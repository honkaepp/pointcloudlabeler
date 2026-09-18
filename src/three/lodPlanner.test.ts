import { describe, it, expect } from 'vitest';
import {
  MaxHeap, MIN_NODE_PIXEL_SIZE, NOT_VISIBLE, KEEP_PIXEL_FACTOR, KEEP_BUDGET_FACTOR,
  EVICT_LIMIT_FACTOR, projFactor, sourceCentreToScene, pixelDiameter,
  meetsPixelThreshold, admits, refines, admittedCeiling, selectEvictions,
  detailBoxWorld, bboxOverlapsDetail, releasePoints, type EvictCandidate,
} from './lodPlanner';
import { isolateBoxToScene } from './filterGeometry';

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function drain(h: MaxHeap): number[] {
  const out: number[] = [];
  while (!h.isEmpty()) out.push(h.pop()!.weight);
  return out;
}

describe('MaxHeap', () => {
  it('pops in descending weight order', () => {
    const rnd = lcg(20260823);
    for (let trial = 0; trial < 60; trial++) {
      const n = 1 + Math.floor(rnd() * 60);
      const w: number[] = [];
      const h = new MaxHeap();
      for (let i = 0; i < n; i++) {
        const x = Math.round(rnd() * 1000) / 10;
        w.push(x);
        h.push({ rec: i, weight: x });
      }
      expect(drain(h)).toEqual([...w].sort((a, b) => b - a));
    }
  });

  it('carries the record index along with its weight', () => {
    const h = new MaxHeap();
    h.push({ rec: 7, weight: 10 });
    h.push({ rec: 9, weight: 90 });
    h.push({ rec: 3, weight: 50 });
    expect([h.pop()!.rec, h.pop()!.rec, h.pop()!.rec]).toEqual([9, 3, 7]);
  });

  it('is empty-safe', () => {
    const h = new MaxHeap();
    expect(h.pop()).toBeUndefined();
    expect(h.isEmpty()).toBe(true);
    expect(h.size).toBe(0);
  });

  it('interleaves pushes and pops correctly', () => {
    const h = new MaxHeap();
    h.push({ rec: 1, weight: 5 });
    h.push({ rec: 2, weight: 50 });
    expect(h.pop()!.weight).toBe(50);
    h.push({ rec: 3, weight: 20 });
    h.push({ rec: 4, weight: 1 });
    expect(drain(h)).toEqual([20, 5, 1]);
  });

  it('keeps equal weights without losing any', () => {
    const h = new MaxHeap();
    for (let i = 0; i < 20; i++) h.push({ rec: i, weight: 42 });
    const recs = new Set<number>();
    while (!h.isEmpty()) recs.add(h.pop()!.rec);
    expect(recs.size).toBe(20);
  });

  /** The defect. A binary heap is a priority queue only if its keys are
   *  totally ordered, and NaN is not: siftUp's `parent >= child` is
   *  false so a NaN swaps all the way to the root, and siftDown's
   *  `child > best` is also false so nothing moves it back. It pins
   *  itself at the top and desorders everything beneath it.
   *
   *  Measured with the raw comparisons, 20 nodes and one NaN:
   *    clean   100 95 90 85 80 75 70 65 60 55 …
   *    w/ NaN   95 100 90 85 75 70 65 60 80 …
   *  The 100-pixel node — the largest thing on screen — pops SECOND.
   *  With MAX_NODES_LOADING = 10 and a budget that cuts refinement off,
   *  a wrong order does not merely delay detail; what falls past the
   *  cutoff never loads. Nothing reports it: the user sees "slow". */
  it('stays ordered when a weight is not a number', () => {
    for (const poison of [NaN, undefined as unknown as number]) {
      const h = new MaxHeap();
      const w = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, poison, 95, 85, 75, 65, 55, 45, 35, 25, 15];
      w.forEach((weight, rec) => h.push({ rec, weight }));
      const out = drain(h);
      expect(out.length).toBe(20);
      const finite = out.filter(Number.isFinite);
      expect(finite, `poison=${String(poison)}`)
        .toEqual([...finite].sort((a, b) => b - a));
      // …and the largest node comes out first, not second.
      expect(out[0]).toBe(100);
    }
  });

  it('sorts an unmeasurable node last rather than dropping it', () => {
    const h = new MaxHeap();
    h.push({ rec: 1, weight: 50 });
    h.push({ rec: 2, weight: NaN });
    h.push({ rec: 3, weight: 10 });
    const recs: number[] = [];
    while (!h.isEmpty()) recs.push(h.pop()!.rec);
    // The node survives the plan — a root or a forced node ignores the
    // weight anyway — it just goes to the back.
    expect(recs).toEqual([1, 3, 2]);
  });

  it('orders infinities without breaking the invariant', () => {
    const h = new MaxHeap();
    [5, Infinity, -Infinity, 100, 0].forEach((weight, rec) => h.push({ rec, weight }));
    expect(drain(h)).toEqual([Infinity, 100, 5, 0, -Infinity]);
  });

  it('does not mutate the caller’s object when the weight is fine', () => {
    const h = new MaxHeap();
    const item = { rec: 4, weight: 12 };
    h.push(item);
    expect(h.pop()).toBe(item);
    expect(item.weight).toBe(12);
  });
});

