// The raw hierarchy.bin decode (octreeReader.decodeHierarchy),
// the open path for clouds whose hierarchy is too large to send as JSON.
import { describe, expect, it } from 'vitest';
import { decodeHierarchy } from './octreeReader';

function record(view: DataView, i: number, r: { childMask: number; level: number; numPoints: number; byteOffset: number; byteSize: number }): void {
  const o = i * 24;
  view.setUint8(o, r.childMask);
  view.setUint8(o + 1, r.level);
  view.setUint32(o + 4, r.numPoints, true);
  view.setBigUint64(o + 8, BigInt(r.byteOffset), true);
  view.setBigUint64(o + 16, BigInt(r.byteSize), true);
}

describe('the raw hierarchy', () => {
  it('decodes every field, offsets past 4 GiB included', () => {
    const recs = [
      { childMask: 0b1010_0001, level: 0, numPoints: 12_345, byteOffset: 0, byteSize: 296_280 },
      { childMask: 0, level: 14, numPoints: 1, byteOffset: 30_000_000_000, byteSize: 24 },
      { childMask: 0xff, level: 3, numPoints: 4_000_000_000, byteOffset: 2 ** 52, byteSize: 5_000_000_000 },
    ];
    const buf = new ArrayBuffer(recs.length * 24);
    const view = new DataView(buf);
    recs.forEach((r, i) => record(view, i, r));
    // The reserved bytes are ignored.
    view.setUint8(2, 0xaa);
    view.setUint8(27, 0x55);
    expect(decodeHierarchy(buf)).toEqual(recs);
  });

  it('refuses a torn record', () => {
    expect(() => decodeHierarchy(new ArrayBuffer(47))).toThrow(/not a multiple of 24/);
  });

  it('decodes a billion-point cloud\'s worth of records', () => {
    // About 1.3 M nodes: a 30 MB hierarchy.
    const n = 1_300_000;
    const buf = new ArrayBuffer(n * 24);
    const u = new Uint32Array(buf);
    for (let i = 0; i < n; i++) {
      u[i * 6] = (i % 15) << 8;
      u[i * 6 + 1] = i;
      u[i * 6 + 2] = i * 24;
      u[i * 6 + 4] = 24;
    }
    const out = decodeHierarchy(buf);
    expect(out.length).toBe(n);
    expect(out[n - 1]).toEqual({ childMask: 0, level: (n - 1) % 15, numPoints: n - 1, byteOffset: (n - 1) * 24, byteSize: 24 });
  });
});
