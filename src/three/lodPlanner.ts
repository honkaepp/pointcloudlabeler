// The LOD planner's decisions, separated from the traversal that makes
// them.
//
// planAndStream walks the octree every re-plan (~12 Hz) and answers four
// questions per node: how big is it on screen, does it earn a place in
// the visible set, does it belong to the forced-detail region, and if
// memory is over budget which resident node dies. Every one of those has
// the same failure mode — get it wrong and NOTHING reports an error.
// The cloud just loads the wrong things first, or quietly never loads
// some of them, and the user reads that as "slow" or "that patch didn't
// come in". There is no exception, no red pixel, no log line.
//
// So the decisions live here where they can be run against known inputs,
// and the traversal — the THREE.js frustum, the record arrays, the
// promise plumbing — stays in OctreeView.
//
// THE HEAP AND NaN
// ----------------
// A binary heap is only a priority queue if its keys are totally
// ordered. NaN is not: every comparison against it is false, so it
// breaks BOTH sift directions in opposite ways. siftUp's
// `parent >= child` is false, so a NaN swaps upward all the way to the
// root; siftDown's `child > best` is also false, so nothing ever moves
// it back. It pins itself at the top and desorders everything under it.
//
// Measured on 20 nodes with one NaN weight among them:
//
//     clean:  100 95 90 85 80 75 70 65 60 55 50 45 40 35 30 25 20 15 10
//     w/ NaN:  95 100 90 85 75 70 65 60 80 55 50 45 40 35 30 NaN 25 …
//
// The 100-pixel node — the largest thing on screen, the one the user is
// looking at — pops SECOND. With MAX_NODES_LOADING = 10 and a point
// budget that cuts refinement off, a wrong order does not merely delay
// detail; the nodes past the cutoff never load at all.
//
// This is reachable, not theoretical. THREE's Frustum.intersectsSphere
// tests `distance < -radius`, which is false for NaN, so a node with a
// degenerate centre or radius is reported INSIDE the frustum (measured:
// true for both), and the diameter formula then yields NaN. A single
// corrupt bbox in an index therefore reorders the whole load queue.
//
// Two guards, at different levels. pixelDiameter reports a node it
// cannot measure as off-screen, which is the honest semantic answer.
// MaxHeap normalises a non-finite key to −Infinity, because a container
// that promises ordering must not accept a key it cannot order — and
// −Infinity rather than dropping the item, so a node is deprioritised
// rather than silently disappearing from the plan.

import { toSceneXYZ } from '../io/sceneAxes';
import { HORIZ_MAX_HALF_EXTENT, VERT_MAX_HALF_EXTENT, marginReach, type IsolateMargin, type Vec3, type Range } from './filterGeometry';

export interface HeapItem { rec: number; weight: number }

/** Max-heap over node weights, largest screen diameter first. */
export class MaxHeap {
  private items: HeapItem[] = [];

  get size(): number { return this.items.length; }
  isEmpty(): boolean { return this.items.length === 0; }

  /** An unorderable weight is stored as −Infinity. See THE HEAP AND NaN
   *  above: accepting NaN as a key does not misplace one node, it
   *  desorders the queue. −Infinity is orderable, sorts last, and still
   *  leaves the node in the plan for the root/forced paths that ignore
   *  the weight entirely.
   *
   *  Unorderable, not merely non-finite: ±Infinity compare correctly
   *  against everything and are left alone. What has to be caught is
   *  anything for which `a < b` and `a >= b` are BOTH false — NaN, and a
   *  non-number that slipped past the types. */
  push(item: HeapItem): void {
    const orderable = typeof item.weight === 'number' && !Number.isNaN(item.weight);
    this.items.push(orderable ? item : { rec: item.rec, weight: -Infinity });
    this.siftUp(this.items.length - 1);
  }

