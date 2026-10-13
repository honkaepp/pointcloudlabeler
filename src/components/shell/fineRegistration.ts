// The arithmetic and the words of the Fine registration panel, kept out
// of the component so they can be tested without a DOM.
//
// The measurement (src-tauri commands/register.rs through
// octree_register) is a rigid transform in world coordinates, moving →
// reference, with the covariance-derived standard error of every
// parameter and the observability of the fit. The panel's job is to
// show those numbers in the units a person judges them in — millimetres
// and degrees, and metres at the plot's edge — and to say plainly when
// the geometry did not constrain what the fit returned.

import { rotationAtEdge } from './registration';

/** The stage the registration runs and reports on, and the one its Stop
 *  is asked on; and the stage of writing the moved copy. Their own, so a
 *  stop here never reaches a skeleton alignment or a subset, and theirs
 *  never reaches this. */
export const REGISTER_STAGE = 'register';
export const TRANSFORM_STAGE = 'transform';

export type RegisterMethod = 'symmetric' | 'pointToPlane' | 'pointToPoint' | 'gicp';
export type RegisterKernel = 'welsch' | 'cauchy' | 'tukey' | 'none';
export type RegisterDof = 'full' | 'levelled' | 'translation';
export type RegisterInitMode = 'current' | 'auto' | 'skeleton' | 'manual' | 'features';

/** The panel's defaults — the Rust side's `RegisterParams::default()`
 *  and `RegisterInit::default()`, in the panel's units. Pinned to the
 *  Rust literals by fineRegistration.test.ts. */
export const FINE_REG_DEFAULTS = {
  method: 'symmetric' as RegisterMethod,
  kernel: 'welsch' as RegisterKernel,
  dof: 'full' as RegisterDof,
  init: 'current' as RegisterInitMode,
  voxelCm: 5,
  levels: 4,
  maxCorrDist: 1.0,
  maxIters: 50,
  normalK: 16,
  maxNormalAngleDeg: 45,
  kernelFloorMm: 2,
  maxPoints: 1_000_000,
  searchRadius: 30,
  yawRangeDeg: 5,
  dtmCell: 0.5,
  featureVoxel: 0.3,
  jackknifeBlock: 2.0,
};

/** What the Rust side reports — DatasetRegistration, camelCased. */
export interface FineRegistrationReport {
  referenceDir: string;
  movingDir: string;
  referenceName: string;
  movingName: string;
  /** Moving → reference, world coordinates, row-major 4 × 4. */
  matrix: number[];
  initMatrix: number[];
  initMode: RegisterInitMode;
  coarse?: {
    dx: number; dy: number; dz: number; yawDeg: number; confidence: number;
    stemAnchors: number; topAnchors: number; matchedTrees: number;
  };
  global?: {
    referenceKeypoints: number; movingKeypoints: number; correspondences: number;
    inliers: number; inlierFraction: number; iterations: number; rmse: number; overlap: number;
  };
  origin: [number, number, number];
  centreWorld: [number, number, number];
  referencePoints: number;
  movingPoints: number;
  report: {
    translation: [number, number, number];
    rotationDeg: [number, number, number];
    translationStdErr: [number, number, number];
    rotationStdErrDeg: [number, number, number];
    /** The same by the spatial block jackknife; NaN with too few blocks. */
    translationStdErrBlocks: [number, number, number];
    rotationStdErrDegBlocks: [number, number, number];
    jackknifeBlocks: number;
    /** A moved point's uncertainty at the cloud's RMS radius, metres:
     *  what M3C2 takes as its registration error. */
    positionStdErr: number;
    rmse: number;
    medianAbs: number;
    sigma: number;
    inliers: number;
    inlierFraction: number;
    overlapFraction: number;
    iterations: number;
    converged: boolean;
    levels: Array<{
      voxel: number; corrDist: number; referencePoints: number; movingPoints: number;
      iterations: number; converged: boolean; rmse: number; inliers: number;
    }>;
    condition: number;
    weakest: string;
    wellConstrained: boolean;
    histMin: number;
    histWidth: number;
    histBins: number[];
  };
  seconds: number;
}

/** A length in the unit it is best read in: millimetres under a
 *  centimetre, centimetres under a metre, metres above. */
export function lengthText(m: number): string {
  if (!Number.isFinite(m)) return '—';
  const a = Math.abs(m);
  if (a < 0.01) return `${(m * 1000).toFixed(2)} mm`;
  if (a < 1) return `${(m * 100).toFixed(2)} cm`;
  return `${m.toFixed(3)} m`;
}

/** "+0.613 m ± 0.1 mm": a value with its standard error, the error in
 *  the finer unit so it is never rounded to nothing. */
export function plusMinus(value: number, stdErr: number, unit: 'm' | 'deg'): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '−';
  if (unit === 'deg') {
    const se = Number.isFinite(stdErr) && stdErr > 0 ? ` ± ${stdErr < 0.001 ? stdErr.toExponential(1) : stdErr.toFixed(4)}°` : '';
    return `${sign}${Math.abs(value).toFixed(4)}°${se}`;
  }
  const se = Number.isFinite(stdErr) && stdErr > 0 ? ` ± ${(stdErr * 1000).toFixed(stdErr < 0.001 ? 2 : 1)} mm` : '';
  return `${sign}${Math.abs(value).toFixed(4)} m${se}`;
}

