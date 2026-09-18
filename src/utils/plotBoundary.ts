// Plot boundary geometry + edge-correction helpers.
//
// Forestry per-hectare statistics MUST account for trees on the plot
// boundary or partially outside it; a naive "count every tree inside
// the bbox" inflates stems/ha + basal area/ha by ~10-30 % in typical
// surveys (Husch et al. 2002, "Forest Mensuration"). Three standard
// methods are implemented here, controllable from the Plot Boundary
// panel:
//
//   • none        — strict in/out by stem centre. Bias-prone but
//                   matches what a naive bbox area gives.
//   • halfcount   — Schreuder/Husch: trees on the boundary band count
//                   0.5. Cheap, slightly biased low.
//   • crownArea   — proportional to crown-area-inside-plot fraction.
//                   The most defensible in mixed-density stands.
//                   Falls back to halfcount when crownArea is unknown.

import type { PlotBoundary, EdgeCorrection } from '../components/shell/OctreeShellContext';

/** Plot area in hectares. Circular = π·r²; rectangular = side product.
 *
 *  Each rectangular side is clamped at zero: an inverted boundary
 *  (min > max, e.g. from a hand-edited plot.json) has NO area, not the
 *  positive one two negative sides multiply into. Area is the
 *  denominator of every per-hectare figure, so a plausible-looking
 *  number for a boundary that contains nothing is the worst value this
 *  can return. */
export function plotAreaHa(b: PlotBoundary): number {
  if (b.kind === 'circular') {
    return (Math.PI * b.radius * b.radius) / 10_000;
  }
  const w = Math.max(0, b.max[0] - b.min[0]);
  const h = Math.max(0, b.max[1] - b.min[1]);
  return (w * h) / 10_000;
}

/** Stem-centre inside the plot? Strict in/out check. */
export function stemCentreInside(xy: [number, number], b: PlotBoundary): boolean {
  if (b.kind === 'circular') {
    const dx = xy[0] - b.center[0];
    const dy = xy[1] - b.center[1];
    return dx * dx + dy * dy <= b.radius * b.radius;
  }
  return xy[0] >= b.min[0] && xy[0] <= b.max[0]
      && xy[1] >= b.min[1] && xy[1] <= b.max[1];
}

/** Signed distance from a stem centre to the boundary. Negative inside,
 *  positive outside. For circular plots this is r − d_to_center; for
 *  rectangular it's the min distance to any edge (also signed). */
export function signedDistanceToBoundary(xy: [number, number], b: PlotBoundary): number {
  if (b.kind === 'circular') {
    const dx = xy[0] - b.center[0];
    const dy = xy[1] - b.center[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    return d - b.radius; // negative inside
  }
  const dl = b.min[0] - xy[0]; // negative when inside
  const dr = xy[0] - b.max[0];
  const db = b.min[1] - xy[1];
  const dt = xy[1] - b.max[1];
  if (Math.max(dl, dr, db, dt) > 0) {
    // Outside — Euclidean distance to the nearest point of the
    // rectangle. The per-axis maximum alone is the Chebyshev distance,
    // which understates diagonally off a corner by up to √2: a stem
    // 1 m east and 1 m north of the corner is 1.41 m from the plot,
    // not 1 m. Only the sign feeds treeWeight, but the magnitude is
    // this function's contract.
    return Math.hypot(Math.max(0, dl, dr), Math.max(0, db, dt));
  }
  // Inside — the (negative) closest-edge distance.
  return -Math.min(-dl, -dr, -db, -dt);
}

/** Crown-area fraction inside the plot — Monte-Carlo over the crown
 *  disk (radius derived from crownArea). Uses a deterministic
 *  fibonacci-lattice sample so the same tree always gets the same
 *  weight. 64 samples is enough for forestry precision. */
export function crownFractionInside(
  xy: [number, number],
  crownArea: number,
  b: PlotBoundary,
): number {
  if (!Number.isFinite(crownArea) || crownArea <= 0) {
    // Fallback: treat as point if no crown — same as 'none' logic.
    return stemCentreInside(xy, b) ? 1 : 0;
  }
  const r = Math.sqrt(crownArea / Math.PI);
  const N = 64;
  let inside = 0;
  // Fibonacci spiral on a disk: ρ = r·√(i / N), θ = i · golden angle.
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i++) {
    const rho = r * Math.sqrt((i + 0.5) / N);
    const theta = i * golden;
    const px = xy[0] + rho * Math.cos(theta);
    const py = xy[1] + rho * Math.sin(theta);
    if (stemCentreInside([px, py], b)) inside++;
  }
  return inside / N;
}

/** Inclusion weight per tree under the chosen edge-correction method.
 *  Returns 0..1; multiply the tree's contribution to a sum by this. */
