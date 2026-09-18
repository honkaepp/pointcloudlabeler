// Tools panel — the primary editing surface. Selection tool + depth,
// active tree_id with stepper / new / eyedropper hint, semantic labels,
// and hide / unhide. Reads everything from the shell context so it can
// float anywhere. No "edit mode" gate: a drag in the viewport always
// selects, Shift+drag orbits, Alt subtracts (handled in OctreeView).

import { useState } from 'react';
import { useOctreeShell } from './OctreeShellContext';
import { isDeadwoodExtra } from '../../persistence/octreeReader';
import { useKeybindings, formatChord } from '../../state/keybindings';
import { confirmDialog } from '../../ui/dialogs';

export default function ToolsPanel() {
  const { tools, setTools, api, selectedCount, editMode, setEditMode, measuring, setMeasuring, display, setDisplay, octree } = useOctreeShell();
  const keys = useKeybindings();
  // Shortcut labels shown on the Assign / Reset buttons so the hotkeys
  // are discoverable; empty when the user has cleared the binding.
  const assignKey = keys['edit.assign'] ? formatChord(keys['edit.assign']) : '';
  const resetKey = keys['edit.reset'] ? formatChord(keys['edit.reset']) : '';
  const hasSel = selectedCount > 0;
  const ready = !!api;
  const canSelect = editMode && !measuring;
  // Whether this dataset carries the two reserved deadwood id channels.
  // New imports always do; only a legacy dataset imported before the
  // feature lacks them (then the Deadwood tab is hidden).
  const hasDeadwood = (octree?.meta.extras ?? []).some(e => isDeadwoodExtra(e.name));
  // Which label workflow the current colour mode maps to. Tree-id,
  // semantic and deadwood editing are deliberately separate: the section
  // shown below follows this so what you edit is always what you see. Any
  // other colour mode (height / intensity / class / flat) is display-only.
  const editTarget: 'tree_id' | 'semantic' | 'deadwood' | null =
    display.colorMode === 'tree_id' ? 'tree_id'
    : display.colorMode === 'semantic' ? 'semantic'
    : (display.colorMode === 'standing_deadwood' || display.colorMode === 'laying_deadwood') ? 'deadwood'
    : null;

  return (
    <div className="flex flex-col gap-3" style={{ width: 252 }}>
      {/* Mode — camera vs edit. Space toggles globally; the chip here
          mirrors the active mode so the user can see at a glance which
          one a left-drag will execute. */}
      <Section label="Mode">
        <Segmented
          value={editMode ? 'edit' : 'camera'}
          onChange={(v) => setEditMode(v === 'edit')}
          options={[
            { value: 'camera', label: 'Camera', icon: <CameraIcon /> },
            { value: 'edit',   label: 'Edit',   icon: <EditIcon /> },
          ]}
        />
        <Hint>
          <b>Space</b> toggles · Camera: drag rotates · Edit: drag selects, <b>Shift</b>+drag orbits, <b>Shift</b>+click picks id
        </Hint>
        <button
          onClick={() => setMeasuring(!measuring)}
          className="btn !h-7 w-full justify-center gap-1.5 mono text-[11px] mt-1.5"
          style={{
            border: `1px solid ${measuring ? 'color-mix(in oklch, #ffd24a 60%, transparent)' : 'var(--line)'}`,
            background: measuring ? 'rgba(255,210,74,0.12)' : 'transparent',
            color: measuring ? '#ffd24a' : 'var(--text-dim)',
          }}
          title="Measure distance between two points (M)"
        >
          <RulerIcon /> {measuring ? 'Measuring…' : 'Measure'}
        </button>
        {measuring && (
          <Hint>Click two points for a 3D distance · drag still orbits · <b>Esc</b> clears · <b>M</b> exits</Hint>
        )}
      </Section>

      {/* Selection tool — segmented control */}
      <Section label="Selection">
        <Segmented
          value={tools.selectTool}
          onChange={(v) => setTools({ selectTool: v as typeof tools.selectTool })}
          options={[
            { value: 'lasso', label: 'Lasso', icon: <LassoIcon /> },
            { value: 'rect', label: 'Rect', icon: <RectIcon /> },
            { value: 'poly', label: 'Poly', icon: <PolyIcon /> },
          ]}
        />
        <div className="mt-1.5">
          <Segmented
            value={tools.selectDepth}
            onChange={(v) => setTools({ selectDepth: v as typeof tools.selectDepth })}
            options={[
              { value: 'visible', label: 'Visible' },
              { value: 'through', label: 'Through' },
            ]}
          />
        </div>
        {!canSelect && (
          <Hint>Selection is off in Camera mode — press <b>Space</b> or click <b>Edit</b> above.</Hint>
        )}
      </Section>

      {/* Edit target — tree_id vs semantic are two separate workflows.
          Picking one switches the viewport colouring to match, so what
          you edit is always what you see: Tree id paints instance ids
          (with the active-tree highlight); Semantic paints stem/branch
          (no highlight, no active tree needed). Other colour modes
          (height / intensity / class) are display-only — pick an edit
          target here to start labelling. */}
      <Section label="Edit">
        <Segmented
          value={editTarget ?? ''}
          onChange={(v) => {
            if (v === 'deadwood') {
              // Drop into whichever deadwood channel is currently active so
              // the highlight + tools target it; the section's toggle flips
              // both the channel and the colour mode together.
              setDisplay({ colorMode: tools.deadwoodChannel === 'standing' ? 'standing_deadwood' : 'laying_deadwood' });
            } else {
              setDisplay({ colorMode: v as 'tree_id' | 'semantic' });
            }
          }}
          options={[
            { value: 'tree_id', label: 'Tree id', icon: <TreeIcon /> },
            { value: 'semantic', label: 'Semantic', icon: <LeafIcon /> },
            ...(hasDeadwood ? [{ value: 'deadwood', label: 'Deadwood', icon: <DeadwoodIcon /> }] : []),
          ]}
        />
        {editTarget === null && (
          <Hint>
            Colouring by <b>{display.colorMode}</b> — pick <b>Tree id</b>, <b>Semantic</b>
            {hasDeadwood ? <> or <b>Deadwood</b></> : null} above to edit labels.
          </Hint>
        )}
      </Section>

      {/* Tree-id editing — only in tree_id colour mode. */}
      {editTarget === 'tree_id' && (
        <Section label="Tree id">
          <div className="flex items-center gap-1.5">
            <Stepper
              value={tools.activeTreeId}
              onChange={(n) => setTools({ activeTreeId: Math.max(0, n) })}
            />
            <button
              className="btn btn-ghost !h-7 !px-2 mono text-[11px]"
              disabled={!ready}
              onClick={() => api?.newTree()}
              title="Next unused tree id"
            >+ New</button>
          </div>
          <div className="grid grid-cols-2 gap-1.5 mt-1.5">
            <button
              className="btn btn-primary !h-7 !px-2 mono text-[11px] justify-center gap-1.5"
              disabled={!ready || !hasSel}
              onClick={() => api?.apply({ treeId: Math.max(0, Math.floor(tools.activeTreeId)) })}
              title={`Assign active tree id to the selection${assignKey ? ` (${assignKey})` : ''}`}
            >Assign{assignKey && <kbd className="kbd">{assignKey}</kbd>}</button>
            <button
              className="btn !h-7 !px-2 mono text-[11px] justify-center gap-1.5"
              disabled={!ready || !hasSel}
              onClick={() => api?.apply({ treeId: 0 })}
              title={`Reset tree id of the selection back to 0 / unassigned${resetKey ? ` (${resetKey})` : ''}`}
            >Reset{resetKey && <kbd className="kbd">{resetKey}</kbd>}</button>
          </div>
          <ClearSelButton ready={ready} hasSel={hasSel} count={selectedCount} onClear={() => api?.clearSelection()} />
          <ResetColumnButton
            ready={ready}
            label="Reset every tree_id"
            confirmMsg="Reset EVERY point's tree_id back to 0? This clears all instance segmentation across the whole cloud (undoable edits are discarded). The change is saved immediately."
            onReset={() => api?.resetAttribute('tree_id')}
          />
          {/* Active-tree highlight colour — the tree the tools act on. */}
          <label className="flex items-center gap-2 mt-2 cursor-pointer">
            <span className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>highlight</span>
            <span
              className="rounded-sm relative overflow-hidden"
              style={{ width: 22, height: 14, background: display.activeTreeColor, boxShadow: '0 0 0 1px rgba(255,255,255,0.2)' }}
            >
              <input
                type="color"
                value={display.activeTreeColor}
                onChange={(e) => setDisplay({ activeTreeColor: e.target.value })}
                className="absolute inset-0 opacity-0 cursor-pointer"
                style={{ width: '100%', height: '100%' }}
                title="Active-tree highlight colour"
              />
            </span>
            <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>{display.activeTreeColor}</span>
          </label>
        </Section>
      )}

      {/* Semantic editing — only in semantic colour mode. No active tree
          / highlight here; you lasso points and paint stem / branch
          directly onto whatever's selected. */}
      {editTarget === 'semantic' && (
        <Section label="Semantic">
          <div className="grid grid-cols-3 gap-1.5">
            <SemBtn color="#af6e3c" label="Stem" disabled={!ready || !hasSel} onClick={() => api?.apply({ semantic: 1 })} />
            <SemBtn color="#46b45a" label="Branch" disabled={!ready || !hasSel} onClick={() => api?.apply({ semantic: 2 })} />
            <SemBtn color="#888" label="Unlabel" disabled={!ready || !hasSel} onClick={() => api?.apply({ semantic: 3 })} />
          </div>
          <ClearSelButton ready={ready} hasSel={hasSel} count={selectedCount} onClear={() => api?.clearSelection()} />
          <ResetColumnButton
            ready={ready}
            label="Clear every semantic label"
            confirmMsg="Clear EVERY point's semantic label (stem / branch) across the whole cloud? Undoable edits are discarded and the change is saved immediately."
            onReset={() => api?.resetAttribute('semantic')}
          />
          <Hint>Lasso points → paint <b>Stem</b> / <b>Branch</b> · <b>Unlabel</b> removes the label. Works on any visible tree.</Hint>
        </Section>
      )}

      {/* Deadwood editing — two id channels (standing dead trees + fallen /
          lying logs). Pick a channel, set the active id, lasso the dead
          tree, Assign. Each labelled instance gets its own deadwood id;
          Clear sets the selection back to 0 (unlabelled). Reset wipes a
          whole channel. The values export as the standing_deadwood /
          laying_deadwood Extra-Bytes columns. */}
      {editTarget === 'deadwood' && (
        <DeadwoodSection ready={ready} hasSel={hasSel} selectedCount={selectedCount} />
      )}

      {/* Delete + selection. "Delete" marks the selection as removed — the
          points vanish from the view AND are dropped from any export /
          terrain / analysis (it's the same per-point flag the exporter
          skips). "Restore" brings a previously-deleted selection back.
          Both are fully undoable and never touch the source file. */}
      <Section label="Points">
        <div className="grid grid-cols-2 gap-1.5">
          <button className="btn !h-7 !px-2 mono text-[11px]" disabled={!ready || !hasSel} onClick={() => api?.apply({ deleted: 1 })} title="Delete selected — removed from the view and from every export (Delete / Backspace)">Delete</button>
          <button className="btn !h-7 !px-2 mono text-[11px]" disabled={!ready || !hasSel} onClick={() => api?.apply({ deleted: 2 })} title="Restore previously deleted points in the selection">Restore</button>
        </div>
        <button
          className="btn btn-ghost !h-7 w-full justify-center mono text-[11px] mt-1.5"
          disabled={!hasSel}
          onClick={() => api?.clearSelection()}
        >
          {hasSel ? `Deselect ${selectedCount.toLocaleString()}` : 'No selection'}
        </button>
      </Section>
    </div>
  );
}

