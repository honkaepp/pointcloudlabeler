// Dual-thumb range slider — a dependency-free, pointer-driven min/max
// selector used by the Filters and Subset panels alongside their numeric
// fields. Two thumbs slide along a shared track; the filled segment shows
// the selected band. Built on raw pointer events (not stacked native
// <input type=range>) so dragging is reliable in WebView2 and the closer
// thumb is always grabbable. Values are in the caller's units (world
// metres, reflectance, …); the component only needs the bounds + step.

import { useRef } from 'react';

interface Props {
  /** Inclusive value bounds the thumbs move between. */
  min: number;
  max: number;
  /** Current [lo, hi] selection (clamped into bounds for display). */
  value: [number, number];
  /** Fires continuously while dragging with the new [lo, hi]. */
  onChange: (v: [number, number]) => void;
  /** Quantisation step in value units. Defaults to (max-min)/1000. */
  step?: number;
}

export default function DualRangeSlider({ min, max, value, onChange, step }: Props) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // Latest value in a ref so the pointermove handler (bound once per drag)
  // always reads the current opposite-thumb position, never a stale one.
  const valueRef = useRef(value);
  valueRef.current = value;

  const span = max - min;
  if (!(span > 0) || !Number.isFinite(span)) {
    // Degenerate bounds (flat axis / unknown range) — render an inert rail
    // so layout stays stable; the numeric fields still drive the filter.
    return <div style={{ height: 18 }} />;
  }
  const st = step && step > 0 ? step : span / 1000;
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const quantize = (v: number) => clamp(min + Math.round((v - min) / st) * st);

  const lo = clamp(value[0]);
  const hi = clamp(value[1]);
  const loPct = ((lo - min) / span) * 100;
  const hiPct = ((hi - min) / span) * 100;

  const valueAt = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return min;
    const r = track.getBoundingClientRect();
    const t = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return quantize(min + Math.max(0, Math.min(1, t)) * span);
  };

  const beginDrag = (which: 'lo' | 'hi', e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const onMove = (ev: PointerEvent) => {
      const v = valueAt(ev.clientX);
      const [clo, chi] = valueRef.current;
      if (which === 'lo') onChange([Math.min(v, chi), chi]);
      else onChange([clo, Math.max(v, clo)]);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Pointer-down on the rail (not a thumb) grabs whichever thumb is nearer
  // and starts dragging it from the click position.
  const onTrackDown = (e: React.PointerEvent) => {
    const v = valueAt(e.clientX);
    const which: 'lo' | 'hi' = Math.abs(v - lo) <= Math.abs(v - hi) ? 'lo' : 'hi';
    const [clo, chi] = valueRef.current;
    if (which === 'lo') onChange([Math.min(v, chi), chi]);
    else onChange([clo, Math.max(v, clo)]);
    beginDrag(which, e);
  };

  const thumb: React.CSSProperties = {
    position: 'absolute', top: '50%', width: 13, height: 13, borderRadius: '50%',
    background: 'var(--accent)', border: '2px solid #06140d',
    transform: 'translate(-50%, -50%)', cursor: 'grab', touchAction: 'none',
    boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
  };

  return (
    <div
      className="relative"
      style={{ height: 18, touchAction: 'none' }}
      onPointerDown={onTrackDown}
      ref={trackRef}
    >
      {/* Rail */}
      <div className="absolute left-0 right-0" style={{ top: '50%', height: 4, transform: 'translateY(-50%)', borderRadius: 2, background: 'rgba(255,255,255,0.12)' }} />
      {/* Selected band */}
      <div
        className="absolute"
        style={{ top: '50%', height: 4, transform: 'translateY(-50%)', borderRadius: 2, background: 'color-mix(in oklch, var(--accent) 70%, transparent)', left: `${loPct}%`, width: `${Math.max(0, hiPct - loPct)}%` }}
      />
      {/* Thumbs — the lo thumb sits above hi at equal positions so it stays grabbable at the extremes. */}
      <div
        role="slider" aria-valuenow={lo} aria-valuemin={min} aria-valuemax={max}
        style={{ ...thumb, left: `${loPct}%`, zIndex: 2 }}
        onPointerDown={(e) => beginDrag('lo', e)}
      />
      <div
        role="slider" aria-valuenow={hi} aria-valuemin={min} aria-valuemax={max}
        style={{ ...thumb, left: `${hiPct}%`, zIndex: 1 }}
        onPointerDown={(e) => beginDrag('hi', e)}
      />
    </div>
  );
}
