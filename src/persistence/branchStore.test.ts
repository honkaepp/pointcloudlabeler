import { describe, it, expect } from 'vitest';
import {
  BRANCH_FORMAT, emptyBranchFile, parseBranchFile, serializeBranchFile, buildMarks,
  membersFromSelection, createBranch, assignToBranch, removeFromBranch, deleteBranch,
  updateBranch, addDiameter, addLength, removeMeasurement, promoteMeasurement,
  baseDiameter, primaryLength, branchSummaryCsv, measurementsCsv, branchColor, branchColorHex,
  type DiameterMeasurement, type LengthMeasurement, type DiameterRole,
  addDiameters, diameterOfRole, stemOf,
} from './branchStore';

const NOW = '2026-10-14T10:00:00Z';

const sel = (entries: Array<[string, number[]]>) => membersFromSelection(new Map(entries));

const dia = (id: string, role: DiameterRole, diameter: number): DiameterMeasurement => ({
  id, role, mode: 'cross', center: [1, 2, 3], axis: [1, 0, 0], theta: Math.PI / 2,
  halfThickness: 0.005, maxRadius: 0.1, trim: 0, d1: diameter - 0.001, d2: diameter + 0.001, diameter,
  manual: false, circleDiameter: diameter, coverage: 0.92, pointCount: 140,
  heightAboveGround: null, groundZ: null, createdAt: NOW,
});
const len = (id: string, primary: boolean, length: number): LengthMeasurement => ({
  id, method: 'manual', nodes: [[0, 0, 0], [length, 0, 0]], length, primary, createdAt: NOW,
});

describe('branches.json', () => {
  it('absent or empty is no branches', () => {
    expect(parseBranchFile('')).toEqual(emptyBranchFile());
    expect(parseBranchFile('{}')).toEqual(emptyBranchFile());
  });

  it('round-trips every field', () => {
    let f = createBranch(emptyBranchFile(), sel([['0:5', [9, 3, 3]], ['1:2', [0]]]), 17, NOW).file;
    f = addDiameter(f, 1, dia('d1', 'base', 0.031), NOW);
    f = addLength(f, 1, len('l1', true, 1.42), NOW);
    f = updateBranch(f, 1, { note: 'dead, "broken", tip', done: true }, NOW);
    const back = parseBranchFile(serializeBranchFile(f));
    expect(back).toEqual(f);
    expect(back.branches[0].members).toEqual([{ tile: 0, record: 5, points: [3, 9] }, { tile: 1, record: 2, points: [0] }]);
    expect(back.branches[0].pointCount).toBe(3);
  });

  it('refuses a file in another format rather than overwriting it as empty', () => {
    expect(() => parseBranchFile(JSON.stringify({ format: 'pointcloudlabeler-branches/9', branches: [] }))).toThrow(/format/);
  });

  it('drops malformed entries and duplicate ids, and recounts the points', () => {
    const f = parseBranchFile(JSON.stringify({
      format: BRANCH_FORMAT,
      branches: [
        { id: 1, members: [{ tile: 0, record: 1, points: [2, 2, -1, 1.5, 4] }], pointCount: 999, diameters: [{ bad: 1 }], lengths: [] },
        { id: 1, members: [] },
        { id: 'x' },
        { id: 2, members: 'nope' },
      ],
    }));
    expect(f.branches.map(b => b.id)).toEqual([1, 2]);
    expect(f.branches[0].members[0].points).toEqual([2, 4]);
    expect(f.branches[0].pointCount).toBe(2);
    expect(f.branches[0].diameters).toEqual([]);
    expect(f.branches[0].name).toBe('Branch 1');
  });
});

