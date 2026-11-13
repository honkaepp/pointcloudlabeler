import { describe, it, expect } from 'vitest';
import {
  type Vec3, add, scale, normalize, cross, dot, dist,
  symEigen3, principalAxis, localAxis, sectionAt, sectionBasis, caliperAt, minWidthAngle,
  crossCaliper, fitCircle2, sectorCoverage, branchEnds, orderEnds, baseSection,
  polylineLength, branchPath, readSection, columnAt, stemAxisAt, stemFoot, highestPoint, trackStem, makeZIndex,
} from './branchMeasure';

/** Deterministic uniform [0, 1). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/** Points on the surface of an elliptic cylinder along `axis` from
 *  `origin`, semi-axes `a` (along the section's u) and `b` (along v),
 *  only the angles in [aFrom, aTo] (a one-sided scan when narrowed). */
function cylinder(opts: {
  origin: Vec3; axis: Vec3; length: number; a: number; b?: number; n: number; seed?: number;
  aFrom?: number; aTo?: number;
}): Float64Array {
  const rnd = lcg(opts.seed ?? 1);
  const ax = normalize(opts.axis);
  const { u, v } = sectionBasis(ax);
  const b = opts.b ?? opts.a;
  const from = opts.aFrom ?? 0, to = opts.aTo ?? 2 * Math.PI;
  const out = new Float64Array(opts.n * 3);
  for (let i = 0; i < opts.n; i++) {
    const t = rnd() * opts.length;
    const ang = from + rnd() * (to - from);
    const p = add(add(opts.origin, scale(ax, t)), add(scale(u, opts.a * Math.cos(ang)), scale(v, b * Math.sin(ang))));
    out.set(p, i * 3);
  }
  return out;
}

const tilted: Vec3 = normalize([1, 0.4, 0.6]);

describe('symEigen3', () => {
  it('recovers the eigen-pairs of a symmetric matrix', () => {
    // Q diag(5, 2, 0.5) Qᵀ for a rotation Q.
    const q1 = normalize([1, 1, 0]), q2 = normalize([-1, 1, 1]), q3 = normalize(cross(q1, q2));
    const vals = [5, 2, 0.5];
    const Q = [q1, q2, q3];
    const m = new Array(9).fill(0);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) m[r * 3 + c] += Q[k][r] * vals[k] * Q[k][c];
    const e = symEigen3(m);
    expect(e.values[0]).toBeCloseTo(5, 10);
    expect(e.values[1]).toBeCloseTo(2, 10);
    expect(e.values[2]).toBeCloseTo(0.5, 10);
    expect(Math.abs(dot(e.vectors[0], q1))).toBeCloseTo(1, 10);
    expect(Math.abs(dot(e.vectors[1], q2))).toBeCloseTo(1, 10);
  });
});

describe('principal and local axes', () => {
  const pts = cylinder({ origin: [10, 20, 5], axis: tilted, length: 1, a: 0.02, n: 6000 });
  it('the principal axis of a branch runs along it', () => {
    const ax = principalAxis(pts)!;
    expect(Math.abs(dot(ax.dir, tilted))).toBeGreaterThan(0.9999);
  });
  it('the local axis around a bark point runs along the branch too', () => {
    const at: Vec3 = add([10, 20, 5], scale(tilted, 0.5));
    const ax = localAxis(pts, at, 0.08)!;
    expect(Math.abs(dot(ax.dir, tilted))).toBeGreaterThan(0.999);
  });
  it('a sparse neighbourhood widens until it has enough points', () => {
    const sparse = cylinder({ origin: [0, 0, 0], axis: tilted, length: 1, a: 0.02, n: 60 });
    expect(localAxis(sparse, scale(tilted, 0.5), 0.01)).not.toBeNull();
  });
});

