// XYZ / CSV / TXT project panel — list / import ASCII point-cloud
// files, edit each one's column-to-role mapping, crop a region and
// convert to LAS / LAZ for the Editor to open.

import { useState } from 'react';
import XyzImportDialog from './XyzImportDialog';
import XyzColumnMapping from './XyzColumnMapping';

export interface XyzMapping {
  x: number;
  y: number;
  z: number;
  intensity: number | null;
  r: number | null;
  g: number | null;
  b: number | null;
  classification: number | null;
}

export interface XyzProjectSummary {
  id: string;
  sourcePath: string;
  name: string;
  delimiter: string;
  hasHeader: boolean;
  headerNames: string[];
  columnCount: number;
  preview: string[][];
  approxPointCount: number;
  fileSize: number;
  mapping: XyzMapping;
  updatedAt: number;
}

interface Props {
  projects: XyzProjectSummary[];
  onChange: () => void | Promise<void>;
  onStatus: (s: { kind: 'ok' | 'err' | 'info'; msg: string } | null) => void;
}

export default function XyzProjectPanel({ projects, onChange, onStatus }: Props) {
  const [importOpen, setImportOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const selected = projects.find(p => p.id === selectedId) ?? null;

  return (
    <>
      <div className="rounded-md" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px]" style={{ color: 'var(--text)' }}>ASCII point clouds</div>
            <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
              .xyz / .csv / .txt / .asc — column-separated text. Auto-detected delimiter + header, then map columns to roles.
            </div>
          </div>
          <button
            className="btn btn-primary !h-8 !px-3 mono text-[11.5px]"
            onClick={() => setImportOpen(true)}
            title="Pick an ASCII point-cloud file on disk"
          >+ Import ASCII file</button>
        </div>

        {projects.length === 0 ? (
          <div className="p-6 text-center">
            <div className="mono text-[12px]" style={{ color: 'var(--text-dim)', marginBottom: 4 }}>
              No ASCII files yet.
            </div>
            <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              Import a <span style={{ color: 'var(--text-dim)' }}>.xyz</span> / <span style={{ color: 'var(--text-dim)' }}>.csv</span> / <span style={{ color: 'var(--text-dim)' }}>.txt</span> file to map its columns and convert to LAS / LAZ.
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
                      {p.columnCount} col · {p.delimiter} · ~{(p.approxPointCount / 1e6).toFixed(1)}M pts
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="overflow-y-auto scroll-thin">
              {selected ? (
                <XyzColumnMapping
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
        <XyzImportDialog
          onClose={() => setImportOpen(false)}
          onImported={async () => { setImportOpen(false); await onChange(); }}
          onStatus={onStatus}
        />
      )}
    </>
  );
}
