// Stretching a colour ramp, shading by intensity, and the legend as a
// control — on the CPU colouring of the point renderer.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { stripComments } from '../testing/sourceScan';
import { legendShift, legendSpan, rampRangeKey, stretchSpans, type RampSpans } from './colorStretch';
import { histogramOf, tidy } from './colorHistogram';
import { colorNode, type LoadedNode, type PaintExtras } from './OctreeView';
import { rampColor } from './palette';
import { legendClick } from '../components/shell/ColorLegend';
import { autoRange, domainT, drawnDomain } from '../components/shell/RangeEditor';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const OFF: [number, number, number] = [500000, 7000000, 100];
// The cloud's own spans, in the colouring's units (relative to OFF).
const own: RampSpans = {
  height: { lo: 2, hi: 32 },
  x: { lo: -10, hi: 10 },
  y: { lo: -5, hi: 5 },
  intensity: { lo: 100, hi: 8100 },
};

/** A node of `n` points as the colouring reads it. */
function node(n: number, at: (i: number) => [number, number, number], o: Partial<LoadedNode> = {}): LoadedNode {
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions.set(at(i), i * 3);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(n * 3), 3, true));
  return {
    geom, positions, treeIds: new Int32Array(n), intensity: new Uint16Array(n), classification: new Uint8Array(n),
    returnNumber: new Uint8Array(n), semantic: new Uint8Array(n), extras: {}, selection: null, dim: new Uint8Array(n),
    visibility: new Uint8Array(n).fill(1), strays: 0, standingDeadwood: null, layingDeadwood: null,
    tile: 0, record: 0, heightMin: 0, heightMax: 1,
    ...o,
  } as unknown as LoadedNode;
}
const rgbOf = (ln: LoadedNode, i: number) => Array.from((ln.geom.attributes.color.array as Uint8Array).slice(i * 3, i * 3 + 3));
const ramp = (t: number) => { const c: [number, number, number] = [0, 0, 0]; rampColor('viridis', t, c); return c; };
const paint = (o: Partial<PaintExtras> = {}): PaintExtras => ({ shade: null, treeColors: null, classLut: new Uint8Array(768), ...o });

