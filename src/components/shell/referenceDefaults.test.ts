// Every parameter a user can set that belongs to a published method
// has to open at that method's own constant.
//
// A panel whose defaults are somebody's taste rather than the paper's
// produces different numbers from the paper it cites, and says nothing
// about it. Four were wrong when this was written: two panels opened
// TreeQSM's cover sweep at half create_input.m's PatchDiam1, one
// applied a minimum tree size the reference does not have and the
// backend had deliberately removed, and one offered a cover-size
// control on a path that ignores it.
//
// Source scans, for the same reason the rest of this file gives: what
// went wrong is a default and a placement, and a scan is what catches
// those coming back.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';

const read = (p: string) =>
  readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

/** `const [name, setName] = useState(value)` over one file. */
function defaults(src: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of stripComments(src).matchAll(/const \[(\w+), set\w+\] = useState\(([\d.]+)\)/g)) {
    out.set(m[1], Number(m[2]));
  }
  return out;
}

describe('the published methods open at their published constants', () => {
  const tst = defaults(read('src/components/shell/SkeletonTransferPanel.tsx'));
  const stem = defaults(read('src/components/shell/StemCenterlinePanel.tsx'));

  it("opens TreeQSM's cover sweep at create_input.m's own PatchDiam1", () => {
    // create_input.m: inputs.PatchDiam1 = [0.08 0.12]. The eight-model
    // sweep is scaled from the first of those, so the knob has to be
    // 8 cm for the sweep to be create_input's. Both panels had 4.
    expect(tst.get('rCoverCm'), 'skeleton transfer no longer sweeps around 0.08').toBe(8);
    expect(stem.get('rCoverCm'), 'stem centrelines no longer sweep around 0.08').toBe(8);
  });

  it('applies no minimum tree size, because the reference applies none', () => {
    // TST_get_tree_skeletons_v3.m runs TreeQSM on every tree in the
    // treelist and warns when one fails. The backend was lowered from
    // 200 to 30 for exactly this reason, and the centreline panel then
    // passed 200 and put the floor back.
    expect(tst.get('minPts'), 'skeleton transfer imposes a minimum again').toBe(0);
    expect(stem.get('minPts'), 'stem centrelines impose a minimum again').toBe(0);
  });

  it('thins nothing the reference would not, because the reference thins nothing', () => {
    // TST_get_tree_skeletons_v3.m reconstructs every tree at
    // filtering.m's 4 mm cubical downsampling and never thins further:
    // its input is one pre-cut tree per file and it needs no cap. The
    // cap here is a DEVIATION offered for a machine that cannot hold a
    // tree (see thin_to_at_most), and it shipped at 400k — which thinned
    // the twelve largest trees of a measured plot to 16–64 mm while the
    // reference would have kept them at 4 mm. Zero is what matches; the
    // memory ceiling, not thinning, is what keeps a giant tree from
    // taking the application down.
    expect(tst.get('maxPts'), 'skeleton transfer thins the big trees again').toBe(0);
  });

  it('cuts the ground where the reference cuts it and not where it does not', () => {
    // cfg.ground_threshold = 0.20 applies to the TARGET.
    expect(tst.get('groundCm'), 'the target threshold is no longer 0.20 m').toBe(20);
    // TST_get_tree_skeletons_v3.m hands each tree's whole cloud to
    // filtering + treeqsm: no cut on the baseline at all.
    expect(tst.get('baselineGroundCm'), 'the baseline is cut again').toBe(0);
  });

  it('reconstructs each tree once, as the reference does', () => {
    // TST_pc_tree_skeleton.m builds the skeleton from
    // QSM_tree_t<id>_m1.mat and reads `QSM.cylinder` — which in MATLAB
    // resolves only for a 1x1 struct. So the skeleton comes from ONE
    // model, the first, whatever create_input hands treeqsm; and
    // nothing in that path calls select_optimum, so taking the best of
    // several would be a deviation as well as eight times the work.
    expect(tst.get('qsmModels'), 'the skeleton build no longer runs one model per tree')
      .toBe(1);
  });

  it("samples the skeleton at the reference's own step", () => {
    // stepSize = 0.02 in TST_pc_tree_skeleton.m.
    expect(tst.get('spacingMm'), 'the skeleton spacing is no longer 20 mm').toBe(20);
    // cfg.distance_threshold = 0.30.
    expect(tst.get('distanceCm'), 'the NN distance is no longer 0.30 m').toBe(30);
  });

  it('offers no cover-size control on the path that ignores one', () => {
    // The TreeQSM branch method runs create_input.m's fixed eight-model
    // sweep; the voxel argument reaches it and is discarded. A control
    // that invites tuning and changes nothing is worse than none.
    const metrics = stripComments(read('src/modules/MetricsModule.tsx'));
    const branchBlock = metrics.slice(metrics.indexOf("qsmBranchMethod === 'treeqsm'"));
    expect(branchBlock, 'a voxel control is offered for TreeQSM again')
      .not.toMatch(/label=\{qsmBranchMethod === 'treeqsm' \? '[^']*voxel/i);
    expect(branchBlock, 'nothing explains why there is no cover size to set')
      .toMatch(/create_input\.m sweeps eight/);
  });
});

