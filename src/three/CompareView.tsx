// The Compare view: the source and the target of a skeleton transfer
// side by side, under ONE camera.
//
// The workflow's third and fourth stages — inspect the transfer, edit where
// it failed — had no view of their own: the user switched datasets and
// compared from memory. This is the view. Two panes, each a canvas with
// the editor's own streamer over its own octree (full LOD, its own half
// of the point budget, the dataset's patches applied as the editor
// applies them); orbit, pan or zoom in either and both move, because the
// pose they share lives in world coordinates and each pane converts with
// its own offset (see comparePose.ts). Colour by any of the viewport's
// modes, through the SAME colorNode the editor colours with — so an
// inherited id is the same colour on both sides by construction, not by
// a copy of the palette.
//
// HEIGHTS. A TLS plot normalised to height above ground beside a HeliALS
// epoch in elevation stood 540 m apart under one camera: one pane's cloud
// at the bottom of the screen, the other's at the top. With alignment on
// each pane has a height base — the elevation side its ground level, the
// normalised side zero — and the shared pose's z is a height above ground
// on both. A constant per pane; see comparePose.ts, heightBasesFor.
//
// Read-only. Nothing here writes to either octree; the edit API the
// streamer offers is left unused.
//
// The export renders each pane offscreen at the figure's size, on white,
// at the FULL budget (see PlanOverride in OctreeView.tsx), and hands back
// PNG bytes plus the camera they were rendered with — figures as
// pixel-registered, reproducible files rather than matched
// screenshots.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { openOctree, type OpenOctree } from '../persistence/octreeReader';
import { loadPatches, PatchStore, type NodeKey as PatchNodeKey } from '../persistence/octreePatches';
import {
  DEFAULT_FILTERS, type ColorMode, type DisplayConfig, type FilterConfig, type SkeletonColorMode, type SkeletonOverlay, type ViewerStats,
} from '../components/shell/OctreeShellContext';
import { guessFrame } from '../components/shell/heightFrames';
import { NodeStreamer, AdaptiveClip, ContextLossWatch, SkeletonPointsOverlay, ThemeClearColor, type EditApi, type PlanOverride } from './OctreeView';
import { viewportBackground } from '../ui/theme';
import { useHeightDisplay } from './useTerrain';
import {
  poseToScene, poseFromScene, posesEqual, defaultPose, extentOf, splitBudget, exportBudget, exportPointSize,
  clampExportSize, heightBasesFor, footprintIntersection, SIDE_BY_SIDE_GUTTER_PX, boxThrough, invertRigid, type Rigid2,
  type CameraPose, type CompareApi, type HeightBases, type PaneStats, type Vec3,
} from './comparePose';
import { flipRowsRgba, rgbaToPng, composeSideBySidePng, type RgbaImage } from './pngEncode';

type Side = 'source' | 'target';

/** The one camera. `driver` is the pane the user is moving; the other
 *  follows. null after a programmatic move: both follow. */
interface SharedPose {
  pose: CameraPose;
  version: number;
  driver: Side | null;
}

interface PaneRender {
  rgba: RgbaImage;
  pointsRendered: number;
  settled: boolean;
}
type PaneExport = (width: number, height: number, pointBudget: number) => Promise<PaneRender>;

interface Props {
  sourceDir: string;
  targetDir: string;
  /** Display names, as the project lists them. */
  sourceName: string;
  targetName: string;
  /** Any of the viewport's colour modes, over both panes. */
  colorMode: ColorMode;
  /** Leave tree id 0 out of both panes. */
  hideUnlabeled: boolean;
  /** Put both clouds in one height — see heightBasesFor. */
  alignHeights: boolean;
  /** The source's skeletons onto the target's trees (world) — the
   *  target pane looks through it, so both panes show the same tree
   *  when the clouds stand apart. Null: none. */
  alignment: Rigid2 | null;
  /** Drawn over the target pane when non-null, coloured by `skeletonColor`. */
  skeleton: SkeletonOverlay | null;
  skeletonColor: SkeletonColorMode;
  /** The editor's display: point size, unlabelled colour, and the point
   *  budget the two panes split. */
  display: DisplayConfig;
  onApiReady: (api: CompareApi | null) => void;
  onClose: () => void;
}

const noop = () => { /* the compare panes select nothing */ };

