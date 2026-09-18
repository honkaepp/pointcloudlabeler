// A minimal, valid LAS 1.2 file, built in memory.
//
// Test support only. The LAS point decoder in parseLasStream reads
// through laz-perf's WASM reader, so the only way to exercise it — and
// the argument order of its scene-axis mapping in particular — is to
// hand it a real file. Synthesising one is a few dozen lines against the
// ASPRS spec and needs no fixture on disk.

export interface LasPoint {
  /** Quantised coordinates, as stored in the record. */
  xi: number;
  yi: number;
  zi: number;
  intensity?: number;
  /** Return number, 1..5 (bits 0–2 of the return byte). */
  returnNumber?: number;
  classification?: number;
}

export interface LasOptions {
  scale?: [number, number, number];
  offset?: [number, number, number];
}

const HEADER_SIZE = 227;   // LAS 1.2
const POINT_LEN = 20;      // point data record format 0

/** Build a LAS 1.2, point-format-0 file containing `points`. */
export function buildLas(points: LasPoint[], opts: LasOptions = {}): Uint8Array {
  const scale = opts.scale ?? [0.001, 0.001, 0.001];
  const offset = opts.offset ?? [0, 0, 0];
  const buf = new Uint8Array(HEADER_SIZE + points.length * POINT_LEN);
  const dv = new DataView(buf.buffer);

  // "LASF"
  buf.set([0x4c, 0x41, 0x53, 0x46], 0);
  dv.setUint8(24, 1);                       // version major
  dv.setUint8(25, 2);                       // version minor
  dv.setUint16(94, HEADER_SIZE, true);      // header size
  dv.setUint32(96, HEADER_SIZE, true);      // offset to point data
  dv.setUint32(100, 0, true);               // VLR count
  dv.setUint8(104, 0);                      // point data format
  dv.setUint16(105, POINT_LEN, true);       // point data record length
  dv.setUint32(107, points.length, true);   // legacy point count
  dv.setFloat64(131, scale[0], true);
  dv.setFloat64(139, scale[1], true);
  dv.setFloat64(147, scale[2], true);
  dv.setFloat64(155, offset[0], true);
  dv.setFloat64(163, offset[1], true);
  dv.setFloat64(171, offset[2], true);

  // Bounding box, in the header's max/min pair order per axis.
  const world = (v: number, a: 0 | 1 | 2) => v * scale[a] + offset[a];
  const xs = points.map(p => world(p.xi, 0));
  const ys = points.map(p => world(p.yi, 1));
  const zs = points.map(p => world(p.zi, 2));
  const span = (vs: number[]) => (vs.length ? [Math.max(...vs), Math.min(...vs)] : [0, 0]);
  const [xMax, xMin] = span(xs);
  const [yMax, yMin] = span(ys);
  const [zMax, zMin] = span(zs);
  dv.setFloat64(179, xMax, true); dv.setFloat64(187, xMin, true);
  dv.setFloat64(195, yMax, true); dv.setFloat64(203, yMin, true);
  dv.setFloat64(211, zMax, true); dv.setFloat64(219, zMin, true);

  points.forEach((p, i) => {
    const o = HEADER_SIZE + i * POINT_LEN;
    dv.setInt32(o, p.xi, true);
    dv.setInt32(o + 4, p.yi, true);
    dv.setInt32(o + 8, p.zi, true);
    dv.setUint16(o + 12, p.intensity ?? 0, true);
    dv.setUint8(o + 14, (p.returnNumber ?? 1) & 0x07);   // return byte
    dv.setUint8(o + 15, p.classification ?? 0);
    // 16 scan angle, 17 user data, 18–19 point source id — left zero.
  });
  return buf;
}

/** The FileLike shape the LAS reader takes: a size plus ranged reads. */
export function fileLikeOf(bytes: Uint8Array, name = 'test.las') {
  return {
    name,
    size: bytes.byteLength,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () =>
        bytes.slice(start, Math.min(end, bytes.byteLength)).buffer as ArrayBuffer,
    }),
  };
}
