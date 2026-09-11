/**
 * PPI renderer (modes "hunt" and "battle"): a plan position indicator with
 * the radar at the centre of the arena. North-up: world km, +y = north = up
 * on screen (screen angle = −world azimuth).
 *
 * What you see is the radar's PICTURE, not the truth: fading blips where
 * paints landed, tracks from the tracker, jam strobes where noise pours in.
 * Truth is drawn only where the player owns it — battle platforms are your
 * own aircraft, and the hunt target appears only after a correct identify.
 *
 * The phosphor look comes from drawing radar.plots directly each frame with
 * an alpha from each plot's remaining life — no accumulation buffer, so the
 * decay is exact (no 8-bit ghosting), DPR-sharp, frozen while paused, and
 * cleared automatically when the radar resets.
 */
import {
  clear, drawEmitter, MIN_PULSE_PX, COLORS,
} from './common.js';
import { drawAScope } from './scope.js';
import { C_M_PER_US, fmtSig } from '../params.js';

const KM_TO_US = 1000 / C_M_PER_US;

export function render(ctx, layout, sim) {
  const game = layout.game; // HuntModeCtx | BattleModeCtx
  const radar = game.radar;
  const { emitter, main, pxPerUs } = layout;
  const arenaKm = sim.params.get('rangeKm');
  const arenaPx = arenaKm * KM_TO_US * pxPerUs;
  const kmToPx = (km) => km * KM_TO_US * pxPerUs;
  const toX = (xKm) => emitter.x + kmToPx(xKm);
  const toY = (yKm) => emitter.y - kmToPx(yKm); // +y north = up

  sim.maxRange = arenaKm * KM_TO_US * 1.25;

  clear(ctx, layout);

  ctx.save();
  ctx.beginPath();
  ctx.rect(main.x, main.y, main.w, main.h);
  ctx.clip();

  // ---- Range rings + bearing ticks ---------------------------------------
  const step = arenaKm <= 40 ? 10 : arenaKm <= 120 ? 25 : 50;
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
  for (let r = step; r <= arenaKm + 0.01; r += step) {
    ctx.beginPath();
    ctx.arc(emitter.x, emitter.y, kmToPx(r), 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText(`${r}`, toX(r) + 3, emitter.y - 4);
  }
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.textAlign = 'center';
  for (let b = 0; b < 360; b += 30) {
    const th = ((90 - b) * Math.PI) / 180; // bearing → world az
    const sx = Math.cos(th);
    const sy = Math.sin(th);
    ctx.beginPath();
    ctx.moveTo(emitter.x, emitter.y);
    ctx.lineTo(toX(sx * arenaKm), toY(sy * arenaKm));
    ctx.stroke();
    if (b % 90 === 0) {
      ctx.fillText('NESW'[b / 90], toX(sx * arenaKm * 0.96), toY(sy * arenaKm * 0.96) + 3);
    }
  }

  // Arena edge.
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.arc(emitter.x, emitter.y, arenaPx, 0, Math.PI * 2);
  ctx.stroke();

  // ---- Jam strobes (battle): noise pouring in at the jammer's azimuth ----
  if (game.game?.jammers) {
    for (const j of game.game.jammers) {
      const bw = radar.beamwidthRad;
      const mainlobe = Math.abs(angDiff(j.azRad, radar.azRad)) < bw;
      const a = (mainlobe ? 0.30 : 0.10) * (0.8 + 0.2 * Math.random());
      wedge(ctx, emitter, arenaPx, j.azRad, bw * 1.3, `rgba(255,92,122,${a})`);
      // Burn-through ring: inside it this jammer no longer hides its platform.
      const btKm = game._burnThrough(j);
      if (btKm > 0.5 && btKm < arenaKm) {
        ctx.strokeStyle = 'rgba(255,92,122,0.35)';
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        ctx.arc(emitter.x, emitter.y, kmToPx(btKm), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  // ---- Plot blips (phosphor-style fade from plot.lifeS) ------------------
  for (const p of radar.plots) {
    const x = toX(p.xKm);
    const y = toY(p.yKm);
    const a = Math.max(0, Math.min(1, p.lifeS / 4));
    const r = p.falseAlarm ? 2.5 : Math.max(2, Math.min(6, 3 + (p.snrDb - 13) / 8));
    ctx.fillStyle = p.falseAlarm
      ? `rgba(170,185,200,${0.8 * a})`
      : `rgba(62,230,168,${0.95 * a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (p.ambiguous && a > 0.2) {
      ctx.strokeStyle = `rgba(255,180,84,${0.9 * a})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---- Outgoing pulse arcs (each pulse remembers its beam azimuth) -------
  const bw = radar.beamwidthRad;
  for (const p of sim.pulses) {
    const az = game.echoField.pulseAz.get(p) ?? radar.azRad;
    const lead = sim.leadingEdge(p);
    const trail = sim.trailingEdge(p);
    const rO = lead * pxPerUs;
    const rI = trail * pxPerUs;
    if (rO <= 0 || rO > arenaPx * 1.25) continue;
    const mid = (rO + rI) / 2;
    ctx.strokeStyle = `rgba(62,230,168,${0.5 / (1 + lead / (arenaKm * KM_TO_US))})`;
    ctx.lineWidth = Math.max(MIN_PULSE_PX * 0.6, rO - rI);
    ctx.beginPath();
    ctx.arc(emitter.x, emitter.y, Math.max(1, mid), -az - bw / 2, -az + bw / 2);
    ctx.stroke();
  }

  // ---- Echo rings (battle only: own platforms, no secret to keep) --------
  if (game.id === 'battle') {
    for (const e of game.echoField.echoes) {
      const age = sim.time - e.tReflectUs;
      if (age <= 0) continue;
      const fade = 0.5 / (1 + age / e.rangeUs);
      if (fade < 0.03) continue;
      ctx.strokeStyle = `rgba(255,180,84,${fade})`;
      ctx.lineWidth = Math.max(2, e.pulseWidth * pxPerUs);
      ctx.beginPath();
      ctx.arc(toX(e.xKm), toY(e.yKm), age * pxPerUs, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---- Beam wedge ---------------------------------------------------------
  wedgeGradient(ctx, emitter, arenaPx, radar.azRad, bw, 'rgba(62,230,168,0.22)');
  if (radar.scanMode === 'manual' && !game.lockedTrackId) {
    // Steering command indicator.
    const ca = radar.commandAzRad;
    ctx.strokeStyle = 'rgba(215,225,234,0.25)';
    ctx.setLineDash([2, 6]);
    ctx.beginPath();
    ctx.moveTo(emitter.x, emitter.y);
    ctx.lineTo(emitter.x + Math.cos(-ca) * arenaPx, emitter.y + Math.sin(-ca) * arenaPx);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---- Tracks -------------------------------------------------------------
  ctx.font = '600 10px system-ui, sans-serif';
  for (const tr of radar.tracks) {
    const x = toX(tr.xKm);
    const y = toY(tr.yKm);
    if (tr.state === 'TENTATIVE') {
      ctx.strokeStyle = 'rgba(170,185,200,0.6)';
      ctx.lineWidth = 1;
      cross(ctx, x, y, 4);
      continue;
    }
    const col = tr.state === 'COAST' ? 'rgba(255,180,84,0.9)' : 'rgba(62,230,168,0.95)';
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = 1.5;
    diamond(ctx, x, y, 7, tr.state !== 'COAST');
    // Velocity leader: where the track will be in 30 game-seconds.
    const lx = toX(tr.xKm + tr.vxKmS * 30);
    const ly = toY(tr.yKm + tr.vyKmS * 30);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillText(
      `T${tr.id} ${Math.round(Math.hypot(tr.vxKmS, tr.vyKmS) * 1000)} m/s${tr.state === 'COAST' ? ' ▢' : ''}`,
      x + 10, y - 8,
    );
    // Designated (locked) track: corner brackets + label.
    if (game.lockedTrackId === tr.id) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      const s = 13, c = 5;
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.moveTo(x + sx * s - sx * c, y + sy * s);
        ctx.lineTo(x + sx * s, y + sy * s);
        ctx.lineTo(x + sx * s, y + sy * s - sy * c);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText('LOCK', x + 17, y + 17);
    }
  }

  // ---- Truth layer the player owns ---------------------------------------
  if (game.id === 'battle') {
    drawGoal(ctx, emitter, kmToPx(game.game.goalKm));
    for (const p of game.game.platforms) {
      drawPlatform(ctx, game, p, toX(p.xKm), toY(p.yKm), radar, toX, toY);
    }
  } else if (game.game?.revealed) {
    const t = game.game.target;
    const x = toX(t.xKm);
    const y = toY(t.yKm);
    ctx.strokeStyle = ctx.fillStyle = 'rgba(255,180,84,0.95)';
    chevron(ctx, x, y, -t.headingRad, 9, false);
    ctx.textAlign = 'center';
    ctx.fillText(`${t.cls.label.toUpperCase()} (truth)`, x, y + 20);
  }

  ctx.restore();

  // ---- Radar glyph + banner ----------------------------------------------
  layout.sensor = {
    x: emitter.x + Math.cos(-radar.azRad) * 40,
    y: emitter.y + Math.sin(-radar.azRad) * 40,
  };
  drawEmitter(ctx, layout, sim, 'RADAR');
  banner(ctx, layout, game);

  drawAScope(ctx, layout, sim, radar, sim.params);
}

// ---------------------------------------------------------------------------

function angDiff(a, b) {
  let d = a - b;
  while (d <= -Math.PI) d += 2 * Math.PI;
  while (d > Math.PI) d -= 2 * Math.PI;
  return d;
}

function wedge(ctx, c, rPx, azRad, widthRad, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.arc(c.x, c.y, rPx, -azRad - widthRad / 2, -azRad + widthRad / 2);
  ctx.closePath();
  ctx.fill();
}

function wedgeGradient(ctx, c, rPx, azRad, widthRad, colour) {
  const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, rPx);
  g.addColorStop(0, colour);
  g.addColorStop(1, 'rgba(62,230,168,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(c.x, c.y);
  ctx.arc(c.x, c.y, rPx, -azRad - widthRad / 2, -azRad + widthRad / 2);
  ctx.closePath();
  ctx.fill();
}

function cross(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
  ctx.moveTo(x - s, y + s); ctx.lineTo(x + s, y - s);
  ctx.stroke();
}

function diamond(ctx, x, y, s, filled) {
  ctx.beginPath();
  ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y);
  ctx.closePath();
  if (filled) ctx.fill(); else ctx.stroke();
}

function chevron(ctx, x, y, screenAngle, s, filled = true) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(screenAngle);
  ctx.beginPath();
  ctx.moveTo(s, 0);
  ctx.lineTo(-s * 0.8, s * 0.7);
  ctx.lineTo(-s * 0.4, 0);
  ctx.lineTo(-s * 0.8, -s * 0.7);
  ctx.closePath();
  if (filled) ctx.fill(); else ctx.stroke();
  ctx.restore();
}

function drawGoal(ctx, c, rPx) {
  ctx.strokeStyle = 'rgba(62,230,168,0.5)';
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(c.x, c.y, rPx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(62,230,168,0.7)';
  ctx.font = '600 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('GOAL', c.x, c.y - rPx - 5);
}

function drawPlatform(ctx, modeCtx, p, x, y, radar, toX, toY) {
  const selected = modeCtx.game.selectedId === p.id;
  const idx = modeCtx.game.platforms.indexOf(p) + 1;

  if (!p.alive) {
    ctx.strokeStyle = 'rgba(127,145,163,0.7)';
    ctx.lineWidth = 2;
    cross(ctx, x, y, 7);
    ctx.fillStyle = 'rgba(127,145,163,0.7)';
    ctx.textAlign = 'center';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText(`#${idx} DOWN`, x, y + 20);
    return;
  }

  // Waypoint leg.
  if (p.waypoint) {
    ctx.strokeStyle = 'rgba(215,225,234,0.25)';
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(toX(p.waypoint.xKm), toY(p.waypoint.yKm));
    ctx.stroke();
    ctx.setLineDash([]);
    cross(ctx, toX(p.waypoint.xKm), toY(p.waypoint.yKm), 3);
  }

  // RWR: amber arc on the radar-facing side while the beam is on us.
  const painted = radar.gameT - p.lastPaintedGameT < 0.6;
  if (painted) {
    const azToRadar = Math.atan2(-p.yKm, -p.xKm);
    ctx.strokeStyle = 'rgba(255,180,84,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 13, -azToRadar - 0.7, -azToRadar + 0.7);
    ctx.stroke();
  }

  // EA: red emission arcs toward the radar.
  if (p.ea) {
    const azToRadar = Math.atan2(-p.yKm, -p.xKm);
    ctx.strokeStyle = 'rgba(255,92,122,0.85)';
    ctx.lineWidth = 1.5;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.arc(x, y, 8 + i * 5, -azToRadar - 0.5, -azToRadar + 0.5);
      ctx.stroke();
    }
  }

  const col = selected ? '#ffffff' : '#8fd8ff';
  ctx.fillStyle = col;
  ctx.strokeStyle = col;
  chevron(ctx, x, y, -p.headingRad, 9, true);
  if (selected) {
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText(`#${idx} ${p.cls.label}${p.ea ? ' ⚡' : ''}`, x, y + 24);
}

function banner(ctx, layout, game) {
  let text = null;
  if (game.id === 'battle') {
    if (game.game.state === 'won') text = 'GOAL REACHED — STRIKE THROUGH';
    else if (game.game.state === 'lost') text = 'ALL PLATFORMS INTERCEPTED';
  } else if (game.id === 'hunt' && game.game.state === 'won') {
    text = `IDENTIFIED: ${game.game.target.cls.label.toUpperCase()} — ${Math.round(game.game.elapsedWallS)} s, ${game.game.guesses.length} guess${game.game.guesses.length > 1 ? 'es' : ''}`;
  }
  if (!text) return;
  ctx.font = '700 18px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = game.game.state === 'lost' ? '#ff5c7a' : '#3ee6a8';
  ctx.fillText(text, layout.main.x + layout.main.w / 2, layout.main.y + 40);
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = '#7f91a3';
  ctx.fillText('Press G for a new round', layout.main.x + layout.main.w / 2, layout.main.y + 60);
}
