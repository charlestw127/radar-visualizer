/**
 * Ring renderer.
 *
 * Each in-flight pulse is an expanding annulus centred on the emitter. The
 * outer radius is the leading edge, the inner radius the trailing edge, so
 * the ring's thickness is the pulse width (with a minimum on-screen thickness
 * so nanosecond pulses stay visible). Concentric stripes inside the annulus
 * show the carrier at a stylised spacing (see carrierSpacingPx). When the
 * annulus sweeps over the sensor, the sensor lights up and a hit burst plays.
 */
import {
  clear, drawGrid, drawEmitter, drawSensor, drawHitEffect, drawPulseTrainStrip,
  carrierSpacingPx, MIN_PULSE_PX,
} from './common.js';

const MAX_STRIPES = 80;

export function render(ctx, layout, sim) {
  clear(ctx, layout);
  drawGrid(ctx, layout);

  const { emitter, main, pxPerUs, rangeUs } = layout;

  // Anything beyond the far corner of the main area is invisible; cull there.
  const maxVisibleUs = Math.hypot(
    Math.max(emitter.x, main.w - emitter.x),
    Math.max(emitter.y, main.h - emitter.y),
  ) / pxPerUs;
  sim.maxRange = maxVisibleUs + MIN_PULSE_PX / pxPerUs;

  ctx.save();
  ctx.beginPath();
  ctx.rect(main.x, main.y, main.w, main.h);
  ctx.clip();
  for (const p of sim.pulses) {
    drawRing(ctx, layout, sim, p);
  }
  ctx.restore();

  const intensity = sim.sensorIntensity(rangeUs);
  drawEmitter(ctx, layout, sim);
  drawSensor(ctx, layout, intensity);
  drawHitEffect(ctx, layout, sim);
  drawPulseTrainStrip(ctx, layout, sim);
}

function drawRing(ctx, layout, sim, pulse) {
  const { emitter, pxPerUs, rangeUs } = layout;
  const leadUs = sim.leadingEdge(pulse);
  const trailUs = sim.trailingEdge(pulse);
  const rOuter = leadUs * pxPerUs;
  let rInner = trailUs * pxPerUs;
  if (rOuter <= 0) return;
  // Enforce a minimum visible thickness.
  rInner = Math.min(rInner, Math.max(0, rOuter - MIN_PULSE_PX));

  // Energy spreads over the wavefront, so fade with range (gentler than 1/r²
  // so it stays visible across the canvas).
  const fade = 1 / (1 + leadUs / (rangeUs * 0.6));

  // Filled annulus (outer arc clockwise, inner arc anticlockwise).
  ctx.beginPath();
  ctx.arc(emitter.x, emitter.y, rOuter, 0, Math.PI * 2, false);
  if (rInner > 0) ctx.arc(emitter.x, emitter.y, rInner, 0, Math.PI * 2, true);
  ctx.fillStyle = `rgba(62,230,168,${0.18 * fade})`;
  ctx.fill();

  // Leading-edge highlight.
  ctx.beginPath();
  ctx.arc(emitter.x, emitter.y, rOuter, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(62,230,168,${0.9 * fade})`;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Carrier stripes, phase-locked to distance from the emitter so they
  // appear to travel outward with the ring.
  const lambdaPx = carrierSpacingPx(pulse.frequency);
  ctx.strokeStyle = `rgba(62,230,168,${0.45 * fade})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let count = 0;
  const firstStripe = Math.floor(rOuter / lambdaPx) * lambdaPx;
  for (let r = firstStripe; r > rInner && count < MAX_STRIPES; r -= lambdaPx, count++) {
    if (r <= 0 || r >= rOuter) continue;
    ctx.moveTo(emitter.x + r, emitter.y);
    ctx.arc(emitter.x, emitter.y, r, 0, Math.PI * 2);
  }
  ctx.stroke();
}
