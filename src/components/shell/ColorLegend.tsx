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

import { rampColor } from '../../three/palette';
import { formatTick } from '../chart/ticks';
import { useOctreeShell, type ColorMode, type ColorRamp } from './OctreeShellContext';
import { CLASS_OPTIONS, SEMANTIC_OPTIONS } from './FiltersPanel';

const GRADIENT_STOPS = 24;
const BAR_WIDTH = 104;
const BAR_HEIGHT = 8;

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
function scalarMeta(mode: ColorMode): { title: string; unit: string; integer?: boolean } | null {
  if (mode === 'height') return { title: 'Height', unit: 'm' };
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

export default function ColorLegend() {
  const { display, stats } = useOctreeShell();
  if (!display.showLegend) return null;
  const mode = display.colorMode;

  // Hash colours (tree_id, the two deadwood channels) and the flat tint
  // carry no readable scale — hide rather than show something meaningless.
  if (mode === 'tree_id' || mode === 'standing_deadwood' || mode === 'laying_deadwood' || mode === 'flat') {
    return null;
  }

  if (mode === 'classification') {
    return (
      <Frame title="Classification">
        <SwatchGrid cols={2} items={CLASS_OPTIONS.map(o => ({ code: o.code, label: o.label, color: o.swatch }))} />
      </Frame>
    );
  }
  if (mode === 'semantic') {
    return (
      <Frame title="Semantic">
        <SwatchGrid cols={1} items={SEMANTIC_OPTIONS.map(o => ({ code: o.code, label: o.label, color: o.swatch ?? display.unlabeledColor }))} />
      </Frame>
    );
  }

  const meta = scalarMeta(mode);
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
    <Frame title={meta.title}>
      <div style={{ width: BAR_WIDTH, height: BAR_HEIGHT, borderRadius: 3, background: rampToCss(display.ramp), boxShadow: '0 0 0 1px rgba(255,255,255,0.10)' }} />
      <div className="mono tnum" style={{ display: 'flex', justifyContent: 'space-between', width: BAR_WIDTH, fontSize: 10, color: 'var(--text)', marginTop: 3 }}>
        <span>{fmtBound(rampLo, meta.unit, meta.integer)}</span>
        <span>{fmtBound(rampHi, meta.unit, meta.integer)}</span>
      </div>
    </Frame>
  );
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      className="absolute pointer-events-none select-none"
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
    </div>
  );
}

function SwatchGrid({ items, cols }: { items: { code: number; label: string; color: string }[]; cols: 1 | 2 }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, auto)`, gap: '2px 10px' }}>
      {items.map(it => (
        <div key={it.code} className="mono" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9.5, color: 'var(--text)' }}>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: it.color, boxShadow: '0 0 0 1px rgba(255,255,255,0.15)', flexShrink: 0 }} />
          <span style={{ whiteSpace: 'nowrap' }}>{it.label}</span>
        </div>
      ))}
    </div>
  );
}
