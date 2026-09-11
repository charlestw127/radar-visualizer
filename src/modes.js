/**
 * modes.js — the mode layer above the beam-mode style switch.
 *
 * Each mode context owns the per-mode models (RadarModel, game state, the
 * cosmetic echo field) and exposes:
 *   enter(sim) / update({dtWallS, running, sim}) / liveLabels / liveValues()
 * plus optional pointer/wheel handlers. Renderers reach this context via
 * `layout.game` (main.js attaches it each frame, the SensorMotion pattern).
 *
 * Beam mode has no context here — its frame path in main.js is exactly the
 * pre-mode code, so its behaviour cannot drift.
 *
 * Param memory: every mode remembers its own slider values; first entry
 * applies MODE_PRESETS. Restores go through params.set, so clamping and
 * controls.sync run as the invariants require.
 */
import { C_M_PER_US, fmtSig, fmtTimeUs, fmtFrequencyHz, PARAM_SPECS } from './params.js';
import { GAME_TIMELAPSE } from './world.js';
import { RadarModel } from './radar.js';
import { HuntGame, BattleGame } from './games.js';
import { RF, twoWayDopplerHz, wrapAngle, burnThroughKm } from './rf.js';
import { SCAN_RATE_RAD_S } from './radar.js';
import { CENTRE_FRAC, RADIUS_FRAC } from './sensorMotion.js';

export const MODE_PRESETS = {
  beam: {},
  // Radar demo: slow enough to WATCH the bounce (round trip 60 km ≈ 0.5 s wall).
  radar: { timeScale: 800, pri: 1000, pulseWidth: 10, frequency: 3000, rangeKm: 60 },
  hunt: { timeScale: 60000, pri: 2000, pulseWidth: 10, frequency: 3000, rangeKm: 100, beamwidthDeg: 6 },
  battle: { timeScale: 60000, pri: 2000, pulseWidth: 10, frequency: 3000, rangeKm: 100, beamwidthDeg: 6 },
};

export class ParamMemory {
  /** @param {import('./params.js').Params} params */
  constructor(params) {
    this.params = params;
    this.saved = new Map();
    // Seed beam mode with the spec defaults, so an app started via
    // ?mode=radar still lands on the familiar sliders when switching to beam.
    const defaults = {};
    for (const [key, spec] of Object.entries(PARAM_SPECS)) defaults[key] = spec.default;
    this.saved.set('beam', defaults);
  }

  save(modeId) {
    const snap = {};
    for (const key of Object.keys(PARAM_SPECS)) snap[key] = this.params.get(key);
    this.saved.set(modeId, snap);
  }

  /** Restore a mode's remembered sliders, or its presets on first entry. */
  load(modeId) {
    const values = this.saved.get(modeId) ?? MODE_PRESETS[modeId] ?? {};
    for (const [key, v] of Object.entries(values)) this.params.set(key, v);
  }
}

/**
 * Cosmetic echo bookkeeping: tags each TX pulse with the antenna azimuth it
 * left on (first frame it is seen — pulses are never mutated), and spawns an
 * expanding echo ring when a pulse's leading edge sweeps a target. Detection
 * NEVER reads this; it exists so the eye can follow energy out and back.
 */
export class EchoField {
  constructor() {
    this.pulseAz = new WeakMap();     // pulse → azRad at emission
    this.pulseEchoed = new WeakMap(); // pulse → Set of target ids already echoed
    this.echoes = [];                 // {tReflectUs, xKm, yKm, rangeUs, pulseWidth, frequency}
  }

  /** Record the antenna azimuth for pulses that appeared since last frame. */
  tagPulses(sim, azRad) {
    for (const p of sim.pulses) {
      if (!this.pulseAz.has(p)) this.pulseAz.set(p, azRad);
    }
  }

  /**
   * Spawn echo rings for pulses crossing targets. With beamwidthRad set, only
   * targets inside the pulse's tagged beam produce echoes (rotating radar).
   */
  spawnEchoes(sim, targets, beamwidthRad = null) {
    for (const p of sim.pulses) {
      const lead = sim.leadingEdge(p);
      let done = this.pulseEchoed.get(p);
      if (!done) { done = new Set(); this.pulseEchoed.set(p, done); }
      const pAz = this.pulseAz.get(p) ?? 0;
      for (const t of targets) {
        if (!t.alive || done.has(t.id)) continue;
        const rUs = (t.rangeKm * 1000) / C_M_PER_US;
        if (lead < rUs) continue;
        done.add(t.id);
        if (beamwidthRad !== null
          && Math.abs(wrapAngle(t.azRad - pAz)) > beamwidthRad / 2 + 0.03) continue;
        this.echoes.push({
          tReflectUs: p.tEmit + rUs,
          xKm: t.xKm, yKm: t.yKm, rangeUs: rUs,
          pulseWidth: p.pulseWidth, frequency: p.frequency,
        });
      }
    }
    // Cull echoes well after their ring has passed back over the radar.
    this.echoes = this.echoes.filter(
      (e) => sim.time - e.tReflectUs - e.pulseWidth <= e.rangeUs * 1.6 + 80,
    );
    if (this.echoes.length > 300) this.echoes.splice(0, this.echoes.length - 300);
  }
}

