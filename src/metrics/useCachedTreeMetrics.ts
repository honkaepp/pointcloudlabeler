// Seed a panel from metrics another panel has already measured.
//
// Ten panels want the per-tree metrics and each holds its own copy in
// React state, because each also has its own idea of when to compute and
// what to do while it is computing. That is fine — what was not fine is
// that opening a second panel measured the plot a second time.
//
// `loadTreeMetrics` fixed the measuring. This fixes the WAITING: a panel
// that opens after the plot has been measured should show the numbers,
// not a "Compute metrics" button over data that already exists. The hook
// only ever reads the cache — it never starts a pass — so mounting a
// panel remains free.
//
// Deliberately not a full state hook. Each panel keeps its own `metrics`
// state and its own compute path; this just hands it a starting value.

import { useEffect, useState } from 'react';
import type { TreeMetric } from '../persistence/octreeReader';
import { cachedTreeMetrics, type MetricsSource } from './loadMetrics';
import { DEFAULT_METRIC_PARAMS, type MetricParams } from './params';

export interface CachedMetrics {
  rows: TreeMetric[];
  /** When the pass that produced them finished (epoch ms). */
  at: number;
}

/** Metrics already measured for `dir` and still valid for what is on
 *  disk, or null. Re-checks whenever the dataset changes.
 *
 *  `bump` is an opaque value a panel can change to make the hook look
 *  again — after its own compute, or after an edit it knows about. */
export function useCachedTreeMetrics(
  desktop: MetricsSource | undefined | null,
  dir: string | null | undefined,
  params: MetricParams = DEFAULT_METRIC_PARAMS,
  bump?: unknown,
): CachedMetrics | null {
  const [hit, setHit] = useState<CachedMetrics | null>(null);
  // Spread the params into the dep list rather than the object: a panel
  // that builds its params inline creates a new object every render, and
  // depending on the object would re-run this effect forever.
  const { crownCell, bhLow, bhHigh, dtmCell } = params;

  useEffect(() => {
    let cancelled = false;
    setHit(null);
    if (!desktop || !dir) return;
    void cachedTreeMetrics(desktop, dir, { crownCell, bhLow, bhHigh, dtmCell })
      .then(found => { if (!cancelled) setHit(found); })
      .catch(() => { if (!cancelled) setHit(null); });
    return () => { cancelled = true; };
  }, [desktop, dir, crownCell, bhLow, bhHigh, dtmCell, bump]);

  return hit;
}
