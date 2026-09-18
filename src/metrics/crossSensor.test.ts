import { describe, it, expect } from 'vitest';
import type { TreeMetric } from '../persistence/octreeReader';
import {
  joinSensors, classify, detectionStats, detectionBySize,
  toRows, rowToCells, JOINED_CSV_HEADER, DEFAULT_DBH_CLASSES,
  type JoinedTree,
} from './crossSensor';

function tree(treeId: number, x: number, y: number, dbh: number, height = 20): TreeMetric {
  return {
    treeId, count: 4000, height, dbh,
    basalArea: Number.isFinite(dbh) && dbh > 0 ? Math.PI * (dbh / 2) ** 2 : NaN,
    crownArea: 12, crownDiameter: 3.9, x, y, baseZ: 0, leanDeg: 0,
  };
}

const joined = (als: TreeMetric | null, tls: TreeMetric | null): JoinedTree => ({
  als, tls, distance: als && tls ? 0.5 : NaN,
  dbh: tls ? tls.dbh : als ? als.dbh : NaN,
});

describe('joinSensors', () => {
  it('pairs a crown with the stem under it', () => {
    const r = joinSensors(
      [tree(1, 0, 0, 0.31), tree(2, 10, 0, 0.26)],
      [tree(101, 0.6, 0, 0.30), tree(102, 10.4, 0, 0.25)],
      { radius: 2 },
    );
    expect(r.nMatched).toBe(2);
    expect(r.nAlsOnly).toBe(0);
    expect(r.nTlsOnly).toBe(0);
    const m = r.rows.filter(t => classify(t) === 'matched');
    expect(m.map(t => [t.als!.treeId, t.tls!.treeId])).toEqual([[1, 101], [2, 102]]);
    expect(m[0].distance).toBeCloseTo(0.6, 9);
  });

  /** A row survives for a tree only one sensor saw. Dropping it would
   *  make every plot look perfectly detected. */
  it('keeps a tree that only one sensor found', () => {
    const r = joinSensors(
      [tree(1, 0, 0, 0.30), tree(2, 50, 50, 0.28)],
      [tree(101, 0.4, 0, 0.30), tree(102, 20, 0, 0.12)],
      { radius: 2 },
    );
    expect(r.rows).toHaveLength(3);
    expect(r.nMatched).toBe(1);
    expect(r.nAlsOnly).toBe(1);
    expect(r.nTlsOnly).toBe(1);
    expect(r.rows.map(classify).sort()).toEqual(['alsOnly', 'matched', 'tlsOnly']);
  });

  it('takes the reference diameter from the TLS side', () => {
    // The ALS estimate is deliberately wrong; the measured one wins.
    const r = joinSensors([tree(1, 0, 0, 0.99)], [tree(101, 0.3, 0, 0.30)], { radius: 2 });
    expect(r.rows[0].dbh).toBeCloseTo(0.30, 9);
  });

  it('accounts for every tree exactly once', () => {
    const als = Array.from({ length: 9 }, (_, i) => tree(i, i * 2, 0, 0.3));
    const tls = Array.from({ length: 7 }, (_, i) => tree(100 + i, i * 2 + 0.4, 0, 0.3));
    const r = joinSensors(als, tls, { radius: 1.5 });
    expect(r.rows).toHaveLength(r.nMatched + r.nAlsOnly + r.nTlsOnly);
    expect(r.nMatched + r.nAlsOnly).toBe(als.length);
    expect(r.nMatched + r.nTlsOnly).toBe(tls.length);
  });

  it('an empty plot on either side is all misses, not a crash', () => {
    expect(joinSensors([], [tree(1, 0, 0, 0.3)], { radius: 2 }).nTlsOnly).toBe(1);
    expect(joinSensors([tree(1, 0, 0, 0.3)], [], { radius: 2 }).nAlsOnly).toBe(1);
    expect(joinSensors([], [], { radius: 2 }).rows).toEqual([]);
  });
});

