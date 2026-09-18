// Stem taper + log assortment (bucking / apteeraus) — the UI.
//
// The arithmetic lives in metrics/bucking.ts so it can be tested against
// a stem whose answers are known; this file is the panel around it.
//
// Defaults are calibrated for Nordic / Finnish softwood (saha / kuitu /
// energia). All fields are editable inline so a non-Nordic user can
// retune for their own market without a code change.
//
// Read-only on the cached QSM (no Rust changes).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import type { QsmResult } from '../../persistence/octreeReader';
import { useProject } from '../../context/ProjectContext';
import {
  buckTree, plotTotals as computePlotTotals, taperPoints, sanitizeLengths,
  type Assortment, type BuckingResult,
} from '../../metrics/bucking';
import { csvNum, csvBlob } from '../../io/csv';
import { currencyCsvSuffix, getCurrency, setCurrency, MAX_CURRENCY_LEN } from '../../metrics/currency';
import { saveCsvFile } from '../../io/saveDownload';

interface Desktop {
  octreeReadQsm?: (dir: string) => Promise<QsmResult | null>;
  octreeTreeSummary?: (dir: string) => Promise<{ treeId: number; count: number; bboxMin: [number, number, number]; bboxMax: [number, number, number] }[]>;
}

// Defaults: Finnish softwood market, autumn 2025 ballpark.
const DEFAULT_ASSORTMENTS: Assortment[] = [
  { id: 'saw',    name: 'Sawlog',  minTopDcm: 16, lengths: [3.7, 4.0, 4.3, 4.6, 4.9, 5.2, 5.5], pricePerM3: 60, colour: '#6fa8dc' },
  { id: 'pulp',   name: 'Pulpwood',minTopDcm:  7, lengths: [2.7, 3.0, 3.3, 3.6, 3.9, 4.2, 4.5, 4.8, 5.0], pricePerM3: 30, colour: '#67d391' },
  { id: 'energy', name: 'Energy',  minTopDcm:  5, lengths: [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0], pricePerM3: 15, colour: '#e6c068' },
];
const WASTE_COLOUR = '#7f7f7f';

// --- Panel --------------------------------------------------------------

