// Tree Skeleton Transfer — the two defects a user hit on first use.
//
// Both were reported by opening the application and trying the feature,
// which is how both had to be found: nothing in the type system or the
// test suite could have noticed either, because both are correct code
// applying a rule in the wrong place.
//
// Source scans rather than behavioural tests, deliberately. What went
// wrong is not a computation — it is a filter and a material flag — and
// a scan is what catches those coming back.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';

const read = (p: string) =>
  readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

/** The build step could not use the cloud you were looking at.
 *
 *  One selection drove both "build skeletons from" and "transfer
 *  from", and it was filtered by the transfer rule — a cloud cannot be
 *  transferred onto itself, so the active cloud was dropped from the
 *  list. Correct for transfer, wrong for build: skeletonising the cloud
 *  you just segmented and corrected is the normal workflow, and it was
 *  impossible with no message saying why. */
describe('skeletons can be built from any cloud in the project', () => {
  const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));

  it('does not filter the active cloud out of the baseline list', () => {
    expect(panel, 'the baseline list excludes a cloud again')
      .not.toMatch(/octreeList\.filter\([^)]*!==\s*octree\?\.dir/);
    expect(panel, 'the baseline candidates are no longer every cloud')
      .toMatch(/baselineCandidates\s*=\s*octreeList\s*;/);
  });

  it('enforces the self-transfer rule where it belongs, and says so', () => {
    // On the transfer button, not on the list that also feeds build.
    // Against the CHOSEN TARGET, not the open dataset: the target is
    // the user's to pick, and a cloud still cannot be transferred onto
    // itself whichever one that is.
    expect(panel).toMatch(/transferIsSelf\s*=\s*!!targetDir\s*&&\s*sameDir\(baselineDir, targetDir\)/);
    expect(panel, 'the transfer button ignores the self-transfer case')
      .toMatch(/disabled=\{[^}]*transferIsSelf/);
    // A disabled button with no reason is the same defect wearing a
    // different hat.
    expect(panel, 'nothing tells the user why the transfer is disabled')
      .toMatch(/transferIsSelf\s*&&[^}]*\n?[\s\S]{0,400}?nothing to transfer/);
  });
});

/** "Load & show" did nothing.
 *
 *  The skeleton is a tree's axis, so it is inside the stem, wrapped in
 *  the cloud's own surface points. The overlay had depth testing on, so
 *  those points won every pixel. The only way to see a skeleton was to
 *  export it and re-import it as a separate cloud.
 *
 *  Every other overlay drawn inside the cloud — the centreline lines
 *  and dots, the measurement lines — already had it off. */
describe('the skeleton overlay is visible inside the cloud', () => {
  // Comments stripped: the explanation of this very defect sits
  // inside the material literal and would otherwise be part of what
  // the pattern has to match around.
  const view = stripComments(read('src/three/OctreeView.tsx'));

  it('draws skeleton points without depth testing', () => {
    // The material literal for the skeleton overlay: find the block by
    // its distinctive size, then check the flag inside it.
    const block = view.match(/size:\s*2\.4,[\s\S]{0,600}?\}\);/);
    expect(block, 'the skeleton overlay material has moved or changed shape')
      .toBeTruthy();
    expect(block![0], 'the skeleton overlay depth-tests again and is hidden by the cloud')
      .toMatch(/depthTest:\s*false/);
  });

  it('is consistent with the other overlays drawn through the cloud', () => {
    // The centreline dots and the measurement lines are the precedent.
    // If they ever turn depth testing on, this test should be revisited
    // rather than silently disagreeing with them.
    const through = [...view.matchAll(/depthTest:\s*(true|false)/g)].map(m => m[1]);
    expect(through.length, 'no overlay materials found').toBeGreaterThan(3);
    expect(through.filter(v => v === 'false').length,
      'the overlays that draw through the cloud no longer agree')
      .toBeGreaterThanOrEqual(4);
  });
});

/** The skeletons the transfer labels from have to be the ones the
 *  reference would build, or the comparison against it measures the
 *  skeleton builder rather than the transfer.
 *
 *  Three things had drifted, and none of them is visible from the
 *  transfer's own code — which is why they are scanned here rather
 *  than tested through it: the whole path runs over octree files on
 *  disk, and a behavioural test of it would be a test of the file
 *  format. */
describe('the baseline skeletons are built the way the reference builds them', () => {
  const octree = stripComments(read('src-tauri/src/commands/octree.rs'));

  it("sweeps around create_input's own PatchDiam1 and not half of it", () => {
    // TreeQSM's create_input.m sweeps PatchDiam1 over {0.08, 0.12};
    // the panel's knob scales that whole set, so the default has to be
    // 0.08 for the sweep to be create_input's. It was 0.04.
    const defaults = [...octree.matchAll(/r_cover\.unwrap_or\(([0-9.]+)\)/g)].map(m => m[1]);
    expect(defaults.length, 'the skeleton commands no longer default r_cover')
      .toBeGreaterThanOrEqual(2);
    expect(defaults.filter(d => d === '0.08').length,
      `r_cover defaults are ${defaults.join(', ')} — the skeleton commands must use 0.08`)
      .toBeGreaterThanOrEqual(2);
  });

  it("runs TreeQSM's own filter before each reconstruction", () => {
    // The reference: Pass = filtering(pc.Location, inputs); then
    // treeqsm on what passed. Without it the cover sets are built over
    // whatever the segmentation happened to include.
    // One tree's filter → thin → fit → sample lives in reconstruct_one_tree,
    // which the build's worker calls inside catch_unwind so a tree that
    // panics is one tree skipped and not a run stalled.
    const one = octree.slice(octree.indexOf('fn reconstruct_one_tree'));
    const upToFit = one.slice(0, one.indexOf('fit_treeqsm_full_cylinders'));
    expect(upToFit, 'the skeleton builder no longer filters before fitting')
      .toMatch(/treeqsm::filtering(?:_report)?\(/);
    expect(upToFit, 'the filter no longer uses TreeQSM\'s own parameters')
      .toMatch(/FilterParams::default\(\)/);
  });

  it('cuts the ground at the threshold the caller set, not a hidden one', () => {
    const build = octree.slice(octree.indexOf('fn build_skeleton_from_baseline'));
    const head = build.slice(0, 6000);
    expect(head, 'the baseline ground cut is hard-coded again')
      .not.toMatch(/wz - g as f64\) < 0\.1/);
    expect(head, 'the baseline no longer uses the caller\'s ground threshold')
      .toMatch(/wz - g as f64\) < ground_threshold/);
  });
});

/** Panel logic that a type checker cannot see and a user hits at once.
 *
 *  Four of these were live: a slider that could not reach its own
 *  default, a setting that decides what step 1 does while sitting under
 *  step 3, a save dialog offered for a dataset with nothing to save,
 *  and results that stayed on screen after the dataset they described
 *  had been swapped out. */
