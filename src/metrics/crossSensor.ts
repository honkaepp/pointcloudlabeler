// Step 6 of the brief: match ALS- and TLS/MLS-based tree positions, and
// say how well they agree.
//
// The deliverable is one row per tree carrying the TLS-derived stem
// volume beside the ALS-derived metrics — the table a model is fitted
// on. What decides whether that table is worth fitting is the part the
// brief asks for and no package provides: the detection rate, broken
// down by size.
//
// The breakdown is the whole point. On a mature Nordic conifer plot ALS
// detection runs from near zero below 20 cm DBH to near total above
// 40 cm, and a single overall F1 hides that completely. A plot can show
// F1 = 0.78 while the model built on it cannot see a suppressed tree at
// all — which is exactly the claim the number would be used to support.

import type { TreeMetric } from '../persistence/octreeReader';
import { matchByPosition, type MatchMethod } from './assignment';
import { csvNum } from '../io/csv';

/** One tree as both sensors saw it. `als` or `tls` is null when only one
 *  of them found it — the row is kept either way, because a tree seen by
 *  one sensor and missed by the other is the finding, not a gap to drop
 *  before anyone notices. */
export interface JoinedTree {
  als: TreeMetric | null;
  tls: TreeMetric | null;
  /** Separation of the two stem positions (m); NaN when unmatched. */
  distance: number;
  /** Reference diameter for the size breakdown: the TLS one where it
   *  exists, since that is the measured one. */
  dbh: number;
}

export type Detection = 'matched' | 'alsOnly' | 'tlsOnly';

export function classify(t: JoinedTree): Detection {
  if (t.als && t.tls) return 'matched';
  return t.als ? 'alsOnly' : 'tlsOnly';
}

export interface JoinOptions {
  /** Pairs further apart than this are never made (m). ALS stem
   *  positions come from a crown apex or centroid, so they sit further
   *  from the stem than a TLS fit does — on a leaning or asymmetric
   *  crown, metres. 2–3 m is the usual working value. */
  radius: number;
  method?: MatchMethod;
}

export interface JoinResult {
  rows: JoinedTree[];
  /** Trees both sensors found. */
  nMatched: number;
  /** Found by ALS with no stem under it — a commission, or a TLS miss. */
  nAlsOnly: number;
  /** A measured stem the ALS pass did not find — an omission. */
  nTlsOnly: number;
}

/** Join the two tree lists on position.
 *
 *  TLS is the reference side by convention: it measures the stem
 *  directly, so a TLS tree with no ALS partner is an ALS omission
 *  rather than a TLS invention. */
export function joinSensors(
  als: TreeMetric[],
  tls: TreeMetric[],
  opts: JoinOptions,
): JoinResult {
  const r = matchByPosition(
    als, tls,
    a => [a.x, a.y] as const,
    t => [t.x, t.y] as const,
    { radius: opts.radius, method: opts.method },
  );

  const rows: JoinedTree[] = [];
  for (const p of r.matches) {
    rows.push({ als: p.a, tls: p.b, distance: p.distance, dbh: p.b.dbh });
  }
  for (const a of r.unmatchedA) {
    rows.push({ als: a, tls: null, distance: NaN, dbh: a.dbh });
  }
  for (const t of r.unmatchedB) {
    rows.push({ als: null, tls: t, distance: NaN, dbh: t.dbh });
  }

  return {
    rows,
    nMatched: r.matches.length,
    nAlsOnly: r.unmatchedA.length,
    nTlsOnly: r.unmatchedB.length,
  };
}

// --- Detection accuracy ------------------------------------------------

export interface DetectionStats {
  /** Matched — a measured stem the ALS pass also found. */
  truePositives: number;
  /** ALS found something with no measured stem under it. */
  falsePositives: number;
  /** A measured stem the ALS pass missed. */
  falseNegatives: number;
  /** TP / (TP + FN) — the share of real trees that were found. NaN when
   *  there were no real trees to find. */
  recall: number;
  /** TP / (TP + FP) — the share of detections that were real. */
  precision: number;
  /** Harmonic mean of the two. NaN when either is undefined. */
  f1: number;
}

export function detectionStats(rows: readonly JoinedTree[]): DetectionStats {
  let tp = 0, fp = 0, fn = 0;
  for (const t of rows) {
    const c = classify(t);
    if (c === 'matched') tp++;
    else if (c === 'alsOnly') fp++;
    else fn++;
  }
  // A rate over nothing is not zero, it is unknown. Reporting recall 0
  // for a plot with no reference trees would read as total failure.
  const recall = tp + fn > 0 ? tp / (tp + fn) : NaN;
  const precision = tp + fp > 0 ? tp / (tp + fp) : NaN;
  const f1 = Number.isFinite(recall) && Number.isFinite(precision) && recall + precision > 0
    ? (2 * recall * precision) / (recall + precision)
    : NaN;
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, recall, precision, f1 };
}

