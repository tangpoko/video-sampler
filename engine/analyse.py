"""Clip analyser for Video Sampler.

Reads one film, finds its most colourful, high-movement and strange moments, and writes a clip
library: analysis.json (everything), clips.js (what the crate page reads), thumbnails, and a small
proxy copy of the film used for hover previews and, later, for editing.

The film is decoded once. ffmpeg splits the picture into two outputs: a tiny 12 fps stream piped
to Python for scoring, and the proxy file written to disk.

Usage:
    python analyse.py <film> --out <library folder>
"""
import argparse
import json
import math
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import cv2
import numpy as np

# Analysis runs at 12 frames per second. That is enough to place a cut within a twelfth of a
# second, and halves the work compared with decoding every frame of a 24 fps film.
ANALYSIS_FPS = 12
ANALYSIS_W = 320
FLOW_W = 160
# Every 6th analysis frame (2 per second) goes to CLIP and is kept as a possible thumbnail.
CLIP_EVERY = 6
CLIP_BATCH = 128
PROXY_H = 480

# Windows are the candidate clips. 2 seconds long, sliding by half a second inside each shot.
WIN_FRAMES = 2 * ANALYSIS_FPS
WIN_STEP = ANALYSIS_FPS // 2
MIN_SHOT_FRAMES = 6          # shots under half a second are skipped
MAX_PER_SHOT = 3             # at most 3 non-overlapping clips from one shot

# Cut detection. A frame is a cut when its change from the previous frame is at least this many
# times bigger than the average change around it, and above an absolute floor.
CUT_RATIO = 3.0
CUT_FLOOR = 18.0
CUT_NEIGHBOURS = 6

INTEREST_POS = [
    "a surreal, strange, dreamlike image",
    "vivid psychedelic colours",
    "people dancing",
    "a spectacular colourful stage show",
    "a bizarre and striking scene",
    "dramatic lighting with bold colours",
    "an explosion of colour and movement",
    "a kaleidoscopic pattern",
    "glamorous costumes and sets",
    "a grand musical number",
]
INTEREST_NEG = [
    "a person talking in a plain room",
    "a plain close-up of a face talking",
    "an ordinary office or kitchen",
    "a blurry, out of focus frame",
]
TEXT_PROMPT = "text on screen, a title card or credits"
DARK_PROMPT = "a blank dark screen"

TAGS = [
    "dancing", "crowd", "face close-up", "landscape", "sky", "night city", "neon lights", "fire",
    "water", "explosion", "animals", "cars", "machines", "flowers", "musicians", "singing",
    "costumes", "stage", "abstract pattern", "space", "beach", "jungle", "kissing", "fighting",
    "running", "spinning", "smoke", "mirrors", "lights", "food",
]


# ----------------------------------------------------------------------------- ffmpeg helpers

def need(tool):
    path = shutil.which(tool)
    if not path:
        sys.exit(f"{tool} was not found on PATH")
    return path


FFMPEG = need("ffmpeg")
FFPROBE = need("ffprobe")