describe('a cross-section read with calipers', () => {
  const origin: Vec3 = [100, 200, 30];
  const round = cylinder({ origin, axis: tilted, length: 1, a: 0.02, n: 40000, seed: 7 });
  // Clicked on the bark, not on the axis.
  const { u } = sectionBasis(tilted);
  const click = add(add(origin, scale(tilted, 0.4)), scale(u, 0.02));
  const opts = { axisRadius: 0.08, halfThickness: 0.005, maxRadius: 0.1 };

  it('the section is centred on the axis, perpendicular to it', () => {
    const s = sectionAt(round, click, opts)!;
    expect(Math.abs(dot(s.axis, tilted))).toBeGreaterThan(0.999);
    const onAxis = add(origin, scale(tilted, dot(sub3(s.center, origin), tilted)));
    expect(dist(s.center, onAxis)).toBeLessThan(0.002);
    expect(dot(sub3(s.center, origin), tilted)).toBeCloseTo(0.4, 2);
    expect(s.count).toBeGreaterThan(200);
  });

  it('reads the diameter in every direction of a round branch, to a millimetre', () => {
    const s = sectionAt(round, click, opts)!;
    for (const deg of [0, 30, 60, 90, 135]) {
      expect(caliperAt(s.pts, (deg * Math.PI) / 180).width).toBeGreaterThan(0.039);
      expect(caliperAt(s.pts, (deg * Math.PI) / 180).width).toBeLessThan(0.0402);
    }
    const cc = crossCaliper(s.pts, 0);
    expect(cc.mean).toBeCloseTo(0.04, 3);
  });

  it('the circle fit agrees, and a branch seen all round has full coverage', () => {
    const s = sectionAt(round, click, opts)!;
    const c = fitCircle2(s.pts)!;
    expect(c.r).toBeCloseTo(0.02, 3);
    expect(sectorCoverage(s.pts, c.cu, c.cv)).toBe(1);
  });

  it('an oval section: the narrowest direction reads the minor axis, the cross reading the major', () => {
    const oval = cylinder({ origin, axis: tilted, length: 1, a: 0.03, b: 0.02, n: 40000, seed: 3 });
    const s = sectionAt(oval, add(origin, scale(tilted, 0.5)), opts)!;
    const th = minWidthAngle(s.pts);
    const cc = crossCaliper(s.pts, th);
    expect(cc.first.width).toBeCloseTo(0.04, 3);
    expect(cc.second.width).toBeCloseTo(0.06, 3);
    expect(cc.mean).toBeCloseTo(0.05, 3);
    // b lies along v: the narrow direction is 90° from u.
    expect(Math.abs(Math.cos(th))).toBeLessThan(0.05);
  });

  it('a stray point opens the jaws; trimming the outermost percent closes them again', () => {
    const s = sectionAt(round, click, opts)!;
    const pts = new Float64Array(s.pts.length + 2);
    pts.set(s.pts);
    pts[s.pts.length] = 0.06; pts[s.pts.length + 1] = 0;
    expect(caliperAt(pts, 0).width).toBeGreaterThan(0.075);
    expect(caliperAt(pts, 0, 0.01).width).toBeLessThan(0.0402);
  });

  it('a branch scanned from one side reads true across the seen side, and says it was seen from one side', () => {
    const half = cylinder({ origin, axis: tilted, length: 1, a: 0.02, n: 20000, seed: 9, aFrom: 0, aTo: Math.PI });
    const s = sectionAt(half, add(origin, scale(tilted, 0.5)), opts)!;
    // The half-shell spans the full width along u (angles 0 and π).
    expect(caliperAt(s.pts, 0).width).toBeCloseTo(0.04, 3);
    const c = fitCircle2(s.pts)!;
    expect(sectorCoverage(s.pts, c.cu, c.cv)).toBeLessThanOrEqual(0.6);
  });

  it('nothing in the slab is no section', () => {
    expect(sectionAt(round, [0, 0, 0], opts)).toBeNull();
  });
});

