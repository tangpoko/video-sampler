// Stand-in for engine/server.py, used when the address has ?mock=1.
// Loads app/dev/fixtures/*.json (made by app/dev/make_fixture.py) and applies edits in memory
// in a simple way. The taste rules live in the real server. This only has to behave like the
// contract well enough to exercise the page.

import { ApiError } from "./api.js";
import { makeBeatMap, clamp } from "./util.js";

const FIXTURES = new URL("../dev/fixtures/", import.meta.url);
// Project folder as seen by the dev file server (engine/serve.py . --port 8771).
const ROOT = new URL("../../", import.meta.url).pathname;
const PREVIEW_FILE = "renders/neon-afterhours-3.mp4";

const db = { loaded: null, libraries: [], songs: [], projects: [], clips: null, base: null, open: new Map(), jobs: new Map() };

async function load() {
  db.loaded ??= (async () => {
    const get = async (name) => {
      const res = await fetch(new URL(name, FIXTURES));
      if (!res.ok) throw new ApiError(`Fixture ${name} is missing. Run app/dev/make_fixture.py first.`, 500);
      return res.json();
    };
    [db.libraries, db.songs, db.projects, db.clips, db.base] = await Promise.all(
      ["libraries.json", "songs.json", "projects.json", "clips.json", "project.json"].map(get));
  })();
  return db.loaded;
}

/** Contract URLs (/media/...) point at the dev file server's real files instead. */
function devUrl(u) {
  if (typeof u !== "string") return u;
  let m;
  if ((m = u.match(/^\/media\/library\/(.+)$/))) return `${ROOT}library/${m[1]}`;
  if ((m = u.match(/^\/media\/preview\/[^/]+\/(\d+)\.mp4$/))) return `${ROOT}${PREVIEW_FILE}?v=${m[1]}`;
  if ((m = u.match(/^\/media\/song\/(.+)$/))) return `${ROOT}songs/${m[1]}.wav`;
  return u;
}

function publish(p) {
  const out = structuredClone({
    id: p.id, name: p.name, version: p.version,
    can_undo: p.undo.length > 0, can_redo: p.redo.length > 0,
    library: p.library, song: p.song, settings: p.settings, seed: p.seed,
    effects_available: p.effects_available, cuts: p.cuts, preview: p.preview,
  });
  out.library.proxy_url = devUrl(out.library.proxy_url);
  out.library.thumb_url = devUrl(out.library.thumb_url);
  out.song.url = devUrl(out.song.url);
  out.preview.url = devUrl(out.preview.url);
  return out;
}

function openProject(id) {
  if (db.open.has(id)) return db.open.get(id);
  const entry = db.projects.find((x) => x.id === id);
  if (!entry) throw new ApiError(`There is no project called ${id}.`, 404);
  const p = structuredClone(db.base);
  Object.assign(p, { id, name: entry.name, undo: [], redo: [], timer: null });
  p.preview.url = `/media/preview/${id}/${p.preview.version}.mp4`;
  p.beat = makeBeatMap(p.song);
  db.open.set(id, p);
  return p;
}

const fail = (msg, status = 400) => { throw new ApiError(msg, status); };
const newId = (p) => {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 6);
    if (id.length === 4 && !p.cuts.some((c) => c.id === id)) return id;
  }
};
const clipOf = (id) => db.clips.clips.find((c) => c.id === id);

function find(p, cutId) {
  const i = p.cuts.findIndex((c) => c.id === cutId);
  if (i < 0) fail("That cut no longer exists.", 404);
  return i;
}

/** Start point and speed so the clip fills a cut of the given length. */
function fit(clip, dur) {
  const span = clip.shot_end - clip.shot_start;
  const speed = span >= dur ? 1 : clamp(span / dur, 0.25, 2);
  const need = dur * speed;
  const src = clamp(clip.start, clip.shot_start, Math.max(clip.shot_start, clip.shot_end - need));
  return { src: +src.toFixed(3), speed: +speed.toFixed(3) };
}

function ranked(p) {
  const { colour: wc, motion: wm, strange: ws } = p.settings;
  const tot = wc + wm + ws || 1;
  return db.clips.clips
    .map((c) => ({ c, s: c.quality * (wc * c.colour + wm * c.motion + ws * c.strange) / tot }))
    .sort((a, b) => b.s - a.s).slice(0, 300).map((x) => x.c);
}

function autoPick(p, cut, pool) {
  let clip;
  do { clip = pool[Math.floor(Math.random() * pool.length)]; } while (clip.id === cut.clip && pool.length > 1);
  const fx = p.effects_available.filter((e) => (p.settings.fx_weights?.[e.id] ?? 1) > 0);
  const effects = [];
  if (Math.random() < p.settings.effects) {
    const pic = fx.filter((e) => e.kind === "picture");
    effects.push(pic[Math.floor(Math.random() * pic.length)].id);
    if (Math.random() < 0.35) {
      const time = fx.filter((e) => e.kind === "time");
      effects.push(time[Math.floor(Math.random() * time.length)].id);
    }
  }
  Object.assign(cut, { clip: clip.id, effects }, fit(clip, cut.t1 - cut.t0));
}

