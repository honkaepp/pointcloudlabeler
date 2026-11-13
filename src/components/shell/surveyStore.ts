// The Survey panel's state and arithmetic (SurveyPanel.tsx draws
// it, three/SurveyOverlay.tsx shows it in the viewer).
//
// The panel's one piece of geometry is the line the user clicks in the
// viewer: measured as it grows (3D and plan length, plan area when it is
// closed, heights), and the input of the other tools — the area of a volume
// or an ortho image, the section line of a profile. The tools run in the
// backend (src-tauri/src/commands/octree/survey.rs) and write their files
// into the dataset's survey/ and terrain/ folders.

import { useSyncExternalStore } from 'react';
import type { FeatureKind } from '../../layers/fileLayers';

export type Vec3 = [number, number, number];
export type SurveyTab = 'measure' | 'contours' | 'volume' | 'change' | 'ortho' | 'profile' | 'mesh' | 'export';

// ---------------------------------------------------------------------------
// what the backend returns (camelCase, as the Rust structs serialise)

export interface SurveyMeasures { length3d: number; length2d: number; area2d: number; heightRange: number; rise: number }
export interface ContourLine { z: number; index: boolean; closed: boolean; points: Vec3[] }
export interface ContourResult { lines: ContourLine[]; levels: number; minZ: number; maxZ: number; lengthM: number; files: string[] }
export interface VolumeResult {
  areaM2: number; coveredM2: number; filledCells: number; aboveM3: number; belowM3: number; netM3: number;
  maxAbove: number; maxBelow: number; reference: string; files: string[];
}
export interface VoxelChangeResult {
  voxels: number; referenceVoxels: number; unchanged: number; appeared: number; disappeared: number;
  appearedM3: number; disappearedM3: number; points: number; pointsNew: number; columnWritten: string | null;
  gone: Vec3[]; files: string[];
}
export interface OrthoResult { width: number; height: number; pixelSize: number; filledPct: number; topLeft: [number, number]; files: string[] }
export interface ProfileResult {
  lengthM: number; points: number; zMin: number; zMax: number;
  preview: { station: number[]; offset: number[]; z: number[]; class: number[] };
  ground: Array<[number, number]>; files: string[];
}
export interface GeometryResult { measures: SurveyMeasures; files: string[] }
export interface MeshResult {
  vertices: number; triangles: number; areaM2: number; volumeM3: number | null;
  min: Vec3; max: Vec3; ply: string; files: string[];
}
export interface DxfPointsResult { points: number; classes: Array<[number, number]>; files: string[] }

/** A mesh shown in the viewer: one the panel made, or a file the user opened. */
export interface SurveyMesh { id: string; path: string; name: string; visible: boolean; color: string; opacity: number }
/** A scanner trajectory drawn in the view (a mobile scan's _traj.txt). */
export interface SurveyTrajectory { id: string; path: string; name: string; visible: boolean; color: string }
/** Points and lines from a run's file — scan positions, targets,
 *  stems, a region, voxels (layers/fileLayers.ts reads them). */
export interface SurveyFeature { id: string; path: string; name: string; kind: FeatureKind; visible: boolean; color: string }

export interface SurveyDesktop {
  surveyContours?: (params: unknown) => Promise<unknown>;
  surveyVolume?: (params: unknown) => Promise<unknown>;
  surveyVoxelChange?: (params: unknown) => Promise<unknown>;
  surveyOrtho?: (params: unknown) => Promise<unknown>;
  surveyProfile?: (params: unknown) => Promise<unknown>;
  surveySaveGeometry?: (params: unknown) => Promise<unknown>;
  surveyMesh?: (params: unknown) => Promise<unknown>;
  surveyDxfPoints?: (params: unknown) => Promise<unknown>;
  openFileDialog?: (opts: { filters: Array<{ name: string; extensions: string[] }> }) => Promise<{ path: string } | null>;
  readFileRange?: (path: string, start: number, end: number) => Promise<ArrayBuffer>;
  statFile?: (path: string) => Promise<unknown>;
  onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void> | (() => void);
  octreeCancel?: (stage: string) => Promise<boolean>;
}

