// PTX / PTS project panel — list / import Leica Cyclone ASCII files,
// browse their scan sections, and export a cropped + merged LAS / LAZ.
//
// Each registered file gets a folder under
//   <projectFolder>/preprocessing/ptx/<safeName>/
// holding a manifest.json (file path, per-section name + pose + point
// count + byte offset for fast seek-to-block on export).

import { useState } from 'react';
import PtxImportDialog from './PtxImportDialog';
import PtxScanList from './PtxScanList';

export interface PtxScanPosition {
  id: string;
  name: string;
  pointCount: number;
  /** 4×4 pose (scan local → world), row-major. Identity for PTS. */
  pose: number[];
  hasIntensity: boolean;
  hasColor: boolean;
  /** File byte offset where this section's first point line starts. */
  pointByteOffset: number;
  /** Detected per-point columns (3, 4, 6 or 7). */
  columnsPerPoint: number;
}

export interface PtxProjectSummary {
  id: string;
  sourcePath: string;
  name: string;
  /** "ptx" or "pts" — set by the Rust side from the file extension. */
  kind: string;
  scanPositions: PtxScanPosition[];
  updatedAt: number;
}

interface Props {
  projects: PtxProjectSummary[];
  onChange: () => void | Promise<void>;
  onStatus: (s: { kind: 'ok' | 'err' | 'info'; msg: string } | null) => void;
}

export default function PtxProjectPanel({ projects, onChange, onStatus }: Props) {
  const [importOpen, setImportOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const selected = projects.find(p => p.id === selectedId) ?? null;

  return (
    <>
      <div className="rounded-md" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px]" style={{ color: 'var(--text)' }}>PTX / PTS files</div>
            <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
              Leica Cyclone ASCII — also Topcon MAGNET Collage, 3D Forest exports, NavVis IndoorViewer.
            </div>
          </div>
          <button
            className="btn btn-primary !h-8 !px-3 mono text-[11.5px]"
            onClick={() => setImportOpen(true)}
            title="Pick a .ptx or .pts file on disk"
          >+ Import PTX / PTS</button>
        </div>

        {projects.length === 0 ? (
          <div className="p-6 text-center">
            <div className="mono text-[12px]" style={{ color: 'var(--text-dim)', marginBottom: 4 }}>
              No PTX / PTS files yet.
            </div>
            <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              Import a <span style={{ color: 'var(--text-dim)' }}>.ptx</span> or <span style={{ color: 'var(--text-dim)' }}>.pts</span> file to list its scan sections. Then crop a region and export to the Editor as a single LAS / LAZ.
            </div>
          </div>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: '260px 1fr', minHeight: 360 }}>
            <div className="overflow-y-auto scroll-thin" style={{ borderRight: '1px solid var(--line)' }}>
              {projects.map(p => {
                const active = p.id === selectedId;
                return (
                  <button
                    key={p.id}
                    onClick={() => setSelectedId(p.id)}
                    className="w-full text-left px-3 py-2.5 transition-all"
                    style={{
                      borderBottom: '1px solid var(--line)',
                      background: active ? 'color-mix(in oklch, var(--accent) 10%, transparent)' : 'transparent',
                      borderLeft: `3px solid ${active ? 'var(--accent)' : 'transparent'}`,
                    }}
                  >
                    <div className="mono text-[11.5px] truncate" style={{ color: active ? 'var(--text)' : 'var(--text-dim)' }}>{p.name}</div>
                    <div className="mono text-[9.5px] truncate" style={{ color: 'var(--text-mute)' }}>
                      {p.scanPositions.length} section{p.scanPositions.length === 1 ? '' : 's'} · {p.kind.toUpperCase()}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="overflow-y-auto scroll-thin">
              {selected ? (
                <PtxScanList
                  project={selected}
                  onChange={onChange}
                  onStatus={onStatus}
                />
              ) : (
                <div className="p-6 mono text-[11px]" style={{ color: 'var(--text-mute)' }}>
                  Pick a file on the left.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {importOpen && (
        <PtxImportDialog
          onClose={() => setImportOpen(false)}
          onImported={async () => { setImportOpen(false); await onChange(); }}
          onStatus={onStatus}
        />
      )}
    </>
  );
}
