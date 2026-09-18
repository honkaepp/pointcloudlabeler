import { describe, it, expect } from 'vitest';
import { decodeNodePoints, decodeExtraColumn, isDeadwoodExtra } from './octreeReader';

/** Build a node block in the on-disk layout:
 *  i32 X, i32 Y, i32 Z, i32 tree_id, u16 intensity, u8 class,
 *  u8 return_number, [u8 semantic], [f32 extras…]. */
function block(
  points: Array<{
    xi: number; yi: number; zi: number; id: number;
    intensity?: number; cls?: number; ret?: number; sem?: number;
    extras?: number[];
  }>,
  pointBytes: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(points.length * pointBytes);
  const dv = new DataView(buf);
  points.forEach((p, i) => {
    const o = i * pointBytes;
    dv.setInt32(o, p.xi, true);
    dv.setInt32(o + 4, p.yi, true);
    dv.setInt32(o + 8, p.zi, true);
    dv.setInt32(o + 12, p.id, true);
    dv.setUint16(o + 16, p.intensity ?? 0, true);
    dv.setUint8(o + 18, p.cls ?? 0);
    dv.setUint8(o + 19, p.ret ?? 0);
    if (pointBytes >= 21) dv.setUint8(o + 20, p.sem ?? 0);
    (p.extras ?? []).forEach((v, k) => dv.setFloat32(o + 21 + k * 4, v, true));
  });
  return buf;
}

const SCALE: [number, number, number] = [0.001, 0.001, 0.001];
const OFFSET: [number, number, number] = [500000, 6700000, 100];

describe('decodeNodePoints', () => {
  it('dequantises with the dataset scale and offset', () => {
    const d = decodeNodePoints(block([{ xi: 1000, yi: 2000, zi: 3000, id: 7 }], 21), SCALE, OFFSET, 21);
    expect(d.count).toBe(1);
    // 1000 * 0.001 = 1 m east, 2 m north, 3 m up — offset cancels.
    expect(d.positions[0]).toBeCloseTo(1, 6);
    expect(d.positions[1]).toBeCloseTo(3, 6);    // up
    expect(d.positions[2]).toBeCloseTo(-2, 6);   // −north
  });

  /** The mapping every viewer measurement rests on: survey (east,
   *  north, up) becomes scene (east, up, −north). Dropping the negation
   *  mirrors the cloud — see io/sceneAxes. */
  it('maps survey axes to scene axes, negating north', () => {
    const d = decodeNodePoints(block([
      { xi: 1000, yi: 0, zi: 0, id: 1 },   // pure east
      { xi: 0, yi: 1000, zi: 0, id: 2 },   // pure north
      { xi: 0, yi: 0, zi: 1000, id: 3 },   // pure up
    ], 21), SCALE, OFFSET, 21);
    // Component-wise: the mapping yields −0 for a zeroed axis, and a
    // deep-equal would call that different from +0.
    const expected = [
      1, 0, 0,    // east  → +X
      0, 0, -1,   // north → −Z
      0, 1, 0,    // up    → +Y
    ];
    for (let k = 0; k < expected.length; k++) {
      expect(d.positions[k], `component ${k}`).toBeCloseTo(expected[k], 6);
    }
  });

  it('carries tree id, intensity, classification and return number', () => {
    const d = decodeNodePoints(block([
      { xi: 0, yi: 0, zi: 0, id: -1, intensity: 65535, cls: 2, ret: 3 },
      { xi: 0, yi: 0, zi: 0, id: 4711, intensity: 1, cls: 5, ret: 1 },
    ], 21), SCALE, OFFSET, 21);
    expect([...d.treeIds]).toEqual([-1, 4711]);
    expect([...d.intensity]).toEqual([65535, 1]);
    expect([...d.classification]).toEqual([2, 5]);
    expect([...d.returnNumber]).toEqual([3, 1]);
  });

  describe('format versions', () => {
    it('v1 (20 B) has no semantic byte, and reads it as unlabelled', () => {
      const d = decodeNodePoints(block([{ xi: 1000, yi: 0, zi: 0, id: 1 }], 20), SCALE, OFFSET, 20);
      expect(d.count).toBe(1);
      expect([...d.semantic]).toEqual([0]);
      expect(d.positions[0]).toBeCloseTo(1, 6);
    });

    it('v2 (21 B) reads the semantic byte', () => {
      const d = decodeNodePoints(block([
        { xi: 0, yi: 0, zi: 0, id: 1, sem: 1 },
        { xi: 0, yi: 0, zi: 0, id: 2, sem: 2 },
      ], 21), SCALE, OFFSET, 21);
      expect([...d.semantic]).toEqual([1, 2]);
    });

    it('defaults to the v1 stride when the caller does not say', () => {
      const d = decodeNodePoints(block([{ xi: 1000, yi: 0, zi: 0, id: 1 }], 20), SCALE, OFFSET);
      expect(d.count).toBe(1);
    });
  });

  describe('extra columns', () => {
    const PB = 21 + 8;   // two f32 extras
    const NAMES = ['reflectance', 'deviation'];
    const bytes = () => block([
      { xi: 0, yi: 0, zi: 0, id: 1, extras: [-12.5, 3] },
      { xi: 0, yi: 0, zi: 0, id: 2, extras: [-8.25, 7] },
    ], PB);

    it('decodes each named column', () => {
      const d = decodeNodePoints(bytes(), SCALE, OFFSET, PB, NAMES);
      expect([...d.extras.reflectance]).toEqual([-12.5, -8.25]);
      expect([...d.extras.deviation]).toEqual([3, 7]);
    });

    /** Lazy extras: a cloud with many columns should not materialise a
     *  Float32Array per point for the ones nothing is looking at. */
    it('materialises only the wanted columns', () => {
      const d = decodeNodePoints(bytes(), SCALE, OFFSET, PB, NAMES, new Set(['deviation']));
      expect(Object.keys(d.extras)).toEqual(['deviation']);
      expect([...d.extras.deviation]).toEqual([3, 7]);
    });

    it('skips extras entirely when none are named', () => {
      const d = decodeNodePoints(bytes(), SCALE, OFFSET, PB);
      expect(Object.keys(d.extras)).toEqual([]);
      // …and the base fields still decode at the wider stride.
      expect([...d.treeIds]).toEqual([1, 2]);
    });

    /** More names than the stride can hold — a metadata/file mismatch.
     *  Reading past the record would pull the next point's coordinates
     *  in as a reflectance value. */
    it('reads no more columns than the stride fits', () => {
      const d = decodeNodePoints(bytes(), SCALE, OFFSET, PB, [...NAMES, 'phantom']);
      expect(Object.keys(d.extras).sort()).toEqual(['deviation', 'reflectance']);
    });

    it('is empty on a v2 file that names extras it does not carry', () => {
      const d = decodeNodePoints(block([{ xi: 0, yi: 0, zi: 0, id: 1 }], 21), SCALE, OFFSET, 21, NAMES);
      expect(Object.keys(d.extras)).toEqual([]);
    });
  });

  it('an empty block decodes to an empty node', () => {
    const d = decodeNodePoints(new ArrayBuffer(0), SCALE, OFFSET, 21);
    expect(d.count).toBe(0);
    expect(d.positions.length).toBe(0);
  });

  /** A block whose length is not a whole number of records — a
   *  truncated read. Decoding the partial tail would read past the
   *  buffer; the count is floored instead. */
  it('ignores a partial trailing record', () => {
    const full = block([{ xi: 1000, yi: 0, zi: 0, id: 1 }, { xi: 2000, yi: 0, zi: 0, id: 2 }], 21);
    const cut = full.slice(0, 21 + 10);
    const d = decodeNodePoints(cut, SCALE, OFFSET, 21);
    expect(d.count).toBe(1);
    expect([...d.treeIds]).toEqual([1]);
  });
});

