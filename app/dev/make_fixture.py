"""Build contract-shaped JSON fixtures for the editor's mock mode (app/index.html?mock=1).

Reads real data already on disk and writes app/dev/fixtures/*.json in the shapes that
docs/API.md describes, so the page can be developed without engine/server.py.

Usage (from the project folder):
    engine/.venv/Scripts/python app/dev/make_fixture.py
"""
import json
import random
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "fixtures"

LIBRARY = "neon-demon"
SONG = "afterhours"
EDIT = "neon-afterhours-3"
PROJECT_ID = "neon-afterhours"
PROJECT_NAME = "Neon Afterhours"
PEAKS = 2000

# Same ids as FX_WEIGHTS in engine/auto.py. Kept as a plain table so this script does not have
# to import the engine (auto.py pulls in the heavy analysis stack).
EFFECTS = [
    ("kaleidoscope", "4-way mirror", "picture", 3.5),
    ("kaleido6", "Kaleidoscope 6", "picture", 2.0),
    ("kaleido8", "Kaleidoscope 8", "picture", 2.0),
    ("kaleido12", "Kaleidoscope 12", "picture", 0.0),
    ("mirror", "Mirror", "picture", 3.0),
    ("flip", "Flip", "picture", 1.0),
    ("upside_down", "Upside down", "picture", 0.6),
    ("hue", "Hue shift", "picture", 1.2),
    ("invert", "Invert", "picture", 0.6),
    ("rgb_split", "RGB split", "picture", 1.2),
    ("posterize", "Posterize", "picture", 0.0),
    ("vhs", "VHS noise", "picture", 1.2),
    ("stutter", "Stutter", "time", 3.0),
    ("stutter_fast", "Fast stutter", "time", 2.0),
    ("pingpong", "Ping-pong", "time", 3.0),
    ("reverse", "Reverse", "time", 1.2),
]


def load(path):
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def song_peaks(path, n=PEAKS):
    """Loudness outline: the loudest sample in each of n equal slices, scaled so the top is 1."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", "8000", "-f", "f32le", "-"],
        check=True, capture_output=True).stdout
    x = np.abs(np.frombuffer(raw, dtype=np.float32))
    edges = np.linspace(0, len(x), n + 1).astype(int)
    peaks = np.array([x[a:b].max() if b > a else 0.0 for a, b in zip(edges[:-1], edges[1:])])
    top = float(peaks.max()) or 1.0
    return [round(float(p) / top, 3) for p in peaks]


def main():
    analysis = load(f"library/{LIBRARY}/analysis.json")
    song = load(f"songs/{SONG}.json")
    edit = load(f"edits/{EDIT}.json")
    OUT.mkdir(parents=True, exist_ok=True)

    shots = analysis["shots"]
    clips = []
    for c in analysis["clips"]:
        s0, s1 = shots[c["shot"]]
        clips.append({
            "id": c["id"], "shot": c["shot"], "start": c["start"], "end": c["end"],
            "shot_start": s0, "shot_end": s1,
            "colour": c["colour"], "motion": c["motion"], "strange": c["strange"],
            "quality": c["quality"], "hue": c["hue"], "hue_strength": c["hue_strength"],
            "tags": c["tags"],
        })
    crop = analysis["crop"]
    aspect = round(crop["w"] * analysis["source"].get("sar", 1.0) / crop["h"], 3)

    rng = random.Random(7)
    seen = set()

    def new_id():
        while True:
            i = "".join(rng.choice("abcdefghjkmnpqrstuvwxyz23456789") for _ in range(4))
            if i not in seen:
                seen.add(i)
                return i

    cuts = []
    for s in edit["segments"]:
        cuts.append({
            "id": new_id(), "t0": s["t0"], "t1": s["t1"], "beat0": s["beat0"], "beats": s["beats"],
            "section": s["section"], "label": s["label"],
            "clip": s["clip"], "src": s["src"], "speed": s["speed"],
            "effects": s["effects"], "locked": False,
        })
    assert cuts[0]["t0"] == 0 and abs(cuts[-1]["t1"] - song["duration"]) < 1e-6
    assert all(abs(a["t1"] - b["t0"]) < 1e-9 for a, b in zip(cuts, cuts[1:]))

    settings = {k: edit["settings"][k] for k in
                ("cut_speed", "repetition", "effects", "colour", "motion", "strange")}
    settings["fx_weights"] = {e[0]: e[3] for e in EFFECTS}

    project = {
        "id": PROJECT_ID, "name": PROJECT_NAME,
        "version": 1, "can_undo": False, "can_redo": False,
        "library": {
            "id": LIBRARY, "film": analysis["film"], "aspect": aspect,
            "proxy_url": f"/media/library/{LIBRARY}/proxy.mp4",
            "thumb_url": f"/media/library/{LIBRARY}/thumbs/{{clip}}.jpg",
        },
        "song": {
            "id": SONG, "name": SONG, "url": f"/media/song/{SONG}",
            "duration": song["duration"], "tempo": song["tempo"],
            "beats": [{"t": b["t"], "downbeat": b["downbeat"]} for b in song["beats"]],
            "sections": [{"t0": s["t0"], "t1": s["t1"], "label": s["label"], "energy": s["energy"]}
                         for s in song["sections"]],
            "peaks": song_peaks(Path(song["song"]) if Path(song["song"]).exists()
                                else ROOT / "songs" / f"{SONG}.wav"),
        },
        "settings": settings,
        "seed": edit["seed"],
        "effects_available": [{"id": e[0], "name": e[1], "kind": e[2]} for e in EFFECTS],
        "cuts": cuts,
        "preview": {"version": 1, "status": "ready", "pending": 0,
                    "url": f"/media/preview/{PROJECT_ID}/1.mp4"},
    }

    first_thumb = f"/media/library/{LIBRARY}/thumbs/{cuts[0]['clip']}.jpg"
    files = {
        "project.json": project,
        "clips.json": {"clips": clips, "tags": analysis["tags"]},
        "libraries.json": [{"id": LIBRARY, "film": analysis["film"],
                            "duration": analysis["duration"], "clips": len(clips),
                            "thumb": f"/media/library/{LIBRARY}/thumbs/{clips[0]['id']}.jpg"}],
        "songs.json": [{"id": SONG, "name": SONG, "duration": song["duration"],
                        "tempo": song["tempo"]}],
        "projects.json": [{"id": PROJECT_ID, "name": PROJECT_NAME, "library": LIBRARY,
                           "song": SONG, "modified": "2026-11-10T04:34:00", "thumb": first_thumb}],
    }
    for name, data in files.items():
        (OUT / name).write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
        print(f"{name:16} {(OUT / name).stat().st_size / 1024:8.1f} KB")
    print(f"{len(cuts)} cuts, {len(clips)} clips, {len(project['song']['peaks'])} peaks, aspect {aspect}")


if __name__ == "__main__":
    sys.exit(main())
