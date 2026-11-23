"""Projects for the Video Sampler editor: the saved edit, the edit operations, undo and redo.

A project is one film library, one song and a list of cuts that covers the whole song. It is
saved to projects/<id>/project.json after every change, with its undo history next to it in
history.json. docs/API.md describes the shapes the web page sees.

Cuts are kept on the song's half-beat grid. A cut stores where it starts in beats and how many
beats it lasts, and its times in seconds are always worked out from those, so cuts cannot drift
apart or leave gaps.
"""
import copy
import json
import os
import random
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

import auto
import render
from preview import Preview

ROOT = Path(__file__).resolve().parent.parent
LIBRARY_DIR = ROOT / "library"
SONGS_DIR = ROOT / "songs"
PROJECTS_DIR = ROOT / "projects"
EDITS_DIR = ROOT / "edits"

SLIDERS = ("cut_speed", "repetition", "effects", "colour", "motion", "strange")
HISTORY_LIMIT = 50
PEAKS = 2000
MIN_HAND_SPEED, MAX_HAND_SPEED = 0.25, 2.0

EFFECT_NAMES = {
    "kaleidoscope": "4-way mirror", "kaleido6": "Kaleidoscope 6", "kaleido8": "Kaleidoscope 8",
    "kaleido12": "Kaleidoscope 12", "mirror": "Mirror", "flip": "Flip", "upside_down": "Upside down",
    "hue": "Hue shift", "invert": "Invert", "rgb_split": "RGB split", "posterize": "Posterize",
    "vhs": "VHS", "stutter": "Stutter", "stutter_fast": "Fast stutter", "pingpong": "Back and forth",
    "reverse": "Reverse",
}
EFFECTS_AVAILABLE = [{"id": e, "name": EFFECT_NAMES.get(e, e), "kind": "time" if e in auto.TIME_FX else "picture"}
                     for e in auto.FX_WEIGHTS]


