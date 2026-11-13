// Preprocessing module — sensor-native preprocessing that happens BEFORE
// a cloud lands in the Editor.
//
// Importers: E57 (every major TLS / MLS vendor exports it), PTX / PTS
// and XYZ / ASCII. Which edition this is, and everything that follows
// from it, is decided in src/build/edition.ts and nowhere else.
//
// Future home for other sensor-side preprocessing (ULS trajectories,
// FARO SCENE…) — anything that gates the raw scanner data into
// editor-ready point clouds. The Editor module continues to own
// post-import work (segmentation, deadwood, metrics, exports).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useProject } from '../context/ProjectContext';
import E57ProjectPanel, { type E57ProjectSummary } from '../components/preprocessing/E57ProjectPanel';
import PtxProjectPanel, { type PtxProjectSummary } from '../components/preprocessing/PtxProjectPanel';
import XyzProjectPanel, { type XyzProjectSummary } from '../components/preprocessing/XyzProjectPanel';
import CoregisterPanel from '../components/preprocessing/CoregisterPanel';
import ProjectCrs from '../components/preprocessing/ProjectCrs';
import { pickData, useDataHubFocus } from '../io/dataOpen';
import { EDITION, preprocessingSources } from '../build/edition';

export default function PreprocessingModule() {
  const { project } = useProject();
  const [e57Projects, setE57Projects] = useState<E57ProjectSummary[]>([]);
  const [ptxProjects, setPtxProjects] = useState<PtxProjectSummary[]>([]);
  const [xyzProjects, setXyzProjects] = useState<XyzProjectSummary[]>([]);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err' | 'info'; msg: string } | null>(null);

  // Re-list whenever the active project changes — registrations for each
  // importer live under <projectFolder>/preprocessing/<kind>/ so they're
  // project-local. The lists are independent (each importer has its own
  // folder), so a failure on one doesn't blank the others.
  const refresh = useCallback(async () => {
    if (!project?.folder) {
      setE57Projects([]); setPtxProjects([]); setXyzProjects([]); return;
    }
    const api = (window as unknown as Record<string, unknown>).desktop as {
      e57ListProjects?: (projectFolder: string) => Promise<E57ProjectSummary[]>;
      ptxListProjects?: (projectFolder: string) => Promise<PtxProjectSummary[]>;
      xyzListProjects?: (projectFolder: string) => Promise<XyzProjectSummary[]>;
    } | undefined;
    if (api?.e57ListProjects) {
      try { setE57Projects(await api.e57ListProjects(project.folder)); }
      catch (e) { console.warn('e57_list_projects failed', e); setE57Projects([]); }
    } else {
      setE57Projects([]);
    }
    if (api?.ptxListProjects) {
      try { setPtxProjects(await api.ptxListProjects(project.folder)); }
      catch (e) { console.warn('ptx_list_projects failed', e); setPtxProjects([]); }
    } else {
      setPtxProjects([]);
    }
    if (api?.xyzListProjects) {
      try { setXyzProjects(await api.xyzListProjects(project.folder)); }
      catch (e) { console.warn('xyz_list_projects failed', e); setXyzProjects([]); }
    } else {
      setXyzProjects([]);
    }
  }, [project?.folder]);
  useEffect(() => { void refresh(); }, [refresh]);
  // The data door sent a PTX here — bring its panel into view.
  const hubFocus = useDataHubFocus();
  const ptxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hubFocus.target === 'ptx') setTimeout(() => ptxRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }, [hubFocus]);

  if (!project) {
    return (
      <div className="absolute left-0 right-0 bottom-0 flex items-center justify-center mono text-[12px]"
           style={{ top: 52, color: 'var(--text-mute)', background: 'var(--viewport-bg)' }}>
        Open a project, or open data from the welcome screen: a project is made for it.
      </div>
    );
  }

  return (
    <div className="absolute left-0 right-0 bottom-0 flex flex-col" style={{ top: 52, background: '#0a110d' }}>
      <div className="px-5 py-3 hairline-b flex items-center gap-3" style={{ background: 'var(--wash-1)' }}>
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px]" style={{ color: 'var(--text)' }}>Data</div>
          <div className="mono text-[10.5px]" style={{ color: 'var(--text-mute)' }}>
            Sensor-native data into editor-ready point clouds — {preprocessingSources(EDITION).join(', ')}.
          </div>
          <div className="mt-1"><ProjectCrs /></div>
        </div>
        {/* the one door (a drop anywhere does the same) */}
        <div className="flex gap-1.5 shrink-0">
          <button className="btn btn-primary !h-8 !px-3 mono text-[11px]" onClick={() => void pickData('file')}
            title="A point cloud, a .zip of clouds or a PTX — or drop it anywhere">
            Open data…
          </button>
          <button className="btn !h-8 !px-3 mono text-[11px]" onClick={() => void pickData('folder')}
            title="A folder of point clouds or a project">
            Folder…
          </button>
        </div>
        {status && (
          // Bounded and wrapping. A long error in this box used to take
          // the whole header width and squeeze the title beside it to
          // one word per line.
          <div className="mono text-[11px] px-2.5 py-1 rounded-md min-w-0"
               style={{
                 flex: '0 1 60%', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.45,
                 color: status.kind === 'err' ? '#ffb4be' : status.kind === 'ok' ? 'var(--accent)' : 'var(--text-dim)',
                 background: status.kind === 'err' ? 'rgba(224,80,107,0.10)' : 'var(--wash-2)',
                 border: `1px solid ${status.kind === 'err' ? 'color-mix(in oklch, var(--danger, #e0506b) 45%, transparent)' : 'var(--line)'}`,
               }}>
            {status.msg}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scroll-thin p-5">
        <div className="max-w-[1100px] mx-auto flex flex-col gap-5">

          <E57ProjectPanel
            projects={e57Projects}
            onChange={refresh}
            onStatus={setStatus}
          />

          <div ref={ptxRef} style={{ scrollMarginTop: 12 }}>
            <PtxProjectPanel
              projects={ptxProjects}
              onChange={refresh}
              onStatus={setStatus}
            />
          </div>

          <XyzProjectPanel
            projects={xyzProjects}
            onChange={refresh}
            onStatus={setStatus}
          />

          <CoregisterPanel onStatus={setStatus} />

        </div>
      </div>
    </div>
  );
}
