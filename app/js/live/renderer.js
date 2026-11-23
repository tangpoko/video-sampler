// The live player's picture. Two channels, A and B, each play a film through their own effects.
// A last pass mixes the two finished pictures onto the canvas. Nothing is rendered ahead of time.
//
// Passes, per screen refresh, for each channel that has a film:
//   1. source: the newest video frame, or a frame from the recent-frames ring while a time
//      effect (stutter, back and forth, reverse) is held.
//   2. fx: shape effects bend where each pixel reads from, then the colour effects run.
//   3. trails: mixes in the previous output, slightly zoomed, so movement leaves a smear.
// Then once:
//   4. mix: one channel is the bottom layer and the other the top. The top layer is blended in,
//      with a brightness or colour key cutting holes in it, and drawn letterboxed to the canvas.
//
// The picture takes channel A's shape (B's when only B has a film). A film of another shape is
// cropped to fill it, so nothing shows black edges under the other layer.
//
// Shape effects match render.py: "mirror" is the left half plus its mirror image, "quad" is the
// middle quarter of the frame mirrored four ways, and the kaleidoscope folds wedges around the
// centre the same way kaleido_maps does, with the source wedge up and to the right of centre.

const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  // One triangle that covers the whole screen.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FX = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_src;
uniform vec2 u_size;        // size in source pixels of the part of the film that is shown
uniform vec2 u_fit;         // how much of the film is shown on each axis (1 = all of it)
uniform float u_time;       // seconds since the page opened
uniform bool u_flip, u_upside, u_mirror, u_mirrorV, u_quad, u_kaleido, u_invert, u_hueOn;
uniform float u_wedges, u_spin, u_zoom, u_rgb, u_hueSpeed, u_vhs;
uniform float u_flash, u_hueJump;   // beat reactions: a white flash, and a hue step per beat
uniform float u_black, u_invHit;     // beat reactions: a blackout, and an invert hit, 0 to 1
uniform float u_hueAdd;             // a fixed hue turn in degrees (Hue, Shift)
uniform float u_fish;               // lens: above 0 bulges the middle out, below 0 pinches it in
uniform float u_ripple, u_rippleSize;   // ripple strength, and how wide its rings are (0 to 1)
uniform float u_poster;             // posterize: colour levels per channel, 0 is off
uniform float u_halo, u_haloThresh; // halation: glow strength, and how bright a part has to be to glow
uniform float u_neon;               // neon boost strength

const float PI = 3.14159265;

// From the picture's frame to the film's frame. A film of another shape is cropped to fill it.
vec2 fit(vec2 uv) { return 0.5 + (uv - 0.5) * u_fit; }

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec3 hueRotate(vec3 c, float deg, float sat) {
  // Rotate in YIQ, which keeps brightness steady while the colours turn.
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * c;
  float a = radians(deg);
  float ca = cos(a), sa = sin(a);
  yiq.yz = mat2(ca, sa, -sa, ca) * yiq.yz * sat;
  return toRGB * yiq;
}

