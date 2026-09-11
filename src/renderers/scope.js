/**
 * scope.js — the A-scope: received amplitude vs apparent range, drawn in the
 * bottom strip in the radar / hunt / battle modes (replacing the TX pulse
 * train strip, which stays in beam mode).
 *
 * The x axis spans one full PRI of round trip (0 … c·PRI/2), so second-time-
 * around echoes fold onto it with zero extra machinery — exactly where the
 * radar believes them to be. Blips are the radar's released paints (they
 * appear when the animated echo lands, thanks to the paint-delay queue) and
 * fade like phosphor. The main-bang block at the left is the blind range
 * cτ/2; barrage jamming raises the whole noise floor.
 */
import { fmtSig, fmtTimeUs, C_M_PER_US } from '../params.js';
import { RF } from '../rf.js';
import { COLORS } from './common.js';

const DB_SPAN = 40;         // vertical scale: 0 (noise) … +40 dB
const NOISE_JITTER_DB = 2.5;

// Per-strip noise ribbon state (frozen when paused), keyed by column count.
let noiseCols = [];

export function drawAScope(ctx, layout, sim, radar, params) {
  const { strip } = layout;
  const priUs = params.get('pri');
  const tauUs = params.get('pulseWidth');
  const spanUs = priUs / 2;                 // apparent-range window
  const spanKm = (spanUs * C_M_PER_US) / 1000;
  const usToX = (us) => strip.x + (us / spanUs) * strip.w;
  const baseY = strip.y + strip.h - 14;
  const dbToY = (db) => baseY - (Math.max(0, Math.min(DB_SPAN, db)) / DB_SPAN) * (strip.h - 34);

  ctx.save();
  ctx.lineWidth = 1; // don't inherit a beam renderer's line width
  ctx.fillStyle = '#0e131a';
  ctx.fillRect(strip.x, strip.y, strip.w, strip.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.moveTo(strip.x, strip.y + 0.5);
  ctx.lineTo(strip.x + strip.w, strip.y + 0.5);
  ctx.stroke();

  // Jamming lifts the whole floor (barrage noise is range-less).
  const jnDb = Math.max(0, radar.lastDwell?.jnDb ?? 0);
  const floorDb = Math.min(DB_SPAN * 0.75, jnDb);

  // Noise ribbon (per-column drift, frozen on pause).
  const cols = Math.max(2, Math.floor(strip.w / 3));
  if (noiseCols.length !== cols) noiseCols = Array.from({ length: cols }, () => 0);
  if (sim.running) {
    for (let i = 0; i < cols; i++) {
      const target = (Math.random() - 0.3) * NOISE_JITTER_DB;
      noiseCols[i] += (target - noiseCols[i]) * 0.25;
    }
  }
  ctx.beginPath();
  ctx.moveTo(strip.x, baseY);
  for (let i = 0; i < cols; i++) {
    ctx.lineTo(strip.x + (i / (cols - 1)) * strip.w, dbToY(floorDb + Math.max(0, noiseCols[i])));
  }
  ctx.lineTo(strip.x + strip.w, baseY);
  ctx.closePath();
  ctx.fillStyle = jnDb > 3 ? 'rgba(255,92,122,0.30)' : 'rgba(127,145,163,0.25)';
  ctx.fill();

  // Main bang / blind range: 0 … cτ/2.
  const blindX = usToX(Math.min(spanUs, tauUs / 2));
  ctx.fillStyle = 'rgba(255,180,84,0.20)';
  ctx.fillRect(strip.x, strip.y + 12, blindX - strip.x, baseY - strip.y - 12);

  // Detection threshold.
  const threshY = dbToY(floorDb + RF.THRESH_DB);
  ctx.strokeStyle = 'rgba(255,180,84,0.5)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(strip.x, threshY);
  ctx.lineTo(strip.x + strip.w, threshY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Blips: released paints, phosphor-fading, width ≥ the pulse resolution.
  // plot.snrDb is measured above the TOTAL interference floor, so blips ride
  // on top of the (possibly jam-raised) drawn floor — a burn-through blip
  // pokes above the noise exactly as it did in the receiver.
  for (const p of radar.plots) {
    const rUs = (p.rangeKm * 1000) / C_M_PER_US;
    if (rUs > spanUs) continue;
    const x = usToX(rUs);
    const wPx = Math.max(2, (tauUs / 2 / spanUs) * strip.w);
    const a = Math.max(0, Math.min(1, p.lifeS / 4));
    const topY = dbToY(floorDb + p.snrDb);
    ctx.fillStyle = p.falseAlarm
      ? `rgba(127,145,163,${0.7 * a})`
      : `rgba(62,230,168,${0.85 * a})`;
    ctx.beginPath();
    ctx.moveTo(x - wPx, baseY);
    ctx.quadraticCurveTo(x, topY - (baseY - topY) * 0.2, x + wPx, baseY);
    ctx.closePath();
    ctx.fill();
    if (p.ambiguous && a > 0.4) {
      ctx.fillStyle = `rgba(255,180,84,${a})`;
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('2nd?', x, topY - 4);
    }
  }

  // Axis: range labels every quarter span.
  ctx.fillStyle = COLORS.text;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const x = strip.x + (i / 4) * strip.w;
    ctx.fillText(`${fmtSig(spanKm * (i / 4))}`, Math.min(strip.x + strip.w - 14, Math.max(strip.x + 10, x)), strip.y + strip.h - 3);
  }

  ctx.textAlign = 'left';
  ctx.fillText(
    `A-scope — apparent range 0…${fmtSig(spanKm)} km (one PRI of round trip = ${fmtTimeUs(priUs)})`
    + `${jnDb > 3 ? ` · JAMMED +${jnDb.toFixed(0)} dB` : ''} · blind < ${fmtSig((tauUs / 2) * C_M_PER_US / 1000)} km`,
    strip.x + 10, strip.y + 16,
  );
  ctx.restore();
}
