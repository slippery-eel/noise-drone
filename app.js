'use strict';

// ── AudioWorklet (inline Blob URL) ────────────────────────────────────────

const WORKLET_CODE = `
class NoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.type = (options.processorOptions || {}).type || 'white';
    this.b0 = this.b1 = this.b2 = this.b3 = this.b4 = this.b5 = this.b6 = 0;
    this.lastOut = 0; this.dcLastIn = 0; this.dcLastOut = 0;
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      const w = Math.random() * 2 - 1;
      let s;
      if (this.type === 'white') {
        s = w * 0.5;
      } else if (this.type === 'pink') {
        this.b0 = 0.99886*this.b0 + w*0.0555179;
        this.b1 = 0.99332*this.b1 + w*0.0750759;
        this.b2 = 0.96900*this.b2 + w*0.1538520;
        this.b3 = 0.86650*this.b3 + w*0.3104856;
        this.b4 = 0.55000*this.b4 + w*0.5329522;
        this.b5 = -0.7616*this.b5 - w*0.0168980;
        s = (this.b0+this.b1+this.b2+this.b3+this.b4+this.b5+this.b6+w*0.5362)*0.11;
        this.b6 = w*0.115926;
      } else {
        this.lastOut = (this.lastOut + 0.02*w) / 1.02;
        s = this.lastOut * 3.5;
        const dc = s - this.dcLastIn + 0.995*this.dcLastOut;
        this.dcLastIn = s; this.dcLastOut = dc; s = dc;
      }
      out[i] = s;
    }
    return true;
  }
}
registerProcessor('noise-processor', NoiseProcessor);
`;

// ── State ─────────────────────────────────────────────────────────────────

const state = {
  mode: 'white', playing: false,
  volume: 0.7, texture: 0.4, darkness: 0.5, movement: 0.2, pitch: 0.5,
  subAmount: 0, subOctave: 1,
  grit: 0, space: 0, drift: 0,
};

// ── Audio nodes ───────────────────────────────────────────────────────────

let audioCtx = null;
let workletReady = false;
let sourceNodes = [];
let padOscillators = [];
let textureFilter = null, darknessFilter = null;
let masterGain = null, analyserNode = null;
let lfoNode = null, lfoGainNode = null;
let subOsc = null, subFilter = null, subGain = null;
let waveshaper = null;
let convolver = null, dryGain = null, wetGain = null;
let driftTimer = null;

// ── Audio init ────────────────────────────────────────────────────────────

function createReverbIR(ctx, duration = 4) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * duration);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.3);
    }
  }
  return buf;
}

async function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  if (!workletReady) {
    try {
      const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      workletReady = true;
    } catch (_) {}
  }

  if (masterGain) return;

  masterGain = audioCtx.createGain();
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 4096;
  analyserNode.smoothingTimeConstant = 0.88;
  masterGain.connect(analyserNode);
  analyserNode.connect(audioCtx.destination);

  textureFilter = audioCtx.createBiquadFilter();
  darknessFilter = audioCtx.createBiquadFilter();
  darknessFilter.type = 'lowpass';
  darknessFilter.Q.value = 0.8;

  lfoNode = audioCtx.createOscillator();
  lfoNode.frequency.value = 0.3;
  lfoGainNode = audioCtx.createGain();
  lfoGainNode.gain.value = 0;
  lfoNode.connect(lfoGainNode);
  lfoGainNode.connect(darknessFilter.frequency);
  lfoNode.start();

  waveshaper = audioCtx.createWaveShaper();
  waveshaper.oversample = '4x';

  convolver = audioCtx.createConvolver();
  convolver.buffer = createReverbIR(audioCtx);
  dryGain = audioCtx.createGain();
  dryGain.gain.value = 1;
  wetGain = audioCtx.createGain();
  wetGain.gain.value = 0;

  textureFilter.connect(darknessFilter);
  darknessFilter.connect(waveshaper);
  waveshaper.connect(dryGain);
  waveshaper.connect(convolver);
  convolver.connect(wetGain);
  dryGain.connect(masterGain);
  wetGain.connect(masterGain);

  subFilter = audioCtx.createBiquadFilter();
  subFilter.type = 'lowpass';
  subFilter.frequency.value = 130;
  subFilter.Q.value = 0.5;
  subGain = audioCtx.createGain();
  subGain.gain.value = 0;
  subFilter.connect(subGain);
  subGain.connect(masterGain);
}

