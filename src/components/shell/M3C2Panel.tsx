// M3C2 change-detection panel — Lague, Brodu & Leroux 2013.
//
// Compares the ACTIVE (open) octree against a chosen REFERENCE-epoch octree
// and reports the signed distance distribution (canopy / stem growth, sway,
// blowdown) with a 95% level of detection so real change is separated from
// registration + roughness noise. Read-only: it measures, it never edits the
// cloud. Positive = the active cloud sits above the reference (upward growth).
//
// The two epochs must already be co-registered — align them with the
// Co-registration tool first, or the whole plot reads as spurious change.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOctreeShell, type M3C2Result, type M3C2Overlay } from './OctreeShellContext';
import { onOctreeProgress } from '../../persistence/octreeStore';
import { percentile } from '../../metrics/stats';

export default function M3C2Panel() {
  const { octree, octreeList, api, analysisLayers, addAnalysisLayer, setAnalysisLayerVisible, removeAnalysisLayer, setM3c2Summary } = useOctreeShell();
  // The change map is a layer in the Layers panel — hidden, shown, saved
  // with the dataset or removed there as well as here. Each run makes a
  // new one, named after the epochs and the core spacing.
  const [layerId, setLayerId] = useState<string | null>(null);
  const layer = analysisLayers.find(l => l.id === layerId);
  const canRun = !!api && !!octree;
  const candidates = octreeList.filter(e => e.dir !== octree?.dir);

  const [referenceDir, setReferenceDir] = useState('');
  // Slider-friendly units, converted to metres/… on run.
  const [voxelCm, setVoxelCm] = useState(10);    // 0.10 m
  const [normalCm, setNormalCm] = useState(100); // 1.00 m
  const [projCm, setProjCm] = useState(50);      // 0.50 m
  const [depthCm, setDepthCm] = useState(300);   // 3.00 m
  const [regMm, setRegMm] = useState(20);        // 0.02 m
  // Where the distance is evaluated: Lague et al.'s core points are a
  // subsample of the cloud. At the decimation voxel (10 cm) a 438 M-point
  // plot was tens of millions of cylinder queries and the bar stood at
  // 60 % for hours; at half a metre the same change field is a few
  // hundred thousand.
  const [coreCm, setCoreCm] = useState(50);      // 0.50 m

  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<M3C2Result | null>(null);
  const desktop = (window as unknown as { desktop?: { octreeCancel?: (stage: string) => Promise<boolean> } }).desktop;

  useEffect(() => {
    if (!referenceDir && candidates.length > 0) setReferenceDir(candidates[0].dir);
  }, [candidates, referenceDir]);

  useEffect(() => {
    if (!busy) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((stage, p) => { if (stage === 'm3c2') setPct(p); })
      .then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [busy]);

  const run = useCallback(async () => {
    if (!api || !referenceDir) return;
    setBusy(true); setPct(0); setError(null); setResult(null); setStopping(false);
    try {
      const res = await api.m3c2(referenceDir, {
        voxelSize: voxelCm / 100,
        normalScale: normalCm / 100,
        projectionScale: projCm / 100,
        maxDepth: depthCm / 100,
        regError: regMm / 1000,
        coreSpacing: coreCm / 100,
      });
      setResult(res);
      const referenceName = octreeList.find(e => e.dir === referenceDir)?.name ?? referenceDir;
      // The change map, as a layer — when there is one to draw.
      const overlay = buildOverlay(res);
      setLayerId(overlay ? addAnalysisLayer({
        kind: 'm3c2',
        label: `M3C2 · ${referenceName} → ${octree?.meta.name ?? 'active'} · ${coreCm} cm`,
        source: `M3C2 · normal ${normalCm} cm · projection ${projCm} cm · depth ${depthCm} cm · reg ${regMm} mm${res.stopped ? ' · stopped early' : ''}`,
        payload: { kind: 'm3c2', overlay },
      }) : null);
      // Hand the headline stats to the Report panel — the same numbers the
      // stat card below renders. corePoints is the DEFINED count (points
      // with an actual change value) so it stays consistent with
      // significantPct, which is also a fraction of the defined set.
      setM3c2Summary({
        referenceName,
        corePoints: res.definedCount,
        significantPct: res.definedCount > 0 ? (res.significantCount / res.definedCount) * 100 : 0,
        meanChangeCm: res.meanDistance * 100,
        medianChangeCm: res.medianDistance * 100,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false); setStopping(false);
    }
  }, [api, referenceDir, voxelCm, normalCm, projCm, depthCm, regMm, coreCm, addAnalysisLayer, octree?.meta.name, octreeList, setM3c2Summary]);

  const cancel = useCallback(async () => {
    if (!desktop?.octreeCancel) return;
    setStopping(true);
    try { await desktop.octreeCancel('m3c2'); } catch { /* nothing was running */ }
  }, [desktop]);

  /** Everything this panel produced, gone: the result, the change map
   *  painted on the cloud, and the summary it handed the Report. It
   *  never wrote into the cloud, so this is all there is to take back. */
  const clearAll = useCallback(() => {
    setResult(null); setError(null);
    if (layerId) void removeAnalysisLayer(layerId);
    setLayerId(null);
    setM3c2Summary(null);
  }, [layerId, removeAnalysisLayer, setM3c2Summary]);

  const refName = candidates.find(e => e.dir === referenceDir)?.name ?? '';
  const sigPct = result && result.definedCount > 0
    ? (result.significantCount / result.definedCount) * 100 : 0;

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 420 }}>
      {!canRun && (
        <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          M3C2 needs the desktop build and an open dataset.
        </div>
      )}
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
        Signed change from a reference epoch to the active cloud, along local
        normals, with a 95% level of detection. Positive = growth (active
        above reference). Both epochs must be <b>co-registered</b> first.
      </div>

      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)', lineHeight: 1.5 }}>{error}</div>
      )}

      <Section title="Reference epoch" sub="the ‘before’ dataset">
        {candidates.length === 0 ? (
          <div className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            No other dataset in the project — import the earlier epoch first.
          </div>
        ) : (
          <select
            value={referenceDir}
            onChange={(e) => setReferenceDir(e.target.value)}
            disabled={busy}
            className="mono text-[11px] rounded-md px-1.5 py-1"
            style={{ background: 'var(--wash-2)', border: '1px solid var(--line)', color: 'var(--text)' }}
          >
            {candidates.map(e => (
              <option key={e.dir} value={e.dir}>{e.name} · {e.pointCount.toLocaleString()} pts</option>
            ))}
          </select>
        )}
        <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          <span style={{ color: 'var(--text)' }}>{refName || '—'}</span> → <span style={{ color: 'var(--text)' }}>{octree?.meta.name ?? '—'}</span> (active)
        </div>
      </Section>

      <Section title="Scales" sub="voxel · normal · projection · depth">
        <SliderRow label="Decimation"       unit="cm" value={voxelCm}  min={2}  max={50}   step={1} setValue={setVoxelCm}  disabled={busy} />
        <SliderRow label="Normal scale"     unit="cm" value={normalCm} min={20} max={300}  step={5} setValue={setNormalCm} disabled={busy} />
        <SliderRow label="Projection scale" unit="cm" value={projCm}   min={5}  max={200}  step={5} setValue={setProjCm}   disabled={busy} />
        <SliderRow label="Max depth"        unit="cm" value={depthCm}  min={50} max={1000} step={10} setValue={setDepthCm} disabled={busy} />
        <SliderRow label="Reg. error"       unit="mm" value={regMm}    min={0}  max={100}  step={1} setValue={setRegMm}    disabled={busy} />
        <SliderRow label="Core spacing"     unit="cm" value={coreCm}   min={10} max={200}  step={5} setValue={setCoreCm}   disabled={busy} />
        <div className="mono text-[8.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
          Core spacing is where the change is evaluated — a subsample, as in Lague et al. Finer than the
          decimation means every decimated point; at 10 cm on a large plot that is hours.
        </div>
      </Section>

      <div className="flex gap-1.5">
        <button
          className="btn !h-8 mono text-[11.5px] justify-center flex-1"
          disabled={!canRun || busy || !referenceDir}
          onClick={run}
          style={{
            background: busy ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : undefined,
            color: busy ? 'var(--accent)' : undefined,
          }}
        >
          {busy ? `${pct < 0.35 ? 'Reading the reference' : pct < 0.6 ? 'Reading the active cloud' : pct < 0.9 ? 'Comparing' : 'Finishing'} (${(pct * 100).toFixed(0)} %)…` : 'Compute M3C2'}
        </button>
        {busy && (
          <button className="btn !h-8 mono text-[11.5px] !px-3" onClick={() => void cancel()}
            disabled={!desktop?.octreeCancel || stopping} title="Stop between chunks — the core points already compared are kept">
            {stopping ? 'Stopping…' : 'Cancel'}
          </button>
        )}
        {result && !busy && (
          <button className="btn !h-8 mono text-[11.5px] !px-3" onClick={clearAll}
            title="Drop the result, the change map and the Report entry">Clear</button>
        )}
      </div>
      {busy && <ProgressBar pct={pct} />}
      {result?.stopped && !busy && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', border: '1px solid var(--line)' }}>
          Stopped — {result.coreCount.toLocaleString()} core points were compared before that; the rest were not.
        </div>
      )}

      {result && !busy && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            <span>Mean change</span><span style={{ color: signColor(result.meanDistance), textAlign: 'right' }}>{cm(result.meanDistance)}</span>
            <span>Median</span><span style={{ color: signColor(result.medianDistance), textAlign: 'right' }}>{cm(result.medianDistance)}</span>
            <span>Std dev</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{(result.stdDistance * 100).toFixed(1)} cm</span>
            <span>Significant</span><span style={{ color: 'var(--accent)', textAlign: 'right' }}>{sigPct.toFixed(0)} %</span>
            <span>Core points</span><span style={{ color: 'var(--text)', textAlign: 'right' }}>{result.definedCount.toLocaleString()} / {result.coreCount.toLocaleString()}</span>
          </div>
          <Histogram distances={result.distance} />
          <div className="mono text-[8.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
            Distance distribution · <span style={{ color: '#5b8bd0' }}>■</span> loss / lower · <span style={{ color: '#d06b6b' }}>■</span> growth / higher. {(result.coreCount - result.definedCount).toLocaleString()} undefined (no overlap).
          </div>
          <div className="flex flex-col gap-1">
            <button
              className="btn !h-6 mono text-[10px] justify-center"
              disabled={!layer}
              onClick={() => { if (layerId && layer) void setAnalysisLayerVisible(layerId, !layer.visible); }}
            >
              {layer?.visible ? 'Hide 3D overlay' : 'Show 3D overlay'}
            </button>
            <span className="mono text-[8.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
              {layer?.visible ? 'Painted on the active cloud' : 'Coloured change map'} · listed in Layers, where it can be saved with the dataset.
            </span>
          </div>
        </div>
      )}

      <div className="mono text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
        M3C2 — Lague et al. 2013. A measurement only; nothing is written into the cloud.
      </div>
    </div>
  );
}