describe('decodeExtraColumn', () => {
  const PB = 21 + 8;
  const bytes = block([
    { xi: 0, yi: 0, zi: 0, id: 1, extras: [-12.5, 3] },
    { xi: 0, yi: 0, zi: 0, id: 2, extras: [-8.25, 7] },
  ], PB);

  it('pulls one column out by its record index', () => {
    expect([...decodeExtraColumn(bytes, PB, 0)]).toEqual([-12.5, -8.25]);
    expect([...decodeExtraColumn(bytes, PB, 1)]).toEqual([3, 7]);
  });

  /** It must agree with decodeNodePoints — this is the lazy-hydration
   *  path for a column the node load skipped, so a disagreement would
   *  show a different value depending on which colour mode was active
   *  when the node streamed in. */
  it('agrees with the eager decode', () => {
    const eager = decodeNodePoints(bytes, SCALE, OFFSET, PB, ['a', 'b']);
    expect([...decodeExtraColumn(bytes, PB, 0)]).toEqual([...eager.extras.a]);
    expect([...decodeExtraColumn(bytes, PB, 1)]).toEqual([...eager.extras.b]);
  });

  it('returns zeros for a column past the end of the record', () => {
    expect([...decodeExtraColumn(bytes, PB, 2)]).toEqual([0, 0]);
    expect([...decodeExtraColumn(bytes, 21, 0)]).toEqual([0, 0]);
  });
});

describe('isDeadwoodExtra', () => {
  it('claims the two reserved id channels, whatever their case', () => {
    expect(isDeadwoodExtra('standing_deadwood')).toBe(true);
    expect(isDeadwoodExtra('LAYING_DEADWOOD')).toBe(true);
  });

  it('leaves an ordinary extra alone', () => {
    expect(isDeadwoodExtra('reflectance')).toBe(false);
    expect(isDeadwoodExtra('deadwood')).toBe(false);
  });
});
