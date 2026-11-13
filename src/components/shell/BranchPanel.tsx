// Branches — cut branches out of a tree by hand and measure them the way
// they are measured in the field: base diameter with calipers (one
// reading, or two at right angles), and length.
//
// The workflow:
//   1. Isolate a tree in Tree review. Every one of its points is then
//      resident, so a branch is cut and measured on all of its points.
//   2. Lasso a branch's points and make them a branch. They are painted
//      in the branch's colour from then on — in every colour mode, after
//      a restart — so the branches already done stand out from the
//      ones still to do. ("Hide cut branches" takes the done ones away.)
//   3. With the branch active: cut a section where the diameter is read
//      (clicked, or found at the base), close the caliper jaws on it,
//      and save the reading. Measure the length by clicking along the
//      branch, or let it follow the branch's points from the base.
//   4. Everything is kept in branches.json beside the dataset and
//      exports as CSV.
//
// The geometry is metrics/branchMeasure.ts; the file is
// persistence/branchStore.ts; the viewport graphics branchOverlay.ts.

import { useCallback, useEffect, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import {
  add, scale, sectionAt, minWidthAngle, branchEnds, orderEnds,
  baseSection, branchPath, polylineLength, dist, type Vec3,
} from '../../metrics/branchMeasure';
import {
  membersFromSelection, createBranch, assignToBranch, removeFromBranch, deleteBranch, updateBranch,
  addDiameter, addLength, removeMeasurement, promoteMeasurement, baseDiameter, primaryLength,
  branchColorHex, branchSummaryCsv, measurementsCsv, newMeasurementId,
  type BranchRecord, type DiameterMeasurement, type LengthMeasurement,
} from '../../persistence/branchStore';
import { sectionOverlay, pathOverlay, mergeOverlays, boundsOf } from './branchOverlay';
import { saveCsvFile } from '../../io/saveDownload';
import { csvNum } from '../../io/csv';
import { confirmDialog } from '../../ui/dialogs';
import {
  nowIso, mm, ERR_STYLE, BOX_STYLE, ACTIVE_BTN, Slider, Seg, ModeSeg, SectionReader, LengthDraftView, SavedMeasurements,
  useReading, diameterFrom, type SectionRead, type LengthDraft,
} from './measureUi';

export default function BranchPanel() {
  const {
    api, octree, filters, selectedCount, setWorldPicker, editMode, setEditMode, setTools,
    branchFile, updateBranches, branchError, branchView, setBranchView, setBranchOverlay,
  } = useOctreeShell();

  const treeId = filters.isolateTreeId;
  const stemAt: Vec3 | null = filters.isolateAnchor
    ? [filters.isolateAnchor[0], filters.isolateAnchor[1], filters.isolateAnchor[2]]
    : null;

  // Section settings (millimetres in the UI, metres in the maths).
  const [thicknessMm, setThicknessMm] = useState(10);
  const [radiusMm, setRadiusMm] = useState(60);
  const [axisMm, setAxisMm] = useState(60);
  const [trimPct, setTrimPct] = useState(0);
  const [mode, setMode] = useState<'cross' | 'single'>('cross');
  const [baseOffsetMm, setBaseOffsetMm] = useState(20);
  const [cellMm, setCellMm] = useState(20);
  const [labelSemantic, setLabelSemantic] = useState(false);
  const [onlyThisTree, setOnlyThisTree] = useState(true);

  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  const [picking, setPicking] = useState<null | 'section' | 'path'>(null);
  const [read, setRead] = useState<SectionRead | null>(null);
  const [draft, setDraft] = useState<LengthDraft | null>(null);

  const active: BranchRecord | null = branchFile.branches.find(b => b.id === branchView.activeId && b.kind === 'branch') ?? null;
  const trim = trimPct / 100;

  // ---- The active branch's points ------------------------------------
  // Read from the viewer on demand: a measurement runs on what is
  // resident, and says when part of the branch is not.
  const [ptsInfo, setPtsInfo] = useState<{ loaded: number; missing: number } | null>(null);
  const activePoints = useCallback((): Float64Array | null => {
    if (!api || !active) return null;
    const { xyz, missing } = api.pointsWorld(active.members);
    setPtsInfo({ loaded: xyz.length / 3, missing });
    return xyz.length >= 9 ? xyz : null;
  }, [api, active]);
  useEffect(() => {
    setRead(null);
    setDraft(null);
    if (active) activePoints(); else setPtsInfo(null);
    // Re-read only when the branch or its membership changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.pointCount]);

  // ---- Picking --------------------------------------------------------
  const stopPicking = useCallback(() => {
    setWorldPicker(null);
    setPicking(null);
  }, [setWorldPicker]);
  useEffect(() => () => { setWorldPicker(null); setBranchOverlay(null); }, [setWorldPicker, setBranchOverlay]);

  // ---- Cutting --------------------------------------------------------
  const selection = useCallback(() => {
    const sel = api ? membersFromSelection(api.getSelection()) : [];
    if (sel.length === 0) setMsg({ text: 'Nothing is selected. Lasso the branch’s points first.', error: true });
    return sel;
  }, [api]);

  const afterCut = useCallback(() => {
    if (!api) return;
    if (labelSemantic) api.applyToSelection({ semantic: 2 });
    api.clearSelection();
  }, [api, labelSemantic]);

  const cutNew = useCallback(() => {
    const sel = selection();
    if (sel.length === 0) return;
    let id = 0;
    updateBranches(f => {
      const r = createBranch(f, sel, treeId, nowIso());
      id = r.id;
      return r.file;
    });
    setBranchView({ activeId: id });
    afterCut();
    setMsg({ text: `Branch ${id} cut out: ${sel.reduce((n, m) => n + m.points.length, 0).toLocaleString()} points.` });
  }, [selection, updateBranches, treeId, setBranchView, afterCut]);

  const addToActive = useCallback(() => {
    if (!active) return;
    const sel = selection();
    if (sel.length === 0) return;
    updateBranches(f => assignToBranch(f, active.id, sel, nowIso()));
    afterCut();
  }, [active, selection, updateBranches, afterCut]);

  const removeFromActive = useCallback(() => {
    if (!active) return;
    const sel = selection();
    if (sel.length === 0) return;
    updateBranches(f => removeFromBranch(f, active.id, sel, nowIso()));
    api?.clearSelection();
  }, [active, selection, updateBranches, api]);

  const removeBranch = useCallback((b: BranchRecord) => {
    void (async () => {
      if (!(await confirmDialog(`Delete ${b.name} and its ${b.diameters.length + b.lengths.length} measurement(s)? Its points stay in the cloud.`))) return;
      updateBranches(f => deleteBranch(f, b.id));
      if (branchView.activeId === b.id) setBranchView({ activeId: null });
    })();
  }, [updateBranches, branchView.activeId, setBranchView]);

  const frame = useCallback((b: BranchRecord) => {
    if (!api) return;
    const { xyz } = api.pointsWorld(b.members);
    const bb = boundsOf(xyz, 0.15);
    if (bb) api.frameBox(bb.min, bb.max);
    else setMsg({ text: `${b.name}: none of its points are loaded. Isolate its tree in Tree review.`, error: true });
  }, [api]);

  // ---- Diameter -------------------------------------------------------
  const cutSection = useCallback((at: Vec3, axis?: Vec3, keepTheta?: number) => {
    const xyz = activePoints();
    if (!xyz) { setMsg({ text: 'The active branch has no loaded points. Isolate its tree in Tree review.', error: true }); return; }
    const s = sectionAt(xyz, at, {
      axisRadius: axisMm / 1000, halfThickness: thicknessMm / 2000, maxRadius: radiusMm / 1000, axis,
    });
    if (!s || s.count < 3) {
      setMsg({ text: 'No points of the active branch in a section there. Click on the branch itself, or widen the section.', error: true });
      return;
    }
    setMsg(null);
    setRead({ section: s, theta: keepTheta ?? minWidthAngle(s.pts, trim), manual: [null, null] });
  }, [activePoints, axisMm, thicknessMm, radiusMm, trim]);

  const pickSection = useCallback(() => {
    if (picking) { stopPicking(); return; }
    setPicking('section');
    setWorldPicker(() => (hit: [number, number, number]) => {
      setWorldPicker(null);
      setPicking(null);
      cutSection(hit);
    });
  }, [picking, stopPicking, setWorldPicker, cutSection]);

  const ends = useCallback((xyz: Float64Array) => {
    const e = branchEnds(xyz);
    return e ? orderEnds(e.a, e.b, stemAt) : null;
  }, [stemAt]);

  const sectionAtBase = useCallback(() => {
    const xyz = activePoints();
    if (!xyz) { setMsg({ text: 'The active branch has no loaded points.', error: true }); return; }
    const e = ends(xyz);
    const bs = e ? baseSection(xyz, e.base, e.tip, baseOffsetMm / 1000, axisMm / 1000) : null;
    if (!bs) { setMsg({ text: 'Could not find the branch’s base.', error: true }); return; }
    cutSection(bs.at, bs.axis);
  }, [activePoints, ends, baseOffsetMm, axisMm, cutSection]);

  const nudge = useCallback((dMm: number) => {
    if (!read) return;
    const s = read.section;
    cutSection(add(s.center, scale(s.axis, dMm / 1000)), s.axis, read.theta);
  }, [read, cutSection]);

  const reading = useReading(read, mode, trim);

  const saveDiameter = useCallback((role: 'base' | 'other') => {
    if (!active || !read || !reading) return;
    const d: DiameterMeasurement = diameterFrom(read, reading, role, mode, trim, newMeasurementId('d'));
    updateBranches(f => addDiameter(f, active.id, d, nowIso()));
    setMsg({ text: `${role === 'base' ? 'Base diameter' : 'Diameter'} ${mm(d.diameter)} saved to ${active.name}.` });
  }, [active, read, reading, mode, trim, updateBranches]);

  const showDiameter = useCallback((d: DiameterMeasurement) => {
    setMode(d.mode);
    setTrimPct(Math.round(d.trim * 1000) / 10);
    setThicknessMm(Math.round(d.halfThickness * 2000));
    setRadiusMm(Math.round(d.maxRadius * 1000));
    const xyz = activePoints();
    if (!xyz) { setMsg({ text: 'The branch’s points are not loaded.', error: true }); return; }
    const s = sectionAt(xyz, d.center, { axisRadius: axisMm / 1000, halfThickness: d.halfThickness, maxRadius: d.maxRadius, axis: d.axis });
    if (s) setRead({ section: s, theta: d.theta, manual: [null, null] });
  }, [activePoints, axisMm]);

  // ---- Length ---------------------------------------------------------
  // Clicking along a branch suspends the camera (a pick and an orbit are
  // the same drag), so the button pauses: rotate the view, then go on
  // clicking where the polyline left off.
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

  const startAtBase = useCallback(() => {
    const xyz = activePoints();
    const e = xyz ? ends(xyz) : null;
    if (!e) return;
    setDraft(d => {
      const rest = d && d.method === 'manual' ? d.nodes : [];
      const nodes = rest.length > 0 && dist(rest[0], e.base) < 1e-9 ? rest : [e.base, ...rest];
      return { method: 'manual', nodes, length: polylineLength(nodes) };
    });
  }, [activePoints, ends]);

  const undoNode = useCallback(() => {
    setDraft(d => {
      if (!d || d.method !== 'manual' || d.nodes.length === 0) return d;
      const nodes = d.nodes.slice(0, -1);
      return { ...d, nodes, length: polylineLength(nodes) };
    });
  }, []);

  const followPath = useCallback(() => {
    stopPicking();
    const xyz = activePoints();
    const e = xyz ? ends(xyz) : null;
    if (!xyz || !e) { setMsg({ text: 'The active branch has no loaded points.', error: true }); return; }
    const p = branchPath(xyz, e.base, cellMm / 1000);
    if (!p) return;
    setDraft({ method: 'path', nodes: p.nodes, length: p.length, unreached: p.unreached });
  }, [stopPicking, activePoints, ends, cellMm]);

  const chord = useCallback(() => {
    stopPicking();
    const xyz = activePoints();
    const e = xyz ? ends(xyz) : null;
    if (!e) { setMsg({ text: 'The active branch has no loaded points.', error: true }); return; }
    setDraft({ method: 'chord', nodes: [e.base, e.tip], length: dist(e.base, e.tip) });
  }, [stopPicking, activePoints, ends]);

  const saveLength = useCallback((primary: boolean) => {
    if (!active || !draft || draft.nodes.length < 2) return;
    stopPicking();
    const l: LengthMeasurement = {
      id: newMeasurementId('l'), method: draft.method, nodes: draft.nodes, length: draft.length, primary, createdAt: nowIso(),
    };
    updateBranches(f => addLength(f, active.id, l, nowIso()));
    setMsg({ text: `Length ${l.length.toFixed(3)} m saved to ${active.name}.` });
  }, [active, draft, stopPicking, updateBranches]);

  // ---- Viewport graphics ---------------------------------------------
  useEffect(() => {
    setBranchOverlay(mergeOverlays(
      read && reading ? sectionOverlay(read.section, reading.jaws, reading.diameter) : null,
      draft && draft.nodes.length > 0 ? pathOverlay(draft.nodes) : null,
    ));
  }, [read, reading, draft, setBranchOverlay]);

  // ---- Export ---------------------------------------------------------
  const exportPoints = useCallback((which: BranchRecord[]) => {
    if (!api) return;
    const rows = ['branch_id,tree_id,x,y,z'];
    let missing = 0;
    for (const b of which) {
      const { xyz, missing: m } = api.pointsWorld(b.members);
      missing += m;
      for (let i = 0; i < xyz.length; i += 3) {
        rows.push(`${b.id},${b.treeId ?? ''},${csvNum(xyz[i], 4)},${csvNum(xyz[i + 1], 4)},${csvNum(xyz[i + 2], 4)}`);
      }
    }
    void saveCsvFile(rows, which.length === 1 ? `branch-${which[0].id}-points.csv` : 'branch-points.csv');
    if (missing > 0) setMsg({ text: `${missing.toLocaleString()} point(s) were not loaded and are not in the file. Isolate the tree and export again for all of them.`, error: true });
  }, [api]);

  // ---- Render ---------------------------------------------------------
  const branches = branchFile.branches.filter(b => b.kind === 'branch');
  const listed = branches.filter(b => !(onlyThisTree && treeId !== null && b.treeId !== treeId));
  const disabled = !api || !octree;

  return (
    <div className="flex flex-col gap-2 px-2.5 py-2.5" style={{ minWidth: 400 }}>
      {branchError && <div className="mono text-[10px] px-2 py-1.5 rounded-md" style={ERR_STYLE}>{branchError}</div>}
      {msg && (
        <div className="mono text-[10px] px-2 py-1.5 rounded-md flex gap-2"
          style={msg.error ? ERR_STYLE : { color: 'var(--text)', ...BOX_STYLE }}>
          <span className="flex-1">{msg.text}</span>
          <button className="btn !h-4 !px-1 mono text-[9px]" onClick={() => setMsg(null)}>✕</button>
        </div>
      )}
      {treeId === null && (
        <div className="mono text-[10px] px-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Isolate a tree in Tree review first: all of its points are then loaded, so a branch is cut and measured on every point it has.
        </div>
      )}

      {/* 1 · Cut out */}
      <div className="rounded-md p-2 flex flex-col gap-1.5" style={BOX_STYLE}>
        <div className="mono text-[10.5px]" style={{ color: 'var(--text)' }}>
          1 · Cut out <span style={{ color: 'var(--text-mute)' }}>— {selectedCount.toLocaleString()} point(s) selected{treeId !== null ? ` · tree ${treeId}` : ''}</span>
        </div>
        <div className="flex flex-wrap gap-1">
          <button className="btn !h-6 mono text-[10.5px]" disabled={disabled}
            onClick={() => { setEditMode(true); setTools({ selectTool: 'lasso' }); }}
            style={editMode ? ACTIVE_BTN : undefined}
            title="Edit mode with the lasso: drag around the branch's points (Shift adds, Alt subtracts)">Lasso</button>
          <button className="btn !h-6 mono text-[10.5px]" disabled={disabled || selectedCount === 0} onClick={cutNew}>New branch from selection</button>
          <button className="btn !h-6 mono text-[10.5px]" disabled={disabled || !active || selectedCount === 0} onClick={addToActive}>Add to active</button>
          <button className="btn !h-6 mono text-[10.5px]" disabled={disabled || !active || selectedCount === 0} onClick={removeFromActive}>Remove from active</button>
        </div>
        <label className="mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
          <input type="checkbox" checked={labelSemantic} onChange={(e) => setLabelSemantic(e.target.checked)} />
          also label the points branch (semantic 2) — an edit to the cloud, saved with it
        </label>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
            <input type="checkbox" checked={branchView.paint} onChange={(e) => setBranchView({ paint: e.target.checked })} />
            paint branches
          </label>
          <Seg value={branchView.filter} onChange={(v) => setBranchView({ filter: v })} options={[
            { v: 'all', label: 'all', title: 'Show every point' },
            { v: 'hideMarked', label: 'hide cut', title: 'Hide the branches already cut out (the active one stays) — what is left is still to do' },
            { v: 'onlyActive', label: 'only active', title: 'Show nothing but the active branch' },
          ]} />
        </div>
      </div>

      {/* 2 · Branches */}
      <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
        <div className="px-2 py-1 mono text-[10px] flex items-center gap-2"
          style={{ color: 'var(--text-dim)', background: 'var(--wash-1)', borderBottom: '1px solid var(--line)' }}>
          <span className="flex-1">2 · Branches ({listed.length}{listed.length !== branches.length ? ` of ${branches.length}` : ''})</span>
          {treeId !== null && (
            <label className="flex items-center gap-1"><input type="checkbox" checked={onlyThisTree} onChange={(e) => setOnlyThisTree(e.target.checked)} />this tree</label>
          )}
        </div>
        <div className="max-h-[180px] overflow-y-auto scroll-thin">
          {listed.length === 0 && (
            <div className="mono text-[10px] px-2 py-2" style={{ color: 'var(--text-mute)' }}>No branches yet. Lasso one and press “New branch from selection”.</div>
          )}
          {listed.map(b => {
            const bd = baseDiameter(b);
            const pl = primaryLength(b);
            const isActive = b.id === branchView.activeId;
            return (
              <div key={b.id} className="flex items-center gap-1.5 px-2 py-1 mono text-[10.5px] cursor-pointer"
                style={{ borderBottom: '1px solid var(--line)', background: isActive ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : undefined }}
                onClick={() => setBranchView({ activeId: isActive ? null : b.id })}
                title={isActive ? 'Active — click to release' : 'Make this the active branch'}>
                <span style={{ width: 10, height: 10, borderRadius: 2, background: branchColorHex(b.id), flex: 'none' }} />
                <span style={{ color: 'var(--text)', minWidth: 70 }}>{b.name}</span>
                <span style={{ color: 'var(--text-mute)', minWidth: 52 }}>{b.pointCount.toLocaleString()} p</span>
                <span style={{ color: bd ? 'var(--accent)' : 'var(--text-mute)', minWidth: 64 }}>{bd ? `Ø ${mm(bd.diameter)}` : 'Ø —'}</span>
                <span style={{ color: pl ? 'var(--text)' : 'var(--text-mute)', minWidth: 54 }}>{pl ? `${pl.length.toFixed(2)} m` : 'L —'}</span>
                <span className="flex-1" />
                <button className="btn !h-5 !px-1.5 mono text-[9.5px]" title={b.done ? 'Done — click to reopen' : 'Mark as done'}
                  style={b.done ? { color: '#67d391', borderColor: '#67d391' } : undefined}
                  onClick={(e) => { e.stopPropagation(); updateBranches(f => updateBranch(f, b.id, { done: !b.done }, nowIso())); }}>✓</button>
                <button className="btn !h-5 !px-1.5 mono text-[9.5px]" title="Frame the camera on it"
                  onClick={(e) => { e.stopPropagation(); frame(b); }}>⌖</button>
                <button className="btn !h-5 !px-1.5 mono text-[9.5px]" title="Delete the branch (its points stay)"
                  onClick={(e) => { e.stopPropagation(); removeBranch(b); }}>✕</button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 3 · Measure */}
      {active && (
        <div className="rounded-md p-2 flex flex-col gap-2" style={BOX_STYLE}>
          <div className="flex items-center gap-1.5">
            <span style={{ width: 10, height: 10, borderRadius: 2, background: branchColorHex(active.id) }} />
            <input key={`name-${active.id}`} defaultValue={active.name} className="mono text-[10.5px] px-1 py-0.5 rounded flex-1"
              style={{ background: 'transparent', border: '1px solid var(--line)', color: 'var(--text)' }}
              onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== active.name) updateBranches(f => updateBranch(f, active.id, { name: v }, nowIso())); }} />
            <span className="mono text-[9.5px]" style={{ color: ptsInfo && ptsInfo.missing > 0 ? '#e6c068' : 'var(--text-mute)' }}>
              {ptsInfo ? `${ptsInfo.loaded.toLocaleString()} loaded${ptsInfo.missing > 0 ? ` · ${ptsInfo.missing.toLocaleString()} not` : ''}` : ''}
            </span>
            <button className="btn !h-5 !px-1.5 mono text-[9.5px]" title="Read the branch's points again (after more of the cloud has streamed in)" onClick={() => activePoints()}>↻</button>
          </div>
          <textarea key={`note-${active.id}`} defaultValue={active.note} rows={1} placeholder="note"
            className="mono text-[10px] px-1 py-0.5 rounded" style={{ background: 'transparent', border: '1px solid var(--line)', color: 'var(--text)', resize: 'vertical' }}
            onBlur={(e) => { if (e.target.value !== active.note) updateBranches(f => updateBranch(f, active.id, { note: e.target.value }, nowIso())); }} />

          {/* Diameter */}
          <div className="mono text-[10.5px]" style={{ color: 'var(--text)' }}>3 · Diameter — calipers across a section</div>
          <div className="flex flex-wrap gap-1 items-center">
            <button className="btn !h-6 mono text-[10.5px]" onClick={sectionAtBase} disabled={disabled}
              title="Find the end nearer the stem and cut the section the base offset in from it">Section at base</button>
            <button className="btn !h-6 mono text-[10.5px]" onClick={pickSection} disabled={disabled}
              style={picking === 'section' ? ACTIVE_BTN : undefined}>
              {picking === 'section' ? 'Click the branch… (cancel)' : 'Pick section'}
            </button>
            <span className="flex-1" />
            <ModeSeg mode={mode} setMode={setMode} />
          </div>
          <div className="flex flex-col gap-1">
            <Slider label="Section thickness" value={thicknessMm} min={2} max={50} step={1} unit="mm" onChange={setThicknessMm} />
            <Slider label="Search radius" value={radiusMm} min={10} max={300} step={5} unit="mm" onChange={setRadiusMm} />
            <Slider label="Axis from ±" value={axisMm} min={10} max={300} step={5} unit="mm" onChange={setAxisMm} />
            <Slider label="Base offset" value={baseOffsetMm} min={0} max={200} step={5} unit="mm" onChange={setBaseOffsetMm} />
            <Slider label="Ignore outermost" value={trimPct} min={0} max={10} step={0.5} unit="%" onChange={setTrimPct} />
          </div>
          {read && reading && (
            <SectionReader read={read} setRead={setRead} reading={reading} mode={mode} trim={trim} onNudge={nudge} along="the branch">
              <button className="btn !h-6 mono text-[10.5px] flex-1 justify-center" onClick={() => saveDiameter('base')}>Save as base diameter</button>
              <button className="btn !h-6 mono text-[10.5px]" onClick={() => saveDiameter('other')}>Save as other</button>
            </SectionReader>
          )}

          {/* Length */}
          <div className="mono text-[10.5px]" style={{ color: 'var(--text)' }}>4 · Length</div>
          <div className="flex flex-wrap gap-1">
            <button className="btn !h-6 mono text-[10.5px]" onClick={startManual} disabled={disabled}
              style={picking === 'path' ? ACTIVE_BTN : undefined}
              title="Click points along the branch from base to tip; the length is the polyline through them">
              {picking === 'path' ? 'Pause (to turn the view)' : draft?.method === 'manual' && draft.nodes.length > 0 ? 'Go on clicking' : 'Click along the branch'}
            </button>
            {draft?.method === 'manual' && <button className="btn !h-6 mono text-[10.5px]" onClick={startAtBase} title="Put the branch's base end in as the first point">from base end</button>}
            {draft?.method === 'manual' && draft.nodes.length > 0 && <button className="btn !h-6 mono text-[10.5px]" onClick={undoNode}>undo point</button>}
            {draft?.method === 'manual' && draft.nodes.length > 0 && <button className="btn !h-6 mono text-[10.5px]" onClick={() => setDraft({ method: 'manual', nodes: [], length: 0 })}>clear</button>}
            <button className="btn !h-6 mono text-[10.5px]" onClick={followPath} disabled={disabled}
              title="Follow the branch's points from its base to the point farthest along it">Follow the branch</button>
            <button className="btn !h-6 mono text-[10.5px]" onClick={chord} disabled={disabled} title="Straight from base end to tip end">Straight</button>
          </div>
          <Slider label="Path cell" value={cellMm} min={5} max={100} step={5} unit="mm" onChange={setCellMm} />
          {draft && <LengthDraftView draft={draft} primaryLabel="Save as branch length" onSave={saveLength} />}

          {/* Saved */}
          <SavedMeasurements
            part={active} roles={['base']} lengthRoleLabel="LEN"
            onShowDiameter={showDiameter}
            onShowLength={(l) => setDraft({ method: l.method, nodes: l.nodes, length: l.length })}
            onPromote={(id, role) => updateBranches(f => promoteMeasurement(f, active.id, id, nowIso(), role))}
            onRemove={(id) => updateBranches(f => removeMeasurement(f, active.id, id, nowIso()))}
          />
        </div>
      )}

      {/* 5 · Export */}
      <div className="flex flex-wrap gap-1 items-center">
        <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>Export</span>
        <button className="btn !h-6 mono text-[10.5px]" disabled={branchFile.branches.length === 0}
          onClick={() => void saveCsvFile(branchSummaryCsv(branchFile), 'branches.csv')}
          title="One row per branch: base diameter, length, points, done">Branches CSV</button>
        <button className="btn !h-6 mono text-[10.5px]" disabled={branchFile.branches.length === 0}
          onClick={() => void saveCsvFile(measurementsCsv(branchFile), 'branch-measurements.csv')}
          title="One row per measurement, with where it was taken">Measurements CSV</button>
        <button className="btn !h-6 mono text-[10.5px]" disabled={!active}
          onClick={() => active && exportPoints([active])} title="x, y, z of the active branch's points">Active branch points</button>
        <button className="btn !h-6 mono text-[10.5px]" disabled={listed.length === 0}
          onClick={() => exportPoints(listed)} title="x, y, z of every listed branch's points, with the branch id">Listed branches' points</button>
      </div>
    </div>
  );
}
