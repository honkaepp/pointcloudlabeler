import { describe, it, expect } from 'vitest';
import {
  assign, matchByPosition, totalDistance, totalSquaredDistance, FORBIDDEN,
  type MatchMethod,
} from './assignment';

/** Brute force: the true minimum over every injective row→column map.
 *  Exponential, so only for tiny matrices — but it is a real oracle, not
 *  a second guess at the same algorithm. */
function bruteForce(cost: number[][]): { total: number; pairs: number } {
  const n = cost.length;
  const m = n > 0 ? cost[0].length : 0;
  let best = Infinity;
  let bestPairs = 0;
  const usedCol = new Array(m).fill(false);

  const walk = (row: number, total: number, pairs: number): void => {
    if (row === n) {
      // Prefer more pairs, then lower total — the same ordering the
      // forbidden-cost substitution enforces in the solver.
      if (pairs > bestPairs || (pairs === bestPairs && total < best)) {
        best = total; bestPairs = pairs;
      }
      return;
    }
    walk(row + 1, total, pairs);            // leave this row unassigned
    for (let j = 0; j < m; j++) {
      if (usedCol[j] || !Number.isFinite(cost[row][j])) continue;
      usedCol[j] = true;
      walk(row + 1, total + cost[row][j], pairs + 1);
      usedCol[j] = false;
    }
  };
  walk(0, 0, 0);
  return { total: bestPairs === 0 ? 0 : best, pairs: bestPairs };
}

function scoreOf(cost: number[][], colOf: number[]): { total: number; pairs: number } {
  let total = 0, pairs = 0;
  const seen = new Set<number>();
  for (let i = 0; i < colOf.length; i++) {
    const j = colOf[i];
    if (j < 0) continue;
    expect(seen.has(j), `column ${j} assigned twice`).toBe(false);
    seen.add(j);
    expect(Number.isFinite(cost[i][j]), `pair ${i}→${j} is forbidden`).toBe(true);
    total += cost[i][j]; pairs++;
  }
  return { total, pairs };
}

/** Deterministic pseudo-random costs — a fixed seed, so a failure is
 *  reproducible rather than a story about a run nobody kept. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

describe('assign — Hungarian', () => {
  it('solves the textbook 3×3', () => {
    const cost = [
      [4, 1, 3],
      [2, 0, 5],
      [3, 2, 2],
    ];
    const colOf = assign(cost);
    expect(scoreOf(cost, colOf).total).toBe(5);   // 4 + 0 + ... no: 1+2+2
  });

  it('takes the assignment, not the row minima', () => {
    // Row-wise greedy would take column 0 twice.
    const cost = [
      [1, 2],
      [1, 9],
    ];
    const colOf = assign(cost);
    expect(scoreOf(cost, colOf).total).toBe(3);   // 2 + 1, not 1 + 9
  });

  /** The property that matters, checked against exhaustive search. */
  it('matches brute force on 200 random square matrices', () => {
    const rnd = lcg(20260820);
    for (let t = 0; t < 200; t++) {
      const n = 1 + Math.floor(rnd() * 5);
      const cost = Array.from({ length: n }, () =>
        Array.from({ length: n }, () => Math.round(rnd() * 100)));
      const got = scoreOf(cost, assign(cost));
      const want = bruteForce(cost);
      expect(got.pairs, `n=${n} pairs`).toBe(want.pairs);
      expect(got.total, `n=${n} total`).toBeCloseTo(want.total, 9);
    }
  });

  it('matches brute force on rectangular matrices, both ways round', () => {
    const rnd = lcg(4711);
    for (let t = 0; t < 150; t++) {
      const n = 1 + Math.floor(rnd() * 5);
      const m = 1 + Math.floor(rnd() * 5);
      const cost = Array.from({ length: n }, () =>
        Array.from({ length: m }, () => Math.round(rnd() * 50)));
      const got = scoreOf(cost, assign(cost));
      const want = bruteForce(cost);
      expect(got.pairs, `${n}×${m} pairs`).toBe(want.pairs);
      expect(got.total, `${n}×${m} total`).toBeCloseTo(want.total, 9);
    }
  });

  it('matches brute force when some pairs are forbidden', () => {
    const rnd = lcg(1337);
    for (let t = 0; t < 150; t++) {
      const n = 1 + Math.floor(rnd() * 4);
      const m = 1 + Math.floor(rnd() * 4);
      const cost = Array.from({ length: n }, () =>
        Array.from({ length: m }, () => (rnd() < 0.4 ? FORBIDDEN : Math.round(rnd() * 40))));
      const got = scoreOf(cost, assign(cost));
      const want = bruteForce(cost);
      expect(got.pairs, `${n}×${m} pairs`).toBe(want.pairs);
      expect(got.total, `${n}×${m} total`).toBeCloseTo(want.total, 9);
    }
  });

  /** Maximising the number of pairs comes before minimising distance:
   *  a tree both sensors saw should be reported as seen by both, even if
   *  that costs a little total distance. */
  it('prefers more pairs over a lower total', () => {
    const cost = [
      [1, 2],
      [FORBIDDEN, 3],
    ];
    // Taking 1 leaves row 1 with only column 1 → total 4, two pairs.
    // Taking only the single cheapest pair would be total 1, one pair.
    const colOf = assign(cost);
    expect(scoreOf(cost, colOf)).toEqual({ total: 4, pairs: 2 });
  });

  it('never assigns a forbidden pair, even when nothing else is left', () => {
    const cost = [[FORBIDDEN, FORBIDDEN], [FORBIDDEN, FORBIDDEN]];
    expect(assign(cost)).toEqual([-1, -1]);
  });

  it('leaves rows unassigned when there are more rows than columns', () => {
    const colOf = assign([[1], [2], [3]]);
    expect(colOf.filter(j => j >= 0)).toHaveLength(1);
    expect(colOf[0]).toBe(0);   // the cheapest row takes the only column
  });

  it('treats NaN as forbidden rather than as a cost', () => {
    const cost = [[NaN, 5], [3, NaN]];
    expect(assign(cost)).toEqual([1, 0]);
  });

  it('handles degenerate shapes', () => {
    expect(assign([])).toEqual([]);
    expect(assign([[]])).toEqual([-1]);
    expect(assign([[7]])).toEqual([0]);
  });

  it('handles negative costs', () => {
    const cost = [[-5, -1], [-2, -8]];
    expect(scoreOf(cost, assign(cost)).total).toBeCloseTo(-13, 9);
  });

  it('does not mutate the caller\'s matrix', () => {
    const cost = [[1, 2], [3, 4]];
    const copy = cost.map(r => [...r]);
    assign(cost);
    expect(cost).toEqual(copy);
  });
});

