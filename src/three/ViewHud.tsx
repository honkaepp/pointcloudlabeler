// What a measuring view shows in its corner: a north arrow, a
// scale bar and the projection (perspective / parallel).
//
// The scale bar is exact everywhere in a parallel view and holds at the orbit
// target in a perspective one (it says so). The north arrow points to grid
// north as the view sees it: the scene's −z (io/sceneAxes) projected onto the
// screen, or, looking straight along north, the camera's heading.
//
// It reads the camera every animation frame and writes the DOM directly, so
// the viewer does not re-render with every camera move.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { isOrtho, unitsPerPixel } from './viewCamera';

/** The longest the bar may be, in CSS pixels. */
const MAX_BAR_PX = 120;

/** The largest 1 / 2 / 5 × 10ⁿ length no longer than `max` (world units). */
export function niceLength(max: number): number {
  if (!(max > 0) || !Number.isFinite(max)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(max)));
  for (const m of [5, 2, 1]) if (m * p <= max) return m * p;
  return p;
}

export function formatLength(m: number): string {
  if (m >= 1000) return `${+(m / 1000).toPrecision(3)} km`;
  if (m >= 1) return `${+m.toPrecision(3)} m`;
  if (m >= 0.01) return `${+(m * 100).toPrecision(3)} cm`;
  return `${+(m * 1000).toPrecision(3)} mm`;
}

/** The screen angle (radians, clockwise from up) north points to, or null
 *  when the view looks along north and the screen has no north. `aspect`:
 *  the view's width over its height (normalised x and y differ in scale). */
export function northAngle(cam: THREE.Camera, target: THREE.Vector3, aspect = 1): number | null {
  const a = target.clone().project(cam);
  const b = target.clone().add(new THREE.Vector3(0, 0, -1)).project(cam);
  const dx = (b.x - a.x) * aspect;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  return Math.atan2(dx, dy);
}

export default function ViewHud({ orbitRef, projection, onProjection }: {
  orbitRef: React.RefObject<OrbitControlsImpl | null>;
  projection: 'perspective' | 'ortho';
  onProjection?: (p: 'perspective' | 'ortho') => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const arrow = useRef<SVGGElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    let lastAngle = NaN, lastBar = NaN, lastText = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const ctl = orbitRef.current;
      const el = root.current?.parentElement;
      if (!ctl || !el) return;
      const cam = ctl.object as THREE.PerspectiveCamera;
      const target = ctl.target;
      const angle = northAngle(cam, target, el.clientWidth / Math.max(1, el.clientHeight));
      const deg = angle === null ? 0 : (angle * 180) / Math.PI;
      if (arrow.current && Math.abs(deg - lastAngle) > 0.2) {
        arrow.current.setAttribute('transform', `rotate(${deg.toFixed(1)} 16 16)`);
        arrow.current.style.opacity = angle === null ? '0.35' : '1';
        lastAngle = deg;
      }
      const upp = unitsPerPixel(cam, target, el.clientHeight);
      const len = niceLength(upp * MAX_BAR_PX);
      const px = len / upp;
      if (bar.current && Math.abs(px - lastBar) > 0.5) {
        bar.current.style.width = `${px.toFixed(1)}px`;
        lastBar = px;
      }
      const text = `${isOrtho(cam) ? '' : '≈ '}${formatLength(len)}`;
      if (label.current && text !== lastText) {
        label.current.textContent = text;
        lastText = text;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [orbitRef]);

  const ortho = projection === 'ortho';
  return (
    // Beside the orientation gizmo (AxisGizmo: 76 px at right 14, bottom 36).
    <div ref={root} className="absolute z-10 flex items-end gap-3 pointer-events-none select-none"
      style={{ right: 100, bottom: 38 }}>
      <div className="flex flex-col items-end gap-1"
        title={ortho ? 'Scale of the parallel view: the same everywhere in it' : 'Scale at the orbit target; nearer things are larger, farther smaller (switch to Parallel for a true scale)'}>
        <span ref={label} className="mono text-[10px]" style={{ color: 'var(--text)', textShadow: '0 1px 2px rgba(0,0,0,0.8)' }} />
        <div ref={bar} style={{ height: 6, borderLeft: '2px solid var(--text)', borderRight: '2px solid var(--text)', borderBottom: '2px solid var(--text)', filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.8))' }} />
      </div>
      <svg width="32" height="32" viewBox="0 0 32 32" aria-label="North" style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.8))' }}>
        <title>Grid north</title>
        <g ref={arrow}>
          <path d="M16 3 L21 17 L16 14 L11 17 Z" fill="var(--accent)" />
          <path d="M16 29 L21 17 L16 20 L11 17 Z" fill="var(--text-mute)" opacity="0.6" />
          <text x="16" y="12.5" textAnchor="middle" fontSize="6" fontFamily="monospace" fill="#06140d">N</text>
        </g>
      </svg>
      {onProjection && (
        <div className="flex rounded-md overflow-hidden pointer-events-auto" style={{ border: '1px solid var(--line-strong)', background: 'rgba(8,14,11,0.82)' }}>
          {(['perspective', 'ortho'] as const).map((p) => (
            <button key={p} onClick={() => onProjection(p)}
              title={p === 'ortho' ? 'Parallel (orthographic) projection: true scale everywhere — profiles, sections, measuring (5)' : 'Perspective projection (5)'}
              className="mono text-[10px] px-2 py-1"
              style={{ background: projection === p ? 'color-mix(in oklch, var(--accent) 22%, transparent)' : 'transparent', color: projection === p ? 'var(--accent)' : 'var(--text-dim)', border: 'none', cursor: 'pointer' }}>
              {p === 'ortho' ? 'Parallel' : 'Persp'}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
