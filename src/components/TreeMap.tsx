// Top-down tree map for an active cloud. One dot per tree at its
// (baseX, baseY) world coords, sized by DBH and coloured by either
// DBH or species. Plot polygons overlay so spatial-join sanity checks
// are immediate. Lives next to the histograms / scatter in Inventory.
//
// Pure SVG (matches the rest of the Inventory charts), so there's no
// new dependency and no canvas/raster surprises with the panel layout.

import { useMemo, useState } from 'react';
import { niceTicks, formatTick } from './chart/ticks';
import { wktToPolygon, type PlotRow } from '../persistence/plotsStore';

export interface TreeMapEntry {
  treeId: number;
  baseX: number | null;
  baseY: number | null;
  dbh: number | null;          // cm
  species: string | null;
  height: number | null;        // m
}

interface Props {
  trees: TreeMapEntry[];
  plots: PlotRow[];
  title?: string;
  width?: number;
  height?: number;
  /** Colour mode. 'dbh' = continuous accent ramp; 'species' = small
   *  categorical palette keyed on the boreal SPECIES_OPTIONS codes. */
  colorBy?: 'dbh' | 'species';
  onColorByChange?: (m: 'dbh' | 'species') => void;
}

// Categorical palette for the species mode. Picked to look reasonable
// against the dark panel + survive Bortle-9-monitor calibration.
const SPECIES_COLORS: Record<string, string> = {
  PIS: '#7ee0a8', // pine — accent green
  PIA: '#62b3ff', // spruce — blue
  BEP: '#ffd166', // birch — yellow
  BEB: '#fbc02d', // downy birch — darker yellow
  POT: '#ef6c9e', // aspen — pink
  ALG: '#b388eb', // grey alder — purple
  SOA: '#ff9f6b', // rowan — orange
  OTH: '#a0a0a0', // other
  '':  '#666666', // untagged
};

// Continuous accent ramp for the DBH mode — three stops: low (dim
// teal), mid (accent green), high (warm yellow), interpolated linearly
// per channel in sRGB. Good enough for at-a-glance distinction; if
// users want viridis we already have it in the color sub-package.
function dbhColor(dbh: number, lo: number, hi: number): string {
  const t = hi > lo ? Math.max(0, Math.min(1, (dbh - lo) / (hi - lo))) : 0.5;
  // Stops: 0 = #2e6a55, 0.5 = #7ee0a8, 1 = #ffd166
  const stops = [
    [0.00, [46, 106, 85]],
    [0.50, [126, 224, 168]],
    [1.00, [255, 209, 102]],
  ] as const;
  let i = 0;
  while (i < stops.length - 1 && t > stops[i + 1][0]) i++;
  const [t0, c0] = stops[i];
  const [t1, c1] = stops[Math.min(i + 1, stops.length - 1)];
  const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  const r = Math.round(c0[0] + (c1[0] - c0[0]) * u);
  const g = Math.round(c0[1] + (c1[1] - c0[1]) * u);
  const b = Math.round(c0[2] + (c1[2] - c0[2]) * u);
  return `rgb(${r}, ${g}, ${b})`;
}

interface Hover { idx: number; cx: number; cy: number }

