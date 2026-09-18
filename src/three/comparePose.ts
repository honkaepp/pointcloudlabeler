/** The Compare view's camera, saved views and export bookkeeping — the
 *  parts with no WebGL in them, so they can be tested on their own.
 *
 *  ONE CAMERA, TWO SCENES. The Compare view shows the source and the
 *  target of a skeleton transfer side by side, and one camera drives
 *  both. The two clouds are two octrees with two offsets, and each
 *  renders in its own scene frame (source coordinates minus its offset,
 *  with the editor's axis swap — see io/sceneAxes.ts). A pose shared
 *  between them therefore has to live in WORLD coordinates, the source
 *  CRS both clouds were imported in: east, north, up. Each pane converts
 *  on the way in and out with its own offset. Two clouds of one plot
 *  imported on different days, with different offsets, then show the
 *  same place from the same point — which is the whole point.
 *
 *  Saved views are world poses too, for the same reason, and carry the
 *  pair of datasets they were saved for. */

import type { ColorMode, SkeletonColorMode } from '../components/shell/OctreeShellContext';
import type { FrameGuess } from '../components/shell/heightFrames';

export type Vec3 = [number, number, number];

/** A camera pose in world coordinates (source CRS: east, north, up). */
export interface CameraPose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  fov: number;
}

/** The same pose in a pane's scene frame. */
export interface ScenePose {
  position: Vec3;
  target: Vec3;
  up: Vec3;
  fov: number;
}

/** World point → scene point, for a cloud with `offset`. The editor's
 *  convention: scene X = east, scene Y = up, scene Z = −north. */
export function worldToScene(p: Vec3, offset: Vec3): Vec3 {
  // `0 -` rather than a unary minus: -(0) is -0, which JSON and a
  // deep-equality test both tell from 0.
  return [p[0] - offset[0], p[2] - offset[2], 0 - (p[1] - offset[1])];
}

/** The inverse of worldToScene. */
export function sceneToWorld(s: Vec3, offset: Vec3): Vec3 {
  return [s[0] + offset[0], offset[1] - s[2], s[1] + offset[2]];
}

/** A direction (no offset): world → scene. */
export function dirToScene(d: Vec3): Vec3 {
  return [d[0], d[2], 0 - d[1]];
}

/** A direction (no offset): scene → world. */
export function dirToWorld(s: Vec3): Vec3 {
  return [s[0], 0 - s[2], s[1]];
}

/** A rigid transform of the ground plane in WORLD coordinates: rotation
 *  by `theta` about (cx, cy), then translation by (dx, dy). The skeleton
 *  alignment (src-tauri skelalign.rs) measures one from the source's
 *  skeletons onto the target's trees; the Compare takes the target
 *  pane's camera through it, so the two panes look at the same tree
 *  although the clouds stand apart. */
export interface Rigid2 {
  theta: number;
  dx: number;
  dy: number;
  cx: number;
  cy: number;
}

export function applyRigid(r: Rigid2, x: number, y: number): [number, number] {
  const s = Math.sin(r.theta), c = Math.cos(r.theta);
  const px = x - r.cx, py = y - r.cy;
  return [r.cx + c * px - s * py + r.dx, r.cy + s * px + c * py + r.dy];
}

/** The transform taking a moved point back — see Rigid2::inverse. */
export function invertRigid(r: Rigid2): Rigid2 {
  const s = Math.sin(-r.theta), c = Math.cos(-r.theta);
  return { theta: -r.theta, dx: -(c * r.dx - s * r.dy), dy: -(s * r.dx + c * r.dy), cx: r.cx, cy: r.cy };
}

/** A world point through the transform; z untouched. */
export function rigidPoint(r: Rigid2 | null | undefined, p: Vec3): Vec3 {
  if (!r) return p;
  const [x, y] = applyRigid(r, p[0], p[1]);
  return [x, y, p[2]];
}

/** A world direction through the transform's rotation. */
export function rigidDir(r: Rigid2 | null | undefined, d: Vec3): Vec3 {
  if (!r) return d;
  const s = Math.sin(r.theta), c = Math.cos(r.theta);
  return [c * d[0] - s * d[1], s * d[0] + c * d[1], d[2]];
}

