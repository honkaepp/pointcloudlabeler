import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeHits, scanSources } from '../testing/sourceScan';
import { polygonToWkt, wktToPolygon } from './plotsStore';

type Ring = Array<[number, number]>;

/** Shoelace area. A polygon that lost a vertex is a different polygon,
 *  and this is the number that says by how much — it is also what every
 *  per-hectare figure divides by. */
function area(v: Ring): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const j = (i + 1) % v.length;
    s += v[i][0] * v[j][1] - v[j][0] * v[i][1];
  }
  return Math.abs(s) / 2;
}

const SQUARE: Ring = [[0, 0], [100, 0], [100, 100], [0, 100]];

describe('polygonToWkt', () => {
  it('writes a closed ring', () => {
    expect(polygonToWkt(SQUARE))
      .toBe('POLYGON((0 0, 100 0, 100 100, 0 100, 0 0))');
  });

  it('does not repeat a ring that already closes', () => {
    const closed: Ring = [...SQUARE, [0, 0]];
    expect(polygonToWkt(closed)).toBe(polygonToWkt(SQUARE));
  });

  it('refuses anything that is not a polygon', () => {
    expect(polygonToWkt([])).toBe('');
    expect(polygonToWkt([[0, 0]])).toBe('');
    expect(polygonToWkt([[0, 0], [1, 1]])).toBe('');
  });

  /** The defect. A non-finite vertex used to be written as the literal
   *  "NaN", which the reader then DROPPED — so a square came back as a
   *  triangle. Measured: a 100 m square with one unreadable corner read
   *  back at 5000 m² instead of 10 000, and every per-hectare figure
   *  divided by that area doubled. No error at either end. */
  it('refuses a polygon with an unmeasurable vertex, rather than writing NaN', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (const i of [0, 2, 3]) {
        const ring = SQUARE.map((v, k) => (k === i ? [bad, v[1]] : v)) as Ring;
        expect(polygonToWkt(ring), `${bad} at ${i}`).toBe('');
        const ringY = SQUARE.map((v, k) => (k === i ? [v[0], bad] : v)) as Ring;
        expect(polygonToWkt(ringY), `${bad} at ${i} (y)`).toBe('');
      }
    }
  });

  it('never writes "NaN" into a geometry', () => {
    const ring: Ring = [[0, 0], [1, NaN], [2, 2], [0, 3]];
    expect(polygonToWkt(ring)).not.toContain('NaN');
  });

  /** JavaScript writes a magnitude past 1e21, or below about 1e-7, as
   *  "1e+21" — which most WKT parsers reject, and the whole reason this
   *  format was chosen is that other GIS tools can read it. A plot
   *  boundary is metres to kilometres across, so such a coordinate is
   *  not a plot boundary: refused by the same rule as a non-finite one,
   *  rather than written as something no GIS will open. */
  it('never writes exponential notation', () => {
    for (const big of [1e21, 1e30, -1e25, 1e-9, 5e-324]) {
      const w = polygonToWkt([[big, 0], [big + 1, 0], [big + 1, 1]]);
      expect(w, String(big)).toBe('');
    }
    // …and everything at a plausible scale still writes.
    expect(polygonToWkt([[1e20, 0], [1e20 + 1, 0], [1e20 + 1, 1]])).not.toBe('');
  });

  it('keeps survey coordinates to the millimetre', () => {
    const w = polygonToWkt([[500123.456, 6800234.789], [500223.456, 6800234.789], [500223.456, 6800334.789]]);
    expect(w).toContain('500123.456 6800234.789');
  });

  it('writes a plain zero, not a negative one', () => {
    expect(polygonToWkt([[-0, -0], [1, 0], [1, 1]])).toContain('0 0');
    expect(polygonToWkt([[-0, -0], [1, 0], [1, 1]])).not.toContain('-0');
  });
});

