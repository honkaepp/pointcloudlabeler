// The Layers panel's files: the layers opened from files (meshes,
// and the points and lines of a run's files) as rows of the scene, a picker to
// open any such file, and the project's run outputs (commands/outputs.rs),
// folder by folder, each opened as what it is — a cloud into the editor, a
// trajectory, scan positions, targets, stems, a region, voxels or a mesh as
// a layer over the cloud (fileLayerActions.ts).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOptionalProject } from '../../context/ProjectContext';
import type { OctreeListEntry } from '../../persistence/octreeReader';
import { safeOutputName } from '../../persistence/octreeStore';
import { formatBytes } from '../../utils/format';
import { KIND_LABEL, LAYER_KINDS, classifyOutput, type OutputKind } from '../../layers/fileLayers';
import { removeMesh, updateMesh, useSurveyStore } from './surveyStore';
import {
  layerState, listProjectFiles, openFileLayer, removeFileLayer, setLayerVisible, type ProjectFile,
} from './fileLayerActions';

/** What the picker offers: the files that open as a layer, and clouds. */
export const LAYER_FILE_FILTERS = [
  { name: 'Layer files', extensions: ['txt', 'csv', 'geojson', 'json', 'shp', 'ply', 'obj', 'stl', 'qsm', 'qsf'] },
  { name: 'Point clouds', extensions: ['las', 'laz', 'e57'] },
];

interface PickDesktop {
  openFileDialog?: (o: { filters?: Array<{ name: string; extensions: string[] }> }) => Promise<{ path: string } | null>;
}

/** Open a file the user picks as what it is; the error, if any, to `onError`. */
export async function pickFileLayer(onError: (msg: string) => void): Promise<void> {
  const d = (window as unknown as { desktop?: PickDesktop }).desktop;
  if (!d?.openFileDialog) { onError('Opening files needs the desktop build.'); return; }
  try {
    const f = await d.openFileDialog({ filters: LAYER_FILE_FILTERS });
    if (f?.path) await openFileLayer(f.path);
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
  }
}

/** The meshes and feature layers as rows of the scene (the trajectories
 *  have their own rows in LayersPanel). */
export function FileLayerRows({ Row }: {
  Row: (p: { swatch: string; title: string; sub: string; visible: boolean; onToggle: () => void; onRemove?: () => void }) => JSX.Element;
}) {
  const s = useSurveyStore();
  return (
    <>
      {s.meshes.map((m) => (
        <Row key={m.id} swatch={m.color} title={m.name} sub="mesh" visible={m.visible}
          onToggle={() => updateMesh(m.path, { visible: !m.visible })} onRemove={() => removeMesh(m.path)} />
      ))}
      {s.features.map((f) => (
        <Row key={f.id} swatch={f.color} title={f.name} sub={KIND_LABEL[f.kind]} visible={f.visible}
          onToggle={() => setLayerVisible(f.path, !f.visible)} onRemove={() => removeFileLayer(f.path)} />
      ))}
    </>
  );
}

const OPEN_KEY = 'pointcloudlabeler-layers-files-open';
/** The kinds listed without "all files": what opens as something. */
const LISTED: ReadonlySet<OutputKind> = new Set<OutputKind>([...LAYER_KINDS, 'cloud', 'qsm']);

function lastPart(folder: string): string {
  return folder.split('/').pop() || folder;
}

