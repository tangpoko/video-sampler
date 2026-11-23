// Live player: two decks, A and B, play at the same time. Each deck has its own video, its own
// column of effects (A on the left, B on the right) and its own monitor under the picture. The
// mixer between the monitors lays one deck over the other with blend modes and brightness or
// colour cutouts. A separate music playlist's beats can drive some of the effects and the mix.

import { h, fmtFilm, range, paintRange, isTextField, clamp } from "../util.js";
import { toast } from "../toast.js";
import { LiveRenderer, BLENDS } from "./renderer.js";
import { BeatDetector } from "./beat.js";

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const stage = $("stage");
const overlay = $("overlay");
const root = $("live");

// ---- small icons -------------------------------------------------------------------------------

// Line icons for the controls, drawn in currentColor so they light up with their button.
const SVG = {
  play: '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 1.5l9 5.5-9 5.5z"/></svg>',
  pause: '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2h3v10H3zM8 2h3v10H8z"/></svg>',
  next: '<svg width="16" height="14" viewBox="0 0 18 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M2 2l9 6-9 6zM15 2v12"/></svg>',
  soundOn: '<svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 5h3l4-3v10l-4-3h-3z"/><path d="M11 4.5a3.5 3.5 0 0 1 0 5M13 2.5a6.5 6.5 0 0 1 0 9"/></svg>',
  soundOff: '<svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 5h3l4-3v10l-4-3h-3z"/><path d="M11 5l4 4M15 5l-4 4"/></svg>',
  load: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M7 2l5 6H2z"/><path d="M2 11.5h10"/></svg>',
  chev: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4.5L6 8l3.5-3.5"/></svg>',
  search: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.2"/><path d="M9.2 9.2L13 13"/></svg>',
  list: '<svg width="18" height="16" viewBox="0 0 18 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M2 3h10M2 8h10M2 13h6M15 10v5M13 13l2 2 2-2"/></svg>',
  cutouts: '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="4" cy="4" r="2.4"/><circle cx="4" cy="11" r="2.4"/><path d="M6 5.2L13.5 12M6 9.8L13.5 3"/></svg>',
  select: '<svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3l4 4 4-4"/></svg>',
};
const svgEl = (svg, cls = "ic") => h(`span.${cls}`, { "aria-hidden": "true", html: svg });

// Effect icons on a 24 by 24 grid: [lines, filled shape].
const circle = (x, y, r) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const ICONS = {
  mirror: ["M12 3v18M3 6l6 6-6 6zM21 6l-6 6 6 6z", ""],
  quad: ["M4 4h16v16H4zM12 4v16M4 12h16", ""],
  kaleido: [`${circle(12, 12, 9)}M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4`, ""],
  flip: ["M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3M12 4v4M12 16v4", ""],
  upside: ["M12 3v18M9 6l3-3 3 3M9 18l3 3 3-3M4 12h4M16 12h4", ""],
  zoom: [`${circle(10, 10, 6)}M14.5 14.5L20 20M7.5 10h5M10 7.5v5`, ""],
  hue: ["M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4", ""],
  invert: [circle(12, 12, 9), "M12 3a9 9 0 0 1 0 18z"],
  rgb: [circle(9, 9, 5) + circle(15, 9, 5) + circle(12, 15, 5), ""],
  vhs: [`M3 6h18v12H3z${circle(8, 12, 2)}${circle(16, 12, 2)}M10 12h4`, ""],
  trails: [`${circle(15, 12, 5)}M8 8a5 5 0 0 0 0 8M4 9.5a4 4 0 0 0 0 5`, ""],
  stutter: ["M5 5v14M9 5v14M13 5v14M17 8v8M20 10v4", ""],
  bounce: ["M4 9h15l-3-3M20 15H5l3 3", ""],
  reverse: ["M21 6v12l-8-6zM12 6v12l-8-6z", ""],
  pulse: [circle(12, 12, 3) + circle(12, 12, 8), ""],
  flash: ["M13 2L5 14h6l-1 8 8-12h-6z", ""],
  jump: ["M3 20h4v-4h4v-4h4v-4h4V4h2", ""],
  swap: [`M4 4h7v7H4z${circle(17, 16.5, 3.5)}M14 6h4v3M10 18H6v-3`, ""],
  lock: ["M8 21h8L13 3h-2zM12 15l5-9", ""],
};
function effectIcon(id) {
  const [line, fill] = ICONS[id] || ["", ""];
  return svgEl(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${line}"/>${fill ? `<path class="pf" d="${fill}"/>` : ""}</svg>`, "pic");
}

// ---- effects -------------------------------------------------------------------------------------

// Two layers. The renderer reads "fx": one entry per thing the shader can do (mirror, quad,
// kaleido, ...), each { on, ...settings }. The columns show "entries": a single effect, or a
// family such as Kaleidoscope whose variants (2, 4, 8, 12 wedges) each turn on some fx with some
// values. Only one variant of a family is on at a time.
//
// kind: "toggle" stays on until pressed again. "hold" (time effects) is on while the key or
// button is held, and Shift locks it on.

const fmtX2 = (v) => `${(+v).toFixed(2)}x`;
const fmtX1 = (v) => `${(+v).toFixed(1)}x`;
const fmtPct = (v) => `${Math.round(v * 100)}%`;
const fmtMs = (v) => `${v} ms`;
const fmtDeg = (v) => `${v}°`;

/** A variant: its name, the short tag shown on the row, the fx it turns on, and values it sets. */
const V = (name, tag, fx, set = {}) => ({ name, tag, fx, set });
/** A slider. It edits fx[fx][id]. "only" lists the variants it applies to; null means all. */
const S = (fx, id, label, min, max, step, value, fmt, only = null) => ({ fx, id, label, min, max, step, value, fmt, only });

const GROUPS = [
  { title: "Shape", items: [
    { id: "mirror", name: "Mirror", variants: [
      V("Left to right", "L-R", ["mirror"]), V("Top to bottom", "T-B", ["mirrorV"]), V("4-way", "4-way", ["quad"])] },
    { id: "kaleido", name: "Kaleidoscope", def: 2,
      variants: [2, 4, 8, 12].map((n) => V(`${n} wedges`, String(n), ["kaleido"], { kaleido: { wedges: n } })),
      sliders: [S("kaleido", "spin", "Spin", -1, 1, 0.05, 0, (v) => (+v).toFixed(2))] },
    { id: "flip", name: "Flip", variants: [
      V("Sideways", "Side", ["flip"]), V("Upside down", "Down", ["upside"]), V("Both ways", "Both", ["flip", "upside"])] },
    { id: "zoom", name: "Zoom", variants: [
      V("In", "In", ["zoom"]), V("Out", "Out", ["zoomOut"]), V("Pulse on beat", "Pulse", ["pulse"])],
      sliders: [
        S("zoom", "amount", "Amount", 1.05, 2.5, 0.05, 1.3, fmtX2, [0, 1]),
        S("pulse", "amount", "Pulse size", 0.1, 1, 0.05, 0.5, fmtPct, [2])] },
    { id: "fisheye", name: "Fisheye", variants: [
      V("Bulge", "Bulge", ["fisheye"]), V("Pinch", "Pinch", ["pinch"]), V("Pulse on beat", "Pulse", ["fishPulse"])],
      sliders: [S("fisheye", "amount", "Amount", 0.1, 1, 0.05, 0.5, fmtPct)] },
    { id: "ripple", name: "Ripple", variants: [V("Steady", "Steady", ["ripple"]), V("On the beat", "Beat", ["rippleHit"])],
      sliders: [
        S("ripple", "amount", "Amount", 0.1, 1, 0.05, 0.4, fmtPct),
        S("ripple", "size", "Wave size", 0.1, 1, 0.05, 0.5, fmtPct)] },
  ] },
  { title: "Colour", items: [
    { id: "hue", name: "Hue", variants: [
      V("Cycle", "Cycle", ["hue"]), V("Shift", "Shift", ["hueShift"]), V("Jump on beat", "Jump", ["jump"])],
      sliders: [
        S("hue", "speed", "Speed", 10, 360, 10, 90, (v) => `${v}°/s`, [0]),
        S("hueShift", "angle", "Angle", 15, 345, 15, 180, fmtDeg, [1]),
        S("jump", "step", "Step", 30, 180, 15, 90, fmtDeg, [2])] },
    { id: "invert", name: "Invert", variants: [V("Steady", "Steady", ["invert"]), V("Hit on beat", "Hit", ["invHit"])] },
    { id: "rgb", name: "RGB split", variants: [V("Steady", "Steady", ["rgb"]), V("Hit on beat", "Hit", ["rgbHit"])],
      sliders: [S("rgb", "amount", "Amount", 0.2, 4, 0.1, 1, fmtX1)] },
    { id: "vhs", name: "VHS", sliders: [S("vhs", "amount", "Amount", 0.1, 1, 0.05, 0.7, fmtPct)] },
    { id: "trails", name: "Trails", sliders: [
      S("trails", "length", "Length", 0.1, 0.95, 0.05, 0.6, fmtPct),
      S("trails", "drift", "Drift", 0, 1, 0.05, 0.3, fmtPct)] },
    { id: "poster", name: "Posterize", sliders: [S("poster", "levels", "Levels", 2, 8, 1, 4, (v) => String(v))] },
    { id: "halation", name: "Halation", sliders: [
      S("halation", "amount", "Glow", 0.1, 1, 0.05, 0.6, fmtPct),
      S("halation", "threshold", "Threshold", 0.3, 0.9, 0.05, 0.6, fmtPct)] },
    { id: "neon", name: "Neon boost", sliders: [S("neon", "amount", "Amount", 0.1, 1, 0.05, 0.6, fmtPct)] },
  ] },
  { title: "Time", note: "Hold. Shift locks", items: [
    { id: "stutter", name: "Stutter", kind: "hold", sliders: [S("stutter", "ms", "Loop", 40, 1000, 10, 250, fmtMs)] },
    { id: "bounce", name: "Back and forth", kind: "hold", sliders: [S("bounce", "ms", "Loop", 100, 1500, 10, 500, fmtMs)] },
    { id: "reverse", name: "Reverse", kind: "hold" },
  ] },
  { title: "Beat", note: "Follows the music", items: [
    { id: "flash", name: "Flash", variants: [V("White", "White", ["flash"]), V("Blackout", "Black", ["blackout"])],
      sliders: [S("flash", "amount", "Amount", 0.1, 1, 0.05, 0.4, fmtPct)] },
    { id: "swap", name: "Shape swap", sliders: [S("swap", "every", "Every", 1, 8, 1, 2, (v) => (+v === 1 ? "beat" : `${v} beats`))] },
    { id: "lock", name: "Time effects on tempo" },
  ] },
];

// A single effect is an entry with one variant, which turns on the fx of the same name.
const ENTRIES = GROUPS.flatMap((g) => g.items);
for (const e of ENTRIES) {
  e.variants ||= [V(e.name, "", [e.id])];
  e.fam = e.variants.length > 1;
  e.def ||= 0;
  e.sliders ||= [];
  e.kind ||= "toggle";
}
const BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));
const FX_IDS = [...new Set(ENTRIES.flatMap((e) => e.variants.flatMap((v) => v.fx)))];
const SLIDERS = ENTRIES.flatMap((e) => e.sliders);
const TIME_IDS = ["stutter", "bounce", "reverse"];
const VARIANT_COUNT = ENTRIES.reduce((n, e) => n + e.variants.length, 0);

