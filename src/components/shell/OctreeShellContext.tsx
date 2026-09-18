// Shared state for the octree editor's shell + panels. Lifts the
// display config, tool config, active tree_id, selection / dirty state
// and the imperative action API out of OctreeView so the surrounding
// shell (toolbar, panels, status bar, command palette) can read and
// drive the viewer without prop-drilling.
//
// OctreeView consumes display + tool state via props for clarity inside
// the viewer; the shell hoists them here, passes them down, and exposes
// the rest of the editor surface via context so any panel can reach
// undo / save / export / preset views without threading callbacks.

import { createContext, useContext } from 'react';
import type { AnalysisLayer, LayerKind, LayerPayload } from '../../layers/analysisLayers';
import type { CompareApi, CompareRequest } from '../../three/comparePose';
import type { IsolateMargin } from '../../three/filterGeometry';
import type { OctreeListEntry, OpenOctree, RasterLayer } from '../../persistence/octreeReader';

/** A second (and beyond) point cloud rendered into the scene as a
 *  read-only overlay alongside the primary editable cloud. Edits +
 *  filters + analysis still target the primary cloud; overlays are
 *  positioned into the primary's scene via an offset correction so
 *  spatially-coincident clouds line up. */
export interface SecondaryCloud {
  id: string;
  label: string;
  visible: boolean;
  /** Hex tint applied to every point ('#rrggbb') when colorMode is 'flat',
   *  and the high end of the ramp when colorMode is 'height'. */
  color: string;
  /** How the overlay is coloured. 'flat' uses the tint; 'height' ramps over
   *  the overlay's own Z range; 'intensity' ramps over its own intensity
   *  range; 'classification' uses the ASPRS class palette; 'tree_id' uses
   *  a hash colour per tree id. Every mode reads fields that are already
   *  decoded from the overlay's octree.bin, so no format extension is
   *  needed and tweaks repaint instantly. */
  colorMode: 'flat' | 'height' | 'intensity' | 'classification' | 'tree_id' | `extra:${string}`;
  /** When true, the primary's filters (hide unassigned / isolate / id
   *  range / hidden classes) are mirrored onto this overlay too. When
   *  false, every overlay point is drawn regardless of the primary's
   *  filter state, which is useful when an overlay is a reference layer
   *  whose points wouldn't carry meaningful tree ids in the first place. */
  syncFilters: boolean;
  octree: OpenOctree;
}

/** Colour mode for the primary cloud. Categorical / built-in modes are
 *  string literals; per-extra modes are encoded as `extra:<name>` so the
 *  same ColorMode field carries everything the Display panel exposes
 *  without a separate `extraName` field. */
export type ColorMode = 'height' | 'intensity' | 'classification' | 'tree_id' | 'semantic' | 'standing_deadwood' | 'laying_deadwood' | 'flat' | 'x' | 'y' | `extra:${string}`;
export type SelectTool = 'rect' | 'lasso' | 'poly';
export type SelectDepth = 'visible' | 'through';
/** Continuous colour ramp applied to the scalar modes (height /
 *  intensity / x / y / extras). 'forest' is PointCloudLabeler's native green ramp. */
export type ColorRamp = 'forest' | 'viridis' | 'turbo' | 'inferno' | 'grayscale' | 'magma' | 'cividis' | 'plasma' | 'ocean' | 'spectral' | 'rdylgn' | 'custom';

/** Forestry plot boundary — used by every per-hectare statistic and
 *  by the edge-correction logic. Coordinates are in the dataset's
 *  source CRS (same frame as TreeMetric x / y). */
export type PlotBoundary =
  | { kind: 'circular'; center: [number, number]; radius: number }
  | { kind: 'rectangular'; min: [number, number]; max: [number, number] };

/** Stem centreline overlay — one polyline per tree, drawn in the
 *  viewport as a thin coloured line that traces the trunk axis. Nodes
 *  are in world / source-CRS coordinates (OctreeView reapplies the
 *  scene swap-and-negate at render time). */
export interface StemCenterlineOverlay {
  trees: Array<{
    treeId: number;
    nodes: Array<{ x: number; y: number; z: number; radius: number }>;
  }>;
}

/** Skeleton points overlay — flat xyz buffer + parallel tree_id /
 *  branch_order arrays. Drawn in the viewport as small colored dots
 *  (one draw call regardless of point count). Pushed by the Skeleton
 *  Transfer panel's "Build" stage; survives across panel re-opens
 *  until the user clears it explicitly. */
export interface SkeletonOverlay {
  /** World origin the xyz are relative to; see skeletonPlanar.ts. */
  origin: [number, number, number];
  /** length = 3 × point count, world / source-CRS coords. */
  xyz: Float32Array;
  /** Length = point count. */
  treeId: Int32Array;
  /** Length = point count. 0 = trunk, ≥ 1 = branch. */
  order: Uint8Array;
  /** Length = point count. QSM cylinder radius, mm. */
  radiusMm: Uint16Array;
  /** What the dots are coloured by: the instance (tree id), the class
   *  (stem / branch from the branching order), or the cylinder radius. */
  colorMode: SkeletonColorMode;
  /** The dataset the skeletons were read from. The viewport needs its
   *  ground when the skeletons are in elevation and the cloud they are
   *  drawn over is normalised — see three/useTerrain.ts. */
  sourceDir?: string;
  /** Where the skeletons stand over the cloud they are drawn on: the
   *  alignment onto that cloud's trees, in the skeleton origin's frame
   *  (see SkeletonAlignment). Applied to every point before it is
   *  drawn. Null draws them where they were built. */
  alignment?: AlignmentParam | null;
}

/** A rigid transform of the plane in the skeleton origin's frame:
 *  rotation by `theta` about (cx, cy), then translation by (dx, dy). */
export interface AlignmentParam {
  dx: number;
  dy: number;
  theta: number;
  cx: number;
  cy: number;
}

/** What the alignment step found — src-tauri skelalign.rs — kept beside
 *  the target as skeleton_alignment.json: the transform from the
 *  skeletons onto the target's trees. The skeletons are the ones that
 *  are right, so the target is moved by the inverse
 *  (octreeShiftGeoreference); until then the transfer and the views
 *  take the skeletons through it, which labels the same. */
export interface SkeletonAlignment extends AlignmentParam {
  format: string;
  baselineDir: string;
  targetDir: string;
  /** The skeleton origin (world) the transform's frame is relative to. */
  origin: [number, number, number];
  /** Of the trees matched by their stems after the fit (m); −1 when
   *  none were. */
  rmse: number;
  matchedTrees: number;
  treeCount: number;
  /** The coarse vote's peak over its best rival: above about 1.3 the
   *  shift is unambiguous, near 1 a guess. */
  confidence: number;
  coarse: AlignmentParam;
  createdAt: string;
  /** How far the TARGET has been moved (m east, north) onto the
   *  skeletons since this was measured; dx/dy are then the remaining
   *  offset. Zero until it is moved. */
  targetShifted?: [number, number];
}

export type SkeletonColorMode = 'tree' | 'class' | 'radius';

/** Result of the Tree Skeleton Transfer (Honkanen et al. 2026,
 *  doi:10.1016/j.ophoto.2026.100147)
 *  command — every count the panel + status banner display. */
export interface SkeletonTransferResult {
  baselineTreeCount: number;
  skeletonPointCount: number;
  targetEligibleCount: number;
  transferredCount: number;
  stemCount: number;
  branchCount: number;
  /** Farther from the skeleton than the distance threshold. These keep
   *  the tree of the nearest skeleton point — a leaf belongs to its
   *  tree even though it is not wood — unless `labelBeyondThreshold`
   *  was turned off. Their semantic byte is 0 either way. */
  unclassifiedCount: number;
  /** Outside the convex hull of the whole baseline skeleton, seen from
   *  above. Nothing is claimed about these. */
  outsideHullCount: number;
  /** The skeletons were moved by the panel's alignment before
   *  matching — see SkeletonAlignment. */
  alignmentApplied: boolean;
}

