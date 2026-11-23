# Video Sampler

A visual sampler for making music videos out of films. You load one film and one song. The
engine scrubs the whole film for its most colourful, strange and high-movement moments, then cuts
an edit to the song, either automatically (with reroll) or by hand on a timeline. The look it aims
for is the hand-made VHS party edit from the 90s, done in minutes instead of weeks.

There is a simpler sibling project, **video-sampler-mini**, a small browser-only version built
as a music visualizer.

## How it works

1. **Analyse the film** (`engine/analyse.py`). ffmpeg decodes the film once at low resolution.
   OpenCV scores each moment for colour and motion (optical flow). A CLIP model (open_clip, on
   the GPU) scores how strange each moment looks and makes the clips searchable by text. The same
   pass writes a small proxy copy of the film for fast previews.
2. **Analyse the song** (`engine/song.py`). librosa finds beats, bars, sections and how much
   energy each section has.
3. **Plan the edit** (`engine/auto.py`). A planner picks clips to fit the song's structure.
   Sliders control cut speed, how often clips repeat, how strong the effects are, and how much
   colour, motion and strangeness count. A new seed is a reroll.
4. **Render** (`engine/render.py`). Each cut is rendered from the original film (or the proxy,
   for drafts) with its effects, then joined with the song. Cut points are rounded to 24 fps
   frames once, so timing never drifts against the beat.

Effects include mirror, flip, kaleidoscope, hue shift, invert, posterize, RGB split, VHS noise,
reverse, speed change and stutter.

## The editor

`engine/server.py` serves a browser editor from `app/`: a clip crate you can search and preview
on hover, a timeline, an inspector for each cut, undo, and rerolls. Rerolls call the same planner
as auto mode, so the taste rules live in one place. Changed cuts re-render in the background
(`engine/preview.py`). The server uses only Python's standard library. Its API is documented in
[docs/API.md](docs/API.md).

There is also a live player (`app/live.html`) that plays a film with WebGL2 shader effects in
real time, synced to the beat. `engine/live.py` makes a browser-playable copy of the film first,
since browsers can't play most HEVC or MKV files.

## Tech

- Python 3.13: ffmpeg, OpenCV, open_clip (PyTorch, CUDA build), librosa, NumPy, SciPy
- Plain JavaScript and CSS front end, no framework
- WebGL2 shaders for the live effects
- Built and tested on Windows with an NVIDIA GPU

## Running it

Media is not included. Bring your own film and song.

```
cd engine
uv venv
uv pip install numpy scipy opencv-python librosa soundfile pillow open_clip_torch
uv pip install --reinstall torch torchvision --index-url https://download.pytorch.org/whl/cu128
```

Installing `open_clip_torch` pulls in the CPU build of PyTorch, which is why the second line
reinstalls the CUDA build. ffmpeg must be on your PATH.

Auto mode, from the project folder:

```
engine/.venv/Scripts/python engine/analyse.py <film> --out library/<name>
engine/.venv/Scripts/python engine/song.py <song> --out songs/<song>.json
engine/.venv/Scripts/python engine/auto.py --library library/<name> --song songs/<song>.json --out edits/<edit>.json --seed 1
engine/.venv/Scripts/python engine/render.py edits/<edit>.json --out renders/<edit>.mp4 --draft
```

The editor:

```
engine/.venv/Scripts/python engine/server.py
```

Then open http://127.0.0.1:8770/.
