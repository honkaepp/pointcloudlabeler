// A viewport click taken where it meets a plane, not on the
// point under it. The stem review clicks into the hollow of a stem's
// cross-section, where there is no point to pick, and onto the bark ring
// seen from straight above, where the nearest point may be one of a
// branch below.

import * as THREE from 'three';
import { sceneToWorld } from '../io/sceneAxes';

type V3 = [number, number, number];

/** A plane in world (survey) coordinates. */
export interface PickPlane { anchor: V3; normal: V3 }

/** The view ray of a click in world coordinates: from `a` (near plane) to
 *  `b` (far plane), and the ray through the pixel to its right (`a1`, `b1`),
 *  whose distance from the first at any point along it is a pixel there. */
export interface ViewRay { a: V3; b: V3; a1: V3; b1: V3 }

/** A drag in the viewport, handed over as view rays: `start` on
 *  the press (false: nothing taken, the press is ignored), `move` as the
 *  pointer moves, `end` on the release. Tree Review's pull-apart moves
 *  trees with it. */
export interface WorldDrag {
  start: (r: ViewRay) => boolean;
  move: (r: ViewRay) => void;
  end: () => void;
}

/** A world picker; with `plane`, the viewport hands it the click where the
 *  view ray meets that plane instead of the point under the cursor; with
 *  `drag`, the viewport hands it whole drags instead of clicks. */
export type WorldPicker = ((hit: V3) => void) & { plane?: PickPlane; drag?: WorldDrag };

/** A world picker that takes drags, not clicks. */
export function dragPicker(drag: WorldDrag): WorldPicker {
  return Object.assign(() => {}, { drag });
}

/** A world picker that takes its clicks on `plane`. */
export function planePicker(plane: PickPlane, cb: (hit: V3) => void): WorldPicker {
  return Object.assign((hit: V3) => cb(hit), { plane });
}

/** Where the line through `a` and `b` meets the plane; null when it runs
 *  along it. */
export function rayPlane(a: V3, b: V3, plane: PickPlane): V3 | null {
  const d: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const n = plane.normal;
  const den = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
  if (Math.abs(den) < 1e-12) return null;
  const t = (n[0] * (plane.anchor[0] - a[0]) + n[1] * (plane.anchor[1] - a[1]) + n[2] * (plane.anchor[2] - a[2])) / den;
  return [a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]];
}

/** The click at canvas pixel (`x`, `y`) of a `w` × `h` canvas, through
 *  `camera` (perspective or parallel: its own projection is inverted), on
 *  `plane`; world coordinates. */
export function pickOnPlane(camera: THREE.Camera, x: number, y: number, w: number, h: number, plane: PickPlane, offset: readonly [number, number, number]): V3 | null {
  const r = viewRay(camera, x, y, w, h, offset);
  return rayPlane(r.a, r.b, plane);
}

/** The view ray of canvas pixel (`x`, `y`), world coordinates. */
export function viewRay(camera: THREE.Camera, x: number, y: number, w: number, h: number, offset: readonly [number, number, number]): ViewRay {
  const at = (px: number) => {
    const nx = (px / Math.max(1, w)) * 2 - 1, ny = 1 - (y / Math.max(1, h)) * 2;
    const p0 = new THREE.Vector3(nx, ny, -1).unproject(camera);
    const p1 = new THREE.Vector3(nx, ny, 1).unproject(camera);
    return [sceneToWorld([p0.x, p0.y, p0.z], offset), sceneToWorld([p1.x, p1.y, p1.z], offset)] as const;
  };
  const [a, b] = at(x), [a1, b1] = at(x + 1);
  return { a, b, a1, b1 };
}

