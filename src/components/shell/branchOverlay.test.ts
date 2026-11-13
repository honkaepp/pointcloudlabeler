import { describe, it, expect } from 'vitest';
import { sectionToWorld, sectionOverlay, pathOverlay, mergeOverlays, boundsOf, JAW1_COLOR, JAW2_COLOR, BASE_COLOR, TIP_COLOR } from './branchOverlay';
import { dist, dot, sectionBasis, sub, type Vec3 } from '../../metrics/branchMeasure';

const axis: Vec3 = [0.6, 0.0, 0.8];
const { u, v } = sectionBasis(axis);
const s = { center: [10, 20, 30] as Vec3, u, v };

describe('the section overlay', () => {
  it('puts a section point back where it came from', () => {
    const p = sectionToWorld(s, 0.01, -0.02);
    const d = sub(p, s.center);
    expect(dot(d, u)).toBeCloseTo(0.01, 12);
    expect(dot(d, v)).toBeCloseTo(-0.02, 12);
    expect(dot(d, axis)).toBeCloseTo(0, 12);
  });

  it('draws the ring at the diameter, and each jaw across its reading at the jaw position', () => {
    const o = sectionOverlay(s, [{ theta: 0, lo: -0.02, hi: 0.021 }, { theta: Math.PI / 2, lo: -0.015, hi: 0.015 }], 0.04);
    const ring = o.segments.filter(sg => sg.color === '#ffffff');
    expect(ring).toHaveLength(32);
    for (const sg of ring) expect(dist(sg.a, s.center)).toBeCloseTo(0.02, 10);
    const jaw1 = o.segments.filter(sg => sg.color === JAW1_COLOR);
    // Two jaws and the reading between them.
    expect(jaw1).toHaveLength(3);
    // The first jaw sits at u = lo and runs along v.
    const mid = sub([(jaw1[0].a[0] + jaw1[0].b[0]) / 2, (jaw1[0].a[1] + jaw1[0].b[1]) / 2, (jaw1[0].a[2] + jaw1[0].b[2]) / 2], s.center);
    expect(dot(mid, u)).toBeCloseTo(-0.02, 10);
    expect(Math.abs(dot(sub(jaw1[0].b, jaw1[0].a), u))).toBeLessThan(1e-12);
    // The reading spans hi − lo.
    expect(dist(jaw1[2].a, jaw1[2].b)).toBeCloseTo(0.041, 10);
    expect(o.segments.filter(sg => sg.color === JAW2_COLOR)).toHaveLength(3);
  });
});

describe('the length overlay', () => {
  it('a segment between each pair of nodes, the base and the tip marked', () => {
    const o = pathOverlay([[0, 0, 0], [1, 0, 0], [1, 1, 0]]);
    expect(o.segments).toHaveLength(2);
    expect(o.dots[0].color).toBe(BASE_COLOR);
    expect(o.dots[2].color).toBe(TIP_COLOR);
  });

  it('merging nothing is nothing', () => {
    expect(mergeOverlays(null, undefined)).toBeNull();
    expect(mergeOverlays(pathOverlay([[0, 0, 0], [1, 0, 0]]), null)!.segments).toHaveLength(1);
  });
});

describe('bounds', () => {
  it('covers every point, padded', () => {
    const b = boundsOf(new Float64Array([1, 2, 3, -1, 5, 0]), 0.5)!;
    expect(b.min).toEqual([-1.5, 1.5, -0.5]);
    expect(b.max).toEqual([1.5, 5.5, 3.5]);
    expect(boundsOf(new Float64Array(0))).toBeNull();
  });
});
