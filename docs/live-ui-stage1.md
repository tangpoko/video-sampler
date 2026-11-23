# Live player UI, stage 1: layout and look

Target design: the "Tape Deck, columns with favourites" mockup, `TapeDeckColumns2.dc.html`
(a canvas mockup in a templating format, not included in this repo; copy its CSS, materials, type,
colours and markup ideas, not its framework). Tang chose this on 15 Nov 2026.

## What stage 1 covers

Move the real live player (`app/live.html`, `app/js/live/main.js`, `app/css/live.css`) to the
new layout and look. Everything that works today keeps working. Not in stage 1: effect families
and variants, favourites stars, rollover previews in the monitors, Auto vibes, Autoclip, new
effects. Leave no fake controls for those: nothing on screen that does nothing.

## Layout (1440 x 900 design size, must work from 1280 x 720 up)

- Top bar: app name, a link back to the editor, the music strip (track, BPM, beat light, next
  track, opens the playlist), Full screen.
- Left column, about 300 px: deck A's effects as one scrolling list, grouped Shape, Colour,
  Time, Beat. Search box at the top (filters the list as you type). Each row: icon, name, key on
  the right, lit with the accent when on. Time effects are held (mouse down or key), Shift locks,
  as today. Effects with sliders have a chevron that opens the sliders under the row.
- Right column: deck B, mirrored.
- Centre: main picture (the WebGL canvas) at the top, as large as the centre allows, 16:9
  letterboxed in black. Below it: deck A monitor, mixer, deck B monitor.
  - Deck monitor: deck letter, video name, a small view of that deck's video (stage 1 may show the
    plain video without effects; label it "A in"), play/pause, a position bar, time, film sound on
    or off, speed, and a Load button. Load opens the existing video picker for that deck.
  - Mixer: BPM readout and beat light, crossfader A to B, blend mode, "Cut every N beats", "Swap
    top layer on beat", which layer is on top, and a Cutouts button that opens the existing
    brightness and colour key controls in a popover.
- The A/B channel switch goes away. Both decks are played at once.

## Keys

Each deck has its own keys, shown on its rows.
- Deck A: 1 2 3 4 5, Q W E R T, A S D F G, Z X C V B
- Deck B: 6 7 8 9 0, Y U I O P, H J K L ;, N M , . /
Map the existing 19 effects in their current group order (Shape, Colour, Time, Beat) onto these
rows. Global keys move to keys that are not taken: Space plays or pauses both decks, Enter is full
screen, Escape closes the picker or popovers, Backspace turns all effects off, `=` is next track,
`[` and `]` change the speed of both decks.

## Look

90s VCR / boombox: dark smoky plastic, chunky keys, green VFD readouts in VT323, Michroma for
printed labels (both Google Fonts, already used by the mockup). The accent colour is a CSS
variable `--acc`, default pink `#ff4fd8`; tints, glows and lit-key gradients use
`color-mix()` with it. Text contrast at least 4.5:1. No em dashes in UI text.

## Copy

"Load" on the deck button. Say "video", never "film", in UI text.
