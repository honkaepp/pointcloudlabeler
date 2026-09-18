import { describe, it, expect, beforeEach } from 'vitest';
import type { TreeMetric, StemFit } from '../persistence/octreeReader';
import {
  loadStemFits, loadTreeMetrics, invalidateTreeMetrics, cachedTreeMetrics,
  treeMetricsCacheSize, type MetricsSource,
} from './loadMetrics';
import { mergeStemFits, countRefined } from './plotStats';
import { DEFAULT_METRIC_PARAMS, type MetricParams } from './params';

function tree(treeId: number, dbh: number): TreeMetric {
  return {
    treeId, count: 4000, height: 20, dbh,
    basalArea: Number.isFinite(dbh) && dbh > 0 ? Math.PI * (dbh / 2) ** 2 : NaN,
    crownArea: 12, crownDiameter: 3.9,
    x: treeId, y: 0, baseZ: 0, leanDeg: 0,
  };
}

function fit(treeId: number, dbh: number): StemFit {
  return {
    treeId, dbh, centerX: treeId, centerY: 0,
    inlierCount: 900, bandCount: 8, rmse: 0.004, writtenStemPoints: 0,
  };
}

/** A bridge stub that records what it was asked for. */
function source(opts: {
  metrics?: TreeMetric[];
  stems?: StemFit[] | null;
  stemsThrows?: boolean;
  metricsThrows?: boolean;
} = {}): MetricsSource & { calls: string[]; params: MetricParams[] } {
  const calls: string[] = [];
  const params: MetricParams[] = [];
  return {
    calls, params,
    octreeTreeMetrics: async (dir, p) => {
      calls.push(`metrics:${dir}`);
      params.push(p);
      if (opts.metricsThrows) throw new Error('metrics failed');
      return opts.metrics ?? [];
    },
    octreeReadStems: async dir => {
      calls.push(`stems:${dir}`);
      if (opts.stemsThrows) throw new Error('sidecar unreadable');
      return opts.stems ?? null;
    },
  };
}

const g = (d: number) => Math.PI * (d / 2) ** 2;

/** `octree_fit_stems` refines DBH with RANSAC; the metrics pass fits an
 *  algebraic circle across the whole breast-height band. The refinement
 *  reached exactly one screen — the merge lived inside the Metrics table
 *  — so the report, the per-hectare figures, the caliper validation, the
 *  thinning selection and every export used the diameter the fit exists
 *  to replace. DBH is squared into basal area, so the gap was amplified
 *  everywhere downstream.
 *
 *  The loader now decides, not the panel. */
describe('loadTreeMetrics', () => {
  it('replaces the algebraic diameter with the fitted one', async () => {
    const s = source({ metrics: [tree(1, 0.30), tree(2, 0.25)], stems: [fit(1, 0.284)] });
    const rows = await loadTreeMetrics(s, '/ds');

    expect(rows[0].dbh).toBeCloseTo(0.284, 12);
    expect(rows[0].basalArea).toBeCloseTo(g(0.284), 12);
    expect(rows[0].dbhSource).toBe('stemFit');
    // Tree 2 has no fit — it keeps the algebraic figure, and says so.
    expect(rows[1].dbh).toBeCloseTo(0.25, 12);
    expect(rows[1].dbhSource).toBeUndefined();
  });

  it('asks for the fits of the dataset it measured', async () => {
    const s = source({ metrics: [tree(1, 0.3)] });
    await loadTreeMetrics(s, '/ds/epoch-2024');
    expect(s.calls).toEqual(['metrics:/ds/epoch-2024', 'stems:/ds/epoch-2024']);
  });

  it('reads the fits after the metrics, so a fit finishing now is picked up', async () => {
    const s = source({ metrics: [tree(1, 0.3)] });
    await loadTreeMetrics(s, '/ds');
    expect(s.calls.indexOf('stems:/ds')).toBeGreaterThan(s.calls.indexOf('metrics:/ds'));
  });

  it('passes the caller\'s band through, defaulting to the shared one', async () => {
    const s = source({ metrics: [] });
    await loadTreeMetrics(s, '/ds');
    expect(s.params[0]).toEqual(DEFAULT_METRIC_PARAMS);

    const custom: MetricParams = { crownCell: 0.5, bhLow: 1.0, bhHigh: 1.6, dtmCell: 1.0 };
    await loadTreeMetrics(s, '/ds', custom);
    expect(s.params[1]).toEqual(custom);
  });

  /** The fit is the optional half. A dataset it has never been run on is
   *  the normal case, not an error. */
  it('returns the algebraic metrics when no fit has been run', async () => {
    const s = source({ metrics: [tree(1, 0.30)], stems: null });
    const rows = await loadTreeMetrics(s, '/ds');
    expect(rows[0].dbh).toBeCloseTo(0.30, 12);
    expect(countRefined(rows)).toBe(0);
  });

  it('survives an unreadable sidecar rather than losing the metrics', async () => {
    const s = source({ metrics: [tree(1, 0.30)], stemsThrows: true });
    const rows = await loadTreeMetrics(s, '/ds');
    expect(rows).toHaveLength(1);
    expect(rows[0].dbh).toBeCloseTo(0.30, 12);
  });

  it('works against a build with no stem-fit command at all', async () => {
    const s: MetricsSource = { octreeTreeMetrics: async () => [tree(1, 0.30)] };
    const rows = await loadTreeMetrics(s, '/ds');
    expect(rows[0].dbh).toBeCloseTo(0.30, 12);
  });

  /** A failed metrics pass is real and the panel has to show it — unlike
   *  a missing fit, it must not be swallowed into an empty table. */
  it('propagates a metrics failure', async () => {
    const s = source({ metricsThrows: true });
    await expect(loadTreeMetrics(s, '/ds')).rejects.toThrow('metrics failed');
  });

  it('refuses clearly when the command is missing', async () => {
    await expect(loadTreeMetrics({}, '/ds')).rejects.toThrow(/not available/);
    await expect(loadTreeMetrics(undefined, '/ds')).rejects.toThrow(/not available/);
  });
});

