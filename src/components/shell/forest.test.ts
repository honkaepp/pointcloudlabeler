// The forest pass in the editor: its summary, and correcting the
// stems by hand (forestStore's edits).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';
import { forestSummary, forestTimings, DEFAULT_FOREST_PARAMS, type ForestResult, type ForestSeed } from './forest';
import { addSeed, deleteSeed, forestNotes, mergeSeeds, mergeTrees, seedGeometry, seedNear, splitSeed } from './forestStore';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const seed = (id: number, x: number, y: number, o: Partial<ForestSeed> = {}): ForestSeed => ({
  id, tree: id, x, y, z: 100, r: 0.15, lean: [0, 0], top: 2.2, circles: 4, source: 'circle', ...o,
});

describe('the run', () => {
  it('says what it found and how long each stage took', () => {
    const r: ForestResult = {
      treeCount: 120, assignedPoints: 1, stemPoints: 30, branchPoints: 30, leafPoints: 40, seeds: 130, seedsWithoutCircle: 12,
      merged: 3, suggestions: 5, edgeTrees: 2, understoryTrees: 4, workingPoints: 1, reused: true, usedReflectance: true,
      seconds: 4.25, timings: [['reused', 0], ['trees', 3.1], ['stems', 0.4]],
    };
    expect(forestSummary(r)).toBe('120 trees · 118 stems fitted · 12 from the flow · 60% wood · 3 merged · 5 to check · 4.3 s (graph reused)');
    expect(forestTimings(r)).toBe('trees 3.1 s, stems 0.4 s');
    expect(DEFAULT_FOREST_PARAMS.voxel).toBe(0.04);
  });
});

describe('correcting the stems', () => {
  const seeds = [seed(1, 0, 0), seed(2, 3, 0), seed(3, 3.2, 0.1, { tree: 2 })];
  it('a click finds the stem it is on, allowing for lean and radius', () => {
    expect(seedNear(seeds, 0.2, 0, 101)?.id).toBe(1);
    expect(seedNear(seeds, 1.5, 0, 101)).toBeNull();
    const leaning = [seed(9, 0, 0, { lean: [0.2, 0] })];
    expect(seedNear(leaning, 1.0, 0, 105)?.id).toBe(9);
  });
  it('a stem added where clicked stands on the ground of its neighbours', () => {
    const out = addSeed(seeds, 6, 1, 102.5);
    const s = out[out.length - 1];
    expect(s).toMatchObject({ id: 4, tree: 3, x: 6, y: 1, z: 100, source: 'user', circles: 0, r: 0 });
    expect(s.top).toBeCloseTo(2.8, 9);
  });
  it('merge, split and delete work on trees as well as stems', () => {
    const m = mergeSeeds(seeds, 1, 2);
    expect(m.map((s) => s.tree)).toEqual([2, 2, 2]);
    expect(mergeTrees(seeds, 1, 2).map((s) => s.tree)).toEqual([1, 1, 1]);
    expect(splitSeed(seeds, 3).find((s) => s.id === 3)?.tree).toBe(3);
    expect(deleteSeed(seeds, 2).map((s) => s.id)).toEqual([1, 3]);
  });
  it('the overlay draws a line and a ring per stem, the picked tree in pink', () => {
    const g = seedGeometry(seeds, 2);
    expect(g.segments.length).toBe(3 * 17);
    expect(g.segments[17].color).toBe('#ff47bc');
    expect(g.segments[34].color).toBe('#f9a8d4');
    expect(g.segments[0].color).toBe('#4ade80');
  });
});

describe('the wiring', () => {
  it('the Segment panel leads with the forest pass; the viewer draws the stems', () => {
    const panel = read('./SegmentPanel.tsx');
    expect(panel.indexOf('<ForestSection canRun={canRun} />')).toBeLessThan(panel.indexOf('<CrownSection canRun={canRun} />'));
    expect(read('../../three/OctreeView.tsx')).toContain('<ForestOverlay offset={octree.meta.offset} terrain={heights.flattenWith} />');
    expect(readFileSync(new URL('../../persistence/desktopBridge.ts', import.meta.url), 'utf8')).toContain("('octree_segment_forest', { octreeDir, params })");
    const rs = read('../../../src-tauri/src/lib.rs');
    expect(rs).toContain('octree::octree_segment_forest,');
    expect(rs).toContain('octree::octree_forest_save_seeds,');
  });
});

describe('the forest pass in Tree review', () => {
  it("a tree's flags and the trees it may be one with", () => {
    const st = {
      trees: [{ tree: 4, x: 0, y: 0, z: 0, height: 1.6, r: 0, voxels: 10, flags: ['edge', 'understory', 'noStemFit'] }],
      suggestions: [{ a: 4, b: 9, votes: 2, x: 0, y: 0, z: 0 }],
    };
    const n = forestNotes(st, 4).map((x) => x.label);
    expect(n).toEqual(['stands at the edge of the data', 'understory (1.6 m)', 'no stem circle fitted', 'may be one tree with #9']);
    expect(forestNotes(st, 9).map((x) => x.label)).toEqual(['may be one tree with #4']);
    expect(forestNotes(st, 1)).toEqual([]);
  });
});

describe('TreeQSM is shared: the skeleton transfer keeps its points', () => {
  it('only the QSM fit leaves leaves out; building skeletons does not', () => {
    const rs = readFileSync(new URL('../../../src-tauri/src/commands/octree.rs', import.meta.url), 'utf8');
    const qsm = rs.slice(rs.indexOf('pub fn run_tree_qsm('), rs.indexOf('// Branch fitting (QSM v1'));
    expect(qsm).toContain('if sem == SEM_LEAF { bin_e.leaves += 1; continue; }');
    const skel = rs.slice(rs.indexOf('pub fn run_build_skeletons('), rs.indexOf('\npub fn ', rs.indexOf('pub fn run_build_skeletons(') + 10));
    expect(skel.length).toBeGreaterThan(1000);
    expect(skel).not.toContain('SEM_LEAF');
    expect(read('../../../src-tauri/src/commands/treeqsm.rs')).not.toContain('SEM_LEAF');
  });
});
