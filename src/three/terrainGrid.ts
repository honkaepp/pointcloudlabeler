/** A cloud's ground surface as the renderer reads it — the pure part,
 *  no WebGL: parsing the grid the Rust side hands over and sampling it.
 *
 *  For "heights above ground" as a DISPLAY: every point is drawn at its
 *  stored z minus the ground under it plus one reference level (the
 *  median ground), so the cloud stays where it was on screen and the
 *  terrain comes out of it. The stored coordinates are never touched —
 *  edits, picks and exports work on them as before; only where a point
 *  is drawn changes, in the shader (see OctreeView's vertex shader) and,
 *  for the CPU-side projections that select and pick, through `shift`. */

export interface TerrainGrid {
  cols: number;
  rows: number;
  minX: number;
  minY: number;
  cell: number;
  /** The reference level: the median ground z. A point on the ground
   *  is drawn at this z wherever it stands. */
  reference: number;
  /** cols × rows, row-major, NaN where there is no ground. */
  z: Float32Array;
}

const MAGIC = 'PCLD';
export const TERRAIN_HEADER_BYTES = 48;

/** Parse what octree_dtm_grid returns. Throws on anything else. */
export function parseTerrainGrid(buf: ArrayBuffer): TerrainGrid {
  if (buf.byteLength < TERRAIN_HEADER_BYTES) throw new Error('terrain grid: too short for a header');
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== MAGIC) throw new Error(`terrain grid: not a ${MAGIC} file`);
  const version = dv.getUint32(4, true);
  if (version !== 1) throw new Error(`terrain grid: version ${version} is not 1`);
  const cols = dv.getUint32(8, true);
  const rows = dv.getUint32(12, true);
  const minX = dv.getFloat64(16, true);
  const minY = dv.getFloat64(24, true);
  const cell = dv.getFloat64(32, true);
  const reference = dv.getFloat64(40, true);
  const n = cols * rows;
  if (buf.byteLength < TERRAIN_HEADER_BYTES + n * 4) throw new Error('terrain grid: fewer cells than the header says');
  if (!(cell > 0) || !Number.isFinite(reference)) throw new Error('terrain grid: bad cell or reference');
  // A copy: the buffer's header puts the floats at an offset a
  // Float32Array view could not take on every platform.
  const z = new Float32Array(buf.slice(TERRAIN_HEADER_BYTES, TERRAIN_HEADER_BYTES + n * 4));
  return { cols, rows, minX, minY, cell, reference, z };
}

/** The ground z under (east, north): bilinear over cell centres,
 *  clamped to the grid, and the reference where a cell has no ground —
 *  so a point over a hole is drawn where it is stored. */
export function sampleGround(g: TerrainGrid, east: number, north: number): number {
  const gx = Math.min(Math.max((east - g.minX) / g.cell - 0.5, 0), g.cols - 1);
  const gy = Math.min(Math.max((north - g.minY) / g.cell - 0.5, 0), g.rows - 1);
  const i0 = Math.floor(gx), j0 = Math.floor(gy);
  const i1 = Math.min(i0 + 1, g.cols - 1), j1 = Math.min(j0 + 1, g.rows - 1);
  const fx = gx - i0, fy = gy - j0;
  const at = (i: number, j: number) => {
    const v = g.z[j * g.cols + i];
    return Number.isFinite(v) ? v : g.reference;
  };
  const a = at(i0, j0) * (1 - fx) + at(i1, j0) * fx;
  const b = at(i0, j1) * (1 - fx) + at(i1, j1) * fx;
  return a * (1 - fy) + b * fy;
}

/** What to take off a point's scene height at (east, north): the
 *  ground there minus the reference. Zero on flat ground at the
 *  reference level, positive uphill, negative downhill. */
export function terrainShift(g: TerrainGrid, east: number, north: number): number {
  return sampleGround(g, east, north) - g.reference;
}

/** The grid's relief: how far any ground cell lies from the reference,
 *  at most. The planner grows every node's bounding sphere by it, so a
 *  node whose points are drawn lower or higher than stored is still
 *  admitted where they show. */
export function terrainRelief(g: TerrainGrid): number {
  let r = 0;
  for (let i = 0; i < g.z.length; i++) {
    const v = g.z[i];
    if (!Number.isFinite(v)) continue;
    const d = Math.abs(v - g.reference);
    if (d > r) r = d;
  }
  return r;
}

/** The grid's values relative to the reference, NaN → 0, as the GPU
 *  texture holds them — sampled the same way the shader does. */
export function relativeCells(g: TerrainGrid): Float32Array<ArrayBuffer> {
  const out = new Float32Array(g.z.length);
  for (let i = 0; i < g.z.length; i++) {
    const v = g.z[i];
    out[i] = Number.isFinite(v) ? v - g.reference : 0;
  }
  return out;
}

/** The lowest and highest ground in the grid, or null with no ground. */
export function groundRange(g: TerrainGrid): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < g.z.length; i++) {
    const v = g.z[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}