export function surveyDesktop(): SurveyDesktop | undefined {
  return (window as unknown as { desktop?: SurveyDesktop }).desktop;
}

// ---------------------------------------------------------------------------
// measuring

/** Lengths, plan area and heights of a polyline or polygon — the same
 *  arithmetic as the backend's `measures` (survey.rs). */
export function measure(points: Vec3[], closed: boolean): SurveyMeasures {
  const n = points.length;
  const m: SurveyMeasures = { length3d: 0, length2d: 0, area2d: 0, heightRange: 0, rise: 0 };
  if (n === 0) return m;
  const edges = closed && n > 2 ? n : n - 1;
  for (let i = 0; i < edges; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    m.length3d += Math.hypot(dx, dy, dz);
    m.length2d += Math.hypot(dx, dy);
  }
  if (closed && n > 2) m.area2d = polygonArea(points.map((p) => [p[0], p[1]]));
  const zs = points.map((p) => p[2]);
  m.heightRange = Math.max(...zs) - Math.min(...zs);
  m.rise = points[n - 1][2] - points[0][2];
  return m;
}

export function polygonArea(poly: Array<[number, number]>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** The two edges of a corridor `width` wide around a polyline (plan), at
 *  the vertices' heights — what the viewer shows of a profile's section. */
export function corridor(points: Vec3[], width: number): [Vec3[], Vec3[]] {
  const left: Vec3[] = [], right: Vec3[] = [];
  const h = width / 2;
  const n = points.length;
  // the left normal of segment k (from k to k + 1), in plan
  const normal = (k: number): [number, number] => {
    const a = points[k], b = points[k + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return [-dy / l, dx / l];
  };
  for (let i = 0; i < n && n >= 2; i++) {
    // at a bend, the bisector of the two segments' normals
    const before = i > 0 ? normal(i - 1) : normal(0);
    const after = i < n - 1 ? normal(i) : normal(n - 2);
    let nx = before[0] + after[0], ny = before[1] + after[1];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l; ny /= l;
    const p = points[i];
    left.push([p[0] + nx * h, p[1] + ny * h, p[2]]);
    right.push([p[0] - nx * h, p[1] - ny * h, p[2]]);
  }
  return [left, right];
}

export function fmtLength(m: number): string {
  if (!Number.isFinite(m)) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(3)} km` : `${m.toFixed(m < 10 ? 3 : 2)} m`;
}

export function fmtArea(m2: number): string {
  if (!Number.isFinite(m2)) return '—';
  return m2 >= 10_000 ? `${(m2 / 10_000).toFixed(4)} ha (${Math.round(m2).toLocaleString('en-US')} m²)` : `${m2.toFixed(2)} m²`;
}

export function fmtVolume(m3: number): string {
  return Number.isFinite(m3) ? `${m3.toFixed(m3 < 10 ? 3 : 1)} m³` : '—';
}

// ---------------------------------------------------------------------------
// the store

export interface SurveyJob { kind: SurveyTab; stage: string; pct: number }

export interface SurveyState {
  tab: SurveyTab;
  /** The dataset the line and the results belong to. */
  dir: string | null;
  points: Vec3[];
  closed: boolean;
  picking: boolean;
  name: string;
  contour: { interval: string; indexEvery: string; cellSize: string; smooth: string; minLength: string; useArea: boolean };
  volume: { surface: string; reference: string; planeZ: string; cellSize: string; classes: string; fillGaps: boolean; wholeDataset: boolean };
  change: { referenceDir: string; voxelSize: string; neighbours: boolean; minPoints: string; writeColumn: boolean };
  ortho: { view: 'top' | 'side'; bearingDeg: string; pixelSize: string; color: string; depthNear: string; depthFar: string; shade: boolean; useArea: boolean };
  profile: { width: string; exaggeration: number };
  mesh: {
    method: '2.5d' | '3d'; cellSize: string; surface: string; classes: string; zLow: string; zHigh: string;
    fillGaps: boolean; minPoints: string; smooth: string; decimate: string; obj: boolean; stl: boolean; dxf: boolean; useArea: boolean;
  };
  dxf: { classes: string; zLow: string; zHigh: string; every: string; maxPoints: string; useArea: boolean };
  meshes: SurveyMesh[];
  trajectories: SurveyTrajectory[];
  features: SurveyFeature[];
  meshResult: MeshResult | null;
  dxfResult: DxfPointsResult | null;
  contours: ContourResult | null;
  volumeResult: VolumeResult | null;
  changeResult: VoxelChangeResult | null;
  orthoResult: OrthoResult | null;
  profileResult: ProfileResult | null;
  geometry: GeometryResult | null;
  showContours: boolean;
  showGone: boolean;
  job: SurveyJob | null;
  error: string | null;
}

export function initialSurveyState(): SurveyState {
  return {
    tab: 'measure',
    dir: null,
    points: [],
    closed: false,
    picking: false,
    name: 'survey',
    contour: { interval: '0.5', indexEvery: '5', cellSize: '0.5', smooth: '2', minLength: '2', useArea: true },
    volume: { surface: 'top', reference: 'rim', planeZ: '', cellSize: '0.1', classes: '', fillGaps: true, wholeDataset: false },
    change: { referenceDir: '', voxelSize: '0.1', neighbours: true, minPoints: '1', writeColumn: true },
    ortho: { view: 'top', bearingDeg: '0', pixelSize: '0.02', color: 'height', depthNear: '', depthFar: '', shade: true, useArea: true },
    profile: { width: '0.5', exaggeration: 1 },
    mesh: {
      method: '2.5d', cellSize: '0.1', surface: 'top', classes: '', zLow: '', zHigh: '', fillGaps: true, minPoints: '1',
      smooth: '0', decimate: '0', obj: true, stl: false, dxf: false, useArea: true,
    },
    dxf: { classes: '', zLow: '', zHigh: '', every: '1', maxPoints: '5000000', useArea: true },
    meshes: [],
    trajectories: [],
    features: [],
    meshResult: null,
    dxfResult: null,
    contours: null,
    volumeResult: null,
    changeResult: null,
    orthoResult: null,
    profileResult: null,
    geometry: null,
    showContours: true,
    showGone: true,
    job: null,
    error: null,
  };
}

let state: SurveyState = initialSurveyState();
const listeners = new Set<() => void>();

export function getSurveyState(): SurveyState {
  return state;
}

export function setSurveyState(patch: Partial<SurveyState> | ((s: SurveyState) => Partial<SurveyState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function resetSurveyStore(): void {
  state = initialSurveyState();
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useSurveyStore(): SurveyState {
  return useSyncExternalStore(subscribe, getSurveyState, getSurveyState);
}

/** The line and every result belong to one dataset: another one open
 *  starts afresh (the settings stay). */
export function bindDataset(dir: string | null): void {
  if (state.dir !== dir) {
    setSurveyState({
      dir, points: [], closed: false, picking: false, contours: null, volumeResult: null, changeResult: null,
      orthoResult: null, profileResult: null, geometry: null, meshResult: null, dxfResult: null, error: null,
    });
  }
}

export function addPoint(p: Vec3): void {
  setSurveyState((s) => ({ points: [...s.points, p], geometry: null }));
}

export function undoPoint(): void {
  setSurveyState((s) => ({ points: s.points.slice(0, -1), geometry: null }));
}

export function clearPoints(): void {
  setSurveyState({ points: [], geometry: null, picking: false });
}

/** Numbers typed into the panel, or the reason they are not. */
export function num(text: string, what: string, opts: { min?: number; positive?: boolean } = {}): number {
  const v = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(v)) throw new Error(`${what}: a number, please`);
  if (opts.positive && !(v > 0)) throw new Error(`${what} must be more than 0`);
  if (opts.min !== undefined && v < opts.min) throw new Error(`${what} must be at least ${opts.min}`);
  return v;
}

export function parseClasses(text: string): number[] {
  return text.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean).map((t) => {
    const v = Number(t);
    if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`class ${t}: a number 0–255`);
    return v;
  });
}

/** The area the line encloses, as the backend takes it ([x, y] vertices). */
export function areaPolygon(s: SurveyState): Array<[number, number]> {
  return s.closed && s.points.length >= 3 ? s.points.map((p) => [p[0], p[1]]) : [];
}

// ---------------------------------------------------------------------------
// building the backend's parameters

export function contourParams(s: SurveyState, dir: string) {
  const c = s.contour;
  return {
    octreeDir: dir,
    interval: num(c.interval, 'Interval', { positive: true }),
    indexEvery: Math.round(num(c.indexEvery, 'Index every', { min: 1 })),
    cellSize: num(c.cellSize, 'DTM cell', { positive: true }),
    smooth: Math.round(num(c.smooth, 'Smoothing', { min: 0 })),
    minLength: num(c.minLength, 'Shortest line', { min: 0 }),
    polygon: c.useArea ? areaPolygon(s) : [],
  };
}

export function volumeParams(s: SurveyState, dir: string) {
  const v = s.volume;
  const polygon = v.wholeDataset ? [] : areaPolygon(s);
  if (!v.wholeDataset && polygon.length < 3) throw new Error('Draw an area (Measure → Area, three points or more) or choose the whole dataset.');
  return {
    octreeDir: dir,
    polygon,
    surface: v.surface,
    reference: v.reference,
    planeZ: v.reference === 'plane' ? num(v.planeZ, 'Plane height') : null,
    cellSize: num(v.cellSize, 'Cell', { positive: true }),
    classes: parseClasses(v.classes),
    fillGaps: v.fillGaps,
    outName: s.name.trim() || 'volume',
  };
}

export function changeParams(s: SurveyState, dir: string) {
  const c = s.change;
  if (!c.referenceDir) throw new Error('Choose the dataset to compare with.');
  return {
    octreeDir: dir,
    referenceDir: c.referenceDir,
    voxelSize: num(c.voxelSize, 'Voxel', { positive: true }),
    neighbours: c.neighbours,
    minPoints: Math.round(num(c.minPoints, 'Points per voxel', { min: 1 })),
    writeColumn: c.writeColumn,
  };
}

export function orthoParams(s: SurveyState, dir: string) {
  const o = s.ortho;
  const near = o.depthNear.trim(), far = o.depthFar.trim();
  const depth = o.view === 'side' && (near !== '' || far !== '')
    ? [near === '' ? -1e9 : num(near, 'In front'), far === '' ? 1e9 : num(far, 'Behind')]
    : null;
  return {
    octreeDir: dir,
    view: o.view,
    bearingDeg: o.view === 'side' ? num(o.bearingDeg, 'Bearing') : 0,
    pixelSize: num(o.pixelSize, 'Pixel', { positive: true }),
    color: o.color,
    polygon: o.useArea ? areaPolygon(s) : [],
    depth,
    shade: o.shade,
    outName: s.name.trim() || 'ortho',
  };
}

export function profileParams(s: SurveyState, dir: string) {
  if (s.points.length < 2) throw new Error('Draw the section line first (Measure, two points or more).');
  return {
    octreeDir: dir,
    line: s.points.map((p) => [p[0], p[1]]),
    width: num(s.profile.width, 'Corridor width', { positive: true }),
    maxPreview: 200_000,
    outName: s.name.trim() || 'profile',
  };
}

/** A height window typed as two optional numbers. */
function zRange(lo: string, hi: string): [number, number] | null {
  if (lo.trim() === '' && hi.trim() === '') return null;
  return [lo.trim() === '' ? -1e9 : num(lo, 'Lowest height'), hi.trim() === '' ? 1e9 : num(hi, 'Highest height')];
}

export function meshParams(s: SurveyState, dir: string) {
  const m = s.mesh;
  return {
    octreeDir: dir,
    method: m.method,
    cellSize: num(m.cellSize, m.method === '3d' ? 'Voxel' : 'Cell', { positive: true }),
    surface: m.surface,
    polygon: m.useArea ? areaPolygon(s) : [],
    classes: parseClasses(m.classes),
    zRange: zRange(m.zLow, m.zHigh),
    fillGaps: m.fillGaps,
    minPoints: Math.round(num(m.minPoints, 'Points per voxel', { min: 1 })),
    smooth: Math.round(num(m.smooth, 'Smoothing', { min: 0 })),
    decimate: num(m.decimate, 'Decimation', { min: 0 }),
    formats: ['ply', ...(m.obj ? ['obj'] : []), ...(m.stl ? ['stl'] : []), ...(m.dxf ? ['dxf'] : [])],
    outName: s.name.trim() || 'mesh',
  };
}

export function dxfParams(s: SurveyState, dir: string) {
  const d = s.dxf;
  return {
    octreeDir: dir,
    polygon: d.useArea ? areaPolygon(s) : [],
    classes: parseClasses(d.classes),
    zRange: zRange(d.zLow, d.zHigh),
    every: Math.round(num(d.every, 'Every n-th point', { min: 1 })),
    maxPoints: Math.round(num(d.maxPoints, 'Most points', { min: 1 })),
    outName: s.name.trim() || 'points',
  };
}

// ---------------------------------------------------------------------------
// meshes in the viewer

const MESH_COLORS = ['#c8b48a', '#8ec5d6', '#d69ab0', '#a9cf8c', '#d9b36c'];
/** Gives a mesh made anew a new id, so the viewer reads the file again. */
let meshSerial = 0;

export function addMesh(path: string): void {
  setSurveyState((s) => {
    if (s.meshes.some((m) => m.path === path)) {
      return { meshes: s.meshes.map((m) => (m.path === path ? { ...m, visible: true, id: `${path}#${++meshSerial}` } : m)) };
    }
    const name = path.split(/[\\/]/).pop() ?? path;
    const color = MESH_COLORS[s.meshes.length % MESH_COLORS.length];
    return { meshes: [...s.meshes, { id: `${path}#${++meshSerial}`, path, name, visible: true, color, opacity: 1 }] };
  });
}

