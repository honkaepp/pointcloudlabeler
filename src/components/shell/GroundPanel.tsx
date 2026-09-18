// Ground (Terrain) panel — bare-earth classification + terrain models.
// The user picks the filter: PMF (Progressive Morphological Filter,
// Zhang 2003 — per-cell min surface → growing morphological opening) or
// CSF (Cloth Simulation Filter, Zhang 2016 — a stiff cloth settles onto
// the terrain and bridges canopy / buildings). Both run natively +
// out-of-core over the whole octree and write class 2 in place, shown via
// the Classification colour mode. The panel also builds DTM / DSM / CHM
// rasters (tagged by the classifier used) and exports a normalized cloud.

import { useCallback, useEffect, useState } from 'react';
import { cancelStage, canCancel } from '../../ui/cancelStage';
import { useOctreeShell, DEFAULT_GROUND_PARAMS, type GroundParams } from './OctreeShellContext';
import type { TerrainResult, RasterLayer } from '../../persistence/octreeReader';
import type { ExportReport } from '../../persistence/desktopBridge';
import { parseAsciiGrid } from '../../io/asciiGrid';
import { confirmDialog } from '../../ui/dialogs';

interface Desktop {
  octreeClassifyGround?: unknown;
  octreeTerrain?: (
    dir: string, cellSize: number,
    opts?: { dsmMethod?: 'p2r' | 'pit_free'; dsmLayers?: number[] },
  ) => Promise<TerrainResult>;
  saveLasDialog?: (name: string) => Promise<string | null>;
  cloudExportOctreeLas?: (dir: string, out: string, normalize?: boolean, cellSize?: number) => Promise<ExportReport>;
  octreeNormalize?: (dir: string, cellSize: number) => Promise<{ count: number; min: number; max: number; withoutGround: number }>;
  octreeRemoveExtra?: (dir: string, name: string) => Promise<number>;
  readFile?: (path: string) => Promise<ArrayBuffer>;
  onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void> | (() => void);
}

/** Canonical height-above-ground column tokens (punctuation/​case
 *  stripped) so the normalize tool can spot an existing one — imported
 *  or previously computed — under any spelling and require a reset before
 *  recomputing. */
const HAG_TOKENS = new Set([
  'heightaboveground', 'hag', 'agl', 'normalizedheight', 'heightnormalized',
  'normz', 'znorm', 'zaboveground', 'normalizedz', 'nz', 'zn',
]);
function findHagExtra(extras: { name: string }[] | undefined): string | null {
  for (const e of extras ?? []) {
    const key = e.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (HAG_TOKENS.has(key)) return e.name;
  }
  return null;
}

