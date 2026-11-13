// New-project dialog. Restyled to match the editor shell — glassy modal,
// chip section headers, accent-lit inputs and a live "will create" path
// card. It gathers name + parent folder + coordinate system + notes and
// hands them to createProject().
//
// As little as a project needs. The name and the place come
// prefilled — from the data being opened (components/DataDoor.tsx), and the
// place where the last project was made — so Enter is usually all it takes.
// The coordinate system is optional and is the project's record of where its
// data lies; each dataset keeps its own. The default cloud format it used to ask was stored
// and read by nothing, and is gone.

import { useEffect, useMemo, useState } from 'react';
import { COORD_PRESETS, browseForFolder, createProject } from '../persistence/projectStore';
import { plainPath } from '../io/dataOpen';
import { projectNameProblem } from '../persistence/projectName';
import type { ProjectState } from '../persistence/projectStore';
import { formatChord } from '../state/keybindings';

interface Props {
  onClose: () => void;
  onCreated: (p: ProjectState) => void;
  /** Prefilled when the project is made for data being opened. */
  initialName?: string;
  initialParent?: string;
  /** What the project is for, under the title ("For Scans.zip — …"). */
  purpose?: string;
}

const LAST_PARENT_KEY = 'pointcloudlabeler-last-project-parent';
const LAST_CRS_KEY = 'pointcloudlabeler-last-project-crs';
/** The coordinate system choice: a preset's index, 'none', or 'custom'. */
type CrsChoice = number | 'none' | 'custom';

