// The Survey panel's geometry in the viewer: the clicked line or
// area, a profile's corridor, contour lines and the voxels a change
// detection found gone. Drawn over the cloud (no depth test) so a line on
// the ground stays visible under the canopy. The data come from the
// panel's store (components/shell/surveyStore.ts), which also holds the
// layers opened from files: meshes, trajectories and the points and lines
// of a run's files (scan positions, targets, stems, regions, voxels). The
// Height panel's scale draws here too (HeightOverlay.tsx).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { parseTrajectory, setSurveyState, surveyDesktop, surveyOverlay, useSurveyStore } from '../components/shell/surveyStore';
import { parseMesh, parsePly, shadeVertices, type MeshData } from './meshFiles';
import { groundGridOf, isElevationGrid, parseFeatures, type FeatureKind, type Features } from '../layers/fileLayers';
import { parseAsciiGrid } from '../io/asciiGrid';
import { buildSurface } from './RasterLayers';
import type { RasterGrid } from '../persistence/octreeReader';
import type { TerrainDisplay } from './terrain';
import { toSceneXYZ, writeScenePosition } from '../io/sceneAxes';
import ViewTools from './ViewTools';
import HeightOverlay from './HeightOverlay';

/** `zSpan`: the cloud's lowest and highest z (world), where a file's points
 *  without a height are drawn — a pin through the cloud. */
export default function SurveyOverlay({ offset, terrain = null, zSpan = null }: {
  offset: [number, number, number]; terrain?: TerrainDisplay | null; zSpan?: [number, number] | null;
}) {
  const { scene } = useThree();
  const s = useSurveyStore();
  const data = useMemo(() => surveyOverlay(s), [s]);
  const groupRef = useRef<THREE.Group | null>(null);
  const linesRef = useRef<THREE.LineSegments | null>(null);
  const dotsRef = useRef<THREE.Points | null>(null);

  useEffect(() => {
    const group = new THREE.Group();
    group.renderOrder = 998;
    group.visible = false;
    const lgeo = new THREE.BufferGeometry();
    const lmat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
    const lines = new THREE.LineSegments(lgeo, lmat);
    lines.frustumCulled = false;
    lines.renderOrder = 999;
    const dgeo = new THREE.BufferGeometry();
    const dmat = new THREE.PointsMaterial({ vertexColors: true, size: 7, sizeAttenuation: false, depthTest: false, transparent: true });
    const dots = new THREE.Points(dgeo, dmat);
    dots.frustumCulled = false;
    dots.renderOrder = 1000;
    group.add(lines, dots);
    scene.add(group);
    groupRef.current = group; linesRef.current = lines; dotsRef.current = dots;
    return () => {
      scene.remove(group);
      lgeo.dispose(); lmat.dispose(); dgeo.dispose(); dmat.dispose();
      groupRef.current = null; linesRef.current = null; dotsRef.current = null;
    };
  }, [scene]);

  useEffect(() => {
    const group = groupRef.current, lines = linesRef.current, dots = dotsRef.current;
    if (!group || !lines || !dots) return;
    const { segments, dots: pts } = data;
    if (segments.length === 0 && pts.length === 0) { group.visible = false; return; }
    // world → scene, as the cloud itself (o is the buffer index of a vertex · 3)
    const toScene = (p: [number, number, number], out: Float32Array, o: number) => {
      writeScenePosition(out, o / 3, p[0] - offset[0], p[1] - offset[1], p[2] - (terrain ? terrain.shift(p[0], p[1]) : 0) - offset[2]);
    };
    const col = new THREE.Color();
    const lp = new Float32Array(segments.length * 6), lc = new Float32Array(segments.length * 6);
    segments.forEach((sg, i) => {
      toScene(sg.a, lp, i * 6); toScene(sg.b, lp, i * 6 + 3);
      col.set(sg.color);
      lc.set([col.r, col.g, col.b, col.r, col.g, col.b], i * 6);
    });
    const dp = new Float32Array(pts.length * 3), dc = new Float32Array(pts.length * 3);
    pts.forEach((d, i) => {
      toScene(d.p, dp, i * 3);
      col.set(d.color);
      dc.set([col.r, col.g, col.b], i * 3);
    });
    lines.geometry.setAttribute('position', new THREE.BufferAttribute(lp, 3));
    lines.geometry.setAttribute('color', new THREE.BufferAttribute(lc, 3));
    lines.geometry.computeBoundingSphere();
    dots.geometry.setAttribute('position', new THREE.BufferAttribute(dp, 3));
    dots.geometry.setAttribute('color', new THREE.BufferAttribute(dc, 3));
    dots.geometry.computeBoundingSphere();
    group.visible = true;
  }, [data, offset, terrain]);

  return (
    <>
      <SurveyMeshes offset={offset} terrain={terrain} />
      <SurveyTrajectories offset={offset} terrain={terrain} />
      <SurveyFeatures offset={offset} terrain={terrain} zSpan={zSpan} />
      <HeightOverlay offset={offset} terrain={terrain} />
      <ViewTools />
    </>
  );
}

