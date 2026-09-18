// Stem centerline extraction — surface TreeQSM v2's trunk segmentation
// (Raumonen 2013 §2.3 cover-graph walk + §2.5 cylinder fitting) as a
// standalone tool that draws per-tree polylines in the 3D viewport.
//
// The full QSM panel already builds these chains internally but
// flattens them to QsmSlice records and discards the 3D endpoints. This
// panel calls the trunk-only path (no branch reconstruction, ~25 % of
// the full cost) and pushes the resulting polylines into shell state;
// OctreeView renders them as coloured LineSegments overlays. Useful
// for leaning / curved / asymmetric stems where a single-slice DBH
// reading would otherwise mislead.

import { useCallback, useEffect, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { csvNum, csvBlob } from '../../io/csv';
import { saveCsvFile } from '../../io/saveDownload';

interface CenterlineNode { x: number; y: number; z: number; radius: number }
interface TreeCenterline {
  treeId: number;
  nodes: CenterlineNode[];
  length: number;
  leanDeg: number;
}
interface Result {
  trees: TreeCenterline[];
  /** The run was stopped by the user; `trees` holds what was fitted
   *  before that. */
  stopped?: boolean;
}
interface Desktop {
  octreeStemCenterlines?: (
    octreeDir: string,
    opts?: { rCover?: number; onlyTreeId?: number; minTreePoints?: number; dtmCell?: number },
  ) => Promise<Result>;
  octreeCancel?: (stage: string) => Promise<boolean>;
  onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void> | (() => void);
}

export default function StemCenterlinePanel() {
  const { octree, addAnalysisLayer, removeAnalysisLayer } = useOctreeShell();
  // The plot's centrelines are a layer in the Layers panel — hidden,
  // shown, saved with the dataset or removed there as well as here.
  const PLOT_LAYER = 'centerlines-plot';
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;

  // r_cover (m × 100 — slider in cm). 4 cm matches TreeQSM v2 default.
  // create_input.m's PatchDiam1 = [0.08 0.12]. The whole eight-model
  // sweep is scaled from the first of those, so 8 cm IS the reference's
  // default set; 4 cm — which this was — is half of it on every tree.
  const [rCoverCm, setRCoverCm] = useState(8);
  // Minimum tree points (skip sparse / tiny trees).
  // The reference applies no minimum tree size at all, and the backend
  // was deliberately lowered from 200 to 30 because a 200-point floor
  // silently skipped small and partly occluded trees. This panel then
  // passed 200 anyway and put the floor straight back. Zero here means
  // "whatever the cover generation itself needs", which is the
  // backend's own precondition of thirty points.
  const [minPts, setMinPts] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  // A run streams the whole cloud and then fits every tree — minutes on
  // a large plot — and it used to show nothing but a busy label, with no
  // way to stop it. The backend reports on the "centerlines" channel
  // and honours a stop on the same name, between trees.
  const [pct, setPct] = useState(0);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (!desktop?.onOctreeProgress) return;
    let off: (() => void) | undefined;
    void Promise.resolve(desktop.onOctreeProgress((e) => {
      if (e.stage === 'centerlines') setPct(e.pct);
    })).then((f) => { off = f; });
    return () => { off?.(); };
  }, [desktop]);

  const run = useCallback(async () => {
    if (!desktop?.octreeStemCenterlines || !octree?.dir) return;
    setBusy(true); setError(null); setNote(null); setPct(0); setStopping(false);
    try {
      const r = await desktop.octreeStemCenterlines(octree.dir, {
        rCover: rCoverCm * 0.01,
        minTreePoints: minPts,
      });
      setResult(r);
      if (r.trees.length > 0) {
        addAnalysisLayer({
          id: PLOT_LAYER, kind: 'centerlines',
          label: `Stem centrelines · ${octree.meta.name}`,
          source: `Stem centerlines · PatchDiam1 ${rCoverCm} cm · min ${minPts} points${r.stopped ? ' · stopped early' : ''}`,
          payload: { kind: 'centerlines', overlay: { trees: r.trees.map(t => ({ treeId: t.treeId, nodes: t.nodes })) } },
        });
      } else {
        void removeAnalysisLayer(PLOT_LAYER);
      }
      if (r.stopped) setNote(`Stopped — ${r.trees.length} tree${r.trees.length === 1 ? '' : 's'} fitted before that are kept.`);
      else if (r.trees.length === 0) setNote('No tree yielded a centreline — none had enough points above ground, or the cloud carries no tree ids.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false); setStopping(false); setPct(0);
    }
  }, [desktop, octree?.dir, octree?.meta.name, rCoverCm, minPts, addAnalysisLayer, removeAnalysisLayer]);

  const cancel = useCallback(async () => {
    if (!desktop?.octreeCancel) return;
    setStopping(true);
    try { await desktop.octreeCancel('centerlines'); } catch { /* nothing was running */ }
  }, [desktop]);

  const clearOverlay = useCallback(() => {
    void removeAnalysisLayer(PLOT_LAYER);
    setResult(null);
  }, [removeAnalysisLayer]);

  const exportCsv = useCallback(() => {
    if (!result || result.trees.length === 0) return;
    const rows = ['tree_id,length_m,lean_deg,n_nodes'];
    result.trees.forEach(t => {
      rows.push([t.treeId, csvNum(t.length, 2), csvNum(t.leanDeg, 2), t.nodes.length].join(','));
    });
    void saveCsvFile(rows, 'stem-centerlines.csv');
  }, [result]);

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 360 }}>
      {error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: '#e0506b', background: 'rgba(224,80,107,0.10)', border: '1px solid rgba(224,80,107,0.45)' }}>{error}</div>
      )}
      {note && !error && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', border: '1px solid var(--line)' }}>{note}</div>
      )}

      <div className="rounded-md p-2 flex flex-col gap-1.5" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>PatchDiam1</label>
          <input type="range" min={2} max={20} step={1}
            value={rCoverCm} onChange={(e) => setRCoverCm(parseInt(e.target.value, 10))}
            className="flex-1" disabled={busy} />
          <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{rCoverCm} cm</span>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="mono text-[10px] w-[120px]" style={{ color: 'var(--text-dim)' }}>Min tree points</label>
          <input type="range" min={0} max={2000} step={10}
            value={minPts} onChange={(e) => setMinPts(parseInt(e.target.value, 10))}
            className="flex-1" disabled={busy} />
          <span className="mono text-[10px] w-[44px] text-right" style={{ color: 'var(--text)' }}>{minPts}</span>
        </div>
        <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.4 }}>
          8 cm is create_input.m&rsquo;s own PatchDiam1, which the
          eight-model sweep is scaled from; smaller resolves finer stem
          detail at the cost of more covers. The reference applies no
          minimum tree size, so zero is what matches it — raising it
          skips small trees instead of attempting them.
        </div>
      </div>

      <div className="flex gap-1.5">
        <button
          className="btn !h-8 mono text-[11.5px] justify-center flex-1"
          disabled={!desktop?.octreeStemCenterlines || !octree?.dir || busy}
          onClick={run}
        >
          {busy ? `Extracting centrelines (${(pct * 100).toFixed(0)} %)…` : 'Run centreline extraction'}
        </button>
        {busy && (
          <button className="btn !h-8 mono text-[11.5px] !px-3" onClick={() => void cancel()}
            disabled={!desktop?.octreeCancel || stopping}
            title="Stop between trees — the ones already fitted are kept">
            {stopping ? 'Stopping…' : 'Cancel'}
          </button>
        )}
        {result && !busy && (
          <button className="btn !h-8 mono text-[11.5px] !px-3" onClick={clearOverlay}>
            Clear
          </button>
        )}
      </div>
      {busy && (
        <div className="rounded-sm overflow-hidden" style={{ height: 4, background: 'var(--wash-2)' }} title={`${(pct * 100).toFixed(0)} %`}>
          <div style={{ width: `${(pct * 100).toFixed(1)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.15s' }} />
        </div>
      )}

      {result && (
        <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
          <div className="px-2 py-1 mono text-[10px] flex items-center justify-between"
            style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderBottom: '1px solid var(--line)' }}>
            <span>Trees ({result.trees.length})</span>
            <button className="btn !h-5 !px-1.5 mono text-[10px]" onClick={exportCsv} disabled={result.trees.length === 0}>CSV</button>
          </div>
          {result.trees.length === 0 ? (
            <div className="mono text-[10.5px] px-2 py-2" style={{ color: 'var(--text-mute)' }}>
              No tree met the minimum point count — try lowering it, or
              segment trees first.
            </div>
          ) : (
            <div className="max-h-[320px] overflow-y-auto scroll-thin">
              {result.trees.map(t => (
                <CenterlineRow key={t.treeId} t={t} />
              ))}
            </div>
          )}
        </div>
      )}

      {!result && (
        <div className="mono text-[10.5px] px-1.5 py-2" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
          Runs TreeQSM v2's trunk segmentation (Raumonen 2013) on each
          segmented tree and draws the resulting polyline in the 3D
          viewport. Useful for leaning or curved stems where a single
          DBH reading wouldn't capture the geometry. Requires trees to
          be segmented (Auto-segment panel) and the Terrain panel to
          have run (needs the DTM for the ground filter).
        </div>
      )}
    </div>
  );
}

function CenterlineRow({ t }: { t: TreeCenterline }) {
  const leanColor = t.leanDeg >= 10 ? '#e0817b' : t.leanDeg >= 5 ? '#e6c068' : 'var(--text-dim)';
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1.5"
      style={{ borderBottom: '1px solid var(--line)' }}>
      <div className="flex items-center gap-2 mono text-[11px]">
        <span style={{ color: 'var(--text)', minWidth: 64 }}>Tree {t.treeId}</span>
        <span style={{ color: 'var(--accent)' }}>{t.length.toFixed(1)} m</span>
        <span className="flex-1" />
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
          {t.nodes.length} nodes
        </span>
      </div>
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
        lean <span style={{ color: leanColor }}>{t.leanDeg.toFixed(1)}°</span>
      </div>
    </div>
  );
}
