// Stem taper + log assortment (bucking / apteeraus).
//
// Greedy bucking from the stump upward with descending priority — the
// heuristic a real harvester applies when no smart bucker is configured:
// at the current height try the highest-priority assortment, take the
// longest module whose top end still meets that assortment's minimum
// top diameter, cut, advance, repeat.
//
// Extracted from BuckingPanel so the arithmetic can be tested against a
// stem whose answers are known. This is the file that decides what the
// stand is worth, and it had no tests.
//
// The rule that holds it together: **every volume here is integrated
// over the same taper, the same way the QSM integrated it in Rust.**
// Logs, the stump and the residue all come out of one integrator, so
// they add up to the QSM's own stem volume rather than to two different
// approximations of it that get reconciled by subtraction.

import type { TreeQsm } from '../persistence/octreeReader';

export interface Assortment {
  id: string;
  name: string;
  /** Minimum acceptable top-end diameter, **cm**. */
  minTopDcm: number;
  /** Length module set, **m**. Sorted ascending by the caller; the
   *  bucker tries from the longest down. */
  lengths: number[];
  /** Price per cubic metre (currency is global to the panel). */
  pricePerM3: number;
  /** Colour for the stem-profile overlay + the plot-totals bar. */
  colour: string;
}

export interface Log {
  assortmentId: string;
  /** Lower edge, height above ground (m). */
  hLow: number;
  /** Upper edge, height above ground (m). */
  hHigh: number;
  length: number;
  /** Butt-end diameter (m). */
  dButt: number;
  /** Top-end diameter (m). */
  dTop: number;
  volume: number;
  revenue: number;
}

export interface BuckingResult {
  treeId: number;
  /** Full tree height from the metrics pass (m) — the crown top. */
  height: number;
  /** Highest point on the stem the QSM actually FITTED a circle to (m).
   *  Bucking stops here. Under a closed canopy the upper stem is often
   *  occluded and this sits well below `height`. */
  measuredTop: number;
  logs: Log[];
  perClass: Record<string, number>;
  revenuePerClass: Record<string, number>;
  /** Σ log volumes (m³). */
  loggedVolume: number;
  /** Stump, below the first cut (m³). */
  stumpVolume: number;
  /** Measured stem above the last cut (m³). */
  residueVolume: number;
  /** stumpVolume + residueVolume (m³) — everything measured but not sold. */
  wasteVolume: number;
  /** stumpVolume + loggedVolume + residueVolume. Equals the QSM's own
   *  `stemVolume` to floating-point, because it is the same integral. */
  taperVolume: number;
  /** What the QSM reported, for the caller to show side by side. */
  qsmStemVolume: number;
  totalRevenue: number;
}

/** A point on the measured taper: fitted diameter at a known height. */
export interface TaperPoint { h: number; d: number }

/** The measured taper: one point per accepted slice, at the slice's
 *  MID height, ascending.
 *
 *  `hag` is the slice's lower edge and the fitted radius describes the
 *  band above it, so the diameter belongs at `hag + slice/2`. The slice
 *  height is taken from the gap between the first two slices rather than
 *  from a nominal setting, because the TreeQSM path supplies cylinders
 *  of its own lengths through the same record — which is exactly what
 *  the Rust integrator does, so the two stay in step.
 *
 *  No zero-diameter anchor at the tree top. There used to be one, with a
 *  comment saying it stopped logs extending above the last fit; it did
 *  the opposite. It drew a straight cone from the topmost measured slice
 *  to the crown and let the bucker sell logs out of it — wood no circle
 *  was ever fitted to. On an occluded stem measured to 10 m of 22 m that
 *  turned 0.66 m³ of measured stem into 0.82 m³ of merchantable logs. */
export function taperPoints(t: TreeQsm): TaperPoint[] {
  const slices = [...t.slices].sort((a, b) => a.hag - b.hag);
  if (slices.length === 0) return [];
  const spacing = slices.length >= 2
    ? Math.max(0.05, slices[1].hag - slices[0].hag)
    : 0.25;
  return slices.map(s => ({ h: s.hag + spacing * 0.5, d: s.radius * 2 }));
}

