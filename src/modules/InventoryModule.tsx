// Inventory module — a stand-level overview of a dataset's segmented
// trees, computed natively from the octree (the same per-tree metrics the
// Metrics module uses) and presented in the modern shell look: summary
// stat cards, DBH + height distributions, a DBH–height allometry scatter,
// and a spatial tree map. No project.db round-trip — pick a dataset,
// Analyze, and everything fills in.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useProject } from '../context/ProjectContext';
import { listOctrees, type OctreeListEntry, type TreeMetric } from '../persistence/octreeReader';
import { onOctreeProgress } from '../persistence/octreeStore';
import MetricHistogram from '../components/MetricHistogram';
import MetricScatter from '../components/MetricScatter';
import TreeMap, { type TreeMapEntry } from '../components/TreeMap';
import { plotAreaHa, parsePlotBoundary } from '../utils/plotBoundary';
import type { PlotBoundary } from '../components/shell/OctreeShellContext';
import { loadTreeMetrics } from '../metrics/loadMetrics';
import { DEFAULT_METRIC_PARAMS } from '../metrics/params';

interface Desktop {
  octreeTreeMetrics?: (dir: string, params: { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number }) => Promise<TreeMetric[]>;
  // Plot boundary overlay (plot.json) — read directly through the bridge:
  // InventoryModule is a top-level module outside the editor shell, so it
  // has no OctreeShellContext to read the boundary from and goes straight
  // to the same on-disk file the Editor's panels now agree on.
  octreeReadPlot?: (dir: string) => Promise<string>;
}

