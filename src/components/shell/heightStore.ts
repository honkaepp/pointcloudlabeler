// The Height tool: two points clicked in the cloud (a tree's
// root and its top, say), the distance between them and a height scale
// standing on the lower one, ticked every few metres, with rings around
// the scale as helper lines at each tick. The panel (HeightPanel.tsx)
// picks the points, the viewer (three/HeightOverlay.tsx) draws what
// `heightOverlay` gives it. Points are in world coordinates, as the
// viewport's picker hands them.

import { useSyncExternalStore } from 'react';
import { csvField, csvNum } from '../../io/csv';

export type Vec3 = [number, number, number];

export interface HeightReading {
  /** The lower and the higher of the two points: the scale stands on `low`. */
  low: Vec3;
  high: Vec3;
  /** Height difference (m). */
  height: number;
  /** Straight-line distance (m). */
  distance: number;
  /** Horizontal distance (m). */
  horizontal: number;
  /** Angle of the line from the horizontal (deg); 90 = straight up. */
  slopeDeg: number;
}

/** The reading of two points, in either order. */
export function heightReading(a: Vec3, b: Vec3): HeightReading {
  const [low, high] = a[2] <= b[2] ? [a, b] : [b, a];
  const height = high[2] - low[2];
  const horizontal = Math.hypot(high[0] - low[0], high[1] - low[1]);
  const distance = Math.hypot(horizontal, height);
  const slopeDeg = distance > 0 ? (Math.atan2(height, horizontal) * 180) / Math.PI : 0;
  return { low, high, height, distance, horizontal, slopeDeg };
}

/** Steps the scale can be ticked at (m). */
export const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100] as const;
/** Auto step: the finest giving at most this many intervals. */
const MAX_INTERVALS = 8;

/** The step for a height: `chosen` when it is set (> 0), else the finest of
 *  `STEPS` that cuts the height into at most eight intervals — 27 m gets
 *  5 m, 12 m gets 2 m, 3 m gets 0.5 m. */
export function scaleStep(height: number, chosen = 0): number {
  if (chosen > 0) return chosen;
  for (const s of STEPS) if (Math.ceil(height / s - 1e-9) <= MAX_INTERVALS) return s;
  return STEPS[STEPS.length - 1];
}

/** Where the ticks of a scale go (m above its foot): 0, step, … up to the
 *  first one at or over the height, so a 27.4 m tree reads on 0–30 m.
 *  A height of nothing has the foot only. */
export function scaleTicks(height: number, step: number): number[] {
  if (!(step > 0) || !(height > 0)) return [0];
  const n = Math.min(1000, Math.ceil(height / step - 1e-9));
  return Array.from({ length: n + 1 }, (_, k) => round(k * step));
}

const round = (v: number) => Math.round(v * 1e6) / 1e6;

/** Auto ring radius: a twentieth of the scale, kept between 0.3 and 3 m. */
export function ringRadius(scaleTop: number, chosen = 0): number {
  if (chosen > 0) return chosen;
  return Math.min(3, Math.max(0.3, scaleTop / 20));
}

/** A tick's label: whole metres without decimals, else as fine as the step. */
export function tickLabel(v: number, step: number): string {
  const dp = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return `${v.toFixed(dp)} m`;
}

export interface KeptHeight extends HeightReading { id: number; note: string }

export type PickEnd = 'a' | 'b';

export interface HeightState {
  /** The dataset the points belong to: another one open starts afresh. */
  dir: string | null;
  /** The panel is open: the viewer draws the scale only then. */
  open: boolean;
  a: Vec3 | null;
  b: Vec3 | null;
  /** The end the next click in the viewport sets. */
  picking: PickEnd | null;
  /** Tick step (m); 0 = auto (`scaleStep`). */
  step: number;
  /** Rings around the scale at each tick. */
  rings: boolean;
  /** Ring radius (m); 0 = auto (`ringRadius`). */
  radius: number;
  /** Labels on the ticks. */
  labels: boolean;
  kept: KeptHeight[];
}

export function initialHeightState(): HeightState {
  return { dir: null, open: false, a: null, b: null, picking: null, step: 0, rings: true, radius: 0, labels: true, kept: [] };
}

let state: HeightState = initialHeightState();
const listeners = new Set<() => void>();

export function getHeightState(): HeightState {
  return state;
}

