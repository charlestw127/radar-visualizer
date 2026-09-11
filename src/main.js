/**
 * Entry point: wires Params → Simulation → the active mode → renderer, and
 * runs the requestAnimationFrame loop.
 *
 * BEAM mode's frame path is the original code (Simulation + SensorMotion +
 * wave/ring renderer) and must stay behaviourally identical. The radar /
 * hunt / battle modes route through their mode context (modes.js), which
 * owns the RadarModel, game state and cosmetic echo field; renderers reach
 * it via `layout.game`.
 */
import {
  Params, PARAM_SPECS, C_M_PER_US, fmtSig, fmtFrequencyHz,
} from './params.js';
import { Simulation } from './simulation.js';
import { computeLayout, computeCentredLayout } from './scene.js';
import { buildControls, buildLiveReadouts } from './controls.js';
import { Pinger } from './audio.js';
import { SpectrumView } from './spectrum.js';
import { SensorMotion } from './sensorMotion.js';
import { ParamMemory, RadarModeCtx, HuntModeCtx, BattleModeCtx } from './modes.js';
import { RCS_CLASSES } from './rf.js';
import * as waveRenderer from './renderers/wave.js';
import * as ringRenderer from './renderers/ring.js';
import * as monostaticRenderer from './renderers/monostatic.js';
import * as ppiRenderer from './renderers/ppi.js';

const RENDERERS = { wave: waveRenderer, ring: ringRenderer };
const KM_TO_US = 1000 / C_M_PER_US;

const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');

const params = new Params();
const sim = new Simulation(params);
const motion = new SensorMotion(params);
const modeCtxs = {
  radar: new RadarModeCtx(params),
  hunt: new HuntModeCtx(params),
  battle: new BattleModeCtx(params),
};
const paramMemory = new ParamMemory(params);
let mode = null;                 // 'beam' | 'radar' | 'hunt' | 'battle'
let renderer = RENDERERS.wave;   // beam-mode style renderer
let canvasW = 1;
let canvasH = 1;
let layout = computeLayout(canvasW, canvasH, params.rangeUs);

const controlsApi = buildControls(
  {
    waveform: document.getElementById('controls'),
    sensor: document.getElementById('sensor-controls'),
    radar: document.getElementById('radar-controls'),
    radartarget: document.getElementById('radartarget-controls'),
    ecm: document.getElementById('ecm-controls'),
  },
  document.getElementById('readouts'),
  params,
);
const beamLive = buildLiveReadouts(
  document.getElementById('live-readouts'),
  ['Live range', 'Radial velocity', 'Doppler shift', 'Path loss'],
);
const modeLive = {
  radar: buildLiveReadouts(document.getElementById('radar-live'), modeCtxs.radar.liveLabels),
  hunt: buildLiveReadouts(document.getElementById('hunt-live'), modeCtxs.hunt.liveLabels),
  battle: buildLiveReadouts(document.getElementById('battle-live'), modeCtxs.battle.liveLabels),
};
const spectrum = new SpectrumView(document.getElementById('spectrum'));

// ---- Mode switching -----------------------------------------------------------

function setMode(next) {
  // Object.hasOwn: `in` would accept prototype keys (?mode=constructor).
  if (next !== 'beam' && !Object.hasOwn(modeCtxs, next)) next = 'beam';
  if (next === mode) return;
  if (mode) paramMemory.save(mode);
  mode = next;
  paramMemory.load(mode);
  sim.reset();

  document.body.dataset.mode = mode;
  for (const sec of document.querySelectorAll('.mode-section')) {
    sec.classList.toggle('active', sec.dataset.modes.split(' ').includes(mode));
  }
  const radio = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  controlsApi.refreshLabels(mode);

  const mc = modeCtxs[mode];
  if (mc) mc.enter();
  if (mode === 'radar') modeCtxs.radar.target.orbiting = targetOrbitToggle.checked;
  if (mode === 'battle') rebuildPlatformList();
}

for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', () => setMode(radio.value));
}

// ---- Beam-mode style switching ------------------------------------------------

function setStyle(name) {
  if (!RENDERERS[name]) return;
  renderer = RENDERERS[name];
  const radio = document.querySelector(`input[name="style"][value="${name}"]`);
  if (radio) radio.checked = true;
}

for (const radio of document.querySelectorAll('input[name="style"]')) {
  radio.addEventListener('change', () => setStyle(radio.value));
}

// ---- Sensor / target orbit toggles --------------------------------------------

