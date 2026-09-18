// Tree growth — multi-temporal per-tree increment between two epochs.
//
// The forester picks an earlier REFERENCE dataset; this panel computes
// per-tree metrics for both the active (later) and the reference (earlier)
// cloud, matches stems across the two by position, and reports per-tree
// DBH / height / volume increment — plus which trees were harvested or
// fell (present before, gone now) and which are ingrowth (new). It is the
// per-tree companion to the M3C2 panel (M3C2 = per-point surface change;
// this = per-tree inventory change). Read-only: it measures, it never
// edits either cloud.
//
// The two epochs must be tree-segmented (tree_id), have the Terrain / DTM
// computed, and be co-registered — align them with the Co-registration
// tool first, or the stems won't match across years.
//
// Volume is a form-factor estimate (basal area × height × f), NOT a QSM
// volume — honest and stand-consistent, but coarser than a cylinder model.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import type { TreeMetric } from '../../persistence/octreeReader';
import { DEFAULT_METRIC_PARAMS } from '../../metrics/params';
import { loadTreeMetrics } from '../../metrics/loadMetrics';
import {
  matchTrees, summarise, vol,
  type Pair, type GrowthResult,
} from '../../metrics/growth';
import { csvNum, csvBlob } from '../../io/csv';
import { saveCsvFile } from '../../io/saveDownload';

interface Desktop {
  octreeTreeMetrics?: (dir: string, params: { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number }) => Promise<TreeMetric[]>;
  octreeCancel?: (stage: string) => Promise<boolean>;
  onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void> | (() => void);
}

const METRICS_PARAMS = DEFAULT_METRIC_PARAMS;

// The growth arithmetic lives in metrics/growth.ts so it can be tested
// on trees whose increment is known; this file is the UI around it.

// --- Panel --------------------------------------------------------------