describe('loadStemFits', () => {
  it('keys the fits by tree', async () => {
    const s = source({ stems: [fit(3, 0.28), fit(7, 0.31)] });
    const m = await loadStemFits(s, '/ds');
    expect(m?.size).toBe(2);
    expect(m?.get(7)?.dbh).toBeCloseTo(0.31, 12);
  });

  it('is null for a dataset with no fit, an empty fit, or no command', async () => {
    expect(await loadStemFits(source({ stems: null }), '/ds')).toBeNull();
    expect(await loadStemFits(source({ stems: [] }), '/ds')).toBeNull();
    expect(await loadStemFits({}, '/ds')).toBeNull();
    expect(await loadStemFits(source({}), '')).toBeNull();
  });

  it('is null rather than throwing on a corrupt sidecar', async () => {
    expect(await loadStemFits(source({ stemsThrows: true }), '/ds')).toBeNull();
  });
});

describe('mergeStemFits', () => {
  it('leaves a tree alone when its fit did not converge', () => {
    // dbh is NaN when no cylinder reached the inlier threshold — that is
    // a failed fit, not a measurement of zero, and it must not overwrite
    // the algebraic diameter with nothing.
    const rows = mergeStemFits([tree(1, 0.30)], new Map([[1, fit(1, NaN)]]));
    expect(rows[0].dbh).toBeCloseTo(0.30, 12);
    expect(rows[0].dbhSource).toBeUndefined();
  });

  it('ignores a non-positive fitted diameter', () => {
    const rows = mergeStemFits([tree(1, 0.30)], new Map([[1, fit(1, 0)]]));
    expect(rows[0].dbh).toBeCloseTo(0.30, 12);
  });

  it('does not mutate the rows it was given', () => {
    const original = [tree(1, 0.30)];
    const rows = mergeStemFits(original, new Map([[1, fit(1, 0.284)]]));
    expect(original[0].dbh).toBeCloseTo(0.30, 12);
    expect(rows[0].dbh).toBeCloseTo(0.284, 12);
  });

  it('keeps every other field of the row', () => {
    const rows = mergeStemFits([tree(5, 0.30)], new Map([[5, fit(5, 0.284)]]));
    expect(rows[0].treeId).toBe(5);
    expect(rows[0].height).toBe(20);
    expect(rows[0].crownArea).toBe(12);
    expect(rows[0].x).toBe(5);
  });

  it('is the identity when there is nothing to merge', () => {
    const rows = [tree(1, 0.30)];
    expect(mergeStemFits(rows, null)).toBe(rows);
    expect(mergeStemFits(rows, new Map())).toBe(rows);
  });

  /** A fit for a tree that is not in this dataset's metrics — a stale
   *  sidecar after re-segmentation — must not invent a row. */
  it('does not add trees the metrics pass did not report', () => {
    const rows = mergeStemFits([tree(1, 0.30)], new Map([[1, fit(1, 0.28)], [99, fit(99, 0.4)]]));
    expect(rows).toHaveLength(1);
    expect(rows[0].treeId).toBe(1);
  });
});

