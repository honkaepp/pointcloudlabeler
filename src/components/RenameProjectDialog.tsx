// Rename Project…: one name for the project and its folder.
//
// Opened from the project's name in the module strip, Project → Rename
// Project… and a recent project on the welcome screen. The dialog is
// controlled by App, which runs the rename (src-tauri/src/commands/
// project_rename.rs): the open project closes for it and opens again under
// the new name, so App keeps the draft, the busy flag and the error while
// the screen behind changes.

import { useEffect } from 'react';
import { folderName, projectNameProblem, siblingFolder } from '../persistence/projectName';
import { getEditorSession } from '../state/editorSession';
import { getJobs } from '../state/jobs';

export interface RenameDraft {
  /** The project's folder as it is now. */
  folder: string;
  /** Its name as shown now. */
  current: string;
  /** The new name being typed. */
  draft: string;
  /** The project is the open one: it closes and opens again. */
  open: boolean;
  busy: boolean;
  error: string | null;
}

/** Why the open project cannot be renamed right now, or null. Renaming
 *  closes it, and Windows renames no folder a job is writing into. */
export function renameBlocker(): string | null {
  if (getEditorSession().dirty) return 'The open cloud has unsaved edits. Save them first, then rename the project.';
  const running = getJobs().map((j) => j.label).filter((s): s is string => !!s);
  if (running.length > 0) return `Wait for ${running[0]} to finish (or stop it), then rename the project: it writes into the project’s folder.`;
  return null;
}

interface Props {
  rename: RenameDraft;
  onDraft: (draft: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export default function RenameProjectDialog({ rename, onDraft, onSubmit, onClose }: Props) {
  const { folder, current, draft, open, busy, error } = rename;
  const problem = draft.trim() ? projectNameProblem(draft) : null;
  const unchanged = draft.trim() === folderName(folder) && draft.trim() === current;
  const canRename = !!draft.trim() && !problem && !unchanged && !busy;
  const target = siblingFolder(folder, draft.trim() || '…');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); }
      else if (e.key === 'Enter' && canRename) { e.preventDefault(); onSubmit(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, canRename, onClose, onSubmit]);

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center pointer-events-auto"
      style={{ background: 'rgba(6,10,8,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
      role="dialog" aria-label="Rename project">
      <div className="panel rounded-xl overflow-hidden" style={{ width: 520, maxWidth: '94vw' }}>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>Rename project</div>
            <div className="mono text-[10.5px] truncate" style={{ color: 'var(--text-mute)' }} title={folder}>{current}</div>
          </div>
          <button className="btn btn-ghost !h-7 !w-7 !p-0 justify-center" onClick={onClose} disabled={busy} title="Close (Esc)">✕</button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3">
          <div>
            <div className="chip mb-1.5" style={{ margin: 0 }}>New name</div>
            <input
              autoFocus
              aria-label="New project name"
              className="w-full px-2.5 py-2 mono text-[12.5px] rounded-md outline-none"
              style={{ background: 'rgba(0,0,0,0.3)', border: `1px solid ${problem ? 'rgba(240,138,126,0.7)' : 'var(--line)'}`, color: 'var(--text)' }}
              value={draft}
              disabled={busy}
              onChange={(e) => onDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
            />
            {problem && <div className="mono text-[10.5px] mt-1.5" style={{ color: 'var(--danger, #e0506b)' }}>{problem}</div>}
          </div>

          <div className="mono text-[10.5px] px-2.5 py-1.5 rounded-md truncate" title={target}
            style={{ background: 'color-mix(in oklch, var(--accent) 8%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 30%, transparent)', color: 'var(--text-dim)' }}>
            {target}
          </div>
          <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
            The project’s folder is renamed on disk with it. Saved views, layers and the paths kept inside the project follow.
            {open && ' The project closes for a moment and opens again under its new name; the editor opens the cloud it had open.'}
          </div>

          {error && (
            <div className="mono text-[11px] px-2.5 py-2 rounded-md" role="alert"
              style={{ color: 'var(--danger, #e0506b)', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 50%, transparent)' }}>
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3.5" style={{ borderTop: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            <span className="kbd">↵</span> rename · <span className="kbd">Esc</span> cancel
          </span>
          <div className="flex gap-1.5">
            <button className="btn !px-3" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary !px-3" onClick={onSubmit} disabled={!canRename}>
              {busy ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
