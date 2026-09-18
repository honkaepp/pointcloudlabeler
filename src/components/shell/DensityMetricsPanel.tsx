// Forestry density metrics — lidR / FORTLS equivalent.
//
// Triggers `octree_density_metrics` on the active cloud (which streams
// the cloud + DTM, builds 12 grid rasters and a plot-wide summary),
// surfaces the result as a dashboard card and pushes the rasters into
// the scene's RasterLayer list so the user can colour the ground by
// any of them. Also computes Lorey's mean height + dominant height
// from the cached per-tree metrics when those exist, so the user
// gets the full classical forestry inventory headline.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { cancelStage, canCancel } from '../../ui/cancelStage';
import { useOctreeShell } from './OctreeShellContext';
import type { DensityMetricsResult, RasterLayer, RasterGrid, TreeMetric } from '../../persistence/octreeReader';
import { parseAsciiGrid } from '../../io/asciiGrid';
import { useProject } from '../../context/ProjectContext';
import { loadTreeMetrics } from '../../metrics/loadMetrics';
import { treeStats } from '../../metrics/plotStats';
import { csvBlob } from '../../io/csv';
import { saveCsvFile } from '../../io/saveDownload';

interface Desktop {
  octreeDensityMetrics?: (
    octreeDir: string, cellSize: number,
    opts: { minHeight?: number; canopyThreshold?: number; epsg?: number },
  ) => Promise<DensityMetricsResult>;
  octreeTreeMetrics?: (
    dir: string,
    params: { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number },
  ) => Promise<TreeMetric[]>;
  readFile?: (path: string) => Promise<Uint8Array>;
  onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void> | (() => void);
}

interface PerTreeStats {
  loreyMeanHeight: number; // basal-area weighted mean height
  dominantHeight: number;  // mean height of the N tallest trees
  topNCount: number;       // how many trees went into the dominant calc
  basalArea: number;       // Σ basal area (m²)
  treeCount: number;
}

/** Compute Lorey's mean height + dominant height from per-tree
 *  metrics. Dominant uses the top 100 stems/ha by height — but the
 *  plot area is unknown here, so we default to the top 10 % of stems
 *  (a reasonable proxy for plot-scale work). Returns null when the
 *  metric inputs aren't usable (no DBH / no height). */
function summarisePerTree(trees: TreeMetric[]): PerTreeStats | null {
  if (trees.length === 0) return null;
  // Shared with the report and the Plot Boundary panel — this used to be
  // a third independent copy, and it filtered to trees having BOTH a
  // diameter and a height before summing basal area. Basal area comes
  // from the diameter alone, so a tree with no ground beneath it
  // (height 0 = unmeasured, not short) disappeared from a plot total
  // labelled "Σ from DBH".
  const ts = treeStats(trees);
  if (ts.nWithDbh === 0 && ts.nWithHeight === 0) return null;
  return {
    loreyMeanHeight: ts.loreyMeanHeight,
    dominantHeight: ts.dominantHeight,
    topNCount: ts.topNCount,
    basalArea: ts.basalAreaTotal,
    treeCount: ts.treeCount,
  };
}

