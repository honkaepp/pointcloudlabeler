// The skeleton cache as the renderer receives it: one binary buffer,
// viewed in place.
//
// The layout is defined by `skeleton_planar_bytes` in
// src-tauri/src/commands/octree.rs; this is its reader, and the two have
// to agree byte for byte. Little-endian throughout:
//
//    0..4   "TSKP"              4..8   version (3)
//    8..12  point count n       12..16 tree count
//   16..20  spacing, mm         20     1 finished, 2 checkpoint, 0 unknown
//   21..32  reserved
//   32..56  origin x, y, z as f64 — the xyz below are relative to it
//   56..+12n  xyz, f32 × 3 per point
//     ..+4n   tree_id, i32 per point
//     ..+2n   cylinder radius, u16 mm per point (at 56 + 16n: even)
//     ..+n    branch order, u8 per point
//
// WHY BINARY
// ----------
// The same data used to arrive as three JSON arrays. A plot's skeleton
// is tens of millions of points, so that was hundreds of megabytes of
// text to parse into V8 heap arrays several times the size of the text
// — more than the heap allows — and the renderer process died at the
// end of an hour-long build with nothing on screen to say why. An
// ArrayBuffer lives outside the JS heap, is a fraction of the size, and
// the typed arrays below are views over it: nothing here copies.

export interface SkeletonPlanar {
  pointCount: number;
  treeCount: number;
  /** Metres. */
  skeletonSpacing: number;
  /** True when the build that wrote the cache finished, false when the
   *  file is a checkpoint, null when it predates the flag. */
  complete: boolean | null;
  /** World origin the coordinates are relative to. An f32 cannot hold
   *  a projected coordinate: at an LV95 easting of 2 600 000 m its step
   *  is a quarter of a metre, and a skeleton stored that way drew as
   *  vertical dashed lines on a lattice. World = origin + xyz, in
   *  doubles. */
  origin: [number, number, number];
  /** Three per point, relative to `origin`. */
  xyz: Float32Array;
  treeId: Int32Array;
  /** QSM cylinder radius the point was sampled from, in millimetres. */
  radiusMm: Uint16Array;
  /** 0 trunk, ≥ 1 branch. */
  order: Uint8Array;
}

const MAGIC = 'TSKP';
const VERSION = 3;
export const SKELETON_PLANAR_HEADER = 56;
/** Bytes per point after the header: 12 xyz + 4 tree id + 2 radius + 1 order. */
export const SKELETON_PLANAR_BYTES_PER_POINT = 19;

/** Decode the command's response. An empty body is "no cache" and
 *  decodes to null; anything else that is not the layout above throws,
 *  naming what was wrong, because a truncated or foreign buffer must
 *  not be drawn as a skeleton. */
export function decodeSkeletonPlanar(bytes: ArrayBuffer | Uint8Array): SkeletonPlanar | null {
  let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength === 0) return null;
  if (u8.byteLength < SKELETON_PLANAR_HEADER) {
    throw new Error(`skeleton buffer is ${u8.byteLength} bytes, shorter than its ${SKELETON_PLANAR_HEADER}-byte header`);
  }
  // A Float32Array view needs a byte offset divisible by four. A view
  // handed over at an odd offset into a larger buffer is copied once to
  // a buffer of its own; the usual case, offset 0, is not.
  if (u8.byteOffset % 4 !== 0) u8 = u8.slice();

  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== MAGIC) {
    throw new Error(`skeleton buffer starts with ${JSON.stringify(magic)}, expected ${MAGIC}`);
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== VERSION) {
    throw new Error(`skeleton buffer version ${version}; this build reads version ${VERSION}`);
  }
  const n = dv.getUint32(8, true);
  const expected = SKELETON_PLANAR_HEADER + SKELETON_PLANAR_BYTES_PER_POINT * n;
  if (u8.byteLength !== expected) {
    throw new Error(`skeleton buffer is ${u8.byteLength} bytes; ${n} points need ${expected}`);
  }
  const finished = u8[20];
  const base = u8.byteOffset + SKELETON_PLANAR_HEADER;
  return {
    pointCount: n,
    treeCount: dv.getUint32(12, true),
    skeletonSpacing: dv.getUint32(16, true) / 1000,
    complete: finished === 1 ? true : finished === 2 ? false : null,
    origin: [dv.getFloat64(32, true), dv.getFloat64(40, true), dv.getFloat64(48, true)],
    xyz: new Float32Array(u8.buffer, base, 3 * n),
    treeId: new Int32Array(u8.buffer, base + 12 * n, n),
    radiusMm: new Uint16Array(u8.buffer, base + 16 * n, n),
    order: new Uint8Array(u8.buffer, base + 18 * n, n),
  };
}
