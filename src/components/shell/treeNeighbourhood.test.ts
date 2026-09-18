import { describe, it, expect } from 'vitest';
import { farExtent, isolateGeomFor, neighboursOf } from './treeNeighbourhood';
import { HORIZ_MAX_HALF_EXTENT } from '../../three/filterGeometry';
import type { TreeSummaryEntry } from '../../persistence/octreeReader';

/** A tree standing at (x, y) with a σ-core of `r` metres horizontally
 *  and a 20 m stem. */
function tree(id: number, x: number, y: number, r = 0.6, count = 5000): TreeSummaryEntry {
  return {
    treeId: id,
    count,
    bboxMin: [x - r * 3, y - r * 3, 100],
    bboxMax: [x + r * 3, y + r * 3, 120],
    centroid: [x, y, 108],
    sigma: [r, r, 5],
  };
}

describe('isolateGeomFor', () => {
  it('anchors on the density centre, not the bbox centre', () => {
    // A tree whose bbox is dragged 40 m east by a handful of strays.
    const t = tree(1, 0, 0);
    t.bboxMax = [40, 2, 120];
    const g = isolateGeomFor(t);
    expect(g.anchor).not.toBeNull();
    expect(g.anchor![0]).toBeCloseTo(0, 6);
    const midX = (g.box[0][0] + g.box[1][0]) * 0.5;
    expect(midX).toBeCloseTo(0, 6);
  });

  it('keeps the full bbox height so the stump stays in the box', () => {
    const g = isolateGeomFor(tree(1, 0, 0));
    expect(g.box[0][2]).toBe(100);
    expect(g.box[1][2]).toBe(120);
  });

  it('gives a sparse sapling a workable 1.5 m half-extent either way', () => {
    // The 1.5 m floor is UNCONDITIONAL: it applies to the bbox cap as
    // well as to the σ term, so a thread-thin tree cannot end up with a
    // neighbourhood too small to drag stray points into. Both a
    // 0.15 m-wide bbox and a 5 m one land on 1.5 m here.
    const thin = isolateGeomFor(tree(1, 0, 0, 0.05));
    expect((thin.box[1][0] - thin.box[0][0]) * 0.5).toBeCloseTo(1.5, 6);
    const roomy = tree(2, 0, 0, 0.05);
    roomy.bboxMin = [-5, -5, 100];
    roomy.bboxMax = [5, 5, 120];
    expect((isolateGeomFor(roomy).box[1][0] - isolateGeomFor(roomy).box[0][0]) * 0.5)
      .toBeCloseTo(1.5, 6);
  });

  it('uses 2.5σ once the tree is bigger than the floor, capped by the bbox', () => {
    // A real crown: σ 2 m ⇒ 5 m half-extent, and the bbox (±6 m) has
    // room for it.
    const big = tree(1, 0, 0, 2);
    expect((big.bboxMax[0] - big.bboxMin[0]) * 0.5).toBeCloseTo(6, 6);
    expect((isolateGeomFor(big).box[1][0] - isolateGeomFor(big).box[0][0]) * 0.5)
      .toBeCloseTo(5, 6);
    // …and the bbox caps it when σ over-reaches: the same σ inside a
    // 3 m-wide bbox gives 1.5 m, not 5 m.
    const clipped = tree(2, 0, 0, 2);
    clipped.bboxMin = [-1.5, -1.5, 100];
    clipped.bboxMax = [1.5, 1.5, 120];
    expect((isolateGeomFor(clipped).box[1][0] - isolateGeomFor(clipped).box[0][0]) * 0.5)
      .toBeCloseTo(1.5, 6);
  });

  it('falls back to the raw bbox when the scan has no density stats', () => {
    const t = tree(1, 3, 4);
    const legacy = { ...t, centroid: undefined, sigma: undefined } as unknown as TreeSummaryEntry;
    const g = isolateGeomFor(legacy);
    expect(g.anchor).toBeNull();
    expect(g.box[0]).toEqual(t.bboxMin);
    expect(g.box[1]).toEqual(t.bboxMax);
  });
});

