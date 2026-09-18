// The cameras the figures are taken from, computed rather than
// held by hand.
//
// Registration is the whole point: a source-and-target pair must be the
// same camera, the same pixel dimensions and the same crop. Matched by
// eye the author's own panels agreed to within 2–4 px, which was luck
// and cost an hour a figure. A camera derived from the two clouds'
// shared bounding box is the same camera for both by construction, and
// the same one again six months from now.

import type { CameraPose } from '../three/comparePose';
import type { Vec3 } from '../three/comparePose';

export interface Box { min: Vec3; max: Vec3 }

/** The box that holds both, in whatever frame the caller has already
 *  put them — see heightBasesFor for a pair in two height frames. */
export function unionBox(boxes: Box[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      if (b.min[i] < min[i]) min[i] = b.min[i];
      if (b.max[i] > max[i]) max[i] = b.max[i];
    }
  }
  return { min, max };
}

/** How far a perspective camera must stand to fit `halfW` × `halfH` of
 *  world in a frame of this field of view and aspect, with `margin` of
 *  slack (1.08 = 8 % air around the subject). */
export function fitDistance(halfW: number, halfH: number, fovDeg: number, aspect: number, margin = 1.08): number {
  const t = Math.tan((fovDeg * Math.PI) / 180 / 2);
  return Math.max(halfH / t, halfW / (aspect * t)) * margin;
}

const FOV = 35;

/** Where the camera stands, as a compass bearing FROM the subject: 0 is
 *  due north of it looking south, 90 due east, 180 due south, 270 west.
 *  Elevation is the angle above the horizon: 0 is level — a side
 *  elevation — and 90 is straight down. Both are the user's to set;
 *  the named views below are the bearings people ask for most. */
export interface Direction { azimuth: number; elevation: number }

export function compass(azimuth: number): string {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const a = ((azimuth % 360) + 360) % 360;
  return names[Math.round(a / 45) % 8];
}

/** A camera at `dir` from the box, far enough that the box fits the
 *  frame. The distance is exact for any direction: the box's eight
 *  corners are projected onto the camera's own right and up axes, and
 *  the half-extents of that projection are what has to fit — rather than
 *  the box's width and height, which are only the right answer when the
 *  camera happens to be on an axis. */
