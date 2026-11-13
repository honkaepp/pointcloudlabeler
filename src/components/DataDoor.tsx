// The one door data comes in by (see io/dataOpen.ts).
//
// Mounted by App in every state, with or without a project, so that a file
// dropped on the welcome screen, on the editor or on any other module — or
// opened with File → Open Data… or an "Open data" button — goes where it
// belongs:
//
//   a point cloud           → the editor's import (several: one after another)
//   a .zip of clouds        → unpacked into the project's imports folder, then as above
//   a PTX                   → the Data tab's PTX importer
//   a project               → opened
//   other data files        → layers over the cloud: a trajectory (_traj.txt),
//                             scan positions, targets, stems (CSV), a region
//                             (GeoJSON, shapefile), voxels, a mesh, a QSM
//                             (layers/fileLayers.ts; the project keeps them)
//
// With no project open, the project is made first: the New Project dialog
// comes up named after the data and placed where the last one was, and the
// data goes on once it exists.

import { useCallback, useEffect, useRef, useState } from 'react';
import NewProjectDialog from './NewProjectDialog';
import NoticeStack from './NoticeStack';
import type { ModuleId } from './ModuleTabs';
import { openProject, type ProjectState } from '../persistence/projectStore';
import {
  OPENABLE_SUMMARY, focusDataHub, onOpenDataRequest, parentDir, pickData, plainPath, planOpen, projectNameFor, stemOf,
  type DataEntry, type DataPlan,
} from '../io/dataOpen';
import { pushNotice, updateNotice, dismissNotice } from '../state/notices';
import { setJob } from '../state/jobs';
import { joinPath, onEditorImportRequest, requestEditorImport, safeName } from '../state/editorImport';
import { openFileLayer, useProjectFileLayers } from './shell/fileLayerActions';
import { LAYER_KINDS, classifyOutput } from '../layers/fileLayers';

interface Props {
  project: ProjectState | null;
  onProject: (p: ProjectState) => void;
  onModule: (m: ModuleId) => void;
}

interface DoorDesktop {
  onDataDrop?: (cb: (entries: unknown) => void) => Promise<() => void>;
  onDataDrag?: (cb: (over: boolean) => void) => () => void;
  onDataProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void>;
  dataExtract?: (archive: string, dest: string, only: string[]) => Promise<unknown>;
  octreeCancel?: (stage: string) => Promise<boolean>;
  onMenuAction?: (cb: (action: string, payload?: unknown) => void) => () => void;
}

function desktop(): DoorDesktop | undefined {
  return (window as unknown as { desktop?: DoorDesktop }).desktop;
}

const LAST_PARENT_KEY = 'pointcloudlabeler-last-project-parent';

/** Where the last project was made (NewProjectDialog remembers it), for the next one. */
function lastProjectParent(): string {
  try { return plainPath(localStorage.getItem(LAST_PARENT_KEY) ?? ''); } catch { return ''; }
}

