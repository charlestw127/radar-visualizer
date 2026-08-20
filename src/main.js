/**
 * Entry point: wires Params → Simulation → active Renderer, and runs the
 * requestAnimationFrame loop.
 */
import { Params } from './params.js';
import { Simulation } from './simulation.js';
import { computeLayout } from './scene.js';
import { buildControls } from './controls.js';
import * as waveRenderer from './renderers/wave.js';
import * as ringRenderer from './renderers/ring.js';

const RENDERERS = { wave: waveRenderer, ring: ringRenderer };

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');

const params = new Params();
const sim = new Simulation(params);
let renderer = RENDERERS.wave;
let canvasW = 1;
let canvasH = 1;
let layout = computeLayout(canvasW, canvasH, params.rangeUs);

buildControls(
  document.getElementById('controls'),
  document.getElementById('readouts'),
  params,
);

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

// URL params: ?style=wave|ring selects the renderer, ?t=<µs> fast-forwards the
// simulation on load (handy for screenshots and debugging).
const urlParams = new URLSearchParams(location.search);
setStyle(urlParams.get('style') || 'wave');
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

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === '1') setStyle('wave');
  else if (e.key === '2') setStyle('ring');
  else if (e.key === 'r' || e.key === 'R') sim.reset();
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

let last = performance.now();
function frame(now) {
  // Clamp dt so a backgrounded tab does not fast-forward on return.
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  sim.step(dt);
  // Layout depends on the range slider, so recompute each frame (cheap).
  layout = computeLayout(canvasW, canvasH, params.rangeUs);
  renderer.render(ctx, layout, sim);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
