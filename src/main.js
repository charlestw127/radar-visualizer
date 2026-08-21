/**
 * Entry point: wires Params → Simulation → active Renderer, and runs the
 * requestAnimationFrame loop. Also owns the side effects that hang off the
 * loop: sensor motion, the hit ping, the spectrum panel and live readouts.
 */
import {
  Params, PARAM_SPECS, C_M_PER_US, fmtSig, fmtFrequencyHz,
} from './params.js';
import { Simulation } from './simulation.js';
import { computeLayout } from './scene.js';
import { buildControls, buildLiveReadouts } from './controls.js';
import { Pinger } from './audio.js';
import { SpectrumView } from './spectrum.js';
import { SensorMotion } from './sensorMotion.js';
import * as waveRenderer from './renderers/wave.js';
import * as ringRenderer from './renderers/ring.js';

const RENDERERS = { wave: waveRenderer, ring: ringRenderer };

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');

const params = new Params();
const sim = new Simulation(params);
const motion = new SensorMotion(params);
let renderer = RENDERERS.wave;
let canvasW = 1;
let canvasH = 1;
let layout = computeLayout(canvasW, canvasH, params.rangeUs);

buildControls(
  {
    waveform: document.getElementById('controls'),
    sensor: document.getElementById('sensor-controls'),
  },
  document.getElementById('readouts'),
  params,
);
const updateLive = buildLiveReadouts(
  document.getElementById('live-readouts'),
  ['Live range', 'Radial velocity', 'Doppler shift', 'Path loss'],
);
const spectrum = new SpectrumView(document.getElementById('spectrum'));

// ---- Style switching ------------------------------------------------------

function setStyle(name) {
  if (!RENDERERS[name]) return;
  renderer = RENDERERS[name];
  const radio = document.querySelector(`input[name="style"][value="${name}"]`);
  if (radio) radio.checked = true;
}

for (const radio of document.querySelectorAll('input[name="style"]')) {
  radio.addEventListener('change', () => setStyle(radio.value));
}

// ---- Sensor motion ----------------------------------------------------------

const orbitToggle = document.getElementById('orbit-toggle');
function setOrbit(on) {
  motion.enabled = on;
  orbitToggle.checked = on;
}
orbitToggle.addEventListener('change', () => setOrbit(orbitToggle.checked));

// ---- URL params ---------------------------------------------------------------
// ?style=wave|ring selects the renderer, ?orbit=1 starts with a moving sensor,
// ?t=<µs> fast-forwards the simulation on load, and any PARAM_SPECS key
// (e.g. ?pri=5&pulseWidth=1) presets a slider — for sharing a scenario,
// screenshots and debugging.

const urlParams = new URLSearchParams(location.search);
for (const key of Object.keys(PARAM_SPECS)) {
  if (urlParams.has(key)) params.set(key, Number(urlParams.get(key)));
}
setStyle(urlParams.get('style') || 'wave');
setOrbit(['1', 'true', 'on'].includes(urlParams.get('orbit') ?? ''));
if (urlParams.has('angle')) motion.angle = (Number(urlParams.get('angle')) * Math.PI) / 180; // orbit start, degrees
const fastForwardUs = Number(urlParams.get('t'));
if (fastForwardUs > 0) sim.step(fastForwardUs / params.get('timeScale'));

// ---- Pause / reset ----------------------------------------------------------

const pauseBtn = document.getElementById('btn-pause');
function togglePause() {
  sim.running = !sim.running;
  pauseBtn.textContent = sim.running ? 'Pause' : 'Resume';
}
pauseBtn.addEventListener('click', togglePause);
document.getElementById('btn-reset').addEventListener('click', () => sim.reset());

// ---- Sound --------------------------------------------------------------------

const pinger = new Pinger();
const soundBtn = document.getElementById('btn-sound');
function setSound(on) {
  pinger.enabled = on;
  soundBtn.textContent = on ? 'Sound on' : 'Muted';
  soundBtn.setAttribute('aria-pressed', String(on));
}
soundBtn.addEventListener('click', () => setSound(!pinger.enabled));

// Browsers only allow audio after a user gesture; unlock on the first one.
const unlockAudio = () => pinger.unlock();
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('keydown', unlockAudio);

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === '1') setStyle('wave');
  else if (e.key === '2') setStyle('ring');
  else if (e.key === 'r' || e.key === 'R') sim.reset();
  else if (e.key === 'm' || e.key === 'M') setSound(!pinger.enabled);
  else if (e.key === 'o' || e.key === 'O') setOrbit(!motion.enabled);
});

// ---- Canvas sizing ----------------------------------------------------------

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const { clientWidth: w, clientHeight: h } = canvas;
  if (w === 0 || h === 0) return;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvasW = w;
  canvasH = h;
}
new ResizeObserver(resize).observe(canvas);
resize();

// ---- Main loop --------------------------------------------------------------

function liveReadoutValues() {
  const rangeKm = (layout.rangeUs * C_M_PER_US) / 1000;
  if (!layout.orbit) return [`${fmtSig(rangeKm)} km`, '—', '—', '—'];
  const vr = layout.radialVelocity;
  const tag = vr > 1 ? ' closing' : vr < -1 ? ' opening' : '';
  const sign = (x) => (x > 0 ? '+' : x < 0 ? '−' : '');
  return [
    `${fmtSig(rangeKm)} km`,
    `${sign(vr)}${fmtSig(Math.abs(vr))} m/s${tag}`,
    `${sign(layout.dopplerHz)}${fmtFrequencyHz(Math.abs(layout.dopplerHz))}`,
    `${layout.pathGainDb.toFixed(1)} dB`,
  ];
}

let last = performance.now();
function frame(now) {
  // Clamp dt so a backgrounded tab does not fast-forward on return.
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  sim.step(dt);
  motion.update(sim.running ? dt : 0);
  // Layout depends on the range slider and sensor motion, so recompute each frame (cheap).
  layout = motion.apply(computeLayout(canvasW, canvasH, params.rangeUs));

  // Hits are registered inside render() (via sim.sensorIntensity); ping on any new ones.
  const hitsBefore = sim.hitCount;
  renderer.render(ctx, layout, sim);
  if (sim.hitCount > hitsBefore) {
    // Quieter with path loss (amplitude ∝ 1/R), pitch bent by closing/opening
    // speed as an exaggerated Doppler cue (±4 semitones at full radial speed).
    const amplitude = Math.sqrt(layout.pathGain);
    const bend = layout.orbit ? 4 * (layout.radialVelocity / params.get('platformSpeed')) : 0;
    pinger.play(sim.lastHitFrequency, { gain: 0.3 + 0.7 * amplitude, bendSemitones: bend });
  }

  spectrum.draw(params, sim, layout);
  updateLive(liveReadoutValues());
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