// ---------------------------------------------------------------------------
// meshes: made by the Survey panel or opened from a file

/** The visible meshes of the Survey panel, each read from its file once. */
export function SurveyMeshes({ offset, terrain = null }: { offset: [number, number, number]; terrain?: TerrainDisplay | null }) {
  const s = useSurveyStore();
  return (
    <>
      {s.meshes.filter((m) => m.visible).map((m) => (
        <MeshLayer key={m.id} path={m.path} color={m.color} opacity={m.opacity} offset={offset} terrain={terrain} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// trajectories: the path a mobile scanner walked (a _traj.txt)

/** The visible trajectories, drawn over the cloud like the survey lines. */
export function SurveyTrajectories({ offset, terrain = null }: { offset: [number, number, number]; terrain?: TerrainDisplay | null }) {
  const s = useSurveyStore();
  return (
    <>
      {s.trajectories.filter((t) => t.visible).map((t) => (
        <TrajectoryLayer key={t.id} path={t.path} color={t.color} offset={offset} terrain={terrain} />
      ))}
    </>
  );
}

const MAX_TRAJECTORY_BYTES = 400_000_000;

function TrajectoryLayer({ path, color, offset, terrain }: {
  path: string; color: string; offset: [number, number, number]; terrain: TerrainDisplay | null;
}) {
  const { scene } = useThree();
  const [points, setPoints] = useState<number[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = surveyDesktop();
        if (!d?.readFileRange || !d.statFile) throw new Error('reading trajectories needs the desktop build');
        const st = await d.statFile(path) as { size?: number };
        const size = st?.size ?? 0;
        if (size > MAX_TRAJECTORY_BYTES) throw new Error(`${Math.round(size / 1e6)} MB is too large to show`);
        const text = new TextDecoder().decode(await d.readFileRange(path, 0, size));
        const p = parseTrajectory(text);
        if (p.length < 6) throw new Error('no positions in it (expected `time x y z ...` per line)');
        if (alive) setPoints(p);
      } catch (e) {
        if (alive) setSurveyState({ error: `Trajectory ${path}: ${e instanceof Error ? e.message : String(e)}` });
      }
    })();
    return () => { alive = false; };
  }, [path]);

  useEffect(() => {
    if (!points) return;
    const n = points.length / 3;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
      writeScenePosition(pos, i, x - offset[0], y - offset[1], z - (terrain ? terrain.shift(x, y) : 0) - offset[2]);
    }
    const group = new THREE.Group();
    group.renderOrder = 997;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeBoundingSphere();
    const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    line.renderOrder = 997;
    // the start and the end of the walk
    const ends = new THREE.BufferGeometry();
    ends.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...pos.subarray(0, 3), ...pos.subarray((n - 1) * 3, n * 3)]), 3));
    const endMat = new THREE.PointsMaterial({ color, size: 9, sizeAttenuation: false, depthTest: false, transparent: true });
    const endDots = new THREE.Points(ends, endMat);
    endDots.frustumCulled = false;
    endDots.renderOrder = 998;
    group.add(line, endDots);
    scene.add(group);
    return () => {
      scene.remove(group);
      geo.dispose(); mat.dispose(); ends.dispose(); endMat.dispose();
    };
  }, [points, offset, terrain, color, scene]);

  return null;
}

const MAX_MESH_BYTES = 1_500_000_000;

function MeshLayer({ path, color, opacity, offset, terrain }: {
  path: string; color: string; opacity: number; offset: [number, number, number]; terrain: TerrainDisplay | null;
}) {
  const { scene } = useThree();
  const [data, setData] = useState<MeshData | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = surveyDesktop();
        if (!d?.readFileRange || !d.statFile) throw new Error('reading mesh files needs the desktop build');
        const st = await d.statFile(path) as { size?: number };
        const size = st?.size ?? 0;
        if (size > MAX_MESH_BYTES) throw new Error(`${path}: ${Math.round(size / 1e6)} MB is too large to show`);
        const buf = await d.readFileRange(path, 0, size);
        const m = parseMesh(path, buf);
        if (alive) setData(m);
      } catch (e) {
        if (alive) setSurveyState({ error: `Mesh ${path}: ${e instanceof Error ? e.message : String(e)}` });
      }
    })();
    return () => { alive = false; };
  }, [path]);

  useEffect(() => {
    if (!data) return;
    const n = data.positions.length / 3;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const x = data.positions[i * 3], y = data.positions[i * 3 + 1], z = data.positions[i * 3 + 2];
      writeScenePosition(pos, i, x - offset[0], y - offset[1], z - (terrain ? terrain.shift(x, y) : 0) - offset[2]);
    }
    const c = new THREE.Color(color);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(shadeVertices(data.positions, data.indices, [c.r, c.g, c.b], data.colors), 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: opacity < 1, opacity });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 10;
    scene.add(mesh);
    meshRef.current = mesh;
    return () => {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
      meshRef.current = null;
    };
  }, [data, offset, terrain, color, opacity, scene]);

  return null;
}

