import { describe, it, expect } from 'vitest';
import type { TreeMetric, QsmResult } from '../persistence/octreeReader';
import {
  buildTrees, strategyWeights, scoreTree, treeJitter, generateRoads,
  distToNearestRoad, simulate, JITTER_WEIGHT, FORM_FACTOR,
  type Tree, type Strategy, type SimulateOptions,
} from './thinning';

function metric(treeId: number, x: number, y: number, dbh: number, height = 20): TreeMetric {
  return {
    treeId, count: 4000, height, dbh,
    basalArea: Number.isFinite(dbh) && dbh > 0 ? Math.PI * (dbh / 2) ** 2 : NaN,
    crownArea: 12, crownDiameter: 3.9, x, y, baseZ: 0, leanDeg: 0,
  };
}

function tree(treeId: number, x: number, y: number, dbh: number, confidence = NaN): Tree {
  return {
    treeId, x, y, dbh, height: 20,
    ba: Math.PI * (dbh / 2) ** 2, volume: 0.5, volumeSource: 'formFactor',
    confidence,
  };
}

const OPTS: SimulateOptions = {
  targetBaPerHa: 18, plotAreaHa: 0.04, headingDeg: 0,
  roadSpacing: 20, roadWidth: 4, boomReach: 10, strategy: 'low',
};

const g = (d: number) => Math.PI * (d / 2) ** 2;

/** A tree with no fitted DBH cannot contribute a basal area, so it
 *  cannot be in the arithmetic. It used to be dropped and never
 *  mentioned — the stand basal area, the removal target and the tree
 *  count were all taken over the survivors of a filter nothing on screen
 *  disclosed, and the exported harvest list had no row for those stems.
 *  A harvester working the plan meets trees that are not on it. */
describe('buildTrees', () => {
  it('counts what it had to leave out instead of dropping it silently', () => {
    const s = buildTrees([
      metric(1, 0, 0, 0.30), metric(2, 1, 0, NaN), metric(3, 2, 0, 0), metric(4, 3, 0, -1),
    ], null, null);
    expect(s.trees).toHaveLength(1);
    expect(s.nNoDbh).toBe(3);
  });

  it('takes the QSM volume and confidence when there is one', () => {
    const qsm = { trees: [{ treeId: 1, stemVolume: 0.83, confidence: 0.62 }] } as unknown as QsmResult;
    const s = buildTrees([metric(1, 0, 0, 0.30)], qsm, null);
    expect(s.trees[0].volume).toBeCloseTo(0.83, 12);
    expect(s.trees[0].confidence).toBeCloseTo(0.62, 12);
    expect(s.trees[0].volumeSource).toBe('qsm');
    expect(s.nAllometric).toBe(0);
  });

  it('falls back to basal area × height × form factor, and says so', () => {
    const s = buildTrees([metric(1, 0, 0, 0.30, 22)], null, null);
    expect(s.trees[0].volume).toBeCloseTo(g(0.30) * 22 * FORM_FACTOR, 12);
    expect(s.trees[0].volumeSource).toBe('formFactor');
    expect(s.nAllometric).toBe(1);
  });

  /** A height of 0 is what the metrics pass reports for a tree with no
   *  ground surface beneath it — unmeasured, not short. Its allometric
   *  volume is 0, so it is priced at nothing in the harvest revenue. */
  it('counts the trees whose volume could not be estimated at all', () => {
    const s = buildTrees([metric(1, 0, 0, 0.30, 0)], null, null);
    expect(s.trees[0].volume).toBe(0);
    expect(s.trees[0].volumeSource).toBe('none');
    expect(s.nNoHeight).toBe(1);
  });

  /** Confidence is the quality term's only input. A tree with no QSM was
   *  given 1.0 — indistinguishable from a perfectly assessed stem. */
  it('leaves confidence unset rather than perfect when there is no QSM', () => {
    const s = buildTrees([metric(1, 0, 0, 0.30)], null, null);
    expect(Number.isNaN(s.trees[0].confidence)).toBe(true);
  });

  it('is empty, not NaN-valued, for no metrics', () => {
    expect(buildTrees([], null, null)).toEqual({
      trees: [], nNoDbh: 0, nAllometric: 0, nNoHeight: 0,
      volumeSources: { qsm: 0, laasasenaho: 0, formFactor: 0, none: 0 },
    });
  });

  /** The national volume function, once the species is known. Without a
   *  species every tree falls back to the form factor — a constant, and
   *  the harvest revenue multiplies it by a price per cubic metre. */
  it('uses the national function when the species is known', () => {
    const m = [metric(1, 0, 0, 0.25, 20)];
    const withSp = buildTrees(m, null, null, new Map([[1, 'pine']]));
    const without = buildTrees(m, null, null);

    expect(withSp.trees[0].volumeSource).toBe('laasasenaho');
    expect(without.trees[0].volumeSource).toBe('formFactor');
    // Different numbers, and both plausible — which is exactly why the
    // column has to say which one it is.
    expect(withSp.trees[0].volume).not.toBeCloseTo(without.trees[0].volume, 3);
  });

  it('takes a fallback species for trees with no assignment', () => {
    const s = buildTrees([metric(1, 0, 0, 0.25, 20)], null, null, null, 'spruce');
    expect(s.trees[0].volumeSource).toBe('laasasenaho');
  });

  it('counts how each volume was produced', () => {
    const qsm = { trees: [{ treeId: 1, stemVolume: 0.8, confidence: 0.7 }] } as unknown as QsmResult;
    const s = buildTrees(
      [metric(1, 0, 0, 0.30), metric(2, 1, 0, 0.25), metric(3, 2, 0, 0.25, 0)],
      qsm, null, new Map([[2, 'pine']]),
    );
    expect(s.volumeSources).toEqual({ qsm: 1, laasasenaho: 1, formFactor: 0, none: 1 });
  });
});

