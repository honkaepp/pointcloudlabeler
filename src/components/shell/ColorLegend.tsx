// Colour-scale legend — read-only readout overlaid bottom-left of the
// viewport, explaining what the active colour mode's colours MEAN
// numerically. A green-to-red canopy says nothing without "3.2 m … 27.8 m"
// beside it, and PointCloudLabeler presents itself as a measurement instrument.
//
// Scalar modes (height / intensity / x / y / extras) get a gradient bar
// sampled from the SAME ramp resolver colorNode() paints points with (see
// rampColor, exported from OctreeView), with low/high bounds read straight
// from ViewerStats.rampLo/rampHi — NodeStreamer fills those every frame
// from the exact span objects colorNode() was called with, so this can
// never show a bound the shader didn't actually use. Categorical modes get
// a small fixed swatch key (classification / semantic, reusing the SAME
// code→colour lists the Filters panel toggles) or hide entirely — hash
// colours (tree_id, deadwood) and a flat tint have no scale to legend.
//
// The legend is also a control. A class or semantic swatch hides
// its points (Alt-click: only those), a scalar bound can be typed, Auto
// stretches the ramp over the loaded points' 2–98 %, and the bounds are the
// world's: elevations, eastings, northings (engineState.colorUniforms).
// Tree ids show the active tree and the unlabelled colour; trees coloured
// by a measurement show its ramp and bounds, or the flag colours.

import { useEffect, useRef, useState } from 'react';
import { rampColor } from '../../three/palette';
import { formatTick } from '../chart/ticks';
import { useOctreeShell, type ColorMode, type ColorRamp } from './OctreeShellContext';
import { classOptionsFor, SEMANTIC_OPTIONS } from './FiltersPanel';
import { useRampStretch } from './RangeEditor';
import { FLAG_LABELS, FLAG_RGB, treeMetricDef } from '../../three/treeMetricColors';

const GRADIENT_STOPS = 24;
const BAR_WIDTH = 120;
const BAR_HEIGHT = 8;
/** ASPRS classes are a byte; semantic codes 0 … 4 (see FiltersPanel's domains). */
const CLASS_DOMAIN_MAX = 255;
const SEMANTIC_DOMAIN_MAX = 4;

/** Sample rampColor at even steps into a CSS gradient. Deliberately NOT
 *  hand-written per-ramp CSS — 'custom' is user-defined via colour
 *  pickers, so a hard-coded gradient would be wrong the moment someone
 *  picks their own low/high colour. */
