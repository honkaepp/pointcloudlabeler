// The stem review: the forest pass's stems one at a time, seen
// from straight above in a thin slab at breast height, the way a stem is
// checked in the field. Each stem's circle is drawn over its cross-section
// (forestStore's seedGeometry, exact), so a circle on a branch, a stem
// missed between two others or a diameter read off half the bark shows at
// a glance; it can be moved, measured, added or deleted on the spot, and
// the trees re-grown from the corrected stems afterwards.
//
// Everything here is the editor's own: the horizontal slab filter
// (filters.planeSlab), the parallel camera of the section view
// (sectionPose), the stems overlay, the viewport's world picker (taking
// the click on the slab's plane, so the hollow of a stem can be clicked)
// and the virtual caliper for a fit.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { viewer, type CameraPose } from './viewToolsStore';
import { sectionPose } from './SlabPanel';
import { planePicker } from '../../three/planePick';
import {
  addSeed, axisAt, BH, deleteSeed, editSeeds, forestState, markStem, measureSeed, moveSeed, setForestState, splitSeed, stemDoubts,
  unmeasureSeed, useForestStore,
} from './forestStore';

/** Widths of the view, metres, and half-thicknesses of the slab. */
const VIEWS = [1.5, 3, 6, 12];
const SLABS = [0.025, 0.05, 0.1];

type ClickMode = 'move' | 'radius' | 'add';

const CLICKS: [ClickMode, string, string, string][] = [
  ['move', 'Move', 'M', 'Click where the centre of the stem is'],
  ['radius', 'Radius', 'R', 'Click on the bark: the circle goes through it'],
  ['add', 'Add', 'A', 'Click the centre of a stem that has none'],
];

interface CaliperFit {
  centerX: number; centerY: number; radius: number; rmse: number; coverage: number; pointCount: number; rejectedCount: number;
}
interface Desktop {
  octreeVirtualCaliper?: (dir: string, x: number, y: number, z: number, slabHalfHeight?: number, searchRadius?: number) => Promise<CaliperFit>;
}

/** Start the review over the stems in `order` (reviewOrder's). */
export function startStemReview(order: number[]): void {
  if (order.length === 0) return;
  setForestState({ review: { order, index: 0, view: 3, slab: 0.05 }, mode: 'select' });
}

