import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';
import { HEIGHT_MODE_KEY, HEIGHT_MODES, parseHeightMode } from './heightMode';
import { DEFAULT_DISPLAY } from './OctreeShellContext';

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

/** One master switch for how every view draws heights: as stored, or as
 *  height above the classified ground. It lives in the Display panel,
 *  reaches every viewport through DisplayConfig, and holds across
 *  restarts like the other Display choices that matter. */
describe('the height mode switch', () => {
  it('is "as stored" unless it says above ground, and stored by default', () => {
    expect(parseHeightMode('above_ground')).toBe('above_ground');
    expect(parseHeightMode('stored')).toBe('stored');
    expect(parseHeightMode('elevation')).toBe('stored');
    expect(parseHeightMode(null)).toBe('stored');
    expect(DEFAULT_DISPLAY.heightMode).toBe('stored');
    expect(HEIGHT_MODES.map((m) => m.id)).toEqual(['stored', 'above_ground']);
  });

  it('is offered in the Display panel, kept by the shell, and mirrored to settings.json', () => {
    const panel = stripComments(read('src/components/shell/DisplayPanel.tsx'));
    expect(panel, 'the Display panel has no Heights control').toMatch(/HEIGHT_MODES\.map\(/);
    expect(panel, 'the control does not set the display').toMatch(/setDisplay\(\{ heightMode: m\.id \}\)/);
    const shell = stripComments(read('src/components/shell/EditorShell.tsx'));
    expect(shell, 'the shell starts from the default rather than the saved mode').toMatch(/heightMode: readHeightMode\(\)/);
    expect(shell, 'a change is not saved').toMatch(/if \(patch\.heightMode\) writeHeightMode\(patch\.heightMode\);/);
    const store = read('src/persistence/settingsStore.ts');
    expect(store, 'the key is not mirrored to settings.json').toContain(`'${HEIGHT_MODE_KEY}'`);
  });
});
