import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string) => readFileSync(p, 'utf8');

/** The Branches panel's pieces live in seven files that never meet at
 *  compile time: a panel id in a union, a registration in the shell, a
 *  toggle in the activity bar, a native menu item and its table entry,
 *  the shell → viewer props, and a bridge command per direction. Each
 *  one forgotten compiles and leaves part of the feature unreachable. */
describe('the Branches panel is wired in everywhere it has to be', () => {
  it('is a panel of its own, reachable like the others', () => {
    expect(read('src/components/shell/OctreeShellContext.tsx')).toMatch(/\| 'branches' \|/);
    const shell = read('src/components/shell/EditorShell.tsx');
    expect(shell).toMatch(/import BranchPanel from '\.\/BranchPanel';/);
    expect(shell).toMatch(/<FloatingPanel id="branches" title="Branches"[\s\S]*?>\s*<BranchPanel \/>/);
    expect(shell).toMatch(/panel\('branches', 'Toggle Branches panel'\);/);
    expect(read('src/components/shell/ActivityBar.tsx')).toMatch(/<PanelToggle id="branches"/);
    expect(read('src/components/shell/menuActions.ts')).toMatch(/'panel-branches': panel\('branches'\),/);
    expect(read('src-tauri/src/menu.rs')).toMatch(/"Branches…", "panel-branches"/);
  });

  it('the Stems panel too', () => {
    expect(read('src/components/shell/OctreeShellContext.tsx')).toMatch(/\| 'stems' \|/);
    const shell = read('src/components/shell/EditorShell.tsx');
    expect(shell).toMatch(/import StemPanel from '\.\/StemPanel';/);
    expect(shell).toMatch(/<FloatingPanel id="stems" title="Stems"[\s\S]*?>\s*<StemPanel \/>/);
    expect(shell).toMatch(/panel\('stems', 'Toggle Stems panel'\);/);
    expect(read('src/components/shell/ActivityBar.tsx')).toMatch(/<PanelToggle id="stems"/);
    expect(read('src/components/shell/menuActions.ts')).toMatch(/'panel-stems': panel\('stems'\),/);
    expect(read('src-tauri/src/menu.rs')).toMatch(/"Stems…", "panel-stems"/);
  });

  it('both panels read diameters with the one shared section reader', () => {
    for (const f of ['BranchPanel', 'StemPanel']) {
      const src = read(`src/components/shell/${f}.tsx`);
      expect(src).toMatch(/<SectionReader read=\{read\} setRead=\{setRead\} reading=\{reading\}/);
      expect(src).toMatch(/useReading\(read, mode, trim\)/);
    }
    // The stem is followed up from its foot, never found by a centroid.
    expect(read('src/components/shell/StemPanel.tsx')).toMatch(/trackStem\(p\.xyz,/);
  });

  it('hands the viewer the marks and the measurement graphics, and the streamer the marks', () => {
    const shell = read('src/components/shell/EditorShell.tsx');
    expect(shell).toMatch(/branchMarks=\{branchMarks\}\s*branchOverlay=\{branchOverlay\}/);
    const view = read('src/three/OctreeView.tsx');
    expect(view).toMatch(/<BranchMeasureOverlay overlay=\{branchOverlay\}/);
    expect(view).toMatch(/branchMarks=\{branchMarks\}\s*\/>/);
    // Every node a streamer loads carries its marks holder, so a node
    // streamed in after a branch was cut comes in painted.
    expect(view).toMatch(/branchRef: shared\.branch,/);
    // …and colorNode paints them on every path that colours a node.
    expect(view).toMatch(/paintBranches\(ln\);/);
  });

  it('reads and writes branches.json through the bridge, and Rust knows both commands', () => {
    const bridge = read('src/persistence/desktopBridge.ts');
    expect(bridge).toMatch(/ctx\.invoke<string>\('octree_read_branches', \{ octreeDir \}\)/);
    expect(bridge).toMatch(/ctx\.invoke<null>\('octree_write_branches', \{ octreeDir, json \}\)/);
    const lib = read('src-tauri/src/lib.rs');
    expect(lib).toMatch(/octree::octree_read_branches,/);
    expect(lib).toMatch(/octree::octree_write_branches,/);
  });

  it('a rebuilt dataset loses its branches with the other sidecars, and dataset.info lists the file', () => {
    expect(read('src-tauri/src/commands/octree.rs')).toMatch(/"plot\.json", "branches\.json"\] \{\n\s*let p = out_dir\.join\(name\);/);
    expect(read('src-tauri/src/ops/project.rs')).toMatch(/"branches\.json"/);
  });
});