export default function StemReview() {
  const { octree, display, setDisplay, filters, setFilters, setWorldPicker } = useOctreeShell();
  const f = useForestStore();
  const r = f.review;
  const seeds = f.seeds ?? [];
  const id = r ? r.order[Math.min(r.index, r.order.length - 1)] : null;
  const cur = seeds.find((s) => s.id === id) ?? null;
  const [mode, setMode] = useState<ClickMode | null>(null);
  const [note, setNote] = useState<{ text: string; warn?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // what the review changes, put back when it ends
  const shell = useRef({ setDisplay, setFilters, setWorldPicker });
  shell.current = { setDisplay, setFilters, setWorldPicker };
  const saved = useRef<{ pose: CameraPose | null; projection: 'perspective' | 'ortho'; colorMode: typeof display.colorMode; slab: typeof filters.planeSlab } | null>(null);
  useEffect(() => {
    saved.current = { pose: viewer()?.getPose() ?? null, projection: display.projection ?? 'perspective', colorMode: display.colorMode, slab: filters.planeSlab };
    // which tree each cross-section went to
    shell.current.setDisplay({ colorMode: 'tree_id' });
    return () => {
      const s = saved.current;
      shell.current.setWorldPicker(null);
      if (!s) return;
      shell.current.setFilters({ planeSlab: s.slab });
      shell.current.setDisplay({ projection: s.projection, colorMode: s.colorMode });
      if (s.pose) viewer()?.setPose(s.pose);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // the view: the slab through the stem at breast height, seen from above
  const look = useCallback(() => {
    const st = forestState();
    const rv = st.review;
    const s = rv ? st.seeds?.find((x) => x.id === rv.order[rv.index]) : null;
    if (!s || !rv || !octree) return;
    const [cx, cy] = axisAt(s);
    const cz = s.z + BH;
    setFilters({ planeSlab: { anchor: [cx, cy, cz], normal: [0, 0, 1], halfHeight: rv.slab } });
    setDisplay({ projection: 'ortho' });
    const v = viewer();
    if (v) {
      const aspect = v.canvas.clientWidth / Math.max(1, v.canvas.clientHeight);
      v.setPose(sectionPose([cx, cy, cz], [0, 0, 1], octree.meta.offset as [number, number, number], rv.view, rv.view, aspect));
    }
    setForestState({ selected: s.id });
  }, [octree, setFilters, setDisplay]);
  // a new stem, view or slab moves the view; an edit of the stem does not
  useEffect(() => { look(); setNote(null); }, [id, r?.view, r?.slab, look]);

  const go = useCallback((d: number) => {
    const rv = forestState().review;
    if (!rv) return;
    setMode(null);
    setForestState({ review: { ...rv, index: Math.max(0, Math.min(rv.order.length - 1, rv.index + d)) } });
  }, []);

  const onClick = useCallback((hit: [number, number, number]) => {
    const st = forestState();
    const rv = st.review;
    const s = rv ? st.seeds?.find((x) => x.id === rv.order[rv.index]) : null;
    if (!rv || !s) return;
    const m = modeRef.current;
    if (m === 'move') {
      editSeeds((list) => moveSeed(list, s.id, hit[0], hit[1]));
      markStem(s.id, 'edited');
      setNote({ text: 'moved; the next re-grow measures it there (or Fit / Radius now)' });
    } else if (m === 'radius') {
      const [ax, ay] = axisAt(s);
      const rad = Math.hypot(hit[0] - ax, hit[1] - ay);
      editSeeds((list) => measureSeed(list, s.id, rad));
      markStem(s.id, 'edited');
      setNote({ text: `⌀ ${(rad * 200).toFixed(1)} cm by hand` });
    } else if (m === 'add') {
      editSeeds((list) => addSeed(list, hit[0], hit[1], hit[2]));
      const list = forestState().seeds ?? [];
      const added = list[list.length - 1];
      if (!added) return;
      markStem(added.id, 'edited');
      const order = [...rv.order];
      order.splice(rv.index + 1, 0, added.id);
      setForestState({ review: { ...rv, order, index: rv.index + 1 } });
      setMode(null);
      setNote({ text: `stem #${added.id} added, a tree of its own; Fit or Radius measures it` });
    }
  }, []);

  // while a click mode is on, the next clicks go to the stem, on the slab's plane
  useEffect(() => {
    if (!mode || !cur) { setWorldPicker(null); return; }
    const [cx, cy] = axisAt(cur);
    const plane = { anchor: [cx, cy, cur.z + BH] as [number, number, number], normal: [0, 0, 1] as [number, number, number] };
    setWorldPicker(() => planePicker(plane, onClick));
    return () => setWorldPicker(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, cur?.id, cur?.z, onClick, setWorldPicker]);

  const remove = useCallback(() => {
    const st = forestState();
    const rv = st.review;
    const sid = rv?.order[rv.index];
    if (!rv || sid === undefined) return;
    editSeeds((list) => deleteSeed(list, sid));
    markStem(sid, null);
    const order = rv.order.filter((x) => x !== sid);
    if (order.length === 0) { setForestState({ review: null, selected: null }); return; }
    setForestState({ review: { ...rv, order, index: Math.min(rv.index, order.length - 1) }, selected: null });
    setMode(null);
  }, []);

  const accept = useCallback(() => {
    const rv = forestState().review;
    const sid = rv?.order[rv.index];
    if (sid === undefined) return;
    if (forestState().marks[sid]?.status !== 'edited') markStem(sid, 'ok');
    go(1);
  }, [go]);

  const fit = useCallback(async () => {
    const desktop = (window as unknown as { desktop?: Desktop }).desktop;
    const st = forestState();
    const rv = st.review;
    const s = rv ? st.seeds?.find((x) => x.id === rv.order[rv.index]) : null;
    if (!s || !rv || !octree?.dir) return;
    if (!desktop?.octreeVirtualCaliper) { setNote({ text: 'the caliper needs the desktop app', warn: true }); return; }
    const [ax, ay] = axisAt(s);
    const search = Math.max(0.3, 2 * Math.max(s.r, 0.05) + 0.15);
    setBusy(true); setNote({ text: 'fitting…' });
    try {
      const m = await desktop.octreeVirtualCaliper(octree.dir, ax, ay, s.z + BH, Math.max(0.03, rv.slab), search);
      const off = Math.hypot(m.centerX - ax, m.centerY - ay);
      if (!(m.radius > 0) || off > Math.max(s.r, 0.1) + 0.25) {
        setNote({ text: `the circle fitted ${off.toFixed(2)} m from the stem's centre — move the stem onto it first, or set the radius by hand`, warn: true });
        return;
      }
      editSeeds((list) => measureSeed(list, s.id, m.radius, [m.centerX, m.centerY]));
      markStem(s.id, 'edited');
      setNote({ text: `⌀ ${(m.radius * 200).toFixed(1)} cm · rmse ${(m.rmse * 100).toFixed(1)} cm · ${Math.round(m.coverage * 100)} % of the round seen · ${m.pointCount} points${m.rejectedCount > 0 ? ` (${m.rejectedCount} strays left out)` : ''}` });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), warn: true });
    } finally {
      setBusy(false);
    }
  }, [octree?.dir]);

  const exit = useCallback(() => { setMode(null); setForestState({ review: null, mode: 'select' }); }, []);

  // keys: ← → step, Enter accepts, Delete deletes, M R A click modes, F fits,
  // Esc ends the click mode, then the review. Taken before the editor's own
  // bindings (Delete there deletes the selected points).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      let done = true;
      if (k === 'ArrowRight' || k === 'PageDown') go(1);
      else if (k === 'ArrowLeft' || k === 'PageUp') go(-1);
      else if (k === 'Enter') accept();
      else if (k === 'Delete' || k === 'Backspace') remove();
      else if (k === 'm' || k === 'M') setMode((m) => (m === 'move' ? null : 'move'));
      else if (k === 'r' || k === 'R') setMode((m) => (m === 'radius' ? null : 'radius'));
      else if (k === 'a' || k === 'A') setMode((m) => (m === 'add' ? null : 'add'));
      else if (k === 'f' || k === 'F') void fit();
      else if (k === 'Escape') { if (modeRef.current) setMode(null); else exit(); }
      else done = false;
      if (done) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go, accept, remove, fit, exit]);

  if (!r) return null;
  const total = r.order.length;
  const marked = Object.keys(f.marks).length;
  const mark = cur ? f.marks[cur.id] : undefined;
  const doubts = cur ? stemDoubts(seeds, cur, f.suggestions) : [];
  return (
    <div className="flex flex-col gap-1.5 rounded-md p-1.5" style={{ border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)' }}>
      <div className="flex items-center justify-between mono text-[10.5px]" style={{ color: 'var(--text)' }}>
        <span>Stem review · {Math.min(r.index + 1, total)} / {total}</span>
        <span className="text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{marked} looked at</span>
      </div>
      {cur ? (
        <div className="flex flex-col gap-0.5 mono text-[9.5px]" style={{ color: 'var(--text-dim)', lineHeight: 1.45 }}>
          <span>
            stem #{cur.id} · tree {cur.tree} · {cur.source === 'manual' ? 'measured by hand' : cur.source}
            {cur.r > 0 ? ` · ⌀ ${(cur.r * 200).toFixed(1)} cm` : ' · no diameter'}
            {mark ? ` · ${mark.status === 'ok' ? '✓ ok' : '✎ edited'}` : ''}
          </span>
          {doubts.map((d) => <span key={d} style={{ color: 'var(--warn, #f59e0b)' }}>• {d}</span>)}
        </div>
      ) : (
        <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>this stem is gone</div>
      )}
      <div className="flex gap-1">
        <button type="button" className="btn !h-6 flex-1 justify-center mono text-[10px]" onClick={() => go(-1)} disabled={r.index === 0} title="Previous stem (←)">◀</button>
        <button type="button" className="btn btn-primary !h-6 flex-[2] justify-center mono text-[10px]" onClick={accept} title="The stem is right: mark it and go on (Enter)">OK ▶</button>
        <button type="button" className="btn !h-6 flex-1 justify-center mono text-[10px]" onClick={() => go(1)} disabled={r.index >= total - 1} title="Next stem without marking (→)">▶</button>
      </div>
      <div className="flex gap-1">
        {CLICKS.map(([m, label, key, hint]) => {
          const on = mode === m;
          return (
            <button key={m} type="button" title={`${hint} (${key})`} onClick={() => setMode(on ? null : m)}
              className="flex-1 rounded py-1 mono text-[10px]"
              style={{
                border: `1px solid ${on ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
                background: on ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
                color: on ? 'var(--accent)' : 'var(--text-dim)',
              }}>{label}</button>
          );
        })}
        <button type="button" className="btn !h-6 !px-1.5 mono text-[10px]" disabled={busy || !cur} onClick={() => void fit()}
          title="Fit a circle to the points of the slab round the stem (the virtual caliper) and take it (F)">Fit</button>
        <button type="button" className="btn !h-6 !px-1.5 mono text-[10px]" disabled={!cur} onClick={remove} title="Delete the stem: a stump, a shrub, a branch (Delete)">Delete</button>
      </div>
      {mode && (
        <div className="mono text-[9.5px]" style={{ color: 'var(--accent)', lineHeight: 1.4 }}>
          {CLICKS.find(([m]) => m === mode)?.[3]}. Esc to move the view.
        </div>
      )}
      {note && <div className="mono text-[9.5px]" style={{ color: note.warn ? 'var(--danger, #f87171)' : 'var(--text-dim)', lineHeight: 1.4 }}>{note.text}</div>}
      {cur && (
        <div className="flex gap-1">
          <button type="button" className="btn !h-6 !px-1.5 mono text-[9.5px]" onClick={() => editSeeds((list) => splitSeed(list, cur.id))}
            disabled={seeds.filter((s) => s.tree === cur.tree).length < 2} title="Make this stem a tree of its own">Own tree</button>
          {cur.source === 'manual' && (
            <button type="button" className="btn !h-6 !px-1.5 mono text-[9.5px]" onClick={() => editSeeds((list) => unmeasureSeed(list, cur.id))}
              title="Let the forest pass measure this stem again at the next re-grow">Measure on re-grow</button>
          )}
          <button type="button" className="btn !h-6 !px-1.5 mono text-[9.5px]" onClick={look} title="Back to the stem from above">Re-centre</button>
        </div>
      )}
      <div className="flex items-center gap-1 mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
        <span>view</span>
        {VIEWS.map((v) => (
          <button key={v} type="button" className="btn !h-5 !px-1 text-[9px]" style={r.view === v ? { color: 'var(--accent)' } : undefined}
            onClick={() => setForestState({ review: { ...r, view: v } })}>{v} m</button>
        ))}
        <span className="ml-1">slab ±</span>
        {SLABS.map((v) => (
          <button key={v} type="button" className="btn !h-5 !px-1 text-[9px]" style={r.slab === v ? { color: 'var(--accent)' } : undefined}
            onClick={() => setForestState({ review: { ...r, slab: v } })}>{Math.round(v * 1000) / 10} cm</button>
        ))}
      </div>
      <div className="flex gap-1">
        <button type="button" className="btn !h-6 flex-1 justify-center mono text-[10px]" onClick={exit} title="Back to the view as it was (Esc)">End review</button>
      </div>
    </div>
  );
}