// ---------------- distribution chart ----------------

function Histogram({ distances }: { distances: number[] }) {
  const bins = useMemo(() => {
    const finite: number[] = [];
    for (const d of distances) if (Number.isFinite(d)) finite.push(d);
    if (finite.length === 0) return null;
    // Robust symmetric range = 95th percentile of |d|.
    const scale = Math.max(percentile(finite.map(Math.abs), 0.95) || 0.05, 0.05);
    const N = 25;
    const counts = new Array<number>(N).fill(0);
    for (const d of finite) {
      const t = (d + scale) / (2 * scale); // 0..1
      let i = Math.floor(t * N);
      if (i < 0) i = 0; else if (i >= N) i = N - 1;
      counts[i]++;
    }
    const max = Math.max(...counts, 1);
    return { counts, max, scale, N };
  }, [distances]);

  if (!bins) return <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>No defined distances.</div>;
  const { counts, max, scale, N } = bins;
  const W = 380, H = 48, bw = W / N;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H + 12}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      {counts.map((c, i) => {
        const h = (c / max) * H;
        const center = -scale + (i + 0.5) * (2 * scale / N);
        return <rect key={i} x={i * bw + 0.5} y={H - h} width={bw - 1} height={h} fill={signColor(center)} opacity={0.85} />;
      })}
      {/* zero line */}
      <line x1={W / 2} y1={0} x2={W / 2} y2={H} stroke="var(--line)" strokeWidth={0.8} strokeDasharray="2 2" />
      <text x={2} y={H + 10} fill="var(--text-mute)" fontSize={8} fontFamily="monospace">−{(scale * 100).toFixed(0)} cm</text>
      <text x={W - 2} y={H + 10} textAnchor="end" fill="var(--text-mute)" fontSize={8} fontFamily="monospace">+{(scale * 100).toFixed(0)} cm</text>
    </svg>
  );
}

