/**
 * rf.js — DOM-free, Node-importable radar-equation engine for the radar /
 * hunt / battle modes. Everything the game *measures* is computed here,
 * analytically, from truth geometry — never by counting animated pulses —
 * so the numbers on screen are the physics even where the animation is
 * stylised (the SpectrumView precedent).
 *
 * Single-pulse SNR in dB:
 *   SNR = K0 + 10log10(σ m²) + 10log10(τ µs) + 20log10(F_REF/f) − 40log10(R km)
 *         + 2·pat(Δaz) + 10log10(N)
 * where pat is a Gaussian mainlobe approximation (one-way), applied twice for
 * monostatic two-way, and N is pulses integrated per dwell (capped).
 *
 * K0 folds Pt·G²λ²_ref/((4π)³·kT·B·NF·L) into one game-calibrated constant:
 * with defaults (σ = 1 m², τ = 10 µs, 3 GHz, boresight, N = 64) detection
 * (SNR = THRESH) happens at ≈ 80 km. Worked example:
 *   61 + 0 + 10 + 0 − 40log10(80) + 18.1 = 61 + 10 − 76.1 + 18.1 = 13 ✓
 * The 20log10(F_REF/f) term assumes constant antenna gain across the band, so
 * low bands honestly detect further (the VHF early-warning story).
 *
 * Jamming (noise ECM, self-screening or stand-off):
 *   J/N = ERP_dB + JAM_K − 20log10(R_jam km) + (mainlobe ? 0 : SIDELOBE_DB)
 * Detection then runs against SNR_eff = SNR − max(0, J/N): the 40logR echo
 * beats the 20logR jammer only inside the burn-through range.
 */
import { C_M_PER_US } from './params.js';

export const RF = {
  K0_DB: 61,          // calibration constant (see worked example above)
  F_REF_MHZ: 3000,    // frequency where the λ² term is 0 dB
  THRESH_DB: 13,      // detection threshold (Pd = 0.5 here)
  PD_SLOPE_DB: 1.5,   // logistic width: edge-of-detection targets flicker
  NI_MAX: 64,         // max pulses integrated per dwell (+18 dB)
  PATTERN_K: 12,      // one-way Gaussian mainlobe: −12·(Δaz/θbw)² dB
  JAM_K_DB: 30,       // jammer calibration (30 dB ERP at 50 km → J/N ≈ 26 dB)
  SIDELOBE_DB: -25,   // jamming received outside the mainlobe
  PFA_PER_DWELL: 0.004, // false-alarm probability per dwell
  BEAM_SPLIT: 1.6,    // az accuracy: σ_az = θbw / (BEAM_SPLIT·√(2·SNR))
  MEAS_JITTER_DB: 2,  // per-plot SNR measurement noise (σ)
};

/** Target classes for hunt/battle. RCS spans 40 dB → 10× detection-range spread. */
export const RCS_CLASSES = [
  { id: 'bird',     label: 'Bird',     rcsM2: 0.01, speedMps: 25 },
  { id: 'missile',  label: 'Missile',  rcsM2: 0.1,  speedMps: 900 },
  { id: 'fighter',  label: 'Fighter',  rcsM2: 3,    speedMps: 300 },
  { id: 'bomber',   label: 'Bomber',   rcsM2: 30,   speedMps: 220 },
  { id: 'airliner', label: 'Airliner', rcsM2: 100,  speedMps: 250 },
];

const log10 = Math.log10;

/** One-way Gaussian beam-shape loss in dB (≤ 0) at Δaz off boresight. */
export function patternDb(dAzRad, beamwidthRad) {
  return -RF.PATTERN_K * (dAzRad / beamwidthRad) ** 2;
}

/**
 * Integrated SNR in dB for one dwell.
 * @param {object} a  {rKm, rcsM2, tauUs, fMHz, beamwidthRad, offBoresightRad?, nPulses?, jnDb?}
 */
export function snrDb(a) {
  const {
    rKm, rcsM2, tauUs, fMHz, beamwidthRad,
    offBoresightRad = 0, nPulses = 1, jnDb = 0,
  } = a;
  if (rKm <= 0.05) return 60; // point-blank: saturate rather than diverge
  const n = Math.max(1, Math.min(RF.NI_MAX, nPulses));
  const raw =
    RF.K0_DB
    + 10 * log10(rcsM2)
    + 10 * log10(tauUs)
    + 20 * log10(RF.F_REF_MHZ / fMHz)
    - 40 * log10(rKm)
    + 2 * patternDb(offBoresightRad, beamwidthRad)
    + 10 * log10(n);
  return raw - Math.max(0, jnDb);
}

