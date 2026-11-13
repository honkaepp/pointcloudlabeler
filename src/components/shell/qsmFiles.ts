// QSMs as files (src-tauri commands/qsmfile): the open .qsm format
// and its .qsf manifest, tubes as OBJ (one object per tree, for Blender) and
// PLY (world coordinates, coloured by how each cylinder was measured), and
// .qsm / .qsf from other software (Arbor's among them) read back to tubes.
// Tubes show in the viewer as a Survey mesh layer, in their own colours.

import { addMesh } from './surveyStore';

export interface QsmExportResult {
  trees: number;
  qsf: string | null;
  obj: string | null;
  ply: string | null;
  /** What the OBJ's coordinates are relative to. */
  origin: [number, number, number];
  files: number;
}

export interface QsmImportResult {
  trees: number;
  edges: number;
  ply: string;
  /** The files' own messages (their QC log), per tree. */
  messages: string[];
}

interface QsmDesktop {
  qsmExportFiles?: (octreeDir: string, formats: string[], outDir?: string, sides?: number) => Promise<QsmExportResult>;
  qsmImportFile?: (path: string, outPly?: string, sides?: number) => Promise<QsmImportResult>;
  /** The bridge returns the picked file (path, name, size), not a bare path. */
  openFileDialog?: (o: { filters?: { name: string; extensions: string[] }[] }) => Promise<{ path: string; name: string; size: number } | null>;
}
const desktop = (): QsmDesktop | undefined => (window as unknown as { desktop?: QsmDesktop }).desktop;

/** The quality levels as the tubes are coloured (the .qsm `quality_level`:
 *  higher is surer). */
export const QSM_QUALITY: { level: number; label: string; color: string }[] = [
  { level: 4, label: 'measured all round', color: 'rgb(74,222,128)' },
  { level: 3, label: 'seen from one side', color: 'rgb(250,204,21)' },
  { level: 2, label: 'radius corrected', color: 'rgb(249,115,22)' },
  { level: 1, label: 'gap bridged', color: 'rgb(239,68,68)' },
  { level: 0, label: 'connector', color: 'rgb(148,163,184)' },
];

/** Write the dataset's QSM as files; returns what was written. */
export async function exportQsmFiles(dir: string, formats: string[] = ['qsm', 'obj', 'ply'], sides?: number): Promise<QsmExportResult> {
  const d = desktop();
  if (!d?.qsmExportFiles) throw new Error('Writing QSM files needs the desktop build.');
  return d.qsmExportFiles(dir, formats, undefined, sides);
}

/** The dataset's QSM as tubes in the viewer: six-sided, so a plot of a few
 *  hundred thousand cylinders stays a few hundred megabytes. */
export async function showQsmTubes(dir: string): Promise<QsmExportResult> {
  const r = await exportQsmFiles(dir, ['ply'], 6);
  if (r.ply) addMesh(r.ply);
  return r;
}

/** A .qsm or .qsf from elsewhere, picked by the user, as tubes in the viewer. */
export async function openQsmFile(): Promise<QsmImportResult | null> {
  const d = desktop();
  if (!d?.qsmImportFile || !d.openFileDialog) throw new Error('Opening QSM files needs the desktop build.');
  const picked = await d.openFileDialog({ filters: [{ name: 'QSM', extensions: ['qsm', 'qsf'] }] });
  if (!picked?.path) return null;
  return importQsmFile(picked.path);
}

/** A .qsm or .qsf as tubes in the viewer (Layers opens a run's QSM file so). */
export async function importQsmFile(path: string): Promise<QsmImportResult> {
  const d = desktop();
  if (!d?.qsmImportFile) throw new Error('Opening QSM files needs the desktop build.');
  const r = await d.qsmImportFile(path);
  addMesh(r.ply);
  return r;
}
