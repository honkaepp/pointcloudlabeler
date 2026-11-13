// Branch measurement — the geometry behind the Branches panel.
//
// A branch is a set of points the user has cut out of a tree by hand.
// Two things are measured on it, both the way a person in the field
// would measure them:
//
//   DIAMETER, as calipers take it. A thin section is cut across the
//   branch at the place the user points at, perpendicular to the
//   branch's own local axis (not to the vertical: a branch leaves the
//   stem at any angle). The section's points are laid out in that
//   plane, and a caliper reading in a direction θ is the distance
//   between two jaws closed onto the section from either side — the
//   extent of the points projected on that direction. That is exactly
//   what a steel caliper measures: the width of the shadow, not a
//   fitted circle. A cross-caliper reading is two of them at right
//   angles and their mean, the field practice for a section that is
//   not round. A circle fit is reported beside it for comparison only.
//
//   LENGTH, along the branch. A straight base-to-tip chord, a path
//   through the branch's points from its base to the point farthest
//   along it (a shortest path over a voxel graph, so a curved branch is
//   measured along its curve), or a polyline the user clicks through.
//
// Everything here is in metres and in the dataset's own coordinates
// (world / source CRS, z up). Points are a flat xyz Float64Array. Pure
// functions only; the panel feeds them the points of the loaded branch.

export type Vec3 = [number, number, number];

// ---------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 1];
}

const pointAt = (xyz: ArrayLike<number>, i: number): Vec3 => [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]];

// ---------------------------------------------------------------------
// Principal axis (PCA)
// ---------------------------------------------------------------------

/** Eigen-decomposition of a symmetric 3×3 matrix by cyclic Jacobi
 *  rotations. `m` is row-major. Values come back largest first, with
 *  the matching unit eigenvectors. */
export function symEigen3(m: ArrayLike<number>): { values: [number, number, number]; vectors: [Vec3, Vec3, Vec3] } {
  const a = [
    [m[0], m[1], m[2]],
    [m[3], m[4], m[5]],
    [m[6], m[7], m[8]],
  ];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    const scaleRef = Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]);
    if (off <= 1e-15 * (scaleRef + 1e-300)) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  const values = order.map(i => a[i][i]) as [number, number, number];
  const vectors = order.map(i => normalize([v[0][i], v[1][i], v[2][i]])) as [Vec3, Vec3, Vec3];
  return { values, vectors };
}

export interface Axis {
  /** Mean of the points the axis was fitted to. */
  centroid: Vec3;
  /** Unit direction of greatest spread. Sign is arbitrary. */
  dir: Vec3;
  /** Variances along the three principal directions, largest first. */
  eigen: [number, number, number];
  count: number;
}

/** Principal axis of the points `idx` (all of them when omitted). Null
 *  for fewer than three points. */
export function principalAxis(xyz: ArrayLike<number>, idx?: ArrayLike<number>): Axis | null {
  const n = idx ? idx.length : Math.floor(xyz.length / 3);
  if (n < 3) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < n; k++) {
    const i = idx ? idx[k] : k;
    cx += xyz[i * 3]; cy += xyz[i * 3 + 1]; cz += xyz[i * 3 + 2];
  }
  cx /= n; cy /= n; cz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let k = 0; k < n; k++) {
    const i = idx ? idx[k] : k;
    const dx = xyz[i * 3] - cx, dy = xyz[i * 3 + 1] - cy, dz = xyz[i * 3 + 2] - cz;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  const e = symEigen3([xx / n, xy / n, xz / n, xy / n, yy / n, yz / n, xz / n, yz / n, zz / n]);
  return { centroid: [cx, cy, cz], dir: e.vectors[0], eigen: e.values, count: n };
}

/** Indices of the points within `radius` of `at`. */
export function pointsWithin(xyz: ArrayLike<number>, at: Vec3, radius: number): number[] {
  const out: number[] = [];
  const r2 = radius * radius;
  const n = Math.floor(xyz.length / 3);
  for (let i = 0; i < n; i++) {
    const dx = xyz[i * 3] - at[0], dy = xyz[i * 3 + 1] - at[1], dz = xyz[i * 3 + 2] - at[2];
    if (dx * dx + dy * dy + dz * dz <= r2) out.push(i);
  }
  return out;
}

