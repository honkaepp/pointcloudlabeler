// The parallel projection, the section view, the scale bar and north
// arrow, and saved views — on the point renderer, whose fixed-pixel points
// need nothing of the projection, while the planner, the clipping, the
// picks and the eye-dome lighting do.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import { ViewCamera, isOrtho, orthoHalfHeight, orthoSizingDistance, syncOrtho, unitsPerPixel } from './viewCamera';
import { formatLength, niceLength, northAngle } from './ViewHud';
import { applyFilters, colorNode, type LoadedNode } from './OctreeView';
import { admits, refines } from './lodPlanner';
import { DEFAULT_FILTERS, type FilterConfig } from '../components/shell/OctreeShellContext';
import { sectionPose } from '../components/shell/SlabPanel';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

function camAt(pos: [number, number, number], target: [number, number, number], ortho: boolean): ViewCamera {
  const c = new ViewCamera(45, 16 / 9, 0.1, 1000);
  c.position.set(...pos);
  c.lookAt(...target);
  c.ortho = ortho;
  syncOrtho(c, c.position.distanceTo(new THREE.Vector3(...target)), 100);
  c.updateProjectionMatrix();
  c.updateMatrixWorld();
  return c;
}

describe('the parallel projection', () => {
  it('shows at every depth what the perspective view shows at the target', () => {
    const target: [number, number, number] = [0, 0, 0];
    const persp = camAt([0, 0, 40], target, false);
    const ortho = camAt([0, 0, 40], target, true);
    // a point on the target plane lands on the same pixel in both
    const p = new THREE.Vector3(5, 3, 0);
    const a = p.clone().project(persp), b = p.clone().project(ortho);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
    // and a point 20 m behind it does not shrink in the parallel one
    const q = new THREE.Vector3(5, 3, -20).project(ortho);
    expect(q.x).toBeCloseTo(b.x, 9);
    expect(new THREE.Vector3(5, 3, -20).project(persp).x).toBeLessThan(a.x);
  });
  it('sees what lies behind the camera too, and is told apart by its matrix', () => {
    const ortho = camAt([0, 0, 10], [0, 0, 0], true);
    expect(ortho.orthoNear).toBeLessThan(0);
    const behind = new THREE.Vector3(0, 0, 30).project(ortho);
    expect(Math.abs(behind.z)).toBeLessThanOrEqual(1);
    expect(ortho.projectionMatrix.elements[15]).toBe(1);
    expect(camAt([0, 0, 10], [0, 0, 0], false).projectionMatrix.elements[15]).toBe(0);
  });
  it('a pick projects with it as the viewer does: no point is lost behind a w of 0', () => {
    // the viewer's CPU picks skip v.w <= 0 and |ndc z| > 1 — in a parallel
    // view w is 1 everywhere, and the whole scene is within near / far
    const ortho = camAt([0, 0, 10], [0, 0, 0], true);
    const m = new THREE.Matrix4().multiplyMatrices(ortho.projectionMatrix, ortho.matrixWorldInverse);
    for (const z of [-80, -1, 0, 9, 30]) {
      const v = new THREE.Vector4(1, 2, z, 1).applyMatrix4(m);
      expect(v.w).toBe(1);
      expect(Math.abs(v.z / v.w)).toBeLessThanOrEqual(1);
    }
  });
  it('sizes things at the target distance, and copies its state with a clone', () => {
    const ortho = camAt([0, 0, 40], [0, 0, 0], true);
    expect(orthoSizingDistance(ortho)).toBeCloseTo(40, 9);
    expect(orthoSizingDistance(camAt([0, 0, 40], [0, 0, 0], false))).toBe(0);
    const c = ortho.clone();
    expect(isOrtho(c)).toBe(true);
    expect(c.orthoDistance).toBeCloseTo(40, 9);
    expect(orthoHalfHeight(ortho)).toBeCloseTo(40 * Math.tan(Math.PI / 8), 9);
  });
  it('a scale bar is exact in it and holds at the target in perspective', () => {
    const ortho = camAt([0, 0, 40], [0, 0, 0], true);
    const upp = unitsPerPixel(ortho, new THREE.Vector3(0, 0, 0), 900);
    expect(upp).toBeCloseTo((2 * 40 * Math.tan(Math.PI / 8)) / 900, 9);
    expect(niceLength(upp * 120)).toBe(2);
    expect(niceLength(7.3)).toBe(5);
    expect(niceLength(0.031)).toBe(0.02);
    expect(formatLength(20)).toBe('20 m');
    expect(formatLength(0.05)).toBe('5 cm');
    expect(formatLength(2000)).toBe('2 km');
  });
  it('the north arrow points to grid north as the view sees it', () => {
    // scene −z is north; looking down from above with north up
    const top = camAt([0, 50, 0.01], [0, 0, 0], true);
    top.up.set(0, 1, 0);
    expect(northAngle(top, new THREE.Vector3(0, 0, 0))).toBeCloseTo(0, 2);
    // standing south of the target looking north: north is into the view
    const facingNorth = camAt([0, 0, 40], [0, 0, 0], false);
    expect(northAngle(facingNorth, new THREE.Vector3(0, 0, 0))).toBeNull();
    // standing west looking east: north is to the left
    const facingEast = camAt([-40, 10, 0], [0, 0, 0], false);
    expect(northAngle(facingEast, new THREE.Vector3(0, 0, 0))).toBeCloseTo(-Math.PI / 2, 3);
  });
  it('the eye-dome lighting reads a parallel view\'s depth as the distance it is', () => {
    // A parallel projection writes depth linear in the view distance
    // between its own near and far (near behind the camera); the EDL pass
    // inverts exactly that, and floors the distance a little in front.
    const ortho = camAt([0, 0, 40], [0, 0, 0], true);
    const n = ortho.orthoNear, f = ortho.orthoFar;
    for (const dist of [1, 25, 40, 70]) {
      const p = new THREE.Vector3(3, -2, 40 - dist).project(ortho);
      const depth01 = p.z * 0.5 + 0.5;
      const ndc = depth01 * 2 - 1;
      const lin = Math.max(0.5 * (ndc * (f - n) + f + n), 0.05 * ortho.orthoDistance);
      expect(lin).toBeCloseTo(Math.max(dist, 2), 6);
    }
    const edl = read('./EdlPass.tsx');
    expect(edl).toContain('float lin = 0.5 * (ndc * (uFar - uNear) + uFar + uNear);');
    expect(edl).toContain('return max(lin, 0.05 * uOrthoDist);');
    expect(edl).toMatch(/if \(isOrtho\(cam\)\) \{\s*u\.uOrtho\.value = 1;\s*u\.uNear\.value = cam\.orthoNear;\s*u\.uFar\.value = cam\.orthoFar;/);
    // the perspective identity is unchanged
    expect(edl).toContain('return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));');
  });
  it('the points need nothing of it: fixed pixels at every depth', () => {
    const view = read('./OctreeView.tsx');
    expect(view).toContain('gl_Position = projectionMatrix * viewPos;');
    expect(view).toContain('gl_PointSize = aVisible > 1.5 ? max(uSize, ${STRAY_PX.toFixed(1)}) : uSize;');
    // a press in a parallel view pivots at the point's depth without
    // zooming: camera and target move along the view axis together
    expect(view).toMatch(/if \(isOrtho\(cam\)\) \{[\s\S]{0,400}?cam\.position\.addScaledVector\(dir, along\);\s*ctl\.target\.addScaledVector\(dir, along\);/);
  });
  it('the planner sizes nodes at its distance, and the viewer switches and zooms it', () => {
    const view = read('./OctreeView.tsx');
    expect(view).toContain('orthoDist > 0 ? orthoDist : Math.sqrt(dx * dx + dy * dy + dz * dz)');
    expect(view).toContain('camera={viewCamera}');
    expect(view).toContain("<ProjectionSync projection={display.projection ?? 'perspective'}");
    expect(view).toContain('if (isOrtho(cam)) syncOrtho(cam, d, extent);');
    expect(view).toContain('<ViewHud orbitRef={orbitRef}');
    expect(read('../state/keybindings.ts')).toContain("{ id: 'view.ortho',");
  });

  it('is one camera a canvas, its aspect the canvas\'s, so a reloaded cloud is not drawn stretched', () => {
    const view = read('./OctreeView.tsx');
    // made again only with a new canvas, not when a reload of the same
    // cloud gives the bounding box new arrays
    expect(view).toMatch(/const viewCamera = useMemo\(\(\) => \{[\s\S]*?\}, \[octree\.dir, canvasEpoch\]\);/);
    expect(view).toContain('key={`${octree.dir}#${canvasEpoch}`}');
    // and kept at the canvas's aspect every frame, whatever replaced it
    expect(view).toContain('if (width > 0 && height > 0 && Math.abs(cam.aspect - width / height) > 1e-6) {');
  });

  it('draws an isolated tree whole: its strays large and bright, never left out by the budget', () => {
    // The isolated tree's records are forced: always admitted and refined,
    // whatever the budget (the renderer draws forced nodes whole).
    expect(admits({ isRoot: false, forced: true, wasVisible: false, weight: 0, plannedPoints: 1e9, pointBudget: 1 })).toBe(true);
    expect(refines(1e9, 1, true)).toBe(true);
    // Points of tree 7 inside the margin ring, one 10 m east of it, and
    // one of another tree out there too.
    const n = 4;
    const positions = Float32Array.from([0, 1, 0, 1, 1, -1, 10, 1, 0, 10, 1, 0.5]);
    const ln = {
      positions, treeIds: Int32Array.from([7, 7, 7, 8]), classification: new Uint8Array(n), deleted: null,
      visibility: new Uint8Array(n), strays: 0, semantic: null, intensity: new Uint16Array(n), extras: {},
      standingDeadwood: null, layingDeadwood: null, tile: 0, record: 0,
    } as unknown as LoadedNode;
    const f: FilterConfig = {
      ...DEFAULT_FILTERS, isolateTreeId: 7, isolateBox: [[-2, -2, 0], [2, 2, 20]], isolateMargin: 0.5,
      isolateShowOthers: true,
    };
    // (the other tree's point out there is clipped by the ring as before)
    expect(applyFilters(ln, f, [0, 0, 0])).toBe(3);
    expect(Array.from(ln.visibility)).toEqual([1, 1, 2, 0]);
    expect(ln.strays).toBe(1);
    // off by the toggle: drawn as any other point
    applyFilters(ln, { ...f, isolateHighlightStrays: false }, [0, 0, 0]);
    expect(Array.from(ln.visibility)).toEqual([1, 1, 1, 0]);
    // painted bright yellow, unless selected, and never depth-cued
    applyFilters(ln, f, [0, 0, 0]);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(n * 3), 3, true));
    Object.assign(ln, { geom, dim: new Uint8Array(n), selection: null, returnNumber: new Uint8Array(n) });
    colorNode(ln, 'tree_id', 'viridis', { tree: 7, standing: 0, laying: 0 }, [255, 0, 255], undefined, {}, [120, 120, 120]);
    const c = geom.attributes.color.array as Uint8Array;
    expect(Array.from(c.slice(6, 9))).toEqual([255, 219, 38]);
    expect(Array.from(c.slice(0, 3))).toEqual([255, 0, 255]);
    ln.selection = Uint8Array.from([0, 0, 1, 0]);
    colorNode(ln, 'tree_id', 'viridis', { tree: 7, standing: 0, laying: 0 }, [255, 0, 255], undefined, {}, [120, 120, 120]);
    expect(Array.from(c.slice(6, 9))).toEqual([230, 30, 50]);
    // the shader draws them at least six pixels across; every "is it
    // drawn" test reads visibility !== 0
    const view = read('./OctreeView.tsx');
    expect(view).toContain('gl_PointSize = aVisible > 1.5 ? max(uSize, ${STRAY_PX.toFixed(1)}) : uSize;');
    expect(view).toContain('const STRAY_PX = 6;');
    expect(view).toContain('const strayBox = ibox !== null && f.isolateHighlightStrays !== false ? ibox : null;');
    expect(read('../components/shell/TreeReviewPanel.tsx')).toContain('onChange={(v) => setFilters({ isolateHighlightStrays: v })}');
  });
});