/** "Quality thinning" without a QSM used to be 0.80 × a constant +
 *  0.20 × size + a 0.05 jitter. The constant does not make the score
 *  neutral — it shrinks the spread of the one informative term while the
 *  tie-breaker keeps its full size, so a quarter of the ordering was
 *  noise. The user picked a strategy, it looked like it was working, and
 *  it was mostly random. */
describe('strategyWeights', () => {
  const STRATEGIES: Strategy[] = ['low', 'high', 'quality', 'mixed'];

  it('sums to one, with or without a quality signal', () => {
    for (const s of STRATEGIES) {
      for (const has of [true, false]) {
        const w = strategyWeights(s, has);
        expect(w.qual + w.small + w.large, `${s}/${has}`).toBeCloseTo(1, 12);
      }
    }
  });

  it('drops the quality term and redistributes it when no QSM exists', () => {
    const w = strategyWeights('quality', false);
    expect(w.qual).toBe(0);
    expect(w.small).toBeCloseTo(1, 12);
  });

  it('keeps the shape of a strategy that mixes two size terms', () => {
    // 'high' is 0.30 quality + 0.70 large; without quality it is all large.
    const w = strategyWeights('high', false);
    expect(w.qual).toBe(0);
    expect(w.large).toBeCloseTo(1, 12);
    expect(w.small).toBe(0);
  });

  it('leaves the weights alone when a QSM is present', () => {
    expect(strategyWeights('quality', true)).toEqual({ qual: 0.80, small: 0.20, large: 0.0 });
    expect(strategyWeights('low', true)).toEqual({ qual: 0.30, small: 0.70, large: 0.0 });
  });

  /** The measurable consequence: with the quality weight redistributed,
   *  the tie-breaker is a twentieth of the signal rather than a quarter. */
  it('leaves the tie-breaker small next to the informative spread', () => {
    const w = strategyWeights('quality', false);
    const spread = w.small + w.large;          // sSmall/sLarge span [0, 1]
    expect(JITTER_WEIGHT / spread).toBeLessThanOrEqual(0.05);
    const old = 0.20;                          // the size weight it used to keep
    expect(JITTER_WEIGHT / old).toBeGreaterThan(0.2);
  });
});

