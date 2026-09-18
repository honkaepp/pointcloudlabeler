// Parser for ESRI ASCII grids (.asc) — the raster format octree_terrain
// writes DTM / DSM / CHM into. Six header lines (ncols, nrows, xllcorner,
// yllcorner, cellsize, NODATA_value) then `nrows` whitespace-separated
// data rows, north-first (the first row is the northernmost). We flip
// that to a south-first (cy increasing northward) row-major array so the
// renderer's cell→world math matches the converter's.

import type { RasterGrid } from '../persistence/octreeReader';

export function parseAsciiGrid(text: string): RasterGrid {
  // Header: tolerate any whitespace + case in the keys.
  const header: Record<string, number> = {};
  let cursor = 0;
  const len = text.length;

  // Read the six "key value" header lines from the top.
  //
  // The loop condition is on `lineStart`, not on `cursor`. `cursor`
  // only moves when a header line is successfully read, so a blank line
  // that hits the `continue` below leaves it alone — and if there is no
  // further newline in the file, every subsequent pass slices the same
  // empty string and continues again. `cursor < len` never becomes
  // false, and the parser spins forever on the UI thread.
  //
  // Reachable from both call sites (GroundPanel and
  // DensityMetricsPanel read .asc files straight off disk) on any
  // truncated write: a whitespace-only file, or a header that ends in a
  // blank line with no trailing newline, both hung the application with
  // no error and no way back. `lineStart` is strictly increasing —
  // `nl >= lineStart` always, so `lineStart = nl + 1` grows by at least
  // one each pass — which makes termination structural rather than
  // dependent on the content.
  const headerKeys = ['ncols', 'nrows', 'xllcorner', 'yllcorner', 'cellsize', 'nodata_value'];
  let lineStart = 0;
  let read = 0;
  while (read < headerKeys.length && lineStart < len) {
    let nl = text.indexOf('\n', lineStart);
    if (nl < 0) nl = len;
    const line = text.slice(lineStart, nl).trim();
    lineStart = nl + 1;
    if (!line) continue;
    const sp = line.search(/\s/);
    if (sp < 0) break;
    const key = line.slice(0, sp).toLowerCase();
    const val = parseFloat(line.slice(sp + 1).trim());
    if (headerKeys.includes(key)) {
      header[key] = val;
      read++;
      cursor = lineStart;
    } else {
      // Not a header line → data starts here; stop.
      break;
    }
  }

  const cols = Math.max(0, Math.round(header.ncols ?? 0));
  const rows = Math.max(0, Math.round(header.nrows ?? 0));
  const cellSize = header.cellsize || 1;
  const minX = header.xllcorner ?? 0;
  const minY = header.yllcorner ?? 0;
  const nodata = header.nodata_value ?? -9999;

  const values = new Float32Array(cols * rows);
  values.fill(NaN);
  let vmin = Infinity;
  let vmax = -Infinity;

  // Tokenise the remaining body. The first data row is the northernmost,
  // so file row ry maps to cy = rows-1-ry.
  const body = text.slice(cursor);
  let i = 0;
  const blen = body.length;
  let ry = 0;
  while (ry < rows && i < blen) {
    // Find end of this line.
    let nl = body.indexOf('\n', i);
    if (nl < 0) nl = blen;
    const cy = rows - 1 - ry;
    // Parse whitespace-separated numbers in [i, nl).
    let cx = 0;
    let j = i;
    while (j < nl && cx < cols) {
      while (j < nl && (body.charCodeAt(j) === 32 || body.charCodeAt(j) === 9 || body.charCodeAt(j) === 13)) j++;
      if (j >= nl) break;
      const start = j;
      while (j < nl) {
        const c = body.charCodeAt(j);
        if (c === 32 || c === 9 || c === 13) break;
        j++;
      }
      const v = parseFloat(body.slice(start, j));
      if (Number.isFinite(v) && v !== nodata) {
        values[cy * cols + cx] = v;
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }
      cx++;
    }
    i = nl + 1;
    ry++;
  }

  if (!Number.isFinite(vmin)) { vmin = 0; vmax = 0; }
  return { cols, rows, cellSize, minX, minY, values, vmin, vmax };
}