/** The box that holds every corner of `box` taken through `r`. */
export function boxThrough(box: { min: Vec3; max: Vec3 }, r: Rigid2 | null | undefined): { min: Vec3; max: Vec3 } {
  if (!r) return box;
  const min: Vec3 = [Infinity, Infinity, box.min[2]];
  const max: Vec3 = [-Infinity, -Infinity, box.max[2]];
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      const [px, py] = applyRigid(r, x, y);
      if (px < min[0]) min[0] = px; if (px > max[0]) max[0] = px;
      if (py < min[1]) min[1] = py; if (py > max[1]) max[1] = py;
    }
  }
  return { min, max };
}

/** The stored alignment's transform, which is in the skeleton origin's
 *  frame, as a world transform. */
export function alignmentToWorld(a: { dx: number; dy: number; theta: number; cx: number; cy: number }, origin: [number, number, number]): Rigid2 {
  return { theta: a.theta, dx: a.dx, dy: a.dy, cx: origin[0] + a.cx, cy: origin[1] + a.cy };
}

/** `zBase` is the pane's HEIGHT BASE: the world z that the shared
 *  pose's z = 0 stands at in this cloud. Zero for a cloud in the shared
 *  frame already; a cloud in elevation beside a normalised one gets its
 *  ground level, so the pose's z reads as height above ground on both
 *  sides — see heightBasesFor. */
export function poseToScene(pose: CameraPose, offset: Vec3, zBase = 0, rigid: Rigid2 | null = null): ScenePose {
  // The shared pose is in the SOURCE's frame; a pane whose cloud stands
  // elsewhere (the aligned target) takes it through its transform first.
  const lift = (p: Vec3): Vec3 => { const q = rigidPoint(rigid, p); return [q[0], q[1], q[2] + zBase]; };
  return {
    position: worldToScene(lift(pose.position), offset),
    target: worldToScene(lift(pose.target), offset),
    up: dirToScene(rigidDir(rigid, pose.up)),
    fov: pose.fov,
  };
}

export function poseFromScene(scene: ScenePose, offset: Vec3, zBase = 0, rigid: Rigid2 | null = null): CameraPose {
  const inv = rigid ? invertRigid(rigid) : null;
  const drop = (p: Vec3): Vec3 => { const w = sceneToWorld(p, offset); return rigidPoint(inv, [w[0], w[1], w[2] - zBase]); };
  return {
    position: drop(scene.position),
    target: drop(scene.target),
    up: rigidDir(inv, dirToWorld(scene.up)),
    fov: scene.fov,
  };
}

/** The height base of each pane — see poseToScene.
 *
 *  A TLS plot normalised to height above ground beside a HeliALS epoch
 *  in elevation stood 540 m apart under one camera: the left pane
 *  showed its cloud at the bottom of the screen, the right pane its
 *  cloud at the top, and nothing could be compared. With alignment on,
 *  a side whose z is elevation gets its ground level (the median of its
 *  class-2 surface under the other cloud's footprint) as base, a side
 *  already in height above ground gets zero, so the shared pose is a
 *  height on both. A CONSTANT per side: the terrain's relief across the
 *  plot is what remains, a few metres at most, where a per-point
 *  flattening would move every node's box under the planner. With
 *  alignment off both bases are zero and the pose is world z. */
export interface HeightBases { source: number; target: number }

export function heightBasesFor(
  align: boolean,
  source: { guess: FrameGuess; groundZ: number | null },
  target: { guess: FrameGuess; groundZ: number | null },
): HeightBases {
  if (!align) return { source: 0, target: 0 };
  const base = (side: { guess: FrameGuess; groundZ: number | null }) =>
    side.guess === 'absolute' && side.groundZ !== null && Number.isFinite(side.groundZ) ? side.groundZ : 0;
  return { source: base(source), target: base(target) };
}

