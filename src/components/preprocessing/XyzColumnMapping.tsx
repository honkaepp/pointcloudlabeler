// Column-role mapping for an imported ASCII file. Unlike the Riegl /
// E57 / PTX panels (which list per-scan positions), an ASCII cloud is
// one bag of points — the right pane is a column-mapping editor + a
// preview table + an Export button.
//
// The "preview" comes from the Rust importer (first ~10 lines as
// already-parsed cells), so the user sees concrete values per column
// while picking the right roles. Every change to the mapping persists
// to the manifest via xyz_set_mapping so it survives a reload.

import { useMemo, useState } from 'react';
import { useProject } from '../../context/ProjectContext';
import type { XyzMapping, XyzProjectSummary } from './XyzProjectPanel';
import { confirmDialog } from '../../ui/dialogs';

interface Props {
  project: XyzProjectSummary;
  onChange: () => void | Promise<void>;
  onStatus: (s: { kind: 'ok' | 'err' | 'info'; msg: string } | null) => void;
}

type OptionRole = 'intensity' | 'r' | 'g' | 'b' | 'classification';
const OPTION_LABELS: Record<OptionRole, string> = {
  intensity: 'Intensity',
  r: 'Red',
  g: 'Green',
  b: 'Blue',
  classification: 'Classification',
};