  pop(): HeapItem | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    const items = this.items;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (items[p].weight >= items[i].weight) break;
      const t = items[p]; items[p] = items[i]; items[i] = t;
      i = p;
    }
  }

  private siftDown(i: number): void {
    const items = this.items;
    const n = items.length;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let best = i;
      if (l < n && items[l].weight > items[best].weight) best = l;
      if (r < n && items[r].weight > items[best].weight) best = r;
      if (best === i) break;
      const t = items[best]; items[best] = items[i]; items[i] = t;
      i = best;
    }
  }
}

// ---------------------------------------------------------------- size

/** Nodes whose projected diameter is under this many pixels are not
 *  refined into. */
export const MIN_NODE_PIXEL_SIZE = 30;

/** Pixels per world unit at distance 1. Shared with the shader, which
 *  sizes points from the same number — a mismatch would make points and
 *  node-selection disagree about how big a metre is. */
export function projFactor(fovDeg: number, viewportHeight: number): number {
  // Math.max(1, NaN) is NaN, so the floor alone does not sanitise a
  // height that never got measured — a canvas queried before layout
  // reports one.
  const h = Number.isFinite(viewportHeight) ? Math.max(1, viewportHeight) : 1;
  const halfH = Math.tan((fovDeg * Math.PI) / 180 / 2);
  // A degenerate fov gives halfH = 0 and an infinite scale, which would
  // make every node the same (infinite) size and flatten the priority
  // order to insertion order.
  if (!(halfH > 1e-9) || !Number.isFinite(halfH)) return h / 2;
  return h / (2 * halfH);
}

/** A node's centre in scene coordinates.
 *
 *  Source axes are X east, Y north, Z up; the scene is Y-up with north
 *  negated (see io/sceneAxes). Dropping the negation mirrors the cloud,
 *  so the frustum test rejects the wrong half and nodes pop in and out
 *  as the camera orbits — which is what this looked like before the
 *  octree decoder was fixed. Third and fourth hand-written copies of
 *  this remap lived in the planner's two traversals. */
export function sourceCentreToScene(
  cx: number, cy: number, cz: number, offset: Vec3,
): [number, number, number] {
  return toSceneXYZ(cx - offset[0], cy - offset[1], cz - offset[2]);
}

/** Screen diameter in pixels of a bounding sphere at `dist`.
 *
 *  Returns NOT_VISIBLE for anything it cannot measure: a degenerate
 *  radius or distance would otherwise produce NaN, and NaN in the queue
 *  costs far more than one node (see THE HEAP AND NaN). */
export function pixelDiameter(radius: number, dist: number, proj: number): number {
  if (!Number.isFinite(radius) || !Number.isFinite(dist) || !Number.isFinite(proj)) {
    return NOT_VISIBLE;
  }
  // The floor keeps a node the camera sits exactly inside from dividing
  // by zero; such a node is enormous on screen and always refined.
  return (2 * radius * proj) / Math.max(dist, 0.001);
}

/** Sentinel for "this node is not on screen". Negative so it sorts below
 *  every real diameter and fails every `>= threshold` test. */
export const NOT_VISIBLE = -1;

// ----------------------------------------------------------- admission

/** Hysteresis for nodes that were visible in the PREVIOUS plan.
 *
 *  A node sitting right at the cutoff used to flip in and out of the
 *  visible set on consecutive re-plans as the camera moved or damping
 *  settled — each flip a fade-out plus a fade-in, which read as the
 *  cloud blinking in patches. The keep-band means a node must fall
 *  clearly below the threshold before it drops out. */
export const KEEP_PIXEL_FACTOR = 0.8;
export const KEEP_BUDGET_FACTOR = 1.15;

export interface AdmitInput {
  /** Level-0 tile root. Roots always render: each holds only a sparse
   *  sample of its tile, and guaranteeing them means the overview never
   *  vanishes when zoomed far out or when a close region has spent the
   *  whole budget. */
  isRoot: boolean;
  /** Inside the forced-detail region — an isolated tree being edited.
   *  Ignores both the pixel threshold and the budget so the whole tree
   *  is resident and editable at any zoom. */
  forced: boolean;
  /** In the previous plan's visible set. */
  wasVisible: boolean;
  /** Projected diameter in pixels, or NOT_VISIBLE. */
  weight: number;
  /** Points already admitted this plan. */
  plannedPoints: number;
  pointBudget: number;
}

