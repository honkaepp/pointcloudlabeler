// Handing a cloud file to the editor's import from anywhere (the data door,
// a layer that turns out to be a cloud): the same dialog and octree
// conversion as File → Open Data, without the file picker. EditorModule
// listens.

const IMPORT_EVENT = 'pointcloudlabeler:import-cloud';

export interface ImportRequest {
  name: string;
  size: number;
  path: string;
  /** The scanner, when the source says it: preselected in the import dialog. */
  scannerType?: 'TLS' | 'MLS' | 'ULS' | 'ALS' | 'other';
  /** Convert without the dialog, every attribute carried (a LAZ this
   *  program wrote: nothing to ask). */
  auto?: boolean;
}

interface StatDesktop {
  statFile?: (path: string) => Promise<unknown>;
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** A file or folder name from any name: what Windows and the LAS writers accept. */
export function safeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'data';
}

export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : `${dir}${sep}${name}`;
}

/** Ask the editor to import the cloud at `path`. */
export async function requestEditorImport(path: string, opts?: Pick<ImportRequest, 'scannerType' | 'auto'>): Promise<void> {
  let size = 0;
  try {
    const d = (window as unknown as { desktop?: StatDesktop }).desktop;
    const st = await d?.statFile?.(path) as { size?: number } | undefined;
    size = typeof st?.size === 'number' ? st.size : 0;
  } catch { /* the import dialog reads the size again if it needs it */ }
  window.dispatchEvent(new CustomEvent<ImportRequest>(IMPORT_EVENT, { detail: { name: baseName(path), size, path, ...opts } }));
}

/** EditorModule listens with this; returns the unsubscribe. */
export function onEditorImportRequest(cb: (f: ImportRequest) => void): () => void {
  const h = (e: Event) => {
    const d = (e as CustomEvent<ImportRequest>).detail;
    if (d && typeof d.path === 'string') cb(d);
  };
  window.addEventListener(IMPORT_EVENT, h);
  return () => window.removeEventListener(IMPORT_EVENT, h);
}