describe('projFactor', () => {
  it('scales with viewport height', () => {
    expect(projFactor(60, 1000)).toBeCloseTo(2 * projFactor(60, 500), 9);
  });

  it('gives a wider field of view a smaller factor', () => {
    expect(projFactor(90, 800)).toBeLessThan(projFactor(30, 800));
  });

  it('matches the closed form for a 90° fov', () => {
    // tan(45°) = 1, so the factor is exactly height / 2.
    expect(projFactor(90, 800)).toBeCloseTo(400, 6);
  });

  /** A zero fov gives tan(0) = 0 and an infinite scale, which would make
   *  every node infinitely large — the priority order collapses to
   *  insertion order and the planner loads whatever it happened to see
   *  first. */
  it('survives a degenerate field of view', () => {
    for (const fov of [0, -10, NaN, 180, 360]) {
      const p = projFactor(fov, 800);
      expect(Number.isFinite(p), `fov ${fov} -> ${p}`).toBe(true);
      expect(p).toBeGreaterThan(0);
    }
  });

  it('survives a zero-height viewport', () => {
    for (const h of [0, -5, NaN]) {
      expect(Number.isFinite(projFactor(60, h)), `h ${h}`).toBe(true);
    }
  });
});

describe('sourceCentreToScene', () => {
  const OFF: [number, number, number] = [500000, 6800000, 120];

  /** North is NEGATED, not merely swapped. Dropping the sign is a
   *  reflection: the frustum then culls the mirrored half of the cloud
   *  and nodes pop in and out as the camera orbits. */
  it('negates north and lifts up into scene Y', () => {
    expect(sourceCentreToScene(500010, 6800020, 150, OFF)).toEqual([10, 30, -20]);
  });

  it('puts the dataset origin at the scene origin', () => {
    expect(sourceCentreToScene(OFF[0], OFF[1], OFF[2], OFF)).toEqual([0, 0, -0]);
  });

  it('is a rotation, not a reflection — it preserves handedness', () => {
    const O: [number, number, number] = [0, 0, 0];
    const e = sourceCentreToScene(1, 0, 0, O);   // east
    const n = sourceCentreToScene(0, 1, 0, O);   // north
    const u = sourceCentreToScene(0, 0, 1, O);   // up
    // east × north should still point up.
    const cross = [
      e[1] * n[2] - e[2] * n[1],
      e[2] * n[0] - e[0] * n[2],
      e[0] * n[1] - e[1] * n[0],
    ];
    const dot = cross[0] * u[0] + cross[1] * u[1] + cross[2] * u[2];
    expect(dot).toBeGreaterThan(0);
  });

  it('preserves distances', () => {
    const O: [number, number, number] = [0, 0, 0];
    const a = sourceCentreToScene(3, 4, 12, O);
    expect(Math.hypot(...a)).toBeCloseTo(13, 9);
  });
});