/** The branch's local axis around `at`: PCA of its points within
 *  `radius`, the radius doubled (up to four times) while fewer than
 *  `minPoints` fall inside — a thin or sparsely scanned stretch still
 *  gets an axis. Null when the branch has too few points anywhere near. */
export function localAxis(xyz: ArrayLike<number>, at: Vec3, radius: number, minPoints = 12): Axis | null {
  let r = radius;
  for (let k = 0; k < 3; k++) {
    const idx = pointsWithin(xyz, at, r);
    if (idx.length >= minPoints) return principalAxis(xyz, idx);
    r *= 2;
  }
  const idx = pointsWithin(xyz, at, r);
  return idx.length >= 3 ? principalAxis(xyz, idx) : null;
}

// ---------------------------------------------------------------------
// Cross-section
// ---------------------------------------------------------------------

export interface Section {
  /** Where the section crosses the branch axis (world). */
  center: Vec3;
  /** Unit axis the section is perpendicular to. */
  axis: Vec3;
  /** In-plane basis. `u` is horizontal (perpendicular to both the axis
   *  and the vertical), `v` completes the right-handed frame — for a
   *  near-horizontal branch θ = 0 reads the horizontal width and
   *  θ = 90° the vertical depth. */
  u: Vec3;
  v: Vec3;
  /** Section points as (u, v) pairs relative to `center`, metres. */
  pts: Float64Array;
  count: number;
  halfThickness: number;
  maxRadius: number;
}

/** A unit vector perpendicular to `axis` that is horizontal where it
 *  can be (falls back to east for a vertical axis). */
export function sectionBasis(axis: Vec3): { u: Vec3; v: Vec3 } {
  const a = normalize(axis);
  let u = cross(a, [0, 0, 1]);
  if (norm(u) < 1e-6) u = cross(a, [0, 1, 0]);
  u = normalize(u);
  const v = normalize(cross(a, u));
  return { u, v };
}

function gatherSection(
  xyz: ArrayLike<number>, center: Vec3, axis: Vec3, u: Vec3, v: Vec3,
  halfThickness: number, maxRadius: number,
): number[] {
  const out: number[] = [];
  const n = Math.floor(xyz.length / 3);
  const r2 = maxRadius * maxRadius;
  for (let i = 0; i < n; i++) {
    const d: Vec3 = [xyz[i * 3] - center[0], xyz[i * 3 + 1] - center[1], xyz[i * 3 + 2] - center[2]];
    const t = dot(d, axis);
    if (t < -halfThickness || t > halfThickness) continue;
    const pu = dot(d, u), pv = dot(d, v);
    if (pu * pu + pv * pv > r2) continue;
    out.push(i);
  }
  return out;
}

export interface SectionOptions {
  /** Radius (m) of the neighbourhood the local axis is fitted over. */
  axisRadius: number;
  /** Half the slab thickness along the axis (m). */
  halfThickness: number;
  /** Largest distance from the axis a section point may lie (m). */
  maxRadius: number;
  /** Use this axis instead of fitting one (the base section, whose axis
   *  is oriented toward the tip; a stem section; a section moved along
   *  or re-shown). With an axis given, `at` is taken to lie on it. */
  axis?: Vec3;
}

/** Cut a section across the branch at `at` (a clicked point, usually on
 *  the bark rather than on the axis). The local axis is fitted around
 *  the click; the section centre is the click's position along that
 *  axis, moved onto the axis; and the centre is then re-centred once on
 *  the section's own points so a click on one side does not leave the
 *  far side outside `maxRadius`. Null when no points fall in the slab. */
