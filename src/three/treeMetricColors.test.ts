// Every tree coloured by what was measured of it.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { stripComments } from '../testing/sourceScan';
import type { TreeMetric } from '../persistence/octreeReader';
import type { Pair } from '../metrics/growth';
import {
  FLAG_RGB, TREE_TEX_MAX_ID, TREE_TEX_WIDTH, publishTreeGrowth, publishTreeMetrics, publishTreeQc, treeColorTexture,
  treeData, treeMetricDef, treeValueRange, treeValues,
} from './treeMetricColors';
import { colorNode, type LoadedNode } from './OctreeView';
import { isStretchable } from '../components/shell/RangeEditor';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const tree = (treeId: number, o: Partial<TreeMetric> = {}): TreeMetric => ({
  treeId, count: 1000, height: 20, dbh: 0.3, basalArea: 0.07, crownArea: 20, crownDiameter: 5, x: treeId, y: 0, baseZ: 0, leanDeg: 2, ...o,
});

describe('the value of each tree', () => {
  const rows = [tree(1, { height: 18, dbh: 0.25 }), tree(2, { height: 31, dbh: NaN, leanDeg: 12 }), tree(0), tree(5, { crownDiameter: 7.5 })];
  it('a measurement in its units, a tree without one left out', () => {
    expect([...treeValues('height', rows)]).toEqual([[1, 18], [2, 31], [5, 20]]);
    const dbh = treeValues('dbh', rows);
    expect(dbh.get(1)).toBeCloseTo(25, 9);
    expect(dbh.has(2)).toBe(false);
    expect(treeValues('crown', rows).get(5)).toBe(7.5);
    expect(treeValues('lean', rows).get(2)).toBe(12);
    expect(treeValues('height', null).size).toBe(0);
  });
  it('the QC flag: the published one, else what the metrics alone raise; every measured tree has one', () => {
    const qc = treeValues('qc', rows, null, new Map([[2, 3]]));
    expect(qc.get(2)).toBe(3);
    expect(qc.get(1)).toBe(0);
    // the missing DBH alone is a flag
    expect(treeValues('qc', rows).get(2)).toBeGreaterThan(0);
  });
  it('growth: the later epoch minus the earlier, on the later tree ids', () => {
    const pairs: Pair[] = [
      { ref: tree(10, { dbh: 0.30, height: 20 }), now: tree(3, { dbh: 0.32, height: 21.5 }), distance: 0.1 },
      { ref: tree(11, { dbh: NaN }), now: tree(4), distance: 0.2 },
    ];
    const d = treeValues('ddbh', rows, pairs);
    expect(d.get(3)).toBeCloseTo(2, 6);
    expect(d.has(4)).toBe(false);
    expect(treeValues('dheight', rows, pairs).get(3)).toBeCloseTo(1.5, 9);
    expect(treeValues('ddbh', rows, null).size).toBe(0);
  });
  it('the auto range is the trees’ 2–98 %', () => {
    const v = new Map(Array.from({ length: 101 }, (_, i) => [i + 1, i] as [number, number]));
    expect(treeValueRange(v)).toEqual({ lo: 2, hi: 98, min: 0, max: 100 });
    expect(treeValueRange(new Map([[1, 5]]))).toEqual({ lo: 5, hi: 6, min: 5, max: 5 });
    expect(treeValueRange(new Map())).toBeNull();
    expect(treeMetricDef(undefined).id).toBe('height');
  });
});

describe('the texture of tree colours', () => {
  it('one texel per id up to the largest, alpha 0 where nothing was measured', () => {
    const t = treeColorTexture(new Map([[1, 0], [3, 10]]), 'ramp', 'grayscale', { lo: 0, hi: 10 }, 'k');
    expect([t.width, t.height]).toEqual([4, 1]);
    expect(t.data[1 * 4 + 3]).toBe(255);
    expect(t.data[2 * 4 + 3]).toBe(0);
    expect(t.data[0 + 3]).toBe(0);
    // grayscale ends: dark at lo, light at hi
    expect(t.data[1 * 4]).toBeLessThan(40);
    expect(t.data[3 * 4]).toBeGreaterThan(200);
  });
  it('rows of 4096 for large ids; ids past the cap are left out', () => {
    const t = treeColorTexture(new Map([[5000, 1], [TREE_TEX_MAX_ID + 7, 1]]), 'ramp', 'viridis', { lo: 0, hi: 2 }, 'k');
    expect([t.width, t.height]).toEqual([TREE_TEX_WIDTH, 2]);
  });
  it('a flag in its fixed colours', () => {
    const t = treeColorTexture(new Map([[1, 3], [2, 0]]), 'flag', 'viridis', null, 'k');
    expect([...t.data.slice(4, 7)]).toEqual(FLAG_RGB[3]);
    expect([...t.data.slice(8, 11)]).toEqual(FLAG_RGB[0]);
  });
});

