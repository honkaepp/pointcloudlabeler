import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import { normalizeDir, sameDir, findDir } from './datasetDirs';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

/** The list spells a dataset's folder as the OS does, the importer as
 *  the JS did; a `===` between the two called one dataset two. */
describe('one dataset directory, two spellings', () => {
  it('names the same folder through separators, case, a trailing slash and a verbatim prefix', () => {
    expect(sameDir('C:\\Users\\eppu\\plot\\octrees\\Evo', 'C:/Users/eppu/plot/octrees/Evo')).toBe(true);
    expect(sameDir('C:\\Users\\eppu\\plot/octrees/Evo', 'C:\\Users\\eppu\\plot\\octrees\\Evo')).toBe(true);
    expect(sameDir('c:/users/eppu/plot/octrees/evo/', 'C:/Users/eppu/plot/octrees/Evo')).toBe(true);
    expect(sameDir('\\\\?\\C:\\plot\\octrees\\Evo', 'C:/plot/octrees/Evo')).toBe(true);
    expect(sameDir('C:/plot/octrees/Evo', 'C:/plot/octrees/Evo2')).toBe(false);
    expect(sameDir('', 'C:/plot/octrees/Evo')).toBe(false);
    expect(sameDir(undefined, null)).toBe(false);
    expect(normalizeDir('/')).toBe('/');
  });

  it('finds the list entry by name, exact spelling first', () => {
    const list = [{ dir: 'C:\\p\\octrees\\A', name: 'A' }, { dir: 'C:\\p\\octrees\\B', name: 'B' }];
    expect(findDir(list, 'C:/p/octrees/B')?.name).toBe('B');
    expect(findDir(list, 'C:\\p\\octrees\\A')?.name).toBe('A');
    expect(findDir(list, 'C:/p/octrees/C')).toBeUndefined();
    expect(findDir(list, '')).toBeUndefined();
  });

  it('the importer opens the dataset under the list’s spelling, and the transfer panel compares by name', () => {
    const editor = stripComments(read('src/modules/EditorModule.tsx'));
    expect(editor, 'the freshly converted cloud is opened under the importer’s spelling').toMatch(/openOctree\(listed\?\.dir \?\? res\.outDir\)/);
    const panel = stripComments(read('src/components/shell/SkeletonTransferPanel.tsx'));
    expect(panel, 'the target list still filters the baseline by ===').toMatch(/octreeList\.filter\(\(e\) => !sameDir\(e\.dir, baselineDir\)\)/);
    expect(panel, 'a dataset is still compared to the open cloud by ===').not.toMatch(/=== octree\?\.dir|octree\?\.dir ===/);
    expect(panel, 'the baseline defaults to a spelling the list may not have').toMatch(/setBaselineDir\(findDir\(baselineCandidates, octree\?\.dir\)\?\.dir \?\? baselineCandidates\[0\]\.dir\);/);
    // The height-frame choice shows whenever a target is chosen — not
    // only when both entries were found and the guess said mismatch.
    expect(panel).toMatch(/\{targetDir && \(\s*<div className="flex flex-col gap-1">\s*\{baselineEntry && targetEntry && frameSuggestion\.mismatch && \(/);
  });
});