export default function BuckingPanel() {
  const { octree, api, setFilters } = useOctreeShell();
  const { project } = useProject();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  const [qsm, setQsm] = useState<QsmResult | null>(null);
  const [bboxes, setBboxes] = useState<Map<number, { min: [number, number, number]; max: [number, number, number] }> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [assortments, setAssortments] = useState<Assortment[]>(DEFAULT_ASSORTMENTS);
  const [stumpHeight, setStumpHeight] = useState(0.10);
  // The prices below are whatever the user's own market quotes; the
  // symbol they are printed with has to be too. See metrics/currency.ts.
  const [currency, setCurrencyState] = useState<string>(() => getCurrency());
  const [selectedTreeId, setSelectedTreeId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!project?.folder || !octree?.dir) { setQsm(null); setBboxes(null); return; }
    setLoading(true); setError(null);
    try {
      if (desktop?.octreeReadQsm) {
        const res = await desktop.octreeReadQsm(octree.dir);
        setQsm(res);
      }
      if (desktop?.octreeTreeSummary) {
        const list = await desktop.octreeTreeSummary(octree.dir);
        const m = new Map<number, { min: [number, number, number]; max: [number, number, number] }>();
        for (const r of list) m.set(r.treeId, { min: r.bboxMin, max: r.bboxMax });
        setBboxes(m);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [project?.folder, octree?.dir, desktop]);
  useEffect(() => { void refresh(); }, [refresh]);

  const results = useMemo<BuckingResult[]>(() => {
    if (!qsm) return [];
    return qsm.trees.map(t => buckTree(t, stumpHeight, assortments));
  }, [qsm, stumpHeight, assortments]);

  const plotTotals = useMemo(
    () => computePlotTotals(results, assortments),
    [results, assortments],
  );

  // Currently-selected tree (for the per-tree profile canvas).
  const selResult = useMemo(() =>
    selectedTreeId == null ? null : results.find(r => r.treeId === selectedTreeId) ?? null,
  [selectedTreeId, results]);
  const selTree = useMemo(() =>
    selectedTreeId == null || !qsm ? null : qsm.trees.find(t => t.treeId === selectedTreeId) ?? null,
  [selectedTreeId, qsm]);

  // --- Stem-profile canvas ---
  const profileRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = profileRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth, cssH = c.clientHeight;
    if (c.width !== cssW * dpr || c.height !== cssH * dpr) {
      c.width = cssW * dpr; c.height = cssH * dpr;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!selTree || !selResult) return;
    const pts = taperPoints(selTree);
    // Plot rectangle.
    const padL = 32, padR = 12, padT = 10, padB = 22;
    const plotW = cssW - padL - padR, plotH = cssH - padT - padB;
    const maxH = selTree.height;
    // Max diameter for the X scale — include the butt slice and a
    // 10 % pad so the stem isn't right against the right edge.
    const maxD = Math.max(...pts.map(p => p.d)) * 1.1 || 0.5;
    const toPx = (d: number, h: number): [number, number] => [
      padL + plotW * 0.5 + (d * 0.5 / maxD) * plotW * 0.5,
      cssH - padB - (h / maxH) * plotH,
    ];
    const toPxLeft = (d: number, h: number): [number, number] => [
      padL + plotW * 0.5 - (d * 0.5 / maxD) * plotW * 0.5,
      cssH - padB - (h / maxH) * plotH,
    ];

    // Frame + gridlines.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(padL - 0.5, padT - 0.5, plotW + 1, plotH + 1);
    ctx.font = '9px ui-monospace,monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    for (let h = 0; h <= maxH; h += Math.ceil(maxH / 6)) {
      const [, py] = toPx(0, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(cssW - padR, py); ctx.stroke();
      ctx.fillText(`${h} m`, 2, py + 3);
    }
    // Centreline.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    const cx = padL + plotW * 0.5;
    ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, cssH - padB); ctx.stroke();

    // Log bands — drawn before the taper outline so the outline sits
    // on top.
    for (const log of selResult.logs) {
      const colour = assortments.find(a => a.id === log.assortmentId)?.colour ?? WASTE_COLOUR;
      const [xL, yTop] = toPxLeft(Math.max(log.dButt, log.dTop), log.hHigh);
      const [xR, yBot] = toPx(Math.max(log.dButt, log.dTop), log.hLow);
      ctx.fillStyle = colour + '38'; // ~22 % alpha
      ctx.fillRect(xL, yTop, xR - xL, yBot - yTop);
      // Boundary line + class label.
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xL, yBot); ctx.lineTo(xR, yBot);
      ctx.stroke();
      ctx.fillStyle = colour;
      ctx.font = '9px ui-monospace,monospace';
      ctx.fillText(`${(log.length).toFixed(1)} m`, cx + 4, (yTop + yBot) / 2 + 3);
    }

    // Taper outline (mirrored, left + right).
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const [px, py] = toPx(pts[i].d, pts[i].h);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const [px, py] = toPxLeft(pts[i].d, pts[i].h);
      ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();

    // Stump line.
    const [xs, ys] = toPx(0, stumpHeight);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, ys); ctx.lineTo(cssW - padR, ys);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText(`stump ${(stumpHeight * 100).toFixed(0)} cm`, xs - 36, ys - 3);
  }, [selTree, selResult, assortments, stumpHeight]);

  // --- Sorted per-tree rows for the table ---
  const sortedRows = useMemo(
    () => [...results].sort((a, b) => b.totalRevenue - a.totalRevenue),
    [results],
  );

  // --- CSV export ---
  const exportCsv = useCallback(() => {
    if (results.length === 0) return;
    // The money columns are named after the currency actually in use —
    // a file of `saw_eur` values that are Chilean pesos is a file that
    // lies to whatever reads it next. See currencyCsvSuffix for why the
    // name is derived from letters rather than from the symbol.
    const rev = currencyCsvSuffix(currency);
    const headers = [
      'tree_id', 'height_m', 'measured_top_m', 'stem_volume_m3',
      ...assortments.flatMap(a => [`${a.id}_m3`, `${a.id}_${rev}`]),
      'stump_m3', 'residue_m3', 'waste_m3', `total_${rev}`,
    ];
    const lines = [headers.join(',')];
    for (const r of results) {
      const row = [
        r.treeId,
        csvNum(r.height, 2),
        // How far up a circle was actually fitted. `stem_volume_m3` is
        // the QSM's own figure, which this column qualifies: under a
        // closed canopy it can be a third of the tree.
        csvNum(r.measuredTop, 2),
        csvNum(r.qsmStemVolume, 4),
        ...assortments.flatMap(a => [
          csvNum(r.perClass[a.id] ?? 0, 4),
          csvNum(r.revenuePerClass[a.id] ?? 0, 2),
        ]),
        csvNum(r.stumpVolume, 4),
        csvNum(r.residueVolume, 4),
        csvNum(r.wasteVolume, 4),
        csvNum(r.totalRevenue, 2),
      ];
      lines.push(row.join(','));
    }
    void saveCsvFile(lines, 'bucking.csv');
  }, [results, assortments, currency]);

  // --- Render -----------------------------------------------------------
  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 480 }}>
      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      {!qsm && !loading && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
          Run the Stem QSM in the Metrics module first. The bucking panel reads the cached QSM (per-tree slice radii) to find the longest valid log at every height under each assortment's minimum-top-diameter rule.
        </div>
      )}

      {/* Stump height + assortments editor */}
      <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>Stump height (m)</label>
          <input
            type="number" step={0.05} min={0} max={1.0}
            value={stumpHeight}
            onChange={(e) => setStumpHeight(parseFloat(e.target.value) || 0)}
            className="bg-transparent mono text-[10.5px] px-1 py-0.5 w-[64px]"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
          />
          <span className="flex-1" />
          <label className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Currency</label>
          <input
            type="text"
            maxLength={MAX_CURRENCY_LEN}
            value={currency}
            onChange={(e) => setCurrencyState(e.target.value)}
            onBlur={(e) => setCurrencyState(setCurrency(e.target.value))}
            className="bg-transparent mono text-[10.5px] px-1 py-0.5 w-[52px] text-center"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
            title="Symbol or code the prices below and every revenue figure are in - EUR, USD, kr, CHF, R$. Saved for every project."
          />
        </div>
        <div className="grid grid-cols-[68px_1fr_60px_60px_56px] gap-1 items-center mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
          <span>class</span>
          <span>lengths (m)</span>
          <span className="text-right">min top</span>
          <span className="text-right">{currency}/m³</span>
          <span></span>
        </div>
        {assortments.map((a, i) => (
          <div key={a.id} className="grid grid-cols-[68px_1fr_60px_60px_56px] gap-1 items-center">
            <span className="mono text-[10.5px]" style={{ color: a.colour }}>{a.name}</span>
            <input
              className="bg-transparent mono text-[10px] px-1 py-0.5"
              style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
              value={a.lengths.join(', ')}
              onChange={(e) => {
                // sanitizeLengths, not just isFinite: a zero-length module
                // makes the bucker cut forever at the same height, and
                // typing "0.5" passes through "0" and "0." on the way.
                const ls = sanitizeLengths(e.target.value.split(',').map(v => parseFloat(v.trim())));
                const next = [...assortments];
                next[i] = { ...a, lengths: ls };
                setAssortments(next);
              }}
            />
            <input
              type="number" step={1} min={1} max={50}
              className="bg-transparent mono text-[10.5px] px-1 py-0.5 text-right"
              style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
              value={a.minTopDcm}
              onChange={(e) => {
                const next = [...assortments];
                next[i] = { ...a, minTopDcm: parseFloat(e.target.value) || 0 };
                setAssortments(next);
              }}
            />
            <input
              type="number" step={1} min={0}
              className="bg-transparent mono text-[10.5px] px-1 py-0.5 text-right"
              style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
              value={a.pricePerM3}
              onChange={(e) => {
                const next = [...assortments];
                next[i] = { ...a, pricePerM3: parseFloat(e.target.value) || 0 };
                setAssortments(next);
              }}
            />
            <button
              className="btn !h-6 !px-1 mono text-[9.5px]"
              onClick={() => setAssortments(assortments.filter((_, j) => j !== i))}
              title="Remove this assortment"
            >
              ✕
            </button>
          </div>
        ))}
        <div className="flex items-center justify-between">
          <button
            className="btn !h-6 !px-2 mono text-[10px]"
            onClick={() => setAssortments(DEFAULT_ASSORTMENTS)}
          >
            Reset to Nordic defaults
          </button>
          <button
            className="btn !h-6 !px-2 mono text-[10px]"
            onClick={() => setAssortments([
              ...assortments,
              { id: `custom${assortments.length}`, name: 'Custom', minTopDcm: 5, lengths: [3.0], pricePerM3: 10, colour: '#b489d9' },
            ])}
          >
            + Add class
          </button>
        </div>
      </div>

      {/* Plot totals */}
      {qsm && results.length > 0 && (
        <div className="rounded-md p-2 flex flex-col gap-2" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="flex items-baseline gap-2">
            <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Plot totals</span>
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
              {results.length} tree{results.length === 1 ? '' : 's'} · {plotTotals.totalVol.toFixed(2)} m³ measured stem · {(plotTotals.totalVol - plotTotals.waste).toFixed(2)} m³ logged
              {plotTotals.nPartiallyMeasured > 0 && (
                <> · <span style={{ color: '#e6c068' }}>{plotTotals.nPartiallyMeasured} stem{plotTotals.nPartiallyMeasured === 1 ? '' : 's'} fitted below 80 % of tree height</span></>
              )}
            </span>
          </div>
          {/* Stacked bar — m³ per class. */}
          <StackedBar segments={[
            ...assortments.map(a => ({ value: plotTotals.perClass[a.id] ?? 0, colour: a.colour, label: a.name })),
            { value: plotTotals.waste, colour: WASTE_COLOUR, label: 'Waste' },
          ]} />
          {/* Per-class numerical rows. */}
          <div className="flex flex-col gap-0.5">
            {assortments.map(a => (
              <ClassRow
                key={a.id}
                colour={a.colour}
                name={a.name}
                volume={plotTotals.perClass[a.id] ?? 0}
                revenue={plotTotals.revenuePerClass[a.id] ?? 0}
                total={plotTotals.totalVol}
                currency={currency}
              />
            ))}
            <ClassRow colour={WASTE_COLOUR} name="Waste" volume={plotTotals.waste} revenue={0} total={plotTotals.totalVol} currency={currency} />
          </div>
          <div className="flex items-baseline gap-2 pt-1" style={{ borderTop: '1px solid var(--line)' }}>
            <span className="mono text-[10.5px]" style={{ color: 'var(--text-dim)', width: 100 }}>Total revenue</span>
            <span className="mono text-[12px]" style={{ color: 'var(--accent)' }}>{plotTotals.totalRev.toFixed(0)} {currency}</span>
            <span className="flex-1" />
            <button className="btn !h-6 !px-2 mono text-[10px]" onClick={exportCsv} disabled={results.length === 0}>Export CSV</button>
          </div>
        </div>
      )}

      {/* Per-tree profile + table */}
      {qsm && results.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {/* Tree picker / table */}
          <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
            <div className="px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderBottom: '1px solid var(--line)' }}>
              Per tree — sorted by revenue
            </div>
            <div className="max-h-[260px] overflow-y-auto scroll-thin">
              {sortedRows.map((r) => (
                <button
                  key={r.treeId}
                  className="w-full text-left px-2 py-1 flex items-center gap-2 hover:bg-white/[0.025]"
                  style={{
                    borderBottom: '1px solid var(--line)',
                    background: r.treeId === selectedTreeId ? 'var(--wash-2)' : 'transparent',
                  }}
                  onClick={() => {
                    setSelectedTreeId(r.treeId);
                    const bb = bboxes?.get(r.treeId);
                    if (bb) {
                      setFilters({ isolateTreeId: r.treeId, isolateBox: [bb.min, bb.max], isolateAnchor: null });
                      api?.frameBox(bb.min, bb.max);
                    }
                  }}
                >
                  <span className="mono text-[10.5px]" style={{ color: 'var(--text)', width: 44 }}>#{r.treeId}</span>
                  <span className="mono text-[10px] flex-1" style={{ color: 'var(--text-dim)' }}>
                    {assortments.map(a => (
                      <span key={a.id} style={{ color: (r.perClass[a.id] ?? 0) > 0 ? a.colour : 'var(--text-mute)', marginRight: 8 }}>
                        {(r.perClass[a.id] ?? 0).toFixed(2)}
                      </span>
                    ))}
                  </span>
                  <span className="mono text-[10.5px]" style={{ color: 'var(--accent)' }}>{r.totalRevenue.toFixed(0)} {currency}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Stem profile canvas */}
          <div className="rounded-md" style={{ border: '1px solid var(--line)', background: 'rgba(0,0,0,0.18)', height: 260 }}>
            <canvas ref={profileRef} style={{ width: '100%', height: '100%' }} />
          </div>
        </div>
      )}

      {selResult && (
        <div className="mono text-[10px] flex items-center gap-2 flex-wrap" style={{ color: 'var(--text-dim)' }}>
          <span style={{ color: 'var(--text)' }}>tree {selResult.treeId}</span>
          <span style={{ color: 'var(--text-mute)' }}>·</span>
          <span>{selResult.logs.length} log{selResult.logs.length === 1 ? '' : 's'}</span>
          <span style={{ color: 'var(--text-mute)' }}>·</span>
          <span>{selResult.height.toFixed(1)} m tall</span>
          <span style={{ color: selResult.measuredTop < selResult.height * 0.8 ? '#e6c068' : undefined }}>
            stem fitted to {selResult.measuredTop.toFixed(1)} m
          </span>
          <span style={{ color: 'var(--text-mute)' }}>·</span>
          <span style={{ color: 'var(--accent)' }}>{selResult.totalRevenue.toFixed(0)} {currency}</span>
          <span style={{ color: 'var(--text-mute)' }}>·</span>
          <span>waste {(selResult.wasteVolume * 1000).toFixed(0)} L</span>
        </div>
      )}
    </div>
  );
}

