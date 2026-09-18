import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';

const read = (p: string) => stripComments(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));

/** Five panels take a click in the viewport and hand it to a backend
 *  command that works in survey coordinates: the virtual caliper,
 *  click-to-measure, the scan-inspection viewpoint, the plot-boundary
 *  centre. The viewport's pick is a SCENE point, and it was handed over
 *  as it was — so a stem clicked at scene (47, 21, −30) was looked for
 *  at easting 47, northing 21, elevation −30, and every one of them
 *  found nothing. The conversion happens once, where the click is
 *  routed, so no panel can forget it. */
describe('the world picker', () => {
  const view = read('src/three/OctreeView.tsx');

  it('hands panels the pick in survey coordinates, not scene coordinates', () => {
    expect(view).toMatch(/if \(hit\) worldPicker\(sceneToWorld\(hit, sceneOffset\)\);/);
    expect(view, 'the raw scene pick still reaches a panel').not.toMatch(/if \(hit\) worldPicker\(hit\);/);
    // …with the dataset's own origin, passed in from where it is known.
    expect(view).toMatch(/sceneOffset=\{octree\.meta\.offset\}/);
    expect(view).toMatch(/import \{[^}]*sceneToWorld[^}]*\} from '\.\.\/io\/sceneAxes'/);
  });

  it('is what every click-driven panel goes through', () => {
    for (const f of ['CaliperPanel', 'TreeHandlePanel', 'ScanInspectionPanel', 'PlotBoundaryPanel']) {
      expect(read(`src/components/shell/${f}.tsx`), `${f} does not use the world picker`).toMatch(/setWorldPicker\(/);
    }
  });
});

/** The other panels that did nothing, and why. */
describe('the panels that did nothing', () => {
  it('Point QC reads its command from the desktop bridge, not the viewer api', () => {
    const qc = read('src/components/shell/PointQcPanel.tsx');
    expect(qc).toMatch(/const desktop = \(window as unknown as \{ desktop\?: \{/);
    expect(qc, 'still casts the viewer api to the bridge').not.toMatch(/api as unknown as/);
    // …and the button says so when the command is missing, rather than
    // being enabled and doing nothing.
    expect(qc).toMatch(/disabled=\{running \|\| !octree\?\.dir \|\| !desktop\?\.octreePointQc\}/);
  });

  it('the slab panel fits the panel that hosts it', () => {
    // 400 px of content in a 400 px panel, plus padding, overflowed it —
    // the frame button was cut in half and the body no longer sat on
    // the panel's background.
    const slab = read('src/components/shell/SlabPanel.tsx');
    expect(slab).not.toMatch(/minWidth: 400/);
    expect(read('src/components/shell/EditorShell.tsx')).toMatch(/id="slab" title="Cross-section slab" width=\{400\}/);
  });

  it('centreline extraction reports progress and can be stopped, and keeps what it fitted', () => {
    const panel = read('src/components/shell/StemCenterlinePanel.tsx');
    expect(panel).toMatch(/if \(e\.stage === 'centerlines'\) setPct\(e\.pct\)/);
    expect(panel).toMatch(/desktop\.octreeCancel\('centerlines'\)/);
    expect(panel).toMatch(/\{stopping \? 'Stopping…' : 'Cancel'\}/);
    expect(panel).toMatch(/Extracting centrelines \(\$\{\(pct \* 100\)\.toFixed\(0\)\} %\)…/);
    const rust = readFileSync(new URL('../../src-tauri/src/commands/octree.rs', import.meta.url), 'utf8');
    expect(rust).toMatch(/cancel::try_begin\("centerlines"\)/);
    expect(rust).toMatch(/cancel::token\("centerlines"\)/);
    expect(rust).toMatch(/emit_progress\(window, "centerlines", 0\.35 \+ 0\.65 \* i as f32 \/ n_trees as f32\)/);
    // A stop between trees returns the trees already fitted, flagged.
    expect(rust).toMatch(/if crate::commands::cancel::stopped\(&cancel\) \{ stopped = true; break; \}/);
    expect(rust).toMatch(/Ok\(StemCenterlineResult \{ trees: out, stopped \}\)/);
  });
});