export function sectionAt(xyz: ArrayLike<number>, at: Vec3, opts: SectionOptions): Section | null {
  const fitted = opts.axis ? null : localAxis(xyz, at, opts.axisRadius);
  if (!fitted && !opts.axis) return null;
  const axis = normalize(opts.axis ?? fitted!.dir);
  const c0 = fitted ? fitted.centroid : at;
  let center = add(c0, scale(axis, dot(sub(at, c0), axis)));
  const { u, v } = sectionBasis(axis);
  let idx = gatherSection(xyz, center, axis, u, v, opts.halfThickness, opts.maxRadius);
  if (idx.length === 0) return null;
  // One re-centre: the in-plane mean of the section points.
  let mu = 0, mv = 0;
  for (const i of idx) {
    const d = sub(pointAt(xyz, i), center);
    mu += dot(d, u); mv += dot(d, v);
  }
  mu /= idx.length; mv /= idx.length;
  center = add(center, add(scale(u, mu), scale(v, mv)));
  idx = gatherSection(xyz, center, axis, u, v, opts.halfThickness, opts.maxRadius);
  if (idx.length === 0) return null;
  const pts = new Float64Array(idx.length * 2);
  idx.forEach((i, k) => {
    const d = sub(pointAt(xyz, i), center);
    pts[k * 2] = dot(d, u);
    pts[k * 2 + 1] = dot(d, v);
  });
  return { center, axis, u, v, pts, count: idx.length, halfThickness: opts.halfThickness, maxRadius: opts.maxRadius };
}

// ---------------------------------------------------------------------
// Caliper
// ---------------------------------------------------------------------

/** Value at quantile q (0..1) of an ascending-sorted array, linear
 *  interpolation between neighbours. */
function quantileSorted(s: Float64Array, q: number): number {
  if (s.length === 0) return NaN;
  const pos = Math.min(Math.max(q, 0), 1) * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export interface CaliperReading {
  /** Jaw direction (radians from the section's u axis). */
  theta: number;
  /** Positions of the two jaws along that direction (m, from the
   *  section centre). */
  lo: number;
  hi: number;
  /** hi − lo: the caliper reading (m). */
  width: number;
}

/** One caliper reading on a section: the jaws closed onto the points
 *  projected on direction θ. `trim` is the fraction of points allowed
 *  outside each jaw (0 = the outermost point on either side, a steel
 *  caliper; 0.01 ignores the outermost 1 % per side, for a scan with
 *  stray points on the bark). */
export function caliperAt(pts: Float64Array, theta: number, trim = 0): CaliperReading {
  const n = pts.length / 2;
  const c = Math.cos(theta), s = Math.sin(theta);
  const proj = new Float64Array(n);
  for (let i = 0; i < n; i++) proj[i] = pts[i * 2] * c + pts[i * 2 + 1] * s;
  proj.sort();
  const lo = quantileSorted(proj, trim);
  const hi = quantileSorted(proj, 1 - trim);
  return { theta, lo, hi, width: hi - lo };
}

/** The direction (0..π) in which the section is narrowest — where a
 *  caliper reads its minimum. Sampled every degree, then refined by a
 *  golden-section search over the bracketing two degrees. */
export function minWidthAngle(pts: Float64Array, trim = 0): number {
  if (pts.length < 4) return 0;
  const step = Math.PI / 180;
  let best = 0, bestW = Infinity;
  for (let k = 0; k < 180; k++) {
    const w = caliperAt(pts, k * step, trim).width;
    if (w < bestW) { bestW = w; best = k * step; }
  }
  let a = best - step, b = best + step;
  const g = (Math.sqrt(5) - 1) / 2;
  let x1 = b - g * (b - a), x2 = a + g * (b - a);
  let f1 = caliperAt(pts, x1, trim).width, f2 = caliperAt(pts, x2, trim).width;
  for (let it = 0; it < 30; it++) {
    if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = caliperAt(pts, x1, trim).width; }
    else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = caliperAt(pts, x2, trim).width; }
  }
  let t = (a + b) / 2;
  t = ((t % Math.PI) + Math.PI) % Math.PI;
  return t;
}

export interface CrossCaliper {
  first: CaliperReading;
  /** At θ + 90°. */
  second: CaliperReading;
  /** Arithmetic mean of the two readings — the cross-calipered
   *  diameter. */
  mean: number;
}

/** Two caliper readings at right angles and their mean. */
export function crossCaliper(pts: Float64Array, theta: number, trim = 0): CrossCaliper {
  const first = caliperAt(pts, theta, trim);
  const second = caliperAt(pts, theta + Math.PI / 2, trim);
  return { first, second, mean: (first.width + second.width) / 2 };
}

export interface SectionReading {
  /** One reading (single) or two at right angles (cross). */
  jaws: CaliperReading[];
  widths: number[];
  /** The mean of the readings (m). */
  diameter: number;
  circle: CircleFit | null;
  coverage: number | null;
  /** Some jaw was set by hand. */
  manual: boolean;
}

