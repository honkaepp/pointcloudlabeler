// One way to ask for a tree's measurements.
//
// `octree_tree_metrics` fits the DBH circle algebraically over the whole
// breast-height band. `octree_fit_stems` refines it with RANSAC, throwing
// out branch and understorey points that the algebraic fit is dragged by,
// and that refinement is the one the user explicitly asks for.
//
// It reached exactly one screen. The merge lived inside the Metrics
// table, so the report, the per-hectare figures, the validation against
// calipers, the thinning selection, the growth comparison and every
// export went on using the diameter the fit exists to replace — and DBH
// is squared into basal area, so the difference was amplified everywhere
// downstream. Two panels showed two diameters for one tree, each looking
// authoritative.
//
// So the loader, not the panel, decides: whoever asks for tree metrics
// gets the best diameter available for that dataset. A panel that wants
// the raw algebraic figure has to say so.

import type { TreeMetric, StemFit } from '../persistence/octreeReader';
import { DEFAULT_METRIC_PARAMS, type MetricParams } from './params';
import { mergeStemFits } from './plotStats';

/** The slice of the desktop bridge this needs. Panels each declare their
 *  own partial view of `window.desktop`; this is structurally compatible
 *  with all of them, and picks up `octreeReadStems` at runtime whether or
 *  not a given panel's local interface happens to name it. */
export interface MetricsSource {
  octreeTreeMetrics?: (dir: string, params: MetricParams) => Promise<TreeMetric[]>;
  octreeReadStems?: (dir: string) => Promise<StemFit[] | null>;
  /** Length + mtime of every file the metrics are computed from. Absent
   *  on an older desktop build, and on the web build; the cache below
   *  simply does not engage then. */
  octreeDatasetFingerprint?: (dir: string) => Promise<string>;
}

// ---------------------------------------------------------------------
// The cache.
//
// `octree_tree_metrics` is a full pass over the cloud and TEN panels ask
// for its answer — QC, Tree review, Metrics, Report, Validation,
// Thinning, Density, Plot boundary, Growth, Cross-sensor. Three of them
// used to start their own pass merely because the panel was opened, so
// arranging four windows on screen measured the same plot four times.
//
// WHAT MAKES A CACHE HERE SAFE. Every one of those panels presents these
// numbers as measurements, so serving a stale row is worse than
// recomputing: it is a wrong DBH under a confident heading. The usual
// approach — invalidate from each place that mutates the dataset — works
// until someone adds an eleventh way to change a tree_id, and the
// failure is silent.
//
// So the cache validates rather than trusts. Every request first asks
// the backend for a fingerprint of the files the answer depends on
// (`octree_dataset_fingerprint`: length + mtime of octree.bin,
// patches.bin, treemap.json, metadata.json, stems.json). A stat of five
// files is microseconds against a pass over millions of points, and it
// catches a change made by ANY route, including one made outside the
// app. When the fingerprint moves, so does the cache key, and nothing
// has to remember to call an invalidator.
//
// `invalidateTreeMetrics` still exists for the case the fingerprint
// cannot see: a user who simply wants the numbers computed again.
// ---------------------------------------------------------------------

interface CacheEntry {
  rows: TreeMetric[];
  /** When the pass that produced these finished (epoch ms). */
  at: number;
}

/** Completed results, keyed by dataset + params + fingerprint.
 *
 *  Bounded: every edit to a dataset makes a NEW key (the fingerprint
 *  moved), so an afternoon of correcting one plot would otherwise keep
 *  every intermediate answer alive — a row per tree per edit. Insertion
 *  order is eviction order, oldest first, which for a Map is free. */
const cache = new Map<string, CacheEntry>();
/** How many results to keep. Enough for a couple of datasets open at
 *  once plus their recent history; small enough that the memory is
 *  bounded by something other than how long the session has run. */
const CACHE_MAX = 8;
/** Passes currently running, so four panels opening at once share one.
 *  Keyed identically, and removed as soon as the promise settles. */
const inFlight = new Map<string, Promise<TreeMetric[]>>();

function cacheKey(dir: string, params: MetricParams, fingerprint: string): string {
  return `${dir}\u0000${fingerprint}\u0000${params.crownCell}/${params.bhLow}/${params.bhHigh}/${params.dtmCell}`;
}

/** Drop cached metrics — for `dir` alone, or all of them.
 *
 *  The fingerprint already covers every change to the DATA. This is for
 *  the other reason to recompute: the user asking for it. A "Recompute"
 *  button that returned the cached rows because nothing on disk had
 *  moved would be a button that does nothing. */
