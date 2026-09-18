// Riegl project panel — list / import RiSCAN PRO + RiPROCESS projects
// the user has registered with PointCloudLabeler, browse their scan positions, and
// export a cropped + merged LAS for the Editor module to open.
//
// Each imported project gets a folder under
//   <projectFolder>/preprocessing/riegl/<safeName>/
// holding a tiny manifest.json PointCloudLabeler writes (Riegl path, scan positions,
// transforms) so re-opening the PointCloudLabeler project re-lists them without
// re-parsing.

import { useEffect, useState } from 'react';
import RieglImportDialog from './RieglImportDialog';
import RieglScanPositionList from './RieglScanPositionList';

export interface RieglScanPosition {
  id: string;
  name: string;
  /** 4×4 SOP matrix (scan-position → project coords), row-major. */
  sop: number[];
  /** Point count if known, else null (RDBLib metadata not always cached). */
  pointCount: number | null;
  /** Centre of the scan position's bbox in PROJECT (PRCS) coords, for
   *  the map / table view. Null when the manifest predates the bbox cache. */
  centre: [number, number, number] | null;
  /** True if the importer matched at least one *.rdbx to this scan
   *  position — i.e. `rdbxPaths` is non-empty. False when only *.rxp
   *  line files were found, which need RIEGL's RiVLib (not linked). */
  hasRdbx: boolean;
  /** The *.rdbx files this position's points come from. A position
   *  scanned twice has two. Absent in manifests written before the
   *  importer resolved and cached the paths. */
  rdbxPaths?: string[];
  /** How many *.rxp files were found for it. Only for the badge to
   *  say what the importer saw. */
  rxpCount?: number;
  /** The *.rxp files of this position. Exportable only in a build made
   *  with `--features rivlib` — see `RieglCapabilities`. */
  rxpPaths?: string[];
  /** Which file the pose came from (`project.rsp`, `final.pose`, …), or
   *  null when none held one and the position carries the identity. */
  poseSource?: string | null;
  /** When no file held a transform: what they held instead. A
   *  scanner's `final.pose` is a GNSS fix and inclination, not a
   *  registration, and "identity pose" alone does not say why. */
  poseNote?: string | null;
}

/** What the backend this UI is talking to can actually read. Neither
 *  RIEGL format in the build that ships: `.rdbx` (RDB 2) only through
 *  RIEGL's rdblib, `.rxp` only through RiVLib, and a build linked
 *  against either cannot be distributed. */
export interface RieglCapabilities {
  rdbx: boolean;
  rxp: boolean;
}

export interface RieglProjectSummary {
  /** PointCloudLabeler-side registration id (folder name under preprocessing/riegl/). */
  id: string;
  /** Original .RiSCAN / .RiPROJECT path on disk. */
  sourcePath: string;
  /** Display name from the project's GLCS / metadata, else the folder name. */
  name: string;
  /** EPSG code (PRCS), null if not stored in the project. */
  epsg: number | null;
  /** 4×4 POP matrix (PRCS → GLCS), row-major. Null when the project is
   *  un-georeferenced. */
  pop: number[] | null;
  scanPositions: RieglScanPosition[];
  /** Which layout the folder turned out to be: a RiSCAN PRO /
   *  RiPROCESS project, or a scanner's own `.PROJ`. */
  kind?: 'riscan' | 'scanner-proj';
  /** Point files counted anywhere under the project folder, whether or
   *  not a scan position claimed them, plus the .rdbx no position did.
   *  "This project carries no .rdbx at all" and "they are somewhere the
   *  importer did not look" need different answers from the user, and
   *  until these existed the UI could not tell them apart. Absent in
   *  manifests written before the tally. */
  rdbxInProject?: number;
  rxpInProject?: number;
  rdbxUnassigned?: number;
  /** When the manifest was last refreshed (epoch ms). */
  updatedAt: number;
}

interface Props {
  projects: RieglProjectSummary[];
  onChange: () => void | Promise<void>;
  onStatus: (s: { kind: 'ok' | 'err' | 'info'; msg: string } | null) => void;
}

export default function RieglProjectPanel({ projects, onChange, onStatus }: Props) {
  const [importOpen, setImportOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const selected = projects.find(p => p.id === selectedId) ?? null;
  // Asked once per panel mount. The conservative default is what a
  // released build reports — nothing — so a backend too old to answer
  // is treated as the shipped one rather than as able to read points.
  const [caps, setCaps] = useState<RieglCapabilities>({ rdbx: false, rxp: false });
  useEffect(() => {
    const api = (window as unknown as Record<string, unknown>).desktop as {
      rieglCapabilities?: () => Promise<RieglCapabilities>;
    } | undefined;
    if (!api?.rieglCapabilities) return;
    let alive = true;
    void api.rieglCapabilities()
      .then(c => { if (alive) setCaps(c); })
      .catch(e => console.warn('riegl_capabilities failed', e));
    return () => { alive = false; };
  }, []);

  return (
    <>
      <div className="rounded-md" style={{ border: '1px solid var(--line)', background: 'var(--wash-1)' }}>
        <div className="flex items-center px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px]" style={{ color: 'var(--text)' }}>Riegl projects</div>
            <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
              RiSCAN PRO / RiPROCESS .RiSCAN / .RiPROJECT, or a scanner's own .PROJ — scan positions + registration in one place.
            </div>
          </div>
          <button
            className="btn btn-primary !h-8 !px-3 mono text-[11.5px]"
            onClick={() => setImportOpen(true)}
            title="Pick a Riegl .RiSCAN / .RiPROJECT folder on disk"
          >+ Import Riegl project</button>
        </div>

        {projects.length === 0 ? (
          <div className="p-6 text-center">
            <div className="mono text-[12px]" style={{ color: 'var(--text-dim)', marginBottom: 4 }}>
              No Riegl projects yet.
            </div>
            <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              Import a <span style={{ color: 'var(--text-dim)' }}>.RiSCAN</span> / <span style={{ color: 'var(--text-dim)' }}>.RiPROJECT</span> folder — or a scanner's own <span style={{ color: 'var(--text-dim)' }}>.PROJ</span> — to load its scan positions + registration. Then crop a region of interest and export to the Editor.
            </div>
          </div>
        ) : (
          <div className="grid" style={{ gridTemplateColumns: '260px 1fr', minHeight: 360 }}>
            {/* Project list (left) */}
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
                      {p.epsg ? ` · EPSG:${p.epsg}` : ''}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Selected project detail (right) */}
            <div className="overflow-y-auto scroll-thin">
              {selected ? (
                /* Keyed by project + manifest time so switching projects
                   or re-importing one starts with a selection belonging
                   to the project on screen. Without it the list kept the
                   previous project's selected ids — which overlap,
                   because ids are positional (sp_000, sp_001, …). */
                <RieglScanPositionList
                  key={`${selected.id}:${selected.updatedAt}`}
                  project={selected}
                  caps={caps}
                  onChange={onChange}
                  onStatus={onStatus}
                />
              ) : (
                <div className="p-6 mono text-[11px]" style={{ color: 'var(--text-mute)' }}>
                  Pick a project on the left.
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {importOpen && (
        <RieglImportDialog
          onClose={() => setImportOpen(false)}
          onImported={async () => { setImportOpen(false); await onChange(); }}
          onStatus={onStatus}
        />
      )}
    </>
  );
}