describe('the skeleton transfer panel says what it does', () => {
  const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));

  it('gives every slider a range that contains its own default', () => {
    // `const [xCm, setXCm] = useState(8)` and the SliderRow that binds
    // to `value={xCm}` have to agree, or the panel opens showing a
    // number the control cannot produce and the first drag jumps.
    const defaults = new Map<string, number>();
    for (const m of panel.matchAll(/const \[(\w+), set\w+\] = useState\((\d+)\)/g)) {
      defaults.set(m[1], Number(m[2]));
    }
    const rows = [...panel.matchAll(
      /<SliderRow label="([^"]+)"[^>]*?value=\{(\w+)\}\s+min=\{(-?\d+)\}\s+max=\{(\d+)\}/g)];
    expect(rows.length, 'the sliders have moved or changed shape').toBeGreaterThanOrEqual(4);
    for (const [, label, name, min, max] of rows) {
      const d = defaults.get(name);
      expect(d, `no default found for ${name}`).toBeDefined();
      expect(d!, `"${label}" defaults to ${d} but its slider starts at ${min}`)
        .toBeGreaterThanOrEqual(Number(min));
      expect(d!, `"${label}" defaults to ${d} but its slider ends at ${max}`)
        .toBeLessThanOrEqual(Number(max));
    }
  });

  it('keeps the two ground thresholds apart and under the steps they govern', () => {
    // The reference cuts the TARGET at 0.20 m and does not cut the
    // baseline at all, so one slider could not be both. They are two
    // parameters, and each belongs under the step it decides.
    const build = panel.slice(panel.indexOf('const runBuild'), panel.indexOf('const pushToOverlay'));
    expect(build, 'the build no longer passes the baseline threshold')
      .toMatch(/groundThreshold:\s*baselineGroundCm/);
    const transfer = panel.slice(panel.indexOf('const runTransfer'));
    expect(transfer, 'the transfer no longer passes the target threshold')
      .toMatch(/groundThreshold:\s*groundCm\s*\*/);
    expect(transfer, 'the transfer no longer passes the baseline threshold on rebuild')
      .toMatch(/baselineGroundThreshold:\s*baselineGroundCm/);

    const step1 = panel.slice(panel.indexOf('1. Build skeletons'), panel.indexOf('2. View skeletons'));
    const step3 = panel.slice(panel.indexOf('3. Transfer labels'));
    expect(step1, 'the baseline threshold is not under the step that uses it')
      .toMatch(/value=\{baselineGroundCm\}/);
    expect(step3, 'the target threshold is not under the step that uses it')
      .toMatch(/value=\{groundCm\}/);
    expect(step1, 'the target threshold has strayed into step 1')
      .not.toMatch(/value=\{groundCm\}/);
  });

  it('does not offer to export a dataset it has not loaded', () => {
    // The save dialog used to open, take a path, and only then fail.
    const exportBlock = panel.slice(panel.indexOf('Export{'), panel.indexOf('3. Transfer labels'));
    const buttons = [...exportBlock.matchAll(/octreeExportSkeletons \|\| ([^|]+) \|\|/g)]
      .map(m => m[1].trim());
    expect(buttons.length, 'the export buttons have moved').toBeGreaterThanOrEqual(4);
    for (const guard of buttons) {
      expect(guard, `an export button is gated on "${guard}" rather than on what is loaded`)
        .toBe('!viewedSummary');
    }
  });

  it('drops a result when the dataset it described is swapped out', () => {
    expect(panel, 'the build summary survives a change of baseline')
      .toMatch(/setBuildResult\(null\)[^}]*\}, \[baselineDir\]\)/);
    expect(panel, 'the transfer summary survives a change of baseline or target')
      .toMatch(/setTransferResult\(null\)[^}]*\}, \[baselineDir, targetDir\]\)/);
  });

  it('says whether it will reuse a cache or spend as long rebuilding one', () => {
    // Step 3 reuses skeletons.bin when it exists, so changing
    // PatchDiam1 and pressing Transfer does nothing until the cache is
    // cleared — and when there is none, pressing it starts a job as
    // long as step 1 with no warning. Neither was said, and neither
    // could be said without knowing which datasets hold skeletons.
    const step3 = panel.slice(panel.indexOf('3. Transfer labels'));
    expect(step3, 'the transfer no longer knows whether a cache exists')
      .toMatch(/cached\[baselineDir\]/);
    expect(step3, 'the transfer no longer says the cache ignores new settings')
      .toMatch(/do NOT rebuild it/);
    expect(step3, 'the transfer no longer warns that it will build one')
      .toMatch(/no cached skeletons/);
  });

  it('knows which datasets hold skeletons without reading them', () => {
    // The header is twenty-four bytes. Answering "does this cloud have
    // skeletons" by loading the file would mean millions of points per
    // dropdown row. The probe has to be CALLED, not merely declared —
    // a declaration with no call satisfies a looser pattern and tells
    // the user nothing.
    expect(panel, 'the panel no longer calls the cheap probe')
      .toMatch(/await desktop\.octreeSkeletonInfo\(/);
    expect(panel, 'the panel reads whole skeleton files to build the listing')
      .not.toMatch(/for \(const e of octreeList\)[\s\S]{0,200}octreeReadSkeletons/);
    const step1 = panel.slice(panel.indexOf('1. Build skeletons'), panel.indexOf('2. View skeletons'));
    expect(step1, 'the baseline dropdown does not say which clouds have skeletons')
      .toMatch(/cached\[e\.dir\]/);
  });

  it('offers the three scopes the reference itself writes', () => {
    // TST_get_tree_skeletons_v3.m produces both a combined
    // <plot>_skeletonpoints_<year>.txt and a skeletons/ folder of
    // tree_<id>_skeleton.ply. A port that can only write one of those
    // cannot be fed back to it.
    const exp = panel.slice(panel.indexOf('const exportSkeletons'),
                            panel.indexOf('const runTransfer'));
    expect(exp, 'the export no longer takes a single tree').toMatch(/onlyTreeId: onlyTree/);
    expect(exp, 'the export no longer writes one file per tree').toMatch(/perTree \}\)/);
    // The folder picker is `browseForFolder` now — a Rust command, so
    // the backend learns the directory and grants what goes into it
    // (src-tauri/src/fsgrant.rs). The property under test is unchanged:
    // per-tree asks for a DIRECTORY, whole-plot asks for a file.
    expect(exp, 'one file per tree still asks for a file rather than a folder')
      .toMatch(/perTree\s*\n?\s*\?\s*await desktop\.browseForFolder/);
    expect(exp, 'the whole-plot export no longer asks for a filename')
      .toMatch(/desktop\.saveExportDialog\?\.\(/);
    // And the panel offers all three.
    const step2 = panel.slice(panel.indexOf('2. View skeletons'), panel.indexOf('3. Transfer labels'));
    expect(step2, 'there is no way to pick a single tree').toMatch(/Tree \{t\} only/);
    expect(step2, 'there is no way to ask for one file per tree').toMatch(/one file per tree/);
    expect(step2, "the reference's own text layout is not offered")
      .toMatch(/exportSkeletons\('txt'\)/);
  });

  it('exports under the dataset\'s own name', () => {
    // Three clouds used to export skeletons.csv, skeletons (1).csv and
    // skeletons (2).csv, with nothing in any of them saying which
    // cloud it came from.
    const exp = panel.slice(panel.indexOf('const exportSkeletons'),
                            panel.indexOf('const runTransfer'));
    // The name is now the first argument to the Rust save dialog.
    expect(exp, 'the save dialog offers a generic filename again')
      .toMatch(/saveExportDialog\?\.\(\s*`\$\{stem\}_skeletons\$\{suffix\}\$\{ext\}`/);
    // There is deliberately no window.prompt fallback: a path typed
    // into a prompt is not one the backend can tell from a path the
    // renderer invented, so the write would be refused. A fallback
    // that always fails is worse than none.
    expect(exp, 'the prompt fallback is back, and the backend will refuse what it returns')
      .not.toMatch(/window\.prompt/);
    // A single tree's file says which tree it is.
    expect(exp, 'a one-tree export is not named for its tree')
      .toMatch(/const suffix = onlyTree !== undefined \? `_tree\$\{onlyTree\}`/);
    expect(exp, 'the name is no longer taken from the dataset')
      .toMatch(/const stem = \(findDir\(octreeList, viewedDir\)\?\.name/);
  });
});

/** A long run has to be stoppable, and a parameter has to be typable.
 *
 *  Both were reported the same way the earlier defects in this file
 *  were: by opening the application and using it. An hour-long
 *  skeleton build started with the wrong PatchDiam could only be
 *  waited out or killed, and a value that has to match a published
 *  constant could only be dragged at. */
