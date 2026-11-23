// Small shared helpers: DOM building, number formatting, the beat grid, custom range sliders.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Build an element. h("button.btn.primary", {title: "x", onclick: fn}, "Label", childEl) */
export function h(spec, attrs, ...kids) {
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  if (attrs != null && (attrs instanceof Node || typeof attrs !== "object" || Array.isArray(attrs))) {
    kids.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" };
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

/** Song time, 1:23.4 */
export function fmtTime(s, tenths = true) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest);
  const out = `${m}:${String(whole).padStart(2, "0")}`;
  return tenths ? `${out}.${Math.floor((rest - whole) * 10)}` : out;
}

/** Film timecode, 1:01:50.2 */
export function fmtFilm(s) {
  s = Math.max(0, s || 0);
  const hrs = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return `${hrs}:${String(m).padStart(2, "0")}:${sec}`;
}

export function fmtBeats(n) {
  if (n === 0.5) return "Half a beat";
  const txt = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `${txt} ${n === 1 ? "beat" : "beats"}`;
}

/**
 * The song's beat grid. Beat positions are floats, 2.5 is halfway between beat 2 and beat 3.
 * Same rule as tb() in engine/auto.py: a straight line between neighbouring beats, and the last
 * beat runs to the end of the song.
 */
export function makeBeatMap(song) {
  const bt = song.beats.map((b) => b.t);
  bt.push(song.duration);
  const last = bt.length - 2;
  const time = (x) => {
    const i = clamp(Math.floor(x), 0, last);
    return bt[i] + (bt[i + 1] - bt[i]) * (x - i);
  };
  const beat = (t) => {
    if (t <= bt[0]) return 0;
    let lo = 0, hi = last;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bt[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo + clamp((t - bt[lo]) / (bt[lo + 1] - bt[lo]), 0, 1);
  };
  const snapHalf = (t) => Math.round(beat(t) * 2) / 2;
  return { time, beat, snapHalf, count: bt.length - 1 };
}

/** Paints the filled part of a custom range slider. Call after setting .value in code. */
export function paintRange(el) {
  const min = +el.min || 0, max = +el.max || 100;
  const p = max > min ? ((+el.value - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--p", `${clamp(p, 0, 100)}%`);
}

export function range(attrs) {
  const { value, ...rest } = attrs;
  const el = h("input.range", { type: "range", ...rest });
  if (value != null) el.value = value;
  paintRange(el);
  el.addEventListener("input", () => paintRange(el));
  return el;
}

export const isTextField = (el) =>
  !!el && (el.tagName === "TEXTAREA" || el.isContentEditable ||
    (el.tagName === "INPUT" && !["range", "checkbox", "button"].includes(el.type)));

/** Absolute URL, so it can be used inside CSS custom properties without surprises. */
export const absUrl = (u) => new URL(u, location.href).href;