const orbitToggle = document.getElementById('orbit-toggle');
function setOrbit(on) {
  motion.enabled = on;
  orbitToggle.checked = on;
}
orbitToggle.addEventListener('change', () => setOrbit(orbitToggle.checked));

const targetOrbitToggle = document.getElementById('target-orbit-toggle');
targetOrbitToggle.addEventListener('change', () => {
  modeCtxs.radar.target.orbiting = targetOrbitToggle.checked;
});

// ---- Hunt identify buttons -----------------------------------------------------

const huntStatusEl = document.getElementById('hunt-status');
let huntFlash = null;
let huntFlashUntil = 0;
const identifyButtons = [];
{
  const box = document.getElementById('identify-buttons');
  for (const cls of RCS_CLASSES) {
    const b = document.createElement('button');
    identifyButtons.push(b);
    b.type = 'button';
    b.textContent = `${cls.label} ~${fmtSig(cls.rcsM2, 2)} m²`;
    b.addEventListener('click', () => {
      const res = modeCtxs.hunt.game.guess(cls.id);
      if (res && !res.correct) {
        huntFlash = `Not a ${cls.label.toLowerCase()} — keep tracking.`;
        huntFlashUntil = performance.now() + 3000;
      }
    });
    box.append(b);
  }
}
document.getElementById('btn-new-hunt').addEventListener('click', () => restartGame());

// ---- Battle platform list ------------------------------------------------------

let platformRows = [];
function rebuildPlatformList() {
  const list = document.getElementById('platform-list');
  list.textContent = '';
  platformRows = [];
  const game = modeCtxs.battle.game;
  game.platforms.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'platform-row';
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = `#${i + 1} ${p.cls.label} · ${p.cls.speedMps} m/s`;
    const status = document.createElement('span');
    status.className = 'p-status';
    const ea = document.createElement('button');
    ea.type = 'button';
    ea.className = 'p-ea';
    ea.textContent = 'EA off';
    row.addEventListener('click', () => modeCtxs.battle.game.select(p.id));
    ea.addEventListener('click', (e) => {
      e.stopPropagation();
      modeCtxs.battle.game.toggleEa(p.id);
    });
    row.append(name, status, ea);
    list.append(row);
    platformRows.push({ p, row, status, ea });
  });
}

function updatePlatformList() {
  const game = modeCtxs.battle.game;
  for (const { p, row, status, ea } of platformRows) {
    row.classList.toggle('selected', game.selectedId === p.id);
    const s = game.statuses.get(p.id) ?? 'HIDDEN';
    if (status.textContent !== s) {
      status.textContent = s;
      status.dataset.s = s;
    }
    const eaTxt = p.ea ? 'EA ON' : 'EA off';
    if (ea.textContent !== eaTxt) {
      ea.textContent = eaTxt;
      ea.setAttribute('aria-pressed', String(p.ea));
    }
    ea.disabled = !p.alive;
  }
}

document.getElementById('btn-restart-battle').addEventListener('click', () => restartGame());

function restartGame() {
  const mc = modeCtxs[mode];
  if (!mc) return;
  sim.reset();
  huntFlash = null; // a wrong-guess message must not describe the next round
  if (mc.restart) mc.restart(); else mc.enter();
  if (mode === 'battle') rebuildPlatformList();
}

// ---- Pointer input on the scene ------------------------------------------------

function eventWorld(e) {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const kmPerPx = 1 / (KM_TO_US * layout.pxPerUs);
  return {
    mx, my,
    xKm: (mx - layout.emitter.x) * kmPerPx,
    yKm: -(my - layout.emitter.y) * kmPerPx, // PPI is y-up
    azRad: Math.atan2(-(my - layout.emitter.y), mx - layout.emitter.x),
  };
}

canvas.addEventListener('pointermove', (e) => {
  if (mode !== 'hunt') return;
  if (modeCtxs.hunt.locked) return; // designated track owns the beam
  modeCtxs.hunt.pointTo(eventWorld(e).azRad);
});