export function updateMesh(path: string, patch: Partial<SurveyMesh>): void {
  setSurveyState((s) => ({ meshes: s.meshes.map((m) => (m.path === path ? { ...m, ...patch } : m)) }));
}

export function removeMesh(path: string): void {
  setSurveyState((s) => ({ meshes: s.meshes.filter((m) => m.path !== path) }));
}

// ---------------------------------------------------------------------------
// trajectories in the viewer

const TRAJECTORY_COLORS = ['#ff9f43', '#4fc3f7', '#f06292', '#dce775'];

export function addTrajectory(path: string): void {
  setSurveyState((s) => {
    if (s.trajectories.some((t) => t.path === path)) {
      return { trajectories: s.trajectories.map((t) => (t.path === path ? { ...t, visible: true, id: `${path}#${++meshSerial}` } : t)) };
    }
    const name = path.split(/[\\/]/).pop() ?? path;
    const color = TRAJECTORY_COLORS[s.trajectories.length % TRAJECTORY_COLORS.length];
    return { trajectories: [...s.trajectories, { id: `${path}#${++meshSerial}`, path, name, visible: true, color }] };
  });
}

export function updateTrajectory(path: string, patch: Partial<SurveyTrajectory>): void {
  setSurveyState((s) => ({ trajectories: s.trajectories.map((t) => (t.path === path ? { ...t, ...patch } : t)) }));
}