describe('the store the panels publish to', () => {
  it('keeps one dataset’s measurements, its growth and its flags', () => {
    const rows = [tree(1)];
    publishTreeMetrics('/a', rows);
    publishTreeGrowth('/a', []);
    expect(treeData().rows).toBe(rows);
    expect(treeData().pairs).toEqual([]);
    publishTreeQc('/a', null, [{ treeId: 1, severity: 'warning' }, { treeId: 1, severity: 'critical' }, { treeId: 2, severity: 'info' }]);
    expect(treeData().rows).toBe(rows);
    expect([...treeData().qc!]).toEqual([[1, 3], [2, 1]]);
    // another dataset starts empty
    const v = treeData().version;
    publishTreeGrowth('/b', null);
    expect(treeData()).toMatchObject({ dir: '/b', rows: null, pairs: null, qc: null });
    expect(treeData().version).toBeGreaterThan(v);
  });
});

describe('the mode in the point colouring', () => {
  /** Points of trees 1, 2 (measured), 3 (not measured) and 0 (no tree). */
  function node(): LoadedNode {
    const n = 4;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(n * 3), 3, true));
    return {
      geom, positions: new Float32Array(n * 3), treeIds: Int32Array.from([1, 2, 3, 0]), intensity: new Uint16Array(n),
      classification: new Uint8Array(n), returnNumber: new Uint8Array(n), semantic: new Uint8Array(n), extras: {},
      selection: null, dim: new Uint8Array(n), visibility: new Uint8Array(n).fill(1), strays: 0,
      standingDeadwood: null, layingDeadwood: null, tile: 0, record: 0,
    } as unknown as LoadedNode;
  }
  const rgb = (ln: LoadedNode, i: number) => Array.from((ln.geom.attributes.color.array as Uint8Array).slice(i * 3, i * 3 + 3));
  const tex = treeColorTexture(new Map([[1, 0], [2, 10]]), 'ramp', 'grayscale', { lo: 0, hi: 10 }, 'k');
  const paint = { shade: null, treeColors: { data: tex.data, count: tex.width * tex.height }, classLut: new Uint8Array(768) };

  it('each tree in its colour by its id, a tree not measured lighter grey, no tree the unlabelled colour', () => {
    const ln = node();
    colorNode(ln, 'tree_metric', 'grayscale', { tree: 0, standing: 0, laying: 0 }, [255, 0, 255], undefined, {}, [120, 120, 120], undefined, undefined, paint);
    expect(rgb(ln, 0)).toEqual(Array.from(tex.data.slice(4, 7)));
    expect(rgb(ln, 1)).toEqual(Array.from(tex.data.slice(8, 11)));
    expect(rgb(ln, 0)[0]).toBeLessThan(rgb(ln, 1)[0]);
    expect(rgb(ln, 2)).toEqual([120 + 41, 120 + 41, 120 + 41]);
    expect(rgb(ln, 3)).toEqual([120, 120, 120]);
    // the unassigned are the depth-cued background, as in tree_id
    expect(Array.from(ln.dim)).toEqual([0, 0, 0, 1]);
    // with nothing measured every tree is "not measured"
    const none = node();
    colorNode(none, 'tree_metric', 'grayscale', { tree: 0, standing: 0, laying: 0 }, [255, 0, 255], undefined, {}, [120, 120, 120], undefined, undefined, { ...paint, treeColors: null });
    expect(rgb(none, 0)).toEqual([161, 161, 161]);
  });

  it('the active tree is lit, the selection still red; the measurements stretch like any ramp', () => {
    const ln = node();
    ln.selection = Uint8Array.from([0, 1, 0, 0]);
    colorNode(ln, 'tree_metric', 'grayscale', { tree: 1, standing: 0, laying: 0 }, [255, 71, 188], undefined, {}, [120, 120, 120], undefined, undefined, paint);
    expect(rgb(ln, 0)).toEqual([255, 71, 188]);
    expect(rgb(ln, 1)).toEqual([230, 30, 50]);
    expect(isStretchable('tree_metric', 'dbh')).toBe(true);
    expect(isStretchable('tree_metric', 'qc')).toBe(false);
  });

  it('the viewer, the panels and the palette are wired', () => {
    const view = read('./OctreeView.tsx');
    expect(view).toContain('const values = treeValues(def.id, treeStore.rows, treeStore.pairs, treeStore.qc);');
    expect(view).toContain('() => ({ shade, treeColors: treeColours?.colors ?? null, classLut }),');
    // the legend is the trees' range, and a recolour follows the colours
    expect(view).toContain('legend = treeColoursRef.current?.range ?? null;');
    expect(view).toMatch(/\}, \[display\.colorMode, display\.ramp, display\.customRamp, activeTreeId, activeStandingId, activeLayingId, activeRgb, unlabeledRgb, spans, paint, hydrateExtraColumn\]\);/);
    expect(read('../components/shell/TreeGrowthPanel.tsx')).toContain('publishTreeGrowth(octree.dir, result?.matches ?? null);');
    expect(read('../components/shell/QcPanel.tsx')).toContain('publishTreeQc(octree.dir, metrics, flags);');
    expect(read('../components/shell/DisplayPanel.tsx')).toContain("{display.colorMode === 'tree_metric' && <TreeMetricPicker />}");
    expect(read('../components/shell/EditorShell.tsx')).toContain('TREE_METRICS.forEach(m => cmds.push({ id: `colour.tree.${m.id}`');
  });
});
