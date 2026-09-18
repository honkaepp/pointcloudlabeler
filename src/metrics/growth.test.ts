import { describe, it, expect } from 'vitest';
import type { TreeMetric } from '../persistence/octreeReader';
import { matchTrees, summarise, vol } from './growth';

/** A tree at (x, y) with a given DBH and height. `dbh: NaN` is a tree
 *  whose stem circle could not be fitted — the case that matters here. */
function tree(treeId: number, x: number, y: number, dbh: number, height: number): TreeMetric {
  return {
    treeId, count: 4000, height, dbh,
    basalArea: Number.isFinite(dbh) ? Math.PI * (dbh / 2) ** 2 : NaN,
    crownArea: 25, crownDiameter: 5.6,
    x, y, baseZ: 0, leanDeg: 0,
  };
}

const F = 0.5; // form factor

describe('matchTrees', () => {
  it('pairs each tree with its own stem and leaves the rest unclaimed', () => {
    const refs = [tree(1, 0, 0, 0.20, 18), tree(2, 5, 0, 0.25, 20), tree(3, 10, 0, 0.30, 22)];
    // Tree 2 is gone; a new one has appeared at (20, 0).
    const nows = [tree(11, 0.05, 0.02, 0.21, 18.4), tree(13, 10.03, 0, 0.31, 22.3), tree(14, 20, 0, 0.08, 6)];
    const r = matchTrees(refs, nows, 1.0);

    // Compared as a set: `matches` comes out in distance order, which is
    // a property of the greedy claim, not of which tree is which.
    const pairs = r.matches.map(m => [m.ref.treeId, m.now.treeId]).sort((a, b) => a[0] - b[0]);
    expect(pairs).toEqual([[1, 11], [3, 13]]);
    expect(r.harvested.map(t => t.treeId)).toEqual([2]);
    expect(r.ingrowth.map(t => t.treeId)).toEqual([14]);
  });

  it('claims the closest pair first, so a near miss cannot steal a partner', () => {
    // Two reference trees 0.6 m apart; one new stem sits nearer the
    // second. Greedy-by-distance must give it to the second, not to
    // whichever happens to come first in the array.
    const refs = [tree(1, 0, 0, 0.2, 18), tree(2, 0.6, 0, 0.2, 18)];
    const nows = [tree(9, 0.55, 0, 0.21, 18)];
    const r = matchTrees(refs, nows, 1.0);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].ref.treeId).toBe(2);
    expect(r.harvested.map(t => t.treeId)).toEqual([1]);
  });

  it('never matches one tree twice', () => {
    const refs = [tree(1, 0, 0, 0.2, 18), tree(2, 0.1, 0, 0.2, 18), tree(3, 0.2, 0, 0.2, 18)];
    const nows = [tree(9, 0.05, 0, 0.2, 18)];
    const r = matchTrees(refs, nows, 5.0);
    expect(r.matches).toHaveLength(1);
    expect(r.harvested).toHaveLength(2);
  });

  it('matches nothing when the radius excludes everything', () => {
    const r = matchTrees([tree(1, 0, 0, 0.2, 18)], [tree(2, 3, 0, 0.2, 18)], 1.0);
    expect(r.matches).toHaveLength(0);
    expect(r.harvested).toHaveLength(1);
    expect(r.ingrowth).toHaveLength(1);
  });
});

/** A stem circle that fitted in one scan and not the other says nothing
 *  about growth. Substituting a zero for the missing side does not
 *  produce a missing value — it produces the tree's ENTIRE volume as an
 *  increment or a loss, and occlusion differs between scans so the set
 *  of failures is not the same each time. */
