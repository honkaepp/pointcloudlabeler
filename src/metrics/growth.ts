// Multi-temporal per-tree increment between two epochs: match the same
// tree across two scans, then difference what was measured.
//
// Extracted from TreeGrowthPanel so the arithmetic can be tested on trees
// whose growth is known. The panel keeps the UI.
//
// The one rule everything here follows: a difference is only a growth
// figure when BOTH epochs measured the thing being differenced. A stem
// circle that fitted in one scan and not the other says nothing about
// growth, and quietly substituting a zero for the missing side turns a
// measurement failure into a specific, plausible, wrong number.

import type { TreeMetric } from '../persistence/octreeReader';
import { matchByPosition } from './assignment';

export interface Pair {
  ref: TreeMetric;
  now: TreeMetric;
  distance: number;
}

export interface GrowthResult {
  matches: Pair[];
  /** Reference trees with no partner now — harvested / fallen. */
  harvested: TreeMetric[];
  /** Active trees with no partner before — ingrowth / new. */
  ingrowth: TreeMetric[];
}

/** Greedy bipartite nearest-neighbour on stem-base XY. Build every
 *  candidate pair within the search radius, sort by distance ascending,
 *  claim in order — no double-claims. The unclaimed lists are the
 *  harvested and ingrowth trees.
 *
 *  The position this matches on is the stem BASE (see `stem_base` in the
 *  metrics pass): a crown centroid moves as the crown grows, and even
 *  the breast-height section moves when a stem leans or sways, so
 *  neither can carry a radius this small. */
/** Trees are matched on the stem BASE, which is the only point on a
 *  leaning or swaying stem that does not move between scans. */
const XY = (t: TreeMetric) => [t.x, t.y] as const;

export function matchTrees(refs: TreeMetric[], nows: TreeMetric[], radius: number): GrowthResult {
  const r = matchByPosition(refs, nows, XY, XY, { radius });
  return {
    matches: r.matches.map(m => ({ ref: m.a, now: m.b, distance: m.distance })),
    harvested: r.unmatchedA,
    ingrowth: r.unmatchedB,
  };
}

/** Form-factor stem volume estimate (m³): basal area × height × f.
 *
 *  NaN when the stem circle could not be fitted, and that NaN is the
 *  point. It used to return 0 in that case, which reads as "this tree
 *  has no wood in it" — and since growth is a difference between epochs,
 *  a tree fitted in one scan and not the other then contributed its
 *  ENTIRE volume as growth or as loss. Occlusion differs between scans,
 *  so which trees fail is not the same set each time; on a plot where a
 *  fifth of the stems fail in one epoch that is enough to turn a growing
 *  stand's net increment negative. */
export function vol(t: TreeMetric, f: number): number {
  return Number.isFinite(t.basalArea) ? t.basalArea * t.height * f : NaN;
}

export interface Summary {
  /** Matched pairs. */
  n: number;
  /** Pairs where BOTH epochs produced a DBH. */
  nDbhPairs: number;
  /** Pairs where BOTH epochs produced a volume. */
  nVolPairs: number;
  meanDdbh: number;   // m, over nDbhPairs
  meanDh: number;     // m, over n
  sumDv: number;      // m³, over nVolPairs
  harvestedCount: number;
  harvestedVol: number;
  /** Harvested trees with no fitted stem, so no volume to remove. */
  harvestedUnmeasured: number;
  ingrowthCount: number;
  ingrowthVol: number;
  /** Ingrowth trees with no fitted stem. */
  ingrowthUnmeasured: number;
}

/** Sum of the finite entries, plus how many were not finite. */
function sumMeasured(values: number[]): { sum: number; missing: number } {
  let sum = 0, missing = 0;
  for (const v of values) {
    if (Number.isFinite(v)) sum += v;
    else missing++;
  }
  return { sum, missing };
}

export function summarise(res: GrowthResult, f: number): Summary {
  let sumDdbh = 0, nDbh = 0, sumDh = 0, nH = 0, sumDv = 0, nVol = 0;
  for (const m of res.matches) {
    if (Number.isFinite(m.now.dbh) && Number.isFinite(m.ref.dbh)) {
      sumDdbh += m.now.dbh - m.ref.dbh; nDbh++;
    }
    if (Number.isFinite(m.now.height) && Number.isFinite(m.ref.height)) {
      sumDh += m.now.height - m.ref.height; nH++;
    }
    // Both sides, or neither: a volume difference against a missing
    // measurement is not an increment.
    const vNow = vol(m.now, f), vRef = vol(m.ref, f);
    if (Number.isFinite(vNow) && Number.isFinite(vRef)) {
      sumDv += vNow - vRef; nVol++;
    }
  }
  const harvested = sumMeasured(res.harvested.map(t => vol(t, f)));
  const ingrowth = sumMeasured(res.ingrowth.map(t => vol(t, f)));
  return {
    n: res.matches.length,
    nDbhPairs: nDbh,
    nVolPairs: nVol,
    meanDdbh: nDbh > 0 ? sumDdbh / nDbh : 0,
    meanDh: nH > 0 ? sumDh / nH : 0,
    sumDv,
    harvestedCount: res.harvested.length,
    harvestedVol: harvested.sum,
    harvestedUnmeasured: harvested.missing,
    ingrowthCount: res.ingrowth.length,
    ingrowthVol: ingrowth.sum,
    ingrowthUnmeasured: ingrowth.missing,
  };
}
