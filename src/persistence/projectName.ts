// A project's name, and the per-project storage that follows it.
//
// A project is its folder, and the folder's name is the project's name:
// Rename Project renames both (src-tauri/src/commands/project_rename.rs),
// and a folder renamed in Explorer gives the project its new name. The
// name rules here are the Rust side's `name_problem`, so the dialog says
// what the backend would refuse before it is asked.
//
// This machine's storage keeps some things per project or per dataset under
// the folder's path — `pointcloudlabeler-file-layers:<folder>`, `pointcloudlabeler-views:<dir>`
// — and some settings hold paths inside a project. When a project's folder
// gets a new name or place, `migrateStoredPaths` moves every such key and
// value to it. The backend says when (`relocated` on the project it opened
// or renamed); running it twice changes nothing.

/** The longest project name (the Rust side's NAME_MAX). */
export const PROJECT_NAME_MAX = 100;

const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** What is wrong with `name` as a project (and so a folder) name, or null. */
export function projectNameProblem(name: string): string | null {
  const t = name.trim();
  if (!t) return 'Give the project a name.';
  if ([...t].length > PROJECT_NAME_MAX) return `A project name can be at most ${PROJECT_NAME_MAX} characters.`;
  if (t === '.' || t === '..') return '“.” and “..” are not names.';
  const bad = [...t].find((c) => '<>:"/\\|?*'.includes(c) || c.charCodeAt(0) < 32);
  if (bad !== undefined) {
    return `A project name cannot contain ${bad.charCodeAt(0) < 32 ? 'a control character' : `“${bad}”`} — it is its folder’s name too.`;
  }
  if (t.endsWith('.')) return 'A project name cannot end in a dot: Windows drops it from the folder’s name.';
  if (RESERVED.has(t.split('.')[0].trimEnd().toUpperCase())) return `“${t}” is a name Windows keeps for a device.`;
  return null;
}

/** The last component of a path as written. */
export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}

/** The folder a project named `name` has beside `folder`. */
export function siblingFolder(folder: string, name: string): string {
  const trimmed = folder.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return cut < 0 ? name : `${trimmed.slice(0, cut + 1)}${name.trim()}`;
}

const isSep = (c: string) => c === '/' || c === '\\';
const VERBATIM = /^(\\\\\?\\|\/\/\?\/)/;

/** `s` with the folder `from` at its start replaced by `to`, when `s` is
 *  that folder or a path inside it; null otherwise. Folders compare as
 *  Windows does — either separator, any case — and `to` is written the way
 *  `s` was: with its separator, a verbatim prefix kept, and in lower case
 *  when the matched part was (a key built from a lower-cased path). The
 *  Rust side's `rebase`. */
export function rebasePath(s: string, from: string, to: string): string | null {
  const prefix = VERBATIM.exec(s)?.[0] ?? '';
  const body = s.slice(prefix.length);
  const fromBody = from.replace(VERBATIM, '').replace(/[\\/]+$/, '');
  if (!fromBody || body.length < fromBody.length) return null;
  for (let i = 0; i < fromBody.length; i++) {
    const a = body[i], b = fromBody[i];
    if (isSep(a) || isSep(b) ? !(isSep(a) && isSep(b)) : a.toLowerCase() !== b.toLowerCase()) return null;
  }
  const rest = body.slice(fromBody.length);
  if (rest && !isSep(rest[0])) return null;
  const matched = body.slice(0, fromBody.length);
  const toBody = to.replace(VERBATIM, '').replace(/[\\/]+$/, '');
  let out = matched.includes('\\') ? toBody.replace(/\//g, '\\') : matched.includes('/') ? toBody.replace(/\\/g, '/') : toBody;
  if (/\p{L}/u.test(matched) && matched === matched.toLowerCase() && matched !== fromBody) out = out.toLowerCase();
  return `${prefix}${out}${rest}`;
}

/** Do `a` and `b` name the same folder? */
export function sameFolder(a: string, b: string): boolean {
  return rebasePath(a, b, b) !== null && rebasePath(b, a, a) !== null;
}

/** A storage key with the path in it moved: the path starts somewhere after
 *  the key's own prefix (`pointcloudlabeler-views:C:\…`). */
function rebaseKey(key: string, from: string, to: string): string | null {
  for (let i = 0; i < key.length; i++) {
    const moved = rebasePath(key.slice(i), from, to);
    if (moved !== null) return key.slice(0, i) + moved;
  }
  return null;
}

/** A stored value with the paths in it moved: every string of a JSON value,
 *  or the value itself when it is a plain string. */
function rebaseValue(value: string, from: string, to: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return rebasePath(value, from, to); }
  let changed = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = rebasePath(v, from, to);
      if (m !== null) { changed = true; return m; }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const mk = rebasePath(k, from, to);
        if (mk !== null) changed = true;
        out[mk ?? k] = walk(x);
      }
      return out;
    }
    return v;
  };
  const next = walk(parsed);
  return changed ? JSON.stringify(next) : null;
}

/** The part of Storage this needs (so a test can hand it a map). */
export interface KeyStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function localStore(): KeyStore | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** Move this machine's storage of the project at `from` to `to`: keys that
 *  name a path inside it, and the paths inside it that values hold. For a
 *  copy (`kept`: the project is still at `from`) the keys are copied and the
 *  values left alone. A key the new place has already is never overwritten,
 *  so running this again changes nothing. Returns how many entries moved. */
export function migrateStoredPaths(from: string, to: string, opts: { kept?: boolean } = {}, store: KeyStore | null = localStore()): number {
  if (!store || !from || !to || sameFolder(from, to)) return 0;
  const keys: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k !== null) keys.push(k);
    }
  } catch { return 0; }
  let moved = 0;
  for (const key of keys) {
    try {
      const value = store.getItem(key);
      if (value === null) continue;
      const newKey = rebaseKey(key, from, to);
      const newValue = rebaseValue(value, from, to);
      if (newKey !== null) {
        if (store.getItem(newKey) === null) store.setItem(newKey, newValue ?? value);
        if (!opts.kept) store.removeItem(key);
        moved++;
      } else if (newValue !== null && !opts.kept) {
        store.setItem(key, newValue);
        moved++;
      }
    } catch { /* storage unavailable: this entry stays where it was */ }
  }
  return moved;
}
