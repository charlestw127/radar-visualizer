/**
 * Drawing helpers shared by both renderers: background, emitter, sensor,
 * hit effect, and the pulse-train strip.
 */

import { fmtTimeUs } from '../params.js';

/** Minimum on-screen length/thickness of a pulse, so ns pulses stay visible. */
export const MIN_PULSE_PX = 10;

/**
 * On-screen spacing between carrier cycles, in px, as a function of carrier
 * frequency in MHz. Real wavelengths (3 m at 100 MHz, 7.5 mm at 40 GHz) are
 * far below a pixel at tens of km per canvas, so this is a stylised log
 * mapping: higher frequency → visibly tighter cycles, never sub-pixel.
 */
export function carrierSpacingPx(freqMHz) {
  const F_LO = 100, F_HI = 40000;   // MHz
  const PX_LO = 48, PX_HI = 5;      // px
  const t = Math.log(freqMHz / F_LO) / Math.log(F_HI / F_LO);
  const clamped = Math.min(1, Math.max(0, t));
  return PX_LO * Math.pow(PX_HI / PX_LO, clamped);
}

export const COLORS = {
  grid: 'rgba(255,255,255,0.04)',
  emitter: '#ffb454',
  sensor: '#3ee6a8',
  pulse: '#3ee6a8',
  pulseDim: 'rgba(62,230,168,0.35)',
  hit: '#ffffff',
  text: '#7f91a3',
};

export function clear(ctx, layout) {
  ctx.fillStyle = '#0b0f14';
  ctx.fillRect(0, 0, layout.width, layout.height);
}

export function drawGrid(ctx, layout) {
  const { main } = layout;
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  const step = 40;
  ctx.beginPath();
  for (let x = step; x < main.w; x += step) {
    ctx.moveTo(x, main.y);
    ctx.lineTo(x, main.y + main.h);
  }
  for (let y = step; y < main.h; y += step) {
    ctx.moveTo(main.x, y);
    ctx.lineTo(main.x + main.w, y);
  }
  ctx.stroke();
}

