// Orientation gizmo for the bottom-right of the editor — a small XYZ axis
// cross that rotates with the camera, the way CloudCompare's does. It
// shows the DATA axes (X = east, Y = north, Z = up) rather than the raw
// Three.js scene axes, so the labels read the way a forester expects even
// though the scene itself is Y-up (sceneZ = −north).
//
// Two pieces share one ref to stay cheap: an in-Canvas updater writes the
// three axes' view-space directions every frame; a DOM/SVG overlay reads
// that ref on its own rAF loop and nudges line + label positions without
// triggering React re-renders.

import { useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

export interface GizmoDirs {
  // Each entry is the axis direction in camera/view space (x right, y up,
  // z toward the viewer). The overlay turns these into 2D screen lines.
  x: [number, number, number];
  y: [number, number, number];
  z: [number, number, number];
}

// Data axes expressed in SCENE space (sceneX = east, sceneY = up,
// sceneZ = −north): X east = +sceneX, Y north = −sceneZ, Z up = +sceneY.
const SCENE_AXES: { key: keyof GizmoDirs; vec: THREE.Vector3; color: string; label: string }[] = [
  { key: 'x', vec: new THREE.Vector3(1, 0, 0),  color: '#e0506b', label: 'X' }, // east
  { key: 'y', vec: new THREE.Vector3(0, 0, -1), color: '#6ad06a', label: 'Y' }, // north
  { key: 'z', vec: new THREE.Vector3(0, 1, 0),  color: '#5a9cf0', label: 'Z' }, // up
];

/** In-Canvas: refresh the shared dirs ref from the live camera each frame. */
export function AxisGizmoUpdater({ dirsRef }: { dirsRef: React.MutableRefObject<GizmoDirs> }) {
  const { camera } = useThree();
  const tmp = useRef(new THREE.Vector3()).current;
  useFrame(() => {
    const d = dirsRef.current;
    for (const a of SCENE_AXES) {
      tmp.copy(a.vec).transformDirection(camera.matrixWorldInverse);
      d[a.key][0] = tmp.x; d[a.key][1] = tmp.y; d[a.key][2] = tmp.z;
    }
  });
  return null;
}

const BOX = 76;      // overlay size (px)
const C = BOX / 2;   // centre
const L = 26;        // axis length (px)

/** DOM overlay: draws the three axes from the shared ref on a self-driven
 *  rAF loop. Pointer-transparent so it never blocks the orbit controls. */
export function AxisGizmoOverlay({ dirsRef }: { dirsRef: React.MutableRefObject<GizmoDirs> }) {
  const rootRef = useRef<SVGSVGElement | null>(null);
  // Per-axis element refs (positive + negative ends) so the rAF loop can
  // mutate attributes directly. Both ends are drawn so the cross reads as
  // a full set of axes; only the positive end carries the letter label.
  const refs = useRef<Record<keyof GizmoDirs, {
    line: SVGLineElement | null;
    disc: SVGCircleElement | null;
    text: SVGTextElement | null;
  }>>({
    x: { line: null, disc: null, text: null },
    y: { line: null, disc: null, text: null },
    z: { line: null, disc: null, text: null },
  });

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const d = dirsRef.current;
      for (const a of SCENE_AXES) {
        const r = refs.current[a.key];
        if (!r.line || !r.disc || !r.text) continue;
        const v = d[a.key];
        // Screen direction: x right, y up → SVG y is down so negate.
        const ex = C + v[0] * L;
        const ey = C - v[1] * L;
        // Depth toward viewer (v[2] > 0) → fully opaque + drawn on top;
        // pointing away → dimmer. Maps [-1,1] → [0.35, 1].
        const op = 0.35 + 0.65 * (v[2] * 0.5 + 0.5);
        r.line.setAttribute('x2', ex.toFixed(1));
        r.line.setAttribute('y2', ey.toFixed(1));
        r.line.setAttribute('opacity', op.toFixed(2));
        r.disc.setAttribute('cx', ex.toFixed(1));
        r.disc.setAttribute('cy', ey.toFixed(1));
        r.disc.setAttribute('opacity', op.toFixed(2));
        r.text.setAttribute('x', ex.toFixed(1));
        r.text.setAttribute('y', (ey + 3.2).toFixed(1));
        r.text.setAttribute('opacity', op.toFixed(2));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dirsRef]);

  return (
    <div
      className="absolute pointer-events-none select-none"
      style={{ right: 14, bottom: 36, width: BOX, height: BOX, zIndex: 20 }}
      aria-hidden="true"
      title="Orientation — X east · Y north · Z up"
    >
      <svg ref={rootRef} width={BOX} height={BOX} viewBox={`0 0 ${BOX} ${BOX}`}>
        {/* Soft backdrop disc so the cross reads over any cloud colour. */}
        <circle cx={C} cy={C} r={C - 2} fill="rgba(8,14,11,0.55)" stroke="rgba(255,255,255,0.10)" strokeWidth="1" />
        {SCENE_AXES.map(a => (
          <g key={a.key}>
            <line
              ref={(el) => { refs.current[a.key].line = el; }}
              x1={C} y1={C} x2={C} y2={C}
              stroke={a.color} strokeWidth="2" strokeLinecap="round"
            />
            <circle
              ref={(el) => { refs.current[a.key].disc = el; }}
              cx={C} cy={C} r="7" fill={a.color}
            />
            <text
              ref={(el) => { refs.current[a.key].text = el; }}
              x={C} y={C} textAnchor="middle"
              fontSize="9" fontWeight="700" fill="#06140d"
              style={{ fontFamily: 'ui-monospace, monospace' }}
            >{a.label}</text>
          </g>
        ))}
        {/* Centre hub. */}
        <circle cx={C} cy={C} r="2.5" fill="rgba(255,255,255,0.6)" />
      </svg>
    </div>
  );
}
