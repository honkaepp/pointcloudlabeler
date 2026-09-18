// Edge-corrected per-hectare plot statistics.
//
// Extracted from PlotBoundaryPanel so the arithmetic can be tested on a
// plot whose answers are known. The panel keeps the UI.
//
// Every figure here is a sum over trees divided by the plot area, so it
// follows the same rule the growth summary does: a ratio is only
// meaningful over the trees that have BOTH of the things being divided.

import type { TreeMetric, TreeQsm, QsmResult, StemFit } from '../persistence/octreeReader';
import type { PlotBoundary, EdgeCorrection } from '../components/shell/OctreeShellContext';
import { plotAreaHa, treeWeight } from '../utils/plotBoundary';
import { topFractionMean } from './stats';

export interface PlotStats {
  areaHa: number;
  /** Σ inclusion weights — the edge-corrected stem count. */
  nWeighted: number;
  nFullyIn: number;
  nPartial: number;
  nOut: number;
  stemsPerHa: number;
  basalAreaPerHa: number;
  /** Basal-area weighted mean height (Lorey's H), over the trees that
   *  have both a diameter and a height. NaN when none do. */
  loreyMeanHeight: number;
  /** Trees inside the plot with a diameter but no usable height, so they
   *  are not in Lorey's mean. A tree with no ground beneath it reports a
   *  height of 0, which is not a short tree — it is an unmeasured one. */
  nNoHeight: number;
  stemVolumePerHa: number;
  stemVolumeCi95PerHa: number;
  hasQsm: boolean;
  insideRows: Array<{ tree: TreeMetric; weight: number }>;
}

export function computePlotStats(
  metrics: TreeMetric[],
  plotBoundary: PlotBoundary,
  edge: EdgeCorrection,
  halfcountBuffer: number,
  qsm: QsmResult | null,
): PlotStats {
  const areaHa = plotAreaHa(plotBoundary);
  const qsmMap: Map<number, TreeQsm> | null =
    qsm ? new Map(qsm.trees.map(t => [t.treeId, t])) : null;

  let nWeighted = 0;
  let baSum = 0;
  // Lorey's mean height is Σ(g·h) / Σ(g), and both sums must run over
  // the SAME trees. They did not: a tree with a diameter but no height
  // was added to the denominator and not the numerator, so it pulled the
  // mean down as if it were a tree of height zero. `height` comes back
  // as 0 for a tree with no ground surface beneath it, so this is not an
  // exotic case — and one tree in four is enough to understate the
  // figure by a quarter.
  let baWeightedH = 0;
  let baWithHeight = 0;
  let nNoHeight = 0;
  let stemVolSum = 0;
  let stemVolVar = 0;
  let nFullyIn = 0;
  let nPartial = 0;
  let nOut = 0;
  const insideRows: Array<{ tree: TreeMetric; weight: number }> = [];

  for (const t of metrics) {
    if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) { nOut++; continue; }
    const w = treeWeight([t.x, t.y], t.crownArea, plotBoundary, edge, halfcountBuffer);
    if (w === 0) { nOut++; continue; }
    if (w === 1) nFullyIn++; else nPartial++;
    insideRows.push({ tree: t, weight: w });
    nWeighted += w;

    if (Number.isFinite(t.dbh) && t.dbh > 0) {
      const ba = Math.PI * (t.dbh * 0.5) ** 2;
      baSum += w * ba;
      if (Number.isFinite(t.height) && t.height > 0) {
        baWeightedH += w * ba * t.height;
        baWithHeight += w * ba;
      } else {
        nNoHeight++;
      }
    }

    const q = qsmMap?.get(t.treeId);
    if (q) {
      stemVolSum += w * q.stemVolume;
      const ci = Number.isFinite(q.stemVolumeCi95) ? q.stemVolumeCi95 : 0;
      // Independent trees in quadrature; the weight squares out too.
      // Combining 95 % half-widths this way is the same as combining
      // the σ they scale from — the 1.96 factors out of the sum.
      stemVolVar += (w * ci) ** 2;
    }
  }

  const perHa = Math.max(areaHa, 1e-6);
  return {
    areaHa,
    nWeighted,
    nFullyIn, nPartial, nOut,
    stemsPerHa: nWeighted / perHa,
    basalAreaPerHa: baSum / perHa,
    loreyMeanHeight: baWithHeight > 0 ? baWeightedH / baWithHeight : NaN,
    nNoHeight,
    stemVolumePerHa: stemVolSum / perHa,
    stemVolumeCi95PerHa: Math.sqrt(stemVolVar) / perHa,
    hasQsm: qsm !== null,
    insideRows,
  };
}