// Each deck has its own keys, four rows of the keyboard each: A on the left hand, B on the right.
// The entries take them in list order, so the first is 1 on A and 6 on B. A family's key turns
// on its chosen variant.
const KEY_LABELS = [
  ["1", "2", "3", "4", "5", "Q", "W", "E", "R", "T", "A", "S", "D", "F", "G", "Z", "X", "C", "V", "B"],
  ["6", "7", "8", "9", "0", "Y", "U", "I", "O", "P", "H", "J", "K", "L", ";", "N", "M", ",", ".", "/"],
];
// Keys are matched by their place on the keyboard (event.code), so Shift does not change them.
const CODE_NAMES = { ";": "Semicolon", ",": "Comma", ".": "Period", "/": "Slash" };
const keyCode = (label) => CODE_NAMES[label] || (/\d/.test(label) ? `Digit${label}` : `Key${label}`);
// Effects added later go to the end of the key order, so the keys people have learned stay put.
const KEY_ORDER = ["mirror", "kaleido", "flip", "zoom", "hue", "invert", "rgb", "vhs", "trails", "stutter", "bounce", "reverse",
  "flash", "swap", "lock", "fisheye", "ripple", "poster", "halation", "neon"];
const keyLabel = (deck, id) => KEY_LABELS[deck][KEY_ORDER.indexOf(id)] || "";
const BY_CODE = new Map();   // event.code -> { deck: 0 or 1, e: the entry }
KEY_LABELS.forEach((labels, deck) => KEY_ORDER.forEach((id, i) => { if (labels[i] && BY_ID.get(id)) BY_CODE.set(keyCode(labels[i]), { deck, e: BY_ID.get(id) }); }));

/** Effect settings for one deck. Deck A keeps the storage key it had before there were two. */
function makeFx(saveKey) {
  const fx = {};
  for (const id of FX_IDS) fx[id] = { on: false };
  for (const s of SLIDERS) fx[s.fx][s.id] = s.value;
  fx.kaleido.wedges = 8;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(saveKey) || "{}") || {}; } catch { /* nothing saved, or storage is blocked */ }
  for (const s of SLIDERS) {
    const v = saved[s.fx]?.[s.id];
    if (typeof v === "number") fx[s.fx][s.id] = clamp(v, s.min, s.max);
  }
  return { fx, oldWedges: saved.kaleido?.wedges };
}

/** A favourite is "kaleido" (the whole entry) or "kaleido/1" (one variant). */
function favEntry(key) {
  const [id, vs] = key.split("/");
  const e = BY_ID.get(id);
  if (!e) return null;
  if (vs == null) return { e, vi: null };
  const vi = Number(vs);
  return e.fam && Number.isInteger(vi) && vi >= 0 && vi < e.variants.length ? { e, vi } : null;
}

/** Which variant each family uses, and the deck's favourites. Remembered between visits. */
function makeDeckUi(uiKey, oldWedges) {
  const out = { pick: {}, fav: [] };
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(uiKey) || "null"); } catch { /* storage blocked */ }
  if (saved && typeof saved === "object") {
    for (const [id, vi] of Object.entries(saved.pick || {})) {
      const e = BY_ID.get(id);
      if (e && Number.isInteger(vi) && vi >= 0 && vi < e.variants.length) out.pick[id] = vi;
    }
    out.fav = [...new Set((Array.isArray(saved.fav) ? saved.fav : []).filter((k) => typeof k === "string" && favEntry(k)))];
  } else if (typeof oldWedges === "number") {
    // Before families, the kaleidoscope had a Wedges slider. Start on the nearest wedge count.
    const counts = BY_ID.get("kaleido").variants.map((v) => v.set.kaleido.wedges);
    out.pick.kaleido = counts.reduce((best, n, i) => (Math.abs(n - oldWedges) < Math.abs(counts[best] - oldWedges) ? i : best), 0);
  }
  return out;
}

// The two decks. Each has its own video, effects, held time effects and on-screen controls.
const chans = ["A", "B"].map((name, i) => ({
  i, name,
  video: $(i ? "videoB" : "video"),
  saveKey: i ? "live-player-fx-v1-b" : "live-player-fx-v1",
  uiKey: i ? "live-player-deck-v1-b" : "live-player-deck-v1",
  fx: null,
  on: {},                // entry id -> the variant that is on, for entries that are not held
  pick: {},              // entry id -> the variant the entry turns on next (the last one used)
  fav: [],               // favourite keys, in the order they were starred
  open: new Set(),       // entries whose dropdown is open
  held: new Set(),       // time effects held by key or mouse right now
  latched: new Set(),    // time effects locked on with Shift
  lastTime: null,        // the newest held one wins when several are down
  title: "",             // the video's name, empty when the deck has none
  objectUrl: null,
  ui: {},                // this deck's effect rows and monitor controls, filled in below
}));
for (const c of chans) {
  const { fx, oldWedges } = makeFx(c.saveKey);
  c.fx = fx;
  Object.assign(c, makeDeckUi(c.uiKey, oldWedges));
  // Values a family's chosen variant sets (the wedge count) are in place even while it is off,
  // because Shape swap turns the kaleidoscope on by itself.
  for (const e of ENTRIES) if (e.fam) setValues(c, e.variants[pickOf(c, e)]);
}
chans[1].video.muted = true;   // two videos talking at once is noise. B's sound starts off.

function save(c) {
  const out = {};
  for (const [id, v] of Object.entries(c.fx)) { const { on, ...rest } = v; out[id] = rest; }
  try { localStorage.setItem(c.saveKey, JSON.stringify(out)); } catch { /* storage blocked */ }
}
function saveUi(c) {
  try { localStorage.setItem(c.uiKey, JSON.stringify({ pick: c.pick, fav: c.fav })); } catch { /* storage blocked */ }
}

/** The variant an entry shows: the one on now, else the last one used, else its default. */
function pickOf(c, e) { return c.on[e.id] ?? c.pick[e.id] ?? e.def; }
function setValues(c, v) { for (const [id, vals] of Object.entries(v.set)) Object.assign(c.fx[id], vals); }
function isOn(c, e) { return e.kind === "hold" ? !!c.fx[e.id].on : c.on[e.id] != null; }

let renderer;
try {
  renderer = new LiveRenderer(canvas, chans.map((c) => c.video));
  for (const c of chans) renderer.channels[c.i].params = c.fx;
} catch (e) {
  overlay.classList.remove("is-hidden");
  overlay.replaceChildren(h("div.picker.panel", h("h1", "The live effects cannot run here"), h("p.picker-lead", e.message)));
}
const rch = (c) => renderer?.channels[c.i];

// The beat lights and BPM readouts (top bar and mixer). The music code lights them every refresh.
const beatLights = [];
const bpmReadouts = [];

// ---- popovers ----------------------------------------------------------------------------------

// The playlist and the cutouts open as small panels next to their button. A click anywhere else,
// or Escape, closes them.
const pops = [];
function popover(btn, el, onOpen) {
  const p = {
    btn, el,
    isOpen: () => !el.classList.contains("is-hidden"),
    open() { closePops(); el.classList.remove("is-hidden"); btn.setAttribute("aria-expanded", "true"); btn.classList.add("open"); onOpen?.(); },
    close() { el.classList.add("is-hidden"); btn.setAttribute("aria-expanded", "false"); btn.classList.remove("open"); },
  };
  el.classList.add("is-hidden");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", () => (p.isOpen() ? p.close() : p.open()));
  pops.push(p);
  return p;
}
/** Close every open popover. Says whether one was open. */
function closePops() {
  let any = false;
  for (const p of pops) if (p.isOpen()) { p.close(); any = true; }
  return any;
}
// Caught before the click reaches anything, so picking a key colour from the picture can keep
// the cutouts open: the picture click ends the pick, which would otherwise count as "outside".
document.addEventListener("pointerdown", (e) => {
  if (picking != null) return;
  for (const p of pops) if (p.isOpen() && !p.el.contains(e.target) && !p.btn.contains(e.target)) p.close();
}, true);

// ---- shared controls ---------------------------------------------------------------------------

/** A row of buttons where one is chosen. options: [[value, label], ...] */
function seg(options, get, set, label) {
  const btns = options.map(([value, text]) => h("button.nchip.wide", { type: "button", onclick: () => { set(value); sync(); } }, text));
  const el = h("div.chips", { role: "group", "aria-label": label }, btns);
  const sync = () => btns.forEach((b, i) => b.setAttribute("aria-pressed", String(get() === options[i][0])));
  sync();
  el.sync = sync;
  return el;
}

/** A settings slider: label, slider and a green readout. Used under effects and in the cutouts. */
function setRow(label, attrs, fmt, onInput, cls = "") {
  const out = h("span.vfd.sv", fmt(attrs.value));
  const r = range({ ...attrs, "aria-label": label });
  r.classList.add("srng");
  r.addEventListener("input", () => { out.textContent = fmt(r.value); onInput(+r.value); });
  const el = h(`label.set${cls}`, h("span.sl", label), r, out);
  el.set = (v) => { r.value = v; paintRange(r); out.textContent = fmt(v); };
  return el;
}

/** A key with a light, for things that are on or off. */
function toggleKey(text, title, onclick) {
  const led = h("span.led");
  const btn = h("button.key.tog", { type: "button", title, "aria-pressed": "false", onclick }, led, h("span", text));
  btn.set = (on) => { btn.setAttribute("aria-pressed", String(on)); btn.classList.toggle("lit", on); led.classList.toggle("on", on); };
  return btn;
}

const pct = (v) => `${Math.round(v * 100)}%`;

// ---- mix -------------------------------------------------------------------------------------

const MIX_KEY = "live-player-mix-v1";
const BLEND_NAMES = { normal: "Normal", screen: "Screen", add: "Add", multiply: "Multiply", difference: "Difference", overlay: "Overlay", lighten: "Lighten", darken: "Darken" };

// x is the crossfader: 0 shows only A, 1 only B. The renderer wants "how much of the top layer
// shows", which applyMix() works out from x and which layer is on top.
const mix = {
  x: 0.5,
  blend: "normal",
  aOnTop: false,
  key: "off",
  keyBright: false,
  level: 0.3,
  colour: "#00ff00",
  tol: 0.12,
  soft: 0.1,
  beat: "off",          // "off", "cut" (jump the crossfader to the other side) or "swap" (swap the layers)
  every: 4,
};
const MIX_SAVED = ["x", "blend", "aOnTop", "key", "keyBright", "level", "colour", "tol", "soft", "beat", "every"];
try {
  const saved = JSON.parse(localStorage.getItem(MIX_KEY) || "{}");
  for (const k of MIX_SAVED) if (typeof saved[k] === typeof mix[k]) mix[k] = saved[k];
  if (!BLENDS.includes(mix.blend)) mix.blend = "normal";
  if (!["off", "brightness", "colour"].includes(mix.key)) mix.key = "off";
  if (!["off", "cut", "swap"].includes(mix.beat)) mix.beat = "off";
} catch { /* nothing saved */ }
let beatFlip = false;
// Single deck mode: one video and one column of effects, no deck B and no mixer.
const SINGLE_KEY = "live-player-single-v1";
let single = false;
try { single = localStorage.getItem(SINGLE_KEY) === "1"; } catch { /* storage blocked */ }     // flipped by "on the beat"
let showMatte = false;    // show the cutout as black and white, for setting the key up

function saveMix() {
  const out = {};
  for (const k of MIX_SAVED) out[k] = mix[k];
  try { localStorage.setItem(MIX_KEY, JSON.stringify(out)); } catch { /* storage blocked */ }
}

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const rgbToHex = (rgb) => `#${rgb.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`;

/** Copy the mix settings into the renderer. Runs every refresh, because the beat changes them. */
function applyMix() {
  if (!renderer) return;
  const m = renderer.mix;
  const x = beatFlip && mix.beat === "cut" ? 1 - mix.x : mix.x;
  m.aOnTop = mix.aOnTop;
  m.swapped = beatFlip && mix.beat === "swap";
  m.fade = renderer.topIndex() === 1 ? x : 1 - x;
  m.blend = mix.blend;
  m.key = mix.key;
  m.keyBright = mix.keyBright;
  m.level = mix.level;
  m.colour = hexToRgb(mix.colour);
  m.tol = mix.tol;
  m.soft = mix.soft;
  m.matte = showMatte;
  // Single deck: only A is shown, with nothing laid over it or cut out of it.
  if (single) {
    m.swapped = false;
    m.fade = renderer.topIndex() === 1 ? 0 : 1;
    m.blend = "normal";
    m.key = "off";
    m.matte = false;
  }
}

