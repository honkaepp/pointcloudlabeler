// Which stretched range (DisplayConfig.rampRanges) a colour mode reads: the
// built-in ramps over elevation or height above ground, intensity, and the
// eastings / northings. Other modes have no stretch here (an extra column
// keeps its own, extraRangeOverrides).
//
// A stretch is kept in the units the legend shows — elevations, eastings
// and northings in world coordinates, height above ground in metres, raw
// intensity — while the CPU colouring reads positions relative to the
// dataset offset. stretchSpans converts a set range into the colouring's
// units, legendSpan the colouring's span back into the legend's, so the
// legend always states exactly the span the colours run over.

import type { ColorMode } from '../components/shell/OctreeShellContext';

export type RampRangeKey = 'height' | 'heightAboveGround' | 'intensity' | 'x' | 'y';

type V3 = readonly [number, number, number];

export interface Span { lo: number; hi: number }

/** The stretches the user set, by ramp (DisplayConfig.rampRanges). */
export type RampRanges = Partial<Record<RampRangeKey, Span>>;

/** The spans the built-in ramps run over, in the units the colouring
 *  reads: height in scene y (elevation − offset, or height above ground),
 *  x as easting − offset, y as northing − offset (the ramp runs south to
 *  north), and raw intensity (null: the cloud recorded no range, and the
 *  colouring normalises each node over its own). */
export interface RampSpans<H extends Span = Span> {
  height: H;
  x: Span;
  y: Span;
  intensity: Span | null;
}

export function rampRangeKey(mode: ColorMode, heightAboveGround: boolean): RampRangeKey | null {
  if (mode === 'height') return heightAboveGround ? 'heightAboveGround' : 'height';
  if (mode === 'intensity' || mode === 'x' || mode === 'y') return mode;
  return null;
}

/** What the legend's units are ahead of the colouring's for a ramp: the
 *  dataset offset for elevations, eastings and northings, nothing for
 *  height above ground and intensity. */
export function legendShift(key: RampRangeKey, offset: V3): number {
  if (key === 'height') return offset[2];
  if (key === 'x') return offset[0];
  if (key === 'y') return offset[1];
  return 0;
}

/** A set range that can be ramped over (finite, and not empty). */
export function usableRange(r: Span | null | undefined): r is Span {
  return !!r && Number.isFinite(r.lo) && Number.isFinite(r.hi) && r.hi > r.lo;
}

/** The spans the ramps run over: the cloud's own (`own`), each replaced by
 *  the stretch the user set for it, converted from the legend's units to
 *  the colouring's. Anything else on a span (the height's terrain shift)
 *  is kept. A nonsense range is ignored. */
export function stretchSpans<H extends Span>(
  own: RampSpans<H>, ranges: RampRanges | undefined | null, offset: V3, heightAboveGround: boolean,
): RampSpans<H> {
  if (!ranges) return own;
  const at = <S extends Span>(key: RampRangeKey, span: S): S => {
    const r = ranges[key];
    if (!usableRange(r)) return span;
    const d = legendShift(key, offset);
    return { ...span, lo: r.lo - d, hi: r.hi - d };
  };
  const i = ranges.intensity;
  return {
    height: at(heightAboveGround ? 'heightAboveGround' : 'height', own.height),
    x: at('x', own.x),
    y: at('y', own.y),
    // a set range applies even where the cloud recorded none
    intensity: usableRange(i) ? { lo: i.lo, hi: i.hi } : own.intensity,
  };
}

/** What the legend shows for `mode`: the span its colours run over, in the
 *  legend's units. Null for a mode without a built-in ramp, and for
 *  intensity with no single span (each node ramped over its own). */
export function legendSpan(
  mode: ColorMode, spans: RampSpans, offset: V3, heightAboveGround: boolean,
): Span | null {
  const key = rampRangeKey(mode, heightAboveGround);
  if (!key) return null;
  const s = key === 'height' || key === 'heightAboveGround' ? spans.height
    : key === 'intensity' ? spans.intensity
    : spans[key];
  if (!s) return null;
  const d = legendShift(key, offset);
  return { lo: s.lo + d, hi: s.hi + d };
}
