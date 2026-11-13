// Read-only overlay point cloud — a second (and beyond) octree rendered
// into the same scene as the primary editable cloud. Loads only the tile
// roots (sparse overview, fast to load and bounded in size); the primary
// cloud retains full LOD streaming. Editing and picking stay scoped to
// the primary; overlays are pure visualisation so adding or removing one
// can never affect the primary's state.
//
// Placement: an overlay decodes its points in its own scene coords (using
// its own metadata.offset). To line up with the primary cloud, the group
// is shifted by the offset difference (with the same Y/Z axis swap the
// rest of the editor uses). Two clouds with the same source-CRS bounds
// therefore overlap perfectly regardless of import order.
//
// Per-overlay colouring + optional filter sync: all of the primary's
// filters ("sync filters"), only its X / Y / Z extent ("sync extent" — the
// height filter clips both clouds at the same elevation without the
// primary's tree, class and id filters, which mean nothing in another
// cloud), or none. The ranges are world coordinates, converted through
// the overlay's own offset. The decoded attribute arrays (treeIds /
// classification / intensity) are kept in memory per tile so colour-mode
// and filter changes recolour / re-mask in place without ever re-reading
// the disk. The shader matches the primary
// cloud's pattern (per-point aVisible mask that displaces hidden points
// to a clip-space corner) so a filtered overlay never rasterises stray
// pixels even on GPUs that clamp gl_PointSize back up to 1.

import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { decodeNodePoints, readBlock, type ExtraArray, type OpenOctree } from '../persistence/octreeReader';
import { DEFAULT_FILTERS, type FilterConfig } from '../components/shell/OctreeShellContext';
import { classColorIn, namedClassCodes, treeIdColor01, hexToRgb01, UNASSIGNED_RGB } from './palette';
import { eastRangeToScene, northRangeToScene, upRangeToScene, type Vec3 } from './filterGeometry';
import type { TerrainDisplay } from './terrain';
import { useTerrain } from './useTerrain';

/** Unassigned points, 0–1. Shares the viewport's default grey rather
 *  than the near-miss 0.55 this file used to hardcode. */
const UNASSIGNED_COLOR: [number, number, number] = [
  UNASSIGNED_RGB[0] / 255, UNASSIGNED_RGB[1] / 255, UNASSIGNED_RGB[2] / 255,
];

export type OverlayColorMode = 'flat' | 'height' | 'intensity' | 'classification' | 'tree_id' | `extra:${string}`;

/** The filters an overlay draws with — all of the primary's
 *  (`syncFilters`), only its X / Y / Z extent (`syncExtent`), or none
 *  (DEFAULT_FILTERS, which hide nothing). The ranges are world
 *  coordinates, so each cloud converts them through its own offset. */
export function overlayFilters(primary: FilterConfig, syncFilters: boolean, syncExtent: boolean): FilterConfig {
  if (syncFilters) return primary;
  if (!syncExtent || (!primary.xRange && !primary.yRange && !primary.zRange)) return DEFAULT_FILTERS;
  return { ...DEFAULT_FILTERS, xRange: primary.xRange, yRange: primary.yRange, zRange: primary.zRange };
}

interface Props {
  octree: OpenOctree;
  /** Primary cloud's metadata.offset — overlay points are displaced by
   *  the overlay's offset minus this, expressed in scene axes. */
  primaryOffset: [number, number, number];
  visible: boolean;
  /** Hex tint ('#rrggbb'): used as the flat colour, and as the ramp's
   *  high end / accent in the other modes. */
  color: string;
  colorMode: OverlayColorMode;
  /** The primary's filters; what of them this overlay takes is
   *  `syncFilters` / `syncExtent` (overlayFilters). */
  filters: FilterConfig;
  /** All of them: any point hidden by the primary's filter set is also
   *  hidden here. */
  syncFilters: boolean;
  /** Only the X / Y / Z extent (the height filter among them). */
  syncExtent: boolean;
  /** Heights above ground: take the ground under each point off its
   *  height, with this cloud's own terrain — or, when it has no ground
   *  classification, the primary's (`fallbackTerrain`): it is the same
   *  ground. See three/terrainGrid.ts. */
  flatten?: boolean;
  fallbackTerrain?: TerrainDisplay | null;
}