// The mixer, between the two deck monitors: tempo, blend, cutouts, beat cuts, which deck is on
// top, and the crossfader.
const mixUI = (() => {
  const el = $("mixer");

  // Tempo readout. The faint 888 behind the number is the unlit segments of a VFD display.
  const bpmNum = h("span.lt", "---");
  const light = h("span.beatled", { title: "Lights up on each beat it hears" });
  bpmReadouts.push(bpmNum);
  beatLights.push(light);
  const bpmBox = h("div.vfd.bpmbox",
    h("div.bpmnum", h("span.gs", { "aria-hidden": "true" }, "888"), bpmNum),
    h("div.bpmside", h("div.lrow", h("span.vlab", "TEMPO"), light), h("span.vlab", "BPM")));

  // Blend mode, as a green VFD select.
  const blendSel = h("select", { "aria-label": "Blend mode" },
    ...BLENDS.map((b) => h("option", { value: b, selected: b === mix.blend }, BLEND_NAMES[b])));
  blendSel.addEventListener("change", () => { mix.blend = blendSel.value; saveMix(); });
  const blend = h("label.vfdsel", h("span.print", "Blend"), blendSel, svgEl(SVG.select, "selchev"));

  // Cutouts open in a popover above the button.
  const cutBtn = h("button.key", { type: "button", "aria-haspopup": "dialog", title: "Cut holes in the top deck so the other shows through" },
    svgEl(SVG.cutouts), h("span", "Cutouts"));
  const keySeg = seg([["off", "Off"], ["brightness", "Brightness"], ["colour", "Colour"]], () => mix.key, (v) => { mix.key = v; saveMix(); syncKey(); }, "Cutout");
  const darkSeg = seg([[false, "Cut dark"], [true, "Cut bright"]], () => mix.keyBright, (v) => { mix.keyBright = v; saveMix(); }, "Which parts are cut out");
  const level = setRow("Level", { min: 0, max: 1, step: 0.01, value: mix.level }, pct, (v) => { mix.level = v; saveMix(); }, ".flat");
  const swatch = h("input.swatch", { type: "color", value: mix.colour, "aria-label": "Colour to cut out", title: "Colour to cut out" });
  swatch.addEventListener("input", () => { mix.colour = swatch.value; saveMix(); });
  const pickBtn = h("button.key.small", { type: "button", onclick: () => startPick() }, "Pick from picture");
  const tol = setRow("Tolerance", { min: 0.01, max: 0.5, step: 0.01, value: mix.tol }, pct, (v) => { mix.tol = v; saveMix(); }, ".flat");
  const soft = setRow("Soft edge", { min: 0, max: 0.4, step: 0.01, value: mix.soft }, pct, (v) => { mix.soft = v; saveMix(); }, ".flat");
  const matteBtn = toggleKey("Show cutout", "Shows what is kept as white and what is cut out as black", () => { showMatte = !showMatte; matteBtn.set(showMatte); });
  matteBtn.classList.add("small");
  const keyNote = h("p.pop-note");
  const brightBox = h("div.pop-sub", darkSeg, level);
  const colourBox = h("div.pop-sub", h("div.mrow", swatch, pickBtn), tol);
  const keyBox = h("div.pop-sub", brightBox, colourBox, soft, h("div.mrow", matteBtn));
  const cutPop = h("div.pop.cut-pop", { role: "dialog", "aria-label": "Cutouts" },
    h("div.mhead", h("span.gt", "Cutouts"), h("span.rule")),
    keyNote, keySeg, keyBox);
  popover(cutBtn, cutPop);

  function syncKeyNote() {
    const top = mix.aOnTop ? "A" : "B", bottom = mix.aOnTop ? "B" : "A";
    keyNote.textContent = `Cuts holes in ${top}, so ${bottom} shows through.`;
  }
  function syncKey() {
    keyBox.classList.toggle("is-hidden", mix.key === "off");
    brightBox.classList.toggle("is-hidden", mix.key !== "brightness");
    colourBox.classList.toggle("is-hidden", mix.key !== "colour");
    cutBtn.classList.toggle("lit", mix.key !== "off");
    if (mix.key === "off" && showMatte) { showMatte = false; matteBtn.set(false); }
    syncKeyNote();
  }
  syncKey();

  // On the beat: cut between A and B, or swap which one is on top, every N beats. Only one of
  // the two can be on, so turning one on turns the other off.
  const setBeat = (v) => { mix.beat = mix.beat === v ? "off" : v; beatFlip = false; saveMix(); syncBeat(); };
  const cutTog = toggleKey("Cut every", "Jump the crossfader to the other deck every few beats", () => setBeat("cut"));
  const swapTog = toggleKey("Swap top layer on beat", "Swap which deck is on top every few beats, using the same count as Cut every", () => setBeat("swap"));
  const EVERY = [1, 2, 4, 8];
  // The old mixer had a 1 to 16 slider, so a saved count may not be one of the chips. Use the
  // nearest chip, so one of them is always lit.
  if (!EVERY.includes(mix.every)) mix.every = EVERY.reduce((a, b) => (Math.abs(b - mix.every) < Math.abs(a - mix.every) ? b : a));
  const chips = EVERY.map((n) => h("button.nchip", { type: "button", onclick: () => { mix.every = n; saveMix(); syncBeat(); } }, String(n)));
  function syncBeat() {
    cutTog.set(mix.beat === "cut");
    swapTog.set(mix.beat === "swap");
    chips.forEach((b, i) => b.setAttribute("aria-pressed", String(mix.every === EVERY[i])));
  }
  syncBeat();

  // Which deck is on top. It shows the live answer, so it flips with "Swap top layer on beat".
  const topBtn = h("button.toplab", { type: "button", title: "Put the other deck on top" }, "B on top");
  topBtn.addEventListener("click", () => { mix.aOnTop = !mix.aOnTop; saveMix(); syncKeyNote(); });

  // The crossfader. Double-click centres it.
  const xfade = range({ min: 0, max: 1, step: 0.01, value: mix.x, "aria-label": "Crossfader, A on the left, B on the right" });
  xfade.className = "xfr";
  xfade.title = "Double-click to centre";
  xfade.addEventListener("input", () => { mix.x = +xfade.value; saveMix(); });
  xfade.addEventListener("dblclick", () => { mix.x = 0.5; xfade.value = 0.5; saveMix(); });

  el.append(
    bpmBox,
    h("div.mrow", blend, h("div.popwrap", cutBtn, cutPop)),
    h("div.mrow", cutTog, h("div.chips", { role: "group", "aria-label": "Every how many beats" }, chips), h("span.print", "beats")),
    h("div.mrow", swapTog, h("span.grow"), topBtn),
    h("div.xf", h("span.ab", "A"), h("div.slot", xfade), h("span.ab", "B")));

  return {
    /** Show mix settings that were changed from outside the mixer (a vibe). */
    sync() { blendSel.value = mix.blend; xfade.value = String(mix.x); syncBeat(); },
    setKey(v) { mix.key = v; saveMix(); keySeg.sync(); syncKey(); },
    setColour(hex) { mix.colour = hex; swatch.value = hex; saveMix(); },
    /** Every refresh: the deck that is on top right now. */
    frame() {
      if (!renderer) return;
      const text = `${chans[renderer.topIndex()].name} on top`;
      if (topBtn.textContent !== text) topBtn.textContent = text;
    },
  };
})();

// Pick the key colour by clicking the picture. The colour comes from the top layer with its
// effects on, because that is the picture the key cuts.
let picking = null;   // the deck being picked from, fixed at the start so "swap" cannot change it
function startPick() {
  if (!renderer) return;
  const top = renderer.topIndex();
  if (!chans[top].title) return toast(`Deck ${chans[top].name} has no video yet, so there is nothing to pick from.`, "info");
  picking = top;
  stage.classList.add("is-picking");
  toast(`Click the colour in ${chans[top].name} that should be cut out. Esc cancels.`, "info");
}
function endPick() { picking = null; stage.classList.remove("is-picking"); }
canvas.addEventListener("pointerdown", (e) => {
  if (picking == null) return;
  e.preventDefault();
  // Read from that deck's own picture, before the mix, so earlier cutouts do not change it.
  const rgb = renderer.colourAt(picking, e.clientX, e.clientY);
  if (!rgb) return toast("That is outside the picture. Click on the video.", "info");
  mixUI.setColour(rgbToHex(rgb));
  if (mix.key !== "colour") mixUI.setKey("colour");
  endPick();
});

// ---- time effects (held) ---------------------------------------------------------------------

function timeLen(c, id) {
  const beat = music.beat.beatSeconds();
  const rate = c.video.playbackRate || 1;
  if (c.fx.lock.on && beat) return (id === "bounce" ? beat : beat / 2) * rate;
  return ((c.fx[id].ms || 250) / 1000) * rate;
}

function syncTime(c) {
  const active = [...c.held, ...c.latched];
  if (!active.includes(c.lastTime)) c.lastTime = active[active.length - 1] || null;
  for (const id of TIME_IDS) c.fx[id].on = active.includes(id);
  const r = rch(c);
  if (r) {
    if (c.lastTime) r.holdTime(c.lastTime, timeLen(c, c.lastTime));
    else if (r.timeMode) r.releaseTime();
  }
  refreshFx(c);
}

function press(c, id) { c.held.add(id); c.lastTime = id; syncTime(c); }
function release(c, id) { c.held.delete(id); syncTime(c); }
function toggleLatch(c, id) {
  if (c.latched.has(id)) c.latched.delete(id); else { c.latched.add(id); c.lastTime = id; }
  syncTime(c);
}

// Time effects held with the mouse: pointer -> { deck, effect }. Let go is caught on the window,
// because the pointer may have left the button by then.
const mouseHolds = new Map();
function mouseUp(e) {
  const m = mouseHolds.get(e.pointerId);
  if (!m) return;
  mouseHolds.delete(e.pointerId);
  if (m.c.held.has(m.id)) release(m.c, m.id);
}
window.addEventListener("pointerup", mouseUp);
window.addEventListener("pointercancel", mouseUp);

/** Make the fx match which variant of an entry is on. */
function applyEntry(c, e) {
  for (const v of e.variants) for (const id of v.fx) c.fx[id].on = false;
  const vi = c.on[e.id];
  if (vi != null) {
    const v = e.variants[vi];
    setValues(c, v);
    for (const id of v.fx) c.fx[id].on = true;
  }
  const r = rch(c);
  if (r) {
    if (!c.fx.jump.on) r.extra.hueJump = 0;
    if (!c.fx.swap.on) r.extra.shape = null;
  }
}

/** Turn an entry on with its chosen variant, or off. Time effects lock on or off instead. */
function toggleEntry(c, e) {
  if (e.kind === "hold") return toggleLatch(c, e.id);
  if (c.on[e.id] != null) delete c.on[e.id];
  else c.on[e.id] = pickOf(c, e);
  applyEntry(c, e);
  refreshFx(c);
}

/** Turn one variant of a family on, or off if it is the one on. It becomes the family's choice. */
function pickVariant(c, e, vi) {
  if (c.on[e.id] === vi) delete c.on[e.id];
  else c.on[e.id] = vi;
  if (c.pick[e.id] !== vi) { c.pick[e.id] = vi; saveUi(c); }
  applyEntry(c, e);
  refreshFx(c);
}