export function drawEmitter(ctx, layout, sim) {
  const { emitter } = layout;
  // Brief flash while a pulse is leaving the antenna (held for at least a
  // few frames so nanosecond pulses still register).
  let tx = 0;
  for (const p of sim.pulses) {
    const age = sim.time - p.tEmit;
    if (age >= 0 && age <= sim.visibleUs(p.pulseWidth, 0.08)) tx = 1;
  }

  ctx.save();
  ctx.translate(emitter.x, emitter.y);

  if (tx) {
    ctx.fillStyle = 'rgba(255,180,84,0.25)';
    ctx.beginPath();
    ctx.arc(0, 0, 26, 0, Math.PI * 2);
    ctx.fill();
  }

  // Antenna: a short mast, then a concave dish (with feed at the focus)
  // rotated to point at the sensor, so it tracks a moving one.
  ctx.strokeStyle = COLORS.emitter;
  ctx.fillStyle = COLORS.emitter;
  ctx.lineCap = 'round';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-4, 2);
  ctx.lineTo(-4, 22);
  ctx.stroke();

  const { sensor } = layout;
  ctx.rotate(Math.atan2(sensor.y - emitter.y, sensor.x - emitter.x));
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(12, 0, 16, Math.PI * 0.68, Math.PI * 1.32);
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-4, 0);
  ctx.lineTo(4, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(4, 0, 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
  label(ctx, 'EMITTER', emitter.x, emitter.y + 34, COLORS.emitter);
}

export function drawSensor(ctx, layout, intensity) {
  const { sensor } = layout;
  ctx.save();
  ctx.translate(sensor.x, sensor.y);

  // Glow scales with illumination intensity, dimmed by path loss (1/R²)
  // when the sensor is moving; floor keeps distant hits visible.
  const glow = intensity * (0.35 + 0.65 * (layout.pathGain ?? 1));
  if (glow > 0.01) {
    const grad = ctx.createRadialGradient(0, 0, 4, 0, 0, 40);
    grad.addColorStop(0, `rgba(255,255,255,${0.7 * glow})`);
    grad.addColorStop(0.4, `rgba(62,230,168,${0.45 * glow})`);
    grad.addColorStop(1, 'rgba(62,230,168,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, 40, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sensor body: small diamond.
  ctx.fillStyle = intensity > 0.5 ? COLORS.hit : COLORS.sensor;
  ctx.beginPath();
  ctx.moveTo(0, -12);
  ctx.lineTo(12, 0);
  ctx.lineTo(0, 12);
  ctx.lineTo(-12, 0);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
  label(ctx, 'SENSOR', sensor.x, sensor.y + 34, COLORS.sensor);
}

/**
 * Orbit path and velocity vector for a moving sensor (no-op when fixed).
 * Draw before the pulses so it sits underneath them.
 */
export function drawOrbitPath(ctx, layout) {
  const { orbit, sensor } = layout;
  if (!orbit) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(127,145,163,0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 7]);
  ctx.beginPath();
  ctx.arc(orbit.cx, orbit.cy, orbit.r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  // Velocity arrow along the tangent; colour hints closing (green) / opening (amber).
  const closing = layout.radialVelocity > 0;
  const len = 30;
  const tx = orbit.tangent.x;
  const ty = orbit.tangent.y;
  const hx = sensor.x + tx * len;
  const hy = sensor.y + ty * len;
  ctx.strokeStyle = closing ? 'rgba(62,230,168,0.8)' : 'rgba(255,180,84,0.8)';
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(sensor.x + tx * 14, sensor.y + ty * 14);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(hx + tx * 7, hy + ty * 7);
  ctx.lineTo(hx - ty * 4, hy + tx * 4);
  ctx.lineTo(hx + ty * 4, hy - tx * 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Expanding shock-ring at the sensor, triggered on each new hit.
 * Duration is in simulated µs so it slows down with the time scale.
 */
export function drawHitEffect(ctx, layout, sim) {
  const age = sim.time - sim.lastHitTime;
  const duration = sim.hitBurstUs;
  if (age < 0 || age > duration) return;

  const t = age / duration;
  const { sensor } = layout;
  const radius = 14 + t * 50;
  const alpha = (1 - t) * 0.9;

  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
  ctx.lineWidth = 3 * (1 - t) + 0.5;
  ctx.beginPath();
  ctx.arc(sensor.x, sensor.y, radius, 0, Math.PI * 2);
  ctx.stroke();

  // Spokes radiating out for a "ping" feel.
  ctx.strokeStyle = `rgba(62,230,168,${alpha * 0.8})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + t * 0.5;
    const r0 = radius * 0.7;
    const r1 = radius * 0.95;
    ctx.moveTo(sensor.x + Math.cos(a) * r0, sensor.y + Math.sin(a) * r0);
    ctx.lineTo(sensor.x + Math.cos(a) * r1, sensor.y + Math.sin(a) * r1);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Bottom strip: transmitted pulse train vs time, right edge = now.
 * Makes PRI / pulse width / duty cycle legible at a glance.
 */
export function drawPulseTrainStrip(ctx, layout, sim) {
  const { strip } = layout;
  const pri = sim.params.get('pri');
  const windowUs = pri * 6; // always show ~6 PRIs so duty cycle reads the same at any PRF
  const usToX = (t) => strip.x + strip.w - ((sim.time - t) / windowUs) * strip.w;

  ctx.save();
  ctx.fillStyle = '#0e131a';
  ctx.fillRect(strip.x, strip.y, strip.w, strip.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.moveTo(strip.x, strip.y + 0.5);
  ctx.lineTo(strip.x + strip.w, strip.y + 0.5);
  ctx.stroke();

  const baseY = strip.y + strip.h * 0.68;
  const topY = strip.y + strip.h * 0.28;

  // Baseline
  ctx.strokeStyle = COLORS.pulseDim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(strip.x, baseY);
  ctx.lineTo(strip.x + strip.w, baseY);
  ctx.stroke();

  // Pulses (rectangular envelope), from emission history so bars persist
  // after the pulse itself has been culled from the scene.
  ctx.fillStyle = 'rgba(62,230,168,0.35)';
  ctx.strokeStyle = COLORS.pulse;
  for (const p of sim.history) {
    const x0 = usToX(p.tEmit);
    const x1 = usToX(Math.min(sim.time, p.tEmit + p.pulseWidth));
    if (x1 < strip.x) continue;
    const w = Math.max(1, x1 - x0);
    ctx.fillRect(x0, topY, w, baseY - topY);
    ctx.strokeRect(x0 + 0.5, topY + 0.5, w, baseY - topY);
  }

  // Ticks every PRI, labelled from the most recent emission.
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  for (let t = sim.lastEmit; t > sim.time - windowUs && isFinite(t); t -= pri) {
    const x = usToX(t);
    ctx.beginPath();
    ctx.moveTo(x, baseY);
    ctx.lineTo(x, baseY + 6);
    ctx.stroke();
  }

  ctx.textAlign = 'left';
  ctx.fillText(
    `TX pulse train — window ${fmtTimeUs(windowUs)} · t = ${fmtTimeUs(sim.time)} · hits: ${sim.hitCount}`,
    strip.x + 10,
    strip.y + 16,
  );
  ctx.restore();
}

function label(ctx, text, x, y, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.letterSpacing = '0.1em';
  ctx.fillText(text, x, y);
  ctx.restore();
}