export default function TreeGrowthPanel() {
  const { octree, octreeList, api, setGrowthSummary } = useOctreeShell();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;
  const canRun = !!api && !!octree && !!desktop?.octreeTreeMetrics;
  const candidates = octreeList.filter(e => e.dir !== octree?.dir);

  const [referenceDir, setReferenceDir] = useState('');
  const [years, setYears] = useState(5);
  const [searchRadius, setSearchRadius] = useState(1.5);
  const [formFactor, setFormFactor] = useState(0.50);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GrowthResult | null>(null);
  // Each epoch's measurement is a pass over its whole cloud, reported
  // on the "metrics" channel; the two are taken one after the other so
  // the bar means one thing at a time, and a Stop reaches the one that
  // is running.
  const [pct, setPct] = useState(0);
  const [stage, setStage] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!desktop?.onOctreeProgress) return;
    let off: (() => void) | undefined;
    void Promise.resolve(desktop.onOctreeProgress((e) => {
      if (e.stage === 'metrics') setPct(e.pct);
    })).then((f) => { off = f; });
    return () => { off?.(); };
  }, [desktop]);

  useEffect(() => {
    if (!referenceDir && candidates.length > 0) setReferenceDir(candidates[0].dir);
  }, [candidates, referenceDir]);

  // Raw per-epoch metrics kept so the match radius re-pairs instantly
  // without recomputing metrics (only the pairing depends on the radius).
  const metricsRef = useRef<{ ref: TreeMetric[]; now: TreeMetric[] } | null>(null);

  const compute = useCallback(async () => {
    if (!desktop?.octreeTreeMetrics || !octree?.dir || !referenceDir) return;
    setBusy(true); setError(null); setResult(null); setPct(0); setStopping(false);
    try {
      await api?.save();
      const refName = octreeList.find(e => e.dir === referenceDir)?.name ?? 'the reference epoch';
      setStage(`Measuring ${octree.meta.name ?? 'the active epoch'}`);
      const nowMetrics = await loadTreeMetrics(desktop, octree.dir, METRICS_PARAMS);
      setPct(0);
      setStage(`Measuring ${refName}`);
      const refMetrics = await loadTreeMetrics(desktop, referenceDir, METRICS_PARAMS);
      metricsRef.current = { ref: refMetrics, now: nowMetrics };
      setResult(matchTrees(refMetrics, nowMetrics, searchRadius));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false); setStage(null); setStopping(false); setPct(0);
    }
  }, [desktop, octree?.dir, octree?.meta.name, octreeList, referenceDir, searchRadius, api]);

  const cancel = useCallback(async () => {
    if (!desktop?.octreeCancel) return;
    setStopping(true);
    try { await desktop.octreeCancel('metrics'); } catch { /* nothing was running */ }
  }, [desktop]);

  /** Everything this panel produced, gone — the result, the raw metrics
   *  it keeps for re-pairing, and the summary it handed the Report. */
  const clearAll = useCallback(() => {
    setResult(null); setError(null);
    metricsRef.current = null;
    setGrowthSummary(null);
  }, [setGrowthSummary]);

  const onRadius = useCallback((r: number) => {
    setSearchRadius(r);
    const src = metricsRef.current;
    if (src) setResult(matchTrees(src.ref, src.now, r));
  }, []);

  const summary = useMemo(() => result ? summarise(result, formFactor) : null, [result, formFactor]);

  // Hand the growth summary to the Report panel whenever the displayed
  // numbers change — a fresh compute, or a form-factor / interval tweak on
  // an existing result. Keeps the report in lockstep with whatever this
  // panel is currently showing rather than freezing it at compute time.
  useEffect(() => {
    if (!summary) return;
    setGrowthSummary({
      years,
      nMatched: summary.n,
      meanDbhGrowthCmPerYear: years > 0 ? (summary.meanDdbh * 100) / years : 0,
      meanHeightGrowthMPerYear: years > 0 ? summary.meanDh / years : 0,
      volumeChangeM3: summary.sumDv,
      harvested: summary.harvestedCount,
      ingrowth: summary.ingrowthCount,
    });
  }, [summary, years, setGrowthSummary]);

  const sortedMatches = useMemo(() => {
    if (!result) return [];
    return [...result.matches].sort((a, b) => (b.now.dbh - b.ref.dbh) - (a.now.dbh - a.ref.dbh));
  }, [result]);

  const perYear = (v: number) => years > 0 ? v / years : 0;

  const exportCsv = useCallback(() => {
    if (!result) return;
    const rows = ['status,ref_id,now_id,x,y,dbh_ref_cm,dbh_now_cm,ddbh_cm,h_ref_m,h_now_m,dh_m,v_ref_m3,v_now_m3,dv_m3'];
    // Metres to centimetres. The "unmeasurable is an empty cell, never
    // the string NaN" rule this file used to state privately now lives
    // in csvNum, where every exporter can obey it — this one did not, in
    // its own main row type.
    const cm = (m: number) => csvNum(m * 100, 1);
    for (const m of result.matches) {
      rows.push([
        'grown', m.ref.treeId, m.now.treeId, csvNum(m.now.x, 3), csvNum(m.now.y, 3),
        cm(m.ref.dbh), cm(m.now.dbh),
        csvNum((m.now.dbh - m.ref.dbh) * 100, 1),
        csvNum(m.ref.height, 2), csvNum(m.now.height, 2), csvNum(m.now.height - m.ref.height, 2),
        csvNum(vol(m.ref, formFactor), 4), csvNum(vol(m.now, formFactor), 4),
        csvNum(vol(m.now, formFactor) - vol(m.ref, formFactor), 4),
      ].join(','));
    }
    for (const t of result.harvested) {
      rows.push(['harvested', t.treeId, '', csvNum(t.x, 3), csvNum(t.y, 3), cm(t.dbh), '', '', csvNum(t.height, 2), '', '', csvNum(vol(t, formFactor), 4), '', ''].join(','));
    }
    for (const t of result.ingrowth) {
      rows.push(['ingrowth', '', t.treeId, csvNum(t.x, 3), csvNum(t.y, 3), '', cm(t.dbh), '', '', csvNum(t.height, 2), '', '', csvNum(vol(t, formFactor), 4), ''].join(','));
    }
    void saveCsvFile(rows, 'tree-growth.csv');
  }, [result, formFactor]);

  const refName = candidates.find(e => e.dir === referenceDir)?.name ?? '';

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 440 }}>
      {!canRun && (
        <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Tree growth needs the desktop build and an open dataset.
        </div>
      )}
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
        Per-tree DBH / height / volume increment between two epochs. Both must be
        tree-segmented, have the DTM computed, and be <b>co-registered</b> first.
      </div>

      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)', lineHeight: 1.5 }}>{error}</div>
      )}

      <Section title="Reference epoch" sub="the earlier dataset">
        {candidates.length === 0 ? (
          <div className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            No other dataset in the project — import the earlier epoch first.
          </div>
        ) : (
          <select
            value={referenceDir}
            onChange={(e) => setReferenceDir(e.target.value)}
            disabled={busy}
            className="mono text-[11px] rounded-md px-1.5 py-1"
            style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
          >
            {candidates.map(e => (
              <option key={e.dir} value={e.dir}>{e.name} · {e.pointCount.toLocaleString()} pts</option>
            ))}
          </select>
        )}
        <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          <span style={{ color: 'var(--text)' }}>{refName || '—'}</span> → <span style={{ color: 'var(--text)' }}>{octree?.meta.name ?? '—'}</span> (active)
        </div>
      </Section>

      <Section title="Parameters" sub="interval · match radius · form factor">
        <SliderRow label="Interval"     unit="yr" value={years}        min={0.5} max={30}  step={0.5}  setValue={setYears}      disabled={busy} fixed={1} />
        <SliderRow label="Match radius" unit="m"  value={searchRadius}  min={0.5} max={6}   step={0.25} setValue={onRadius}      disabled={busy} fixed={2} />
        <SliderRow label="Form factor"  unit=""   value={formFactor}    min={0.30} max={0.70} step={0.01} setValue={setFormFactor} disabled={busy} fixed={2} />
      </Section>

      <div className="flex gap-1.5">
        <button
          className="btn !h-8 mono text-[11.5px] justify-center flex-1"
          disabled={!canRun || busy || !referenceDir}
          onClick={compute}
          style={{
            background: busy ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
            color: busy ? 'var(--accent)' : undefined,
          }}
        >
          {busy ? `${stage ?? 'Measuring'} (${(pct * 100).toFixed(0)} %)…` : 'Compute growth'}
        </button>
        {busy && (
          <button className="btn !h-8 mono text-[11.5px] !px-3" onClick={() => void cancel()}
            disabled={!desktop?.octreeCancel || stopping} title="Stop the measurement that is running">
            {stopping ? 'Stopping…' : 'Cancel'}
          </button>
        )}
        {result && !busy && (
          <button className="btn !h-8 mono text-[11.5px] !px-3" onClick={clearAll}
            title="Drop the result and its entry in the Report">Clear</button>
        )}
      </div>
      {busy && (
        <div className="rounded-sm overflow-hidden" style={{ height: 4, background: 'var(--wash-2)' }}>
          <div style={{ width: `${(pct * 100).toFixed(1)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.15s' }} />
        </div>
      )}

      {result && summary && !busy && (
        <>
          <div className="rounded-md p-2 flex flex-col gap-1" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
            <StatRow label="Matched trees" value={`${summary.n}`} hint={`${summary.nDbhPairs} with DBH`} />
            <StatRow label="Mean ΔDBH" value={`${signCm(summary.meanDdbh)}  (${signCm(perYear(summary.meanDdbh))}/yr)`} valueColor={growthColor(summary.meanDdbh)} />
            <StatRow label="Mean ΔHeight" value={`${signM(summary.meanDh)}  (${signM(perYear(summary.meanDh))}/yr)`} valueColor={growthColor(summary.meanDh)} />
            <StatRow label="Σ Volume incr." value={`${signM3(summary.sumDv)}  (${signM3(perYear(summary.sumDv))}/yr)`} valueColor={growthColor(summary.sumDv)}
              hint={summary.nVolPairs < summary.n
                ? `form-factor est. · over ${summary.nVolPairs} of ${summary.n} pairs — the rest lack a stem fit in one epoch`
                : `form-factor est. · over all ${summary.nVolPairs} pairs`} />
            <StatRow label="Harvested / fallen" value={`${summary.harvestedCount}`}
              hint={`${summary.harvestedVol.toFixed(2)} m³ removed${summary.harvestedUnmeasured > 0 ? ` · ${summary.harvestedUnmeasured} without a stem fit` : ''}`}
              valueColor="#e0817b" />
            <StatRow label="Ingrowth / new" value={`${summary.ingrowthCount}`}
              hint={`${summary.ingrowthVol.toFixed(2)} m³${summary.ingrowthUnmeasured > 0 ? ` · ${summary.ingrowthUnmeasured} without a stem fit` : ''}`}
              valueColor="#78c8dc" />
          </div>

          <GrowthMap result={result} />
          <div className="mono text-[8.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
            <span style={{ color: '#67d391' }}>●</span> grew · <span style={{ color: '#e0817b' }}>●</span> shrank · <span style={{ color: '#e0817b' }}>✕</span> harvested · <span style={{ color: '#78c8dc' }}>+</span> new. Dot size ∝ current DBH.
          </div>

          <div className="flex items-center justify-end">
            <button className="btn !h-6 !px-2 mono text-[10px]" onClick={exportCsv}>Export CSV</button>
          </div>

          <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
            <div className="px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderBottom: '1px solid var(--line)' }}>
              Per-tree increment (by ΔDBH)
            </div>
            <div className="max-h-[200px] overflow-y-auto scroll-thin">
              {sortedMatches.slice(0, 60).map((m, i) => <GrowthRow key={i} m={m} />)}
              {sortedMatches.length > 60 && (
                <div className="px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-mute)' }}>+ {sortedMatches.length - 60} more — export the CSV for the full list.</div>
              )}
            </div>
          </div>

          {result.harvested.length > 0 && (
            <IdList title={`Harvested / fallen (${result.harvested.length})`} tint="rgba(224,129,123,0.06)" trees={result.harvested} />
          )}
          {result.ingrowth.length > 0 && (
            <IdList title={`Ingrowth / new (${result.ingrowth.length})`} tint="rgba(120,200,220,0.06)" trees={result.ingrowth} />
          )}
        </>
      )}

      {!result && !busy && candidates.length > 0 && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
          Pick the earlier epoch, set the interval, then Compute. Volume is a
          form-factor estimate (BA·H·f), not a QSM model.
        </div>
      )}
    </div>
  );
}

// --- Plan-view map ------------------------------------------------------

function GrowthMap({ result }: { result: GrowthResult }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
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

    const all: { x: number; y: number }[] = [];
    result.matches.forEach(m => all.push({ x: m.now.x, y: m.now.y }));
    result.harvested.forEach(t => all.push({ x: t.x, y: t.y }));
    result.ingrowth.forEach(t => all.push({ x: t.x, y: t.y }));
    if (all.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of all) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    // Square the data range + 5 % pad so the map is undistorted (north up).
    const span = Math.max(maxX - minX, maxY - minY, 1) * 1.05;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const lo = { x: cx - span / 2, y: cy - span / 2 };
    const pad = 8;
    const plot = Math.min(cssW, cssH) - 2 * pad;
    const toPx = (x: number, y: number) => [
      pad + ((x - lo.x) / span) * plot,
      // y up (north): invert
      pad + plot - ((y - lo.y) / span) * plot,
    ] as const;

    // Frame.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.strokeRect(pad - 0.5, pad - 0.5, plot + 1, plot + 1);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '9px ui-monospace,monospace';
    ctx.fillText('N', pad + plot / 2 - 3, pad + 9);

    // Matched trees — colour by ΔDBH, size by current DBH.
    for (const m of result.matches) {
      const dd = (Number.isFinite(m.now.dbh) && Number.isFinite(m.ref.dbh)) ? m.now.dbh - m.ref.dbh : NaN;
      const col = !Number.isFinite(dd) ? 'rgba(255,255,255,0.35)'
        : dd > 0.005 ? '#67d391' : dd < -0.005 ? '#e0817b' : 'rgba(255,255,255,0.35)';
      const rad = 2 + Math.min(3, (Number.isFinite(m.now.dbh) ? m.now.dbh : 0.2) * 6);
      const [px, py] = toPx(m.now.x, m.now.y);
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(px, py, rad, 0, Math.PI * 2); ctx.fill();
    }
    // Harvested — muted-red ✕ at the reference position.
    ctx.strokeStyle = 'rgba(224,129,123,0.75)';
    ctx.lineWidth = 1.3;
    for (const t of result.harvested) {
      const [px, py] = toPx(t.x, t.y);
      ctx.beginPath();
      ctx.moveTo(px - 3, py - 3); ctx.lineTo(px + 3, py + 3);
      ctx.moveTo(px + 3, py - 3); ctx.lineTo(px - 3, py + 3);
      ctx.stroke();
    }
    // Ingrowth — cyan + at the current position.
    ctx.strokeStyle = 'rgba(120,200,220,0.85)';
    for (const t of result.ingrowth) {
      const [px, py] = toPx(t.x, t.y);
      ctx.beginPath();
      ctx.moveTo(px - 3, py); ctx.lineTo(px + 3, py);
      ctx.moveTo(px, py - 3); ctx.lineTo(px, py + 3);
      ctx.stroke();
    }
  }, [result]);

  return (
    <div className="rounded-md" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)', height: 260 }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
    </div>
  );
}

// --- Rows ---------------------------------------------------------------

function GrowthRow({ m }: { m: Pair }) {
  const dd = (Number.isFinite(m.now.dbh) && Number.isFinite(m.ref.dbh)) ? m.now.dbh - m.ref.dbh : NaN;
  const dh = m.now.height - m.ref.height;
  return (
    <div className="flex items-center gap-2 px-2 py-1 mono text-[10px]" style={{ borderBottom: '1px solid var(--line)' }}>
      <span style={{ color: 'var(--text)', width: 72 }}>#{m.ref.treeId}→#{m.now.treeId}</span>
      <span className="flex-1" style={{ color: 'var(--text-mute)' }}>
        Ø {dbhCm(m.ref.dbh)}→{dbhCm(m.now.dbh)}
        <span style={{ color: growthColor(dd) }}> {signCm(dd)}</span>
      </span>
      <span style={{ color: 'var(--text-mute)' }}>
        H {m.ref.height.toFixed(1)}→{m.now.height.toFixed(1)}
        <span style={{ color: growthColor(dh) }}> {signM(dh)}</span>
      </span>
    </div>
  );
}

function IdList({ title, tint, trees }: { title: string; tint: string; trees: TreeMetric[] }) {
  return (
    <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
      <div className="px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-dim)', background: tint, borderBottom: '1px solid var(--line)' }}>{title}</div>
      <div className="max-h-[110px] overflow-y-auto scroll-thin">
        {trees.slice(0, 40).map(t => (
          <div key={t.treeId} className="flex items-center gap-2 px-2 py-0.5 mono text-[9.5px]" style={{ borderBottom: '1px solid var(--line)', color: 'var(--text-mute)' }}>
            <span style={{ color: 'var(--text)', width: 46 }}>#{t.treeId}</span>
            <span className="flex-1">({t.x.toFixed(1)}, {t.y.toFixed(1)})</span>
            <span>{Number.isFinite(t.dbh) ? `Ø ${(t.dbh * 100).toFixed(1)} cm` : '—'} · H {t.height.toFixed(1)} m</span>
          </div>
        ))}
        {trees.length > 40 && (
          <div className="px-2 py-1 mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>+ {trees.length - 40} more (in the CSV).</div>
        )}
      </div>
    </div>
  );
}

// --- Formatting ---------------------------------------------------------

function growthColor(m: number): string {
  if (!Number.isFinite(m)) return 'var(--text-dim)';
  if (m > 0.005) return '#67d391';
  if (m < -0.005) return '#e0817b';
  return 'var(--text-dim)';
}
function dbhCm(m: number): string { return Number.isFinite(m) ? `${(m * 100).toFixed(1)}` : '—'; }
function signCm(m: number): string { if (!Number.isFinite(m)) return '—'; const v = m * 100; return `${v >= 0 ? '+' : ''}${v.toFixed(1)} cm`; }
function signM(m: number): string { if (!Number.isFinite(m)) return '—'; return `${m >= 0 ? '+' : ''}${m.toFixed(2)} m`; }
function signM3(m: number): string { if (!Number.isFinite(m)) return '—'; return `${m >= 0 ? '+' : ''}${m.toFixed(2)} m³`; }

// --- Building blocks ----------------------------------------------------

function StatRow({ label, value, hint, valueColor }: { label: string; value: string; hint?: string; valueColor?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="mono text-[10px]" style={{ color: 'var(--text-dim)', width: 128 }}>{label}</span>
      <span className="mono text-[11px]" style={{ color: valueColor ?? 'var(--text)' }}>{value}</span>
      {hint && <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{hint}</span>}
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

function SliderRow({
  label, unit, value, min, max, step, setValue, disabled, fixed,
}: {
  label: string; unit: string; value: number; min: number; max: number; step: number;
  setValue: (n: number) => void; disabled: boolean; fixed: number;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="mono text-[10px] w-[92px]" style={{ color: 'var(--text-dim)' }}>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => setValue(parseFloat(e.target.value))} className="flex-1" disabled={disabled} />
      <span className="mono text-[10px] w-[60px] text-right" style={{ color: 'var(--text)' }}>{value.toFixed(fixed)} {unit}</span>
    </div>
  );
}