/** The XY footprint two clouds share, or null when they do not overlap. */
export function footprintIntersection(
  a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 },
): [number, number, number, number] | null {
  const x0 = Math.max(a.min[0], b.min[0]);
  const y0 = Math.max(a.min[1], b.min[1]);
  const x1 = Math.min(a.max[0], b.max[0]);
  const y1 = Math.min(a.max[1], b.max[1]);
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

function vecEqual(a: Vec3, b: Vec3, eps: number): boolean {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps && Math.abs(a[2] - b[2]) <= eps;
}

export function posesEqual(a: CameraPose, b: CameraPose, eps = 1e-6): boolean {
  return vecEqual(a.position, b.position, eps)
    && vecEqual(a.target, b.target, eps)
    && vecEqual(a.up, b.up, eps)
    && Math.abs(a.fov - b.fov) <= eps;
}

export function isFinitePose(p: CameraPose): boolean {
  const ok = (v: Vec3) => v.length === 3 && v.every((x) => Number.isFinite(x));
  return ok(p.position) && ok(p.target) && ok(p.up) && Number.isFinite(p.fov) && p.fov > 0 && p.fov < 180;
}

/** The view a pair of clouds opens on: the editor's own start camera
 *  (centre + 0.8 · extent east, 0.6 · extent up, and 0.8 · extent to
 *  the south, which is +Z in the scene) over the union of both boxes,
 *  so neither cloud starts off screen. */
export function defaultPose(boxes: Array<{ min: Vec3; max: Vec3 }>): CameraPose {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      if (b.min[i] < min[i]) min[i] = b.min[i];
      if (b.max[i] > max[i]) max[i] = b.max[i];
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) {
    return { position: [0.8, -0.8, 0.6], target: [0, 0, 0], up: [0, 0, 1], fov: 45 };
  }
  const centre: Vec3 = [0.5 * (min[0] + max[0]), 0.5 * (min[1] + max[1]), 0.5 * (min[2] + max[2])];
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1);
  return {
    position: [centre[0] + extent * 0.8, centre[1] - extent * 0.8, centre[2] + extent * 0.6],
    target: centre,
    up: [0, 0, 1],
    fov: 45,
  };
}

/** The larger of the two clouds' spans — what the panes' clip planes
 *  and the start distance are scaled by. */
export function extentOf(boxes: Array<{ min: Vec3; max: Vec3 }>): number {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) {
    for (let i = 0; i < 3; i++) {
      if (b.min[i] < min[i]) min[i] = b.min[i];
      if (b.max[i] > max[i]) max[i] = b.max[i];
    }
  }
  const e = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  return e > 0 && Number.isFinite(e) ? e : 1;
}

// ------------------------------------------------------------------
// Saved views
// ------------------------------------------------------------------

export const COMPARE_VIEWS_FILE = 'compare_views.json';
const VIEWS_FORMAT = 'pointcloudlabeler-compare-views';

export interface SavedViewDataset {
  /** The dataset's directory, as the project lists it. */
  dir: string;
  /** Its display name, for a reader of the file. */
  name: string;
}

export interface SavedView {
  name: string;
  /** ISO 8601, when it was saved. */
  savedAt: string;
  pose: CameraPose;
  source: SavedViewDataset;
  target: SavedViewDataset;
  /** The height bases the pose was saved under (see heightBasesFor);
   *  absent in a file from before alignment existed, which means both
   *  zero. */
  heightBase?: HeightBases;
}

export function serializeViews(views: SavedView[]): string {
  return JSON.stringify({ format: VIEWS_FORMAT, version: 1, views }, null, 2);
}

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

function isDataset(d: unknown): d is SavedViewDataset {
  return !!d && typeof d === 'object'
    && typeof (d as SavedViewDataset).dir === 'string'
    && typeof (d as SavedViewDataset).name === 'string';
}

/** Parse a views file. Throws on a file that is not one; drops an
 *  entry that is malformed rather than the whole file, so one bad
 *  hand-edit does not lose every other view. */
