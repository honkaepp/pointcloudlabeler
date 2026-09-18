// Layers panel — the scene's object list plus the dataset switcher.
//
// Scene objects: the point cloud (visibility toggle) and any raster
// surfaces (DTM / DSM / CHM) computed in the Terrain panel, each with a
// show/hide eye and a remove control. This is where multiple objects
// (and, later, multiple clouds) are managed.
//
// Datasets: the saved octrees under the project — import a new cloud or
// switch to another.

import { useEffect, useMemo, useState } from 'react';
import { useOctreeShell, type SecondaryCloud } from './OctreeShellContext';
import type { OctreeListEntry, RasterLayer, CrsListEntry, OctreeCrs, NadGridStatus, VerticalCrs, GeoidStatus } from '../../persistence/octreeReader';
import { formatBytes } from '../../utils/format';
import { confirmDialog } from '../../ui/dialogs';
import { describePayload, type AnalysisLayer } from '../../layers/analysisLayers';

interface Desktop {
  browseForFolder?: (title?: string) => Promise<string | null>;
  octreeMergeClouds?: (args: {
    srcADir: string; srcBDir: string; outDir: string;
    name: string; scannerType: string;
  }) => Promise<{ outDir: string; pointCount: number; tileCount: number; durationMs: number }>;
  octreeFilterOutliers?: (args: {
    srcDir: string; outDir: string; name: string; scannerType: string;
    method: 'sor' | 'radius';
    k?: number; stdMult?: number; radius?: number; minNeighbours?: number;
  }) => Promise<{ outDir: string; pointCountIn: number; pointCountOut: number; durationMs: number }>;
  octreeVoxelDownsample?: (args: {
    srcDir: string; outDir: string; name: string; scannerType: string;
    voxelSize: number;
  }) => Promise<{ outDir: string; pointCountIn: number; pointCountOut: number; durationMs: number }>;
  onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void> | (() => void);
  crsList?: () => Promise<CrsListEntry[]>;
  octreeSetCrs?: (octreeDir: string, crsJson: string) => Promise<void>;
  // Vertical datum — see commands/octree.rs's "Vertical datum" section
  // and HeightRow below. Same bookkeeping-only contract as octreeSetCrs:
  // records what Z already is, never converts it.
  octreeSetVerticalCrs?: (octreeDir: string, verticalJson: string) => Promise<void>;
  // NTv2 datum-shift grids — see src-tauri/src/commands/nadgrid.rs and
  // GeodeticDataRow below. nadgrid_status never throws; nadgrid_set_dir
  // rejects (a string) a path that isn't a directory.
  nadgridStatus?: () => Promise<NadGridStatus>;
  nadgridSetDir?: (dir: string) => Promise<NadGridStatus>;
  // Geoid grids (.gtx) — nadgrid.rs's sibling for the vertical axis,
  // sharing its folder. geoid_status never throws.
  geoidStatus?: () => Promise<GeoidStatus>;
}

interface Props {
  list: OctreeListEntry[];
  currentDir: string | null;
  onOpen: (entry: OctreeListEntry) => void;
  onImport: () => void;
  /** Delete a dataset from the project (closes the viewer first if it's
   *  the active cloud, drops it from any overlays, then removes the
   *  on-disk directory). The host owns the actual rm; the panel just
   *  surfaces the confirm + the click. */
  onRemoveDataset: (entry: OctreeListEntry) => void | Promise<void>;
}

const KIND_SWATCH: Record<RasterLayer['kind'], string> = {
  chm: 'linear-gradient(90deg,#2a4632,#5a9640,#d2c846,#dc7828,#c83228)',
  dtm: 'linear-gradient(90deg,#3c3228,#a59670,#dcd7c8)',
  dsm: 'linear-gradient(90deg,#3c3228,#a59670,#dcd7c8)',
  // Slope: shallow → steep on a sequential ramp (perceptually flat
  // for low values, hot toward 60°+).
  slope: 'linear-gradient(90deg,#2c2e3c,#3c6f8c,#76b07a,#e0c878,#dc7050)',
  // Aspect: cyclic ramp so 0° and 360° (both north) read the same.
  aspect: 'conic-gradient(from 0deg,#dc4e6e,#dcc44a,#5ad2a0,#5a9cf0,#a064e0,#dc4e6e)',
  // TPI: diverging blue (valley) → grey (mid-slope/flat) → red (ridge).
  tpi: 'linear-gradient(90deg,#4060c0,#a0b8e0,#dcdcdc,#e0a070,#c83228)',
  // Filled DEM looks just like the DTM (same earth ramp).
  filled: 'linear-gradient(90deg,#3c3228,#a59670,#dcd7c8)',
  // Flow accumulation: dark → bright blue on a log-style ramp.
  flow_accum: 'linear-gradient(90deg,#1a2030,#2a4070,#4080c0,#60c0e0,#dcf0ff)',
  // TWI: dry (warm) → wet (cool). Cyan-greens = high wetness.
  twi: 'linear-gradient(90deg,#c84040,#e0a060,#dcdca0,#80c0a0,#4080c0)',
  // Streams: simple binary (background → bright cyan).
  streams: 'linear-gradient(90deg,#202028,#40a0e0)',
  // Plan curvature: diverging — concave (channel) blue, convex
  // (ridge) red, planar grey.
  plan_curv: 'linear-gradient(90deg,#4060c0,#a0b8e0,#dcdcdc,#e0a070,#c83228)',
  // Profile curvature: same diverging convention, channel-blue ↔
  // ridge-red across zero.
  profile_curv: 'linear-gradient(90deg,#4060c0,#a0b8e0,#dcdcdc,#e0a070,#c83228)',
  // TRI: smooth → rough, single-hue sequential.
  tri: 'linear-gradient(90deg,#2c2e3c,#4a608c,#7c98c8,#bcd0e8,#f0f0f8)',
  // HLI: cool exposures (north-facing) → hot exposures (SW-facing).
  hli: 'linear-gradient(90deg,#3060c0,#80a0e0,#dcdcdc,#e0b070,#c83228)',
  // Forestry density-metric ramps. Mean / percentile rasters reuse
  // the CHM green→yellow→red height ramp so units (m above ground)
  // read the same across the inventory dashboard. SD / CV use a
  // muted sequential. Skewness uses the same diverging blue↔grey↔red
  // as curvature. Density uses log-scaled cyan→white (same role as
  // flow accumulation). Canopy cover is bare → fully closed canopy.
  height_mean: 'linear-gradient(90deg,#2a4632,#5a9640,#d2c846,#dc7828,#c83228)',
  height_sd:   'linear-gradient(90deg,#2c2e3c,#4060a0,#80a0c8,#c0d0e0,#f0f0f0)',
  height_cv:   'linear-gradient(90deg,#2c2e3c,#4060a0,#80a0c8,#c0d0e0,#f0f0f0)',
  height_skew: 'linear-gradient(90deg,#4060c0,#a0b8e0,#dcdcdc,#e0a070,#c83228)',
  height_kurt: 'linear-gradient(90deg,#4060c0,#a0b8e0,#dcdcdc,#e0a070,#c83228)',
  height_p25:  'linear-gradient(90deg,#2a4632,#5a9640,#d2c846,#dc7828,#c83228)',
  height_p50:  'linear-gradient(90deg,#2a4632,#5a9640,#d2c846,#dc7828,#c83228)',
  height_p75:  'linear-gradient(90deg,#2a4632,#5a9640,#d2c846,#dc7828,#c83228)',
  height_p90:  'linear-gradient(90deg,#2a4632,#5a9640,#d2c846,#dc7828,#c83228)',
  height_p95:  'linear-gradient(90deg,#2a4632,#5a9640,#d2c846,#dc7828,#c83228)',
  density:     'linear-gradient(90deg,#1a2030,#2a4070,#4080c0,#60c0e0,#dcf0ff)',
  canopy_cover:'linear-gradient(90deg,#3c2618,#a06030,#d2c846,#5a9640,#2a4632)',
  // Hillshade: pure grayscale, cartographic standard.
  hillshade:       'linear-gradient(90deg,#101010,#404040,#808080,#c0c0c0,#f0f0f0)',
  hillshade_multi: 'linear-gradient(90deg,#101010,#404040,#808080,#c0c0c0,#f0f0f0)',
};