// ── Noise fallback (ScriptProcessorNode) ─────────────────────────────────

function createNoiseFallback(type) {
  const bufSize = 4096;
  const proc = audioCtx.createScriptProcessor(bufSize, 0, 1);
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0,lo=0,di=0,dco=0;
  proc.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
      const w = Math.random() * 2 - 1;
      let s;
      if (type === 'white') {
        s = w * 0.5;
      } else if (type === 'pink') {
        b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
        b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
        b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
        s = (b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11;
        b6 = w*0.115926;
      } else {
        lo = (lo + 0.02*w) / 1.02;
        s = lo * 3.5;
        const dc = s - di + 0.995*dco;
        di = s; dco = dc; s = dc;
      }
      out[i] = s;
    }
  };
  return proc;
}

// ── Source management ─────────────────────────────────────────────────────

function startSource() {
  stopSource();
  const isNoise = ['white','pink','brown'].includes(state.mode);

  if (isNoise) {
    const src = workletReady
      ? new AudioWorkletNode(audioCtx, 'noise-processor', { processorOptions: { type: state.mode } })
      : createNoiseFallback(state.mode);
    src.connect(textureFilter);
    sourceNodes = [src];
  } else if (state.mode === 'sine') {
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = pitchToFreq(state.pitch);
    osc.connect(textureFilter);
    osc.start();
    sourceNodes = [osc];
  } else if (state.mode === 'pad') {
    const mix = audioCtx.createGain();
    mix.gain.value = 0.2;
    mix.connect(textureFilter);
    const spread = state.texture * 30;
    const freq = pitchToFreq(state.pitch);
    padOscillators = [-2,-1,0,1,2].map((d, i) => {
      const osc = audioCtx.createOscillator();
      const pan = audioCtx.createStereoPanner();
      pan.pan.value = (i - 2) * 0.18;
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = d * spread;
      osc.connect(pan);
      pan.connect(mix);
      osc.start();
      return osc;
    });
    sourceNodes = [...padOscillators, mix];
  }

  // Sub oscillator — created fresh each play so its phase aligns with the main source
  if (subOsc) {
    try { subOsc.stop(); } catch (_) {}
    try { subOsc.disconnect(); } catch (_) {}
  }
  subOsc = audioCtx.createOscillator();
  subOsc.type = 'sine';
  subOsc.frequency.value = pitchToFreq(state.pitch) / Math.pow(2, state.subOctave);
  subOsc.connect(subFilter);
  subOsc.start();

  applySliders();
}

function stopSource() {
  sourceNodes.forEach(n => {
    try { if (n.stop) n.stop(); } catch (_) {}
    try { n.disconnect(); } catch (_) {}
  });
  sourceNodes = [];
  padOscillators = [];

  if (subOsc) {
    try { subOsc.stop(); } catch (_) {}
    try { subOsc.disconnect(); } catch (_) {}
    subOsc = null;
  }
  if (subGain) subGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.02);
}

// ── Grit (waveshaper curve) ───────────────────────────────────────────────

function applyGrit(amount) {
  if (!waveshaper) return;
  if (amount < 0.01) { waveshaper.curve = null; return; }
  const n = 512;
  const curve = new Float32Array(n);
  const k = amount * 100;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
  }
  waveshaper.curve = curve;
}

// ── Slider → audio params ─────────────────────────────────────────────────