/** Parameters the panel sends to the backend. All optional — the
 *  backend has sensible defaults from the reference implementation. */
export interface SkeletonTransferParams {
  distanceThreshold?: number;
  skeletonSpacing?: number;
  groundThreshold?: number;
  rCover?: number;
  minTreePoints?: number;
  dtmCell?: number;
  /** Skip baseline points below this height above ground before
   *  reconstructing. Default 0 — the reference does not cut the
   *  baseline; its per-tree clouds are cut before it ever sees them. */
  baselineGroundThreshold?: number;
  /** Give a point beyond the distance threshold the tree of its nearest
   *  skeleton point anyway, as the reference method does, with the
   *  semantic byte left at 0 to say it is not wood. Default true. */
  labelBeyondThreshold?: boolean; skipAddedCylinders?: boolean; dropFarFragments?: boolean;
  /** Which z each side is matched in: as stored, or as height above
   *  its own class-2 ground surface. A normalised baseline against a
   *  target in elevation matches nothing as stored — see
   *  shell/heightFrames.ts. Default 'stored' on both sides. */
  baselineHeight?: 'stored' | 'above_ground';
  targetHeight?: 'stored' | 'above_ground';
  /** Move the skeletons onto the target's trees before matching: the
   *  transform the alignment step measured (SkeletonAlignment), in the
   *  skeleton origin's frame. Absent matches them where they are. */
  alignment?: AlignmentParam;
  /** How many of create_input.m's eight PatchDiam parameter sets each
   *  tree is reconstructed with, 1–8. Default 8, which is the full
   *  grid; `define_input(P,1,1,1)` hands treeqsm one. Eight is eight
   *  times the work, so this is the biggest single lever on how long a
   *  plot takes — and it changes which model comes out, since TreeQSM
   *  keeps the best of what it is given. */
  qsmModels?: number;
  /** Segments larger than this are thinned by the reference's own
   *  cubical downsampling at a coarser edge before reconstruction. A
   *  segmentation can put millions of points under one tree id, and
   *  one such segment costs more memory than a whole plot of real
   *  trees. 0 disables it — which is the reference's own case, since
   *  its input is one pre-cut tree per file. */
  maxTreePoints?: number;
}

/** Edge-correction method for inclusion-weighted per-tree statistics:
 *  - 'none'         — strict in/out by stem centre.
 *  - 'halfcount'    — tree counts 1.0 fully inside, 0.5 on the
 *                     boundary band (default boundary buffer 1 m).
 *  - 'crownArea'    — proportional to the fraction of the crown circle
 *                     that lies inside the plot. The most defensible
 *                     in mixed-density stands but needs crownArea on
 *                     the tree record. */
export type EdgeCorrection = 'none' | 'halfcount' | 'crownArea';

export interface DisplayConfig {
  colorMode: ColorMode;
  edlEnabled: boolean;
  edlStrength: number;
  /** Hard render budget in points. The streamer stops refining detail
   *  once the visible set crosses this; default 4 M is comfortable on
   *  most laptops. */
  pointBudget: number;
  /** Highlight colour (hex) for the active tree — the tree the Tree-id
   *  tools act on. Only shown while colouring by tree_id or semantic
   *  (the editable modes). Default pink. */
  activeTreeColor: string;
  /** Colour ramp for the scalar modes (height / intensity). */
  ramp: ColorRamp;
  /** On-screen point size in pixels (fixed, distance-independent). 1 is
   *  the original crisp-dot default; raise it for sparse clouds or to
   *  read structure on a high-DPI display. */
  pointSize: number;
  /** Low → high colours (hex) for the 'custom' ramp, so the user can
   *  define their own colouring for a scalar / extra column instead of
   *  picking a preset. Only consulted when ramp === 'custom'. */
  customRamp: [string, string];
  /** Colour (hex) used for "no label" points in the categorical edit
   *  modes — tree_id ≤ 0, semantic = 0, deadwood = (0, 0). Shared across
   *  the three so the unlabelled baseline reads the same in every edit
   *  workflow. Default is the neutral grey the tools panel used to hard
   *  code. */
  unlabeledColor: string;
  /** Per-extra-column ramp range overrides — keyed by extra name. When an
   *  entry is present, the `extra:<name>` colour mode uses that lo/hi
   *  instead of the cloud-wide observed range from metadata.extras.
   *  Useful when outliers compress the useful band so the user can squeeze
   *  the ramp into the part of the range that actually carries signal.
   *  Empty (default) ⇒ every extra ramps over its observed range. */
  extraRangeOverrides: Record<string, { lo: number; hi: number }>;
  /** Depth-cue the grey unassigned points while a tree is isolated in
   *  Tree Review: nearer background points render lighter, farther ones
   *  darker, so the grey cloud around the tree reads with depth instead
   *  of as one flat wall. Only active while isolating with the nearby
   *  points shown; the isolated tree's own colours stay full strength. */
  depthCueUnassigned: boolean;
  /** How hard the depth cue pushes, 0..1. 0 leaves the background flat
   *  (equivalent to the toggle being off), 1 runs the full span from
   *  noticeably brighter than base at the near edge to nearly black at
   *  the far one. The default used to be the ONLY setting, and it was
   *  spread over a depth range far wider than the points it dimmed, so
   *  the control read as doing nothing. */
  depthCueStrength: number;
  /** Show the colour-scale legend (bottom-left of the viewport) for the
   *  active colour mode. On by default — a measurement instrument should
   *  say what its colours mean; off for a user who'd rather have the
   *  corner clear for a screenshot. */
  showLegend: boolean;
  /** How every view draws heights: as the file stores them, or as height
   *  above the classified ground under each point (the terrain taken
   *  out, the ground drawn flat at its median level). A display choice
   *  only — coordinates, edits and exports stay stored. Persisted; see
   *  heightMode.ts. A cloud with no ground classification is drawn as
   *  stored either way, and the viewport says so. */
  heightMode: HeightMode;
  /** What the 'height' colour ramp runs over: the stored z (default),
   *  or the height above the classified ground under each point — the
   *  user's choice, whichever way the heights are drawn. Needs the
   *  cloud's terrain; without one the ramp stays on the stored z. */
  heightColorAboveGround: boolean;
}

export type HeightMode = 'stored' | 'above_ground';

export const DEFAULT_DISPLAY: DisplayConfig = {
  colorMode: 'height',
  // Eye-Dome Lighting is off by default — it's a depth-cue post-process
  // some users want, but the cloud should read the same as RiSCAN's plain
  // dots out of the box. Toggle it on from the Display panel.
  edlEnabled: false,
  edlStrength: 1.5,
  // Default point budget — comfortable on most laptops. The slider goes
  // higher so a powerful GPU isn't artificially capped.
  pointBudget: 4_000_000,
  activeTreeColor: '#ff47bc',
  ramp: 'forest',
  pointSize: 1,
  customRamp: ['#1a1a3a', '#e0b84a'],
  unlabeledColor: '#787878',
  extraRangeOverrides: {},
  depthCueUnassigned: true,
  depthCueStrength: 0.7,
  showLegend: true,
  heightMode: 'stored',
  heightColorAboveGround: false,
};

export interface ToolsConfig {
  selectTool: SelectTool;
  selectDepth: SelectDepth;
  activeTreeId: number;
  /** Which deadwood channel the Deadwood tool paints into. */
  deadwoodChannel: 'standing' | 'laying';
  /** Active instance id per deadwood channel (kept separate so toggling
   *  the channel remembers the id you were labelling in each). */
  activeStandingId: number;
  activeLayingId: number;
}

export const DEFAULT_TOOLS: ToolsConfig = {
  selectTool: 'lasso',
  selectDepth: 'visible',
  activeTreeId: 1,
  deadwoodChannel: 'standing',
  activeStandingId: 1,
  activeLayingId: 1,
};

