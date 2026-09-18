// Thinning simulator — harvennuksen simulaatio.
//
// Set a target post-thinning basal area (m²/ha); this decides which
// trees come out and where the strip roads run.
//
//   1. Strip-road centrelines: parallel lines at the chosen heading and
//      spacing across the stand.
//   2. Forced removal — anything within road_width / 2 of a centreline
//      has to go so the harvester can pass.
//   3. Boom-reach candidates — within boom_reach of a centreline.
//      Beyond that the harvester cannot get to it.
//   4. Score the candidates, sort descending, remove greedily until the
//      target basal area is reached or the pool runs out.
//
// Extracted from ThinningPanel so it can be tested. This is the file
// that decides which trees get cut, and it had no tests.

import type { TreeMetric, QsmResult } from '../persistence/octreeReader';
import { resolveVolume, tallySources, describeVolumeSources, type ResolvedVolume, type VolumeTally } from './volumeFunctions';

export type Strategy = 'low' | 'high' | 'quality' | 'mixed';

export interface Tree {
  treeId: number;
  x: number;
  y: number;
  dbh: number;
  height: number;
  /** Basal area (m²). */
  ba: number;
  /** Stem volume (m³) — the QSM's when there is one, otherwise an
   *  allometric estimate. `volumeSource` says which. */
  volume: number;
  volumeSource: ResolvedVolume['source'];
  /** QSM angular coverage (0..1). NaN when the tree has no QSM — NOT 1.
   *  A tree that was never assessed is not a tree that scored perfectly,
   *  and the quality term has to be able to tell the difference. */
  confidence: number;
  bbox?: { min: [number, number, number]; max: [number, number, number] };
}

export interface Road { x1: number; y1: number; x2: number; y2: number }

export interface Plan {
  forced: Tree[];
  candidates: Tree[];
  unreachable: Tree[];
  removed: Tree[];
  roads: Road[];
  baAfter: number;
  baBefore: number;
  plotAreaHa: number;
  cannotReachTarget: boolean;
  /** Whether the quality term had any input. False when no tree carries
   *  a QSM confidence, in which case the quality weight is redistributed
   *  — see `strategyWeights`. */
  qualityAvailable: boolean;
}

/** Trees for the simulator, plus what had to be left out of it.
 *
 *  A tree with no fitted DBH cannot contribute a basal area, so it
 *  cannot be in the arithmetic. It used to be dropped and never
 *  mentioned: the stand basal area, the removal target and the tree
 *  count were all computed over the survivors of a filter nothing on
 *  screen disclosed, and the exported harvest list simply had no row
 *  for those stems — so a harvester working the plan meets trees that
 *  are not on it. They are counted now, and the panel says so. */
export interface TreeSet {
  trees: Tree[];
  /** How each tree's volume was produced, for the panel to disclose. */
  volumeSources: VolumeTally;
  /** Metrics rows with no usable DBH, so absent from every figure. */
  nNoDbh: number;
  /** Trees whose volume is an allometric guess rather than a QSM. */
  nAllometric: number;
  /** Trees with a height of 0 — unmeasured, not short — whose
   *  allometric volume is therefore 0 and priced at nothing. */
  nNoHeight: number;
}

/** Conservative boreal-softwood form factor for the fallback volume
 *  v ≈ basal area × height × f. */
export const FORM_FACTOR = 0.50;

export function buildTrees(
  metrics: TreeMetric[],
  qsm: QsmResult | null,
  bboxes: Map<number, { min: [number, number, number]; max: [number, number, number] }> | null,
  /** Per-tree species (species.json). Unlocks the national volume
   *  function; without it every tree falls back to the form factor. */
  speciesByTree?: Map<number, string> | null,
  /** Species for trees with no assignment. */
  defaultSpecies?: string | null,
): TreeSet {
  const qsmMap = new Map<number, { v: number; conf: number }>();
  if (qsm) for (const t of qsm.trees) qsmMap.set(t.treeId, { v: t.stemVolume, conf: t.confidence });

  const trees: Tree[] = [];
  let nNoDbh = 0, nAllometric = 0, nNoHeight = 0;
  const resolved: ResolvedVolume[] = [];
  const qsmVolumes = new Map<number, number>();
  for (const [id, v] of qsmMap) qsmVolumes.set(id, v.v);
  for (const t of metrics) {
    if (!Number.isFinite(t.dbh) || t.dbh <= 0) { nNoDbh++; continue; }
    const ba = Math.PI * (t.dbh * 0.5) ** 2;
    const q = qsmMap.get(t.treeId);
    // One resolver decides QSM > national function > form factor, and
    // says which it used — the three are a measurement, a published
    // model and a placeholder, and the harvest revenue multiplies
    // whichever it got by a price per cubic metre.
    const rv = resolveVolume(t, {
      qsm: qsmVolumes, speciesByTree, defaultSpecies, formFactor: FORM_FACTOR,
    });
    resolved.push(rv);
    // 0 is what the arithmetic needs for a tree nothing could be
    // estimated for, but it is an unmeasured tree, not a worthless one.
    const volume = Number.isFinite(rv.volume) ? rv.volume : 0;
    const volumeSource = rv.source;
    if (rv.source === 'formFactor') nAllometric++;
    if (rv.source === 'none') nNoHeight++;
    trees.push({
      treeId: t.treeId, x: t.x, y: t.y, dbh: t.dbh, height: t.height,
      ba, volume, volumeSource,
      confidence: q ? q.conf : NaN,
      bbox: bboxes?.get(t.treeId),
    });
  }
  return { trees, nNoDbh, nAllometric, nNoHeight, volumeSources: tallySources(resolved) };
}