// ---------------------------------------------------------------------------
// Points and lines from a run's files

const MAX_FEATURE_BYTES = 400_000_000;
/** Points named in the view at most; more are drawn unnamed. */
const MAX_LABELS = 300;
const CIRCLE_SEGMENTS = 32;
/** Breast height: where a point without a height has its dot and circle. */
const DOT_HEIGHT = 1.3;

/** The visible feature layers: scan positions, targets, stems, regions, voxels. */
export function SurveyFeatures({ offset, terrain = null, zSpan = null }: {
  offset: [number, number, number]; terrain?: TerrainDisplay | null; zSpan?: [number, number] | null;
}) {
  const s = useSurveyStore();
  return (
    <>
      {s.features.filter((f) => f.visible).map((f) => (f.kind === 'raster'
        ? <RasterFileLayer key={f.id} path={f.path} offset={offset} terrain={terrain} zSpan={zSpan} />
        : <FeatureLayer key={f.id} path={f.path} kind={f.kind} color={f.color} offset={offset} terrain={terrain} zSpan={zSpan} />
      ))}
    </>
  );
}

/** A file's features read; a voxel file's centres as points. */
async function readFeatures(path: string, kind: FeatureKind): Promise<Features> {
  const d = surveyDesktop();
  if (!d?.readFileRange || !d.statFile) throw new Error('reading layer files needs the desktop build');
  const st = await d.statFile(path) as { size?: number };
  const size = st?.size ?? 0;
  if (size > MAX_FEATURE_BYTES) throw new Error(`${Math.round(size / 1e6)} MB is too large to show`);
  const buf = await d.readFileRange(path, 0, size);
  if (kind === 'voxels') {
    const m = parsePly(buf);
    const points = [];
    for (let i = 0; i < m.positions.length; i += 3) points.push({ x: m.positions[i], y: m.positions[i + 1], z: m.positions[i + 2] });
    return { points, lines: [], lonLat: false };
  }
  const f = parseFeatures(path, buf);
  if (f.lonLat) throw new Error("its coordinates are longitude and latitude, not the cloud's (open the CSV of the same run, or a file in map coordinates)");
  if (f.points.length === 0 && f.lines.length === 0) throw new Error('no points or lines in it');
  return f;
}