describe('a ramp in world units, and stretched', () => {
  it('the legend reads elevations, eastings and northings', () => {
    expect(legendSpan('height', own, OFF, false)).toEqual({ lo: 102, hi: 132 });
    expect(legendSpan('x', own, OFF, false)).toEqual({ lo: 499990, hi: 500010 });
    expect(legendSpan('y', own, OFF, false)).toEqual({ lo: 6999995, hi: 7000005 });
    expect(legendSpan('intensity', own, OFF, false)).toEqual({ lo: 100, hi: 8100 });
    // height above ground has no offset in it
    expect(legendSpan('height', own, OFF, true)).toEqual({ lo: 2, hi: 32 });
    // no single span: intensity ramped per node, and the categorical modes
    expect(legendSpan('intensity', { ...own, intensity: null }, OFF, false)).toBeNull();
    expect(legendSpan('tree_id', own, OFF, false)).toBeNull();
    expect(legendShift('y', OFF)).toBe(7000000);
  });

  it('a set range moves the ramp: in world units in, the colouring\'s units out', () => {
    const s = stretchSpans(own, { height: { lo: 110, hi: 120 }, x: { lo: 500000, hi: 500004 }, intensity: { lo: 600, hi: 6000 } }, OFF, false);
    expect(s.height).toEqual({ lo: 10, hi: 20 });
    expect(s.x).toEqual({ lo: 0, hi: 4 });
    expect(s.y).toBe(own.y);
    expect(s.intensity).toEqual({ lo: 600, hi: 6000 });
    // …and the legend says the set range back
    expect(legendSpan('height', s, OFF, false)).toEqual({ lo: 110, hi: 120 });
    // over height above ground the other stretch applies, and the terrain stays on the span
    const shift = () => 0;
    const hag = stretchSpans({ ...own, height: { lo: 0, hi: 30, shift } }, { height: { lo: 110, hi: 120 }, heightAboveGround: { lo: 1, hi: 9 } }, OFF, true);
    expect(hag.height).toEqual({ lo: 1, hi: 9, shift });
    // a range without a cloud-wide one still applies
    expect(stretchSpans({ ...own, intensity: null }, { intensity: { lo: 1, hi: 9 } }, OFF, false).intensity).toEqual({ lo: 1, hi: 9 });
    // a nonsense range is ignored
    expect(stretchSpans(own, { height: { lo: 5, hi: 5 } }, OFF, false).height).toEqual({ lo: 2, hi: 32 });
    expect(stretchSpans(own, undefined, OFF, false)).toBe(own);
    expect(rampRangeKey('height', true)).toBe('heightAboveGround');
    expect(rampRangeKey('tree_id', false)).toBeNull();
  });

  it('the colouring runs the Y ramp south to north over northings, and over the stretch', () => {
    // scene z is −(north − offset): the first point is 4 m south, the second 4 m north
    const ln = node(2, (i) => [0, 0, i === 0 ? 4 : -4]);
    colorNode(ln, 'y', 'viridis', { tree: 0, standing: 0, laying: 0 }, [255, 0, 255], undefined, {}, [120, 120, 120],
      { y: { lo: -4, hi: 4 } }, undefined, paint());
    expect(rgbOf(ln, 0)).toEqual(ramp(0));
    expect(rgbOf(ln, 1)).toEqual(ramp(1));
    // a stretch of the height ramp is what the points are coloured over
    const h = node(3, (i) => [0, [10, 15, 20][i], 0]);
    const s = stretchSpans(own, { height: { lo: 110, hi: 120 } }, OFF, false);
    colorNode(h, 'height', 'viridis', { tree: 0, standing: 0, laying: 0 }, [255, 0, 255], s.height, {}, [120, 120, 120], undefined, undefined, paint());
    expect(rgbOf(h, 0)).toEqual(ramp(0));
    expect(rgbOf(h, 1)).toEqual(ramp(0.5));
    expect(rgbOf(h, 2)).toEqual(ramp(1));
  });

  it('shades any mode by intensity, never the intensity mode itself or the selection', () => {
    const shade = { strength: 1, lo: 0, inv: 1 / 100 };
    const mk = () => node(3, () => [0, 0, 0], { intensity: Uint16Array.from([0, 100, 50]), selection: Uint8Array.from([0, 0, 1]) });
    const flat = mk();
    colorNode(flat, 'flat', 'viridis', { tree: 0, standing: 0, laying: 0 }, [255, 0, 255], undefined, {}, [120, 120, 120], undefined, undefined, paint({ shade }));
    // weak returns darker (0.35 ×), strong ones brighter (1.65 ×, clamped)
    expect(rgbOf(flat, 0)).toEqual([63, 63, 63]);
    expect(rgbOf(flat, 1)).toEqual([255, 255, 255]);
    expect(rgbOf(flat, 2)).toEqual([230, 30, 50]);
    // half strength halfway between
    const half = mk();
    colorNode(half, 'flat', 'viridis', { tree: 0, standing: 0, laying: 0 }, [255, 0, 255], undefined, {}, [120, 120, 120], undefined, undefined, paint({ shade: { ...shade, strength: 0.5 } }));
    expect(rgbOf(half, 0)).toEqual([Math.round(180 * 0.675), Math.round(180 * 0.675), Math.round(180 * 0.675)]);
    // off: the plain colours
    const plain = mk();
    colorNode(plain, 'flat', 'viridis', { tree: 0, standing: 0, laying: 0 }, [255, 0, 255], undefined, {}, [120, 120, 120], undefined, undefined, paint());
    expect(rgbOf(plain, 0)).toEqual([180, 180, 180]);
    const inten = mk();
    colorNode(inten, 'intensity', 'viridis', { tree: 0, standing: 0, laying: 0 }, [255, 0, 255], undefined, {}, [120, 120, 120], undefined, { lo: 0, hi: 100 }, paint({ shade }));
    expect(rgbOf(inten, 1)).toEqual(ramp(1));
  });

  it('the streamer colours with the stretch and states it in the legend', () => {
    const view = read('./OctreeView.tsx');
    expect(view).toMatch(/\.\.\.stretchSpans\(\s*\{ height: heightSpan, x: xSpan, y: ySpan, intensity: intensitySpan \},\s*display\.rampRanges, octree\.meta\.offset, heightAboveGround,\s*\)/);
    expect(view).toContain('sharedUniformsRef.current.spans = spans;');
    expect(view).toContain('legend = legendSpan(rampMode, spansRef.current, octree.meta.offset, !!colorTerrainRef.current);');
    // the shading is part of what a recolour runs on, and off by default
    expect(view).toContain('if (paint?.shade && mode !== \'intensity\') shadeByIntensity(ln, paint.shade);');
    expect(view).toContain('const r = shadeSet ?? shadeSeen ?? intensitySpan;');
    expect(view).toMatch(/const shadeOn = \(display\.shade \?\? 0\) > 0;/);
  });
});