describe('the backend agrees with the panels about those constants', () => {
  const octree = stripComments(read('src-tauri/src/commands/octree.rs'));

  it('defaults every cover sweep to 0.08 and no tree-size minimum', () => {
    const covers = [...octree.matchAll(/r_cover\.unwrap_or\(([0-9.]+)\)/g)].map(m => m[1]);
    expect(covers.length, 'the commands no longer default r_cover').toBeGreaterThanOrEqual(3);
    expect(covers.filter(c => c === '0.08').length,
      `r_cover defaults are ${covers.join(', ')} — all of them must be 0.08`)
      .toBe(covers.length);

    const models = [...octree.matchAll(/qsm_models\.unwrap_or\((\d+)\)/g)].map(m => m[1]);
    expect(models.length, 'the commands no longer default qsm_models')
      .toBeGreaterThanOrEqual(2);
    expect(models.filter(m => m === '1').length,
      `qsm_models defaults are ${models.join(', ')} — the reference builds one model per tree`)
      .toBe(models.length);

    const mins = [...octree.matchAll(/min_tree_points\.unwrap_or\((\d+)\)/g)].map(m => m[1]);
    expect(mins.length, 'the commands no longer default min_tree_points')
      .toBeGreaterThanOrEqual(2);
    expect(mins.filter(m => m === '200').length,
      'a 200-point floor is back, and it silently skips small trees').toBe(0);
  });

  it('cuts the TARGET at the ground where the reference cuts it', () => {
    // cfg.ground_threshold = 0.20, and it applies to the target only —
    // TST_get_tree_skeletons_v3.m hands each baseline tree's whole
    // cloud to filtering + treeqsm with no cut at all. So the two
    // fallbacks are DIFFERENT numbers, and both were 0.0: the transfer
    // silently kept ground points the reference discards, while the
    // comment above it said 0.20.
    const transfer = octree.slice(octree.indexOf('pub async fn octree_skeleton_transfer'),
                                  octree.indexOf('fn run_skeleton_transfer'));
    expect(transfer, "the target's ground cut is no longer cfg.ground_threshold")
      .toMatch(/let ground = ground_threshold\.unwrap_or\(0\.20\)/);
    expect(transfer, 'the baseline is cut again, which the reference does not do')
      .toMatch(/let base_ground = baseline_ground_threshold\.unwrap_or\(0\.0\)/);

    // The build command has no target, so its only ground knob is the
    // baseline's, and that one stays 0.
    const build = octree.slice(octree.indexOf('pub async fn octree_build_skeletons'),
                               octree.indexOf('#[derive(Serialize)]',
                                              octree.indexOf('pub async fn octree_build_skeletons')));
    expect(build, 'the skeleton build cuts the baseline at the ground')
      .toMatch(/let ground = ground_threshold\.unwrap_or\(0\.0\)/);
  });
});