/** Diameter at height `h` (m).
 *
 *  Constant at the first slice's diameter below the first slice centre —
 *  a cylinder, not an extrapolation of the taper's slope. That is what
 *  the Rust integrator assumes for the stump, and the stump is the
 *  thickest part of the tree, so guessing a slope there would move real
 *  volume. Above the last slice centre there is no measurement, so it
 *  returns 0 and the caller must not integrate there. */
export function diameterAt(pts: TaperPoint[], h: number): number {
  if (pts.length === 0) return 0;
  if (h <= pts[0].h) return pts[0].d;
  if (h >= pts[pts.length - 1].h) return h === pts[pts.length - 1].h ? pts[pts.length - 1].d : 0;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (pts[m].h <= h) lo = m; else hi = m;
  }
  const a = pts[lo], b = pts[hi];
  const span = b.h - a.h;
  if (!(span > 0)) return a.d;
  return a.d + (b.d - a.d) * ((h - a.h) / span);
}

/** Cone-frustum volume: V = π/12 · L · (d_b² + d_b·d_t + d_t²), which is
 *  the π/3 · L · (r_b² + r_b·r_t + r_t²) the Rust integrator uses. */
export function frustumVolume(dButt: number, dTop: number, length: number): number {
  return (Math.PI / 12) * length * (dButt * dButt + dButt * dTop + dTop * dTop);
}

/** Volume of the taper between two heights (m³), integrated the way the
 *  QSM integrated it: a cylinder below the first slice centre, then one
 *  frustum per slice interval, split at whatever heights the caller asks
 *  for.
 *
 *  A single chord frustum across a whole 5 m log is NOT the same thing —
 *  it replaces fifteen measured diameters with a straight line between
 *  the two ends, and misses by ~1 % in whichever direction the taper
 *  curves. A log's volume has a price per cubic metre attached to it, so
 *  it should be a genuine slice of the volume the QSM reported, not a
 *  second approximation of the same stem. */
export function integrateTaper(pts: TaperPoint[], hLow: number, hHigh: number): number {
  if (pts.length === 0 || !(hHigh > hLow)) return 0;
  const top = pts[pts.length - 1].h;
  const lo = Math.max(0, hLow);
  const hi = Math.min(hHigh, top);
  if (!(hi > lo)) return 0;

  let v = 0;
  // Cylinder below the first slice centre.
  const first = pts[0].h;
  if (lo < first) {
    const cylTop = Math.min(hi, first);
    v += Math.PI * (pts[0].d * 0.5) ** 2 * (cylTop - lo);
    if (cylTop >= hi) return v;
  }
  // Frustum per slice interval, clipped to [lo, hi].
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b.h <= lo) continue;
    if (a.h >= hi) break;
    const s = Math.max(a.h, lo);
    const e = Math.min(b.h, hi);
    if (!(e > s)) continue;
    v += frustumVolume(diameterAt(pts, s), diameterAt(pts, e), e - s);
  }
  return v;
}

/** Clean a typed-in length module set at the input boundary: drop what
 *  cannot be a log length, sort ascending.
 *
 *  The panel's length field is free text by design ("retune for your own
 *  market without a code change"), and typing "0.5" passes through "0"
 *  and "0." on the way — both parse to 0. Storing a zero-length module
 *  in the assortment is meaningless whatever the bucker does with it, so
 *  it is dropped here.
 *
 *  This is hygiene, NOT what makes bucking terminate. `buckTree` refuses
 *  a cut that does not advance the height, and that is the property the
 *  loop rests on — see there. */
export function sanitizeLengths(lengths: number[]): number[] {
  return lengths.filter(l => Number.isFinite(l) && l > 0).sort((a, b) => a - b);
}

