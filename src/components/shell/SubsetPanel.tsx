// Subset / Extract panel — build a NEW dataset from the active cloud by
// keeping only the points that fall inside a set of attribute ranges
// (X / Y / Z in world units · intensity · tree_id · any numeric extra such
// as reflectance / amplitude). The native command streams the source
// octree, applies the same patch + merge overlay an export would, filters,
// and rebuilds a first-class LOD octree under the project so it lands in
// the Datasets list straight away.

import { useEffect, useMemo, useState } from 'react';
import { cancelStage, canCancel } from '../../ui/cancelStage';
import { useOctreeShell } from './OctreeShellContext';
import DualRangeSlider from './DualRangeSlider';
import { CLASS_OPTIONS } from './FiltersPanel';

interface Desktop {
  octreeSubset?: (args: {
    srcDir: string; outDir: string; name: string; scannerType: string;
    filter: {
      xRange?: [number, number]; yRange?: [number, number]; zRange?: [number, number];
      intensityRange?: [number, number]; treeIdRange?: [number, number];
      classes?: number[]; extraRanges?: { name: string; min: number; max: number }[];
    };
  }) => Promise<{ outDir: string; pointCount: number; tileCount: number; durationMs: number }>;
  onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void> | (() => void);
}

/** One optional [min, max] range row. Empty bounds are open-ended; both
 *  empty → the constraint is off. Values are plain numbers (world units
 *  for X/Y/Z, raw for intensity / extras). */
interface RangeState { min: string; max: string }
const EMPTY: RangeState = { min: '', max: '' };

function toRange(r: RangeState): [number, number] | undefined {
  const lo = r.min.trim() === '' ? -Infinity : parseFloat(r.min);
  const hi = r.max.trim() === '' ? Infinity : parseFloat(r.max);
  if (!Number.isFinite(lo) && !Number.isFinite(hi)) return undefined;
  return [Number.isFinite(lo) ? lo : -1e30, Number.isFinite(hi) ? hi : 1e30];
}

