// Cross-sensor join — step 6 of the ALS + TLS/MLS exercise, and the
// table the whole exercise exists to produce.
//
// Pick the ALS dataset and the ground-based one, match their tree
// positions, and get one row per tree carrying the TLS-derived stem
// volume beside the ALS-derived metrics. The join and the accuracy
// arithmetic live in metrics/crossSensor.ts and metrics/assignment.ts so
// they can be tested against a plot whose answers are known; this file
// is the UI around them.
//
// The chart is the point of the panel. A single detection rate over a
// whole plot is close to meaningless: ALS sees almost nothing under
// 15 cm and almost everything over 40, so one number is an average over
// two different instruments. The per-class bars are what say whether a
// model fitted on this table can be trusted for small stems — which is
// usually the question being asked.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import type { TreeMetric, QsmResult } from '../../persistence/octreeReader';
import { loadTreeMetrics } from '../../metrics/loadMetrics';
import { csvField, csvText } from '../../io/csv';
import {
  joinSensors, detectionStats, detectionBySize, toRows, rowToCells,
  JOINED_CSV_HEADER, classify,
  type JoinResult, type Detection,
} from '../../metrics/crossSensor';
import type { MatchMethod } from '../../metrics/assignment';
import {
  fitVolumeModel, predictVolume, describeModel, DEFAULT_SPEC,
  type FittedModel, type TrainingPair,
} from '../../metrics/treeModel';

interface Desktop {
  octreeTreeMetrics?: (dir: string, params: { crownCell: number; bhLow: number; bhHigh: number; dtmCell: number }) => Promise<TreeMetric[]>;
  octreeReadQsm?: (dir: string) => Promise<QsmResult | null>;
  saveCsvDialog?: (name: string) => Promise<string | null>;
  writeFile?: (path: string, data: string) => Promise<void>;
  octreeCancel?: (stage: string) => Promise<boolean>;
  onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void> | (() => void);
}

const DETECTION_COLOUR: Record<Detection, string> = {
  matched: '#67d391',
  alsOnly: '#e6c068',
  tlsOnly: '#e0817b',
};
const DETECTION_LABEL: Record<Detection, string> = {
  matched: 'both sensors',
  alsOnly: 'ALS only',
  tlsOnly: 'TLS only — missed by ALS',
};

