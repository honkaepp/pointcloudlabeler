// New-project dialog. Restyled to match the editor shell — glassy modal,
// chip section headers, accent-lit inputs, a segmented format picker and
// a live "will create" path card. The create logic is unchanged: it
// gathers name + parent folder + coordinate system + default cloud format
// + notes and hands them to createProject().

import { useEffect, useMemo, useState } from 'react';
import { COORD_PRESETS, browseForFolder, createProject } from '../persistence/projectStore';
import type { ProjectState } from '../persistence/projectStore';

interface Props {
  onClose: () => void;
  onCreated: (p: ProjectState) => void;
}

export default function NewProjectDialog({ onClose, onCreated }: Props) {
  const [name, setName] = useState('');
  const [parentFolder, setParentFolder] = useState('');
  const [crsIdx, setCrsIdx] = useState(0);
  const [customEpsg, setCustomEpsg] = useState('');
  const [defaultFormat, setDefaultFormat] = useState<'txt' | 'las'>('las');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const safeName = name.trim().replace(/[\\/:*?"<>|]+/g, '_');
  const targetFolder = parentFolder && safeName
    ? `${parentFolder.replace(/[\\/]+$/, '')}/${safeName}`
    : '';
  const canCreate = !!name.trim() && !!parentFolder && !busy;

  // Resolved CRS label — custom EPSG wins over the preset when typed.
  const crsLabel = useMemo(() => {
    const custom = customEpsg.trim();
    if (custom) return `EPSG:${custom}`;
    const p = COORD_PRESETS[crsIdx];
    return `EPSG:${p.epsg} · ${p.name}${p.vertical ? ` (${p.vertical})` : ''}`;
  }, [customEpsg, crsIdx]);

  const pickParent = async () => {
    const folder = await browseForFolder('new');
    if (folder) setParentFolder(folder);
  };

  const submit = async () => {
    setErr(null);
    if (!name.trim()) { setErr('Give the project a name.'); return; }
    if (!parentFolder) { setErr('Choose a parent folder.'); return; }
    setBusy(true);
    try {
      const preset = COORD_PRESETS[crsIdx];
      const custom = customEpsg.trim();
      const crs = custom
        ? { epsg: parseInt(custom, 10) || null, name: `EPSG:${custom}` }
        : { epsg: preset.epsg, name: preset.name, vertical: preset.vertical };
      const p = await createProject({
        folder: targetFolder,
        name: name.trim(),
        coordinateSystem: crs,
        defaultCloudFormat: defaultFormat,
        notes: notes.trim(),
      });
      if (!p) throw new Error('Could not create project');
      onCreated(p);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  };

  // Esc closes; ⌘/Ctrl+Enter creates (Enter alone is left to the textarea).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCreate) { e.preventDefault(); void submit(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreate, name, parentFolder, crsIdx, customEpsg, defaultFormat, notes]);

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center pointer-events-auto"
      style={{ background: 'rgba(6,10,8,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
      role="dialog"
      aria-label="New project"
    >
      <div className="panel rounded-xl overflow-hidden" style={{ width: 600, maxWidth: '94vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="rounded-md flex items-center justify-center" style={{ width: 30, height: 30, background: 'color-mix(in oklch, var(--accent) 18%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)' }}>
            <FolderPlus />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>New project</div>
            <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>A project holds your clouds, octrees, edits + plots in one folder.</div>
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
              onFocus={focusOn}
              onBlur={focusOff}
            />
          </Field>

          <Field label="Parent folder">
            <div className="flex gap-1.5">
              <input
                className="flex-1 px-2.5 py-2 mono text-[12px] rounded-md outline-none min-w-0"
                style={inputStyle}
                placeholder="Where the project folder is created"
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

          <Field label="Coordinate system">
            <select
              className="w-full px-2.5 py-2 mono text-[12px] rounded-md outline-none"
              style={inputStyle}
              value={crsIdx}
              onChange={(e) => { setCrsIdx(parseInt(e.target.value, 10)); setCustomEpsg(''); }}
              onFocus={focusOn}
              onBlur={focusOff}
            >
              {COORD_PRESETS.map((p, i) => (
                <option key={p.epsg} value={i}>EPSG:{p.epsg} — {p.name}{p.vertical ? ` (${p.vertical})` : ''}</option>
              ))}
            </select>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', width: 92 }}>or custom EPSG</span>
              <input
                className="flex-1 px-2.5 py-1.5 mono text-[11.5px] rounded-md outline-none min-w-0"
                style={inputStyle}
                placeholder="e.g. 25832"
                value={customEpsg}
                onChange={(e) => setCustomEpsg(e.target.value.replace(/[^0-9]/g, ''))}
                onFocus={focusOn}
                onBlur={focusOff}
              />
            </div>
            <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)' }}>Using <span style={{ color: 'var(--accent)' }}>{crsLabel}</span></div>
          </Field>

          <Field label="Default cloud format">
            <div className="flex gap-1 p-0.5 rounded-md" style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)' }}>
              {([
                { v: 'las', label: 'LAS / LAZ', sub: 'lidar' },
                { v: 'txt', label: 'TXT / XYZ / CSV', sub: 'text' },
              ] as const).map(o => {
                const active = defaultFormat === o.v;
                return (
                  <button
                    key={o.v}
                    onClick={() => setDefaultFormat(o.v)}
                    className="flex-1 flex items-center justify-center gap-1.5 rounded py-1.5 mono text-[11px] transition-all"
                    style={{
                      background: active ? 'color-mix(in oklch, var(--accent) 20%, transparent)' : 'transparent',
                      color: active ? 'var(--accent)' : 'var(--text-dim)',
                    }}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Notes" optional>
            <textarea
              className="w-full px-2.5 py-2 mono text-[12px] rounded-md outline-none"
              style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }}
              placeholder="Plot location, campaign year, sensor used…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onFocus={focusOn}
              onBlur={focusOff}
            />
          </Field>

          {err && (
            <div className="mono text-[11px] px-2.5 py-2 rounded-md" style={{ color: 'var(--danger, #e0506b)', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 50%, transparent)' }}>
              {err}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-5 py-3.5" style={{ borderTop: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            <span className="kbd">⌘</span><span className="kbd">↵</span> create · <span className="kbd">Esc</span> cancel
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