// ---------------- deadwood ----------------

/** Manual labelling of standing + laying deadwood. Mirrors the tree_id
 *  workflow (active id stepper + New + Assign / Clear) but with a channel
 *  toggle, and writes into the dataset's two reserved deadwood id columns
 *  via the patch overlay (so it's undoable + non-destructive until saved). */
function DeadwoodSection({ ready, hasSel, selectedCount }: {
  ready: boolean; hasSel: boolean; selectedCount: number;
}) {
  const { tools, setTools, api, display, setDisplay } = useOctreeShell();
  // Channel is derived from the active colour mode (the source of truth for
  // what's drawn + highlighted), so picking a deadwood mode from the
  // Display panel and from this toggle can never disagree. This section
  // only renders while colourMode is one of the two deadwood channels.
  const channel: 'standing' | 'laying' = display.colorMode === 'standing_deadwood' ? 'standing' : 'laying';
  const activeId = channel === 'standing' ? tools.activeStandingId : tools.activeLayingId;
  const setActiveId = (n: number) => setTools(
    channel === 'standing' ? { activeStandingId: Math.max(0, n) } : { activeLayingId: Math.max(0, n) },
  );
  const assign = (id: number) => api?.apply(
    channel === 'standing' ? { standingDeadwood: id } : { layingDeadwood: id },
  );
  // Switching channel also switches the viewport colouring so the active
  // instance highlight + Shift+click eyedropper target the chosen channel.
  const setChannel = (v: 'standing' | 'laying') => {
    setTools({ deadwoodChannel: v });
    setDisplay({ colorMode: v === 'standing' ? 'standing_deadwood' : 'laying_deadwood' });
  };
  const accent = channel === 'standing' ? '#e0763c' : '#3a9cd6';

  return (
    <Section label="Deadwood">
      {/* Channel — standing dead trees vs fallen / lying logs. */}
      <Segmented
        value={channel}
        onChange={(v) => setChannel(v as 'standing' | 'laying')}
        options={[
          { value: 'standing', label: 'Standing', icon: <StandingDeadIcon /> },
          { value: 'laying', label: 'Laying', icon: <LayingDeadIcon /> },
        ]}
      />
      <div className="flex items-center gap-1.5 mt-1.5">
        <Stepper value={activeId} onChange={setActiveId} />
        <button
          className="btn btn-ghost !h-7 !px-2 mono text-[11px]"
          disabled={!ready}
          onClick={() => setActiveId((api?.maxDeadwoodId(channel) ?? 0) + 1)}
          title="Next unused deadwood id in this channel"
        >+ New</button>
      </div>
      <div className="grid grid-cols-2 gap-1.5 mt-1.5">
        <button
          className="btn !h-7 !px-2 mono text-[11px] justify-center"
          style={{ border: `1px solid color-mix(in oklch, ${accent} 60%, transparent)`, background: `color-mix(in oklch, ${accent} 16%, transparent)`, color: accent }}
          disabled={!ready || !hasSel}
          onClick={() => assign(Math.max(1, Math.floor(activeId)))}
          title={`Label the selection as ${channel} deadwood id ${activeId}`}
        >Assign</button>
        <button
          className="btn !h-7 !px-2 mono text-[11px] justify-center"
          disabled={!ready || !hasSel}
          onClick={() => assign(0)}
          title="Clear the deadwood label of the selection (back to none) in this channel"
        >Clear</button>
      </div>
      <ClearSelButton ready={ready} hasSel={hasSel} count={selectedCount} onClear={() => api?.clearSelection()} />
      <ResetColumnButton
        ready={ready}
        label={`Reset every ${channel} deadwood id`}
        confirmMsg={`Reset EVERY point's ${channel}-deadwood id back to 0 across the whole cloud? This clears all ${channel}-deadwood labelling (undoable edits are discarded). The change is saved immediately.`}
        onReset={() => api?.resetAttribute(channel === 'standing' ? 'standing_deadwood' : 'laying_deadwood')}
      />
      {/* Active-instance highlight colour — the log the tools act on, shown
          when you Shift+click an existing one. Shares the tree-id highlight
          colour so the "active" convention reads the same everywhere. */}
      <label className="flex items-center gap-2 mt-2 cursor-pointer">
        <span className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>highlight</span>
        <span
          className="rounded-sm relative overflow-hidden"
          style={{ width: 22, height: 14, background: display.activeTreeColor, boxShadow: '0 0 0 1px rgba(255,255,255,0.2)' }}
        >
          <input
            type="color"
            value={display.activeTreeColor}
            onChange={(e) => setDisplay({ activeTreeColor: e.target.value })}
            className="absolute inset-0 opacity-0 cursor-pointer"
            style={{ width: '100%', height: '100%' }}
            title="Active-instance highlight colour"
          />
        </span>
        <span className="mono text-[10px]" style={{ color: 'var(--text-dim)' }}>{display.activeTreeColor}</span>
      </label>
      <Hint>
        Pick a channel + id, lasso a dead {channel === 'standing' ? 'standing trunk' : 'fallen log'} → <b>Assign</b>.
        <b> Shift+click</b> an existing one to make it active and re-edit it (it highlights).
        <b> + New</b> starts a fresh instance · <b>Clear</b> unlabels the selection.
        Exports as the <b>{channel === 'standing' ? 'standing_deadwood' : 'laying_deadwood'}</b> column.
      </Hint>
    </Section>
  );
}

