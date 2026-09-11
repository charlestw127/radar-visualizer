/**
 * radar.js — DOM-free monostatic radar model for the radar / hunt / battle
 * modes: antenna, dwell scheduler, analytic detection, paint-delay queue,
 * plots, alpha-beta tracker with M-of-N confirmation, RWR bookkeeping and
 * RCS estimation.
 *
 * Detection is ANALYTIC (see rf.js): once per dwell, each target's integrated
 * SNR is computed from truth geometry and a Bernoulli draw decides detection.
 * Animated pulses/echoes are cosmetic, so the Simulation's emission skip-ahead
 * at fast playback cannot lose detections. Causality is preserved the other
 * way by the PAINT-DELAY QUEUE: a successful detection is not shown until
 * sim.time has advanced by the echo's true round trip (2R), so at slow
 * playback the blip lands exactly when the animated echo reaches the dish.
 *
 * Time bases: dwells, antenna motion and the tracker run in game seconds
 * (true seconds at GAME_TIMELAPSE× wall speed — see world.js). The paint
 * queue alone bridges to simulated µs.
 */
import {
  RF, snrDb, jamJnDb, sumJnDb, pd, sigmaAzRad, sigmaRangeUs, rcsEstimateDb,
  apparentRangeUs, gauss, wrapAngle,
} from './rf.js';
import { C_M_PER_US } from './params.js';

export const SCAN_RATE_RAD_S = (36 * Math.PI) / 180;   // circular scan, true °/s
export const MANUAL_SLEW_RAD_S = (60 * Math.PI) / 180; // manual steer slew, true °/s
const MANUAL_DWELL_S = 0.4;      // manual-steer detection cadence, game seconds
const PLOT_LIFE_S = 6;           // wall-clock fade time of a raw plot on the PPI
const MAX_PLOTS = 300;
const TRACK_CONFIRM_HITS = 3;    // M-of-N: confirm at 3 hits …
const TRACK_CONFIRM_WINDOW = 5;  // … within the first 5 paint opportunities
const TRACK_DROP_MISSES = 4;
const ALPHA = 0.5;               // alpha-beta filter gains
const BETA = 0.2;
const GATE_FLOOR_KM = 1.5;
const MAX_TARGET_KM_S = 1.0;     // fastest credible arena target (missile ~0.9)

let nextTrackId = 1;

export class RadarModel {
  /** @param {import('./params.js').Params} params */
  constructor(params) {
    this.params = params;
    this.reset();
  }

  reset() {
    this.gameT = 0;              // game-seconds since mode start
    this.azRad = 0;              // antenna boresight
    this.scanMode = 'scan';      // 'scan' (circular) | 'manual' (slew to command)
    this.commandAzRad = 0;       // manual steer target
    /**
     * When true (hunt/battle), dwells generate paints through the delay
     * queue. The monostatic demo sets false and instead calls measure() as
     * each ANIMATED echo lands, so every blip has a visible cause at slow
     * playback. Dwells still drive RWR and lastDwell either way.
     */
    this.paintFromDwells = true;
    this._dwellAccumRad = 0;
    this._dwellTimerS = 0;
    this.pendingPaints = [];     // detections waiting for their echo to arrive
    this.plots = [];             // released plots {xKm,yKm,azRad,rangeKm,snrDb,ambiguous,falseAlarm,lifeS}
    this.tracks = [];
    this.newPaints = [];         // released THIS frame (pings, phosphor)
    this.newEvents = [];         // {type:'confirm'|'drop', track} this frame
    this.rwrPaintsThisFrame = []; // platforms swept by the beam this frame
    this.lastDwell = null;       // debug/A-scope: {azRad, nPulses, targets:[{...}]}
  }

  get beamwidthRad() {
    return (this.params.get('beamwidthDeg') * Math.PI) / 180;
  }

  /** Revisit period (game s): full circle in scan mode, dwell cadence in manual. */
  get revisitS() {
    return this.scanMode === 'scan'
      ? (2 * Math.PI) / SCAN_RATE_RAD_S
      : MANUAL_DWELL_S * 4;
  }

