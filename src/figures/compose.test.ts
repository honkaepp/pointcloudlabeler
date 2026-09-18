import { describe, it, expect } from 'vitest';
import { layoutGrid, clampCrop, sameSize, dpiAt, checkDpi, DPI_COMBINATION } from './compose';

/** A source-and-target pair must be the same camera, the same pixel
 *  dimensions and the same crop. By hand the author's panels agreed to
 *  within 2–4 px, which is good enough and is also luck. */
describe('composing the figure', () => {
  it('gives every cell in a row one height and every cell in a column one width', () => {
    const sizes = [
      { width: 1200, height: 900 }, { width: 1200, height: 900 },
      { width: 1200, height: 700 }, { width: 1100, height: 700 },
    ];
    const g = layoutGrid(sizes, { rows: 2, cols: 2, gutter: 70, margin: 40 });
    expect(g.colWidths).toEqual([1200, 1200]);
    expect(g.rowHeights).toEqual([900, 700]);
    expect(g.size).toEqual({ width: 40 * 2 + 2400 + 70, height: 40 * 2 + 1600 + 70 });
    // Placed, never resampled: each cell keeps its own pixels.
    expect(g.cells.map((c) => [c.width, c.height])).toEqual([[1200, 900], [1200, 900], [1200, 700], [1100, 700]]);
    // Row 2 starts one row height plus a gutter below row 1.
    expect(g.cells[2].y).toBe(40 + 900 + 70);
    expect(g.cells[0].x).toBe(40);
    expect(g.cells[1].x).toBe(40 + 1200 + 70);
    // The narrow cell is centred in its column rather than pinned left.
    expect(g.cells[3].x).toBe(40 + 1200 + 70 + 50);
  });

  it('handles one row, one column and a short cell list', () => {
    const g = layoutGrid([{ width: 100, height: 50 }], { rows: 1, cols: 1, gutter: 70, margin: 10 });
    expect(g.size).toEqual({ width: 120, height: 70 });
    const partial = layoutGrid([{ width: 10, height: 10 }], { rows: 2, cols: 2, gutter: 5, margin: 0 });
    expect(partial.cells).toHaveLength(1);
    expect(partial.size).toEqual({ width: 15, height: 15 });
  });

  it('clamps a shared crop to each image instead of tearing its edge', () => {
    const img = { width: 2400, height: 1800 };
    expect(clampCrop({ x: 200, y: 150, width: 1000, height: 800 }, img)).toEqual({ x: 200, y: 150, width: 1000, height: 800 });
    expect(clampCrop({ x: 2000, y: 1700, width: 1000, height: 800 }, img)).toEqual({ x: 2000, y: 1700, width: 400, height: 100 });
    expect(clampCrop({ x: -50, y: -50, width: 100, height: 100 }, img)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(sameSize([img, { ...img }])).toBe(true);
    expect(sameSize([img, { width: 2400, height: 1801 }])).toBe(false);
  });

  it('states the dpi before the file is written, and what would fix it', () => {
    // The brief's own case: 480 CSS px at DPR 4 is 1920 px, printed 8 cm.
    expect(dpiAt(1920, 8)).toBeCloseTo(609.6, 1);
    const ok = checkDpi(1920, 8, 'combination');
    expect(ok.ok).toBe(true);
    expect(ok.message).toMatch(/610 dpi at 8 cm/);
    // A screen capture of the same panel: 505 px at DPR 1.
    const bad = checkDpi(505, 8, 'combination');
    expect(bad.ok).toBe(false);
    expect(bad.dpi).toBeCloseTo(160.3, 1);
    expect(bad.required).toBe(DPI_COMBINATION);
    expect(bad.neededPx).toBe(1575);
    expect(bad.message).toMatch(/below the 500 dpi floor — export at 1575 px wide/);
    // A rendered point cloud only has to clear 300.
    expect(checkDpi(1000, 8, 'halftone').ok).toBe(true);
  });
});
