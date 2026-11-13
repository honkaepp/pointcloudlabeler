import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { stripComments } from '../testing/sourceScan';
import { pointInPolygon } from './selectionMath';
import {
  DRAG_LEVEL_SINE, SHIFT_TEX_WIDTH, dragDelta, dragPlane, drawnPosition, getTreeShift, moveBy,
  setTreeShift, shiftAway, shiftBearing, shiftForView, shiftSlots, slotTexel, subscribeTreeShift, type ShiftEN,
} from './treeShift';
import { rayPlane, type ViewRay } from './planePick';
import { describeOffset, ruleOffset, treeCentre } from '../components/shell/TreeShiftSection';

type V3 = [number, number, number];
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const DIR = 'C:/data/plot/octrees/p1';
const spec = (offsets: Array<[number, ShiftEN]>, anchor = 33, dir = DIR) => ({ dir, anchor, offsets: new Map(offsets) });

afterEach(() => setTreeShift(null));

describe('the offset of a tree drawn aside', () => {
  it('belongs to one dataset and one isolated tree', () => {
    const s = spec([[42, [2, 0]]]);
    expect(shiftForView(s, DIR, 33)).not.toBeNull();
    expect(shiftForView(s, 'C:/data/other', 33), 'another dataset').toBeNull();
    expect(shiftForView(s, DIR, 34), 'another tree isolated').toBeNull();
    expect(shiftForView(s, DIR, null), 'nothing isolated').toBeNull();
    expect(shiftForView(null, DIR, 33)).toBeNull();
  });

  it('is east and north on the ground, scene x and −z, and never moves the unassigned', () => {
    const v = shiftForView(spec([[42, [2, 0.5]], [60, [-1, -3]], [0, [5, 5]], [-7, [1, 1]], [61, [0, 0]]]), DIR, 33)!;
    const ids = [...v.lookup.keys()];
    expect(ids.sort((a, b) => a - b)).toEqual([42, 60]);
    expect(v.lookup.get(42)).toEqual([2, 0, -0.5]);
    expect(v.lookup.get(60)).toEqual([-1, 0, 3]);
    expect(v.reach).toBeCloseTo(Math.hypot(1, 3), 12);
    // only zero or unassigned offsets: nothing to draw
    expect(shiftForView(spec([[0, [3, 3]], [61, [0, 0]]]), DIR, 33)).toBeNull();
  });

  it('reaches the shader as a slot per tree, its offset in the slot\'s texel', () => {
    // Over a row of the texture, so the second row is read too, with ids
    // far apart and close together.
    const lookup = new Map<number, V3>();
    let id = 3;
    for (let k = 0; k < SHIFT_TEX_WIDTH + 900; k++) {
      id += 1 + ((k * 7919) % 13);
      lookup.set(id, [((k % 17) - 8) * 0.37, 0, ((k % 11) - 5) * 1.13]);
    }
    lookup.set(2_000_000_123, [12.5, 0, -0.25]);
    const s = shiftSlots(lookup);
    expect(s.slotOf.size).toBe(lookup.size);
    expect(s.width).toBe(SHIFT_TEX_WIDTH);
    expect(s.height).toBe(2);
    const at = (slot: number): V3 => {
      const [x, y] = slotTexel(slot, s.width);
      const t = (y * s.width + x) * 4;
      return [s.data[t], s.data[t + 1], s.data[t + 2]];
    };
    let prev = 0;
    for (const i of [...lookup.keys()].sort((a, b) => a - b)) {
      const slot = s.slotOf.get(i)!;
      expect(slot, `id ${i}`).toBe(prev + 1);
      prev = slot;
      const o = lookup.get(i)!;
      expect(at(slot), `id ${i}`).toEqual([Math.fround(o[0]), Math.fround(o[1]), Math.fround(o[2])]);
    }
    // slot 0 (not moved) reads nothing
    expect(at(0)).toEqual([0, 0, 0]);
    // the vertex shader's texel address is slotTexel's
    expect(slotTexel(SHIFT_TEX_WIDTH + 5, SHIFT_TEX_WIDTH)).toEqual([5, 1]);
    // a drag (new offsets, the same trees) keeps every slot; another tree does not
    const moved = new Map([...lookup].map(([i, o]) => [i, [o[0] + 1, 0, o[2]] as V3]));
    expect(shiftSlots(moved).key).toBe(s.key);
    expect(shiftSlots(new Map([[5, [1, 0, 0]]])).key).not.toBe(shiftSlots(new Map([[6, [1, 0, 0]]])).key);
    expect(shiftSlots(new Map([[5, [1, 0, 0]]]))).toMatchObject({ width: 2, height: 1 });
  });
});