export function removeTrajectory(path: string): void {
  setSurveyState((s) => ({ trajectories: s.trajectories.filter((t) => t.path !== path) }));
}

// ---------------------------------------------------------------------------
// Points and lines from a run's files

const FEATURE_COLORS: Record<FeatureKind, string> = {
  positions: '#ffd54f', targets: '#ff7043', stems: '#81c784', region: '#64b5f6', voxels: '#ba68c8', raster: '#4dd0e1',
};

export function addFeature(path: string, kind: FeatureKind): void {
  setSurveyState((s) => {
    if (s.features.some((f) => f.path === path)) {
      return { features: s.features.map((f) => (f.path === path ? { ...f, visible: true, id: `${path}#${++meshSerial}` } : f)) };
    }
    const name = path.split(/[\\/]/).pop() ?? path;
    return { features: [...s.features, { id: `${path}#${++meshSerial}`, path, name, kind, visible: true, color: FEATURE_COLORS[kind] }] };
  });
}

export function updateFeature(path: string, patch: Partial<SurveyFeature>): void {
  setSurveyState((s) => ({ features: s.features.map((f) => (f.path === path ? { ...f, ...patch } : f)) }));
}

export function removeFeature(path: string): void {
  setSurveyState((s) => ({ features: s.features.filter((f) => f.path !== path) }));
}

