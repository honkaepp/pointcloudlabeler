import { describe, it, expect } from 'vitest';
import { parseAsciiGrid } from './asciiGrid';

/** The exact shape `write_ascii_grid` (src-tauri/src/commands/octree.rs)
 *  emits: six header lines, then `nrows` rows NORTH FIRST, values as the
 *  shortest decimal that reads back as the same f32, non-finite cells as
 *  the declared sentinel.
 *
 *  This is one half of a contract whose other half is in Rust. Nothing
 *  can compile-check it, so both halves are pinned by literal samples —
 *  the Rust side by `ascii_grid_tests`, this side by the fixture below.
 *  If the writer ever changes format, one of the two fails. */
const GRID = [
  'ncols 3',
  'nrows 2',
  'xllcorner 500123.5',
  'yllcorner 6800234.25',
  'cellsize 0.5',
  'NODATA_value -9999',
  '30 31 -9999',   // north row
  '10 11 12',      // south row
  '',
].join('\n');

describe('parseAsciiGrid', () => {
  it('reads the header as the georeference', () => {
    const g = parseAsciiGrid(GRID);
    expect(g.cols).toBe(3);
    expect(g.rows).toBe(2);
    expect(g.cellSize).toBe(0.5);
    expect(g.minX).toBe(500123.5);
    expect(g.minY).toBe(6800234.25);
  });

  /** The file is north-first; the renderer's cell→world math wants
   *  row 0 to be the SOUTHERNMOST, because that is how the octree
   *  binned the cells in the first place ((wy − minY)/cell). A parser
   *  that forgot the flip would hand the viewer a terrain mirrored
   *  about its own east-west axis — which still looks like terrain,
   *  and still sits inside the right bounding box. */
  it('flips the file north-first into a south-first array', () => {
    const g = parseAsciiGrid(GRID);
    // Row 0 = south = the '10 11 12' line.
    expect(g.values[0]).toBe(10);
    expect(g.values[1]).toBe(11);
    expect(g.values[2]).toBe(12);
    // Row 1 = north.
    expect(g.values[3]).toBe(30);
    expect(g.values[4]).toBe(31);
  });

  it('turns the sentinel into NaN, not into ground at −9999 m', () => {
    const g = parseAsciiGrid(GRID);
    expect(g.values[5]).toBeNaN();
    expect(g.vmin).toBe(10);
    expect(g.vmax).toBe(31);
  });

  /** The writer emits full f32 precision precisely so the grid the
   *  viewer draws is the grid the analysis produced. Curvature and the
   *  dimensionless indices live at 1e-4 and below; a parser that
   *  rounded, or a writer that did, turns 18 % of a plan-curvature plot
   *  into exactly zero — an assertion that the ground there is planar. */
  it('keeps values a fixed three decimals would have destroyed', () => {
    const text = [
      'ncols 4', 'nrows 1', 'xllcorner 0', 'yllcorner 0',
      'cellsize 5', 'NODATA_value -9999',
      '0.0004621 -0.0004621 0.00001234 0.4918883', '',
    ].join('\n');
    const g = parseAsciiGrid(text);
    expect(g.values[0]).toBeCloseTo(0.0004621, 9);
    expect(g.values[1]).toBeCloseTo(-0.0004621, 9);
    expect(g.values[2]).toBeCloseTo(0.00001234, 11);
    expect(g.values[3]).toBeCloseTo(0.4918883, 7);
    // …and none of them collapsed to a single level.
    expect(new Set(Array.from(g.values)).size).toBe(4);
  });

  it('reads exponent notation, should another producer write it', () => {
    const text = [
      'ncols 2', 'nrows 1', 'xllcorner 0', 'yllcorner 0',
      'cellsize 1', 'NODATA_value -9999', '1.5e-4 -2E3', '',
    ].join('\n');
    const g = parseAsciiGrid(text);
    expect(g.values[0]).toBeCloseTo(1.5e-4, 10);
    expect(g.values[1]).toBe(-2000);
  });

  it('accepts the header spellings and spacing other tools write', () => {
    const text = [
      'NCOLS         2', 'NROWS         1', 'XLLCORNER     10',
      'YLLCORNER     20', 'CELLSIZE      2', 'NODATA_VALUE  -9999',
      '  1  2  ', '',
    ].join('\n');
    const g = parseAsciiGrid(text);
    expect([g.cols, g.rows, g.minX, g.minY, g.cellSize]).toEqual([2, 1, 10, 20, 2]);
    expect(Array.from(g.values)).toEqual([1, 2]);
  });

  it('handles CRLF line endings', () => {
    const g = parseAsciiGrid(GRID.split('\n').join('\r\n'));
    expect(Array.from(g.values.slice(0, 3))).toEqual([10, 11, 12]);
    expect(g.values[3]).toBe(30);
  });

  /** A NODATA_value other than −9999 is legal, and a grid that ignored
   *  the declared one would read the sentinel as an elevation — which
   *  is how a plot ends up with a 9999 m cliff in it. */
  it('honours a non-default NODATA_value', () => {
    const text = [
      'ncols 3', 'nrows 1', 'xllcorner 0', 'yllcorner 0',
      'cellsize 1', 'NODATA_value -32768', '1 -32768 3', '',
    ].join('\n');
    const g = parseAsciiGrid(text);
    expect(g.values[1]).toBeNaN();
    expect(g.vmin).toBe(1);
    expect(g.vmax).toBe(3);
  });

  /** A grid with nothing in it must not report an elevation range of
   *  ±Infinity — every consumer of vmin/vmax scales a colour ramp by
   *  it, and Infinity makes the whole layer one flat colour. */
  it('reports a usable range for an all-NoData grid', () => {
    const text = [
      'ncols 2', 'nrows 1', 'xllcorner 0', 'yllcorner 0',
      'cellsize 1', 'NODATA_value -9999', '-9999 -9999', '',
    ].join('\n');
    const g = parseAsciiGrid(text);
    expect(Number.isFinite(g.vmin) && Number.isFinite(g.vmax)).toBe(true);
    expect(g.values[0]).toBeNaN();
  });

  /** A truncated file — a write that ran out of disk, a partial read —
   *  must not silently present the rows it did get as if they were the
   *  whole grid, mapped to the wrong latitudes. The rows that ARE there
   *  keep their north-first meaning, so a file short by one row leaves
   *  the SOUTH row missing, not the north one. */
  it('leaves the missing part of a truncated grid as NoData', () => {
    const text = [
      'ncols 2', 'nrows 3', 'xllcorner 0', 'yllcorner 0',
      'cellsize 1', 'NODATA_value -9999', '5 6', '7 8', '',
    ].join('\n');
    const g = parseAsciiGrid(text);
    expect(g.values.length).toBe(6);
    expect(g.values[4]).toBe(5);   // north row still north
    expect(g.values[2]).toBe(7);
    expect(g.values[0]).toBeNaN(); // the south row never arrived
    expect(g.values[1]).toBeNaN();
  });

  it('survives an empty or headerless string', () => {
    for (const text of ['', '   ', 'not a grid at all']) {
      const g = parseAsciiGrid(text);
      expect(g.values.length, JSON.stringify(text)).toBe(0);
      expect(Number.isFinite(g.vmin)).toBe(true);
    }
  });

  /** THE HANG. The header loop advanced its line pointer but tested a
   *  cursor that only moves on a SUCCESSFUL header read, so a blank
   *  line with no newline after it made every pass slice the same empty
   *  string and `continue` — forever, on the UI thread, with no error
   *  and no way out of the app.
   *
   *  Both call sites read .asc files straight off disk, so any
   *  truncated write reaches it: a terrain run killed mid-write, a
   *  partial copy, a half-synced drive. Each case below spun past a
   *  million iterations before the fix; `expect` never ran because the
   *  test never returned. */
  it('terminates on a truncated or malformed header', () => {
    for (const text of [
      '   ',                       // whitespace only, no newline
      '\n',                        // one blank line
      '\n\n\n',                    // several
      'ncols 3\n\n',               // header, then a blank line at EOF
      'ncols 3\nnrows 2\n   ',     // header, then trailing spaces
      'ncols 3\nnrows 2',          // cut off mid-header, no newline
      '  \r\n  ',                  // blank CRLF lines
    ]) {
      const g = parseAsciiGrid(text);
      expect(g, JSON.stringify(text)).toBeTruthy();
      expect(Number.isFinite(g.vmin), JSON.stringify(text)).toBe(true);
    }
  });

  /** A partial header still yields whatever it declared, and safe
   *  defaults for what it did not — not a grid sized by a stale ncols. */
  it('reads a partial header without inventing the rest', () => {
    const g = parseAsciiGrid('ncols 3\nnrows 2\n');
    expect(g.cols).toBe(3);
    expect(g.rows).toBe(2);
    expect(g.cellSize).toBe(1);   // no cellsize declared
    expect(g.minX).toBe(0);
    expect(g.values.length).toBe(6);
    expect(Array.from(g.values).every(Number.isNaN)).toBe(true);
  });
});
