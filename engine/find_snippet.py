"""Find the liveliest stretch of a long recording (a DJ mix) and cut it out as a song.

"Lively" here means the stretch has contrast, not just volume: a quiet breakdown, a build and a
drop give auto mode something to react to. Each candidate stretch is scored on how far its
loudness swings, how many sudden jumps in loudness it has, and how busy it is.

The cut starts on a downbeat and ends on a bar line, with a short fade out.

Usage:
    python find_snippet.py <mix> --out songs/<name>.wav [--length 180]
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

FFMPEG = shutil.which("ffmpeg") or sys.exit("ffmpeg not found")
SR = 11025


def scan(path, length):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(SR),
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    y = np.frombuffer(raw, np.float32)
    hop = 5500                                        # half-second steps (divisible by 10)
    n = len(y) // hop
    frames = y[: n * hop].reshape(n, hop)
    rms_db = 20 * np.log10(np.sqrt((frames ** 2).mean(1)) + 1e-5)
    # Busyness: how much the loudness flickers inside each half second.
    fine = y[: n * hop].reshape(n, 10, hop // 10)
    fine_rms = np.sqrt((fine ** 2).mean(2))
    busy = np.abs(np.diff(fine_rms, axis=1)).mean(1) / (fine_rms.mean(1) + 1e-4)
    smooth = np.convolve(rms_db, np.ones(8) / 8, mode="same")     # 4-second average
    jump = np.maximum(0, smooth[8:] - smooth[:-8])                # rise over 4 seconds, in dB
    jump = np.concatenate([np.zeros(8), jump])

    win = int(length * 2)
    best, rows = None, []
    for s in range(0, n - win, 10):                               # step 5 seconds
        seg = smooth[s:s + win]
        if np.percentile(seg, 50) < np.percentile(smooth, 30):
            continue                                              # mostly quiet stretch
        swing = min(18.0, np.percentile(seg, 95) - np.percentile(seg, 5))
        drops = int((jump[s:s + win] > 5).sum() > 0) + int(np.sum(np.diff((jump[s:s + win] > 5).astype(int)) == 1))
        busyness = busy[s:s + win].mean()
        score = swing / 18 + 0.25 * min(drops, 4) + 1.5 * busyness
        rows.append((score, s / 2, swing, drops, busyness))
        if best is None or score > best[0]:
            best = rows[-1]
    rows.sort(reverse=True)
    return best, rows, len(y) / SR


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mix")
    ap.add_argument("--out", required=True)
    ap.add_argument("--length", type=float, default=180)
    ap.add_argument("--start", type=float, help="skip the scan and cut from this second")
    a = ap.parse_args()

    if a.start is None:
        best, rows, dur = scan(a.mix, a.length)
        print(f"mix is {dur / 60:.1f} min. Best stretches (start, loudness swing dB, drops, busyness):")
        shown = []
        for sc, s, swing, drops, b in rows:
            if all(abs(s - t) > a.length / 2 for t in shown):
                shown.append(s)
                print(f"  {int(s // 60)}:{int(s % 60):02d}  score {sc:.2f}  swing {swing:.1f}  drops {drops}  busy {b:.2f}")
            if len(shown) >= 5:
                break
        start = best[1]
    else:
        start = a.start

    # Cut a rough piece with 8 seconds of slack either side, find its bars, then trim to them.
    import song as songmod
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    rough = out.with_suffix(".rough.wav")
    r0 = max(0, start - 8)
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", f"{r0:.2f}", "-t", f"{a.length + 16:.2f}", "-i", str(a.mix),
                    "-vn", "-ac", "2", "-ar", "44100", str(rough)], check=True)
    info = songmod.analyse_song(rough)
    downs = [b["t"] for b in info["beats"] if b["downbeat"]]
    want0 = start - r0
    t0 = min(downs, key=lambda t: abs(t - want0))
    t1 = min(downs, key=lambda t: abs(t - (t0 + a.length)))
    # 30 ms before the downbeat so the first kick is not clipped.
    t0 = max(0, t0 - 0.03)
    d = t1 - t0
    subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", f"{t0:.3f}", "-t", f"{d:.3f}", "-i", str(rough),
                    "-af", f"afade=t=in:d=0.02,afade=t=out:st={d - 1.5:.3f}:d=1.5", str(out)], check=True)
    rough.unlink()
    m0 = r0 + t0
    print(f"cut {d:.1f} s starting at {int(m0 // 60)}:{m0 % 60:04.1f} of the mix -> {out}")


if __name__ == "__main__":
    main()
