import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The streamer's cache-generation guard.
 *
 *  `reloadNodes()` runs after every native command that rewrites
 *  octree.bin — ground classification, CHM segmentation, tree isolation,
 *  leaf-wood, deadwood, skeleton transfer. Its job is to throw the cache
 *  away because the file changed. It used to leave the in-flight reads
 *  alone, so a read issued before the rewrite landed (or overlapping it)
 *  settled afterwards carrying pre-operation bytes and published itself
 *  into the freshly-cleared cache: a node showing the OLD tree ids among
 *  correctly reloaded ones, with nothing on screen to tell them apart.
 *
 *  The fix is a generation counter that a stale load compares itself
 *  against before publishing. Driving that end-to-end would need the
 *  streamer running under WebGL, which this suite has no context for —
 *  so what is pinned here is the structure the fix depends on, in the
 *  same way the export-plumbing suite pins a chain that tsc cannot see.
 *  It is what fails if a THIRD cache reset is added later and forgets to
 *  bump, or if the check before publishing is removed. */
describe('streamer cache generation', () => {
  const src = readFileSync('src/three/OctreeView.tsx', 'utf8');

  it('every path that clears the loaded cache also bumps the generation', () => {
    // Each reset is identified by clearing the loaded map; a reset that
    // does that without bumping leaves in-flight loads able to publish
    // into it.
    const resets = [...src.matchAll(/loadedRef\.current\.clear\(\)/g)];
    expect(resets.length, 'expected the known cache resets').toBeGreaterThanOrEqual(3);

    for (const m of resets) {
      // The bump lives within the same block; look at a generous window
      // after the clear rather than parsing scopes.
      const window = src.slice(m.index!, m.index! + 1400);
      expect(
        window,
        'a cache reset that does not bump loadGenRef lets an in-flight load '
        + 'publish bytes that no longer exist on disk',
      ).toContain('loadGenRef.current++');
    }
  });

  it('every cache reset also drops the in-flight set and the queue', () => {
    // Left behind, a queue entry planned against the old cache is
    // re-issued, and an in-flight read is never reconsidered. Both of the
    // original resets did this; the reloadNodes one did not, which is
    // what made the bug reachable.
    for (const m of [...src.matchAll(/loadedRef\.current\.clear\(\)/g)]) {
      const window = src.slice(m.index!, m.index! + 1400);
      expect(window, 'reset leaves the in-flight set behind').toContain('inFlightRef.current.clear()');
      expect(window, 'reset leaves the load queue behind').toContain('loadQueueRef.current = []');
    }
  });

  it('a load compares its generation before publishing, and disposes if stale', () => {
    const guard = src.slice(src.indexOf('if (gen !== genRef.current)'));
    expect(
      src.indexOf('if (gen !== genRef.current)'),
      'loadNode must compare the generation it started with against the live one',
    ).toBeGreaterThan(-1);
    // Dropping without disposing would leak the GPU buffers it decoded.
    const body = guard.slice(0, 200);
    expect(body, 'a stale load must dispose its geometry').toContain('geom.dispose()');
    expect(body, 'a stale load must dispose its material').toContain('material.dispose()');
    // And it must bail BEFORE inserting into the cache.
    const publishAt = src.indexOf('loaded.set(recIdx, ln);');
    expect(publishAt).toBeGreaterThan(src.indexOf('if (gen !== genRef.current)'));
  });

  it('the generation is threaded from the planner down to the load', () => {
    // A break anywhere in this chain and the check compares a constant
    // against itself, which passes always and guards nothing.
    expect(src, 'planAndStream must take the generation').toMatch(/genRef: \{ current: number \}/);
    expect(src, 'pumpQueue must pass the CURRENT generation into the load')
      .toContain('genRef.current, genRef,');
  });
});