function rampToCss(ramp: ColorRamp): string {
  const rgb: [number, number, number] = [0, 0, 0];
  const stops: string[] = [];
  for (let i = 0; i < GRADIENT_STOPS; i++) {
    const t = i / (GRADIENT_STOPS - 1);
    rampColor(ramp, t, rgb);
    stops.push(`rgb(${rgb[0]},${rgb[1]},${rgb[2]}) ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

/** Title + unit for each scalar mode — titles match the Display panel's
 *  own button labels so the legend reads as "the thing you just clicked".
 *  Height/X/Y are metric distances in the dataset's source CRS; intensity
 *  is the raw stored 16-bit value (integer, no unit); extras carry
 *  whatever unit the source column had, unknown to PointCloudLabeler, so left bare. */
function scalarMeta(mode: ColorMode, aboveGround: boolean): { title: string; unit: string; integer?: boolean } | null {
  if (mode === 'height') return { title: aboveGround ? 'Height above ground' : 'Elevation', unit: 'm' };
  if (mode === 'x') return { title: 'X (east)', unit: 'm' };
  if (mode === 'y') return { title: 'Y (north)', unit: 'm' };
  if (mode === 'intensity') return { title: 'Intensity', unit: '', integer: true };
  if (typeof mode === 'string' && mode.startsWith('extra:')) return { title: mode.slice('extra:'.length), unit: '' };
  return null;
}

function fmtBound(v: number, unit: string, integer?: boolean): string {
  if (integer) return Math.round(v).toLocaleString();
  const s = formatTick(v);
  return unit ? `${s} ${unit}` : s;
}

/** The hidden set after a click on `code`: toggled, or with Alt the code
 *  alone (again: everything back). Over the code's whole domain, so a code
 *  the legend does not list is hidden by a solo too. */
export function legendClick(hidden: number[], code: number, solo: boolean, domainMax: number): number[] {
  if (solo) {
    const soloed = hidden.length === domainMax && !hidden.includes(code);
    if (soloed) return [];
    const out: number[] = [];
    for (let c = 0; c <= domainMax; c++) if (c !== code) out.push(c);
    return out;
  }
  return hidden.includes(code) ? hidden.filter((c) => c !== code) : [...hidden, code].sort((a, b) => a - b);
}

export default function ColorLegend() {
  const { display, stats, filters, setFilters, tools, octree } = useOctreeShell();
  const stretch = useRampStretch();
  if (!display.showLegend) return null;
  const mode = display.colorMode;
  const shadeNote = (display.shade ?? 0) > 0 && mode !== 'intensity' ? 'shaded by intensity' : null;

  if (mode === 'flat') return null;

  if (mode === 'tree_id' || mode === 'standing_deadwood' || mode === 'laying_deadwood') {
    const active = mode === 'tree_id' ? tools.activeTreeId : null;
    return (
      <Frame title={mode === 'tree_id' ? 'Tree id — a colour each' : mode === 'standing_deadwood' ? 'Standing deadwood' : 'Laying deadwood'} note={shadeNote}>
        <div className="flex flex-col gap-0.5">
          {active !== null && active > 0 && (
            <Swatch color={display.activeTreeColor} label={`active tree #${active}`} />
          )}
          <Swatch color={display.unlabeledColor} label="unlabelled" />
        </div>
      </Frame>
    );
  }

  if (mode === 'classification' || mode === 'semantic') {
    const cls = mode === 'classification';
    const hidden = cls ? filters.hiddenClasses : filters.hiddenSemantic;
    const items = cls
      ? classOptionsFor(octree?.meta.classNames).map((o) => ({ code: o.code, label: o.label, color: o.swatch }))
      : SEMANTIC_OPTIONS.map((o) => ({ code: o.code, label: o.label, color: o.swatch ?? display.unlabeledColor }));
    const click = (code: number, solo: boolean) => {
      const next = legendClick(hidden, code, solo, cls ? CLASS_DOMAIN_MAX : SEMANTIC_DOMAIN_MAX);
      setFilters(cls ? { hiddenClasses: next } : { hiddenSemantic: next });
    };
    return (
      <Frame title={cls ? 'Classification' : 'Semantic'} note={shadeNote ?? 'click: hide · Alt-click: only this'} interactive>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cls ? 2 : 1}, auto)`, gap: '1px 10px' }}>
          {items.map((it) => {
            const off = hidden.includes(it.code);
            return (
              <button key={it.code} type="button" onClick={(e) => click(it.code, e.altKey)}
                title={off ? `Show ${it.label}` : `Hide ${it.label} (Alt-click: show only ${it.label})`}
                className="mono" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9.5, color: off ? 'var(--text-mute)' : 'var(--text)', background: 'none', border: 'none', padding: '1px 0', cursor: 'pointer', textDecoration: off ? 'line-through' : 'none' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: off ? 'transparent' : it.color, boxShadow: `0 0 0 1px ${off ? 'var(--text-mute)' : 'rgba(255,255,255,0.15)'}`, flexShrink: 0 }} />
                <span style={{ whiteSpace: 'nowrap' }}>{it.label}</span>
              </button>
            );
          })}
        </div>
      </Frame>
    );
  }

  // Trees by a measurement — a flag's colours, or a ramp below
  const tree = mode === 'tree_metric' ? treeMetricDef(display.treeMetric) : null;
  const notMeasured = (
    <div className="flex flex-col gap-0.5 mt-1">
      {tools.activeTreeId > 0 && <Swatch color={display.activeTreeColor} label={`active tree #${tools.activeTreeId}`} />}
      <Swatch color={`color-mix(in srgb, ${display.unlabeledColor} 70%, white)`} label="not measured" />
      <Swatch color={display.unlabeledColor} label="no tree" />
    </div>
  );
  if (tree && tree.kind === 'flag') {
    return (
      <Frame title={`Trees by ${tree.label}`} note={shadeNote}>
        <div className="flex flex-col gap-0.5">
          {FLAG_LABELS.map(([rank, label]) => (
            <Swatch key={rank} color={`rgb(${FLAG_RGB[rank].join(',')})`} label={label} />
          ))}
        </div>
        {notMeasured}
      </Frame>
    );
  }

  const meta = tree ? { title: `Trees by ${tree.label}`, unit: tree.unit } : scalarMeta(mode, stretch.hist?.key === 'heightAboveGround' || (mode === 'height' && display.heightColorAboveGround === true));
  if (!meta) return null;
  const { rampLo, rampHi } = stats;
  // Bounds are only known inside the viewer (streamed, per-dataset) and
  // surfaced via ViewerStats; if they're not ready yet — or genuinely
  // unavailable, see the rampLo/rampHi doc comment on ViewerStats — show
  // nothing rather than a made-up range.
  if (rampLo === null || rampHi === null || !Number.isFinite(rampLo) || !Number.isFinite(rampHi) || rampHi <= rampLo) {
    return null;
  }

  return (
    <Frame title={meta.title} note={shadeNote} interactive>
      <div style={{ width: BAR_WIDTH, height: BAR_HEIGHT, borderRadius: 3, background: rampToCss(display.ramp), boxShadow: '0 0 0 1px rgba(255,255,255,0.10)' }} />
      <div className="mono tnum" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: BAR_WIDTH, fontSize: 10, color: 'var(--text)', marginTop: 3, gap: 4 }}>
        <Bound value={rampLo} unit={meta.unit} integer={meta.integer} onCommit={(v) => v < rampHi && stretch.setRange({ lo: v, hi: rampHi })} />
        <Bound value={rampHi} unit={meta.unit} integer={meta.integer} onCommit={(v) => v > rampLo && stretch.setRange({ lo: rampLo, hi: v })} align="right" />
      </div>
      <div className="flex gap-2 mt-1">
        <LegendBtn onClick={stretch.auto} title="Stretch the ramp over the loaded points' values, the weakest and strongest 2 % cut">Auto</LegendBtn>
        {stretch.overridden && <LegendBtn onClick={() => stretch.setRange(null)} title="The cloud's own range">Reset</LegendBtn>}
      </div>
      {tree && notMeasured}
    </Frame>
  );
}