  /**
   * Advance the radar. Call once per frame.
   * @param {object} a
   *   dtGameS   game-seconds elapsed (0 when paused)
   *   dtWallS   wall-clock seconds elapsed (plot fading only)
   *   sim       the Simulation (paint-delay bridge + waveform snapshot times)
   *   targets   Platform[] — truth
   *   jammers   Platform[] — subset with EA radiating
   *   erpDb     jammer ERP for this scenario
   */
  update({ dtGameS, dtWallS, sim, targets, jammers = [], erpDb = 0 }) {
    this.newPaints = [];
    this.newEvents = [];
    this.rwrPaintsThisFrame = [];
    this.gameT += dtGameS;

    // ---- Antenna motion + dwell scheduling --------------------------------
    const bw = this.beamwidthRad;
    if (this.scanMode === 'scan') {
      const moved = SCAN_RATE_RAD_S * dtGameS;
      this.azRad = wrapAngle(this.azRad + moved);
      this._dwellAccumRad += moved;
      // One dwell each time the boresight has advanced one beamwidth. A slow
      // frame can cover several dwells; run them at their proper centres.
      while (this._dwellAccumRad >= bw) {
        this._dwellAccumRad -= bw;
        const centre = wrapAngle(this.azRad - this._dwellAccumRad - bw / 2);
        this._runDwell(centre, bw / SCAN_RATE_RAD_S, sim, targets, jammers, erpDb);
      }
    } else {
      const dAz = wrapAngle(this.commandAzRad - this.azRad);
      const maxSlew = MANUAL_SLEW_RAD_S * dtGameS;
      this.azRad = wrapAngle(this.azRad + Math.max(-maxSlew, Math.min(maxSlew, dAz)));
      this._dwellTimerS += dtGameS;
      if (this._dwellTimerS >= MANUAL_DWELL_S) {
        this._dwellTimerS = 0;
        this._runDwell(this.azRad, MANUAL_DWELL_S, sim, targets, jammers, erpDb);
      }
    }

    // ---- Release paints whose echo has come home --------------------------
    // A detection not delivered within a couple of revisits is stale — a real
    // radar's picture would simply miss that scan. This bounds the queue when
    // the playback slider makes sim time crawl relative to the dwell engine,
    // and prevents a flood of ancient plots when it is raised again.
    const staleGameS = this.revisitS * 2;
    for (let i = this.pendingPaints.length - 1; i >= 0; i--) {
      const p = this.pendingPaints[i];
      p.gameAgeS = (p.gameAgeS ?? 0) + dtGameS;
      if (sim.time >= p.readyAtSimUs) {
        this.pendingPaints.splice(i, 1);
        this._releasePaint(p.plot);
      } else if (p.gameAgeS > staleGameS) {
        this.pendingPaints.splice(i, 1);
      }
    }
    if (this.pendingPaints.length > 400) {
      this.pendingPaints.splice(0, this.pendingPaints.length - 400);
    }

    // ---- Plot fade, track coasting ---------------------------------------
    for (const pl of this.plots) pl.lifeS -= dtWallS;
    this.plots = this.plots.filter((p) => p.lifeS > 0);

    for (const tr of this.tracks) {
      if (this.gameT - tr.lastPaintGameT > this.revisitS * 1.6 * (tr.misses + 1)) {
        tr.misses += 1;
        tr.opportunities += 1; // a missed revisit is a failed paint opportunity
        tr.lastPaintGameT += this.revisitS * 1.6; // count each missed revisit once
        if (tr.state === 'CONFIRMED') tr.state = 'COAST';
      }
    }
    // Tentative tracks (mostly false alarms) die fast: 2 missed revisits, or
    // an exhausted M-of-N confirmation window.
    const dropped = this.tracks.filter((t) => t.misses >= TRACK_DROP_MISSES
      || (t.state === 'TENTATIVE' && t.misses >= 2)
      || (t.state === 'TENTATIVE' && t.opportunities >= TRACK_CONFIRM_WINDOW && t.hits < TRACK_CONFIRM_HITS));
    for (const t of dropped) this.newEvents.push({ type: 'drop', track: t });
    this.tracks = this.tracks.filter((t) => !dropped.includes(t));
  }

