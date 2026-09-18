// Stage 2 + Stage 3 viewer for PointCloudLabeler octree datasets.
//
// Owns its own R3F Canvas + orbit camera. Streams node blocks based
// on a camera-aware LOD plan (frustum cull + screen-space error),
// applies any edits stored in <octreeDir>/patches.bin before pushing
// nodes to the GPU, and offers box-selection + tree_id / semantic /
// hide editing on top of the streamed point cloud. Edits live in the
// in-memory PatchStore and get flushed back to patches.bin on save.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sceneToWorld } from '../io/sceneAxes';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import {
  readNodePoints,
  readExtraColumn,
  readNodeSelectData,
  STANDING_DEADWOOD_EXTRA,
  LAYING_DEADWOOD_EXTRA,
  NO_RECORD,
  type OpenOctree,
  type RasterLayer,
} from '../persistence/octreeReader';
import RasterLayers from './RasterLayers';
import OverlayCloud from './OverlayCloud';
import type { SecondaryCloud } from '../components/shell/OctreeShellContext';
import {
  applyToNode,
  loadPatches,
  nodeKey as patchNodeKey,
  PatchStore,
  savePatches,
  type NodeKey as PatchNodeKey,
  type PatchEdit,
} from '../persistence/octreePatches';
import EdlPass from './EdlPass';
import { viewportBackground } from '../ui/theme';
import { useViewportBackground } from '../ui/useTheme';
import { type TerrainDisplay, emptyTerrainTexture } from './terrain';
import { useHeightDisplay } from './useTerrain';
import type { ZAdjust } from './skeletonAlign';
import { pointInPolygon, flattenRemap, applyRemapInPlace } from './selectionMath';
import { onOctreeProgress } from '../persistence/octreeStore';
import { describeRendererMemory, readPerformanceMemory, type RendererMemoryInfo } from '../persistence/rendererMemory';
import { rememberReopen } from '../persistence/reopenAfterReload';
import {
  eastRangeToScene, northRangeToScene, upRangeToScene,
  slabToScene, isolateBoxToScene, inSlab, inBox, viewDepthSpan,
} from './filterGeometry';
import { forcedRecordSet } from './forcedRecords';

/** See EditApi.isolateStatus. */
export interface IsolateStatus {
  treeId: number;
  /** Records the scan listed for the tree; null when the scan predates
   *  the field or the list belongs to another tree. */
  scanRecords: number | null;
  /** Records the planner forces to full depth, ancestors included. */
  forced: number;
  /** Of those, resident on the GPU, and still on their way. */
  loaded: number;
  pending: number;
  /** Points carrying the isolated id across every resident node, and
   *  how many of them the filter lets through to be drawn. */
  residentPoints: number;
  drawnPoints: number;
}
import { f32ToI32, quantisePositions } from './quantise';
import {
  MaxHeap, MIN_NODE_PIXEL_SIZE, NOT_VISIBLE, projFactor as projFactorFor,
  sourceCentreToScene, pixelDiameter, admits, refines, selectEvictions,
  meetsPixelThreshold, releasePoints,
  detailBoxWorld, bboxOverlapsDetail, EVICT_LIMIT_FACTOR,
} from './lodPlanner';
import {
  rampColor, setCustomRampStops, classColor, treeIdColor, deadwoodColor, hexToRgb255, UNASSIGNED_RGB,
} from './palette';
import { AxisGizmoUpdater, AxisGizmoOverlay, type GizmoDirs } from './AxisGizmo';
import type {
  ColorMode, ColorRamp, DisplayConfig, ToolsConfig, FilterConfig, GroundParams, SegmentParams, DeadwoodParams,
  ViewerStats, OctreeShellApi, SkeletonTransferParams, SkeletonTransferResult,
  LeafWoodParams, TreeIsoParams, Li2012Params, M3C2Params, M3C2Result,
  StemTaperParams, StemTaperResult,
} from '../components/shell/OctreeShellContext';

/** Live subset-preview clip box (world X/Y/Z ranges), shared with the
 *  streamer so freshly-loaded nodes get clipped the same as resident ones. */
type SubsetPreview = { xRange: [number, number] | null; yRange: [number, number] | null; zRange: [number, number] | null };

interface Props {
  octree: OpenOctree;
  /** Display config, owned by the shell (DisplayPanel drives it). */
  display: DisplayConfig;
  /** Tool config (selection tool / depth / active tree id), owned by
   *  the shell (ToolsPanel drives it). */
  tools: ToolsConfig;
  /** Visibility filters (non-destructive). Owned by the shell
   *  (FiltersPanel drives it). The viewer rebuilds per-node
   *  `aVisible` buffers when this changes. */
  filters: FilterConfig;
  /** Live subset-preview clip (world X/Y/Z ranges) — clips the cloud to
   *  the box the Subset panel is dragging out, on top of the filters.
   *  Null = no preview. */
  subsetPreview?: { xRange: [number, number] | null; yRange: [number, number] | null; zRange: [number, number] | null } | null;
  /** When set, the next click (mouse-down + mouse-up within a 5 px
   *  threshold = no drag) routes its picked world XYZ here instead of
   *  the normal tool action. The Virtual Caliper panel sets this when
   *  the user clicks "Pick stem point"; the viewport calls the
   *  callback once and the panel clears the picker. */
  worldPicker?: ((hit: [number, number, number]) => void) | null;
  /** Stem centreline polylines (one per tree). Drawn as thin yellow
   *  LineSegments depth-test-off overlay over the cloud — pushed by
   *  the Stem Centerline panel + the Click-to-measure-tree panel.
   *  Null / empty = no overlay. Nodes are in world / source CRS;
   *  OctreeView reapplies the scene swap-and-negate. */
  stemCenterlines?: { trees: Array<{ treeId: number; nodes: Array<{ x: number; y: number; z: number; radius: number }> }> } | null;
  /** Skeleton sample points overlay — flat xyz buffer + per-point
   *  tree_id / branch_order. Drawn as a single THREE.Points cloud
   *  coloured by tree_id hash, depth-test on so it composes with the
   *  cloud naturally. Null = no overlay. */
  skeletonOverlay?: { origin: [number, number, number]; xyz: Float32Array; treeId: Int32Array; order: Uint8Array; radiusMm: Uint16Array; colorMode: 'tree' | 'class' | 'radius'; sourceDir?: string; alignment?: { dx: number; dy: number; theta: number; cx: number; cy: number } | null } | null;
  /** M3C2 change overlay — decimated core points colored by signed
   *  distance (blue = loss, red = growth, dim grey = within-noise /
   *  undefined). Coords are already relative to the active octree offset,
   *  so only the scene swap-and-negate is applied. Null = no overlay. */
  m3c2Overlay?: { xyz: Float32Array; distance: Float32Array; significant: Uint8Array; maxAbs: number } | null;
  /** Raster scene objects (DTM / DSM / CHM) to render as 3D surfaces. */
  rasterLayers: RasterLayer[];
  /** Point-cloud visibility (Layers panel can hide it). */
  cloudVisible: boolean;
  /** Additional clouds rendered alongside the primary one (read-only). */
  secondaryClouds: SecondaryCloud[];
  /** Edit mode: when false a plain drag orbits (camera mode); when true
   *  a plain drag selects (Shift+drag still orbits). Space toggles in
   *  the shell. */
  editMode: boolean;
  /** Measure mode: when on a click snaps to the nearest visible point and
   *  two clicks define a measured segment. Suspends selection. M toggles
   *  in the shell. */
  measuring: boolean;
  /** Push live viewer stats up to the shell's status bar (throttled). */
  onStats: (s: ViewerStats) => void;
  /** Push the current selection count up. */
  onSelectedCount: (n: number) => void;
  /** Notify the shell whenever unsaved edits exist (false after save). */
  onDirtyChange?: (dirty: boolean) => void;
  /** Hand the shell the imperative action API once the viewer mounts;
   *  called with null on unmount. */
  onApiReady: (api: OctreeShellApi | null) => void;
  /** The eyedropper (Shift+click) sets the active tree id through the
   *  shell so the ToolsPanel stays in sync. */
  onActiveTreeId: (id: number) => void;
  /** Eyedropper in a deadwood colour mode sets that channel's active id
   *  through the shell so the Deadwood tool re-edits the picked log. */
  onActiveDeadwoodId: (channel: 'standing' | 'laying', id: number) => void;
  /** Bake the dataset (with patches applied) to a LAS file. The viewer
   *  flushes its in-memory patches to patches.bin first, so the export
   *  reflects exactly what's on screen. */
  onExportLas?: () => void | Promise<void>;
  /** Written on pointer-move with the world position under the cursor
   *  (nearest streamed point) for the status bar. */
  cursorRef?: React.MutableRefObject<{ x: number; y: number; z: number } | null>;
}

interface LoadedNode {
  geom: THREE.BufferGeometry;
  level: number;
  /** Live tree ids, mutated by editing patches. */
  treeIds: Int32Array;
  intensity: Uint16Array;
  classification: Uint8Array;
  /** LAS return number per point (byte 19) — already decoded upstream, kept here so the return-number filter can read it. */
  returnNumber: Uint8Array;
  /** How many of this node's points passed the filters at the last
   *  applyFilters call. Kept per node (rather than one global tally) so
   *  the live match count stays correct as tiles stream in and out —
   *  a tally computed only when the filters change would drift the
   *  moment the user panned. Summed over the resident nodes per frame. */
  filterPass: number;
  semantic: Uint8Array | null;
  /** Per-extra-column data, decoded from the trailing f32 region of each
   *  point's bytes. Keys match metadata.extras[i].name; empty object
   *  when the file has no extras (v1 / v2 / un-extended v3 imports). */
  extras: Record<string, Float32Array>;
  deleted: Uint8Array | null;
  selection: Uint8Array | null;
  /** Per-point filter visibility (1 = drawn, 0 = hidden). Backs the
   *  `aVisible` shader attribute, which multiplies gl_PointSize so a
   *  hidden point becomes a zero-size primitive and never rasterises.
   *  Filters are non-destructive — flipping this brings the point back
   *  next frame without touching positions / patches / disk. Uint8 (not
   *  float): a non-normalized integer attribute reaches the shader as
   *  0.0 / 1.0 and costs 1 byte/point of VRAM instead of 4. */
  visibility: Uint8Array;
  /** Per-point depth-cue flag (1 = grey background point that fades with
   *  view depth while a tree is isolated; 0 = full-strength colour).
   *  Backs the `aDim` shader attribute; rewritten by colorNode — set for
   *  unassigned points in tree_id mode, zero everywhere else. */
  dim: Uint8Array;
  /** Live positions in scene coords (NaN for deleted points) — the CPU
   *  source of truth for picking / selection / measuring / colour ramps.
   *  The GPU never sees these: it draws qPositions below. */
  positions: Float32Array;
  /** GPU position attribute: per-axis uint16, normalized, node-relative —
   *  scene = qOrigin + raw/65535 × qSize (dequantised in the vertex
   *  shader from per-node uniforms). 6 bytes/point instead of 12, which
   *  halves position VRAM + upload; precision is qSize/65535 per axis
   *  (mm-scale even on a whole tile). Deleted (NaN) points encode as 0
   *  and are masked by aVisible, since NaN can't ride in a uint. */
  qPositions: Uint16Array;
  qOrigin: [number, number, number];
  qSize: [number, number, number];
  /** Original positions decoded from disk, kept so an undo / unhide
   *  can restore them without round-tripping through the file. */
  originalPositions: Float32Array;
  /** Original tree ids — undoing a tree_id assignment resets to this. */
  originalTreeIds: Int32Array;
  /** Original semantic labels imported from the LAS Extra-Bytes column
   *  (zeros for v1 files / unsegmented imports). Undoing a semantic
   *  edit resets `semantic` back to this. */
  originalSemantic: Uint8Array;
  /** Live deadwood instance ids per channel (standing / laying), mutated
   *  by editing patches. Null when the dataset doesn't carry the reserved
   *  deadwood extras (legacy v3 datasets imported before the feature). */
  standingDeadwood: Int32Array | null;
  layingDeadwood: Int32Array | null;
  /** Pristine deadwood ids decoded from disk, for undo / repaint reset. */
  originalStandingDeadwood: Int32Array | null;
  originalLayingDeadwood: Int32Array | null;
  tile: number;
  record: number;
  recIdx: number;
  numPoints: number;
  spacing: number;
  heightMin: number;
  heightMax: number;
  /** Frame counter at the last plan call that marked this node visible.
   *  LRU eviction sorts non-visible nodes by this ascending. */
  lastUsedFrame: number;
  /** Streaming-fade level, 0–1. Drives the material's uFade each frame:
   *  ramps toward 1 while the node is in the visible set (dissolve in)
   *  and toward 0 when it leaves (dissolve out before hiding). */
  fade: number;
  /** Per-node material (clone of the base ShaderMaterial). Owned by
   *  the LoadedNode so eviction can dispose it cleanly. */
  material: THREE.ShaderMaterial;
  /** Set once the node's Points object has been uploaded to the scene
   *  in the per-frame GPU drain. Null while the node is queued for
   *  upload — eviction handles either state. */
  obj: THREE.Points | null;
}

// Potree 2-style streamer constants. Tuned for a 12 GB VRAM target;
// pointBudget is user-controlled via DisplayControls, the rest stay
// fixed because they balance latency vs. throughput, not memory.
// Concurrent disk loads. Potree's default of 4 is tuned for HTTP latency;
// our blocks come off local disk through the Tauri IPC, where per-call
// overhead (not bandwidth) dominates — more in-flight reads hide it.
const MAX_NODES_LOADING = 10;
const LOADED_TO_GPU_PER_FRAME = 4;       // GPU uploads / frame to avoid hitches
const PLAN_INTERVAL_MS = 80;             // re-plan throttle (≈ 12 Hz)
// Streaming fade — a freshly loaded node dissolves IN over this long
// (screen-door dither in the fragment shader, no blending / sorting
// involved), and a node leaving the visible set dissolves OUT before its
// Points object is actually hidden. Kills the "tile pops into existence"
// flicker the additive streamer otherwise shows while loading.
const FADE_IN_MS = 220;
const FADE_OUT_MS = 120;
// Predictive prefetch: when the camera is moving, also plan from its
// extrapolated position this far ahead and queue those loads at reduced
// priority — tiles start arriving BEFORE the camera gets there (the
// RiSCAN-style "it's already loaded when you stop" feel).
const PREFETCH_LOOKAHEAD_S = 0.3;
const PREFETCH_MIN_SPEED = 0.5;          // scene units (m) per second
const PREFETCH_MAX_NODES = 32;           // cap per plan so prefetch can't starve real loads

/** Tiny inlined binary max-heap. Used for the LOD priority queue —
 *  pop returns the highest-weight node (largest projected radius)
 *  so the planner refines into screen-prominent regions first. */
/** Shared shader uniforms that update once per frame and propagate to
 *  every per-node material via JS reference identity. The per-node
 *  ShaderMaterial clones each get a private uSpacing uniform but
 *  reference the same uSize / uProjFactor objects. */
/** What the 'height' colour ramp runs over, in scene y. `shift`, when
 *  set, is the ground under a point (scene x, z) minus the terrain's
 *  reference, taken off the point's y before ramping — the ramp is then
 *  over height above ground. */
export interface HeightSpan {
  lo: number;
  hi: number;
  shift?: (sceneX: number, sceneZ: number) => number;
}

interface SharedShaderUniforms {
  uSize: { value: number };
  uProjFactor: { value: number };
  /** Depth-cue for the grey background (unassigned) points while a tree
   *  is isolated in Tree Review: points flagged aDim=1 fade from lighter
   *  (near) to darker (far) across [uDimNear, uDimFar] view depth.
   *  uDimEnabled gates the whole effect; near/far re-derive every frame
   *  from the camera ↔ isolate-box distance. Shared objects so one write
   *  reaches every node material. */
  uDimEnabled: { value: number };
  uDimNear: { value: number };
  uDimFar: { value: number };
  uDimStrength: { value: number };
  /** "Heights above ground" — see three/terrainGrid.ts. uFlatten gates
   *  it; uDtm is the ground minus its reference level as an R32F
   *  texture; uDtmOrigin is the grid's (minX − offsetX, minY − offsetY),
   *  so scene x and world north index it; uDtmCell its cell; uDtmSize
   *  its cols × rows. Shared objects, so one write reaches every node. */
  uFlatten: { value: number };
  uDtm: { value: THREE.Texture };
  uDtmOrigin: { value: THREE.Vector2 };
  uDtmCell: { value: number };
  uDtmSize: { value: THREE.Vector2 };
  /** Not a uniform: how far a drawn point can lie from its stored
   *  height — the terrain's relief, metres — so the planner grows each
   *  node's sphere by it for the frustum test. 0 while not flattening. */
  relief: number;
  /** Not a uniform: the span the 'height' colour ramp runs over, and,
   *  when the ramp is over height above ground, the terrain to take off
   *  each point first. Here so a node loaded later is coloured like the
   *  ones on screen. Null before the streamer sets it. */
  heightSpan: HeightSpan | null;
  /** Not a shader uniform — shared render state threaded alongside the
   *  uniforms so node colouring (incl. freshly-streamed nodes) can paint
   *  the active-instance highlight without re-threading every loader
   *  signature. The id is keyed per channel; 0 = no highlight for that
   *  channel. The active colour mode picks which channel's id is shown:
   *  tree_id → `tree`, standing_deadwood → `standing`,
   *  laying_deadwood → `laying`. */
  activeTreeId: number;
  activeStandingId: number;
  activeLayingId: number;
  /** RGB (0–255) of the active-instance highlight, from display.activeTreeColor. */
  activeTreeRgb: [number, number, number];
  /** RGB (0–255) of unlabelled points in the categorical edit modes
   *  (tree_id ≤ 0, semantic = 0, deadwood = (0, 0)). From
   *  display.unlabeledColor — user-tunable. */
  unlabeledRgb: [number, number, number];
  /** Flattened tree-id merge map (from → final target). Applied to a
   *  node's tree ids right after its patches, so a merged tree reads as
   *  its target id everywhere downstream (colour, filters, picking).
   *  Empty when no merges are active. */
  remap: Map<number, number>;
}

/** Parse a #rrggbb hex string into an [r,g,b] 0–255 tuple.
 *
 *  Falls back to a loud pink, not a neutral grey: these are colours the
 *  user picked in the Display panel, so a value that fails to parse is a
 *  bug in the config round-trip and should be seen, not absorbed. */
function hexToRgb(hex: string): [number, number, number] {
  return hexToRgb255(hex, [255, 71, 188]);
}

function createSharedUniforms(): SharedShaderUniforms {
  return {
    // Fixed point size = 1 framebuffer pixel — a fixed single-pixel
    // default single-pixel point rendering. gl_PointSize is in framebuffer
    // pixels, so 1.0 is one physical pixel on screen regardless of the
    // display's scaling. No UI slider — tune here if ever needed.
    uSize: { value: 1.0 },
    uProjFactor: { value: 800.0 },
    uDimEnabled: { value: 0 },
    uDimNear: { value: 1 },
    uDimFar: { value: 100 },
    uDimStrength: { value: 0.7 },
    uFlatten: { value: 0 },
    uDtm: { value: emptyTerrainTexture() },
    uDtmOrigin: { value: new THREE.Vector2(0, 0) },
    uDtmCell: { value: 1 },
    uDtmSize: { value: new THREE.Vector2(1, 1) },
    relief: 0,
    heightSpan: null,
    activeTreeId: 0,
    activeStandingId: 0,
    activeLayingId: 0,
    activeTreeRgb: [255, 71, 188],
    unlabeledRgb: [120, 120, 120],
    remap: new Map<number, number>(),
  };
}

/** Resolve a raw { from → to } merge map into a flat one where a single
 *  lookup fully resolves an id (A→B→C collapses to A→C). Self-maps + the
 *  obvious cycles are dropped. Mirrors the Rust parse_remap so the viewer
 *  and the exporter agree on what a merged cloud looks like. */
/** Desktop-bridge accessors for the merge overlay. The octree editor
 *  only runs on the desktop build, but these degrade to no-ops (empty
 *  map / resolved promise) if the bridge is somehow absent. */
interface TreemapBridge {
  octreeReadTreemap?: (dir: string) => Promise<string>;
  octreeWriteTreemap?: (dir: string, json: string) => Promise<unknown>;
}

async function readTreemap(dir: string): Promise<Map<number, number>> {
  const d = (window as unknown as { desktop?: TreemapBridge }).desktop;
  const map = new Map<number, number>();
  if (!d?.octreeReadTreemap) return map;
  try {
    const obj = JSON.parse((await d.octreeReadTreemap(dir)) || '{}') as Record<string, number>;
    for (const [k, v] of Object.entries(obj)) {
      const from = parseInt(k, 10);
      if (Number.isFinite(from) && Number.isFinite(v) && from !== v) map.set(from, v);
    }
  } catch { /* malformed / absent overlay ⇒ no merges */ }
  return map;
}

function writeTreemap(dir: string, raw: Map<number, number>): Promise<void> {
  const d = (window as unknown as { desktop?: TreemapBridge }).desktop;
  if (!d?.octreeWriteTreemap) return Promise.resolve();
  const obj: Record<string, number> = {};
  for (const [from, to] of raw) obj[String(from)] = to;
  return Promise.resolve(d.octreeWriteTreemap(dir, JSON.stringify(obj))).then(() => undefined);
}

const POINT_VERTEX_SHADER = /* glsl */ `
attribute vec3 color;
attribute float aVisible;
attribute float aDim;
uniform float uSize;
uniform vec3 uQOrigin;
uniform vec3 uQSize;
uniform float uDimEnabled;
uniform float uDimNear;
uniform float uDimFar;
uniform float uDimStrength;
uniform float uFlatten;
uniform highp sampler2D uDtm;
uniform vec2 uDtmOrigin;
uniform float uDtmCell;
uniform vec2 uDtmSize;
varying vec3 vColor;
varying float vBright;
// The ground minus its reference level under a scene (x, z): bilinear
// over the cell centres, clamped to the grid — the same sampling as
// terrainGrid.ts's sampleGround, so a pick lands where the point shows.
// Bilinear by hand: a float texture is NEAREST-filtered.
float dtmTexel(vec2 ij) {
  return texture2D(uDtm, (ij + 0.5) / uDtmSize).r;
}
float dtmShift(vec2 sceneXZ) {
  // Scene x is east − offset; scene z is −(north − offset).
  vec2 g = vec2(sceneXZ.x - uDtmOrigin.x, -sceneXZ.y - uDtmOrigin.y) / uDtmCell - 0.5;
  g = clamp(g, vec2(0.0), uDtmSize - 1.0);
  vec2 i0 = floor(g);
  vec2 i1 = min(i0 + 1.0, uDtmSize - 1.0);
  vec2 f = g - i0;
  float a = mix(dtmTexel(vec2(i0.x, i0.y)), dtmTexel(vec2(i1.x, i0.y)), f.x);
  float b = mix(dtmTexel(vec2(i0.x, i1.y)), dtmTexel(vec2(i1.x, i1.y)), f.x);
  return mix(a, b, f.y);
}
void main() {
  // Filter mask: a hidden point is sent to a clip-space corner where it
  // is guaranteed to be culled, and its size is zeroed. Belt-and-braces
  // because some GPU drivers clamp gl_PointSize to a 1 px minimum even
  // when the requested size is zero — that left class-filter hides
  // (e.g. ground points after the PMF) still rasterising at 1 px while
  // tree-id filters worked. With the clip-space displacement no fragment
  // is ever emitted regardless of how the driver handles point size.
  // Deleted points also pass through here: they quantise to the node
  // origin but always carry aVisible = 0.
  if (aVisible < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vBright = 1.0;
    return;
  }
  vColor = color;
  // Dequantise the node-relative uint16 position (normalized attribute,
  // so 'position' arrives in [0,1] per axis). Node-relative coords also
  // kill float32 jitter on large UTM-style coordinates.
  vec3 pos = uQOrigin + position * uQSize;
  // Heights above ground: the terrain under the point comes off its
  // height, so the ground is drawn flat at its reference level and a
  // tree stands at its height over it. The stored position is untouched.
  if (uFlatten > 0.5) pos.y -= dtmShift(pos.xz);
  vec4 viewPos = modelViewMatrix * vec4(pos, 1.0);
  // Depth-cue the flagged (grey background) points: nearer = lighter,
  // farther = darker across the isolate neighbourhood's depth span, so
  // the unassigned cloud around an isolated tree reads with depth
  // instead of as a flat grey wall. Everything else stays full strength.
  vBright = 1.0;
  if (uDimEnabled > 0.5 && aDim > 0.5) {
    float t = clamp((-viewPos.z - uDimNear) / max(uDimFar - uDimNear, 0.001), 0.0, 1.0);
    // The ends of the ramp open out from 1.0 with the strength, so the
    // slider runs continuously from "no cue at all" to a hard one and
    // there is no jump when it leaves zero.
    float near = 1.0 + 0.45 * uDimStrength;
    float far  = 1.0 - 0.92 * uDimStrength;
    vBright = mix(near, far, t);
  }
  gl_Position = projectionMatrix * viewPos;
  // Fixed pixel-size points — crisp dots, the same small size at every
  // distance / LOD level (RiSCAN-Pro-style dots, not distance-scaled
  // splats). An earlier attempt at spacing-adaptive sizing to hide LOD
  // density seams blew the points up into huge boxes, so we keep the
  // fixed-size look the cloud reads best with; uSize is an absolute
  // pixel count from the Display panel's Point-size slider.
  gl_PointSize = uSize;
}
`;

const POINT_FRAGMENT_SHADER = /* glsl */ `
varying vec3 vColor;
varying float vBright;
uniform float uFade;
void main() {
  // Screen-door fade for streaming: while uFade < 1 a per-pixel hash
  // discards the complementary fraction of fragments, so a freshly
  // loaded node dissolves in instead of popping. No blending — depth
  // writes stay intact, so there's nothing to sort and EDL still works.
  if (uFade < 1.0) {
    float h = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    if (h > uFade) discard;
  }
  gl_FragColor = vec4(vColor * vBright, 1.0);
}
`;

/** Build a ShaderMaterial bound to the shared uniforms + this node's
 *  spacing. Cheap to call per node — Three.js dedups identical shader
 *  programs internally so all clones share one GPU pipeline. uFade and
 *  the dequantisation params (uQOrigin / uQSize) are per-node. */
function makeNodeMaterial(
  shared: SharedShaderUniforms, spacing: number,
  qOrigin: [number, number, number], qSize: [number, number, number],
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSize: shared.uSize,
      uProjFactor: shared.uProjFactor,
      uSpacing: { value: spacing },
      uFade: { value: 0 },
      uQOrigin: { value: new THREE.Vector3(qOrigin[0], qOrigin[1], qOrigin[2]) },
      uQSize: { value: new THREE.Vector3(qSize[0], qSize[1], qSize[2]) },
      uDimEnabled: shared.uDimEnabled,
      uDimStrength: shared.uDimStrength,
      uDimNear: shared.uDimNear,
      uDimFar: shared.uDimFar,
      uFlatten: shared.uFlatten,
      uDtm: shared.uDtm,
      uDtmOrigin: shared.uDtmOrigin,
      uDtmCell: shared.uDtmCell,
      uDtmSize: shared.uDtmSize,
    },
    vertexShader: POINT_VERTEX_SHADER,
    fragmentShader: POINT_FRAGMENT_SHADER,
    transparent: false,
    depthTest: true,
    depthWrite: true,
  });
}

/** Re-encode a node's live float positions into its uint16 GPU buffer.
 *  Called whenever ln.positions changes (load, edit replay, undo). The
 *  encoding — and why a deleted NaN point lands on 0 — is in
 *  three/quantise. */
function syncQuantizedPositions(ln: LoadedNode): void {
  quantisePositions(ln.positions, ln.qPositions, { qOrigin: ln.qOrigin, qSize: ln.qSize });
}

/** A screen-space selection shape, in client-space CSS pixels. Mirrors
 *  the in-memory ShapeSelectController so the octree editor offers the
 *  same rectangle / lasso / polygon tools. */
export type SelectShape =
  | { kind: 'rect'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'poly'; pts: [number, number][] };

/** A frozen copy of the session selection (node key → point indices),
 *  captured by apply-to-selection and carried on its undo batch so
 *  Ctrl+Z can hand the points back as still-selected. Plain arrays, not
 *  live Sets — the live ones keep mutating after the snapshot. */
type SelectionSnapshot = Array<[PatchNodeKey, number[]]>;

/** API exposed from the in-canvas EditController so the outer toolbar
 *  + the OctreeSelectController gesture handler can drive editing
 *  without poking refs directly. */
export interface EditApi {
  /** Project world points into screen space and mark every point inside
   *  `shape` selected. `depth: 'visible'` keeps only points on the
   *  frontmost surface (occlusion-aware across all loaded
   *  nodes); 'through' takes every point in the shape regardless of
   *  depth. `mode` adds to or subtracts from the running selection. */
  selectByShape: (shape: SelectShape, depth: 'visible' | 'through', mode: 'add' | 'sub') => number;
  clearSelection: () => void;
  /** Replace the session selection with a snapshot (the one an
   *  apply-to-selection consumed, carried on its undo batch) and repaint
   *  — so undoing a wrong-button apply leaves the points still selected
   *  for the right button. */
  restoreSelection: (snap: SelectionSnapshot) => void;
  /** Select every VISIBLE unassigned (tree_id ≤ 0) point across the
   *  loaded nodes — i.e. exactly the grey points on screen, already
   *  narrowed by whatever filters are active (isolate box, height band,
   *  margin ring …). Returns how many were added. Backs Tree Review's
   *  "absorb nearby unassigned" action: with a tree isolated, the
   *  visible grey ring IS the candidate set, so this replaces a fiddly
   *  lasso with one click. */
  selectVisibleUnassigned: () => number;
  /** Screen-space eyedropper: returns the tree_id of the frontmost point
   *  under the cursor (within a few px), or null if nothing is hit. */
  pickTreeIdAt: (x: number, y: number) => number | null;
  /** Same as pickTreeIdAt but for one of the deadwood id channels. */
  pickDeadwoodIdAt: (x: number, y: number, channel: 'standing' | 'laying') => number | null;
  /** Screen-space pick returning the source-CRS world position of the
   *  frontmost point under the cursor (for the status bar), or null. */
  pickPositionAt: (x: number, y: number) => { x: number; y: number; z: number } | null;
  /** Screen-space pick returning the SCENE-space position (the same
   *  coords the geometry is drawn in) of the frontmost visible point
   *  under the cursor, for the measure tool's in-scene overlay. Distances
   *  in scene space equal real-world distances (the scene transform is a
   *  rigid translate + axis-swap). Null if nothing is hit. `maxSamples`
   *  caps the scan via stride sampling — the measure tool wants every
   *  point (default Infinity); the rotation pivot passes a small cap so
   *  the per-press pick stays cheap. */
  pickScenePointAt: (x: number, y: number, maxSamples?: number) => [number, number, number] | null;
  /** Largest tree_id across loaded nodes + patches — used by the
   *  toolbar's "New tree" button. Out-of-core so it can only see loaded
   *  data, but that's the same set the user is looking at. */
  maxTreeId: () => number;
  /** Apply an action to every currently-selected point across loaded
   *  nodes. Returns the number of patch records written. */
  applyToSelection: (action: {
    treeId?: number;
    semantic?: 0 | 1 | 2 | 3;
    deleted?: 0 | 1 | 2;
    standingDeadwood?: number;
    layingDeadwood?: number;
  }) => number;
  countSelected: () => number;
  /** Largest deadwood id across loaded nodes + patches for the given
   *  channel — used by the Deadwood tool's "New" button. */
  maxDeadwoodId: (channel: 'standing' | 'laying') => number;
  /** Merge every `fromIds` tree into `toId`: updates the merge overlay,
   *  persists treemap.json, and re-folds all loaded nodes so the change
   *  shows immediately. Resolves once the overlay is on disk. */
  mergeTrees: (fromIds: number[], toId: number) => Promise<void>;
  /** Drop one merge (un-merge `fromId` back to itself). */
  unmergeTree: (fromId: number) => Promise<void>;
  /** Drop every merge. */
  clearMerges: () => Promise<void>;
  /** Current merges as raw [from, to] pairs (pre-flatten), id-sorted. */
  getMerges: () => [number, number][];
  /** Drop every loaded node + re-stream from disk. Used after an
   *  out-of-band rewrite of octree.bin (e.g. ground classification) so
   *  the freshly-written attributes show without reopening the dataset. */
  reloadNodes: () => void;
  /** Stop the streamer planning and loading nodes. Paired with
   *  reloadNodes while a memory-heavy backend stage runs: the resident
   *  set is dropped and NOT refilled until this is cleared. */
  setStreamingPaused: (paused: boolean) => void;
  /** What the viewport holds right now — for the memory samples the
   *  busyStage effect writes while a heavy stage runs. */
  memoryInfo: () => RendererMemoryInfo;
  /** Where the isolated tree's points stand in the streamer, for the
   *  review panel to show: the records the scan listed for it, how
   *  many of those (ancestors included) the planner forces, how many
   *  are resident, and how many points of the id are resident and
   *  drawn. A tree whose far parts do not show is diagnosed from this
   *  line instead of guessed at. Null when nothing is isolated. */
  isolateStatus: () => IsolateStatus | null;
  /** Cheap heuristic: does any currently-loaded node carry a tree_id > 0?
   *  Used to warn before a destructive re-segmentation. Tile roots hold a
   *  whole-tile sample, so an imported tree_id column is reliably seen. */
  hasTreeIds: () => boolean;
}

