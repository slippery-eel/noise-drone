'use strict';

// ── Recorder (AudioWorklet, with ScriptProcessor fallback) ────────────────
// Chrome refuses Blob-URL worklets on file:// pages (origin "null"), so when
// the worklet can't load, capture falls back to a ScriptProcessorNode.

const RECORDER_WORKLET = `
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false; this.size = 16384; this.reset();
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.reset(); this.on = true; }
      else if (e.data === 'stop') { this.on = false; this.flush(); this.port.postMessage('done'); }
    };
  }
  reset() { this.l = new Float32Array(this.size); this.r = new Float32Array(this.size); this.n = 0; }
  flush() {
    if (!this.n) return;
    const l = this.l.slice(0, this.n), r = this.r.slice(0, this.n);
    this.port.postMessage([l, r], [l.buffer, r.buffer]);
    this.reset();
  }
  process(inputs) {
    const inp = inputs[0];
    if (this.on && inp && inp[0]) {
      const l = inp[0], r = inp[1] || inp[0];
      this.l.set(l, this.n); this.r.set(r, this.n); this.n += l.length;
      if (this.n + 128 > this.size) this.flush();
    }
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);
`;

// Returns { input, start(), stop() }; onChunk(l, r) per block, onDone() after stop.
async function createRecorder(ctx, onChunk, onDone) {
  try {
    const url = URL.createObjectURL(new Blob([RECORDER_WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const node = new AudioWorkletNode(ctx, 'recorder-processor', {
      numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit',
    });
    node.port.onmessage = e => { if (e.data === 'done') onDone(); else onChunk(e.data[0], e.data[1]); };
    return { input: node, start: () => node.port.postMessage('start'), stop: () => node.port.postMessage('stop') };
  } catch (_) {
    const node = ctx.createScriptProcessor(4096, 2, 2);
    const mute = ctx.createGain(); mute.gain.value = 0;
    node.connect(mute); mute.connect(ctx.destination);
    let on = false;
    node.onaudioprocess = e => {
      if (on) onChunk(e.inputBuffer.getChannelData(0).slice(), e.inputBuffer.getChannelData(1).slice());
    };
    return { input: node, start: () => { on = true; }, stop: () => { on = false; onDone(); } };
  }
}

// ── Constants & helpers ───────────────────────────────────────────────────

const SR = 48000;                         // film standard; used live and for renders
const COLORS = ['white', 'pink', 'brown'];
const SOURCES = ['noise', 'tone', 'organ', 'choir', 'resonator', 'hum'];
const PITCHED = ['tone', 'organ', 'choir', 'resonator'];
const LAYERS = ['bed', 'tone', 'air'];    // free-source layers
const ALL_LAYERS = [...LAYERS, 'sub'];    // sub is always a sine below the root
const INTERVALS = { unison: [0], octave: [0, 12], fifth: [0, 7], tritone: [0, 6], minor2: [0, 1], minor9: [0, 13] };
const ORGAN_PARTIALS = [1, 2, 3, 4, 5, 6, 8];
const BAR_RATIOS = [1, 2.756, 5.404, 8.933, 13.344, 18.64];   // free-free bar modes: bowed metal
const VOWELS = { oo: [300, 870, 2240], ah: [730, 1090, 2440], ee: [270, 2290, 3010] };
const FORMANT_GAIN = [1, 0.5, 0.3];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const lk = (L, p) => L + p[0].toUpperCase() + p.slice(1);   // layer key: ('bed', 'level') → 'bedLevel'
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const midiToHz = m => 440 * Math.pow(2, (m - 69) / 12);
const noteName = m => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
const darknessToHz = d => 20000 * Math.pow(200 / 20000, d);
const beatHz = b => 0.2 + b * 3.8;
const lpHz = f => f < 0 ? 20000 * Math.pow(60 / 20000, -f) : 20000;   // layer filter: left = low-pass
const hpHz = f => f > 0 ? 20 * Math.pow(6000 / 20, f) : 20;            //               right = high-pass
const resonQ = q => 4 * Math.pow(100, q);                             // 4 … 400
// Harmonic n ↔ bar mode n, interpolated geometrically by Inharmonicity
const resonRatio = (n, inh) => Math.pow(n, 1 - inh) * Math.pow(BAR_RATIOS[n - 1], inh);
const usesNoise = (s, L) => {
  const src = s[lk(L, 'src')];
  return src === 'noise' || src === 'resonator' || (src === 'choir' && s[lk(L, 'exc')] === 'noise');
};
const isVoiced = (s, L) => PITCHED.includes(s[lk(L, 'src')]) && !(s[lk(L, 'src')] === 'choir' && s[lk(L, 'exc')] === 'noise');

function softClipCurve(k) {
  const n = 512, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

// ── Space & tape buffers ──────────────────────────────────────────────────
// All context-free and seeded, so a render reuses exactly what plays live.

const verbSecs = v => 0.8 * Math.pow(15, v);     // Size → RT60, 0.8 … 12 s
const echoSecs = v => 0.05 * Math.pow(30, v);    // Echo time, 50 ms … 1.5 s
const irKeyOf = (size, damp) => size.toFixed(2) + '|' + damp.toFixed(2);
const WOW_BASE = 0.006;                          // tape delay centre; wow swings ±4 ms around it
const ECHO_CURVE = softClipCurve(2);
const SHIMMER_MAX = 0.6;
const FREEZE_LOOPS = [1.31, 1.73, 2.17, 2.79];   // seconds
const FREEZE_FB = 0.9995;                        // hours to fall 60 dB (mids; highs damp sooner)
const FREEZE_START = 4.5;                        // a graph built frozen captures this far in
const FREEZE_NORM = 1;
const irCache = new Map();

// Exponentially decaying stereo noise (−60 dB at RT60). Damping is a one-pole
// low-pass whose cutoff falls over the tail, so highs die first, as in a room.
function getReverbIR(size, damp) {
  const key = irKeyOf(size, damp);
  if (irCache.has(key)) return irCache.get(key);
  size = +size.toFixed(2); damp = +damp.toFixed(2);
  const rt = verbSecs(size), len = Math.ceil(rt * SR);
  const f0 = 16000 * Math.pow(0.3, damp), f1 = 16000 * Math.pow(0.02, damp);
  const k = Math.exp(-Math.log(1000) / len);
  const buf = new AudioBuffer({ length: len, sampleRate: SR, numberOfChannels: 2 });
  for (let c = 0; c < 2; c++) {
    const rand = mulberry32(4441 + c * 131), d = buf.getChannelData(c);
    let y = 0, a = 0, env = 1;
    for (let i = 0; i < len; i++) {
      if ((i & 31) === 0) a = Math.exp(-2 * Math.PI * f0 * Math.pow(f1 / f0, i / len) / SR);
      y = (1 - a) * (rand() * 2 - 1) + a * y;
      d[i] = y * env * Math.min(1, i / 96);
      env *= k;
    }
  }
  if (irCache.size >= 6) irCache.delete(irCache.keys().next().value);
  irCache.set(key, buf);
  return buf;
}

// Octave-down pitch shift without a worklet: two delay taps whose delay rises
// at 0.5 s/s (→ half speed), each faded by a sin² window so the jump back is
// silent. One 4-channel looping buffer drives both taps, so they stay in sync.
const SHIFT_PERIOD = 0.2;
let shiftBuffer = null;

function getShiftBuffer() {
  if (!shiftBuffer) {
    const n = Math.round(SHIFT_PERIOD * SR), W = SHIFT_PERIOD / 2;
    shiftBuffer = new AudioBuffer({ length: n, sampleRate: SR, numberOfChannels: 4 });
    const [d1, g1, d2, g2] = [0, 1, 2, 3].map(c => shiftBuffer.getChannelData(c));
    for (let i = 0; i < n; i++) {
      const p = i / n, q = (p + 0.5) % 1;
      d1[i] = 0.004 + W * p; g1[i] = Math.sin(Math.PI * p) ** 2;
      d2[i] = 0.004 + W * q; g2[i] = Math.sin(Math.PI * q) ** 2;
    }
  }
  return shiftBuffer;
}

function makeOctaveDown(ctx, list) {
  const input = ctx.createGain(), output = ctx.createGain();
  const src = ctx.createBufferSource();
  src.buffer = getShiftBuffer(); src.loop = true;
  const split = ctx.createChannelSplitter(4);
  src.connect(split);
  list.push(input, output, src, split);
  [0, 2].forEach(c => {
    const d = ctx.createDelay(0.2); d.delayTime.value = 0;
    const g = ctx.createGain(); g.gain.value = 0;
    split.connect(d.delayTime, c); split.connect(g.gain, c + 1);
    input.connect(d); d.connect(g); g.connect(output);
    list.push(d, g);
  });
  src.start();
  return { input, output };
}

// Vinyl crackle: sparse noisy clicks (mostly faint, a few loud) and rare
// low pops. Nothing lands near the end, so the loop seam is silent.
const CRACKLE_SECS = 17;
let crackleBuffer = null;

function getCrackleBuffer() {
  if (!crackleBuffer) {
    const n = CRACKLE_SECS * SR, rand = mulberry32(777);
    crackleBuffer = new AudioBuffer({ length: n, sampleRate: SR, numberOfChannels: 2 });
    const L = crackleBuffer.getChannelData(0), R = crackleBuffer.getChannelData(1);
    for (let t = 0; ;) {
      t += -Math.log(1 - rand()) / 7;                 // ~7 events per second
      const i0 = Math.floor(t * SR);
      if (i0 > n - 400) break;
      const pop = rand() < 0.04;
      const amp = pop ? 0.3 + 0.4 * rand() : 0.03 + 0.97 * Math.pow(rand(), 5);
      const tau = pop ? 20 + rand() * 40 : 1 + rand() * 5;
      const bal = rand() * Math.PI / 2, gl = Math.cos(bal) * 1.4, gr = Math.sin(bal) * 1.4;
      const sgn = rand() < 0.5 ? -1 : 1;
      for (let k = 0, len = Math.ceil(tau * 6); k < len; k++) {
        const v = sgn * amp * Math.exp(-k / tau) * (pop || k === 0 ? 1 : rand() * 2 - 1);
        L[i0 + k] += v * Math.min(1, gl); R[i0 + k] += v * Math.min(1, gr);
      }
    }
  }
  return crackleBuffer;
}

// Periodic waves are bound to a context; Tone's are cached per harmonic count.
const toneWaves = new WeakMap();
function toneWave(ctx, harm) {
  if (!toneWaves.has(ctx)) toneWaves.set(ctx, {});
  const cache = toneWaves.get(ctx);
  if (!cache[harm]) {
    const real = new Float32Array(harm + 1), imag = new Float32Array(harm + 1);
    for (let k = 1; k <= harm; k++) imag[k] = 1 / k;
    cache[harm] = ctx.createPeriodicWave(real, imag);
  }
  return cache[harm];
}

// Mains hum: weak fundamental, strong 2nd (rectifier), Buzz adds the upper series.
function humWave(ctx, buzz) {
  const n = 16, real = new Float32Array(n + 1), imag = new Float32Array(n + 1);
  imag[1] = 0.5; imag[2] = 1;
  for (let k = 3; k <= n; k++) imag[k] = buzz * buzz * Math.pow(k, -0.6) * (k % 2 ? 1 : 0.5);
  return ctx.createPeriodicWave(real, imag);
}

// Vowel position (−1 = oo, 0 = ah, +1 = ee) → formant i's detune from its "ah"
// frequency, in units of 2400 ¢. Used as a WaveShaper curve so a wander signal
// can sweep the vowel at audio rate, identically live and offline.
function formantCurve(i) {
  const n = 257, curve = new Float32Array(n), ah = VOWELS.ah[i];
  for (let j = 0; j < n; j++) {
    const p = j / (n - 1) * 2 - 1;
    const [a, b, t] = p < 0 ? [VOWELS.oo[i], ah, p + 1] : [ah, VOWELS.ee[i], p];
    const f = a * Math.pow(b / a, t);
    curve[j] = 1200 * Math.log2(f / ah) / 2400;
  }
  return curve;
}

// ── Wander: smooth, non-periodic random modulation ────────────────────────
// A few long seamless-looping buffers of fractal value noise (Catmull-Rom
// interpolated). Played as looping buffer sources at a chosen playbackRate,
// they behave like an LFO that never repeats audibly — and, being ordinary
// audio nodes, they render offline exactly like they play live.

const WANDER_SR = 3000, WANDER_SECS = 120, WANDER_BUFS = 4;
let wanderBuffers = null;

function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeWanderData(rand) {
  const n = WANDER_SR * WANDER_SECS;
  const out = new Float32Array(n);
  [[0.25, 1], [0.5, 0.5], [1, 0.25]].forEach(([perSec, amp]) => {
    const pts = Math.round(WANDER_SECS * perSec);
    const v = Array.from({ length: pts }, () => rand() * 2 - 1);
    const step = n / pts;
    for (let i = 0; i < n; i++) {
      const x = i / step, k = Math.floor(x), t = x - k;
      const p0 = v[(k - 1 + pts) % pts], p1 = v[k % pts], p2 = v[(k + 1) % pts], p3 = v[(k + 2) % pts];
      out[i] += amp * (p1 + 0.5 * t * (p2 - p0 + t * (2*p0 - 5*p1 + 4*p2 - p3 + t * (3*(p1 - p2) + p3 - p0))));
    }
  });
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}

function getWanderBuffers() {
  if (!wanderBuffers) {
    wanderBuffers = Array.from({ length: WANDER_BUFS }, (_, i) => {
      const buf = new AudioBuffer({ length: WANDER_SR * WANDER_SECS, sampleRate: WANDER_SR, numberOfChannels: 1 });
      buf.getChannelData(0).set(makeWanderData(mulberry32(1013 + i * 7919)));
      return buf;
    });
  }
  return wanderBuffers;
}

// ── Noise: seamless-looping stereo buffers ───────────────────────────────
// Independent L/R channels; Width crossfeeds L into R. Context-free
// AudioBuffers, so the live and offline graphs share them.

const NOISE_SECS = 20, NOISE_XFADE = 0.5;
const noiseBuffers = {};

function fillNoise(type, out) {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0, dcIn = 0, dcOut = 0;
  for (let i = 0; i < out.length; i++) {
    const w = Math.random() * 2 - 1;
    if (type === 'white') { out[i] = w * 0.5; continue; }
    if (type === 'pink') {
      b0 = 0.99886*b0 + w*0.0555179; b1 = 0.99332*b1 + w*0.0750759;
      b2 = 0.96900*b2 + w*0.1538520; b3 = 0.86650*b3 + w*0.3104856;
      b4 = 0.55000*b4 + w*0.5329522; b5 = -0.7616*b5 - w*0.0168980;
      out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w*0.5362) * 0.11;
      b6 = w*0.115926;
      continue;
    }
    last = (last + 0.02*w) / 1.02;
    const s = last * 3.5;
    out[i] = s - dcIn + 0.995*dcOut;
    dcIn = s; dcOut = out[i];
  }
}

function getNoiseBuffer(type) {
  if (!noiseBuffers[type]) {
    const n = NOISE_SECS * SR, x = NOISE_XFADE * SR;
    const buf = new AudioBuffer({ length: n, sampleRate: SR, numberOfChannels: 2 });
    for (let c = 0; c < 2; c++) {
      const raw = new Float32Array(n + x);
      fillNoise(type, raw);
      const d = buf.getChannelData(c);
      d.set(raw.subarray(0, n));
      for (let i = 0; i < x; i++) {            // crossfade the tail into the head → seamless loop
        const t = (i / x) * Math.PI / 2;
        d[i] = raw[i] * Math.sin(t) + raw[n + i] * Math.cos(t);
      }
    }
    noiseBuffers[type] = buf;
  }
  return noiseBuffers[type];
}

function makeNoise(ctx, type, list) {
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer(type);
  src.loop = true;
  const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  const lToR = ctx.createGain(), rToR = ctx.createGain();
  src.connect(split);
  split.connect(merge, 0, 0);
  split.connect(lToR, 0); split.connect(rToR, 1);
  lToR.connect(merge, 0, 1); rToR.connect(merge, 0, 1);
  src.start(0, Math.random() * NOISE_SECS);
  list.push(src, split, lToR, rToR, merge);
  return {
    out: merge,
    setWidth(w, set) {
      const norm = 1 / Math.sqrt((1 - w) * (1 - w) + w * w);
      set(lToR.gain, (1 - w) * norm);
      set(rToR.gain, w * norm);
    },
  };
}

// ── Layer sources ─────────────────────────────────────────────────────────
// Each builder wires a source into `inp` (pushing every node it makes onto
// `nodes` for disposal) and returns update(s, set). `g` = { ctx, s, wander, vib }.
// Structural choices (source, colour, exciter, interval) rebuild the layer;
// everything else is a parameter glide.

const layerRoot = (s, L) => midiToHz(s.pitch) * Math.pow(2, s[lk(L, 'oct')]);

// Interval notes (+ a beating twin per note), each with its own drift, pan
// wander and pitch-mod bus (vibrato + drift → every detune in that voice).
function makeVoices(g, dest, nodes, perVoice, twins = true) {
  const { ctx } = g;
  const notes = INTERVALS[g.s.interval] || [0];
  const mainGain = ctx.createGain(), twinGain = ctx.createGain();
  twinGain.gain.value = 0;
  mainGain.connect(dest); twinGain.connect(dest);
  nodes.push(mainGain, twinGain);
  const voices = [];
  notes.forEach((semi, ni) => (twins ? [false, true] : [false]).forEach(twin => {
    const vg = ctx.createGain(); vg.gain.value = 1 / notes.length;
    const pan = ctx.createStereoPanner();
    vg.connect(pan); pan.connect(twin ? twinGain : mainGain);
    const pitchMod = ctx.createGain();
    g.vib.connect(pitchMod);
    const drift = g.wander(0.5, nodes); drift.out.connect(pitchMod);
    const panW = g.wander(0.25, nodes); panW.out.connect(pan.pan);
    nodes.push(vg, pan, pitchMod, () => g.vib.disconnect(pitchMod));
    voices.push({
      ...perVoice(vg, pitchMod), pan, drift, panW, twin,
      ratio: Math.pow(2, semi / 12),
      panBase: (notes.length > 1 ? (ni ? 0.35 : -0.35) : 0) * (twin ? -1 : 1),
    });
  }));
  return (s, set, root) => {
    const bh = beatHz(s.beat);
    voices.forEach(v => {
      v.setFreq(root * v.ratio + (v.twin ? bh : 0), set, s);
      set(v.drift.out.gain, s.drift * 50);
      set(v.pan.pan, clamp(v.panBase * s.width, -1, 1));
      set(v.panW.out.gain, s.width * 0.35);
    });
    if (twins) set(twinGain.gain, Math.min(1, s.beat * 10) * 0.8);
  };
}

const SOURCE_BUILDERS = {
  noise(g, L, inp, nodes) {
    const n = makeNoise(g.ctx, g.s[lk(L, 'color')], nodes);
    n.out.connect(inp);
    return (s, set) => n.setWidth(s.width, set);
  },

  // Harmonics = 1 is a pure sine; more adds a 1/k series (toward a saw).
  tone(g, L, inp, nodes) {
    const { ctx } = g, oscs = [];
    let harm = g.s[lk(L, 'harm')];
    const voices = makeVoices(g, inp, nodes, (dest, pm) => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(toneWave(ctx, harm));
      const a = ctx.createGain(); a.gain.value = 0.45;
      o.connect(a); a.connect(dest); pm.connect(o.detune); o.start();
      nodes.push(o, a); oscs.push(o);
      return { setFreq: (f, set) => set(o.frequency, f) };
    });
    return (s, set) => {
      if (s[lk(L, 'harm')] !== harm) {
        harm = s[lk(L, 'harm')];
        oscs.forEach(o => o.setPeriodicWave(toneWave(ctx, harm)));
      }
      voices(s, set, layerRoot(s, L));
    };
  },

  // Additive partials, each breathing on its own wander.
  organ(g, L, inp, nodes) {
    const { ctx } = g, partials = [];
    const voices = makeVoices(g, inp, nodes, (dest, pm) => {
      const ps = ORGAN_PARTIALS.map(n => {
        const o = ctx.createOscillator();
        const a = ctx.createGain(); a.gain.value = 0;
        const w = g.wander(0.06 + Math.random() * 0.2, nodes); w.out.connect(a.gain);
        o.connect(a); a.connect(dest); pm.connect(o.detune); o.start();
        nodes.push(o, a);
        const p = { n, o, a, w }; partials.push(p);
        return p;
      });
      return { setFreq: (f, set) => ps.forEach(p => set(p.o.frequency, Math.min(20000, f * p.n))) };
    });
    return (s, set) => {
      const bright = s[lk(L, 'bright')], breathe = s[lk(L, 'breathe')];
      partials.forEach(p => {
        const amp = 0.4 * Math.pow(p.n, -(2.2 - 1.8 * bright));   // ranges amp·(1 − breathe) … amp
        set(p.a.gain, amp * (1 - breathe / 2));
        set(p.w.out.gain, amp * breathe / 2);
      });
      voices(s, set, layerRoot(s, L));
    };
  },

  // Saw ensemble or breath noise through parallel F1/F2/F3 bandpasses.
  choir(g, L, inp, nodes) {
    const { ctx, s } = g;
    const exc = ctx.createGain(); nodes.push(exc);
    let noise = null, voices = null;
    if (s[lk(L, 'exc')] === 'noise') {
      noise = makeNoise(ctx, s[lk(L, 'color')], nodes);
      noise.out.connect(exc);
      exc.gain.value = 1.5;
    } else {
      voices = makeVoices(g, exc, nodes, (dest, pm) => {
        const os = [-9, 0, 9].map(cents => {
          const o = ctx.createOscillator(); o.type = 'sawtooth'; o.detune.value = cents;
          const a = ctx.createGain(); a.gain.value = 0.33;
          o.connect(a); a.connect(dest); pm.connect(o.detune); o.start();
          nodes.push(o, a);
          return o;
        });
        return { setFreq: (f, set) => os.forEach(o => set(o.frequency, f)) };
      });
    }
    // Vowel position = constant + wander·morph, shaped per formant into detune
    const pos = ctx.createConstantSource(); pos.start();
    const morphW = g.wander(0.15, nodes); morphW.out.connect(pos.offset);
    nodes.push(pos);
    VOWELS.ah.forEach((f, i) => {
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = f; bp.Q.value = 7 + i * 3;
      const shaper = ctx.createWaveShaper(); shaper.curve = formantCurve(i);
      const cents = ctx.createGain(); cents.gain.value = 2400;
      const a = ctx.createGain(); a.gain.value = FORMANT_GAIN[i] * (noise ? 3 : 5);
      pos.connect(shaper); shaper.connect(cents); cents.connect(bp.detune);
      exc.connect(bp); bp.connect(a); a.connect(inp);
      nodes.push(bp, shaper, cents, a);
    });
    return (s, set) => {
      set(pos.offset, s[lk(L, 'vowel')] * 2 - 1);
      set(morphW.out.gain, s[lk(L, 'morph')]);
      if (noise) noise.setWidth(s.width, set);
      else voices(s, set, layerRoot(s, L));
    };
  },

  // Noise exciting high-Q bandpasses at harmonic → bar-mode ratios.
  resonator(g, L, inp, nodes) {
    const { ctx } = g, bands = [];
    const noise = makeNoise(ctx, g.s[lk(L, 'color')], nodes);
    const voices = makeVoices(g, inp, nodes, (dest, pm) => {
      const bs = BAR_RATIOS.map((_, i) => {
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
        const a = ctx.createGain(); a.gain.value = 0;
        noise.out.connect(bp); bp.connect(a); a.connect(dest); pm.connect(bp.detune);
        nodes.push(bp, a);
        const b = { n: i + 1, bp, a }; bands.push(b);
        return b;
      });
      return {
        setFreq: (f, set, s) => bs.forEach(b => set(b.bp.frequency, Math.min(20000, f * resonRatio(b.n, s[lk(L, 'inharm')])))),
      };
    }, false);
    return (s, set) => {
      const Q = resonQ(s[lk(L, 'q')]);
      // A bandpass passes ∝ 1/√Q of the noise: compensate so Q changes ring, not vanish
      bands.forEach(b => { set(b.bp.Q, Q); set(b.a.gain, 1.5 * Math.sqrt(Q) * Math.pow(b.n, -0.7)); });
      noise.setWidth(s.width, set);
      voices(s, set, layerRoot(s, L));
    };
  },

  // 50/60 Hz mains with flutter (wander on pitch and level). Ignores Pitch.
  hum(g, L, inp, nodes) {
    const { ctx } = g;
    const o = ctx.createOscillator(), amp = ctx.createGain();
    const flP = g.wander(3, nodes); flP.out.connect(o.detune);
    const flA = g.wander(1.5, nodes); flA.out.connect(amp.gain);
    o.connect(amp); amp.connect(inp); o.start();
    nodes.push(o, amp);
    let buzz = null;
    return (s, set) => {
      if (s[lk(L, 'buzz')] !== buzz) { buzz = s[lk(L, 'buzz')]; o.setPeriodicWave(humWave(ctx, buzz)); }
      const fl = s[lk(L, 'flutter')];
      set(o.frequency, s[lk(L, 'mains')]);
      set(flP.out.gain, fl * 25);
      set(amp.gain, 0.5 * (1 - fl * 0.35));
      set(flA.out.gain, 0.5 * fl * 0.35);
    };
  },

  sub(g, L, inp, nodes) {
    const o = g.ctx.createOscillator();
    const a = g.ctx.createGain(); a.gain.value = 0.85;
    o.connect(a); a.connect(inp); o.start();
    nodes.push(o, a);
    return (s, set) => set(o.frequency, midiToHz(s.pitch) / Math.pow(2, s.subOct));
  },
};

// Anything that needs new nodes goes in the key; a key change rebuilds the layer.
function layerKey(s, L) {
  if (!s[lk(L, 'on')]) return 'off';
  if (L === 'sub') return 'sub';
  const src = s[lk(L, 'src')], k = [src];
  if (usesNoise(s, L)) k.push(s[lk(L, 'color')]);
  if (src === 'choir') k.push(s[lk(L, 'exc')]);
  if (isVoiced(s, L)) k.push(s.interval);
  return k.join('|');
}

function disposeNodes(list) {
  list.forEach(n => {
    if (typeof n === 'function') { try { n(); } catch (_) {} return; }
    try { if (n.stop) n.stop(); } catch (_) {}
    try { n.disconnect(); } catch (_) {}
  });
}

// ── Events: sparse one-shots ──────────────────────────────────────────────
// Creaks, thuds, reversed swells, whispers, metal pings and drips, built from
// ordinary nodes per event. Every random choice comes from the `rand` passed
// in (a seeded generator), so a given seed yields the same events live and in
// a render. Variety scales how far each event strays from its type's centre.

const EVENT_TYPES = ['creak', 'thud', 'swell', 'whisper', 'ping', 'drip'];
const evFlag = t => 'ev' + t[0].toUpperCase() + t.slice(1);   // 'creak' → 'evCreak'
const eventRate = d => d < 0.01 ? 0 : Math.pow(15, d) / 40;    // events/s: 1 per 40 s … 1 per 2.7 s

function evKit(ctx, rand, v) {
  const nodes = [];
  const node = n => (nodes.push(n), n);
  return {
    nodes, rand, node,
    J: (c, oct) => c * Math.pow(2, (rand() * 2 - 1) * oct * v),   // centre ± up to `oct` octaves at full Variety
    pick: a => a[Math.floor(rand() * a.length)],
    gain(val = 0) { const g = node(ctx.createGain()); g.gain.value = val; return g; },
    osc(type, f) { const o = node(ctx.createOscillator()); o.type = type; o.frequency.value = f; return o; },
    filt(type, f, q) { const b = node(ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; b.Q.value = q; return b; },
    noise(color, t0, t1) {
      const n = node(ctx.createBufferSource());
      n.buffer = getNoiseBuffer(color); n.loop = true;
      n.start(t0, rand() * NOISE_SECS); n.stop(t1);
      return n;
    },
  };
}

// Each synth schedules one event at t0 into `out` and returns its end time.
const EVENT_SYNTHS = {
  // Stick-slip: a slow, irregular sawtooth click train through two resonances
  creak({ k, t0, g, out }) {
    const dur = k.J(1.4, 1);
    const o = k.osc('sawtooth', k.J(22, 0.7));
    let f = o.frequency.value;
    o.frequency.setValueAtTime(f, t0);
    const segs = 3 + Math.floor(k.rand() * 3);
    for (let i = 1; i <= segs; i++) {
      f = clamp(f * Math.pow(2, (k.rand() * 2 - 1) * 0.6), 8, 70);
      o.frequency.linearRampToValueAtTime(f, t0 + dur * i / segs);
    }
    const r = k.J(650, 0.8), b1 = k.filt('bandpass', r, 7), b2 = k.filt('bandpass', r * 2.3, 10);
    const hp = k.filt('highpass', 180, 0.7), env = k.gain();
    o.connect(b1); o.connect(b2); b1.connect(hp); b2.connect(hp); hp.connect(env); env.connect(out);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(g * 6, t0 + dur * 0.3);
    env.gain.linearRampToValueAtTime(g * 4.4, t0 + dur * 0.75);
    env.gain.linearRampToValueAtTime(0, t0 + dur);
    o.start(t0); o.stop(t0 + dur + 0.05);
    return t0 + dur + 0.05;
  },

  // Distant impact: a dropping sine body plus a short low-passed noise hit
  thud({ k, t0, g, out }) {
    const f = k.J(70, 0.5), dec = k.J(0.9, 0.7);
    const o = k.osc('sine', f * 1.8), env = k.gain();
    o.frequency.setValueAtTime(f * 1.8, t0);
    o.frequency.exponentialRampToValueAtTime(f, t0 + 0.08);
    o.connect(env); env.connect(out);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(g * 0.8, t0 + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0005, t0 + dec);
    const n = k.noise('brown', t0, t0 + dec), lp = k.filt('lowpass', k.J(260, 0.5), 0.7), ne = k.gain();
    n.connect(lp); lp.connect(ne); ne.connect(out);
    ne.gain.setValueAtTime(0, t0);
    ne.gain.linearRampToValueAtTime(g * 0.6, t0 + 0.004);
    ne.gain.exponentialRampToValueAtTime(0.0005, t0 + 0.12 + dec * 0.2);
    o.start(t0); o.stop(t0 + dec + 0.05);
    return t0 + dec + 0.05;
  },

  // Reversed swell: rising noise sweep plus a chord tone, cut off abruptly
  swell({ k, t0, g, out, base }) {
    const dur = k.J(3, 0.6);
    const f0 = k.J(300, 0.6), f1 = f0 * k.J(10, 0.5);
    const n = k.noise('pink', t0, t0 + dur + 0.05), bp = k.filt('bandpass', f0, 1.2), env = k.gain();
    bp.frequency.setValueAtTime(f0, t0);
    bp.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const o = k.osc('triangle', base * k.pick([2, 3, 4])), og = k.gain(0.3);
    n.connect(bp); bp.connect(env); o.connect(og); og.connect(env); env.connect(out);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(g * 2.6, t0 + dur);
    env.gain.linearRampToValueAtTime(0, t0 + dur + 0.035);
    o.start(t0); o.stop(t0 + dur + 0.05);
    return t0 + dur + 0.05;
  },

  // Whisper: noise through gliding vowel formants, pulsed into syllables
  whisper({ k, t0, g, out }) {
    const dur = k.J(1.6, 0.6);
    const va = VOWELS[k.pick(['oo', 'ah', 'ee'])], vb = VOWELS[k.pick(['oo', 'ah', 'ee'])];
    const n = k.noise('white', t0, t0 + dur), hp = k.filt('highpass', 250, 0.7), am = k.gain(0.6);
    n.connect(hp);
    const lfo = k.osc('sine', k.J(4.5, 0.5)), lg = k.gain(0.4);
    lfo.connect(lg); lg.connect(am.gain);
    [0, 1, 2].forEach(i => {
      const b = k.filt('bandpass', va[i], 12), fg = k.gain(FORMANT_GAIN[i]);
      b.frequency.setValueAtTime(va[i], t0);
      b.frequency.linearRampToValueAtTime(vb[i] * k.J(1, 0.15), t0 + dur);
      hp.connect(b); b.connect(fg); fg.connect(am);
    });
    const env = k.gain();
    am.connect(env); env.connect(out);
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(g * 12, t0 + 0.2);
    env.gain.setValueAtTime(g * 12, t0 + dur - 0.35);
    env.gain.linearRampToValueAtTime(0, t0 + dur);
    lfo.start(t0); lfo.stop(t0 + dur);
    return t0 + dur;
  },

  // Struck metal or pipe, tuned to the root: decaying sine partials
  ping({ k, t0, g, out, base }) {
    const ratios = k.rand() < 0.6 ? BAR_RATIOS.slice(0, 4) : [1, 2, 3, 4.01];
    const f = base * k.pick([2, 4, 8]) * k.J(1, 0.1), ring = k.J(3.5, 0.6);
    ratios.forEach((r, i) => {
      if (f * r > 16000) return;
      const o = k.osc('sine', f * r), e = k.gain(), d = ring / (1 + i * 0.7);
      o.connect(e); e.connect(out);
      e.gain.setValueAtTime(0, t0);
      e.gain.linearRampToValueAtTime(g * 0.9 / (i + 1), t0 + 0.002);
      e.gain.exponentialRampToValueAtTime(0.0003, t0 + d);
      o.start(t0); o.stop(t0 + d + 0.05);
    });
    return t0 + ring + 0.05;
  },

  // Water drop: a tiny upward-chirping sine, sometimes with a quieter second drop
  drip({ k, t0, g, out }, second = false) {
    const f = k.J(1000, 0.6), dec = k.J(0.08, 0.4);
    const o = k.osc('sine', f), e = k.gain();
    o.frequency.setValueAtTime(f, t0);
    o.frequency.exponentialRampToValueAtTime(f * 2.2, t0 + dec * 0.6);
    o.connect(e); e.connect(out);
    e.gain.setValueAtTime(0, t0);
    e.gain.linearRampToValueAtTime(g * 1.6, t0 + 0.002);
    e.gain.exponentialRampToValueAtTime(0.0003, t0 + dec);
    o.start(t0); o.stop(t0 + dec + 0.02);
    if (!second && k.rand() < 0.35) {
      return EVENT_SYNTHS.drip({ k, t0: t0 + k.J(0.25, 0.5), g: g * 0.5, out }, true);
    }
    return t0 + dec + 0.02;
  },
};

// ── Graph builder (live + offline) ────────────────────────────────────────

// opts.eventsAt: when the event timeline starts (a render passes its pre-roll,
// so its events line up with what played after pressing Play).
function buildGraph(ctx, s, opts = {}) {
  const bufs = getWanderBuffers();
  const persistent = [];                    // scheduled sources living as long as the graph

  const output = ctx.createGain();
  const master = ctx.createGain();
  master.gain.value = 0;                    // ramps up on first update → no click on start
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -2; limiter.knee.value = 0; limiter.ratio.value = 20;
  limiter.attack.value = 0.002; limiter.release.value = 0.2;
  master.connect(limiter); limiter.connect(output);

  const bus = ctx.createGain();
  const wow = ctx.createDelay(0.05); wow.delayTime.value = WOW_BASE;
  const tape = ctx.createBiquadFilter(); tape.type = 'lowpass'; tape.Q.value = 0.5;
  const dark = ctx.createBiquadFilter(); dark.type = 'lowpass';
  const ageSat = ctx.createWaveShaper(); ageSat.oversample = '2x';
  const grit = ctx.createWaveShaper(); grit.oversample = '4x';
  const trem = ctx.createGain(); trem.gain.value = 0;
  const breath = ctx.createGain(); breath.gain.value = 0;
  const dry = ctx.createGain();

  bus.connect(wow); wow.connect(tape); tape.connect(dark); dark.connect(ageSat);
  ageSat.connect(grit); grit.connect(trem); trem.connect(breath);
  breath.connect(dry); dry.connect(master);
  // breath also feeds the echo and the reverb, set up below

  function wander(rate, list) {
    const src = ctx.createBufferSource();
    src.buffer = bufs[Math.floor(Math.random() * bufs.length)];
    src.loop = true;
    src.playbackRate.value = rate;
    const out = ctx.createGain(); out.gain.value = 0;
    src.connect(out);
    src.start(0, Math.random() * WANDER_SECS);
    list.push(src, out);
    return { src, out };
  }
  function lfo(rate) {
    const src = ctx.createOscillator(); src.frequency.value = rate;
    const out = ctx.createGain(); out.gain.value = 0;
    src.connect(out); src.start();
    persistent.push(src, out);
    return { src, out };
  }
  function constant(v) {
    const c = ctx.createConstantSource(); c.offset.value = v; c.start();
    persistent.push(c);
    return c;
  }

  // Movement: wander → filter detune (cents, so it sweeps evenly at any cutoff)
  const moveW = wander(0.6, persistent); moveW.out.connect(dark.detune);

  // Tremolo: gain = bias + mod, ranging [1 − depth, 1]
  const tremBias = constant(1); tremBias.connect(trem.gain);
  const tremSine = lfo(s.tremoloRate); tremSine.out.connect(trem.gain);
  const tremWander = wander(s.tremoloRate, persistent); tremWander.out.connect(trem.gain);

  // Breath: slow wandering amplitude swells
  const breathBias = constant(1); breathBias.connect(breath.gain);
  const breathW = wander(0.3, persistent); breathW.out.connect(breath.gain);

  // Vibrato bus → every voice's pitch-mod bus
  const vib = ctx.createGain();
  const vibSine = lfo(s.vibratoRate); vibSine.out.connect(vib);
  const vibWander = wander(s.vibratoRate, persistent); vibWander.out.connect(vib);
  persistent.push(vib);

  // Age noise floor
  const ageNoiseGain = ctx.createGain(); ageNoiseGain.gain.value = 0; ageNoiseGain.connect(master);
  const ageNoise = makeNoise(ctx, 'white', persistent);
  ageNoise.setWidth(1, (param, v) => { param.value = v; });
  ageNoise.out.connect(ageNoiseGain);

  // Wow & flutter: slow wander + fast sine/wander on the short tape delay
  const wowW = wander(0.5, persistent); wowW.out.connect(wow.delayTime);
  const flutS = lfo(6.3); flutS.out.connect(wow.delayTime);
  const flutW = wander(12, persistent); flutW.out.connect(wow.delayTime);

  // Vinyl crackle, after the colour chain like the hiss
  const crackle = ctx.createBufferSource();
  crackle.buffer = getCrackleBuffer(); crackle.loop = true;
  const crackleLP = ctx.createBiquadFilter(); crackleLP.type = 'lowpass'; crackleLP.frequency.value = 6000;
  const crackleGain = ctx.createGain(); crackleGain.gain.value = 0;
  crackle.connect(crackleLP); crackleLP.connect(crackleGain); crackleGain.connect(master);
  crackle.start(0, Math.random() * CRACKLE_SECS);
  persistent.push(crackle, crackleLP, crackleGain);

  // ── Tape echo: delay → low-pass → high-pass → soft clip → feedback ──
  // Each repeat is darker than the last; wander keeps the time unsteady.
  const echo = ctx.createDelay(2); echo.delayTime.value = echoSecs(s.echoTime);
  const echoLP = ctx.createBiquadFilter(); echoLP.type = 'lowpass'; echoLP.frequency.value = 2400; echoLP.Q.value = -3;
  const echoHP = ctx.createBiquadFilter(); echoHP.type = 'highpass'; echoHP.frequency.value = 120; echoHP.Q.value = -3;
  const echoSat = ctx.createWaveShaper(); echoSat.curve = ECHO_CURVE;
  const echoFb = ctx.createGain(); echoFb.gain.value = 0;
  const echoOut = ctx.createGain(); echoOut.gain.value = 0;
  breath.connect(echo); echo.connect(echoLP); echoLP.connect(echoHP); echoHP.connect(echoSat);
  echoSat.connect(echoFb); echoFb.connect(echo);
  echoSat.connect(echoOut); echoOut.connect(master);
  const echoW = wander(0.3, persistent); echoW.out.connect(echo.delayTime);
  persistent.push(echo, echoLP, echoHP, echoSat, echoFb, echoOut);

  // ── Reverb: pre-delay → two convolvers ──
  // A new IR (Size / Damping) loads into the idle convolver, which takes over
  // the input; the old one keeps ringing out its own tail, so nothing clicks.
  const verbIn = ctx.createGain(), preDelay = ctx.createDelay(1), verbOut = ctx.createGain();
  const wet = ctx.createGain(), wetGate = ctx.createGain();
  preDelay.delayTime.value = s.preDelay;
  breath.connect(verbIn); echoOut.connect(verbIn); verbIn.connect(preDelay);
  verbOut.connect(wet); wet.connect(wetGate); wetGate.connect(master);
  persistent.push(verbIn, preDelay, verbOut, wet, wetGate);
  const convs = [0, 1].map(() => {
    const conv = ctx.createConvolver(), g = ctx.createGain();
    conv.connect(g); g.connect(verbOut);
    persistent.push(conv, g);
    return { conv, g, ringUntil: 0 };
  });
  let activeConv = 1, irKey = null, irWanted = null, irTimer = 0;

  function loadIR() {
    const [size, damp] = irWanted.split('|').map(Number);
    const next = convs[1 - activeConv], cur = convs[activeConv], now = ctx.currentTime;
    next.conv.buffer = getReverbIR(size, damp);
    next.g.gain.cancelScheduledValues(now); next.g.gain.setValueAtTime(1, now);
    preDelay.connect(next.conv);
    if (irKey !== null) { preDelay.disconnect(cur.conv); cur.ringUntil = now + cur.conv.buffer.duration; }
    activeConv = 1 - activeConv;
    irKey = irWanted;
  }
  function requestIR() {
    const key = irKeyOf(s.verbSize, s.verbDamp);
    if (key === irWanted) return;
    irWanted = key;
    if (irKey === null) { loadIR(); return; }    // first build is synchronous, so renders get it too
    clearTimeout(irTimer);
    irTimer = setTimeout(function tryLoad() {    // live only: debounced while a slider moves
      const idle = convs[1 - activeConv];
      if (ctx.currentTime < idle.ringUntil) {    // still ringing from an earlier swap: fade it first
        idle.g.gain.setTargetAtTime(0, ctx.currentTime, 0.06);
        idle.ringUntil = 0;
        irTimer = setTimeout(tryLoad, 350);
        return;
      }
      if (irWanted !== irKey) loadIR();
    }, 200);
  }

  // Shimmer: reverb out → octave down → back into the reverb, so each pass
  // sinks another octave into the tail. Filters keep it from turning to mud.
  const shimSend = ctx.createGain(); shimSend.gain.value = 0;
  const shift = makeOctaveDown(ctx, persistent);
  const shimHP = ctx.createBiquadFilter(); shimHP.type = 'highpass'; shimHP.frequency.value = 90; shimHP.Q.value = -3;
  const shimLP = ctx.createBiquadFilter(); shimLP.type = 'lowpass'; shimLP.frequency.value = 3500; shimLP.Q.value = -3;
  verbOut.connect(shimSend); shimSend.connect(shift.input); shift.output.connect(shimHP);
  shimHP.connect(shimLP); shimLP.connect(verbIn);
  persistent.push(shimSend, shimHP, shimLP);

  // ── Freeze: four parallel long feedback loops ──
  // Off, they just listen to the reverb (no feedback). On, feedback goes to ~1
  // while their input fades out over ~2 s, so each loop captures a stretch of
  // the tail crossfaded into itself; four incommensurate lengths never line up.
  // (They stay independent: Chrome's cross-coupled delay cycles are unstable.)
  const freezeIn = ctx.createGain(), freezeSum = ctx.createGain(), freezeGate = ctx.createGain(), freezeLvl = ctx.createGain();
  freezeGate.gain.value = 0;
  freezeSum.gain.value = FREEZE_NORM;
  const freezeHP = ctx.createBiquadFilter(); freezeHP.type = 'highpass'; freezeHP.frequency.value = 40;
  verbOut.connect(freezeIn); freezeIn.connect(freezeHP);
  freezeSum.connect(freezeGate); freezeGate.connect(freezeLvl); freezeLvl.connect(master);
  persistent.push(freezeIn, freezeSum, freezeGate, freezeLvl, freezeHP);
  const loops = FREEZE_LOOPS.map(t => {
    const d = ctx.createDelay(4); d.delayTime.value = t;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000; lp.Q.value = -6;
    const fb = ctx.createGain(); fb.gain.value = 0;
    freezeHP.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); d.connect(freezeSum);
    const w = wander(0.2, persistent); w.out.gain.value = 0.0015; w.out.connect(d.delayTime);
    persistent.push(d, lp, fb);
    return fb.gain;
  });

  let frozen = false;
  function setFreeze(on, at) {
    frozen = on;
    [freezeIn.gain, freezeGate.gain, wetGate.gain, ...loops].forEach(p => p.cancelScheduledValues(at));
    if (on) {
      loops.forEach(p => p.setValueAtTime(FREEZE_FB, at));
      freezeIn.gain.setTargetAtTime(1, at, 0.05);             // (in case a quick re-freeze caught it closed)
      freezeIn.gain.setTargetAtTime(0, at + 0.15, 0.6);
      freezeGate.gain.setTargetAtTime(1, at, 0.3);
      wetGate.gain.setTargetAtTime(0, at, 0.6);
    } else {
      freezeGate.gain.setTargetAtTime(0, at, 0.5);
      wetGate.gain.setTargetAtTime(1, at, 0.3);
      loops.forEach(p => p.setTargetAtTime(0, at, 0.8));      // let go, then back to listening
      freezeIn.gain.setTargetAtTime(1, at + 1, 0.3);
    }
  }
  // Starting frozen (a render, or play while Freeze is on) lets the tail build first
  if (s.freeze) setFreeze(true, ctx.currentTime + FREEZE_START);

  // ── Events: distance filter + their own room, joining after Darkness ──
  // (they have Distance for that), so they still get age, grit, tremolo,
  // breath and the main reverb like everything else.
  const offline = ctx instanceof OfflineAudioContext;
  const evIn = ctx.createGain();
  const evLP = ctx.createBiquadFilter(); evLP.type = 'lowpass'; evLP.Q.value = 0.5;
  const evDry = ctx.createGain(); evDry.gain.value = 0;
  const evSend = ctx.createGain(); evSend.gain.value = 0;
  const evVerb = ctx.createConvolver(); evVerb.buffer = getReverbIR(0.6, 0.55);
  evIn.connect(evLP); evLP.connect(evDry); evDry.connect(ageSat);
  evLP.connect(evSend); evSend.connect(evVerb); evVerb.connect(ageSat);
  persistent.push(evIn, evLP, evDry, evSend, evVerb);

  const evSeedOf = seed => mulberry32(seed * 7919 + 17);
  let evSeed = s.eventSeed, evRand = evSeedOf(evSeed), evNext = null, evTimer = 0;
  const evOrigin = offline ? (opts.eventsAt || 0) : ctx.currentTime;
  const evTypesOn = () => EVENT_TYPES.filter(t => s[evFlag(t)]);

  function fireEvent(t0, rand, types) {
    const k = evKit(ctx, rand, s.evVariety);
    const type = k.pick(types);
    const pan = k.node(ctx.createStereoPanner());
    pan.pan.value = (rand() * 2 - 1) * 0.85;
    pan.connect(evIn);
    const g = 0.45 * Math.pow(10, -rand() * 12 * s.evVariety / 20);
    const end = EVENT_SYNTHS[type]({ k, t0, g, out: pan, base: midiToHz(s.pitch) });
    if (!offline) setTimeout(() => disposeNodes(k.nodes), (end - ctx.currentTime) * 1000 + 300);
  }

  // Poisson arrivals from the seeded generator, scheduled up to tEnd.
  function scheduleEvents(tEnd) {
    const types = evTypesOn(), rate = types.length ? eventRate(s.evDensity) : 0;
    if (!rate) { evNext = null; return; }
    if (evNext === null) evNext = Math.max(evOrigin, ctx.currentTime) + 0.3 - Math.log(1 - evRand()) / rate;
    while (evNext < tEnd) {
      if (evNext > ctx.currentTime) fireEvent(evNext, evRand, types);   // (skips any a throttled tab missed)
      evNext -= Math.log(1 - evRand()) / rate;
    }
  }

  // Fire one now (live): uses its own randomness, so the seeded pattern is untouched
  function trigger() {
    const types = evTypesOn();
    fireEvent(ctx.currentTime + 0.02, Math.random, types.length ? types : EVENT_TYPES);
  }

  // ── Layers: source → high-pass → low-pass → pan → level ──
  // Muted layers aren't built at all, so they cost nothing.
  const layers = {};

  function buildLayer(L, key) {
    const nodes = [];
    const inp = ctx.createGain();
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.707;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.707;
    const pan = ctx.createStereoPanner();
    const out = ctx.createGain(); out.gain.value = 0;
    inp.connect(hp); hp.connect(lp); lp.connect(pan); pan.connect(out);
    out.connect(L === 'sub' ? master : bus);   // sub skips the colour chain, as before
    nodes.push(inp, hp, lp, pan, out);
    const builder = SOURCE_BUILDERS[L === 'sub' ? 'sub' : s[lk(L, 'src')]];
    const update = builder({ ctx, s, wander, vib }, L, inp, nodes);
    return { key, nodes, hp, lp, pan, out, update, fresh: true };
  }

  function disposeLayer(ly, fade = 0.03) {
    if (!ly.nodes) return;
    ly.out.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
    setTimeout(() => disposeNodes(ly.nodes), fade * 1000 + 60);
  }

  // ── Parameter update ──
  // key: the single parameter that changed (undefined → apply everything)
  function update(next, key) {
    s = next;
    const now = ctx.currentTime, T = 0.05;
    const set = (param, v) => param.setTargetAtTime(v, now, T);
    const setNow = (param, v) => param.setValueAtTime(v, now);   // fresh nodes: no glide from defaults

    set(master.gain, s.volume);
    set(dark.frequency, darknessToHz(s.darkness));
    set(dark.Q, 0.5 + s.resonance * 14.5);
    set(moveW.out.gain, s.movement * 2400);

    ALL_LAYERS.forEach(L => {
      const lkey = layerKey(s, L);
      let ly = layers[L];
      if (!ly || ly.key !== lkey) {
        if (ly) disposeLayer(ly);
        ly = layers[L] = lkey === 'off' ? { key: lkey } : buildLayer(L, lkey);
      }
      if (!ly.update) return;
      const sv = ly.fresh ? setNow : set;
      const f = s[lk(L, 'filter')];
      sv(ly.lp.frequency, lpHz(f));
      sv(ly.hp.frequency, hpHz(f));
      sv(ly.pan.pan, s[lk(L, 'pan')]);
      set(ly.out.gain, s[lk(L, 'level')]);       // always glides: fades a new layer in
      ly.update(s, sv);
      ly.fresh = false;
    });

    if (key === undefined || key === 'grit') grit.curve = s.grit < 0.01 ? null : softClipCurve(s.grit * 100);
    if (key === undefined || key === 'age') ageSat.curve = s.age < 0.01 ? null : softClipCurve(s.age * 15);

    set(dry.gain, 1 - s.space * 0.65);
    set(wet.gain, s.space * 0.65);
    set(freezeLvl.gain, Math.max(s.space, 0.4) * 0.65);
    set(preDelay.delayTime, s.preDelay);
    set(shimSend.gain, s.shimmer * SHIMMER_MAX);
    requestIR();
    if (!!s.freeze !== frozen) setFreeze(!!s.freeze, now);

    const et = echoSecs(s.echoTime);
    echo.delayTime.setTargetAtTime(et, now, 0.25);   // slow glide: the tape-speed swoop
    set(echoW.out.gain, et * 0.004);
    set(echoFb.gain, s.echoFeedback);
    set(echoOut.gain, s.echoMix * 0.5);

    set(wowW.out.gain, s.wow * 0.004);
    set(flutS.out.gain, s.wow * 0.00012);
    set(flutW.out.gain, s.wow * 0.0001);
    set(crackleGain.gain, Math.pow(s.crackle, 1.5) * 0.4);

    const wanderShape = s.modShape === 'wander';
    set(vibSine.src.frequency, s.vibratoRate);
    set(vibWander.src.playbackRate, s.vibratoRate);
    set(vibSine.out.gain, wanderShape ? 0 : s.vibratoDepth * 100);
    set(vibWander.out.gain, wanderShape ? s.vibratoDepth * 100 : 0);

    set(tremSine.src.frequency, s.tremoloRate);
    set(tremWander.src.playbackRate, s.tremoloRate);
    set(tremBias.offset, 1 - s.tremoloDepth / 2);
    set(tremSine.out.gain, wanderShape ? 0 : s.tremoloDepth / 2);
    set(tremWander.out.gain, wanderShape ? s.tremoloDepth / 2 : 0);

    set(breathBias.offset, 1 - s.breath / 2);
    set(breathW.out.gain, s.breath / 2);

    set(tape.frequency, 8000 - s.age * 4000);
    set(ageNoiseGain.gain, s.age * 0.015);

    set(evLP.frequency, 16000 * Math.pow(700 / 16000, s.evDistance));
    set(evDry.gain, s.evLevel * (1 - 0.75 * s.evDistance));
    set(evSend.gain, s.evLevel * (0.2 + 0.9 * s.evDistance));
    if (s.eventSeed !== evSeed) { evSeed = s.eventSeed; evRand = evSeedOf(evSeed); evNext = null; }
    else if (key === 'evDensity' || EVENT_TYPES.some(t => evFlag(t) === key)) evNext = null;   // re-draw the wait at the new rate
  }

  function dispose(fade = 0.08) {
    clearInterval(evTimer);
    clearTimeout(irTimer);
    master.gain.setTargetAtTime(0, ctx.currentTime, fade / 3);
    setTimeout(() => {
      Object.values(layers).forEach(ly => ly.nodes && disposeNodes(ly.nodes));
      disposeNodes(persistent);
      output.disconnect();
    }, fade * 1000 + 60);
  }

  update(s);
  if (offline) scheduleEvents(ctx.length / ctx.sampleRate);           // the whole timeline, up front
  else {
    scheduleEvents(ctx.currentTime + 1.2);
    evTimer = setInterval(() => scheduleEvents(ctx.currentTime + 1.2), 250);
  }
  return { output, limiter, update, dispose, trigger };
}

// ── Live engine ───────────────────────────────────────────────────────────

let audioCtx = null, analyser = null, recorder = null, graph = null;

async function ensureContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext({ sampleRate: SR });
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.6;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -25;
    analyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  if (!recorder) recorder = await createRecorder(audioCtx, onRecorderChunk, finishCapture);
}

async function togglePlay() {
  const btn = document.getElementById('play-btn');
  if (state.playing) {
    if (capture) stopCapture();
    graph.dispose();
    graph = null;
    state.playing = false;
    btn.querySelector('.play-label').textContent = 'Play';
    btn.querySelector('.play-icon').textContent = '▶';
    btn.classList.remove('active');
    stopVisuals();
    return;
  }
  btn.classList.add('loading');
  try {
    await ensureContext();
    graph = buildGraph(audioCtx, state);
    graph.output.connect(analyser);
    graph.output.connect(recorder.input);
    state.playing = true;
    btn.querySelector('.play-label').textContent = 'Stop';
    btn.querySelector('.play-icon').textContent = '■';
    btn.classList.add('active');
    startVisuals();
  } catch (e) {
    showError('Could not start audio: ' + e.message);
  } finally {
    btn.classList.remove('loading');
  }
}

// ── Performance capture (free length, stereo) ─────────────────────────────

let capture = null;

async function toggleCapture() {
  if (capture) { stopCapture(); return; }
  if (!state.playing) await togglePlay();
  if (!state.playing) return;
  capture = { L: [], R: [], t0: performance.now(), timer: setInterval(updateCaptureBtn, 250), stopping: false };
  recorder.start();
  updateCaptureBtn();
}

function stopCapture() {
  if (!capture || capture.stopping) return;
  capture.stopping = true;
  recorder.stop();                            // recorder flushes, then calls finishCapture
}

function onRecorderChunk(l, r) {
  if (!capture) return;
  capture.L.push(l);
  capture.R.push(r);
}

function finishCapture() {
  if (!capture) return;
  const { L, R, timer } = capture;
  clearInterval(timer);
  capture = null;
  updateCaptureBtn();
  if (!L.length) return;
  const secs = Math.round(L.reduce((n, c) => n + c.length, 0) / audioCtx.sampleRate);
  downloadWAV([concat(L), concat(R)], audioCtx.sampleRate, `capture-${describe()}-${secs}s.wav`);
}

function updateCaptureBtn() {
  const btn = document.getElementById('record-btn');
  if (!capture) {
    btn.textContent = '⏺ Capture';
    btn.classList.remove('recording');
    return;
  }
  const t = Math.floor((performance.now() - capture.t0) / 1000);
  btn.textContent = `⏹ ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  btn.classList.add('recording');
}

// ── Offline render ────────────────────────────────────────────────────────

async function renderAudio({ duration, loop, fade, normalize }) {
  const pre = state.freeze ? FREEZE_START + 4.5 : 3; // discard start-up so the file begins "already playing" (and fully frozen)
  const xf = loop ? Math.min(4, duration / 4) : 0;    // crossfade length for seamless loops
  const off = new OfflineAudioContext(2, Math.ceil((pre + duration + xf) * SR), SR);
  buildGraph(off, { ...state }, { eventsAt: pre }).output.connect(off.destination);
  const buf = await off.startRendering();

  const n = Math.round(duration * SR), p = Math.round(pre * SR), x = Math.round(xf * SR);
  const srcs = [0, 1].map(c => buf.getChannelData(c));
  const chans = srcs.map(src => src.slice(p, p + n));

  // Crossfade the tail (past the loop point) into the head, so sample n−1 is
  // followed seamlessly by sample 0. Equal-power sin/cos only holds level for
  // uncorrelated material; tonal partials are phase-coherent and partly cancel
  // (or reinforce). So per short block, measure head/tail power and correlation
  // (both channels together, keeping the image) and scale the mix to the power
  // an uncorrelated crossfade would give. The gain is 1 at both ends of the
  // fade and interpolated between block centres, so the seam stays clean.
  if (x > 0) {
    const B = 2048, nb = Math.ceil(x / B);
    const kx = [0], ky = [1];                          // gain anchors (sample → gain)
    for (let b = 0; b < nb; b++) {
      const i0 = b * B, i1 = Math.min(x, i0 + B);
      let pa = 0, pb = 0, cab = 0;
      for (const src of srcs) {
        for (let i = i0; i < i1; i++) {
          const a = src[p + i], t = src[p + n + i];
          pa += a * a; pb += t * t; cab += a * t;
        }
      }
      const th = ((i0 + i1) / 2 / x) * Math.PI / 2, ga = Math.sin(th), gb = Math.cos(th);
      const want = ga * ga * pa + gb * gb * pb;
      const got = want + 2 * ga * gb * cab;
      kx.push((i0 + i1) / 2);
      ky.push(got > 1e-12 ? clamp(Math.sqrt(want / got), 0.5, 4) : 1);
    }
    kx.push(x); ky.push(1);
    srcs.forEach((src, c) => {
      const o = chans[c];
      for (let i = 0, j = 0; i < x; i++) {
        while (kx[j + 1] < i) j++;
        const k = ky[j] + (ky[j + 1] - ky[j]) * (i - kx[j]) / (kx[j + 1] - kx[j]);
        const th = (i / x) * Math.PI / 2;
        o[i] = k * (src[p + i] * Math.sin(th) + src[p + n + i] * Math.cos(th));
      }
    });
  }

  if (fade && !loop) {
    const fi = Math.round(1.5 * SR), fo = Math.round(3 * SR);
    chans.forEach(o => {
      for (let i = 0; i < fi; i++) o[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fi);
      for (let i = 0; i < fo; i++) o[n - 1 - i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / fo);
    });
  }

  if (normalize) {
    let peak = 0;
    chans.forEach(o => { for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(o[i])); });
    if (peak > 0) {
      const g = Math.pow(10, -1 / 20) / peak;
      chans.forEach(o => { for (let i = 0; i < n; i++) o[i] *= g; });
    }
  }
  return chans;
}

async function exportAudio() {
  const duration = parseInt(document.getElementById('duration').value, 10);
  const loop = document.getElementById('opt-loop').checked;
  const fade = document.getElementById('opt-fade').checked;
  const normalize = document.getElementById('opt-normalize').checked;
  const chans = await renderAudio({ duration, loop, fade, normalize });
  downloadWAV(chans, SR, `${describe()}-${duration}s${loop ? '-loop' : ''}.wav`);
}

// ── WAV encoding / download ───────────────────────────────────────────────

function concat(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  chunks.forEach(c => { out.set(c, o); o += c.length; });
  return out;
}

function encodeWAV(chans, sr, bits = 24) {
  const nc = chans.length, n = chans[0].length, bps = bits / 8, block = nc * bps;
  const buf = new ArrayBuffer(44 + n * block);
  const v = new DataView(buf), bytes = new Uint8Array(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * block, true);
  str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * block, true);
  v.setUint16(32, block, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, n * block, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const s = clamp(chans[c][i], -1, 1);
      if (bits === 24) {
        const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7FFFFF);
        bytes[o] = x & 255; bytes[o + 1] = (x >> 8) & 255; bytes[o + 2] = (x >> 16) & 255;
      } else {
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      }
      o += bps;
    }
  }
  return buf;
}

function downloadWAV(chans, sr, filename) {
  const url = URL.createObjectURL(new Blob([encodeWAV(chans, sr)], { type: 'audio/wav' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function describe() {
  const on = ALL_LAYERS.filter(L => state[lk(L, 'on')]);
  if (!on.length) return 'silence';
  const names = on.map(L => L === 'sub' ? 'sub' : state[lk(L, 'src')] === 'noise' ? state[lk(L, 'color')] : state[lk(L, 'src')]);
  const pitched = on.some(L => L === 'sub' || isVoiced(state, L));
  return [...new Set(names)].join('-') + (pitched ? '-' + noteName(state.pitch) : '');
}

// ── Visualization: scrolling spectrogram + peak meter ─────────────────────
// Runs only while playing, throttled to ~30 fps, one 1-px column per frame.

const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');
const SPEC_LUT = (() => {
  const stops = [[0, [8, 11, 18]], [0.35, [18, 52, 70]], [0.7, [80, 160, 180]], [1, [232, 240, 236]]];
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * f;
  }
  return lut;
})();
const freqData = new Uint8Array(2048);
const timeData = new Float32Array(4096);
let specCol = null, rowBin = null, rafId = 0, lastDraw = 0;
let meterFill = null, limitBadge = null;

function resizeCanvas() {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(r.width));
  canvas.height = Math.max(1, Math.floor(r.height));
  const H = canvas.height;
  specCol = canvasCtx.createImageData(1, H);
  rowBin = new Uint16Array(H);
  for (let y = 0; y < H; y++) {
    const f = 30 * Math.pow(12000 / 30, (H - 1 - y) / Math.max(1, H - 1));
    rowBin[y] = Math.min(2047, Math.round(f / (SR / 2) * 2048));
  }
  clearCanvas();
}

function clearCanvas() {
  canvasCtx.fillStyle = '#080b12';
  canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
  if (!state.playing) {
    canvasCtx.fillStyle = '#2a3a4c';
    canvasCtx.font = '12px Inter, system-ui, sans-serif';
    canvasCtx.textAlign = 'center';
    canvasCtx.fillText('Space to play', canvas.width / 2, canvas.height / 2 + 4);
  }
}

function drawFrame(ts) {
  rafId = requestAnimationFrame(drawFrame);
  if (ts - lastDraw < 33) return;
  lastDraw = ts;
  const W = canvas.width, H = canvas.height;

  analyser.getByteFrequencyData(freqData);
  canvasCtx.drawImage(canvas, -1, 0);
  const d = specCol.data;
  for (let y = 0; y < H; y++) {
    const li = freqData[rowBin[y]] * 3, o = y * 4;
    d[o] = SPEC_LUT[li]; d[o + 1] = SPEC_LUT[li + 1]; d[o + 2] = SPEC_LUT[li + 2]; d[o + 3] = 255;
  }
  canvasCtx.putImageData(specCol, W - 1, 0);

  analyser.getFloatTimeDomainData(timeData);
  let peak = 0;
  for (let i = 0; i < timeData.length; i++) peak = Math.max(peak, Math.abs(timeData[i]));
  const db = 20 * Math.log10(peak + 1e-9);
  meterFill.style.transform = `scaleX(${clamp((db + 60) / 60, 0, 1)})`;
  limitBadge.classList.toggle('on', !!graph && graph.limiter.reduction < -2);
}

function startVisuals() {
  if (rafId) return;
  clearCanvas();
  rafId = requestAnimationFrame(drawFrame);
}

function stopVisuals() {
  cancelAnimationFrame(rafId);
  rafId = 0;
  meterFill.style.transform = 'scaleX(0)';
  limitBadge.classList.remove('on');
  clearCanvas();
}

// ── State, defaults & presets ─────────────────────────────────────────────

// Prefix a layer's params: ly('bed', { level: 1 }) → { bedLevel: 1 }
const ly = (L, o) => Object.fromEntries(Object.entries(o).map(([p, v]) => [lk(L, p), v]));

const LAYER_DEFAULTS = {
  on: false, src: 'noise', level: 0.7, filter: 0, pan: 0, oct: 0,
  color: 'pink', harm: 1, bright: 0.4, breathe: 0.5,
  exc: 'saw', vowel: 0.5, morph: 0.3, inharm: 0.5, q: 0.5,
  mains: 60, buzz: 0.4, flutter: 0.2,
};

const DEFAULTS = {
  volume: 0.7, darkness: 0.4, resonance: 0, movement: 0.2, width: 0.5,
  pitch: 45, interval: 'unison', beat: 0, drift: 0,
  grit: 0, space: 0, age: 0, wow: 0, crackle: 0, breath: 0,
  verbSize: 0.5, verbDamp: 0.3, preDelay: 0.02, shimmer: 0, freeze: false,
  echoTime: 0.6, echoFeedback: 0.4, echoMix: 0,
  evDensity: 0, evLevel: 0.6, evDistance: 0.5, evVariety: 0.6, eventSeed: 1,
  evCreak: true, evThud: true, evSwell: true, evWhisper: true, evPing: true, evDrip: false,
  modShape: 'sine', vibratoRate: 1.5, vibratoDepth: 0, tremoloRate: 4, tremoloDepth: 0,
  ...ly('bed', { ...LAYER_DEFAULTS, on: true }),
  ...ly('tone', { ...LAYER_DEFAULTS, src: 'tone' }),
  ...ly('air', { ...LAYER_DEFAULTS, color: 'white', filter: 0.55, level: 0.35 }),
  ...ly('sub', { on: false, level: 0.6, filter: 0, pan: 0, oct: 1 }),
};

const state = { ...DEFAULTS, playing: false };

// Event-type flags with only the listed types on: evOnly('creak', 'thud')
const evOnly = (...types) => Object.fromEntries(EVENT_TYPES.map(t => [evFlag(t), types.includes(t)]));

// Presets list only what differs from DEFAULTS; applyPreset starts from DEFAULTS.
const PRESETS = {
  industrial: {
    evDensity: 0.45, evDistance: 0.5, evVariety: 0.5, ...evOnly('thud', 'ping', 'creak'),
    verbSize: 0.4, verbDamp: 0.5, echoTime: 0.55, echoFeedback: 0.35, echoMix: 0.15,
    volume: 0.58, darkness: 0.55, movement: 0.45, pitch: 40, drift: 0.1, grit: 0.6, space: 0.2, age: 0.3, breath: 0.2,
    ...ly('bed', { src: 'resonator', color: 'brown', inharm: 0.55, q: 0.45, level: 0.6 }),
    ...ly('tone', { on: true, harm: 9, filter: -0.35, level: 0.45 }),
    ...ly('air', { on: true, level: 0.25, filter: 0.6 }),
    ...ly('sub', { on: true, level: 0.7 }),
  },
  ritual: {
    verbSize: 0.75, verbDamp: 0.45, preDelay: 0.04, shimmer: 0.25,
    darkness: 0.45, movement: 0.18, pitch: 43, interval: 'fifth', beat: 0.15, drift: 0.35, grit: 0.08, space: 0.65, breath: 0.35,
    ...ly('bed', { on: false }),
    ...ly('tone', { on: true, src: 'organ', bright: 0.3, breathe: 0.7, level: 0.6 }),
    ...ly('air', { on: true, src: 'choir', oct: 1, vowel: 0.1, morph: 0.35, filter: 0, pan: 0.1, level: 0.35 }),
    ...ly('sub', { on: true, level: 0.55, oct: 2 }),
  },
  mechanical: {
    evDensity: 0.5, evDistance: 0.35, evLevel: 0.5, evVariety: 0.3, ...evOnly('ping', 'thud'),
    verbSize: 0.35, verbDamp: 0.4, echoTime: 0.4, echoFeedback: 0.25, echoMix: 0.12,
    volume: 0.64, darkness: 0.45, resonance: 0.3, movement: 0.5, pitch: 47, drift: 0.05, grit: 0.4, space: 0.18,
    tremoloRate: 6, tremoloDepth: 0.35,
    ...ly('bed', { src: 'hum', buzz: 0.7, flutter: 0.25, level: 0.6 }),
    ...ly('tone', { on: true, harm: 6, level: 0.4 }),
    ...ly('air', { on: true, src: 'resonator', inharm: 1, q: 0.6, oct: 1, filter: 0, level: 0.3 }),
    ...ly('sub', { on: true, level: 0.5 }),
  },
  haunted: {
    evDensity: 0.35, evDistance: 0.7, ...evOnly('whisper', 'swell', 'creak'),
    verbSize: 0.7, verbDamp: 0.5, shimmer: 0.3, echoTime: 0.7, echoFeedback: 0.5, echoMix: 0.2, wow: 0.15,
    volume: 0.6, darkness: 0.5, movement: 0.28, pitch: 51, interval: 'tritone', beat: 0.2, drift: 0.55,
    grit: 0.12, space: 0.78, breath: 0.4, modShape: 'wander', vibratoRate: 0.6, vibratoDepth: 0.15,
    ...ly('bed', { level: 0.25, filter: -0.4 }),
    ...ly('tone', { on: true, src: 'choir', vowel: 0.2, morph: 0.6, level: 0.6 }),
    ...ly('air', { on: true, src: 'choir', exc: 'noise', vowel: 0.8, morph: 0.5, filter: 0.2, level: 0.3 }),
    ...ly('sub', { on: true, level: 0.3, oct: 2 }),
  },
  'deep-space': {
    verbSize: 0.9, verbDamp: 0.35, preDelay: 0.08, shimmer: 0.4,
    volume: 0.65, darkness: 0.4, movement: 0.08, width: 0.8, pitch: 45, interval: 'octave', beat: 0.05, drift: 0.08,
    grit: 0.03, space: 0.88,
    ...ly('bed', { color: 'brown', filter: -0.3, level: 0.3 }),
    ...ly('tone', { on: true, src: 'organ', bright: 0.2, breathe: 0.6, level: 0.55 }),
    ...ly('sub', { on: true, level: 0.8, oct: 2 }),
  },
  'room-tone': {
    evDensity: 0.2, evDistance: 0.6, evLevel: 0.5, ...evOnly('creak', 'thud'),
    verbSize: 0.2, verbDamp: 0.6, preDelay: 0.005, wow: 0.1,
    darkness: 0.55, movement: 0.35, width: 0.7, pitch: 34, space: 0.3, age: 0.45, breath: 0.3,
    ...ly('bed', { color: 'brown', filter: -0.2, level: 0.8 }),
    ...ly('air', { on: true, src: 'hum', buzz: 0.35, flutter: 0.2, filter: 0, level: 0.2 }),
    ...ly('sub', { on: true, level: 0.25 }),
  },
  unease: {
    verbSize: 0.7, verbDamp: 0.55, echoTime: 0.9, echoFeedback: 0.5, echoMix: 0.15,
    volume: 0.75, darkness: 0.55, resonance: 0.25, movement: 0.4, width: 0.8, pitch: 38, interval: 'minor2', beat: 0.3,
    drift: 0.4, space: 0.6, breath: 0.3,
    ...ly('bed', { src: 'resonator', inharm: 0.85, q: 0.7, level: 0.5 }),
    ...ly('tone', { on: true, src: 'organ', breathe: 0.5, level: 0.45 }),
    ...ly('sub', { on: true, level: 0.3 }),
  },
  glass: {
    verbSize: 0.8, verbDamp: 0.1, preDelay: 0.05, shimmer: 0.15,
    volume: 1, darkness: 0.2, movement: 0.15, width: 0.8, pitch: 57, drift: 0.15, space: 0.7, breath: 0.3,
    ...ly('bed', { on: false }),
    ...ly('tone', { on: true, src: 'resonator', color: 'white', inharm: 0.15, q: 0.85, oct: 1, level: 0.9 }),
    ...ly('air', { on: true, filter: 0.7, level: 0.15 }),
  },
  // Velvet dread: low breathing organ in a minor ninth, a whisper behind it
  'red-room': {
    evDensity: 0.15, evDistance: 0.7, ...evOnly('swell', 'whisper'),
    verbSize: 0.6, verbDamp: 0.6, echoTime: 0.65, echoFeedback: 0.45, echoMix: 0.15, wow: 0.25, crackle: 0.15,
    darkness: 0.5, movement: 0.25, width: 0.7, pitch: 40, interval: 'minor9', beat: 0.1, drift: 0.25,
    space: 0.75, age: 0.35, breath: 0.35, modShape: 'wander', vibratoRate: 0.4, vibratoDepth: 0.08,
    ...ly('bed', { filter: -0.45, level: 0.3 }),
    ...ly('tone', { on: true, src: 'organ', bright: 0.25, breathe: 0.6, level: 0.5 }),
    ...ly('air', { on: true, src: 'choir', exc: 'noise', vowel: 0.15, morph: 0.5, filter: 0.15, level: 0.25 }),
    ...ly('sub', { on: true, level: 0.45 }),
  },
  // Radiator hiss, buzzing mains, steam in the pipes
  eraserhead: {
    evDensity: 0.4, evDistance: 0.45, evVariety: 0.5, ...evOnly('creak', 'thud', 'ping'),
    verbSize: 0.35, verbDamp: 0.7, wow: 0.2, crackle: 0.25,
    volume: 0.6, darkness: 0.5, movement: 0.3, width: 0.6, pitch: 33, grit: 0.35, age: 0.7, space: 0.35, breath: 0.2,
    ...ly('bed', { color: 'brown', filter: -0.1, level: 0.7 }),
    ...ly('tone', { on: true, src: 'hum', mains: 60, buzz: 0.8, flutter: 0.35, level: 0.45 }),
    ...ly('air', { on: true, src: 'resonator', color: 'white', inharm: 0.9, q: 0.55, oct: 1, filter: 0.3, level: 0.25 }),
    ...ly('sub', { on: true, level: 0.5 }),
  },
  // Pressure at depth: groaning metal partials over a sub you feel more than hear
  abyss: {
    evDensity: 0.3, evDistance: 0.85, evLevel: 0.7, ...evOnly('thud', 'ping', 'drip'),
    verbSize: 0.85, verbDamp: 0.8, preDelay: 0.06, shimmer: 0.35,
    volume: 0.66, darkness: 0.7, resonance: 0.2, movement: 0.35, width: 0.9, pitch: 31, drift: 0.3,
    space: 0.6, breath: 0.45,
    ...ly('bed', { color: 'brown', filter: -0.5, level: 0.6 }),
    ...ly('tone', { on: true, src: 'resonator', color: 'brown', inharm: 1, q: 0.8, level: 0.7 }),
    ...ly('sub', { on: true, level: 0.8 }),
  },
  // A bowed cymbal / singing bowl: two inharmonic resonators beating against each other
  'bowed-steel': {
    verbSize: 0.8, verbDamp: 0.2, preDelay: 0.03,
    volume: 0.95, darkness: 0.25, movement: 0.15, width: 0.8, pitch: 50, drift: 0.2, space: 0.75, breath: 0.25,
    ...ly('bed', { on: false }),
    ...ly('tone', { on: true, src: 'resonator', color: 'pink', inharm: 1, q: 0.88, level: 1 }),
    ...ly('air', { on: true, src: 'resonator', color: 'pink', inharm: 0.7, q: 0.8, oct: 1, filter: 0, pan: 0.4, level: 0.6 }),
  },
  // Howling wind through a gap: resonant swept noise and a moaning whisper
  'night-wind': {
    evDensity: 0.3, evDistance: 0.8, ...evOnly('creak', 'whisper'),
    verbSize: 0.65, verbDamp: 0.4, echoTime: 0.75, echoFeedback: 0.35, echoMix: 0.15,
    volume: 0.9, darkness: 0.35, resonance: 0.55, movement: 0.8, width: 1, space: 0.5, breath: 0.6, modShape: 'wander',
    ...ly('bed', { level: 1 }),
    ...ly('air', { on: true, src: 'choir', exc: 'noise', vowel: 0, morph: 0.8, filter: 0.1, level: 0.7 }),
  },
  // Flickering tube light in an empty corridor: buzz and a thin high whine
  fluorescent: {
    verbSize: 0.25, verbDamp: 0.3,
    volume: 0.8, darkness: 0.15, movement: 0.05, width: 0.4, pitch: 57, age: 0.15, space: 0.2,
    ...ly('bed', { color: 'white', filter: 0.5, level: 0.15 }),
    ...ly('tone', { on: true, src: 'hum', mains: 60, buzz: 0.9, flutter: 0.08, level: 0.55 }),
    ...ly('air', { on: true, src: 'tone', harm: 1, oct: 2, filter: 0, level: 0.08 }),
  },
  // Voices that aren't there: two whispers drifting between vowels over a low sung tone
  seance: {
    evDensity: 0.45, evDistance: 0.6, ...evOnly('whisper', 'creak', 'swell'),
    verbSize: 0.75, verbDamp: 0.5, echoTime: 0.8, echoFeedback: 0.55, echoMix: 0.25, wow: 0.1,
    volume: 0.9, darkness: 0.45, movement: 0.3, width: 0.9, pitch: 45, interval: 'tritone', drift: 0.4, space: 0.85, breath: 0.5,
    modShape: 'wander', vibratoRate: 0.3, vibratoDepth: 0.2,
    ...ly('bed', { src: 'choir', exc: 'noise', vowel: 0.4, morph: 0.8, pan: -0.4, level: 0.6 }),
    ...ly('tone', { on: true, src: 'choir', vowel: 0.1, morph: 0.6, oct: -1, level: 0.55 }),
    ...ly('air', { on: true, src: 'choir', exc: 'noise', vowel: 0.8, morph: 0.9, filter: 0, pan: 0.35, level: 0.75 }),
    ...ly('sub', { on: true, level: 0.25, oct: 2 }),
  },
  // Underwater: muffled, slowly heaving organ and brown noise
  submerged: {
    evDensity: 0.35, evDistance: 0.75, ...evOnly('drip', 'thud'),
    verbSize: 0.6, verbDamp: 0.9, wow: 0.2,
    darkness: 0.78, resonance: 0.3, movement: 0.45, width: 0.7, pitch: 36, interval: 'octave', beat: 0.25, drift: 0.2,
    space: 0.5, breath: 0.4, modShape: 'wander', tremoloRate: 0.3, tremoloDepth: 0.4,
    ...ly('bed', { color: 'brown', level: 0.7 }),
    ...ly('tone', { on: true, src: 'organ', bright: 0.15, breathe: 0.4, level: 0.5 }),
    ...ly('sub', { on: true, level: 0.6 }),
  },
  // A choir caught on a dying broadcast: thin, warbling, saturated
  'radio-ghost': {
    verbSize: 0.3, verbDamp: 0.7, echoTime: 0.45, echoFeedback: 0.3, echoMix: 0.2, wow: 0.5, crackle: 0.4,
    darkness: 0.3, resonance: 0.4, movement: 0.2, width: 0.3, pitch: 52, interval: 'fifth', drift: 0.3,
    grit: 0.3, age: 0.8, space: 0.4, tremoloRate: 7, tremoloDepth: 0.25,
    ...ly('bed', { color: 'white', filter: 0.35, level: 0.3 }),
    ...ly('tone', { on: true, src: 'choir', vowel: 0.6, morph: 0.4, filter: 0.2, level: 0.5 }),
    ...ly('air', { on: true, src: 'hum', mains: 50, buzz: 0.6, flutter: 0.5, filter: 0, level: 0.15 }),
  },
  // Huge stone room: organ fifths, an "ah" choir an octave up, endless tail
  cathedral: {
    verbSize: 1, verbDamp: 0.4, preDelay: 0.09, shimmer: 0.2,
    darkness: 0.3, movement: 0.12, width: 0.9, pitch: 41, interval: 'fifth', beat: 0.05, drift: 0.12,
    space: 0.95, breath: 0.25,
    ...ly('bed', { filter: -0.6, level: 0.2 }),
    ...ly('tone', { on: true, src: 'organ', bright: 0.45, breathe: 0.5, level: 0.55 }),
    ...ly('air', { on: true, src: 'choir', vowel: 0.5, morph: 0.25, oct: 1, filter: 0, level: 0.35 }),
    ...ly('sub', { on: true, level: 0.5 }),
  },
  // Ringing ears after a blast: a faint, slowly beating high sine over muffled room noise
  tinnitus: {
    volume: 0.75, darkness: 0.05, movement: 0.1, width: 0.3, pitch: 66, beat: 0.12, drift: 0.05, space: 0.15,
    ...ly('bed', { filter: -0.4, level: 0.7 }),
    ...ly('tone', { on: true, harm: 1, oct: 2, level: 0.2 }),
  },
  // A slow heartbeat throb under everything
  pulse: {
    verbSize: 0.35, verbDamp: 0.7, echoTime: 0.853, echoFeedback: 0.3, echoMix: 0.2,   // echo lands on the throb
    darkness: 0.65, movement: 0.15, width: 0.5, pitch: 33, space: 0.3, breath: 0.2,
    tremoloRate: 1.1, tremoloDepth: 0.85,
    ...ly('bed', { color: 'brown', filter: -0.3, level: 0.6 }),
    ...ly('tone', { on: true, harm: 3, oct: -1, level: 0.4 }),
    ...ly('sub', { on: true, level: 0.8 }),
  },
  // Nobody's home: settling timbers and footfalls somewhere upstairs
  'empty-house': {
    verbSize: 0.35, verbDamp: 0.6, preDelay: 0.015,
    darkness: 0.55, movement: 0.2, width: 0.7, pitch: 34, space: 0.35, age: 0.2, breath: 0.2,
    evDensity: 0.5, evDistance: 0.4, evLevel: 0.7, evVariety: 0.7, ...evOnly('creak', 'thud'),
    ...ly('bed', { color: 'brown', filter: -0.35, level: 0.55 }),
    ...ly('air', { on: true, src: 'hum', mains: 60, buzz: 0.2, flutter: 0.15, filter: 0, level: 0.1 }),
  },
  // Deep cave: water dripping into darkness, a far-off ringing, low rock resonance
  cave: {
    verbSize: 0.85, verbDamp: 0.4, preDelay: 0.07,
    darkness: 0.45, movement: 0.25, width: 0.9, pitch: 36, drift: 0.15, space: 0.7, breath: 0.3,
    evDensity: 0.55, evDistance: 0.65, evVariety: 0.7, ...evOnly('drip', 'ping'),
    ...ly('bed', { color: 'brown', filter: -0.45, level: 0.5 }),
    ...ly('tone', { on: true, src: 'resonator', color: 'brown', inharm: 0.3, q: 0.7, oct: -1, level: 0.35 }),
    ...ly('sub', { on: true, level: 0.35 }),
  },
  // 3 a.m. off the highway: a buzzing fridge, a worn tape, something through the wall
  'motel-room': {
    verbSize: 0.25, verbDamp: 0.7, preDelay: 0.008, wow: 0.3, crackle: 0.3,
    darkness: 0.55, movement: 0.2, width: 0.6, pitch: 34, age: 0.35, space: 0.25, breath: 0.15,
    evDensity: 0.3, evDistance: 0.6, ...evOnly('thud', 'creak'),
    ...ly('bed', { color: 'brown', filter: -0.3, level: 0.6 }),
    ...ly('tone', { on: true, src: 'hum', mains: 60, buzz: 0.45, flutter: 0.4, level: 0.35 }),
  },
  // Bare concrete: slapback, a long gap before the room answers, steps far below
  stairwell: {
    verbSize: 0.45, verbDamp: 0.15, preDelay: 0.12, echoTime: 0.26, echoFeedback: 0.25, echoMix: 0.2,
    volume: 0.95, darkness: 0.3, movement: 0.15, width: 0.8, pitch: 41, space: 0.55,
    evDensity: 0.4, evDistance: 0.8, evVariety: 0.5, ...evOnly('thud', 'ping'),
    ...ly('bed', { filter: -0.2, level: 0.9 }),
    ...ly('air', { on: true, filter: 0.5, level: 0.3 }),
  },
  // A music box on a warped tape: high organ in a minor ninth, sparkle, swells
  lullaby: {
    verbSize: 0.6, verbDamp: 0.5, shimmer: 0.35, wow: 0.55, crackle: 0.35,
    volume: 0.85, darkness: 0.35, movement: 0.15, width: 0.6, pitch: 52, interval: 'minor9', beat: 0.1, drift: 0.3,
    age: 0.5, space: 0.55, breath: 0.3, modShape: 'wander', vibratoRate: 0.5, vibratoDepth: 0.1,
    evDensity: 0.15, evDistance: 0.6, ...evOnly('swell'),
    ...ly('bed', { on: false }),
    ...ly('tone', { on: true, src: 'organ', oct: 1, bright: 0.55, breathe: 0.5, level: 0.5 }),
    ...ly('air', { on: true, src: 'tone', harm: 3, oct: 2, filter: 0, level: 0.1 }),
  },
  // A low choir grinding in a cluster, with whispers too close for comfort
  possession: {
    verbSize: 0.55, verbDamp: 0.55, echoTime: 0.5, echoFeedback: 0.4, echoMix: 0.15,
    darkness: 0.5, resonance: 0.2, movement: 0.35, width: 0.9, pitch: 38, interval: 'minor2', beat: 0.35, drift: 0.45,
    grit: 0.3, space: 0.6, breath: 0.45, modShape: 'wander', vibratoRate: 0.7, vibratoDepth: 0.25,
    evDensity: 0.7, evDistance: 0.25, evLevel: 0.55, ...evOnly('whisper', 'swell'),
    ...ly('bed', { color: 'brown', filter: -0.4, level: 0.3 }),
    ...ly('tone', { on: true, src: 'choir', vowel: 0.3, morph: 0.7, oct: -1, level: 0.6 }),
    ...ly('sub', { on: true, level: 0.35 }),
  },
  // Plant room: 50 Hz machinery throbbing, metal ticking and knocking nearby
  'generator-room': {
    verbSize: 0.3, verbDamp: 0.6, echoTime: 0.3, echoFeedback: 0.2, echoMix: 0.1,
    volume: 0.55, darkness: 0.45, movement: 0.2, width: 0.5, pitch: 31, grit: 0.25, space: 0.25, age: 0.2,
    tremoloRate: 3.3, tremoloDepth: 0.3,
    evDensity: 0.45, evDistance: 0.3, evLevel: 0.5, evVariety: 0.4, ...evOnly('ping', 'thud'),
    ...ly('bed', { color: 'brown', level: 0.5 }),
    ...ly('tone', { on: true, src: 'hum', mains: 50, buzz: 0.85, flutter: 0.15, level: 0.5 }),
    ...ly('air', { on: true, src: 'tone', harm: 7, oct: 1, filter: -0.2, level: 0.15 }),
    ...ly('sub', { on: true, level: 0.55 }),
  },
  // Air moving through ducts: resonant swept noise, a faint fan hum, the odd creak of metal
  ventilation: {
    verbSize: 0.35, verbDamp: 0.5,
    volume: 0.85, darkness: 0.35, resonance: 0.6, movement: 0.75, width: 0.8, pitch: 40, space: 0.3, breath: 0.35, modShape: 'wander',
    evDensity: 0.2, evDistance: 0.55, ...evOnly('creak'),
    ...ly('bed', { level: 0.8 }),
    ...ly('tone', { on: true, src: 'hum', mains: 60, buzz: 0.3, flutter: 0.1, level: 0.12 }),
    ...ly('air', { on: true, filter: 0.55, level: 0.25 }),
  },
  // Ice: glassy resonators ringing into a bright, endlessly sinking tail
  frost: {
    verbSize: 0.85, verbDamp: 0.05, preDelay: 0.06, shimmer: 0.5,
    volume: 0.95, darkness: 0.15, movement: 0.12, width: 0.9, pitch: 60, drift: 0.12, space: 0.8, breath: 0.25,
    evDensity: 0.35, evDistance: 0.75, ...evOnly('ping', 'drip'),
    ...ly('bed', { on: false }),
    ...ly('tone', { on: true, src: 'resonator', color: 'white', inharm: 0.2, q: 0.9, oct: 1, level: 0.9 }),
    ...ly('air', { on: true, src: 'resonator', color: 'pink', inharm: 0.5, q: 0.85, oct: 2, filter: 0, pan: -0.4, level: 0.35 }),
  },
  // A hull on the seabed: groaning steel, timbers giving, water finding its way in
  shipwreck: {
    verbSize: 0.8, verbDamp: 0.75, preDelay: 0.05, wow: 0.15,
    darkness: 0.65, movement: 0.3, width: 0.9, pitch: 30, drift: 0.35, space: 0.65, breath: 0.4,
    evDensity: 0.4, evDistance: 0.7, evVariety: 0.7, ...evOnly('creak', 'thud', 'drip'),
    ...ly('bed', { color: 'brown', filter: -0.4, level: 0.5 }),
    ...ly('tone', { on: true, src: 'resonator', color: 'brown', inharm: 0.85, q: 0.75, level: 0.7 }),
    ...ly('sub', { on: true, level: 0.5 }),
  },
  // Almost nothing: a breath of organ in a vast, sinking space
  void: {
    verbSize: 1, verbDamp: 0.5, preDelay: 0.1, shimmer: 0.45,
    volume: 0.9, darkness: 0.45, movement: 0.1, width: 1, pitch: 33, drift: 0.2, space: 0.95, breath: 0.7,
    evDensity: 0.1, evDistance: 0.9, ...evOnly('swell'),
    ...ly('bed', { color: 'brown', filter: -0.6, level: 0.2 }),
    ...ly('tone', { on: true, src: 'organ', bright: 0.1, breathe: 0.8, level: 0.35 }),
    ...ly('sub', { on: true, level: 0.3 }),
  },
  // Weather rolling in: low rumble, wind voices, thunder far off
  'storm-front': {
    verbSize: 0.75, verbDamp: 0.6,
    darkness: 0.55, resonance: 0.15, movement: 0.85, width: 1, pitch: 29, space: 0.5, breath: 0.55, modShape: 'wander',
    evDensity: 0.35, evDistance: 0.9, evLevel: 0.8, evVariety: 0.9, ...evOnly('thud'),
    ...ly('bed', { color: 'brown', level: 0.85 }),
    ...ly('air', { on: true, src: 'choir', exc: 'noise', vowel: 0, morph: 0.9, filter: 0.1, level: 0.5 }),
    ...ly('sub', { on: true, level: 0.35 }),
  },
  // ── Open Air: outdoor beds that leave room for dialogue (quiet, no near or whisper events) ──
  // Wind on an open hill, with a soft organ fifth up high that's never quite in tune
  hillside: {
    verbSize: 0.55, verbDamp: 0.3, preDelay: 0.04,
    volume: 0.6, darkness: 0.4, resonance: 0.25, movement: 0.45, width: 0.9, pitch: 45, interval: 'fifth', beat: 0.12,
    drift: 0.2, space: 0.35, breath: 0.55, modShape: 'wander',
    ...ly('bed', { level: 0.7 }),
    ...ly('tone', { on: true, src: 'organ', oct: 1, bright: 0.3, breathe: 0.6, filter: -0.2, level: 0.2 }),
  },
  // The same wind, but something's in it: far voices in the gusts, a bottle-like tritone, a distant bell
  'mountain-path': {
    verbSize: 0.6, verbDamp: 0.35, preDelay: 0.05,
    volume: 0.6, darkness: 0.4, resonance: 0.3, movement: 0.55, width: 1, pitch: 43, interval: 'tritone', drift: 0.25,
    space: 0.4, breath: 0.5, modShape: 'wander',
    evDensity: 0.12, evDistance: 0.9, evLevel: 0.5, evVariety: 0.4, ...evOnly('ping'),
    ...ly('bed', { level: 0.7 }),
    ...ly('tone', { on: true, src: 'resonator', color: 'white', inharm: 0.35, q: 0.8, oct: 1, level: 0.25 }),
    ...ly('air', { on: true, src: 'choir', exc: 'noise', vowel: 0, morph: 0.8, filter: -0.35, level: 0.2 }),
  },
  // High altitude: wide wind, a faint beating ring above it, the bed bending ever so slightly
  'thin-air': {
    verbSize: 0.65, verbDamp: 0.2, preDelay: 0.03, shimmer: 0.3, wow: 0.12,
    volume: 0.6, darkness: 0.35, resonance: 0.2, movement: 0.5, width: 1, pitch: 72, beat: 0.2, drift: 0.08,
    space: 0.4, breath: 0.45, modShape: 'wander',
    ...ly('bed', { level: 0.65 }),
    ...ly('tone', { on: true, harm: 1, oct: 2, level: 0.05 }),
    ...ly('air', { on: true, filter: 0.55, level: 0.15 }),
  },
  // A far-off choir on the wind, slowly drifting out of tune; now and then a swell from nowhere
  'summit-hymn': {
    verbSize: 0.75, verbDamp: 0.45, preDelay: 0.06,
    volume: 0.75, darkness: 0.4, movement: 0.4, width: 0.9, pitch: 45, interval: 'fifth', drift: 0.35,
    space: 0.6, breath: 0.5, modShape: 'wander', vibratoRate: 0.4, vibratoDepth: 0.12,
    evDensity: 0.12, evDistance: 0.85, evLevel: 0.5, ...evOnly('swell'),
    ...ly('bed', { level: 0.6 }),
    ...ly('tone', { on: true, src: 'choir', vowel: 0.5, morph: 0.3, filter: -0.3, level: 0.45 }),
  },
};

// ── Preset groups ─────────────────────────────────────────────────────────

const PRESET_LABELS = {
  industrial: 'Industrial', ritual: 'Ritual', mechanical: 'Mechanical', haunted: 'Haunted',
  'deep-space': 'Deep Space', 'room-tone': 'Room Tone', unease: 'Unease', glass: 'Glass',
  'red-room': 'Red Room', eraserhead: 'Eraserhead', abyss: 'Abyss', 'bowed-steel': 'Bowed Steel',
  'night-wind': 'Night Wind', fluorescent: 'Fluorescent', seance: 'Séance', submerged: 'Submerged',
  'radio-ghost': 'Radio Ghost', cathedral: 'Cathedral', tinnitus: 'Tinnitus', pulse: 'Pulse',
  'empty-house': 'Empty House', cave: 'Cave', 'motel-room': 'Motel Room', stairwell: 'Stairwell',
  lullaby: 'Lullaby', possession: 'Possession', 'generator-room': 'Generator Room', ventilation: 'Ventilation',
  frost: 'Frost', shipwreck: 'Shipwreck', void: 'Void', 'storm-front': 'Storm Front',
  hillside: 'Hillside', 'mountain-path': 'Mountain Path', 'thin-air': 'Thin Air', 'summit-hymn': 'Summit Hymn',
};

const PRESET_GROUPS = [
  { id: 'places', name: 'Places', presets: ['room-tone', 'empty-house', 'cave', 'cathedral', 'fluorescent', 'motel-room', 'stairwell'] },
  { id: 'voices', name: 'Voices', presets: ['haunted', 'seance', 'red-room', 'radio-ghost', 'ritual', 'lullaby', 'possession'] },
  { id: 'machines', name: 'Machines', presets: ['industrial', 'mechanical', 'eraserhead', 'pulse', 'generator-room', 'ventilation'] },
  { id: 'metal', name: 'Metal & Glass', presets: ['glass', 'bowed-steel', 'tinnitus', 'frost', 'shipwreck'] },
  { id: 'vast', name: 'Vast & Deep', presets: ['deep-space', 'abyss', 'unease', 'submerged', 'void'] },
  { id: 'open-air', name: 'Open Air', presets: ['hillside', 'mountain-path', 'thin-air', 'summit-hymn', 'night-wind', 'storm-front'] },
];

// ── Layer UI (generated) ──────────────────────────────────────────────────

const LAYER_NAMES = { bed: 'Bed', tone: 'Tone', air: 'Air', sub: 'Sub' };
const SRC_LABELS = { noise: 'Noise', tone: 'Tone', organ: 'Organ', choir: 'Choir', resonator: 'Resonator', hum: 'Hum' };

// [param, label, kind, slider range | toggle options, show-for (source tokens), title]
const LAYER_ROWS = [
  ['src', 'Source', 'toggle', SOURCES.map(v => [v, SRC_LABELS[v]])],
  ['level', 'Level', 'slider', [0, 1, 0.001]],
  ['filter', 'Filter', 'slider', [-1, 1, 0.001], null, 'Left of centre: low-pass · right: high-pass'],
  ['pan', 'Pan', 'slider', [-1, 1, 0.001]],
  ['oct', 'Octave', 'slider', [-2, 2, 1], 'voiced', 'Register relative to Pitch'],
  ['color', 'Colour', 'toggle', COLORS.map(v => [v, v[0].toUpperCase() + v.slice(1)]), 'noise'],
  ['harm', 'Harmonics', 'slider', [1, 12, 1], 'tone', '1 = pure sine'],
  ['bright', 'Bright', 'slider', [0, 1, 0.001], 'organ', 'Upper partial level'],
  ['breathe', 'Breathe', 'slider', [0, 1, 0.001], 'organ', 'Each partial swells on its own'],
  ['exc', 'Voice', 'toggle', [['saw', 'Sung'], ['noise', 'Whisper']], 'choir'],
  ['vowel', 'Vowel', 'slider', [0, 1, 0.001], 'choir', 'oo · ah · ee'],
  ['morph', 'Morph', 'slider', [0, 1, 0.001], 'choir', 'Vowel wanders around its setting'],
  ['inharm', 'Inharm.', 'slider', [0, 1, 0.001], 'resonator', 'Harmonic (string, pipe) → bar modes (bowed metal)'],
  ['q', 'Ring', 'slider', [0, 1, 0.001], 'resonator', 'Filter Q: breathy → singing'],
  ['mains', 'Mains', 'toggle', [[50, '50 Hz'], [60, '60 Hz']], 'hum'],
  ['buzz', 'Buzz', 'slider', [0, 1, 0.001], 'hum', 'Upper harmonics'],
  ['flutter', 'Flutter', 'slider', [0, 1, 0.001], 'hum', 'Unsteady pitch and level'],
];
const SUB_ROWS = [
  LAYER_ROWS[1], LAYER_ROWS[2], LAYER_ROWS[3],
  ['oct', 'Octave', 'toggle', [[1, '−1'], [2, '−2']]],
];
const layerRows = L => L === 'sub' ? SUB_ROWS : LAYER_ROWS;

// Tokens a layer's rows are shown for: its source, plus 'voiced' / 'noise'
function layerTokens(s, L) {
  const t = [s[lk(L, 'src')]];
  if (isVoiced(s, L)) t.push('voiced');
  if (usesNoise(s, L)) t.push('noise');
  return t;
}

let uiLayer = 'bed';

function buildLayerUI() {
  const tabs = document.getElementById('layer-tabs');
  const panels = document.getElementById('layer-panels');
  ALL_LAYERS.forEach(L => {
    const tab = document.createElement('div');
    tab.className = 'layer-tab';
    tab.dataset.layer = L;
    tab.innerHTML = `<button class="layer-mute" title="Mute / unmute"></button>` +
      `<button class="layer-select"><span class="layer-name">${LAYER_NAMES[L]}</span><span class="layer-src"></span></button>`;
    tabs.appendChild(tab);

    const panel = document.createElement('div');
    panel.className = 'layer-panel';
    panel.dataset.layer = L;
    panel.innerHTML = layerRows(L).map(([p, label, kind, opts, show, title]) => {
      const key = lk(L, p);
      const attrs = (show ? ` data-for="${show}"` : '') + (title ? ` title="${title}"` : '');
      const inner = kind === 'slider'
        ? `<input type="range" id="${key}" min="${opts[0]}" max="${opts[1]}" step="${opts[2]}">` +
          `<span class="slider-value" id="${key}-val"></span>`
        : `<div class="toggle-group compact" data-key="${key}">` +
          opts.map(([v, t]) => `<button class="toggle-btn" data-value="${v}">${t}</button>`).join('') +
          `</div><span class="slider-value"></span>`;
      return `<div class="slider-row"${attrs}><label class="slider-label"${kind === 'slider' ? ` for="${key}"` : ''}>${label}</label>${inner}</div>`;
    }).join('');
    panels.appendChild(panel);
  });

  tabs.addEventListener('click', e => {
    const tab = e.target.closest('.layer-tab');
    if (!tab) return;
    const L = tab.dataset.layer;
    if (e.target.closest('.layer-mute')) setChoice(lk(L, 'on'), !state[lk(L, 'on')]);
    else { uiLayer = L; syncChoices(); }
  });
}

// ── Controls ──────────────────────────────────────────────────────────────

const pct = v => Math.round(v * 100) + '%';
const hz = f => f >= 1000 ? (f / 1000).toFixed(1) + ' kHz' : Math.round(f) + ' Hz';
const VOWEL_NAMES = ['oo', 'oo·ah', 'ah', 'ah·ee', 'ee'];

const LAYER_FORMAT = {
  level: pct,
  filter: f => Math.abs(f) < 0.01 ? 'open' : f < 0 ? 'LP ' + hz(lpHz(f)) : 'HP ' + hz(hpHz(f)),
  pan: v => Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L ' : 'R ') + Math.round(Math.abs(v) * 100),
  oct: v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + ' oct',
  harm: v => v === 1 ? 'sine' : String(v),
  bright: pct, breathe: pct, morph: pct, buzz: pct, flutter: pct,
  vowel: v => VOWEL_NAMES[Math.round(v * 4)],
  inharm: v => v < 0.01 ? 'harmonic' : pct(v),
  q: v => 'Q ' + Math.round(resonQ(v)),
};

const FORMAT = {
  volume: pct,
  darkness: v => hz(darknessToHz(v)),
  resonance: v => 'Q ' + (0.5 + v * 14.5).toFixed(1),
  movement: v => '±' + (v * 2).toFixed(1) + ' oct',
  width: pct,
  pitch: v => `${noteName(v)} · ${Math.round(midiToHz(v))}`,
  beat: v => v < 0.01 ? 'off' : beatHz(v).toFixed(1) + ' Hz',
  drift: v => '±' + Math.round(v * 50) + '¢',
  grit: pct, space: pct, age: pct, wow: pct, crackle: pct, breath: pct,
  verbSize: v => verbSecs(v).toFixed(1) + ' s',
  verbDamp: v => v < 0.01 ? 'bright' : pct(v),
  preDelay: v => Math.round(v * 1000) + ' ms',
  shimmer: v => v < 0.01 ? 'off' : pct(v),
  echoTime: v => { const t = echoSecs(v); return t < 1 ? Math.round(t * 1000) + ' ms' : t.toFixed(2) + ' s'; },
  echoFeedback: pct,
  echoMix: v => v < 0.01 ? 'off' : pct(v),
  evDensity: v => v < 0.01 ? 'off' : '~' + Math.round(1 / eventRate(v)) + ' s',
  evLevel: pct,
  evDistance: v => (v < 0.34 ? 'near' : v < 0.67 ? 'mid' : 'far') + ' ' + pct(v),
  evVariety: pct,
  vibratoRate: v => v.toFixed(1) + ' Hz',
  vibratoDepth: v => '±' + Math.round(v * 100) + '¢',
  tremoloRate: v => v.toFixed(1) + ' Hz',
  tremoloDepth: pct,
};
ALL_LAYERS.forEach(L => layerRows(L).forEach(([p, , kind]) => {
  if (kind === 'slider') FORMAT[lk(L, p)] = LAYER_FORMAT[p];
}));
const SLIDER_KEYS = Object.keys(FORMAT);

function updateSliderFill(el) {
  const v = parseFloat(el.value);
  const p = ((v - parseFloat(el.min)) / (parseFloat(el.max) - parseFloat(el.min))) * 100;
  el.style.background = `linear-gradient(to right, var(--accent) ${p}%, var(--border) ${p}%)`;
  const valEl = document.getElementById(el.id + '-val');
  if (valEl) valEl.textContent = FORMAT[el.id](v);
}

function animateSlider(el, target, ms = 420) {
  const from = parseFloat(el.value);
  if (from === target) { updateSliderFill(el); return; }
  const t0 = performance.now();
  const token = el._anim = {};
  function step(now) {
    if (el._anim !== token) return;
    const p = Math.min((now - t0) / ms, 1);
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    el.value = from + (target - from) * e;
    updateSliderFill(el);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function setParam(k, v) {
  state[k] = v;
  updateSliderFill(document.getElementById(k));
  clearActivePreset();
  if (graph) graph.update(state, k);
}

function setChoice(k, v) {
  state[k] = v;
  syncChoices();
  clearActivePreset();
  if (graph) graph.update(state, k);
}

function syncChoices() {
  document.querySelectorAll('.toggle-group[data-key]').forEach(g => {
    g.querySelectorAll('.toggle-btn').forEach(b => b.classList.toggle('active', b.dataset.value === String(state[g.dataset.key])));
  });
  document.querySelectorAll('[data-flag]').forEach(b => b.classList.toggle('active', !!state[b.dataset.flag]));
  ALL_LAYERS.forEach(L => {
    const on = state[lk(L, 'on')];
    const tab = document.querySelector(`.layer-tab[data-layer="${L}"]`);
    tab.classList.toggle('on', on);
    tab.classList.toggle('selected', L === uiLayer);
    tab.querySelector('.layer-src').textContent = L === 'sub' ? 'Sine' : SRC_LABELS[state[lk(L, 'src')]];
    const panel = document.querySelector(`.layer-panel[data-layer="${L}"]`);
    panel.hidden = L !== uiLayer;
    panel.classList.toggle('muted', !on);
    if (L === 'sub') return;
    const tokens = layerTokens(state, L);
    panel.querySelectorAll('[data-for]').forEach(row => {
      row.hidden = !row.dataset.for.split(' ').some(t => tokens.includes(t));
    });
  });
  // Pitch / interval / beat / drift / vibrato only matter when something is pitched
  const pitched = state.subOn || LAYERS.some(L => state[lk(L, 'on')] && isVoiced(state, L));
  document.querySelector('.app').dataset.kind = pitched ? 'drone' : 'noise';
}

function applyState(next) {
  Object.assign(state, next);
  syncChoices();
  SLIDER_KEYS.forEach(k => animateSlider(document.getElementById(k), state[k]));
  if (graph) graph.update(state);
}

// ── Preset panel (generated from PRESET_GROUPS) ──
// One group's presets show at a time; the open group is remembered per browser.

const GROUP_STORE = 'noise-preset-group';
let uiGroup = PRESET_GROUPS[0].id, activePreset = null;
try { uiGroup = localStorage.getItem(GROUP_STORE) || uiGroup; } catch (_) {}

function setGroup(id) {
  uiGroup = id;
  try { localStorage.setItem(GROUP_STORE, id); } catch (_) {}
  renderPresetGroup();
}

function renderPresetGroup() {
  const group = PRESET_GROUPS.find(g => g.id === uiGroup) || PRESET_GROUPS[0];
  uiGroup = group.id;
  document.querySelectorAll('.preset-group-tab').forEach(b => b.classList.toggle('active', b.dataset.group === uiGroup));
  document.getElementById('preset-grid').innerHTML = group.presets.map(p =>
    `<button class="preset-btn${p === activePreset ? ' active' : ''}" data-preset="${p}">${PRESET_LABELS[p]}</button>`).join('');
}

function buildPresetUI() {
  const tabs = document.getElementById('preset-groups');
  tabs.innerHTML = PRESET_GROUPS.map(g =>
    `<button class="toggle-btn preset-group-tab" data-group="${g.id}">${g.name}</button>`).join('');
  tabs.addEventListener('click', e => {
    const b = e.target.closest('.preset-group-tab');
    if (b) setGroup(b.dataset.group);
  });
  document.getElementById('preset-grid').addEventListener('click', e => {
    const b = e.target.closest('.preset-btn');
    if (b) applyPreset(b.dataset.preset);
  });
  renderPresetGroup();
}

function applyPreset(name) {
  applyState({ ...DEFAULTS, ...PRESETS[name] });
  activePreset = name;
  const group = PRESET_GROUPS.find(g => g.presets.includes(name));
  if (group && group.id !== uiGroup) setGroup(group.id);
  else renderPresetGroup();
}

function clearActivePreset() {
  activePreset = null;
  document.querySelectorAll('.preset-btn.active').forEach(b => b.classList.remove('active'));
}

function randomize() {
  const r = Math.random, pick = a => a[Math.floor(r() * a.length)];
  const next = {
    ...DEFAULTS,
    volume: state.volume,
    darkness: 0.25 + r() * 0.5, resonance: r() * 0.4, movement: r() * 0.7, width: 0.3 + r() * 0.7,
    pitch: 28 + Math.floor(r() * 30), interval: pick(Object.keys(INTERVALS)), beat: r() < 0.5 ? 0 : r() * 0.5,
    drift: r() * 0.5, grit: r() * 0.4, space: r() * 0.8, age: r() * 0.5, breath: r() * 0.5,
    wow: r() < 0.4 ? r() * 0.4 : 0, crackle: r() < 0.25 ? r() * 0.35 : 0,
    verbSize: 0.3 + r() * 0.6, verbDamp: r() * 0.8, preDelay: r() * 0.08, shimmer: r() < 0.3 ? r() * 0.5 : 0,
    echoTime: 0.3 + r() * 0.6, echoFeedback: r() * 0.6, echoMix: r() < 0.35 ? r() * 0.35 : 0,
    modShape: pick(['sine', 'wander']),
    evDensity: r() < 0.5 ? 0.2 + r() * 0.45 : 0, evLevel: 0.4 + r() * 0.4, evDistance: r(), evVariety: 0.3 + r() * 0.7,
    eventSeed: 1 + Math.floor(r() * 1e6),
    ...evOnly(...EVENT_TYPES.filter(() => r() < 0.5)),
    ...ly('sub', { on: r() < 0.5, level: 0.3 + r() * 0.5, oct: pick([1, 2]) }),
  };
  LAYERS.forEach(L => Object.assign(next, ly(L, {
    on: L === 'bed' || r() < 0.5, src: pick(SOURCES), level: 0.3 + r() * 0.5,
    filter: (r() - 0.5) * 1.2, pan: (r() - 0.5) * 0.6, oct: pick([-1, 0, 0, 1]),
    color: pick(COLORS), harm: 1 + Math.floor(r() * 8), bright: r(), breathe: r(),
    exc: pick(['saw', 'noise']), vowel: r(), morph: r() * 0.7, inharm: r(), q: r() * 0.8,
    mains: pick([50, 60]), buzz: r(), flutter: r() * 0.5,
  })));
  applyState(next);
  clearActivePreset();
  const icon = document.querySelector('.randomize-icon');
  icon.classList.remove('spin');
  void icon.offsetWidth;
  icon.classList.add('spin');
}

function bindSlider(k) {
  const el = document.getElementById(k);
  // Shift-drag = fine control (1/10 speed)
  el.addEventListener('pointerdown', e => { el._fine = e.shiftKey; el._raw = null; el._v = state[k]; });
  el.addEventListener('pointerup', () => { el._fine = false; });
  el.addEventListener('input', () => {
    let v = parseFloat(el.value);
    if (el._fine) {
      if (el._raw === null) { el._raw = v; v = el._v; }
      else { const raw = v; v = clamp(el._v + (raw - el._raw) * 0.1, parseFloat(el.min), parseFloat(el.max)); el._raw = raw; }
      el._v = v;
      el.value = v;
    }
    setParam(k, v);
  });
  el.addEventListener('dblclick', () => { el.value = DEFAULTS[k]; setParam(k, DEFAULTS[k]); });
  el.value = state[k];
  updateSliderFill(el);
}

// ── Error display ─────────────────────────────────────────────────────────

function showError(msg) {
  let el = document.getElementById('error-msg');
  if (!el) {
    el = Object.assign(document.createElement('div'), { id: 'error-msg', className: 'error-msg' });
    document.querySelector('.app').prepend(el);
  }
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.remove(), 7000);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  meterFill = document.getElementById('meter-fill');
  limitBadge = document.getElementById('limit-badge');
  new ResizeObserver(resizeCanvas).observe(canvas.parentElement);
  resizeCanvas();

  buildLayerUI();
  SLIDER_KEYS.forEach(bindSlider);

  document.querySelectorAll('.toggle-group[data-key]').forEach(group => {
    group.addEventListener('click', e => {
      const b = e.target.closest('.toggle-btn');
      if (!b) return;
      const v = b.dataset.value;
      const t = typeof DEFAULTS[group.dataset.key];
      setChoice(group.dataset.key, t === 'number' ? Number(v) : t === 'boolean' ? v === 'true' : v);
    });
  });
  buildPresetUI();
  document.querySelectorAll('[data-flag]').forEach(btn => {
    btn.addEventListener('click', () => setChoice(btn.dataset.flag, !state[btn.dataset.flag]));
  });
  document.getElementById('ev-reseed').addEventListener('click', () => setChoice('eventSeed', state.eventSeed + 1));
  document.getElementById('ev-fire').addEventListener('click', () => { if (graph) graph.trigger(); });

  document.getElementById('play-btn').addEventListener('click', togglePlay);
  document.getElementById('randomize-btn').addEventListener('click', randomize);
  document.getElementById('record-btn').addEventListener('click', toggleCapture);

  const loopBox = document.getElementById('opt-loop'), fadeBox = document.getElementById('opt-fade');
  loopBox.addEventListener('change', () => { fadeBox.disabled = loopBox.checked; });

  document.getElementById('export-btn').addEventListener('click', async () => {
    const btn = document.getElementById('export-btn');
    btn.disabled = true;
    btn.textContent = 'Rendering…';
    try {
      await exportAudio();
    } catch (e) {
      showError('Render failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '↓ Render WAV';
    }
  });

  // Space = play/stop (also suppresses the focused button's own Space click)
  const isTyping = t => t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox');
  document.addEventListener('keydown', e => {
    if (e.code === 'KeyF' && !isTyping(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
      setChoice('freeze', !state.freeze);        // F = freeze / release the reverb tail
      return;
    }
    if (e.code === 'KeyE' && !isTyping(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
      if (graph) graph.trigger();                // E = fire an event now
      return;
    }
    if (e.code !== 'Space' || isTyping(e.target)) return;
    e.preventDefault();
    if (!e.repeat) togglePlay();
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space' && !isTyping(e.target)) e.preventDefault();
  });

  syncChoices();
});
