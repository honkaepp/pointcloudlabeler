// The stretch of a colour ramp: where its colours run, over a
// histogram of the values (the loaded points, three/colorHistogram.ts).
//
// Drag either end on the histogram, type it, or let Auto cut the 2 % tails
// (intensity and reflectance in particular are skewed by a few strong
// returns that otherwise take the whole ramp). The range is kept in the
// units the legend shows; Reset gives the cloud's own range back.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOctreeShell, type ColorHistogram, type ColorMode } from './OctreeShellContext';
import { tidy } from '../../three/colorHistogram';
import { rampRangeKey } from '../../three/colorStretch';
import { treeMetricDef, type TreeMetricKey } from '../../three/treeMetricColors';

/** The modes whose ramp can be stretched (a tree metric that is a
 *  measurement, not a flag). */
export function isStretchable(m: ColorMode, treeMetric?: TreeMetricKey): boolean {
  if (m === 'tree_metric') return treeMetricDef(treeMetric).kind === 'ramp';
  return m === 'height' || m === 'intensity' || m === 'x' || m === 'y' || (typeof m === 'string' && m.startsWith('extra:'));
}

type RampKey = 'height' | 'heightAboveGround' | 'intensity' | 'x' | 'y';

/** The active ramp's range and how to change it, kept per mode:
 *  DisplayConfig.rampRanges for the built-in ramps, extraRangeOverrides for
 *  an extra column, treeRanges for a tree metric. Shared by the Display
 *  panel and the legend. */
export function useRampStretch() {
  const { display, setDisplay, stats, api, octree } = useOctreeShell();
  const mode = display.colorMode;
  const [hist, setHist] = useState<ColorHistogram | null>(null);
  const refresh = useCallback((): ColorHistogram | null => {
    const h = api?.colorHistogram(64) ?? null;
    setHist(h);
    return h;
  }, [api]);
  // read it now, and again once more of the cloud has streamed in
  useEffect(() => {
    if (!isStretchable(mode, display.treeMetric)) return;
    refresh();
    const t = setTimeout(refresh, 2000);
    return () => clearTimeout(t);
  }, [mode, octree?.dir, display.heightColorAboveGround, display.treeMetric, refresh]);
  const extra = typeof mode === 'string' && mode.startsWith('extra:') ? mode.slice('extra:'.length) : null;
  const tree = mode === 'tree_metric' ? treeMetricDef(display.treeMetric) : null;
  const key = extra || tree ? null : (hist?.key as RampKey | undefined) ?? rampRangeKey(mode, display.heightColorAboveGround === true);
  const current = stats.rampLo !== null && stats.rampHi !== null ? { lo: stats.rampLo, hi: stats.rampHi } : null;
  const overridden = extra ? !!display.extraRangeOverrides?.[extra] : tree ? !!display.treeRanges?.[tree.id] : !!(key && display.rampRanges?.[key]);
  const setRange = (r: Range | null) => {
    if (tree) {
      const next = { ...(display.treeRanges ?? {}) };
      if (r) next[tree.id] = r; else delete next[tree.id];
      setDisplay({ treeRanges: next });
    } else if (extra) {
      const next = { ...(display.extraRangeOverrides ?? {}) };
      if (r) next[extra] = r; else delete next[extra];
      setDisplay({ extraRangeOverrides: next });
    } else if (key) {
      const next = { ...(display.rampRanges ?? {}) };
      if (r) next[key] = r; else delete next[key];
      setDisplay({ rampRanges: next });
    }
  };
  const integer = mode === 'intensity';
  /** The 2–98 % stretch of what is loaded now. */
  const auto = () => {
    const h = refresh();
    if (h) setRange(autoRange(h, integer));
  };
  const unit = mode === 'height' || mode === 'x' || mode === 'y' ? 'm' : tree ? tree.unit : '';
  return { mode, hist, refresh, current, overridden, setRange, auto, unit, integer };
}

/** The 2–98 % range of a histogram, tidied. */
export function autoRange(h: ColorHistogram, integer: boolean): Range {
  return integer
    ? { lo: Math.round(h.p.p2), hi: Math.max(Math.round(h.p.p2) + 1, Math.round(h.p.p98)) }
    : { lo: tidy(h.p.p2, h.lo, h.hi), hi: tidy(h.p.p98, h.lo, h.hi) };
}

const W = 206;
const H = 46;

export interface Range { lo: number; hi: number }

/** Where a value sits across the drawn domain, 0 … 1. */
export function domainT(v: number, d: Range): number {
  return d.hi > d.lo ? Math.min(1, Math.max(0, (v - d.lo) / (d.hi - d.lo))) : 0;
}

/** The domain drawn: the histogram's, widened to take the current range. */
export function drawnDomain(h: ColorHistogram | null, current: Range | null): Range | null {
  if (!h && !current) return null;
  const lo = Math.min(h ? h.lo : Infinity, current ? current.lo : Infinity);
  const hi = Math.max(h ? h.hi : -Infinity, current ? current.hi : -Infinity);
  return hi > lo ? { lo, hi } : null;
}