/** Turn every effect on one deck off. */
function deckOff(c) {
  for (const v of Object.values(c.fx)) v.on = false;
  c.on = {};
  c.held.clear();
  c.latched.clear();
  c.lastTime = null;
  const r = rch(c);
  if (r) {
    Object.assign(r.extra, { zoomPulse: 0, flash: 0, black: 0, invHit: 0, rgbHit: 0, hueJump: 0, fishHit: 0, rippleHit: 0, shape: null });
    if (r.timeMode) r.releaseTime();
  }
  refreshFx(c);
}

function allOff() {
  for (const c of chans) deckOff(c);
  setVibe(null);
}

// ---- effect columns ------------------------------------------------------------------------------

const STAR = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l1.95 4 4.4.62-3.18 3.1.75 4.38L8 11.63l-3.92 2.07.75-4.38-3.18-3.1 4.4-.62z"/></svg>';
const favKey = (e, vi) => (vi == null ? e.id : `${e.id}/${vi}`);

/** Light up one deck's rows that are on, its stars, and its "n ON" count. */
function refreshFx(c) {
  const u = c.ui;
  if (!u.rows) return;
  for (const row of [...u.rows, ...u.favRows]) {
    const { e, vi } = row;
    const on = vi == null ? isOn(c, e) : c.on[e.id] === vi;
    row.el.classList.toggle("on", on);
    row.hit.setAttribute("aria-pressed", String(on));
    if (row.vt) row.vt.textContent = e.kind === "hold" && c.latched.has(e.id) ? "LOCK" : e.fam && vi == null ? e.variants[pickOf(c, e)].tag : "";
    const fav = c.fav.includes(row.key);
    row.star.classList.toggle("on", fav);
    row.star.setAttribute("aria-pressed", String(fav));
    row.star.title = `${fav ? "Remove" : "Add"} ${row.what} ${fav ? "from" : "to"} favourites`;
  }
  // Sliders that belong to one variant show only while that variant is the family's choice.
  for (const { e, set, s } of u.sliders) set.classList.toggle("is-off", !!s.only && !s.only.includes(pickOf(c, e)));
  let total = 0;
  for (const g of u.groups) {
    const n = g.entries.filter((e) => isOn(c, e)).length;
    total += n;
    g.count.textContent = n ? `${n} on` : "";
  }
  u.count.textContent = `${total} ON`;
  u.led.classList.toggle("on", total > 0);
  u.favCount.textContent = String(c.fav.length);
}

function toggleFav(c, key) {
  const u = c.ui;
  const i = c.fav.indexOf(key);
  if (i >= 0) c.fav.splice(i, 1); else c.fav.push(key);
  saveUi(c);
  // Removing a star from inside the favourites rebuilds them and drops the focused star. Give
  // the keyboard to the next favourite's star, or to this effect's star in the list.
  const at = u.favRows.findIndex((r) => r.star === document.activeElement);
  u.buildFavs();
  refreshFx(c);
  if (at >= 0) {
    const next = u.favRows[Math.min(at, u.favRows.length - 1)] || u.rows.find((r) => r.key === key);
    next?.star.focus();
  }
}

/** The button that turns an entry (vi null) or one variant on. Time effects are held. */
function hitButton(c, e, vi, label, children) {
  const hit = h("button.hit", {
    type: "button", "aria-pressed": "false", "aria-label": label,
    "aria-keyshortcuts": vi == null ? keyLabel(c.i, e.id) || null : null,
  }, children);
  if (e.kind === "hold") {
    const k = keyLabel(c.i, e.id);
    hit.title = `Hold to play${k ? ` (or hold ${k})` : ""}. Shift locks it on`;
    hit.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.shiftKey) return toggleLatch(c, e.id);
      mouseHolds.set(ev.pointerId, { c, id: e.id });
      press(c, e.id);
    });
    // A keyboard press on the focused button (Enter or Space) has nothing to hold, so it
    // locks the effect on or off instead. Mouse clicks have detail 1 or more and are skipped.
    hit.addEventListener("click", (ev) => { if (ev.detail === 0) toggleLatch(c, e.id); });
  } else if (vi == null) {
    const k = keyLabel(c.i, e.id);
    if (k) hit.title = `Press ${k}`;
    hit.addEventListener("click", () => toggleEntry(c, e));
  } else {
    hit.addEventListener("click", () => pickVariant(c, e, vi));
  }
  // Pointing at an effect shows it in the deck's monitor. The main picture does not change.
  hit.addEventListener("pointerenter", () => setHover(c, e, vi));
  hit.addEventListener("pointerleave", () => setHover(c, null));
  hit.addEventListener("focus", () => { if (hit.matches(":focus-visible")) setHover(c, e, vi); });
  hit.addEventListener("blur", () => { if (c.hover?.e === e && c.hover.vi === vi) setHover(c, null); });
  return hit;
}

function starButton(c, key, what) {
  const star = h("button.star", { type: "button", "aria-pressed": "false", "aria-label": `Favourite: ${what}`, html: STAR });
  star.addEventListener("click", () => toggleFav(c, key));
  return star;
}

/** A full-size row: an entry, or in the favourites a single starred variant. */
function entryRow(c, e, vi, inFav) {
  const v = vi == null ? null : e.variants[vi];
  const key = vi == null ? keyLabel(c.i, e.id) : "";
  const name = v ? `${e.name} ${v.tag === v.name ? v.name : v.name.toLowerCase()}` : e.name;
  const vt = vi == null && (e.fam || e.kind === "hold") ? h("span.vt") : null;
  const hit = hitButton(c, e, vi, `${name}, deck ${c.name}`, [effectIcon(e.id), h("span.nm", name), vt]);
  const what = v ? `${e.name}, ${v.name}` : e.name;
  const star = starButton(c, favKey(e, vi), what);
  let chev = h("span.chev.none");
  if (!inFav && (e.fam || e.sliders.length)) {
    chev = h("button.chev", { type: "button", "aria-expanded": "false",
      "aria-label": e.fam ? `Types and settings for ${e.name}` : `Settings for ${e.name}`, html: SVG.chev });
  }
  const el = h(`div.row${inFav ? ".fv" : ""}`, hit, chev, star, h(`span.ky${key ? "" : ".none"}`, key || ""));
  return { el, hit, vt, star, chev, e, vi, key: favKey(e, vi), what };
}

/** One deck's effects column: header, search box, favourites and the grouped list of effects. */
function buildColumn(c) {
  const col = $(c.i ? "colB" : "colA");
  const u = c.ui;
  u.rows = [];        // every row in the main list, entries and variants
  u.favRows = [];     // rows in the favourites, rebuilt when a star changes
  u.sliders = [];
  u.groups = [];
  u.count = h("span", "0 ON");
  u.led = h("span.led");
  u.favCount = h("span.gc");

  const head = h("div.chead",
    h("span.badge", c.name),
    h("span.ctitle", h("b", `DECK ${c.name}`), h("small", `${VARIANT_COUNT} EFFECTS`)),
    h("span.sp"),
    h("span.vfd.oncount", { title: `Effects on for deck ${c.name}` }, u.led, u.count));

  const find = h("input", { type: "text", placeholder: "Search", spellcheck: "false", autocomplete: "off", "aria-label": `Find an effect on deck ${c.name}` });
  const findBox = h("label.find", svgEl(SVG.search), find);

  // Favourites, pinned above the list.
  const favList = h("div.favlist");
  // The hint only shows when someone clicks the Favourites heading while it is empty.
  const favEmpty = h("p.fempty.is-hidden", "Star an effect to pin it here.");
  const favHead = h("div.ghead.fhead", { role: "button", tabindex: "0", "aria-label": `Deck ${c.name} favourites` },
    svgEl(STAR, "fstar"), h("span.gt", "Favourites"), h("span.rule"), u.favCount);
  const showHint = () => { if (!c.fav.length) favEmpty.classList.toggle("is-hidden"); };
  favHead.addEventListener("click", showHint);
  favHead.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); showHint(); } });
  const favs = h("div.favs", { role: "group", "aria-label": `Deck ${c.name} favourites` }, favHead, favEmpty, favList);
  u.buildFavs = () => {
    u.favRows = c.fav.map(favEntry).filter(Boolean).map(({ e, vi }) => entryRow(c, e, vi, true));
    favList.replaceChildren(...u.favRows.map((r) => r.el));
    if (u.favRows.length) favEmpty.classList.add("is-hidden");
  };
  u.buildFavs();

  const list = h("div.list", { role: "group", "aria-label": `Deck ${c.name} effects` });
  const noMatch = h("p.nomatch.is-hidden", "No effect has that name.");
  const items = [];   // per entry: its row, dropdown and variant rows, for the search

  for (const g of GROUPS) {
    const count = h("span.gc");
    const ghead = h("div.ghead", h("span.gt", g.title), g.note ? h("span.gn", g.note) : null, h("span.rule"), count);
    list.append(ghead);
    const group = { head: ghead, count, entries: g.items, items: [] };
    u.groups.push(group);

    for (const e of g.items) {
      const row = entryRow(c, e, null, false);
      u.rows.push(row);
      list.append(row.el);
      const item = { e, row, drop: null, subs: [] };

      // The dropdown under a family or an effect with settings: its variants, then its sliders.
      if (row.chev.tagName === "BUTTON") {
        const drop = h("div.drop.is-hidden");
        if (e.fam) e.variants.forEach((v, vi) => {
          const hit = hitButton(c, e, vi, `${e.name}, ${v.name}, deck ${c.name}`, [h("span.led"), h("span.nm", v.name)]);
          const star = starButton(c, favKey(e, vi), `${e.name}, ${v.name}`);
          const el = h("div.sub", hit, star);
          const sub = { el, hit, vt: null, star, e, vi, key: favKey(e, vi), what: `${e.name}, ${v.name}`, v };
          u.rows.push(sub);
          item.subs.push(sub);
          drop.append(el);
        });
        if (e.sliders.length) {
          const sets = h("div.sets", e.sliders.map((s) => {
            const set = setRow(s.label, { min: s.min, max: s.max, step: s.step, value: c.fx[s.fx][s.id] }, s.fmt, (val) => {
              c.fx[s.fx][s.id] = val;
              if (e.kind === "hold" && c.lastTime === e.id) syncTime(c);
              save(c);
            });
            set.querySelector("input").setAttribute("aria-label", `${e.name} ${s.label.toLowerCase()}, deck ${c.name}`);
            u.sliders.push({ e, set, s });
            return set;
          }));
          drop.append(sets);
        }
        row.chev.addEventListener("click", () => {
          if (c.open.has(e.id)) c.open.delete(e.id); else c.open.add(e.id);
          syncOpen(item);
        });
        list.append(drop);
        item.drop = drop;
      }
      items.push(item);
      group.items.push(item);
    }
  }
  list.append(noMatch);

  // A dropdown is open when its chevron opened it, or while a search matches only its variants.
  function syncOpen(item) {
    if (!item.drop) return;
    const open = c.open.has(item.e.id) || item.forced;
    item.drop.classList.toggle("is-hidden", !open);
    item.drop.classList.toggle("searching", !!item.forced);
    item.row.chev.classList.toggle("open", open);
    item.row.chev.setAttribute("aria-expanded", String(open));
  }

  // The search box matches effect names and variant names. A family whose own name does not
  // match but some of its variants do stays in the list, opened to just those variants.
  function filter() {
    const q = find.value.trim().toLowerCase();
    let shown = 0;
    for (const item of items) {
      const { e } = item;
      const nameHit = !q || e.name.toLowerCase().includes(q);
      const subHits = q && !nameHit ? item.subs.filter((s) => s.v.name.toLowerCase().includes(q)) : [];
      const match = nameHit || subHits.length > 0;
      item.row.el.classList.toggle("is-filtered", !match);
      item.forced = !nameHit && subHits.length > 0;
      for (const s of item.subs) s.el.classList.toggle("is-filtered", item.forced && !subHits.includes(s));
      if (item.drop) {
        if (!match) item.drop.classList.add("is-hidden");
        else syncOpen(item);
      }
      if (match) shown++;
    }
    for (const g of u.groups) g.head.classList.toggle("is-filtered", g.items.every((it) => it.row.el.classList.contains("is-filtered")));
    noMatch.classList.toggle("is-hidden", shown > 0);
  }
  find.addEventListener("input", filter);
  find.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    if (find.value) { find.value = ""; filter(); } else find.blur();
  });

  col.append(head, findBox, h("div.slotbox", favs, list));
  refreshFx(c);
}

