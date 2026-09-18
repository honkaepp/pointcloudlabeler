import { describe, it, expect } from 'vitest';
import type { TreeQsm, QsmSlice } from '../persistence/octreeReader';
import {
  taperPoints, diameterAt, frustumVolume, integrateTaper, sanitizeLengths,
  buckTree, plotTotals, type Assortment, type TaperPoint,
} from './bucking';

const SLICE = 0.25;

function slice(hag: number, radius: number): QsmSlice {
  return { hag, z: hag, centerX: 0, centerY: 0, radius, rmse: 0.003, nPoints: 400, coverage: 1 };
}

/** A stem measured from the ground up to `topSlice`, tapering as
 *  d(h) = d0 · (1 − h/H)^exp — the shape a softwood actually has.
 *  `height` is the crown top, which can be well above the last slice the
 *  QSM managed to fit under a closed canopy. */
function tree(opts: {
  height: number; topSlice: number; d0?: number; exp?: number; treeId?: number;
}): TreeQsm {
  const { height, topSlice, d0 = 0.34, exp = 0.6, treeId = 1 } = opts;
  const slices: QsmSlice[] = [];
  for (let hag = 0; hag + SLICE <= topSlice + 1e-9; hag += SLICE) {
    const hc = hag + SLICE / 2;
    slices.push(slice(hag, d0 * Math.pow(Math.max(0, 1 - hc / height), exp) * 0.5));
  }
  return {
    treeId, baseX: 0, baseY: 0, baseZ: 0, height, slices,
    branches: [], branchVolume: 0, branchCount: 0,
    totalVolume: 0, stemVolume: qsmStemVolume(slices),
    stemVolumeStd: 0.01, stemVolumeCi95: 0.02,
    dbh: 0.3, confidence: 1, completeness: 1, acceptedSlices: slices.length,
  } as unknown as TreeQsm;
}

/** The Rust integrator, reimplemented from its own comment: a cylinder
 *  of the first slice's radius from the ground to the first slice
 *  CENTRE, then a cone frustum between each pair of consecutive slice
 *  centres. This is the number the whole app calls "stem volume". */
function qsmStemVolume(slices: QsmSlice[]): number {
  if (slices.length === 0) return 0;
  const step = slices.length >= 2 ? Math.max(0, slices[1].hag - slices[0].hag) : SLICE;
  let v = Math.PI * slices[0].radius ** 2 * (slices[0].hag + step * 0.5);
  for (let i = 0; i + 1 < slices.length; i++) {
    const a = slices[i], b = slices[i + 1];
    const dh = Math.max(0, b.hag - a.hag);
    v += (Math.PI / 3) * dh * (a.radius ** 2 + a.radius * b.radius + b.radius ** 2);
  }
  return v;
}

const ASSORTMENTS: Assortment[] = [
  { id: 'saw', name: 'Sawlog', minTopDcm: 16, lengths: [3.7, 4.0, 4.3, 4.6, 4.9, 5.2, 5.5], pricePerM3: 60, colour: '#1' },
  { id: 'pulp', name: 'Pulpwood', minTopDcm: 7, lengths: [2.7, 3.0, 3.3, 3.6, 3.9, 4.2, 4.5, 4.8, 5.0], pricePerM3: 30, colour: '#2' },
  { id: 'energy', name: 'Energy', minTopDcm: 5, lengths: [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0], pricePerM3: 15, colour: '#3' },
];

describe('taperPoints', () => {
  it('puts the fitted diameter at the slice mid-height', () => {
    const t = tree({ height: 20, topSlice: 1 });
    const pts = taperPoints(t);
    expect(pts[0].h).toBeCloseTo(0.125, 12);
    expect(pts[1].h).toBeCloseTo(0.375, 12);
    expect(pts[0].d).toBeCloseTo(t.slices[0].radius * 2, 12);
  });

  it('sorts by height whatever order the slices arrive in', () => {
    const t = tree({ height: 20, topSlice: 2 });
    t.slices.reverse();
    const pts = taperPoints(t);
    for (let i = 1; i < pts.length; i++) expect(pts[i].h).toBeGreaterThan(pts[i - 1].h);
  });

  /** The old code appended a zero-diameter point at the crown top and
   *  called it a safety net that stopped logs extending above the last
   *  fit. It did the opposite: it drew a straight cone from the topmost
   *  measured slice to the crown, and the bucker sold logs out of it. */
  it('stops at the last measured slice, inventing no stem above it', () => {
    const t = tree({ height: 22, topSlice: 10 });
    const pts = taperPoints(t);
    const top = pts[pts.length - 1].h;
    expect(top).toBeCloseTo(9.875, 9);
    expect(top).toBeLessThan(t.height);
    expect(pts.some(p => p.d === 0)).toBe(false);
  });

  it('is empty for a tree with no accepted slices', () => {
    const t = tree({ height: 20, topSlice: 10 });
    t.slices = [];
    expect(taperPoints(t)).toEqual([]);
  });
});