/** Even-odd point-in-polygon test in screen space. Identical to the
 *  in-memory ShapeSelectController's so lasso / polygon selection behaves
 *  the same in both editors. `pts` are CSS-pixel screen coordinates. */
/** Backend stages that saturate every core for minutes and take the
 *  memory with them. While one runs, the viewport releases its resident
 *  point set and stops streaming — see the busyStage effect. */
const RELEASE_CLOUD_FOR = new Set(['tst', 'qsm']);
const STAGE_LABEL: Record<string, string> = { tst: 'skeleton build', qsm: 'QSM reconstruction' };

export default function OctreeView({
  octree, display, tools, filters, subsetPreview, worldPicker, stemCenterlines, skeletonOverlay, m3c2Overlay, rasterLayers, cloudVisible, secondaryClouds, editMode, measuring, onStats, onSelectedCount, onDirtyChange,
  onApiReady, onActiveTreeId, onActiveDeadwoodId, onExportLas, cursorRef,
}: Props) {
  const bbMin = octree.meta.boundingBox.min;
  const bbMax = octree.meta.boundingBox.max;
  const sceneCenter = useMemo<[number, number, number]>(() => [
    0.5 * (bbMin[0] + bbMax[0]) - octree.meta.offset[0],
    0.5 * (bbMin[2] + bbMax[2]) - octree.meta.offset[2],
    // sceneZ = −north (see decodeNodePoints): negate so the camera
    // centres on the same place the points actually render.
    -(0.5 * (bbMin[1] + bbMax[1]) - octree.meta.offset[1]),
  ], [bbMin, bbMax, octree.meta.offset]);
  const extent = useMemo<number>(() => Math.max(
    bbMax[0] - bbMin[0],
    bbMax[1] - bbMin[1],
    bbMax[2] - bbMin[2],
  ), [bbMin, bbMax]);
  const startCamera = useMemo<[number, number, number]>(() => [
    sceneCenter[0] + extent * 0.8,
    sceneCenter[1] + extent * 0.6,
    sceneCenter[2] + extent * 0.8,
  ], [sceneCenter, extent]);
  const targetVec = useMemo(() => new THREE.Vector3(...sceneCenter), [sceneCenter]);

  // Heights: the cloud's terrain while they are shown above ground, and
  // the skeleton overlay's move onto this cloud's height frame — a
  // normalised skeleton over an elevation cloud used to be drawn
  // hundreds of metres under it. See three/useTerrain.ts.
  const heights = useHeightDisplay({
    heightMode: display.heightMode ?? 'stored',
    colorAboveGround: display.colorMode === 'height' && display.heightColorAboveGround === true,
    cloudDir: octree.dir,
    cloudZ: [bbMin[2], bbMax[2]],
    skeleton: skeletonOverlay,
  });

  // Display + tools are controlled by the shell; pull the active tree id
  // out for the edit handlers below.
  const activeTreeId = tools.activeTreeId;
  const activeStandingId = tools.activeStandingId;
  const activeLayingId = tools.activeLayingId;
  const selectTool = tools.selectTool;
  const selectDepth = tools.selectDepth;

  // The streamer pushes stats every frame; throttle the push up to the
  // shell to ~5 Hz so the status-bar rerender doesn't compete with the
  // canvas.
  const lastStatsAt = useRef(0);
  const onStatsChange = useCallback((s: ViewerStats) => {
    const now = performance.now();
    if (now - lastStatsAt.current < 200) return;
    lastStatsAt.current = now;
    onStats(s);
  }, [onStats]);

  // ---- Stage 3 edit state -----------------------------------------
  const storeRef = useRef<PatchStore>(new PatchStore());
  /** Session-persistent selection: node-key → set of point indices.
   *  Lives outside loadedRef so a selected point survives the LOD
   *  evicting + reloading its node. */
  const selectionStoreRef = useRef<Map<PatchNodeKey, Set<number>>>(new Map());
  const [storeVersion, setStoreVersion] = useState(0);
  // The WebGL context died and has not come back. Not a crash of the
  // application — the backend keeps running — but indistinguishable
  // from one until something says so.
  const [glLost, setGlLost] = useState(false);
  // A new dataset is a new canvas with a live context, whatever became
  // of the last one.
  useEffect(() => { setGlLost(false); }, [octree.dir]);
  // Bumped to give the same cloud a new canvas — the overlay's first
  // remedy for a lost context. A new key is exactly what a change of
  // dataset does, and that path is exercised on every switch.
  const [canvasEpoch, setCanvasEpoch] = useState(0);
  // Which long backend operation is running, if any. The viewport
  // stops drawing continuously while one is, because a frame that
  // takes seconds is what loses the context in the first place.
  const [busyStage, setBusyStage] = useState<string | null>(null);
  // Mirrors `released` below for the streamer: it may mount AFTER the
  // release — a dataset opened while a build already runs — and then
  // the calls below were no-ops on a null api, the flag said released,
  // and the cloud streamed in regardless (memory.log showed 17 million
  // points "released"). A streamer that mounts while this is true
  // starts paused.
  const releasedRef = useRef(false);
  useEffect(() => {
    let stop: (() => void) | null = null;
    let dead = false;
    let idle: ReturnType<typeof setTimeout> | null = null;
    // Whether the resident point set has been released for the stage
    // now running — once per stage, not on every progress tick.
    let released = false;
    // WHAT THE PAGE HOLDS, ONCE A MINUTE, WHILE A STAGE RUNS.
    //
    // The renderer process died of memory an hour into a build with
    // the cloud released and the backend at a quarter of a gigabyte.
    // The process samples (crash.rs) say which browser process grew;
    // these say how much of it was this page's JS heap and whether the
    // viewport was really holding nothing. To memory.log, via the
    // crash_log command's "memory" kind.
    let sampler: ReturnType<typeof setInterval> | null = null;
    let sampledStage = '';
    const sample = () => {
      const desktop = (window as unknown as { desktop?: { logCrash?: (m: string, k?: string) => unknown } }).desktop;
      if (!desktop?.logCrash) return;
      try {
        desktop.logCrash(describeRendererMemory(
          sampledStage, released, readPerformanceMemory(),
          editApiRef.current?.memoryInfo() ?? null,
          document.getElementsByTagName('*').length,
        ), 'memory');
      } catch { /* the log is best-effort */ }
    };
    const stopSampling = () => {
      if (sampler) { clearInterval(sampler); sampler = null; }
    };
    const finish = () => {
      setBusyStage(null);
      if (sampler) { sample(); stopSampling(); }
      if (released) {
        released = false;
        releasedRef.current = false;
        // Lift the pause; the planner refills the view on the next frame.
        editApiRef.current?.setStreamingPaused(false);
      }
    };
    onOctreeProgress((stage, pct) => {
      // 1 is the last thing every stage emits. A stage that dies
      // without emitting it would otherwise pin the viewport on
      // 'demand' for the rest of the session, so silence ends it too:
      // every running stage reports at least every few seconds, so a
      // minute without a word means there is nothing running.
      if (idle) clearTimeout(idle);
      if (pct >= 1) { finish(); return; }
      setBusyStage(stage);
      if (!sampler) {
        sampledStage = stage;
        sampler = setInterval(sample, 60_000);
      }
      // RELEASE THE POINT SET WHILE THE BACKEND SATURATES THE MACHINE.
      //
      // The renderer died at 70 % of a skeleton build showing WebView2's
      // own crash page — a renderer process gone, not a lost context.
      // Whatever the proximate cause on a given machine, a viewport
      // that holds nothing and draws nothing cannot run out of memory,
      // cannot stall on a frame, and cannot lose a context that
      // matters. Every edit lives in the patch store, not in the nodes,
      // so nothing unsaved is at risk; the cloud streams back in when
      // the stage reports done.
      if (RELEASE_CLOUD_FOR.has(stage) && !released) {
        released = true;
        releasedRef.current = true;
        editApiRef.current?.setStreamingPaused(true);
        editApiRef.current?.reloadNodes();
        // One sample right after the release, so the log shows what
        // releasing actually freed.
        setTimeout(sample, 2_000);
      }
      idle = setTimeout(finish, 60_000);
    }).then((un) => { if (dead) un(); else stop = un; });
    return () => {
      dead = true;
      if (idle) clearTimeout(idle);
      stopSampling();
      if (stop) stop();
    };
  }, []);
  const [selectedCount, setSelectedCountState] = useState(0);
  const setSelectedCount = useCallback((n: number) => {
    setSelectedCountState(n);
    onSelectedCount(n);
  }, [onSelectedCount]);
  const [, setDirtyState] = useState(false);
  const setDirty = useCallback((d: boolean) => {
    setDirtyState(d);
    onDirtyChange?.(d);
  }, [onDirtyChange]);
  // The EditController inside Canvas plugs its API in here via a ref so
  // the toolbar + box-drag overlay can call it directly.
  const editApiRef = useRef<EditApi | null>(null);

  // Load patches when the dataset changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const patches = await loadPatches(octree.dir);
        if (cancelled) return;
        storeRef.current.loadFrom(patches);
        setStoreVersion(storeRef.current.version);
        setDirty(false);
      } catch (e) {
        console.warn('octree patches load failed', e);
      }
    })();
    return () => { cancelled = true; };
  }, [octree]);

  // Saves are SERIALIZED through this chain: the begin/chunk/commit
  // protocol appends to ONE shared tmp file per dataset, so two saves
  // running at once (⌘S during an export-triggered flush, autosave vs
  // manual, …) would interleave their chunks into it — and because both
  // write whole 32-byte records, the commit length check could pass and
  // replace patches.bin with a mixed record stream. A save enqueued
  // while one is in flight simply runs after it completes.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const onSave = useCallback(async () => {
    // Don't swallow errors here — the shell's wrapper turns a thrown
    // error into a red "Save failed" indicator the user actually sees,
    // and re-throws so the export path can abort instead of running with
    // an out-of-date patches.bin. (The old console.warn-and-continue was
    // how the user lost dozens of trees' worth of edits: WebView2 hung
    // the JSON-encoded patches IPC, the promise rejected silently,
    // markClean ran, dirty cleared, the Save button went green —
    // patches.bin was never actually written.)
    const run = async () => {
      // NOTHING TO FLUSH, NOTHING TO WRITE. The store carries a dirty
      // flag "so saving knows whether to hit disk" (its own words) and
      // this never consulted it, so every caller rewrote patches.bin in
      // full whether or not a single point had changed — and half a
      // dozen panels call save() before they measure anything, on mount.
      //
      // It became load-bearing with the metrics cache: that cache is
      // keyed on a fingerprint of the files, so a save that rewrites
      // patches.bin for no reason moves the fingerprint and throws away
      // a measurement of the whole cloud. A clean store has, by
      // construction, already been written — `markClean` runs only after
      // a write that nothing changed underneath.
      if (!storeRef.current.dirty) { setDirty(false); return; }

      // Snapshot the store version BEFORE the write. savePatches streams
      // the LIVE map chunk-by-chunk (editing stays enabled during a
      // save), so an edit made while the write is in flight may or may
      // not land in the file. If any did, what's on disk is a valid but
      // already-stale snapshot — so only mark the store clean when
      // nothing changed underneath the write. Otherwise stay dirty:
      // the Save button keeps prompting, the beforeunload guard stays
      // armed, and the autosave re-flushes shortly. Clearing dirty
      // unconditionally here was a silent-loss window (edit during
      // save → "Saved ✓" → close window → edit gone).
      const versionAtStart = storeRef.current.version;
      await savePatches(octree.dir, storeRef.current.map);
      if (storeRef.current.version === versionAtStart) {
        storeRef.current.markClean();
        setDirty(false);
      } else {
        setDirty(true);
      }
    };
    const p = saveChainRef.current.then(run, run);
    // The chain must never carry a rejection forward (each caller still
    // observes its own save's failure via `p`).
    saveChainRef.current = p.then(() => undefined, () => undefined);
    return p;
  }, [octree, setDirty]);

  // Export = flush the current edits to patches.bin (so the Rust
  // exporter, which reads the file, sees exactly what's on screen) then
  // hand off to the parent's LAS writer.
  // Read through a ref so the API object below does not depend on the
  // prop's identity: an inline arrow from the shell rebuilt the API on
  // every render and the rebuilt API re-rendered the shell — see the
  // note beside exportWithLiveFilters in EditorShell.tsx.
  const onExportLasRef = useRef(onExportLas);
  onExportLasRef.current = onExportLas;
  const doExport = useCallback(async () => {
    const exportLas = onExportLasRef.current;
    if (!exportLas) return;
    await onSave();
    await exportLas();
  }, [onSave]);

  const onUndo = useCallback(() => {
    const r = storeRef.current.undo();
    if (r.ok) {
      setStoreVersion(storeRef.current.version);
      setDirty(storeRef.current.dirty);
      // An undone apply-to-selection also hands back the selection it
      // consumed: the points re-light selection-red, so a wrong-button
      // press (Assign when Reset was meant) rewinds to "still selected —
      // press the right button now" instead of dumping a long
      // hand-picked set.
      if (r.meta) editApiRef.current?.restoreSelection(r.meta as SelectionSnapshot);
    }
  }, []);
  const onRedo = useCallback(() => {
    const r = storeRef.current.redo();
    if (r.ok) {
      setStoreVersion(storeRef.current.version);
      setDirty(storeRef.current.dirty);
      // Redo re-applies the edit — mirror the original apply, which
      // clears the selection so the freshly-recoloured result is
      // visible instead of staying painted selection-red.
      if (r.meta) editApiRef.current?.clearSelection();
    }
  }, []);

  // Editor keyboard shortcuts (save / undo / redo / clear selection /
  // delete / view presets / assign / reset / …) are owned by the shell's
  // central, customizable keybinding dispatcher (EditorShell + state/
  // keybindings.ts) so every shortcut is rebindable from one place. The
  // viewer keeps only the in-gesture keys that are local to an active
  // lasso / measurement (handled inside those controllers below).

  // ---- Selection tools (parity with the in-memory editor) ---------
  // A plain drag with the active tool selects, Shift+drag orbits, Alt
  // subtracts, Shift+click picks a tree_id. The gesture + SVG overlay
  // live in the in-canvas OctreeSelectController; OctreeView owns the
  // orbit-controls ref so the controller can suspend orbit during a drag.
  const orbitRef = useRef<OrbitControlsImpl | null>(null);
  // Shared store for the orientation gizmo: the in-Canvas updater writes
  // each axis's view-space direction here every frame; the DOM overlay
  // reads it on its own rAF loop.
  const gizmoDirsRef = useRef<GizmoDirs>({ x: [1, 0, 0], y: [0, 0, -1], z: [0, 1, 0] });

  const onAfterSelect = useCallback(() => {
    setSelectedCount(editApiRef.current?.countSelected() ?? 0);
  }, [setSelectedCount]);
  // Shift+click eyedropper, colour-mode-aware: in a deadwood channel it
  // picks that channel's id and re-activates it (so you can edit that log
  // again); otherwise it picks the tree id. Returns true when an id was
  // set so the caller swallows the click (keeps it off orbit).
  const onEyedrop = useCallback((x: number, y: number): boolean => {
    const mode = display.colorMode;
    if (mode === 'standing_deadwood' || mode === 'laying_deadwood') {
      const channel = mode === 'standing_deadwood' ? 'standing' : 'laying';
      const id = editApiRef.current?.pickDeadwoodIdAt(x, y, channel);
      if (id != null && id > 0) { onActiveDeadwoodId(channel, id); return true; }
      return false;
    }
    const id = editApiRef.current?.pickTreeIdAt(x, y);
    if (id != null && id > 0) { onActiveTreeId(Math.max(0, id)); return true; }
    return false;
  }, [display.colorMode, onActiveTreeId, onActiveDeadwoodId]);

  // Snap the camera to an orthographic preset. Mirrors the in-memory
  // presetView: F1 top, F2 front, F3 side, each fitting the scene bbox.
  // Works through orbitRef so it composes with damping + zoomToCursor.
  const presetView = useCallback((kind: 'top' | 'front' | 'side') => {
    const ctl = orbitRef.current;
    if (!ctl) return;
    const [cx, cy, cz] = sceneCenter;
    // Scene-space spans (Y is up after the source Y/Z swap).
    const dx = Math.max(0.5, bbMax[0] - bbMin[0]);
    const dy = Math.max(0.5, bbMax[2] - bbMin[2]);
    const dz = Math.max(0.5, bbMax[1] - bbMin[1]);
    if (kind === 'top') {
      ctl.object.position.set(cx, cy + Math.max(dx, dz) * 1.1, cz + 0.001);
    } else if (kind === 'front') {
      ctl.object.position.set(cx, cy, cz + Math.max(dx, dy) * 1.2);
    } else {
      ctl.object.position.set(cx + Math.max(dz, dy) * 1.2, cy, cz);
    }
    ctl.target.set(cx, cy, cz);
    ctl.object.up.set(0, 1, 0);
    ctl.update();
  }, [sceneCenter, bbMin, bbMax]);

  // Frame the camera on a world-space (source-CRS) bbox, preserving the
  // current view direction. Tree Review hands us a tree's footprint; we
  // convert to scene coords (undo the offset + Y/Z swap), recentre the
  // orbit target, and pull the camera back far enough to fit the box in
  // the 45° fov with a little margin.
  const frameBox = useCallback((min: [number, number, number], max: [number, number, number]) => {
    const ctl = orbitRef.current;
    if (!ctl) return;
    const off = octree.meta.offset;
    // scene X ← source X, scene Y ← source Z (height), scene Z ← −source Y
    // (north negated to keep the scene right-handed; see decodeNodePoints).
    const sx0 = min[0] - off[0], sx1 = max[0] - off[0];
    const sy0 = min[2] - off[2], sy1 = max[2] - off[2];
    const sz0 = -(min[1] - off[1]), sz1 = -(max[1] - off[1]);
    const cx = 0.5 * (sx0 + sx1), cy = 0.5 * (sy0 + sy1), cz = 0.5 * (sz0 + sz1);
    const radius = 0.5 * Math.max(sx1 - sx0, sy1 - sy0, sz1 - sz0, 0.5);
    const fov = (ctl.object as THREE.PerspectiveCamera).fov ?? 45;
    const dist = (radius / Math.tan((fov * Math.PI) / 180 / 2)) * 1.5 + radius;
    const dir = new THREE.Vector3().subVectors(ctl.object.position, ctl.target);
    if (dir.lengthSq() < 1e-9) dir.set(1, 0.7, 1);
    dir.normalize();
    ctl.target.set(cx, cy, cz);
    ctl.object.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    ctl.object.up.set(0, 1, 0);
    ctl.update();
  }, [octree.meta.offset]);

  // (F1/F2/F3 view presets are dispatched through the shell's central
  // keybinding handler now, calling api.presetView — see EditorShell.)

  // Apply handlers used by the toolbar buttons. After a successful edit
  // we clear the selection so the result is actually visible — otherwise
  // the just-edited points stay painted selection-red and it looks like
  // nothing happened (this was the "assign does nothing" report). Matches
  // the in-memory editor, which also commits + clears.
  const apply = (action: { treeId?: number; semantic?: 0 | 1 | 2 | 3; deleted?: 0 | 1 | 2; standingDeadwood?: number; layingDeadwood?: number }) => {
    const n = editApiRef.current?.applyToSelection(action) ?? 0;
    if (n > 0) {
      editApiRef.current?.clearSelection();
      setStoreVersion(storeRef.current.version);
      setDirty(true);
    }
  };
  const clearSel = useCallback(() => {
    editApiRef.current?.clearSelection();
    setSelectedCount(0);
  }, [setSelectedCount]);

  const newTree = useCallback(() => {
    const mx = editApiRef.current?.maxTreeId() ?? 0;
    onActiveTreeId(mx + 1);
  }, [onActiveTreeId]);

  // Ground classification: flush edits (so hidden points are excluded),
  // run the native Progressive Morphological Filter over the whole cloud
  // (writes class 2 into octree.bin), then reload nodes so the new
  // classification shows immediately.
  const doClassifyGround = useCallback(async (params: GroundParams): Promise<number> => {
    const d = (window as unknown as {
      desktop?: { octreeClassifyGround?: (dir: string, p: GroundParams) => Promise<number> };
    }).desktop;
    if (!d?.octreeClassifyGround) throw new Error('Ground classification needs the desktop build.');
    await onSave();
    const n = await d.octreeClassifyGround(octree.dir, params);
    editApiRef.current?.reloadNodes();
    return n;
  }, [onSave, octree.dir]);

  const doResetClassification = useCallback(async (fromClass: number, toClass: number): Promise<number> => {
    const d = (window as unknown as {
      desktop?: { octreeResetClassification?: (dir: string, from: number, to: number) => Promise<number> };
    }).desktop;
    if (!d?.octreeResetClassification) throw new Error('Classification reset needs the desktop build.');
    await onSave();
    const n = await d.octreeResetClassification(octree.dir, fromClass, toClass);
    editApiRef.current?.reloadNodes();
    return n;
  }, [onSave, octree.dir]);

  // Reset the whole tree_id or semantic column back to 0. The native
  // command zeroes the baked values in octree.bin; we then strip the
  // matching column from the in-memory patch overlay (so edits don't
  // re-impose old ids/labels), persist the trimmed patches, and reload.
  const doResetAttribute = useCallback(async (attr: 'tree_id' | 'semantic' | 'standing_deadwood' | 'laying_deadwood'): Promise<number> => {
    const d = (window as unknown as {
      desktop?: { octreeResetAttribute?: (dir: string, attr: string) => Promise<number> };
    }).desktop;
    if (!d?.octreeResetAttribute) throw new Error('Column reset needs the desktop build.');
    const n = await d.octreeResetAttribute(octree.dir, attr);
    // Drop this column's overrides from the patch store, then persist so
    // patches.bin agrees with the now-zeroed octree.bin.
    storeRef.current.clearAttribute(attr);
    setStoreVersion(storeRef.current.version);
    await onSave();
    editApiRef.current?.reloadNodes();
    return n;
  }, [onSave, octree.dir]);

  // Auto-segment tree crowns from the CHM. The native command writes fresh
  // tree_ids into octree.bin; we then drop any tree_id patch overrides
  // (so they don't re-impose old ids), persist, and reload — same flush /
  // clear / reload dance as a tree_id reset, but seeded by the watershed.
  const doSegmentChm = useCallback(async (params: SegmentParams): Promise<{ treeCount: number; assignedPoints: number }> => {
    const d = (window as unknown as {
      desktop?: { octreeSegmentChm?: (dir: string, p: SegmentParams) => Promise<{ treeCount: number; assignedPoints: number }> };
    }).desktop;
    if (!d?.octreeSegmentChm) throw new Error('Auto-segmentation needs the desktop build.');
    await onSave();
    const res = await d.octreeSegmentChm(octree.dir, params);
    storeRef.current.clearAttribute('tree_id');
    setStoreVersion(storeRef.current.version);
    await onSave();
    editApiRef.current?.reloadNodes();
    return res;
  }, [onSave, octree.dir]);

  // treeiso individual-tree isolation — bottom-up cut-pursuit cascade. Same
  // flush / clear-tree_id / reload dance as the CHM segmenter (both write a
  // fresh tree_id from scratch).
  const doTreeIsolation = useCallback(async (params: TreeIsoParams): Promise<{ treeCount: number; assignedPoints: number }> => {
    const d = (window as unknown as {
      desktop?: { octreeTreeIsolation?: (dir: string, p: TreeIsoParams) => Promise<{ treeCount: number; assignedPoints: number }> };
    }).desktop;
    if (!d?.octreeTreeIsolation) throw new Error('Tree isolation needs the desktop build.');
    await onSave();
    const res = await d.octreeTreeIsolation(octree.dir, params);
    storeRef.current.clearAttribute('tree_id');
    setStoreVersion(storeRef.current.version);
    await onSave();
    editApiRef.current?.reloadNodes();
    return res;
  }, [onSave, octree.dir]);

  // Li et al. 2012 — same flush / clear-tree_id / reload dance as the other
  // two detectors, since it also writes a fresh tree_id from scratch.
  const doSegmentLi2012 = useCallback(async (params: Li2012Params): Promise<{ treeCount: number; assignedPoints: number }> => {
    const d = (window as unknown as {
      desktop?: { octreeSegmentLi2012?: (dir: string, p: Li2012Params) => Promise<{ treeCount: number; assignedPoints: number }> };
    }).desktop;
    if (!d?.octreeSegmentLi2012) throw new Error('Li 2012 segmentation needs the desktop build.');
    await onSave();
    const res = await d.octreeSegmentLi2012(octree.dir, params);
    storeRef.current.clearAttribute('tree_id');
    setStoreVersion(storeRef.current.version);
    await onSave();
    editApiRef.current?.reloadNodes();
    return res;
  }, [onSave, octree.dir]);

  // M3C2 change detection against a reference epoch — read-only analysis, so
  // no flush / clear / reload (nothing in this cloud changes).
  const doM3C2 = useCallback(async (referenceDir: string, params: M3C2Params): Promise<M3C2Result> => {
    const d = (window as unknown as {
      desktop?: { octreeM3C2?: (dir: string, ref: string, p: M3C2Params) => Promise<M3C2Result> };
    }).desktop;
    if (!d?.octreeM3C2) throw new Error('M3C2 needs the desktop build.');
    return d.octreeM3C2(octree.dir, referenceDir, params);
  }, [octree.dir]);

  // Stem taper (3DFin-style): one click on a stem → the diameter profile
  // section-by-section + a truncated-cone stem volume. Read-only.
  const doStemTaper = useCallback(async (
    clickX: number, clickY: number, clickZ: number, params: StemTaperParams,
  ): Promise<StemTaperResult> => {
    const d = (window as unknown as {
      desktop?: {
        octreeStemTaper?: (
          dir: string, x: number, y: number, z: number,
          opts: { cylinderRadius?: number; sectionHeight?: number; slabHalfHeight?: number; stumpHeight?: number; dtmCell?: number },
        ) => Promise<StemTaperResult>;
      };
    }).desktop;
    if (!d?.octreeStemTaper) throw new Error('Stem taper needs the desktop build.');
    return d.octreeStemTaper(octree.dir, clickX, clickY, clickZ, {
      cylinderRadius: params.cylinderRadius,
      sectionHeight: params.sectionHeight,
      slabHalfHeight: params.slabHalfHeight,
      stumpHeight: params.stumpHeight,
      dtmCell: params.dtmCell,
    });
  }, [octree.dir]);

  // Tree Skeleton Transfer (Honkanen et al. 2026,
  // doi:10.1016/j.ophoto.2026.100147). Pulls tree_id
  // + semantic labels from a baseline dataset's QSM skeletons onto
  // THIS (target) dataset. Same flush / clear / reload dance as the
  // CHM segmenter, but clears BOTH tree_id and semantic patch
  // overrides since the backend rewrites both columns.
  // The target is the caller's, not necessarily the open dataset. The
  // backend always took both directories; only this function pinned
  // the second one to whatever happened to be on screen, which meant a
  // project with five clouds could transfer into exactly one of them.
  //
  // When the target IS the open dataset it needs the reload dance —
  // flush, drop the patch overrides the old labels live in, save,
  // reload — or the viewport keeps showing what was there before.
  // When it is not, the backend has written its octree.bin and it
  // picks the labels up the next time it is opened, which is what the
  // SegmentAnyTree batch beside this already does.
  const doSkeletonTransfer = useCallback(async (
    baselineDir: string,
    targetDir: string,
    params: { distanceThreshold?: number; skeletonSpacing?: number; groundThreshold?: number; rCover?: number; minTreePoints?: number; dtmCell?: number; qsmModels?: number; maxTreePoints?: number; baselineHeight?: 'stored' | 'above_ground'; targetHeight?: 'stored' | 'above_ground' },
  ): Promise<SkeletonTransferResult> => {
    const d = (window as unknown as {
      desktop?: { octreeSkeletonTransfer?: (baseDir: string, targetDir: string, p: typeof params) => Promise<SkeletonTransferResult> };
    }).desktop;
    if (!d?.octreeSkeletonTransfer) throw new Error('Skeleton transfer needs the desktop build.');
    const isActive = targetDir === octree.dir;
    if (isActive) await onSave();
    const res = await d.octreeSkeletonTransfer(baselineDir, targetDir, params);
    if (isActive) {
      storeRef.current.clearAttribute('tree_id');
      storeRef.current.clearAttribute('semantic');
      setStoreVersion(storeRef.current.version);
      await onSave();
      editApiRef.current?.reloadNodes();
    }
    return res;
  }, [onSave, octree.dir]);


  // Auto-detect laying deadwood. Same flush / clear / reload dance as the
  // CHM segmenter, but it writes the laying_deadwood column instead of
  // tree_id (so we clear THAT column's patch overrides). The result is a
  // seed the user edits in the Deadwood tool.
  const doSegmentDeadwood = useCallback(async (params: DeadwoodParams): Promise<{ logCount: number; assignedPoints: number }> => {
    const d = (window as unknown as {
      desktop?: { octreeSegmentDeadwood?: (dir: string, p: DeadwoodParams) => Promise<{ logCount: number; assignedPoints: number }> };
    }).desktop;
    if (!d?.octreeSegmentDeadwood) throw new Error('Deadwood detection needs the desktop build.');
    await onSave();
    const res = await d.octreeSegmentDeadwood(octree.dir, params);
    storeRef.current.clearAttribute('laying_deadwood');
    setStoreVersion(storeRef.current.version);
    await onSave();
    editApiRef.current?.reloadNodes();
    return res;
  }, [onSave, octree.dir]);

  // Geometric leaf–wood separation. Writes the semantic column (1 = wood,
  // 2 = leaf), so the same flush / clear-semantic / reload dance as the
  // skeleton transfer (which also rewrites semantic).
  const doLeafWood = useCallback(async (params: LeafWoodParams): Promise<{ woodPoints: number; leafPoints: number }> => {
    const d = (window as unknown as {
      desktop?: { octreeLeafWood?: (dir: string, p: LeafWoodParams) => Promise<{ woodPoints: number; leafPoints: number }> };
    }).desktop;
    if (!d?.octreeLeafWood) throw new Error('Leaf–wood separation needs the desktop build.');
    await onSave();
    const res = await d.octreeLeafWood(octree.dir, params);
    storeRef.current.clearAttribute('semantic');
    setStoreVersion(storeRef.current.version);
    await onSave();
    editApiRef.current?.reloadNodes();
    return res;
  }, [onSave, octree.dir]);

  // Hand the imperative action API up to the shell. Rebuilt whenever one
  // of its closures changes; cleared on unmount so panels disable.
  useEffect(() => {
    const api: OctreeShellApi = {
      apply,
      clearSelection: clearSel,
      save: onSave,
      exportLas: () => doExport(),
      undo: onUndo,
      redo: onRedo,
      presetView,
      frameBox,
      newTree,
      mergeTrees: (f, t) => editApiRef.current?.mergeTrees(f, t) ?? Promise.resolve(),
      unmergeTree: (f) => editApiRef.current?.unmergeTree(f) ?? Promise.resolve(),
      clearMerges: () => editApiRef.current?.clearMerges() ?? Promise.resolve(),
      getMerges: () => editApiRef.current?.getMerges() ?? [],
      countSelected: () => editApiRef.current?.countSelected() ?? 0,
      maxTreeId: () => editApiRef.current?.maxTreeId() ?? 0,
      applyToSelection: (a) => editApiRef.current?.applyToSelection(a) ?? 0,
      selectVisibleUnassigned: () => editApiRef.current?.selectVisibleUnassigned() ?? 0,
      pickScenePointAt: (x, y, maxSamples) => editApiRef.current?.pickScenePointAt(x, y, maxSamples) ?? null,
      classifyGround: (params) => doClassifyGround(params),
      resetClassification: (from, to) => doResetClassification(from, to),
      resetAttribute: (attr) => doResetAttribute(attr),
      segmentChm: (params) => doSegmentChm(params),
      treeIsolation: (params) => doTreeIsolation(params),
      segmentLi2012: (params) => doSegmentLi2012(params),
      m3c2: (referenceDir, params) => doM3C2(referenceDir, params),
      stemTaper: (clickX, clickY, clickZ, params) => doStemTaper(clickX, clickY, clickZ, params),
      segmentDeadwood: (params) => doSegmentDeadwood(params),
      leafWood: (params) => doLeafWood(params),
      skeletonTransfer: (baselineDir, targetDir, params) => doSkeletonTransfer(baselineDir, targetDir, params),
      hasTreeIds: () => editApiRef.current?.hasTreeIds() ?? false,
      isolateStatus: () => editApiRef.current?.isolateStatus() ?? null,
      maxDeadwoodId: (channel) => editApiRef.current?.maxDeadwoodId(channel) ?? 0,
    };
    onApiReady(api);
    return () => onApiReady(null);
    // `apply` is a stable-enough inline closure; we intentionally rebuild
    // the api when the stable callbacks change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSel, onSave, doExport, onUndo, onRedo, presetView, frameBox, newTree, doClassifyGround, doResetClassification, doResetAttribute, doSegmentChm, doTreeIsolation, doM3C2, doStemTaper, doSegmentDeadwood, doLeafWood, doSkeletonTransfer, onApiReady]);

  return (
    // Dark backdrop so a momentarily blank GL canvas (e.g. a context
    // restore) never flashes the white page behind it.
    <div className="absolute inset-0" style={{ background: 'var(--viewport-bg)' }}>
      {glLost && (
        <div className="absolute inset-0 z-30 flex items-center justify-center" style={{ background: 'rgba(11,13,16,0.94)' }}>
          <div className="mono text-[11px] rounded-lg px-4 py-3" style={{ maxWidth: 460, lineHeight: 1.6, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }}>
            <div style={{ color: '#e6c068', marginBottom: 6 }}>The graphics context was lost.</div>
            <div style={{ color: 'var(--text-mute)' }}>
              Windows reset the display driver — usually because a frame took
              too long while the CPU was saturated. <b style={{ color: 'var(--text)' }}>
              Anything running in the background is still running</b> and still
              writing its checkpoints; only the view died. Your edits are in
              the patch store, not in the view.
            </div>
            {/* A new canvas for the same cloud, first: it is what a change
                of dataset does, and it keeps the project, the dataset and
                every panel as they are. The whole application reloads only
                if that does not hold — and then comes back to this cloud
                rather than to the dataset list. */}
            <button
              className="btn !h-7 mono text-[11px] justify-center"
              style={{ marginTop: 10, width: '100%' }}
              onClick={() => { setGlLost(false); setCanvasEpoch((e) => e + 1); }}
              title="Open a new graphics context for the same cloud. Nothing else changes."
            >
              Recreate the view
            </button>
            <button
              className="btn !h-7 mono text-[11px] justify-center"
              style={{ marginTop: 6, width: '100%', color: 'var(--text-mute)' }}
              onClick={() => { rememberReopen(octree.dir); window.location.reload(); }}
              title="If the view goes dark again: restart the whole application. It reopens this cloud."
            >
              Reload the application
            </button>
          </div>
        </div>
      )}
      {busyStage && RELEASE_CLOUD_FOR.has(busyStage) && !glLost && (
        <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
          <div className="mono text-[11px] rounded-lg px-4 py-3" style={{ maxWidth: 440, lineHeight: 1.6, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text-mute)' }}>
            <div style={{ color: 'var(--text)', marginBottom: 4 }}>
              Point cloud released while the {STAGE_LABEL[busyStage] ?? busyStage} runs.
            </div>
            It frees the viewport's memory for the reconstruction and comes back
            when the stage finishes. Your edits are in the patch store, not in
            the view — nothing unsaved is affected.
          </div>
        </div>
      )}
      {/* One line on how this view draws heights, while there is one to
          say: above ground, or the skeletons moved onto the cloud. */}
      {heights.note && (
        <div
          className="absolute z-20 mono text-[10px] px-2 py-1 rounded pointer-events-none"
          style={{ top: 8, left: '50%', transform: 'translateX(-50%)', maxWidth: '72%', background: 'rgba(11,13,16,0.78)', color: 'var(--text-dim)', border: '1px solid var(--line)' }}
        >
          {heights.note}
        </div>
      )}
      <Canvas
        key={`${octree.dir}#${canvasEpoch}`}
        dpr={[1, 1.5]}
        // STOP RENDERING WHILE THE BACKEND IS SATURATING THE MACHINE.
        //
        // The viewport draws tens of millions of points every frame. With
        // every core busy reconstructing trees a frame can take seconds,
        // and Windows resets a display driver whose operation runs past
        // about two of them — which loses the WebGL context and leaves a
        // black canvas with a live menu bar. That is what six "crashes"
        // were: the backend kept going and kept checkpointing throughout.
        //
        // On 'demand' the scene is drawn only when something asks for it,
        // so the cloud can stay open — which is the realistic way this
        // tool is used — without the GPU being asked to redraw it sixty
        // times a second against a machine that has nothing to spare.
        frameloop={busyStage ? 'demand' : 'always'}
        // near/far scaled to the cloud. A fixed near of 1 mm against a
        // far of hundreds of metres destroys depth-buffer precision, and
        // the EDL pass (which reads depth) then renders white once you
        // zoom in close. Keep far/near to a sane ratio (~4000) so depth
        // stays usable at every zoom level.
        camera={{ position: startCamera, fov: 45, near: Math.max(extent * 0.002, 0.01), far: extent * 8 }}
        onCreated={({ gl }) => {
          gl.setClearColor(viewportBackground(), 1);
        }}
      >
        <ContextLossWatch onLost={() => setGlLost(true)} onRestored={() => setGlLost(false)} />
        <ThemeClearColor />
        <OrbitControls
          ref={orbitRef}
          target={targetVec}
          makeDefault
          enableDamping
          dampingFactor={0.08}
          // Mouse mapping (matches common desktop point-cloud tools):
          //   • Left   → rotate (orbit) around the pivot
          //   • Right  → pan
          //   • Middle → dolly-zoom (drag-zoom, for those who want it)
          //   • Wheel  → zoom, anchored at the cursor (zoomToCursor)
          // In Edit mode a left-drag draws the selection instead (Shift+left
          // still orbits); right-drag panning stays available either way.
          mouseButtons={{
            LEFT: THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.PAN,
          }}
          // Unlimited zoom. We don't clamp the dolly
          // distance; the AdaptiveClip component below rescales the
          // camera near/far every frame from the pivot distance, which
          // keeps depth precision sane at any zoom (this is what made the
          // old fixed clamp unnecessary — the clamp existed only to dodge
          // the near-plane precision crash, now handled properly).
          minDistance={0}
          maxDistance={Infinity}
          zoomToCursor
        />
        <AdaptiveClip orbitRef={orbitRef} extent={extent} />
        <NodeStreamer
          octree={octree}
          display={display}
          filters={filters}
          subsetPreview={subsetPreview}
          cloudVisible={cloudVisible}
          activeTreeId={activeTreeId}
          activeStandingId={activeStandingId}
          activeLayingId={activeLayingId}
          storeRef={storeRef}
          selectionStoreRef={selectionStoreRef}
          storeVersion={storeVersion}
          onSelectionChange={setSelectedCount}
          onStatsChange={onStatsChange}
          editApiRef={editApiRef}
          releasedRef={releasedRef}
          terrain={heights.flattenWith}
          colorTerrain={heights.colorWith}
        />
        <RasterLayers layers={rasterLayers} offset={octree.meta.offset} terrain={heights.flattenWith} />
        {secondaryClouds.map(c => (
          <OverlayCloud
            key={c.id}
            octree={c.octree}
            primaryOffset={octree.meta.offset}
            visible={c.visible}
            color={c.color}
            colorMode={c.colorMode}
            filters={c.syncFilters ? filters : null}
            flatten={display.heightMode === 'above_ground'}
            fallbackTerrain={heights.flattenWith}
          />
        ))}
        <OctreeSelectController
          editMode={editMode && !measuring}
          selectTool={selectTool}
          selectDepth={selectDepth}
          orbitRef={orbitRef}
          editApiRef={editApiRef}
          onAfterSelect={onAfterSelect}
          onEyedrop={onEyedrop}
          cursorRef={cursorRef}
          worldPicker={worldPicker}
          sceneOffset={octree.meta.offset}
        />
        <MeasureController active={measuring} editApiRef={editApiRef} />
        <CenterlineOverlay centerlines={stemCenterlines} offset={octree.meta.offset} terrain={heights.flattenWith} />
        <SkeletonPointsOverlay skeleton={skeletonOverlay} offset={octree.meta.offset} solid={!cloudVisible} zAdjust={heights.skeletonZAdjust} />
        <M3C2PointsOverlay overlay={m3c2Overlay} offset={octree.meta.offset} terrain={heights.flattenWith} />
        <AxisGizmoUpdater dirsRef={gizmoDirsRef} />
        <EdlPass
          enabled={display.edlEnabled}
          strength={display.edlStrength}
          radius={1.5}
        />
      </Canvas>
      {/* Orientation gizmo, bottom-right (CloudCompare-style). Pointer-
          transparent so it never blocks orbiting. */}
      <AxisGizmoOverlay dirsRef={gizmoDirsRef} />
    </div>
  );
}

// ===================== Adaptive near/far ========================

/** Per-frame camera near/far rescale for unlimited zoom (Potree-
 *  style). A fixed near/far either clamps how close you can dolly or
 *  destroys depth precision at the extremes (the latter is what flashed
 *  the EDL pass white). Instead we tie the clip planes to the distance
 *  from the camera to the orbit pivot: near tracks ~2 % of that distance
 *  (so you can dive arbitrarily close), and far covers the pivot plus the
 *  whole cloud span behind it. The ratio stays bounded (≈ a few thousand)
 *  at every zoom, so depth precision — and the EDL depth read — stay
 *  stable from millimetres to the full-cloud overview. */
/** Tells the view when its WebGL context dies, and when it comes back.
 *
 *  A CHILD OF THE CANVAS, NOT A LISTENER LEFT ON IT. The listeners used
 *  to be attached in Canvas.onCreated and never removed — and
 *  react-three-fiber, half a second after a Canvas unmounts, calls
 *  forceContextLoss() on its renderer to hand the GPU its memory back.
 *  The Canvas is keyed by dataset, so every change of point cloud (and
 *  every import, which opens the cloud it made) unmounted one and
 *  fired webglcontextlost on its canvas, into a listener that told the
 *  still-mounted view its context had been lost. It had not: that was
 *  the OLD canvas, being taken down on purpose. The overlay that had
 *  been written for Windows resetting the display driver came up on
 *  every switch and said so.
 *
 *  As an effect the listeners go with the canvas they watch, before
 *  fiber's timer fires; and a loss on a canvas no longer in the
 *  document is ignored anyway, so a teardown by any other route is not
 *  a crash either. preventDefault is what makes a lost context
 *  RESTORABLE — the browser will not fire webglcontextrestored without
 *  it — and on 'demand' nothing would ask for the first frame after a
 *  restore, so it is asked for here. */
/** Keeps the canvas cleared to the theme's background. The clear colour
 *  is set once at creation, so a theme switched while a cloud is open
 *  would otherwise leave the old surface behind the points until the
 *  view was recreated. */
export function ThemeClearColor() {
  const bg = useViewportBackground();
  const { gl, invalidate } = useThree();
  useEffect(() => {
    gl.setClearColor(bg, 1);
    invalidate();
  }, [gl, bg, invalidate]);
  return null;
}

export function ContextLossWatch({ onLost, onRestored }: { onLost: () => void; onRestored: () => void }) {
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const el = gl.domElement;
    const lost = (e: Event) => {
      e.preventDefault();
      if (!el.isConnected) return;
      onLost();
    };
    const restored = () => {
      onRestored();
      invalidate();
    };
    el.addEventListener('webglcontextlost', lost, false);
    el.addEventListener('webglcontextrestored', restored, false);
    return () => {
      el.removeEventListener('webglcontextlost', lost, false);
      el.removeEventListener('webglcontextrestored', restored, false);
    };
  }, [gl, invalidate, onLost, onRestored]);
  return null;
}

