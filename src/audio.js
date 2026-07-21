// Synthesized audio — no assets. Everything is generated from noise buffers and oscillators.

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.crowdGain = null;
    this.crowdBase = 0.05;
    this.crowdExcite = 0;
    this._noiseBuf = null;
  }

  init() {
    if (this.ctx) return;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(ctx.destination);

    // shared 2s white noise buffer
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;

    this._startCrowd();
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  _noise(duration, { filterType = 'lowpass', freq = 1000, q = 1, gain = 0.5, attack = 0.001, decay = 0.15, freqEnd = null } = {}) {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    if (freqEnd != null) f.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 20), t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + duration + 0.05);
  }

  _tone(freq, duration, { type = 'sine', gain = 0.2, freqEnd = null, attack = 0.002, decay = null } = {}) {
    const ctx = this.ctx; if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (freqEnd != null) o.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 20), t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (decay ?? duration));
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + duration + 0.05);
  }

  // ---- gunshots (vol scaled by distance for AI shots) ----
  shot(kind, vol = 1) {
    if (!this.ctx) return;
    const v = Math.max(0.02, Math.min(1, vol));
    switch (kind) {
      case 'pistol':
        this._noise(0.25, { freq: 2800, freqEnd: 400, gain: 0.55 * v, decay: 0.09 });
        this._tone(180, 0.1, { type: 'square', gain: 0.12 * v, freqEnd: 60 });
        break;
      case 'smg':
        this._noise(0.15, { freq: 3400, freqEnd: 600, gain: 0.4 * v, decay: 0.055 });
        this._tone(220, 0.07, { type: 'square', gain: 0.08 * v, freqEnd: 90 });
        break;
      case 'shotgun':
        this._noise(0.5, { freq: 1400, freqEnd: 120, gain: 0.85 * v, decay: 0.22 });
        this._tone(90, 0.3, { type: 'sine', gain: 0.35 * v, freqEnd: 35 });
        break;
      case 'rifle':
        this._noise(0.3, { freq: 2400, freqEnd: 300, gain: 0.6 * v, decay: 0.11 });
        this._tone(140, 0.14, { type: 'sawtooth', gain: 0.14 * v, freqEnd: 50 });
        break;
      case 'dmr':
        this._noise(0.55, { freq: 2000, freqEnd: 150, gain: 0.8 * v, decay: 0.25 });
        this._tone(110, 0.3, { type: 'sine', gain: 0.3 * v, freqEnd: 40 });
        break;
    }
  }

  dryFire() { this._tone(1200, 0.04, { type: 'square', gain: 0.07 }); }

  reload(stage = 0) {
    if (stage === 0) { this._noise(0.06, { freq: 3000, gain: 0.2, decay: 0.03 }); this._tone(500, 0.05, { type: 'square', gain: 0.06, freqEnd: 300 }); }
    else { this._noise(0.08, { freq: 2200, gain: 0.28, decay: 0.045 }); this._tone(700, 0.06, { type: 'square', gain: 0.08, freqEnd: 350 }); }
  }

  hitFlesh() {
    this._noise(0.12, { freq: 500, freqEnd: 120, gain: 0.35, decay: 0.08 });
    this._tone(160, 0.09, { type: 'sine', gain: 0.15, freqEnd: 70 });
  }

  hitmarker() { this._tone(2400, 0.045, { type: 'sine', gain: 0.12, freqEnd: 1800 }); }
  headshotDing() { this._tone(1560, 0.18, { type: 'sine', gain: 0.14, freqEnd: 1560 }); }

  ricochet() {
    this._noise(0.15, { filterType: 'bandpass', freq: 3200 + Math.random() * 2500, q: 8, gain: 0.16, decay: 0.09 });
  }

  hurt() {
    this._tone(300 + Math.random() * 80, 0.18, { type: 'sawtooth', gain: 0.18, freqEnd: 90 });
    this._noise(0.2, { freq: 700, freqEnd: 150, gain: 0.3, decay: 0.13 });
  }

  footstep() { this._noise(0.07, { freq: 300 + Math.random() * 150, gain: 0.07, decay: 0.045 }); }

  klaxon() {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        this._tone(520, 0.35, { type: 'square', gain: 0.14, freqEnd: 380, decay: 0.32 });
        this._tone(524, 0.35, { type: 'square', gain: 0.1, freqEnd: 384, decay: 0.32 });
      }, i * 420);
    }
  }

  cashRegister() {
    this._tone(1320, 0.09, { type: 'square', gain: 0.08 });
    setTimeout(() => this._tone(1760, 0.12, { type: 'square', gain: 0.08 }), 70);
  }

  uiClick() { this._tone(900, 0.05, { type: 'square', gain: 0.05, freqEnd: 600 }); }

  explosion(vol = 1) {
    const v = Math.max(0.05, Math.min(1, vol));
    this._noise(1.1, { freq: 900, freqEnd: 60, gain: 1.0 * v, decay: 0.5 });
    this._noise(0.4, { freq: 3500, freqEnd: 300, gain: 0.5 * v, decay: 0.15 });
    this._tone(55, 0.8, { type: 'sine', gain: 0.5 * v, freqEnd: 24 });
    this._tone(110, 0.35, { type: 'square', gain: 0.2 * v, freqEnd: 40 });
  }

  drop() {
    this._noise(0.6, { freq: 900, freqEnd: 100, gain: 0.5, decay: 0.3 });
    this._tone(70, 0.4, { type: 'sine', gain: 0.3, freqEnd: 30 });
  }

  // ---- crowd ambience ----
  _startCrowd() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.value = this.crowdBase;
    this.crowdGain = g;
    src.connect(f).connect(g).connect(this.master);
    src.start();
    // slow murmur LFO
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.015;
    lfo.connect(lfoG).connect(g.gain);
    lfo.start();
  }

  crowdRoar(intensity = 1) { this.crowdExcite = Math.min(1, this.crowdExcite + 0.4 * intensity); }

  setCrowdLevel(base) { this.crowdBase = base; }

  update(dt) {
    if (!this.crowdGain) return;
    this.crowdExcite = Math.max(0, this.crowdExcite - dt * 0.35);
    const target = this.crowdBase + this.crowdExcite * 0.22;
    const cur = this.crowdGain.gain.value;
    this.crowdGain.gain.value = cur + (target - cur) * Math.min(1, dt * 5);
  }
}

export const audio = new AudioEngine();
