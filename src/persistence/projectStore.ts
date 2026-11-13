// Renderer-side wrapper around the project IPC. Keeps the project state in React
// state so children can observe it; persists nothing locally (main owns the source
// of truth).
//
// A project's name is its folder's name. Rename Project renames both
// (renameProject), and a project found in a folder other than the one it was
// last opened from — renamed or moved in Explorer, or copied — comes with
// `relocated`; adoptProject then moves this machine's per-project storage
// keys to the new place (persistence/projectName.ts).

import { migrateStoredPaths } from './projectName';

export interface ProjectMeta {
  version: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  coordinateSystem: { epsg: number | null; name: string; vertical?: string };
  defaultCloudFormat: string;
  notes: string;
  /** The folder the project was last opened from. */
  lastFolder?: string;
}

/** A project found somewhere other than where it was last opened. */
export interface ProjectRelocation {
  /** Where it was. */
  from: string;
  /** Still there too: a copy, not a move. */
  kept: boolean;
  /** Paths stored inside the project that were moved with it. */
  paths: number;
}

export interface ProjectState {
  folder: string;
  meta: ProjectMeta;
  relocated?: ProjectRelocation;
}

/** What Rename Project did (commands/project_rename.rs). */
export interface RenameOutcome {
  folder: string;
  name: string;
  relocated?: ProjectRelocation;
  /** The project, open again, when it was the open one. */
  project?: ProjectState;
}

export interface ProjectCreateOpts {
  folder: string;
  name: string;
  coordinateSystem?: { epsg: number | null; name: string; vertical?: string };
  defaultCloudFormat?: string;
  notes?: string;
}

export interface RecentProject {
  folder: string;
  name: string;
  updatedAt: number;
  exists: boolean;
}

interface DesktopProjectAPI {
  projectCurrent: () => Promise<ProjectState | null>;
  projectCreate: (opts: ProjectCreateOpts) => Promise<ProjectState | null>;
  projectOpen: (folder: string) => Promise<ProjectState | null>;
  projectClose: () => Promise<boolean>;
  projectSaveMeta: (patch: Partial<ProjectMeta>) => Promise<ProjectMeta>;
  projectRecent: () => Promise<RecentProject[]>;
  projectRemoveRecent: (folder: string) => Promise<string[]>;
  projectBrowseForFolder: (mode: 'new' | 'open') => Promise<string | null>;
  projectRename?: (folder: string, name: string) => Promise<RenameOutcome>;
  projectRenameCheck?: (folder: string, name: string) => Promise<string>;
}

function api(): DesktopProjectAPI | null {
  const a = (window as unknown as { desktop?: Partial<DesktopProjectAPI> }).desktop;
  if (!a || typeof a.projectCurrent !== 'function') return null;
  return a as DesktopProjectAPI;
}

export function projectsAvailable(): boolean { return api() !== null; }

export async function getCurrent(): Promise<ProjectState | null> {
  return api()?.projectCurrent() ?? null;
}
export async function createProject(opts: ProjectCreateOpts): Promise<ProjectState | null> {
  return api()?.projectCreate(opts) ?? null;
}
export async function openProject(folder: string): Promise<ProjectState | null> {
  return adoptProject(await api()?.projectOpen(folder) ?? null);
}
export async function closeProject(): Promise<boolean> {
  return api()?.projectClose() ?? false;
}
export async function listRecent(): Promise<RecentProject[]> {
  return api()?.projectRecent() ?? [];
}
export async function removeRecent(folder: string): Promise<void> {
  await api()?.projectRemoveRecent(folder);
}
export async function browseForFolder(mode: 'new' | 'open'): Promise<string | null> {
  return api()?.projectBrowseForFolder(mode) ?? null;
}

/** The project as opened, with this machine's storage of it moved
 *  when it was found somewhere new. Every way a project arrives goes through
 *  here (the open call, project:changed); moving twice changes nothing. */
export function adoptProject(p: ProjectState | null): ProjectState | null {
  if (p?.relocated) migrateStoredPaths(p.relocated.from, p.folder, { kept: p.relocated.kept });
  return p;
}

/** What would stop renaming the project at `folder` to `name`
 *  (the name, a folder of that name, a job writing into it) — thrown, before
 *  anything is closed. Resolves to the folder's new path. */
export async function checkRename(folder: string, name: string): Promise<string> {
  const check = api()?.projectRenameCheck;
  if (!check) throw new Error('Renaming a project needs the desktop application.');
  return check(folder, name);
}

/** Rename the project at `folder` — its folder and its name. The
 *  storage keys move with it; an open project comes back open. */
export async function renameProject(folder: string, name: string): Promise<RenameOutcome> {
  const rename = api()?.projectRename;
  if (!rename) throw new Error('Renaming a project needs the desktop application.');
  const out = await rename(folder, name);
  if (out.relocated) migrateStoredPaths(out.relocated.from, out.folder, { kept: out.relocated.kept });
  return out;
}

// Common Finnish + global coordinate systems to offer in the New Project dialog.
// Users can also enter a custom EPSG code.
export const COORD_PRESETS: Array<{ epsg: number; name: string; vertical?: string }> = [
  { epsg: 3067, name: 'ETRS89 / TM35FIN(E,N)', vertical: 'N2000' },
  { epsg: 3879, name: 'ETRS89 / GK25FIN' },
  { epsg: 3878, name: 'ETRS89 / GK24FIN' },
  { epsg: 3880, name: 'ETRS89 / GK26FIN' },
  { epsg: 2393, name: 'KKJ / Finland Uniform Coordinate System (legacy)' },
  { epsg: 2056, name: 'CH1903+ / LV95 (Switzerland)', vertical: 'LN02 / LHN95' },
  { epsg: 21781, name: 'CH1903 / LV03 (Switzerland, legacy)' },
  { epsg: 4326, name: 'WGS 84 (geographic)' },
  { epsg: 3857, name: 'WGS 84 / Web Mercator' },
  { epsg: 32634, name: 'WGS 84 / UTM zone 34N' },
  { epsg: 32635, name: 'WGS 84 / UTM zone 35N' },
  { epsg: 32632, name: 'WGS 84 / UTM zone 32N (CH, AT)' },
];
