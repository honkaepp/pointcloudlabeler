// The Height tool in the viewer: the scale standing on the lower
// of the two clicked points, its ticks and rings, the line between the
// points and their labels, from components/shell/heightStore.ts. Drawn over
// the cloud (no depth test), as the Survey lines, so the scale stays in
// sight inside a crown.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { heightOverlay, useHeightStore, type HeightOverlayData } from '../components/shell/heightStore';
import type { TerrainDisplay } from './terrain';
import { toSceneXYZ, writeScenePosition } from '../io/sceneAxes';

const NOTHING: HeightOverlayData = { segments: [], dots: [], labels: [], labelOffset: 0 };
/** The screen's right is followed in steps of this much (rad): labels move
 *  with the view without a render every frame. */
const TURN = Math.PI / 18;

export default function HeightOverlay({ offset, terrain = null }: { offset: [number, number, number]; terrain?: TerrainDisplay | null }) {
  const { scene, camera, invalidate } = useThree();
  const s = useHeightStore();
  const data = useMemo(() => (s.open ? heightOverlay(s) : NOTHING), [s]);
  // the screen's right as a world bearing (east = 0, north = π/2): the
  // camera's x axis in the scene (east, up, −north)
  const [right, setRight] = useState(0);
  const rightRef = useRef(0);
  useFrame(() => {
    if (data.labels.length === 0) return;
    const e = camera.matrixWorld.elements;
    const a = Math.round(Math.atan2(-e[2], e[0]) / TURN) * TURN;
    if (a !== rightRef.current) { rightRef.current = a; setRight(a); }
  });
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
    const dmat = new THREE.PointsMaterial({ vertexColors: true, size: 9, sizeAttenuation: false, depthTest: false, transparent: true });
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

  // world → scene, as the cloud itself (with its terrain while heights are shown above ground)
  const shift = useMemo(() => (x: number, y: number) => (terrain ? terrain.shift(x, y) : 0), [terrain]);

  useEffect(() => {
    const group = groupRef.current, lines = linesRef.current, dots = dotsRef.current;
    if (!group || !lines || !dots) return;
    const { segments, dots: pts } = data;
    if (segments.length === 0 && pts.length === 0) { group.visible = false; invalidate(); return; }
    const toScene = (p: [number, number, number], out: Float32Array, i: number) => {
      writeScenePosition(out, i, p[0] - offset[0], p[1] - offset[1], p[2] - shift(p[0], p[1]) - offset[2]);
    };
    const col = new THREE.Color();
    const lp = new Float32Array(segments.length * 6), lc = new Float32Array(segments.length * 6);
    segments.forEach((sg, i) => {
      toScene(sg.a, lp, i * 2); toScene(sg.b, lp, i * 2 + 1);
      col.set(sg.color);
      lc.set([col.r, col.g, col.b, col.r, col.g, col.b], i * 6);
    });
    const dp = new Float32Array(pts.length * 3), dc = new Float32Array(pts.length * 3);
    pts.forEach((d, i) => {
      toScene(d.p, dp, i);
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
    invalidate();
  }, [data, offset, shift, invalidate]);

  return (
    <>
      {data.labels.map((l, i) => {
        // out from the axis: the lines' labels to the screen's right, the height to its left
        const d = (l.strong ? -1 : 1) * data.labelOffset;
        const x = l.p[0] + d * Math.cos(right), y = l.p[1] + d * Math.sin(right);
        return (
        <Html key={`${i}:${l.text}`} position={toSceneXYZ(x - offset[0], y - offset[1], l.p[2] - shift(l.p[0], l.p[1]) - offset[2])}
          zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
          <div className="mono" style={{
            fontSize: l.strong ? 12 : 10, fontWeight: l.strong ? 700 : 500, color: l.color, whiteSpace: 'nowrap',
            transform: l.strong ? 'translate(calc(-100% - 6px), -50%)' : 'translate(6px, -50%)',
            textShadow: '0 0 3px #000, 0 0 3px #000, 0 0 2px #000',
            ...(l.strong ? { padding: '2px 7px', borderRadius: 6, background: 'rgba(10,16,12,0.85)', border: `1px solid ${l.color}` } : {}),
          }}>
            {l.text}
            {l.sub && <div style={{ fontSize: 9.5, fontWeight: 500, color: '#e8d9a0' }}>{l.sub}</div>}
          </div>
        </Html>
        );
      })}
    </>
  );
}
