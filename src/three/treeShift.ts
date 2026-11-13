// Tree Review's "pull apart": neighbouring trees drawn aside.
//
// Two crowns whose branches interleave are hard to correct where they meet:
// the wrong-id branch of one tree sits inside the other's crown, and the
// colours alone do not say which side a twig belongs to. Drawing a
// neighbour a couple of metres to the side splits the knot open — its own
// branches go with it, the active tree's branches that wrongly carry its id
// go with it too and stand out as a gap in one crown and a stray limb in
// the other — and every editing tool keeps working on the moved picture.
//
// The move is a DISPLAY, never an edit. A point is drawn at its stored
// position plus the offset of the tree it carries the id of (the point
// vertex shader's treeShift, through the slot each point of a moved tree
// carries — shiftSlots below — and drawnPosition for the CPU picks and
// selections), so a lasso drawn around the moved crown takes exactly the
// points seen there. Filters, picks, measurements, saving
// and every export read the stored coordinates, which nothing here touches.
// Because the offset follows the CURRENT id, a branch given back to the
// active tree jumps home the moment its id changes.
//
// The shift lives in a small module store the Tree Review panel writes and
// the viewer reads. It belongs to one dataset and to one isolated tree: the
// viewer draws it only while that very tree is isolated in that dataset, so
// another module, the second window and any other view are never moved.

import type { PickPlane, ViewRay } from './planePick';

type V3 = [number, number, number];

/** A tree's view offset: metres east and north (horizontal only). */
export type ShiftEN = readonly [number, number];

export interface TreeShift {
  /** The dataset folder the shift was made in. */
  dir: string;
  /** The isolated tree it was made around. */
  anchor: number;
  /** Offsets by tree id (ids ≤ 0, the unassigned, never move). */
  offsets: ReadonlyMap<number, ShiftEN>;
}

// ---- the store ------------------------------------------------------

let current: TreeShift | null = null;
const listeners = new Set<() => void>();

export function getTreeShift(): TreeShift | null { return current; }

/** Replace the shift (null: nothing moved). Listeners hear every change. */
export function setTreeShift(next: TreeShift | null): void {
  const v = next && next.offsets.size > 0 ? next : null;
  if (v === current) return;
  current = v;
  for (const fn of listeners) fn();
}