export default function CrossSensorPanel() {
  const { octree, octreeList, api } = useOctreeShell();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  const [alsDir, setAlsDir] = useState('');
  const [tlsDir, setTlsDir] = useState('');
  const [radius, setRadius] = useState(2.5);
  const [method, setMethod] = useState<MatchMethod>('optimal');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  // Each cloud's measurement is a pass over the whole of it, reported on
  // the "metrics" channel; a Stop reaches the one that is running.
  const [metricsPct, setMetricsPct] = useState(0);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!desktop?.onOctreeProgress) return;
    let off: (() => void) | undefined;
    void Promise.resolve(desktop.onOctreeProgress((e) => {
      if (e.stage === 'metrics') setMetricsPct(e.pct);
    })).then((f) => { off = f; });
    return () => { off?.(); };
  }, [desktop]);
  const cancel = useCallback(async () => {
    if (!desktop?.octreeCancel) return;
    setStopping(true);
    try { await desktop.octreeCancel('metrics'); } catch { /* nothing was running */ }
  }, [desktop]);
  // Kept raw so changing the radius or the method re-pairs instantly
  // without re-streaming either cloud — only the pairing depends on them.
  const [loaded, setLoaded] = useState<{
    als: TreeMetric[]; tls: TreeMetric[]; volumes: Map<number, number> | null;
  } | null>(null);

  useEffect(() => {
    if (octreeList.length === 0) return;
    if (!alsDir) setAlsDir(octree?.dir ?? octreeList[0].dir);
    if (!tlsDir) {
      const other = octreeList.find(e => e.dir !== (octree?.dir ?? octreeList[0].dir));
      if (other) setTlsDir(other.dir);
    }
  }, [octreeList, octree, alsDir, tlsDir]);

  // A new dataset list invalidates a result computed from the old one.
  useEffect(() => { setLoaded(null); }, [alsDir, tlsDir]);

  const run = useCallback(async () => {
    if (!desktop || !alsDir || !tlsDir) return;
    setBusy(true); setError(null); setMetricsPct(0); setStopping(false);
    try {
      await api?.save();
      setStage('Measuring the ALS trees');
      const als = await loadTreeMetrics(desktop, alsDir);
      setMetricsPct(0);
      setStage('Measuring the ground-based trees');
      const tls = await loadTreeMetrics(desktop, tlsDir);

      setStage('Reading the stem volumes…');
      let volumes: Map<number, number> | null = null;
      if (desktop.octreeReadQsm) {
        try {
          const qsm = await desktop.octreeReadQsm(tlsDir);
          if (qsm) volumes = new Map(qsm.trees.map(t => [t.treeId, t.stemVolume]));
        } catch { volumes = null; }
      }
      setLoaded({ als, tls, volumes });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLoaded(null);
    } finally {
      setBusy(false); setStage(null); setStopping(false); setMetricsPct(0);
    }
  }, [desktop, alsDir, tlsDir, api]);

  const join: JoinResult | null = useMemo(
    () => (loaded ? joinSensors(loaded.als, loaded.tls, { radius, method }) : null),
    [loaded, radius, method],
  );
  const stats = useMemo(() => (join ? detectionStats(join.rows) : null), [join]);
  const bySize = useMemo(() => (join ? detectionBySize(join.rows) : null), [join]);
  const rows = useMemo(
    () => (join ? toRows(join, loaded?.volumes ?? null) : []),
    [join, loaded],
  );
  const nWithVolume = useMemo(
    () => rows.filter(r => r.tlsStemVolumeM3 != null).length,
    [rows],
  );

  // Fit on the trees BOTH sensors saw, then predict for the ones ALS
  // found and the ground scan did not. Those are the trees the plot
  // total is currently missing entirely.
  const [useModel, setUseModel] = useState(false);
  const model: FittedModel | null = useMemo(() => {
    if (!join || !loaded) return null;
    const pairs: TrainingPair[] = [];
    for (const t of join.rows) {
      if (!t.als || !t.tls) continue;
      const v = loaded.volumes?.get(t.tls.treeId);
      if (v === undefined) continue;
      pairs.push({ als: t.als, volume: v });
    }
    return fitVolumeModel(pairs, DEFAULT_SPEC);
  }, [join, loaded]);

  const predicted = useMemo(() => {
    if (!model || !join) return null;
    let n = 0, extrapolated = 0, total = 0;
    for (const t of join.rows) {
      if (!t.als || t.tls) continue;          // only the ALS-only trees
      const p = predictVolume(model, t.als);
      if (!Number.isFinite(p.volume)) continue;
      n++; total += p.volume;
      if (p.extrapolated) extrapolated++;
    }
    return { n, extrapolated, total };
  }, [model, join]);

  const measuredTotal = useMemo(
    () => rows.reduce((s, r) => s + (r.tlsStemVolumeM3 ?? 0), 0),
    [rows],
  );

  const exportCsv = useCallback(async () => {
    if (rows.length === 0 || !desktop?.saveCsvDialog || !desktop?.writeFile) return;
    const path = await desktop.saveCsvDialog('als_tls_joined.csv');
    if (!path) return;
    const lines = [JOINED_CSV_HEADER.join(',')];
    for (const r of rows) lines.push(rowToCells(r).map(csvField).join(','));
    await desktop.writeFile(path, csvText(lines));
  }, [rows, desktop]);

  const alsName = octreeList.find(e => e.dir === alsDir)?.name ?? '—';
  const tlsName = octreeList.find(e => e.dir === tlsDir)?.name ?? '—';
  const sameDataset = alsDir !== '' && alsDir === tlsDir;

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 460 }}>
      {octreeList.length < 2 && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
          This needs two datasets in the project — an airborne one and a ground-based one over
          the same plot. Import the second, segment and measure both, then come back.
        </div>
      )}

      {/* ---- Inputs ---- */}
      <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <Picker label="ALS (airborne)" value={alsDir} onChange={setAlsDir} list={octreeList} />
        <Picker label="TLS / MLS (ground)" value={tlsDir} onChange={setTlsDir} list={octreeList} />
        {sameDataset && (
          <div className="mono text-[10px] px-1.5 py-1 rounded-sm" style={{ color: '#e6c068', background: 'rgba(230,192,104,0.10)', border: '1px solid rgba(230,192,104,0.35)' }}>
            Both sides are the same dataset — every tree will match itself and the accuracy
            figures will read as perfect. Pick the other sensor.
          </div>
        )}

        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>Search radius (m)</label>
          <input type="range" min={0.5} max={6} step={0.25} value={radius}
            onChange={e => setRadius(parseFloat(e.target.value))} className="flex-1" />
          <span className="mono text-[10px] w-[40px] text-right" style={{ color: 'var(--text)' }}>{radius.toFixed(2)}</span>
        </div>
        <div className="mono text-[9.5px] px-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          An ALS position comes from the crown, a TLS one from the stem. On a leaning or
          lopsided crown those are metres apart, so this is wider than it looks like it
          should be.
        </div>

        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>Matching</label>
          <select
            className="bg-transparent mono text-[10.5px] px-1 py-0.5 flex-1"
            style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
            value={method} onChange={e => setMethod(e.target.value as MatchMethod)}
          >
            <option value="optimal">Optimal (Hungarian)</option>
            <option value="greedy">Greedy nearest — for comparison</option>
          </select>
        </div>
        {method === 'greedy' && (
          <div className="mono text-[9.5px] px-1" style={{ color: '#e6c068', lineHeight: 1.5 }}>
            Greedy is what most papers report, so it is here for a like-for-like number. It
            finds fewer trees: one crown takes the stem another crown needed, and that second
            tree is then reported as seen by one sensor when both saw it.
          </div>
        )}

        <div className="pt-1 flex items-center gap-1.5">
          <button
            className="btn !h-7 !px-2 mono text-[11px] flex-1"
            disabled={busy || !alsDir || !tlsDir || !desktop?.octreeTreeMetrics}
            onClick={() => void run()}
          >
            {busy ? `${stage ?? 'Working'} (${(metricsPct * 100).toFixed(0)} %)…` : loaded ? 'Re-measure both' : 'Measure and join'}
          </button>
          {busy && (
            <button className="btn !h-7 !px-2 mono text-[11px]" onClick={() => void cancel()}
              disabled={!desktop?.octreeCancel || stopping} title="Stop the measurement that is running">
              {stopping ? 'Stopping…' : 'Cancel'}
            </button>
          )}
          {loaded && !busy && (
            <button className="btn !h-7 !px-2 mono text-[11px]" onClick={() => { setLoaded(null); setError(null); }}
              title="Drop the join — nothing was written anywhere">Clear</button>
          )}
        </div>
        {busy && (
          <div className="rounded-sm overflow-hidden" style={{ height: 4, background: 'var(--wash-2)' }}>
            <div style={{ width: `${(metricsPct * 100).toFixed(1)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.15s' }} />
          </div>
        )}
      </div>

      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}

      {/* ---- What came out ---- */}
      {join && stats && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
            {alsName} → {tlsName}
          </div>
          <TallyBar join={join} />
          <div className="grid grid-cols-3 gap-1.5 pt-0.5">
            <Stat label="Recall" value={pct(stats.recall)} hint={`${stats.truePositives} of ${stats.truePositives + stats.falseNegatives} measured stems`} />
            <Stat label="Precision" value={pct(stats.precision)} hint={`${stats.truePositives} of ${stats.truePositives + stats.falsePositives} detections`} />
            <Stat label="F1" value={pct(stats.f1)} hint="harmonic mean" />
          </div>
        </div>
      )}

      {/* ---- The chart the exercise needs ---- */}
      {bySize && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
            Detection rate by diameter class
          </div>
          <SizeChart classes={bySize.classes} />
          <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            One overall rate averages an instrument that sees nearly every large stem with one
            that sees almost no small ones. This is the figure that says what the table below
            can honestly be used for.
          </div>
          {bySize.unclassified.falseNegatives + bySize.unclassified.truePositives > 0 && (
            <div className="mono text-[9.5px]" style={{ color: '#e6c068' }}>
              {bySize.unclassified.falseNegatives + bySize.unclassified.truePositives + bySize.unclassified.falsePositives} tree(s)
              had no usable diameter and are in none of these classes.
            </div>
          )}
        </div>
      )}

      {/* ---- Filling in the trees the ground scan missed ---- */}
      {nWithVolume > 0 && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
            Volume for the trees TLS missed
          </div>
          <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            {describeModel(model)}
          </div>
          {model && predicted && predicted.n > 0 ? (
            <>
              <label className="flex items-center gap-1.5 mono text-[10px]" style={{ color: 'var(--text)' }}>
                <input type="checkbox" checked={useModel} onChange={e => setUseModel(e.target.checked)} />
                Add {predicted.n} predicted tree{predicted.n === 1 ? '' : 's'} to the plot total
              </label>
              <div className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>
                measured {measuredTotal.toFixed(2)} m³
                {useModel && <> + predicted {predicted.total.toFixed(2)} m³ = <b>{(measuredTotal + predicted.total).toFixed(2)} m³</b></>}
              </div>
              {/* The warning that matters more than the model does. */}
              {predicted.extrapolated > 0 && (
                <div className="mono text-[9.5px] px-1.5 py-1 rounded-sm" style={{ color: '#e6c068', background: 'rgba(230,192,104,0.10)', border: '1px solid rgba(230,192,104,0.35)' }}>
                  {predicted.extrapolated} of {predicted.n} predictions are OUTSIDE the range the
                  model was fitted on. That is expected, not a glitch: the trees the ground scan
                  missed are the occluded and the small ones, so they are not a random sample of
                  the trees it matched. Treat these as an estimate of what is there, not a
                  measurement of it.
                </div>
              )}
              <div className="mono text-[9px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
                The error above is cross-validated — the fit&apos;s own R² is measured on the rows
                that produced it and would read better than the model performs.
              </div>
            </>
          ) : (
            <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
              {model
                ? 'Every ALS tree already has a measured volume — nothing to predict.'
                : 'A model needs matched trees with a measured stem volume. Run the Stem QSM on the ground-based dataset, and check the join found pairs.'}
            </div>
          )}
        </div>
      )}

      {/* ---- The deliverable ---- */}
      {rows.length > 0 && (
        <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
          <div className="px-2 py-1 mono text-[10px] flex items-center justify-between" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderBottom: '1px solid var(--line)' }}>
            <span>{rows.length} rows · {nWithVolume} with a stem volume</span>
            <button
              className="btn !h-5 !px-1.5 mono text-[9.5px]"
              disabled={!desktop?.saveCsvDialog}
              onClick={() => void exportCsv()}
            >Export CSV</button>
          </div>
          {nWithVolume === 0 && (
            <div className="px-2 py-1.5 mono text-[9.5px]" style={{ color: '#e6c068', borderBottom: '1px solid var(--line)' }}>
              No stem volumes — run the Stem QSM on the ground-based dataset first, or the
              response column of this table is empty.
            </div>
          )}
          <div className="max-h-[200px] overflow-y-auto scroll-thin">
            <table className="w-full mono text-[10px]" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--text-mute)' }}>
                  <Th>tree</Th><Th>seen by</Th><Th right>sep m</Th>
                  <Th right>DBH cm</Th><Th right>vol m³</Th><Th right>ALS h</Th><Th right>crown m²</Th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 300).map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--line)' }}>
                    <Td>{r.tlsTreeId ?? r.alsTreeId}</Td>
                    <Td>
                      <span style={{ color: DETECTION_COLOUR[r.detection] }}>
                        {r.detection === 'matched' ? 'both' : r.detection === 'alsOnly' ? 'ALS' : 'TLS'}
                      </span>
                    </Td>
                    <Td right>{fmt(r.separationM, 2)}</Td>
                    <Td right>{r.tlsDbhM == null ? '—' : (r.tlsDbhM * 100).toFixed(1)}</Td>
                    <Td right>
                      {r.tlsStemVolumeM3 != null ? fmt(r.tlsStemVolumeM3, 3) : (() => {
                        if (!useModel || !model || r.detection !== 'alsOnly') return '—';
                        const t = join?.rows.find(x => x.als && x.als.treeId === r.alsTreeId && !x.tls);
                        if (!t?.als) return '—';
                        const p = predictVolume(model, t.als);
                        if (!Number.isFinite(p.volume)) return '—';
                        // Predictions are shown in the model's colour and
                        // parenthesised, so no row can be read as measured.
                        return <span style={{ color: p.extrapolated ? '#e6c068' : 'var(--text-mute)' }}>
                          ({p.volume.toFixed(3)})
                        </span>;
                      })()}
                    </Td>
                    <Td right>{fmt(r.alsHeightM, 1)}</Td>
                    <Td right>{fmt(r.alsCrownAreaM2, 1)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 300 && (
            <div className="px-2 py-1 mono text-[9.5px]" style={{ color: 'var(--text-mute)', borderTop: '1px solid var(--line)' }}>
              Showing the first 300 of {rows.length}. The CSV has them all.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- Pieces -----------------------------------------------------------

function pct(v: number): string {
  return Number.isFinite(v) ? `${(v * 100).toFixed(0)} %` : '—';
}
function fmt(v: number | null, dp: number): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(dp);
}

function Picker({ label, value, onChange, list }: {
  label: string; value: string; onChange: (v: string) => void;
  list: { dir: string; name: string }[];
}) {
  return (
    <div className="flex items-center gap-1.5">
      <label className="mono text-[10px] w-[124px]" style={{ color: 'var(--text-dim)' }}>{label}</label>
      <select
        className="bg-transparent mono text-[10.5px] px-1 py-0.5 flex-1"
        style={{ border: '1px solid var(--line)', borderRadius: 3, color: 'var(--text)' }}
        value={value} onChange={e => onChange(e.target.value)}
      >
        {list.length === 0 && <option value="">no datasets</option>}
        {list.map(e => <option key={e.dir} value={e.dir}>{e.name}</option>)}
      </select>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-sm px-1.5 py-1" style={{ background: 'var(--wash-1)' }}>
      <div className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>{label}</div>
      <div className="mono text-[13px]" style={{ color: 'var(--text)' }}>{value}</div>
      <div className="mono text-[8.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>{hint}</div>
    </div>
  );
}

/** Where every tree went, as one bar. Counts are printed as well as
 *  drawn — a bar segment too small to see is still a tree. */
function TallyBar({ join }: { join: JoinResult }) {
  const total = join.rows.length || 1;
  const parts: Array<[Detection, number]> = [
    ['matched', join.nMatched],
    ['tlsOnly', join.nTlsOnly],
    ['alsOnly', join.nAlsOnly],
  ];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-[10px] rounded-sm overflow-hidden" style={{ background: 'var(--wash-2)' }}>
        {parts.map(([k, n]) => n > 0 && (
          <div key={k} style={{ width: `${(n / total) * 100}%`, background: DETECTION_COLOUR[k] }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {parts.map(([k, n]) => (
          <span key={k} className="mono text-[9.5px] flex items-center gap-1" style={{ color: 'var(--text-mute)' }}>
            <span style={{ width: 7, height: 7, borderRadius: 1, background: DETECTION_COLOUR[k], display: 'inline-block' }} />
            {n} {DETECTION_LABEL[k]}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Recall per diameter class. Bars, because the shape of the curve is
 *  the message and a column of percentages is not a shape.
 *
 *  A class with no reference trees is drawn as an explicit gap rather
 *  than a zero bar: nothing was measured there, which is not the same
 *  as nothing being found. */
function SizeChart({ classes }: { classes: Array<{ dbhLow: number; dbhHigh: number; recall: number; nReference: number }> }) {
  const H = 76;
  return (
    <div className="flex items-end gap-1" style={{ height: H + 26 }}>
      {classes.map(c => {
        const known = Number.isFinite(c.recall);
        const h = known ? Math.max(2, c.recall * H) : 0;
        const label = c.dbhHigh === Infinity
          ? `${(c.dbhLow * 100).toFixed(0)}+`
          : `${(c.dbhLow * 100).toFixed(0)}–${(c.dbhHigh * 100).toFixed(0)}`;
        return (
          <div key={c.dbhLow} className="flex-1 flex flex-col items-center gap-0.5" style={{ minWidth: 0 }}>
            <div className="mono text-[8.5px]" style={{ color: 'var(--text-mute)' }}>
              {known ? `${(c.recall * 100).toFixed(0)}` : '—'}
            </div>
            <div className="w-full flex items-end justify-center" style={{ height: H }}>
              {known ? (
                <div
                  title={`${c.nReference} measured stems in this class`}
                  style={{
                    width: '100%', height: h, borderRadius: '2px 2px 0 0',
                    background: c.recall >= 0.8 ? '#67d391' : c.recall >= 0.4 ? '#e6c068' : '#e0817b',
                  }}
                />
              ) : (
                <div className="w-full" style={{ height: 2, background: 'var(--line)' }} title="no measured stems in this class" />
              )}
            </div>
            <div className="mono text-[8.5px]" style={{ color: 'var(--text-dim)' }}>{label}</div>
            <div className="mono text-[8px]" style={{ color: 'var(--text-mute)' }}>n={c.nReference}</div>
          </div>
        );
      })}
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-1.5 py-1 font-normal ${right ? 'text-right' : 'text-left'}`}>{children}</th>;
}
function Td({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <td className={`px-1.5 py-0.5 ${right ? 'text-right' : 'text-left'}`} style={{ color: 'var(--text-dim)' }}>{children}</td>;
}

export { classify };
