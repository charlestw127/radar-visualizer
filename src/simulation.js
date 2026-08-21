/**
 * Pulse-train simulation.
 *
 * Keeps a list of in-flight pulses. Each pulse snapshots the waveform
 * parameters at the moment it was emitted, so changing a slider only affects
 * pulses emitted from then on — pulses already in the air keep their shape.
 *
 * Time is simulated microseconds. Propagation speed is 1 light-µs per µs, so
 * a pulse emitted at tEmit has its leading edge at distance (now - tEmit) and
 * its trailing edge at (now - tEmit - pulseWidth).
 */

/** Safety caps so extreme settings (1 µs PRI, 300 km range) stay smooth. */
const MAX_PULSES = 1500;
const MAX_HISTORY = 2000;

export class Simulation {
  /**
   * @param {import('./params.js').Params} params
   */
  constructor(params) {
    this.params = params;
    this.maxRange = 300; // light-µs; pulses beyond this are discarded
    this.running = true;
    this.reset();

    params.subscribe((key) => {
      if (key === 'pri') this._reschedule();
    });
  }

  reset() {
    this.time = 0;
    /** Pulses currently in flight (culled once beyond maxRange). */
    this.pulses = [];
    /** Recent emissions {tEmit, pulseWidth}, independent of culling. */
    this.history = [];
    this.lastEmit = -Infinity;
    this.nextEmit = 0;
    this.hitCount = 0;
    this.lastHitTime = -Infinity;
    /** Carrier (MHz) of the most recent pulse to hit; drives the ping pitch. */
    this.lastHitFrequency = 0;
    /** Sensor illumination 0..1 from the last sensorIntensity() call. */
    this.lastIntensity = 0;
    /** Sensor distance (light-µs) from the last sensorIntensity() call. */
    this.sensorDistance = null;
  }

  /** Advance the simulation by dtSeconds of wall-clock time. */
  step(dtSeconds) {
    if (!this.running) return;
    const dt = dtSeconds * this.params.get('timeScale');
    this.time += dt;

    // At fast playback one frame can span thousands of PRIs. Pulses emitted
    // early enough in the frame would already be beyond maxRange (and so past
    // the sensor), so skip straight over them: count their hits, keep a few
    // PRIs of history for the strip, and only allocate pulses that could
    // still be visible.
    const pri = this.params.get('pri');
    const pw = this.params.get('pulseWidth');
    const keepUs = Math.max(this.maxRange + pw, pri * 10);
    if (this.nextEmit < this.time - keepUs) {
      const skipped = Math.floor((this.time - keepUs - this.nextEmit) / pri);
      if (skipped > 0) {
        this.nextEmit += skipped * pri;
        this.lastEmit = this.nextEmit - pri;
        this.hitCount += skipped;
        this.lastHitTime = this.time;
        this.lastHitFrequency = this.params.get('frequency');
      }
    }

    // Emit any pulses that are due. The guard bounds work per frame; anything
    // left over is picked up next frame.
    let guard = 0;
    while (this.nextEmit <= this.time && guard++ < MAX_PULSES) {
      const pulse = {
        tEmit: this.nextEmit,
        pulseWidth: this.params.get('pulseWidth'),
        frequency: this.params.get('frequency'),
        hit: false,
      };
      this.pulses.push(pulse);
      this.history.push({ tEmit: pulse.tEmit, pulseWidth: pulse.pulseWidth });
      this.lastEmit = this.nextEmit;
      this.nextEmit += pri;
    }

    // Drop pulses whose trailing edge has left the visible range, and
    // history older than the strip could ever show (it shows a few PRIs).
    // A pulse culled before sensorIntensity() got to it (possible when one
    // frame spans the whole range) still passed the sensor: count the hit.
    this.pulses = this.pulses.filter((p) => {
      if (this.trailingEdge(p) <= this.maxRange) return true;
      if (!p.hit && this.sensorDistance !== null && this.leadingEdge(p) >= this.sensorDistance) {
        this._registerHit(p);
      }
      return false;
    });
    if (this.pulses.length > MAX_PULSES) {
      this.pulses = this.pulses.slice(-MAX_PULSES);
    }
    const historyUs = pri * 10;
    this.history = this.history.filter(
      (h) => this.time - h.tEmit < historyUs,
    );
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }
  }

  /** Distance (light-µs) of the pulse's leading edge from the emitter. */
  leadingEdge(p) {
    return this.time - p.tEmit;
  }

  /** Distance (light-µs) of the pulse's trailing edge from the emitter (≥ 0). */
  trailingEdge(p) {
    return Math.max(0, this.time - p.tEmit - p.pulseWidth);
  }

  /**
   * A duration in simulated µs that is at least `minUs` and at least
   * `realSeconds` of wall-clock time at the current playback speed. Visual
   * effects use this so they stay perceptible at fast playback (where a
   * few µs would be a single frame) yet still slow down with the pulses.
   */
  visibleUs(minUs, realSeconds) {
    return Math.max(minUs, realSeconds * this.params.get('timeScale'));
  }

  /** How long (µs) the sensor keeps glowing after a pulse has fully passed. */
  get hitDecayUs() {
    return this.visibleUs(6, 0.15);
  }

  /** Duration (µs) of the hit burst animation at the sensor. */
  get hitBurstUs() {
    return this.visibleUs(12, 0.35);
  }

  /**
   * Compute how strongly the sensor at `distance` is currently being
   * illuminated: 1 while a pulse overlaps it, decaying to 0 afterwards.
   * Also registers hit events (leading edge crossing the sensor).
   */
  sensorIntensity(distance) {
    this.sensorDistance = distance;
    let best = 0;
    const decayUs = this.hitDecayUs;
    for (const p of this.pulses) {
      const lead = this.leadingEdge(p);
      const trail = this.trailingEdge(p);

      if (lead >= distance && !p.hit) this._registerHit(p);

      let intensity = 0;
      if (lead >= distance && trail <= distance) {
        intensity = 1;
      } else if (trail > distance) {
        intensity = Math.exp(-(trail - distance) / decayUs);
      }
      if (intensity > best) best = intensity;
    }
    this.lastIntensity = best;
    return best;
  }

  _registerHit(p) {
    p.hit = true;
    this.hitCount += 1;
    this.lastHitTime = this.time;
    this.lastHitFrequency = p.frequency;
  }

  /** After a PRI change, re-time the next emission from the last one. */
  _reschedule() {
    const pri = this.params.get('pri');
    this.nextEmit = Math.max(this.time, this.lastEmit + pri);
  }
}
