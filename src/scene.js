/**
 * Scene layout: where the emitter and sensor sit on the canvas, and the
 * mapping between simulation distance (light-µs) and pixels.
 *
 * Two layouts share one shape: computeLayout (emitter left, sensor/target
 * right — beam and monostatic-radar modes) and computeCentredLayout (radar
 * at the centre of a circular arena — the PPI modes).
 */

/** Height reserved at the bottom of the canvas for the pulse-train strip. */
const STRIP_HEIGHT = 90;

/**
 * @param {number} width   canvas width in CSS px
 * @param {number} height  canvas height in CSS px
 * @param {number} rangeUs emitter→sensor distance in light-µs
 */
export function computeLayout(width, height, rangeUs) {
  const mainHeight = height - STRIP_HEIGHT;
  const emitter = { x: width * 0.14, y: mainHeight * 0.5 };
  const sensor = { x: width * 0.86, y: mainHeight * 0.5 };
  const distancePx = sensor.x - emitter.x;

  return {
    width,
    height,
    emitter,
    sensor,
    distancePx,
    rangeUs,          // live emitter→sensor range (SensorMotion may overwrite)
    nominalRangeUs: rangeUs, // the slider value; use for anything that must not breathe with motion
    pxPerUs: distancePx / rangeUs,
    main: { x: 0, y: 0, w: width, h: mainHeight },
    strip: { x: 0, y: mainHeight, w: width, h: STRIP_HEIGHT },
  };
}

/**
 * Radar-at-centre layout for the PPI modes: `rangeUs` is the ARENA RADIUS,
 * mapped to the largest circle that fits above the strip.
 * @param {number} width   canvas width in CSS px
 * @param {number} height  canvas height in CSS px
 * @param {number} rangeUs arena radius in light-µs
 */
export function computeCentredLayout(width, height, rangeUs) {
  const mainHeight = height - STRIP_HEIGHT;
  const emitter = { x: width * 0.5, y: mainHeight * 0.5 };
  const radiusPx = Math.max(40, Math.min(width, mainHeight) / 2 - 26);

  return {
    width,
    height,
    emitter,
    sensor: { x: emitter.x, y: emitter.y }, // monostatic: RX is the TX
    distancePx: radiusPx,
    rangeUs,
    nominalRangeUs: rangeUs,
    pxPerUs: radiusPx / rangeUs,
    main: { x: 0, y: 0, w: width, h: mainHeight },
    strip: { x: 0, y: mainHeight, w: width, h: STRIP_HEIGHT },
  };
}