export function parseViews(text: string): SavedView[] {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || (parsed as { format?: unknown }).format !== VIEWS_FORMAT) {
    throw new Error(`not a ${VIEWS_FORMAT} file`);
  }
  const raw = (parsed as { views?: unknown }).views;
  if (!Array.isArray(raw)) return [];
  const out: SavedView[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const e = v as Partial<SavedView>;
    const p = e.pose as Partial<CameraPose> | undefined;
    if (typeof e.name !== 'string' || typeof e.savedAt !== 'string') continue;
    if (!p || !isVec3(p.position) || !isVec3(p.target) || !isVec3(p.up) || typeof p.fov !== 'number') continue;
    if (!isDataset(e.source) || !isDataset(e.target)) continue;
    const pose: CameraPose = { position: p.position, target: p.target, up: p.up, fov: p.fov };
    if (!isFinitePose(pose)) continue;
    const hb = e.heightBase;
    const heightBase = hb && typeof hb === 'object' && Number.isFinite(hb.source) && Number.isFinite(hb.target)
      ? { source: hb.source, target: hb.target } : undefined;
    out.push({ name: e.name, savedAt: e.savedAt, pose, source: e.source, target: e.target, ...(heightBase ? { heightBase } : {}) });
  }
  return out;
}

// ------------------------------------------------------------------
// Export
// ------------------------------------------------------------------

export const DEFAULT_EXPORT_SIZE = { width: 2400, height: 1800 };
/** The white gap between the two panes in the side-by-side PNG. Fixed,
 *  so two figures exported months apart line up. */
export const SIDE_BY_SIDE_GUTTER_PX = 48;
/** Neither dimension goes past this: a 16 k render target is the
 *  common WebGL ceiling and two of them at once are the export. */
export const MAX_EXPORT_SIDE_PX = 8192;
/** The least a pane streams with, however small the total budget: a
 *  pane that cannot hold a tree is no comparison. */
export const MIN_PANE_BUDGET = 250_000;

export function clampExportSize(width: number, height: number): { width: number; height: number } {
  const w = Number.isFinite(width) ? Math.round(width) : DEFAULT_EXPORT_SIZE.width;
  const h = Number.isFinite(height) ? Math.round(height) : DEFAULT_EXPORT_SIZE.height;
  return {
    width: Math.min(MAX_EXPORT_SIDE_PX, Math.max(64, w)),
    height: Math.min(MAX_EXPORT_SIDE_PX, Math.max(64, h)),
  };
}

export function sideBySideSize(width: number, height: number, gutter = SIDE_BY_SIDE_GUTTER_PX): { width: number; height: number } {
  return { width: 2 * width + gutter, height };
}

/** Two live panes share the one point budget: each streams with half,
 *  so the pair costs what the single view did. */
export function splitBudget(total: number): number {
  const half = Math.floor((Number.isFinite(total) ? total : 0) / 2);
  return Math.max(MIN_PANE_BUDGET, half);
}

/** An export plans at the FULL budget, not the pane's half: a figure at
 *  screen LOD looks sparse in print. */
export function exportBudget(total: number): number {
  return Math.max(MIN_PANE_BUDGET, Number.isFinite(total) ? Math.floor(total) : MIN_PANE_BUDGET);
}

/** The on-screen point size scaled to the export's height, so a dot
 *  covers the same fraction of the figure it covers of the screen. */
export function exportPointSize(screenPointSize: number, screenHeight: number, exportHeight: number): number {
  const s = Number.isFinite(screenPointSize) && screenPointSize > 0 ? screenPointSize : 1;
  if (!(screenHeight > 0) || !(exportHeight > 0)) return s;
  return Math.max(1, Math.round(s * (exportHeight / screenHeight) * 10) / 10);
}

export interface ExportPaneInfo {
  dir: string;
  name: string;
  /** Points of this cloud drawn in the export, from the streamer's
   *  count at the moment of the render. */
  pointsRendered: number;
  file: string;
}

export interface ExportSidecar {
  format: 'pointcloudlabeler-compare-export';
  version: 1;
  app: { name: string; version: string };
  exportedAt: string;
  /** In the shared frame: world x, y and a z that is height above
   *  `heightBase` on each side. */
  camera: CameraPose;
  heightBase: HeightBases;
  colorMode: ColorMode;
  hideUnlabeled: boolean;
  skeletonOverlay: boolean;
  skeletonColor: SkeletonColorMode | null;
  pixelSize: { width: number; height: number };
  background: '#ffffff';
  source: ExportPaneInfo;
  target: ExportPaneInfo;
  sideBySide: { file: string; gutterPx: number } | null;
}

