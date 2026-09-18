import { describe, it, expect } from 'vitest';
import type { PlotBoundary } from '../components/shell/OctreeShellContext';
import {
  plotAreaHa, stemCentreInside, signedDistanceToBoundary,
  crownFractionInside, treeWeight, fitRectangularToBbox,
  fitCircularToBbox, parsePlotBoundary,
} from './plotBoundary';

const RECT: PlotBoundary = { kind: 'rectangular', min: [0, 0], max: [20, 30] };
const CIRC: PlotBoundary = { kind: 'circular', center: [10, 10], radius: 8 };

/** Area is the denominator of every per-hectare figure in the app. */
describe('plotAreaHa', () => {
  it('rectangular is the side product', () => {
    expect(plotAreaHa(RECT)).toBeCloseTo(600 / 10_000, 15);
  });

  it('circular is π·r²', () => {
    expect(plotAreaHa(CIRC)).toBeCloseTo(Math.PI * 64 / 10_000, 15);
  });

  /** An inverted rectangle (min > max — a hand-edited plot.json) used
   *  to multiply two negative sides into a PLAUSIBLE POSITIVE area for
   *  a boundary that can contain no tree. */
  it('an inverted rectangle has no area, not a positive one', () => {
    expect(plotAreaHa({ kind: 'rectangular', min: [20, 30], max: [0, 0] })).toBe(0);
    // One axis inverted: no negative area either.
    expect(plotAreaHa({ kind: 'rectangular', min: [0, 30], max: [20, 0] })).toBe(0);
  });
});

describe('stemCentreInside', () => {
  it('rectangular: in, out, and exactly on the edge', () => {
    expect(stemCentreInside([10, 15], RECT)).toBe(true);
    expect(stemCentreInside([-0.01, 15], RECT)).toBe(false);
    expect(stemCentreInside([0, 15], RECT)).toBe(true);   // edge counts in
    expect(stemCentreInside([20, 30], RECT)).toBe(true);  // corner counts in
  });

  it('circular: in, out, and exactly on the rim', () => {
    expect(stemCentreInside([10, 10], CIRC)).toBe(true);
    expect(stemCentreInside([18, 10], CIRC)).toBe(true);  // on the rim
    expect(stemCentreInside([18.01, 10], CIRC)).toBe(false);
  });
});

describe('signedDistanceToBoundary', () => {
  it('is negative inside, by the distance to the nearest edge', () => {
    expect(signedDistanceToBoundary([10, 15], RECT)).toBeCloseTo(-10, 12);
    expect(signedDistanceToBoundary([3, 15], RECT)).toBeCloseTo(-3, 12);
    expect(signedDistanceToBoundary([10, 28], RECT)).toBeCloseTo(-2, 12);
  });

  it('is positive outside, by the distance back to the plot', () => {
    expect(signedDistanceToBoundary([-4, 15], RECT)).toBeCloseTo(4, 12);
    expect(signedDistanceToBoundary([10, 33], RECT)).toBeCloseTo(3, 12);
  });

  /** Diagonally off a corner, the distance is the hypotenuse. The
   *  per-axis maximum alone is the Chebyshev distance, which understated
   *  it by up to √2: a stem 3 m east and 4 m north of the corner is 5 m
   *  from the plot, not 4 m. */
  it('measures a corner offset as the hypotenuse, not the larger leg', () => {
    expect(signedDistanceToBoundary([23, 34], RECT)).toBeCloseTo(5, 12);
    expect(signedDistanceToBoundary([-3, -4], RECT)).toBeCloseTo(5, 12);
  });

  it('is zero exactly on the boundary', () => {
    expect(signedDistanceToBoundary([0, 15], RECT)).toBeCloseTo(0, 12);
    expect(signedDistanceToBoundary([18, 10], CIRC)).toBeCloseTo(0, 12);
  });

  it('circular: r − d, negative inside', () => {
    expect(signedDistanceToBoundary([10, 10], CIRC)).toBeCloseTo(-8, 12);
    expect(signedDistanceToBoundary([15, 10], CIRC)).toBeCloseTo(-3, 12);
    expect(signedDistanceToBoundary([20, 10], CIRC)).toBeCloseTo(2, 12);
  });
});