export function setHeightState(patch: Partial<HeightState> | ((s: HeightState) => Partial<HeightState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function resetHeightStore(): void {
  state = initialHeightState();
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useHeightStore(): HeightState {
  return useSyncExternalStore(subscribe, getHeightState, getHeightState);
}

/** A click in the viewport while picking: sets that end, then asks for the
 *  other one while it is missing, else stops. */
export function placePoint(p: Vec3): void {
  setHeightState((s) => {
    if (!s.picking) return {};
    const next = s.picking === 'a' ? { a: p } : { b: p };
    const a = next.a ?? s.a, b = next.b ?? s.b;
    const picking: PickEnd | null = !a ? 'a' : !b ? 'b' : null;
    return { ...next, picking };
  });
}

/** Start over: both ends are clicked again, the first one now. */
export function pickBoth(): void {
  setHeightState({ a: null, b: null, picking: 'a' });
}

/** The current reading into the kept list (newest first). */
export function keepReading(note = ''): void {
  setHeightState((s) => {
    if (!s.a || !s.b) return {};
    return { kept: [{ ...heightReading(s.a, s.b), id: Date.now() + s.kept.length, note }, ...s.kept] };
  });
}

/** Another dataset open: the points and the kept readings go (the settings stay). */
export function heightDataset(dir: string | null): void {
  if (state.dir === dir) return;
  setHeightState({ dir, a: null, b: null, picking: null, kept: [] });
}

/** The kept readings as CSV rows (header first), oldest first. */
export function heightCsv(kept: KeptHeight[]): string[] {
  const rows = ['idx,height_m,distance_3d_m,horizontal_m,slope_deg,base_x,base_y,base_z,top_x,top_y,top_z,note'];
  [...kept].reverse().forEach((k, i) => {
    rows.push([
      i + 1, csvNum(k.height, 3), csvNum(k.distance, 3), csvNum(k.horizontal, 3), csvNum(k.slopeDeg, 1),
      ...[...k.low, ...k.high].map((v) => csvNum(v, 3)), csvField(k.note),
    ].join(','));
  });
  return rows;
}

// ---------------------------------------------------------------------------
// what the viewer draws

export interface HeightSegment { a: Vec3; b: Vec3; color: string }
/** Labels sit on the scale's axis: the viewer moves them `labelOffset`
 *  metres out, the lines' labels to the right on the screen and the height
 *  (`strong`) to the left, whichever side the scale is seen from. */
export interface HeightLabel { p: Vec3; text: string; color: string; strong?: boolean; /** A second, smaller line. */ sub?: string }
export interface HeightOverlayData {
  segments: HeightSegment[];
  dots: Array<{ p: Vec3; color: string }>;
  labels: HeightLabel[];
  /** How far from the axis the labels go (m): outside the rings, or the ticks. */
  labelOffset: number;
}

export const HEIGHT_COLORS = {
  scale: '#f2f2f2',
  tick: '#9fd3ff',
  minor: '#6c8aa3',
  line: '#ffd24a',
  top: '#ff9f43',
  point: '#ffd24a',
} as const;

const RING_SEGMENTS = 48;

/** The scale, its ticks and rings, the line between the points and the
 *  marker of the higher one on the scale, with their labels. One point
 *  only: its dot. */
export function heightOverlay(s: Pick<HeightState, 'a' | 'b' | 'step' | 'rings' | 'radius' | 'labels'>): HeightOverlayData {
  const segments: HeightSegment[] = [];
  const dots: HeightOverlayData['dots'] = [];
  const labels: HeightLabel[] = [];
  for (const p of [s.a, s.b]) if (p) dots.push({ p, color: HEIGHT_COLORS.point });
  if (!s.a || !s.b) return { segments, dots, labels, labelOffset: 0 };
  const r = heightReading(s.a, s.b);
  const step = scaleStep(r.height, s.step);
  const ticks = scaleTicks(r.height, step);
  const top = ticks[ticks.length - 1];
  const [x, y, z0] = r.low;
  const radius = ringRadius(top, s.radius);
  // the scale itself
  segments.push({ a: [x, y, z0], b: [x, y, z0 + top], color: HEIGHT_COLORS.scale });
  // ticks: a cross at each, a ring around the scale when asked
  const tick = radius * 0.35;
  for (const t of ticks) {
    const z = z0 + t;
    segments.push({ a: [x - tick, y, z], b: [x + tick, y, z], color: HEIGHT_COLORS.tick });
    segments.push({ a: [x, y - tick, z], b: [x, y + tick, z], color: HEIGHT_COLORS.tick });
    if (s.rings && t > 0) ring(segments, x, y, z, radius, HEIGHT_COLORS.tick);
    if (s.labels) labels.push({ p: [x, y, z], text: tickLabel(t, step), color: HEIGHT_COLORS.tick });
  }
  // minor ticks: five to a step
  const minor = step / 5;
  for (let k = 1; k * minor < top - 1e-9; k++) {
    if (k % 5 === 0) continue;
    const z = z0 + k * minor;
    segments.push({ a: [x - tick / 3, y, z], b: [x + tick / 3, y, z], color: HEIGHT_COLORS.minor });
  }
  // the line between the points, and the higher one carried onto the scale
  segments.push({ a: r.low, b: r.high, color: HEIGHT_COLORS.line });
  const zt = r.high[2];
  if (r.horizontal > 1e-6) segments.push({ a: r.high, b: [x, y, zt], color: HEIGHT_COLORS.top });
  if (s.rings) ring(segments, x, y, zt, radius * 0.6, HEIGHT_COLORS.top);
  // the height at the top of the scale, the distances under it (a label
  // halfway up the line would sit on the scale's own)
  const sub = r.horizontal > 0.05 ? `↗ ${r.distance.toFixed(2)} m · ↔ ${r.horizontal.toFixed(2)} m` : undefined;
  labels.push({ p: [x, y, zt], text: `${r.height.toFixed(2)} m`, color: HEIGHT_COLORS.top, strong: true, sub });
  return { segments, dots, labels, labelOffset: s.rings ? radius * 1.1 : tick * 1.3 };
}

function ring(out: HeightSegment[], x: number, y: number, z: number, radius: number, color: string): void {
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const a0 = (i / RING_SEGMENTS) * Math.PI * 2, a1 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2;
    out.push({ a: [x + radius * Math.cos(a0), y + radius * Math.sin(a0), z], b: [x + radius * Math.cos(a1), y + radius * Math.sin(a1), z], color });
  }
}
