// The stem review: the stems one at a time from above at breast
// height, moved, measured, added and deleted there (forestStore's edits,
// StemReview.tsx), and the viewport's clicks on the slab's plane.

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';
import type { ForestSeed } from './forest';
import {
  axisAt, BH, measureSeed, moveSeed, reviewOrder, seedGeometry, stemDoubts, unmeasureSeed, validMarks,
} from './forestStore';
import { sectionPose } from './SlabPanel';
import { ViewCamera, syncOrtho } from '../../three/viewCamera';
import { pickOnPlane, planePicker, rayPlane } from '../../three/planePick';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const seed = (id: number, x: number, y: number, o: Partial<ForestSeed> = {}): ForestSeed => ({
  id, tree: id, x, y, z: 100, r: 0.15, lean: [0, 0], top: 2.2, circles: 4, source: 'circle', ...o,
});

describe('correcting a stem from above', () => {
  it('a move puts the axis at breast height where clicked, keeping the lean', () => {
    const s = seed(1, 0, 0, { lean: [0.1, -0.05] });
    const out = moveSeed([s, seed(2, 5, 5)], 1, 3, 4);
    const [ax, ay] = axisAt(out[0]);
    expect(ax).toBeCloseTo(3, 12);
    expect(ay).toBeCloseTo(4, 12);
    expect(out[0].lean).toEqual([0.1, -0.05]);
    expect(out[0].source).toBe('circle');
    expect(out[1]).toEqual(seed(2, 5, 5));
  });
  it('a stem measured by hand keeps its circle; it can be handed back to the forest pass', () => {
    const s = seed(1, 0, 0, { lean: [0.1, 0] });
    const m = measureSeed([s], 1, 0.21, [2, 1])[0];
    expect(m.source).toBe('manual');
    expect(m.r).toBe(0.21);
    expect(axisAt(m)[0]).toBeCloseTo(2, 12);
    expect(axisAt(m)[1]).toBeCloseTo(1, 12);
    // the radius alone leaves the centre where it is
    expect(measureSeed([s], 1, 0.3)[0]).toMatchObject({ x: 0, y: 0, r: 0.3, source: 'manual' });
    expect(unmeasureSeed([m], 1)[0].source).toBe('circle');
    expect(unmeasureSeed([{ ...m, circles: 0 }], 1)[0].source).toBe('user');
    expect(unmeasureSeed([s], 1)[0]).toEqual(s);
  });
  it('says why a stem is worth a look', () => {
    const seeds = [seed(1, 0, 0), seed(2, 3, 0, { source: 'flow', circles: 0, r: 0 }), seed(3, 6, 0, { tree: 4 }), seed(4, 6.5, 0)];
    expect(stemDoubts(seeds, seeds[0])).toEqual([]);
    expect(stemDoubts(seeds, seeds[1])).toEqual(['found from the flow of its branches only (no stem circle)', 'no diameter']);
    expect(stemDoubts(seeds, seeds[2])).toEqual(['one of 2 stems of tree 4']);
    expect(stemDoubts(seeds, seeds[0], [{ a: 9, b: 1, votes: 2, x: 0, y: 0, z: 0 }])).toEqual(['may be one tree with #9']);
    expect(stemDoubts(seeds, seed(5, 0, 0, { r: 0.7 }))).toEqual(['very thick (⌀ 140 cm)']);
  });
  it('walks the doubtful stems first, each group in rows from north to south, there and back', () => {
    const seeds = [
      seed(1, 5, -1), seed(2, 0, -1), seed(3, 0, -11), seed(4, 5, -11),
      seed(5, 2, -1, { source: 'flow', circles: 0 }),
    ];
    expect(reviewOrder(seeds)).toEqual([5, 2, 1, 4, 3]);
    expect(reviewOrder(seeds, [], false)).toEqual([2, 5, 1, 4, 3]);
  });
  it('a mark holds only for the stem it was made on', () => {
    const seeds = [seed(1, 0, 0), seed(2, 3, 0)];
    const marks = {
      1: { status: 'ok' as const, x: 0.05, y: 0 },
      2: { status: 'edited' as const, x: 3.5, y: 0 }, // a fresh run put another stem under id 2
      7: { status: 'ok' as const, x: 0, y: 0 },       // gone
    };
    expect(validMarks(marks, seeds)).toEqual({ 1: { status: 'ok', x: 0.05, y: 0 } });
  });
  it('in the review the overlay draws the circle itself and a cross on its centre', () => {
    const g = seedGeometry([seed(1, 0, 0, { r: 0.2 })], null, true).segments;
    expect(g.length).toBe(1 + 48 + 2);
    const ring = g.slice(1, 49);
    for (const sg of ring) {
      expect(Math.hypot(sg.a[0], sg.a[1])).toBeCloseTo(0.2, 9);
      expect(sg.a[2]).toBeCloseTo(100 + BH, 9);
    }
    // no diameter: only the cross
    expect(seedGeometry([seed(1, 0, 0, { r: 0 })], null, true).segments.length).toBe(1 + 2);
    // a stem measured by hand is the user's colour
    expect(seedGeometry([seed(1, 0, 0, { source: 'manual' })], null, true).segments[0].color).toBe('#38bdf8');
  });
});

