// Plot boundary + expansion factors panel — defines a circular or
// rectangular plot boundary and surfaces PROPER per-hectare statistics
// with edge correction (none / halfcount / crown-area). Same primitive
// every commercial forestry tool computes per-ha stats off; replaces
// the "tree bbox area" approximation other panels use as a fallback.
// The boundary is a property of the DATASET: applying/clearing it here
// persists plot.json next to the octree (via octreeWritePlot), and
// EditorShell seeds shell state from that same file on every dataset
// switch, so Report and Thinning (in-shell) and InventoryModule (its
// own top-level module, read straight off the bridge) all agree on one
// value instead of each computing their own.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import type { TreeMetric, QsmResult } from '../../persistence/octreeReader';
import type { PlotBoundary, EdgeCorrection } from './OctreeShellContext';
import { loadTreeMetrics } from '../../metrics/loadMetrics';
import {
  plotAreaHa, fitRectangularToBbox, fitCircularToBbox, treeWeight,
} from '../../utils/plotBoundary';
import { computePlotStats } from '../../metrics/plotStats';

interface Desktop {
  octreeTreeMetrics?: (
    dir: string,
    params: { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number },
  ) => Promise<TreeMetric[]>;
  octreeReadQsm?: (dir: string) => Promise<QsmResult | null>;
  octreeWritePlot?: (dir: string, json: string) => Promise<void>;
}