export default function SubsetPanel() {
  const { octree, refreshDatasets, setSubsetPreview } = useOctreeShell();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;
  const canRun = !!desktop?.octreeSubset && !!octree;

  const bbMin = octree?.meta.boundingBox.min;
  const bbMax = octree?.meta.boundingBox.max;
  const extras = useMemo(() => octree?.meta.extras ?? [], [octree]);

  const [name, setName] = useState('');
  const [x, setX] = useState<RangeState>(EMPTY);
  const [y, setY] = useState<RangeState>(EMPTY);
  const [z, setZ] = useState<RangeState>(EMPTY);
  const [intensity, setIntensity] = useState<RangeState>(EMPTY);
  const [treeId, setTreeId] = useState<RangeState>(EMPTY);
  // Per-extra ranges keyed by column name.
  const [extraRanges, setExtraRanges] = useState<Record<string, RangeState>>({});
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const defaultName = (octree?.meta.name || 'cloud') + '_subset';

  // Drive the live preview clip ("wall") from the X/Y/Z ranges so the
  // viewport shows the cloud cut to the box you're dragging out, before
  // you commit to building the subset. Cleared when the panel unmounts
  // (closed) so it never lingers as a stray clip.
  useEffect(() => {
    setSubsetPreview({ xRange: toRange(x) ?? null, yRange: toRange(y) ?? null, zRange: toRange(z) ?? null });
  }, [x, y, z, setSubsetPreview]);
  useEffect(() => () => setSubsetPreview(null), [setSubsetPreview]);
  // Classification keep-list. The backend's SubsetFilter has always
  // supported this — the panel just never sent it, so "extract just the
  // ground points as a new dataset" had no direct path even though
  // Subset is the tool for exactly that.
  const [keepClasses, setKeepClasses] = useState<number[]>(() => CLASS_OPTIONS.map(o => o.code));
  const toggleClass = (code: number) => setKeepClasses(prev =>
    prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code].sort((a, b) => a - b));


  const run = async () => {
    if (!desktop?.octreeSubset || !octree) return;
    const finalName = (name.trim() || defaultName).replace(/[\\/:*?"<>|]+/g, '_');
    // Write the subset next to the source under the project's octrees dir
    // (the source dir's parent), so it shows up in the same Datasets list.
    const parent = octree.dir.replace(/[\\/][^\\/]+[\\/]?$/, '');
    const outDir = `${parent}/${finalName}`;
    const extraRangePayload = extras
      .map(e => ({ e, r: toRange(extraRanges[e.name] ?? EMPTY) }))
      .filter((x): x is { e: typeof extras[number]; r: [number, number] } => x.r !== undefined)
      .map(({ e, r }) => ({ name: e.name, min: r[0], max: r[1] }));

    const filter = {
      xRange: toRange(x), yRange: toRange(y), zRange: toRange(z),
      intensityRange: toRange(intensity), treeIdRange: toRange(treeId),
      extraRanges: extraRangePayload.length ? extraRangePayload : undefined,
      // A keep-list, matching the export dialog's shape. Undefined when
      // every class is ticked, so the common case sends no constraint at
      // all rather than an all-inclusive list.
      classes: keepClasses.length === CLASS_OPTIONS.length ? undefined : keepClasses,
    };

    setRunning(true); setPct(0); setError(null); setResult(null);
    let unlisten: (() => void) | undefined;
    try {
      if (desktop.onOctreeProgress) {
        unlisten = await Promise.resolve(desktop.onOctreeProgress((e) => {
          if (e.stage === 'subset' || e.stage === 'build' || e.stage === 'stitch') setPct(e.pct);
        })) as (() => void);
      }
      const res = await desktop.octreeSubset({
        srcDir: octree.dir, outDir, name: finalName,
        scannerType: octree.meta.scannerType, filter,
      });
      setResult(`${res.pointCount.toLocaleString()} pts → "${finalName}"`);
      await refreshDatasets?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      unlisten?.();
      setRunning(false); setPct(0);
    }
  };

  return (
    <div className="flex flex-col gap-2.5" style={{ width: 256 }}>
      <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Keep only points inside these ranges and save them as a new dataset. Leave a bound empty for open-ended. Edits, deletions and merges on the active cloud are applied first.
      </div>

      {!canRun && (
        <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
          Subset needs the desktop build and an open cloud.
        </div>
      )}

      <Section label="Spatial (world units)">
        <Range label="X" range={x} onChange={setX} loPh={bbMin?.[0]} hiPh={bbMax?.[0]} />
        <Range label="Y" range={y} onChange={setY} loPh={bbMin?.[1]} hiPh={bbMax?.[1]} />
        <Range label="Z" range={z} onChange={setZ} loPh={bbMin?.[2]} hiPh={bbMax?.[2]} />
      </Section>

      <Section label="Attributes">
        <Range label="Intensity" range={intensity} onChange={setIntensity} />
        <Range label="tree_id" range={treeId} onChange={setTreeId} integer />
      </Section>

      <Section label="Classification">
        <div className="flex flex-wrap gap-1">
          {CLASS_OPTIONS.map(opt => {
            const on = keepClasses.includes(opt.code);
            return (
              <button
                key={opt.code}
                onClick={() => toggleClass(opt.code)}
                disabled={running}
                className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm flex items-center gap-1"
                style={{
                  border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                  color: on ? 'var(--text)' : 'var(--text-mute)',
                  opacity: on ? 1 : 0.55,
                }}
                title={`Class ${opt.code} — ${opt.label}`}
              >
                <span style={{ width: 7, height: 7, borderRadius: 2, background: opt.swatch, display: 'inline-block' }} />
                {opt.label}
              </button>
            );
          })}
        </div>
        <div className="mono text-[9px] mt-1" style={{ color: 'var(--text-mute)' }}>
          {keepClasses.length === CLASS_OPTIONS.length
            ? 'All classes kept — no constraint is sent.'
            : `Keeping ${keepClasses.length} of ${CLASS_OPTIONS.length} classes.`}
        </div>
      </Section>

      {extras.length > 0 && (
        <Section label="Extras">
          {extras.map(e => (
            <Range
              key={e.name}
              label={e.name}
              range={extraRanges[e.name] ?? EMPTY}
              onChange={(r) => setExtraRanges(m => ({ ...m, [e.name]: r }))}
              loPh={e.min} hiPh={e.max}
            />
          ))}
        </Section>
      )}

      <Section label="New dataset name">
        <input
          value={name}
          placeholder={defaultName}
          onChange={(e) => setName(e.target.value)}
          className="w-full mono text-[12px] py-1.5 px-2 rounded-md"
          style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', outline: 'none' }}
        />
      </Section>

      <div className="flex gap-1.5">
        <button
          className="btn btn-primary !h-8 flex-1 justify-center mono text-[11.5px]"
          disabled={!canRun || running}
          onClick={run}
          title="Build a new dataset from the points passing these ranges"
        >
          {running ? `Extracting… ${Math.round(pct * 100)}%` : 'Create subset cloud'}
        </button>
        {running && (
          <button className="btn !h-8 mono text-[11px] !px-3" onClick={() => cancelStage('subset')} disabled={!canCancel()}
            title="Stop — the partial dataset is removed">Cancel</button>
        )}
      </div>

      {running && (
        <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: 'var(--wash-3)' }}>
          <div style={{ width: `${Math.round(pct * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
        </div>
      )}
      {result && !running && (
        <div className="mono text-[10.5px]" style={{ color: 'var(--accent)', lineHeight: 1.5 }}>
          ✓ {result} · open it from the Layers panel.
        </div>
      )}
      {error && (
        <div className="mono text-[10px]" style={{ color: 'var(--danger, #e0506b)', lineHeight: 1.5 }}>{error}</div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="chip mb-1.5">{label}</div>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function Range({ label, range, onChange, loPh, hiPh, integer }: {
  label: string;
  range: RangeState;
  onChange: (r: RangeState) => void;
  loPh?: number;
  hiPh?: number;
  integer?: boolean;
}) {
  const active = range.min.trim() !== '' || range.max.trim() !== '';
  const fmt = (n: number | undefined) => (n === undefined ? '' : (Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2)));
  // A slider appears when this column has known bounds (spatial extent
  // from the bbox, or an extra's metadata min/max). Open ends fall back
  // to the bound; the numeric fields keep working in lock-step.
  const hasBounds = loPh !== undefined && hiPh !== undefined && hiPh > loPh;
  const toNum = (s: string, fallback: number) => { const v = parseFloat(s); return Number.isFinite(v) ? v : fallback; };
  const round = (v: number) => integer ? Math.round(v) : Math.round(v * 1000) / 1000;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className="mono text-[10.5px] shrink-0" style={{ width: 64, color: active ? 'var(--text)' : 'var(--text-dim)' }}>{label}</span>
        <input
          type="number" step={integer ? 1 : 'any'} value={range.min}
          placeholder={fmt(loPh) || 'min'}
          onChange={(e) => onChange({ ...range, min: e.target.value })}
          className="flex-1 min-w-0 mono text-[11.5px] py-1 px-1.5 rounded-md"
          style={{ background: 'rgba(0,0,0,0.3)', border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 40%, transparent)' : 'var(--line)'}`, color: 'var(--text)', outline: 'none' }}
        />
        <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>…</span>
        <input
          type="number" step={integer ? 1 : 'any'} value={range.max}
          placeholder={fmt(hiPh) || 'max'}
          onChange={(e) => onChange({ ...range, max: e.target.value })}
          className="flex-1 min-w-0 mono text-[11.5px] py-1 px-1.5 rounded-md"
          style={{ background: 'rgba(0,0,0,0.3)', border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 40%, transparent)' : 'var(--line)'}`, color: 'var(--text)', outline: 'none' }}
        />
      </div>
      {hasBounds && (
        <div className="pl-[70px]">
          <DualRangeSlider
            min={loPh as number}
            max={hiPh as number}
            step={integer ? 1 : undefined}
            value={[toNum(range.min, loPh as number), toNum(range.max, hiPh as number)]}
            onChange={([a, b]) => {
              const bl = loPh as number, bh = hiPh as number;
              // Snap-to-edge keeps the field empty (open-ended) so a slider
              // at the extent reads as "no constraint on that side".
              const atLo = a <= bl + (bh - bl) * 1e-4;
              const atHi = b >= bh - (bh - bl) * 1e-4;
              onChange({ min: atLo ? '' : String(round(a)), max: atHi ? '' : String(round(b)) });
            }}
          />
        </div>
      )}
    </div>
  );
}
