import { describe, it, expect } from 'vitest';
import { parseTerrainGrid, sampleGround, terrainShift, terrainRelief, relativeCells, TERRAIN_HEADER_BYTES } from './terrainGrid';

function grid(cols: number, rows: number, cells: number[], minX = 100, minY = 200, cell = 1, reference = 541): ArrayBuffer {
  const buf = new ArrayBuffer(TERRAIN_HEADER_BYTES + cols * rows * 4);
  const dv = new DataView(buf);
  'PCLD'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, 1, true); dv.setUint32(8, cols, true); dv.setUint32(12, rows, true);
  dv.setFloat64(16, minX, true); dv.setFloat64(24, minY, true); dv.setFloat64(32, cell, true); dv.setFloat64(40, reference, true);
  cells.forEach((v, i) => dv.setFloat32(TERRAIN_HEADER_BYTES + i * 4, v, true));
  return buf;
}

describe('the ground grid the renderer flattens by', () => {
  it('parses the Rust side’s layout and refuses anything else', () => {
    const g = parseTerrainGrid(grid(2, 2, [540, 542, 541, NaN]));
    expect([g.cols, g.rows, g.minX, g.minY, g.cell, g.reference]).toEqual([2, 2, 100, 200, 1, 541]);
    expect(Array.from(g.z.subarray(0, 3))).toEqual([540, 542, 541]);
    expect(Number.isNaN(g.z[3])).toBe(true);
    expect(() => parseTerrainGrid(new ArrayBuffer(10))).toThrow(/header/);
    const bad = grid(1, 1, [1]); new DataView(bad).setUint8(0, 'X'.charCodeAt(0));
    expect(() => parseTerrainGrid(bad)).toThrow(/PCLD/);
  });

  it('samples bilinearly between cell centres, clamps at the edge, and reads the reference over a hole', () => {
    // A 3 × 1 strip sloping 540, 542, 544 at cell centres x = 100.5, 101.5, 102.5.
    const g = parseTerrainGrid(grid(3, 1, [540, 542, 544]));
    expect(sampleGround(g, 100.5, 200.5)).toBeCloseTo(540, 9);
    expect(sampleGround(g, 101.0, 200.5)).toBeCloseTo(541, 9);
    expect(sampleGround(g, 102.5, 200.5)).toBeCloseTo(544, 9);
    expect(sampleGround(g, 50, 200.5), 'west of the grid: the first cell').toBeCloseTo(540, 9);
    expect(sampleGround(g, 999, 999), 'far off: the last cell').toBeCloseTo(544, 9);
    // The shift is the ground minus the reference: a point on the
    // ground at 542 with the reference at 541 is drawn 1 m lower.
    expect(terrainShift(g, 101.5, 200.5)).toBeCloseTo(1, 9);
    expect(terrainRelief(g)).toBeCloseTo(3, 9);
    const holed = parseTerrainGrid(grid(2, 1, [NaN, 543]));
    expect(sampleGround(holed, 100.5, 200.5), 'a hole reads the reference').toBeCloseTo(541, 9);
    expect(Array.from(relativeCells(holed))).toEqual([0, 2]);
  });
});