export interface SizeClassStats extends DetectionStats {
  /** Lower edge of the diameter class (m). */
  dbhLow: number;
  /** Upper edge, exclusive (m). Infinity for the open top class. */
  dbhHigh: number;
  /** Reference trees in this class — TP + FN. What recall rests on. */
  nReference: number;
}

/** Default diameter classes: 10 cm wide from 5 cm, open above 45 cm.
 *  Wide enough that a plot has trees in each, narrow enough to show the
 *  detection curve rising. */
export const DEFAULT_DBH_CLASSES: readonly number[] = [0.05, 0.15, 0.25, 0.35, 0.45];

/** Detection accuracy per diameter class.
 *
 *  Classified on the REFERENCE diameter — the TLS one — because that is
 *  the measurement. An ALS-only detection has no measured diameter, so
 *  it is counted as a false positive in whichever class its own estimate
 *  falls in, and where that estimate is missing it lands in the
 *  unclassified bucket rather than silently in the first class. */
export function detectionBySize(
  rows: readonly JoinedTree[],
  edges: readonly number[] = DEFAULT_DBH_CLASSES,
): { classes: SizeClassStats[]; unclassified: DetectionStats } {
  const bounds = [...edges].sort((a, b) => a - b);
  const buckets: JoinedTree[][] = bounds.map(() => []);
  const unplaced: JoinedTree[] = [];

  for (const t of rows) {
    const d = t.dbh;
    if (!Number.isFinite(d) || d <= 0 || d < bounds[0]) { unplaced.push(t); continue; }
    let k = 0;
    while (k + 1 < bounds.length && d >= bounds[k + 1]) k++;
    buckets[k].push(t);
  }

  return {
    classes: buckets.map((b, k) => ({
      dbhLow: bounds[k],
      dbhHigh: k + 1 < bounds.length ? bounds[k + 1] : Infinity,
      nReference: b.filter(t => t.tls !== null).length,
      ...detectionStats(b),
    })),
    unclassified: detectionStats(unplaced),
  };
}

// --- The deliverable table --------------------------------------------

/** One row of the exercise's data frame: TLS-derived stem volume beside
 *  the ALS-derived metrics, plus the detection outcome so a row that is
 *  present for only one sensor cannot be mistaken for a measured one. */
export interface JoinedRow {
  detection: Detection;
  separationM: number;
  tlsTreeId: number | null;
  tlsDbhM: number | null;
  tlsHeightM: number | null;
  /** TLS/MLS stem volume (m³) — the response variable. */
  tlsStemVolumeM3: number | null;
  alsTreeId: number | null;
  alsHeightM: number | null;
  alsCrownAreaM2: number | null;
  alsCrownDiameterM: number | null;
  alsDbhM: number | null;
}

const orNull = (v: number | undefined): number | null =>
  v !== undefined && Number.isFinite(v) && v > 0 ? v : null;

export function toRows(
  join: JoinResult,
  /** TLS stem volume per tree id, from the QSM. */
  stemVolume: Map<number, number> | null,
): JoinedRow[] {
  return join.rows.map(t => ({
    detection: classify(t),
    separationM: t.distance,
    tlsTreeId: t.tls ? t.tls.treeId : null,
    tlsDbhM: t.tls ? orNull(t.tls.dbh) : null,
    tlsHeightM: t.tls ? orNull(t.tls.height) : null,
    tlsStemVolumeM3: t.tls ? orNull(stemVolume?.get(t.tls.treeId)) : null,
    alsTreeId: t.als ? t.als.treeId : null,
    alsHeightM: t.als ? orNull(t.als.height) : null,
    alsCrownAreaM2: t.als ? orNull(t.als.crownArea) : null,
    alsCrownDiameterM: t.als ? orNull(t.als.crownDiameter) : null,
    alsDbhM: t.als ? orNull(t.als.dbh) : null,
  }));
}

export const JOINED_CSV_HEADER = [
  'detection', 'separation_m',
  'tls_tree_id', 'tls_dbh_m', 'tls_height_m', 'tls_stem_volume_m3',
  'als_tree_id', 'als_height_m', 'als_crown_area_m2', 'als_crown_diameter_m', 'als_dbh_m',
] as const;

/** A row as CSV cells, in JOINED_CSV_HEADER order. An absent value is an
 *  EMPTY cell, never a zero — a tree the other sensor never saw has no
 *  volume, and writing 0 there would be read as a measurement of nothing
 *  by whatever fits the model. */
export function rowToCells(r: JoinedRow): string[] {
  const n = csvNum;
  return [
    r.detection,
    n(r.separationM, 3),
    r.tlsTreeId == null ? '' : String(r.tlsTreeId),
    n(r.tlsDbhM, 4), n(r.tlsHeightM, 2), n(r.tlsStemVolumeM3, 5),
    r.alsTreeId == null ? '' : String(r.alsTreeId),
    n(r.alsHeightM, 2), n(r.alsCrownAreaM2, 2), n(r.alsCrownDiameterM, 2), n(r.alsDbhM, 4),
  ];
}
