import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_METRIC_PARAMS, describeMetricParams } from './params';

/** Every .ts/.tsx file under src/, recursively. */
function sourceFiles(dir = 'src'): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('per-tree metric parameters', () => {
  /** This is the test that would have caught the real bug.
   *
   *  Ten panels ask the same Rust command for a tree's DBH, and that
   *  command streams the cloud fresh every call with whatever parameters
   *  it is handed — so the parameters ARE the definition of DBH. Three
   *  call sites passed a 1.0–1.6 m breast-height band and seven passed
   *  1.2–1.4 m, with nothing on screen disclosing either. The Validation
   *  panel consequently reported a bias and RMSE for a DBH the user had
   *  never seen.
   *
   *  Nothing about that is a type error, so tsc was always going to be
   *  silent about it. An invariant over the source is what catches it. */
  it('are defined in exactly one place', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.endsWith(join('metrics', 'params.ts'))) continue;
      const text = readFileSync(file, 'utf8');
      // A literal breast-height band anywhere else means a second
      // definition of DBH has appeared.
      if (/bhLow:\s*[0-9]/.test(text)) offenders.push(file);
    }
    expect(
      offenders,
      'a hardcoded breast-height band outside metrics/params.ts is a second, undisclosed definition of DBH',
    ).toEqual([]);
  });

  /** DBH is defined at 1.3 m; ±10 cm is the conventional sampling
   *  window. A band that drifts wider starts reaching down the taper and
   *  inflating the fit on a butt-swelled tree. */
  it('bracket breast height symmetrically and tightly', () => {
    const { bhLow, bhHigh } = DEFAULT_METRIC_PARAMS;
    expect(bhLow).toBeLessThan(1.3);
    expect(bhHigh).toBeGreaterThan(1.3);
    expect((bhLow + bhHigh) / 2).toBeCloseTo(1.3, 6);
    expect(bhHigh - bhLow).toBeLessThanOrEqual(0.2);
  });

  it('are all positive — a zero cell size would divide by zero downstream', () => {
    expect(DEFAULT_METRIC_PARAMS.crownCell).toBeGreaterThan(0);
    expect(DEFAULT_METRIC_PARAMS.dtmCell).toBeGreaterThan(0);
  });

  /** A DBH is not a fact about a tree on its own — it is a fact about a
   *  tree AND the band it was measured across. The description exists so
   *  a panel can show the second half. */
  it('describe themselves with the band that produced them', () => {
    const s = describeMetricParams(DEFAULT_METRIC_PARAMS);
    expect(s).toContain(DEFAULT_METRIC_PARAMS.bhLow.toFixed(2));
    expect(s).toContain(DEFAULT_METRIC_PARAMS.bhHigh.toFixed(2));
  });

  /** The same bug one level up: agreeing on the parameters is not enough
   *  if the panels disagree about which ANSWER to use.
   *
   *  `octree_fit_stems` refines DBH with RANSAC, and the merge that
   *  applied it lived inside the Metrics table — so nine other call sites
   *  went on showing the algebraic diameter the fit exists to replace,
   *  and DBH is squared into basal area. `loadTreeMetrics` is now the one
   *  place that answers "what is this tree's diameter"; calling the raw
   *  command elsewhere reopens the gap.
   *
   *  MetricsModule is the deliberate exception: it is the panel that runs
   *  the fit, and it holds the algebraic rows and the fit side by side so
   *  the table can show both and the inlier count behind the refinement. */
  it('are read through one loader, so every panel gets the same diameter', () => {
    const allowed = [
      join('src', 'metrics', 'loadMetrics.ts'),
      join('src', 'modules', 'MetricsModule.tsx'),
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (allowed.includes(file)) continue;
      // A call, not a declaration: the interface entries read
      // `octreeTreeMetrics?: (` and the bridge `octreeTreeMetrics: (`.
      if (/\.octreeTreeMetrics\(/.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
    expect(
      offenders,
      'calling octreeTreeMetrics directly skips the RANSAC stem fit, so this panel shows a different diameter than the rest',
    ).toEqual([]);
  });
});