function pitchToFreq(v) {
  return 55 * Math.pow(16, v); // 55 Hz – 880 Hz
}

function applySliders() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const T = 0.05;
  const isNoise = ['white','pink','brown'].includes(state.mode);

  masterGain.gain.setTargetAtTime(state.volume, now, T);
  darknessFilter.frequency.setTargetAtTime(20000 * Math.pow(200/20000, state.darkness), now, T);
  lfoGainNode.gain.setTargetAtTime(state.movement * 600, now, T);

  if (isNoise) {
    textureFilter.type = 'peaking';
    textureFilter.Q.value = 0.8;
    textureFilter.gain.value = 8;
    textureFilter.frequency.setTargetAtTime(200 + state.texture * 7800, now, T);
  } else {
    textureFilter.type = 'highshelf';
    textureFilter.frequency.value = 2000;
    textureFilter.gain.setTargetAtTime(state.texture * 8, now, T);

    const freq = pitchToFreq(state.pitch);
    if (state.mode === 'sine' && sourceNodes[0]) {
      sourceNodes[0].frequency.setTargetAtTime(freq, now, T);
    }
    if (state.mode === 'pad' && padOscillators.length) {
      const spread = state.texture * 30;
      padOscillators.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freq, now, T);
        osc.detune.setTargetAtTime([-2,-1,0,1,2][i] * spread, now, T);
      });
    }
  }

  if (subGain && subOsc) {
    const subFreq = pitchToFreq(state.pitch) / Math.pow(2, state.subOctave);
    subOsc.frequency.setTargetAtTime(subFreq, now, T);
    subGain.gain.setTargetAtTime(state.subAmount * 0.85, now, T);
  }

  applyGrit(state.grit);

  if (dryGain && wetGain) {
    dryGain.gain.setTargetAtTime(1 - state.space * 0.65, now, T);
    wetGain.gain.setTargetAtTime(state.space * 0.65, now, T);
  }
}

// ── Drift (slow pitch wander) ─────────────────────────────────────────────

function startDrift() {
  stopDrift();
  driftTimer = setInterval(() => {
    if (!state.playing || state.drift < 0.01) return;
    if (!['sine','pad'].includes(state.mode)) return;
    const now = audioCtx.currentTime;
    const base = pitchToFreq(state.pitch);
    const freq = base * (1 + (Math.random() * 2 - 1) * state.drift * 0.04);
    if (state.mode === 'sine' && sourceNodes[0]) {
      sourceNodes[0].frequency.setTargetAtTime(freq, now, 2.5);
    } else if (state.mode === 'pad') {
      padOscillators.forEach((osc, i) => {
        osc.frequency.setTargetAtTime(freq, now, 2.5 + i * 0.2);
      });
    }
  }, 2400);
}

function stopDrift() {
  if (driftTimer) clearInterval(driftTimer);
  driftTimer = null;
}

// ── Play / stop ───────────────────────────────────────────────────────────

async function togglePlay() {
  const btn = document.getElementById('play-btn');
  if (state.playing) {
    stopSource();
    stopDrift();
    state.playing = false;
    btn.querySelector('.play-label').textContent = 'Play';
    btn.querySelector('.play-icon').textContent = '▶';
    btn.classList.remove('active');
    return;
  }
  btn.classList.add('loading');
  try {
    await initAudio();
    startSource();
    startDrift();
    state.playing = true;
    btn.querySelector('.play-label').textContent = 'Stop';
    btn.querySelector('.play-icon').textContent = '■';
    btn.classList.add('active');
  } catch (e) {
    showError('Could not start audio. Try opening via a local server (e.g. npx serve .)');
  } finally {
    btn.classList.remove('loading');
  }
}

// ── Export ────────────────────────────────────────────────────────────────