// ---------------- building blocks ----------------

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="chip mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <div className="mono text-[9.5px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>{children}</div>;
}

function Segmented<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: React.ReactNode }[];
}) {
  return (
    <div className="flex gap-1 p-0.5 rounded-md" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)' }}>
      {options.map(o => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="flex-1 flex items-center justify-center gap-1.5 rounded py-1.5 mono text-[11px] transition-all"
            style={{
              background: active ? 'color-mix(in oklch, var(--accent) 20%, transparent)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-dim)',
            }}
          >
            {o.icon}{o.label}
          </button>
        );
      })}
    </div>
  );
}

function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center rounded-md overflow-hidden" style={{ border: '1px solid var(--line-strong)' }}>
      <button className="px-2 py-1 hover:bg-white/5" style={{ color: 'var(--text-dim)' }} onClick={() => onChange(value - 1)}>−</button>
      <input
        type="number" min={0} value={value}
        onChange={(e) => onChange(parseInt(e.target.value || '0', 10))}
        className="bg-transparent w-12 text-center mono text-[12px] py-1"
        style={{ color: 'var(--text)', border: 'none', outline: 'none' }}
      />
      <button className="px-2 py-1 hover:bg-white/5" style={{ color: 'var(--text-dim)' }} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}

/** Clear the current selection — surfaced inside the tree_id + semantic
 *  edit sections (next to Assign / Reset / paint) so undoing a pick is one
 *  click away from where you select, not buried in another section. */
