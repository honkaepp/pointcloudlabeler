// Import-time column mapping. Lets the user declare which source column
// (by name) fills each PointCloudLabeler role — X / Y / Z / tree_id / semantic /
// classification — for both TXT and LAS/LAZ imports. Columns left
// unmapped pass through as ordinary extras under their original names.
//
// X/Y/Z and tree_id are applied before/at parse time (they determine
// positions + instance ids); semantic + classification are resolved by
// name downstream (loadData seeds the editable semantic array and the
// ground mask from them). LAS X/Y/Z always come from the geometric LAS
// coordinates, so the dialog locks those rows for LAS files.
//
// WHAT IS REACHABLE TODAY
// -----------------------
// Only `suggestMapping` and `ROLE_INFO`. The two apply* functions below
// have no callers: the Rust importer took over conversion, and
// ImportMappingDialog's one call site opens it in `scannerOnly` mode, so
// the role-assignment path — and everything that consumed a
// ColumnMapping — is not on any route a user can take. The in-browser
// TXT and LAS decoders this fed are unreachable for the same reason (see
// io/sceneAxes, which says the same about its own mapping and asks that
// a revival not be a mirrored one).
//
// They are kept rather than deleted, and tested, for that reason: what
// is preserved has to be preserved CORRECT, or reviving it revives a
// defect. `applyMappingToHeader` had one — see the note on `idxOf`.

import type { HeaderInfo } from './parser/headerDetect';
import type { ParsedCloud } from './parseTxtStream';

export type ColumnRole = 'x' | 'y' | 'z' | 'h' | 'tree_id' | 'semantic' | 'classification';

export interface ColumnMapping {
  x: string | null;
  y: string | null;
  /** Absolute elevation column (above sea level). */
  z: string | null;
  /** Normalised height-above-ground column, when the file already carries
   *  one. Optional — if the cloud is loaded in H without this column, H is
   *  computed in-app from the ground surface. */
  h: string | null;
  tree_id: string | null;
  semantic: string | null;
  classification: string | null;
}

/** Role metadata for the import dialog — order here is the row order. */
export const ROLE_INFO: Array<{ role: ColumnRole; label: string; required: boolean; hint: string }> = [
  { role: 'x', label: 'X', required: true, hint: 'Easting / horizontal X coordinate.' },
  { role: 'y', label: 'Y', required: true, hint: 'Northing / horizontal Y coordinate.' },
  { role: 'z', label: 'Z — elevation (ASL)', required: false, hint: 'Absolute elevation above sea level.' },
  { role: 'h', label: 'H — above ground', required: false, hint: 'Normalised height above ground, if the file has it. Computed in-app otherwise.' },
  { role: 'tree_id', label: 'tree_id', required: false, hint: 'Instance segmentation id (0 = unassigned).' },
  { role: 'semantic', label: 'semantic', required: false, hint: 'Per-point stem/branch class (e.g. semantic_pred). 1 = stem, 2 = branch.' },
  { role: 'classification', label: 'classification', required: false, hint: 'ASPRS class — value 2 is treated as ground.' },
];

const find = (cols: string[], ...names: string[]): string | null => {
  for (const n of names) {
    const hit = cols.find(c => c.toLowerCase() === n);
    if (hit) return hit;
  }
  return null;
};

/** Heuristic default mapping from a column-name list. Mirrors the parser's
 *  auto-detection for the unambiguous positional roles (X / Y / Z / H /
 *  classification) so the dialog opens pre-filled with sensible guesses
 *  the user can correct.
 *
 *  tree_id and semantic are deliberately left null. They tend to live in
 *  arbitrarily-named extra columns ("id", "label", "preds_2024", "stem")
 *  and a guess based on name fragments was wrong as often as right —
 *  including when the file simply didn't carry them. The dialog now shows
 *  every available column and the user picks (or leaves "— none —"). */
export function suggestMapping(cols: string[]): ColumnMapping {
  // A normalised-height column resolved here is excluded from the Z guess so
  // a file carrying both an absolute Z and a precomputed AGL maps each to the
  // right role. Bare 'h' stays an absolute-Z fallback (matches the parser).
  const hGuess = find(cols, 'hag', 'agl', 'height_above_ground', 'norm_z', 'normalized_height',
    'height_normalized', 'z_norm', 'nz', 'chm', 'z_above_ground');
  return {
    x: find(cols, 'x'),
    y: find(cols, 'y'),
    z: find(cols, 'z', 'h'),
    h: hGuess,
    tree_id: null,
    semantic: null,
    classification: find(cols, 'classification', 'class'),
  };
}