/**
 * The monostatic demo's target: a frictionless sphere — constant RCS from
 * every aspect (that is the point of the sphere assumption). RCS comes live
 * from the targetRcs slider; it can fly the same off-centre orbit as beam
 * mode's sensor (same wall-clock time base, same geometry constants).
 */
export class SphereTarget {
  /** @param {import('./params.js').Params} params */
  constructor(params) {
    this.params = params;
    this.id = 'sphere';
    this.alive = true;
    this.orbiting = false;
    this.angle = 0;
    this.lastPaintedGameT = -Infinity;
    this.paintCount = 0;
  }

  get cls() {
    const rcs = this.params.get('targetRcs');
    return { id: 'sphere', label: 'Sphere', rcsM2: rcs };
  }

  /** Sphere diameter (m) for the optical-regime RCS σ = πr². */
  get diameterM() {
    return 2 * Math.sqrt(this.params.get('targetRcs') / Math.PI);
  }

  update(dtWallS) {
    if (!this.orbiting || dtWallS <= 0) return;
    const period = this.params.get('orbitPeriod');
    this.angle = (this.angle + (2 * Math.PI * dtWallS) / period) % (2 * Math.PI);
  }

  get xKm() {
    const R = this.params.get('rangeKm');
    return this.orbiting ? R * (CENTRE_FRAC + RADIUS_FRAC * Math.cos(this.angle)) : R;
  }

  get yKm() {
    const R = this.params.get('rangeKm');
    return this.orbiting ? R * RADIUS_FRAC * Math.sin(this.angle) : 0;
  }

  get rangeKm() { return Math.hypot(this.xKm, this.yKm); }
  get azRad() { return Math.atan2(this.yKm, this.xKm); }

  /** True radial velocity (m/s, + closing): slider speed × orbit geometry. */
  get radialVelocityMps() {
    if (!this.orbiting) return 0;
    const r = this.rangeKm;
    if (r < 1e-6) return 0;
    const factor = (Math.sin(this.angle) * this.xKm - Math.cos(this.angle) * this.yKm) / r;
    return this.params.get('platformSpeed') * factor;
  }
}

const dash = '—';
const signOf = (x) => (x > 0 ? '+' : x < 0 ? '−' : '');

/** RCS readout string for a track estimate: "≈3.2 m² ±1.1 dB (n=12)". */
function rcsText(radar) {
  const tr = radar.bestTrack();
  const est = radar.rcsEstimate(tr);
  if (!est) return dash;
  const m2 = Math.pow(10, est.meanDb / 10);
  return `≈${fmtSig(m2, 2)} m² ±${est.ci95Db.toFixed(1)} dB (n=${est.n})`;
}

// ---------------------------------------------------------------------------

export class RadarModeCtx {
  /** @param {import('./params.js').Params} params */
  constructor(params) {
    this.id = 'radar';
    this.params = params;
    this.radar = new RadarModel(params);
    this.target = new SphereTarget(params);
    this.echoField = new EchoField();
    this.lastRealPlot = null;
  }

  enter() {
    this.radar.reset();
    this.radar.scanMode = 'manual';
    // The demo's blips come from the ANIMATED echo arrivals (below), so a
    // blip on the A-scope always has a ring you watched come home.
    this.radar.paintFromDwells = false;
    this.echoField = new EchoField();
    this.lastRealPlot = null;
  }