describe('the point shader and the viewer draw and select it', () => {
  const view = stripComments(read('src/three/OctreeView.tsx'));

  it('the vertex shader moves the drawn position by the offset in the point\'s slot', () => {
    expect(view).toContain('attribute float aShift;');
    expect(view).toContain('vec2 ij = vec2(mod(slot, uShiftTexSize.x), floor(slot / uShiftTexSize.x));');
    expect(view).toContain('return texture2D(uShiftTex, (ij + 0.5) / uShiftTexSize).xyz;');
    // after the terrain comes off, before the view matrix
    expect(view).toMatch(/if \(uFlatten > 0\.5\) pos\.y -= dtmShift\(pos\.xz\);\s*if \(uShiftOn > 0\.5 && aShift > 0\.5\) pos \+= treeShift\(aShift\);\s*vec4 viewPos = modelViewMatrix/);
    // a node reads it only while it holds a moved tree's points
    expect(view).toContain('on.value = any ? 1 : 0;');
    expect(view).toContain('bs.radius = ln.baseRadius + (on ? shared.shiftReach : 0);');
  });

  it('the viewer draws it for the edited cloud only, while its tree is isolated, and follows the ids', () => {
    expect(view).toContain('const view = primary ? shiftForView(getTreeShift(), octree.dir, isolateId) : null;');
    expect(view).toContain('if (same) fitShiftSphere(ln, su); else writeShiftSlots(ln, su);');
    // a point whose id changes is drawn where its new tree is; a node
    // loaded later gets its slots too
    expect(view).toContain('if (sharedUniformsRef.current.shift) writeShiftSlots(ln, sharedUniformsRef.current);');
    expect(view).toContain('if (shared.shift) writeShiftSlots(ln, shared);');
    // the planner and the selection's node tests widen by the reach, sideways
    expect(view).toContain('sphere.radius = r + shared.relief + shared.shiftReach;');
    expect(view).toContain('const wx = (c & 1) ? b[o + 3] + reach : b[o] - reach;');
    // every CPU projection uses the drawn position
    expect(view).toContain('drawnPosition(DRAWN, sx, sy, sz, id, drawnY(sx, sy, sz), shiftLookupRef.current);');
    // and a pick hands back the stored point, never the drawn one
    expect(view).toMatch(/best = \[px, py, pz\]/);
    expect(view).toContain('best = { x: px + off[0], y: off[1] - pz, z: py + off[2] };');
  });
});

/** The CPU selection of OctreeView's selectByShape ('through'), point for
 *  point: project where each point is drawn, keep those in the polygon. */
function cpuLasso(
  pos: Float32Array, ids: Int32Array, lookup: ReadonlyMap<number, V3> | null,
  m: THREE.Matrix4, W: number, H: number, poly: [number, number][],
): number[] {
  const out: number[] = [];
  const v = new THREE.Vector4();
  const d = new Float64Array(3);
  for (let i = 0; i < ids.length; i++) {
    const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
    drawnPosition(d, px, py, pz, ids[i], py, lookup);
    v.set(d[0], d[1], d[2], 1).applyMatrix4(m);
    if (v.w <= 0) continue;
    const iw = 1 / v.w;
    const sx = (v.x * iw * 0.5 + 0.5) * W;
    const sy = (-v.y * iw * 0.5 + 0.5) * H;
    if (pointInPolygon(sx, sy, poly)) out.push(i);
  }
  return out;
}

