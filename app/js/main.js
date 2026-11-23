// Boot: builds the top bar, wires the views together and owns the keyboard.

import { h, isTextField, range, paintRange } from "./util.js";
import { icons } from "./icons.js";
import { api, MOCK, waitForJob } from "./api.js";
import { toast } from "./toast.js";
import { S, on, actions, openProject, closeProject, select, selectNeighbour, selectedCut, cutAt } from "./state.js";
import { createPlayer } from "./player.js";
import { createTimeline } from "./timeline.js";
import { createCrate } from "./crate.js";
import { createInspector } from "./inspector.js";
import { createStart } from "./start.js";

const $ = (id) => document.getElementById(id);
const app = $("app");

// ---------- views ----------

const player = createPlayer($("player"));
const timeline = createTimeline($("timeline"), player);
const crate = createCrate($("crate"));
const inspector = createInspector($("inspector"), { splitAtPlayhead });
const start = createStart($("start"), { onOpen: open });

// ---------- top bar ----------

const backBtn = h("button.icon-btn", { "aria-label": "All projects", title: "All projects", html: icons.back, onclick: () => showStart() });
const nameEl = h("span.project-title");
const metaEl = h("span.project-meta");
const undoBtn = h("button.icon-btn", { "aria-label": "Undo", title: "Undo (Ctrl+Z)", html: icons.undo, onclick: () => actions.undo() });
const redoBtn = h("button.icon-btn", { "aria-label": "Redo", title: "Redo (Ctrl+Shift+Z)", html: icons.redo, onclick: () => actions.redo() });
const rerollBtn = h("button.btn.reroll-btn", { title: "Re-plan every cut that is not locked", onclick: () => actions.rerollAll() },
  h("span", { html: icons.reroll }), "Reroll");
const settingsBtn = h("button.btn.icon-only.settings-btn", { "aria-label": "Auto mode settings", title: "Auto mode settings", "aria-expanded": "false", html: icons.sliders });
const statusEl = h("div.status", { role: "status", "aria-live": "polite" });
const exportBtn = h("button.btn.primary.export-btn", { onclick: exportVideo }, h("span", { html: icons.export }), h("span.export-label", "Export"));
const popover = h("div.popover.is-hidden", { role: "dialog", "aria-label": "Auto mode settings" });

$("topbar").append(
  h("div.top-left", backBtn, nameEl, metaEl),
  h("div.top-mid", h("div.btn-pair", undoBtn, redoBtn), h("span.top-sep"),
    h("div.btn-group", rerollBtn, settingsBtn), popover),
  h("div.top-right", MOCK && h("span.mock-tag", { title: "Answers come from app/dev/fixtures, not the server" }, "Mock data"), statusEl, exportBtn));

const SETTINGS = [
  ["cut_speed", "Cut speed", "Slow", "Fast"],
  ["repetition", "Repetition", "Fresh clips", "Repeats"],
  ["effects", "Effects", "Clean", "Heavy"],
];
const settingSliders = SETTINGS.map(([key, label, lo, hi]) => {
  const out = h("output.slider-value");
  const el = range({ min: 0, max: 100, step: 1, value: 50, "aria-label": label });
  el.addEventListener("input", () => { out.textContent = el.value; });
  el.addEventListener("change", () => actions.patchSettings({ [key]: +el.value / 100 }));
  el.addEventListener("keydown", (e) => e.stopPropagation());
  popover.append(h("label.slider-cell", h("span.slider-row", h("span.slider-label", label), out), el,
    h("span.slider-ends", h("span", lo), h("span", hi))));
  return { key, el, out };
});
popover.append(h("div.popover-foot",
  h("span.slider-note", "Saved as you go. Reroll applies them to unlocked cuts."),
  h("button.btn.primary.sm", { onclick: () => { togglePopover(false); actions.rerollAll(); } }, "Reroll now")));

function togglePopover(show = popover.classList.contains("is-hidden")) {
  popover.classList.toggle("is-hidden", !show);
  settingsBtn.setAttribute("aria-expanded", String(show));
}
settingsBtn.addEventListener("click", (e) => { e.stopPropagation(); togglePopover(); });
document.addEventListener("pointerdown", (e) => {
  if (!popover.classList.contains("is-hidden") && !popover.contains(e.target) && !settingsBtn.contains(e.target)) togglePopover(false);
});

function renderTopbar() {
  const p = S.project;
  if (!p) return;
  nameEl.textContent = p.name;
  const unlocked = p.cuts.filter((c) => !c.locked).length;
  metaEl.textContent = `${p.song.name}, ${Math.round(p.song.tempo)} bpm`;
  undoBtn.disabled = !p.can_undo;
  redoBtn.disabled = !p.can_redo;
  rerollBtn.disabled = unlocked === 0;
  rerollBtn.title = unlocked === 0 ? "Every cut is locked, so there is nothing to reroll"
    : `Re-plan the ${unlocked} cuts that are not locked`;
  for (const s of settingSliders) {
    if (document.activeElement === s.el) continue;
    s.el.value = Math.round((p.settings[s.key] ?? 0.5) * 100);
    s.out.textContent = s.el.value;
    paintRange(s.el);
  }
  document.title = `${p.name} · Video Sampler`;
}