/** The positions of a trajectory text file — `time x y z …` per line (TUM, as
 *  mobile scanners' software writes it), comments and headers
 *  skipped — kept every `step` metres along the path, and the last. */
export function parseTrajectory(text: string, step = 0.2): number[] {
  const out: number[] = [];
  let last: [number, number, number] | null = null;
  let pending: [number, number, number] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('%') || t.startsWith('//')) continue;
    const f = t.split(/[\s,;]+/);
    if (f.length < 4) continue;
    const x = Number(f[1]), y = Number(f[2]), z = Number(f[3]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(Number(f[0]))) continue;
    const p: [number, number, number] = [x, y, z];
    if (!last || Math.hypot(x - last[0], y - last[1], z - last[2]) >= step) {
      out.push(x, y, z);
      last = p;
      pending = null;
    } else {
      pending = p;
    }
  }
  if (pending) out.push(...pending);
  return out;
}

// ---------------------------------------------------------------------------
// running a tool

/** The backend's progress stage of each tool (also what Stop cancels). */
export const SURVEY_STAGES: Record<SurveyTab, string> = {
  measure: 'geometry', contours: 'contours', volume: 'volume', change: 'voxel_change', ortho: 'ortho', profile: 'profile',
  mesh: 'mesh', export: 'dxf_points',
};

