"""Playable copies of films for the live player.

A browser can only play a few formats: H.264 or AV1 video with AAC audio in an MP4, or VP9 in
WebM. Many downloaded films are HEVC (x265), often 10-bit, in an MKV, and the browser shows
nothing for those. So the live player plays a copy made once with ffmpeg: H.264, 8-bit, at most
1080 lines tall, stereo AAC, with the index at the front so seeking works before it is fully read.

Copies live in live/<id>.mp4 next to a small live/<id>.json that remembers the original path,
so asking for the same film twice reuses the copy.
"""
import json
import re
import subprocess
import tempfile
import threading
from pathlib import Path

import project as store
import render

LIVE_DIR = store.ROOT / "live"

# Films being converted right now, by source path, so a second request for the same film gets
# the job that is already running instead of a second ffmpeg writing the same file.
RUNNING = {}
_running_lock = threading.Lock()


def _probe(path):
    """The film's length in seconds and the first video stream's colour transfer."""
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "format=duration:stream=color_transfer", "-of", "json", str(path)],
                         capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        info = json.loads(out.stdout or "{}")
    except ValueError:
        info = {}
    try:
        duration = float(info.get("format", {}).get("duration", 0))
    except (TypeError, ValueError):
        duration = 0.0
    streams = info.get("streams") or [{}]
    return duration, streams[0].get("color_transfer", "")


def list_copies():
    """The playable copies already made, and the analysed films that do not have one yet."""
    LIVE_DIR.mkdir(exist_ok=True)
    copies, have = [], set()
    for info in sorted(LIVE_DIR.glob("*.json")):
        meta = json.loads(info.read_text(encoding="utf-8"))
        if not (LIVE_DIR / f"{info.stem}.mp4").exists():
            continue
        have.add(meta.get("source", ""))
        copies.append({"id": info.stem, "name": meta.get("name", info.stem), "duration": meta.get("duration", 0),
                       "url": f"/media/live/{info.stem}.mp4"})
    suggestions = []
    for lib in store.list_libraries():
        path = store.load_library(lib["id"])["lib"].get("film_path", "")
        if path and path not in have and Path(path).is_file():
            suggestions.append({"name": lib["film"], "path": path})
    return {"copies": copies, "films": suggestions}


def find_copy(source):
    for info in LIVE_DIR.glob("*.json"):
        meta = json.loads(info.read_text(encoding="utf-8"))
        if meta.get("source") == str(source) and (LIVE_DIR / f"{info.stem}.mp4").exists():
            return info.stem, meta
    return None, None


def make_copy(source, job):
    """Convert one film. job.update(progress, message) is called as ffmpeg goes."""
    LIVE_DIR.mkdir(exist_ok=True)
    cid, meta = find_copy(source)
    if cid:
        job.update(1, "This film already has a playable copy")
        return {"id": cid, "name": meta["name"], "url": f"/media/live/{cid}.mp4"}

    base = store.slug(source.stem)
    cid, n = base, 2
    while any((LIVE_DIR / f"{cid}{ext}").exists() for ext in (".json", ".mp4", ".part.mp4")):
        cid, n = f"{base}-{n}", n + 1
    out = LIVE_DIR / f"{cid}.mp4"
    part = LIVE_DIR / f"{cid}.part.mp4"
    part.touch()                       # claims the id before ffmpeg starts
    duration, transfer = _probe(source)

    # Even width and height (H.264 needs them), square pixels so anamorphic DVD rips keep their
    # shape, and at most 1080 lines. HDR films are tone mapped, or they come out grey and flat.
    size = "scale=w='trunc(oh*dar/2)*2':h='min(1080,trunc(ih/2)*2)':flags=bicubic,setsar=1"
    if transfer in ("smpte2084", "arib-std-b67"):
        vf = ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,"
              f"zscale=t=bt709:m=bt709:r=tv,{size},format=yuv420p")
    else:
        vf = f"{size},format=yuv420p"

    # The encoder render.py picked (NVENC when the GPU has it), at a quality a little below the
    # export's, since this copy is for playing, not for the final file.
    enc = render.encoder()
    enc = [("23" if a == "19" else "20" if a == "18" else a) for a in enc]
    cmd = ["ffmpeg", "-y", "-v", "error", "-progress", "pipe:1", "-nostats", "-i", str(source),
           "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
           "-vf", vf, *enc,
           "-g", "48",                    # a keyframe every two seconds, so seeking lands quickly
           "-c:a", "aac", "-ac", "2", "-b:a", "192k", "-movflags", "+faststart", str(part)]
    job.update(0.0, "Making a playable copy")
    # Errors go to a file, not a pipe. A damaged film can print thousands of lines, which would
    # fill a pipe nobody reads until the end, and ffmpeg would stop and wait forever.
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as errf:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errf, text=True,
                                encoding="utf-8", errors="replace")
        for line in proc.stdout:
            m = re.match(r"out_time_us=(\d+)", line.strip())
            if m and duration:
                done = int(m.group(1)) / 1e6
                job.update(0.99 * done / duration, f"Making a playable copy, {int(done // 60)} of {int(duration // 60)} min")
        code = proc.wait()
        errf.seek(0)
        err = errf.read()
    if code != 0:
        part.unlink(missing_ok=True)
        raise store.ApiError("ffmpeg could not convert this film: " + err.strip()[-300:], 500)
    part.replace(out)
    name = source.name
    (LIVE_DIR / f"{cid}.json").write_text(json.dumps({"source": str(source), "name": name, "duration": duration}),
                                          encoding="utf-8")
    job.update(1, "Done")
    return {"id": cid, "name": name, "url": f"/media/live/{cid}.mp4"}


# Autoclip: the best parts of a playable copy, from the analyser's library for the same film.
SEGMENT_MAX = 8.0      # seconds. Neighbouring clips in one shot join up to this length.
SEGMENTS_KEPT = 120    # the best ones, which is plenty to jump between without repeats


def copy_clips(copy_id):
    """The best stretches of one playable copy, best first. analysed is False when the film has
    no library yet, and can_analyse says whether the original file is there to analyse."""
    info = LIVE_DIR / f"{store.safe_id(copy_id)}.json"
    if not info.exists():
        raise store.ApiError("There is no playable copy with that id.", 404)
    source = json.loads(info.read_text(encoding="utf-8")).get("source", "")
    lib = None
    for entry in store.list_libraries():
        loaded = store.load_library(entry["id"])["lib"]
        if source and Path(loaded.get("film_path", "")) == Path(source):
            lib = loaded
            break
    if lib is None:
        return {"analysed": False, "can_analyse": bool(source) and Path(source).is_file(), "source": source, "segments": []}

    # Join clips that follow each other inside one shot, so a jump lands on a stretch of a few
    # seconds instead of a two second blip. A stretch scores as the mean of its clips.
    clips = sorted(lib["clips"], key=lambda c: c["start"])
    segments, cur = [], None
    for c in clips:
        if cur and c["shot"] == cur["shot"] and -0.05 < c["start"] - cur["end"] <= 1.0 and c["end"] - cur["start"] <= SEGMENT_MAX:
            cur["end"] = c["end"]
            cur["scores"].append(c.get("score", 0))
        else:
            cur = {"shot": c["shot"], "start": c["start"], "end": c["end"], "scores": [c.get("score", 0)]}
            segments.append(cur)
    for seg in segments:
        scores = seg.pop("scores")
        seg["score"] = round(sum(scores) / len(scores), 3)
    segments.sort(key=lambda seg: seg["score"], reverse=True)
    return {"analysed": True, "segments": segments[:SEGMENTS_KEPT]}
