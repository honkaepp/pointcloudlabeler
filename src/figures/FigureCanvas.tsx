// One dataset, rendered offscreen at whatever size the figure asks for.
//
// THE FIGURE IS NOT A SCREENSHOT OF THE VIEWPORT. It is rendered at its
// own pixel size, with its own camera and its own point size, and — the
// part that matters most — at the FULL node budget for that view rather
// than whatever level of detail happens to be resident on screen. A
// figure exported at screen LOD looks sparse in print, and the
// difference between a genuinely sparse airborne cloud and an
// under-streamed dense one is exactly the thing a reviewer will
// question. So the export blocks until the nodes the view needs are in.
//
// The canvas is mounted at a token size and drawn only when an export
// asks for a frame: `frameloop="demand"`. Two live viewports already
// split one streaming budget in the Compare view, and this is a third
// consumer — it never streams while nothing is being exported.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { openOctree, type OpenOctree } from '../persistence/octreeReader';
import { loadTerrain, type TerrainDisplay } from '../three/terrain';
import { loadPatches, PatchStore, type NodeKey as PatchNodeKey } from '../persistence/octreePatches';
import { NodeStreamer, type EditApi, type PlanOverride } from '../three/OctreeView';
import { DEFAULT_DISPLAY, DEFAULT_FILTERS, type DisplayConfig, type FilterConfig, type ViewerStats } from '../components/shell/OctreeShellContext';
import { poseToScene, type CameraPose } from '../three/comparePose';
import { flipRowsRgba, type RgbaImage } from '../three/pngEncode';
import type { Background, FigureColorMode, Unclassified } from './figureSpec';

/** What one viewport figure needs that the dataset does not carry. */
export interface ViewportRequest {
  width: number;
  height: number;
  background: Background;
  colorMode: FigureColorMode;
  unclassified: Unclassified;
  /** The colour the unclassified points are drawn in when shown. */
  unclassifiedColor: string;
  camera: CameraPose;
  /** The height base this cloud's z is read against, so a pair in two
   *  height frames can share one camera — see comparePose. */
  zBase: number;
  isolateTreeId: number | null;
  isolateBox: [[number, number, number], [number, number, number]] | null;
  isolateMargin: number;
  pointSize: number;
  pointBudget: number;
  /** Draw every point at its height above the ground under it, taking
   *  this cloud's own terrain out — the same flattening the viewport's
   *  "heights above ground" does. What puts a plot in elevation and a
   *  plot normalised before import into ONE height frame: a single
   *  ground level per cloud cannot, because it leaves the terrain's
   *  relief in one of them and not the other, and the two then stand at
   *  different heights tree by tree. */
  flatten: boolean;
}

export interface ViewportRender {
  rgba: RgbaImage;
  width: number;
  height: number;
  pointsRendered: number;
  /** False when the streamer never went quiet — the frame was taken
   *  before every node the view wanted was resident, and the sidecar
   *  says so rather than the figure quietly being sparse. */
  settled: boolean;
}

/** Told how the frame is coming along, so a long wait is visible
 *  instead of looking like a hang. */
export type ExportProgress = (what: string) => void;

export type ViewportExport = (req: ViewportRequest, onProgress?: ExportProgress) => Promise<ViewportRender>;

const BACKGROUND_HEX: Record<Background, string> = { white: '#ffffff', dark: '#0b0d10' };

/** How long the streamer must report nothing pending before the frame is
 *  taken, and how long the export waits for that at most. The same
 *  settle the Compare view's export uses, for the same reason. */
const POLL_MS = 100;
const QUIET_POLLS = 5;
const TIMEOUT_MS = 180_000;

async function settle(statsRef: React.MutableRefObject<ViewerStats | null>, onProgress?: ExportProgress): Promise<boolean> {
  const t0 = performance.now();
  let quiet = 0;
  let said = 0;
  await new Promise((r) => setTimeout(r, 3 * POLL_MS));
  while (performance.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const s = statsRef.current;
    quiet = (s?.pendingNodes ?? 1) === 0 ? quiet + 1 : 0;
    if (quiet >= QUIET_POLLS) return true;
    // Every two seconds, what it is still waiting for.
    const elapsed = performance.now() - t0;
    if (elapsed - said > 2000) {
      said = elapsed;
      onProgress?.(`streaming — ${(s?.visiblePoints ?? 0).toLocaleString()} points in, ${s?.pendingNodes ?? '?'} nodes to go (${(elapsed / 1000).toFixed(0)} s)`);
    }
  }
  return false;
}

export interface FigureCanvasProps {
  dir: string;
  /** Set to an exporter once the dataset is open; null while it loads. */
  onReady: (exp: ViewportExport | null) => void;
  onError: (message: string) => void;
}