function remembered(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function remember(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

/** The last choice, else ETRS-TM35FIN with N2000 heights. */
function initialCrs(): { choice: CrsChoice; custom: string } {
  const v = remembered(LAST_CRS_KEY);
  if (v === 'none') return { choice: 'none', custom: '' };
  if (/^custom:\d+$/.test(v)) return { choice: 'custom', custom: v.slice(7) };
  const i = COORD_PRESETS.findIndex((p) => String(p.epsg) === v);
  return { choice: i >= 0 ? i : 0, custom: '' };
}

export default function NewProjectDialog({ onClose, onCreated, initialName, initialParent, purpose }: Props) {
  const [name, setName] = useState(initialName ?? '');
  const [parentFolder, setParentFolder] = useState(() => plainPath(initialParent ?? remembered(LAST_PARENT_KEY)));
  const [crs, setCrs] = useState(initialCrs);
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The name is the folder's name, by the rules Rename Project
  // uses — said here, not quietly changed into another name.
  const nameProblem = name.trim() ? projectNameProblem(name) : null;
  const safeName = nameProblem ? '' : name.trim();
  const sep = parentFolder.includes('\\') && !parentFolder.includes('/') ? '\\' : '/';
  const targetFolder = parentFolder && safeName
    ? `${parentFolder.replace(/[\\/]+$/, '')}${sep}${safeName}`
    : '';
  const customOk = crs.choice !== 'custom' || /^\d{4,6}$/.test(crs.custom.trim());
  const canCreate = !!name.trim() && !nameProblem && !!parentFolder && customOk && !busy;

  const crsLabel = useMemo(() => {
    if (crs.choice === 'none') return null;
    if (crs.choice === 'custom') return crs.custom.trim() ? `EPSG:${crs.custom.trim()}` : null;
    const p = COORD_PRESETS[crs.choice];
    return `EPSG:${p.epsg}${p.vertical ? ` + ${p.vertical}` : ''}`;
  }, [crs]);

  const pickParent = async () => {
    const folder = await browseForFolder('new');
    if (folder) setParentFolder(folder);
  };

  const submit = async () => {
    setErr(null);
    if (!name.trim()) { setErr('Give the project a name.'); return; }
    if (nameProblem) { setErr(nameProblem); return; }
    if (!parentFolder) { setErr('Choose where the project folder goes.'); return; }
    if (!customOk) { setErr('An EPSG code is a number, e.g. 25835.'); return; }
    setBusy(true);
    try {
      const coordinateSystem = crs.choice === 'none'
        ? { epsg: null, name: 'unknown' }
        : crs.choice === 'custom'
          ? { epsg: parseInt(crs.custom.trim(), 10), name: `EPSG:${crs.custom.trim()}` }
          : { epsg: COORD_PRESETS[crs.choice].epsg, name: COORD_PRESETS[crs.choice].name, vertical: COORD_PRESETS[crs.choice].vertical };
      const p = await createProject({
        folder: targetFolder,
        name: name.trim(),
        coordinateSystem,
        notes: notes.trim(),
      });
      if (!p) throw new Error('Could not create project');
      remember(LAST_PARENT_KEY, parentFolder);
      remember(LAST_CRS_KEY, crs.choice === 'none' ? 'none' : crs.choice === 'custom' ? `custom:${crs.custom.trim()}` : String(COORD_PRESETS[crs.choice].epsg));
      onCreated(p);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  // Esc closes; Enter creates (in the notes, Ctrl/⌘+Enter).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key !== 'Enter' || !canCreate) return;
      const inNotes = (e.target as HTMLElement | null)?.tagName === 'TEXTAREA';
      if (inNotes && !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      void submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreate, name, parentFolder, crs, notes]);

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center pointer-events-auto"
      style={{ background: 'rgba(6,10,8,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
      role="dialog"
      aria-label="New project"
    >
      <div className="panel rounded-xl overflow-hidden" style={{ width: 560, maxWidth: '94vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="rounded-md flex items-center justify-center" style={{ width: 30, height: 30, background: 'color-mix(in oklch, var(--accent) 18%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)' }}>
            <FolderPlus />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>New project</div>
            <div className="mono text-[10.5px] truncate" style={{ color: 'var(--text-mute)' }} title={purpose}>{purpose ?? 'A project holds your clouds, octrees, edits + plots in one folder.'}</div>
          </div>
          <button className="btn btn-ghost !h-7 !w-7 !p-0 justify-center" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 flex flex-col gap-4 overflow-y-auto">
          <Field label="Name">
            <input
              autoFocus
              className="w-full px-2.5 py-2 mono text-[12.5px] rounded-md outline-none"
              style={inputStyle}
              placeholder="e.g. Suomenoja 2024"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => { focusOn(e); e.currentTarget.select(); }}
              onBlur={focusOff}
            />
            {nameProblem && (
              <div className="mono text-[10.5px] mt-1.5" style={{ color: 'var(--danger, #e0506b)' }}>{nameProblem}</div>
            )}
          </Field>

          <Field label="Location">
            <div className="flex gap-1.5">
              <input
                className="flex-1 px-2.5 py-2 mono text-[12px] rounded-md outline-none min-w-0"
                style={inputStyle}
                placeholder="The folder the project folder is made in"
                value={parentFolder}
                onChange={(e) => setParentFolder(e.target.value)}
                onFocus={focusOn}
                onBlur={focusOff}
              />
              <button className="btn !px-3 mono text-[11.5px]" onClick={pickParent}>Browse…</button>
            </div>
            {targetFolder && (
              <div className="flex items-center gap-2 mt-2 px-2.5 py-1.5 rounded-md mono text-[10.5px]"
                style={{ background: 'color-mix(in oklch, var(--accent) 8%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 30%, transparent)', color: 'var(--text-dim)' }}>
                <FolderIcon />
                <span className="truncate" title={targetFolder}>{targetFolder}</span>
              </div>
            )}
          </Field>

          <Field label="Coordinate system" optional>
            <div className="flex gap-1.5">
              <select
                className="flex-1 min-w-0 px-2.5 py-2 mono text-[12px] rounded-md outline-none"
                style={inputStyle}
                value={String(crs.choice)}
                onChange={(e) => {
                  const v = e.target.value;
                  setCrs((c) => ({ ...c, choice: v === 'none' || v === 'custom' ? v : parseInt(v, 10) }));
                }}
                onFocus={focusOn}
                onBlur={focusOff}
              >
                {COORD_PRESETS.map((p, i) => (
                  <option key={p.epsg} value={i}>EPSG:{p.epsg} — {p.name}{p.vertical ? ` (${p.vertical})` : ''}</option>
                ))}
                <option value="custom">Other EPSG code…</option>
                <option value="none">Not set — each dataset keeps its own</option>
              </select>
              {crs.choice === 'custom' && (
                <input
                  className="px-2.5 py-2 mono text-[12px] rounded-md outline-none"
                  style={{ ...inputStyle, width: 110, borderColor: customOk ? 'var(--line)' : 'rgba(240,138,126,0.7)' }}
                  placeholder="e.g. 25835"
                  value={crs.custom}
                  onChange={(e) => setCrs((c) => ({ ...c, custom: e.target.value.replace(/[^0-9]/g, '') }))}
                />
              )}
            </div>
            <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              {crsLabel
                ? <>The project is recorded in <span style={{ color: 'var(--accent)' }}>{crsLabel}</span>. Imported clouds keep their own.</>
                : 'No coordinate system recorded for the project. Imported clouds keep their own.'}
            </div>
          </Field>

          {showNotes ? (
            <Field label="Notes" optional>
              <textarea
                autoFocus
                className="w-full px-2.5 py-2 mono text-[12px] rounded-md outline-none"
                style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }}
                placeholder="Plot location, campaign year, sensor used…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                onFocus={focusOn}
                onBlur={focusOff}
              />
            </Field>
          ) : (
            <button className="mono text-[10.5px] text-left" onClick={() => setShowNotes(true)}
              style={{ color: 'var(--text-mute)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
              + Add notes
            </button>
          )}

          {err && (
            <div className="mono text-[11px] px-2.5 py-2 rounded-md" style={{ color: 'var(--danger, #e0506b)', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 50%, transparent)' }}>
              {err}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3.5" style={{ borderTop: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            <span className="kbd">↵</span> create · <span className="kbd">Esc</span> cancel{showNotes ? <> · in notes <span className="kbd">{formatChord('mod+Enter')}</span></> : null}
          </span>
          <div className="flex gap-1.5">
            <button className="btn !px-3" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary !px-3" onClick={submit} disabled={!canCreate}>
              {busy ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid var(--line)',
  color: 'var(--text)',
};
const focusOn = (e: React.FocusEvent<HTMLElement>) => {
  e.currentTarget.style.borderColor = 'color-mix(in oklch, var(--accent) 55%, transparent)';
};
const focusOff = (e: React.FocusEvent<HTMLElement>) => {
  e.currentTarget.style.borderColor = 'var(--line)';
};

function Field({ label, optional, children }: { label: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="chip" style={{ margin: 0 }}>{label}</span>
        {optional && <span className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>optional</span>}
      </div>
      {children}
    </div>
  );
}

function FolderPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
      <path d="M12 11v5M9.5 13.5h5" />
    </svg>
  );
}
function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}
