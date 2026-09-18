// Bottom status strip — cursor world coords, point counts, selection,
// FPS. Designed to be glanceable and quiet: tabular numerals so digits
// don't shift width as they tick, muted text so it doesn't compete with
// the viewport. Cursor coords are pushed in by OctreeView via a ref
// that updates on every frame without re-rendering the React tree.

import { useEffect, useState } from 'react';
import { useOctreeShell, countActiveFilters } from './OctreeShellContext';

interface Props {
  /** A ref OctreeView writes the cursor world position into on every
   *  pointer move. We read it on a 5 Hz timer so the bar stays smooth
   *  without re-rendering the whole shell on every mouse move. */
  cursorRef: React.MutableRefObject<{ x: number; y: number; z: number } | null>;
}

const HEIGHT = 26;

export default function StatusBar({ cursorRef }: Props) {
  const { stats, selectedCount, octree, filters, togglePanel, visiblePanels, datasetBusy } = useOctreeShell();
  const [, setTick] = useState(0);
  const nFilters = countActiveFilters(filters);

  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 200);
    return () => window.clearInterval(id);
  }, []);

  const cursor = cursorRef.current;
  const fps = Math.round(stats.fps);

  return (
    <div
      className="flex items-center px-3 gap-4 mono text-[10.5px] tnum hairline-t shrink-0"
      style={{
        height: HEIGHT,
        background: 'rgba(8, 14, 11, 0.92)',
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        color: 'var(--text-mute)',
        zIndex: 30,
      }}
    >
      {/* Editing is blocked while a native command rewrites the dataset
          (see src/state/datasetBusy.ts). Saying so here is what turns a
          dead toolbar into an explained one — otherwise the user's clicks
          just stop working with no reason given. */}
      {datasetBusy && (
        <>
          <span
            className="mono text-[10.5px]"
            style={{ color: '#e0b84a' }}
            title="A native operation is rewriting this dataset. Editing is blocked until it finishes, because an edit made now would be discarded when the dataset reloads."
          >
            ● rewriting dataset — editing paused
          </span>
          <Sep />
        </>
      )}
      <Field label="cursor" value={cursor
        ? `${cursor.x.toFixed(2)}, ${cursor.y.toFixed(2)}, ${cursor.z.toFixed(2)}`
        : '—'}
      />
      <Sep />
      <Field label="visible" value={`${formatPoints(stats.visiblePoints)} / ${formatPoints(stats.loadedPoints)} pts`} />
      <Sep />
      <Field label="nodes" value={`${stats.visibleNodes} / ${stats.loadedNodes}${stats.pendingNodes > 0 ? ` (+${stats.pendingNodes})` : ''}`} />
      <Sep />
      <Field
        label="selection"
        value={selectedCount > 0 ? `${selectedCount.toLocaleString()} pts` : 'none'}
        accent={selectedCount > 0}
      />
      {nFilters > 0 && (
        <>
          <Sep />
          <button
            onClick={() => { if (!visiblePanels.has('filters')) togglePanel('filters'); }}
            className="flex items-center gap-1.5 rounded mono text-[10.5px] transition-all"
            style={{
              padding: '2px 6px',
              border: '1px solid color-mix(in oklch, var(--accent) 50%, transparent)',
              background: 'color-mix(in oklch, var(--accent) 14%, transparent)',
              color: 'var(--accent)',
            }}
            title="Visibility filters are active — click to open the Filters panel"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5h16l-6 8v6l-4-2v-4z" />
            </svg>
            <span>{nFilters} filter{nFilters > 1 ? 's' : ''}</span>
          </button>
        </>
      )}
      <div className="flex-1" />
      {octree && (
        <Field
          label="total"
          value={`${formatPoints(octree.meta.pointCount)} pts · ${octree.meta.tiles.length} tiles`}
        />
      )}
      <Sep />
      <Field label="fps" value={`${fps || '—'}`} />
    </div>
  );
}

function Field({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span style={{ color: 'var(--text-mute)', textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 9.5 }}>
        {label}
      </span>
      <span style={{ color: accent ? 'var(--accent)' : 'var(--text-dim)' }}>{value}</span>
    </div>
  );
}

function Sep() {
  return <div className="w-px h-3" style={{ background: 'var(--line)' }} />;
}

function formatPoints(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