class ApiError(Exception):
    """A problem the page should show to the user. The message is a plain sentence."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message, self.status = message, status


def safe_id(text):
    """Ids become folder names and parts of URLs, so only allow plain characters."""
    if not isinstance(text, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}", text) or ".." in text:
        raise ApiError("That name is not valid.", 404)
    return text


def slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")
    return s[:60] or "untitled"


def write_json(path, data, indent=None):
    """Write to a second file and swap it in, so a crash mid-write cannot leave half a file."""
    tmp = Path(str(path) + ".tmp")
    tmp.write_text(json.dumps(data, indent=indent), encoding="utf-8")
    os.replace(tmp, path)


def whole(x):
    """3.0 -> 3, 0.5 stays 0.5. Beat counts read better without a trailing .0."""
    return int(x) if float(x).is_integer() else float(x)


# ---- libraries ---------------------------------------------------------------------------------

_lib_cache = {}
_lib_lock = threading.Lock()


def load_library(lib_id):
    """A film library, loaded once and reloaded if analysis.json changes."""
    folder = LIBRARY_DIR / safe_id(lib_id)
    path = folder / "analysis.json"
    if not path.exists():
        raise ApiError(f"There is no film library called {lib_id}.", 404)
    mtime = path.stat().st_mtime_ns
    with _lib_lock:
        entry = _lib_cache.get(lib_id)
        if entry is None or entry["mtime"] != mtime:
            lib = json.loads(path.read_text(encoding="utf-8"))
            entry = _lib_cache[lib_id] = {"id": lib_id, "dir": folder, "lib": lib, "mtime": mtime, "emb": None,
                                          "by_id": {c["id"]: c for c in lib["clips"]}}
        return entry


def library_embeddings(entry):
    with _lib_lock:
        if entry["emb"] is None:
            entry["emb"] = np.load(entry["dir"] / "clip_embeddings.npy")
        return entry["emb"]


def library_aspect(lib):
    crop = lib["crop"]
    return crop["w"] * lib["source"]["sar"] / crop["h"]


def list_libraries():
    out = []
    for folder in sorted(LIBRARY_DIR.glob("*")):
        if not (folder / "analysis.json").exists():
            continue
        lib = load_library(folder.name)["lib"]
        best = max(lib["clips"], key=lambda c: c.get("score", 0), default=None)
        out.append({"id": folder.name, "film": lib["film"], "duration": lib["duration"],
                    "clips": len(lib["clips"]),
                    "thumb": f"/media/library/{folder.name}/thumbs/{best['id']}.jpg" if best else None})
    return out


def library_clips(lib_id):
    lib = load_library(lib_id)["lib"]
    shots = lib["shots"]
    clips = []
    for c in lib["clips"]:
        lo, hi = shots[c["shot"]]
        clips.append({"id": c["id"], "shot": c["shot"], "start": c["start"], "end": c["end"],
                      "shot_start": lo, "shot_end": hi,
                      "colour": c["colour"], "motion": c["motion"], "strange": c["strange"],
                      "quality": c["quality"], "hue": c["hue"], "hue_strength": c["hue_strength"],
                      "tags": c.get("tags", [])})
    return {"clips": clips, "tags": lib.get("tags", [])}


# ---- songs -------------------------------------------------------------------------------------

_song_cache = {}
_song_lock = threading.Lock()


def compute_peaks(audio, n=PEAKS):
    """The song's loudness outline for drawing the waveform: n values from 0 to 1, each the
    loudest moment in its slice of the song."""
    raw = subprocess.run([render.FFMPEG, "-v", "error", "-i", str(audio), "-vn", "-ac", "1", "-ar", "8000",
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    y = np.abs(np.frombuffer(raw, np.float32))
    if len(y) == 0:
        return [0.0] * n
    peaks = np.array([part.max() if len(part) else 0.0 for part in np.array_split(y, n)])
    return [round(float(v), 3) for v in peaks / (peaks.max() + 1e-9)]


def load_song(song_id):
    """A song's beats, bars, sections and peaks. The peaks are worked out the first time a song
    is opened and saved back into its json file."""
    path = SONGS_DIR / f"{safe_id(song_id)}.json"
    if not path.exists():
        raise ApiError(f"There is no song called {song_id}.", 404)
    with _song_lock:
        mtime = path.stat().st_mtime_ns
        hit = _song_cache.get(song_id)
        if hit and hit[0] == mtime:
            return hit[1]
        song = json.loads(path.read_text(encoding="utf-8"))
        if "peaks" not in song:
            if not Path(song["song"]).exists():
                raise ApiError(f"The audio file for {song_id} is missing: {song['song']}", 404)
            song["peaks"] = compute_peaks(song["song"])
            write_json(path, song, indent=1)
        _song_cache[song_id] = (path.stat().st_mtime_ns, song)
        return song


def list_songs():
    out = []
    for path in sorted(SONGS_DIR.glob("*.json")):
        try:
            song = json.loads(path.read_text(encoding="utf-8"))
            out.append({"id": path.stem, "name": path.stem, "duration": song["duration"], "tempo": song["tempo"]})
        except (ValueError, KeyError):
            continue                    # not a song file
    return out


# ---- projects ----------------------------------------------------------------------------------

class Project:
    def __init__(self, data, history=None):
        self.d = data
        self.id = data["id"]
        self.folder = PROJECTS_DIR / self.id
        self.lock = threading.RLock()
        history = history or {}
        self.undo_stack = history.get("undo", [])
        self.redo_stack = history.get("redo", [])
        self.lib = load_library(data["library"])
        self.song = load_song(data["song"])
        self.nbeats = len(self.song["beats"])
        self.sec_start = [self.song["bars"][s["bar0"]]["beat0"] for s in self.song["sections"]]
        self._planner = None
        self.preview = Preview(self.id, self.folder)

    # ---- saving ----

    def save(self, history=True):
        self.d["modified"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        self.folder.mkdir(parents=True, exist_ok=True)
        write_json(self.folder / "project.json", self.d, indent=1)
        if history:
            write_json(self.folder / "history.json", {"undo": self.undo_stack, "redo": self.redo_stack})

    # ---- what the page sees ----

    def public(self):
        with self.lock:
            lib, song, d = self.lib["lib"], self.song, self.d
            return {
                "id": self.id, "name": d["name"], "version": d["version"],
                "can_undo": bool(self.undo_stack), "can_redo": bool(self.redo_stack),
                "library": {"id": d["library"], "film": lib["film"], "aspect": round(library_aspect(lib), 3),
                            "proxy_url": f"/media/library/{d['library']}/proxy.mp4",
                            "thumb_url": f"/media/library/{d['library']}/thumbs/{{clip}}.jpg"},
                "song": {"id": d["song"], "name": d["song"], "url": f"/media/song/{d['song']}",
                         "duration": song["duration"], "tempo": song["tempo"],
                         "beats": [{"t": b["t"], "downbeat": b["downbeat"]} for b in song["beats"]],
                         "sections": [{"t0": s["t0"], "t1": s["t1"], "label": s["label"], "energy": s["energy"]}
                                      for s in song["sections"]],
                         "peaks": song["peaks"]},
                "settings": copy.deepcopy(d["settings"]),
                "seed": d["seed"],
                "effects_available": EFFECTS_AVAILABLE,
                "cuts": copy.deepcopy(d["cuts"]),
                "preview": self.preview.status(),
            }

    def summary(self):
        with self.lock:
            d = self.d
            first = d["cuts"][0]["clip"] if d["cuts"] else None
            return {"id": self.id, "name": d["name"], "library": d["library"], "song": d["song"],
                    "modified": d.get("modified"),
                    "thumb": f"/media/library/{d['library']}/thumbs/{first}.jpg" if first else None}

    # ---- the beat grid ----

    def T(self, beat):
        return round(auto.beat_time(self.song, beat), 4)

    def section_at(self, beat):
        sec = 0
        for k, b in enumerate(self.sec_start):
            if beat >= b - 1e-6:
                sec = k
        return sec

    def retime(self, cut):
        """Set a cut's seconds, section and label from its beats."""
        cut["beat0"] = float(cut["beat0"])
        cut["beats"] = whole(cut["beats"])
        cut["t0"] = self.T(cut["beat0"])
        cut["t1"] = self.T(cut["beat0"] + cut["beats"])
        cut["section"] = self.section_at(cut["beat0"])
        cut["label"] = self.song["sections"][cut["section"]]["label"]
        return cut

    def frames(self, t0, t1):
        return round(t1 * render.FPS) - round(t0 * render.FPS)

    def check(self):
        """The promises in the contract. Run after every edit, before it is saved."""
        cuts = self.d["cuts"]
        if not cuts:
            raise ValueError("no cuts")
        if cuts[0]["beat0"] != 0 or cuts[0]["t0"] != 0:
            raise ValueError("the first cut does not start at 0")
        for a, b in zip(cuts, cuts[1:]):
            if abs(a["beat0"] + a["beats"] - b["beat0"]) > 1e-9 or a["t1"] != b["t0"]:
                raise ValueError(f"gap between cut {a['id']} and cut {b['id']}")
        last = cuts[-1]
        if abs(last["beat0"] + last["beats"] - self.nbeats) > 1e-9 or last["t1"] != self.song["duration"]:
            raise ValueError("the last cut does not end with the song")
        for c in cuts:
            if c["beats"] <= 0 or (c["beats"] * 2) % 1 or (c["beat0"] * 2) % 1:
                raise ValueError(f"cut {c['id']} is off the half-beat grid")
        if len({c["id"] for c in cuts}) != len(cuts):
            raise ValueError("two cuts share an id")

    # ---- small helpers ----

    def new_id(self):
        taken = {c["id"] for c in self.d["cuts"]}
        for snap in self.undo_stack + self.redo_stack:
            taken.update(c["id"] for c in snap["cuts"])
        while True:
            cid = "".join(random.choice("abcdefghijkmnpqrstuvwxyz23456789") for _ in range(4))
            if cid not in taken:
                return cid

    def find(self, cut_id):
        for i, c in enumerate(self.d["cuts"]):
            if c["id"] == cut_id:
                return i, c
        raise ApiError(f"There is no cut with the id {cut_id}.", 404)

    def planner_settings(self):
        return {**self.d["settings"], **self.d.get("planner", {})}

    def make_planner(self, seed):
        return auto.Planner(self.lib["dir"], self.song, self.planner_settings(), seed,
                            lib=self.lib["lib"], emb=library_embeddings(self.lib))

    def planner(self):
        """The planner for this project's seed and settings. It decides which look and which
        signature effect each section has, so a one-cut reroll has to use the same one as the
        plan that made the rest of the edit. Kept until the seed or the settings change."""
        key = json.dumps([self.planner_settings(), self.d["seed"]], sort_keys=True)
        if self._planner is None or self._planner[0] != key:
            self._planner = (key, self.make_planner(self.d["seed"]))
        return self._planner[1]

    def shot_span(self, clip_id):
        """The usable part of a clip's shot in film seconds, the same span auto mode uses."""
        c = self.lib["by_id"].get(clip_id)
        if c is None:
            return None
        lo, hi = self.lib["lib"]["shots"][c["shot"]]
        return lo + 0.1, hi - 0.1

    def keep_in_film(self, cut):
        """A cut must not read past the end of the film, or it would come out short."""
        need = (cut["t1"] - cut["t0"]) * cut["speed"]
        end = self.lib["lib"]["duration"] - 0.5
        cut["src"] = round(max(0.0, min(cut["src"], end - need)), 3)

    # ---- running an edit ----

    def snapshot(self):
        return {"cuts": copy.deepcopy(self.d["cuts"]), "settings": copy.deepcopy(self.d["settings"]),
                "seed": self.d["seed"]}

    def restore(self, snap):
        self.d["cuts"] = copy.deepcopy(snap["cuts"])
        self.d["settings"] = copy.deepcopy(snap["settings"])
        self.d["seed"] = snap["seed"]

    def edit(self, change):
        """Run one edit. If it fails or breaks a promise, the project is put back as it was."""
        with self.lock:
            before = self.snapshot()
            try:
                change()
                self.check()
            except ApiError:
                self.restore(before)
                raise
            except Exception as e:
                self.restore(before)
                raise ApiError(f"That edit could not be applied: {e}", 500)
            self.undo_stack.append(before)
            del self.undo_stack[:-HISTORY_LIMIT]
            self.redo_stack.clear()
            return self.commit()

    def commit(self):
        self.d["version"] += 1
        self.save()
        self.request_preview()
        return self.public()

    def request_preview(self):
        with self.lock:
            lib = self.lib["lib"]
            self.preview.request(self.d["version"], copy.deepcopy(self.d["cuts"]), self.song["duration"],
                                 self.lib["dir"] / lib["proxy"], render.frame_size(lib, True),
                                 round(60 / self.song["tempo"] * render.FPS), self.song["song"])

    def ensure_preview(self):
        """Start a render if this version has no preview yet, such as after a restart."""
        with self.lock:
            st = self.preview.status()
            if st["status"] != "ready" or st["version"] != self.d["version"]:
                if self.preview.target is None or self.preview.target["version"] != self.d["version"] \
                        or self.preview.thread is None:
                    self.request_preview()

    # ---- the edit operations ----

    def delete_cut(self, cut_id):
        def change():
            cuts = self.d["cuts"]
            i, cut = self.find(cut_id)
            if len(cuts) == 1:
                raise ApiError("The last cut cannot be deleted.")
            if i > 0:
                keep = cuts[i - 1]
            else:
                keep = cuts[1]
                keep["beat0"] = cut["beat0"]
            keep["beats"] += cut["beats"]
            cuts.pop(i)
            self.retime(keep)
            self.keep_in_film(keep)
            # Stretching a cut is a hand edit. Without the lock the next reroll would cut it up again.
            keep["locked"] = True
        return self.edit(change)

    def grid_beat(self, body):
        beat = (body or {}).get("beat")
        if not isinstance(beat, (int, float)) or isinstance(beat, bool):
            raise ApiError("Send the beat position as a number, like {\"beat\": 12.5}.")
        return round(beat * 2) / 2      # the nearest half beat

    def split_cut(self, cut_id, body):
        beat = self.grid_beat(body)

        def change():
            i, cut = self.find(cut_id)
            if not cut["beat0"] < beat < cut["beat0"] + cut["beats"]:
                raise ApiError("The split point has to be inside the cut, not on its edge.")
            end = cut["beat0"] + cut["beats"]
            second = copy.deepcopy(cut)
            cut["beats"] = beat - cut["beat0"]
            self.retime(cut)
            second.update(id=self.new_id(), beat0=beat, beats=end - beat)
            self.retime(second)
            # The second part carries on from the film frame where the first part stops.
            second["src"] = round(cut["src"] + self.frames(cut["t0"], cut["t1"]) / render.FPS * cut["speed"], 3)
            self.keep_in_film(second)
            cut["locked"] = second["locked"] = True
            self.d["cuts"].insert(i + 1, second)
        return self.edit(change)

    def move_start(self, cut_id, body):
        beat = self.grid_beat(body)

        def change():
            i, cut = self.find(cut_id)
            if i == 0:
                raise ApiError("The first cut starts with the song, so its start cannot move.")
            prev = self.d["cuts"][i - 1]
            end = cut["beat0"] + cut["beats"]
            if not prev["beat0"] < beat < end:
                raise ApiError("The cut point has to stay between the start of the cut before and the end of this cut.")
            prev["beats"] = beat - prev["beat0"]
            cut["beat0"], cut["beats"] = beat, end - beat
            for c in (prev, cut):
                self.retime(c)
                self.keep_in_film(c)
                c["locked"] = True
        return self.edit(change)

    def swap_clip(self, cut_id, body):
        clip_id = (body or {}).get("clip")

        def change():
            _, cut = self.find(cut_id)
            p = self.planner()
            if clip_id not in p.index:
                raise ApiError(f"There is no clip called {clip_id} in this film.", 404)
            # Same fit as auto mode. Auto mode avoids shots too short for the cut. A hand pick can
            # be any shot, so here a short shot is slowed as far as it takes to stay inside it.
            cut["src"], cut["speed"] = p.fit(p.index[clip_id], cut["t1"] - cut["t0"], floor=MIN_HAND_SPEED)
            cut["clip"] = clip_id
            cut["locked"] = True
        return self.edit(change)

    def reroll_cut(self, cut_id):
        def change():
            cuts = self.d["cuts"]
            i, cut = self.find(cut_id)
            p = self.planner()
            idx = [p.index.get(c["clip"]) for c in cuts]
            used = {}
            for j, k in enumerate(idx):
                if j != i and k is not None:
                    used[k] = used.get(k, 0) + 1
            # Clips the new pick must not repeat: the four cuts before, the cut after, and the
            # clip being replaced. The planner looks at the last six entries of this list.
            near = idx[max(0, i - 4):i] + idx[i + 1:i + 2] + [idx[i]]
            near = [k for k in near if k is not None]
            prev = p.clips[idx[i - 1]] if i > 0 and idx[i - 1] is not None else None
            rng = random.Random()
            seg = None
            for _ in range(10):
                seg = {"t0": cut["t0"], "t1": cut["t1"], "section": cut["section"],
                       "beats": cut["beats"], "beat0": cut["beat0"]}
                state = {"used": dict(used), "recent": list(near), "first_take": {}, "prev": prev,
                         "pos": {}, "done": cuts[:i]}
                p.fill(seg, state, rng)
                if seg["clip"] != cut["clip"]:
                    break
            cut.update(clip=seg["clip"], src=seg["src"], speed=seg["speed"],
                       effects=[e for e in seg["effects"] if e])
        return self.edit(change)

    def patch_cut(self, cut_id, body):
        body = body or {}
        unknown = set(body) - {"src", "speed", "effects", "locked"}
        if unknown or not body:
            raise ApiError("A cut can be changed in these ways only: src, speed, effects, locked.")

        def number(key):
            v = body[key]
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                raise ApiError(f"{key} has to be a number.")
            return float(v)

        def change():
            _, cut = self.find(cut_id)
            if "effects" in body:
                fx = body["effects"]
                if not isinstance(fx, list) or any(e not in auto.FX_WEIGHTS for e in fx):
                    raise ApiError("effects has to be a list of effect ids from effects_available.")
                cut["effects"] = list(fx)
            if "speed" in body:
                cut["speed"] = round(min(MAX_HAND_SPEED, max(MIN_HAND_SPEED, number("speed"))), 3)
            if "src" in body:
                src = number("src")
                span = self.shot_span(cut["clip"])
                if span:
                    need = (cut["t1"] - cut["t0"]) * cut["speed"]
                    src = min(max(src, span[0]), max(span[0], span[1] - need))
                cut["src"] = round(src, 3)
            self.keep_in_film(cut)
            if "locked" in body:
                if not isinstance(body["locked"], bool):
                    raise ApiError("locked has to be true or false.")
                cut["locked"] = body["locked"]
            if set(body) != {"locked"}:
                cut["locked"] = True
        return self.edit(change)

    def reroll_all(self, body):
        seed = (body or {}).get("seed")
        if seed is None:
            seed = random.randrange(1, 1_000_000)
        if not isinstance(seed, int) or isinstance(seed, bool):
            raise ApiError("seed has to be a whole number.")

        def change():
            self.d["seed"] = seed
            self.d["cuts"] = self.planned_cuts(seed, self.d["cuts"])
        return self.edit(change)

    def planned_cuts(self, seed, old=()):
        """Plan the edit with auto mode. Locked cuts in old are kept exactly as they are, and
        only the stretches between them are planned, on the beat grid, with no gaps."""
        p = self.make_planner(seed)
        locked = [c for c in old if c.get("locked")]
        free, at = [], 0.0
        for c in locked:
            if c["beat0"] - at > 1e-6:
                free.append((at, c["beat0"]))
            at = c["beat0"] + c["beats"]
        if self.nbeats - at > 1e-6:
            free.append((at, self.nbeats))
        todo = [(s["beat0"], False, s) for s in p.grid(free)] + [(c["beat0"], True, c) for c in locked]
        todo.sort(key=lambda x: x[0])
        state, cuts = p.new_state(), []
        for _, is_locked, seg in todo:
            if is_locked:
                p.note(seg, state)      # later cuts see it as the previous clip and a used clip
                cuts.append(seg)
                continue
            p.fill(seg, state)
            cut = {"id": None, "t0": 0, "t1": 0, "beat0": seg["beat0"], "beats": seg["beats"],
                   "section": seg["section"], "label": seg["label"], "clip": seg["clip"], "src": seg["src"],
                   "speed": seg["speed"], "effects": [e for e in seg["effects"] if e], "locked": False}
            cuts.append(self.retime(cut))
        self.d["cuts"] = [c for c in cuts if c["id"]]      # so new_id sees the kept ids
        for c in cuts:
            if not c["id"]:
                c["id"] = self.new_id()
                self.d["cuts"].append(c)
        return cuts

    def patch_settings(self, body):
        body = body or {}
        if not isinstance(body, dict) or not body:
            raise ApiError("Send the settings to change.")

        def change():
            s = self.d["settings"]
            for key, v in body.items():
                if key in SLIDERS:
                    if not isinstance(v, (int, float)) or isinstance(v, bool):
                        raise ApiError(f"{key} has to be a number from 0 to 1.")
                    s[key] = min(1.0, max(0.0, float(v)))
                elif key == "fx_weights":
                    if not isinstance(v, dict):
                        raise ApiError("fx_weights has to be an object of effect id and weight.")
                    for e, wgt in v.items():
                        if e not in auto.FX_WEIGHTS or not isinstance(wgt, (int, float)) or isinstance(wgt, bool):
                            raise ApiError(f"{e} is not an effect, or its weight is not a number.")
                        s["fx_weights"][e] = max(0.0, float(wgt))
                else:
                    raise ApiError(f"There is no setting called {key}.")
        return self.edit(change)

    def undo(self):
        with self.lock:
            if not self.undo_stack:
                raise ApiError("There is nothing to undo.")
            self.redo_stack.append(self.snapshot())
            self.restore(self.undo_stack.pop())
            return self.commit()

    def redo(self):
        with self.lock:
            if not self.redo_stack:
                raise ApiError("There is nothing to redo.")
            self.undo_stack.append(self.snapshot())
            self.restore(self.redo_stack.pop())
            return self.commit()

    def as_edit(self):
        """The project in the shape render.py takes, for a full-quality export."""
        with self.lock:
            return {"library": str(self.lib["dir"]), "film": self.lib["lib"]["film_path"],
                    "song": self.song["song"], "duration": self.song["duration"], "tempo": self.song["tempo"],
                    "segments": copy.deepcopy(self.d["cuts"])}, self.d["version"]


