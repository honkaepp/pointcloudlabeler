import { useEffect, useState } from 'react';
import type { RecentProject } from '../persistence/projectStore';
import { listRecent, removeRecent } from '../persistence/projectStore';
import { formatAgo } from '../utils/format';
import { PointCloudLabelerLogoMark, PointCloudLabelerWordmark } from './PointCloudLabelerLogo';

interface Props {
  onNew: () => void;
  onOpen: () => void;
  onOpenRecent: (folder: string) => Promise<void> | void;
  refreshTick?: number;
}

export default function WelcomeScreen({ onNew, onOpen, onOpenRecent, refreshTick }: Props) {
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => { listRecent().then(setRecent).catch(() => setRecent([])); };
  useEffect(() => { refresh(); }, [refreshTick]);

  const tryOpen = async (folder: string) => {
    setErr(null); setBusy(true);
    try {
      await onOpenRecent(folder);
    } catch (e) {
      setErr((e as Error).message || 'Could not open project');
    } finally { setBusy(false); }
  };

  const forget = async (folder: string) => {
    await removeRecent(folder);
    refresh();
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center"
      style={{
        background: `
          radial-gradient(ellipse at 30% 20%, rgba(126,224,168,0.07), transparent 60%),
          radial-gradient(ellipse at 70% 100%, rgba(60,130,90,0.06), transparent 65%),
          #0a110d
        `,
      }}>
      <div className="panel rounded-md p-7" style={{ width: 640, maxWidth: '92vw' }}>
        <div className="flex items-start gap-4 mb-5">
          <div
            className="rounded-md flex items-center justify-center shrink-0"
            style={{
              width: 72, height: 72,
              background: 'radial-gradient(circle at 30% 28%, rgba(126,224,168,0.18), rgba(126,224,168,0.02) 72%)',
              border: '1px solid rgba(126,224,168,0.30)',
              boxShadow: '0 14px 36px -16px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.04) inset',
            }}
          >
            <PointCloudLabelerLogoMark size={52} />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-1">
              <PointCloudLabelerWordmark size={22} />
              <span className="chip" style={{ color: 'var(--text-mute)' }}>
                Tree segmentation &middot; Forest inventory
              </span>
            </div>
            <div className="mono text-[20px]" style={{ color: 'var(--text)' }}>Start a project</div>
            <div className="mono text-[11px]" style={{ color: 'var(--text-mute)', marginTop: 4 }}>
              Every point cloud lives inside a project. A project folder holds the cloud
              binaries, a SQLite database of trees / plots / forest metrics, and the project's
              coordinate system + settings.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-5">
          <button className="btn btn-primary !h-12 justify-center" onClick={onNew}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New project
          </button>
          <button className="btn !h-12 justify-center" onClick={onOpen}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1z" />
            </svg>
            Open project
          </button>
        </div>

        <div className="hairline-b mb-3" />
        <div className="chip mb-2">RECENT · PROJECTS</div>
        {recent.length === 0 ? (
          <div className="mono text-[11.5px]" style={{ color: 'var(--text-mute)' }}>
            No recent projects. Use <span style={{ color: 'var(--text)' }}>New project</span> to create one.
          </div>
        ) : (
          <div className="rounded-sm overflow-hidden" style={{ border: '1px solid var(--line)' }}>
            {recent.map((r, i) => (
              <div
                key={r.folder}
                className="w-full flex items-center justify-between px-3 py-2"
                style={{
                  background: i % 2 === 0 ? 'var(--wash-1)' : 'transparent',
                  borderTop: i > 0 ? '1px solid var(--line)' : 'none',
                }}
              >
                <button
                  onClick={() => tryOpen(r.folder)}
                  disabled={busy}
                  title={r.folder}
                  className="flex flex-col min-w-0 flex-1 text-left"
                  style={{ background: 'transparent', border: 'none', cursor: busy ? 'wait' : 'pointer', padding: 0 }}
                >
                  <div className="mono text-[12.5px] truncate" style={{ color: r.exists ? 'var(--text)' : 'var(--text-dim)' }}>{r.name}</div>
                  <div className="mono text-[10.5px] truncate" style={{ color: 'var(--text-mute)' }}>{r.folder}</div>
                </button>
                <div className="mono text-[10.5px] ml-3 shrink-0 flex items-center gap-2" style={{ color: 'var(--text-dim)' }}>
                  <span>{r.exists ? (r.updatedAt ? formatAgo(r.updatedAt) : '') : 'missing'}</span>
                  <button
                    className="btn btn-ghost !h-6 !px-1.5"
                    onClick={(e) => { e.stopPropagation(); forget(r.folder); }}
                    title="Remove from recent list"
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {err && (
          <div className="mono text-[11.5px] mt-3 px-2 py-1.5 rounded-sm" style={{ color: 'var(--danger)', border: '1px solid var(--danger)' }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