def probe(film):
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,sample_aspect_ratio:format=duration",
         "-of", "json", str(film)],
        capture_output=True, text=True, check=True).stdout
    data = json.loads(out)
    s = data["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    sar = s.get("sample_aspect_ratio", "1:1")
    if sar in ("0:1", "N/A", None):
        sar = "1:1"
    sn, sd = sar.split(":")
    return {
        "width": int(s["width"]),
        "height": int(s["height"]),
        "fps": float(num) / float(den),
        "sar": float(sn) / float(sd),
        "duration": float(data["format"]["duration"]),
    }


def detect_bars(film, info, samples=20):
    """Find black letterbox or pillarbox bars by looking at frames spread across the film.

    A row is a bar if it stays near black in every sampled frame. Bright scenes anywhere in the
    film light up the real picture rows, so taking the brightest value per row over all samples
    separates picture from bar.
    """
    W, H = info["width"], info["height"]
    row_max = np.zeros(180, np.float32)
    col_max = np.zeros(320, np.float32)
    got = 0
    for k in range(samples):
        t = info["duration"] * (k + 0.5) / samples
        raw = subprocess.run(
            [FFMPEG, "-v", "error", "-ss", f"{t:.2f}", "-i", str(film), "-frames:v", "1",
             "-vf", "scale=320:180,format=gray", "-f", "rawvideo", "-"],
            capture_output=True).stdout
        if len(raw) != 320 * 180:
            continue
        g = np.frombuffer(raw, np.uint8).reshape(180, 320).astype(np.float32)
        row_max = np.maximum(row_max, g.mean(1))
        col_max = np.maximum(col_max, g.mean(0))
        got += 1
    full = {"x": 0, "y": 0, "w": W, "h": H}
    if got < 3:
        return full

    def span(profile, size, n):
        live = np.where(profile >= 18)[0]
        if len(live) == 0:
            return 0, size
        a = math.floor(live[0] * size / n)
        b = math.ceil((live[-1] + 1) * size / n)
        # one sample row of margin inwards, so a soft bar edge does not leave a dark line
        if a > 0:
            a += math.ceil(size / n)
        if b < size:
            b -= math.ceil(size / n)
        return a, b

    y0, y1 = span(row_max, H, 180)
    x0, x1 = span(col_max, W, 320)
    x0, y0 = x0 // 2 * 2, y0 // 2 * 2
    w, h = (x1 - x0) // 2 * 2, (y1 - y0) // 2 * 2
    # Refuse crops that remove more than 40% of either side. Those come from dark films, not bars.
    if w < 0.6 * W or h < 0.6 * H:
        return full
    return {"x": x0, "y": y0, "w": w, "h": h}


def pick_encoder():
    """Use the NVIDIA encoder for the proxy when it works, otherwise x264."""
    test = subprocess.run(
        [FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:d=0.1",
         "-c:v", "h264_nvenc", "-f", "null", "-"], capture_output=True)
    if test.returncode == 0:
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "30"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "27"]


# ----------------------------------------------------------------------------- CLIP

class Clip:
    def __init__(self):
        import torch
        import open_clip
        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model, _, _ = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="laion2b_s34b_b79k", device=self.device)
        self.model.eval()
        tok = open_clip.get_tokenizer("ViT-B-32")
        self.mean = torch.tensor([0.48145466, 0.4578275, 0.40821073], device=self.device).view(1, 3, 1, 1)
        self.std = torch.tensor([0.26862954, 0.26130258, 0.27577711], device=self.device).view(1, 3, 1, 1)
        prompts = INTEREST_POS + INTEREST_NEG + [TEXT_PROMPT, DARK_PROMPT]
        with torch.no_grad():
            self.prompt_emb = self._text(tok, prompts)
            self.tag_emb = self._text(tok, [f"a film still of {t}" for t in TAGS])
        self.n_pos = len(INTEREST_POS)
        self.i_text = len(INTEREST_POS) + len(INTEREST_NEG)
        self.i_dark = self.i_text + 1

    def _text(self, tok, texts):
        e = self.model.encode_text(tok(texts).to(self.device)).float()
        return e / e.norm(dim=-1, keepdim=True)

    def encode(self, crops):
        """crops: list of 224x224x3 uint8 RGB. Returns (embeddings, interest, text_p, dark_p, tag_sims)."""
        torch = self.torch
        x = torch.from_numpy(np.stack(crops)).to(self.device).permute(0, 3, 1, 2).float() / 255.0
        x = (x - self.mean) / self.std
        with torch.no_grad(), torch.autocast(self.device, enabled=self.device == "cuda"):
            e = self.model.encode_image(x).float()
        e = e / e.norm(dim=-1, keepdim=True)
        p = (100.0 * e @ self.prompt_emb.T).softmax(dim=-1)
        interest = p[:, :self.n_pos].sum(-1)
        tags = e @ self.tag_emb.T
        return (e.cpu().numpy().astype(np.float16), interest.cpu().numpy(),
                p[:, self.i_text].cpu().numpy(), p[:, self.i_dark].cpu().numpy(),
                tags.cpu().numpy().astype(np.float16))


def clip_crop(rgb):
    h, w = rgb.shape[:2]
    s = 224 / min(h, w)
    r = cv2.resize(rgb, (max(224, round(w * s)), max(224, round(h * s))), interpolation=cv2.INTER_CUBIC)
    y = (r.shape[0] - 224) // 2
    x = (r.shape[1] - 224) // 2
    return np.ascontiguousarray(r[y:y + 224, x:x + 224])


