// Auto-segment panel — two automatic seed-segmentation tools that both
// write straight into octree.bin (and clear the matching patch overrides),
// surfaced here so their parameter rails don't crowd the editing panels:
//
//   1. Tree crowns (CHM watershed) → writes tree_id
//   2. Laying deadwood (near-ground PCA + DBSCAN) → writes laying_deadwood
//
// Both are seeds the user refines by hand afterwards (Tree review / merge
// for crowns; the Deadwood edit tool for logs).

import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelStage, canCancel } from '../../ui/cancelStage';
import {
  useOctreeShell, DEFAULT_SEGMENT_PARAMS, DEFAULT_DEADWOOD_PARAMS, DEFAULT_LEAFWOOD_PARAMS, DEFAULT_TREEISO_PARAMS,
  DEFAULT_LI2012_PARAMS,
  type SegmentParams, type DeadwoodParams, type LeafWoodParams, type TreeIsoParams,
  type Li2012Params,
} from './OctreeShellContext';
import { isDeadwoodExtra } from '../../persistence/octreeReader';
import { onOctreeProgress } from '../../persistence/octreeStore';
import { confirmDialog } from '../../ui/dialogs';

export default function SegmentPanel() {
  const { octree, api } = useOctreeShell();
  const canRun = !!api && !!octree;
  const hasDeadwood = (octree?.meta.extras ?? []).some(e => isDeadwoodExtra(e.name));

  return (
    <div className="flex flex-col gap-2.5" style={{ width: 264 }}>
      {!canRun && (
        <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Auto-segmentation needs the desktop build and an open dataset.
        </div>
      )}
      <CrownSection canRun={canRun} />
      <TreeIsolationSection canRun={canRun} />
      <Li2012Section canRun={canRun} />
      <LeafWoodSection canRun={canRun} />
      <DeadwoodSection canRun={canRun} hasDeadwood={hasDeadwood} />
    </div>
  );
}

// ---------------- Tree crowns (CHM watershed) ----------------

