"""Song analysis for Video Sampler.

Finds the beats, bars and sections of a song, and how much energy each part has. Auto mode uses
this to decide where cuts land, how fast they come, and which parts of the song share a look.

Usage:
    python song.py <song> --out <song.json>
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 22050
HOP = 512


def load_audio(path):
    ffmpeg = shutil.which("ffmpeg") or sys.exit("ffmpeg not found")
    raw = subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR),
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def norm01(x):
    x = np.asarray(x, np.float64)
    lo, hi = np.percentile(x, 5), np.percentile(x, 95)
    return np.clip((x - lo) / (hi - lo + 1e-9), 0, 1)


def analyse_song(path):
    import librosa

    y = load_audio(path)
    duration = len(y) / SR

    onset_env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    tempo, beats = librosa.beat.beat_track(onset_envelope=onset_env, sr=SR, hop_length=HOP)
    tempo = float(np.atleast_1d(tempo)[0])
    beat_t = librosa.frames_to_time(beats, sr=SR, hop_length=HOP)
    if len(beat_t) < 8:
        sys.exit("could not find a steady beat in this song")

    # Fill in beats before the first detected one and after the last, at the same spacing, so
    # quiet intros and outros still have a grid to cut on.
    step = float(np.median(np.diff(beat_t)))
    front = np.arange(beat_t[0] - step, -1e-6, -step)[::-1]
    back = np.arange(beat_t[-1] + step, duration - step * 0.5, step)
    beat_t = np.concatenate([front, beat_t, back])
    n_front = len(front)

    # Downbeats. Assume 4 beats to a bar and find which of the 4 positions carries the kick:
    # the one with the most low-frequency punch is beat 1.
    S = np.abs(librosa.stft(y, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=SR)
    low = S[freqs < 150].sum(0)
    low_onset = np.maximum(0, np.diff(low, prepend=low[0]))
    bf = librosa.time_to_frames(beat_t, sr=SR, hop_length=HOP).clip(0, len(low_onset) - 1)
    kick = np.array([low_onset[max(0, f - 2):f + 3].max() for f in bf])
    phase = int(np.argmax([kick[p::4].mean() for p in range(4)]))
    downbeat_idx = list(range(phase, len(beat_t), 4))

    # Per-beat loudness and busyness.
    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    rms_db = librosa.amplitude_to_db(rms + 1e-6)
    edges = np.concatenate([bf, [len(rms)]])
    beat_rms = np.array([rms_db[edges[i]:max(edges[i] + 1, edges[i + 1])].mean() for i in range(len(bf))])
    beat_onset = np.array([onset_env[edges[i]:max(edges[i] + 1, edges[i + 1])].mean() for i in range(len(bf))])
    beat_kick = kick

    # Bars. A partial bar before the first downbeat is kept as bar 0 if it exists.
    bar_starts = ([0] if phase > 0 else []) + downbeat_idx
    bars = []
    for k, b0 in enumerate(bar_starts):
        b1 = bar_starts[k + 1] if k + 1 < len(bar_starts) else len(beat_t)
        t0 = float(beat_t[b0]) if b0 > 0 else 0.0
        t1 = float(beat_t[b1]) if b1 < len(beat_t) else duration
        bars.append({"beat0": b0, "beat1": b1, "t0": round(t0, 3), "t1": round(t1, 3)})

    # Bar features for finding sections: timbre (MFCC), harmony (chroma) and loudness.
    mfcc = librosa.feature.mfcc(y=y, sr=SR, hop_length=HOP, n_mfcc=13)
    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP)
    bar_frames = [librosa.time_to_frames(b["t0"], sr=SR, hop_length=HOP) for b in bars] + [mfcc.shape[1]]
    feats = []
    for k in range(len(bars)):
        a, b = bar_frames[k], max(bar_frames[k] + 1, bar_frames[k + 1])
        feats.append(np.concatenate([mfcc[:, a:b].mean(1), 2 * chroma[:, a:b].mean(1),
                                     [rms_db[a:b].mean() / 5]]))
    F = np.array(feats)
    F = (F - F.mean(0)) / (F.std(0) + 1e-6)

    # Energy per bar, 0 to 1 within this song: loudness, busyness and kick together.
    bar_rms = np.array([beat_rms[b["beat0"]:b["beat1"]].mean() for b in bars])
    bar_onset = np.array([beat_onset[b["beat0"]:b["beat1"]].mean() for b in bars])
    bar_kick = np.array([beat_kick[b["beat0"]:b["beat1"]].mean() for b in bars])
    energy = 0.45 * norm01(bar_rms) + 0.35 * norm01(bar_onset) + 0.2 * norm01(bar_kick)
    for k, b in enumerate(bars):
        b["energy"] = round(float(energy[k]), 3)

    sections = find_sections(F, energy, bars, duration)

    beats_out = []
    for i, t in enumerate(beat_t):
        beats_out.append({"t": round(float(t), 3), "downbeat": i in set(downbeat_idx),
                          "accent": round(float(norm01(beat_onset)[i]), 3),
                          "guessed": i < n_front or i >= n_front + len(beats)})
    return {
        "song": str(Path(path).resolve()), "duration": round(duration, 3), "tempo": round(tempo, 2),
        "beats": beats_out, "bars": bars, "sections": sections,
    }


def find_sections(F, energy, bars, duration):
    """Split the song where its sound changes, and label sections that sound alike the same.

    Uses a self-similarity matrix of the bars and a checkerboard kernel: a boundary is where the
    bars before look like each other and unlike the bars after. Boundaries prefer every 4th bar,
    which is where pop and dance music change parts.
    """
    n = len(F)
    if n < 8:
        return [{"bar0": 0, "bar1": n, "t0": 0.0, "t1": duration, "label": "A",
                 "energy": round(float(energy.mean()), 3)}]
    U = F / (np.linalg.norm(F, axis=1, keepdims=True) + 1e-9)
    SSM = U @ U.T
    half = 4
    kern = np.ones((2 * half, 2 * half))
    kern[:half, half:] = -1
    kern[half:, :half] = -1
    pad = np.pad(SSM, half, mode="edge")
    nov = np.array([(pad[i:i + 2 * half, i:i + 2 * half] * kern).sum() for i in range(n)])
    nov = np.maximum(nov, 0)
    # Big jumps in energy (a drop, a breakdown) also mark boundaries.
    de = np.abs(np.diff(energy, prepend=energy[0]))
    score = nov / (nov.max() + 1e-9) + 0.8 * de
    # The song's first downbeat bar is index 0 or 1, depending on whether there is a pickup bar.
    first = 1 if bars[0]["t0"] == 0.0 and len(bars) > 1 and bars[0]["beat1"] - bars[0]["beat0"] < 4 else 0
    bonus = np.array([0.25 if (i - first) % 8 == 0 else 0.12 if (i - first) % 4 == 0 else 0.0 for i in range(n)])
    score = score + bonus
    cuts = [0]
    order = np.argsort(-score)
    thresh = score.mean() + 0.6 * score.std()
    for i in order:
        if score[i] < thresh:
            break
        if i < 4 or i > n - 4:
            continue
        if all(abs(i - c) >= 4 for c in cuts):
            cuts.append(int(i))
    cuts = sorted(cuts) + [n]

    secs = []
    for k in range(len(cuts) - 1):
        a, b = cuts[k], cuts[k + 1]
        secs.append({"bar0": a, "bar1": b, "t0": bars[a]["t0"], "t1": bars[b - 1]["t1"],
                     "mean": U[a:b].mean(0), "energy": round(float(energy[a:b].mean()), 3)})
    # Label: a section that sounds like an earlier one gets its label.
    labels = []
    for k, s in enumerate(secs):
        m = s["mean"] / (np.linalg.norm(s["mean"]) + 1e-9)
        best, best_sim = None, 0.0
        for j in range(k):
            o = secs[j]["mean"] / (np.linalg.norm(secs[j]["mean"]) + 1e-9)
            sim = float(m @ o)
            if sim > best_sim:
                best, best_sim = j, sim
        if best is not None and best_sim > 0.85:
            labels.append(labels[best])
        else:
            labels.append(chr(ord("A") + len(set(labels))))
    for s, lab in zip(secs, labels):
        s["label"] = lab
        del s["mean"]
    return secs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("song")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    data = analyse_song(a.song)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(data, indent=1))
    print(f"{data['duration']:.1f} s, {data['tempo']:.1f} bpm, {len(data['beats'])} beats, "
          f"{len(data['bars'])} bars, sections: "
          + ", ".join(f"{s['label']} {s['t0']:.1f}-{s['t1']:.1f}s (energy {s['energy']:.2f})" for s in data["sections"]))


if __name__ == "__main__":
    main()
