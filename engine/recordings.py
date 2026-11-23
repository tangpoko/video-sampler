"""Recordings from the live player.

The browser records the main picture and the sound as WebM, because that is the only format its
recorder writes. The page uploads it here and ffmpeg turns it into an MP4 that plays anywhere.
The browser's recorder writes frames whenever the page draws one, so the frame rate wanders.
ffmpeg evens it out to 30 frames a second.
"""
import re
import subprocess
import tempfile
import time
from pathlib import Path

import project as store
import render

RECORDINGS_DIR = store.ROOT / "recordings"
CHUNK = 1024 * 1024


def receive(stream, length):
    """Save an uploaded WebM. Returns its path."""
    RECORDINGS_DIR.mkdir(exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H.%M.%S")
    path = RECORDINGS_DIR / f"live {stamp}.webm"
    n = 1
    while path.exists() or path.with_suffix(".mp4").exists():
        n += 1
        path = RECORDINGS_DIR / f"live {stamp} ({n}).webm"
    left = length
    with open(path, "wb") as f:
        while left > 0:
            chunk = stream.read(min(CHUNK, left))
            if not chunk:
                break
            f.write(chunk)
            left -= len(chunk)
    if left > 0:
        path.unlink(missing_ok=True)
        raise store.ApiError("The recording did not finish uploading.", 400)
    return path


def convert(webm, duration, job):
    """WebM to MP4. Deletes the WebM once the MP4 is written."""
    out = webm.with_suffix(".mp4")
    part = webm.with_suffix(".part.mp4")
    # Sides have to be even for H.264.
    cmd = ["ffmpeg", "-y", "-v", "error", "-progress", "pipe:1", "-nostats", "-i", str(webm),
           "-vf", "fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2", *render.encoder(),
           "-c:a", "aac", "-ac", "2", "-b:a", "256k", "-movflags", "+faststart", "-f", "mp4", str(part)]
    job.update(0.0, "Saving")
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as errf:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errf, text=True,
                                encoding="utf-8", errors="replace")
        for line in proc.stdout:
            m = re.match(r"out_time_us=(\d+)", line.strip())
            if m and duration:
                job.update(0.99 * int(m.group(1)) / 1e6 / duration, "Saving")
        code = proc.wait()
        errf.seek(0)
        err = errf.read()
    if code != 0:
        part.unlink(missing_ok=True)
        raise store.ApiError("ffmpeg could not convert the recording: " + err.strip()[-300:], 500)
    part.replace(out)
    webm.unlink(missing_ok=True)
    return {"name": out.name, "path": str(out), "url": f"/media/recording/{out.name}"}


def recording_path(name):
    path = (RECORDINGS_DIR / name).resolve()
    if path.parent != RECORDINGS_DIR.resolve() or path.suffix != ".mp4" or not path.is_file():
        raise store.ApiError("There is no such recording.", 404)
    return path


def reveal(name):
    """Open File Explorer with the recording selected."""
    path = recording_path(name)
    subprocess.Popen(["explorer", "/select,", str(path)])
    return {"ok": True}