// Turn a result into a viewport overlay. maxAbs = 95th percentile of the
// finite |distance| (min 1 cm) so the ramp saturates on the bulk of real
// change, not on a handful of outliers — same robust scale as the chart.
function buildOverlay(res: M3C2Result): M3C2Overlay | null {
  if (res.distance.length === 0) return null;
  const abs: number[] = [];
  for (const d of res.distance) if (Number.isFinite(d)) abs.push(Math.abs(d));
  if (abs.length === 0) return null;
  const maxAbs = Math.max(percentile(abs, 0.95) || 0.05, 0.01);
  return {
    xyz: Float32Array.from(res.xyz),
    distance: Float32Array.from(res.distance),
    significant: Uint8Array.from(res.significant),
    maxAbs,
  };
}

function signColor(d: number): string {
  if (d > 0.005) return '#d06b6b';   // growth / higher
  if (d < -0.005) return '#5b8bd0';  // loss / lower
  return 'var(--text-dim)';
}
function cm(m: number): string {
  const v = m * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)} cm`;
}

// ---------------- building blocks ----------------

function Section({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
      <div className="flex items-baseline gap-2">
        <span className="mono text-[11px]" style={{ color: 'var(--text)' }}>{title}</span>
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{sub}</span>
      </div>
      {children}
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height: 3, background: 'var(--wash-3)' }}>
      <div style={{ width: `${(Math.max(0, Math.min(1, pct)) * 100).toFixed(1)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.15s' }} />
    </div>
  );
}

function SliderRow({
  label, unit, value, min, max, step, setValue, disabled,
}: {
  label: string; unit: string; value: number; min: number; max: number; step: number;
  setValue: (n: number) => void; disabled: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="mono text-[10px] w-[112px]" style={{ color: 'var(--text-dim)' }}>{label}</label>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => setValue(parseInt(e.target.value, 10))} className="flex-1" disabled={disabled} />
      <span className="mono text-[10px] w-[52px] text-right" style={{ color: 'var(--text)' }}>{value} {unit}</span>
    </div>
  );
}