describe('pixelDiameter', () => {
  it('halves when the distance doubles', () => {
    expect(pixelDiameter(5, 200, 400)).toBeCloseTo(pixelDiameter(5, 100, 400) / 2, 9);
  });

  it('is linear in radius', () => {
    expect(pixelDiameter(10, 100, 400)).toBeCloseTo(2 * pixelDiameter(5, 100, 400), 9);
  });

  it('matches the closed form', () => {
    // A 5 m-radius node 100 m away, 400 px per unit at distance 1.
    expect(pixelDiameter(5, 100, 400)).toBeCloseTo(40, 9);
  });

  /** THREE's Frustum.intersectsSphere tests `distance < -radius`, which
   *  is false for NaN — a node with a degenerate centre or radius is
   *  reported INSIDE the frustum rather than culled (measured: true for
   *  both). Without this guard the diameter is NaN and one corrupt bbox
   *  in an index reorders the whole load queue. */
  it('reports an unmeasurable node as off-screen rather than as NaN', () => {
    expect(pixelDiameter(NaN, 100, 400)).toBe(NOT_VISIBLE);
    expect(pixelDiameter(5, NaN, 400)).toBe(NOT_VISIBLE);
    expect(pixelDiameter(5, 100, NaN)).toBe(NOT_VISIBLE);
    expect(pixelDiameter(Infinity, 100, 400)).toBe(NOT_VISIBLE);
  });

  it('never returns NaN for any input', () => {
    for (const r of [0, 1, -1, 1e9, NaN, Infinity]) {
      for (const d of [0, 0.0001, 1, 1e9, NaN, Infinity]) {
        const v = pixelDiameter(r, d, 400);
        expect(Number.isNaN(v), `r=${r} d=${d}`).toBe(false);
      }
    }
  });

  it('stays finite for a camera sitting exactly on the node centre', () => {
    const v = pixelDiameter(5, 0, 400);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(MIN_NODE_PIXEL_SIZE);
  });

  it('sorts NOT_VISIBLE below every real diameter', () => {
    expect(NOT_VISIBLE).toBeLessThan(pixelDiameter(1e-9, 1e9, 1));
    expect(meetsPixelThreshold(NOT_VISIBLE, true)).toBe(false);
  });
});

describe('admits', () => {
  const base = {
    isRoot: false, forced: false, wasVisible: false,
    weight: 100, plannedPoints: 0, pointBudget: 1_000_000,
  };

  it('lets a large node in', () => {
    expect(admits(base)).toBe(true);
  });

  it('keeps a node smaller than the pixel threshold out', () => {
    expect(admits({ ...base, weight: MIN_NODE_PIXEL_SIZE - 0.01 })).toBe(false);
    expect(admits({ ...base, weight: MIN_NODE_PIXEL_SIZE })).toBe(true);
  });

  /** Roots hold only a sparse sample of their tile. Guaranteeing them
   *  means the overview never vanishes when zoomed far out, nor when a
   *  close region has spent the entire budget. */
  it('always admits a tile root, at any size and any budget', () => {
    expect(admits({ ...base, isRoot: true, weight: 0.001, plannedPoints: 1e9 })).toBe(true);
    expect(admits({ ...base, isRoot: true, weight: NOT_VISIBLE, plannedPoints: 1e9 })).toBe(true);
  });

  /** The isolated tree must be fully resident and editable at any zoom,
   *  or a lasso silently misses points that "weren't streamed in yet". */
  it('always admits a forced-detail node', () => {
    expect(admits({ ...base, forced: true, weight: NOT_VISIBLE, plannedPoints: 1e9 })).toBe(true);
  });

  it('stops admitting once the budget is spent', () => {
    expect(admits({ ...base, plannedPoints: 999_999 })).toBe(true);
    expect(admits({ ...base, plannedPoints: 1_000_000 })).toBe(false);
  });

  /** Hysteresis. A node right at the cutoff used to flip in and out on
   *  consecutive re-plans, each flip a fade-out plus a fade-in — the
   *  cloud "blinking in patches". */
  it('relaxes both gates for a node that was already visible', () => {
    const marginal = MIN_NODE_PIXEL_SIZE * 0.9;
    expect(admits({ ...base, weight: marginal, wasVisible: false })).toBe(false);
    expect(admits({ ...base, weight: marginal, wasVisible: true })).toBe(true);

    const over = 1_050_000;
    expect(admits({ ...base, plannedPoints: over, wasVisible: false })).toBe(false);
    expect(admits({ ...base, plannedPoints: over, wasVisible: true })).toBe(true);
  });

  it('does not relax past the keep band', () => {
    expect(admits({ ...base, weight: MIN_NODE_PIXEL_SIZE * KEEP_PIXEL_FACTOR - 0.01, wasVisible: true })).toBe(false);
    expect(admits({ ...base, plannedPoints: 1_000_000 * KEEP_BUDGET_FACTOR, wasVisible: true })).toBe(false);
  });

  /** A weight that is not a number must fail the size gate, not sail
   *  through it. The old form was `if (weight < minPx) continue`, and
   *  `NaN < 30` is false. */
  it('rejects a node whose size is not a number', () => {
    for (const weight of [NaN, undefined as unknown as number]) {
      expect(admits({ ...base, weight }), String(weight)).toBe(false);
      expect(admits({ ...base, weight, wasVisible: true })).toBe(false);
    }
  });

  it('still admits a root or forced node with an unmeasurable size', () => {
    expect(admits({ ...base, weight: NaN, isRoot: true })).toBe(true);
    expect(admits({ ...base, weight: NaN, forced: true })).toBe(true);
  });
});

