// Landing view — shown in the viewport area when no dataset is open.
// A calm, centred hero with the two primary actions (import / open
// recent) so a fresh project isn't a blank void. Recent datasets are
// the project's saved octrees; clicking one opens it straight into the
// editor.

import type { OctreeListEntry } from '../../persistence/octreeReader';

interface Props {
  list: OctreeListEntry[];
  onImport: () => void;
  onOpen: (entry: OctreeListEntry) => void;
}

export default function LandingView({ list, onImport, onOpen }: Props) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex flex-col items-center" style={{ width: 560, maxWidth: '90%' }}>
        {/* Hero mark */}
        <div
          className="rounded-2xl mb-5 flex items-center justify-center"
          style={{
            width: 64, height: 64,
            background: 'color-mix(in oklch, var(--accent) 14%, transparent)',
            border: '1px solid color-mix(in oklch, var(--accent) 40%, transparent)',
            boxShadow: '0 0 48px -12px var(--accent-dim)',
          }}
        >
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v6M12 22v-6M5 12H2M22 12h-3" />
            <circle cx="12" cy="12" r="3.5" />
            <path d="M6 6l2 2M18 6l-2 2M6 18l2-2M18 18l-2-2" />
          </svg>
        </div>

        <h1 className="text-[22px] font-semibold mb-1.5" style={{ color: 'var(--text)' }}>
          PointCloudLabeler point cloud editor
        </h1>
        <p className="text-[13px] mb-7 text-center" style={{ color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Out-of-core segmentation + labelling for TLS / MLS / ULS / ALS clouds.<br />
          Import a LAS / LAZ to build a streaming octree and start editing.
        </p>

        <div className="flex gap-2.5 mb-8">
          <button className="btn btn-primary !h-10 !px-5 gap-2 text-[13px]" onClick={onImport}>
            <PlusIcon /> Import LAS / LAZ
          </button>
          <button
            className="btn !h-10 !px-4 gap-2 text-[13px]"
            onClick={() => { /* opens command palette via parent hint */ }}
            disabled
            style={{ display: 'none' }}
          >
            Command palette
          </button>
        </div>

        {list.length > 0 && (
          <div className="w-full">
            <div className="chip mb-2 text-center">Recent datasets</div>
            <div className="grid grid-cols-2 gap-2">
              {list.slice(0, 6).map(e => (
                <button
                  key={e.dir}
                  onClick={() => onOpen(e)}
                  className="flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-all panel"
                  style={{ boxShadow: 'none', border: '1px solid var(--line)' }}
                  onMouseEnter={(ev) => { ev.currentTarget.style.borderColor = 'color-mix(in oklch, var(--accent) 40%, transparent)'; }}
                  onMouseLeave={(ev) => { ev.currentTarget.style.borderColor = 'var(--line)'; }}
                >
                  <span className="rounded-sm shrink-0" style={{ width: 9, height: 9, background: 'var(--accent)' }} />
                  <div className="min-w-0">
                    <div className="mono text-[11.5px] truncate" style={{ color: 'var(--text)' }}>{e.name}</div>
                    <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
                      {formatPoints(e.pointCount)} pts · {e.scannerType}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mono text-[10px] mt-7 flex items-center gap-1.5" style={{ color: 'var(--text-mute)' }}>
          Press <span className="kbd">⌘K</span> for commands
        </div>
      </div>
    </div>
  );
}

function formatPoints(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function PlusIcon() {
  return <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M8 3v10M3 8h10"/></svg>;
}