describe('a lasso takes the points where they are drawn', () => {
  // Two crowns in one place: tree 33 (the isolated one) and tree 42, its
  // points interleaved with 33's along the same line. Scene axes.
  const N = 40;
  const pos = new Float32Array(N * 2 * 3);
  const ids = new Int32Array(N * 2);
  for (let k = 0; k < N; k++) {
    // tree 33 from x −1 to 1, tree 42 between its points
    const x33 = -1 + (2 * k) / N, x42 = x33 + 1 / N;
    pos.set([x33, 10 + (k % 5) * 0.2, 0.1 * (k % 3)], k * 3);
    pos.set([x42, 10 + (k % 4) * 0.25, -0.1 * (k % 3)], (N + k) * 3);
    ids[k] = 33;
    ids[N + k] = 42;
  }
  const stored = pos.slice();
  // Looking north at the crowns from 20 m away (scene −z is north).
  const W = 800, H = 600;
  const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 500);
  cam.position.set(1.5, 10.5, 20);
  cam.lookAt(1.5, 10.5, 0);
  cam.updateMatrixWorld();
  const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const toScreen = (x: number, y: number, z: number): [number, number] => {
    const v = new THREE.Vector4(x, y, z, 1).applyMatrix4(m);
    return [(v.x / v.w * 0.5 + 0.5) * W, (-v.y / v.w * 0.5 + 0.5) * H];
  };
  /** A screen box around a scene region x0..x1, heights 9.5–11.5. */
  const boxAround = (x0: number, x1: number): [number, number][] => {
    const a = toScreen(x0, 9.5, 0), b = toScreen(x1, 11.5, 0);
    return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  };
  // Tree 42 drawn 3 m east (Tree Review's pull-apart around tree 33).
  const view = shiftForView(spec([[42, [3, 0]]]), DIR, 33)!;
  const tree42 = Array.from({ length: N }, (_, k) => N + k);
  const tree33 = Array.from({ length: N }, (_, k) => k);

  it('around the moved tree: all of its points and none of the isolated tree’s', () => {
    const got = cpuLasso(pos, ids, view.lookup, m, W, H, boxAround(1.8, 4.2));
    expect(got).toEqual(tree42);
  });

  it('around the place it was moved from: the isolated tree’s points there, none of the moved one’s', () => {
    const got = cpuLasso(pos, ids, view.lookup, m, W, H, boxAround(-1.2, 1.2));
    expect(got).toEqual(tree33);
    // with nothing moved the same lasso takes both trees — the knot
    expect(cpuLasso(pos, ids, null, m, W, H, boxAround(-1.2, 1.2))).toEqual([...tree33, ...tree42]);
  });

  it('the CPU paths place a point where the shader draws it', () => {
    // the shader: the offset in the texel of the point's slot (0: none)
    const slots = shiftSlots(view.lookup);
    const shaderShift = (id: number): V3 => {
      const slot = slots.slotOf.get(id) ?? 0;
      if (slot === 0) return [0, 0, 0];
      const [x, y] = slotTexel(slot, slots.width);
      const t = (y * slots.width + x) * 4;
      return [slots.data[t], slots.data[t + 1], slots.data[t + 2]];
    };
    const d = new Float64Array(3);
    for (let i = 0; i < ids.length; i++) {
      const p: V3 = [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
      const g = shaderShift(ids[i]);
      drawnPosition(d, p[0], p[1], p[2], ids[i], p[1], view.lookup);
      for (let a = 0; a < 3; a++) expect(Math.abs(d[a] - (p[a] + g[a]))).toBeLessThan(1e-6);
    }
    // the drawn height (terrain off) passes through unchanged
    drawnPosition(d, 1, 10, 2, 42, 7.5, view.lookup);
    expect([...d]).toEqual([4, 7.5, 2]);
  });

  it('a point given back to the isolated tree is drawn at home at once', () => {
    const ids2 = ids.slice();
    ids2[N + 5] = 33; // a branch of 42 was really 33's
    const moved = cpuLasso(pos, ids2, view.lookup, m, W, H, boxAround(1.8, 4.2));
    expect(moved).not.toContain(N + 5);
    expect(cpuLasso(pos, ids2, view.lookup, m, W, H, boxAround(-1.2, 1.2))).toContain(N + 5);
  });

  it('never touches the stored coordinates', () => {
    expect(Array.from(pos)).toEqual(Array.from(stored));
  });
});