describe('base, tip and length', () => {
  it('the base is the end nearer the stem, or the lower one without a stem', () => {
    const a: Vec3 = [1, 0, 5], b: Vec3 = [3, 0, 6];
    expect(orderEnds(a, b, [0, 0, 0]).base).toBe(a);
    expect(orderEnds(a, b, [4, 0, 0]).base).toBe(b);
    expect(orderEnds(b, a).base).toBe(a);
  });

  it('the ends of a straight branch are its extreme points, and the base section sits the offset in from the base', () => {
    const origin: Vec3 = [0, 0, 10];
    const pts = cylinder({ origin, axis: tilted, length: 1.2, a: 0.015, n: 20000, seed: 11 });
    const ends = branchEnds(pts)!;
    const { base, tip } = orderEnds(ends.a, ends.b, [-1, -1, 0]);
    expect(dot(sub3(base, origin), tilted)).toBeLessThan(0.01);
    expect(dist(base, tip)).toBeGreaterThan(1.19);
    const bs = baseSection(pts, base, tip, 0.02, 0.06)!;
    expect(dot(bs.axis, tilted)).toBeGreaterThan(0.999);
    expect(dot(sub3(bs.at, origin), tilted)).toBeCloseTo(0.02, 2);
  });

  it('the path along a curved branch measures its arc, not its chord', () => {
    // A quarter circle of radius 0.5 m in the x–z plane, 1.5 cm thick.
    const rnd = lcg(5);
    const n = 30000;
    const pts = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const t = rnd() * (Math.PI / 2);
      const c: Vec3 = [0.5 * Math.cos(t), 0, 0.5 * Math.sin(t)];
      const tan: Vec3 = [-Math.sin(t), 0, Math.cos(t)];
      const { u, v } = sectionBasis(tan);
      const ang = rnd() * 2 * Math.PI;
      pts.set(add(c, add(scale(u, 0.0075 * Math.cos(ang)), scale(v, 0.0075 * Math.sin(ang)))), i * 3);
    }
    const p = branchPath(pts, [0.5, 0, 0], 0.02)!;
    const arc = (Math.PI / 2) * 0.5;
    expect(p.unreached).toBe(0);
    expect(p.length).toBeGreaterThan(arc * 0.97);
    expect(p.length).toBeLessThan(arc * 1.04);
    expect(dist(p.tip, [0, 0, 0.5])).toBeLessThan(0.03);
    expect(dist([0.5, 0, 0], p.tip)).toBeLessThan(arc);
  });

  it('a gap wider than the graph reaches is reported, not bridged', () => {
    const a = cylinder({ origin: [0, 0, 0], axis: [1, 0, 0], length: 0.3, a: 0.01, n: 3000, seed: 2 });
    const b = cylinder({ origin: [0.6, 0, 0], axis: [1, 0, 0], length: 0.3, a: 0.01, n: 3000, seed: 4 });
    const both = new Float64Array(a.length + b.length);
    both.set(a); both.set(b, a.length);
    const p = branchPath(both, [0, 0, 0], 0.02)!;
    expect(p.unreached).toBeGreaterThan(0);
    expect(p.length).toBeLessThan(0.35);
  });

  it('a polyline is the sum of its segments', () => {
    expect(polylineLength([[0, 0, 0], [3, 4, 0], [3, 4, 12]])).toBeCloseTo(17, 12);
    expect(polylineLength([[1, 1, 1]])).toBe(0);
  });
});

describe('reading a section', () => {
  const pts = cylinder({ origin: [0, 0, 0], axis: [0, 0, 1], length: 0.02, a: 0.03, b: 0.02, n: 4000, seed: 21 });
  const s = sectionAt(pts, [0, 0, 0.01], { axisRadius: 0.05, halfThickness: 0.02, maxRadius: 0.1, axis: [0, 0, 1] })!;
  it('cross: two readings at right angles and their mean; single: one', () => {
    const r = readSection(s.pts, 0, 'cross', 0);
    expect(r.jaws).toHaveLength(2);
    expect(r.diameter).toBeCloseTo((r.widths[0] + r.widths[1]) / 2, 12);
    expect(readSection(s.pts, 0, 'single', 0).jaws).toHaveLength(1);
    expect(r.manual).toBe(false);
  });
  it('a jaw set by hand is the reading', () => {
    const r = readSection(s.pts, 0, 'cross', 0, [[-0.01, 0.02], null]);
    expect(r.widths[0]).toBeCloseTo(0.03, 12);
    expect(r.manual).toBe(true);
  });
  it('a section given its axis is centred on the given point, not on a fit', () => {
    expect(dist(s.center, [0, 0, 0.01])).toBeLessThan(0.002);
  });
});