describe('diameterAt', () => {
  const pts: TaperPoint[] = [{ h: 1, d: 0.30 }, { h: 2, d: 0.26 }, { h: 3, d: 0.20 }];

  it('interpolates between slice centres', () => {
    expect(diameterAt(pts, 1.5)).toBeCloseTo(0.28, 12);
    expect(diameterAt(pts, 2.5)).toBeCloseTo(0.23, 12);
  });

  it('is exact at the slice centres', () => {
    expect(diameterAt(pts, 1)).toBeCloseTo(0.30, 12);
    expect(diameterAt(pts, 3)).toBeCloseTo(0.20, 12);
  });

  /** Below the first slice the stem is a cylinder, not a continuation of
   *  the taper's slope. The stump is the thickest part of the tree, so
   *  extrapolating a slope there moves real volume — and the Rust
   *  integrator assumes the cylinder, so anything else would put the two
   *  out of step. */
  it('holds the butt diameter below the first slice', () => {
    expect(diameterAt(pts, 0.5)).toBeCloseTo(0.30, 12);
    expect(diameterAt(pts, 0)).toBeCloseTo(0.30, 12);
  });

  it('is zero above the last measured slice — there is no measurement there', () => {
    expect(diameterAt(pts, 3.0001)).toBe(0);
    expect(diameterAt(pts, 50)).toBe(0);
  });

  it('is zero for a tree with no slices', () => {
    expect(diameterAt([], 1)).toBe(0);
  });

  it('survives two slices at the same height', () => {
    expect(() => diameterAt([{ h: 1, d: 0.3 }, { h: 1, d: 0.2 }], 1)).not.toThrow();
  });
});

describe('frustumVolume', () => {
  it('reduces to a cylinder when both ends match', () => {
    expect(frustumVolume(0.4, 0.4, 2)).toBeCloseTo(Math.PI * 0.2 ** 2 * 2, 12);
  });

  it('reduces to a cone when the top is a point', () => {
    expect(frustumVolume(0.4, 0, 3)).toBeCloseTo(Math.PI * 0.2 ** 2 * 3 / 3, 12);
  });

  it('is the π/3 · h · (r² + r·R + R²) the Rust integrator uses', () => {
    const [db, dt, L] = [0.36, 0.22, 4.3];
    const [rb, rt] = [db / 2, dt / 2];
    expect(frustumVolume(db, dt, L))
      .toBeCloseTo((Math.PI / 3) * L * (rb * rb + rb * rt + rt * rt), 15);
  });
});

/** The property the whole module hangs on. If the panel integrates the
 *  taper the same way Rust did, then the stump plus the logs plus the
 *  residue ARE the QSM's stem volume — not a second approximation of it
 *  that has to be reconciled by subtracting. */
describe('integrateTaper agrees with the QSM integrator', () => {
  it('reproduces the stem volume exactly over the measured span', () => {
    for (const [h, topSlice, exp] of [[22, 22, 0.6], [22, 10, 0.6], [18, 18, 1.5], [30, 25, 0.4]] as const) {
      const t = tree({ height: h, topSlice, exp });
      const pts = taperPoints(t);
      const whole = integrateTaper(pts, 0, pts[pts.length - 1].h);
      expect(whole, `H=${h} top=${topSlice}`).toBeCloseTo(t.stemVolume, 12);
    }
  });

  it('splits additively at any height', () => {
    const t = tree({ height: 22, topSlice: 22 });
    const pts = taperPoints(t);
    const top = pts[pts.length - 1].h;
    for (const cut of [0.1, 1.0, 4.37, 13.2, top - 0.01]) {
      expect(integrateTaper(pts, 0, cut) + integrateTaper(pts, cut, top))
        .toBeCloseTo(integrateTaper(pts, 0, top), 12);
    }
  });

  it('never integrates above the last measured slice', () => {
    const t = tree({ height: 22, topSlice: 10 });
    const pts = taperPoints(t);
    const top = pts[pts.length - 1].h;
    expect(integrateTaper(pts, 0, 1000)).toBeCloseTo(integrateTaper(pts, 0, top), 12);
    expect(integrateTaper(pts, top, 1000)).toBe(0);
  });

  it('is zero for an empty or inverted span', () => {
    const pts = taperPoints(tree({ height: 20, topSlice: 10 }));
    expect(integrateTaper(pts, 5, 5)).toBe(0);
    expect(integrateTaper(pts, 5, 4)).toBe(0);
    expect(integrateTaper([], 0, 10)).toBe(0);
  });

  /** A single chord frustum across a whole 5 m log replaces fifteen
   *  measured diameters with a straight line between its two ends. */
  it('differs from one chord frustum across a long log', () => {
    const pts = taperPoints(tree({ height: 22, topSlice: 22 }));
    const chord = frustumVolume(diameterAt(pts, 0.1), diameterAt(pts, 5.6), 5.5);
    const real = integrateTaper(pts, 0.1, 5.6);
    expect(Math.abs(chord / real - 1)).toBeGreaterThan(0.002);
  });
});

