// Thinning simulator — harvennuksen simulaatio.
//
// Set a target post-thinning basal area (m²/ha) and the panel decides
// which trees to remove and where the strip roads run. The simulation
// is purely advisory — no on-disk edits happen, the user can click an
// individual removed tree to isolate it in the viewport, or export
// the full removed-tree list as CSV to drive a harvester plan or a
// manual review.
//
// The algorithm lives in metrics/thinning.ts (Finnish/Nordic practice:
// strip roads, forced corridor removal, boom-reach candidates, weighted
// scoring, greedy removal to a target basal area). This file is the
// panel around it — controls, plan-view canvas, stats card, CSV.
//
// What the panel owes the user beyond the numbers: which stems the
// arithmetic could not include, where the removed volume came from, and
// when a selected strategy has no input to work with. A harvest plan
// that quietly omits a tree is worse than one that says it cannot
// measure it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import type { QsmResult, TreeMetric } from '../../persistence/octreeReader';
import { useProject } from '../../context/ProjectContext';
import { plotAreaHa as boundaryAreaHa } from '../../utils/plotBoundary';
import { loadTreeMetrics } from '../../metrics/loadMetrics';
import {
  buildTrees, simulate, distToNearestRoad,
  type Strategy, type Tree, type Plan,
} from '../../metrics/thinning';
import { describeVolumeSources } from '../../metrics/volumeFunctions';
import { SPECIES_DENSITIES } from '../../metrics/biomass';
import { csvNum, csvBlob } from '../../io/csv';
import { getCurrency, setCurrency, MAX_CURRENCY_LEN } from '../../metrics/currency';
import { DEFAULT_METRIC_PARAMS } from '../../metrics/params';
import { useCachedTreeMetrics } from '../../metrics/useCachedTreeMetrics';
import { saveCsvFile } from '../../io/saveDownload';

interface Desktop {
  octreeReadQsm?: (dir: string) => Promise<QsmResult | null>;
  octreeReadSpecies?: (dir: string) => Promise<string>;
  octreeTreeSummary?: (dir: string) => Promise<{ treeId: number; count: number; bboxMin: [number, number, number]; bboxMax: [number, number, number] }[]>;
  octreeTreeMetrics?: (dir: string, params: { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number }) => Promise<TreeMetric[]>;
}

// --- Panel --------------------------------------------------------------

