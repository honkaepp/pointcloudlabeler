// Tree Review panel — walk every segmented tree one at a time. A scan
// runs a global, patch-aware pass in Rust (octree_tree_summary) so the
// per-tree point counts + footprints are exact, not just whatever LOD
// nodes happen to be loaded. Picking a tree makes it the active id,
// isolates it (filter), and flies the camera to its bbox; ←/→ step
// through the list. This is the foundation merge + analytics build on.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import type { TreeSummaryEntry, TreeMetric } from '../../persistence/octreeReader';
import { onOctreeProgress } from '../../persistence/octreeStore';
import { computeQcFlags, worstByTree, SEV_COLOR, type Flag, type Severity } from '../../metrics/qcFlags';
import { SPECIES_DENSITIES } from '../../metrics/biomass';
import { DEFAULT_METRIC_PARAMS } from '../../metrics/params';
import { useCachedTreeMetrics } from '../../metrics/useCachedTreeMetrics';
import { loadTreeMetrics } from '../../metrics/loadMetrics';
import { treeIdColor, UNASSIGNED_RGB } from '../../three/palette';
import DualRangeSlider from './DualRangeSlider';
import { farExtent, isolateGeomFor, neighboursOf } from './treeNeighbourhood';
import { marginReach, type IsolateMargin, type MarginReach } from '../../three/filterGeometry';
import { editReach, relinkReach, DIRECTION_LABELS, DIRECTION_TITLES } from './marginFields';
import { confirmDialog } from '../../ui/dialogs';

type SortMode = 'id' | 'count';
/** Per-tree QA status: absent = unreviewed. Persisted to review.json. */
type ReviewStatus = 'ok' | 'flag';
type StatusFilter = 'all' | 'unreviewed' | 'flag' | 'ok';

interface Desktop {
  octreeTreeSummary?: (dir: string) => Promise<TreeSummaryEntry[]>;
  octreeTreeMetrics?: (dir: string, params: { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number }) => Promise<TreeMetric[]>;
  octreeReadReview?: (dir: string) => Promise<string>;
  octreeWriteReview?: (dir: string, json: string) => Promise<void>;
  octreeReadSpecies?: (dir: string) => Promise<string>;
  octreeWriteSpecies?: (dir: string, json: string) => Promise<void>;
}

/** Default metric params — match the Metrics module so a tree reads the
 *  same numbers in both places. */
const METRIC_PARAMS = DEFAULT_METRIC_PARAMS;

