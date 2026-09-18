// Renderer-side wrapper around the project IPC. Keeps the project state in React
// state so children can observe it; persists nothing locally (main owns the source
// of truth).

export interface ProjectMeta {
  version: number;
  name: string;
  createdAt: number;
  updatedAt: number;
  coordinateSystem: { epsg: number | null; name: string; vertical?: string };
  defaultCloudFormat: string;
  notes: string;
}

export interface ProjectState {
  folder: string;
  meta: ProjectMeta;
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
  return api()?.projectOpen(folder) ?? null;
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
