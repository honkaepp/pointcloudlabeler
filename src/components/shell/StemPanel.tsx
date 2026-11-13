// Stems — a tree's stem measured the way it is in the field: diameter
// with calipers at any height above the ground (DBH at 1.3 m, d6 at
// 6 m, or a taper series up the stem), the tree's height, and the
// stem's length.
//
// The same instrument as the Branches panel (measureUi.tsx): a thin
// section across the stem, perpendicular to its own axis, read with
// caliper jaws — one reading or two at right angles — that can be
// turned and dragged by hand. What is particular to a stem:
//
//   WHERE. A diameter is asked for at a height above the ground, so
//   the ground under the stem is found first: the dataset's classified
//   ground (DTM) under the stem's foot, or, with no ground class, the
//   stem's lowest point — or a point the user clicks. The stem is then
//   followed up from its foot by circles fitted to thin slabs
//   (trackStem), which finds the stem at 6 m among the branches that
//   leave it there, where a centroid would be dragged into the crown.
//
//   WHICH POINTS. The isolated tree's points as they are; only those
//   labelled stem (semantic 1, from Tree Skeleton Transfer or leaf–wood
//   separation); or a stem cut out by hand with the lasso, which is
//   then painted like a branch.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import {
  sectionAt, minWidthAngle, readSection, trackStem, stemFoot, highestPoint, makeZIndex,
  branchPath, polylineLength, type Vec3, type ZIndex,
} from '../../metrics/branchMeasure';
import {
  membersFromSelection, createBranch, assignToBranch, removeFromBranch, deleteBranch, updateBranch,
  addDiameter, addDiameters, addLength, removeMeasurement, promoteMeasurement, diameterOfRole, primaryLength,
  branchColorHex, branchSummaryCsv, measurementsCsv, newMeasurementId, stemOf,
  type BranchFile, type BranchRecord, type DiameterMeasurement, type DiameterRole, type LengthMeasurement,
} from '../../persistence/branchStore';
import { sectionOverlay, pathOverlay, mergeOverlays, boundsOf } from './branchOverlay';
import { saveCsvFile } from '../../io/saveDownload';
import { confirmDialog } from '../../ui/dialogs';
import { parseTerrainGrid, sampleGround, type TerrainGrid } from '../../three/terrainGrid';
import {
  nowIso, mm, ERR_STYLE, BOX_STYLE, ACTIVE_BTN, Slider, Seg, ModeSeg, SectionReader, LengthDraftView, SavedMeasurements,
  useReading, diameterFrom, type SectionRead, type LengthDraft,
} from './measureUi';

type Source = 'tree' | 'stemLabel' | 'cut';

interface Ground {
  z: number;
  from: 'dtm' | 'lowest' | 'picked';
  /** The tree (or stem record) it was found for. */
  key: string;
}

interface DtmBridge { octreeDtmGrid?: (dir: string, cell?: number) => Promise<ArrayBuffer> }

const GROUND_TEXT: Record<Ground['from'], string> = {
  dtm: 'classified ground under the stem',
  lowest: 'the stem’s lowest point — the cloud has no ground class',
  picked: 'clicked',
};

const onlyStems = (f: BranchFile): BranchFile => ({ ...f, branches: f.branches.filter(b => b.kind === 'stem') });

