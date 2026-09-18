export interface SpatialGrid {
  cell: number;
  nx: number;
  ny: number;
  nz: number;
  minX: number;
  minY: number;
  minZ: number;
  cellStart: Uint32Array;
  pointIdx: Uint32Array;
}

export function buildGrid(positions: Float32Array): SpatialGrid | null {
  const n = positions.length / 3;
  if (n === 0) return null;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const targetCells = Math.max(4096, n / 16);
  const vol = Math.max(1e-3, (maxX - minX) * (maxY - minY) * (maxZ - minZ));
  let cell = Math.cbrt(vol / targetCells);
  cell = Math.max(0.25, Math.min(8, cell));
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const totalCells = nx * ny * nz;
  const counts = new Uint32Array(totalCells + 1);
  const cellOf = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const gx = ((positions[i * 3] - minX) / cell) | 0;
    const gy = ((positions[i * 3 + 1] - minY) / cell) | 0;
    const gz = ((positions[i * 3 + 2] - minZ) / cell) | 0;
    const c = gx + nx * (gy + ny * gz);
    cellOf[i] = c;
    counts[c + 1]++;
  }
  for (let i = 1; i <= totalCells; i++) counts[i] += counts[i - 1];
  const cellStart = counts;
  const cursor = new Uint32Array(totalCells);
  const pointIdx = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const c = cellOf[i];
    pointIdx[cellStart[c] + cursor[c]++] = i;
  }
  return { cell, nx, ny, nz, minX, minY, minZ, cellStart, pointIdx };
}
