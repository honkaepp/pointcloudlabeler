import { describe, it, expect } from 'vitest';
import { DEFAULT_FILTERS, type FilterConfig } from './shell/OctreeShellContext';
import { buildExportFilter, describeActiveFilters } from './OctreeExportDialog';

/** No constraint active — the app's own default, not a hand-rolled copy
 *  of it. A local copy would drift as fields are added, and would go on
 *  passing while the real default started sending something. */
function none(): FilterConfig {
  return structuredClone(DEFAULT_FILTERS);
}

/** Each constraint the export honours, one at a time. Anything added to
 *  `buildExportFilter` without being added here shows up as a coverage
 *  gap in the agreement test below. */
const CONSTRAINTS: { name: string; apply: (f: FilterConfig) => void }[] = [
  { name: 'hideUnassigned', apply: f => { f.hideUnassigned = true; } },
  { name: 'isolateTreeId', apply: f => { f.isolateTreeId = 42; } },
  { name: 'treeIdRange', apply: f => { f.treeIdRange = [1, 99]; } },
  { name: 'hiddenClasses', apply: f => { f.hiddenClasses = [2]; } },
  { name: 'hiddenSemantic', apply: f => { f.hiddenSemantic = [0]; } },
  { name: 'hiddenReturns', apply: f => { f.hiddenReturns = [3]; } },
  { name: 'hideStandingDeadwood', apply: f => { f.hideStandingDeadwood = true; } },
  { name: 'hideLayingDeadwood', apply: f => { f.hideLayingDeadwood = true; } },
  { name: 'onlyDeadwood', apply: f => { f.onlyDeadwood = true; } },
  { name: 'xRange', apply: f => { f.xRange = [0, 10]; } },
  { name: 'yRange', apply: f => { f.yRange = [0, 10]; } },
  { name: 'zRange', apply: f => { f.zRange = [0, 30]; } },
  { name: 'intensityRange', apply: f => { f.intensityRange = [10, 200]; } },
  { name: 'extraRange', apply: f => { f.extraRange = { name: 'height_above_ground', lo: 2, hi: 30 }; } },
];

describe('export filter', () => {
  it('sends nothing when nothing is active, so the default export is unchanged', () => {
    expect(buildExportFilter(none())).toBeUndefined();
    expect(describeActiveFilters(none())).toEqual([]);
  });

  /** The invariant that matters. The checkbox shows the user a list of
   *  what "export what the filters show" will apply; the payload is what
   *  it actually applies. If one can be non-empty while the other is
   *  empty, the dialog is describing an export it is not performing —
   *  either silently dropping a constraint the user was promised, or
   *  applying one they were never told about. */
  it.each(CONSTRAINTS)('$name is both described and sent', ({ apply }) => {
    const f = none();
    apply(f);
    expect(describeActiveFilters(f).length, 'active but not described').toBeGreaterThan(0);
    expect(buildExportFilter(f), 'described but not sent').toBeDefined();
  });

  it('describes exactly as many constraints as are active', () => {
    const f = none();
    for (const c of CONSTRAINTS) c.apply(f);
    expect(describeActiveFilters(f).length).toBe(CONSTRAINTS.length);
  });

  /** The panel exposes a HIDE-list; the backend predicate takes a
   *  KEEP-list. Getting the complement backwards would export exactly
   *  the points the user was hiding — a mistake with no visible symptom
   *  short of opening the file. */
  it('converts hidden classes into a keep-list, not a hide-list', () => {
    const f = none();
    f.hiddenClasses = [2, 7];
    const out = buildExportFilter(f)!;
    expect(out.classes).toBeDefined();
    expect(out.classes!.includes(2), 'a hidden class must NOT be kept').toBe(false);
    expect(out.classes!.includes(7)).toBe(false);
    expect(out.classes!.includes(1), 'an unhidden class must be kept').toBe(true);
    expect(out.classes!.length).toBe(254); // 256 codes minus the two hidden
  });

  it('passes ranges through unchanged — a silently widened range exports too much', () => {
    const f = none();
    f.zRange = [1.5, 28.25];
    f.intensityRange = [10, 200];
    const out = buildExportFilter(f)!;
    expect(out.zRange).toEqual([1.5, 28.25]);
    expect(out.intensityRange).toEqual([10, 200]);
  });

  it('carries an extra-column range under its own name', () => {
    const f = none();
    f.extraRange = { name: 'height_above_ground', lo: 2, hi: 30 };
    const out = buildExportFilter(f)!;
    expect(out.extraRanges).toEqual([{ name: 'height_above_ground', min: 2, max: 30 }]);
  });

  /** The cross-section slab used to be grouped with the view-dependent
   *  aids below and left out of the export, so cutting a section and
   *  exporting what the filters show returned the whole cloud. It is not
   *  the same kind of thing: a slab is a static predicate on a point's
   *  world position, no different from the X/Y/Z ranges that always
   *  travelled, except for its orientation. */
  it('sends the cross-section slab, and names it in the will-apply list', () => {
    const f = none();
    f.planeSlab = { anchor: [1, 2, 3], normal: [0, 0, 1], halfHeight: 0.25 };
    const out = buildExportFilter(f);
    expect(out, 'a slab alone must be enough to make the export filtered').toBeDefined();
    expect(out!.planeSlab).toEqual({ anchor: [1, 2, 3], normal: [0, 0, 1], halfHeight: 0.25 });
    // Half-height 0.25 m is a 50 cm cut.
    expect(describeActiveFilters(f)).toEqual(['cross-section 50 cm thick']);
  });

  /** These are view-dependent — they answer "what can I see from here",
   *  which no file can encode — and the dialog discloses that they do not
   *  travel. If one ever started reaching the payload, the export would
   *  quietly stop matching the documented behaviour. */
  it('does not send the isolate-neighbourhood opt-in', () => {
    const f = none();
    f.isolateShowUnassigned = true;
    expect(buildExportFilter(f), 'a viewport-only aid must not reach the export').toBeUndefined();
    expect(describeActiveFilters(f)).toEqual([]);
  });
});
