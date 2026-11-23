// Start view: open a project, or make one in three steps (pick a film, pick a song, name it).

import { h, fmtTime } from "./util.js";
import { icons } from "./icons.js";
import { api, waitForJob } from "./api.js";
import { toast } from "./toast.js";

export function createStart(root, { onOpen }) {
  const data = { projects: null, libraries: null, songs: null };
  const form = { name: "", library: null, song: null, snippet: false, creating: false };

  const projectsEl = h("div.project-grid");
  const projectCount = h("span.section-note");
  const libsEl = h("div.pick-list");
  const songsEl = h("div.pick-list");
  const stepEls = [1, 2, 3].map((n) => h("span.step-n", String(n)));
  const summaryEl = h("dl.summary");
  const createNote = h("p.create-note");
  const nameInput = h("input.input", { type: "text", placeholder: "Name your edit", maxlength: 60, "aria-label": "Project name", spellcheck: "false" });
  const createBtn = h("button.btn.primary.lg.create-btn", { disabled: true }, "Create project");
  nameInput.addEventListener("input", () => { form.name = nameInput.value; syncCreate(); });
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") create(); });
  createBtn.addEventListener("click", create);

  const dateText = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";
  };
  const skeleton = (n, cls = "div.skeleton-row") => Array.from({ length: n }, () => h(cls));
  /**
   * A readable film title from a file name: "The.Neon.Demon.2016.1080p.BluRay.mkv" becomes
   * "The Neon Demon (2016)". A name with no year in it only loses its extension and separators.
   */
  const filmTitle = (file) => {
    const base = String(file || "").replace(/\.[a-z0-9]{2,4}$/i, "");
    const words = base.split(/[._]+|\s+/).filter(Boolean);
    const yearAt = words.findIndex((w, i) => i > 0 && /^\(?(19|20)\d\d\)?$/.test(w));
    if (yearAt > 0) return `${words.slice(0, yearAt).join(" ")} (${words[yearAt].replace(/[()]/g, "")})`;
    return words.join(" ") || String(file || "");
  };
  const filmName = (id) => { const l = data.libraries?.find((x) => x.id === id); return l ? filmTitle(l.film || l.id) : id; };
  const songName = (id) => { const x = data.songs?.find((y) => y.id === id); return x ? (x.name || x.id) : id; };
  const hours = (s) => {
    const m = Math.round(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  };

  /** A path box with an Add button and the job's progress bar under it. */
  function adder({ title, placeholder, label, start, done, extra }) {
    const input = h("input.input", { type: "text", placeholder, "aria-label": label, spellcheck: "false" });
    const btn = h("button.btn", "Add");
    const bar = h("div.progress", h("div.progress-fill"));
    const msg = h("div.progress-msg");
    const prog = h("div.adder-progress.is-hidden", bar, msg);
    const run = async () => {
      const path = input.value.trim().replace(/^"|"$/g, "");
      if (!path || btn.disabled) return;
      btn.disabled = input.disabled = true;
      prog.classList.remove("is-hidden");
      bar.firstChild.style.width = "0%";
      msg.textContent = "Starting";
      try {
        const { job } = await start(path);
        const finished = await waitForJob(job, (j) => {
          bar.firstChild.style.width = `${Math.round((j.progress || 0) * 100)}%`;
          msg.textContent = `${j.message || "Working"}, ${Math.round((j.progress || 0) * 100)}%`;
        });
        input.value = "";
        await done(finished.result);
      } catch (e) {
        toast(e.message, "error");
      } finally {
        btn.disabled = input.disabled = false;
        prog.classList.add("is-hidden");
      }
    };
    btn.addEventListener("click", run);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
    return h("div.adder", h("div.adder-title", title), h("div.adder-row", input, btn), extra, prog);
  }

  const snippetBox = h("input.check", { type: "checkbox", id: "snippet" });
  snippetBox.addEventListener("change", () => { form.snippet = snippetBox.checked; });

  const step = (i, title, ...kids) =>
    h("div.step", h("div.step-head", stepEls[i], h("h3.step-title", title)), ...kids);

  root.append(
    h("div.start-inner",
      h("header.start-head",
        h("span.brand-mark", { html: icons.play }),
        h("h1.brand-name", "Video Sampler"),
        h("p.start-tag", "One film, one song. The best clips, cut to the beat."),
        h("a.btn.sm.live-link", { href: "live.html", style: { marginTop: "6px", textDecoration: "none", display: "inline-flex", alignItems: "center" } }, "Open the live player")),
      h("section.start-section",
        h("div.section-head", h("h2", "Projects"), projectCount),
        projectsEl),
      h("section.start-section",
        h("div.section-head", h("h2", "New project"), h("span.section-note", "Three steps, then auto mode plans the first edit.")),
        h("div.steps",
          step(0, "Pick a film",
            libsEl,
            adder({ title: "Or add a film by file path", placeholder: "C:\\path\\to\\film.mkv", label: "Path to a film file",
              start: (path) => api.addLibrary(path),
              done: async (result) => { await loadLists(); if (result?.id) form.library = result.id; renderPickers(); toast("The film is ready.", "info"); } })),
          step(1, "Pick a song",
            songsEl,
            adder({ title: "Or add a song by file path", placeholder: "C:\\path\\to\\song.mp3", label: "Path to a song file",
              start: (path) => api.addSong(path, form.snippet),
              extra: h("label.check-row", { for: "snippet" }, snippetBox, h("span", "Long mix. Use its liveliest three minutes.")),
              done: async (result) => { await loadLists(); if (result?.id) form.song = result.id; renderPickers(); toast("The song is ready.", "info"); } })),
          step(2, "Name it",
            nameInput,
            summaryEl,
            h("div.create", createBtn, createNote))))));

  function syncCreate() {
    createBtn.disabled = form.creating || !form.name.trim() || !form.library || !form.song;
    createBtn.textContent = form.creating ? "Planning the edit" : "Create project";
    const done = [!!form.library, !!form.song, !!form.name.trim()];
    stepEls.forEach((el, i) => {
      el.classList.toggle("is-done", done[i]);
      if (done[i]) el.innerHTML = icons.check; else el.textContent = String(i + 1);
    });
    const line = (label, value) => [h("dt", label), h(value ? "dd" : "dd.is-missing", value || "Not picked yet")];
    summaryEl.replaceChildren(
      ...line("Film", form.library && filmName(form.library)),
      ...line("Song", form.song && songName(form.song)));
    createNote.textContent = form.creating ? "This takes a few seconds."
      : !form.library ? "Pick a film first."
      : !form.song ? "Pick a song next."
      : !form.name.trim() ? "Give it a name to finish."
      : "Auto mode cuts the film to the song. Every cut can be changed after.";
  }

  function renderProjects() {
    if (!data.projects) {
      projectCount.textContent = "";
      return projectsEl.replaceChildren(...skeleton(3, "div.skeleton-card"));
    }
    projectCount.textContent = data.projects.length ? String(data.projects.length) : "";
    projectsEl.dataset.count = Math.min(3, data.projects.length);
    if (!data.projects.length) {
      return projectsEl.replaceChildren(h("div.empty.projects-empty",
        h("div.empty-icon", { html: icons.film }),
        h("div.empty-title", "No projects yet"),
        h("div.empty-sub", "Pick a film and a song below to make the first one.")));
    }
    projectsEl.replaceChildren(...data.projects.map((p) =>
      h("button.project-card", { dataset: { id: p.id }, title: `Open ${p.name}`, onclick: () => onOpen(p.id) },
        h("span.project-thumb",
          p.thumb ? h("img", { alt: "", src: p.thumb, loading: "lazy" }) : h("span.project-nothumb", { html: icons.film }),
          h("span.project-open", h("span", { html: icons.play }), "Open")),
        h("span.project-text",
          h("span.project-name", p.name),
          h("span.project-line", h("span", { html: icons.film }), h("span.project-line-text", filmName(p.library) || "No film")),
          h("span.project-line", h("span", { html: icons.music }), h("span.project-line-text", songName(p.song) || "No song")),
          h("span.project-date", dateText(p.modified) && `Edited ${dateText(p.modified)}`),
          h("span.project-cta", h("span", { html: icons.play }), "Open project")))));
  }

  function pickRows(el, list, selected, onPick, line, emptyText, emptyIcon) {
    if (!list) return el.replaceChildren(...skeleton(2));
    if (!list.length) {
      return el.replaceChildren(h("div.pick-empty",
        h("span.pick-empty-icon", { html: emptyIcon }),
        h("span.pick-empty-text", h("span.pick-empty-title", emptyText[0]), h("span", emptyText[1]))));
    }
    el.replaceChildren(...list.map((item) =>
      h("button.pick-row", { "aria-pressed": String(item.id === selected), dataset: { id: item.id }, onclick: () => onPick(item.id) },
        ...line(item), h("span.radio"))));
  }

  function renderPickers() {
    pickRows(libsEl, data.libraries, form.library, (id) => { form.library = id; renderPickers(); },
      (l) => [
        h("span.pick-thumb", l.thumb && h("img", { alt: "", src: l.thumb, loading: "lazy" })),
        h("span.pick-text",
          h("span.pick-name", { title: l.film || l.id }, filmTitle(l.film || l.id)),
          h("span.pick-sub", `${hours(l.duration || 0)}, ${l.clips ?? 0} clips`))],
      ["No films yet", "Add one by file path below. Analysing a film takes several minutes."], icons.film);
    pickRows(songsEl, data.songs, form.song, (id) => { form.song = id; renderPickers(); },
      (s) => [
        h("span.pick-thumb.is-song", { html: icons.music }),
        h("span.pick-text",
          h("span.pick-name", { title: s.name || s.id }, s.name || s.id),
          h("span.pick-sub", `${fmtTime(s.duration || 0, false)}, ${Math.round(s.tempo || 0)} bpm`))],
      ["No songs yet", "Add one by file path below."], icons.music);
    syncCreate();
  }

  async function loadLists() {
    const [libraries, songs] = await Promise.all([api.libraries(), api.songs()]);
    data.libraries = libraries;
    data.songs = songs;
    if (!form.library && libraries.length === 1) form.library = libraries[0].id;
    if (!form.song && songs.length === 1) form.song = songs[0].id;
  }

  async function create() {
    if (createBtn.disabled) return;
    form.creating = true;
    syncCreate();
    try {
      const project = await api.createProject({ name: form.name.trim(), library: form.library, song: form.song });
      nameInput.value = form.name = "";
      onOpen(project);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      form.creating = false;
      syncCreate();
    }
  }

  async function refresh() {
    renderProjects();
    renderPickers();
    try {
      const [projects] = await Promise.all([api.projects(), loadLists()]);
      data.projects = projects;
    } catch (e) {
      data.projects ??= [];
      data.libraries ??= [];
      data.songs ??= [];
      toast(e.message, "error");
    }
    renderProjects();
    renderPickers();
  }

  return { refresh };
}
