// The geometry Tree Review's isolate mode is built on, kept out of the
// panel so it can be tested against known coordinates.
//
// Both functions here answer the same question from two directions: the
// first says which box the viewer clips the isolated tree's surroundings
// to, the second says which OTHER trees reach into that box. They have
// to agree — a neighbour the panel lists but the viewer never draws
// reads as a broken control, and one the viewer draws but the panel does
// not list cannot be turned off.

import { HORIZ_MAX_HALF_EXTENT, marginReach, type IsolateMargin } from '../../three/filterGeometry';
import type { TreeSummaryEntry } from '../../persistence/octreeReader';

export interface IsolateGeom {
  box: [[number, number, number], [number, number, number]];
  anchor: [number, number, number] | null;
}

/** The isolate neighbourhood for one tree, from the scan's density
 *  statistics instead of the raw bbox:
 *
 *  - HORIZONTAL half-extent per axis = max(2.5σ, 1.5 m), capped by the
 *    bbox half. ±2.5σ around the centroid covers essentially the whole
 *    real crown while excluding far strays — the raw bbox half (what
 *    the box used before) is exactly what strays inflate, which made
 *    the "nearby unassigned" reveal a 20 m hall the tree sat in the
 *    corner of. The 1.5 m floor keeps sparse saplings workable.
 *  - VERTICAL span = the full bbox Z range, anchored at its middle —
 *    NOT the centroid Z, which is crown-biased on TLS stems and would
 *    cut the stump out of the box.
 *
 *  Degrades gracefully on a scan cached by an older build (no
 *  centroid/σ at runtime): falls back to the raw bbox + null anchor,
 *  i.e. the previous behaviour. */
export function isolateGeomFor(t: TreeSummaryEntry): IsolateGeom {
  if (!t.centroid || !t.sigma) {
    return { box: [t.bboxMin, t.bboxMax], anchor: null };
  }
  const bhx = (t.bboxMax[0] - t.bboxMin[0]) * 0.5;
  const bhy = (t.bboxMax[1] - t.bboxMin[1]) * 0.5;
  const hx = Math.min(Math.max(2.5 * t.sigma[0], 1.5), Math.max(bhx, 1.5));
  const hy = Math.min(Math.max(2.5 * t.sigma[1], 1.5), Math.max(bhy, 1.5));
  const ax = t.centroid[0];
  const ay = t.centroid[1];
  const zMid = (t.bboxMin[2] + t.bboxMax[2]) * 0.5;
  return {
    box: [
      [ax - hx, ay - hy, t.bboxMin[2]],
      [ax + hx, ay + hy, t.bboxMax[2]],
    ],
    anchor: [ax, ay, zMid],
  };
}

/** How far (m, horizontal) the tree's points reach beyond its isolate
 *  box; 0 when the box holds them all. The box is built from the density
 *  centre and σ, so a tree whose id also covers a cluster 50 m away has a
 *  bbox far wider than its box — and that is the number to show, because
 *  TreeQSM will fit to that cluster as part of the tree. */
export function farExtent(t: TreeSummaryEntry, g: IsolateGeom): number {
  let d = 0;
  for (const a of [0, 1] as const) {
    d = Math.max(d, g.box[0][a] - t.bboxMin[a], t.bboxMax[a] - g.box[1][a]);
  }
  return Math.max(0, d);
}

export interface Neighbour {
  id: number;
  /** Horizontal distance between the two trees' centres (m). */
  dist: number;
  count: number;
}

/** The trees whose own core footprint overlaps the isolate
 *  neighbourhood of `selectedId` — i.e. exactly the trees "Show other
 *  trees nearby" can put on screen — nearest first.
 *
 *  It reproduces the viewer's box arithmetic rather than approximating
 *  it (same anchor, same HORIZ_MAX_HALF_EXTENT clamp, same margin), so a
 *  tree this offers is a tree that actually appears when you pick it.
 *
 *  Only the horizontal footprint is tested. The vertical is deliberately
 *  ignored: the height band is a live control the user drags, and a
 *  neighbour list that emptied itself as the band narrowed would take
 *  away the picks at the moment they are being used. */
export function neighboursOf(
  trees: readonly TreeSummaryEntry[] | null,
  selectedId: number | null,
  margin: IsolateMargin,
): Neighbour[] {
  const out: Neighbour[] = [];
  if (!trees || selectedId == null || selectedId <= 0) return out;
  const self = trees.find(t => t.treeId === selectedId);
  if (!self) return out;

  const g = isolateGeomFor(self);
  // The four horizontal reaches, each its own; the vertical two are
  // the band's business.
  const [west, east, south, north] = marginReach(margin);
  const ax = g.anchor ? g.anchor[0] : (g.box[0][0] + g.box[1][0]) * 0.5;
  const ay = g.anchor ? g.anchor[1] : (g.box[0][1] + g.box[1][1]) * 0.5;
  const hx = Math.min((g.box[1][0] - g.box[0][0]) * 0.5, HORIZ_MAX_HALF_EXTENT);
  const hy = Math.min((g.box[1][1] - g.box[0][1]) * 0.5, HORIZ_MAX_HALF_EXTENT);
  const x0 = ax - hx - west, x1 = ax + hx + east;
  const y0 = ay - hy - south, y1 = ay + hy + north;

  for (const t of trees) {
    if (t.treeId <= 0 || t.treeId === selectedId) continue;
    // The neighbour's own extent: its σ-core where the scan carries one
    // (stray-proof), its raw bbox on an older cached scan.
    const tx0 = t.sigma ? t.centroid[0] - 2.5 * t.sigma[0] : t.bboxMin[0];
    const tx1 = t.sigma ? t.centroid[0] + 2.5 * t.sigma[0] : t.bboxMax[0];
    const ty0 = t.sigma ? t.centroid[1] - 2.5 * t.sigma[1] : t.bboxMin[1];
    const ty1 = t.sigma ? t.centroid[1] + 2.5 * t.sigma[1] : t.bboxMax[1];
    if (tx1 < x0 || tx0 > x1 || ty1 < y0 || ty0 > y1) continue;
    const cx = t.centroid ? t.centroid[0] : (t.bboxMin[0] + t.bboxMax[0]) * 0.5;
    const cy = t.centroid ? t.centroid[1] : (t.bboxMin[1] + t.bboxMax[1]) * 0.5;
    const dist = Math.hypot(cx - ax, cy - ay);
    // A tree with a degenerate bbox has no orderable distance, and
    // sorting on NaN would scatter it through the list at random.
    if (!Number.isFinite(dist)) continue;
    out.push({ id: t.treeId, dist, count: t.count });
  }
  out.sort((a, b) => a.dist - b.dist || a.id - b.id);
  return out;
}
