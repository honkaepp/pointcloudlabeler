// Pick a single .e57 file and register it with PointCloudLabeler.
// The Rust side parses the XML envelope (per-scan name, guid, point
// count, pose, bounds) and writes a manifest under
// <projectFolder>/preprocessing/e57/<safeName>/manifest.json so the
// list survives a PointCloudLabeler reload.
//
// Unlike Riegl, E57 is a SINGLE file (.e57), so this uses the file
// picker (not the folder picker).

import { useEffect, useState } from 'react';
import { useProject } from '../../context/ProjectContext';

interface Props {
  onClose: () => void;
  onImported: () => void | Promise<void>;
  onStatus: (s: { kind: 'ok' | 'err' | 'info'; msg: string } | null) => void;
}

export default function E57ImportDialog({ onClose, onImported, onStatus }: Props) {
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
      filters: [{ name: 'E57 point cloud', extensions: ['e57', 'E57'] }],
    });
    if (!res?.path) return;
    setSourcePath(res.path);
    if (!name.trim()) {
      const base = res.path.split(/[\\/]/).pop() ?? '';
      setName(base.replace(/\.e57$/i, ''));
    }
  };

  const run = async () => {
    if (!project?.folder) return;
    setBusy(true); setErr(null);
    try {
      const api = (window as unknown as Record<string, unknown>).desktop as {
        e57ImportProject?: (args: { projectFolder: string; sourcePath: string; name: string }) => Promise<{ id: string }>;
      } | undefined;
      if (!api?.e57ImportProject) throw new Error('E57 import needs the desktop build (e57_import_project command missing).');
      const res = await api.e57ImportProject({
        projectFolder: project.folder,
        sourcePath: sourcePath.trim(),
        name: name.trim() || 'E57 project',
      });
      onStatus({ kind: 'ok', msg: `Imported E57 file "${name.trim() || res.id}".` });
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
      aria-label="Import E57 file"
    >
      <div className="panel rounded-xl overflow-hidden" style={{ width: 560, maxWidth: '94vw' }}>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="rounded-md flex items-center justify-center" style={{ width: 30, height: 30, background: 'color-mix(in oklch, var(--accent) 18%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)' }}>
            <E57Icon />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>Import E57 file</div>
            <div className="mono text-[10.5px] truncate" style={{ color: 'var(--text-mute)' }}>
              ASTM E2807 — FARO, Leica, Trimble, NavVis, Emesent, XGRIDS, GreenValley exports
            </div>
          </div>
          <button className="btn btn-ghost !h-7 !w-7 !p-0 justify-center" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          <Field label="E57 file">
            <div className="flex gap-1.5">
              <input
                className="flex-1 px-2.5 py-2 mono text-[12px] rounded-md outline-none min-w-0"
                style={inputStyle}
                placeholder="…/scan.e57"
                value={sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
                onFocus={focusOn}
                onBlur={focusOff}
                spellCheck={false}
              />
              <button className="btn !px-3 mono text-[11.5px]" onClick={browse}>Browse…</button>
            </div>
            <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              A single .e57 file. PointCloudLabeler parses every scan position's name, point count + pose and caches a manifest — the original .e57 stays where it is.
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
              {busy ? 'Importing…' : 'Import'}
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

function E57Icon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="18" height="13" rx="1.5" />
      <path d="M3 10h18M8 13h2M12 13h4M8 16h8" />
    </svg>
  );
}
