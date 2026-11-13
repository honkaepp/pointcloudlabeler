// Colouring every tree by what was measured of it: its height,
// its DBH, its crown, its lean, its worst quality flag, how much it grew.
// The plot reads as a map of the stand at a glance: the tall ones, the
// thick ones, the leaning ones, the ones to check, the ones that grew.
//
// The colours are worked out here, per tree, on the CPU — a ramp over a
// range for a measurement, fixed colours for a flag — into a texture one
// texel per tree id that the point shader reads by the point's tree id
// (pointShaders' tree_metric mode). A few thousand trees cost nothing to
// recolour, so a new ramp or range is a new texture.
//
// Where the numbers come from: the per-tree metrics pass
// (metrics/loadMetrics.ts — never started by merely looking: the Display
// panel offers to measure), the QC flags over those, and the growth
// panel's pairing with an earlier epoch (TreeGrowthPanel publishes it).

import type { ColorRamp } from '../components/shell/OctreeShellContext';
import type { TreeMetric } from '../persistence/octreeReader';
import { computeQcFlags, worstByTree, SEV_RANK } from '../metrics/qcFlags';
import type { Pair } from '../metrics/growth';
import { finiteCount, percentile } from '../metrics/stats';
import { rampColor } from './palette';

export type TreeMetricKey = 'height' | 'dbh' | 'crown' | 'lean' | 'qc' | 'ddbh' | 'dheight';

export interface TreeMetricDef {
  id: TreeMetricKey;
  label: string;
  unit: string;
  /** 'ramp': a measurement over a colour ramp; 'flag': fixed colours. */
  kind: 'ramp' | 'flag';
  /** Needs the growth pairing (an earlier epoch). */
  growth?: boolean;
  hint: string;
}

export const TREE_METRICS: TreeMetricDef[] = [
  { id: 'height', label: 'Height', unit: 'm', kind: 'ramp', hint: 'Tree height, top over the ground at the stem' },
  { id: 'dbh', label: 'DBH', unit: 'cm', kind: 'ramp', hint: 'Diameter at breast height (the stem fit where it was run)' },
  { id: 'crown', label: 'Crown', unit: 'm', kind: 'ramp', hint: 'Crown diameter' },
  { id: 'lean', label: 'Lean', unit: '°', kind: 'ramp', hint: 'Stem lean from vertical — storm damage shows up here' },
  { id: 'qc', label: 'QC flag', unit: '', kind: 'flag', hint: 'The worst quality flag of each tree: critical, warning, info, or none' },
  { id: 'ddbh', label: 'Δ DBH', unit: 'cm', kind: 'ramp', growth: true, hint: 'DBH growth since the earlier epoch (Tree growth panel)' },
  { id: 'dheight', label: 'Δ height', unit: 'm', kind: 'ramp', growth: true, hint: 'Height growth since the earlier epoch (Tree growth panel)' },
];

export function treeMetricDef(key: TreeMetricKey | undefined): TreeMetricDef {
  return TREE_METRICS.find((m) => m.id === key) ?? TREE_METRICS[0];
}

/** The QC flag colours by severity rank (0 = measured, no flag). */
export const FLAG_RGB: Record<number, [number, number, number]> = {
  0: [86, 170, 110],
  1: [90, 150, 230],
  2: [235, 175, 60],
  3: [225, 70, 80],
};
export const FLAG_LABELS: Array<[number, string]> = [[3, 'critical'], [2, 'warning'], [1, 'info'], [0, 'no flag']];

/** One value per tree for a metric, NaN-free (a tree with nothing measured
 *  is left out and drawn as "not measured"). */
export function treeValues(
  key: TreeMetricKey, rows: readonly TreeMetric[] | null, pairs?: readonly Pair[] | null,
  qc?: ReadonlyMap<number, number> | null,
): Map<number, number> {
  const out = new Map<number, number>();
  const put = (id: number, v: number) => { if (id > 0 && Number.isFinite(v)) out.set(id, v); };
  if (key === 'ddbh' || key === 'dheight') {
    for (const p of pairs ?? []) {
      put(p.now.treeId, key === 'ddbh' ? (p.now.dbh - p.ref.dbh) * 100 : p.now.height - p.ref.height);
    }
    return out;
  }
  if (!rows) return out;
  if (key === 'qc') {
    // the QC panel's flags when it has published them (with its QSM and
    // extent checks), else the flags the metrics alone raise
    if (qc) {
      for (const t of rows) put(t.treeId, qc.get(t.treeId) ?? 0);
      return out;
    }
    const worst = worstByTree(computeQcFlags([...rows], null, null));
    for (const t of rows) put(t.treeId, SEV_RANK[worst.get(t.treeId) as keyof typeof SEV_RANK] ?? 0);
    return out;
  }
  for (const t of rows) {
    put(t.treeId, key === 'height' ? t.height : key === 'dbh' ? t.dbh * 100 : key === 'crown' ? t.crownDiameter : t.leanDeg);
  }
  return out;
}

