// What the trees are coloured by (the 'tree_metric' colour
// mode): a measurement or the QC flag, and where the measurements stand.
// Measuring the plot is a full pass over the cloud, so it is a button
// here and never a side effect of choosing the mode; measurements another
// panel has made are picked up as they are (metrics/loadMetrics.ts).

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { cachedTreeMetrics, loadTreeMetrics, type MetricsSource } from '../../metrics/loadMetrics';
import {
  TREE_METRICS, publishTreeMetrics, subscribeTreeData, treeData, treeMetricDef, treeValues,
} from '../../three/treeMetricColors';

export default function TreeMetricPicker() {
  const { display, setDisplay, octree } = useOctreeShell();
  const store = useSyncExternalStore(subscribeTreeData, treeData);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dir = octree?.dir ?? '';
  const mine = store.dir === dir;
  const rows = mine ? store.rows : null;
  const pairs = mine ? store.pairs : null;
  const metric = treeMetricDef(display.treeMetric);
  const desktop = (window as unknown as { desktop?: MetricsSource }).desktop;

  const lookAgain = () => {
    if (!dir) return;
    void cachedTreeMetrics(desktop, dir).then((hit) => { if (hit) publishTreeMetrics(dir, hit.rows); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(lookAgain, [dir]);

  /** `again`: a fresh pass, not the cached one (the user asked for it). */
  const measure = async (again: boolean) => {
    if (!dir) return;
    setBusy(true); setError(null);
    try {
      publishTreeMetrics(dir, await loadTreeMetrics(desktop, dir, undefined, again ? { force: true } : undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const coloured = treeValues(metric.id, rows, pairs, mine ? store.qc : null).size;
  return (
    <div>
      <div className="chip mb-1.5">Trees by</div>
      <div className="grid grid-cols-2 gap-1">
        {TREE_METRICS.map((m) => {
          const active = metric.id === m.id;
          const off = m.growth && !pairs;
          return (
            <button key={m.id} type="button" disabled={off} onClick={() => setDisplay({ treeMetric: m.id })}
              title={off ? `${m.hint} — pair the two epochs in the Tree growth panel first` : m.hint}
              className="rounded-md px-2 py-1 mono text-[10.5px] text-left"
              style={{
                border: `1px solid ${active ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                background: active ? 'color-mix(in oklch, var(--accent) 10%, transparent)' : 'transparent',
                color: off ? 'var(--text-mute)' : active ? 'var(--text)' : 'var(--text-dim)',
                opacity: off ? 0.55 : 1,
              }}>
              {m.label}{m.unit ? <span style={{ color: 'var(--text-mute)' }}> {m.unit}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="mono text-[9.5px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
        {metric.growth
          ? pairs ? `${coloured} trees paired with the earlier epoch.` : 'Pair the epochs in the Tree growth panel to colour by growth.'
          : rows ? `${rows.length} trees measured, ${coloured} with a ${metric.label.toLowerCase()}.` : 'The trees have not been measured yet.'}
      </div>
      {!metric.growth && (
        <div className="flex gap-1 mt-1.5">
          <button type="button" className="btn !h-7 flex-1 justify-center mono text-[10.5px]" disabled={!dir || busy || !desktop?.octreeTreeMetrics}
            onClick={() => void measure(!!rows)}
            title="Measure every tree of the plot (height, DBH, crown, lean) — a pass over the whole cloud; the other panels then have the numbers too">
            {busy ? 'Measuring…' : rows ? 'Measure again' : 'Measure the trees'}
          </button>
          {!rows && (
            <button type="button" className="btn !h-7 mono text-[10.5px]" onClick={lookAgain} disabled={!dir}
              title="Look for measurements another panel has made since">↻</button>
          )}
        </div>
      )}
      {error && <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--danger, #e0506b)', lineHeight: 1.4 }}>{error}</div>}
    </div>
  );
}
