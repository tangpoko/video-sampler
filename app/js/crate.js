// Crate: the film's best clips as a grid, ranked live by the three weight sliders.
// The ranking, the per-shot limit, the Variety penalty and the hover preview follow
// engine/crate_template.html.

import { h, fmtFilm, range, paintRange, absUrl } from "./util.js";
import { icons } from "./icons.js";
import { S, on, actions, selectedCut, thumbUrl } from "./state.js";
import { CLIP_MIME } from "./timeline.js";

const PER_SHOT = 2;       // at most this many clips from one shot
const NEAR_SECONDS = 45;  // Variety looks this far around each picked clip
const PAGE = 60;

export function createCrate(root) {
  const W = { colour: 35, motion: 30, strange: 35 };
  let variety = 50;
  let want = PAGE * 2;
  let order = "score";
  let tagsOpen = false;
  const activeTags = new Set();

  const count = h("span.crate-count");
  const orderBtns = [["score", "Best"], ["hue", "Colour"], ["time", "Film"]].map(([id, label]) =>
    h("button.seg-btn", { dataset: { order: id }, "aria-pressed": id === order ? "true" : "false",
      title: { score: "Best first", hue: "Sorted by colour", time: "In film order" }[id],
      onclick: () => { order = id; orderBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.order === id))); render(); } }, label));
  const head = h("div.panel-head", h("span.panel-title", "Crate"), count, h("span.spacer"), h("div.seg", orderBtns));

  const sliders = {};
  const slider = (key, label, cls, get, set, onRelease) => {
    const out = h("output.slider-value", String(get()));
    const el = range({ min: 0, max: 100, step: 1, value: get(), "aria-label": label });
    el.addEventListener("input", () => { set(+el.value); out.textContent = el.value; render(); });
    if (onRelease) el.addEventListener("change", onRelease);
    el.addEventListener("keydown", (e) => e.stopPropagation());
    sliders[key] = { el, out };
    return h(`label.slider-cell.${cls}`, h("span.slider-row", h("span.slider-dot"), h("span.slider-label", label), out), el);
  };
  // The three weights are also the auto mode's taste settings, so they are saved on release.
  const saveWeights = () => {
    if (!S.project) return;
    actions.patchSettings({ colour: W.colour / 100, motion: W.motion / 100, strange: W.strange / 100 });
  };
  const controls = h("div.crate-sliders",
    slider("colour", "Colour", "w-colour", () => W.colour, (v) => { W.colour = v; }, saveWeights),
    slider("motion", "Motion", "w-motion", () => W.motion, (v) => { W.motion = v; }, saveWeights),
    slider("strange", "Strangeness", "w-strange", () => W.strange, (v) => { W.strange = v; }, saveWeights),
    slider("variety", "Variety", "w-variety", () => variety, (v) => { variety = v; }));

  const tagsEl = h("div.crate-tags");
  const tagsToggle = h("button.btn.ghost.sm.tags-toggle", { onclick: () => { tagsOpen = !tagsOpen; syncTags(); } });
  const tagsRow = h("div.crate-tags-row", tagsEl, tagsToggle);
  const grid = h("div.crate-grid");
  const more = h("button.btn.ghost.more-btn", { onclick: () => { want += PAGE; render(); } }, "Show more clips");
  const emptyEl = h("div.empty",
    h("div.empty-title", "No clips match these tags"),
    h("div.empty-sub", "Turn a tag off to see more of the film."));
  const scroll = h("div.crate-scroll", grid, emptyEl, more);
  root.append(head, controls, tagsRow, scroll);

  function syncTags() {
    tagsEl.classList.toggle("is-open", tagsOpen);
    tagsToggle.textContent = tagsOpen ? "Fewer tags" : "All tags";
  }

  function buildTags() {
    const counts = {};
    for (const c of S.clips) for (const t of c.tags) counts[t] = (counts[t] || 0) + 1;
    activeTags.clear();
    tagsEl.replaceChildren(...Object.keys(counts).sort((a, b) => counts[b] - counts[a]).map((t) =>
      h("button.chip", { "aria-pressed": "false", onclick: (e) => {
        activeTags.has(t) ? activeTags.delete(t) : activeTags.add(t);
        e.currentTarget.setAttribute("aria-pressed", String(activeTags.has(t)));
        render();
      } }, t, h("span.chip-n", String(counts[t])))));
    syncTags();
  }

  const scoreOf = (c) => {
    const tot = W.colour + W.motion + W.strange || 1;
    return c.quality * (W.colour * c.colour + W.motion * c.motion + W.strange * c.strange) / tot;
  };

  // One shared video element, moved into whichever tile is hovered and seeked to its clip.
  const vid = h("video.tile-video", { playsinline: true, preload: "auto" });
  vid.muted = true;
  let playing = null;
  vid.addEventListener("timeupdate", () => { if (playing && vid.currentTime >= playing.end) vid.currentTime = playing.start; });
  function hoverIn(tile, c) {
    playing = c;
    tile.querySelector(".tile-frame").append(vid);
    const go = () => { if (playing === c) { vid.currentTime = c.start; vid.play().catch(() => {}); } };
    // Seeking before the video's metadata has loaded is ignored, so wait for it on first hover.
    if (vid.readyState >= 1) go(); else vid.addEventListener("loadedmetadata", go, { once: true });
  }
  function hoverOut() {
    if (!playing && !vid.isConnected) return;
    playing = null;
    vid.pause();
    vid.remove();
  }

  function rank() {
    let list = S.clips.filter((c) => !activeTags.size || c.tags.some((t) => activeTags.has(t)));
    const matching = list.length;
    list = list.map((c) => ({ c, s: scoreOf(c) })).sort((a, b) => b.s - a.s);
    const used = {};
    list = list.filter(({ c }) => (used[c.shot] = (used[c.shot] || 0) + 1) <= PER_SHOT);
    // Variety: one strong scene (a club full of strobes) can fill the whole crate on its own.
    // Each pick lowers the score of every clip within 45 seconds of it in the film. At 100,
    // each nearby pick costs 0.08, so a clip with five picks around it drops by 0.4 and the
    // next scene gets a turn.
    const cost = (variety / 100) * 0.08;
    const picked = [];
    const pool = list.slice();
    while (picked.length < want && pool.length) {
      let best = 0, bestS = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const c = pool[i].c;
        let near = 0;
        for (const p of picked) if (Math.abs(p.c.start - c.start) < NEAR_SECONDS) near++;
        const s = pool[i].s - cost * near;
        if (s > bestS) { bestS = s; best = i; }
        if (cost === 0) break;
      }
      picked.push(pool.splice(best, 1)[0]);
    }
    picked.forEach((x, i) => { x.rank = i + 1; });
    if (order === "hue") picked.sort((a, b) => (a.c.hue_strength < 0.08) - (b.c.hue_strength < 0.08) || a.c.hue - b.c.hue);
    if (order === "time") picked.sort((a, b) => a.c.start - b.c.start);
    return { picked, available: list.length, matching };
  }

  function render() {
    if (!S.project) return;
    const { picked, available, matching } = rank();
    hoverOut();
    const ar = S.project.library.aspect || 2.39;
    const selClip = selectedCut()?.clip;
    const frag = document.createDocumentFragment();
    for (const { c, s, rank: r } of picked) {
      const sw = c.hue_strength < 0.08 ? "hsl(225 5% 50%)" : `hsl(${c.hue} 70% 55%)`;
      const tile = h("div.tile", { draggable: "true", dataset: { id: c.id, start: c.start }, title: c.tags.join(", ") },
        h("div.tile-frame", { style: `aspect-ratio:${ar}` },
          h("img", { loading: "lazy", draggable: "false", alt: "", src: thumbUrl(c.id) }),
          h("span.tile-rank", `${r}`),
          h("span.tile-score", String(Math.round(s * 100))),
          h("button.use-btn", { dataset: { use: c.id }, title: "Put this clip in the selected cut", "aria-label": "Use this clip in the selected cut" },
            h("span", { html: icons.swap }), h("span.use-label", "Use clip"))),
        h("div.tile-meta",
          h("div.tile-bars",
            h("i.bar.w-colour", { title: `Colour ${Math.round(c.colour * 100)}`, style: `--v:${c.colour}` }),
            h("i.bar.w-motion", { title: `Motion ${Math.round(c.motion * 100)}`, style: `--v:${c.motion}` }),
            h("i.bar.w-strange", { title: `Strangeness ${Math.round(c.strange * 100)}`, style: `--v:${c.strange}` })),
          h("div.tile-row",
            h("span.tile-swatch", { style: `background:${sw}` }),
            h("span.tile-tc", fmtFilm(c.start).replace(/\.\d$/, "")))));
      if (c.id === selClip) tile.classList.add("is-current");
      frag.append(tile);
    }
    grid.replaceChildren(frag);
    count.textContent = `${picked.length} of ${S.clips.length} clips`;
    count.title = activeTags.size ? `${matching} clips match the chosen tags` : "";
    emptyEl.classList.toggle("is-hidden", picked.length > 0);
    more.classList.toggle("is-hidden", picked.length >= available);
  }

  // Hover, drag and the Use button are handled once for the whole grid.
  grid.addEventListener("mouseover", (e) => {
    const tile = e.target.closest(".tile");
    if (!tile || tile.contains(e.relatedTarget)) return;
    const c = S.clipById.get(tile.dataset.id);
    if (c) hoverIn(tile, c);
  });
  grid.addEventListener("mouseout", (e) => {
    const tile = e.target.closest(".tile");
    if (tile && !tile.contains(e.relatedTarget)) hoverOut();
  });
  grid.addEventListener("dragstart", (e) => {
    const tile = e.target.closest(".tile");
    if (!tile) return;
    hoverOut();
    e.dataTransfer.setData(CLIP_MIME, tile.dataset.id);
    e.dataTransfer.setData("text/plain", tile.dataset.id);
    e.dataTransfer.effectAllowed = "copy";
    const img = tile.querySelector("img");
    if (img?.complete) e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2);
    document.body.classList.add("is-dragging-clip");
  });
  grid.addEventListener("dragend", () => document.body.classList.remove("is-dragging-clip"));
  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-use]");
    const cut = selectedCut();
    if (btn && cut) actions.swapClip(cut.id, btn.dataset.use);
  });

  on("open", (p) => {
    W.colour = Math.round((p.settings.colour ?? 0.35) * 100);
    W.motion = Math.round((p.settings.motion ?? 0.3) * 100);
    W.strange = Math.round((p.settings.strange ?? 0.35) * 100);
    for (const k of ["colour", "motion", "strange"]) {
      sliders[k].el.value = W[k];
      sliders[k].out.textContent = W[k];
      paintRange(sliders[k].el);
    }
    want = PAGE * 2;
    vid.src = absUrl(p.library.proxy_url);
    buildTags();
    render();
    scroll.scrollTop = 0;
  });
  on("close", () => {
    hoverOut();
    vid.removeAttribute("src");
    vid.load();
    grid.replaceChildren();
  });
  on("selection", (cut) => {
    root.classList.toggle("has-selection", !!cut);
    grid.querySelector(".tile.is-current")?.classList.remove("is-current");
    if (cut) grid.querySelector(`.tile[data-id="${cut.clip}"]`)?.classList.add("is-current");
  });

  return { render, get video() { return vid; } };
}
