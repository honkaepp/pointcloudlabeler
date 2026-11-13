// Data files as layers over the cloud.
//
// Scanning and processing leave more than a point cloud: the path walked,
// the scan positions, the reflector targets, the stems found, the region a
// cloud was cut to, voxels, grids. The Layers panel lists the project's
// files (commands/outputs.rs) and shows them here: what a file is
// by its name (`classifyOutput`), and the vector ones read into points and
// lines (`parseFeatures`) from CSV, GeoJSON or a shapefile.

export type OutputKind =
  | 'cloud' | 'trajectory' | 'positions' | 'targets' | 'stems' | 'region' | 'voxels' | 'mesh' | 'qsm'
  | 'raster' | 'report' | 'matrix' | 'image' | 'other';

/** The kinds drawn from a file of their own (a feature layer): points and
 *  lines, voxels, and a raster (an ESRI ASCII grid as a surface). */
export type FeatureKind = 'positions' | 'targets' | 'stems' | 'region' | 'voxels' | 'raster';

export const FEATURE_KINDS: ReadonlySet<OutputKind> = new Set<OutputKind>(['positions', 'targets', 'stems', 'region', 'voxels', 'raster']);

/** The kinds the Layers panel shows over the cloud. */
export const LAYER_KINDS: ReadonlySet<OutputKind> = new Set<OutputKind>(['trajectory', 'mesh', ...FEATURE_KINDS]);

export const KIND_LABEL: Record<OutputKind, string> = {
  cloud: 'point cloud', trajectory: 'trajectory', positions: 'scan positions', targets: 'targets',
  stems: 'stems', region: 'region', voxels: 'voxels', mesh: 'mesh', qsm: 'QSM', raster: 'raster', report: 'report',
  matrix: 'transform', image: 'image', other: 'file',
};

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** What a data file is, by its name (the names scanner software, the Survey
 *  panel and the QSM export give their files). */
export function classifyOutput(path: string): OutputKind {
  const name = baseName(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1);
  switch (ext) {
    case 'las': case 'laz': case 'e57': case 'ptx': case 'xyz': return 'cloud';
    case 'ply':
      if (/_pad\.ply$/.test(name)) return 'voxels';
      if (/_tubes\.ply$|^trees\.ply$/.test(name)) return 'mesh';
      return 'cloud';
    case 'obj': case 'stl': return 'mesh';
    case 'qsm': case 'qsf': return 'qsm';
    case 'txt':
      if (/_traj(_map)?\.txt$|_frames\.txt$|_odometry\.txt$|^traj(ectory)?\.txt$/.test(name)) return 'trajectory';
      if (/_summary\.txt$/.test(name)) return 'report';
      return 'other';
    case 'csv':
      if (/_scan_positions\.csv$/.test(name)) return 'positions';
      if (/_targets\.csv$|_stops\.csv$/.test(name)) return 'targets';
      if (/_stems\.csv$|_trees\.csv$/.test(name)) return 'stems';
      if (/_georef\.csv$/.test(name)) return 'matrix';
      return 'other';
    // the scan positions' GeoJSON is in WGS84: their CSV is the layer
    case 'geojson': return /_scan_positions\.geojson$/.test(name) ? 'other' : 'region';
    case 'shp': return 'region';
    // an ESRI ASCII grid is drawn; a GeoTIFF (the terrain's twin of its .asc) is not read yet
    case 'asc': return 'raster';
    case 'tif': case 'tiff': return 'other';
    case 'json': return 'report';
    case 'jpg': case 'jpeg': case 'png': return 'image';
    default: return 'other';
  }
}

// ---------------------------------------------------------------------------
// features: points (with a name, and a circle for a stem or a target) and lines

export interface FeaturePoint {
  x: number;
  y: number;
  /** null: the file gives no height; drawn as a pin through the cloud. */
  z: number | null;
  label?: string;
  /** A circle about the point, metres (a stem at breast height, a target). */
  radius?: number;
}

export interface Features {
  points: FeaturePoint[];
  /** Polylines; a polygon's ring closed. */
  lines: Array<Array<[number, number, number | null]>>;
  /** Longitude / latitude, not the cloud's coordinates (not drawn). */
  lonLat: boolean;
}

const EMPTY = (): Features => ({ points: [], lines: [], lonLat: false });