/**
 * Jam-to-noise ratio (dB) that one noise jammer puts into the radar receiver.
 * Mainlobe when the radar's beam points within a beamwidth of the jammer.
 */
export function jamJnDb({ erpDb, rKm, offBoresightRad, beamwidthRad }) {
  if (rKm <= 0.05) return 60;
  const lobe = Math.abs(offBoresightRad) <= beamwidthRad ? 0 : RF.SIDELOBE_DB;
  return erpDb + RF.JAM_K_DB - 20 * log10(rKm) + lobe;
}

/** Sum several J/N contributions (dB in, dB out, power-linear addition). */
export function sumJnDb(jnDbs) {
  let lin = 0;
  for (const db of jnDbs) lin += Math.pow(10, db / 10);
  return lin > 0 ? 10 * log10(lin) : -Infinity;
}

/** Probability of detection from effective SNR: logistic stand-in for a Swerling curve. */
export function pd(snrEffDb) {
  return 1 / (1 + Math.exp(-(snrEffDb - RF.THRESH_DB) / RF.PD_SLOPE_DB));
}

/** Azimuth measurement accuracy (rad, 1σ): beam-splitting improves with SNR. */
export function sigmaAzRad(beamwidthRad, snrDbVal) {
  const snrLin = Math.max(2, Math.pow(10, snrDbVal / 10));
  return beamwidthRad / (RF.BEAM_SPLIT * Math.sqrt(2 * snrLin));
}

/** Range measurement accuracy (light-µs, 1σ): resolution cτ/2 split by SNR. */
export function sigmaRangeUs(tauUs, snrDbVal) {
  const snrLin = Math.max(2, Math.pow(10, snrDbVal / 10));
  return (tauUs / 2) / Math.sqrt(2 * snrLin);
}

/**
 * Invert the equation: estimate RCS (dBsm) from one measured plot.
 * Uses the measured range, so ambiguous plots bias the estimate — honestly.
 */
export function rcsEstimateDb(measSnrDb, a) {
  return measSnrDb - snrDb({ ...a, rcsM2: 1, jnDb: 0 });
}

/**
 * Self-screening burn-through range (km): the range inside which the target's
 * echo out-competes its own jammer. Solved numerically (monotonic in R).
 */
export function burnThroughKm({ rcsM2, tauUs, fMHz, nPulses, erpDb }) {
  let lo = 0.1, hi = 500;
  // Same clamp as detection: a negative J/N is no jamming, not a bonus —
  // otherwise the readout could exceed the clear-sky detection range.
  const margin = (r) =>
    snrDb({ rKm: r, rcsM2, tauUs, fMHz, beamwidthRad: 1, nPulses })
    - Math.max(0, jamJnDb({ erpDb, rKm: r, offBoresightRad: 0, beamwidthRad: 1 }))
    - RF.THRESH_DB;
  if (margin(hi) > 0) return hi;   // jammer never wins
  if (margin(lo) < 0) return 0;    // jammer always wins
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (margin(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Clear-sky detection range (km) for a target on boresight (SNR = THRESH). */
export function detectionRangeKm({ rcsM2, tauUs, fMHz, nPulses }) {
  const at1km = snrDb({ rKm: 1, rcsM2, tauUs, fMHz, beamwidthRad: 1, nPulses });
  return Math.pow(10, (at1km - RF.THRESH_DB) / 40);
}

/** Apparent (folded) range in light-µs given true range and PRI — 2nd-time-around. */
export function apparentRangeUs(trueRangeUs, priUs) {
  return ((2 * trueRangeUs) % priUs) / 2;
}

/** Two-way Doppler in Hz for radial velocity (m/s, + closing) at carrier fMHz. */
export function twoWayDopplerHz(vrMps, fMHz) {
  return (2 * vrMps * fMHz) / C_M_PER_US;
}

/** Standard normal sample (Box–Muller). */
export function gauss() {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a) {
  while (a <= -Math.PI) a += 2 * Math.PI;
  while (a > Math.PI) a -= 2 * Math.PI;
  return a;
}