/** The project's run outputs, folder by folder. */
export default function ProjectFiles({ datasets, onOpenDataset }: { datasets: OctreeListEntry[]; onOpenDataset: (e: OctreeListEntry) => void }) {
  const project = useOptionalProject()?.project ?? null;
  const s = useSurveyStore();
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch { return true; } });
  const [all, setAll] = useState(false);
  const [files, setFiles] = useState<ProjectFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const folder = project?.folder ?? null;

  const refresh = useCallback(async () => {
    setError(null);
    try { setFiles(await listProjectFiles()); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { if (open && folder) void refresh(); }, [open, folder, refresh]);
  // a run that ends writes new files: list again when the shown layers change too
  useEffect(() => { if (open && folder) void refresh(); }, [open, folder, refresh, s.trajectories.length, s.features.length, s.meshes.length]);

  const toggleOpen = () => setOpen((o) => {
    try { localStorage.setItem(OPEN_KEY, o ? '0' : '1'); } catch { /* storage unavailable */ }
    return !o;
  });

  const groups = useMemo(() => {
    const out: Array<{ folder: string; files: Array<ProjectFile & { kind: OutputKind }>; hidden: number }> = [];
    for (const f of files ?? []) {
      const kind = classifyOutput(f.path);
      let g = out[out.length - 1];
      if (!g || g.folder !== f.folder) { g = { folder: f.folder, files: [], hidden: 0 }; out.push(g); }
      if (all || LISTED.has(kind)) g.files.push({ ...f, kind });
      else g.hidden += 1;
    }
    return out.filter((g) => g.files.length > 0 || all);
  }, [files, all]);

  const datasetOf = (f: ProjectFile) => {
    const want = safeOutputName(f.name).toLowerCase();
    return datasets.find((d) => (d.dir.split(/[\\/]/).pop() ?? '').toLowerCase() === want);
  };

  if (!folder) return null;
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5 mb-1">
        <button onClick={toggleOpen} className="chip" title="The files unpacked into this project (imports/)">
          {open ? '▾' : '▸'} Project files
        </button>
        <span className="flex-1" />
        {open && (
          <>
            <button className="mono text-[9px]" style={{ color: all ? 'var(--accent)' : 'var(--text-mute)' }} onClick={() => setAll((v) => !v)}
              title="Every file the runs wrote, not only clouds and layers">all files</button>
            <button className="mono text-[9px] px-1" style={{ color: 'var(--text-mute)' }} onClick={() => void refresh()} title="List the files again">↻</button>
          </>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-1.5">
          {error && <div className="mono text-[9.5px]" style={{ color: '#e0506b' }}>{error}</div>}
          {files && groups.length === 0 && (
            <div className="mono text-[9.5px] px-1" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
              Nothing unpacked yet: archives opened into this project go into its imports/ folder, and what they hold is listed here.
            </div>
          )}
          {groups.map((g) => (
            <div key={g.folder} className="rounded-md px-1.5 py-1" style={{ border: '1px solid var(--line)' }}>
              <div className="mono text-[9.5px] truncate mb-0.5" style={{ color: 'var(--text-dim)' }} title={g.folder}>{lastPart(g.folder)}</div>
              {g.files.map((f) => (
                <FileRow key={f.path} file={f} dataset={f.kind === 'cloud' ? datasetOf(f) : undefined} shown={layerState(f.path, s)}
                  onOpenDataset={onOpenDataset} onError={setError} />
              ))}
              {g.hidden > 0 && <div className="mono text-[8.5px]" style={{ color: 'var(--text-mute)' }}>+ {g.hidden} other file{g.hidden === 1 ? '' : 's'}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FileRow({ file, dataset, shown, onOpenDataset, onError }: {
  file: ProjectFile & { kind: OutputKind }; dataset: OctreeListEntry | undefined; shown: { shown: boolean; visible: boolean };
  onOpenDataset: (e: OctreeListEntry) => void; onError: (msg: string) => void;
}) {
  const run = (f: () => Promise<unknown>) => void f().catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  const layer = LAYER_KINDS.has(file.kind);
  return (
    <div className="flex items-center gap-1.5 mono text-[9.5px] py-0.5">
      {layer ? (
        <button onClick={() => setLayerVisible(file.path, !shown.visible)} title={shown.visible ? 'Hide' : 'Show over the cloud'}
          style={{ color: shown.visible ? 'var(--accent)' : 'var(--text-mute)', width: 14 }}>
          {shown.visible ? '●' : '○'}
        </button>
      ) : <span style={{ width: 14 }} />}
      <span className="truncate flex-1" style={{ color: 'var(--text)' }} title={file.path}>{file.name}</span>
      <span style={{ color: 'var(--text-mute)' }}>{KIND_LABEL[file.kind]}</span>
      <span style={{ color: 'var(--text-mute)', minWidth: 44, textAlign: 'right' }}>{formatBytes(file.bytes)}</span>
      {file.kind === 'cloud' && (dataset ? (
        <button className="px-1 rounded-sm" style={{ border: '1px solid var(--line)', color: 'var(--text-dim)' }} onClick={() => onOpenDataset(dataset)}
          title="Open the dataset made from it">Open</button>
      ) : (
        <button className="px-1 rounded-sm" style={{ border: '1px solid var(--line)', color: 'var(--text-dim)' }}
          onClick={() => run(() => openFileLayer(file.path))} title="Import into the editor (octree conversion)">Import</button>
      ))}
      {file.kind === 'qsm' && (
        <button className="px-1 rounded-sm" style={{ border: '1px solid var(--line)', color: 'var(--text-dim)' }}
          onClick={() => run(() => openFileLayer(file.path))} title="Show its tubes">Show</button>
      )}
    </div>
  );
}