/** A mounted, hidden canvas for one dataset. Kept mounted between the
 *  parts of a figure so the pair of exports that must register share one
 *  streamer and one GPU context. */
export default function FigureCanvas({ dir, onReady, onError }: FigureCanvasProps) {
  const [octree, setOctree] = useState<OpenOctree | null>(null);
  const storeRef = useRef<PatchStore>(new PatchStore());
  const [storeVersion, setStoreVersion] = useState(0);
  const [request, setRequest] = useState<ViewportRequest | null>(null);
  // The cloud's ground surface, loaded once and kept while the canvas
  // is up: a figure often takes two frames of the same dataset.
  const [terrain, setTerrain] = useState<TerrainDisplay | null>(null);
  const terrainRef = useRef<{ dir: string; promise: Promise<TerrainDisplay | null> } | null>(null);

  /** The terrain, loaded at most once per dataset. AWAITED BY THE
   *  EXPORT before the frame is drawn — loading it beside the render
   *  meant the first frame of a pair came out unflattened, which is the
   *  one thing the flattening exists to prevent. */
  const ensureTerrain = useCallback(async (): Promise<TerrainDisplay | null> => {
    if (terrainRef.current?.dir !== dir) terrainRef.current = { dir, promise: loadTerrain(dir) };
    const t = await terrainRef.current.promise;
    setTerrain(t);
    return t;
  }, [dir]);

  useEffect(() => () => {
    // The canvas is going: let go of whatever ground it holds.
    const held = terrainRef.current;
    terrainRef.current = null;
    void held?.promise.then((t) => t?.dispose());
  }, [dir]);

  useEffect(() => {
    let cancelled = false;
    setOctree(null);
    onReady(null);
    (async () => {
      try {
        const o = await openOctree(dir);
        const patches = await loadPatches(dir).catch(() => new Map<PatchNodeKey, never[]>());
        if (cancelled) return;
        const store = new PatchStore();
        store.loadFrom(patches);
        storeRef.current = store;
        setStoreVersion((v) => v + 1);
        setOctree(o);
      } catch (e) {
        if (!cancelled) onError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
    // onReady / onError are stable callbacks from the module.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir]);

  // The display and filters the request asks for. Both are derived, so
  // the streamer re-colours and re-masks before the frame is taken.
  const display = useMemo<DisplayConfig>(() => ({
    ...DEFAULT_DISPLAY,
    colorMode: request?.colorMode === 'semantic' ? 'semantic' : 'tree_id',
    pointSize: request?.pointSize ?? 2,
    pointBudget: request?.pointBudget ?? DEFAULT_DISPLAY.pointBudget,
    edlEnabled: false,
    showLegend: false,
    // The colour the figure asks for its unclassified points — the
    // viewport's own neutral grey unless the user chose otherwise, so
    // the figure and the screen agree by default.
    unlabeledColor: request?.unclassifiedColor ?? DEFAULT_DISPLAY.unlabeledColor,
  }), [request]);

  const filters = useMemo<FilterConfig>(() => ({
    ...DEFAULT_FILTERS,
    hideUnassigned: request?.unclassified === 'hidden',
    isolateTreeId: request?.isolateTreeId ?? null,
    isolateBox: request?.isolateBox ?? null,
    isolateMargin: request?.isolateMargin ?? 0,
    // Inside an isolate, the unclassified points around the tree are
    // shown or hidden by the same choice.
    isolateShowUnassigned: request?.unclassified !== 'hidden',
  }), [request]);

  if (!octree) return null;
  return (
    // Off the layout, not `display: none`: a hidden canvas gets no
    // WebGL context in some drivers, and one with zero size renders
    // nothing. It is 2 × 2 px in a corner, and every frame it draws is
    // drawn into an offscreen target at the figure's own size.
    <div style={{ position: 'fixed', left: -8, top: -8, width: 2, height: 2, overflow: 'hidden', pointerEvents: 'none', opacity: 0 }} aria-hidden>
      <Canvas
        frameloop="demand"
        dpr={1}
        gl={{ preserveDrawingBuffer: false, antialias: false }}
        camera={{ position: [1, 1, 1], fov: 45, near: 0.01, far: 10000 }}
        onCreated={({ gl }) => { gl.setClearColor('#ffffff', 1); }}
      >
        <Streamer
          octree={octree}
          display={display}
          filters={filters}
          storeRef={storeRef}
          storeVersion={storeVersion}
          terrain={request?.flatten ? terrain : null}
          ensureTerrain={ensureTerrain}
          onRequest={setRequest}
          onReady={onReady}
        />
      </Canvas>
    </div>
  );
}

function Streamer({ octree, display, filters, storeRef, storeVersion, terrain, ensureTerrain, onRequest, onReady }: {
  octree: OpenOctree;
  display: DisplayConfig;
  filters: FilterConfig;
  storeRef: React.MutableRefObject<PatchStore>;
  storeVersion: number;
  terrain: TerrainDisplay | null;
  ensureTerrain: () => Promise<TerrainDisplay | null>;
  onRequest: (r: ViewportRequest | null) => void;
  onReady: (e: ViewportExport | null) => void;
}) {
  const { gl, scene, camera, invalidate } = useThree();
  const statsRef = useRef<ViewerStats | null>(null);
  const planOverrideRef = useRef<PlanOverride | null>(null);
  const editApiRef = useRef<EditApi | null>(null);
  const releasedRef = useRef(false);
  const selectionStoreRef = useRef(new Map<PatchNodeKey, Set<number>>());
  const noop = useCallback(() => { /* a figure selects nothing */ }, []);
  const onStats = useCallback((s: ViewerStats) => { statsRef.current = s; }, []);
  const offset = octree.meta.offset as [number, number, number];

  useEffect(() => {
    const exporter: ViewportExport = async (req, onProgress) => {
      const cam = camera as THREE.PerspectiveCamera;
      // 0. The ground first, when the frame is to be drawn above it:
      //    the streamer must already hold it when the frame is taken.
      if (req.flatten) {
        onProgress?.('reading the ground surface');
        const t = await ensureTerrain();
        if (!t) throw new Error('this cloud has no ground classification, so its heights cannot be taken above ground');
        // One tick for the streamer to receive it before anything is
        // planned against it.
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      // 1. The figure's own camera, frustum and plan. The point size is
      //    in OUTPUT pixels: a 1 px splat that reads on screen is
      //    invisible at 2400.
      onRequest(req);
      const pose = poseToScene(req.camera, offset, req.zBase);
      cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
      cam.up.set(pose.up[0], pose.up[1], pose.up[2]);
      cam.lookAt(pose.target[0], pose.target[1], pose.target[2]);
      cam.fov = pose.fov;
      cam.aspect = req.width / req.height;
      const span = Math.hypot(
        octree.meta.boundingBox.max[0] - octree.meta.boundingBox.min[0],
        octree.meta.boundingBox.max[1] - octree.meta.boundingBox.min[1],
        octree.meta.boundingBox.max[2] - octree.meta.boundingBox.min[2],
      ) || 100;
      cam.near = Math.max(span * 0.0005, 0.01);
      cam.far = span * 10;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      planOverrideRef.current = {
        width: req.width, height: req.height,
        pointBudget: req.pointBudget, pointSize: req.pointSize,
      };
      // 2. Let it stream. `demand` means the loop only runs when asked,
      //    so the export drives it until the streamer goes quiet.
      const until = Date.now() + TIMEOUT_MS;
      const pump = setInterval(() => { invalidate(); }, POLL_MS / 2);
      let settled = false;
      try {
        settled = await settle(statsRef, onProgress);
        if (!settled && Date.now() > until) settled = false;
      } finally {
        clearInterval(pump);
      }
      // 3. Render into a target at the figure's size and read it back.
      const rt = new THREE.WebGLRenderTarget(req.width, req.height, { depthBuffer: true, stencilBuffer: false });
      const prevTarget = gl.getRenderTarget();
      const prevColor = gl.getClearColor(new THREE.Color());
      const prevAlpha = gl.getClearAlpha();
      const rgba = new Uint8Array(req.width * req.height * 4);
      try {
        gl.setRenderTarget(rt);
        gl.setClearColor(BACKGROUND_HEX[req.background], 1);
        gl.clear(true, true, false);
        gl.render(scene, cam);
        gl.readRenderTargetPixels(rt, 0, 0, req.width, req.height, rgba);
      } finally {
        gl.setRenderTarget(prevTarget);
        gl.setClearColor(prevColor, prevAlpha);
        rt.dispose();
        planOverrideRef.current = null;
      }
      return {
        rgba: flipRowsRgba(rgba, req.width, req.height),
        width: req.width, height: req.height,
        pointsRendered: statsRef.current?.visiblePoints ?? 0,
        settled,
      };
    };
    onReady(exporter);
    return () => { onReady(null); };
  }, [gl, scene, camera, invalidate, offset, octree.meta.boundingBox, ensureTerrain, onReady, onRequest]);

  return (
    <NodeStreamer
      octree={octree}
      display={display}
      filters={filters}
      subsetPreview={null}
      cloudVisible
      activeTreeId={0}
      activeStandingId={0}
      activeLayingId={0}
      storeRef={storeRef}
      selectionStoreRef={selectionStoreRef}
      storeVersion={storeVersion}
      onSelectionChange={noop}
      onStatsChange={onStats}
      editApiRef={editApiRef}
      releasedRef={releasedRef}
      planOverrideRef={planOverrideRef}
      terrain={terrain}
    />
  );
}