describe('membership', () => {
  it('a point belongs to one branch: assigning it elsewhere takes it out of the first', () => {
    let f = createBranch(emptyBranchFile(), sel([['0:1', [1, 2, 3]]]), 4, NOW).file;
    const second = createBranch(f, sel([['0:1', [3, 4]]]), 4, NOW);
    f = second.file;
    expect(second.id).toBe(2);
    expect(f.branches[0].members).toEqual([{ tile: 0, record: 1, points: [1, 2] }]);
    expect(f.branches[1].members).toEqual([{ tile: 0, record: 1, points: [3, 4] }]);
    const marks = buildMarks(f);
    expect(marks.get('0:1')!.get(1)).toBe(1);
    expect(marks.get('0:1')!.get(3)).toBe(2);
  });

  it('adding to a branch unions, removing subtracts, and an emptied node drops out', () => {
    let f = createBranch(emptyBranchFile(), sel([['0:1', [1, 2]]]), null, NOW).file;
    f = assignToBranch(f, 1, sel([['0:1', [2, 7]], ['3:0', [5]]]), NOW);
    expect(f.branches[0].pointCount).toBe(4);
    f = removeFromBranch(f, 1, sel([['3:0', [5]], ['0:1', [1]]]), NOW);
    expect(f.branches[0].members).toEqual([{ tile: 0, record: 1, points: [2, 7] }]);
    expect(f.branches[0].pointCount).toBe(2);
  });

  it('deleting a branch frees its points', () => {
    let f = createBranch(emptyBranchFile(), sel([['0:1', [1]]]), null, NOW).file;
    f = createBranch(f, sel([['0:1', [2]]]), null, NOW).file;
    f = deleteBranch(f, 1);
    expect(f.branches.map(b => b.id)).toEqual([2]);
    expect(buildMarks(f).get('0:1')!.has(1)).toBe(false);
    // Ids are not reused while a higher one exists.
    expect(createBranch(f, [], null, NOW).id).toBe(3);
  });
});

describe('measurements', () => {
  it('a new base diameter retires the old one; promoting brings one back', () => {
    let f = createBranch(emptyBranchFile(), [], null, NOW).file;
    f = addDiameter(f, 1, dia('a', 'base', 0.03), NOW);
    f = addDiameter(f, 1, dia('b', 'base', 0.032), NOW);
    f = addDiameter(f, 1, dia('c', 'other', 0.02), NOW);
    expect(baseDiameter(f.branches[0])!.id).toBe('b');
    expect(f.branches[0].diameters.filter(d => d.role === 'base')).toHaveLength(1);
    f = promoteMeasurement(f, 1, 'a', NOW);
    expect(baseDiameter(f.branches[0])!.id).toBe('a');
    f = removeMeasurement(f, 1, 'a', NOW);
    expect(baseDiameter(f.branches[0])).toBeNull();
  });

  it('one primary length at a time', () => {
    let f = createBranch(emptyBranchFile(), [], null, NOW).file;
    f = addLength(f, 1, len('x', true, 1.0), NOW);
    f = addLength(f, 1, len('y', true, 1.1), NOW);
    expect(primaryLength(f.branches[0])!.id).toBe('y');
    expect(f.branches[0].lengths.filter(l => l.primary)).toHaveLength(1);
  });
});

describe('CSV', () => {
  it('the summary has one row per branch, diameters in mm and lengths in m', () => {
    let f = createBranch(emptyBranchFile(), sel([['0:1', [1, 2]]]), 12, NOW).file;
    f = addDiameter(f, 1, dia('a', 'base', 0.0314), NOW);
    f = addLength(f, 1, len('l', true, 1.2346), NOW);
    f = updateBranch(f, 1, { note: '=cmd' }, NOW);
    const rows = branchSummaryCsv(f);
    expect(rows).toHaveLength(2);
    const head = rows[0].split(',');
    const cells = rows[1].split(',');
    expect(cells[head.indexOf('base_diameter_mm')]).toBe('31.4');
    expect(cells[head.indexOf('length_m')]).toBe('1.235');
    expect(cells[head.indexOf('tree_id')]).toBe('12');
    // A note is free text and must not reach a spreadsheet as a formula.
    expect(cells[head.indexOf('note')]).toBe("'=cmd");
  });

  it('the measurement table has a row per diameter and per length, with where each was taken', () => {
    let f = createBranch(emptyBranchFile(), [], 3, NOW).file;
    f = addDiameter(f, 1, dia('a', 'base', 0.02), NOW);
    f = addLength(f, 1, len('l', true, 0.8), NOW);
    const rows = measurementsCsv(f);
    expect(rows).toHaveLength(3);
    const head = rows[0].split(',');
    const d = rows[1].split(',');
    const l = rows[2].split(',');
    expect(d[head.indexOf('kind')]).toBe('diameter');
    expect(d[head.indexOf('value')]).toBe('20.0');
    expect(d[head.indexOf('theta_deg')]).toBe('90.0');
    expect(d[head.indexOf('thickness_mm')]).toBe('10.0');
    expect(l[head.indexOf('kind')]).toBe('length');
    expect(l[head.indexOf('value')]).toBe('0.800');
    expect(l[head.indexOf('end_x')]).toBe('0.800');
    expect(rows.every(r => r.split(',').length === head.length)).toBe(true);
  });
});