// ---------------------------------------------------------------------

function pt(id: number, x: number, y: number) { return { id, x, y }; }
const XY = (t: { x: number; y: number }) => [t.x, t.y] as const;

function match(
  as: { id: number; x: number; y: number }[],
  bs: { id: number; x: number; y: number }[],
  radius: number,
  method: MatchMethod = 'optimal',
) {
  return matchByPosition(as, bs, XY, XY, { radius, method });
}

describe('matchByPosition', () => {
  it('pairs each tree with the one under it', () => {
    const r = match([pt(1, 0, 0), pt(2, 10, 0)], [pt(11, 0.3, 0), pt(12, 10.2, 0)], 2);
    expect(r.matches.map(p => [p.a.id, p.b.id])).toEqual([[1, 11], [2, 12]]);
    expect(r.unmatchedA).toHaveLength(0);
    expect(r.unmatchedB).toHaveLength(0);
  });

  it('reports the separation', () => {
    const r = match([pt(1, 0, 0)], [pt(11, 3, 4)], 10);
    expect(r.matches[0].distance).toBeCloseTo(5, 12);
  });

  it('never pairs beyond the radius', () => {
    const r = match([pt(1, 0, 0)], [pt(11, 5, 0)], 2);
    expect(r.matches).toHaveLength(0);
    expect(r.unmatchedA.map(a => a.id)).toEqual([1]);
    expect(r.unmatchedB.map(b => b.id)).toEqual([11]);
  });

  it('never claims either side twice', () => {
    const r = match([pt(1, 0, 0), pt(2, 0.2, 0)], [pt(11, 0.1, 0)], 5);
    expect(r.matches).toHaveLength(1);
    expect(r.unmatchedA).toHaveLength(1);
  });

  /** The defect that motivated this module. Greedy takes the globally
   *  shortest pair first; here that is A2–B1, which strands A1 with
   *  nothing in range. Both trees exist in both sensors and the plot
   *  loses one. */
  it('finds a tree greedy loses', () => {
    const as = [pt(1, 0, 0), pt(2, 1.0, 0)];
    const bs = [pt(11, 1.1, 0), pt(12, 2.0, 0)];
    // A1 reaches only B1 (1.1 m). A2 reaches B1 (0.1 m) and B2 (1.0 m).
    const greedy = match(as, bs, 1.5, 'greedy');
    const optimal = match(as, bs, 1.5, 'optimal');

    expect(greedy.matches).toHaveLength(1);
    expect(greedy.matches[0].a.id).toBe(2);
    expect(greedy.unmatchedA.map(a => a.id)).toEqual([1]);

    expect(optimal.matches).toHaveLength(2);
    expect(optimal.matches.map(p => [p.a.id, p.b.id]).sort())
      .toEqual([[1, 11], [2, 12]]);
  });

  it('never finds fewer pairs than greedy, on random plots', () => {
    const rnd = lcg(90210);
    for (let t = 0; t < 120; t++) {
      const n = 1 + Math.floor(rnd() * 8);
      const m = 1 + Math.floor(rnd() * 8);
      const as = Array.from({ length: n }, (_, i) => pt(i, rnd() * 10, rnd() * 10));
      const bs = Array.from({ length: m }, (_, i) => pt(100 + i, rnd() * 10, rnd() * 10));
      const g = match(as, bs, 2.5, 'greedy');
      const o = match(as, bs, 2.5, 'optimal');
      expect(o.matches.length, `trial ${t}`).toBeGreaterThanOrEqual(g.matches.length);
      // …and on the objective it actually minimises, never worse.
      if (o.matches.length === g.matches.length) {
        expect(totalSquaredDistance(o), `trial ${t}`)
          .toBeLessThanOrEqual(totalSquaredDistance(g) + 1e-9);
      }
    }
  });

  /** Writing the test above against Σd caught this, and the test was
   *  what was wrong. Minimising Σd² can accept a larger Σd: it refuses
   *  one implausible long pair to buy several ordinary ones, and for
   *  trees a long pair usually means a wrong pair. Pinned so nobody
   *  "fixes" the objective back to Σd on the strength of a total that
   *  looks worse. */
  it('can report a larger total distance than greedy, by design', () => {
    const rnd = lcg(90210);
    let sawLargerSumD = false;
    for (let t = 0; t < 120 && !sawLargerSumD; t++) {
      const n = 1 + Math.floor(rnd() * 8);
      const m = 1 + Math.floor(rnd() * 8);
      const as = Array.from({ length: n }, (_, i) => pt(i, rnd() * 10, rnd() * 10));
      const bs = Array.from({ length: m }, (_, i) => pt(100 + i, rnd() * 10, rnd() * 10));
      const g = match(as, bs, 2.5, 'greedy');
      const o = match(as, bs, 2.5, 'optimal');
      if (o.matches.length === g.matches.length
        && totalDistance(o) > totalDistance(g) + 1e-9) {
        sawLargerSumD = true;
        // Same pair count, larger Σd — and yet a smaller Σd².
        expect(totalSquaredDistance(o)).toBeLessThan(totalSquaredDistance(g));
      }
    }
    expect(sawLargerSumD, 'expected the squared objective to trade Σd somewhere').toBe(true);
  });

  it('leaves a tree with no position unmatched rather than at the origin', () => {
    const r = match([pt(1, NaN, NaN), pt(2, 0, 0)], [pt(11, 0.1, 0)], 5);
    expect(r.matches.map(p => p.a.id)).toEqual([2]);
    expect(r.unmatchedA.map(a => a.id)).toEqual([1]);
  });

  it('is order-independent', () => {
    const rnd = lcg(2718);
    const as = Array.from({ length: 7 }, (_, i) => pt(i, rnd() * 8, rnd() * 8));
    const bs = Array.from({ length: 7 }, (_, i) => pt(100 + i, rnd() * 8, rnd() * 8));
    const key = (r: ReturnType<typeof match>) =>
      r.matches.map(p => `${p.a.id}-${p.b.id}`).sort().join(',');
    for (const method of ['optimal', 'greedy'] as MatchMethod[]) {
      expect(key(match([...as].reverse(), [...bs].reverse(), 3, method)), method)
        .toBe(key(match(as, bs, 3, method)));
    }
  });

  it('is empty, not broken, with nothing on either side', () => {
    expect(match([], [pt(1, 0, 0)], 2).matches).toHaveLength(0);
    expect(match([pt(1, 0, 0)], [], 2).matches).toHaveLength(0);
    expect(match([], [], 2)).toEqual({ matches: [], unmatchedA: [], unmatchedB: [] });
  });

  it('a negative or non-finite radius matches nothing', () => {
    for (const radius of [-1, NaN, Infinity]) {
      expect(match([pt(1, 0, 0)], [pt(11, 0, 0)], radius).matches, `radius ${radius}`)
        .toHaveLength(0);
    }
  });

  /** Zero is a radius, not an error: it pairs trees at identical
   *  coordinates and nothing else. Clamping the invalid values above to
   *  0 would have quietly turned them into this case. */
  it('a zero radius pairs exact coincidences only', () => {
    expect(match([pt(1, 0, 0)], [pt(11, 0, 0)], 0).matches).toHaveLength(1);
    expect(match([pt(1, 0, 0)], [pt(11, 0.001, 0)], 0).matches).toHaveLength(0);
  });

  it('accounts for every tree exactly once', () => {
    const rnd = lcg(31415);
    for (let t = 0; t < 60; t++) {
      const as = Array.from({ length: 6 }, (_, i) => pt(i, rnd() * 6, rnd() * 6));
      const bs = Array.from({ length: 5 }, (_, i) => pt(100 + i, rnd() * 6, rnd() * 6));
      const r = match(as, bs, 2);
      expect(r.matches.length + r.unmatchedA.length).toBe(as.length);
      expect(r.matches.length + r.unmatchedB.length).toBe(bs.length);
    }
  });
});