describe('neighboursOf', () => {
  /** Selected tree at the origin plus rings of others going out. */
  const plot: TreeSummaryEntry[] = [
    tree(1, 0, 0),
    tree(2, 3, 0),
    tree(3, 0, -2),
    tree(4, 30, 30),   // far away — never a neighbour
    tree(0, 0.2, 0.2), // the unassigned bucket, never a neighbour
  ];

  it('lists the nearby trees, nearest first, and excludes the tree itself', () => {
    const n = neighboursOf(plot, 1, 2);
    expect(n.map(x => x.id)).toEqual([3, 2]);
    expect(n[0].dist).toBeCloseTo(2, 6);
    expect(n[1].dist).toBeCloseTo(3, 6);
    expect(n.some(x => x.id === 1)).toBe(false);
    expect(n.some(x => x.id === 0)).toBe(false);
    expect(n.some(x => x.id === 4)).toBe(false);
  });

  it('widens with the margin, which is the control the panel offers', () => {
    // Half-extent is 1.5 m (the σ floor), the neighbour's core reaches
    // 1.5 m back toward it, so 3 m apart needs no margin at all…
    expect(neighboursOf(plot, 1, 0).map(x => x.id)).toEqual([3, 2]);
    // …but a tree 12 m out needs one.
    const far = [...plot, tree(9, 12, 0)];
    expect(neighboursOf(far, 1, 2).some(x => x.id === 9)).toBe(false);
    expect(neighboursOf(far, 1, 10).some(x => x.id === 9)).toBe(true);
  });

  it('cannot reach further than the viewer will draw', () => {
    // The box's half-extent is clamped at HORIZ_MAX_HALF_EXTENT BEFORE
    // the margin, so a tree whose own bbox spans the plot does not turn
    // every tree in that direction into a "neighbour" — the same clamp
    // the renderer applies, which is the point of sharing the constant.
    const sprawling = tree(1, 0, 0);
    sprawling.bboxMin = [-60, -60, 100];
    sprawling.bboxMax = [60, 60, 120];
    sprawling.sigma = [40, 40, 5];
    const n = neighboursOf([sprawling, tree(5, 25, 0)], 1, 2);
    expect(HORIZ_MAX_HALF_EXTENT).toBe(8);
    // 8 m box + 2 m margin + the neighbour's own 1.8 m core = 11.8 m
    // reach; 25 m is well outside it.
    expect(n).toEqual([]);
  });

  it('is empty rather than throwing on the inputs the panel really passes', () => {
    // Per-axis reach: a neighbour 6 m east is within an east–west reach
    // of 5 and not within a north–south reach of 5 — the list follows
    // the box.
    const cross = [tree(1, 0, 0), tree(2, 6, 0), tree(3, 0, 6), tree(4, -6, 0), tree(5, 0, -6)];
    expect(neighboursOf(cross, 1, [5, 0, 0]).map(x => x.id)).toEqual([2, 4]);
    expect(neighboursOf(cross, 1, [0, 5, 0]).map(x => x.id)).toEqual([3, 5]);
    // Per-direction reach: east alone finds the eastern neighbour and
    // not the western; north alone the northern and not the southern.
    expect(neighboursOf(cross, 1, [0, 5, 0, 0, 0, 0]).map(x => x.id)).toEqual([2]);
    expect(neighboursOf(cross, 1, [5, 0, 0, 0, 0, 0]).map(x => x.id)).toEqual([4]);
    expect(neighboursOf(cross, 1, [0, 0, 0, 5, 0, 0]).map(x => x.id)).toEqual([3]);
    expect(neighboursOf(cross, 1, [0, 0, 5, 0, 0, 0]).map(x => x.id)).toEqual([5]);
    // …and the vertical reaches change nothing here — the band is a
    // live control and must not empty the list.
    expect(neighboursOf(cross, 1, [0, 0, 0, 0, 50, 50])).toEqual([]);
    expect(neighboursOf(null, 1, 2)).toEqual([]);
    expect(neighboursOf(plot, null, 2)).toEqual([]);
    expect(neighboursOf(plot, 0, 2)).toEqual([]);      // the unassigned bucket
    expect(neighboursOf(plot, 999, 2)).toEqual([]);    // an id not in the scan
    expect(neighboursOf([], 1, 2)).toEqual([]);
    expect(neighboursOf(plot, 1, NaN).length).toBeGreaterThan(0); // margin guarded
  });

  it('drops a tree whose position is not a number', () => {
    const broken = tree(7, NaN, NaN);
    broken.bboxMin = [NaN, NaN, NaN];
    broken.bboxMax = [NaN, NaN, NaN];
    const n = neighboursOf([...plot, broken], 1, 2);
    expect(n.some(x => x.id === 7)).toBe(false);
    expect(n.map(x => x.id)).toEqual([3, 2]);
  });

  it('ties break on the id, so the list order is stable across runs', () => {
    // Two neighbours at exactly the same distance — the review panel's
    // chips must not swap places between renders.
    const sym = [tree(1, 0, 0), tree(8, 2, 0), tree(6, -2, 0)];
    expect(neighboursOf(sym, 1, 2).map(x => x.id)).toEqual([6, 8]);
  });
});

describe('farExtent', () => {
  const compact: TreeSummaryEntry = {
    treeId: 5, count: 1000,
    bboxMin: [-4, -4, 0], bboxMax: [4, 4, 20],
    centroid: [0, 0, 10], sigma: [2, 2, 5],
  };
  it('is zero for a tree the box holds', () => {
    expect(farExtent(compact, isolateGeomFor(compact))).toBe(0);
  });
  it('is the reach of the far cluster for a tree whose id covers one', () => {
    // Tree 228: a clean tree, and fifty metres away a cluster with the
    // same id. The density box stays on the tree; the bbox does not.
    const t: TreeSummaryEntry = { ...compact, treeId: 228, bboxMax: [54, 4, 20] };
    const d = farExtent(t, isolateGeomFor(t));
    expect(d).toBeGreaterThan(40);
    expect(d).toBeLessThanOrEqual(54);
  });
});