describe('colours', () => {
  it('cycle through the palette and print as hex', () => {
    expect(branchColor(1)).toEqual(branchColor(13));
    expect(branchColor(1)).not.toEqual(branchColor(2));
    expect(branchColorHex(1)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('stems', () => {
  it('a stem is a part of its own kind, named after its tree, found by its tree', () => {
    let f = createBranch(emptyBranchFile(), sel([['0:1', [1]]]), 7, NOW).file;
    const s = createBranch(f, sel([['0:1', [2, 3]]]), 7, NOW, 'stem');
    f = s.file;
    expect(f.branches[1].kind).toBe('stem');
    expect(f.branches[1].name).toBe('Stem of tree 7');
    expect(stemOf(f, 7)!.id).toBe(s.id);
    expect(stemOf(f, 8)).toBeNull();
    expect(parseBranchFile(serializeBranchFile(f)).branches.map(b => b.kind)).toEqual(['branch', 'stem']);
    // A file written before stems existed reads as branches.
    expect(parseBranchFile(JSON.stringify({ format: BRANCH_FORMAT, branches: [{ id: 1 }] })).branches[0].kind).toBe('branch');
  });

  it('DBH and d6 each keep one reading, independently; a series adds in one go', () => {
    let f = createBranch(emptyBranchFile(), [], 7, NOW, 'stem').file;
    f = addDiameters(f, 1, [
      { ...dia('a', 'dbh', 0.30), heightAboveGround: 1.3, groundZ: 100 },
      { ...dia('b', 'd6', 0.22), heightAboveGround: 6, groundZ: 100 },
      { ...dia('c', 'other', 0.25), heightAboveGround: 4, groundZ: 100 },
    ], NOW);
    f = addDiameter(f, 1, { ...dia('d', 'dbh', 0.31), heightAboveGround: 1.3, groundZ: 100 }, NOW);
    const b = f.branches[0];
    expect(diameterOfRole(b, 'dbh')!.id).toBe('d');
    expect(diameterOfRole(b, 'd6')!.id).toBe('b');
    expect(b.diameters.find(d => d.id === 'a')!.role).toBe('other');
    f = promoteMeasurement(f, 1, 'c', NOW, 'd6');
    expect(diameterOfRole(f.branches[0], 'd6')!.id).toBe('c');
    expect(diameterOfRole(f.branches[0], 'dbh')!.id).toBe('d');
  });

  it('the CSVs carry the kind, DBH, d6, the height, and each reading’s height above ground', () => {
    let f = createBranch(emptyBranchFile(), [], 7, NOW, 'stem').file;
    f = addDiameter(f, 1, { ...dia('a', 'dbh', 0.3012), heightAboveGround: 1.3, groundZ: 100 }, NOW);
    f = addLength(f, 1, { id: 'h', method: 'height', nodes: [[0, 0, 100], [0, 0, 121.5]], length: 21.5, primary: true, createdAt: NOW }, NOW);
    const sum = branchSummaryCsv(f);
    const head = sum[0].split(','), row = sum[1].split(',');
    expect(row[head.indexOf('kind')]).toBe('stem');
    expect(row[head.indexOf('dbh_mm')]).toBe('301.2');
    expect(row[head.indexOf('height_m')]).toBe('21.500');
    const m = measurementsCsv(f);
    const mh = m[0].split(','), mr = m[1].split(',');
    expect(mr[mh.indexOf('height_above_ground_m')]).toBe('1.300');
    expect(mr[mh.indexOf('role')]).toBe('dbh');
    expect(m.every(r => r.split(',').length === mh.length)).toBe(true);
  });
});