/** Non-destructive visibility filters. Hidden points are rendered at
 *  zero size (and excluded from selection / picking) — nothing is
 *  deleted, so clearing the filter brings every point straight back.
 *  A point is drawn iff it passes EVERY active filter (logical AND). */
export interface FilterConfig {
  /** Hide points with tree_id ≤ 0 (unassigned / background). */
  hideUnassigned: boolean;
  /** Show ONLY this tree id; everything else is hidden. null = off. */
  isolateTreeId: number | null;
  /** While isolating, also keep unassigned (tree_id ≤ 0) points visible.
   *  Tree Review uses this so you can see + reassign stray ground /
   *  background points around the isolated tree. Ignored when not
   *  isolating. */
  isolateShowUnassigned: boolean;
  /** Keep only tree ids within [min, max] inclusive. null = off. */
  treeIdRange: [number, number] | null;
  /** Classification codes to hide (ASPRS). Empty = show every class. */
  hiddenClasses: number[];
  /** Semantic codes hidden from view: 0 = unlabelled, 1 = stem, 2 = branch.
   *  Same convention as hiddenClasses. Empty = show everything. */
  hiddenSemantic: number[];
  /** Return numbers to hide (0 = unset/unknown, 1..7 as in LAS). Empty =
   *  show every return. */
  hiddenReturns: number[];
  /** Hide points carrying a standing- / laying-deadwood instance id (> 0). */
  hideStandingDeadwood: boolean;
  hideLayingDeadwood: boolean;
  /** Show ONLY points labelled in either deadwood channel. Inert when the
   *  dataset carries no deadwood columns (otherwise it would blank the view). */
  onlyDeadwood: boolean;
  /** Keep only points whose world X (east) is within [min, max]. null =
   *  off. World/source-CRS units, matching the dataset bounding box. */
  xRange: [number, number] | null;
  /** Keep only points whose world Y (north) is within [min, max]. */
  yRange: [number, number] | null;
  /** Keep only points whose world Z (elevation) is within [min, max]. */
  zRange: [number, number] | null;
  /** Raw stored-intensity range (u16). Null = off. */
  intensityRange: [number, number] | null;
  /** Keep only points whose value in ONE numeric extra column falls in
   *  [lo, hi]. Single column at a time, so only one lazily-decoded column
   *  ever has to be hydrated for filtering. null = off. */
  extraRange: { name: string; lo: number; hi: number } | null;
  /** World (source-CRS) bbox of the isolated tree — `[min, max]`. When set
   *  (Tree Review sets it alongside isolateTreeId), the streamer FORCE-
   *  refines every node intersecting this box (dilated by isolateMargin)
   *  to full depth regardless of zoom, and exempts them from replacement-
   *  LOD, so EVERY point of the isolated tree is loaded + visible + editable
   *  at any distance. null = no forced-detail region. */
  isolateBox: [[number, number, number], [number, number, number]] | null;
  /** World anchor for the isolate neighbourhood clamp — the tree's point
   *  DENSITY centre (mean position from the tree scan). The clamped
   *  margin box + forced-detail region centre here instead of at the
   *  bbox centre, which a handful of stray points can drag tens of
   *  metres off the trunk (the "unassigned appear in the wrong place"
   *  bug). null → fall back to the bbox centre. */
  isolateAnchor: [number, number, number] | null;
  /** Margin (m) the isolateBox is dilated by — both for the forced-detail
   *  load AND for which surrounding unassigned points show while
   *  isolateShowUnassigned is on (so you can pull nearby stray points
   *  into the tree). One value for every direction, one per world axis,
   *  or one per direction [west, east, south, north, down, up]; there is
   *  no ceiling. Read through filterGeometry's marginReach, never
   *  directly. */
  isolateMargin: IsolateMargin;
  /** While isolating, also show OTHER trees' assigned points inside the
   *  same margin/Z neighbourhood — useful to see where a neighbouring
   *  crown ends so points can be moved between the two. They keep their
   *  own tree_id colours. Ignored when not isolating. */
  isolateShowOthers: boolean;
  /** WHICH other trees, when `isolateShowOthers` is on. null = every tree
   *  whose points fall in the neighbourhood box; a list = only those ids;
   *  an empty list = none of them.
   *
   *  Two crowns tangled together is the case worth looking at, and with
   *  every neighbour on at once a dense plot puts five more crowns in
   *  front of the pair you are trying to separate. Tree Review lists the
   *  neighbours by distance and this is what its picks drive. */
  isolateOtherIds: number[] | null;
  /** The isolated tree's records from the scan, tagged with the tree
   *  they belong to so a stale set cannot outlive a change of tree. The
   *  streamer refines exactly these to full depth, frustum or not: the
   *  isolateBox is clamped around the trunk, and a cluster 50 m away
   *  carrying the same id was never loaded while TreeQSM fitted to it. */
  isolateRecords: { treeId: number; records: number[] } | null;
  /** Height band (metres ABOVE THE ISOLATED TREE'S bbox base) that the
   *  nearby unassigned / other-tree points must fall inside to show.
   *  E.g. [0, 4] shows just the near-ground band around the trunk. null =
   *  the whole margin box height. Only consulted while isolating with
   *  isolateShowUnassigned / isolateShowOthers on. */
  isolateZRange: [number, number] | null;
  /** Apply `isolateZRange` to the ISOLATED TREE's own points too, not
   *  only to the neighbours — turning the band into a true horizontal
   *  slice through everything on screen.
   *
   *  Off by default, and deliberately separate from the band itself: the
   *  band's first job is to stop the canopy overhead burying the trunk
   *  you are working on, and for that the tree must stay whole. Its
   *  second job — reading a cross-section at breast height, checking
   *  whether two stems are really one — needs the tree cut as well.
   *  Only the ELEVATION bounds apply; the margin box's horizontal walls
   *  never clip the tree, or a wide crown would lose its edges. */
  isolateZBandCutsTree: boolean;
  /** Arbitrary-orientation slab filter — keep only points whose signed
   *  perpendicular distance to the plane (anchor, normal) lies in
   *  [-halfHeight, halfHeight]. Stacks with X/Y/Z range filters and
   *  the isolate/box filter; null = off. Distinct from `zRange` so
   *  the Slab panel can drag any orientation without touching the
   *  user's Filters-panel Z range. */
  planeSlab: {
    anchor: [number, number, number];
    /** Unit vector (caller normalises). */
    normal: [number, number, number];
    halfHeight: number;
  } | null;
  /** Viewpoint-based Hidden Point Removal — when set, every point's
   *  (azimuth, elevation) from the viewpoint is computed and only the
   *  closest range per angular bin is kept visible. Same depth-map
   *  the Scan-inspection panel renders the panorama from; the filter
   *  uses it as a Z-buffer for occlusion. Null = off. */
  viewpointHpr: {
    viewpoint: [number, number, number];
    /** Bin counts on the equirectangular sphere. */
    azBins: number;
    elBins: number;
    /** Closest range per bin (azBins × elBins, row-major). Empty
     *  bins hold +Infinity so the per-point lookup naturally hides
     *  points there. */
    depth: Float32Array;
    /** A point passes when |range − depthBin| ≤ tolerance. Default
     *  ~0.05 m so several points landing in the same bin all stay
     *  visible (anti-aliasing — strict <= 0 would leave only a
     *  single point per bin). */
    tolerance: number;
  } | null;
}

export const DEFAULT_FILTERS: FilterConfig = {
  hideUnassigned: false,
  isolateTreeId: null,
  isolateShowUnassigned: false,
  treeIdRange: null,
  hiddenClasses: [],
  hiddenSemantic: [],
  hiddenReturns: [],
  hideStandingDeadwood: false,
  hideLayingDeadwood: false,
  onlyDeadwood: false,
  xRange: null,
  yRange: null,
  zRange: null,
  intensityRange: null,
  extraRange: null,
  isolateBox: null,
  isolateAnchor: null,
  isolateMargin: [2, 2, 2, 2, 2, 2],
  isolateShowOthers: false,
  isolateOtherIds: null,
  isolateRecords: null,
  isolateZRange: null,
  isolateZBandCutsTree: false,
  planeSlab: null,
  viewpointHpr: null,
};

