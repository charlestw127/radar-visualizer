/**
 * Scene layout: where the emitter and sensor sit on the canvas, and the
 * mapping between simulation distance (light-µs) and pixels.
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
    rangeUs,
    pxPerUs: distancePx / rangeUs,
    main: { x: 0, y: 0, w: width, h: mainHeight },
    strip: { x: 0, y: mainHeight, w: width, h: STRIP_HEIGHT },
  };
}
