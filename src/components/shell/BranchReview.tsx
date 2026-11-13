// The branch review: the branches the forest pass nearly gave to
// another tree, one at a time, largest first (forest/near_ties.json). When
// the trees were grown, the boundary of each of these with the other tree
// was close to a tie; compared with the hand-segmented MLS plots, that is
// where the branches that went to the wrong tree are (a tree reaches a
// neighbour's branch from its tip). Each can be looked at, moved to the
// other tree — an edit like any other, undone with Ctrl+Z — or passed as
// right. On MLS plots the learned owner model has already moved the
// branches it was sure of; those are listed the other way round (the tree
// that has them now first) and say so, and Move gives one back.
//
// Everything here is the editor's own: the camera's frame on a box, the
// tree colours, and the patch store's undoable edits (applyToRecords).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { firstUnmarked, forestState, markTie, setForestState, useForestStore, type NearTie } from './forestStore';

interface Desktop {
  octreeForestBranchPoints?: (dir: string, id: number) => Promise<[number, number[]][]>;
}

/** Start the review at the first branch not looked at yet. */
export function startBranchReview(): void {
  const st = forestState();
  if (st.ties.length === 0) return;
  setForestState({ tieReview: { index: firstUnmarked(st.ties, st.tieMarks) }, review: null });
}

/** The box the view frames for a branch: the branch, and room round it. */
/** What to ask of a branch: whether the owner model moved it, and how sure it was. */
export function tieQuestion(t: NearTie): string {
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  if (t.auto) return `Moved here from tree ${t.other} by the owner model${t.p === undefined ? '' : `, ${pct(t.p)} sure`} — is it tree ${t.tree}’s?`;
  return `Is it tree ${t.other}’s branch, reached by tree ${t.tree} from its tip?${t.p === undefined ? '' : ` Owner model: ${pct(t.p)} tree ${t.other}’s.`}`;
}

export function tieFrame(t: NearTie, pad = 1.5): [[number, number, number], [number, number, number]] {
  return [
    [t.min[0] - pad, t.min[1] - pad, t.min[2] - pad],
    [t.max[0] + pad, t.max[1] + pad, t.max[2] + pad],
  ];
}