/** How many filters are currently constraining the view — drives the
 *  activity-bar dot, the panel badge and the status-bar chip. */
export function countActiveFilters(f: FilterConfig): number {
  let n = 0;
  if (f.hideUnassigned) n++;
  if (f.isolateTreeId !== null) n++;
  if (f.treeIdRange !== null) n++;
  if (f.hiddenClasses.length > 0) n++;
  if (f.hiddenSemantic.length > 0) n++;
  if (f.hiddenReturns.length > 0) n++;
  if (f.hideStandingDeadwood) n++;
  if (f.hideLayingDeadwood) n++;
  if (f.onlyDeadwood) n++;
  if (f.xRange !== null) n++;
  if (f.yRange !== null) n++;
  if (f.zRange !== null) n++;
  if (f.intensityRange !== null) n++;
  if (f.extraRange !== null) n++;
  return n;
}

export interface ViewerStats {
  loadedNodes: number;
  visibleNodes: number;
  pendingNodes: number;
  loadedPoints: number;
  visiblePoints: number;
  drawCalls: number;
  geometries: number;
  fps: number;
  /** Points passing the filters, and the total, across LOADED nodes only —
   *  the whole cloud isn't resident, so this is deliberately a
   *  loaded-set figure and the UI must label it as such. */
  filterPassPoints: number;
  filterTotalPoints: number;
  /** Low/high bounds of the ACTIVE colour mode's ramp, for the viewport
   *  legend — sourced from the exact same values colorNode() ramped this
   *  frame's points over, never a separate guess. height / x / y /
   *  extra:<name> mirror the cloud-wide span or metadata.extras (± the
   *  user's range override) colorNode was called with. intensity has no
   *  such cloud-wide span (each node normalises over its own observed
   *  min/max in refreshNodeColors), so this carries the live observed
   *  range across the currently LOADED nodes instead — same loaded-set
   *  caveat as filterPassPoints/filterTotalPoints above. null for
   *  categorical / flat modes (no numeric scale) or whenever the bound
   *  genuinely isn't known yet — the legend hides itself rather than
   *  show a guess. */
  rampLo: number | null;
  rampHi: number | null;
}

export const ZERO_STATS: ViewerStats = {
  loadedNodes: 0, visibleNodes: 0, pendingNodes: 0,
  loadedPoints: 0, visiblePoints: 0, drawCalls: 0, geometries: 0, fps: 0,
  filterPassPoints: 0, filterTotalPoints: 0,
  rampLo: null, rampHi: null,
};

/** Imperative actions the shell exposes. OctreeView populates this on
 *  mount and clears it on unmount; panels call into it directly. Null
 *  while the viewer is still booting (panels disable themselves). */
export interface OctreeShellApi {
  apply: (action: { treeId?: number; semantic?: 0 | 1 | 2 | 3; deleted?: 0 | 1 | 2; standingDeadwood?: number; layingDeadwood?: number }) => void;
  clearSelection: () => void;
  save: () => Promise<void>;
  exportLas: () => Promise<void> | void;
  undo: () => void;
  redo: () => void;
  presetView: (kind: 'top' | 'front' | 'side') => void;
  /** Frame the camera on a world-space (source-CRS) bounding box,
   *  keeping the current view direction. Used by Tree Review to fly to
   *  a tree's footprint. */
  frameBox: (min: [number, number, number], max: [number, number, number]) => void;
  /** See EditApi.isolateStatus in OctreeView: what the streamer holds of the isolated tree. */
  isolateStatus: () => import('../../three/OctreeView').IsolateStatus | null;
  /** Set the active tree_id to max(loaded) + 1. */
  newTree: () => void;

  /** How many points are currently in the selection set (across
   *  loaded nodes). Used by the Tree Review's "Split off" action to
   *  refuse to run on an empty lasso. */
  countSelected: () => number;
  /** Pick a world-space point under the given canvas-relative pixel.
   *  Returns null when nothing's there (cursor over the background).
   *  Used by the Virtual Caliper to find the stem point the forester
   *  clicked. `maxSamples` is the search budget — `120_000` matches
   *  the rotation-pivot pick used elsewhere, big enough for any
   *  realistic UI gesture. */
  pickScenePointAt: (x: number, y: number, maxSamples?: number) => [number, number, number] | null;
  /** Largest tree_id across loaded nodes + patches. Tree Review uses
   *  this to auto-pick the next free id when splitting a crown. */
  maxTreeId: () => number;
  /** Apply an edit to every currently-selected point. Returns how
   *  many patch records were written. Used by the crown-split action
   *  to assign a fresh tree_id to the lassoed subset of the
   *  isolated tree (the isolate filter restricts the selection to
   *  that tree's points, so the action is safely scoped). */
  applyToSelection: (action: {
    treeId?: number;
    semantic?: 0 | 1 | 2 | 3;
    deleted?: 0 | 1 | 2;
    standingDeadwood?: number;
    layingDeadwood?: number;
  }) => number;
  /** Select every VISIBLE unassigned (tree_id ≤ 0) point — exactly the
   *  grey points on screen, already narrowed by the active filters
   *  (isolate box, margin ring, height band …). Returns how many were
   *  added. Backs Tree Review's one-click "absorb nearby unassigned"
   *  instead of lassoing a stray ring by hand. */
  selectVisibleUnassigned: () => number;

