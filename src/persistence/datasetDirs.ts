/** One dataset directory, two spellings.
 *
 *  The project list comes from the Rust side, which walks the octrees
 *  folder and hands back each path as the OS spells it — backslashes on
 *  Windows. The importer's output path is built on the JS side with a
 *  forward slash. The same dataset is then `…\octrees\Evo` in the list
 *  and `…/octrees/Evo` on the cloud opened straight after import, and
 *  every `===` between the two says they are different clouds: the
 *  Skeleton Transfer panel offered the baseline as its own target and
 *  hid the height-frame choice, because the open cloud matched no list
 *  entry. Directories are compared here, by what they name. */

export function normalizeDir(dir: string): string {
  let d = dir.replace(/\\/g, '/');
  // A UNC/verbatim prefix Rust's canonicalize can add on Windows.
  if (d.startsWith('//?/')) d = d.slice(4);
  d = d.replace(/\/{2,}/g, '/');
  if (d.length > 1) d = d.replace(/\/+$/, '');
  // Windows paths are case-insensitive; a Linux path that differs only
  // in case is not something this application produces.
  return d.toLowerCase();
}

export function sameDir(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a === b || normalizeDir(a) === normalizeDir(b);
}

/** The list entry that names `dir`, whichever way either is spelled. */
export function findDir<T extends { dir: string }>(list: readonly T[], dir: string | null | undefined): T | undefined {
  if (!dir) return undefined;
  return list.find((e) => e.dir === dir) ?? list.find((e) => sameDir(e.dir, dir));
}