export default function DensityMetricsPanel() {
  const { octree, setRasterLayers } = useOctreeShell();
  const { project } = useProject();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  // Parameters.
  const [cellSize, setCellSize] = useState(2.0);
  const [minHeight, setMinHeight] = useState(0.2);
  const [canopyThreshold, setCanopyThreshold] = useState(2.0);

  // State.
  const [result, setResult] = useState<DensityMetricsResult | null>(null);
  const [computing, setComputing] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Pull existing per-tree metrics for Lorey + dominant height. We
  // never trigger the heavy per-tree pass from here — only read what
  // the Metrics module / other panels already computed.
  const [perTree, setPerTree] = useState<PerTreeStats | null>(null);
  const [perTreeLoading, setPerTreeLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!octree?.dir || !desktop?.octreeTreeMetrics) { setPerTree(null); return; }
      // This streams the whole cloud and rebuilds the DTM — seconds on a
      // real dataset — and it fires on every open of the panel, since the
      // floating-panel host unmounts children when closed. Without a
      // visible loading state the panel just sits there looking blank or
      // stale, which reads as broken rather than busy.
      setPerTreeLoading(true);
      try {
        const trees = await loadTreeMetrics(desktop, octree.dir);
        if (cancelled) return;
        setPerTree(summarisePerTree(trees));
      } catch {
        if (!cancelled) setPerTree(null);
      } finally {
        if (!cancelled) setPerTreeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [octree?.dir, desktop, project?.folder]);

  const run = useCallback(async () => {
    if (!desktop?.octreeDensityMetrics || !octree?.dir) return;
    setComputing(true); setError(null); setPct(0);
    let unlisten: (() => void) | undefined;
    try {
      if (desktop.onOctreeProgress) {
        unlisten = await Promise.resolve(desktop.onOctreeProgress((e) => {
          if (e.stage === 'density') setPct(e.pct);
        })) as (() => void);
      }
      const res = await desktop.octreeDensityMetrics(octree.dir, cellSize, {
        minHeight, canopyThreshold,
      });
      setResult(res);
      // Push the rasters into the scene's layer list. Hidden by
      // default — the user picks one or two of interest to colour
      // the ground with.
      if (desktop.readFile) {
        const read = desktop.readFile;
        const load = async (path: string, kind: RasterLayer['kind'], label: string): Promise<RasterLayer | null> => {
          try {
            const text = new TextDecoder().decode(await read(path));
            const grid: RasterGrid | null = parseAsciiGrid(text);
            return { id: `${kind}:density`, kind, label, visible: false, grid };
          } catch { return null; }
        };
        const loaded = (await Promise.all([
          load(res.meanPath,        'height_mean',  `Mean height (m, min ${res.minHeight} m)`),
          load(res.sdPath,          'height_sd',    `Height SD (m)`),
          load(res.cvPath,          'height_cv',    `Height CV (sd/mean)`),
          load(res.skewPath,        'height_skew',  `Height skewness`),
          load(res.kurtPath,        'height_kurt',  `Height kurtosis (excess)`),
          load(res.p25Path,         'height_p25',   `Height P25 (m)`),
          load(res.p50Path,         'height_p50',   `Height P50 (m, median)`),
          load(res.p75Path,         'height_p75',   `Height P75 (m)`),
          load(res.p90Path,         'height_p90',   `Height P90 (m)`),
          load(res.p95Path,         'height_p95',   `Height P95 (m)`),
          load(res.densityPath,     'density',      `Return density (pts/m²)`),
          load(res.canopyCoverPath, 'canopy_cover', `Canopy cover (frac ≥ ${res.canopyThreshold} m)`),
        ])).filter((l): l is RasterLayer => l !== null);
        // Replace any prior density layers with these fresh ones.
        setRasterLayers(prev => {
          const next = prev.filter(l => !l.id.endsWith(':density'));
          return [...next, ...loaded];
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      unlisten?.();
      setComputing(false);
    }
  }, [desktop, octree?.dir, cellSize, minHeight, canopyThreshold, setRasterLayers]);

  // CSV export of the plot summary + per-tree row.
  const exportCsv = useCallback(() => {
    if (!result) return;
    const rows: string[] = [
      'metric,value,unit',
      `cell_size,${result.cellSize.toFixed(3)},m`,
      `min_height,${result.minHeight.toFixed(3)},m`,
      `canopy_threshold,${result.canopyThreshold.toFixed(3)},m`,
      `plot_returns,${result.plotCount},count`,
      `plot_mean_height,${result.plotMean.toFixed(3)},m`,
      `plot_sd_height,${result.plotSd.toFixed(3)},m`,
      `plot_p25,${result.plotP25.toFixed(3)},m`,
      `plot_p50,${result.plotP50.toFixed(3)},m`,
      `plot_p75,${result.plotP75.toFixed(3)},m`,
      `plot_p90,${result.plotP90.toFixed(3)},m`,
      `plot_p95,${result.plotP95.toFixed(3)},m`,
      `plot_skewness,${result.plotSkew.toFixed(3)},`,
      `plot_excess_kurtosis,${result.plotKurt.toFixed(3)},`,
      `plot_canopy_cover,${(result.plotCanopyCover * 100).toFixed(2)},%`,
      `canopy_cover_basis,${result.canopyCoverBasis},`,
      `plot_density,${result.plotDensity.toFixed(1)},pts/m²`,
    ];
    if (perTree) {
      rows.push(
        `tree_count,${perTree.treeCount},`,
        `tree_basal_area_total,${perTree.basalArea.toFixed(3)},m²`,
        `lorey_mean_height,${perTree.loreyMeanHeight.toFixed(3)},m`,
        `dominant_height_top10pct,${perTree.dominantHeight.toFixed(3)},m`,
        `dominant_top_n,${perTree.topNCount},stems`,
      );
    }
    void saveCsvFile(rows, 'density_metrics.csv');
  }, [result, perTree]);

  const summary = useMemo(() => {
    if (!result) return null;
    return [
      { label: 'Returns', value: `${(result.plotCount / 1e6).toFixed(2)} M`, hint: `${result.plotDensity.toFixed(1)} pts/m²` },
      { label: 'Mean ± SD', value: `${result.plotMean.toFixed(2)} ± ${result.plotSd.toFixed(2)} m`, hint: 'above ground' },
      { label: 'Median (P50)', value: `${result.plotP50.toFixed(2)} m`, hint: '' },
      { label: 'P25 → P95', value: `${result.plotP25.toFixed(2)} → ${result.plotP95.toFixed(2)} m`, hint: '' },
      { label: 'P75 / P90', value: `${result.plotP75.toFixed(2)} / ${result.plotP90.toFixed(2)} m`, hint: '' },
      { label: 'Skew · Kurt', value: `${result.plotSkew.toFixed(2)} · ${result.plotKurt.toFixed(2)}`, hint: 'distribution shape' },
      { label: 'Canopy cover', value: `${(result.plotCanopyCover * 100).toFixed(1)} %`, hint: `≥ ${result.canopyThreshold} m above ground · ${result.canopyCoverBasis}` },
    ];
  }, [result]);

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 440 }}>
      {/* Parameters */}
      <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>Cell size (m)</label>
          <input type="range" min={0.5} max={10} step={0.25}
            value={cellSize} onChange={(e) => setCellSize(parseFloat(e.target.value))}
            disabled={computing} className="flex-1" />
          <span className="mono text-[10px] w-[48px] text-right" style={{ color: 'var(--text)' }}>{cellSize.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>Min height (m)</label>
          <input type="range" min={0} max={3} step={0.05}
            value={minHeight} onChange={(e) => setMinHeight(parseFloat(e.target.value))}
            disabled={computing} className="flex-1" />
          <span className="mono text-[10px] w-[48px] text-right" style={{ color: 'var(--text)' }}>{minHeight.toFixed(2)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>Canopy threshold (m)</label>
          <input type="range" min={0.5} max={10} step={0.25}
            value={canopyThreshold} onChange={(e) => setCanopyThreshold(parseFloat(e.target.value))}
            disabled={computing} className="flex-1" />
          <span className="mono text-[10px] w-[48px] text-right" style={{ color: 'var(--text)' }}>{canopyThreshold.toFixed(2)}</span>
        </div>
      </div>

      <div className="flex gap-1.5">
        <button
          className="btn !h-7 mono text-[11px] justify-center flex-1"
          onClick={() => void run()}
          disabled={!desktop?.octreeDensityMetrics || !octree?.dir || computing}
          title="Compute height-above-ground statistics over the whole cloud. Requires DTM (run Terrain first)."
        >
          {computing
            ? `Computing… ${(pct * 100).toFixed(0)} %`
            : (result ? 'Re-compute' : 'Compute density metrics')}
        </button>
        {computing && (
          <button className="btn !h-7 mono text-[11px] !px-3" onClick={() => cancelStage('density')} disabled={!canCancel()}
            title="Stop the run — the rasters are written only at the end">Cancel</button>
        )}
      </div>

      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      {!result && !computing && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
          Streams the cloud, samples the cached DTM bilinearly to get height-above-ground per point, and produces twelve gridded rasters (mean / SD / CV / skew / kurt / P25 / P50 / P75 / P90 / P95 / return density / canopy cover) plus a plot-wide summary — the classical lidR / FORTLS inventory dashboard. Run the Terrain panel first so the DTM is in place.
        </div>
      )}

      {/* Plot summary */}
      {summary && result && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="flex items-center justify-between">
            <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Plot summary</span>
            <button className="btn !h-6 !px-2 mono text-[10px]" onClick={exportCsv}>Export CSV</button>
          </div>
          {summary.map((s) => (
            <div key={s.label} className="flex items-baseline gap-2 mono text-[10.5px]">
              <span style={{ color: 'var(--text-dim)', width: 130 }}>{s.label}</span>
              <span style={{ color: 'var(--text)' }}>{s.value}</span>
              {s.hint && <span style={{ color: 'var(--text-mute)', fontSize: 9.5 }}>{s.hint}</span>}
            </div>
          ))}
          {perTreeLoading && (
            <div className="pt-1.5 mt-0.5 mono text-[10px]" style={{ borderTop: '1px solid var(--line)', color: 'var(--text-dim)' }}>
              Computing per-tree metrics — streaming the cloud…
            </div>
          )}
          {perTree && (
            <div className="pt-1.5 mt-0.5 flex flex-col gap-1" style={{ borderTop: '1px solid var(--line)' }}>
              <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>From per-tree metrics ({perTree.treeCount} trees)</span>
              <Row label="Lorey's mean height"   value={`${perTree.loreyMeanHeight.toFixed(2)} m`}  hint="basal-area weighted" />
              <Row label="Dominant height"       value={`${perTree.dominantHeight.toFixed(2)} m`}  hint={`top ${perTree.topNCount} stems`} />
              <Row label="Plot basal area"        value={`${perTree.basalArea.toFixed(2)} m²`}      hint="Σ from DBH" />
            </div>
          )}
        </div>
      )}

      {/* Raster layer hint */}
      {result && (
        <div className="mono text-[9.5px] px-1.5 py-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          12 rasters added to the Layers panel ({result.cols}×{result.rows} @ {result.cellSize.toFixed(2)} m). Toggle one on to colour the ground by it.
        </div>
      )}
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 mono text-[10.5px]">
      <span style={{ color: 'var(--text-dim)', width: 130 }}>{label}</span>
      <span style={{ color: 'var(--text)' }}>{value}</span>
      {hint && <span style={{ color: 'var(--text-mute)', fontSize: 9.5 }}>{hint}</span>}
    </div>
  );
}
