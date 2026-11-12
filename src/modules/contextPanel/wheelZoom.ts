/**
 * Zoom speed shared by the Mermaid / SVG window and the large figure view, so
 * a wheel turn or a pinch zooms the same amount in both.
 */

/** What + and − add or take away (25 percentage points). */
export const ZOOM_BUTTON_STEP = 0.25;
const WHEEL_ZOOM_DELTA_MAX = 24;
const WHEEL_ZOOM_SENSITIVITY = 0.002;

/**
 * The scale after one wheel event. Only `deltaY` is read: in Gecko, reading
 * `deltaMode` first turns a trackpad's pixel deltas into tiny line deltas.
 */
export function getWheelZoomScale(scale: number, deltaY: number): number {
  const boundedDelta = Math.min(
    WHEEL_ZOOM_DELTA_MAX,
    Math.max(-WHEEL_ZOOM_DELTA_MAX, deltaY),
  );
  return scale * Math.exp(-boundedDelta * WHEEL_ZOOM_SENSITIVITY);
}