describe('countRefined', () => {
  it('counts the rows whose diameter came from the fit', () => {
    const rows = mergeStemFits(
      [tree(1, 0.30), tree(2, 0.25), tree(3, 0.28)],
      new Map([[1, fit(1, 0.284)], [3, fit(3, NaN)]]),
    );
    expect(countRefined(rows)).toBe(1);   // tree 3's fit did not converge
  });

  it('is zero for untouched metrics', () => {
    expect(countRefined([tree(1, 0.30), tree(2, 0.25)])).toBe(0);
    expect(countRefined([])).toBe(0);
  });
});

/** The cache.
 *
 *  Ten panels ask for these numbers and every one of them presents them
 *  as measurements, so the interesting tests are not "does it cache" but
 *  "can it ever hand back a row that no longer describes the cloud".
 */
describe('the tree-metrics cache', () => {
  /** A source that also answers the fingerprint call, with a value the
   *  test controls — this is what stands in for the files on disk. */
  function cached(fp: () => string, opts: Parameters<typeof source>[0] = {}) {
    const s = source(opts) as ReturnType<typeof source> & MetricsSource;
    s.octreeDatasetFingerprint = async (dir: string) => {
      s.calls.push(`fp:${dir}`);
      return fp();
    };
    return s;
  }
  const passes = (s: { calls: string[] }) => s.calls.filter(c => c.startsWith('metrics:')).length;

  beforeEach(() => invalidateTreeMetrics());

  it('computes once and serves the rest from memory', async () => {
    const s = cached(() => 'A', { metrics: [tree(1, 0.3)] });
    const a = await loadTreeMetrics(s, '/ds');
    const b = await loadTreeMetrics(s, '/ds');
    const c = await loadTreeMetrics(s, '/ds');
    expect(passes(s)).toBe(1);
    expect(b).toBe(a);   // the same array, not a copy
    expect(c).toBe(a);
  });

  /** THE ONE THAT MATTERS. A merge, a split, a re-segmentation or a stem
   *  fit all move the fingerprint, and the cache must follow — a stale
   *  DBH under a confident heading is worse than no cache at all. */
  it('recomputes the moment the dataset changes underneath it', async () => {
    let disk = 'before-the-merge';
    const s = cached(() => disk, { metrics: [tree(1, 0.30)] });
    await loadTreeMetrics(s, '/ds');
    await loadTreeMetrics(s, '/ds');
    expect(passes(s)).toBe(1);

    disk = 'after-the-merge';
    await loadTreeMetrics(s, '/ds');
    expect(passes(s), 'a changed fingerprint must retire the cached rows').toBe(2);
    // …and going back to the earlier state is a cache hit, not a bug:
    // the rows for that state are still correct for it.
    disk = 'before-the-merge';
    await loadTreeMetrics(s, '/ds');
    expect(passes(s)).toBe(2);
  });

  it('keeps datasets apart', async () => {
    const s = cached(() => 'A', { metrics: [tree(1, 0.3)] });
    await loadTreeMetrics(s, '/plot-a');
    await loadTreeMetrics(s, '/plot-b');
    await loadTreeMetrics(s, '/plot-a');
    expect(passes(s)).toBe(2);
    expect(treeMetricsCacheSize()).toBe(2);
  });

  it('keeps different parameters apart', async () => {
    const s = cached(() => 'A', { metrics: [tree(1, 0.3)] });
    await loadTreeMetrics(s, '/ds');
    await loadTreeMetrics(s, '/ds', { ...DEFAULT_METRIC_PARAMS, bhLow: 1.0 });
    await loadTreeMetrics(s, '/ds');
    expect(passes(s), 'a different breast band is a different measurement').toBe(2);
  });

  /** Four panels mounting together must measure the plot once between
   *  them, not four times — which is the whole reason this exists. */
  it('shares one pass between callers that arrive together', async () => {
    let release: (v: TreeMetric[]) => void = () => {};
    const gate = new Promise<TreeMetric[]>(r => { release = r; });
    const s: MetricsSource & { n: number } = {
      n: 0,
      octreeDatasetFingerprint: async () => 'A',
      octreeTreeMetrics: async () => { s.n++; return gate; },
      octreeReadStems: async () => null,
    };
    const all = Promise.all([
      loadTreeMetrics(s, '/ds'), loadTreeMetrics(s, '/ds'),
      loadTreeMetrics(s, '/ds'), loadTreeMetrics(s, '/ds'),
    ]);
    release([tree(1, 0.3)]);
    const rows = await all;
    expect(s.n).toBe(1);
    for (const r of rows) expect(r).toBe(rows[0]);
  });

  it('does not cache a failure', async () => {
    let fail = true;
    const s: MetricsSource & { n: number } = {
      n: 0,
      octreeDatasetFingerprint: async () => 'A',
      octreeTreeMetrics: async () => {
        s.n++;
        if (fail) throw new Error('metrics failed');
        return [tree(1, 0.3)];
      },
      octreeReadStems: async () => null,
    };
    await expect(loadTreeMetrics(s, '/ds')).rejects.toThrow('metrics failed');
    fail = false;
    // A rejected pass must leave nothing behind — neither a cached
    // result nor an in-flight promise the next caller would await
    // forever.
    await expect(loadTreeMetrics(s, '/ds')).resolves.toHaveLength(1);
    expect(s.n).toBe(2);
  });

  it('recomputes on force, even when nothing on disk moved', async () => {
    const s = cached(() => 'A', { metrics: [tree(1, 0.3)] });
    await loadTreeMetrics(s, '/ds');
    await loadTreeMetrics(s, '/ds', DEFAULT_METRIC_PARAMS, { force: true });
    expect(passes(s)).toBe(2);
    // …and the fresh rows become the cached ones.
    await loadTreeMetrics(s, '/ds');
    expect(passes(s)).toBe(2);
  });

  it('invalidates one dataset without touching the others', async () => {
    const s = cached(() => 'A', { metrics: [tree(1, 0.3)] });
    await loadTreeMetrics(s, '/plot-a');
    await loadTreeMetrics(s, '/plot-b');
    invalidateTreeMetrics('/plot-a');
    await loadTreeMetrics(s, '/plot-a');
    await loadTreeMetrics(s, '/plot-b');
    expect(passes(s)).toBe(3);
  });

  /** An older desktop build, or the web build, has no fingerprint call.
   *  Caching blind there would be caching without any way to know the
   *  cache had died, so it does not cache at all — the behaviour before
   *  this existed. */
  it('does not cache when it cannot tell whether the cache is still valid', async () => {
    const s = source({ metrics: [tree(1, 0.3)] });   // no fingerprint method
    await loadTreeMetrics(s, '/ds');
    await loadTreeMetrics(s, '/ds');
    expect(passes(s)).toBe(2);
    expect(treeMetricsCacheSize()).toBe(0);
  });

  it('does not cache when the fingerprint call itself fails', async () => {
    const s = source({ metrics: [tree(1, 0.3)] }) as ReturnType<typeof source> & MetricsSource;
    s.octreeDatasetFingerprint = async () => { throw new Error('no such directory'); };
    await loadTreeMetrics(s, '/ds');
    await loadTreeMetrics(s, '/ds');
    expect(passes(s), 'a dataset we cannot stat is not one to serve from memory').toBe(2);
  });

  it('hands a panel the measured rows on mount, and never computes to do it', async () => {
    let disk = 'A';
    const s = cached(() => disk, { metrics: [tree(1, 0.3)] });
    expect(await cachedTreeMetrics(s, '/ds')).toBeNull();
    expect(passes(s), 'an empty cache must not trigger a pass').toBe(0);

    const rows = await loadTreeMetrics(s, '/ds');
    const seen = await cachedTreeMetrics(s, '/ds');
    expect(seen?.rows).toBe(rows);
    expect(seen?.at).toBeGreaterThan(0);
    expect(passes(s)).toBe(1);

    // The check is against the CURRENT fingerprint, so an edit hides the
    // old rows rather than showing them fast.
    disk = 'B';
    expect(await cachedTreeMetrics(s, '/ds'),
      'a peek that skipped the fingerprint would be a fast way to show a stale DBH').toBeNull();
    expect(passes(s)).toBe(1);

    disk = 'A';
    invalidateTreeMetrics('/ds');
    expect(await cachedTreeMetrics(s, '/ds')).toBeNull();
  });

  it('is bounded, so a long correction session does not grow without end', async () => {
    // Every edit moves the fingerprint and so makes a new key. Twenty
    // edits to one plot must not leave twenty plots' worth of rows
    // alive.
    let n = 0;
    const s = cached(() => `edit-${n}`, { metrics: [tree(1, 0.3)] });
    for (n = 0; n < 20; n++) await loadTreeMetrics(s, '/ds');
    expect(treeMetricsCacheSize()).toBeLessThanOrEqual(8);
    // …and what survives is the RECENT work, not the oldest.
    n = 19;
    const before = passes(s);
    await loadTreeMetrics(s, '/ds');
    expect(passes(s), 'the latest state must still be a hit').toBe(before);
  });

  it('still folds the stem fits in on a cache miss', async () => {
    const s = cached(() => 'A', { metrics: [tree(1, 0.30)], stems: [fit(1, 0.42)] });
    const rows = await loadTreeMetrics(s, '/ds');
    expect(rows[0].dbh).toBeCloseTo(0.42, 6);
    expect(rows[0].dbhSource).toBe('stemFit');
  });
});
