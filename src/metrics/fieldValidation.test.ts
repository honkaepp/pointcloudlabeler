import { describe, it, expect } from 'vitest';
import type { TreeMetric } from '../persistence/octreeReader';
import {
  autoMap, rowsToFieldTrees, matchTrees, statsFor,
  type Mapping, type FieldTree,
} from './fieldValidation';

function metric(treeId: number, x: number, y: number, dbh: number, height: number): TreeMetric {
  return {
    treeId, count: 4000, height, dbh,
    basalArea: Number.isFinite(dbh) && dbh > 0 ? Math.PI * (dbh / 2) ** 2 : NaN,
    crownArea: 12, crownDiameter: 3.9, x, y, baseZ: 0, leanDeg: 0,
  };
}

function field(rowIdx: number, x: number, y: number, dbh: number, h: number): FieldTree {
  return { rowIdx, fieldId: `${rowIdx}`, x, y, caliperDbh: dbh, hypHeight: h, species: '' };
}

describe('autoMap', () => {
  it('finds the usual English headers', () => {
    const m = autoMap(['id', 'x', 'y', 'dbh', 'height', 'species']);
    expect(m).toEqual({ idCol: 0, xCol: 1, yCol: 2, dbhCol: 3, heightCol: 4, speciesCol: 5 });
  });

  it('matches a prefixed name like dbh_cm', () => {
    expect(autoMap(['x', 'y', 'dbh_cm', 'height_m']).dbhCol).toBe(2);
  });

  it('matches Finnish headers, which this app\'s users write', () => {
    const m = autoMap(['puunumero', 'x', 'y', 'lapimitta', 'pituus', 'puulaji']);
    expect(m.idCol).toBe(0);
    expect(m.dbhCol).toBe(3);
    expect(m.heightCol).toBe(4);
    expect(m.speciesCol).toBe(5);
  });

  it('is case- and space-insensitive', () => {
    expect(autoMap([' X ', 'Y', 'DBH']).dbhCol).toBe(2);
  });

  it('reports -1 for a column that is not there', () => {
    const m = autoMap(['x', 'y']);
    expect(m.dbhCol).toBe(-1);
    expect(m.heightCol).toBe(-1);
  });
});

describe('rowsToFieldTrees', () => {
  const M: Mapping = { xCol: 1, yCol: 2, dbhCol: 3, heightCol: 4, speciesCol: -1, idCol: 0 };

  it('converts caliper centimetres to metres', () => {
    const t = rowsToFieldTrees([['1', '10', '20', '24.7', '18.4']], M, false)[0];
    expect(t.caliperDbh).toBeCloseTo(0.247, 12);
    expect(t.hypHeight).toBeCloseTo(18.4, 12);
  });

  it('reads decimal commas when the file uses them', () => {
    const t = rowsToFieldTrees([['1', '10', '20', '24,7', '18,4']], M, true)[0];
    expect(t.caliperDbh).toBeCloseTo(0.247, 12);
    expect(t.hypHeight).toBeCloseTo(18.4, 12);
  });

  it('drops a row with no position', () => {
    expect(rowsToFieldTrees([['1', '', '20', '24.7', '18']], M, false)).toHaveLength(0);
  });

  it('keeps a row whose measurements are missing — the position still matches', () => {
    const t = rowsToFieldTrees([['1', '10', '20', '', '']], M, false)[0];
    expect(t.x).toBe(10);
    expect(Number.isNaN(t.caliperDbh)).toBe(true);
    expect(Number.isNaN(t.hypHeight)).toBe(true);
  });

  it('falls back to a row number when no id column is mapped', () => {
    expect(rowsToFieldTrees([['1', '10', '20', '24', '18']], { ...M, idCol: -1 }, false)[0].fieldId).toBe('1');
  });
});

describe('matchTrees', () => {
  const metrics = [metric(1, 0, 0, 0.30, 20), metric(2, 10, 0, 0.25, 18)];

  it('pairs each field tree with its nearest PointCloudLabeler tree', () => {
    const r = matchTrees([field(0, 0.4, 0, 0.29, 20), field(1, 10.2, 0, 0.26, 18)], metrics, 2);
    expect(r.matches).toHaveLength(2);
    expect(r.matches.map(m => m.pointcloudlabeler.treeId).sort()).toEqual([1, 2]);
  });

  it('never claims either side twice', () => {
    // Two field trees near the same PointCloudLabeler tree; only the closer wins.
    const r = matchTrees([field(0, 0.2, 0, 0.3, 20), field(1, 0.5, 0, 0.3, 20)], [metrics[0]], 2);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].field.rowIdx).toBe(0);
    expect(r.unmatchedField.map(f => f.rowIdx)).toEqual([1]);
  });

  it('leaves a field tree beyond the radius unmatched', () => {
    const r = matchTrees([field(0, 50, 50, 0.3, 20)], metrics, 2);
    expect(r.matches).toHaveLength(0);
    expect(r.unmatchedField).toHaveLength(1);
    expect(r.unmatchedPointCloudLabeler).toHaveLength(2);
  });

  it('reports the separation of each pair', () => {
    const r = matchTrees([field(0, 3, 4, 0.3, 20)], [metrics[0]], 10);
    expect(r.matches[0].distance).toBeCloseTo(5, 12);
  });

  it('is empty, not broken, with nothing on either side', () => {
    expect(matchTrees([], metrics, 2).matches).toHaveLength(0);
    expect(matchTrees([field(0, 0, 0, 0.3, 20)], [], 2).matches).toHaveLength(0);
  });
});