export async function runSurveyJob<T>(kind: SurveyTab, work: () => Promise<T>): Promise<T | null> {
  if (state.job) return null;
  const stage = SURVEY_STAGES[kind];
  setSurveyState({ job: { kind, stage, pct: 0 }, error: null });
  let off: (() => void) | undefined;
  try {
    const d = surveyDesktop();
    if (d?.onOctreeProgress) {
      off = await Promise.resolve(d.onOctreeProgress((e) => {
        if (e.stage === stage && state.job) setSurveyState({ job: { ...state.job, pct: e.pct } });
      }));
    }
    return await work();
  } catch (e) {
    setSurveyState({ error: e instanceof Error ? e.message : String(e) });
    return null;
  } finally {
    off?.();
    setSurveyState({ job: null });
  }
}

export function stopSurveyJob(): void {
  const j = state.job;
  if (j) void surveyDesktop()?.octreeCancel?.(j.stage);
}

// ---------------------------------------------------------------------------
// what the viewer draws

export interface SurveySegment { a: Vec3; b: Vec3; color: string }
export interface SurveyDot { p: Vec3; color: string }
export interface SurveyOverlayData { segments: SurveySegment[]; dots: SurveyDot[] }

export const SURVEY_COLORS = {
  line: '#ffb020',
  vertex: '#ffe08a',
  corridor: '#4fd1e8',
  contour: '#c9a46a',
  contourIndex: '#ffd27a',
  gone: '#ff4d5e',
} as const;

