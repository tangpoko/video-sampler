// Everything the page asks the server goes through here. See docs/API.md for the contract.
//
// Real mode: requests go to /api on the server that served this page (engine/server.py).
// Mock mode: add ?mock=1 to the address. Requests are answered in memory by mock.js from the
// files in app/dev/fixtures/, so the page can be developed without the server.

export const MOCK = new URLSearchParams(location.search).has("mock");

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

let mockBackend = null;

async function call(method, path, body) {
  if (MOCK) {
    mockBackend ??= await import("./mock.js");
    return mockBackend.handle(method, path, body);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Cannot reach the server. Check that it is still running.");
  }
  let data = null;
  try { data = await res.json(); } catch { /* an empty or non-JSON answer */ }
  if (!res.ok) throw new ApiError(data?.error || `The server answered with error ${res.status}.`, res.status);
  return data;
}

const enc = encodeURIComponent;
const cut = (project, id) => `/projects/${enc(project)}/cuts/${enc(id)}`;

export const api = {
  libraries: () => call("GET", "/libraries"),
  addLibrary: (path) => call("POST", "/libraries", { path }),
  clips: (library) => call("GET", `/libraries/${enc(library)}/clips`),
  songs: () => call("GET", "/songs"),
  addSong: (path, snippet) => call("POST", "/songs", snippet ? { path, snippet: true } : { path }),
  projects: () => call("GET", "/projects"),
  createProject: (body) => call("POST", "/projects", body),
  project: (id) => call("GET", `/projects/${enc(id)}`),
  deleteProject: (id) => call("DELETE", `/projects/${enc(id)}`),
  job: (id) => call("GET", `/jobs/${enc(id)}`),

  deleteCut: (p, id) => call("POST", `${cut(p, id)}/delete`),
  splitCut: (p, id, beat) => call("POST", `${cut(p, id)}/split`, { beat }),
  moveStart: (p, id, beat) => call("POST", `${cut(p, id)}/move_start`, { beat }),
  swapClip: (p, id, clip) => call("POST", `${cut(p, id)}/clip`, { clip }),
  rerollCut: (p, id) => call("POST", `${cut(p, id)}/reroll`),
  patchCut: (p, id, body) => call("PATCH", cut(p, id), body),
  reroll: (p, seed) => call("POST", `/projects/${enc(p)}/reroll`, seed == null ? {} : { seed }),
  patchSettings: (p, body) => call("PATCH", `/projects/${enc(p)}/settings`, body),
  undo: (p) => call("POST", `/projects/${enc(p)}/undo`),
  redo: (p) => call("POST", `/projects/${enc(p)}/redo`),
  preview: (p) => call("GET", `/projects/${enc(p)}/preview`),
  exportVideo: (p, width) => call("POST", `/projects/${enc(p)}/export`, width ? { width } : {}),
};

/** Polls a job until it finishes. onProgress gets the job object about twice a second. */
export async function waitForJob(jobId, onProgress) {
  for (;;) {
    const job = await api.job(jobId);
    onProgress?.(job);
    if (job.status === "done") return job;
    if (job.status === "failed") throw new ApiError(job.message || "The job failed.");
    await new Promise((r) => setTimeout(r, 500));
  }
}