canvas.addEventListener('pointerdown', (e) => {
  if (mode === 'hunt') {
    // Click a blip/track to designate it (single-target track); the beam
    // then follows the track so the sliders can be adjusted hands-free.
    // Click empty sky to unlock and steer there.
    const w = eventWorld(e);
    const pickKm = 18 / (KM_TO_US * layout.pxPerUs);
    const locked = modeCtxs.hunt.tryLock(w.xKm, w.yKm, pickKm);
    if (!locked) {
      modeCtxs.hunt.unlock();
      modeCtxs.hunt.pointTo(w.azRad);
    }
  } else if (mode === 'battle') {
    const w = eventWorld(e);
    const game = modeCtxs.battle.game;
    // Click near a platform selects it; anywhere else sets the course.
    let picked = null;
    for (const p of game.platforms) {
      const px = layout.emitter.x + p.xKm * KM_TO_US * layout.pxPerUs;
      const py = layout.emitter.y - p.yKm * KM_TO_US * layout.pxPerUs;
      if (Math.hypot(px - w.mx, py - w.my) < 16) picked = p;
    }
    if (picked) {
      game.select(picked.id);
    } else {
      const arena = params.get('rangeKm');
      const r = Math.hypot(w.xKm, w.yKm);
      const s = r > arena ? arena / r : 1;
      game.setWaypoint(w.xKm * s, w.yKm * s);
    }
  }
});

canvas.addEventListener('wheel', (e) => {
  if (mode !== 'hunt' && mode !== 'battle' && mode !== 'radar') return;
  e.preventDefault();
  // Proportional to the delta so trackpad flicks don't slam the limits;
  // one mouse-wheel notch (deltaY ≈ ±100) ≈ 1°.
  const step = Math.max(-2, Math.min(2, e.deltaY / 100));
  if (step) params.set('beamwidthDeg', params.get('beamwidthDeg') + step);
}, { passive: false });

// ---- Pause / reset ----------------------------------------------------------

const pauseBtn = document.getElementById('btn-pause');
function togglePause() {
  sim.running = !sim.running;
  pauseBtn.textContent = sim.running ? 'Pause' : 'Resume';
}
pauseBtn.addEventListener('click', togglePause);
document.getElementById('btn-reset').addEventListener('click', () => {
  sim.reset();
  restartGame();
});

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

/** Mode-specific audio: paints blip, confirms chirp up, RWR warbles low, intercepts thud. */
function modeAudio(mc) {
  const fc = params.get('frequency');
  for (const ev of mc.radar.newEvents) {
    if (ev.type === 'confirm') { pinger.play(fc, { bendSemitones: 7, gain: 0.8 }); return; }
  }
  if (mode === 'battle') {
    for (const ev of mc.game.events) {
      if (ev.type === 'intercept') { pinger.play(fc, { bendSemitones: -19, gain: 0.9 }); return; }
      if (ev.type === 'win') { pinger.play(fc, { bendSemitones: 12, gain: 1 }); return; }
      if (ev.type === 'lose') { pinger.play(fc, { bendSemitones: -24, gain: 1 }); return; }
    }
  }
  const real = mc.radar.newPaints.filter((p) => !p.falseAlarm);
  if (real.length) {
    const p = real[real.length - 1];
    const gain = 0.25 + 0.75 * Math.max(0, Math.min(1, (p.snrDb - 13) / 27));
    pinger.play(fc, { gain });
    return;
  }
  // Own-side RWR chirp when the enemy beam sweeps a battle platform.
  if (mode === 'battle' && mc.radar.rwrPaintsThisFrame.length) {
    pinger.play(fc, { bendSemitones: -14, gain: 0.3 });
  }
}

// ---- Keyboard -----------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === '1') { setMode('beam'); setStyle('wave'); }
  else if (e.key === '2') { setMode('beam'); setStyle('ring'); }
  else if (e.key === '3') setMode('radar');
  else if (e.key === '4') setMode('hunt');
  else if (e.key === '5') setMode('battle');
  else if (e.key === 'r' || e.key === 'R') { sim.reset(); restartGame(); }
  else if (e.key === 'g' || e.key === 'G') restartGame();
  else if (e.key === 'm' || e.key === 'M') setSound(!pinger.enabled);
  else if (e.key === 'o' || e.key === 'O') {
    if (mode === 'beam') setOrbit(!motion.enabled);
    else if (mode === 'radar') {
      targetOrbitToggle.checked = !targetOrbitToggle.checked;
      modeCtxs.radar.target.orbiting = targetOrbitToggle.checked;
    }
  } else if ((e.key === 'e' || e.key === 'E') && mode === 'battle') {
    const game = modeCtxs.battle.game;
    if (game.selected) game.toggleEa(game.selected.id);
  } else if (e.key === 'Escape' && mode === 'hunt') {
    modeCtxs.hunt.unlock();
  } else if (e.key === 'Tab' && mode === 'battle') {
    e.preventDefault();
    const game = modeCtxs.battle.game;
    const alive = game.platforms.filter((p) => p.alive);
    if (alive.length) {
      const i = alive.findIndex((p) => p.id === game.selectedId);
      game.select(alive[(i + 1) % alive.length].id);
    }
  }
});