export function AdaptiveClip({ orbitRef, extent }: {
  orbitRef: React.RefObject<OrbitControlsImpl | null>;
  extent: number;
}) {
  const { camera } = useThree();
  useFrame(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const ctl = orbitRef.current;
    if (!ctl) return;
    const d = cam.position.distanceTo(ctl.target);
    // near: 2 % of pivot distance, floored so it never hits zero.
    const near = Math.max(d * 0.02, extent * 1e-4, 0.002);
    // far: reach past the pivot by the cloud span so nothing clips when
    // zoomed in close, and grows with the pivot distance when zoomed out.
    const far = d + extent * 3 + near * 10;
    // Only touch the projection matrix when it drifts enough to matter —
    // avoids a matrix rebuild every single frame while idle.
    if (Math.abs(cam.near - near) > near * 0.1 || Math.abs(cam.far - far) > far * 0.1) {
      cam.near = near;
      cam.far = far;
      cam.updateProjectionMatrix();
    }
  });
  return null;
}

// ===================== Selection controller =====================

type ActiveShape =
  | { kind: 'rect'; start: [number, number]; cur: [number, number] }
  | { kind: 'lasso'; pts: [number, number][]; closed: boolean; mode?: 'poly' };

/** In-canvas gesture handler that draws the rect / lasso / polygon and
 *  drives the EditApi. Ported from the in-memory ShapeSelectController so
 *  the octree editor's selection UX is identical: plain drag selects,
 *  Shift+drag orbits, Alt subtracts, Shift+click eyedrops a tree_id, and
 *  polygons close on double-click / Enter / clicking the first vertex.
 *  Only the projection + occlusion math differs — that lives in the
 *  EditApi because the octree's points span many streamed nodes. */
function OctreeSelectController({
  editMode, selectTool, selectDepth, orbitRef, editApiRef, onAfterSelect, onEyedrop, cursorRef,
  worldPicker, sceneOffset,
}: {
  editMode: boolean;
  selectTool: 'rect' | 'lasso' | 'poly';
  selectDepth: 'visible' | 'through';
  orbitRef: React.RefObject<OrbitControlsImpl | null>;
  editApiRef: React.RefObject<EditApi | null>;
  onAfterSelect: () => void;
  /** Shift+click eyedropper — colour-mode-aware. Returns true when it set
   *  an active id (tree or deadwood) so the click is swallowed. */
  onEyedrop: (x: number, y: number) => boolean;
  cursorRef?: React.MutableRefObject<{ x: number; y: number; z: number } | null>;
  /** Virtual-caliper world-picker — when a panel sets it, the next
   *  click here is routed there instead of running the normal tool
   *  action. See the useEffect below. */
  worldPicker?: ((hit: [number, number, number]) => void) | null;
  /** The dataset origin, so the pick can be handed over in survey
   *  coordinates — which is what "world picker" promises and what
   *  every backend command works in. */
  sceneOffset: [number, number, number];
}) {
  const { gl } = useThree();
  const activeRef = useRef<ActiveShape | null>(null);
  const additiveRef = useRef(true);
  const lastClickRef = useRef({ t: 0, x: 0, y: 0 });
  const overlayRef = useRef<{ layer: HTMLElement; svg: SVGSVGElement } | null>(null);

  // SVG overlay over the canvas — pointer-events:none so it never blocks
  // the toolbars or orbit. Mounted only while edit mode is on so the
  // canvas cursor stays the default (camera/grab) in browsing mode.
  useEffect(() => {
    if (!editMode) return;
    const canvas = gl.domElement;
    const parent = canvas.parentElement;
    if (!parent) return;
    const layer = document.createElement('div');
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.cssText = 'position:absolute;inset:0;overflow:visible;';
    layer.appendChild(svg);
    parent.appendChild(layer);
    overlayRef.current = { layer, svg };
    canvas.style.cursor = 'crosshair';
    return () => {
      parent.removeChild(layer);
      overlayRef.current = null;
      canvas.style.cursor = '';
    };
  }, [editMode, gl]);

  const drawShape = useCallback(() => {
    const ov = overlayRef.current;
    if (!ov) return;
    const a = activeRef.current;
    ov.svg.innerHTML = '';
    if (!a) return;
    const stroke = additiveRef.current ? '#7ee0a8' : '#f87171';
    const fill = additiveRef.current ? 'rgba(126,224,168,0.10)' : 'rgba(248,113,113,0.10)';
    if (a.kind === 'rect') {
      const [x1, y1] = a.start, [x2, y2] = a.cur;
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      r.setAttribute('x', String(Math.min(x1, x2))); r.setAttribute('y', String(Math.min(y1, y2)));
      r.setAttribute('width', String(Math.abs(x2 - x1))); r.setAttribute('height', String(Math.abs(y2 - y1)));
      r.setAttribute('fill', fill); r.setAttribute('stroke', stroke);
      r.setAttribute('stroke-width', '1'); r.setAttribute('stroke-dasharray', '4 3');
      ov.svg.appendChild(r);
    } else {
      const pts = a.pts;
      if (pts.length < 2) return;
      const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0] + ',' + p[1]).join(' ');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d + (a.closed ? ' Z' : ''));
      path.setAttribute('fill', fill); path.setAttribute('stroke', stroke);
      path.setAttribute('stroke-width', '1.2'); path.setAttribute('stroke-dasharray', '5 3');
      path.setAttribute('stroke-linejoin', 'round');
      ov.svg.appendChild(path);
      if (a.mode === 'poly') {
        const handlesEnd = a.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < handlesEnd; i++) {
          const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          c.setAttribute('cx', String(pts[i][0])); c.setAttribute('cy', String(pts[i][1]));
          c.setAttribute('r', i === 0 && pts.length >= 3 ? '5' : '3.5');
          c.setAttribute('fill', i === 0 && pts.length >= 3 ? stroke : '#0a110d');
          c.setAttribute('stroke', stroke); c.setAttribute('stroke-width', '1.4');
          ov.svg.appendChild(c);
        }
      }
    }
  }, []);

  const commit = useCallback(() => {
    const a = activeRef.current;
    if (!a) return;
    let shape: SelectShape;
    if (a.kind === 'rect') {
      if (Math.abs(a.cur[0] - a.start[0]) < 3 || Math.abs(a.cur[1] - a.start[1]) < 3) return;
      shape = { kind: 'rect', x0: a.start[0], y0: a.start[1], x1: a.cur[0], y1: a.cur[1] };
    } else {
      if (a.pts.length < 3) return;
      shape = { kind: 'poly', pts: a.pts };
    }
    editApiRef.current?.selectByShape(shape, selectDepth, additiveRef.current ? 'add' : 'sub');
    onAfterSelect();
  }, [selectDepth, editApiRef, onAfterSelect]);

  // Shift+click eyedropper — always active, independent of editMode,
  // matching the in-memory editor's behaviour. Capture phase + stopProp
  // on a hit so the click never reaches OrbitControls; a miss falls
  // through to Shift+drag orbit.
  useEffect(() => {
    const dom = gl.domElement;
    const onPick = (e: PointerEvent) => {
      if (e.button !== 0 || !e.shiftKey) return;
      const r = dom.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      // The eyedropper is colour-mode-aware: in a deadwood channel it
      // picks that channel's id, otherwise the tree id. onEyedrop returns
      // true when it set an active id so the click never reaches orbit.
      if (onEyedrop(x, y)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    // Cursor world-coordinate readout for the status bar. The pick is
    // O(loaded points), so we must never run it during motion — that's
    // what made orbiting lag. Instead we DEBOUNCE: every move resets a
    // timer and only a settled cursor (no movement for ~180 ms, no
    // button held) triggers a single pick. Continuous orbit / drag fires
    // zero picks.
    let settleTimer: number | undefined;
    let buttonsDown = 0;
    const onDownCount = (e: PointerEvent) => { if (e.button === 0 || e.button === 1 || e.button === 2) buttonsDown++; };
    const onUpCount = () => { buttonsDown = Math.max(0, buttonsDown - 1); };
    const onHover = (e: PointerEvent) => {
      if (!cursorRef) return;
      window.clearTimeout(settleTimer);
      const px = e.clientX, py = e.clientY;
      settleTimer = window.setTimeout(() => {
        if (buttonsDown > 0) return; // mid drag/orbit — skip
        const r = dom.getBoundingClientRect();
        cursorRef.current = editApiRef.current?.pickPositionAt(px - r.left, py - r.top) ?? null;
      }, 180);
    };
    dom.addEventListener('pointerdown', onPick, true);
    dom.addEventListener('pointerdown', onDownCount);
    window.addEventListener('pointerup', onUpCount);
    dom.addEventListener('pointermove', onHover);
    return () => {
      window.clearTimeout(settleTimer);
      dom.removeEventListener('pointerdown', onPick, true);
      dom.removeEventListener('pointerdown', onDownCount);
      window.removeEventListener('pointerup', onUpCount);
      dom.removeEventListener('pointermove', onHover);
    };
  }, [gl, editApiRef, onEyedrop, cursorRef]);

  // Rotation pivot. On any left press we drop the orbit
  // pivot onto the surface depth under the cursor so a rotate spins
  // around what you're looking at instead of a distant scene centre
  // ("näkymä kääntyy tosi kaukaa"). The pivot is projected onto the
  // current view axis, so the framing never snaps — only the orbit
  // radius changes. Harmless on a select / measure click (orbit is
  // off there) since the projection leaves the image untouched.
  useEffect(() => {
    const dom = gl.domElement;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const ctl = orbitRef.current;
      if (!ctl) return;
      const r = dom.getBoundingClientRect();
      const hit = editApiRef.current?.pickScenePointAt(e.clientX - r.left, e.clientY - r.top, 120_000);
      if (!hit) return;
      const cam = ctl.object as THREE.PerspectiveCamera;
      const dir = new THREE.Vector3().subVectors(ctl.target, cam.position);
      const len = dir.length();
      if (len < 1e-6) return;
      dir.multiplyScalar(1 / len);
      const depth = new THREE.Vector3(hit[0], hit[1], hit[2]).sub(cam.position).dot(dir);
      if (depth <= 1e-4) return;
      ctl.target.copy(cam.position).addScaledVector(dir, depth);
      ctl.update();
    };
    dom.addEventListener('pointerdown', onDown);
    return () => dom.removeEventListener('pointerdown', onDown);
  }, [gl, orbitRef, editApiRef]);

  // Virtual-caliper / world-picker hook. When a panel sets the
  // `worldPicker` callback the viewport routes the NEXT click (mouse-
  // down + mouse-up within a 5 px tolerance = no drag) to it instead
  // of running its normal tool action. Camera orbit + lasso selection
  // are temporarily suppressed so the click is unambiguous; the cursor
  // becomes a crosshair while picking.
  useEffect(() => {
    if (!worldPicker) return;
    const dom = gl.domElement;
    const prevCursor = dom.style.cursor;
    dom.style.cursor = 'crosshair';
    const prevOrbit = orbitRef.current?.enabled ?? true;
    if (orbitRef.current) orbitRef.current.enabled = false;
    let downX = 0, downY = 0, dragged = false, down = false;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      down = true; dragged = false; downX = e.clientX; downY = e.clientY;
      e.stopPropagation(); e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) dragged = true;
    };
    const onUp = (e: PointerEvent) => {
      if (!down) return;
      down = false;
      if (dragged) return; // a drag means "I changed my mind" — ignore
      const r = dom.getBoundingClientRect();
      // The pick is a SCENE point. It went to the panels as it was, and
      // the caliper, click-to-measure, the scan-inspection viewpoint and
      // the plot-boundary centre all searched survey coordinates for a
      // scene point — "0 points landed", a viewpoint 6 800 km from the
      // cloud. Converted once, here, so no panel can forget to.
      const hit = editApiRef.current?.pickScenePointAt(e.clientX - r.left, e.clientY - r.top, 120_000);
      if (hit) worldPicker(sceneToWorld(hit, sceneOffset));
      e.stopPropagation(); e.preventDefault();
    };
    // Capture phase so we beat the other click handlers (orbit
    // controls, edit lasso, rotation-pivot pick).
    dom.addEventListener('pointerdown', onDown, true);
    dom.addEventListener('pointermove', onMove, true);
    dom.addEventListener('pointerup', onUp, true);
    return () => {
      dom.removeEventListener('pointerdown', onDown, true);
      dom.removeEventListener('pointermove', onMove, true);
      dom.removeEventListener('pointerup', onUp, true);
      dom.style.cursor = prevCursor;
      if (orbitRef.current) orbitRef.current.enabled = prevOrbit;
    };
  }, [worldPicker, gl, editApiRef, sceneOffset]);

  useEffect(() => {
    if (!editMode) return;
    const dom = gl.domElement;
    const toLocal = (e: PointerEvent): [number, number] => {
      const r = dom.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const enableOrbit = (on: boolean) => { if (orbitRef.current) orbitRef.current.enabled = on; };
    const finishPoly = () => {
      const a = activeRef.current;
      if (!a || a.kind !== 'lasso' || a.pts.length < 3) {
        activeRef.current = null; drawShape(); enableOrbit(true); return;
      }
      a.closed = true; drawShape(); commit();
      setTimeout(() => { activeRef.current = null; drawShape(); }, 120);
      enableOrbit(true);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // In edit mode a plain left-drag selects; Shift+drag still orbits
      // so the camera is always reachable, and Shift+click eyedrops the
      // tree id (handled in the always-on pick effect above).
      if (e.shiftKey) return;
      if (selectTool === 'poly') {
        const p = toLocal(e);
        const a = activeRef.current;
        const last = lastClickRef.current;
        const now = performance.now();
        const isDouble = (now - last.t) < 350 && Math.hypot(p[0] - last.x, p[1] - last.y) < 10;
        lastClickRef.current = { t: now, x: p[0], y: p[1] };
        if (!a) {
          enableOrbit(false);
          additiveRef.current = !e.altKey;
          activeRef.current = { kind: 'lasso', pts: [p, p], closed: false, mode: 'poly' };
        } else if (a.kind === 'lasso') {
          if (isDouble && a.pts.length >= 3) {
            a.pts.pop(); if (a.pts.length >= 2) a.pts.pop();
            finishPoly(); e.preventDefault(); e.stopPropagation(); return;
          }
          const first = a.pts[0];
          if (a.pts.length >= 3 && Math.hypot(p[0] - first[0], p[1] - first[1]) < 10) {
            a.pts.pop(); finishPoly(); e.preventDefault(); e.stopPropagation(); return;
          }
          a.pts[a.pts.length - 1] = p; a.pts.push(p);
        }
        drawShape(); e.preventDefault(); e.stopPropagation();
        return;
      }
      enableOrbit(false);
      additiveRef.current = !e.altKey;
      const p = toLocal(e);
      activeRef.current = selectTool === 'rect'
        ? { kind: 'rect', start: p, cur: p }
        : { kind: 'lasso', pts: [p], closed: false };
      drawShape();
      e.preventDefault(); e.stopPropagation();
    };
    const onMove = (e: PointerEvent) => {
      const a = activeRef.current;
      if (!a) return;
      const p = toLocal(e);
      if (a.kind === 'rect') a.cur = p;
      else if (a.mode === 'poly') a.pts[a.pts.length - 1] = p;
      else {
        const last = a.pts[a.pts.length - 1];
        if (!last || Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) > 2) a.pts.push(p);
      }
      drawShape();
    };
    const onUp = () => {
      const a = activeRef.current;
      if (!a) return;
      if (a.kind === 'lasso' && a.mode === 'poly') return; // poly closes via click/Enter
      if (a.kind === 'lasso') a.closed = true;
      drawShape(); commit();
      setTimeout(() => { activeRef.current = null; drawShape(); }, 120);
      enableOrbit(true);
    };
    const onKey = (e: KeyboardEvent) => {
      const a = activeRef.current;
      if (!a) return;
      if (a.kind === 'lasso' && a.mode === 'poly' && (e.key === 'Enter' || e.key === ' ')) {
        finishPoly(); e.preventDefault();
      } else if (e.key === 'Escape') {
        activeRef.current = null; drawShape(); enableOrbit(true);
      } else if (a.kind === 'lasso' && a.mode === 'poly' && (e.key === 'Backspace' || e.key === 'Delete')) {
        if (a.pts.length > 2) { a.pts.splice(a.pts.length - 2, 1); drawShape(); }
        e.preventDefault();
      }
    };
    const onLeave = () => {
      const a = activeRef.current;
      if (a && !(a.kind === 'lasso' && a.mode === 'poly')) {
        activeRef.current = null; drawShape(); enableOrbit(true);
      }
    };
    dom.addEventListener('pointerdown', onDown, true);
    dom.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    dom.addEventListener('pointerleave', onLeave);
    return () => {
      dom.removeEventListener('pointerdown', onDown, true);
      dom.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      dom.removeEventListener('pointerleave', onLeave);
      enableOrbit(true);
    };
  }, [editMode, selectTool, gl, drawShape, commit, orbitRef]);

  return null;
}

