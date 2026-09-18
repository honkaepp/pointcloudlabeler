// Renders DTM / DSM / CHM rasters as 3D surfaces inside the octree
// viewport so they show up as toggleable scene objects (Layers panel).
//
// Geometry: one vertex per grid cell centre, two triangles per quad,
// skipping any quad touching a NODATA (NaN) cell. Vertex colour comes
// from a value ramp. Placement follows the point cloud's scene transform
// (sceneX = worldX − offsetX, sceneZ = worldY − offsetY). Height:
//   • DTM / DSM values are absolute elevations → sceneY = value − offsetZ
//   • CHM values are heights above ground → sceneY = value (a relief that
//     sits roughly at canopy height above the scene's ground baseline)
// so each surface lands where you'd expect relative to the cloud.

import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { TerrainDisplay } from './terrain';
import type { RasterLayer, RasterGrid } from '../persistence/octreeReader';

interface Props {
  layers: RasterLayer[];
  /** Dataset offset (metadata.offset) — the scene origin in source CRS. */
  offset: [number, number, number];
  /** The cloud's terrain while heights are shown above ground: every
   *  surface comes down by the ground under it, like the points — a
   *  DTM goes flat at its reference level, a CHM shows canopy height
   *  over it. Null leaves the surfaces at their stored heights. */
  terrain?: TerrainDisplay | null;
}

export default function RasterLayers({ layers, offset, terrain = null }: Props) {
  const { scene } = useThree();
  const groupRef = useRef<THREE.Group | null>(null);

  // Stable group parented to the scene for the lifetime of the viewer.
  useEffect(() => {
    const g = new THREE.Group();
    g.renderOrder = 1; // after points (helps EDL read a sensible depth)
    scene.add(g);
    groupRef.current = g;
    return () => {
      scene.remove(g);
      disposeGroup(g);
      groupRef.current = null;
    };
  }, [scene]);

  // Rebuild the meshes whenever the visible layer set / grids change. The
  // raster grids are small (plot-scale) so a full rebuild is cheap and
  // keeps the bookkeeping simple.
  useEffect(() => {
    const g = groupRef.current;
    if (!g) return;
    disposeGroup(g);
    for (const layer of layers) {
      if (!layer.visible || !layer.grid) continue;
      const mesh = buildSurface(layer.grid, layer.kind, offset, layer.opacity ?? 1, !!layer.wireframe, layer.elevationGrid ?? null, terrain);
      if (mesh) {
        mesh.userData.layerId = layer.id;
        g.add(mesh);
      }
    }
  }, [layers, offset, terrain]);

  return null;
}

function disposeGroup(g: THREE.Group) {
  for (let i = g.children.length - 1; i >= 0; i--) {
    const m = g.children[i] as THREE.Mesh;
    m.removeFromParent();
    m.geometry?.dispose();
    (m.material as THREE.Material | undefined)?.dispose();
  }
}

