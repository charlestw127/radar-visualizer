/**
 * Builds the slider panel from PARAM_SPECS and keeps it in sync with Params.
 *
 * Specs with `scale: 'log'` get a logarithmic slider: the <input> runs
 * 0..SLIDER_STEPS and is mapped to the spec's [min, max] exponentially, so a
 * 1 µs – 10 ms range is equally easy to drive at both ends.
 */
import {
  PARAM_SPECS, fmtSig, fmtFrequencyHz, fmtTimeUs, fmtDistanceM,
} from './params.js';

const SLIDER_STEPS = 1000;

function toSlider(spec, v) {
  if (spec.scale !== 'log') return v;
  return Math.round(SLIDER_STEPS * Math.log(v / spec.min) / Math.log(spec.max / spec.min));
}

function fromSlider(spec, pos) {
  if (spec.scale !== 'log') return Number(pos);
  return spec.min * Math.pow(spec.max / spec.min, Number(pos) / SLIDER_STEPS);
}

/**
 * @param {HTMLElement} container element to fill with sliders
 * @param {HTMLElement} readoutEl <dl> element for derived values
 * @param {import('./params.js').Params} params
 */
export function buildControls(container, readoutEl, params) {
  const inputs = {};

  for (const [key, spec] of Object.entries(PARAM_SPECS)) {
    const wrap = document.createElement('div');
    wrap.className = 'control';

    const labelRow = document.createElement('div');
    labelRow.className = 'label-row';
    const name = document.createElement('label');
    name.textContent = spec.label;
    name.htmlFor = `param-${key}`;
    const value = document.createElement('span');
    value.className = 'value';
    labelRow.append(name, value);

    const input = document.createElement('input');
    input.type = 'range';
    input.id = `param-${key}`;
    if (spec.scale === 'log') {
      input.min = 0;
      input.max = SLIDER_STEPS;
      input.step = 1;
    } else {
      input.min = spec.min;
      input.max = spec.max;
      input.step = spec.step ?? 'any';
    }
    input.value = toSlider(spec, params.get(key));
    input.addEventListener('input', () => params.set(key, fromSlider(spec, input.value)));

    wrap.append(labelRow, input);
    container.append(wrap);
    inputs[key] = { input, value, spec };
  }

  const readouts = [
    ['PRF', () => fmtFrequencyHz(params.prfHz)],
    ['Duty cycle', () => `${fmtSig(params.dutyCycle * 100)} %`],
    ['Band', () => params.band],
    ['Wavelength', () => fmtDistanceM(params.wavelengthM)],
    ['Pulse length', () => fmtDistanceM(params.pulseLengthM)],
    ['Unambiguous range', () => `${fmtSig(params.unambiguousRangeKm)} km`],
    ['Range transit time', () => fmtTimeUs(params.rangeUs)],
    ['Slow-motion', () => `×${Math.round(params.slowMotionFactor).toLocaleString()}`],
  ];
  const readoutValues = readouts.map(([label]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    readoutEl.append(dt, dd);
    return dd;
  });

  function sync() {
    for (const [key, { input, value, spec }] of Object.entries(inputs)) {
      const v = params.get(key);
      // Params may have clamped a value (e.g. pulse width vs PRI); reflect it.
      const pos = toSlider(spec, v);
      if (Number(input.value) !== pos) input.value = pos;
      value.textContent = spec.format(v);
    }
    readouts.forEach(([, fn], i) => { readoutValues[i].textContent = fn(); });
  }

  params.subscribe(sync);
  sync();
}