describe('the section view', () => {
  it('looks along the slab at true scale, the plot face filling the view', () => {
    // an east–west slab (normal north) through (100, 200, 50), offset (100, 200, 0)
    const p = sectionPose([100, 200, 50], [0, 1, 0], [100, 200, 0], 40, 30, 16 / 9);
    expect(p.target).toEqual([0, 50, -0]);
    // the camera south of it, looking north (scene −z)
    expect(p.position[2]).toBeGreaterThan(0);
    expect(p.position[0]).toBeCloseTo(0, 9);
    const dist = p.position[2];
    expect(2 * dist * Math.tan(Math.PI / 8)).toBeCloseTo(30 * 1.08, 6);
    // a horizontal slab: from above, north up
    const h = sectionPose([100, 200, 50], [0, 0, 1], [100, 200, 0], 40, 30, 16 / 9);
    expect(h.position[1]).toBeGreaterThan(50);
    expect(h.position[2]).toBeGreaterThan(0);
  });
  it('steps with [ and ] while the slab is on', () => {
    const slab = read('../components/shell/SlabPanel.tsx');
    expect(slab).toContain("if (e.key === '[') { e.preventDefault(); step(-1); }");
    expect(slab).toContain("setDisplay({ projection: 'ortho' });");
  });
});

describe('saved views', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
  });
  afterEach(() => { delete (globalThis as Record<string, unknown>).localStorage; });

  it('are kept per dataset, with the projection', async () => {
    const vt = await import('../components/shell/viewToolsStore');
    vt.resetViewTools();
    vt.bindViewDataset('C:/p/octrees/plot');
    vt.registerViewer({ getPose: () => ({ position: [1, 2, 3], target: [0, 0, 0] }), setPose: () => {}, canvas: {} as HTMLCanvasElement });
    vt.saveView('', 'ortho');
    vt.saveView('Stem 12', 'perspective');
    expect(vt.getViewTools().savedViews.map((v) => v.name)).toEqual(['View 1', 'Stem 12']);
    vt.renameView('View 1', 'North edge');
    vt.deleteView('Stem 12');
    vt.bindViewDataset('C:/p/octrees/other');
    expect(vt.getViewTools().savedViews).toEqual([]);
    vt.bindViewDataset('C:/p/octrees/plot');
    expect(vt.getViewTools().savedViews).toEqual([{ position: [1, 2, 3], target: [0, 0, 0], name: 'North edge', projection: 'ortho' }]);
    vt.registerViewer(null);
  });
});
