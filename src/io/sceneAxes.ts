// The one mapping from survey axes to scene axes.
//
// Source clouds are Z-up (X east, Y north, Z up). Three.js is Y-up.
// Rotating one to the other is a −90° rotation about X:
//
//     sceneX = east      sceneY = up      sceneZ = −north
//
// The negation is the whole point. Dropping it — (x, z, +y) — is a
// REFLECTION, not a rotation: it flips handedness and mirrors the cloud,
// so a road reads flipped against CloudCompare and any angle measured in
// the viewer comes out with the wrong sign. The octree decoder was fixed
// for exactly that; the TXT and LAS decoders kept the mirrored form, and
// nothing compared them because the two paths never meet at runtime.
//
// They still don't — the TXT and LAS point decoders are currently
// unreachable, the Rust importer having taken over conversion (see
// their file headers). This lives here so that if either is revived it
// cannot be revived mirrored.

/** Scene position for one point, given survey coordinates relative to
 *  the dataset origin. Writes into `out` at `i * 3`. */
export function writeScenePosition(
  out: Float32Array,
  i: number,
  east: number,
  north: number,
  up: number,
): void {
  const o = i * 3;
  out[o] = east;
  out[o + 1] = up;
  out[o + 2] = -north;
}

/** Same mapping as a tuple, for callers that are not filling a buffer. */
export function toSceneXYZ(
  east: number,
  north: number,
  up: number,
): [number, number, number] {
  return [east, up, -north];
}

/** The inverse: a scene position back to survey coordinates, with the
 *  dataset origin added — what a pick in the viewport has to go through
 *  before a backend command, which works in survey coordinates, receives
 *  it. The virtual caliper, click-to-measure, the scan-inspection
 *  viewpoint and the plot-boundary centre were all handed the scene
 *  point as it was: a stem clicked at (47, 21, −30) in the scene was
 *  looked for at easting 47, northing 21, elevation −30 — nowhere near
 *  the cloud — and every one of them found "0 points". */
export function sceneToWorld(
  scene: readonly [number, number, number],
  offset: readonly [number, number, number],
): [number, number, number] {
  return [scene[0] + offset[0], offset[1] - scene[2], scene[1] + offset[2]];
}
