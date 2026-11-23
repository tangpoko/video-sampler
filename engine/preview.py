"""Draft previews for the editor.

Every cut is rendered to its own small file, named by a hash of everything that decides its
picture. A preview is those files joined without re-encoding, plus the song. After an edit only
the cuts whose hash is new need rendering, so the wait is about one cut, not the whole video.

One Preview object per project. The project calls request() after every edit. A background
thread renders what is missing, four cuts at a time, then joins. If more edits arrive while it
works, it drops the versions in between and builds the newest one.
"""
import hashlib
import json
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

import render

# Shared by all projects so two open projects cannot start eight ffmpegs between them.
POOL = ThreadPoolExecutor(4, thread_name_prefix="cut")
KEEP_PREVIEWS = 3
# Rendered cuts kept on disk per project. Old ones are only useful for undo, and a draft cut is
# small, so this is generous. Past it, the oldest cuts the current edit does not use are deleted.
KEEP_CUTS = 1500

_enc = None
_enc_lock = threading.Lock()
_maps_lock = threading.Lock()


def encoder():
    """The ffmpeg encoder settings, tested once. The test starts ffmpeg, so do not repeat it."""
    global _enc
    with _enc_lock:
        if _enc is None:
            _enc = render.encoder()
        return _enc


def cut_frames(cuts, duration):
    """Frames each cut gets. Cut points are rounded to 24 fps frames once and a cut gets the
    frames between its two points, the same rule as render.py, so timing never drifts."""
    points = [round(c["t0"] * render.FPS) for c in cuts] + [round(duration * render.FPS)]
    return [points[k + 1] - points[k] for k in range(len(cuts))]


def cut_hash(src_path, cut, frames, W, H, beat_frames):
    key = [str(src_path), round(float(cut["src"]), 3), round(float(cut["speed"]), 3), list(cut["effects"]),
           frames, W, H, beat_frames, encoder()]
    return hashlib.sha1(json.dumps(key).encode()).hexdigest()[:20]


def _quote(path):
    """A path for ffmpeg's join list. Single quotes in the path need escaping there."""
    return Path(path).as_posix().replace("'", "'\\''")


