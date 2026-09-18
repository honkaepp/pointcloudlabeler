// SVG histogram with proper tick marks, gridlines, axis labels, and a
// hover tooltip that surfaces the actual bin value. Zero-dependency.

import { useMemo, useState } from 'react';
import { niceTicks, formatTick } from './chart/ticks';
import { mean as statMean, median as statMedian } from '../metrics/stats';

interface Props {
  values: number[];
  /** Unit shown after axis numbers (e.g. 'cm', 'm³'). */
  unit: string;
  /** Title shown above the chart. */
  title: string;
  /** Axis label for the data being binned (e.g. 'DBH'). */
  xLabel?: string;
  /** Number of bins. Defaults to ~ √n bounded to [8, 40]. */
  bins?: number;
  /** Clamp X range. Auto-computed from data when omitted. */
  range?: [number, number];
  width?: number;
  height?: number;
  color?: string;
}

interface BinHover { ix: number; lo: number; hi: number; count: number; cx: number; cy: number }

export default function MetricHistogram({
  values, unit, title, xLabel, bins, range, width = 360, height = 240, color = 'var(--accent)',
}: Props) {
  const finite = useMemo(() => values.filter(v => Number.isFinite(v)), [values]);
  const [hover, setHover] = useState<BinHover | null>(null);

  if (finite.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <div className="mono text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-mute)' }}>{title}</div>
        <div className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>no data</div>
      </div>
    );
  }
  const lo = range ? range[0] : Math.min(...finite);
  const hi = range ? range[1] : Math.max(...finite);
  const span = Math.max(1e-9, hi - lo);
  const binCount = bins ?? Math.max(8, Math.min(40, Math.ceil(Math.sqrt(finite.length))));
  const counts = new Array(binCount).fill(0);
  for (const v of finite) {
    let idx = Math.floor(((v - lo) / span) * binCount);
    if (idx === binCount) idx = binCount - 1;
    if (idx >= 0 && idx < binCount) counts[idx]++;
  }
  const maxCount = Math.max(1, ...counts);
  const xTicks = niceTicks(lo, hi, 6);
  const yTicks = niceTicks(0, maxCount, 4);

  const padL = 46, padR = 12, padT = 14, padB = 38;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const xScale = (v: number) => padL + ((v - lo) / span) * innerW;
  const yScale = (c: number) => padT + innerH - (c / Math.max(1, yTicks.hi || maxCount)) * innerH;
  const barW = innerW / binCount;

  const mean = statMean(finite);
  const median = statMedian(finite);

  return (
    <div className="flex flex-col gap-1 relative">
      <div className="flex items-baseline justify-between">
        <div className="mono text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-mute)' }}>{title}</div>
        <div className="mono text-[10px] tnum" style={{ color: 'var(--text-mute)' }}>
          n={finite.length} · μ={formatTick(mean)} · med={formatTick(median)} {unit}
        </div>
      </div>
      <svg width={width} height={height} role="img" aria-label={title} onMouseLeave={() => setHover(null)}>
        {/* Y grid lines */}
        {yTicks.ticks.map(t => (
          <line
            key={`y-${t}`}
            x1={padL} x2={padL + innerW}
            y1={yScale(t)} y2={yScale(t)}
            stroke="var(--line)"
            strokeOpacity={t === 0 ? 0.9 : 0.18}
          />
        ))}
        {/* Y tick labels */}
        {yTicks.ticks.map(t => (
          <text
            key={`yl-${t}`}
            x={padL - 6} y={yScale(t) + 3}
            fontSize={10}
            fill="var(--text-mute)"
            textAnchor="end"
            className="mono tnum"
          >
            {formatTick(t)}
          </text>
        ))}
        {/* Bars */}
        {counts.map((c, i) => {
          const binLo = lo + (i / binCount) * span;
          const binHi = lo + ((i + 1) / binCount) * span;
          const y = yScale(c);
          const x = padL + i * barW;
          const h = padT + innerH - y;
          return (
            <rect
              key={i}
              x={x + 0.5}
              y={y}
              width={Math.max(0.5, barW - 1)}
              height={Math.max(0, h)}
              fill={color}
              fillOpacity={hover && hover.ix === i ? 1 : 0.78}
              onMouseEnter={() => setHover({ ix: i, lo: binLo, hi: binHi, count: c, cx: x + barW / 2, cy: y })}
            />
          );
        })}
        {/* X axis line */}
        <line x1={padL} x2={padL + innerW} y1={padT + innerH} y2={padT + innerH} stroke="var(--line-strong)" />
        {/* X ticks */}
        {xTicks.ticks.filter(t => t >= lo - 1e-9 && t <= hi + 1e-9).map(t => (
          <g key={`xt-${t}`}>
            <line
              x1={xScale(t)} x2={xScale(t)}
              y1={padT + innerH} y2={padT + innerH + 4}
              stroke="var(--text-mute)"
            />
            <text
              x={xScale(t)} y={padT + innerH + 16}
              fontSize={10}
              fill="var(--text-mute)"
              textAnchor="middle"
              className="mono tnum"
            >
              {formatTick(t)}
            </text>
          </g>
        ))}
        {/* Axis labels */}
        <text
          x={padL + innerW / 2}
          y={height - 4}
          fontSize={10.5}
          fill="var(--text-dim)"
          textAnchor="middle"
        >
          {xLabel ? `${xLabel} (${unit})` : unit}
        </text>
        <text
          x={12}
          y={padT + innerH / 2}
          fontSize={10.5}
          fill="var(--text-dim)"
          textAnchor="middle"
          transform={`rotate(-90, 12, ${padT + innerH / 2})`}
        >
          count
        </text>
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute panel rounded-sm px-2 py-1 mono text-[10.5px] tnum"
          style={{
            left: Math.min(width - 130, Math.max(0, hover.cx)),
            top: Math.max(0, hover.cy - 38),
            background: 'rgba(10,17,13,0.94)',
            border: '1px solid var(--line-strong)',
            color: 'var(--text)',
            whiteSpace: 'nowrap',
          }}
        >
          {formatTick(hover.lo)}–{formatTick(hover.hi)} {unit} · n={hover.count}
        </div>
      )}
    </div>
  );
}
