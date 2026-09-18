import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { median, percentile, mad, mean, stdDev, finiteCount, topFractionMean } from './stats';

describe('percentile', () => {
  /** The same fixture and the same three values octree.rs pins for
   *  `percentile_sorted`. PointCloudLabeler reports p25/p50/p75/p90/p95 from Rust in
   *  its density rasters and summary; a TypeScript percentile that
   *  disagreed would put two different answers to "the 95th percentile"
   *  in front of the same user. */
  it('matches the convention the Rust side exports', () => {
    const v = Array.from({ length: 11 }, (_, i) => i);   // 0..10
    expect(percentile(v, 0.5)).toBeCloseTo(5, 12);
    expect(percentile(v, 0.25)).toBeCloseTo(2.5, 12);    // type-7 interpolation
    expect(percentile(v, 0.75)).toBeCloseTo(7.5, 12);
  });

  it('still says so in the Rust source', () => {
    const rust = readFileSync('src-tauri/src/commands/octree.rs', 'utf8');
    const fn = /fn percentile_sorted\(sorted: &\[f32\], q: f64\) -> f64 \{[\s\S]*?\n\}/.exec(rust);
    expect(fn, 'percentile_sorted not found').not.toBeNull();
    // (n − 1) · q, then interpolate between the bracketing samples.
    expect(fn![0]).toMatch(/\(n - 1\) as f64 \* q/);
    expect(fn![0]).toMatch(/1\.0 - t/);
  });

  it('hits the ends exactly', () => {
    const v = [3, 1, 4, 1, 5, 9, 2, 6];
    expect(percentile(v, 0)).toBe(1);
    expect(percentile(v, 1)).toBe(9);
  });

  it('clamps a nonsense q instead of indexing outside the array', () => {
    const v = [1, 2, 3, 4, 5];
    expect(percentile(v, -1)).toBe(1);
    expect(percentile(v, 2)).toBe(5);
    expect(percentile(v, NaN)).toBe(3);      // falls back to the median
  });

  it('is monotone in q', () => {
    const v = [2, 8, 1, 9, 4, 6, 3, 7, 5];
    let prev = -Infinity;
    for (let q = 0; q <= 1; q += 0.01) {
      const p = percentile(v, q);
      expect(p).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = p;
    }
  });

  it('handles one value and none', () => {
    expect(percentile([7], 0.9)).toBe(7);
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe('median', () => {
  it('is the middle of an odd list and the mean of the middle two', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('does not care what order it is given', () => {
    const v = [5, 3, 8, 1, 9, 2];
    expect(median(v)).toBe(median([...v].reverse()));
    expect(median(v)).toBe(median([...v].sort()));
  });

  it('does not mutate its input', () => {
    const v = [5, 3, 8, 1];
    median(v);
    expect(v).toEqual([5, 3, 8, 1]);
  });

  /** The defect this module exists for.
   *
   *  `(a, b) => a - b` returns NaN when either side is, and the spec
   *  treats a NaN comparison result as "equal", so the sort leaves the
   *  value where it was and returns a sequence that is not sorted. The
   *  median index then lands on the wrong element. Measured in V8 with
   *  the unguarded implementation:
   *
   *      [NaN, 1, 2, 4, 5]  ->  median 2
   *      [1, 2, 4, 5, NaN]  ->  median 4
   *      [1, 2, NaN, 4, 5]  ->  median NaN
   *
   *  Not merely NaN: a plausible wrong number, and which one depends on
   *  where the unmeasurable value happened to sit in the input. */
  it('is not moved by where an unmeasurable value sat in the input', () => {
    const truth = median([1, 2, 4, 5]);       // 3
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (const arr of [
        [bad, 1, 2, 4, 5],
        [1, 2, bad, 4, 5],
        [1, 2, 4, 5, bad],
        [1, bad, 2, bad, 4, 5],
      ]) {
        expect(median(arr), `${bad} in ${JSON.stringify(arr)}`).toBe(truth);
      }
    }
  });

  it('answers NaN when nothing was measurable, not zero', () => {
    // Zero is a plot with trees of no height; NaN is a plot whose
    // heights were never measured. Reporting the first for the second
    // would put it in the harvest queue.
    expect(median([NaN, NaN])).toBeNaN();
    expect(median([])).toBeNaN();
  });

  it('keeps a real zero', () => {
    expect(median([0, 0, 0])).toBe(0);
    expect(median([-1, 0, 1])).toBe(0);
  });
});

describe('mad', () => {
  it('is the median of the absolute deviations', () => {
    // deviations from 5: 4,2,0,2,4 -> median 2
    expect(mad([1, 3, 5, 7, 9])).toBe(2);
  });

  it('takes an explicit centre', () => {
    expect(mad([1, 3, 5, 7, 9], 5)).toBe(2);
    expect(mad([1, 3, 5, 7, 9], 1)).toBe(4);   // deviations 0,2,4,6,8
  });

  it('is zero when every measurement agrees, which is a real answer', () => {
    expect(mad([4, 4, 4, 4])).toBe(0);
  });

  /** The failure that made this worth finding. qcFlags compares
   *  `|v − med| > 3·mad` to flag outliers. With an unguarded median one
   *  unmeasurable tree turned med and mad into NaN, every comparison
   *  into false, and the panel that exists to flag bad trees flagged
   *  nothing — including the genuinely bad tree beside it. */
  it('survives an unmeasurable tree, so the outlier beside it is still found', () => {
    const clean = [0.21, 0.23, 0.25, 0.24, 0.22, 0.60];
    const withGap = [0.21, 0.23, NaN, 0.24, 0.22, 0.60];
    const flagged = (a: number[]) => {
      const m = median(a);
      const d = mad(a, m);
      return a.filter(v => Number.isFinite(v) && Math.abs(v - m) > 3 * d);
    };
    expect(flagged(clean)).toEqual([0.6]);
    expect(flagged(withGap), 'the outlier must still be flagged').toEqual([0.6]);
  });

  it('answers NaN when there is no centre to deviate from', () => {
    expect(mad([])).toBeNaN();
    expect(mad([NaN, NaN])).toBeNaN();
    expect(mad([1, 2, 3], NaN)).toBeNaN();
  });
});

describe('mean and stdDev', () => {
  it('averages the measurable values', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([1, NaN, 3])).toBe(2);
    expect(mean([])).toBeNaN();
    expect(mean([NaN])).toBeNaN();
  });

  /** A single unguarded NaN in a sum poisons it silently and completely:
   *  `1 + NaN + 3` is NaN, and a mean of NaN reads on screen as "—". */
  it('is not poisoned by one unmeasurable value', () => {
    expect(mean([1, 2, NaN, 4, 5])).toBe(3);
  });

  it('uses the n−1 denominator, matching what the Rust side reports', () => {
    // sd of 2,4,4,4,5,5,7,9 is 2 with n, 2.138… with n−1.
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.13809, 4);
  });

  it('has no spread to report below two measurable values', () => {
    expect(stdDev([5])).toBeNaN();
    expect(stdDev([5, NaN])).toBeNaN();
    expect(stdDev([])).toBeNaN();
    expect(stdDev([5, 5])).toBe(0);        // two identical IS zero spread
  });

  it('counts what it used', () => {
    expect(finiteCount([1, NaN, 3, Infinity, 5])).toBe(3);
    expect(finiteCount([])).toBe(0);
  });
});

describe('topFractionMean', () => {
  /** Dominant height: the mean of the tallest 10 %. */
  it('averages the largest fraction', () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(topFractionMean(v, 0.1)).toEqual({ value: 10, count: 1 });
    expect(topFractionMean(v, 0.3)).toEqual({ value: 9, count: 3 });   // 8,9,10
    expect(topFractionMean(v, 1)).toEqual({ value: 5.5, count: 10 });
  });

  it('does not care what order it is given', () => {
    const v = [7, 2, 9, 4, 1];
    expect(topFractionMean(v, 0.4)).toEqual(topFractionMean([...v].reverse(), 0.4));
  });

  /** A plot of three trees still has a dominant height. Rounding the
   *  count to zero would make it NaN and drop the plot from a summary
   *  that should have said "over 3 trees". */
  it('always takes at least one', () => {
    expect(topFractionMean([4, 5, 6], 0.01)).toEqual({ value: 6, count: 1 });
    expect(topFractionMean([4, 5, 6], 0)).toEqual({ value: 6, count: 1 });
  });

  it('ignores unmeasurable trees rather than being poisoned by them', () => {
    // Four measurable values, so ceil(4 x 0.5) = 2: the top two are
    // 4 and 10. The two unmeasurable trees do not inflate the count.
    expect(topFractionMean([1, NaN, 3, 4, NaN, 10], 0.5))
      .toEqual({ value: 7, count: 2 });
  });

  it('reports nothing, and no count, for a plot with no measured heights', () => {
    const r = topFractionMean([NaN, NaN], 0.1);
    expect(r.value).toBeNaN();
    expect(r.count).toBe(0);
  });

  it('survives a nonsense fraction', () => {
    expect(topFractionMean([1, 2, 3], -1).count).toBe(1);
    expect(topFractionMean([1, 2, 3], 5).count).toBe(3);
    expect(topFractionMean([1, 2, 3], NaN).count).toBe(3);
  });
});