class Preview:
    def __init__(self, project_id, folder):
        self.project_id = project_id
        self.cache = Path(folder) / "cache"
        self.out = Path(folder) / "preview"
        self.cache.mkdir(parents=True, exist_ok=True)
        self.out.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.target = None          # the newest version asked for
        self.thread = None
        self.inflight = {}          # hash -> future, so one cut is never rendered twice at once
        self.pending = 0
        self.error = None
        self.closed = False
        # Versions only go up, so the highest numbered file is the last finished preview.
        done = [int(p.stem) for p in self.out.glob("*.mp4") if p.stem.isdigit()]
        self.done = max(done) if done else 0
        for p in list(self.cache.glob("*.tmp.mp4")) + list(self.out.glob("*.tmp.mp4")):
            p.unlink(missing_ok=True)       # left behind if the server was stopped mid-render

    # ---- called by the project -------------------------------------------------------------

    def request(self, version, cuts, duration, src_path, size, beat_frames, song_audio):
        """Ask for a preview of this version of the edit. Returns at once."""
        W, H = size
        items = []
        for cut, frames in zip(cuts, cut_frames(cuts, duration)):
            if frames <= 0:
                continue
            seg = {"t0": cut["t0"], "src": cut["src"], "speed": cut["speed"],
                   "effects": list(cut["effects"]), "frames": frames}
            items.append((cut_hash(src_path, cut, frames, W, H, beat_frames), seg))
        target = {"version": version, "items": items, "hashes": {h for h, _ in items},
                  "src": str(src_path), "W": W, "H": H, "beat_frames": beat_frames,
                  "song": str(song_audio), "tries": 0}
        with self.lock:
            if self.closed:
                return
            self.target = target
            self.pending = self._count_missing(target)
            if self.thread is None:
                self.thread = threading.Thread(target=self._run, daemon=True, name=f"preview-{self.project_id}")
                self.thread.start()

    def status(self):
        with self.lock:
            want = self.target["version"] if self.target else self.done
            ready = want == self.done and self.done > 0
            out = {"version": self.done, "status": "ready" if ready else "rendering",
                   "pending": 0 if ready else self.pending,
                   "url": f"/media/preview/{self.project_id}/{self.done}.mp4" if self.done else None}
            if self.error:
                out["error"] = self.error
            return out

    def close(self):
        """The project is being deleted. Stop starting renders."""
        with self.lock:
            self.closed = True
            self.target = None

    # ---- the worker -------------------------------------------------------------------------

    def _count_missing(self, target):
        return sum(1 for h in target["hashes"] if not (self.cache / f"{h}.mp4").exists())

    def _run(self):
        while True:
            with self.lock:
                t = self.target
                if t is None or t["version"] == self.done or t["tries"] >= 3:
                    self.thread = None
                    return
            try:
                self._build(t)
            except Exception as e:      # a failed join must not kill the worker for good
                t["tries"] += 1
                self.error = f"Preview of version {t['version']} failed: {e}"
                print(self.error, flush=True)
                time.sleep(1)

    def _build(self, t):
        missing = {h: seg for h, seg in t["items"] if not (self.cache / f"{h}.mp4").exists()}
        # Kaleidoscope lookup tables are files in the cache folder. Make them before the parallel
        # renders start, or two renders would write the same table at the same time.
        wedges = {e[7:] for seg in missing.values() for e in seg["effects"]
                  if e in ("kaleido6", "kaleido8", "kaleido12")}
        with _maps_lock:
            for n in wedges:
                render.kaleido_maps(t["W"], t["H"], int(n), self.cache)
        futures = []
        with self.lock:
            for h, seg in missing.items():
                f = self.inflight.get(h)
                if f is None or f.done():
                    f = self.inflight[h] = POOL.submit(self._render, h, seg, t)
                futures.append(f)
        for f in futures:
            f.add_done_callback(lambda _f: self._recount())
        wait(futures)
        with self.lock:
            for h in missing:
                self.inflight.pop(h, None)
            if self.target is not t:
                return                  # a newer edit arrived, build that one instead
        files = []
        for h, _ in t["items"]:
            good, bad = self.cache / f"{h}.mp4", self.cache / f"{h}.failed.mp4"
            files.append(good if good.exists() else bad)
        self._join(t, files)
        with self.lock:
            self.done = max(self.done, t["version"])
            if self.target is t:
                self.pending = 0
        self._prune(t)

    def _recount(self):
        with self.lock:
            if self.target is not None:
                self.pending = self._count_missing(self.target)

    def _render(self, h, seg, t):
        with self.lock:
            # Skip a cut no longer in the edit: the user has moved on while it waited its turn.
            if self.target is None or h not in self.target["hashes"]:
                return
        final = self.cache / f"{h}.mp4"
        if final.exists():
            return
        tmp = self.cache / f"{h}.{threading.get_ident()}.tmp.mp4"
        try:
            render.render_segment((seg, t["src"], None, t["W"], t["H"], encoder(), str(tmp), t["beat_frames"]))
            # ffmpeg stops early without an error if the film runs out, which would shift every
            # cut after this one. Count the frames before trusting the file.
            got = _count_frames(tmp)
            if got is not None and got != seg["frames"]:
                raise RuntimeError(f"cut at {seg['t0']:.2f}s rendered {got} frames, needed {seg['frames']}")
            os.replace(tmp, final)
            (self.cache / f"{h}.failed.mp4").unlink(missing_ok=True)
        except Exception as e:
            # One broken cut should not leave the user with no preview at all. Put black in its
            # place for now and say so. The real file is retried on the next edit.
            self.error = str(e)[:500]
            print(f"preview: {self.error}", flush=True)
            tmp.unlink(missing_ok=True)
            subprocess.run([render.FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i",
                            f"color=c=black:s={t['W']}x{t['H']}:r={render.FPS}", "-frames:v", str(seg["frames"]),
                            "-an", *encoder(), "-r", str(render.FPS), str(self.cache / f"{h}.failed.mp4")],
                           capture_output=True)

    def _song_audio(self, song):
        """The song as AAC, encoded once per project, so each join only copies it."""
        st = os.stat(song)
        key = hashlib.sha1(f"{song}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()[:12]
        out = self.cache / f"song_{key}.m4a"
        if not out.exists():
            tmp = self.cache / f"song_{key}.tmp.m4a"
            subprocess.run([render.FFMPEG, "-v", "error", "-y", "-i", song, "-vn", "-c:a", "aac", "-b:a", "256k",
                            str(tmp)], check=True, capture_output=True)
            os.replace(tmp, out)
        return out

    def _join(self, t, files):
        audio = self._song_audio(t["song"])
        lst = self.out / f"{t['version']}.txt"
        lst.write_text("".join(f"file '{_quote(f)}'\n" for f in files), encoding="utf-8")
        tmp = self.out / f"{t['version']}.tmp.mp4"
        try:
            r = subprocess.run([render.FFMPEG, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                                "-i", str(audio), "-map", "0:v", "-map", "1:a", "-c", "copy",
                                "-movflags", "+faststart", str(tmp)], capture_output=True, text=True)
            if r.returncode != 0:
                raise RuntimeError(r.stderr[-400:])
            os.replace(tmp, self.out / f"{t['version']}.mp4")
        finally:
            lst.unlink(missing_ok=True)
            tmp.unlink(missing_ok=True)

    def _prune(self, t):
        versions = sorted(int(p.stem) for p in self.out.glob("*.mp4") if p.stem.isdigit())
        for v in versions[:-KEEP_PREVIEWS]:
            try:
                (self.out / f"{v}.mp4").unlink()
            except OSError:
                pass                    # the player still has it open. It goes next time.
        cuts = [p for p in self.cache.glob("*.mp4") if not p.name.endswith(".tmp.mp4")]
        if len(cuts) > KEEP_CUTS:
            spare = sorted((p for p in cuts if p.name.split(".")[0] not in t["hashes"]),
                           key=lambda p: p.stat().st_mtime)
            for p in spare[: len(cuts) - KEEP_CUTS]:
                try:
                    p.unlink()
                except OSError:
                    pass


def _count_frames(path):
    import shutil
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None                     # cannot check, trust ffmpeg
    r = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=nb_frames", "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    try:
        return int(r.stdout.strip().split(",")[0])
    except ValueError:
        return -1
