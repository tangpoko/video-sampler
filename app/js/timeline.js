// Timeline: an overview strip of the whole song, then the ruler, section bands, one block per cut,
// the beat grid and the song's waveform.
//
// The main timeline opens zoomed in so that about 8 bars of music fill its width, which is wide
// enough for an ordinary cut to show its thumbnail. The overview strip above it always shows the
// whole song with a box marking the part the main timeline is showing. Dragging the box scrolls
// the main timeline, so the main timeline has no scrollbar of its own.
//
// Everything is placed by one number, pps (pixels per second of song). A cut's block sits at
// left = t0 * pps and is (t1 - t0) * pps wide, so it lines up exactly with the ruler and the
// playhead. The ruler, beat grid and waveform are painted on a canvas the size of the visible
// area and repainted on scroll and zoom. The cuts are ordinary elements inside the scroller.

import { h, clamp, fmtTime, fmtBeats, range, paintRange, absUrl } from "./util.js";
import { icons } from "./icons.js";
import { S, on, select, actions, thumbUrl } from "./state.js";

const RULER_H = 24;
const SECTION_H = 20;
const BOTTOM_PAD = 6;         // space under the waveform
const OPEN_BARS = 8;          // bars of music across the timeline when a project opens
const OV_MIN_BOX = 10;        // the overview box never gets narrower than this, so it can be grabbed
const LABEL_MIN = 76;         // a block at least this wide has room for its length in words
const PAD = 12;               // empty space before 0:00 and after the end, matches .tl-track in the CSS
const MAX_PPS = 420;          // a half-beat cut (about 0.22 s) is over 90 px wide here
const THUMB_MIN = 22;         // narrower than this, a block is a plain coloured bar
const HANDLE_MIN = 14;        // narrower than this, there is no room for an edge handle
const SECTION_HUES = [212, 158, 276, 24, 338, 96, 190, 52];
export const CLIP_MIME = "application/x-vs-clip";

