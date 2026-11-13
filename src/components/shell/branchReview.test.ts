// The branch review: the branches the forest pass nearly gave to
// another tree (forest/near_ties.json), one at a time, largest first; each
// moved to the other tree as an undoable edit, or passed as right.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';
import { firstUnmarked, validTieMarks, type NearTie } from './forestStore';
import { tieFrame, tieQuestion } from './BranchReview';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const tie = (id: number, o: Partial<NearTie> = {}): NearTie => ({
  id, tree: 3, other: 7, ratio: 0.995, nodes: 120, points: 2400, centre: [10, 20, 8], min: [9, 19, 6], max: [11, 21, 10], ...o,
});

describe('the branch review', () => {
  it('keeps its marks only for the run that listed the branches', () => {
    expect(validTieMarks({ run: 5, marks: { 1: 'ok', 2: 'moved' } }, 5)).toEqual({ 1: 'ok', 2: 'moved' });
    expect(validTieMarks({ run: 4, marks: { 1: 'ok' } }, 5)).toEqual({});
    expect(validTieMarks(undefined, 5)).toEqual({});
    expect(validTieMarks({ run: 5, marks: { 1: 'ok', 2: 'maybe' as never } }, 5)).toEqual({ 1: 'ok' });
    // a list with no run (none written yet) holds no marks
    expect(validTieMarks({ run: 0, marks: { 1: 'ok' } }, 0)).toEqual({});
  });

  it('starts at the first branch not looked at, in the file’s order (largest first)', () => {
    const ties = [tie(1), tie(2), tie(3)];
    expect(firstUnmarked(ties, {})).toBe(0);
    expect(firstUnmarked(ties, { 1: 'ok', 2: 'moved' })).toBe(2);
    expect(firstUnmarked(ties, { 1: 'ok', 2: 'ok', 3: 'ok' })).toBe(0);
  });

  it('says when the owner model moved a branch, and how sure it was', () => {
    expect(tieQuestion(tie(1))).toBe('Is it tree 7’s branch, reached by tree 3 from its tip?');
    expect(tieQuestion(tie(1, { p: 0.3 }))).toBe('Is it tree 7’s branch, reached by tree 3 from its tip? Owner model: 30 % tree 7’s.');
    // moved: listed the other way round, tree 3 now has the branch tree 7 had
    expect(tieQuestion(tie(1, { p: 0.82, auto: true }))).toBe('Moved here from tree 7 by the owner model, 82 % sure — is it tree 3’s?');
  });

  it('frames the branch with room round it', () => {
    expect(tieFrame(tie(1), 1.5)).toEqual([[7.5, 17.5, 4.5], [12.5, 22.5, 11.5]]);
  });

  it('moves a branch as one undoable edit of the points the desktop finds for it', () => {
    const view = read('./BranchReview.tsx');
    expect(view).toMatch(/octreeForestBranchPoints\(octree\.dir, t\.id\)/);
    expect(view).toMatch(/api\.applyToRecords\(groups, \{ treeId: t\.other \}\)/);
    expect(view).toMatch(/markTie\(t\.id, 'moved'\)/);
    // the editor's own undo: one PatchStore batch, keyed by tile:record
    const octree = read('../../three/OctreeView.tsx');
    const at = octree.indexOf('applyToRecords:');
    expect(at).toBeGreaterThan(0);
    const body = octree.slice(at, at + 600);
    expect(body).toMatch(/patchNodeKey\(tileOf\[rec\], rec\)/);
    expect(body).toMatch(/storeRef\.current\.applyAction\(keyed, action\)/);
    expect(body).toMatch(/setStoreVersion/);
    // blocked while the dataset is busy, as the other edits are
    expect(read('./EditorShell.tsx')).toMatch(/applyToRecords: blocked/);
  });

  it('reads the list and the points through the desktop bridge', () => {
    const bridge = readFileSync(new URL('../../persistence/desktopBridge.ts', import.meta.url), 'utf8');
    expect(bridge).toMatch(/'near_ties'/);
    expect(bridge).toMatch(/octree_forest_branch_points/);
    const store = read('./forestStore.ts');
    expect(store).toMatch(/octreeForestFile\?\.\(dir, 'near_ties'\)/);
    // the marks go with the stem review's, with the run they belong to
    expect(store).toMatch(/ties: \{ run: state\.tieRun, marks: state\.tieMarks \}/);
  });
});