void main() {
  vec2 uv = v_uv;

  // Shape. Each step says where this output pixel reads from, so they run last-applied first.
  // The lens effects bend the finished shape, so they come first here.
  vec2 asp = vec2(u_size.x / u_size.y, 1.0);   // so circles stay round on a wide picture
  if (u_fish != 0.0) {
    vec2 p = (uv - 0.5) * asp;
    float r2 = dot(p, p);
    // Reads spread out towards the edges. Dividing keeps the frame's edge roughly in place, so
    // the middle grows (bulge) or shrinks (pinch).
    p *= (1.0 + u_fish * r2) / (1.0 + u_fish * 0.3);
    uv = 0.5 + p / asp;
  }
  if (u_ripple > 0.0) {
    vec2 p = (uv - 0.5) * asp;
    float r = length(p);
    float rings = mix(60.0, 12.0, u_rippleSize);
    float w = sin(r * rings - u_time * 5.0) * u_ripple * 0.02;
    if (r > 0.0) uv += (p / r) * w / asp;
  }
  // Below 1 zooms out. Reads past the edge bounce back in, so the picture tiles as mirror images.
  if (u_zoom != 1.0) uv = 0.5 + (uv - 0.5) / u_zoom;
  if (u_kaleido) {
    vec2 p = (uv - 0.5) * u_size;
    float r = length(p);
    float seg = 2.0 * PI / u_wedges;
    float t = mod(atan(p.y, p.x) + u_spin * u_time, seg);
    if (t > seg * 0.5) t = seg - t;
    t = PI / 4.0 - t;                              // same wedge as kaleido_maps: 22.5 to 45 degrees above horizontal, right of centre
    uv = (0.5 * u_size + r * vec2(cos(t), sin(t) * 0.9)) / u_size;
  }
  if (u_quad) {
    vec2 c = vec2(uv.x < 0.5 ? 2.0 * uv.x : 2.0 - 2.0 * uv.x,
                  uv.y > 0.5 ? 2.0 * uv.y - 1.0 : 1.0 - 2.0 * uv.y);
    uv = 0.25 + 0.5 * c;
  }
  if (u_mirror && uv.x > 0.5) uv.x = 1.0 - uv.x;
  if (u_mirrorV && uv.y < 0.5) uv.y = 1.0 - uv.y;   // keeps the top half (uv.y 1 is the top)
  if (u_upside) uv.y = 1.0 - uv.y;
  if (u_flip) uv.x = 1.0 - uv.x;

  // VHS wobble: each pair of lines drifts sideways a little, and a tracking band rolls slowly
  // up the picture where the drift is much bigger.
  if (u_vhs > 0.0) {
    float line = floor(uv.y * u_size.y / 2.0);
    float band = smoothstep(0.06, 0.0, abs(fract(uv.y - u_time * 0.07) - 0.5));
    uv.x += (hash(vec2(line, floor(u_time * 30.0))) - 0.5) * u_vhs * (0.002 + band * 0.02);
  }

  // Colour channels read from slightly different spots: RGB split, and VHS chroma bleed.
  float dx = (u_rgb * u_size.x / 120.0 + u_vhs * u_size.x / 200.0) / u_size.x;
  float dy = u_rgb * (u_size.y / 160.0) / u_size.y;
  vec3 c = vec3(texture(u_src, fit(uv + vec2(dx, 0.0))).r,
                texture(u_src, fit(uv + vec2(0.0, dy))).g,
                texture(u_src, fit(uv - vec2(dx, 0.0))).b);

  // Halation: bright parts bleed a red-orange glow into their surroundings, like old film stock.
  // The glow is gathered from two rings of samples around this pixel.
  if (u_halo > 0.0) {
    vec3 glow = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      float a = float(i) * PI / 6.0;
      vec2 d = vec2(cos(a), sin(a)) / asp;
      for (int k = 1; k <= 2; k++) {
        vec3 s = texture(u_src, fit(uv + d * float(k) * 0.018)).rgb;
        glow += s * smoothstep(u_haloThresh, 1.0, dot(s, vec3(0.299, 0.587, 0.114)));
      }
    }
    glow /= 24.0;
    c += vec3(1.0, 0.32, 0.12) * dot(glow, vec3(0.333)) * u_halo * 3.0 + glow * u_halo * 0.5;
  }

  if (u_hueOn || u_hueJump != 0.0 || u_hueAdd != 0.0)
    c = hueRotate(c, (u_hueOn ? u_time * u_hueSpeed + 120.0 : 0.0) + u_hueJump + u_hueAdd, u_hueOn ? 1.4 : 1.0);

  // Neon boost: much stronger colour, deeper blacks and brighter brights.
  if (u_neon > 0.0) {
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 1.0 + 1.8 * u_neon);
    c = mix(c, smoothstep(0.1, 0.9, c), u_neon);
    c *= 1.0 + 0.35 * u_neon;
  }

  // Posterize: a few flat levels per colour, then a little more saturation, as in render.py.
  if (u_poster > 0.0) {
    c = (floor(clamp(c, 0.0, 0.999) * u_poster) + 0.5) / u_poster;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 1.3);
  }

  if (u_vhs > 0.0) {
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 1.0 + 0.6 * u_vhs);                   // saturation
    c = (c - 0.5) * (1.0 + 0.15 * u_vhs) + 0.5;               // contrast
    c += (hash(v_uv * u_size + fract(u_time) * 97.0) - 0.5) * 0.14 * u_vhs;   // grain, new each frame
    c *= 1.0 - 0.08 * u_vhs * step(0.5, fract(v_uv.y * u_size.y / 2.0));     // faint scan lines
  }

  c += (1.0 - c) * u_flash * 0.7;
  c *= 1.0 - u_black;
  if (u_invert) c = 1.0 - c;
  c = mix(c, 1.0 - c, u_invHit);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const TRAIL = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_cur, u_prev;
