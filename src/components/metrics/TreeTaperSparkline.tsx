// Stem taper sparkline — mirrored XY profile (left edge = -radius,
// right edge = +radius) of one tree's QSM slices, with each slice
// marker coloured by its angular coverage. Plotted hag-vertical so it
// reads as the tree standing up.
//
// Compact (no legend / axis chrome to fight for space), but the
// breast-height reference and a Σ stem volume + confidence chip make
// it a single-glance readout the forester can verify.

import type { TreeQsm } from '../../persistence/octreeReader';

interface Props {
  tree: TreeQsm;
  /** Box width / height in CSS px. */
  width?: number;
  height?: number;
}

const PAD_X = 36;
const PAD_TOP = 10;
const PAD_BOTTOM = 18;

export default function TreeTaperSparkline({ tree, width = 320, height = 240 }: Props) {
  const slices = tree.slices;
  if (slices.length < 2) {
    return (
      <div className="mono text-[10px] px-3 py-4" style={{ color: 'var(--text-mute)' }}>
        Not enough QSM slices to draw a taper (need ≥ 2; tree has {slices.length}).
      </div>
    );
  }

  const rMax = Math.max(...slices.map(s => s.radius)) * 1.15;
  const hMax = Math.max(tree.height, slices[slices.length - 1].hag + 0.5);

  // Map model -> SVG. y inverts (hag 0 at the bottom).
  const innerW = width - 2 * PAD_X;
  const innerH = height - PAD_TOP - PAD_BOTTOM;
  const xToSvg = (r: number) => PAD_X + (r + rMax) / (2 * rMax) * innerW;
  const yToSvg = (hag: number) => PAD_TOP + (1 - hag / hMax) * innerH;

  // Mirrored profile polygon: left edge bottom→top, right edge top→bottom.
  const left = slices.map(s => `${xToSvg(-s.radius).toFixed(1)},${yToSvg(s.hag).toFixed(1)}`).join(' ');
  const right = [...slices].reverse()
    .map(s => `${xToSvg(s.radius).toFixed(1)},${yToSvg(s.hag).toFixed(1)}`).join(' ');

  // Breast-height reference line at 1.3 m.
  const bhY = yToSvg(1.3);
  const showBh = 1.3 <= hMax;

  // Confidence colour for slice markers (matches the table colours).
  const markerColor = (cov: number) =>
    cov >= 0.80 ? 'var(--accent)' : cov >= 0.55 ? '#e6c068' : '#ffb4be';

  return (
    <div style={{ minWidth: width }}>
      <div className="flex items-center gap-2 mb-1.5 mono text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
        <span className="chip" style={{ margin: 0 }}>Tree {tree.treeId}</span>
        <span>{tree.height.toFixed(1)} m · DBH {Number.isFinite(tree.dbh) ? (tree.dbh * 100).toFixed(1) + ' cm' : '—'}</span>
        <span className="flex-1" />
        <span>
          Σ <span style={{ color: 'var(--accent)' }}>{tree.stemVolume.toFixed(3)} m³</span>
          {tree.stemVolumeCi95 > 0 && (
            <span style={{ color: 'var(--text-mute)' }} title={`σ ${tree.stemVolumeStd.toFixed(4)} m³ · 95 % CI`}>
              {' '}± {tree.stemVolumeCi95.toFixed(3)}
            </span>
          )}
          {tree.branchCount > 0 && (
            <span style={{ color: 'var(--text-mute)' }} title={`${tree.branchCount} primary branches`}>
              {' + '}<span style={{ color: 'var(--accent)' }}>{tree.branchVolume.toFixed(3)}</span> br
            </span>
          )}
        </span>
        <span title={`${tree.acceptedSlices} accepted · ${tree.rejectedSlices} rejected · ${(tree.completeness * 100).toFixed(0)}% height coverage`}
              style={{ color: markerColor(tree.confidence) }}>
          {(tree.confidence * 100).toFixed(0)}%
        </span>
      </div>
      <svg width={width} height={height} role="img" aria-label={`Taper of tree ${tree.treeId}`}
           style={{ display: 'block', background: 'rgba(0,0,0,0.18)', borderRadius: 6 }}>
        {/* Filled mirrored profile. */}
        <polygon
          points={`${left} ${right}`}
          fill="color-mix(in oklch, var(--accent) 18%, transparent)"
          stroke="color-mix(in oklch, var(--accent) 60%, transparent)"
          strokeWidth="0.8"
        />
        {/* Centerline. */}
        <line
          x1={xToSvg(0)} x2={xToSvg(0)}
          y1={yToSvg(0)} y2={yToSvg(slices[slices.length - 1].hag)}
          stroke="var(--line)" strokeWidth="0.5" strokeDasharray="2 3"
        />
        {/* Breast-height reference. */}
        {showBh && (
          <>
            <line
              x1={PAD_X} x2={width - PAD_X}
              y1={bhY} y2={bhY}
              stroke="var(--text-mute)" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.6"
            />
            <text x={PAD_X - 4} y={bhY + 3} textAnchor="end"
                  style={{ fill: 'var(--text-mute)', fontSize: 9, fontFamily: 'var(--mono)' }}>
              1.3
            </text>
          </>
        )}
        {/* Slice markers — left edge (so they don't clutter the centerline). */}
        {slices.map((s, i) => (
          <g key={i}>
            <circle
              cx={xToSvg(-s.radius)} cy={yToSvg(s.hag)}
              r={2.2} fill={markerColor(s.coverage)}
              opacity="0.95"
            >
              <title>
                {`hag ${s.hag.toFixed(2)} m · r ${(s.radius * 100).toFixed(1)} cm · n ${s.nPoints} · coverage ${(s.coverage * 100).toFixed(0)}%`}
              </title>
            </circle>
            <circle
              cx={xToSvg(s.radius)} cy={yToSvg(s.hag)}
              r={2.2} fill={markerColor(s.coverage)}
              opacity="0.95"
            />
          </g>
        ))}
        {/* Y-axis ticks: every 5 m up to hMax. */}
        {axisTicks(hMax).map(t => (
          <g key={t}>
            <line
              x1={PAD_X - 3} x2={PAD_X}
              y1={yToSvg(t)} y2={yToSvg(t)}
              stroke="var(--text-mute)" strokeWidth="0.5"
            />
            <text x={PAD_X - 5} y={yToSvg(t) + 3} textAnchor="end"
                  style={{ fill: 'var(--text-mute)', fontSize: 9, fontFamily: 'var(--mono)' }}>
              {t}
            </text>
          </g>
        ))}
        {/* Y-axis label. */}
        <text x={6} y={PAD_TOP + 8} style={{ fill: 'var(--text-mute)', fontSize: 9, fontFamily: 'var(--mono)' }}>m</text>
        {/* Radius scale at the bottom. */}
        <line
          x1={PAD_X} x2={width - PAD_X}
          y1={height - PAD_BOTTOM + 4} y2={height - PAD_BOTTOM + 4}
          stroke="var(--line)" strokeWidth="0.5"
        />
        {[-rMax, 0, rMax].map(r => (
          <g key={r}>
            <line
              x1={xToSvg(r)} x2={xToSvg(r)}
              y1={height - PAD_BOTTOM + 4} y2={height - PAD_BOTTOM + 7}
              stroke="var(--text-mute)" strokeWidth="0.5"
            />
            <text x={xToSvg(r)} y={height - 4} textAnchor="middle"
                  style={{ fill: 'var(--text-mute)', fontSize: 9, fontFamily: 'var(--mono)' }}>
              {r === 0 ? '0' : (r * 100).toFixed(0) + ' cm'}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function axisTicks(hMax: number): number[] {
  const step = hMax > 30 ? 10 : hMax > 15 ? 5 : 2;
  const out: number[] = [];
  for (let t = 0; t <= hMax; t += step) out.push(t);
  return out;
}