describe('sanitizeLengths', () => {
  /** The lengths field is free text by design so a non-Nordic user can
   *  retune for their own market. Typing "0.5" passes through "0" and
   *  "0." on the way, both of which parse to 0 — and a zero-length log
   *  passes every diameter test, adds nothing, and leaves the cut height
   *  exactly where it was, so the bucker cuts it again forever. */
  it('drops the zero that froze the app mid-keystroke', () => {
    expect(sanitizeLengths([0, 3.7, 4.0])).toEqual([3.7, 4.0]);
  });

  it('drops negatives, which walked the cut height back down the stem', () => {
    expect(sanitizeLengths([-1, 3.0])).toEqual([3.0]);
  });

  it('drops NaN and Infinity', () => {
    expect(sanitizeLengths([NaN, Infinity, -Infinity, 3.0])).toEqual([3.0]);
  });

  it('sorts ascending, so longest-first really is longest-first', () => {
    expect(sanitizeLengths([4.0, 3.0, 5.0])).toEqual([3.0, 4.0, 5.0]);
  });

  it('is empty rather than throwing when nothing is usable', () => {
    expect(sanitizeLengths([])).toEqual([]);
    expect(sanitizeLengths([0, -2, NaN])).toEqual([]);
  });
});

describe('buckTree', () => {
  const STUMP = 0.10;

  it('cuts the highest-priority assortment that fits, longest module first', () => {
    const r = buckTree(tree({ height: 22, topSlice: 22 }), STUMP, ASSORTMENTS);
    expect(r.logs.length).toBeGreaterThan(2);
    expect(r.logs[0].assortmentId).toBe('saw');
    expect(r.logs[0].length).toBe(5.5);
    expect(r.logs[0].hLow).toBeCloseTo(STUMP, 12);
    // Logs are contiguous, bottom to top.
    for (let i = 1; i < r.logs.length; i++) {
      expect(r.logs[i].hLow).toBeCloseTo(r.logs[i - 1].hHigh, 12);
    }
  });

  it('respects each assortment\'s minimum top diameter', () => {
    const r = buckTree(tree({ height: 22, topSlice: 22 }), STUMP, ASSORTMENTS);
    for (const log of r.logs) {
      const a = ASSORTMENTS.find(x => x.id === log.assortmentId)!;
      expect(log.dTop * 100).toBeGreaterThanOrEqual(a.minTopDcm - 1e-9);
    }
  });

  it('drops to a lower class as the stem thins, never back up', () => {
    const r = buckTree(tree({ height: 22, topSlice: 22 }), STUMP, ASSORTMENTS);
    const rank = (id: string) => ASSORTMENTS.findIndex(a => a.id === id);
    for (let i = 1; i < r.logs.length; i++) {
      expect(rank(r.logs[i].assortmentId)).toBeGreaterThanOrEqual(rank(r.logs[i - 1].assortmentId));
    }
  });

  /** The invariant that replaced `waste = max(0, stemVolume − logged)`.
   *  That subtraction mixed the QSM's integration with a chord-frustum
   *  one and clamped the difference at zero, so every discretisation
   *  error landed in "waste" and any overshoot vanished. */
  it('accounts for every cubic metre of the measured stem', () => {
    for (const topSlice of [22, 15, 10, 5]) {
      const t = tree({ height: 22, topSlice });
      const r = buckTree(t, STUMP, ASSORTMENTS);
      expect(r.stumpVolume + r.loggedVolume + r.residueVolume, `top=${topSlice}`)
        .toBeCloseTo(r.taperVolume, 12);
      expect(r.taperVolume, `top=${topSlice}`).toBeCloseTo(t.stemVolume, 12);
      expect(r.wasteVolume).toBeCloseTo(r.stumpVolume + r.residueVolume, 12);
    }
  });

  /** The defect this module was extracted to fix. Under a closed canopy
   *  the QSM often fits circles only up to 10 m of a 22 m stem. The old
   *  bucker drew a cone from there to the crown and sold logs out of it:
   *  0.66 m³ of measured stem became 0.82 m³ of merchantable logs — 124 %
   *  — and the waste figure read 0.000 m³ because the clamp swallowed it. */
  it('never sells more wood than the QSM measured', () => {
    for (const topSlice of [22, 15, 10, 5]) {
      const t = tree({ height: 22, topSlice });
      const r = buckTree(t, STUMP, ASSORTMENTS);
      expect(r.loggedVolume, `top=${topSlice}`).toBeLessThanOrEqual(t.stemVolume + 1e-12);
      expect(r.measuredTop).toBeLessThanOrEqual(t.height);
      for (const log of r.logs) expect(log.hHigh).toBeLessThanOrEqual(r.measuredTop + 1e-12);
    }
  });

  it('reports how far up the stem was actually measured', () => {
    const r = buckTree(tree({ height: 22, topSlice: 10 }), STUMP, ASSORTMENTS);
    expect(r.height).toBe(22);
    expect(r.measuredTop).toBeCloseTo(9.875, 9);
  });

  it('prices each log at its own class rate', () => {
    const r = buckTree(tree({ height: 22, topSlice: 22 }), STUMP, ASSORTMENTS);
    for (const log of r.logs) {
      const a = ASSORTMENTS.find(x => x.id === log.assortmentId)!;
      expect(log.revenue).toBeCloseTo(log.volume * a.pricePerM3, 12);
    }
    expect(r.totalRevenue).toBeCloseTo(r.logs.reduce((s, l) => s + l.revenue, 0), 12);
    expect(r.totalRevenue).toBeCloseTo(
      Object.values(r.revenuePerClass).reduce((s, v) => s + v, 0), 12);
  });

  it('sums volume per class to the logged total', () => {
    const r = buckTree(tree({ height: 22, topSlice: 22 }), STUMP, ASSORTMENTS);
    expect(Object.values(r.perClass).reduce((s, v) => s + v, 0)).toBeCloseTo(r.loggedVolume, 12);
  });

  it('leaves the stump uncut and counts it as waste', () => {
    const r = buckTree(tree({ height: 22, topSlice: 22 }), 0.30, ASSORTMENTS);
    expect(r.logs[0].hLow).toBeCloseTo(0.30, 12);
    expect(r.stumpVolume).toBeGreaterThan(0);
    // A taller stump means less merchantable stem.
    const low = buckTree(tree({ height: 22, topSlice: 22 }), 0.05, ASSORTMENTS);
    expect(r.stumpVolume).toBeGreaterThan(low.stumpVolume);
  });

  /** The hang, end to end: a zero-length module used to make the cut
   *  height stand still while the log list grew without bound. */
  it('terminates on a zero-length module instead of cutting forever', () => {
    const broken: Assortment[] = [{ ...ASSORTMENTS[0], lengths: [0, 4.0] }];
    const r = buckTree(tree({ height: 22, topSlice: 22 }), STUMP, broken);
    expect(r.logs.every(l => l.length > 0)).toBe(true);
    expect(r.logs.length).toBeLessThan(100);
  });

  /** buckTree does NOT sanitize its input — termination is a property of
   *  its own loop, so that a caller who skips sanitizeLengths gets a
   *  wrong answer at worst and never a frozen app. Deleting the progress
   *  guard makes these hang, which is the failure being demonstrated. */
  it('terminates on a zero-length module it was handed directly', () => {
    const r = buckTree(tree({ height: 22, topSlice: 22 }), STUMP,
      [{ ...ASSORTMENTS[0], lengths: [0] }]);
    expect(r.logs).toHaveLength(0);
  });

  it('still cuts the usable modules alongside a zero one', () => {
    const r = buckTree(tree({ height: 22, topSlice: 22 }), STUMP,
      [{ ...ASSORTMENTS[0], lengths: [0, 4.0] }]);
    expect(r.logs.length).toBeGreaterThan(0);
    expect(r.logs.every(l => l.length === 4.0)).toBe(true);
  });

  it('terminates on a negative module', () => {
    const broken: Assortment[] = [{ ...ASSORTMENTS[0], lengths: [-1] }];
    const r = buckTree(tree({ height: 22, topSlice: 22 }), STUMP, broken);
    expect(r.logs).toHaveLength(0);
    expect(r.residueVolume).toBeCloseTo(r.qsmStemVolume - r.stumpVolume, 10);
  });

  it('takes the longest module first however the set was ordered', () => {
    const shuffled: Assortment[] = [{ ...ASSORTMENTS[0], lengths: [4.0, 5.5, 3.7] }];
    const r = buckTree(tree({ height: 22, topSlice: 22 }), STUMP, shuffled);
    expect(r.logs[0].length).toBe(5.5);
  });

  it('does not reorder the caller\'s assortment', () => {
    const a: Assortment = { ...ASSORTMENTS[0], lengths: [4.0, 5.5, 3.7] };
    buckTree(tree({ height: 22, topSlice: 22 }), STUMP, [a]);
    expect(a.lengths).toEqual([4.0, 5.5, 3.7]);
  });

  it('terminates when nothing can be cut at all', () => {
    const r = buckTree(tree({ height: 22, topSlice: 22 }), STUMP, []);
    expect(r.logs).toHaveLength(0);
    expect(r.loggedVolume).toBe(0);
    expect(r.taperVolume).toBeCloseTo(r.qsmStemVolume, 12);
  });

  it('handles a tree the QSM could not fit at all', () => {
    const t = tree({ height: 22, topSlice: 10 });
    t.slices = [];
    const r = buckTree(t, STUMP, ASSORTMENTS);
    expect(r.logs).toHaveLength(0);
    expect(r.measuredTop).toBe(0);
    expect(r.taperVolume).toBe(0);
    expect(r.totalRevenue).toBe(0);
  });

  it('handles a stump taller than the measured stem', () => {
    const t = tree({ height: 22, topSlice: 1 });
    const r = buckTree(t, 5.0, ASSORTMENTS);
    expect(r.logs).toHaveLength(0);
    // The stump cannot claim volume above where the stem was measured.
    expect(r.stumpVolume).toBeCloseTo(t.stemVolume, 12);
    expect(r.residueVolume).toBe(0);
  });

  it('treats a negative stump height as ground level', () => {
    const t = tree({ height: 22, topSlice: 22 });
    expect(buckTree(t, -1, ASSORTMENTS).logs[0].hLow).toBe(0);
  });
});

