// Field validation — comparing PointCloudLabeler's measurements against calipered
// ground truth.
//
// Extracted from ValidationPanel so it can be tested. The panel's whole
// output is a claim about how accurate PointCloudLabeler is; everything here feeds
// that claim, and none of it had tests.

import type { TreeMetric } from '../persistence/octreeReader';
import { parseNumber, csvUnguard } from '../io/csv';
import { matchByPosition } from './assignment';
export { parseCsv, type ParsedCsv } from '../io/csv';

// --- Column mapping ----------------------------------------------------

export interface Mapping {
  xCol: number;
  yCol: number;
  /** Caliper DBH column, in centimetres. -1 = absent. */
  dbhCol: number;
  /** Hypsometer height column, in metres. -1 = absent. */
  heightCol: number;
  speciesCol: number;
  idCol: number;
}

export function autoMap(headers: string[]): Mapping {
  const lc = headers.map(h => h.trim().toLowerCase());
  const find = (...names: string[]) => {
    for (const n of names) {
      const i = lc.indexOf(n);
      if (i !== -1) return i;
    }
    for (let i = 0; i < lc.length; i++) {
      for (const n of names) if (lc[i].startsWith(n + '_') || lc[i].startsWith(n + ' ')) return i;
    }
    return -1;
  };
  return {
    xCol: find('x', 'easting', 'lon', 'longitude', 'gps_x'),
    yCol: find('y', 'northing', 'lat', 'latitude', 'gps_y'),
    dbhCol: find('dbh', 'diameter', 'd13', 'd', 'd_cm', 'lapimitta'),
    heightCol: find('height', 'h', 'tot_h', 'height_m', 'pituus'),
    speciesCol: find('species', 'sp', 'puulaji'),
    idCol: find('id', 'tree', 'tree_no', 'treenumber', 'puunumero', 'no'),
  };
}

// --- Field trees -------------------------------------------------------

export interface FieldTree {
  rowIdx: number;
  fieldId: string;
  x: number;
  y: number;
  /** Caliper DBH in METRES (CSV centimetres × 0.01), NaN when absent. */
  caliperDbh: number;
  /** Hypsometer height in metres, NaN when absent. */
  hypHeight: number;
  species: string;
}

export function rowsToFieldTrees(
  rows: string[][],
  m: Mapping,
  decimalComma: boolean,
): FieldTree[] {
  const out: FieldTree[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const x = parseNumber(r[m.xCol], decimalComma);
    const y = parseNumber(r[m.yCol], decimalComma);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.push({
      rowIdx: i,
      // csvUnguard: PointCloudLabeler's own export marks a text cell that a
      // spreadsheet would evaluate as a formula (see io/csv.ts), and
      // this reads those exports back. It undoes exactly that marker
      // and leaves every other value alone.
      fieldId: m.idCol >= 0 ? csvUnguard((r[m.idCol] ?? '').trim()) : `${i + 1}`,
      x, y,
      caliperDbh: m.dbhCol >= 0 ? parseNumber(r[m.dbhCol], decimalComma) * 0.01 : NaN,
      hypHeight: m.heightCol >= 0 ? parseNumber(r[m.heightCol], decimalComma) : NaN,
      species: m.speciesCol >= 0 ? csvUnguard((r[m.speciesCol] ?? '').trim()) : '',
    });
  }
  return out;
}

// --- Matching ----------------------------------------------------------

export interface Match {
  field: FieldTree;
  pointcloudlabeler: TreeMetric;
  distance: number;
}

/** Pair the calipered field trees with the trees PointCloudLabeler found, one to
 *  one, within the search radius. The optimal assignment — see
 *  metrics/assignment for why the greedy version this replaced lost
 *  real trees. */
