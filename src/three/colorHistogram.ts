// The colour mode's values over the loaded points, for stretching
// its ramp: a histogram over the sampled range and the percentiles a stretch
// cuts at (the Display panel's range editor, the legend's Auto).
//
// The loaded nodes are a spatially even sample of the cloud (every level
// down to what the view needs), so a histogram of them is the cloud's within
// the precision a ramp needs. At most `MAX_SAMPLES` values are read.

import type { ColorHistogram } from '../components/shell/OctreeShellContext';

export const MAX_SAMPLES = 1_500_000;
/** Bins of the fine pass the percentiles are read from. */
const FINE_BINS = 4096;

export function histogramOf<N>(
  nodes: N[], count: (n: N) => number, value: (n: N, i: number) => number,
  key: string, bins = 96, maxSamples = MAX_SAMPLES,
): ColorHistogram | null {
  let total = 0;
  for (const n of nodes) total += count(n);
  if (total === 0) return null;
  const stride = Math.max(1, Math.ceil(total / maxSamples));
  const vals = new Float64Array(Math.ceil(total / stride) + nodes.length);
  let k = 0;
  let lo = Infinity, hi = -Infinity;
  let phase = 0;
  for (const n of nodes) {
    const c = count(n);
    for (let i = phase; i < c; i += stride) {
      const v = value(n, i);
      if (!Number.isFinite(v)) continue;
      vals[k++] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    phase = (phase + stride - (c % stride)) % stride;
  }
  if (k === 0 || !(hi >= lo)) return null;
  if (hi === lo) hi = lo + 1;
  const fine = new Float64Array(FINE_BINS);
  const fw = (hi - lo) / FINE_BINS;
  for (let j = 0; j < k; j++) fine[Math.min(FINE_BINS - 1, Math.floor((vals[j] - lo) / fw))]++;
  const at = (q: number): number => {
    const want = q * k;
    let acc = 0;
    for (let b = 0; b < FINE_BINS; b++) {
      acc += fine[b];
      if (acc >= want) return lo + (b + 0.5) * fw;
    }
    return hi;
  };
  const counts = new Array<number>(bins).fill(0);
  const per = FINE_BINS / bins;
  for (let b = 0; b < FINE_BINS; b++) counts[Math.min(bins - 1, Math.floor(b / per))] += fine[b];
  return { key, lo, hi, counts, p: { p1: at(0.01), p2: at(0.02), p98: at(0.98), p99: at(0.99) }, samples: k };
}

/** A tidy bound for a stretch: rounded to the histogram's resolution. */
export function tidy(v: number, lo: number, hi: number): number {
  const step = Math.pow(10, Math.floor(Math.log10(Math.max(1e-9, (hi - lo) / 200))));
  return Math.round(v / step) * step;
}