describe('wktToPolygon', () => {
  it('reads back what it wrote, and drops the closing duplicate', () => {
    expect(wktToPolygon(polygonToWkt(SQUARE))).toEqual(SQUARE);
  });

  it('round-trips the area, which is what per-hectare figures divide by', () => {
    for (const ring of [
      SQUARE,
      [[0, 0], [10, 0], [10, 5], [5, 8], [0, 5]] as Ring,
      [[500000, 6800000], [500050, 6800000], [500050, 6800040], [500000, 6800040]] as Ring,
    ]) {
      expect(area(wktToPolygon(polygonToWkt(ring)))).toBeCloseTo(area(ring), 6);
    }
  });

  it('accepts the spacing and case a GIS might write', () => {
    for (const w of [
      'POLYGON((0 0, 1 0, 1 1, 0 0))',
      'polygon ( ( 0 0 , 1 0 , 1 1 , 0 0 ) )',
      '  POLYGON((0 0,1 0,1 1,0 0))  ',
    ]) {
      expect(wktToPolygon(w), w).toEqual([[0, 0], [1, 0], [1, 1]]);
    }
  });

  it('reads a 3D coordinate by its first two ordinates', () => {
    expect(wktToPolygon('POLYGON((0 0 12, 1 0 12, 1 1 13, 0 0 12))'))
      .toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  /** "POLYGON" is a substring of "MULTIPOLYGON". The unanchored pattern
   *  matched one and swallowed its extra opening bracket into the first
   *  coordinate, so a square came back as a four-point ring missing its
   *  first vertex — the right number of points, the wrong shape, no
   *  error. A multipolygon is not a single ring and must be refused. */
  it('does not half-read a MULTIPOLYGON', () => {
    expect(wktToPolygon('MULTIPOLYGON(((0 0, 100 0, 100 100, 0 100, 0 0)))')).toEqual([]);
    expect(wktToPolygon('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)),((5 5, 6 5, 6 6, 5 5)))')).toEqual([]);
  });

  /** A polygon with a hole is not a single ring either. Reading only
   *  its outer ring reports an area that includes the hole. */
  it('refuses a polygon with an interior ring', () => {
    expect(wktToPolygon('POLYGON((0 0, 10 0, 10 10, 0 0),(2 2, 3 2, 3 3, 2 2))')).toEqual([]);
  });

  /** One unreadable vertex makes the whole geometry unreadable. Keeping
   *  the rest gives a smaller polygon that looks perfectly valid — and
   *  an area, and a per-hectare figure, that are simply wrong. */
  it('refuses the whole polygon when one vertex will not parse', () => {
    for (const w of [
      'POLYGON((0 0, 100 0, NaN 100, 0 100, 0 0))',
      'POLYGON((0 0, 100 0, abc 100, 0 100, 0 0))',
      'POLYGON((0 0, 100 0, 100, 0 100, 0 0))',
      'POLYGON((0 0, 100 0, 1 2 3 4, 0 100, 0 0))',
      'POLYGON((0 0, 100 0, Infinity 100, 0 0))',
    ]) {
      expect(wktToPolygon(w), w).toEqual([]);
    }
  });

  /** Anchored at both ends. The unanchored pattern found a POLYGON
   *  anywhere in the string and ignored everything around it, so a
   *  truncated field, a concatenated one, or a geometry that merely
   *  CONTAINS a polygon all read as a bare ring — the right shape,
   *  taken out of the wrong geometry. */
  it('refuses a polygon with anything around it', () => {
    for (const w of [
      'POLYGON((0 0, 1 0, 1 1, 0 0)) and then some',
      'GEOMETRYCOLLECTION(POLYGON((0 0, 1 0, 1 1, 0 0)))',
      'xxPOLYGON((0 0, 1 0, 1 1, 0 0))',
      'SRID=3067;POLYGON((0 0, 1 0, 1 1, 0 0))',
    ]) {
      expect(wktToPolygon(w), w).toEqual([]);
    }
  });

  it('refuses anything that is not a polygon at all', () => {
    for (const w of [null, undefined, '', 'not wkt', 'POINT(1 2)',
      'LINESTRING(0 0, 1 1)', 'POLYGON', 'POLYGON(())']) {
      expect(wktToPolygon(w as string), String(w)).toEqual([]);
    }
  });

  it('does not drop a legitimate repeated interior vertex', () => {
    // Only the FIRST/LAST pair is a closing duplicate.
    const w = 'POLYGON((0 0, 1 0, 1 0, 1 1, 0 0))';
    expect(wktToPolygon(w)).toEqual([[0, 0], [1, 0], [1, 0], [1, 1]]);
  });
});

/** This module is superseded: the plot boundary is now a property of
 *  the dataset (plot.json beside the octree, written by
 *  PlotBoundaryPanel), and nothing touches the `plots` table. The two
 *  WKT converters are kept and tested so a revival is a correct one —
 *  and pinned, so whoever revives it learns the note has gone stale
 *  rather than believing an inert path is live. */
describe('what is reachable', () => {
  it('has no other user of the plots table', () => {
    const src = readFileSync('src/persistence/plotsStore.ts', 'utf8');
    expect(src).toMatch(/SUPERSEDED/);
  });

  /** The four storage functions reached the table through db_all /
   *  db_get / db_run, which ran SQL handed to them as a string. That is
   *  not a plots API, it is SQLite: ATTACH writes a database file at any
   *  absolute path and reads any the user can read. Reviving plot
   *  storage must not revive the bridge — a command per statement, with
   *  the SQL written in Rust, costs three commands and closes it. */
  it('reaches no generic SQL bridge', () => {
    for (const needle of ['dbAll', 'dbGet', 'dbRun', 'db_all', 'db_get', 'db_run']) {
      const hits = scanSources('src', needle);
      expect(hits, `the SQL passthrough is back:\n${describeHits(hits)}`).toEqual([]);
    }
    const handler = readFileSync(
      new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8');
    expect(handler).not.toMatch(/db_(all|get|run)/);
  });

  it('is still rendered with an empty plot list', () => {
    const inv = readFileSync('src/modules/InventoryModule.tsx', 'utf8');
    expect(inv).toContain('<TreeMap');
    expect(inv, 'TreeMap now receives real plots — is the SUPERSEDED note still true?')
      .toMatch(/plots=\{\[\]\}/);
  });
});
