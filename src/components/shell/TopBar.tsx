// Top bar — slim, glassy, holds the project / dataset name and the
// command-palette trigger. Window controls stay native (Tauri owns the
// chrome). The dataset name reads through to the open octree's metadata
// so the title always matches what's in the viewport.

import { useOctreeShell } from './OctreeShellContext';

interface Props {
  projectName: string | null;
  onCloseOctree?: () => void;
  /** True while a long-running op is in flight; the title bar grows a
   *  small spinner so the user knows a save / export is still running. */
  busy?: boolean;
}

const HEIGHT = 40;

export default function TopBar({ projectName, onCloseOctree, busy }: Props) {
  const { octree, setPaletteOpen, dirty, editMode, setEditMode } = useOctreeShell();
  const dsName = octree?.meta.name ?? null;
  const pts = octree?.meta.pointCount;

  return (
    <div
      className="flex items-center px-3 gap-3 hairline-b shrink-0"
      style={{
        height: HEIGHT,
        background: 'rgba(8, 14, 11, 0.92)',
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        zIndex: 30,
      }}
    >
      {/* Wordmark */}
      <div className="flex items-center gap-2 select-none">
        <div
          className="rounded-sm"
          style={{ width: 14, height: 14, background: 'var(--accent)', boxShadow: '0 0 12px var(--accent-dim)' }}
        />
        <div className="text-[13px] font-semibold tracking-wide" style={{ color: 'var(--text)' }}>
          PointCloudLabeler
        </div>
      </div>

      <div className="mx-1 w-px h-4" style={{ background: 'var(--line)' }} />

      {/* Project + dataset breadcrumb */}
      <div className="flex items-center gap-2 mono text-[11.5px] flex-1 min-w-0">
        {projectName && (
          <span style={{ color: 'var(--text-dim)' }} className="truncate">
            {projectName}
          </span>
        )}
        {dsName && projectName && (
          <span style={{ color: 'var(--text-mute)' }}>·</span>
        )}
        {dsName && (
          <span style={{ color: 'var(--text)' }} className="truncate">
            {dsName}
            {dirty && <span style={{ color: 'var(--warn)', marginLeft: 4 }}>•</span>}
          </span>
        )}
        {pts != null && (
          <span style={{ color: 'var(--text-mute)' }} className="ml-1">
            ({pts.toLocaleString()} pts)
          </span>
        )}
        {busy && (
          <span className="blink" style={{ color: 'var(--accent)', marginLeft: 6 }}>working…</span>
        )}
      </div>

      {/* Current mode — single source of truth for what a left-drag does. */}
      {octree && (
        <button
          onClick={() => setEditMode(!editMode)}
          className="flex items-center gap-1.5 rounded-md px-2 py-0.5 mono text-[10.5px]"
          title={`${editMode ? 'Edit' : 'Camera'} mode (Space)`}
          style={{
            border: '1px solid color-mix(in oklch, var(--accent) 45%, transparent)',
            background: editMode ? 'color-mix(in oklch, var(--accent) 18%, transparent)' : 'var(--wash-1)',
            color: editMode ? 'var(--accent)' : 'var(--text-dim)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 3, background: editMode ? 'var(--accent)' : 'var(--text-mute)' }} />
          {editMode ? 'Edit' : 'Camera'}
          <span className="kbd" style={{ marginLeft: 4 }}>Space</span>
        </button>
      )}

      {/* Command palette trigger — visual hint that ⌘K opens it. */}
      <button
        onClick={() => setPaletteOpen(true)}
        className="flex items-center gap-2 rounded-md px-2.5 py-1 hover:bg-white/5 transition-colors mono text-[11px]"
        style={{ border: '1px solid var(--line-strong)', color: 'var(--text-dim)' }}
        title="Command palette"
      >
        <SearchIcon />
        <span>Search…</span>
        <span className="kbd" style={{ marginLeft: 6 }}>⌘K</span>
      </button>

      {onCloseOctree && octree && (
        <button
          onClick={onCloseOctree}
          className="btn btn-ghost !h-6 !px-2 mono text-[11px]"
          title="Close this dataset and return to the start view"
        >
          ✕ Close
        </button>
      )}
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-3-3" />
    </svg>
  );
}