function buildSurface(
  grid: RasterGrid, kind: RasterLayer['kind'], offset: [number, number, number],
  opacity: number, wireframe: boolean, elevationGrid: RasterGrid | null,
  terrain: TerrainDisplay | null = null,
): THREE.Mesh | null {
  const { cols, rows, cellSize, minX, minY, values, vmin, vmax } = grid;
  if (cols < 2 || rows < 2) return null;
  const n = cols * rows;
  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const span = Math.max(vmax - vmin, 1e-6);
  // Whether the cell value is itself an elevation (DTM / DSM / the
  // sink-filled DEM) or a non-elevation attribute (CHM = height,
  // slope / aspect / TPI / curvature / etc.). Non-elevation surfaces
  // are draped on the supplied ground grid so they sit at the real
  // DEM elevation rather than at "value = height".
  const absolute = kind === 'dtm' || kind === 'dsm' || kind === 'filled';
  // Drape: when an aligned ground grid is supplied, place the surface at
  // the ground elevation. For the CHM the value adds (canopy = ground +
  // height). For slope/aspect/TPI the value is purely decorative — the
  // ground level alone gives a correct relief.
  const drape = elevationGrid && elevationGrid.values.length === n ? elevationGrid.values : null;
  const useValueAsHeight = kind === 'chm'; // ground + canopy height
  // Pre-compute the diverging-ramp scale for TPI / curvature so the
  // rendering is symmetric about zero (positive = ridge / convex,
  // negative = valley / concave).
  const divergingScale = (kind === 'tpi' || kind === 'plan_curv' || kind === 'profile_curv')
    ? Math.max(Math.abs(vmin), Math.abs(vmax), 1e-6)
    : 0;
  // Flow accumulation spans many orders of magnitude — squash with
  // log1p so the network is visible even when one main channel
  // carries the bulk.
  const flowLogScale = kind === 'flow_accum' ? Math.log1p(Math.max(vmax, 1)) : 0;
  // Point density per cell also spans orders of magnitude; same trick.
  const densityLogScale = kind === 'density' ? Math.log1p(Math.max(vmax, 1)) : 0;
  // Skew + kurt are diverging about 0 — symmetric scale by |range|.
  const skewKurtScale = (kind === 'height_skew' || kind === 'height_kurt')
    ? Math.max(Math.abs(vmin), Math.abs(vmax), 1e-3)
    : 0;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const idx = cy * cols + cx;
      const v = values[idx];
      const wx = minX + (cx + 0.5) * cellSize;
      const wy = minY + (cy + 0.5) * cellSize;
      positions[idx * 3] = wx - offset[0];
      let sceneY: number;
      if (Number.isNaN(v)) sceneY = 0;
      else if (absolute) sceneY = v - offset[2];
      else if (drape) {
        const g = drape[idx];
        if (Number.isNaN(g)) sceneY = useValueAsHeight ? v : 0;
        else sceneY = useValueAsHeight ? (g + v - offset[2]) : (g - offset[2]);
      } else sceneY = useValueAsHeight ? v : 0;
      if (terrain && !Number.isNaN(v)) sceneY -= terrain.shift(wx, wy);
      positions[idx * 3 + 1] = sceneY;
      // sceneZ = −north (matches the point cloud's right-handed mapping).
      positions[idx * 3 + 2] = -(wy - offset[1]);
      // Per-kind colour normalisation. Slope clamps at 60° (anything
      // steeper reads as fully red), aspect wraps 0..360 cyclically,
      // TPI is symmetric about zero so 0 = grey, ±tpiScale = the
      // ramp ends.
      let t: number;
      if (Number.isNaN(v)) t = 0;
      else if (kind === 'slope') t = Math.min(1, Math.max(0, v / 60));
      else if (kind === 'aspect') t = (((v % 360) + 360) % 360) / 360;
      else if (kind === 'tpi' || kind === 'plan_curv' || kind === 'profile_curv') {
        t = 0.5 + 0.5 * Math.max(-1, Math.min(1, v / divergingScale));
      }
      else if (kind === 'flow_accum') {
        // log1p compresses the long tail; flowLogScale = log1p(vmax).
        t = flowLogScale > 0 ? Math.log1p(Math.max(0, v)) / flowLogScale : 0;
      }
      else if (kind === 'streams') {
        // Hard binary; the ramp's first two stops are the same colour.
        t = v >= 0.5 ? 0.75 : 0.1;
      }
      else if (kind === 'hli') {
        // HLI is already in roughly [0..1] (it's exp of a small
        // quantity); clamp to the observed range for a useful spread.
        t = (v - vmin) / span;
      }
      else if (kind === 'density') {
        t = densityLogScale > 0 ? Math.log1p(Math.max(0, v)) / densityLogScale : 0;
      }
      else if (kind === 'height_skew' || kind === 'height_kurt') {
        t = 0.5 + 0.5 * Math.max(-1, Math.min(1, v / skewKurtScale));
      }
      else if (kind === 'canopy_cover') {
        // Already in [0..1] — pass through.
        t = Math.max(0, Math.min(1, v));
      }
      else if (kind === 'hillshade' || kind === 'hillshade_multi') {
        // Already in [0..1] — pass through. Pure grayscale shading
        // is the cartographic standard.
        t = Math.max(0, Math.min(1, v));
      }
      else t = (v - vmin) / span;
      const [r, g, b] = ramp(kind, t);
      colors[idx * 3] = r; colors[idx * 3 + 1] = g; colors[idx * 3 + 2] = b;
    }
  }

  // Two triangles per quad, skipping any quad with a NODATA corner.
  const index: number[] = [];
  for (let cy = 0; cy < rows - 1; cy++) {
    for (let cx = 0; cx < cols - 1; cx++) {
      const a = cy * cols + cx;
      const b = cy * cols + cx + 1;
      const c = (cy + 1) * cols + cx;
      const d = (cy + 1) * cols + cx + 1;
      if (Number.isNaN(values[a]) || Number.isNaN(values[b]) || Number.isNaN(values[c]) || Number.isNaN(values[d])) continue;
      index.push(a, c, b, b, c, d);
    }
  }
  if (index.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geom.setIndex(index);
  geom.computeVertexNormals();
  geom.computeBoundingSphere();

  const op = Math.max(0.05, Math.min(1, opacity));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    wireframe,
    transparent: op < 1,
    opacity: op,
    depthWrite: op >= 1,
  });
  return new THREE.Mesh(geom, mat);
}

