// Inline SVG icons on a 16 px grid, drawn with the current text colour.
const wrap = (body, fill) =>
  `<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="${fill ? "currentColor" : "none"}" stroke="${fill ? "none" : "currentColor"}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const icons = {
  play: wrap('<path d="M4.5 2.8v10.4a.5.5 0 0 0 .76.43l8.4-5.2a.5.5 0 0 0 0-.86l-8.4-5.2a.5.5 0 0 0-.76.43z"/>', true),
  pause: wrap('<rect x="3.5" y="2.5" width="3.2" height="11" rx="0.8"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="0.8"/>', true),
  undo: wrap('<path d="M5.5 3.5 3 6l2.5 2.5"/><path d="M3 6h6.2a3.6 3.6 0 0 1 0 7.2H6.5"/>'),
  redo: wrap('<path d="M10.5 3.5 13 6l-2.5 2.5"/><path d="M13 6H6.8a3.6 3.6 0 0 0 0 7.2h2.7"/>'),
  reroll: wrap('<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.75"/><path d="M13.3 2.3v3.2h-3.2"/>'),
  lock: wrap('<rect x="3.5" y="7.2" width="9" height="6.3" rx="1.4"/><path d="M5.5 7.2V5.3a2.5 2.5 0 0 1 5 0v1.9"/>'),
  unlock: wrap('<rect x="3.5" y="7.2" width="9" height="6.3" rx="1.4"/><path d="M5.5 7.2V5.3a2.5 2.5 0 0 1 4.7-1.2"/>'),
  split: wrap('<path d="M8 2v12"/><path d="M5 5.5 2.5 8 5 10.5"/><path d="M11 5.5 13.5 8 11 10.5"/>'),
  trash: wrap('<path d="M2.8 4.5h10.4"/><path d="M6.2 4.5V3h3.6v1.5"/><path d="m4.3 4.5.6 8.2a.9.9 0 0 0 .9.8h4.4a.9.9 0 0 0 .9-.8l.6-8.2"/>'),
  export: wrap('<path d="M8 2.5v7.6"/><path d="M5 7.3 8 10.3l3-3"/><path d="M3 13.2h10"/>'),
  check: wrap('<path d="m3.5 8.4 3 3 6-6.6"/>'),
  plus: wrap('<path d="M8 3.2v9.6M3.2 8h9.6"/>'),
  minus: wrap('<path d="M3.2 8h9.6"/>'),
  back: wrap('<path d="M9.8 3.5 5.3 8l4.5 4.5"/>'),
  chevron: wrap('<path d="m4 6 4 4 4-4"/>'),
  sliders: wrap('<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/>'),
  volume: wrap('<path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z"/><path d="M10.5 6a2.8 2.8 0 0 1 0 4M12.2 4.2a5.3 5.3 0 0 1 0 7.6"/>'),
  mute: wrap('<path d="M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5z"/><path d="m10.8 6.3 3 3.4M13.8 6.3l-3 3.4"/>'),
  fx: wrap('<path d="M8 1.8 9.5 6.5 14.2 8 9.5 9.5 8 14.2 6.5 9.5 1.8 8l4.7-1.5z"/>', true),
  film: wrap('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5.5 2.5v11M10.5 2.5v11M2.5 8h11M2.5 5.2h3M2.5 10.8h3M10.5 5.2h3M10.5 10.8h3"/>'),
  music: wrap('<path d="M6 12V3.5l7-1.3v8.3"/><circle cx="4.3" cy="12" r="1.7"/><circle cx="11.3" cy="10.5" r="1.7"/>'),
  close: wrap('<path d="m4 4 8 8M12 4l-8 8"/>'),
  swap: wrap('<path d="M2.5 5.5h10M10 3l2.5 2.5L10 8"/><path d="M13.5 10.5h-10M6 8l-2.5 2.5L6 13"/>'),
  fit: wrap('<path d="M2.5 3v10M13.5 3v10"/><path d="M5 8h6M6.8 6 5 8l1.8 2M9.2 6 11 8l-1.8 2"/>'),
  cursor: wrap('<path d="M4 2.5v10l2.7-2.4 1.7 3.6 1.6-.8-1.7-3.5H12z"/>'),
  alert: wrap('<path d="M8 2.2 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>'),
};
