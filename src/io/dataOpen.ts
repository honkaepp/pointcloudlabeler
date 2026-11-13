// One door for data, the renderer's half (the Rust half, which says what a
// file or folder is, is src-tauri/src/commands/dataopen.rs).
//
// Whatever the user opens or drops — a LAS, a folder of tiles, a .zip of
// clouds, a PTX, a project — goes through `planOpen`, which decides where it
// belongs, and components/DataDoor.tsx carries the plan out: clouds into the
// editor's import, PTX to the Data tab, archives unpacked first, projects
// opened.

import { useSyncExternalStore } from 'react';

export type DataKind = 'cloud' | 'ptx' | 'project' | 'archive' | 'folder' | 'unknown';

/** commands/dataopen.rs DataEntry. */
export interface DataEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  kind: DataKind;
  /** A folder's or an archive's entries that can be opened. */
  contents: DataEntry[];
}

/** The extensions the editor's import reads (io/pointFile.ts, LAS / LAZ aside). */
export const CLOUD_EXTENSIONS = ['las', 'laz', 'ply', 'e57', 'txt', 'xyz', 'csv', 'asc', 'pts', 'tsv', 'dat'];

/** What a file is, by its name — as `kind_of_name` in dataopen.rs. */
export function kindOfName(name: string): DataKind {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  if (CLOUD_EXTENSIONS.includes(ext)) return 'cloud';
  if (ext === 'ptx') return 'ptx';
  if (ext === 'zip') return 'archive';
  return 'unknown';
}

/** The open dialog's formats: everything first, then by source. */
export const OPEN_DATA_FILTERS = [
  { name: 'Point clouds, archives and PTX', extensions: [...CLOUD_EXTENSIONS, 'zip', 'ptx'] },
  { name: 'Point clouds (LAS / LAZ / text / PLY / E57)', extensions: CLOUD_EXTENSIONS },
  { name: 'Archive of point clouds (.zip)', extensions: ['zip'] },
  { name: 'PTX', extensions: ['ptx'] },
];

/** What can be dropped, in words (the drop overlay, the welcome screen). */
export const OPENABLE_SUMMARY: Array<[string, string]> = [
  ['Point clouds', 'LAS · LAZ · E57 · PLY · TXT / XYZ / CSV'],
  ['Archives', '.zip of point clouds'],
  ['Structured scans', 'PTX'],
  ['Projects', 'a PointCloudLabeler project folder'],
];

/** Where an entry goes, in words. */
export function describeKind(kind: DataKind): string {
  switch (kind) {
    case 'cloud': return 'point cloud → the editor';
    case 'ptx': return 'PTX → the Data tab';
    case 'project': return 'PointCloudLabeler project → opened';
    case 'archive': return 'archive → unpacked into the project, then opened';
    case 'folder': return 'folder → what it holds';
    default: return 'not something PointCloudLabeler opens';
  }
}

export type DataPlan =
  | { action: 'openProject'; folder: string; ignored: string[] }
  | { action: 'extract'; entry: DataEntry; only: string[]; ignored: string[] }
  | { action: 'importClouds'; entries: DataEntry[]; ignored: string[] }
  | { action: 'ptx'; entry: DataEntry; ignored: string[] }
  | { action: 'nothing'; ignored: string[] };

/** Where what was opened goes. One thing is done: a project is opened, or an
 *  archive is unpacked, or every cloud is imported (one after another), or a
 *  PTX goes to the Data tab. What is not done is named in
 *  `ignored`. A folder counts as what it holds. */
export function planOpen(input: DataEntry[]): DataPlan {
  const entries: DataEntry[] = [];
  const unopenable: string[] = [];
  for (const e of input) {
    if (e.kind === 'folder') {
      if (e.contents.length > 0) entries.push(...e.contents);
      else unopenable.push(e.name);
    } else if (e.kind === 'unknown') {
      unopenable.push(e.name);
    } else {
      entries.push(e);
    }
  }
  const others = (chosen: DataEntry[]) => [
    ...entries.filter((e) => !chosen.includes(e)).map((e) => e.name),
    ...unopenable,
  ];
  const first = (...kinds: DataKind[]) => entries.find((e) => kinds.includes(e.kind));
  const project = first('project');
  if (project) return { action: 'openProject', folder: project.path, ignored: others([project]) };
  const archive = entries.find((e) => e.kind === 'archive' && e.contents.length > 0);
  if (archive) {
    const only = archive.contents.map((c) => c.path);
    return { action: 'extract', entry: archive, only, ignored: others([archive]) };
  }
  const clouds = entries.filter((e) => e.kind === 'cloud');
  if (clouds.length > 0) return { action: 'importClouds', entries: clouds, ignored: others(clouds) };
  const ptx = first('ptx');
  if (ptx) return { action: 'ptx', entry: ptx, ignored: others([ptx]) };
  return { action: 'nothing', ignored: [...entries.map((e) => e.name), ...unopenable] };
}

