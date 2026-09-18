import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  suggestMapping, applyMappingToHeader, applyColumnMapping,
  ROLE_INFO, type ColumnMapping,
} from './columnMapping';
import type { HeaderInfo } from './parser/headerDetect';
import type { ParsedCloud } from './parseTxtStream';

const NONE: ColumnMapping = {
  x: null, y: null, z: null, h: null,
  tree_id: null, semantic: null, classification: null,
};

function header(cols: string[], guesses: Partial<HeaderInfo> = {}): HeaderInfo {
  return {
    header: cols,
    sep: ' ',
    ix: 0, iy: 1, iz: 2, iId: -1,
    extraIdx: cols.map((_, i) => i).filter(i => i > 2),
    extraNames: cols.slice(3),
    hadHeader: true,
    headerBytes: 0,
    ...guesses,
  };
}

describe('suggestMapping', () => {
  it('finds the obvious positional columns', () => {
    const m = suggestMapping(['x', 'y', 'z', 'intensity']);
    expect(m.x).toBe('x');
    expect(m.y).toBe('y');
    expect(m.z).toBe('z');
  });

  it('matches column names case-insensitively', () => {
    const m = suggestMapping(['X', 'Y', 'Z', 'Classification']);
    expect([m.x, m.y, m.z]).toEqual(['X', 'Y', 'Z']);
    expect(m.classification).toBe('Classification');
  });

  /** Two different heights. `z` is elevation above sea level; `h` is
   *  height above ground. Putting a normalised height in the elevation
   *  role puts the whole cloud at ground level, and every absolute
   *  elevation PointCloudLabeler then reports is wrong by the terrain. */
  it('keeps an absolute elevation apart from a normalised height', () => {
    for (const hName of ['hag', 'agl', 'norm_z', 'z_norm', 'height_above_ground', 'chm']) {
      const m = suggestMapping(['x', 'y', 'z', hName]);
      expect(m.z, `${hName}: z`).toBe('z');
      expect(m.h, `${hName}: h`).toBe(hName);
    }
  });

  /** A file with a normalised height and NO absolute one: the height
   *  fills the above-ground role and the elevation role stays empty. Let
   *  it fill both and the cloud is treated as having an absolute Z that
   *  is really metres above the terrain — every elevation PointCloudLabeler reports
   *  is then wrong by the height of the ground under it, and the cloud
   *  is never re-based because it already looks normalised. */
  it('does not let a normalised height also become the elevation', () => {
    for (const hName of ['hag', 'agl', 'norm_z', 'z_norm', 'chm']) {
      const m = suggestMapping(['x', 'y', hName]);
      expect(m.h, `${hName}: h`).toBe(hName);
      expect(m.z, `${hName}: z`).toBeNull();
    }
  });

  /** A bare `h` with no `z` is the file's only vertical, so it fills the
   *  elevation role — matching what the parser does. It must not ALSO
   *  claim the above-ground role, or the cloud would be treated as
   *  already normalised and never re-based against the ground. */
  it('treats a bare h as the elevation when there is no z', () => {
    const m = suggestMapping(['x', 'y', 'h']);
    expect(m.z).toBe('h');
    expect(m.h).toBeNull();
  });

  /** Instance ids live in arbitrarily named columns — "id", "label",
   *  "preds_2024" — and a name guess was wrong as often as right,
   *  including on files that carried none. A wrong tree_id guess
   *  relabels every point in the cloud. */
  it('never guesses tree_id or semantic', () => {
    const m = suggestMapping(['x', 'y', 'z', 'tree_id', 'semantic', 'label', 'id']);
    expect(m.tree_id).toBeNull();
    expect(m.semantic).toBeNull();
  });

  it('leaves a role null when nothing matches', () => {
    const m = suggestMapping(['a', 'b', 'c']);
    expect(m).toEqual(NONE);
  });

  it('is empty-safe', () => {
    expect(suggestMapping([])).toEqual(NONE);
  });

  it('offers every role the dialog has a row for', () => {
    const m = suggestMapping(['x', 'y', 'z']);
    for (const r of ROLE_INFO) expect(Object.keys(m)).toContain(r.role);
    expect(ROLE_INFO.filter(r => r.required).map(r => r.role)).toEqual(['x', 'y']);
  });
});

