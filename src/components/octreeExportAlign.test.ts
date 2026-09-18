import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/** A cloud exported "loss-less" came back half a millimetre off the
 *  file it was imported from, every point the same way. The octree's
 *  offset was the bounding cube's corner — any number — so a source
 *  on its own millimetre grid re-quantised with one constant fraction.
 *  Loss-less has to mean loss-less against the FILE. */
describe('the octree grid is the source file\'s grid', () => {
  const octree = stripComments(read('src-tauri/src/commands/octree.rs'));

  it('quantises a LAS import on the file\'s own grid', () => {
    expect(octree, 'the import still puts the offset on the cube corner')
      .toMatch(/let \(scale, offset\) = choose_quantisation\(bbox, Some\(&src_grid\)\);/);
    expect(octree, 'the offset is not moved onto the source grid')
      .toMatch(/offset\[axis\] = o_src \+ steps \* scale\[axis\];/);
    expect(octree, 'the source grid is not recorded in the metadata')
      .toMatch(/record_source_grid\(&out_path, &src_grid\)\?;/);
  });

  it('can move an old dataset back onto its file\'s grid without a re-import', () => {
    expect(octree, 'no realignment command').toMatch(/pub fn octree_realign_to_source\(/);
    expect(octree, 'the realignment rounds the offset to the source grid')
      .toMatch(/let steps = \(\(offset\[axis\] - src\.offset\[axis\]\) \/ s\)\.round\(\);/);
    expect(octree, 'a file from another plot would be accepted').toMatch(/does not look like this dataset.s source/);
    const lib = read('src-tauri/src/lib.rs');
    expect(lib, 'the command is not registered').toMatch(/octree::octree_realign_to_source,/);
    const bridge = stripComments(read('src/persistence/desktopBridge.ts'));
    expect(bridge, 'the bridge does not expose it').toMatch(/'octree_realign_to_source', \{ octreeDir, lasPath \}/);
    const dialog = stripComments(read('src/components/OctreeExportDialog.tsx'));
    expect(dialog, 'the export dialog does not offer it').toMatch(/Align to source LAS/);
    expect(dialog, 'the dialog does not say how far the points moved').toMatch(/Moved onto the source grid: X \$\{mm\[0\]\} mm/);
    const editor = stripComments(read('src/modules/EditorModule.tsx'));
    expect(editor, 'the dialog is not told which dataset it exports').toMatch(/octreeDir=\{exportTarget\.dir\}/);
  });
});
