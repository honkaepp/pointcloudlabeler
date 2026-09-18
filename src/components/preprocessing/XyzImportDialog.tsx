// Pick an ASCII point-cloud file (.xyz, .csv, .txt, .pts, .asc) and
// register it. The Rust side sniffs the delimiter, decides if line 1
// is a header, counts columns, grabs a 10-line preview, estimates the
// point count, and saves a default column-to-role mapping (with a
// header-name match when present, otherwise the common X Y Z [I] [R G B]
// fallback).
//
// After import the user can re-shuffle the mapping in the project
// panel before exporting to LAS / LAZ.

import { useEffect, useState } from 'react';
import { useProject } from '../../context/ProjectContext';

interface Props {
  onClose: () => void;
  onImported: () => void | Promise<void>;
  onStatus: (s: { kind: 'ok' | 'err' | 'info'; msg: string } | null) => void;
}

export default function XyzImportDialog({ onClose, onImported, onStatus }: Props) {
  const { project } = useProject();
  const [sourcePath, setSourcePath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canImport = !busy && !!sourcePath.trim() && !!project?.folder;

  const browse = async () => {
    const api = (window as unknown as Record<string, unknown>).desktop as {
      openFileDialog?: (opts: { filters: { name: string; extensions: string[] }[] }) =>
        Promise<{ path: string; name: string; size: number } | null>;
    } | undefined;
    if (!api?.openFileDialog) {
      setErr('File picker not available (desktop build only).');
      return;
    }
    const res = await api.openFileDialog({
      filters: [
        { name: 'ASCII point cloud', extensions: ['xyz', 'csv', 'txt', 'asc', 'pts', 'tsv'] },
      ],
    });
    if (!res?.path) return;
    setSourcePath(res.path);
    if (!name.trim()) {
      const base = res.path.split(/[\\/]/).pop() ?? '';
      setName(base.replace(/\.(xyz|csv|txt|asc|pts|tsv)$/i, ''));
    }
  };

  const run = async () => {
    if (!project?.folder) return;
    setBusy(true); setErr(null);
    try {
      const api = (window as unknown as Record<string, unknown>).desktop as {
        xyzImportProject?: (args: { projectFolder: string; sourcePath: string; name: string }) => Promise<{ id: string }>;
      } | undefined;
      if (!api?.xyzImportProject) throw new Error('XYZ import needs the desktop build (xyz_import_project command missing).');
      const res = await api.xyzImportProject({
        projectFolder: project.folder,
        sourcePath: sourcePath.trim(),
        name: name.trim() || 'XYZ project',
      });
      onStatus({ kind: 'ok', msg: `Imported XYZ/CSV file "${name.trim() || res.id}". Set the column mapping in the panel before exporting.` });
      await onImported();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canImport) { e.preventDefault(); void run(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canImport, sourcePath, name]);

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center pointer-events-auto"
      style={{ background: 'rgba(6,10,8,0.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
      role="dialog"
      aria-label="Import ASCII point cloud"
    >
      <div className="panel rounded-xl overflow-hidden" style={{ width: 560, maxWidth: '94vw' }}>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="rounded-md flex items-center justify-center" style={{ width: 30, height: 30, background: 'color-mix(in oklch, var(--accent) 18%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)' }}>
            <XyzIcon />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>Import ASCII point cloud</div>
            <div className="mono text-[10.5px] truncate" style={{ color: 'var(--text-mute)' }}>
              .xyz / .csv / .txt / .asc / .pts / .tsv — any column-separated text
            </div>
          </div>
          <button className="btn btn-ghost !h-7 !w-7 !p-0 justify-center" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          <Field label="File">
            <div className="flex gap-1.5">
              <input
                className="flex-1 px-2.5 py-2 mono text-[12px] rounded-md outline-none min-w-0"
                style={inputStyle}
                placeholder="…/scan.xyz"
                value={sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
                onFocus={focusOn}
                onBlur={focusOff}
                spellCheck={false}
              />
              <button className="btn !px-3 mono text-[11.5px]" onClick={browse}>Browse…</button>
            </div>
            <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              PointCloudLabeler sniffs the delimiter (space / tab / comma / semicolon) and column layout from the first 64 KB. Map columns to roles after import.
            </div>
          </Field>

          <Field label="Display name" optional>
            <input
              className="w-full px-2.5 py-2 mono text-[12px] rounded-md outline-none"
              style={inputStyle}
              placeholder="(defaults to the file basename)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={focusOn}
              onBlur={focusOff}
            />
          </Field>

          {err && (
            <div className="mono text-[11px] px-2.5 py-2 rounded-md"
                 style={{ color: '#ffb4be', background: 'rgba(224,80,107,0.10)', border: '1px solid color-mix(in oklch, var(--danger, #e0506b) 45%, transparent)' }}>
              {err}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3.5" style={{ borderTop: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>
            <span className="kbd">⌘</span><span className="kbd">↵</span> import · <span className="kbd">Esc</span> cancel
          </span>
          <div className="flex gap-1.5">
            <button className="btn !px-3" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary !px-3" onClick={run} disabled={!canImport}>
              {busy ? 'Sniffing…' : 'Import'}
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

function XyzIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M4 12h16M4 18h16" />
      <path d="M9 4v16M15 4v16" />
    </svg>
  );
}
