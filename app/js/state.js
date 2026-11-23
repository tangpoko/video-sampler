// The one place that holds the open project. Every edit call returns the full updated Project,
// so an edit is: call the server, replace S.project with the answer, tell the views to redraw.

import { api } from "./api.js";
import { toast } from "./toast.js";
import { makeBeatMap } from "./util.js";

export const S = {
  project: null,
  clips: [],
  clipById: new Map(),
  tags: [],
  beat: null,          // beat grid helpers for the open song
  selectedId: null,
  busy: 0,             // edit calls still waiting for an answer
};

const listeners = {};
/** Events: "open", "close", "project", "selection", "preview", "busy". */
export function on(evt, fn) {
  (listeners[evt] ??= []).push(fn);
}
function emit(evt, arg) {
  for (const fn of listeners[evt] || []) fn(arg);
}

export const cutById = (id) => S.project?.cuts.find((c) => c.id === id) || null;
export const selectedCut = () => cutById(S.selectedId);
export const cutAt = (t) => {
  const cuts = S.project?.cuts || [];
  return cuts.find((c) => t >= c.t0 && t < c.t1) || cuts[cuts.length - 1] || null;
};
export const thumbUrl = (clipId) => S.project.library.thumb_url.replace("{clip}", clipId);

let selectedMid = 0;   // middle of the selected cut, to find its place again if its id goes away

export async function openProject(idOrProject) {
  const p = typeof idOrProject === "string" ? await api.project(idOrProject) : idOrProject;
  const lib = await api.clips(p.library.id);
  S.clips = lib.clips;
  S.tags = lib.tags || [];
  S.clipById = new Map(lib.clips.map((c) => [c.id, c]));
  S.selectedId = null;
  S.project = null;
  setProject(p, true);
}

export function closeProject() {
  clearTimeout(pollTimer);
  S.project = null;
  S.selectedId = null;
  emit("close");
}

function setProject(p, opening = false) {
  S.project = p;
  S.beat = makeBeatMap(p.song);
  if (S.selectedId && !cutById(S.selectedId)) {
    // The selected cut was deleted or re-planned. Select whatever now covers the same moment.
    S.selectedId = cutAt(selectedMid)?.id ?? null;
  }
  const sel = selectedCut();
  if (sel) selectedMid = (sel.t0 + sel.t1) / 2;
  if (opening) emit("open", p);
  emit("project", p);
  emit("selection", sel);
  emit("preview", p.preview);
  pollPreview();
}

export function select(id) {
  if (id === S.selectedId) return;
  S.selectedId = id && cutById(id) ? id : null;
  const sel = selectedCut();
  if (sel) selectedMid = (sel.t0 + sel.t1) / 2;
  emit("selection", sel);
}

export function selectNeighbour(step, fallbackTime = 0) {
  const cuts = S.project?.cuts || [];
  if (!cuts.length) return;
  let i = cuts.findIndex((c) => c.id === S.selectedId);
  i = i < 0 ? cuts.indexOf(cutAt(fallbackTime)) : Math.min(cuts.length - 1, Math.max(0, i + step));
  select(cuts[i].id);
}

// While the preview is rendering, ask for its state twice a second. The old preview keeps
// playing the whole time, nothing waits on this.
let pollTimer = null;
function pollPreview() {
  clearTimeout(pollTimer);
  const p = S.project;
  if (!p || p.preview.status !== "rendering") return;
  pollTimer = setTimeout(async () => {
    try {
      const pv = await api.preview(p.id);
      if (S.project === p) {
        p.preview = pv;
        emit("preview", pv);
      }
    } catch { /* try again on the next tick */ }
    pollPreview();
  }, 500);
}

// Edits are sent one after another so answers arrive in the order the user made them.
let chain = Promise.resolve();
function edit(fn) {
  const p = S.project;
  if (!p) return Promise.resolve(false);
  S.busy += 1;
  emit("busy", S.busy);
  const run = chain.then(async () => {
    try {
      const next = await fn(p.id);
      if (S.project && S.project.id === p.id) setProject(next);
      return true;
    } catch (e) {
      toast(e.message || "Something went wrong.", "error");
      return false;
    } finally {
      S.busy -= 1;
      emit("busy", S.busy);
    }
  });
  chain = run;
  return run;
}

export const actions = {
  deleteCut: (id) => edit((p) => api.deleteCut(p, id)),
  splitCut: (id, beat) => edit((p) => api.splitCut(p, id, beat)),
  moveStart: (id, beat) => edit((p) => api.moveStart(p, id, beat)),
  swapClip: (id, clip) => edit((p) => api.swapClip(p, id, clip)),
  rerollCut: (id) => edit((p) => api.rerollCut(p, id)),
  patchCut: (id, body) => edit((p) => api.patchCut(p, id, body)),
  rerollAll: () => edit((p) => api.reroll(p)),
  patchSettings: (body) => edit((p) => api.patchSettings(p, body)),
  undo: () => edit((p) => api.undo(p)),
  redo: () => edit((p) => api.redo(p)),
};
