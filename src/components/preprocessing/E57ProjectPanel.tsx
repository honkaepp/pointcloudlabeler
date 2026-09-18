// E57 project panel — list / import .e57 files, browse their scan
// positions, and export a cropped + merged LAS for the Editor module
// to open.
//
// Each registered E57 gets a folder under
//   <projectFolder>/preprocessing/e57/<safeName>/
// holding a manifest.json (file path, per-scan name + guid + pose +
// point count) so re-opening the PointCloudLabeler project re-lists the imports
// without re-parsing the .e57.

import { useState } from 'react';
import E57ImportDialog from './E57ImportDialog';
import E57ScanList from './E57ScanList';

export interface E57ScanPosition {
  id: string;
  name: string;
  guid: string | null;
  pointCount: number;
  /** 4×4 pose (scan local → world), row-major. Identity when missing. */
  pose: number[];
  /** Local-frame bbox if the writer recorded CartesianBounds. */
  localBounds: [number, number, number, number, number, number] | null;
  /** Scan centroid in world coords. */
  worldCentre: [number, number, number] | null;
  hasCartesian: boolean;
  hasSpherical: boolean;
  hasIntensity: boolean;
  hasColor: boolean;
}

export interface E57ProjectSummary {
  id: string;
  sourcePath: string;
  name: string;
  guid: string | null;
  libraryVersion: string | null;
  coordinateMetadata: string | null;
  scanPositions: E57ScanPosition[];
  updatedAt: number;
}

interface Props {
  projects: E57ProjectSummary[];
  onChange: () => void | Promise<void>;
  onStatus: (s: { kind: 'ok' | 'err' | 'info'; msg: string } | null) => void;
}

export default function E57ProjectPanel({ projects, onChange, onStatus }: Props) {
  const [importOpen, setImportOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const selected = projects.find(p => p.id === selectedId) ?? null;

  return (
    <>
      <div className="rounded-md" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px]" style={{ color: 'var(--text)' }}>E57 files</div>
            <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
              ASTM E2807 — FARO Focus / Orbis, Leica BLK360 / RTC360 / Cyclone, Trimble X7 / X9, NavVis VLX, Emesent Hovermap, XGRIDS Lixel, GreenValley LiDAR360.
            </div>
          </div>
          <button
            className="btn btn-primary !h-8 !px-3 mono text-[11.5px]"
            onClick={() => setImportOpen(true)}
            title="Pick a .e57 file on disk"
          >+ Import E57 file</button>
        </div>

        {projects.length === 0 ? (
          <div className="p-6 text-center">
            <div className="mono text-[12px]" style={{ color: 'var(--text-dim)', marginBottom: 4 }}>
              No E57 files yet.
            </div>
            <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              Import an <span style={{ color: 'var(--text-dim)' }}>.e57</span> file to list its scan positions. Then crop a region and export to the Editor as a single LAS / LAZ.
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
                      {p.scanPositions.length} scan position{p.scanPositions.length === 1 ? '' : 's'}
                      {p.libraryVersion ? ` · ${p.libraryVersion.split(' ')[0]}` : ''}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="overflow-y-auto scroll-thin">
              {selected ? (
                <E57ScanList
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
        <E57ImportDialog
          onClose={() => setImportOpen(false)}
          onImported={async () => { setImportOpen(false); await onChange(); }}
          onStatus={onStatus}
        />
      )}
    </>
  );
}