export function buildSidecar(input: {
  appVersion: string;
  exportedAt: string;
  camera: CameraPose;
  heightBase: HeightBases;
  colorMode: ColorMode;
  hideUnlabeled: boolean;
  skeletonOverlay: boolean;
  skeletonColor: SkeletonColorMode | null;
  pixelSize: { width: number; height: number };
  source: ExportPaneInfo;
  target: ExportPaneInfo;
  sideBySide: string | null;
}): ExportSidecar {
  return {
    format: 'pointcloudlabeler-compare-export',
    version: 1,
    app: { name: 'PointCloudLabeler', version: input.appVersion },
    exportedAt: input.exportedAt,
    camera: {
      position: [...input.camera.position] as Vec3,
      target: [...input.camera.target] as Vec3,
      up: [...input.camera.up] as Vec3,
      fov: input.camera.fov,
    },
    heightBase: { ...input.heightBase },
    colorMode: input.colorMode,
    hideUnlabeled: input.hideUnlabeled,
    skeletonOverlay: input.skeletonOverlay,
    skeletonColor: input.skeletonColor,
    pixelSize: { ...input.pixelSize },
    background: '#ffffff',
    source: { ...input.source },
    target: { ...input.target },
    sideBySide: input.sideBySide ? { file: input.sideBySide, gutterPx: SIDE_BY_SIDE_GUTTER_PX } : null,
  };
}

/** The file names one export writes, from a base path. */
export function exportFileNames(base: string, sideBySide: boolean): {
  source: string; target: string; sideBySide: string | null; sidecar: string;
} {
  return {
    source: `${base}_source.png`,
    target: `${base}_target.png`,
    sideBySide: sideBySide ? `${base}_side-by-side.png` : null,
    sidecar: `${base}.json`,
  };
}

/** A file-name-safe timestamp: 2026-09-14T07-48-35. */
export function exportStamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
}

// ------------------------------------------------------------------
// The view's surface to the shell and the panel
// ------------------------------------------------------------------

/** Any of the viewport's colour modes, over both panes at once. */
export type CompareColorMode = ColorMode;

/** What the Skeleton Transfer panel asks the shell to show. */
export interface CompareRequest {
  sourceDir: string;
  targetDir: string;
  colorMode: CompareColorMode;
  /** Draw the plot-level skeleton (the shell's skeletonOverlay) over the
   *  target pane, coloured by `skeletonColor`. */
  showSkeleton: boolean;
  skeletonColor: SkeletonColorMode;
  /** Leave tree id 0 out of both panes. */
  hideUnlabeled: boolean;
  /** Put both clouds in one height — see heightBasesFor. */
  alignHeights: boolean;
  /** The source's skeletons onto the target's trees, in world
   *  coordinates — see Rigid2. The target pane's camera goes through
   *  it. Null: the clouds are taken to be registered. */
  alignment?: Rigid2 | null;
}

export interface PaneStats {
  visiblePoints: number;
  loadedPoints: number;
  pendingNodes: number;
}

export interface PaneRenderResult {
  png: Uint8Array;
  /** The pane's visible-point count at the moment of the render. */
  pointsRendered: number;
  /** False when the streamer had not finished loading the export's
   *  node set inside the wait: the figure is what was resident then. */
  settled: boolean;
}

export interface CompareExportResult {
  width: number;
  height: number;
  /** The camera the figures were rendered with — the live one, in the
   *  shared frame — and the height base of each side under it. */
  camera: CameraPose;
  heightBase: HeightBases;
  source: PaneRenderResult;
  target: PaneRenderResult;
  /** The two panes side by side with a white gutter, when asked for. */
  sideBySide: Uint8Array | null;
}

export interface CompareApi {
  getPose(): CameraPose;
  /** Move both panes to `pose`. */
  setPose(pose: CameraPose): void;
  /** Render both panes offscreen at `width` × `height` on white, at the
   *  full point budget, no UI. */
  exportFigures(opts: { width: number; height: number; sideBySide: boolean }): Promise<CompareExportResult>;
  stats(): { source: PaneStats | null; target: PaneStats | null };
  /** The height base of each pane under the current alignment. */
  heightBases(): HeightBases;
  /** Extra columns both clouds carry, for the colour-by choice. */
  columns(): string[];
}
