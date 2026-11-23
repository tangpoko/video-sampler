"""Auto mode for Video Sampler: plans an edit of one film's clips to one song.

Writes edit.json, a list of segments (song time, which clip, where in the film, speed, effects).
The renderer turns that into a video. The hands-on timeline will open the same file later.

The rules, all controlled by sliders from 0 to 1:
  cut_speed   how many beats a cut lasts. Louder, busier bars cut faster.
  repetition  how often strong clips come back, and how much a repeated section reuses the
              clips from its first appearance, in the same order.
  effects     how often effects are applied. Louder sections get more.
  Each section label (A, B, C) gets its own look: a group of visually similar clips, and a
  signature effect. When the chorus comes back, so does its look.

Usage:
    python auto.py --library library/<film> --song songs/<song>.json --out edits/<name>.json [--seed 1]
"""
import argparse
import json
import math
import random
from pathlib import Path

import numpy as np

# How often each effect is chosen, relative to the others. Tang asked for more kaleidoscope,
# stutter and back-and-forth (10 Nov 2026), so those start high. --boost changes them per run.
# After the second render she ruled out two: the 12-wedge kaleidoscope (too busy, the film
# disappears into a pattern) and posterize (does not match the rest). Both are off at weight 0.
# She preferred the 4-way mirror and the plain mirror, where the film stays readable.
FX_WEIGHTS = {
    # picture effects
    "kaleidoscope": 3.5,   # 4-way mirror
    "kaleido6": 2.0, "kaleido8": 2.0, "kaleido12": 0.0,   # radial, 6, 8 or 12 wedges
    "mirror": 3.0, "flip": 1.0, "upside_down": 0.6,
    "hue": 1.2, "invert": 0.6, "rgb_split": 1.2, "posterize": 0.0, "vhs": 1.2,
    # time effects
    "stutter": 3.0,        # the first half beat repeated
    "stutter_fast": 2.0,   # the first quarter beat repeated
    "pingpong": 3.0,       # a beat played forward, then backward, over and over
    "reverse": 1.2,
}
TIME_FX = ["stutter", "stutter_fast", "pingpong", "reverse"]
GEO_FX = {"mirror", "kaleidoscope", "kaleido6", "kaleido8", "kaleido12", "flip", "upside_down"}
# Effects that look good held on screen for a whole section, used as section signatures.
SIGNATURES = ["mirror", "kaleidoscope", "kaleido6", "kaleido8", "kaleido12", "hue", "rgb_split",
              "vhs", "posterize", "flip"]


def weighted(names, rng, exclude=(), weights=None):
    """Pick one effect by its weight. weights is a per-edit copy of FX_WEIGHTS, when given."""
    weights = FX_WEIGHTS if weights is None else weights
    names = [n for n in names if n not in exclude and weights.get(n, 0) > 0]
    return rng.choices(names, [weights[n] for n in names])[0] if names else None

DEFAULTS = {"cut_speed": 0.5, "repetition": 0.35, "effects": 0.5,
            "colour": 0.30, "motion": 0.40, "strange": 0.30, "pool": 300, "looks": 6}


def kmeans(X, k, rng, iters=30):
    idx = rng.sample(range(len(X)), k)
    C = X[idx].copy()
    for _ in range(iters):
        lab = np.argmax(X @ C.T, axis=1)
        for j in range(k):
            m = X[lab == j]
            if len(m):
                c = m.mean(0)
                C[j] = c / (np.linalg.norm(c) + 1e-9)
    return np.argmax(X @ C.T, axis=1)


# Cut rhythms for one bar of 4 beats, as lists of beat counts. Mixing lengths inside a bar
# (a long shot answered by two quick ones) reads as rhythm. Equal cuts read as a metronome.
# [8] and [6, 2] run across two bars.
PATTERNS = {
    "slow": [[8], [4], [6, 2], [4], [3, 1], [2, 2], [4]],
    "mid": [[4], [2, 2], [3, 1], [2, 1, 1], [1, 1, 2], [3, 0.5, 0.5], [4]],
    "fast": [[2, 1, 1], [1, 1, 2], [1, 1, 1, 1], [2, 0.5, 0.5, 1], [3, 0.5, 0.5], [2, 2],
             [1, 0.5, 0.5, 2], [4]],
}