function CrownSection({ canRun }: { canRun: boolean }) {
  const { api, setDisplay, setFilters } = useOctreeShell();
  const [segParams, setSegParams] = useState<SegmentParams>(DEFAULT_SEGMENT_PARAMS);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setSeg = (patch: Partial<SegmentParams>) => setSegParams(p => ({ ...p, ...patch }));

  // Subscribe to the native "segment" progress channel while a run is in
  // flight so the user sees how far the watershed has got.
  useEffect(() => {
    if (!busy) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((stage, p) => {
      if (stage === 'segment') setPct(p);
    }).then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [busy]);

  const run = useCallback(async () => {
    if (!api) return;
    const hasExisting = api.hasTreeIds();
    const msg = hasExisting
      ? 'This cloud already has tree_id data (e.g. an imported column or a previous run).\n\nAuto-segmentation REPLACES every tree_id with a fresh CHM segmentation — the existing values will be lost. This is saved immediately and can\'t be undone with Ctrl+Z.\n\nContinue?'
      : 'Auto-segmentation writes fresh tree_ids from the CHM, overwriting any existing tree_id data in this cloud. Continue?';
    if (!await confirmDialog(msg)) return;
    setBusy(true); setPct(0); setError(null); setResult(null);
    try {
      const res = await api.segmentChm(segParams);
      setResult(`${res.treeCount.toLocaleString()} trees · ${res.assignedPoints.toLocaleString()} pts`);
      setDisplay({ colorMode: 'tree_id' });
      setFilters({ isolateTreeId: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, segParams, setDisplay, setFilters]);

  return (
    <Drawer title="🌲 Tree crowns" sub="CHM watershed" defaultOpen>
      <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Detects treetops + grows crowns from the CHM. Needs ground classified first.
      </div>
      <Warn>Replaces every tree_id. If this cloud already has tree_id data (e.g. an imported column), it will be overwritten — you'll be asked to confirm.</Warn>
      <Num label="Cell size"        unit="m"     value={segParams.cellSize}        min={0.1} step={0.05} onChange={(v) => setSeg({ cellSize: v })}        hint="CHM resolution." />
      <Num label="Min tree height"  unit="m"     value={segParams.minHeight}       min={0.5} step={0.5}  onChange={(v) => setSeg({ minHeight: v })}       hint="Ignore tops below this." />
      <Num label="Smoothing"        unit="cells" value={segParams.smooth}          min={0}   step={1}    onChange={(v) => setSeg({ smooth: v })}          hint="Box blur to suppress false tops. 0 = off." />
      <Num label="Crown radius"     unit="m"     value={segParams.crownBaseRadius} min={0.5} step={0.5}  onChange={(v) => setSeg({ crownBaseRadius: v })} hint="Min search window for a treetop." />
      <Num label="…per height"      unit="m/m"   value={segParams.crownRadiusPerM} min={0}   step={0.01} onChange={(v) => setSeg({ crownRadiusPerM: v })} hint="Window grows this much per metre of height." />
      <Num label="Max crown radius" unit="m"     value={segParams.crownMaxRadius}  min={1}   step={0.5}  onChange={(v) => setSeg({ crownMaxRadius: v })}  hint="Cap on the search window." />
      <RunButton busy={busy} disabled={!canRun} onClick={run} cancelStages={['segment']} label="Segment trees" busyLabel="Segmenting…" pct={pct} />
      {busy && <ProgressBar pct={pct} />}
      {result && !busy && <Ok>{result}</Ok>}
      {error && <Err>{error}</Err>}
      <div className="mono text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Then open <b>Tree review</b> → <b>Scan trees</b> to list + navigate the crowns.
      </div>
    </Drawer>
  );
}

// ---------------- Laying deadwood (PCA + DBSCAN) ----------------

function DeadwoodSection({ canRun, hasDeadwood }: { canRun: boolean; hasDeadwood: boolean }) {
  const { api, setDisplay } = useOctreeShell();
  const [params, setParams] = useState<DeadwoodParams>(DEFAULT_DEADWOOD_PARAMS);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<DeadwoodParams>) => setParams(p => ({ ...p, ...patch }));

  // Subscribe to the native "deadwood" progress channel while a run is
  // in flight (Rust emits it through every phase: gather, PCA, DBSCAN, write).
  useEffect(() => {
    if (!busy) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((stage, p) => {
      if (stage === 'deadwood') setPct(p);
    }).then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [busy]);

  const run = useCallback(async () => {
    if (!api) return;
    if (!await confirmDialog(
      'Auto-detect laying deadwood writes a fresh segmentation into the laying_deadwood column, OVERWRITING any existing laying-deadwood labelling in this cloud. It\'s a starting point you then refine by hand. This is saved immediately and can\'t be undone with Ctrl+Z.\n\nContinue?',
    )) return;
    setBusy(true); setPct(0); setError(null); setResult(null);
    try {
      const res = await api.segmentDeadwood(params);
      setResult(`${res.logCount.toLocaleString()} logs · ${res.assignedPoints.toLocaleString()} pts`);
      // Show the result + drop into the Laying-deadwood edit workflow
      // (detection writes the laying_deadwood channel).
      setDisplay({ colorMode: 'laying_deadwood' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, params, setDisplay]);

  if (!hasDeadwood) {
    return (
      <Drawer title="🪵 Laying deadwood" sub="PCA + DBSCAN">
        <EnableDeadwood />
      </Drawer>
    );
  }

  return (
    <Drawer title="🪵 Laying deadwood" sub="PCA + DBSCAN">
      <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Finds fallen logs near the ground: keeps points that are locally
        linear with a near-horizontal axis (a log surface), then clusters
        them into separate trunks. A seed for the Deadwood (laying) tool.
        Needs ground classified.
      </div>
      <Warn>Overwrites the laying_deadwood column. You'll be asked to confirm; existing manual laying-deadwood labels are replaced.</Warn>
      <Num label="Ground cell"     unit="m" value={params.cellSize}        min={0.1}  step={0.05} onChange={(v) => set({ cellSize: v })}        hint="DTM resolution for the height band." />
      <div className="flex gap-2">
        <div className="flex-1"><Num label="Height min" unit="m" value={params.hagMin} min={0} step={0.05} onChange={(v) => set({ hagMin: v })} hint="Band low." /></div>
        <div className="flex-1"><Num label="Height max" unit="m" value={params.hagMax} min={0.1} step={0.1} onChange={(v) => set({ hagMax: v })} hint="Band high." /></div>
      </div>
      <Num label="Search radius"   unit="m" value={params.neighborRadius}  min={0.1}  step={0.05} onChange={(v) => set({ neighborRadius: v })}  hint="PCA neighbourhood — must be LARGER than a trunk diameter." />
      <Num label="Min linearity"   unit=""  value={params.minLinearity}    min={0}    max={1} step={0.05} onChange={(v) => set({ minLinearity: v })}   hint="0–1. Higher = stricter ‘elongated’ test." />
      <Num label="Max axis tilt"   unit=""  value={params.maxAxisVerticality} min={0} max={1} step={0.05} onChange={(v) => set({ maxAxisVerticality: v })} hint={`0–1 = |sin(tilt)| of the log axis — currently ${(Math.asin(Math.min(1, Math.max(0, params.maxAxisVerticality))) * 180 / Math.PI).toFixed(0)}° off horizontal. Anything steeper is treated as a standing stem.`} />
      <Num label="Cluster gap"     unit="m" value={params.clusterEps}      min={0.05} step={0.05} onChange={(v) => set({ clusterEps: v })}      hint="DBSCAN distance — points within this join one log." />
      <Num label="Min log points"  unit=""  value={params.minClusterPoints} min={3}   step={1}    onChange={(v) => set({ minClusterPoints: Math.round(v) })} hint="Drop clusters smaller than this." />
      <Num label="Min log length"  unit="m" value={params.minLogLength}    min={0.2}  step={0.1}  onChange={(v) => set({ minLogLength: v })}    hint="Drop clusters shorter than this along their axis." />
      <RunButton busy={busy} disabled={!canRun} onClick={run} cancelStages={['deadwood']} label="Detect deadwood" busyLabel="Detecting…" pct={pct} />
      {busy && <ProgressBar pct={pct} />}
      {result && !busy && <Ok>{result}</Ok>}
      {error && <Err>{error}</Err>}
      <div className="mono text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Then open <b>Tools → Edit → Deadwood</b> (Laying) to fix / add logs the detector missed.
      </div>
    </Drawer>
  );
}

// ---------------- Tree isolation (treeiso cut-pursuit, TLS) ----------------

function TreeIsolationSection({ canRun }: { canRun: boolean }) {
  const { api, setDisplay, setFilters } = useOctreeShell();
  const [params, setParams] = useState<TreeIsoParams>(DEFAULT_TREEISO_PARAMS);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<TreeIsoParams>) => setParams(p => ({ ...p, ...patch }));

  useEffect(() => {
    if (!busy) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((stage, p) => {
      if (stage === 'treeiso') setPct(p);
    }).then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [busy]);

  const run = useCallback(async () => {
    if (!api) return;
    const hasExisting = api.hasTreeIds();
    const msg = hasExisting
      ? 'This cloud already has tree_id data (e.g. an imported column or a previous run).\n\nTree isolation REPLACES every tree_id with a fresh bottom-up segmentation — the existing values will be lost. This is saved immediately and can\'t be undone with Ctrl+Z.\n\nContinue?'
      : 'Tree isolation writes fresh tree_ids from the bottom-up cut-pursuit cascade, overwriting any existing tree_id data in this cloud. Continue?';
    if (!await confirmDialog(msg)) return;
    setBusy(true); setPct(0); setError(null); setResult(null);
    try {
      const res = await api.treeIsolation(params);
      setResult(`${res.treeCount.toLocaleString()} trees · ${res.assignedPoints.toLocaleString()} pts`);
      setDisplay({ colorMode: 'tree_id' });
      setFilters({ isolateTreeId: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, params, setDisplay, setFilters]);

  return (
    <Drawer title="🌲 Tree isolation" sub="cut-pursuit (TLS)">
      <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Bottom-up individual-tree segmentation for dense TLS/MLS (treeiso —
        ℓ0 cut-pursuit cascade, ported from the authors' reference code).
        Better than the CHM crowns where canopies interlock and the
        understorey hides. Needs ground classified — and noise removed,
        which the reference assumes and stage 3 cannot recover from.
      </div>
      <Warn>Replaces every tree_id. If this cloud already has tree_id data it will be overwritten — you'll be asked to confirm.</Warn>
      <Num label="Voxel size"    unit="m" value={params.voxelSize}  min={0.02} step={0.01} onChange={(v) => set({ voxelSize: v })}  hint="Decimation before cut-pursuit. The reference uses 0.05 m; finer keeps a superpoint from bridging two interlocking crowns, but is slower." />
      <Num label="λ superpoints" unit=""  value={params.lambda1}    min={0.01} step={0.05} onChange={(v) => set({ lambda1: v })}    hint="λ1 — stage-1 regularisation. Small = finer over-segmentation. Reference 1.0." />
      <Num label="λ segments"    unit=""  value={params.lambda2}    min={0.1}  step={1}    onChange={(v) => set({ lambda2: v })}    hint="λ2 — stage-2 merge strength. Large = stem-length segments. Reference 20." />
      <Num label="Occlusion gap" unit="m" value={params.maxGap}     min={0.05} step={0.1}  onChange={(v) => set({ maxGap: v })}     hint="Largest point gap taken to be occlusion within ONE tree. Superpoints further apart get no stage-2 edge. Not a merge radius. Reference 2.0." />
      <Num label="Min tree pts"  unit=""  value={params.minTreePts} min={1}    step={1}    onChange={(v) => set({ minTreePts: Math.round(v) })} hint="Drop segments smaller than this (voxel points) — before the stage-3 merge too, so noise is left unassigned instead of glued to a tree." />
      <Drawer title="Stage parameters" sub="reference defaults" defaultOpen={false}>
        <Num label="k stage 1"      unit="" value={params.k1}    min={3} max={40} step={1} onChange={(v) => set({ k1: Math.round(v) })} hint="K1 — the stage-1 3D k-NN graph. Reference 5." />
        <Num label="k stage 2"      unit="" value={params.k2}    min={3} max={60} step={1} onChange={(v) => set({ k2: Math.round(v) })} hint="K2 — both stage-2 searches (superpoint centroids, and the re-decimated nodes). Reference 20." />
        <Num label="Re-decimation"  unit="m" value={params.decimate2} min={0.01} step={0.01} onChange={(v) => set({ decimate2: v })} hint="Each superpoint is re-decimated to this before becoming stage-2 graph nodes. Reference 0.1." />
        <Num label="k stage 3"      unit="" value={params.k3}    min={3} max={60} step={1} onChange={(v) => set({ k3: Math.round(v) })} hint="K3 — how many neighbouring segments a fragment considers. Reference 20." />
        <Num label="ρ height/length" unit="" value={params.rho}  min={0.01} step={0.1} onChange={(v) => set({ rho: v })} hint="A segment whose base sits this many of its own lengths above the lowest of its neighbours is a crown fragment, not a stem. Higher = fewer fragments merged. Reference 0.5." />
        <Num label="w vertical"     unit="" value={params.verticalWeight} min={0} step={0.1} onChange={(v) => set({ verticalWeight: v })} hint="How much vertical overlap counts against horizontal overlap when choosing what to merge a fragment into. Reference 0.5." />
        <button
          className="mono text-[10px] py-1 px-2 rounded-md w-full"
          style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid var(--line)', color: 'var(--text-mute)' }}
          onClick={() => setParams(DEFAULT_TREEISO_PARAMS)}
        >Reset to reference defaults</button>
      </Drawer>
      <RunButton busy={busy} disabled={!canRun} onClick={run} cancelStages={['treeiso']} label="Isolate trees" busyLabel="Isolating…" pct={pct} />
      {busy && <ProgressBar pct={pct} />}
      {result && !busy && <Ok>{result}</Ok>}
      {error && <Err>{error}</Err>}
      <div className="mono text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Then open <b>Tree review</b> → <b>Scan trees</b> to list + navigate the trees.
      </div>
    </Drawer>
  );
}

// ---------------- Li et al. 2012 (point cloud, top-down) ----------------

function Li2012Section({ canRun }: { canRun: boolean }) {
  const { api, setDisplay, setFilters } = useOctreeShell();
  const [params, setParams] = useState<Li2012Params>(DEFAULT_LI2012_PARAMS);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Li2012Params>) => setParams(p => ({ ...p, ...patch }));

  useEffect(() => {
    if (!busy) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((stage, p) => {
      if (stage === 'li2012') setPct(p);
    }).then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [busy]);

  const run = useCallback(async () => {
    if (!api) return;
    const hasExisting = api.hasTreeIds();
    const msg = hasExisting
      ? 'This cloud already has tree_id data (e.g. an imported column or a previous run).\n\nLi 2012 REPLACES every tree_id with a fresh segmentation — the existing values will be lost. This is saved immediately and can\'t be undone with Ctrl+Z.\n\nContinue?'
      : 'Li 2012 writes fresh tree_ids from the top-down point-cloud pass, overwriting any existing tree_id data in this cloud. Continue?';
    if (!await confirmDialog(msg)) return;
    setBusy(true); setPct(0); setError(null); setResult(null);
    try {
      const res = await api.segmentLi2012(params);
      setResult(`${res.treeCount.toLocaleString()} trees · ${res.assignedPoints.toLocaleString()} pts`);
      setDisplay({ colorMode: 'tree_id' });
      setFilters({ isolateTreeId: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, params, setDisplay, setFilters]);

  const voxelTooCoarse = params.voxelSize >= Math.min(params.dt1, params.dt2);

  return (
    <Drawer title="🌲 Li 2012" sub="point cloud, top-down">
      <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Points walked in descending height, each grown into whichever tree it is
        nearest. No canopy raster anywhere — so unlike the CHM crowns above, a
        suppressed stem under a dominant one can still be found: it needs only to
        be nearer its own crown than anyone else&apos;s, not to be a local maximum.
        Needs ground classified first.
      </div>
      <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        The third detector on purpose. It fails differently from the other two,
        which is what makes comparing their accuracies mean anything — run each,
        then check them against the ground-based trees in <b>ALS ↔ TLS join</b>.
      </div>
      <Warn>Replaces every tree_id. If this cloud already has tree_id data it will be overwritten — you&apos;ll be asked to confirm.</Warn>
      <Num label="Voxel size"   unit="m" value={params.voxelSize}    min={0.05} step={0.05} onChange={(v) => set({ voxelSize: v })}   hint="Decimation before the pass. Must stay well under the spacing thresholds below." />
      {voxelTooCoarse && (
        <Warn>
          The voxel ({params.voxelSize} m) is not smaller than the spacing threshold
          ({Math.min(params.dt1, params.dt2)} m). Neighbouring points end up further apart than the
          threshold allows and almost every point becomes its own tree. Lower the voxel,
          or raise the thresholds.
        </Warn>
      )}
      <Num label="dt1 (below Zu)" unit="m" value={params.dt1} min={0.2} step={0.1} onChange={(v) => set({ dt1: v })} hint="Spacing threshold for the understorey, at or below Zu. Paper: 1.5 m." />
      <Num label="dt2 (above Zu)" unit="m" value={params.dt2} min={0.2} step={0.1} onChange={(v) => set({ dt2: v })} hint="Spacing threshold above Zu. LARGER than dt1 — crown width scales with tree height, and the trees up there are the big ones. Paper: 2 m." />
      <Num label="Zu"           unit="m" value={params.zu}           min={0}   step={1}   onChange={(v) => set({ zu: v })}           hint="Height above ground separating the two thresholds. Paper: 15 m." />
      <Num label="LM window"    unit="m" value={params.searchWindow} min={0}   step={0.5} onChange={(v) => set({ searchWindow: v })} hint="A point is held to the dt limit only if it is the highest within HALF this window — i.e. could be a treetop itself. 0 treats every point as one. Paper: 2 m." />
      <Num label="Min height"   unit="m" value={params.minHeight}    min={0}   step={0.5} onChange={(v) => set({ minHeight: v })}    hint="Below this is understorey, never assigned to a tree." />
      <Num label="Min tree pts" unit=""  value={params.minTreePts}   min={1}   step={1}   onChange={(v) => set({ minTreePts: Math.round(v) })} hint="Smaller clusters stay unassigned rather than becoming one-point trees." />
      <Num label="DTM cell"     unit="m" value={params.dtmCell}      min={0.1} step={0.1} onChange={(v) => set({ dtmCell: v })}      hint="Ground grid the height above ground is measured from." />
      <RunButton busy={busy} disabled={!canRun} onClick={run} cancelStages={['li2012']} label="Segment (Li 2012)" busyLabel="Segmenting…" pct={pct} />
      {busy && <ProgressBar pct={pct} />}
      {result && !busy && <Ok>{result}</Ok>}
      {error && <Err>{error}</Err>}
      <div className="mono text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Then open <b>Tree review</b> → <b>Scan trees</b> to list + navigate the trees.
      </div>
    </Drawer>
  );
}

// ---------------- Leaf–wood separation (PCA eigenfeatures) ----------------

function LeafWoodSection({ canRun }: { canRun: boolean }) {
  const { api, setDisplay } = useOctreeShell();
  const [params, setParams] = useState<LeafWoodParams>(DEFAULT_LEAFWOOD_PARAMS);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<LeafWoodParams>) => setParams(p => ({ ...p, ...patch }));

  // Native "leafwood" progress channel (gather → PCA → smooth → write).
  useEffect(() => {
    if (!busy) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((stage, p) => {
      if (stage === 'leafwood') setPct(p);
    }).then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [busy]);

  const run = useCallback(async () => {
    if (!api) return;
    if (!await confirmDialog(
      'Leaf–wood separation writes a fresh wood/leaf label into the semantic column, OVERWRITING any existing semantic labelling (e.g. from AI segmentation or skeleton transfer). This is saved immediately and can\'t be undone with Ctrl+Z.\n\nContinue?',
    )) return;
    setBusy(true); setPct(0); setError(null); setResult(null);
    try {
      const res = await api.leafWood(params);
      const total = res.woodPoints + res.leafPoints;
      const woodPct = total > 0 ? (res.woodPoints / total) * 100 : 0;
      setResult(`${res.woodPoints.toLocaleString()} wood · ${res.leafPoints.toLocaleString()} leaf (${woodPct.toFixed(0)}% wood)`);
      setDisplay({ colorMode: 'semantic' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [api, params, setDisplay]);

  return (
    <Drawer title="🌿 Leaf–wood" sub="PCA eigenfeatures">
      <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Classifies every point wood vs leaf from its local shape: wood is
        linear (branches) or planar (trunk), leaf is scattered. Writes the
        semantic column. Classify ground first so ground surfaces aren't
        called wood. A clean wood set feeds QSM / biomass.
      </div>
      <Warn>Overwrites the semantic column. You'll be asked to confirm; existing semantic labels (AI / skeleton transfer) are replaced.</Warn>
      <Num label="Search radius"  unit="m"      value={params.searchRadius} min={0.02} step={0.01} onChange={(v) => set({ searchRadius: v })}                 hint="PCA neighbourhood — branch/twig scale." />
      <Num label="Min neighbours" unit=""       value={params.minNeighbors} min={3}   step={1}    onChange={(v) => set({ minNeighbors: Math.round(v) })}     hint="Below this a point is called leaf." />
      <Num label="Min linearity"  unit=""       value={params.linearityMin} min={0} max={1} step={0.05} onChange={(v) => set({ linearityMin: v })}           hint="Branch test (λ0−λ1)/λ0. Higher = stricter." />
      <Num label="Min planarity"  unit=""       value={params.planarityMin} min={0} max={1} step={0.05} onChange={(v) => set({ planarityMin: v })}           hint="Trunk-surface test (λ1−λ2)/λ0." />
      <Num label="Max scatter"    unit=""       value={params.scatterMax}   min={0} max={1} step={0.05} onChange={(v) => set({ scatterMax: v })}             hint="Foliage veto λ2/λ0. Lower = stricter wood." />
      <Num label="Smoothing"      unit="passes" value={params.smoothPasses} min={0} max={5} step={1}    onChange={(v) => set({ smoothPasses: Math.round(v) })} hint="Majority-vote cleanup. 0 = off." />
      <RunButton busy={busy} disabled={!canRun} onClick={run} cancelStages={['leafwood']} label="Separate leaf / wood" busyLabel="Separating…" pct={pct} />
      {busy && <ProgressBar pct={pct} />}
      {result && !busy && <Ok>{result}</Ok>}
      {error && <Err>{error}</Err>}
      <div className="mono text-[9.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        Colour by <b>semantic</b> to see wood vs leaf, then run <b>Tree QSM</b> on the wood.
      </div>
    </Drawer>
  );
}

// ---------------- enable deadwood channels in-place ----------------

/** Shown when the dataset was imported without the two reserved deadwood
 *  id columns (the import dialog's opt-out, or a legacy dataset). One
 *  click appends both columns to octree.bin in place — no re-import —
 *  then reloads the dataset so the Deadwood tools light up. */
function EnableDeadwood() {
  const { octree, api, reloadActiveOctree } = useOctreeShell();
  const desktop = (window as unknown as {
    desktop?: { octreeAddDeadwoodColumns?: (dir: string) => Promise<number> };
  }).desktop;
  const canAdd = !!octree && !!desktop?.octreeAddDeadwoodColumns;
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!busy) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    onOctreeProgress((stage, p) => {
      if (stage === 'add_deadwood') setPct(p);
    }).then((u) => { if (cancelled) u(); else unsub = u; });
    return () => { cancelled = true; unsub?.(); };
  }, [busy]);

  const run = useCallback(async () => {
    if (!octree || !desktop?.octreeAddDeadwoodColumns) return;
    setBusy(true); setPct(0); setError(null);
    try {
      // Flush pending edits first — the rewrite preserves point order so
      // patches stay valid, but a saved state keeps the failure modes simple.
      await api?.save();
      await desktop.octreeAddDeadwoodColumns(octree.dir);
      await reloadActiveOctree?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false); setPct(0);
    }
  }, [octree, desktop, api, reloadActiveOctree]);

  return (
    <>
      <div className="mono text-[10px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
        This dataset has no deadwood channels (skipped at import). Add the two
        id columns (standing + laying, 8 bytes/point) to enable deadwood
        detection + labelling — rewrites the dataset in place, no re-import.
      </div>
      <RunButton busy={busy} disabled={!canAdd} onClick={run} label="Add deadwood columns" busyLabel="Adding…" pct={pct} />
      {busy && <ProgressBar pct={pct} />}
      {error && <Err>{error}</Err>}
    </>
  );
}

// ---------------- building blocks ----------------

function Drawer({ title, sub, defaultOpen, children }: {
  title: string; sub: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} className="rounded-md" style={{ border: '1px solid var(--line)' }}>
      <summary className="mono text-[11px] cursor-pointer px-2 py-1.5 flex items-center justify-between" style={{ color: 'var(--text)' }}>
        <span>{title}</span>
        <span className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>{sub}</span>
      </summary>
      <div className="flex flex-col gap-2 px-2 pb-2 pt-1">{children}</div>
    </details>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono text-[9.5px] px-1.5 py-1 rounded" style={{ color: '#e0b84a', background: 'rgba(224,184,74,0.10)', border: '1px solid rgba(224,184,74,0.4)', lineHeight: 1.45 }}>
      ⚠ {children}
    </div>
  );
}
function Ok({ children }: { children: React.ReactNode }) {
  return <div className="mono text-[10.5px]" style={{ color: 'var(--accent)' }}>✓ {children}</div>;
}
function Err({ children }: { children: React.ReactNode }) {
  return <div className="mono text-[10.5px]" style={{ color: 'var(--danger, #e0506b)', lineHeight: 1.5 }}>{children}</div>;
}

function RunButton({ busy, disabled, onClick, label, busyLabel, pct, cancelStages }: {
  busy: boolean; disabled: boolean; onClick: () => void; label: string; busyLabel: string; pct?: number;
  /** The progress stage(s) a Cancel stops. Omitted for a rewrite that
   *  cannot stop half-way (adding columns). */
  cancelStages?: string[];
}) {
  const showPct = busy && typeof pct === 'number' && Number.isFinite(pct);
  return (
    <div className="flex gap-1.5 mt-1">
      <button
        className="btn btn-primary !h-8 flex-1 justify-center mono text-[11.5px]"
        disabled={disabled || busy}
        onClick={onClick}
        title={label}
      >
        {busy ? (showPct ? `${busyLabel} ${Math.round(pct! * 100)}%` : busyLabel) : label}
      </button>
      {busy && cancelStages && (
        <button className="btn !h-8 mono text-[11px] !px-3" onClick={() => cancelStage(...cancelStages)} disabled={!canCancel()}
          title="Stop the run — labels are written only at the end, so a stopped run changes nothing">Cancel</button>
      )}
    </div>
  );
}

/** Slim accent-coloured progress bar, sized to match the run button. */
function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="w-full rounded-full overflow-hidden" style={{ height: 4, background: 'var(--wash-3)' }}>
      <div style={{ width: `${Math.round(Math.max(0, Math.min(1, pct)) * 100)}%`, height: '100%', background: 'var(--accent)', transition: 'width 0.2s' }} />
    </div>
  );
}

// A parameter field that can actually be typed into.
//
// The obvious version — `value={n}` with `parseFloat` on every keystroke,
// clamped to `min` — cannot be. Clearing the field to type a new number
// gives NaN, so it snaps back; "0." is NaN too, so no decimal can be
// entered from the left; and clamping on the keystroke means typing "0.05"
// into a field with min 0.02 rewrites the "0" to "0.02" under the cursor
// before the ".05" arrives. So the TEXT is the state, the number is
// committed whenever the text parses, and the clamp happens on blur —
// where it cannot fight the keyboard.
//
// `Number`, not `parseFloat`: parseFloat takes a valid PREFIX, so a
// half-typed "1e" would commit as 1 with the field still reading "1e".
function Num({ label, unit, value, min, max, step, onChange, hint }: {
  label: string; unit: string; value: number; min: number; max?: number; step: number;
  onChange: (v: number) => void; hint?: string;
}) {
  const [text, setText] = useState(String(value));
  // Follow the caller when IT changes the value (a Reset, a preset) — but
  // not when the value merely echoes back what is already typed, or every
  // keystroke would rewrite the field.
  const committed = useRef(value);
  useEffect(() => {
    if (value !== committed.current) { committed.current = value; setText(String(value)); }
  }, [value]);

  const commit = (t: string) => {
    setText(t);
    const trimmed = t.trim();
    if (trimmed === '') return;
    const v = Number(trimmed);
    if (!Number.isFinite(v)) return;
    committed.current = v;
    onChange(v);
  };
  const clamp = () => {
    const v = Number(text.trim());
    let next = Number.isFinite(v) && text.trim() !== '' ? v : value;
    next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    committed.current = next;
    setText(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="mono text-[10.5px]" style={{ color: 'var(--text)' }}>{label}</span>
        <div className="flex items-center gap-1">
          <input
            type="text" inputMode="decimal" value={text} step={step}
            onChange={(e) => commit(e.target.value)}
            onBlur={clamp}
            spellCheck={false}
            className="w-16 mono text-[11.5px] py-0.5 px-1.5 rounded-md text-right"
            style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)', outline: 'none' }}
          />
          {unit && <span className="mono text-[9px]" style={{ color: 'var(--text-mute)', width: 26 }}>{unit}</span>}
        </div>
      </div>
      {hint && <div className="mono text-[8.5px] mt-0.5" style={{ color: 'var(--text-mute)', lineHeight: 1.3 }}>{hint}</div>}
    </div>
  );
}
