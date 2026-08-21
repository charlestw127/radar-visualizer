/**
 * Optional sensor motion: the sensor flies a circle that is off-centre from
 * the emitter, so its range sweeps between ~0.28× and ~0.96× the nominal
 * emitter–sensor distance. That makes range-dependent effects visible:
 * path loss, Doppler, and the change in hit timing.
 *
 * Time base, deliberately mixed:
 *   - The orbit angle advances in WALL-CLOCK seconds (`orbitPeriod`). A real
 *     platform at 300 m/s would not visibly move in ×10 000 slow motion, so
 *     the motion is a stylised animation, frozen while the sim is paused.
 *   - Radial velocity, Doppler and path loss use the `platformSpeed` slider
 *     and the orbit's TRUE geometry (direction of motion vs line of sight),
 *     so the sign and the shape over an orbit are right: closing on one half,
 *     opening on the other, zero at closest and furthest approach.
 */
import { C_M_PER_US } from './params.js';

/** Orbit centre along the emitter→nominal-sensor line, and radius, as fractions of that distance. */
export const CENTRE_FRAC = 0.62;
export const RADIUS_FRAC = 0.34;

export class SensorMotion {
  /** @param {import('./params.js').Params} params */
  constructor(params) {
    this.params = params;
    this.enabled = false;
    this.angle = 0; // radians; 0 = furthest point, on the emitter→sensor axis
  }

  /** Advance the orbit by dt wall-clock seconds (caller passes 0 when paused). */
  update(dtSeconds) {
    if (!this.enabled || dtSeconds <= 0) return;
    const period = this.params.get('orbitPeriod');
    this.angle = (this.angle + (2 * Math.PI * dtSeconds) / period) % (2 * Math.PI);
  }

  /**
   * Apply the motion to a freshly computed layout: moves `layout.sensor`,
   * replaces `layout.rangeUs` with the live range, and adds:
   *   orbit          {cx, cy, r, tangent}  (null when disabled)
   *   radialVelocity m/s, +ve closing
   *   dopplerHz      one-way Doppler shift of the carrier
   *   pathGainDb     1/R² loss relative to closest approach (≤ 0; 0 when disabled)
   *   pathGain       same as a linear power ratio
   */
  apply(layout) {
    layout.orbit = null;
    layout.radialVelocity = 0;
    layout.dopplerHz = 0;
    layout.pathGainDb = 0;
    layout.pathGain = 1;
    if (!this.enabled) return layout;

    const { emitter, sensor: nominal, pxPerUs } = layout;
    const dx = nominal.x - emitter.x;
    const dy = nominal.y - emitter.y;
    const nominalPx = Math.hypot(dx, dy);
    const cx = emitter.x + dx * CENTRE_FRAC;
    const cy = emitter.y + dy * CENTRE_FRAC;
    const r = nominalPx * RADIUS_FRAC;

    const sx = cx + r * Math.cos(this.angle);
    const sy = cy + r * Math.sin(this.angle);
    const distPx = Math.hypot(sx - emitter.x, sy - emitter.y);

    // Unit direction of motion (tangent) and unit line of sight sensor→emitter.
    const tx = -Math.sin(this.angle);
    const ty = Math.cos(this.angle);
    const lx = (emitter.x - sx) / distPx;
    const ly = (emitter.y - sy) / distPx;
    const radialFactor = tx * lx + ty * ly; // +1 straight at the emitter, −1 straight away

    const speed = this.params.get('platformSpeed');
    const fcMHz = this.params.get('frequency');
    const rangeUs = distPx / pxPerUs;
    const rMinUs = (nominalPx / pxPerUs) * (CENTRE_FRAC - RADIUS_FRAC);

    layout.sensor = { x: sx, y: sy };
    layout.rangeUs = rangeUs;
    layout.orbit = { cx, cy, r, tangent: { x: tx, y: ty } };
    layout.radialVelocity = speed * radialFactor;
    // fd = v_r / λ = v_r · f / c, with f in MHz and c in m/µs → Hz.
    layout.dopplerHz = (layout.radialVelocity * fcMHz) / C_M_PER_US;
    layout.pathGainDb = 20 * Math.log10(rMinUs / rangeUs);
    layout.pathGain = Math.pow(10, layout.pathGainDb / 10);
    return layout;
  }
}