// ---- URL params ---------------------------------------------------------------
// ?mode=radar|hunt|battle picks the mode, ?style=wave|ring the beam style,
// ?orbit=1 a moving beam-mode sensor, ?t=<µs> fast-forwards, and any
// PARAM_SPECS key presets a slider (applied AFTER mode presets so shared
// links win).

const urlParams = new URLSearchParams(location.search);
setMode(urlParams.get('mode') ?? 'beam');
let urlOverrode = false;
for (const key of Object.keys(PARAM_SPECS)) {
  if (urlParams.has(key)) {
    params.set(key, Number(urlParams.get(key)));
    urlOverrode = true;
  }
}
// The mode's game spawned against preset values; respawn it against the
// final ones (?mode=hunt&rangeKm=30 must not hide the target off-arena).
if (urlOverrode && mode !== 'beam') restartGame();
setStyle(urlParams.get('style') || 'wave');
setOrbit(['1', 'true', 'on'].includes(urlParams.get('orbit') ?? ''));
if (urlParams.has('angle')) motion.angle = (Number(urlParams.get('angle')) * Math.PI) / 180; // orbit start, degrees
const fastForwardUs = Number(urlParams.get('t'));
if (fastForwardUs > 0) sim.step(fastForwardUs / params.get('timeScale'));

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

function beamLiveValues() {
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

  if (mode === 'beam') {
    motion.update(sim.running ? dt : 0);
    layout = motion.apply(computeLayout(canvasW, canvasH, params.rangeUs));

    const hitsBefore = sim.hitCount;
    renderer.render(ctx, layout, sim);
    if (sim.hitCount > hitsBefore) {
      const amplitude = Math.sqrt(layout.pathGain);
      const bend = layout.orbit ? 4 * (layout.radialVelocity / params.get('platformSpeed')) : 0;
      pinger.play(sim.lastHitFrequency, { gain: 0.3 + 0.7 * amplitude, bendSemitones: bend });
    }
    spectrum.draw(params, sim, layout);
    beamLive(beamLiveValues());
  } else {
    const mc = modeCtxs[mode];
    mc.update({ dtWallS: dt, running: sim.running, sim });
    layout = (mode === 'radar' ? computeLayout : computeCentredLayout)(canvasW, canvasH, params.rangeUs);
    layout.game = mc;
    const si = mc.spectrumInfo?.();
    if (si) Object.assign(layout, si);

    (mode === 'radar' ? monostaticRenderer : ppiRenderer).render(ctx, layout, sim);
    modeAudio(mc);
    spectrum.draw(params, sim, layout);
    modeLive[mode](mc.liveValues());
    if (mode === 'hunt') {
      huntStatusEl.textContent = huntStatusText(mc);
      const done = mc.game.state !== 'hunting';
      if (identifyButtons[0].disabled !== done) {
        for (const b of identifyButtons) b.disabled = done;
      }
    }
    if (mode === 'battle') updatePlatformList();
  }

  requestAnimationFrame(frame);
}

// Console/test handle: drive the app from DevTools or headless CDP (the
// console is the test suite — see CLAUDE.md). Not used by the app itself.
window.__app = { params, sim, motion, modeCtxs, setMode, setStyle };

function huntStatusText(mc) {
  const g = mc.game;
  if (g.state === 'won') {
    return `Identified: ${g.target.cls.label} in ${Math.round(g.elapsedWallS)} s, ${g.guesses.length} guess${g.guesses.length === 1 ? '' : 'es'}. G for a new target.`;
  }
  if (huntFlash && performance.now() < huntFlashUntil) return huntFlash;
  if (performance.now() < mc.lockLostUntil) return 'Track lost — lock broken, back to manual steer.';
  if (mc.locked) return `Locked on T${mc.lockedTrackId} — the beam follows the track. Adjust the waveform freely; click empty sky or Esc to unlock.`;
  const tr = mc.radar.bestTrack();
  if (!tr) return 'Sweep the beam (mouse) until a blip appears, then dwell on it.';
  const est = mc.radar.rcsEstimate(tr);
  if (!est || est.n < 4) return 'Track forming — click the track to lock the beam on it.';
  return 'Estimate ready — call the class when confident (speed is a clue too).';
}

requestAnimationFrame(frame);
