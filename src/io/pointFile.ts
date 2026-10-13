// Point files other than LAS — text (TXT / XYZ / CSV / ASC / PTS), PLY
// and E57 — as the Editor imports and exports them. The Rust side
// (commands/pointfile.rs) reads and writes them through a staged LAS;
// this is the shape of what it needs and returns, plus the file-dialog
// filters, so the import flow, the export dialog and the bridge agree
// on one list of formats.

export type PointFileKind = 'text' | 'ply' | 'e57';

/** The file formats the Editor exports. LAS and LAZ are written by the
 *  exporter itself; the rest are transcoded from the same export. */
export type CloudExportFormat = 'las' | 'laz' | 'txt' | 'ply' | 'e57';

/** Which source column fills which field of the record. Column names
 *  are the probe's; `extras` are carried as 64-bit columns under their
 *  own names. Mirrors `PointFileMapping` in commands/pointfile.rs. */
export interface PointFileMapping {
  x: string | null;
  y: string | null;
  z: string | null;
  intensity?: string | null;
  red?: string | null;
  green?: string | null;
  blue?: string | null;
  classification?: string | null;
  gpsTime?: string | null;
  treeId?: string | null;
  semantic?: string | null;
  returnNumber?: string | null;
  numberOfReturns?: string | null;
  pointSourceId?: string | null;
  scanAngle?: string | null;
  userData?: string | null;
  nir?: string | null;
  standingDeadwood?: string | null;
  layingDeadwood?: string | null;
  extras: string[];
}

/** What `pointfile_probe` reports about a file. */
export interface PointFileProbe {
  kind: PointFileKind;
  columns: string[];
  hasHeader: boolean;
  delimiter: string | null;
  preview: string[][];
  approxPointCount: number;
  scans: string[];
  suggested: PointFileMapping;
}

/** The roles of the mapping dialog, besides X, Y and Z, in the order
 *  they are shown. `key` is the mapping field. */
export const POINT_FILE_ROLES: { key: keyof Omit<PointFileMapping, 'x' | 'y' | 'z' | 'extras'>; label: string; hint: string }[] = [
  { key: 'intensity', label: 'intensity', hint: 'Return strength (an amplitude column is the same quantity), scaled into the record\'s 16 bits by the file\'s own range. Tick the same column under Extra columns to keep it exact too. A reflectance is a different quantity: leave it an extra column.' },
  { key: 'red', label: 'red', hint: 'Colour, 0–1, 0–255 or 0–65535; the file\'s range decides.' },
  { key: 'green', label: 'green', hint: 'Colour.' },
  { key: 'blue', label: 'blue', hint: 'Colour.' },
  { key: 'classification', label: 'classification', hint: 'ASPRS class — 2 is ground.' },
  { key: 'gpsTime', label: 'gps_time', hint: 'Per-point time, kept exact as an f64 column.' },
  { key: 'treeId', label: 'tree_id', hint: 'Instance id per point (0 = unassigned).' },
  { key: 'semantic', label: 'semantic', hint: 'Per-point stem / branch label (1 = stem, 2 = branch).' },
  { key: 'returnNumber', label: 'return_number', hint: 'Which return of its pulse the point is, from 1.' },
  { key: 'numberOfReturns', label: 'number_of_returns', hint: 'Returns the pulse gave.' },
  { key: 'pointSourceId', label: 'point_source_id', hint: 'The scan position or flight line the point came from — the Point QC wind stage needs it.' },
  { key: 'scanAngle', label: 'scan_angle', hint: 'Scan angle in degrees.' },
  { key: 'userData', label: 'user_data', hint: 'A byte per point.' },
  { key: 'nir', label: 'nir', hint: 'Near-infrared, like a colour channel.' },
  { key: 'standingDeadwood', label: 'standing_deadwood', hint: 'Standing dead-tree instance id per point (0 = none).' },
  { key: 'layingDeadwood', label: 'laying_deadwood', hint: 'Fallen / lying dead-tree instance id per point (0 = none).' },
];

const TEXT_EXTENSIONS = ['txt', 'xyz', 'csv', 'asc', 'pts', 'tsv', 'dat'];

/** The kind a file name means, or null for LAS/LAZ and anything else. */
export function pointFileKindOf(name: string): PointFileKind | null {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (TEXT_EXTENSIONS.includes(ext)) return 'text';
  if (ext === 'ply') return 'ply';
  if (ext === 'e57') return 'e57';
  return null;
}

export function isPointFileName(name: string): boolean {
  return pointFileKindOf(name) !== null;
}

export const POINT_FILE_KIND_LABELS: Record<PointFileKind, string> = {
  text: 'TXT / XYZ / CSV',
  ply: 'PLY',
  e57: 'E57',
};

/** The open-dialog filters for an import: everything first, then each
 *  family on its own so the OS dialog can narrow. */
export const CLOUD_OPEN_FILTERS = [
  { name: 'Point clouds', extensions: ['las', 'laz', ...TEXT_EXTENSIONS, 'ply', 'e57'] },
  { name: 'LAS / LAZ', extensions: ['las', 'laz'] },
  { name: 'Text (TXT / XYZ / CSV)', extensions: TEXT_EXTENSIONS },
  { name: 'PLY', extensions: ['ply'] },
  { name: 'E57', extensions: ['e57'] },
];

/** The save-dialog filter for an export of `format`. One filter, so the
 *  OS dialog keeps the extension the dialog chose. */
export function cloudSaveFilter(format: CloudExportFormat): { name: string; extensions: string[] } {
  switch (format) {
    case 'las': return { name: 'LAS point cloud', extensions: ['las'] };
    case 'laz': return { name: 'LAZ compressed point cloud', extensions: ['laz'] };
    case 'txt': return { name: 'Text point cloud', extensions: ['txt', 'xyz', 'csv'] };
    case 'ply': return { name: 'PLY point cloud', extensions: ['ply'] };
    case 'e57': return { name: 'E57 point cloud', extensions: ['e57'] };
  }
}

/** The extension an export of `format` is written with, honouring the
 *  dialog's choice over whatever the save sheet kept: the Rust writer
 *  dispatches on it. A text export keeps a text extension the user
 *  typed (.xyz, .csv). */
export function withExportExtension(path: string, format: CloudExportFormat): string {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  const ext = m ? m[1].toLowerCase() : '';
  if (format === 'txt' && TEXT_EXTENSIONS.includes(ext)) return path;
  const base = m ? path.slice(0, -m[0].length) : path;
  return `${base}.${format}`;
}
