// Tree Skeleton Transfer (TST) panel. Implements the method published
// as Honkanen, E., Yrttimaa, T., Terryn, L., Kamula, T., Erkkilä, A.,
// Liikonen, L., Hyyppä, J. & Vastaranta, M. (2026), "Transferring
// instance and semantic segmentation across terrestrial laser scanning
// time series", ISPRS Open Journal of Photogrammetry and Remote
// Sensing 21:100147, doi:10.1016/j.ophoto.2026.100147 (CC BY 4.0).
// PORTED from the authors' MATLAB — see commands/tst.rs for what was
// ported, the three defects fixed in it, and where this still differs.
//
// Three workflow stages:
//
//   1. BUILD — fit TreeQSM v2 on each baseline tree, sample every
//      cylinder at skeleton_spacing into a per-tree skeleton, and
//      persist the result to `<baselineDir>/skeletons.bin`. Saved
//      skeletons survive across sessions and let the same baseline
//      transfer to multiple targets (different years) without
//      re-running TreeQSM.
//
//   2. VIEW — load the cached skeletons from any dataset (typically
//      the baseline) and draw them in the viewport as small coloured
//      dots. Also exposes "Export" (CSV / PLY) so the skeleton can
//      leave PointCloudLabeler.
//
//   3. TRANSFER — propagate tree_id + semantic from baseline to the
//      currently-open target via nearest-neighbour lookup. Uses the
//      cached skeleton when present; falls back to a one-shot
//      rebuild when it isn't.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useOctreeShell, type SkeletonTransferResult, type SkeletonColorMode,
} from './OctreeShellContext';
import { onOctreeProgress } from '../../persistence/octreeStore';
import {
  COMPARE_VIEWS_FILE, DEFAULT_EXPORT_SIZE, parseViews, serializeViews, buildSidecar, exportFileNames, exportStamp,
  clampExportSize, type SavedView, type CompareColorMode,
} from '../../three/comparePose';
import type { SkeletonPlanar } from '../../persistence/skeletonPlanar';
import { confirmDialog, alertDialog } from '../../ui/dialogs';
import { guessFrame, suggestFrames, describeGuess, type HeightFrame } from './heightFrames';
import { findDir, sameDir } from '../../persistence/datasetDirs';

interface BuildResult {
  treeCount: number;
  pointCount: number;
  skeletonSpacing: number;
  bytesWritten: number;
  trees: Array<{ treeId: number; pointCount: number; bboxMin: [number, number, number]; bboxMax: [number, number, number] }>;
  /** False when the run was stopped short of the plot. What it built
   *  is kept and shown, but as a stop — never as "✓ Built", which is
   *  what a stop at 169 of 257 trees used to say. */
  complete: boolean;
  /** Trees in the baseline, and how many of them have no skeleton yet. */
  treesTotal: number;
  treesRemaining: number;
  /** The TreeQSM cylinder table written beside the cache when the
   *  run finished (qsm_cylinders.csv), for use outside this program. */
  qsmPath?: string | null;
}
type ExportFormat = 'csv' | 'txt' | 'ply' | 'las' | 'laz';
interface SkeletonInfo {
  pointCount: number; treeCount: number; skeletonSpacing: number;
  bytes: number; modifiedAt: number; path: string;
  /** False when the file is a checkpoint from a build that did not
   *  finish. Checkpoints and finished runs write the same format, so
   *  without this a crashed build leaves a cache the panel offers as
   *  though it were the whole plot — and a transfer from a baseline
   *  missing a third of its trees is wrong in a way nothing says. */
  complete: boolean;
}
/** The cache as decoded from the command's binary response — typed
 *  arrays over one buffer, handed to the overlay as they are. */
type SkeletonReadPayload = SkeletonPlanar;
interface Desktop {
  octreeBuildSkeletons?: (baselineDir: string, opts?: { skeletonSpacing?: number; rCover?: number; minTreePoints?: number; dtmCell?: number; groundThreshold?: number; qsmModels?: number; maxTreePoints?: number; skipAddedCylinders?: boolean; dropFarFragments?: boolean }) => Promise<BuildResult>;
  octreeReadSkeletons?: (octreeDir: string) => Promise<SkeletonReadPayload | null>;
  octreeSkeletonInfo?: (octreeDir: string) => Promise<SkeletonInfo | null>;
  octreeCancel?: (stage: string) => Promise<boolean>;
  octreeStageRunning?: (stage: string) => Promise<boolean>;
  octreeClearSkeletons?: (octreeDir: string) => Promise<boolean>;
  octreeExportSkeletons?: (
    octreeDir: string, outPath: string, format: ExportFormat,
    opts?: { onlyTreeId?: number; perTree?: boolean },
  ) => Promise<{ path: string; pointCount: number; bytesWritten: number; fileCount: number; treeCount: number }>;
  saveExportDialog?: (
    defaultName: string,
    filters: { name: string; extensions: string[] }[],
    title?: string,
  ) => Promise<string | null>;
  browseForFolder?: (title?: string) => Promise<string | null>;
  readFile?: (path: string) => Promise<ArrayBuffer>;
  writeFile?: (path: string, content: string) => Promise<boolean>;
  writeFileBytes?: (path: string, bytes: Uint8Array) => Promise<boolean>;
}

