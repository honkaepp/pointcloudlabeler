import { describe, it, expect } from 'vitest';
import type { TreeMetric, QsmResult } from '../persistence/octreeReader';
import type { PlotBoundary } from '../components/shell/OctreeShellContext';
import { computePlotStats, treeStats } from './plotStats';

function tree(treeId: number, x: number, y: number, dbh: number, height: number): TreeMetric {
  return {
    treeId, count: 4000, height, dbh,
    basalArea: Number.isFinite(dbh) && dbh > 0 ? Math.PI * (dbh / 2) ** 2 : NaN,
    crownArea: 12, crownDiameter: 3.9,
    x, y, baseZ: 0, leanDeg: 0,
  };
}

/** A 20 × 20 m plot: 0.04 ha, so per-hectare figures are the plot sums
 *  times 25 — small enough to check in the head. */
const RECT: PlotBoundary = { kind: 'rectangular', min: [0, 0], max: [20, 20] };
const g = (d: number) => Math.PI * (d / 2) ** 2;

describe('computePlotStats', () => {
  it('scales the plot sums to a hectare', () => {
    const trees = [tree(1, 5, 5, 0.30, 20), tree(2, 15, 5, 0.20, 18), tree(3, 5, 15, 0.25, 19)];
    const s = computePlotStats(trees, RECT, 'none', 1.0, null);

    expect(s.areaHa).toBeCloseTo(0.04, 12);
    expect(s.nWeighted).toBe(3);
    expect(s.stemsPerHa).toBeCloseTo(75, 10);         // 3 / 0.04
    const ba = g(0.30) + g(0.20) + g(0.25);
    expect(s.basalAreaPerHa).toBeCloseTo(ba / 0.04, 10);
  });

  /** Lorey's mean height is Σ(g·h) / Σ(g), and both sums have to run
   *  over the same trees. They did not: a tree with a diameter but no
   *  height went into the denominator only, pulling the mean down as if
   *  it were a tree of height zero.
   *
   *  A height of 0 is what the metrics pass reports for a tree with no
   *  ground surface beneath it — an unmeasured tree, not a short one —
   *  so this is not an exotic case. */
  it('averages height over the trees that have one', () => {
    const trees = [
      tree(1, 5, 5, 0.30, 22),
      tree(2, 15, 5, 0.28, 21),
      tree(3, 5, 15, 0.35, 24),
      tree(4, 15, 15, 0.32, 0),   // no ground under it ⇒ no height
    ];
    const s = computePlotStats(trees, RECT, 'none', 1.0, null);

    const num = g(0.30) * 22 + g(0.28) * 21 + g(0.35) * 24;
    const den = g(0.30) + g(0.28) + g(0.35);
    expect(s.loreyMeanHeight).toBeCloseTo(num / den, 10);
    expect(s.nNoHeight).toBe(1);

    // What the mismatched denominator gave: a quarter lower, from one
    // tree in four.
    const withAll = num / (den + g(0.32));
    expect(withAll).toBeLessThan(s.loreyMeanHeight * 0.8);
  });

  it('still counts a tree with no height in the basal area', () => {
    // It has a real diameter; only its height is missing.
    const trees = [tree(1, 5, 5, 0.30, 20), tree(2, 15, 15, 0.32, 0)];
    const s = computePlotStats(trees, RECT, 'none', 1.0, null);
    expect(s.basalAreaPerHa).toBeCloseTo((g(0.30) + g(0.32)) / 0.04, 10);
    expect(s.nWeighted).toBe(2);
  });

  it('reports NaN rather than a number when no tree has both', () => {
    const s = computePlotStats([tree(1, 5, 5, 0.30, 0)], RECT, 'none', 1.0, null);
    expect(Number.isNaN(s.loreyMeanHeight)).toBe(true);
    expect(s.nNoHeight).toBe(1);
  });

  it('leaves a tree outside the boundary out of every figure', () => {
    const trees = [tree(1, 5, 5, 0.30, 20), tree(2, 50, 50, 0.30, 20)];
    const s = computePlotStats(trees, RECT, 'none', 1.0, null);
    expect(s.nOut).toBe(1);
    expect(s.nWeighted).toBe(1);
    expect(s.stemsPerHa).toBeCloseTo(25, 10);
    expect(s.insideRows).toHaveLength(1);
  });

  /** Half-count gives a boundary tree half the weight, which must show
   *  up in every sum, not just the stem count. */
  it('applies the inclusion weight to basal area and volume too', () => {
    // 0.5 m inside the edge, so within the 1 m half-count band.
    const trees = [tree(1, 0.5, 10, 0.30, 20)];
    const s = computePlotStats(trees, RECT, 'halfcount', 1.0, null);
    expect(s.nWeighted).toBeCloseTo(0.5, 12);
    expect(s.nPartial).toBe(1);
    expect(s.basalAreaPerHa).toBeCloseTo(0.5 * g(0.30) / 0.04, 10);
    // A weighted tree still contributes its full height to the mean —
    // the weight cancels between numerator and denominator.
    expect(s.loreyMeanHeight).toBeCloseTo(20, 10);
  });

  it('carries QSM volume and its interval through the same weights', () => {
    const qsm = {
      trees: [
        { treeId: 1, stemVolume: 0.8, stemVolumeCi95: 0.04 },
        { treeId: 2, stemVolume: 0.5, stemVolumeCi95: 0.03 },
      ],
    } as unknown as QsmResult;
    const trees = [tree(1, 5, 5, 0.30, 20), tree(2, 15, 15, 0.25, 19)];
    const s = computePlotStats(trees, RECT, 'none', 1.0, qsm);

    expect(s.hasQsm).toBe(true);
    expect(s.stemVolumePerHa).toBeCloseTo((0.8 + 0.5) / 0.04, 10);
    // Independent trees in quadrature, then scaled to a hectare.
    expect(s.stemVolumeCi95PerHa).toBeCloseTo(Math.hypot(0.04, 0.03) / 0.04, 10);
  });

  it('a tree with no position is out, not at the origin', () => {
    const trees = [tree(1, 5, 5, 0.30, 20), tree(2, NaN, NaN, 0.30, 20)];
    const s = computePlotStats(trees, RECT, 'none', 1.0, null);
    expect(s.nOut).toBe(1);
    expect(s.nWeighted).toBe(1);
  });

  it('an empty plot is zero, not NaN', () => {
    const s = computePlotStats([], RECT, 'none', 1.0, null);
    expect(s.stemsPerHa).toBe(0);
    expect(s.basalAreaPerHa).toBe(0);
    expect(Number.isNaN(s.loreyMeanHeight)).toBe(true);
    expect(Number.isNaN(s.stemVolumePerHa)).toBe(false);
  });

  it('a circular plot uses its own area', () => {
    const circ: PlotBoundary = { kind: 'circular', center: [0, 0], radius: 10 };
    const s = computePlotStats([tree(1, 1, 1, 0.30, 20)], circ, 'none', 1.0, null);
    expect(s.areaHa).toBeCloseTo(Math.PI * 100 / 10_000, 12);
    expect(s.stemsPerHa).toBeCloseTo(1 / (Math.PI * 0.01), 8);
  });
});