describe('refines', () => {
  it('keeps refining while the budget holds', () => {
    expect(refines(0, 1000, false)).toBe(true);
    expect(refines(999, 1000, false)).toBe(true);
    expect(refines(1000, 1000, false)).toBe(false);
  });

  it('never stops refining a forced-detail node', () => {
    expect(refines(1e9, 1000, true)).toBe(true);
  });
});

describe('admittedCeiling', () => {
  /** The planner's comment used to claim the total "can't creep past
   *  ~1.15 × budget". The budget is checked BEFORE the node's own points
   *  are added, so the last admission overshoots by one node — and roots
   *  and forced nodes bypass the cap entirely. This is the real bound,
   *  and a simulated plan has to respect it. */
  it('bounds what a plan can actually admit', () => {
    const rnd = lcg(11);
    const BUDGET = 100_000;
    for (let trial = 0; trial < 200; trial++) {
      const nodes = Array.from({ length: 300 }, () => ({
        pts: 1 + Math.floor(rnd() * 20_000),
        weight: rnd() * 200,
        wasVisible: rnd() < 0.5,
        isRoot: rnd() < 0.05,
        forced: rnd() < 0.02,
      }));
      let planned = 0, largest = 0, rootForced = 0;
      for (const n of nodes) {
        if (!admits({ ...n, plannedPoints: planned, pointBudget: BUDGET })) continue;
        planned += n.pts;
        if (n.isRoot || n.forced) rootForced += n.pts;
        else largest = Math.max(largest, n.pts);
      }
      expect(planned).toBeLessThanOrEqual(admittedCeiling(BUDGET, largest, rootForced));
    }
  });

  it('is at least the budget itself', () => {
    expect(admittedCeiling(1000, 0, 0)).toBeGreaterThanOrEqual(1000);
  });

  /** Each term is there for a reason, so dropping any of them has to
   *  make the bound wrong for some plan. */
  it('accounts for the keep band, the overshoot and the bypasses', () => {
    expect(admittedCeiling(1000, 0, 0)).toBeCloseTo(1000 * KEEP_BUDGET_FACTOR, 9);
    expect(admittedCeiling(1000, 500, 0)).toBeCloseTo(1000 * KEEP_BUDGET_FACTOR + 500, 9);
    expect(admittedCeiling(1000, 0, 700)).toBeCloseTo(1000 * KEEP_BUDGET_FACTOR + 700, 9);
  });
});