describe('clicking on the slab', () => {
  it('a ray meets the plane where it crosses it', () => {
    const plane = { anchor: [0, 0, 1.3] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };
    const hit = rayPlane([1, 2, 10], [1, 2, -10], plane)!;
    expect(hit[0]).toBe(1);
    expect(hit[1]).toBe(2);
    expect(hit[2]).toBeCloseTo(1.3, 12);
    expect(rayPlane([0, 0, 5], [1, 0, 5], plane)).toBeNull();
    const p = planePicker(plane, () => {});
    expect(p.plane).toBe(plane);
  });
  it('from straight above, the click lands on the slab under the cursor, north up', () => {
    const offset: [number, number, number] = [2676000, 1246000, 0];
    const target: [number, number, number] = [2676003, 1246004, 101.3];
    const pose = sectionPose(target, [0, 0, 1], offset, 3, 3, 1);
    const c = new ViewCamera(45, 1, 0.1, 1000);
    c.position.set(...pose.position);
    c.lookAt(...pose.target);
    c.ortho = true;
    syncOrtho(c, c.position.distanceTo(new THREE.Vector3(...pose.target)), 100);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    const plane = { anchor: target, normal: [0, 0, 1] as [number, number, number] };
    const mid = pickOnPlane(c, 50, 50, 100, 100, plane, offset)!;
    expect(mid[0]).toBeCloseTo(target[0], 2);
    expect(mid[1]).toBeCloseTo(target[1], 2);
    expect(mid[2]).toBeCloseTo(target[2], 9);
    // the view is 3 m (and the margin) across: a quarter to the right is ~0.8 m east, a quarter up ~0.8 m north
    const right = pickOnPlane(c, 75, 50, 100, 100, plane, offset)!;
    const up = pickOnPlane(c, 50, 25, 100, 100, plane, offset)!;
    expect(right[0] - target[0]).toBeGreaterThan(0.7);
    expect(right[0] - target[0]).toBeLessThan(0.9);
    expect(Math.abs(right[1] - target[1])).toBeLessThan(0.01);
    expect(up[1] - target[1]).toBeGreaterThan(0.7);
    expect(Math.abs(up[0] - target[0])).toBeLessThan(0.01);
  });
});

describe('the wiring', () => {
  it('the seed editor runs the review; the viewport takes its clicks on the plane; the marks are saved', () => {
    expect(read('./ForestSection.tsx')).toContain('<StemReview />');
    const rv = read('./StemReview.tsx');
    // the review's keys before the editor's (Delete there deletes the selected points)
    expect(rv).toContain("window.addEventListener('keydown', onKey, true)");
    expect(rv).toContain('setWorldPicker(() => planePicker(plane, onClick))');
    expect(rv).toContain("setFilters({ planeSlab: { anchor: [cx, cy, cz], normal: [0, 0, 1], halfHeight: rv.slab } })");
    expect(read('../../three/OctreeView.tsx')).toContain('pickOnPlane(camera, e.clientX - r.left, e.clientY - r.top, r.width, r.height, plane, sceneOffset)');
    expect(readFileSync(new URL('../../persistence/desktopBridge.ts', import.meta.url), 'utf8')).toContain("('octree_forest_save_review', { octreeDir, review })");
    expect(read('../../../src-tauri/src/lib.rs')).toContain('octree::octree_forest_save_review,');
    expect(read('../../../src-tauri/src/commands/octree/forest.rs')).toContain('if s.source == "manual" { continue; }');
  });
});
