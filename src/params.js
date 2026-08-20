/**
 * Radar waveform parameters + derived quantities.
 *
 * Units: time in microseconds (µs), frequency in MHz, range in km. Distances
 * inside the simulation are expressed in "light-microseconds" (the distance
 * light travels in 1 µs ≈ 299.8 m), so propagation speed c == 1 unit/µs.
 *
 * Ranges are chosen to cover what an EW/ESM receiver realistically sees:
 * VHF through X band, PRFs from ~100 Hz to 1 MHz, pulse widths from tens of
 * nanoseconds to a millisecond.
 */

export const C_M_PER_US = 299.792458; // metres per microsecond

export const PARAM_SPECS = {
  frequency: {
    label: 'Carrier frequency',
    min: 100,       // MHz
    max: 10000,     // 10 GHz
    default: 3000,
    scale: 'log',
    format: fmtFrequencyMHz,
  },
  pri: {
    label: 'PRI',
    min: 1,         // µs  (PRF 1 MHz)
    max: 10000,     // 10 ms (PRF 100 Hz)
    default: 300,
    scale: 'log',
    format: fmtTimeUs,
  },
  pulseWidth: {
    label: 'Pulse width',
    min: 0.05,      // 50 ns
    max: 1000,      // 1 ms
    default: 10,
    scale: 'log',
    format: fmtTimeUs,
  },
  rangeKm: {
    label: 'Emitter–sensor range',
    min: 1,
    max: 300,
    default: 50,
    scale: 'log',
    format: (v) => `${fmtSig(v)} km`,
  },
  timeScale: {
    label: 'Playback speed',
    min: 1,         // µs of sim time per real second
    max: 10000,
    default: 100,
    scale: 'log',
    format: (v) => `${fmtSig(v)} µs / s`,
  },
};

/** Pulse width may not exceed this fraction of the PRI (keeps duty cycle < 100%). */
const MAX_DUTY = 0.9;

export class Params {
  constructor() {
    this._values = {};
    for (const [key, spec] of Object.entries(PARAM_SPECS)) {
      this._values[key] = spec.default;
    }
    this._listeners = new Set();
  }

  get(key) {
    return this._values[key];
  }

  /** Set a parameter, clamping to its spec and enforcing cross-parameter constraints. */
  set(key, value) {
    const spec = PARAM_SPECS[key];
    if (!spec) throw new Error(`Unknown param: ${key}`);

    const v = clamp(Number(value), spec.min, spec.max);
    if (v === this._values[key]) return;
    this._values[key] = v;

    // Keep pulse width strictly shorter than PRI.
    const maxPw = this._values.pri * MAX_DUTY;
    if (this._values.pulseWidth > maxPw) {
      this._values.pulseWidth = Math.max(PARAM_SPECS.pulseWidth.min, maxPw);
    }

    for (const fn of this._listeners) fn(key, this);
  }

  /** Subscribe to changes. Callback receives (changedKey, params). Returns unsubscribe fn. */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ---- Derived quantities -------------------------------------------------

  /** Pulse repetition frequency in Hz. */
  get prfHz() {
    return 1e6 / this._values.pri;
  }

  /** Duty cycle as a fraction 0..1. */
  get dutyCycle() {
    return this._values.pulseWidth / this._values.pri;
  }

  /** Carrier wavelength in metres. */
  get wavelengthM() {
    return C_M_PER_US / this._values.frequency;
  }

  /** Physical length of one pulse in metres (c × pulse width). */
  get pulseLengthM() {
    return this._values.pulseWidth * C_M_PER_US;
  }

  /** Maximum unambiguous range in km: c × PRI / 2. */
  get unambiguousRangeKm() {
    return (C_M_PER_US * this._values.pri) / 2 / 1000;
  }

  /** Emitter→sensor distance in light-µs (what the simulation uses). */
  get rangeUs() {
    return (this._values.rangeKm * 1000) / C_M_PER_US;
  }

  /** IEEE radar band letter for the current carrier. */
  get band() {
    return bandFor(this._values.frequency);
  }

  /** How many times slower than real time the animation runs. */
  get slowMotionFactor() {
    return 1e6 / this._values.timeScale;
  }
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// ---- Formatting helpers ----------------------------------------------------

/** 3 significant figures, trailing zeros trimmed. */
export function fmtSig(v, sig = 3) {
  if (!isFinite(v)) return '—';
  return Number(v.toPrecision(sig)).toString();
}

export function fmtFrequencyMHz(mhz) {
  return mhz >= 1000 ? `${fmtSig(mhz / 1000)} GHz` : `${fmtSig(mhz)} MHz`;
}

export function fmtFrequencyHz(hz) {
  if (hz >= 1e6) return `${fmtSig(hz / 1e6)} MHz`;
  if (hz >= 1e3) return `${fmtSig(hz / 1e3)} kHz`;
  return `${fmtSig(hz)} Hz`;
}

export function fmtTimeUs(us) {
  if (us >= 1000) return `${fmtSig(us / 1000)} ms`;
  if (us < 1) return `${fmtSig(us * 1000)} ns`;
  return `${fmtSig(us)} µs`;
}

export function fmtDistanceM(m) {
  if (m >= 1000) return `${fmtSig(m / 1000)} km`;
  if (m < 1) return `${fmtSig(m * 100)} cm`;
  return `${fmtSig(m)} m`;
}

/** IEEE Std 521 band letters. */
export function bandFor(mhz) {
  if (mhz < 30) return 'HF';
  if (mhz < 300) return 'VHF';
  if (mhz < 1000) return 'UHF';
  if (mhz < 2000) return 'L';
  if (mhz < 4000) return 'S';
  if (mhz < 8000) return 'C';
  if (mhz < 12000) return 'X';
  if (mhz < 18000) return 'Ku';
  return 'K';
}