describe('a run can be stopped and a parameter can be typed', () => {
  const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));

  it('offers Cancel while either long operation is running', () => {
    for (const stage of ['build', 'transfer']) {
      const block = panel.slice(panel.indexOf(`busy === '${stage}' && (`), 
                                panel.indexOf(`busy === '${stage}' && (`) + 900);
      expect(block, `no way to stop the ${stage}`).toMatch(/onClick=\{cancelRun\}/);
      // Each button says it is stopping: the run has to finish what it
      // is on before it notices, and a button that looks dead in the
      // meantime gets pressed again.
      expect(block, `the ${stage} button gives no sign it was pressed`)
        .toMatch(/stopping \? 'Stopping/);
    }
    expect(panel, 'Cancel no longer reaches the backend')
      .toMatch(/desktop\.octreeCancel\('tst'\)/);
  });

  it('takes a typed number as well as a dragged one', () => {
    const row = panel.slice(panel.indexOf('function SliderRow'));
    expect(row, 'the value can only be dragged').toMatch(/type="text"/);
    // Committed on blur and on Enter, cancelled on Escape.
    expect(row, 'a typed value is never committed').toMatch(/onBlur=\{\(e\) => commit/);
    expect(row, 'Enter does not commit').toMatch(/e\.key === 'Enter'/);
    expect(row, 'Escape does not abandon the edit').toMatch(/e\.key === 'Escape'/);
    // Clamped to the slider's own range, so typing cannot reach a
    // value the backend would reject.
    expect(row, 'a typed value is not clamped to the range')
      .toMatch(/Math\.min\(max, Math\.max\(min,/);
    // A draft string, not the number reformatted: a field that
    // reformats on every keystroke cannot be cleared and retyped.
    expect(row, 'the field reformats while it is being typed into')
      .toMatch(/value=\{draft \?\? String\(value\)\}/);
  });
});

/** The backend has to consult the flag the button sets, and consult it
 *  where stopping leaves things whole.
 *
 *  Scanned rather than tested through: both loops run over octree files
 *  on disk and a behavioural test of either would be a test of the file
 *  format, which is the same reason the rest of this file gives. */
describe('the long operations consult the cancellation flag', () => {
  const octree = stripComments(read('src-tauri/src/commands/octree.rs'));

  it('stops the skeleton build between trees', () => {
    const build = octree.slice(octree.indexOf('fn build_skeleton_from_baseline'));
    expect(build.slice(0, 30000), 'the build never takes a cancellation token')
      .toMatch(/cancel::token\("tst"\)/);
    expect(build.slice(0, 30000), 'the build never checks whether it was cancelled')
      .toMatch(/cancel::stopped\(&cancel\)/);
  });

  it('hands trees out from a queue, not by splitting an index range', () => {
    // The sort into biggest-first is only worth anything if the order
    // it produces is the order work is TAKEN in. An indexed parallel
    // iterator bisects the range instead — worker 0 at index 0, the
    // next at n/2, the next at n/4 — so the giants end up spread
    // through the run and the last one to start has nothing left to
    // overlap it. A real plot's log showed exactly that: small trees
    // completing first in descending size, giants at the end.
    const build = octree.slice(octree.indexOf('fn build_skeleton_from_baseline'));
    const loop_ = build.slice(0, 30000);
    expect(loop_, 'the trees are back on an indexed parallel iterator')
      .not.toMatch(/trees\.par_iter/);
    expect(loop_, 'there is no shared queue for workers to pull from')
      .toMatch(/take_tree\(\s*&queue, &space, batch_budget, batch_ceiling, 0, &cancel\)/);
    // …and the ceiling it is handed is sized from what THIS machine has
    // free, not a number chosen on another one.
    expect(loop_, 'the byte ceiling is a fixed constant again')
      .toMatch(/stage_ceiling\(\s*mem_available, RECONSTRUCTION_RESERVE, RECONSTRUCTION_FLOOR/);
    // …and the queue is BOUNDED, which is not a detail: LPT order
    // hands every worker a giant at once, and sixteen giants being
    // reconstructed together is what killed the application.
    // The bound is sized from the memory ceiling, not the thread count:
    // a fixed count per worker was smaller than any unthinned tree, and
    // sixteen threads spent a run one tree at a time.
    expect(loop_, 'nothing bounds how much is reconstructed at once')
      .toMatch(/let budget = points_budget_for\(byte_ceiling\);/);
    expect(loop_, 'the budget is a fixed count per worker again')
      .not.toMatch(/POINTS_IN_FLIGHT_PER_WORKER/);
    expect(loop_, 'a finished tree never gives its room back')
      .toMatch(/release_tree\(&queue, &space, n0, 0\)/);
    expect(loop_, 'the phase does not record where its memory started')
      .toMatch(/let base = MemBase::now\(\);/);
    // …and what it records is the process as the OS sees it — the working
    // set, small allocations included — with the tracked subset only as
    // the fallback. The old gauge counted allocations of 64 KiB and up and
    // reported a reconstruction of millions of smaller ones as nothing.
    expect(octree, 'the memory base is not taken from the OS')
      .toMatch(/resident: crate::sysmem::process_resident_bytes\(\)/);

    // The points budget is a proxy — bytes per point were guessed from
    // a crash and the guess was wrong four times. What decides has to
    // be the allocator's own figure, measured for THIS phase rather
    // than for the whole process, which is also holding the plot. The
    // gate is in take_tree, which sits above the builder.
    const take = octree.slice(octree.indexOf('fn take_tree('),
                              octree.indexOf('fn release_tree('));
    expect(take.length, 'take_tree moved and this slice is empty').toBeGreaterThan(400);
    expect(take, 'the reconstruction is not bounded by measured memory')
      .toMatch(/let added = added_since\(&g\.base\);/);
    // …and "measured" means the OS's working set where it can be had —
    // every allocation, not the >= 64 KiB subset that reported millions
    // of small ones as nothing — with the tracked count as the fallback.
    expect(octree, 'the gate no longer reads the process working set')
      .toMatch(/fn added_since\([\s\S]{0,240}?process_resident_bytes\(\)\)[\s\S]{0,160}?r\.saturating_sub\(r0\)/);
    expect(take, 'the measured ceiling is not what admits a tree')
      .toMatch(/else if added >= byte_ceiling \{/);
    // …and it cannot deadlock: nothing running always admits.
    expect(take, 'the ceiling has no escape, so it can stall the pool')
      .toMatch(/if g\.in_flight == 0 \{[\s\S]{0,400}?Some\(g\.trees\.len\(\) - 1\)/);
    // broadcast runs the closure once on EVERY pool thread; an
    // iterator over 0..threads may hand two workers' worth to one.
    expect(loop_, 'the workers are not guaranteed to all start')
      .toMatch(/pool\.broadcast\(/);
  });

  it('reconstructs each tree with the number of models it was asked for', () => {
    // treeqsm.m reconstructs once per PatchDiam combination and keeps
    // the best. create_input.m hands it eight; define_input(P,1,1,1)
    // hands it one. Eight is eight times the work, so a count that is
    // accepted and then ignored is the difference between a run that
    // finishes and one that does not.
    const build = octree.slice(octree.indexOf('pub async fn octree_build_skeletons'));
    expect(build.slice(0, 4000), 'the build command does not take a model count')
      .toMatch(/qsm_models: Option<u8>/);
    expect(build.slice(0, 4000), 'the requested count is dropped for a fixed one')
      .toMatch(/let models = qsm_models\.unwrap_or\(1\)\.clamp\(1, 8\) as usize;/);
    expect(build.slice(0, 4000), 'the count never reaches the builder')
      .toMatch(/build_skeleton_from_baseline\([\s\S]{0,200}?\bmodels\b/);

    const tr = octree.slice(octree.indexOf('pub async fn octree_skeleton_transfer'),
                            octree.indexOf('fn run_skeleton_transfer'));
    expect(tr, 'the transfer command does not take a model count')
      .toMatch(/qsm_models: Option<u8>/);
    expect(tr, 'the transfer drops the requested count')
      .toMatch(/let models = qsm_models\.unwrap_or\(1\)\.clamp\(1, 8\) as usize;/);
    expect(tr, 'the count never reaches the transfer')
      .toMatch(/run_skeleton_transfer\([\s\S]{0,300}?\bmodels,/);

    // …and the per-tree fit is given it rather than a literal.
    const one = octree.slice(octree.indexOf('fn reconstruct_one_tree'));
    expect(one.slice(0, 6000), 'the reconstruction hardcodes its own sweep length')
      .toMatch(/fit_treeqsm_full_cylinders_cancellable\(\s*&pts, r_cover, qsm_models,/);
    // …and the worker runs it caught, with the tree's own stop token,
    // so a panic or the time cap ends one tree and not the run.
    const worker = octree.slice(octree.indexOf('fn build_skeleton_from_baseline'));
    expect(worker, 'a panicking tree stalls the whole run again')
      .toMatch(/catch_unwind\(std::panic::AssertUnwindSafe\(\|\| \{\s*reconstruct_one_tree\(/);
    expect(worker, 'no watchdog stops a tree that runs for a day')
      .toMatch(/t0\.elapsed\(\) > TREE_TIME_CAP/);
    // …on a thread of its own, so the waiter can give up on it without
    // waiting for a pass to end, and a cancel is answered within a second.
    expect(worker, 'the reconstruction runs on the worker itself again')
      .toMatch(/\.name\(format!\("tst-tree-\{tree_id\}"\)\)/);
    expect(worker, 'a cancel waits for the tree to finish')
      .toMatch(/recv_timeout\(std::time::Duration::from_secs\(1\)\)/);
  });

  it('lets the user set the model count, and says what it costs', () => {
    const panel2 = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
    expect(panel2, 'there is no control for the models per tree')
      .toMatch(/label="QSM models per tree"[^/]*value=\{qsmModels\}/);
    expect(panel2, 'the default is no longer the reference\'s single model')
      .toMatch(/const \[qsmModels, setQsmModels\] = useState\(1\)/);
    // Bounded to each caller: the build and the transfer both send it,
    // and one sending it covered for the other when this was one
    // unbounded pattern.
    const build = panel2.slice(panel2.indexOf('const runBuild'),
                               panel2.indexOf('const clearCacheOnViewed'));
    const transfer = panel2.slice(panel2.indexOf('const runTransfer'),
                                  panel2.indexOf('const transferRatio'));
    // A slice that failed to find its boundaries would make both
    // assertions below vacuous, which is exactly how the first version
    // of this test passed while the panel sent nothing.
    expect(build.length, 'the runBuild slice is empty — its boundaries moved')
      .toBeGreaterThan(200);
    expect(transfer.length, 'the runTransfer slice is empty — its boundaries moved')
      .toBeGreaterThan(200);
    expect(build.includes('const runTransfer'), 'the build slice swallowed the transfer')
      .toBe(false);
    // Anchored to the PAYLOAD, not just to the name: `qsmModels`
    // also appears in each callback's dependency array, so a bare
    // name match passes while the call sends nothing — which is how
    // the first version of this assertion passed.
    expect(build, 'the build does not send the chosen count')
      .toMatch(/minTreePoints: minPts,\s*qsmModels,/);
    expect(transfer, 'the transfer does not send the chosen count')
      .toMatch(/minTreePoints: minPts,\s*qsmModels,/);
    // The cost is the reason the control exists; a slider with no
    // explanation is how it came to be fixed at eight unnoticed.
    expect(panel2, 'nothing on screen says what raising the count costs')
      .toMatch(/N\\u00d7 the run time/);
    // …and names the reference file that settles the number, so the
    // next person does not have to re-derive it.
    expect(panel2, 'nothing points at the reference that decides it')
      .toMatch(/TST_pc_tree_skeleton\.m/);
  });

  it('resumes a crashed build only from a cache built the same way', () => {
    // Three crashes cost three whole runs, and every one had finished
    // trees on disk when it died — so a build resumes. The danger in
    // resuming is not the crash: it is picking up a one-model
    // checkpoint into an eight-model run, or one built before the
    // baseline was re-segmented, and ending with a plot whose trees
    // came from two methods with nothing on screen saying so.
    const build = octree.slice(octree.indexOf('fn build_skeleton_from_baseline'));
    const head = build.slice(0, 30000);
    expect(head, 'the resume does not compare the settings it was built with')
      .toMatch(/PartialBuildKey::read\(b_dir\)\.as_ref\(\) == Some\(&key\)/);
    expect(head, 'a FINISHED cache would be resumed from, which rebuilds nothing')
      .toMatch(/if !prev\.complete \{/);
    expect(head, 'the resumed trees are reconstructed all over again')
      .toMatch(/filter\(\|\(id, _\)\| !already\.contains\(id\)\)/);
    // The key has to carry every parameter that changes the model, and
    // a fingerprint of the read — a re-segmented baseline is the case
    // no parameter would catch.
    const key = octree.slice(octree.indexOf('struct PartialBuildKey {'),
                             octree.indexOf('impl PartialBuildKey'));
    for (const f of ['spacing_um', 'r_cover_um', 'ground_um', 'dtm_um',
                     'min_tree_points', 'qsm_models', 'kept_points', 'kept_trees']) {
      expect(key, `the resume key does not carry ${f}, so it would resume across a change in it`)
        .toMatch(new RegExp(`\\b${f}:`));
    }
    // Written with the checkpoint, cleared when the run finishes.
    expect(build.slice(0, 34000), 'the key is not written beside its checkpoint')
      .toMatch(/write_partial_skeletons\(b_dir[^)]*\);\s*key\.write\(b_dir\)/);
    expect(build.slice(0, 44000), 'a finished run leaves its resume key behind')
      .toMatch(/PartialBuildKey::clear\(b_dir\)/);
  });

  it('reads the baseline in batches instead of holding the whole plot', () => {
    // The read used to build the WHOLE plot into one map and keep it
    // for the run: on a measured plot 52.3 million points, 1.2 GiB at
    // 24 bytes each and up to twice that once push had doubled every
    // Vec — held before a single tree was reconstructed, and entirely
    // outside the byte ceiling, which measures what the reconstruction
    // ADDS. Four commits of scheduling work never touched it.
    const build = octree.slice(octree.indexOf('fn build_skeleton_from_baseline'),
                               octree.indexOf('fn save_skeleton_cache'));
    expect(build.length, 'the builder slice is empty').toBeGreaterThan(4000);
    // A counting pass first, keeping nothing.
    expect(build, 'the plot is sized by holding it rather than counting it')
      .toMatch(/\*counts\.entry\(id\)\.or_insert\(0\) \+= 1;/);
    // Then one batch at a time, re-scanning for each.
    expect(build, 'the trees are not read in batches')
      .toMatch(/for \(bi, batch\) in batches\.into_iter\(\)\.enumerate\(\)/);
    // A batch keeps ONLY its own trees. Collecting everything would
    // put the whole plot back in memory with the batching still there
    // to read.
    expect(build, 'a batch keeps every tree, not only its own')
      .toMatch(/if want\.contains_key\(&id\) \{/);
    // …and a cancel ends the run between batches rather than reading
    // the baseline again for work nobody is waiting for.
    expect(build, 'a cancel does not stop the run between batches')
      .toMatch(/for \(bi, batch\)[\s\S]{0,200}?cancel::stopped\(&cancel\) \{ break; \}/);
    expect(build, 'a batch does not re-read the baseline for its own points')
      .toMatch(/scan_baseline\(&mut f\)\?;[\s\S]{0,7000}?schedule_largest_first/);
    // Giants are thinned right after the read, before the queue sees
    // them, at 8 mm at most under the automatic cap — see below.
    expect(build, 'the thinning is not done before the queue')
      .toMatch(/thin_to_at_most_bounded\(v, tree_cap, from_edge, AUTO_THIN_MAX_EDGE\)/);
    expect(build, 'a set cap does not thin as far as it takes')
      .toMatch(/if max_tree_points > 0 \{\s*crate::commands::treeqsm::thin_to_at_most\(v, tree_cap, from_edge\)/);
    expect(octree, 'the automatic edge is not 8 mm').toMatch(/const AUTO_THIN_MAX_EDGE: f64 = 0\.008;/);
    expect(build, 'the thinning is not logged per tree').toMatch(/# tree \{id\} thinned before reconstruction: \{raw\} → \{now\} points at \{:\.0\} mm cubes/);
    // Every batch is one pass over the whole baseline, so the log says
    // what each cost, and the batch is a third of the ceiling rather
    // than an eighth capped at 64 million — seven passes over a
    // 450-million-point plot on a machine that could hold it in one.
    expect(build, 'a batch\u2019s read is not timed in the log').toMatch(/# batch \{\}\/\{n_batches\}: \{\} tree\(s\), \{batch_points_raw\} points read in \{:\.1\} s/);
    expect(octree, 'the batch is not a third of the ceiling').toMatch(/\(\(byte_ceiling as u64\) \/ 3 \/ 24\)\.clamp\(POINTS_PER_BATCH, MAX_POINTS_PER_BATCH\)/);
    expect(build, 'the batch\u2019s own points are not taken off the reconstructions\u2019 ceiling')
      .toMatch(/let batch_ceiling = byte_ceiling\.saturating_sub\(batch_points \* 24\)/);
    expect(build, 'the memory base is taken before the batch is read, charging its points to the first tree')
      .toMatch(/let batch_base = MemBase::now\(\);\s*let trees = schedule_largest_first/);
    // …with EXACT capacity, because push doubles and the slack was a
    // gigabyte by itself over a whole plot.
    expect(build, 'a batch grows its vectors instead of sizing them')
      .toMatch(/Vec::with_capacity\(n as usize\)/);
    expect(octree, 'there is no bound on how much of the plot is read at once')
      .toMatch(/const POINTS_PER_BATCH: u64 = 4_000_000;/);
  });

  it('thins a segment too big to reconstruct rather than dying on it', () => {
    // A measured plot's segmentation put 2.8 million points under one
    // tree id — 1.4x the amount that had already killed the
    // application, in ONE tree. No scheduling helps: whatever bounds
    // how many run at once, one of them still has to run.
    const one = octree.slice(octree.indexOf('fn reconstruct_one_tree')).slice(0, 6000);
    expect(one, 'an oversized segment is handed to TreeQSM whole')
      .toMatch(/thin_to_at_most\(\s*&pts, max_tree_points as usize,/);
    // Thinned AFTER the reference's filter, not instead of it — the
    // filter is part of the method and this is not.
    expect(one.indexOf('treeqsm::filtering('), 'the thinning runs before the reference filter')
      .toBeLessThan(one.indexOf('thin_to_at_most('));
    const loop_ = octree.slice(octree.indexOf('fn build_skeleton_from_baseline')).slice(0, 34000);
    expect(loop_, 'the log does not say which trees were thinned')
      .toMatch(/thinned_at \{[\s\S]{0,120}?mm/);

    // OFF BY DEFAULT, because off is the reference. This pinned 400k
    // for a while: on this data, off was what crashed, and a cap was the
    // only defence against one segment holding millions of points. That
    // defence is now the memory ceiling — sized from what the machine
    // has free, admitting a giant tree alone and holding the rest until
    // it is done — so the deviation no longer has to be the default to
    // keep the application up. The method's author asked for the
    // method: every tree at filtering.m's 4 mm, nothing thinned further.
    // The knob stays, opt-in, for a machine that cannot hold a tree.
    // BOTH commands, counted — one of them defaulting correctly
    // covered for the other when this was a single unbounded match.
    const defaults = [...octree.matchAll(/max_tree_points\.unwrap_or\((\d[\d_]*)\)/g)]
      .map(m => m[1]);
    expect(defaults.length, 'the skeleton commands no longer default max_tree_points')
      .toBeGreaterThanOrEqual(2);
    expect(defaults.filter(d => d === '0').length,
      `max_tree_points defaults are ${defaults.join(', ')} — every one must be 0, `
      + 'because the reference thins nothing beyond its 4 mm filter and the memory ceiling, '
      + 'not a cap, is what keeps a giant segment from taking the application down')
      .toBe(defaults.length);
    // …and a change of cap must not resume onto trees built under the
    // old one, which would mix thinned and unthinned skeletons.
    const keyStart = octree.indexOf('let key = PartialBuildKey {');
    const key = octree.slice(keyStart, octree.indexOf('let mut resumed:', keyStart));
    expect(key.length, 'the resume key literal moved').toBeGreaterThan(100);
    expect(key, 'the resume key does not carry the cap it was built with')
      .toMatch(/\bmax_tree_points,/);
    const panel2 = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
    expect(panel2, 'there is no control for the cap')
      .toMatch(/label="Max tree points"[^/]*value=\{maxPts\}/);
    expect(panel2, 'the cap is not sent to the backend')
      .toMatch(/maxTreePoints: maxPts \* 1000/);
    expect(panel2, 'the panel does not say the cap is automatic at zero')
      .toMatch(/Max tree points is automatic: a quarter of the in-flight point budget/);
    expect(panel2, 'a set cap is not said to be used as it is')
      .toMatch(/A set cap is used as it is/);
    // Turning it off must say what that means, since off is what the
    // reference does and also what crashes on this data.
    expect(panel2, 'switching the cap off says nothing about the risk')
      .toMatch(/Max tree points is automatic[\s\S]{0,600}?one giant used to run alone for an hour on one core/);
  });

  it('drives the bar from a ticker, not from tree completions', () => {
    // Under this scheduling the first trees taken are the plot's
    // largest, so the workers reach no reporting point for minutes.
    // A bar fed only by completions reads 0 % on a run with every core
    // saturated, which is what the previous stall looked like.
    const build = octree.slice(octree.indexOf('fn build_skeleton_from_baseline'),
                               octree.indexOf('fn save_skeleton_cache'));
    expect(build.length, 'the builder slice is empty — its boundaries moved')
      .toBeGreaterThan(4000);
    const loop_ = build;
    expect(loop_, 'nothing reports progress while the giants run')
      .toMatch(/thread::scope[\s\S]{0,400}?sleep[\s\S]{0,200}?emit_progress\(window, "tst"/);
    expect(loop_, 'the ticker is never asked to stop')
      .toMatch(/ticking\.store\(false/);
    // Weighted by the cost of each tree, taken from the counting pass
    // — the points themselves are no longer all in memory to measure.
    expect(loop_, 'the bar is back to counting trees')
      .toMatch(/TreeProgress::new\(order\.iter\(\)\.map\(\|&\(_, n\)\| tree_cost\(charged\(n as usize, tree_cap\)\)\)\)/);
  });

  it('stops the transfer between octree nodes, not mid-node', () => {
    const tr = octree.slice(octree.indexOf('fn run_skeleton_transfer'));
    expect(tr.slice(0, 12000), 'the transfer never takes a cancellation token')
      .toMatch(/cancel::token\("tst"\)/);
    // Between nodes: the ones already written carry their new labels
    // and the rest carry their old ones. Stopping inside a node would
    // leave one half-relabelled.
    expect(tr.slice(0, 12000), 'the transfer no longer stops at a node boundary')
      .toMatch(/if crate::commands::cancel::stopped\(&cancel\) \{ break; \}/);
  });

  it('does not blame the data for a stop the user asked for', () => {
    // A build stopped before its first tree finished and a build whose
    // every tree failed both come back with nothing. The second message
    // sends the user to inspect their segmentation; giving it to the
    // first is telling them their data is broken because they pressed
    // Stop.
    const cmd = octree.slice(octree.indexOf('pub async fn octree_build_skeletons'));
    expect(cmd.slice(0, 4000), 'a cancelled empty build reports a data problem')
      .toMatch(/was_requested\("tst"\)[\s\S]{0,200}?stopped before any tree finished/);
    // Read, not taken: `token` clears the flag, so asking it this
    // question after the run always answers no.
    expect(cmd.slice(0, 4000), 'the check consumes the request instead of reading it')
      .not.toMatch(/stopped\(&crate::commands::cancel::token\("tst"\)\)/);
  });

  it('reports a stopped build as a stop, not a finish', () => {
    // 169 of 257 trees, "✓ Built 169 trees", the skeletons loaded into
    // the view — and a log whose last word was "0 tree(s) skipped". The
    // user read the stop as a finish, and had every reason to. Every
    // surface has to say what was done and what remains.
    const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
    const cmd = octree.slice(octree.indexOf('pub async fn octree_build_skeletons'));
    expect(cmd.slice(0, 6000), 'the result does not say whether the run finished')
      .toMatch(/complete: data\.complete/);
    expect(cmd.slice(0, 6000), 'the result does not say how many trees remain')
      .toMatch(/trees_remaining: account\.trees_remaining/);
    expect(cmd.slice(0, 6000), 'a stopped run still announces 100 %')
      .toMatch(/if data\.complete \{ emit_progress\(&window, "tst", 1\.0\); \}/);
    const build = octree.slice(octree.indexOf('fn build_skeleton_from_baseline('));
    expect(build.slice(0, 40000), 'the log does not account for a stop')
      .toMatch(/stopped_summary\(/);
    expect(build.slice(0, 40000), 'a tree the stop interrupted is not named in the log')
      .toMatch(/stopped by request after \{\} ms — abandoned/);
    expect(build.slice(0, 40000), 'complete is read off the flag, not off what remains')
      .toMatch(/let complete = account\.trees_remaining == 0;/);
    expect(panel, 'the panel shows a stopped build as built')
      .toMatch(/buildResult\.complete === false[\s\S]{0,400}?Stopped/);
    expect(panel, 'the finished line does not say how many trees the plot has')
      .toMatch(/of \$\{buildResult\.treesTotal\}/);
    const tr = octree.slice(octree.indexOf('fn run_skeleton_transfer('));
    expect(tr.slice(0, 4000), 'a transfer accepts a checkpoint as the whole baseline')
      .toMatch(/if !cache\.complete \{[\s\S]{0,400}?return Err/);
    expect(tr.slice(0, 4000), 'a build stopped inside a transfer is transferred anyway')
      .toMatch(/if !built\.complete \{[\s\S]{0,400}?return Err/);
  });

  it('charges a giant at an automatic cap so it does not run alone for an hour', () => {
    // A 450-million-point plot: 25 minutes at 44 %, 4.5 % CPU, forty
    // gigabytes to spare. Every giant exceeded the points budget, ran
    // alone, and every other core waited — with TreeQSM on one thread
    // per tree. The cap thins a giant by the reference's own cubical
    // downsampling (its cover sets are 2 cm; points closer than 8 mm add
    // nothing), the queue charges it at the cap, the budget rises when
    // the run measures a point in flight cheaper than assumed, and big
    // trees get half the threads rather than a quarter.
    expect(octree, 'there is no automatic cap').toMatch(/fn auto_tree_cap\(budget: usize\) -> usize \{ \(budget \/ 4\)\.max\(AUTO_TREE_CAP_FLOOR\) \}/);
    expect(octree, 'the floor is not a million').toMatch(/const AUTO_TREE_CAP_FLOOR: usize = 1_000_000;/);
    expect(octree, 'a set cap is not respected, or zero is not automatic')
      .toMatch(/let tree_cap = if max_tree_points > 0 \{ max_tree_points as usize \} else \{ auto_tree_cap\(budget\) \};/);
    expect(octree, 'the queue charges the raw size').toMatch(/fn charged\(points: usize, cap: usize\) -> usize \{ if cap > 0 \{ points\.min\(cap\) \} else \{ points \} \}/);
    // The reconstruction gets the tree already thinned (cap 0 here) and
    // the edge it was thinned at, for the log's column.
    expect(octree, 'the reconstruction thins again, or loses the edge')
      .toMatch(/&pts, min_tree_points, 0, r_cover, qsm_models,\s*skeleton_spacing, skip_added, drop_fragments, b_offset,\s*pre_thinned, Some\(&\*stop\)\)/);
    expect(octree, 'the queue is charged at a cap after the thinning made sizes actual')
      .toMatch(/release_tree\(&queue, &space, n0, 0\);/);
    expect(octree, 'the budget still only ever lowers')
      .toMatch(/\(byte_ceiling \/ observed\.max\(MIN_BYTES_PER_POINT_IN_FLIGHT\)\)\.clamp\(budget, budget\.saturating_mul\(4\)\)/);
    expect(octree, 'the rise does not wait for a real peak').toMatch(/q\.peak < budget \/ 2 \{\s*return budget;\s*\}/);
    expect(octree, 'big trees still get a quarter of the threads').toMatch(/fn big_tree_slots\(threads: usize\) -> usize \{ \(threads \/ 2\)\.max\(1\) \}/);
    expect(octree, 'the log does not name the automatic cap').toMatch(/\(automatic: the in-flight budget of \{budget\} over four;/);
  });

  it('does not let the trees in flight make each other slow', () => {
    // The 3-hour run: every tree of a hundred thousand points or more
    // ran eight to twenty times slower than it had alone, eight trees
    // went over the 60-minute cap, and small trees were untouched until
    // sixteen giants were in flight together. Three things share the
    // blame and each has a pin: the filter's k-NN gathered and sorted
    // tens of thousands of candidates per point from one bounding-box
    // cell size; the segments pass allocated a whole-tree buffer per
    // layer; and on Windows those blocks all went through one heap
    // lock. And a cap on big trees in flight, so it cannot recur.
    const qsm = stripComments(read('src-tauri/src/commands/treeqsm.rs'));
    const knn = qsm.slice(qsm.indexOf('fn knn_distance('), qsm.indexOf('fn neighbours_within('));
    expect(knn, 'the k-NN is back on a fixed grid cell').toMatch(/KdTree::build\(points, idx\)/);
    expect(knn, 'the k-NN sorts a candidate list per point').not.toMatch(/best\.sort_by/);
    const segStart = qsm.indexOf('pub fn segments(');
    const seg = qsm.slice(segStart, qsm.indexOf('\npub fn ', segStart + 10));
    expect(seg.length, 'the segments slice is empty or runs to the end of the file').toBeLessThan(6000);
    expect(seg, 'segments allocates a whole-tree buffer per layer again')
      .not.toMatch(/vec!\[false; nb\]/);
    expect(seg, 'segments copies forb_all per segment again').not.toMatch(/forb_all\.clone\(\)[\s\S]{0,40}?layers/);
    expect(seg, 'the per-segment marks are not undone by list').toMatch(/for &c in &forb_local \{ forb\[c as usize\] = forb_all\[c as usize\]; \}/);
    const filt = qsm.slice(qsm.indexOf('pub fn filtering('), qsm.indexOf('pub fn thin_to_at_most('));
    expect(filt, 'the filter stages are invisible in the pass trace')
      .toMatch(/pass\("filter_knn"\)[\s\S]*pass\("filter_components"\)[\s\S]*pass\("filter_cube"\)/);
    const mem = stripComments(read('src-tauri/src/memtrack.rs'));
    expect(mem, 'the allocator is the platform heap again').toMatch(/static UNDERLYING: mimalloc::MiMalloc = mimalloc::MiMalloc;/);
    expect(mem, 'something still forwards to System').not.toMatch(/System\./);
    const take = octree.slice(octree.indexOf('fn take_tree('), octree.indexOf('fn release_tree('));
    expect(take, 'big trees are not capped in flight').toMatch(/g\.big_in_flight >= g\.big_slots/);
    expect(take, 'a big tree taken is not counted').toMatch(/if n >= BIG_TREE_POINTS \{ g\.big_in_flight \+= 1; \}/);
    const release = octree.slice(octree.indexOf('fn release_tree('), octree.indexOf('fn release_tree(') + 800);
    expect(release, 'a big tree released is not uncounted').toMatch(/if n >= BIG_TREE_POINTS \{ g\.big_in_flight = g\.big_in_flight\.saturating_sub\(1\); \}/);
    expect(octree, 'the run does not build its queue with the slot cap').toMatch(/big_slots: big_tree_slots\(threads\)/);
    expect(octree, 'the log does not say how many slots there were').toMatch(/# big-tree slots \{\}/);
  });

  it('keeps skeleton coordinates off the f32 lattice and the labels in every export', () => {
    // The skeleton of a whole plot drew as vertical dashed lines: its
    // points were world f32, and at an LV95 easting of 2 600 000 m an
    // f32 steps by a quarter metre. The cache now has an origin and the
    // points are relative to it, on disk, in the renderer's payload, in
    // the transfer's distances and in every export — which also carry
    // the tree id and the class, the two labels the transfer moves.
    const build = octree.slice(octree.indexOf('fn skeleton_points_of('), octree.indexOf('fn skeleton_points_of(') + 3000);
    expect(build, 'skeleton points leave the reconstruction as world f32')
      .toMatch(/c\.start\[0\] \+ dx \* t - origin\[0\]\) as f32/);
    expect(octree, 'the cache has no origin').toMatch(/origin: b_offset,/);
    expect(octree, 'the on-disk header does not carry the origin').toMatch(/const SKEL_HEADER: usize = 48;/);
    expect(octree, "the renderer's payload does not carry the origin").toMatch(/const SKEL_PLANAR_HEADER: usize = 56;/);
    const tr = octree.slice(octree.indexOf('fn run_skeleton_transfer('), octree.indexOf('fn run_skeleton_transfer(') + 12000);
    expect(tr, 'the transfer measures distances in world f32').toMatch(/\(wx - origin\[0\]\) as f32, \(wy - origin\[1\]\) as f32/);
    expect(tr, 'the hull test is in a different frame from the hull').toMatch(/hull\.contains\(wx - origin\[0\], wy - origin\[1\]\)/);
    const exp = octree.slice(octree.indexOf('fn write_skeleton_file('), octree.indexOf('fn write_skeleton_file(') + 9000);
    expect(exp, 'the text export lacks the class column').toMatch(/tree_id,branch_order,class/);
    expect(exp, 'the PLY export writes float coordinates').toMatch(/property double x/);
    expect(exp, 'the PLY export lacks tree id and class').toMatch(/property int tree_id[\s\S]{0,200}?property uchar class/);
    expect(exp, 'the LAS export does not put the class where a reader shows it')
      .toMatch(/classification: las::point::Classification::new\(class\(order\)\)/);
    expect(exp, 'the LAS export does not carry the tree id as point source id').toMatch(/point_source_id: \(raw_tid as u32 & 0xFFFF\) as u16/);
    expect(exp, 'the text export lacks the QSM radius').toMatch(/tree_id,branch_order,class,radius/);
    expect(exp, 'the PLY export lacks the QSM radius').toMatch(/property float radius/);
    expect(exp, 'the LAS export does not carry the radius as intensity').toMatch(/let intensity = \(radius_m\[i\] \* 1000\.0\)/);
    // By NAME, as Extra Bytes: a reader showed "point source id" and
    // "user data" where the method's own words are tree_id and class.
    expect(exp, 'the LAS export has no named Extra Bytes').toMatch(/builder\.vlrs\.push\(skeleton_extra_bytes_vlr\(\)\)/);
    expect(octree, 'the Extra Bytes are not tree_id, branch_order, class, radius')
      .toMatch(/\("tree_id", 6,[\s\S]{0,200}?\("branch_order", 1,[\s\S]{0,200}?\("class", 1,[\s\S]{0,200}?\("radius", 9,/);
    const planar = stripComments(read('src/persistence/skeletonPlanar.ts'));
    expect(planar, 'the decoder does not read the origin').toMatch(/dv\.getFloat64\(32, true\), dv\.getFloat64\(40, true\), dv\.getFloat64\(48, true\)/);
    const view = stripComments(read('src/three/OctreeView.tsx'));
    expect(view, 'the overlay draws relative coordinates as world').toMatch(/let rx = skeleton\.xyz\[i \* 3\];[\s\S]{0,400}?const wx = ox \+ rx;/);
    const qsm = stripComments(read('src-tauri/src/commands/treeqsm.rs'));
    expect(qsm, 'the filter does not report what each stage removed').toMatch(/pub fn filtering_report\(/);
    expect(octree, "the log does not print the reference's filtering block").toMatch(/# tree \{tree_id\} filter: \{\}/);
  });

  it('shows and names every point of an isolated tree, however far', () => {
    // Tree 228 looked clean in review; fifty metres away stood a
    // cluster with its id, unloaded because the isolate box is clamped
    // around the trunk, and TreeQSM fitted cylinders to it. The scan
    // now names each tree's records, the planner forces exactly those,
    // the panel says how far the tree reaches, and the build log names
    // the fragment.
    expect(octree, 'the scan does not list the records a tree lives in').toMatch(/records: recs\.remove\(&tree_id\)\.unwrap_or_default\(\)/);
    expect(octree, 'the build does not look for far fragments').toMatch(/far_fragments\(&pts, FRAGMENT_CELL_M, FRAGMENT_MIN_POINTS, FRAGMENT_MIN_GAP_M\)/);
    expect(octree, 'a fragment is not named in the log').toMatch(/# tree \{tree_id\} fragments: \{\}/);
    const view = stripComments(read('src/three/OctreeView.tsx'));
    expect(view, 'the planner forces only the clamped box').toMatch(/const forcedRec = \(rec: number\): boolean =>\s*inDetail\(rec\) \|\| \(forcedRecords !== null && forcedRecords\.has\(rec\)\)/);
    expect(view, 'a records list from another tree would be used').toMatch(/fc\.isolateRecords\.treeId === fc\.isolateTreeId/);
    expect(view.match(/inDetail\(/g)?.length, 'a planner path still asks the box alone').toBe(1);
    const review = stripComments(read('src/components/shell/TreeReviewPanel.tsx'));
    expect(review, 'isolating a tree does not hand its records to the streamer').toMatch(/isolateRecords: t\.records \? \{ treeId: t\.treeId, records: t\.records \} : null/);
    expect(review, 'the panel does not say the tree reaches beyond the frame').toMatch(/farReach\.toFixed\(0\)\} m outside the framed box/);
    expect(review, 'there is no way to frame the whole tree').toMatch(/api\?\.frameBox\(selectedEntry\.bboxMin, selectedEntry\.bboxMax\)/);
    // And when the far parts still do not show, the panel says where the
    // chain broke instead of leaving it to be guessed at.
    expect(view, 'the viewer cannot report what it holds of the isolated tree').toMatch(/isolateStatus: \(\) => \{/);
    expect(view, 'the status does not count the points the filter lets through').toMatch(/if \(ids\[i\] === id && v\[i\]\) drawnPoints\+\+;/);
    expect(review, 'the panel does not show the streamer status').toMatch(/streamer · records/);
    expect(review, 'an old scan is not named as the reason').toMatch(/This scan predates the record list/);
  });

  it('can leave TreeQSM\u2019s gap-filling connectors out of the skeleton', () => {
    // A tree grew a straight fake branch tens of metres long: a
    // cylinder TreeQSM spliced across a gap to a stray cluster, not a
    // fit to points, and the transfer would label along it. The
    // reference samples those too; this is the option to not, on by
    // default, named in the log per tree, and part of the resume key.
    expect(octree, 'the sampler cannot leave connectors out').toMatch(/if skip_gaps && c\.added \{/);
    expect(octree, 'the build command has no such option').toMatch(/skip_added_cylinders: Option<bool>,[\s\S]{0,400}?-> Result<SkeletonBuildResult, String>/);
    expect(octree, 'the transfer command has no such option').toMatch(/skip_added_cylinders: Option<bool>,[\s\S]{0,400}?-> Result<SkeletonTransferResult, String>/);
    expect(octree, 'the default is not on').toMatch(/let skip_added = skip_added_cylinders\.unwrap_or\(true\);/);
    expect(octree, 'a skipped connector is not named in the log').toMatch(/# tree \{tree_id\} connectors:/);
    expect(octree, 'the resume key ignores the option').toMatch(/#\[serde\(default\)\]\s*skip_added: bool,/);
    const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
    expect(panel, 'the panel has no toggle').toMatch(/leave out gap-spanning cylinders \(TreeQSM added, or a branch 1 m\+ with no points along it\)/);
    expect(panel, 'the build does not send the toggle').toMatch(/skipAddedCylinders: skipAdded,[\s\S]{0,300}?\}\);/);
    expect(panel.match(/skipAddedCylinders: skipAdded,/g)?.length, 'build and transfer both send it').toBe(2);
    const bridge = stripComments(read('src/persistence/desktopBridge.ts'));
    expect(bridge.match(/skipAddedCylinders: opts\.skipAddedCylinders,/g)?.length, 'the bridge forwards it on both commands').toBe(2);
  });

  it('leaves out a long cylinder with no points along it, whatever TreeQSM flagged it', () => {
    // The screenshot: a straight dotted line metres long through empty
    // space, inside a lasso. TreeQSM's `added` flag names the
    // connectors it spliced in, but a fitted cylinder through a few
    // stray cover sets far apart carries no flag — so the flag alone
    // did not guarantee the line goes. Whether a cylinder has points
    // along it does: a metre or longer, points along less than half of
    // it, and it is left out — under the same option, counted in the
    // same log line.
    expect(octree, 'there is no geometric support test').toMatch(/fn unsupported_cylinders\(cyls: &\[BranchCylinder\], pts: &\[\[f64; 3\]\]\) -> Vec<bool>/);
    expect(octree, 'short cylinders are judged too').toMatch(/const GAP_MIN_LEN_M: f64 = 1\.0;/);
    expect(octree, 'the support fraction is not half').toMatch(/const GAP_SUPPORT_MIN: f64 = 0\.5;/);
    expect(octree, 'the tube has no floor').toMatch(/const GAP_TUBE_MIN_M: f64 = 0\.15;/);
    expect(octree, 'the test is judged against the wrong points, or not under the option').toMatch(/let unsupported = if skip_added \{ unsupported_cylinders\(&cylinders, &pts\) \} else \{ Vec::new\(\) \};/);
    expect(octree, 'the sampler ignores the verdict').toMatch(/if skip_gaps && unsupported\.get\(i\)\.copied\(\)\.unwrap_or\(false\) \{/);
    expect(octree, 'the log does not count them').toMatch(/# tree \{tree_id\} connectors: \{connectors_skipped\} gap-filling cylinder\(s\) \(TreeQSM 'added', \{connectors_length_m:\.1\} m\) and \{unsupported_skipped\} fitted branch cylinder\(s\) with no points along them/);
    // The stem is never judged. Measured against the reference on 256
    // ULS trees, branch order 0 was the least-supported structure in
    // both implementations (the bole is occluded under the canopy), a
    // third of every unsupported skeleton point was stem, and the stem
    // is what carries class 1 into the transfer — a blanket test would
    // have deleted trunk first.
    expect(octree, 'the stem is judged like a branch').toMatch(/fn unsupported_cylinders\([^)]*\) -> Vec<bool> \{[\s\S]{0,200}?if c\.branch_order == 0 \{ continue; \}/);
    expect(stripComments(read('src/components/shell/SkeletonTransferPanel.tsx')), 'the tooltip does not say the stem is exempt').toMatch(/The stem is never judged/);
    expect(octree, 'the log line is only written for connectors').toMatch(/if connectors_skipped > 0 \|\| unsupported_skipped > 0 \{/);
  });

  it('writes the method\u2019s inputs at the top of the log, in the reference\u2019s names', () => {
    // A comparison against the MATLAB reference turned on which
    // PatchDiam values and which filter.EdgeLength the port used, and
    // the log had every answer implicit and none written; its
    // "thinned == filtered" was even read as "no filtering". Now the
    // run header says all of it, and what the columns count.
    expect(octree, 'the log does not name the TreeQSM inputs').toMatch(/# inputs: TreeQSM PatchDiam1 \{:\.3\}, PatchDiam2Min \{:\.3\}, PatchDiam2Max \{:\.3\}/);
    expect(octree, 'the log does not name the filter settings').toMatch(/filtering\.m k \{\}, nsigma \{\}, radius \{\} \(\{\}\), ncomp \{\} \(PatchDiam1 \{\}, BallRad1 \{\}\)/);
    expect(octree, 'the log does not name EdgeLength').toMatch(/EdgeLength \{\} \(\{\}\)/);
    expect(octree, 'the inputs are not the ones the run uses').toMatch(/QsmInputs::sweep_around_n\(r_cover, qsm_models\);\s*let fp = crate::commands::treeqsm::FilterParams::default\(\);/);
    expect(octree, 'the columns are not explained').toMatch(/# columns: points = under the id; filtered = after filtering\.m/);
    const treeqsm = stripComments(read('src-tauri/src/commands/treeqsm.rs'));
    expect(treeqsm, 'the filter default is not the stock 4 mm').toMatch(/edge_length: 0\.004 \}/);
    expect(treeqsm, 'the cover size does not scale the stock sweep').toMatch(/for &f1 in &\[1\.0, 1\.5\] \{\s*for &fmax in &\[0\.875, 1\.25\] \{\s*for &fmin in &\[0\.25, 0\.375\] \{/);
  });

  it('keeps every tree\u2019s TreeQSM cylinders as a table beside the cache', () => {
    // The user wants the QSMs themselves, not only the skeleton sampled
    // from them — for other software and for later use here. One CSV
    // per plot, one row per cylinder, world coordinates, written as a
    // .part while the run goes and renamed only when the plot is
    // complete, appended to on a resume; named in the log and the panel.
    expect(octree, 'the table has another name').toMatch(/const QSM_CSV_FILE: &str = "qsm_cylinders\.csv";/);
    expect(octree, 'the table is not written as a part first').toMatch(/const QSM_CSV_PART: &str = "qsm_cylinders\.csv\.part";/);
    expect(octree, 'the columns changed').toMatch(/const QSM_CSV_HEADER: &str = "tree_id,cyl,start_x,start_y,start_z,end_x,end_y,end_z,axis_x,axis_y,axis_z,length,radius,unmod_radius,volume,parent,extension,branch,branch_order,position_in_branch,added,region_points,mad,surf_cov";/);
    expect(octree, 'the rows are not made per tree').toMatch(/fn qsm_csv_rows\(tree_id: i32, cyls: &\[BranchCylinder\]\) -> String/);
    expect(octree, 'the result does not name the table').toMatch(/pub qsm_path: Option<String>,\s*\}/);
    expect(octree, 'the log does not say').toMatch(/# QSM cylinders:/);
    const treeqsm = stripComments(read('src-tauri/src/commands/treeqsm.rs'));
    expect(treeqsm, 'the cylinder record lost the extension').toMatch(/extension: m\.extension\[i\],/);
    expect(treeqsm, 'the cylinder record lost the unmodified radius').toMatch(/unmod_radius: m\.unmod_radius\[i\],/);
    const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
    expect(panel, 'the panel does not show the table').toMatch(/QSM cylinders saved to/);
    expect(panel, 'the result type has no path').toMatch(/qsmPath\?: string \| null;/);
  });

  it('can leave far fragments out before reconstructing, and checks the skeleton\u2019s height', () => {
    // The reference, given a 2 174-point sliver 53 m from tree 228, took
    // the sliver for the tree because its base sat lower and modelled
    // 2.9 m of a 34.7 m tree. The fragment mask leaves the sliver out
    // (on by default, part of the resume key), and the height check
    // names any tree whose skeleton is a fifth off its cloud.
    expect(octree, 'the fragments come without a per-point mask').toMatch(/fn far_fragments_with_mask\(/);
    expect(octree, 'the reconstruction cannot leave fragments out').toMatch(/if drop_fragments && !fragments\.is_empty\(\)/);
    expect(octree, 'the build command has no option for it').toMatch(/drop_far_fragments: Option<bool>,[\s\S]{0,500}?-> Result<SkeletonBuildResult, String>/);
    expect(octree, 'the default is not on').toMatch(/let drop_fragments = drop_far_fragments\.unwrap_or\(true\);/);
    expect(octree, 'the height is not checked').toMatch(/height_ratio_flag\(skeleton_z_span, cloud_z_span\)/);
    expect(octree, 'a height anomaly is not named in the log').toMatch(/# tree \{tree_id\} height:/);
    const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
    expect(panel, 'the panel has no fragment toggle').toMatch(/leave out far fragments before reconstructing/);
    expect(panel.match(/dropFarFragments: dropFragments,/g)?.length, 'build and transfer both send it').toBe(2);
  });

  it('shows the skeletons on their own, coloured by instance, class or radius', () => {
    // Load + show drew the skeleton over its own cloud in one colour per
    // tree and nothing else. The payload now carries the radius, the
    // panel picks the colouring — tree id, class, radius — and hides
    // the cloud while the skeletons show, bringing it back with Hide.
    const planar = stripComments(read('src/persistence/skeletonPlanar.ts'));
    expect(planar, 'the payload does not carry the radius').toMatch(/radiusMm: new Uint16Array\(u8\.buffer, base \+ 16 \* n, n\)/);
    expect(octree, 'the Rust side does not write the radius into the payload').toMatch(/const SKEL_PLANAR_BYTES_PER_POINT: usize = 19;/);
    const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
    expect(panel, 'no colour choice').toMatch(/\['tree', 'class', 'radius'\] as SkeletonColorMode\[\]/);
    expect(panel, 'the cloud is not hidden for the skeletons').toMatch(/if \(skelOnly\) setCloudVisible\(false\);/);
    expect(panel, 'Hide does not bring the cloud back').toMatch(/const showCloud = useCallback\(\(\) => \{\s*setSkeletonOverlay\(null\);\s*setCloudVisible\(true\);/);
    // Hide used to remember in a ref whether THIS panel instance had
    // hidden the cloud, and was disabled without a summary to show: a
    // panel closed and reopened had neither, the cloud stayed hidden,
    // and the way back was the Layers panel. The overlay and the
    // cloud's visibility are the shell's state; that is what it reads.
    expect(panel, 'the panel still remembers in a ref what the shell knows').not.toMatch(/hidCloudRef/);
    expect(panel, 'Hide is disabled without this instance\u2019s summary').toMatch(/disabled=\{\(!skeletonOverlay && cloudVisible\) \|\| !!busy\}/);
    expect(panel, 'a transfer onto the open cloud leaves it hidden under the skeletons').toMatch(/if \(targetIsOpen\) \{[\s\S]{0,400}?showCloud\(\);/);
    const view = stripComments(read('src/three/OctreeView.tsx'));
    expect(view, 'the overlay ignores the colour mode').toMatch(/if \(mode === 'class'\)[\s\S]{0,600}?else if \(mode === 'radius'\)/);
    // Alone, the skeletons are solid: depth-tested and written, opaque.
    // Depth-free points draw in array order, and with the cloud hidden
    // the tree at the back painted over the tree at the front — turning
    // the plot showed every tree through every other.
    expect(view, 'the overlay is depth-free even when the cloud is hidden')
      .toMatch(/mat\.depthTest = solid;\s*mat\.depthWrite = solid;\s*mat\.transparent = !solid;/);
    expect(view, 'the viewport does not make the skeletons solid when the cloud is hidden')
      .toMatch(/<SkeletonPointsOverlay skeleton=\{skeletonOverlay\} offset=\{octree\.meta\.offset\} solid=\{!cloudVisible\} zAdjust=\{heights\.skeletonZAdjust\} \/>/);
    // And a skeleton is the colour of its tree: the viewport's palette,
    // not a hash of its own.
    expect(view, 'the skeleton hashes its own hue for a tree id')
      .toMatch(/const \[r, g, b\] = tid <= 0 \? UNASSIGNED_RGB : treeIdColor\(tid\);/);
  });
});

/** The application did not crash. The VIEW did.
 *
 *  Six runs ended the same way: black content area, live menu bar,
 *  nothing to click. That is a lost WebGL context, not a dead process —
 *  and the checkpoint file proved the backend kept running through it,
 *  because the next run resumed twelve finished trees from it.
 *
 *  The canvas called preventDefault on webglcontextlost, which is what
 *  makes a context RESTORABLE — the browser will not fire
 *  webglcontextrestored without it — and then nothing restored it. The
 *  comment beside it said it was letting the browser recover. */
describe('a lost graphics context is recovered from and explained', () => {
  const view = stripComments(read('src/three/OctreeView.tsx'));

  it('handles the restore it asks the browser to perform', () => {
    expect(view, 'the canvas no longer opts into restoration')
      .toMatch(/addEventListener\('webglcontextlost'/);
    expect(view, 'preventDefault is gone, so no restore will ever be offered')
      .toMatch(/const lost = \(e: Event\) => \{\s*e\.preventDefault\(\)/);
    expect(view, 'nothing handles the restore the canvas asked for')
      .toMatch(/addEventListener\('webglcontextrestored'/);
    // On 'demand' nothing would ask for the first frame after a
    // restore, so the canvas would come back and stay blank.
    expect(view, 'the restored context is never asked to draw')
      .toMatch(/const restored = \(\) => \{\s*onRestored\(\);\s*invalidate\(\);/);
  });

  it('does not take the old canvas being torn down for a crash', () => {
    // react-three-fiber calls forceContextLoss() on a Canvas's renderer
    // half a second after it unmounts. The Canvas is keyed by dataset,
    // so every change of point cloud, and every import, fired
    // webglcontextlost on the OLD canvas — into listeners attached in
    // onCreated and never removed, which told the still-mounted view
    // its context was lost. The "display driver reset" overlay came up
    // on every switch.
    expect(view, 'the listeners are still attached in onCreated, where nothing removes them')
      .not.toMatch(/onCreated=\{[\s\S]{0,400}?addEventListener/);
    expect(view, 'the watcher is not a child of the canvas')
      .toMatch(/<ContextLossWatch onLost=\{\(\) => setGlLost\(true\)\} onRestored=\{\(\) => setGlLost\(false\)\} \/>/);
    expect(view, 'the listeners do not go with the canvas they watch')
      .toMatch(/return \(\) => \{\s*el\.removeEventListener\('webglcontextlost', lost, false\);\s*el\.removeEventListener\('webglcontextrestored', restored, false\);/);
    expect(view, 'a loss on a canvas already out of the document counts as a crash')
      .toMatch(/e\.preventDefault\(\);\s*if \(!el\.isConnected\) return;\s*onLost\(\);/);
    expect(view, 'a new dataset does not start with a live context')
      .toMatch(/useEffect\(\(\) => \{ setGlLost\(false\); \}, \[octree\.dir\]\);/);
  });

  it('recovers in place first, and a full reload comes back to the same cloud', () => {
    // The overlay's only remedy was window.location.reload(), which
    // restored the project and not the dataset: a user whose view had
    // just died landed on the dataset list. A new canvas for the same
    // cloud is what a change of dataset does anyway, so that is the
    // first button; the reload is the second, and it leaves a crumb
    // the editor reopens the cloud from.
    expect(view, 'the canvas cannot be recreated without changing dataset')
      .toMatch(/key=\{`\$\{octree\.dir\}#\$\{canvasEpoch\}`\}/);
    expect(view, 'the first remedy is not a new canvas')
      .toMatch(/onClick=\{\(\) => \{ setGlLost\(false\); setCanvasEpoch\(\(e\) => e \+ 1\); \}\}/);
    expect(view, 'the reload forgets which cloud was open')
      .toMatch(/onClick=\{\(\) => \{ rememberReopen\(octree\.dir\); window\.location\.reload\(\); \}\}/);
    const editor = stripComments(read('src/modules/EditorModule.tsx'));
    expect(editor, 'the editor never reopens the remembered cloud')
      .toMatch(/const dir = takeReopen\(\);\s*if \(!dir \|\| !octreeList\.some\(\(e\) => e\.dir === dir\)\) return;\s*let cancelled = false;\s*openOctree\(dir\)/);
    const crumb = stripComments(read('src/persistence/reopenAfterReload.ts'));
    expect(crumb, 'the crumb outlives the session it was left in')
      .toMatch(/typeof sessionStorage !== 'undefined' \? sessionStorage : null/);
    // And fiber really does what this guards against — pin the
    // behaviour, so a fiber upgrade that changes it is noticed.
    const distDir = new URL('../../../node_modules/@react-three/fiber/dist/', import.meta.url);
    const events = readdirSync(distDir).find((f) => /^events-[0-9a-f]+\.esm\.js$/.test(f));
    expect(events, 'fiber\u2019s events bundle is not where it was').toBeTruthy();
    const fiber = readFileSync(new URL(events as string, distDir), 'utf8');
    expect(fiber, 'fiber no longer forces the context lost on unmount; the guard may be dead')
      .toMatch(/function unmountComponentAtNode[\s\S]{0,1200}?forceContextLoss/);
  });

  it('says the view died rather than leaving a black screen', () => {
    // Six times the user reasonably concluded the whole run was lost.
    expect(view, 'nothing records that the context was lost')
      .toMatch(/setGlLost\(true\)/);
    expect(view, 'nothing clears it when the context comes back')
      .toMatch(/setGlLost\(false\)/);
    expect(view, 'a lost context still shows nothing but black')
      .toMatch(/\{glLost && \(/);
    // The one fact that matters, because it is the opposite of what a
    // black window implies.
    expect(view, 'the notice does not say the backend survived')
      .toMatch(/still running<\/b>/);
  });

  it('stops redrawing the cloud while the backend has every core', () => {
    // A frame drawing tens of millions of points takes seconds when
    // nothing is left to draw it with, and Windows resets a display
    // driver whose operation runs past about two. That is the trigger.
    expect(view, 'the viewport redraws continuously during a long run')
      .toMatch(/frameloop=\{busyStage \? 'demand' : 'always'\}/);
    expect(view, 'nothing tells the viewport a backend stage is running')
      .toMatch(/onOctreeProgress\(\(stage, pct\) =>/);
    expect(view, 'a finished stage never releases the viewport')
      .toMatch(/if \(pct >= 1\) \{ finish\(\); return; \}/);
    expect(view, 'finishing no longer clears the busy stage')
      .toMatch(/const finish = \(\) => \{\s*setBusyStage\(null\);/);
    // A stage that dies without reporting completion would otherwise
    // pin the viewport on 'demand' for the rest of the session.
    expect(view, 'a stage that dies mid-run pins the viewport for ever')
      .toMatch(/setTimeout\(finish, 60_000\)/);
  });

  /** Six "crashes" were read as a lost WebGL context. The seventh was
   *  photographed: WebView2's own crash page, a renderer PROCESS gone.
   *  Whatever the proximate cause on a given machine, a viewport that
   *  holds nothing and draws nothing while the backend saturates it
   *  cannot run out of memory, cannot stall on a long frame, and cannot
   *  lose a context that matters. So while a heavy stage runs the
   *  resident point set is released and the streamer paused. */
  it('releases the resident point set while a heavy stage runs, and pauses the streamer', () => {
    const view = stripComments(read('src/three/OctreeView.tsx'));
    expect(view, 'the skeleton build is not a release stage')
      .toMatch(/RELEASE_CLOUD_FOR = new Set\(\[[^\]]*'tst'/);
    expect(view, 'the release is not wired to the stage')
      .toMatch(/RELEASE_CLOUD_FOR\.has\(stage\)[\s\S]{0,200}?setStreamingPaused\(true\)[\s\S]{0,120}?reloadNodes\(\)/);
    expect(view, 'the planner does not honour the pause — it would refill what was just released')
      .toMatch(/if \(!streamPausedRef\.current\) planAndStream\(/);
    expect(view, 'the pause is never lifted').toMatch(/setStreamingPaused\(false\)/);
    // Edits are safe to release because they never lived in the nodes.
    expect(view).toMatch(/savePatches\(octree\.dir, storeRef\.current\.map\)/);
  });
});

/** The labels can land on any cloud in the project.
 *
 *  The backend always took both directories. Only the frontend pinned
 *  the second one to whatever was on screen, so a project with five
 *  clouds could transfer into exactly one of them — and the panel said
 *  "Target: <active dataset>" as though that were the design. */
describe('the transfer target is the user\'s to choose', () => {
  const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
  const view = stripComments(read('src/three/OctreeView.tsx'));

  it('offers every OTHER dataset as a target, and never the baseline', () => {
    const step3 = panel.slice(panel.indexOf('3. Transfer labels'));
    // Bound both ways: a select showing targetDir that cannot change
    // it is the same limitation with a dropdown drawn on it.
    expect(step3, 'there is no target picker').toMatch(/value=\{targetDir\}/);
    expect(step3, 'the target picker cannot change the target')
      .toMatch(/onChange=\{\(e\) => setTargetDir\(e\.target\.value\)\}/);
    // The baseline is never a target: labels flow from its skeletons to
    // ANOTHER cloud, and offering it was offering to overwrite a
    // segmentation with a copy of itself. A project with no other cloud
    // says so instead of listing one.
    expect(panel, 'the target list is not every other cloud')
      .toMatch(/const targetCandidates = octreeList\.filter\(\(e\) => !sameDir\(e\.dir, baselineDir\)\);/);
    expect(step3, 'the picker lists the baseline too').not.toMatch(/octreeList\.map\(e =>/);
    expect(step3, 'the picker does not list the other clouds').toMatch(/targetCandidates\.map\(e =>/);
    expect(step3, 'a project with no other cloud lists nothing and says nothing')
      .toMatch(/targetCandidates\.length === 0 \? \([\s\S]{0,600}?No other cloud in the project/);
    expect(panel, 'a target equal to the baseline is not replaced')
      .toMatch(/const ok = targetDir && !sameDir\(targetDir, baselineDir\) && targetCandidates\.some\(\(e\) => sameDir\(e\.dir, targetDir\)\);/);
    expect(panel, 'the transfer no longer sends the chosen target')
      .toMatch(/api\.skeletonTransfer\(baselineDir, targetDir,/);
  });

  it('matches each side in the height frame the panel chose', () => {
    const octree = stripComments(read('src-tauri/src/commands/octree.rs'));
    // A TLS baseline normalised to height above ground against a
    // HeliALS target in elevation transferred 0.0 %: every point was
    // hundreds of metres from every skeleton point. The panel guesses
    // each side's frame from its bounding box, warns, defaults the
    // elevation side to height above its own ground surface, and sends
    // both choices; the transfer matches z in that frame.
    expect(panel, 'the panel does not guess the frames').toMatch(/guessFrame\(baselineEntry\.bboxMin\[2\], baselineEntry\.bboxMax\[2\]\)/);
    expect(panel, 'the panel does not warn on a mismatch').toMatch(/The two clouds are not in the same height\./);
    expect(panel, 'the panel has no choice per side').toMatch(/setBaseHeight\(e\.target\.value as HeightFrame\)[\s\S]{0,1200}?setTgtHeight\(e\.target\.value as HeightFrame\)/);
    expect(panel, 'the transfer does not send the frames').toMatch(/baselineHeight: baseHeight,\s*targetHeight: tgtHeight,/);
    const bridge = stripComments(read('src/persistence/desktopBridge.ts'));
    expect(bridge, 'the bridge drops the frames').toMatch(/baselineHeight: opts\.baselineHeight,\s*targetHeight: opts\.targetHeight,/);
    expect(octree, 'the command has no frame parameters').toMatch(/baseline_height: Option<String>,\s*target_height: Option<String>,/);
    expect(octree, 'the frames are not parsed').toMatch(/let baseline_frame = HeightFrame::parse\(baseline_height\.as_deref\(\)\)\?;/);
    expect(octree, 'the skeleton is matched in its stored z whatever the frame')
      .toMatch(/Some\(d\) => match d\.sample\(wx, wy\) \{ Some\(g\) => wz - g as f64, None => 1\.0e6 \},/);
    expect(octree, 'the target is matched in its stored z whatever the frame')
      .toMatch(/let tz = match target_frame \{ HeightFrame::Stored => wz, HeightFrame::AboveGround => hag \};/);
    expect(octree, 'the nearest search reads the unframed skeleton').toMatch(/let s = match_xyz\[j as usize\];/);
    expect(octree, 'the origin comes off z when a side is a height')
      .toMatch(/let z_ref: f64 = if any_above \{ 0\.0 \} else \{ origin\[2\] \};/);
  });

  it('spends the filter\u2019s minutes on a grid and its k-NN on every core', () => {
    // Of a giant's eight minutes, seven and a half were filtering.m's
    // small-component stage — a greedy ball cover and a neighbour set
    // per cover from every point's list of covering balls — to remove
    // one clump. A grid of PatchDiam1 cells linked within BallRad1 says
    // the same in linear time and is the more permissive where it
    // differs; the k-NN stage was 17 s on one core with fifteen idle.
    const treeqsm = stripComments(read('src-tauri/src/commands/treeqsm.rs'));
    expect(treeqsm, 'the component stage still builds a cover').not.toMatch(/let seeds = greedy_ball_cover\(&sub, p\.patch_diam1 \* 0\.5\);/);
    expect(treeqsm, 'the component stage is not on a grid').toMatch(/let drop = small_components\(points, &idx, p\.patch_diam1, p\.ball_rad1, p\.ncomp\);/);
    expect(treeqsm, 'the grid does not link within a ball').toMatch(/let reach = \(\(ball_rad \/ cell\)\.ceil\(\) as i64\)\.clamp\(1, 8\);/);
    expect(treeqsm, 'the k-NN queries run on one thread').toMatch(/fn knn_distance\([^)]*\) -> Vec<f64> \{\s*use rayon::prelude::\*;[\s\S]{0,400}?idx\.par_iter\(\)/);
  });

  it('reloads the viewport only when the target is the open dataset', () => {
    // A target that is not open has had its octree.bin written and
    // picks the labels up next time; forcing a reload of the OPEN
    // dataset after writing a different one would show the wrong
    // thing, and skipping it when the target IS open leaves the
    // viewport on the old labels.
    const fn = view.slice(view.indexOf('const doSkeletonTransfer'),
                          view.indexOf('const doSegmentAnytree'));
    expect(fn, 'the target is pinned to the open dataset again')
      .toMatch(/octreeSkeletonTransfer\(baselineDir, targetDir, params\)/);
    expect(fn, 'nothing distinguishes an open target from another')
      .toMatch(/const isActive = targetDir === octree\.dir/);
    expect(fn, 'the reload is no longer conditional')
      .toMatch(/if \(isActive\) \{[\s\S]{0,400}?reloadNodes\(\)/);
  });

  it('still refuses to transfer a cloud onto itself', () => {
    expect(panel).toMatch(/transferIsSelf\s*=\s*!!targetDir\s*&&\s*sameDir\(baselineDir, targetDir\)/);
    expect(panel, 'the transfer button ignores the self-transfer case')
      .toMatch(/disabled=\{[^}]*transferIsSelf/);
  });

  it('does not answer for a cloud it cannot see', () => {
    // `hasTreeIds` reads the LOADED point store. Asked about a target
    // that is not open it reports on the open one instead, and the
    // dangerous direction of that wrong answer is the reassuring one:
    // "writes fresh tree_ids" about a cloud whose labels are in fact
    // about to be destroyed. So the unopened case must not consult it.
    const fn = panel.slice(panel.indexOf('const runTransfer'),
                           panel.indexOf('const transferRatio'));
    expect(fn, 'the transfer does not know whether its target is open')
      .toMatch(/const targetIsOpen = sameDir\(targetDir, octree\?\.dir\)/);
    // The unopened branch is taken FIRST and warns without asking.
    expect(fn, 'hasTreeIds is consulted before the target is known to be open')
      .toMatch(/!targetIsOpen[\s\S]{0,600}?api\.hasTreeIds\(\)/);
    // …and it says why it cannot check, rather than implying it did.
    expect(fn, 'the warning does not say the target could not be checked')
      .toMatch(/not the dataset you have open/);
    // Whichever branch runs, the dialog names the cloud at risk. The
    // old text said "this cloud", which reads as the open one.
    expect(fn, 'the confirm text does not name the target')
      .toMatch(/const name = targetLabel \|\| 'the target'/);
    expect(fn, 'a nameless target would read as the open dataset')
      .not.toMatch(/This cloud already has tree_id data/);
  });

  it('recolours the viewport only for a result the viewport is showing', () => {
    // Colouring by tree_id after a transfer shows the user what just
    // happened — unless what just happened was to another cloud, in
    // which case it presents unrelated labels as the outcome.
    const fn = panel.slice(panel.indexOf('const runTransfer'),
                           panel.indexOf('const transferRatio'));
    expect(fn, 'the recolour is unconditional again')
      .toMatch(/if \(targetIsOpen\) \{\s*setDisplay\(\{ colorMode: 'tree_id' \}\);\s*setFilters\(\{ isolateTreeId: null \}\);\s*showCloud\(\);\s*\}/);
    // The summary is not gated — a transfer into another cloud still
    // reports how many points it labelled.
    expect(fn, 'the transfer summary is hidden for an unopened target')
      .toMatch(/setTransferResult\(res\);/);
  });

  it('warns on screen, not only in the dialog, that an unopened target waits', () => {
    // A user who transfers into a cloud that is not open sees nothing
    // change in the viewport. Without this line that is indistinguishable
    // from the transfer having silently done nothing.
    const step3 = panel.slice(panel.indexOf('3. Transfer labels'));
    expect(step3, 'nothing tells the user why the viewport did not change')
      .toMatch(/!sameDir\(targetDir, octree\?\.dir\)[\s\S]{0,120}?next time you open it/);
  });
});

/** The renderer died mid-build; the user pressed the crash page's reload
 *  and started the build again. The backend had never stopped — a
 *  renderer dying does not touch a spawn_blocking thread — so two
 *  builds, thirty-two threads, ran on a machine that had just run out
 *  of memory with one. And the second run's File::create wiped the
 *  log of the first: the only record of why it died. */
describe('one skeleton run at a time, and a log that outlives a crash', () => {
  const octree = stripComments(read('src-tauri/src/commands/octree.rs'));

  it('refuses a second build or transfer while one runs', () => {
    // The build and the transfer. The alignment between them claims a
    // stage of its own ("align") since it got a panel of its own — the
    // Cloud registration panel's Stop must not reach a build.
    expect((octree.match(/cancel::try_begin\("tst"\)/g) ?? []).length,
      'every tst command must claim the stage').toBe(2);
    // The guard rides inside the blocking closure, so it is released
    // when the run ends — however it ends. Five: the two tst commands,
    // the alignment, the centreline extraction and M3C2, which claim
    // their own stages the same way.
    expect((octree.match(/spawn_blocking\(move \|\| \{\s*let _run = run;/g) ?? []).length).toBe(5);
    expect(octree).toMatch(/cancel::try_begin\("align"\)/);
    expect(octree).toMatch(/cancel::try_begin\("centerlines"\)/);
    expect(octree).toMatch(/cancel::try_begin\("m3c2"\)/);
  });

  it('appends to skeletons.log instead of truncating it', () => {
    expect(octree).toMatch(/OpenOptions::new\(\)\.append\(true\)\.create\(true\)\.open\(&log_path\)/);
    expect(octree, 'the log is truncated again').not.toMatch(/File::create\(&log_path\)/);
    expect(octree, 'runs are not separated in the log').toMatch(/# run started, unix seconds/);
  });

  it('shows a run the page did not start, with a Stop', () => {
    const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
    expect(panel).toMatch(/octreeStageRunning/);
    expect(panel, 'the orphan run has no Stop').toMatch(/orphanRun && !busy[\s\S]{0,900}?onClick=\{\(\) => void cancelRun\(\)\}/);
    const cancel = stripComments(read('src-tauri/src/commands/cancel.rs'));
    expect(cancel, 'a run that panics would keep its stage claimed for ever')
      .toMatch(/impl Drop for RunGuard/);
  });
});
