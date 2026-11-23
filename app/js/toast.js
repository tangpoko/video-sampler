import { h } from "./util.js";
import { icons } from "./icons.js";

let host;

/**
 * Where the stack sits: bottom right. In the editor that is the right column, just above the
 * inspector, so a message never covers the picture, the timeline or the inspector's controls.
 * On the start view there is no inspector, so it sits in the window's bottom right corner.
 */
function place() {
  const insp = document.getElementById("inspector");
  const rect = insp?.getBoundingClientRect();
  const visible = !!rect && rect.height > 0;
  host.style.bottom = `${(visible ? window.innerHeight - rect.top : 4) + 12}px`;
  host.style.maxWidth = visible ? `${Math.max(240, rect.width - 24)}px` : "";
}

function setUp() {
  host = document.getElementById("toasts");
  const insp = document.getElementById("inspector");
  const again = () => { if (host.children.length) place(); };
  if (insp && "ResizeObserver" in window) new ResizeObserver(again).observe(insp);
  window.addEventListener("resize", again);
}

/** Small message in the bottom right corner. Never blocks the interface. */
export function toast(message, kind = "info", ms = 4200, action = null) {
  if (!host) setUp();
  place();
  const text = h("span.toast-text", String(message));
  // An optional button, { label, onclick }, between the message and the close button.
  const act = action ? h("button.toast-act", { type: "button", onclick: () => { action.onclick(); close(); } }, action.label) : null;
  const el = h(`div.toast.${kind}`, { role: kind === "error" ? "alert" : "status" },
    h("span.toast-icon", { html: kind === "error" ? icons.alert : icons.check }),
    text, act,
    h("button.icon-btn.sm", { "aria-label": "Dismiss", html: icons.close, onclick: () => close() }));
  host.append(el);
  while (host.children.length > 3) host.firstChild.remove();
  requestAnimationFrame(() => el.classList.add("in"));
  let timer = ms ? setTimeout(() => close(), ms) : null;
  function close() {
    clearTimeout(timer);
    el.classList.remove("in");
    setTimeout(() => el.remove(), 180);
  }
  return { close, update(msg) { text.textContent = msg; } };
}
