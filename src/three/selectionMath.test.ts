import { describe, it, expect } from 'vitest';
import { pointInPolygon, flattenRemap, applyRemapInPlace } from './selectionMath';

/** The lasso hit test. Whatever it says is inside gets deleted, or
 *  reassigned to another tree, on the user's next click — so a point it
 *  misjudges is not a rendering artefact, it is an edit to data. */
describe('pointInPolygon', () => {
  const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];

  it('separates inside from outside for a simple square', () => {
    expect(pointInPolygon(5, 5, square)).toBe(true);
    expect(pointInPolygon(-1, 5, square)).toBe(false);
    expect(pointInPolygon(11, 5, square)).toBe(false);
    expect(pointInPolygon(5, -1, square)).toBe(false);
    expect(pointInPolygon(5, 11, square)).toBe(false);
  });

  it('closes the polygon implicitly — the caller must not repeat the first vertex', () => {
    const closed: [number, number][] = [...square, [0, 0]];
    // A repeated vertex adds a zero-length edge, which must not change
    // the answer for points away from the boundary.
    for (const [x, y] of [[5, 5], [-1, 5], [5, 11], [2, 8]] as const) {
      expect(pointInPolygon(x, y, closed)).toBe(pointInPolygon(x, y, square));
    }
  });

  it('handles a concave shape, where a bounding box would not', () => {
    // A C-shape opening to the right; the notch is outside.
    const c: [number, number][] = [[0, 0], [10, 0], [10, 3], [3, 3], [3, 7], [10, 7], [10, 10], [0, 10]];
    expect(pointInPolygon(1, 5, c)).toBe(true);    // in the spine
    expect(pointInPolygon(7, 5, c)).toBe(false);   // in the notch
    expect(pointInPolygon(7, 1, c)).toBe(true);    // in the lower arm
    expect(pointInPolygon(7, 9, c)).toBe(true);    // in the upper arm
  });

  it('is not confused by horizontal edges', () => {
    // Every edge of the square at y = 0 and y = 10 is horizontal; a
    // naive implementation divides by zero on them.
    for (let x = 0.5; x < 10; x += 0.5) {
      expect(pointInPolygon(x, 0.0001, square)).toBe(true);
      expect(pointInPolygon(x, 9.9999, square)).toBe(true);
      expect(pointInPolygon(x, -0.0001, square)).toBe(false);
      expect(pointInPolygon(x, 10.0001, square)).toBe(false);
    }
  });

  it('gives a consistent answer along a scanline through a vertex', () => {
    // A diamond: y = 5 passes exactly through the left and right
    // vertices. The half-open (yi > y) test must count each crossing
    // once, so the interior stays interior.
    const diamond: [number, number][] = [[5, 0], [10, 5], [5, 10], [0, 5]];
    expect(pointInPolygon(5, 5, diamond)).toBe(true);
    expect(pointInPolygon(-1, 5, diamond)).toBe(false);
    expect(pointInPolygon(11, 5, diamond)).toBe(false);
  });

  it('is degenerate-safe: a line or a single point encloses nothing', () => {
    expect(pointInPolygon(5, 5, [])).toBe(false);
    expect(pointInPolygon(5, 5, [[0, 0]])).toBe(false);
    expect(pointInPolygon(5, 5, [[0, 0], [10, 10]])).toBe(false);
    expect(pointInPolygon(0, 0, [[0, 0], [0, 0], [0, 0]])).toBe(false);
  });

  /** Documented, not asserted as desirable: a self-crossing lasso is
   *  judged even-odd, so the doubly-wound middle counts as OUTSIDE. */
  it('treats the overlap of a self-crossing lasso as outside (even-odd)', () => {
    // A bow-tie: the two triangles are inside, the crossing point is not
    // a region, but a point inside both windings would be excluded.
    const bowtie: [number, number][] = [[0, 0], [10, 10], [10, 0], [0, 10]];
    expect(pointInPolygon(2, 5, bowtie)).toBe(true);   // left triangle
    expect(pointInPolygon(8, 5, bowtie)).toBe(true);   // right triangle
    expect(pointInPolygon(5, 2, bowtie)).toBe(false);  // between them
  });
});