export function matchTrees(fields: FieldTree[], metrics: TreeMetric[], radius: number) {
  const r = matchByPosition(
    fields, metrics,
    f => [f.x, f.y] as const,
    m => [m.x, m.y] as const,
    { radius },
  );
  return {
    matches: r.matches.map(p => ({ field: p.a, pointcloudlabeler: p.b, distance: p.distance })),
    unmatchedField: r.unmatchedA,
    unmatchedPointCloudLabeler: r.unmatchedB,
  };
}

// --- Statistics --------------------------------------------------------

export interface MetricStats {
  /** Pairs the figures rest on. */
  n: number;
  /** Matched pairs where one side had no usable measurement, so they
   *  are in none of the figures. */
  nUnusable: number;
  /** Mean (PointCloudLabeler − caliper). Positive = PointCloudLabeler overestimates. */
  bias: number;
  /** Root mean square difference about the 1:1 line, so it carries the
   *  bias: RMSE² = bias² + SD². */
  rmse: number;
  /** Coefficient of determination of the least-squares fit. NaN when
   *  every caliper reading is the same value and there is no fit. */
  r2: number;
  /** pointcloudlabeler ≈ slope · caliper + intercept. NaN when there is no fit. */
  slope: number;
  intercept: number;
  xMin: number; xMax: number;
  yMin: number; yMax: number;
}

/** Accuracy of PointCloudLabeler against the calipers, over the pairs where both
 *  sides actually measured something.
 *
 *  A finite number is not a measurement. The metrics pass reports a
 *  height of 0 for a tree with no ground surface beneath it, and 0 is
 *  finite — so an unmeasured tree entered the height validation as
 *  "PointCloudLabeler 0 m vs hypsometer 18 m" and dragged bias and RMSE with it. On
 *  a plot where one tree in twenty has no ground under it, a true bias
 *  of −0.1 m and RMSE of 0.6 m was reported as −1.0 m and 4.1 m: PointCloudLabeler
 *  looking seven times worse than it is, in the panel a user consults
 *  to decide whether to trust it. Field CSVs carry the same convention
 *  — a 0 in the height column means "not measured", not a tree of no
 *  height — so both sides are held to it. */
export function statsFor(pairs: { c: number; t: number }[]): MetricStats | null {
  const xs: number[] = [], ys: number[] = [];
  let nUnusable = 0;
  for (const p of pairs) {
    const ok = Number.isFinite(p.c) && p.c > 0 && Number.isFinite(p.t) && p.t > 0;
    if (!ok) { nUnusable++; continue; }
    xs.push(p.c); ys.push(p.t);
  }
  const n = xs.length;
  if (n < 2) return null;

  const sx = xs.reduce((a, b) => a + b, 0) / n;
  const sy = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, syy = 0, sxy = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - sx, dy = ys[i] - sy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    ss += (ys[i] - xs[i]) ** 2;
  }

  // No spread on the caliper axis ⇒ no line to fit. The old code
  // substituted slope 1 and printed "y = 1.000 x + b" as if it had
  // fitted one — a fabricated result is worse than a blank.
  let slope = NaN, intercept = NaN, r2 = NaN;
  if (sxx > 0) {
    slope = sxy / sxx;
    intercept = sy - slope * sx;
    let ssRes = 0;
    for (let i = 0; i < n; i++) ssRes += (ys[i] - (slope * xs[i] + intercept)) ** 2;
    // SS_res from the fitted line, not from 1:1.
    r2 = syy > 0 ? 1 - ssRes / syy : NaN;
  }

  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (xs[i] < xMin) xMin = xs[i]; if (xs[i] > xMax) xMax = xs[i];
    if (ys[i] < yMin) yMin = ys[i]; if (ys[i] > yMax) yMax = ys[i];
  }

  return {
    n, nUnusable,
    bias: ys.reduce((a, b, i) => a + (b - xs[i]), 0) / n,
    rmse: Math.sqrt(ss / n),
    r2, slope, intercept,
    xMin, xMax, yMin, yMax,
  };
}