/** Everything read off a section at direction θ: the jaws of each
 *  reading — closed on the (trimmed) points, or where the user put them
 *  by hand (`manual[i]` = [lo, hi]) — their widths and mean, and the
 *  circle fit and its coverage for comparison. */
export function readSection(
  pts: Float64Array, theta: number, mode: 'cross' | 'single', trim: number,
  manual: ReadonlyArray<[number, number] | null> = [],
): SectionReading {
  const thetas = mode === 'cross' ? [theta, theta + Math.PI / 2] : [theta];
  const jaws = thetas.map((th, i): CaliperReading => {
    const m = manual[i];
    if (m) return { theta: th, lo: m[0], hi: m[1], width: m[1] - m[0] };
    return caliperAt(pts, th, trim);
  });
  const widths = jaws.map(j => j.width);
  const circle = fitCircle2(pts);
  return {
    jaws, widths,
    diameter: widths.reduce((a, b) => a + b, 0) / widths.length,
    circle,
    coverage: circle ? sectorCoverage(pts, circle.cu, circle.cv) : null,
    manual: thetas.some((_, i) => !!manual[i]),
  };
}

// ---------------------------------------------------------------------
// Circle fit (for comparison) and angular coverage
// ---------------------------------------------------------------------

export interface CircleFit {
  cu: number;
  cv: number;
  r: number;
  /** RMS of the radial residuals (m). */
  rmse: number;
}

/** Algebraic (Kåsa) circle fit to 2-D points. Null for fewer than three
 *  points or a degenerate (collinear) set. */
export function fitCircle2(pts: Float64Array): CircleFit | null {
  const n = pts.length / 2;
  if (n < 3) return null;
  // Centre the data first for conditioning.
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += pts[i * 2]; my += pts[i * 2 + 1]; }
  mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = 0; i < n; i++) {
    const u = pts[i * 2] - mx, v = pts[i * 2 + 1] - my;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-18) return null;
  const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
  const uc = (svv * b1 - suv * b2) / det;
  const vc = (suu * b2 - suv * b1) / det;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(pts[i * 2] - mx - uc, pts[i * 2 + 1] - my - vc) - r;
    ss += d * d;
  }
  return { cu: uc + mx, cv: vc + my, r, rmse: Math.sqrt(ss / n) };
}

/** Fraction of twelve 30° sectors around (cu, cv) holding at least one
 *  point — 1.0 for a branch seen all round, about 0.5 for one scanned
 *  from a single side. The same figure the stem caliper reports. */
export function sectorCoverage(pts: Float64Array, cu: number, cv: number, sectors = 12): number {
  const hit = new Uint8Array(sectors);
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const a = Math.atan2(pts[i * 2 + 1] - cv, pts[i * 2] - cu);
    let k = Math.floor(((a + Math.PI) / (2 * Math.PI)) * sectors);
    if (k >= sectors) k = sectors - 1;
    hit[k] = 1;
  }
  let c = 0;
  for (let k = 0; k < sectors; k++) c += hit[k];
  return c / sectors;
}

// ---------------------------------------------------------------------
// Base and tip
// ---------------------------------------------------------------------

export interface BranchEnds {
  axis: Axis;
  /** Extreme points along the principal axis. */
  a: Vec3;
  b: Vec3;
}

/** The two ends of a branch: its points farthest apart along its
 *  principal axis. */
export function branchEnds(xyz: ArrayLike<number>): BranchEnds | null {
  const axis = principalAxis(xyz);
  if (!axis) return null;
  const n = Math.floor(xyz.length / 3);
  let tMin = Infinity, tMax = -Infinity, iMin = 0, iMax = 0;
  for (let i = 0; i < n; i++) {
    const t = dot(sub(pointAt(xyz, i), axis.centroid), axis.dir);
    if (t < tMin) { tMin = t; iMin = i; }
    if (t > tMax) { tMax = t; iMax = i; }
  }
  return { axis, a: pointAt(xyz, iMin), b: pointAt(xyz, iMax) };
}

/** Which end is the base: the one nearer the stem in plan when the
 *  stem's position is known, otherwise the lower one. */