export default function TreeReviewPanel() {
  const { octree, api, tools, filters, setFilters, setTools, display, setDisplay, selectedCount } = useOctreeShell();
  /** Result line for the absorb (select-grey → assign) action. */
  const [absorbNote, setAbsorbNote] = useState<string | null>(null);
  const [trees, setTrees] = useState<TreeSummaryEntry[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sort, setSort] = useState<SortMode>('id');

  // Search filters over the scanned list — for hunting problem trees:
  // fragments (few points), stumps/saplings (low height), suspicious
  // giants (huge footprint), stray-infected segmentations. null = bound
  // off. The FILTERED list drives sorting AND the ‹ › stepper, so
  // "step through every low-count tree and fix each" is the workflow.
  const [showTf, setShowTf] = useState(false);
  const [showMap, setShowMap] = useState(false);
  const [fMinPts, setFMinPts] = useState<number | null>(null);
  const [fMaxPts, setFMaxPts] = useState<number | null>(null);
  const [fMinH, setFMinH] = useState<number | null>(null);
  const [fMaxH, setFMaxH] = useState<number | null>(null);
  const [fMinDiam, setFMinDiam] = useState<number | null>(null);
  const [fMaxDiam, setFMaxDiam] = useState<number | null>(null);
  const [fStrays, setFStrays] = useState(false);
  const [fMaxNeighbour, setFMaxNeighbour] = useState<number | null>(null); // m
  const [fMaxDensity, setFMaxDensity] = useState<number | null>(null);     // pts per m³ of σ-box
  // Metrics-based filters (DBH) — applicable only once Compute metrics
  // has run; inert (and hinted as such) when the cache is missing or
  // was invalidated by a merge / split / re-scan.
  const [fMinDbh, setFMinDbh] = useState<number | null>(null);   // cm
  const [fMaxDbh, setFMaxDbh] = useState<number | null>(null);   // cm
  const [fDbhMissing, setFDbhMissing] = useState(false);
  const [fQcOnly, setFQcOnly] = useState(false);
  // Id window — the plainest filter of all, and the one a forester asks
  // for first when a colleague says "check 120 to 140".
  const [fMinId, setFMinId] = useState<number | null>(null);
  const [fMaxId, setFMaxId] = useState<number | null>(null);
  // Species: '' = any, '-' = not yet assigned, otherwise a species key.
  // "Which trees still have no species" is the other half of the bulk
  // assignment already in this panel, and there was no way to ask it.
  const [fSpecies, setFSpecies] = useState<string>('');
  // The complement of `fMaxNeighbour`: the trees standing furthest from
  // anything else. Over-segmentation shows up as neighbours too CLOSE;
  // a stray cluster in the middle of a gap shows up as one too far.
  const [fMinNeighbour, setFMinNeighbour] = useState<number | null>(null);
  // Metrics-based: crown width and stem lean. Lean is the storm-damage
  // sweep — the plot's leaners are exactly the trees a second pass wants.
  const [fMinCrown, setFMinCrown] = useState<number | null>(null); // m
  const [fMaxCrown, setFMaxCrown] = useState<number | null>(null); // m
  const [fMinLean, setFMinLean] = useState<number | null>(null);   // deg

  // Per-tree forestry metrics (height / DBH / basal area / crown …),
  // computed on demand from the same native command the Metrics module
  // uses and cached by tree_id so navigating trees shows them instantly.
  const [metrics, setMetrics] = useState<Map<number, TreeMetric> | null>(null);
  const [metricsAt, setMetricsAt] = useState<number | null>(null);
  const [computingMetrics, setComputingMetrics] = useState(false);
  // Native progress for the two long ops (scan / metrics) so the user
  // sees the bar instead of a frozen button on big clouds.
  const [scanPct, setScanPct] = useState(0);
  const [metricsPct, setMetricsPct] = useState(0);

  useEffect(() => {
    if (!scanning && !computingMetrics) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((stage, p) => {
      if (stage === 'tree_summary') setScanPct(p);
      else if (stage === 'metrics') setMetricsPct(p);
    }).then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [scanning, computingMetrics]);

  // Merge state. In merge mode a row toggles into mergeSel instead of
  // focusing; "Merge → target" folds every selected source into target.
  const [mergeMode, setMergeMode] = useState(false);
  const [mergeSel, setMergeSel] = useState<Set<number>>(() => new Set());
  const [mergeTarget, setMergeTarget] = useState<number | ''>('');
  const [merges, setMerges] = useState<[number, number][]>([]);
  const [merging, setMerging] = useState(false);

  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  // Seeded from the shared metrics cache — another panel may already have
  // measured this cloud, in which case the DBH filters and the QC badges
  // work the moment this panel opens instead of needing their own pass.
  // Reads only, and fingerprint-checked. See metrics/useCachedTreeMetrics.
  const cachedMetrics = useCachedTreeMetrics(desktop, octree?.dir, METRIC_PARAMS, metricsAt);
  useEffect(() => {
    if (!cachedMetrics) return;
    setMetrics(new Map(cachedMetrics.rows.map(r => [r.treeId, r])));
    setMetricsAt(cachedMetrics.at);
  }, [cachedMetrics]);
  const canScan = !!desktop?.octreeTreeSummary && !!octree;
  const canMetrics = !!desktop?.octreeTreeMetrics && !!octree;
  // The metric for the currently-selected tree (if computed).
  const selMetric = selectedId != null ? metrics?.get(selectedId) ?? null : null;

  // Horizontal distance from each tree's centroid to its NEAREST other
  // tree's centroid. Two "trees" standing 30 cm apart are almost always
  // one tree the segmenter split — this is the sharpest over-
  // segmentation signal available without any metrics pass. O(n²) over
  // centroids: 220 trees = 48 k comparisons, trivial; a 10 k-tree plot
  // would be 100 M, so it's capped and skipped beyond that.
  const NEIGHBOUR_MAX_TREES = 4000;
  const nearestNeighbour = useMemo(() => {
    const m = new Map<number, number>();
    if (!trees) return m;
    const pts = trees.filter(t => t.treeId > 0 && t.centroid);
    if (pts.length < 2 || pts.length > NEIGHBOUR_MAX_TREES) return m;
    for (let i = 0; i < pts.length; i++) {
      let best = Infinity;
      const ax = pts[i].centroid[0], ay = pts[i].centroid[1];
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const dx = ax - pts[j].centroid[0];
        const dy = ay - pts[j].centroid[1];
        const d2 = dx * dx + dy * dy;
        if (d2 < best) best = d2;
      }
      m.set(pts[i].treeId, Math.sqrt(best));
    }
    return m;
  }, [trees]);

  // Which other trees reach into the isolated tree's neighbourhood —
  // the picks the viewer's `isolateOtherIds` drives. See
  // treeNeighbourhood.ts for why the list has to use the viewer's own
  // box arithmetic rather than an approximation of it.
  const neighbours = useMemo(
    () => neighboursOf(trees, selectedId, filters.isolateMargin),
    [trees, selectedId, filters.isolateMargin],
  );

  // Point density = points per m³ of the tree's σ-core box (the real
  // extent, stray-proof). A dense real tree and a sparse noise cluster
  // can carry the SAME point count; density separates them.
  const densityOf = useCallback((t: TreeSummaryEntry): number | null => {
    if (!t.sigma) return null;
    const vol = Math.max(2 * t.sigma[0], 0.25) * Math.max(2 * t.sigma[1], 0.25) * Math.max(2 * t.sigma[2], 0.25);
    if (!(vol > 0)) return null;
    return t.count / vol;
  }, []);

  // QC anomaly flags from the SAME engine the QC panel uses (metrics
  // only here — the segmentation-relevant subset; the dedicated QC panel
  // adds the QSM checks). qcByTree drives the per-row badge + the
  // selected-tree reason list; qcFlaggedCount gates the "flagged" filter.
  const qcFlags = useMemo<Flag[]>(() => metrics ? computeQcFlags([...metrics.values()], null, null) : [], [metrics]);
  const qcByTree = useMemo(() => {
    const m = new Map<number, Flag[]>();
    for (const f of qcFlags) { const a = m.get(f.treeId); if (a) a.push(f); else m.set(f.treeId, [f]); }
    return m;
  }, [qcFlags]);
  const qcWorst = useMemo(() => worstByTree(qcFlags), [qcFlags]);
  const qcFlaggedCount = qcByTree.size;

  // DBH filters count as active only while the metrics cache exists —
  // otherwise they're inert (the memo skips them) and the chip count
  // must not claim filtering that isn't happening.
  const nDbhFilters = metrics
    ? (fMinDbh !== null ? 1 : 0) + (fMaxDbh !== null ? 1 : 0) + (fDbhMissing ? 1 : 0) + (fQcOnly ? 1 : 0) +
      (fMinCrown !== null ? 1 : 0) + (fMaxCrown !== null ? 1 : 0) + (fMinLean !== null ? 1 : 0)
    : 0;
  const nTreeFilters =
    (fMinPts !== null ? 1 : 0) + (fMaxPts !== null ? 1 : 0) +
    (fMinH !== null ? 1 : 0) + (fMaxH !== null ? 1 : 0) +
    (fMinDiam !== null ? 1 : 0) + (fMaxDiam !== null ? 1 : 0) +
    (fStrays ? 1 : 0) + (fMaxNeighbour !== null ? 1 : 0) + (fMinNeighbour !== null ? 1 : 0) +
    (fMaxDensity !== null ? 1 : 0) +
    (fMinId !== null ? 1 : 0) + (fMaxId !== null ? 1 : 0) + (fSpecies !== '' ? 1 : 0) +
    nDbhFilters;
  const dbhFiltersSetButInert = !metrics && (
    fMinDbh !== null || fMaxDbh !== null || fDbhMissing || fQcOnly ||
    fMinCrown !== null || fMaxCrown !== null || fMinLean !== null);
  const clearTreeFilters = useCallback(() => {
    setFMinPts(null); setFMaxPts(null); setFMinH(null); setFMaxH(null);
    setFMinDiam(null); setFMaxDiam(null); setFStrays(false);
    setFMaxNeighbour(null); setFMinNeighbour(null); setFMaxDensity(null);
    setFMinDbh(null); setFMaxDbh(null); setFDbhMissing(false); setFQcOnly(false);
    setFMinId(null); setFMaxId(null); setFSpecies('');
    setFMinCrown(null); setFMaxCrown(null); setFMinLean(null);
  }, []);

  // Per-tree review status (ok / flag; absent = unreviewed) — the
  // pass-through bookkeeping. Persisted to review.json beside the
  // dataset (durable across sessions, rides with the data). statusFilter
  // narrows the list so ‹ › sweeps only the unreviewed / flagged ones.
  const [reviewStatus, setReviewStatus] = useState<Map<number, ReviewStatus>>(() => new Map());
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const reviewDirtyRef = useRef(false);

  // Load review.json when the dataset changes.
  useEffect(() => {
    setReviewStatus(new Map());
    setStatusFilter('all');
    reviewDirtyRef.current = false;
    if (!octree?.dir || !desktop?.octreeReadReview) return;
    let cancelled = false;
    void desktop.octreeReadReview(octree.dir).then((raw) => {
      if (cancelled) return;
      try {
        const obj = JSON.parse(raw) as Record<string, string>;
        const m = new Map<number, ReviewStatus>();
        for (const [k, v] of Object.entries(obj)) {
          const id = parseInt(k, 10);
          if (Number.isFinite(id) && (v === 'ok' || v === 'flag')) m.set(id, v);
        }
        setReviewStatus(m);
      } catch { /* keep empty on a corrupt file */ }
    }).catch(() => { /* absent → empty */ });
    return () => { cancelled = true; };
  }, [octree?.dir, desktop]);

  // Debounced persist whenever the status map changes (after a user edit).
  useEffect(() => {
    if (!reviewDirtyRef.current) return;
    if (!octree?.dir || !desktop?.octreeWriteReview) return;
    const dir = octree.dir;
    const t = setTimeout(() => {
      const obj: Record<string, string> = {};
      for (const [id, s] of reviewStatus) obj[String(id)] = s;
      void desktop.octreeWriteReview!(dir, JSON.stringify(obj)).catch((e) => {
        console.warn('write review.json failed', e);
      });
    }, 400);
    return () => clearTimeout(t);
  }, [reviewStatus, octree?.dir, desktop]);

  const setStatus = useCallback((treeId: number, status: ReviewStatus | null) => {
    reviewDirtyRef.current = true;
    setReviewStatus(prev => {
      const next = new Map(prev);
      if (status === null) next.delete(treeId); else next.set(treeId, status);
      return next;
    });
  }, []);

  // Per-tree species assignment (absent = unassigned) — bookkeeping like
  // reviewStatus above, persisted to species.json beside the dataset.
  // Feeds the biomass maths (MetricsModule) and the report; never
  // touches point data. bulkSpecies is the value the "assign to
  // filtered" action below applies — a forester assigns species in
  // groups (a stand, a row), not tree by tree.
  const [speciesByTree, setSpeciesByTree] = useState<Map<number, string>>(() => new Map());
  const [bulkSpecies, setBulkSpecies] = useState<string>(SPECIES_DENSITIES[0]?.key ?? '');
  const speciesDirtyRef = useRef(false);

  // Load species.json when the dataset changes.
  useEffect(() => {
    setSpeciesByTree(new Map());
    speciesDirtyRef.current = false;
    if (!octree?.dir || !desktop?.octreeReadSpecies) return;
    let cancelled = false;
    void desktop.octreeReadSpecies(octree.dir).then((raw) => {
      if (cancelled) return;
      try {
        const obj = JSON.parse(raw) as Record<string, string>;
        const m = new Map<number, string>();
        for (const [k, v] of Object.entries(obj)) {
          const id = parseInt(k, 10);
          if (Number.isFinite(id) && typeof v === 'string' && v) m.set(id, v);
        }
        setSpeciesByTree(m);
      } catch { /* keep empty on a corrupt file */ }
    }).catch(() => { /* absent → empty */ });
    return () => { cancelled = true; };
  }, [octree?.dir, desktop]);

  // Debounced persist whenever the species map changes (after a user edit).
  useEffect(() => {
    if (!speciesDirtyRef.current) return;
    if (!octree?.dir || !desktop?.octreeWriteSpecies) return;
    const dir = octree.dir;
    const t = setTimeout(() => {
      const obj: Record<string, string> = {};
      for (const [id, key] of speciesByTree) obj[String(id)] = key;
      void desktop.octreeWriteSpecies!(dir, JSON.stringify(obj)).catch((e) => {
        console.warn('write species.json failed', e);
      });
    }, 400);
    return () => clearTimeout(t);
  }, [speciesByTree, octree?.dir, desktop]);

  const setTreeSpecies = useCallback((treeId: number, key: string | null) => {
    speciesDirtyRef.current = true;
    setSpeciesByTree(prev => {
      const next = new Map(prev);
      if (key === null || key === '') next.delete(treeId); else next.set(treeId, key);
      return next;
    });
  }, []);

  // Filtered view of the scan result. The unassigned bucket row is
  // pinned (it's not a reviewable tree); real trees must pass every
  // active bound. Height / footprint come from the bbox so the filters
  // work straight off a scan, no metrics pass needed. "Strays": the
  // horizontal bbox span is at least DOUBLE the σ-core (5σ ≈ the real
  // crown span) and ≥ 4 m beyond it — the signature of a segmentation
  // with points scattered far off the tree. DBH bounds + "DBH missing"
  // read the metrics cache; a tree the metrics pass skipped entirely
  // counts as missing too (no stem to fit is exactly what it means).
  const filtered = useMemo(() => {
    if (!trees) return null;
    if (nTreeFilters === 0 && statusFilter === 'all') return trees;
    return trees.filter(t => {
      if (t.treeId <= 0) return true;
      if (statusFilter !== 'all') {
        const st = reviewStatus.get(t.treeId);
        if (statusFilter === 'unreviewed' && st) return false;
        if (statusFilter === 'ok' && st !== 'ok') return false;
        if (statusFilter === 'flag' && st !== 'flag') return false;
      }
      if (fMinId !== null && t.treeId < fMinId) return false;
      if (fMaxId !== null && t.treeId > fMaxId) return false;
      if (fSpecies !== '') {
        const sp = speciesByTree.get(t.treeId);
        if (fSpecies === '-' ? sp !== undefined : sp !== fSpecies) return false;
      }
      if (fMinPts !== null && t.count < fMinPts) return false;
      if (fMaxPts !== null && t.count > fMaxPts) return false;
      const h = t.bboxMax[2] - t.bboxMin[2];
      if (fMinH !== null && h < fMinH) return false;
      if (fMaxH !== null && h > fMaxH) return false;
      const diam = Math.max(t.bboxMax[0] - t.bboxMin[0], t.bboxMax[1] - t.bboxMin[1]);
      if (fMinDiam !== null && diam < fMinDiam) return false;
      if (fMaxDiam !== null && diam > fMaxDiam) return false;
      if (fStrays) {
        if (!t.sigma) return false; // σ comes from the scan — needs a fresh Re-scan
        const core = 5 * Math.max(t.sigma[0], t.sigma[1]);
        if (!(diam >= 2 * core && diam - core >= 4)) return false;
      }
      if (metrics && (fMinDbh !== null || fMaxDbh !== null || fDbhMissing)) {
        const m = metrics.get(t.treeId);
        const dbhCm = m && Number.isFinite(m.dbh) ? m.dbh * 100 : null;
        if (fDbhMissing && dbhCm !== null) return false;
        if (fMinDbh !== null && (dbhCm === null || dbhCm < fMinDbh)) return false;
        if (fMaxDbh !== null && (dbhCm === null || dbhCm > fMaxDbh)) return false;
      }
      if (fMaxNeighbour !== null) {
        const d = nearestNeighbour.get(t.treeId);
        if (d === undefined || d > fMaxNeighbour) return false;
      }
      if (fMinNeighbour !== null) {
        const d = nearestNeighbour.get(t.treeId);
        if (d === undefined || d < fMinNeighbour) return false;
      }
      if (fMaxDensity !== null) {
        const dens = densityOf(t);
        if (dens === null || dens > fMaxDensity) return false;
      }
      if (metrics && (fMinCrown !== null || fMaxCrown !== null || fMinLean !== null)) {
        const m = metrics.get(t.treeId);
        if (fMinCrown !== null || fMaxCrown !== null) {
          const cd = m && Number.isFinite(m.crownDiameter) ? m.crownDiameter : null;
          if (fMinCrown !== null && (cd === null || cd < fMinCrown)) return false;
          if (fMaxCrown !== null && (cd === null || cd > fMaxCrown)) return false;
        }
        // Lean is NaN when only one band could be fitted, and a tree
        // whose lean is unknown is not a tree known to be leaning.
        if (fMinLean !== null) {
          const lean = m && Number.isFinite(m.leanDeg) ? Math.abs(m.leanDeg) : null;
          if (lean === null || lean < fMinLean) return false;
        }
      }
      if (metrics && fQcOnly && !qcByTree.has(t.treeId)) return false;
      return true;
    });
  }, [trees, nTreeFilters, fMinPts, fMaxPts, fMinH, fMaxH, fMinDiam, fMaxDiam, fStrays,
      fMaxNeighbour, fMinNeighbour, nearestNeighbour, fMaxDensity, densityOf, metrics,
      fMinDbh, fMaxDbh, fDbhMissing, fQcOnly, qcByTree, statusFilter, reviewStatus,
      fMinId, fMaxId, fSpecies, speciesByTree, fMinCrown, fMaxCrown, fMinLean]);

  // Review progress across the whole scan (not the filtered view).
  const reviewedCount = useMemo(() => {
    if (!trees) return 0;
    let n = 0;
    for (const t of trees) if (t.treeId > 0 && reviewStatus.get(t.treeId)) n++;
    return n;
  }, [trees, reviewStatus]);
  const flaggedCount = useMemo(() => {
    if (!trees) return 0;
    let n = 0;
    for (const t of trees) if (t.treeId > 0 && reviewStatus.get(t.treeId) === 'flag') n++;
    return n;
  }, [trees, reviewStatus]);

  // Species-assignment progress across the whole scan (not the filtered
  // view) — the "how many of the plot's trees have a species" line.
  const speciesAssignedCount = useMemo(() => {
    if (!trees) return 0;
    let n = 0;
    for (const t of trees) if (t.treeId > 0 && speciesByTree.has(t.treeId)) n++;
    return n;
  }, [trees, speciesByTree]);

  // Bulk-assign bulkSpecies to every tree the active filters currently
  // show (excluding the pinned "unassigned points" bucket, which isn't
  // a real tree). Confirmed so a stray click can't silently relabel the
  // whole plot.
  const bulkAssignSpecies = useCallback(async () => {
    if (!filtered || !bulkSpecies) return;
    const ids = filtered.filter(t => t.treeId > 0).map(t => t.treeId);
    if (ids.length === 0) return;
    const label = SPECIES_DENSITIES.find(s => s.key === bulkSpecies)?.label ?? bulkSpecies;
    const ok = await confirmDialog(
      `Assign ${label} to ${ids.length} tree${ids.length === 1 ? '' : 's'} matching the current filters?`
    );
    if (!ok) return;
    speciesDirtyRef.current = true;
    setSpeciesByTree(prev => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, bulkSpecies);
      return next;
    });
  }, [filtered, bulkSpecies]);

  // Sorted view of the (filtered) scan result. Sorting by count puts the
  // biggest (most-segmented) trees first; by id keeps the natural
  // numbering.
  const sorted = useMemo(() => {
    if (!filtered) return null;
    const copy = [...filtered];
    if (sort === 'count') copy.sort((a, b) => b.count - a.count || a.treeId - b.treeId);
    else copy.sort((a, b) => a.treeId - b.treeId);
    return copy;
  }, [filtered, sort]);

  const scan = useCallback(async () => {
    if (!desktop?.octreeTreeSummary || !octree) return;
    setScanning(true); setScanPct(0);
    setError(null);
    try {
      // Flush in-memory edits first so the tally reflects unsaved work.
      await api?.save();
      const result = await desktop.octreeTreeSummary(octree.dir);
      setTrees(result);
      setMerges(api?.getMerges() ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTrees(null);
    } finally {
      setScanning(false);
    }
  }, [desktop, octree, api]);

  // Compute per-tree metrics (read-only native pass) and cache by tree_id.
  // Same command + defaults as the Metrics module, so the numbers agree.
  const computeMetrics = useCallback(async () => {
    if (!desktop?.octreeTreeMetrics || !octree) return;
    setComputingMetrics(true); setMetricsPct(0);
    setError(null);
    try {
      await api?.save(); // so unsaved edits / merges are reflected
      // force — see QcPanel: an explicit compute button has to compute.
      const rows = await loadTreeMetrics(desktop, octree.dir, METRIC_PARAMS, { force: true });
      const m = new Map<number, TreeMetric>();
      for (const r of rows) m.set(r.treeId, r);
      setMetrics(m);
      setMetricsAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setComputingMetrics(false);
    }
  }, [desktop, octree, api]);

  // A fresh dataset invalidates any previous scan + merge selection + metrics.
  useEffect(() => {
    setTrees(null); setSelectedId(null); setError(null); setMetrics(null);
    setMergeMode(false); setMergeSel(new Set());
  }, [octree?.dir]);

  // Mirror the viewer's current merge overlay once the api is live.
  useEffect(() => { setMerges(api?.getMerges() ?? []); }, [api]);

  const focusTree = useCallback((t: TreeSummaryEntry) => {
    setSelectedId(t.treeId);
    setTools({ activeTreeId: Math.max(0, t.treeId) });
    // Isolate the tree (hide all others) AND set its neighbourhood as
    // the forced-detail region so the streamer loads + shows EVERY point
    // of this tree at any zoom (so you can edit it fully, not just
    // whatever LOD the camera distance pulled in). isolateShowUnassigned
    // persists across trees; the margin governs the surrounding ring.
    // The box + anchor come from the scan's density statistics (centroid
    // + σ), not the raw bbox — see isolateGeomFor. The camera frames the
    // same box, so picking a tree, stepping ←/→ or splitting always
    // lands the view on the actual trunk with the reveal hugging it.
    const g = isolateGeomFor(t);
    // isolateOtherIds is a pick among THIS tree's neighbours, so it
    // cannot carry over: tree 8's neighbour 12 is not tree 9's, and a
    // stale pick would silently hide every neighbour of the new tree.
    setFilters({
      isolateTreeId: t.treeId, isolateBox: g.box, isolateAnchor: g.anchor,
      isolateOtherIds: null,
      // Every record the scan saw this tree in, so the far parts of a
      // badly segmented tree are loaded too — the box above is clamped
      // around the trunk and does not reach them.
      isolateRecords: t.records ? { treeId: t.treeId, records: t.records } : null,
    });
    api?.frameBox(g.box[0], g.box[1]);
    setAbsorbNote(null); // the note belonged to the previous tree
  }, [api, setTools, setFilters]);

  const step = useCallback((dir: 1 | -1) => {
    if (!sorted || sorted.length === 0) return;
    const idx = sorted.findIndex(t => t.treeId === selectedId);
    const next = idx < 0 ? (dir === 1 ? 0 : sorted.length - 1)
                         : (idx + dir + sorted.length) % sorted.length;
    focusTree(sorted[next]);
  }, [sorted, selectedId, focusTree]);

  // Jump straight to a typed id. Searches the FULL scan, not the
  // filtered view — you know the id you want; a filter hiding it
  // shouldn't make it unreachable (the filter still governs ‹ › after).
  const [jumpId, setJumpId] = useState('');
  const [jumpError, setJumpError] = useState<string | null>(null);
  const jumpToId = useCallback(() => {
    const id = parseInt(jumpId.trim(), 10);
    if (!Number.isFinite(id)) { setJumpError('Enter a tree id.'); return; }
    const t = trees?.find(x => x.treeId === id);
    if (!t) { setJumpError(`No tree ${id} in the scan.`); return; }
    setJumpError(null);
    focusTree(t);
  }, [jumpId, trees, focusTree]);
  useEffect(() => { setJumpError(null); }, [jumpId]);

  // Advance to the NEXT reviewable tree after the currently-selected one
  // in the sorted/filtered order — the sweep loop's forward move. Skips
  // the unassigned bucket. When a status filter is active and marking a
  // tree drops it OUT of the filtered list (e.g. filter = unreviewed),
  // the list shrinks under us, so we step to whatever now sits at (or
  // just past) the old index instead of wrapping back to the top.
  const advanceAfter = useCallback((justMarkedId: number) => {
    const list = (sorted ?? []).filter(t => t.treeId > 0);
    if (list.length === 0) { setSelectedId(null); return; }
    const here = list.findIndex(t => t.treeId === justMarkedId);
    // Prefer the next tree still in the list; if the marked tree was
    // filtered out its slot now holds the following one.
    const nextTree = here >= 0 ? list[(here + 1) % list.length] : list.find(t => t.treeId > justMarkedId) ?? list[0];
    if (nextTree) focusTree(nextTree);
  }, [sorted, focusTree]);

  // Mark the selected tree ok / flag (toggles off if it already has that
  // status) and advance to the next one — the core review keystroke.
  const markCurrent = useCallback((status: ReviewStatus) => {
    if (selectedId == null || selectedId <= 0) return;
    const cur = reviewStatus.get(selectedId);
    setStatus(selectedId, cur === status ? null : status);
    // Re-select the same tree from the (soon-updated) list on the next
    // tick so the advance uses the post-mark filtered order.
    advanceAfter(selectedId);
  }, [selectedId, reviewStatus, setStatus, advanceAfter]);

  const showAll = useCallback(() => {
    setSelectedId(null);
    setFilters({ isolateTreeId: null, isolateBox: null, isolateAnchor: null, isolateOtherIds: null, isolateRecords: null });
  }, [setFilters]);

  const isolating = filters.isolateTreeId !== null;
  // Points of the isolated tree beyond the framed neighbourhood. The box
  // is sized around the trunk (centroid + σ) so a badly segmented tree
  // cannot drag half the plot into full detail — which puts a cluster
  // 50 m away carrying the same id outside it, off screen. TreeQSM sees
  // every point of the id, so the user has to as well.
  const selectedEntry = selectedId != null ? (trees?.find(x => x.treeId === selectedId) ?? null) : null;
  const farReach = isolating && selectedEntry ? farExtent(selectedEntry, isolateGeomFor(selectedEntry)) : 0;
  // What the streamer holds of the isolated tree, once a second: the
  // records the scan listed, how many are forced, loaded, pending, and
  // how many points of the id are resident and drawn. When the far
  // parts of a tree do not show, this line says where the chain broke
  // — a scan from before the records existed, a node not yet loaded, or
  // a filter hiding what is there.
  const [isoStatus, setIsoStatus] = useState<ReturnType<NonNullable<typeof api>['isolateStatus']> | null>(null);
  useEffect(() => {
    if (!isolating || !api) { setIsoStatus(null); return; }
    let alive = true;
    const tick = () => { if (alive) setIsoStatus(api.isolateStatus()); };
    tick();
    const t = setInterval(tick, 1000);
    return () => { alive = false; clearInterval(t); };
  }, [isolating, api, filters.isolateTreeId, filters.isolateRecords]);

  const toggleMergePick = useCallback((id: number) => {
    setMergeSel(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const target = mergeTarget === '' ? tools.activeTreeId : mergeTarget;
  const sourcesToMerge = useMemo(
    () => [...mergeSel].filter(id => id !== target && id > 0),
    [mergeSel, target],
  );

  const doMerge = useCallback(async () => {
    if (!api || sourcesToMerge.length === 0 || target <= 0) return;
    setMerging(true);
    try {
      await api.mergeTrees(sourcesToMerge, target);
      // If we just merged away the tree being isolated, follow it to the
      // target so the view doesn't go blank.
      if (filters.isolateTreeId != null && sourcesToMerge.includes(filters.isolateTreeId)) {
        setFilters({ isolateTreeId: target });
        setSelectedId(target);
      }
      setMergeSel(new Set());
      setMerges(api.getMerges());
      // Merging folds tree_ids → cached metrics are stale.
      setMetrics(null);
      // Re-scan so counts + the list reflect the fold.
      await scan();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMerging(false);
    }
  }, [api, sourcesToMerge, target, scan, filters.isolateTreeId, setFilters]);

  const removeMerge = useCallback(async (fromId: number) => {
    if (!api) return;
    await api.unmergeTree(fromId);
    setMerges(api.getMerges());
    setMetrics(null);
    await scan();
  }, [api, scan]);

  const clearAllMerges = useCallback(async () => {
    if (!api) return;
    await api.clearMerges();
    setMerges(api.getMerges());
    setMetrics(null);
    await scan();
  }, [api, scan]);

  // --- Split: the inverse of merge ---
  //
  // When a tree is isolated, the lasso / poly / rect tools can only
  // touch its own points (the isolate filter masks everything else
  // out, including in the deep-selection pass over unloaded nodes).
  // So splitting is really just: "lasso the bit you want to peel off
  // and re-label it as a fresh tree". This button automates the
  // tedious half — picking the next free tree_id, applying the
  // patch, saving, and isolating the new tree so the user can
  // immediately QC it. The original tree keeps its id; only the
  // lassoed subset moves.
  const [splitting, setSplitting] = useState(false);
  const doSplit = useCallback(async () => {
    if (!api) return;
    const sel = api.countSelected();
    if (sel <= 0) {
      setError('Lasso the portion of the active tree to split off, then click again.');
      return;
    }
    if (filters.isolateTreeId == null) {
      setError('Isolate a tree first (the lasso then touches only its points).');
      return;
    }
    setSplitting(true);
    try {
      const newId = api.maxTreeId() + 1;
      const written = api.applyToSelection({ treeId: newId });
      if (written === 0) {
        setError('No points changed — the selection didn\'t cover any points of the isolated tree.');
        return;
      }
      await api.save();
      setMetrics(null); // per-tree metrics are now stale
      await scan();
      // Auto-isolate the new tree so the user can immediately review
      // the split they just made. The original tree is still
      // accessible via the list.
      const fresh = trees?.find(t => t.treeId === newId);
      if (fresh) focusTree(fresh); // isolate + anchor + frame the split-off tree
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSplitting(false);
    }
  }, [api, filters.isolateTreeId, scan, focusTree, trees]);

  // ←/→ step through the list while the panel is open (ignored while a
  // text field is focused so it never fights numeric inputs elsewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (mergeMode) return; // arrows are for review navigation, not multi-select
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      // Sweep keys: mark reviewed / flag the current tree + advance.
      else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); markCurrent('ok'); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); markCurrent('flag'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, markCurrent, mergeMode]);

  // Keep the active row scrolled into view as ←/→ moves through.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (selectedId == null || !listRef.current) return;
    const row = listRef.current.querySelector(`[data-tid="${selectedId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  /** Ids surviving the active filters — the map dims everything else. */
  const matchingIds = useMemo(() => {
    const s = new Set<number>();
    for (const t of filtered ?? []) if (t.treeId > 0) s.add(t.treeId);
    return s;
  }, [filtered]);

  const realTrees = sorted ? sorted.filter(t => t.treeId > 0).length : 0;
  const totalTrees = trees ? trees.filter(t => t.treeId > 0).length : 0;

  // Width comes from the FloatingPanel around this (EditorShell sets it),
  // not from here. The old fixed 256 sat inside a 280 frame whose 1 px
  // border left 254, so the root alone was already 2 px too wide — and
  // `min-w-0` is what lets the rows below shrink their <select>s instead
  // of pushing the frame out: a flex item's minimum width is its content
  // width, and a species dropdown's content is its longest option.
  return (
    <div className="flex flex-col gap-2.5 w-full min-w-0">
      {!canScan && (
        <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Tree review needs the desktop build (it scans the whole cloud natively).
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          className="btn btn-primary !h-7 flex-1 justify-center mono text-[11px]"
          disabled={!canScan || scanning}
          onClick={scan}
          title="Scan the whole cloud for every tree id (counts + footprints)"
        >
          {scanning ? `Scanning… ${Math.round(scanPct * 100)}%` : trees ? 'Re-scan trees' : 'Scan trees'}
        </button>
        {isolating && (
          <button
            className="btn !h-7 !px-2 justify-center mono text-[11px]"
            onClick={showAll}
            title="Stop isolating — show every tree again"
          >
            Show all
          </button>
        )}
      </div>
      {scanning && (
        <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: 'var(--wash-3)' }}>
          <div style={{ width: `${Math.round(scanPct * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
        </div>
      )}

      {/* While isolating, optionally keep nearby points visible: the
          unassigned (id ≤ 0) background and/or the neighbouring trees'
          assigned points — both clipped to the same margin ring + height
          band so the view stays focused on the tree being fixed. */}
      {isolating && (
        <div className="flex flex-col gap-1.5 p-2 rounded-md" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--line)' }}>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>Show unassigned (id 0) nearby</span>
            <Toggle
              on={filters.isolateShowUnassigned}
              onChange={(v) => setFilters({ isolateShowUnassigned: v })}
            />
          </label>
          <label className="flex items-center justify-between cursor-pointer">
            <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>Show other trees nearby</span>
            <Toggle
              on={filters.isolateShowOthers}
              onChange={(v) => setFilters({ isolateShowOthers: v })}
            />
          </label>
          {/* WHICH neighbours. All of them at once is the wrong default
              in a dense plot: the one crown you are trying to separate
              from disappears behind four others. */}
          {filters.isolateShowOthers && (
            <NeighbourPicker
              neighbours={neighbours}
              picked={filters.isolateOtherIds}
              onChange={(ids) => setFilters({ isolateOtherIds: ids })}
              onGo={(id) => { const t = trees?.find(x => x.treeId === id); if (t) focusTree(t); }}
            />
          )}
          {/* Distance/height ring around the tree: how far out the
              nearby (and forced-detail) points reach, so you can pull
              stray points into the tree or trim ones that don't belong.
              Per axis and without a ceiling — see MarginFields. */}
          <MarginFields
            value={filters.isolateMargin}
            linked={filters.isolateMarginLinked}
            onChange={(m) => setFilters({ isolateMargin: m })}
            onLinkedChange={(linked) => setFilters(linked
              ? { isolateMarginLinked: true, isolateMargin: relinkReach(filters.isolateMargin) }
              : { isolateMarginLinked: false })}
          />
          {isolating && selectedEntry && farReach >= 3 && (
            <div className="mono text-[9.5px] flex items-center gap-2" style={{ color: '#e6c068', lineHeight: 1.4 }}>
              <span className="flex-1 min-w-0">
                Points of tree {selectedEntry.treeId} lie up to {farReach.toFixed(0)} m outside the framed box.
                {isoStatus?.scanRecords == null
                  ? ' This scan predates the record list: Re-scan trees, then isolate again, to load them.'
                  : ' They are loaded and shown; the frame is not around them.'}
              </span>
              <button
                className="btn !h-6 mono text-[10px] shrink-0"
                onClick={() => api?.frameBox(selectedEntry.bboxMin, selectedEntry.bboxMax)}
                title="Frame every point of this tree, the far parts included"
              >Frame all</button>
            </div>
          )}
          {isolating && isoStatus && (
            <div
              className="mono text-[9px] tnum"
              style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}
              title="From the streamer, once a second. records: octree nodes the scan found this tree in. forced: those plus their ancestors, refined to full depth wherever they are. loaded / pending: how many of the forced nodes are resident / still on their way. points: how many points carrying this id are resident, and how many of them the current filters let through to be drawn."
            >
              streamer · records {isoStatus.scanRecords ?? 'none (old scan)'} · forced {isoStatus.forced}
              {' '}· loaded {isoStatus.loaded} · pending {isoStatus.pending}
              {' '}· points {isoStatus.residentPoints.toLocaleString()} resident, {isoStatus.drawnPoints.toLocaleString()} drawn
            </div>
          )}
          {/* Height band (m above the tree base) the nearby points must
              fall in — e.g. 0–4 m shows just the near-ground band around
              the trunk, hiding the canopy clutter overhead. */}
          <ZBand filters={filters} setFilters={setFilters} />
          <label className="flex items-center justify-between cursor-pointer" title="Fade the grey unassigned points with view depth: nearer = lighter, farther = darker, so the background reads with depth instead of as a flat grey wall. The ramp is fitted to the depth the shown points actually occupy, from this camera angle, and re-fits as you orbit.">
            <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>Depth-cue the grey background</span>
            <Toggle
              on={display.depthCueUnassigned}
              onChange={(v) => setDisplay({ depthCueUnassigned: v })}
            />
          </label>
          {display.depthCueUnassigned && (
            <div className="flex items-center gap-2 pl-1">
              <span className="mono text-[10px]" style={{ color: 'var(--text-mute)', width: 52 }}>strength</span>
              <input
                type="range" min={0} max={1} step={0.05} value={display.depthCueStrength}
                onChange={(e) => setDisplay({ depthCueStrength: parseFloat(e.target.value) })}
                className="flex-1"
                title="0 leaves the background flat; 1 runs the full ramp from bright at the near edge to nearly black at the far one."
              />
              <span className="mono text-[10px] tnum" style={{ color: 'var(--text-dim)', width: 34, textAlign: 'right' }}>
                {Math.round(display.depthCueStrength * 100)}%
              </span>
            </div>
          )}
          {display.depthCueUnassigned && display.colorMode !== 'tree_id' && (
            <div className="mono text-[9px]" style={{ color: '#e6c068', lineHeight: 1.4 }}>
              Inactive in the <b>{String(display.colorMode)}</b> colour mode — the cue only applies to the grey
              unassigned points, which only exist as grey under <b>tree_id</b> colouring.
            </div>
          )}
          {display.depthCueUnassigned && display.colorMode === 'tree_id' && !filters.isolateShowUnassigned && (
            <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
              Inactive until <b>Show unassigned (id 0) nearby</b> is on — there is no grey background to cue.
            </div>
          )}
          <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
            The whole isolated tree loads in full detail at any zoom, so you can edit every point. Toggle on the nearby rings to pull stray points into the tree (set their id), trim extras (set id 0), or move points between neighbouring crowns. Edits save as usual.
          </div>
        </div>
      )}

      {error && (
        <div className="mono text-[10px]" style={{ color: 'var(--danger, #e0506b)', lineHeight: 1.5 }}>
          {error}
        </div>
      )}

      {sorted && (
        <>
          {/* Label + chips on one line, always: the label gives way (it
              truncates) before the chips wrap or the row overflows. */}
          <div className="flex items-center justify-between gap-2">
            <span className="mono text-[10.5px] truncate min-w-0" style={{ color: 'var(--text-dim)' }}>
              {nTreeFilters > 0 || statusFilter !== 'all' ? `${realTrees} / ${totalTrees}` : realTrees} tree{realTrees === 1 ? '' : 's'}
            </span>
            <div className="flex items-center gap-1 shrink-0">
              <SortChip label="id" active={sort === 'id'} onClick={() => setSort('id')} />
              <SortChip label="count" active={sort === 'count'} onClick={() => setSort('count')} />
              <SortChip label={nTreeFilters > 0 ? `filter·${nTreeFilters}` : 'filter'} active={showTf || nTreeFilters > 0} onClick={() => setShowTf(s => !s)} />
              <SortChip label="map" active={showMap} onClick={() => setShowMap(s => !s)} />
              <span className="w-px h-3 mx-0.5" style={{ background: 'var(--line)' }} />
              <SortChip label="merge" active={mergeMode} onClick={() => { setMergeMode(m => !m); setMergeSel(new Set()); }} />
            </div>
          </div>

          {/* Review progress + status filter — sweep the list marking each
              tree ok / flag; the filter narrows ‹ › to the ones left. */}
          {!mergeMode && (
            <div className="flex items-center justify-between gap-2">
              <span className="mono text-[10px] truncate min-w-0" style={{ color: 'var(--text-mute)' }}>
                reviewed <span style={{ color: 'var(--text)' }}>{reviewedCount}</span> / {totalTrees}
                {flaggedCount > 0 && <> · <span style={{ color: '#e6c068' }}>{flaggedCount} flagged</span></>}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <SortChip label="all" active={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
                <SortChip label="todo" active={statusFilter === 'unreviewed'} onClick={() => setStatusFilter('unreviewed')} />
                <SortChip label="⚑" active={statusFilter === 'flag'} onClick={() => setStatusFilter('flag')} />
                <SortChip label="✓" active={statusFilter === 'ok'} onClick={() => setStatusFilter('ok')} />
              </div>
            </div>
          )}

          {/* Species-assignment progress — separate from review status;
              a tree can be reviewed-OK and still have no species. */}
          {!mergeMode && (
            <div className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
              species <span style={{ color: 'var(--text)' }}>{speciesAssignedCount}</span> / {totalTrees} assigned
              {speciesAssignedCount < totalTrees && (
                <> · <span style={{ color: '#e6c068' }}>{totalTrees - speciesAssignedCount} unassigned</span></>
              )}
            </div>
          )}

          {/* Bulk species assignment — the point of the feature: a
              forester assigns species to a stand or a row at once, not
              tree by tree. Applies to whatever the list shows now (the
              "filter" chip above narrows it); confirmed so a stray
              click can't relabel the whole plot. */}
          {!mergeMode && (
            <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ background: 'var(--wash-1)', border: '1px solid var(--line)' }}>
              {/* The dropdown gets the whole line. Beside a button it had
                  to show "Scots pine (Pinus sylvestris)" in what was left,
                  and a <select> does not shrink below its longest option:
                  it pushed the button out of the frame instead, leaving
                  "Ass" and a horizontal scrollbar. */}
              <select
                value={bulkSpecies}
                onChange={(e) => setBulkSpecies(e.target.value)}
                className="w-full min-w-0 mono text-[11px] py-1 px-1.5 rounded-md outline-none"
                style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                title={SPECIES_DENSITIES.find(s => s.key === bulkSpecies)?.label}
              >
                {SPECIES_DENSITIES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <button
                className="btn !h-7 w-full justify-center mono text-[11px] whitespace-nowrap"
                disabled={realTrees === 0}
                onClick={bulkAssignSpecies}
                title="Assign this species to every tree currently matching the filters"
              >
                Assign → {realTrees} tree{realTrees === 1 ? '' : 's'}
              </button>
              <Hint>Bulk-assigns to whatever the list shows now ({realTrees} of {totalTrees}) — narrow with the filter chip above first.</Hint>
            </div>
          )}

          {/* Search filters — hunt problem trees, then step through the
              matches with ‹ › fixing each one. */}
          {showTf && (
            <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ background: 'var(--wash-1)', border: '1px solid var(--line)' }}>
              <div className="flex items-center justify-between">
                <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Search filters</span>
                {nTreeFilters > 0 && (
                  <button className="mono text-[10px]" style={{ color: 'var(--accent)' }} onClick={clearTreeFilters}>clear</button>
                )}
              </div>
              <FilterRange label="Tree id" min={fMinId} max={fMaxId} setMin={setFMinId} setMax={setFMaxId} step={1} />
              <div className="flex items-center gap-1.5">
                <span
                  className="mono text-[10px] w-[88px] shrink-0"
                  style={{ color: 'var(--text-dim)' }}
                  title="Narrow the list to one species — or to the trees that still have none, which is what the bulk-assign above is for."
                >Species</span>
                <select
                  value={fSpecies}
                  onChange={(e) => setFSpecies(e.target.value)}
                  className="flex-1 min-w-0 mono text-[10px] py-0.5 px-1 rounded-md outline-none"
                  style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                >
                  <option value="">any</option>
                  <option value="-">unassigned ({totalTrees - speciesAssignedCount})</option>
                  {SPECIES_DENSITIES.map(sp => <option key={sp.key} value={sp.key}>{sp.label}</option>)}
                </select>
              </div>
              <FilterRange label="Points" min={fMinPts} max={fMaxPts} setMin={setFMinPts} setMax={setFMaxPts} step={100} />
              <FilterRange label="Height m" min={fMinH} max={fMaxH} setMin={setFMinH} setMax={setFMaxH} step={1} />
              <FilterRange label="Footprint ⌀ m" min={fMinDiam} max={fMaxDiam} setMin={setFMinDiam} setMax={setFMaxDiam} step={1} />
              <label
                className="flex items-center gap-1.5 mono text-[10px] cursor-pointer"
                style={{ color: 'var(--text-dim)', userSelect: 'none' }}
                title="Trees whose horizontal bbox is at least double the σ-core (5σ ≈ the real crown span) and ≥ 4 m beyond it — the signature of stray points scattered off the tree. Needs a fresh Re-scan (σ comes from it)."
              >
                <input type="checkbox" checked={fStrays} onChange={(e) => setFStrays(e.target.checked)} />
                Strays suspected (bbox ≫ σ-core)
              </label>
              <div className="flex items-center gap-1.5">
                <span
                  className="mono text-[10px] w-[88px] shrink-0"
                  style={{ color: 'var(--text-dim)' }}
                  title="Horizontal distance to the nearest OTHER tree's centre. A MAX sweeps the over-segmentation candidates — two stems 0.5 m apart are almost always one tree the segmenter split. A MIN sweeps the opposite: a cluster standing alone in a gap where no real tree should be."
                >Neighbour m</span>
                <FNum value={fMinNeighbour} placeholder="min" step={0.5} onChange={setFMinNeighbour} />
                <FNum value={fMaxNeighbour} placeholder="max" step={0.5} onChange={setFMaxNeighbour} />
              </div>
              {/* Under the inputs, not beside them: beside, it shared the
                  row's spare width equally with the two boxes and came
                  out four lines tall on a word each. */}
              <div className="mono text-[9.5px] -mt-1" style={{ color: 'var(--text-mute)', paddingLeft: 94 }}>
                {nearestNeighbour.size === 0 && trees && trees.length > 2
                  ? 'needs Re-scan'
                  : 'max → over-seg · min → strays'}
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className="mono text-[10px] w-[88px] shrink-0"
                  style={{ color: 'var(--text-dim)' }}
                  title="Points per m³ of the tree's σ-core box. A real tree and a sparse noise cluster can carry the same point count — density separates them. Set a max to find the thin, cloud-like clusters."
                >Density ≤ /m³</span>
                <FNum value={fMaxDensity} placeholder="max" step={10} onChange={setFMaxDensity} />
                <span className="mono text-[9.5px] flex-1" style={{ color: 'var(--text-mute)' }}>sparse clusters</span>
              </div>

              {/* Metrics-based filters — need the per-tree metrics cache. */}
              <div style={{ opacity: metrics ? 1 : 0.55 }} className="flex flex-col gap-1.5">
                <FilterRange label="DBH cm" min={fMinDbh} max={fMaxDbh} setMin={setFMinDbh} setMax={setFMaxDbh} step={1} disabled={!metrics} />
                <FilterRange label="Crown ⌀ m" min={fMinCrown} max={fMaxCrown} setMin={setFMinCrown} setMax={setFMaxCrown} step={0.5} disabled={!metrics} />
                <div className="flex items-center gap-1.5">
                  <span
                    className="mono text-[10px] w-[88px] shrink-0"
                    style={{ color: 'var(--text-dim)' }}
                    title="Stem lean from vertical. The plot's leaners are the storm-damage sweep — and a segment that 'leans' 40° is usually two trees merged, not one leaning one. Trees whose lean could not be fitted (one band only) never match."
                  >Lean ≥ °</span>
                  <FNum value={fMinLean} placeholder="min" step={1} onChange={setFMinLean} disabled={!metrics} />
                  <span className="mono text-[9.5px] flex-1" style={{ color: 'var(--text-mute)' }}>storm damage</span>
                </div>
              </div>
              <label
                className="flex items-center gap-1.5 mono text-[10px]"
                style={{ color: 'var(--text-dim)', userSelect: 'none', opacity: metrics ? 1 : 0.55, cursor: metrics ? 'pointer' : 'default' }}
                title="Trees where no stem circle could be fit at breast height (DBH = NaN, or the metrics pass skipped the tree entirely) — stemless fragments, buried stumps, fully occluded stems. The QC panel flags these as critical; this filter puts them on the ‹ › stepper."
              >
                <input type="checkbox" disabled={!metrics} checked={fDbhMissing} onChange={(e) => setFDbhMissing(e.target.checked)} />
                DBH missing (no stem fit)
              </label>
              <label
                className="flex items-center gap-1.5 mono text-[10px]"
                style={{ color: 'var(--text-dim)', userSelect: 'none', opacity: metrics ? 1 : 0.55, cursor: metrics ? 'pointer' : 'default' }}
                title="Only trees the QC checks flagged — the same engine the QC panel runs (missing DBH fit, under- / over-segmented crown, odd slenderness, height outlier, sparse points). Sweep them with ‹ ›."
              >
                <input type="checkbox" disabled={!metrics} checked={fQcOnly} onChange={(e) => setFQcOnly(e.target.checked)} />
                QC-flagged only{metrics && qcFlaggedCount > 0 ? ` (${qcFlaggedCount})` : ''}
              </label>
              {!metrics && (
                <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
                  DBH filters need per-tree metrics —{' '}
                  <button
                    className="mono text-[9.5px]"
                    style={{ color: 'var(--accent)' }}
                    disabled={!canMetrics || computingMetrics}
                    onClick={() => void computeMetrics()}
                  >
                    {computingMetrics ? 'computing…' : 'Compute metrics'}
                  </button>
                  {dbhFiltersSetButInert ? ' — the set DBH bounds are inactive until then.' : '.'}
                </div>
              )}

              <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
                Height / ⌀ read from the scan bbox — no metrics pass needed.
                ‹ › steps through the {nTreeFilters > 0 ? 'matching' : 'whole'} list;
                e.g. Points max 500 sweeps the fragments.
              </div>
            </div>
          )}

          {/* Top-down plot map — spatial context the list can't give:
              over-segmentation reads as two dots on top of each other,
              and review progress is visible across the whole plot. */}
          {showMap && trees && (
            <PlotMap
              trees={trees}
              matching={matchingIds}
              selectedId={selectedId}
              reviewStatus={reviewStatus}
              qcWorst={qcWorst}
              onPick={focusTree}
            />
          )}

          {/* Jump straight to an id — faster than scrolling 200+ rows */}
          {!mergeMode && (
            <div className="flex items-center gap-1.5">
              <input
                type="number" min={1} placeholder="go to tree id…"
                value={jumpId}
                onChange={(e) => setJumpId(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); jumpToId(); } }}
                className="flex-1 mono text-[11px] py-1 px-2 rounded-md"
                style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', outline: 'none' }}
                title="Type a tree id and press Enter to isolate + fly to it"
              />
              <button
                className="btn !h-7 !px-2 mono text-[11px]"
                disabled={jumpId.trim() === ''}
                onClick={jumpToId}
                title="Isolate + fly to this id"
              >
                Go
              </button>
            </div>
          )}
          {jumpError && (
            <div className="mono text-[9.5px]" style={{ color: '#e6c068' }}>{jumpError}</div>
          )}

          {/* Prev / next stepper — review mode only */}
          {!mergeMode && (
            <div className="flex items-center gap-1.5">
              <button className="btn !h-7 !px-2 mono text-[12px]" disabled={sorted.length === 0} onClick={() => step(-1)} title="Previous tree (←)">‹</button>
              <div className="flex-1 text-center mono text-[11px] flex items-center justify-center gap-1" style={{ color: selectedId != null ? 'var(--accent)' : 'var(--text-mute)' }}>
                {selectedId != null && selectedId > 0 && reviewStatus.get(selectedId) === 'ok' && <span style={{ color: '#67d391' }}>✓</span>}
                {selectedId != null && selectedId > 0 && reviewStatus.get(selectedId) === 'flag' && <span style={{ color: '#e6c068' }}>⚑</span>}
                {selectedId != null ? `tree ${selectedId}` : 'none selected'}
              </div>
              <button className="btn !h-7 !px-2 mono text-[12px]" disabled={sorted.length === 0} onClick={() => step(1)} title="Next tree (→)">›</button>
            </div>
          )}

          {/* Species for the selected tree — feeds the biomass maths
              (MetricsModule) and the report. Unassigned uses whatever
              fallback species those panels have chosen instead. */}
          {!mergeMode && selectedId != null && selectedId > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="mono text-[10px] shrink-0" style={{ color: 'var(--text-dim)' }}>Species</span>
              <select
                value={speciesByTree.get(selectedId) ?? ''}
                onChange={(e) => setTreeSpecies(selectedId, e.target.value || null)}
                className="flex-1 min-w-0 mono text-[11px] py-1 px-1.5 rounded-md outline-none"
                style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                title={`Species used by the biomass / carbon estimate for this tree${speciesByTree.get(selectedId) ? ` — ${SPECIES_DENSITIES.find(s => s.key === speciesByTree.get(selectedId))?.label ?? ''}` : ''}`}
              >
                <option value="">— unassigned —</option>
                {SPECIES_DENSITIES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
          )}

          {/* Mark reviewed / flag + auto-advance — the sweep keystrokes */}
          {!mergeMode && (
            <div className="flex items-center gap-1.5">
              <button
                className="btn !h-7 flex-1 justify-center gap-1 mono text-[11px]"
                disabled={selectedId == null || selectedId <= 0}
                onClick={() => markCurrent('ok')}
                title="Mark this tree reviewed-OK and jump to the next (R). Click again to un-mark."
                style={reviewStatus.get(selectedId ?? -1) === 'ok'
                  ? { background: 'rgba(103,211,145,0.14)', borderColor: 'color-mix(in oklch, #67d391 55%, transparent)', color: '#8fe3af' } : undefined}
              >
                ✓ Reviewed
              </button>
              <button
                className="btn !h-7 flex-1 justify-center gap-1 mono text-[11px]"
                disabled={selectedId == null || selectedId <= 0}
                onClick={() => markCurrent('flag')}
                title="Flag this tree to come back to and jump to the next (F). Click again to un-flag."
                style={reviewStatus.get(selectedId ?? -1) === 'flag'
                  ? { background: 'rgba(230,192,104,0.14)', borderColor: 'color-mix(in oklch, #e6c068 55%, transparent)', color: '#eccd85' } : undefined}
              >
                ⚑ Flag
              </button>
            </div>
          )}

          {/* Crown split — inverse of merge. Visible only when a tree
              is isolated (the lasso then implicitly stays inside it). */}
          {!mergeMode && isolating && (
            <div
              className="rounded-md p-2 flex flex-col gap-1.5"
              style={{
                background: 'var(--wash-1)',
                border: '1px solid var(--line)',
              }}
            >
              <div className="mono text-[10px]" style={{ color: 'var(--text-dim)', lineHeight: 1.45 }}>
                Lasso the portion of tree <span style={{ color: 'var(--accent)' }}>{filters.isolateTreeId}</span> to split off, then click below. The peeled-off subset becomes a fresh tree (id auto-picked); the original keeps its id.
              </div>
              <button
                className="btn !h-7 mono text-[11px] justify-center"
                disabled={!api || splitting}
                onClick={() => void doSplit()}
                title="Split off the lassoed subset into a new tree_id"
              >
                {splitting ? 'Splitting…' : 'Split off lassoed points → new tree'}
              </button>
            </div>
          )}

          {/* Absorb the visible grey ring into the isolated tree — the
              common "stem base / strays left unlabeled" fix, without
              lassoing by hand. Two steps on purpose: select first (they
              light up red so you SEE what you're about to take), assign
              second. Undo restores the selection if you misfire. */}
          {!mergeMode && isolating && filters.isolateShowUnassigned && (
            <div
              className="rounded-md p-2 flex flex-col gap-1.5"
              style={{ background: 'var(--wash-1)', border: '1px solid var(--line)' }}
            >
              <div className="mono text-[10px]" style={{ color: 'var(--text-dim)', lineHeight: 1.45 }}>
                Pull the visible unassigned (grey) points into tree <span style={{ color: 'var(--accent)' }}>{filters.isolateTreeId}</span> — the margin ring + height band decide which ones are visible, so narrow those first.
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  className="btn !h-7 flex-1 mono text-[11px] justify-center"
                  disabled={!api}
                  onClick={() => {
                    const n = api?.selectVisibleUnassigned() ?? 0;
                    setAbsorbNote(n === 0 ? 'No visible unassigned points to take.' : null);
                  }}
                  title="Select every grey (unassigned) point currently on screen"
                >
                  Select visible grey
                </button>
                <button
                  className="btn btn-primary !h-7 flex-1 mono text-[11px] justify-center"
                  disabled={!api || selectedCount === 0 || filters.isolateTreeId == null}
                  onClick={() => {
                    const id = filters.isolateTreeId;
                    if (id == null) return;
                    const n = api?.applyToSelection({ treeId: id }) ?? 0;
                    api?.clearSelection();
                    setAbsorbNote(n > 0 ? `Assigned ${n.toLocaleString()} points to tree ${id}. Save to persist.` : null);
                  }}
                  title="Assign the selected points to the isolated tree"
                >
                  {selectedCount > 0 ? `Assign ${selectedCount.toLocaleString()} →` : 'Assign →'}
                </button>
              </div>
              {absorbNote && (
                <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>{absorbNote}</div>
              )}
            </div>
          )}

          {/* Per-tree metrics — compute once, then a card per selected tree.
              Read-only native pass (same numbers as the Metrics module). */}
          {!mergeMode && (
            <div className="flex flex-col gap-1.5">
              {!metrics ? (
                <>
                  <button
                    className="btn !h-7 w-full justify-center gap-1.5 mono text-[11px]"
                    disabled={!canMetrics || computingMetrics}
                    onClick={computeMetrics}
                    title="Compute height / DBH / basal area / crown for every tree (needs ground classified)"
                  >
                    📐 {computingMetrics ? `Computing metrics… ${Math.round(metricsPct * 100)}%` : 'Compute metrics'}
                  </button>
                  {computingMetrics && (
                    <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: 'var(--wash-3)' }}>
                      <div style={{ width: `${Math.round(metricsPct * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
                    </div>
                  )}
                </>
              ) : selectedId != null && selectedId > 0 ? (
                <>
                  <MetricCard m={selMetric} treeId={selectedId} onRecompute={computeMetrics} recomputing={computingMetrics} pct={metricsPct} />
                  {/* Neighbour distance for the selected tree — the number
                      the over-segmentation filter thresholds on. */}
                  {nearestNeighbour.get(selectedId) !== undefined && (
                    <div className="mono text-[9.5px] px-2" style={{ color: 'var(--text-mute)' }}>
                      nearest tree {nearestNeighbour.get(selectedId)!.toFixed(2)} m away
                      {nearestNeighbour.get(selectedId)! < 1.0 && <span style={{ color: '#e6c068' }}> · suspiciously close</span>}
                    </div>
                  )}
                  {/* QC findings for this tree — why it's flagged + what to do */}
                  {(qcByTree.get(selectedId) ?? []).map((f, i) => (
                    <div
                      key={i}
                      className="mono text-[9.5px] px-2 py-1.5 rounded-md"
                      style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderLeft: `3px solid ${SEV_COLOR[f.severity]}`, lineHeight: 1.45 }}
                    >
                      <span style={{ color: SEV_COLOR[f.severity] }}>{f.severity}</span> · {f.reason}
                      <div style={{ color: 'var(--text-mute)' }}>→ {f.hint}</div>
                    </div>
                  ))}
                </>
              ) : (
                <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: 'var(--text-mute)', background: 'var(--wash-1)', lineHeight: 1.5 }}>
                  Metrics ready — pick a tree (click a row or use ←/→) to see its forestry attributes.
                  <button className="mono text-[10px] ml-1" style={{ color: 'var(--accent)' }} onClick={computeMetrics} disabled={computingMetrics}>{computingMetrics ? `recomputing… ${Math.round(metricsPct * 100)}%` : 'recompute'}</button>
                </div>
              )}
            </div>
          )}

          {/* Merge action bar */}
          {mergeMode && (
            <div className="flex flex-col gap-1.5 p-2 rounded-md" style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid var(--line)' }}>
              <div className="flex items-center gap-1.5">
                <span className="mono text-[10.5px]" style={{ color: 'var(--text-dim)' }}>Merge {sourcesToMerge.length} → tree</span>
                <input
                  type="number" min={1}
                  value={mergeTarget === '' ? '' : mergeTarget}
                  placeholder={String(tools.activeTreeId)}
                  onChange={(e) => { const t = e.target.value.trim(); setMergeTarget(t === '' ? '' : Math.max(1, parseInt(t, 10) || 1)); }}
                  className="w-16 mono text-[12px] py-1 px-2 rounded-md"
                  style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', outline: 'none' }}
                />
              </div>
              <button
                className="btn btn-primary !h-7 w-full justify-center mono text-[11px]"
                disabled={!api || merging || sourcesToMerge.length === 0 || target <= 0}
                onClick={doMerge}
                title="Fold every selected tree into the target id"
              >
                {merging ? 'Merging…' : `Merge into tree ${target > 0 ? target : '?'}`}
              </button>
              <Hint>Click rows to pick sources · the target keeps its id · reversible below.</Hint>
            </div>
          )}

          {/* The list */}
          <div ref={listRef} className="flex flex-col gap-0.5 overflow-y-auto pr-0.5 scroll-thin" style={{ maxHeight: 260 }}>
            {sorted.map(t => {
              const active = t.treeId === selectedId;
              const unassigned = t.treeId <= 0;
              const picked = mergeSel.has(t.treeId);
              const isTarget = mergeMode && t.treeId === target;
              const [r, g, b] = unassigned ? UNASSIGNED_RGB : treeIdColor(t.treeId);
              const dims = treeDims(t);
              const highlight = mergeMode ? picked : active;
              return (
                <button
                  key={t.treeId}
                  data-tid={t.treeId}
                  onClick={() => (mergeMode ? toggleMergePick(t.treeId) : focusTree(t))}
                  disabled={mergeMode && unassigned}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md transition-all text-left"
                  style={{
                    border: `1px solid ${highlight ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : (isTarget ? 'color-mix(in oklch, var(--accent) 30%, transparent)' : 'transparent')}`,
                    background: highlight ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
                    opacity: mergeMode && unassigned ? 0.4 : 1,
                  }}
                  onMouseEnter={(e) => { if (!highlight) e.currentTarget.style.background = 'var(--wash-2)'; }}
                  onMouseLeave={(e) => { if (!highlight) e.currentTarget.style.background = 'transparent'; }}
                >
                  {mergeMode && (
                    <span style={{
                      width: 13, height: 13, borderRadius: 3, flexShrink: 0,
                      border: `1.5px solid ${picked ? 'var(--accent)' : 'var(--line-strong)'}`,
                      background: picked ? 'var(--accent)' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {picked && <span style={{ color: '#06140d', fontSize: 9, fontWeight: 800, lineHeight: 1 }}>✓</span>}
                    </span>
                  )}
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: `rgb(${r},${g},${b})`, boxShadow: '0 0 0 1px rgba(255,255,255,0.15)', flexShrink: 0 }} />
                  <div className="flex-1 min-w-0">
                    <div className="mono text-[11px] flex items-center gap-1" style={{ color: highlight ? 'var(--accent)' : 'var(--text)' }}>
                      {!unassigned && reviewStatus.get(t.treeId) === 'ok' && <span style={{ color: '#67d391', flexShrink: 0 }}>✓</span>}
                      {!unassigned && reviewStatus.get(t.treeId) === 'flag' && <span style={{ color: '#e6c068', flexShrink: 0 }}>⚑</span>}
                      <span className="truncate">{unassigned ? 'unassigned' : `tree ${t.treeId}`}{isTarget ? ' · target' : ''}</span>
                      {!unassigned && speciesByTree.get(t.treeId) && (
                        <span
                          className="mono"
                          style={{ fontSize: 8.5, color: 'var(--text-dim)', background: 'var(--wash-2)', borderRadius: 3, padding: '1px 4px', flexShrink: 0, letterSpacing: '0.02em' }}
                          title={SPECIES_DENSITIES.find(s => s.key === speciesByTree.get(t.treeId))?.label ?? speciesByTree.get(t.treeId)}
                        >
                          {speciesAbbrev(speciesByTree.get(t.treeId)!)}
                        </span>
                      )}
                      {!unassigned && qcWorst.get(t.treeId) && (
                        <span
                          style={{ color: SEV_COLOR[qcWorst.get(t.treeId)!], flexShrink: 0, marginLeft: 'auto' }}
                          title={`QC: ${(qcByTree.get(t.treeId) ?? []).map(f => f.reason).join(' · ')}`}
                        >●</span>
                      )}
                    </div>
                    <div className="mono text-[9px] tnum" style={{ color: 'var(--text-mute)' }}>
                      {(() => {
                        const rm = metrics?.get(t.treeId);
                        if (rm && Number.isFinite(rm.height)) {
                          const dbhTxt = Number.isFinite(rm.dbh) ? ` · ⌀ ${(rm.dbh * 100).toFixed(0)}cm` : '';
                          return `h ${rm.height.toFixed(1)}m${dbhTxt} · ${t.count.toLocaleString()} pts`;
                        }
                        return `${t.count.toLocaleString()} pts${dims ? ` · ${dims}` : ''}`;
                      })()}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Active merges — each reversible */}
          {merges.length > 0 && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="chip" style={{ margin: 0 }}>{merges.length} merge{merges.length === 1 ? '' : 's'}</span>
                <button className="mono text-[10px]" style={{ color: 'var(--accent)' }} onClick={clearAllMerges}>clear all</button>
              </div>
              <div className="flex flex-col gap-0.5 overflow-y-auto scroll-thin" style={{ maxHeight: 96 }}>
                {merges.map(([from, to]) => (
                  <div key={from} className="flex items-center justify-between px-2 py-1 rounded mono text-[10px]" style={{ background: 'var(--wash-1)', color: 'var(--text-dim)' }}>
                    <span>tree {from} → {to}</span>
                    <button onClick={() => removeMerge(from)} title="Un-merge" style={{ color: 'var(--text-mute)' }} className="px-1 hover:text-white">✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {!sorted && !scanning && canScan && (
        <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Scan the cloud to list every tree, then click one (or use ←/→) to isolate it and fly the camera to its footprint.
        </div>
      )}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>{children}</div>;
}

/** Forestry-attribute card for the selected tree. Shows tree_id (with the
 *  viewport swatch) + every per-tree metric in a tidy grid. NaN-safe: a
 *  metric that couldn't be fit (e.g. no breast-height band) reads "—". */
function MetricCard({ m, treeId, onRecompute, recomputing, pct }: {
  m: TreeMetric | null; treeId: number; onRecompute: () => void; recomputing: boolean; pct: number;
}) {
  const [r, g, b] = treeIdColor(treeId);
  const fmt = (v: number, digits: number, suffix = '') =>
    Number.isFinite(v) ? `${v.toFixed(digits)}${suffix}` : '—';
  return (
    <div className="rounded-md p-2.5" style={{ border: '1px solid color-mix(in oklch, var(--accent) 35%, transparent)', background: 'color-mix(in oklch, var(--accent) 7%, transparent)' }}>
      <div className="flex items-center gap-2 mb-2">
        <span style={{ width: 13, height: 13, borderRadius: 3, background: `rgb(${r},${g},${b})`, boxShadow: '0 0 0 1px rgba(255,255,255,0.2)', flexShrink: 0 }} />
        <span className="mono text-[12px] font-semibold" style={{ color: 'var(--text)' }}>tree {treeId}</span>
        <button
          className="mono text-[9.5px] ml-auto"
          style={{ color: 'var(--text-mute)' }}
          onClick={onRecompute}
          disabled={recomputing}
          title="Recompute every tree's metrics"
        >{recomputing ? `recomputing… ${Math.round(pct * 100)}%` : '↻ recompute'}</button>
      </div>
      {recomputing && (
        <div className="w-full rounded-full overflow-hidden mb-2" style={{ height: 3, background: 'var(--wash-3)' }}>
          <div style={{ width: `${Math.round(pct * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
        </div>
      )}
      {!m ? (
        <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          No metrics for this tree — it may have too few points, or the metrics
          predate the latest segmentation. <button className="mono text-[10px]" style={{ color: 'var(--accent)' }} onClick={onRecompute} disabled={recomputing}>recompute</button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <MetricCell label="Height" value={fmt(m.height, 1, ' m')} />
          <MetricCell label="DBH" value={Number.isFinite(m.dbh) ? `${(m.dbh * 100).toFixed(1)} cm` : '—'} />
          <MetricCell label="Basal area" value={Number.isFinite(m.basalArea) ? `${m.basalArea.toFixed(3)} m²` : '—'} />
          <MetricCell label="Crown area" value={fmt(m.crownArea, 1, ' m²')} />
          <MetricCell label="Crown ⌀" value={fmt(m.crownDiameter, 1, ' m')} />
          <MetricCell label="Points" value={m.count.toLocaleString()} />
          <MetricCell label="Stem X" value={fmt(m.x, 2, ' m')} />
          <MetricCell label="Stem Y" value={fmt(m.y, 2, ' m')} />
          <MetricCell label="Base Z" value={fmt(m.baseZ, 2, ' m')} />
        </div>
      )}
    </div>
  );
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="mono text-[8.5px] uppercase" style={{ color: 'var(--text-mute)', letterSpacing: '0.05em' }}>{label}</span>
      <span className="mono text-[12px] tnum" style={{ color: 'var(--text)' }}>{value}</span>
    </div>
  );
}

/** Height-band control for the nearby-points ring: a toggle plus low/high
 *  inputs in metres ABOVE THE ISOLATED TREE'S BASE. Off (null) = the
 *  whole margin-box height. The max is derived from the tree's own bbox
 *  height + margin so the inputs always cover a sensible span. */
/** Which neighbouring trees to show while "Show other trees nearby" is
 *  on. Listed nearest-first with the colour the viewer paints each one,
 *  so a chip can be matched to a crown on screen without guessing.
 *
 *  `picked === null` means "all of them" — the behaviour before this
 *  existed, and still the default whenever a new tree is selected. An
 *  empty array means none, which is a real state and not the same as
 *  null: it is what you want the moment before you pick the one crown
 *  you are actually separating from.
 */
function NeighbourPicker({ neighbours, picked, onChange, onGo }: {
  neighbours: { id: number; dist: number; count: number }[];
  picked: number[] | null;
  onChange: (ids: number[] | null) => void;
  onGo: (id: number) => void;
}) {
  const all = picked === null;
  const set = new Set(picked ?? []);
  // Count only picks that are still IN the list: narrowing the margin
  // drops neighbours out of it without touching the picks, and "showing
  // 4" beside two chips is a lie about what is on screen.
  const shown = neighbours.reduce((n, x) => n + (set.has(x.id) ? 1 : 0), 0);
  const toggle = (id: number) => {
    // The first pick from "all" starts a list containing just that one,
    // which is what clicking a single chip out of a full set means.
    if (all) { onChange([id]); return; }
    const nextIds = new Set(set);
    if (nextIds.has(id)) nextIds.delete(id); else nextIds.add(id);
    onChange([...nextIds].sort((a, b) => a - b));
  };

  if (neighbours.length === 0) {
    return (
      <div className="mono text-[9.5px] pl-1" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
        No other tree reaches into this neighbourhood. Widen <b>margin</b> to look further out
        {' '}— or this tree really does stand alone.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 pl-1">
      <div className="flex items-center justify-between">
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
          {neighbours.length} neighbour{neighbours.length === 1 ? '' : 's'}
          {' · '}
          {all ? 'showing all' : `showing ${shown}`}
        </span>
        <div className="flex items-center gap-1">
          <button
            className="mono text-[9.5px] px-1 rounded"
            style={{ color: all ? 'var(--accent)' : 'var(--text-dim)' }}
            onClick={() => onChange(null)}
            title="Show every neighbouring tree inside the margin box"
          >all</button>
          <button
            className="mono text-[9.5px] px-1 rounded"
            style={{ color: (!all && shown === 0) ? 'var(--accent)' : 'var(--text-dim)' }}
            onClick={() => onChange([])}
            title="Hide every neighbour — just the isolated tree and (if on) the grey background"
          >none</button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {neighbours.map(n => {
          const on = all || set.has(n.id);
          const [r, g, b] = treeIdColor(n.id);
          return (
            <span
              key={n.id}
              className="inline-flex items-center rounded overflow-hidden"
              style={{ border: `1px solid ${on ? 'var(--line-strong)' : 'var(--line)'}` }}
            >
              <button
                className="mono text-[9.5px] pl-1 pr-1 py-0.5 inline-flex items-center gap-1"
                style={{
                  background: on ? 'var(--wash-3)' : 'transparent',
                  color: on ? 'var(--text)' : 'var(--text-mute)',
                }}
                onClick={() => toggle(n.id)}
                title={`${n.count.toLocaleString()} pts · centre ${n.dist.toFixed(2)} m away — click to ${on ? 'hide' : 'show'}`}
              >
                <span
                  className="inline-block rounded-full shrink-0"
                  style={{
                    width: 6, height: 6,
                    background: `rgb(${r},${g},${b})`,
                    opacity: on ? 1 : 0.35,
                  }}
                />
                {n.id}
                <span className="tnum" style={{ color: 'var(--text-mute)' }}>{n.dist.toFixed(1)}m</span>
              </button>
              <button
                className="mono text-[9.5px] px-1 py-0.5"
                style={{ color: 'var(--text-mute)', borderLeft: '1px solid var(--line)' }}
                onClick={() => onGo(n.id)}
                title={`Isolate tree ${n.id} instead`}
              >→</button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Height band presets, as [low, high] metres above the tree base.
 *  `hi === null` means "to the top of the band's range". */
const Z_PRESETS: { label: string; lo: number; hi: number | null; title: string }[] = [
  { label: 'stump', lo: 0, hi: 0.5, title: 'The ground-level ring at the base — where the unlabelled tyvi usually sits' },
  { label: 'dbh', lo: 1.0, hi: 1.6, title: 'The breast-height band the DBH circle is fitted across' },
  { label: 'stem', lo: 0, hi: 4, title: 'Trunk and the first branches — the default when the band is switched on' },
  { label: 'crown', lo: 5, hi: null, title: 'Everything above 5 m — the crown, with the trunk clutter out of the way' },
];

/** Height band (metres above the isolated tree's base) for the nearby
 *  points, and optionally for the tree itself.
 *
 *  Was a toggle, two number boxes and a slider that moved only the TOP
 *  edge — so setting a mid-trunk slice meant typing both numbers, and
 *  the one draggable control could not express the thing the band is
 *  most used for. Both edges drag now, the presets cover the bands a
 *  forester actually asks for, and the band can cut the isolated tree
 *  as well as its surroundings.
 */
function ZBand({ filters, setFilters }: {
  filters: {
    isolateZRange: [number, number] | null;
    isolateBox: [[number, number, number], [number, number, number]] | null;
    isolateMargin: IsolateMargin;
    isolateZBandCutsTree: boolean;
  };
  setFilters: (patch: { isolateZRange?: [number, number] | null; isolateZBandCutsTree?: boolean }) => void;
}) {
  const treeSpan = filters.isolateBox
    ? Math.min(filters.isolateBox[1][2] - filters.isolateBox[0][2], 60)
    : 30;
  // The band reaches as far up as the box does: the tree plus its
  // UPWARD reach — the horizontal ones do not raise the top.
  const max = Math.max(1, Math.ceil(treeSpan + marginReach(filters.isolateMargin)[5]));
  const zr = filters.isolateZRange;
  const on = zr !== null;
  const lo = zr ? zr[0] : 0;
  const hi = zr ? zr[1] : max;
  const clampBand = (a: number, b: number): [number, number] => {
    const l = Math.max(0, Math.min(max, a));
    const h = Math.max(0, Math.min(max, b));
    return l <= h ? [l, h] : [h, l];
  };
  const setBand = (a: number, b: number) => setFilters({ isolateZRange: clampBand(a, b) });

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center justify-between cursor-pointer" title="Show points only inside this height band, measured in metres above the isolated tree's base. A low edge of exactly 0 means 'from the base up' and keeps the ground-level ring at the stump (the often-unlabelled tyvi) that a strict clip would hide; raise it above 0 for a floating slice.">
        <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>Height band (above base)</span>
        <Toggle
          on={on}
          onChange={(v) => setFilters({ isolateZRange: v ? [0, Math.min(4, max)] : null })}
        />
      </label>
      {on && (
        <div className="flex flex-col gap-1 pl-1">
          <div className="flex items-center gap-1.5">
            <input
              type="number" min={0} max={max} step={0.5} value={lo}
              onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setBand(v, hi); }}
              className="w-14 mono text-[11px] py-0.5 px-1.5 rounded-md text-right"
              style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', outline: 'none' }}
              title="Band low edge (m above the tree base)"
            />
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>–</span>
            <input
              type="number" min={0} max={max} step={0.5} value={hi}
              onChange={(e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) setBand(lo, v); }}
              className="w-14 mono text-[11px] py-0.5 px-1.5 rounded-md text-right"
              style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', outline: 'none' }}
              title="Band high edge (m above the tree base)"
            />
            <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>m</span>
            <span className="mono text-[9.5px] tnum flex-1 text-right" style={{ color: 'var(--text-mute)' }}>
              {(hi - lo).toFixed(1)} m thick
            </span>
          </div>
          {/* Both edges drag. The old single slider moved only the top,
              so a mid-trunk slice could not be dragged at all. */}
          <DualRangeSlider
            min={0} max={max} step={0.5}
            value={[lo, hi]}
            onChange={([a, b]) => setBand(a, b)}
          />
          <div className="flex flex-wrap items-center gap-1">
            {Z_PRESETS.map(pz => {
              const phi = pz.hi === null ? max : Math.min(pz.hi, max);
              const active = Math.abs(lo - pz.lo) < 1e-6 && Math.abs(hi - phi) < 1e-6;
              return (
                <button
                  key={pz.label}
                  className="mono text-[9.5px] px-1.5 py-0.5 rounded"
                  style={{
                    border: `1px solid ${active ? 'var(--line-strong)' : 'var(--line)'}`,
                    background: active ? 'var(--wash-3)' : 'transparent',
                    color: active ? 'var(--text)' : 'var(--text-mute)',
                  }}
                  title={pz.title}
                  onClick={() => setBand(pz.lo, phi)}
                >{pz.label}</button>
              );
            })}
            <button
              className="mono text-[9.5px] px-1.5 py-0.5 rounded"
              style={{ border: '1px solid var(--line)', color: 'var(--text-mute)' }}
              title="Widen the band back to the full height"
              onClick={() => setBand(0, max)}
            >full</button>
          </div>
          <label
            className="flex items-center justify-between cursor-pointer"
            title="Also cut the ISOLATED tree at the band, not just the points around it — the band becomes a true horizontal slice through everything on screen. Only the elevation bounds apply, so a wide crown keeps its edges."
          >
            <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>…cut the isolated tree too</span>
            <Toggle
              on={filters.isolateZBandCutsTree}
              onChange={(v) => setFilters({ isolateZBandCutsTree: v })}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="rounded-full transition-all relative"
      style={{ width: 32, height: 18, background: on ? 'var(--accent)' : 'rgba(255,255,255,0.1)', border: '1px solid var(--line-strong)' }}
    >
      <span
        className="absolute rounded-full transition-all"
        style={{ width: 12, height: 12, top: 2, left: on ? 16 : 2, background: on ? '#06140d' : 'var(--text-dim)' }}
      />
    </button>
  );
}

/** One min…max row of the search-filter block. Empty field = bound off. */
function FilterRange({ label, min, max, setMin, setMax, step, disabled }: {
  label: string; min: number | null; max: number | null;
  setMin: (v: number | null) => void; setMax: (v: number | null) => void;
  step?: number; disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="mono text-[10px] w-[88px] shrink-0" style={{ color: 'var(--text-dim)' }}>{label}</span>
      <FNum value={min} placeholder="min" step={step} onChange={setMin} disabled={disabled} />
      <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>…</span>
      <FNum value={max} placeholder="max" step={step} onChange={setMax} disabled={disabled} />
    </div>
  );
}

/** The isolate margin: one number for every direction, or one field per
 *  DIRECTION, and no ceiling.
 *
 *  It was one slider capped at 10 m. Two things were wrong with that. A
 *  tree whose id also covers a cluster 30 m away — a real case, and the
 *  one a user isolates to fix — could not be reached at all; the reach
 *  is a number now, typed, with no top. And one number is the wrong
 *  shape, and so is one per axis: a stem leaning east wants reach east
 *  and none west, a stump the box cut off wants reach down and none up,
 *  and a crown pressed against its northern neighbour wants none towards
 *  it. Six reaches — west, east, south, north, down, up — say exactly
 *  that.
 *
 *  "same" decides which shape is on screen. While it is on there is ONE
 *  field, because six fields that silently moved together read as six
 *  broken ones — typing 5 into W and watching E, S and N follow was
 *  reported as "no direction works". Switch it off and the six fields
 *  appear, each its own. Whether it is on lives in the filter state
 *  (isolateMarginLinked), so it survives leaving and re-entering
 *  isolation; the arithmetic is marginFields.ts. */
function MarginFields({ value, linked, onChange, onLinkedChange }: {
  value: IsolateMargin;
  linked: boolean;
  onChange: (m: MarginReach) => void;
  onLinkedChange: (linked: boolean) => void;
}) {
  const reach = marginReach(value);
  const field = (i: number, label: string, title: string) => (
    <label className="flex items-center gap-1 flex-1 min-w-0" title={title}>
      <span className="mono text-[10px] shrink-0" style={{ color: 'var(--text-mute)', width: label.length > 1 ? 22 : 10, textAlign: 'center' }}>{label}</span>
      <input
        type="number" min={0} step={0.5} value={reach[i]}
        onChange={(e) => onChange(editReach(value, linked, i, parseFloat(e.target.value)))}
        className="mono text-[10.5px] py-0.5 px-1 rounded-md tnum"
        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', outline: 'none', width: 0, minWidth: 0, flex: 1 }}
      />
    </label>
  );
  const sameToggle = (
    <label className="mono text-[9.5px] flex items-center gap-1 shrink-0 justify-end" style={{ color: 'var(--text-dim)' }}
      title={linked
        ? 'One reach for every direction. Switch off to set west, east, south, north, down and up each on its own.'
        : 'Each direction has its own reach. Switch on to use one number for all six (the W value).'}>
      <input type="checkbox" checked={linked} onChange={(e) => onLinkedChange(e.target.checked)} />
      same
    </label>
  );
  const help = "How far (m) the loaded-in-full + shown-nearby region reaches beyond the tree's box. No ceiling: points of the same id 50 m away are still the tree's.";
  if (linked) {
    return (
      <div className="flex items-center gap-2">
        <span className="mono text-[10px] shrink-0" style={{ color: 'var(--text-mute)', width: 52 }} title={help}>margin</span>
        {field(0, 'all', 'Reach in every direction (m)')}
        <span className="mono text-[10px] shrink-0" style={{ color: 'var(--text-mute)' }}>m</span>
        {sameToggle}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="mono text-[10px] shrink-0" style={{ color: 'var(--text-mute)', width: 52 }} title={help}>margin</span>
        {field(0, DIRECTION_LABELS[0], DIRECTION_TITLES[0])}
        {field(1, DIRECTION_LABELS[1], DIRECTION_TITLES[1])}
        {field(2, DIRECTION_LABELS[2], DIRECTION_TITLES[2])}
        {field(3, DIRECTION_LABELS[3], DIRECTION_TITLES[3])}
      </div>
      <div className="flex items-center gap-2">
        <span className="mono text-[10px] shrink-0" style={{ width: 52 }} />
        {field(4, DIRECTION_LABELS[4], DIRECTION_TITLES[4])}
        {field(5, DIRECTION_LABELS[5], DIRECTION_TITLES[5])}
        <span className="flex-1" />
        {sameToggle}
      </div>
    </div>
  );
}

function FNum({ value, placeholder, step, onChange, disabled }: {
  value: number | null; placeholder: string; step?: number;
  onChange: (v: number | null) => void; disabled?: boolean;
}) {
  return (
    <input
      type="number" step={step} min={0} disabled={disabled}
      value={value ?? ''} placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value.trim();
        onChange(t === '' ? null : Math.max(0, parseFloat(t) || 0));
      }}
      className="flex-1 mono text-[10.5px] py-0.5 px-1.5 rounded-md"
      style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', outline: 'none', width: 0, minWidth: 0 }}
    />
  );
}

function SortChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mono text-[9.5px] px-1.5 py-0.5 rounded transition-all whitespace-nowrap"
      style={{
        color: active ? 'var(--accent)' : 'var(--text-mute)',
        background: active ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
      }}
    >
      {label}
    </button>
  );
}

/** Top-down plan view of every scanned tree, north up. Dots sit at each
 *  tree's density centroid (bbox centre as a fallback), sized mildly by
 *  point count, coloured by review status → QC severity → plain. Trees
 *  filtered out are dimmed rather than hidden, so a filter reads as
 *  "these ones, in context" instead of an unmoored scatter. Clicking
 *  picks the nearest dot. Equal metre-per-pixel on both axes, so
 *  distances (and the over-segmentation "two dots almost touching"
 *  signal) are honest. */
function PlotMap({ trees, matching, selectedId, reviewStatus, qcWorst, onPick }: {
  trees: TreeSummaryEntry[];
  matching: Set<number>;
  selectedId: number | null;
  reviewStatus: Map<number, ReviewStatus>;
  qcWorst: Map<number, Severity>;
  onPick: (t: TreeSummaryEntry) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // World XY per tree (centroid, or bbox centre on a pre-σ scan).
  const pts = useMemo(() => trees
    .filter(t => t.treeId > 0)
    .map(t => ({
      t,
      x: t.centroid ? t.centroid[0] : (t.bboxMin[0] + t.bboxMax[0]) * 0.5,
      y: t.centroid ? t.centroid[1] : (t.bboxMin[1] + t.bboxMax[1]) * 0.5,
    }))
    .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)),
  [trees]);

  // Shared world→pixel mapping, recomputed from the live canvas size so
  // the click handler and the painter can never disagree.
  const project = useCallback((cssW: number, cssH: number) => {
    if (pts.length === 0) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const padW = Math.max((maxX - minX) * 0.06, 1);
    const padH = Math.max((maxY - minY) * 0.06, 1);
    minX -= padW; maxX += padW; minY -= padH; maxY += padH;
    const spanX = Math.max(maxX - minX, 1e-6);
    const spanY = Math.max(maxY - minY, 1e-6);
    // One scale for both axes — a squashed plot would fake the spacing.
    const s = Math.min(cssW / spanX, cssH / spanY);
    const offX = (cssW - spanX * s) * 0.5;
    const offY = (cssH - spanY * s) * 0.5;
    return {
      s,
      toPx: (wx: number, wy: number): [number, number] => [
        offX + (wx - minX) * s,
        // North up: world +Y grows upward, canvas y grows downward.
        cssH - offY - (wy - minY) * s,
      ],
    };
  }, [pts]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth, cssH = c.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
      c.width = cssW * dpr; c.height = cssH * dpr;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const pr = project(cssW, cssH);
    if (!pr) return;

    const maxCount = pts.reduce((m, p) => Math.max(m, p.t.count), 1);
    for (const p of pts) {
      const [px, py] = pr.toPx(p.x, p.y);
      const on = matching.has(p.t.treeId);
      const st = reviewStatus.get(p.t.treeId);
      const sev = qcWorst.get(p.t.treeId);
      // Colour precedence: explicit review verdict, then QC severity,
      // then a neutral dot.
      let fill = 'rgba(200,205,215,0.75)';
      if (st === 'ok') fill = '#67d391';
      else if (st === 'flag') fill = '#e6c068';
      else if (sev === 'critical') fill = '#ffb4be';
      else if (sev === 'warning') fill = '#e6c068';
      // Dim (not hide) the filtered-out ones so the matches read in context.
      ctx.globalAlpha = on ? 1 : 0.18;
      const r = 1.6 + 2.6 * Math.sqrt(p.t.count / maxCount);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      if (p.t.treeId === selectedId) {
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(px, py, r + 3.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff'; // canvas has no CSS vars — literal ring
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // Scale bar — a round metre value about a quarter of the width.
    const targetM = (cssW * 0.25) / pr.s;
    const pow = Math.pow(10, Math.floor(Math.log10(Math.max(targetM, 1e-6))));
    const nice = [1, 2, 5, 10].map(k => k * pow).find(v => v >= targetM * 0.6) ?? pow;
    const barPx = nice * pr.s;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(8, cssH - 8); ctx.lineTo(8 + barPx, cssH - 8);
    ctx.moveTo(8, cssH - 11); ctx.lineTo(8, cssH - 5);
    ctx.moveTo(8 + barPx, cssH - 11); ctx.lineTo(8 + barPx, cssH - 5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '9px ui-monospace,monospace';
    ctx.fillText(`${nice} m`, 8 + barPx + 4, cssH - 5);
    ctx.fillText('N ↑', cssW - 22, 12);
  }, [pts, matching, selectedId, reviewStatus, qcWorst, project]);

  const onClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const pr = project(rect.width, rect.height);
    if (!pr) return;
    let best: TreeSummaryEntry | null = null;
    let bestD2 = 14 * 14; // click tolerance in px
    for (const p of pts) {
      const [px, py] = pr.toPx(p.x, p.y);
      const d2 = (px - mx) ** 2 + (py - my) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = p.t; }
    }
    if (best) onPick(best);
  }, [pts, project, onPick]);

  if (pts.length === 0) {
    return (
      <div className="mono text-[9.5px] px-2 py-2 rounded-md" style={{ color: 'var(--text-mute)', border: '1px solid var(--line)' }}>
        No tree positions yet — run Re-scan trees.
      </div>
    );
  }
  return (
    <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.22)' }}>
      <canvas
        ref={canvasRef}
        onClick={onClick}
        style={{ width: '100%', height: 190, display: 'block', cursor: 'pointer' }}
        title="Top-down plot map — click a dot to isolate that tree. Green = reviewed, amber = flagged / QC warning, red = QC critical; dimmed = filtered out."
      />
    </div>
  );
}

/** Width×Depth×Height in metres from the world bbox (source Z is up).
 *  Returns null for degenerate boxes (single-point trees). */
function treeDims(t: TreeSummaryEntry): string | null {
  const w = t.bboxMax[0] - t.bboxMin[0];
  const d = t.bboxMax[1] - t.bboxMin[1];
  const h = t.bboxMax[2] - t.bboxMin[2];
  if (!Number.isFinite(w) || !Number.isFinite(h)) return null;
  return `h ${h.toFixed(1)}m · ⌀ ${Math.max(w, d).toFixed(1)}m`;
}

/** 2–3 letter row badge for a species key — just the key's own leading
 *  letters, uppercased, so it stays in sync with SPECIES_DENSITIES
 *  without a second lookup table. The list rows are narrow; the full
 *  label rides along in the title tooltip. */
function speciesAbbrev(key: string): string {
  return key.slice(0, 3).toUpperCase();
}