  /** Evaluate one dwell centred on azCentre against every target. */
  _runDwell(azCentreRad, dwellTrueS, sim, targets, jammers, erpDb) {
    const priUs = this.params.get('pri');
    const tauUs = this.params.get('pulseWidth');
    const fMHz = this.params.get('frequency');
    const bw = this.beamwidthRad;
    const nPulses = Math.max(1, Math.min(RF.NI_MAX, dwellTrueS * (1e6 / priUs)));

    // Jamming into this dwell: every radiating jammer contributes, mainlobe
    // when the beam points at it, sidelobe otherwise.
    const jnDb = sumJnDb(jammers.map((j) => jamJnDb({
      erpDb,
      rKm: j.rangeKm,
      offBoresightRad: wrapAngle(j.azRad - azCentreRad),
      beamwidthRad: bw,
    })));

    const dwellInfo = { azRad: azCentreRad, nPulses, jnDb, targets: [] };

    for (const t of targets) {
      if (!t.alive) continue;
      const off = wrapAngle(t.azRad - azCentreRad);
      // Paint only in the dwell whose centre is nearest (±bw/2): one paint
      // opportunity per beam pass, which is what the tracker cadence assumes.
      if (Math.abs(off) > bw / 2) continue;

      // RWR truth: being illuminated is a fact on the target side, whether or
      // not the radar detects the echo.
      t.lastPaintedGameT = this.gameT;
      t.paintCount += 1;
      this.rwrPaintsThisFrame.push(t);

      const m = this.measure({
        rKm: t.rangeKm, azTrueRad: t.azRad, rcsM2: t.cls.rcsM2,
        azCentreRad, tauUs, fMHz, nPulses, jnDb,
      });
      dwellInfo.targets.push({
        target: t, snrDb: m.snrDb, eclipsed: m.eclipsed,
        ambiguous: m.ambiguous, detected: m.detected,
      });
      if (m.plot && this.paintFromDwells) {
        const rUs = (t.rangeKm * 1000) / C_M_PER_US;
        this.pendingPaints.push({
          readyAtSimUs: sim.time + 2 * rUs, // shown when the animated echo lands
          plot: m.plot,
        });
      }
    }

    // False alarm: thermal noise crossing the threshold somewhere in this dwell.
    if (this.paintFromDwells && Math.random() < RF.PFA_PER_DWELL) {
      const rUs = (Math.random() * priUs) / 2;
      const rKm = (rUs * C_M_PER_US) / 1000;
      const az = wrapAngle(azCentreRad + (Math.random() - 0.5) * bw);
      this.pendingPaints.push({
        readyAtSimUs: sim.time + 2 * rUs,
        plot: {
          azRad: az, rangeKm: rKm,
          xKm: rKm * Math.cos(az), yKm: rKm * Math.sin(az),
          snrDb: RF.THRESH_DB + Math.random() * 3,
          ambiguous: false, falseAlarm: true, lifeS: PLOT_LIFE_S,
          waveform: { tauUs, fMHz, nPulses, beamwidthRad: bw, dwellAzRad: az },
        },
      });
    }

    this.lastDwell = dwellInfo;
  }

  /**
   * One measurement attempt against a target: the full detection chain
   * (beam shape, jamming, eclipsing, ambiguity, Pd draw) plus, on success,
   * a plot with SNR-dependent measurement noise. Pure with respect to radar
   * state, so the monostatic mode can call it per animated echo arrival.
   */
  measure({ rKm, azTrueRad, rcsM2, azCentreRad, tauUs, fMHz, nPulses, jnDb = 0 }) {
    const bw = this.beamwidthRad;
    const priUs = this.params.get('pri');
    const off = wrapAngle(azTrueRad - azCentreRad);
    const rUs = (rKm * 1000) / C_M_PER_US;
    const snr = snrDb({
      rKm, rcsM2, tauUs, fMHz,
      beamwidthRad: bw, offBoresightRad: off, nPulses, jnDb,
    });
    const rAppUs = apparentRangeUs(rUs, priUs);
    const eclipsed = rAppUs < tauUs / 2; // echo arrives while still transmitting
    const ambiguous = 2 * rUs > priUs;
    const detected = !eclipsed && Math.random() < pd(snr);
    if (!detected) return { snrDb: snr, eclipsed, ambiguous, detected, plot: null };

    const measSnr = snr + gauss() * RF.MEAS_JITTER_DB;
    // Beam-splitting estimates the target's azimuth (not the beam centre),
    // with the SNR-dependent accuracy from rf.js.
    const measAz = wrapAngle(azTrueRad + gauss() * sigmaAzRad(bw, snr));
    const measRUs = Math.max(0, rAppUs + gauss() * sigmaRangeUs(tauUs, snr));
    const measRKm = (measRUs * C_M_PER_US) / 1000;
    return {
      snrDb: snr, eclipsed, ambiguous, detected,
      plot: {
        azRad: measAz,
        rangeKm: measRKm,
        xKm: measRKm * Math.cos(measAz),
        yKm: measRKm * Math.sin(measAz),
        snrDb: measSnr,
        ambiguous,
        falseAlarm: false,
        lifeS: PLOT_LIFE_S,
        // for RCS inversion at the measured position (incl. beam-shape and
        // jamming corrections — the radar knows its own noise floor):
        waveform: { tauUs, fMHz, nPulses, beamwidthRad: bw, dwellAzRad: azCentreRad, jnDb: Math.max(0, jnDb) },
      },
    };
  }

  /** A paint's echo has arrived: show it and feed the tracker. */
  releasePaint(plot) { this._releasePaint(plot); }

  _releasePaint(plot) {
    this.plots.push(plot);
    if (this.plots.length > MAX_PLOTS) this.plots.shift();
    this.newPaints.push(plot);
    this._associate(plot);
  }

