// EditorShell — the modern octree editing surface. Composes the top
// bar, left activity bar, full-bleed viewport (OctreeView), floating
// tool / display / history / datasets panels, a ⌘K command palette and
// the status bar around the streamed point cloud. Owns the shell state
// (display / tools / panel visibility / selection / stats / action API)
// and exposes it through OctreeShellContext so every panel can read and
// drive the viewer without prop drilling.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { openOctree, type OpenOctree, type OctreeListEntry, type RasterLayer } from '../../persistence/octreeReader';
import type { SecondaryCloud } from './OctreeShellContext';
import { readHeightMode, writeHeightMode } from './heightMode';
import { parsePlotBoundary } from '../../utils/plotBoundary';
import { cancelStage, canCancel } from '../../ui/cancelStage';
import { deriveOverlays, newLayerId, upsertLayer, type AnalysisLayer, type LayerHeader } from '../../layers/analysisLayers';
import { canPersistLayers, deleteLayerFiles, listSavedLayers, loadLayerPayload, saveLayerFiles, type LayerBridge } from '../../layers/layerStore';

/** Bridge surface this shell needs directly (everything else routes
 *  through persistence/ or the individual panels' own Desktop types). */
interface Desktop extends LayerBridge {
  octreeReadPlot?: (octreeDir: string) => Promise<string>;
}

// A short, distinct palette for overlay tints — visually distinct from
// the primary cloud's height ramp. Cycled by overlay index.
const OVERLAY_PALETTE = ['#e0b84a', '#5ad4d4', '#dc7a4a', '#7e9cf0', '#d05a9c', '#9ad06a'];
/** How long the store may sit dirty before the background autosave
 *  flushes it (crash-loss backstop — see the autosave effect). */
const AUTOSAVE_AFTER_MS = 120_000;
import OctreeView from '../../three/OctreeView';
import CompareView from '../../three/CompareView';
import type { CompareApi, CompareRequest } from '../../three/comparePose';
import ColorLegend from './ColorLegend';
import {
  OctreeShellContext, DEFAULT_DISPLAY, DEFAULT_TOOLS, DEFAULT_FILTERS, ZERO_STATS, countActiveFilters,
  type DisplayConfig, type ToolsConfig, type FilterConfig, type ViewerStats, type OctreeShellApi,
  type PanelId, type OctreeShellState,
} from './OctreeShellContext';
import TopBar from './TopBar';
import ActivityBar from './ActivityBar';
import StatusBar from './StatusBar';
import FloatingPanel from './FloatingPanel';
import ToolsPanel from './ToolsPanel';
import DisplayPanel from './DisplayPanel';
import FiltersPanel from './FiltersPanel';
import TreeReviewPanel from './TreeReviewPanel';
import QcPanel from './QcPanel';
import RescanPanel from './RescanPanel';
import ValidationPanel from './ValidationPanel';
import BuckingPanel from './BuckingPanel';
import ThinningPanel from './ThinningPanel';
import DensityMetricsPanel from './DensityMetricsPanel';
import ReportPanel from './ReportPanel';
import CaliperPanel from './CaliperPanel';
import SlabPanel from './SlabPanel';
import ScanInspectionPanel from './ScanInspectionPanel';
import PlotBoundaryPanel from './PlotBoundaryPanel';
import TreeHandlePanel from './TreeHandlePanel';
import StemCenterlinePanel from './StemCenterlinePanel';
import SkeletonTransferPanel from './SkeletonTransferPanel';
import M3C2Panel from './M3C2Panel';
import StemTaperPanel from './StemTaperPanel';
import TreeGrowthPanel from './TreeGrowthPanel';
import CrossSensorPanel from './CrossSensorPanel';
import RegistrationPanel from './RegistrationPanel';
import SegmentPanel from './SegmentPanel';
import GroundPanel from './GroundPanel';
import PointQcPanel from './PointQcPanel';
import HistoryPanel from './HistoryPanel';
import LayersPanel from './LayersPanel';
import SubsetPanel from './SubsetPanel';
import CommandPalette, { type Command } from './CommandPalette';
import KeybindingsPanel from './KeybindingsPanel';
import LandingView from './LandingView';
import { isDatasetBusy, subscribeDatasetBusy, withDatasetBusy as withDatasetBusyImpl } from '../../state/datasetBusy';
import {
  useKeybindings, eventToChord, isRecording, formatChord, type KeyActionId,
} from '../../state/keybindings';

/** Format a chord for a command-palette hint; '' (unbound) → no hint. */
function formatChordOrEmpty(chord: string | undefined): string {
  return chord ? formatChord(chord) : '';
}

/** A live status message bubbled up from the host module (EditorModule).
 *  Drives the banner that sits just above the status bar so users can see
 *  what's happening during long imports, exports, classifies, etc. */
export interface ShellStatus {
  kind: 'ok' | 'err' | 'info' | 'warn';
  msg: string;
}

interface Props {
  /** The open dataset, or null when nothing is loaded (→ landing view). */
  octree: OpenOctree | null;
  projectName: string | null;
  octreeList: OctreeListEntry[];
  onImport: () => void;
  onOpenOctree: (entry: OctreeListEntry) => void;
  /** Delete a dataset directory from the project. The host closes the
   *  viewer if it's the active cloud, drops it from any overlays, then
   *  rm's the on-disk octree directory and refreshes the list. */
  onRemoveDataset: (entry: OctreeListEntry) => void | Promise<void>;
  onCloseOctree: () => void;
  /** Export the active octree. Receives the shell's live Filters-panel
   *  state so the export dialog can offer "apply current view filters"
   *  without a second, separate channel back up to the host. */
  onExportLas: (filters: FilterConfig) => void | Promise<void>;
  /** Bubble unsaved-edits state up so the parent can confirm on close. */
  onDirtyChange?: (dirty: boolean) => void;
  busy?: boolean;
  /** Latest live status / progress from the host (import / export /
   *  classify). Surfaced as a banner above the status bar — the new shell
   *  is the only place these messages now show, so wiring them through
   *  is required for the user to know what's happening. */
  status?: ShellStatus | null;
  progress?: number;
  operation?: string | null;
  /** Dismiss the current status banner (host should null its `status`). */
  onDismissStatus?: () => void;
  /** Re-scan the project's octrees so a newly created dataset (Subset
   *  tool) appears in the dataset list. */
  onDatasetsChanged?: () => void | Promise<void>;
  /** Re-open the active octree from disk after its on-disk format
   *  changed (normalize / remove-extra rewrites octree.bin). */
  onReloadActiveOctree?: () => void | Promise<void>;
}

