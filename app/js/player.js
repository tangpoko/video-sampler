// Preview player. Plays preview.url, the edit with the song already in it.
// Two stacked video elements: when a new preview version is ready it loads in the hidden one,
// is seeked to where the visible one is, and the two trade places. The picture never goes
// black and the playhead and play state carry over.

import { h, fmtTime, range, paintRange, clamp } from "./util.js";
import { icons } from "./icons.js";

export function createPlayer(root) {
  const mkVideo = () => h("video.pv", { playsinline: true, preload: "auto", tabindex: "-1" });
  let active = mkVideo();
  let spare = mkVideo();
  active.classList.add("is-active");

  const empty = h("div.player-empty",
    h("div.spinner.lg"),
    h("div.empty-title", "Rendering the first preview"),
    h("div.empty-sub", "It will start playing here when it is ready."));
  const badge = h("div.player-badge", h("span.spinner"), h("span", "Updating preview"));
  const stage = h("div.player-stage", active, spare, empty, badge);
  const wrap = h("div.player-stage-wrap", stage);

  const playBtn = h("button.icon-btn.play-btn", { "aria-label": "Play", title: "Play or pause (Space)", html: icons.play });
  const timeNow = h("span.tc.now", "0:00.0");
  const timeDur = h("span.tc.dur", "0:00.0");
  const seekBar = range({ min: 0, max: 1000, step: 1, value: 0, "aria-label": "Seek", class: "range seek" });
  const muteBtn = h("button.icon-btn", { "aria-label": "Mute", title: "Mute", html: icons.volume });
  const volume = range({ min: 0, max: 100, step: 1, value: 100, "aria-label": "Volume", class: "range volume" });
  const bar = h("div.player-bar", playBtn,
    h("div.tc-group", timeNow, h("span.tc-sep", "/"), timeDur),
    seekBar, muteBtn, volume);
  root.append(wrap, bar);

  let aspect = 2.39;
  let duration = 0;
  let currentUrl = null;
  let loadToken = 0;
  let seeking = false;
  const timeListeners = [];
  const stateListeners = [];

  function fitStage() {
    // Room inside the wrap's padding.
    const cs = getComputedStyle(wrap);
    const w = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const hgt = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (w <= 0 || hgt <= 0) return;
    const width = Math.min(w, hgt * aspect);
    stage.style.width = `${Math.floor(width)}px`;
    stage.style.height = `${Math.floor(width / aspect)}px`;
  }
  new ResizeObserver(fitStage).observe(wrap);

  const time = () => active.currentTime || 0;
  const playing = () => !active.paused && !active.ended;

  function tick() {
    const t = time();
    timeNow.textContent = fmtTime(t);
    if (!seeking && duration) {
      seekBar.value = Math.round((t / duration) * 1000);
      paintRange(seekBar);
    }
    for (const fn of timeListeners) fn(t);
  }
  function loop() {
    tick();
    if (playing()) requestAnimationFrame(loop);
  }
  function syncState() {
    const on = playing();
    playBtn.innerHTML = on ? icons.pause : icons.play;
    playBtn.setAttribute("aria-label", on ? "Pause" : "Play");
    for (const fn of stateListeners) fn(on);
    if (on) requestAnimationFrame(loop);
  }

  for (const v of [active, spare]) {
    const mine = (fn) => (e) => { if (e.target === active) fn(e); };
    v.addEventListener("play", mine(syncState));
    v.addEventListener("pause", mine(syncState));
    v.addEventListener("ended", mine(syncState));
    v.addEventListener("timeupdate", mine(tick));
    v.addEventListener("seeked", mine(tick));
    v.addEventListener("loadedmetadata", mine(tick));
  }

  function seek(t) {
    if (!currentUrl) return;
    active.currentTime = clamp(t, 0, Math.max(0, (duration || active.duration || 0) - 0.02));
    tick();
  }
  function toggle() {
    if (!currentUrl) return;
    if (playing()) active.pause();
    else active.play().catch(() => {});
  }

  /** Point the player at a preview file. Ignores a URL it is already showing or loading. */
  function load(url) {
    if (!url || url === currentUrl) return;
    currentUrl = url;
    const token = ++loadToken;
    empty.classList.add("is-hidden");
    if (!active.currentSrc && !active.getAttribute("src")) {
      active.src = url;
      return;
    }
    const next = spare;
    next.muted = true;
    next.src = url;
    next.addEventListener("loadedmetadata", () => {
      if (token !== loadToken) return;
      next.addEventListener("seeked", () => {
        if (token !== loadToken) return;
        const wasPlaying = playing();
        const old = active;
        // The old one kept playing while the new one loaded, so line them up once more.
        if (Math.abs(next.currentTime - old.currentTime) > 0.04) next.currentTime = old.currentTime;
        next.muted = old.muted;
        next.volume = old.volume;
        active = next;
        spare = old;
        if (wasPlaying) next.play().catch(() => {});
        old.pause();
        next.classList.add("is-active");
        old.classList.remove("is-active");
        old.removeAttribute("src");
        old.load();
        syncState();
        tick();
      }, { once: true });
      next.currentTime = Math.min(active.currentTime, Math.max(0, next.duration - 0.05));
    }, { once: true });
  }

  playBtn.addEventListener("click", toggle);
  stage.addEventListener("click", toggle);
  seekBar.addEventListener("pointerdown", () => { seeking = true; });
  seekBar.addEventListener("input", () => seek((+seekBar.value / 1000) * duration));
  seekBar.addEventListener("change", () => { seeking = false; });
  seekBar.addEventListener("keydown", (e) => e.stopPropagation());
  volume.addEventListener("keydown", (e) => e.stopPropagation());
  function syncVolume() {
    const off = active.muted || active.volume === 0;
    muteBtn.innerHTML = off ? icons.mute : icons.volume;
    muteBtn.setAttribute("aria-label", off ? "Unmute" : "Mute");
  }
  muteBtn.addEventListener("click", () => { active.muted = !active.muted; syncVolume(); });
  volume.addEventListener("input", () => {
    active.volume = +volume.value / 100;
    active.muted = false;
    syncVolume();
  });

  return {
    get video() { return active; },
    get url() { return currentUrl; },
    time, playing, seek, toggle,
    fit: fitStage,
    onTime(fn) { timeListeners.push(fn); },
    onState(fn) { stateListeners.push(fn); },
    setProject(p) {
      aspect = p.library.aspect || 2.39;
      duration = p.song.duration;
      timeDur.textContent = fmtTime(duration);
      fitStage();
    },
    /** Called on every preview update, including each poll while rendering. */
    setPreview(pv) {
      badge.classList.toggle("is-on", pv.status === "rendering" && !!currentUrl);
      if (pv.url && pv.status === "ready") load(pv.url);
      else if (pv.url && !currentUrl) load(pv.url);
      if (!pv.url && !currentUrl) empty.classList.remove("is-hidden");
    },
    reset() {
      loadToken++;
      for (const v of [active, spare]) { v.pause(); v.removeAttribute("src"); v.load(); }
      currentUrl = null;
      empty.classList.add("is-hidden");
      badge.classList.remove("is-on");
      syncState();
      tick();
    },
  };
}