describe('detectionStats', () => {
  it('counts hits, false alarms and misses', () => {
    const rows = [
      joined(tree(1, 0, 0, 0.3), tree(101, 0, 0, 0.3)),
      joined(tree(2, 0, 0, 0.3), tree(102, 0, 0, 0.3)),
      joined(tree(3, 0, 0, 0.3), null),      // ALS invented one
      joined(null, tree(103, 0, 0, 0.3)),    // ALS missed one
      joined(null, tree(104, 0, 0, 0.3)),
    ];
    const s = detectionStats(rows);
    expect(s).toMatchObject({ truePositives: 2, falsePositives: 1, falseNegatives: 2 });
    expect(s.recall).toBeCloseTo(2 / 4, 12);
    expect(s.precision).toBeCloseTo(2 / 3, 12);
    expect(s.f1).toBeCloseTo(2 * (0.5 * (2 / 3)) / (0.5 + 2 / 3), 12);
  });

  it('is perfect when every tree matched', () => {
    const rows = [joined(tree(1, 0, 0, 0.3), tree(101, 0, 0, 0.3))];
    const s = detectionStats(rows);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.f1).toBe(1);
  });

  /** A rate over nothing is unknown, not zero. Reporting recall 0 for a
   *  plot with no reference trees would read as total failure. */
  it('reports NaN rather than zero when there is nothing to rate', () => {
    const s = detectionStats([]);
    expect(s.truePositives).toBe(0);
    expect(Number.isNaN(s.recall)).toBe(true);
    expect(Number.isNaN(s.precision)).toBe(true);
    expect(Number.isNaN(s.f1)).toBe(true);
  });

  it('recall is defined without detections, precision without references', () => {
    const missedOnly = detectionStats([joined(null, tree(1, 0, 0, 0.3))]);
    expect(missedOnly.recall).toBe(0);
    expect(Number.isNaN(missedOnly.precision)).toBe(true);

    const falseOnly = detectionStats([joined(tree(1, 0, 0, 0.3), null)]);
    expect(Number.isNaN(falseOnly.recall)).toBe(true);
    expect(falseOnly.precision).toBe(0);
  });
});

/** The breakdown the brief asks for and no package provides. A single
 *  overall F1 hides the detection curve completely — and the curve is
 *  what decides what the application can honestly claim. */
describe('detectionBySize', () => {
  /** A plot shaped like a real one: ALS finds nothing small, everything
   *  large. Overall F1 looks respectable; the small class is a zero. */
  const stand: JoinedTree[] = [
    // 5–15 cm: four measured stems, none found.
    ...Array.from({ length: 4 }, (_, i) => joined(null, tree(200 + i, 0, 0, 0.10))),
    // 15–25 cm: four measured, two found.
    joined(tree(1, 0, 0, 0.20), tree(210, 0, 0, 0.20)),
    joined(tree(2, 0, 0, 0.20), tree(211, 0, 0, 0.20)),
    joined(null, tree(212, 0, 0, 0.20)),
    joined(null, tree(213, 0, 0, 0.20)),
    // 35–45 cm: three measured, all found.
    joined(tree(3, 0, 0, 0.40), tree(220, 0, 0, 0.40)),
    joined(tree(4, 0, 0, 0.40), tree(221, 0, 0, 0.40)),
    joined(tree(5, 0, 0, 0.40), tree(222, 0, 0, 0.40)),
  ];

  it('shows the detection rate rising with diameter', () => {
    const { classes } = detectionBySize(stand);
    const by = (lo: number) => classes.find(c => c.dbhLow === lo)!;
    expect(by(0.05).recall).toBe(0);
    expect(by(0.15).recall).toBeCloseTo(0.5, 12);
    expect(by(0.35).recall).toBe(1);
  });

  it('the overall figure hides it', () => {
    const overall = detectionStats(stand);
    // Respectable-looking recall, and four stems PointCloudLabeler cannot see at all.
    expect(overall.recall).toBeCloseTo(5 / 11, 12);
    expect(detectionBySize(stand).classes.find(c => c.dbhLow === 0.05)!.nReference).toBe(4);
  });

  it('names the class edges and the reference count each rate rests on', () => {
    const { classes } = detectionBySize(stand);
    expect(classes.map(c => c.dbhLow)).toEqual([...DEFAULT_DBH_CLASSES]);
    expect(classes[classes.length - 1].dbhHigh).toBe(Infinity);
    expect(classes.reduce((s, c) => s + c.nReference, 0)).toBe(11);
  });

  it('puts a tree on a class edge in the class above', () => {
    const { classes } = detectionBySize([joined(null, tree(1, 0, 0, 0.25))]);
    expect(classes.find(c => c.dbhLow === 0.25)!.nReference).toBe(1);
    expect(classes.find(c => c.dbhLow === 0.15)!.nReference).toBe(0);
  });

  it('everything above the top edge lands in the open class', () => {
    const { classes } = detectionBySize([joined(null, tree(1, 0, 0, 1.20))]);
    expect(classes[classes.length - 1].nReference).toBe(1);
  });

  /** A tree with no usable diameter cannot be put in a size class, and
   *  must not land silently in the first one — which is where it would
   *  go if the search started from the bottom without a guard. */
  it('sets aside a tree with no diameter rather than calling it small', () => {
    const r = detectionBySize([
      joined(null, tree(1, 0, 0, NaN)),
      joined(null, tree(2, 0, 0, 0)),
      joined(null, tree(3, 0, 0, 0.01)),   // below the lowest edge
    ]);
    expect(r.classes[0].nReference).toBe(0);
    expect(r.unclassified.falseNegatives).toBe(3);
  });

  it('accepts custom class edges', () => {
    const r = detectionBySize([joined(null, tree(1, 0, 0, 0.30))], [0.20, 0.40]);
    expect(r.classes).toHaveLength(2);
    expect(r.classes[0].nReference).toBe(1);
    expect(r.classes[1].dbhHigh).toBe(Infinity);
  });

  it('sorts the edges it was handed', () => {
    const r = detectionBySize([joined(null, tree(1, 0, 0, 0.30))], [0.40, 0.20]);
    expect(r.classes.map(c => c.dbhLow)).toEqual([0.20, 0.40]);
  });
});

