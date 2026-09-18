// Report panel — collect every analytics cache PointCloudLabeler has computed for
// the active project and emit a single self-contained .html report.
//
// The panel doesn't compute anything itself; it reads the same caches
// the dedicated panels (Metrics, QSM, Density, Validation) wrote, so
// the report mirrors exactly what those panels showed. Missing
// sections (no QSM yet → no volume block, no field data → no
// validation block) degrade gracefully.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import type { TreeMetric, QsmResult, DensityMetricsResult, StemFit } from '../../persistence/octreeReader';
import { useProject } from '../../context/ProjectContext';
import { generateReportHtml } from '../../report/generate';
import { SPECIES_DENSITIES, computeSpeciesAwareBiomass, computeBiomassTotals } from '../../metrics/biomass';
import {
  CUSTOM_SPECIES_KEY, fallbackDensityLabel, loadBiomassSettings, saveBiomassSettings,
  withFallbackSpecies,
} from '../../metrics/biomassSettings';
import { plotAreaHa as boundaryPlotAreaHa } from '../../utils/plotBoundary';
import { loadTreeMetrics } from '../../metrics/loadMetrics';
import { getCurrency, setCurrency, MAX_CURRENCY_LEN } from '../../metrics/currency';
import { saveTextFile } from '../../io/saveDownload';

interface Desktop {
  octreeTreeMetrics?: (
    dir: string,
    params: { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number },
  ) => Promise<TreeMetric[]>;
  octreeReadQsm?: (dir: string) => Promise<QsmResult | null>;
  octreeReadStems?: (dir: string) => Promise<StemFit[] | null>;
  octreeDensityMetrics?: (
    dir: string, cellSize: number,
    opts: { minHeight?: number; canopyThreshold?: number; epsg?: number },
  ) => Promise<DensityMetricsResult>;
  octreeReadSpecies?: (dir: string) => Promise<string>;
  onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void> | (() => void);
}