export function createTimeline(root, player) {
  const cutCount = h("span.tl-count");
  const zoomOut = h("button.icon-btn.sm", { "aria-label": "Zoom out", title: "Zoom out", html: icons.minus });
  const zoomIn = h("button.icon-btn.sm", { "aria-label": "Zoom in", title: "Zoom in", html: icons.plus });
  const zoomSlider = range({ min: 0, max: 1000, step: 1, value: 0, "aria-label": "Zoom", class: "range zoom" });
  const fitBtn = h("button.btn.ghost.sm.fit-btn", { title: "Show the whole song", "aria-pressed": "false" }, h("span", { html: icons.fit }), "Fit");
  const toolbar = h("div.tl-toolbar",
    h("span.panel-title", "Timeline"), cutCount, h("span.spacer"),
    h("span.tl-hint", "Ctrl + wheel to zoom"),
    zoomOut, zoomSlider, zoomIn, fitBtn);

  const canvas = h("canvas.tl-canvas");
  const sectionsEl = h("div.tl-sections");
  const cutsEl = h("div.tl-cuts");
  const snapEl = h("div.tl-snap", h("span.tl-snap-label"));
  const playhead = h("div.tl-playhead", h("span.tl-playhead-cap"));
  const track = h("div.tl-track", sectionsEl, cutsEl, snapEl, playhead);
  const content = h("div.tl-content", track);
  const scroller = h("div.tl-scroll", { tabindex: "-1" }, content);
  const body = h("div.tl-body", canvas, scroller);

  // Overview strip: the whole song, with a box for the part the main timeline shows.
  const ovCanvas = h("canvas.ov-canvas");
  const ovSel = h("div.ov-sel");
  const ovBox = h("div.ov-box");
  const ovPlayhead = h("div.ov-playhead");
  const overview = h("div.tl-overview", { "aria-label": "Whole song. Drag the box to scroll the timeline." },
    ovCanvas, ovSel, ovBox, ovPlayhead);
  root.append(toolbar, overview, body);
  const ovCtx = ovCanvas.getContext("2d");
  let ovW = 0, ovH = 0;
  let box = { left: 0, width: 0 };
  let lastPps = 0;             // the zoom to go back to when Fit is switched off
  const hueOf = new Map();     // section label to tint, shared by the overview and the main bands

  const ctx = canvas.getContext("2d");
  let pps = 0;                 // 0 until the first layout, then pixels per second
  let fitted = true;           // true while the zoom is "whole song", so resizing keeps it fitted
  let viewW = 0, viewH = 0;
  let dragging = false;
  let geo = { cutsH: 80, waveTop: 140, waveH: 60 };
  const blockById = new Map();
  const css = getComputedStyle(document.documentElement);
  const colour = (name) => css.getPropertyValue(name).trim();

  const duration = () => S.project?.song.duration || 0;
  const minPps = () => (viewW > PAD * 2 && duration() ? (viewW - PAD * 2) / duration() : 1);
  const timeAtClientX = (x) => clamp((x - track.getBoundingClientRect().left) / pps, 0, duration());

  /** Lane heights for the current panel height: ruler, sections, cuts, then the waveform. */
  function measure() {
    viewW = body.clientWidth;
    viewH = body.clientHeight;
    const cutsH = clamp(Math.round((viewH - RULER_H - SECTION_H - BOTTOM_PAD - 10) * 0.6), 44, 120);
    const waveTop = RULER_H + SECTION_H + 4 + cutsH + 6;
    geo = { cutsH, waveTop, waveH: Math.max(16, viewH - waveTop - BOTTOM_PAD) };
    body.style.setProperty("--cuts-h", `${cutsH}px`);
    ovW = overview.clientWidth;
    ovH = overview.clientHeight;
  }

  /** The zoom a project opens at: OPEN_BARS bars of four beats across the visible width. */
  function openPps() {
    const tempo = S.project?.song.tempo || 120;
    const seconds = OPEN_BARS * 4 * (60 / tempo);
    return clamp((viewW - PAD * 2) / seconds, minPps(), MAX_PPS);
  }

  // ---------- zoom ----------

  function sliderFromPps() {
    const lo = Math.log(minPps()), hi = Math.log(MAX_PPS);
    zoomSlider.value = hi > lo ? Math.round(((Math.log(pps) - lo) / (hi - lo)) * 1000) : 0;
    paintRange(zoomSlider);
  }

  /** Change zoom, keeping the song time under anchorX (pixels from the left of the view) still. */
  function setZoom(next, anchorX = viewW / 2) {
    if (!duration() || !viewW) return;
    next = clamp(next, minPps(), MAX_PPS);
    const t = pps ? (scroller.scrollLeft + anchorX - PAD) / pps : 0;
    pps = next;
    fitted = pps <= minPps() * 1.001;
    layout();
    scroller.scrollLeft = fitted ? 0 : t * pps + PAD - anchorX;
    fitBtn.setAttribute("aria-pressed", String(fitted));
    fitBtn.title = fitted ? "Zoom back in" : "Show the whole song";
    sliderFromPps();
    paint();
    placeBox();
  }

  zoomSlider.addEventListener("input", () => {
    const lo = Math.log(minPps()), hi = Math.log(MAX_PPS);
    setZoom(Math.exp(lo + (hi - lo) * (+zoomSlider.value / 1000)), playheadAnchor());
  });
  zoomSlider.addEventListener("keydown", (e) => e.stopPropagation());
  zoomOut.addEventListener("click", () => setZoom(pps / 1.5, playheadAnchor()));
  zoomIn.addEventListener("click", () => setZoom(pps * 1.5, playheadAnchor()));
  // Fit shows the whole song. Pressing it again goes back to the zoom from before.
  fitBtn.addEventListener("click", () => {
    if (fitted) return setZoom(Math.max(lastPps, openPps()), playheadAnchor());
    lastPps = pps;
    setZoom(0);
  });
  body.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setZoom(pps * Math.exp(-e.deltaY * 0.0022), e.clientX - body.getBoundingClientRect().left);
    } else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();   // a plain mouse wheel scrolls the timeline sideways
      scroller.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  /** Zoom around the playhead when it is on screen, otherwise around the middle. */
  function playheadAnchor() {
    const x = player.time() * pps + PAD - scroller.scrollLeft;
    return x >= 0 && x <= viewW ? x : viewW / 2;
  }

  // ---------- layout ----------

  function placeBlock(el, cut) {
    const w = (cut.t1 - cut.t0) * pps;
    el.style.left = `${cut.t0 * pps}px`;
    el.style.width = `${w}px`;
    el.classList.toggle("is-bar", w < THUMB_MIN);
    el.classList.toggle("is-thin", w < HANDLE_MIN);
    el.classList.toggle("has-label", w >= LABEL_MIN);
    // Wider than one thumbnail: repeat it like a film strip. Narrower: show its middle.
    el.classList.toggle("is-strip", w > geo.cutsH * (S.project?.library.aspect || 2.39));
  }

  function layout() {
    const p = S.project;
    if (!p || !pps) return;
    content.style.width = `${duration() * pps + PAD * 2}px`;
    for (const cut of p.cuts) {
      const el = blockById.get(cut.id);
      if (el) placeBlock(el, cut);
    }
    for (const el of sectionsEl.children) {
      el.style.left = `${+el.dataset.t0 * pps}px`;
      el.style.width = `${(+el.dataset.t1 - +el.dataset.t0) * pps}px`;
    }
    movePlayhead(player.time());
    placeSelection();
  }

  function buildSections() {
    const p = S.project;
    hueOf.clear();
    sectionsEl.replaceChildren(...p.song.sections.map((s) => {
      // The same label always gets the same tint.
      if (!hueOf.has(s.label)) hueOf.set(s.label, SECTION_HUES[hueOf.size % SECTION_HUES.length]);
      return h("div.tl-section", {
        dataset: { t0: s.t0, t1: s.t1, label: s.label },
        style: `--hue:${hueOf.get(s.label)}`,
        title: `Section ${s.label}, ${fmtTime(s.t0, false)} to ${fmtTime(s.t1, false)}`,
      }, h("span.tl-section-label", s.label));
    }));
  }

  function buildCuts() {
    const p = S.project;
    blockById.clear();
    const frag = document.createDocumentFragment();
    p.cuts.forEach((cut, i) => {
      const clip = S.clipById.get(cut.clip);
      const grey = !clip || clip.hue_strength < 0.08;
      const el = h("div.cut", {
        dataset: { id: cut.id, index: i },
        title: `${cut.clip}, ${fmtBeats(cut.beats).toLowerCase()}${cut.locked ? ", locked" : ""}`,
      },
        h("div.cut-thumb"),
        h("span.cut-label", fmtBeats(cut.beats)),
        h("div.cut-marks",
          cut.locked && h("span.cut-mark.lock", { html: icons.lock, title: "Locked" }),
          cut.effects.length > 0 && h("span.cut-mark.fx", { html: icons.fx, title: cut.effects.join(", ") })),
        i > 0 && h("div.cut-handle", { title: "Drag to move where this cut starts" }));
      el.style.setProperty("--thumb", `url("${absUrl(thumbUrl(cut.clip))}")`);
      el.style.setProperty("--bar", grey ? "hsl(225 5% 36%)" : `hsl(${clip.hue} 30% 38%)`);
      if (cut.locked) el.classList.add("is-locked");
      if (cut.effects.length) el.classList.add("has-fx");
      if (cut.id === S.selectedId) el.classList.add("is-selected");
      blockById.set(cut.id, el);
      frag.append(el);
    });
    cutsEl.replaceChildren(frag);
    const locked = p.cuts.filter((c) => c.locked).length;
    cutCount.textContent = `${p.cuts.length} cuts${locked ? `, ${locked} locked` : ""}`;
  }

  // ---------- canvas: ruler, beat grid, waveform ----------

  function paint() {
    const p = S.project;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(viewW * dpr) || canvas.height !== Math.round(viewH * dpr)) {
      canvas.width = Math.round(viewW * dpr);
      canvas.height = Math.round(viewH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    if (!p || !pps) return;
    const x0 = scroller.scrollLeft - PAD;   // song time 0 is PAD pixels into the content
    const tA = Math.max(0, x0 / pps), tB = Math.min(duration(), (x0 + viewW) / pps);
    const { waveTop, waveH } = geo;
    const waveBottom = waveTop + waveH;

    // Ruler: a step that leaves at least 64 px between labels.
    const steps = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60];
    const step = steps.find((s) => s * pps >= 64) || 120;
    ctx.font = `10.5px ${colour("--font")}`;
    ctx.textBaseline = "middle";
    ctx.fillStyle = colour("--text-faint");
    ctx.strokeStyle = colour("--line-strong");
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let t = Math.floor(tA / step) * step; t <= tB; t += step) {
      const x = Math.round(t * pps - x0) + 0.5;
      ctx.moveTo(x, RULER_H - 7);
      ctx.lineTo(x, RULER_H);
      ctx.fillText(fmtTime(t + 1e-6, step < 1), x + 7, RULER_H / 2 - 1);
    }
    ctx.stroke();

    // Beat grid through the waveform lane, downbeats stronger, drawn over the waveform. Plain
    // beats drop out when they would sit closer than 9 px, downbeats when closer than 14 px, so
    // the whole-song view stays calm.
    const beats = p.song.beats;
    const beatGap = (60 / (p.song.tempo || 120)) * pps;
    const drawBeats = (downbeat, style, top) => {
      ctx.strokeStyle = style;
      ctx.beginPath();
      for (const b of beats) {
        if (b.t < tA || b.t > tB || !!b.downbeat !== downbeat) continue;
        const x = Math.round(b.t * pps - x0) + 0.5;
        ctx.moveTo(x, top);
        ctx.lineTo(x, waveBottom);
      }
      ctx.stroke();
    };

    // Waveform, mirrored around the middle of its lane.
    const peaks = p.song.peaks || [];
    if (peaks.length) {
      const mid = waveTop + waveH / 2, amp = waveH / 2 - 4;
      const perPx = peaks.length / (duration() * pps);   // peak values per pixel
      ctx.fillStyle = colour("--wave");
      ctx.beginPath();
      const xEnd = Math.min(viewW, duration() * pps - x0);
      for (let x = Math.max(0, Math.ceil(-x0)); x < xEnd; x++) {
        const a = (x0 + x) * perPx;
        let v = 0;
        if (perPx >= 1) {
          for (let i = Math.floor(a); i < Math.min(peaks.length, Math.ceil(a + perPx)); i++) v = Math.max(v, peaks[i]);
        } else {
          const i = Math.floor(a), f = a - i;
          v = (peaks[i] ?? 0) * (1 - f) + (peaks[Math.min(peaks.length - 1, i + 1)] ?? 0) * f;
        }
        const hgt = Math.max(1, v * amp);
        ctx.rect(x, mid - hgt, 1, hgt * 2);
      }
      ctx.fill();
    }
    if (beatGap >= 9) drawBeats(false, colour("--grid"), waveTop);
    if (beatGap * 4 >= 14) drawBeats(true, colour("--grid-strong"), waveTop - 3);
  }

  // ---------- overview strip ----------

  /** Pixels from the left of the overview strip for a song time. */
  const ovX = (t) => PAD + (duration() ? t / duration() : 0) * Math.max(0, ovW - PAD * 2);

  /** Section bands with their labels and the waveform. Repainted on resize and when a song loads. */
  function paintOverview() {
    const p = S.project;
    const dpr = window.devicePixelRatio || 1;
    if (ovCanvas.width !== Math.round(ovW * dpr) || ovCanvas.height !== Math.round(ovH * dpr)) {
      ovCanvas.width = Math.round(ovW * dpr);
      ovCanvas.height = Math.round(ovH * dpr);
    }
    ovCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ovCtx.clearRect(0, 0, ovW, ovH);
    if (!p || !duration() || ovW <= PAD * 2) return;
    const bands = p.song.sections.map((s) => ({ ...s, x0: Math.round(ovX(s.t0)), x1: Math.round(ovX(s.t1)), hue: hueOf.get(s.label) ?? 212 }));
    for (const b of bands) {
      ovCtx.fillStyle = `hsl(${b.hue} 24% 15%)`;
      ovCtx.fillRect(b.x0 + 1, 0, b.x1 - b.x0 - 1, ovH);
      ovCtx.fillStyle = `hsl(${b.hue} 34% 34%)`;
      ovCtx.fillRect(b.x0 + 1, 0, b.x1 - b.x0 - 1, 2);
    }
    // Waveform, standing on the bottom edge, in each section's own tint.
    const peaks = p.song.peaks || [];
    const x0 = Math.round(ovX(0)), x1 = Math.round(ovX(duration()));
    const top = 13, amp = ovH - top - 2;
    let bi = 0;
    for (let x = x0; x < x1 && peaks.length; x++) {
      const a = ((x - x0) / (x1 - x0)) * peaks.length, b = ((x + 1 - x0) / (x1 - x0)) * peaks.length;
      let v = 0;
      for (let i = Math.floor(a); i < Math.min(peaks.length, Math.max(Math.floor(a) + 1, Math.ceil(b))); i++) v = Math.max(v, peaks[i]);
      while (bi < bands.length - 1 && x >= bands[bi].x1) bi++;
      const hgt = Math.max(1, Math.round(v * amp));
      ovCtx.fillStyle = `hsl(${bands[bi]?.hue ?? 212} 22% 44%)`;
      ovCtx.fillRect(x, ovH - hgt, 1, hgt);
    }
    ovCtx.font = `600 10px ${colour("--font")}`;
    ovCtx.textBaseline = "middle";
    for (const b of bands) {
      if (b.x1 - b.x0 < 16) continue;
      ovCtx.fillStyle = `hsl(${b.hue} 45% 78%)`;
      ovCtx.fillText(b.label, b.x0 + 6, 9);
    }
  }

  /** Put the box over the part of the song the main timeline is showing. */
  function placeBox() {
    if (!pps || !duration()) return;
    const tA = clamp((scroller.scrollLeft - PAD) / pps, 0, duration());
    const tB = clamp((scroller.scrollLeft + viewW - PAD) / pps, 0, duration());
    let left = ovX(tA), width = ovX(tB) - left;
    if (width < OV_MIN_BOX) {
      left = clamp(left - (OV_MIN_BOX - width) / 2, 0, Math.max(0, ovW - OV_MIN_BOX));
      width = OV_MIN_BOX;
    }
    box = { left, width, tA, tB };
    ovBox.style.transform = `translateX(${left}px)`;
    ovBox.style.width = `${width}px`;
    overview.classList.toggle("is-fitted", fitted);
    overview.dataset.t0 = tA.toFixed(3);
    overview.dataset.t1 = tB.toFixed(3);
  }

  /** A mark on the overview for the selected cut, so it can be found again after scrolling away. */
  function placeSelection() {
    const cut = S.project?.cuts.find((c) => c.id === S.selectedId);
    ovSel.classList.toggle("is-on", !!cut);
    if (!cut) return;
    ovSel.style.transform = `translateX(${ovX(cut.t0)}px)`;
    ovSel.style.width = `${Math.max(2, ovX(cut.t1) - ovX(cut.t0))}px`;
  }

  // Drag the box to scroll. A press outside the box centres the box there first.
  overview.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !S.project || !pps) return;
    e.preventDefault();
    const rect = overview.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const inside = x >= box.left && x <= box.left + box.width;
    const grab = inside ? x - box.left : box.width / 2;
    const scrollTo = (clientX) => {
      // Left edge of the box, as a song time, then as a scroll position of the main timeline.
      const t = ((clientX - rect.left - grab - PAD) / Math.max(1, ovW - PAD * 2)) * duration();
      scroller.scrollLeft = t <= 0 ? 0 : t * pps + PAD;
    };
    dragging = true;
    overview.classList.add("is-dragging");
    overview.setPointerCapture(e.pointerId);
    if (!inside) scrollTo(e.clientX);
    const move = (ev) => scrollTo(ev.clientX);
    const up = () => {
      dragging = false;
      overview.classList.remove("is-dragging");
      overview.removeEventListener("pointermove", move);
      overview.removeEventListener("pointerup", up);
      overview.removeEventListener("pointercancel", up);
    };
    overview.addEventListener("pointermove", move);
    overview.addEventListener("pointerup", up);
    overview.addEventListener("pointercancel", up);
  });
  overview.addEventListener("wheel", (e) => {
    e.preventDefault();
    scroller.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  }, { passive: false });

  // ---------- playhead ----------

  function movePlayhead(t) {
    if (!pps) return;
    const x = t * pps;
    playhead.style.transform = `translateX(${x}px)`;
    playhead.dataset.x = x;
    ovPlayhead.style.transform = `translateX(${ovX(t)}px)`;
    ovPlayhead.dataset.x = ovX(t);
    // Keep the playhead on screen: while playing the view turns the page, and a seek made from
    // the player's own bar brings the view to it. Not while the user is dragging in the timeline.
    if (!dragging && !fitted && t !== lastT) {
      const left = scroller.scrollLeft, sx = x + PAD;
      if (sx < left || sx > left + viewW - 32) {
        scroller.scrollLeft = Math.max(0, player.playing() ? sx - viewW * 0.12 : sx - viewW / 2);
      }
    }
    lastT = t;
  }
  let lastT = -1;
  player.onTime(movePlayhead);

  /** Scroll so a cut is on screen, used when the selection moves by keyboard. */
  function reveal(cut) {
    if (!cut || !pps) return;
    const a = cut.t0 * pps + PAD, b = cut.t1 * pps + PAD;
    if (a < scroller.scrollLeft + 8) scroller.scrollLeft = Math.max(0, a - 48);
    else if (b > scroller.scrollLeft + viewW - 8) scroller.scrollLeft = b - viewW + 48;
  }

  // ---------- pointer: select, seek, drag a cut's left edge ----------

  content.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !S.project) return;
    const handle = e.target.closest(".cut-handle");
    if (handle) return startEdgeDrag(e, handle.parentElement);
    const block = e.target.closest(".cut");
    if (block) return select(block.dataset.id);
    // Ruler, section band or waveform: seek, and keep seeking while the button is held.
    dragging = true;
    content.setPointerCapture(e.pointerId);
    player.seek(timeAtClientX(e.clientX));
    const move = (ev) => player.seek(timeAtClientX(ev.clientX));
    const up = () => {
      dragging = false;
      content.removeEventListener("pointermove", move);
      content.removeEventListener("pointerup", up);
      content.removeEventListener("pointercancel", up);
    };
    content.addEventListener("pointermove", move);
    content.addEventListener("pointerup", up);
    content.addEventListener("pointercancel", up);
  });
  cutsEl.addEventListener("dblclick", (e) => {
    const block = e.target.closest(".cut");
    const cut = block && S.project.cuts[+block.dataset.index];
    if (cut) player.seek(cut.t0 + 0.001);
  });

  function startEdgeDrag(e, block) {
    e.preventDefault();
    const cuts = S.project.cuts;
    const i = +block.dataset.index;
    const cut = cuts[i], prev = cuts[i - 1];
    if (!prev) return;
    const prevEl = blockById.get(prev.id);
    // The new start must stay strictly between the previous cut's start and this cut's end.
    const lo = prev.beat0 + 0.5, hi = cut.beat0 + cut.beats - 0.5;
    let beat = cut.beat0;
    dragging = true;
    select(cut.id);
    block.setPointerCapture(e.pointerId);
    document.body.classList.add("is-resizing");
    const label = snapEl.firstChild;

    const move = (ev) => {
      beat = clamp(S.beat.snapHalf(timeAtClientX(ev.clientX)), lo, hi);
      const t = beat === cut.beat0 ? cut.t0 : S.beat.time(beat);
      placeBlock(prevEl, { t0: prev.t0, t1: t });
      placeBlock(block, { t0: t, t1: cut.t1 });
      snapEl.style.transform = `translateX(${t * pps}px)`;
      snapEl.classList.add("is-on");
      label.textContent = t.toFixed(2) + ' s';
    };
    const up = () => {
      dragging = false;
      document.body.classList.remove("is-resizing");
      snapEl.classList.remove("is-on");
      block.removeEventListener("pointermove", move);
      block.removeEventListener("pointerup", up);
      block.removeEventListener("pointercancel", up);
      if (beat !== cut.beat0) {
        actions.moveStart(cut.id, beat).then((ok) => { if (!ok) layout(); });
      } else {
        layout();
      }
    };
    block.addEventListener("pointermove", move);
    block.addEventListener("pointerup", up);
    block.addEventListener("pointercancel", up);
  }

  // ---------- drop a crate clip on a cut ----------

  let dropEl = null;
  const setDrop = (el) => {
    if (dropEl === el) return;
    dropEl?.classList.remove("is-drop");
    dropEl = el;
    dropEl?.classList.add("is-drop");
  };
  cutsEl.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes(CLIP_MIME)) return;
    const block = e.target.closest(".cut");
    setDrop(block);
    if (block) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });
  cutsEl.addEventListener("dragleave", (e) => {
    if (!cutsEl.contains(e.relatedTarget)) setDrop(null);
  });
  cutsEl.addEventListener("drop", (e) => {
    const block = e.target.closest(".cut");
    const clip = e.dataTransfer.getData(CLIP_MIME);
    setDrop(null);
    if (!block || !clip) return;
    e.preventDefault();
    select(block.dataset.id);
    actions.swapClip(block.dataset.id, clip);
  });

  // ---------- wiring ----------

  scroller.addEventListener("scroll", () => { paint(); placeBox(); }, { passive: true });
  new ResizeObserver(() => refresh()).observe(body);

  on("open", () => {
    pps = 0;
    lastPps = 0;
    fitted = false;
    scroller.scrollLeft = 0;
    buildSections();
  });
  on("project", () => {
    buildCuts();
    measure();
    if (!pps) openZoom();
    else { layout(); paint(); placeBox(); }
  });
  on("selection", (cut) => {
    cutsEl.querySelector(".cut.is-selected")?.classList.remove("is-selected");
    if (cut) blockById.get(cut.id)?.classList.add("is-selected");
    placeSelection();
  });

  /** Re-measure and redraw. Called when the editor becomes visible. */
  function refresh() {
    measure();
    if (!S.project || !viewW) return;
    paintOverview();
    if (!pps) openZoom();
    else if (fitted || pps < minPps()) setZoom(0);
    else { layout(); sliderFromPps(); paint(); placeBox(); }
  }

  /** First layout of a project: zoomed in to OPEN_BARS bars, at the start of the song. */
  function openZoom() {
    if (!viewW || !duration()) return;
    setZoom(openPps(), 0);
    scroller.scrollLeft = 0;
    paintOverview();
    placeBox();
  }

  return {
    reveal,
    refresh,
    setZoom,
    get pps() { return pps; },
    get fitted() { return fitted; },
    get view() { return { scrollLeft: scroller.scrollLeft, width: viewW, t0: box.tA, t1: box.tB }; },
  };
}
