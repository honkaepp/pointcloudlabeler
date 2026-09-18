import { describe, it, expect } from 'vitest';
import type { TreeMetric } from '../persistence/octreeReader';
import {
  fitVolumeModel, predictVolume, backTransform, describeModel,
  DEFAULT_SPEC, MIN_PAIRS_PER_PREDICTOR,
  type TrainingPair, type ModelSpec,
} from './treeModel';

function tree(height: number, crownArea: number, treeId = 1): TreeMetric {
  return {
    treeId, count: 4000, height, dbh: 0.25,
    basalArea: Math.PI * 0.125 ** 2,
    crownArea, crownDiameter: 2 * Math.sqrt(crownArea / Math.PI),
    x: 0, y: 0, baseZ: 0, leanDeg: 0,
  };
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** A plot whose trees obey a known allometry, so the fit has a right
 *  answer to find: V = 0.02 · h^1.2 · A^0.6. */
function syntheticPlot(n: number, noise = 0, seed = 20260821): TrainingPair[] {
  const rnd = lcg(seed);
  const out: TrainingPair[] = [];
  for (let i = 0; i < n; i++) {
    const height = 8 + rnd() * 18;          // 8–26 m
    const crownArea = 4 + rnd() * 26;       // 4–30 m²
    const truth = 0.02 * height ** 1.2 * crownArea ** 0.6;
    // Multiplicative noise, which is what an allometry actually has.
    const v = truth * Math.exp((rnd() - 0.5) * 2 * noise);
    out.push({ als: tree(height, crownArea, i + 1), volume: v });
  }
  return out;
}

describe('fitVolumeModel', () => {
  it('recovers a known allometry from clean data', () => {
    const m = fitVolumeModel(syntheticPlot(120))!;
    expect(m).not.toBeNull();
    // log V = log 0.02 + 1.2 log h + 0.6 log A
    expect(m.coefficients[0]).toBeCloseTo(Math.log(0.02), 6);
    expect(m.coefficients[1]).toBeCloseTo(1.2, 6);
    expect(m.coefficients[2]).toBeCloseTo(0.6, 6);
    expect(m.r2).toBeCloseTo(1, 6);
  });

  it('predicts a held-out tree from that allometry', () => {
    const m = fitVolumeModel(syntheticPlot(120))!;
    const truth = 0.02 * 20 ** 1.2 * 15 ** 0.6;
    expect(predictVolume(m, tree(20, 15)).volume).toBeCloseTo(truth, 4);
  });

  it('still finds the shape through multiplicative noise', () => {
    const m = fitVolumeModel(syntheticPlot(200, 0.25))!;
    expect(m.coefficients[1]).toBeGreaterThan(0.9);
    expect(m.coefficients[1]).toBeLessThan(1.5);
    expect(m.coefficients[2]).toBeGreaterThan(0.4);
    expect(m.coefficients[2]).toBeLessThan(0.8);
  });

  /** The honest error figure. The fit's own R² is measured on the very
   *  rows that produced it; the cross-validated RMSE is not. */
  it('reports a cross-validated error, and it is not the optimistic one', () => {
    const noisy = fitVolumeModel(syntheticPlot(150, 0.35))!;
    expect(Number.isFinite(noisy.cvRmse)).toBe(true);
    expect(noisy.cvRmse).toBeGreaterThan(0);
    // Noise makes the CV error larger; a clean plot's is near zero.
    const clean = fitVolumeModel(syntheticPlot(150, 0))!;
    expect(clean.cvRmse).toBeLessThan(noisy.cvRmse);
  });

  /** What cross-validation is FOR, and the test that actually pins it.
   *
   *  Here the volume is pure noise — nothing about height or crown area
   *  predicts it. The fit will still find coefficients and report a
   *  positive R², because with enough predictors you can fit anything.
   *  An honest error figure has to come out no better than predicting
   *  the mean, and only an out-of-sample one does. Measure the residuals
   *  on the rows that produced the fit and you get a comfortable number
   *  for a model that knows nothing. */
  it('reports no skill when the predictors carry no signal', () => {
    const rnd = lcg(555);
    const pairs: TrainingPair[] = [];
    const vols: number[] = [];
    for (let i = 0; i < 80; i++) {
      const v = 0.2 + rnd() * 1.6;                  // volume, unrelated
      pairs.push({ als: tree(8 + rnd() * 18, 4 + rnd() * 26, i + 1), volume: v });
      vols.push(v);
    }
    const m = fitVolumeModel(pairs)!;

    // Predicting the mean is the no-skill baseline.
    const mean = vols.reduce((a, b) => a + b, 0) / vols.length;
    const sd = Math.sqrt(vols.reduce((a, v) => a + (v - mean) ** 2, 0) / vols.length);

    // In-sample the fit looks like it learned something…
    const inSample = Math.sqrt(
      pairs.reduce((a, pr) => a + (predictVolume(m, pr.als).volume - pr.volume) ** 2, 0) / pairs.length,
    );
    expect(inSample).toBeLessThan(sd);

    // …and out of sample it has not. This is the number that must be
    // reported, and it cannot be the one above.
    expect(m.cvRmse).toBeGreaterThan(inSample);
    expect(m.cvRmse).toBeGreaterThan(sd * 0.9);
  });

  it('is deterministic — the folds are striped, not shuffled', () => {
    const pairs = syntheticPlot(90, 0.2);
    const a = fitVolumeModel(pairs)!;
    const b = fitVolumeModel(pairs)!;
    expect(a.cvRmse).toBe(b.cvRmse);
    expect(a.coefficients).toEqual(b.coefficients);
  });

  /** Back-transforming a log fit without a correction underestimates
   *  EVERY volume: exp(mean of logs) is the geometric mean, which sits
   *  below the arithmetic mean. A few per cent, in the same direction,
   *  on every tree — which is exactly the kind of bias that survives. */
  it('corrects the log back-transform, so the total is not biased low', () => {
    const pairs = syntheticPlot(200, 0.4);
    const m = fitVolumeModel(pairs)!;
    expect(m.smearing).toBeGreaterThan(1);

    const withCorrection = pairs.reduce((s, p) => s + predictVolume(m, p.als).volume, 0);
    const naive = withCorrection / m.smearing;   // what no correction gives
    const measured = pairs.reduce((s, p) => s + p.volume, 0);

    expect(naive).toBeLessThan(measured * 0.99);
    expect(Math.abs(withCorrection / measured - 1))
      .toBeLessThan(Math.abs(naive / measured - 1));
  });

  it('leaves the linear form untouched by the correction', () => {
    const m = fitVolumeModel(syntheticPlot(120, 0.1), { predictors: ['height'], form: 'linear' })!;
    expect(m.smearing).toBe(1);
    expect(backTransform(3.5, 'linear', 1)).toBe(3.5);
  });

  describe('refuses to fit what it cannot', () => {
    it('needs enough pairs per predictor', () => {
      const spec: ModelSpec = { predictors: ['height', 'crownArea'], form: 'loglog' };
      const need = 2 * MIN_PAIRS_PER_PREDICTOR;
      expect(fitVolumeModel(syntheticPlot(need - 1), spec)).toBeNull();
      expect(fitVolumeModel(syntheticPlot(need), spec)).not.toBeNull();
    });

    it('is null with no pairs, and with no predictors', () => {
      expect(fitVolumeModel([])).toBeNull();
      expect(fitVolumeModel(syntheticPlot(100), { predictors: [], form: 'loglog' })).toBeNull();
    });

    /** Two predictors that are the same number cannot both be fitted.
     *  Without pivoting this divides by a near-zero and returns
     *  coefficients of 1e17 that predict confidently and absurdly. */
    it('is null when the predictors are collinear', () => {
      const pairs: TrainingPair[] = [];
      for (let i = 0; i < 60; i++) {
        const h = 10 + i * 0.2;
        // crownDiameter is a deterministic function of crownArea, so
        // asking for both is asking for the same column twice.
        pairs.push({ als: tree(h, 12), volume: 0.3 + i * 0.01 });
      }
      const m = fitVolumeModel(pairs, { predictors: ['crownArea', 'crownDiameter'], form: 'loglog' });
      expect(m).toBeNull();
    });
  });

  describe('what it will not use as a measurement', () => {
    it('drops a pair with no measured volume', () => {
      const good = syntheticPlot(40);
      const bad: TrainingPair[] = [
        { als: tree(20, 15, 900), volume: 0 },
        { als: tree(21, 16, 901), volume: NaN },
        { als: tree(22, 17, 902), volume: -1 },
      ];
      const m = fitVolumeModel([...good, ...bad])!;
      expect(m.n).toBe(good.length);
    });

    /** A height of 0 is what the metrics pass reports for a tree with no
     *  ground beneath it — unmeasured, not a tree of no height. In the
     *  log form it is −∞ besides. */
    it('drops a pair whose predictor was never measured', () => {
      const good = syntheticPlot(40);
      const m = fitVolumeModel([
        ...good,
        { als: tree(0, 15, 900), volume: 0.4 },
        { als: tree(20, NaN, 901), volume: 0.4 },
      ])!;
      expect(m.n).toBe(good.length);
    });
  });
});

/** The reason the whole module exists — and the reason every prediction
 *  is marked. The trees TLS missed are not a random sample of the trees
 *  it found: they are the occluded, the small, the crowded. The model is
 *  applied outside its training range by construction. */
describe('predictVolume', () => {
  const m = fitVolumeModel(syntheticPlot(150, 0.2))!;

  it('does not flag a tree inside the fitted range', () => {
    const p = predictVolume(m, tree(18, 18));
    expect(p.extrapolated).toBe(false);
    expect(p.volume).toBeGreaterThan(0);
  });

  it('flags a tree below the fitted range but still answers', () => {
    // The training plot is 8–26 m; a suppressed 4 m stem is outside it.
    const p = predictVolume(m, tree(4, 3));
    expect(p.extrapolated).toBe(true);
    expect(p.volume).toBeGreaterThan(0);
  });

  it('flags a tree above the fitted range', () => {
    expect(predictVolume(m, tree(40, 60)).extrapolated).toBe(true);
  });

  it('flags when any one predictor is outside, not only all of them', () => {
    // Height inside 8–26, crown area far outside 4–30.
    expect(predictVolume(m, tree(18, 200)).extrapolated).toBe(true);
  });

  it('is NaN, not zero, for a tree missing a predictor', () => {
    expect(predictVolume(m, tree(NaN, 15)).volume).toBeNaN();
    expect(predictVolume(m, tree(20, 0)).volume).toBeNaN();
  });

  /** A linear fit can extrapolate to a negative volume. That is the
   *  model saying the tree is outside what it can describe, and it must
   *  not be handed on as a measurement of negative wood. */
  it('returns NaN rather than a negative volume', () => {
    const lin = fitVolumeModel(syntheticPlot(120), { predictors: ['height'], form: 'linear' })!;
    const p = predictVolume(lin, tree(0.5, 12));
    expect(p.volume === undefined || Number.isNaN(p.volume) || p.volume > 0).toBe(true);
  });
});

describe('describeModel', () => {
  it('names the form, the predictors, the sample and the honest error', () => {
    const s = describeModel(fitVolumeModel(syntheticPlot(120, 0.2)));
    expect(s).toContain('log-log');
    expect(s).toContain('ALS height');
    expect(s).toContain('crown area');
    expect(s).toContain('120 matched trees');
    expect(s).toMatch(/cross-validated RMSE \d+\.\d+ m³/);
  });

  it('says plainly when there is no model', () => {
    expect(describeModel(null)).toContain('not enough matched trees');
    expect(describeModel(fitVolumeModel(syntheticPlot(3)))).toContain('not enough');
  });

  it('names the default spec it was built for', () => {
    expect(DEFAULT_SPEC.form).toBe('loglog');
    expect(DEFAULT_SPEC.predictors).toEqual(['height', 'crownArea']);
  });
});