describe('scoreTree', () => {
  const w = strategyWeights('low', true);

  it('ranks a small tree above a large one under low thinning', () => {
    const small = scoreTree(tree(1, 0, 0, 0.10), w, 0, 0.40);
    const large = scoreTree(tree(2, 0, 0, 0.40), w, 0, 0.40);
    expect(small).toBeGreaterThan(large);
  });

  it('ranks a large tree above a small one under high thinning', () => {
    const wh = strategyWeights('high', true);
    expect(scoreTree(tree(2, 0, 0, 0.40), wh, 0, 0.40))
      .toBeGreaterThan(scoreTree(tree(1, 0, 0, 0.10), wh, 0, 0.40));
  });

  it('ranks a poorly covered stem above a well covered one', () => {
    const wq = strategyWeights('quality', true);
    const bad = scoreTree(tree(1, 0, 0, 0.30, 0.20), wq, 0, 0.40);
    const good = scoreTree(tree(2, 0, 0, 0.30, 0.95), wq, 0, 0.40);
    expect(bad).toBeGreaterThan(good);
  });

  it('treats an unassessed tree as unremarkable, not as perfect', () => {
    const wq = strategyWeights('quality', true);
    // NaN confidence scores the same as a fully covered stem on the
    // quality term — it must not be pushed to the front of the queue.
    expect(scoreTree(tree(1, 0, 0, 0.30, NaN), wq, 0, 0.40))
      .toBeCloseTo(scoreTree(tree(2, 0, 0, 0.30, 1.0), wq, 0, 0.40), 12);
  });

  it('clamps a confidence outside 0..1 instead of letting it dominate', () => {
    const wq = strategyWeights('quality', true);
    expect(scoreTree(tree(1, 0, 0, 0.30, 5), wq, 0, 0.40))
      .toBeCloseTo(scoreTree(tree(2, 0, 0, 0.30, 1), wq, 0, 0.40), 12);
    expect(scoreTree(tree(3, 0, 0, 0.30, -5), wq, 0, 0.40))
      .toBeCloseTo(scoreTree(tree(4, 0, 0, 0.30, 0), wq, 0, 0.40), 12);
  });

  it('is bounded, so the jitter cannot outrank a real difference', () => {
    for (const s of ['low', 'high', 'quality', 'mixed'] as Strategy[]) {
      const ws = strategyWeights(s, true);
      const v = scoreTree(tree(1, 0, 0, 0.2, 0.5), ws, 1, 0.4);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1 + JITTER_WEIGHT);
    }
  });

  it('does not divide by zero when every tree is the same size', () => {
    expect(Number.isFinite(scoreTree(tree(1, 0, 0, 0.3), w, 0, 0))).toBe(true);
  });
});

describe('treeJitter', () => {
  it('is the same value for the same tree every run', () => {
    expect(treeJitter(4711)).toBe(treeJitter(4711));
  });

  it('stays inside [0, 1) for ids across the range', () => {
    for (const id of [0, 1, 2, 255, 65535, 1_000_000, 2_147_483_647]) {
      const j = treeJitter(id);
      expect(j, `id ${id}`).toBeGreaterThanOrEqual(0);
      expect(j, `id ${id}`).toBeLessThan(1);
    }
  });

  it('spreads ids apart rather than clumping them', () => {
    const vs = Array.from({ length: 200 }, (_, i) => treeJitter(i + 1));
    expect(new Set(vs).size).toBe(200);
    const buckets = new Array(10).fill(0);
    for (const v of vs) buckets[Math.min(9, Math.floor(v * 10))]++;
    for (const b of buckets) expect(b).toBeGreaterThan(0);
  });
});