# ----------------------------------------------------------------------------- per-frame pass

def analyse_stream(film, info, crop, out_dir, clip):
    disp_w = round(crop["w"] * info["sar"])
    aw = ANALYSIS_W
    ah = max(2, round(aw * crop["h"] / disp_w / 2) * 2)
    fh = max(2, round(FLOW_W * ah / aw))
    proxy = out_dir / "proxy.mp4"
    graph = (
        f"[0:v]crop={crop['w']}:{crop['h']}:{crop['x']}:{crop['y']},"
        f"scale={disp_w}:{crop['h']},setsar=1,split=2[a][b];"
        f"[a]fps={ANALYSIS_FPS},scale={aw}:{ah}:flags=area,format=rgb24[an];"
        f"[b]scale=-2:{min(PROXY_H, crop['h'])},format=yuv420p[px]"
    )
    # A keyframe every half second keeps hover-preview seeking fast.
    gop = max(1, round(info["fps"] / 2))
    cmd = [FFMPEG, "-v", "error", "-y", "-i", str(film), "-filter_complex", graph,
           "-map", "[an]", "-f", "rawvideo", "pipe:1",
           "-map", "[px]", "-an", *pick_encoder(), "-g", str(gop), "-movflags", "+faststart",
           str(proxy)]
    errlog = tempfile.TemporaryFile()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=errlog, bufsize=aw * ah * 3 * 8)

    fsize = aw * ah * 3
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_ULTRAFAST)
    feats = {k: [] for k in ("diff", "colour", "sat", "val", "contrast", "hx", "hy", "hw",
                             "mag", "local", "dx", "dy")}
    prev_hsv = prev_gray = None
    crops, crop_idx = [], []
    clip_out = {k: [] for k in ("emb", "interest", "text", "dark", "tags")}
    thumbs = {}
    n = 0
    t0 = last = time.time()
    total = info["duration"] * ANALYSIS_FPS

    def flush():
        if not crops:
            return
        e, i, tx, dk, tg = clip.encode(crops)
        clip_out["emb"].append(e)
        clip_out["interest"].append(i)
        clip_out["text"].append(tx)
        clip_out["dark"].append(dk)
        clip_out["tags"].append(tg)
        crops.clear()

    while True:
        buf = proc.stdout.read(fsize)
        if len(buf) < fsize:
            break
        rgb = np.frombuffer(buf, np.uint8).reshape(ah, aw, 3)

        # Change from the previous frame, for cut detection. Same measure PySceneDetect uses:
        # the mean difference of hue, saturation and brightness on a small copy.
        small = cv2.resize(rgb, (64, 36), interpolation=cv2.INTER_AREA)
        hsv_s = cv2.cvtColor(small, cv2.COLOR_RGB2HSV).astype(np.int16)
        feats["diff"].append(0.0 if prev_hsv is None else float(np.abs(hsv_s - prev_hsv).mean()))
        prev_hsv = hsv_s

        # Colour. Colourfulness is the Hasler and Susstrunk measure: about 15 is dull,
        # 60 is very colourful, above 100 is extreme.
        mid = cv2.resize(rgb, (FLOW_W, fh), interpolation=cv2.INTER_AREA)
        f = mid.astype(np.float32)
        rg = f[..., 0] - f[..., 1]
        yb = 0.5 * (f[..., 0] + f[..., 1]) - f[..., 2]
        feats["colour"].append(float(math.hypot(rg.std(), yb.std()) + 0.3 * math.hypot(rg.mean(), yb.mean())))
        hsv = cv2.cvtColor(mid, cv2.COLOR_RGB2HSV).astype(np.float32)
        s, v = hsv[..., 1] / 255.0, hsv[..., 2] / 255.0
        feats["sat"].append(float(s.mean()))
        feats["val"].append(float(v.mean()))
        gray = cv2.cvtColor(mid, cv2.COLOR_RGB2GRAY)
        feats["contrast"].append(float(gray.std() / 255.0))
        # Dominant hue as a weighted average on the colour wheel, weighted by how saturated and
        # bright each pixel is. Kept as x and y so windows can average it.
        w = s * v
        ang = hsv[..., 0] * (math.pi / 90.0)
        feats["hx"].append(float((w * np.cos(ang)).sum()))
        feats["hy"].append(float((w * np.sin(ang)).sum()))
        feats["hw"].append(float(w.sum()))

        # Movement. Optical flow between this frame and the last, measured in frame widths per
        # second. "local" removes the average flow, so a camera pan over a still scene scores
        # low and a dancer in a locked-off shot scores high.
        if prev_gray is None:
            feats["mag"].append(np.nan); feats["local"].append(np.nan)
            feats["dx"].append(0.0); feats["dy"].append(0.0)
        else:
            flow = dis.calc(prev_gray, gray, None)
            scale = ANALYSIS_FPS / FLOW_W
            mdx, mdy = float(np.median(flow[..., 0])), float(np.median(flow[..., 1]))
            feats["mag"].append(float(np.sqrt((flow ** 2).sum(-1)).mean()) * scale)
            feats["local"].append(float(np.hypot(flow[..., 0] - mdx, flow[..., 1] - mdy).mean()) * scale)
            feats["dx"].append(mdx * scale)
            feats["dy"].append(mdy * scale)
        prev_gray = gray

        if n % CLIP_EVERY == 0:
            crops.append(clip_crop(rgb))
            crop_idx.append(n)
            ok, jpg = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 82])
            thumbs[n] = jpg.tobytes()
            if len(crops) >= CLIP_BATCH:
                flush()
        n += 1

        if time.time() - last > 10:
            last = time.time()
            pct = 100 * n / max(1, total)
            rate = n / ANALYSIS_FPS / (last - t0)
            print(f"  {pct:5.1f}%  {n / ANALYSIS_FPS / 60:6.1f} min of film read, {rate:4.1f}x real time", flush=True)

    flush()
    proc.wait()
    if proc.returncode != 0:
        errlog.seek(0)
        sys.exit("ffmpeg failed:\n" + errlog.read().decode(errors="replace")[-2000:])

    arrays = {k: np.asarray(v, np.float32) for k, v in feats.items()}
    cl = {k: np.concatenate(v) for k, v in clip_out.items()}
    cl["idx"] = np.asarray(crop_idx)
    return n, arrays, cl, thumbs, (aw, ah)