  update({ dtWallS, running, sim }) {
    const dtGame = running ? dtWallS * GAME_TIMELAPSE : 0;
    const dtW = running ? dtWallS : 0; // pause freezes plot fade too
    this.target.update(dtW);
    // A staring tracking radar: the dish follows the target.
    this.radar.commandAzRad = this.target.azRad;
    this.radar.update({
      dtGameS: dtGame, dtWallS: dtW, sim,
      targets: [this.target], jammers: [], erpDb: 0,
    });
    this.echoField.tagPulses(sim, this.radar.azRad);
    this.echoField.spawnEchoes(sim, [this.target]);

    // Measure once per animated echo landing on the dish. The animated ring
    // stands in for the whole dwell's pulse burst, so integration still uses
    // the true-timeline pulse count (stylisation named in the README).
    const nPulses = Math.max(1, Math.min(RF.NI_MAX, 0.4 * (1e6 / this.params.get('pri'))));
    for (const e of this.echoField.echoes) {
      if (e.received) continue;
      if (sim.time - e.tReflectUs < e.rangeUs) continue;
      e.received = true;
      const m = this.radar.measure({
        rKm: (e.rangeUs * C_M_PER_US) / 1000,
        azTrueRad: Math.atan2(e.yKm, e.xKm),
        rcsM2: this.target.cls.rcsM2,
        azCentreRad: this.radar.azRad,
        tauUs: e.pulseWidth,
        fMHz: e.frequency,
        nPulses,
      });
      if (m.plot) {
        this.radar.releasePaint(m.plot); // the echo has already arrived
        this.lastRealPlot = m.plot;
      }
    }
  }

  /**
   * Spectrum decoration for the monostatic echo: TWO-way Doppler and two-way
   * (40 logR) path loss vs closest approach while the target orbits.
   */
  spectrumInfo() {
    if (!this.target.orbiting) return null;
    const fd = twoWayDopplerHz(this.target.radialVelocityMps, this.params.get('frequency'));
    const R = this.params.get('rangeKm');
    const rMin = R * (CENTRE_FRAC - RADIUS_FRAC);
    const db = Math.min(0, 40 * Math.log10(rMin / this.target.rangeKm));
    return { dopplerHz: fd, orbit: { monostatic: true }, pathGainDb: db, pathGain: Math.pow(10, db / 10) };
  }

  get liveLabels() {
    return ['Measured range', 'True range', 'Echo delay (2R)', 'Single-dwell SNR', 'Two-way Doppler', 'RCS estimate'];
  }

  liveValues() {
    const trueR = this.target.rangeKm;
    const dwellT = this.radar.lastDwell?.targets?.[0];
    const vr = this.target.radialVelocityMps;
    const fd = twoWayDopplerHz(vr, this.params.get('frequency'));
    return [
      this.lastRealPlot ? `${fmtSig(this.lastRealPlot.rangeKm)} km` : dash,
      `${fmtSig(trueR)} km`,
      fmtTimeUs((2 * trueR * 1000) / C_M_PER_US),
      dwellT ? `${dwellT.snrDb.toFixed(1)} dB${dwellT.eclipsed ? ' (eclipsed)' : ''}` : dash,
      `${signOf(fd)}${fmtFrequencyHz(Math.abs(fd))}`,
      rcsText(this.radar),
    ];
  }
}

// ---------------------------------------------------------------------------

export class HuntModeCtx {
  /** @param {import('./params.js').Params} params */
  constructor(params) {
    this.id = 'hunt';
    this.params = params;
    this.radar = new RadarModel(params);
    this.game = new HuntGame(params);
    this.echoField = new EchoField();
    this.lockedTrackId = null;   // single-target track: beam follows this track
    this.lockLostUntil = 0;      // wall ms until which "track lost" is shown
  }

  enter() {
    this.radar.reset();
    this.radar.scanMode = 'manual';
    this.game.reset();
    this.echoField = new EchoField();
    this.lockedTrackId = null;
    this.lockLostUntil = 0;
  }

  restart() { this.enter(); }

  get locked() { return this.lockedTrackId !== null; }

  update({ dtWallS, running, sim }) {
    const dtGame = running ? dtWallS * GAME_TIMELAPSE : 0;
    const dtW = running ? dtWallS : 0; // pause freezes plot fade too
    this.game.update(dtGame, dtW);

    // Single-target track: steer at the track's EXTRAPOLATED estimate (all
    // the radar can know), so the operator's hands are free for the sliders.
    if (this.locked) {
      const tr = this.radar.tracks.find((t) => t.id === this.lockedTrackId);
      if (tr) {
        const dtS = Math.min(this.radar.revisitS * 2,
          Math.max(0, this.radar.gameT - tr.lastPaintGameT));
        this.radar.commandAzRad = Math.atan2(
          tr.yKm + tr.vyKmS * dtS, tr.xKm + tr.vxKmS * dtS,
        );
      }
    }

    this.radar.update({
      dtGameS: dtGame, dtWallS: dtW, sim,
      targets: [this.game.target], jammers: [], erpDb: 0,
    });

    // The lock dies with the track (coasted out, or the waveform stopped
    // seeing it — e.g. the target slipped inside the blind range).
    if (this.locked && !this.radar.tracks.some((t) => t.id === this.lockedTrackId)) {
      this.lockedTrackId = null;
      this.lockLostUntil = performance.now() + 3500;
    }

    this.echoField.tagPulses(sim, this.radar.azRad);
    // No echo rings in hunt: an echo ring is centred on the target, which
    // would give the hidden position away. Blips only.
  }

