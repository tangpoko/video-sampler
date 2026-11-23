"""Renderer for Video Sampler: turns an edit.json into a finished video with the song on it.

Each segment is rendered as its own short file straight from the original film (or from the
proxy, with --draft), then they are joined without re-encoding and the song is laid on top.

Timing: every cut point is rounded to a frame at 24 fps once, and each segment gets exactly the
frames between its two cut points. Rounding errors therefore never add up, and the last frame
ends with the song.

Usage:
    python render.py edits/<name>.json --out renders/<name>.mp4 [--draft]
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

FPS = 24
FFMPEG = shutil.which("ffmpeg") or sys.exit("ffmpeg not found")


def effect_graph(fx, W, H, frames, beat_frames):
    """ffmpeg filter steps for a list of effects. Works on a W x H picture, returns a chain that
    can be pasted between two labels. Sizes are multiples of 4 so halves and quarters stay even."""
    parts = []
    for e in fx:
        if e == "mirror":
            parts.append(f"crop={W // 2}:{H}:0:0,split[m1][m2];[m2]hflip[m3];[m1][m3]hstack")
        elif e == "kaleidoscope":
            q = f"crop={W // 2}:{H // 2}:{W // 4}:{H // 4}"
            parts.append(f"{q},split=4[k1][k2][k3][k4];[k2]hflip[k2f];[k3]vflip[k3f];[k4]hflip,vflip[k4f];"
                         f"[k1][k2f]hstack[kt];[k3f][k4f]hstack[kb];[kt][kb]vstack")
        elif e in ("kaleido6", "kaleido8", "kaleido12"):
            parts.append("REMAP:" + e[7:])
        elif e == "stutter_fast":
            k = max(2, beat_frames // 4)
            parts.append(f"trim=end_frame={k},loop=loop=-1:size={k}:start=0,setpts=N/{FPS}/TB")
        elif e == "pingpong":
            # One beat forward then the same beat backward, repeated. On a cut shorter than two
            # beats, use half the cut each way so it still goes there and back once.
            k = max(2, min(beat_frames, frames // 2))
            parts.append(f"trim=end_frame={k},split[p1][p2];[p2]reverse[p3];[p1][p3]concat=n=2:v=1:a=0,"
                         f"loop=loop=-1:size={2 * k}:start=0,setpts=N/{FPS}/TB")
        elif e == "flip":
            parts.append("hflip")
        elif e == "upside_down":
            parts.append("vflip")
        elif e == "hue":
            parts.append("hue=h=t*90+120:s=1.4")
        elif e == "invert":
            parts.append("negate")
        elif e == "rgb_split":
            parts.append(f"format=gbrp,rgbashift=rh=-{W // 120}:bh={W // 120}:gv={H // 160},format=yuv420p")
        elif e == "posterize":
            lut = "floor(val/64)*64+32"
            parts.append(f"format=rgb24,lutrgb=r='{lut}':g='{lut}':b='{lut}',eq=saturation=1.3,format=yuv420p")
        elif e == "vhs":
            parts.append("eq=saturation=1.6:contrast=1.15,noise=alls=16:allf=t,"
                         f"chromashift=cbh={W // 200}:crh=-{W // 200}")
        elif e == "reverse":
            parts.append(f"trim=end_frame={frames},reverse")
        elif e == "stutter":
            # Repeat the first half beat until the cut ends.
            k = max(2, beat_frames // 2)
            parts.append(f"trim=end_frame={k},loop=loop=-1:size={k}:start=0,setpts=N/{FPS}/TB")
    return parts


def kaleido_maps(W, H, wedges, folder):
    """Lookup tables for a radial kaleidoscope with the given number of wedges.

    For every output pixel, work out its angle and distance from the centre, fold the angle into
    one wedge (mirroring every second wedge), and read the source picture at that folded spot.
    Reads that land outside the picture bounce back in, so there are never black gaps. ffmpeg's
    remap filter applies the tables, which is far faster than doing the maths per frame.
    """
    import numpy as np
    fx, fy = Path(folder) / f"kx_{W}x{H}_{wedges}.pgm", Path(folder) / f"ky_{W}x{H}_{wedges}.pgm"
    if fx.exists() and fy.exists():
        return str(fx), str(fy)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float64)
    dx, dy = xx - W / 2, yy - H / 2
    r = np.hypot(dx, dy)
    seg = 2 * np.pi / wedges
    t = np.mod(np.arctan2(dy, dx), seg)
    t = np.where(t > seg / 2, seg - t, t)
    # Point the source wedge up and to the right of centre, where films put faces and light.
    t = t - np.pi / 4
    sx = W / 2 + r * np.cos(t)
    sy = H / 2 + r * np.sin(t) * 0.9

    def bounce(v, size):
        v = np.mod(v, 2 * (size - 1))
        return np.where(v > size - 1, 2 * (size - 1) - v, v)

    for path, arr, size in ((fx, sx, W), (fy, sy, H)):
        data = np.round(bounce(arr, size)).astype(">u2")
        with open(path, "wb") as f:
            f.write(f"P5\n{W} {H}\n65535\n".encode())
            f.write(data.tobytes())
    return str(fx), str(fy)


def chain_to_graph(steps, src_label, out_label, remap_inputs=None):
    """Join filter steps into one filter_complex. Steps that contain their own labelled branches
    (mirror, kaleidoscope, ping-pong) need fresh labels each time they appear. A REMAP step reads
    its two lookup tables from extra ffmpeg inputs."""
    graph, cur = [], src_label
    for n, step in enumerate(steps):
        nxt = f"s{n}"
        if step.startswith("REMAP:"):
            ix, iy = remap_inputs[step[6:]]
            graph.append(f"[{cur}]format=gbrp[r{n}];[r{n}][{ix}:v][{iy}:v]remap,format=yuv420p[{nxt}]")
        else:
            step = step.replace("[m", f"[m{n}_").replace("[k", f"[k{n}_").replace("[p", f"[p{n}_")
            graph.append(f"[{cur}]{step}[{nxt}]")
        cur = nxt
    graph.append(f"[{cur}]null[{out_label}]")
    return ";".join(graph)


def render_segment(job):
    seg, src_path, crop, W, H, enc, out, beat_frames = job
    frames = seg["frames"]
    speed = seg["speed"]
    pre = []
    if crop:
        pre.append(f"crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']}")
    pre += [f"scale={W}:{H}:flags=bicubic", "setsar=1"]
    if abs(speed - 1) > 1e-3:
        pre.append(f"setpts=PTS/{speed}")
    pre += [f"fps={FPS}", "format=yuv420p"]
    steps = [",".join(pre)] + effect_graph(seg["effects"], W, H, frames, beat_frames)
    steps.append(f"scale={W}:{H},setsar=1,format=yuv420p")
    extra, remap_inputs = [], {}
    for step in steps:
        if step.startswith("REMAP:") and step[6:] not in remap_inputs:
            mx, my = kaleido_maps(W, H, int(step[6:]), Path(out).parent)
            n_in = 1 + len(extra) // 2
            remap_inputs[step[6:]] = (n_in, n_in + 1)
            extra += ["-i", mx, "-i", my]
    graph = chain_to_graph(steps, "0:v", "out", remap_inputs)
    read = frames / FPS * speed + 1.0
    cmd = [FFMPEG, "-v", "error", "-y", "-ss", f"{seg['src']:.3f}", "-t", f"{read:.3f}", "-i", src_path,
           *extra, "-filter_complex", graph, "-map", "[out]", "-frames:v", str(frames), "-an",
           *enc, "-r", str(FPS), out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"segment at {seg['t0']:.2f}s failed: {r.stderr[-800:]}\n{graph}")
    return out


def encoder():
    test = subprocess.run([FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:d=0.1",
                           "-c:v", "h264_nvenc", "-f", "null", "-"], capture_output=True)
    if test.returncode == 0:
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "19", "-pix_fmt", "yuv420p"]
    return ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p"]


def frame_size(lib, draft, width=1920):
    """Picture size for a render: the film's own shape after its black bars are cropped off,
    at the asked width (960 for drafts). Both sides are multiples of 4."""
    crop = lib["crop"]
    aspect = crop["w"] * lib["source"]["sar"] / crop["h"]
    W = (960 if draft else width) // 4 * 4
    H = round(W / aspect / 4) * 4
    return W, H


def render_edit(edit, out, draft=False, width=1920, jobs=4, progress=None):
    """Render a whole edit to one file. progress(done, total), if given, is called as cuts
    finish, so the editor can show how far an export is."""
    lib_dir = Path(edit["library"])
    lib = json.loads((lib_dir / "analysis.json").read_text())
    crop = lib["crop"]
    W, H = frame_size(lib, draft, width)
    if draft:
        src, crop = str(lib_dir / lib["proxy"]), None
    else:
        src = edit["film"]
    beat_frames = round(60 / edit["tempo"] * FPS)

    segs = edit["segments"]
    cuts = [round(s["t0"] * FPS) for s in segs] + [round(edit["duration"] * FPS)]
    work = Path(tempfile.mkdtemp(prefix="vs_render_"))
    enc = encoder()
    todo = []
    for k, s in enumerate(segs):
        s = dict(s, frames=cuts[k + 1] - cuts[k])
        if s["frames"] <= 0:
            continue
        todo.append((s, src, crop, W, H, enc, str(work / f"seg{k:04d}.mp4"), beat_frames))

    # Build the kaleidoscope lookup tables once, before the parallel renders need them.
    for wedges in {e[7:] for s in segs for e in s["effects"] if e in ("kaleido6", "kaleido8", "kaleido12")}:
        kaleido_maps(W, H, int(wedges), work)

    t0 = time.time()
    print(f"rendering {len(todo)} cuts at {W}x{H} from {'proxy' if draft else 'the original film'}")
    try:
        files = []
        with ThreadPoolExecutor(jobs) as pool:
            for f in pool.map(render_segment, todo):
                files.append(f)
                if progress:
                    progress(len(files), len(todo))
        lst = work / "list.txt"
        lst.write_text("".join(f"file '{Path(f).as_posix()}'\n" for f in files))
        out = Path(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([FFMPEG, "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
                        "-i", edit["song"], "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                        "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", str(out)], check=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(f"done in {time.time() - t0:.0f} s: {out}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("edit")
    ap.add_argument("--out", required=True)
    ap.add_argument("--draft", action="store_true", help="render from the small proxy, faster")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--jobs", type=int, default=4)
    a = ap.parse_args()
    edit = json.loads(Path(a.edit).read_text())
    render_edit(edit, a.out, a.draft, a.width, a.jobs)


if __name__ == "__main__":
    main()