uniform float u_amount, u_drift;
void main() {
  vec3 cur = texture(u_cur, v_uv).rgb;
  // The previous frame is read slightly zoomed in, so old images grow outward as they fade.
  vec3 prev = texture(u_prev, 0.5 + (v_uv - 0.5) / (1.0 + u_drift * 0.02)).rgb;
  o = vec4(mix(cur, prev, u_amount), 1.0);
}`;

// Blend modes, in the order of BLENDS below.
const MIX = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_bottom, u_top;
uniform bool u_hasBottom, u_hasTop;
uniform float u_fade;        // how much of the top layer shows, 0 to 1
uniform int u_blend;
uniform int u_key;           // 0 no key, 1 brightness key, 2 colour key
uniform bool u_keyBright;    // brightness key: true cuts out the bright parts, false the dark parts
uniform float u_level;       // brightness key: where the cut falls, 0 black to 1 white
uniform vec3 u_keyColour;    // colour key: the colour that is cut out
uniform float u_tol;         // colour key: how far from that colour still counts as it
uniform float u_soft;        // width of the soft edge around the cut
uniform bool u_matte;        // show the cutout as black and white instead of the picture

const vec3 LUMA = vec3(0.299, 0.587, 0.114);

vec3 ycc(vec3 c) {
  float y = dot(c, LUMA);
  return vec3(y, (c.b - y) * 0.564, (c.r - y) * 0.713);
}

vec3 blend(vec3 a, vec3 b) {
  if (u_blend == 1) return 1.0 - (1.0 - a) * (1.0 - b);                         // screen
  if (u_blend == 2) return min(a + b, 1.0);                                     // add
  if (u_blend == 3) return a * b;                                               // multiply
  if (u_blend == 4) return abs(a - b);                                          // difference
  if (u_blend == 5) return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a));   // overlay
  if (u_blend == 6) return max(a, b);                                           // lighten
  if (u_blend == 7) return min(a, b);                                           // darken
  return b;                                                                     // normal
}

void main() {
  vec3 a = texture(u_bottom, v_uv).rgb;
  vec3 b = texture(u_top, v_uv).rgb;
  if (!u_hasTop) { o = vec4(a, 1.0); return; }
  if (!u_hasBottom) { o = vec4(b, 1.0); return; }

  // How much of the top layer is kept here: 1 kept, 0 cut out.
  float keep = 1.0;
  float soft = max(u_soft, 0.002);
  if (u_key == 1) {
    keep = smoothstep(u_level - soft * 0.5, u_level + soft * 0.5, dot(b, LUMA));
    if (u_keyBright) keep = 1.0 - keep;
  } else if (u_key == 2) {
    // Distance from the key colour, measured mostly on colour and only half on brightness, so a
    // shadowed patch of the same colour is still cut out.
    vec3 d = ycc(b) - ycc(u_keyColour);
    d.x *= 0.5;
    keep = smoothstep(u_tol, u_tol + soft, length(d));
  }

  if (u_matte) { o = vec4(vec3(keep), 1.0); return; }
  o = vec4(mix(a, blend(a, b), u_fade * keep), 1.0);
}`;