describe('the deliverable table', () => {
  const join = joinSensors(
    [tree(1, 0, 0, 0.31), tree(9, 50, 50, 0.28)],
    [tree(101, 0.4, 0, 0.30), tree(109, 20, 0, 0.12)],
    { radius: 2 },
  );
  const vols = new Map([[101, 0.842], [109, 0.031]]);

  it('carries TLS volume beside the ALS metrics on a matched row', () => {
    const row = toRows(join, vols).find(r => r.detection === 'matched')!;
    expect(row.tlsTreeId).toBe(101);
    expect(row.tlsStemVolumeM3).toBeCloseTo(0.842, 9);
    expect(row.alsTreeId).toBe(1);
    expect(row.alsCrownAreaM2).toBeCloseTo(12, 9);
    expect(row.separationM).toBeCloseTo(0.4, 9);
  });

  /** The row that decides whether the table can be fitted honestly. An
   *  ALS-only tree has no measured volume; writing 0 there would be read
   *  as a measurement of nothing by whatever fits the model. */
  it('leaves the volume EMPTY for a tree with no stem measured', () => {
    const row = toRows(join, vols).find(r => r.detection === 'alsOnly')!;
    expect(row.tlsStemVolumeM3).toBeNull();
    expect(rowToCells(row)[JOINED_CSV_HEADER.indexOf('tls_stem_volume_m3')]).toBe('');
  });

  it('leaves the ALS metrics empty for a stem the ALS pass missed', () => {
    const row = toRows(join, vols).find(r => r.detection === 'tlsOnly')!;
    expect(row.alsTreeId).toBeNull();
    expect(row.alsHeightM).toBeNull();
    expect(row.tlsStemVolumeM3).toBeCloseTo(0.031, 9);
    expect(rowToCells(row)[JOINED_CSV_HEADER.indexOf('separation_m')]).toBe('');
  });

  it('emits one cell per header column', () => {
    for (const row of toRows(join, vols)) {
      expect(rowToCells(row)).toHaveLength(JOINED_CSV_HEADER.length);
    }
  });

  it('survives a run with no QSM at all', () => {
    for (const row of toRows(join, null)) expect(row.tlsStemVolumeM3).toBeNull();
  });

  it('treats a zero or missing measurement as absent, not as a value', () => {
    const j = joinSensors([tree(1, 0, 0, 0.3, 0)], [tree(101, 0.2, 0, NaN)], { radius: 2 });
    const row = toRows(j, new Map([[101, 0]]))[0];
    expect(row.alsHeightM).toBeNull();          // height 0 = no ground beneath it
    expect(row.tlsDbhM).toBeNull();
    expect(row.tlsStemVolumeM3).toBeNull();     // a 0 m³ stem is not a stem
  });
});
