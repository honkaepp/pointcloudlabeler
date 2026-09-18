/** React hooks over terrain.ts: a cloud's terrain for the height
 *  display, a ground level for what cannot take a surface, and the
 *  skeleton overlay's height in the cloud it is drawn over.
 *
 *  THE SKELETONS ALWAYS LAND ON THE CLOUD. A skeleton is built in its
 *  source cloud's frame: height above ground for a normalised TLS plot,
 *  elevation for an ALS epoch as it came. Drawn as stored over a cloud
 *  in the other frame it is hundreds of metres off, and "Load + show"
 *  showed nothing. So the overlay guesses both frames from their z
 *  ranges (heightFrames.ts) and converts per point: a normalised
 *  skeleton over an elevation cloud is LIFTED by the cloud's ground
 *  under each point; an elevation skeleton over a normalised cloud is
 *  DROPPED by its source cloud's ground. The terrain grids give the
 *  ground under each point; a cloud without a ground classification
 *  gives one level (loadGroundLevel) instead. */

import { useEffect, useMemo, useState } from 'react';
import { guessFrame } from '../components/shell/heightFrames';
import type { HeightMode } from '../components/shell/OctreeShellContext';
import { composeZAdjust, describeHeights, footprintOf, realignFor, zRangeOf, type GroundFn, type Realign, type ZAdjust } from './skeletonAlign';
import { loadGroundLevel, loadTerrain, TerrainDisplay } from './terrain';

export interface TerrainState {
  /** The dir this state is for; null while none is wanted. */
  dir: string | null;
  terrain: TerrainDisplay | null;
  /** A load is in flight. */
  pending: boolean;
  /** Asked, answered, and there is none: the cloud has no ground
   *  classification (or the bridge is absent). */
  missing: boolean;
}

const NO_TERRAIN: TerrainState = { dir: null, terrain: null, pending: false, missing: false };

/** The terrain of `dir`, loaded when non-null and disposed when the
 *  dir changes or the component leaves. */
export function useTerrain(dir: string | null): TerrainState {
  const [state, setState] = useState<TerrainState>(NO_TERRAIN);
  useEffect(() => {
    if (!dir) { setState(NO_TERRAIN); return; }
    let cancelled = false;
    let loaded: TerrainDisplay | null = null;
    setState({ dir, terrain: null, pending: true, missing: false });
    void loadTerrain(dir).then((t) => {
      if (cancelled) { t?.dispose(); return; }
      loaded = t;
      setState({ dir, terrain: t, pending: false, missing: t === null });
    });
    return () => {
      cancelled = true;
      loaded?.dispose();
    };
  }, [dir]);
  // A state for another dir is stale for one render; report none rather
  // than the old cloud's ground under the new cloud.
  return state.dir === dir ? state : (dir ? { dir, terrain: null, pending: true, missing: false } : NO_TERRAIN);
}