/** The panel exists to answer "how accurate is PointCloudLabeler?". Anything that
 *  gets into these figures IS that answer. */
describe('statsFor', () => {
  it('reports bias as PointCloudLabeler minus caliper', () => {
    const s = statsFor([{ c: 0.30, t: 0.32 }, { c: 0.25, t: 0.27 }])!;
    expect(s.bias).toBeCloseTo(0.02, 12);
    expect(s.n).toBe(2);
  });

  it('reports RMSE about the 1:1 line, so it carries the bias', () => {
    const s = statsFor([{ c: 10, t: 11 }, { c: 20, t: 21 }])!;
    expect(s.rmse).toBeCloseTo(1, 12);
    expect(s.bias).toBeCloseTo(1, 12);
    // RMSE² = bias² + SD²; SD is 0 here, so they coincide.
    expect(s.rmse ** 2).toBeCloseTo(s.bias ** 2, 12);
  });

  it('fits a line through the pairs', () => {
    const s = statsFor([{ c: 1, t: 2 }, { c: 2, t: 4 }, { c: 3, t: 6 }])!;
    expect(s.slope).toBeCloseTo(2, 12);
    expect(s.intercept).toBeCloseTo(0, 12);
    expect(s.r2).toBeCloseTo(1, 12);
  });

  /** The defect this module was extracted for. The metrics pass reports
   *  a height of 0 for a tree with no ground surface beneath it, and 0
   *  is finite — so an unmeasured tree entered the height validation as
   *  "PointCloudLabeler 0 m vs hypsometer 18 m". */
  it('leaves out a pair where PointCloudLabeler measured nothing', () => {
    const good = [{ c: 18, t: 18.1 }, { c: 20, t: 19.9 }, { c: 22, t: 22.2 }];
    const s = statsFor([...good, { c: 18, t: 0 }])!;
    const ref = statsFor(good)!;
    expect(s.n).toBe(3);
    expect(s.nUnusable).toBe(1);
    expect(s.bias).toBeCloseTo(ref.bias, 12);
    expect(s.rmse).toBeCloseTo(ref.rmse, 12);
  });

  it('leaves out a pair the field crew did not measure either', () => {
    const s = statsFor([{ c: 18, t: 18.1 }, { c: 20, t: 19.9 }, { c: 0, t: 21 }])!;
    expect(s.n).toBe(2);
    expect(s.nUnusable).toBe(1);
  });

  it('leaves out NaN and negative readings', () => {
    const s = statsFor([
      { c: 18, t: 18.1 }, { c: 20, t: 19.9 },
      { c: NaN, t: 20 }, { c: 20, t: NaN }, { c: -1, t: 20 }, { c: 20, t: -1 },
    ])!;
    expect(s.n).toBe(2);
    expect(s.nUnusable).toBe(4);
  });

  /** How badly the unmeasured tree distorted the answer. */
  it('would otherwise report PointCloudLabeler as far worse than it is', () => {
    const good = Array.from({ length: 19 }, (_, i) => ({ c: 18 + i * 0.2, t: 18 + i * 0.2 - 0.1 }));
    const withGap = [...good, { c: 18, t: 0 }];
    const clean = statsFor(withGap)!;
    // What including it gave: the residual is the whole tree height.
    const dirtyBias = withGap.reduce((a, p) => a + (p.t - p.c), 0) / withGap.length;
    const dirtyRmse = Math.sqrt(withGap.reduce((a, p) => a + (p.t - p.c) ** 2, 0) / withGap.length);
    expect(clean.bias).toBeCloseTo(-0.1, 12);
    expect(Math.abs(dirtyBias)).toBeGreaterThan(Math.abs(clean.bias) * 8);
    expect(dirtyRmse).toBeGreaterThan(clean.rmse * 6);
  });

  /** With no spread on the caliper axis there is no line to fit; the
   *  old code substituted slope 1 and printed "y = 1.000 x + b" as if
   *  it had fitted one. */
  it('reports no fit rather than a fabricated one', () => {
    const s = statsFor([{ c: 0.30, t: 0.31 }, { c: 0.30, t: 0.29 }])!;
    expect(Number.isNaN(s.slope)).toBe(true);
    expect(Number.isNaN(s.intercept)).toBe(true);
    expect(Number.isNaN(s.r2)).toBe(true);
    // Bias and RMSE are still meaningful — they need no fit.
    expect(s.bias).toBeCloseTo(0, 12);
    expect(s.rmse).toBeCloseTo(0.01, 12);
  });

  it('needs two usable pairs before it says anything', () => {
    expect(statsFor([])).toBeNull();
    expect(statsFor([{ c: 0.3, t: 0.31 }])).toBeNull();
    expect(statsFor([{ c: 0.3, t: 0.31 }, { c: 0.3, t: 0 }])).toBeNull();
  });

  it('takes the axis ranges from the usable pairs only', () => {
    const s = statsFor([{ c: 10, t: 11 }, { c: 20, t: 21 }, { c: 5, t: 0 }])!;
    expect(s.xMin).toBe(10);
    expect(s.xMax).toBe(20);
    expect(s.yMin).toBe(11);
    expect(s.yMax).toBe(21);
  });
});