export default function TreeMap({
  trees, plots,
  title = 'Tree map',
  width = 620, height = 420,
  colorBy = 'dbh',
  onColorByChange,
}: Props) {
  const PAD = { l: 48, r: 16, t: 36, b: 36 };
  const W = Math.max(180, width);
  const H = Math.max(180, height);
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  // Filter to trees that actually have a position from a plugin run.
  const positioned = useMemo(() => trees.filter(t =>
    t.baseX != null && t.baseY != null &&
    Number.isFinite(t.baseX) && Number.isFinite(t.baseY),
  ), [trees]);

  // Bounding box across trees + plot polygons. Plot polygons are
  // closed XY rings in absolute world coords.
  const bbox = useMemo(() => {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const t of positioned) {
      if (t.baseX! < xMin) xMin = t.baseX!;
      if (t.baseX! > xMax) xMax = t.baseX!;
      if (t.baseY! < yMin) yMin = t.baseY!;
      if (t.baseY! > yMax) yMax = t.baseY!;
    }
    for (const p of plots) {
      const ring = wktToPolygon(p.geometry_wkt);
      for (const v of ring) {
        if (v[0] < xMin) xMin = v[0];
        if (v[0] > xMax) xMax = v[0];
        if (v[1] < yMin) yMin = v[1];
        if (v[1] > yMax) yMax = v[1];
      }
    }
    if (!Number.isFinite(xMin)) return null;
    // Inflate by 5 % so dots don't kiss the chart border.
    const padX = (xMax - xMin) * 0.05 || 1;
    const padY = (yMax - yMin) * 0.05 || 1;
    return { xMin: xMin - padX, xMax: xMax + padX, yMin: yMin - padY, yMax: yMax + padY };
  }, [positioned, plots]);

  // Equal-aspect mapping. We pick the bigger range as the denominator
  // for both axes so 1 m in X looks like 1 m in Y (north points up).
  // Y axis inverts so larger source-Y = up on screen.
  const map = useMemo(() => {
    if (!bbox) return null;
    const rx = bbox.xMax - bbox.xMin;
    const ry = bbox.yMax - bbox.yMin;
    const r = Math.max(rx, ry);
    const sx = innerW / r;
    const sy = innerH / r;
    const cxOff = (innerW - rx * sx) / 2;
    const cyOff = (innerH - ry * sy) / 2;
    return {
      px: (x: number) => PAD.l + cxOff + (x - bbox.xMin) * sx,
      py: (y: number) => PAD.t + cyOff + (bbox.yMax - y) * sy,
      range: r,
      sx, sy,
    };
  }, [bbox, innerW, innerH]);

  const dbhRange = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const t of positioned) {
      if (t.dbh == null) continue;
      if (t.dbh < lo) lo = t.dbh;
      if (t.dbh > hi) hi = t.dbh;
    }
    if (!Number.isFinite(lo)) return null;
    return { lo, hi };
  }, [positioned]);

  const [hover, setHover] = useState<Hover | null>(null);

  if (!map || !bbox) {
    return (
      <div className="text-[11.5px] py-6 text-center" style={{ color: 'var(--text-mute)' }}>
        No tree positions yet. Run DBH, basal area, or Tree height → Save to project.
      </div>
    );
  }

  // Axis tick values in source XY for cardinal scale reference.
  // niceTicks returns { ticks, lo, hi }; we only need the tick array
  // for the gridlines + axis labels.
  const xTicks = niceTicks(bbox.xMin, bbox.xMax, 5).ticks;
  const yTicks = niceTicks(bbox.yMin, bbox.yMax, 5).ticks;

  // Per-tree visual encoding.
  const dotRadius = (dbh: number | null): number => {
    if (dbh == null) return 2;
    // 5 cm DBH → 3 px, 30 cm → 6 px, 50 cm → 7 px. Caps to keep dots readable.
    return Math.max(2, Math.min(8, 2 + Math.sqrt(dbh) * 0.7));
  };
  const dotColor = (t: TreeMapEntry): string => {
    if (colorBy === 'species') return SPECIES_COLORS[t.species ?? ''] ?? SPECIES_COLORS[''];
    if (t.dbh == null || !dbhRange) return SPECIES_COLORS[''];
    return dbhColor(t.dbh, dbhRange.lo, dbhRange.hi);
  };

  // Species swatches present in the data for the legend in species mode.
  const speciesPresent = useMemo(() => {
    if (colorBy !== 'species') return [];
    const seen = new Set<string>();
    for (const t of positioned) seen.add(t.species ?? '');
    return Array.from(seen);
  }, [positioned, colorBy]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between mb-1">
        <div className="mono text-[11px]" style={{ color: 'var(--text-mute)' }}>{title}</div>
        <div className="flex items-center gap-2">
          <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>color</span>
          <select
            value={colorBy}
            onChange={(e) => onColorByChange?.(e.target.value as 'dbh' | 'species')}
            className="bg-transparent rounded-sm px-1.5 py-0.5 mono text-[10.5px]"
            style={{ border: '1px solid var(--line)', color: 'var(--text)' }}
            disabled={!onColorByChange}
          >
            <option value="dbh">DBH</option>
            <option value="species">species</option>
          </select>
        </div>
      </div>
      <svg width={W} height={H} style={{ display: 'block', background: 'transparent' }}>
        {/* Gridlines */}
        {xTicks.map((t, i) => (
          <line key={`vx${i}`}
            x1={map.px(t)} x2={map.px(t)}
            y1={PAD.t} y2={H - PAD.b}
            stroke="var(--line)" strokeWidth={0.5} opacity={0.4}
          />
        ))}
        {yTicks.map((t, i) => (
          <line key={`vy${i}`}
            x1={PAD.l} x2={W - PAD.r}
            y1={map.py(t)} y2={map.py(t)}
            stroke="var(--line)" strokeWidth={0.5} opacity={0.4}
          />
        ))}
        {/* Axis labels */}
        {xTicks.map((t, i) => (
          <text key={`tx${i}`}
            x={map.px(t)} y={H - PAD.b + 14}
            textAnchor="middle"
            className="mono"
            style={{ fontSize: 10, fill: 'var(--text-mute)' }}
          >{formatTick(t)}</text>
        ))}
        {yTicks.map((t, i) => (
          <text key={`ty${i}`}
            x={PAD.l - 6} y={map.py(t) + 3}
            textAnchor="end"
            className="mono"
            style={{ fontSize: 10, fill: 'var(--text-mute)' }}
          >{formatTick(t)}</text>
        ))}
        <text x={W - PAD.r} y={H - PAD.b + 26} textAnchor="end" className="mono"
          style={{ fontSize: 9.5, fill: 'var(--text-mute)' }}>
          X (m, source)
        </text>
        <text x={PAD.l} y={PAD.t - 12} textAnchor="start" className="mono"
          style={{ fontSize: 9.5, fill: 'var(--text-mute)' }}>
          Y (m, source) — north up
        </text>
        {/* Plot polygons (in front of grid, behind trees so a tree dot
            is never hidden by its plot outline). */}
        {plots.map((p, i) => {
          const ring = wktToPolygon(p.geometry_wkt);
          if (ring.length < 3) return null;
          const d = ring.map((v, k) => `${k === 0 ? 'M' : 'L'} ${map.px(v[0])} ${map.py(v[1])}`).join(' ') + ' Z';
          return (
            <path key={`pl${i}`}
              d={d}
              fill="rgba(255,209,102,0.05)"
              stroke="rgba(255,209,102,0.55)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          );
        })}
        {/* Tree dots */}
        {positioned.map((t, i) => {
          const cx = map.px(t.baseX!);
          const cy = map.py(t.baseY!);
          return (
            <circle
              key={i}
              cx={cx} cy={cy}
              r={dotRadius(t.dbh)}
              fill={dotColor(t)}
              stroke="rgba(0,0,0,0.45)"
              strokeWidth={0.5}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHover({ idx: i, cx, cy })}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
        {/* Hover tooltip */}
        {hover && positioned[hover.idx] && (
          (() => {
            const t = positioned[hover.idx];
            const lines = [
              `tree #${t.treeId}`,
              `x ${t.baseX!.toFixed(2)} m  y ${t.baseY!.toFixed(2)} m`,
              t.dbh != null ? `DBH ${t.dbh.toFixed(1)} cm` : 'DBH —',
              t.height != null ? `h ${t.height.toFixed(1)} m` : 'h —',
              t.species ? `sp ${t.species}` : 'sp —',
            ];
            const tipW = 130;
            const tipH = 14 * lines.length + 8;
            // Keep tooltip on screen.
            let tx = hover.cx + 10;
            let ty = hover.cy - tipH - 6;
            if (tx + tipW > W - 4) tx = hover.cx - 10 - tipW;
            if (ty < PAD.t) ty = hover.cy + 12;
            return (
              <g pointerEvents="none">
                <rect x={tx} y={ty} width={tipW} height={tipH}
                  fill="rgba(11,13,16,0.92)" stroke="var(--line)" strokeWidth={0.5} rx={4} />
                {lines.map((l, j) => (
                  <text key={j}
                    x={tx + 6} y={ty + 14 + 14 * j}
                    className="mono"
                    style={{ fontSize: 10.5, fill: 'var(--text)' }}
                  >{l}</text>
                ))}
              </g>
            );
          })()
        )}
      </svg>
      {/* Legend strip. DBH ramp gets a tiny horizontal gradient + the
          numeric range. Species mode lists the codes present. */}
      <div className="flex items-center gap-3 mt-1 flex-wrap">
        {colorBy === 'dbh' && dbhRange && (
          <div className="flex items-center gap-2">
            <div style={{
              width: 110, height: 8, borderRadius: 2,
              background: 'linear-gradient(90deg, rgb(46,106,85), rgb(126,224,168), rgb(255,209,102))',
            }} />
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
              {dbhRange.lo.toFixed(0)} – {dbhRange.hi.toFixed(0)} cm DBH
            </span>
          </div>
        )}
        {colorBy === 'species' && speciesPresent.map(s => (
          <div key={s || 'untagged'} className="flex items-center gap-1.5">
            <span style={{
              display: 'inline-block', width: 10, height: 10, borderRadius: 5,
              background: SPECIES_COLORS[s] ?? SPECIES_COLORS[''],
            }} />
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
              {s || 'untagged'}
            </span>
          </div>
        ))}
        <span className="ml-auto mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
          {positioned.length} positioned · dot size ~ √DBH
        </span>
      </div>
    </div>
  );
}