export function buckTree(
  t: TreeQsm,
  stumpHeight: number,
  assortments: Assortment[],
): BuckingResult {
  const pts = taperPoints(t);
  const measuredTop = pts.length > 0 ? pts[pts.length - 1].h : 0;
  const stump = Math.max(0, Number.isFinite(stumpHeight) ? stumpHeight : 0);
  const logs: Log[] = [];

  // Longest module first, whatever order they were given in. A copy —
  // the caller's assortment is not ours to reorder.
  const modules = assortments.map(a => [...a.lengths].sort((x, y) => y - x));

  let h = Math.min(stump, measuredTop);
  outer:
  // Terminates because every iteration that cuts strictly increases `h`
  // (the guard below), and an iteration that cuts nothing breaks out.
  // That has to be a property of THIS loop and not of whatever cleaned
  // the input: the function is exported, and the failure mode is a
  // frozen app rather than a wrong number. A zero-length module passes
  // every diameter test, contributes nothing, and leaves the cut height
  // exactly where it was — so the bucker cut it again, forever, while
  // the log list grew without bound. The panel reached that from an
  // ordinary keystroke.
  while (h < measuredTop) {
    for (let ai = 0; ai < assortments.length; ai++) {
      const a = assortments[ai];
      for (const len of modules[ai]) {
        const hTop = h + len;
        // No progress ⇒ no cut. This is what makes the loop a loop.
        if (!(hTop > h)) continue;
        // Never cut above the highest slice a circle was fitted to.
        if (hTop > measuredTop) continue;
        const dTop = diameterAt(pts, hTop);
        if (dTop * 100 < a.minTopDcm) continue;
        const dButt = diameterAt(pts, h);
        const v = integrateTaper(pts, h, hTop);
        logs.push({
          assortmentId: a.id, hLow: h, hHigh: hTop,
          length: len, dButt, dTop,
          volume: v, revenue: v * a.pricePerM3,
        });
        h = hTop;
        continue outer;
      }
    }
    break;
  }

  const perClass: Record<string, number> = {};
  const revenuePerClass: Record<string, number> = {};
  for (const a of assortments) { perClass[a.id] = 0; revenuePerClass[a.id] = 0; }
  for (const log of logs) {
    perClass[log.assortmentId] = (perClass[log.assortmentId] ?? 0) + log.volume;
    revenuePerClass[log.assortmentId] = (revenuePerClass[log.assortmentId] ?? 0) + log.revenue;
  }

  const loggedVolume = logs.reduce((a, l) => a + l.volume, 0);
  // Waste is what is left of the MEASURED stem, integrated the same way
  // — not `qsmStemVolume − loggedVolume`. That subtraction mixed two
  // different integrations of the same tree and then clamped the result
  // at zero, so every discretisation difference landed in "waste" and
  // any overshoot vanished silently. With an occluded upper stem it read
  // 0.000 m³ of waste on a tree the bucker had over-cut by a quarter.
  const stumpVolume = integrateTaper(pts, 0, Math.min(stump, measuredTop));
  const residueVolume = integrateTaper(pts, h, measuredTop);
  const totalRevenue = logs.reduce((a, l) => a + l.revenue, 0);

  return {
    treeId: t.treeId,
    height: t.height,
    measuredTop,
    logs, perClass, revenuePerClass,
    loggedVolume, stumpVolume, residueVolume,
    wasteVolume: stumpVolume + residueVolume,
    taperVolume: stumpVolume + loggedVolume + residueVolume,
    qsmStemVolume: t.stemVolume,
    totalRevenue,
  };
}

export interface PlotTotals {
  perClass: Record<string, number>;
  revenuePerClass: Record<string, number>;
  waste: number;
  /** Σ over trees of stump + logs + residue (m³). */
  totalVol: number;
  totalRev: number;
  /** Trees whose stem was fitted to less than 80 % of the tree height —
   *  the bucking below that top is real, but everything above it is
   *  unmeasured stem the panel is silent about unless it says so. */
  nPartiallyMeasured: number;
}

export function plotTotals(results: BuckingResult[], assortments: Assortment[]): PlotTotals {
  const perClass: Record<string, number> = {};
  const revenuePerClass: Record<string, number> = {};
  for (const a of assortments) { perClass[a.id] = 0; revenuePerClass[a.id] = 0; }
  let waste = 0, totalVol = 0, totalRev = 0, nPartiallyMeasured = 0;
  for (const r of results) {
    for (const k in r.perClass) perClass[k] = (perClass[k] ?? 0) + r.perClass[k];
    for (const k in r.revenuePerClass) revenuePerClass[k] = (revenuePerClass[k] ?? 0) + r.revenuePerClass[k];
    waste += r.wasteVolume;
    totalVol += r.taperVolume;
    totalRev += r.totalRevenue;
    if (r.height > 0 && r.measuredTop < r.height * 0.8) nPartiallyMeasured++;
  }
  return { perClass, revenuePerClass, waste, totalVol, totalRev, nPartiallyMeasured };
}
