// Metrics module — native per-tree forestry metrics over the project's
// octree datasets. Pick a dataset, tune the parameters, compute, and the
// table fills with height / DBH / basal area / crown area + diameter for
// every segmented tree, plus summary cards and a CSV export. Styled to
// match the editor shell (glass panels, chip labels, accent, mono nums).
//
// This replaces the legacy in-memory plugin runner: metrics now come from
// the same out-of-core octree the editor works on, so they reflect the
// classification + segmentation + edits already done there.

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { cancelStage, canCancel } from '../ui/cancelStage';
import { useProject } from '../context/ProjectContext';
import { mergeStemFits } from '../metrics/plotStats';
import { loadStemFits } from '../metrics/loadMetrics';
import { listOctrees, type OctreeListEntry, type TreeMetric, type StemFit, type QsmResult, type TreeQsm } from '../persistence/octreeReader';
import TreeTaperSparkline from '../components/metrics/TreeTaperSparkline';
import {
  SPECIES_DENSITIES, type BiomassParams,
  computeSpeciesAwareBiomass, computeBiomassTotals,
} from '../metrics/biomass';
import { loadBiomassSettings, saveBiomassSettings, withFallbackSpecies } from '../metrics/biomassSettings';
import { onOctreeProgress } from '../persistence/octreeStore';
import { DEFAULT_METRIC_PARAMS } from '../metrics/params';
import { treeIdColor } from '../three/palette';
import { csvNum, csvText } from '../io/csv';
import { mean as statMean } from '../metrics/stats';
import { TQSM_COLUMNS, tqsmRow } from '../metrics/qsmAttributesCsv';

interface Desktop {
  octreeTreeMetrics?: (dir: string, params: { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number }) => Promise<TreeMetric[]>;
  octreeFitStems?: (dir: string, params: { bandLow: number; bandHigh: number; inlierTol: number; iterations: number; minInliers: number; writeSemantic: boolean; dtmCell: number }) => Promise<StemFit[]>;
  octreeTreeQsm?: (dir: string, params: { sliceHeight: number; minPointsPerSlice: number; minTreeHeight: number; dtmCell: number; enableBranches?: boolean; branchMethod?: 'simple' | 'treeqsm'; branchVoxel?: number }) => Promise<QsmResult>;
  octreeReadQsm?: (dir: string) => Promise<QsmResult | null>;
  octreeReadSpecies?: (dir: string) => Promise<string>;
  saveCsvDialog?: (name: string) => Promise<string | null>;
  writeFile?: (path: string, content: string) => Promise<boolean>;
}

interface StemParams { bandLow: number; bandHigh: number; inlierTol: number; iterations: number; minInliers: number; writeSemantic: boolean }
const DEFAULT_STEM: StemParams = { bandLow: 1.0, bandHigh: 3.0, inlierTol: 0.03, iterations: 600, minInliers: 12, writeSemantic: false };

type SortKey = 'treeId' | 'height' | 'dbh' | 'basalArea' | 'crownArea' | 'crownDiameter' | 'count';

interface Params { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number }
const DEFAULT_PARAMS: Params = DEFAULT_METRIC_PARAMS;

