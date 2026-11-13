// The cross-section the Branches panel reads a diameter from, drawn
// looking along the branch: the section's points, the circle fit
// (dashed, for comparison), and the caliper jaws of each reading. A jaw
// can be dragged, the way a caliper is closed by hand onto the bark
// when the outermost points are stray returns rather than wood.

import { useCallback, useMemo, useRef } from 'react';
import type { CircleFit } from '../../metrics/branchMeasure';
import { JAW1_COLOR, JAW2_COLOR, type JawPair } from './branchOverlay';

interface Props {
  /** Section points as (u, v) pairs, metres from the section centre. */
  pts: Float64Array;
  jaws: JawPair[];
  circle: CircleFit | null;
  /** A jaw was dragged to `t` (metres along its reading). */
  onJawDrag: (pair: number, which: 'lo' | 'hi', t: number) => void;
  size?: number;
}

const NICE_MM = [1, 2, 5, 10, 20, 50, 100, 200];

export default function BranchSectionView({ pts, jaws, circle, onJawDrag, size = 300 }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ pair: number; which: 'lo' | 'hi' } | null>(null);

  const { k, R } = useMemo(() => {
    let r = 0.005;
    for (let i = 0; i < pts.length; i += 2) r = Math.max(r, Math.abs(pts[i]), Math.abs(pts[i + 1]));
    for (const j of jaws) r = Math.max(r, Math.abs(j.lo), Math.abs(j.hi));
    r *= 1.2;
    return { R: r, k: (size / 2 - 10) / r };
  }, [pts, jaws, size]);
  const half = size / 2;
  const X = (a: number) => half + a * k;
  const Y = (b: number) => half - b * k;

  const toSection = useCallback((e: React.PointerEvent): [number, number] | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * size;
    const py = ((e.clientY - r.top) / r.height) * size;
    return [(px - half) / k, -(py - half) / k];
  }, [half, k, size]);

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toSection(e);
    if (!p) return;
    const j = jaws[d.pair];
    onJawDrag(d.pair, d.which, p[0] * Math.cos(j.theta) + p[1] * Math.sin(j.theta));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (drag.current) (e.target as Element).releasePointerCapture?.(e.pointerId);
    drag.current = null;
  };

  const scaleMm = useMemo(() => {
    const target = (R * 1000) / 2;
    let best = NICE_MM[0];
    for (const m of NICE_MM) if (m <= target) best = m;
    return best;
  }, [R]);

  const dots = useMemo(() => {
    const out: JSX.Element[] = [];
    for (let i = 0; i < pts.length; i += 2) {
      out.push(<circle key={i} cx={X(pts[i])} cy={Y(pts[i + 1])} r={1.6} fill="var(--text-dim)" />);
    }
    return out;
    // X / Y follow k and half, which the memo already depends on through R.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, k, half]);

  return (
    <svg
      ref={svgRef}
      width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      style={{ background: 'var(--wash-1)', border: '1px solid var(--line)', borderRadius: 6, touchAction: 'none', maxWidth: '100%' }}
      onPointerMove={onMove} onPointerUp={endDrag} onPointerCancel={endDrag}
    >
      {/* Crosshair on the branch axis. */}
      <line x1={half - 6} y1={half} x2={half + 6} y2={half} stroke="var(--line)" />
      <line x1={half} y1={half - 6} x2={half} y2={half + 6} stroke="var(--line)" />
      {dots}
      {circle && (
        <circle cx={X(circle.cu)} cy={Y(circle.cv)} r={circle.r * k} fill="none"
          stroke="var(--text-mute)" strokeDasharray="4 3" strokeWidth={1} />
      )}
      {jaws.map((j, pair) => {
        const c = Math.cos(j.theta), s = Math.sin(j.theta);
        const color = pair === 0 ? JAW1_COLOR : JAW2_COLOR;
        const L = R * 1.5;
        return (
          <g key={pair}>
            <line x1={X(c * j.lo)} y1={Y(s * j.lo)} x2={X(c * j.hi)} y2={Y(s * j.hi)} stroke={color} strokeWidth={1} strokeDasharray="2 2" />
            {(['lo', 'hi'] as const).map(which => {
              const t = which === 'lo' ? j.lo : j.hi;
              const x1 = X(c * t - s * L), y1 = Y(s * t + c * L);
              const x2 = X(c * t + s * L), y2 = Y(s * t - c * L);
              return (
                <g key={which}>
                  <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={2} />
                  <line
                    x1={x1} y1={y1} x2={x2} y2={y2} stroke="transparent" strokeWidth={12}
                    style={{ cursor: 'grab' }}
                    onPointerDown={(e) => {
                      drag.current = { pair, which };
                      (e.target as Element).setPointerCapture?.(e.pointerId);
                      e.preventDefault();
                    }}
                  />
                </g>
              );
            })}
          </g>
        );
      })}
      {/* Scale bar. */}
      <line x1={10} y1={size - 12} x2={10 + (scaleMm / 1000) * k} y2={size - 12} stroke="var(--text)" strokeWidth={2} />
      <text x={10} y={size - 17} fontSize={10} fill="var(--text-dim)" className="mono">{scaleMm} mm</text>
    </svg>
  );
}