describe('selectEvictions', () => {
  const node = (recIdx: number, lastUsedFrame: number, numPoints = 100, level = 2): EvictCandidate =>
    ({ recIdx, lastUsedFrame, numPoints, level });
  const none = () => false;

  it('does nothing while under the limit', () => {
    expect(selectEvictions([node(1, 0), node(2, 1)], none, 100, 200)).toEqual([]);
    // …and nothing exactly AT the limit either.
    expect(selectEvictions([node(1, 0)], none, 200, 200)).toEqual([]);
  });

  it('evicts least-recently-used first', () => {
    const ns = [node(1, 50), node(2, 10), node(3, 30), node(4, 20)];
    const out = selectEvictions(ns, none, 400, 150);
    expect(out.map(n => n.recIdx)).toEqual([2, 4, 3]);
  });

  it('stops as soon as it is back under the limit', () => {
    const ns = [node(1, 1), node(2, 2), node(3, 3), node(4, 4)];
    // 400 resident, limit 250 -> must free 150 -> two nodes of 100.
    const out = selectEvictions(ns, none, 400, 250);
    expect(out.map(n => n.recIdx)).toEqual([1, 2]);
  });

  /** A zoom-out has to show the overview instantly, so tile roots stay
   *  resident however old they are. */
  it('never evicts a tile root', () => {
    const ns = [node(1, 0, 100, 0), node(2, 99, 100, 3)];
    expect(selectEvictions(ns, none, 400, 50).map(n => n.recIdx)).toEqual([2]);
  });

  /** Belt and braces over the planner, which marks these visible anyway.
   *  If they were ever evicted the points would vanish from under a
   *  selection mid-edit, with nothing to say they had been there. */
  it('never evicts a node the caller is keeping', () => {
    const ns = [node(1, 0), node(2, 1), node(3, 2)];
    const out = selectEvictions(ns, rec => rec === 1, 400, 50);
    expect(out.map(n => n.recIdx)).toEqual([2, 3]);
  });

  it('returns everything evictable when that is still not enough', () => {
    const ns = [node(1, 0), node(2, 1)];
    // Freeing both leaves 800 — still over. It must not loop forever or
    // start evicting protected nodes.
    const out = selectEvictions(ns, none, 1000, 50);
    expect(out.map(n => n.recIdx)).toEqual([1, 2]);
  });

  it('is deterministic across equal timestamps', () => {
    const ns = [node(5, 7), node(6, 7), node(7, 7)];
    const a = selectEvictions(ns, none, 400, 150).map(n => n.recIdx);
    const b = selectEvictions(ns, none, 400, 150).map(n => n.recIdx);
    expect(a).toEqual(b);
  });

  /** loadedPoints is a running counter that the caller decrements on
   *  every eviction, and its `< 0` clamp does not catch NaN (`NaN < 0`
   *  is false). One node with an unreadable point count therefore
   *  poisons it permanently — and without the guard, `remaining <= limit`
   *  is false forever, so every re-plan dumps the ENTIRE evictable
   *  resident set. The cloud would clear and reload on a still camera,
   *  with nothing to say why. */
  it('evicts nothing when the point counter has gone bad', () => {
    const ns = [node(1, 0), node(2, 1), node(3, 2)];
    expect(selectEvictions(ns, none, NaN, 50)).toEqual([]);
  });

  it('does not mutate the input order', () => {
    const ns = [node(1, 50), node(2, 10)];
    selectEvictions(ns, none, 400, 50);
    expect(ns.map(n => n.recIdx)).toEqual([1, 2]);
  });

  it('accepts a Map iterator, which is what the planner passes', () => {
    const m = new Map<number, EvictCandidate>([[1, node(1, 5)], [2, node(2, 1)]]);
    // 400 resident, limit 350: freeing the older node alone gets there.
    expect(selectEvictions(m.values(), none, 400, 350).map(n => n.recIdx)).toEqual([2]);
  });

  it('frees enough to get under the limit when it can', () => {
    const rnd = lcg(4242);
    for (let t = 0; t < 200; t++) {
      const ns = Array.from({ length: 40 }, (_, i) =>
        node(i, Math.floor(rnd() * 100), 1 + Math.floor(rnd() * 500), rnd() < 0.1 ? 0 : 2));
      const total = ns.reduce((s, n) => s + n.numPoints, 0);
      const limit = Math.floor(total * 0.4);
      const freed = selectEvictions(ns, none, total, limit).reduce((s, n) => s + n.numPoints, 0);
      const evictable = ns.filter(n => n.level !== 0).reduce((s, n) => s + n.numPoints, 0);
      if (total - evictable <= limit) expect(total - freed).toBeLessThanOrEqual(limit);
    }
  });
});

