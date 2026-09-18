/** The ground surface on the GPU — see terrainGrid.ts for the why and
 *  the maths, which this mirrors in a float texture the point shader
 *  samples per vertex. */

import * as THREE from 'three';
import { groundRange, parseTerrainGrid, relativeCells, sampleGround, terrainRelief, terrainShift, type TerrainGrid } from './terrainGrid';

export class TerrainDisplay {
  readonly grid: TerrainGrid;
  /** cols × rows R32F, the ground minus the reference; NaN → 0.
   *  NEAREST filtered — the shader does its own bilinear, since a float
   *  texture gets LINEAR only with an extension. */
  readonly texture: THREE.DataTexture;
  readonly relief: number;
  /** The lowest and highest ground, for a height-above-ground colour
   *  ramp's span: the tallest a point can stand over the ground is the
   *  cloud's top over the lowest ground. */
  readonly groundRange: [number, number];

  constructor(grid: TerrainGrid) {
    this.grid = grid;
    this.groundRange = groundRange(grid) ?? [grid.reference, grid.reference];
    const tex = new THREE.DataTexture(relativeCells(grid), grid.cols, grid.rows, THREE.RedFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;
    this.relief = terrainRelief(grid);
  }

  /** What to take off a point's scene height at world (east, north). */
  shift(east: number, north: number): number {
    return terrainShift(this.grid, east, north);
  }

  /** The ground's z at world (east, north) — the reference where the
   *  grid has no ground there. */
  ground(east: number, north: number): number {
    return sampleGround(this.grid, east, north);
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/** A 1 × 1 zero texture for the sampler while no terrain is set, so
 *  the uniform is never unbound. */
export function emptyTerrainTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

type DtmBridge = {
  octreeDtmGrid?: (dir: string, cell?: number) => Promise<ArrayBuffer>;
  octreeGroundReference?: (dir: string, within?: [number, number, number, number]) => Promise<{ z: number; from: string; cells: number }>;
};

/** One ground level for a cloud — the median of its ground under
 *  `within`, or its bounding box's floor when it has no ground
 *  classification — for what cannot be given a surface: a skeleton to
 *  realign over a cloud whose terrain is not available. Null only when
 *  the bridge is absent or the cloud cannot be read. */
export async function loadGroundLevel(dir: string, within?: [number, number, number, number] | null): Promise<number | null> {
  const d = (window as unknown as { desktop?: DtmBridge }).desktop;
  if (!d?.octreeGroundReference) return null;
  try {
    return (await d.octreeGroundReference(dir, within ?? undefined)).z;
  } catch (e) {
    console.warn('terrain: no ground level for', dir, e);
    return null;
  }
}

/** Load a cloud's terrain, or null when it has no ground classification
 *  (the Rust side refuses one) or the bridge is absent. */
export async function loadTerrain(dir: string, cell = 0.5): Promise<TerrainDisplay | null> {
  const d = (window as unknown as { desktop?: DtmBridge }).desktop;
  if (!d?.octreeDtmGrid) return null;
  try {
    return new TerrainDisplay(parseTerrainGrid(await d.octreeDtmGrid(dir, cell)));
  } catch (e) {
    console.warn('terrain: not available for', dir, e);
    return null;
  }
}
