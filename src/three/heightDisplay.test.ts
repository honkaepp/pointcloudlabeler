import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const view = stripComments(read('src/three/OctreeView.tsx'));
const compare = stripComments(read('src/three/CompareView.tsx'));
const rs = read('src-tauri/src/commands/octree.rs');

/** "Heights above ground" as a DISPLAY. Every point is drawn at its
 *  stored height less the ground under it (plus one reference level,
 *  so the cloud stays where it was), in the shader, per vertex; the
 *  stored coordinates are never touched. What selects and picks must
 *  see the point where it is drawn, the planner must still admit a node
 *  whose points moved, and every overlay must come down with the cloud.
 *  These pins keep those parts together. */
describe('heights above ground in the renderer', () => {
  it('the point shader takes the terrain off the height, after dequantising and before projecting', () => {
    expect(view).toMatch(/vec3 pos = uQOrigin \+ position \* uQSize;[\s\S]{0,400}?if \(uFlatten > 0\.5\) pos\.y -= dtmShift\(pos\.xz\);[\s\S]{0,100}?vec4 viewPos = modelViewMatrix \* vec4\(pos, 1\.0\);/);
    // The same bilinear sampling as terrainGrid.ts: cell centres,
    // clamped, by hand on a NEAREST float texture.
    expect(view).toMatch(/float dtmShift\(vec2 sceneXZ\)[\s\S]{0,200}?- uDtmOrigin\.y\) \/ uDtmCell - 0\.5;/);
    expect(view).toMatch(/g = clamp\(g, vec2\(0\.0\), uDtmSize - 1\.0\);/);
    for (const u of ['uFlatten', 'uDtm', 'uDtmOrigin', 'uDtmCell', 'uDtmSize']) {
      expect(view, `${u} is not shared with every node material`).toMatch(new RegExp(`${u}: shared\\.${u},`));
    }
  });

  it('the streamer feeds the terrain to the uniforms and goes back to the empty texture without one', () => {
    expect(view).toMatch(/su\.uDtmOrigin\.value\.set\(terrain\.grid\.minX - off\[0\], terrain\.grid\.minY - off\[1\]\);/);
    expect(view).toMatch(/su\.relief = terrain\.relief;/);
    expect(view, 'a disposed texture stays bound').toMatch(/su\.uFlatten\.value = 0;\s*su\.uDtm\.value = emptyDtmRef\.current;\s*su\.relief = 0;/);
  });

  it('the planner grows every node’s sphere by the relief, in the plan and in the prefetch', () => {
    expect(view).toMatch(/sphere\.radius = r \+ shared\.relief;/);
    expect(view).toMatch(/sphere\.radius = idx\.radius\[rec\] \+ shared\.relief;/);
  });

  it('every CPU-side projection tests the point where it is drawn, and returns the stored one', () => {
    // Seven loops read a point; each projects its drawn height.
    expect(view.match(/const dy = drawnY\(px, py, pz\);/g)?.length).toBe(7);
    expect(view, 'a projection still uses the stored height').not.toMatch(/\.set\(px, py, pz, 1\)/);
    expect(view.match(/\.set\(px, dy, pz, 1\)/g)?.length).toBe(13);
    // …and what a pick hands back is the stored point.
    expect(view).toMatch(/best = \[px, py, pz\]/);
    expect(view).toMatch(/return t \? sy - t\.shift\(sx \+ offDraw\[0\], offDraw\[1\] - sz\) : sy;/);
  });

  it('the overlays come down with the cloud, and the skeletons land on it', () => {
    expect(view).toMatch(/<NodeStreamer[\s\S]{0,900}?terrain=\{heights\.flattenWith\}/);
    expect(view).toMatch(/<RasterLayers layers=\{rasterLayers\} offset=\{octree\.meta\.offset\} terrain=\{heights\.flattenWith\} \/>/);
    expect(view).toMatch(/<CenterlineOverlay centerlines=\{stemCenterlines\} offset=\{octree\.meta\.offset\} terrain=\{heights\.flattenWith\} \/>/);
    expect(view).toMatch(/<SkeletonPointsOverlay skeleton=\{skeletonOverlay\} offset=\{octree\.meta\.offset\} solid=\{!cloudVisible\} zAdjust=\{heights\.skeletonZAdjust\} \/>/);
    expect(view).toMatch(/<M3C2PointsOverlay overlay=\{m3c2Overlay\} offset=\{octree\.meta\.offset\} terrain=\{heights\.flattenWith\} \/>/);
    expect(view).toMatch(/flatten=\{display\.heightMode === 'above_ground'\}\s*fallbackTerrain=\{heights\.flattenWith\}/);
    expect(view, 'the skeleton overlay ignores the correction').toMatch(/pos\[i \* 3 \+ 1\] = \(zAdjust \? wz \+ zAdjust\(wx, wy\) : wz\) - offset\[2\];/);
    expect(view, 'the viewport says nothing about the heights').toMatch(/\{heights\.note && \(/);
    const raster = stripComments(read('src/three/RasterLayers.tsx'));
    expect(raster).toMatch(/if \(terrain && !Number\.isNaN\(v\)\) sceneY -= terrain\.shift\(wx, wy\);/);
    const overlay = stripComments(read('src/three/OverlayCloud.tsx'));
    expect(overlay).toMatch(/ps\[i \* 3 \+ 1\] -= terrain\.shift\(x \+ off\[0\], off\[1\] - z\);/);
    expect(overlay, 'a secondary cloud with no ground of its own is not flattened by the primary’s').toMatch(/own\.terrain \?\? fallbackTerrain/);
  });

  it('the Compare panes draw heights the same way, and set the height base at the flattened ground', () => {
    expect(compare).toMatch(/const heights = useHeightDisplay\(\{[\s\S]{0,400}?cloudGroundFallback: cloudGround,\s*sourceGroundFallback: sourceGround,/);
    expect(compare).toMatch(/const zBaseEff = zBase !== 0 && heights\.flattenWith \? heights\.flattenWith\.grid\.reference : zBase;/);
    expect(compare).toMatch(/terrain=\{heights\.flattenWith\}/);
    expect(compare).toMatch(/<SkeletonPointsOverlay skeleton=\{skeleton\} offset=\{offset\} zAdjust=\{heights\.skeletonZAdjust\} \/>/);
    expect(compare).toMatch(/zBase=\{bases\.target\} rigid=\{alignment\} cloudGround=\{opened\.ground\.target\} sourceGround=\{opened\.ground\.source\}/);
  });

  it('the skeleton overlay knows the cloud it came from', () => {
    const ctx = stripComments(read('src/components/shell/OctreeShellContext.tsx'));
    expect(ctx).toMatch(/export interface SkeletonOverlay \{[\s\S]{0,900}?sourceDir\?: string;/);
    const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
    expect(panel, 'Load + show does not say where the skeletons came from').toMatch(/colorMode: skelColor, sourceDir: viewedDir,/);
    expect(panel, 'the compare’s skeletons do not say where they came from').toMatch(/colorMode: skelColor, sourceDir: compare\.sourceDir,/);
    expect(panel, 'a recolour loses the source').toMatch(/sourceDir: lastPayloadDirRef\.current \|\| undefined/);
  });

  it('the Rust side serves the terrain from a stamped cache beside the octree, and the ground reference reads the same grid', () => {
    expect(rs).toMatch(/pub async fn octree_dtm_grid\(octree_dir: String, cell: Option<f64>\)/);
    expect(rs).toMatch(/fn cached_terrain_bytes\(dir: &Path, cell: f64\)/);
    expect(rs).toMatch(/dir\.join\("terrain\.bin"\)/);
    expect(rs).toMatch(/dir\.join\("terrain\.json"\)/);
    expect(rs, 'the stamp ignores a reclassification').toMatch(/file_stamp\(&dir\.join\("patches\.bin"\)\)/);
    expect(rs, 'the ground reference builds its own grid').toMatch(/cached_terrain_bytes\(dir, cell\)\.and_then\(\|b\| dtm_grid_from_terrain_bytes\(&b\)\)/);
    expect(read('src-tauri/src/lib.rs')).toMatch(/octree::octree_dtm_grid,/);
    expect(stripComments(read('src/persistence/desktopBridge.ts'))).toMatch(/octreeDtmGrid: async \(octreeDir: string, cell\?: number\): Promise<ArrayBuffer>/);
  });
});
