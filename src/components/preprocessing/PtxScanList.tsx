// PTX scan-section list — one row per section in the imported file.
// PTS files end up as one row (single section, identity pose).
//
// Same shape as the Riegl + E57 panels so the user sees consistent UI:
// per-row select toggle + tags, world-coord bbox crop (post-pose) and
// export to LAS / LAZ via the Rust ptx_export_region command.

import { useMemo, useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import type { PtxProjectSummary, PtxScanPosition } from './PtxProjectPanel';
import { confirmDialog } from '../../ui/dialogs';

interface Props {
  project: PtxProjectSummary;
  onChange: () => void | Promise<void>;
  onStatus: (s: { kind: 'ok' | 'err' | 'info'; msg: string } | null) => void;
}

export default function PtxScanList({ project, onChange, onStatus }: Props) {
  const { project: pointcloudlabeler } = useProject();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(project.scanPositions.map(p => p.id)));
  const [exportBusy, setExportBusy] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [bbox, setBbox] = useState({
    xMin: '', xMax: '', yMin: '', yMax: '', zMin: '', zMax: '',
  });

  const allOn = selected.size === project.scanPositions.length;
  const anySelected = selected.size > 0;

  const totalPts = useMemo(() => {
    let n = 0;
    for (const sp of project.scanPositions) {
      if (selected.has(sp.id)) n += sp.pointCount;
    }
    return n;
  }, [project.scanPositions, selected]);

  const toggleAll = () => {
    setSelected(allOn ? new Set() : new Set(project.scanPositions.map(p => p.id)));
  };
  const toggleOne = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const subscribeProgress = (): (() => void) | null => {
    const t = (window as unknown as { __TAURI__?: { event?: { listen?: (name: string, cb: (e: { payload: { pct: number } }) => void) => Promise<() => void> } } }).__TAURI__;
    const listen = t?.event?.listen;
    if (!listen) return null;
    let off: (() => void) | null = null;
    listen('ptx-progress', (e) => {
      const pct = e?.payload?.pct;
      if (typeof pct === 'number') setExportPct(pct);
    }).then((unlisten) => { off = unlisten; }).catch(() => { /* no-op */ });
    return () => { if (off) off(); };
  };

  const doExport = async () => {
    if (!pointcloudlabeler?.folder) return;
    const api = (window as unknown as Record<string, unknown>).desktop as {
      ptxExportRegion?: (args: {
        projectFolder: string;
        ptxId: string;
        scanPositionIds: string[];
        bbox: { xMin: number | null; xMax: number | null; yMin: number | null; yMax: number | null; zMin: number | null; zMax: number | null };
        outPath: string;
      }) => Promise<{ outPath: string; pointCount: number }>;
      saveLasDialog?: (filename: string) => Promise<string | null>;
    } | undefined;
    if (!api?.ptxExportRegion || !api?.saveLasDialog) {
      onStatus({ kind: 'err', msg: 'PTX region export needs the desktop build.' });
      return;
    }
    const filename = `${safeFilename(project.name)}_crop.laz`;
    const out = await api.saveLasDialog(filename);
    if (!out) return;
    setExportBusy(true); setExportPct(0);
    const unsubscribe = subscribeProgress();
    onStatus({ kind: 'info', msg: 'Exporting PTX scan sections…' });
    try {
      const parseN = (s: string): number | null => {
        const v = parseFloat(s);
        return Number.isFinite(v) ? v : null;
      };
      const res = await api.ptxExportRegion({
        projectFolder: pointcloudlabeler.folder,
        ptxId: project.id,
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
      onStatus({ kind: 'err', msg: `PTX export failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (unsubscribe) unsubscribe();
      setExportBusy(false); setExportPct(0);
    }
  };

  const remove = async () => {
    if (!pointcloudlabeler?.folder) return;
    if (!await confirmDialog(`Forget PTX file "${project.name}"? The original .ptx/.pts stays on disk; only PointCloudLabeler's manifest is removed.`)) return;
    const api = (window as unknown as Record<string, unknown>).desktop as {
      ptxRemoveProject?: (args: { projectFolder: string; ptxId: string }) => Promise<void>;
    } | undefined;
    if (!api?.ptxRemoveProject) {
      onStatus({ kind: 'err', msg: 'Cannot remove — desktop command missing.' });
      return;
    }
    try {
      await api.ptxRemoveProject({ projectFolder: pointcloudlabeler.folder, ptxId: project.id });
      onStatus({ kind: 'ok', msg: `Removed PTX file "${project.name}".` });
      await onChange();
    } catch (e) {
      onStatus({ kind: 'err', msg: `Remove failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  return (
    <div className="flex flex-col">
      <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-[13px]" style={{ color: 'var(--text)' }}>{project.name}</div>
            <div className="mono text-[10px] truncate" title={project.sourcePath} style={{ color: 'var(--text-mute)' }}>{project.sourcePath}</div>
            <div className="mono text-[10px] mt-1" style={{ color: 'var(--text-mute)' }}>
              {project.scanPositions.length} scan section{project.scanPositions.length === 1 ? '' : 's'} · {project.kind.toUpperCase()} format
            </div>
          </div>
          <button className="btn !h-7 !px-2 mono text-[10.5px]" onClick={remove} title="Forget this PTX file (leaves the original alone)">Remove</button>
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="chip" style={{ margin: 0 }}>Scan sections</span>
          <button
            onClick={toggleAll}
            className="mono text-[10px] px-2 py-0.5 rounded-sm"
            style={{ color: 'var(--text-dim)', border: '1px solid var(--line)' }}
          >{allOn ? 'Select none' : 'Select all'}</button>
        </div>
        <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--line)' }}>
          <div className="max-h-[260px] overflow-y-auto scroll-thin">
            {project.scanPositions.length === 0 ? (
              <div className="p-4 mono text-[10.5px] text-center" style={{ color: 'var(--text-mute)' }}>
                No scan sections in this file.
              </div>
            ) : (
              project.scanPositions.map((sp, i) => (
                <ScanRow
                  key={sp.id}
                  sp={sp}
                  alt={i % 2 === 0}
                  on={selected.has(sp.id)}
                  onToggle={() => toggleOne(sp.id)}
                />
              ))
            )}
          </div>
        </div>
        <div className="mono text-[9.5px] mt-1.5" style={{ color: 'var(--text-mute)' }}>
          Selected: {selected.size} / {project.scanPositions.length}
          {totalPts > 0 && ` · ~${(totalPts / 1e6).toFixed(1)}M points`}
        </div>
      </div>

      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
        <span className="chip mb-1.5">Crop bbox <span className="mono text-[9px]" style={{ color: 'var(--text-mute)', marginLeft: 4 }}>(world coords, post-pose, optional)</span></span>
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
          Leave any field blank to skip that axis. The crop is applied AFTER each section's pose, so the coords live in the file's shared world frame.
        </div>
      </div>

      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
        <button
          className="btn btn-primary !h-9 w-full mono text-[12px] justify-center"
          disabled={!anySelected || exportBusy}
          onClick={() => void doExport()}
          title={anySelected ? 'Read points from the selected sections, apply each section\'s pose, optionally crop and merge into a single LAS / LAZ' : 'Select at least one scan section'}
        >
          {exportBusy
            ? `Exporting… ${exportPct > 0 ? `${Math.round(exportPct * 100)}%` : ''}`
            : `Export region to LAS / LAZ${anySelected ? ` (${selected.size} section${selected.size === 1 ? '' : 's'})` : ''}`}
        </button>
        <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          The merged cloud goes to the LAS file you pick. Open it from the Editor's Layers / Import to convert to an octree.
        </div>
      </div>
    </div>
  );
}

function ScanRow({ sp, on, alt, onToggle }: {
  sp: PtxScanPosition; on: boolean; alt: boolean; onToggle: () => void;
}) {
  const tags: string[] = [];
  if (sp.hasIntensity) tags.push('I');
  if (sp.hasColor) tags.push('RGB');
  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left transition-all"
      style={{
        background: alt ? 'var(--wash-1)' : 'transparent',
        borderLeft: `3px solid ${on ? 'var(--accent)' : 'transparent'}`,
      }}
      title={`Toggle ${sp.name}`}
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
      {tags.length > 0 && (
        <span className="mono text-[9px] flex gap-1">
          {tags.map(t => (
            <span key={t} className="px-1 py-0.5 rounded-sm" style={{ color: 'var(--text-mute)', border: '1px solid var(--line)' }}>{t}</span>
          ))}
        </span>
      )}
      <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
        {(sp.pointCount / 1e6).toFixed(1)}M
      </span>
    </button>
  );
}

function safeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'ptx';
}
