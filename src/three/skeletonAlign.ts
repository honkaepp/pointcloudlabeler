/** The pure part of drawing skeletons over a cloud in another height
 *  frame, and of saying what the viewport does with heights — see
 *  useTerrain.ts for the hooks that feed it. */

import { framesDiffer, type FrameGuess } from '../components/shell/heightFrames';
import type { HeightMode } from '../components/shell/OctreeShellContext';

/** How the overlay is moved onto the cloud: not at all; LIFTED, a
 *  normalised skeleton over an elevation cloud, by the cloud's ground
 *  under each point; DROPPED, an elevation skeleton over a normalised
 *  cloud, by its source cloud's ground. */
export type Realign = 'none' | 'lift' | 'drop';
/** The ground's z at world (east, north). */
export type GroundFn = (east: number, north: number) => number;
/** What to add to a skeleton point's world z before it is drawn. */
export type ZAdjust = (east: number, north: number) => number;

/** [min, max] of the skeletons' world z, or null without a finite point. */
export function zRangeOf(origin: [number, number, number], xyz: Float32Array): [number, number] | null {
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < xyz.length; i += 3) {
    const z = xyz[i];
    if (!Number.isFinite(z)) continue;
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  if (lo > hi) return null;
  return [origin[2] + lo, origin[2] + hi];
}

/** [minEast, minNorth, maxEast, maxNorth] of the skeletons, in world
 *  coordinates, or null without a finite point. */
export function footprintOf(origin: [number, number, number], xyz: Float32Array): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < xyz.length; i += 3) {
    const x = xyz[i], y = xyz[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x0 > x1 || y0 > y1) return null;
  return [origin[0] + x0, origin[1] + y0, origin[0] + x1, origin[1] + y1];
}

/** Which way the skeletons move, from the two frame guesses. Nothing
 *  when either is unclear: a wrong move is worse than none. */
export function realignFor(skeleton: FrameGuess, cloud: FrameGuess): Realign {
  if (!framesDiffer(skeleton, cloud)) return 'none';
  return skeleton === 'above_ground' ? 'lift' : 'drop';
}

/** The per-point correction, or null when the skeletons are drawn as
 *  stored — because nothing is to be done, or because the ground the
 *  move needs is not there yet (the caller waits, and says so). The
 *  realignment puts the point in the cloud's stored frame; the flatten
 *  then takes the cloud's terrain off it like off every cloud point. */
export function composeZAdjust(args: {
  realign: Realign;
  cloudGround: GroundFn | null;
  sourceGround: GroundFn | null;
  flatten: ((east: number, north: number) => number) | null;
}): ZAdjust | null {
  const { realign, cloudGround, sourceGround, flatten } = args;
  let convert: ZAdjust | null = null;
  if (realign === 'lift') {
    if (!cloudGround) return null;
    convert = cloudGround;
  } else if (realign === 'drop') {
    if (!sourceGround) return null;
    convert = (e, n) => -sourceGround(e, n);
  }
  if (!convert && !flatten) return null;
  if (!flatten) return convert;
  if (!convert) return (e, n) => -flatten(e, n);
  const c = convert;
  return (e, n) => c(e, n) - flatten(e, n);
}

/** The viewport's one line about heights, or null when heights are as
 *  stored and the skeletons need no move. */
export function describeHeights(args: {
  heightMode: HeightMode;
  terrain: { reference: number; cell: number } | null;
  terrainPending: boolean;
  terrainMissing: boolean;
  realign: Realign;
  /** The skeleton correction is in place (or none is needed). */
  realigned: boolean;
  sourceKnown: boolean;
}): string | null {
  const parts: string[] = [];
  if (args.heightMode === 'above_ground') {
    if (args.terrain) parts.push(`Heights above ground · the ground is drawn at z ${args.terrain.reference.toFixed(1)} m (${args.terrain.cell} m grid)`);
    else if (args.terrainPending) parts.push('Heights above ground · reading the ground surface…');
    else if (args.terrainMissing) parts.push('Heights above ground · this cloud has no ground classification, so it is shown as stored');
  }
  if (args.realign === 'lift') {
    parts.push(args.realigned
      ? 'Skeletons lifted onto this cloud\'s ground: they are in height above ground, the cloud in elevation'
      : 'Skeletons: reading this cloud\'s ground to lift them onto it…');
  } else if (args.realign === 'drop') {
    if (args.realigned) parts.push('Skeletons lowered to height above ground: they are in elevation, the cloud is normalised');
    else if (!args.sourceKnown) parts.push('Skeletons are in elevation over a normalised cloud, and their source cloud is not known — shown as stored');
    else parts.push('Skeletons: reading their source cloud\'s ground to lower them…');
  }
  return parts.length ? parts.join(' · ') : null;
}