// ============================ Measure tool ========================

/** In-scene distance measurement. A click snaps to the nearest visible
 *  point (via the EditApi); two points define a segment drawn as a
 *  depth-test-off line + endpoint dots, with a live screen-space label
 *  showing 3D distance plus horizontal / vertical components. A third
 *  click starts a fresh measurement; Esc clears; a drag still orbits
 *  (we only act on a click that didn't move). All overlay objects are
 *  built imperatively so this never fights R3F's intrinsic-element
 *  typings, matching the SVG selection overlay's style. */
function MeasureController({ active, editApiRef }: {
  active: boolean;
  editApiRef: React.RefObject<EditApi | null>;
}) {
  const { gl, camera, scene, size } = useThree();
  const ptsRef = useRef<THREE.Vector3[]>([]);
  const lineRef = useRef<THREE.Line | null>(null);
  const dotsRef = useRef<THREE.Points | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);

  // Reflect the current point list onto the overlay geometry + draw
  // ranges. Draw range keeps a half-finished measurement (one point)
  // from drawing a stray line to the origin.
  const refresh = useCallback(() => {
    const line = lineRef.current, dots = dotsRef.current, group = groupRef.current;
    if (!line || !dots || !group) return;
    const pts = ptsRef.current;
    const lp = line.geometry.attributes.position as THREE.BufferAttribute;
    const dp = dots.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pts.length && i < 2; i++) {
      dp.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
      lp.setXYZ(i, pts[i].x, pts[i].y, pts[i].z);
    }
    dp.needsUpdate = true;
    lp.needsUpdate = true;
    dots.geometry.setDrawRange(0, Math.min(pts.length, 2));
    line.geometry.setDrawRange(0, pts.length >= 2 ? 2 : 0);
    group.visible = active && pts.length > 0;
    dots.geometry.computeBoundingSphere();
  }, [active]);

  // Build the overlay objects + the HTML label once. Disposed on unmount.
  useEffect(() => {
    const group = new THREE.Group();
    group.renderOrder = 998;
    group.visible = false;

    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    lgeo.setDrawRange(0, 0);
    const lmat = new THREE.LineBasicMaterial({ color: 0xffd24a, depthTest: false, transparent: true });
    const line = new THREE.Line(lgeo, lmat);
    line.frustumCulled = false;
    line.renderOrder = 999;

    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    dgeo.setDrawRange(0, 0);
    const dmat = new THREE.PointsMaterial({ color: 0xffd24a, size: 9, sizeAttenuation: false, depthTest: false, transparent: true });
    const dots = new THREE.Points(dgeo, dmat);
    dots.frustumCulled = false;
    dots.renderOrder = 1000;

    group.add(line);
    group.add(dots);
    scene.add(group);
    groupRef.current = group;
    lineRef.current = line;
    dotsRef.current = dots;

    const parent = gl.domElement.parentElement;
    let label: HTMLDivElement | null = null;
    if (parent) {
      label = document.createElement('div');
      label.style.cssText = [
        'position:absolute', 'pointer-events:none', 'z-index:6', 'display:none',
        'transform:translate(-50%,-150%)', 'white-space:nowrap',
        'padding:3px 8px', 'border-radius:6px',
        'background:rgba(10,16,12,0.92)', 'border:1px solid rgba(255,210,74,0.55)',
        'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
        "font:600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace",
        'color:#ffd24a', 'text-align:center',
      ].join(';');
      parent.appendChild(label);
      labelRef.current = label;
    }

    return () => {
      scene.remove(group);
      lgeo.dispose(); lmat.dispose(); dgeo.dispose(); dmat.dispose();
      if (label && label.parentElement) label.parentElement.removeChild(label);
      groupRef.current = null; lineRef.current = null; dotsRef.current = null; labelRef.current = null;
    };
  }, [scene, gl]);

  // Click handling — only while active. A click that didn't move picks a
  // point; a drag falls through to OrbitControls. Esc clears.
  useEffect(() => {
    if (!active) {
      ptsRef.current = [];
      refresh();
      if (labelRef.current) labelRef.current.style.display = 'none';
      return;
    }
    const dom = gl.domElement;
    dom.style.cursor = 'crosshair';
    let downX = 0, downY = 0, downBtn = -1;
    const onDown = (e: PointerEvent) => { downBtn = e.button; downX = e.clientX; downY = e.clientY; };
    const onUp = (e: PointerEvent) => {
      if (downBtn !== 0) return;
      downBtn = -1;
      if (e.shiftKey) return; // Shift+click stays the tree-id eyedropper
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return; // was an orbit drag
      const r = dom.getBoundingClientRect();
      const hit = editApiRef.current?.pickScenePointAt(e.clientX - r.left, e.clientY - r.top);
      if (!hit) return;
      const v = new THREE.Vector3(hit[0], hit[1], hit[2]);
      const pts = ptsRef.current;
      ptsRef.current = pts.length >= 2 ? [v] : [...pts, v];
      refresh();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { ptsRef.current = []; refresh(); if (labelRef.current) labelRef.current.style.display = 'none'; }
    };
    dom.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      dom.style.cursor = '';
      dom.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [active, gl, editApiRef, refresh]);

  // Per-frame: project the segment midpoint to screen + paint the label.
  useFrame(() => {
    const label = labelRef.current;
    if (!label) return;
    const pts = ptsRef.current;
    if (!active || pts.length < 2) { label.style.display = 'none'; return; }
    const a = pts[0], b = pts[1];
    const mid = a.clone().add(b).multiplyScalar(0.5).project(camera);
    if (mid.z < -1 || mid.z > 1) { label.style.display = 'none'; return; }
    const sx = (mid.x * 0.5 + 0.5) * size.width;
    const sy = (-mid.y * 0.5 + 0.5) * size.height;
    // Scene axes after the source Y/Z swap: x,z horizontal, y up. So the
    // horizontal run is hypot(dx,dz) and the vertical rise is |dy|.
    const d3 = a.distanceTo(b);
    const dh = Math.hypot(b.x - a.x, b.z - a.z);
    const dv = Math.abs(b.y - a.y);
    label.style.display = 'block';
    label.style.left = `${sx}px`;
    label.style.top = `${sy}px`;
    // Decimals follow the precision floor rather than the number type:
    // both endpoints came out of the resident LOD, so a spacing of 5 cm
    // makes the third decimal noise. Three decimals were printed
    // unconditionally, which asserted millimetres for a measurement that
    // moves when you zoom.
    const floor = lastPickSpacing.current;
    const dp = floor == null ? 2 : floor >= 0.1 ? 1 : floor >= 0.01 ? 2 : 3;
    const basis = floor == null ? '' :
      `<div style="font-size:9px;opacity:0.75">±${floor >= 0.01 ? floor.toFixed(2) : floor.toFixed(3)} m point spacing</div>`;
    label.innerHTML =
      `<div style="font-size:13px">${d3.toFixed(dp)} m</div>` +
      `<div style="font-size:9.5px;color:#cdb86a;font-weight:500">↔ ${dh.toFixed(dp)} &nbsp; ↕ ${dv.toFixed(dp)}</div>` +
      basis;
  });

  return null;
}

// ====================== Stem centerline overlay ===================

/** Thin yellow polyline overlay for each tree's TreeQSM trunk
 *  centerline. The panels write the centerlines in WORLD coords; we
 *  apply the decoder's swap-and-negate (sceneX = worldX − offX,
 *  sceneY = worldZ − offZ, sceneZ = −(worldY − offY)) before pushing
 *  them into a single LineSegments buffer so all trees draw in one
 *  draw call regardless of count. */
function CenterlineOverlay({
  centerlines, offset, terrain = null,
}: {
  centerlines?: { trees: Array<{ treeId: number; nodes: Array<{ x: number; y: number; z: number; radius: number }> }> } | null;
  offset: [number, number, number];
  /** The cloud's terrain while heights are shown above ground: the
   *  lines come down with the points they run through. */
  terrain?: TerrainDisplay | null;
}) {
  const { scene } = useThree();
  const lineRef = useRef<THREE.LineSegments | null>(null);
  const matRef = useRef<THREE.LineBasicMaterial | null>(null);

  // Create the persistent overlay object once and dispose on unmount.
  useEffect(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xffd24a, depthTest: false, transparent: true, opacity: 0.95,
    });
    const lines = new THREE.LineSegments(geom, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 997;
    lines.visible = false;
    scene.add(lines);
    lineRef.current = lines;
    matRef.current = mat;
    return () => {
      scene.remove(lines);
      geom.dispose(); mat.dispose();
      lineRef.current = null; matRef.current = null;
    };
  }, [scene]);

  // Repack the position buffer whenever the centreline set changes.
  // LineSegments draws pairs of vertices as line endpoints; for a
  // polyline with N nodes we emit 2·(N−1) vertices (each segment
  // contributes (i, i+1)). World → scene swap-and-negate matches the
  // decoder convention used everywhere else in OctreeView.
  useEffect(() => {
    const lines = lineRef.current;
    if (!lines) return;
    const trees = centerlines?.trees ?? [];
    let nVerts = 0;
    for (const t of trees) {
      if (t.nodes.length >= 2) nVerts += 2 * (t.nodes.length - 1);
    }
    if (nVerts === 0) {
      lines.visible = false;
      const empty = lines.geometry.attributes.position as THREE.BufferAttribute | undefined;
      if (empty && empty.count > 0) {
        lines.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
      }
      return;
    }
    const arr = new Float32Array(nVerts * 3);
    let p = 0;
    for (const t of trees) {
      if (t.nodes.length < 2) continue;
      for (let i = 0; i < t.nodes.length - 1; i++) {
        const a = t.nodes[i];
        const b = t.nodes[i + 1];
        // World → scene swap-and-negate (same as decodeNodePoints).
        arr[p++] = a.x - offset[0];
        arr[p++] = a.z - (terrain ? terrain.shift(a.x, a.y) : 0) - offset[2];
        arr[p++] = -(a.y - offset[1]);
        arr[p++] = b.x - offset[0];
        arr[p++] = b.z - (terrain ? terrain.shift(b.x, b.y) : 0) - offset[2];
        arr[p++] = -(b.y - offset[1]);
      }
    }
    lines.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    lines.geometry.computeBoundingSphere();
    lines.visible = true;
  }, [centerlines, offset, terrain]);

  return null;
}

// ====================== Skeleton points overlay ===================

/** Per-cylinder skeleton sample points as a single THREE.Points
 *  cloud — small fuchsia-vs-amber dots coloured by branch_order
 *  (0 = trunk → fuchsia, ≥ 1 = branch → amber). Depth-test ON so
 *  the dots sit naturally inside the cloud rather than ghosting
 *  through. Pushed by the Skeleton Transfer panel; cleared with the
 *  panel's Clear button. */
export function SkeletonPointsOverlay({
  skeleton, offset, solid = false, zAdjust = null,
}: {
  skeleton?: { origin: [number, number, number]; xyz: Float32Array; treeId: Int32Array; order: Uint8Array; radiusMm: Uint16Array; colorMode: 'tree' | 'class' | 'radius'; alignment?: { dx: number; dy: number; theta: number; cx: number; cy: number } | null } | null;
  offset: [number, number, number];
  /** True when the skeletons stand alone (the cloud is hidden): then
   *  they are drawn as solid geometry, depth-tested and depth-written,
   *  so a tree in front hides the tree behind it and the EDL pass
   *  shades them. False draws them INSIDE the cloud, over it, as
   *  before — see the material below for why that is depth-free. */
  solid?: boolean;
  /** Added to each point's world z before it is drawn: the move onto the
   *  cloud's height frame, and the terrain off it while heights are shown
   *  above ground — see three/useTerrain.ts. Null draws the stored z. */
  zAdjust?: ZAdjust | null;
}) {
  const { scene } = useThree();
  const pointsRef = useRef<THREE.Points | null>(null);

  useEffect(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(0), 3, true));
    const mat = new THREE.PointsMaterial({
      size: 2.4, sizeAttenuation: false, vertexColors: true,
      // depthTest FALSE, like every other overlay that is drawn inside
      // the cloud rather than on it — the centreline lines and dots and
      // the measurement lines all do the same.
      //
      // A skeleton is the tree's axis, so it is by construction INSIDE
      // the stem, wrapped in the cloud's own surface points. With depth
      // testing on, those points win every pixel and the skeleton is
      // invisible: "Load & show" appeared to do nothing, and the only
      // way to see a skeleton was to export it and re-import it as a
      // cloud of its own.
      //
      // ALONE, THE OPPOSITE. With the cloud hidden there is nothing to
      // see through, and depth-free points draw in array order: the
      // tree at the back paints over the tree at the front, and turning
      // the plot showed every tree through every other. The `solid`
      // effect below switches the same material to depth-tested,
      // depth-written and opaque for that case.
      depthTest: false, transparent: true, opacity: 0.95,
    });
    const pts = new THREE.Points(geom, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 996;
    pts.visible = false;
    scene.add(pts);
    pointsRef.current = pts;
    return () => {
      scene.remove(pts);
      geom.dispose(); mat.dispose();
      pointsRef.current = null;
    };
  }, [scene]);

  useEffect(() => {
    const pts = pointsRef.current;
    if (!pts) return;
    const mat = pts.material as THREE.PointsMaterial;
    mat.depthTest = solid;
    mat.depthWrite = solid;
    mat.transparent = !solid;
    mat.opacity = solid ? 1 : 0.95;
    // A little larger on their own: there is no cloud to read the
    // structure from, only the dots.
    mat.size = solid ? 3.0 : 2.4;
    mat.needsUpdate = true;
  }, [solid]);

  useEffect(() => {
    const pts = pointsRef.current;
    if (!pts) return;
    if (!skeleton || skeleton.treeId.length === 0) {
      pts.visible = false;
      return;
    }
    const n = skeleton.treeId.length;
    const pos = new Float32Array(n * 3);
    // Colours as normalised bytes: a skeleton is tens of millions of
    // points, and three floats per point for a colour that has 256
    // levels anyway was 12 bytes where 3 do, in memory and on the GPU.
    const col = new Uint8Array(n * 3);
    // World → scene swap-and-negate (same decoder convention as the
    // cloud + centreline overlay).
    // World = origin + relative, in doubles, BEFORE the scene offset is
    // taken off: the payload's f32s are relative to the cache's origin
    // because a world f32 at a projected easting is on a quarter-metre
    // lattice, which is what drew every skeleton as vertical dashes.
    const [ox, oy, oz] = skeleton.origin;
    const mode = skeleton.colorMode ?? 'tree';
    // Onto the cloud's trees: the alignment, in the origin's frame,
    // before the origin goes on — see SkeletonOverlay.alignment.
    const al = skeleton.alignment ?? null;
    const sinT = al ? Math.sin(al.theta) : 0;
    const cosT = al ? Math.cos(al.theta) : 1;
    // Radius ramp: log scale from 3 mm (dark blue) through green to
    // 60 cm (yellow) — a stem and a twig differ by two orders of
    // magnitude, which a linear ramp would draw as "everything thin".
    const LOG_MIN = Math.log(3), LOG_MAX = Math.log(600);
    for (let i = 0; i < n; i++) {
      let rx = skeleton.xyz[i * 3];
      let ry = skeleton.xyz[i * 3 + 1];
      if (al) {
        const px = rx - al.cx, py = ry - al.cy;
        rx = al.cx + cosT * px - sinT * py + al.dx;
        ry = al.cy + sinT * px + cosT * py + al.dy;
      }
      const wx = ox + rx;
      const wy = oy + ry;
      const wz = oz + skeleton.xyz[i * 3 + 2];
      pos[i * 3] = wx - offset[0];
      pos[i * 3 + 1] = (zAdjust ? wz + zAdjust(wx, wy) : wz) - offset[2];
      pos[i * 3 + 2] = -(wy - offset[1]);
      if (mode === 'class') {
        // The transfer's semantic class: stem (order 0) warm, branch green.
        if (skeleton.order[i] === 0) { col[i * 3] = 235; col[i * 3 + 1] = 120; col[i * 3 + 2] = 60; }
        else { col[i * 3] = 110; col[i * 3 + 1] = 205; col[i * 3 + 2] = 120; }
      } else if (mode === 'radius') {
        const mm = Math.max(1, skeleton.radiusMm ? skeleton.radiusMm[i] : 1);
        const t = Math.min(1, Math.max(0, (Math.log(mm) - LOG_MIN) / (LOG_MAX - LOG_MIN)));
        // Two-segment ramp: blue → green → yellow.
        if (t < 0.5) {
          const u = t * 2;
          col[i * 3] = 30 + 40 * u; col[i * 3 + 1] = 60 + 150 * u; col[i * 3 + 2] = 200 - 110 * u;
        } else {
          const u = (t - 0.5) * 2;
          col[i * 3] = 70 + 185 * u; col[i * 3 + 1] = 210 + 30 * u; col[i * 3 + 2] = 90 - 60 * u;
        }
      } else {
        // THE VIEWPORT'S OWN TREE-ID PALETTE, so a skeleton is the colour
        // of the tree it was built from — and, after a transfer, of the
        // target points that inherited its id. It used to hash the id to
        // a hue of its own, and the same tree was one colour as points
        // and another as skeleton. Darkened by branch order so stem
        // samples read brighter than branch samples: order 0 → 1.0,
        // ≥ 1 → 0.62.
        const tid = skeleton.treeId[i] | 0;
        const [r, g, b] = tid <= 0 ? UNASSIGNED_RGB : treeIdColor(tid);
        const bright = skeleton.order[i] === 0 ? 1.0 : 0.62;
        col[i * 3] = r * bright;
        col[i * 3 + 1] = g * bright;
        col[i * 3 + 2] = b * bright;
      }
    }
    pts.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pts.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    pts.geometry.computeBoundingSphere();
    pts.visible = true;
  }, [skeleton, offset, zAdjust]);

  return null;
}

/** M3C2 change overlay — one colored dot per core point. Diverging ramp:
 *  significant growth → red, significant loss → blue (magnitude scaled by
 *  |distance| / maxAbs), within-noise → dim grey, undefined → dimmer grey.
 *  Coords arrive already relative to the active offset, so only the scene
 *  swap-and-negate is applied (no offset subtraction). */
function M3C2PointsOverlay({
  overlay, offset, terrain = null,
}: {
  overlay?: { xyz: Float32Array; distance: Float32Array; significant: Uint8Array; maxAbs: number } | null;
  /** The active offset the coords are relative to — only needed to find
   *  the terrain under a point. */
  offset: [number, number, number];
  /** The cloud's terrain while heights are shown above ground. */
  terrain?: TerrainDisplay | null;
}) {
  const { scene } = useThree();
  const pointsRef = useRef<THREE.Points | null>(null);

  useEffect(() => {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(0), 3));
    const mat = new THREE.PointsMaterial({
      size: 3.0, sizeAttenuation: false, vertexColors: true,
      depthTest: true, transparent: true, opacity: 0.95,
    });
    const pts = new THREE.Points(geom, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 997;
    pts.visible = false;
    scene.add(pts);
    pointsRef.current = pts;
    return () => {
      scene.remove(pts);
      geom.dispose(); mat.dispose();
      pointsRef.current = null;
    };
  }, [scene]);

  useEffect(() => {
    const pts = pointsRef.current;
    if (!pts) return;
    if (!overlay || overlay.distance.length === 0) {
      pts.visible = false;
      return;
    }
    const n = overlay.distance.length;
    const inv = 1 / Math.max(overlay.maxAbs, 1e-4);
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    // Diverging ramp endpoints (match the panel's histogram legend).
    const NEU = [0.60, 0.60, 0.62];
    const BLUE = [0.357, 0.545, 0.816]; // #5b8bd0 — loss / lower
    const RED = [0.816, 0.420, 0.420];  // #d06b6b — growth / higher
    for (let i = 0; i < n; i++) {
      // Offset-relative coords → scene swap-and-negate (x, z, −y).
      const rx = overlay.xyz[i * 3];
      const ry = overlay.xyz[i * 3 + 1];
      const rz = overlay.xyz[i * 3 + 2];
      pos[i * 3] = rx;
      pos[i * 3 + 1] = terrain ? rz - terrain.shift(rx + offset[0], ry + offset[1]) : rz;
      pos[i * 3 + 2] = -ry;
      const d = overlay.distance[i];
      let r: number, g: number, b: number;
      if (!Number.isFinite(d)) {
        r = 0.26; g = 0.26; b = 0.28; // undefined — recede
      } else if (overlay.significant[i] === 0) {
        r = 0.40; g = 0.40; b = 0.42; // measured, within noise
      } else {
        // Significant: lerp NEU → RED / BLUE. Floor the magnitude so a
        // just-significant change still reads as colored, not grey.
        let t = d * inv;
        if (t > 1) t = 1; else if (t < -1) t = -1;
        const mag = Math.max(Math.abs(t), 0.4);
        const tgt = t >= 0 ? RED : BLUE;
        r = NEU[0] + mag * (tgt[0] - NEU[0]);
        g = NEU[1] + mag * (tgt[1] - NEU[1]);
        b = NEU[2] + mag * (tgt[2] - NEU[2]);
      }
      col[i * 3] = r;
      col[i * 3 + 1] = g;
      col[i * 3 + 2] = b;
    }
    pts.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pts.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    pts.geometry.computeBoundingSphere();
    pts.visible = true;
  }, [overlay, offset, terrain]);

  return null;
}

// ============================ Streamer ===========================

/** A viewport and budget to plan for instead of the canvas's own.
 *
 *  The Compare view's export renders a pane offscreen at the figure's
 *  size — 2400 × 1800 by default, against a pane a few hundred pixels
 *  high — and at the FULL point budget rather than the half a live pane
 *  streams with. Planned for the screen, the export would be the
 *  screen's LOD blown up: sparse in print. With this set, the planner
 *  admits nodes by the export's pixel size and budget, the point size
 *  follows the export's height, and the pane redraws for the screen
 *  when it is cleared. */
export interface PlanOverride {
  width: number;
  height: number;
  pointBudget: number;
  /** On-screen pixel size for the points while the override holds. */
  pointSize: number;
}

/** The display's point size as the shader gets it: whole pixels, one to
 *  twelve. */
function clampPointSize(s: number): number {
  return Math.max(1, Math.min(12, s || 1));
}

interface StreamerProps {
  octree: OpenOctree;
  display: DisplayConfig;
  filters: FilterConfig;
  subsetPreview?: SubsetPreview | null;
  cloudVisible: boolean;
  activeTreeId: number;
  activeStandingId: number;
  activeLayingId: number;
  storeRef: React.MutableRefObject<PatchStore>;
  selectionStoreRef: React.MutableRefObject<Map<PatchNodeKey, Set<number>>>;
  storeVersion: number;
  onSelectionChange: (n: number) => void;
  onStatsChange: (s: ViewerStats) => void;
  editApiRef: React.MutableRefObject<EditApi | null>;
  /** True while a heavy backend stage has the point set released. Read
   *  once, at mount, so a streamer created during such a stage starts
   *  paused instead of streaming the cloud the stage was meant to be
   *  spared. */
  releasedRef: React.MutableRefObject<boolean>;
  /** See PlanOverride. Optional: the editor's own viewport never sets it. */
  planOverrideRef?: React.MutableRefObject<PlanOverride | null>;
  /** The cloud's terrain while heights are shown above ground — every
   *  point is drawn at its stored height less the ground under it. Null
   *  draws the stored heights. See three/terrainGrid.ts. */
  terrain?: TerrainDisplay | null;
  /** The cloud's terrain for the 'height' colour ramp to run over
   *  height above ground; null ramps over the stored z. */
  colorTerrain?: TerrainDisplay | null;
}

/** Point spacing of the LOD node the last viewport pick answered from,
 *  or null when nothing was hit.
 *
 *  Module-scoped because the pick lives in NodeStreamer and the measure
 *  overlay is a sibling component; there is exactly one streamer at a
 *  time, so a single handle is honest rather than a shortcut. It exists
 *  because picking only ever sees nodes currently streamed in: a
 *  measured distance is between two points of whatever detail level
 *  happens to be resident, which changes as the camera moves. Printing
 *  millimetres off that is the format's precision, not the
 *  measurement's.
 */
const lastPickSpacing: { current: number | null } = { current: null };