/** The merge overlay. It decides which tree a point belongs to, and it
 *  is a file: written by the backend, surviving crashes, editable. */
describe('flattenRemap', () => {
  it('collapses a chain so every id lands on the final target', () => {
    // A merged into B, later B into C.
    const flat = flattenRemap(new Map([[1, 2], [2, 3]]));
    expect(flat.get(1)).toBe(3);
    expect(flat.get(2)).toBe(3);
  });

  it('collapses a long chain in one hop', () => {
    const raw = new Map<number, number>();
    for (let i = 1; i < 500; i++) raw.set(i, i + 1);
    const flat = flattenRemap(raw);
    for (let i = 1; i < 500; i++) expect(flat.get(i)).toBe(500);
  });

  it('leaves an id that was never merged alone', () => {
    const flat = flattenRemap(new Map([[1, 2]]));
    expect(flat.has(2)).toBe(false);
    expect(flat.get(1)).toBe(2);
  });

  /** A cycle cannot come from a legitimate sequence of merges, but the
   *  overlay is a file. The walk had no cycle detection: it took 10 000
   *  hops per key and then kept whichever id it had landed on, so the
   *  same file could fold a tree into a different id depending only on
   *  where the walk started. */
  it('resolves a cycle to one stable id rather than wherever the walk stopped', () => {
    const two = flattenRemap(new Map([[1, 2], [2, 1]]));
    expect(two.has(1)).toBe(false); // 1 is already the smallest, so it stays
    expect(two.get(2)).toBe(1);

    const three = flattenRemap(new Map([[5, 6], [6, 7], [7, 5]]));
    // Every member of the cycle agrees, and agrees on the smallest.
    expect(three.get(6)).toBe(5);
    expect(three.get(7)).toBe(5);
    expect(three.has(5)).toBe(false); // already the target
  });

  it('resolves a tail leading into a cycle to the same id', () => {
    // 9 → 10 → 11 → 12 → 10
    const flat = flattenRemap(new Map([[9, 10], [10, 11], [11, 12], [12, 10]]));
    // The cycle is {10, 11, 12}; 9 only leads into it and is not a
    // member, so the target is 10 and every one of the four agrees.
    for (const id of [9, 10, 11, 12]) {
      expect(flat.get(id) ?? id).toBe(10);
    }
  });

  it('terminates promptly on a cycle instead of grinding through it', () => {
    // 200 ids all pointing into one big cycle. The old walk did 10 000
    // hops for each of them.
    const raw = new Map<number, number>();
    for (let i = 0; i < 200; i++) raw.set(i, (i + 1) % 200);
    const t0 = Date.now();
    const flat = flattenRemap(raw);
    expect(Date.now() - t0).toBeLessThan(200);
    // Everything in one cycle agrees on one id.
    const targets = new Set([...flat.values()]);
    expect(targets.size).toBe(1);
  });

  it('an empty overlay maps nothing', () => {
    expect(flattenRemap(new Map()).size).toBe(0);
  });
});

describe('applyRemapInPlace', () => {
  it('folds ids through the map and leaves the rest untouched', () => {
    const ids = new Int32Array([1, 2, 3, 0, 2]);
    applyRemapInPlace(ids, flattenRemap(new Map([[1, 2], [2, 3]])));
    expect([...ids]).toEqual([3, 3, 3, 0, 3]);
  });

  it('is a no-op for an empty map, including on unassigned points', () => {
    const ids = new Int32Array([0, 7, 7]);
    applyRemapInPlace(ids, new Map());
    expect([...ids]).toEqual([0, 7, 7]);
  });

  it('never invents a mapping for id 0 (unassigned) unless told to', () => {
    const ids = new Int32Array([0, 0, 5]);
    applyRemapInPlace(ids, flattenRemap(new Map([[5, 6]])));
    expect([...ids]).toEqual([0, 0, 6]);
  });
});