export function treeWeight(
  xy: [number, number],
  crownArea: number,
  b: PlotBoundary,
  method: EdgeCorrection,
  halfcountBuffer: number = 1.0,
): number {
  switch (method) {
    case 'none':
      return stemCentreInside(xy, b) ? 1 : 0;
    case 'halfcount': {
      const sd = signedDistanceToBoundary(xy, b);
      if (sd > 0) return 0; // stem centre outside
      // Inside the buffer band (|sd| ≤ buffer) → 0.5; else 1.0.
      return Math.abs(sd) <= halfcountBuffer ? 0.5 : 1.0;
    }
    case 'crownArea':
      return crownFractionInside(xy, crownArea, b);
  }
}

/** Auto-fit a rectangular boundary to the XY bbox of a set of stems,
 *  optionally shrunk by a margin to keep the boundary just inside the
 *  tree envelope (no edge correction needed if margin ≥ typical crown
 *  radius). */
export function fitRectangularToBbox(
  xy: Array<[number, number]>,
  margin: number = 0,
): PlotBoundary | null {
  if (xy.length === 0) return null;
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const [x, y] of xy) {
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  }
  // A margin larger than half the extent would push min past max and
  // invert the rectangle. Clamp each axis at its midpoint instead: the
  // boundary collapses to zero area — visibly "your margin ate the
  // plot" — rather than silently turning inside out.
  const m = Math.max(0, margin);
  const cx = (xMin + xMax) * 0.5;
  const cy = (yMin + yMax) * 0.5;
  return {
    kind: 'rectangular',
    min: [Math.min(xMin + m, cx), Math.min(yMin + m, cy)],
    max: [Math.max(xMax - m, cx), Math.max(yMax - m, cy)],
  };
}

/** Auto-fit a circular boundary — centred on the stems' bbox centre,
 *  with the radius reaching the FARTHEST STEM, optionally shrunk by
 *  margin.
 *
 *  Not the circle circumscribing the bbox, which the doc here used to
 *  claim: that reaches the corners, and a plot rarely has a tree in one.
 *  The extra area would be empty ground, and area is the denominator of
 *  every per-hectare figure. */
export function fitCircularToBbox(
  xy: Array<[number, number]>,
  margin: number = 0,
): PlotBoundary | null {
  if (xy.length === 0) return null;
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const [x, y] of xy) {
    if (x < xMin) xMin = x; if (x > xMax) xMax = x;
    if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  }
  const cx = (xMin + xMax) * 0.5;
  const cy = (yMin + yMax) * 0.5;
  // Radius = distance to the farthest stem, less the margin. (The
  // margin SHRINKS the boundary — see fitRectangularToBbox.)
  let rMax = 0;
  for (const [x, y] of xy) {
    const r = Math.hypot(x - cx, y - cy);
    if (r > rMax) rMax = r;
  }
  const radius = Math.max(1.0, rMax - margin);
  return { kind: 'circular', center: [cx, cy], radius };
}

// --- Persistence -----------------------------------------------------
//
// The boundary is a property of the dataset (plot.json next to the
// octree — see octree_read_plot / octree_write_plot), not of any one
// panel's UI state. Every reader (EditorShell seeding shell state,
// InventoryModule reading the bridge directly since it lives outside
// the shell) needs the exact same "is this actually a PlotBoundary"
// check, so it lives here once instead of each caller re-deriving its
// own notion of a valid payload.

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isNumberPair(x: unknown): x is [number, number] {
  return Array.isArray(x) && x.length === 2 && isFiniteNumber(x[0]) && isFiniteNumber(x[1]);
}

/** Parse a plot.json payload (the raw JSON string octree_read_plot
 *  returns) into a PlotBoundary, or null. "{}" (no boundary saved) and
 *  any malformed / partial payload both parse to null — the same "no
 *  boundary" state a brand-new dataset starts in — so a corrupt file
 *  degrades to the estimated-area fallback instead of throwing. */
export function parsePlotBoundary(raw: string): PlotBoundary | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const b = obj as Record<string, unknown>;
  if (b.kind === 'circular' && isNumberPair(b.center) && isFiniteNumber(b.radius) && b.radius > 0) {
    return { kind: 'circular', center: b.center, radius: b.radius };
  }
  if (b.kind === 'rectangular' && isNumberPair(b.min) && isNumberPair(b.max)
      // An inverted or zero-extent rectangle is malformed, same as a
      // non-positive radius: it can contain no tree, and its "area"
      // would sit in the denominator of every per-hectare figure.
      && b.min[0] < b.max[0] && b.min[1] < b.max[1]) {
    return { kind: 'rectangular', min: b.min, max: b.max };
  }
  return null;
}