/** The entry a new project is named after. */
function namingEntry(plan: DataPlan): DataEntry | null {
  switch (plan.action) {
    case 'ptx': case 'extract': return plan.entry;
    case 'importClouds': return plan.entries[0] ?? null;
    default: return null;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
}

export default function DataDoor({ project, onProject, onModule }: Props) {
  const projectRef = useRef(project);
  projectRef.current = project;
  const [dragOver, setDragOver] = useState(false);
  const [forData, setForData] = useState<{ plan: DataPlan; entry: DataEntry } | null>(null);
  // the layers the open project showed come back, and what is shown is kept
  useProjectFileLayers(project?.folder ?? null);

  const noteIgnored = (ignored: string[]) => {
    if (ignored.length === 0) return;
    const shown = ignored.slice(0, 6).join(', ') + (ignored.length > 6 ? `, … (${ignored.length - 6} more)` : '');
    pushNotice({ kind: 'warn', title: 'Opened one thing at a time', text: `Not opened: ${shown}. Open them after this one.` });
  };

  const route = useCallback(async (plan: DataPlan, folder: string): Promise<void> => {
    switch (plan.action) {
      case 'ptx':
        onModule('preprocessing');
        focusDataHub('ptx');
        pushNotice({ kind: 'info', title: `${plan.entry.name}`, text: 'A structured PTX — import it with the PTX panel’s Import (its scan positions are kept for co-registration).' });
        break;
      case 'importClouds':
        onModule('editor');
        for (const e of plan.entries) await requestEditorImport(e.path);
        if (plan.entries.length > 1) pushNotice({ kind: 'info', title: `${plan.entries.length} point clouds`, text: 'Imported one after another; each asks its import options.' });
        break;
      case 'extract': {
        const d = desktop();
        if (!d?.dataExtract) {
          pushNotice({ kind: 'err', title: 'Archives need the desktop build' });
          break;
        }
        const dest = joinPath(joinPath(folder, 'imports'), safeName(stemOf(plan.entry.name)));
        const id = pushNotice({ kind: 'info', title: `Unpacking ${plan.entry.name}`, text: `into ${dest}`, progress: 0, action: { label: 'Stop', run: () => void d.octreeCancel?.('data-extract') } });
        let unlisten: (() => void) | null = null;
        try {
          const label = `Unpacking ${plan.entry.name}`;
          setJob('data-extract', { label, stage: 'starting', pct: 0, module: 'preprocessing' });
          unlisten = (await d.onDataProgress?.((e) => {
            updateNotice(id, { progress: e.pct, text: e.stage });
            setJob('data-extract', { label, stage: e.stage, pct: e.pct, module: 'preprocessing' });
          })) ?? null;
          const entries = await d.dataExtract(plan.entry.path, dest, plan.only) as DataEntry[];
          dismissNotice(id);
          await route(planOpen(entries), folder);
        } catch (e) {
          dismissNotice(id);
          const msg = errText(e);
          pushNotice({ kind: msg.startsWith('Stopped') ? 'info' : 'err', title: msg.startsWith('Stopped') ? 'Unpacking stopped' : `Could not unpack ${plan.entry.name}`, text: msg });
        } finally {
          unlisten?.();
          setJob('data-extract', null);
        }
        break;
      }
      default:
        break;
    }
    noteIgnored(plan.ignored);
  }, [onModule]);

  const handle = useCallback(async (all: DataEntry[]) => {
    setDragOver(false);
    // a trajectory, scan positions, stems, region, mesh or QSM: a layer, not a cloud to import
    const isLayer = (e: DataEntry) => !e.isDir && (LAYER_KINDS.has(classifyOutput(e.path)) || classifyOutput(e.path) === 'qsm');
    const layers = all.filter(isLayer);
    if (layers.length > 0) {
      onModule('editor');
      for (const e of layers) {
        try { await openFileLayer(e.path); } catch (err) { pushNotice({ kind: 'err', title: `Could not open ${e.name}`, text: errText(err) }); }
      }
      pushNotice({ kind: 'info', title: layers.length === 1 ? `${layers[0].name} is a layer` : `${layers.length} files are layers`, text: 'Shown over the cloud; Layers lists them, to hide or remove.' });
    }
    const entries = all.filter((e) => !isLayer(e));
    if (entries.length === 0) return;
    const plan = planOpen(entries);
    if (plan.action === 'nothing') {
      pushNotice({
        kind: 'warn',
        title: 'Nothing here PointCloudLabeler opens',
        text: `${plan.ignored.slice(0, 6).join(', ') || 'The folder is empty'}.\nIt opens: ${OPENABLE_SUMMARY.map(([k, v]) => `${k} (${v})`).join('; ')}.`,
      });
      return;
    }
    if (plan.action === 'openProject') {
      try {
        const p = await openProject(plan.folder);
        if (p) { onProject(p); onModule('editor'); }
      } catch (e) {
        pushNotice({ kind: 'err', title: 'Could not open the project', text: errText(e) });
      }
      noteIgnored(plan.ignored);
      return;
    }
    const folder = projectRef.current?.folder;
    const entry = namingEntry(plan);
    if (!folder && entry) { setForData({ plan, entry }); return; }
    if (folder) await route(plan, folder);
  }, [onProject, onModule, route]);

  // A drop (granted and classified by the Rust side), an open request from a
  // button, and File → Open Data….
  useEffect(() => {
    const d = desktop();
    let unlistenDrop: (() => void) | null = null;
    let alive = true;
    void d?.onDataDrop?.((v) => { if (Array.isArray(v)) void handle(v as DataEntry[]); }).then((u) => { if (alive) unlistenDrop = u; else u(); });
    const offDrag = d?.onDataDrag?.(setDragOver);
    const offOpen = onOpenDataRequest((entries) => void handle(entries));
    const offMenu = d?.onMenuAction?.((action) => { if (action === 'menu:open-data') void pickData('file'); });
    return () => { alive = false; unlistenDrop?.(); offDrag?.(); offOpen(); offMenu?.(); };
  }, [handle]);

  // What is handed to the editor's import: show the editor.
  useEffect(() => onEditorImportRequest(() => onModule('editor')), [onModule]);

  return (
    <>
      {dragOver && <DropOverlay hasProject={!!project} />}
      {forData && (
        <NewProjectDialog
          initialName={projectNameFor(forData.entry)}
          initialParent={lastProjectParent() || parentDir(forData.entry.path)}
          purpose={`For ${forData.entry.name}`}
          onClose={() => setForData(null)}
          onCreated={(p) => {
            const plan = forData.plan;
            setForData(null);
            onProject(p);
            void route(plan, p.folder);
          }}
        />
      )}
      <NoticeStack />
    </>
  );
}

function DropOverlay({ hasProject }: { hasProject: boolean }) {
  return (
    <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 90, pointerEvents: 'none', background: 'rgba(6,10,8,0.55)', backdropFilter: 'blur(3px)' }}>
      <div className="rounded-xl px-8 py-6 flex flex-col items-center gap-3"
        style={{ border: '2px dashed color-mix(in oklch, var(--accent) 70%, transparent)', background: 'rgba(10,17,13,0.92)', minWidth: 420 }}>
        <div className="text-[16px] font-semibold" style={{ color: 'var(--accent)' }}>Drop to open</div>
        <div className="flex flex-col gap-1">
          {OPENABLE_SUMMARY.map(([k, v]) => (
            <div key={k} className="mono text-[11px] flex gap-3">
              <span style={{ color: 'var(--text)', width: 150 }}>{k}</span>
              <span style={{ color: 'var(--text-mute)' }}>{v}</span>
            </div>
          ))}
        </div>
        {!hasProject && <div className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>A project is made for it first — named after the data.</div>}
      </div>
    </div>
  );
}