  /** Nearest-neighbour association with an SNR-scaled gate, then alpha-beta. */
  _associate(plot) {
    const sigKm = Math.max(
      GATE_FLOOR_KM,
      3 * (sigmaRangeUs(plot.waveform.tauUs, plot.snrDb) * C_M_PER_US) / 1000
        + 3 * plot.rangeKm * sigmaAzRad(plot.waveform.beamwidthRad, plot.snrDb),
    );

    let best = null;
    let bestD = Infinity;
    for (const tr of this.tracks) {
      const dtS = Math.max(0.1, this.gameT - tr.lastPaintGameT);
      const px = tr.xKm + tr.vxKmS * dtS;
      const py = tr.yKm + tr.vyKmS * dtS;
      const d = Math.hypot(plot.xKm - px, plot.yKm - py);
      // Manoeuvre gate: until the velocity is estimated, the target may have
      // moved up to MAX_TARGET_SPEED since the last paint.
      const gate = sigKm + (MAX_TARGET_KM_S + Math.hypot(tr.vxKmS, tr.vyKmS) * 0.5) * dtS;
      if (d < gate && d < bestD) { best = tr; bestD = d; }
    }

    if (!best) {
      this.tracks.push({
        id: nextTrackId++,
        xKm: plot.xKm, yKm: plot.yKm, vxKmS: 0, vyKmS: 0,
        state: 'TENTATIVE', hits: 1, misses: 0, opportunities: 1,
        lastPaintGameT: this.gameT,
        snrDbAvg: plot.snrDb, rcsDbSum: 0, rcsDbSqSum: 0, nRcs: 0,
      });
      this._accumulateRcs(this.tracks[this.tracks.length - 1], plot);
      return;
    }

    const dtS = Math.max(0.1, this.gameT - best.lastPaintGameT);
    const px = best.xKm + best.vxKmS * dtS;
    const py = best.yKm + best.vyKmS * dtS;
    const rx = plot.xKm - px;
    const ry = plot.yKm - py;
    best.xKm = px + ALPHA * rx;
    best.yKm = py + ALPHA * ry;
    best.vxKmS += (BETA * rx) / dtS;
    best.vyKmS += (BETA * ry) / dtS;
    // No arena target flies faster than MAX_TARGET_KM_S; clamp filter kicks.
    const spd = Math.hypot(best.vxKmS, best.vyKmS);
    if (spd > MAX_TARGET_KM_S) {
      best.vxKmS *= MAX_TARGET_KM_S / spd;
      best.vyKmS *= MAX_TARGET_KM_S / spd;
    }
    best.lastPaintGameT = this.gameT;
    best.hits += 1;
    best.opportunities += 1;
    best.misses = 0;
    best.snrDbAvg = 0.7 * best.snrDbAvg + 0.3 * plot.snrDb;
    this._accumulateRcs(best, plot);
    if (best.state !== 'CONFIRMED' && best.hits >= TRACK_CONFIRM_HITS) {
      best.state = 'CONFIRMED';
      this.newEvents.push({ type: 'confirm', track: best });
    } else if (best.state === 'COAST') {
      best.state = 'CONFIRMED';
    }
  }

  /** Per-plot RCS inversion → running estimate on the track. */
  _accumulateRcs(track, plot) {
    if (plot.falseAlarm || plot.rangeKm < 0.5) return;
    // The measured SNR sat on a jam-raised floor; add the J/N the radar
    // itself measured back in before inverting, or every jammed plot would
    // bias the estimate low by the full J/N.
    const est = rcsEstimateDb(plot.snrDb + (plot.waveform.jnDb ?? 0), {
      rKm: plot.rangeKm,
      tauUs: plot.waveform.tauUs,
      fMHz: plot.waveform.fMHz,
      beamwidthRad: plot.waveform.beamwidthRad,
      nPulses: plot.waveform.nPulses,
      // Correct for the beam-shape loss the plot suffered, using the measured
      // azimuth vs the dwell centre — exactly what the radar can know.
      offBoresightRad: wrapAngle(plot.azRad - plot.waveform.dwellAzRad),
    });
    track.rcsDbSum += est;
    track.rcsDbSqSum += est * est;
    track.nRcs += 1;
  }

  /** {meanDb, ci95Db, n} RCS estimate for a track, or null before any data. */
  rcsEstimate(track) {
    if (!track || track.nRcs === 0) return null;
    const mean = track.rcsDbSum / track.nRcs;
    const ci = (2 * RF.MEAS_JITTER_DB) / Math.sqrt(track.nRcs);
    return { meanDb: mean, ci95Db: ci, n: track.nRcs };
  }

  /** Ground-truth speed of a track estimate, m/s (from the km/game-s state). */
  trackSpeedMps(track) {
    return Math.hypot(track.vxKmS, track.vyKmS) * 1000;
  }

  /** The best (most-hit confirmed) track, e.g. for the hunt RCS readout. */
  bestTrack() {
    const confirmed = this.tracks.filter((t) => t.state !== 'TENTATIVE');
    confirmed.sort((a, b) => b.hits - a.hits);
    return confirmed[0] ?? null;
  }
}
