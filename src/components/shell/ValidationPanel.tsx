// Field-data fusion + validation.
//
// The forester ground-truthed the plot with calipers / hypsometers and
// wrote down (tree, DBH, height, GPS X, GPS Y, species). This panel
// closes the loop:
//
//   1. Load the field CSV — sniffed delimiter, auto-detected header,
//      column-role dropdowns (X / Y / DBH / height / species / id).
//
//   2. Match field trees to detected trees. Greedy bipartite nearest-
//      neighbour within a tunable search radius: build every candidate
//      pair under the threshold, sort by distance, claim in order, no
//      double-claims. The result is one PointCloudLabeler tree per field tree
//      (when a partner exists in range).
//
//   3. Validation: per-metric (DBH, height) bias + RMSE + R^2 + n
//      matched, the linear fit (slope + intercept), and a scatter
//      plot of caliper-DBH vs PointCloudLabeler-DBH with the 1:1 line + fit line
//      drawn over it. Residuals histogram lives below the scatter.
//
// No backend changes — everything runs on the cached per-tree
// metrics. The CSV is parsed in-browser via FileReader. v1 keeps the
// data in panel state; persistence + species-stratified stats come
// next.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import type { TreeMetric } from '../../persistence/octreeReader';
import { loadTreeMetrics } from '../../metrics/loadMetrics';
import { csvField, csvNum, csvBlob } from '../../io/csv';
import { DEFAULT_METRIC_PARAMS } from '../../metrics/params';
import { useCachedTreeMetrics } from '../../metrics/useCachedTreeMetrics';
import { saveCsvFile } from '../../io/saveDownload';
import {
  parseCsv, autoMap, rowsToFieldTrees, matchTrees, statsFor,
  type ParsedCsv, type Mapping, type FieldTree, type Match, type MetricStats,
} from '../../metrics/fieldValidation';

interface Desktop {
  octreeTreeMetrics?: (dir: string, params: { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number }) => Promise<TreeMetric[]>;
}

// --- Panel --------------------------------------------------------------