/** Plot-level tree statistics, with each figure taken over the trees
 *  that have what IT needs.
 *
 *  Shared because this was computed independently in three places — the
 *  report, the Density Metrics panel and the Plot Boundary panel — and
 *  they disagreed. Two of them filtered to trees having BOTH a diameter
 *  and a height before summing basal area, which is measured from the
 *  diameter alone, so a tree with no ground beneath it (height 0, which
 *  means unmeasured, not short) vanished from the stem count and the
 *  basal area of a plot it is plainly standing in.
 *
 *  This is the unweighted core. `computePlotStats` builds the
 *  edge-corrected per-hectare figures on the same rules. */
export interface TreeStats {
  /** Every tree. A tree is a tree whether or not every attribute could
   *  be measured on it. */
  treeCount: number;
  nWithDbh: number;
  nWithHeight: number;
  /** Σ basal area over the trees that have a diameter (m²). */
  basalAreaTotal: number;
  /** Basal-area weighted mean height over the trees that have both. */
  loreyMeanHeight: number;
  /** Mean height of the tallest tenth of the MEASURED heights. */
  dominantHeight: number;
  topNCount: number;
}

const basalArea = (dbh: number) => Math.PI * (dbh * 0.5) ** 2;

export function treeStats(metrics: TreeMetric[]): TreeStats {
  const withDbh = metrics.filter(t => Number.isFinite(t.dbh) && t.dbh > 0);
  const withHeight = metrics.filter(t => Number.isFinite(t.height) && t.height > 0);
  const withBoth = metrics.filter(t =>
    Number.isFinite(t.dbh) && t.dbh > 0 && Number.isFinite(t.height) && t.height > 0
  );

  const basalAreaTotal = withDbh.reduce((a, t) => a + basalArea(t.dbh), 0);
  const baBoth = withBoth.reduce((a, t) => a + basalArea(t.dbh), 0);
  const baWeightedH = withBoth.reduce((a, t) => a + basalArea(t.dbh) * t.height, 0);

  const dominant = topFractionMean(withHeight.map(t => t.height), 0.10);

  return {
    treeCount: metrics.length,
    nWithDbh: withDbh.length,
    nWithHeight: withHeight.length,
    basalAreaTotal,
    loreyMeanHeight: baBoth > 0 ? baWeightedH / baBoth : NaN,
    dominantHeight: dominant.value,
    topNCount: dominant.count,
  };
}

/** Fold the RANSAC stem fits onto the metrics rows: where a fit
 *  succeeded, its diameter and the basal area derived from it replace
 *  the algebraic estimate.
 *
 *  Shared because it was not. The merge lived inside the Metrics table
 *  and nowhere else, so the refinement the user explicitly runs improved
 *  that one table — until they navigated away, since the fits were never
 *  persisted either — while the report, the per-hectare figures, the
 *  biomass and every export went on using the algebraic diameter this
 *  fit exists to replace. Two screens showed two diameters for one tree,
 *  and DBH is squared into basal area, so everything downstream
 *  inherited the difference. */
export function mergeStemFits(
  metrics: TreeMetric[],
  stems: Map<number, StemFit> | null,
): TreeMetric[] {
  if (!stems || stems.size === 0) return metrics;
  return metrics.map(t => {
    const f = stems.get(t.treeId);
    if (f && Number.isFinite(f.dbh) && f.dbh > 0) {
      return {
        ...t,
        dbh: f.dbh,
        basalArea: Math.PI * (f.dbh * 0.5) ** 2,
        dbhSource: 'stemFit' as const,
      };
    }
    return t;
  });
}

/** How many of these rows carry a RANSAC-refined diameter. For panels to
 *  say so beside the numbers: a diameter is a fact about a tree AND how
 *  it was measured, and a table mixing two measurements without saying
 *  which is which is showing half of each. */
export function countRefined(metrics: TreeMetric[]): number {
  return metrics.reduce((n, t) => n + (t.dbhSource === 'stemFit' ? 1 : 0), 0);
}