describe('moving the trees', () => {
  const ray = (from: V3, dir: V3): ViewRay => ({ a: from, b: [from[0] + dir[0] * 100, from[1] + dir[1] * 100, from[2] + dir[2] * 100], a1: from, b1: from });

  it('from above, a drag moves over the ground; from the side, along the screen', () => {
    const at: V3 = [500, 7000, 120];
    const top = dragPlane(ray([500, 7000, 200], [0.1, 0.05, -1]), at);
    expect(top.normal).toEqual([0, 0, 1]);
    const side = dragPlane(ray([500, 6980, 125], [0, 1, -0.2]), at);
    expect(side.normal[2]).toBe(0);
    expect(Math.hypot(side.normal[0], side.normal[1])).toBeCloseTo(1, 12);
    expect(side.normal[1]).toBeCloseTo(1, 12);
    // the steepness where it switches
    const s = DRAG_LEVEL_SINE;
    expect(dragPlane(ray([0, 0, 10], [Math.sqrt(1 - (s + 0.01) ** 2), 0, -(s + 0.01)]), at).normal).toEqual([0, 0, 1]);
    expect(dragPlane(ray([0, 0, 10], [Math.sqrt(1 - (s - 0.01) ** 2), 0, -(s - 0.01)]), at).normal[2]).toBe(0);
    // a side view looking north: the pointer moving right moves the tree east,
    // and up the screen moves it nowhere (the move is horizontal)
    const p0 = rayPlane([500, 6980, 125], [500, 7080, 105], side)!;
    const p1 = rayPlane([500, 6980, 125], [502, 7080, 125], side)!;
    const d = dragDelta(p0, p1);
    expect(d[0]).toBeGreaterThan(0);
    expect(Math.abs(d[1])).toBeLessThan(1e-9);
  });

  it('a drag moves every moved tree by the same amount, from where it was', () => {
    const base = new Map<number, ShiftEN>([[42, [2, 0]], [60, [0, -2]]]);
    const next = moveBy(base, base.keys(), [0.5, 1]);
    expect(next.get(42)).toEqual([2.5, 1]);
    expect(next.get(60)).toEqual([0.5, -1]);
    expect(base.get(42)).toEqual([2, 0]);
  });

  it('the distance and direction rules', () => {
    expect(shiftAway([0, 0], [3, 4], 2)).toEqual([1.2, 1.6]);
    expect(shiftAway([5, 5], [5, 5], 2)).toEqual([2, 0]);
    expect(shiftBearing(0, 2)).toEqual([0, 2]);
    expect(shiftBearing(90, 2)).toEqual([2, 0]);
    expect(shiftBearing(180, 1.5)).toEqual([0, -1.5]);
    expect(shiftBearing(270, 1)).toEqual([-1, 0]);
    expect(ruleOffset('away', 2, [0, 0, 5], [0, -4, 5])).toEqual([0, -2]);
    expect(ruleOffset('W', 3, [0, 0, 5], [0, -4, 5])).toEqual([-3, 0]);
    expect(describeOffset([2, -0.5])).toBe('2.00 m E, 0.50 m S');
    expect(describeOffset([0, 0])).toBe('in place');
    // a scan from before the density centre: the box's centre
    expect(treeCentre({ treeId: 1, count: 1, bboxMin: [0, 0, 0], bboxMax: [2, 4, 10] } as never)).toEqual([1, 2, 5]);
  });
});

describe('the store', () => {
  it('tells the viewer about every change and holds nothing empty', () => {
    const seen: Array<unknown> = [];
    const off = subscribeTreeShift(() => seen.push(getTreeShift()));
    const s = spec([[42, [2, 0]]]);
    setTreeShift(s);
    expect(getTreeShift()).toBe(s);
    setTreeShift(spec([]));
    expect(getTreeShift()).toBeNull();
    setTreeShift(null); // no change, no call
    off();
    setTreeShift(s);
    expect(seen).toEqual([s, null]);
  });
});

describe('the panel and the viewport', () => {
  const section = stripComments(read('src/components/shell/TreeShiftSection.tsx'));
  const view = stripComments(read('src/three/OctreeView.tsx'));
  const panel = stripComments(read('src/components/shell/TreeReviewPanel.tsx'));

  it('drags in the view through the world picker, and the lasso stays out of it', () => {
    // React would CALL a picker handed straight to its state setter
    expect(section).toContain('setWorldPicker(() => picker);');
    expect(section).not.toMatch(/setWorldPicker\(picker\)/);
    expect(view).toContain('grabbing = drag.start(rayAt(e));');
    expect(view).toContain('if (drag && grabbing) { drag.move(rayAt(e)); e.stopPropagation(); }');
    expect(view).toContain('if (pickerOnRef.current) return;');
  });

  it('puts every tree back when the section goes, and drops a shift made around another tree', () => {
    expect(section).toContain('useEffect(() => () => { setTreeShift(null); }, []);');
    expect(section).toMatch(/if \(s && \(s\.dir !== dir \|\| s\.anchor !== anchorId\)\) setTreeShift\(null\);/);
    expect(panel).toMatch(/<TreeShiftSection\s+dir=\{octree\.dir\}\s+anchor=\{selectedEntry\}/);
  });
});
