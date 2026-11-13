// What of the primary's filters a cloud added to the scene draws with
// (OverlayCloud's overlayFilters): all of them, only the X / Y / Z
// extent, or none — and how the extent clips its points (maskPoints).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import { maskPoints, overlayFilters, type OverlayPoints } from './OverlayCloud';
import { DEFAULT_FILTERS, type FilterConfig } from '../components/shell/OctreeShellContext';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const primary: FilterConfig = {
  ...DEFAULT_FILTERS,
  zRange: [106, 108],
  xRange: [500_010, 500_020],
  isolateTreeId: 210,
  hiddenClasses: [2],
};

/** Points at world (east, north, up), in a cloud whose offset is `off`:
 *  scene x = east − off, y = up − off, z = −(north − off). `ground` is
 *  what heights above ground took off each point's height. */
function cloud(off: [number, number, number], world: Array<[number, number, number]>, ground: number[] | null = null): OverlayPoints {
  const positions = new Float32Array(world.length * 3);
  world.forEach(([e, n, u], i) => positions.set([e - off[0], u - off[2] - (ground ? ground[i] : 0), -(n - off[1])], i * 3));
  return {
    positions,
    treeIds: new Int32Array(world.length).fill(5),
    classification: new Uint8Array(world.length).fill(2),
    count: world.length,
    ground: ground ? Float32Array.from(ground) : null,
  };
}
const mask = (p: OverlayPoints, f: FilterConfig | null, off: [number, number, number]) => {
  const out = new Float32Array(p.count);
  maskPoints(out, p, f, off);
  return Array.from(out);
};

describe('filters of a cloud in the scene', () => {
  it('take all of the primary\'s when synced', () => {
    expect(overlayFilters(primary, true, true)).toBe(primary);
    expect(overlayFilters(primary, true, false)).toBe(primary);
  });

  it('take only the extent when synced by extent', () => {
    const f = overlayFilters(primary, false, true);
    expect(f.zRange).toEqual([106, 108]);
    expect(f.xRange).toEqual([500_010, 500_020]);
    expect(f.yRange).toBeNull();
    // The tree, class and id filters mean nothing in another cloud.
    expect(f.isolateTreeId).toBeNull();
    expect(f.hiddenClasses).toEqual([]);
  });

  it('take none when not synced, or when there is no extent', () => {
    expect(overlayFilters(primary, false, false)).toBe(DEFAULT_FILTERS);
    expect(overlayFilters({ ...primary, xRange: null, zRange: null }, false, true)).toBe(DEFAULT_FILTERS);
  });

  it('clip both clouds at the same elevation, whatever their offsets', () => {
    // The same five places in two clouds with different offsets.
    const world: Array<[number, number, number]> = [
      [500_015, 7_000_001, 105], [500_015, 7_000_001, 107], [500_015, 7_000_001, 109],
      [500_005, 7_000_001, 107], [500_019, 6_999_990, 106.5],
    ];
    const a: [number, number, number] = [500_000, 7_000_000, 100];
    const b: [number, number, number] = [499_990, 6_999_950, 92];
    const f = overlayFilters(primary, false, true);
    expect(mask(cloud(a, world), f, a)).toEqual([0, 1, 0, 0, 1]);
    expect(mask(cloud(b, world), f, b)).toEqual([0, 1, 0, 0, 1]);
    // a northing range, which flips with the scene's z
    const ny = { ...DEFAULT_FILTERS, yRange: [6_999_985, 6_999_995] as [number, number] };
    expect(mask(cloud(b, world), ny, b)).toEqual([0, 0, 0, 0, 1]);
    // with the heights shown above ground, the extent still reads the stored elevation
    expect(mask(cloud(b, world, [3, 3, 3, 3, 3]), f, b)).toEqual([0, 1, 0, 0, 1]);
  });

  it('nothing hides anything, and synced filters still hide what they hide', () => {
    const off: [number, number, number] = [0, 0, 0];
    const p = cloud(off, [[1, 1, 1], [2, 2, 2]]);
    expect(mask(p, null, off)).toEqual([1, 1]);
    expect(mask(p, DEFAULT_FILTERS, off)).toEqual([1, 1]);
    // the synced isolate hides tree 5, the synced classes class 2
    expect(mask(p, overlayFilters(primary, true, false), off)).toEqual([0, 0]);
  });

  it('the viewer hands every overlay the filters and how it syncs them', () => {
    const view = read('./OctreeView.tsx');
    expect(view).toMatch(/filters=\{filters\}\s*syncFilters=\{c\.syncFilters\}\s*syncExtent=\{c\.syncExtent\}/);
    const overlay = read('./OverlayCloud.tsx');
    expect(overlay).toContain('() => overlayFilters(primaryFilters, syncFilters, syncExtent),');
    expect(overlay).toContain('maskTile(tile, filtersRef.current, octree.meta.offset);');
  });
});