// ---- music -----------------------------------------------------------------------------------

// The music strip in the top bar shows the track, its tempo and a beat light. Clicking it opens
// the playlist. Play and next sit beside it.
const music = (() => {
  const audio = new Audio();
  audio.preload = "auto";
  const beat = new BeatDetector(audio);
  const list = [];          // { name, url }
  let at = -1;

  const trk = h("span.trk", "No music");
  const bpm = h("span.bpm", "---");
  const light = h("span.beatled", { title: "Lights up on each beat it hears" });
  bpmReadouts.push(bpm);
  beatLights.push(light);
  const strip = h("button.strip.vfd", { type: "button", "aria-haspopup": "dialog", title: "Open the playlist" },
    svgEl(SVG.play), trk, h("span.sp"), h("span.vlab", "BPM"), bpm, light, svgEl(SVG.list));
  const playBtn = h("button.key.icon", { type: "button", disabled: true, title: "Play or pause the music", "aria-label": "Play the music", html: SVG.play });
  const nextBtn = h("button.key.icon", { type: "button", disabled: true, title: "Next track (=)", "aria-label": "Next track", html: SVG.next });

  // The playlist popover.
  const vol = range({ min: 0, max: 1, step: 0.01, value: 0.9, "aria-label": "Music volume" });
  vol.classList.add("srng");
  const addSel = h("select", { "aria-label": "Add an analysed song" }, h("option", { value: "" }, "Add a song"));
  const fileIn = h("input", { type: "file", accept: "audio/*", multiple: true, hidden: true });
  const filesBtn = h("button.key.small", { type: "button" }, "Add files");
  const listEl = h("ol.music-list");
  const pop = h("div.pop.music-pop", { role: "dialog", "aria-label": "Playlist" },
    h("div.mhead", h("span.gt", "Playlist"), h("span.rule")),
    listEl,
    h("label.set.flat", h("span.sl", "Volume"), vol),
    h("div.mrow", h("label.vfdsel.grow", addSel, svgEl(SVG.select, "selchev")), filesBtn, fileIn));
  popover(strip, pop);

  audio.volume = 0.9;
  vol.addEventListener("input", () => { audio.volume = +vol.value; });
  filesBtn.addEventListener("click", () => fileIn.click());
  fileIn.addEventListener("change", () => {
    for (const f of fileIn.files) add({ name: f.name.replace(/\.[^.]+$/, ""), url: URL.createObjectURL(f) });
    fileIn.value = "";
  });
  addSel.addEventListener("change", () => {
    const o = addSel.selectedOptions[0];
    if (o?.value) add({ name: o.textContent, url: o.value });
    addSel.value = "";
  });
  playBtn.addEventListener("click", () => togglePlay());
  nextBtn.addEventListener("click", () => next());
  audio.addEventListener("ended", () => next());
  audio.addEventListener("play", sync);
  audio.addEventListener("pause", sync);
  audio.addEventListener("error", () => { if (at >= 0) toast(`Could not play ${list[at].name}.`, "error"); });

  fetch("/api/songs").then((r) => (r.ok ? r.json() : [])).then((songs) => {
    for (const s of songs) addSel.append(h("option", { value: `/media/song/${encodeURIComponent(s.id)}` }, s.name || s.id));
  }).catch(() => {});

  function load(i) {
    at = i;
    audio.src = list[i].url;
    beat.reset();
  }
  function add(track) {
    list.push(track);
    if (at < 0) load(0);
    sync();
  }
  function play() {
    if (at < 0) return;
    beat.start();
    // The videos' own sound would fight the music, so it goes quiet. Each deck's sound button
    // brings it back.
    for (const c of chans) { c.video.muted = true; transportSync(c); }
    audio.play().catch((e) => toast(`Could not play the music: ${e.message}`, "error"));
  }
  function togglePlay() { if (audio.paused) play(); else audio.pause(); }
  function next() {
    if (!list.length) return;
    load((at + 1) % list.length);
    play();
  }
  function choose(i) { load(i); play(); }
  function remove(i) {
    const playing = i === at;
    const [gone] = list.splice(i, 1);
    if (!list.length) { at = -1; audio.pause(); audio.removeAttribute("src"); audio.load(); }
    else if (playing) load(Math.min(i, list.length - 1));
    else if (i < at) at--;
    if (gone.url.startsWith("blob:")) URL.revokeObjectURL(gone.url);
    sync();
  }
  function sync() {
    playBtn.disabled = nextBtn.disabled = at < 0;
    playBtn.innerHTML = audio.paused ? SVG.play : SVG.pause;
    playBtn.setAttribute("aria-label", audio.paused ? "Play the music" : "Pause the music");
    trk.textContent = at >= 0 ? list[at].name : "No music. Click to add songs";
    listEl.replaceChildren(...list.map((t, i) => h(`li.music-item${i === at ? ".is-current" : ""}`,
      h("button.music-pick", { type: "button", onclick: () => choose(i) }, t.name),
      h("button.music-x", { type: "button", title: "Remove", "aria-label": `Remove ${t.name}`, onclick: () => remove(i) }, "×"))));
  }

  // Beat reactions, for each deck's own beat effects, then the mix.
  const swapAt = [0, 0];
  const SHAPES = [null, "mirror", "quad", "kaleido"];
  beat.onBeat((n) => {
    if (!renderer) return;
    for (const c of chans) {
      const r = rch(c), fx = c.fx;
      if (fx.jump.on) r.extra.hueJump = (r.extra.hueJump + fx.jump.step) % 360;
      if (fx.swap.on && n % Math.max(1, fx.swap.every) === 0) {
        swapAt[c.i] = (swapAt[c.i] + 1) % SHAPES.length;
        r.extra.shape = SHAPES[swapAt[c.i]] || "none";
      }
      previewBeat(c, n);
    }
    if (mix.beat !== "off" && n % Math.max(1, mix.every) === 0) beatFlip = !beatFlip;
  });
  function frame(now) {
    beat.update(now);
    const lit = beat.envelope(now, 120) > 0;
    for (const l of beatLights) l.classList.toggle("is-lit", lit);
    const text = beat.bpm && !audio.paused ? String(Math.round(beat.bpm)) : "---";
    for (const b of bpmReadouts) if (b.textContent !== text) b.textContent = text;
    if (!renderer) return;
    const env = beat.envelope(now, 220);
    const flash = beat.envelope(now, 140);
    for (const c of chans) {
      const r = rch(c), fx = c.fx;
      r.extra.zoomPulse = fx.pulse.on ? env * fx.pulse.amount : 0;
      r.extra.flash = fx.flash.on ? flash * fx.flash.amount : 0;
      r.extra.black = fx.blackout.on ? flash * fx.flash.amount : 0;
      r.extra.invHit = fx.invHit.on ? flash : 0;
      r.extra.rgbHit = fx.rgbHit.on ? env : 0;
      r.extra.fishHit = fx.fishPulse.on ? env : 0;
      r.extra.rippleHit = fx.rippleHit.on ? env : 0;
      if (c.lastTime && fx.lock.on) r.holdTime(c.lastTime, timeLen(c, c.lastTime));
      previewFrame(c, env, flash);
    }
  }

  $("music").append(strip, pop, playBtn, nextBtn);
  sync();
  return { audio, beat, frame, next, play };
})();

// ---- auto vibes ----------------------------------------------------------------------------------

// A vibe fills both decks with a set of effects and sets the mixer to match. on: entry id ->
// variant index. set: slider values, which differ from the slider defaults. Sliders of the
// effects a vibe turns on start from their defaults, so an old tweak does not change the vibe.
const VIBES = [
  { id: "chill", name: "Chill", desc: "Soft mirrors, slow colour drift, long trails, few cuts.",
    a: { on: { mirror: 0, hue: 0, trails: 0 }, set: { hue: { speed: 20 }, trails: { length: 0.8, drift: 0.2 } } },
    b: { on: { mirror: 1, trails: 0 }, set: { trails: { length: 0.75, drift: 0.35 } } },
    mix: { blend: "screen", x: 0.35, beat: "cut", every: 8 } },
  { id: "rave", name: "Rave", desc: "Kaleidoscope, white flash, zoom pulse, cut every beat.",
    a: { on: { kaleido: 2, flash: 0, zoom: 2 }, set: { kaleido: { spin: 0.6 }, flash: { amount: 0.8 }, pulse: { amount: 0.65 } } },
    b: { on: { kaleido: 3, rgb: 1, flash: 0 }, set: { kaleido: { spin: -0.6 }, rgb: { amount: 2.2 }, flash: { amount: 0.6 } } },
    mix: { blend: "add", x: 0.55, beat: "cut", every: 1 } },
  { id: "dreamy", name: "Dreamy", desc: "Long trails, slow zoom, soft colour shift, no hard cuts.",
    a: { on: { trails: 0, zoom: 0, hue: 1 }, set: { trails: { length: 0.9, drift: 0.1 }, zoom: { amount: 1.15 }, hueShift: { angle: 30 } } },
    b: { on: { mirror: 0, trails: 0 }, set: { trails: { length: 0.85, drift: 0.15 } } },
    mix: { blend: "lighten", x: 0.4, beat: "off", every: 8 } },
  { id: "glitch", name: "Glitch", desc: "RGB split, VHS tape, invert hits, shape swaps.",
    a: { on: { rgb: 0, vhs: 0, invert: 1 }, set: { rgb: { amount: 2.6 }, vhs: { amount: 0.75 } } },
    b: { on: { rgb: 1, vhs: 0, swap: 0 }, set: { rgb: { amount: 3.2 }, vhs: { amount: 0.6 }, swap: { every: 2 } } },
    mix: { blend: "difference", x: 0.5, beat: "swap", every: 2 } },
  { id: "acid", name: "Acid", desc: "Spinning kaleidoscope, colour jumps, invert hits.",
    a: { on: { kaleido: 1, hue: 2 }, set: { kaleido: { spin: 0.3 }, jump: { step: 90 } } },
    b: { on: { kaleido: 0, invert: 1, hue: 0 }, set: { hue: { speed: 240 } } },
    mix: { blend: "difference", x: 0.45, beat: "cut", every: 2 } },
];
let vibeNow = null;            // the vibe last picked, shown on the Auto button
let autoUi = null;

function applyVibe(vb) {
  for (const c of chans) {
    if (single && c.i === 1) continue;
    const d = c.i ? vb.b : vb.a;
    deckOff(c);
    for (const [id, vi] of Object.entries(d.on)) {
      const e = BY_ID.get(id);
      c.on[id] = vi;
      if (e.fam) c.pick[id] = vi;
      applyEntry(c, e);
      for (const s of e.sliders) c.fx[s.fx][s.id] = s.value;
    }
    for (const [fx, vals] of Object.entries(d.set)) {
      for (const [k, v] of Object.entries(vals)) {
        const s = SLIDERS.find((x) => x.fx === fx && x.id === k);
        c.fx[fx][k] = s ? clamp(v, s.min, s.max) : v;
      }
    }
    for (const { s, set } of c.ui.sliders) set.set(c.fx[s.fx][s.id]);
    save(c);
    saveUi(c);
    refreshFx(c);
  }
  if (!single) {
    Object.assign(mix, vb.mix);
    beatFlip = false;
    saveMix();
    mixUI.sync();
  }
  setVibe(vb.id);
}

