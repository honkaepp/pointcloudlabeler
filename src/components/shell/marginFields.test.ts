import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';
import { editReach, relinkReach, cleanReach } from './marginFields';

const read = (p: string) => stripComments(readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8'));

/** Tree Review's margin control. Six fields that moved together while
 *  "same" was on read as six broken fields, and the "same" flag lived in
 *  the control, which is mounted only during isolation — so it came back
 *  on every time isolation was re-entered, and W widened every direction
 *  again. The arithmetic is pinned here, and the flag's home. */
describe('the isolate margin control', () => {
  it('changes one direction when unlinked and all six when linked', () => {
    expect(editReach([2, 2, 2, 2, 2, 2], false, 1, 5)).toEqual([2, 5, 2, 2, 2, 2]);   // east only
    expect(editReach([2, 2, 2, 2, 2, 2], false, 4, 3)).toEqual([2, 2, 2, 2, 3, 2]);   // down only
    expect(editReach([2, 2, 2, 2, 2, 2], true, 1, 5)).toEqual([5, 5, 5, 5, 5, 5]);
    // A scalar or an axis triple from an older caller is widened per direction too.
    expect(editReach(2, false, 3, 7)).toEqual([2, 2, 2, 7, 2, 2]);
    expect(editReach([1, 2, 3], false, 0, 9)).toEqual([9, 1, 2, 2, 3, 3]);
  });

  it('never stores a negative or non-finite reach, and ignores an out-of-range direction', () => {
    expect(cleanReach(-3)).toBe(0);
    expect(cleanReach(NaN)).toBe(0);
    expect(editReach([1, 1, 1, 1, 1, 1], false, 2, -4)).toEqual([1, 1, 0, 1, 1, 1]);
    expect(editReach([1, 1, 1, 1, 1, 1], false, 9, 4)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('re-linking puts the west value everywhere', () => {
    expect(relinkReach([3, 5, 0, 1, 2, 4])).toEqual([3, 3, 3, 3, 3, 3]);
  });

  it('keeps whether the reaches are linked in the filter state, not in the control', () => {
    const ctx = read('src/components/shell/OctreeShellContext.tsx');
    expect(ctx).toMatch(/isolateMarginLinked: boolean;/);
    expect(ctx).toMatch(/isolateMarginLinked: true,/);
    const panel = read('src/components/shell/TreeReviewPanel.tsx');
    expect(panel).toMatch(/linked=\{filters\.isolateMarginLinked\}/);
    expect(panel, 'a local linked flag resets whenever isolation is re-entered')
      .not.toMatch(/useState\(isUniformReach/);
  });

  it('shows one field while linked and six while not', () => {
    const panel = read('src/components/shell/TreeReviewPanel.tsx');
    const fn = panel.slice(panel.indexOf('function MarginFields('));
    const body = fn.slice(0, fn.indexOf('\nfunction ', 10));
    expect(body).toMatch(/if \(linked\) \{[\s\S]*field\(0, 'all'/);
    for (const i of [0, 1, 2, 3, 4, 5]) {
      expect(body).toMatch(new RegExp(`field\\(${i}, DIRECTION_LABELS\\[${i}\\], DIRECTION_TITLES\\[${i}\\]\\)`));
    }
    expect(body).toMatch(/editReach\(value, linked, i, parseFloat\(e\.target\.value\)\)/);
    // Re-linking goes through the same arithmetic as the test above.
    expect(panel).toMatch(/isolateMargin: relinkReach\(filters\.isolateMargin\)/);
  });
});