export function NodeStreamer({
  octree, display, filters, subsetPreview, cloudVisible, activeTreeId, activeStandingId, activeLayingId, storeRef, selectionStoreRef, storeVersion,
  onSelectionChange, onStatsChange,
  editApiRef, releasedRef, planOverrideRef, terrain, colorTerrain,
}: StreamerProps) {
  const { camera, scene, size, gl } = useThree();
  const groupRef = useRef<THREE.Group>(new THREE.Group());
  // Whole-cloud per-axis spans in SCENE coords, so the height / X / Y
  // ramps run ONCE edge-to-edge across the dataset instead of
  // re-stretching to each tile's local slab. The per-node fallback in
  // refreshNodeColors made the X / Y ramps band per tile (the cloud
  // looked striped in several intervals — that was the report) and
  // produced a per-tile look on `height` too before this was fixed.
  // Scene axes:
  //   sceneX = source X   (east)
  //   sceneY = source Z   (up)
  //   sceneZ = −(source Y − offsetY)   → ramp over [-(maxY-offY), -(minY-offY)]
  // The axis swap is decodeNodePoints's right-handed remap.
  const heightSpan = useMemo<HeightSpan>(() => {
    const off = octree.meta.offset;
    const box = octree.meta.boundingBox;
    // Over height above ground: from the ground up to the cloud's top
    // over the LOWEST ground — the most any point can stand over the
    // ground under it. A ramp that never reaches its top on a slope is
    // the price of not sweeping every point for the exact maximum.
    if (colorTerrain) {
      const t = colorTerrain;
      return {
        lo: 0,
        hi: Math.max(box.max[2] - t.groundRange[0], 1),
        shift: (sx, sz) => t.ground(sx + off[0], off[1] - sz) - off[2],
      };
    }
    return { lo: box.min[2] - off[2], hi: box.max[2] - off[2] };
  }, [octree.meta.boundingBox, octree.meta.offset, colorTerrain]);
  const heightSpanRef = useRef(heightSpan);
  useEffect(() => {
    heightSpanRef.current = heightSpan;
    sharedUniformsRef.current.heightSpan = heightSpan;
  }, [heightSpan]);
  const xSpan = useMemo<{ lo: number; hi: number }>(() => ({
    lo: octree.meta.boundingBox.min[0] - octree.meta.offset[0],
    hi: octree.meta.boundingBox.max[0] - octree.meta.offset[0],
  }), [octree.meta.boundingBox, octree.meta.offset]);
  const ySpan = useMemo<{ lo: number; hi: number }>(() => {
    const lo = -(octree.meta.boundingBox.max[1] - octree.meta.offset[1]);
    const hi = -(octree.meta.boundingBox.min[1] - octree.meta.offset[1]);
    return { lo, hi };
  }, [octree.meta.boundingBox, octree.meta.offset]);
  const xSpanRef = useRef(xSpan);
  const ySpanRef = useRef(ySpan);
  useEffect(() => { xSpanRef.current = xSpan; }, [xSpan]);
  useEffect(() => { ySpanRef.current = ySpan; }, [ySpan]);
  // Cloud-wide intensity span, from the converter's recorded
  // metadata.intensityRange (see octree.rs write_metadata /
  // octree_intensity_range). Unlike height/x/y this has no bounding-box
  // fallback to derive from — absent metadata means the range genuinely
  // isn't known yet (a legacy dataset, or one whose intensity had no
  // usable spread), and colorNode falls back to its old per-node
  // normalisation in that case instead of pretending a span exists.
  const intensitySpan = useMemo<{ lo: number; hi: number } | null>(() => (
    octree.meta.intensityRange
      ? { lo: octree.meta.intensityRange[0], hi: octree.meta.intensityRange[1] }
      : null
  ), [octree.meta.intensityRange]);
  const intensitySpanRef = useRef(intensitySpan);
  useEffect(() => { intensitySpanRef.current = intensitySpan; }, [intensitySpan]);
  // Cloud-wide range per extra column. Starts from the converter's
  // metadata.extras (observed min/max), and a user-set override from
  // display.extraRangeOverrides wins for that column — letting the user
  // squeeze the ramp into a sub-range when outliers compress the useful
  // band. Empty when the dataset has no extras (v1 / v2, or v3 imported
  // without extras).
  const extraRanges = useMemo<Record<string, { lo: number; hi: number }>>(() => {
    const out: Record<string, { lo: number; hi: number }> = {};
    for (const e of octree.meta.extras ?? []) {
      out[e.name] = { lo: e.min, hi: e.max };
    }
    for (const [name, r] of Object.entries(display.extraRangeOverrides ?? {})) {
      if (Number.isFinite(r.lo) && Number.isFinite(r.hi) && r.hi > r.lo) {
        out[name] = { lo: r.lo, hi: r.hi };
      }
    }
    return out;
  }, [octree.meta.extras, display.extraRangeOverrides]);
  const extraRangesRef = useRef(extraRanges);
  useEffect(() => { extraRangesRef.current = extraRanges; }, [extraRanges]);
  /** Loaded nodes keyed by their record index in oct.records / oct.index. */
  const loadedRef = useRef<Map<number, LoadedNode>>(new Map());
  /** In-flight loads keyed by recIdx so we don't double-fetch. */
  const inFlightRef = useRef<Set<number>>(new Set());
  /** Decoded nodes waiting to be added to the scene. Drained at most
   *  LOADED_TO_GPU_PER_FRAME entries per frame so a burst of completed
   *  loads can't hitch the main thread with geometry creation. */
  const pendingGpuRef = useRef<LoadedNode[]>([]);
  /** Visible set after the last plan: record indices the planner chose
   *  to render. Synced onto Points.visible every frame. */
  const visibleSetRef = useRef<Set<number>>(new Set());
  /** Load queue, descending weight order (latest plan output). */
  const loadQueueRef = useRef<Array<{ rec: number; weight: number }>>([]);
  const loadedPointsRef = useRef(0);
  const frameRef = useRef(0);
  // Set through EditApi.setStreamingPaused while a heavy backend stage
  // runs; the planner below does nothing while it is up. Starts up if
  // the stage began before this streamer existed.
  const streamPausedRef = useRef(releasedRef.current);
  const lastPlanAt = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const fpsRef = useRef(0);
  // Camera motion estimate for the predictive prefetch: position at the
  // previous plan + an EMA-smoothed velocity (scene units / s). The
  // planner extrapolates the camera PREFETCH_LOOKAHEAD_S ahead along
  // this velocity and pre-queues the tiles that view will need.
  const prevCamRef = useRef<{ x: number; y: number; z: number; t: number } | null>(null);
  const camVelRef = useRef(new THREE.Vector3());
  // Deep-selection bookkeeping. A paint selection ALSO tests the points
  // that aren't streamed in (fetched from disk, geometry only), so what
  // the user selects is the full-resolution cloud — not whatever subset
  // the LOD happened to draw. gen invalidates in-flight passes when the
  // selection is cleared; pending counts running passes; pendingReapply
  // holds an edit action applied mid-pass so late-found points get the
  // same assignment instead of staying silently unlabelled.
  const deepSelGenRef = useRef(0);
  /** Cache generation. Bumped whenever what is on disk stops matching
   *  what is cached — a dataset reopen, or reloadNodes() after a native
   *  command rewrote octree.bin. A load that finishes carrying an older
   *  generation was decoded from bytes that are gone, and is dropped
   *  rather than published. */
  const loadGenRef = useRef(0);
  const deepSelPendingRef = useRef(0);
  const deepSelReapplyRef = useRef<{
    treeId?: number; semantic?: 0 | 1 | 2 | 3; deleted?: 0 | 1 | 2;
    standingDeadwood?: number; layingDeadwood?: number;
  } | null>(null);
  const displayRef = useRef(display);
  displayRef.current = display;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // Subset preview clip — kept in a ref so the per-node masking can read
  // the latest box without rebuilding the planner closures.
  const subsetPreviewRef = useRef(subsetPreview ?? null);
  subsetPreviewRef.current = subsetPreview ?? null;
  /** Shared per-frame uniforms — every per-node material references
   *  these via object identity so one assignment updates all draws. */
  const sharedUniformsRef = useRef<SharedShaderUniforms>(createSharedUniforms());
  // Keep the shared render-state's active tree id + highlight colour in
  // sync so loaders + colourers (incl. freshly-streamed nodes) match.
  sharedUniformsRef.current.activeTreeId = activeTreeId;
  sharedUniformsRef.current.activeStandingId = activeStandingId;
  sharedUniformsRef.current.activeLayingId = activeLayingId;
  const activeRgb = useMemo(() => hexToRgb(display.activeTreeColor), [display.activeTreeColor]);
  sharedUniformsRef.current.activeTreeRgb = activeRgb;
  const unlabeledRgb = useMemo(() => hexToRgb(display.unlabeledColor), [display.unlabeledColor]);
  sharedUniformsRef.current.unlabeledRgb = unlabeledRgb;

  // Tree-id merge overlay. Raw { from → to } pairs live here; the
  // flattened version is mirrored onto shared.remap so freshly-streamed
  // nodes fold their ids on load. Bumping remapVersion re-folds every
  // already-loaded node.
  const remapRawRef = useRef<Map<number, number>>(new Map());
  const [remapVersion, setRemapVersion] = useState(0);

  // Rebuild one node from its pristine decoded state: replay patches,
  // fold the merge overlay, recolour, re-mask filters. The single path
  // every refresh (undo, edit, merge) funnels through so the node's
  // tree ids / colours / visibility always agree. Uses only refs, so
  // its identity is stable.
  const refreshNode = useCallback((ln: LoadedNode): void => {
    const store = storeRef.current;
    ln.positions.set(ln.originalPositions);
    ln.treeIds.set(ln.originalTreeIds);
    // Semantic resets to the file's imported labels (zeros for
    // unsegmented imports), not to all zeros — otherwise undoing an edit
    // on a pre-segmented cloud would wipe the source labels.
    if (!ln.semantic) ln.semantic = new Uint8Array(ln.treeIds.length);
    ln.semantic.set(ln.originalSemantic);
    if (ln.deleted) ln.deleted.fill(0); else ln.deleted = new Uint8Array(ln.treeIds.length);
    // Deadwood ids reset to their pristine decoded values (zeros for a
    // freshly imported cloud), then patches re-impose any edits.
    if (ln.standingDeadwood && ln.originalStandingDeadwood) ln.standingDeadwood.set(ln.originalStandingDeadwood);
    if (ln.layingDeadwood && ln.originalLayingDeadwood) ln.layingDeadwood.set(ln.originalLayingDeadwood);
    const key = patchNodeKey(ln.tile, ln.record);
    const entries = store.map.get(key);
    applyToNode(ln.treeIds, ln.semantic, ln.deleted, ln.positions, ln.originalPositions, entries, ln.standingDeadwood, ln.layingDeadwood);
    applyRemapInPlace(ln.treeIds, sharedUniformsRef.current.remap);
    {
      const su = sharedUniformsRef.current;
      colorNode(ln, displayRef.current.colorMode, displayRef.current.ramp, { tree: su.activeTreeId, standing: su.activeStandingId, laying: su.activeLayingId }, su.activeTreeRgb, heightSpanRef.current, extraRangesRef.current, su.unlabeledRgb, { x: xSpanRef.current, y: ySpanRef.current }, intensitySpanRef.current ?? undefined);
    }
    // A tree_id edit / merge can flip the filter result (isolate / range
    // / hide-unassigned all key on tree_id), so re-mask after folding.
    ln.filterPass = applyFilters(ln, filtersRef.current, octree.meta.offset);
    applyPreviewClip(ln, subsetPreviewRef.current, octree.meta.offset);
    // Live positions changed (delete / unhide replay) — re-encode the
    // quantised GPU copy before flagging the upload.
    syncQuantizedPositions(ln);
    if (ln.geom) {
      (ln.geom.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (ln.geom.attributes.color as THREE.BufferAttribute).needsUpdate = true;
      const va = ln.geom.attributes.aVisible as THREE.BufferAttribute | undefined;
      if (va) va.needsUpdate = true;
    }
  }, [storeRef]);

  // Point-cloud visibility — the Layers panel can hide the whole cloud
  // to inspect a raster surface on its own. Group-level toggle.
  useEffect(() => { groupRef.current.visible = cloudVisible; }, [cloudVisible]);

  // Point size — drive the shared uSize uniform every node material reads.
  // Absolute on-screen pixel size (fixed-dot look). Mutating the uniform's
  // .value is enough (the render loop reads it each frame); no per-node
  // re-upload needed. Clamped to a sane pixel range.
  useEffect(() => {
    sharedUniformsRef.current.uSize.value = clampPointSize(display.pointSize);
  }, [display.pointSize]);

  // Heights above ground: the terrain into the shared uniforms every node
  // material samples, and into the ref the CPU-side projections (select,
  // pick) read, so a click lands on the point where it is drawn. Without
  // a terrain the sampler goes back to the 1 × 1 zero texture rather than
  // staying on one the owner has disposed — Three would re-upload that
  // on the next draw.
  const terrainRef = useRef<TerrainDisplay | null>(null);
  terrainRef.current = terrain ?? null;
  const emptyDtmRef = useRef<THREE.Texture>(sharedUniformsRef.current.uDtm.value);
  useEffect(() => () => { emptyDtmRef.current.dispose(); }, []);
  useEffect(() => {
    const su = sharedUniformsRef.current;
    const off = octree.meta.offset;
    if (terrain) {
      su.uFlatten.value = 1;
      su.uDtm.value = terrain.texture;
      su.uDtmOrigin.value.set(terrain.grid.minX - off[0], terrain.grid.minY - off[1]);
      su.uDtmCell.value = terrain.grid.cell;
      su.uDtmSize.value.set(terrain.grid.cols, terrain.grid.rows);
      su.relief = terrain.relief;
    } else {
      su.uFlatten.value = 0;
      su.uDtm.value = emptyDtmRef.current;
      su.relief = 0;
    }
  }, [terrain, octree.meta.offset]);
  // Whether the last frame ran under a PlanOverride, so the frame after
  // it lifts puts the display's point size back (the effect above only
  // runs when the display changes).
  const overrideWasOnRef = useRef(false);

  // Hydrate one lazily-skipped extra column on every node in `nodes` by
  // re-reading each node's block and decoding just that column, then run
  // `after` (recolour) as each lands. loadNode only materialises the
  // extras in active use, so switching the colour mode to a not-yet-
  // decoded extra funnels through here. Reads run a few at a time; nodes
  // evicted mid-flight are skipped.
  const hydrateExtraColumn = useCallback(async (
    nodes: LoadedNode[], name: string, after: (ln: LoadedNode) => void,
  ): Promise<void> => {
    const k = (octree.meta.extras ?? []).findIndex(e => e.name === name);
    if (k < 0) return;
    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < nodes.length) {
        const ln = nodes[i++];
        if (!loadedRef.current.has(ln.recIdx)) continue; // evicted meanwhile
        if (ln.extras[name]) { after(ln); continue; }     // raced another hydrate
        try {
          const r = octree.records[ln.recIdx];
          ln.extras[name] = await readExtraColumn(
            octree.dir, r.byteOffset, r.byteSize, octree.meta.pointBytes, k,
          );
          after(ln);
        } catch (e) {
          console.warn(`hydrate extra '${name}' rec=${ln.recIdx} failed`, e);
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }, [octree]);

  // Recolour every loaded node when the colour mode, ramp, custom-ramp
  // colours, the active tree, the highlight colour, or any per-extra
  // range override changes. The custom ramp's stops are pushed to the
  // module-level resolver first so the repaint below picks them up.
  // When the new mode ramps over an extra column some nodes haven't
  // decoded (lazy extras), they paint the flat fallback first and
  // recolour as the hydration lands — progressive, never blocking.
  useEffect(() => {
    setCustomRampStops(display.customRamp[0], display.customRamp[1]);
    // Reads colour state through the refs so the async hydration path
    // always paints with whatever is CURRENT when it completes, not what
    // was active when the effect fired.
    const recolor = (ln: LoadedNode): void => {
      const su = sharedUniformsRef.current;
      colorNode(ln, displayRef.current.colorMode, displayRef.current.ramp, { tree: su.activeTreeId, standing: su.activeStandingId, laying: su.activeLayingId }, su.activeTreeRgb, heightSpanRef.current, extraRangesRef.current, su.unlabeledRgb, { x: xSpanRef.current, y: ySpanRef.current }, intensitySpanRef.current ?? undefined);
      const ca = ln.geom?.attributes.color as THREE.BufferAttribute | undefined;
      if (ca) ca.needsUpdate = true;
    };
    const mode = display.colorMode;
    const extraName = typeof mode === 'string' && mode.startsWith('extra:') ? mode.slice('extra:'.length) : null;
    const missing: LoadedNode[] = [];
    for (const ln of loadedRef.current.values()) {
      recolor(ln);
      if (extraName && !ln.extras[extraName]) missing.push(ln);
    }
    if (extraName && missing.length > 0) void hydrateExtraColumn(missing, extraName, recolor);
  }, [display.colorMode, display.ramp, display.customRamp, activeTreeId, activeStandingId, activeLayingId, activeRgb, unlabeledRgb, extraRanges, hydrateExtraColumn, heightSpan]);

  // Load the merge overlay (treemap.json) when the dataset changes, then
  // re-fold via the remapVersion bump below.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const raw = await readTreemap(octree.dir);
      if (cancelled) return;
      remapRawRef.current = raw;
      sharedUniformsRef.current.remap = flattenRemap(raw);
      setRemapVersion(v => v + 1);
    })();
    return () => { cancelled = true; };
  }, [octree.dir]);

  // Re-fold every loaded node when the merge overlay changes.
  useEffect(() => {
    for (const ln of loadedRef.current.values()) refreshNode(ln);
  }, [remapVersion, refreshNode]);

  // Re-mask every loaded node when the filter config changes. Filters
  // are evaluated against the *current* (post-edit) tree_ids and
  // classifications, so isolating a tree always reflects the latest
  // assignments. Cheap per node — a single linear pass writing one
  // float per point — so even with millions loaded this is sub-ms.
  //
  // We also fold in any nodes still in the pendingGpu queue (loaded but
  // not yet uploaded). They're already in `loaded` so they get hit by
  // the main iteration; the explicit pass is belt-and-suspenders so a
  // node mid-upload can't slip through with stale visibility.
  useEffect(() => {
    const off = octree.meta.offset;
    // Returns the pass count from applyFilters so the loops below can
    // tally it; applyPreviewClip runs AFTER and can hide MORE points on
    // top (the Subset panel's drag preview), but that's a separate,
    // transient tool — the tally is about the FILTERS only, so preview
    // clipping is deliberately excluded from it.
    const apply = (ln: LoadedNode): number => {
      const pass = applyFilters(ln, filters, off);
      ln.filterPass = pass;
      applyPreviewClip(ln, subsetPreview ?? null, off);
      const va = ln.geom?.attributes.aVisible as THREE.BufferAttribute | undefined;
      if (va) va.needsUpdate = true;
      return pass;
    };
    // Each apply() stashes its pass count on the node (ln.filterPass);
    // the per-frame stats emitter sums those, so the live match count
    // stays right as tiles stream in and out instead of freezing at
    // whatever was resident when the filters last changed.
    for (const ln of loadedRef.current.values()) apply(ln);
    for (const ln of pendingGpuRef.current) apply(ln);

    // The extra-range filter can name a column a node hasn't lazily
    // decoded (see loadNode's wanted-extras set); applyFilters just
    // leaves such a node unfiltered by it until the column lands (see
    // the progressive-semantics comment inside applyFilters). Hydrate
    // whatever's missing here, the same way the colour-mode effect above
    // hydrates extra:<name> columns for painting — `apply` doubles as
    // the after-callback, so each node re-runs applyFilters + the
    // preview clip and flags aVisible for re-upload the moment its
    // column arrives. Its return value is ignored here (the type is
    // still structurally void-compatible) — a late-hydrated node was
    // already counted once above, so folding it in again would double-
    // count; the tally simply reflects the next filter change instead.
    const name = filters.extraRange?.name;
    const missing: LoadedNode[] = [];
    if (name) {
      for (const ln of loadedRef.current.values()) {
        if (!ln.extras[name]) missing.push(ln);
      }
    }
    if (name && missing.length > 0) void hydrateExtraColumn(missing, name, apply);
  }, [filters, subsetPreview, octree.meta.offset, hydrateExtraColumn]);

  // When the patch store mutates, reset the affected nodes back to
  // their pristine decoded state and reapply the current patches.
  // Only the nodes the last mutation actually touched are refreshed
  // (PatchStore.takeTouched), so editing one point never re-uploads
  // every loaded node's buffers. Resetting from cached originals is
  // what makes undo / unhide restore the right values.
  useEffect(() => {
    const store = storeRef.current;
    const touched = store.takeTouched();
    if (touched === 'all') {
      for (const ln of loadedRef.current.values()) refreshNode(ln);
    } else {
      for (const key of touched) {
        // key = `${tile}:${recIdx}`; recIdx uniquely keys loadedRef.
        const sep = key.indexOf(':');
        const recIdx = parseInt(key.slice(sep + 1), 10);
        const ln = loadedRef.current.get(recIdx);
        if (ln) refreshNode(ln);
      }
    }
  }, [storeVersion, storeRef, refreshNode]);

  // Scene mount + full teardown on dataset change.
  useEffect(() => {
    const group = groupRef.current;
    scene.add(group);
    return () => {
      scene.remove(group);
      for (const ln of loadedRef.current.values()) {
        if (ln.obj) ln.obj.removeFromParent();
        ln.geom?.dispose();
        ln.material?.dispose();
      }
      for (const ln of pendingGpuRef.current) {
        ln.geom?.dispose();
        ln.material?.dispose();
      }
      loadedRef.current.clear();
      inFlightRef.current.clear();
      pendingGpuRef.current = [];
      visibleSetRef.current.clear();
      loadQueueRef.current = [];
      loadedPointsRef.current = 0;
      // Bump for the same reason the other two resets do. Usually this
      // teardown is an unmount and nothing survives to publish — but the
      // effect keys on `scene`, so a scene swap runs it while the same
      // refs stay live, and an in-flight load would then insert a node
      // decoded before the swap into a cache that had just been cleared.
      loadGenRef.current++;
    };
  }, [scene]);

  // A reopen of the SAME dataset (new octree object, unchanged dir) must
  // re-decode every node from the fresh octree.bin. The <Canvas> is keyed
  // by octree.dir, so a same-dir reopen (reloadActiveOctree after Bake,
  // ground classify, or CHM segment) does NOT remount this component —
  // without this reset the streamer would keep serving nodes it decoded
  // from the PRE-operation octree.bin. After Bake that is silent data
  // loss to the eye: the folded-in tree_id / semantic corrections are on
  // disk and cleared out of patches.bin, but the stale cached nodes still
  // carry their pre-bake originalTreeIds, so the recolor reverts the
  // display to the old values and the corrections look gone. Drop the
  // whole node cache here so the per-frame planner re-decodes from disk.
  // Skipped on first mount (nothing decoded yet).
  const octreeResetFirstRef = useRef(true);
  useEffect(() => {
    if (octreeResetFirstRef.current) { octreeResetFirstRef.current = false; return; }
    for (const ln of loadedRef.current.values()) {
      if (ln.obj) ln.obj.removeFromParent();
      ln.geom?.dispose();
      ln.material?.dispose();
    }
    for (const ln of pendingGpuRef.current) {
      ln.geom?.dispose();
      ln.material?.dispose();
    }
    loadedRef.current.clear();
    inFlightRef.current.clear();
    pendingGpuRef.current = [];
    visibleSetRef.current.clear();
    loadQueueRef.current = [];
    loadedPointsRef.current = 0;
    // Invalidate any in-flight deep-selection pass tied to the old cache,
    // and any in-flight node load decoded from the previous dataset.
    deepSelGenRef.current++;
    loadGenRef.current++;
  }, [octree]);

  // Eager preload of every tile root so a top-down overview shows
  // immediately, before the priority queue refines deeper levels.
  useEffect(() => {
    const queue = loadQueueRef.current;
    queue.length = 0;
    for (let t = 0; t < octree.meta.tiles.length; t++) {
      const rec = octree.tileRecordStarts[t];
      const r = octree.records[rec];
      if (!r || r.byteSize === 0) continue;
      // Big weight to guarantee roots load before the first plan runs.
      queue.push({ rec, weight: 1e9 - t });
      // Mark every root as initially visible so the GPU drain shows
      // them as soon as their geometry is uploaded.
      visibleSetRef.current.add(rec);
    }
    pumpQueue(
      octree, storeRef.current, selectionStoreRef.current,
      loadedRef.current, inFlightRef.current, pendingGpuRef.current,
      queue, sharedUniformsRef.current, loadedPointsRef, displayRef, filtersRef, subsetPreviewRef,
      loadGenRef,
    );
  }, [octree, storeRef, selectionStoreRef]);

  // Per-frame: drain GPU uploads, throttled plan, visibility sync, stats.
  useFrame(() => {
    const frame = ++frameRef.current;
    const now = performance.now();
    // Frame delta — drives both the FPS EMA and the streaming fades.
    // Clamped so a long stall (tab hidden, huge GC) doesn't snap every
    // mid-fade node to its target in one jump.
    const dtMs = lastFrameTimeRef.current > 0 ? Math.min(now - lastFrameTimeRef.current, 100) : 16;
    if (lastFrameTimeRef.current > 0 && dtMs > 0) {
      fpsRef.current = fpsRef.current * 0.9 + (1000 / dtMs) * 0.1;
    }
    lastFrameTimeRef.current = now;

    // 0. An export's PlanOverride sizes the points for the figure while
    //    it holds — see PlanOverride.
    const planOverride = planOverrideRef?.current ?? null;
    if (planOverride) {
      sharedUniformsRef.current.uSize.value = planOverride.pointSize;
    } else if (overrideWasOnRef.current) {
      sharedUniformsRef.current.uSize.value = clampPointSize(displayRef.current.pointSize);
    }
    overrideWasOnRef.current = planOverride !== null;

    // 1. Drain a few pending GPU uploads.
    {
      let added = 0;
      const pending = pendingGpuRef.current;
      const group = groupRef.current;
      while (added < LOADED_TO_GPU_PER_FRAME && pending.length > 0) {
        const ln = pending.shift()!;
        // The node may have been LRU-evicted while it waited for its
        // upload slot (decoded one frame, no longer visible the next).
        // evictNode already disposed its buffers and dropped it from
        // `loaded`, so skip it rather than resurrect an orphan.
        if (!loadedRef.current.has(ln.recIdx)) {
          ln.geom?.dispose();
          ln.material?.dispose();
          continue;
        }
        const obj = new THREE.Points(ln.geom, ln.material);
        obj.frustumCulled = true;
        obj.userData.recIdx = ln.recIdx;
        obj.visible = visibleSetRef.current.has(ln.recIdx);
        group.add(obj);
        ln.obj = obj;
        added++;
      }
    }

    // 2. Throttled re-plan. Removing the cam-stability gate lets
    //    OrbitControls' damping settle without starving the planner.
    if (now - lastPlanAt.current >= PLAN_INTERVAL_MS) {
      lastPlanAt.current = now;
      // Update the smoothed camera-velocity estimate (per plan tick, so
      // the dt is long enough for a stable derivative).
      const pos = camera.position;
      const prev = prevCamRef.current;
      const vel = camVelRef.current;
      if (prev && now > prev.t) {
        const dts = (now - prev.t) / 1000;
        // EMA keeps a flick of the mouse from spraying prefetches.
        vel.x = vel.x * 0.6 + ((pos.x - prev.x) / dts) * 0.4;
        vel.y = vel.y * 0.6 + ((pos.y - prev.y) / dts) * 0.4;
        vel.z = vel.z * 0.6 + ((pos.z - prev.z) / dts) * 0.4;
      }
      prevCamRef.current = { x: pos.x, y: pos.y, z: pos.z, t: now };
      if (!streamPausedRef.current) planAndStream(
        octree, camera as THREE.PerspectiveCamera,
        planOverride ? { width: planOverride.width, height: planOverride.height } : size,
        loadedRef.current, inFlightRef.current, pendingGpuRef.current,
        loadQueueRef.current, visibleSetRef.current, loadedPointsRef,
        frame, sharedUniformsRef.current,
        planOverride ? planOverride.pointBudget : displayRef.current.pointBudget,
        storeRef.current, selectionStoreRef.current, displayRef, filtersRef, subsetPreviewRef,
        loadGenRef, vel,
      );
    }

    // 3. Per-frame visibility + fade sync. A node entering the visible
    //    set dissolves in (uFade 0→1); one leaving dissolves out and is
    //    only then actually hidden — so streaming and re-plans read as a
    //    smooth densification instead of tiles popping in and out.
    const group = groupRef.current;
    const visible = visibleSetRef.current;
    const fadeInStep = dtMs / FADE_IN_MS;
    const fadeOutStep = dtMs / FADE_OUT_MS;
    let visiblePoints = 0;
    let visibleNodes = 0;
    for (const child of group.children) {
      const p = child as THREE.Points;
      const r = p.userData.recIdx as number;
      const want = visible.has(r);
      const ln = loadedRef.current.get(r);
      if (ln) {
        const target = want ? 1 : 0;
        if (ln.fade !== target) {
          ln.fade = want
            ? Math.min(1, ln.fade + fadeInStep)
            : Math.max(0, ln.fade - fadeOutStep);
        }
        const fu = ln.material.uniforms.uFade as { value: number } | undefined;
        if (fu && fu.value !== ln.fade) fu.value = ln.fade;
        const draw = want || ln.fade > 0;
        if (p.visible !== draw) p.visible = draw;
      } else if (p.visible !== want) {
        p.visible = want;
      }
      if (want && ln) { visiblePoints += ln.numPoints; visibleNodes++; }
    }

    // 3b. Depth-cue uniforms — active while a tree is isolated with its
    //     nearby unassigned points shown (tree_id colours). The band
    //     re-derives every frame from the camera pose so orbiting keeps
    //     the near-side grey light and the far-side grey dark.
    //
    //     THE BAND IS THE WHOLE FEATURE. It used to be the camera-to-box
    //     distance plus and minus the box's half-DIAGONAL, which is not
    //     the depth the dimmed points actually occupy — it is dominated
    //     by the tree's height, an axis that is mostly perpendicular to
    //     the view when you are looking at a trunk from the side. On an
    //     ordinary 3 x 3 x 20 m neighbourhood that made the ramp about
    //     28 m long while the grey points spanned some 7 m of it, so the
    //     brightness moved over roughly a fifth of its range and the
    //     toggle read as doing nothing at all.
    //
    //     Projecting the box's eight corners onto the view axis gives
    //     the exact near and far depth of the region the grey points
    //     live in, so the full ramp is spent across the cloud you can
    //     see, at every camera angle.
    {
      const su = sharedUniformsRef.current;
      const fc = filtersRef.current;
      const strength = Math.max(0, Math.min(1, displayRef.current.depthCueStrength ?? 0.7));
      const enabled = displayRef.current.depthCueUnassigned
        && strength > 0.001
        && displayRef.current.colorMode === 'tree_id'
        && fc.isolateTreeId !== null && fc.isolateShowUnassigned && !!fc.isolateBox;
      if (!enabled) {
        if (su.uDimEnabled.value !== 0) su.uDimEnabled.value = 0;
      } else {
        // The very box applyFilters clips the grey points to, so the ramp
        // and the visible cloud cannot describe different regions.
        const b = isolateBoxToScene({
          box: fc.isolateBox!,
          anchor: fc.isolateAnchor ?? null,
          margin: fc.isolateMargin ?? 0,
          zRange: fc.isolateZRange ?? null,
        }, octree.meta.offset);

        // The cloud carries no per-node model transform, so view space is
        // just the camera's inverse world matrix — see viewDepthSpan for
        // why the corners and not a centre-distance.
        camera.updateMatrixWorld();
        const { near, far } = viewDepthSpan(b, camera.matrixWorldInverse.elements);
        su.uDimEnabled.value = 1;
        su.uDimStrength.value = strength;
        su.uDimNear.value = near;
        su.uDimFar.value = far;
      }
    }

    // 4. Stats — feeds the overlay.
    // Filter match count: sum the per-node pass counts over everything
    // resident. O(nodes), not O(points) — a few hundred adds — so it can
    // run per frame and therefore never goes stale as tiles stream in and
    // out, which a tally computed only on filter change would.
    let filterPass = 0, filterTotal = 0;
    for (const ln of loadedRef.current.values()) {
      filterPass += ln.filterPass; filterTotal += ln.treeIds.length;
    }
    for (const ln of pendingGpuRef.current) {
      filterPass += ln.filterPass; filterTotal += ln.treeIds.length;
    }
    const info = gl.info;

    // Legend bounds (see ViewerStats.rampLo/rampHi) — MUST be the exact
    // values colorNode() ramped this frame's active mode over, or the
    // legend lies. height / x / y / extra:<name> read the identical ref
    // objects colorNode() is called with a few lines above (heightSpanRef
    // / xSpanRef / ySpanRef / extraRangesRef) — there is no separate
    // computation to drift out of sync. intensity reads intensitySpanRef
    // the same way: when metadata.intensityRange is known (recorded at
    // import, or backfilled on demand via octree_intensity_range),
    // colorNode ramped over that SAME cloud-wide span, so it's published
    // here too. When it's absent, colorNode fell back to a per-node scan
    // instead — no single pair of numbers describes every tile in that
    // case, so publishing nothing beats publishing a value the painting
    // doesn't actually obey. Categorical / flat modes carry no numeric
    // scale either — null, and the legend hides itself.
    const rampMode = displayRef.current.colorMode;
    let rampLo: number | null = null;
    let rampHi: number | null = null;
    if (rampMode === 'height') {
      rampLo = heightSpanRef.current.lo; rampHi = heightSpanRef.current.hi;
    } else if (rampMode === 'x') {
      rampLo = xSpanRef.current.lo; rampHi = xSpanRef.current.hi;
    } else if (rampMode === 'y') {
      rampLo = ySpanRef.current.lo; rampHi = ySpanRef.current.hi;
    } else if (rampMode === 'intensity') {
      const span = intensitySpanRef.current;
      if (span) { rampLo = span.lo; rampHi = span.hi; }
    } else if (typeof rampMode === 'string' && rampMode.startsWith('extra:')) {
      const r = extraRangesRef.current[rampMode.slice('extra:'.length)];
      if (r) { rampLo = r.lo; rampHi = r.hi; }
    }

    onStatsChange({
      loadedNodes: loadedRef.current.size,
      visibleNodes,
      pendingNodes: loadQueueRef.current.length + inFlightRef.current.size + pendingGpuRef.current.length,
      loadedPoints: loadedPointsRef.current,
      visiblePoints,
      drawCalls: info.render.calls,
      geometries: info.memory.geometries,
      fps: fpsRef.current,
      filterPassPoints: filterPass,
      filterTotalPoints: filterTotal,
      rampLo,
      rampHi,
    });
  });

  // Expose the edit API once the camera + refs are stable.
  useEffect(() => {
    const camPick = camera as THREE.PerspectiveCamera;
    const selStore = selectionStoreRef.current;
    // Where a point is DRAWN, for the screen-space tests below: its
    // stored scene y less the terrain under it while heights are shown
    // above ground. Picks return, and edits act on, the stored
    // coordinates; only the projection uses this.
    const offDraw = octree.meta.offset;
    const drawnY = (sx: number, sy: number, sz: number): number => {
      const t = terrainRef.current;
      return t ? sy - t.shift(sx + offDraw[0], offDraw[1] - sz) : sy;
    };

    const countAll = (): number => {
      let n = 0;
      for (const s of selStore.values()) n += s.size;
      return n;
    };
    const repaintLoaded = (key: PatchNodeKey, ln: LoadedNode): void => {
      // Reflect the session-wide selection on this node's local bit
      // array so the colour pass paints the right points red.
      const set = selStore.get(key);
      if (!set || set.size === 0) {
        if (ln.selection) ln.selection.fill(0);
      } else {
        if (!ln.selection) ln.selection = new Uint8Array(ln.treeIds.length);
        ln.selection.fill(0);
        for (const i of set) if (i < ln.selection.length) ln.selection[i] = 1;
      }
      {
        const su = sharedUniformsRef.current;
        colorNode(ln, displayRef.current.colorMode, displayRef.current.ramp, { tree: su.activeTreeId, standing: su.activeStandingId, laying: su.activeLayingId }, su.activeTreeRgb, heightSpanRef.current, extraRangesRef.current, su.unlabeledRgb, { x: xSpanRef.current, y: ySpanRef.current }, intensitySpanRef.current ?? undefined);
      }
      const ca = ln.geom?.attributes.color as THREE.BufferAttribute | undefined;
      if (ca) ca.needsUpdate = true;
    };

    const getSet = (ln: LoadedNode): Set<number> => {
      const key = patchNodeKey(ln.tile, ln.record);
      let set = selStore.get(key);
      if (!set) { set = new Set(); selStore.set(key, set); }
      return set;
    };
    // Repaint every loaded node from the (now updated) session selection
    // and drop any sets that emptied out. Used after a selection edit so
    // both the highlight and the count stay consistent.
    const repaintAll = (): void => {
      for (const [, ln] of loadedRef.current) {
        const key = patchNodeKey(ln.tile, ln.record);
        const set = selStore.get(key);
        if (set && set.size === 0) selStore.delete(key);
        repaintLoaded(key, ln);
      }
    };

    // Shared screen-space eyedropper: returns the id (from the chosen
    // per-node array) of the frontmost visible point under the cursor, or
    // null. tree_id + both deadwood channels reuse this — `pick` selects
    // which id array to read; a null array (channel absent) is skipped.
    const pickIdAt = (x: number, y: number, pick: (ln: LoadedNode) => Int32Array | null): number | null => {
      const W = Math.max(1, size.width);
      const H = Math.max(1, size.height);
      camPick.updateMatrixWorld();
      const m = new THREE.Matrix4().multiplyMatrices(camPick.projectionMatrix, camPick.matrixWorldInverse);
      const mv = camPick.matrixWorldInverse;
      const v = new THREE.Vector4();
      const vView = new THREE.Vector4();
      const radiusPx = 8;
      let bestDepth = Infinity;
      let bestId: number | null = null;
      for (const [, ln] of loadedRef.current) {
        const arr = pick(ln);
        if (!arr) continue;
        const pos = ln.positions;
        const vis = ln.visibility;
        for (let i = 0; i < arr.length; i++) {
          if (vis[i] === 0) continue;
          const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
          const dy = drawnY(px, py, pz);
          if (!Number.isFinite(px)) continue;
          v.set(px, dy, pz, 1).applyMatrix4(m);
          if (v.w <= 0) continue;
          const iw = 1 / v.w;
          const ndz = v.z * iw;
          if (ndz < -1 || ndz > 1) continue;
          const sx = (v.x * iw * 0.5 + 0.5) * W;
          const sy = (-v.y * iw * 0.5 + 0.5) * H;
          if (Math.abs(sx - x) > radiusPx || Math.abs(sy - y) > radiusPx) continue;
          vView.set(px, dy, pz, 1).applyMatrix4(mv);
          const zLin = -vView.z;
          if (zLin < bestDepth) { bestDepth = zLin; bestId = arr[i]; }
        }
      }
      return bestId;
    };

    // Apply an edit action to every selected (tile:record → indices)
    // entry in the session store — loaded or not; patches replay onto
    // unloaded nodes when they stream in. Shared by the public
    // applyToSelection and by the deep-pass late-reapply below.
    const applyToSelectionImpl = (action: {
      treeId?: number; semantic?: 0 | 1 | 2 | 3; deleted?: 0 | 1 | 2;
      standingDeadwood?: number; layingDeadwood?: number;
    }): number => {
      const edits: PatchEdit[] = [];
      // Freeze the selection that produced this batch onto the undo
      // entry, so Ctrl+Z after a wrong-button apply (Assign when Reset
      // was meant) hands the hand-picked points back still selected.
      const snapshot: SelectionSnapshot = [];
      for (const [key, set] of selStore) {
        if (set.size === 0) continue;
        snapshot.push([key as PatchNodeKey, [...set]]);
        const sep = key.indexOf(':');
        const tile = parseInt(key.slice(0, sep), 10);
        const record = parseInt(key.slice(sep + 1), 10);
        for (const idx of set) {
          edits.push({
            tile, record, pointIdx: idx,
            treeId: action.treeId,
            semantic: action.semantic,
            deleted: action.deleted,
            standingDeadwood: action.standingDeadwood,
            layingDeadwood: action.layingDeadwood,
          });
        }
      }
      if (edits.length === 0) return 0;
      storeRef.current.applyEdits(edits, snapshot);
      return edits.length;
    };

    // ---- Deep selection: extend a paint selection to the points that
    // AREN'T currently streamed in. The sync pass above only sees loaded
    // nodes, so at a far zoom (or a tight point budget) a "fully painted"
    // tree could silently leave its unloaded points unlabelled — the user
    // discovered the segmentation still broken later. This pass walks the
    // hierarchy, finds unloaded nodes whose bbox projects into the shape,
    // fetches ONLY their geometry (12 B/point over the columnar IPC), and
    // runs the same screen-space test, recording matches in the session
    // selection store. Edits then apply store-wide, and the red highlight
    // appears whenever those nodes stream in.
    const deepSelectPass = async (args: {
      gen: number;
      m: THREE.Matrix4;
      mv: THREE.Matrix4;
      W: number; H: number;
      sb: [number, number, number, number];
      hitTest: (sx: number, sy: number) => boolean;
      add: boolean;
      /** Non-null = occlusion-aware mode: candidate must sit within
       *  depthTolM of the nearest rendered surface in its screen cell
       *  (the same test loaded points pass). Built from the loaded set —
       *  an approximation for unloaded points, but the right one: it
       *  reproduces what WOULD have been selected had they been drawn. */
      nearest: Float32Array | null;
      bin: number; bw: number; bh: number; depthTolM: number;
    }): Promise<void> => {
      const idx = octree.index;
      const records = octree.records;
      const off = octree.meta.offset;
      const v = new THREE.Vector4();
      const fr = new THREE.Frustum().setFromProjectionMatrix(args.m);
      const sceneBox = new THREE.Box3();
      // Conservative screen-space overlap of a record's source bbox vs
      // the shape's bbox. A corner behind the near plane makes the
      // projected bbox unreliable — but the old "any corner behind ⇒
      // keep unconditionally" flooded the candidate list whenever the
      // camera sat INSIDE the cloud (exactly the zoomed-in Tree Review
      // editing case: most nodes have a corner behind), which hit the
      // caps below and silently truncated the selection — lassoed
      // points never got selected. Fall back to a 3D frustum test
      // instead: nodes fully behind / beside the camera prune, nodes
      // straddling the near plane stay (still conservative).
      const overlaps = (rec: number): boolean => {
        const b = idx.bbox; const o = rec * 6;
        let anyBehind = false;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let c = 0; c < 8; c++) {
          const wx = (c & 1) ? b[o + 3] : b[o];
          const wy = (c & 2) ? b[o + 4] : b[o + 1];
          const wz = (c & 4) ? b[o + 5] : b[o + 2];
          v.set(wx - off[0], wz - off[2], -(wy - off[1]), 1).applyMatrix4(args.m);
          if (v.w <= 0) { anyBehind = true; continue; }
          const iw = 1 / v.w;
          const px = (v.x * iw * 0.5 + 0.5) * args.W;
          const py = (-v.y * iw * 0.5 + 0.5) * args.H;
          if (px < minX) minX = px; if (px > maxX) maxX = px;
          if (py < minY) minY = py; if (py > maxY) maxY = py;
        }
        if (anyBehind) {
          // Source → scene: sceneX = x−off0, sceneY = z−off2,
          // sceneZ = −(y−off1) (the negation swaps that axis' min/max).
          sceneBox.min.set(b[o] - off[0], b[o + 2] - off[2], -(b[o + 4] - off[1]));
          sceneBox.max.set(b[o + 3] - off[0], b[o + 5] - off[2], -(b[o + 1] - off[1]));
          return fr.intersectsBox(sceneBox);
        }
        return !(maxX < args.sb[0] || minX > args.sb[2] || maxY < args.sb[1] || minY > args.sb[3]);
      };

      // Hierarchy walk: prune subtrees whose bbox misses the shape (a
      // child's bbox is inside its parent's, so the prune is safe), and
      // collect every unloaded node with points. Bounded so a plot-wide
      // lasso at far zoom can't pull the whole cloud through the pass.
      const MAX_DEEP_POINTS = 12_000_000;
      const MAX_DEEP_NODES = 4_000;
      const candidates: number[] = [];
      let candPts = 0;
      let truncated = false;
      const stack: number[] = [...octree.tileRecordStarts];
      while (stack.length > 0) {
        const rec = stack.pop()!;
        const r = records[rec];
        if (!r) continue;
        if (!overlaps(rec)) continue;
        if (r.byteSize > 0 && !loadedRef.current.has(rec)) {
          if (candPts + r.numPoints > MAX_DEEP_POINTS || candidates.length >= MAX_DEEP_NODES) {
            truncated = true;
          } else {
            candidates.push(rec);
            candPts += r.numPoints;
          }
        }
        const cs = idx.childrenStart[rec];
        const ce = idx.childrenStart[rec + 1];
        // NO_RECORD (-1) marks a child slot the index walk never
        // filled — a hierarchy whose childMask tree disagrees with its
        // recordCount. Pushing it would index records[-1].
        for (let k = cs; k < ce; k++) {
          const c = idx.childrenFlat[k];
          if (c !== NO_RECORD) stack.push(c);
        }
      }
      if (truncated) {
        console.warn(`deep selection truncated at ${MAX_DEEP_POINTS.toLocaleString()} unloaded points — zoom in to cover the rest`);
      }
      if (candidates.length === 0) return;

      deepSelPendingRef.current++;
      try {
        const touched = new Set<string>();
        let i = 0;
        const worker = async (): Promise<void> => {
          const v2 = new THREE.Vector4();
          const vv = new THREE.Vector4();
          while (i < candidates.length) {
            if (deepSelGenRef.current !== args.gen) return; // selection cleared
            const rec = candidates[i++];
            const r = records[rec];
            let data: { positions: Float32Array; treeIds: Int32Array; classification: Uint8Array };
            try {
              data = await readNodeSelectData(
                octree.dir, r.byteOffset, r.byteSize, octree.meta.pointBytes,
                octree.meta.scale, octree.meta.offset,
              );
            } catch (e) {
              console.warn(`deep selection: node rec=${rec} fetch failed`, e);
              continue;
            }
            if (deepSelGenRef.current !== args.gen) return;
            const tile = idx.tileOf[rec];
            const key = patchNodeKey(tile, rec);
            const pos = data.positions;
            const count = pos.length / 3;
            // Replicate exactly what the user can see: replay patch
            // overrides (tree_id edits + deletions) and the merge
            // overlay onto the fetched ids, then run the SAME filter
            // mask the loaded nodes use. Otherwise a paint with e.g. an
            // isolate filter active would deep-select points of OTHER
            // trees that the filters hide on screen — and a follow-up
            // assignment would silently mislabel them.
            const deleted = new Uint8Array(count);
            const entries = storeRef.current.map.get(key);
            if (entries) {
              for (const e of entries) {
                if (e.pointIdx >= count) continue;
                if (e.treeId >= 0) data.treeIds[e.pointIdx] = e.treeId;
                if (e.deleted === 1) deleted[e.pointIdx] = 1;
                else if (e.deleted === 2) deleted[e.pointIdx] = 0;
              }
            }
            applyRemapInPlace(data.treeIds, sharedUniformsRef.current.remap);
            const vis = new Uint8Array(count);
            vis.fill(1);
            const pseudo = {
              visibility: vis,
              treeIds: data.treeIds,
              classification: data.classification,
              positions: pos,
              deleted,
            } as unknown as LoadedNode;
            applyFilters(pseudo, filtersRef.current, octree.meta.offset);
            applyPreviewClip(pseudo, subsetPreviewRef.current, octree.meta.offset);
            let set = selStore.get(key);
            for (let p = 0; p < count; p++) {
              if (vis[p] === 0) continue;
              const px = pos[p * 3], py = pos[p * 3 + 1], pz = pos[p * 3 + 2];
              const dy = drawnY(px, py, pz);
              v2.set(px, dy, pz, 1).applyMatrix4(args.m);
              if (v2.w <= 0) continue;
              const iw = 1 / v2.w;
              const ndz = v2.z * iw;
              if (ndz < -1 || ndz > 1) continue;
              const sx = (v2.x * iw * 0.5 + 0.5) * args.W;
              const sy = (-v2.y * iw * 0.5 + 0.5) * args.H;
              if (sx < args.sb[0] || sx > args.sb[2] || sy < args.sb[1] || sy > args.sb[3]) continue;
              if (!args.hitTest(sx, sy)) continue;
              if (args.nearest) {
                vv.set(px, dy, pz, 1).applyMatrix4(args.mv);
                const zLin = -vv.z;
                const bx = Math.max(0, Math.min(args.bw - 1, (sx / args.bin) | 0));
                const by = Math.max(0, Math.min(args.bh - 1, (sy / args.bin) | 0));
                if (zLin > args.nearest[by * args.bw + bx] + args.depthTolM) continue;
              }
              if (args.add) {
                if (!set) { set = new Set(); selStore.set(key, set); }
                set.add(p);
              } else if (set) {
                set.delete(p);
              }
              touched.add(key);
            }
          }
        };
        await Promise.all(Array.from({ length: 4 }, () => worker()));
        if (deepSelGenRef.current !== args.gen) return;
        // A touched node may have streamed in mid-pass AFTER its
        // selection rehydration ran — sync its highlight bits now.
        for (const key of touched) {
          const rec = parseInt(key.slice(key.indexOf(':') + 1), 10);
          const ln = loadedRef.current.get(rec);
          if (ln) repaintLoaded(key as PatchNodeKey, ln);
        }
        onSelectionChange(countAll());
      } finally {
        deepSelPendingRef.current--;
        // The user assigned an edit while this pass was still finding
        // points — re-apply the same action so the late arrivals get it
        // too (idempotent for the ones already edited).
        if (deepSelPendingRef.current === 0 && deepSelReapplyRef.current
            && deepSelGenRef.current === args.gen) {
          const action = deepSelReapplyRef.current;
          deepSelReapplyRef.current = null;
          applyToSelectionImpl(action);
        }
      }
    };

    const api: EditApi = {
      selectByShape: (shape, depth, mode) => {
        const W = Math.max(1, size.width);
        const H = Math.max(1, size.height);
        camPick.updateMatrixWorld();
        const m = new THREE.Matrix4().multiplyMatrices(camPick.projectionMatrix, camPick.matrixWorldInverse);
        const mv = camPick.matrixWorldInverse;
        // Screen-space bbox of the shape — a cheap reject before the
        // per-point polygon test.
        let sbx1: number, sby1: number, sbx2: number, sby2: number;
        if (shape.kind === 'rect') {
          sbx1 = Math.min(shape.x0, shape.x1); sbx2 = Math.max(shape.x0, shape.x1);
          sby1 = Math.min(shape.y0, shape.y1); sby2 = Math.max(shape.y0, shape.y1);
        } else {
          sbx1 = Infinity; sby1 = Infinity; sbx2 = -Infinity; sby2 = -Infinity;
          for (const [x, y] of shape.pts) {
            if (x < sbx1) sbx1 = x; if (y < sby1) sby1 = y;
            if (x > sbx2) sbx2 = x; if (y > sby2) sby2 = y;
          }
        }
        const hitTest = (sx: number, sy: number): boolean =>
          shape.kind === 'rect' ? true : pointInPolygon(sx, sy, shape.pts);
        const add = mode === 'add';
        const v = new THREE.Vector4();
        const vView = new THREE.Vector4();
        let hits = 0;

        if (depth === 'through') {
          for (const [, ln] of loadedRef.current) {
            const set = getSet(ln);
            const pos = ln.positions;
            const vis = ln.visibility;
            for (let i = 0; i < ln.treeIds.length; i++) {
              if (vis[i] === 0) continue;
              const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
              const dy = drawnY(px, py, pz);
              if (!Number.isFinite(px)) continue;
              v.set(px, dy, pz, 1).applyMatrix4(m);
              if (v.w <= 0) continue;
              const iw = 1 / v.w;
              const ndz = v.z * iw;
              if (ndz < -1 || ndz > 1) continue;
              const sx = (v.x * iw * 0.5 + 0.5) * W;
              const sy = (-v.y * iw * 0.5 + 0.5) * H;
              if (sx < sbx1 || sx > sbx2 || sy < sby1 || sy > sby2) continue;
              if (!hitTest(sx, sy)) continue;
              hits++;
              if (add) set.add(i); else set.delete(i);
            }
          }
          repaintAll();
          onSelectionChange(countAll());
          // Extend to the unloaded points under the same shape ('through'
          // has no occlusion test, so nearest stays null). mv is the live
          // camera matrix — clone for the async pass.
          void deepSelectPass({
            gen: deepSelGenRef.current, m, mv: mv.clone(), W, H,
            sb: [sbx1, sby1, sbx2, sby2], hitTest, add,
            nearest: null, bin: 1, bw: 1, bh: 1, depthTolM: 0,
          });
          return hits;
        }

        // depth === 'visible' — occlusion-aware across every loaded node.
        // Pass 1 builds a screen-space nearest-depth grid from all points
        // inside the shape; pass 2 keeps only points within depthTol of
        // the frontmost surface in their screen cell. Mirrors the
        // in-memory ShapeSelectController, extended over the node set.
        const nodesArr = [...loadedRef.current.values()];
        const bin = 2;
        const bw = Math.ceil(W / bin), bh = Math.ceil(H / bin);
        const nearest = new Float32Array(bw * bh); nearest.fill(Infinity);
        const depthTolM = 0.6;
        // Size the candidate buffers to the loaded point count (capped),
        // so small clouds don't pay a fixed 4 M-slot allocation.
        let totalPts = 0;
        for (let ni = 0; ni < nodesArr.length; ni++) totalPts += nodesArr[ni].treeIds.length;
        const cap = Math.min(totalPts, 4_000_000);
        const candNode = new Int32Array(cap);
        const candIdx = new Int32Array(cap);
        const candBin = new Int32Array(cap);
        const candZ = new Float32Array(cap);
        let cbLen = 0;
        let overflow = false;
        for (let ni = 0; ni < nodesArr.length; ni++) {
          const pos = nodesArr[ni].positions;
          const vis = nodesArr[ni].visibility;
          const cnt = nodesArr[ni].treeIds.length;
          for (let i = 0; i < cnt; i++) {
            if (vis[i] === 0) continue;
            const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
            const dy = drawnY(px, py, pz);
            if (!Number.isFinite(px)) continue;
            v.set(px, dy, pz, 1).applyMatrix4(m);
            if (v.w <= 0) continue;
            const iw = 1 / v.w;
            const ndz = v.z * iw;
            if (ndz < -1 || ndz > 1) continue;
            const sx = (v.x * iw * 0.5 + 0.5) * W;
            const sy = (-v.y * iw * 0.5 + 0.5) * H;
            if (sx < sbx1 || sx > sbx2 || sy < sby1 || sy > sby2) continue;
            if (!hitTest(sx, sy)) continue;
            vView.set(px, dy, pz, 1).applyMatrix4(mv);
            const zLin = -vView.z;
            const bx = Math.max(0, Math.min(bw - 1, (sx / bin) | 0));
            const by = Math.max(0, Math.min(bh - 1, (sy / bin) | 0));
            const bi = by * bw + bx;
            if (zLin < nearest[bi]) nearest[bi] = zLin;
            if (cbLen < cap) { candNode[cbLen] = ni; candIdx[cbLen] = i; candBin[cbLen] = bi; candZ[cbLen] = zLin; cbLen++; }
            else overflow = true;
          }
        }
        if (!overflow) {
          for (let k = 0; k < cbLen; k++) {
            if (candZ[k] > nearest[candBin[k]] + depthTolM) continue;
            const set = getSet(nodesArr[candNode[k]]);
            hits++;
            if (add) set.add(candIdx[k]); else set.delete(candIdx[k]);
          }
        } else {
          // Candidate buffer overflowed — re-scan and test against the
          // nearest grid directly (slower, but rare: needs >4 M points
          // inside one shape).
          for (let ni = 0; ni < nodesArr.length; ni++) {
            const set = getSet(nodesArr[ni]);
            const pos = nodesArr[ni].positions;
            const vis = nodesArr[ni].visibility;
            const cnt = nodesArr[ni].treeIds.length;
            for (let i = 0; i < cnt; i++) {
              if (vis[i] === 0) continue;
              const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
              const dy = drawnY(px, py, pz);
              if (!Number.isFinite(px)) continue;
              v.set(px, dy, pz, 1).applyMatrix4(m);
              if (v.w <= 0) continue;
              const iw = 1 / v.w;
              const ndz = v.z * iw;
              if (ndz < -1 || ndz > 1) continue;
              const sx = (v.x * iw * 0.5 + 0.5) * W;
              const sy = (-v.y * iw * 0.5 + 0.5) * H;
              if (sx < sbx1 || sx > sbx2 || sy < sby1 || sy > sby2) continue;
              if (!hitTest(sx, sy)) continue;
              vView.set(px, dy, pz, 1).applyMatrix4(mv);
              const zLin = -vView.z;
              const bx = Math.max(0, Math.min(bw - 1, (sx / bin) | 0));
              const by = Math.max(0, Math.min(bh - 1, (sy / bin) | 0));
              if (zLin > nearest[by * bw + bx] + depthTolM) continue;
              hits++;
              if (add) set.add(i); else set.delete(i);
            }
          }
        }
        repaintAll();
        onSelectionChange(countAll());
        // Extend to the unloaded points under the same shape, against the
        // same nearest-depth grid the loaded points were tested with.
        void deepSelectPass({
          gen: deepSelGenRef.current, m, mv: mv.clone(), W, H,
          sb: [sbx1, sby1, sbx2, sby2], hitTest, add,
          nearest, bin, bw, bh, depthTolM,
        });
        return hits;
      },
      pickTreeIdAt: (x, y) => pickIdAt(x, y, (ln) => ln.treeIds),
      pickDeadwoodIdAt: (x, y, channel) => pickIdAt(x, y,
        (ln) => channel === 'standing' ? ln.standingDeadwood : ln.layingDeadwood),
      pickPositionAt: (x, y) => {
        const W = Math.max(1, size.width);
        const H = Math.max(1, size.height);
        camPick.updateMatrixWorld();
        const m = new THREE.Matrix4().multiplyMatrices(camPick.projectionMatrix, camPick.matrixWorldInverse);
        const mv = camPick.matrixWorldInverse;
        const off = octree.meta.offset;
        const v = new THREE.Vector4();
        const vView = new THREE.Vector4();
        const radiusPx = 10;
        let bestDepth = Infinity;
        let best: { x: number; y: number; z: number } | null = null;
        // Stride-sample so the readout stays cheap regardless of how many
        // points are loaded — a coordinate hint doesn't need every point.
        // Cap the total tested to ~150 k.
        let totalPts = 0;
        for (const [, ln] of loadedRef.current) totalPts += ln.treeIds.length;
        const stride = Math.max(1, Math.floor(totalPts / 150_000));
        for (const [, ln] of loadedRef.current) {
          const pos = ln.positions;
          const vis = ln.visibility;
          const cnt = ln.treeIds.length;
          for (let i = 0; i < cnt; i += stride) {
            if (vis[i] === 0) continue;
            const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
            const dy = drawnY(px, py, pz);
            if (!Number.isFinite(px)) continue;
            v.set(px, dy, pz, 1).applyMatrix4(m);
            if (v.w <= 0) continue;
            const iw = 1 / v.w;
            const ndz = v.z * iw;
            if (ndz < -1 || ndz > 1) continue;
            const sx = (v.x * iw * 0.5 + 0.5) * W;
            const sy = (-v.y * iw * 0.5 + 0.5) * H;
            if (Math.abs(sx - x) > radiusPx || Math.abs(sy - y) > radiusPx) continue;
            vView.set(px, dy, pz, 1).applyMatrix4(mv);
            const zLin = -vView.z;
            if (zLin < bestDepth) {
              bestDepth = zLin;
              // Scene → source CRS: undo the axis rotation + offset. North
              // (source Y) is the negated scene-Z, so y = off[1] − pz.
              best = { x: px + off[0], y: off[1] - pz, z: py + off[2] };
            }
          }
        }
        return best;
      },
      pickScenePointAt: (x, y, maxSamples = Infinity) => {
        const W = Math.max(1, size.width);
        const H = Math.max(1, size.height);
        camPick.updateMatrixWorld();
        const m = new THREE.Matrix4().multiplyMatrices(camPick.projectionMatrix, camPick.matrixWorldInverse);
        const mv = camPick.matrixWorldInverse;
        const v = new THREE.Vector4();
        const vView = new THREE.Vector4();
        const radiusPx = 12;
        let bestDepth = Infinity;
        let best: [number, number, number] | null = null;
        // Point spacing of the node the hit came from — the precision
        // floor of anything measured between two picks. Picking only
        // sees nodes currently STREAMED IN, so a measurement is between
        // two points of whatever detail level happens to be resident,
        // and that changes as the camera moves. Reported so the readout
        // can stop implying a precision the method does not have.
        let bestSpacing = 0;
        // Measure passes Infinity → full scan (exactness matters). The
        // rotation pivot passes a small cap → stride-sample so the
        // per-press pick stays cheap on multi-million-point clouds.
        // Either way we skip filtered-out points (can't pivot/measure on
        // what isn't on screen).
        let totalPts = 0;
        for (const [, ln] of loadedRef.current) totalPts += ln.treeIds.length;
        const stride = Number.isFinite(maxSamples) && totalPts > maxSamples
          ? Math.max(1, Math.floor(totalPts / maxSamples))
          : 1;
        for (const [, ln] of loadedRef.current) {
          const pos = ln.positions;
          const vis = ln.visibility;
          const cnt = ln.treeIds.length;
          for (let i = 0; i < cnt; i += stride) {
            if (vis[i] === 0) continue;
            const px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
            const dy = drawnY(px, py, pz);
            if (!Number.isFinite(px)) continue;
            v.set(px, dy, pz, 1).applyMatrix4(m);
            if (v.w <= 0) continue;
            const iw = 1 / v.w;
            const ndz = v.z * iw;
            if (ndz < -1 || ndz > 1) continue;
            const sx = (v.x * iw * 0.5 + 0.5) * W;
            const sy = (-v.y * iw * 0.5 + 0.5) * H;
            if (Math.abs(sx - x) > radiusPx || Math.abs(sy - y) > radiusPx) continue;
            vView.set(px, dy, pz, 1).applyMatrix4(mv);
            const zLin = -vView.z;
            if (zLin < bestDepth) { bestDepth = zLin; best = [px, py, pz]; bestSpacing = ln.spacing; }
          }
        }
        lastPickSpacing.current = best ? bestSpacing : null;
        return best;
      },
      maxTreeId: () => {
        let mx = 0;
        for (const [, ln] of loadedRef.current) {
          const t = ln.treeIds;
          for (let i = 0; i < t.length; i++) if (t[i] > mx) mx = t[i];
        }
        for (const entries of storeRef.current.map.values()) {
          for (const e of entries) if (e.treeId > mx) mx = e.treeId;
        }
        return mx;
      },
      clearSelection: () => {
        // Invalidate any in-flight deep-selection pass — its results
        // belong to the selection that was just discarded.
        deepSelGenRef.current++;
        deepSelReapplyRef.current = null;
        selStore.clear();
        for (const [, ln] of loadedRef.current) {
          const key = patchNodeKey(ln.tile, ln.record);
          repaintLoaded(key, ln);
        }
        onSelectionChange(0);
      },
      selectVisibleUnassigned: () => {
        // "What you see is what you get": walk the loaded nodes and add
        // every point that is currently DRAWN (visibility === 1, so all
        // active filters already applied) and unassigned. No deep pass —
        // unloaded points aren't on screen, so absorbing them would grab
        // things the user can't see; with a tree isolated the forced-
        // detail region has the whole neighbourhood resident anyway.
        let added = 0;
        for (const [, ln] of loadedRef.current) {
          const ids = ln.treeIds;
          const vis = ln.visibility;
          const set = getSet(ln);
          for (let i = 0; i < ids.length; i++) {
            if (vis[i] === 0) continue;
            if (ids[i] > 0) continue;
            if (!set.has(i)) { set.add(i); added++; }
          }
        }
        repaintAll();
        onSelectionChange(countAll());
        return added;
      },
      restoreSelection: (snap) => {
        // Replace the live selection with the snapshot an undone apply
        // consumed. Same invalidation as clearSelection: any in-flight
        // deep pass belongs to whatever selection is being replaced.
        deepSelGenRef.current++;
        deepSelReapplyRef.current = null;
        selStore.clear();
        let total = 0;
        for (const [key, idxs] of snap) {
          selStore.set(key, new Set(idxs));
          total += idxs.length;
        }
        // repaintLoaded rebuilds each node's selection bits from
        // selStore, so loaded nodes light up now; unloaded ones
        // rehydrate from selStore when they stream in (same path a
        // fresh paint selection uses).
        for (const [, ln] of loadedRef.current) {
          const key = patchNodeKey(ln.tile, ln.record);
          repaintLoaded(key, ln);
        }
        onSelectionChange(total);
      },
      applyToSelection: (action) => {
        // A deep pass may still be discovering unloaded points for the
        // current selection. Remember the action so the pass re-applies
        // it to the late arrivals when it lands — otherwise they'd stay
        // selected but silently unedited (the exact bug this whole
        // machinery exists to kill).
        if (deepSelPendingRef.current > 0) deepSelReapplyRef.current = action;
        return applyToSelectionImpl(action);
      },
      countSelected: () => countAll(),
      maxDeadwoodId: (channel) => {
        let mx = 0;
        for (const [, ln] of loadedRef.current) {
          const arr = channel === 'standing' ? ln.standingDeadwood : ln.layingDeadwood;
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) if (arr[i] > mx) mx = arr[i];
        }
        for (const entries of storeRef.current.map.values()) {
          for (const e of entries) {
            const v = channel === 'standing' ? e.standingDeadwood : e.layingDeadwood;
            if (v > mx) mx = v;
          }
        }
        return mx;
      },
      mergeTrees: async (fromIds, toId) => {
        const raw = remapRawRef.current;
        for (const f of fromIds) {
          if (f === toId || f <= 0) continue;
          raw.set(f, toId);
        }
        sharedUniformsRef.current.remap = flattenRemap(raw);
        setRemapVersion(v => v + 1);
        await writeTreemap(octree.dir, raw);
      },
      unmergeTree: async (fromId) => {
        remapRawRef.current.delete(fromId);
        sharedUniformsRef.current.remap = flattenRemap(remapRawRef.current);
        setRemapVersion(v => v + 1);
        await writeTreemap(octree.dir, remapRawRef.current);
      },
      clearMerges: async () => {
        remapRawRef.current = new Map();
        sharedUniformsRef.current.remap = new Map();
        setRemapVersion(v => v + 1);
        await writeTreemap(octree.dir, remapRawRef.current);
      },
      getMerges: () => [...remapRawRef.current.entries()].sort((a, b) => a[0] - b[0]),
      reloadNodes: () => {
        const group = groupRef.current;
        for (const ln of loadedRef.current.values()) {
          if (ln.obj) ln.obj.removeFromParent();
          ln.geom?.dispose();
          ln.material?.dispose();
        }
        for (const ln of pendingGpuRef.current) {
          ln.geom?.dispose();
          ln.material?.dispose();
        }
        // Drop any orphaned Points still parented (defensive).
        for (let i = group.children.length - 1; i >= 0; i--) group.children[i].removeFromParent();
        loadedRef.current.clear();
        pendingGpuRef.current = [];
        visibleSetRef.current.clear();
        loadedPointsRef.current = 0;
        // The two other cache resets clear these; this one did not, and
        // "in-flight loads settle on their own" was the problem rather
        // than the reasoning. reloadNodes runs precisely because
        // octree.bin was just rewritten, so a read already in flight
        // carries bytes that no longer exist — bumping the generation
        // makes it drop itself when it lands. The queue is dropped too:
        // its entries were planned against the old cache, and the
        // per-frame planner re-queues every visible node next tick.
        loadGenRef.current++;
        inFlightRef.current.clear();
        loadQueueRef.current = [];
      },
      setStreamingPaused: (paused) => { streamPausedRef.current = paused; },
      isolateStatus: () => {
        const fc = filtersRef.current;
        const id = fc.isolateTreeId;
        if (id === null) return null;
        const list = fc.isolateRecords && fc.isolateRecords.treeId === id ? fc.isolateRecords.records : null;
        const forced = list ? forcedRecordSet(list, octree.index) : null;
        let loaded = 0, pending = 0;
        if (forced) {
          for (const rec of forced) {
            if (loadedRef.current.has(rec)) loaded++;
            else if (inFlightRef.current.has(rec) || loadQueueRef.current.some(q => q.rec === rec)) pending++;
          }
        }
        let residentPoints = 0;
        for (const ln of loadedRef.current.values()) {
          const ids = ln.treeIds;
          for (let i = 0; i < ids.length; i++) if (ids[i] === id) residentPoints++;
        }
        let drawnPoints = 0;
        for (const ln of loadedRef.current.values()) {
          const ids = ln.treeIds;
          const v = ln.visibility;
          for (let i = 0; i < ids.length; i++) if (ids[i] === id && v[i]) drawnPoints++;
        }
        return {
          treeId: id, scanRecords: list ? list.length : null,
          forced: forced ? forced.size : 0, loaded, pending, residentPoints, drawnPoints,
        };
      },
      memoryInfo: () => ({
        loadedNodes: loadedRef.current.size,
        loadedPoints: loadedPointsRef.current,
        pendingGpu: pendingGpuRef.current.length,
        inFlight: inFlightRef.current.size,
        queued: loadQueueRef.current.length,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        programs: gl.info.programs?.length ?? 0,
      }),
      hasTreeIds: () => {
        for (const ln of loadedRef.current.values()) {
          const ids = ln.treeIds;
          for (let i = 0; i < ids.length; i++) if (ids[i] > 0) return true;
        }
        return false;
      },
    };
    editApiRef.current = api;
    return () => { editApiRef.current = null; };
  }, [octree, camera, size, editApiRef, onSelectionChange, storeRef, selectionStoreRef]);

  return null;
}