describe('the histogram of the loaded points', () => {
  const nodes = [
    { v: Array.from({ length: 1000 }, (_, i) => i) },
    { v: Array.from({ length: 1000 }, (_, i) => 1000 + i) },
  ];
  it('covers every node and reads the percentiles a stretch cuts at', () => {
    const h = histogramOf(nodes, (n) => n.v.length, (n, i) => n.v[i], 'intensity', 20)!;
    expect(h.samples).toBe(2000);
    expect(h.lo).toBe(0);
    expect(h.hi).toBe(1999);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(2000);
    expect(h.p.p2).toBeGreaterThan(30);
    expect(h.p.p2).toBeLessThan(50);
    expect(h.p.p98).toBeGreaterThan(1950);
    expect(autoRange(h, true)).toEqual({ lo: Math.round(h.p.p2), hi: Math.round(h.p.p98) });
  });
  it('samples evenly across nodes when there are many points, and skips what is not a number', () => {
    const h = histogramOf(nodes, (n) => n.v.length, (n, i) => (i % 2 ? NaN : n.v[i]), 'x', 10, 500)!;
    expect(h.samples).toBeGreaterThan(200);
    expect(h.samples).toBeLessThanOrEqual(500);
    expect(histogramOf([], () => 0, () => 0, 'x')).toBeNull();
  });
  it('a drag lands on tidy numbers within the drawn domain', () => {
    expect(tidy(123.456789, 100, 140)).toBeCloseTo(123.5, 9);
    expect(domainT(5, { lo: 0, hi: 10 })).toBe(0.5);
    expect(drawnDomain(null, { lo: 1, hi: 2 })).toEqual({ lo: 1, hi: 2 });
  });
});

describe('the legend as a control', () => {
  it('a click hides a class, Alt-click shows it alone, and again everything', () => {
    expect(legendClick([], 2, false, 255)).toEqual([2]);
    expect(legendClick([2, 5], 2, false, 255)).toEqual([5]);
    const solo = legendClick([], 5, true, 255);
    expect(solo).toHaveLength(255);
    expect(solo).not.toContain(5);
    expect(legendClick(solo, 5, true, 255)).toEqual([]);
  });
  it('the Display panel and the legend stretch the same way; the viewer answers the histogram', () => {
    expect(read('../components/shell/DisplayPanel.tsx')).toContain('const r = useRampStretch();');
    expect(read('../components/shell/ColorLegend.tsx')).toContain('const stretch = useRampStretch();');
    const view = read('./OctreeView.tsx');
    expect(view).toContain('colorHistogram: (bins) => editApiRef.current?.colorHistogram(bins) ?? null,');
    expect(view).toContain('return histogramOf([...loadedRef.current.values()], (ln) => ln.numPoints, value, key, bins);');
    // in the legend's units: northings for Y, elevations unless above ground
    expect(view).toContain("else if (mode === 'y') value = (ln, i) => off[1] - ln.positions[i * 3 + 2];");
    expect(view).toContain("const key = mode === 'height' ? (hag ? 'heightAboveGround' : 'height') : mode;");
  });
});