/** What the filters read of an overlay tile's points. */
export interface OverlayPoints {
  /** Scene coordinates in the overlay's own frame (x = east − offset,
   *  y = height − offset, z = −(north − offset)), heights above ground
   *  while those are shown. */
  positions: Float32Array;
  treeIds: Int32Array;
  classification: Uint8Array;
  count: number;
  /** What was taken off each point's height to show it above ground, so
   *  the extent tests the stored elevation like the primary's filters;
   *  null when nothing was. */
  ground: Float32Array | null;
}

/** Per-tile attribute slice kept in memory so colour-mode + filter
 *  changes can repaint / remask the overlay without re-reading disk. */
interface TileData extends OverlayPoints {
  intensity: Uint16Array;
  /** Numeric extra columns decoded from the overlay's octree, keyed by name. */
  extras: Record<string, ExtraArray>;
  points: THREE.Points;
}

const VERTEX_SHADER = /* glsl */ `
attribute vec3 color;
attribute float aVisible;
uniform float uSize;
varying vec3 vColor;
void main() {
  if (aVisible < 0.5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    return;
  }
  vColor = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize;
}
`;
const FRAGMENT_SHADER = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }
`;

export default function OverlayCloud({
  octree, primaryOffset, visible, color, colorMode, filters: primaryFilters, syncFilters, syncExtent, flatten = false, fallbackTerrain = null,
}: Props) {
  const { scene } = useThree();
  const filters = useMemo(
    () => overlayFilters(primaryFilters, syncFilters, syncExtent),
    [primaryFilters, syncFilters, syncExtent],
  );
  // The class palette with a colour of its own for each class this
  // cloud's source file named.
  const named = useMemo(() => namedClassCodes(octree.meta.classNames), [octree.meta.classNames]);
  const namedRef = useRef(named);
  namedRef.current = named;
  const own = useTerrain(flatten ? octree.dir : null);
  // Wait for this cloud's own answer before falling back, so the tiles
  // are not decoded once flat to the primary's ground and again to
  // their own.
  const terrain: TerrainDisplay | null = !flatten ? null : own.pending ? null : (own.terrain ?? fallbackTerrain);
  const groupRef = useRef<THREE.Group | null>(null);
  const tilesRef = useRef<TileData[]>([]);
  // Cross-tile statistics for the ramp modes — filled as tiles load.
  // Height: scene Y range. Intensity: raw u16 range. Both are computed
  // across every loaded tile so a single ramp covers the whole overlay.
  const statsRef = useRef<{ hLo: number; hHi: number; iLo: number; iHi: number }>({ hLo: 0, hHi: 1, iLo: 0, iHi: 1 });
  // Latest props in refs so the async loader colours freshly-loaded tiles
  // with the current values without being a load dependency.
  const colorRef = useRef(color);
  const colorModeRef = useRef(colorMode);
  const filtersRef = useRef(filters);
  // Cloud-wide range per extra column (from the overlay's own metadata) for
  // the `extra:<name>` colour mode. Stable for the overlay's lifetime.
  const extraRangesRef = useRef<Record<string, { lo: number; hi: number }>>({});
  extraRangesRef.current = useMemo(() => {
    const out: Record<string, { lo: number; hi: number }> = {};
    for (const e of octree.meta.extras ?? []) out[e.name] = { lo: e.min, hi: e.max };
    return out;
  }, [octree.meta.extras]);

  // Scene axes: x = source X, y = source Z (height), z = −source Y (north
  // negated to keep the scene right-handed; see decodeNodePoints). The
  // overlay decodes in its own scene coords; shifting the group brings the
  // two into a shared world space. The north (z) shift negates with the
  // axis so coincident clouds still align.
  const correction = useMemo<[number, number, number]>(() => [
    octree.meta.offset[0] - primaryOffset[0],
    octree.meta.offset[2] - primaryOffset[2],
    primaryOffset[1] - octree.meta.offset[1],
  ], [octree.meta.offset, primaryOffset]);

  // Mount + load every tile root once. Each root carries a uniform-density
  // sample of the whole tile, so all roots together give a recognisable
  // overview for any cloud size — without paying for the full LOD pyramid
  // the primary streamer maintains. Colour / filter changes are handled
  // by the dedicated effects below so they never trigger a reload.
  useEffect(() => {
    let cancelled = false;
    const group = new THREE.Group();
    group.position.set(correction[0], correction[1], correction[2]);
    group.renderOrder = 0;
    scene.add(group);
    groupRef.current = group;
    tilesRef.current = [];
    statsRef.current = { hLo: Infinity, hHi: -Infinity, iLo: Infinity, iHi: -Infinity };

    (async () => {
      for (let t = 0; t < octree.meta.tiles.length; t++) {
        if (cancelled) return;
        const rec = octree.tileRecordStarts[t];
        const r = octree.records[rec];
        if (!r || r.byteSize === 0) continue;
        try {
          const bytes = await readBlock(octree.dir, r.byteOffset, r.byteSize);
          if (cancelled) return;
          const decoded = decodeNodePoints(
            bytes, octree.meta.scale, octree.meta.offset, octree.meta.pointBytes,
            octree.meta.extras ?? [],
          );
          if (decoded.count === 0) continue;
          // Heights above ground: the terrain off each point, in this
          // cloud's own scene frame (x = east − offset, z = −(north −
          // offset)), before the height stats see the points. What came
          // off is kept for the extent filter, which reads the stored
          // elevation.
          let ground: Float32Array | null = null;
          if (terrain) {
            const off = octree.meta.offset;
            const ps = decoded.positions;
            ground = new Float32Array(decoded.count);
            for (let i = 0; i < decoded.count; i++) {
              const x = ps[i * 3], z = ps[i * 3 + 2];
              if (!Number.isFinite(x)) continue;
              const g = terrain.shift(x + off[0], off[1] - z);
              ps[i * 3 + 1] -= g;
              ground[i] = g;
            }
          }
          // Extend the per-overlay stats with this tile's range so the
          // ramp modes have a stable span across the whole overlay.
          const stats = statsRef.current;
          for (let i = 0; i < decoded.count; i++) {
            const h = decoded.positions[i * 3 + 1];
            if (h < stats.hLo) stats.hLo = h;
            if (h > stats.hHi) stats.hHi = h;
            const it = decoded.intensity[i];
            if (it < stats.iLo) stats.iLo = it;
            if (it > stats.iHi) stats.iHi = it;
          }
          const geom = new THREE.BufferGeometry();
          geom.setAttribute('position', new THREE.BufferAttribute(decoded.positions, 3));
          const colorAttr = new THREE.BufferAttribute(new Float32Array(decoded.count * 3), 3);
          colorAttr.setUsage(THREE.DynamicDrawUsage);
          geom.setAttribute('color', colorAttr);
          const visBuf = new Float32Array(decoded.count); visBuf.fill(1);
          const visAttr = new THREE.BufferAttribute(visBuf, 1);
          visAttr.setUsage(THREE.DynamicDrawUsage);
          geom.setAttribute('aVisible', visAttr);
          geom.computeBoundingSphere();
          const mat = new THREE.ShaderMaterial({
            uniforms: { uSize: { value: 1 } },
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER,
            transparent: false, depthTest: true, depthWrite: true,
          });
          const obj = new THREE.Points(geom, mat);
          obj.frustumCulled = true;
          if (cancelled) { geom.dispose(); mat.dispose(); continue; }
          group.add(obj);
          const tile: TileData = {
            positions: decoded.positions,
            treeIds: decoded.treeIds,
            classification: decoded.classification,
            intensity: decoded.intensity,
            extras: decoded.extras,
            count: decoded.count,
            ground,
            points: obj,
          };
          tilesRef.current.push(tile);
          // Colour + mask this tile immediately so points appear as they
          // load. The final stats pass below repaints everything once the
          // overlay-wide ranges are known.
          paintTile(tile, colorModeRef.current, colorRef.current, statsRef.current, extraRangesRef.current, namedRef.current);
          maskTile(tile, filtersRef.current, octree.meta.offset);
        } catch (e) {
          console.warn(`overlay root tile=${t} load failed`, e);
        }
      }
      if (cancelled) return;
      // Final repaint with the now-tight stats — corrects any tile that
      // was painted before later tiles widened the range.
      for (const tile of tilesRef.current) {
        paintTile(tile, colorModeRef.current, colorRef.current, statsRef.current, extraRangesRef.current, namedRef.current);
      }
    })();

    return () => {
      cancelled = true;
      scene.remove(group);
      for (let i = group.children.length - 1; i >= 0; i--) {
        const m = group.children[i] as THREE.Points;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose();
      }
      tilesRef.current = [];
      groupRef.current = null;
    };
    // Intentionally NOT keyed on color / colorMode / filters: those drive
    // the separate effects below so they never trigger a reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [octree, correction, scene, terrain]);

  useEffect(() => {
    colorRef.current = color;
    colorModeRef.current = colorMode;
    for (const tile of tilesRef.current) paintTile(tile, colorMode, color, statsRef.current, extraRangesRef.current, named);
  }, [color, colorMode, named]);

  useEffect(() => {
    filtersRef.current = filters;
    for (const tile of tilesRef.current) maskTile(tile, filters, octree.meta.offset);
  }, [filters, octree.meta.offset]);

  useEffect(() => {
    if (groupRef.current) groupRef.current.visible = visible;
  }, [visible]);

  return null;
}

/** Rewrite one tile's colour buffer in place for the given mode/tint. */
function paintTile(
  tile: TileData, mode: OverlayColorMode, color: string,
  stats: { hLo: number; hHi: number; iLo: number; iHi: number },
  extraRanges: Record<string, { lo: number; hi: number }> = {},
  /** The classes this cloud's source file named (classColorIn). */
  named: readonly number[] = [],
) {
  const col = tile.points.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!col) return;
  const cArr = col.array as Float32Array;
  const rgb = hexToRgb(color);
  const n = tile.count;
  // `extra:<name>` — colour by a numeric extra over the overlay's own
  // metadata range, mirroring the primary cloud's extra colouring.
  if (typeof mode === 'string' && mode.startsWith('extra:')) {
    const name = mode.slice('extra:'.length);
    const arr = tile.extras[name];
    const r = extraRanges[name];
    if (arr && r && r.hi > r.lo) {
      const span = Math.max(1e-6, r.hi - r.lo);
      for (let i = 0; i < n; i++) {
        const c = rampSample(HEIGHT_STOPS, clamp01((arr[i] - r.lo) / span));
        cArr[i * 3] = c[0]; cArr[i * 3 + 1] = c[1]; cArr[i * 3 + 2] = c[2];
      }
    } else {
      for (let i = 0; i < n; i++) { cArr[i * 3] = rgb[0]; cArr[i * 3 + 1] = rgb[1]; cArr[i * 3 + 2] = rgb[2]; }
    }
    col.needsUpdate = true;
    return;
  }
  switch (mode) {
    case 'flat': {
      for (let i = 0; i < n; i++) {
        cArr[i * 3] = rgb[0]; cArr[i * 3 + 1] = rgb[1]; cArr[i * 3 + 2] = rgb[2];
      }
      break;
    }
    case 'height': {
      const span = Math.max(1e-6, stats.hHi - stats.hLo);
      const pos = tile.positions;
      for (let i = 0; i < n; i++) {
        const t = clamp01((pos[i * 3 + 1] - stats.hLo) / span);
        const c = rampSample(HEIGHT_STOPS, t);
        cArr[i * 3] = c[0]; cArr[i * 3 + 1] = c[1]; cArr[i * 3 + 2] = c[2];
      }
      break;
    }
    case 'intensity': {
      const span = Math.max(1, stats.iHi - stats.iLo);
      const it = tile.intensity;
      for (let i = 0; i < n; i++) {
        const t = clamp01((it[i] - stats.iLo) / span);
        const c = rampSample(INTENSITY_STOPS, t);
        cArr[i * 3] = c[0]; cArr[i * 3 + 1] = c[1]; cArr[i * 3 + 2] = c[2];
      }
      break;
    }
    case 'classification': {
      const cls = tile.classification;
      for (let i = 0; i < n; i++) {
        const c = classColorIn(cls[i], named);
        cArr[i * 3] = c[0] / 255; cArr[i * 3 + 1] = c[1] / 255; cArr[i * 3 + 2] = c[2] / 255;
      }
      break;
    }
    case 'tree_id': {
      const ids = tile.treeIds;
      for (let i = 0; i < n; i++) {
        const id = ids[i];
        const c = id <= 0 ? UNASSIGNED_COLOR : treeIdColor01(id);
        cArr[i * 3] = c[0]; cArr[i * 3 + 1] = c[1]; cArr[i * 3 + 2] = c[2];
      }
      break;
    }
  }
  col.needsUpdate = true;
}

/** Recompute one tile's aVisible mask from the (synced) filter config —
 *  see maskPoints. `offset` is this cloud's own metadata.offset. */
function maskTile(tile: TileData, f: FilterConfig | null, offset: Vec3) {
  const va = tile.points.geometry.getAttribute('aVisible') as THREE.BufferAttribute | undefined;
  if (!va) return;
  maskPoints(va.array as Float32Array, tile, f, offset);
  va.needsUpdate = true;
}

/** Which of an overlay tile's points `f` keeps, into `out` (1 drawn,
 *  0 hidden). Mirrors the primary cloud's applyFilters for what makes
 *  sense in another cloud: unassigned / isolate / id range / classes, and
 *  the X / Y / Z extent — world ranges, converted through THIS cloud's
 *  `offset` (its scene frame), the height tested at the stored elevation
 *  even while heights are shown above ground. null → everything drawn. */
export function maskPoints(out: Float32Array, pts: OverlayPoints, f: FilterConfig | null, offset: Vec3): void {
  const n = pts.count;
  if (f === null) {
    for (let i = 0; i < n; i++) out[i] = 1;
    return;
  }
  const ids = pts.treeIds;
  const cls = pts.classification;
  const pos = pts.positions;
  const ground = pts.ground;
  const hideUnassigned = f.hideUnassigned;
  const isolate = f.isolateTreeId;
  const isolateKeepUnassigned = f.isolateShowUnassigned;
  const range = f.treeIdRange;
  const rangeMin = range ? range[0] : 0;
  const rangeMax = range ? range[1] : 0;
  let classMask: Uint8Array | null = null;
  if (f.hiddenClasses.length > 0) {
    classMask = new Uint8Array(256);
    for (const c of f.hiddenClasses) if (c >= 0 && c < 256) classMask[c] = 1;
  }
  const xr = f.xRange ? eastRangeToScene(f.xRange, offset) : null;
  const yr = f.yRange ? northRangeToScene(f.yRange, offset) : null;
  const zr = f.zRange ? upRangeToScene(f.zRange, offset) : null;
  for (let i = 0; i < n; i++) {
    let pass = true;
    const id = ids[i];
    if (hideUnassigned && id <= 0) pass = false;
    if (pass && isolate !== null && id !== isolate && !(isolateKeepUnassigned && id <= 0)) pass = false;
    if (pass && range !== null && (id < rangeMin || id > rangeMax)) pass = false;
    if (pass && classMask !== null && classMask[cls[i]]) pass = false;
    if (pass && xr) { const v = pos[i * 3]; if (!(v >= xr[0] && v <= xr[1])) pass = false; }
    if (pass && yr) { const v = pos[i * 3 + 2]; if (!(v >= yr[0] && v <= yr[1])) pass = false; }
    if (pass && zr) {
      const v = pos[i * 3 + 1] + (ground !== null ? ground[i] : 0);
      if (!(v >= zr[0] && v <= zr[1])) pass = false;
    }
    out[i] = pass ? 1 : 0;
  }
}

// ---------- Colour helpers ----------

// Viridis-like ramp for height: distinct from the primary's forest ramp
// so overlay structure reads clearly when coloured by height.
const HEIGHT_STOPS: [number, number, number][] = [
  [0.27, 0.00, 0.33],
  [0.21, 0.36, 0.55],
  [0.13, 0.57, 0.55],
  [0.37, 0.79, 0.38],
  [0.99, 0.91, 0.14],
];
// Plasma-ish ramp for intensity — warm, sits well over a green primary.
const INTENSITY_STOPS: [number, number, number][] = [
  [0.05, 0.03, 0.20],
  [0.45, 0.05, 0.55],
  [0.85, 0.30, 0.55],
  [0.99, 0.65, 0.34],
  [1.00, 0.95, 0.55],
];

function rampSample(stops: [number, number, number][], t: number): [number, number, number] {
  const s = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(s));
  const f = s - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }

function hexToRgb(hex: string): [number, number, number] {
  return hexToRgb01(hex, [0.7, 0.7, 0.5]);
}