describe('applyMappingToHeader', () => {
  it('reassigns the positional columns by name', () => {
    const h = header(['a', 'easting', 'northing', 'elev']);
    const out = applyMappingToHeader(h, { ...NONE, x: 'easting', y: 'northing', z: 'elev' });
    expect([out.ix, out.iy, out.iz]).toEqual([1, 2, 3]);
  });

  /** The defect. `indexOf` returning -1 used to fall through to the
   *  parser's auto-detected index, so naming a column the file does not
   *  have silently imported a DIFFERENT one: the user says "X is
   *  'easting'", the file has no 'easting', and the cloud loads from
   *  whatever was guessed — every coordinate plausible, none of them the
   *  ones asked for. */
  it('refuses a column the file does not have, rather than substituting one', () => {
    const h = header(['x', 'y', 'z']);
    for (const bad of [
      { ...NONE, x: 'easting', y: 'y', z: 'z' },
      { ...NONE, x: 'x', y: 'northing', z: 'z' },
      { ...NONE, x: 'x', y: 'y', z: 'elevation' },
      { ...NONE, x: 'x', y: 'y', z: 'z', tree_id: 'instance' },
    ]) {
      expect(() => applyMappingToHeader(h, bad)).toThrow(/does not have/);
    }
  });

  it('says which column it could not find, and what there was', () => {
    const h = header(['x', 'y', 'z', 'intensity']);
    try {
      applyMappingToHeader(h, { ...NONE, x: 'easting' });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('easting');
      expect(msg).toContain('intensity');    // the columns it does have
    }
  });

  /** A role the user did not assign is a different case: fall back to
   *  the parser's own guess, which is what the dialog opens pre-filled
   *  with anyway. */
  it('keeps the parser’s guess for a role left unassigned', () => {
    const h = header(['a', 'b', 'c'], { ix: 2, iy: 1, iz: 0 });
    const out = applyMappingToHeader(h, NONE);
    expect([out.ix, out.iy, out.iz]).toEqual([2, 1, 0]);
  });

  /** …but NOT for tree_id. Unmapped means "this file has no instance
   *  ids", not "guess one" — an id taken from a column that happens to
   *  hold integers would relabel every point in the cloud. */
  it('does not inherit a guessed tree_id when the role is unassigned', () => {
    const h = header(['x', 'y', 'z', 'anything'], { iId: 3 });
    expect(applyMappingToHeader(h, NONE).iId).toBe(-1);
    expect(applyMappingToHeader(h, { ...NONE, tree_id: 'anything' }).iId).toBe(3);
  });

  it('refuses a mapping with no vertical at all', () => {
    const h = header(['x', 'y'], { iz: -1 });
    expect(() => applyMappingToHeader(h, { ...NONE, x: 'x', y: 'y' }))
      .toThrow(/missing X, Y, or a vertical/);
  });

  /** With both, positions parse from the absolute Z so it stays
   *  available; with only H, from H. Getting this backwards puts the
   *  cloud at ground level and loses the elevation entirely. */
  it('parses positions from Z when the file has both Z and H', () => {
    const h = header(['x', 'y', 'z', 'hag']);
    const both = applyMappingToHeader(h, { ...NONE, x: 'x', y: 'y', z: 'z', h: 'hag' });
    expect(both.iz).toBe(2);
    const onlyH = applyMappingToHeader(h, { ...NONE, x: 'x', y: 'y', z: null, h: 'hag' });
    expect(onlyH.iz).toBe(3);
  });

  /** Every column that is not a position or an id stays an extra, under
   *  its own name. A column consumed twice — or dropped — shifts what
   *  each remaining name refers to. */
  it('keeps exactly the unconsumed columns as extras', () => {
    const h = header(['x', 'y', 'z', 'tid', 'intensity', 'echo']);
    const out = applyMappingToHeader(h, { ...NONE, x: 'x', y: 'y', z: 'z', tree_id: 'tid' });
    expect(out.extraNames).toEqual(['intensity', 'echo']);
    expect(out.extraIdx).toEqual([4, 5]);
    // Names and indices stay in step: extraIdx[k] must name extraNames[k].
    out.extraIdx.forEach((idx, k) => expect(h.header[idx]).toBe(out.extraNames[k]));
  });

  it('keeps the id column as an extra when tree_id is unmapped', () => {
    const h = header(['x', 'y', 'z', 'tid']);
    const out = applyMappingToHeader(h, { ...NONE, x: 'x', y: 'y', z: 'z' });
    expect(out.extraNames).toEqual(['tid']);
  });

  it('does not mutate the header it was given', () => {
    const h = header(['x', 'y', 'z', 'i']);
    const before = JSON.parse(JSON.stringify(h));
    applyMappingToHeader(h, { ...NONE, x: 'x', y: 'y', z: 'z' });
    expect(h).toEqual(before);
  });
});