export default function SkeletonTransferPanel() {
  const {
    octree, octreeList, api, setDisplay, setFilters, skeletonOverlay, setSkeletonOverlay, cloudVisible, setCloudVisible,
    compare, setCompare, compareApi,
  } = useOctreeShell();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;
  const canRun = !!api && !!octree;

  // EVERY DEFAULT HERE IS THE REFERENCE'S OWN CONSTANT, and each one
  // names where it comes from. A parameter panel whose defaults are
  // somebody's taste rather than the published method's is a panel
  // that quietly produces different numbers from the paper it cites.
  const [baselineDir, setBaselineDir] = useState<string>('');
  // cfg.distance_threshold = 0.30 — TST_tree_skeleton_transfer_TLS.m
  const [distanceCm, setDistanceCm] = useState(30);
  // The reference assigns tree_lbl from the nearest skeleton point
  // whatever the distance, and lets the class say the point is not
  // wood. On a leaf-on scan that is the whole method — the crown is
  // metres from any cylinder axis and it is still the tree's.
  const [labelBeyond, setLabelBeyond] = useState(true);
  // stepSize = 0.02 — TST_pc_tree_skeleton.m
  const [spacingMm, setSpacingMm] = useState(20);
  // cfg.ground_threshold = 0.20, which the reference applies to the
  // TARGET only.
  const [groundCm, setGroundCm] = useState(20);
  // The reference does NOT cut the baseline: TST_get_tree_skeletons_v3.m
  // hands each tree's whole cloud to filtering + treeqsm, because those
  // clouds were cut before it ever saw them. Zero is therefore the
  // reference's value; raise it when the segmentation has let ground
  // into a tree.
  const [baselineGroundCm, setBaselineGroundCm] = useState(0);
  // PatchDiam1 = [0.08 0.12] — create_input.m. The whole eight-model
  // sweep is scaled from the first of those, so 8 cm here IS
  // create_input's default set.
  const [rCoverCm, setRCoverCm] = useState(8);
  // NOT THE REFERENCE'S — it has no minimum at all, and runs TreeQSM on
  // every tree in the treelist. Zero is therefore the faithful value.
  // The control is a speed knob: raising it skips small segments
  // instead of fitting and discarding them.
  const [minPts, setMinPts] = useState(0);
  // How many of create_input.m's parameter sets each tree is
  // reconstructed with. ONE is the reference's own — see the note by
  // the control — and it is also the single biggest lever on how long
  // a plot takes: this was fixed at eight, with nothing on screen
  // saying so, on a plot whose largest tree took twelve minutes at
  // eight models and takes ninety seconds at one.
  const [qsmModels, setQsmModels] = useState(1);
  // Leave the cylinders that span a gap out of the skeleton: TreeQSM's
  // connectors (cylinder.added), spliced across a gap between a branch
  // and its parent rather than fit to points — and, since a fitted
  // cylinder through a few stray cover sets carries no flag at all,
  // any BRANCH cylinder a metre or longer with points along less than
  // half of it (the stem is never judged: under a canopy it is
  // interpolated across occluded stretches legitimately, and it carries
  // the stem class). Either is a straight line between two things; when one
  // of them is a stray cluster far from the tree it is the long
  // straight fake branch, and the transfer hands its label to every
  // target point along it. The reference samples them; off
  // reproduces that.
  const [skipAdded, setSkipAdded] = useState(true);
  // Leave far fragments of an id out before reconstructing. Given the
  // 2 174-point sliver 53 m from tree 228, TreeQSM took the sliver for
  // the tree because its base sat lower and modelled 2.9 m of a 34.7 m
  // tree. With the fragment out, it sees the tree. The log names every
  // fragment either way; off feeds the reference's input.
  const [dropFragments, setDropFragments] = useState(true);
  // How the skeleton dots are coloured, and whether the point cloud is
  // hidden while they show — a skeleton drawn over its own cloud is
  // hard to read, and the transfer's inputs are the skeleton alone.
  const [skelColor, setSkelColor] = useState<SkeletonColorMode>('tree');
  const [skelOnly, setSkelOnly] = useState(true);
  const lastPayloadRef = useRef<SkeletonReadPayload | null>(null);
  // The dataset the last payload was read from: the overlay carries it
  // so the viewport can find that cloud's ground (see three/useTerrain.ts).
  const lastPayloadDirRef = useRef<string>('');
  // Segments bigger than this are thinned before reconstruction. A
  // measured plot's segmentation put 2.8 million points under one tree
  // id — more memory than the entire plot had been in the run before
  // it — and one such segment kills the application whatever bounds
  // how many trees run at once, because one of them still has to run.
  // 0 = no cap, which is the reference: TST_get_tree_skeletons_v3.m
  // reconstructs every tree at filtering.m's 4 mm and never thins
  // further. The cap is a deviation offered for a machine that cannot
  // hold a tree; see the note under the slider.
  const [maxPts, setMaxPts] = useState(0);

  const [busy, setBusy] = useState<null | 'build' | 'view' | 'transfer' | 'export'>(null);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [buildResult, setBuildResult] = useState<BuildResult | null>(null);
  const [viewedDir, setViewedDir] = useState<string>('');
  const [viewedSummary, setViewedSummary] = useState<{ pointCount: number; treeCount: number; spacing: number } | null>(null);
  const [transferResult, setTransferResult] = useState<SkeletonTransferResult | null>(null);
  // Which datasets already hold skeletons. Read from the file header
  // only, so listing this costs nothing; without it the panel could not
  // say whether step 3 will reuse a cache or spend as long as step 1
  // rebuilding one.
  const [cached, setCached] = useState<Record<string, SkeletonInfo | null>>({});
  // Export scope. '' is every tree in one file; a tree id is that tree
  // alone; `perTree` writes one file per tree into a folder, named
  // tree_<id>_skeleton.<ext> as TST_pc_tree_skeleton.m names them.
  const [exportTree, setExportTree] = useState<string>('');
  const [perTree, setPerTree] = useState(false);
  // The tree ids in the loaded skeletons, so the picker offers what is
  // actually there rather than a number field that can miss.
  const [treeIds, setTreeIds] = useState<number[]>([]);
  // Set while a stop has been asked for and the run has not yet
  // noticed. Without it the button looks dead for the seconds it takes
  // the current tree to finish, and a user presses it again.
  const [stopping, setStopping] = useState(false);
  // A run this panel did not start: the view was (re)loaded while one
  // was going and the backend kept working. Polled, because nothing
  // else tells a fresh page about it.
  const [orphanRun, setOrphanRun] = useState(false);
  // The cloud the labels land on. It defaults to the open one, which
  // is the ordinary case, but it does not have to be it: the backend
  // always took both directories and only the panel pinned this to
  // whatever was on screen, so a project with five clouds could
  // transfer into exactly one of them.
  const [targetDir, setTargetDir] = useState<string>('');

  // EVERY cloud in the project is a candidate to build skeletons from,
  // the active one included.
  //
  // This list used to exclude the active octree, because transferring a
  // cloud onto itself is meaningless. But the same selection drives
  // step 1, and building skeletons from the cloud you are looking at is
  // the normal thing to do — you segment it, correct it in Tree Review,
  // and skeletonise what you just fixed. Excluding it made the obvious
  // workflow impossible and left no error message saying why.
  //
  // The self-transfer rule belongs on the transfer button, which is
  // where it is enforced now.
  const baselineCandidates = octreeList;
  const transferIsSelf = !!targetDir && sameDir(baselineDir, targetDir);
  useEffect(() => {
    if (!baselineDir && baselineCandidates.length > 0) {
      // Default to the ACTIVE cloud when there is one — that is what a
      // user who just segmented something expects to skeletonise.
      setBaselineDir(findDir(baselineCandidates, octree?.dir)?.dir ?? baselineCandidates[0].dir);
    }
  }, [baselineCandidates, baselineDir, octree]);
  useEffect(() => {
    if (!viewedDir && octreeList.length > 0) {
      setViewedDir(baselineDir || octreeList[0].dir);
    }
  }, [octreeList, viewedDir, baselineDir]);

  // A result describes the dataset it was computed for. Change the
  // baseline and the "Built 42 trees" line under step 1 is about a
  // cloud the dropdown no longer names; change the target and the
  // transfer summary is about a cloud that is no longer open. Both
  // used to stay on screen, which is worse than showing nothing.
  useEffect(() => { setBuildResult(null); setError(null); }, [baselineDir]);
  useEffect(() => { setTransferResult(null); }, [baselineDir, targetDir]);
  // THE TARGET IS NEVER THE BASELINE. Labels flow from the skeletons to
  // another cloud; the cloud they were built from already has them, and
  // offering it here is offering to overwrite a segmentation with a
  // copy of itself. The list is every OTHER cloud in the project — the
  // open one first when it is not the baseline — and a project with no
  // other cloud says so instead of listing one.
  const targetCandidates = octreeList.filter((e) => !sameDir(e.dir, baselineDir));
  useEffect(() => {
    const ok = targetDir && !sameDir(targetDir, baselineDir) && targetCandidates.some((e) => sameDir(e.dir, targetDir));
    if (ok) return;
    const preferred = findDir(targetCandidates, octree?.dir) ?? targetCandidates[0];
    setTargetDir(preferred?.dir ?? '');
  }, [octree?.dir, targetDir, baselineDir, targetCandidates]);

  // THE HEIGHT FRAME of each side — see heightFrames.ts. Guessed from
  // the two bounding boxes whenever the pair changes; the user's own
  // choice for a pair stands until the pair changes.
  const baselineEntry = findDir(octreeList, baselineDir);
  const targetEntry = findDir(octreeList, targetDir);
  const baselineGuess = baselineEntry ? guessFrame(baselineEntry.bboxMin[2], baselineEntry.bboxMax[2]) : 'unknown';
  const targetGuess = targetEntry ? guessFrame(targetEntry.bboxMin[2], targetEntry.bboxMax[2]) : 'unknown';
  const frameSuggestion = suggestFrames(baselineGuess, targetGuess);
  const [baseHeight, setBaseHeight] = useState<HeightFrame>('stored');
  const [tgtHeight, setTgtHeight] = useState<HeightFrame>('stored');

  useEffect(() => {
    setBaseHeight(frameSuggestion.baseline);
    setTgtHeight(frameSuggestion.target);
    // The suggestion is a function of the pair; re-running on its own
    // fields would loop, so the pair is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baselineDir, targetDir]);

  const refreshCached = useCallback(async () => {
    if (!desktop?.octreeSkeletonInfo) return;
    const out: Record<string, SkeletonInfo | null> = {};
    for (const e of octreeList) {
      try { out[e.dir] = await desktop.octreeSkeletonInfo(e.dir); }
      catch { out[e.dir] = null; }
    }
    setCached(out);
  }, [desktop, octreeList]);
  useEffect(() => { void refreshCached(); }, [refreshCached]);

  // Orphan-run check. After the renderer died mid-build and the page
  // was reloaded, the first build was still running and the user
  // started a second one on top of it — the backend now refuses that,
  // but the page should also SAY there is one, and offer the Stop.
  useEffect(() => {
    if (!desktop?.octreeStageRunning || busy) return;
    let alive = true;
    const ask = desktop.octreeStageRunning;
    const poll = async () => {
      try {
        const r = await ask('tst');
        if (alive) setOrphanRun(r);
      } catch { /* not available in this build */ }
    };
    void poll();
    const t = setInterval(poll, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [desktop, busy]);

  // Native progress channel — both build + transfer emit on "tst".
  useEffect(() => {
    if (!busy) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((stage, p) => {
      if (stage === 'tst') setPct(p);
    }).then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [busy]);

  const cancelRun = useCallback(async () => {
    if (!desktop?.octreeCancel) return;
    setStopping(true);
    try { await desktop.octreeCancel('tst'); } catch { /* nothing was running */ }
  }, [desktop]);

  // -------------------- BUILD --------------------------------------
  const runBuild = useCallback(async () => {
    if (!desktop?.octreeBuildSkeletons || !baselineDir) return;
    setBusy('build'); setPct(0); setError(null); setBuildResult(null); setStopping(false);
    try {
      const res = await desktop.octreeBuildSkeletons(baselineDir, {
        skeletonSpacing: spacingMm * 0.001,
        rCover: rCoverCm * 0.01,
        minTreePoints: minPts,
        qsmModels,
        maxTreePoints: maxPts * 1000,
        groundThreshold: baselineGroundCm * 0.01,
        skipAddedCylinders: skipAdded,
        dropFarFragments: dropFragments,
      });
      setBuildResult(res);
      void refreshCached();
      // Auto-load the just-built skeletons into the viewport so the
      // user sees them immediately.
      setViewedDir(baselineDir);
      if (desktop.octreeReadSkeletons) {
        const payload = await desktop.octreeReadSkeletons(baselineDir);
        if (payload) pushToOverlay(payload);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null); setStopping(false);
    }
  }, [desktop, baselineDir, spacingMm, rCoverCm, minPts, baselineGroundCm, qsmModels, skipAdded, dropFragments, refreshCached]);

  // -------------------- VIEW ---------------------------------------
  const pushToOverlay = useCallback((payload: SkeletonReadPayload) => {
    // The arrays go to the overlay as they arrived. They used to be
    // copied out of JSON number arrays here, on top of the parse that
    // made those — for tens of millions of points, the copies that
    // finished off the renderer.
    lastPayloadRef.current = payload;
    lastPayloadDirRef.current = viewedDir;
    setSkeletonOverlay({
      origin: payload.origin, xyz: payload.xyz, treeId: payload.treeId, order: payload.order,
      radiusMm: payload.radiusMm, colorMode: skelColor, sourceDir: viewedDir,
    });
    // Skeletons alone: the cloud goes away while they show, and comes
    // back with Hide — see showCloud.
    if (skelOnly) setCloudVisible(false);
    setViewedSummary({
      pointCount: payload.pointCount,
      treeCount: payload.treeCount,
      spacing: payload.skeletonSpacing,
    });
    const ids = Array.from(new Set(payload.treeId)).sort((a, b) => a - b);
    setTreeIds(ids);
    setExportTree(prev => (prev && ids.includes(Number(prev)) ? prev : ''));
  }, [setSkeletonOverlay, skelColor, skelOnly, setCloudVisible, viewedDir]);

  // A new colour applies to what is on screen without reloading it.
  useEffect(() => {
    const payload = lastPayloadRef.current;
    if (!payload) return;
    setSkeletonOverlay({
      origin: payload.origin, xyz: payload.xyz, treeId: payload.treeId, order: payload.order,
      radiusMm: payload.radiusMm, colorMode: skelColor, sourceDir: lastPayloadDirRef.current || undefined,
    });
  }, [skelColor, setSkeletonOverlay]);

  const loadViz = useCallback(async () => {
    if (!desktop?.octreeReadSkeletons || !viewedDir) return;
    setBusy('view'); setError(null);
    try {
      const payload = await desktop.octreeReadSkeletons(viewedDir);
      if (!payload) {
        setError('No skeletons.bin in that dataset — build skeletons first.');
        setSkeletonOverlay(null);
        setViewedSummary(null);
        setTreeIds([]);
      } else {
        pushToOverlay(payload);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [desktop, viewedDir, pushToOverlay, setSkeletonOverlay]);

  // Skeletons off, cloud back — whatever hid the cloud. The cloud is
  // where a transfer's result is, and it was the one thing this panel
  // could not reliably bring back: Hide used to remember in a ref
  // whether THIS panel instance had hidden the cloud, and was disabled
  // without a summary to show. A panel closed and reopened, or a module
  // switched and returned to, had neither — the skeletons stayed on,
  // the cloud stayed hidden, and the way back was the Layers panel.
  // The overlay and the cloud's visibility are the shell's state, so
  // that is what this reads and sets.
  const showCloud = useCallback(() => {
    setSkeletonOverlay(null);
    setCloudVisible(true);
  }, [setSkeletonOverlay, setCloudVisible]);
  const clearViz = useCallback(() => {
    showCloud();
    setViewedSummary(null);
    setTreeIds([]);
    lastPayloadRef.current = null;
    lastPayloadDirRef.current = '';
  }, [showCloud]);

  const clearCacheOnViewed = useCallback(async () => {
    if (!desktop?.octreeClearSkeletons || !viewedDir) return;
    const alsoBaseline = sameDir(viewedDir, baselineDir);
    if (!await confirmDialog(
      `Delete the cached skeletons.bin from ${findDir(octreeList, viewedDir)?.name ?? 'this dataset'}?`
      + (alsoBaseline
        ? '\n\nThis is the baseline selected in step 1, so the next transfer will have to rebuild it from scratch.'
        : '\n\nThis is NOT the baseline selected in step 1, so the next transfer is unaffected.')
    )) return;
    try {
      await desktop.octreeClearSkeletons(viewedDir);
      void refreshCached();
      setSkeletonOverlay(null);
      setViewedSummary(null);
      if (sameDir(viewedDir, baselineDir)) setBuildResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [desktop, viewedDir, baselineDir, octreeList, refreshCached, setSkeletonOverlay]);

  // -------------------- EXPORT -------------------------------------
  const exportSkeletons = useCallback(async (format: ExportFormat) => {
    if (!desktop?.octreeExportSkeletons || !viewedDir) return;
    // Save dialog with the right extension + filter per format. LAZ
    // uses the same LAS-writer path on the backend (the `las` crate
    // routes to its LAZ-parallel writer when the path ends `.laz`),
    // so the panel just passes the format token through.
    const ext = `.${format}`;
    // Named after the dataset, not "skeletons". Exporting from three
    // clouds used to give skeletons.csv, skeletons (1).csv and
    // skeletons (2).csv, and nothing in any of them says which cloud
    // it came from.
    const stem = (findDir(octreeList, viewedDir)?.name ?? 'skeletons')
      .replace(/[\\/:*?"<>|]+/g, '_');
    const onlyTree = exportTree === '' ? undefined : Number(exportTree);
    const filterName = format === 'las' || format === 'laz'
      ? `LAS / LAZ point cloud (${format.toUpperCase()})`
      : format.toUpperCase();
    // Both pickers are Rust commands (src-tauri/src/commands/file.rs):
    // opening them there is what lets the backend tell a path the user
    // chose from one the renderer named, and that is what permits the
    // write at all (src-tauri/src/fsgrant.rs). One file per tree goes
    // into a DIRECTORY, so that mode asks for one — and picking a
    // folder grants everything under it, which is what the per-tree
    // files need.
    //
    // There is deliberately no window.prompt fallback any more. A path
    // typed into a prompt carries no proof the user chose it, so the
    // backend would refuse the write and the export would fail with a
    // permission error instead of a missing dialog.
    const suffix = onlyTree !== undefined ? `_tree${onlyTree}` : '';
    const outPath = perTree
      ? await desktop.browseForFolder?.('Folder for one file per tree') ?? null
      : await desktop.saveExportDialog?.(
          `${stem}_skeletons${suffix}${ext}`,
          [{ name: filterName, extensions: [format] }],
          `Export skeletons (${format.toUpperCase()})`,
        ) ?? null;
    if (!outPath) return;
    setBusy('export'); setError(null);
    try {
      const res = await desktop.octreeExportSkeletons(viewedDir, outPath, format,
        { onlyTreeId: onlyTree, perTree });
      const sizeKb = res.bytesWritten / 1024;
      const sizeStr = sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb.toFixed(0)} KB`;
      const what = res.fileCount > 1
        ? `${res.fileCount} files, one per tree`
        : `${res.treeCount} tree${res.treeCount === 1 ? '' : 's'}`;
      void alertDialog(
        `Exported ${res.pointCount.toLocaleString()} skeleton points (${what})\n→ ${res.path}\n(${sizeStr})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [desktop, viewedDir, octreeList, exportTree, perTree]);

  // The names the panel shows, and that the confirm dialog names when
  // it says which cloud is about to be overwritten — so they are
  // declared before the callback that reads them, not after it.
  const baselineLabel = findDir(baselineCandidates, baselineDir)?.name ?? '';
  const viewedLabel = findDir(octreeList, viewedDir)?.name ?? '';
  const targetLabel = findDir(octreeList, targetDir)?.name ?? '';

  // -------------------- TRANSFER -----------------------------------
  const runTransfer = useCallback(async () => {
    if (!api || !baselineDir || !targetDir) return;
    // `hasTreeIds` reads the loaded point store, which is the OPEN
    // dataset — it can say nothing about a target that is not open.
    // Claiming "this cloud has no tree_id data" about a cloud it never
    // looked at would be the reassuring half of a wrong answer, so an
    // unopened target gets the destructive warning unconditionally.
    const targetIsOpen = sameDir(targetDir, octree?.dir);
    const name = targetLabel || 'the target';
    const msg = !targetIsOpen
      ? `Skeleton Transfer REPLACES every tree_id + semantic class in ${name} with the labels propagated from ${baselineLabel || 'the baseline'}.\n\n${name} is not the dataset you have open, so its existing labels — if it has any — cannot be checked from here and will be lost. This is saved immediately and can't be undone with Ctrl+Z.\n\nContinue?`
      : api.hasTreeIds()
        ? `${name} already has tree_id data (e.g. an imported column or a previous segmentation).\n\nSkeleton Transfer REPLACES every tree_id + semantic class with the labels propagated from the baseline. The existing values will be lost. This is saved immediately and can't be undone with Ctrl+Z.\n\nContinue?`
        : `Skeleton Transfer writes fresh tree_ids + semantic classes from the baseline's QSM skeletons, overwriting any existing labels in ${name}. Continue?`;
    if (!await confirmDialog(msg)) return;
    setBusy('transfer'); setPct(0); setError(null); setTransferResult(null); setStopping(false);
    try {
      const res = await api.skeletonTransfer(baselineDir, targetDir, {
        distanceThreshold: distanceCm * 0.01,
        skeletonSpacing: spacingMm * 0.001,
        groundThreshold: groundCm * 0.01,
        baselineGroundThreshold: baselineGroundCm * 0.01,
        rCover: rCoverCm * 0.01,
        minTreePoints: minPts,
        qsmModels,
        maxTreePoints: maxPts * 1000,
        labelBeyondThreshold: labelBeyond,
        skipAddedCylinders: skipAdded,
        dropFarFragments: dropFragments,
        baselineHeight: baseHeight,
        targetHeight: tgtHeight,
      });
      setTransferResult(res);
      // Colour by tree_id to show the result — but only when the
      // result is what the viewport is showing. Recolouring the open
      // cloud after labelling a DIFFERENT one presents somebody else's
      // tree_ids as the outcome of the run that just finished.
      if (targetIsOpen) {
        setDisplay({ colorMode: 'tree_id' });
        setFilters({ isolateTreeId: null });
        // The result is in the cloud: skeletons off and the cloud back,
        // so what is on screen is the run's outcome — not a hidden
        // cloud under the skeletons it was labelled from.
        showCloud();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null); setStopping(false);
    }
  }, [api, baselineDir, targetDir, octree?.dir, targetLabel, baselineLabel,
      distanceCm, spacingMm, groundCm, baselineGroundCm, rCoverCm, minPts, qsmModels, skipAdded, dropFragments,
      labelBeyond, baseHeight, tgtHeight, setDisplay, setFilters, showCloud]);

  // -------------------- COMPARE (step 4) -----------------------------
  // The view itself is three/CompareView.tsx, shown by the shell in place
  // of the viewport while `compare` is set; this is its control surface.
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState('');
  const [selectedView, setSelectedView] = useState('');
  const [exportW, setExportW] = useState(DEFAULT_EXPORT_SIZE.width);
  const [exportH, setExportH] = useState(DEFAULT_EXPORT_SIZE.height);
  const [sideBySide, setSideBySide] = useState(true);
  const [compareNote, setCompareNote] = useState<string | null>(null);
  const [compareBusy, setCompareBusy] = useState<'export' | 'views' | null>(null);
  const nameOf = useCallback((dir: string) => findDir(octreeList, dir)?.name ?? dir, [octreeList]);
  const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
  // Saved views live beside the TARGET: the pair is about the target's
  // labels, and the target is the dataset the figures are of.
  const viewsPath = compare ? `${compare.targetDir}/${COMPARE_VIEWS_FILE}` : null;

  const readViews = useCallback(async (path: string): Promise<SavedView[]> => {
    if (!desktop?.readFile) return [];
    try {
      return parseViews(new TextDecoder().decode(await desktop.readFile(path)));
    } catch {
      // No file yet, or not one of ours: no views. Saving writes a fresh one.
      return [];
    }
  }, [desktop]);
  useEffect(() => {
    if (!viewsPath) { setViews([]); setSelectedView(''); return; }
    let cancelled = false;
    void readViews(viewsPath).then((v) => {
      if (cancelled) return;
      setViews(v);
      setSelectedView(v[0]?.name ?? '');
    });
    return () => { cancelled = true; };
  }, [viewsPath, readViews]);

  const openCompare = useCallback(async () => {
    if (!baselineDir || !targetDir || sameDir(baselineDir, targetDir)) return;
    setCompareNote(null); setError(null);
    // The compare shows what is on disk, so the open cloud's edits go
    // there first — the view replaces the editor while it is up.
    try { await api?.save(); }
    catch (e) { setError(`Could not save the open cloud before comparing: ${e instanceof Error ? e.message : String(e)}`); return; }
    setCompare({
      sourceDir: baselineDir, targetDir, colorMode: 'tree_id', showSkeleton: false, skeletonColor: skelColor,
      hideUnlabeled: false,
      // Heights aligned when the two clouds are not in the same height
      // (a normalised plot beside an epoch in elevation); as stored
      // otherwise, so a real vertical offset between two epochs shows.
      alignHeights: frameSuggestion.mismatch,
    });
  }, [api, baselineDir, targetDir, setCompare, skelColor, frameSuggestion.mismatch]);

  const setCompareColor = useCallback((m: CompareColorMode) => {
    setCompare((prev) => (prev ? { ...prev, colorMode: m } : prev));
  }, [setCompare]);
  const setCompareFlag = useCallback((patch: Partial<Pick<NonNullable<typeof compare>, 'hideUnlabeled' | 'alignHeights' | 'skeletonColor'>>) => {
    setCompare((prev) => (prev ? { ...prev, ...patch } : prev));
  }, [setCompare]);
  const compareColumns = compareApi?.columns() ?? [];
  const compareBases = compareApi?.heightBases() ?? { source: 0, target: 0 };

  const setCompareSkeleton = useCallback(async (on: boolean) => {
    if (on && !skeletonOverlay && compare) {
      // Not loaded yet: read the source's cache straight into the
      // overlay — without touching the cloud's visibility, which is the
      // editor's, not the compare's.
      if (!desktop?.octreeReadSkeletons) return;
      try {
        const payload = await desktop.octreeReadSkeletons(compare.sourceDir);
        if (!payload) { setError('The source has no skeletons.bin — build them in step 1 first.'); return; }
        lastPayloadRef.current = payload;
        lastPayloadDirRef.current = compare.sourceDir;
        setSkeletonOverlay({
          origin: payload.origin, xyz: payload.xyz, treeId: payload.treeId, order: payload.order,
          radiusMm: payload.radiusMm, colorMode: skelColor, sourceDir: compare.sourceDir,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setCompare((prev) => (prev ? { ...prev, showSkeleton: on } : prev));
  }, [compare, desktop, skeletonOverlay, setSkeletonOverlay, skelColor, setCompare]);

  const writeViews = useCallback(async (next: SavedView[]) => {
    if (!viewsPath || !desktop?.writeFile) return false;
    setCompareBusy('views');
    try {
      await desktop.writeFile(viewsPath, serializeViews(next));
      setViews(next);
      return true;
    } catch (e) {
      setError(`Could not write ${COMPARE_VIEWS_FILE}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    } finally {
      setCompareBusy(null);
    }
  }, [viewsPath, desktop]);

  const saveView = useCallback(async () => {
    if (!compare || !compareApi) return;
    const name = viewName.trim() || `View ${views.length + 1}`;
    const view: SavedView = {
      name, savedAt: new Date().toISOString(), pose: compareApi.getPose(),
      source: { dir: compare.sourceDir, name: nameOf(compare.sourceDir) },
      target: { dir: compare.targetDir, name: nameOf(compare.targetDir) },
      heightBase: compareApi.heightBases(),
    };
    if (await writeViews([...views.filter((v) => v.name !== name), view])) {
      setSelectedView(name);
      setViewName('');
      setCompareNote(`Saved view “${name}” to ${COMPARE_VIEWS_FILE} beside the target.`);
    }
  }, [compare, compareApi, viewName, views, nameOf, writeViews]);

  const loadView = useCallback(() => {
    const v = views.find((x) => x.name === selectedView);
    if (!v || !compareApi) return;
    compareApi.setPose(v.pose);
    const now = compareApi.heightBases();
    const saved = v.heightBase ?? { source: 0, target: 0 };
    const sameBase = Math.abs(now.source - saved.source) < 1e-6 && Math.abs(now.target - saved.target) < 1e-6;
    setCompareNote(`View “${v.name}” loaded (saved ${new Date(v.savedAt).toLocaleString()}).`
      + (sameBase ? '' : ` It was saved with heights ${saved.target === 0 && saved.source === 0 ? 'as stored' : 'aligned'} and they are ${now.target === 0 && now.source === 0 ? 'as stored' : 'aligned'} now — toggle “align heights” to see it as it was saved.`));
  }, [views, selectedView, compareApi]);

  const deleteView = useCallback(async () => {
    if (!selectedView) return;
    const next = views.filter((v) => v.name !== selectedView);
    if (await writeViews(next)) {
      setSelectedView(next[0]?.name ?? '');
      setCompareNote(`Removed view “${selectedView}”.`);
    }
  }, [views, selectedView, writeViews]);

  const exportFigures = useCallback(async () => {
    if (!compare || !compareApi || !desktop?.browseForFolder || !desktop.writeFileBytes || !desktop.writeFile) return;
    const folder = await desktop.browseForFolder('Folder for the compare figures');
    if (!folder) return;
    setCompareBusy('export'); setError(null);
    setCompareNote('Rendering both panes at full detail…');
    try {
      const size = clampExportSize(exportW, exportH);
      const names = exportFileNames(`${folder}/compare_${exportStamp(new Date())}`, sideBySide);
      const res = await compareApi.exportFigures({ width: size.width, height: size.height, sideBySide });
      await desktop.writeFileBytes(names.source, res.source.png);
      await desktop.writeFileBytes(names.target, res.target.png);
      if (names.sideBySide && res.sideBySide) await desktop.writeFileBytes(names.sideBySide, res.sideBySide);
      const sidecar = buildSidecar({
        appVersion: __APP_VERSION__,
        exportedAt: new Date().toISOString(),
        camera: res.camera,
        heightBase: res.heightBase,
        colorMode: compare.colorMode,
        hideUnlabeled: compare.hideUnlabeled,
        skeletonOverlay: compare.showSkeleton && !!skeletonOverlay,
        skeletonColor: compare.showSkeleton && skeletonOverlay ? compare.skeletonColor : null,
        pixelSize: { width: res.width, height: res.height },
        source: { dir: compare.sourceDir, name: nameOf(compare.sourceDir), pointsRendered: res.source.pointsRendered, file: basename(names.source) },
        target: { dir: compare.targetDir, name: nameOf(compare.targetDir), pointsRendered: res.target.pointsRendered, file: basename(names.target) },
        sideBySide: names.sideBySide ? basename(names.sideBySide) : null,
      });
      await desktop.writeFile(names.sidecar, JSON.stringify(sidecar, null, 2));
      const unsettled = !res.source.settled || !res.target.settled;
      setCompareNote(
        `Wrote ${basename(names.source)}, ${basename(names.target)}`
        + `${names.sideBySide ? `, ${basename(names.sideBySide)}` : ''} and ${basename(names.sidecar)}`
        + ` · ${res.source.pointsRendered.toLocaleString()} / ${res.target.pointsRendered.toLocaleString()} points rendered`
        + (unsettled ? ' · a pane had NOT finished loading when it rendered — export again' : '') + '.',
      );
    } catch (e) {
      setError(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
      setCompareNote(null);
    } finally {
      setCompareBusy(null);
    }
  }, [compare, compareApi, desktop, exportW, exportH, sideBySide, skeletonOverlay, nameOf]);

  const transferRatio = transferResult && transferResult.targetEligibleCount > 0
    ? transferResult.transferredCount / transferResult.targetEligibleCount
    : 0;
  const transferColor =
    transferRatio >= 0.85 ? '#67d391' :
    transferRatio >= 0.60 ? '#e6c068' : '#e0817b';

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 440 }}>
      {!canRun && (
        <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Skeleton transfer needs the desktop build and an open target dataset.
        </div>
      )}
      {orphanRun && !busy && (
        <div className="mono text-[10.5px] rounded px-2 py-1.5 flex items-center gap-2"
          style={{ background: 'rgba(230,192,104,0.08)', border: '1px solid rgba(230,192,104,0.35)', color: 'var(--text)', lineHeight: 1.5 }}>
          <span style={{ flex: 1 }}>
            A skeleton build or transfer is still running in the background — it
            started before this view was loaded. Starting another is refused until
            it finishes; its progress is in <b>skeletons.log</b> beside the dataset.
          </span>
          <button className="btn !h-6 mono text-[10.5px]" onClick={() => void cancelRun()}>Stop it</button>
        </div>
      )}

      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      {/* -------- Stage 1: Build -------- */}
      <Section title="1. Build skeletons" sub="fit TreeQSM on each baseline tree → skeletons.bin">
        <div className="flex flex-col gap-1.5">
          <label className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Baseline dataset</label>
          {baselineCandidates.length === 0 ? (
            <div className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
              No other dataset in the project. Import a segmented baseline cloud first.
            </div>
          ) : (
            <select
              value={baselineDir}
              onChange={(e) => setBaselineDir(e.target.value)}
              disabled={!!busy}
              className="mono text-[11px] rounded-md px-1.5 py-1"
              style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
            >
              {baselineCandidates.map(e => (
                <option key={e.dir} value={e.dir}>
                  {e.name} · {e.pointCount.toLocaleString()} pts
                  {cached[e.dir] ? ` · ✓ ${cached[e.dir]!.treeCount} skeletons` : ' · no skeletons yet'}
                </option>
              ))}
            </select>
          )}
          <SliderRow label="Skeleton spacing" unit="mm" value={spacingMm} min={5} max={100} step={5} setValue={setSpacingMm} disabled={!!busy} />
          <SliderRow label="PatchDiam1 (cover size)" unit="cm" value={rCoverCm} min={2} max={20} step={1} setValue={setRCoverCm} disabled={!!busy} />
          <SliderRow label="Min tree points" unit="" value={minPts} min={0} max={2000} step={10} setValue={setMinPts} disabled={!!busy} />
          <SliderRow label="Ground threshold" unit="cm" value={baselineGroundCm} min={0} max={100} step={5} setValue={setBaselineGroundCm} disabled={!!busy} />
          <SliderRow label="QSM models per tree" unit="" value={qsmModels} min={1} max={8} step={1} setValue={setQsmModels} disabled={!!busy} />
          <label className="mono text-[10px] flex items-center gap-1.5 px-0.5" style={{ color: 'var(--text-dim)' }}
            title="On: cylinders that span a gap are left out of the skeleton — TreeQSM's connectors (cylinder.added), spliced across a gap between a branch and its parent rather than fit to points, and any branch cylinder 1 m or longer with points along less than half of its length, flag or not. Either is a straight line between two things; when one of them is a stray cluster far from the tree it is the long straight fake branch, which the transfer would then label along. The stem is never judged: under a canopy it is legitimately interpolated across a stretch with no returns, and it carries the stem class into the transfer. The log names every tree and both counts. Off: the reference's skeleton, every cylinder.">
            <input type="checkbox" checked={skipAdded} disabled={!!busy}
              onChange={(e) => setSkipAdded(e.target.checked)} />
            leave out gap-spanning cylinders (TreeQSM added, or a branch 1 m+ with no points along it)
          </label>
          <label className="mono text-[10px] flex items-center gap-1.5 px-0.5" style={{ color: 'var(--text-dim)' }}
            title="On: points of an id that stand 12 m or further from the rest of the tree (50 points or more) are left out before TreeQSM sees the tree. Given a 2 174-point sliver 53 m from tree 228, the reference took the sliver for the tree because its base sat lower and modelled 2.9 m of a 34.7 m tree; with the sliver out it models the tree. The log names every fragment either way. Off: the reference's input, everything under the id.">
            <input type="checkbox" checked={dropFragments} disabled={!!busy}
              onChange={(e) => setDropFragments(e.target.checked)} />
            leave out far fragments before reconstructing
          </label>
          <SliderRow label="Max tree points" unit="k" value={maxPts} min={0} max={3000} step={50} setValue={setMaxPts} disabled={!!busy} />
          <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            Defaults are the reference&rsquo;s: PatchDiam1 8 cm and
            spacing 20 mm are create_input.m and TST_pc_tree_skeleton.m.
            The other three are not in it — it cuts no ground from the
            baseline and applies no minimum tree size, so zero matches
            there; zero on the last leaves the tree cap to the machine
            (below). Raise the first two for speed on a noisy segmentation.
          </div>
          <div className="mono text-[9.5px]" style={{ lineHeight: 1.5, color: 'var(--text-mute)' }}>
            {maxPts === 0
              ? 'Max tree points is automatic: a quarter of the in-flight point budget, never under 1 M points, and skeletons.log names the cap and every tree it touched. Trees above it are thinned by the reference\u2019s own cubical downsampling at a coarser edge \u2014 8 mm for most \u2014 so four trees reconstruct at once where one giant used to run alone for an hour on one core. TreeQSM\u2019s cover sets are 2 cm across, so points closer than that add nothing to the skeleton. Set a value to fix the cap yourself.'
              : `Segments over ${maxPts}k points are thinned to fit by the reference\u2019s own cubical downsampling at a coarser edge, and skeletons.log names every tree it touched. A set cap is used as it is, whatever the machine could hold.`}
          </div>
          {baselineDir && sameDir(baselineDir, octree?.dir) && (
            <div className="mono text-[9.5px]" style={{ lineHeight: 1.5, color: '#e6c068' }}>
              The build reads the baseline straight from disk, so it does
              not need to be the cloud you have open — and the open one
              costs memory the reconstruction also wants. On a large plot,
              open a small dataset and pick this one as the baseline.
            </div>
          )}
          <div className="mono text-[9.5px]" style={{ lineHeight: 1.5, color: qsmModels > 1 ? '#e6c068' : 'var(--text-mute)' }}>
            {qsmModels === 1
              ? '1 model per tree is the reference: TST_pc_tree_skeleton.m builds the skeleton from QSM_tree_t<id>_m1.mat and reads QSM.cylinder, which resolves only for a single model. Raise it to search a wider field \u2014 at N\u00d7 the run time, and no longer matching the MATLAB pipeline.'
              : `${qsmModels}\u00d7 the reference\u2019s run time. TST_pc_tree_skeleton.m uses model m1 only, so anything above 1 searches a wider field than the MATLAB pipeline does and picks by select_optimum, which is not in its path.`}
          </div>
          <button
            className="btn !h-7 mono text-[11px] justify-center"
            disabled={!desktop?.octreeBuildSkeletons || !baselineDir || !!busy}
            onClick={runBuild}
            style={{
              background: busy === 'build' ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
              color: busy === 'build' ? 'var(--accent)' : undefined,
            }}
          >
            {busy === 'build' ? `Building (${(pct * 100).toFixed(0)} %)…` : `Build skeletons for ${baselineLabel || 'baseline'}`}
          </button>
          {busy === 'build' && (
            <>
              <ProgressBar pct={pct} />
              <button
                className="btn !h-6 mono text-[10px] justify-center"
                disabled={!desktop?.octreeCancel || stopping}
                onClick={cancelRun}
                title="Stop now. The trees in flight are abandoned; every tree finished so far is kept, and Build again with the same settings resumes from them."
              >
                {stopping ? 'Stopping…' : 'Cancel'}
              </button>
            </>
          )}
          {buildResult && !busy && buildResult.complete === false && (
            <div className="mono text-[10px]" style={{ color: '#e6c068', lineHeight: 1.55 }}>
              <span style={{ fontWeight: 600 }}>■ Stopped</span> — {buildResult.treeCount} of {buildResult.treesTotal} trees built,
              {' '}{buildResult.treesRemaining} remain ·
              {' '}{buildResult.pointCount.toLocaleString()} skeleton pts
              <br />
              The finished trees are kept in skeletons.bin. Build again with the same settings to resume from them;
              a transfer refuses this cache until the plot is complete.
            </div>
          )}
          {buildResult && !busy && buildResult.complete !== false && (
            <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
              <span style={{ color: 'var(--accent)' }}>✓ Built</span> {buildResult.treeCount}
              {buildResult.treesTotal ? ` of ${buildResult.treesTotal}` : ''} trees ·
              {' '}{buildResult.pointCount.toLocaleString()} skeleton pts ·
              {' '}{(buildResult.bytesWritten / 1024 / 1024).toFixed(1)} MB
              <br />
              spacing {(buildResult.skeletonSpacing * 1000).toFixed(0)} mm
              <br />
              saved to <span style={{ color: 'var(--text-dim)' }}>
                {cached[baselineDir]?.path ?? `${baselineLabel}/skeletons.bin`}
              </span>
              {buildResult.qsmPath && (
                <>
                  <br />
                  QSM cylinders saved to <span style={{ color: 'var(--text-dim)' }}
                    title={`${buildResult.qsmPath}\nOne row per TreeQSM cylinder of every tree, world coordinates: tree_id, cyl, start/end/axis xyz, length, radius, unmod_radius, volume, parent, extension, branch, branch_order, position_in_branch, added, region_points, mad, surf_cov. For use in other software, or later in this one.`}>
                    {buildResult.qsmPath.split(/[\\/]/).pop()}
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* -------- Stage 2: View / Export -------- */}
      <Section title="2. View skeletons in viewport" sub="load cached skeletons + draw as coloured dots">
        <div className="flex flex-col gap-1.5">
          {octreeList.length === 0 ? (
            <div className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
              No datasets in the project.
            </div>
          ) : (
            <select
              value={viewedDir}
              onChange={(e) => setViewedDir(e.target.value)}
              disabled={!!busy}
              className="mono text-[11px] rounded-md px-1.5 py-1"
              style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
            >
              {octreeList.map(e => (
                <option key={e.dir} value={e.dir}>
                  {e.name}
                  {cached[e.dir] ? ` · ✓ ${cached[e.dir]!.pointCount.toLocaleString()} pts` : ' · no skeletons'}
                </option>
              ))}
            </select>
          )}
          <div className="flex items-center gap-1.5">
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)', width: 52 }}>colour</span>
            {(['tree', 'class', 'radius'] as SkeletonColorMode[]).map(m => (
              <button
                key={m}
                className="btn !h-6 mono text-[10px] flex-1 justify-center"
                onClick={() => setSkelColor(m)}
                style={{
                  background: skelColor === m ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
                  color: skelColor === m ? 'var(--accent)' : undefined,
                }}
                title={m === 'tree' ? 'One colour per tree id — the instance segmentation the transfer moves.'
                  : m === 'class' ? 'Stem (branching order 0) in one colour, branches in another — the semantic class the transfer moves.'
                  : 'The QSM cylinder radius the point was sampled from: dark blue thin, through green, to yellow thick (log scale, 3 mm to 60 cm).'}
              >{m === 'tree' ? 'tree id' : m}</button>
            ))}
          </div>
          <label className="mono text-[10px] flex items-center gap-1.5 px-0.5" style={{ color: 'var(--text-dim)' }}
            title="Hide the point cloud while the skeletons show, so they can be read on their own; the Hide button brings the cloud back. Off: the skeletons draw over the cloud.">
            <input type="checkbox" checked={skelOnly} onChange={(e) => {
              setSkelOnly(e.target.checked);
              if (skeletonOverlay) setCloudVisible(!e.target.checked);
            }} />
            show the skeletons alone (hide the point cloud)
          </label>
          <div className="flex gap-1.5">
            <button
              className="btn !h-7 mono text-[11px] justify-center flex-1"
              disabled={!desktop?.octreeReadSkeletons || !viewedDir || !!busy}
              onClick={loadViz}
            >
              {busy === 'view' ? 'Loading…' : 'Load + show'}
            </button>
            <button
              className="btn !h-7 mono text-[11px] justify-center"
              disabled={(!skeletonOverlay && cloudVisible) || !!busy}
              onClick={clearViz}
              title="Take the skeletons off and bring the point cloud back — the transfer's result is in the cloud. Works whatever hid the cloud, and after this panel was closed and reopened."
            >
              Hide · show cloud
            </button>
            <button
              className="btn !h-7 mono text-[11px] justify-center"
              disabled={!desktop?.octreeClearSkeletons || !viewedDir || !!busy}
              onClick={clearCacheOnViewed}
              title="Delete the cached skeletons.bin for the selected dataset"
            >
              Clear cache
            </button>
          </div>
          {viewedSummary && (
            <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
              Showing <span style={{ color: 'var(--accent)' }}>{viewedSummary.treeCount}</span> trees ·
              {' '}{viewedSummary.pointCount.toLocaleString()} skeleton pts ·
              {' '}spacing {(viewedSummary.spacing * 1000).toFixed(0)} mm — from {viewedLabel}
            </div>
          )}
          <div className="flex flex-col gap-1 mt-0.5">
            <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
              Export{!viewedSummary && ' — load a dataset\u2019s skeletons above first'}
            </div>
            <div className="flex items-center gap-1.5">
              <select
                value={exportTree}
                onChange={(e) => setExportTree(e.target.value)}
                disabled={!viewedSummary || !!busy}
                className="mono text-[10.5px] rounded-md px-1.5 py-1 flex-1"
                style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
              >
                <option value="">All trees ({treeIds.length})</option>
                {treeIds.map(t => <option key={t} value={String(t)}>Tree {t} only</option>)}
              </select>
              <label className="mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}
                title="One file per tree in a folder you choose, named tree_<id>_skeleton.<ext> — the layout TST_pc_tree_skeleton.m writes, so the result drops straight into the reference's own skeletons/ folder.">
                <input type="checkbox" checked={perTree} disabled={!viewedSummary || !!busy}
                  onChange={(e) => setPerTree(e.target.checked)} />
                one file per tree
              </label>
            </div>
            <div className="flex gap-1.5">
              <button
                className="btn !h-7 mono text-[10.5px] justify-center flex-1"
                disabled={!desktop?.octreeExportSkeletons || !viewedSummary || !!busy}
                onClick={() => exportSkeletons('txt')}
                title="x,y,h,tree_id,branch_order,class,radius — the header and the %.3f rows TST_get_tree_skeletons_v3.m writes for its combined <plot>_skeletonpoints_<year>.txt, plus the class (1 stem, 2 branch) and the QSM cylinder radius (m), so MATLAB reads it back by column name."
              >
                TXT
              </button>
              <button
                className="btn !h-7 mono text-[10.5px] justify-center flex-1"
                disabled={!desktop?.octreeExportSkeletons || !viewedSummary || !!busy}
                onClick={() => exportSkeletons('csv')}
                title="x,y,z,tree_id,branch_order,class,radius — the same rows as TXT with the third column named for what it is."
              >
                CSV
              </button>
              <button
                className="btn !h-7 mono text-[10.5px] justify-center flex-1"
                disabled={!desktop?.octreeExportSkeletons || !viewedSummary || !!busy}
                onClick={() => exportSkeletons('ply')}
                title="ASCII PLY 1.0 — x y z as doubles, then tree_id, branch_order, class (1 stem, 2 branch) and radius (m)"
              >
                PLY
              </button>
              <button
                className="btn !h-7 mono text-[10.5px] justify-center flex-1"
                disabled={!desktop?.octreeExportSkeletons || !viewedSummary || !!busy}
                onClick={() => exportSkeletons('las')}
                title="LAS 1.4 point format 2 with Extra Bytes named tree_id, branch_order, class (1 stem, 2 branch) and radius (m) — what a reader lists as scalar fields. The same values also ride in classification, point source id, user data and intensity (mm)."
              >
                LAS
              </button>
              <button
                className="btn !h-7 mono text-[10.5px] justify-center flex-1"
                disabled={!desktop?.octreeExportSkeletons || !viewedSummary || !!busy}
                onClick={() => exportSkeletons('laz')}
                title="Same as LAS but LAZ-compressed (typically 5–10× smaller)"
              >
                LAZ
              </button>
            </div>
          </div>
        </div>
      </Section>

      {/* -------- Stage 3: Transfer -------- */}
      <Section title="3. Transfer labels to target" sub="baseline skeleton → any cloud in the project">
        <div className="flex flex-col gap-1.5">
          <label className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Target dataset</label>
          {targetCandidates.length === 0 ? (
            <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e6c068', background: 'rgba(230,192,104,0.08)', border: '1px solid rgba(230,192,104,0.35)', lineHeight: 1.5 }}>
              No other cloud in the project. The target of a transfer is another epoch of the plot — import it
              (Layers → Import) and it appears here. The baseline itself is never a target: it already carries the labels.
            </div>
          ) : (
            <select
              value={targetDir}
              onChange={(e) => setTargetDir(e.target.value)}
              disabled={!!busy}
              className="mono text-[11px] rounded-md px-1.5 py-1"
              style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
            >
              {targetCandidates.map(e => (
                <option key={e.dir} value={e.dir}>
                  {e.name}{sameDir(e.dir, octree?.dir) ? ' · open' : ''}
                </option>
              ))}
            </select>
          )}
          {targetDir && (
            <div className="flex flex-col gap-1">
              {baselineEntry && targetEntry && frameSuggestion.mismatch && (
                <div className="mono text-[9.5px] px-2 py-1.5 rounded-md" style={{ color: 'var(--text)', background: 'rgba(230,192,104,0.08)', border: '1px solid rgba(230,192,104,0.35)', lineHeight: 1.5 }}>
                  <b style={{ color: '#e6c068' }}>The two clouds are not in the same height.</b>{' '}
                  {baselineLabel}&rsquo;s z is {describeGuess(baselineGuess)} (z {baselineEntry.bboxMin[2].toFixed(1)}…{baselineEntry.bboxMax[2].toFixed(1)} m);{' '}
                  {targetLabel}&rsquo;s is {describeGuess(targetGuess)} (z {targetEntry.bboxMin[2].toFixed(1)}…{targetEntry.bboxMax[2].toFixed(1)} m).
                  Matched as stored they are hundreds of metres apart at every point and nothing transfers — that is what 0.0 % was.
                  The side in elevation is matched by its height above its own ground surface below, which needs a
                  ground classification on that cloud (open it, Tools → Ground classification); the normalised side
                  stays as stored, since its z already is height above ground.
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <span className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }} title="Which z the baseline's skeleton is matched in.">baseline height</span>
                <select value={baseHeight} onChange={(e) => setBaseHeight(e.target.value as HeightFrame)} disabled={!!busy}
                  className="mono text-[10.5px] rounded-md px-1.5 py-0.5 flex-1"
                  style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
                  <option value="stored">z as stored ({describeGuess(baselineGuess)})</option>
                  <option value="above_ground">height above its ground surface (needs ground class)</option>
                </select>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }} title="Which z the target's points are matched in.">target height</span>
                <select value={tgtHeight} onChange={(e) => setTgtHeight(e.target.value as HeightFrame)} disabled={!!busy}
                  className="mono text-[10.5px] rounded-md px-1.5 py-0.5 flex-1"
                  style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}>
                  <option value="stored">z as stored ({describeGuess(targetGuess)})</option>
                  <option value="above_ground">height above its ground surface (needs ground class)</option>
                </select>
              </div>
            </div>
          )}
          <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            Labels flow from <span style={{ color: 'var(--text)' }}>{baselineLabel || '—'}</span> →{' '}
            <span style={{ color: 'var(--text)' }}>{targetLabel || '—'}</span>.
            {targetDir && !sameDir(targetDir, octree?.dir)
              && ' It is not the open dataset, so it picks the new labels up the next time you open it.'}
          </div>
          <div className="mono text-[9.5px]" style={{ lineHeight: 1.5, color: cached[baselineDir] && cached[baselineDir]!.complete !== false ? 'var(--text-mute)' : '#e6c068' }}>
            {cached[baselineDir] && cached[baselineDir]!.complete === false
              ? `${baselineLabel}'s cached skeletons are PARTIAL — ${cached[baselineDir]!.treeCount} trees `
                + `from a build that did not finish. Transferring from them labels only those trees. `
                + 'Build again to complete it; the finished trees are kept, so it resumes rather than restarts.'
              : cached[baselineDir]
              ? `Will reuse ${baselineLabel}'s cached skeletons (${cached[baselineDir]!.treeCount} trees, `
                + `${cached[baselineDir]!.pointCount.toLocaleString()} points, spacing `
                + `${(cached[baselineDir]!.skeletonSpacing * 1000).toFixed(0)} mm). `
                + 'Step 1\u2019s settings do NOT rebuild it \u2014 clear the cache or build again.'
              : `${baselineLabel || 'The baseline'} has no cached skeletons, so this will build them `
                + 'first with step 1\u2019s settings, taking as long as step 1 does.'}
          </div>
          <SliderRow label="Max NN distance" unit="cm" value={distanceCm} min={5} max={100} step={5} setValue={setDistanceCm} disabled={!!busy} />
          <SliderRow label="Ground threshold" unit="cm" value={groundCm} min={0} max={100} step={5} setValue={setGroundCm} disabled={!!busy} />
          <label className="mono text-[10px] flex items-center gap-1.5 px-0.5" style={{ color: 'var(--text-dim)' }}
            title="On (the reference method): a point beyond the distance threshold still takes the tree of the nearest skeleton point, with its semantic class left at 0 to say it is not stem or branch — so a leaf-on crown belongs to its tree. Off: such points are left with no tree at all, which is the stricter reading for a target that contains things other than trees.">
            <input type="checkbox" checked={labelBeyond} disabled={!!busy}
              onChange={(e) => setLabelBeyond(e.target.checked)} />
            label points beyond the threshold
          </label>
          <button
            className="btn !h-7 mono text-[11px] justify-center"
            disabled={!api || !baselineDir || !targetDir || transferIsSelf || targetCandidates.length === 0 || !!busy}
            onClick={runTransfer}
            style={{
              background: busy === 'transfer' ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
              color: busy === 'transfer' ? 'var(--accent)' : undefined,
            }}
          >
            {busy === 'transfer'
              ? `Transferring (${(pct * 100).toFixed(0)} %)…`
              : `Transfer ${baselineLabel || 'baseline'} → ${targetLabel || 'target'}`}
          </button>
          {transferIsSelf && !busy && (
            <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              The baseline and the target are the same cloud, so there is
              nothing to transfer. Build its skeletons above, then open the
              cloud you want to label and come back.
            </div>
          )}
          {busy === 'transfer' && (
            <>
              <ProgressBar pct={pct} />
              <button
                className="btn !h-6 mono text-[10px] justify-center"
                disabled={!desktop?.octreeCancel || stopping}
                onClick={cancelRun}
                title="Stop at the next octree node. The points already written carry their new labels and the rest carry their old ones."
              >
                {stopping ? 'Stopping…' : 'Cancel'}
              </button>
            </>
          )}
          {transferResult && !busy && (
            <div className="rounded-md p-2 flex flex-col gap-0.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
              <div className="mono text-[11px] flex items-center gap-2">
                <span style={{ color: 'var(--accent)' }}>✓ Transferred</span>
                <span style={{ color: transferColor }}>{(transferRatio * 100).toFixed(1)} %</span>
                <span style={{ color: 'var(--text-mute)' }}>of target</span>
              </div>
              <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
                {transferResult.baselineTreeCount} baseline trees · {transferResult.skeletonPointCount.toLocaleString()} skeleton pts
              </div>
              <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
                <span style={{ color: '#67d391' }}>{transferResult.stemCount.toLocaleString()} stem</span>
                <span style={{ color: 'var(--text-dim)' }}> · </span>
                <span style={{ color: '#e6c068' }}>{transferResult.branchCount.toLocaleString()} branch</span>
                <span style={{ color: 'var(--text-dim)' }}> · </span>
                {transferResult.unclassifiedCount.toLocaleString()} not wood (d &gt; {distanceCm} cm)
              </div>
              <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
                {transferResult.outsideHullCount.toLocaleString()} outside the skeleton&rsquo;s outline &mdash; unlabelled
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* -------- Stage 4: Compare -------- */}
      <Section title="4. Compare" sub="source | target under one camera · saved views · figure export">
        <div className="flex flex-col gap-1.5">
          {!compare ? (
            <>
              <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
                Inspect the transfer: <span style={{ color: 'var(--text)' }}>{baselineLabel || 'the baseline'}</span> on the
                left, <span style={{ color: 'var(--text)' }}>{targetLabel || 'the target'}</span> on the right, one camera
                moving both. Read-only; the open cloud&rsquo;s edits are saved first. Use it once the transfer above
                has finished, so the target carries the labels the skeleton propagated.
              </div>
              <button
                className="btn !h-7 mono text-[11px] justify-center"
                disabled={!baselineDir || !targetDir || transferIsSelf || !!busy}
                onClick={() => void openCompare()}
              >
                Open compare · {baselineLabel || 'baseline'} | {targetLabel || 'target'}
              </button>
            </>
          ) : (
            <>
              <button className="btn !h-7 mono text-[11px] justify-center" onClick={() => setCompare(null)}>
                Close compare · back to the open cloud
              </button>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="mono text-[10px] w-[60px]" style={{ color: 'var(--text-dim)' }}>colour</span>
                {([
                  ['tree_id', 'tree id', 'Colour both panes by tree identity, with the viewport\u2019s own palette: an inherited id is the same colour on both sides. Unlabelled (id 0) is the neutral grey.'],
                  ['semantic', 'class', 'Colour both panes by semantic class: stem, branch, unlabelled.'],
                  ['classification', 'classification', 'The ASPRS classification byte: ground, vegetation, and so on.'],
                  ['height', 'height', 'Height ramp over each cloud\u2019s own z span.'],
                  ['intensity', 'intensity', 'Intensity ramp over each cloud\u2019s own recorded range.'],
                ] as [CompareColorMode, string, string][]).map(([m, label, title]) => (
                  <button
                    key={m}
                    className="btn !h-6 mono text-[10px] justify-center"
                    style={compare.colorMode === m ? { background: 'color-mix(in oklch, var(--accent) 18%, transparent)', color: 'var(--accent)' } : undefined}
                    onClick={() => setCompareColor(m)}
                    title={title}
                  >{label}</button>
                ))}
                {compareColumns.length > 0 && (
                  <select
                    value={compare.colorMode.startsWith('extra:') ? compare.colorMode : ''}
                    onChange={(e) => { if (e.target.value) setCompareColor(e.target.value as CompareColorMode); }}
                    className="mono text-[10px] rounded-md px-1.5 py-0.5"
                    style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
                    title="An extra column both clouds carry, ramped over each cloud\u2019s own recorded range."
                  >
                    <option value="">column…</option>
                    {compareColumns.map((c) => <option key={c} value={`extra:${c}`}>{c}</option>)}
                  </select>
                )}
              </div>
              <label className="mono text-[10px] flex items-center gap-1.5 px-0.5" style={{ color: 'var(--text-dim)' }}
                title="Leave the points with tree id 0 out of both panes, so only the labelled trees show. The export follows the view.">
                <input type="checkbox" checked={compare.hideUnlabeled}
                  onChange={(e) => setCompareFlag({ hideUnlabeled: e.target.checked })} />
                hide unlabelled (tree id 0)
              </label>
              <label className="mono text-[10px] flex items-center gap-1.5 px-0.5" style={{ color: 'var(--text-dim)' }}
                title="Put both clouds in one height: a cloud in elevation is shown with the shared camera\u2019s height 0 at its ground level (the median of its class-2 surface under the other cloud\u2019s footprint), a normalised cloud as it is. A constant per pane, so the terrain\u2019s relief across the plot is what remains. Off: world z on both sides, so a real vertical offset between two epochs shows.">
                <input type="checkbox" checked={compare.alignHeights}
                  onChange={(e) => setCompareFlag({ alignHeights: e.target.checked })} />
                align heights
                {compare.alignHeights && (compareBases.source !== 0 || compareBases.target !== 0) && (
                  <span style={{ color: 'var(--text-mute)' }}>
                    · height 0 at z {compareBases.source !== 0 ? `${compareBases.source.toFixed(1)} m (source)` : ''}
                    {compareBases.source !== 0 && compareBases.target !== 0 ? ', ' : ''}
                    {compareBases.target !== 0 ? `${compareBases.target.toFixed(1)} m (target)` : ''}
                  </span>
                )}
              </label>
              <label className="mono text-[10px] flex items-center gap-1.5 px-0.5" style={{ color: 'var(--text-dim)' }}
                title="Draw the source\u2019s plot-level skeleton (its cached skeletons.bin) over the target pane.">
                <input type="checkbox" checked={compare.showSkeleton} disabled={!!compareBusy}
                  onChange={(e) => void setCompareSkeleton(e.target.checked)} />
                skeleton over the target
              </label>
              {compare.showSkeleton && (
                <div className="flex items-center gap-1.5">
                  <span className="mono text-[10px] w-[60px]" style={{ color: 'var(--text-dim)' }}>skeleton</span>
                  {(['tree', 'class', 'radius'] as SkeletonColorMode[]).map((m) => (
                    <button
                      key={m}
                      className="btn !h-6 mono text-[10px] flex-1 justify-center"
                      style={compare.skeletonColor === m ? { background: 'color-mix(in oklch, var(--accent) 18%, transparent)', color: 'var(--accent)' } : undefined}
                      onClick={() => setCompareFlag({ skeletonColor: m })}
                      title={m === 'tree' ? 'Skeleton dots in the tree\u2019s own colour.'
                        : m === 'class' ? 'Stem in one colour, branches in another.'
                        : 'The QSM cylinder radius, dark blue thin to yellow thick.'}
                    >{m === 'tree' ? 'tree id' : m}</button>
                  ))}
                </div>
              )}
              <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
                Saved views <span style={{ color: 'var(--text-mute)' }}>· {COMPARE_VIEWS_FILE} beside the target</span>
              </div>
              <div className="flex gap-1.5">
                <select
                  value={selectedView}
                  onChange={(e) => setSelectedView(e.target.value)}
                  disabled={views.length === 0}
                  className="mono text-[11px] rounded-md px-1.5 py-1 flex-1 min-w-0"
                  style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
                >
                  {views.length === 0 && <option value="">no saved views yet</option>}
                  {views.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                </select>
                <button className="btn !h-7 mono text-[11px]" disabled={!selectedView || !compareApi} onClick={loadView}
                  title="Move both panes to the saved camera, exactly.">Load</button>
                <button className="btn !h-7 mono text-[11px]" disabled={!selectedView || !!compareBusy} onClick={() => void deleteView()}
                  title="Remove the selected view from the file.">Delete</button>
              </div>
              <div className="flex gap-1.5">
                <input
                  type="text" value={viewName} onChange={(e) => setViewName(e.target.value)}
                  placeholder={`View ${views.length + 1}`}
                  className="mono text-[11px] rounded-md px-1.5 py-1 flex-1 min-w-0"
                  style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
                />
                <button className="btn !h-7 mono text-[11px]" disabled={!compareApi || !!compareBusy} onClick={() => void saveView()}
                  title="Save the current camera under this name. Load restores it exactly — days apart, for the same view before and after a repair.">Save view</button>
              </div>
              <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
                Export figures <span style={{ color: 'var(--text-mute)' }}>· both panes, one camera, one size, white, no UI, full detail</span>
              </div>
              <div className="flex items-center gap-1.5">
                <input type="number" value={exportW} min={64} max={8192} step={1} onChange={(e) => setExportW(Number(e.target.value))}
                  className="mono text-[11px] rounded-md px-1.5 py-1 w-[72px]" title="Width of each pane, pixels"
                  style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }} />
                <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>×</span>
                <input type="number" value={exportH} min={64} max={8192} step={1} onChange={(e) => setExportH(Number(e.target.value))}
                  className="mono text-[11px] rounded-md px-1.5 py-1 w-[72px]" title="Height of each pane, pixels"
                  style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }} />
                <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>px each</span>
                <label className="mono text-[10px] flex items-center gap-1.5 ml-auto" style={{ color: 'var(--text-dim)' }}
                  title="Also write the two panes in one image with a fixed white gutter between them. No labels or captions — the paper adds those.">
                  <input type="checkbox" checked={sideBySide} onChange={(e) => setSideBySide(e.target.checked)} />
                  side-by-side too
                </label>
              </div>
              <button
                className="btn !h-7 mono text-[11px] justify-center"
                disabled={!compareApi || !!compareBusy || !desktop?.writeFileBytes}
                onClick={() => void exportFigures()}
                title="Pick a folder. Writes compare_<time>_source.png, _target.png, optionally _side-by-side.png, and a .json with the camera, colour mode, datasets, point counts and app version."
              >
                {compareBusy === 'export' ? 'Rendering…' : 'Export figures…'}
              </button>
              {compareNote && (
                <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>{compareNote}</div>
              )}
            </>
          )}
        </div>
      </Section>

      <div className="mono text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
        Honkanen et al. (2026), ISPRS Open Journal of Photogrammetry and Remote Sensing 21:100147, doi:10.1016/j.ophoto.2026.100147 — same epoch propagation as the MATLAB reference (<a href="https://github.com/honkaepp/tree-skeleton-transfer" target="_blank" rel="noreferrer" style={{ color: 'var(--text-dim)', textDecoration: 'underline' }}>repo</a>) but cached + visualised in PointCloudLabeler.
      </div>
    </div>
  );
}

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
      <div className="flex items-baseline gap-2">
        <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>{title}</span>
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{sub}</span>
      </div>
      {children}
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height: 3, background: 'var(--wash-3)' }}>
      <div style={{ width: `${(pct * 100).toFixed(1)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.15s' }} />
    </div>
  );
}

function SliderRow({
  label, unit, value, min, max, step, setValue, disabled,
}: {
  label: string; unit: string; value: number;
  min: number; max: number; step: number;
  setValue: (n: number) => void; disabled: boolean;
}) {
  // The number is typable, not just draggable. A slider cannot express
  // "exactly 8" reliably at any width, and a parameter that has to
  // match a published constant is exactly the case where the value
  // matters more than the gesture. It is a separate draft string
  // rather than a number formatted back into the field, because a
  // field that reformats on every keystroke cannot be cleared and
  // retyped — you delete a digit and it snaps back.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (raw: string) => {
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n)) {
      setValue(Math.min(max, Math.max(min, Math.round(n / step) * step)));
    }
    setDraft(null);
  };
  return (
    <div className="flex items-center gap-1.5">
      <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>{label}</label>
      <input
        type="range" min={min} max={max} step={step}
        value={value}
        onChange={(e) => setValue(parseInt(e.target.value, 10))}
        className="flex-1" disabled={disabled}
      />
      <input
        type="text" inputMode="decimal"
        className="mono text-[10px] rounded px-1 py-0.5 w-[54px] text-right"
        style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
        value={draft ?? String(value)}
        disabled={disabled}
        title={`${min}…${max}${unit ? ' ' + unit : ''}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit((e.target as HTMLInputElement).value); }
          if (e.key === 'Escape') { setDraft(null); }
        }}
      />
      <span className="mono text-[9.5px] w-[22px]" style={{ color: 'var(--text-mute)' }}>{unit}</span>
    </div>
  );
}