// ============================ Planner / loader ===================

/** Re-plan the visible set + load queue from the current camera.
 *  Walks every tile root, refines into children via priority queue
 *  ordered by screen-projected diameter, marks nodes visible until
 *  the point budget is hit, evicts old non-visible nodes LRU-style,
 *  and kicks off any missing loads. */
function planAndStream(
  octree: OpenOctree,
  camera: THREE.PerspectiveCamera,
  size: { width: number; height: number },
  loaded: Map<number, LoadedNode>,
  inFlight: Set<number>,
  pendingGpu: LoadedNode[],
  queue: Array<{ rec: number; weight: number }>,
  visible: Set<number>,
  loadedPointsRef: { current: number },
  frame: number,
  shared: SharedShaderUniforms,
  pointBudget: number,
  store: PatchStore,
  selectionStore: Map<PatchNodeKey, Set<number>>,
  displayRef: { current: DisplayConfig },
  filtersRef: { current: FilterConfig },
  previewRef: { current: SubsetPreview | null },
  /** Live cache generation — see loadNode's `gen` parameter. */
  genRef: { current: number },
  /** Smoothed camera velocity (scene units / s) for the predictive
   *  prefetch — pass a zero vector to disable. */
  camVel?: THREE.Vector3,
): void {
  const off = octree.meta.offset;
  const idx = octree.index;
  const records = octree.records;
  // Pixels per world unit at distance 1. Used both here (node pixel
  // diameter) and in the shader (point size).
  const projFactor = projFactorFor(camera.fov, size.height);
  shared.uProjFactor.value = projFactor;

  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(vp);

  const camX = camera.position.x;
  const camY = camera.position.y;
  const camZ = camera.position.z;
  const sphere = new THREE.Sphere();

  // Forced-detail region: when a tree is isolated for editing, Tree Review
  // sets filters.isolateBox to its world (source-CRS) bbox. Every node
  // whose source bbox intersects that box (dilated by isolateMargin) is
  // refined to full depth regardless of screen size, point budget AND
  // camera frustum (never evicted either), so the whole tree — crown to
  // stump, on-screen or not — is loaded + drawn + editable at any zoom,
  // not just the LOD the camera distance happens to pull in. What the
  // user sees while editing is therefore ALL of the tree's points, and a
  // lasso over it can never miss data that "wasn't streamed in yet".
  // Source axes: 0=X, 1=Y, 2=Z.
  const fc = filtersRef.current;
  // Same centroid-anchored clamp as applyFilters' ibox — a poorly
  // segmented tree (a few stray points scattered across the plot) used
  // to give a bbox that spanned half the dataset, which the planner then
  // forced to full LOD; that ate the whole point budget and starved the
  // rest of the scene of detail.
  const detailBox = fc.isolateTreeId !== null && fc.isolateBox
    ? detailBoxWorld(fc.isolateBox, fc.isolateAnchor ?? null, fc.isolateMargin ?? 0)
    : null;
  // True if record `rec`'s source-CRS bbox overlaps the forced-detail box.
  const inDetail = (rec: number): boolean =>
    detailBox !== null && bboxOverlapsDetail(idx.bbox, rec, detailBox);
  // …and the records the isolated tree's points actually live in, from
  // the scan, ancestors included — wherever they are. The detail box is
  // clamped around the trunk so a badly segmented tree cannot force half
  // the plot to full LOD; the price was that its far strays were never
  // loaded, and a cluster 50 m away carrying the same id was invisible
  // in review while TreeQSM fitted cylinders to it. Loading exactly
  // those records costs their points and nothing else. Tagged with the
  // tree so a list left over from another tree is ignored.
  const forcedRecords = fc.isolateTreeId !== null && fc.isolateRecords
    && fc.isolateRecords.treeId === fc.isolateTreeId
    ? forcedRecordSet(fc.isolateRecords.records, idx)
    : null;
  const forcedRec = (rec: number): boolean =>
    inDetail(rec) || (forcedRecords !== null && forcedRecords.has(rec));

  // Convert a record's source-CRS centre+radius into scene coords
  // (right-handed axis remap + offset subtraction — sceneZ = −north to
  // match decodeNodePoints, otherwise the frustum cull rejects the
  // mirrored half of the cloud and points pop in/out as you orbit) and
  // compute its screen pixel diameter. Returns -1 if outside the
  // frustum. The bounding sphere radius is invariant under reflection so
  // it stays as-is.
  const projDiameter = (rec: number): number => {
    const [sx, sy, sz] = sourceCentreToScene(
      idx.centre[rec * 3], idx.centre[rec * 3 + 1], idx.centre[rec * 3 + 2], off,
    );
    const r = idx.radius[rec];
    sphere.center.set(sx, sy, sz);
    // Grown by the terrain's relief: a flattened node's points are drawn
    // up to that far from their stored height (see shared.relief).
    sphere.radius = r + shared.relief;
    // intersectsSphere tests `distance < -radius`, which is FALSE for a
    // NaN centre or radius — a degenerate node is reported inside the
    // frustum rather than culled. pixelDiameter catches it.
    if (!frustum.intersectsSphere(sphere)) return NOT_VISIBLE;
    const dx = sx - camX, dy = sy - camY, dz = sz - camZ;
    return pixelDiameter(r, Math.sqrt(dx * dx + dy * dy + dz * dz), projFactor);
  };

  // Hysteresis: nodes that were visible in the PREVIOUS plan get a
  // relaxed pixel threshold and a small budget tolerance this plan. A
  // node sitting right at the cutoff used to flip in/out of the visible
  // set on consecutive re-plans (12 Hz) as the camera moved or damping
  // settled — each flip a fade-out + fade-in pulse, which read as the
  // cloud "blinking" in patches. The keep-band means a node must move
  // clearly below the threshold to drop out, so the set is stable for
  // small view changes. Bounded: the relaxation only applies to nodes
  // already in the set, so the total can't creep past ~1.15 × budget.
  const prevVisible = new Set(visible);

  // Seed the heap with every tile root in the frustum — plus any root
  // overlapping the forced-detail box even when it's OUT of the frustum,
  // so the whole isolated tree is resident regardless of where the
  // camera points. Without this, zooming into the stem left the crown
  // unloaded (off-frustum), and it popped in only when the camera turned
  // — the "I lassoed the branch but more of it appeared when I zoomed"
  // trap: what you see is not all there is.
  visible.clear();
  const heap = new MaxHeap();
  for (let t = 0; t < octree.meta.tiles.length; t++) {
    const rec = octree.tileRecordStarts[t];
    const r = records[rec];
    if (!r || r.byteSize === 0) continue;
    const w = projDiameter(rec);
    if (w < 0) {
      if (!forcedRec(rec)) continue;
      heap.push({ rec, weight: MIN_NODE_PIXEL_SIZE * 10 });
      continue;
    }
    heap.push({ rec, weight: w });
  }

  const newQueueRecs = new Set<number>();
  const newQueue: Array<{ rec: number; weight: number }> = [];
  let plannedPoints = 0;
  while (!heap.isEmpty()) {
    const top = heap.pop()!;
    const rec = top.rec;
    const isRoot = idx.levelOf[rec] === 0;
    // Nodes inside the forced-detail region (an isolated tree being
    // edited) always render + refine, ignoring the pixel threshold and
    // the budget, so the whole tree is present at any zoom.
    const forced = forcedRec(rec);
    // Tile roots always render — each holds ≤ ~4 k sparse sample points
    // (ACCEL_GRID³), so all in-frustum roots together stay well under
    // budget. Guaranteeing them means the overview never vanishes when
    // zoomed far out, nor when a close region spends the whole budget.
    // Non-roots obey the pixel threshold + the point budget, with the
    // hysteresis band for nodes already on screen (see prevVisible).
    if (!admits({
      isRoot, forced, wasVisible: prevVisible.has(rec),
      weight: top.weight, plannedPoints, pointBudget,
    })) continue;
    if (records[rec].byteSize === 0) continue;
    if (visible.has(rec)) continue;
    visible.add(rec);
    plannedPoints += records[rec].numPoints;
    const ln = loaded.get(rec);
    if (ln) {
      ln.lastUsedFrame = frame;
    } else if (!inFlight.has(rec) && !newQueueRecs.has(rec)) {
      let alreadyPending = false;
      for (let i = 0; i < pendingGpu.length; i++) {
        if (pendingGpu[i].recIdx === rec) { alreadyPending = true; break; }
      }
      if (!alreadyPending) {
        newQueueRecs.add(rec);
        newQueue.push({ rec, weight: top.weight });
      }
    }
    // Once the budget is spent, stop refining detail — but keep draining
    // the heap so any remaining (distant, low-weight) roots still get
    // shown. Forced-detail nodes ignore the budget so the isolated tree
    // always streams in full.
    if (!refines(plannedPoints, pointBudget, forced)) continue;
    // Refine into children whose own projection is large enough — OR that
    // sit inside the forced-detail region (refine those to full depth).
    const cs = idx.childrenStart[rec];
    const ce = idx.childrenStart[rec + 1];
    for (let k = cs; k < ce; k++) {
      const child = idx.childrenFlat[k];
      if (child === NO_RECORD) continue;
      if (records[child].byteSize === 0) continue;
      const childForced = forcedRec(child);
      const cw = projDiameter(child);
      // Children already on screen keep the relaxed threshold too, so a
      // refined branch doesn't collapse + re-refine across plans.
      // Children already on screen keep the relaxed threshold too, so a
      // refined branch doesn't collapse + re-refine across plans.
      if (!childForced && !meetsPixelThreshold(cw, prevVisible.has(child))) continue;
      // Forced children refine even OUTSIDE the frustum (cw = -1 there;
      // Math.max gives them the forced weight) — the isolated tree must
      // be fully resident no matter where the camera looks, so nothing
      // pops in mid-edit when the user orbits or zooms. Three.js still
      // frustum-culls the off-screen nodes at render time.
      heap.push({ rec: child, weight: childForced ? Math.max(cw, MIN_NODE_PIXEL_SIZE * 10) : cw });
    }
  }

  // NOTE: an experimental "replacement-LOD" pass once lived here — it
  // dropped a parent from the visible set when all its children were
  // GPU-resident, to avoid the additive-octree double-density. It made the
  // cloud flicker oddly even while the camera sat still (the parent/child
  // visible set kept flipping as nodes settled in/out of the "fully
  // covered" condition each re-plan), so it was reverted. We render the
  // additive set (parent AND children) — the original, stable behaviour.
  // Forced-detail (isolated-tree) nodes still load in full via the planner
  // loop above, so the editing workflow is unaffected.

  // LRU eviction once memory crosses 2 × budget. Tile roots stay
  // resident so a zoom-out always shows the overview instantly, and
  // forced-detail (isolated-tree) nodes are never evicted — the whole
  // tree must stay resident for the review-editing workflow even though
  // the planner marks them visible anyway (belt and braces: an edit to
  // the planner must not silently re-enable evicting the tree under the
  // user's lasso).
  const limit = pointBudget * EVICT_LIMIT_FACTOR;
  for (const ln of selectEvictions(
    loaded.values(),
    (rec) => visible.has(rec) || forcedRec(rec),
    loadedPointsRef.current, limit,
  )) {
    evictNode(ln, loadedPointsRef);
    loaded.delete(ln.recIdx);
  }

  // Predictive prefetch: when the camera is moving, run a second (load-
  // only) traversal from its position extrapolated PREFETCH_LOOKAHEAD_S
  // ahead, and append those nodes to the queue at reduced priority. The
  // visible set is untouched — these tiles just start their disk reads
  // early so they're resident by the time the camera arrives, instead of
  // popping in after every stop (the biggest perceived-latency gap vs
  // native viewers like RiSCAN Pro).
  const speed = camVel ? camVel.length() : 0;
  if (camVel && speed >= PREFETCH_MIN_SPEED) {
    const dx = camVel.x * PREFETCH_LOOKAHEAD_S;
    const dy = camVel.y * PREFETCH_LOOKAHEAD_S;
    const dz = camVel.z * PREFETCH_LOOKAHEAD_S;
    // Translating a frustum by d: a point x is inside iff (x − d) was
    // inside the original, i.e. each plane's constant shifts by −n·d.
    // Exact for translation; orientation is assumed unchanged over the
    // lookahead, which holds well at 0.3 s.
    const predFrustum = new THREE.Frustum();
    for (let i = 0; i < 6; i++) {
      const pl = predFrustum.planes[i];
      pl.copy(frustum.planes[i]);
      pl.constant -= pl.normal.x * dx + pl.normal.y * dy + pl.normal.z * dz;
    }
    const pCamX = camX + dx, pCamY = camY + dy, pCamZ = camZ + dz;
    const projDiameterPred = (rec: number): number => {
      const [sx, sy, sz] = sourceCentreToScene(
        idx.centre[rec * 3], idx.centre[rec * 3 + 1], idx.centre[rec * 3 + 2], off,
      );
      sphere.center.set(sx, sy, sz);
      sphere.radius = idx.radius[rec] + shared.relief;
      if (!predFrustum.intersectsSphere(sphere)) return NOT_VISIBLE;
      const ddx = sx - pCamX, ddy = sy - pCamY, ddz = sz - pCamZ;
      return pixelDiameter(
        idx.radius[rec], Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz), projFactor,
      );
    };
    const ph = new MaxHeap();
    for (let t = 0; t < octree.meta.tiles.length; t++) {
      const rec = octree.tileRecordStarts[t];
      const r = records[rec];
      if (!r || r.byteSize === 0) continue;
      const w = projDiameterPred(rec);
      if (w < 0) continue;
      ph.push({ rec, weight: w });
    }
    const seen = new Set<number>();
    let plannedPrefetch = 0;
    let queued = 0;
    while (!ph.isEmpty() && queued < PREFETCH_MAX_NODES) {
      const top = ph.pop()!;
      const rec = top.rec;
      if (seen.has(rec)) continue;
      seen.add(rec);
      const isRoot = idx.levelOf[rec] === 0;
      if (!isRoot) {
        if (!meetsPixelThreshold(top.weight, false)) continue;
        if (plannedPrefetch >= pointBudget) break;
      }
      if (records[rec].byteSize === 0) continue;
      plannedPrefetch += records[rec].numPoints;
      if (!loaded.has(rec) && !inFlight.has(rec) && !newQueueRecs.has(rec)) {
        let alreadyPending = false;
        for (let i = 0; i < pendingGpu.length; i++) {
          if (pendingGpu[i].recIdx === rec) { alreadyPending = true; break; }
        }
        if (!alreadyPending) {
          newQueueRecs.add(rec);
          // ×0.3 keeps every current-view load ahead of every prefetch.
          newQueue.push({ rec, weight: top.weight * 0.3 });
          queued++;
        }
      }
      const cs = idx.childrenStart[rec];
      const ce = idx.childrenStart[rec + 1];
      for (let k = cs; k < ce; k++) {
        const child = idx.childrenFlat[k];
        if (child === NO_RECORD) continue;
        if (records[child].byteSize === 0) continue;
        const cw = projDiameterPred(child);
        if (!meetsPixelThreshold(cw, false)) continue;
        ph.push({ rec: child, weight: cw });
      }
    }
  }

  // Replace the load queue with the freshly computed priorities.
  newQueue.sort((a, b) => b.weight - a.weight);
  queue.length = 0;
  for (let i = 0; i < newQueue.length; i++) queue.push(newQueue[i]);

  pumpQueue(
    octree, store, selectionStore, loaded, inFlight, pendingGpu,
    queue, shared, loadedPointsRef, displayRef, filtersRef, previewRef,
    genRef,
  );
}

