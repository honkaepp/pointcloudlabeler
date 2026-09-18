// History / persistence panel — undo, redo, save edits to patches.bin,
// and export the dataset (with edits applied) to LAS. The save button
// surfaces the LIVE save state (saving / saved at HH:MM:SS / error),
// because an earlier "fire and forget" save silently swallowed WebView2
// hangs on big patch buffers and cost the user real editing work. Every
// save must be visible.

import { useEffect, useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { confirmDialog } from '../../ui/dialogs';

export default function HistoryPanel() {
  const { octree, api, dirty, saveStatus, lastSavedAt, saveError, autosaveEnabled, setAutosaveEnabled, reloadActiveOctree } = useOctreeShell();
  const ready = !!api;
  // Tick once a second so "Saved · 12 s ago" stays accurate without
  // having to drive a render from a Date.now() ref each frame.
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!lastSavedAt) return;
    const t = setInterval(() => setNow(n => n + 1), 1000);
    return () => clearInterval(t);
  }, [lastSavedAt]);

  const onClickSave = async () => {
    if (!api) return;
    try { await api.save(); } catch { /* surfaced via saveError */ }
  };

  // Bake: fold the accumulated tree_id + semantic overrides in
  // patches.bin into octree.bin and drop them from patches.bin, so a
  // long correction session (one 32-byte record per point of every
  // corrected tree) doesn't grow the overlay without bound. Not part of
  // OctreeShellApi — this is a one-off maintenance action, not a viewer
  // edit — so it's wired straight to window.desktop like EnableDeadwood
  // (SegmentPanel.tsx) does for its own one-off backend call.
  const desktop = (window as unknown as {
    desktop?: { octreeBakePatches?: (dir: string) => Promise<{ baked: number; remaining: number; unmatched: number }> };
  }).desktop;
  const [baking, setBaking] = useState(false);
  const [bakeResult, setBakeResult] = useState<{ baked: number; remaining: number; unmatched: number } | null>(null);
  const [bakeError, setBakeError] = useState<string | null>(null);

  // A "Baked …" line from a previously-open dataset would be misleading
  // once the user switches clouds — drop it along with any stale error.
  useEffect(() => {
    setBakeResult(null);
    setBakeError(null);
  }, [octree?.dir]);

  const canBake = ready && !!octree && !!desktop?.octreeBakePatches;

  const onClickBake = async () => {
    if (!api || !octree || !desktop?.octreeBakePatches) return;
    if (!await confirmDialog(
      'Bake edits permanently folds the accumulated tree_id + semantic corrections into the dataset (octree.bin) and clears them out of the edit overlay (patches.bin). This resets the undo/redo history — deletions are left exactly as they are. The result is saved immediately and can\'t be undone with Ctrl+Z.\n\nContinue?',
    )) return;
    setBaking(true); setBakeError(null); setBakeResult(null);
    try {
      // Flush pending in-memory edits first so nothing is lost off the
      // undo stack before it gets reset.
      await api.save();
      const res = await desktop.octreeBakePatches(octree.dir);
      setBakeResult(res);
      await reloadActiveOctree?.();
    } catch (e) {
      setBakeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBaking(false);
    }
  };

  const label =
    saveStatus === 'saving' ? 'Saving…' :
    saveStatus === 'error'  ? 'Save failed' :
    dirty                   ? 'Save edits' :
    lastSavedAt             ? `Saved · ${relTime(lastSavedAt)}` :
                              'Saved';

  // Saving must NEVER be disabled by "dirty: false" if the user actually
  // wants to force a re-write — keep it enabled while dirty, while
  // saving, or when the last attempt errored. Also enabled when nothing
  // is pending so the user can force a clean save if they're paranoid.
  const disabled = !ready || saveStatus === 'saving';

  const accent =
    saveStatus === 'error'  ? 'danger' :
    saveStatus === 'saving' ? 'saving' :
    dirty                   ? 'primary' : null;

  const style: React.CSSProperties =
    accent === 'danger'  ? { background: 'rgba(224,80,107,0.18)', borderColor: 'color-mix(in oklch, var(--danger, #e0506b) 70%, transparent)', color: '#ffb4be' } :
    accent === 'saving'  ? { background: 'var(--wash-2)', borderColor: 'var(--line-strong)' } :
    {};

  return (
    <div className="flex flex-col gap-2" style={{ width: 230 }}>
      <div className="grid grid-cols-2 gap-1.5">
        <button className="btn !h-8 justify-center gap-1.5 mono text-[11px]" disabled={!ready} onClick={() => api?.undo()} title="Undo (⌘Z)">
          <UndoIcon /> Undo
        </button>
        <button className="btn !h-8 justify-center gap-1.5 mono text-[11px]" disabled={!ready} onClick={() => api?.redo()} title="Redo (⌘⇧Z)">
          <RedoIcon /> Redo
        </button>
      </div>

      <button
        className={`btn !h-8 justify-center gap-1.5 mono text-[11.5px] ${accent === 'primary' ? 'btn-primary' : ''}`}
        style={style}
        disabled={disabled}
        onClick={onClickSave}
        title={
          saveStatus === 'error'  ? `Save failed: ${saveError ?? 'unknown error'}. Click to retry.` :
          saveStatus === 'saving' ? 'Writing patches.bin…' :
          dirty                   ? 'Save edits to patches.bin (⌘S)' :
          lastSavedAt             ? `Last saved at ${new Date(lastSavedAt).toLocaleTimeString()}` :
                                    'No unsaved edits'
        }
      >
        {saveStatus === 'saving' ? <Spinner /> : <SaveIcon />} {label}
      </button>

      {saveStatus === 'error' && saveError && (
        <div
          className="mono text-[10px] px-2 py-1.5 rounded"
          style={{ color: '#ffb4be', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 45%, transparent)', lineHeight: 1.45 }}
          title={saveError}
        >
          {saveError.length > 200 ? `${saveError.slice(0, 200)}…` : saveError}
        </div>
      )}

      <label
        className="flex items-center gap-1.5 mono text-[10px] px-0.5"
        style={{ color: 'var(--text-dim)', cursor: 'pointer', userSelect: 'none' }}
        title="When on, unsaved edits are flushed to disk in the background after sitting dirty for 2 minutes — protection against a crash or power cut. When off, only manual saves (button / ⌘S) write, and closing without saving discards the session's edits."
      >
        <input
          type="checkbox"
          checked={autosaveEnabled}
          onChange={(e) => setAutosaveEnabled(e.target.checked)}
        />
        Autosave edits (2 min)
      </label>

      <button
        className="btn !h-8 justify-center gap-1.5 mono text-[11.5px]"
        disabled={!canBake || baking}
        onClick={onClickBake}
        title="Fold accumulated tree_id + semantic edits into octree.bin and shrink patches.bin. Resets undo/redo history; deletions are unaffected."
      >
        {baking ? <Spinner /> : <BakeIcon />} {baking ? 'Baking…' : 'Bake edits to disk'}
      </button>

      {bakeResult && !baking && (
        <div className="mono text-[10px] px-2 py-1.5 rounded" style={{ color: bakeResult.unmatched > 0 ? '#ffb4be' : 'var(--text-mute)', background: bakeResult.unmatched > 0 ? 'rgba(224,80,107,0.10)' : undefined, border: bakeResult.unmatched > 0 ? '1px solid color-mix(in oklch, var(--danger, #e0506b) 45%, transparent)' : undefined, lineHeight: 1.45 }}>
          Baked {bakeResult.baked.toLocaleString()} corrections into the dataset
          {bakeResult.remaining > 0 && <> · {bakeResult.remaining.toLocaleString()} deletion/deadwood records left in the overlay</>}
          {bakeResult.unmatched > 0 && (
            <><br />⚠ {bakeResult.unmatched.toLocaleString()} edits matched no point — nothing was dropped (the overlay was kept intact). Please report this.</>
          )}
        </div>
      )}
      {bakeError && (
        <div
          className="mono text-[10px] px-2 py-1.5 rounded"
          style={{ color: '#ffb4be', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 45%, transparent)', lineHeight: 1.45 }}
          title={bakeError}
        >
          {bakeError.length > 200 ? `${bakeError.slice(0, 200)}…` : bakeError}
        </div>
      )}

      <button
        className="btn !h-8 justify-center gap-1.5 mono text-[11.5px]"
        disabled={!ready}
        onClick={() => api?.exportLas()}
        title="Save, then export to LAS (tree_id + semantic in Extra-Bytes)"
      >
        <ExportIcon /> Export LAS
      </button>
    </div>
  );
}

/** "12 s ago" / "3 min ago" / "1 h ago" — Tree Review uses the same form. */
function relTime(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}

function Spinner() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.6" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite" />
      </path>
    </svg>
  );
}

function UndoIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h6a3 3 0 1 1 0 6H7M4 7l3-3M4 7l3 3"/></svg>;
}
function RedoIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 7H6a3 3 0 1 0 0 6h3M12 7l-3-3M12 7l-3 3"/></svg>;
}
function SaveIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h8l2 2v8H3z"/><path d="M6 3v3h4V3M6 13v-3h4v3"/></svg>;
}
function ExportIcon() {
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2v8M5 7l3 3 3-3M3 13h10"/></svg>;
}
function BakeIcon() {
  // Two overlapping layers compacting down into one — patches.bin
  // (the overlay) folding into octree.bin (the base).
  return <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2 3 4.5 8 7l5-2.5L8 2Z"/><path d="M3 8l5 2.5L13 8M4.5 11 8 12.5 11.5 11"/></svg>;
}