def bar_pattern(energy, cut_speed, rng, prev):
    """Pick the cut rhythm for the next bar. Louder bars and a higher cut speed slider give
    busier rhythms. Never the same rhythm twice in a row."""
    level = 0.6 * energy + 0.4 * cut_speed            # 0 = slowest, 1 = fastest
    pool = PATTERNS["slow"] if level < 0.45 else PATTERNS["mid"] if level < 0.62 else PATTERNS["fast"]
    options = [p for p in pool if p != prev] or pool
    return list(rng.choice(options))


def beat_time(song, x):
    """Song time at a beat position that may fall between beats (2.5 = halfway from beat 2 to 3).
    The video starts at 0 and ends with the song, even if the first beat is a little late."""
    beats = song["beats"]
    if x <= 0:
        return 0.0
    if x >= len(beats):
        return song["duration"]
    i = int(math.floor(x))
    a = beats[i]["t"]
    b = beats[i + 1]["t"] if i + 1 < len(beats) else song["duration"]
    return a + (b - a) * (x - i)


class Planner:
    """Everything auto mode knows about one film and one song: clip scores, the looks, which look
    and signature effect each section label gets. plan() uses it for a whole edit. The editor
    uses the same object to re-plan one cut, or the stretches between locked cuts, so a reroll
    follows exactly the rules of a full plan.

    The looks and signatures come from the seed. Building a Planner twice with the same seed and
    settings gives the same looks, which is how a single-cut reroll matches the rest of the edit.
    """

    def __init__(self, library_dir, song, settings, seed, lib=None, emb=None):
        settings = {**DEFAULTS, **settings}
        self.settings, self.song = settings, song
        self.rng = rng = random.Random(seed)
        # Per-edit effect odds (the editor's fx_weights setting). Without it, the tuned defaults.
        self.weights = {**FX_WEIGHTS, **(settings.get("fx_weights") or {})}
        if lib is None:
            lib = json.loads((Path(library_dir) / "analysis.json").read_text())
        if emb is None:
            emb = np.load(Path(library_dir) / "clip_embeddings.npy")
        emb = emb.astype(np.float32)
        # Copies, because the scores written below depend on the settings and the caller may
        # share one loaded library between several planners.
        self.clips = clips = [dict(c) for c in lib["clips"]]
        shots = lib["shots"]
        self.index = {c["id"]: i for i, c in enumerate(clips)}

        w = {k: settings[k] for k in ("colour", "motion", "strange")}
        tot = sum(w.values()) or 1
        for c in clips:
            c["s"] = c["quality"] * sum(w[k] * c[k] for k in w) / tot
            lo, hi = shots[c["shot"]]
            c["lo"], c["hi"] = lo + 0.1, hi - 0.1        # usable span of the clip's shot
        order = sorted(range(len(clips)), key=lambda i: -clips[i]["s"])
        self.pool = pool = order[: settings["pool"]]
        X = emb[pool]
        X /= np.linalg.norm(X, axis=1, keepdims=True) + 1e-9
        self.look_of = look_of = dict(zip(pool, kmeans(X, settings["looks"], rng)))

        # Give each section label a look. Louder labels get the looks with the most movement.
        labels = []
        for s in song["sections"]:
            if s["label"] not in labels:
                labels.append(s["label"])
        label_energy = {l: np.mean([s["energy"] for s in song["sections"] if s["label"] == l]) for l in labels}
        look_motion = {g: np.mean([clips[i]["motion"] for i in pool if look_of[i] == g] or [0])
                       for g in range(settings["looks"])}
        looks_by_motion = sorted(look_motion, key=lambda g: -look_motion[g])
        labels_by_energy = sorted(labels, key=lambda l: -label_energy[l])
        self.label_look = {l: looks_by_motion[k % len(looks_by_motion)] for k, l in enumerate(labels_by_energy)}
        # Signature effect per label. The label that fills the most of the song picks first, and only
        # from the highest-weighted effects, so the look Tang asked for most covers the most screen time.
        label_time = {l: sum(s["t1"] - s["t0"] for s in song["sections"] if s["label"] == l) for l in labels}
        top = max(self.weights[e] for e in SIGNATURES)
        self.label_sig = label_sig = {}
        for n, l in enumerate(sorted(labels, key=lambda l: -label_time[l])):
            names = [e for e in SIGNATURES if self.weights[e] >= top] if n == 0 else SIGNATURES
            label_sig[l] = weighted(names, rng, exclude=set(label_sig.values()), weights=self.weights) \
                or weighted(SIGNATURES, rng, weights=self.weights)

        self.bar_of_beat = {}
        for k, b in enumerate(song["bars"]):
            for i in range(b["beat0"], b["beat1"]):
                self.bar_of_beat[i] = k
        self.sec_start_beat = [song["bars"][s["bar0"]]["beat0"] for s in song["sections"]]
        self.copied = set()

    def section_beats(self, sec):
        """First beat of a section and the beat where the next one starts."""
        starts = self.sec_start_beat
        return starts[sec], starts[sec + 1] if sec + 1 < len(starts) else len(self.song["beats"])

    def grid(self, free=None):
        """The cut grid: where cuts fall, section by section, as segments without clips yet.

        A repeated section usually copies the cut rhythm of its first appearance, so its clips
        can be replayed in the same places.

        free is a list of (first beat, end beat) stretches to plan, used when the editor keeps
        locked cuts and re-plans only the stretches between them. None plans the whole song.
        A section that is only partly free gets fresh bar rhythms (it cannot copy an earlier
        section cut for cut), and a stretch that starts in the middle of a bar is first cut up
        to the next bar line so the bar rhythms after it sit on bars again.
        """
        song, settings, rng = self.song, self.settings, self.rng
        segments = []
        label_pattern = {}
        self.copied = set()
        for sec, s in enumerate(song["sections"]):
            b0, b1 = self.section_beats(sec)
            if free is None:
                spans = [(b0, b1)]
            else:
                spans = [(max(a, b0), min(b, b1)) for a, b in free if min(b, b1) - max(a, b0) > 1e-6]
            whole = len(spans) == 1 and spans[0][0] == b0 and spans[0][1] == b1
            copy = whole and s["label"] in label_pattern and rng.random() < min(1.0, settings["repetition"] * 2)
            if copy:
                self.copied.add(sec)
            for a, b in spans:
                pattern, i, k = [], float(a), 0
                queue, prev_pat = [], None
                while i < b - 1e-6:
                    if copy and k < len(label_pattern[s["label"]]):
                        n = label_pattern[s["label"]][k]
                    else:
                        if not queue:
                            bar = self.bar_of_beat.get(int(i), len(song["bars"]) - 1)
                            queue = bar_pattern(song["bars"][bar]["energy"], settings["cut_speed"], rng, prev_pat)
                            prev_pat = list(queue)
                        n = queue.pop(0)
                    n = min(n, b - i)
                    if not whole:
                        bar = song["bars"][self.bar_of_beat.get(int(i), len(song["bars"]) - 1)]
                        if i - bar["beat0"] > 1e-6:
                            n = min(n, bar["beat1"] - i)
                            if i + n >= bar["beat1"] - 1e-6:
                                queue = []                  # back on a bar line, start a fresh rhythm
                    segments.append({"t0": beat_time(song, i), "t1": beat_time(song, i + n),
                                     "section": sec, "beats": n, "beat0": i})
                    pattern.append(n)
                    i += n
                    k += 1
                if whole:
                    label_pattern.setdefault(s["label"], pattern)
        return segments

    @staticmethod
    def new_state():
        """What the planner remembers while it walks through the cuts in song order."""
        return {"used": {}, "recent": [], "first_take": {}, "prev": None, "pos": {}, "done": []}

    def fit(self, choice, dur, floor=None):
        """Where in the film a clip starts and how fast it plays so it fills a cut of dur seconds.
        Centred on the clip's best window, kept inside its shot. A shot shorter than the cut is
        slowed a little so it fills it, but never below floor (MIN_SPEED for auto mode)."""
        c = self.clips[choice]
        span = c["hi"] - c["lo"]
        speed = 1.0
        if span < dur:
            speed = max(MIN_SPEED if floor is None else floor, span / dur)
        need = dur * speed
        mid = (c["start"] + c["end"]) / 2
        src = min(max(mid - need / 2, c["lo"]), max(c["lo"], c["hi"] - need))
        return round(src, 3), round(speed, 3)

    def _is_first(self, seg):
        label = self.song["sections"][seg["section"]]["label"]
        return all(s["label"] != label for s in self.song["sections"][: seg["section"]])

    def _remember(self, seg, choice, state):
        k = state["pos"].get(seg["section"], 0)
        state["pos"][seg["section"]] = k + 1
        label = self.song["sections"][seg["section"]]["label"]
        if choice is not None:
            state["used"][choice] = state["used"].get(choice, 0) + 1
            state["recent"].append(choice)
            state["prev"] = self.clips[choice]
        state["done"].append(seg)
        if self._is_first(seg):
            state["first_take"].setdefault(label, []).append({"clip": choice, "t0": seg["t0"], "t1": seg["t1"]})

    def note(self, seg, state):
        """Record a cut that is already decided (a locked one) so the cuts planned after it see it
        as the previous clip, a used clip and part of its section's first appearance."""
        self._remember(seg, self.index.get(seg.get("clip")), state)

    def fill(self, seg, state, rng=None):
        """Choose the clip, start point, speed and effects for one cut, given what came before."""
        rng = rng or self.rng
        song, settings, clips = self.song, self.settings, self.clips
        used_count, recent, first_take = state["used"], state["recent"], state["first_take"]
        sec = song["sections"][seg["section"]]
        label = sec["label"]
        energy = sec["energy"]
        dur = seg["t1"] - seg["t0"]
        k = state["pos"].get(seg["section"], 0)

        choice = None
        # A repeated section replays its first appearance, clip for clip, part of the time.
        if seg["section"] in self.copied and label in first_take and k < len(first_take[label]) \
                and rng.random() < 0.75:
            ref = first_take[label][k]
            if ref["clip"] is not None and ref["clip"] not in recent[-2:] \
                    and abs((ref["t1"] - ref["t0"]) - dur) < 0.15 * dur:
                choice = ref["clip"]
                seg["callback"] = True
        # Otherwise sometimes bring back a favourite from earlier in the song.
        if choice is None and used_count and rng.random() < settings["repetition"] * 0.5:
            favs = sorted(used_count, key=lambda c: -clips[c]["s"])[:8]
            favs = [c for c in favs if c not in recent[-4:] and clips[c]["hi"] - clips[c]["lo"] >= dur * MIN_SPEED]
            if favs:
                choice = rng.choice(favs)
                seg["repeat"] = True
        if choice is None:
            choice = pick_new(clips, self.pool, self.look_of, self.label_look[label], energy, dur,
                              state["prev"], used_count, recent, rng)

        c = clips[choice]
        src, speed = self.fit(choice, dur)

        fx = pick_effects(seg, energy, self.label_sig[label], settings["effects"], dur, song, rng, self.weights)
        if seg.get("repeat") or seg.get("callback"):
            # A repeated clip should look different from last time.
            last = next((s["effects"] for s in reversed(state["done"]) if s.get("clip") == c["id"]), [])
            if fx == last:
                fx = [weighted(SIGNATURES, rng, exclude=last, weights=self.weights)]

        seg.update({"clip": c["id"], "src": src, "speed": speed,
                    "effects": fx, "look": int(self.look_of.get(choice, -1)), "label": label})
        self._remember(seg, choice, state)
        return seg