export default function GroundPanel() {
  const { api, octree, display, setDisplay, setRasterLayers, reloadActiveOctree } = useOctreeShell();
  const [params, setParams] = useState<GroundParams>(DEFAULT_GROUND_PARAMS);
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terrain, setTerrain] = useState<TerrainResult | null>(null);
  // The classifier that produced the current class-2 points — drives the
  // terrain raster labels so a CSF DTM reads differently from a PMF one.
  const [lastMethod, setLastMethod] = useState<'pmf' | 'csf'>('pmf');
  const isCsf = params.method === 'csf';
  // DSM construction method. 'p2r' (default) is the per-cell-max grid;
  // 'pit_free' adds a multi-layer surface-max pass that fills small
  // canopy-gap pits — visibly cleaner CHM on sparse forest, at the cost
  // of one extra streaming pass over octree.bin.
  const [dsmMethod, setDsmMethod] = useState<'p2r' | 'pit_free'>('p2r');

  const desktop = (window as unknown as { desktop?: Desktop }).desktop;
  const canRun = !!desktop?.octreeClassifyGround && !!api && !!octree;
  const canTerrain = !!desktop?.octreeTerrain && !!api && !!octree;
  const canExportNormalized = !!desktop?.saveLasDialog && !!desktop?.cloudExportOctreeLas && !!api && !!octree;

  const set = (patch: Partial<GroundParams>) => setParams(p => ({ ...p, ...patch }));

  // Subscribe to native progress while any long op runs (classify /
  // reset / terrain all report through the octree-progress channel).
  useEffect(() => {
    if (!running || !desktop?.onOctreeProgress) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    Promise.resolve(desktop.onOctreeProgress((e) => {
      if (e.stage === 'classify_ground' || e.stage === 'terrain' || e.stage === 'reset_class' || e.stage === 'export' || e.stage === 'normalize' || e.stage === 'remove_extra') setPct(e.pct);
    })).then((u) => { if (cancelled) u?.(); else unlisten = u; });
    return () => { cancelled = true; unlisten?.(); };
  }, [running, desktop]);

  const run = useCallback(async () => {
    if (!api) return;
    setRunning(true); setPct(0); setError(null); setResult(null);
    try {
      const n = await api.classifyGround(params);
      setResult(`${n.toLocaleString()} ground points (${params.method.toUpperCase()})`);
      setLastMethod(params.method);
      // Show the result straight away.
      if (display.colorMode !== 'classification') setDisplay({ colorMode: 'classification' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setPct(0);
    }
  }, [api, params, display.colorMode, setDisplay]);

  // Compute DTM / DSM / CHM rasters from the (classified) cloud. Flushes
  // edits first so deleted points are excluded, then writes the three
  // .asc grids under <octreeDir>/terrain/.
  const computeTerrain = useCallback(async () => {
    if (!api || !octree || !desktop?.octreeTerrain) return;
    setRunning(true); setPct(0); setError(null); setResult(null); setTerrain(null);
    try {
      await api.save();
      const res = await desktop.octreeTerrain(octree.dir, params.cellSize, { dsmMethod });
      setTerrain(res);
      // Load the freshly-written grids as scene objects (CHM shown by
      // default, terrain models added hidden) so they're toggleable in
      // the Layers panel without leaving this panel.
      const read = desktop.readFile;
      if (read) {
        // Tag each raster by BOTH the classifier (ground source) and the
        // DSM method, so e.g. a PMF + p2r CHM and a CSF + pit-free CHM
        // can sit in the Layers panel side by side, distinctly named, and
        // re-computing one only replaces the matching tag.
        const M = lastMethod.toUpperCase();
        const D = dsmMethod === 'pit_free' ? 'pit-free' : 'p2r';
        const tag = `${lastMethod}-${dsmMethod}`;
        const load = async (path: string, kind: RasterLayer['kind'], label: string, visible: boolean): Promise<RasterLayer | null> => {
          try {
            const text = new TextDecoder().decode(await read(path));
            return { id: `${kind}:${tag}`, kind, label, visible, grid: parseAsciiGrid(text) };
          } catch { return null; }
        };
        // The DTM doesn't depend on the DSM method, so it stays tagged
        // only by the classifier (its id stays stable across DSM tweaks).
        const loaded = (await Promise.all([
          load(res.chmPath, 'chm', `CHM · canopy height (${M} · ${D})`, true),
          load(res.dsmPath, 'dsm', `DSM · surface (${M} · ${D})`, false),
        ])).filter((l): l is RasterLayer => l !== null);
        const dtm = await load(res.dtmPath, 'dtm', `DTM · ground (${M})`, false);
        if (dtm) {
          // Re-tag the DTM with the classifier only (its surface doesn't
          // change between p2r / pit-free runs of the SAME classifier).
          dtm.id = `dtm:${lastMethod}`;
          loaded.push(dtm);
          // Drape the CHM onto the ground so it renders at the real canopy
          // elevation (ground + height) rather than as a low relief.
          const chm = loaded.find(l => l.kind === 'chm');
          if (chm && dtm.grid) chm.elevationGrid = dtm.grid;
        }
        // Geomorphometric + hydrological derivatives, all computed
        // from the DTM in a single rayon pass and written alongside
        // the elevation surfaces. Hidden by default — foresters opt
        // in from the Layers panel when they need a specific layer
        // (TWI for site quality, HLI for thermal exposure, plan
        // curvature for drainage convergence, …). Drape them onto
        // the ground for the relief look.
        const r = res.tpiRadiusCells * res.cellSize;
        const streamArea = res.streamThresholdCells * res.cellSize * res.cellSize;
        const derivs = (await Promise.all([
          load(res.slopePath,        'slope',        `Slope · degrees (Horn 1981, ${M})`, false),
          load(res.aspectPath,       'aspect',       `Aspect · compass deg (Horn 1981, ${M})`, false),
          load(res.tpiPath,          'tpi',          `TPI · ±metres (Weiss 2001, r=${r.toFixed(1)} m, ${M})`, false),
          load(res.filledPath,       'filled',       `Filled DEM · sinks raised (Wang–Liu 2006, ${M})`, false),
          load(res.flowAccumPath,    'flow_accum',   `Flow accumulation · cells (D8, ${M})`, false),
          load(res.twiPath,          'twi',          `TWI · wetness ln(α/tan β) (Beven & Kirkby 1979, ${M})`, false),
          load(res.streamsPath,      'streams',      `Streams · ≥ ${streamArea.toFixed(0)} m² catchment (${M})`, false),
          load(res.planCurvPath,     'plan_curv',    `Plan curvature · 1/m (Zevenbergen & Thorne 1987, ${M})`, false),
          load(res.profileCurvPath,  'profile_curv', `Profile curvature · 1/m (Zevenbergen & Thorne 1987, ${M})`, false),
          load(res.triPath,          'tri',          `TRI · ruggedness (m, Riley 1999, ${M})`, false),
          load(res.hliPath,          'hli',          `HLI · heat load index (McCune & Keon 2002, ${Math.abs(res.hliLatitudeDeg).toFixed(1)}°${res.hliLatitudeDeg < 0 ? 'S' : 'N'}, ${M})`, false),
          load(res.hillshadePath,      'hillshade',       `Hillshade · sun ${res.hillshadeAzimuthDeg.toFixed(0)}° az / ${res.hillshadeAltitudeDeg.toFixed(0)}° alt (${M})`, false),
          load(res.hillshadeMultiPath, 'hillshade_multi', `Hillshade · multi-directional (Mark 1992, ${M})`, false),
        ])).filter((l): l is RasterLayer => l !== null);
        for (const d of derivs) {
          // Pin derivative ids to the classifier (independent of DSM tag,
          // since they come from the DTM only).
          d.id = `${d.kind}:${lastMethod}`;
          if (dtm?.grid) d.elevationGrid = dtm.grid;
          loaded.push(d);
        }
        // Merge: replace same-id layers (a re-compute with the same tag)
        // but keep rasters from other classifier / DSM combinations so
        // both stay viewable side by side.
        setRasterLayers(prev => {
          const ids = new Set(loaded.map(l => l.id));
          return [...prev.filter(l => !ids.has(l.id)), ...loaded];
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setPct(0);
    }
  }, [api, octree, desktop, params.cellSize, lastMethod, dsmMethod, setRasterLayers]);

  // Export a height-normalised cloud — point Z becomes height above the
  // ground (class-2 DTM). Flushes edits, prompts for LAS/LAZ, then writes.
  const exportNormalized = useCallback(async () => {
    if (!api || !octree || !desktop?.saveLasDialog || !desktop?.cloudExportOctreeLas) return;
    const base = (octree.meta.name || 'octree').replace(/[\\/:*?"<>|]+/g, '_');
    const out = await desktop.saveLasDialog(`${base}_normalized.las`);
    if (!out) return;
    setRunning(true); setPct(0); setError(null); setResult(null);
    try {
      await api.save();
      const r = await desktop.cloudExportOctreeLas(octree.dir, out, true, params.cellSize);
      // Points with no ground beneath them cannot be given a height above
      // ground, so a normalised export leaves them out. Report it here
      // rather than let the file be quietly short.
      const dropped = r.skippedNoGround > 0
        ? ` (${r.skippedNoGround.toLocaleString()} left out — no ground beneath them)`
        : '';
      setResult(`exported ${r.written.toLocaleString()} points → ${out}${dropped}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setPct(0);
    }
  }, [api, octree, desktop, params.cellSize]);

  // Reset classifications. `from` < 0 clears every class; otherwise only
  // that class is reset to unclassified (1). Lets a pre-classified import
  // (or a previous run) be wiped so our classifier starts fresh.
  const reset = useCallback(async (from: number, label: string) => {
    if (!api) return;
    setRunning(true); setPct(0); setError(null); setResult(null);
    try {
      const n = await api.resetClassification(from, 1);
      setResult(`reset ${n.toLocaleString()} points (${label})`);
      if (display.colorMode !== 'classification') setDisplay({ colorMode: 'classification' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setPct(0);
    }
  }, [api, display.colorMode, setDisplay]);

  // Existing height-above-ground extra (imported or previously computed),
  // if any. While present the normalize tool is blocked — reset it first.
  const hagName = findHagExtra(octree?.meta.extras);
  const canNormalize = !!desktop?.octreeNormalize && !!api && !!octree && !hagName;

  // Add a height-above-ground extra column from the class-2 DTM. Z stays
  // absolute (so a LAS/LAZ export keeps real elevation); the new column is
  // colour-by-able in the Display panel. Flush edits first (the DTM build
  // honours deletions), then re-open so the viewer sees the new column.
  const normalize = useCallback(async () => {
    if (!api || !octree || !desktop?.octreeNormalize) return;
    setRunning(true); setPct(0); setError(null); setResult(null);
    try {
      await api.save();
      const res = await desktop.octreeNormalize(octree.dir, params.cellSize);
      // Points with no ground beneath them get NaN, not a height, and are
      // excluded from the range above. Saying how many is the difference
      // between "the range is 0–28 m" and "the range is 0–28 m over the
      // 94 % of the cloud the ground surface actually reaches".
      const gap = res.withoutGround > 0
        ? ` · ${res.withoutGround.toLocaleString()} points have no ground beneath them (no height)`
        : '';
      setResult(`height-above-ground column added · ${res.min.toFixed(1)}–${res.max.toFixed(1)} m${gap}`);
      await reloadActiveOctree?.();
      // Show it straight away.
      setDisplay({ colorMode: 'extra:height_above_ground' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setPct(0);
    }
  }, [api, octree, desktop, params.cellSize, reloadActiveOctree, setDisplay]);

  // Reset (remove) an existing height-above-ground column so it can be
  // recomputed — whether one we created or one that rode in from the file.
  const resetHag = useCallback(async () => {
    if (!api || !octree || !desktop?.octreeRemoveExtra || !hagName) return;
    if (!await confirmDialog(`Remove the "${hagName}" column? You can recompute it afterwards.`)) return;
    setRunning(true); setPct(0); setError(null); setResult(null);
    try {
      await api.save();
      await desktop.octreeRemoveExtra(octree.dir, hagName);
      setResult(`removed "${hagName}" column`);
      // If we were colouring by it, fall back to height so the view stays valid.
      if (display.colorMode === `extra:${hagName}`) setDisplay({ colorMode: 'height' });
      await reloadActiveOctree?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setPct(0);
    }
  }, [api, octree, desktop, hagName, display.colorMode, reloadActiveOctree, setDisplay]);

  return (
    <div className="flex flex-col gap-2.5" style={{ width: 248 }}>
      {!canRun && !running && (
        <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Ground classification needs the desktop build (it runs natively over the whole cloud).
        </div>
      )}

      {/* Method picker — PMF vs CSF. Both write class 2 over the whole
          cloud; the parameters below follow the active method. */}
      <div>
        <div className="chip mb-1.5">Algorithm</div>
        <div className="flex gap-1 p-0.5 rounded-md" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)' }}>
          {([
            { v: 'pmf', label: 'PMF' },
            { v: 'csf', label: 'CSF' },
          ] as const).map(o => {
            const active = params.method === o.v;
            return (
              <button
                key={o.v}
                onClick={() => set({ method: o.v })}
                className="flex-1 rounded py-1.5 mono text-[11px] transition-all"
                style={{
                  background: active ? 'color-mix(in oklch, var(--accent) 20%, transparent)' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--text-dim)',
                }}
              >{o.label}</button>
            );
          })}
        </div>
        <div className="mono text-[9.5px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          {isCsf
            ? 'Cloth Simulation Filter (Zhang et al. 2016) — a stiff cloth settles onto the terrain from below and bridges canopy / buildings. Good on complex relief.'
            : 'Progressive Morphological Filter (Zhang et al. 2003) — the standard bare-earth filter via growing morphological openings.'}
        </div>
      </div>

      <Num label="Cell size" unit="m" value={params.cellSize} min={0.05} step={0.05}
        onChange={(v) => set({ cellSize: v })} hint={isCsf ? 'Cloth resolution. 0.5 m for plot-scale TLS/MLS.' : 'Raster resolution. 0.5 m for plot-scale TLS/MLS.'} />
      <Num label="Tolerance" unit="m" value={params.tolerance} min={0.01} step={0.01}
        onChange={(v) => set({ tolerance: v })} hint="Height band above bare earth still counted as ground." />

      {isCsf ? (
        <Num label="Rigidity" unit="" value={params.rigidity} min={1} max={4} step={1}
          onChange={(v) => set({ rigidity: Math.round(Math.max(1, Math.min(4, v))) })}
          hint="Cloth stiffness 1–4. 1 = steep/relief, 4 = flat. Stiffer bridges wider gaps with no ground return: on a 5×5-cell canopy patch, 1 climbs into all of it, 4 bridges all of it." />
      ) : (<>
        <Num label="Slope budget" unit="" value={params.slope} min={0.01} step={0.01}
          onChange={(v) => set({ slope: v })} hint="Rise/run. 0.2 ≈ 11°. Raise on steep terrain." />
        <details>
          <summary className="mono text-[10px] cursor-pointer" style={{ color: 'var(--text-dim)' }}>
            Advanced
          </summary>
          <div className="flex flex-col gap-2.5 mt-2">
            <Num label="Initial threshold" unit="m" value={params.initialThreshold} min={0.01} step={0.05}
              onChange={(v) => set({ initialThreshold: v })} hint="Smallest object the first window removes." />
            {/* The cap only engages once slope × window growth reaches it,
                which at the defaults it never does — the per-step threshold
                tops out at 1.9 m against a 2.5 m cap. Saying so here because
                it is the control a user reaches for first when the filter is
                shaving terrain, and Slope is the one that moves. */}
            <Num label="Max threshold" unit="m" value={params.maxThreshold} min={0.1} step={0.1}
              onChange={(v) => set({ maxThreshold: v })}
              hint="Cap so big windows don't re-accept canopy. Only bites below slope × window growth — at the defaults that peaks at 1.9 m, so raise Slope to keep taller terrain." />
            <Num label="Max window" unit="m" value={params.maxWindowM} min={1} step={0.5}
              onChange={(v) => set({ maxWindowM: v })} hint="WIDTH of the largest opening, and an opening removes only what it can span — so this must exceed the widest crown, not half of it." />
          </div>
        </details>
      </>)}

      <div className="flex gap-1.5">
        <button
          className="btn btn-primary !h-8 flex-1 justify-center mono text-[11.5px]"
          disabled={!canRun || running}
          onClick={run}
          title="Classify ground points across the whole cloud"
        >
          {running ? `Classifying… ${Math.round(pct * 100)}%` : `Classify ground · ${params.method.toUpperCase()}`}
        </button>
        {running && (
          <button className="btn !h-8 mono text-[11px] !px-3" onClick={() => cancelStage('classify_ground', 'terrain')} disabled={!canCancel()}
            title="Stop the run — classes are written only at the end, so a stopped run changes nothing">Cancel</button>
        )}
      </div>

      {running && (
        <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: 'var(--wash-3)' }}>
          <div style={{ width: `${Math.round(pct * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
        </div>
      )}

      {result && !running && (
        <div className="mono text-[10.5px]" style={{ color: 'var(--accent)' }}>
          ✓ {result}
        </div>
      )}
      {error && (
        <div className="mono text-[10px]" style={{ color: 'var(--danger, #e0506b)', lineHeight: 1.5 }}>
          {error}
        </div>
      )}

      {/* Terrain models — DTM / DSM / CHM rasters from the classified
          cloud (DTM is built from class-2 ground, so classify first). */}
      <div className="pt-1" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="chip mb-1.5">Terrain models</div>
        {/* DSM construction method. p2r = per-cell max (fast, default).
            pit-free = Khosravipour 2014 style multi-layer surface max +
            small dilation, so canopy gaps don't read as pits in the CHM.
            Recomputing with a different method adds a SECOND CHM/DSM to
            the Layers panel (tagged by method) so the two are easy to
            compare side by side. */}
        <div className="mb-1.5">
          <div className="mono text-[10px] mb-1" style={{ color: 'var(--text-mute)' }}>DSM method</div>
          <div className="flex gap-1 p-0.5 rounded-md" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)' }}>
            {([
              { v: 'p2r', label: 'p2r' },
              { v: 'pit_free', label: 'pit-free' },
            ] as const).map(o => {
              const active = dsmMethod === o.v;
              return (
                <button
                  key={o.v}
                  onClick={() => setDsmMethod(o.v)}
                  className="flex-1 rounded py-1 mono text-[11px] transition-all"
                  style={{
                    background: active ? 'color-mix(in oklch, var(--accent) 20%, transparent)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-dim)',
                  }}
                  title={o.v === 'p2r'
                    ? 'Point-to-raster: per-cell max of each point’s height above the bilinear ground.'
                    : 'Pit-free (Khosravipour 2014): the same per-point normalisation, then a multi-layer surface max + small dilation that fills canopy-gap pits.'}
                >{o.label}</button>
              );
            })}
          </div>
          <div className="mono text-[9px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            CHM is built per-point: each point’s height above the bilinear DTM (so it’s accurate on slopes), max per cell.
            {dsmMethod === 'pit_free'
              ? ' Pit-free adds layered surfaces + a 3×3 close to fill small canopy gaps. Rasters tagged "pit-free" sit alongside any p2r ones in the Layers panel.'
              : ' p2r is the fast per-cell max; pit-free fills small gaps.'}
          </div>
        </div>
        <div className="flex gap-1.5">
          <button
            className="btn !h-8 flex-1 justify-center mono text-[11.5px]"
            disabled={!canTerrain || running}
            onClick={computeTerrain}
            title="Compute DTM / DSM / CHM rasters and write them as .asc grids"
          >
            {running ? `Computing… ${Math.round(pct * 100)}%` : `Compute DTM · DSM · CHM · ${dsmMethod === 'pit_free' ? 'pit-free' : 'p2r'}`}
          </button>
          {running && (
            <button className="btn !h-8 mono text-[11px] !px-3" onClick={() => cancelStage('terrain', 'classify_ground')} disabled={!canCancel()}
              title="Stop the run — the rasters are written only at the end">Cancel</button>
          )}
        </div>
        {terrain && !running && (
          <div className="mt-1.5 flex flex-col gap-0.5 mono text-[9.5px]" style={{ color: 'var(--text-dim)' }}>
            <div>{terrain.cols}×{terrain.rows} cells · {terrain.cellSize.toFixed(2)} m</div>
            <div>CHM max <span style={{ color: 'var(--accent)' }}>{terrain.chmMax.toFixed(1)} m</span> · DTM {terrain.dtmMin.toFixed(1)}–{terrain.dtmMax.toFixed(1)} m</div>
            <div className="truncate" style={{ color: 'var(--text-mute)' }} title={terrain.outDir}>→ {terrain.outDir}</div>
            <div style={{ color: 'var(--text-mute)' }}>.asc + .tif (GeoTIFF) written for each — drop the .tif straight into QGIS / ArcGIS</div>
          </div>
        )}
        <button
          className="btn !h-7 w-full justify-center mono text-[11px] mt-1.5"
          disabled={!canExportNormalized || running}
          onClick={exportNormalized}
          title="Export a LAS/LAZ where Z is height above ground (Z − DTM)"
        >
          Export normalized cloud…
        </button>
        <div className="mono text-[9px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          DTM (ground) · DSM (top surface) · CHM (canopy height = DSM−DTM), written as ESRI ASCII grids. Normalized export re-bases each point's Z to height above ground.
        </div>
      </div>

      {/* Normalize (height above ground) — add a column to THIS dataset
          rather than exporting. Z geometry is kept (a LAS/LAZ export still
          carries the absolute elevation); the new column is colour-by-able
          in the Display panel. Blocked when a height-above-ground column
          already exists — reset it first. */}
      <div className="pt-1" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="chip mb-1.5">Normalize · height above ground</div>
        {hagName ? (
          <>
            <div className="mono text-[10px] mb-1.5" style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>
              Column <span style={{ color: 'var(--accent)' }}>{hagName}</span> already present. Colour by it in the Display panel, or reset it to recompute.
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                className="btn !h-7 !px-2 mono text-[11px] justify-center"
                disabled={!api || running}
                onClick={() => setDisplay({ colorMode: `extra:${hagName}` })}
                title="Colour the cloud by the existing height-above-ground column"
              >Colour by it</button>
              <button
                className="btn !h-7 !px-2 mono text-[11px] justify-center"
                disabled={!desktop?.octreeRemoveExtra || running}
                onClick={resetHag}
                title="Remove the existing height-above-ground column so it can be recomputed"
              >Reset column</button>
            </div>
          </>
        ) : (
          <>
            <button
              className="btn !h-8 w-full justify-center mono text-[11.5px]"
              disabled={!canNormalize || running}
              onClick={normalize}
              title="Add a height-above-ground column (Z − class-2 DTM) to this dataset"
            >
              {running ? `Normalizing… ${Math.round(pct * 100)}%` : 'Add height-above-ground column'}
            </button>
            <div className="mono text-[9px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              Adds a <span style={{ color: 'var(--text-dim)' }}>height_above_ground</span> column (4 B/point) computed from the class-2 ground surface. Z stays absolute, so exports keep real elevation. Classify ground first.
            </div>
          </>
        )}
      </div>

      {/* Reset — clear an existing classification (e.g. one baked into the
          import) so the classifier above can run on a clean slate. */}
      <div className="pt-1" style={{ borderTop: '1px solid var(--line)' }}>
        <div className="chip mb-1.5">Reset</div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            className="btn !h-7 !px-2 mono text-[11px] justify-center"
            disabled={!canRun || running}
            onClick={() => reset(2, 'ground → unclassified')}
            title="Set every ground (class 2) point back to unclassified"
          >Clear ground</button>
          <button
            className="btn !h-7 !px-2 mono text-[11px] justify-center"
            disabled={!canRun || running}
            onClick={() => reset(-1, 'all → unclassified')}
            title="Set every point's classification back to unclassified"
          >Clear all</button>
        </div>
      </div>

      <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Re-running recomputes from scratch — tweak and classify again freely. Hide ground from the Filters panel (class 2).
      </div>
    </div>
  );
}

function Num({ label, unit, value, min, max, step, onChange, hint }: {
  label: string;
  unit: string;
  value: number;
  min: number;
  /** Upper bound, for the parameters that have one. Enforced on the way
   *  out as well as declared on the input — the spinner respects `max`
   *  but typing does not, and a rigidity of 9 reaching the backend is
   *  silently clamped there, so the panel would show a setting the
   *  classifier is not using. */
  max?: number;
  step: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>{label}</span>
        <div className="flex items-center gap-1">
          <input
            type="number" value={value} min={min} max={max} step={step}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (Number.isFinite(v)) onChange(Math.min(max ?? Infinity, Math.max(min, v)));
            }}
            className="w-16 mono text-[12px] py-1 px-2 rounded-md text-right"
            style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', outline: 'none' }}
          />
          {unit && <span className="mono text-[10px]" style={{ color: 'var(--text-mute)', width: 12 }}>{unit}</span>}
        </div>
      </div>
      {hint && <div className="mono text-[9px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}