export function subscribeTreeShift(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ---- what the viewer draws ------------------------------------------

/** Texels a row of the offset texture (slotTexel). */
export const SHIFT_TEX_WIDTH = 4096;

export interface ShiftView {
  /** Scene offset by tree id (scene x = east, z = −north). */
  lookup: ReadonlyMap<number, V3>;
  /** The longest offset, metres: how far a drawn point can be from its
   *  stored place, which the planner and the selection's box tests widen
   *  their bounds by. */
  reach: number;
}

/** The offset to draw in a view of `dir` whose isolated tree is
 *  `isolateTreeId` — null unless the shift was made for that dataset and
 *  that tree, and moves something. */
export function shiftForView(s: TreeShift | null, dir: string, isolateTreeId: number | null): ShiftView | null {
  if (!s || s.dir !== dir || isolateTreeId === null || isolateTreeId !== s.anchor) return null;
  const lookup = new Map<number, V3>();
  let reach = 0;
  for (const [id, [e, n]] of s.offsets) {
    if (!(id > 0) || !Number.isFinite(e) || !Number.isFinite(n) || (e === 0 && n === 0)) continue;
    lookup.set(id, [e, 0, -n]);
    reach = Math.max(reach, Math.hypot(e, n));
  }
  if (lookup.size === 0) return null;
  return { lookup, reach };
}

/** What the point shader reads: each moved tree's SLOT (1, 2, … in id
 *  order; 0 = not moved), which the viewer writes per point (aShift), and
 *  the offsets as RGBA float texels, the slot's at slotTexel(slot) —
 *  slot 0 is a zero texel. `key` names the moved ids: while it holds, a
 *  drag only rewrites the texels and no point's slot changes. */
export interface ShiftSlots {
  key: string;
  slotOf: Map<number, number>;
  data: Float32Array<ArrayBuffer>;
  width: number;
  height: number;
}

export function shiftSlots(lookup: ReadonlyMap<number, V3>): ShiftSlots {
  const ids = [...lookup.keys()].filter((id) => id > 0 && Number.isInteger(id)).sort((a, b) => a - b);
  const n = ids.length + 1;
  const width = Math.min(SHIFT_TEX_WIDTH, n);
  const height = Math.ceil(n / SHIFT_TEX_WIDTH);
  const data = new Float32Array(width * height * 4);
  const slotOf = new Map<number, number>();
  ids.forEach((id, k) => {
    const slot = k + 1;
    slotOf.set(id, slot);
    const [x, y] = slotTexel(slot, width);
    const o = lookup.get(id)!;
    const t = (y * width + x) * 4;
    data[t] = o[0]; data[t + 1] = o[1]; data[t + 2] = o[2];
  });
  return { key: ids.join(','), slotOf, data, width, height };
}

/** The texel (column, row) of a slot in a `width`-wide texture: the
 *  vertex shader's vec2(mod(slot, width), floor(slot / width)). */
export function slotTexel(slot: number, width: number): [number, number] {
  return [slot % width, Math.floor(slot / width)];
}

/** Where a point is DRAWN, scene coordinates, into `out`: its stored
 *  position with the drawn height (`drawnY`, the terrain off while heights
 *  are shown above ground) and its tree's offset. The CPU twin of the
 *  vertex shader's drawn position, for every pick and selection that
 *  projects points. */
export function drawnPosition(
  out: Float64Array, px: number, py: number, pz: number, id: number,
  dy: number, lookup: ReadonlyMap<number, V3> | null,
): Float64Array {
  out[0] = px; out[1] = dy; out[2] = pz;
  if (lookup !== null && id > 0) {
    const o = lookup.get(id);
    if (o !== undefined) { out[0] += o[0]; out[1] += o[1]; out[2] += o[2]; }
  }
  return out;
}

// ---- what the panel sets ----------------------------------------------

/** `distance` metres straight away from the active tree's centre
 *  (`from`, east/north) through the neighbour's (`to`); due east when the
 *  two centres coincide. */
export function shiftAway(from: readonly [number, number], to: readonly [number, number], distance: number): ShiftEN {
  let dx = to[0] - from[0];
  let dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-6)) { dx = 1; dy = 0; } else { dx /= len; dy /= len; }
  return [dx * distance, dy * distance];
}

/** `distance` metres towards a compass bearing (0 north, 90 east). */
export function shiftBearing(bearingDeg: number, distance: number): ShiftEN {
  const a = (bearingDeg * Math.PI) / 180;
  return [round6(Math.sin(a) * distance), round6(Math.cos(a) * distance)];
}

function round6(v: number): number { return Math.round(v * 1e6) / 1e6 || 0; }

/** A ray steeper than this (sine of its angle below the horizon) drags
 *  on a level plane — a view from above; flatter, on an upright plane
 *  facing the camera — a view from the side, where a level plane is seen
 *  edge-on and the slightest hand movement would throw the tree metres. */
export const DRAG_LEVEL_SINE = 0.7;

/** The plane a drag in the view moves trees on, through `at` (world
 *  coordinates; survey axes, z up): level when the view looks down, else
 *  upright and square to the view's horizontal direction. */
export function dragPlane(ray: ViewRay, at: readonly [number, number, number]): PickPlane {
  const d: V3 = [ray.b[0] - ray.a[0], ray.b[1] - ray.a[1], ray.b[2] - ray.a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const anchor: V3 = [at[0], at[1], at[2]];
  const flat = Math.hypot(d[0], d[1]);
  if (!(len > 0) || Math.abs(d[2]) / len > DRAG_LEVEL_SINE || !(flat > 1e-9)) {
    return { anchor, normal: [0, 0, 1] };
  }
  return { anchor, normal: [d[0] / flat, d[1] / flat, 0] };
}

/** The horizontal move from `start` to `now` on the drag plane. */
export function dragDelta(start: readonly [number, number, number], now: readonly [number, number, number]): ShiftEN {
  return [now[0] - start[0], now[1] - start[1]];
}

/** Every offset of `base` moved by `delta`, for the ids in `ids`. */
export function moveBy(base: ReadonlyMap<number, ShiftEN>, ids: Iterable<number>, delta: ShiftEN): Map<number, ShiftEN> {
  const out = new Map(base);
  for (const id of ids) {
    const o = base.get(id) ?? [0, 0];
    out.set(id, [o[0] + delta[0], o[1] + delta[1]]);
  }
  return out;
}
