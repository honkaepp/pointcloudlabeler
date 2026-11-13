// What the Branches panel draws in the viewport, as world-space line
// segments and dots: the caliper jaws and the section ring where a
// diameter is being read, and the polyline a length runs along. Pure,
// so the geometry is tested apart from the panel.

import type { BranchOverlayData } from './OctreeShellContext';
import { add, scale, type Section, type Vec3 } from '../../metrics/branchMeasure';

export const JAW1_COLOR = '#ffc400';
export const JAW2_COLOR = '#22d3ee';
export const RING_COLOR = '#ffffff';
export const PATH_COLOR = '#f5f5f5';
export const BASE_COLOR = '#7cfc00';
export const TIP_COLOR = '#ff6b6b';

/** A point of the section plane, (a, b) in the section's (u, v) frame,
 *  back in world coordinates. */
export function sectionToWorld(s: Pick<Section, 'center' | 'u' | 'v'>, a: number, b: number): Vec3 {
  return add(s.center, add(scale(s.u, a), scale(s.v, b)));
}

export interface JawPair {
  /** Direction of the reading (radians from u). */
  theta: number;
  lo: number;
  hi: number;
}

/** One pair of jaws: two strokes across direction θ at lo and hi, each
 *  `reach` long either side of the reading's line. */
function jawSegments(s: Pick<Section, 'center' | 'u' | 'v'>, j: JawPair, reach: number, color: string): BranchOverlayData['segments'] {
  const c = Math.cos(j.theta), sn = Math.sin(j.theta);
  const out: BranchOverlayData['segments'] = [];
  for (const t of [j.lo, j.hi]) {
    // Along the reading: (c, sn) · t; across it: (−sn, c) · ±reach.
    out.push({
      a: sectionToWorld(s, c * t + sn * reach, sn * t - c * reach),
      b: sectionToWorld(s, c * t - sn * reach, sn * t + c * reach),
      color,
    });
  }
  // The reading itself, jaw to jaw.
  out.push({ a: sectionToWorld(s, c * j.lo, sn * j.lo), b: sectionToWorld(s, c * j.hi, sn * j.hi), color });
  return out;
}

/** The section being read: a ring of the measured diameter around the
 *  axis, the jaws of each reading, and a dot on the centre. */
export function sectionOverlay(
  s: Pick<Section, 'center' | 'u' | 'v'>,
  jaws: JawPair[],
  diameter: number,
): BranchOverlayData {
  const segments: BranchOverlayData['segments'] = [];
  const r = Math.max(diameter / 2, 1e-4);
  const n = 32;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * 2 * Math.PI, a1 = ((k + 1) / n) * 2 * Math.PI;
    segments.push({
      a: sectionToWorld(s, r * Math.cos(a0), r * Math.sin(a0)),
      b: sectionToWorld(s, r * Math.cos(a1), r * Math.sin(a1)),
      color: RING_COLOR,
    });
  }
  const reach = r * 1.3;
  jaws.forEach((j, i) => segments.push(...jawSegments(s, j, reach, i === 0 ? JAW1_COLOR : JAW2_COLOR)));
  return { segments, dots: [{ p: s.center, color: RING_COLOR }] };
}

/** A length: the polyline, its base and its tip. */
export function pathOverlay(nodes: Vec3[]): BranchOverlayData {
  const segments: BranchOverlayData['segments'] = [];
  for (let i = 1; i < nodes.length; i++) segments.push({ a: nodes[i - 1], b: nodes[i], color: PATH_COLOR });
  const dots: BranchOverlayData['dots'] = nodes.map((p, i) => ({
    p,
    color: i === 0 ? BASE_COLOR : i === nodes.length - 1 ? TIP_COLOR : PATH_COLOR,
  }));
  return { segments, dots };
}

export function mergeOverlays(...parts: Array<BranchOverlayData | null | undefined>): BranchOverlayData | null {
  const segments: BranchOverlayData['segments'] = [];
  const dots: BranchOverlayData['dots'] = [];
  for (const p of parts) {
    if (!p) continue;
    segments.push(...p.segments);
    dots.push(...p.dots);
  }
  return segments.length === 0 && dots.length === 0 ? null : { segments, dots };
}

/** World bounding box of a flat xyz buffer, grown by `pad` metres. */
export function boundsOf(xyz: ArrayLike<number>, pad = 0): { min: Vec3; max: Vec3 } | null {
  const n = Math.floor(xyz.length / 3);
  if (n === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = xyz[i * 3 + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min: [min[0] - pad, min[1] - pad, min[2] - pad], max: [max[0] + pad, max[1] + pad, max[2] + pad] };
}