describe('crownFractionInside', () => {
  it('is 1 for a crown wholly inside', () => {
    expect(crownFractionInside([10, 15], Math.PI * 2 * 2, RECT)).toBe(1);
  });

  it('is 0 for a crown wholly outside', () => {
    expect(crownFractionInside([-10, 15], Math.PI * 2 * 2, RECT)).toBe(0);
  });

  it('is about half for a stem standing on a straight edge', () => {
    const f = crownFractionInside([0, 15], Math.PI * 2 * 2, RECT);
    expect(f).toBeGreaterThan(0.40);
    expect(f).toBeLessThan(0.60);
  });

  it('grows monotonically as the stem moves into the plot', () => {
    const crown = Math.PI * 3 * 3;
    let prev = -1;
    for (const x of [-3, -1.5, 0, 1.5, 3]) {
      const f = crownFractionInside([x, 15], crown, RECT);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it('falls back to the point check when the crown is unknown', () => {
    expect(crownFractionInside([10, 15], NaN, RECT)).toBe(1);
    expect(crownFractionInside([-1, 15], NaN, RECT)).toBe(0);
    expect(crownFractionInside([10, 15], 0, RECT)).toBe(1);
  });

  it('is deterministic — the same tree always gets the same weight', () => {
    const a = crownFractionInside([0.5, 15], 12, RECT);
    expect(crownFractionInside([0.5, 15], 12, RECT)).toBe(a);
  });
});

describe('treeWeight', () => {
  it("'none' is strict in/out", () => {
    expect(treeWeight([10, 15], 12, RECT, 'none', 1)).toBe(1);
    expect(treeWeight([-1, 15], 12, RECT, 'none', 1)).toBe(0);
  });

  it("'halfcount' halves the band and keeps the interior whole", () => {
    expect(treeWeight([0.5, 15], 12, RECT, 'halfcount', 1)).toBe(0.5);
    expect(treeWeight([5, 15], 12, RECT, 'halfcount', 1)).toBe(1);
    expect(treeWeight([-0.5, 15], 12, RECT, 'halfcount', 1)).toBe(0);
  });

  it("'halfcount' respects the buffer width", () => {
    expect(treeWeight([2, 15], 12, RECT, 'halfcount', 3)).toBe(0.5);
    expect(treeWeight([2, 15], 12, RECT, 'halfcount', 1)).toBe(1);
  });

  it("'crownArea' weights by the fraction of crown inside", () => {
    expect(treeWeight([10, 15], Math.PI * 4, RECT, 'crownArea', 1)).toBe(1);
    const f = treeWeight([0, 15], Math.PI * 4, RECT, 'crownArea', 1);
    expect(f).toBeGreaterThan(0.4);
    expect(f).toBeLessThan(0.6);
  });

  /** A stem just outside the corner. Under the fixed Euclidean distance
   *  it is outside (weight 0); the Chebyshev distance called it "on the
   *  boundary" of a plot it does not touch. */
  it('keeps a corner-adjacent outside stem outside', () => {
    expect(treeWeight([20.8, 30.8], 12, RECT, 'halfcount', 1)).toBe(0);
  });
});

describe('fitRectangularToBbox', () => {
  const stems: Array<[number, number]> = [[0, 0], [10, 0], [10, 6], [0, 6], [5, 3]];

  it('wraps the stems exactly at margin 0', () => {
    const b = fitRectangularToBbox(stems, 0)!;
    expect(b).toEqual({ kind: 'rectangular', min: [0, 0], max: [10, 6] });
  });

  it('shrinks by the margin', () => {
    const b = fitRectangularToBbox(stems, 1)!;
    expect(b).toEqual({ kind: 'rectangular', min: [1, 1], max: [9, 5] });
  });

  /** A margin over half the extent used to push min past max and turn
   *  the rectangle inside out — which plotAreaHa then read as a
   *  positive area. It collapses to the midline instead: zero area,
   *  visibly wrong, nothing silently counted. */
  it('collapses rather than inverts when the margin eats the plot', () => {
    const b = fitRectangularToBbox(stems, 4)!;
    if (b.kind !== 'rectangular') throw new Error('expected rectangular');
    expect(b.min[0]).toBeLessThanOrEqual(b.max[0]);
    expect(b.min[1]).toBeLessThanOrEqual(b.max[1]);
    expect(b.min[1]).toBeCloseTo(3, 12);   // y collapsed to the midline
    expect(b.max[1]).toBeCloseTo(3, 12);
    expect(plotAreaHa(b)).toBe(0);
  });

  it('is null for no stems', () => {
    expect(fitRectangularToBbox([], 0)).toBeNull();
  });
});

describe('fitCircularToBbox', () => {
  it('reaches the farthest stem, not the bbox corner', () => {
    // Stems on a plus shape: bbox is 20 × 20, its corner is 14.1 m out,
    // but the farthest stem is 10 m from the centre.
    const stems: Array<[number, number]> = [[0, 10], [20, 10], [10, 0], [10, 20], [10, 10]];
    const b = fitCircularToBbox(stems, 0)!;
    if (b.kind !== 'circular') throw new Error('expected circular');
    expect(b.center).toEqual([10, 10]);
    expect(b.radius).toBeCloseTo(10, 12);
  });

  it('shrinks by the margin but never below 1 m', () => {
    const stems: Array<[number, number]> = [[0, 0], [20, 0]];
    expect((fitCircularToBbox(stems, 2)! as { radius: number }).radius).toBeCloseTo(8, 12);
    expect((fitCircularToBbox(stems, 100)! as { radius: number }).radius).toBe(1);
  });

  it('is null for no stems', () => {
    expect(fitCircularToBbox([], 0)).toBeNull();
  });
});

describe('parsePlotBoundary', () => {
  it('round-trips both kinds', () => {
    expect(parsePlotBoundary(JSON.stringify(RECT))).toEqual(RECT);
    expect(parsePlotBoundary(JSON.stringify(CIRC))).toEqual(CIRC);
  });

  it('parses "{}" and malformed JSON to "no boundary"', () => {
    expect(parsePlotBoundary('{}')).toBeNull();
    expect(parsePlotBoundary('not json')).toBeNull();
    expect(parsePlotBoundary('null')).toBeNull();
    expect(parsePlotBoundary('[1,2]')).toBeNull();
  });

  it('rejects a non-positive radius', () => {
    expect(parsePlotBoundary(JSON.stringify({ kind: 'circular', center: [0, 0], radius: 0 }))).toBeNull();
    expect(parsePlotBoundary(JSON.stringify({ kind: 'circular', center: [0, 0], radius: -5 }))).toBeNull();
  });

  it('rejects non-finite coordinates', () => {
    expect(parsePlotBoundary('{"kind":"circular","center":[null,0],"radius":5}')).toBeNull();
    expect(parsePlotBoundary('{"kind":"rectangular","min":[0,0],"max":["20",30]}')).toBeNull();
  });

  /** The entry point for the inverted rectangle: a corrupt or
   *  hand-edited plot.json. Malformed degrades to the estimated-area
   *  fallback — the same state a brand-new dataset starts in — rather
   *  than loading a boundary that contains nothing but reports an
   *  area. */
  it('rejects an inverted or zero-extent rectangle as malformed', () => {
    expect(parsePlotBoundary(JSON.stringify({ kind: 'rectangular', min: [20, 30], max: [0, 0] }))).toBeNull();
    expect(parsePlotBoundary(JSON.stringify({ kind: 'rectangular', min: [0, 30], max: [20, 0] }))).toBeNull();
    expect(parsePlotBoundary(JSON.stringify({ kind: 'rectangular', min: [5, 5], max: [5, 30] }))).toBeNull();
  });

  it('rejects partial payloads', () => {
    expect(parsePlotBoundary('{"kind":"circular","radius":5}')).toBeNull();
    expect(parsePlotBoundary('{"kind":"rectangular","min":[0,0]}')).toBeNull();
  });
});
