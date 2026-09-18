// Scan positions of one imported Riegl project — each row shows the
// position's name, registration status, point count and a select toggle
// for the export workflow. The header carries the project-wide actions
// (re-register, crop region, export merged LAS for the Editor).
//
// Cropping + merging across positions runs on the Rust side
// (riegl_export_region); this UI just collects the bbox / polygon + which
// positions to include. The result lands as a .laz in the project's
// imports/ folder and the user can open it from the Editor's Layers
// panel.

import { useMemo, useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import type { RieglCapabilities, RieglProjectSummary, RieglScanPosition } from './RieglProjectPanel';
import { confirmDialog } from '../../ui/dialogs';

interface Props {
  project: RieglProjectSummary;
  /** What the backend can read — decides whether a .rxp-only position
   *  is exportable at all. */
  caps: RieglCapabilities;
  onChange: () => void | Promise<void>;
  onStatus: (s: { kind: 'ok' | 'err' | 'info'; msg: string } | null) => void;
}

/** How many `.rdbx` the importer matched to a position. Older
 *  manifests carry no paths, only the flag, so fall back to it. */
function rdbxCount(sp: RieglScanPosition): number {
  return sp.rdbxPaths?.length ?? (sp.hasRdbx ? 1 : 0);
}

function rxpCount(sp: RieglScanPosition): number {
  return sp.rxpPaths?.length ?? sp.rxpCount ?? 0;
}

/** Can this build export this position? `.rdbx` only where rdblib is
 *  linked in, `.rxp` only where RiVLib is — and either is a build
 *  nobody may distribute, so in the build that ships the answer is no
 *  for every position, and the panel says what to do instead. */
function isExportable(sp: RieglScanPosition, caps: RieglCapabilities): boolean {
  return (caps.rdbx && rdbxCount(sp) > 0) || (caps.rxp && rxpCount(sp) > 0);
}

/** The way forward when this build cannot read the project's points:
 *  RiSCAN PRO exports what PointCloudLabeler already imports. */
const EXPORT_INSTEAD = 'In RiSCAN PRO select the scan positions, Export → E57 or LAS/LAZ, in project (PRCS) or global (GLCS) coordinates, and import that file here through the E57 panel below or the Editor\'s LAS import — the registration RiSCAN PRO holds comes with it.';

export default function RieglScanPositionList({ project, caps, onChange, onStatus }: Props) {
  const { project: pointcloudlabeler } = useProject();
  // Only positions with a readable .rdbx can be exported. They used to
  // be selectable anyway — dimmed, but selected by default and counted
  // on the export button — so the export ran and failed in the backend
  // instead of the UI saying up front what it had.
  const exportable = useMemo(
    () => project.scanPositions.filter(sp => isExportable(sp, caps)),
    [project.scanPositions, caps],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(exportable.map(p => p.id)));
  const [exportBusy, setExportBusy] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  // Crop bbox in PROJECT (PRCS) coords. Empty strings = "no clip on that
  // axis" — the exporter passes through every selected position's points
  // unfiltered for that dim.
  const [bbox, setBbox] = useState({
    xMin: '', xMax: '', yMin: '', yMax: '', zMin: '', zMax: '',
  });

  const allOn = exportable.length > 0 && selected.size === exportable.length;
  const anySelected = selected.size > 0;

  const totalPts = useMemo(() => {
    let n = 0; let known = 0;
    for (const sp of project.scanPositions) {
      if (!selected.has(sp.id)) continue;
      if (sp.pointCount != null) { n += sp.pointCount; known++; }
    }
    return { n, complete: known === selected.size };
  }, [project.scanPositions, selected]);

  const toggleAll = () => {
    setSelected(allOn ? new Set() : new Set(exportable.map(p => p.id)));
  };
  const toggleOne = (id: string) => {
    if (!exportable.some(sp => sp.id === id)) return;
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const doExport = async () => {
    if (!pointcloudlabeler?.folder) return;
    const api = (window as unknown as Record<string, unknown>).desktop as {
      rieglExportRegion?: (args: {
        projectFolder: string;
        rieglId: string;
        scanPositionIds: string[];
        bbox: { xMin: number | null; xMax: number | null; yMin: number | null; yMax: number | null; zMin: number | null; zMax: number | null };
        outPath: string;
      }) => Promise<{ outPath: string; pointCount: number }>;
      saveLasDialog?: (filename: string) => Promise<string | null>;
    } | undefined;
    if (!api?.rieglExportRegion || !api?.saveLasDialog) {
      onStatus({ kind: 'err', msg: 'Riegl region export needs the desktop build.' });
      return;
    }
    const filename = `${safeFilename(project.name)}_crop.laz`;
    const out = await api.saveLasDialog(filename);
    if (!out) return;
    setExportBusy(true); setExportPct(0);
    onStatus({ kind: 'info', msg: 'Exporting Riegl scan positions…' });
    try {
      const parseN = (s: string): number | null => {
        const v = parseFloat(s);
        return Number.isFinite(v) ? v : null;
      };
      const res = await api.rieglExportRegion({
        projectFolder: pointcloudlabeler.folder,
        rieglId: project.id,
        scanPositionIds: [...selected],
        bbox: {
          xMin: parseN(bbox.xMin), xMax: parseN(bbox.xMax),
          yMin: parseN(bbox.yMin), yMax: parseN(bbox.yMax),
          zMin: parseN(bbox.zMin), zMax: parseN(bbox.zMax),
        },
        outPath: out,
      });
      onStatus({ kind: 'ok', msg: `Exported ${res.pointCount.toLocaleString()} points → ${res.outPath}. Open it from the Editor's Layers panel.` });
    } catch (e) {
      onStatus({ kind: 'err', msg: `Riegl export failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setExportBusy(false); setExportPct(0);
    }
  };

  const remove = async () => {
    if (!pointcloudlabeler?.folder) return;
    if (!await confirmDialog(`Forget Riegl project "${project.name}"? The original Riegl files on disk are left alone; only PointCloudLabeler's manifest is removed.`)) return;
    const api = (window as unknown as Record<string, unknown>).desktop as {
      rieglRemoveProject?: (args: { projectFolder: string; rieglId: string }) => Promise<void>;
    } | undefined;
    if (!api?.rieglRemoveProject) {
      onStatus({ kind: 'err', msg: 'Cannot remove — desktop command missing.' });
      return;
    }
    try {
      await api.rieglRemoveProject({ projectFolder: pointcloudlabeler.folder, rieglId: project.id });
      onStatus({ kind: 'ok', msg: `Removed Riegl project "${project.name}".` });
      await onChange();
    } catch (e) {
      onStatus({ kind: 'err', msg: `Remove failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  return (
    <div className="flex flex-col">
      {/* Project header */}
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[13px]" style={{ color: 'var(--text)' }}>{project.name}</div>
            <div className="mono text-[10px] truncate" title={project.sourcePath} style={{ color: 'var(--text-mute)' }}>{project.sourcePath}</div>
            <div className="mono text-[10px] mt-1" style={{ color: 'var(--text-mute)' }}>
              {project.scanPositions.length} scan position{project.scanPositions.length === 1 ? '' : 's'}
              {project.epsg ? ` · EPSG:${project.epsg}` : ' · no EPSG stored'}
              {project.pop ? ' · POP set (PRCS → GLCS)' : ''}
            </div>
            {project.rdbxInProject != null && (
              <div className="mono text-[10px] mt-0.5" style={{ color: 'var(--text-mute)' }}>
                {project.kind === 'scanner-proj' ? 'Scanner .PROJ · ' : ''}
                {project.rdbxInProject} .rdbx · {project.rxpInProject ?? 0} .rxp found in the folder
                {project.rdbxUnassigned ? ` · ${project.rdbxUnassigned} .rdbx not matched to a position` : ''}
              </div>
            )}
          </div>
          <button className="btn !h-7 !px-2 mono text-[10.5px]" onClick={remove} title="Forget this Riegl project (leaves the original files alone)">Remove</button>
        </div>
      </div>

      {/* Scan position list */}
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="chip" style={{ margin: 0 }}>Scan positions</span>
          <button
            onClick={toggleAll}
            className="mono text-[10px] px-2 py-0.5 rounded-sm"
            style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }}
          >{allOn ? 'Select none' : 'Select all'}</button>
        </div>
        <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
          <div className="max-h-[200px] overflow-y-auto scroll-thin">
            {project.scanPositions.length === 0 ? (
              <div className="p-4 mono text-[10.5px] text-center" style={{ color: 'var(--text-mute)' }}>
                No scan positions parsed. (Project XML may use an unrecognised schema.)
              </div>
            ) : (
              project.scanPositions.map((sp, i) => (
                <ScanRow
                  key={sp.id}
                  sp={sp}
                  caps={caps}
                  alt={i % 2 === 0}
                  on={selected.has(sp.id)}
                  onToggle={() => toggleOne(sp.id)}
                />
              ))
            )}
          </div>
        </div>
        <div className="mono text-[9.5px] mt-1.5" style={{ color: 'var(--text-mute)' }}>
          Selected: {selected.size} / {exportable.length} exportable
          {exportable.length !== project.scanPositions.length && ` (of ${project.scanPositions.length})`}
          {totalPts.n > 0 && ` · ~${(totalPts.n / 1e6).toFixed(1)}M points${totalPts.complete ? '' : ' (partial — some counts unknown)'}`}
        </div>
        {project.scanPositions.length > 0 && exportable.length === 0 && (
          <div className="mono text-[9.5px] mt-1.5 rounded-sm px-2 py-1.5"
               style={{ color: 'var(--text-dim)', border: '1px solid var(--line)', background: 'var(--wash-1)', lineHeight: 1.55 }}>
            {!caps.rdbx && (project.rdbxInProject ?? 0) > 0
              ? `This project's ${project.rdbxInProject} .rdbx file${project.rdbxInProject === 1 ? ' is' : 's are'} RIEGL RDB 2 database${project.rdbxInProject === 1 ? '' : 's'}, which only RIEGL's rdblib reads — and rdblib cannot ship with PointCloudLabeler, so this build cannot read the points. ${EXPORT_INSTEAD} (Building PointCloudLabeler yourself with --features rdblib reads them directly; that build is for your own use only.)`
              : project.rdbxInProject === 0
                ? `No .rdbx anywhere in this project folder${(project.rxpInProject ?? 0) > 0 ? `, only ${project.rxpInProject} .rxp scan${project.rxpInProject === 1 ? '' : 's'}` : ''} — and .rxp needs RIEGL's RiVLib, which no distributable build can link. ${EXPORT_INSTEAD} (Or build PointCloudLabeler yourself with --features rivlib, for your own use only.)`
                : `${project.rdbxInProject ?? 0} .rdbx are in the project folder but none could be matched to a scan position. This is a layout the importer does not know yet — worth reporting with the paths.`}
          </div>
        )}
      </div>

      {/* Crop bbox (PRCS coords) */}
      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
        <span className="chip mb-1.5">Crop bbox <span className="mono text-[9px]" style={{ color: 'var(--text-mute)', marginLeft: 4 }}>(project coords, optional)</span></span>
        <div className="grid grid-cols-3 gap-1.5">
          {(['x', 'y', 'z'] as const).map(ax => (
            <div key={ax} className="flex flex-col">
              <span className="mono text-[9px] mb-0.5" style={{ color: 'var(--text-mute)' }}>{ax.toUpperCase()}</span>
              <input
                className="mono text-[11px] py-1 px-1.5 rounded-md outline-none mb-1"
                style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                placeholder="min"
                value={bbox[`${ax}Min` as keyof typeof bbox]}
                onChange={(e) => setBbox(b => ({ ...b, [`${ax}Min`]: e.target.value }))}
              />
              <input
                className="mono text-[11px] py-1 px-1.5 rounded-md outline-none"
                style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                placeholder="max"
                value={bbox[`${ax}Max` as keyof typeof bbox]}
                onChange={(e) => setBbox(b => ({ ...b, [`${ax}Max`]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Leave any field blank to skip that axis. Coordinates are in the Riegl project's PRCS (after the SOP transform); if the project carries a POP they're still PRCS — the export writes the transformed-to-GLCS LAS for round-tripping.
        </div>
      </div>

      {/* Export */}
      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
        <button
          className="btn btn-primary !h-9 w-full mono text-[12px] justify-center"
          disabled={!anySelected || exportBusy}
          onClick={() => void doExport()}
          title={anySelected ? 'Crop + merge the selected scan positions into a single LAZ and open the save-as dialog' : 'Select at least one scan position'}
        >
          {exportBusy
            ? `Exporting… ${exportPct > 0 ? `${Math.round(exportPct * 100)}%` : ''}`
            : `Export region to LAS / LAZ${anySelected ? ` (${selected.size} position${selected.size === 1 ? '' : 's'})` : ''}`}
        </button>
        <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          The merged cloud goes to the LAS file you pick. Open it from the Editor's Layers / Import to convert to an octree.
        </div>
      </div>
    </div>
  );
}

function ScanRow({ sp, caps, on, alt, onToggle }: {
  sp: RieglScanPosition; caps: RieglCapabilities; on: boolean; alt: boolean; onToggle: () => void;
}) {
  const nRdbx = rdbxCount(sp);
  const nRxp = rxpCount(sp);
  const readable = isExportable(sp, caps);
  const source = nRdbx > 0 ? '.rdbx' : '.rxp';
  return (
    <button
      onClick={onToggle}
      disabled={!readable}
      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-all"
      style={{
        background: alt ? 'var(--wash-1)' : 'transparent',
        borderLeft: `3px solid ${on ? 'var(--accent)' : 'transparent'}`,
        opacity: readable ? 1 : 0.55,
        cursor: readable ? 'pointer' : 'not-allowed',
      }}
      title={readable
        ? [
            `Toggle ${sp.name} — ${nRdbx > 0 ? `${nRdbx} .rdbx` : `${nRxp} .rxp`}`,
            ...(nRdbx > 0 ? (sp.rdbxPaths ?? []) : (sp.rxpPaths ?? [])),
            sp.poseSource
              ? `pose: ${sp.poseSource}`
              : sp.poseNote ?? 'pose: none found — identity, register it in the Co-registration panel',
          ].join('\n')
        : nRdbx > 0 && !caps.rdbx
          ? `${sp.name} — ${nRdbx} .rdbx (RIEGL RDB 2), readable only through RIEGL's rdblib, which this build does not have. Export to E57 / LAS from RiSCAN PRO and import that, or build with --features rdblib for your own use.`
        : nRxp > 0
          ? `${sp.name} — ${nRxp} .rxp scan${nRxp === 1 ? '' : 's'} and no .rdbx. Reading .rxp needs RIEGL's RiVLib, which no distributable build can link; export to E57 / LAS from RiSCAN PRO, or build with --features rivlib for your own use.`
          : sp.rxpCount == null
            ? `${sp.name} — no .rdbx found (this manifest predates the .rxp tally; re-import to refresh it)`
            : `${sp.name} — no .rdbx or .rxp found for this position`}
    >
      <span
        className="rounded-sm shrink-0 flex items-center justify-center"
        style={{ width: 14, height: 14, background: on ? 'var(--accent)' : 'rgba(0,0,0,0.3)', border: `1px solid ${on ? 'var(--accent)' : 'var(--line-strong)'}` }}
      >
        {on && (
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="#06140d" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8.5L6.5 12L13 4" />
          </svg>
        )}
      </span>
      <span className="mono text-[11px] flex-1 truncate" style={{ color: on ? 'var(--text)' : 'var(--text-dim)' }}>{sp.name}</span>
      {sp.pointCount != null && (
        <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
          {(sp.pointCount / 1e6).toFixed(1)}M
        </span>
      )}
      {sp.poseSource === null && (
        <span className="mono text-[9px] px-1 py-0.5 rounded-sm" style={{ color: 'var(--text-mute)', border: '1px solid var(--line)' }}
              title={sp.poseNote ?? 'No pose file held a transform for this position — it sits at the origin unrotated until you register it'}>identity pose</span>
      )}
      {readable && (nRdbx > 1 || (nRdbx === 0 && nRxp > 1)) && (
        <span className="mono text-[9px] px-1 py-0.5 rounded-sm" style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }} title={`${nRdbx > 0 ? nRdbx : nRxp} scans at this position — all of them are exported`}>{nRdbx > 0 ? nRdbx : nRxp} × {source}</span>
      )}
      {readable && nRdbx === 0 && nRxp === 1 && (
        <span className="mono text-[9px] px-1 py-0.5 rounded-sm" style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }} title="Read through RiVLib — this build cannot be distributed">.rxp</span>
      )}
      {!readable && (
        <span className="mono text-[9px] px-1 py-0.5 rounded-sm" style={{ color: 'var(--text-mute)', border: '1px solid var(--line)' }} title=".rdbx missing">
          {nRxp > 0 || sp.rxpCount == null ? '.rxp only' : 'no point files'}
        </span>
      )}
    </button>
  );
}

function safeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'riegl';
}
