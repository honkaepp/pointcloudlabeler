import { useEffect, useState } from 'react';
import type { RecentProject } from '../persistence/projectStore';
import { browseForFolder, listRecent, removeRecent } from '../persistence/projectStore';
import { formatAgo } from '../utils/format';
import { PointCloudLabelerLogoMark, PointCloudLabelerWordmark } from './PointCloudLabelerLogo';
import { OPENABLE_SUMMARY, pickData } from '../io/dataOpen';

interface Props {
  onNew: () => void;
  onOpen: () => void;
  onOpenRecent: (folder: string) => Promise<void> | void;
  refreshTick?: number;
  /** Rename Project… for a recent project. */
  onRename?: (r: RecentProject) => void;
}

// Data first. Opening (or dropping) a point cloud, a folder of tiles or a
// .zip of clouds makes the project for it on the way
// (components/DataDoor.tsx), so starting from the data is one step; New
// project / Open project and the recent projects are there as before.
export default function WelcomeScreen({ onNew, onOpen, onOpenRecent, refreshTick, onRename }: Props) {
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

  // A project moved somewhere else — opened from where it is now,
  // its old entry goes (commands/project_rename.rs).
  const locate = async () => {
    const folder = await browseForFolder('open');
    if (folder) await tryOpen(folder);
  };

  return (
    <div className="absolute inset-0 flex items-center justify-center overflow-y-auto py-8"
      style={{
        background: `
          radial-gradient(ellipse at 30% 20%, rgba(126,224,168,0.07), transparent 60%),
          radial-gradient(ellipse at 70% 100%, rgba(60,130,90,0.06), transparent 65%),
          #0a110d
        `,
      }}>
      <div className="panel rounded-md p-7" style={{ width: 680, maxWidth: '92vw' }}>
        <div className="flex items-center gap-4 mb-5">
          <div
            className="rounded-md flex items-center justify-center shrink-0"
            style={{
              width: 64, height: 64,
              background: 'radial-gradient(circle at 30% 28%, rgba(126,224,168,0.18), rgba(126,224,168,0.02) 72%)',
              border: '1px solid rgba(126,224,168,0.30)',
              boxShadow: '0 14px 36px -16px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.04) inset',
            }}
          >
            <PointCloudLabelerLogoMark size={46} />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <PointCloudLabelerWordmark size={22} />
              <span className="chip" style={{ color: 'var(--text-mute)' }}>
                Scanner data &middot; Tree segmentation &middot; Forest inventory
              </span>
            </div>
            <div className="mono text-[11px]" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
              From any point cloud to edited trees and plots.
            </div>
          </div>
        </div>

        {/* Open data: the drop zone (a drop works anywhere in the window). */}
        <div className="rounded-lg p-4 mb-4 flex flex-col gap-3"
          style={{ border: '1.5px dashed color-mix(in oklch, var(--accent) 45%, transparent)', background: 'color-mix(in oklch, var(--accent) 5%, transparent)' }}>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex-1 min-w-[220px]">
              <div className="text-[15px]" style={{ color: 'var(--text)' }}>Open data</div>
              <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
                Drop it here, or choose it. A project is made for it, named after the data.
              </div>
            </div>
            <button className="btn btn-primary !h-10 !px-4 justify-center" onClick={() => void pickData('file')} title="A point cloud, a .zip of clouds or a PTX">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
              File…
            </button>
            <button className="btn !h-10 !px-4 justify-center" onClick={() => void pickData('folder')} title="A folder of point clouds, or a PointCloudLabeler project">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-8l-2-2H4a1 1 0 0 0-1 1z" />
              </svg>
              Folder…
            </button>
          </div>
          <div className="grid gap-x-4 gap-y-0.5" style={{ gridTemplateColumns: 'max-content 1fr' }}>
            {OPENABLE_SUMMARY.map(([k, v]) => (
              <div key={k} className="contents">
                <span className="mono text-[10.5px]" style={{ color: 'var(--text-dim)' }}>{k}</span>
                <span className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 mb-5">
          <button className="btn !h-10 justify-center" onClick={onNew} title="An empty project: a folder for clouds, octrees, edits and plots">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New empty project
          </button>
          <button className="btn !h-10 justify-center" onClick={onOpen}>
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
            No recent projects yet. Open some data above, or make an empty project.
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
                  disabled={busy || !r.exists}
                  title={r.exists ? r.folder : `${r.folder} — not found (moved or on a drive that is not connected)`}
                  className="flex flex-col min-w-0 flex-1 text-left"
                  style={{ background: 'transparent', border: 'none', cursor: busy ? 'wait' : r.exists ? 'pointer' : 'default', padding: 0 }}
                >
                  <div className="mono text-[12.5px] truncate" style={{ color: r.exists ? 'var(--text)' : 'var(--text-dim)' }}>{r.name}</div>
                  <div className="mono text-[10.5px] truncate" style={{ color: 'var(--text-mute)' }}>{r.folder}</div>
                </button>
                <div className="mono text-[10.5px] ml-3 shrink-0 flex items-center gap-2" style={{ color: 'var(--text-dim)' }}>
                  <span>{r.exists ? (r.updatedAt ? formatAgo(r.updatedAt) : '') : 'missing'}</span>
                  {/* Rename it, or find where it went */}
                  {r.exists && onRename && (
                    <button
                      className="btn btn-ghost !h-6 !px-1.5"
                      onClick={(e) => { e.stopPropagation(); onRename(r); }}
                      disabled={busy}
                      title="Rename project… (its folder too)"
                      aria-label={`Rename ${r.name}`}
                    >
                      ✎
                    </button>
                  )}
                  {!r.exists && (
                    <button
                      className="btn btn-ghost !h-6 !px-1.5"
                      onClick={(e) => { e.stopPropagation(); void locate(); }}
                      disabled={busy}
                      title="The folder was moved or renamed: find it, and the list follows"
                    >
                      Locate…
                    </button>
                  )}
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
        <div className="mono text-[10px] mt-4" style={{ color: 'var(--text-mute)', lineHeight: 1.55 }}>
          A project is a folder: the clouds as streaming octrees, your edits, a SQLite database of trees, plots and forest metrics, and the project’s settings.
        </div>
      </div>
    </div>
  );
}