describe('summarise', () => {
  it('differences volume only where both epochs measured one', () => {
    const refs = [tree(1, 0, 0, 0.30, 20), tree(2, 5, 0, 0.30, 20)];
    // Tree 2's stem could not be fitted in the new scan.
    const nows = [tree(1, 0, 0, 0.31, 20.5), tree(2, 5, 0, NaN, 20.5)];
    const s = summarise(matchTrees(refs, nows, 1.0), F);

    expect(s.n).toBe(2);
    expect(s.nVolPairs).toBe(1);
    // Only tree 1 contributes, and it grew.
    const expected = vol(nows[0], F) - vol(refs[0], F);
    expect(s.sumDv).toBeCloseTo(expected, 12);
    expect(s.sumDv).toBeGreaterThan(0);

    // What treating the missing fit as zero volume would have given: the
    // whole of tree 2 subtracted, turning a growing plot into a shrinking
    // one.
    const naive = expected + (0 - vol(refs[1], F));
    expect(naive).toBeLessThan(0);
  });

  it('reports how many pairs the volume figure actually rests on', () => {
    const refs = Array.from({ length: 10 }, (_, i) => tree(i, i * 5, 0, 0.3, 20));
    const nows = refs.map((t, i) => tree(t.treeId, t.x, t.y, i < 3 ? NaN : 0.31, 20.4));
    const s = summarise(matchTrees(refs, nows, 1.0), F);
    expect(s.n).toBe(10);
    expect(s.nVolPairs).toBe(7);
    expect(s.nDbhPairs).toBe(7);
  });

  it('leaves an unmeasurable harvested tree out of the removed volume, and says so', () => {
    const refs = [tree(1, 0, 0, 0.30, 20), tree(2, 5, 0, NaN, 18)];
    const s = summarise(matchTrees(refs, [], 1.0), F);
    expect(s.harvestedCount).toBe(2);
    expect(s.harvestedUnmeasured).toBe(1);
    expect(s.harvestedVol).toBeCloseTo(vol(refs[0], F), 12);
    expect(Number.isFinite(s.harvestedVol)).toBe(true);
  });

  it('does the same for ingrowth', () => {
    const nows = [tree(1, 0, 0, 0.08, 6), tree(2, 5, 0, NaN, 5)];
    const s = summarise(matchTrees([], nows, 1.0), F);
    expect(s.ingrowthCount).toBe(2);
    expect(s.ingrowthUnmeasured).toBe(1);
    expect(s.ingrowthVol).toBeCloseTo(vol(nows[0], F), 12);
  });

  it('averages DBH growth only over pairs that have a DBH at both ends', () => {
    const refs = [tree(1, 0, 0, 0.30, 20), tree(2, 5, 0, NaN, 20)];
    const nows = [tree(1, 0, 0, 0.32, 20), tree(2, 5, 0, 0.28, 20)];
    const s = summarise(matchTrees(refs, nows, 1.0), F);
    expect(s.nDbhPairs).toBe(1);
    expect(s.meanDdbh).toBeCloseTo(0.02, 12);
  });

  it('recovers a known increment exactly', () => {
    // Ten trees, each +1 cm DBH and +0.4 m height over the period.
    const refs = Array.from({ length: 10 }, (_, i) => tree(i, i * 4, 0, 0.25, 19));
    const nows = refs.map(t => tree(t.treeId, t.x, t.y, 0.26, 19.4));
    const s = summarise(matchTrees(refs, nows, 1.0), F);

    expect(s.n).toBe(10);
    expect(s.meanDdbh).toBeCloseTo(0.01, 12);
    expect(s.meanDh).toBeCloseTo(0.4, 12);
    const per = vol(nows[0], F) - vol(refs[0], F);
    expect(s.sumDv).toBeCloseTo(per * 10, 10);
    expect(s.harvestedCount).toBe(0);
    expect(s.ingrowthCount).toBe(0);
  });

  it('an empty comparison is zero, not NaN', () => {
    const s = summarise({ matches: [], harvested: [], ingrowth: [] }, F);
    expect(s.meanDdbh).toBe(0);
    expect(s.meanDh).toBe(0);
    expect(s.sumDv).toBe(0);
    expect(Number.isNaN(s.harvestedVol)).toBe(false);
    expect(Number.isNaN(s.ingrowthVol)).toBe(false);
  });
});

describe('vol', () => {
  it('is NaN when there is no stem fit, not zero', () => {
    expect(Number.isNaN(vol(tree(1, 0, 0, NaN, 20), F))).toBe(true);
    expect(vol(tree(1, 0, 0, 0.30, 20), F)).toBeCloseTo(Math.PI * 0.15 ** 2 * 20 * F, 12);
  });
});