function StackedBar({ segments }: { segments: { value: number; colour: string; label: string }[] }) {
  const total = segments.reduce((a, b) => a + b.value, 0);
  if (total <= 0) return null;
  return (
    <div className="h-3 rounded-sm overflow-hidden flex" style={{ background: 'var(--wash-2)' }}>
      {segments.map((s, i) => (
        s.value > 0 && (
          <div
            key={i}
            title={`${s.label}: ${s.value.toFixed(2)} m³`}
            style={{ width: `${(s.value / total) * 100}%`, background: s.colour }}
          />
        )
      ))}
    </div>
  );
}

function ClassRow({ colour, name, volume, revenue, total, currency }: {
  colour: string; name: string; volume: number; revenue: number; total: number; currency: string;
}) {
  return (
    <div className="flex items-baseline gap-2 mono text-[10.5px]">
      <span style={{ width: 10, height: 10, background: colour, borderRadius: 2, display: 'inline-block' }} />
      <span style={{ color: 'var(--text-dim)', width: 84 }}>{name}</span>
      <span style={{ color: 'var(--text)', width: 76, textAlign: 'right' }}>{volume.toFixed(2)} m³</span>
      <span style={{ color: 'var(--text-mute)', width: 56, textAlign: 'right' }}>{total > 0 ? `${((volume / total) * 100).toFixed(0)} %` : '—'}</span>
      <span style={{ color: 'var(--text)', textAlign: 'right' }}>{revenue.toFixed(0)} {currency}</span>
    </div>
  );
}
