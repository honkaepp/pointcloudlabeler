import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
const rs = read('src-tauri/src/commands/octree.rs');
const transfer = rs.slice(rs.indexOf('fn run_skeleton_transfer('));

/** A TLS plot's skeletons over its HeliALS epoch: the two clouds did not
 *  sit on each other, and the transfer labelled from skeletons beside
 *  the trees. The search that labels is bounded ON PURPOSE — an
 *  unbounded one labelled the understorey and the floor. Registering
 *  two clouds is its own job, in a panel of its own — RegistrationPanel,
 *  see registration.test.ts: the measurement (src-tauri skelalign.rs),
 *  the lossless georeference shift (octree_shift_georeference) and the
 *  plumbing that takes skeletons and the Compare through a transform
 *  are driven from there, and the TST panel carries none of it. */
describe('the transfer searches as it did, and takes the skeletons through the alignment', () => {
  it('looks for the nearest skeleton point in the 3 × 3 × 3 cell ring, never farther', () => {
    expect(transfer).toMatch(/let hash = SpatialHash::build\(&match_xyz, cell\);/);
    expect(transfer).toMatch(/let s = match_xyz\[j as usize\];/);
    expect(transfer, 'an unbounded nearest search is back').not.toMatch(/KdTree3/);
    expect(transfer, 'the ring is not the whole reach').toMatch(/for dz in -1\.\.=1 \{\s*for dy in -1\.\.=1 \{\s*for dx in -1\.\.=1 \{/);
    // Every point of a node on its own thread, the node written once,
    // a stop between nodes: the speed-up stays, the answers do not move.
    expect(transfer).toMatch(/block\.par_chunks_mut\(t_point_bytes\)\.enumerate\(\)\.map\(/);
    expect(transfer).toMatch(/if node\.dirty \{[\s\S]{0,300}?file\.write_all\(&block\)/);
    expect(transfer).toMatch(/if crate::commands::cancel::stopped\(&cancel\) \{ break; \}/);
  });

  it('moves the matched coordinates — and the outline — by the alignment it is given, and says so', () => {
    expect(transfer).toMatch(/if let Some\(a\) = &alignment \{\s*let r = a\.rigid\(\);/);
    expect(transfer).toMatch(/SkeletonHull::of\(&match_xyz\)/);
    expect(transfer).toMatch(/alignment_applied: alignment\.is_some\(\),/);
    expect(rs).toMatch(/alignment: Option<crate::commands::skelalign::AlignmentParam>,/);
    expect(rs, 'the stem histogram is back').not.toMatch(/StemHistogram/);
  });

  it('the alignment command reads both clouds, votes, refines, and stores the transform beside the target', () => {
    expect(rs).toMatch(/pub async fn octree_skeleton_align\(/);
    expect(rs).toMatch(/const ALIGNMENT_FILE: &str = "skeleton_alignment\.json";/);
    const run = rs.slice(rs.indexOf('fn run_skeleton_align('), rs.indexOf('fn chrono_like_now('));
    // The skeleton side needs no DTM: a tree's base is its own ground.
    expect(run).toMatch(/let hag = p\[2\] as f64 - e\.base;/);
    expect(run).toMatch(/masks\[cy as usize \* v_cols \+ cx as usize\]\.fetch_or\(1u16 << layer, Ordering::Relaxed\);/);
    expect(run).toMatch(/let tops = canopy_tops\(&chm, 4\.0, 3\);/);
    expect(run).toMatch(/grid\.add_normalised\(&top_grid\);/);
    expect(run).toMatch(/let refined = refine\(&stem_anchors, &vert, Some\(\(&top_anchors, &tops\)\), coarse, rotate\);/);
    expect(run).toMatch(/write_file_atomic\(&t_dir\.join\(ALIGNMENT_FILE\), &json, ALIGNMENT_FILE\)/);
    expect(read('src-tauri/src/lib.rs')).toMatch(/octree::octree_skeleton_align,\s*octree::octree_skeleton_alignment_read,\s*octree::octree_skeleton_alignment_clear,/);
    expect(read('src-tauri/src/commands/mod.rs')).toMatch(/pub mod skelalign;/);
  });

  it('the alignment module is tested on a synthetic forest through clutter', () => {
    const m = read('src-tauri/src/commands/skelalign.rs');
    expect(m).toMatch(/fn the_votes_find_a_shift_of_tens_of_metres_through_clutter\(\)/);
    expect(m).toMatch(/fn the_fine_fit_recovers_shift_and_rotation_to_centimetres\(\)/);
    expect(m, 'the fit is not trimmed of outliers').toMatch(/let cut = \(2\.5 \* median\)\.max\(0\.15\);/);
  });
});

describe('the plumbing that takes skeletons and the Compare through a transform is the registration panel\u2019s, not the transfer\u2019s', () => {
  it('the TST panel carries none of it', () => {
    const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
    expect(panel).not.toMatch(/octreeSkeletonAlign|octreeShiftGeoreference|alignmentToWorld|Georeference the target|alignStems/);
    expect(panel, 'the overlay is still handed an alignment').not.toMatch(/alignment:/);
  });

  it('the overlay rotates about the centre and shifts before the origin goes on', () => {
    const view = stripComments(read('src/three/OctreeView.tsx'));
    expect(view).toMatch(/rx = al\.cx \+ cosT \* px - sinT \* py \+ al\.dx;\s*ry = al\.cy \+ sinT \* px \+ cosT \* py \+ al\.dy;/);
    expect(view).toMatch(/const wx = ox \+ rx;\s*const wy = oy \+ ry;/);
  });

  it('the Compare takes the target pane through the world transform, both ways, and frames the target box back through it', () => {
    const compare = stripComments(read('src/three/CompareView.tsx'));
    expect(compare).toMatch(/poseToScene\(initial, offset, zBaseEff, rigid\)/);
    expect(compare).toMatch(/\}, offset, zBase, rigid\);/);
    expect(compare).toMatch(/poseToScene\(sh\.pose, offset, zBase, rigid\)/);
    expect(compare).toMatch(/boxThrough\(\s*\{ min: shiftZ\(opened\.target[\s\S]{0,200}?alignment \? invertRigid\(alignment\) : null,\s*\)/);
    expect(compare).toMatch(/rigid=\{alignment\} cloudGround=\{opened\.ground\.target\}/);
    expect(stripComments(read('src/components/shell/EditorShell.tsx'))).toMatch(/alignment=\{compare\.alignment \?\? null\}/);
  });

  it('the shift moves the offset, the bounds, the tiles and the alignment — never a point — and is registered', () => {
    expect(rs).toMatch(/pub async fn octree_shift_georeference\(/);
    const core = rs.slice(rs.indexOf('fn shift_georeference_core('), rs.indexOf('mod georeference_shift_tests'));
    expect(core).toMatch(/for k in \["bboxMin", "bboxMax"\]/);
    expect(core).toMatch(/entry\("georeferenceShifts"\)/);
    expect(core, 'metadata.json is not replaced whole').toMatch(/write_file_atomic\(&meta_path, &bytes, "metadata\.json"\)/);
    expect(core, 'the dataset\u2019s own skeletons stay in the old frame').toMatch(/f\.seek\(SeekFrom::Start\(24\)\)/);
    expect(core).toMatch(/a\.target_shifted\[0\] \+= dx; a\.target_shifted\[1\] \+= dy;/);
    expect(core, 'octree.bin is touched').not.toMatch(/octree\.bin/);
    expect(rs, 'the terrain cache does not notice a moved frame').toMatch(/let \(meta_len, meta_mtime\) = file_stamp\(&dir\.join\("metadata\.json"\)\);/);
    expect(read('src-tauri/src/lib.rs')).toMatch(/octree::octree_shift_georeference,/);
    expect(stripComments(read('src/persistence/desktopBridge.ts'))).toMatch(/'octree_shift_georeference', \{ octreeDir, dx, dy, note \}/);
  });
});
