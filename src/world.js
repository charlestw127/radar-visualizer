/**
 * world.js — DOM-free arena kinematics for the radar game modes.
 *
 * ONE time base for everything above the pulse level: "game seconds" are TRUE
 * seconds, played back at GAME_TIMELAPSE× wall-clock speed. Platform motion,
 * antenna rotation, dwell timing, the tracker and every velocity readout all
 * run in game seconds, so speeds are true m/s everywhere with no scattered
 * conversion factors — the single stylisation is that the arena timeline runs
 * GAME_TIMELAPSE× faster than your wall clock (documented in the README).
 * Pulse/echo ANIMATION stays in simulated µs exactly as in beam mode.
 *
 * Coordinates: kilometres, radar at the origin. Azimuth is the standard math
 * angle (0 = +x east, counter-clockwise positive) — the PPI draws it directly.
 */
import { RCS_CLASSES } from './rf.js';
import { wrapAngle } from './rf.js';

/** Arena timeline speed-up vs wall clock. */
export const GAME_TIMELAPSE = 5;

/** Turn rate for waypoint-following platforms, rad per game-second. */
const TURN_RATE = 0.35;

let nextId = 1;

export class Platform {
  /**
   * @param {string} classId one of RCS_CLASSES ids
   * @param {number} xKm @param {number} yKm @param {number} headingRad
   */
  constructor(classId, xKm, yKm, headingRad = 0) {
    const cls = RCS_CLASSES.find((c) => c.id === classId);
    if (!cls) throw new Error(`Unknown class: ${classId}`);
    this.id = nextId++;
    this.cls = cls;
    this.xKm = xKm;
    this.yKm = yKm;
    this.headingRad = headingRad;
    this.speedMps = cls.speedMps;   // true m/s
    this.waypoint = null;           // {xKm, yKm} or null = fly straight
    this.ea = false;                // noise jammer on/off
    this.alive = true;
    this.lastPaintedGameT = -Infinity; // RWR: when the radar beam last swept us
    this.paintCount = 0;
  }

  get rangeKm() { return Math.hypot(this.xKm, this.yKm); }
  get azRad() { return Math.atan2(this.yKm, this.xKm); }

  /** Radial velocity toward the radar at the origin, m/s (+ closing). */
  get radialVelocityMps() {
    const r = this.rangeKm;
    if (r < 1e-6 || !this.alive) return 0;
    const vx = Math.cos(this.headingRad);
    const vy = Math.sin(this.headingRad);
    return this.speedMps * -((vx * this.xKm + vy * this.yKm) / r);
  }

  /** Advance by dt game-seconds: turn toward waypoint, then fly. */
  update(dtGameS) {
    if (!this.alive || dtGameS <= 0) return;
    if (this.waypoint) {
      const dx = this.waypoint.xKm - this.xKm;
      const dy = this.waypoint.yKm - this.yKm;
      const dist = Math.hypot(dx, dy);
      const arriveKm = (this.speedMps / 1000) * dtGameS * 2 + 0.2;
      if (dist < arriveKm) {
        this.waypoint = null; // caller (or the loiter subclass) decides what's next
      } else {
        const want = Math.atan2(dy, dx);
        const dAz = wrapAngle(want - this.headingRad);
        const maxTurn = TURN_RATE * dtGameS;
        this.headingRad = wrapAngle(
          this.headingRad + Math.max(-maxTurn, Math.min(maxTurn, dAz)),
        );
      }
    }
    const dKm = (this.speedMps / 1000) * dtGameS;
    this.xKm += Math.cos(this.headingRad) * dKm;
    this.yKm += Math.sin(this.headingRad) * dKm;
  }
}

/** A battle platform loiters when it has no waypoint (flies a tight circle). */
export class BattlePlatform extends Platform {
  update(dtGameS) {
    if (!this.alive || dtGameS <= 0) return;
    if (!this.waypoint) {
      this.headingRad = wrapAngle(this.headingRad + 0.06 * dtGameS); // gentle orbit
    }
    super.update(dtGameS);
  }
}

/** Random point in an annulus around the origin (used for spawns/wander). */
export function randomPointKm(rMinKm, rMaxKm, azMinRad = -Math.PI, azMaxRad = Math.PI) {
  const az = azMinRad + Math.random() * (azMaxRad - azMinRad);
  const r = rMinKm + Math.random() * (rMaxKm - rMinKm);
  return { xKm: r * Math.cos(az), yKm: r * Math.sin(az) };
}