function generateNoiseSamples(type, count) {
  const buf = new Float32Array(count);
  let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0,lo=0,di=0,dco=0;
  for (let i = 0; i < count; i++) {
    const w = Math.random() * 2 - 1;
    let s;
    if (type === 'white') {
      s = w * 0.5;
    } else if (type === 'pink') {
      b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
      b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
      b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
      s = (b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11; b6=w*0.115926;
    } else {
      lo = (lo + 0.02*w) / 1.02; s = lo * 3.5;
      const dc = s - di + 0.995*dco; di=s; dco=dc; s=dc;
    }
    buf[i] = s;
  }
  return buf;
}

async function exportAudio(duration) {
  const SR = 44100;
  const len = SR * duration;
  const offCtx = new OfflineAudioContext(2, len, SR);
  const isNoise = ['white','pink','brown'].includes(state.mode);

  const offGain = offCtx.createGain();
  offGain.gain.value = state.volume;
  offGain.connect(offCtx.destination);

  const offTexture = offCtx.createBiquadFilter();
  const offDark = offCtx.createBiquadFilter();
  offDark.type = 'lowpass';
  offDark.Q.value = 0.8;
  offDark.frequency.value = 20000 * Math.pow(200/20000, state.darkness);

  const offWS = offCtx.createWaveShaper();
  offWS.oversample = '4x';
  if (state.grit > 0.01) {
    const n = 512, k = state.grit * 100;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i*2)/n - 1;
      curve[i] = ((Math.PI+k)*x) / (Math.PI+k*Math.abs(x));
    }
    offWS.curve = curve;
  }

  const offDry = offCtx.createGain();
  offDry.gain.value = 1 - state.space * 0.65;
  const offWet = offCtx.createGain();
  offWet.gain.value = state.space * 0.65;
  const offReverb = offCtx.createConvolver();
  offReverb.buffer = createReverbIR(offCtx);

  offTexture.connect(offDark);
  offDark.connect(offWS);
  offWS.connect(offDry);
  offWS.connect(offReverb);
  offReverb.connect(offWet);
  offDry.connect(offGain);
  offWet.connect(offGain);

  if (state.movement > 0.01) {
    const lfo = offCtx.createOscillator();
    lfo.frequency.value = 0.3;
    const lfoG = offCtx.createGain();
    lfoG.gain.value = state.movement * 600;
    lfo.connect(lfoG);
    lfoG.connect(offDark.frequency);
    lfo.start();
  }

  if (isNoise) {
    offTexture.type = 'peaking';
    offTexture.Q.value = 0.8;
    offTexture.gain.value = 8;
    offTexture.frequency.value = 200 + state.texture * 7800;
    const samples = generateNoiseSamples(state.mode, len);
    const nb = offCtx.createBuffer(1, len, SR);
    nb.getChannelData(0).set(samples);
    const src = offCtx.createBufferSource();
    src.buffer = nb; src.connect(offTexture); src.start();
  } else {
    offTexture.type = 'highshelf';
    offTexture.frequency.value = 2000;
    offTexture.gain.value = state.texture * 8;
    const freq = pitchToFreq(state.pitch);
    if (state.mode === 'sine') {
      const osc = offCtx.createOscillator();
      osc.type = 'sine'; osc.frequency.value = freq;
      osc.connect(offTexture); osc.start();
    } else {
      const mix = offCtx.createGain();
      mix.gain.value = 0.2; mix.connect(offTexture);
      const spread = state.texture * 30;
      [-2,-1,0,1,2].forEach((d, i) => {
        const osc = offCtx.createOscillator();
        const pan = offCtx.createStereoPanner();
        pan.pan.value = (i - 2) * 0.18;
        osc.type = 'sawtooth'; osc.frequency.value = freq; osc.detune.value = d * spread;
        osc.connect(pan); pan.connect(mix); osc.start();
      });
    }
  }

  if (state.subAmount > 0.01) {
    const sOsc = offCtx.createOscillator();
    sOsc.type = 'sine';
    sOsc.frequency.value = pitchToFreq(state.pitch) / Math.pow(2, state.subOctave);
    const sF = offCtx.createBiquadFilter();
    sF.type = 'lowpass'; sF.frequency.value = 130; sF.Q.value = 0.5;
    const sG = offCtx.createGain();
    sG.gain.value = state.subAmount * 0.85;
    sOsc.connect(sF); sF.connect(sG); sG.connect(offGain);
    sOsc.start();
  }

  const rendered = await offCtx.startRendering();
  const wavBuf = encodeWAV(rendered.getChannelData(0), SR);
  const blob = new Blob([wavBuf], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.mode}-${duration}s.wav`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function encodeWAV(samples, sr) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off+i, s.charCodeAt(i)); };
  str(0,'RIFF'); v.setUint32(4, 36+n*2, true);
  str(8,'WAVE'); str(12,'fmt '); v.setUint32(16,16,true);
  v.setUint16(20,1,true); v.setUint16(22,1,true);
  v.setUint32(24,sr,true); v.setUint32(28,sr*2,true);
  v.setUint16(32,2,true); v.setUint16(34,16,true);
  str(36,'data'); v.setUint32(40,n*2,true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44+i*2, s < 0 ? s*0x8000 : s*0x7FFF, true);
  }
  return buf;
}

// ── Visualization ─────────────────────────────────────────────────────────

const canvas = document.getElementById('visualizer');
const canvasCtx = canvas.getContext('2d');

function resizeCanvas() {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = Math.floor(r.width);
  canvas.height = Math.floor(r.height);
}

new ResizeObserver(resizeCanvas).observe(canvas.parentElement);
resizeCanvas();

function drawFrame() {
  requestAnimationFrame(drawFrame);
  const W = canvas.width, H = canvas.height, cy = H / 2;

  canvasCtx.fillStyle = 'rgba(8,11,18,0.2)';
  canvasCtx.fillRect(0, 0, W, H);

  if (!analyserNode || !state.playing) {
    canvasCtx.beginPath();
    canvasCtx.strokeStyle = 'rgba(0,229,255,0.2)';
    canvasCtx.lineWidth = 1;
    canvasCtx.shadowBlur = 6;
    canvasCtx.shadowColor = '#00e5ff';
    canvasCtx.moveTo(0, cy); canvasCtx.lineTo(W, cy);
    canvasCtx.stroke(); canvasCtx.shadowBlur = 0;
    return;
  }

  const isNoise = ['white','pink','brown'].includes(state.mode);

  if (isNoise) {
    // Waveform
    const data = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.getByteTimeDomainData(data);
    canvasCtx.beginPath();
    canvasCtx.strokeStyle = '#00e5ff';
    canvasCtx.lineWidth = 1.5;
    canvasCtx.shadowBlur = 14;
    canvasCtx.shadowColor = 'rgba(0,229,255,0.5)';
    for (let x = 0; x < W; x++) {
      const i = Math.floor(x / W * data.length);
      const y = (data[i] / 128 - 1) * cy * 0.82 + cy;
      if (x === 0) canvasCtx.moveTo(x, y); else canvasCtx.lineTo(x, y);
    }
    canvasCtx.stroke();
    canvasCtx.shadowBlur = 0;
  } else {
    // Log-scale spectrum (emphasises bass)
    const data = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.getByteFrequencyData(data);
    const maxBin = Math.min(Math.floor(data.length * 0.35), data.length - 1);

    canvasCtx.beginPath();
    canvasCtx.moveTo(0, H);
    for (let x = 0; x < W; x++) {
      const t = x / W;
      const bin = Math.floor(Math.pow(t, 1.6) * maxBin);
      const y = H - (data[bin] / 255) * H * 0.9;
      canvasCtx.lineTo(x, y);
    }
    canvasCtx.lineTo(W, H);
    canvasCtx.closePath();
    const grad = canvasCtx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(0,229,255,0.65)');
    grad.addColorStop(0.5, 'rgba(0,100,180,0.3)');
    grad.addColorStop(1, 'rgba(0,40,80,0.05)');
    canvasCtx.fillStyle = grad;
    canvasCtx.fill();

    // Glow edge
    canvasCtx.beginPath();
    canvasCtx.strokeStyle = '#00e5ff';
    canvasCtx.lineWidth = 1.5;
    canvasCtx.shadowBlur = 14;
    canvasCtx.shadowColor = 'rgba(0,229,255,0.5)';
    for (let x = 0; x < W; x++) {
      const t = x / W;
      const bin = Math.floor(Math.pow(t, 1.6) * maxBin);
      const y = H - (data[bin] / 255) * H * 0.9;
      if (x === 0) canvasCtx.moveTo(x, y); else canvasCtx.lineTo(x, y);
    }
    canvasCtx.stroke();
    canvasCtx.shadowBlur = 0;
  }
}

drawFrame();

// ── Mode switching ────────────────────────────────────────────────────────

function setMode(mode, restartIfPlaying = true) {
  state.mode = mode;
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  if (state.playing && restartIfPlaying) startSource();
}

// ── Sub octave toggle ─────────────────────────────────────────────────────

function setSubOctave(oct) {
  state.subOctave = oct;
  document.querySelectorAll('[data-octave]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.octave) === oct);
  });
  if (audioCtx && subOsc) {
    subOsc.frequency.setTargetAtTime(
      pitchToFreq(state.pitch) / Math.pow(2, oct),
      audioCtx.currentTime, 0.1
    );
  }
}

// ── Presets ───────────────────────────────────────────────────────────────

const PRESETS = {
  industrial:  { mode:'pad',  volume:0.75, texture:0.65, darkness:0.72, movement:0.45, pitch:0.15, subAmount:0.70, subOctave:1, grit:0.60, space:0.20, drift:0.10 },
  ritual:      { mode:'sine', volume:0.70, texture:0.25, darkness:0.62, movement:0.18, pitch:0.22, subAmount:0.55, subOctave:2, grit:0.08, space:0.65, drift:0.35 },
  mechanical:  { mode:'pad',  volume:0.72, texture:0.78, darkness:0.55, movement:0.62, pitch:0.30, subAmount:0.50, subOctave:1, grit:0.48, space:0.18, drift:0.05 },
  haunted:     { mode:'sine', volume:0.58, texture:0.18, darkness:0.80, movement:0.28, pitch:0.38, subAmount:0.30, subOctave:2, grit:0.12, space:0.78, drift:0.55 },
  'deep-space':{ mode:'sine', volume:0.65, texture:0.08, darkness:0.48, movement:0.08, pitch:0.25, subAmount:0.80, subOctave:2, grit:0.03, space:0.88, drift:0.08 },
};

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;
  const modeChanged = p.mode !== state.mode;
  if (modeChanged) setMode(p.mode, false);
  Object.entries(p).forEach(([k, v]) => {
    if (k === 'mode') return;
    if (k === 'subOctave') { setSubOctave(v); return; }
    state[k] = v;
    const el = document.getElementById(k);
    if (el) animateSlider(el, v);
  });
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.preset === name);
  });
  if (state.playing) { if (modeChanged) startSource(); else applySliders(); }
}

// ── Action macros ─────────────────────────────────────────────────────────

const ACTIONS = {
  darker:      { darkness:+0.2,  subAmount:+0.15, space:+0.05 },
  massive:     { subAmount:+0.28, pitch:-0.1,    space:+0.22, volume:+0.05 },
  corrupt:     { grit:+0.28,     drift:+0.12,   texture:+0.12 },
  destabilize: { drift:+0.25,    movement:+0.2, grit:+0.08 },
};

function applyAction(name) {
  const deltas = ACTIONS[name];
  if (!deltas) return;
  Object.entries(deltas).forEach(([k, delta]) => {
    const val = Math.max(0, Math.min(1, (state[k] || 0) + delta));
    state[k] = val;
    const el = document.getElementById(k);
    if (el) animateSlider(el, val);
  });
  document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
  if (audioCtx) applySliders();
}

// ── Randomize ─────────────────────────────────────────────────────────────

const MODES = ['white','pink','brown','sine','pad'];

function randomize() {
  const newMode = MODES[Math.floor(Math.random() * MODES.length)];
  const next = {
    volume:    0.5  + Math.random() * 0.35,
    texture:   Math.random(),
    darkness:  0.2  + Math.random() * 0.6,
    movement:  Math.random() * 0.7,
    pitch:     0.1  + Math.random() * 0.8,
    subAmount: Math.random() * 0.7,
    grit:      Math.random() * 0.5,
    space:     Math.random() * 0.6,
    drift:     Math.random() * 0.4,
  };
  const newOct = Math.random() > 0.5 ? 2 : 1;
  setSubOctave(newOct);

  const modeChanged = newMode !== state.mode;
  if (modeChanged) setMode(newMode, false);
  Object.entries(next).forEach(([k, v]) => {
    state[k] = v;
    const el = document.getElementById(k);
    if (el) animateSlider(el, v);
  });
  document.querySelectorAll('.preset-btn').forEach(btn => btn.classList.remove('active'));
  if (state.playing) { if (modeChanged) startSource(); else applySliders(); }

  const icon = document.querySelector('.randomize-icon');
  icon.classList.remove('spin');
  void icon.offsetWidth;
  icon.classList.add('spin');
}

// ── Slider helpers ────────────────────────────────────────────────────────

function updateSliderFill(el) {
  const pct = ((parseFloat(el.value) - parseFloat(el.min)) /
               (parseFloat(el.max) - parseFloat(el.min))) * 100;
  el.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--border) ${pct}%)`;
  const valEl = document.getElementById(el.id + '-val');
  if (valEl) valEl.textContent = parseFloat(el.value).toFixed(2);
}