export interface Weights { qual: number; small: number; large: number }

/** Weights for a strategy.
 *
 *  `hasQuality` is false when no tree carries a QSM confidence. The
 *  quality term is then the same constant for every tree, and leaving
 *  its weight in place does not make the score neutral — it shrinks the
 *  spread of everything that IS informative while the tie-break jitter
 *  keeps its full size. "Quality thinning" without a QSM used to be
 *  0.80 × a constant + 0.20 × size + jitter, which put a quarter of the
 *  ordering in the tie-breaker: a strategy the user selected, that
 *  looked like it was working, and was mostly noise.
 *
 *  With no quality signal the weight is redistributed over the terms
 *  that have one. The panel says the quality term is unavailable — a
 *  silent renormalisation would be a second undisclosed strategy. */
export function strategyWeights(strategy: Strategy, hasQuality: boolean): Weights {
  let w: Weights;
  switch (strategy) {
    case 'low':     w = { qual: 0.30, small: 0.70, large: 0.0 }; break;
    case 'high':    w = { qual: 0.30, small: 0.0,  large: 0.70 }; break;
    case 'quality': w = { qual: 0.80, small: 0.20, large: 0.0 }; break;
    case 'mixed':   w = { qual: 0.50, small: 0.50, large: 0.0 }; break;
  }
  if (hasQuality) return w;
  const rest = w.small + w.large;
  if (rest <= 0) {
    // 'quality' is the only strategy that could in principle have no
    // size term at all; it does not today, but a future preset might.
    return { qual: 0, small: 1, large: 0 };
  }
  const k = 1 / rest;
  return { qual: 0, small: w.small * k, large: w.large * k };
}

/** Deterministic per-tree tie-breaker in [0, 1). Knuth's multiplicative
 *  hash — same tree, same value, so re-running gives the same plan. */
export function treeJitter(treeId: number): number {
  return ((treeId >>> 0) * 2654435761 % 4294967296) / 4294967296;
}

/** How much of the score the tie-breaker is allowed to move. Small
 *  enough to only split trees the weighted terms rank equally. */
export const JITTER_WEIGHT = 0.05;

export function scoreTree(t: Tree, w: Weights, jitter: number, dbhMax: number): number {
  // Low confidence → high score → removed first. An unassessed tree
  // (NaN) scores 0 on this term rather than counting as a perfect stem.
  const conf = Number.isFinite(t.confidence) ? Math.max(0, Math.min(1, t.confidence)) : 1;
  const sQual = 1 - conf;
  const sSmall = dbhMax > 0 ? 1 - t.dbh / dbhMax : 0;
  const sLarge = dbhMax > 0 ? t.dbh / dbhMax : 0;
  return w.qual * sQual + w.small * sSmall + w.large * sLarge + jitter * JITTER_WEIGHT;
}

/** Strip-road centrelines covering the bbox at the given spacing and
 *  heading. */
export function generateRoads(
  bbox: { xMin: number; yMin: number; xMax: number; yMax: number },
  headingDeg: number,
  spacing: number,
): Road[] {
  if (!(spacing > 0) || !Number.isFinite(bbox.xMin) || !Number.isFinite(bbox.xMax)) return [];
  const theta = (headingDeg * Math.PI) / 180;
  const dir = [Math.cos(theta), Math.sin(theta)];
  const norm = [-Math.sin(theta), Math.cos(theta)];
  const cx = (bbox.xMin + bbox.xMax) * 0.5;
  const cy = (bbox.yMin + bbox.yMax) * 0.5;
  const corners = [
    [bbox.xMin, bbox.yMin], [bbox.xMax, bbox.yMin],
    [bbox.xMax, bbox.yMax], [bbox.xMin, bbox.yMax],
  ];
  let nMin = Infinity, nMax = -Infinity, dMin = Infinity, dMax = -Infinity;
  for (const [x, y] of corners) {
    const rx = x - cx, ry = y - cy;
    const n = rx * norm[0] + ry * norm[1];
    const d = rx * dir[0] + ry * dir[1];
    if (n < nMin) nMin = n; if (n > nMax) nMax = n;
    if (d < dMin) dMin = d; if (d > dMax) dMax = d;
  }
  const out: Road[] = [];
  const startN = Math.ceil(nMin / spacing) * spacing;
  for (let n = startN; n <= nMax; n += spacing) {
    out.push({
      x1: cx + dir[0] * dMin + norm[0] * n,
      y1: cy + dir[1] * dMin + norm[1] * n,
      x2: cx + dir[0] * dMax + norm[0] * n,
      y2: cy + dir[1] * dMax + norm[1] * n,
    });
  }
  return out;
}

