import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';
import {
  ALIGN_STAGE, alignStageLabel, confidenceVerdict, describeShift, halfExtent,
  isWorthMoving, rotationAtEdge, shiftOntoReference,
} from './registration';

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

/** Two clouds of one plot, metres apart, and every pairing tool
 *  assuming they sit on each other. The measurement (skelalign.rs) and
 *  the lossless georeference shift existed, tested, with no panel: a
 *  user had no way to run either. The Cloud registration panel is that
 *  way, on its own — the transfer panel labels, this one moves clouds. */
describe('the registration arithmetic', () => {
  it('moves the target by the inverse of what was measured from the skeletons onto it', () => {
    expect(shiftOntoReference({ dx: 12.2, dy: -3.1 })).toEqual([-12.2, 3.1]);
  });

  it('reads the coarse vote\u2019s peak ratio as a verdict', () => {
    expect(confidenceVerdict(1.8).label).toBe('unambiguous');
    expect(confidenceVerdict(Infinity).label).toBe('unambiguous');
    expect(confidenceVerdict(1.15).label).toMatch(/likely/);
    expect(confidenceVerdict(1.02).label).toMatch(/guess/);
  });

  it('puts a rotation the shift cannot carry at the plot\u2019s edge, as a distance', () => {
    // A 60 × 60 m plot: half the diagonal is 42.4 m; 0.5° there is 37 cm.
    const r = halfExtent([100, 200, 0], [160, 260, 30]);
    expect(r).toBeCloseTo(42.43, 2);
    expect(rotationAtEdge(0.5 * Math.PI / 180, r)).toBeCloseTo(0.370, 3);
    expect(rotationAtEdge(-0.5 * Math.PI / 180, r)).toBeCloseTo(0.370, 3);
  });

  it('does not call a millimetre a move', () => {
    expect(isWorthMoving(0.0004, 0.0004)).toBe(false);
    expect(isWorthMoving(0.01, 0)).toBe(true);
    expect(isWorthMoving(NaN, 1)).toBe(false);
  });

  it('describes a shift with its signs and its length', () => {
    expect(describeShift(12.2, -3.1)).toBe('+12.20 m east, \u22123.10 m north (12.59 m)');
  });

  it('labels the run\u2019s stages at the milestones the Rust side reports', () => {
    expect(alignStageLabel(0.01)).toMatch(/skeletons/);
    expect(alignStageLabel(0.3)).toMatch(/target/);
    expect(alignStageLabel(0.7)).toMatch(/Voting/);
    expect(alignStageLabel(0.95)).toMatch(/Refining/);
  });
});

describe('the Cloud registration panel', () => {
  const panel = stripComments(read('src/components/shell/RegistrationPanel.tsx'));
  const rust = stripComments(read('src-tauri/src/commands/octree.rs'));

  it('is a panel of its own, reachable like the others', () => {
    expect(read('src/components/shell/OctreeShellContext.tsx')).toMatch(/\| 'register';/);
    const shell = read('src/components/shell/EditorShell.tsx');
    expect(shell).toMatch(/import RegistrationPanel from '\.\/RegistrationPanel';/);
    expect(shell).toMatch(/<FloatingPanel id="register" title="Cloud registration"[\s\S]*?>\s*<RegistrationPanel \/>/);
    expect(shell).toMatch(/panel\('register', 'Toggle Cloud registration panel'\);/);
    expect(read('src/components/shell/ActivityBar.tsx')).toMatch(/<PanelToggle id="register"/);
  });

  it('measures through the bridge, on the alignment\u2019s own stage, with a Stop', () => {
    expect(panel).toMatch(/desktop\.octreeSkeletonAlign\(referenceDir, targetDir, \{/);
    expect(panel).toMatch(/if \(stage === ALIGN_STAGE\) setPct\(p\);/);
    expect(panel).toMatch(/cancelStage\(ALIGN_STAGE\)/);
    expect(ALIGN_STAGE).toBe('align');
    // The Rust side claims and reports the same stage, and a stop
    // leaves nothing half-written: the file goes down at the end.
    expect(rust).toMatch(/cancel::try_begin\("align"\)/);
    expect(rust).toMatch(/cancel::token\("align"\)/);
    const run = rust.slice(rust.indexOf('fn run_skeleton_align('), rust.indexOf('fn chrono_like_now('));
    expect((run.match(/emit_progress\(window, "align",/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((run.match(/if crate::commands::cancel::stopped\(&cancel\) \{ return Err\("Stopped — nothing was changed\."\.to_string\(\)\); \}/g) ?? []).length).toBe(2);
    expect(run.indexOf('write_file_atomic(&t_dir.join(ALIGNMENT_FILE)')).toBeGreaterThan(run.lastIndexOf('cancel::stopped'));
  });

  it('moves the target by the inverse, reopens it if it is the open cloud, and can undo', () => {
    expect(panel).toMatch(/const remaining = alignment \? shiftOntoReference\(alignment\) : null;/);
    expect(panel).toMatch(/desktop\.octreeShiftGeoreference\(targetDir, dx, dy, why\)/);
    expect(panel).toMatch(/if \(targetIsOpen\) await saveOpenIfNeeded\(\);/);
    expect(panel).toMatch(/await refreshDatasets\?\.\(\);\s*if \(targetIsOpen\) await reloadActiveOctree\?\.\(\);/);
    expect(panel).toMatch(/void shift\(-moved\[0\], -moved\[1\], 'undo the move onto the reference'\);/);
    expect(panel).toMatch(/desktop\.octreeSkeletonAlignmentClear\(targetDir\)/);
    // Skeletons drawn in the old frame come off when the frame moves.
    expect(panel).toMatch(/if \(skeletonOverlay\) setSkeletonOverlay\(null\);/);
  });

  it('shows the skeletons through the alignment, live, and opens the Compare through it', () => {
    expect(panel).toMatch(/alignment: viaAlignment && alignment \? param\(alignment\) : null,/);
    expect(panel).toMatch(/setSkeletonOverlay\(\{ \.\.\.skeletonOverlay, alignment: on && alignment \? param\(alignment\) : null \}\);/);
    expect(panel).toMatch(/alignment: through && alignment \? param\(alignment\) : null,\s*\}\);/);
    expect(panel).toMatch(/showSkeleton: ok, skeletonColor: 'tree'/);
  });

  it('says what the shift cannot do — rotate — and by how much', () => {
    expect(panel).toMatch(/rotationAtEdge\(alignment\.theta, halfExtent\(targetEntry\.bboxMin, targetEntry\.bboxMax\)\)/);
    expect(panel).toMatch(/is not applied — a georeference shift is a translation/);
  });
});