/** "+0.613 m east, −0.402 m north, +0.098 m up (0.740 m)". */
export function describeTranslation(t: readonly number[]): string {
  const s = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)} m`;
  const len = Math.hypot(t[0] ?? 0, t[1] ?? 0, t[2] ?? 0);
  return `${s(t[0] ?? 0)} east, ${s(t[1] ?? 0)} north, ${s(t[2] ?? 0)} up (${len.toFixed(3)} m)`;
}

/** The angle of a rotation given as roll, pitch, yaw in degrees, in
 *  radians — the one number a plot's edge turns by. */
export function rotationAngleRad(rotationDeg: readonly number[]): number {
  // For the small angles a registration ends with, the three combine
  // as a vector; this is exact to second order.
  const r = (rotationDeg[0] ?? 0) * Math.PI / 180;
  const p = (rotationDeg[1] ?? 0) * Math.PI / 180;
  const y = (rotationDeg[2] ?? 0) * Math.PI / 180;
  return Math.hypot(r, p, y);
}

/** What the rotation amounts to at the plot's edge, metres. */
export function rotationAtPlotEdge(rotationDeg: readonly number[], bboxMin: readonly number[], bboxMax: readonly number[]): number {
  const w = Math.abs((bboxMax[0] ?? 0) - (bboxMin[0] ?? 0));
  const h = Math.abs((bboxMax[1] ?? 0) - (bboxMin[1] ?? 0));
  return rotationAtEdge(rotationAngleRad(rotationDeg), Math.hypot(w, h) / 2);
}

/** The observability verdict: what the condition number of the scaled
 *  normal matrix says about the directions the clouds' geometry did or
 *  did not fix. Below 100 everything is constrained; above 10 000 a
 *  direction was chosen, not measured. */
export function constraintVerdict(condition: number, weakest: string): { label: string; color: string; ok: boolean } {
  if (!Number.isFinite(condition)) return { label: `unconstrained — ${weakest} was not measured`, color: '#e0817b', ok: false };
  if (condition < 100) return { label: 'every direction constrained', color: '#67d391', ok: true };
  if (condition < 10_000) return { label: `weakly constrained along ${weakest} — check that direction before trusting it`, color: '#e6c068', ok: false };
  return { label: `unconstrained — ${weakest} was chosen, not measured`, color: '#e0817b', ok: false };
}

/** The coarse vote's peak over its best rival, as words. */
export function coarseVerdict(confidence: number): string {
  if (!Number.isFinite(confidence) || confidence >= 1.3) return 'unambiguous';
  if (confidence >= 1.1) return 'likely';
  return 'a guess — check it';
}

/** What the run is doing at this fraction of the Rust side's progress:
 *  the coarse search to 12 %, the two reads to 52 %, the fit after. */
export function registerStageLabel(pct: number, init: RegisterInitMode): string {
  if (pct < 0.12) {
    if (init === 'auto') return 'Coarse search: rasterising stems and crowns, voting…';
    if (init === 'features') return 'Feature search: histograms, pairing, hypotheses…';
    return 'Starting…';
  }
  if (pct < 0.32) return 'Reading the reference over the overlap…';
  if (pct < 0.52) return 'Reading the moving cloud over the overlap…';
  return 'Fitting: coarse to fine…';
}

/** The larger of the two standard errors — the one to quote: the
 *  independent-residual figure undercounts what neighbouring pairs
 *  share, the block jackknife counts it once. */
export function quotedStdErr(independent: number, blocks: number): number {
  if (Number.isFinite(blocks) && blocks > independent) return blocks;
  return independent;
}

/** The moved copy's name, unless the user types one. */
export function defaultCopyName(movingName: string): string {
  return `${movingName} registered`;
}

/** The directory the moved copy goes to: beside the source, under the
 *  project's octrees directory, as the Subset panel does it. */
export function copyOutDir(movingDir: string, name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_');
  const parent = movingDir.replace(/[\\/][^\\/]+[\\/]?$/, '');
  return `${parent}/${safe}`;
}

/** The residual histogram as bar heights in [0, 1], with the centre bin
 *  marked so the eye finds zero. */
export function histogramBars(bins: readonly number[]): Array<{ h: number; centre: boolean }> {
  const max = bins.reduce((m, v) => Math.max(m, v), 0);
  const mid = Math.floor(bins.length / 2);
  return bins.map((v, i) => ({ h: max > 0 ? v / max : 0, centre: i === mid }));
}

/** Below this a move is not worth writing a copy for. */
export const MIN_MOVE_M = 0.0005;

export function isWorthApplying(r: FineRegistrationReport, bboxMin: readonly number[], bboxMax: readonly number[]): boolean {
  const t = Math.hypot(...r.report.translation);
  return t >= MIN_MOVE_M || rotationAtPlotEdge(r.report.rotationDeg, bboxMin, bboxMax) >= MIN_MOVE_M;
}