describe('generateRoads', () => {
  const bbox = { xMin: -50, yMin: -50, xMax: 50, yMax: 50 };

  it('lays parallel roads at the requested spacing', () => {
    const roads = generateRoads(bbox, 0, 20);
    expect(roads.length).toBeGreaterThan(2);
    // Heading 0 ⇒ roads run along +x, offset along +y.
    for (const r of roads) expect(r.y1).toBeCloseTo(r.y2, 9);
    const ys = roads.map(r => r.y1).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeCloseTo(20, 9);
  });

  it('turns with the heading', () => {
    const roads = generateRoads(bbox, 90, 20);
    for (const r of roads) expect(r.x1).toBeCloseTo(r.x2, 9);
  });

  it('spans the whole bbox', () => {
    const roads = generateRoads(bbox, 0, 20);
    const ys = roads.map(r => r.y1);
    expect(Math.min(...ys)).toBeLessThanOrEqual(bbox.yMin + 20);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(bbox.yMax - 20);
  });

  /** A road set that walks backwards forever, or a bbox built from an
   *  empty tree list, must come back empty rather than filling memory. */
  it('returns nothing for a non-positive spacing', () => {
    expect(generateRoads(bbox, 0, 0)).toEqual([]);
    expect(generateRoads(bbox, 0, -20)).toEqual([]);
    expect(generateRoads(bbox, 0, NaN)).toEqual([]);
  });

  it('returns nothing for an empty bbox', () => {
    expect(generateRoads({ xMin: Infinity, yMin: Infinity, xMax: -Infinity, yMax: -Infinity }, 0, 20)).toEqual([]);
  });
});

describe('distToNearestRoad', () => {
  const roads = [{ x1: -50, y1: 0, x2: 50, y2: 0 }, { x1: -50, y1: 20, x2: 50, y2: 20 }];

  it('measures perpendicular distance to the closest centreline', () => {
    expect(distToNearestRoad(0, 3, roads)).toBeCloseTo(3, 12);
    expect(distToNearestRoad(0, 16, roads)).toBeCloseTo(4, 12);
    expect(distToNearestRoad(0, 0, roads)).toBeCloseTo(0, 12);
  });

  it('is Infinity with no roads — nothing is reachable', () => {
    expect(distToNearestRoad(0, 0, [])).toBe(Infinity);
  });

  it('ignores a degenerate zero-length road', () => {
    expect(distToNearestRoad(0, 5, [{ x1: 1, y1: 1, x2: 1, y2: 1 }])).toBe(Infinity);
  });
});