export default function ReportPanel() {
  const {
    octree, plotBoundary,
    // Report hand-off summaries — each written by its own producing panel
    // on a successful run (ValidationPanel / TreeGrowthPanel / M3C2Panel /
    // StemTaperPanel). This panel only reads them; it never recomputes.
    validationSummary, growthSummary, m3c2Summary, taperMeasurements,
  } = useOctreeShell();
  const { project } = useProject();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  // ---- Inputs collected from the project + the user ----
  const [projectName, setProjectName] = useState('');
  const [description, setDescription] = useState('');
  const [plotAreaHa, setPlotAreaHa] = useState<number | null>(null);
  const [autoPlotArea, setAutoPlotArea] = useState(true);
  // Fallback species for any tree with no assignment in Tree Review —
  // the real per-tree mix comes from species.json (loaded below); this
  // only covers what's left unassigned. Keyed like SPECIES_DENSITIES
  // (not a display label) so it drives computeSpeciesAwareBiomass directly.
  // Read, not chosen here. The density behind a carbon figure is set in
  // the Metrics module; this panel used to ignore it and pass
  // DEFAULT_BIOMASS_PARAMS, so the report quoted a different tonnage
  // from the table the user had just read — always at 400 kg/m³, which
  // is Scots pine, which is not what grows in most of the world.
  const [biomassSettings, setBiomassSettings] = useState(() => loadBiomassSettings());
  const fallbackSpeciesKey = biomassSettings.fallbackSpeciesKey;
  const setFallbackSpeciesKey = (key: string) =>
    setBiomassSettings(s => saveBiomassSettings(withFallbackSpecies(s, key)));
  const [unitPrice, setUnitPrice] = useState(35);
  // The report is a client-facing document; its money has to say
  // whose money it is. Shared with the Bucking / Thinning panels so
  // one plot cannot quote two currencies. See metrics/currency.ts.
  const [currency, setCurrencyState] = useState<string>(() => getCurrency());

  // Auto-fill project name from project / dataset when available.
  useEffect(() => {
    if (octree?.meta?.name && !projectName) setProjectName(octree.meta.name);
    else if (project?.folder && !projectName) {
      const last = project.folder.replace(/[\\/]$/, '').split(/[\\/]/).pop() ?? '';
      if (last) setProjectName(last);
    }
  }, [octree, project, projectName]);

  // ---- Cached data ----
  const [metrics, setMetrics] = useState<TreeMetric[] | null>(null);
  const [qsm, setQsm] = useState<QsmResult | null>(null);
  const [density, setDensity] = useState<DensityMetricsResult | null>(null);
  // Per-tree species assignment (species.json) — same bookkeeping
  // overlay Tree Review writes; read-only here, refreshed alongside the
  // other caches.
  const [speciesByTree, setSpeciesByTree] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Pull every cache the report can use. Each call is best-effort —
  // a missing cache just means that section won't render.
  const refresh = useCallback(async () => {
    if (!octree?.dir || !desktop) { setMetrics(null); setQsm(null); setDensity(null); setSpeciesByTree(new Map()); return; }
    setLoading(true); setError(null);
    try {
      if (desktop.octreeTreeMetrics) {
        try {
          setMetrics(await loadTreeMetrics(desktop, octree.dir));
        } catch {
          setMetrics(null);
        }
      }
      if (desktop.octreeReadQsm) {
        try { setQsm(await desktop.octreeReadQsm(octree.dir)); } catch { setQsm(null); }
      }
      if (desktop.octreeReadSpecies) {
        try {
          const raw = await desktop.octreeReadSpecies(octree.dir);
          const obj = JSON.parse(raw) as Record<string, string>;
          const m = new Map<number, string>();
          for (const [k, v] of Object.entries(obj)) {
            const id = parseInt(k, 10);
            if (Number.isFinite(id) && typeof v === 'string' && v) m.set(id, v);
          }
          setSpeciesByTree(m);
        } catch { setSpeciesByTree(new Map()); }
      }
      // Density metrics is heavier — don't auto-trigger a fresh
      // compute, only pick it up if a previous run cached results
      // (the panel exposes a "Run density now" toggle for that).
      // For now we just leave density null unless explicitly run.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [octree?.dir, desktop]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Auto plot area from tree bbox — minimal axis-aligned envelope.
  const autoPlotAreaValue = useMemo(() => {
    if (!metrics || metrics.length === 0) return null;
    const xs = metrics.map(t => t.x).filter(Number.isFinite);
    const ys = metrics.map(t => t.y).filter(Number.isFinite);
    if (xs.length === 0 || ys.length === 0) return null;
    const span = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
    return Math.max(0.0025, span / 10000); // ha
  }, [metrics]);
  // When a Plot Boundary panel has defined a boundary, prefer its
  // exact area (with edge-correction in mind) over the tree-bbox
  // auto-fit. The user can still tick "auto" off + type a manual
  // value when the boundary isn't authoritative. plotAreaHa() is the
  // one implementation of this maths (src/utils/plotBoundary.ts) — every
  // consumer (this panel, Thinning, InventoryModule) calls the same
  // function instead of each re-deriving the circle/rectangle formula.
  const boundaryAreaHa = useMemo(
    () => (plotBoundary ? boundaryPlotAreaHa(plotBoundary) : null),
    [plotBoundary],
  );
  useEffect(() => {
    if (!autoPlotArea) return;
    if (boundaryAreaHa !== null) setPlotAreaHa(boundaryAreaHa);
    else if (autoPlotAreaValue !== null) setPlotAreaHa(autoPlotAreaValue);
  }, [autoPlotArea, autoPlotAreaValue, boundaryAreaHa]);
  // Honesty label for the generated report's "Plot area" line and, by
  // extension, every per-hectare figure that divides by it — plainly
  // states whether plotAreaHa came from a measured boundary, a bbox
  // guess, or a manual entry (autoPlotArea off).
  const plotAreaBasis = useMemo<'boundary' | 'bbox' | 'manual'>(() => {
    if (!autoPlotArea) return 'manual';
    return boundaryAreaHa !== null ? 'boundary' : 'bbox';
  }, [autoPlotArea, boundaryAreaHa]);

  // ---- Trigger a density compute on demand ----
  const runDensity = useCallback(async () => {
    if (!desktop?.octreeDensityMetrics || !octree?.dir) return;
    setBusy(true); setError(null);
    let unlisten: (() => void) | undefined;
    try {
      if (desktop.onOctreeProgress) {
        unlisten = await Promise.resolve(desktop.onOctreeProgress(() => {})) as (() => void);
      }
      const d = await desktop.octreeDensityMetrics(octree.dir, 2.0, {
        minHeight: 0.2, canopyThreshold: 2.0,
      });
      setDensity(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      unlisten?.();
      setBusy(false);
    }
  }, [desktop, octree?.dir]);

  // Species-aware biomass, computed exactly like the Metrics module:
  // each QSM tree uses its own species.json assignment, falling back to
  // fallbackSpeciesKey when unassigned. Undefined qsm ⇒ null, same
  // "requires QSM" gate the rest of the report already uses.
  const speciesBiomass = useMemo(() => {
    if (!qsm || qsm.trees.length === 0) return null;
    return computeSpeciesAwareBiomass(qsm.trees, speciesByTree, fallbackSpeciesKey, biomassSettings.params);
  }, [qsm, speciesByTree, fallbackSpeciesKey, biomassSettings.params]);
  const biomassTotals = useMemo(() => {
    if (!speciesBiomass) return null;
    return computeBiomassTotals([...speciesBiomass.byTree.values()]);
  }, [speciesBiomass]);
  // Per-species tree counts behind the totals — the fallback count is
  // tracked separately by computeSpeciesAwareBiomass above.
  const speciesMix = useMemo(() => {
    if (!qsm) return [] as { label: string; treeCount: number }[];
    const counts = new Map<string, number>();
    for (const t of qsm.trees) {
      const key = speciesByTree.get(t.treeId);
      if (key === undefined) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([key, treeCount]) => ({ label: SPECIES_DENSITIES.find(s => s.key === key)?.label ?? key, treeCount }))
      .sort((a, b) => b.treeCount - a.treeCount);
  }, [qsm, speciesByTree]);
  // The report's biomass input — species mix + fallback count instead of
  // a single plot-wide species, so a mostly-unassigned plot can't read
  // as a clean species-aware result.
  const biomassInput = useMemo(() => {
    if (!speciesBiomass || !biomassTotals) return undefined;
    return {
      speciesMix,
      fallbackCount: speciesBiomass.fallbackCount,
      fallbackLabel: fallbackDensityLabel(biomassSettings).label,
      // What the tonnes were actually computed with. The density is the
      // largest single assumption under a carbon figure and a reader
      // cannot check the number without it.
      fallbackDensity: fallbackDensityLabel(biomassSettings).density,
      // Only when the density came from a bundled preset. A custom
      // figure has no published source, and the report must not invent
      // one for it.
      fallbackSource: SPECIES_DENSITIES.find(x => x.key === fallbackSpeciesKey)?.source,
      biomassKg: biomassTotals.biomass,
      biomassKgCi95: 1.96 * biomassTotals.biomassStd,
      carbonKg: biomassTotals.carbon,
      carbonKgCi95: 1.96 * biomassTotals.carbonStd,
      co2eKg: biomassTotals.co2e,
      co2eKgCi95: 1.96 * biomassTotals.co2eStd,
    };
  }, [speciesBiomass, biomassTotals, speciesMix, biomassSettings]);

  // ---- Section availability checks ----
  const have = useMemo(() => ({
    metrics: (metrics?.length ?? 0) > 0,
    qsm: (qsm?.trees.length ?? 0) > 0,
    density: density !== null,
    biomass: biomassInput !== undefined,
    validation: validationSummary !== null,
    growth: growthSummary !== null,
    m3c2: m3c2Summary !== null,
    taper: (taperMeasurements?.length ?? 0) > 0,
  }), [metrics, qsm, density, biomassInput, validationSummary, growthSummary, m3c2Summary, taperMeasurements]);

  // ---- Generate + download ----
  const generate = useCallback(() => {
    if (!metrics || metrics.length === 0) {
      setError('No per-tree metrics yet. Compute them in the Metrics module first.');
      return;
    }
    const html = generateReportHtml({
      projectName: projectName || octree?.meta.name || 'PointCloudLabeler plot',
      description: description || undefined,
      plotAreaHa: plotAreaHa ?? autoPlotAreaValue ?? 0.04,
      plotAreaBasis,
      crsLabel: octree?.meta?.scannerType,
      metrics,
      qsm,
      density,
      bucking: { unitPrice, currency },
      biomass: biomassInput,
      // Hand-off summaries from the panels that computed them — null when
      // that analysis hasn't been run, which the generator renders as "no
      // block" rather than a stale or guessed number.
      fieldValidation: validationSummary ?? undefined,
      growth: growthSummary ?? undefined,
      m3c2: m3c2Summary ?? undefined,
      taper: taperMeasurements ?? undefined,
    });
    const safe = (projectName || 'pointcloudlabeler-plot').replace(/[\\/:*?"<>|]+/g, '_');
    void saveTextFile(html, `${safe}-report.html`, 'text/html;charset=utf-8');
  }, [metrics, qsm, density, projectName, description, plotAreaHa, autoPlotAreaValue, plotAreaBasis,
      biomassInput, unitPrice, octree, validationSummary, growthSummary, m3c2Summary, taperMeasurements]);

  const openPreview = useCallback(() => {
    if (!metrics) return;
    const html = generateReportHtml({
      projectName: projectName || octree?.meta.name || 'PointCloudLabeler plot',
      description: description || undefined,
      plotAreaHa: plotAreaHa ?? autoPlotAreaValue ?? 0.04,
      plotAreaBasis,
      crsLabel: octree?.meta?.scannerType,
      metrics,
      qsm,
      density,
      bucking: { unitPrice, currency },
      biomass: biomassInput,
      fieldValidation: validationSummary ?? undefined,
      growth: growthSummary ?? undefined,
      m3c2: m3c2Summary ?? undefined,
      taper: taperMeasurements ?? undefined,
    });
    // Use a Blob URL so the preview window can also be printed → PDF.
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    // Don't revoke immediately; the new tab still needs it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, [metrics, qsm, density, projectName, description, plotAreaHa, autoPlotAreaValue, plotAreaBasis,
      biomassInput, unitPrice, octree, validationSummary, growthSummary, m3c2Summary, taperMeasurements]);

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 440 }}>
      {loading && (
        <div className="mono text-[10px] px-1 py-0.5 rounded-sm" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)' }}>
          Gathering analytics — streaming the cloud…
        </div>
      )}
      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      {/* Project header inputs */}
      <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>Project name</label>
          <input
            type="text"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            className="bg-transparent mono text-[10.5px] px-1.5 py-0.5 flex-1"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
          />
        </div>
        <div className="flex items-start gap-1.5">
          <label className="mono text-[10px] w-[110px] pt-1" style={{ color: 'var(--text-dim)' }}>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Optional — one or two short lines (e.g. plot location, sampling date)"
            className="bg-transparent mono text-[10.5px] px-1.5 py-0.5 flex-1 resize-none"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>Plot area (ha)</label>
          <input
            type="number" step={0.001} min={0.001}
            disabled={autoPlotArea}
            value={plotAreaHa?.toFixed(3) ?? ''}
            onChange={(e) => setPlotAreaHa(parseFloat(e.target.value) || 0.01)}
            className="bg-transparent mono text-[10.5px] px-1 py-0.5 w-[80px]"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
          />
          <label className="mono text-[10px] flex items-center gap-1" style={{ color: 'var(--text-dim)', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoPlotArea} onChange={() => setAutoPlotArea(a => !a)} /> auto
          </label>
          <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
            {plotAreaBasis === 'boundary' ? '(defined plot boundary)' : plotAreaBasis === 'manual' ? '(manual override)' : '(estimated — tree bbox)'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>Fallback species</label>
          <select
            className="bg-transparent mono text-[10.5px] flex-1 px-1 py-0.5"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
            value={fallbackSpeciesKey}
            onChange={(e) => setFallbackSpeciesKey(e.target.value)}
          >
            {SPECIES_DENSITIES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            {/* Present so a custom density set in the Metrics module has
                somewhere to show. Without it the select falls back to
                its first option and the panel silently claims Scots pine
                over a stand of eucalyptus. */}
            <option value={CUSTOM_SPECIES_KEY}>Custom density (set in Metrics)</option>
          </select>
        </div>
        <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', paddingLeft: 118 }}>
          {fallbackDensityLabel(biomassSettings).density} kg/m³ basic density, carbon fraction{' '}
          {biomassSettings.params.carbonFraction}. Used only for trees with no species assignment —
          set per-tree species in Tree Review, and the density itself in the Metrics module.
        </div>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>Unit price ({currency}/m³)</label>
          <input
            type="number" step={1} min={0}
            value={unitPrice}
            onChange={(e) => setUnitPrice(parseFloat(e.target.value) || 0)}
            className="bg-transparent mono text-[10.5px] px-1 py-0.5 w-[80px]"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
          />
          <input
            type="text"
            maxLength={MAX_CURRENCY_LEN}
            value={currency}
            onChange={(e) => setCurrencyState(e.target.value)}
            onBlur={(e) => setCurrencyState(setCurrency(e.target.value))}
            className="bg-transparent mono text-[10.5px] px-1 py-0.5 w-[52px] text-center"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
            title="Symbol or code the report's revenue figures are in. Shared with the Bucking and Thinning panels."
          />
          <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>(mixed-grade headline only — Bucking panel has the breakdown)</span>
        </div>
      </div>

      {/* Section availability */}
      <div className="rounded-md p-2 flex flex-col gap-1" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Report sections</div>
        <SectionStatus label="Per-tree metrics" available={have.metrics} hint={have.metrics ? `${metrics!.length} trees` : 'Compute in Metrics module first'} />
        <SectionStatus label="QSM volume + uncertainty" available={have.qsm} hint={have.qsm ? `${qsm!.trees.length} fitted` : 'Run QSM in Metrics module'} />
        <SectionStatus
          label="Biomass + carbon"
          available={have.qsm && have.biomass}
          hint={!have.qsm
            ? '(requires QSM)'
            : speciesBiomass
              ? `${speciesMix.length} species · ${speciesBiomass.fallbackCount} fallback`
              : undefined}
        />
        <SectionStatus label="Density metrics" available={have.density} hint={have.density ? `${density!.cols}×${density!.rows} grid` : 'Run density panel — or generate one here'} />
        {!have.density && (
          <button
            className="btn !h-6 !px-2 mono text-[10px] self-start mt-1"
            disabled={busy || !octree?.dir}
            onClick={() => void runDensity()}
          >
            {busy ? 'Computing density…' : 'Run density now (DTM required)'}
          </button>
        )}
        <SectionStatus label="Field-data validation" available={have.validation} hint={have.validation ? `n=${validationSummary!.nMatched} matched` : 'Run the Field validation panel'} />
        <SectionStatus label="Tree growth (epoch change)" available={have.growth} hint={have.growth ? `${growthSummary!.nMatched} matched stems` : 'Run the Tree growth panel'} />
        <SectionStatus label="M3C2 surface change" available={have.m3c2} hint={have.m3c2 ? `vs. ${m3c2Summary!.referenceName}` : 'Run the M3C2 panel'} />
        <SectionStatus label="Stem taper" available={have.taper} hint={have.taper ? `${taperMeasurements!.length} stem${taperMeasurements!.length === 1 ? '' : 's'} measured` : 'Run the Stem taper panel'} />
      </div>

      {/* Generate */}
      <div className="flex items-center gap-1.5 pt-1">
        <button
          className="btn !h-7 mono text-[11px] flex-1 justify-center"
          disabled={!have.metrics || loading}
          onClick={generate}
          title="Download a single self-contained .html file — print → PDF from the browser if you need PDF"
        >
          Download report
        </button>
        <button
          className="btn !h-7 mono text-[11px] flex-1 justify-center"
          disabled={!have.metrics || loading}
          onClick={openPreview}
          title="Open the report in a new browser tab"
        >
          Open preview
        </button>
        <button
          className="btn !h-7 !px-2 mono text-[11px]"
          disabled={loading}
          onClick={() => void refresh()}
          title="Reload the analytics caches"
        >
          ↻
        </button>
      </div>

      <div className="mono text-[9.5px] px-1.5 py-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        The report is a single self-contained .html file — every chart is an inline SVG, no external assets. Open it in any browser; print to PDF if a paper deliverable is needed. Missing sections (no QSM, no field validation, no density) just don't render; the file still works.
      </div>
    </div>
  );
}

function SectionStatus({ label, available, hint }: { label: string; available: boolean; hint?: string }) {
  return (
    <div className="flex items-center gap-2 mono text-[10.5px]">
      <span style={{ color: available ? '#67d391' : 'var(--text-mute)', width: 12 }}>{available ? '●' : '○'}</span>
      <span style={{ color: 'var(--text)', minWidth: 180 }}>{label}</span>
      {hint && <span style={{ color: 'var(--text-mute)', fontSize: 9.5 }}>{hint}</span>}
    </div>
  );
}
