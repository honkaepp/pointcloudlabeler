// SVG scatter for paired per-tree metrics — DBH × height in the
// Inventory module is the canonical use case. Carries tick marks,
// gridlines, axis labels, hover tooltip + an OLS regression line
// with R² in the footer so users can read allometry tightness off
// the chart at a glance.

import { useMemo, useState } from 'react';
import { niceTicks, formatTick, linearRegression } from './chart/ticks';

interface Props {
  xs: number[];
  ys: number[];
  xUnit: string;
  yUnit: string;
  title: string;
  xLabel?: string;
  yLabel?: string;
  width?: number;
  height?: number;
  color?: string;
  /** Show OLS regression line + R² when ≥ this many points are paired.
   *  Default 5; below that the line is more confidence in noise than signal. */
  regressionMinN?: number;
}

interface DotHover { i: number; x: number; y: number; cx: number; cy: number }

export default function MetricScatter({
  xs, ys, xUnit, yUnit, title, xLabel, yLabel,
  width = 360, height = 260, color = 'var(--accent)', regressionMinN = 5,
}: Props) {
  const n = Math.min(xs.length, ys.length);
  const [hover, setHover] = useState<DotHover | null>(null);

  const stats = useMemo(() => {
    if (n === 0) return null;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xs[i] < xMin) xMin = xs[i]; if (xs[i] > xMax) xMax = xs[i];
      if (ys[i] < yMin) yMin = ys[i]; if (ys[i] > yMax) yMax = ys[i];
    }
    const xt = niceTicks(xMin, xMax, 6);
    const yt = niceTicks(yMin, yMax, 5);
    const fit = n >= regressionMinN ? linearRegression(xs.slice(0, n), ys.slice(0, n)) : null;
    return { xMin, xMax, yMin, yMax, xTicks: xt, yTicks: yt, fit };
  }, [xs, ys, n, regressionMinN]);

  if (!stats || n === 0) {
    return (
      <div className="flex flex-col gap-1">
        <div className="mono text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-mute)' }}>{title}</div>
        <div className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>no paired data</div>
      </div>
    );
  }
  const { xMin, xMax, yMin, yMax, xTicks, yTicks, fit } = stats;
  // Use nice-tick bounds so axes land on round numbers; clamp dots within
  // the original data span to avoid empty whitespace on heavily-skewed data.
  const xLo = Math.min(xMin, xTicks.lo), xHi = Math.max(xMax, xTicks.hi);
  const yLo = Math.min(yMin, yTicks.lo), yHi = Math.max(yMax, yTicks.hi);
  const xSpan = Math.max(1e-9, xHi - xLo);
  const ySpan = Math.max(1e-9, yHi - yLo);

  const padL = 50, padR = 14, padT = 14, padB = 40;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const xScale = (v: number) => padL + ((v - xLo) / xSpan) * innerW;
  const yScale = (v: number) => padT + innerH - ((v - yLo) / ySpan) * innerH;

  // Dot opacity scales with crowding — solo points pop, dense clusters
  // fade in proportion to local count so overlap reads as density.
  const dotOpacity = Math.max(0.18, Math.min(0.72, 14 / Math.sqrt(n)));

  return (
    <div className="flex flex-col gap-1 relative">
      <div className="flex items-baseline justify-between">
        <div className="mono text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-mute)' }}>{title}</div>
        <div className="mono text-[10px] tnum" style={{ color: 'var(--text-mute)' }}>
          n={n}
          {fit && <> · r={fit.r.toFixed(2)} · R²={fit.r2.toFixed(2)} · slope={fit.slope.toFixed(3)}</>}
        </div>
      </div>
      <svg width={width} height={height} role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
        {/* Y grid + ticks */}
        {yTicks.ticks.filter(t => t >= yLo - 1e-9 && t <= yHi + 1e-9).map(t => (
          <g key={`y-${t}`}>
            <line x1={padL} x2={padL + innerW} y1={yScale(t)} y2={yScale(t)} stroke="var(--line)" strokeOpacity={0.18} />
            <text x={padL - 6} y={yScale(t) + 3} fontSize={10} fill="var(--text-mute)" textAnchor="end" className="mono tnum">{formatTick(t)}</text>
          </g>
        ))}
        {/* X grid + ticks */}
        {xTicks.ticks.filter(t => t >= xLo - 1e-9 && t <= xHi + 1e-9).map(t => (
          <g key={`x-${t}`}>
            <line x1={xScale(t)} x2={xScale(t)} y1={padT} y2={padT + innerH} stroke="var(--line)" strokeOpacity={0.18} />
            <line x1={xScale(t)} x2={xScale(t)} y1={padT + innerH} y2={padT + innerH + 4} stroke="var(--text-mute)" />
            <text x={xScale(t)} y={padT + innerH + 16} fontSize={10} fill="var(--text-mute)" textAnchor="middle" className="mono tnum">{formatTick(t)}</text>
          </g>
        ))}
        {/* Axes */}
        <line x1={padL} x2={padL} y1={padT} y2={padT + innerH} stroke="var(--line-strong)" />
        <line x1={padL} x2={padL + innerW} y1={padT + innerH} y2={padT + innerH} stroke="var(--line-strong)" />
        {/* OLS regression line (clip to data x-range). */}
        {fit && (() => {
          const yAtXmin = fit.slope * xMin + fit.intercept;
          const yAtXmax = fit.slope * xMax + fit.intercept;
          return (
            <line
              x1={xScale(xMin)} y1={yScale(yAtXmin)}
              x2={xScale(xMax)} y2={yScale(yAtXmax)}
              stroke="#ffb703"
              strokeWidth={1.5}
              strokeOpacity={0.85}
              strokeDasharray="4 3"
            />
          );
        })()}
        {/* Dots */}
        {Array.from({ length: n }, (_, i) => {
          const cx = xScale(xs[i]);
          const cy = yScale(ys[i]);
          const isHover = hover?.i === i;
          return (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={isHover ? 4 : 2.8}
              fill={color}
              fillOpacity={isHover ? 1 : dotOpacity}
              stroke={isHover ? 'var(--text)' : 'none'}
              strokeWidth={isHover ? 1 : 0}
              onMouseEnter={() => setHover({ i, x: xs[i], y: ys[i], cx, cy })}
            />
          );
        })}
        {/* Axis labels */}
        <text
          x={padL + innerW / 2}
          y={height - 6}
          fontSize={10.5}
          fill="var(--text-dim)"
          textAnchor="middle"
        >
          {xLabel ? `${xLabel} (${xUnit})` : xUnit}
        </text>
        <text
          x={14}
          y={padT + innerH / 2}
          fontSize={10.5}
          fill="var(--text-dim)"
          textAnchor="middle"
          transform={`rotate(-90, 14, ${padT + innerH / 2})`}
        >
          {yLabel ? `${yLabel} (${yUnit})` : yUnit}
        </text>
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute panel rounded-sm px-2 py-1 mono text-[10.5px] tnum"
          style={{
            left: Math.min(width - 140, Math.max(0, hover.cx + 6)),
            top: Math.max(0, hover.cy - 32),
            background: 'rgba(10,17,13,0.94)',
            border: '1px solid var(--line-strong)',
            color: 'var(--text)',
            whiteSpace: 'nowrap',
          }}
        >
          {formatTick(hover.x)} {xUnit} · {formatTick(hover.y)} {yUnit}
        </div>
      )}
    </div>
  );
}