export function orbitPose(box: Box, aspect: number, dir: Direction, fov = FOV, margin = 1.08): CameraPose {
  const c: Vec3 = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  const az = (dir.azimuth * Math.PI) / 180;
  const el = (Math.max(-90, Math.min(90, dir.elevation)) * Math.PI) / 180;
  // The unit vector from the subject towards the camera.
  const away: Vec3 = [
    Math.cos(el) * Math.sin(az),
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
  ];
  // Up: the world's up, except looking almost straight down, where it
  // is degenerate — then the horizontal bearing is what reads as up, so
  // a plan view from the south has north at the top.
  const nearVertical = Math.abs(dir.elevation) > 80;
  const worldUp: Vec3 = nearVertical ? [-Math.sin(az), -Math.cos(az), 0] : [0, 0, 1];
  // The camera's own right and up, for measuring the box against the
  // frame. The pose reports the WORLD up, which is what a camera is
  // given; these two are only the ruler.
  const fwd: Vec3 = [-away[0], -away[1], -away[2]];
  const right = normalise(cross(fwd, worldUp));
  const up = normalise(cross(right, fwd));
  let halfR = 0, halfU = 0, halfD = 0;
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) {
        const v: Vec3 = [x - c[0], y - c[1], z - c[2]];
        halfR = Math.max(halfR, Math.abs(dot(v, right)));
        halfU = Math.max(halfU, Math.abs(dot(v, up)));
        halfD = Math.max(halfD, Math.abs(dot(v, away)));
      }
    }
  }
  const d = fitDistance(halfR, halfU, fov, aspect, margin) + halfD;
  return {
    position: [c[0] + away[0] * d, c[1] + away[1] * d, c[2] + away[2] * d],
    target: c,
    up: normalise(worldUp),
    fov,
  };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function normalise(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** The directions people ask for by name. Each is a starting point: the
 *  bearing and the angle stay editable. */
export type ViewName = 'oblique' | 'side' | 'top';
export const VIEWS: { id: ViewName; label: string; dir: Direction; hint: string }[] = [
  { id: 'oblique', label: 'Oblique', dir: { azimuth: 135, elevation: 25 }, hint: 'From the south-east, 25° up — the general-purpose view.' },
  { id: 'side', label: 'Side elevation', dir: { azimuth: 180, elevation: 0 }, hint: 'Level, from the south. Shows stems and crown profile.' },
  { id: 'top', label: 'Plan (top-down)', dir: { azimuth: 180, elevation: 90 }, hint: 'Straight down, north up. For where things are rather than what they look like.' },
];

export function directionOf(view: ViewName): Direction {
  return (VIEWS.find((v) => v.id === view) ?? VIEWS[0]).dir;
}

/** The named view whose direction this is, when it is one of them. */
export function viewNameOf(dir: Direction): ViewName | null {
  const near = (a: number, b: number) => Math.abs(((a - b) % 360 + 540) % 360 - 180) < 0.5;
  for (const v of VIEWS) {
    if (Math.abs(v.dir.elevation - dir.elevation) < 0.5 && (dir.elevation > 80 || near(v.dir.azimuth, dir.azimuth))) return v.id;
  }
  return null;
}

/** A SIDE ELEVATION: level, from the south. */
export function sideElevationPose(box: Box, aspect: number, fov = FOV): CameraPose {
  return orbitPose(box, aspect, directionOf('side'), fov);
}

/** AN OBLIQUE: the three-quarter view, from the south-east and above. */
export function obliquePose(box: Box, aspect: number, fov = FOV): CameraPose {
  return orbitPose(box, aspect, directionOf('oblique'), fov);
}

/** STRAIGHT DOWN: a plan view, north up. */
export function topDownPose(box: Box, aspect: number, fov = FOV): CameraPose {
  return orbitPose(box, aspect, directionOf('top'), fov);
}

export function poseFor(view: ViewName, box: Box, aspect: number): CameraPose {
  return orbitPose(box, aspect, directionOf(view));
}

/** One tree's own frame: the isolate box, padded by the margin the user
 *  set, from whichever direction they chose. */
export function treePose(box: Box, aspect: number, marginM: number, dir: Direction = directionOf('oblique'), fov = FOV): CameraPose {
  const padded: Box = {
    min: [box.min[0] - marginM, box.min[1] - marginM, box.min[2]],
    max: [box.max[0] + marginM, box.max[1] + marginM, box.max[2]],
  };
  return orbitPose(padded, aspect, dir, fov);
}

/** The same camera, `factor` times as far from its subject: 1 is the
 *  fitted distance, 2 stands twice as far, 0.5 twice as close. The
 *  target, the bearing and the up vector do not move, so a pair or a
 *  comparison taken at another distance still registers — and it is
 *  applied AFTER the fit, so the fitted distance stays the one the box
 *  arithmetic derived and the user's choice is a plain multiple of it. */
export function standOff(pose: CameraPose, factor: number): CameraPose {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  if (f === 1) return pose;
  const [px, py, pz] = pose.position;
  const [tx, ty, tz] = pose.target;
  return {
    ...pose,
    position: [tx + (px - tx) * f, ty + (py - ty) * f, tz + (pz - tz) * f],
  };
}

/** The point size an export should use so apparent density stays what
 *  it is on screen as the figure scales up. A 1 px splat that reads
 *  correctly on a 900 px viewport disappears at 2400 px; this keeps the
 *  dot the same fraction of the frame, with a floor of one whole pixel
 *  and a ceiling that stops a small figure turning into blobs. */
export function figurePointSize(screenPointSize: number, screenHeight: number, figureHeight: number): number {
  const scaled = Math.max(1, screenPointSize) * (figureHeight / Math.max(1, screenHeight));
  return Math.min(12, Math.max(1, Math.round(scaled * 10) / 10));
}

/** A scale bar's length: a round number of metres that covers between a
 *  tenth and a third of the frame's width. */
export function scaleBarMetres(frameWidthM: number): number {
  const target = frameWidthM / 5;
  const steps = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
  let best = steps[0];
  for (const s of steps) if (s <= target) best = s;
  return best;
}