/** Is this node big enough on screen to be worth refining into?
 *
 *  Written as `>=` rather than `< threshold ? skip`, so a weight that is
 *  not a number fails the test instead of passing it — every ordered
 *  comparison against NaN is false, and the negated form silently let it
 *  through. */
export function meetsPixelThreshold(weight: number, wasVisible: boolean): boolean {
  const minPx = wasVisible ? MIN_NODE_PIXEL_SIZE * KEEP_PIXEL_FACTOR : MIN_NODE_PIXEL_SIZE;
  return weight >= minPx;
}

/** Does this node earn a place in the visible set?
 *
 *  Two independent gates — size on screen, and room left in the budget —
 *  each relaxed for a node that was already visible. The child-descent
 *  test uses only the first: whether to LOOK at a child is a question
 *  about the camera, not about how much of the budget its siblings have
 *  spent. */
export function admits(a: AdmitInput): boolean {
  if (a.isRoot || a.forced) return true;
  if (!meetsPixelThreshold(a.weight, a.wasVisible)) return false;
  const cap = a.wasVisible ? a.pointBudget * KEEP_BUDGET_FACTOR : a.pointBudget;
  return a.plannedPoints < cap;
}

/** Should refinement continue past this node?
 *
 *  Once the budget is spent, stop refining detail — but the caller keeps
 *  draining the heap so remaining distant, low-weight roots still get
 *  shown. Forced nodes ignore the budget entirely. */
export function refines(plannedPoints: number, pointBudget: number, forced: boolean): boolean {
  return forced || plannedPoints < pointBudget;
}

/** Ceiling the admitted total can actually reach, for a given largest
 *  node.
 *
 *  The check is `plannedPoints < cap` BEFORE the node's own points are
 *  added, so the last admission overshoots by up to one node — and
 *  roots and forced nodes bypass the cap altogether. The comment in the
 *  planner used to claim the total "can't creep past ~1.15 × budget",
 *  which is the right order of magnitude and not the bound. This is the
 *  bound, so a caller sizing GPU memory has a real number. */
export function admittedCeiling(
  pointBudget: number, largestNodePoints: number, rootAndForcedPoints: number,
): number {
  return pointBudget * KEEP_BUDGET_FACTOR + largestNodePoints + rootAndForcedPoints;
}

// ------------------------------------------------------------ eviction

/** Memory ceiling before LRU eviction runs, as a multiple of the point
 *  budget. Above the budget because the resident set legitimately holds
 *  more than the visible set — evicting down to exactly the budget would
 *  discard nodes the next small camera move needs straight back. */
export const EVICT_LIMIT_FACTOR = 2;

export interface EvictCandidate {
  recIdx: number;
  /** Octree level. Level 0 (a tile root) is never evicted, so a zoom-out
   *  always shows the overview instantly. */
  level: number;
  numPoints: number;
  /** Plan number this node was last marked visible in. */
  lastUsedFrame: number;
}

/** Which resident nodes to evict, oldest-used first, to bring the point
 *  count back under `limit`.
 *
 *  `keep(rec)` covers both the current visible set and the forced-detail
 *  region. Forced nodes are excluded belt-and-braces: the planner marks
 *  them visible anyway, but an edit to the planner must not silently
 *  re-enable evicting the tree under the user's lasso — the points would
 *  vanish from a selection mid-edit with nothing to say they had ever
 *  been there.
 *
 *  Returns the nodes to dispose. Pure: the caller does the disposal and
 *  the map deletion, so this can be checked against known input. */