export default function MetricsModule() {
  const { project, activeModule } = useProject();
  const shown = activeModule === 'metrics';
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  const [list, setList] = useState<OctreeListEntry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [rows, setRows] = useState<TreeMetric[] | null>(null);
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'treeId', dir: 1 });

  // RANSAC stem fit — refines DBH + (optionally) labels stem points. Keyed
  // by tree_id so it merges onto the metrics rows.
  const [stemParams, setStemParams] = useState<StemParams>(DEFAULT_STEM);
  const [stems, setStems] = useState<Map<number, StemFit> | null>(null);
  const [fitting, setFitting] = useState(false);
  const [fitPct, setFitPct] = useState(0);

  // Stem QSM — taper as a cylinder stack + stem volume + occlusion-aware
  // confidence per tree. Cached qsm.json on disk so reopens skip the
  // recompute. Keyed by tree_id like the stem fit map.
  const [qsmSliceHeight, setQsmSliceHeight] = useState(0.25);
  const [qsmMinPoints, setQsmMinPoints] = useState(15);
  const [qsmMinHeight, setQsmMinHeight] = useState(3.0);
  const [qsmEnableBranches, setQsmEnableBranches] = useState(false);
  const [qsmBranchMethod, setQsmBranchMethod] = useState<'simple' | 'treeqsm'>('simple');
  const [qsmBranchVoxel, setQsmBranchVoxel] = useState(0.10);
  const [qsm, setQsm] = useState<Map<number, TreeQsm> | null>(null);
  const [qsmTotal, setQsmTotal] = useState<number | null>(null);
  const [qsmTotalStd, setQsmTotalStd] = useState<number | null>(null);
  const [qsmRunning, setQsmRunning] = useState(false);
  const [qsmPct, setQsmPct] = useState(0);
  // Which tree's taper sparkline is expanded inline in the table.
  // Toggles via row click when QSM data exists for that tree.
  const [expandedTaperId, setExpandedTaperId] = useState<number | null>(null);

  // Biomass + carbon. Derived live from the QSM volumes + the wood
  // density / carbon-fraction params below — no recompute on the
  // Rust side, so editing density updates every number instantly.
  // Per-tree species (species.json, written by Tree Review — read-only
  // here) drives each tree's own density; fallbackSpeciesKey is only
  // used for trees with no assignment.
  const [speciesByTree, setSpeciesByTree] = useState<Map<number, string>>(() => new Map());
  //
  // Both live in metrics/biomassSettings.ts rather than in this
  // component, because the Report panel needs the SAME numbers: it used
  // to pass DEFAULT_BIOMASS_PARAMS regardless of what was set here, so
  // a stand whose species has no preset — anywhere outside the boreal
  // zone — got one tonnage in this table and a different one in the
  // client's report, with neither screen saying which density it used.
  const [fallbackSpeciesKey, setFallbackSpeciesKey] =
    useState<string>(() => loadBiomassSettings().fallbackSpeciesKey);
  const [biomassParams, setBiomassParams] =
    useState<BiomassParams>(() => loadBiomassSettings().params);
  useEffect(() => {
    saveBiomassSettings({ fallbackSpeciesKey, params: biomassParams });
  }, [fallbackSpeciesKey, biomassParams]);

  const canRun = !!desktop?.octreeTreeMetrics && !!dir;

  // The list is taken each time this module is shown, not only when the
  // project changes: the module stays mounted behind its tab while the
  // Editor imports, subsets and shifts datasets, and a list taken when a
  // new project was still empty would otherwise stay empty.
  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    (async () => {
      if (!project?.folder) { setList([]); return; }
      try {
        const ls = await listOctrees(project.folder);
        if (cancelled) return;
        setList(ls);
        setListError(null);
        setDir(prev => (prev && ls.some(l => l.dir === prev)) ? prev : (ls[0]?.dir ?? null));
      } catch (e) {
        // "No datasets" and "couldn't read the datasets" look identical
        // as an empty list, and the second is what a permissions problem
        // or a damaged project folder produces. Say which.
        if (!cancelled) { setList([]); setListError(e instanceof Error ? e.message : String(e)); }
      }
    })();
    return () => { cancelled = true; };
  }, [project?.folder, shown]);

  // A new dataset invalidates the table.
  useEffect(() => { setRows(null); setError(null); setStatus(null); setStems(null); }, [dir]);

  // …and then picks up whatever stem fit was already run on it. The fits
  // are persisted next to the dataset (stems.json), so every panel reads
  // the same refined diameters; this table has to start from the same
  // place or it would be the one screen disagreeing — the mirror of the
  // problem that made them shared.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fits = await loadStemFits(desktop, dir ?? '');
      if (!cancelled && fits) setStems(fits);
    })();
    return () => { cancelled = true; };
  }, [desktop, dir]);

  const set = (patch: Partial<Params>) => setParams(p => ({ ...p, ...patch }));
  const setStem = (patch: Partial<StemParams>) => setStemParams(p => ({ ...p, ...patch }));

  // Merge the RANSAC stem fit onto the metrics rows: where a fit succeeded
  // its DBH (and the derived basal area) override the algebraic estimate.
  const mergedRows = useMemo<TreeMetric[] | null>(() => {
    if (!rows) return null;
    if (!stems) return rows;
    return mergeStemFits(rows, stems);
  }, [rows, stems]);

  const runFit = useCallback(async () => {
    if (!desktop?.octreeFitStems || !dir) return;
    setFitting(true); setFitPct(0); setError(null); setStatus(null);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onOctreeProgress((stage, p) => { if (stage === 'stemfit') setFitPct(p); });
      const res = await desktop.octreeFitStems(dir, { ...stemParams, dtmCell: params.dtmCell });
      const map = new Map<number, StemFit>(res.map(f => [f.treeId, f]));
      setStems(map);
      const ok = res.filter(f => Number.isFinite(f.dbh)).length;
      const wrote = res.reduce((a, f) => a + f.writtenStemPoints, 0);
      setStatus(`${ok}/${res.length} stems fit${stemParams.writeSemantic ? ` · ${wrote.toLocaleString()} stem points labelled` : ''}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      unlisten?.();
      setFitting(false); setFitPct(0);
    }
  }, [desktop, dir, stemParams, params.dtmCell]);

  const runQsm = useCallback(async () => {
    if (!desktop?.octreeTreeQsm || !dir) return;
    setQsmRunning(true); setQsmPct(0); setError(null); setStatus(null);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onOctreeProgress((stage, p) => { if (stage === 'qsm') setQsmPct(p); });
      const res = await desktop.octreeTreeQsm(dir, {
        sliceHeight: qsmSliceHeight,
        minPointsPerSlice: qsmMinPoints,
        minTreeHeight: qsmMinHeight,
        dtmCell: params.dtmCell,
        enableBranches: qsmEnableBranches,
        branchMethod: qsmBranchMethod,
        branchVoxel: qsmBranchVoxel,
      });
      setQsm(new Map(res.trees.map(t => [t.treeId, t])));
      setQsmTotal(res.totalStemVolume);
      setQsmTotalStd(res.totalStemVolumeStd);
      const ci = res.totalStemVolumeStd > 0 ? ` ± ${(1.96 * res.totalStemVolumeStd).toFixed(3)}` : '';
      setStatus(`QSM: ${res.trees.length} trees · Σ stem volume ${res.totalStemVolume.toFixed(3)}${ci} m³`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      unlisten?.();
      setQsmRunning(false); setQsmPct(0);
    }
  }, [desktop, dir, qsmSliceHeight, qsmMinPoints, qsmMinHeight, qsmEnableBranches, qsmBranchMethod, qsmBranchVoxel, params.dtmCell]);

  // Re-load the cached QSM whenever the dataset changes — survives a
  // PointCloudLabeler reload without re-running the streaming fit.
  useEffect(() => {
    let cancelled = false;
    setQsm(null); setQsmTotal(null); setQsmTotalStd(null);
    if (!desktop?.octreeReadQsm || !dir) return;
    (async () => {
      try {
        const res = await desktop.octreeReadQsm!(dir);
        if (cancelled || !res) return;
        setQsm(new Map(res.trees.map(t => [t.treeId, t])));
        setQsmTotal(res.totalStemVolume);
        setQsmTotalStd(res.totalStemVolumeStd);
      } catch { /* silent — no cached qsm.json yet */ }
    })();
    return () => { cancelled = true; };
  }, [desktop, dir]);

  // Re-load species.json whenever the dataset changes — the per-tree
  // assignment Tree Review writes. Read-only here: this module never
  // writes species.json, it only consumes it for the biomass maths.
  useEffect(() => {
    let cancelled = false;
    setSpeciesByTree(new Map());
    if (!desktop?.octreeReadSpecies || !dir) return;
    (async () => {
      try {
        const raw = await desktop.octreeReadSpecies!(dir);
        if (cancelled) return;
        const obj = JSON.parse(raw) as Record<string, string>;
        const m = new Map<number, string>();
        for (const [k, v] of Object.entries(obj)) {
          const id = parseInt(k, 10);
          if (Number.isFinite(id) && typeof v === 'string' && v) m.set(id, v);
        }
        setSpeciesByTree(m);
      } catch { /* absent / corrupt → empty, every tree falls back */ }
    })();
    return () => { cancelled = true; };
  }, [desktop, dir]);

  const run = useCallback(async () => {
    if (!desktop?.octreeTreeMetrics || !dir) return;
    setRunning(true); setPct(0); setError(null); setStatus(null);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onOctreeProgress((stage, p) => { if (stage === 'metrics') setPct(p); });
      const res = await desktop.octreeTreeMetrics(dir, params);
      setRows(res);
      // The stem fit is NOT dropped here. It is keyed by tree id, which a
      // re-measure does not change — only re-segmentation does — and the
      // fit has its own band, so re-measuring over a different
      // breast-height band leaves it just as valid as it was. Clearing it
      // silently reverted the table to the algebraic diameter while
      // stems.json on disk kept every other panel on the refined one.
      setStatus(`${res.length.toLocaleString()} trees measured`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows(null);
    } finally {
      unlisten?.();
      setRunning(false); setPct(0);
    }
  }, [desktop, dir, params]);

  // True when at least one tree's QSM has a branch fit, so the table
  // can show the Branch/Total columns conditionally (and old runs
  // without branches don't get empty columns).
  const hasBranches = useMemo(() => {
    if (!qsm) return false;
    for (const t of qsm.values()) if ((t.branchCount ?? 0) > 0) return true;
    return false;
  }, [qsm]);

  // True when at least one tree carries the ported TreeQSM's own
  // attributes, which only the "treeqsm" branch method produces. The
  // export adds its block of columns only then, so a run made with
  // another method does not get twenty-six empty ones.
  const hasTreeqsm = useMemo(() => {
    if (!qsm) return false;
    for (const t of qsm.values()) if (t.treeqsm) return true;
    return false;
  }, [qsm]);

  // Per-tree biomass + carbon, keyed by tree_id, recomputed whenever the
  // QSM, the species assignment, or the density / carbon params change.
  // Each tree uses ITS OWN species' density (falling back to
  // fallbackSpeciesKey when unassigned) — computeSpeciesAwareBiomass
  // also reports how many trees that was, so the totals below can never
  // quietly present a mostly-fallback plot as a species-aware result.
  const speciesBiomass = useMemo(() => {
    if (!qsm) return null;
    return computeSpeciesAwareBiomass([...qsm.values()], speciesByTree, fallbackSpeciesKey, biomassParams);
  }, [qsm, speciesByTree, fallbackSpeciesKey, biomassParams]);
  const biomass = speciesBiomass?.byTree ?? null;

  const biomassTotals = useMemo(() => {
    if (!biomass) return null;
    return computeBiomassTotals([...biomass.values()]);
  }, [biomass]);

  // Species mix over the QSM-fitted trees that DO carry an assignment
  // (the fallback count is tracked separately by computeSpeciesAwareBiomass
  // above) — count per species, richest first.
  const speciesMix = useMemo(() => {
    if (!qsm) return [] as { key: string; label: string; count: number }[];
    const counts = new Map<string, number>();
    for (const t of qsm.values()) {
      const key = speciesByTree.get(t.treeId);
      if (key === undefined) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([key, count]) => ({ key, label: SPECIES_DENSITIES.find(s => s.key === key)?.label ?? key, count }))
      .sort((a, b) => b.count - a.count);
  }, [qsm, speciesByTree]);

  // Apply a species preset to the FALLBACK slot → density + carbon
  // fraction (keeps the branch-uncertainty fraction the user may have
  // tuned). Only trees with no explicit assignment in Tree Review use
  // this — everything else uses its own species regardless of this
  // setting.
  // withFallbackSpecies, not a local copy of the same three assignments:
  // the Report panel offers this identical picker, and when each kept
  // its own version of "what changes when you pick a species" they drifted
  // — one carrying the preset's density and the other not carrying
  // anything at all.
  const applyFallbackSpecies = (key: string) => {
    const next = withFallbackSpecies({ fallbackSpeciesKey, params: biomassParams }, key);
    setFallbackSpeciesKey(next.fallbackSpeciesKey);
    setBiomassParams(next.params);
  };

  const sorted = useMemo(() => {
    if (!mergedRows) return null;
    const copy = [...mergedRows];
    const { key, dir: d } = sort;
    copy.sort((a, b) => {
      const av = a[key], bv = b[key];
      // NaN (unfittable DBH) sinks to the bottom regardless of direction.
      const an = Number.isNaN(av), bn = Number.isNaN(bv);
      if (an && bn) return a.treeId - b.treeId;
      if (an) return 1;
      if (bn) return -1;
      return (av - bv) * d;
    });
    return copy;
  }, [mergedRows, sort]);

  // Summary stats over the measured trees (DBH means skip unfittable ones).
  const summary = useMemo(() => {
    if (!mergedRows || mergedRows.length === 0) return null;
    const n = mergedRows.length;
    // The shared statistic over a projection of the rows. Named apart
    // from it because it takes a selector, not an array — a `mean` that
    // means something else in one file is how the codebase ended up with
    // several, two of which had stopped dropping the values that were
    // never measured.
    const meanOf = (sel: (t: TreeMetric) => number) => statMean(mergedRows.map(sel));
    const sum = (sel: (t: TreeMetric) => number) => mergedRows.reduce((a, t) => a + (Number.isFinite(sel(t)) ? sel(t) : 0), 0);
    const withDbh = mergedRows.filter(t => Number.isFinite(t.dbh)).length;
    return {
      n,
      meanHeight: meanOf(t => t.height),
      meanDbh: meanOf(t => t.dbh),
      meanCrown: meanOf(t => t.crownDiameter),
      totalBasal: sum(t => t.basalArea),
      withDbh,
    };
  }, [mergedRows]);

  const toggleSort = (key: SortKey) =>
    setSort(s => s.key === key ? { key, dir: (s.dir === 1 ? -1 : 1) } : { key, dir: key === 'treeId' ? 1 : -1 });

  const exportCsv = useCallback(async () => {
    if (!sorted || sorted.length === 0 || !desktop?.saveCsvDialog || !desktop?.writeFile) return;
    const name = (list.find(l => l.dir === dir)?.name ?? 'metrics').replace(/[\\/:*?"<>|]+/g, '_');
    const path = await desktop.saveCsvDialog(`${name}_tree_metrics.csv`);
    if (!path) return;
    const baseHeader = ['tree_id', 'points', 'height_m', 'dbh_m', 'dbh_method', 'basal_area_m2', 'crown_area_m2', 'crown_diameter_m', 'stem_inliers', 'stem_rmse_m', 'base_x', 'base_y', 'base_z', 'lean_deg'];
    const qsmHeader = qsm
      ? [
          'qsm_stem_volume_m3', 'qsm_stem_volume_std_m3', 'qsm_stem_volume_ci95_m3',
          ...(hasBranches ? ['qsm_branch_volume_m3', 'qsm_branch_count', 'qsm_total_volume_m3'] : []),
          'qsm_confidence', 'qsm_completeness', 'qsm_accepted_slices', 'qsm_rejected_slices',
          'biomass_kg', 'biomass_ci95_kg', 'carbon_kg', 'carbon_ci95_kg', 'co2e_kg', 'co2e_ci95_kg',
        ]
      : [];
    // TreeQSM's own table, appended so the columns above keep their
    // positions. The names and the cells live together in
    // metrics/qsmAttributesCsv so they cannot drift apart.
    const tqsmHeader = hasTreeqsm ? [...TQSM_COLUMNS] : [];
    const lines = [[...baseHeader, ...qsmHeader, ...tqsmHeader].join(',')];
    for (const t of sorted) {
      const f = stems?.get(t.treeId);
      const refined = f && Number.isFinite(f.dbh);
      const base = [
        t.treeId, t.count,
        csvNum(t.height, 2), csvNum(t.dbh, 3), refined ? 'ransac' : 'algebraic', csvNum(t.basalArea, 4),
        csvNum(t.crownArea, 2), csvNum(t.crownDiameter, 2),
        refined ? f!.inlierCount : '', refined ? csvNum(f!.rmse, 4) : '',
        csvNum(t.x, 3), csvNum(t.y, 3), csvNum(t.baseZ, 3), csvNum(t.leanDeg, 1),
      ];
      if (qsm) {
        const q = qsm.get(t.treeId);
        base.push(
          q ? csvNum(q.stemVolume, 4) : '',
          q ? csvNum(q.stemVolumeStd, 5) : '',
          q ? csvNum(q.stemVolumeCi95, 5) : '',
        );
        if (hasBranches) {
          base.push(
            q ? csvNum(q.branchVolume, 4) : '',
            q ? q.branchCount : '',
            q ? csvNum(q.totalVolume, 4) : '',
          );
        }
        base.push(
          q ? csvNum(q.confidence, 3) : '',
          q ? csvNum(q.completeness, 3) : '',
          q ? q.acceptedSlices : '',
          q ? q.rejectedSlices : '',
        );
        const bm = biomass?.get(t.treeId);
        base.push(
          bm ? csvNum(bm.biomass, 2) : '',
          bm ? csvNum(1.96 * bm.biomassStd, 2) : '',
          bm ? csvNum(bm.carbon, 2) : '',
          bm ? csvNum(1.96 * bm.carbonStd, 2) : '',
          bm ? csvNum(bm.co2e, 2) : '',
          bm ? csvNum(1.96 * bm.co2eStd, 2) : '',
        );
      }
      if (hasTreeqsm) {
        base.push(...tqsmRow(qsm?.get(t.treeId)?.treeqsm));
      }
      lines.push(base.join(','));
    }
    try {
      await desktop.writeFile(path, csvText(lines));
      setStatus(`exported ${sorted.length.toLocaleString()} rows → ${path}`);
    } catch (e) {
      setError(`CSV export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [sorted, desktop, list, dir, stems, qsm, hasBranches, hasTreeqsm, biomass]);

  if (!project) {
    return (
      <Page>
        <div className="flex-1 flex items-center justify-center mono text-[12px]" style={{ color: 'var(--text-mute)' }}>
          Open a project to compute metrics.
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <div className="flex flex-1 min-h-0">
        {/* Left rail — dataset + parameters + run. */}
        <aside className="shrink-0 flex flex-col gap-4 p-4 overflow-y-auto scroll-thin hairline-r" style={{ width: 296, background: 'var(--wash-1)' }}>
          <div className="flex items-center gap-2">
            <div className="rounded-md flex items-center justify-center" style={{ width: 28, height: 28, background: 'color-mix(in oklch, var(--accent) 18%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)' }}>
              <MetricsIcon />
            </div>
            <div>
              <div className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>Per-tree metrics</div>
              <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>height · DBH · basal · crown</div>
            </div>
          </div>

          <Field label="Dataset">
            {list.length === 0 ? (
              listError
                ? <div className="mono text-[10.5px]" style={{ color: '#e0506b' }}>Could not read this project's datasets: {listError}</div>
                : <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>No datasets in this project yet.</div>
            ) : (
              <select
                value={dir ?? ''}
                onChange={(e) => setDir(e.target.value || null)}
                className="w-full px-2.5 py-2 mono text-[12px] rounded-md outline-none"
                style={inputStyle}
              >
                {list.map(l => (
                  <option key={l.dir} value={l.dir}>{l.name} · {formatPts(l.pointCount)} pts</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Parameters">
            <div className="flex flex-col gap-2.5">
              <Num label="Crown cell" unit="m" value={params.crownCell} min={0.1} step={0.05} onChange={(v) => set({ crownCell: v })} hint="Crown footprint resolution." />
              <Num label="DTM cell" unit="m" value={params.dtmCell} min={0.1} step={0.05} onChange={(v) => set({ dtmCell: v })} hint="Ground resolution (height is above this)." />
              <div className="flex items-end gap-2">
                <Num label="Breast band" unit="m" value={params.bhLow} min={0.1} step={0.1} onChange={(v) => set({ bhLow: v })} compact />
                <span className="mono text-[11px] pb-1.5" style={{ color: 'var(--text-mute)' }}>…</span>
                <Num label="" unit="m" value={params.bhHigh} min={0.2} step={0.1} onChange={(v) => set({ bhHigh: v })} compact />
              </div>
              <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>DBH is fit to stem points in this height band around 1.3 m.</div>
            </div>
          </Field>

          <div className="flex gap-1.5">
            <button
              className="btn btn-primary !h-9 flex-1 justify-center mono text-[12px]"
              disabled={!canRun || running}
              onClick={run}
              title="Compute metrics for every segmented tree"
            >
              {running ? `Computing… ${Math.round(pct * 100)}%` : 'Compute metrics'}
            </button>
            {running && (
              <button className="btn !h-9 mono text-[11px] !px-3" onClick={() => cancelStage('metrics')} disabled={!canCancel()}
                title="Stop the measurement — nothing is written">Cancel</button>
            )}
          </div>
          {running && (
            <div className="w-full rounded-full overflow-hidden -mt-2" style={{ height: 4, background: 'var(--wash-3)' }}>
              <div style={{ width: `${Math.round(pct * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
            </div>
          )}
          {!canRun && !running && (
            <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              Metrics need the desktop build and a dataset with ground classified + trees segmented.
            </div>
          )}

          {/* RANSAC stem fit — refines DBH + optionally labels stem points.
              Enriches the table after metrics are computed. */}
          <div className="pt-1" style={{ borderTop: '1px solid var(--line)' }}>
            <details>
              <summary className="chip cursor-pointer" style={{ width: 'fit-content' }}>Stem fit · RANSAC</summary>
              <div className="flex flex-col gap-2.5 mt-2">
                <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
                  Fits a vertical stem cylinder per tree and refines DBH (overrides the algebraic estimate in the table). Compute metrics first.
                </div>
                <div className="flex items-end gap-2">
                  <Num label="Stem band" unit="m" value={stemParams.bandLow} min={0.1} step={0.1} onChange={(v) => setStem({ bandLow: v })} compact />
                  <span className="mono text-[11px] pb-1.5" style={{ color: 'var(--text-mute)' }}>…</span>
                  <Num label="" unit="m" value={stemParams.bandHigh} min={0.5} step={0.1} onChange={(v) => setStem({ bandHigh: v })} compact />
                </div>
                <Num label="Inlier tol." unit="m" value={stemParams.inlierTol} min={0.005} step={0.005} onChange={(v) => setStem({ inlierTol: v })} hint="Radial distance a point can sit from the cylinder." />
                <Num label="Iterations" unit="" value={stemParams.iterations} min={50} step={50} onChange={(v) => setStem({ iterations: Math.round(v) })} hint="RANSAC samples per tree." />
                <Num label="Min inliers" unit="" value={stemParams.minInliers} min={4} step={1} onChange={(v) => setStem({ minInliers: Math.round(v) })} hint="Below this, the tree's DBH stays unfit (—)." />
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <Checkbox checked={stemParams.writeSemantic} onChange={(b) => setStem({ writeSemantic: b })} />
                  <span className="mono text-[10.5px]" style={{ color: 'var(--text)' }}>Label stem points (semantic = stem)</span>
                </label>
                {stemParams.writeSemantic && (
                  <div className="mono text-[8.5px]" style={{ color: '#e0b84a', lineHeight: 1.4 }}>
                    Writes semantic=1 into the dataset on disk. Reopen / reload it in the Editor to see the labels.
                  </div>
                )}
                <div className="flex gap-1.5">
                  <button
                    className="btn !h-8 flex-1 justify-center mono text-[11.5px]"
                    disabled={!desktop?.octreeFitStems || !dir || !rows || fitting || running}
                    onClick={runFit}
                    title="Run RANSAC stem fitting and refine DBH"
                  >
                    {fitting ? `Fitting… ${Math.round(fitPct * 100)}%` : (rows ? 'Refine DBH (RANSAC)' : 'Compute metrics first')}
                  </button>
                  {fitting && (
                    <button className="btn !h-8 mono text-[11px] !px-3" onClick={() => cancelStage('stemfit')} disabled={!canCancel()}
                      title="Stop the fit — stem labels are written only at the end, so a stopped run changes nothing">Cancel</button>
                  )}
                </div>
                {fitting && (
                  <div className="w-full rounded-full overflow-hidden -mt-1.5" style={{ height: 4, background: 'var(--wash-3)' }}>
                    <div style={{ width: `${Math.round(fitPct * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
                  </div>
                )}
              </div>
            </details>
          </div>

          {/* Stem QSM — taper as a cylinder stack + frustum-sum stem
              volume + occlusion-aware confidence per slice. Cached to
              qsm.json so reopens skip the recompute. Branches (full
              TreeQSM) are deferred to v2. */}
          <div className="pt-1" style={{ borderTop: '1px solid var(--line)' }}>
            <details>
              <summary className="chip cursor-pointer" style={{ width: 'fit-content' }}>Stem QSM · taper + volume</summary>
              <div className="flex flex-col gap-2.5 mt-2">
                <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
                  Slices the stem into horizontal bands, fits a circle per band, integrates frustum volumes. Each slice carries an angular coverage (0..1) — the per-tree confidence reflects how completely the stem was seen.
                </div>
                <Num label="Slice height" unit="m" value={qsmSliceHeight} min={0.10} step={0.05} onChange={setQsmSliceHeight} hint="Smaller = finer taper, more sensitive to noise. 0.25 m is the sweet spot for TLS." />
                <Num label="Min points / slice" unit="" value={qsmMinPoints} min={5} step={1} onChange={(v) => setQsmMinPoints(Math.round(v))} hint="Below this, the slice is skipped (counted as rejected)." />
                <Num label="Min tree height" unit="m" value={qsmMinHeight} min={0.5} step={0.5} onChange={setQsmMinHeight} hint="Trees shorter than this are skipped entirely (shrubs / regen)." />
                <label className="flex items-center gap-2 mono text-[10.5px] py-0.5 cursor-pointer select-none" style={{ color: 'var(--text-dim)' }}>
                  <input
                    type="checkbox"
                    checked={qsmEnableBranches}
                    onChange={(e) => setQsmEnableBranches(e.target.checked)}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <span>Fit branches</span>
                </label>
                {qsmEnableBranches && (
                  <>
                    <div className="flex flex-col gap-1">
                      <span className="chip" style={{ width: 'fit-content', margin: 0 }}>Method</span>
                      <label className="flex items-start gap-2 mono text-[10.5px] cursor-pointer select-none" style={{ color: 'var(--text-dim)' }}>
                        <input
                          type="radio"
                          checked={qsmBranchMethod === 'simple'}
                          onChange={() => { setQsmBranchMethod('simple'); setQsmBranchVoxel(0.10); }}
                          style={{ accentColor: 'var(--accent)', marginTop: 2 }}
                        />
                        <div>
                          <div style={{ color: 'var(--text)' }}>Simple (one cylinder / component)</div>
                          <div style={{ color: 'var(--text-mute)', lineHeight: 1.4, fontSize: '0.9em' }}>Fast. No hierarchy.</div>
                        </div>
                      </label>
                      <label className="flex items-start gap-2 mono text-[10.5px] cursor-pointer select-none" style={{ color: 'var(--text-dim)' }}>
                        <input
                          type="radio"
                          checked={qsmBranchMethod === 'treeqsm'}
                          onChange={() => setQsmBranchMethod('treeqsm')}
                          style={{ accentColor: 'var(--accent)', marginTop: 2 }}
                        />
                        <div>
                          <div style={{ color: 'var(--text)' }}>TreeQSM (Raumonen 2013)</div>
                          <div style={{ color: 'var(--text-mute)', lineHeight: 1.4, fontSize: '0.9em' }}>Overlapping-ball cover sets, segment hierarchy, cylinder chains, parent-child + branch order.</div>
                        </div>
                      </label>
                    </div>
                    {qsmBranchMethod === 'treeqsm' ? (
                      <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
                        No cover size to set. TreeQSM does not fit one
                        model — create_input.m sweeps eight, over
                        PatchDiam1 [0.08 0.12], PatchDiam2Min [0.02 0.03]
                        and PatchDiam2Max [0.07 0.10], and select_optimum
                        keeps the one whose cylinders sit closest to the
                        cloud. That sweep is the method; a single cover
                        size chosen in advance is what it exists to
                        replace. A voxel control used to sit here and had
                        no effect on this path at all.
                      </div>
                    ) : (
                      <Num
                        label="Branch voxel"
                        unit="m" value={qsmBranchVoxel} min={0.005} step={0.005} onChange={setQsmBranchVoxel}
                        hint="Voxel size for branch clustering. Smaller captures thinner branches but costs memory; 0.10 m is the sweet spot."
                      />
                    )}
                  </>
                )}
                <button
                  className="btn !h-8 w-full justify-center mono text-[11.5px]"
                  disabled={!desktop?.octreeTreeQsm || !dir || qsmRunning || running}
                  onClick={runQsm}
                  title={qsmEnableBranches
                    ? (qsmBranchMethod === 'treeqsm'
                        ? 'Slice the stem, then run Raumonen-style TreeQSM on branches (overlapping balls, segment hierarchy, cylinder chains)'
                        : 'Slice the stem, then fit one PCA cylinder per branch component')
                    : 'Slice every segmented tree, fit circles, sum frustum volumes'}
                >
                  {qsmRunning
                    ? `Running QSM… ${Math.round(qsmPct * 100)}%`
                    : `Compute QSM${qsmEnableBranches ? (qsmBranchMethod === 'treeqsm' ? ' (TreeQSM)' : ' (stem + branches)') : ' (stem)'}`}
                </button>
                {qsmRunning && (
                  <button className="btn !h-7 w-full justify-center mono text-[11px] -mt-1" onClick={() => cancelStage('qsm')} disabled={!canCancel()}
                    title="Stop the QSM — nothing is written until every tree is done">Cancel QSM</button>
                )}
                {qsmRunning && (
                  <div className="w-full rounded-full overflow-hidden -mt-1.5" style={{ height: 4, background: 'var(--wash-3)' }}>
                    <div style={{ width: `${Math.round(qsmPct * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
                  </div>
                )}
                {qsmTotal != null && !qsmRunning && (
                  <div className="mono text-[10px]" style={{ color: 'var(--text-dim)', lineHeight: 1.45 }}>
                    Σ stem volume <span style={{ color: 'var(--accent)' }}>{qsmTotal.toFixed(3)} m³</span>
                    {qsmTotalStd != null && qsmTotalStd > 0 && (
                      <> ± <span style={{ color: 'var(--text)' }}>{(1.96 * qsmTotalStd).toFixed(3)}</span> <span style={{ color: 'var(--text-mute)' }}>(95 % CI)</span></>
                    )}
                    {' · '}{qsm?.size ?? 0} trees
                    {qsm && (() => {
                      let bv = 0, bc = 0;
                      for (const t of qsm.values()) { bv += t.branchVolume ?? 0; bc += t.branchCount ?? 0; }
                      if (bc === 0) return null;
                      return (
                        <div style={{ color: 'var(--text-mute)' }}>
                          Σ branch volume <span style={{ color: 'var(--accent)' }}>{bv.toFixed(3)} m³</span> · {bc} branches
                          {' · total '}<span style={{ color: 'var(--accent)' }}>{(qsmTotal + bv).toFixed(3)} m³</span>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            </details>
          </div>

          {/* Biomass + carbon — derived live from the QSM volumes.
              Only meaningful once a QSM has been computed. */}
          {qsm && (
            <div className="pt-1" style={{ borderTop: '1px solid var(--line)' }}>
              <details open>
                <summary className="chip cursor-pointer" style={{ width: 'fit-content' }}>Biomass &amp; carbon</summary>
                <div className="flex flex-col gap-2.5 mt-2">
                  <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
                    Woody biomass = each tree's species density × its (stem + branch) volume; carbon = biomass × carbon fraction; CO₂e = carbon × 44/12. Assign species per tree in Tree Review — anything unassigned uses the fallback below. Uncertainty combines the QSM volume CI with each tree's own density + carbon-fraction errors.
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="chip" style={{ width: 'fit-content', margin: 0 }}>Fallback species</span>
                    <select
                      className="mono text-[11px] py-1 px-1.5 rounded-md outline-none"
                      style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                      value={fallbackSpeciesKey}
                      onChange={(e) => applyFallbackSpecies(e.target.value)}
                    >
                      {SPECIES_DENSITIES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                      <option value="custom">Custom…</option>
                    </select>
                    {fallbackSpeciesKey !== 'custom' && (
                      <span className="mono text-[8.5px]" style={{ color: 'var(--text-mute)' }}>
                        {SPECIES_DENSITIES.find(s => s.key === fallbackSpeciesKey)?.source}
                      </span>
                    )}
                    <span className="mono text-[8.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
                      Used only for trees with no species assignment.
                    </span>
                  </div>
                  <Num label="Wood density" unit="kg/m³" value={biomassParams.density} min={100} step={5}
                       onChange={(v) => { setFallbackSpeciesKey('custom'); setBiomassParams(p => ({ ...p, density: v })); }}
                       hint="Basic density: oven-dry mass / green volume. Fallback only — assigned trees use their own species." />
                  <Num label="Density ±1σ" unit="kg/m³" value={biomassParams.densityStd} min={0} step={5}
                       onChange={(v) => setBiomassParams(p => ({ ...p, densityStd: v }))}
                       hint="Natural variation in density — feeds the fallback's biomass CI." />
                  <Num label="Carbon fraction" unit="" value={biomassParams.carbonFraction} min={0.3} step={0.01}
                       onChange={(v) => { setFallbackSpeciesKey('custom'); setBiomassParams(p => ({ ...p, carbonFraction: v })); }}
                       hint="Carbon per oven-dry mass, fallback only. Boreal stemwood ≈ 0.50; IPCC 2006 default 0.47." />
                  <Num label="Branch vol. ±" unit="%" value={biomassParams.branchUncFraction * 100} min={0} step={5}
                       onChange={(v) => setBiomassParams(p => ({ ...p, branchUncFraction: v / 100 }))}
                       hint="Relative uncertainty on branch volume, every tree regardless of species (branch QSM is noisier than the slice stem)." />
                  {speciesMix.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <span className="chip" style={{ width: 'fit-content', margin: 0 }}>Species mix</span>
                      <div className="mono text-[10px] flex flex-col gap-0.5" style={{ color: 'var(--text-dim)' }}>
                        {speciesMix.map(s => (
                          <div key={s.key} className="flex items-center justify-between">
                            <span>{s.label}</span>
                            <span className="tnum" style={{ color: 'var(--text)' }}>{s.count}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {speciesBiomass && speciesBiomass.fallbackCount > 0 && (
                    <div
                      className="mono text-[10px] px-2 py-1.5 rounded-md"
                      style={{ color: '#e6c068', background: 'rgba(230,192,104,0.10)', border: '1px solid color-mix(in oklch, #e6c068 45%, transparent)', lineHeight: 1.5 }}
                    >
                      ⚑ {speciesBiomass.fallbackCount} of {qsm.size} tree{qsm.size === 1 ? '' : 's'} {speciesBiomass.fallbackCount === 1 ? 'has' : 'have'} no species assigned — using the {SPECIES_DENSITIES.find(s => s.key === fallbackSpeciesKey)?.label ?? fallbackSpeciesKey} fallback density. Assign species in Tree Review for a fully species-aware estimate.
                    </div>
                  )}
                  {biomassTotals && (
                    <div className="mono text-[10px] mt-0.5 flex flex-col gap-0.5" style={{ color: 'var(--text-dim)', lineHeight: 1.5 }}>
                      <div>Σ biomass <span style={{ color: 'var(--accent)' }}>{fmtMass(biomassTotals.biomass)}</span> ± {fmtMass(1.96 * biomassTotals.biomassStd)}</div>
                      <div>Σ carbon <span style={{ color: 'var(--accent)' }}>{fmtMass(biomassTotals.carbon)}</span> ± {fmtMass(1.96 * biomassTotals.carbonStd)}</div>
                      <div>Σ CO₂e <span style={{ color: 'var(--accent)' }}>{fmtMass(biomassTotals.co2e)}</span> ± {fmtMass(1.96 * biomassTotals.co2eStd)} <span style={{ color: 'var(--text-mute)' }}>(95 % CI)</span></div>
                    </div>
                  )}
                </div>
              </details>
            </div>
          )}
          {error && (
            <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: 'var(--danger, #e0506b)', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 45%, transparent)', lineHeight: 1.5 }}>
              {error}
            </div>
          )}
        </aside>

        {/* Right — summary + table. */}
        <main className="flex-1 min-w-0 flex flex-col p-4 gap-4 overflow-hidden">
          {summary && (
            <div className="grid grid-cols-5 gap-2.5 shrink-0">
              <Stat label="Trees" value={summary.n.toLocaleString()} />
              <Stat label="Mean height" value={fmt(summary.meanHeight, 1)} unit="m" />
              <Stat label="Mean DBH" value={fmt(summary.meanDbh * 100, 1)} unit="cm" sub={`${summary.withDbh}/${summary.n} fit`} />
              <Stat label="Mean crown ⌀" value={fmt(summary.meanCrown, 1)} unit="m" />
              <Stat label="Σ basal area" value={fmt(summary.totalBasal, 2)} unit="m²" />
            </div>
          )}
          {biomassTotals && qsmTotal != null && (
            <div className="grid grid-cols-5 gap-2.5 shrink-0">
              <Stat label="Σ stem vol" value={fmt(qsmTotal, 2)} unit="m³" />
              <Stat label="Σ biomass" value={scaleMassVal(biomassTotals.biomass)} unit={scaleMassUnit(biomassTotals.biomass)} sub={`±${scaleMassVal(1.96 * biomassTotals.biomassStd)} ${scaleMassUnit(biomassTotals.biomass)}`} />
              <Stat label="Σ carbon" value={scaleMassVal(biomassTotals.carbon)} unit={scaleMassUnit(biomassTotals.carbon)} />
              <Stat label="Σ CO₂e" value={scaleMassVal(biomassTotals.co2e)} unit={scaleMassUnit(biomassTotals.co2e)} sub={`±${scaleMassVal(1.96 * biomassTotals.co2eStd)} (95 % CI)`} />
              {/* Prominent by design: a plot where almost every tree fell
                  back to the default species must not read as a real
                  species-aware result, so this sits right next to the
                  headline totals, not buried in the aside. */}
              <Stat
                label="Fallback trees"
                value={`${speciesBiomass?.fallbackCount ?? 0}`}
                unit={`/ ${qsm?.size ?? 0}`}
                sub={speciesMix.length > 0 ? `${speciesMix.length} species assigned` : 'no species assigned'}
                warn={(speciesBiomass?.fallbackCount ?? 0) > 0}
              />
            </div>
          )}

          <div className="flex-1 min-h-0 panel rounded-xl overflow-hidden flex flex-col">
            <div className="flex items-center justify-between px-4 py-2.5 hairline-b shrink-0">
              <span className="chip" style={{ margin: 0 }}>{sorted ? `${sorted.length} trees` : 'Results'}</span>
              <div className="flex items-center gap-2 min-w-0">
                {status && !running && <span className="mono text-[10px] truncate" style={{ color: 'var(--accent)', maxWidth: 360 }} title={status}>✓ {status}</span>}
                <button
                  className="btn !h-7 !px-3 mono text-[11px] shrink-0"
                  disabled={!sorted || sorted.length === 0 || !desktop?.saveCsvDialog}
                  onClick={exportCsv}
                  title="Export the table to a CSV file"
                >
                  Export CSV
                </button>
              </div>
            </div>

            {!sorted ? (
              <div className="flex-1 flex items-center justify-center mono text-[11.5px] px-6 text-center" style={{ color: 'var(--text-mute)', lineHeight: 1.6 }}>
                {running ? 'Measuring every tree…' : 'Pick a dataset and compute to see per-tree height, DBH, basal area and crown size. Classify ground + segment trees in the Editor first.'}
              </div>
            ) : sorted.length === 0 ? (
              <div className="flex-1 flex items-center justify-center mono text-[11.5px] px-6 text-center" style={{ color: 'var(--text-mute)' }}>
                No segmented trees found — segment trees in the Editor's Tree Review panel first.
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-auto scroll-thin">
                <table className="w-full border-collapse">
                  <thead className="sticky top-0 z-10" style={{ background: 'rgba(12,18,15,0.96)', backdropFilter: 'blur(6px)' }}>
                    <tr>
                      <Th label="Tree" k="treeId" sort={sort} onSort={toggleSort} left />
                      <Th label="Height" unit="m" k="height" sort={sort} onSort={toggleSort} />
                      <Th label="DBH" unit="cm" k="dbh" sort={sort} onSort={toggleSort} />
                      <Th label="Basal" unit="m²" k="basalArea" sort={sort} onSort={toggleSort} />
                      <Th label="Crown" unit="m²" k="crownArea" sort={sort} onSort={toggleSort} />
                      <Th label="Crown ⌀" unit="m" k="crownDiameter" sort={sort} onSort={toggleSort} />
                      <Th label="Points" k="count" sort={sort} onSort={toggleSort} />
                      {stems && (
                        <th className="px-3 py-2 text-right" style={{ borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
                          <span className="mono text-[10px] uppercase" style={{ color: 'var(--text-mute)', letterSpacing: '0.04em' }}>Stem inliers</span>
                        </th>
                      )}
                      {qsm && (
                        <>
                          <th className="px-3 py-2 text-right" style={{ borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
                            <span className="mono text-[10px] uppercase" style={{ color: 'var(--text-mute)', letterSpacing: '0.04em' }}>Stem vol m³</span>
                          </th>
                          <th className="px-3 py-2 text-right" style={{ borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
                            <span className="mono text-[10px] uppercase" style={{ color: 'var(--text-mute)', letterSpacing: '0.04em' }} title="95 % confidence half-width on stem volume (= 1.96·σ from per-slice RMSE / √n).">± 95 % CI</span>
                          </th>
                          {hasBranches && (
                            <>
                              <th className="px-3 py-2 text-right" style={{ borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
                                <span className="mono text-[10px] uppercase" style={{ color: 'var(--text-mute)', letterSpacing: '0.04em' }} title="Sum of primary-branch cylinder volumes (PCA cylinders, m³).">Branch m³</span>
                              </th>
                              <th className="px-3 py-2 text-right" style={{ borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
                                <span className="mono text-[10px] uppercase" style={{ color: 'var(--text-mute)', letterSpacing: '0.04em' }} title="Stem + branch (m³).">Total m³</span>
                              </th>
                            </>
                          )}
                          <th className="px-3 py-2 text-right" style={{ borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
                            <span className="mono text-[10px] uppercase" style={{ color: 'var(--text-mute)', letterSpacing: '0.04em' }} title="Radius-weighted mean angular coverage across slices (0..1). 1.0 = fully encircled stem.">Conf.</span>
                          </th>
                          <th className="px-3 py-2 text-right" style={{ borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
                            <span className="mono text-[10px] uppercase" style={{ color: 'var(--text-mute)', letterSpacing: '0.04em' }} title="Above-stump woody biomass = density × (stem + branch volume).">Biomass</span>
                          </th>
                          <th className="px-3 py-2 text-right" style={{ borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}>
                            <span className="mono text-[10px] uppercase" style={{ color: 'var(--text-mute)', letterSpacing: '0.04em' }} title="CO₂-equivalent = biomass × carbon fraction × 44/12.">CO₂e</span>
                          </th>
                        </>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(t => {
                      const [r, g, b] = treeIdColor(t.treeId);
                      const f = stems?.get(t.treeId);
                      const refined = !!f && Number.isFinite(f.dbh);
                      const q = qsm?.get(t.treeId);
                      const taperOpen = expandedTaperId === t.treeId && !!q;
                      // 7 base cols + optional stem-inliers + QSM block
                      // (stem vol, ±CI, conf, biomass, co2e = 5, plus
                      // branch + total when branches present = 2).
                      const colSpan = 7 + (stems ? 1 : 0) + (qsm ? 5 + (hasBranches ? 2 : 0) : 0);
                      return (
                        <Fragment key={t.treeId}>
                        <tr
                          className="hairline-b"
                          style={{
                            borderColor: 'var(--wash-2)',
                            cursor: q ? 'pointer' : 'default',
                            background: taperOpen ? 'color-mix(in oklch, var(--accent) 6%, transparent)' : undefined,
                          }}
                          onClick={() => q && setExpandedTaperId(taperOpen ? null : t.treeId)}
                          title={q ? 'Click to toggle the taper sparkline' : undefined}
                        >
                          <td className="px-3 py-1.5">
                            <span className="flex items-center gap-2">
                              <span style={{ width: 9, height: 9, borderRadius: 2, background: `rgb(${r},${g},${b})`, boxShadow: '0 0 0 1px rgba(255,255,255,0.15)', flexShrink: 0 }} />
                              <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>{t.treeId}</span>
                            </span>
                          </td>
                          <Td>{fmt(t.height, 1)}</Td>
                          <td className="px-3 py-1.5 text-right mono text-[11px] tnum" style={{ color: 'var(--text-dim)' }}>
                            {Number.isFinite(t.dbh) ? (
                              <span className="inline-flex items-center gap-1 justify-end">
                                {refined && <span title={`RANSAC fit · RMSE ${f!.rmse.toFixed(3)} m`} style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--accent)' }} />}
                                {fmt(t.dbh * 100, 1)}
                              </span>
                            ) : <Dash />}
                          </td>
                          <Td>{Number.isFinite(t.basalArea) ? fmt(t.basalArea, 3) : <Dash />}</Td>
                          <Td>{fmt(t.crownArea, 1)}</Td>
                          <Td>{fmt(t.crownDiameter, 1)}</Td>
                          <Td muted>{t.count.toLocaleString()}</Td>
                          {stems && <Td muted>{refined ? f!.inlierCount.toLocaleString() : <Dash />}</Td>}
                          {qsm && (
                            <>
                              <Td>{q && Number.isFinite(q.stemVolume) ? fmt(q.stemVolume, 3) : <Dash />}</Td>
                              <td className="px-3 py-1.5 text-right mono text-[11px] tnum" style={{ color: 'var(--text-mute)' }} title={q ? `σ ${q.stemVolumeStd.toFixed(4)} m³ · 95 % CI ± ${q.stemVolumeCi95.toFixed(4)} m³` : undefined}>
                                {q && q.stemVolumeCi95 > 0 ? `± ${q.stemVolumeCi95.toFixed(3)}` : <Dash />}
                              </td>
                              {hasBranches && (
                                <>
                                  <td className="px-3 py-1.5 text-right mono text-[11px] tnum" style={{ color: 'var(--text-dim)' }} title={q ? `${q.branchCount} branches` : undefined}>
                                    {q && q.branchCount > 0 ? fmt(q.branchVolume, 3) : <Dash />}
                                  </td>
                                  <td className="px-3 py-1.5 text-right mono text-[11px] tnum" style={{ color: 'var(--text)' }}>
                                    {q && Number.isFinite(q.totalVolume) ? fmt(q.totalVolume, 3) : <Dash />}
                                  </td>
                                </>
                              )}
                              <td className="px-3 py-1.5 text-right mono text-[11px] tnum" style={{ color: q ? confColor(q.confidence) : 'var(--text-mute)' }} title={q ? `${q.acceptedSlices} accepted · ${q.rejectedSlices} rejected · ${(q.completeness * 100).toFixed(0)}% height coverage` : undefined}>
                                {q ? `${(q.confidence * 100).toFixed(0)}%` : <Dash />}
                              </td>
                              {(() => {
                                const bm = biomass?.get(t.treeId);
                                return (
                                  <>
                                    <td className="px-3 py-1.5 text-right mono text-[11px] tnum" style={{ color: 'var(--text-dim)' }} title={bm ? `±${fmtMass(1.96 * bm.biomassStd)} (95 % CI)` : undefined}>
                                      {bm ? fmtMass(bm.biomass) : <Dash />}
                                    </td>
                                    <td className="px-3 py-1.5 text-right mono text-[11px] tnum" style={{ color: 'var(--text-dim)' }} title={bm ? `±${fmtMass(1.96 * bm.co2eStd)} (95 % CI)` : undefined}>
                                      {bm ? fmtMass(bm.co2e) : <Dash />}
                                    </td>
                                  </>
                                );
                              })()}
                            </>
                          )}
                        </tr>
                        {taperOpen && q && (
                          <tr>
                            <td colSpan={colSpan} style={{ background: 'rgba(0,0,0,0.18)', padding: '12px 16px', borderBottom: '1px solid var(--line)' }}>
                              <TreeTaperSparkline tree={q} />
                            </td>
                          </tr>
                        )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </div>
    </Page>
  );
}

// ---------------- building blocks ----------------

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute left-0 right-0 bottom-0 flex flex-col" style={{ top: 52, background: 'var(--viewport-bg)' }}>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="chip mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function Stat({ label, value, unit, sub, warn }: { label: string; value: string; unit?: string; sub?: string; warn?: boolean }) {
  const warnColor = '#e6c068';
  return (
    <div className="panel rounded-lg px-3 py-2.5" style={warn ? { borderColor: 'color-mix(in oklch, #e6c068 45%, transparent)' } : undefined}>
      <div className="mono text-[9.5px] uppercase" style={{ color: 'var(--text-mute)', letterSpacing: '0.06em' }}>{label}</div>
      <div className="flex items-baseline gap-1 mt-0.5">
        <span className="text-[18px] font-semibold tnum" style={{ color: warn ? warnColor : 'var(--text)' }}>{value}</span>
        {unit && <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>{unit}</span>}
      </div>
      {sub && <div className="mono text-[9px] mt-0.5" style={{ color: warn ? warnColor : 'var(--text-mute)' }}>{sub}</div>}
    </div>
  );
}

function Th({ label, unit, k, sort, onSort, left }: { label: string; unit?: string; k: SortKey; sort: { key: SortKey; dir: 1 | -1 }; onSort: (k: SortKey) => void; left?: boolean }) {
  const active = sort.key === k;
  return (
    <th
      className={`px-3 py-2 ${left ? 'text-left' : 'text-right'} cursor-pointer select-none`}
      style={{ borderBottom: '1px solid var(--line)', whiteSpace: 'nowrap' }}
      onClick={() => onSort(k)}
    >
      <span className="inline-flex items-center gap-1 mono text-[10px] uppercase" style={{ color: active ? 'var(--accent)' : 'var(--text-mute)', letterSpacing: '0.04em' }}>
        {label}{unit && <span style={{ opacity: 0.7 }}>({unit})</span>}
        <span style={{ width: 8, opacity: active ? 1 : 0.25 }}>{active ? (sort.dir === 1 ? '▲' : '▼') : '↕'}</span>
      </span>
    </th>
  );
}

function Td({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <td className="px-3 py-1.5 text-right mono text-[11px] tnum" style={{ color: muted ? 'var(--text-mute)' : 'var(--text-dim)' }}>{children}</td>;
}

function Dash() { return <span style={{ color: 'var(--text-mute)' }}>—</span>; }

// Confidence colour ramp for the QSM angular-coverage column. Green
// when the stem was almost fully encircled (≥ 0.80), yellow for
// partial coverage (0.55–0.80), red for one-sided / heavily occluded.
function confColor(c: number): string {
  if (!Number.isFinite(c)) return 'var(--text-mute)';
  if (c >= 0.80) return 'var(--accent)';
  if (c >= 0.55) return '#e6c068';
  return '#ffb4be';
}

function Num({ label, unit, value, min, step, onChange, hint, compact }: {
  label: string; unit: string; value: number; min: number; step: number;
  onChange: (v: number) => void; hint?: string; compact?: boolean;
}) {
  return (
    <div className={compact ? 'flex-1' : ''}>
      <div className="flex items-center justify-between gap-2">
        {label && <span className="mono text-[10.5px]" style={{ color: 'var(--text)' }}>{label}</span>}
        <div className="flex items-center gap-1 flex-1 justify-end">
          <input
            type="number" value={value} min={min} step={step}
            onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) onChange(Math.max(min, v)); }}
            className="mono text-[11.5px] py-1 px-2 rounded-md text-right"
            style={{ ...inputStyle, width: compact ? 56 : 64 }}
          />
          {unit && <span className="mono text-[9px]" style={{ color: 'var(--text-mute)', width: 14 }}>{unit}</span>}
        </div>
      </div>
      {hint && <div className="mono text-[8.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.3 }}>{hint}</div>}
    </div>
  );
}

function Checkbox({ checked, onChange }: { checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="rounded-sm flex items-center justify-center transition-all shrink-0"
      style={{ width: 14, height: 14, background: checked ? 'var(--accent)' : 'rgba(0,0,0,0.3)', border: `1px solid ${checked ? 'var(--accent)' : 'var(--line-strong)'}` }}
      aria-pressed={checked}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#06140d" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5L6.5 12L13 4" /></svg>
      )}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid var(--line)',
  color: 'var(--text)',
  outline: 'none',
};

function fmt(n: number, dp: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(dp);
}
// Mass in kg, auto-scaled to t above 1000 kg for readability.
function fmtMass(kg: number): string {
  if (!Number.isFinite(kg)) return '—';
  if (Math.abs(kg) >= 1000) return `${(kg / 1000).toFixed(2)} t`;
  return `${kg.toFixed(1)} kg`;
}
// Split value + unit for the Stat cards (which take them separately).
function scaleMassUnit(kg: number): string { return Math.abs(kg) >= 1000 ? 't' : 'kg'; }
function scaleMassVal(kg: number): string {
  if (!Number.isFinite(kg)) return '—';
  return Math.abs(kg) >= 1000 ? (kg / 1000).toFixed(2) : kg.toFixed(1);
}

function formatPts(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function MetricsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}