/** Everything the overlay draws for a state: the line (closed for an
 *  area), the profile's corridor, the contours and the gone voxels. */
export function surveyOverlay(s: SurveyState): SurveyOverlayData {
  const segments: SurveySegment[] = [];
  const dots: SurveyDot[] = [];
  const pts = s.points;
  for (let i = 0; i + 1 < pts.length; i++) segments.push({ a: pts[i], b: pts[i + 1], color: SURVEY_COLORS.line });
  if (s.closed && pts.length > 2) segments.push({ a: pts[pts.length - 1], b: pts[0], color: SURVEY_COLORS.line });
  for (const p of pts) dots.push({ p, color: SURVEY_COLORS.vertex });
  const width = Number(s.profile.width);
  if (s.tab === 'profile' && pts.length >= 2 && width > 0) {
    for (const side of corridor(pts, width)) {
      for (let i = 0; i + 1 < side.length; i++) segments.push({ a: side[i], b: side[i + 1], color: SURVEY_COLORS.corridor });
    }
  }
  if (s.showContours && s.contours) {
    for (const l of s.contours.lines) {
      const c = l.index ? SURVEY_COLORS.contourIndex : SURVEY_COLORS.contour;
      for (let i = 0; i + 1 < l.points.length; i++) segments.push({ a: l.points[i], b: l.points[i + 1], color: c });
      if (l.closed && l.points.length > 2) segments.push({ a: l.points[l.points.length - 1], b: l.points[0], color: c });
    }
  }
  if (s.showGone && s.changeResult) for (const p of s.changeResult.gone) dots.push({ p, color: SURVEY_COLORS.gone });
  return { segments, dots };
}

// ---------------------------------------------------------------------------
// the palette

export interface SurveyPaletteCommand { id: string; group?: string; title: string; keywords?: string; run: () => void }

let mounted = 0;

/** SurveyPanel calls this while it is on screen. */
export function surveyPanelMounted(): () => void {
  mounted += 1;
  return () => { mounted -= 1; };
}

export function openSurveyTab(tab: SurveyTab, togglePanel: () => void): void {
  setSurveyState({ tab });
  if (mounted === 0) togglePanel();
}

export function surveyPaletteCommands(togglePanel: () => void): SurveyPaletteCommand[] {
  const open = (tab: SurveyTab) => () => openSurveyTab(tab, togglePanel);
  return [
    { id: 'survey.measure', group: 'Survey', title: 'Survey: measure a polyline or an area…', keywords: 'distance length area polygon perimeter', run: open('measure') },
    { id: 'survey.contours', group: 'Survey', title: 'Survey: contour lines of the ground…', keywords: 'contour isoline dtm dxf geojson', run: open('contours') },
    { id: 'survey.volume', group: 'Survey', title: 'Survey: volume (cut and fill) of an area…', keywords: 'volume cut fill stockpile pile plane dtm', run: open('volume') },
    { id: 'survey.change', group: 'Survey', title: 'Survey: voxel change against another acquisition…', keywords: 'change detection voxel difference compare', run: open('change') },
    { id: 'survey.ortho', group: 'Survey', title: 'Survey: ortho image (top or side view)…', keywords: 'orthophoto ortho plot png geotiff raster image', run: open('ortho') },
    { id: 'survey.profile', group: 'Survey', title: 'Survey: section profile along a line…', keywords: 'section profile cross transect slice', run: open('profile') },
    { id: 'survey.mesh', group: 'Survey', title: 'Survey: triangle mesh (2.5D or 3D), or show a mesh file…', keywords: 'mesh triangulate tin obj stl ply surface', run: open('mesh') },
    { id: 'survey.export', group: 'Survey', title: 'Survey: export points as DXF…', keywords: 'dxf cad autocad points export', run: open('export') },
    { id: 'panel.survey', group: 'Panels', title: 'Toggle Survey panel', run: togglePanel },
  ];
}