export function orderEnds(a: Vec3, b: Vec3, stem?: Vec3 | null): { base: Vec3; tip: Vec3 } {
  if (stem) {
    const da = Math.hypot(a[0] - stem[0], a[1] - stem[1]);
    const db = Math.hypot(b[0] - stem[0], b[1] - stem[1]);
    return da <= db ? { base: a, tip: b } : { base: b, tip: a };
  }
  return a[2] <= b[2] ? { base: a, tip: b } : { base: b, tip: a };
}

/** Where the base diameter is read: `offset` metres in from the base
 *  end along the branch's local axis there, with the axis oriented
 *  toward the tip. The base end is the branch's outermost point at the
 *  stem, so the offset keeps the section clear of the stem collar. */
export function baseSection(
  xyz: ArrayLike<number>, base: Vec3, tip: Vec3, offset: number, axisRadius: number,
): { at: Vec3; axis: Vec3 } | null {
  const ax = localAxis(xyz, add(base, scale(normalize(sub(tip, base)), Math.max(offset, axisRadius))), axisRadius);
  if (!ax) return null;
  let dir = ax.dir;
  if (dot(dir, sub(tip, base)) < 0) dir = scale(dir, -1);
  const tBase = dot(sub(base, ax.centroid), dir);
  return { at: add(ax.centroid, scale(dir, tBase + offset)), axis: dir };
}

// ---------------------------------------------------------------------
// Stems
// ---------------------------------------------------------------------

function medianOf(vals: number[]): number {
  const a = Float64Array.from(vals);
  a.sort();
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** The stem's centre in plan at height `z`: the median east and north
 *  of the points within ±`halfWindow` of `z`, taken twice — the second
 *  time only over the points within `maxRadius` of the first — so the
 *  crown's spread at that height does not drag it off the stem. Null
 *  when no point is that high or low. */
export function columnAt(xyz: ArrayLike<number>, z: number, halfWindow: number, maxRadius: number): Vec3 | null {
  const n = Math.floor(xyz.length / 3);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Math.abs(xyz[i * 3 + 2] - z) > halfWindow) continue;
    xs.push(xyz[i * 3]); ys.push(xyz[i * 3 + 1]);
  }
  if (xs.length < 3) return null;
  let cx = medianOf(xs), cy = medianOf(ys);
  const xs2: number[] = [], ys2: number[] = [];
  for (let k = 0; k < xs.length; k++) {
    if (Math.hypot(xs[k] - cx, ys[k] - cy) <= maxRadius) { xs2.push(xs[k]); ys2.push(ys[k]); }
  }
  if (xs2.length >= 3) { cx = medianOf(xs2); cy = medianOf(ys2); }
  return [cx, cy, z];
}

/** The stem's axis at `at`: the line through the centres of circles
 *  fitted to two thin horizontal slabs `halfWindow` below and above it,
 *  inside `maxRadius` of the column. A circle fit, not a PCA, because a
 *  tree's points around a stem section include its branches; the stem
 *  is the circle among them. Vertical when either slab is too thin to
 *  fit or the line leans more than 45°. */
export function stemAxisAt(
  xyz: ArrayLike<number>, at: Vec3, halfWindow: number, slabHalf: number, maxRadius: number,
): Vec3 {
  const centre = (z: number): [number, number] | null => {
    const n = Math.floor(xyz.length / 3);
    const pts: number[] = [];
    for (let i = 0; i < n; i++) {
      if (Math.abs(xyz[i * 3 + 2] - z) > slabHalf) continue;
      const dx = xyz[i * 3] - at[0], dy = xyz[i * 3 + 1] - at[1];
      if (dx * dx + dy * dy > maxRadius * maxRadius) continue;
      pts.push(dx, dy);
    }
    if (pts.length < 16) return null;
    const c = fitCircle2(Float64Array.from(pts));
    return c && c.r < maxRadius * 1.5 ? [c.cu + at[0], c.cv + at[1]] : null;
  };
  const lo = centre(at[2] - halfWindow), hi = centre(at[2] + halfWindow);
  if (!lo || !hi) return [0, 0, 1];
  const ax = normalize([hi[0] - lo[0], hi[1] - lo[1], 2 * halfWindow]);
  return ax[2] < Math.SQRT1_2 ? [0, 0, 1] : ax;
}