const COPY = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
void main() { o = texture(u_tex, v_uv); }`;

export const BLENDS = ["normal", "screen", "add", "multiply", "difference", "overlay", "lighten", "darken"];
export const KEYS = ["off", "brightness", "colour"];

const RING_SECONDS = 4;       // how much recent film the time effects can reach back into
const RING_MAX_FRAMES = 150;  // 4 s at 30 fps plus room. At 60 fps the reach drops to 2.5 s.
const RING_MAX_WIDTH = 1280;

/** One film with its own effects, recent-frames ring and output buffers. */
class Channel {
  constructor(r, video, name) {
    this.r = r;
    this.gl = r.gl;
    this.video = video;
    this.name = name;
    this.params = {};
    this.extra = { zoomPulse: 0, flash: 0, black: 0, invHit: 0, rgbHit: 0, hueJump: 0, fishHit: 0, rippleHit: 0, shape: null };   // set by the beat reactions
    this.timeMode = null;           // { kind, startedAt, len } while a time effect is held
    this.frozen = null;             // the ring slots that time effect loops over
    this.hasFrame = false;
    this.liveTex = r.texture();
    this.ring = { slots: [], times: [], head: 0, count: 0, total: 0, w: 0, h: 0 };   // total: frames ever written
    this.targets = null;            // fx output and the two trail buffers, sized to the picture

    this.onFrame = this.onFrame.bind(this);
    if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(this.onFrame);
    else this.noFrameCallback = true;
    video.addEventListener("seeking", () => this.clearRing());
    video.addEventListener("emptied", () => { this.hasFrame = false; this.clearRing(); });
  }

  /** Size the recent-frames ring for a new film. */
  setupRing() {
    const gl = this.gl, v = this.video;
    for (const t of this.ring.slots) gl.deleteTexture(t);
    const w = Math.min(this.r.ringWidth, v.videoWidth) & ~1;
    const h = Math.round((w * v.videoHeight) / v.videoWidth) & ~1;
    this.ring = { slots: [], times: [], head: 0, count: 0, total: this.ring.total || 0, w, h };
    if (!w || !h) return;
    for (let i = 0; i < this.r.ringFrames; i++) this.ring.slots.push(this.r.texture(w, h));
    if (gl.getError() === gl.OUT_OF_MEMORY) {
      // Not enough graphics memory for the full ring. Keep a third of it.
      for (const t of this.ring.slots.splice(Math.floor(this.r.ringFrames / 3))) gl.deleteTexture(t);
    }
  }

  /** Free the graphics memory of an emptied channel. The next film builds it again. */
  release() {
    const gl = this.gl;
    for (const t of this.ring.slots) gl.deleteTexture(t);
    if (this.targets) for (const t of [this.targets.fx, this.targets.a, this.targets.b]) gl.deleteTexture(t);
    this.ring = { slots: [], times: [], head: 0, count: 0, total: this.ring.total || 0, w: 0, h: 0 };
    this.targets = null;
    this.sourceW = this.sourceH = 0;
    this.hasFrame = false;
    this.frozen = null;
    this.timeMode = null;
  }

  clearRing() {
    this.ring.count = 0;
    this.ring.head = 0;
    if (this.frozen) this.frozen = { head: 0, count: 0, total0: this.ring.total, protect: 0 };
  }

  // ---- frames in ----

  onFrame(now, meta) {
    this.video.requestVideoFrameCallback(this.onFrame);
    try { this.takeFrame(meta.mediaTime); } catch (e) { this.r.error(e); }
  }

  takeFrame(mediaTime) {
    const gl = this.gl, v = this.video;
    if (!v.videoWidth) return;
    if (this.ring.w === 0 || this.sourceW !== v.videoWidth || this.sourceH !== v.videoHeight) {
      this.sourceW = v.videoWidth;
      this.sourceH = v.videoHeight;
      this.setupRing();
    }
    gl.bindTexture(gl.TEXTURE_2D, this.liveTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, v);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    this.hasFrame = true;

    // Keep a copy for the time effects. While one is held, the frames it loops are frozen and
    // the film carries on underneath, so letting go jumps back to where the film is, like a
    // DJ's loop roll. New frames still go into the free slots, so a second press right after
    // letting go has film to loop. They stop before they would overwrite the frozen frames.
    const r = this.ring;
    if (!r.slots.length) return;
    const fz = this.frozen;
    if (fz && fz.count >= 2 && r.total - fz.total0 >= r.slots.length - fz.protect) return;
    const last = r.count ? r.times[(r.head - 1 + r.slots.length) % r.slots.length] : null;
    if (last != null && (mediaTime < last || mediaTime - last > 0.5)) this.clearRing();   // a jump, not playback
    if (last != null && mediaTime === last) return;
    this.r.drawTo(r.slots[r.head], r.w, r.h, this.r.progCopy, { u_tex: this.liveTex });
    r.times[r.head] = mediaTime;
    r.head = (r.head + 1) % r.slots.length;
    r.count = Math.min(r.count + 1, r.slots.length);
    r.total++;
    if (fz) {
      // The ring was emptied during the hold (a seek, or a new film). Start the loop again from
      // the frames arriving now, instead of showing the live film while the panel says it is on.
      if (fz.count < 2 && r.count >= 2) this.freeze(true);
    }
    // Drop frames older than the ring's reach, so the time effects stay near the present.
    while (r.count > 2 && mediaTime - r.times[(r.head - r.count + r.slots.length) % r.slots.length] > RING_SECONDS) r.count--;
  }

  // ---- time effects ----

  /** kind is "stutter", "bounce" or "reverse". len is the loop length in seconds of film. */
  holdTime(kind, len) {
    if (this.timeMode?.kind === kind) { this.timeMode.len = len; return; }
    this.timeMode = { kind, len, startedAt: performance.now() };
    this.freeze(false);
  }

  releaseTime() {
    this.timeMode = null;
    this.frozen = null;
  }

  /** Take a snapshot of which ring slots the held time effect loops over. */
  freeze(restart) {
    const r = this.ring, n = r.slots.length;
    // Reverse can reach back through every frame, so all of them are kept. Stutter and back
    // and forth never loop more than 1.6 s, so only that much is kept and the rest of the ring
    // keeps filling.
    let protect = r.count;
    if (this.timeMode?.kind !== "reverse" && r.count) {
      const newest = r.times[(r.head - 1 + n) % n];
      protect = 0;
      while (protect < r.count && newest - r.times[(r.head - 1 - protect + 2 * n) % n] <= 1.6) protect++;
      protect = Math.min(r.count, protect + 1);
    }
    this.frozen = { head: r.head, count: r.count, total0: r.total, protect };
    if (restart && this.timeMode) this.timeMode.startedAt = performance.now();
  }

  /** The ring slot to show for the held time effect, or null to show the live frame. */
  ringFrame() {
    const r = this.ring, m = this.timeMode, fz = this.frozen;
    if (!m || !fz) return null;
    const n = r.slots.length;
    // Frames written since the press may have replaced the oldest frozen ones.
    const count = Math.min(fz.count, n - (r.total - fz.total0));
    if (count < 2) {
      // A monitor preview holding its own time effect does not stop the ring filling, so its
      // frames run out after a few seconds. It loops the newest frames again.
      if (this.ownTime && r.count >= 2) { this.freeze(true); return this.ringFrame(); }
      return null;
    }
    const at = (k) => (fz.head - 1 - k + n * 2) % n;         // k frames back from the newest frozen one
    const newest = r.times[at(0)];
    const oldest = r.times[at(count - 1)];
    const rate = this.video.playbackRate || 1;
    const elapsed = ((performance.now() - m.startedAt) / 1000) * rate;
    let target;
    if (m.kind === "reverse") {
      const span = Math.max(newest - oldest, 1e-3);
      target = newest - (elapsed % span);
    } else {
      const len = Math.min(m.len, newest - oldest);
      if (len <= 0) return at(0);
      const start = newest - len;
      let p = m.kind === "bounce" ? elapsed % (2 * len) : elapsed % len;
      if (p > len) p = 2 * len - p;
      target = start + p;
    }
    // The newest frame at or before target.
    for (let k = 0; k < count; k++) if (r.times[at(k)] <= target + 1e-4) return at(k);
    return at(count - 1);
  }

  // ---- drawing ----

  /** Run this channel's effects into its own buffers at the picture's size. Returns the result. */
  render(w, h, time) {
    const r = this.r, v = this.video, p = this.params, x = this.extra;
    let t = this.targets;
    if (!t || t.w !== w || t.h !== h) {
      if (t) for (const tex of [t.fx, t.a, t.b]) this.gl.deleteTexture(tex);
      t = this.targets = { w, h, fx: r.texture(w, h), a: r.texture(w, h), b: r.texture(w, h), fresh: true };
    }
    const slot = this.ringFrame();
    const src = slot == null ? this.liveTex : this.ring.slots[slot];

    // Crop a film of another shape so it fills the picture.
    const filmAspect = v.videoWidth / v.videoHeight, picAspect = w / h;
    const fit = filmAspect > picAspect ? [picAspect / filmAspect, 1] : [1, filmAspect / picAspect];

    // Shape swap on the beat replaces the three mirror shapes with the one it picked.
    const shape = (k) => (x.shape ? x.shape === k : !!p[k]?.on);
    r.drawTo(t.fx, w, h, r.progFx, { u_src: src }, {
      u_size: [v.videoWidth * fit[0], v.videoHeight * fit[1]],
      u_fit: fit,
      u_time: time,
      u_flip: !!p.flip?.on,
      u_upside: !!p.upside?.on,
      u_mirror: shape("mirror"),
      u_mirrorV: !x.shape && !!p.mirrorV?.on,
      u_quad: shape("quad"),
      u_kaleido: shape("kaleido"),
      u_wedges: p.kaleido?.wedges || 8,
      u_spin: shape("kaleido") ? p.kaleido?.spin || 0 : 0,
      // Zoom in and zoom out share the zoom's Amount. Out uses one over it.
      u_zoom: (p.zoom?.on ? p.zoom.amount || 1 : p.zoomOut?.on ? 1 / (p.zoom?.amount || 1) : 1) * (1 + 0.25 * x.zoomPulse),
      u_rgb: (p.rgb?.on ? p.rgb.amount ?? 1 : 0) + x.rgbHit * 3 * (p.rgb?.amount ?? 1),
      u_hueOn: !!p.hue?.on,
      u_hueSpeed: p.hue?.speed ?? 90,
      u_hueAdd: p.hueShift?.on ? p.hueShift.angle ?? 180 : 0,
      u_vhs: p.vhs?.on ? p.vhs.amount ?? 0.7 : 0,
      u_invert: !!p.invert?.on,
      u_flash: x.flash,
      u_black: x.black,
      u_invHit: x.invHit,
      u_hueJump: x.hueJump,
      // Fisheye's three variants share its Amount. Pulse bulges with the beat.
      u_fish: (p.fisheye?.on ? 1.5 : p.pinch?.on ? -0.8 : 1.5 * (x.fishHit || 0)) * (p.fisheye?.amount ?? 0.5),
      u_ripple: (p.ripple?.on ? p.ripple.amount ?? 0.4 : 0) + (x.rippleHit || 0) * (p.ripple?.amount ?? 0.4),
      u_rippleSize: p.ripple?.size ?? 0.5,
      u_poster: p.poster?.on ? p.poster.levels ?? 4 : 0,
      u_halo: p.halation?.on ? p.halation.amount ?? 0.6 : 0,
      u_haloThresh: p.halation?.threshold ?? 0.6,
      u_neon: p.neon?.on ? p.neon.amount ?? 0.6 : 0,
    });

    // Trails always run, with amount 0 when off, so turning them on starts from the current
    // picture instead of whatever was left in the buffer from minutes ago.
    const amount = p.trails?.on && !t.fresh ? p.trails.length ?? 0.6 : 0;
    r.drawTo(t.b, w, h, r.progTrail, { u_cur: t.fx, u_prev: t.a },
      { u_amount: amount * 0.95, u_drift: p.trails?.drift ?? 0.3 });
    t.fresh = false;
    [t.a, t.b] = [t.b, t.a];
    return t.a;
  }
}

export class LiveRenderer {
  /**
   * videos: the two video elements, for channels A and B. A deck monitor makes its own small
   * renderer with one video and a smaller ring (opts.ringWidth), so it costs little memory.
   */
  constructor(canvas, videos, opts = {}) {
    this.ringWidth = opts.ringWidth || RING_MAX_WIDTH;
    this.ringFrames = opts.ringFrames || RING_MAX_FRAMES;
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("This browser has no WebGL 2, which the live effects need.");
    this.gl = gl;
    this.startedAt = performance.now();
    this.errors = [];

    this.progFx = this.program(FX, "fx");
    this.progTrail = this.program(TRAIL, "trails");
    this.progMix = this.program(MIX, "mix");
    this.progCopy = this.program(COPY, "copy");
    this.vao = gl.createVertexArray();
    this.fbo = gl.createFramebuffer();
    this.blank = this.texture(1, 1);

    // How the two channels are mixed. main.js owns this object and changes it in place.
    this.mix = {
      fade: 1,              // how much of the top layer shows
      blend: "normal",
      key: "off",
      keyBright: false,     // brightness key cuts out the bright parts instead of the dark
      level: 0.3,
      colour: [0, 1, 0],
      tol: 0.12,
      soft: 0.1,
      aOnTop: false,        // normally B is laid over A
      swapped: false,       // flipped on the beat by "swap on beat"
      matte: false,
    };

    this.channels = videos.map((v, i) => new Channel(this, v, "AB"[i]));
    this.previews = [];
    this.draw = this.draw.bind(this);
    requestAnimationFrame(this.draw);
  }

  error(e) {
    if (this.errors.length < 5) { this.errors.push(e); console.error(e); }
  }

  // ---- setup ----

  program(fragSrc, name) {
    const gl = this.gl;
    const make = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`The ${name} shader did not compile: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, make(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, make(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`The ${name} shader did not link: ${gl.getProgramInfoLog(p)}`);
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    p.u = {};
    p.ints = new Set();      // int uniforms, which need uniform1i
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      p.u[info.name] = gl.getUniformLocation(p, info.name);
      if (info.type === gl.INT) p.ints.add(info.name);
    }
    return p;
  }

  texture(w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Reads past the edge bounce back in, so zoom and kaleidoscope never show black gaps.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    if (w && h) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    return t;
  }

  // ---- drawing ----

  drawTo(tex, w, h, prog, textures, uniforms = {}) {
    const gl = this.gl;
    if (tex) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    gl.viewport(...(tex ? [0, 0, w, h] : this.screenRect));
    gl.useProgram(prog);
    let unit = 0;
    for (const [name, t] of Object.entries(textures)) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(prog.u[name], unit++);
    }
    for (const [name, v] of Object.entries(uniforms)) {
      const loc = prog.u[name];
      if (loc == null) continue;
      if (Array.isArray(v)) (v.length === 3 ? gl.uniform3f : gl.uniform2f).call(gl, loc, ...v);
      else if (typeof v === "boolean") gl.uniform1i(loc, v ? 1 : 0);
      else if (prog.ints.has(name)) gl.uniform1i(loc, v);
      else gl.uniform1f(loc, v);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** The channel whose shape the picture takes: A, or B when only B has a film. */
  shapeSource() {
    const [a, b] = this.channels;
    return a.video.videoWidth || !b.video.videoWidth ? a.video : b.video;
  }

  /** Fit the canvas to its box, and the picture inside it with black bars. */
  layout() {
    const c = this.canvas, v = this.shapeSource();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(c.clientWidth * dpr));
    const ch = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    let w = cw, h = Math.round(cw / aspect);
    if (h > ch) { h = ch; w = Math.round(ch * aspect); }
    this.screenRect = [Math.floor((cw - w) / 2), Math.floor((ch - h) / 2), w, h];
  }

  /** Which channel is the top layer right now, after "A on top" and "swap on beat". */
  topIndex() {
    return this.mix.aOnTop !== this.mix.swapped ? 0 : 1;
  }

  draw() {
    requestAnimationFrame(this.draw);
    const gl = this.gl, m = this.mix;
    try {
      for (const ch of this.channels) if (ch.noFrameCallback && ch.video.readyState >= 2) ch.takeFrame(ch.video.currentTime);
      this.layout();
      const time = (performance.now() - this.startedAt) / 1000;
      for (const pv of this.previews) this.drawPreview(pv, time);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const live = this.channels.map((ch) => ch.hasFrame);
      if (!live[0] && !live[1]) return;

      const [, , w, h] = this.screenRect;
      const out = this.channels.map((ch, i) => (live[i] ? ch.render(w, h, time) : this.blank));
      const top = this.topIndex(), bottom = 1 - top;
      this.drawTo(null, 0, 0, this.progMix, { u_bottom: out[bottom], u_top: out[top] }, {
        u_hasBottom: live[bottom],
        u_hasTop: live[top],
        u_fade: m.fade,
        u_blend: Math.max(0, BLENDS.indexOf(m.blend)),
        u_key: Math.max(0, KEYS.indexOf(m.key)),
        u_keyBright: !!m.keyBright,
        u_level: m.level,
        u_keyColour: m.colour,
        u_tol: m.tol,
        u_soft: m.soft,
        u_matte: !!m.matte && m.key !== "off" && live[top],
      });
    } catch (e) {
      this.error(e);
    }
  }

  /**
   * A deck monitor's preview: channel i's film with its own effects, drawn into a small 2D
   * canvas. It shares the channel's frames and ring, so it adds no video upload and little
   * memory. main.js sets preview.ch.params, .extra and the time effect state.
   */
  addPreview(i, canvas) {
    const ch = Object.create(this.channels[i]);   // reads the channel's frames, keeps its own settings
    Object.assign(ch, {
      params: {}, extra: { zoomPulse: 0, flash: 0, black: 0, invHit: 0, rgbHit: 0, hueJump: 0, fishHit: 0, rippleHit: 0, shape: null },
      targets: null, timeMode: null, frozen: null, ownTime: false,
    });
    const pv = { ch, canvas, ctx: canvas.getContext("2d", { alpha: false }), on: true, drawn: false };
    this.previews.push(pv);
    return pv;
  }

  /**
   * Draw a preview into the corner of the main canvas, copy it out to the monitor's canvas, and
   * let the main picture draw over that corner afterwards. One WebGL context does all of it.
   */
  drawPreview(pv, time) {
    const c = this.canvas, cv = pv.canvas;
    const live = pv.on && pv.ch.hasFrame && cv.clientWidth > 4;
    if (!live) { pv.drawn = false; return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.min(c.width, Math.round(cv.clientWidth * dpr));
    const h = Math.min(c.height, Math.round(cv.clientHeight * dpr));
    if (w < 2 || h < 2) { pv.drawn = false; return; }
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const out = pv.ch.render(w, h, time);
    const keep = this.screenRect;
    this.screenRect = [0, 0, w, h];
    this.drawTo(null, 0, 0, this.progCopy, { u_tex: out });
    this.screenRect = keep;
    pv.ctx.drawImage(c, 0, c.height - h, w, h, 0, 0, w, h);   // GL's bottom left is the canvas's bottom rows
    pv.drawn = true;
  }

  /**
   * The colour of channel i's finished picture under a point on the canvas, in page pixels.
   * Returns [r, g, b] from 0 to 1, or null when the point is outside the picture.
   */
  colourAt(i, clientX, clientY) {
    const ch = this.channels[i], t = ch.targets;
    if (!ch.hasFrame || !t || !this.screenRect) return null;
    const box = this.canvas.getBoundingClientRect();
    const sx = ((clientX - box.left) / box.width) * this.canvas.width;
    const sy = this.canvas.height - ((clientY - box.top) / box.height) * this.canvas.height;   // GL counts up from the bottom
    const [rx, ry, rw, rh] = this.screenRect;
    const x = Math.floor(sx - rx), y = Math.floor(sy - ry);
    if (x < 0 || y < 0 || x >= rw || y >= rh || rw !== t.w || rh !== t.h) return null;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.a, 0);
    // Average a 5 by 5 patch, so film grain and VHS noise do not decide the colour.
    const x0 = Math.max(0, x - 2), y0 = Math.max(0, y - 2);
    const pw = Math.min(5, rw - x0), ph = Math.min(5, rh - y0);
    const px = new Uint8Array(pw * ph * 4);
    gl.readPixels(x0, y0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const sum = [0, 0, 0];
    for (let k = 0; k < px.length; k += 4) for (let c = 0; c < 3; c++) sum[c] += px[k + c];
    return sum.map((s) => s / (pw * ph) / 255);
  }
}
