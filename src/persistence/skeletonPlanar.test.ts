import { describe, it, expect } from 'vitest';
import {
  decodeSkeletonPlanar, SKELETON_PLANAR_HEADER, SKELETON_PLANAR_BYTES_PER_POINT,
} from './skeletonPlanar';

/** The Rust side's layout, written here independently so the test is
 *  a second opinion on the reader and not a mirror of it. */
function encode(points: Array<{ xyz: [number, number, number]; treeId: number; order: number; radiusMm?: number }>,
  opts: { treeCount?: number; spacingMm?: number; finished?: number; version?: number; magic?: string;
          origin?: [number, number, number] } = {}): Uint8Array {
  const n = points.length;
  const out = new Uint8Array(SKELETON_PLANAR_HEADER + SKELETON_PLANAR_BYTES_PER_POINT * n);
  const dv = new DataView(out.buffer);
  const magic = opts.magic ?? 'TSKP';
  for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i);
  dv.setUint32(4, opts.version ?? 3, true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, opts.treeCount ?? 2, true);
  dv.setUint32(16, opts.spacingMm ?? 20, true);
  out[20] = opts.finished ?? 1;
  const origin = opts.origin ?? [0, 0, 0];
  dv.setFloat64(32, origin[0], true);
  dv.setFloat64(40, origin[1], true);
  dv.setFloat64(48, origin[2], true);
  const xyzAt = SKELETON_PLANAR_HEADER, idAt = xyzAt + 12 * n, radiusAt = idAt + 4 * n, orderAt = radiusAt + 2 * n;
  points.forEach((p, i) => {
    dv.setFloat32(xyzAt + 12 * i, p.xyz[0], true);
    dv.setFloat32(xyzAt + 12 * i + 4, p.xyz[1], true);
    dv.setFloat32(xyzAt + 12 * i + 8, p.xyz[2], true);
    dv.setInt32(idAt + 4 * i, p.treeId, true);
    dv.setUint16(radiusAt + 2 * i, p.radiusMm ?? 0, true);
    out[orderAt + i] = p.order;
  });
  return out;
}

const SAMPLE = [
  { xyz: [1, 2, 3] as [number, number, number], treeId: 1, order: 0, radiusMm: 250 },
  { xyz: [-4, 5, 6.5] as [number, number, number], treeId: 1, order: 1, radiusMm: 30 },
  { xyz: [100.25, 200.5, 0.125] as [number, number, number], treeId: 7, order: 2, radiusMm: 5 },
];

describe('decodeSkeletonPlanar', () => {
  it('reads every column back, as views over the one buffer', () => {
    const buf = encode(SAMPLE, { treeCount: 2, spacingMm: 20, finished: 1 });
    const d = decodeSkeletonPlanar(buf)!;
    expect(d.pointCount).toBe(3);
    expect(d.treeCount).toBe(2);
    expect(d.skeletonSpacing).toBeCloseTo(0.02);
    expect(d.complete).toBe(true);
    expect(Array.from(d.xyz)).toEqual([1, 2, 3, -4, 5, 6.5, 100.25, 200.5, 0.125]);
    expect(Array.from(d.treeId)).toEqual([1, 1, 7]);
    expect(Array.from(d.order)).toEqual([0, 1, 2]);
    // No copies: the views share the buffer they were decoded from.
    expect(d.xyz.buffer).toBe(buf.buffer);
    expect(d.treeId.buffer).toBe(buf.buffer);
    expect(d.order.buffer).toBe(buf.buffer);
  });

  it('accepts a bare ArrayBuffer as well as a view', () => {
    const buf = encode(SAMPLE);
    const copy = new ArrayBuffer(buf.byteLength);
    new Uint8Array(copy).set(buf);
    expect(Array.from(decodeSkeletonPlanar(copy)!.treeId)).toEqual([1, 1, 7]);
  });

  it('reads the finished byte three ways', () => {
    expect(decodeSkeletonPlanar(encode(SAMPLE, { finished: 1 }))!.complete).toBe(true);
    expect(decodeSkeletonPlanar(encode(SAMPLE, { finished: 2 }))!.complete).toBe(false);
    expect(decodeSkeletonPlanar(encode(SAMPLE, { finished: 0 }))!.complete).toBeNull();
  });

  it('decodes an empty body as "no cache"', () => {
    expect(decodeSkeletonPlanar(new ArrayBuffer(0))).toBeNull();
    expect(decodeSkeletonPlanar(new Uint8Array(0))).toBeNull();
  });

  it('decodes a cache with zero points', () => {
    const d = decodeSkeletonPlanar(encode([]))!;
    expect(d.pointCount).toBe(0);
    expect(d.xyz.length).toBe(0);
  });

  /** A view that does not start on a four-byte boundary cannot be
   *  wrapped in a Float32Array; the reader copies it once instead of
   *  throwing a RangeError from deep inside. */
  it('copes with a view at an unaligned offset', () => {
    const payload = encode(SAMPLE);
    const bigger = new Uint8Array(payload.byteLength + 3);
    bigger.set(payload, 3);
    const view = new Uint8Array(bigger.buffer, 3, payload.byteLength);
    const d = decodeSkeletonPlanar(view)!;
    expect(Array.from(d.xyz)).toEqual([1, 2, 3, -4, 5, 6.5, 100.25, 200.5, 0.125]);
    expect(Array.from(d.order)).toEqual([0, 1, 2]);
  });

  it('refuses what is not a skeleton buffer, saying why', () => {
    expect(() => decodeSkeletonPlanar(encode(SAMPLE, { magic: 'TSKE' }))).toThrow(/TSKE.*expected TSKP/);
    expect(() => decodeSkeletonPlanar(encode(SAMPLE, { version: 4 }))).toThrow(/version 3/);
    expect(() => decodeSkeletonPlanar(encode(SAMPLE).subarray(0, 70))).toThrow(/3 points need/);
    expect(() => decodeSkeletonPlanar(encode(SAMPLE).subarray(0, 70))).toThrow(/113/);
    expect(() => decodeSkeletonPlanar(new Uint8Array(8))).toThrow(/shorter than/);
  });

  it('carries the origin, so a projected coordinate survives the f32', () => {
    // LV95: easting 2 600 000 m, where an f32 steps by a quarter metre.
    // The points are relative and small; world = origin + xyz in doubles.
    const origin: [number, number, number] = [2_600_123.0, 1_200_456.0, 512.0];
    const d = decodeSkeletonPlanar(encode(SAMPLE, { origin }))!;
    expect(d.origin).toEqual(origin);
    expect(d.xyz[0]).toBe(1);
    const worldY1 = d.origin[1] + d.xyz[4];
    const worldY0 = d.origin[1] + d.xyz[1];
    expect(worldY1 - worldY0).toBeCloseTo(3, 9);
    // A world f32 could not have told 0.30 m from 0.25 m at this easting.
    expect(Math.fround(2_600_123.30)).toBe(Math.fround(2_600_123.25));
  });

  it('carries the cylinder radius, in millimetres, at an even offset for any count', () => {
    const d = decodeSkeletonPlanar(encode(SAMPLE))!;
    expect(Array.from(d.radiusMm)).toEqual([250, 30, 5]);
    expect(Array.from(d.order)).toEqual([0, 1, 2]);
    // Three points: 56 + 16·3 = 104 is even; a Uint16Array over an odd
    // offset would throw, so the layout puts radius before order.
    expect(d.radiusMm.byteOffset % 2).toBe(0);
    const one = decodeSkeletonPlanar(encode([SAMPLE[1]]))!;
    expect(Array.from(one.radiusMm)).toEqual([30]);
  });
});