  /** Merge every `fromIds` tree into `toId` (persists treemap.json and
   *  re-folds the view). */
  mergeTrees: (fromIds: number[], toId: number) => Promise<void>;
  /** Un-merge one source id. */
  unmergeTree: (fromId: number) => Promise<void>;
  /** Drop every merge. */
  clearMerges: () => Promise<void>;
  /** Current merges as raw [from, to] pairs. */
  getMerges: () => [number, number][];
  /** Classify ground points (Progressive Morphological Filter) over the
   *  whole cloud, writing class 2 back to octree.bin, then reload nodes.
   *  Returns the ground-point count. */
  classifyGround: (params: GroundParams) => Promise<number>;
  /** Reset classifications in place + reload. fromClass < 0 → every
   *  point; else only that class. Each match becomes toClass. Returns
   *  the number of points changed. */
  resetClassification: (fromClass: number, toClass: number) => Promise<number>;
  /** Reset a whole column back to 0 — zeroes the baked octree.bin values
   *  (tree_id / semantic / either deadwood channel) and clears the
   *  matching patch overrides, then reloads. Returns points changed. */
  resetAttribute: (attr: 'tree_id' | 'semantic' | 'standing_deadwood' | 'laying_deadwood') => Promise<number>;
  /** Largest deadwood instance id currently loaded for a channel — backs
   *  the Deadwood tool's "New" button. */
  maxDeadwoodId: (channel: 'standing' | 'laying') => number;
  /** Auto-segment tree crowns from the CHM (treetop maxima + watershed),
   *  writing fresh tree_ids into octree.bin and clearing any tree_id patch
   *  overrides, then reload. Returns the tree count + points assigned. */
  segmentChm: (params: SegmentParams) => Promise<{ treeCount: number; assignedPoints: number }>;
  /** treeiso individual-tree isolation (bottom-up cut-pursuit cascade) →
   *  tree_id; overwrites tree_id + clears its patch overrides, then reloads. */
  treeIsolation: (params: TreeIsoParams) => Promise<{ treeCount: number; assignedPoints: number }>;
  segmentLi2012: (params: Li2012Params) => Promise<{ treeCount: number; assignedPoints: number }>;
  /** M3C2 change detection against a reference-epoch dataset. Read-only
   *  analysis — returns the change map + summary stats, writes nothing. */
  m3c2: (referenceDir: string, params: M3C2Params) => Promise<M3C2Result>;
  /** Stem-taper profile at a clicked stem (3DFin-style). Read-only —
   *  returns the section-by-section diameter profile + stem volume;
   *  writes nothing into the cloud. */
  stemTaper: (clickX: number, clickY: number, clickZ: number, params: StemTaperParams) => Promise<StemTaperResult>;
  /** Auto-detect laying deadwood (near-ground PCA + DBSCAN), writing a
   *  seed segmentation into the laying_deadwood column (overwrites it) and
   *  clearing laying_deadwood patch overrides, then reload. Returns the log
   *  count + points assigned. The user refines / adds logs by hand after. */
  segmentDeadwood: (params: DeadwoodParams) => Promise<{ logCount: number; assignedPoints: number }>;
  /** Geometric leaf–wood separation (LeWoS-style PCA eigenfeatures + smoothing)
   *  writing the semantic byte (1 = wood, 2 = leaf, 0 = ground); overwrites
   *  semantic + clears its patch overrides, then reloads. Returns wood/leaf
   *  point counts. Pure geometry — no ML / GPU / network. */
  leafWood: (params: LeafWoodParams) => Promise<{ woodPoints: number; leafPoints: number }>;
  /** Tree Skeleton Transfer (Honkanen et al. 2026,
   *  doi:10.1016/j.ophoto.2026.100147) — propagate
   *  the BASELINE octree's per-point tree_id + semantic labels onto
   *  the active (target) cloud. Backend rewrites tree_id + semantic
   *  in target/octree.bin; this wrapper clears both patch columns,
   *  saves, and reloads, matching the same dance the CHM segmenter
   *  does. */
  /** Propagate tree_id + semantic from `baselineDir`'s skeletons onto
   *  `targetDir`. The target need not be the open dataset — one that is
   *  not picks up its new labels the next time it is opened. */
  skeletonTransfer: (baselineDir: string, targetDir: string, params: SkeletonTransferParams) => Promise<SkeletonTransferResult>;
  /** Cheap heuristic: does the cloud already carry tree_id data (any
   *  loaded point with tree_id > 0)? Used to warn before a destructive
   *  re-segmentation overwrites an imported tree_id column. */
  hasTreeIds: () => boolean;
}

/** Parameters for CHM-based auto-segmentation (individual-tree-crown
 *  delineation). The search window scales with tree height so big crowns
 *  aren't split: radius(m) = base + perM·height, clamped to [base, max]. */
export interface SegmentParams {
  cellSize: number;
  /** CHM smoothing radius in cells (box blur). 0 = none. */
  smooth: number;
  /** Minimum treetop height above ground (m). */
  minHeight: number;
  crownBaseRadius: number;
  crownRadiusPerM: number;
  crownMaxRadius: number;
}

export const DEFAULT_SEGMENT_PARAMS: SegmentParams = {
  cellSize: 0.5,
  smooth: 1,
  minHeight: 2.0,
  crownBaseRadius: 1.5,
  crownRadiusPerM: 0.05,
  crownMaxRadius: 5.0,
};

/** treeiso (Xi & Hopkinson 2022) tree-isolation parameters — the names and
 *  defaults are the authors' own (`truebelief/artemis_treeiso`). The
 *  non-ground cloud is voxel-decimated to `voxelSize`; stage 1 cuts it into
 *  superpoints (K1/λ1), stage 2 re-decimates each of those to `decimate2`
 *  and cuts the result horizontally (K2/λ2) with edges gated by `maxGap`,
 *  and stage 3 iteratively merges the crown fragments stage 2 leaves behind
 *  (K3/ρ/w). Writes tree_id — a bottom-up alternative to the CHM watershed
 *  for dense TLS/MLS. */
export interface TreeIsoParams {
  /** Voxel edge (m) the cloud is decimated to before cut-pursuit. The
   *  reference decimates to 0.05 m for stage 1; finer is slower but keeps
   *  a superpoint from bridging two interlocking crowns, which is where
   *  the algorithm stops being able to separate them. */
  voxelSize: number;
  /** K1 — k for the stage-1 3D k-NN graph. */
  k1: number;
  /** λ1 — stage-1 cut-pursuit regularisation (small → fine superpoints). */
  lambda1: number;
  /** K2 — k for both stage-2 searches (cluster centroids, and nodes). */
  k2: number;
  /** λ2 — stage-2 cut-pursuit regularisation (larger → stem-length
   *  segments). */
  lambda2: number;
  /** PR_DECIMATE_RES2 — resolution (m) each superpoint is re-decimated to
   *  in order to make the stage-2 graph nodes. */
  decimate2: number;
  /** PR_MAX_GAP — the largest point gap (m) taken to be occlusion WITHIN
   *  one tree. Two superpoints further apart than this get no stage-2
   *  edge, so they can never end up in one segment. Not a merge radius. */
  maxGap: number;
  /** K3 — k for the stage-3 segment-neighbourhood searches. */
  k3: number;
  /** ρ — a segment whose base sits this many of its own lengths above the
   *  lowest of its K3 neighbours is a crown fragment, not a stem. */
  rho: number;
  /** w — how much vertical overlap counts against horizontal overlap when
   *  choosing which segment to merge a fragment into. */
  verticalWeight: number;
  /** Ours, not the reference's: drop segments with fewer than this many
   *  working (voxel) points, before the stage-3 merge as well as after,
   *  so noise is left unassigned rather than glued onto a real tree. */
  minTreePts: number;
}

/** Li et al. 2012 tree segmentation. The non-ground cloud is
 *  voxel-decimated, then points are walked in descending height and each
 *  grown into whichever tree it is nearest — no canopy raster anywhere,
 *  so a suppressed stem with no local maximum can still be found.
 *
 *  The third detector on purpose: it fails differently from the CHM
 *  watershed and from treeiso, which is what makes comparing their
 *  accuracies mean anything. */
export interface Li2012Params {
  /** Voxel edge (m) the cloud is decimated to. Related to the spacing
   *  thresholds below: a voxel larger than dt2 leaves neighbours further
   *  apart than the threshold allows, and every point becomes its own
   *  tree. */
  voxelSize: number;
  /** dt1 — spacing threshold (m) for points at or BELOW `zu`. The
   *  paper's 1.5 m. */
  dt1: number;
  /** dt2 — spacing threshold (m) for points ABOVE `zu`. Larger (2 m in
   *  the paper), because crown width scales with tree height and the
   *  trees up there are the big ones. */
  dt2: number;
  /** Zu — height above ground (m) separating the two thresholds. */
  zu: number;
  /** R — the window (m; a DIAMETER, so the radius is half of it) a point
   *  must be the highest within to count as a possible treetop, and so
   *  to be held to the dt limit at all. 0 treats every point as one. */
  searchWindow: number;
  /** Points below this height above ground are understorey, not crown. */
  minHeight: number;
  /** Drop clusters smaller than this many working (voxel) points. */
  minTreePts: number;
  /** DTM cell size (m) — the height above ground the thresholds read. */
  dtmCell: number;
}

/** The paper's own values for a mixed-conifer plot (dt1 1.5, dt2 2,
 *  Zu 15, R 2, hmin 2), plus the two that are ours: the decimation the
 *  working set is built at, and the minimum cluster size. */
export const DEFAULT_LI2012_PARAMS: Li2012Params = {
  voxelSize: 0.5,
  dt1: 1.5,
  dt2: 2.0,
  zu: 15.0,
  searchWindow: 2.0,
  minHeight: 2.0,
  minTreePts: 30,
  dtmCell: 0.5,
};

/** The reference implementation's own defaults, unchanged, except
 *  `voxelSize` (0.1 rather than its 0.05, to keep a whole plot inside the
 *  working-set cap) and `minTreePts`, which it does not have. */