  /** Pointer steering: command the beam toward the cursor (slew-limited). */
  pointTo(azRad) { this.radar.commandAzRad = azRad; }

  /**
   * Try to designate a track near the clicked point (km). Confirmed tracks
   * win over tentative ones at similar distance. Returns the track or null.
   */
  tryLock(xKm, yKm, pickKm) {
    const d = (t) => Math.hypot(t.xKm - xKm, t.yKm - yKm);
    const cands = this.radar.tracks.filter((t) => d(t) <= pickKm);
    cands.sort((a, b) =>
      ((a.state === 'TENTATIVE') - (b.state === 'TENTATIVE')) || (d(a) - d(b)));
    if (!cands.length) return null;
    this.lockedTrackId = cands[0].id;
    return cands[0];
  }

  unlock() { this.lockedTrackId = null; }

  get liveLabels() {
    return ['Beam azimuth', 'Confirmed tracks', 'Track speed', 'RCS estimate'];
  }

  liveValues() {
    const tr = this.radar.bestTrack();
    return [
      `${(((-this.radar.azRad * 180) / Math.PI + 450) % 360).toFixed(0)}°`
        + (this.locked ? ` → T${this.lockedTrackId}` : ''),
      String(this.radar.tracks.filter((t) => t.state !== 'TENTATIVE').length),
      tr ? `≈${fmtSig(this.radar.trackSpeedMps(tr), 2)} m/s` : dash,
      rcsText(this.radar),
    ];
  }
}

// ---------------------------------------------------------------------------

export class BattleModeCtx {
  /** @param {import('./params.js').Params} params */
  constructor(params) {
    this.id = 'battle';
    this.params = params;
    this.radar = new RadarModel(params);
    this.game = new BattleGame(params);
    this.echoField = new EchoField();
  }

  enter() {
    this.radar.reset();
    this.radar.scanMode = 'scan';
    this.game.reset();
    this.echoField = new EchoField();
  }

  restart() { this.enter(); }

  update({ dtWallS, running, sim }) {
    const dtGame = running ? dtWallS * GAME_TIMELAPSE : 0;
    const dtW = running ? dtWallS : 0; // pause freezes plot fade + game clocks
    this.radar.update({
      dtGameS: dtGame, dtWallS: dtW, sim,
      targets: this.game.platforms,
      jammers: this.game.jammers,
      erpDb: this.params.get('jamErp'),
    });
    this.game.update(dtGame, dtW, this.radar);
    this.echoField.tagPulses(sim, this.radar.azRad);
    this.echoField.spawnEchoes(sim, this.game.platforms, this.radar.beamwidthRad);
  }

  get liveLabels() {
    return ['Selected', 'Range to goal', 'Burn-through (sel.)', 'Status'];
  }

  liveValues() {
    const p = this.game.selected;
    if (!p) return [dash, dash, dash, this.game.state.toUpperCase()];
    const bt = this._burnThrough(p);
    return [
      `#${this.game.platforms.indexOf(p) + 1} ${p.cls.label}`,
      `${fmtSig(Math.max(0, p.rangeKm - this.game.goalKm))} km`,
      p.ea ? `${fmtSig(bt)} km` : dash,
      this.game.state === 'playing' ? (this.game.statuses.get(p.id) ?? dash) : this.game.state.toUpperCase(),
    ];
  }

  _burnThrough(p) {
    // Pulses per dwell with the same numbers the dwell engine uses.
    const dwellTrueS = this.radar.beamwidthRad / SCAN_RATE_RAD_S;
    const nPulses = Math.max(1, Math.min(RF.NI_MAX, dwellTrueS * (1e6 / this.params.get('pri'))));
    return burnThroughKm({
      rcsM2: p.cls.rcsM2,
      tauUs: this.params.get('pulseWidth'),
      fMHz: this.params.get('frequency'),
      nPulses,
      erpDb: this.params.get('jamErp'),
    });
  }
}