describe('simulate', () => {
  /** A 100 × 100 m stand on a 3 m grid, DBH varying with position —
   *  dense enough (≈ 47 m²/ha) that a 18 m²/ha target needs real
   *  candidate thinning and not just the road corridors. */
  function stand(): Tree[] {
    const out: Tree[] = [];
    let id = 1;
    for (let x = -45; x <= 45; x += 3) {
      for (let y = -45; y <= 45; y += 3) {
        out.push(tree(id, x, y, 0.12 + ((id * 7) % 23) * 0.01));
        id++;
      }
    }
    return out;
  }
  const OPT = { ...OPTS, plotAreaHa: 1.0, targetBaPerHa: 18 };

  /** Basal area per hectare left after the road corridors alone. Below
   *  the target, candidate thinning never runs. */
  function baAfterForced(p: ReturnType<typeof simulate>): number {
    return p.baBefore - p.forced.reduce((a, t) => a + t.ba, 0) / p.plotAreaHa;
  }

  it('puts every tree in exactly one of forced / candidate / unreachable', () => {
    const trees = stand();
    const p = simulate(trees, OPT);
    expect(p.forced.length + p.candidates.length + p.unreachable.length).toBe(trees.length);
    const ids = new Set([...p.forced, ...p.candidates, ...p.unreachable].map(t => t.treeId));
    expect(ids.size).toBe(trees.length);
  });

  it('forces out everything standing in a road corridor', () => {
    const p = simulate(stand(), OPT);
    for (const t of p.forced) {
      expect(distToNearestRoad(t.x, t.y, p.roads)).toBeLessThanOrEqual(OPT.roadWidth * 0.5 + 1e-9);
    }
    expect(p.forced.length).toBeGreaterThan(0);
  });

  it('never removes a tree the boom cannot reach', () => {
    const p = simulate(stand(), OPT);
    const unreach = new Set(p.unreachable.map(t => t.treeId));
    for (const t of p.removed) expect(unreach.has(t.treeId)).toBe(false);
  });

  it('removes down to the target basal area', () => {
    const trees = stand();
    const p = simulate(trees, OPT);
    expect(p.baBefore).toBeGreaterThan(OPT.targetBaPerHa);
    expect(baAfterForced(p)).toBeGreaterThan(OPT.targetBaPerHa);  // candidates do run
    expect(p.baAfter).toBeLessThanOrEqual(OPT.targetBaPerHa);
    expect(p.cannotReachTarget).toBe(false);
  });

  /** Greedy removal checks the target BEFORE taking each tree, so the
   *  last one always crosses it — you cannot remove a fraction of a
   *  stem. The overshoot has to be bounded by one tree, though:
   *  over-thinning is the mistake you cannot undo. */
  it('overshoots the target by at most one tree', () => {
    const trees = stand();
    const p = simulate(trees, OPT);
    const maxBa = Math.max(...trees.map(t => t.ba));
    expect(p.baAfter).toBeGreaterThan(OPT.targetBaPerHa - maxBa / OPT.plotAreaHa);
  });

  it('removes nothing beyond the road corridor when already below target', () => {
    const p = simulate(stand(), { ...OPT, targetBaPerHa: 1000 });
    expect(p.removed.map(t => t.treeId).sort()).toEqual(p.forced.map(t => t.treeId).sort());
  });

  it('flags a target the road layout cannot expose enough trees for', () => {
    const p = simulate(stand(), { ...OPT, targetBaPerHa: 0.1, boomReach: 2.5 });
    expect(p.cannotReachTarget).toBe(true);
    expect(p.baAfter).toBeGreaterThan(0.1);
  });

  it('is deterministic — the same stand gives the same plan', () => {
    const a = simulate(stand(), OPT).removed.map(t => t.treeId);
    const b = simulate(stand(), OPT).removed.map(t => t.treeId);
    expect(a).toEqual(b);
  });

  /** A plan that depends on the order the metrics happened to arrive in
   *  is not a plan, it is a coincidence. */
  it('does not depend on the order the trees are listed in', () => {
    const a = simulate(stand(), OPT).removed.map(t => t.treeId).sort((x, y) => x - y);
    const b = simulate([...stand()].reverse(), OPT).removed.map(t => t.treeId).sort((x, y) => x - y);
    expect(b).toEqual(a);
  });

  it('takes the small stems first under low thinning', () => {
    const p = simulate(stand(), { ...OPT, strategy: 'low' });
    const sel = p.removed.filter(t => !p.forced.includes(t));
    const kept = p.candidates.filter(t => !sel.includes(t));
    if (sel.length > 0 && kept.length > 0) {
      const meanSel = sel.reduce((a, t) => a + t.dbh, 0) / sel.length;
      const meanKept = kept.reduce((a, t) => a + t.dbh, 0) / kept.length;
      expect(meanSel).toBeLessThan(meanKept);
    }
  });

  it('takes the large stems first under high thinning', () => {
    const p = simulate(stand(), { ...OPT, strategy: 'high' });
    const sel = p.removed.filter(t => !p.forced.includes(t));
    const kept = p.candidates.filter(t => !sel.includes(t));
    if (sel.length > 0 && kept.length > 0) {
      const meanSel = sel.reduce((a, t) => a + t.dbh, 0) / sel.length;
      const meanKept = kept.reduce((a, t) => a + t.dbh, 0) / kept.length;
      expect(meanSel).toBeGreaterThan(meanKept);
    }
  });

  it('reports that the quality term had nothing to work with', () => {
    expect(simulate(stand(), OPT).qualityAvailable).toBe(false);
    const withQsm = stand().map((t, i) => ({ ...t, confidence: i % 2 ? 0.4 : 0.9 }));
    expect(simulate(withQsm, OPT).qualityAvailable).toBe(true);
  });

  /** With the quality weight redistributed, 'quality' thinning without a
   *  QSM behaves as the size thinning it has actually become — rather
   *  than as a mostly-random selection that looks like quality work. */
  it('quality thinning without a QSM sorts by size, not by chance', () => {
    const p = simulate(stand(), { ...OPT, strategy: 'quality' });
    const sel = p.removed.filter(t => !p.forced.includes(t));
    const kept = p.candidates.filter(t => !sel.includes(t));
    if (sel.length > 0 && kept.length > 0) {
      const meanSel = sel.reduce((a, t) => a + t.dbh, 0) / sel.length;
      const meanKept = kept.reduce((a, t) => a + t.dbh, 0) / kept.length;
      expect(meanSel).toBeLessThan(meanKept);
    }
  });

  it('an empty stand is a plan with nothing in it, not NaN', () => {
    const p = simulate([], OPT);
    expect(p.removed).toEqual([]);
    expect(p.roads).toEqual([]);
    expect(p.baBefore).toBe(0);
    expect(p.baAfter).toBe(0);
  });

  it('does not divide by a zero plot area', () => {
    const p = simulate(stand(), { ...OPT, plotAreaHa: 0 });
    expect(Number.isFinite(p.baBefore)).toBe(true);
    expect(Number.isFinite(p.baAfter)).toBe(true);
  });

  /** A stem the segmentation found but could not place. It must not
   *  drag the road layout to the origin, must not be cut sight-unseen,
   *  and must still count toward the stand it is standing in. */
  it('leaves a tree with no position unreachable, not removed', () => {
    const lost = tree(9999, NaN, NaN, 0.3);
    const p = simulate([...stand(), lost], OPT);
    const ref = simulate(stand(), OPT);
    expect(p.roads.length).toBe(ref.roads.length);
    expect(p.unreachable.map(t => t.treeId)).toContain(9999);
    expect(p.removed.map(t => t.treeId)).not.toContain(9999);
    expect(p.baBefore).toBeCloseTo(ref.baBefore + lost.ba / OPT.plotAreaHa, 10);
  });

  /** The jitter is what makes the plan reproducible: keyed to the tree
   *  id, it gives every tree a distinct score even when they are
   *  otherwise identical, so the ranking cannot fall back on the order
   *  the metrics happened to arrive in. */
  it('is order-independent even when every tree is the same size', () => {
    const trees = stand().map(t => ({ ...t, dbh: 0.25, ba: Math.PI * 0.125 ** 2 }));
    const a = simulate(trees, OPT).removed.map(t => t.treeId).sort((x, y) => x - y);
    const b = simulate([...trees].reverse(), OPT).removed.map(t => t.treeId).sort((x, y) => x - y);
    expect(b).toEqual(a);
    // …and the scores really are all distinct, which is why.
    const scores = new Set(trees.map(t => treeJitter(t.treeId)));
    expect(scores.size).toBe(trees.length);
  });

  it('accounts for every removed tree exactly once', () => {
    const p = simulate(stand(), OPT);
    expect(new Set(p.removed.map(t => t.treeId)).size).toBe(p.removed.length);
    const baSum = p.removed.reduce((a, t) => a + t.ba, 0);
    expect(p.baBefore - baSum / p.plotAreaHa).toBeCloseTo(p.baAfter, 10);
  });
});
