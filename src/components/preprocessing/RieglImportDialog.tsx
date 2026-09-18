// Pick a Riegl project directory and import its metadata. Either
// flavour: a RiSCAN PRO / RiPROCESS `.RiSCAN` / `.RiPROJECT`, or the
// `.PROJ` a scanner writes to its own storage. The Rust side reads the
// project metadata and the scan-position poses — not the point bytes,
// which stream on demand at export — and writes a small manifest into
// <projectFolder>/preprocessing/riegl/<safeName>/manifest.json so the
// list survives a PointCloudLabeler reload.

import { useEffect, useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import { browseForFolder } from '../../persistence/projectStore';

interface Props {
  onClose: () => void;
  onImported: () => void | Promise<void>;
  onStatus: (s: { kind: 'ok' | 'err' | 'info'; msg: string } | null) => void;
}

export default function RieglImportDialog({ onClose, onImported, onStatus }: Props) {
  const { project } = useProject();
  const [sourcePath, setSourcePath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canImport = !busy && !!sourcePath.trim() && !!project?.folder;

  const browse = async () => {
    // Reuses the project-browser dialog; Riegl projects ARE folders, not files.
    const folder = await browseForFolder('open');
    if (!folder) return;
    setSourcePath(folder);
    // Default the display name to the folder basename minus the
    // project suffix, whichever of the three it is.
    if (!name.trim()) {
      const base = folder.split(/[\\/]/).pop() ?? '';
      setName(base.replace(/\.(riscan|riproject|proj)$/i, ''));
    }
  };

  const run = async () => {
    if (!project?.folder) return;
    setBusy(true); setErr(null);
    try {
      const api = (window as unknown as Record<string, unknown>).desktop as {
        rieglImportProject?: (args: { projectFolder: string; sourcePath: string; name: string }) => Promise<{ id: string }>;
      } | undefined;
      if (!api?.rieglImportProject) throw new Error('Riegl import needs the desktop build (riegl_import_project command missing).');
      const res = await api.rieglImportProject({
        projectFolder: project.folder,
        sourcePath: sourcePath.trim(),
        name: name.trim() || 'Riegl project',
      });
      onStatus({ kind: 'ok', msg: `Imported Riegl project "${name.trim() || res.id}".` });
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
      aria-label="Import Riegl project"
    >
      <div className="panel rounded-xl overflow-hidden" style={{ width: 560, maxWidth: '94vw' }}>
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--line)', background: 'var(--wash-1)' }}>
          <div className="rounded-md flex items-center justify-center" style={{ width: 30, height: 30, background: 'color-mix(in oklch, var(--accent) 18%, transparent)', border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)' }}>
            <RiIcon />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>Import Riegl project</div>
            <div className="mono text-[10.5px] truncate" style={{ color: 'var(--text-mute)' }}>
              .RiSCAN / .RiPROJECT (RiSCAN PRO, RiPROCESS) or .PROJ (scanner)
            </div>
          </div>
          <button className="btn btn-ghost !h-7 !w-7 !p-0 justify-center" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-4">
          <Field label="Project folder">
            <div className="flex gap-1.5">
              <input
                className="flex-1 px-2.5 py-2 mono text-[12px] rounded-md outline-none min-w-0"
                style={inputStyle}
                placeholder="…/MyPlot.RiSCAN"
                value={sourcePath}
                onChange={(e) => setSourcePath(e.target.value)}
                onFocus={focusOn}
                onBlur={focusOff}
                spellCheck={false}
              />
              <button className="btn !px-3 mono text-[11.5px]" onClick={browse}>Browse…</button>
            </div>
            <div className="mono text-[10px] mt-1.5" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              The folder itself (it's a directory, not a single file). PointCloudLabeler reads the project metadata + scan-position poses and caches a manifest — the original Riegl files stay where they are. The points themselves — .rdbx (RDB 2) and .rxp — are RIEGL's own formats, readable only through RIEGL's rdblib / RiVLib, which a distributable build cannot link: to get them into PointCloudLabeler, export from RiSCAN PRO as E57 or LAS/LAZ and import that.
            </div>
          </Field>

          <Field label="Display name" optional>
            <input
              className="w-full px-2.5 py-2 mono text-[12px] rounded-md outline-none"
              style={inputStyle}
              placeholder="(defaults to the folder basename)"
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

function RiIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </svg>
  );
}