export const DEFAULT_TREEISO_PARAMS: TreeIsoParams = {
  voxelSize: 0.1,
  k1: 5,
  lambda1: 1.0,
  k2: 20,
  lambda2: 20.0,
  decimate2: 0.1,
  maxGap: 2.0,
  k3: 20,
  rho: 0.5,
  verticalWeight: 0.5,
  minTreePts: 20,
};

/** M3C2 (Lague et al. 2013) change-detection parameters. Both epochs are
 *  voxel-decimated to `voxelSize`; at each core point a PCA normal is fit
 *  over `normalScale`, then both clouds are projected onto it inside a
 *  cylinder of `projectionScale` diameter / `maxDepth` half-length. */
export interface M3C2Params {
  voxelSize: number;
  normalScale: number;
  projectionScale: number;
  maxDepth: number;
  /** Registration error (m) folded into the level of detection. */
  regError: number;
  /** Spacing (m) of the core points the distance is evaluated at —
   *  Lague et al.'s subsample. Coarser than the decimation voxel, or the
   *  decimated cloud itself is the core. */
  coreSpacing: number;
}

export const DEFAULT_M3C2_PARAMS: M3C2Params = {
  voxelSize: 0.1,
  normalScale: 1.0,
  projectionScale: 0.5,
  maxDepth: 3.0,
  regError: 0.02,
  coreSpacing: 0.5,
};

/** Result of an M3C2 run — summary stats + per-core-point arrays (the
 *  arrays drive the panel's distribution chart today; a 3-D change overlay
 *  can consume them later). Positive distance = the compared/active cloud
 *  sits above the reference (upward growth). */
export interface M3C2Result {
  coreCount: number;
  definedCount: number;
  significantCount: number;
  meanDistance: number;
  medianDistance: number;
  stdDistance: number;
  /** 3 × coreCount, relative to the compared octree offset. */
  xyz: number[];
  /** coreCount; NaN where undefined. */
  distance: number[];
  /** coreCount; 1 where the change exceeded the level of detection. */
  significant: number[];
  /** The run was stopped between chunks; the core points above are the
   *  ones finished before that. */
  stopped: boolean;
}

/** A 3-D change overlay built from an {@link M3C2Result} — the core points
 *  drawn as a colored THREE.Points cloud over the active dataset so the
 *  forester can see *where* growth / loss happened, not just the histogram.
 *  Coordinates are already relative to the ACTIVE octree offset (the M3C2
 *  command returns them that way), so OctreeView applies only the scene
 *  swap-and-negate, not the offset subtraction. Diverging ramp: blue = loss
 *  (below reference), red = growth (above), dim grey = within-noise /
 *  undefined. Survives panel re-opens until cleared. */
export interface M3C2Overlay {
  /** 3 × point count, relative to the active octree offset. */
  xyz: Float32Array;
  /** point count; NaN where the distance is undefined. */
  distance: Float32Array;
  /** point count; 1 where change exceeded the level of detection. */
  significant: Uint8Array;
  /** Colour-ramp half-range (m). |distance| ≥ maxAbs saturates. */
  maxAbs: number;
}

/** Stem-taper (3DFin-style) parameters. The forester clicks a stem; the
 *  backend fits a circle every `sectionHeight` from `stumpHeight` upward,
 *  tracking the stem centre, and returns the diameter profile + volume.
 *  All distances in metres. */
export interface StemTaperParams {
  /** Horizontal search radius around the click (m). */
  cylinderRadius: number;
  /** Spacing between taper sections (m). */
  sectionHeight: number;
  /** Half-thickness of each section's fit slab (m). */
  slabHalfHeight: number;
  /** Where the taper starts above ground (m). */
  stumpHeight: number;
  /** DTM cell size for the ground sample (m). */
  dtmCell: number;
}

export const DEFAULT_STEM_TAPER_PARAMS: StemTaperParams = {
  cylinderRadius: 1.0,
  sectionHeight: 0.30,
  slabHalfHeight: 0.05,
  stumpHeight: 0.10,
  dtmCell: 0.50,
};

/** One fitted section of a stem-taper profile (proximal → distal). */
export interface TaperSection {
  /** Height above ground for the section mid-Z (m). */
  hag: number;
  /** World Z at the section mid-height (m). */
  z: number;
  /** Fitted diameter (m). */
  diameter: number;
  /** Fitted circle centre, world XY. */
  centerX: number;
  centerY: number;
  /** Radial RMSE of the fit (m). */
  rmse: number;
  /** 12-sector angular coverage (0..1). */
  coverage: number;
  /** Points that survived MAD rejection and drove the fit. */
  n: number;
}

/** Result of a stem-taper run — the diameter profile plus derived
 *  volume + DBH. Log bucking is computed in the panel from `sections`
 *  so assortment specs can be retuned without a re-run. */
export interface StemTaperResult {
  /** DTM-sampled ground elevation at the click (m). */
  baseZ: number;
  /** Tree height (m). */
  height: number;
  /** Diameter at breast height (m), interpolated from the profile. */
  dbh: number;
  /** Stem volume (m³), truncated-cone integral over the sections. */
  stemVolume: number;
  sections: TaperSection[];
  pointCount: number;
}

/** Parameters for automatic laying-deadwood detection (classic geometry
 *  pipeline: near-ground height band → per-point PCA keeping linear,
 *  near-horizontal points → DBSCAN clustering → length filter). All
 *  distances in metres. The result is a seed the user edits by hand. */
export interface DeadwoodParams {
  /** DTM cell size for the bare-earth surface the height band is over. */
  cellSize: number;
  /** Height band above ground a candidate point must fall in. */
  hagMin: number;
  hagMax: number;
  /** PCA neighbourhood radius — must exceed the trunk diameter so the
   *  neighbourhood spans along the log axis (else it sees only the
   *  locally-planar cylinder surface and linearity collapses). */
  neighborRadius: number;
  /** Minimum linearity (λ1−λ2)/λ1 for a log point. */
  minLinearity: number;
  /** Max |z-component| of the principal axis — keeps near-horizontal logs,
   *  rejects vertical standing stems. */
  maxAxisVerticality: number;
  /** DBSCAN neighbour distance. */
  clusterEps: number;
  /** Minimum points for a cluster to survive as a log. */
  minClusterPoints: number;
  /** Minimum log length (PCA-axis projected extent). */
  minLogLength: number;
}

export const DEFAULT_DEADWOOD_PARAMS: DeadwoodParams = {
  cellSize: 0.5,
  hagMin: 0.05,
  hagMax: 1.5,
  neighborRadius: 0.4,
  minLinearity: 0.6,
  maxAxisVerticality: 0.4,
  clusterEps: 0.3,
  minClusterPoints: 20,
  minLogLength: 0.6,
};

/** Geometric leaf–wood separation parameters. Per non-ground point, PCA over
 *  `searchRadius` yields eigenvalues λ0≥λ1≥λ2; WOOD is locally linear (branch)
 *  or planar (trunk), LEAF is scattered (foliage). Written to the semantic
 *  byte (1 = wood, 2 = leaf). */
export interface LeafWoodParams {
  /** PCA neighbourhood radius (m) — branch/twig scale. */
  searchRadius: number;
  /** Minimum neighbours for a stable PCA; below this a point is called leaf. */
  minNeighbors: number;
  /** Wood if linearity (λ0−λ1)/λ0 ≥ this (branches). */
  linearityMin: number;
  /** …or planarity (λ1−λ2)/λ0 ≥ this (trunk surface). */
  planarityMin: number;
  /** …and scatter λ2/λ0 ≤ this (rejects scattered foliage). */
  scatterMax: number;
  /** Majority-vote smoothing passes over the neighbourhood. */
  smoothPasses: number;
}

export const DEFAULT_LEAFWOOD_PARAMS: LeafWoodParams = {
  searchRadius: 0.06,
  minNeighbors: 8,
  linearityMin: 0.6,
  planarityMin: 0.55,
  scatterMax: 0.35,
  smoothPasses: 2,
};