function ClearSelButton({ ready, hasSel, count, onClear }: {
  ready: boolean; hasSel: boolean; count: number; onClear: () => void;
}) {
  return (
    <button
      className="btn btn-ghost !h-7 w-full justify-center mono text-[11px] mt-1.5"
      disabled={!ready || !hasSel}
      onClick={onClear}
      title="Clear the current point selection (does not change any labels)"
    >
      {hasSel ? `Deselect ${count.toLocaleString()}` : 'No selection'}
    </button>
  );
}

/** Reset an entire column (tree_id / semantic) to 0 across the whole
 *  cloud. Destructive + immediate (it writes to disk), so it confirms
 *  first and shows a brief running state. Distinct from the per-selection
 *  Reset above, which only touches the current pick. */
function ResetColumnButton({ ready, label, confirmMsg, onReset }: {
  ready: boolean; label: string; confirmMsg: string; onReset?: () => Promise<number> | undefined;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn btn-ghost !h-7 w-full justify-center mono text-[10.5px] mt-1.5"
      style={{ color: 'var(--text-mute)' }}
      disabled={!ready || busy}
      title={label}
      onClick={async () => {
        if (busy || !onReset) return;
        if (!await confirmDialog(confirmMsg)) return;
        setBusy(true);
        try { await onReset(); } finally { setBusy(false); }
      }}
    >
      {busy ? 'Resetting…' : label}
    </button>
  );
}