/** A project name from the data opened: a file's stem, a folder's name. */
export function projectNameFor(e: DataEntry): string {
  let s = e.name;
  if (!e.isDir) s = s.replace(/\.[a-z0-9]+$/i, '');
  if (/^project$/i.test(s)) s = parentName(e.path) || s;
  return s.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'project';
}

/** A path without Windows' verbatim prefix (`\\?\C:\…`, `\\?\UNC\server\…`),
 *  which older backends handed out: such a path takes no `/`, so a folder
 *  joined onto it with one (`<project>/octrees/…`) names nothing. */
export function plainPath(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:/.test(path)) return path.slice(4);
  return path;
}

/** The folder a path is in. */
export function parentDir(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : '';
}

function parentName(path: string): string {
  const dir = parentDir(path);
  const i = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
  return dir.slice(i + 1);
}

export function stemOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i <= 0 ? name : name.slice(0, i);
}

/** An entry for a picked file when the backend cannot classify it (an older build). */
export function entryFromPicked(p: { name: string; size: number; path: string }): DataEntry {
  return { path: p.path, name: p.name, isDir: false, size: p.size, kind: kindOfName(p.name), contents: [] };
}

// ---------------------------------------------------------------------------
// asking for data to be opened, from anywhere

const OPEN_EVENT = 'pointcloudlabeler:open-data';

/** Open `entries` through the door (DataDoor carries it out). */
export function requestOpenData(entries: DataEntry[]): void {
  window.dispatchEvent(new CustomEvent<DataEntry[]>(OPEN_EVENT, { detail: entries }));
}

export function onOpenDataRequest(cb: (entries: DataEntry[]) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent<DataEntry[]>).detail;
    if (Array.isArray(d)) cb(d);
  };
  window.addEventListener(OPEN_EVENT, h);
  return () => window.removeEventListener(OPEN_EVENT, h);
}

interface PickedFile { name: string; size: number; path: string }

interface DataDesktop {
  openFileDialog?: (opts?: { filters?: Array<{ name: string; extensions: string[] }> }) => Promise<PickedFile | null>;
  browseForFolder?: (title?: string) => Promise<string | null>;
  dataClassify?: (path: string) => Promise<unknown>;
}

function desktop(): DataDesktop | undefined {
  return (window as unknown as { desktop?: DataDesktop }).desktop;
}

/** The open dialog (a file, or a folder: a project or a folder of clouds),
 *  then the door. */
export async function pickData(mode: 'file' | 'folder'): Promise<void> {
  const d = desktop();
  let path: string | null = null;
  let picked: PickedFile | null = null;
  if (mode === 'file') {
    picked = (await d?.openFileDialog?.({ filters: OPEN_DATA_FILTERS })) ?? null;
    path = picked?.path ?? null;
  } else {
    path = (await d?.browseForFolder?.('Open a folder — a PointCloudLabeler project or a folder of point clouds')) ?? null;
  }
  if (!path) return;
  let entry: DataEntry | null = null;
  try {
    const v = await d?.dataClassify?.(path);
    if (v && typeof v === 'object') entry = v as DataEntry;
  } catch { /* an older backend: by the name */ }
  entry ??= picked ? entryFromPicked(picked) : { path, name: path.split(/[\\/]/).pop() ?? path, isDir: true, size: 0, kind: 'folder', contents: [] };
  requestOpenData([entry]);
}

// ---------------------------------------------------------------------------
// which part of the Data tab to show (the router sets it, the tab scrolls)

export type HubTarget = 'ptx';

let hub: { target: HubTarget | null; tick: number } = { target: null, tick: 0 };
const hubListeners = new Set<() => void>();

export function focusDataHub(target: HubTarget): void {
  hub = { target, tick: hub.tick + 1 };
  for (const l of hubListeners) l();
}

export function useDataHubFocus(): { target: HubTarget | null; tick: number } {
  return useSyncExternalStore(
    (l) => { hubListeners.add(l); return () => { hubListeners.delete(l); }; },
    () => hub,
    () => hub,
  );
}
