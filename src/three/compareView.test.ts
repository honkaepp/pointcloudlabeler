import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import { treeIdColor, treeIdColor01 } from './palette';
import { flipRowsRgba } from './pngEncode';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const compare = stripComments(read('src/three/CompareView.tsx'));
const view = stripComments(read('src/three/OctreeView.tsx'));
const shell = stripComments(read('src/components/shell/EditorShell.tsx'));
const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));

/** The Compare view: the source and the target of a skeleton transfer
 *  side by side under one camera — the workflow's "inspect" stage as a
 *  view of its own, and its figures as reproducible exports. These are
 *  the tests a node process can run, and the pins that hold the rest in
 *  place. */
describe('the Compare view', () => {
  it('colours both panes with the viewport’s own palette, so an id is one colour on both sides', () => {
    // Palette determinism: the same tree id yields the same RGB in both
    // viewports and across datasets. The palette is a pure function of
    // the id, and the panes reach it through the editor's own colorNode —
    // CompareView carries no palette of its own to drift from it.
    for (const id of [1, 17, 228, 4096, 70_001]) {
      const a = treeIdColor(id);
      const b = treeIdColor(id);
      expect(b).toEqual(a);
      const [r, g, bb] = treeIdColor01(id);
      expect([Math.round(r * 255), Math.round(g * 255), Math.round(bb * 255)]).toEqual(a);
    }
    expect(treeIdColor(17)).not.toEqual(treeIdColor(18));
    expect(compare, 'CompareView has a palette of its own').not.toMatch(/from '\.\/palette'/);
    expect(compare, 'the panes do not render through the editor’s streamer')
      .toMatch(/<NodeStreamer[\s\S]{0,600}?display=\{display\}/);
    expect(compare, 'the colour mode is not the one the panel chose, or the budget is not split')
      .toMatch(/\.\.\.display, colorMode, pointBudget: splitBudget\(display\.pointBudget\)/);
    expect(view, 'the editor’s tree-id colouring is not the palette function')
      .toMatch(/if \(mode === 'tree_id'\) \{[\s\S]{0,400}?treeIdColor\(id\)/);
    expect(view, 'id 0 is not the neutral unlabelled colour')
      .toMatch(/if \(id <= 0\) \{ colors\[i \* 3\] = ur0;/);
  });

  it('drives both panes from one camera in world coordinates', () => {
    // The pose is published by the pane the user moves and applied by
    // the other, each converting with its own offset (comparePose.ts
    // holds the maths and its round-trip test).
    expect(compare, 'no pane publishes the pose').toMatch(/if \(sh\.driver === side\) \{[\s\S]{0,300}?poseFromScene\(/);
    expect(compare, 'no pane follows the pose').toMatch(/else if \(applied\.current !== sh\.version\) \{[\s\S]{0,200}?poseToScene\(sh\.pose, offset, zBase, rigid\)/);
    expect(compare, 'the driver publishes without its height base').toMatch(/\}, offset, zBase, rigid\);\s*if \(!posesEqual\(pose, sh\.pose, 1e-9\)\)/);
    expect(compare, 'input does not make a pane the driver').toMatch(/onPointerDownCapture=\{drive\} onWheelCapture=\{drive\}/);
    expect(compare, 'a loaded view does not move both panes').toMatch(/setPose: \(pose\) => \{[\s\S]{0,200}?sh\.driver = null;/);
  });

  it('puts a cloud in elevation beside a normalised one, and can hide the unlabelled and colour by any column', () => {
    // TLS normalised beside HeliALS in elevation stood 540 m apart under
    // one camera: one pane's cloud at the bottom of the screen, the
    // other's at the top. Each pane now has a height base — the
    // elevation side its ground level under the shared footprint, asked
    // of the Rust side — and every pose conversion goes through it. The
    // unlabelled go through the editor's own hideUnassigned filter, and
    // the colour mode is any of the viewport's, extras included.
    expect(compare, 'no ground level is asked for').toMatch(/desktop\?\.octreeGroundReference/);
    expect(compare, 'the footprint the two share is not what the ground is asked under').toMatch(/footprintIntersection\(boxOf\(source\), boxOf\(target\)\)/);
    expect(compare, 'the bases do not come from heightBasesFor').toMatch(/heightBasesFor\(\s*alignHeights,/);
    expect(compare, 'the start view is not framed in the shared frame').toMatch(/shiftZ\(opened\.target\.meta\.boundingBox\.min as Vec3, -bases\.target\)/);
    expect(compare, 'the pane camera does not start through its base').toMatch(/poseToScene\(initial, offset, zBaseEff, rigid\)/);
    expect(compare, 'the unlabelled are not the editor’s own filter').toMatch(/\{ \.\.\.DEFAULT_FILTERS, hideUnassigned: hideUnlabeled \}/);
    expect(compare, 'the skeleton keeps its own colour mode').toMatch(/\{ \.\.\.skeleton, colorMode: skeletonColor \}/);
    expect(compare, 'the columns both clouds carry are not offered').toMatch(/columns: \(\) => columns,/);
    expect(compare, 'the pane does not say where its height 0 is').toMatch(/height 0 at z \{zBaseEff\.toFixed\(1\)\} m/);
    const rs = read('src-tauri/src/commands/octree.rs');
    expect(rs, 'there is no ground reference command').toMatch(/pub async fn octree_ground_reference\(/);
    expect(rs, 'the reference is the floor, not the median').toMatch(/fn median_ground_z\(g: &DtmGrid, within: Option<\[f64; 4\]>\)/);
    expect(read('src-tauri/src/lib.rs'), 'the command is not registered').toMatch(/octree::octree_ground_reference,/);
    expect(panel, 'the panel has no hide-unlabelled toggle').toMatch(/hide unlabelled \(tree id 0\)/);
    expect(panel, 'the panel has no height alignment toggle').toMatch(/setCompareFlag\(\{ alignHeights: e\.target\.checked \}\)/);
    expect(panel, 'the panel offers only two colour modes').toMatch(/\['classification', 'classification',[\s\S]{0,400}?\['height', 'height',[\s\S]{0,400}?\['intensity', 'intensity',/);
    expect(panel, 'the extra columns are not offered').toMatch(/compareColumns\.map\(\(c\) => <option key=\{c\} value=\{`extra:\$\{c\}`\}>/);
    expect(panel, 'alignment is not the default on a height mismatch').toMatch(/alignHeights: frameSuggestion\.mismatch,/);
  });

  it('exports at the figure’s size and the full budget, on white, with the live camera', () => {
    // Export completeness: the render is planned for the export's pixel
    // size at the FULL budget, not the pane's half and not the screen's
    // LOD — the streamer's PlanOverride. Export equality: both panes get
    // the same size, and the sidecar carries the camera at export time.
    expect(view, 'the planner ignores the override’s viewport')
      .toMatch(/planOverride \? \{ width: planOverride\.width, height: planOverride\.height \} : size,/);
    expect(view, 'the planner ignores the override’s budget')
      .toMatch(/planOverride \? planOverride\.pointBudget : displayRef\.current\.pointBudget,/);
    expect(view, 'the point size does not follow the override')
      .toMatch(/if \(planOverride\) \{\s*sharedUniformsRef\.current\.uSize\.value = planOverride\.pointSize;/);
    expect(compare, 'the export does not plan at the full budget').toMatch(/const budget = exportBudget\(fullBudget\);/);
    expect(compare, 'the panes render at different sizes')
      .toMatch(/await src\(size\.width, size\.height, budget\);\s*const t = await tgt\(size\.width, size\.height, budget\);/);
    expect(compare, 'the export does not wait for the node set').toMatch(/const settled = await settle\(statsRef\);/);
    expect(compare, 'the export is not on white').toMatch(/gl\.setClearColor\('#ffffff', 1\);/);
    expect(compare, 'the pixels are not read back').toMatch(/gl\.readRenderTargetPixels\(rt, 0, 0, width, height, rgba\);/);
    expect(compare, 'the override is not lifted after the render').toMatch(/finally \{\s*planOverrideRef\.current = null;/);
    expect(compare, 'the sidecar camera is not the live one').toMatch(/camera: sharedRef\.current\.pose,/);
    expect(panel, 'the panel does not write the camera the view rendered with').toMatch(/camera: res\.camera,/);
    expect(panel, 'the sidecar does not name the app version').toMatch(/appVersion: __APP_VERSION__,/);
    expect(panel, 'the PNGs are not written as bytes').toMatch(/writeFileBytes\(names\.source, res\.source\.png\);\s*await desktop\.writeFileBytes\(names\.target, res\.target\.png\);/);
  });

  it('flips WebGL’s rows into image order and forces opaque alpha', () => {
    // 2 × 2: bottom row (WebGL's first) is red, top row is blue.
    const rgba = new Uint8Array([
      255, 0, 0, 10, 255, 0, 0, 10,   // row 0 in WebGL = bottom of the image
      0, 0, 255, 20, 0, 0, 255, 20,   // row 1 in WebGL = top of the image
    ]);
    const img = flipRowsRgba(rgba, 2, 2);
    expect(Array.from(img.subarray(0, 8))).toEqual([0, 0, 255, 255, 0, 0, 255, 255]);
    expect(Array.from(img.subarray(8, 16))).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
    expect(img.buffer).toBeInstanceOf(ArrayBuffer);
  });

  it('is read-only, replaces the viewport while open, and closes with the dataset', () => {
    expect(compare, 'the compare writes to a dataset').not.toMatch(/savePatches|flush\(|octree_write|applyToSelection/);
    expect(shell, 'the shell does not show the compare in place of the viewport')
      .toMatch(/\{octree && compare \? \(\s*<CompareView/);
    expect(shell, 'a change of dataset leaves a stale pair open').toMatch(/useEffect\(\(\) => \{ setCompare\(null\); \}, \[octree\?\.dir\]\);/);
    expect(shell, 'the legend draws over the compare').toMatch(/\{octree && !compare && <ColorLegend \/>\}/);
    expect(panel, 'the panel has no step 4').toMatch(/title="4\. Compare"/);
    expect(panel, 'the compare opens without saving the open cloud').toMatch(/await api\?\.save\(\);[\s\S]{0,300}?setCompare\(\{\s*sourceDir: baselineDir, targetDir, colorMode: 'tree_id', showSkeleton: false, skeletonColor: skelColor,/);
    expect(panel, 'saved views are not beside the target').toMatch(/`\$\{compare\.targetDir\}\/\$\{COMPARE_VIEWS_FILE\}`/);
  });

  it('writes bytes through a command that decodes the path it was given', () => {
    const rs = read('src-tauri/src/commands/file.rs');
    const lib = read('src-tauri/src/lib.rs');
    const bridge = stripComments(read('src/persistence/desktopBridge.ts'));
    expect(rs, 'there is no binary write').toMatch(/pub fn file_write_bytes\(/);
    expect(rs, 'the path is not decoded').toMatch(/let path = percent_decode\(raw\)\?;/);
    expect(rs, 'the write skips authorisation').toMatch(/let resolved = state\.authorise_path\(&path\)\?;\s*fs::write\(&resolved, bytes\)/);
    expect(lib, 'the command is not registered').toMatch(/file::file_write_bytes,/);
    expect(bridge, 'the bridge sends the path raw in a header')
      .toMatch(/'file_write_bytes', bytes, \{ headers: \{ 'x-path': encodeURIComponent\(path\) \} \}/);
  });
});