function renderStatus(pv) {
  const rendering = pv.status === "rendering";
  statusEl.classList.toggle("is-rendering", rendering);
  statusEl.replaceChildren(
    h(rendering ? "span.spinner" : "span.status-dot"),
    h("span.status-text", rendering
      ? (pv.pending > 0 ? `Rendering ${pv.pending} ${pv.pending === 1 ? "cut" : "cuts"}` : "Joining preview")
      : "Preview ready"));
  statusEl.dataset.status = pv.status;
}

let exporting = false;
async function exportVideo() {
  if (exporting || !S.project) return;
  exporting = true;
  const label = exportBtn.querySelector(".export-label");
  exportBtn.classList.add("is-busy");
  try {
    const { job } = await api.exportVideo(S.project.id);
    const done = await waitForJob(job, (j) => { label.textContent = `Exporting ${Math.round((j.progress || 0) * 100)}%`; });
    toast(`Export finished. Saved to ${done.result?.path || "the project's exports folder"}.`, "info", 9000);
  } catch (e) {
    toast(e.message, "error");
  } finally {
    exporting = false;
    label.textContent = "Export";
    exportBtn.classList.remove("is-busy");
  }
}

// ---------- state wiring ----------

on("open", (p) => {
  player.reset();
  player.setProject(p);
});
on("project", renderTopbar);
on("preview", (pv) => {
  renderStatus(pv);
  player.setPreview(pv);
});
on("close", () => player.reset());

function splitAtPlayhead() {
  const t = player.time();
  const cut = selectedCut() || cutAt(t);
  if (!cut) return;
  const beat = S.beat.snapHalf(t);
  if (t < cut.t0 || t >= cut.t1) {
    toast("Move the playhead inside the selected cut, then split.", "error");
  } else if (beat <= cut.beat0 || beat >= cut.beat0 + cut.beats) {
    toast(cut.beats <= 0.5 ? "A half-beat cut is too short to split." : "The playhead is on the edge of this cut. Move it further in, then split.", "error");
  } else {
    select(cut.id);
    actions.splitCut(cut.id, beat);
  }
}

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  if (!S.project || isTextField(e.target)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === "z") {
    e.preventDefault();
    return e.shiftKey ? actions.redo() : actions.undo();
  }
  if (mod && k === "y") { e.preventDefault(); return actions.redo(); }
  if (mod || e.altKey) return;
  const cut = selectedCut();
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) player.toggle();
    return;
  }
  if (k === "escape") { togglePopover(false); return select(null); }
  if (k === "arrowleft" || k === "arrowright") {
    e.preventDefault();
    selectNeighbour(k === "arrowleft" ? -1 : 1, player.time());
    return timeline.reveal(selectedCut());
  }
  if (e.repeat) return;
  if (k === "s") { e.preventDefault(); return splitAtPlayhead(); }
  if (!cut) return;
  if (k === "delete" || k === "backspace") { e.preventDefault(); actions.deleteCut(cut.id); }
  else if (k === "r") actions.rerollCut(cut.id);
  else if (k === "l") actions.patchCut(cut.id, { locked: !cut.locked });
});
// Space plays and pauses everywhere, so it must not also press whichever button has focus.
document.addEventListener("keyup", (e) => {
  if (e.code === "Space" && S.project && !isTextField(e.target)) e.preventDefault();
});

// ---------- which view is showing ----------

function showStart() {
  closeProject();
  app.dataset.view = "start";
  document.title = "Video Sampler";
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  start.refresh();
}

async function open(idOrProject) {
  app.dataset.view = "loading";
  try {
    await openProject(idOrProject);
    app.dataset.view = "editor";
    // The panels had no size while hidden, so measure them now instead of waiting for a frame.
    player.fit();
    timeline.refresh();
    history.replaceState(null, "", `#project=${encodeURIComponent(S.project.id)}`);
  } catch (e) {
    toast(e.message, "error");
    showStart();
  }
}

const wanted = new URLSearchParams(location.hash.slice(1)).get("project");
if (wanted) open(wanted); else showStart();

// For debugging from the console.
window.vs = { S, actions, player, timeline, crate, inspector, api, select };

// Typing or pasting an address with another project in it switches to that project.
window.addEventListener("hashchange", () => {
  const id = new URLSearchParams(location.hash.slice(1)).get("project");
  if (id && id !== S.project?.id) open(id);
  else if (!id && S.project) showStart();
});