def plan(library_dir, song, settings, seed):
    p = Planner(library_dir, song, settings, seed)
    segments = p.grid()
    state = p.new_state()
    for seg in segments:
        p.fill(seg, state)
    return segments, {"label_look": p.label_look, "label_signature": p.label_sig}


# Tang found the second render had too many still shots. Two causes, both removed: calm sections
# were matched to calm clips, and short shots were slowed to half speed to fill long cuts.
# Now a clip must be in the more-moving 55% of the film, and is never slowed below 80% speed.
MIN_MOTION = 0.45
MIN_SPEED = 0.8


def pick_new(clips, pool, look_of, want_look, energy, dur, prev, used_count, recent, rng):
    cands, weights = [], []
    for i in pool:
        c = clips[i]
        if i in recent[-6:]:
            continue
        span = c["hi"] - c["lo"]
        if span < dur * MIN_SPEED:
            continue                                   # too short to fill this cut
        if c["motion"] < MIN_MOTION:
            continue                                   # a still shot
        wgt = c["s"] ** 3
        wgt *= 1.0 if look_of[i] == want_look else 0.25
        # Movement always counts, and counts more when the music is busy.
        wgt *= c["motion"] ** (1.5 + 2 * energy)
        if used_count.get(i):
            wgt *= 0.15
        if prev is not None:
            # Continuity: a similar colour or a camera moving the same way as the last clip.
            dh = abs(((c["hue"] - prev["hue"]) + 180) % 360 - 180)
            if c["hue_strength"] > 0.1 and prev["hue_strength"] > 0.1 and dh < 30:
                wgt *= 1.6
            pa, pb = prev["pan"], c["pan"]
            if pa[0] * pb[0] + pa[1] * pb[1] > 0 and math.hypot(*pb) > 0.05:
                wgt *= 1.3
            if c["shot"] == prev["shot"]:
                wgt *= 0.2
        cands.append(i)
        weights.append(wgt)
    if not cands:
        return rng.choice(pool)
    return rng.choices(cands, weights)[0]