function SemBtn({ color, label, onClick, disabled }: { color: string; label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      className="btn !h-7 !px-1.5 mono text-[11px] justify-center gap-1.5"
      disabled={disabled}
      onClick={onClick}
    >
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' }} />
      {label}
    </button>
  );
}

function CameraIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="9" r="2.5"/><path d="M3 5h2l1-1.5h4L11 5h2v7H3z"/></svg>;
}
function EditIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l7-7 2 2-7 7H3z"/><path d="M9 5l2 2"/></svg>;
}
function RulerIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="12" height="6" rx="1" transform="rotate(-45 8 8)"/><path d="M6 6l1 1M8 4l1 1M10 6l1 1"/></svg>;
}
function TreeIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M8 2 L11 7 H5 Z"/><path d="M6.5 7 L10 11 H6 Z"/><path d="M8 11 v3"/></svg>;
}
function LeafIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M13 3c-5 0-9 2-9 7 0 1 0 2 1 3 4-1 8-5 8-10Z"/><path d="M4 13 C6 10 9 7 12 5"/></svg>;
}
function DeadwoodIcon() {
  // A bare snag — upright leafless stem with stubbed branches.
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M8 14V3"/><path d="M8 6l3-2.5"/><path d="M8 9L5 6.5"/><path d="M8 5L6 4"/></svg>;
}
function StandingDeadIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M8 14V2"/><path d="M8 6l3-2"/><path d="M8 9L5 7"/></svg>;
}
function LayingDeadIcon() {
  // A felled log lying on the ground.
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d="M2 10h12"/><path d="M5 10l-2-3"/><path d="M9 10l2.5-2.5"/></svg>;
}
function LassoIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 6c0-2 2-3 5-3s5 1 5 3-2 3-5 3c-1 0-2 0-2 1s1 2 1 2" strokeLinecap="round"/></svg>;
}
function RectIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><rect x="3" y="4" width="10" height="8" rx="1" strokeDasharray="2 1.5"/></svg>;
}
function PolyIcon() {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 6l4-3 6 2-1 6-7 1z" strokeLinejoin="round"/></svg>;
}