/** One CSV line into fields: commas (or semicolons, or tabs), "quoted" fields kept whole. */
export function splitCsv(line: string): string[] {
  const sep = line.includes(',') ? ',' : line.includes(';') ? ';' : '\t';
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; continue; }
    if (c === sep && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** Breast height, where a stem's circle is drawn above its ground. */
const BREAST_HEIGHT = 1.3;

/** A table of points with a header: x and y (or easting and northing), z when
 *  it has one — a stem's `ground_z` plus breast height — a name, and a circle:
 *  a stem's `dbh_cm` or a target's `diameter` (m). */
export function parsePointTable(text: string): Features {
  const rows = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (rows.length === 0) return EMPTY();
  const head = splitCsv(rows[0]).map((h) => h.toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const ix = col('x', 'easting', 'east', 'e'), iy = col('y', 'northing', 'north', 'n');
  if (ix < 0 || iy < 0) throw new Error('no x and y columns in its header');
  const iz = col('z', 'height', 'elevation'), ig = col('ground_z');
  const idbh = col('dbh_cm'), idiam = col('diameter');
  const iname = col('name', 'id', 'label', 'target', 'stop', 'tree');
  const num = (s: string | undefined) => (s === undefined || s === '' ? NaN : Number(s));
  const out = EMPTY();
  for (const row of rows.slice(1)) {
    const f = splitCsv(row);
    const x = num(f[ix]), y = num(f[iy]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const z = iz >= 0 ? num(f[iz]) : ig >= 0 ? num(f[ig]) + BREAST_HEIGHT : NaN;
    const p: FeaturePoint = { x, y, z: Number.isFinite(z) ? z : null };
    if (iname >= 0 && f[iname]) p.label = f[iname];
    const r = idbh >= 0 ? num(f[idbh]) / 200 : idiam >= 0 ? num(f[idiam]) / 2 : NaN;
    if (Number.isFinite(r) && r > 0) p.radius = r;
    out.points.push(p);
  }
  return out;
}

type Position = number[];

/** GeoJSON: points, lines and polygons (and their Multi- forms), a feature's
 *  `name` (or `id`) as its label. */
export function parseGeoJson(text: string): Features {
  const out = EMPTY();
  const pt = (c: Position): [number, number, number | null] => [c[0], c[1], c.length > 2 && Number.isFinite(c[2]) ? c[2] : null];
  const geom = (g: { type?: string; coordinates?: unknown; geometries?: unknown[] } | null | undefined, label?: string): void => {
    if (!g || typeof g !== 'object') return;
    const c = g.coordinates as unknown;
    switch (g.type) {
      case 'Point': { const [x, y, z] = pt(c as Position); out.points.push({ x, y, z, label }); break; }
      case 'MultiPoint': for (const q of c as Position[]) { const [x, y, z] = pt(q); out.points.push({ x, y, z, label }); } break;
      case 'LineString': out.lines.push((c as Position[]).map(pt)); break;
      case 'MultiLineString': for (const l of c as Position[][]) out.lines.push(l.map(pt)); break;
      case 'Polygon': for (const ring of c as Position[][]) out.lines.push(closed(ring.map(pt))); break;
      case 'MultiPolygon': for (const poly of c as Position[][][]) for (const ring of poly) out.lines.push(closed(ring.map(pt))); break;
      case 'GeometryCollection': for (const h of g.geometries ?? []) geom(h as never, label); break;
      default: break;
    }
  };
  const doc = JSON.parse(text) as { type?: string; features?: Array<{ geometry?: unknown; properties?: Record<string, unknown> | null; id?: unknown }>; geometry?: unknown; properties?: Record<string, unknown> | null };
  const nameOf = (p: Record<string, unknown> | null | undefined, id: unknown): string | undefined => {
    const v = p?.name ?? p?.Name ?? p?.id ?? id;
    return v === undefined || v === null ? undefined : String(v);
  };
  if (doc.type === 'FeatureCollection') for (const f of doc.features ?? []) geom(f.geometry as never, nameOf(f.properties, f.id));
  else if (doc.type === 'Feature') geom(doc.geometry as never, nameOf(doc.properties, undefined));
  else geom(doc as never);
  out.lonLat = looksLonLat(out);
  return out;
}

function closed(ring: Array<[number, number, number | null]>): Array<[number, number, number | null]> {
  if (ring.length > 1) {
    const a = ring[0], b = ring[ring.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) return [...ring, a];
  }
  return ring;
}

/** Every coordinate within ±180 / ±90: degrees, not metres of a projection. */
function looksLonLat(f: Features): boolean {
  const xy = [...f.points.map((p) => [p.x, p.y]), ...f.lines.flat().map((q) => [q[0], q[1]])];
  return xy.length > 0 && xy.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90);
}

/** An ESRI shapefile's geometry (the .shp; points, lines, polygons, with or
 *  without z). */
export function parseShapefile(buf: ArrayBuffer): Features {
  const dv = new DataView(buf);
  if (buf.byteLength < 100 || dv.getInt32(0, false) !== 9994) throw new Error('not a shapefile (.shp)');
  const out = EMPTY();
  let at = 100;
  while (at + 8 <= buf.byteLength) {
    const len = dv.getInt32(at + 4, false) * 2;
    const rec = at + 8;
    at = rec + len;
    if (len < 4 || at > buf.byteLength) break;
    const base = dv.getInt32(rec, true);
    if (base === 1 || base === 11 || base === 21) {
      const z = base === 11 ? dv.getFloat64(rec + 20, true) : null;
      out.points.push({ x: dv.getFloat64(rec + 4, true), y: dv.getFloat64(rec + 12, true), z });
    } else if (base === 3 || base === 5 || base === 13 || base === 15 || base === 23 || base === 25) {
      const nParts = dv.getInt32(rec + 36, true), nPts = dv.getInt32(rec + 40, true);
      const partsAt = rec + 44, ptsAt = partsAt + 4 * nParts;
      const hasZ = base === 13 || base === 15;
      const zAt = ptsAt + 16 * nPts + 16;
      for (let k = 0; k < nParts; k++) {
        const from = dv.getInt32(partsAt + 4 * k, true);
        const to = k + 1 < nParts ? dv.getInt32(partsAt + 4 * (k + 1), true) : nPts;
        const line: Array<[number, number, number | null]> = [];
        for (let i = from; i < to; i++) {
          line.push([dv.getFloat64(ptsAt + 16 * i, true), dv.getFloat64(ptsAt + 16 * i + 8, true), hasZ ? dv.getFloat64(zAt + 8 * i, true) : null]);
        }
        if (line.length > 1) out.lines.push(base === 5 || base === 15 || base === 25 ? closed(line) : line);
      }
    } else if (base === 8 || base === 18 || base === 28) {
      const nPts = dv.getInt32(rec + 36, true);
      const zAt = rec + 40 + 16 * nPts + 16;
      for (let i = 0; i < nPts; i++) {
        out.points.push({ x: dv.getFloat64(rec + 40 + 16 * i, true), y: dv.getFloat64(rec + 48 + 16 * i, true), z: base === 18 ? dv.getFloat64(zAt + 8 * i, true) : null });
      }
    }
  }
  out.lonLat = looksLonLat(out);
  return out;
}

/** Where a file's points and lines without a height are drawn: the heights
 *  the cloud's points take (its occupied tiles), not its bounding box, which
 *  the importer grows to a cube far below the ground. */
export function occupiedZSpan(
  tiles: ReadonlyArray<{ pointCount: number; bboxMin: [number, number, number]; bboxMax: [number, number, number] }>,
  box: { min: [number, number, number]; max: [number, number, number] },
): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const t of tiles) {
    if (t.pointCount <= 0) continue;
    lo = Math.min(lo, t.bboxMin[2]);
    hi = Math.max(hi, t.bboxMax[2]);
  }
  return Number.isFinite(lo) && Number.isFinite(hi) ? [Math.max(lo, box.min[2]), Math.min(hi, box.max[2])] : [box.min[2], box.max[2]];
}

/** An ESRI ASCII grid of elevations (drawn at its values) rather than of a
 *  quantity (drawn on the ground): a gap fraction run's ground, a DTM, DSM or
 *  filled DEM. */
export function isElevationGrid(path: string): boolean {
  return /(^|[_\-.])(ground|dtm|dsm|dem|filled)\.asc$/i.test(baseName(path));
}

/** The ground grid written beside a quantity grid by the same run
 *  (`<prefix>_cover.asc` → `<prefix>_ground.asc`), or null. */
export function groundGridOf(path: string): string | null {
  if (isElevationGrid(path)) return null;
  const g = path.replace(/_[^_\\/]+\.asc$/i, '_ground.asc');
  return g !== path ? g : null;
}

/** A feature file's contents by its kind and extension. */
export function parseFeatures(path: string, buf: ArrayBuffer): Features {
  const name = baseName(path).toLowerCase();
  if (name.endsWith('.shp')) return parseShapefile(buf);
  const text = new TextDecoder().decode(buf);
  if (name.endsWith('.geojson') || name.endsWith('.json')) return parseGeoJson(text);
  return parsePointTable(text);
}