export default function BranchReview() {
  const { api, octree, display, setDisplay } = useOctreeShell();
  const f = useForestStore();
  const r = f.tieReview;
  const cur = r ? f.ties[Math.min(r.index, f.ties.length - 1)] ?? null : null;
  const [note, setNote] = useState<{ text: string; warn?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  // the trees in their own colours while reviewing, as they were afterwards
  const shell = useRef({ setDisplay });
  shell.current = { setDisplay };
  const savedColour = useRef(display.colorMode);
  useEffect(() => {
    savedColour.current = display.colorMode;
    shell.current.setDisplay({ colorMode: 'tree_id' });
    return () => { shell.current.setDisplay({ colorMode: savedColour.current }); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const look = useCallback(() => {
    const st = forestState();
    const t = st.tieReview ? st.ties[st.tieReview.index] : null;
    if (!t || !api) return;
    const [lo, hi] = tieFrame(t);
    api.frameBox(lo, hi);
  }, [api]);
  useEffect(() => { look(); setNote(null); }, [r?.index, look]);

  const go = useCallback((d: number) => {
    const st = forestState();
    if (!st.tieReview) return;
    const index = Math.max(0, Math.min(st.ties.length - 1, st.tieReview.index + d));
    setForestState({ tieReview: { index } });
  }, []);

  const accept = useCallback(() => {
    const st = forestState();
    const t = st.tieReview ? st.ties[st.tieReview.index] : null;
    if (!t) return;
    if (st.tieMarks[t.id] !== 'moved') markTie(t.id, 'ok');
    go(1);
  }, [go]);

  const move = useCallback(async () => {
    const st = forestState();
    const t = st.tieReview ? st.ties[st.tieReview.index] : null;
    const desktop = (window as unknown as { desktop?: Desktop }).desktop;
    if (!t || !api || !octree?.dir) return;
    if (!desktop?.octreeForestBranchPoints) { setNote({ text: 'moving a branch needs the desktop app', warn: true }); return; }
    setBusy(true); setNote({ text: 'finding the branch’s points…' });
    try {
      const groups = await desktop.octreeForestBranchPoints(octree.dir, t.id);
      const n = api.applyToRecords(groups, { treeId: t.other });
      if (n === 0) { setNote({ text: 'none of its points are tree ' + t.tree + ' any more', warn: true }); return; }
      markTie(t.id, 'moved');
      setNote({ text: `${n.toLocaleString()} points moved to tree ${t.other} — Ctrl+Z puts them back` });
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : String(e), warn: true });
    } finally {
      setBusy(false);
    }
  }, [api, octree?.dir]);

  const exit = useCallback(() => setForestState({ tieReview: null }), []);

  // keys: ← → step, Enter passes the branch as right, M moves it, L looks
  // again, Esc ends the review. Taken before the editor's own bindings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      let done = true;
      if (k === 'ArrowRight' || k === 'PageDown') go(1);
      else if (k === 'ArrowLeft' || k === 'PageUp') go(-1);
      else if (k === 'Enter') accept();
      else if (k === 'm' || k === 'M') void move();
      else if (k === 'l' || k === 'L') look();
      else if (k === 'Escape') exit();
      else done = false;
      if (done) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [go, accept, move, look, exit]);

  if (!r) return null;
  const total = f.ties.length;
  const looked = Object.keys(f.tieMarks).length;
  const mark = cur ? f.tieMarks[cur.id] : undefined;
  return (
    <div className="flex flex-col gap-1.5 rounded-md p-1.5" style={{ border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)' }}>
      <div className="flex items-center justify-between mono text-[10.5px]" style={{ color: 'var(--text)' }}>
        <span>Branch review · {Math.min(r.index + 1, total)} / {total}</span>
        <span className="text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{looked} looked at</span>
      </div>
      {cur && (
        <div className="flex flex-col gap-0.5 mono text-[9.5px]" style={{ color: 'var(--text-dim)', lineHeight: 1.45 }}>
          <span>
            tree {cur.tree} → or tree {cur.other} · {cur.points.toLocaleString()} points · tie {(cur.ratio * 100).toFixed(1)} %
            {mark ? ` · ${mark === 'ok' ? '✓ right' : '→ moved'}` : ''}
          </span>
          <span style={{ color: 'var(--text-mute)' }}>{tieQuestion(cur)}</span>
        </div>
      )}
      <div className="flex gap-1">
        <button type="button" className="btn !h-6 flex-1 justify-center mono text-[10px]" onClick={() => go(-1)} disabled={r.index === 0} title="Previous branch (←)">◀</button>
        <button type="button" className="btn btn-primary !h-6 flex-[2] justify-center mono text-[10px]" onClick={accept} title="The branch is right where it is: mark it and go on (Enter)">Right ▶</button>
        <button type="button" className="btn !h-6 flex-1 justify-center mono text-[10px]" onClick={() => go(1)} disabled={r.index >= total - 1} title="Next branch without marking (→)">▶</button>
      </div>
      <div className="flex gap-1">
        <button type="button" className="btn !h-6 flex-[2] justify-center mono text-[10px]" disabled={busy || !cur || mark === 'moved'} onClick={() => void move()}
          title="Give the branch's points to the other tree — an edit like any other, Ctrl+Z undoes it (M)">
          {cur ? `Move to tree ${cur.other}` : 'Move'}
        </button>
        <button type="button" className="btn !h-6 flex-1 justify-center mono text-[10px]" disabled={!cur} onClick={look} title="Back to the branch (L)">Look</button>
      </div>
      {note && <div className="mono text-[9.5px]" style={{ color: note.warn ? 'var(--danger, #f87171)' : 'var(--text-dim)', lineHeight: 1.4 }}>{note.text}</div>}
      <div className="flex gap-1">
        <button type="button" className="btn !h-6 flex-1 justify-center mono text-[10px]" onClick={exit} title="End the review (Esc)">End review</button>
      </div>
    </div>
  );
}