export default function InventoryModule() {
  const { project, activeModule } = useProject();
  const shown = activeModule === 'inventory';
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  const [list, setList] = useState<OctreeListEntry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [rows, setRows] = useState<TreeMetric[] | null>(null);
  const [plotBoundary, setPlotBoundary] = useState<PlotBoundary | null>(null);
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [colorBy, setColorBy] = useState<'dbh' | 'species'>('dbh');

  const entry = useMemo(() => list.find(l => l.dir === dir) ?? null, [list, dir]);
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

  useEffect(() => { setRows(null); setError(null); }, [dir]);

  // Plot boundary is a dataset property (plot.json next to the octree),
  // not shell state — load it straight from the bridge whenever the
  // selected dataset changes so the per-hectare figures below use the
  // same measured area as the Editor's Report / Thinning panels instead
  // of silently defaulting to the bbox estimate.
  useEffect(() => {
    setPlotBoundary(null);
    if (!dir || !desktop?.octreeReadPlot) return;
    let cancelled = false;
    void desktop.octreeReadPlot(dir).then((raw) => {
      if (!cancelled) setPlotBoundary(parsePlotBoundary(raw));
    }).catch(() => { /* missing/unreadable → stays null, bbox fallback */ });
    return () => { cancelled = true; };
  }, [dir, desktop]);

  const analyze = useCallback(async () => {
    if (!desktop?.octreeTreeMetrics || !dir) return;
    setRunning(true); setPct(0); setError(null);
    let unlisten: (() => void) | null = null;
    try {
      unlisten = await onOctreeProgress((stage, p) => { if (stage === 'metrics') setPct(p); });
      // force — the Analyse button is the user asking for a fresh pass.
      const res = await loadTreeMetrics(desktop, dir, DEFAULT_METRIC_PARAMS, { force: true });
      setRows(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows(null);
    } finally {
      unlisten?.();
      setRunning(false); setPct(0);
    }
  }, [desktop, dir]);

  // Derived inventory statistics.
  const inv = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    const n = rows.length;
    const heights = rows.map(t => t.height).filter(Number.isFinite).sort((a, b) => b - a);
    const dbhsCm = rows.filter(t => Number.isFinite(t.dbh)).map(t => t.dbh * 100);
    const meanHeight = heights.length ? heights.reduce((a, b) => a + b, 0) / heights.length : NaN;
    // Dominant height = mean of the tallest 20 %.
    const topN = Math.max(1, Math.round(heights.length * 0.2));
    const domHeight = heights.length ? heights.slice(0, topN).reduce((a, b) => a + b, 0) / topN : NaN;
    const meanDbh = dbhsCm.length ? dbhsCm.reduce((a, b) => a + b, 0) / dbhsCm.length : NaN;
    const totalBasal = rows.reduce((a, t) => a + (Number.isFinite(t.basalArea) ? t.basalArea : 0), 0);
    // Stand area: the defined plot boundary (a real measurement — same
    // value the Editor's Report / Thinning panels use) when one exists;
    // otherwise the dataset's horizontal bbox, which overestimates
    // irregular plots. areaBasis records which one won so the UI can
    // label every per-hectare figure below instead of presenting both
    // the same way.
    const boundaryHa = plotBoundary ? plotAreaHa(plotBoundary) : null;
    const areaM2 = entry ? Math.max(1e-6, (entry.bboxMax[0] - entry.bboxMin[0]) * (entry.bboxMax[1] - entry.bboxMin[1])) : NaN;
    const bboxHa = areaM2 / 10000;
    const ha = boundaryHa ?? bboxHa;
    return {
      n,
      meanHeight, domHeight, meanDbh,
      totalBasal,
      stemsPerHa: Number.isFinite(ha) ? n / ha : NaN,
      basalPerHa: Number.isFinite(ha) ? totalBasal / ha : NaN,
      ha,
      areaBasis: (boundaryHa != null ? 'boundary' : 'bbox') as 'boundary' | 'bbox',
      heights, dbhsCm,
      withDbh: dbhsCm.length,
    };
  }, [rows, entry, plotBoundary]);

  // Paired DBH (cm) × height (m) for the allometry scatter.
  const pairs = useMemo(() => {
    if (!rows) return { xs: [], ys: [] };
    const xs: number[] = [], ys: number[] = [];
    for (const t of rows) if (Number.isFinite(t.dbh) && Number.isFinite(t.height)) { xs.push(t.dbh * 100); ys.push(t.height); }
    return { xs, ys };
  }, [rows]);

  const treeMapEntries = useMemo<TreeMapEntry[]>(() => {
    if (!rows) return [];
    return rows.map(t => ({
      treeId: t.treeId,
      baseX: t.x, baseY: t.y,
      dbh: Number.isFinite(t.dbh) ? t.dbh * 100 : null,
      species: null,
      height: Number.isFinite(t.height) ? t.height : null,
    }));
  }, [rows]);

  if (!project) {
    return (
      <Page>
        <div className="flex-1 flex items-center justify-center mono text-[12px]" style={{ color: 'var(--text-mute)' }}>
          Open a project to view its inventory.
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <div className="flex flex-1 min-h-0">
        {/* Left rail */}
        <aside className="shrink-0 flex flex-col gap-4 p-4 overflow-y-auto scroll-thin hairline-r" style={{ width: 288, background: 'var(--wash-1)' }}>
          <div className="flex items-center gap-2">
            <div className="rounded-md flex items-center justify-center" style={{ width: 28, height: 28, background: 'color-mix(in oklch, var(--accent) 18%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)' }}>
              <InvIcon />
            </div>
            <div>
              <div className="text-[13px] font-semibold" style={{ color: 'var(--text)' }}>Inventory</div>
              <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>stand summary · distributions · map</div>
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
                {list.map(l => <option key={l.dir} value={l.dir}>{l.name} · {formatPts(l.pointCount)} pts</option>)}
              </select>
            )}
          </Field>

          {entry && (
            <div className="mono text-[9.5px] flex flex-col gap-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              <div>{entry.scannerType} · {entry.tileCount} tiles</div>
              {inv && Number.isFinite(inv.ha) && (
                <div>stand ≈ {inv.ha.toFixed(2)} ha ({inv.areaBasis === 'boundary' ? 'plot boundary' : 'bbox estimate'})</div>
              )}
            </div>
          )}

          <button
            className="btn btn-primary !h-9 w-full justify-center mono text-[12px]"
            disabled={!canRun || running}
            onClick={analyze}
            title="Compute the per-tree inventory for this dataset"
          >
            {running ? `Analyzing… ${Math.round(pct * 100)}%` : 'Analyze inventory'}
          </button>
          {running && (
            <div className="w-full rounded-full overflow-hidden -mt-2" style={{ height: 4, background: 'var(--wash-3)' }}>
              <div style={{ width: `${Math.round(pct * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
            </div>
          )}
          {!canRun && !running && (
            <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              Needs the desktop build and a dataset with ground classified + trees segmented (Editor).
            </div>
          )}
          {error && (
            <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: 'var(--danger, #e0506b)', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 45%, transparent)', lineHeight: 1.5 }}>
              {error}
            </div>
          )}
          <div className="mono text-[8.5px] mt-auto pt-2" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            {inv?.areaBasis === 'boundary'
              ? "Per-hectare figures use the defined plot boundary (set in the Editor's Plot Boundary panel) as stand area."
              : "Per-hectare figures use the dataset's horizontal bounding box as stand area — a rough estimate for irregular plots. Define a plot boundary in the Editor for a measured figure."}
          </div>
        </aside>

        {/* Right — dashboard */}
        <main className="flex-1 min-w-0 overflow-auto scroll-thin p-4">
          {!inv ? (
            <div className="h-full flex items-center justify-center mono text-[11.5px] px-6 text-center" style={{ color: 'var(--text-mute)', lineHeight: 1.6 }}>
              {running ? 'Computing inventory…' : 'Pick a dataset and Analyze to see the stand summary, DBH + height distributions, the allometry, and a tree map. Segment trees in the Editor first.'}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Summary cards */}
              <div className="grid grid-cols-6 gap-2.5">
                <Stat label="Trees" value={inv.n.toLocaleString()} />
                <Stat label="Stems/ha" value={fmt(inv.stemsPerHa, 0)} sub={inv.areaBasis === 'boundary' ? 'plot boundary' : 'bbox est.'} />
                <Stat label="Mean height" value={fmt(inv.meanHeight, 1)} unit="m" />
                <Stat label="Dominant H" value={fmt(inv.domHeight, 1)} unit="m" sub="top 20%" />
                <Stat label="Mean DBH" value={fmt(inv.meanDbh, 1)} unit="cm" sub={`${inv.withDbh}/${inv.n} fit`} />
                <Stat label="Basal/ha" value={fmt(inv.basalPerHa, 1)} unit="m²" sub={`Σ ${fmt(inv.totalBasal, 1)} m² · ${inv.areaBasis === 'boundary' ? 'boundary' : 'bbox'}`} />
              </div>

              {/* Distributions + allometry */}
              <div className="grid grid-cols-3 gap-3">
                <Card>
                  {inv.dbhsCm.length > 0
                    ? <MetricHistogram values={inv.dbhsCm} unit="cm" title="DBH distribution" xLabel="DBH" color="#7ee0a8" />
                    : <ChartEmpty title="DBH distribution" note="No DBH fits — try RANSAC stem fit in Metrics or a denser cloud." />}
                </Card>
                <Card>
                  {inv.heights.length > 0
                    ? <MetricHistogram values={inv.heights} unit="m" title="Height distribution" xLabel="Height" color="#5a9cf0" />
                    : <ChartEmpty title="Height distribution" note="No height data." />}
                </Card>
                <Card>
                  {pairs.xs.length >= 2
                    ? <MetricScatter xs={pairs.xs} ys={pairs.ys} xUnit="cm" yUnit="m" title="DBH × height" xLabel="DBH" yLabel="Height" />
                    : <ChartEmpty title="DBH × height" note="Need trees with both DBH and height." />}
                </Card>
              </div>

              {/* Tree map */}
              <Card>
                <TreeMap trees={treeMapEntries} plots={[]} title="Tree map" colorBy={colorBy} onColorByChange={setColorBy} width={900} height={420} />
              </Card>
            </div>
          )}
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

function Card({ children }: { children: React.ReactNode }) {
  return <div className="panel rounded-xl p-3 overflow-hidden">{children}</div>;
}

function ChartEmpty({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex flex-col" style={{ minHeight: 180 }}>
      <div className="mono text-[11px] mb-1" style={{ color: 'var(--text-dim)' }}>{title}</div>
      <div className="flex-1 flex items-center justify-center mono text-[10px] text-center px-4" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>{note}</div>
    </div>
  );
}

function Stat({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="panel rounded-lg px-3 py-2.5">
      <div className="mono text-[9.5px] uppercase" style={{ color: 'var(--text-mute)', letterSpacing: '0.06em' }}>{label}</div>
      <div className="flex items-baseline gap-1 mt-0.5">
        <span className="text-[18px] font-semibold tnum" style={{ color: 'var(--text)' }}>{value}</span>
        {unit && <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>{unit}</span>}
      </div>
      {sub && <div className="mono text-[9px] mt-0.5" style={{ color: 'var(--text-mute)' }}>{sub}</div>}
    </div>
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
function formatPts(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function InvIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5h18M3 12h18M3 19h18" />
      <circle cx="7" cy="5" r="0.5" fill="currentColor" /><circle cx="7" cy="12" r="0.5" fill="currentColor" /><circle cx="7" cy="19" r="0.5" fill="currentColor" />
    </svg>
  );
}
