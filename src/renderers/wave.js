/**
 * Sine-wave renderer.
 *
 * Each in-flight pulse is drawn as a burst of carrier cycles travelling along
 * the straight line from emitter to sensor. The burst's length is the pulse
 * width (with a minimum on-screen length so nanosecond pulses stay visible),
 * the cycle spacing is a stylised function of carrier frequency (see
 * carrierSpacingPx), and the phase is locked to distance from the emitter so
 * the waveform visibly moves with the pulse. Pulses are absorbed at the sensor.
 *
 * The beam follows the sensor's current position (a tracking radar), so with
 * a moving sensor the line rotates; pulses already in flight rotate with it.
 */
import {
  clear, drawGrid, drawOrbitPath, drawEmitter, drawSensor, drawHitEffect,
  drawPulseTrainStrip, carrierSpacingPx, MIN_PULSE_PX, COLORS,
} from './common.js';

const AMPLITUDE = 32; // px
const SAMPLE_PX = 2;  // sampling resolution along the beam

export function render(ctx, layout, sim) {
  clear(ctx, layout);
  drawGrid(ctx, layout);
  drawOrbitPath(ctx, layout);

  const { emitter, sensor, rangeUs, pxPerUs } = layout;

  // Unit vector along the beam and its normal (for the sine displacement).
  const distPx = Math.hypot(sensor.x - emitter.x, sensor.y - emitter.y) || 1;
  const beam = {
    ux: (sensor.x - emitter.x) / distPx,
    uy: (sensor.y - emitter.y) / distPx,
  };
  beam.nx = -beam.uy;
  beam.ny = beam.ux;

  // Pulses past the sensor are absorbed; no need to keep them around.
  sim.maxRange = rangeUs + MIN_PULSE_PX / pxPerUs;

  // Beam baseline.
  ctx.strokeStyle = 'rgba(62,230,168,0.12)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(emitter.x, emitter.y);
  ctx.lineTo(sensor.x, sensor.y);
  ctx.stroke();
  ctx.setLineDash([]);

  for (const p of sim.pulses) {
    const leadUs = Math.min(sim.leadingEdge(p), rangeUs);
    const trailUs = sim.trailingEdge(p);
    if (trailUs >= rangeUs) continue; // fully absorbed
    drawPulse(ctx, layout, beam, p, leadUs, trailUs);
  }

  const intensity = sim.sensorIntensity(rangeUs);
  drawEmitter(ctx, layout, sim);
  drawSensor(ctx, layout, intensity);
  drawHitEffect(ctx, layout, sim);
  drawPulseTrainStrip(ctx, layout, sim);
}

function drawPulse(ctx, layout, beam, pulse, leadUs, trailUs) {
  const { emitter, pxPerUs, nominalRangeUs } = layout;
  const d1 = leadUs * pxPerUs;
  let d0 = trailUs * pxPerUs;
  // Enforce a minimum visible length (short pulses would otherwise be sub-pixel).
  if (d1 - d0 < MIN_PULSE_PX) d0 = Math.max(0, d1 - MIN_PULSE_PX);
  const lengthPx = d1 - d0;
  if (lengthPx < 1) return;

  const lambdaPx = carrierSpacingPx(pulse.frequency);
  const k = (2 * Math.PI) / lambdaPx; // radians per px

  // Amplitude falls off gently with range so distant pulses look weaker.
  const rangeFade = 1 / (1 + leadUs / nominalRangeUs);

  ctx.beginPath();
  for (let d = d0; d <= d1; d += SAMPLE_PX) {
    const posInPulse = (d1 - d) / lengthPx; // 0 at leading edge, 1 at trailing
    const off = Math.sin(k * d) * AMPLITUDE * envelope(posInPulse) * rangeFade;
    const x = emitter.x + beam.ux * d + beam.nx * off;
    const y = emitter.y + beam.uy * d + beam.ny * off;
    if (d === d0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }

  // Soft glow pass, then crisp line.
  ctx.strokeStyle = 'rgba(62,230,168,0.25)';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.strokeStyle = COLORS.pulse;
  ctx.lineWidth = 1.8;
  ctx.stroke();
}

/** Smooth ramp at both ends of the pulse so it does not start/stop abruptly. */
function envelope(t) {
  const edge = 0.12;
  if (t < 0 || t > 1) return 0;
  if (t < edge) return smoothstep(t / edge);
  if (t > 1 - edge) return smoothstep((1 - t) / edge);
  return 1;
}

function smoothstep(t) {
  return t * t * (3 - 2 * t);
}