def pick_effects(seg, energy, signature, amount, dur, song, rng, weights=None):
    weights = FX_WEIGHTS if weights is None else weights
    fx = []
    p = amount * (0.25 + 0.75 * energy)
    if rng.random() < p * 1.2:
        fx.append(signature)
    # A second picture effect, any of them.
    if rng.random() < p * 0.6:
        extra = weighted([e for e in FX_WEIGHTS if e not in TIME_FX], rng, exclude=fx, weights=weights)
        if extra:
            fx.append(extra)
    # Two geometry effects on top of each other mostly cancel out or look muddy.
    if len([e for e in fx if e in GEO_FX]) > 1:
        fx = [fx[0]] + [e for e in fx[1:] if e not in GEO_FX]
    # A time effect on top: stutter, ping-pong or reverse. More likely when the music is busy.
    if seg["beats"] >= 1 and rng.random() < amount * (0.25 + 0.6 * energy):
        t = weighted(TIME_FX, rng, weights=weights)
        if t:
            fx.append(t)
    return fx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--library", required=True)
    ap.add_argument("--song", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=1)
    for k, v in DEFAULTS.items():
        ap.add_argument("--" + k.replace("_", "-"), type=type(v), default=v)
    ap.add_argument("--boost", default="", help="change effect odds, e.g. kaleido8=3,vhs=0 (multipliers)")
    a = ap.parse_args()
    for item in filter(None, a.boost.split(",")):
        name, mult = item.split("=")
        if name not in FX_WEIGHTS:
            ap.error(f"unknown effect {name}. Known: {', '.join(FX_WEIGHTS)}")
        FX_WEIGHTS[name] *= float(mult)
    settings = {k: getattr(a, k) for k in DEFAULTS}
    settings["boost"] = a.boost
    library_dir = Path(a.library).resolve()
    song = json.loads(Path(a.song).read_text())
    segments, looks = plan(library_dir, song, settings, a.seed)
    lib = json.loads((library_dir / "analysis.json").read_text())
    edit = {
        "library": str(library_dir), "film": lib["film_path"], "song": song["song"],
        "duration": song["duration"], "tempo": song["tempo"], "seed": a.seed, "settings": settings,
        "sections": song["sections"], **looks, "segments": segments,
    }
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(edit, indent=1))
    n_fx = sum(1 for s in segments if s["effects"])
    n_rep = sum(1 for s in segments if s.get("repeat") or s.get("callback"))
    print(f"{len(segments)} cuts, {len({s['clip'] for s in segments})} different clips, "
          f"{n_rep} repeats, {n_fx} with effects. Section looks: {looks['label_signature']}")


if __name__ == "__main__":
    main()
