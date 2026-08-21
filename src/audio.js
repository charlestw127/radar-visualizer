/**
 * Sensor "ping" sound, synthesised with the Web Audio API (no audio files).
 *
 * Browsers refuse to start audio until the user has interacted with the page,
 * so the AudioContext is created/resumed lazily from unlock(), which main.js
 * calls on the first pointer or keyboard event. Pings are rate-limited in
 * wall-clock time because at high PRF the sensor can be hit hundreds of
 * times per second, which would just be a buzz.
 */

/** Minimum wall-clock gap between pings, ms. */
const MIN_INTERVAL_MS = 70;

/** Ping pitch range (Hz), mapped from carrier frequency 100 MHz → 40 GHz. */
const PITCH_LO = 440;
const PITCH_HI = 2093;     // two octaves + a third above
const CARRIER_LO = 100;    // MHz
const CARRIER_HI = 40000;  // MHz

export class Pinger {
  constructor() {
    this.enabled = true;
    this.volume = 0.25;
    this.ctx = null;
    this._lastPlay = -Infinity;
  }

  /** Create or resume the AudioContext. Must be called from a user gesture. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** True once the browser has allowed audio to run. */
  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /**
   * Play one ping. Pitch follows the carrier frequency of the pulse that hit
   * (low band → low note), so different emitters sound different.
   * @param {number} carrierMHz
   */
  play(carrierMHz) {
    if (!this.enabled || !this.ready) return;
    const now = performance.now();
    if (now - this._lastPlay < MIN_INTERVAL_MS) return;
    this._lastPlay = now;

    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    const pitch = pitchFor(carrierMHz);

    // Master envelope: ~5 ms attack, exponential decay over ~0.4 s.
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(this.volume, t0 + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);
    gain.connect(ctx.destination);

    // Fundamental with a slight downward glide gives the classic sonar "ping".
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitch, t0);
    osc.frequency.exponentialRampToValueAtTime(pitch * 0.96, t0 + 0.45);
    osc.connect(gain);

    // Quiet octave above for a little brightness at the attack.
    const harm = ctx.createOscillator();
    const harmGain = ctx.createGain();
    harmGain.gain.setValueAtTime(0.3, t0);
    harmGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
    harm.type = 'sine';
    harm.frequency.setValueAtTime(pitch * 2, t0);
    harm.connect(harmGain);
    harmGain.connect(gain);

    osc.start(t0);
    harm.start(t0);
    osc.stop(t0 + 0.5);
    harm.stop(t0 + 0.5);
  }
}

/** Log-map carrier MHz onto the ping pitch range. */
export function pitchFor(carrierMHz) {
  const t = Math.log(carrierMHz / CARRIER_LO) / Math.log(CARRIER_HI / CARRIER_LO);
  const clamped = Math.min(1, Math.max(0, t));
  return PITCH_LO * Math.pow(PITCH_HI / PITCH_LO, clamped);
}