/** After an edit: bump the version and pretend to render the changed cuts for a moment. */
function commit(p, changed) {
  p.version += 1;
  clearInterval(p.timer);
  p.preview.status = "rendering";
  p.preview.pending = (p.preview.pending || 0) + Math.max(1, changed);
  const step = Math.max(1, Math.ceil(p.preview.pending / 3));
  p.timer = setInterval(() => {
    p.preview.pending = Math.max(0, p.preview.pending - step);
    if (p.preview.pending === 0) {
      clearInterval(p.timer);
      p.preview = { version: p.version, status: "ready", pending: 0, url: `/media/preview/${p.id}/${p.version}.mp4` };
    }
  }, 450);
}

function snapshot(p) {
  return structuredClone({ cuts: p.cuts, settings: p.settings, seed: p.seed });
}

function edit(p, fn) {
  const before = snapshot(p);
  const changed = fn();
  p.undo.push(before);
  p.redo.length = 0;
  commit(p, changed ?? 1);
  return publish(p);
}

function restore(p, from, to) {
  if (!from.length) fail(from === p.undo ? "Nothing to undo." : "Nothing to redo.");
  to.push(snapshot(p));
  Object.assign(p, from.pop());
  commit(p, 1);
  return publish(p);
}

function cutAction(p, cutId, action, body = {}) {
  const i = find(p, cutId);
  const cut = p.cuts[i];
  const end = cut.beat0 + cut.beats;

  if (action === "delete") {
    if (p.cuts.length < 2) fail("The last cut cannot be deleted.");
    return edit(p, () => {
      p.cuts.splice(i, 1);
      if (i > 0) {
        const prev = p.cuts[i - 1];
        prev.t1 = cut.t1;
        prev.beats += cut.beats;
      } else {
        const next = p.cuts[0];
        next.t0 = cut.t0;
        next.beat0 = cut.beat0;
        next.beats += cut.beats;
      }
    });
  }

  if (action === "split") {
    const beat = +body.beat;
    if (!(beat > cut.beat0 && beat < end)) fail("The split point has to be inside the cut, not on its edge.");
    return edit(p, () => {
      const t = +p.beat.time(beat).toFixed(3);
      const second = {
        ...structuredClone(cut), id: newId(p), t0: t, beat0: beat, beats: end - beat,
        src: +(cut.src + (t - cut.t0) * cut.speed).toFixed(3), locked: true,
      };
      Object.assign(cut, { t1: t, beats: beat - cut.beat0, locked: true });
      p.cuts.splice(i + 1, 0, second);
      return 2;
    });
  }

  if (action === "move_start") {
    if (i === 0) fail("The first cut starts at the beginning of the song and cannot move.");
    const prev = p.cuts[i - 1];
    const beat = +body.beat;
    if (!(beat > prev.beat0 && beat < end)) fail("The cut point has to stay between the cut before it and the end of this cut.");
    return edit(p, () => {
      const t = +p.beat.time(beat).toFixed(3);
      Object.assign(prev, { t1: t, beats: beat - prev.beat0 });
      Object.assign(cut, { t0: t, beat0: beat, beats: end - beat, locked: true });
      return 2;
    });
  }

  if (action === "clip") {
    const clip = clipOf(body.clip);
    if (!clip) fail("That clip is not in this film's crate.", 404);
    return edit(p, () => { Object.assign(cut, { clip: clip.id, locked: true }, fit(clip, cut.t1 - cut.t0)); });
  }

  if (action === "reroll") {
    return edit(p, () => { autoPick(p, cut, ranked(p)); });
  }

  if (action === "patch") {
    return edit(p, () => {
      const clip = clipOf(cut.clip);
      const keys = Object.keys(body);
      if ("speed" in body) cut.speed = +clamp(+body.speed, 0.25, 2).toFixed(3);
      if ("src" in body || "speed" in body) {
        const need = (cut.t1 - cut.t0) * cut.speed;
        const want = "src" in body ? +body.src : cut.src;
        cut.src = +clamp(want, clip.shot_start, Math.max(clip.shot_start, clip.shot_end - need)).toFixed(3);
      }
      if ("effects" in body) {
        const known = new Set(p.effects_available.map((e) => e.id));
        cut.effects = body.effects.filter((e) => known.has(e));
      }
      if ("locked" in body) cut.locked = !!body.locked;
      if (!(keys.length === 1 && keys[0] === "locked")) cut.locked = true;
    });
  }
  fail("Unknown edit.", 404);
}

function startJob(seconds, messages, finish) {
  const id = `job-${Math.random().toString(36).slice(2, 8)}`;
  db.jobs.set(id, { t0: performance.now(), seconds, messages, finish, result: undefined });
  return { job: id };
}