export default function StemPanel() {
  const {
    api, octree, filters, selectedCount, setWorldPicker, editMode, setEditMode, setTools,
    branchFile, updateBranches, branchError, setBranchOverlay,
  } = useOctreeShell();

  const treeId = filters.isolateTreeId;
  const stems = branchFile.branches.filter(b => b.kind === 'stem');
  const [pickedId, setPickedId] = useState<number | null>(null);
  // The stem worked on: the isolated tree's, or one picked in the list.
  const stem: BranchRecord | null = treeId !== null
    ? stemOf(branchFile, treeId)
    : stems.find(s => s.id === pickedId) ?? null;
  const stemTree = treeId ?? stem?.treeId ?? null;

  const [source, setSource] = useState<Source>('tree');
  useEffect(() => {
    // A stem cut out by hand is the obvious source when there is one.
    setSource(stem && stem.members.length > 0 ? 'cut' : 'tree');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stemTree, stem?.id]);

  const [thicknessMm, setThicknessMm] = useState(20);
  const [radiusMm, setRadiusMm] = useState(400);
  const [trimPct, setTrimPct] = useState(0);
  const [mode, setMode] = useState<'cross' | 'single'>('cross');
  const [heightM, setHeightM] = useState(1.3);
  const [seriesFrom, setSeriesFrom] = useState(0.5);
  const [seriesStep, setSeriesStep] = useState(1);
  const [cellMm, setCellMm] = useState(50);
  const [labelSemantic, setLabelSemantic] = useState(false);

  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [picking, setPicking] = useState<null | 'section' | 'path' | 'ground'>(null);
  const [read, setRead] = useState<SectionRead | null>(null);
  const [draft, setDraft] = useState<LengthDraft | null>(null);
  const [ground, setGround] = useState<Ground | null>(null);
  const [busy, setBusy] = useState(false);
  const trim = trimPct / 100;
  const key = `${octree?.dir ?? ''}|${stemTree ?? ''}|${source}`;

  // Everything measured goes when the tree or the points change.
  useEffect(() => { setRead(null); setDraft(null); setGround(g => (g && g.key === key ? g : null)); }, [key]);

  // ---- Points -------------------------------------------------------
  const ptsCache = useRef<{ key: string; version: number; xyz: Float64Array; zi: ZIndex } | null>(null);
  const [ptsVersion, setPtsVersion] = useState(0);
  const [ptsCount, setPtsCount] = useState<number | null>(null);
  const points = useCallback((): { xyz: Float64Array; zi: ZIndex } | null => {
    if (!api) return null;
    const c = ptsCache.current;
    if (c && c.key === key && c.version === ptsVersion) return c;
    let xyz: Float64Array;
    if (source === 'cut') {
      if (!stem || stem.members.length === 0) return null;
      xyz = api.pointsWorld(stem.members).xyz;
    } else {
      if (stemTree === null) return null;
      xyz = api.treePointsWorld(stemTree, source === 'stemLabel' ? 1 : undefined);
    }
    setPtsCount(xyz.length / 3);
    if (xyz.length < 30) return null;
    const next = { key, version: ptsVersion, xyz, zi: makeZIndex(xyz) };
    ptsCache.current = next;
    return next;
  }, [api, key, ptsVersion, source, stem, stemTree]);
  useEffect(() => { setPtsCount(null); }, [key]);

  // ---- Ground -------------------------------------------------------
  const dtmCache = useRef<{ dir: string; grid: TerrainGrid | null } | null>(null);
  const ensureGround = useCallback(async (xyz: Float64Array): Promise<Ground | null> => {
    if (ground && ground.key === key) return ground;
    const foot = stemFoot(xyz);
    if (!foot) return null;
    const dir = octree?.dir;
    let grid: TerrainGrid | null = null;
    if (dir) {
      if (dtmCache.current?.dir === dir) grid = dtmCache.current.grid;
      else {
        const d = (window as unknown as { desktop?: DtmBridge }).desktop;
        try {
          grid = d?.octreeDtmGrid ? parseTerrainGrid(await d.octreeDtmGrid(dir, 0.5)) : null;
        } catch {
          grid = null; // no ground class in this cloud
        }
        dtmCache.current = { dir, grid };
      }
    }
    const g: Ground = grid
      ? { z: sampleGround(grid, foot[0], foot[1]), from: 'dtm', key }
      : { z: foot[2], from: 'lowest', key };
    setGround(g);
    return g;
  }, [ground, key, octree?.dir]);

  const pickGround = useCallback(() => {
    if (picking === 'ground') { setWorldPicker(null); setPicking(null); return; }
    setPicking('ground');
    setWorldPicker(() => (hit: [number, number, number]) => {
      setWorldPicker(null);
      setPicking(null);
      setGround({ z: hit[2], from: 'picked', key });
      setRead(null);
    });
  }, [picking, setWorldPicker, key]);

  // ---- Stem record ----------------------------------------------------
  /** The stem record to save on, created on first use. */
  const ensureStem = useCallback((): number | null => {
    if (stem) return stem.id;
    if (stemTree === null) return null;
    let id: number | null = null;
    updateBranches(f => {
      const existing = stemOf(f, stemTree);
      if (existing) { id = existing.id; return f; }
      const r = createBranch(f, [], stemTree, nowIso(), 'stem');
      id = r.id;
      return r.file;
    });
    return id;
  }, [stem, stemTree, updateBranches]);

  // ---- Picking --------------------------------------------------------
  const stopPicking = useCallback(() => { setWorldPicker(null); setPicking(null); }, [setWorldPicker]);
  useEffect(() => () => { setWorldPicker(null); setBranchOverlay(null); }, [setWorldPicker, setBranchOverlay]);

  // ---- Cutting --------------------------------------------------------
  const cutStem = useCallback((remove: boolean) => {
    if (!api) return;
    const sel = membersFromSelection(api.getSelection());
    if (sel.length === 0) { setMsg({ text: 'Nothing is selected. Lasso the stem’s points first.', error: true }); return; }
    if (remove) {
      if (stem) updateBranches(f => removeFromBranch(f, stem.id, sel, nowIso()));
    } else if (stem) {
      updateBranches(f => assignToBranch(f, stem.id, sel, nowIso()));
    } else {
      updateBranches(f => createBranch(f, sel, treeId, nowIso(), 'stem').file);
    }
    if (!remove && labelSemantic) api.applyToSelection({ semantic: 1 });
    api.clearSelection();
    setPtsVersion(v => v + 1);
  }, [api, stem, treeId, updateBranches, labelSemantic]);

  // ---- Diameter -------------------------------------------------------
  /** Cut the section where the stem crosses `h` metres above the ground. */
  const sectionAtHeight = useCallback(async (h: number, keepTheta?: number) => {
    const p = points();
    if (!p) { setMsg({ text: stemTree === null ? 'Isolate a tree in Tree review first.' : 'No points to measure on — is the tree loaded, and does the source hold points?', error: true }); return; }
    setBusy(true);
    try {
      const g = await ensureGround(p.xyz);
      const foot = stemFoot(p.xyz);
      if (!g || !foot) return;
      const t = trackStem(p.xyz, [foot[0], foot[1], Math.max(foot[2], g.z)], g.z + h, { maxRadius: radiusMm / 1000, zIndex: p.zi });
      if (!t) { setMsg({ text: 'Could not follow the stem up to that height.', error: true }); return; }
      const s = sectionAt(p.xyz, t.at, { axisRadius: 0.5, halfThickness: thicknessMm / 2000, maxRadius: radiusMm / 1000, axis: t.axis });
      if (!s || s.count < 5) { setMsg({ text: `No stem points at ${h.toFixed(2)} m. Is the stem scanned there?`, error: true }); return; }
      setMsg(null);
      setRead({ section: s, theta: keepTheta ?? minWidthAngle(s.pts, trim), manual: [null, null], heightAboveGround: h, groundZ: g.z });
    } finally {
      setBusy(false);
    }
  }, [points, ensureGround, radiusMm, thicknessMm, trim, stemTree]);

  const pickSection = useCallback(() => {
    if (picking === 'section') { stopPicking(); return; }
    setPicking('section');
    setWorldPicker(() => (hit: [number, number, number]) => {
      setWorldPicker(null);
      setPicking(null);
      void (async () => {
        const p = points();
        if (!p) return;
        const g = await ensureGround(p.xyz);
        if (!g) return;
        const h = Math.max(0.05, hit[2] - g.z);
        setHeightM(Math.round(h * 100) / 100);
        void sectionAtHeight(h);
      })();
    });
  }, [picking, stopPicking, setWorldPicker, points, ensureGround, sectionAtHeight]);

  const nudge = useCallback((dMm: number) => {
    if (!read || read.heightAboveGround == null) return;
    const h = Math.max(0.01, read.heightAboveGround + dMm / 1000);
    setHeightM(Math.round(h * 1000) / 1000);
    void sectionAtHeight(h, read.theta);
  }, [read, sectionAtHeight]);

  const reading = useReading(read, mode, trim);

  const saveDiameter = useCallback((role: DiameterRole) => {
    if (!read || !reading) return;
    const id = ensureStem();
    if (id === null) return;
    const d: DiameterMeasurement = diameterFrom(read, reading, role, mode, trim, newMeasurementId('d'));
    updateBranches(f => addDiameter(f, id, d, nowIso()));
    setMsg({ text: `${role === 'dbh' ? 'DBH' : role === 'd6' ? 'd6' : 'Diameter'} ${mm(d.diameter)} at ${(d.heightAboveGround ?? 0).toFixed(2)} m saved.` });
  }, [read, reading, ensureStem, mode, trim, updateBranches]);

  /** Read the stem every `seriesStep` metres from `seriesFrom` to a
   *  metre short of the top, with the jaws closed on the points (no hand
   *  adjustment), each saved as an 'other' reading at its height. */
  const taperSeries = useCallback(async () => {
    const p = points();
    if (!p) { setMsg({ text: 'No points to measure on.', error: true }); return; }
    const id = ensureStem();
    if (id === null) return;
    setBusy(true);
    try {
      const g = await ensureGround(p.xyz);
      const foot = stemFoot(p.xyz);
      const top = highestPoint(p.xyz);
      if (!g || !foot || !top) return;
      const out: DiameterMeasurement[] = [];
      let missed = 0;
      for (let h = seriesFrom; h <= top[2] - g.z - 1 + 1e-9; h += seriesStep) {
        const t = trackStem(p.xyz, [foot[0], foot[1], Math.max(foot[2], g.z)], g.z + h, { maxRadius: radiusMm / 1000, zIndex: p.zi });
        const s = t && sectionAt(p.xyz, t.at, { axisRadius: 0.5, halfThickness: thicknessMm / 2000, maxRadius: radiusMm / 1000, axis: t.axis });
        if (!s || s.count < 8) { missed++; continue; }
        const theta = minWidthAngle(s.pts, trim);
        const r = readSection(s.pts, theta, mode, trim);
        out.push(diameterFrom(
          { section: s, theta, manual: [], heightAboveGround: Math.round(h * 1000) / 1000, groundZ: g.z },
          r, 'other', mode, trim, newMeasurementId('d'),
        ));
      }
      if (out.length > 0) updateBranches(f => addDiameters(f, id, out, nowIso()));
      setMsg({ text: `Taper series: ${out.length} reading(s) saved${missed ? `, ${missed} height(s) without enough stem points skipped` : ''}.` });
    } finally {
      setBusy(false);
    }
  }, [points, ensureStem, ensureGround, seriesFrom, seriesStep, radiusMm, thicknessMm, trim, mode, updateBranches]);

  const showDiameter = useCallback((d: DiameterMeasurement) => {
    setMode(d.mode);
    setTrimPct(Math.round(d.trim * 1000) / 10);
    setThicknessMm(Math.round(d.halfThickness * 2000));
    setRadiusMm(Math.round(d.maxRadius * 1000));
    const p = points();
    if (!p) { setMsg({ text: 'The stem’s points are not loaded.', error: true }); return; }
    const s = sectionAt(p.xyz, d.center, { axisRadius: 0.5, halfThickness: d.halfThickness, maxRadius: d.maxRadius, axis: d.axis });
    if (s) setRead({ section: s, theta: d.theta, manual: [null, null], heightAboveGround: d.heightAboveGround, groundZ: d.groundZ });
  }, [points]);

  // ---- Height and length --------------------------------------------
  const measureHeight = useCallback(async () => {
    stopPicking();
    const p = points();
    if (!p) { setMsg({ text: 'No points to measure on.', error: true }); return; }
    const g = await ensureGround(p.xyz);
    const foot = stemFoot(p.xyz);
    const top = highestPoint(p.xyz);
    if (!g || !foot || !top) return;
    setDraft({ method: 'height', nodes: [[foot[0], foot[1], g.z], top], length: top[2] - g.z });
  }, [stopPicking, points, ensureGround]);

  const followStem = useCallback(async () => {
    stopPicking();
    const p = points();
    if (!p) { setMsg({ text: 'No points to measure on.', error: true }); return; }
    const g = await ensureGround(p.xyz);
    const foot = stemFoot(p.xyz);
    if (!g || !foot) return;
    const path = branchPath(p.xyz, foot, cellMm / 1000);
    if (!path) return;
    const nodes: Vec3[] = [[foot[0], foot[1], g.z], ...path.nodes];
    setDraft({ method: 'path', nodes, length: polylineLength(nodes), unreached: path.unreached });
  }, [stopPicking, points, ensureGround, cellMm]);

  const startManual = useCallback(() => {
    if (picking === 'path') { stopPicking(); return; }
    setDraft(d => (d && d.method === 'manual' ? d : { method: 'manual', nodes: [], length: 0 }));
    setPicking('path');
    setWorldPicker(() => (hit: [number, number, number]) => {
      setDraft(d => {
        const nodes = [...(d && d.method === 'manual' ? d.nodes : []), hit as Vec3];
        return { method: 'manual', nodes, length: polylineLength(nodes) };
      });
    });
  }, [picking, stopPicking, setWorldPicker]);

  const saveLength = useCallback((primary: boolean) => {
    if (!draft || draft.nodes.length < 2) return;
    stopPicking();
    const id = ensureStem();
    if (id === null) return;
    const l: LengthMeasurement = { id: newMeasurementId('l'), method: draft.method, nodes: draft.nodes, length: draft.length, primary, createdAt: nowIso() };
    updateBranches(f => addLength(f, id, l, nowIso()));
    setMsg({ text: `${draft.method === 'height' ? 'Height' : 'Length'} ${l.length.toFixed(2)} m saved.` });
  }, [draft, stopPicking, ensureStem, updateBranches]);

  // ---- Viewport graphics ---------------------------------------------
  useEffect(() => {
    setBranchOverlay(mergeOverlays(
      read && reading ? sectionOverlay(read.section, reading.jaws, reading.diameter) : null,
      draft && draft.nodes.length > 0 ? pathOverlay(draft.nodes) : null,
    ));
  }, [read, reading, draft, setBranchOverlay]);

  // ---- Stems list -----------------------------------------------------
  const frame = useCallback((b: BranchRecord) => {
    if (!api) return;
    const xyz = b.members.length > 0 ? api.pointsWorld(b.members).xyz : (b.treeId !== null ? api.treePointsWorld(b.treeId) : new Float64Array(0));
    const bb = boundsOf(xyz, 0.5);
    if (bb) api.frameBox(bb.min, bb.max);
    else setMsg({ text: `${b.name}: its points are not loaded. Isolate tree ${b.treeId ?? '?'} in Tree review.`, error: true });
  }, [api]);

  const removeStem = useCallback((b: BranchRecord) => {
    void (async () => {
      if (!(await confirmDialog(`Delete ${b.name} and its ${b.diameters.length + b.lengths.length} measurement(s)? Its points stay in the cloud.`))) return;
      updateBranches(f => deleteBranch(f, b.id));
    })();
  }, [updateBranches]);

  const disabled = !api || !octree || busy;

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 400 }}>
      {branchError && <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={ERR_STYLE}>{branchError}</div>}
      {msg && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md flex gap-2" style={msg.error ? ERR_STYLE : { color: 'var(--text)', ...BOX_STYLE }}>
          <span className="flex-1">{msg.text}</span>
          <button className="btn !h-4 !px-1 mono text-[9px]" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}
      {treeId === null && !stem && (
        <div className="mono text-[10px] px-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Isolate a tree in Tree review: its stem is measured on all of its points. Stems already measured are listed below.
        </div>
      )}

      {/* 1 · The stem */}
      {stemTree !== null && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={BOX_STYLE}>
          <div className="flex items-center gap-1.5">
            {stem && <span style={{ width: 10, height: 10, borderRadius: 2, background: branchColorHex(stem.id) }} />}
            <span className="mono text-[10.5px] flex-1" style={{ color: 'var(--text)' }}>
              1 · Stem of tree {stemTree}
              <span style={{ color: 'var(--text-mute)' }}>{ptsCount !== null ? ` — ${ptsCount.toLocaleString()} points` : ''}</span>
            </span>
            <button className="btn !h-5 !px-1.5 mono text-[9.5px]" title="Read the points again (after more of the cloud has streamed in)"
              onClick={() => { setPtsVersion(v => v + 1); setRead(null); }}>↻</button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Points</span>
            <Seg value={source} onChange={setSource} options={[
              { v: 'tree', label: 'whole tree', title: 'Every point of the isolated tree; the search radius and the stem tracking keep the branches out' },
              { v: 'stemLabel', label: 'stem-labelled', title: 'Only the tree’s points labelled stem (semantic 1)' },
              { v: 'cut', label: 'cut stem', title: 'The points cut out below with the lasso' },
            ]} />
          </div>
          <div className="flex flex-wrap gap-1">
            <button className="btn !h-6 mono text-[10.5px]" disabled={disabled}
              onClick={() => { setEditMode(true); setTools({ selectTool: 'lasso' }); }}
              style={editMode ? ACTIVE_BTN : undefined}>Lasso</button>
            <button className="btn !h-6 mono text-[10.5px]" disabled={disabled || selectedCount === 0 || treeId === null} onClick={() => cutStem(false)}>
              {stem && stem.members.length > 0 ? 'Add selection to the stem' : 'Cut stem from selection'}
            </button>
            {stem && stem.members.length > 0 && (
              <button className="btn !h-6 mono text-[10.5px]" disabled={disabled || selectedCount === 0} onClick={() => cutStem(true)}>Remove selection</button>
            )}
          </div>
          <label className="mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
            <input type="checkbox" checked={labelSemantic} onChange={(e) => setLabelSemantic(e.target.checked)} />
            also label the cut points stem (semantic 1) — an edit to the cloud, saved with it
          </label>
          <div className="flex items-center gap-1.5">
            <span className="mono text-[10px] flex-1" style={{ color: 'var(--text-dim)' }}>
              Ground {ground && ground.key === key ? <span style={{ color: 'var(--text)' }}>{ground.z.toFixed(2)} m</span> : '—'}
              {ground && ground.key === key ? <span style={{ color: 'var(--text-mute)' }}> · {GROUND_TEXT[ground.from]}</span> : ' · found on the first measurement'}
            </span>
            <button className="btn !h-5 !px-1.5 mono text-[9.5px]" onClick={pickGround} style={picking === 'ground' ? ACTIVE_BTN : undefined}
              title="Click the ground beside the stem to measure heights from there">{picking === 'ground' ? 'click the ground…' : 'pick'}</button>
            {ground && ground.from === 'picked' && (
              <button className="btn !h-5 !px-1.5 mono text-[9.5px]" onClick={() => { setGround(null); setRead(null); }}>auto</button>
            )}
          </div>
        </div>
      )}

      {/* 2 · Diameter */}
      {stemTree !== null && (
        <div className="rounded-md p-2 flex flex-col gap-2" style={BOX_STYLE}>
          <div className="flex items-center gap-1.5">
            <span className="mono text-[10.5px] flex-1" style={{ color: 'var(--text)' }}>2 · Diameter — calipers at a height</span>
            <ModeSeg mode={mode} setMode={setMode} />
          </div>
          <div className="flex flex-wrap gap-1 items-center">
            <button className="btn !h-6 mono text-[10.5px]" disabled={disabled} onClick={() => { setHeightM(1.3); void sectionAtHeight(1.3); }}>DBH 1.3 m</button>
            <button className="btn !h-6 mono text-[10.5px]" disabled={disabled} onClick={() => { setHeightM(6); void sectionAtHeight(6); }}>d6 6 m</button>
            <input type="number" min={0.05} step={0.1} value={heightM}
              onChange={(e) => setHeightM(parseFloat(e.target.value) || 0)}
              className="mono text-[10.5px] px-1 rounded w-[64px]" style={{ background: 'transparent', border: '1px solid var(--line)', color: 'var(--text)' }} />
            <button className="btn !h-6 mono text-[10.5px]" disabled={disabled || !(heightM > 0)} onClick={() => void sectionAtHeight(heightM)}>at {heightM} m</button>
            <button className="btn !h-6 mono text-[10.5px]" disabled={disabled} onClick={pickSection} style={picking === 'section' ? ACTIVE_BTN : undefined}
              title="Click the stem at the height to read it">{picking === 'section' ? 'Click the stem… (cancel)' : 'Pick height'}</button>
          </div>
          <div className="flex flex-col gap-1">
            <Slider label="Section thickness" value={thicknessMm} min={5} max={100} step={5} unit="mm" onChange={setThicknessMm} />
            <Slider label="Search radius" value={radiusMm} min={50} max={1500} step={25} unit="mm" onChange={setRadiusMm} />
            <Slider label="Ignore outermost" value={trimPct} min={0} max={10} step={0.5} unit="%" onChange={setTrimPct} />
          </div>
          {busy && <div className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>Measuring…</div>}
          {read && reading && (
            <SectionReader read={read} setRead={setRead} reading={reading} mode={mode} trim={trim} onNudge={nudge} along="the stem">
              <button className="btn !h-6 mono text-[10.5px] flex-1 justify-center" onClick={() => saveDiameter('dbh')}
                style={read.heightAboveGround != null && Math.abs(read.heightAboveGround - 1.3) < 0.05 ? ACTIVE_BTN : undefined}>Save as DBH</button>
              <button className="btn !h-6 mono text-[10.5px]" onClick={() => saveDiameter('d6')}
                style={read.heightAboveGround != null && Math.abs(read.heightAboveGround - 6) < 0.05 ? ACTIVE_BTN : undefined}>Save as d6</button>
              <button className="btn !h-6 mono text-[10.5px]" onClick={() => saveDiameter('other')}>Save as other</button>
            </SectionReader>
          )}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Taper series from</span>
            <input type="number" min={0.1} step={0.1} value={seriesFrom} onChange={(e) => setSeriesFrom(Math.max(0.1, parseFloat(e.target.value) || 0.5))}
              className="mono text-[10.5px] px-1 rounded w-[52px]" style={{ background: 'transparent', border: '1px solid var(--line)', color: 'var(--text)' }} />
            <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>m every</span>
            <input type="number" min={0.1} step={0.1} value={seriesStep} onChange={(e) => setSeriesStep(Math.max(0.1, parseFloat(e.target.value) || 1))}
              className="mono text-[10.5px] px-1 rounded w-[52px]" style={{ background: 'transparent', border: '1px solid var(--line)', color: 'var(--text)' }} />
            <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>m</span>
            <button className="btn !h-6 mono text-[10.5px]" disabled={disabled} onClick={() => void taperSeries()}
              title="Read the stem at every step up to a metre below the top, the jaws closed on the points, each saved at its height">Read series</button>
          </div>
        </div>
      )}

      {/* 3 · Height and length */}
      {stemTree !== null && (
        <div className="rounded-md p-2 flex flex-col gap-1.5" style={BOX_STYLE}>
          <div className="mono text-[10.5px]" style={{ color: 'var(--text)' }}>3 · Height and length</div>
          <div className="flex flex-wrap gap-1">
            <button className="btn !h-6 mono text-[10.5px]" disabled={disabled} onClick={() => void measureHeight()}
              title="From the ground to the highest point of the points measured on (the whole tree: the tree's height)">Tree height</button>
            <button className="btn !h-6 mono text-[10.5px]" disabled={disabled} onClick={() => void followStem()}
              title="From the foot along the points to the farthest one — on stem-labelled or cut stem points, the stem's length">Follow the stem</button>
            <button className="btn !h-6 mono text-[10.5px]" disabled={disabled} onClick={startManual} style={picking === 'path' ? ACTIVE_BTN : undefined}>
              {picking === 'path' ? 'Pause (to turn the view)' : draft?.method === 'manual' && draft.nodes.length > 0 ? 'Go on clicking' : 'Click along the stem'}
            </button>
            {draft?.method === 'manual' && draft.nodes.length > 0 && (
              <button className="btn !h-6 mono text-[10.5px]" onClick={() => setDraft({ method: 'manual', nodes: [], length: 0 })}>clear</button>
            )}
          </div>
          <Slider label="Path cell" value={cellMm} min={10} max={200} step={10} unit="mm" onChange={setCellMm} />
          {draft && <LengthDraftView draft={draft} primaryLabel={draft.method === 'height' ? 'Save as tree height' : 'Save as stem length'} onSave={saveLength} />}
        </div>
      )}

      {stem && (
        <SavedMeasurements
          part={stem} roles={['dbh', 'd6']} lengthRoleLabel="LEN"
          onShowDiameter={showDiameter}
          onShowLength={(l) => setDraft({ method: l.method, nodes: l.nodes, length: l.length })}
          onPromote={(id, role) => updateBranches(f => promoteMeasurement(f, stem.id, id, nowIso(), role))}
          onRemove={(id) => updateBranches(f => removeMeasurement(f, stem.id, id, nowIso()))}
        />
      )}

      {/* Stems measured */}
      <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
        <div className="px-2 py-1 mono text-[10px]" style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderBottom: '1px solid var(--line)' }}>
          Stems ({stems.length})
        </div>
        <div className="max-h-[160px] overflow-y-auto scroll-thin">
          {stems.length === 0 && <div className="mono text-[10px] px-2 py-2" style={{ color: 'var(--text-mute)' }}>No stem measured yet.</div>}
          {stems.map(b => {
            const dbh = diameterOfRole(b, 'dbh');
            const d6 = diameterOfRole(b, 'd6');
            const h = b.lengths.find(l => l.method === 'height' && l.primary) ?? b.lengths.find(l => l.method === 'height');
            const len = primaryLength(b);
            const isCurrent = stem?.id === b.id;
            return (
              <div key={b.id} className="flex items-center gap-1.5 px-2 py-1 mono text-[10.5px] cursor-pointer"
                style={{ borderBottom: '1px solid var(--line)', background: isCurrent ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : undefined }}
                onClick={() => { if (treeId === null) setPickedId(b.id); }}
                title={treeId === null ? 'Work on this stem' : 'Isolate its tree in Tree review to work on it'}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: branchColorHex(b.id), flex: 'none' }} />
                <span style={{ color: 'var(--text)', minWidth: 60 }}>tree {b.treeId ?? '—'}</span>
                <span style={{ color: dbh ? 'var(--accent)' : 'var(--text-mute)', minWidth: 74 }}>{dbh ? `DBH ${(dbh.diameter * 100).toFixed(1)}` : 'DBH —'}</span>
                <span style={{ color: d6 ? 'var(--text)' : 'var(--text-mute)', minWidth: 62 }}>{d6 ? `d6 ${(d6.diameter * 100).toFixed(1)}` : 'd6 —'}</span>
                <span style={{ color: h ? 'var(--text)' : 'var(--text-mute)', minWidth: 52 }}>{h ? `h ${h.length.toFixed(1)}` : (len ? `L ${len.length.toFixed(1)}` : 'h —')}</span>
                <span className="flex-1" />
                <button className="btn !h-5 !px-1.5 mono text-[9.5px]" title={b.done ? 'Done — click to reopen' : 'Mark as done'}
                  style={b.done ? { color: '#67d391', borderColor: '#67d391' } : undefined}
                  onClick={(e) => { e.stopPropagation(); updateBranches(f => updateBranch(f, b.id, { done: !b.done }, nowIso())); }}>✓</button>
                <button className="btn !h-5 !px-1.5 mono text-[9.5px]" title="Frame the camera on it" onClick={(e) => { e.stopPropagation(); frame(b); }}>⌖</button>
                <button className="btn !h-5 !px-1.5 mono text-[9.5px]" title="Delete the stem record (its points stay)" onClick={(e) => { e.stopPropagation(); removeStem(b); }}>✕</button>
              </div>
            );
          })}
        </div>
        <div className="px-2 py-1 mono text-[9.5px]" style={{ color: 'var(--text-mute)', borderTop: '1px solid var(--line)' }}>DBH and d6 in cm, heights in m.</div>
      </div>

      <div className="flex flex-wrap gap-1 items-center">
        <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Export</span>
        <button className="btn !h-6 mono text-[10.5px]" disabled={stems.length === 0}
          onClick={() => void saveCsvFile(branchSummaryCsv(onlyStems(branchFile)), 'stems.csv')}
          title="One row per stem: DBH, d6, height, length">Stems CSV</button>
        <button className="btn !h-6 mono text-[10.5px]" disabled={stems.length === 0}
          onClick={() => void saveCsvFile(measurementsCsv(onlyStems(branchFile)), 'stem-measurements.csv')}
          title="One row per reading, with its height above ground — the taper">Readings CSV</button>
      </div>
    </div>
  );
}