function setVibe(id) {
  vibeNow = id;
  if (!autoUi) return;
  const vb = VIBES.find((v) => v.id === id);
  autoUi.label.textContent = vb ? `Auto: ${vb.name}` : "Auto";
  autoUi.btn.classList.toggle("lit", !!vb);
  for (const { vb: v, el } of autoUi.items) {
    el.classList.toggle("on", v.id === id);
    el.setAttribute("aria-checked", String(v.id === id));
  }
}

/** The Auto button in the top bar and its menu of vibes. */
function autoMenu() {
  const label = h("span", "Auto");
  const btn = h("button.key.autobtn", { type: "button", "aria-haspopup": "menu", title: "Pick a vibe. It fills the decks with effects and sets the mixer" },
    svgEl('<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M2 14l8-8M11 1.5v3M9.5 3h3M14 6v2.5M12.75 7.25h2.5M5.5 2v2M4.5 3h2"/></svg>'),
    label, svgEl(SVG.chev, "autochev"));
  const note = h("span.mn");
  const items = VIBES.map((vb) => {
    const el = h("button.vibe", { type: "button", role: "menuitemradio", "aria-checked": "false" },
      h("span.led"), h("span.vn", vb.name), h("span.vd", vb.desc));
    el.addEventListener("click", () => { applyVibe(vb); pop.close(); });
    return { vb, el };
  });
  const clear = h("button.vibe.clear", { type: "button", role: "menuitem" }, h("span.vn", "Clear, all effects off"));
  clear.addEventListener("click", () => { allOff(); pop.close(); });
  const menu = h("div.pop.vibe-pop", { role: "menu", "aria-label": "Vibes" },
    h("div.mhead", h("span.gt", "Vibes"), h("span.rule"), note), ...items.map((x) => x.el), clear);
  const pop = popover(btn, menu, () => { note.textContent = single ? "Fills deck A" : "Fills both decks"; });
  autoUi = { btn, label, items };
  setVibe(vibeNow);
  return h("div.popwrap.autowrap", btn, menu);
}

// ---- autoclip ------------------------------------------------------------------------------------

// Off, a deck plays its video straight through. On, it jumps between the best stretches the
// analyser found, on the beat when music is playing. A video with no analysis yet gets one first.
const CLIP_MIN = 2;            // seconds. Shorter stretches play this long, so a jump is never a blip.
const BEAT_WAIT_MS = 1500;     // if no beat comes this long after a stretch ends, jump anyway

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "The server said no.");
  return body;
}

