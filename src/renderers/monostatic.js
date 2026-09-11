/**
 * Monostatic-radar renderer (mode "radar"): the dish on the left is both
 * emitter and sensor. TX rings expand from the radar exactly as in beam
 * mode's ring style; when a ring sweeps the sphere, an ECHO ring (amber)
 * expands back from the sphere's position at illumination, and the blip on
 * the A-scope lands when that echo reaches the dish (paint-delay queue).
 *
 * Screen mapping: world km with the radar at the origin, +x right, +y DOWN
 * (matches beam mode's orbit direction on screen).
 */
import {
  clear, drawGrid, drawEmitter, carrierSpacingPx, MIN_PULSE_PX, COLORS, label,
} from './common.js';
import { drawAScope } from './scope.js';
import { C_M_PER_US, fmtSig, fmtDistanceM } from '../params.js';
import { CENTRE_FRAC, RADIUS_FRAC } from '../sensorMotion.js';

const KM_TO_US = 1000 / C_M_PER_US;

export function render(ctx, layout, sim) {
  const game = layout.game; // RadarModeCtx
  const { emitter, main, pxPerUs } = layout;
  const kmToPx = (km) => km * KM_TO_US * pxPerUs;
  const toX = (xKm) => emitter.x + kmToPx(xKm);
  const toY = (yKm) => emitter.y + kmToPx(yKm);

  const maxVisibleUs = Math.hypot(
    Math.max(emitter.x, main.w - emitter.x),
    Math.max(emitter.y, main.h - emitter.y),
  ) / pxPerUs;
  sim.maxRange = maxVisibleUs + MIN_PULSE_PX / pxPerUs;

  clear(ctx, layout);
  drawGrid(ctx, layout);

  const target = game.target;
  const tx = toX(target.xKm);
  const ty = toY(target.yKm);
  const targetRangeUs = target.rangeKm * KM_TO_US;

  // Orbit path (same geometry constants as beam mode's sensor orbit).
  if (target.orbiting) {
    const R = layout.nominalRangeUs / KM_TO_US; // slider km
    ctx.save();
    ctx.strokeStyle = 'rgba(127,145,163,0.35)';
    ctx.setLineDash([3, 7]);
    ctx.beginPath();
    ctx.arc(toX(R * CENTRE_FRAC), toY(0), kmToPx(R * RADIUS_FRAC), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Staring beam cone toward the target.
  const az = Math.atan2(ty - emitter.y, tx - emitter.x);
  const bw = game.radar.beamwidthRad;
  const coneLen = maxVisibleUs * pxPerUs;
  ctx.save();
  ctx.fillStyle = 'rgba(62,230,168,0.05)';
  ctx.beginPath();
  ctx.moveTo(emitter.x, emitter.y);
  ctx.arc(emitter.x, emitter.y, coneLen, az - bw / 2, az + bw / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(main.x, main.y, main.w, main.h);
  ctx.clip();

  // TX rings (green, from the radar).
  for (const p of sim.pulses) {
    drawAnnulus(ctx, emitter.x, emitter.y,
      sim.leadingEdge(p) * pxPerUs, sim.trailingEdge(p) * pxPerUs,
      p.frequency, [62, 230, 168], 1 / (1 + sim.leadingEdge(p) / layout.nominalRangeUs));
  }

  // Echo rings (amber, from the sphere's position at illumination).
  let radarGlow = 0;
  for (const e of game.echoField.echoes) {
    const age = sim.time - e.tReflectUs;
    if (age <= 0) continue;
    const fade = 0.8 / (1 + age / e.rangeUs);
    drawAnnulus(ctx, toX(e.xKm), toY(e.yKm),
      age * pxPerUs, Math.max(0, age - e.pulseWidth) * pxPerUs,
      e.frequency, [255, 180, 84], fade);
    // Echo front crossing the dish: receive glow.
    const frontOverRadar = age - e.rangeUs;
    if (frontOverRadar >= 0 && frontOverRadar <= e.pulseWidth + sim.hitDecayUs) radarGlow = 1;
  }
  ctx.restore();

  // Sphere target: radius by log-RCS, lit while a TX ring is over it.
  let lit = 0;
  for (const p of sim.pulses) {
    if (sim.leadingEdge(p) >= targetRangeUs && sim.trailingEdge(p) <= targetRangeUs) lit = 1;
  }
  const rcs = target.cls.rcsM2;
  const rad = 6 + ((Math.log10(rcs) + 2) / 4) * 14;
  if (lit) {
    const grad = ctx.createRadialGradient(tx, ty, rad * 0.3, tx, ty, rad * 3);
    grad.addColorStop(0, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,180,84,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(tx, ty, rad * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const sphereGrad = ctx.createRadialGradient(tx - rad * 0.35, ty - rad * 0.35, rad * 0.2, tx, ty, rad);
  sphereGrad.addColorStop(0, '#d7e1ea');
  sphereGrad.addColorStop(1, '#5a6f83');
  ctx.fillStyle = sphereGrad;
  ctx.beginPath();
  ctx.arc(tx, ty, rad, 0, Math.PI * 2);
  ctx.fill();
  label(ctx, `SPHERE σ=${fmtSig(rcs, 2)} m² (d≈${fmtDistanceM(target.diameterM)})`, tx, ty + rad + 16, '#aebfce');

  // Radar dish (emitter glyph pointed at the target) + receive glow.
  layout.sensor = { x: tx, y: ty }; // aims the dish; layout is per-frame
  if (radarGlow) {
    const g = ctx.createRadialGradient(emitter.x, emitter.y, 6, emitter.x, emitter.y, 46);
    g.addColorStop(0, 'rgba(255,180,84,0.6)');
    g.addColorStop(1, 'rgba(255,180,84,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(emitter.x, emitter.y, 46, 0, Math.PI * 2);
    ctx.fill();
  }
  drawEmitter(ctx, layout, sim, 'RADAR (TX + RX)');

  drawAScope(ctx, layout, sim, game.radar, sim.params);
}

/** Expanding annulus with carrier stripes — the ring.js look, recolourable. */
function drawAnnulus(ctx, cx, cy, rOuter, rInnerRaw, freqMHz, [r, g, b], fade) {
  if (rOuter <= 0 || fade <= 0.01) return;
  const rInner = Math.min(rInnerRaw, Math.max(0, rOuter - MIN_PULSE_PX));

  ctx.beginPath();
  ctx.arc(cx, cy, rOuter, 0, Math.PI * 2, false);
  if (rInner > 0) ctx.arc(cx, cy, rInner, 0, Math.PI * 2, true);
  ctx.fillStyle = `rgba(${r},${g},${b},${0.16 * fade})`;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, rOuter, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(${r},${g},${b},${0.85 * fade})`;
  ctx.lineWidth = 2;
  ctx.stroke();

  const lambdaPx = carrierSpacingPx(freqMHz);
  ctx.strokeStyle = `rgba(${r},${g},${b},${0.4 * fade})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let count = 0;
  for (let rr = Math.floor(rOuter / lambdaPx) * lambdaPx; rr > rInner && count < 60; rr -= lambdaPx, count++) {
    if (rr <= 0 || rr >= rOuter) continue;
    ctx.moveTo(cx + rr, cy);
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
  }
  ctx.stroke();
}