function pumpQueue(
  octree: OpenOctree,
  store: PatchStore,
  selectionStore: Map<PatchNodeKey, Set<number>>,
  loaded: Map<number, LoadedNode>,
  inFlight: Set<number>,
  pendingGpu: LoadedNode[],
  queue: Array<{ rec: number; weight: number }>,
  shared: SharedShaderUniforms,
  loadedPointsRef: { current: number },
  displayRef: { current: DisplayConfig },
  filtersRef: { current: FilterConfig },
  previewRef: { current: SubsetPreview | null },
  /** Live cache generation — a load that finishes after reloadNodes()
   *  bumped this is decoded from bytes that no longer exist on disk. */
  genRef: { current: number },
): void {
  while (inFlight.size < MAX_NODES_LOADING && queue.length > 0) {
    const next = queue.shift()!;
    const rec = next.rec;
    if (loaded.has(rec) || inFlight.has(rec)) continue;
    inFlight.add(rec);
    const r = octree.records[rec];
    void loadNode(
      octree, rec, r.byteOffset, r.byteSize,
      store, selectionStore, shared, loaded, pendingGpu,
      loadedPointsRef, displayRef, filtersRef, previewRef,
      genRef.current, genRef,
    ).finally(() => {
      inFlight.delete(rec);
      if (queue.length > 0 && inFlight.size < MAX_NODES_LOADING) {
        pumpQueue(
          octree, store, selectionStore, loaded, inFlight, pendingGpu,
          queue, shared, loadedPointsRef, displayRef, filtersRef, previewRef,
          genRef,
        );
      }
    });
  }
}

function evictNode(
  ln: LoadedNode,
  loadedPointsRef: { current: number },
): void {
  if (ln.obj) {
    ln.obj.removeFromParent();
    ln.obj = null;
  }
  if (ln.geom) ln.geom.dispose();
  if (ln.material) ln.material.dispose();
  loadedPointsRef.current = releasePoints(loadedPointsRef.current, ln.numPoints);
}

async function loadNode(
  octree: OpenOctree,
  recIdx: number,
  byteOffset: number,
  byteSize: number,
  store: PatchStore,
  selectionStore: Map<PatchNodeKey, Set<number>>,
  shared: SharedShaderUniforms,
  loaded: Map<number, LoadedNode>,
  pendingGpu: LoadedNode[],
  loadedPointsRef: { current: number },
  displayRef: { current: DisplayConfig },
  filtersRef: { current: FilterConfig },
  previewRef: { current: SubsetPreview | null },
  /** Cache generation this load belongs to, and the live counter to
   *  compare against when it finishes. See the check before `loaded.set`
   *  below for what this is protecting. */
  gen: number,
  genRef: { current: number },
): Promise<void> {
  if (loaded.has(recIdx)) return;
  try {
    // Lazy extras: only materialise the columns something is actually
    // using right now — the two deadwood id channels (they feed the
    // always-on editing arrays below) and the extra the active colour
    // mode ramps over. On clouds with many extra columns this cuts the
    // per-point decode + resident JS memory from 4·N bytes to at most 12,
    // which is most of why a many-extras dataset used to stream slower
    // than a plain one. A column needed later (user switches colour mode)
    // hydrates via a ranged column read — see hydrateExtraColumn.
    const allExtraNames = (octree.meta.extras ?? []).map(e => e.name);
    const wanted = new Set<string>();
    for (const n of allExtraNames) {
      if (n === STANDING_DEADWOOD_EXTRA || n === LAYING_DEADWOOD_EXTRA) wanted.add(n);
    }
    const mode = displayRef.current.colorMode;
    if (typeof mode === 'string' && mode.startsWith('extra:')) {
      wanted.add(mode.slice('extra:'.length));
    }
    // The extra-range FILTER needs its column too, and it needs it up
    // front: the filter-apply effect hydrates the nodes that were
    // already loaded when the filter changed, but a node streaming in
    // afterwards (pan / zoom) is never revisited by that effect — it
    // would arrive without the column and, by the progressive rule in
    // applyFilters, draw its points unfiltered forever. Asking for the
    // column here is one extra sliced field on a read that is happening
    // anyway, and it keeps "what you see" honest as new tiles arrive.
    const exFilterName = filtersRef.current.extraRange?.name;
    if (exFilterName) wanted.add(exFilterName);
    // Column-extracting read (RDB2-style): Rust slices the wanted fields
    // out of the block before the IPC hop, so transfer + decode scale
    // with what's drawn, not with the file's column count.
    const decoded = await readNodePoints(
      octree.dir, byteOffset, byteSize,
      octree.meta.scale, octree.meta.offset, octree.meta.pointBytes,
      allExtraNames, wanted,
    );
    if (decoded.count === 0) return;

    const tile = octree.index.tileOf[recIdx];
    const level = octree.index.levelOf[recIdx];
    const spacing = octree.index.spacing[recIdx];

    // Cache the pristine decoded state so undo / unhide can restore.
    const originalPositions = new Float32Array(decoded.positions);
    const originalTreeIds = new Int32Array(decoded.treeIds);
    // Seed the editable semantic array with whatever the converter
    // imported from the LAS Extra-Bytes column (zeros for v1 files /
    // unsegmented imports). Patches override this in-memory.
    const semantic = new Uint8Array(decoded.semantic);
    const deleted = new Uint8Array(decoded.count);
    // Deadwood id channels — decoded as f32 extras under their reserved
    // names; we keep editable Int32Array copies (the ids are integers) so
    // patches can override per point. Null when the dataset doesn't carry
    // the columns (legacy v3 import predating the deadwood feature).
    const sdExtra = decoded.extras[STANDING_DEADWOOD_EXTRA];
    const ldExtra = decoded.extras[LAYING_DEADWOOD_EXTRA];
    const standingDeadwood = sdExtra ? f32ToI32(sdExtra) : null;
    const layingDeadwood = ldExtra ? f32ToI32(ldExtra) : null;
    const originalStandingDeadwood = standingDeadwood ? new Int32Array(standingDeadwood) : null;
    const originalLayingDeadwood = layingDeadwood ? new Int32Array(layingDeadwood) : null;
    // The Int32 copies above are the editable source of truth for the
    // deadwood channels (colouring, picking, patches); the decoded f32
    // views are never read again — drop them so they don't sit on the
    // heap (8 bytes/point on every loaded node).
    delete decoded.extras[STANDING_DEADWOOD_EXTRA];
    delete decoded.extras[LAYING_DEADWOOD_EXTRA];
    const patchKey = patchNodeKey(tile, recIdx) as unknown as PatchNodeKey;
    const entries = store.map.get(patchKey);
    applyToNode(decoded.treeIds, semantic, deleted, decoded.positions, originalPositions, entries, standingDeadwood, layingDeadwood);

    // Node extents from the PRISTINE positions (always finite — deletes
    // only NaN the live copy). minY/maxY feed the height ramp fallback;
    // the full min/max corner pair becomes the quantisation frame.
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < decoded.count; i++) {
      const x = originalPositions[i * 3];
      const y = originalPositions[i * 3 + 1];
      const z = originalPositions[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (!Number.isFinite(minY)) { minX = 0; maxX = 1; minY = 0; maxY = 1; minZ = 0; maxZ = 1; }

    // Rehydrate session-wide selection bits.
    let selection: Uint8Array | null = null;
    const selSet = selectionStore.get(patchKey);
    if (selSet && selSet.size > 0) {
      selection = new Uint8Array(decoded.count);
      for (const i of selSet) if (i < selection.length) selection[i] = 1;
    }

    const colors = new Uint8Array(decoded.count * 3);
    // aVisible defaults to 1 (drawn); applyFilters below overrides
    // entries to 0 wherever the active filters reject the point.
    const visibility = new Uint8Array(decoded.count);
    visibility.fill(1);
    const geom = new THREE.BufferGeometry();
    // GPU positions: node-relative quantised uint16 (normalized — the
    // shader sees [0,1] and dequantises via uQOrigin/uQSize). Halves
    // position VRAM + upload vs float32.
    //
    // Precision is the node's own extent / 65535, so it depends on the
    // level: a few micrometres on a leaf node, but ~8 mm on the root of
    // a 500 m plot, which is the coarse overview LOD you only ever see
    // from far away. Saying "sub-mm on typical nodes" was true of the
    // nodes you look at closely and not of the ones you don't. Nothing
    // measured is affected either way — the float copy stays CPU-side
    // and is what picking, selection, measurement and the ramps read.
    const qOrigin: [number, number, number] = [minX, minY, minZ];
    const qSize: [number, number, number] = [
      Math.max(maxX - minX, 1e-6),
      Math.max(maxY - minY, 1e-6),
      Math.max(maxZ - minZ, 1e-6),
    ];
    const qPositions = new Uint16Array(decoded.count * 3);
    const posAttr = new THREE.BufferAttribute(qPositions, 3, true);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', posAttr);
    // colour + aVisible are both rewritten at runtime — colour on every
    // selection / recolour / highlight, aVisible on every filter change.
    // Both are marked DynamicDrawUsage so the driver expects frequent
    // re-uploads: WebView2 has been flaky honouring needsUpdate on a
    // StaticDrawUsage points attribute, which left selection red + the
    // hide filters not actually showing on screen.
    const colorAttr = new THREE.BufferAttribute(colors, 3, true);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('color', colorAttr);
    const visAttr = new THREE.BufferAttribute(visibility, 1);
    visAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aVisible', visAttr);
    // Depth-cue flag per point (see LoadedNode.dim) — rewritten on every
    // recolour, so dynamic like colour/aVisible.
    const dim = new Uint8Array(decoded.count);
    const dimAttr = new THREE.BufferAttribute(dim, 1);
    dimAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('aDim', dimAttr);
    // computeBoundingSphere() would read the raw quantised values; set
    // the sphere from the known node extents instead (frustumCulled
    // relies on it).
    geom.boundingSphere = new THREE.Sphere(
      new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2),
      Math.sqrt(qSize[0] * qSize[0] + qSize[1] * qSize[1] + qSize[2] * qSize[2]) / 2 + 1e-3,
    );

    const material = makeNodeMaterial(shared, spacing, qOrigin, qSize);

    const ln: LoadedNode = {
      geom, level,
      treeIds: decoded.treeIds,
      intensity: decoded.intensity,
      classification: decoded.classification,
      returnNumber: decoded.returnNumber,
      filterPass: 0,
      extras: decoded.extras,
      semantic, deleted, selection,
      standingDeadwood, layingDeadwood,
      originalStandingDeadwood, originalLayingDeadwood,
      visibility,
      dim,
      positions: decoded.positions,
      qPositions, qOrigin, qSize,
      originalPositions, originalTreeIds,
      originalSemantic: new Uint8Array(decoded.semantic),
      tile, record: recIdx,
      recIdx, numPoints: decoded.count, spacing,
      heightMin: minY, heightMax: maxY,
      lastUsedFrame: 0,
      fade: 0,
      material, obj: null,
    };
    // Encode the (post-patch) live positions into the GPU buffer.
    syncQuantizedPositions(ln);
    applyRemapInPlace(ln.treeIds, shared.remap);
    // Whole-cloud Z range in scene-Y (positions[1] = sourceZ − offset[2]),
    // so the height ramp runs once bottom-to-top across the entire cloud
    // instead of per-node — otherwise every tile remapped its own thin Z
    // slab to the full ramp and the cloud looked banded.
    // …or, when the streamer has set one, ITS span — the 'height' ramp
    // over height above ground needs the terrain the streamer holds.
    const globalHeightSpan: HeightSpan = shared.heightSpan ?? {
      lo: octree.meta.boundingBox.min[2] - octree.meta.offset[2],
      hi: octree.meta.boundingBox.max[2] - octree.meta.offset[2],
    };
    // Cloud-wide X / Y spans in SCENE coords (sceneZ = −northSource) so
    // 'x' and 'y' colour modes ramp once edge-to-edge across the whole
    // dataset instead of remapping each tile's local slab to the full
    // ramp (the visible-banding bug).
    const globalAxisSpans = {
      x: {
        lo: octree.meta.boundingBox.min[0] - octree.meta.offset[0],
        hi: octree.meta.boundingBox.max[0] - octree.meta.offset[0],
      },
      y: {
        lo: -(octree.meta.boundingBox.max[1] - octree.meta.offset[1]),
        hi: -(octree.meta.boundingBox.min[1] - octree.meta.offset[1]),
      },
    };
    // Cloud-wide intensity span (metadata.intensityRange) — absent on
    // datasets imported before this field existed, or whose intensity had
    // no usable spread; colorNode falls back to a per-node scan then.
    const globalIntensitySpan = octree.meta.intensityRange
      ? { lo: octree.meta.intensityRange[0], hi: octree.meta.intensityRange[1] }
      : undefined;
    // Cloud-wide extras min/max from metadata so `extra:<name>` mode maps
    // every tile through the same value→colour bucket; a user override
    // from displayRef.current.extraRangeOverrides wins on a per-extra
    // basis (lets the user squeeze the ramp into a sub-range when
    // outliers compress the useful band). Cheap object — recomputed per
    // node load but iterates only the few extras the file carries.
    const globalExtraRanges: Record<string, { lo: number; hi: number }> = {};
    for (const e of octree.meta.extras ?? []) {
      globalExtraRanges[e.name] = { lo: e.min, hi: e.max };
    }
    for (const [name, r] of Object.entries(displayRef.current.extraRangeOverrides ?? {})) {
      if (Number.isFinite(r.lo) && Number.isFinite(r.hi) && r.hi > r.lo) {
        globalExtraRanges[name] = { lo: r.lo, hi: r.hi };
      }
    }
    colorNode(ln, displayRef.current.colorMode, displayRef.current.ramp, { tree: shared.activeTreeId, standing: shared.activeStandingId, laying: shared.activeLayingId }, shared.activeTreeRgb, globalHeightSpan, globalExtraRanges, shared.unlabeledRgb, globalAxisSpans, globalIntensitySpan);
    ln.filterPass = applyFilters(ln, filtersRef.current, octree.meta.offset);
    applyPreviewClip(ln, previewRef.current, octree.meta.offset);
    (geom.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (geom.attributes.aVisible as THREE.BufferAttribute).needsUpdate = true;

    // The bytes this node was decoded from may already be stale.
    //
    // reloadNodes() runs after every native command that REWRITES
    // octree.bin — ground classification, segmentation, skeleton
    // transfer — and its whole job is to throw away what was cached
    // because the file changed underneath it. A read issued before that
    // point, or overlapping the rewrite itself, settles afterwards
    // carrying pre-operation (or half-written) bytes, and publishing it
    // drops a node with the OLD tree ids or classification in among
    // correctly reloaded ones. Nothing distinguishes it on screen: it is
    // the same failure as the stale cache that survived a same-directory
    // reopen, on the path that reopen never touched.
    if (gen !== genRef.current) {
      geom.dispose();
      material.dispose();
      return;
    }
    loaded.set(recIdx, ln);
    pendingGpu.push(ln);
    loadedPointsRef.current += decoded.count;
  } catch (e) {
    console.warn(`octree node rec=${recIdx} load failed`, e);
  }
}

/** Recompute the colour buffer for one loaded node, in place. Selection
 *  always wins over the mode-driven colour so the user can see what
 *  they've picked regardless of which attribute is active.
 *
 *  `extraRanges` lets the caller pass the cloud-wide min/max of every
 *  extra column (from metadata.extras) so an `extra:<name>` mode ramps
 *  uniformly across tiles. Missing keys fall back to per-node range. */
function refreshNodeColors(
  ln: LoadedNode, mode: ColorMode, ramp: ColorRamp = 'forest',
  heightSpan?: HeightSpan,
  extraRanges?: Record<string, { lo: number; hi: number }>,
  unlabeledRgb: [number, number, number] = [120, 120, 120],
  /** Cloud-wide X / Y spans in SCENE coords. Plumbed in so the X and Y
   *  ramps stretch ONCE edge-to-edge across the dataset (otherwise each
   *  tile's per-node range remapped to the full ramp and the cloud
   *  rendered in banded intervals). Falls back to a per-node sweep when
   *  not provided so the function stays drop-in. */
  axisSpans?: { x?: { lo: number; hi: number }; y?: { lo: number; hi: number } },
  /** Cloud-wide intensity span (metadata.intensityRange, recorded at
   *  import or backfilled via octree_intensity_range). Present ⇒ ramp
   *  over it so every tile maps the same raw intensity to the same
   *  colour. Absent ⇒ fall back to this node's own observed min/max —
   *  the pre-existing per-node behaviour, kept for datasets that haven't
   *  had the range computed yet (see the intensity branch below). */
  intensitySpan?: { lo: number; hi: number },
): void {
  const colorAttr = ln.geom.attributes.color as THREE.BufferAttribute | undefined;
  if (!colorAttr) return;
  const colors = colorAttr.array as Uint8Array;
  const count = ln.treeIds.length;
  const positions = ln.positions;
  const ur0 = unlabeledRgb[0], ur1 = unlabeledRgb[1], ur2 = unlabeledRgb[2];
  // Height ramp uses the WHOLE-cloud Z range so the gradient runs
  // bottom-to-top once across the dataset. Falling back to per-node
  // range made every node remap its own slab of points to the full
  // ramp, producing the banded "intervals" look the user reported.
  const lo = heightSpan ? heightSpan.lo : ln.heightMin;
  const hi = heightSpan ? heightSpan.hi : ln.heightMax;
  const span = Math.max(hi - lo, 1e-6);
  const rgb: [number, number, number] = [0, 0, 0];
  // `extra:<name>` — colour by an arbitrary numeric extra column carried
  // from the source LAS file. Uses the cloud-wide observed range from
  // metadata.extras so every tile maps the same value to the same colour;
  // missing range falls back to a per-node sweep so the ramp is still
  // meaningful. Unknown extras drop to flat so the viewport doesn't go
  // black on a malformed mode string.
  if (typeof mode === 'string' && mode.startsWith('extra:')) {
    const name = mode.slice('extra:'.length);
    const arr = ln.extras[name];
    if (!arr) {
      for (let i = 0; i < count; i++) {
        if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; continue; }
        colors[i * 3] = 180; colors[i * 3 + 1] = 180; colors[i * 3 + 2] = 180;
      }
      return;
    }
    let eLo: number, eHi: number;
    const r = extraRanges?.[name];
    if (r && r.hi > r.lo) { eLo = r.lo; eHi = r.hi; }
    else {
      eLo = Infinity; eHi = -Infinity;
      for (let i = 0; i < count; i++) {
        const v = arr[i];
        if (!Number.isFinite(v)) continue;
        if (v < eLo) eLo = v; if (v > eHi) eHi = v;
      }
      if (!Number.isFinite(eLo) || eHi <= eLo) { eLo = 0; eHi = 1; }
    }
    const eSpan = Math.max(eHi - eLo, 1e-6);
    for (let i = 0; i < count; i++) {
      if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; continue; }
      const v = arr[i];
      const t = Number.isFinite(v) ? (v - eLo) / eSpan : 0;
      rampColor(ramp, t, rgb);
      colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
    }
    return;
  }
  if (mode === 'intensity') {
    // Cloud-wide span (metadata.intensityRange, recorded at import or
    // backfilled on demand via octree_intensity_range) — every tile maps
    // the same raw intensity to the same colour, so no per-node scan is
    // needed at all; that per-node scan is exactly what used to make two
    // tiles paint the same raw value differently (the banding bug height
    // / x / y were already fixed for via their own cloud-wide spans).
    if (intensitySpan) {
      const iLo = intensitySpan.lo, iHi = intensitySpan.hi;
      const iSpan = Math.max(iHi - iLo, 1e-6);
      for (let i = 0; i < count; i++) {
        if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; continue; }
        rampColor(ramp, (ln.intensity[i] - iLo) / iSpan, rgb);
        colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
      }
      return;
    }
    // Fallback for datasets that don't have metadata.intensityRange yet —
    // imported before the field existed, and not backfilled via the
    // Display panel's "Compute intensity range" button. Normalises over
    // this NODE's own observed min/max, same as every dataset did before
    // the cloud-wide span existed: two tiles CAN paint the same raw value
    // differently here, but a banded cloud still beats an uncoloured one,
    // and the banding disappears the moment the range is known.
    //
    // Degenerate ranges (intensity column missing in the source → all
    // zeros) used to leave imin = imax → ispan-as-Math.max(0,1) = 1 and
    // t = (0 − 0) / 1 = 0, which is fine on its own; but it then
    // primed switches to other ramp modes to produce NaN t values where
    // the per-node range fell through to bad fallbacks. Harden: if no
    // values are usable, paint a single ramp colour and bail.
    let imin = Infinity, imax = -Infinity;
    for (let i = 0; i < count; i++) {
      const v = ln.intensity[i];
      if (v < imin) imin = v; if (v > imax) imax = v;
    }
    if (!Number.isFinite(imin) || imax <= imin) {
      rampColor(ramp, 0, rgb);
      for (let i = 0; i < count; i++) {
        if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; continue; }
        colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
      }
      return;
    }
    const ispan = imax - imin;
    for (let i = 0; i < count; i++) {
      if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; continue; }
      rampColor(ramp, (ln.intensity[i] - imin) / ispan, rgb);
      colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
    }
    return;
  }
  if (mode === 'classification') {
    for (let i = 0; i < count; i++) {
      if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; continue; }
      const [r, g, b] = classColor(ln.classification[i]);
      colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
    }
    return;
  }
  if (mode === 'tree_id') {
    for (let i = 0; i < count; i++) {
      if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; continue; }
      const id = ln.treeIds[i];
      if (id <= 0) { colors[i * 3] = ur0; colors[i * 3 + 1] = ur1; colors[i * 3 + 2] = ur2; }
      else { const [r, g, b] = treeIdColor(id); colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b; }
    }
    return;
  }
  if (mode === 'semantic') {
    // 1 = stem (warm brown), 2 = branch (green), 0 = unlabelled (the
    // user-pickable unlabeledColor). Matches the Stem / Branch toolbar
    // buttons so the user sees what they're labelling.
    const sem = ln.semantic;
    for (let i = 0; i < count; i++) {
      if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; continue; }
      const s = sem ? sem[i] : 0;
      if (s === 1)       { colors[i * 3] = 175; colors[i * 3 + 1] = 110; colors[i * 3 + 2] = 60;  }
      else if (s === 2)  { colors[i * 3] = 70;  colors[i * 3 + 1] = 180; colors[i * 3 + 2] = 90;  }
      else               { colors[i * 3] = ur0; colors[i * 3 + 1] = ur1; colors[i * 3 + 2] = ur2; }
    }
    return;
  }
  if (mode === 'standing_deadwood' || mode === 'laying_deadwood') {
    // One channel per colour mode so the two are inspected + edited
    // independently. The active-id highlight is overlaid afterwards in
    // colorNode (Shift+click picks the id under the cursor and that
    // instance reads as the pink active-tree colour).
    const arr = mode === 'standing_deadwood' ? ln.standingDeadwood : ln.layingDeadwood;
    const ch: 'standing' | 'laying' = mode === 'standing_deadwood' ? 'standing' : 'laying';
    for (let i = 0; i < count; i++) {
      if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; continue; }
      const id = arr ? arr[i] : 0;
      if (id > 0) {
        const [r, g, b] = deadwoodColor(id, ch);
        colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
      } else {
        colors[i * 3] = ur0; colors[i * 3 + 1] = ur1; colors[i * 3 + 2] = ur2;
      }
    }
    return;
  }
  if (mode === 'flat') {
    for (let i = 0; i < count; i++) {
      if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; }
      else { colors[i * 3] = 180; colors[i * 3 + 1] = 180; colors[i * 3 + 2] = 180; }
    }
    return;
  }
  // 'x' / 'y' ramp over the axis (scene coords). sceneX = positions[0]
  // (east), sceneZ = positions[2] (−north — the editor's right-handed
  // remap). Use the cloud-wide span when the caller supplied it so the
  // ramp paints the whole dataset edge-to-edge in ONE pass instead of
  // re-stretching to each tile's local slab (which produced visible
  // banding intervals per tile — the original bug report).
  if (mode === 'x' || mode === 'y') {
    const axis = mode === 'x' ? 0 : 2;
    const global = mode === 'x' ? axisSpans?.x : axisSpans?.y;
    let aLo: number, aHi: number;
    if (global && Number.isFinite(global.lo) && Number.isFinite(global.hi) && global.hi > global.lo) {
      aLo = global.lo; aHi = global.hi;
    } else {
      aLo = Infinity; aHi = -Infinity;
      for (let i = 0; i < count; i++) {
        const v = positions[i * 3 + axis];
        if (!Number.isFinite(v)) continue;
        if (v < aLo) aLo = v; if (v > aHi) aHi = v;
      }
      if (!Number.isFinite(aLo) || aHi <= aLo) { aLo = 0; aHi = 1; }
    }
    const aSpan = Math.max(aHi - aLo, 1e-6);
    for (let i = 0; i < count; i++) {
      if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; continue; }
      const v = positions[i * 3 + axis];
      const t = Number.isFinite(v) ? (v - aLo) / aSpan : 0;
      rampColor(ramp, t, rgb);
      colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
    }
    return;
  }
  // height — NaN-safe over deleted (NaN-position) points so rampColor
  // never sees a non-finite t. Over height above ground when the span
  // carries the terrain: the ground under the point comes off first.
  const shift = heightSpan?.shift;
  for (let i = 0; i < count; i++) {
    if (ln.selection && ln.selection[i]) { colors[i * 3] = 230; colors[i * 3 + 1] = 30; colors[i * 3 + 2] = 50; continue; }
    const y = positions[i * 3 + 1];
    const v = shift && Number.isFinite(y) ? y - shift(positions[i * 3], positions[i * 3 + 2]) : y;
    const t = Number.isFinite(v) ? (v - lo) / span : 0;
    rampColor(ramp, t, rgb);
    colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
  }
}