# ----------------------------------------------------------------------------- shots and windows

def find_cuts(diff):
    n = len(diff)
    cuts = [0]
    for i in range(1, n):
        lo, hi = max(1, i - CUT_NEIGHBOURS), min(n, i + CUT_NEIGHBOURS + 1)
        around = np.concatenate([diff[lo:i], diff[i + 1:hi]])
        base = float(around.mean()) if len(around) else 0.0
        if diff[i] >= CUT_FLOOR and diff[i] >= CUT_RATIO * max(base, 2.0):
            if i - cuts[-1] >= 3:  # ignore flicker inside a quarter second
                cuts.append(i)
    cuts.append(n)
    return [(cuts[k], cuts[k + 1]) for k in range(len(cuts) - 1)]


def pct_rank(x):
    """Percentile rank from 0 to 1. Equal values share their average rank, so a stretch of
    identical frames (a still title card, a black screen) does not get arbitrary scores."""
    x = np.asarray(x, np.float64)
    s = np.sort(x)
    lo = np.searchsorted(s, x, side="left")
    hi = np.searchsorted(s, x, side="right") - 1
    return ((lo + hi) / 2) / max(1, len(x) - 1)


def build_windows(n, f, cl, shots):
    # A shot's first frame has flow measured across the cut, which is meaningless.
    for s, _ in shots:
        if s < n:
            f["mag"][s] = np.nan
            f["local"][s] = np.nan

    pos_of = {idx: k for k, idx in enumerate(cl["idx"])}
    wins = []
    for si, (s, e) in enumerate(shots):
        a0, a1 = s + 1, e - 1          # trim a frame at each end, away from the cut
        length = a1 - a0
        if length < MIN_SHOT_FRAMES:
            continue
        if length <= WIN_FRAMES:
            spans = [(a0, a1)]
        else:
            spans = [(a, a + WIN_FRAMES) for a in range(a0, a1 - WIN_FRAMES + 1, WIN_STEP)]
        for a, b in spans:
            ci = [pos_of[i] for i in range(a, b) if i in pos_of]
            if not ci:
                continue
            wins.append({"shot": si, "a": a, "b": b, "ci": ci})

    W = len(wins)
    if W == 0:
        return [], None

    def wmean(key):
        return np.array([np.nanmean(f[key][w["a"]:w["b"]]) if not np.all(np.isnan(f[key][w["a"]:w["b"]]))
                         else 0.0 for w in wins], np.float32)

    colour, sat, val, contrast = wmean("colour"), wmean("sat"), wmean("val"), wmean("contrast")
    mag, local, dx, dy = wmean("mag"), wmean("local"), wmean("dx"), wmean("dy")
    hx = np.array([f["hx"][w["a"]:w["b"]].sum() for w in wins])
    hy = np.array([f["hy"][w["a"]:w["b"]].sum() for w in wins])
    hw = np.array([f["hw"][w["a"]:w["b"]].sum() for w in wins]) + 1e-6
    hue = (np.degrees(np.arctan2(hy, hx)) + 360) % 360
    hue_strength = np.hypot(hx, hy) / hw * sat

    emb = np.stack([cl["emb"][w["ci"]].astype(np.float32).mean(0) for w in wins])
    emb /= np.linalg.norm(emb, axis=1, keepdims=True) + 1e-8
    interest = np.array([cl["interest"][w["ci"]].mean() for w in wins])
    text_p = np.array([cl["text"][w["ci"]].mean() for w in wins])
    dark_p = np.array([cl["dark"][w["ci"]].mean() for w in wins])
    tags = np.stack([cl["tags"][w["ci"]].astype(np.float32).mean(0) for w in wins])
    shot_ids = np.array([w["shot"] for w in wins])

    novelty = novelty_scores(emb, shot_ids)

    # Film-relative scores from 0 to 1. Ranking inside the film means a muted film still has
    # its own most colourful moments float to the top.
    colour_s = pct_rank(colour)
    motion_s = pct_rank(0.6 * local + 0.4 * mag)
    strange_s = 0.5 * pct_rank(interest) + 0.5 * pct_rank(novelty)
    dark_frac = np.array([np.mean(f["val"][w["a"]:w["b"]] < 0.07) for w in wins])
    flat = contrast < 0.04
    quality = (1 - 0.8 * dark_frac) * (1 - 0.8 * np.clip(text_p * 2, 0, 1)) * \
              (1 - 0.5 * np.clip(dark_p * 2, 0, 1)) * np.where(flat, 0.4, 1.0)

    for k, w in enumerate(wins):
        w.update({
            "colour": float(colour_s[k]), "motion": float(motion_s[k]), "strange": float(strange_s[k]),
            "quality": float(quality[k]),
            "raw": {"colourfulness": round(float(colour[k]), 1), "saturation": round(float(sat[k]), 3),
                    "brightness": round(float(val[k]), 3), "contrast": round(float(contrast[k]), 3),
                    "motion": round(float(mag[k]), 3), "local_motion": round(float(local[k]), 3),
                    "interest": round(float(interest[k]), 3), "novelty": round(float(novelty[k]), 3),
                    "text": round(float(text_p[k]), 3)},
            "hue": round(float(hue[k]), 1), "hue_strength": round(float(hue_strength[k]), 3),
            "pan": [round(float(dx[k]), 3), round(float(dy[k]), 3)],
        })
    return wins, {"emb": emb, "tags": tags}