export default function LayersPanel({ list, currentDir, onOpen, onImport, onRemoveDataset }: Props) {
  const {
    octree,
    rasterLayers, setRasterLayers,
    cloudVisible, setCloudVisible,
    secondaryClouds, addSecondary, removeSecondary, toggleSecondary, updateSecondary,
    analysisLayers, setAnalysisLayerVisible, removeAnalysisLayer, saveAnalysisLayer, saveRasterLayer, canPersistLayers,
    refreshDatasets, reloadActiveOctree, overlayError, clearOverlayError,
  } = useOctreeShell();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  // What a layer action could not do, said where the row is.
  const [layerError, setLayerError] = useState<string | null>(null);
  const layerAction = (run: () => Promise<void>) => {
    setLayerError(null);
    void run().catch((e) => setLayerError(e instanceof Error ? e.message : String(e)));
  };

  const toggleRaster = (id: string) =>
    setRasterLayers(prev => prev.map(l => (l.id === id ? { ...l, visible: !l.visible } : l)));
  /** A raster saved with the dataset takes its file with it — after
   *  asking, because a file is not something to lose to a mis-click. */
  const removeRaster = (l: RasterLayer) => layerAction(async () => {
    if (l.savedAs) {
      if (!await confirmDialog(`Remove "${l.label}" and delete its saved layer file from the dataset?`)) return;
      await removeAnalysisLayer(l.savedAs, { deleteFile: true });
    }
    setRasterLayers(prev => prev.filter(r => r.id !== l.id));
  });
  /** Off the list — and, for a layer saved with the dataset, off the
   *  disk, after asking. Hiding is the eye; this is gone. A skeleton
   *  layer is the transfer panel's file and is only taken off the view. */
  const removeLayer = (l: AnalysisLayer) => layerAction(async () => {
    if (l.kind === 'skeleton') { await removeAnalysisLayer(l.id); return; }
    if (l.saved) {
      if (!await confirmDialog(`Remove "${l.label}" and delete its saved layer files from the dataset?`)) return;
      await removeAnalysisLayer(l.id, { deleteFile: true });
      return;
    }
    await removeAnalysisLayer(l.id);
  });

  // --- Coordinate system (records what the active dataset's points
  // ALREADY are — never reprojects anything; see the note rendered next
  // to the picker below). The curated table comes from crs_list so this
  // panel never hardcodes a second copy of it.
  const [crsOptions, setCrsOptions] = useState<CrsListEntry[]>([]);
  const [crsSelection, setCrsSelection] = useState<string>(''); // epsg as string, or 'other'
  const [crsOtherProj, setCrsOtherProj] = useState('');
  const [crsOtherLabel, setCrsOtherLabel] = useState('');
  const [crsApplying, setCrsApplying] = useState(false);
  const [crsError, setCrsError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop?.crsList) return;
    let cancelled = false;
    desktop.crsList().then(rows => { if (!cancelled) setCrsOptions(rows); }).catch(() => { /* picker just stays empty */ });
    return () => { cancelled = true; };
  }, [desktop]);

  // Re-sync the picker to whatever's actually recorded whenever the
  // active dataset changes (open a different cloud, or reload after
  // applying a CRS) — otherwise a stale selection from the previous
  // dataset would linger in the dropdown.
  useEffect(() => {
    const crs: OctreeCrs | undefined = octree?.meta.crs;
    setCrsError(null);
    if (crs && 'epsg' in crs) {
      setCrsSelection(String(crs.epsg));
    } else if (crs && 'proj' in crs) {
      setCrsSelection('other');
      setCrsOtherProj(crs.proj);
      setCrsOtherLabel(crs.label);
    } else {
      setCrsSelection('');
      setCrsOtherProj('');
      setCrsOtherLabel('');
    }
  }, [octree]);

  // A dataset the importer scaled to metres shows a proj4 string rather
  // than the EPSG code its file declared, which is confusing on its own
  // — this is the sentence that explains why, and it is also the only
  // place the conversion is visible after the import has finished.
  const crsConversion = useMemo(() => {
    const crs = octree?.meta.crs;
    if (!crs || !('proj' in crs) || crs.sourceEpsg === undefined) return null;
    const k = crs.sourceUnitToMetre;
    const unit = k === undefined ? 'its own unit'
      : Math.abs(k - 0.3048) < 1e-9 ? 'international feet'
      : Math.abs(k - 1200 / 3937) < 1e-9 ? 'US survey feet'
      : `units of ${k} m`;
    return `Imported from EPSG:${crs.sourceEpsg}, which is in ${unit}. `
      + `PointCloudLabeler measures in metres, so the points were scaled on the way in and this `
      + `dataset now holds that same projection in metres. Export to EPSG:${crs.sourceEpsg} `
      + `to get them back in the original coordinate system.`;
  }, [octree]);

  const applyCrs = async () => {
    if (!octree || !desktop?.octreeSetCrs) return;
    setCrsApplying(true); setCrsError(null);
    try {
      let crs: OctreeCrs;
      if (crsSelection === 'other') {
        const proj = crsOtherProj.trim();
        if (!proj) throw new Error('Enter a proj4 definition string first.');
        crs = { proj, label: crsOtherLabel.trim() || 'Custom (proj4)' };
        // Re-applying an unedited converted CRS must not quietly drop the
        // record of which coordinate system the file arrived in — that is
        // what an export back to the source relies on.
        const was = octree.meta.crs;
        if (was && 'proj' in was && was.sourceEpsg !== undefined && was.proj === proj) {
          crs = {
            ...crs,
            sourceEpsg: was.sourceEpsg,
            sourceUnitToMetre: was.sourceUnitToMetre,
            sourceVerticalUnitToMetre: was.sourceVerticalUnitToMetre,
          };
        }
      } else {
        const epsg = parseInt(crsSelection, 10);
        const found = crsOptions.find(o => o.epsg === epsg);
        if (!found) throw new Error('Pick a coordinate system first.');
        crs = { epsg, label: found.label };
      }
      await desktop.octreeSetCrs(octree.dir, JSON.stringify(crs));
      // metadata.json changed on disk out from under the already-open
      // viewer — same reload every other metadata-mutating panel
      // (Display, Ground, Segment) does after a native command like
      // this one edits it.
      await reloadActiveOctree?.();
    } catch (e) {
      setCrsError(e instanceof Error ? e.message : String(e));
    } finally {
      setCrsApplying(false);
    }
  };

  // --- Height / vertical datum (records what the active dataset's Z
  // values ALREADY are — never converts anything; see the note rendered
  // in HeightRow below, and commands/octree.rs's "Vertical datum"
  // section for why PointCloudLabeler refuses to guess this instead of defaulting
  // to ellipsoidal).
  const [vertDatum, setVertDatum] = useState<string>(''); // '' | 'ellipsoidal' | 'orthometric'
  const [vertLabel, setVertLabel] = useState('');
  const [vertGeoid, setVertGeoid] = useState('');
  const [vertEpsg, setVertEpsg] = useState('');
  const [vertApplying, setVertApplying] = useState(false);
  const [vertError, setVertError] = useState<string | null>(null);

  // Re-sync to whatever's actually recorded whenever the active dataset
  // changes — same reasoning as the CRS effect above.
  useEffect(() => {
    const vertical = octree?.meta.vertical;
    setVertError(null);
    setVertDatum(vertical?.datum ?? '');
    setVertLabel(vertical?.label ?? '');
    setVertGeoid(vertical?.geoid ?? '');
  }, [octree]);

  const applyVertical = async () => {
    if (!octree || !desktop?.octreeSetVerticalCrs) return;
    let datum: VerticalCrs['datum'];
    if (vertDatum === 'ellipsoidal') datum = 'ellipsoidal';
    else if (vertDatum === 'orthometric') datum = 'orthometric';
    else { setVertError('Pick ellipsoidal or orthometric first.'); return; }
    setVertApplying(true); setVertError(null);
    try {
      const vertical: VerticalCrs = { datum };
      if (vertLabel.trim()) vertical.label = vertLabel.trim();
      if (datum === 'orthometric' && vertGeoid.trim()) vertical.geoid = vertGeoid.trim();
      // The EPSG code is what an export can actually DECLARE. Without it
      // a converted file cannot say what its heights are measured from,
      // and a reader is left guessing the one thing PointCloudLabeler won't guess.
      const code = parseInt(vertEpsg.trim(), 10);
      if (Number.isFinite(code) && code > 0) vertical.epsg = code;
      await desktop.octreeSetVerticalCrs(octree.dir, JSON.stringify(vertical));
      // Same out-from-under-the-viewer reload applyCrs does above.
      await reloadActiveOctree?.();
    } catch (e) {
      setVertError(e instanceof Error ? e.message : String(e));
    } finally {
      setVertApplying(false);
    }
  };

  const clearVertical = async () => {
    if (!octree || !desktop?.octreeSetVerticalCrs) return;
    setVertApplying(true); setVertError(null);
    try {
      await desktop.octreeSetVerticalCrs(octree.dir, 'null');
      await reloadActiveOctree?.();
    } catch (e) {
      setVertError(e instanceof Error ? e.message : String(e));
    } finally {
      setVertApplying(false);
    }
  };

  const inScene = new Set(secondaryClouds.map(c => c.id));
  const byDir = new Map(list.map(e => [e.dir, e]));
  /** Promote an overlay to the primary (active, editable) cloud — routes
   *  through the host's open handler, which guards unsaved edits first. */
  const makeActive = (dir: string) => {
    const entry = byDir.get(dir);
    if (entry) onOpen(entry);
  };

  // --- Clean / downsample the active cloud -> new dataset --------------
  //
  // SOR (Statistical Outlier Removal) flags points whose mean k-NN
  // distance exceeds μ + std_mult·σ over the cloud — kills MLS noise
  // hairballs and stray returns without a manual lasso pass. Radius
  // outlier removal drops points with too few neighbours in a fixed
  // ball. Voxel downsample produces a thinned cloud at the chosen
  // voxel size for fast previews / batch passes.
  const [cleanMode, setCleanMode] = useState<'sor' | 'radius' | 'voxel'>('sor');
  const [cleanSorK, setCleanSorK] = useState(8);
  const [cleanSorStd, setCleanSorStd] = useState(1.0);
  const [cleanRadius, setCleanRadius] = useState(0.05);
  const [cleanMinN, setCleanMinN] = useState(3);
  const [cleanVoxel, setCleanVoxel] = useState(0.05);
  const [cleanName, setCleanName] = useState('');
  const [cleaning, setCleaning] = useState(false);
  const [cleanPct, setCleanPct] = useState(0);
  const [cleanResult, setCleanResult] = useState<string | null>(null);
  const [cleanError, setCleanError] = useState<string | null>(null);
  const canClean = !!octree && (
    (cleanMode === 'voxel' && !!desktop?.octreeVoxelDownsample) ||
    (cleanMode !== 'voxel' && !!desktop?.octreeFilterOutliers)
  );
  const runClean = async () => {
    if (!octree) return;
    const parent = octree.dir.replace(/[\\/][^\\/]+[\\/]?$/, '');
    const defaultName = cleanMode === 'voxel'
      ? `${octree.meta.name}_voxel${cleanVoxel.toFixed(2)}`
      : cleanMode === 'sor'
        ? `${octree.meta.name}_sor`
        : `${octree.meta.name}_radius`;
    const finalName = (cleanName.trim() || defaultName).replace(/[\\/:*?"<>|]+/g, '_');
    const outDir = `${parent}/${finalName}`;
    setCleaning(true); setCleanError(null); setCleanPct(0); setCleanResult(null);
    let unlisten: (() => void) | undefined;
    try {
      if (desktop?.onOctreeProgress) {
        unlisten = await Promise.resolve(desktop.onOctreeProgress((e) => {
          if (e.stage === 'clean' || e.stage === 'downsample' || e.stage === 'build' || e.stage === 'stitch') {
            setCleanPct(e.pct);
          }
        })) as (() => void);
      }
      let r: { pointCountIn: number; pointCountOut: number };
      if (cleanMode === 'voxel') {
        r = await desktop!.octreeVoxelDownsample!({
          srcDir: octree.dir, outDir, name: finalName, scannerType: octree.meta.scannerType,
          voxelSize: cleanVoxel,
        });
      } else {
        r = await desktop!.octreeFilterOutliers!({
          srcDir: octree.dir, outDir, name: finalName, scannerType: octree.meta.scannerType,
          method: cleanMode,
          k: cleanMode === 'sor' ? cleanSorK : undefined,
          stdMult: cleanMode === 'sor' ? cleanSorStd : undefined,
          radius: cleanMode === 'radius' ? cleanRadius : undefined,
          minNeighbours: cleanMode === 'radius' ? cleanMinN : undefined,
        });
      }
      const pct = r.pointCountIn > 0 ? (r.pointCountOut / r.pointCountIn) * 100 : 0;
      setCleanResult(`Kept ${r.pointCountOut.toLocaleString()} / ${r.pointCountIn.toLocaleString()} pts (${pct.toFixed(1)} %)`);
      setCleanName('');
      await refreshDatasets?.();
    } catch (e) {
      setCleanError(e instanceof Error ? e.message : String(e));
    } finally {
      unlisten?.();
      setCleaning(false);
    }
  };

  // --- Merge primary + overlay -> new dataset --------------------------
  //
  // Combines the active cloud with one of the overlay clouds (typically
  // MLS + ALS) into a single new octree, with a `source` extra column
  // distinguishing the origins. The merged dataset shows up in the
  // dataset list and can be opened like any other.
  const [merging, setMerging] = useState(false);
  const [mergePct, setMergePct] = useState(0);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<string>(''); // overlay dir
  const [mergeName, setMergeName] = useState('');
  const canMerge = !!desktop?.octreeMergeClouds && !!octree && secondaryClouds.length > 0;
  const runMerge = async () => {
    if (!desktop?.octreeMergeClouds || !octree) return;
    const overlayDir = mergeTarget || secondaryClouds[0]?.id;
    if (!overlayDir) return;
    const overlay = byDir.get(overlayDir);
    const defaultName = `${octree.meta.name}+${overlay?.name ?? 'overlay'}`;
    const finalName = (mergeName.trim() || defaultName).replace(/[\\/:*?"<>|]+/g, '_');
    // Write next to the primary under the project's octrees dir, same
    // pattern as the Subset tool — keeps related datasets together.
    const parent = octree.dir.replace(/[\\/][^\\/]+[\\/]?$/, '');
    const outDir = `${parent}/${finalName}`;
    setMerging(true); setMergeError(null); setMergePct(0);
    let unlisten: (() => void) | undefined;
    try {
      if (desktop.onOctreeProgress) {
        unlisten = await Promise.resolve(desktop.onOctreeProgress((e) => {
          if (e.stage === 'merge' || e.stage === 'build' || e.stage === 'stitch') setMergePct(e.pct);
        })) as (() => void);
      }
      await desktop.octreeMergeClouds({
        srcADir: octree.dir, srcBDir: overlayDir, outDir,
        name: finalName, scannerType: octree.meta.scannerType,
      });
      setMergeName('');
      await refreshDatasets?.();
    } catch (e) {
      setMergeError(e instanceof Error ? e.message : String(e));
    } finally {
      unlisten?.();
      setMerging(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" style={{ width: 272 }}>
      {/* Scene objects */}
      <div>
        <div className="chip mb-1.5">Scene</div>
        <div className="flex flex-col gap-1">
          {/* Primary (active, editable) cloud — the one every tool targets. */}
          {octree && (
            <>
              <Row
                swatch="conic-gradient(#7ee0a8,#5a9cf0,#e0b84a,#e0506b,#7ee0a8)"
                title={octree.meta.name}
                sub="active · editable"
                accent
                visible={cloudVisible}
                onToggle={() => setCloudVisible(!cloudVisible)}
              />
              <CrsRow
                currentLabel={octree.meta.crs?.label ?? null}
                converted={crsConversion}
                options={crsOptions}
                selection={crsSelection}
                onSelectionChange={setCrsSelection}
                otherProj={crsOtherProj}
                onOtherProjChange={setCrsOtherProj}
                otherLabel={crsOtherLabel}
                onOtherLabelChange={setCrsOtherLabel}
                applying={crsApplying}
                error={crsError}
                canApply={!!desktop?.octreeSetCrs}
                onApply={() => void applyCrs()}
              />
              <HeightRow
                current={octree.meta.vertical ?? null}
                datum={vertDatum}
                onDatumChange={setVertDatum}
                label={vertLabel}
                onLabelChange={setVertLabel}
                geoid={vertGeoid}
                epsg={vertEpsg}
                onEpsgChange={setVertEpsg}
                onGeoidChange={setVertGeoid}
                applying={vertApplying}
                error={vertError}
                canApply={!!desktop?.octreeSetVerticalCrs}
                onApply={() => void applyVertical()}
                onClear={() => void clearVertical()}
              />
              <GeodeticDataRow />
            </>
          )}
          {/* Overlay clouds — read-only siblings of the primary, each with
              its own tint / height colouring and a promote-to-active action. */}
          {secondaryClouds.map(c => (
            <OverlayRow
              key={c.id}
              cloud={c}
              onToggle={() => toggleSecondary(c.id)}
              onRemove={() => removeSecondary(c.id)}
              onColor={(color) => updateSecondary(c.id, { color })}
              onMode={(colorMode) => updateSecondary(c.id, { colorMode })}
              onSyncFilters={(syncFilters) => updateSecondary(c.id, { syncFilters })}
              onMakeActive={() => makeActive(c.id)}
            />
          ))}
          {rasterLayers.map(l => (
            <RasterRow
              key={l.id}
              layer={l}
              swatch={KIND_SWATCH[l.kind]}
              saved={!!l.savedAs}
              canSave={canPersistLayers && !!l.grid}
              onSave={() => layerAction(() => saveRasterLayer(l.id))}
              onToggle={() => toggleRaster(l.id)}
              onRemove={() => removeRaster(l)}
              onOpacity={(opacity) => setRasterLayers(prev => prev.map(r => r.id === l.id ? { ...r, opacity } : r))}
              onWireframe={(wireframe) => setRasterLayers(prev => prev.map(r => r.id === l.id ? { ...r, wireframe } : r))}
            />
          ))}
          {/* Analysis layers — what the tools drew: M3C2 change maps,
              centrelines, taper profiles, skeletons. One list, each with
              an eye, a Save that keeps it with the dataset, and a remove.
              A saved layer comes back here, hidden, on the next open. */}
          {analysisLayers.map(l => (
            <AnalysisRow
              key={l.id}
              layer={l}
              canSave={canPersistLayers}
              onToggle={() => layerAction(() => setAnalysisLayerVisible(l.id, !l.visible))}
              onSave={() => layerAction(() => saveAnalysisLayer(l.id))}
              onRemove={() => removeLayer(l)}
            />
          ))}
          {layerError && (
            <div className="mono text-[9.5px] px-2 py-1 rounded-sm" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>
              {layerError}
            </div>
          )}
          {rasterLayers.length === 0 && secondaryClouds.length === 0 && analysisLayers.length === 0 && (
            <div className="mono text-[9.5px] px-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              Compute DTM / DSM / CHM in the Terrain panel to add raster surfaces, run an analysis (M3C2, stem
              centrelines, stem taper, click-to-measure, skeletons) to add its layer here, or add another dataset to
              the scene below. Every layer can be hidden, saved with the dataset and removed from this list.
            </div>
          )}
        </div>

        {/* Clean / downsample the active cloud → new dataset. SOR
            (Statistical Outlier Removal) flags points whose mean k-NN
            distance is above μ + σ·multiplier (the PCL / CloudCompare
            / PDAL standard); radius drops isolated points; voxel
            downsamples to one representative per voxel. */}
        {octree && (
          <div
            className="mt-2 rounded-md p-2 flex flex-col gap-1.5"
            style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}
          >
            <div className="flex items-center gap-1.5">
              <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
                Clean / downsample → new dataset
              </div>
            </div>
            <div className="flex items-center gap-1">
              <ModeChip label="SOR"      active={cleanMode === 'sor'}    onClick={() => setCleanMode('sor')}    title="Statistical Outlier Removal — k-NN mean distance > μ + σ·multiplier (PCL default)" />
              <ModeChip label="Radius"   active={cleanMode === 'radius'} onClick={() => setCleanMode('radius')} title="Drop points with fewer than N neighbours within a fixed radius" />
              <ModeChip label="Voxel"    active={cleanMode === 'voxel'}  onClick={() => setCleanMode('voxel')}  title="One representative point per voxel — for fast previews + batch passes" />
            </div>
            {cleanMode === 'sor' && (
              <div className="grid grid-cols-[68px_1fr_56px] gap-1 items-center">
                <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>k</span>
                <input
                  type="range" min={4} max={32} step={1}
                  value={cleanSorK}
                  onChange={(e) => setCleanSorK(parseInt(e.target.value, 10))}
                  disabled={cleaning}
                />
                <span className="mono text-[10px] text-right" style={{ color: 'var(--text)' }}>{cleanSorK}</span>
                <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>σ × mult</span>
                <input
                  type="range" min={0.5} max={3.0} step={0.1}
                  value={cleanSorStd}
                  onChange={(e) => setCleanSorStd(parseFloat(e.target.value))}
                  disabled={cleaning}
                />
                <span className="mono text-[10px] text-right" style={{ color: 'var(--text)' }}>{cleanSorStd.toFixed(1)}</span>
              </div>
            )}
            {cleanMode === 'radius' && (
              <div className="grid grid-cols-[68px_1fr_56px] gap-1 items-center">
                <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>radius (m)</span>
                <input
                  type="range" min={0.005} max={0.5} step={0.005}
                  value={cleanRadius}
                  onChange={(e) => setCleanRadius(parseFloat(e.target.value))}
                  disabled={cleaning}
                />
                <span className="mono text-[10px] text-right" style={{ color: 'var(--text)' }}>{cleanRadius.toFixed(3)}</span>
                <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>min N</span>
                <input
                  type="range" min={1} max={16} step={1}
                  value={cleanMinN}
                  onChange={(e) => setCleanMinN(parseInt(e.target.value, 10))}
                  disabled={cleaning}
                />
                <span className="mono text-[10px] text-right" style={{ color: 'var(--text)' }}>{cleanMinN}</span>
              </div>
            )}
            {cleanMode === 'voxel' && (
              <div className="grid grid-cols-[68px_1fr_56px] gap-1 items-center">
                <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>voxel (m)</span>
                <input
                  type="range" min={0.005} max={1.0} step={0.005}
                  value={cleanVoxel}
                  onChange={(e) => setCleanVoxel(parseFloat(e.target.value))}
                  disabled={cleaning}
                />
                <span className="mono text-[10px] text-right" style={{ color: 'var(--text)' }}>{cleanVoxel.toFixed(3)}</span>
              </div>
            )}
            <input
              type="text"
              placeholder={cleanMode === 'voxel'
                ? `${octree.meta.name}_voxel${cleanVoxel.toFixed(2)}`
                : `${octree.meta.name}_${cleanMode}`}
              value={cleanName}
              onChange={(e) => setCleanName(e.target.value)}
              disabled={cleaning}
              className="bg-transparent mono text-[10.5px] px-1.5 py-0.5"
              style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
            />
            <button
              className="btn !h-7 mono text-[11px] justify-center"
              disabled={!canClean || cleaning}
              onClick={() => void runClean()}
              title="Build a new dataset filtered by the chosen method (original kept)"
            >
              {cleaning
                ? `${cleanMode === 'voxel' ? 'Downsampling' : 'Cleaning'}… ${(cleanPct * 100).toFixed(0)} %`
                : (cleanMode === 'voxel' ? 'Downsample → new dataset' : 'Clean → new dataset')}
            </button>
            {cleanResult && (
              <div className="mono text-[9.5px] px-1 py-0.5 rounded-sm" style={{ color: 'var(--accent)', background: 'var(--wash-2)' }}>
                {cleanResult}
              </div>
            )}
            {cleanError && (
              <div className="mono text-[9.5px] px-1 py-0.5 rounded-sm" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.08)' }}>
                {cleanError}
              </div>
            )}
          </div>
        )}

        {/* Merge primary + overlay → new dataset. Typical use: an
            MLS / TLS active cloud plus an ALS overlay for canopy-top
            elevations the ground-level scan missed. */}
        {canMerge && (
          <div
            className="mt-2 rounded-md p-2 flex flex-col gap-1.5"
            style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}
          >
            <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
              Merge primary + overlay → new dataset
            </div>
            {secondaryClouds.length > 1 && (
              <select
                className="bg-transparent mono text-[10.5px] px-1 py-0.5"
                style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
                value={mergeTarget || secondaryClouds[0].id}
                onChange={(e) => setMergeTarget(e.target.value)}
                disabled={merging}
              >
                {secondaryClouds.map(c => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
            )}
            <input
              type="text"
              placeholder={octree && secondaryClouds[0]
                ? `${octree.meta.name}+${secondaryClouds[0].label}`
                : 'merged-cloud-name'}
              value={mergeName}
              onChange={(e) => setMergeName(e.target.value)}
              disabled={merging}
              className="bg-transparent mono text-[10.5px] px-1.5 py-0.5"
              style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
            />
            <button
              className="btn !h-7 mono text-[11px] justify-center"
              disabled={merging}
              onClick={() => void runMerge()}
              title="Concatenate the active cloud + the chosen overlay into a new octree. A `source` extra column (0 = primary, 1 = overlay) lets the Display panel colour by origin."
            >
              {merging ? `Merging… ${(mergePct * 100).toFixed(0)} %` : 'Merge into new dataset'}
            </button>
            {mergeError && (
              <div className="mono text-[9.5px] px-1 py-0.5 rounded-sm" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.08)' }}>
                {mergeError}
              </div>
            )}
            <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
              Both clouds must share the same CRS. All extras except a fresh "source" column are dropped; base columns (tree_id / intensity / class / return / semantic) ride through from each origin.
            </div>
          </div>
        )}
      </div>

      {/* Datasets */}
      <div>
        <div className="chip mb-1.5">Datasets</div>
        <button className="btn !h-8 w-full justify-center gap-1.5 mono text-[11.5px] mb-1.5" onClick={onImport}>
          <PlusIcon /> Import LAS / LAZ
        </button>
        {overlayError && (
          <div
            className="mono text-[9.5px] px-1 py-0.5 rounded-sm mb-1 flex items-start gap-1"
            style={{ color: '#e0506b', background: 'rgba(224,80,107,0.08)' }}
          >
            <span className="flex-1">{overlayError}</span>
            <button onClick={clearOverlayError} className="shrink-0 opacity-60 hover:opacity-100">✕</button>
          </div>
        )}
        {list.length === 0 ? (
          <div className="mono text-[10.5px] text-center py-3" style={{ color: 'var(--text-mute)' }}>
            No datasets yet.<br />Import a cloud to begin.
          </div>
        ) : (
          <div className="flex flex-col gap-1 max-h-[240px] overflow-y-auto scroll-thin">
            {list.map(e => {
              const active = e.dir === currentDir;
              const overlayed = inScene.has(e.dir);
              return (
                <div
                  key={e.dir}
                  className="flex items-stretch gap-1 rounded-md transition-all"
                  style={{
                    border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 45%, transparent)' : 'var(--line)'}`,
                    background: active ? 'color-mix(in oklch, var(--accent) 10%, transparent)' : 'transparent',
                  }}
                >
                  <button
                    onClick={() => onOpen(e)}
                    disabled={active}
                    className="flex items-center gap-2.5 px-2.5 py-2 text-left flex-1 min-w-0"
                    title={active ? 'Currently open as the primary cloud' : 'Open as the primary editable cloud'}
                  >
                    <span className="rounded-sm shrink-0" style={{ width: 8, height: 8, background: active ? 'var(--accent)' : 'var(--text-mute)' }} />
                    <div className="min-w-0 flex-1">
                      <div className="mono text-[11.5px] truncate" style={{ color: active ? 'var(--text)' : 'var(--text-dim)' }}>{e.name}</div>
                      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
                        {formatPoints(e.pointCount)} pts · {e.scannerType} · {e.tileCount} tiles
                      </div>
                    </div>
                  </button>
                  {!active && (
                    overlayed ? (
                      <button
                        onClick={() => removeSecondary(e.dir)}
                        className="px-2 mono text-[10.5px] shrink-0"
                        style={{ color: 'var(--accent)', borderLeft: '1px solid var(--line)' }}
                        title="Remove from scene"
                      >✓ in scene</button>
                    ) : (
                      <button
                        onClick={() => void addSecondary(e.dir, e.name)}
                        className="px-2 mono text-[10.5px] shrink-0"
                        style={{ color: 'var(--text-dim)', borderLeft: '1px solid var(--line)' }}
                        title="Add to the current scene as a read-only overlay"
                      >+ scene</button>
                    )
                  )}
                  <button
                    onClick={() => void onRemoveDataset(e)}
                    className="px-2 mono text-[10.5px] shrink-0"
                    style={{ color: 'var(--text-mute)', borderLeft: '1px solid var(--line)' }}
                    title={`Delete this dataset from the project (removes ${e.name}'s octree directory)`}
                  >
                    <TrashIcon />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ModeChip({ label, active, onClick, title }: {
  label: string; active: boolean; onClick: () => void; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="mono text-[10px] px-2 py-0.5 rounded-sm"
      style={{
        color: active ? 'var(--accent)' : 'var(--text-dim)',
        background: active ? 'color-mix(in oklch, var(--accent) 14%, transparent)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function Row({ swatch, title, sub, visible, accent, onToggle, onRemove }: {
  swatch: string;
  title: string;
  sub: string;
  visible: boolean;
  accent?: boolean;
  onToggle: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1.5"
      style={{
        border: `1px solid ${accent ? 'color-mix(in oklch, var(--accent) 45%, transparent)' : 'var(--line)'}`,
        background: accent
          ? 'color-mix(in oklch, var(--accent) 9%, transparent)'
          : visible ? 'var(--wash-1)' : 'transparent',
      }}
    >
      <button onClick={onToggle} title={visible ? 'Hide' : 'Show'} className="shrink-0" style={{ color: visible ? 'var(--accent)' : 'var(--text-mute)' }}>
        {visible ? <EyeIcon /> : <EyeOffIcon />}
      </button>
      <span className="rounded-sm shrink-0" style={{ width: 16, height: 10, background: swatch, boxShadow: '0 0 0 1px rgba(255,255,255,0.12)', opacity: visible ? 1 : 0.4 }} />
      <div className="min-w-0 flex-1">
        <div className="mono text-[11px] truncate" style={{ color: visible ? 'var(--text)' : 'var(--text-dim)' }}>{title}</div>
        <div className="mono text-[9px]" style={{ color: accent ? 'var(--accent)' : 'var(--text-mute)' }}>{sub}</div>
      </div>
      {onRemove && (
        <button onClick={onRemove} title="Remove from scene" className="shrink-0 px-1 opacity-50 hover:opacity-100" style={{ color: 'var(--text-mute)' }}>✕</button>
      )}
    </div>
  );
}

/** Compact "Coordinate system" row for the active dataset: shows the
 *  recorded CRS (or "not set"), a picker to choose a new one from the
 *  curated table — or a raw proj4 string via "Other…" for anything the
 *  table doesn't carry — and an Apply button. This only ever writes a
 *  label into metadata.json (see LayersPanel's applyCrs / the
 *  octree_set_crs command); the note at the bottom exists specifically
 *  so picking a CRS here doesn't get mistaken for reprojecting the
 *  cloud — it emphatically does not. */
function CrsRow({
  currentLabel, converted, options, selection, onSelectionChange,
  otherProj, onOtherProjChange, otherLabel, onOtherLabelChange,
  applying, error, canApply, onApply,
}: {
  currentLabel: string | null;
  /** Set only when the importer scaled this dataset to metres — see
   *  LayersPanel's `crsConversion`. */
  converted: string | null;
  options: CrsListEntry[];
  selection: string;
  onSelectionChange: (v: string) => void;
  otherProj: string;
  onOtherProjChange: (v: string) => void;
  otherLabel: string;
  onOtherLabelChange: (v: string) => void;
  applying: boolean;
  error: string | null;
  canApply: boolean;
  onApply: () => void;
}) {
  const isOther = selection === 'other';
  const canSubmit = canApply && !applying && (isOther ? otherProj.trim().length > 0 : selection !== '');
  return (
    <div
      className="flex flex-col gap-1 rounded-md px-2 py-1.5"
      style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-dim)' }}>Coordinate system</span>
        <span
          className="mono text-[9.5px] truncate"
          style={{ color: currentLabel ? 'var(--accent)' : 'var(--text-mute)', maxWidth: 140 }}
          title={currentLabel ?? 'not set'}
        >
          {currentLabel ?? 'not set'}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <select
          className="bg-transparent mono text-[10px] px-1 py-0.5 flex-1 min-w-0"
          style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
          value={selection}
          onChange={(e) => onSelectionChange(e.target.value)}
          disabled={applying}
        >
          <option value="" disabled>Select…</option>
          {options.map(o => (
            <option key={o.epsg} value={String(o.epsg)}>{o.label} (EPSG:{o.epsg})</option>
          ))}
          <option value="other">Other (proj4 string)…</option>
        </select>
        <button
          className="btn !h-6 mono text-[10px] px-2 shrink-0"
          disabled={!canSubmit}
          onClick={onApply}
          title="Record this as the dataset's coordinate system — does not move any points"
        >
          {applying ? '…' : 'Apply'}
        </button>
      </div>
      {isOther && (
        <div className="flex flex-col gap-1">
          <input
            type="text"
            placeholder="+proj=... +ellps=... +units=m +no_defs"
            value={otherProj}
            onChange={(e) => onOtherProjChange(e.target.value)}
            disabled={applying}
            className="bg-transparent mono text-[10px] px-1.5 py-0.5"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
          />
          <input
            type="text"
            placeholder="Label (e.g. a local grid's name)"
            value={otherLabel}
            onChange={(e) => onOtherLabelChange(e.target.value)}
            disabled={applying}
            className="bg-transparent mono text-[10px] px-1.5 py-0.5"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
          />
        </div>
      )}
      {error && (
        <div className="mono text-[9.5px] px-1 py-0.5 rounded-sm" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.08)' }}>
          {error}
        </div>
      )}
      {converted && (
        <div className="mono text-[9px] px-1 py-0.5 rounded-sm" style={{ color: '#e0b84a', background: 'rgba(224,184,74,0.08)', lineHeight: 1.4 }}>
          {converted}
        </div>
      )}
      <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
        Records what the data already IS — it does not move any points. Setting it wrong makes every later conversion wrong.
      </div>
    </div>
  );
}

/** Compact "Height" row for the active dataset: shows the recorded
 *  vertical datum (or "not recorded"), a picker between ellipsoidal
 *  (what GNSS / a raw LiDAR delivery gives) and orthometric (what
 *  national height systems and forestry height/volume models use), an
 *  optional free-text label and — for orthometric — an optional geoid
 *  model name, an Apply button, and a way to clear back to unrecorded.
 *  Same visual idiom and the same bookkeeping-only contract as CrsRow
 *  above (see LayersPanel's applyVertical / the octree_set_vertical_crs
 *  command): this never converts a single Z value, only records what
 *  they already are — see commands/octree.rs's "Vertical datum" section
 *  for why PointCloudLabeler refuses to guess it instead. */
function HeightRow({
  current, datum, onDatumChange, label, onLabelChange, geoid, onGeoidChange, epsg, onEpsgChange,
  applying, error, canApply, onApply, onClear,
}: {
  current: VerticalCrs | null;
  datum: string;
  onDatumChange: (v: string) => void;
  label: string;
  onLabelChange: (v: string) => void;
  geoid: string;
  onGeoidChange: (v: string) => void;
  epsg: string;
  onEpsgChange: (v: string) => void;
  applying: boolean;
  error: string | null;
  canApply: boolean;
  onApply: () => void;
  onClear: () => void;
}) {
  const currentText = current
    ? (current.label ? `${current.datum} (${current.label})` : current.datum)
    : 'not recorded';
  const hasSelection = datum === 'ellipsoidal' || datum === 'orthometric';
  const canSubmit = canApply && !applying && hasSelection;
  return (
    <div
      className="flex flex-col gap-1 rounded-md px-2 py-1.5"
      style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-dim)' }}>Height</span>
        <div className="flex items-center gap-1 min-w-0">
          <span
            className="mono text-[9.5px] truncate"
            style={{ color: current ? 'var(--accent)' : 'var(--text-mute)', maxWidth: 130 }}
            title={currentText}
          >
            {currentText}
          </span>
          {current && (
            <button
              onClick={onClear}
              disabled={applying || !canApply}
              title="Clear the recorded vertical datum"
              className="shrink-0 px-0.5 opacity-50 hover:opacity-100"
              style={{ color: 'var(--text-mute)' }}
            >✕</button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <select
          className="bg-transparent mono text-[10px] px-1 py-0.5 flex-1 min-w-0"
          style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
          value={datum}
          onChange={(e) => onDatumChange(e.target.value)}
          disabled={applying}
        >
          <option value="" disabled>Select…</option>
          <option value="ellipsoidal">Ellipsoidal (GNSS)</option>
          <option value="orthometric">Orthometric (national height system)</option>
        </select>
        <button
          className="btn !h-6 mono text-[10px] px-2 shrink-0"
          disabled={!canSubmit}
          onClick={onApply}
          title="Record this as the dataset's vertical datum — does not change any Z value"
        >
          {applying ? '…' : 'Apply'}
        </button>
      </div>
      {hasSelection && (
        <div className="flex flex-col gap-1">
          <input
            type="text"
            placeholder="Label (e.g. N2000)"
            value={label}
            onChange={(e) => onLabelChange(e.target.value)}
            disabled={applying}
            className="bg-transparent mono text-[10px] px-1.5 py-0.5"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
          />
          {datum === 'orthometric' && (
            <input
              type="text"
              placeholder="Geoid model (e.g. egm96_15.gtx)"
              value={geoid}
              onChange={(e) => onGeoidChange(e.target.value)}
              disabled={applying}
              className="bg-transparent mono text-[10px] px-1.5 py-0.5"
              style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
            />
          )}
          <input
            type="text"
            placeholder="Vertical EPSG (e.g. 3900 = N2000)"
            value={epsg}
            onChange={(e) => onEpsgChange(e.target.value)}
            disabled={applying}
            className="bg-transparent mono text-[10px] px-1.5 py-0.5"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
          />
        </div>
      )}
      {error && (
        <div className="mono text-[9.5px] px-1 py-0.5 rounded-sm" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.08)' }}>
          {error}
        </div>
      )}
      <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
        LiDAR from GNSS normally arrives as ellipsoidal height; national maps and forestry models use orthometric, tens of metres apart. This only records which one the Z values already are — it never converts them. PointCloudLabeler will not convert heights until it's recorded, because guessing wrong applies the geoid correction twice and the result still looks like a plausible elevation.
      </div>
    </div>
  );
}

// localStorage / settings.json key for the configured geodetic data
// folder — shared by both grid kinds below (geodata.rs owns one folder
// setting for both; see its module doc for why). Must match nadgrid.rs's
// SETTINGS_KEY and settingsStore.ts's PERSISTED_KEYS exactly — the
// renderer is the only writer, the Rust side only reads it (once, at
// startup), so a spelling drift here means the folder silently never
// restores across a restart.
const GEODETIC_DIR_KEY = 'pointcloudlabeler-geodetic-data-dir';

const NO_GEODETIC_STATUS: NadGridStatus = {
  dir: null, dirExists: false, searched: [], files: [], restartRequired: false,
};
const NO_GEOID_STATUS: GeoidStatus = {
  dir: null, dirExists: false, searched: [], files: [],
};

/** One row of the merged file list below — an NTv2 datum-shift grid
 *  (`.gsb`) or a GTX geoid model (`.gtx`), normalised to a common shape
 *  so the two kinds render through one path (GeodeticFileRow) instead of
 *  two near-duplicate blocks. `kind` is the fact a user actually needs:
 *  a CRS that won't resolve needs a datum-shift grid, a height
 *  conversion needs a geoid model, and the two are not interchangeable
 *  no matter how similar the row looks. */
interface GeodeticFile {
  kind: 'shift' | 'geoid';
  file: string;
  dir: string;
  sizeBytes: number;
  checked: boolean;
  ok: boolean;
  error: string | null;
  /** One entry per grid table the file holds — an NTv2 file can carry a
   *  root grid plus nested sub-grids, a GTX file always exactly one.
   *  Empty when unchecked (too large to verify) or failed to parse. */
  grids: Array<{ label: string; detail: string }>;
}

/** "Geodetic data" row — every grid file the shared geodetic-data folder
 *  holds: NTv2 (`.gsb`) horizontal datum-shift grids AND (`.gtx`) geoid
 *  models. Sits directly under Coordinate system and Height because it
 *  answers the question those two rows raise: some CRS entries (NAD27,
 *  OSGB36, NTF, RD, the pre-EUREF national systems…) need a `.gsb` PointCloudLabeler
 *  cannot ship to resolve at all, and converting a recorded orthometric
 *  ↔ ellipsoidal height needs a `.gtx` — a different national data
 *  product, sometimes hundreds of MB either way. This just points PointCloudLabeler
 *  at a folder of them and reports what it found, tagging each entry by
 *  which kind it is so a user can tell whether they have the kind their
 *  problem needs. See src-tauri/src/commands/nadgrid.rs and geoid.rs's
 *  module docs for the mechanics (search order, why a huge file is
 *  listed but not parsed, why a stale NTv2 grid can outlive the folder
 *  it came from — geoid.rs has no such staleness; see its `status()` doc
 *  comment for why not).
 *
 *  Unlike CrsRow / HeightRow, this manages its own state instead of
 *  being lifted into LayersPanel: the grid folder isn't scoped to the
 *  active dataset at all, so there is nothing for the parent to
 *  coordinate. */
function GeodeticDataRow() {
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;
  const [status, setStatus] = useState<NadGridStatus>(NO_GEODETIC_STATUS);
  const [geoid, setGeoid] = useState<GeoidStatus>(NO_GEOID_STATUS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!desktop?.nadgridStatus && !desktop?.geoidStatus) return;
    let cancelled = false;
    // Both grid kinds live in the same folder (geodata.rs owns one
    // setting for both), so one poll covers both instead of a second
    // effect and a second loading flash.
    Promise.all([
      desktop.nadgridStatus ? desktop.nadgridStatus() : Promise.resolve(NO_GEODETIC_STATUS),
      desktop.geoidStatus ? desktop.geoidStatus() : Promise.resolve(NO_GEOID_STATUS),
    ])
      .then(([nad, gtx]) => { if (!cancelled) { setStatus(nad); setGeoid(gtx); } })
      .catch(() => { /* neither command throws; nothing to recover from */ });
    return () => { cancelled = true; };
  }, [desktop]);

  // Applies a new folder ('' clears it) through nadgrid_set_dir, mirrors
  // the CONFIRMED result into localStorage — the only path the Rust side
  // reads it back from, and only at next startup, so this is a
  // fire-and-forget write, never a round trip — and repaints from the
  // returned status so the panel never shows a folder it hasn't
  // actually verified.
  const applyDir = async (dir: string) => {
    if (!desktop?.nadgridSetDir) return;
    setBusy(true); setError(null);
    try {
      const s = await desktop.nadgridSetDir(dir);
      setStatus(s);
      if (s.dir) localStorage.setItem(GEODETIC_DIR_KEY, s.dir);
      else localStorage.removeItem(GEODETIC_DIR_KEY);
      // nadgrid_set_dir only reports the .gsb side of the folder it just
      // changed; re-poll geoid_status against that same folder so the
      // merged list below doesn't keep showing .gtx files from the
      // folder that was just replaced.
      if (desktop.geoidStatus) {
        try { setGeoid(await desktop.geoidStatus()); } catch { /* geoid_status never throws */ }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    if (!desktop?.nadgridSetDir) return;
    setError(null);
    let picked: string | null = null;
    try {
      // The folder picker is a Rust command, not the dialog plugin:
      // picking a folder there also GRANTS it, which is what lets the
      // grid files inside it be read afterwards (see fsgrant.rs). Its
      // own title, rather than reusing the project picker's.
      picked = await desktop.browseForFolder?.('Select geodetic data folder') ?? null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (picked) await applyDir(picked);
  };

  // Every folder actually searched beyond the one the user configured
  // here — picked up from PROJ_NADGRIDS / PROJ_DATA (see the module
  // doc's search_dirs). Identical for both grid kinds (geodata.rs owns
  // one search list for both), so nadgrid's status carries it for both.
  const extraSearched = status.dir ? status.searched.filter(d => d !== status.dir) : status.searched;

  // Merge both kinds into the one shape GeodeticFileRow renders, so the
  // ok / failed / unverified treatment is written once, not twice.
  const files: GeodeticFile[] = [
    ...status.files.map((f): GeodeticFile => ({
      kind: 'shift',
      file: f.file, dir: f.dir, sizeBytes: f.sizeBytes, checked: f.checked, ok: f.ok, error: f.error,
      grids: f.ok
        ? f.grids.map(g => ({
            label: `${g.root ? 'root' : 'sub'} · ${formatPoints(g.nodes)} nodes · ${g.rows}×${g.cols}`,
            detail: g.details,
          }))
        : [],
    })),
    ...geoid.files.map((f): GeodeticFile => ({
      kind: 'geoid',
      file: f.file, dir: f.dir, sizeBytes: f.sizeBytes, checked: f.checked, ok: f.ok, error: f.error,
      // GeoidGridFile's extent fields are set together or not at all
      // (geoid.rs's `inspect` populates all six from the same parsed
      // grid), so checking every one before using any keeps this a
      // type-safe read rather than an assumption.
      grids: f.ok && f.rows != null && f.cols != null && f.south != null && f.north != null && f.west != null && f.east != null
        ? [{
            label: `${f.rows}×${f.cols} · ${f.south.toFixed(1)}..${f.north.toFixed(1)}°N ${f.west.toFixed(1)}..${f.east.toFixed(1)}°E`,
            detail: `${f.rows}×${f.cols} nodes, covering ${f.south.toFixed(4)}..${f.north.toFixed(4)} N, ${f.west.toFixed(4)}..${f.east.toFixed(4)} E`,
          }]
        : [],
    })),
  ];
  const distinctFileDirs = new Set(files.map(f => f.dir));
  const showFileDir = distinctFileDirs.size > 1;

  const checkedFiles = files.filter(f => f.checked);
  const okCount = checkedFiles.filter(f => f.ok).length;
  const failedCount = checkedFiles.filter(f => !f.ok).length;
  const uncheckedCount = files.length - checkedFiles.length;
  // "found nothing" and "wasn't told where to look" are different
  // states; collapsing them reads as though a configured folder was
  // empty when in fact none was ever set.
  const summary = status.searched.length === 0
    ? 'no folder set'
    : files.length === 0
    ? 'no grid files found'
    : [
        `${okCount} grid${okCount === 1 ? '' : 's'}`,
        ...(failedCount > 0 ? [`${failedCount} failed`] : []),
        ...(uncheckedCount > 0 ? [`${uncheckedCount} unverified`] : []),
      ].join(' · ');

  return (
    <div
      className="flex flex-col gap-1 rounded-md px-2 py-1.5"
      style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-dim)' }}>Geodetic data</span>
        <div className="flex items-center gap-1 min-w-0">
          <span
            className="mono text-[9.5px] truncate"
            style={{
              color: !status.dir ? 'var(--text-mute)' : !status.dirExists ? '#e0b84a' : 'var(--accent)',
              maxWidth: 130,
            }}
            title={status.dir ?? 'not set'}
          >
            {status.dir ?? 'not set'}
          </span>
          {status.dir && (
            <button
              onClick={() => void applyDir('')}
              disabled={busy || !desktop?.nadgridSetDir}
              title="Clear the configured folder"
              className="shrink-0 px-0.5 opacity-50 hover:opacity-100"
              style={{ color: 'var(--text-mute)' }}
            >✕</button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button
          className="btn !h-6 mono text-[10px] px-2 shrink-0"
          disabled={busy || !desktop?.nadgridSetDir}
          onClick={() => void browse()}
          title="Pick a folder of .gsb NTv2 grid files"
        >
          {busy ? '…' : 'Browse…'}
        </button>
        <span className="mono text-[9.5px] truncate" style={{ color: 'var(--text-dim)' }}>{summary}</span>
      </div>

      {status.dir && !status.dirExists && (
        <div className="mono text-[9px] px-1 py-0.5 rounded-sm" style={{ color: '#e0b84a', background: 'rgba(224,184,74,0.10)' }}>
          Configured folder not found — moved, or a network drive disconnected.
          {extraSearched.length > 0 && ' Grids below may still be coming from PROJ_DATA / PROJ_NADGRIDS.'}
        </div>
      )}

      {extraSearched.length > 0 && (
        <div className="mono text-[9px] truncate" style={{ color: 'var(--text-mute)' }} title={extraSearched.join('\n')}>
          {status.dir ? 'Also searched (PROJ_DATA / PROJ_NADGRIDS): ' : 'No folder configured — using PROJ_DATA / PROJ_NADGRIDS: '}
          {extraSearched.join(', ')}
        </div>
      )}

      {status.restartRequired && (
        <div className="mono text-[9px] px-1 py-0.5 rounded-sm" style={{ color: '#e0b84a', background: 'rgba(224,184,74,0.10)' }}>
          A grid from a previous folder is still loaded in this session — restart PointCloudLabeler for the change to fully apply.
        </div>
      )}

      {files.length > 0 && (
        <details>
          <summary className="mono text-[9.5px] cursor-pointer" style={{ color: 'var(--text-dim)' }}>
            {files.length} file{files.length === 1 ? '' : 's'}
          </summary>
          <div className="flex flex-col gap-1 mt-1">
            {files.map(f => (
              <GeodeticFileRow key={`${f.kind}:${f.dir}/${f.file}`} f={f} showDir={showFileDir} />
            ))}
          </div>
        </details>
      )}

      {error && (
        <div className="mono text-[9.5px] px-1 py-0.5 rounded-sm" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.08)' }}>
          {error}
        </div>
      )}

      <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
        NTv2 grids (.gsb) give centimetre-accurate horizontal datum shifts for legacy systems (NAD27, OSGB36, NTF, RD, the pre-EUREF national systems). Geoid grids (.gtx) give the undulation used to convert ellipsoidal ↔ orthometric height (see Height above). PointCloudLabeler ships neither — both are national data products — so point this at an existing PROJ data folder or files downloaded from the national mapping agency.
      </div>
    </div>
  );
}

/** One row of the merged NTv2 / geoid file list — the checked / ok /
 *  unverified / failed treatment (mirrors MAX_VERIFY_BYTES in both
 *  nadgrid.rs and geoid.rs) is written once here instead of duplicated
 *  per kind; only the small kind tag says what the entry actually is. */
function GeodeticFileRow({ f, showDir }: { f: GeodeticFile; showDir: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 pb-1" style={{ borderBottom: '1px solid var(--line)' }}>
      <div className="flex items-center justify-between gap-1">
        <span className="flex items-center gap-1 min-w-0">
          <span
            className="mono text-[8.5px] uppercase shrink-0"
            style={{ color: 'var(--text-dim)', letterSpacing: '0.05em' }}
            title={f.kind === 'shift' ? 'NTv2 horizontal datum-shift grid' : 'Geoid undulation model'}
          >
            {f.kind}
          </span>
          <span
            className="mono text-[9.5px] truncate"
            style={{ color: !f.checked ? 'var(--text-mute)' : f.ok ? 'var(--text)' : '#e0b84a' }}
            title={f.file}
          >
            {f.file}
          </span>
        </span>
        <span className="mono text-[9px] shrink-0" style={{ color: 'var(--text-mute)' }}>{formatBytes(f.sizeBytes)}</span>
      </div>
      {showDir && (
        <div className="mono text-[9px] truncate" style={{ color: 'var(--text-mute)' }} title={f.dir}>{f.dir}</div>
      )}
      {!f.checked ? (
        <div className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>
          not verified — large file, loads on first use
        </div>
      ) : f.ok ? (
        f.grids.map((g, i) => (
          <div key={i} className="mono text-[9px] truncate" style={{ color: 'var(--text-mute)' }} title={g.detail}>
            {g.label}
          </div>
        ))
      ) : (
        <div className="mono text-[9px]" style={{ color: '#e0b84a' }}>{f.error}</div>
      )}
    </div>
  );
}

// Colour modes available for overlay clouds. Mirrors the primary's
// scalar/categorical menu where the field is already decoded from the
// overlay's octree.bin, so a switch repaints instantly.
const OVERLAY_COLOR_MODES: { value: SecondaryCloud['colorMode']; label: string; swatch: string }[] = [
  { value: 'flat', label: 'flat', swatch: '' /* per-overlay tint, drawn below */ },
  { value: 'height', label: 'height', swatch: 'linear-gradient(90deg,#440a54,#21908d,#fde725)' },
  { value: 'intensity', label: 'intensity', swatch: 'linear-gradient(90deg,#0c0833,#73158c,#dc4b78,#fbe85a)' },
  { value: 'classification', label: 'class', swatch: 'linear-gradient(90deg,#785a3c,#28c828,#dc5050,#5078dc)' },
  { value: 'tree_id', label: 'tree_id', swatch: 'conic-gradient(#e0506b,#e0b84a,#7ee0a8,#5a9cf0,#d05a9c,#e0506b)' },
];

/** An overlay cloud row: show/hide + tint colour + colour mode + filter
 *  sync + promote-to-active + remove. Overlays are read-only so this is
 *  the full set of controls that apply to them. */
function OverlayRow({ cloud, onToggle, onRemove, onColor, onMode, onSyncFilters, onMakeActive }: {
  cloud: SecondaryCloud;
  onToggle: () => void;
  onRemove: () => void;
  onColor: (color: string) => void;
  onMode: (mode: SecondaryCloud['colorMode']) => void;
  onSyncFilters: (sync: boolean) => void;
  onMakeActive: () => void;
}) {
  const { visible, color, colorMode, syncFilters, label } = cloud;
  // The colour swatch reflects the active mode: tint for flat, ramp/palette
  // for the scalar/categorical modes. Tint mode still doubles the swatch as
  // a colour picker so the user can tweak the overlay's accent.
  const activeSwatch = colorMode === 'flat'
    ? `linear-gradient(90deg,${color},${color})`
    : OVERLAY_COLOR_MODES.find(m => m.value === colorMode)?.swatch ?? `linear-gradient(90deg,${color},${color})`;
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md px-2 py-1.5"
      style={{ border: '1px solid var(--line)', background: visible ? 'var(--wash-1)' : 'transparent' }}
    >
      <div className="flex items-center gap-2">
        <button onClick={onToggle} title={visible ? 'Hide' : 'Show'} className="shrink-0" style={{ color: visible ? 'var(--accent)' : 'var(--text-mute)' }}>
          {visible ? <EyeIcon /> : <EyeOffIcon />}
        </button>
        {colorMode === 'flat' ? (
          <label className="shrink-0 relative cursor-pointer" title="Overlay tint" style={{ width: 16, height: 10 }}>
            <span className="rounded-sm block w-full h-full" style={{ background: activeSwatch, boxShadow: '0 0 0 1px rgba(255,255,255,0.12)', opacity: visible ? 1 : 0.4 }} />
            <input
              type="color"
              value={color}
              onChange={(e) => onColor(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer"
              style={{ width: '100%', height: '100%' }}
            />
          </label>
        ) : (
          <span
            className="rounded-sm shrink-0"
            style={{ width: 16, height: 10, background: activeSwatch, boxShadow: '0 0 0 1px rgba(255,255,255,0.12)', opacity: visible ? 1 : 0.4 }}
            title="Colour driven by the overlay's own data — switch to flat to pick a tint"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="mono text-[11px] truncate" style={{ color: visible ? 'var(--text)' : 'var(--text-dim)' }}>{label}</div>
          <div className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>overlay · read-only</div>
        </div>
        <button onClick={onRemove} title="Remove from scene" className="shrink-0 px-1 opacity-50 hover:opacity-100" style={{ color: 'var(--text-mute)' }}>✕</button>
      </div>

      {/* Colour-mode picker — built-ins plus one chip per numeric extra the
          overlay carries (species / reflectance / …). Wraps so longer names
          stay legible at the panel's width. */}
      <div className="flex flex-wrap gap-1 pl-6">
        {[
          ...OVERLAY_COLOR_MODES.map(m => ({ value: m.value, label: m.label })),
          ...(cloud.octree.meta.extras ?? []).map(e => ({ value: `extra:${e.name}` as SecondaryCloud['colorMode'], label: e.name })),
        ].map(m => {
          const active = colorMode === m.value;
          return (
            <button
              key={m.value}
              onClick={() => onMode(m.value)}
              className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm"
              style={{
                background: active ? 'color-mix(in oklch, var(--accent) 22%, transparent)' : 'transparent',
                color: active ? 'var(--text)' : 'var(--text-mute)',
                border: '1px solid var(--line)',
              }}
              title={`Colour by ${m.label}`}
            >{m.label}</button>
          );
        })}
      </div>

      {/* Filter sync + promote-to-active sit on their own row so each
          control has enough room to read. */}
      <div className="flex items-center gap-1.5 pl-6">
        <button
          onClick={() => onSyncFilters(!syncFilters)}
          className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm flex items-center gap-1"
          style={{
            background: syncFilters ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : 'transparent',
            color: syncFilters ? 'var(--accent)' : 'var(--text-mute)',
            border: `1px solid ${syncFilters ? 'color-mix(in oklch, var(--accent) 45%, transparent)' : 'var(--line)'}`,
          }}
          title="Mirror the primary cloud's filters (hide unassigned / isolate / id range / hide classes) onto this overlay"
        >
          <SyncDot on={syncFilters} /> sync filters
        </button>
        <div className="flex-1" />
        <button
          onClick={onMakeActive}
          className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm"
          style={{ border: '1px solid color-mix(in oklch, var(--accent) 40%, transparent)', color: 'var(--accent)' }}
          title="Make this the active, editable cloud (tools will target it)"
        >→ active</button>
      </div>
    </div>
  );
}

function SyncDot({ on }: { on: boolean }) {
  return (
    <span
      className="rounded-full"
      style={{ width: 6, height: 6, background: on ? 'var(--accent)' : 'var(--text-mute)', display: 'inline-block' }}
    />
  );
}

/** A raster surface row (DTM / DSM / CHM): show/hide + an opacity slider
 *  and a wireframe toggle so the surface can be inspected over the cloud. */
function RasterRow({ layer, swatch, saved, canSave, onSave, onToggle, onRemove, onOpacity, onWireframe }: {
  layer: RasterLayer;
  swatch: string;
  saved: boolean;
  canSave: boolean;
  onSave: () => void;
  onToggle: () => void;
  onRemove: () => void;
  onOpacity: (v: number) => void;
  onWireframe: (v: boolean) => void;
}) {
  const { visible, label, grid } = layer;
  const opacity = layer.opacity ?? 1;
  const wire = !!layer.wireframe;
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md px-2 py-1.5"
      style={{ border: '1px solid var(--line)', background: visible ? 'var(--wash-1)' : 'transparent' }}
    >
      <div className="flex items-center gap-2">
        <button onClick={onToggle} title={visible ? 'Hide' : 'Show'} className="shrink-0" style={{ color: visible ? 'var(--accent)' : 'var(--text-mute)' }}>
          {visible ? <EyeIcon /> : <EyeOffIcon />}
        </button>
        <span className="rounded-sm shrink-0" style={{ width: 16, height: 10, background: swatch, boxShadow: '0 0 0 1px rgba(255,255,255,0.12)', opacity: visible ? 1 : 0.4 }} />
        <div className="min-w-0 flex-1">
          <div className="mono text-[11px] truncate" style={{ color: visible ? 'var(--text)' : 'var(--text-dim)' }}>{label}</div>
          <div className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>{grid ? `${grid.cols}×${grid.rows} raster` : 'loading…'}{saved ? ' · saved with the dataset' : ''}</div>
        </div>
        {canSave && !saved && (
          <button onClick={onSave} className="mono text-[9px] px-1.5 py-0.5 rounded-sm shrink-0" style={{ border: '1px solid var(--line)', color: 'var(--text-dim)' }}
            title="Keep this raster with the dataset (layers/) — it comes back, hidden, on the next open">save</button>
        )}
        <button onClick={onRemove} title={saved ? 'Remove, and delete its saved file' : 'Remove from scene'} className="shrink-0 px-1 opacity-50 hover:opacity-100" style={{ color: 'var(--text-mute)' }}>✕</button>
      </div>
      {visible && (
        <div className="flex items-center gap-2 pl-6">
          <span className="mono text-[9px]" style={{ color: 'var(--text-mute)', width: 30 }}>{Math.round(opacity * 100)}%</span>
          <input
            type="range" min={0.1} max={1} step={0.05} value={opacity}
            onChange={(e) => onOpacity(parseFloat(e.target.value))}
            className="flex-1" style={{ height: 14 }}
            title="Surface opacity"
          />
          <button
            onClick={() => onWireframe(!wire)}
            className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm shrink-0"
            style={{
              border: `1px solid ${wire ? 'color-mix(in oklch, var(--accent) 45%, transparent)' : 'var(--line)'}`,
              color: wire ? 'var(--accent)' : 'var(--text-mute)',
              background: wire ? 'color-mix(in oklch, var(--accent) 14%, transparent)' : 'transparent',
            }}
            title="Toggle wireframe"
          >wire</button>
        </div>
      )}
    </div>
  );
}

function formatPoints(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function PlusIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"><path d="M8 3v10M3 8h10"/></svg>;
}
function TrashIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 4h10"/><path d="M5 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M5 4l1 9a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l1-9"/></svg>;
}
/** The colour a kind of analysis layer is listed with. */
const LAYER_SWATCH: Record<AnalysisLayer['kind'], string> = {
  m3c2: 'linear-gradient(90deg, #5b8bd0, #9aa0a6, #d06b6b)',
  centerlines: '#e0b84a',
  skeleton: '#7ee0a8',
  raster: '#8c8c8c',
};

/** One analysis layer: eye, name, what it is and where it stands, Save
 *  while it is only in memory, remove. */
function AnalysisRow({ layer, canSave, onToggle, onSave, onRemove }: {
  layer: AnalysisLayer;
  canSave: boolean;
  onToggle: () => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  const { visible, label } = layer;
  const state = layer.kind === 'skeleton'
    ? 'kept by Tree Skeleton Transfer as skeletons.bin'
    : layer.saved ? 'saved with the dataset' : 'this session only — not saved';
  const desc = describePayload(layer);
  return (
    <div
      className="flex items-center gap-2 rounded-md px-2 py-1.5"
      style={{ border: '1px solid var(--line)', background: visible ? 'var(--wash-1)' : 'transparent' }}
    >
      <button onClick={onToggle} title={visible ? 'Hide' : layer.payload ? 'Show' : 'Show — reads it from the dataset'} className="shrink-0" style={{ color: visible ? 'var(--accent)' : 'var(--text-mute)' }}>
        {visible ? <EyeIcon /> : <EyeOffIcon />}
      </button>
      <span className="rounded-sm shrink-0" style={{ width: 16, height: 10, background: LAYER_SWATCH[layer.kind], boxShadow: '0 0 0 1px rgba(255,255,255,0.12)', opacity: visible ? 1 : 0.4 }} />
      <div className="min-w-0 flex-1">
        <div className="mono text-[11px] truncate" style={{ color: visible ? 'var(--text)' : 'var(--text-dim)' }}>{label}</div>
        <div className="mono text-[9px] truncate" style={{ color: 'var(--text-mute)' }} title={`${layer.source}${desc ? ` · ${desc}` : ''} · ${state}`}>
          {desc ? `${desc} · ` : ''}{state}
        </div>
      </div>
      {layer.savable && !layer.saved && layer.payload && (
        <button onClick={onSave} disabled={!canSave} className="mono text-[9px] px-1.5 py-0.5 rounded-sm shrink-0"
          style={{ border: '1px solid var(--line)', color: canSave ? 'var(--text-dim)' : 'var(--text-mute)' }}
          title={canSave ? 'Keep this layer with the dataset (layers/) — it comes back, hidden, on the next open' : 'This build cannot save layers'}>save</button>
      )}
      <button onClick={onRemove}
        title={layer.kind === 'skeleton' ? 'Take the skeletons off the view (skeletons.bin stays; the Tree Skeleton Transfer panel deletes it)' : layer.saved ? 'Remove, and delete its saved files' : 'Remove'}
        className="shrink-0 px-1 opacity-50 hover:opacity-100" style={{ color: 'var(--text-mute)' }}>✕</button>
    </div>
  );
}

function EyeIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="2.5"/></svg>;
}
function EyeOffIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3.3 4.2M6.7 6.7A18 18 0 0 0 2 12s3.5 7 10 7a10.9 10.9 0 0 0 3.4-.5"/></svg>;
}