export default function ThinningPanel() {
  const { octree, api, setFilters, plotBoundary } = useOctreeShell();
  const { project } = useProject();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  const [metrics, setMetrics] = useState<TreeMetric[] | null>(null);
  // Seeded from the shared metrics cache: another panel may already have
  // measured this cloud, and this panel should then show the numbers
  // rather than a Compute button over data that exists. Reads only — it
  // never starts a pass — and is fingerprint-checked, so what it shows
  // describes the cloud as it is now. See metrics/useCachedTreeMetrics.
  const [metricsAt, setMetricsAt] = useState<number | null>(null);
  const cachedMetrics = useCachedTreeMetrics(desktop, octree?.dir, DEFAULT_METRIC_PARAMS, metricsAt);
  useEffect(() => {
    if (cachedMetrics) { setMetrics(cachedMetrics.rows); setMetricsAt(cachedMetrics.at); }
  }, [cachedMetrics]);
  const [qsm, setQsm] = useState<QsmResult | null>(null);
  const [bboxes, setBboxes] = useState<Map<number, { min: [number, number, number]; max: [number, number, number] }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Tuning.
  const [targetBa, setTargetBa] = useState(18);          // m²/ha
  const [plotArea, setPlotArea] = useState<number | null>(null); // ha — auto unless overridden
  const [autoArea, setAutoArea] = useState(true);
  const [heading, setHeading] = useState(0);             // road heading, degrees
  const [roadSpacing, setRoadSpacing] = useState(20);    // m
  const [roadWidth, setRoadWidth] = useState(4);         // m
  const [boomReach, setBoomReach] = useState(10);        // m
  const [strategy, setStrategy] = useState<Strategy>('low');
  const [pricePerM3, setPricePerM3] = useState(35);      // mixed unit price for the revenue estimate
  // Whose money — see metrics/currency.ts. Shared with the Bucking
  // panel and the report so one plot cannot quote two currencies.
  const [currency, setCurrencyState] = useState<string>(() => getCurrency());
  // Per-tree species (species.json) unlocks the national volume
  // function; without it every tree gets the constant form factor.
  const [speciesByTree, setSpeciesByTree] = useState<Map<number, string>>(new Map());
  const [defaultSpecies, setDefaultSpecies] = useState<string>('pine');

  // Initial load + on-octree-change.
  const refresh = useCallback(async () => {
    if (!project?.folder || !octree?.dir) { setMetrics(null); setQsm(null); setBboxes(null); return; }
    setLoading(true); setError(null);
    try {
      if (desktop?.octreeReadQsm) setQsm(await desktop.octreeReadQsm(octree.dir));
      if (desktop?.octreeReadSpecies) {
        try {
          const obj = JSON.parse(await desktop.octreeReadSpecies(octree.dir)) as Record<string, string>;
          const m = new Map<number, string>();
          for (const [k, v] of Object.entries(obj)) {
            const id = parseInt(k, 10);
            if (Number.isFinite(id) && typeof v === 'string' && v) m.set(id, v);
          }
          setSpeciesByTree(m);
        } catch { setSpeciesByTree(new Map()); }
      }
      if (desktop?.octreeTreeSummary) {
        const list = await desktop.octreeTreeSummary(octree.dir);
        const m = new Map<number, { min: [number, number, number]; max: [number, number, number] }>();
        for (const r of list) m.set(r.treeId, { min: r.bboxMin, max: r.bboxMax });
        setBboxes(m);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project?.folder, octree?.dir, desktop]);
  useEffect(() => { void refresh(); }, [refresh]);

  //
  // `force` separates the two callers. The BUTTON is the user asking for
  // a fresh pass and must get one; the mount effect below is not, and
  // forcing there would throw away a measurement of the whole cloud
  // every time the panel opened — which is the waste the shared cache
  // exists to end.
  const computeMetrics = useCallback(async (force = false) => {
    if (!desktop?.octreeTreeMetrics || !octree?.dir) return;
    setComputing(true); setError(null);
    try {
      await api?.save();
      const res = await loadTreeMetrics(desktop, octree.dir, DEFAULT_METRIC_PARAMS, { force });
      setMetrics(res);
      setMetricsAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setComputing(false);
    }
  }, [desktop, octree?.dir, api]);
  // Auto-load on open. Not forced: with the plot already measured by any
  // other panel this returns from the shared cache without touching the
  // cloud, and only an unmeasured (or edited) plot pays for a pass.
  useEffect(() => { void computeMetrics(); }, [octree?.dir]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Build the per-tree input ---
  // `treeSet` carries what had to be left out as well as what went in:
  // a stem with no fitted DBH has no basal area, so it cannot be in the
  // arithmetic — but dropping it silently made the stand basal area, the
  // removal target, the tree count and the exported harvest list all
  // quietly exclude it.
  const treeSet = useMemo(
    () => buildTrees(metrics ?? [], qsm, bboxes, speciesByTree, defaultSpecies),
    [metrics, qsm, bboxes, speciesByTree, defaultSpecies],
  );
  const trees = treeSet.trees;

  // Auto plot area: the defined plot boundary (a real measurement) wins
  // over the tree-bbox estimate whenever one exists — same priority the
  // Report panel uses, so the two never quote different BA/ha off the
  // same trees. Bbox stays the fallback (and the only option) when no
  // boundary is defined; the "auto" checkbox lets the user override
  // either with a typed value.
  const boundaryPlotArea = useMemo(
    () => (plotBoundary ? boundaryAreaHa(plotBoundary) : null),
    [plotBoundary],
  );
  // Auto-compute plot area from the tree bbox the first time we have
  // data, so the user has a sensible BA/ha figure on first load even
  // without a defined boundary.
  const autoPlotArea = useMemo(() => {
    if (trees.length === 0) return null;
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const t of trees) {
      if (t.x < xMin) xMin = t.x; if (t.x > xMax) xMax = t.x;
      if (t.y < yMin) yMin = t.y; if (t.y > yMax) yMax = t.y;
    }
    return Math.max(0.0025, ((xMax - xMin) * (yMax - yMin)) / 10000);
  }, [trees]);
  useEffect(() => {
    if (!autoArea) return;
    if (boundaryPlotArea != null) setPlotArea(boundaryPlotArea);
    else if (autoPlotArea != null) setPlotArea(autoPlotArea);
  }, [autoArea, boundaryPlotArea, autoPlotArea]);
  // Honesty label for every per-ha figure this panel shows (Plot area
  // row + the Basal area stat line below) — plainly states whether the
  // area came from a measured boundary, a bbox guess, or a manual entry
  // instead of letting all three look equally precise.
  const areaBasisLabel = useMemo(() => {
    if (!autoArea) return 'manual override';
    return boundaryPlotArea != null ? 'defined plot boundary' : 'estimated area (tree bbox)';
  }, [autoArea, boundaryPlotArea]);

  // --- Run the simulation ---
  const plan = useMemo<Plan | null>(() => {
    if (trees.length === 0 || !plotArea) return null;
    return simulate(trees, {
      targetBaPerHa: targetBa, plotAreaHa: plotArea, headingDeg: heading,
      roadSpacing, roadWidth, boomReach, strategy,
    });
  }, [trees, targetBa, plotArea, heading, roadSpacing, roadWidth, boomReach, strategy]);

  // --- Plan-view canvas ---
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dotPx = useRef<{ x: number; y: number; r: number; treeId: number }[]>([]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth, cssH = c.clientHeight;
    if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
      c.width = cssW * dpr; c.height = cssH * dpr;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!plan || trees.length === 0) { dotPx.current = []; return; }

    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const t of trees) {
      if (t.x < xMin) xMin = t.x; if (t.x > xMax) xMax = t.x;
      if (t.y < yMin) yMin = t.y; if (t.y > yMax) yMax = t.y;
    }
    const pad = Math.max(2, (xMax - xMin + yMax - yMin) * 0.04);
    xMin -= pad; yMin -= pad; xMax += pad; yMax += pad;
    const xs = (xMax - xMin) || 1, ys = (yMax - yMin) || 1;
    const s = Math.min((cssW - 24) / xs, (cssH - 24) / ys);
    const ox = 12 + (cssW - 24 - xs * s) * 0.5;
    const oy = 12 + (cssH - 24 - ys * s) * 0.5;
    const toPx = (wx: number, wy: number): [number, number] => [
      ox + (wx - xMin) * s,
      cssH - (oy + (wy - yMin) * s),
    ];

    // Plot frame.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(ox - 0.5, cssH - (oy + ys * s) - 0.5, xs * s + 1, ys * s + 1);

    // Road corridors — translucent bands of width = roadWidth.
    ctx.strokeStyle = 'rgba(230,192,104,0.20)';
    ctx.lineWidth = roadWidth * s;
    for (const r of plan.roads) {
      const [p1x, p1y] = toPx(r.x1, r.y1);
      const [p2x, p2y] = toPx(r.x2, r.y2);
      ctx.beginPath();
      ctx.moveTo(p1x, p1y); ctx.lineTo(p2x, p2y);
      ctx.stroke();
    }
    // Centrelines on top.
    ctx.strokeStyle = 'rgba(230,192,104,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const r of plan.roads) {
      const [p1x, p1y] = toPx(r.x1, r.y1);
      const [p2x, p2y] = toPx(r.x2, r.y2);
      ctx.beginPath();
      ctx.moveTo(p1x, p1y); ctx.lineTo(p2x, p2y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Tree dots: status-coloured.
    const removedSet = new Set(plan.removed.map(t => t.treeId));
    const forcedSet = new Set(plan.forced.map(t => t.treeId));
    const unreachableSet = new Set(plan.unreachable.map(t => t.treeId));
    const newDotPx: { x: number; y: number; r: number; treeId: number }[] = [];
    for (const t of trees) {
      const [px, py] = toPx(t.x, t.y);
      const r = Math.max(2.5, Math.min(6, 2.5 + t.dbh * 12));
      let fill: string;
      if (forcedSet.has(t.treeId))           fill = '#e0506b';  // in the road
      else if (removedSet.has(t.treeId))     fill = '#e0817b';  // selected for removal
      else if (unreachableSet.has(t.treeId)) fill = '#666';     // outside boom reach
      else                                   fill = '#67d391';  // kept
      ctx.fillStyle = fill;
      ctx.strokeStyle = 'rgba(0,0,0,0.4)';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      newDotPx.push({ x: px, y: py, r: r + 4, treeId: t.treeId });
    }
    dotPx.current = newDotPx;

    // Legend.
    ctx.font = '9.5px ui-monospace,monospace';
    const legend: [string, string][] = [
      ['#e0506b', 'in road'],
      ['#e0817b', 'selected'],
      ['#67d391', 'keep'],
      ['#666',    'unreachable'],
    ];
    let lx = 14, ly = 14;
    for (const [col, label] of legend) {
      ctx.fillStyle = col;
      ctx.fillRect(lx, ly - 7, 8, 8);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(label, lx + 12, ly);
      lx += 80;
    }
  }, [plan, trees, roadWidth]);

  const onCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best: { treeId: number; d2: number } | null = null;
    for (const d of dotPx.current) {
      const dx = d.x - x, dy = d.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= d.r * d.r && (!best || d2 < best.d2)) best = { treeId: d.treeId, d2 };
    }
    if (best && bboxes) {
      const bb = bboxes.get(best.treeId);
      if (bb) {
        setFilters({ isolateTreeId: best.treeId, isolateBox: [bb.min, bb.max], isolateAnchor: null });
        api?.frameBox(bb.min, bb.max);
      }
    }
  }, [bboxes, setFilters, api]);

  // --- Aggregate removal stats ---
  const stats = useMemo(() => {
    if (!plan) return null;
    const baRemoved = plan.removed.reduce((a, b) => a + b.ba, 0) / plan.plotAreaHa;
    const volRemoved = plan.removed.reduce((a, b) => a + b.volume, 0);
    const baKept = plan.baAfter;
    return {
      nTotal: trees.length,
      nForced: plan.forced.length,
      nSelected: plan.removed.length - plan.forced.length,
      nUnreach: plan.unreachable.length,
      nKept: trees.length - plan.removed.length,
      baBefore: plan.baBefore,
      baAfter: baKept,
      baRemoved,
      volRemoved,
      revenue: volRemoved * pricePerM3,
      cannotReachTarget: plan.cannotReachTarget,
    };
  }, [plan, trees, pricePerM3]);

  // Where the removed volume — and so the revenue — actually comes
  // from. A QSM volume is measured; the fallback is basal area × height
  // × 0.50, which is a guess with a price tag attached to it.
  const volumeBasisLabel = useMemo(
    () => describeVolumeSources(treeSet.volumeSources),
    [treeSet],
  );

  // --- Removed-tree CSV export ---
  const exportCsv = useCallback(() => {
    if (!plan) return;
    const lines = ['tree_id,reason,x,y,dbh_cm,height_m,ba_m2,volume_m3,volume_source,confidence'];
    const forcedSet = new Set(plan.forced.map(t => t.treeId));
    for (const t of plan.removed) {
      lines.push([
        t.treeId,
        forcedSet.has(t.treeId) ? 'road' : 'selected',
        csvNum(t.x, 2), csvNum(t.y, 2),
        csvNum(t.dbh * 100, 1),
        csvNum(t.height, 1),
        csvNum(t.ba, 4),
        csvNum(t.volume, 4),
        t.volumeSource,
        csvNum(t.confidence, 3),
      ].join(','));
    }
    void saveCsvFile(lines, 'thinning-removed.csv');
  }, [plan]);

  // --- Render ------------------------------------------------------------
  const removedSorted = useMemo(() => {
    if (!plan) return [];
    return [...plan.removed].sort((a, b) => b.dbh - a.dbh).slice(0, 200);
  }, [plan]);

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 480 }}>
      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      {computing && (
        <div className="mono text-[10px] px-1 py-0.5 rounded-sm" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)' }}>
          Computing per-tree metrics — streaming the cloud…
        </div>
      )}
      {!metrics && !computing && (
        <button className="btn !h-7 mono text-[11px]" onClick={() => void computeMetrics(true)}>Compute per-tree metrics</button>
      )}

      {trees.length > 0 && (
        <>
          {/* Targets */}
          <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>Target BA (m²/ha)</label>
              <input
                type="range" min={6} max={32} step={0.5}
                value={targetBa}
                onChange={(e) => setTargetBa(parseFloat(e.target.value))}
                className="flex-1"
              />
              <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{targetBa.toFixed(1)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>Plot area (ha)</label>
              <input
                type="number" step={0.001} min={0.001}
                disabled={autoArea}
                value={plotArea?.toFixed(3) ?? ''}
                onChange={(e) => setPlotArea(parseFloat(e.target.value) || 0.01)}
                className="bg-transparent mono text-[10.5px] px-1 py-0.5 w-[80px]"
                style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
              />
              <label className="mono text-[10px] flex items-center gap-1" style={{ color: 'var(--text-dim)', cursor: 'pointer' }}>
                <input type="checkbox" checked={autoArea} onChange={() => setAutoArea(a => !a)} /> auto
              </label>
              <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>({areaBasisLabel})</span>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>Strategy</label>
              <select
                className="bg-transparent mono text-[10.5px] flex-1 px-1 py-0.5"
                style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as Strategy)}
              >
                <option value="low">Low thinning — small + suppressed out</option>
                <option value="quality">Quality — defective stems first</option>
                <option value="mixed">Mixed — quality + small (50/50)</option>
                <option value="high">High thinning — large overstorey out</option>
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>Price ({currency}/m³)</label>
              <input
                type="number" step={1} min={0}
                value={pricePerM3}
                onChange={(e) => setPricePerM3(parseFloat(e.target.value) || 0)}
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
                title="Symbol or code this price and the revenue estimate are in. Shared with the Bucking panel and the report."
              />
              <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>(mixed grade — bucking panel gives the breakdown)</span>
            </div>
          </div>

          {/* Strip-road controls */}
          <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
            <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Strip roads (ajourat)</div>
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>Heading (°)</label>
              <input type="range" min={0} max={180} step={5}
                value={heading} onChange={(e) => setHeading(parseFloat(e.target.value))}
                className="flex-1" />
              <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{heading.toFixed(0)}°</span>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>Spacing (m)</label>
              <input type="range" min={10} max={40} step={1}
                value={roadSpacing} onChange={(e) => setRoadSpacing(parseFloat(e.target.value))}
                className="flex-1" />
              <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{roadSpacing.toFixed(0)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>Width (m)</label>
              <input type="range" min={2} max={6} step={0.25}
                value={roadWidth} onChange={(e) => setRoadWidth(parseFloat(e.target.value))}
                className="flex-1" />
              <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{roadWidth.toFixed(2)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>Species (default)</label>
              <select
                className="bg-transparent mono text-[10.5px] px-1 py-0.5 flex-1"
                style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
                value={defaultSpecies}
                onChange={(e) => setDefaultSpecies(e.target.value)}
                title="For trees with no assignment in Tree Review. Pine, spruce and birch get the Laasasenaho 1982 national volume function; anything else falls back to the constant form factor."
              >
                {SPECIES_DENSITIES.map(sp => (
                  <option key={sp.key} value={sp.key}>{sp.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>Boom reach (m)</label>
              <input type="range" min={4} max={12} step={0.5}
                value={boomReach} onChange={(e) => setBoomReach(parseFloat(e.target.value))}
                className="flex-1" />
              <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{boomReach.toFixed(1)}</span>
            </div>
          </div>

          {/* Plan view */}
          <div className="rounded-md" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)', height: 320 }}>
            <canvas ref={canvasRef} onClick={onCanvasClick} style={{ width: '100%', height: '100%', cursor: 'pointer' }} />
          </div>

          {/* Stats card */}
          {stats && (
            <div className="rounded-md p-2 flex flex-col gap-1" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
              <StatLine label="Basal area (m²/ha)" before={stats.baBefore.toFixed(1)} after={stats.baAfter.toFixed(1)} removed={`−${stats.baRemoved.toFixed(1)}`} hint={areaBasisLabel} />
              <StatLine label="Trees" before={`${stats.nTotal}`} after={`${stats.nKept}`} removed={`−${stats.nForced + stats.nSelected}`} hint={`${stats.nForced} in roads · ${stats.nSelected} selected · ${stats.nUnreach} unreachable`} />
              <StatLine label="Volume" before="" after="" removed={`${stats.volRemoved.toFixed(2)} m³`} hint={volumeBasisLabel} />
              <StatLine label="Revenue (est.)" before="" after="" removed={`${stats.revenue.toFixed(0)} ${currency}`} />
              {/* What the figures above could not include. A stem with no
                  fitted DBH has no basal area, so it is in none of them —
                  and it has no row in the exported harvest list either, so
                  the machine meets a tree the plan does not mention. */}
              {treeSet.nNoDbh > 0 && (
                <div className="mono text-[10px] px-1.5 py-1 rounded-sm mt-1" style={{ color: '#e6c068', background: 'rgba(230,192,104,0.10)', border: '1px solid rgba(230,192,104,0.35)' }}>
                  {treeSet.nNoDbh} segmented stem{treeSet.nNoDbh === 1 ? '' : 's'} could not be measured at breast height and {treeSet.nNoDbh === 1 ? 'is' : 'are'} in none of these figures — not the basal area, not the target, not the removal list. Run the stem fit, or expect {treeSet.nNoDbh === 1 ? 'it' : 'them'} standing when the harvester arrives.
                </div>
              )}
              {/* The quality term's only input is QSM coverage. */}
              {plan && !plan.qualityAvailable && (
                <div className="mono text-[10px] px-1.5 py-1 rounded-sm" style={{ color: 'var(--text-mute)' }}>
                  No QSM on this dataset, so the stem-quality term has nothing to score. Its weight is given to the size term — this run is a pure {strategy === 'high' ? 'large' : 'small'}-stem selection.
                </div>
              )}
              {stats.cannotReachTarget && (
                <div className="mono text-[10px] px-1.5 py-1 rounded-sm mt-1" style={{ color: '#e6c068', background: 'rgba(230,192,104,0.10)', border: '1px solid rgba(230,192,104,0.35)' }}>
                  Target not reached: even every reachable tree is selected. Add more strip roads (lower spacing) or relax the target BA.
                </div>
              )}
              <div className="pt-1 flex items-center justify-end">
                <button className="btn !h-6 !px-2 mono text-[10px]" onClick={exportCsv}>Export removed CSV</button>
              </div>
            </div>
          )}

          {/* Removed list (top 200 by DBH) */}
          {removedSorted.length > 0 && (
            <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
              <div className="px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderBottom: '1px solid var(--line)' }}>
                Removed — {plan && plan.removed.length > removedSorted.length
                  ? `top ${removedSorted.length} of ${plan.removed.length} by DBH (the CSV has them all)`
                  : `${removedSorted.length} by DBH`}
              </div>
              <div className="max-h-[180px] overflow-y-auto scroll-thin">
                {removedSorted.map((t) => {
                  const forced = plan?.forced.some(f => f.treeId === t.treeId);
                  return (
                    <button
                      key={t.treeId}
                      className="w-full text-left px-2 py-1 flex items-center gap-2 hover:bg-white/[0.025]"
                      style={{
                        borderBottom: '1px solid var(--line)',
                        borderLeft: `3px solid ${forced ? '#e0506b' : '#e0817b'}`,
                      }}
                      onClick={() => {
                        const bb = t.bbox;
                        if (!bb) return;
                        setFilters({ isolateTreeId: t.treeId, isolateBox: [bb.min, bb.max], isolateAnchor: null });
                        api?.frameBox(bb.min, bb.max);
                      }}
                    >
                      <span className="mono text-[10.5px]" style={{ color: 'var(--text)', width: 46 }}>#{t.treeId}</span>
                      <span className="mono text-[10px]" style={{ color: 'var(--text-mute)', width: 64 }}>{forced ? 'road' : 'selected'}</span>
                      <span className="mono text-[10.5px] flex-1" style={{ color: 'var(--text-dim)' }}>
                        DBH {(t.dbh * 100).toFixed(1)} cm · {t.volume.toFixed(2)} m³
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatLine({ label, before, after, removed, hint }: {
  label: string; before: string; after: string; removed: string; hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 mono text-[10.5px]">
      <span style={{ color: 'var(--text-dim)', width: 132 }}>{label}</span>
      {before !== '' && <span style={{ color: 'var(--text-mute)', width: 60 }}>before {before}</span>}
      {after !== '' && <span style={{ color: 'var(--text)', width: 70 }}>after {after}</span>}
      <span style={{ color: '#e0817b' }}>{removed}</span>
      {hint && <span style={{ color: 'var(--text-mute)' }}>{hint}</span>}
    </div>
  );
}