def novelty_scores(emb, shot_ids, k=10):
    """How unlike the rest of the film each window looks.

    For each window, take its 10 most similar windows from other shots. A high average
    similarity means the film is full of images like it. Novelty is one minus that average.
    """
    import torch
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    E = torch.from_numpy(emb).to(dev).half()
    S = torch.from_numpy(shot_ids).to(dev)
    out = np.zeros(len(emb), np.float32)
    k = min(k, max(1, len(emb) - 1))
    for i in range(0, len(emb), 1024):
        sims = (E[i:i + 1024] @ E.T).float()
        same = S[i:i + 1024, None] == S[None, :]
        sims[same] = -1.0
        top = sims.topk(k, dim=1).values
        top = torch.where(top < -0.5, torch.zeros_like(top), top)
        out[i:i + 1024] = (1 - top.mean(1)).cpu().numpy()
    return out


DEFAULT_WEIGHTS = {"colour": 0.35, "motion": 0.30, "strange": 0.35}


def score(w, weights=DEFAULT_WEIGHTS):
    tot = sum(weights.values())
    return w["quality"] * sum(weights[k] * w[k] for k in weights) / tot


def select_candidates(wins):
    """Pick up to 3 non-overlapping windows per shot, best first."""
    by_shot = {}
    for k, w in enumerate(wins):
        by_shot.setdefault(w["shot"], []).append(k)
    chosen = []
    for ks in by_shot.values():
        ks = sorted(ks, key=lambda k: -score(wins[k]))
        taken = []
        for k in ks:
            w = wins[k]
            if all(w["b"] <= wins[t]["a"] or w["a"] >= wins[t]["b"] for t in taken):
                taken.append(k)
                if len(taken) >= MAX_PER_SHOT:
                    break
        chosen.extend(taken)
    return sorted(chosen, key=lambda k: -score(wins[k]))


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("film")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    film = Path(args.film).resolve()
    out = Path(args.out).resolve()
    (out / "thumbs").mkdir(parents=True, exist_ok=True)
    t_start = time.time()

    info = probe(film)
    print(f"{film.name}: {info['width']}x{info['height']}, {info['fps']:.2f} fps, {info['duration'] / 60:.1f} min")
    crop = detect_bars(film, info)
    if crop["w"] != info["width"] or crop["h"] != info["height"]:
        print(f"black bars found, cropping to {crop['w']}x{crop['h']} at {crop['x']},{crop['y']}")

    print("loading CLIP")
    clip = Clip()
    print(f"CLIP running on {clip.device}")

    print("reading film")
    n, f, cl, thumbs, (aw, ah) = analyse_stream(film, info, crop, out, clip)
    t_read = time.time() - t_start

    shots = find_cuts(f["diff"])
    wins, extra = build_windows(n, f, cl, shots)
    if not wins:
        sys.exit("no usable clips found")
    chosen = select_candidates(wins)

    clips = []
    for rank, k in enumerate(chosen):
        w = wins[k]
        mid = (w["a"] + w["b"]) // 2
        tidx = min(cl["idx"], key=lambda i: abs(i - mid))
        cid = f"c{k:05d}"
        (out / "thumbs" / f"{cid}.jpg").write_bytes(thumbs[tidx])
        tag_sims = extra["tags"][k]
        top = np.argsort(-tag_sims)[:3]
        clips.append({
            "id": cid, "shot": w["shot"],
            "start": round(w["a"] / ANALYSIS_FPS, 3), "end": round(w["b"] / ANALYSIS_FPS, 3),
            "colour": round(w["colour"], 3), "motion": round(w["motion"], 3),
            "strange": round(w["strange"], 3), "quality": round(w["quality"], 3),
            "score": round(score(w), 3),
            "hue": w["hue"], "hue_strength": w["hue_strength"], "pan": w["pan"],
            "tags": [TAGS[t] for t in top],
            "raw": w["raw"],
        })

    library = {
        "film": film.name, "film_path": str(film),
        "duration": info["duration"], "source": info, "crop": crop,
        "analysis_fps": ANALYSIS_FPS, "proxy": "proxy.mp4",
        "shots": [[round(s / ANALYSIS_FPS, 3), round(e / ANALYSIS_FPS, 3)] for s, e in shots],
        "weights": DEFAULT_WEIGHTS, "tags": TAGS,
        "clips": clips,
    }
    (out / "analysis.json").write_text(json.dumps(library, indent=1))
    (out / "clips.js").write_text("window.LIBRARY = " + json.dumps(library) + ";\n")
    np.save(out / "clip_embeddings.npy", extra["emb"][chosen].astype(np.float16))
    shutil.copy(Path(__file__).with_name("crate_template.html"), out / "crate.html")

    took = time.time() - t_start
    print(f"done in {took / 60:.1f} min (reading {t_read / 60:.1f} min): "
          f"{len(shots)} shots, {len(wins)} windows scored, {len(clips)} clips in the crate")
    print(f"open {out / 'crate.html'}")


if __name__ == "__main__":
    main()
