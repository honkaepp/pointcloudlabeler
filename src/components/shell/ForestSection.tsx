// The forest pass in the Segment panel: the stems found and every
// tree grown from them, wood and leaf, in one run (src-tauri commands/forest).
// Recommended over the three crown detectors for TLS / MLS plots: it starts
// from the stems, so interlocking crowns are cut where their wood meets,
// not where a canopy model happens to dip.

import { useCallback, useEffect, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { onOctreeProgress } from '../../persistence/octreeStore';
import { confirmDialog } from '../../ui/dialogs';
import { Drawer, Err, Num, Ok, RunButton, Warn } from './SegmentPanel';
import { DEFAULT_FOREST_PARAMS, forestSummary, forestTimings, type ForestParams, type ForestResult } from './forest';
import {
  clickSeed, deleteSeed, editSeeds, loadForest, mergeTrees, reviewOrder, saveSeeds, setForestState, splitSeed, useForestStore, type SeedMode,
} from './forestStore';
import StemReview, { startStemReview } from './StemReview';
import BranchReview, { startBranchReview } from './BranchReview';

export default function ForestSection({ canRun }: { canRun: boolean }) {
  const { api, octree, setDisplay, setFilters } = useOctreeShell();
  const [params, setParams] = useState<ForestParams>(DEFAULT_FOREST_PARAMS);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState<ForestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ForestParams>) => setParams((p) => ({ ...p, ...patch }));
  const hasReflectance = (octree?.meta.extras ?? []).some((e) => e.name.toLowerCase() === 'reflectance');

  useEffect(() => {
    if (!busy) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((stage, p) => { if (stage === 'forest') setPct(p); }).then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [busy]);
  useEffect(() => { setResult(null); setError(null); if (octree?.dir) void loadForest(octree.dir); }, [octree?.dir]);

  const run = useCallback(async (overrides?: Partial<ForestParams>) => {
    if (!api) return;
    const p = { ...params, ...overrides };
    const msg = `The forest pass writes fresh tree ids${p.writeSemantic ? ' and stem / branch / leaf labels' : ''} for the whole cloud, replacing what is there. This is saved immediately and can't be undone with Ctrl+Z.\n\nContinue?`;
    if (!await confirmDialog(msg)) return;
    setBusy(true); setPct(0); setError(null); setResult(null);
    try {
      if (p.useSavedSeeds) await saveSeeds();
      const res = await api.segmentForest(p);
      setResult(res);
      if (octree?.dir) await loadForest(octree.dir);
      setDisplay({ colorMode: 'tree_id' });
      setFilters({ isolateTreeId: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, params, setDisplay, setFilters, octree?.dir]);

  return (
    <Drawer title="🌲 Forest — stems to trees" sub="recommended" defaultOpen>
      <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Finds the stems (circles in thin slices above the ground, and the
        flow of every branch down to them), then grows each tree from its
        stem over the wood; foliage goes with the branch it hangs from. Wood
        and leaf come from local shape, what each point carries to the
        ground{hasReflectance ? ' and the scanner’s reflectance' : ''}.
        Needs ground classified.
      </div>
      <Warn>Replaces every tree_id{params.writeSemantic ? ' and the semantic labels' : ''}. You'll be asked to confirm.</Warn>
      <Num label="Voxel" unit="m" value={params.voxel} min={0.02} max={0.2} step={0.01} onChange={(v) => set({ voxel: v })}
        hint="The working resolution. 4 cm keeps thin branches; 5–6 cm is faster on large or sparse clouds." />
      <Num label="Ground cut" unit="m" value={params.cut} min={0} max={1.5} step={0.05} onChange={(v) => set({ cut: v })}
        hint="Points lower than this above the ground stay out of the graph — grass and litter would join every stem to every other. Stem feet below it still get their tree." />
      <Num label="Edge buffer" unit="m" value={params.edgeBuffer} min={0} step={0.5} onChange={(v) => set({ edgeBuffer: v })}
        hint="Trees standing this close to the edge of the data are flagged 'edge' (seen from one side, crown cut off) — flagged, not removed." />
      <Num label="Understory below" unit="m" value={params.understory} min={0} step={0.5} onChange={(v) => set({ understory: v })}
        hint="Trees lower than this are flagged 'understory'." />
      <label className="flex items-center justify-between mono text-[10.5px]" style={{ color: hasReflectance ? 'var(--text)' : 'var(--text-mute)' }}
        title={hasReflectance ? 'Bark returns more than leaves at the scanner’s wavelength: blended into the wood likelihood' : 'This cloud has no Reflectance column'}>
        <span>Use reflectance</span>
        <input type="checkbox" checked={params.useReflectance && hasReflectance} disabled={!hasReflectance}
          onChange={(e) => set({ useReflectance: e.target.checked })} />
      </label>
      <label className="flex items-center justify-between mono text-[10.5px]" style={{ color: 'var(--text)' }}
        title="Also write stem / branch / leaf into the semantic column (QSM then models the wood only)">
        <span>Write stem / branch / leaf</span>
        <input type="checkbox" checked={params.writeSemantic} onChange={(e) => set({ writeSemantic: e.target.checked })} />
      </label>
      <RunButton busy={busy} disabled={!canRun} onClick={() => void run({ useSavedSeeds: false })} cancelStages={['forest']}
        label="Find stems and trees" busyLabel="Growing trees…" pct={pct} />
      {result && (
        <>
          <Ok>{forestSummary(result)}</Ok>
          <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
            {result.edgeTrees > 0 && <>{result.edgeTrees} at the edge · </>}
            {result.understoryTrees > 0 && <>{result.understoryTrees} understory · </>}
            {result.workingPoints.toLocaleString()} working points · {forestTimings(result)}
          </div>
        </>
      )}
      {error && <Err>{error}</Err>}
      <SeedEditor busy={busy} onRegrow={() => void run({ useSavedSeeds: true })} />
    </Drawer>
  );
}

const MODES: [SeedMode, string, string][] = [
  ['select', 'Pick', 'Click a stem to see it and the others of its tree'],
  ['add', 'Add', 'Click a missed stem (anywhere up it) to add one there'],
  ['merge', 'Merge', 'Click the stem to keep, then the stems that belong to the same tree'],
  ['delete', 'Delete', 'Click a false stem (a stump, a shrub) to remove it'],
];

/** The stems the forest pass found, corrected by hand: the fast way to fix
 *  a segmentation, then re-grow the trees from the corrected stems. */
function SeedEditor({ busy, onRegrow }: { busy: boolean; onRegrow: () => void }) {
  const { api, setWorldPicker, setFilters } = useOctreeShell();
  const f = useForestStore();
  const [editing, setEditing] = useState(false);
  const [doubtfulFirst, setDoubtfulFirst] = useState(true);
  const reviewing = f.review !== null || f.tieReview !== null;
  // the review takes the viewport's clicks itself
  useEffect(() => { if (reviewing) setEditing(false); }, [reviewing]);
  // while editing, every click in the viewport goes to the stems
  useEffect(() => {
    if (!editing) { setWorldPicker(null); return; }
    setWorldPicker(() => (hit: [number, number, number]) => clickSeed(hit[0], hit[1], hit[2]));
    return () => setWorldPicker(null);
  }, [editing, setWorldPicker]);
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setEditing(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing]);
  if (!f.seeds) {
    return (
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
        The stems are saved beside the dataset (forest/) after a run; then
        they can be corrected here and the trees re-grown from them in
        seconds, the graph being kept.
      </div>
    );
  }
  const seeds = f.seeds;
  const fitted = seeds.filter((s) => s.circles > 0).length;
  const looked = Object.keys(f.marks).length;
  const yours = seeds.filter((s) => s.source === 'user').length;
  const trees = new Set(seeds.map((s) => s.tree)).size;
  const sel = seeds.find((s) => s.id === f.selected) ?? null;
  const look = (x: number, y: number, z: number, isolate?: number) => {
    api?.frameBox([x - 4, y - 4, z - 1], [x + 4, y + 4, z + 22]);
    if (isolate !== undefined) setFilters({ isolateTreeId: isolate });
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-md p-1.5" style={{ border: '1px solid var(--line)' }}>
      <div className="flex items-center justify-between mono text-[10.5px]" style={{ color: 'var(--text)' }}>
        <span>Stems</span>
        <label className="flex items-center gap-1 text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
          show <input type="checkbox" checked={f.visible} onChange={(e) => setForestState({ visible: e.target.checked })} />
        </label>
      </div>
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.45 }}>
        {seeds.length.toLocaleString()} stems → {trees.toLocaleString()} trees · {fitted.toLocaleString()} fitted (green),{' '}
        {(seeds.length - fitted - yours).toLocaleString()} from the flow (amber){yours > 0 ? `, ${yours} yours (blue)` : ''}
        {looked > 0 ? ` · ${looked.toLocaleString()} looked at` : ''}
      </div>
      {f.review !== null ? <StemReview /> : f.tieReview !== null ? <BranchReview /> : (
        <div className="flex flex-col gap-1">
          <button type="button" className="btn !h-7 justify-center mono text-[10.5px]" disabled={busy}
            onClick={() => startStemReview(reviewOrder(seeds, f.suggestions, doubtfulFirst))}
            title="Go through the stems one at a time, from above in a thin slab at breast height: move, measure, add or delete them there">
            Review stems one by one
          </button>
          {f.ties.length > 0 && (
            <button type="button" className="btn !h-7 justify-center mono text-[10.5px]" disabled={busy} onClick={startBranchReview}
              title="Go through the branches the trees nearly gave to another tree, the largest first: move one to the other tree (Ctrl+Z undoes) or pass it as right">
              Review near-tie branches ({f.ties.length.toLocaleString()}{Object.keys(f.tieMarks).length > 0 ? `, ${Object.keys(f.tieMarks).length.toLocaleString()} looked at` : ''})
            </button>
          )}
          <label className="flex items-center gap-1 mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}
            title="Stems found from the flow only, added by hand, without a diameter, of an odd size, sharing a tree or maybe one tree with another come first">
            <input type="checkbox" checked={doubtfulFirst} onChange={(e) => setDoubtfulFirst(e.target.checked)} /> doubtful stems first
          </label>
        </div>
      )}
      {!reviewing && <div className="flex gap-1">
        {MODES.map(([m, label, hint]) => {
          const on = editing && f.mode === m;
          return (
            <button key={m} type="button" title={hint}
              onClick={() => { if (on) { setEditing(false); } else { setForestState({ mode: m }); setEditing(true); } }}
              className="flex-1 rounded py-1 mono text-[10px]"
              style={{
                border: `1px solid ${on ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                background: on ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
                color: on ? 'var(--accent)' : 'var(--text-dim)',
              }}>{label}</button>
          );
        })}
      </div>}
      {editing && (
        <div className="mono text-[9.5px]" style={{ color: 'var(--accent)', lineHeight: 1.4 }}>
          {MODES.find(([m]) => m === f.mode)?.[2]}. Esc or the button again to move the view.
        </div>
      )}
      {sel && !reviewing && (
        <div className="flex flex-col gap-1 mono text-[9.5px]" style={{ color: 'var(--text-dim)' }}>
          <span>
            stem #{sel.id} · tree {sel.tree} · {sel.source}{sel.r > 0 ? ` · ⌀ ${(sel.r * 200).toFixed(1)} cm` : ''}{sel.circles > 0 ? ` · ${sel.circles} circles` : ''}
          </span>
          <div className="flex gap-1">
            <button type="button" className="btn !h-6 !px-1.5 mono text-[9.5px]" onClick={() => look(sel.x, sel.y, sel.z, sel.tree)}>Look</button>
            <button type="button" className="btn !h-6 !px-1.5 mono text-[9.5px]" onClick={() => editSeeds((s) => splitSeed(s, sel.id))}
              disabled={seeds.filter((s) => s.tree === sel.tree).length < 2} title="Make this stem a tree of its own">Own tree</button>
            <button type="button" className="btn !h-6 !px-1.5 mono text-[9.5px]" onClick={() => { editSeeds((s) => deleteSeed(s, sel.id)); setForestState({ selected: null }); }}>Delete</button>
          </div>
        </div>
      )}
      {f.suggestions.length > 0 && (
        <details className="mono text-[9.5px]" style={{ color: 'var(--text-dim)' }}>
          <summary className="cursor-pointer">{f.suggestions.length} pairs may be one tree</summary>
          <div className="flex flex-col gap-0.5 mt-1 max-h-40 overflow-y-auto scroll-thin">
            {f.suggestions.slice(0, 60).map((g) => (
              <div key={`${g.a}-${g.b}`} className="flex items-center gap-1">
                <span className="flex-1">trees {g.a} + {g.b} · {g.votes} {g.votes === 1 ? 'height' : 'heights'}</span>
                <button type="button" className="btn !h-5 !px-1 text-[9px]" onClick={() => look(g.x, g.y, g.z - 3)}>Look</button>
                <button type="button" className="btn !h-5 !px-1 text-[9px]" onClick={() => {
                  editSeeds((s) => mergeTrees(s, g.a, g.b));
                  setForestState({ suggestions: f.suggestions.filter((x) => x !== g) });
                }} title="Grow the two from one stem set at the next re-grow">Merge</button>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="flex gap-1">
        <button type="button" className="btn !h-7 flex-1 justify-center mono text-[10.5px]" disabled={!f.dirty || busy}
          onClick={() => void saveSeeds()}>Save stems</button>
        <button type="button" className="btn btn-primary !h-7 flex-1 justify-center mono text-[10.5px]" disabled={busy}
          onClick={onRegrow} title="Save the stems and grow every tree from them again (the graph is kept: seconds)">Re-grow trees</button>
      </div>
    </div>
  );
}