// Per-kind colour ramps. CHM uses a green→yellow→red height ramp (low
// canopy → tall), terrain models use a muted earth→pale ramp, slope
// goes cool→hot, aspect uses a cyclic compass-style ramp (so north
// wraps cleanly), and TPI is diverging blue↔grey↔red about zero so
// ridges and valleys read at a glance.
function ramp(kind: RasterLayer['kind'], t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  let stops: [number, number, number][];
  if (kind === 'chm') {
    stops = [[40, 70, 50], [90, 150, 60], [210, 200, 70], [220, 120, 40], [200, 50, 40]];
  } else if (kind === 'slope') {
    // Shallow → steep. Slope is normalised against ~60° in the
    // caller's `t` so the hot end (>= 45°) reads as red.
    stops = [[44, 46, 60], [60, 111, 140], [118, 176, 122], [224, 200, 120], [220, 112, 80]];
  } else if (kind === 'aspect') {
    // Cyclic ramp: north (0°/360°) red, east yellow, south green,
    // west blue, back to red. Matches the conic gradient swatch in
    // the Layers panel.
    stops = [[220, 78, 110], [220, 196, 74], [90, 210, 160], [90, 156, 240], [160, 100, 224], [220, 78, 110]];
  } else if (kind === 'tpi' || kind === 'plan_curv' || kind === 'profile_curv') {
    // Diverging blue → grey → red. TPI: valley / mid-slope / ridge.
    // Curvature: concave / planar / convex. Caller maps the signed
    // value to [0..1] symmetric about 0.5.
    stops = [[64, 96, 192], [160, 184, 224], [220, 220, 220], [224, 160, 112], [200, 50, 40]];
  } else if (kind === 'flow_accum') {
    // Sequential dark → bright on a log-scaled `t` so a few high-
    // accumulation channels don't drown out the rest of the network.
    stops = [[26, 32, 48], [42, 64, 112], [64, 128, 192], [96, 192, 224], [220, 240, 255]];
  } else if (kind === 'twi') {
    // Dry → wet diverging-ish ramp: warm low TWI (drainage divides),
    // cool high TWI (saturated valleys). Centred around the population
    // median.
    stops = [[200, 64, 64], [224, 160, 96], [220, 220, 160], [128, 192, 160], [64, 128, 192]];
  } else if (kind === 'streams') {
    // Binary: 0 = background, 1 = stream. Hard cyan for the network.
    stops = [[32, 32, 40], [32, 32, 40], [64, 160, 224], [64, 160, 224]];
  } else if (kind === 'tri') {
    // Single-hue sequential — smooth to rough.
    stops = [[44, 46, 60], [74, 96, 140], [124, 152, 200], [188, 208, 232], [240, 240, 248]];
  } else if (kind === 'hli') {
    // Cold (north-facing) → hot (south-west-facing). HLI is already
    // in [0..1]ish so the caller passes `t` straight through.
    stops = [[48, 96, 192], [128, 160, 224], [220, 220, 220], [224, 176, 112], [200, 80, 64]];
  } else if (kind === 'height_mean' || kind === 'height_p25' || kind === 'height_p50'
          || kind === 'height_p75' || kind === 'height_p90' || kind === 'height_p95') {
    // Same green→yellow→red height ramp the CHM uses, so the per-
    // percentile and mean-height rasters read consistently with the
    // canopy-height map and with each other.
    stops = [[40, 70, 50], [90, 150, 60], [210, 200, 70], [220, 120, 40], [200, 50, 40]];
  } else if (kind === 'height_sd' || kind === 'height_cv') {
    // SD / CV: muted blue → white sequential — the standard
    // "uncertainty / spread" ramp.
    stops = [[44, 46, 60], [64, 96, 160], [128, 160, 200], [192, 208, 224], [240, 240, 248]];
  } else if (kind === 'height_skew' || kind === 'height_kurt') {
    // Diverging about zero — same as curvatures.
    stops = [[64, 96, 192], [160, 184, 224], [220, 220, 220], [224, 160, 112], [200, 50, 40]];
  } else if (kind === 'density') {
    // Sequential dark → bright (like flow_accum) — densities span
    // many orders of magnitude.
    stops = [[26, 32, 48], [42, 64, 112], [64, 128, 192], [96, 192, 224], [220, 240, 255]];
  } else if (kind === 'canopy_cover') {
    // Bare ground (warm brown) → fully closed canopy (deep green).
    stops = [[60, 38, 24], [160, 96, 48], [210, 200, 70], [90, 150, 60], [42, 70, 50]];
  } else if (kind === 'hillshade' || kind === 'hillshade_multi') {
    // Pure grayscale — the cartographic standard. Hillshade values
    // are already in [0..1] so the ramp passes through directly.
    stops = [[16, 16, 16], [64, 64, 64], [128, 128, 128], [192, 192, 192], [240, 240, 240]];
  } else {
    // DTM / DSM: muted earth → pale.
    stops = [[60, 50, 40], [110, 95, 70], [165, 150, 120], [220, 215, 200]];
  }
  const f = x * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const k = f - i;
  const a = stops[i], b = stops[i + 1];
  return [
    (a[0] + (b[0] - a[0]) * k) / 255,
    (a[1] + (b[1] - a[1]) * k) / 255,
    (a[2] + (b[2] - a[2]) * k) / 255,
  ];
}