/** The points' indices ordered by height, so a horizontal slab is a
 *  binary search and a run instead of a pass over every point — a stem
 *  is followed up through dozens of slabs, and a taper series does that
 *  for each of its heights. */
export interface ZIndex {
  order: Uint32Array;
  z: Float64Array;
}

export function makeZIndex(xyz: ArrayLike<number>): ZIndex {
  const n = Math.floor(xyz.length / 3);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => xyz[a * 3 + 2] - xyz[b * 3 + 2] || a - b);
  const z = new Float64Array(n);
  for (let k = 0; k < n; k++) z[k] = xyz[order[k] * 3 + 2];
  return { order, z };
}

/** First position in `zi` whose height is ≥ `v`. */
function lowerBound(zs: Float64Array, v: number): number {
  let lo = 0, hi = zs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (zs[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Indices of the points with |z − zc| ≤ half, through the index when
 *  there is one. */
function slabIndices(xyz: ArrayLike<number>, zc: number, half: number, zi?: ZIndex): ArrayLike<number> {
  if (zi) {
    const a = lowerBound(zi.z, zc - half), b = lowerBound(zi.z, zc + half + 1e-12);
    return zi.order.subarray(a, b);
  }
  const out: number[] = [];
  const n = Math.floor(xyz.length / 3);
  for (let i = 0; i < n; i++) if (Math.abs(xyz[i * 3 + 2] - zc) <= half) out.push(i);
  return out;
}

/** A circle fitted to the points of a thin horizontal slab at `z`
 *  within `maxRadius` of (cx, cy), refitted once without the points far
 *  off the first circle (a branch leaving the stem there). Centre and
 *  radius in world plan coordinates; null when the slab is too thin or
 *  the fit comes out wider than the search. */
export function stemCircleAt(
  xyz: ArrayLike<number>, cx: number, cy: number, z: number, slabHalf: number, maxRadius: number, zi?: ZIndex,
): { cx: number; cy: number; r: number; count: number } | null {
  const pts: number[] = [];
  const idx = slabIndices(xyz, z, slabHalf, zi);
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    const dx = xyz[i * 3] - cx, dy = xyz[i * 3 + 1] - cy;
    if (dx * dx + dy * dy > maxRadius * maxRadius) continue;
    pts.push(dx, dy);
  }
  if (pts.length < 16) return null;
  let p = Float64Array.from(pts);
  let c = fitCircle2(p);
  if (!c) return null;
  const tol = Math.max(0.01, 2.5 * c.rmse);
  const keep: number[] = [];
  for (let i = 0; i < p.length; i += 2) {
    if (Math.abs(Math.hypot(p[i] - c.cu, p[i + 1] - c.cv) - c.r) <= tol) keep.push(p[i], p[i + 1]);
  }
  if (keep.length >= 16) {
    p = Float64Array.from(keep);
    c = fitCircle2(p) ?? c;
  }
  if (c.r > maxRadius) return null;
  return { cx: cx + c.cu, cy: cy + c.cv, r: c.r, count: p.length / 2 };
}

/** Follow a stem up from its foot to height `z`: a circle fitted to a
 *  thin slab every `step` metres, each one searched for around where
 *  the stem was heading from the last two — so a branch, or a crown
 *  that spreads wide at the height asked for, is never mistaken for the
 *  stem the way a plain centroid is. Where a slab gives no circle (a
 *  gap in the scan) the stem is carried on along its heading. Returns
 *  the stem's centre at `z` and its local axis there. */
export function trackStem(
  xyz: ArrayLike<number>, foot: Vec3, z: number,
  opts: { step?: number; slabHalf?: number; maxRadius: number; zIndex?: ZIndex },
): { at: Vec3; axis: Vec3 } | null {
  const step = opts.step ?? 0.25, slabHalf = opts.slabHalf ?? 0.03;
  const zi = opts.zIndex;
  const start = foot[2] + Math.min(0.3, Math.max(0, z - foot[2]));
  const first = stemCircleAt(xyz, foot[0], foot[1], start, slabHalf, opts.maxRadius, zi);
  let px = first ? first.cx : foot[0], py = first ? first.cy : foot[1], pz = start;
  let dx = 0, dy = 0; // plan drift per metre of height
  const centres: Vec3[] = [[px, py, pz]];
  while (pz < z - 1e-9) {
    const h = Math.min(step, z - pz);
    const nz = pz + h;
    const gx = px + dx * h, gy = py + dy * h;
    const c = stemCircleAt(xyz, gx, gy, nz, slabHalf, opts.maxRadius, zi);
    const nx = c ? c.cx : gx, ny = c ? c.cy : gy;
    if (c) {
      // Heading from the last metre or so of centres, damped.
      const back = centres[Math.max(0, centres.length - Math.round(1 / step))];
      const dz = nz - back[2];
      if (dz > 1e-6) { dx = 0.5 * dx + 0.5 * (nx - back[0]) / dz; dy = 0.5 * dy + 0.5 * (ny - back[1]) / dz; }
    }
    px = nx; py = ny; pz = nz;
    centres.push([px, py, pz]);
  }
  const at: Vec3 = [px, py, z];
  const lean = Math.hypot(dx, dy);
  const axis = lean > 1 ? ([0, 0, 1] as Vec3) : normalize([dx, dy, 1]);
  return { at, axis };
}

/** The foot of a stem: its lowest point's height, at the plan centre of
 *  the points within `depth` of it. */
export function stemFoot(xyz: ArrayLike<number>, depth = 0.5): Vec3 | null {
  const n = Math.floor(xyz.length / 3);
  if (n === 0) return null;
  let zMin = Infinity;
  for (let i = 0; i < n; i++) zMin = Math.min(zMin, xyz[i * 3 + 2]);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < n; i++) {
    if (xyz[i * 3 + 2] > zMin + depth) continue;
    xs.push(xyz[i * 3]); ys.push(xyz[i * 3 + 1]);
  }
  return [medianOf(xs), medianOf(ys), zMin];
}

/** The highest point. */
export function highestPoint(xyz: ArrayLike<number>): Vec3 | null {
  const n = Math.floor(xyz.length / 3);
  if (n === 0) return null;
  let best = 0;
  for (let i = 1; i < n; i++) if (xyz[i * 3 + 2] > xyz[best * 3 + 2]) best = i;
  return pointAt(xyz, best);
}

// ---------------------------------------------------------------------
// Length
// ---------------------------------------------------------------------

export function polylineLength(nodes: Vec3[]): number {
  let s = 0;
  for (let i = 1; i < nodes.length; i++) s += dist(nodes[i - 1], nodes[i]);
  return s;
}

/** Binary min-heap of (key, value) pairs. */
class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number { return this.k.length; }
  push(key: number, val: number): void {
    this.k.push(key); this.v.push(val);
    let i = this.k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      [this.k[p], this.k[i]] = [this.k[i], this.k[p]];
      [this.v[p], this.v[i]] = [this.v[i], this.v[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.k[0], this.v[0]];
    const lk = this.k.pop()!, lv = this.v.pop()!;
    if (this.k.length > 0) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l;
        if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        [this.k[m], this.k[i]] = [this.k[i], this.k[m]];
        [this.v[m], this.v[i]] = [this.v[i], this.v[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface BranchPath {
  /** Smoothed path from the base to the tip (world). */
  nodes: Vec3[];
  /** Length of `nodes` (m). */
  length: number;
  /** The point the path ends at: the branch point farthest from the
   *  base along the branch. */
  tip: Vec3;
  /** Voxels the path could not reach from the base (a gap in the scan
   *  wider than the graph bridges). Nonzero means part of the branch was
   *  left out and the length may be short. */
  unreached: number;
}

/** Length along the branch: the points are binned into `voxel`-sized
 *  cells (each standing for the mean of its points), cells are joined to
 *  every cell within two cells' reach, and the shortest path through
 *  that graph is followed from the cell nearest `start` to the cell
 *  farthest from it. The path is smoothed with a five-node moving
 *  average (ends kept) before it is measured, so the length follows the
 *  branch's centre line rather than the zig-zag between cell centres. */
export function branchPath(xyz: ArrayLike<number>, start: Vec3, voxel = 0.02): BranchPath | null {
  const n = Math.floor(xyz.length / 3);
  if (n < 2) return null;
  const cells = new Map<string, number>();
  const cx: number[] = [], cy: number[] = [], cz: number[] = [], cn: number[] = [];
  const ci: number[][] = [];
  const keyOf = (i: number, j: number, k: number) => `${i},${j},${k}`;
  for (let p = 0; p < n; p++) {
    const i = Math.floor(xyz[p * 3] / voxel), j = Math.floor(xyz[p * 3 + 1] / voxel), k = Math.floor(xyz[p * 3 + 2] / voxel);
    const key = keyOf(i, j, k);
    let c = cells.get(key);
    if (c === undefined) {
      c = cx.length;
      cells.set(key, c);
      cx.push(0); cy.push(0); cz.push(0); cn.push(0); ci.push([i, j, k]);
    }
    cx[c] += xyz[p * 3]; cy[c] += xyz[p * 3 + 1]; cz[c] += xyz[p * 3 + 2]; cn[c] += 1;
  }
  const m = cx.length;
  for (let c = 0; c < m; c++) { cx[c] /= cn[c]; cy[c] /= cn[c]; cz[c] /= cn[c]; }
  let s0 = 0, best = Infinity;
  for (let c = 0; c < m; c++) {
    const d = Math.hypot(cx[c] - start[0], cy[c] - start[1], cz[c] - start[2]);
    if (d < best) { best = d; s0 = c; }
  }
  const distTo = new Float64Array(m).fill(Infinity);
  const prev = new Int32Array(m).fill(-1);
  distTo[s0] = 0;
  const heap = new MinHeap();
  heap.push(0, s0);
  const R = 2;
  while (heap.size > 0) {
    const [d, c] = heap.pop();
    if (d > distTo[c]) continue;
    const [i, j, k] = ci[c];
    for (let di = -R; di <= R; di++) {
      for (let dj = -R; dj <= R; dj++) {
        for (let dk = -R; dk <= R; dk++) {
          if (di === 0 && dj === 0 && dk === 0) continue;
          const o = cells.get(keyOf(i + di, j + dj, k + dk));
          if (o === undefined) continue;
          const w = Math.hypot(cx[o] - cx[c], cy[o] - cy[c], cz[o] - cz[c]);
          const nd = d + w;
          if (nd < distTo[o]) { distTo[o] = nd; prev[o] = c; heap.push(nd, o); }
        }
      }
    }
  }
  let tipCell = s0, far = 0, unreached = 0;
  for (let c = 0; c < m; c++) {
    if (!Number.isFinite(distTo[c])) { unreached++; continue; }
    if (distTo[c] > far) { far = distTo[c]; tipCell = c; }
  }
  const raw: Vec3[] = [];
  for (let c = tipCell; c !== -1; c = prev[c]) raw.push([cx[c], cy[c], cz[c]]);
  raw.reverse();
  // The path runs between cell means, half a cell short of the branch
  // at either end: it is extended to the start itself and to the point
  // of the tip cell farthest from the start, so a branch is not
  // measured a cell shorter than it is.
  const [ti, tj, tk] = ci[tipCell];
  let tipPoint: Vec3 = raw[raw.length - 1];
  let tipFar = -1;
  for (let p = 0; p < n; p++) {
    if (Math.floor(xyz[p * 3] / voxel) !== ti || Math.floor(xyz[p * 3 + 1] / voxel) !== tj || Math.floor(xyz[p * 3 + 2] / voxel) !== tk) continue;
    const q = pointAt(xyz, p);
    const d = dist(q, start);
    if (d > tipFar) { tipFar = d; tipPoint = q; }
  }
  if (dist(raw[0], start) > 1e-9) raw.unshift([start[0], start[1], start[2]]);
  if (dist(raw[raw.length - 1], tipPoint) > 1e-9) raw.push(tipPoint);
  const nodes: Vec3[] = raw.map((p, idx) => {
    if (idx === 0 || idx === raw.length - 1) return p;
    const lo = Math.max(0, idx - 2), hi = Math.min(raw.length - 1, idx + 2);
    let sx = 0, sy = 0, sz = 0;
    for (let q = lo; q <= hi; q++) { sx += raw[q][0]; sy += raw[q][1]; sz += raw[q][2]; }
    const c = hi - lo + 1;
    return [sx / c, sy / c, sz / c];
  });
  return { nodes, length: polylineLength(nodes), tip: tipPoint, unreached };
}