export default function EditorShell({
  octree, projectName, octreeList, onImport, onOpenOctree, onRemoveDataset, onCloseOctree, onExportLas, onDirtyChange, busy,
  status, progress, operation, onDismissStatus, onDatasetsChanged, onReloadActiveOctree,
}: Props) {
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;
  // The height mode is the one Display choice that holds across
  // restarts — see heightMode.ts.
  const [display, setDisplayState] = useState<DisplayConfig>(() => ({ ...DEFAULT_DISPLAY, heightMode: readHeightMode() }));
  const [tools, setToolsState] = useState<ToolsConfig>(DEFAULT_TOOLS);
  const [filters, setFiltersState] = useState<FilterConfig>(DEFAULT_FILTERS);
  const [rasterLayers, setRasterLayers] = useState<RasterLayer[]>([]);
  const [cloudVisible, setCloudVisible] = useState(true);
  const [subsetPreview, setSubsetPreview] = useState<OctreeShellState['subsetPreview']>(null);
  // Caliper / pick-a-point world picker. The viewport reads this in
  // its click handler and, when set, routes the next mouse-up's
  // world XYZ here instead of running the normal tool action.
  const [worldPicker, setWorldPicker] = useState<OctreeShellState['worldPicker']>(null);
  const [plotBoundary, setPlotBoundary] = useState<OctreeShellState['plotBoundary']>(null);
  // THE ANALYSIS LAYERS — one list of everything a tool has drawn over
  // the cloud; the three overlays the viewport takes are derived from
  // it. See layers/analysisLayers.ts for why, and for the file format
  // a saved layer is kept in.
  const [analysisLayers, setAnalysisLayers] = useState<AnalysisLayer[]>([]);
  const analysisLayersRef = useRef(analysisLayers);
  analysisLayersRef.current = analysisLayers;
  const rasterLayersRef = useRef(rasterLayers);
  rasterLayersRef.current = rasterLayers;
  /** Headers of the layers saved with the open dataset — what a payload
   *  is read back with the first time a saved layer is shown. */
  const layerHeadersRef = useRef<Map<string, LayerHeader>>(new Map());
  const { m3c2Overlay, stemCenterlines, skeletonOverlay } = useMemo(() => deriveOverlays(analysisLayers), [analysisLayers]);
  // The Compare view, in place of the viewport while set — see
  // three/CompareView.tsx. Closed whenever the open dataset changes:
  // a pair the panel asked for is a pair of THAT session's clouds.
  const [compare, setCompare] = useState<CompareRequest | null>(null);
  const [compareApi, setCompareApi] = useState<CompareApi | null>(null);
  useEffect(() => { setCompare(null); }, [octree?.dir]);
  // Report hand-off summaries — each producing panel writes its own slot on
  // a successful run; the Report panel only reads. See OctreeShellContext's
  // "Report hand-off summaries" section for why these exist (stem taper /
  // growth / M3C2 are never persisted to disk, unlike the cached metrics).
  const [validationSummary, setValidationSummary] = useState<OctreeShellState['validationSummary']>(null);
  const [growthSummary, setGrowthSummary] = useState<OctreeShellState['growthSummary']>(null);
  const [m3c2Summary, setM3c2Summary] = useState<OctreeShellState['m3c2Summary']>(null);
  const [taperMeasurements, setTaperMeasurements] = useState<OctreeShellState['taperMeasurements']>(null);
  const [secondaryClouds, setSecondaryClouds] = useState<SecondaryCloud[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [visiblePanels, setVisiblePanels] = useState<Set<PanelId>>(() => new Set<PanelId>(['tools']));
  const [selectedCount, setSelectedCount] = useState(0);
  const [dirty, setDirtyState] = useState(false);
  const setDirty = useCallback((d: boolean) => { setDirtyState(d); onDirtyChange?.(d); }, [onDirtyChange]);
  const [stats, setStats] = useState<ViewerStats>(ZERO_STATS);
  // Save state, mirrored from OctreeView's onSave. Drives the Save button
  // (spinner while saving, last-saved time when clean, red error message
  // when a save failed) and the shell status banner so a failed save can
  // never silently hide again.
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [apiState, setApiState] = useState<OctreeShellApi | null>(null);
  // Wrap the viewer-provided save() with the visible state machine so
  // every call site (button, ⌘S, panel-driven side effects) lights up the
  // same indicator. Reset on dataset change. The unwrapped raw save is
  // never used outside this wrapper.
  const setApi = useCallback((next: OctreeShellApi | null) => {
    if (!next) { setApiState(null); return; }
    const raw = next.save;
    const wrappedSave = async (): Promise<void> => {
      setSaveStatus('saving');
      setSaveError(null);
      try {
        await raw();
        setLastSavedAt(Date.now());
        setSaveStatus('saved');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setSaveError(msg);
        setSaveStatus('error');
        // Re-throw so callers awaiting save() (e.g. export-before-save)
        // can abort the follow-up step instead of running with stale data.
        throw e;
      }
    };
    setApiState({ ...next, save: wrappedSave });
  }, []);
  // THE RENDER LOOP THIS BROKE.
  //
  // The viewer used to get `onExportLas={() => onExportLas(filters)}`: a
  // new function on every render of this shell. The viewer's export
  // callback depends on it, its API object depends on that, and it
  // reports a rebuilt API through onApiReady → setApi → setApiState →
  // this shell renders again → a new function → the viewer renders →
  // a rebuilt API → … Measured at 96 commits a second with the editor
  // idle and 195 a second while a build ran, from the moment a dataset
  // opened until it was closed. Every cycle allocated; a fraction stayed;
  // the renderer's heap reached its 4 GB limit in under an hour and the
  // process was killed for memory — three times, on two machines, each
  // blamed on the build that happened to be running.
  //
  // The handler is stable and reads the filters through a ref, so the
  // loop has nothing to spin on. A test measures the commit rate.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const exportWithLiveFilters = useCallback(() => onExportLas(filtersRef.current), [onExportLas]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Surfaced by LayersPanel; an overlay that failed to open must say so.
  const [overlayError, setOverlayError] = useState<string | null>(null);
  // The lock is held in desktopBridge, around the mutating commands
  // themselves, so no panel can forget to take it — see
  // src/state/datasetBusy.ts for why it lives there and not here.
  const datasetBusy = useSyncExternalStore(subscribeDatasetBusy, isDatasetBusy, isDatasetBusy);
  const withDatasetBusy = withDatasetBusyImpl;
  // Editing is blocked while a native command is rewriting the dataset.
  // Wrapping the api here rather than guarding each call site is what
  // makes it a guarantee: every path that mutates the patch store —
  // toolbar, keybindings, command palette, Tree Review — goes through
  // this object, so none of them can be forgotten. See
  // OctreeShellState.datasetBusy for what the edit would otherwise cost.
  const api = useMemo(() => {
    if (!apiState || !datasetBusy) return apiState;
    const blocked = () => 0;
    return {
      ...apiState,
      apply: () => {},
      applyToSelection: blocked,
      selectVisibleUnassigned: blocked,
      undo: () => {},
      redo: () => {},
      newTree: () => {},
      mergeTrees: () => Promise.resolve(),
      unmergeTree: () => Promise.resolve(),
      clearMerges: () => Promise.resolve(),
    } as typeof apiState;
  }, [apiState, datasetBusy]);
  const cursorRef = useRef<{ x: number; y: number; z: number } | null>(null);
  // Autosave is OPT-IN (default off, persisted): a background flush also
  // takes away "close without saving" as an escape hatch — some review
  // sessions are exploratory and MEANT to be discarded — so the user
  // decides in the History panel. Stored under 'tree-seg-autosave'
  // ('1'/'0'), mirrored to settings.json by the settings store so the
  // choice survives WebView2 profile resets.
  const [autosaveEnabled, setAutosaveEnabledState] = useState<boolean>(() => {
    try { return localStorage.getItem('tree-seg-autosave') === '1'; } catch { return false; }
  });
  const setAutosaveEnabled = useCallback((v: boolean) => {
    setAutosaveEnabledState(v);
    try { localStorage.setItem('tree-seg-autosave', v ? '1' : '0'); } catch { /* mirror only */ }
  }, []);

  const setDisplay = useCallback((patch: Partial<DisplayConfig>) => {
    if (patch.heightMode) writeHeightMode(patch.heightMode);
    setDisplayState(d => ({ ...d, ...patch }));
  }, []);
  const setTools = useCallback((patch: Partial<ToolsConfig>) => setToolsState(t => ({ ...t, ...patch })), []);
  const setFilters = useCallback((patch: Partial<FilterConfig>) => setFiltersState(f => ({ ...f, ...patch })), []);
  const togglePanel = useCallback((id: PanelId) => {
    setVisiblePanels(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const setActiveTreeId = useCallback((id: number) => setToolsState(t => ({ ...t, activeTreeId: id })), []);
  const setActiveDeadwoodId = useCallback((channel: 'standing' | 'laying', id: number) =>
    setToolsState(t => channel === 'standing' ? { ...t, activeStandingId: id } : { ...t, activeLayingId: id }), []);

  // Switching datasets drops any raster layers + overlays and un-hides
  // the primary cloud — they all belong to the previous octree's session.
  const octreeDir = octree?.dir ?? null;
  useEffect(() => {
    setRasterLayers([]);
    setSecondaryClouds([]);
    setCloudVisible(true);
    // Report hand-off summaries belong to the dataset that produced them —
    // a validation / growth / M3C2 / taper summary from the previous cloud
    // must never be reported for the new one.
    setValidationSummary(null);
    setGrowthSummary(null);
    setM3c2Summary(null);
    setTaperMeasurements(null);
    // Plot boundary is a property of the DATASET (plot.json next to it),
    // not of this UI session: reset first — a boundary from the previous
    // cloud must never leak onto the new one — then load whatever the new
    // dataset has saved. No saved boundary ⇒ stays null, exactly like a
    // dataset that has never had one defined.
    setPlotBoundary(null);
    // The analysis layers belong to the dataset too: the list empties,
    // and whatever the new dataset has saved under layers/ comes back
    // hidden — rasters into the raster list at once (their grids are
    // small), the rest as rows that read their data when first shown.
    setAnalysisLayers([]);
    layerHeadersRef.current.clear();
    let cancelled = false;
    if (octreeDir && desktop?.octreeReadPlot) {
      void desktop.octreeReadPlot(octreeDir).then((raw) => {
        if (!cancelled) setPlotBoundary(parsePlotBoundary(raw));
      }).catch(() => { /* unreadable → stays null, panels fall back to bbox */ });
    }
    if (octreeDir && canPersistLayers(desktop)) {
      const d = desktop;
      void listSavedLayers(d, octreeDir).then(async ({ layers, headers }) => {
        if (cancelled) return;
        for (const [id, h] of headers) layerHeadersRef.current.set(id, h);
        const rasters: RasterLayer[] = [];
        const others: AnalysisLayer[] = [];
        for (const l of layers) {
          if (l.kind !== 'raster') { others.push(l); continue; }
          try {
            const payload = await loadLayerPayload(d, octreeDir, headers.get(l.id)!);
            if (payload.kind === 'raster') {
              rasters.push({
                id: `saved:${l.id}`, kind: payload.raster.rasterKind, label: payload.raster.label, visible: false,
                grid: payload.raster.grid, opacity: payload.raster.opacity, wireframe: payload.raster.wireframe, savedAs: l.id,
              });
            }
          } catch (e) {
            console.warn(`saved raster ${l.id} could not be read: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (cancelled) return;
        setAnalysisLayers(others);
        if (rasters.length > 0) setRasterLayers(prev => [...prev, ...rasters]);
      }).catch((e) => { console.warn('saved layers could not be listed', e); });
    }
    return () => { cancelled = true; };
  }, [octreeDir, desktop]);

  const addAnalysisLayer = useCallback<OctreeShellState['addAnalysisLayer']>((input) => {
    const id = input.id ?? newLayerId(input.kind);
    setAnalysisLayers(prev => {
      const old = prev.find(l => l.id === id);
      return upsertLayer(prev, {
        id, kind: input.kind, label: input.label, source: input.source,
        createdAt: old?.createdAt ?? new Date().toISOString(),
        visible: input.visible ?? true,
        // New content under an old id: what is on disk is no longer what
        // is shown, so the row offers Save again.
        saved: false,
        payload: input.payload,
        savable: input.savable ?? input.kind !== 'skeleton',
      });
    });
    return id;
  }, []);

  const setAnalysisLayerVisible = useCallback<OctreeShellState['setAnalysisLayerVisible']>(async (id, visible) => {
    const l = analysisLayersRef.current.find(x => x.id === id);
    if (!l) return;
    if (visible && !l.payload) {
      // A saved layer shown for the first time: read it now.
      const h = layerHeadersRef.current.get(id);
      if (!h || !octreeDir || !canPersistLayers(desktop)) throw new Error('this layer has no data in memory and cannot be read back');
      const payload = await loadLayerPayload(desktop, octreeDir, h);
      setAnalysisLayers(prev => prev.map(x => (x.id === id ? { ...x, payload, visible: true } : x)));
      return;
    }
    setAnalysisLayers(prev => prev.map(x => (x.id === id ? { ...x, visible } : x)));
  }, [octreeDir, desktop]);

  const saveAnalysisLayer = useCallback<OctreeShellState['saveAnalysisLayer']>(async (id) => {
    const l = analysisLayersRef.current.find(x => x.id === id);
    if (!l || !octreeDir) return;
    if (!canPersistLayers(desktop)) throw new Error('this build cannot save layers');
    const header = await saveLayerFiles(desktop, octreeDir, l);
    layerHeadersRef.current.set(id, header);
    setAnalysisLayers(prev => prev.map(x => (x.id === id ? { ...x, saved: true } : x)));
  }, [octreeDir, desktop]);

  const removeAnalysisLayer = useCallback<OctreeShellState['removeAnalysisLayer']>(async (id, opts) => {
    if (opts?.deleteFile && octreeDir && canPersistLayers(desktop) && layerHeadersRef.current.has(id)) {
      await deleteLayerFiles(desktop, octreeDir, id);
    }
    layerHeadersRef.current.delete(id);
    setAnalysisLayers(prev => prev.filter(x => x.id !== id));
  }, [octreeDir, desktop]);

  const saveRasterLayer = useCallback<OctreeShellState['saveRasterLayer']>(async (rasterId) => {
    const r = rasterLayersRef.current.find(x => x.id === rasterId);
    if (!r?.grid || !octreeDir) return;
    if (!canPersistLayers(desktop)) throw new Error('this build cannot save layers');
    const id = r.savedAs ?? newLayerId('raster');
    const header = await saveLayerFiles(desktop, octreeDir, {
      id, kind: 'raster', label: r.label, source: 'Terrain', createdAt: new Date().toISOString(),
      visible: r.visible, saved: false, savable: true,
      payload: { kind: 'raster', raster: { rasterKind: r.kind, label: r.label, grid: r.grid, opacity: r.opacity ?? 1, wireframe: !!r.wireframe } },
    });
    layerHeadersRef.current.set(id, header);
    setRasterLayers(prev => prev.map(x => (x.id === rasterId ? { ...x, savedAs: id } : x)));
  }, [octreeDir, desktop]);

  /** The Skeleton Transfer panel's overlay, as the one `skeleton` layer:
   *  listed, hidden and shown like the others, but never written by the
   *  Layers panel — its file is the panel's own skeletons.bin. */
  const setSkeletonOverlay = useCallback((o: OctreeShellState['skeletonOverlay']) => {
    if (!o) { setAnalysisLayers(prev => prev.filter(l => l.id !== 'skeleton')); return; }
    const from = o.sourceDir?.split(/[\\/]/).filter(Boolean).pop();
    setAnalysisLayers(prev => upsertLayer(prev, {
      id: 'skeleton', kind: 'skeleton',
      label: from ? `Skeletons · ${from}` : 'Skeletons',
      source: 'Tree Skeleton Transfer · kept as skeletons.bin',
      createdAt: prev.find(l => l.id === 'skeleton')?.createdAt ?? new Date().toISOString(),
      visible: true, saved: true, savable: false,
      payload: { kind: 'skeleton', overlay: o },
    }));
  }, []);

  const addSecondary = useCallback(async (dir: string, label: string) => {
    setOverlayError(null);
    if (dir === octreeDir) return; // already the primary cloud
    try {
      const loaded = await openOctree(dir);
      setSecondaryClouds(prev => {
        if (prev.some(c => c.id === dir)) return prev;
        return [...prev, {
          id: dir,
          label,
          visible: true,
          color: OVERLAY_PALETTE[prev.length % OVERLAY_PALETTE.length],
          colorMode: 'flat' as const,
          syncFilters: false,
          octree: loaded,
        }];
      });
    } catch (e) {
      // A console warning is invisible to the user: the row still reads
      // "+ scene" and nothing appears, so a dataset on a disconnected
      // drive or with a corrupt metadata.json is indistinguishable from a
      // mis-click. Surface it where the other shell errors go.
      setOverlayError(`Could not add "${label}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [octreeDir]);
  const removeSecondary = useCallback((id: string) =>
    setSecondaryClouds(prev => prev.filter(c => c.id !== id)),
  []);
  const toggleSecondary = useCallback((id: string) =>
    setSecondaryClouds(prev => prev.map(c => c.id === id ? { ...c, visible: !c.visible } : c)),
  []);
  const updateSecondary = useCallback((id: string, patch: Partial<Pick<SecondaryCloud, 'color' | 'colorMode' | 'syncFilters'>>) =>
    setSecondaryClouds(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c)),
  []);

  const ctxValue = useMemo<OctreeShellState>(() => ({
    visiblePanels, togglePanel,
    editMode, setEditMode,
    measuring, setMeasuring,
    display, setDisplay,
    tools, setTools,
    filters, setFilters,
    rasterLayers, setRasterLayers,
    cloudVisible, setCloudVisible,
    subsetPreview, setSubsetPreview,
    worldPicker, setWorldPicker,
    plotBoundary, setPlotBoundary,
    analysisLayers, addAnalysisLayer, setAnalysisLayerVisible, removeAnalysisLayer, saveAnalysisLayer, saveRasterLayer,
    canPersistLayers: canPersistLayers(desktop),
    stemCenterlines,
    skeletonOverlay, setSkeletonOverlay,
    m3c2Overlay,
    compare, setCompare, compareApi, setCompareApi,
    validationSummary, setValidationSummary,
    growthSummary, setGrowthSummary,
    m3c2Summary, setM3c2Summary,
    taperMeasurements, setTaperMeasurements,
    secondaryClouds, addSecondary, removeSecondary, toggleSecondary, updateSecondary,
    selectedCount, dirty, stats,
    saveStatus, lastSavedAt, saveError,
    autosaveEnabled, setAutosaveEnabled,
    octree, octreeList, api,
    paletteOpen, setPaletteOpen,
    datasetBusy, withDatasetBusy,
    overlayError, clearOverlayError: () => setOverlayError(null),
    refreshDatasets: onDatasetsChanged,
    reloadActiveOctree: onReloadActiveOctree,
  }), [visiblePanels, togglePanel, editMode, measuring, display, setDisplay, tools, setTools, filters, setFilters, rasterLayers, cloudVisible, subsetPreview, worldPicker, plotBoundary, analysisLayers, addAnalysisLayer, setAnalysisLayerVisible, removeAnalysisLayer, saveAnalysisLayer, saveRasterLayer, desktop, stemCenterlines, skeletonOverlay, setSkeletonOverlay, m3c2Overlay, compare, compareApi, validationSummary, growthSummary, m3c2Summary, taperMeasurements, secondaryClouds, addSecondary, removeSecondary, toggleSecondary, updateSecondary, selectedCount, dirty, stats, saveStatus, lastSavedAt, saveError, autosaveEnabled, setAutosaveEnabled, octree, octreeList, api, paletteOpen, datasetBusy, withDatasetBusy, overlayError, onDatasetsChanged, onReloadActiveOctree]);

  // Reset save indicators when the dataset changes — a "saved 4 min ago"
  // from the previous cloud shouldn't be claimed on the new one.
  useEffect(() => {
    setSaveStatus('idle');
    setLastSavedAt(null);
    setSaveError(null);
  }, [octreeDir]);

  // Browser-level beforeunload guard so a refresh / window close with
  // unsaved edits prompts the user instead of silently losing them. We
  // already block dataset switches; this covers the window itself.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Autosave — the OPT-IN crash-loss backstop (toggle lives in the
  // History panel; off by default). beforeunload covers a window close,
  // but a renderer crash / OOM / power cut fires no event and takes
  // every edit since the last manual save with it. When enabled and the
  // store has been dirty for AUTOSAVE_AFTER_MS, flush it in the
  // background through the same wrapped save every caller uses, so the
  // indicator flips "Saving… → Saved" and a failure lights the same red
  // error state. The timer re-arms after each save or new edit burst;
  // edits made DURING the flush keep the store dirty (version check in
  // onSave), which re-arms this effect — nothing is ever stranded
  // unsaved for more than one interval. Failures are surfaced by the
  // status machine; the catch only silences the duplicate rejection.
  useEffect(() => {
    if (!autosaveEnabled || !api || !dirty || saveStatus === 'saving') return;
    const t = window.setTimeout(() => {
      void api.save().catch(() => { /* shown via saveStatus/saveError */ });
    }, AUTOSAVE_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [autosaveEnabled, api, dirty, saveStatus]);

  // Customizable global keybindings. ONE window handler drives every
  // editor shortcut: it normalizes the pressed chord, looks up which
  // action owns it in the live binding map, and dispatches. (Previously
  // shortcuts were hardcoded here AND in OctreeView; they're now all
  // routed through this single registry so the Keybindings panel can
  // rebind any of them.)
  const bindings = useKeybindings();
  // Reverse map chord → action id, rebuilt when the bindings change.
  const chordToAction = useMemo(() => {
    const m = new Map<string, KeyActionId>();
    for (const id of Object.keys(bindings) as KeyActionId[]) {
      const c = bindings[id];
      if (c) m.set(c, id);
    }
    return m;
  }, [bindings]);

  // Dispatch one action by id. Context-aware where it matters (assign /
  // reset follow the active colour mode + the matching active id). Kept in
  // a ref so the single window listener always calls the latest closure
  // without re-subscribing on every state change.
  const runAction = useCallback((id: KeyActionId): void => {
    const mode = display.colorMode;
    switch (id) {
      case 'file.import': onImport(); break;
      case 'file.save': void api?.save(); break;
      case 'file.export': void api?.exportLas(); break;
      case 'edit.undo': api?.undo(); break;
      case 'edit.redo': api?.redo(); break;
      case 'edit.newTree': api?.newTree(); break;
      case 'edit.delete': api?.apply({ deleted: 1 }); break;
      case 'edit.restore': api?.apply({ deleted: 2 }); break;
      case 'edit.clearSelection': api?.clearSelection(); break;
      case 'edit.assign':
        if (mode === 'tree_id') api?.apply({ treeId: Math.max(0, Math.floor(tools.activeTreeId)) });
        else if (mode === 'standing_deadwood') api?.apply({ standingDeadwood: Math.max(0, Math.floor(tools.activeStandingId)) });
        else if (mode === 'laying_deadwood') api?.apply({ layingDeadwood: Math.max(0, Math.floor(tools.activeLayingId)) });
        else if (mode === 'semantic') api?.apply({ semantic: 1 });
        break;
      case 'edit.reset':
        if (mode === 'tree_id') api?.apply({ treeId: 0 });
        else if (mode === 'standing_deadwood') api?.apply({ standingDeadwood: 0 });
        else if (mode === 'laying_deadwood') api?.apply({ layingDeadwood: 0 });
        else if (mode === 'semantic') api?.apply({ semantic: 3 });
        break;
      case 'edit.semStem': api?.apply({ semantic: 1 }); break;
      case 'edit.semBranch': api?.apply({ semantic: 2 }); break;
      case 'edit.semUnlabel': api?.apply({ semantic: 3 }); break;
      case 'mode.toggle': setEditMode(m => !m); break;
      case 'mode.measure': setMeasuring(m => !m); break;
      case 'view.palette': setPaletteOpen(o => !o); break;
      case 'view.top': api?.presetView('top'); break;
      case 'view.front': api?.presetView('front'); break;
      case 'view.side': api?.presetView('side'); break;
      case 'view.edl': setDisplay({ edlEnabled: !display.edlEnabled }); break;
      case 'filter.hideUnassigned': setFilters({ hideUnassigned: !filters.hideUnassigned }); break;
      case 'filter.isolate':
        if (tools.activeTreeId > 0) {
          // A shortcut isolate has no neighbourhood box — clear any box a
          // Tree Review isolate left behind so it can't scope unassigned
          // (or force full-detail streaming) around the WRONG tree.
          setFilters({ isolateTreeId: filters.isolateTreeId === tools.activeTreeId ? null : tools.activeTreeId, isolateBox: null, isolateAnchor: null });
        }
        break;
      case 'colour.tree_id': setDisplay({ colorMode: 'tree_id' }); break;
      case 'colour.height': setDisplay({ colorMode: 'height' }); break;
      case 'colour.intensity': setDisplay({ colorMode: 'intensity' }); break;
      case 'colour.classification': setDisplay({ colorMode: 'classification' }); break;
      case 'colour.semantic': setDisplay({ colorMode: 'semantic' }); break;
      case 'colour.flat': setDisplay({ colorMode: 'flat' }); break;
    }
  }, [api, display.colorMode, display.edlEnabled, tools.activeTreeId, tools.activeStandingId, tools.activeLayingId, filters.hideUnassigned, filters.isolateTreeId, onImport, setDisplay, setFilters]);
  const runActionRef = useRef(runAction);
  runActionRef.current = runAction;
  const chordToActionRef = useRef(chordToAction);
  chordToActionRef.current = chordToAction;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The Keybindings panel is capturing a chord — let it have the key.
      if (isRecording()) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
      const id = chordToActionRef.current.get(eventToChord(e));
      if (!id) return;
      e.preventDefault();
      runActionRef.current(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Command palette contents — everything the panels can do, reachable
  // by keyboard. Rebuilt when the things they depend on change.
  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = [];
    const panel = (id: PanelId, title: string) =>
      cmds.push({ id: `panel.${id}`, group: 'Panels', title, run: () => togglePanel(id) });
    // Live shortcut hints from the binding map (reflect any customization).
    const hk = (id: KeyActionId) => formatChordOrEmpty(bindings[id]);
    cmds.push({ id: 'file.import', group: 'File', title: 'Import LAS / LAZ…', hint: hk('file.import'), run: onImport });
    cmds.push({ id: 'file.export', group: 'File', title: 'Export to LAS', hint: hk('file.export'), disabled: !api, run: () => api?.exportLas() });
    cmds.push({ id: 'file.save', group: 'File', title: 'Save edits', hint: hk('file.save'), disabled: !api, run: () => api?.save() });
    cmds.push({ id: 'edit.undo', group: 'Edit', title: 'Undo', hint: hk('edit.undo'), disabled: !api, run: () => api?.undo() });
    cmds.push({ id: 'edit.redo', group: 'Edit', title: 'Redo', hint: hk('edit.redo'), disabled: !api, run: () => api?.redo() });
    cmds.push({ id: 'edit.assign', group: 'Edit', title: 'Assign active id to selection', hint: hk('edit.assign'), disabled: !api, run: () => runAction('edit.assign') });
    cmds.push({ id: 'edit.reset', group: 'Edit', title: 'Reset selection to 0', hint: hk('edit.reset'), disabled: !api, run: () => runAction('edit.reset') });
    cmds.push({ id: 'edit.mode', group: 'Edit', title: editMode ? 'Switch to camera mode' : 'Switch to edit mode', hint: hk('mode.toggle'), run: () => setEditMode(m => !m) });
    cmds.push({ id: 'edit.measure', group: 'Edit', title: measuring ? 'Stop measuring' : 'Measure distance', hint: hk('mode.measure'), run: () => setMeasuring(m => !m) });
    cmds.push({ id: 'edit.deselect', group: 'Edit', title: 'Clear selection', hint: hk('edit.clearSelection'), disabled: !api, run: () => api?.clearSelection() });
    cmds.push({ id: 'edit.newtree', group: 'Edit', title: 'New tree id', hint: hk('edit.newTree'), disabled: !api, run: () => api?.newTree() });
    (['height', 'intensity', 'classification', 'tree_id', 'semantic', 'flat'] as const).forEach(m =>
      cmds.push({ id: `colour.${m}`, group: 'Colour', title: `Colour by ${m.replace('_', ' ')}`, hint: hk(`colour.${m}` as KeyActionId), keywords: 'display', run: () => setDisplay({ colorMode: m }) }));
    cmds.push({ id: 'view.top', group: 'View', title: 'Top view', hint: hk('view.top'), disabled: !api, run: () => api?.presetView('top') });
    cmds.push({ id: 'view.front', group: 'View', title: 'Front view', hint: hk('view.front'), disabled: !api, run: () => api?.presetView('front') });
    cmds.push({ id: 'view.side', group: 'View', title: 'Side view', hint: hk('view.side'), disabled: !api, run: () => api?.presetView('side') });
    cmds.push({ id: 'view.edl', group: 'View', title: `${display.edlEnabled ? 'Disable' : 'Enable'} Eye-Dome lighting`, run: () => setDisplay({ edlEnabled: !display.edlEnabled }) });
    panel('tools', 'Toggle Tools panel');
    panel('display', 'Toggle Display panel');
    panel('filters', 'Toggle Filters panel');
    panel('review', 'Toggle Tree review panel');
    panel('qc', 'Toggle QC (quality control) panel');
    panel('pointqc', 'Toggle Point QC panel');
    panel('rescan', 'Toggle Rescan advisor panel');
    panel('validation', 'Toggle Field validation panel');
    panel('bucking', 'Toggle Stem bucking panel');
    panel('thinning', 'Toggle Thinning simulator panel');
    panel('density', 'Toggle Density metrics panel');
    panel('report', 'Toggle Report panel');
    panel('caliper', 'Toggle Virtual caliper panel');
    panel('slab', 'Toggle Cross-section slab panel');
    panel('scaninspect', 'Toggle Scan inspection panel');
    panel('plotbound', 'Toggle Plot boundary panel');
    panel('treehandle', 'Toggle Click-to-measure-tree panel');
    panel('centerline', 'Toggle Stem centerlines panel');
    panel('tst', 'Toggle Tree Skeleton Transfer panel');
    panel('m3c2', 'Toggle M3C2 change detection panel');
    panel('taper', 'Toggle Stem taper panel');
    panel('growth', 'Toggle Tree growth panel');
    panel('crosssensor', 'Toggle ALS ↔ TLS join panel');
    panel('register', 'Toggle Cloud registration panel');
    panel('segment', 'Toggle Auto-segment panel');
    panel('ground', 'Toggle Terrain panel');
    panel('history', 'Toggle History panel');
    panel('layers', 'Toggle Layers panel');
    panel('subset', 'Toggle Subset / extract panel');
    panel('keys', 'Keyboard shortcuts…');
    const nFilters = countActiveFilters(filters);
    cmds.push({
      id: 'filters.clear', group: 'Filters',
      title: nFilters > 0 ? `Clear all filters (${nFilters} active)` : 'Clear all filters',
      disabled: nFilters === 0,
      run: () => setFilters({ hideUnassigned: false, isolateTreeId: null, isolateBox: null, isolateAnchor: null, isolateShowUnassigned: false, treeIdRange: null, hiddenClasses: [], hiddenSemantic: [], hiddenReturns: [], hideStandingDeadwood: false, hideLayingDeadwood: false, onlyDeadwood: false, xRange: null, yRange: null, zRange: null, intensityRange: null, extraRange: null }),
    });
    cmds.push({
      id: 'filters.unassigned', group: 'Filters',
      title: filters.hideUnassigned ? 'Show unassigned points' : 'Hide unassigned points',
      run: () => setFilters({ hideUnassigned: !filters.hideUnassigned }),
    });
    cmds.push({
      id: 'filters.isolate', group: 'Filters',
      title: filters.isolateTreeId === tools.activeTreeId
        ? 'Show all trees (stop isolating)'
        : `Isolate tree ${tools.activeTreeId}`,
      disabled: tools.activeTreeId <= 0,
      run: () => setFilters({
        isolateTreeId: filters.isolateTreeId === tools.activeTreeId ? null : tools.activeTreeId,
        isolateBox: null,
        isolateAnchor: null,
      }),
    });
    return cmds;
  }, [api, onImport, togglePanel, setDisplay, display.edlEnabled, editMode, measuring, filters, setFilters, tools.activeTreeId, bindings, runAction]);

  return (
    <OctreeShellContext.Provider value={ctxValue}>
      {/* Starts below the ModuleTabs strip (top-0, 52 px) so cross-module
          navigation stays visible above the shell. */}
      <div className="absolute left-0 right-0 bottom-0 flex flex-col" style={{ top: 52, zIndex: 40 }}>
        <TopBar projectName={projectName} onCloseOctree={onCloseOctree} busy={busy} />

        <div className="flex flex-1 min-h-0">
          <ActivityBar onOpenFile={onImport} disabled={false} />

          {/* Viewport area — OctreeView is full-bleed when a dataset is
              open; otherwise the landing view fills it. Panels float over
              the viewer and only mount while a dataset is loaded. */}
          <div className="relative flex-1 min-w-0">
            {octree && compare ? (
              <CompareView
                sourceDir={compare.sourceDir}
                targetDir={compare.targetDir}
                sourceName={octreeList.find((e) => e.dir === compare.sourceDir)?.name ?? compare.sourceDir}
                targetName={octreeList.find((e) => e.dir === compare.targetDir)?.name ?? compare.targetDir}
                colorMode={compare.colorMode}
                hideUnlabeled={compare.hideUnlabeled}
                alignHeights={compare.alignHeights}
                alignment={compare.alignment ?? null}
                skeleton={compare.showSkeleton ? skeletonOverlay : null}
                skeletonColor={compare.skeletonColor}
                display={display}
                onApiReady={setCompareApi}
                onClose={() => setCompare(null)}
              />
            ) : octree ? (
              <OctreeView
                octree={octree}
                display={display}
                tools={tools}
                filters={filters}
                subsetPreview={subsetPreview}
                worldPicker={worldPicker}
                stemCenterlines={stemCenterlines}
                skeletonOverlay={skeletonOverlay}
                m3c2Overlay={m3c2Overlay}
                rasterLayers={rasterLayers}
                cloudVisible={cloudVisible}
                secondaryClouds={secondaryClouds}
                editMode={editMode}
                measuring={measuring}
                onStats={setStats}
                onSelectedCount={setSelectedCount}
                onDirtyChange={setDirty}
                onApiReady={setApi}
                onActiveTreeId={setActiveTreeId}
                onActiveDeadwoodId={setActiveDeadwoodId}
                onExportLas={exportWithLiveFilters}
                cursorRef={cursorRef}
              />
            ) : (
              <LandingView list={octreeList} onImport={onImport} onOpen={onOpenOctree} />
            )}

            {/* Colour-scale legend — sibling of the canvas so it never
                interferes with orbit controls or the axis gizmo
                (bottom-right); z-indexed above the canvas but below any
                floating panel dragged over it. */}
            {octree && !compare && <ColorLegend />}

            {octree && (<>
              <FloatingPanel id="tools" title="Tools" initial={{ x: 16, y: 16 }} open={visiblePanels.has('tools')} onClose={() => togglePanel('tools')}>
                <ToolsPanel />
              </FloatingPanel>
              <FloatingPanel id="display" title="Display" initial={{ x: 16, y: 360 }} open={visiblePanels.has('display')} onClose={() => togglePanel('display')}>
                <DisplayPanel />
              </FloatingPanel>
              <FloatingPanel id="filters" title="Filters" initial={{ x: 16, y: 760 }} open={visiblePanels.has('filters')} onClose={() => togglePanel('filters')}>
                <FiltersPanel />
              </FloatingPanel>
              {/* 360, measured rather than guessed: at the 280 default the
                  count row ("257 / 257 trees" beside id·count·filter·map·
                  merge) and the review row ("reviewed 38 / 257 · 8 flagged"
                  beside all·todo·⚑·✓) both wrapped onto two lines, and
                  the species dropdown pushed its button out of the frame.
                  334 px of content is the narrowest that carries every
                  row on one line with a three-digit tree count. */}
              <FloatingPanel id="review" title="Tree review" width={360} initial={{ x: 300, y: 360 }} open={visiblePanels.has('review')} onClose={() => togglePanel('review')}>
                <TreeReviewPanel />
              </FloatingPanel>
              {/* 480, like the other prose-carrying panels. It had no
                  width at all, so it took the 280 default while its own
                  content declared minWidth 320 — the rows overflowed the
                  frame, and each of them carries a reason AND a
                  sentence-long hint. */}
              <FloatingPanel id="qc" title="QC — flags" width={480} initial={{ x: 620, y: 100 }} open={visiblePanels.has('qc')} onClose={() => togglePanel('qc')}>
                <QcPanel />
              </FloatingPanel>
              <FloatingPanel id="rescan" title="Rescan advisor" width={460} initial={{ x: 720, y: 120 }} open={visiblePanels.has('rescan')} onClose={() => togglePanel('rescan')}>
                <RescanPanel />
              </FloatingPanel>
              <FloatingPanel id="validation" title="Field validation" width={480} initial={{ x: 760, y: 140 }} open={visiblePanels.has('validation')} onClose={() => togglePanel('validation')}>
                <ValidationPanel />
              </FloatingPanel>
              <FloatingPanel id="bucking" title="Stem bucking" width={520} initial={{ x: 800, y: 160 }} open={visiblePanels.has('bucking')} onClose={() => togglePanel('bucking')}>
                <BuckingPanel />
              </FloatingPanel>
              <FloatingPanel id="thinning" title="Thinning simulator" width={500} initial={{ x: 840, y: 180 }} open={visiblePanels.has('thinning')} onClose={() => togglePanel('thinning')}>
                <ThinningPanel />
              </FloatingPanel>
              <FloatingPanel id="density" title="Density metrics" width={460} initial={{ x: 880, y: 200 }} open={visiblePanels.has('density')} onClose={() => togglePanel('density')}>
                <DensityMetricsPanel />
              </FloatingPanel>
              <FloatingPanel id="report" title="Report" width={460} initial={{ x: 920, y: 220 }} open={visiblePanels.has('report')} onClose={() => togglePanel('report')}>
                <ReportPanel />
              </FloatingPanel>
              <FloatingPanel id="caliper" title="Virtual caliper" width={380} initial={{ x: 960, y: 240 }} open={visiblePanels.has('caliper')} onClose={() => togglePanel('caliper')}>
                <CaliperPanel />
              </FloatingPanel>
              <FloatingPanel id="slab" title="Cross-section slab" width={400} initial={{ x: 1000, y: 260 }} open={visiblePanels.has('slab')} onClose={() => togglePanel('slab')}>
                <SlabPanel />
              </FloatingPanel>
              <FloatingPanel id="scaninspect" title="Scan inspection" width={500} initial={{ x: 1040, y: 280 }} open={visiblePanels.has('scaninspect')} onClose={() => togglePanel('scaninspect')}>
                <ScanInspectionPanel />
              </FloatingPanel>
              <FloatingPanel id="plotbound" title="Plot boundary" width={440} initial={{ x: 1080, y: 300 }} open={visiblePanels.has('plotbound')} onClose={() => togglePanel('plotbound')}>
                <PlotBoundaryPanel />
              </FloatingPanel>
              <FloatingPanel id="treehandle" title="Click-to-measure-tree" width={420} initial={{ x: 1120, y: 320 }} open={visiblePanels.has('treehandle')} onClose={() => togglePanel('treehandle')}>
                <TreeHandlePanel />
              </FloatingPanel>
              <FloatingPanel id="centerline" title="Stem centerlines" width={420} initial={{ x: 1160, y: 340 }} open={visiblePanels.has('centerline')} onClose={() => togglePanel('centerline')}>
                <StemCenterlinePanel />
              </FloatingPanel>
              <FloatingPanel id="tst" title="Tree Skeleton Transfer" width={460} initial={{ x: 1200, y: 360 }} open={visiblePanels.has('tst')} onClose={() => togglePanel('tst')}>
                <SkeletonTransferPanel />
              </FloatingPanel>
              <FloatingPanel id="m3c2" title="M3C2 change detection" width={452} initial={{ x: 1150, y: 320 }} open={visiblePanels.has('m3c2')} onClose={() => togglePanel('m3c2')}>
                <M3C2Panel />
              </FloatingPanel>
              <FloatingPanel id="taper" title="Stem taper" width={412} initial={{ x: 1120, y: 340 }} open={visiblePanels.has('taper')} onClose={() => togglePanel('taper')}>
                <StemTaperPanel />
              </FloatingPanel>
              <FloatingPanel id="growth" title="Tree growth" width={472} initial={{ x: 1090, y: 300 }} open={visiblePanels.has('growth')} onClose={() => togglePanel('growth')}>
                <TreeGrowthPanel />
              </FloatingPanel>
              <FloatingPanel id="crosssensor" title="ALS ↔ TLS join" width={492} initial={{ x: 1060, y: 280 }} open={visiblePanels.has('crosssensor')} onClose={() => togglePanel('crosssensor')}>
                <CrossSensorPanel />
              </FloatingPanel>
              <FloatingPanel id="register" title="Cloud registration" width={452} initial={{ x: 1030, y: 260 }} open={visiblePanels.has('register')} onClose={() => togglePanel('register')}>
                <RegistrationPanel />
              </FloatingPanel>
              <FloatingPanel id="segment" title="Auto-segment" width={300} initial={{ x: 600, y: 16 }} open={visiblePanels.has('segment')} onClose={() => togglePanel('segment')}>
                <SegmentPanel />
              </FloatingPanel>
              <FloatingPanel id="pointqc" title="Point QC" width={352} initial={{ x: 640, y: 140 }} open={visiblePanels.has('pointqc')} onClose={() => togglePanel('pointqc')}>
                <PointQcPanel />
              </FloatingPanel>
              <FloatingPanel id="ground" title="Terrain" width={272} initial={{ x: 580, y: 360 }} open={visiblePanels.has('ground')} onClose={() => togglePanel('ground')}>
                <GroundPanel />
              </FloatingPanel>
              <FloatingPanel id="history" title="History" initial={{ x: 300, y: 16 }} open={visiblePanels.has('history')} onClose={() => togglePanel('history')}>
                <HistoryPanel />
              </FloatingPanel>
              <FloatingPanel id="layers" title="Layers" width={296} initial={{ x: 16, y: 540 }} open={visiblePanels.has('layers')} onClose={() => togglePanel('layers')}>
                <LayersPanel list={octreeList} currentDir={octree.dir} onOpen={onOpenOctree} onImport={onImport} onRemoveDataset={onRemoveDataset} />
              </FloatingPanel>
              <FloatingPanel id="subset" title="Subset / extract" width={288} initial={{ x: 340, y: 96 }} open={visiblePanels.has('subset')} onClose={() => togglePanel('subset')}>
                <SubsetPanel />
              </FloatingPanel>
              <FloatingPanel id="keys" title="Keyboard shortcuts" width={314} initial={{ x: 360, y: 60 }} open={visiblePanels.has('keys')} onClose={() => togglePanel('keys')}>
                <KeybindingsPanel />
              </FloatingPanel>
            </>)}
          </div>
        </div>

        <StatusBanner
          status={status ?? null}
          progress={progress ?? 0}
          operation={operation ?? null}
          onDismiss={onDismissStatus}
        />
        <StatusBar cursorRef={cursorRef} />
      </div>

      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
    </OctreeShellContext.Provider>
  );
}

/** Banner above the status bar showing the latest import / export /
 *  classify status + a progress bar. Auto-hides for OK messages a few
 *  seconds after they appear so they don't clutter the viewport; errors
 *  and warnings stay until dismissed or replaced. Sized to never push
 *  the status bar down (absolute positioning above it). */
function StatusBanner({
  status, progress, operation, onDismiss,
}: {
  status: ShellStatus | null;
  progress: number;
  operation: string | null;
  onDismiss?: () => void;
}) {
  // Show whenever there's a status OR an active operation with progress.
  const inProgress = (operation != null && operation !== '') || progress > 0;
  const show = !!status || inProgress;
  if (!show) return null;

  // Colour palette per status kind. The bar itself uses the accent unless
  // an error is showing, in which case red so it's unmistakable.
  const kind = status?.kind ?? 'info';
  const fg =
    kind === 'err'  ? 'var(--danger, #e0506b)'
  : kind === 'warn' ? '#e0b84a'
  : kind === 'ok'   ? 'var(--accent)'
  :                   'var(--text)';
  const bg =
    kind === 'err'  ? 'rgba(224,80,107,0.10)'
  : kind === 'warn' ? 'rgba(224,184,74,0.10)'
  : kind === 'ok'   ? 'color-mix(in oklch, var(--accent) 10%, transparent)'
  :                   'var(--wash-2)';
  const border =
    kind === 'err'  ? 'color-mix(in oklch, var(--danger, #e0506b) 50%, transparent)'
  : kind === 'warn' ? 'rgba(224,184,74,0.55)'
  : kind === 'ok'   ? 'color-mix(in oklch, var(--accent) 50%, transparent)'
  :                   'var(--line-strong)';

  const pct = Math.max(0, Math.min(1, progress));
  const showBar = inProgress && pct >= 0 && pct < 1;

  return (
    <div
      className="hairline-t shrink-0"
      style={{
        background: bg,
        borderTop: `1px solid ${border}`,
        padding: '6px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        minHeight: 30,
        zIndex: 30,
      }}
    >
      {(kind === 'info' || kind === 'ok') && inProgress && (
        <span
          className="rounded-full"
          style={{
            width: 12, height: 12, flexShrink: 0,
            border: '2px solid color-mix(in oklch, var(--accent) 40%, transparent)',
            borderTopColor: 'var(--accent)',
            animation: 'spin 1.1s linear infinite',
          }}
        />
      )}
      <div className="flex flex-col flex-1 min-w-0 gap-1">
        <div className="flex items-center gap-2 min-w-0">
          {operation && (
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>
              {operation}
            </span>
          )}
          <span className="mono text-[11.5px] truncate" style={{ color: fg }}>
            {status?.msg ?? (operation ? `${operation}…` : '')}
          </span>
        </div>
        {showBar && (
          <div className="w-full rounded-full overflow-hidden" style={{ height: 3, background: 'var(--wash-3)' }}>
            <div style={{ width: `${(pct * 100).toFixed(1)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.15s' }} />
          </div>
        )}
      </div>
      {inProgress && operation === 'Exporting' && (
        <button
          onClick={() => cancelStage('export')}
          disabled={!canCancel()}
          className="btn !h-6 mono text-[10px] !px-2 shrink-0"
          title="Stop the export — the partial file is removed"
        >
          Cancel
        </button>
      )}
      {!inProgress && status && onDismiss && (
        <button
          onClick={onDismiss}
          className="mono text-[10px] px-1 opacity-60 hover:opacity-100"
          style={{ color: fg }}
          title="Dismiss"
        >
          ✕
        </button>
      )}
    </div>
  );
}