export default function ValidationPanel() {
  const { octree, api, setValidationSummary } = useOctreeShell();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
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
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [searchRadius, setSearchRadius] = useState(2.0);
  const [view, setView] = useState<'dbh' | 'height'>('dbh');

  // --- CSV file picker ---
  const onPickFile = useCallback(async (file: File) => {
    setError(null);
    try {
      const text = await file.text();
      const p = parseCsv(text);
      if (!p) { setError('Empty file.'); return; }
      setParsed(p);
      setMapping(autoMap(p.headers));
      setFileName(file.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // --- Metrics: only compute when the user clicks (heavy job) ---
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

  // Auto-load on open. Not forced: with the plot already measured by
  // any other panel this returns from the shared cache without touching
  // the cloud, and only an unmeasured (or edited) plot pays for a pass.
  useEffect(() => { void computeMetrics(); }, [octree?.dir]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Derived data ---
  const fieldTrees = useMemo(() => {
    if (!parsed || !mapping) return [];
    if (mapping.xCol < 0 || mapping.yCol < 0) return [];
    return rowsToFieldTrees(parsed.rows, mapping, parsed.decimalComma);
  }, [parsed, mapping]);

  const matchResult = useMemo(() => {
    if (!metrics || fieldTrees.length === 0) return null;
    return matchTrees(fieldTrees, metrics, searchRadius);
  }, [metrics, fieldTrees, searchRadius]);

  const dbhStats = useMemo(() => {
    if (!matchResult) return null;
    return statsFor(matchResult.matches.map(m => ({ c: m.field.caliperDbh, t: m.pointcloudlabeler.dbh })));
  }, [matchResult]);

  // Hand the DBH validation stats to the Report panel whenever they change.
  // Always DBH (not whichever metric the toggle below is showing) — the
  // report's field-validation block is DBH-specific, matching what foresters
  // actually caliper in the field. Units convert m → cm here so the report
  // never has to know the panel's internal units.
  useEffect(() => {
    if (!dbhStats) return;
    setValidationSummary({
      nMatched: dbhStats.n,
      biasCm: dbhStats.bias * 100,
      rmseCm: dbhStats.rmse * 100,
      r2: dbhStats.r2,
    });
  }, [dbhStats, setValidationSummary]);

  const heightStats = useMemo(() => {
    if (!matchResult) return null;
    return statsFor(matchResult.matches.map(m => ({ c: m.field.hypHeight, t: m.pointcloudlabeler.height })));
  }, [matchResult]);

  const activeStats = view === 'dbh' ? dbhStats : heightStats;
  const axisLabel = view === 'dbh' ? 'DBH (m)' : 'height (m)';

  // --- Scatter rendering ---
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
    if (!activeStats || !matchResult) return;

    const pairs = matchResult.matches
      .map(m => view === 'dbh'
        ? { c: m.field.caliperDbh, t: m.pointcloudlabeler.dbh }
        : { c: m.field.hypHeight, t: m.pointcloudlabeler.height })
      .filter(p => Number.isFinite(p.c) && p.c > 0 && Number.isFinite(p.t) && p.t > 0);
    if (pairs.length === 0) return;

    // Axis range — extend both to include 0 and a 5 % pad, and force
    // a square frame so the 1:1 line is at 45°.
    const allMin = Math.min(activeStats.xMin, activeStats.yMin, 0);
    const allMax = Math.max(activeStats.xMax, activeStats.yMax) * 1.05;
    const range = allMax - allMin || 1;

    const padL = 36, padB = 28, padT = 12, padR = 12;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;
    const toPx = (x: number, y: number) => [
      padL + ((x - allMin) / range) * plotW,
      cssH - padB - ((y - allMin) / range) * plotH,
    ] as const;

    // Frame.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.strokeRect(padL - 0.5, padT - 0.5, plotW + 1, plotH + 1);

    // Gridlines + tick labels — choose 4–5 ticks across the range.
    ctx.font = '9px ui-monospace,monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    const ticks = niceTicks(allMin, allMin + range, 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (const t of ticks) {
      const [px, ] = toPx(t, allMin);
      const [, py] = toPx(allMin, t);
      ctx.beginPath();
      ctx.moveTo(px, padT); ctx.lineTo(px, cssH - padB);
      ctx.moveTo(padL, py); ctx.lineTo(cssW - padR, py);
      ctx.stroke();
      ctx.fillText(t.toFixed(view === 'dbh' ? 2 : 1), px - 8, cssH - padB + 10);
      ctx.fillText(t.toFixed(view === 'dbh' ? 2 : 1), 2, py + 3);
    }

    // 1:1 line.
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    {
      const [x0, y0] = toPx(allMin, allMin);
      const [x1, y1] = toPx(allMax, allMax);
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Linear-fit line.
    ctx.strokeStyle = '#67d391';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    {
      const yA = activeStats.slope * allMin + activeStats.intercept;
      const yB = activeStats.slope * allMax + activeStats.intercept;
      const [x0, y0] = toPx(allMin, yA);
      const [x1, y1] = toPx(allMax, yB);
      ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
    }
    ctx.stroke();

    // Points.
    ctx.fillStyle = 'rgba(120,180,240,0.85)';
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 0.6;
    for (const p of pairs) {
      const [px, py] = toPx(p.c, p.t);
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Axis labels.
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px ui-monospace,monospace';
    ctx.fillText(`caliper ${axisLabel}`, cssW / 2 - 32, cssH - 4);
    ctx.save();
    ctx.translate(10, cssH / 2 + 32);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`PointCloudLabeler ${axisLabel}`, 0, 0);
    ctx.restore();
  }, [activeStats, matchResult, view, axisLabel]);

  // --- CSV export ---
  // One flat table: matched pairs first, then unmatched field rows
  // (a `status` column tells them apart; unmatched rows leave every
  // PointCloudLabeler-side column blank since there's no partner). Exports the
  // FULL unmatchedField list, not the 50-row slice rendered below —
  // same reasoning as the Thinning panel's export not being capped
  // to its on-screen "top 200". Caliper DBH and PointCloudLabeler DBH are both
  // stored in metres internally; both are ×100'd here so the two
  // _cm columns can never end up in different units.
  const exportCsv = useCallback(() => {
    if (!matchResult || (matchResult.matches.length === 0 && matchResult.unmatchedField.length === 0)) return;
    const lines = ['field_id,field_x,field_y,caliper_dbh_cm,pointcloudlabeler_dbh_cm,dbh_diff_cm,hyp_height_m,pointcloudlabeler_height_m,height_diff_m,match_distance_m,status'];
    for (const m of matchResult.matches) {
      const caliperCm = m.field.caliperDbh * 100; // NaN when no DBH column was mapped
      const pointcloudlabelerCm = m.pointcloudlabeler.dbh * 100;          // NaN when the PointCloudLabeler DBH fit failed
      const dbhDiff = pointcloudlabelerCm - caliperCm;         // NaN propagates when either side is
      const hypH = m.field.hypHeight;
      const pointcloudlabelerH = m.pointcloudlabeler.height;
      const heightDiff = pointcloudlabelerH - hypH;
      lines.push([
        csvField(m.field.fieldId),
        csvNum(m.field.x, 3),
        csvNum(m.field.y, 3),
        csvNum(caliperCm, 2),
        csvNum(pointcloudlabelerCm, 2),
        csvNum(dbhDiff, 2),
        csvNum(hypH, 2),
        csvNum(pointcloudlabelerH, 2),
        csvNum(heightDiff, 2),
        csvNum(m.distance, 3),
        'matched',
      ].join(','));
    }
    for (const f of matchResult.unmatchedField) {
      const caliperCm = f.caliperDbh * 100;
      lines.push([
        csvField(f.fieldId),
        csvNum(f.x, 3),
        csvNum(f.y, 3),
        csvNum(caliperCm, 2),
        '', '',
        csvNum(f.hypHeight, 2),
        '', '', '',
        'unmatched',
      ].join(','));
    }
    void saveCsvFile(lines, 'field-validation.csv');
  }, [matchResult]);

  // --- Render -----------------------------------------------------------
  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 460 }}>
      {/* Load field CSV */}
      <div className="flex items-center gap-1.5">
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.txt,.tsv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPickFile(f);
            e.target.value = '';
          }}
        />
        <button
          className="btn !h-7 !px-2 mono text-[11px] flex-1"
          onClick={() => fileInputRef.current?.click()}
        >
          {fileName ? `↻ ${fileName}` : 'Load field CSV…'}
        </button>
        {!metrics && (
          <button
            className="btn !h-7 !px-2 mono text-[11px]"
            disabled={!desktop?.octreeTreeMetrics || !octree?.dir || computing}
            onClick={() => void computeMetrics(true)}
            title="Run PointCloudLabeler per-tree metrics so the panel has detected trees to match against"
          >
            {computing ? '…' : 'Compute metrics'}
          </button>
        )}
      </div>

      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      {!parsed && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
          Load a field CSV with caliper-measured DBH (cm), optional hypsometer height (m), and GPS X / Y in the SAME coordinate system as the point cloud (UTM, ETRS-TM35FIN, …). PointCloudLabeler auto-detects the delimiter and header row and tries to map columns by name — adjust the dropdowns below if it gets one wrong.
        </div>
      )}

      {/* Column mapping */}
      {parsed && mapping && (
        <div className="rounded-md p-2 flex flex-col gap-1" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
            {parsed.rows.length} field row{parsed.rows.length === 1 ? '' : 's'} · delim "{parsed.delimiter === '\t' ? 'tab' : parsed.delimiter}"{parsed.hasHeader ? ' · with header' : ' · no header'}{parsed.decimalComma ? ' · decimal comma (24,7 = 24.7)' : ''}
          </div>
          <ColMap label="X (easting)*" v={mapping.xCol} headers={parsed.headers} onChange={(v) => setMapping({ ...mapping, xCol: v })} />
          <ColMap label="Y (northing)*" v={mapping.yCol} headers={parsed.headers} onChange={(v) => setMapping({ ...mapping, yCol: v })} />
          <ColMap label="DBH (cm)" v={mapping.dbhCol} headers={parsed.headers} optional onChange={(v) => setMapping({ ...mapping, dbhCol: v })} />
          <ColMap label="Height (m)" v={mapping.heightCol} headers={parsed.headers} optional onChange={(v) => setMapping({ ...mapping, heightCol: v })} />
          <ColMap label="Species" v={mapping.speciesCol} headers={parsed.headers} optional onChange={(v) => setMapping({ ...mapping, speciesCol: v })} />
          <ColMap label="Field id" v={mapping.idCol} headers={parsed.headers} optional onChange={(v) => setMapping({ ...mapping, idCol: v })} />
        </div>
      )}

      {/* Search radius */}
      {parsed && (
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>Search radius</label>
          <input
            type="range" min={0.5} max={6.0} step={0.25}
            value={searchRadius}
            onChange={(e) => setSearchRadius(parseFloat(e.target.value))}
            className="flex-1"
          />
          <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{searchRadius.toFixed(2)} m</span>
        </div>
      )}

      {/* Match summary */}
      {matchResult && (
        <div className="mono text-[10.5px] flex items-center flex-wrap" style={{ color: 'var(--text-dim)' }}>
          <span>{matchResult.matches.length} matched</span>
          <span style={{ color: 'var(--text-mute)' }}> · </span>
          <span style={{ color: matchResult.unmatchedField.length > 0 ? '#e6c068' : 'var(--text-dim)' }}>{matchResult.unmatchedField.length} field unmatched</span>
          <span style={{ color: 'var(--text-mute)' }}> · </span>
          <span style={{ color: 'var(--text-mute)' }}>{matchResult.unmatchedPointCloudLabeler.length} PointCloudLabeler not claimed</span>
          <span className="flex-1" />
          <button className="btn !h-5 !px-1.5 mono text-[10px]" onClick={exportCsv} disabled={matchResult.matches.length === 0 && matchResult.unmatchedField.length === 0}>CSV</button>
        </div>
      )}

      {/* Metric toggle */}
      {matchResult && (
        <div className="flex items-center gap-1.5">
          <button
            className="btn !h-7 !px-2 mono text-[11px] flex-1"
            style={{
              background: view === 'dbh' ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
              color: view === 'dbh' ? 'var(--accent)' : undefined,
              borderColor: view === 'dbh' ? 'var(--accent)' : undefined,
            }}
            onClick={() => setView('dbh')}
          >
            DBH {dbhStats ? `(n=${dbhStats.n})` : ''}
          </button>
          <button
            className="btn !h-7 !px-2 mono text-[11px] flex-1"
            style={{
              background: view === 'height' ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
              color: view === 'height' ? 'var(--accent)' : undefined,
              borderColor: view === 'height' ? 'var(--accent)' : undefined,
            }}
            onClick={() => setView('height')}
            disabled={!heightStats}
          >
            Height {heightStats ? `(n=${heightStats.n})` : '(no data)'}
          </button>
        </div>
      )}

      {/* Stats card */}
      {activeStats && (
        <div className="rounded-md p-2 flex flex-col gap-1" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <StatRow label="Bias (PointCloudLabeler − caliper)" value={`${(activeStats.bias * (view === 'dbh' ? 100 : 1)).toFixed(2)} ${view === 'dbh' ? 'cm' : 'm'}`} hint="positive = PointCloudLabeler overestimates" />
          <StatRow label="RMSE" value={`${(activeStats.rmse * (view === 'dbh' ? 100 : 1)).toFixed(2)} ${view === 'dbh' ? 'cm' : 'm'}`} />
          <StatRow label="R²" value={Number.isFinite(activeStats.r2) ? activeStats.r2.toFixed(3) : '—'} />
          <StatRow
            label="Linear fit"
            value={Number.isFinite(activeStats.slope)
              ? `y = ${activeStats.slope.toFixed(3)} x + ${(activeStats.intercept * (view === 'dbh' ? 100 : 1)).toFixed(2)} ${view === 'dbh' ? 'cm' : 'm'}`
              : '— (every caliper reading is the same value)'}
            hint="pointcloudlabeler as a function of caliper" />
          <StatRow label="Pairs" value={`${activeStats.n}`} hint="matched trees these figures rest on" />
          {/* A finite number is not a measurement. The metrics pass reports
              a height of 0 for a tree with no ground surface beneath it, and
              field sheets write 0 for "not measured" — both used to enter the
              statistics as a real reading and drag bias and RMSE with them. */}
          {activeStats.nUnusable > 0 && (
            <div className="mono text-[10px] px-1.5 py-1 rounded-sm mt-1" style={{ color: '#e6c068', background: 'rgba(230,192,104,0.10)', border: '1px solid rgba(230,192,104,0.35)' }}>
              {activeStats.nUnusable} more matched pair{activeStats.nUnusable === 1 ? '' : 's'} had no usable {view === 'dbh' ? 'diameter' : 'height'} on one side or the other, so {activeStats.nUnusable === 1 ? 'it is' : 'they are'} in none of these figures.
            </div>
          )}
        </div>
      )}

      {/* Scatter canvas */}
      {activeStats && (
        <div className="rounded-md" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)', height: 260 }}>
          <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
        </div>
      )}

      {/* Unmatched field rows — these are the ones worth a manual review. */}
      {matchResult && matchResult.unmatchedField.length > 0 && (
        <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
          <div className="px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-dim)', background: 'rgba(230,192,104,0.06)', borderBottom: '1px solid var(--line)' }}>
            Unmatched field rows ({matchResult.unmatchedField.length}) — outside the search radius
          </div>
          <div className="max-h-[120px] overflow-y-auto scroll-thin">
            {matchResult.unmatchedField.slice(0, 50).map((f) => (
              <div key={f.rowIdx} className="flex items-center gap-2 px-2 py-1" style={{ borderBottom: '1px solid var(--line)' }}>
                <span className="mono text-[10.5px]" style={{ color: 'var(--text)', width: 50 }}>{f.fieldId}</span>
                <span className="mono text-[10px] flex-1" style={{ color: 'var(--text-dim)' }}>
                  ({f.x.toFixed(1)}, {f.y.toFixed(1)})
                </span>
                <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
                  {Number.isFinite(f.caliperDbh) ? `DBH ${(f.caliperDbh * 100).toFixed(1)} cm` : ''}
                  {f.species ? ` · ${f.species}` : ''}
                </span>
              </div>
            ))}
            {matchResult.unmatchedField.length > 50 && (
              <div className="px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
                + {matchResult.unmatchedField.length - 50} more — increase the search radius or check the CRS.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="mono text-[10px]" style={{ color: 'var(--text-dim)', width: 140 }}>{label}</span>
      <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>{value}</span>
      {hint && <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{hint}</span>}
    </div>
  );
}

function ColMap({ label, v, headers, onChange, optional }: {
  label: string; v: number; headers: string[]; onChange: (v: number) => void; optional?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>{label}</label>
      <select
        className="bg-transparent mono text-[10.5px] flex-1 px-1 py-0.5"
        style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
        value={v}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
      >
        {optional && <option value={-1}>—</option>}
        {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
      </select>
    </div>
  );
}

/** Choose ~`approx` "nice" tick values across [lo, hi] for axis labels. */
function niceTicks(lo: number, hi: number, approx: number): number[] {
  const range = hi - lo;
  if (range <= 0) return [lo];
  const rough = range / approx;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  let step: number;
  if (norm < 1.5) step = pow;
  else if (norm < 3) step = 2 * pow;
  else if (norm < 7) step = 5 * pow;
  else step = 10 * pow;
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let t = start; t <= hi; t += step) out.push(t);
  return out;
}