export function selectEvictions<T extends EvictCandidate>(
  nodes: Iterable<T>,
  keep: (rec: number) => boolean,
  loadedPoints: number,
  limit: number,
): T[] {
  if (!(loadedPoints > limit)) return [];
  const candidates: T[] = [];
  for (const n of nodes) {
    if (keep(n.recIdx)) continue;
    if (n.level === 0) continue;
    candidates.push(n);
  }
  // Ascending lastUsedFrame — least recently used first. Ties keep
  // insertion order, which is the map's, so the choice is deterministic
  // rather than depending on sort implementation.
  candidates.sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);

  const out: T[] = [];
  let remaining = loadedPoints;
  for (const n of candidates) {
    if (remaining <= limit) break;
    out.push(n);
    remaining -= n.numPoints;
  }
  return out;
}

/** The resident point count after releasing one node's points.
 *
 *  The `< 0` floor alone does not keep this counter honest, because
 *  `NaN < 0` is false: one node with an unreadable point count poisons
 *  it permanently, and a poisoned counter breaks eviction in whichever
 *  direction the comparison happens to fall — never evicting (memory
 *  grows until the tab dies) or evicting everything on every re-plan
 *  (the cloud clears and reloads on a still camera). Neither reports
 *  anything. Keeping the counter's last good value is the conservative
 *  choice: it over-counts, so eviction runs sooner than needed rather
 *  than never. */
export function releasePoints(current: number, numPoints: number): number {
  // The floor applies to the preserve branch too: a counter that is
  // already negative would never trip the evict comparison either.
  const held = Number.isFinite(current) && current > 0 ? current : 0;
  if (!Number.isFinite(numPoints)) return held;
  const next = held - numPoints;
  return next > 0 ? next : 0;
}

// -------------------------------------------------- forced-detail box

/** The forced-detail region for an isolated tree, in WORLD (source-CRS)
 *  axes: [minX, minY, minZ, maxX, maxY, maxZ].
 *
 *  This must be the same box filterGeometry's isolateBoxToScene derives,
 *  or the two disagree about which points belong to the isolated tree:
 *  the filter would reveal points the planner never guaranteed were
 *  loaded, and a lasso over them would miss data that "wasn't streamed
 *  in yet" — the exact trap the forced-detail region exists to close.
 *  It was a hand-copy, with the clamp constants written out as bare 8
 *  and 30 on this side; they are now the same constants.
 *
 *  Note the deliberate asymmetry: isolateBoxToScene ALSO applies the
 *  user's height band, and this does not. Loading more than is shown is
 *  the safe direction; showing more than was loaded is not. */
export function detailBoxWorld(
  box: readonly [Vec3, Vec3],
  anchor: Vec3 | null,
  margin: IsolateMargin,
): [number, number, number, number, number, number] {
  const [bmin, bmax] = box;
  const [west, east, south, north, down, up] = marginReach(margin);
  const cx = anchor ? anchor[0] : (bmin[0] + bmax[0]) * 0.5;
  const cy = anchor ? anchor[1] : (bmin[1] + bmax[1]) * 0.5;
  const cz = anchor ? anchor[2] : (bmin[2] + bmax[2]) * 0.5;
  const hx = Math.min((bmax[0] - bmin[0]) * 0.5, HORIZ_MAX_HALF_EXTENT);
  const hy = Math.min((bmax[1] - bmin[1]) * 0.5, HORIZ_MAX_HALF_EXTENT);
  const hz = Math.min((bmax[2] - bmin[2]) * 0.5, VERT_MAX_HALF_EXTENT);
  return [cx - hx - west, cy - hy - south, cz - hz - down, cx + hx + east, cy + hy + north, cz + hz + up];
}

/** Does a node's world-axis bbox overlap the forced-detail box?
 *
 *  `bbox` is the flat per-record array, 6 floats per node in source
 *  axes. Overlap, not containment: a node clipped by the box still holds
 *  points of the isolated tree. */
export function bboxOverlapsDetail(
  bbox: ArrayLike<number>, rec: number,
  detail: readonly [number, number, number, number, number, number],
): boolean {
  const o = rec * 6;
  return !(bbox[o + 3] < detail[0] || bbox[o] > detail[3]
        || bbox[o + 4] < detail[1] || bbox[o + 1] > detail[4]
        || bbox[o + 5] < detail[2] || bbox[o + 2] > detail[5]);
}

export type { Vec3, Range };
