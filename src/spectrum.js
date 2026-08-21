/**
 * Spectrum panel: the power spectrum of the current pulse train, drawn the
 * way a spectrum analyser at the sensor would show it.
 *
 * A rectangular pulse of width τ has a sinc² envelope, |sin(πfτ)/(πfτ)|²,
 * with nulls every 1/τ either side of the carrier. A coherent train of such
 * pulses at interval PRI is a line spectrum: discrete lines spaced 1/PRI
 * (the PRF) under that envelope. When the lines are closer together than a
 * few pixels at the chosen span they are drawn as a filled envelope instead,
 * and the caption says so — exactly what a real analyser does when its
 * resolution bandwidth is wider than the PRF.
 *
 * The spectrum is analytic, computed from the live waveform parameters (it is
 * a property of what the emitter is transmitting now). The noise floor is
 * cosmetic, and the trace brightens with the sensor's live illumination.
 */
import { fmtFrequencyHz, fmtFrequencyMHz } from './params.js';

const DB_FLOOR = -60;
const LOBES = 4;            // span = ±LOBES/τ around the carrier
const NOISE_DB = -52;
const MIN_LINE_PX = 3;      // PRF lines closer than this are "unresolved"
const PAD = { left: 30, right: 8, top: 20, bottom: 32 };

export class SpectrumView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0;
    this.h = 0;
    this.noise = [];
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  /**
   * @param {import('./params.js').Params} params
   * @param {import('./simulation.js').Simulation} sim
   */
  draw(params, sim) {
    const { ctx, w, h } = this;
    if (!w || !h) return;

    const tau = params.get('pulseWidth');   // µs
    const pri = params.get('pri');          // µs
    const fc = params.get('frequency');     // MHz
    const prf = 1 / pri;                    // MHz
    const span = (2 * LOBES) / tau;         // MHz, total width shown

    const plot = {
      x: PAD.left, y: PAD.top,
      w: w - PAD.left - PAD.right, h: h - PAD.top - PAD.bottom,
    };
    const cols = Math.max(1, Math.floor(plot.w));
    const dbToY = (db) => plot.y + (db / DB_FLOOR) * plot.h;
    const offToX = (fMHz) => plot.x + (fMHz / span + 0.5) * plot.w;
    const envDb = (fMHz) => {
      const x = Math.PI * fMHz * tau;
      const s = x === 0 ? 1 : Math.sin(x) / x;
      return Math.max(DB_FLOOR, 20 * Math.log10(Math.abs(s) + 1e-9));
    };

    // Cosmetic noise floor: per-column values that drift, frozen when paused.
    if (this.noise.length !== cols) {
      this.noise = Array.from({ length: cols }, () => NOISE_DB);
    }
    if (sim.running) {
      for (let i = 0; i < cols; i++) {
        const target = NOISE_DB + (Math.random() - 0.5) * 8;
        this.noise[i] += (target - this.noise[i]) * 0.15;
      }
    }

    // Background + dB grid.
    ctx.fillStyle = '#0e131a';
    ctx.fillRect(0, 0, w, h);
    ctx.font = '9px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let db = 0; db >= DB_FLOOR; db -= 10) {
      const y = Math.round(dbToY(db)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.w, y);
      ctx.stroke();
      ctx.fillStyle = '#7f91a3';
      ctx.fillText(`${db}`, plot.x - 4, y);
    }

    // Noise trace.
    ctx.beginPath();
    ctx.moveTo(plot.x, plot.y + plot.h);
    for (let i = 0; i < cols; i++) {
      ctx.lineTo(plot.x + i, dbToY(this.noise[i]));
    }
    ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
    ctx.closePath();
    ctx.fillStyle = 'rgba(127,145,163,0.18)';
    ctx.fill();

    // Signal.
    const alpha = 0.45 + 0.55 * sim.lastIntensity;
    const linePx = (plot.w * prf) / span;
    const resolved = linePx >= MIN_LINE_PX;

    if (resolved) {
      // Dashed envelope, then one line per PRF harmonic under it.
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = `rgba(62,230,168,${0.35 * alpha})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < cols; i++) {
        const y = dbToY(envDb((i / cols - 0.5) * span));
        if (i === 0) ctx.moveTo(plot.x + i, y);
        else ctx.lineTo(plot.x + i, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      const K = Math.floor(span / 2 / prf);
      ctx.strokeStyle = `rgba(62,230,168,${alpha})`;
      ctx.lineWidth = Math.min(2, Math.max(1, linePx * 0.3));
      ctx.beginPath();
      for (let k = -K; k <= K; k++) {
        const f = k * prf;
        const x = Math.round(offToX(f)) + 0.5;
        const i = Math.min(cols - 1, Math.max(0, Math.round(x - plot.x)));
        const top = dbToY(envDb(f));
        const base = dbToY(this.noise[i]);
        if (top >= base) continue;
        ctx.moveTo(x, base);
        ctx.lineTo(x, top);
      }
      ctx.stroke();
    } else {
      // Unresolved lines merge into the continuous envelope.
      ctx.beginPath();
      ctx.moveTo(plot.x, plot.y + plot.h);
      for (let i = 0; i < cols; i++) {
        const db = Math.max(envDb((i / cols - 0.5) * span), this.noise[i]);
        ctx.lineTo(plot.x + i, dbToY(db));
      }
      ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
      ctx.closePath();
      ctx.fillStyle = `rgba(62,230,168,${0.22 * alpha})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(62,230,168,${alpha})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < cols; i++) {
        const db = Math.max(envDb((i / cols - 0.5) * span), this.noise[i]);
        const y = dbToY(db);
        if (i === 0) ctx.moveTo(plot.x + i, y);
        else ctx.lineTo(plot.x + i, y);
      }
      ctx.stroke();
    }

    // Carrier marker.
    const xc = Math.round(offToX(0)) + 0.5;
    ctx.strokeStyle = 'rgba(255,180,84,0.5)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(xc, plot.y);
    ctx.lineTo(xc, plot.y + plot.h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Header and axis labels.
    ctx.fillStyle = '#7f91a3';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(`fc ${fmtFrequencyMHz(fc)} · span ${fmtOffset(span)} · dB`, plot.x, 13);

    const ly = plot.y + plot.h + 12;
    ctx.textAlign = 'left';
    ctx.fillText(`−${fmtOffset(span / 2)}`, plot.x, ly);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffb454';
    ctx.fillText('fc', xc, ly);
    ctx.fillStyle = '#7f91a3';
    ctx.textAlign = 'right';
    ctx.fillText(`+${fmtOffset(span / 2)}`, plot.x + plot.w, ly);

    ctx.textAlign = 'left';
    ctx.fillText(
      `null–null 2/τ ${fmtOffset(2 / tau)} · 3 dB ${fmtOffset(0.886 / tau)} · PRF lines ${fmtOffset(prf)}${resolved ? '' : ' (unresolved)'}`,
      plot.x - PAD.left + 6, ly + 13,
    );
  }
}

/** Format a frequency offset given in MHz with an auto unit. */
function fmtOffset(mhz) {
  return fmtFrequencyHz(mhz * 1e6);
}