/** One ground level for `dir` under `within`, or null while unknown. */
export function useGroundLevel(dir: string | null, within: [number, number, number, number] | null): number | null {
  const [level, setLevel] = useState<{ dir: string; z: number | null } | null>(null);
  const key = within ? within.join(',') : '';
  useEffect(() => {
    if (!dir) { setLevel(null); return; }
    let cancelled = false;
    void loadGroundLevel(dir, within).then((z) => { if (!cancelled) setLevel({ dir, z }); });
    return () => { cancelled = true; };
    // `within` is compared by value through `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, key]);
  return level && level.dir === dir ? level.z : null;
}

export interface SkeletonLike {
  origin: [number, number, number];
  xyz: Float32Array;
  /** The cloud the skeletons were built from, for its ground when the
   *  skeletons are in elevation over a normalised cloud. */
  sourceDir?: string;
}

export interface HeightDisplay {
  /** The cloud's terrain to flatten it with, while heights are shown
   *  above ground and the cloud has one. Null otherwise. */
  flattenWith: TerrainDisplay | null;
  /** The cloud's terrain for the 'height' colour ramp, while the ramp
   *  is over height above ground and the cloud has one. Null otherwise. */
  colorWith: TerrainDisplay | null;
  /** Per-point height correction for the skeleton overlay, in world z,
   *  or null when it is drawn as stored. */
  skeletonZAdjust: ZAdjust | null;
  realign: Realign;
  /** What the viewport tells the user about the heights, or null when
   *  there is nothing to say. */
  note: string | null;
  cloudTerrain: TerrainState;
}

/** Everything the viewport needs to draw heights: the cloud's terrain
 *  (above-ground mode), and the skeleton overlay's realignment onto the
 *  cloud (always). `cloudGroundFallback` / `sourceGroundFallback` are
 *  levels a caller already has (the Compare view's); otherwise they are
 *  asked for when needed. */
export function useHeightDisplay(args: {
  heightMode: HeightMode;
  /** The 'height' colour ramp runs over height above ground. */
  colorAboveGround?: boolean;
  cloudDir: string;
  cloudZ: [number, number];
  skeleton: SkeletonLike | null | undefined;
  cloudGroundFallback?: number | null;
  sourceGroundFallback?: number | null;
}): HeightDisplay {
  const { heightMode, cloudDir, cloudZ, skeleton } = args;
  const cloudGuess = guessFrame(cloudZ[0], cloudZ[1]);
  const skelRange = useMemo(() => (skeleton ? zRangeOf(skeleton.origin, skeleton.xyz) : null), [skeleton]);
  const footprint = useMemo(() => (skeleton ? footprintOf(skeleton.origin, skeleton.xyz) : null), [skeleton]);
  const skelGuess = skelRange ? guessFrame(skelRange[0], skelRange[1]) : 'unknown';
  const realign = skeleton ? realignFor(skelGuess, cloudGuess) : 'none';
  const sourceDir = skeleton?.sourceDir ?? null;

  const flatten = heightMode === 'above_ground';
  const colorAbove = args.colorAboveGround === true;
  const cloudTerrain = useTerrain(flatten || colorAbove || realign === 'lift' ? cloudDir : null);
  const sourceTerrain = useTerrain(realign === 'drop' ? sourceDir : null);
  // A level instead of a surface where the surface is not to be had.
  const wantCloudLevel = realign === 'lift' && cloudTerrain.missing && args.cloudGroundFallback == null;
  const wantSourceLevel = realign === 'drop' && (sourceDir === null || sourceTerrain.missing) && args.sourceGroundFallback == null;
  const cloudLevel = useGroundLevel(wantCloudLevel ? cloudDir : null, footprint);
  const sourceLevel = useGroundLevel(wantSourceLevel && sourceDir ? sourceDir : null, footprint);
  const cloudGroundLevel = args.cloudGroundFallback ?? cloudLevel;
  const sourceGroundLevel = args.sourceGroundFallback ?? sourceLevel;

  const flattenWith = flatten ? cloudTerrain.terrain : null;
  const colorWith = colorAbove ? cloudTerrain.terrain : null;
  const skeletonZAdjust = useMemo<ZAdjust | null>(() => {
    const ct = cloudTerrain.terrain;
    const st = sourceTerrain.terrain;
    const cloudGround: GroundFn | null = ct ? (e, n) => ct.ground(e, n) : cloudGroundLevel != null ? () => cloudGroundLevel : null;
    const sourceGround: GroundFn | null = st ? (e, n) => st.ground(e, n) : sourceGroundLevel != null ? () => sourceGroundLevel : null;
    return composeZAdjust({
      realign, cloudGround, sourceGround,
      flatten: flattenWith ? (e, n) => flattenWith.shift(e, n) : null,
    });
  }, [realign, cloudTerrain.terrain, sourceTerrain.terrain, cloudGroundLevel, sourceGroundLevel, flattenWith]);

  const note = describeHeights({
    heightMode,
    terrain: cloudTerrain.terrain ? { reference: cloudTerrain.terrain.grid.reference, cell: cloudTerrain.terrain.grid.cell } : null,
    terrainPending: cloudTerrain.pending,
    terrainMissing: cloudTerrain.missing,
    realign,
    realigned: skeletonZAdjust !== null || realign === 'none',
    sourceKnown: sourceDir !== null,
  });
  return { flattenWith, colorWith, skeletonZAdjust, realign, note, cloudTerrain };
}