describe('a stem', () => {
  // 12 m stem leaning 6° toward east, radius 16 cm at the foot tapering
  // to 6 cm at the top, ground at z = 100, with branches leaving it
  // horizontally from 1.2 m up.
  const lean: Vec3 = normalize([Math.tan((6 * Math.PI) / 180), 0, 1]);
  const foot: Vec3 = [50, 60, 100];
  const rnd = lcg(31);
  const parts: number[] = [];
  const { u, v } = sectionBasis(lean);
  for (let i = 0; i < 60000; i++) {
    const t = rnd() * 12;
    const r = 0.16 - (0.1 * t) / 12;
    const ang = rnd() * 2 * Math.PI;
    parts.push(...add(add(foot, scale(lean, t)), add(scale(u, r * Math.cos(ang)), scale(v, r * Math.sin(ang)))));
  }
  for (const [h, az] of [[1.2, 0.5], [1.5, 2.6], [6.1, 4.0], [8, 1.0]] as const) {
    const base = add(foot, scale(lean, h));
    const dir: Vec3 = [Math.cos(az), Math.sin(az), 0];
    for (let i = 0; i < 2000; i++) {
      const t = 0.15 + rnd() * 1.5;
      const ang = rnd() * 2 * Math.PI;
      const { u: bu, v: bv } = sectionBasis(dir);
      parts.push(...add(add(base, scale(dir, t)), add(scale(bu, 0.015 * Math.cos(ang)), scale(bv, 0.015 * Math.sin(ang)))));
    }
  }
  const xyz = Float64Array.from(parts);
  const axisAt = (h: number) => add(foot, scale(lean, h / lean[2]));

  it('the plain column centre is good where no branch leaves the stem', () => {
    const c = columnAt(xyz, 103, 0.2, 0.4)!;
    const truth = axisAt(3);
    expect(Math.hypot(c[0] - truth[0], c[1] - truth[1])).toBeLessThan(0.01);
  });

  it('followed up from its foot, the stem at 1.3 m is found among the branches that leave it there', () => {
    const t = trackStem(xyz, stemFoot(xyz)!, 101.3, { maxRadius: 0.3 })!;
    const truth = axisAt(1.3);
    expect(Math.hypot(t.at[0] - truth[0], t.at[1] - truth[1])).toBeLessThan(0.01);
    expect(t.at[2]).toBe(101.3);
    expect(dot(t.axis, lean)).toBeGreaterThan(0.995);
  });

  it('and at 6 m, where a branch leaves it, too', () => {
    const t = trackStem(xyz, stemFoot(xyz)!, 106, { maxRadius: 0.3 })!;
    const truth = axisAt(6);
    expect(Math.hypot(t.at[0] - truth[0], t.at[1] - truth[1])).toBeLessThan(0.01);
  });

  it('the stem axis is found by circles, not swayed by the branches', () => {
    const t = trackStem(xyz, stemFoot(xyz)!, 101.3, { maxRadius: 0.3 })!;
    const ax = stemAxisAt(xyz, t.at, 0.25, 0.03, 0.4);
    expect(dot(ax, lean)).toBeGreaterThan(0.998);
  });

  it('a cross-calipered DBH reads the stem at 1.3 m to a few millimetres', () => {
    const t = trackStem(xyz, stemFoot(xyz)!, 101.3, { maxRadius: 0.3 })!;
    const s = sectionAt(xyz, t.at, { axisRadius: 0.5, halfThickness: 0.01, maxRadius: 0.3, axis: t.axis })!;
    const tAlong = 1.3 / lean[2];
    const trueD = 2 * (0.16 - (0.1 * tAlong) / 12);
    const r = readSection(s.pts, minWidthAngle(s.pts), 'cross', 0);
    expect(Math.abs(r.diameter - trueD)).toBeLessThan(0.004);
  });

  it('the foot is the stem’s lowest point, the top its highest', () => {
    const f = stemFoot(xyz)!;
    expect(f[2]).toBeCloseTo(100 - 0.16 * Math.sin((6 * Math.PI) / 180), 1);
    expect(Math.hypot(f[0] - foot[0], f[1] - foot[1])).toBeLessThan(0.1);
    expect(highestPoint(xyz)![2]).toBeGreaterThan(100 + 11.9 * lean[2]);
  });

  it('the height index finds the same stem, faster', () => {
    const zi = makeZIndex(xyz);
    for (let k = 1; k < zi.z.length; k++) expect(zi.z[k]).toBeGreaterThanOrEqual(zi.z[k - 1]);
    const a = trackStem(xyz, stemFoot(xyz)!, 106, { maxRadius: 0.3 })!;
    const b = trackStem(xyz, stemFoot(xyz)!, 106, { maxRadius: 0.3, zIndex: zi })!;
    expect(dist(a.at, b.at)).toBeLessThan(1e-9);
  });

  it('too few points in a slab leaves the axis vertical', () => {
    expect(stemAxisAt(new Float64Array([0, 0, 0, 1, 1, 1]), [0, 0, 0], 0.2, 0.02, 0.3)).toEqual([0, 0, 1]);
    expect(columnAt(xyz, 300, 0.3, 0.4)).toBeNull();
  });
});

function sub3(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