/** The 2–98 % of the values (the auto range), and their extent. */
export function treeValueRange(values: Map<number, number>): { lo: number; hi: number; min: number; max: number } | null {
  const v = [...values.values()];
  if (finiteCount(v) === 0) return null;
  const min = percentile(v, 0), max = percentile(v, 1);
  let lo = percentile(v, 0.02), hi = percentile(v, 0.98);
  if (!(hi > lo)) { lo = min; hi = max; }
  if (!(hi > lo)) hi = lo + 1;
  return { lo, hi, min, max };
}

/** Texels a row; a tree id's texel is (id % W, id / W). */
export const TREE_TEX_WIDTH = 4096;
/** Tree ids above this are drawn as not measured (a 16 MB texture). */
export const TREE_TEX_MAX_ID = TREE_TEX_WIDTH * 1024 - 1;

export interface TreeColorTexture {
  key: string;
  data: Uint8Array;
  width: number;
  height: number;
}

/** RGBA8, one texel per tree id up to the largest measured: the colour,
 *  alpha 255; alpha 0 where nothing was measured. */
export function treeColorTexture(
  values: Map<number, number>, kind: 'ramp' | 'flag', ramp: ColorRamp, range: { lo: number; hi: number } | null, key: string,
): TreeColorTexture {
  let maxId = 0;
  for (const id of values.keys()) if (id <= TREE_TEX_MAX_ID && id > maxId) maxId = id;
  const n = maxId + 1;
  const width = Math.min(TREE_TEX_WIDTH, n);
  const height = Math.max(1, Math.ceil(n / TREE_TEX_WIDTH));
  const data = new Uint8Array(width * height * 4);
  const rgb: [number, number, number] = [0, 0, 0];
  const lo = range?.lo ?? 0;
  const inv = range && range.hi > range.lo ? 1 / (range.hi - range.lo) : 0;
  for (const [id, v] of values) {
    if (id > TREE_TEX_MAX_ID) continue;
    if (kind === 'flag') {
      const c = FLAG_RGB[Math.round(v)] ?? FLAG_RGB[0];
      rgb[0] = c[0]; rgb[1] = c[1]; rgb[2] = c[2];
    } else {
      rampColor(ramp, Math.min(1, Math.max(0, (v - lo) * inv)), rgb);
    }
    const o = id * 4;
    data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
  }
  return { key, data, width, height };
}

// ------------------------------------------------------------- the store
//
// What has been measured of the active dataset's trees, as the Display
// panel and the growth panel find it, for the viewer to colour by.

export interface TreeData {
  dir: string;
  rows: TreeMetric[] | null;
  pairs: Pair[] | null;
  /** The QC panel's worst flag rank per tree, when it is open. */
  qc: Map<number, number> | null;
  version: number;
}

let data: TreeData = { dir: '', rows: null, pairs: null, qc: null, version: 0 };
const listeners = new Set<() => void>();

export function treeData(): TreeData { return data; }

export function subscribeTreeData(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function set(next: Partial<TreeData> & { dir: string }): void {
  const same = next.dir === data.dir;
  data = {
    dir: next.dir,
    rows: next.rows !== undefined ? next.rows : same ? data.rows : null,
    pairs: next.pairs !== undefined ? next.pairs : same ? data.pairs : null,
    qc: next.qc !== undefined ? next.qc : same ? data.qc : null,
    version: data.version + 1,
  };
  for (const l of listeners) l();
}

/** The per-tree metrics of `dir` (the metrics pass's rows). */
export function publishTreeMetrics(dir: string, rows: TreeMetric[] | null): void {
  if (dir === data.dir && rows === data.rows) return;
  set({ dir, rows });
}

/** The QC panel's metrics and its flags for `dir`, as worst rank per tree. */
export function publishTreeQc(dir: string, rows: TreeMetric[] | null, flags: readonly { treeId: number; severity: keyof typeof SEV_RANK }[] | null): void {
  let qc: Map<number, number> | null = null;
  if (flags) {
    qc = new Map();
    for (const f of flags) qc.set(f.treeId, Math.max(qc.get(f.treeId) ?? 0, SEV_RANK[f.severity]));
  }
  set(rows ? { dir, rows, qc } : { dir, qc });
}

/** The growth panel's pairs for `dir` (the later epoch is `dir`). */
export function publishTreeGrowth(dir: string, pairs: Pair[] | null): void {
  if (dir === data.dir && pairs === data.pairs) return;
  set({ dir, pairs });
}