/** Parameters for the Progressive Morphological Filter ground classifier.
 *  All distances in metres.
 *
 *  These used to be described as identical to the in-memory editor's
 *  groundClassify options "so both paths behave the same". That file no
 *  longer exists — the Rust classifier is the only one — so there is no
 *  second path to agree with, and nothing to check the wording against
 *  if it drifts. */
export interface GroundParams {
  /** Bare-earth filter: 'pmf' (Progressive Morphological Filter, Zhang
   *  2003) or 'csf' (Cloth Simulation Filter, Zhang 2016). */
  method: 'pmf' | 'csf';
  cellSize: number;
  tolerance: number;
  slope: number;
  initialThreshold: number;
  maxThreshold: number;
  maxWindowM: number;
  /** CSF cloth rigidity (1 soft / steep … 4 stiff / flat). PMF ignores it. */
  rigidity: number;
}

export const DEFAULT_GROUND_PARAMS: GroundParams = {
  method: 'pmf',
  cellSize: 0.5,
  tolerance: 0.2,
  slope: 0.2,
  initialThreshold: 0.3,
  maxThreshold: 2.5,
  maxWindowM: 20,
  rigidity: 2,
};

// --- Report hand-off summaries -------------------------------------------
//
// Stem taper, tree growth and M3C2 are computed on demand and, unlike
// TreeMetric / QsmResult / DensityMetricsResult, never persisted to disk —
// they live only in their panel's local state. Field validation has the
// same shape of problem: ValidationPanel computes real stats but nothing
// ever wrote them anywhere the Report panel could read. Each producing
// panel drops its finished, already-computed summary into one of the slots
// below on a successful run; the Report panel only ever reads what's here,
// so it can never disagree with the panel that computed it. Slots survive
// their panel closing (the report is often opened afterwards) and are
// reset when the active dataset changes (see the octreeDir effect in
// EditorShell) so a summary from the previous cloud is never reported for
// the new one.

/** Field-data validation summary — hand-off for the Report panel.
 *  ValidationPanel owns writing it, from the DBH-metric stats it already
 *  computes for its own stat card + scatter plot. */
export interface ValidationSummary {
  nMatched: number;
  biasCm: number;
  rmseCm: number;
  r2: number;
}

/** Per-tree growth summary — hand-off for the Report panel. TreeGrowthPanel
 *  owns writing it, from the numbers it already shows after a compute. */
export interface GrowthSummary {
  years: number;
  nMatched: number;
  meanDbhGrowthCmPerYear: number;
  meanHeightGrowthMPerYear: number;
  volumeChangeM3: number;
  harvested: number;
  ingrowth: number;
}

/** M3C2 change-detection summary — hand-off for the Report panel. M3C2Panel
 *  owns writing it, from the result of a successful run. */
export interface M3C2Summary {
  referenceName: string;
  corePoints: number;
  significantPct: number;
  meanChangeCm: number;
  medianChangeCm: number;
}

/** One measured stem from the Stem Taper panel — hand-off for the Report
 *  panel. StemTaperPanel owns writing it; the panel keeps a single
 *  measurement at a time today, so it contributes a one-entry array. */
export interface TaperMeasurement {
  label: string;
  dbhCm: number;
  heightM: number;
  stemVolumeM3: number;
  sawlogM3: number;
  pulpwoodM3: number;
}

export type PanelId = 'tools' | 'display' | 'filters' | 'review' | 'ground' | 'history' | 'layers' | 'subset' | 'segment' | 'keys' | 'qc' | 'pointqc' | 'rescan' | 'validation' | 'bucking' | 'thinning' | 'density' | 'report' | 'caliper' | 'slab' | 'scaninspect' | 'plotbound' | 'treehandle' | 'centerline' | 'tst' | 'm3c2' | 'taper' | 'growth' | 'crosssensor' | 'register';

export interface OctreeShellState {
  /** Currently visible floating panels. The activity bar toggles these. */
  visiblePanels: Set<PanelId>;
  togglePanel: (id: PanelId) => void;

  /** Editing on/off. When false a left-drag in the viewport orbits the
   *  camera (middle button pans, wheel zooms). When true
   *  a left-drag draws the active selection shape; Shift+drag still
   *  orbits so the camera is always reachable. Space toggles this. */
  editMode: boolean;
  setEditMode: (b: boolean) => void;

  /** Measure tool. When on, a click in the viewport snaps to the nearest
   *  visible point; two clicks define a measured segment (3D distance +
   *  horizontal + vertical). A drag still orbits; Esc clears. Selection
   *  is suspended while measuring. */
  measuring: boolean;
  setMeasuring: (b: boolean) => void;

  display: DisplayConfig;
  setDisplay: (patch: Partial<DisplayConfig>) => void;

  tools: ToolsConfig;
  setTools: (patch: Partial<ToolsConfig>) => void;

  filters: FilterConfig;
  setFilters: (patch: Partial<FilterConfig>) => void;

  /** Raster scene objects (DTM / DSM / CHM) shown in 3D + toggled from
   *  the Layers panel. */
  rasterLayers: RasterLayer[];
  setRasterLayers: (next: RasterLayer[] | ((prev: RasterLayer[]) => RasterLayer[])) => void;
  /** Point-cloud visibility — the Layers panel can hide it to inspect a
   *  raster surface on its own. */
  cloudVisible: boolean;
  setCloudVisible: (b: boolean) => void;

  /** Live subset-preview clip — world (source-CRS) X/Y/Z ranges the Subset
   *  panel writes while you drag its sliders, so the viewport clips the
   *  cloud to the box you're about to extract (a "wall" you can see the
   *  result size against). Null / all-null = no preview. Non-destructive,
   *  separate from the user's actual Filters; cleared when the Subset panel
   *  closes. */
  subsetPreview: { xRange: [number, number] | null; yRange: [number, number] | null; zRange: [number, number] | null } | null;
  setSubsetPreview: (p: OctreeShellState['subsetPreview']) => void;

  /** Active world-coordinate picker — when a panel is in "click a
   *  stem" mode (Virtual Caliper, etc.) it registers a handler here
   *  and the viewport routes the next left-click's world XYZ to it
   *  instead of running its normal tool action. Cleared after one
   *  pick or when the panel cancels. */
  worldPicker: ((hit: [number, number, number]) => void) | null;
  setWorldPicker: (cb: ((hit: [number, number, number]) => void) | null) => void;
  /** Plot boundary — a property of the DATASET, not this UI session.
   *  Persisted to plot.json next to the dataset (PlotBoundaryPanel
   *  writes it on apply/clear/auto-fit; EditorShell's octreeDir-keyed
   *  effect loads it whenever the active dataset changes) so every
   *  consumer computes the same PROPER per-hectare statistics (with
   *  edge correction) instead of each guessing its own tree-bbox
   *  approximation. This panel, Report and Thinning read it from here;
   *  InventoryModule (outside the shell) reads the same file through
   *  the bridge directly. Null = no boundary defined, panels fall back
   *  to their own auto-bbox area. */
  plotBoundary: PlotBoundary | null;
  setPlotBoundary: (b: PlotBoundary | null) => void;