export function invalidateTreeMetrics(dir?: string): void {
  if (dir === undefined) { cache.clear(); inFlight.clear(); return; }
  const prefix = `${dir}\u0000`;
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
  for (const k of [...inFlight.keys()]) if (k.startsWith(prefix)) inFlight.delete(k);
}

/** Metrics for a dataset IF they are already measured and still valid —
 *  never a computation.
 *
 *  This is what a panel calls on mount: it can show the numbers straight
 *  away when another panel has already measured the plot, and show its
 *  "Compute" button when nobody has, without a full pass either way. The
 *  fingerprint is checked, so what comes back describes the cloud as it
 *  is now; a peek that skipped that check would be a fast way to display
 *  a stale DBH. */
export async function cachedTreeMetrics(
  desktop: MetricsSource | undefined | null,
  dir: string,
  params: MetricParams = DEFAULT_METRIC_PARAMS,
): Promise<{ rows: TreeMetric[]; at: number } | null> {
  if (!desktop?.octreeDatasetFingerprint) return null;
  let fingerprint: string;
  try {
    fingerprint = await desktop.octreeDatasetFingerprint(dir);
  } catch {
    return null;
  }
  const hit = cache.get(cacheKey(dir, params, fingerprint));
  return hit ? { rows: hit.rows, at: hit.at } : null;
}

/** How many datasets are held. Tests assert on this; nothing else should
 *  need it. */
export function treeMetricsCacheSize(): number {
  return cache.size;
}

/** The persisted stem fits for a dataset, keyed by tree, or null when the
 *  fit has never been run on it. Never throws: an unreadable sidecar
 *  means "no refinement available", not "no metrics". */
export async function loadStemFits(
  desktop: MetricsSource | undefined | null,
  dir: string,
): Promise<Map<number, StemFit> | null> {
  if (!desktop?.octreeReadStems || !dir) return null;
  try {
    const raw = await desktop.octreeReadStems(dir);
    if (!raw || raw.length === 0) return null;
    return new Map(raw.map(f => [f.treeId, f]));
  } catch {
    return null;
  }
}

/** Per-tree metrics for a dataset, with RANSAC-refined diameters folded
 *  in where the stem fit has been run.
 *
 *  Cached — see the block above. The cache is keyed on a fingerprint of
 *  the files the answer depends on, so it can only ever return rows that
 *  still describe the cloud on disk; `force` is for the user asking for
 *  a fresh pass anyway.
 *
 *  Throws whatever `octreeTreeMetrics` throws — that failure is real and
 *  the caller has to show it. The stem fits are the optional half. */
export async function loadTreeMetrics(
  desktop: MetricsSource | undefined | null,
  dir: string,
  params: MetricParams = DEFAULT_METRIC_PARAMS,
  opts?: { force?: boolean },
): Promise<TreeMetric[]> {
  if (!desktop?.octreeTreeMetrics) {
    throw new Error('Tree metrics are not available in this build');
  }

  // No fingerprint command (older desktop build, or the web build):
  // compute every time, exactly as before this cache existed. A cache
  // that cannot tell when it went stale is not one to fall back to.
  let fingerprint: string | null = null;
  if (desktop.octreeDatasetFingerprint) {
    try {
      fingerprint = await desktop.octreeDatasetFingerprint(dir);
    } catch {
      // A dataset whose files cannot be stat'd is one whose metrics we
      // should not be serving from memory either.
      fingerprint = null;
    }
  }
  if (fingerprint === null) return computeTreeMetrics(desktop, dir, params);

  const key = cacheKey(dir, params, fingerprint);
  if (opts?.force) { cache.delete(key); inFlight.delete(key); }
  else {
    const hit = cache.get(key);
    if (hit) return hit.rows;
    // Four panels mounting at once must share ONE pass, not start four.
    const running = inFlight.get(key);
    if (running) return running;
  }

  const promise = computeTreeMetrics(desktop, dir, params)
    .then(rows => {
      cache.set(key, { rows, at: Date.now() });
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
      }
      return rows;
    })
    .finally(() => {
      // Only if it is still ours: a `force` between start and finish
      // replaced it, and dropping the newer entry would strand its
      // waiters on a promise nothing resolves.
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

/** The pass itself, with no caching — the only place that calls the
 *  backend. */
async function computeTreeMetrics(
  desktop: MetricsSource,
  dir: string,
  params: MetricParams,
): Promise<TreeMetric[]> {
  const metrics = await desktop.octreeTreeMetrics!(dir, params);
  // Read the fits after the metrics, not in parallel: a fit run started
  // from the Metrics panel writes stems.json at the end of its pass, and
  // reading second is the ordering that picks up a fit finishing now
  // rather than the one before it.
  const fits = await loadStemFits(desktop, dir);
  return mergeStemFits(metrics, fits);
}