function FeatureLayer({ path, kind, color, offset, terrain, zSpan }: {
  path: string; kind: FeatureKind; color: string; offset: [number, number, number]; terrain: TerrainDisplay | null; zSpan: [number, number] | null;
}) {
  const { scene } = useThree();
  const [data, setData] = useState<Features | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const f = await readFeatures(path, kind);
        if (alive) setData(f);
      } catch (e) {
        if (alive) setSurveyState({ error: `Layer ${path}: ${e instanceof Error ? e.message : String(e)}` });
      }
    })();
    return () => { alive = false; };
  }, [path, kind]);

  const z0 = zSpan?.[0] ?? offset[2];
  const z1 = zSpan?.[1] ?? offset[2];
  // world → scene, as the cloud itself
  const scenePos = useMemo(() => (x: number, y: number, z: number): [number, number, number] =>
    toSceneXYZ(x - offset[0], y - offset[1], z - (terrain ? terrain.shift(x, y) : 0) - offset[2]), [offset, terrain]);

  useEffect(() => {
    if (!data) return;
    const seg: number[] = [];
    const push = (a: [number, number, number], b: [number, number, number]) => { seg.push(...a, ...b); };
    for (const line of data.lines) {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        push(scenePos(a[0], a[1], a[2] ?? z0), scenePos(b[0], b[1], b[2] ?? z0));
      }
    }
    const dots: number[] = [];
    for (const p of data.points) {
      // a point without a height: a pin through the cloud
      if (p.z === null) push(scenePos(p.x, p.y, z0), scenePos(p.x, p.y, z1));
      const z = p.z ?? z0 + DOT_HEIGHT;
      dots.push(...scenePos(p.x, p.y, z));
      if (p.radius) {
        for (let k = 0; k < CIRCLE_SEGMENTS; k++) {
          const a0 = (2 * Math.PI * k) / CIRCLE_SEGMENTS, a1 = (2 * Math.PI * (k + 1)) / CIRCLE_SEGMENTS;
          push(scenePos(p.x + p.radius * Math.cos(a0), p.y + p.radius * Math.sin(a0), z), scenePos(p.x + p.radius * Math.cos(a1), p.y + p.radius * Math.sin(a1), z));
        }
      }
    }
    const group = new THREE.Group();
    group.renderOrder = 996;
    const disposers: Array<() => void> = [];
    if (seg.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
      geo.computeBoundingSphere();
      const mat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
      const lines = new THREE.LineSegments(geo, mat);
      lines.frustumCulled = false;
      lines.renderOrder = 996;
      group.add(lines);
      disposers.push(() => { geo.dispose(); mat.dispose(); });
    }
    if (dots.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(dots), 3));
      geo.computeBoundingSphere();
      // voxels are many and inside the cloud: depth-tested and small; the rest on top
      const voxels = kind === 'voxels';
      const mat = new THREE.PointsMaterial({ color, size: voxels ? 3 : 8, sizeAttenuation: false, depthTest: voxels, transparent: true });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      pts.renderOrder = 997;
      group.add(pts);
      disposers.push(() => { geo.dispose(); mat.dispose(); });
    }
    scene.add(group);
    return () => { scene.remove(group); for (const d of disposers) d(); };
  }, [data, scenePos, z0, z1, color, kind, scene]);

  const labels = useMemo(() => {
    if (!data || kind === 'voxels') return [];
    const named = data.points.filter((p) => p.label);
    return named.length <= MAX_LABELS ? named : [];
  }, [data, kind]);

  return (
    <>
      {labels.map((p, i) => (
        <Html key={`${i}:${p.label}`} position={scenePos(p.x, p.y, p.z ?? z0 + DOT_HEIGHT)} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="mono" style={{ fontSize: 10, color, whiteSpace: 'nowrap', transform: 'translate(6px, -14px)', textShadow: '0 0 3px #000, 0 0 3px #000' }}>{p.label}</div>
        </Html>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// An ESRI ASCII grid from a file as a surface

async function readText(path: string): Promise<string> {
  const d = surveyDesktop();
  if (!d?.readFileRange || !d.statFile) throw new Error('reading layer files needs the desktop build');
  const st = await d.statFile(path) as { size?: number };
  const size = st?.size ?? 0;
  if (size > MAX_FEATURE_BYTES) throw new Error(`${Math.round(size / 1e6)} MB is too large to show`);
  return new TextDecoder().decode(await d.readFileRange(path, 0, size));
}

/** An elevation grid at its heights; a quantity grid (cover, PAI, …) draped
 *  on its run's ground grid when that is beside it, else at the cloud's
 *  lowest points. */
function RasterFileLayer({ path, offset, terrain, zSpan }: {
  path: string; offset: [number, number, number]; terrain: TerrainDisplay | null; zSpan: [number, number] | null;
}) {
  const { scene } = useThree();
  const [grids, setGrids] = useState<{ grid: RasterGrid; ground: RasterGrid | null } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const grid = parseAsciiGrid(await readText(path));
        if (grid.cols < 2 || grid.rows < 2) throw new Error('not a grid of at least 2 × 2 cells');
        let ground: RasterGrid | null = null;
        const g = groundGridOf(path);
        if (g) {
          try {
            const gg = parseAsciiGrid(await readText(g));
            if (gg.cols === grid.cols && gg.rows === grid.rows) ground = gg;
          } catch { /* no ground beside it: drawn at the cloud's lowest points */ }
        }
        if (alive) setGrids({ grid, ground });
      } catch (e) {
        if (alive) setSurveyState({ error: `Layer ${path}: ${e instanceof Error ? e.message : String(e)}` });
      }
    })();
    return () => { alive = false; };
  }, [path]);

  const baseZ = zSpan?.[0];
  useEffect(() => {
    if (!grids) return;
    const elevation = isElevationGrid(path);
    const mesh = buildSurface(grids.grid, elevation ? 'dtm' : 'grid', offset, 0.85, false, elevation ? null : grids.ground, terrain, baseZ);
    if (!mesh) return;
    mesh.renderOrder = 2;
    scene.add(mesh);
    return () => {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    };
  }, [grids, path, offset, terrain, baseZ, scene]);

  return null;
}