# ---- the set of projects ---------------------------------------------------------------------

_projects = {}
_store_lock = threading.RLock()


def get_project(pid):
    safe_id(pid)
    with _store_lock:
        if pid in _projects:
            return _projects[pid]
        path = PROJECTS_DIR / pid / "project.json"
        if not path.exists():
            raise ApiError(f"There is no project called {pid}.", 404)
        hist = PROJECTS_DIR / pid / "history.json"
        history = json.loads(hist.read_text(encoding="utf-8")) if hist.exists() else None
        p = _projects[pid] = Project(json.loads(path.read_text(encoding="utf-8")), history)
        return p


def list_projects():
    out = []
    for path in sorted(PROJECTS_DIR.glob("*/project.json")):
        try:
            out.append(get_project(path.parent.name).summary())
        except ApiError as e:
            print(f"skipping project {path.parent.name}: {e.message}", flush=True)
    out.sort(key=lambda p: p["modified"] or "", reverse=True)
    return out


def default_settings(given=None):
    s = {k: auto.DEFAULTS[k] for k in SLIDERS}
    s["fx_weights"] = dict(auto.FX_WEIGHTS)
    for k, v in (given or {}).items():
        if k in SLIDERS and isinstance(v, (int, float)) and not isinstance(v, bool):
            s[k] = min(1.0, max(0.0, float(v)))
        elif k == "fx_weights" and isinstance(v, dict):
            for e, wgt in v.items():
                if e in auto.FX_WEIGHTS and isinstance(wgt, (int, float)) and not isinstance(wgt, bool):
                    s["fx_weights"][e] = max(0.0, float(wgt))
    return s


