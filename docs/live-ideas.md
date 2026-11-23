# Live player: ideas and inspiration

Notes from 14 and 15 Nov 2026. Nothing here is built yet unless it says so. Tang wants all of
the effects below.

## New effects (from the Eyecandy technique library, eyecannndy.com)

These work on a finished film. Camera techniques on that site (dolly, aerial and so on) do not.

Effects that use the recent-frames memory the player already keeps for stutter:

- **Slit-scan:** each row of the picture comes from a slightly different moment, so moving
  things stretch and bend.
- **Echo print:** three or four faded copies from a fraction of a second earlier, layered.
- **Step-print:** each frame held for a few frames, so motion goes choppy and dreamy.
- **Wigglegram:** flicks between two frames a moment apart, for a shaky fake-3D look.
- **Duplication or split screen:** a 2x2 or 3x3 grid, each copy a little behind the last.
- **Freeze frame:** hold to freeze.

New shader looks:

- **Thermal, night vision, x-ray:** brightness mapped to a heat palette, green night vision with
  grain, inverted blue x-ray.
- **Halation:** bright areas glow red-orange, like old film stock.
- **Fisheye and distortions:** lens bulge, ripple, wobble. Can pulse on the beat.
- **Ratio switch:** the black bars jump between widescreen, square and tall on the beat.
- **Datamosh:** one shot smears into the next as if the file were corrupted. A live fake is
  possible and is the biggest job on this list.

Cuts that use the analyser:

- **Crash cuts, quick cuts, jump cuts:** on the beat, jump to one of the analyser's top-scored
  clips. Must be optional: some people will want the film to just play, with no AI.

## Things worth borrowing from Visibox (spaceage.tv)

Visibox is stage playback software for bands. It triggers pre-made clips from a setlist. It does
not analyse footage, auto-edit to a song or detect beats from the audio.

- **Crossfades and layering two clips** (a Visibox user called crossfading the one thing missing).
  Built 15 Nov 2026 as channels A and B, see "Two channels" below.
- **Recording the output** to a video file, so a live jam becomes something to post.
- **Stream Deck and MIDI control,** the usual way performers avoid keyboard shortcuts.
- **A phone remote** to control it from across the room.
- **A separate output window** for a projector or second screen (also raised by our critic).

## Where to look for effect inspiration

From a Visibox guide on making visuals with AI-written code:

- **GLSL fragment shaders, Shadertoy (shadertoy.com):** the most useful for us, because the live
  player's effects are already GLSL fragment shaders. A Shadertoy effect can be adapted to run
  on the film directly.
- **p5.js:** 2D generative art. Particle systems, flow fields, geometric patterns, noise-based
  visuals. Good for overlays drawn on top of the film.
- **Three.js:** 3D. Rotating objects, depth, camera fly-throughs. Could map the film onto 3D
  shapes, such as a spinning cube or a tunnel.
- **Canvas API, CSS and SVG animation, GSAP:** simpler tools for overlays and timed sequences.

## Open questions being discussed

- **Effects panel layout.** The current list is too long for all these effects. Ideas so far:
  pads laid out like the keyboard, or buttons that each show a tiny live preview of the effect
  on the current frame. Tang asked whether keys should matter at all. Current thinking: the
  on-screen panel is the main way in, and keys are shortcuts shown small on each button.
- **What to call it.** "Video sampler" fits: stutter, back and forth and beat cuts are sampler
  moves. The live part could be its play mode next to auto-edit mode.
- **The pitch.** Load a film and a song, it looks great within seconds, then play on top as much
  or as little as you like.
- **AI is optional.** The analyser (CLIP running on the user's own graphics card, no Claude, no
  internet, no cost per use) only powers clip-finding. Without it the player still works on any
  film.

## Two channels (built 15 Nov 2026)

Two films play at once on channels A and B, each with its own effects. The Mix section of the
panel lays one over the other:

- Crossfader from A to B. Double-click centres it.
- Blend modes: normal, screen, add, multiply, difference, overlay, lighten, darken.
- On top: B over A, or A over B.
- Cutouts on the top layer: brightness key (cut the dark or the bright parts, level, soft edge) and
  colour key (pick the colour with the swatch or by clicking the picture, tolerance, soft edge).
  "Show cutout" shows what is kept as white and what is cut as black.
- On the beat, every N beats: cut between A and B (the crossfader jumps to the other side) or swap
  which layer is on top.
- The A / B switch (key G) decides which channel the effects panel, transport, Films and Open file
  act on. A dot on A or B means that channel has effects on.

Not built yet from the same idea: cutting out people (needs a segmentation model), shape wipes,
using one film as a stencil for the other.