describe('releasePoints', () => {
  it('subtracts a node from the resident count', () => {
    expect(releasePoints(1000, 300)).toBe(700);
  });

  it('floors at zero rather than going negative', () => {
    expect(releasePoints(100, 400)).toBe(0);
    expect(releasePoints(0, 400)).toBe(0);
  });

  /** The counter drives eviction, and `NaN < 0` is false, so the old
   *  floor let one unreadable point count poison it for the rest of the
   *  session. A poisoned counter then either never evicts (memory grows
   *  until the tab dies) or evicts everything on every re-plan (the
   *  cloud clears and reloads on a still camera). Neither reports. */
  it('keeps the counter usable when a node has no readable point count', () => {
    for (const bad of [NaN, Infinity, undefined as unknown as number]) {
      const out = releasePoints(1000, bad);
      expect(Number.isFinite(out), String(bad)).toBe(true);
      // Conservative: keep the last good value, so eviction runs sooner
      // than needed rather than never.
      expect(out).toBe(1000);
    }
  });

  it('recovers a counter that is already poisoned', () => {
    expect(releasePoints(NaN, 100)).toBe(0);
    expect(releasePoints(NaN, NaN)).toBe(0);
  });

  it('never returns a value that breaks the evict comparison', () => {
    for (const c of [0, 1, 1e9, -5, NaN, Infinity]) {
      for (const n of [0, 1, 1e9, -5, NaN, Infinity]) {
        const out = releasePoints(c, n);
        expect(Number.isFinite(out), `c=${c} n=${n} -> ${out}`).toBe(true);
        expect(out).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('detailBoxWorld', () => {
  const BOX: [[number, number, number], [number, number, number]] =
    [[10, 20, 0], [14, 26, 18]];

  it('centres on the box when there is no anchor', () => {
    const d = detailBoxWorld(BOX, null, 0);
    expect(d).toEqual([10, 20, 0, 14, 26, 18]);
  });

  it('centres on the density anchor when there is one', () => {
    const d = detailBoxWorld(BOX, [12, 21, 2], 0);
    expect([d[0], d[3]]).toEqual([10, 14]);      // half-extent 2 either side
    expect([d[1], d[4]]).toEqual([18, 24]);      // anchored low in north
  });

  it('dilates by the margin on every axis', () => {
    const d = detailBoxWorld(BOX, null, 3);
    expect(d).toEqual([7, 17, -3, 17, 29, 21]);
  });

  it('ignores a negative or non-finite margin', () => {
    for (const m of [-5, NaN, Infinity]) {
      expect(detailBoxWorld(BOX, null, m), `margin ${m}`).toEqual([10, 20, 0, 14, 26, 18]);
    }
  });

  it('dilates per world axis when given three reaches, the same way the filter does', () => {
    // East–west 3, north–south 0, up–down 5 — the planner must load
    // exactly the box the filter will show, or a lasso over the revealed
    // points misses data that was never streamed in.
    expect(detailBoxWorld(BOX, null, [3, 0, 5])).toEqual([7, 20, -5, 17, 26, 23]);
    expect(detailBoxWorld(BOX, null, [1, -2, NaN])).toEqual([9, 20, 0, 15, 26, 18]);
  });

  it('dilates in ONE direction when given six', () => {
    // [west, east, south, north, down, up]: 2 east, 4 north, 1 down.
    expect(detailBoxWorld(BOX, null, [0, 2, 0, 4, 1, 0])).toEqual([10, 20, -1, 16, 30, 18]);
  });

  /** A poorly segmented tree — a few stray points across the plot — has
   *  a raw bbox spanning most of the dataset. Forcing THAT to full LOD
   *  ate the whole point budget and starved the rest of the scene. */
  it('clamps a stray-inflated bbox', () => {
    const huge: [[number, number, number], [number, number, number]] =
      [[-500, -500, -200], [500, 500, 200]];
    const d = detailBoxWorld(huge, [0, 0, 0], 0);
    expect(d).toEqual([-8, -8, -30, 8, 8, 30]);
  });

  /** The planner and the filter must derive the SAME box, or the filter
   *  reveals points the planner never guaranteed were loaded — and a
   *  lasso over them misses data, which is the exact trap the
   *  forced-detail region exists to close. This was a hand-copy with the
   *  clamp constants written out as bare 8 and 30 on the planner side. */
  it('agrees with the filter’s isolate box', () => {
    const OFF: [number, number, number] = [1000, 2000, 30];
    const cases: Array<[typeof BOX, [number, number, number] | null, number]> = [
      [BOX, null, 0],
      [BOX, [12, 21, 2], 1.5],
      [[[-500, -500, -200], [500, 500, 200]], [3, -4, 5], 2],
      [[[0, 0, 0], [0, 0, 0]], null, 0.5],
    ];
    for (const [box, anchor, margin] of cases) {
      const w = detailBoxWorld(box, anchor, margin);
      // No height band: that is the one place the two deliberately
      // differ, and the filter is the narrower of the two.
      const s = isolateBoxToScene({ box, anchor, margin, zRange: null }, OFF);
      expect(s.x0, `x0 ${JSON.stringify(box)}`).toBeCloseTo(w[0] - OFF[0], 9);
      expect(s.x1).toBeCloseTo(w[3] - OFF[0], 9);
      expect(s.y0, 'y0 (up)').toBeCloseTo(w[2] - OFF[2], 9);
      expect(s.y1).toBeCloseTo(w[5] - OFF[2], 9);
      // Scene Z is −(world north), so the interval flips.
      expect(s.z0, 'z0 (north, negated)').toBeCloseTo(OFF[1] - w[4], 9);
      expect(s.z1).toBeCloseTo(OFF[1] - w[1], 9);
    }
  });

  /** The filter's height band narrows what is SHOWN; the planner loads
   *  the full box regardless. Loading more than is shown is the safe
   *  direction — the reverse is the bug. */
  it('is never narrower than what the filter shows', () => {
    const OFF: [number, number, number] = [0, 0, 0];
    const w = detailBoxWorld(BOX, null, 1);
    const s = isolateBoxToScene({ box: BOX, anchor: null, margin: 1, zRange: [2, 6] }, OFF);
    expect(s.y0).toBeGreaterThanOrEqual(w[2] - 1e-9);
    expect(s.y1).toBeLessThanOrEqual(w[5] + 1e-9);
  });
});

describe('bboxOverlapsDetail', () => {
  //                x0 y0 z0  x1 y1 z1
  const BB = new Float64Array([
    0, 0, 0, 10, 10, 10,      // rec 0 — overlaps
    100, 100, 100, 110, 110, 110, // rec 1 — far away
    5, 5, 5, 6, 6, 6,         // rec 2 — fully inside
    -50, -50, -50, 50, 50, 50, // rec 3 — contains the detail box
  ]);
  const D = [4, 4, 4, 8, 8, 8] as const;

  it('takes a node that overlaps but is not contained', () => {
    expect(bboxOverlapsDetail(BB, 0, D)).toBe(true);
  });

  it('rejects a node that does not reach the box', () => {
    expect(bboxOverlapsDetail(BB, 1, D)).toBe(false);
  });

  it('takes a node fully inside', () => {
    expect(bboxOverlapsDetail(BB, 2, D)).toBe(true);
  });

  /** Overlap, not containment: a node clipped by the box still holds
   *  points of the isolated tree, and dropping it would leave a hole in
   *  the region the user is editing. */
  it('takes a node that contains the whole box', () => {
    expect(bboxOverlapsDetail(BB, 3, D)).toBe(true);
  });

  it('counts a touching face as overlapping', () => {
    const touch = new Float64Array([8, 4, 4, 12, 8, 8]);
    expect(bboxOverlapsDetail(touch, 0, D)).toBe(true);
  });

  it('separates on every axis independently', () => {
    for (let axis = 0; axis < 3; axis++) {
      const b = [0, 0, 0, 10, 10, 10];
      b[axis] = 100; b[axis + 3] = 110;   // push only this axis away
      expect(bboxOverlapsDetail(new Float64Array(b), 0, D), `axis ${axis}`).toBe(false);
    }
  });

  it('reads the right record out of a packed array', () => {
    expect(bboxOverlapsDetail(BB, 2, [5.5, 5.5, 5.5, 5.6, 5.6, 5.6])).toBe(true);
    expect(bboxOverlapsDetail(BB, 0, [5.5, 5.5, 5.5, 5.6, 5.6, 5.6])).toBe(true);
    expect(bboxOverlapsDetail(BB, 1, [5.5, 5.5, 5.5, 5.6, 5.6, 5.6])).toBe(false);
  });
});

describe('the planner constants hold together', () => {
  it('relaxes rather than tightens', () => {
    expect(KEEP_PIXEL_FACTOR).toBeLessThan(1);
    expect(KEEP_PIXEL_FACTOR).toBeGreaterThan(0);
    expect(KEEP_BUDGET_FACTOR).toBeGreaterThan(1);
  });

  /** Eviction must not fire while the plan is still legally admitting.
   *  If the evict limit sat below what a plan can hold, every re-plan
   *  would evict nodes the same plan had just marked visible — load,
   *  evict, reload, for as long as the camera sits still. */
  it('evicts above what a plan can admit, not below', () => {
    expect(EVICT_LIMIT_FACTOR).toBeGreaterThan(KEEP_BUDGET_FACTOR);
  });
});