def _new(pid, name, library, song, seed, settings, planner):
    load_library(library)
    load_song(song)
    data = {"id": pid, "name": name, "version": 1, "library": library, "song": song,
            "settings": settings, "planner": planner, "seed": seed, "cuts": []}
    return Project(data)


def _free_id(name):
    base = slug(name)
    pid, n = base, 2
    while (PROJECTS_DIR / pid).exists():
        pid, n = f"{base}-{n}", n + 1
    return pid


def create_project(body):
    body = body or {}
    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ApiError("The project needs a name.")
    for key in ("library", "song"):
        if not isinstance(body.get(key), str):
            raise ApiError(f"Choose a {'film' if key == 'library' else 'song'} for the project.")
    seed = body.get("seed")
    if seed is None:
        seed = random.randrange(1, 1_000_000)
    if not isinstance(seed, int) or isinstance(seed, bool):
        raise ApiError("seed has to be a whole number.")
    with _store_lock:
        p = _new(_free_id(name), name.strip(), body["library"], body["song"], seed,
                 default_settings(body.get("settings")),
                 {"pool": auto.DEFAULTS["pool"], "looks": auto.DEFAULTS["looks"]})
        p.d["cuts"] = p.planned_cuts(seed)
        p.check()
        p.save()
        _projects[p.id] = p
    p.request_preview()
    return p