/** Start a server job and wait for it. onProgress gets the job as it runs. */
async function runJob(url, payload, onProgress) {
  const { job: id } = await getJSON(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  for (;;) {
    let job;
    try { job = await getJSON(`/api/jobs/${id}`); } catch { throw new Error("The analysis was lost. The server may have restarted, so try again."); }
    onProgress?.(job);
    if (job.status === "done") return job.result;
    if (job.status === "failed") throw new Error(job.message);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function autoclipButton(c) {
  const btn = toggleKey("Autoclip", "Off: the video plays straight through. On: Autoclip jumps between the best parts the analyser found.", () => toggleAutoclip(c));
  btn.classList.add("small", "best");
  c.auto = { btn, on: false, segs: null, seg: null, recent: [], waiting: 0, busy: false, token: 0, jumpTo: null };
  // A seek by hand while Autoclip is on starts a stretch where it landed, instead of being
  // undone on the next frame. Autoclip's own jumps are told apart by jumpTo.
  c.video.addEventListener("seeked", () => {
    const a = c.auto;
    if (!a.on) return;
    const t = c.video.currentTime;
    if (a.jumpTo != null && Math.abs(t - a.jumpTo) < 0.5) { a.jumpTo = null; return; }
    a.jumpTo = null;
    a.seg = { shot: -1, start: t, end: t + 4 };
    a.waiting = 0;
  });
  return btn;
}

/** A new video (or none) on the deck: Autoclip off, and any lookup or analysis for the old one ignored. */
function resetAutoclip(c) {
  const a = c.auto;
  if (!a) return;
  setAutoclip(c, false);
  a.segs = null;
  a.token++;
  a.busy = false;
  setAutoLabel(c, "");
}

function setAutoLabel(c, extra) {
  c.auto.btn.lastChild.textContent = extra ? `Autoclip ${extra}` : "Autoclip";
}

function setAutoclip(c, on) {
  const a = c.auto;
  if (!a) return;
  a.on = on;
  a.seg = null;
  a.waiting = 0;
  a.btn.set(on);
  if (on) jumpClip(c);
}

async function toggleAutoclip(c) {
  const a = c.auto;
  if (a.on) return setAutoclip(c, false);
  if (a.busy) return;
  if (!c.title) return toast(`Load a video on deck ${c.name} first.`, "info");
  if (!c.copyId) return toast("Autoclip needs the analyser's results, and this video was opened straight from a file. Load it from the list of playable copies instead.", "info");
  const forId = c.copyId, token = a.token;
  const stale = () => a.token !== token || c.copyId !== forId;
  a.busy = true;
  try {
    let info = a.segs ? { analysed: true, segments: a.segs } : await getJSON(`/api/live/${encodeURIComponent(forId)}/clips`);
    if (!info.analysed) {
      if (!info.can_analyse) throw new Error("This video has not been analysed, and its original file is no longer where it was, so it cannot be analysed now.");
      toast(`Finding the best parts of ${c.title}. The first time takes a few minutes. You can keep playing.`, "info");
      setAutoLabel(c, "0%");
      await runJob("/api/libraries", { path: info.source }, (job) => { if (!stale()) setAutoLabel(c, `${Math.round((job.progress || 0) * 100)}%`); });
      if (stale()) return;
      info = await getJSON(`/api/live/${encodeURIComponent(forId)}/clips`);
      if (!info.analysed) throw new Error("The analyser finished, but its results for this video were not found.");
    }
    if (stale()) return;
    if (!info.segments.length) throw new Error("The analyser found no parts of this video to jump between.");
    a.segs = info.segments;
    setAutoclip(c, true);
  } catch (e) {
    if (!stale()) toast(e.message, "error");
  } finally {
    if (a.token === token) { a.busy = false; setAutoLabel(c, ""); }
  }
}

/** Jump to another good stretch: weighted towards the best, not one of the last few, not the same shot. */
function jumpClip(c) {
  const a = c.auto, v = c.video;
  if (!a.segs?.length || !v.duration) return;
  const recentMax = Math.min(15, Math.floor(a.segs.length / 2));
  let pool = a.segs.filter((s) => !a.recent.includes(s.start) && s.shot !== a.seg?.shot && s.start < v.duration);
  if (!pool.length) pool = a.segs.filter((s) => s.start < v.duration);
  if (!pool.length) return;
  const weights = pool.map((s) => s.score ** 4);
  let r = Math.random() * weights.reduce((x, y) => x + y, 0);
  let seg = pool[pool.length - 1];
  for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) { seg = pool[i]; break; } }
  a.recent.push(seg.start);
  while (a.recent.length > recentMax) a.recent.shift();
  a.seg = seg;
  a.waiting = 0;
  a.jumpTo = seg.start;
  v.currentTime = seg.start;
}

/** Every refresh: when the stretch is over, jump on the next beat, or now if there is no music. */
function autoclipFrame(c, now) {
  const a = c.auto, v = c.video;
  if (!a?.on || !a.segs || v.paused || v.seeking) return;
  const s = a.seg, t = v.currentTime;
  if (s && t >= s.start - 0.3 && t < Math.max(s.end, s.start + CLIP_MIN)) return;
  if (music.beat.bpm && !music.audio.paused) {
    if (!a.waiting) a.waiting = now;
    if (now - a.waiting < BEAT_WAIT_MS) return;
  }
  jumpClip(c);
}
music.beat.onBeat(() => { for (const c of chans) if (c.auto?.on && c.auto.waiting && !c.video.paused) jumpClip(c); });

// ---- monitor previews ----------------------------------------------------------------------------

// Each deck's monitor shows that deck with its own effects ("A out"). Pointing at an effect shows
// what pressing it would do: the deck's effects plus that one, or without it if it is on now.

function setHover(c, e, vi = null) {
  c.hover = e ? { e, vi } : null;
  const u = c.ui;
  if (!u.tag) return;
  if (!e) { u.tag.textContent = `${c.name} out`; u.cue.classList.remove("cueing"); return; }
  const v = vi == null ? null : e.variants[vi];
  const name = v ? `${e.name} ${v.tag}` : e.fam ? `${e.name} ${e.variants[pickOf(c, e)].tag}` : e.name;
  u.tag.textContent = `Cue: ${name}`;
  u.cue.classList.add("cueing");
}

/** The deck's effect settings with the pointed-at effect pressed. Only changed fx are copied. */
function previewParams(c) {
  const p = { ...c.fx };
  const hv = c.hover;
  if (!hv || hv.e.kind === "hold") return p;
  const e = hv.e, vi = hv.vi ?? pickOf(c, e);
  for (const v of e.variants) for (const id of v.fx) p[id] = { ...c.fx[id], on: false };
  if (c.on[e.id] !== vi) {
    const v = e.variants[vi];
    for (const [id, vals] of Object.entries(v.set)) p[id] = { ...p[id], ...vals };
    for (const id of v.fx) p[id] = { ...p[id], on: true };
  }
  return p;
}

const PREVIEW_SHAPES = [null, "mirror", "quad", "kaleido"];
/** Beat counters for an effect that is only on in the preview. */
function previewBeat(c, n) {
  const pv = c.pv, r = rch(c);
  if (!pv || !r) return;
  const p = pv.ch.params, x = pv.ch.extra;
  if (p.jump?.on && !c.fx.jump.on) x.hueJump = (x.hueJump + p.jump.step) % 360;
  if (p.swap?.on && !c.fx.swap.on && n % Math.max(1, p.swap.every) === 0) {
    pv.swapAt = ((pv.swapAt || 0) + 1) % PREVIEW_SHAPES.length;
    x.shape = PREVIEW_SHAPES[pv.swapAt] || "none";
  }
}

/** Every refresh: the preview's settings, beat reactions and time effect. */
function previewFrame(c, env, flash) {
  const pv = c.pv, r = rch(c);
  if (!pv || !r) return;
  const ch = pv.ch, p = previewParams(c), x = ch.extra;
  ch.params = p;
  x.zoomPulse = p.pulse.on ? env * p.pulse.amount : 0;
  x.flash = p.flash.on ? flash * p.flash.amount : 0;
  x.black = p.blackout.on ? flash * p.flash.amount : 0;
  x.invHit = p.invHit.on ? flash : 0;
  x.rgbHit = p.rgbHit.on ? env : 0;
  x.fishHit = p.fishPulse.on ? env : 0;
  x.rippleHit = p.rippleHit.on ? env : 0;
  if (!p.jump.on) x.hueJump = 0; else if (c.fx.jump.on) x.hueJump = r.extra.hueJump;
  if (!p.swap.on) x.shape = null; else if (c.fx.swap.on) x.shape = r.extra.shape;
  const hv = c.hover;
  if (hv?.e.kind === "hold" && !c.fx[hv.e.id].on) {
    // Pointing at a time effect plays it in the monitor, looping the frames from that moment.
    if (!ch.ownTime || ch.timeMode?.kind !== hv.e.id) {
      ch.ownTime = true;
      ch.timeMode = { kind: hv.e.id, len: timeLen(c, hv.e.id), startedAt: performance.now() };
      ch.freeze(false);
    }
  } else {
    ch.ownTime = false;
    ch.timeMode = r.timeMode;
    ch.frozen = r.frozen;
  }
}

// ---- deck monitors -------------------------------------------------------------------------------

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/**
 * One deck's monitor under the picture: its name, a small view of its plain video (the deck's
 * own video element, so it costs nothing extra), play, position, sound, speed and Load.
 */
function buildMonitor(c) {
  const mon = $(c.i ? "monB" : "monA");
  const u = c.ui;
  u.name = h("span.fname", "No video");
  u.time = h("span.cuetime", "0:00:00.0");
  u.none = h("span.cue-none", "No video");
  u.pvCanvas = h("canvas.cuecv", { "aria-hidden": "true" });
  u.tag = h("span.cuetag", `${c.name} out`);
  const cue = h("div.cue", c.video, u.pvCanvas, h("span.scan"), u.none, u.tag, u.time);
  u.cue = cue;

  u.play = h("button.key.icon.small", { type: "button", title: "Play or pause this deck. Space plays or pauses both.", html: SVG.play });
  u.seek = range({ min: 0, max: 1000, step: 1, value: 0, "aria-label": `Position in the video on deck ${c.name}` });
  u.seek.classList.add("srng", "pos");
  u.seeking = false;
  u.mute = h("button.key.icon.small", { type: "button", html: SVG.soundOn });
  u.vol = range({ min: 0, max: 1, step: 0.01, value: 1, "aria-label": `Video volume on deck ${c.name}` });
  u.vol.classList.add("srng", "vol");
  u.speed = h("select", { "aria-label": `Speed of deck ${c.name}`, title: "Speed. [ and ] change both decks." },
    ...SPEEDS.map((v) => h("option", { value: v, selected: v === 1 }, `${v}x`)));
  // Both decks have a button that reads "Load", so the spoken name says which deck it is for.
  const load = h("button.key.small.load", { type: "button", title: `Load a video on deck ${c.name}`, "aria-label": `Load a video on deck ${c.name}` }, svgEl(SVG.load), h("span.lbl", "Load"));

  mon.append(
    h("div.dhead", h("span.badge", c.name), h("div.vfd.film", { title: `Video on deck ${c.name}` }, u.name)),
    cue,
    h("div.mrow", u.play, u.seek),
    h("div.mrow", u.mute, u.vol, h("label.vfdsel.speed", u.speed, svgEl(SVG.select, "selchev"))),
    h("div.loadrow", autoclipButton(c), load));

  u.play.addEventListener("click", () => togglePlay(c));
  u.seek.addEventListener("input", () => { u.seeking = true; const v = c.video; if (v.duration) v.currentTime = (u.seek.value / 1000) * v.duration; });
  u.seek.addEventListener("change", () => { u.seeking = false; });
  u.speed.addEventListener("change", () => { c.video.playbackRate = +u.speed.value; if (c.lastTime) syncTime(c); });
  u.mute.addEventListener("click", () => { c.video.muted = !c.video.muted; transportSync(c); });
  u.vol.addEventListener("input", () => { const v = c.video; v.volume = +u.vol.value; if (v.muted && +u.vol.value > 0) v.muted = false; transportSync(c); });
  load.addEventListener("click", () => showPicker(c));

  for (const ev of ["play", "pause", "ratechange", "volumechange"]) c.video.addEventListener(ev, () => transportSync(c));
}

function togglePlay(c) {
  const v = c.video;
  if (!v.getAttribute("src")) return showPicker(c);
  if (v.paused) v.play().catch(() => {}); else v.pause();
}

/** Space: if either deck is playing, pause both. Otherwise play both. */
function playBoth() {
  const loaded = chans.filter((c) => c.video.getAttribute("src") && !(single && c.i === 1));
  if (!loaded.length) return showPicker(chans[0]);
  const anyPlaying = loaded.some((c) => !c.video.paused);
  for (const c of loaded) {
    if (anyPlaying) c.video.pause();
    else c.video.play().catch(() => {});
  }
}

function transportSync(c) {
  const u = c.ui, v = c.video;
  if (!u.play) return;
  u.play.innerHTML = v.paused ? SVG.play : SVG.pause;
  u.play.setAttribute("aria-label", v.paused ? `Play deck ${c.name}` : `Pause deck ${c.name}`);
  u.mute.innerHTML = v.muted ? SVG.soundOff : SVG.soundOn;
  u.mute.classList.toggle("lit", !v.muted);
  u.mute.setAttribute("aria-pressed", String(!v.muted));
  u.mute.setAttribute("aria-label", `Sound of deck ${c.name}`);
  u.mute.title = v.muted ? `Deck ${c.name} sound is off. Click to turn it on.` : `Deck ${c.name} sound is on. Click to turn it off.`;
  u.speed.value = String(v.playbackRate);
  u.vol.value = v.volume;
  paintRange(u.vol);
}

function stepSpeed(c, dir) {
  const v = c.video;
  // The nearest listed speed, then one step up or down.
  let i = SPEEDS.reduce((best, s, k) => (Math.abs(s - v.playbackRate) < Math.abs(SPEEDS[best] - v.playbackRate) ? k : best), 0);
  i = clamp(i + dir, 0, SPEEDS.length - 1);
  v.playbackRate = SPEEDS[i];
  if (c.lastTime) syncTime(c);
}

// ---- titles --------------------------------------------------------------------------------------

function syncTitle() {
  const [a, b] = chans;
  for (const c of chans) {
    c.ui.name.textContent = c.title || "No video";
    c.ui.name.parentElement.title = c.title ? `Deck ${c.name}: ${c.title}` : `Deck ${c.name} has no video`;
    c.ui.cue.classList.toggle("has-video", !!c.title);
  }
  $("empty").classList.toggle("is-hidden", !!(a.title || b.title));
  document.title = a.title || b.title ? `${a.title || b.title} · Live Player` : "Live Player";
}

// ---- video picker --------------------------------------------------------------------------------

/** "The.Neon.Demon.2016.1080p.BluRay.mkv" becomes "The Neon Demon (2016)", like the start screen. */
function filmTitle(file) {
  const base = String(file || "").replace(/\.[a-z0-9]{2,4}$/i, "");
  const words = base.split(/[._]+|\s+/).filter(Boolean);
  const yearAt = words.findIndex((w, i) => i > 0 && /^\(?(19|20)\d\d\)?$/.test(w));
  if (yearAt > 0) return `${words.slice(0, yearAt).join(" ")} (${words[yearAt].replace(/[()]/g, "")})`;
  return words.join(" ") || String(file || "");
}

let pickerFor = null;    // the deck the open picker loads into
let fileTarget = null;   // the deck "Open a file" loads into
let pickerReturn = null; // the element that had the keyboard before the picker opened

function showPicker(target, message) {
  if (!renderer) return;
  closePops();
  pickerFor = target;
  overlay.classList.remove("is-hidden");
  const copies = h("div.picker-section", h("div.picker-label", "Ready to play"), h("div.picker-empty", "Loading"));
  const films = h("div.picker-section.is-hidden");
  const pathIn = h("input.input", { type: "text", placeholder: "Full path of any video, like C:/path/to/video.mkv", spellcheck: "false", "aria-label": "Video path" });
  const pathBtn = h("button.key.small", { type: "button" }, "Make playable copy");
  const prog = h("div.convert-progress.is-hidden", h("div.progress", h("div.progress-fill")), h("div.progress-msg"));
  const fileBtn = h("button.key.small", { type: "button", onclick: () => { fileTarget = target; $("file").click(); } }, "Open a file");
  const empty = target.title ? h("button.key.small", { type: "button", onclick: () => clearChannel(target) }, `Empty deck ${target.name}`) : null;
  const close = h("button.key.small", { type: "button", onclick: hidePicker, title: "Close (Esc)" }, "Close");
  const open = (url, name) => openUrl(target, url, name);

  const lead = target.i === 1
    ? "Deck B plays on top of A at first. Mix them with the crossfader, blend modes and cutouts in the mixer."
    : "Videos play live with the effects on top. A browser can only play some formats, so a video in another format gets a playable copy first. That takes a few minutes, once per video.";
  // Remember where the keyboard was, so closing the picker can put it back there.
  if (!overlay.contains(document.activeElement)) pickerReturn = document.activeElement;
  const box = h("div.picker.panel", { tabindex: "-1" },
    h("div.picker-head", h("span.badge", target.name), h("h1", `Load a video on deck ${target.name}`)),
    h("p.picker-lead", message || lead),
    copies, films,
    h("div.picker-section", h("div.picker-label", "Another video"),
      h("div.path-row", pathIn, pathBtn), prog,
      h("p.picker-note", "Or open a file from this computer, or drop one on the window. MP4 and WebM files usually play straight away.")),
    h("div.picker-actions", fileBtn, empty, h("span.grow"), close));
  overlay.replaceChildren(box);
  overlay.setAttribute("aria-label", `Load a video on deck ${target.name}`);
  // Move the keyboard into the picker, so Tab walks its buttons rather than the page behind it.
  box.focus({ preventScroll: true });

  const convert = async (path) => {
    if (!path) return;
    pathBtn.disabled = pathIn.disabled = true;
    prog.classList.remove("is-hidden");
    try {
      const res = await fetch("/api/live", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "The server said no.");
      for (;;) {
        const jr = await fetch(`/api/jobs/${body.job}`);
        const job = await jr.json().catch(() => ({}));
        if (!jr.ok) throw new Error(job.error || "The conversion was lost. The server may have restarted, so try again.");
        prog.querySelector(".progress-fill").style.width = `${Math.round((job.progress || 0) * 100)}%`;
        prog.querySelector(".progress-msg").textContent = job.message || "Working";
        if (job.status === "done") { open(job.result.url, filmTitle(job.result.name)); return; }
        if (job.status === "failed") throw new Error(job.message);
        await new Promise((r) => setTimeout(r, 700));
      }
    } catch (e) {
      toast(e.message, "error");
    } finally {
      pathBtn.disabled = pathIn.disabled = false;
      prog.classList.add("is-hidden");
    }
  };
  pathBtn.addEventListener("click", () => convert(pathIn.value.trim().replace(/^"|"$/g, "")));
  pathIn.addEventListener("keydown", (e) => { if (e.key === "Enter") pathBtn.click(); });

  fetch("/api/live").then((r) => r.json()).then(({ copies: ready, films: todo }) => {
    copies.replaceChildren(h("div.picker-label", "Ready to play"),
      ...(ready.length ? ready.map((v) => h("div.picker-row",
        h("span.name", filmTitle(v.name)), h("span.meta", v.duration ? fmtFilm(v.duration) : ""),
        h("button.key.small.lit", { type: "button", onclick: () => open(v.url, filmTitle(v.name)) }, `Load on ${target.name}`)))
        : [h("div.picker-empty", "No playable copies yet.")]));
    if (todo.length) {
      films.classList.remove("is-hidden");
      films.replaceChildren(h("div.picker-label", "Your analysed videos"),
        ...todo.map((f) => h("div.picker-row", h("span.name", filmTitle(f.name)),
          h("button.key.small", { type: "button", onclick: () => convert(f.path) }, "Make playable copy"))));
    }
  }).catch(() => copies.replaceChildren(h("div.picker-label", "Ready to play"),
    h("div.picker-empty", "The editor server is not running, so only Open a file works.")));
}

function hidePicker() {
  const wasOpen = pickerOpen();
  overlay.classList.add("is-hidden");
  pickerFor = null;
  endPick();
  // Give the keyboard back to whatever had it before the picker opened.
  if (wasOpen && overlay.contains(document.activeElement)) {
    if (pickerReturn?.isConnected && pickerReturn !== document.body) pickerReturn.focus({ preventScroll: true });
    else document.activeElement.blur();
  }
  pickerReturn = null;
}
const pickerOpen = () => !overlay.classList.contains("is-hidden") && pickerFor != null;

// A click on the dimmed background closes the picker.
overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay && pickerFor) hidePicker(); });