/** Everything above is worth nothing if a fifth private copy appears.
 *  Four existed: two filtered their input and were right, two did not
 *  and were wrong — and no individual file showed it. Only putting them
 *  side by side did. */
describe('one implementation of each order statistic', () => {
  function* walk(dir: string): Generator<string> {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) yield* walk(p);
      else if (/\.tsx?$/.test(e) && !/\.test\./.test(e)) yield p;
    }
  }

  it('is not redefined outside metrics/stats.ts', () => {
    const NAMES = ['median', 'percentile', 'quantile', 'mad', 'stdDev', 'mean'];
    const offenders: string[] = [];
    for (const file of walk('src')) {
      if (file === join('src', 'metrics', 'stats.ts')) continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const l = line.trim();
        for (const n of NAMES) {
          // Both spellings. Catching only `function median` let an arrow
          // `const mad = (a, m) => …` back in, and the teeth check found
          // it — a scan that misses half the ways to declare a function
          // reports clean while the copy it exists to prevent is there.
          // `const median = someCall(x)` is a value, not a definition,
          // so the `(` must follow the `=` directly.
          const redefined =
            new RegExp(`^(export\\s+)?function\\s+${n}\\b`).test(l)
            || new RegExp(`^(export\\s+)?(const|let)\\s+${n}\\s*(:[^=]*)?=\\s*(\\(|function\\b|async\\b)`).test(l);
          if (redefined) offenders.push(`${file}:${i + 1}: ${l}`);
        }
      });
    }
    expect(offenders, `redefined outside metrics/stats.ts:\n${offenders.join('\n')}`).toEqual([]);
  });

  /** A sort of numbers that has not filtered its input first is the
   *  shape of the defect, wherever it appears. */
  it('never sorts numbers without dropping the unmeasurable ones', () => {
    const offenders: string[] = [];
    for (const file of walk('src')) {
      if (file === join('src', 'metrics', 'stats.ts')) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const l = line.trim();
        // A numeric comparator: `(a, b) => a - b` or its descending twin.
        if (!/\.sort\(\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*=>\s*\w+\s*-\s*\w+\s*\)/.test(l)) return;
        // Fine if the values were filtered on the same line or just above.
        const context = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
        if (/isFinite|finiteCount|filter\(Number\.isFinite\)/.test(context)) return;
        // …or if they are integers by construction (class codes, ids).
        if (/hidden|code|Id\b|ids\b|edges|bounds/i.test(l)) return;
        offenders.push(`${file}:${i + 1}: ${l}`);
      });
    }
    expect(offenders, `unguarded numeric sort:\n${offenders.join('\n')}`).toEqual([]);
  });
});