function animateSlider(el, target, ms = 420) {
  const from = parseFloat(el.value);
  const t0 = performance.now();
  function step(now) {
    const p = Math.min((now - t0) / ms, 1);
    const e = p < 0.5 ? 2*p*p : 1 - Math.pow(-2*p+2, 2)/2;
    el.value = from + (target - from) * e;
    updateSliderFill(el);
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Error display ─────────────────────────────────────────────────────────

function showError(msg) {
  let el = document.getElementById('error-msg');
  if (!el) {
    el = Object.assign(document.createElement('div'), { id:'error-msg', className:'error-msg' });
    document.querySelector('.app').prepend(el);
  }
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.remove(), 7000);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  const sliders = ['volume','texture','darkness','movement','pitch','subAmount','grit','space','drift'];
  sliders.forEach(name => {
    const el = document.getElementById(name);
    el.addEventListener('input', () => {
      state[name] = parseFloat(el.value);
      updateSliderFill(el);
      if (audioCtx) applySliders();
    });
    updateSliderFill(el);
  });

  document.querySelectorAll('[data-octave]').forEach(btn => {
    btn.addEventListener('click', () => setSubOctave(parseInt(btn.dataset.octave)));
  });

  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });

  document.querySelectorAll('.action-btn').forEach(btn => {
    btn.addEventListener('click', () => applyAction(btn.dataset.action));
  });

  document.getElementById('play-btn').addEventListener('click', togglePlay);
  document.getElementById('randomize-btn').addEventListener('click', randomize);

  document.getElementById('export-btn').addEventListener('click', async () => {
    const btn = document.getElementById('export-btn');
    const duration = parseInt(document.querySelector('input[name="duration"]:checked').value);
    btn.disabled = true;
    btn.textContent = 'Exporting…';
    try {
      await exportAudio(duration);
    } catch (e) {
      showError('Export failed: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '↓ Export';
    }
  });

  setMode('white', false);
});