/** The unweighted core, shared by the report, the Density Metrics panel
 *  and (through computePlotStats) the Plot Boundary panel.
 *
 *  It exists because those three each computed the same plot figures
 *  independently and disagreed: two of them required a tree to have BOTH
 *  a diameter and a height before counting its basal area, which comes
 *  from the diameter alone. */
describe('treeStats', () => {
  const withGap = [
    tree(1, 0, 0, 0.30, 22),
    tree(2, 0, 0, 0.28, 21),
    tree(3, 0, 0, 0.35, 24),
    tree(4, 0, 0, 0.32, 0),   // measured stem, no ground beneath it
  ];

  it('counts every tree and says what each figure rests on', () => {
    const s = treeStats(withGap);
    expect(s.treeCount).toBe(4);
    expect(s.nWithDbh).toBe(4);
    expect(s.nWithHeight).toBe(3);
  });

  it('sums basal area from the diameter alone', () => {
    const s = treeStats(withGap);
    expect(s.basalAreaTotal).toBeCloseTo(g(0.30) + g(0.28) + g(0.35) + g(0.32), 12);
  });

  it('weights Lorey height over the trees that have both', () => {
    const s = treeStats(withGap);
    const num = g(0.30) * 22 + g(0.28) * 21 + g(0.35) * 24;
    const den = g(0.30) + g(0.28) + g(0.35);
    expect(s.loreyMeanHeight).toBeCloseTo(num / den, 10);
  });

  it('takes dominant height from the measured heights only', () => {
    const s = treeStats(withGap);
    // 3 measured heights ⇒ top 10 % is 1 stem ⇒ the tallest.
    expect(s.topNCount).toBe(1);
    expect(s.dominantHeight).toBeCloseTo(24, 12);
  });

  it('reports NaN rather than a number when nothing is measurable', () => {
    const s = treeStats([tree(1, 0, 0, NaN, 0)]);
    expect(s.treeCount).toBe(1);
    expect(s.basalAreaTotal).toBe(0);
    expect(Number.isNaN(s.loreyMeanHeight)).toBe(true);
    expect(Number.isNaN(s.dominantHeight)).toBe(true);
  });

  it('an empty list is empty, not NaN-valued counts', () => {
    const s = treeStats([]);
    expect(s.treeCount).toBe(0);
    expect(s.nWithDbh).toBe(0);
    expect(s.basalAreaTotal).toBe(0);
  });

  /** The property that made this shared: the basal area the panel scales
   *  to a hectare is the same total the report prints. */
  it('agrees with the per-hectare path on basal area', () => {
    const s = treeStats(withGap);
    const perHa = computePlotStats(withGap, RECT, 'none', 1.0, null);
    expect(perHa.basalAreaPerHa * perHa.areaHa).toBeCloseTo(s.basalAreaTotal, 10);
    expect(perHa.loreyMeanHeight).toBeCloseTo(s.loreyMeanHeight, 10);
  });
});