/** Colour a node for the given mode, then overlay the active-id
 *  highlight. The highlight is shown for the id-channel edit modes
 *  (tree_id and the two deadwood channels) so the user sees which
 *  instance the tools will paint into; semantic / scalar / flat modes
 *  stay pure. The active id per channel is plumbed through
 *  `activeIds`. This is the single entry point all callers use so a
 *  freshly-streamed node and a recolour-on-change behave identically. */
function colorNode(
  ln: LoadedNode, mode: ColorMode, ramp: ColorRamp,
  activeIds: { tree: number; standing: number; laying: number },
  activeRgb: [number, number, number],
  heightSpan?: HeightSpan,
  extraRanges?: Record<string, { lo: number; hi: number }>,
  unlabeledRgb: [number, number, number] = [120, 120, 120],
  axisSpans?: { x?: { lo: number; hi: number }; y?: { lo: number; hi: number } },
  /** Cloud-wide intensity span (metadata.intensityRange) — see
   *  refreshNodeColors for how it's used. */
  intensitySpan?: { lo: number; hi: number },
): void {
  refreshNodeColors(ln, mode, ramp, heightSpan, extraRanges, unlabeledRgb, axisSpans, intensitySpan);
  if (mode === 'tree_id' && activeIds.tree > 0) {
    applyActiveHighlight(ln, ln.treeIds, activeIds.tree, activeRgb);
  } else if (mode === 'standing_deadwood' && activeIds.standing > 0 && ln.standingDeadwood) {
    applyActiveHighlight(ln, ln.standingDeadwood, activeIds.standing, activeRgb);
  } else if (mode === 'laying_deadwood' && activeIds.laying > 0 && ln.layingDeadwood) {
    applyActiveHighlight(ln, ln.layingDeadwood, activeIds.laying, activeRgb);
  }
  // Refresh the depth-cue flags: in tree_id mode the unassigned (grey)
  // points are the dimmable background; selected points stay full so the
  // red picks never fade. Other modes carry no background semantics. The
  // shader-side uDimEnabled gate keeps this inert outside Tree Review's
  // isolate, so the flag write is unconditional and cheap.
  if (ln.dim) {
    const dim = ln.dim;
    if (mode === 'tree_id') {
      const ids = ln.treeIds;
      const sel = ln.selection;
      for (let i = 0; i < dim.length; i++) {
        dim[i] = ids[i] <= 0 && !(sel && sel[i]) ? 1 : 0;
      }
    } else {
      dim.fill(0);
    }
    const da = ln.geom?.attributes.aDim as THREE.BufferAttribute | undefined;
    if (da) da.needsUpdate = true;
  }
}

/** Recompute the per-point visibility mask from the active filters. A
 *  point passes (visibility[i] = 1) iff it survives EVERY active filter
 *  (logical AND). Filters are non-destructive: clearing one re-runs
 *  this and the points come back next frame. Cheap — one linear pass
 *  per node, no allocations.
 *
 *  `offset` is the dataset's metadata.offset, used to turn the X/Y/Z
 *  world-coordinate range filters into the node's scene-local positions
 *  (positions[i*3] = worldX − offset[0], +1 = worldZ − offset[2] (height),
 *  +2 = worldY − offset[1]). Converted once per node, not per point.
 *
 *  Returns how many of this node's points passed, so callers can tally a
 *  live match count (Filters panel) without a second per-point pass. */
function applyFilters(ln: LoadedNode, f: FilterConfig, offset: [number, number, number]): number {
  const v = ln.visibility;
  const ids = ln.treeIds;
  const cls = ln.classification;
  const pos = ln.positions;
  const del = ln.deleted;
  const n = ids.length;
  const hideUnassigned = f.hideUnassigned;
  const isolate = f.isolateTreeId;
  const isolateKeepUnassigned = f.isolateShowUnassigned;
  const range = f.treeIdRange;
  const rangeMin = range ? range[0] : 0;
  const rangeMax = range ? range[1] : 0;
  // World→scene-local conversion for the spatial range filters, done once.
  // Scene axes (see decodeNodePoints): positions[0] = worldX − offX,
  // positions[1] = worldZ − offZ (elevation), positions[2] = −(worldY −
  // offY) (north, negated). The Y(north) world range therefore maps to a
  // negated + swapped scene-Z interval. Compared in scene-local space to
  // avoid a per-point add.
  const xr = f.xRange ? eastRangeToScene(f.xRange, offset) : null;
  const yr = f.yRange ? northRangeToScene(f.yRange, offset) : null;
  const zr = f.zRange ? upRangeToScene(f.zRange, offset) : null;
  // Arbitrary-orientation slab. The user supplies (anchor, normal,
  // halfHeight) in WORLD coords; per-point we test
  //   |(p_world − anchor) · normal| ≤ halfHeight
  // The CPU loop sees positions in SCENE-local coords where the
  // converter applied the same swap-and-negate the decoder uses
  // (sceneX = worldX − offX, sceneY = worldZ − offZ, sceneZ = −(worldY
  // − offY)). Rewriting the plane test in scene coords gives a
  // remapped normal (nx_world, nz_world, −ny_world) and a constant
  // offset folded into the plane equation. Pre-computed here so the
  // hot inner loop is a single dot product + abs() per point.
  //
  // The per-point tests below call filterGeometry's slabDistance and
  // inBox rather than repeating their arithmetic. They used to be
  // written out here — a slab dot product and two box comparisons,
  // inline, the box test twice — while the extracted versions were the
  // ones with tests. That is the shape this audit keeps finding: the
  // tested copy and the running copy are not the same copy.
  //
  // Inlining them was for speed, and that turned out not to be true.
  // Measured over 12M points, seven runs, median: 47.7 ms written out
  // against 45.6 ms through the helpers — the calls are 4% FASTER, V8
  // having inlined them anyway. There was nothing to trade.
  const slab = f.planeSlab ? slabToScene(f.planeSlab, offset) : null;
  // Viewpoint-based Hidden Point Removal — Z-buffer against the
  // depth map the Scan-inspection panel built. Per point we recover
  // its world XYZ (scene + offset, with the same swap-and-negate the
  // decoder did), compute its (azimuth, elevation) from the viewpoint
  // in the SAME compass convention the backend used (0 = north, π/2
  // = east), look up the closest range in that angular bin, and only
  // keep the point if its range ≤ binDepth + tolerance.
  let vpOn = false;
  let vpx = 0, vpy = 0, vpz = 0;
  let vpAz = 0, vpEl = 0;
  let vpInvAz = 0, vpInvEl = 0;
  let vpDepth: Float32Array | null = null;
  let vpTol = 0;
  if (f.viewpointHpr) {
    const v = f.viewpointHpr;
    vpx = v.viewpoint[0]; vpy = v.viewpoint[1]; vpz = v.viewpoint[2];
    vpAz = v.azBins; vpEl = v.elBins;
    vpInvAz = v.azBins / (2 * Math.PI);
    vpInvEl = v.elBins / Math.PI;
    vpDepth = v.depth;
    vpTol = v.tolerance;
    vpOn = vpDepth.length === v.azBins * v.elBins && vpTol >= 0;
  }
  const halfPi = Math.PI / 2;
  const twoPi = Math.PI * 2;
  // Isolated-tree neighbourhood box (scene-local). When showing
  // unassigned points around an isolated tree, only those inside this box
  // pass — so the stray points right around the tree light up rather than
  // every unassigned point in the cloud. The clamping and the anchoring,
  // and why both exist, are in three/filterGeometry.
  const showOthers = f.isolateShowOthers;
  // WHICH neighbours, when they are shown at all. null = every tree in
  // the box.
  //
  // A direct-indexed table beats a Set for something read once per point
  // over millions of them — but only while the ids stay small. Tree ids
  // written by this app's own segmentation are 1..T, yet an IMPORTED
  // tree_id column is an arbitrary i32, and sizing a table off one of
  // those would try to allocate gigabytes for a handful of picks. Past a
  // megabyte's worth the Set is the right structure and the difference
  // no longer matters, because a plot with a million distinct tree ids
  // is not one anybody is hand-picking neighbours in.
  const OTHER_TABLE_MAX = 1 << 20;
  let otherMask: Uint8Array | null = null;
  let otherSet: Set<number> | null = null;
  if (showOthers && f.isolateOtherIds !== null) {
    let hi = 0;
    for (const id of f.isolateOtherIds) if (id > hi) hi = id;
    if (hi < OTHER_TABLE_MAX) {
      otherMask = new Uint8Array(hi + 1);
      for (const id of f.isolateOtherIds) if (id > 0) otherMask[id] = 1;
    } else {
      otherSet = new Set(f.isolateOtherIds);
    }
  }
  let ibox: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number } | null = null;
  // Computed whenever an isolate box exists (not only under the opt-ins):
  // since the "Hide unassigned" toggle now governs unassigned during
  // isolation too, the box must be ready to scope them even when neither
  // opt-in is set.
  if (isolate !== null && f.isolateBox) {
    ibox = isolateBoxToScene({
      box: f.isolateBox,
      anchor: f.isolateAnchor ?? null,
      margin: f.isolateMargin ?? 0,
      zRange: f.isolateZRange ?? null,
    }, offset);
  }
  // The band's elevation bounds on their own, for cutting the isolated
  // tree. Taken from the same box the neighbours are clipped by, so the
  // slice through the tree and the slice through everything around it
  // are the identical band and cannot drift apart.
  const treeBandY: [number, number] | null =
    (ibox && f.isolateZBandCutsTree && f.isolateZRange) ? [ibox.y0, ibox.y1] : null;
  // Build a 256-byte lookup table for the class filter — O(1) check
  // per point and amortised free even for >1 M points.
  const classMask = f.hiddenClasses.length > 0
    ? (() => {
        const m = new Uint8Array(256);
        for (const c of f.hiddenClasses) if (c >= 0 && c < 256) m[c] = 1;
        return m;
      })()
    : null;
  // Same O(1) mask for the semantic hide-list. semArr is null on any node
  // that hasn't decoded a semantic column, AND undefined on the pseudo
  // node the deep-selection pass builds for UNLOADED nodes (that path
  // fetches only positions/treeIds/classification over the wire and casts
  // the result to LoadedNode, so the other columns simply aren't there).
  // The truthy check treats both the same, and every read of semArr must
  // stay guarded rather than assume the column exists.
  const semArr = ln.semantic;
  const semMask = (f.hiddenSemantic.length > 0 && semArr)
    ? (() => {
        const m = new Uint8Array(256);
        for (const c of f.hiddenSemantic) if (c >= 0 && c < 256) m[c] = 1;
        return m;
      })()
    : null;
  // Same idea for the return-number hide-list. LAS return_number runs
  // 0..7 (0 = unset/unknown — plenty of terrestrial TLS/MLS scans never
  // populate it), so 256 slots is overkill on range but still O(1) and
  // free to build. retArr is guarded exactly like semArr: it's undefined
  // on the deep-selection pseudo node, which only ever carries
  // visibility/treeIds/classification/positions/deleted.
  const retArr = ln.returnNumber;
  const retMask = (f.hiddenReturns.length > 0 && retArr)
    ? (() => {
        const m = new Uint8Array(256);
        for (const r of f.hiddenReturns) if (r >= 0 && r < 256) m[r] = 1;
        return m;
      })()
    : null;
  // Single-column extra-value range filter. loadNode only decodes the
  // extra columns something is actively using (see hydrateExtraColumn),
  // so a node that hasn't hydrated the named column yet simply has no
  // entry for it: exArr comes back undefined and this node is NOT
  // filtered by extraRange until the hydration lands and the filter-apply
  // effect re-runs applyFilters on it. Same progressive idea as the
  // colour mode painting a flat fallback and recolouring as columns
  // arrive — must never throw and must never blank a node.
  const exR = f.extraRange;
  const exArr = exR && ln.extras ? ln.extras[exR.name] : undefined;
  const exLo = exR ? exR.lo : 0;
  const exHi = exR ? exR.hi : 0;
  // Deadwood channels are equally absent on the pseudo node, and null on
  // any real dataset imported before the deadwood extras existed. "Only
  // deadwood" only makes sense when at least one channel is actually
  // present — leaving it "on" over a column-less dataset would blank the
  // whole view instead of doing nothing, so it's forced off here.
  const standArr = ln.standingDeadwood;
  const layArr = ln.layingDeadwood;
  const hideStanding = f.hideStandingDeadwood;
  const hideLaying = f.hideLayingDeadwood;
  const onlyDeadwoodOn = f.onlyDeadwood && (!!standArr || !!layArr);
  // Raw stored-intensity range. ln.intensity is always allocated on a real
  // node but — like the columns above — absent on the pseudo node, so it
  // gets the same existence guard rather than being assumed present.
  const intensityArr = ln.intensity;
  const ir = f.intensityRange;
  const irLo = ir ? ir[0] : 0;
  const irHi = ir ? ir[1] : 0;
  // Count of points that pass, returned to the caller — the filter-apply
  // effect tallies this across every loaded node for the Filters panel's
  // live match-count readout.
  let passCount = 0;
  for (let i = 0; i < n; i++) {
    // Deleted points are always hidden. This used to ride implicitly on
    // their NaN positions (NaN never rasterises), but the GPU now draws
    // quantised uints — NaN can't ride along — so the mask is explicit.
    if (del && del[i]) { v[i] = 0; continue; }
    const id = ids[i];
    let pass: boolean;
    // Unassigned (id ≤ 0) and assigned (id > 0) points obey DIFFERENT
    // controls so the two never fight:
    //   • Unassigned visibility is governed solely by "hide unassigned"
    //     (plus the isolate opt-in) — NOT by the tree-id range or the
    //     isolate id, since those pick among ASSIGNED ids. That's the fix
    //     for "hide unassigned does nothing while a range is active": with
    //     range [14,16] the unassigned points used to be rejected by the
    //     range itself, so the toggle had no effect. Now the toggle owns
    //     them regardless of any range / isolate.
    //   • Assigned visibility obeys isolate + range (ANDed).
    if (id <= 0) {
      // Unassigned visibility: ONE control per context, so neither
      // toggle is ever dead and they never fight.
      //   • No isolate → the Filters panel's "Hide unassigned" governs.
      //   • Isolate WITH a neighbourhood box (Tree Review / QC / …) →
      //     the review panel's own "show unassigned nearby" opt-in
      //     governs, box-scoped. The global toggle is ignored here —
      //     otherwise a globally-OFF toggle flooded the isolated view
      //     with background the panel's opt-in couldn't turn off (and
      //     for a badly segmented tree whose bbox is inflated by
      //     strays, the clamped margin box can sit AWAY from the trunk,
      //     so the flood even appeared in the wrong place).
      //   • Isolate WITHOUT a box (an id typed into the Filters panel)
      //     → the global toggle governs plot-wide; this was the dead
      //     control before.
      if (isolate === null) {
        pass = !hideUnassigned;
      } else if (ibox) {
        pass = isolateKeepUnassigned;
        if (pass && !inBox(ibox, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])) pass = false;
      } else {
        pass = !hideUnassigned;
      }
    } else {
      pass = true;
      if (isolate !== null && id !== isolate) {
        // Other trees' points: hidden while isolating UNLESS the user
        // opted into seeing the neighbours inside the same margin/Z box
        // (to judge where one crown ends and the next begins). They keep
        // their own tree_id colours. `otherMask`, when present, narrows
        // that to the specific neighbours picked in the panel.
        if (showOthers && ibox) {
          const picked = otherMask !== null ? (id < otherMask.length && otherMask[id] === 1)
                       : otherSet !== null ? otherSet.has(id)
                       : true;
          if (!picked) pass = false;
          else if (!inBox(ibox, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])) pass = false;
        } else {
          pass = false;
        }
      } else if (isolate !== null && treeBandY !== null) {
        // The isolated tree itself, when the height band is set to cut
        // it too: ELEVATION only. Running it through `inBox` instead
        // would also apply the margin box's horizontal walls, which are
        // sized for the trunk — a wide crown would lose its edges and
        // look like a segmentation error that isn't there.
        const y = pos[i * 3 + 1];
        if (y < treeBandY[0] || y > treeBandY[1]) pass = false;
      }
      if (pass && range !== null && (id < rangeMin || id > rangeMax)) pass = false;
    }
    // Class + spatial filters apply to everything (assigned or not).
    if (pass && classMask !== null && classMask[cls[i]]) pass = false;
    if (pass && semArr && semMask && semMask[semArr[i]]) pass = false;
    if (pass && hideStanding && standArr && standArr[i] > 0) pass = false;
    if (pass && hideLaying && layArr && layArr[i] > 0) pass = false;
    if (pass && onlyDeadwoodOn) {
      const sv = standArr ? standArr[i] : 0;
      const lv = layArr ? layArr[i] : 0;
      if (sv <= 0 && lv <= 0) pass = false;
    }
    if (pass && ir && intensityArr) {
      const iv = intensityArr[i];
      if (iv < irLo || iv > irHi) pass = false;
    }
    if (pass && retArr && retMask && retMask[retArr[i]]) pass = false;
    if (pass && exArr) {
      const ev = exArr[i];
      if (ev < exLo || ev > exHi) pass = false;
    }
    if (pass && xr) { const xv = pos[i * 3]; if (xv < xr[0] || xv > xr[1]) pass = false; }
    if (pass && yr) { const yv = pos[i * 3 + 2]; if (yv < yr[0] || yv > yr[1]) pass = false; }
    if (pass && zr) { const zv = pos[i * 3 + 1]; if (zv < zr[0] || zv > zr[1]) pass = false; }
    if (pass && slab && !inSlab(slab, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])) pass = false;
    if (pass && vpOn && vpDepth) {
      // Scene → world (reverse the decoder's swap-and-negate):
      //   worldX = sceneX + offX
      //   worldY = offY − sceneZ
      //   worldZ = sceneY + offZ
      const sx = pos[i * 3], sy = pos[i * 3 + 1], sz = pos[i * 3 + 2];
      const wx = sx + offset[0];
      const wy = offset[1] - sz;
      const wz = sy + offset[2];
      const dx = wx - vpx;
      const dy = wy - vpy;
      const dz = wz - vpz;
      const range = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (range < 1e-6) {
        // Point coincides with the viewpoint — keep it visible (it's
        // the scanner itself, conceptually).
      } else {
        let a = Math.atan2(dx, dy);
        if (a < 0) a += twoPi;
        const e = Math.asin(dz / range) + halfPi;
        let ai = (a * vpInvAz) | 0;
        let ei = (e * vpInvEl) | 0;
        if (ai >= vpAz) ai = vpAz - 1;
        if (ei >= vpEl) ei = vpEl - 1;
        const binDepth = vpDepth[ei * vpAz + ai];
        if (Number.isFinite(binDepth) && range > binDepth + vpTol) pass = false;
      }
    }
    v[i] = pass ? 1 : 0;
    if (pass) passCount++;
  }
  return passCount;
}

/** Subset-preview clip: AND an extra spatial box into the node's
 *  visibility on top of whatever applyFilters already decided, so the
 *  cloud reads as if cut to the box the Subset panel is dragging out.
 *  World ranges; compared in scene-local coords (same axis remap as
 *  applyFilters). No-op when `preview` is null / all-null. */
function applyPreviewClip(
  ln: LoadedNode,
  preview: { xRange: [number, number] | null; yRange: [number, number] | null; zRange: [number, number] | null } | null,
  offset: [number, number, number],
): void {
  if (!preview) return;
  const xr = preview.xRange ? [preview.xRange[0] - offset[0], preview.xRange[1] - offset[0]] as const : null;
  const yr = preview.yRange ? [offset[1] - preview.yRange[1], offset[1] - preview.yRange[0]] as const : null;
  const zr = preview.zRange ? [preview.zRange[0] - offset[2], preview.zRange[1] - offset[2]] as const : null;
  if (!xr && !yr && !zr) return;
  const v = ln.visibility;
  const pos = ln.positions;
  const n = v.length;
  for (let i = 0; i < n; i++) {
    if (v[i] === 0) continue; // already hidden by a filter
    if (xr) { const xv = pos[i * 3]; if (xv < xr[0] || xv > xr[1]) { v[i] = 0; continue; } }
    if (yr) { const yv = pos[i * 3 + 2]; if (yv < yr[0] || yv > yr[1]) { v[i] = 0; continue; } }
    if (zr) { const zv = pos[i * 3 + 1]; if (zv < zr[0] || zv > zr[1]) { v[i] = 0; continue; } }
  }
}

/** Paint every (non-selected) point whose id in `ids` matches `activeId`
 *  with the highlight colour — the in-memory editor's active-instance
 *  highlight, so the user sees which tree / deadwood log the tools act
 *  on. Selection red still wins. Used for tree_id and for both deadwood
 *  channels (Shift+click in the matching colour mode picks the id under
 *  the cursor + makes it the active one). */
function applyActiveHighlight(
  ln: LoadedNode, ids: Int32Array, activeId: number, rgb: [number, number, number],
): void {
  const colorAttr = ln.geom.attributes.color as THREE.BufferAttribute | undefined;
  if (!colorAttr) return;
  const colors = colorAttr.array as Uint8Array;
  const sel = ln.selection;
  const count = ids.length;
  const [r, g, b] = rgb;
  for (let i = 0; i < count; i++) {
    if (ids[i] !== activeId) continue;
    if (sel && sel[i]) continue; // selection red wins
    colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
  }
}

