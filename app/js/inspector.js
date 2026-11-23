// Inspector: everything about the selected cut, and the hand adjustments to it.
// Start point and speed send their PATCH when the slider is released, not while it moves.

import { h, fmtFilm, fmtBeats, fmtTime, range, paintRange, clamp, absUrl } from "./util.js";
import { icons } from "./icons.js";
import { S, on, actions, selectedCut, thumbUrl } from "./state.js";

export function createInspector(root, { splitAtPlayhead }) {
  // A muted copy of the proxy film, shown over the thumbnail while the start point slider moves,
  // so the user can see the frame they are choosing before anything is rendered.
  const scrub = h("video.insp-scrub", { playsinline: true, preload: "metadata" });
  scrub.muted = true;
  let scrubWant = null;
  scrub.addEventListener("seeked", () => {
    if (scrubWant != null && Math.abs(scrub.currentTime - scrubWant) > 0.05) scrub.currentTime = scrubWant;
  });
  function scrubTo(t) {
    scrubWant = t;
    scrub.classList.add("is-on");
    if (scrub.readyState >= 1) { if (!scrub.seeking) scrub.currentTime = t; }
    else scrub.addEventListener("loadedmetadata", () => { scrub.currentTime = scrubWant; }, { once: true });
  }

  const key = (k) => ({ dataset: { key: k } });

  function renderEmpty() {
    const row = (keys, text) => h("div.hint-row", h("span.hint-keys", keys.map((k) => h("kbd", k))), h("span", text));
    root.replaceChildren(
      h("div.panel-head", h("span.panel-title", "Inspector")),
      h("div.insp-empty",
        h("div.empty-icon", { html: icons.cursor }),
        h("div.empty-title", "No cut selected"),
        h("div.empty-sub", "Click a cut on the timeline to edit it."),
        h("div.hints",
          row(["Space"], "Play or pause"),
          row(["←", "→"], "Previous or next cut"),
          row(["R"], "Reroll the cut"),
          row(["L"], "Lock or unlock"),
          row(["S"], "Split at the playhead"),
          row(["Del"], "Delete the cut"))));
  }

  function render() {
    const p = S.project;
    const cut = selectedCut();
    if (!p) return root.replaceChildren();
    if (!cut) return renderEmpty();
    const focusKey = root.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    const clip = S.clipById.get(cut.clip);
    const dur = cut.t1 - cut.t0;
    const index = p.cuts.indexOf(cut);

    // ----- header: thumbnail and facts -----
    const lockBtn = h("button.btn.sm.ghost.lock-btn", { ...key("lock"), "aria-pressed": String(cut.locked),
      title: "Locked cuts are left alone by Reroll (L)",
      onclick: () => actions.patchCut(cut.id, { locked: !cut.locked }) },
      h("span", { html: cut.locked ? icons.lock : icons.unlock }), cut.locked ? "Locked" : "Lock");
    scrub.classList.remove("is-on");
    const header = h("div.insp-header",
      h("div.insp-thumb", { style: `aspect-ratio:${p.library.aspect || 2.39}` },
        h("img", { alt: "", src: thumbUrl(cut.clip) }), scrub),
      h("div.insp-facts",
        h("div.insp-id", h("span.insp-clip", { title: "Clip in the crate" }, cut.clip),
          h("span.insp-pos", `Cut ${index + 1} of ${p.cuts.length}, section ${cut.label}`)),
        h("dl.facts",
          h("dt", "Length"), h("dd.tc.insp-length", `${fmtBeats(cut.beats)}, ${dur.toFixed(2)} s`),
          h("dt", "Song"), h("dd.tc", `${fmtTime(cut.t0)} to ${fmtTime(cut.t1)}`))));

    // ----- start point and speed -----
    // The clip may start anywhere in its shot, as long as the needed length still fits before
    // the shot ends. Needed length is the cut's length times the speed.
    const filmOut = h("output.slider-value.tc", fmtFilm(cut.src));
    const speedOut = h("output.slider-value.tc", `${cut.speed.toFixed(2)}x`);
    const srcMax = (speed) => (clip ? clip.shot_end - dur * speed : cut.src);
    const srcSlider = range({ ...key("src"), min: clip ? clip.shot_start : cut.src, max: Math.max(clip ? clip.shot_start : cut.src, srcMax(cut.speed)),
      step: 0.001, value: cut.src, "aria-label": "Start point", class: "range src-slider" });
    const noRoom = !clip || srcMax(cut.speed) - clip.shot_start < 0.02;
    srcSlider.disabled = noRoom;
    const noRoomText = "The shot is only just long enough, so the start cannot move.";
    const noteEl = h("div.slider-note");
    const setNote = (text) => { noteEl.textContent = text; noteEl.classList.toggle("is-hidden", !text); };
    if (clip) srcSlider.title = `The shot runs ${fmtFilm(clip.shot_start)} to ${fmtFilm(clip.shot_end)}`;
    let wantSrc = cut.src;   // where the user put the start, before any speed limit pulled it back
    srcSlider.addEventListener("input", () => {
      wantSrc = +srcSlider.value;
      filmOut.textContent = fmtFilm(+srcSlider.value);
      scrubTo(+srcSlider.value);
    });
    srcSlider.addEventListener("change", () => {
      if (Math.abs(+srcSlider.value - cut.src) > 0.004) actions.patchCut(cut.id, { src: +(+srcSlider.value).toFixed(3) });
    });
    const speedSlider = range({ ...key("speed"), min: 0.25, max: 2, step: 0.05, value: cut.speed, "aria-label": "Speed", class: "range speed-slider" });
    // A faster cut uses more of the shot, so the latest possible start moves earlier. The start
    // slider follows while the speed slider is still being dragged, not only after release.
    speedSlider.addEventListener("input", () => {
      const speed = +speedSlider.value;
      speedOut.textContent = `${speed.toFixed(2)}x`;
      if (!clip) return;
      const max = Math.max(clip.shot_start, srcMax(speed));
      const room = max - clip.shot_start >= 0.02;
      srcSlider.max = max;
      srcSlider.value = Math.min(wantSrc, max);
      srcSlider.disabled = !room;
      paintRange(srcSlider);
      filmOut.textContent = fmtFilm(+srcSlider.value);
      setNote(room ? "" : noRoomText);
    });
    speedSlider.addEventListener("change", () => {
      if (Math.abs(+speedSlider.value - cut.speed) < 0.001) return;
      const body = { speed: +speedSlider.value };
      // If the new speed pushed the start point earlier, send that too.
      if (Math.abs(+srcSlider.value - cut.src) > 0.004) body.src = +(+srcSlider.value).toFixed(3);
      actions.patchCut(cut.id, body);
    });
    for (const el of [srcSlider, speedSlider]) el.addEventListener("keydown", (e) => e.stopPropagation());
    setNote(clip ? (noRoom ? noRoomText : "") : "This clip is not in the crate.");
    const slidersEl = h("div.insp-sliders",
      h("label.slider-line", h("span.slider-label", "Start point"), srcSlider, filmOut),
      noteEl,
      h("label.slider-line", h("span.slider-label", "Speed"), speedSlider, speedOut));

    // ----- effects -----
    const group = (kind, title) => {
      const list = p.effects_available.filter((e) => e.kind === kind);
      if (!list.length) return null;
      return h("div.fx-group", { dataset: { kind } },
        h("div.group-title", title),
        h("div.fx-chips", list.map((fx) => {
          const onNow = cut.effects.includes(fx.id);
          return h("button.chip.fx-chip", { ...key(`fx-${fx.id}`), dataset: { key: `fx-${fx.id}`, fx: fx.id }, "aria-pressed": String(onNow),
            onclick: () => actions.patchCut(cut.id, {
              effects: onNow ? cut.effects.filter((e) => e !== fx.id) : [...cut.effects, fx.id] }) }, fx.name);
        })));
    };
    const unknown = cut.effects.filter((e) => !p.effects_available.some((fx) => fx.id === e));
    const effectsEl = h("div.insp-effects", group("picture", "Picture"), group("time", "Time"),
      unknown.length > 0 && h("div.slider-note", `Also on this cut: ${unknown.join(", ")}`));

    // ----- actions -----
    const head = h("div.panel-head.insp-head", h("span.panel-title", "Inspector"),
      h("button.btn.sm.ghost", { ...key("reroll"), title: "Pick a different clip and effects for this cut (R)",
        onclick: () => actions.rerollCut(cut.id) }, h("span", { html: icons.reroll }), "Reroll"),
      h("button.btn.sm.ghost", { ...key("split"), title: "Split this cut at the playhead (S)",
        onclick: () => splitAtPlayhead() }, h("span", { html: icons.split }), "Split"),
      lockBtn,
      h("span.head-sep"),
      h("button.icon-btn.sm.danger", { ...key("delete"), "aria-label": "Delete this cut", title: "Delete this cut (Delete)",
        html: icons.trash, onclick: () => actions.deleteCut(cut.id) }));

    root.replaceChildren(head, h("div.insp-body", header, slidersEl, effectsEl));
    if (focusKey) root.querySelector(`[data-key="${focusKey}"]`)?.focus({ preventScroll: true });
  }

  on("open", (p) => { scrub.src = absUrl(p.library.proxy_url); });
  on("close", () => { scrub.removeAttribute("src"); scrub.load(); root.replaceChildren(); });
  on("project", render);
  on("selection", render);
  renderEmpty();
  return { render };
}