function readJob(id) {
  const j = db.jobs.get(id);
  if (!j) fail("That job is not known.", 404);
  const progress = clamp((performance.now() - j.t0) / (j.seconds * 1000), 0, 1);
  if (progress < 1) {
    const message = j.messages[Math.min(j.messages.length - 1, Math.floor(progress * j.messages.length))];
    return { status: "running", progress: +progress.toFixed(3), message };
  }
  if (j.result === undefined) j.result = j.finish();
  return { status: "done", progress: 1, message: "Done", result: j.result };
}

const baseName = (path) => String(path).split(/[\\/]/).pop() || "";
const slug = (s) => s.toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";

function route(method, path, body) {
  let m;
  if (path === "/libraries" && method === "GET") {
    return db.libraries.map((l) => ({ ...l, thumb: devUrl(l.thumb) }));
  }
  if (path === "/libraries" && method === "POST") {
    if (!body?.path?.trim()) fail("Type the path to a film file first.");
    return startJob(4, ["Reading the film", "Scoring colour and motion", "Scoring strangeness", "Writing thumbnails"], () => {
      const id = slug(baseName(body.path));
      if (!db.libraries.some((l) => l.id === id)) db.libraries.push({ ...db.libraries[0], id, film: baseName(body.path) });
      return { id };
    });
  }
  if ((m = path.match(/^\/libraries\/([^/]+)\/clips$/)) && method === "GET") return structuredClone(db.clips);
  if (path === "/songs" && method === "GET") return structuredClone(db.songs);
  if (path === "/songs" && method === "POST") {
    if (!body?.path?.trim()) fail("Type the path to a song file first.");
    return startJob(2.5, [body.snippet ? "Finding the liveliest stretch" : "Reading the song", "Finding beats and sections"], () => {
      const id = slug(baseName(body.path));
      if (!db.songs.some((s) => s.id === id)) db.songs.push({ ...db.songs[0], id, name: id });
      return { id };
    });
  }
  if (path === "/projects" && method === "GET") {
    return db.projects.map((x) => ({ ...x, thumb: devUrl(x.thumb) }));
  }
  if (path === "/projects" && method === "POST") {
    if (!body?.name?.trim()) fail("Give the project a name.");
    if (!db.libraries.some((l) => l.id === body.library)) fail("Pick a film.");
    if (!db.songs.some((s) => s.id === body.song)) fail("Pick a song.");
    let id = slug(body.name);
    while (db.projects.some((x) => x.id === id)) id += "-2";
    db.projects.unshift({ id, name: body.name.trim(), library: body.library, song: body.song,
      modified: new Date().toISOString().slice(0, 19), thumb: db.projects[0]?.thumb ?? db.libraries[0].thumb });
    return publish(openProject(id));
  }
  if ((m = path.match(/^\/jobs\/([^/]+)$/)) && method === "GET") return readJob(m[1]);

  if ((m = path.match(/^\/projects\/([^/]+)(\/.*)?$/))) {
    const id = decodeURIComponent(m[1]);
    const rest = m[2] || "";
    if (rest === "" && method === "DELETE") {
      db.projects = db.projects.filter((x) => x.id !== id);
      db.open.delete(id);
      return { ok: true };
    }
    const p = openProject(id);
    if (rest === "" && method === "GET") return publish(p);
    if (rest === "/preview" && method === "GET") return { ...p.preview, url: devUrl(p.preview.url) };
    if (rest === "/undo" && method === "POST") return restore(p, p.undo, p.redo);
    if (rest === "/redo" && method === "POST") return restore(p, p.redo, p.undo);
    if (rest === "/reroll" && method === "POST") {
      return edit(p, () => {
        p.seed = body?.seed ?? p.seed + 1;
        const pool = ranked(p);
        const open = p.cuts.filter((c) => !c.locked);
        open.forEach((c) => autoPick(p, c, pool));
        return open.length;
      });
    }
    if (rest === "/settings" && method === "PATCH") {
      // Saved, but not an edit to the picture: no undo step and nothing to render.
      Object.assign(p.settings, body || {});
      p.version += 1;
      if (p.preview.status === "ready") p.preview.version = p.version;
      return publish(p);
    }
    if (rest === "/export" && method === "POST") {
      return startJob(5, ["Rendering cuts from the original film", "Joining cuts", "Adding the song"], () => ({
        path: `projects/${id}/exports/${id}-v${p.version}.mp4`, url: `${ROOT}${PREVIEW_FILE}`,
      }));
    }
    if ((m = rest.match(/^\/cuts\/([^/]+)(?:\/(delete|split|move_start|clip|reroll))?$/))) {
      const action = m[2] || (method === "PATCH" ? "patch" : null);
      if (action && (method === "POST") === (action !== "patch")) return cutAction(p, decodeURIComponent(m[1]), action, body);
    }
  }
  fail(`The mock server has no answer for ${method} ${path}.`, 404);
}

export async function handle(method, path, body) {
  await load();
  await new Promise((r) => setTimeout(r, 40));   // a little latency, like a real request
  return route(method, path, body);
}
