// Live beat detection on whatever music is playing.
//
// The music goes through a Web Audio analyser before the speakers. On every screen refresh we
// read how loud the bass is (roughly 40 to 170 Hz, where the kick drum sits) and compare the
// rise since the last refresh with the recent rises. A rise well above the recent ones is a
// beat. Beats closer together than 0.28 s are ignored, which caps detection at about 210 BPM.
//
// The tempo is fitted to the beats heard in the last 12 seconds. Every tempo from 80 to 180 BPM
// in steps of 0.5 is tried. For each pair of beats, the gap between them should be a whole
// number of beats at the right tempo, give or take the 16 ms the detector can be late by. The
// tempo that fits the most pairs wins. A missed kick or an extra hit only spoils a few pairs,
// which is why this beats taking the middle gap. Tempos near 125 BPM get a slight preference,
// so a 90 BPM song is not reported as 180 when both fit equally well.

export class BeatDetector {
  constructor(audio) {
    this.audio = audio;
    this.ctx = null;
    this.lastBeatAt = -1e9;       // performance.now() of the newest beat
    this.count = 0;
    this.bpm = 0;
    this.listeners = [];
    this.prev = 0;
    this.flux = [];
    this.onsets = [];             // seconds, on the audio clock, of the beats heard recently
  }

  /** Must run from a click or key press, since browsers only allow sound after one. */
  start() {
    if (this.ctx) { if (this.ctx.state === "suspended") this.ctx.resume(); return; }
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaElementSource(this.audio);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    src.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    const hz = this.ctx.sampleRate / this.analyser.fftSize;
    this.lo = Math.max(1, Math.round(40 / hz));
    this.hi = Math.max(this.lo + 1, Math.round(170 / hz));
  }

  onBeat(fn) { this.listeners.push(fn); }

  /** Forget the tempo and history, for a new song. */
  reset() {
    this.prev = 0;
    this.flux = [];
    this.onsets = [];
    this.bpm = 0;
    this.lastBeatAt = -1e9;
  }

  /** Best tempo for the recent beats, or 0 if there are too few. */
  fitTempo() {
    const t = this.onsets;
    if (t.length < 6) return 0;
    let best = 0, bestScore = 0;
    for (let bpm = 80; bpm <= 180; bpm += 0.5) {
      const period = 60 / bpm;
      let score = 0;
      for (let i = 0; i < t.length; i++) {
        for (let j = i + 1; j < t.length; j++) {
          const dt = t[j] - t[i];
          if (dt > 4) break;
          const k = Math.round(dt / period);
          if (k < 1) continue;
          const err = (dt - k * period) / 0.02;
          score += Math.exp(-err * err) / Math.sqrt(k);
        }
      }
      score *= Math.exp(-((Math.log2(bpm / 125) / 1.2) ** 2));
      if (score > bestScore) { bestScore = score; best = bpm; }
    }
    return best;
  }

  /** Call once per screen refresh. */
  update(now) {
    if (!this.analyser || this.audio.paused) return;
    // Sample about 60 times a second whatever the screen's refresh rate, so the bass rise per
    // sample and the one second of history mean the same on a 60 Hz and a 144 Hz monitor.
    if (now - (this.sampledAt || 0) < 15) return;
    this.sampledAt = now;
    this.analyser.getByteFrequencyData(this.bins);
    let e = 0;
    for (let i = this.lo; i <= this.hi; i++) e += this.bins[i];
    e /= (this.hi - this.lo + 1) * 255;
    const rise = Math.max(0, e - this.prev);
    this.prev = e;

    const f = this.flux;
    f.push(rise);
    if (f.length > 60) f.shift();                  // about one second of history
    const mean = f.reduce((a, b) => a + b, 0) / f.length;
    const sd = Math.sqrt(f.reduce((a, b) => a + (b - mean) ** 2, 0) / f.length);
    if (f.length < 20 || rise < mean + 1.5 * sd || rise < 0.02 || e < 0.25) return;
    if (now - this.lastBeatAt < 280) return;

    this.lastBeatAt = now;
    this.count++;
    const at = this.ctx.currentTime;
    this.onsets.push(at);
    while (this.onsets.length && at - this.onsets[0] > 12) this.onsets.shift();
    const fitted = this.fitTempo();
    if (fitted) this.bpm = fitted;
    for (const fn of this.listeners) fn(this.count, now);
  }

  /** 1 right on a beat, falling to 0 over decayMs. Used for pulses and flashes. */
  envelope(now, decayMs = 200) {
    const t = (now - this.lastBeatAt) / decayMs;
    return t >= 1 || t < 0 ? 0 : (1 - t) ** 2;
  }

  /** Seconds per beat, or 0 while the tempo is still unknown. */
  beatSeconds() { return this.bpm ? 60 / this.bpm : 0; }
}