export default function RangeEditor({ current, overridden, histogram, onRefresh, onChange, unit, integer }: {
  /** The range the ramp runs over now (the legend's). */
  current: Range | null;
  /** Whether that is a set range (Reset then gives the cloud's back). */
  overridden: boolean;
  histogram: ColorHistogram | null;
  onRefresh: () => void;
  onChange: (r: Range | null) => void;
  unit: string;
  integer?: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<'lo' | 'hi' | null>(null);
  const d = drawnDomain(histogram, current);

  const valueAt = useCallback((clientX: number): number | null => {
    const el = svg.current;
    if (!el || !d) return null;
    const r = el.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
    return d.lo + t * (d.hi - d.lo);
  }, [d]);

  useEffect(() => {
    if (!drag || !current || !d) return;
    const move = (e: PointerEvent) => {
      const v = valueAt(e.clientX);
      if (v === null) return;
      const t = integer ? Math.round(v) : tidy(v, d.lo, d.hi);
      if (drag === 'lo' && t < current.hi) onChange({ lo: t, hi: current.hi });
      if (drag === 'hi' && t > current.lo) onChange({ lo: current.lo, hi: t });
    };
    const up = () => setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [drag, current, d, valueAt, onChange, integer]);

  const max = histogram ? Math.max(1, ...histogram.counts) : 1;
  const x = (v: number) => (d ? domainT(v, d) * W : 0);
  const fmt = (v: number) => (integer ? String(Math.round(v)) : String(+v.toPrecision(6)));

  return (
    <div className="flex flex-col gap-1">
      <svg ref={svg} width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block', cursor: drag ? 'ew-resize' : 'default', background: 'rgba(0,0,0,0.25)', borderRadius: 4 }}
        onPointerDown={(e) => {
          // the nearer end follows a press anywhere on the strip
          if (!current) return;
          const v = valueAt(e.clientX);
          if (v === null) return;
          setDrag(Math.abs(v - current.lo) <= Math.abs(v - current.hi) ? 'lo' : 'hi');
        }}>
        {histogram && d && histogram.counts.map((c, i) => {
          const bw = W / histogram.counts.length;
          const v0 = histogram.lo + (i / histogram.counts.length) * (histogram.hi - histogram.lo);
          const bx = x(v0);
          const bh = (Math.sqrt(c) / Math.sqrt(max)) * (H - 4);
          return <rect key={i} x={bx} y={H - bh} width={Math.max(1, bw * (histogram.hi - histogram.lo) / (d.hi - d.lo) - 0.5)} height={bh} fill="var(--text-dim)" opacity={0.55} />;
        })}
        {current && d && (
          <>
            <rect x={0} y={0} width={x(current.lo)} height={H} fill="rgba(0,0,0,0.45)" />
            <rect x={x(current.hi)} y={0} width={Math.max(0, W - x(current.hi))} height={H} fill="rgba(0,0,0,0.45)" />
            {(['lo', 'hi'] as const).map((k) => (
              <g key={k} style={{ cursor: 'ew-resize' }} onPointerDown={(e) => { e.stopPropagation(); setDrag(k); }}>
                <line x1={x(current[k])} x2={x(current[k])} y1={0} y2={H} stroke="var(--accent)" strokeWidth={2} />
                <rect x={x(current[k]) - 4} y={H / 2 - 7} width={8} height={14} rx={2} fill="var(--accent)" />
              </g>
            ))}
          </>
        )}
        {!histogram && (
          <text x={W / 2} y={H / 2 + 3} textAnchor="middle" fontSize={9.5} fontFamily="monospace" fill="var(--text-mute)">no histogram yet</text>
        )}
      </svg>
      <div className="flex items-center gap-1">
        <Num value={current?.lo ?? NaN} onCommit={(v) => current && v < current.hi && onChange({ lo: v, hi: current.hi })} title={`Ramp start${unit ? ` (${unit})` : ''}`} />
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>…</span>
        <Num value={current?.hi ?? NaN} onCommit={(v) => current && v > current.lo && onChange({ lo: current.lo, hi: v })} title={`Ramp end${unit ? ` (${unit})` : ''}`} />
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{unit}</span>
      </div>
      <div className="flex items-center gap-1 flex-wrap">
        <Chip disabled={!histogram} title="Cut the weakest and strongest 2 % of the values: the ramp spans what most points have"
          onClick={() => histogram && onChange(autoRange(histogram, !!integer))}>
          Auto 2–98 %
        </Chip>
        <Chip disabled={!histogram} title="Every loaded value, end to end" onClick={() => histogram && onChange({ lo: histogram.lo, hi: histogram.hi })}>Full</Chip>
        <Chip disabled={!overridden} title="The cloud's own range" onClick={() => onChange(null)}>Reset</Chip>
        <Chip title="Read the histogram again from what is loaded now" onClick={onRefresh}>↻</Chip>
        {histogram && <span className="mono text-[9px] ml-auto" style={{ color: 'var(--text-mute)' }} title="The loaded points: an even sample of the cloud">{fmtCount(histogram.samples)} pts</span>}
      </div>
      {current && <span className="sr-only">{fmt(current.lo)}–{fmt(current.hi)}</span>}
    </div>
  );
}

function fmtCount(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n);
}

function Chip({ children, onClick, disabled, title }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title}
      className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm"
      style={{ color: disabled ? 'var(--text-mute)' : 'var(--text-dim)', border: '1px solid var(--line)', background: 'none', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      {children}
    </button>
  );
}

/** A number input that keeps a draft while typing and commits on Enter / blur. */
function Num({ value, onCommit, title }: { value: number; onCommit: (v: number) => void; title?: string }) {
  const [draft, setDraft] = useState(Number.isFinite(value) ? String(+value.toPrecision(7)) : '');
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) { last.current = value; setDraft(Number.isFinite(value) ? String(+value.toPrecision(7)) : ''); }
  }, [value]);
  const commit = () => {
    const v = Number(draft.replace(',', '.'));
    if (draft.trim() !== '' && Number.isFinite(v)) onCommit(v);
    else setDraft(Number.isFinite(value) ? String(+value.toPrecision(7)) : '');
  };
  return (
    <input value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} title={title}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }}
      className="mono text-[10px] py-0.5 px-1.5 rounded-sm text-right outline-none"
      style={{ width: 78, background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }} />
  );
}