export default function XyzColumnMapping({ project, onChange, onStatus }: Props) {
  const { project: pointcloudlabeler } = useProject();
  const [mapping, setMapping] = useState<XyzMapping>(project.mapping);
  const [savingMap, setSavingMap] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportPct, setExportPct] = useState(0);
  const [bbox, setBbox] = useState({
    xMin: '', xMax: '', yMin: '', yMax: '', zMin: '', zMax: '',
  });

  const cols = useMemo(() => Array.from({ length: project.columnCount }, (_, i) => i), [project.columnCount]);

  // Column labels combine the zero-based index with the header name
  // (when present) so the user always sees both — useful when columns
  // are named X / Y / Z but the user has to pick e.g. column 7 as
  // intensity.
  const colLabel = (i: number) => {
    const name = project.headerNames[i];
    if (name && name.trim().length > 0) return `Col ${i} (${name})`;
    return `Col ${i}`;
  };

  const updateMapping = async (next: XyzMapping) => {
    setMapping(next);
    if (!pointcloudlabeler?.folder) return;
    const api = (window as unknown as Record<string, unknown>).desktop as {
      xyzSetMapping?: (args: { projectFolder: string; xyzId: string; mapping: XyzMapping }) => Promise<unknown>;
    } | undefined;
    if (!api?.xyzSetMapping) return;
    setSavingMap(true);
    try {
      await api.xyzSetMapping({ projectFolder: pointcloudlabeler.folder, xyzId: project.id, mapping: next });
    } catch (e) {
      onStatus({ kind: 'err', msg: `Saving mapping failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setSavingMap(false);
    }
  };

  const setRequired = (role: 'x' | 'y' | 'z', col: number) => {
    updateMapping({ ...mapping, [role]: col });
  };
  const setOptional = (role: OptionRole, col: number | null) => {
    updateMapping({ ...mapping, [role]: col });
  };

  const subscribeProgress = (): (() => void) | null => {
    const t = (window as unknown as { __TAURI__?: { event?: { listen?: (name: string, cb: (e: { payload: { pct: number } }) => void) => Promise<() => void> } } }).__TAURI__;
    const listen = t?.event?.listen;
    if (!listen) return null;
    let off: (() => void) | null = null;
    listen('xyz-progress', (e) => {
      const pct = e?.payload?.pct;
      if (typeof pct === 'number') setExportPct(pct);
    }).then((unlisten) => { off = unlisten; }).catch(() => { /* no-op */ });
    return () => { if (off) off(); };
  };

  const doExport = async () => {
    if (!pointcloudlabeler?.folder) return;
    const api = (window as unknown as Record<string, unknown>).desktop as {
      xyzExport?: (args: {
        projectFolder: string;
        xyzId: string;
        bbox: { xMin: number | null; xMax: number | null; yMin: number | null; yMax: number | null; zMin: number | null; zMax: number | null };
        outPath: string;
      }) => Promise<{ outPath: string; pointCount: number }>;
      saveLasDialog?: (filename: string) => Promise<string | null>;
    } | undefined;
    if (!api?.xyzExport || !api?.saveLasDialog) {
      onStatus({ kind: 'err', msg: 'XYZ export needs the desktop build.' });
      return;
    }
    const filename = `${safeFilename(project.name)}_crop.laz`;
    const out = await api.saveLasDialog(filename);
    if (!out) return;
    setExportBusy(true); setExportPct(0);
    const unsubscribe = subscribeProgress();
    onStatus({ kind: 'info', msg: 'Converting ASCII to LAS / LAZ…' });
    try {
      const parseN = (s: string): number | null => {
        const v = parseFloat(s);
        return Number.isFinite(v) ? v : null;
      };
      const res = await api.xyzExport({
        projectFolder: pointcloudlabeler.folder,
        xyzId: project.id,
        bbox: {
          xMin: parseN(bbox.xMin), xMax: parseN(bbox.xMax),
          yMin: parseN(bbox.yMin), yMax: parseN(bbox.yMax),
          zMin: parseN(bbox.zMin), zMax: parseN(bbox.zMax),
        },
        outPath: out,
      });
      onStatus({ kind: 'ok', msg: `Exported ${res.pointCount.toLocaleString()} points → ${res.outPath}. Open it from the Editor's Layers panel.` });
    } catch (e) {
      onStatus({ kind: 'err', msg: `XYZ export failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (unsubscribe) unsubscribe();
      setExportBusy(false); setExportPct(0);
    }
  };

  const remove = async () => {
    if (!pointcloudlabeler?.folder) return;
    if (!await confirmDialog(`Forget XYZ file "${project.name}"? The original ASCII file stays on disk; only PointCloudLabeler's manifest is removed.`)) return;
    const api = (window as unknown as Record<string, unknown>).desktop as {
      xyzRemoveProject?: (args: { projectFolder: string; xyzId: string }) => Promise<void>;
    } | undefined;
    if (!api?.xyzRemoveProject) {
      onStatus({ kind: 'err', msg: 'Cannot remove — desktop command missing.' });
      return;
    }
    try {
      await api.xyzRemoveProject({ projectFolder: pointcloudlabeler.folder, xyzId: project.id });
      onStatus({ kind: 'ok', msg: `Removed XYZ file "${project.name}".` });
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
              {project.columnCount} column{project.columnCount === 1 ? '' : 's'} · {project.delimiter} delimiter · {project.hasHeader ? 'header on line 1' : 'no header'} · ~{(project.approxPointCount / 1e6).toFixed(1)}M points
            </div>
          </div>
          <button className="btn !h-7 !px-2 mono text-[10.5px]" onClick={remove} title="Forget this file (leaves the original alone)">Remove</button>
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="chip" style={{ margin: 0 }}>Column mapping</span>
          {savingMap && <span className="mono text-[9px]" style={{ color: 'var(--text-mute)' }}>saving…</span>}
        </div>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: '90px 1fr' }}>
          <RequiredRow label="X" col={mapping.x} cols={cols} colLabel={colLabel} onSet={(c) => setRequired('x', c)} />
          <RequiredRow label="Y" col={mapping.y} cols={cols} colLabel={colLabel} onSet={(c) => setRequired('y', c)} />
          <RequiredRow label="Z" col={mapping.z} cols={cols} colLabel={colLabel} onSet={(c) => setRequired('z', c)} />
          {(Object.keys(OPTION_LABELS) as OptionRole[]).map(role => (
            <OptionalRow
              key={role}
              label={OPTION_LABELS[role]}
              col={mapping[role]}
              cols={cols}
              colLabel={colLabel}
              onSet={(c) => setOptional(role, c)}
            />
          ))}
        </div>
        <div className="mono text-[9.5px] mt-1.5" style={{ color: 'var(--text-mute)' }}>
          Intensity auto-detects three conventions ([-1,1] / [0,1] / 0..2047). Colour expects 0..255 per channel (or 0..1 floats).
        </div>
      </div>

      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
        <span className="chip mb-1.5">Preview <span className="mono text-[9px]" style={{ color: 'var(--text-mute)', marginLeft: 4 }}>first {project.preview.length} lines</span></span>
        <div className="rounded-md overflow-auto scroll-thin mono text-[10.5px]" style={{ border: '1px solid var(--line)', maxHeight: 220, background: 'rgba(0,0,0,0.25)' }}>
          <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%' }}>
            <thead style={{ background: 'var(--wash-1)', position: 'sticky', top: 0 }}>
              <tr>
                {cols.map(i => (
                  <th key={i} className="px-2 py-1 text-left" style={{ color: 'var(--text-mute)', borderBottom: '1px solid var(--line)' }}>
                    {colLabel(i)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {project.preview.map((row, ri) => (
                <tr key={ri}>
                  {cols.map(i => (
                    <td key={i} className="px-2 py-1" style={{ color: 'var(--text-dim)', borderBottom: '1px solid var(--line)' }}>
                      {row[i] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
        <span className="chip mb-1.5">Crop bbox <span className="mono text-[9px]" style={{ color: 'var(--text-mute)', marginLeft: 4 }}>(world coords, optional)</span></span>
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
      </div>

      <div className="px-4 py-3" style={{ borderTop: '1px solid var(--line)' }}>
        <button
          className="btn btn-primary !h-9 w-full mono text-[12px] justify-center"
          disabled={exportBusy}
          onClick={() => void doExport()}
          title="Convert the ASCII file to LAS / LAZ with the mapping applied"
        >
          {exportBusy
            ? `Exporting… ${exportPct > 0 ? `${Math.round(exportPct * 100)}%` : ''}`
            : 'Convert to LAS / LAZ'}
        </button>
        <div className="mono text-[9.5px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
          Two passes: first scans for the bbox (LAS offset), second writes the points. Open the LAS / LAZ from the Editor's Layers / Import to convert to an octree.
        </div>
      </div>
    </div>
  );
}

function RequiredRow({ label, col, cols, colLabel, onSet }: {
  label: string;
  col: number;
  cols: number[];
  colLabel: (i: number) => string;
  onSet: (c: number) => void;
}) {
  return (
    <>
      <div className="mono text-[11px] flex items-center" style={{ color: 'var(--text-dim)' }}>{label}</div>
      <select
        className="mono text-[11.5px] py-1 px-1.5 rounded-md outline-none"
        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text)' }}
        value={col}
        onChange={(e) => onSet(parseInt(e.target.value, 10))}
      >
        {cols.map(i => <option key={i} value={i}>{colLabel(i)}</option>)}
      </select>
    </>
  );
}

function OptionalRow({ label, col, cols, colLabel, onSet }: {
  label: string;
  col: number | null;
  cols: number[];
  colLabel: (i: number) => string;
  onSet: (c: number | null) => void;
}) {
  const val = col == null ? -1 : col;
  return (
    <>
      <div className="mono text-[11px] flex items-center" style={{ color: 'var(--text-mute)' }}>{label}</div>
      <select
        className="mono text-[11.5px] py-1 px-1.5 rounded-md outline-none"
        style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid var(--line)', color: 'var(--text-dim)' }}
        value={val}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          onSet(n < 0 ? null : n);
        }}
      >
        <option value={-1}>— skip —</option>
        {cols.map(i => <option key={i} value={i}>{colLabel(i)}</option>)}
      </select>
    </>
  );
}

function safeFilename(s: string): string {
  return s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'xyz';
}