/** A bound that turns into an input when clicked. */
function Bound({ value, unit, integer, onCommit, align }: { value: number; unit: string; integer?: boolean; onCommit: (v: number) => void; align?: 'right' }) {
  const [edit, setEdit] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const editing = edit !== null;
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);
  if (edit !== null) {
    const done = () => {
      const v = Number(edit.replace(',', '.'));
      if (edit.trim() !== '' && Number.isFinite(v)) onCommit(v);
      setEdit(null);
    };
    return (
      <input ref={input} value={edit} onChange={(e) => setEdit(e.target.value)} onBlur={done}
        onKeyDown={(e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') setEdit(null); }}
        className="mono" style={{ width: 56, fontSize: 10, textAlign: align ?? 'left', background: 'rgba(0,0,0,0.5)', border: '1px solid var(--line)', color: 'var(--text)', padding: '0 2px' }} />
    );
  }
  return (
    <button type="button" onClick={() => setEdit(String(integer ? Math.round(value) : +value.toPrecision(7)))} title="Type the ramp's end"
      className="mono tnum" style={{ fontSize: 10, color: 'var(--text)', background: 'none', border: 'none', padding: 0, cursor: 'text', textAlign: align ?? 'left' }}>
      {fmtBound(value, unit, integer)}
    </button>
  );
}

function LegendBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button type="button" onClick={onClick} title={title} className="mono"
      style={{ fontSize: 9, color: 'var(--text-dim)', background: 'none', border: '1px solid var(--line)', borderRadius: 3, padding: '0 4px', cursor: 'pointer' }}>
      {children}
    </button>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9.5, color: 'var(--text)' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, boxShadow: '0 0 0 1px rgba(255,255,255,0.15)', flexShrink: 0 }} />
      <span style={{ whiteSpace: 'nowrap' }}>{label}</span>
    </div>
  );
}

function Frame({ title, note, interactive, children }: { title: string; note?: string | null; interactive?: boolean; children: React.ReactNode }) {
  return (
    <div
      className={`absolute select-none ${interactive ? '' : 'pointer-events-none'}`}
      style={{
        left: 14, bottom: 14, zIndex: 20,
        padding: '7px 9px',
        borderRadius: 8,
        background: 'rgba(0,0,0,0.35)',
        border: '1px solid var(--line)',
      }}
    >
      <div className="mono" style={{ fontSize: 9.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-mute)', marginBottom: 5 }}>
        {title}
      </div>
      {children}
      {note && <div className="mono" style={{ fontSize: 8.5, color: 'var(--text-mute)', marginTop: 4 }}>{note}</div>}
    </div>
  );
}