/** Build a HeaderInfo with X/Y/Z/tree_id reassigned per the mapping, for the
 *  TXT parse path. Throws if a required positional column can't be resolved. */
export function applyMappingToHeader(base: HeaderInfo, mapping: ColumnMapping): HeaderInfo {
  // A role the user did not assign falls back to the parser's own guess;
  // a role they assigned to a column the file does not have is an error.
  //
  // These used to be the same case. `indexOf` returning -1 fell through
  // to the auto-detected index, so naming a missing column silently
  // imported a DIFFERENT one — the user says "X is 'easting'", the file
  // has no 'easting', and the cloud loads from whatever was guessed,
  // with every coordinate plausible and none of them the ones asked for.
  // The dialog only ever offers columns the file has, so nothing reaches
  // this today; a mapping carried across files — a preset, a batch
  // import — is exactly what a revival would add.
  const idxOf = (name: string | null, fallback: number): number => {
    if (!name) return fallback;
    const i = base.header.indexOf(name);
    if (i < 0) {
      throw new Error(
        `Import mapping names a column "${name}" that this file does not have. `
        + `Its columns are: ${base.header.join(', ')}`,
      );
    }
    return i;
  };
  const ix = idxOf(mapping.x, base.ix);
  const iy = idxOf(mapping.y, base.iy);
  // Parse positions in the absolute Z when present (so it stays available),
  // otherwise the H column — the post-parse axis step re-bases as needed.
  const iz = idxOf(mapping.z ?? mapping.h, base.iz);
  // tree_id is optional: unmapped means "this file has none", not "guess
  // one" — an instance id guessed from a column that happens to hold
  // integers would relabel every point.
  const iId = mapping.tree_id ? idxOf(mapping.tree_id, -1) : -1;
  if (ix < 0 || iy < 0 || iz < 0) {
    throw new Error('Import mapping is missing X, Y, or a vertical (Z or H) — assign them before importing.');
  }
  const extraIdx: number[] = [];
  const extraNames: string[] = [];
  for (let h = 0; h < base.header.length; h++) {
    if (h !== ix && h !== iy && h !== iz && h !== iId) {
      extraIdx.push(h);
      extraNames.push(base.header[h]);
    }
  }
  return { ...base, ix, iy, iz, iId, extraIdx, extraNames };
}

/** Post-parse structural part of the mapping: if tree_id was mapped to a
 *  column that survived as an extra (the LAS case — positions never consume
 *  it), move its integer values into treeIds and drop it from the extras so
 *  the instance id is represented once. No-op when tree_id was already
 *  consumed at parse time (TXT) or left unmapped. Returns a shallow copy;
 *  the input is not mutated. */
export function applyColumnMapping(parsed: ParsedCloud, mapping: ColumnMapping): ParsedCloud {
  const tid = mapping.tree_id;
  if (!tid || !(tid in parsed.extraCols)) return parsed;

  const src = parsed.extraCols[tid];
  const n = parsed.count;
  const treeIds = new Int32Array(n);
  if (Array.isArray(src)) {
    for (let i = 0; i < n; i++) treeIds[i] = Math.round(parseFloat(src[i]) || 0);
  } else {
    for (let i = 0; i < n; i++) treeIds[i] = Math.round((src as ArrayLike<number>)[i] ?? 0);
  }

  const extraCols = { ...parsed.extraCols };
  delete extraCols[tid];
  const columnOrder = parsed.columnOrder.filter(c => c !== tid);
  // Rebuild colIdx so the dropped column's index isn't referenced. Indices
  // are recomputed against the new columnOrder (x/y/z/tree_id keep slots
  // 0..3, extras follow in order).
  const extraNames = parsed.colIdx.extraNames.filter(c => c !== tid);
  const colIdx = {
    ...parsed.colIdx,
    extraNames,
    extraIdx: extraNames.map((_, k) => 4 + k),
  };
  return { ...parsed, treeIds, extraCols, columnOrder, colIdx };
}
