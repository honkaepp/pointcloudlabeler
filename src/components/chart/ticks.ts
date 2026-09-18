// Shared chart primitives — tick generators + linear regression. Used by
// MetricHistogram and MetricScatter so they stop looking like 2010 matplotlib
// defaults and start carrying tick marks / grid lines / regression lines.

/**
 * Generate "nice" tick values inside [min, max] aiming for ~targetCount
 * ticks, snapped to a 1/2/5 × 10ⁿ stride so the labels are readable.
 * Returns the tick values inclusive of bounds (the endpoints may extend
 * slightly past min/max so the bars / dots stay within the chart).
 */
export function niceTicks(min: number, max: number, targetCount = 5): { ticks: number[]; lo: number; hi: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    const v = Number.isFinite(min) ? min : 0;
    return { ticks: [v], lo: v - 1, hi: v + 1 };
  }
  if (min > max) { const t = min; min = max; max = t; }
  const range = max - min;
  const rawStep = range / Math.max(1, targetCount);
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  // 1 / 2 / 5 × 10ⁿ — same shape d3.ticks uses.
  let step: number;
  if (norm < 1.5) step = mag;
  else if (norm < 3) step = 2 * mag;
  else if (norm < 7) step = 5 * mag;
  else step = 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step * 0.5; v += step) ticks.push(roundToStep(v, step));
  return { ticks, lo, hi };
}

function roundToStep(v: number, step: number): number {
  // Snap to the step's decimal precision to dodge 0.1 + 0.2 = 0.30000…4.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const k = Math.pow(10, decimals);
  return Math.round(v * k) / k;
}

/** Human-readable label for a tick value. Auto-picks decimal places. */
export function formatTick(v: number, step?: number): string {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  if (step != null && step >= 1) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Pearson r — sign-aware correlation. */
  r: number;
  /** Coefficient of determination = r². */
  r2: number;
  /** RMS residual of y - (slope x + intercept). */
  rms: number;
}

/** Ordinary least-squares fit y = slope · x + intercept. Returns null
 *  when fewer than 2 points are provided or the x-values have zero variance
 *  (vertical line — slope undefined). */
export function linearRegression(xs: number[], ys: number[]): LinearFit | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r = (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 0;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const yhat = slope * xs[i] + intercept;
    const e = ys[i] - yhat;
    sse += e * e;
  }
  const rms = Math.sqrt(sse / n);
  return { slope, intercept, r, r2: r * r, rms };
}