function openUrl(c, url, name) {
  if (c.objectUrl && c.objectUrl !== url) { URL.revokeObjectURL(c.objectUrl); c.objectUrl = null; }
  // A playable copy has the analyser's results for Autoclip. A file opened from the computer has not.
  const m = /^\/media\/live\/([^/?#]+)\.mp4$/.exec(url);
  c.copyId = m ? decodeURIComponent(m[1]) : null;
  setAutoclip(c, false);
  resetAutoclip(c);
  c.title = name;
  c.video.src = url;
  c.video.loop = true;
  c.video.play().catch(() => {});
  syncTitle();
  if (pickerFor === c) hidePicker();
}

function clearChannel(c) {
  const r = rch(c);
  c.held.clear(); c.latched.clear(); c.lastTime = null;
  for (const id of TIME_IDS) c.fx[id].on = false;
  if (r?.timeMode) r.releaseTime();
  if (c.objectUrl) { URL.revokeObjectURL(c.objectUrl); c.objectUrl = null; }
  c.title = "";
  c.copyId = null;
  setAutoclip(c, false);
  resetAutoclip(c);
  c.video.pause();
  c.video.removeAttribute("src");
  c.video.load();
  syncTitle();
  r?.release();
  refreshFx(c);
  hidePicker();
}

function openFile(file, c) {
  if (!file) return;
  if (file.type.startsWith("audio/")) {
    return toast("That is a song. Add it to the playlist from the music strip at the top.", "info");
  }
  const url = URL.createObjectURL(file);
  openUrl(c, url, file.name);
  c.objectUrl = url;
}

for (const c of chans) {
  c.video.addEventListener("error", () => {
    if (!c.title || !c.video.getAttribute("src")) return;
    showPicker(c, `${c.title} cannot play in the browser. Paste its full path below to make a playable copy.`);
  });
  c.video.addEventListener("loadedmetadata", () => {
    // Some files load their sound but not their picture (HEVC on machines without the decoder).
    if (c.video.videoWidth) return;
    showPicker(c, `${c.title} has a picture format the browser cannot show. Paste its full path below to make a playable copy.`);
  });
}

$("file").addEventListener("change", (e) => { openFile(e.target.files[0], fileTarget || chans[0]); e.target.value = ""; });
$("full").addEventListener("click", fullscreen);
$("alloff").addEventListener("click", allOff);

// The single deck switch in the top bar. Deck B is paused and hidden while it is on, and keeps
// its video for when it comes back.
const singleBtn = toggleKey("Single deck", "Use one deck only: hides deck B and the mixer", () => setSingle(!single));
singleBtn.id = "single";
$("alloff").before(singleBtn);
singleBtn.before(autoMenu());

// ---- record ------------------------------------------------------------------------------------

// Rec captures the main picture and everything you hear: the music and any deck sound that is on.
// The browser can only record WebM, so the server turns it into an MP4 in the recordings folder.
const recorder = (() => {
  let rec = null, startedAt = 0, timer = 0, dest = null, busy = false;
  const btn = toggleKey("Rec", "Record the main picture and the sound. Press again to stop and save.", () => toggle());
  btn.classList.add("rec");
  const label = btn.lastElementChild;
  const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

  /** The sound to record. The first time, every deck's sound is routed through the same sound
   *  graph as the music, so it can be recorded too. It plays exactly as before. */
  function sound() {
    music.beat.start();
    const ctx = music.beat.ctx;
    if (!dest) {
      dest = ctx.createMediaStreamDestination();
      music.beat.analyser.connect(dest);
      for (const c of chans) {
        const src = ctx.createMediaElementSource(c.video);
        src.connect(ctx.destination);
        src.connect(dest);
      }
    }
    return dest.stream;
  }

  function start() {
    if (!renderer) return toast("Recording needs WebGL, which is off in this browser.", "error");
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    const picture = canvas.captureStream(30);
    const stream = new MediaStream([...picture.getVideoTracks(), ...sound().getAudioTracks()]);
    const chunks = [];
    rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 16e6, audioBitsPerSecond: 256e3 });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      picture.getTracks().forEach((t) => t.stop());
      save(new Blob(chunks, { type: "video/webm" }), (performance.now() - startedAt) / 1000);
    };
    rec.start(1000);
    startedAt = performance.now();
    btn.set(true);
    const show = () => { label.textContent = `Rec ${mmss((performance.now() - startedAt) / 1000)}`; };
    show();
    timer = setInterval(show, 250);
  }

  function stop() {
    clearInterval(timer);
    btn.set(false);
    if (rec && rec.state !== "inactive") rec.stop();
    rec = null;
  }

  async function save(blob, seconds) {
    busy = true;
    btn.disabled = true;
    label.textContent = "Saving";
    try {
      const { job: id } = await getJSON("/api/recordings", {
        method: "POST", headers: { "Content-Type": "video/webm", "X-Duration": seconds.toFixed(2) }, body: blob });
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        const job = await getJSON(`/api/jobs/${id}`);
        if (job.status === "failed") throw new Error(job.message);
        if (job.status === "done") {
          const { name } = job.result;
          toast(`Saved to recordings/${name}`, "info", 12000,
            { label: "Show", onclick: () => fetch(`/api/recordings/${encodeURIComponent(name)}/reveal`, { method: "POST" }) });
          break;
        }
        label.textContent = `Saving ${Math.round(job.progress * 100)}%`;
      }
    } catch (e) {
      // The recording is still in the page. Offer it as it is, so it is never lost.
      const url = URL.createObjectURL(blob);
      toast(`The recording could not be saved: ${e.message}`, "error", 0, {
        label: "Download WebM",
        onclick: () => { h("a", { href: url, download: `live ${new Date().toISOString().slice(0, 19).replace(/:/g, ".")}.webm` }).click(); },
      });
    } finally {
      busy = false;
      btn.disabled = false;
      label.textContent = "Rec";
    }
  }

  function toggle() { if (rec) stop(); else if (!busy) start(); }

  // Leaving the page would lose a recording that is still going or still uploading.
  window.addEventListener("beforeunload", (e) => { if (rec || busy) e.preventDefault(); });
  return { btn, toggle, get recording() { return !!rec; } };
})();
singleBtn.before(recorder.btn);
function setSingle(on) {
  single = on;
  try { localStorage.setItem(SINGLE_KEY, on ? "1" : "0"); } catch { /* storage blocked */ }
  root.classList.toggle("single", on);
  singleBtn.set(on);
  if (on) {
    const b = chans[1];
    b.video.pause();
    b.held.clear();
    b.latched.clear();
    syncTime(b);
  }
  closePops();
  document.querySelector(".bezel.l").innerHTML = on ? "Video out <em>A</em>" : "Video out <em>A+B</em> mix";
  document.querySelector(".bezel.r").textContent = on ? "Space plays the deck" : "Space plays both decks";
  $("alloff").title = on ? "Turn every effect off (Backspace)" : "Turn every effect off on both decks (Backspace)";
}
setSingle(single);

// Drag and drop: the half of the window the file is dropped on picks the deck.
const drop = $("drop");
let dragDepth = 0;
const dropSide = (e) => (single || e.clientX < window.innerWidth / 2 ? 0 : 1);
window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { dragDepth++; root.classList.add("is-dragging"); drop.classList.add("is-on"); } });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; root.classList.remove("is-dragging"); drop.classList.remove("is-on"); } });
window.addEventListener("dragover", (e) => { e.preventDefault(); drop.dataset.side = String(dropSide(e)); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  root.classList.remove("is-dragging");
  drop.classList.remove("is-on");
  openFile(e.dataTransfer?.files[0], chans[dropSide(e)]);
});

function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.().catch(() => {});
}
let cursorTimer;
stage.addEventListener("mousemove", () => {
  stage.classList.add("show-cursor");
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => stage.classList.remove("show-cursor"), 1500);
});

// ---- keys --------------------------------------------------------------------------------------

// Effect keys go straight to their deck. The rest act on both decks or the whole player.
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Escape works from anywhere, even while typing a path in the picker. The effect search boxes
  // catch their own Escape first (it clears the box), so it never reaches here from them.
  if (e.code === "Escape") {
    if (e.repeat) return;
    if (picking != null) return endPick();
    if (closePops()) return;
    if (pickerOpen()) hidePicker();
    return;
  }
  if (isTextField(e.target)) return;
  // The picker covers the decks, so while it is open the deck keys stay quiet. Its own buttons
  // and fields still get their keys.
  if (pickerOpen()) return;
  // A keyboard user who has tabbed to a button expects Enter and Space to press it. A button
  // that was clicked with the mouse keeps focus without the focus ring, and then Space still
  // plays the decks, as on a hardware deck.
  const tabbedTo = e.target.matches?.("button, a[href], summary") && e.target.matches(":focus-visible");
  if (tabbedTo && (e.code === "Space" || e.code === "Enter" || e.code === "NumpadEnter")) return;
  const hit = BY_CODE.get(e.code);
  if (hit) {
    e.preventDefault();
    if (e.repeat) return;
    if (single && hit.deck === 1) return;
    const c = chans[hit.deck], fx = hit.e;
    if (fx.kind === "hold" && !e.shiftKey) return press(c, fx.id);
    return toggleEntry(c, fx);
  }
  if (e.target.tagName === "SELECT" || (e.target.tagName === "INPUT" && e.key.startsWith("Arrow"))) return;
  const skip = (s) => { for (const c of chans) { const v = c.video; if (v.duration) v.currentTime = clamp(v.currentTime + s, 0, v.duration); } };
  const actions = {
    Space: playBoth,
    ArrowLeft: () => skip(-5),
    ArrowRight: () => skip(5),
    BracketLeft: () => chans.forEach((c) => stepSpeed(c, -1)),
    BracketRight: () => chans.forEach((c) => stepSpeed(c, 1)),
    Enter: fullscreen,
    NumpadEnter: fullscreen,
    Equal: () => music.next(),
    Backspace: allOff,
  };
  const fn = actions[e.code];
  if (fn) { e.preventDefault(); if (!e.repeat) fn(); }
});
window.addEventListener("keyup", (e) => {
  const hit = BY_CODE.get(e.code);
  if (hit?.e.kind !== "hold") return;
  const c = chans[hit.deck];
  if (c.held.has(hit.e.id)) release(c, hit.e.id);
});
// Letting go of a key while the window is in the background never sends keyup.
window.addEventListener("blur", () => {
  mouseHolds.clear();
  for (const c of chans) for (const id of [...c.held]) release(c, id);
});

// ---- every refresh -----------------------------------------------------------------------------

function tick(now) {
  requestAnimationFrame(tick);
  music.frame(now);
  applyMix();
  mixUI.frame();
  for (const c of chans) {
    const u = c.ui, v = c.video;
    if (v.duration && !u.seeking) {
      u.seek.value = String(Math.round((v.currentTime / v.duration) * 1000));
      u.seek.style.setProperty("--p", `${(v.currentTime / v.duration) * 100}%`);
    } else if (!v.duration) {
      u.seek.value = "0";
      u.seek.style.setProperty("--p", "0%");
    }
    const t = fmtFilm(v.currentTime || 0);
    if (u.time.textContent !== t) u.time.textContent = t;
    autoclipFrame(c, now);
    if (c.pv) {
      c.pv.on = !(single && c.i === 1);
      u.cue.classList.toggle("has-preview", c.pv.drawn);
    }
  }
}

for (const c of chans) { buildColumn(c); buildMonitor(c); transportSync(c); }
if (renderer) for (const c of chans) {
  c.pv = renderer.addPreview(c.i, c.ui.pvCanvas);
  // The deck's ring of recent frames empties on a seek or a new video. A time effect playing only
  // in the monitor starts its loop again from the new frames, instead of mixing old and new.
  const restart = () => { const ch = c.pv.ch; if (ch.ownTime) ch.frozen = { head: 0, count: 0, total0: ch.ring.total, protect: 0 }; };
  c.video.addEventListener("seeking", restart);
  c.video.addEventListener("emptied", restart);
}
syncTitle();
requestAnimationFrame(tick);
showPicker(chans[0]);

// For checking from the console or a test: window.live.renderer, window.live.chans, window.live.mix
window.live = { recorder, renderer, chans, mix, music, showPicker, openUrl };