/** Distance from a point to the nearest road centreline. Infinity when
 *  there are no roads — nothing is reachable without one. */
export function distToNearestRoad(x: number, y: number, roads: Road[]): number {
  let best = Infinity;
  for (const r of roads) {
    const dx = r.x2 - r.x1, dy = r.y2 - r.y1;
    const L2 = dx * dx + dy * dy;
    if (L2 === 0) continue;
    const t = ((x - r.x1) * dx + (y - r.y1) * dy) / L2;
    const tc = Math.max(0, Math.min(1, t));
    const px = r.x1 + dx * tc, py = r.y1 + dy * tc;
    const d = Math.hypot(x - px, y - py);
    if (d < best) best = d;
  }
  return best;
}

export interface SimulateOptions {
  targetBaPerHa: number;
  plotAreaHa: number;
  headingDeg: number;
  roadSpacing: number;
  roadWidth: number;
  boomReach: number;
  strategy: Strategy;
}

export function simulate(trees: Tree[], o: SimulateOptions): Plan {
  const area = o.plotAreaHa > 0 ? o.plotAreaHa : 1e-6;

  // A tree with no position needs no guard here: NaN fails both
  // comparisons, so it never moves the bbox. It then measures NaN to
  // every road, fails both the corridor and the boom-reach test, and
  // lands in `unreachable` — which is the right answer for a stem
  // nobody can drive to. Its basal area still counts toward the stand.
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const t of trees) {
    if (t.x < xMin) xMin = t.x; if (t.x > xMax) xMax = t.x;
    if (t.y < yMin) yMin = t.y; if (t.y > yMax) yMax = t.y;
  }
  const pad = o.roadWidth;
  const roads = generateRoads(
    { xMin: xMin - pad, yMin: yMin - pad, xMax: xMax + pad, yMax: yMax + pad },
    o.headingDeg, o.roadSpacing,
  );

  const halfWidth = o.roadWidth * 0.5;
  const forced: Tree[] = [];
  const candidates: Tree[] = [];
  const unreachable: Tree[] = [];
  for (const t of trees) {
    const d = distToNearestRoad(t.x, t.y, roads);
    if (d <= halfWidth) forced.push(t);
    else if (d <= o.boomReach) candidates.push(t);
    else unreachable.push(t);
  }

  const baTotal = trees.reduce((a, b) => a + b.ba, 0);
  const baBefore = baTotal / area;
  const baForced = forced.reduce((a, b) => a + b.ba, 0) / area;
  const baToRemove = Math.max(0, baBefore - baForced - o.targetBaPerHa);

  const qualityAvailable = trees.some(t => Number.isFinite(t.confidence));
  const w = strategyWeights(o.strategy, qualityAvailable);
  const dbhMax = trees.reduce((m, t) => (t.dbh > m ? t.dbh : m), 0);
  const scored = candidates
    // The jitter is keyed to the tree id, so no two trees score exactly
    // alike and the ranking does not depend on the order the metrics
    // happened to arrive in. That — not the sort — is what makes the
    // plan reproducible; an explicit id tie-break here would be a
    // branch that can never be taken.
    .map(t => ({ t, s: scoreTree(t, w, treeJitter(t.treeId), dbhMax) }))
    .sort((a, b) => b.s - a.s);

  const removedCands: Tree[] = [];
  let baOut = 0;
  for (const { t } of scored) {
    if (baOut / area >= baToRemove) break;
    removedCands.push(t);
    baOut += t.ba;
  }
  const removed = [...forced, ...removedCands];
  const baAfter = (baTotal - removed.reduce((a, b) => a + b.ba, 0)) / area;
  const cannotReachTarget =
    baAfter > o.targetBaPerHa + 0.05 && removedCands.length === candidates.length;

  return {
    forced, candidates: scored.map(s => s.t), unreachable, removed,
    roads, baAfter, baBefore, plotAreaHa: o.plotAreaHa, cannotReachTarget,
    qualityAvailable,
  };
}
