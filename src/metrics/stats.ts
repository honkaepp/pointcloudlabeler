// Order statistics, once.
//
// A median or a percentile means sorting, and sorting numbers in
// JavaScript means `(a, b) => a - b`, which returns NaN when either side
// is. The spec says a NaN comparison result is treated as +0 — "these
// two are equal" — so the sort simply leaves the value where it was and
// returns a sequence that is not sorted. Measured in V8:
//
//     [NaN, 1, 2, 4, 5]   sorts to  [NaN, 1, 2, 4, 5]   median 2
//     [1, 2, 4, 5, NaN]   sorts to  [1, 2, 4, 5, NaN]   median 4
//     [1, 2, NaN, 4, 5]   sorts to  [1, 2, NaN, 4, 5]   median NaN
//
// So the answer is not merely NaN. Depending on where the unmeasurable
// value happened to sit in the input, the median index lands on the
// wrong element and the result is a plausible WRONG NUMBER — 2 or 4
// where the finite values say 3, with no NaN anywhere to notice.
//
// PointCloudLabeler had four private implementations of this. Two filtered their
// input and were fine; two did not:
//
//   * report/generate.ts's median, feeding the plot summary.
//   * qcFlags.ts's median and MAD — which is the outlier detector. One
//     tree with an unmeasurable DBH turned its median and MAD into NaN,
//     every `|v − med| > 3·mad` comparison into false, and the panel
//     that exists to flag bad trees flagged nothing. The genuinely bad
//     tree beside it went unreported.
//
// A statistic over measurements that were not all made is a statistic
// over the ones that were. Non-finite values are dropped here, once,
// rather than each caller being trusted to remember.
//
// THE PERCENTILE CONVENTION
// -------------------------
// Linear interpolation at (n−1)·q — R's type 7, numpy's default, and
// what octree.rs's `percentile_sorted` already uses for the p25/p50/p75/
// p90/p95 rasters and summary PointCloudLabeler exports. The two TS call sites that
// used nearest-rank now agree with it: one codebase reporting a "95th
// percentile" two different ways is the divergence this module exists to
// end, and on a display scale the difference is one sample out of
// thousands.

/** Finite values only, ascending. The shared precondition of everything
 *  below — see the module note for what skipping it costs. */
function sortedFinite(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of values) if (Number.isFinite(v)) out.push(v);
  out.sort((a, b) => a - b);
  return out;
}

/** How many of `values` are usable. Callers that need to say "over 12 of
 *  17 trees" ask here rather than counting again. */
export function finiteCount(values: readonly number[]): number {
  let n = 0;
  for (const v of values) if (Number.isFinite(v)) n++;
  return n;
}

/** Percentile at q ∈ [0,1], linearly interpolated (type 7).
 *
 *  NaN when nothing is measurable, which is different from 0 and has to
 *  stay different: a plot with no measured heights has no median height,
 *  and reporting 0 would put it in the harvest queue. */
export function percentile(values: readonly number[], q: number): number {
  const s = sortedFinite(values);
  if (s.length === 0) return NaN;
  if (s.length === 1) return s[0];
  const qq = Number.isFinite(q) ? Math.min(1, Math.max(0, q)) : 0.5;
  const h = (s.length - 1) * qq;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, s.length - 1);
  const t = h - lo;
  return s[lo] * (1 - t) + s[hi] * t;
}

/** Median. NaN when nothing is measurable. */
export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

/** Median absolute deviation from `centre` (the median when omitted).
 *
 *  The robust spread the QC flags compare against. Zero is a real
 *  answer — every measurement identical — and callers must not read it
 *  as "no data"; that case is NaN. */
export function mad(values: readonly number[], centre?: number): number {
  const c = centre === undefined ? median(values) : centre;
  // Both of the next two lines are belt-and-braces over what `median`
  // already does, and the teeth check reports them as making no
  // difference: a non-finite centre turns every deviation into NaN,
  // which median drops, and an unfiltered input reaches a median that
  // filters. They stay because "a spread around no centre is not zero,
  // it is unknown" is the reason, and reconstructing it from median's
  // behaviour two calls away is how a later simplification loses it.
  if (!Number.isFinite(c)) return NaN;
  const dev: number[] = [];
  for (const v of values) if (Number.isFinite(v)) dev.push(Math.abs(v - c));
  return median(dev);
}

/** Mean of the largest `fraction` of the measurable values, and how many
 *  that was.
 *
 *  Dominant height — the mean of the tallest 10 % of a plot's trees — is
 *  a standard forestry statistic and the reason this is here rather than
 *  a sort at the call site. At least one value is always taken, so a
 *  plot of three trees still has a dominant height.
 *
 *  The count travels with the mean because a dominant height over two
 *  trees and one over two hundred are not the same claim, and the
 *  reader has no way to tell them apart from the number alone. */
export function topFractionMean(
  values: readonly number[], fraction: number,
): { value: number; count: number } {
  const s = sortedFinite(values);
  if (s.length === 0) return { value: NaN, count: 0 };
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 1;
  const count = Math.max(1, Math.ceil(s.length * f));
  let sum = 0;
  // sortedFinite is ascending, so the largest are at the end.
  for (let i = s.length - count; i < s.length; i++) sum += s[i];
  return { value: sum / count, count };
}

/** Arithmetic mean over the measurable values. NaN when there are none. */
export function mean(values: readonly number[]): number {
  let sum = 0, n = 0;
  for (const v of values) if (Number.isFinite(v)) { sum += v; n++; }
  return n === 0 ? NaN : sum / n;
}

/** Sample standard deviation (n−1), matching what octree.rs reports.
 *
 *  NaN below two measurable values: one sample has no spread to
 *  estimate, and 0 would claim it does. */
export function stdDev(values: readonly number[], centre?: number): number {
  const finite: number[] = [];
  for (const v of values) if (Number.isFinite(v)) finite.push(v);
  // One value would give sqrt(0/0) = NaN on its own; this says why
  // rather than leaving it to the arithmetic.
  if (finite.length < 2) return NaN;
  const m = centre === undefined || !Number.isFinite(centre) ? mean(finite) : centre;
  let acc = 0;
  for (const v of finite) acc += (v - m) ** 2;
  return Math.sqrt(acc / (finite.length - 1));
}