describe('plotTotals', () => {
  const trees = [
    tree({ height: 22, topSlice: 22, treeId: 1 }),
    tree({ height: 20, topSlice: 20, d0: 0.28, treeId: 2 }),
    tree({ height: 22, topSlice: 8, treeId: 3 }),   // occluded upper stem
  ];
  const results = trees.map(t => buckTree(t, 0.10, ASSORTMENTS));

  it('adds up the per-tree figures', () => {
    const p = plotTotals(results, ASSORTMENTS);
    expect(p.totalRev).toBeCloseTo(results.reduce((s, r) => s + r.totalRevenue, 0), 10);
    expect(p.waste).toBeCloseTo(results.reduce((s, r) => s + r.wasteVolume, 0), 10);
    for (const a of ASSORTMENTS) {
      expect(p.perClass[a.id]).toBeCloseTo(results.reduce((s, r) => s + r.perClass[a.id], 0), 12);
    }
  });

  it('the plot volume is the plot\'s measured stem volume, no more', () => {
    const p = plotTotals(results, ASSORTMENTS);
    expect(p.totalVol).toBeCloseTo(trees.reduce((s, t) => s + t.stemVolume, 0), 10);
    const logged = Object.values(p.perClass).reduce((s, v) => s + v, 0);
    expect(logged + p.waste).toBeCloseTo(p.totalVol, 10);
  });

  /** Bucking a stem the QSM only saw the bottom third of is still a
   *  legitimate answer for that third — but a total that says nothing
   *  about it reads as a measurement of the whole stand. */
  it('counts the trees whose upper stem was never measured', () => {
    expect(plotTotals(results, ASSORTMENTS).nPartiallyMeasured).toBe(1);
  });

  it('an empty plot is zeros, not NaN', () => {
    const p = plotTotals([], ASSORTMENTS);
    expect(p.totalVol).toBe(0);
    expect(p.totalRev).toBe(0);
    expect(p.perClass.saw).toBe(0);
    expect(p.nPartiallyMeasured).toBe(0);
  });
});