  /** THE ANALYSIS LAYERS — everything a tool has drawn over the cloud,
   *  as one list the user owns: shown or hidden, saved with the dataset
   *  or not, removable. The three overlays below are DERIVED from it
   *  (see layers/analysisLayers.ts, deriveOverlays) and read-only; a
   *  panel that has drawn something adds a layer and refers to it by
   *  id. The Layers panel lists them all. */
  analysisLayers: AnalysisLayer[];
  /** Add a layer, or replace the one with the same id. Visible unless
   *  told otherwise. Returns the id. */
  addAnalysisLayer: (input: {
    id?: string; kind: LayerKind; label: string; source: string; payload: LayerPayload;
    visible?: boolean; savable?: boolean;
  }) => string;
  /** Show or hide. Showing a saved layer that has not been read yet
   *  reads it first. */
  setAnalysisLayerVisible: (id: string, visible: boolean) => Promise<void>;
  /** Take it off the list. With `deleteFile`, its files go too. */
  removeAnalysisLayer: (id: string, opts?: { deleteFile?: boolean }) => Promise<void>;
  /** Write it under the dataset's `layers/` folder. */
  saveAnalysisLayer: (id: string) => Promise<void>;
  /** Write one of the raster layers the same way; it then carries its
   *  layer id in `savedAs` and comes back, hidden, on the next open. */
  saveRasterLayer: (rasterId: string) => Promise<void>;
  /** Layers can be saved: the desktop build with the layer commands. */
  canPersistLayers: boolean;

  /** Stem centreline polylines — every visible `centerlines` layer
   *  merged: the plot's centrelines, a taper profile and the
   *  click-to-measure handles are the same kind of thing and belong on
   *  screen together. Coordinates are in world / source CRS —
   *  OctreeView applies the scene swap-and-negate. Null = none. */
  stemCenterlines: StemCenterlineOverlay | null;
  /** Per-cylinder skeleton sample points, drawn as small colored dots —
   *  the visible `skeleton` layer, which the Skeleton Transfer panel
   *  sets and clears through this adapter; its file is skeletons.bin,
   *  not a layer file. */
  skeletonOverlay: SkeletonOverlay | null;
  setSkeletonOverlay: (o: SkeletonOverlay | null) => void;
  /** Per-core-point M3C2 change overlay — the most recently added
   *  visible `m3c2` layer. Null = none shown. */
  m3c2Overlay: M3C2Overlay | null;

  /** The Compare view: the source and the target of a skeleton transfer
   *  side by side under one camera, in place of the viewport while set.
   *  The Skeleton Transfer panel's step 4 opens and closes it. Read-only
   *  for both clouds. */
  compare: CompareRequest | null;
  setCompare: (c: CompareRequest | null | ((prev: CompareRequest | null) => CompareRequest | null)) => void;
  /** CompareView's surface — the pose, the export — null while closed. */
  compareApi: CompareApi | null;
  setCompareApi: (api: CompareApi | null) => void;

  /** Field-data validation summary — hand-off for the Report panel.
   *  Owned by ValidationPanel; see {@link ValidationSummary}. */
  validationSummary: ValidationSummary | null;
  setValidationSummary: (s: ValidationSummary | null) => void;
  /** Tree-growth summary — hand-off for the Report panel. Owned by
   *  TreeGrowthPanel; see {@link GrowthSummary}. */
  growthSummary: GrowthSummary | null;
  setGrowthSummary: (s: GrowthSummary | null) => void;
  /** M3C2 change-detection summary — hand-off for the Report panel.
   *  Owned by M3C2Panel; see {@link M3C2Summary}. */
  m3c2Summary: M3C2Summary | null;
  setM3c2Summary: (s: M3C2Summary | null) => void;
  /** Measured stems from the Stem Taper panel — hand-off for the Report
   *  panel. Owned by StemTaperPanel; see {@link TaperMeasurement}. */
  taperMeasurements: TaperMeasurement[] | null;
  setTaperMeasurements: (m: TaperMeasurement[] | null) => void;

  /** Additional clouds rendered alongside the primary one (overlays). */
  secondaryClouds: SecondaryCloud[];
  /** Add a saved octree (by its on-disk dir) to the scene as an overlay.
   *  No-op if it's the primary cloud or already in the overlay list. */
  addSecondary: (dir: string, label: string) => Promise<void>;
  removeSecondary: (id: string) => void;
  toggleSecondary: (id: string) => void;
  /** Change an overlay's tint, colour mode, or filter-sync in place. */
  updateSecondary: (id: string, patch: Partial<Pick<SecondaryCloud, 'color' | 'colorMode' | 'syncFilters'>>) => void;

  /** Live counts pushed up by OctreeView. */
  selectedCount: number;
  dirty: boolean;
  stats: ViewerStats;

  /** Live save status, surfaced in HistoryPanel + the shell status bar so
   *  the user can SEE when patches.bin has been written.
   *
   *  - 'idle'   – clean, nothing to do
   *  - 'saving' – write in flight
   *  - 'saved'  – last write succeeded (lastSavedAt is set)
   *  - 'error'  – last write failed (saveError carries the message). The
   *               user MUST see this — silently swallowed save errors are
   *               what cost the user dozens of trees' worth of editing
   *               on an earlier build. */
  saveStatus: 'idle' | 'saving' | 'saved' | 'error';
  /** Epoch ms of the last successful save, or null. Drives the
   *  "Saved · HH:MM:SS" label on the Save button. */
  lastSavedAt: number | null;
  /** Human message from the last failed save, surfaced in red on the
   *  Save button + on the shell banner. */
  saveError: string | null;
  /** Opt-in background flush of dirty edits (2 min) — the crash-loss
   *  backstop. OFF by default: an autosave also removes "close without
   *  saving" as an escape hatch, so the user opts in from the History
   *  panel. Persisted via 'tree-seg-autosave' (settings.json mirror). */
  autosaveEnabled: boolean;
  setAutosaveEnabled: (v: boolean) => void;

  /** Currently-open dataset. Null when the user hasn't opened one yet. */
  octree: OpenOctree | null;
  /** Every dataset in the project (incl. the currently-open one). The
   *  Skeleton Transfer panel uses this to pick a baseline; other
   *  panels can list the project's clouds without prop-drilling. */
  octreeList: OctreeListEntry[];

  /** Re-scan the project's octrees so a newly created dataset (e.g. from
   *  the Subset tool) appears in the Layers panel's dataset list. Provided
   *  by the host module; no-op when absent. */
  refreshDatasets?: () => void | Promise<void>;

  /** Re-open the active octree from disk (its metadata + node layout
   *  changed on disk — e.g. after adding / removing an extra column, which
   *  rewrites octree.bin at a new stride). The viewer remounts with the
   *  fresh metadata. Provided by the host; no-op when absent. */
  reloadActiveOctree?: () => void | Promise<void>;

  /** Imperative action API — null until OctreeView mounts. */
  api: OctreeShellApi | null;

  /** Command palette open state. */
  paletteOpen: boolean;
  setPaletteOpen: (b: boolean) => void;

  /** True while a native command is rewriting the active dataset on disk
   *  (bake, ground classification, segmentation, normalise, a column
   *  add/remove, the intensity backfill…).
   *
   *  Editing MUST be blocked while it is set, and blocked rather than
   *  merely warned about. Those commands finish by re-opening the
   *  dataset to pick up the schema change, and the re-open reloads
   *  patches.bin from disk over the in-memory store and clears undo — so
   *  an edit made during the operation's window is destroyed, silently,
   *  while the indicator reads "Saved". Warning afterwards is too late,
   *  and re-saving the in-memory store after a bake would be worse still:
   *  it would re-apply records the bake had already burned into
   *  octree.bin. */
  /** Why the last "+ scene" overlay add failed, if it did. A console
   *  warning is invisible: the button looks unchanged and nothing
   *  appears, so a missing folder reads as a mis-click. */
  overlayError: string | null;
  clearOverlayError: () => void;

  datasetBusy: boolean;
  /** Run `fn` with `datasetBusy` held. Always releases, including on
   *  throw — a stuck flag would lock editing for the rest of the session,
   *  which is its own bug. Nests safely (it is a counter underneath), so
   *  two operations overlapping cannot release each other's hold. */
  withDatasetBusy: <T>(fn: () => Promise<T>) => Promise<T>;
}

const Ctx = createContext<OctreeShellState | null>(null);

export const OctreeShellContext = Ctx;

export function useOctreeShell(): OctreeShellState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOctreeShell must be used inside <OctreeShellContext.Provider>');
  return v;
}