/** How long a pane's streamer must report nothing pending before an
 *  export renders, and how long the export waits for that at most. */
const EXPORT_SETTLE_POLL_MS = 100;
const EXPORT_SETTLE_QUIET_POLLS = 5;
const EXPORT_SETTLE_TIMEOUT_MS = 120_000;

type GroundReferenceFn = (dir: string, within?: [number, number, number, number]) => Promise<{ z: number; from: string; cells: number }>;

interface Opened {
  source: OpenOctree;
  target: OpenOctree;
  /** Ground level per side, when the cloud has a ground classification. */
  ground: { source: number | null; target: number | null };
}

export default function CompareView({
  sourceDir, targetDir, sourceName, targetName, colorMode, hideUnlabeled, alignHeights, alignment, skeleton, skeletonColor,
  display, onApiReady, onClose,
}: Props) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceStoreRef = useRef<PatchStore>(new PatchStore());
  const targetStoreRef = useRef<PatchStore>(new PatchStore());
  const [storeVersion, setStoreVersion] = useState(0);

  // Open both octrees and their patches, and ask each cloud in
  // elevation where its ground is under the footprint the two share. A
  // patches.bin that fails to load is an empty overlay, as in the
  // editor — not a closed view; a ground level that fails is no base.
  useEffect(() => {
    let cancelled = false;
    setOpened(null);
    setError(null);
    (async () => {
      try {
        const [source, target] = await Promise.all([openOctree(sourceDir), openOctree(targetDir)]);
        const empty = () => new Map<PatchNodeKey, never[]>();
        const [sp, tp] = await Promise.all([
          loadPatches(sourceDir).catch((e) => { console.warn('compare: source patches', e); return empty(); }),
          loadPatches(targetDir).catch((e) => { console.warn('compare: target patches', e); return empty(); }),
        ]);
        const groundRef = (window as unknown as { desktop?: { octreeGroundReference?: GroundReferenceFn } }).desktop?.octreeGroundReference;
        const boxOf = (o: OpenOctree) => ({ min: o.meta.boundingBox.min as Vec3, max: o.meta.boundingBox.max as Vec3 });
        const shared = footprintIntersection(boxOf(source), boxOf(target)) ?? undefined;
        const groundOf = async (o: OpenOctree, dir: string): Promise<number | null> => {
          if (!groundRef || guessFrame(o.meta.boundingBox.min[2], o.meta.boundingBox.max[2]) !== 'absolute') return null;
          try { return (await groundRef(dir, shared)).z; }
          catch (e) { console.warn('compare: ground reference', e); return null; }
        };
        const [gs, gt] = await Promise.all([groundOf(source, sourceDir), groundOf(target, targetDir)]);
        if (cancelled) return;
        const ss = new PatchStore(); ss.loadFrom(sp);
        const ts = new PatchStore(); ts.loadFrom(tp);
        sourceStoreRef.current = ss;
        targetStoreRef.current = ts;
        setStoreVersion((v) => v + 1);
        setOpened({ source, target, ground: { source: gs, target: gt } });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [sourceDir, targetDir]);

  // The height base of each pane — zero on both with alignment off.
  const bases = useMemo<HeightBases>(() => {
    if (!opened) return { source: 0, target: 0 };
    const guess = (o: OpenOctree) => guessFrame(o.meta.boundingBox.min[2], o.meta.boundingBox.max[2]);
    return heightBasesFor(
      alignHeights,
      { guess: guess(opened.source), groundZ: opened.ground.source },
      { guess: guess(opened.target), groundZ: opened.ground.target },
    );
  }, [opened, alignHeights]);

  // The boxes in the SHARED frame (z as height above each base, the
  // target's footprint back through the alignment), so the start view
  // frames both clouds where they will actually appear.
  const boxes = useMemo(() => opened ? [
    { min: shiftZ(opened.source.meta.boundingBox.min as Vec3, -bases.source), max: shiftZ(opened.source.meta.boundingBox.max as Vec3, -bases.source) },
    boxThrough(
      { min: shiftZ(opened.target.meta.boundingBox.min as Vec3, -bases.target), max: shiftZ(opened.target.meta.boundingBox.max as Vec3, -bases.target) },
      alignment ? invertRigid(alignment) : null,
    ),
  ] : [], [opened, bases, alignment]);
  const initialPose = useMemo(() => defaultPose(boxes), [boxes]);
  const extent = useMemo(() => extentOf(boxes), [boxes]);
  const sharedRef = useRef<SharedPose>({ pose: initialPose, version: 1, driver: null });
  // A new pair of clouds, or a new alignment, starts on its default view.
  useEffect(() => {
    sharedRef.current = { pose: initialPose, version: sharedRef.current.version + 1, driver: null };
  }, [initialPose]);

  // Each pane streams with half the budget: the pair costs what the one
  // view did. EDL off — the panes draw plain points, and so does the
  // export.
  const paneDisplay = useMemo<DisplayConfig>(() => ({
    ...display, colorMode, pointBudget: splitBudget(display.pointBudget), edlEnabled: false,
  }), [display, colorMode]);
  const paneFilters = useMemo<FilterConfig>(() => ({ ...DEFAULT_FILTERS, hideUnassigned: hideUnlabeled }), [hideUnlabeled]);
  const paneSkeleton = useMemo<SkeletonOverlay | null>(
    () => (skeleton ? { ...skeleton, colorMode: skeletonColor } : null), [skeleton, skeletonColor]);

  const sourceStats = useRef<PaneStats | null>(null);
  const targetStats = useRef<PaneStats | null>(null);
  const sourceExport = useRef<PaneExport | null>(null);
  const targetExport = useRef<PaneExport | null>(null);

  const fullBudget = display.pointBudget;
  useEffect(() => {
    if (!opened) { onApiReady(null); return; }
    const columns = (() => {
      const a = new Set((opened.source.meta.extras ?? []).map((e) => e.name));
      return (opened.target.meta.extras ?? []).map((e) => e.name).filter((n) => a.has(n)).sort();
    })();
    const api: CompareApi = {
      getPose: () => sharedRef.current.pose,
      setPose: (pose) => {
        const sh = sharedRef.current;
        sh.pose = pose;
        sh.version += 1;
        sh.driver = null;
      },
      exportFigures: async ({ width, height, sideBySide }) => {
        const size = clampExportSize(width, height);
        const budget = exportBudget(fullBudget);
        const src = sourceExport.current;
        const tgt = targetExport.current;
        if (!src || !tgt) throw new Error('the compare panes are not ready to render');
        // One pane after the other: two full-budget renders share one GPU.
        const s = await src(size.width, size.height, budget);
        const t = await tgt(size.width, size.height, budget);
        const [sPng, tPng] = await Promise.all([
          rgbaToPng(s.rgba, size.width, size.height),
          rgbaToPng(t.rgba, size.width, size.height),
        ]);
        const combined = sideBySide
          ? await composeSideBySidePng(s.rgba, t.rgba, size.width, size.height, SIDE_BY_SIDE_GUTTER_PX)
          : null;
        return {
          width: size.width, height: size.height,
          camera: sharedRef.current.pose,
          heightBase: { ...bases },
          source: { png: sPng, pointsRendered: s.pointsRendered, settled: s.settled },
          target: { png: tPng, pointsRendered: t.pointsRendered, settled: t.settled },
          sideBySide: combined,
        };
      },
      stats: () => ({ source: sourceStats.current, target: targetStats.current }),
      heightBases: () => ({ ...bases }),
      columns: () => columns,
    };
    onApiReady(api);
    return () => onApiReady(null);
  }, [opened, fullBudget, bases, onApiReady]);

  const budgetLabel = `${(paneDisplay.pointBudget / 1e6).toFixed(1)} M of ${(display.pointBudget / 1e6).toFixed(1)} M pts`;

  return (
    <div className="absolute inset-0 flex" style={{ background: 'var(--viewport-bg)' }}>
      {error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <div className="mono text-[11px] rounded-lg px-4 py-3" style={{ maxWidth: 460, lineHeight: 1.6, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--text)' }}>
            <div style={{ color: '#e0817b', marginBottom: 6 }}>Compare could not open the pair.</div>
            <div style={{ color: 'var(--text-mute)' }}>{error}</div>
            <button className="btn !h-7 mono text-[11px] justify-center" style={{ marginTop: 10, width: '100%' }} onClick={onClose}>Close compare</button>
          </div>
        </div>
      )}
      {!opened && !error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center mono text-[11px]" style={{ color: 'var(--text-mute)' }}>
          Opening both clouds…
        </div>
      )}
      {opened && (
        <>
          <Pane
            side="source" octree={opened.source} storeRef={sourceStoreRef} storeVersion={storeVersion}
            display={paneDisplay} filters={paneFilters} skeleton={null} sharedRef={sharedRef} extent={extent} initial={initialPose}
            zBase={bases.source} rigid={null} cloudGround={opened.ground.source} sourceGround={null}
            statsRef={sourceStats} exportRef={sourceExport} label={`Source · ${sourceName}`} budgetLabel={budgetLabel}
          />
          <div style={{ width: 2, background: 'var(--line)' }} />
          <Pane
            side="target" octree={opened.target} storeRef={targetStoreRef} storeVersion={storeVersion}
            display={paneDisplay} filters={paneFilters} skeleton={paneSkeleton} sharedRef={sharedRef} extent={extent} initial={initialPose}
            zBase={bases.target} rigid={alignment} cloudGround={opened.ground.target} sourceGround={opened.ground.source}
            statsRef={targetStats} exportRef={targetExport} label={`Target · ${targetName}`} budgetLabel={budgetLabel}
          />
        </>
      )}
      <button
        className="btn !h-6 mono text-[10px] absolute z-30"
        style={{ top: 8, right: 8 }}
        onClick={onClose}
        title="Back to the open cloud. The Skeleton Transfer panel's step 4 opens this again."
      >
        ✕ Close compare
      </button>
    </div>
  );
}

function shiftZ(p: Vec3, dz: number): Vec3 {
  return [p[0], p[1], p[2] + dz];
}

// ------------------------------------------------------------------

function Pane({
  side, octree, storeRef, storeVersion, display, filters, skeleton, sharedRef, extent, initial, zBase, rigid, cloudGround, sourceGround, statsRef, exportRef, label, budgetLabel,
}: {
  side: Side;
  octree: OpenOctree;
  storeRef: React.MutableRefObject<PatchStore>;
  storeVersion: number;
  display: DisplayConfig;
  filters: FilterConfig;
  skeleton: SkeletonOverlay | null;
  sharedRef: React.MutableRefObject<SharedPose>;
  extent: number;
  initial: CameraPose;
  /** This pane's height base — see comparePose.ts, poseToScene. */
  zBase: number;
  /** The shared pose into this cloud's frame — the alignment for the
   *  target pane, null for the source. */
  rigid: Rigid2 | null;
  /** This cloud's ground level under the shared footprint (null when it
   *  has none or is normalised), and the skeletons' source cloud's — the
   *  fallbacks for moving the skeletons onto this cloud's height frame
   *  when a terrain is not to be had. See three/useTerrain.ts. */
  cloudGround: number | null;
  sourceGround: number | null;
  statsRef: React.MutableRefObject<PaneStats | null>;
  exportRef: React.MutableRefObject<PaneExport | null>;
  label: string;
  budgetLabel: string;
}) {
  const orbitRef = useRef<OrbitControlsImpl | null>(null);
  const selectionStoreRef = useRef<Map<PatchNodeKey, Set<number>>>(new Map());
  const editApiRef = useRef<EditApi | null>(null);
  const releasedRef = useRef(false);
  const planOverrideRef = useRef<PlanOverride | null>(null);
  const [lost, setLost] = useState(false);
  const [exporting, setExporting] = useState(false);
  const offset = octree.meta.offset;
  // Heights above ground, and the skeletons onto this cloud's frame —
  // the same as the editor's viewport. A flattened cloud's ground is
  // exactly at its terrain's reference level, so that is the height
  // base then, not the footprint median the alignment guessed with.
  const heights = useHeightDisplay({
    heightMode: display.heightMode ?? 'stored',
    colorAboveGround: display.colorMode === 'height' && display.heightColorAboveGround === true,
    cloudDir: octree.dir,
    cloudZ: [octree.meta.boundingBox.min[2], octree.meta.boundingBox.max[2]],
    skeleton,
    cloudGroundFallback: cloudGround,
    sourceGroundFallback: sourceGround,
  });
  const zBaseEff = zBase !== 0 && heights.flattenWith ? heights.flattenWith.grid.reference : zBase;
  const start = useMemo(() => poseToScene(initial, offset, zBaseEff, rigid), [initial, offset, zBaseEff, rigid]);
  const startTarget = useMemo(() => new THREE.Vector3(...start.target), [start]);
  const onStats = useCallback((s: ViewerStats) => {
    statsRef.current = { visiblePoints: s.visiblePoints, loadedPoints: s.loadedPoints, pendingNodes: s.pendingNodes };
  }, [statsRef]);
  const drive = useCallback(() => { sharedRef.current.driver = side; }, [sharedRef, side]);

  return (
    <div className="relative flex-1 min-w-0 h-full" onPointerDownCapture={drive} onWheelCapture={drive}>
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: start.position, fov: start.fov, near: Math.max(extent * 0.002, 0.01), far: extent * 8 }}
        onCreated={({ gl }) => { gl.setClearColor(viewportBackground(), 1); }}
      >
        <ContextLossWatch onLost={() => setLost(true)} onRestored={() => setLost(false)} />
        <ThemeClearColor />
        <OrbitControls
          ref={orbitRef}
          target={startTarget}
          makeDefault
          enableDamping
          dampingFactor={0.08}
          mouseButtons={{ LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
          zoomToCursor
          minDistance={0}
          maxDistance={Infinity}
        />
        <CameraLink side={side} sharedRef={sharedRef} offset={offset} zBase={zBaseEff} rigid={rigid} orbitRef={orbitRef} />
        <AdaptiveClip orbitRef={orbitRef} extent={extent} />
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
          terrain={heights.flattenWith}
          colorTerrain={heights.colorWith}
        />
        {skeleton && <SkeletonPointsOverlay skeleton={skeleton} offset={offset} zAdjust={heights.skeletonZAdjust} />}
        <PaneExporter exportRef={exportRef} statsRef={statsRef} planOverrideRef={planOverrideRef} pointSize={display.pointSize} onBusy={setExporting} />
      </Canvas>
      <div className="absolute mono text-[10px] px-1.5 py-0.5 rounded pointer-events-none" style={{ top: 8, left: 8, background: 'rgba(11,13,16,0.7)', color: 'var(--text-dim)' }}>
        <span style={{ color: 'var(--text)' }}>{label}</span>
        <span style={{ color: 'var(--text-mute)' }}> · {budgetLabel}</span>
        {zBaseEff !== 0 && (
          <span style={{ color: 'var(--text-mute)' }} title="This cloud is in elevation; the shared camera's height 0 is set at its ground level here, so it stands beside the normalised cloud."> · height 0 at z {zBaseEff.toFixed(1)} m</span>
        )}
        {heights.note && (
          <span style={{ color: 'var(--text-mute)' }}> · {heights.note}</span>
        )}
        {rigid && (
          <span style={{ color: 'var(--text-mute)' }} title="The source's skeletons were aligned to this cloud's trees; the shared camera goes through that transform here, so both panes look at the same tree."> · through the alignment ({Math.hypot(rigid.dx, rigid.dy).toFixed(2)} m{Math.abs(rigid.theta) > 1e-6 ? `, ${(rigid.theta * 180 / Math.PI).toFixed(2)}°` : ''})</span>
        )}
      </div>
      {exporting && (
        <div className="absolute inset-0 z-10 flex items-center justify-center mono text-[11px]" style={{ background: 'rgba(11,13,16,0.6)', color: 'var(--text)' }}>
          Rendering the figure at full detail…
        </div>
      )}
      {lost && (
        <div className="absolute inset-0 z-10 flex items-center justify-center mono text-[11px]" style={{ background: 'rgba(11,13,16,0.9)', color: '#e6c068' }}>
          This pane's graphics context was lost — close Compare and open it again.
        </div>
      )}
    </div>
  );
}

/** Keeps this pane's camera on the shared pose: publishing it while
 *  this pane is the driver, following it otherwise. Both directions go
 *  through this pane's offset and height base. */
function CameraLink({ side, sharedRef, offset, zBase, rigid, orbitRef }: {
  side: Side;
  sharedRef: React.MutableRefObject<SharedPose>;
  offset: [number, number, number];
  zBase: number;
  rigid: Rigid2 | null;
  orbitRef: React.RefObject<OrbitControlsImpl | null>;
}) {
  const { camera } = useThree();
  const applied = useRef(0);
  useFrame(() => {
    const ctl = orbitRef.current;
    if (!ctl) return;
    const cam = camera as THREE.PerspectiveCamera;
    const sh = sharedRef.current;
    if (sh.driver === side) {
      const pose = poseFromScene({
        position: [cam.position.x, cam.position.y, cam.position.z],
        target: [ctl.target.x, ctl.target.y, ctl.target.z],
        up: [cam.up.x, cam.up.y, cam.up.z],
        fov: cam.fov,
      }, offset, zBase, rigid);
      if (!posesEqual(pose, sh.pose, 1e-9)) {
        sh.pose = pose;
        sh.version += 1;
      }
      applied.current = sh.version;
    } else if (applied.current !== sh.version) {
      const sp = poseToScene(sh.pose, offset, zBase, rigid);
      cam.position.set(sp.position[0], sp.position[1], sp.position[2]);
      cam.up.set(sp.up[0], sp.up[1], sp.up[2]);
      ctl.target.set(sp.target[0], sp.target[1], sp.target[2]);
      if (Math.abs(cam.fov - sp.fov) > 1e-9) {
        cam.fov = sp.fov;
        cam.updateProjectionMatrix();
      }
      ctl.update();
      applied.current = sh.version;
    }
  });
  return null;
}

/** Wait until the pane's streamer has had nothing pending for a few
 *  polls in a row — the export's node set is resident — or give up
 *  after the timeout and say so. */
async function settle(statsRef: React.MutableRefObject<PaneStats | null>): Promise<boolean> {
  const t0 = performance.now();
  let quiet = 0;
  // At least a couple of plan ticks before the first look, so a
  // just-set override has had a chance to fill the queue.
  await new Promise((r) => setTimeout(r, 3 * EXPORT_SETTLE_POLL_MS));
  while (performance.now() - t0 < EXPORT_SETTLE_TIMEOUT_MS) {
    const s = statsRef.current;
    quiet = s && s.pendingNodes === 0 ? quiet + 1 : 0;
    if (quiet >= EXPORT_SETTLE_QUIET_POLLS) return true;
    await new Promise((r) => setTimeout(r, EXPORT_SETTLE_POLL_MS));
  }
  return false;
}

/** Renders this pane offscreen on demand — see the file comment. */
function PaneExporter({ exportRef, statsRef, planOverrideRef, pointSize, onBusy }: {
  exportRef: React.MutableRefObject<PaneExport | null>;
  statsRef: React.MutableRefObject<PaneStats | null>;
  planOverrideRef: React.MutableRefObject<PlanOverride | null>;
  pointSize: number;
  onBusy: (b: boolean) => void;
}) {
  const { gl, scene, camera, size } = useThree();
  useEffect(() => {
    exportRef.current = async (width, height, pointBudget) => {
      const cam = camera as THREE.PerspectiveCamera;
      const prevAspect = cam.aspect;
      onBusy(true);
      try {
        // 1. Plan for the figure: its pixel size, the full budget, and a
        //    camera whose frustum is the figure's, not the pane's.
        planOverrideRef.current = {
          width, height, pointBudget,
          pointSize: exportPointSize(pointSize, size.height, height),
        };
        cam.aspect = width / height;
        cam.updateProjectionMatrix();
        const settled = await settle(statsRef);
        // 2. Render it, on white, and read it back.
        const rt = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, stencilBuffer: false });
        const prevTarget = gl.getRenderTarget();
        const prevColor = gl.getClearColor(new THREE.Color());
        const prevAlpha = gl.getClearAlpha();
        const rgba = new Uint8Array(width * height * 4);
        try {
          gl.setRenderTarget(rt);
          gl.setClearColor('#ffffff', 1);
          gl.clear(true, true, false);
          gl.render(scene, cam);
          gl.readRenderTargetPixels(rt, 0, 0, width, height, rgba);
        } finally {
          gl.setRenderTarget(prevTarget);
          gl.setClearColor(prevColor, prevAlpha);
          rt.dispose();
        }
        const pointsRendered = statsRef.current?.visiblePoints ?? 0;
        return { rgba: flipRowsRgba(rgba, width, height), pointsRendered, settled };
      } finally {
        // 3. Back to the screen: the pane replans for its own size.
        planOverrideRef.current = null;
        cam.aspect = prevAspect;
        cam.updateProjectionMatrix();
        onBusy(false);
      }
    };
    return () => { exportRef.current = null; };
  }, [gl, scene, camera, size.height, pointSize, exportRef, statsRef, planOverrideRef, onBusy]);
  return null;
}