def create_from_edit(edit_path, pid, name):
    """Turn an edit.json written by auto.py into a project. Used for the starter project."""
    edit = json.loads(Path(edit_path).read_text(encoding="utf-8"))
    library = Path(edit["library"]).name
    song = next((s["id"] for s in list_songs()
                 if json.loads((SONGS_DIR / f"{s['id']}.json").read_text(encoding="utf-8")).get("song") == edit["song"]),
                None)
    if song is None:
        raise ApiError(f"No analysed song matches {edit['song']}.", 404)
    es = edit.get("settings", {})
    with _store_lock:
        p = _new(pid, name, library, song, edit.get("seed", 1), default_settings(es),
                 {"pool": es.get("pool", auto.DEFAULTS["pool"]), "looks": es.get("looks", auto.DEFAULTS["looks"])})
        for seg in edit["segments"]:
            cut = {"id": None, "t0": 0, "t1": 0, "beat0": seg["beat0"], "beats": seg["beats"],
                   "section": seg["section"], "label": seg["label"], "clip": seg["clip"], "src": seg["src"],
                   "speed": seg["speed"], "effects": list(seg["effects"]), "locked": False}
            p.retime(cut)
            cut["id"] = p.new_id()
            p.d["cuts"].append(cut)
        p.check()
        p.save()
        _projects[p.id] = p
    p.request_preview()
    return p


def delete_project(pid):
    p = get_project(pid)
    with _store_lock:
        p.preview.close()
        _projects.pop(pid, None)
    # A render that was already running may still hold a file open for a moment.
    for _ in range(5):
        shutil.rmtree(p.folder, ignore_errors=True)
        if not p.folder.exists():
            break
        time.sleep(0.5)
    if p.folder.exists():
        raise ApiError("Some of the project's files are in use and could not be deleted. Try again in a moment.", 500)


def ensure_default_project():
    """On first start there is nothing to open, so make the starter project from the last
    planned edit of The Neon Demon to afterhours."""
    PROJECTS_DIR.mkdir(exist_ok=True)
    if any(PROJECTS_DIR.glob("*/project.json")):
        return None
    edit = EDITS_DIR / "neon-afterhours-3.json"
    if not edit.exists():
        return None
    try:
        return create_from_edit(edit, "neon-afterhours", "Neon Afterhours")
    except Exception as e:
        print(f"could not make the starter project: {e}", flush=True)
        return None
