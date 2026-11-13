// The stems of the forest pass in the viewer, for the seed
// editor: a line up each stem's axis to the top of what it claims and a
// ring at breast height; green where circles were fitted, amber where the
// flow alone found it, blue where the user put it, pink for the stem picked
// and the others of its tree. Drawn over the cloud (no depth test) so a
// stem stays visible inside the crowns. The data come from forestStore.

import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { seedGeometry, useForestStore } from '../components/shell/forestStore';
import type { TerrainDisplay } from './terrain';
import { writeScenePosition } from '../io/sceneAxes';

export default function ForestOverlay({ offset, terrain = null }: { offset: [number, number, number]; terrain?: TerrainDisplay | null }) {
  const { scene } = useThree();
  const s = useForestStore();
  // the stem review draws the circles themselves, to read the diameter off
  const exact = s.review !== null;
  const data = useMemo(() => (s.visible && s.seeds ? seedGeometry(s.seeds, s.selected, exact) : null), [s.visible, s.seeds, s.selected, exact]);
  const linesRef = useRef<THREE.LineSegments | null>(null);

  useEffect(() => {
    const geo = new THREE.BufferGeometry();
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    lines.renderOrder = 999;
    lines.visible = false;
    scene.add(lines);
    linesRef.current = lines;
    return () => { scene.remove(lines); geo.dispose(); mat.dispose(); linesRef.current = null; };
  }, [scene]);

  useEffect(() => {
    const lines = linesRef.current;
    if (!lines) return;
    if (!data || data.segments.length === 0) { lines.visible = false; return; }
    const segs = data.segments;
    const pos = new Float32Array(segs.length * 6), col = new Float32Array(segs.length * 6);
    const c = new THREE.Color();
    const put = (p: [number, number, number], v: number) =>
      writeScenePosition(pos, v, p[0] - offset[0], p[1] - offset[1], p[2] - (terrain ? terrain.shift(p[0], p[1]) : 0) - offset[2]);
    segs.forEach((sg, i) => {
      put(sg.a, i * 2); put(sg.b, i * 2 + 1);
      c.set(sg.color);
      col.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
    });
    lines.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    lines.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    lines.geometry.computeBoundingSphere();
    lines.visible = true;
  }, [data, offset, terrain]);

  return null;
}
