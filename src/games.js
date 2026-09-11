/**
 * games.js — DOM-free state machines for the two game modes.
 *
 * HUNT: one hidden platform of a random class wanders the arena. The player
 * steers the beam, builds a track, reads the RCS estimate and calls the
 * class. Truth is only revealed on a correct call.
 *
 * BATTLE: four player-controlled platforms try to reach the goal ring around
 * the radar while an automatic scan hunts them. A platform continuously
 * TRACKED for INTERCEPT_WALL_S is intercepted. EA (noise jamming) denies
 * detection outside burn-through; ES/RWR paint warnings are always available
 * (they are truth on the platform's own side).
 */
import { RCS_CLASSES } from './rf.js';
import { Platform, BattlePlatform, randomPointKm } from './world.js';

/** Wall-clock seconds of continuous track before a platform is intercepted. */
export const INTERCEPT_WALL_S = 8;
/** A confirmed track within this distance of a platform is "on" it. */
const ASSOC_KM = 6;

export class HuntGame {
  /** @param {import('./params.js').Params} params */
  constructor(params) {
    this.params = params;
    this.reset();
  }

  get arenaKm() { return this.params.get('rangeKm'); }

  reset() {
    const cls = RCS_CLASSES[Math.floor(Math.random() * RCS_CLASSES.length)];
    const pos = randomPointKm(this.arenaKm * 0.35, this.arenaKm * 0.8);
    this.target = new Platform(cls.id, pos.xKm, pos.yKm, Math.random() * 2 * Math.PI);
    this.state = 'hunting'; // 'hunting' | 'won'
    this.guesses = [];
    this.elapsedWallS = 0;
    this.revealed = false;
  }

  update(dtGameS, dtWallS) {
    if (this.state !== 'hunting') return;
    this.elapsedWallS += dtWallS;
    if (!this.target.waypoint) {
      this.target.waypoint = randomPointKm(this.arenaKm * 0.2, this.arenaKm * 0.85);
    }
    this.target.update(dtGameS);
  }

  /**
   * Call the target's class. Returns {correct, cls} — correct ends the hunt
   * and reveals the truth; wrong guesses are recorded and play continues.
   */
  guess(classId) {
    if (this.state !== 'hunting') return null;
    this.guesses.push(classId);
    const correct = classId === this.target.cls.id;
    if (correct) {
      this.state = 'won';
      this.revealed = true;
    }
    return { correct, cls: this.target.cls };
  }
}

export class BattleGame {
  /** @param {import('./params.js').Params} params */
  constructor(params) {
    this.params = params;
    this.reset();
  }

  get arenaKm() { return this.params.get('rangeKm'); }
  get goalKm() { return Math.max(6, this.arenaKm * 0.08); }

  reset() {
    const a = this.arenaKm;
    const mk = (cls, azDeg) => {
      const az = (azDeg * Math.PI) / 180;
      const p = new BattlePlatform(cls, a * 0.85 * Math.cos(az), a * 0.85 * Math.sin(az), az + Math.PI);
      return p;
    };
    // A varied strike package spawning on the western edge.
    this.platforms = [
      mk('fighter', 155), mk('fighter', 175), mk('bomber', 195), mk('missile', 215),
    ];
    this.selectedId = this.platforms[0].id;
    this.state = 'playing'; // 'playing' | 'won' | 'lost'
    this.trackedWallS = new Map(this.platforms.map((p) => [p.id, 0]));
    this.statuses = new Map();   // id → 'HIDDEN'|'PAINTED'|'DETECTED'|'TRACKED'|'INTERCEPTED'
    this.events = [];            // {type:'intercept'|'win'|'lose', platform?} this frame
  }

  get selected() { return this.platforms.find((p) => p.id === this.selectedId) ?? null; }
  get jammers() { return this.platforms.filter((p) => p.ea && p.alive); }

  select(id) { if (this.platforms.some((p) => p.id === id)) this.selectedId = id; }

  setWaypoint(xKm, yKm) {
    const p = this.selected;
    if (p && p.alive && this.state === 'playing') p.waypoint = { xKm, yKm };
  }

  toggleEa(id) {
    const p = this.platforms.find((q) => q.id === id);
    if (p && p.alive) p.ea = !p.ea;
  }

  /**
   * @param {number} dtGameS @param {number} dtWallS
   * @param {import('./radar.js').RadarModel} radar
   */
  update(dtGameS, dtWallS, radar) {
    this.events = [];
    if (this.state !== 'playing') return;

    for (const p of this.platforms) p.update(dtGameS);

    // Status ladder per platform, from the radar's ACTUAL picture (the truth
    // side only supplies the pairing between tracks and platforms).
    const paintedWindow = radar.revisitS * 1.6;
    for (const p of this.platforms) {
      if (!p.alive) { this.statuses.set(p.id, 'INTERCEPTED'); continue; }

      let matched = null;
      for (const tr of radar.tracks) {
        // Extrapolate the track to NOW: a 900 m/s missile moves ~9 km
        // between scan revisits, far outside ASSOC_KM at the last filtered
        // position. Capped so a coasting track cannot chase forever.
        const dtS = Math.min(radar.revisitS * 2,
          Math.max(0, radar.gameT - (tr.lastPaintGameT ?? radar.gameT)));
        const tx = tr.xKm + (tr.vxKmS ?? 0) * dtS;
        const ty = tr.yKm + (tr.vyKmS ?? 0) * dtS;
        if (Math.hypot(tx - p.xKm, ty - p.yKm) < ASSOC_KM) {
          if (!matched || tr.state !== 'TENTATIVE') matched = tr;
        }
      }
      let status = 'HIDDEN';
      if (matched && matched.state !== 'TENTATIVE') status = 'TRACKED';
      else if (matched) status = 'DETECTED';
      else if (radar.gameT - p.lastPaintedGameT < paintedWindow) status = 'PAINTED';
      this.statuses.set(p.id, status);

      // Intercept clock: runs while tracked, unwinds otherwise.
      let t = this.trackedWallS.get(p.id) ?? 0;
      t = status === 'TRACKED' ? t + dtWallS : Math.max(0, t - dtWallS * 2);
      this.trackedWallS.set(p.id, t);
      if (t >= INTERCEPT_WALL_S) {
        p.alive = false;
        p.ea = false;
        this.statuses.set(p.id, 'INTERCEPTED');
        this.events.push({ type: 'intercept', platform: p });
      }
    }

    // Win: anyone alive inside the goal ring. Lose: nobody left alive.
    if (this.platforms.some((p) => p.alive && p.rangeKm <= this.goalKm)) {
      this.state = 'won';
      this.events.push({ type: 'win' });
    } else if (this.platforms.every((p) => !p.alive)) {
      this.state = 'lost';
      this.events.push({ type: 'lose' });
    }
  }
}