export default function PlotBoundaryPanel() {
  const { octree, api, plotBoundary, setPlotBoundary, setWorldPicker, setFilters } = useOctreeShell();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  // Auto-load metrics + QSM so the per-hectare stats can be live.
  const [metrics, setMetrics] = useState<TreeMetric[] | null>(null);
  const [qsm, setQsm] = useState<QsmResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!octree?.dir || !desktop) { setMetrics(null); setQsm(null); return; }
      // This streams the whole cloud and rebuilds the DTM — seconds on a
      // real dataset — and it fires on every open of the panel, since the
      // floating-panel host unmounts children when closed. Without a
      // visible loading state the panel just sits there looking blank or
      // stale, which reads as broken rather than busy.
      setBusy(true);
      try {
        if (desktop.octreeTreeMetrics) {
          const t = await loadTreeMetrics(desktop, octree.dir);
          if (!cancelled) setMetrics(t);
        }
        if (desktop.octreeReadQsm) {
          const q = await desktop.octreeReadQsm(octree.dir);
          if (!cancelled) setQsm(q);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [octree?.dir, desktop]);

  // Boundary kind + per-kind state. The shell state is the source of
  // truth; these are local-only inputs the user edits before clicking
  // "Apply". Auto-fit buttons write straight to shell state.
  const [kind, setKind] = useState<'circular' | 'rectangular'>('circular');
      {busy && (
        <div className="mono text-[10px] px-1 py-0.5 rounded-sm" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)' }}>
          Loading per-tree metrics — streaming the cloud…
        </div>
      )}
  const [picking, setPicking] = useState(false);
  const [edge, setEdge] = useState<EdgeCorrection>('crownArea');
  const [halfcountBuffer, setHalfcountBuffer] = useState(1.0);

  // Circular inputs.
  const [circCx, setCircCx] = useState('');
  const [circCy, setCircCy] = useState('');
  const [circR, setCircR] = useState('15');
  // Rectangular inputs.
  const [rectXMin, setRectXMin] = useState('');
  const [rectYMin, setRectYMin] = useState('');
  const [rectXMax, setRectXMax] = useState('');
  const [rectYMax, setRectYMax] = useState('');

  // Sync local inputs from shell state.
  useEffect(() => {
    if (!plotBoundary) return;
    if (plotBoundary.kind === 'circular') {
      setKind('circular');
      setCircCx(plotBoundary.center[0].toFixed(2));
      setCircCy(plotBoundary.center[1].toFixed(2));
      setCircR(plotBoundary.radius.toFixed(2));
    } else {
      setKind('rectangular');
      setRectXMin(plotBoundary.min[0].toFixed(2));
      setRectYMin(plotBoundary.min[1].toFixed(2));
      setRectXMax(plotBoundary.max[0].toFixed(2));
      setRectYMax(plotBoundary.max[1].toFixed(2));
    }
  }, [plotBoundary]);

  // Auto-fit from tree centres.
  const xyAll = useMemo<Array<[number, number]>>(() =>
    (metrics ?? [])
      .filter(t => Number.isFinite(t.x) && Number.isFinite(t.y))
      .map(t => [t.x, t.y]),
    [metrics],
  );
  // Persist the boundary next to the dataset whenever the user sets or
  // clears it from this panel — Apply, Clear and Auto-fit all count as
  // "the user defined a boundary". Shell state alone evaporates on
  // reload and isn't visible to InventoryModule (outside the shell), so
  // plot.json next to the dataset is what makes this a property of the
  // DATASET instead of a UI session. Fire-and-forget: a write failure
  // surfaces in the error banner without blocking the on-screen update.
  const applyBoundary = useCallback((b: PlotBoundary | null) => {
    setPlotBoundary(b);
    if (!octree?.dir || !desktop?.octreeWritePlot) return;
    void desktop.octreeWritePlot(octree.dir, JSON.stringify(b ?? {})).catch((e) => {
      setError(e instanceof Error ? e.message : String(e));
    });
  }, [setPlotBoundary, octree?.dir, desktop]);

  const autoFitCirc = useCallback(() => {
    const b = fitCircularToBbox(xyAll, 0);
    if (b) applyBoundary(b);
  }, [xyAll, applyBoundary]);
  const autoFitRect = useCallback(() => {
    const b = fitRectangularToBbox(xyAll, 0);
    if (b) applyBoundary(b);
  }, [xyAll, applyBoundary]);

  // Apply local inputs to shell state (+ persist to plot.json).
  const apply = useCallback(() => {
    let boundary: PlotBoundary;
    if (kind === 'circular') {
      const cx = parseFloat(circCx), cy = parseFloat(circCy), r = parseFloat(circR);
      if (![cx, cy, r].every(Number.isFinite) || r <= 0) {
        setError('Centre + radius must be numeric and radius > 0');
        return;
      }
      boundary = { kind: 'circular', center: [cx, cy], radius: r };
    } else {
      const x0 = parseFloat(rectXMin), y0 = parseFloat(rectYMin);
      const x1 = parseFloat(rectXMax), y1 = parseFloat(rectYMax);
      if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) {
        setError('Rectangle corners must be numeric and max > min');
        return;
      }
      boundary = { kind: 'rectangular', min: [x0, y0], max: [x1, y1] };
    }
    applyBoundary(boundary);
    setError(null);
  }, [kind, circCx, circCy, circR, rectXMin, rectYMin, rectXMax, rectYMax, applyBoundary]);

  const clear = useCallback(() => {
    applyBoundary(null);
  }, [applyBoundary]);

  // Centre-from-click hook for circular boundaries.
  const armCentrePick = useCallback(() => {
    setPicking(true);
    setWorldPicker(() => (hit: [number, number, number]) => {
      setPicking(false);
      setWorldPicker(null);
      setCircCx(hit[0].toFixed(2));
      setCircCy(hit[1].toFixed(2));
      setKind('circular');
    });
  }, [setWorldPicker]);
  const cancelPick = useCallback(() => {
    setPicking(false); setWorldPicker(null);
  }, [setWorldPicker]);
  useEffect(() => () => setWorldPicker(null), [setWorldPicker]);

  // Edge-corrected per-hectare statistics. The arithmetic lives in
  // metrics/plotStats.ts so it can be tested on a plot whose answers are
  // known; this is the UI around it.
  const stats = useMemo(() => {
    if (!plotBoundary || !metrics || metrics.length === 0) return null;
    return computePlotStats(metrics, plotBoundary, edge, halfcountBuffer, qsm);
  }, [plotBoundary, metrics, qsm, edge, halfcountBuffer]);

  // 2D plan-view canvas.
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
    if (xyAll.length === 0) return;
    // Bbox of trees + boundary (whichever is larger), pad 10 %.
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    for (const [x, y] of xyAll) {
      if (x < xMin) xMin = x; if (x > xMax) xMax = x;
      if (y < yMin) yMin = y; if (y > yMax) yMax = y;
    }
    if (plotBoundary) {
      if (plotBoundary.kind === 'circular') {
        const [cx, cy] = plotBoundary.center; const r = plotBoundary.radius;
        if (cx - r < xMin) xMin = cx - r; if (cx + r > xMax) xMax = cx + r;
        if (cy - r < yMin) yMin = cy - r; if (cy + r > yMax) yMax = cy + r;
      } else {
        if (plotBoundary.min[0] < xMin) xMin = plotBoundary.min[0];
        if (plotBoundary.min[1] < yMin) yMin = plotBoundary.min[1];
        if (plotBoundary.max[0] > xMax) xMax = plotBoundary.max[0];
        if (plotBoundary.max[1] > yMax) yMax = plotBoundary.max[1];
      }
    }
    const pad = Math.max(3, (xMax - xMin + yMax - yMin) * 0.05);
    xMin -= pad; yMin -= pad; xMax += pad; yMax += pad;
    const xs = (xMax - xMin) || 1, ys = (yMax - yMin) || 1;
    const s = Math.min((cssW - 20) / xs, (cssH - 20) / ys);
    const ox = 10 + (cssW - 20 - xs * s) * 0.5;
    const oy = 10 + (cssH - 20 - ys * s) * 0.5;
    const toPx = (wx: number, wy: number): [number, number] => [
      ox + (wx - xMin) * s,
      cssH - (oy + (wy - yMin) * s),
    ];
    // Tree dots — colour by inclusion weight.
    if (metrics) {
      for (const t of metrics) {
        if (!Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
        const [px, py] = toPx(t.x, t.y);
        let w = 0;
        if (plotBoundary) {
          w = treeWeight([t.x, t.y], t.crownArea, plotBoundary, edge, halfcountBuffer);
        }
        const fill = !plotBoundary ? '#888'
          : w === 0 ? '#666'
          : w === 1 ? '#67d391'
          : '#e6c068';
        ctx.fillStyle = fill;
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 0.6;
        const r = Math.max(2, Math.min(6, 2 + (Number.isFinite(t.dbh) ? t.dbh * 12 : 0)));
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
      }
    }
    // Boundary overlay.
    if (plotBoundary) {
      ctx.strokeStyle = 'var(--accent)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      if (plotBoundary.kind === 'circular') {
        const [cpx, cpy] = toPx(plotBoundary.center[0], plotBoundary.center[1]);
        const rPx = plotBoundary.radius * s;
        ctx.beginPath();
        ctx.arc(cpx, cpy, rPx, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const [x0, y1] = toPx(plotBoundary.min[0], plotBoundary.min[1]);
        const [x1, y0] = toPx(plotBoundary.max[0], plotBoundary.max[1]);
        ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1),
          Math.abs(x1 - x0), Math.abs(y1 - y0));
      }
      ctx.setLineDash([]);
    }
    // North marker.
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '10px ui-monospace,monospace';
    ctx.fillText('N ↑', cssW - 28, 16);
  }, [xyAll, metrics, plotBoundary, edge, halfcountBuffer]);

  // Optional: fly the camera around the boundary.
  const flyToBoundary = useCallback(() => {
    if (!api || !plotBoundary || !octree) return;
    if (plotBoundary.kind === 'circular') {
      const [cx, cy] = plotBoundary.center; const r = plotBoundary.radius;
      api.frameBox(
        [cx - r, cy - r, octree.meta.boundingBox.min[2]],
        [cx + r, cy + r, octree.meta.boundingBox.max[2]],
      );
    } else {
      api.frameBox(
        [plotBoundary.min[0], plotBoundary.min[1], octree.meta.boundingBox.min[2]],
        [plotBoundary.max[0], plotBoundary.max[1], octree.meta.boundingBox.max[2]],
      );
    }
  }, [api, plotBoundary, octree]);

  // Apply an X/Y world-coord clip filter matching the boundary, so
  // the 3D viewport limits to the plot. Rectangular only; the
  // existing xRange / yRange filters are axis-aligned.
  const applyClipFilter = useCallback(() => {
    if (!plotBoundary) return;
    if (plotBoundary.kind === 'rectangular') {
      setFilters({
        xRange: [plotBoundary.min[0], plotBoundary.max[0]],
        yRange: [plotBoundary.min[1], plotBoundary.max[1]],
      });
    } else {
      // Circular falls back to bbox of the circle.
      const [cx, cy] = plotBoundary.center; const r = plotBoundary.radius;
      setFilters({
        xRange: [cx - r, cx + r],
        yRange: [cy - r, cy + r],
      });
    }
  }, [plotBoundary, setFilters]);

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 420 }}>
      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      {/* Kind chips */}
      <div className="flex items-center gap-1">
        <span className="mono text-[10px]" style={{ color: 'var(--text-dim)', minWidth: 56 }}>Plot</span>
        <ChipBtn label="Circular" active={kind === 'circular'} onClick={() => setKind('circular')} />
        <ChipBtn label="Rectangular" active={kind === 'rectangular'} onClick={() => setKind('rectangular')} />
      </div>

      {/* Circular inputs */}
      {kind === 'circular' && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="flex items-center gap-1.5">
            <label className="mono text-[10px] w-[80px]" style={{ color: 'var(--text-dim)' }}>Centre X</label>
            <NumberField value={circCx} onChange={setCircCx} />
            <label className="mono text-[10px] w-[40px]" style={{ color: 'var(--text-dim)' }}>Y</label>
            <NumberField value={circCy} onChange={setCircCy} />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="mono text-[10px] w-[80px]" style={{ color: 'var(--text-dim)' }}>Radius (m)</label>
            <NumberField value={circR} onChange={setCircR} />
            <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
              area = {(Math.PI * (parseFloat(circR) || 0) ** 2 / 10000).toFixed(4)} ha
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button className="btn !h-7 !px-2 mono text-[10px]" onClick={armCentrePick} disabled={picking || busy}
              style={{
                background: picking ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
                color: picking ? 'var(--accent)' : undefined,
                borderColor: picking ? 'var(--accent)' : undefined,
              }}>
              {picking ? 'Click in viewport · (cancel)' : '🎯 Pick centre from cloud'}
            </button>
            {picking && (
              <button className="btn !h-7 !px-2 mono text-[10px]" onClick={cancelPick}>Cancel</button>
            )}
            <button className="btn !h-7 !px-2 mono text-[10px]" onClick={autoFitCirc} disabled={xyAll.length === 0}>
              Auto-fit
            </button>
          </div>
        </div>
      )}

      {/* Rectangular inputs */}
      {kind === 'rectangular' && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="flex items-center gap-1.5">
            <label className="mono text-[10px] w-[80px]" style={{ color: 'var(--text-dim)' }}>X min / max</label>
            <NumberField value={rectXMin} onChange={setRectXMin} />
            <NumberField value={rectXMax} onChange={setRectXMax} />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="mono text-[10px] w-[80px]" style={{ color: 'var(--text-dim)' }}>Y min / max</label>
            <NumberField value={rectYMin} onChange={setRectYMin} />
            <NumberField value={rectYMax} onChange={setRectYMax} />
          </div>
          <div className="flex items-center gap-1.5">
            <button className="btn !h-7 !px-2 mono text-[10px]" onClick={autoFitRect} disabled={xyAll.length === 0}>
              Auto-fit from tree bbox
            </button>
            <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
              area = {(
                ((parseFloat(rectXMax) || 0) - (parseFloat(rectXMin) || 0))
                * ((parseFloat(rectYMax) || 0) - (parseFloat(rectYMin) || 0)) / 10000
              ).toFixed(4)} ha
            </span>
          </div>
        </div>
      )}

      {/* Apply / clear / fly */}
      <div className="flex items-center gap-1.5">
        <button className="btn !h-7 mono text-[11px] flex-1 justify-center" onClick={apply}>
          Apply boundary
        </button>
        <button className="btn !h-7 !px-2 mono text-[11px]" onClick={clear} disabled={!plotBoundary}>
          Clear
        </button>
        <button className="btn !h-7 !px-2 mono text-[11px]" onClick={flyToBoundary} disabled={!plotBoundary || !api} title="Fly camera around boundary">↗</button>
      </div>

      {/* Edge correction */}
      <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center gap-1 flex-wrap">
          <span className="mono text-[10px]" style={{ color: 'var(--text-dim)', minWidth: 56 }}>Edge corr</span>
          <ChipBtn label="None" active={edge === 'none'} onClick={() => setEdge('none')} />
          <ChipBtn label="Halfcount" active={edge === 'halfcount'} onClick={() => setEdge('halfcount')} />
          <ChipBtn label="Crown area" active={edge === 'crownArea'} onClick={() => setEdge('crownArea')} />
        </div>
        {edge === 'halfcount' && (
          <div className="flex items-center gap-1.5">
            <label className="mono text-[10px] w-[110px]" style={{ color: 'var(--text-dim)' }}>Buffer (m)</label>
            <input type="range" min={0.1} max={3} step={0.1}
              value={halfcountBuffer}
              onChange={(e) => setHalfcountBuffer(parseFloat(e.target.value))}
              className="flex-1" />
            <span className="mono text-[10px] w-[48px] text-right" style={{ color: 'var(--text)' }}>{halfcountBuffer.toFixed(1)}</span>
          </div>
        )}
        <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
          {edge === 'none' && 'Strict in/out by stem centre. Bias-prone — fast.'}
          {edge === 'halfcount' && 'Trees within the buffer count 0.5. Schreuder/Husch standard, slightly biased low.'}
          {edge === 'crownArea' && 'Per-tree weight = fraction of crown disk inside the plot (Monte-Carlo, 64 samples). Most defensible in mixed-density stands.'}
        </div>
      </div>

      {/* 2D plan view */}
      <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)', background: '#0a0c10', height: 280 }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      </div>

      {/* Per-hectare stats */}
      {stats && (
        <div className="rounded-md p-2 flex flex-col gap-1" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="flex items-baseline gap-2">
            <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Plot area</span>
            <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>{stats.areaHa.toFixed(4)} ha</span>
            <span className="flex-1" />
            <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
              {stats.nFullyIn} fully · {stats.nPartial} partial · {stats.nOut} out
            </span>
          </div>
          <StatRow label="Stems / ha" value={`${stats.stemsPerHa.toFixed(0)}`} hint={`Σ weight = ${stats.nWeighted.toFixed(2)} of ${stats.nFullyIn + stats.nPartial}`} />
          <StatRow label="Basal area / ha" value={`${stats.basalAreaPerHa.toFixed(2)} m²/ha`} />
          <StatRow label="Lorey's mean H" value={`${Number.isFinite(stats.loreyMeanHeight) ? stats.loreyMeanHeight.toFixed(2) : '—'} m`} hint="basal-area weighted" />
          {stats.hasQsm && (
            <StatRow label="Stem volume / ha" value={`${stats.stemVolumePerHa.toFixed(2)} m³/ha`}
              hint={`± ${stats.stemVolumeCi95PerHa.toFixed(3)} m³/ha · 95 % CI`} />
          )}
        </div>
      )}

      {/* Optional XY clip filter — narrows the 3D viewport to the plot. */}
      {plotBoundary && (
        <button className="btn !h-6 mono text-[10.5px] justify-center" onClick={applyClipFilter}>
          Clip 3D viewport to plot extent
        </button>
      )}

      <div className="mono text-[9.5px] px-1.5 py-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        The boundary is saved next to the dataset (plot.json) — Report, Thinning and Inventory all read the same value for their per-hectare figures. Green dots = trees fully inside, yellow = partial (edge-corrected), grey = outside.
      </div>
    </div>
  );
}

function NumberField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-transparent mono text-[10.5px] px-1.5 py-0.5 flex-1 min-w-0"
      style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
    />
  );
}

function StatRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2 mono text-[10.5px]">
      <span style={{ color: 'var(--text-dim)', width: 130 }}>{label}</span>
      <span style={{ color: 'var(--text)' }}>{value}</span>
      {hint && <span style={{ color: 'var(--text-mute)', fontSize: 9.5 }}>{hint}</span>}
    </div>
  );
}

function ChipBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className="mono text-[10px] px-2 py-0.5 rounded-sm whitespace-nowrap"
      style={{
        color: active ? 'var(--accent)' : 'var(--text-dim)',
        background: active ? 'color-mix(in oklch, var(--accent) 14%, transparent)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
        cursor: 'pointer',
      }}>
      {label}
    </button>
  );
}