describe('applyColumnMapping', () => {
  function cloud(extra: Record<string, number[] | string[]>, count: number): ParsedCloud {
    const names = Object.keys(extra);
    return {
      positions: new Float32Array(count * 3),
      treeIds: new Int32Array(count),
      extraCols: extra as ParsedCloud['extraCols'],
      columnOrder: ['x', 'y', 'z', ...names],
      columnSep: ' ',
      hadHeader: true,
      origin: { x: 0, y: 0, z: 0 },
      colIdx: { ix: 0, iy: 1, iz: 2, iId: -1, extraIdx: names.map((_, k) => 4 + k), extraNames: names },
      count,
    } as ParsedCloud;
  }

  it('moves a numeric extra into the instance ids and drops the column', () => {
    const c = cloud({ tid: [1, 2, 2, 7], intensity: [10, 20, 30, 40] }, 4);
    const out = applyColumnMapping(c, { ...NONE, tree_id: 'tid' });
    expect([...out.treeIds]).toEqual([1, 2, 2, 7]);
    expect(Object.keys(out.extraCols)).toEqual(['intensity']);
    expect(out.columnOrder).not.toContain('tid');
  });

  it('parses ids out of a text column', () => {
    const c = cloud({ tid: ['1', '2', ' 3 ', '4.6'] }, 4);
    const out = applyColumnMapping(c, { ...NONE, tree_id: 'tid' });
    expect([...out.treeIds]).toEqual([1, 2, 3, 5]);
  });

  /** An id that cannot be read is the UNASSIGNED bucket, which is what 0
   *  means — not a tree of its own, and not a crash. */
  it('makes an unreadable id unassigned', () => {
    const c = cloud({ tid: ['', 'n/a', 'NaN', '7'] }, 4);
    const out = applyColumnMapping(c, { ...NONE, tree_id: 'tid' });
    expect([...out.treeIds]).toEqual([0, 0, 0, 7]);
  });

  it('is a no-op when tree_id is unmapped or names no extra', () => {
    const c = cloud({ intensity: [1, 2] }, 2);
    expect(applyColumnMapping(c, NONE)).toBe(c);
    expect(applyColumnMapping(c, { ...NONE, tree_id: 'absent' })).toBe(c);
  });

  it('does not mutate the cloud it was given', () => {
    const c = cloud({ tid: [1, 2], intensity: [3, 4] }, 2);
    applyColumnMapping(c, { ...NONE, tree_id: 'tid' });
    expect(Object.keys(c.extraCols)).toEqual(['tid', 'intensity']);
    expect([...c.treeIds]).toEqual([0, 0]);
  });

  /** The names and the indices describe the same list and must stay in
   *  step: an index list that outlives a dropped name points every
   *  remaining extra at the wrong column. */
  it('keeps the extra names and indices in step after dropping the id column', () => {
    const c = cloud({ tid: [1], a: [2], b: [3] }, 1);
    const out = applyColumnMapping(c, { ...NONE, tree_id: 'tid' });
    expect(out.colIdx.extraNames).toEqual(['a', 'b']);
    expect(out.colIdx.extraIdx).toHaveLength(out.colIdx.extraNames.length);
    expect(out.colIdx.extraNames).toEqual(out.columnOrder.slice(3));
  });
});

/** This module is not on any route a user can take: the Rust importer
 *  took over conversion and ImportMappingDialog's one call site opens it
 *  in `scannerOnly` mode. It is kept and tested so that a revival is a
 *  correct revival — the same reason io/sceneAxes gives for keeping its
 *  own mapping. If that changes, this test is where someone finds out
 *  the note above it has gone stale. */
describe('what is reachable', () => {
  const files = [
    'src/modules/EditorModule.tsx',
    'src/components/ImportMappingDialog.tsx',
  ].map(f => readFileSync(f, 'utf8'));

  it('has no caller for the apply* functions', () => {
    for (const name of ['applyMappingToHeader', 'applyColumnMapping']) {
      for (const src of files) {
        expect(src.includes(name), `${name} now has a caller — is the note in columnMapping.ts still true?`).toBe(false);
      }
    }
  });

  it('opens the dialog in scannerOnly mode, which hides the role rows', () => {
    const editor = files[0];
    const uses = editor.split('<ImportMappingDialog').length - 1;
    expect(uses, 'more than one call site — check the mode of each').toBe(1);
    expect(editor).toMatch(/mode="scannerOnly"/);
  });
});
