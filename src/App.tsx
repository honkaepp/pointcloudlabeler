// Top-level shell — App.tsx is a thin router over the modules (Editor,
// Preprocessing, Inventory, Metrics, Figures) that share one open
// project. Editor-side state (loaded cloud, selection, undo stack, etc.)
// lives entirely inside EditorModule; this file owns only:
//
//   - the currently-open project (lifted into ProjectContext)
//   - the WelcomeScreen + New Project dialog flow that comes before any
//     module is shown
//   - the module tab strip + active-module switching
//   - menu:project-* events from the native menu so opening / closing
//     projects keeps working from the menu regardless of which tab is
//     currently active (the Editor would otherwise be unmounted on
//     Inventory / Metrics and miss the events)
//   - project:changed events emitted by the Rust side after a state
//     change so the UI stays in sync with the backend
//
// Everything heavier — the editor's keybinds, cloud IO, render loop —
// stays inside `<EditorModule/>`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WelcomeScreen from './components/WelcomeScreen';
import NewProjectDialog from './components/NewProjectDialog';
import ModuleTabs, { type ModuleId } from './components/ModuleTabs';
import ErrorBoundary from './components/ErrorBoundary';
import RendererCrashNotice from './components/RendererCrashNotice';
import EditorModule from './modules/EditorModule';
import PreprocessingModule from './modules/PreprocessingModule';
import InventoryModule from './modules/InventoryModule';
import MetricsModule from './modules/MetricsModule';
import FigureModule from './modules/FigureModule';
import DataDoor from './components/DataDoor';
import CompareWindowControls, { secondWindowCommand, useCompareChannel } from './components/CompareWindowControls';
import { PointCloudLabelerLogoMark } from './components/PointCloudLabelerLogo';
import { currentRole } from './state/compareWindow';
import { ProjectProvider } from './context/ProjectContext';
import {
  getCurrent as getCurrentProject,
  openProject,
  closeProject,
  browseForFolder,
  adoptProject,
  checkRename,
  renameProject,
  type ProjectState,
  type RenameOutcome,
} from './persistence/projectStore';
// Rename Project…
import RenameProjectDialog, { renameBlocker, type RenameDraft } from './components/RenameProjectDialog';
import { projectNameProblem, rebasePath, sameFolder } from './persistence/projectName';
import { getEditorSession } from './state/editorSession';
import { rememberReopen } from './persistence/reopenAfterReload';

export default function App() {
  const [project, setProject] = useState<ProjectState | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [welcomeTick, setWelcomeTick] = useState(0);
  const [activeModule, setActiveModule] = useState<ModuleId>('editor');
  // This page may be the second window (commands/compare_window.rs).
  const role = useMemo(() => currentRole(), []);
  useCompareChannel();
  // Rename Project… — App keeps the dialog's state, because the
  // open project closes for the rename and the screen behind it changes.
  const [rename, setRename] = useState<RenameDraft | null>(null);
  const renameRef = useRef(rename);
  renameRef.current = rename;
  const projectRef = useRef(project);
  projectRef.current = project;

  const handleProjectOpenDialog = useCallback(async (folder?: string) => {
    let target = folder;
    if (!target) {
      target = (await browseForFolder('open')) ?? undefined;
      if (!target) return;
    }
    const p = await openProject(target);
    if (!p) throw new Error('Project could not be opened (no response from main process).');
    setProject(p);
    setActiveModule('editor');
  }, []);

  const handleProjectClose = useCallback(async () => {
    await closeProject();
    setProject(null);
    setWelcomeTick(t => t + 1);
    setActiveModule('editor');
  }, []);

  // Fetch initial project state on mount (in case the Rust side already has one).
  useEffect(() => {
    getCurrentProject().then(p => p && setProject(adoptProject(p))).catch(() => { /* ignore */ });
  }, []);

  // Rename Project… — from the project's name in the module strip,
  // Project → Rename Project… and a recent project on the welcome screen.
  const startRename = useCallback((folder: string, current: string) => {
    const p = projectRef.current;
    setRename({ folder, current, draft: current, open: !!p && sameFolder(p.folder, folder), busy: false, error: null });
  }, []);

  // The open project closes (its modules let go of its files), the folder
  // and the name change together, and it opens again under the new name
  // with the cloud the editor had open. A rename that fails opens it again
  // as it was.
  const runRename = useCallback(async () => {
    const r = renameRef.current;
    if (!r || r.busy) return;
    const name = r.draft.trim();
    const problem = projectNameProblem(name) ?? (r.open ? renameBlocker() : null);
    if (problem) { setRename({ ...r, error: problem }); return; }
    setRename({ ...r, busy: true, error: null });
    try {
      // what is in the way shows before the project closes for nothing
      await checkRename(r.folder, name);
      if (r.open) {
        const reopen = getEditorSession().dir;
        await closeProject();
        setProject(null);
        let out: RenameOutcome;
        try {
          out = await renameProject(r.folder, name);
        } catch (e) {
          if (reopen) rememberReopen(reopen);
          setProject(await openProject(r.folder));
          throw e;
        }
        if (reopen) rememberReopen(rebasePath(reopen, r.folder, out.folder) ?? reopen);
        setProject(await openProject(out.folder));
      } else {
        await renameProject(r.folder, name);
        setWelcomeTick(t => t + 1);
      }
      setRename(null);
    } catch (e) {
      setRename(cur => cur && { ...cur, busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  // Listen for project lifecycle events from the native menu / Rust backend.
  // Per-module actions (save, export, undo, …) are owned by each module.
  useEffect(() => {
    const api = (window as unknown as Record<string, unknown>).desktop as {
      onMenuAction?: (cb: (action: string, payload?: unknown) => void) => () => void;
    } | undefined;
    if (!api?.onMenuAction) return;
    const unsub = api.onMenuAction((action, payload) => {
      switch (action) {
        case 'menu:project-new':
          setShowNewProject(true);
          break;
        case 'menu:project-open':
          handleProjectOpenDialog(payload as string | undefined).catch(e =>
            console.warn('project open failed', e));
          break;
        case 'menu:project-close':
          handleProjectClose().catch(e => console.warn('project close failed', e));
          break;
        case 'project:changed':
          // A project found in a renamed or moved folder brings its storage keys along
          setProject(adoptProject((payload as ProjectState | null) ?? null));
          break;
        // Project → Rename Project… (the main window renames)
        case 'menu:project-rename': {
          const p = projectRef.current;
          if (p && role === 'main') startRename(p.folder, p.meta.name);
          break;
        }
        // View → Second Window… — what the ⧉ button in the
        // module tabs runs too; in the second window itself, the two side
        // by side.
        case 'menu:compare-window':
          void secondWindowCommand();
          break;
      }
    });
    return unsub;
  }, [handleProjectOpenDialog, handleProjectClose, startRename, role]);

  const ctxValue = useMemo(() => ({ project, setProject, activeModule }), [project, activeModule]);

  // One door for data — drops, File → Open Data…, the Open data
  // buttons — with or without a project (components/DataDoor.tsx).
  const door = <DataDoor project={project} onProject={setProject} onModule={setActiveModule} />;

  // The Rename Project dialog, over whichever screen is showing.
  const renameDialog = rename && (
    <RenameProjectDialog
      rename={rename}
      onDraft={(draft) => setRename(cur => cur && { ...cur, draft, error: null })}
      onSubmit={() => void runRename()}
      onClose={() => setRename(cur => (cur?.busy ? cur : null))}
    />
  );

  // The second window — the editor alone, under a strip that
  // links it to the first, in the project the first has open.
  if (role === 'compare') {
    return (
      <ProjectProvider value={ctxValue}>
        <div className="w-screen h-screen relative select-none">
          <RendererCrashNotice />
          <div className="absolute top-0 left-0 right-0 z-40 flex items-center gap-2 px-3 hairline-b"
            style={{ height: 52, background: 'rgba(8, 14, 11, 0.92)' }}>
            <PointCloudLabelerLogoMark size={18} />
            <span className="text-[12.5px] font-medium tracking-wide" style={{ color: 'var(--text)' }}>Second window</span>
            <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>{project?.meta.name ?? 'no project open'}</span>
            <div className="flex-1" />
            <CompareWindowControls compact={false} />
          </div>
          {project ? (
            <ErrorBoundary label="Editor"><EditorModule /></ErrorBoundary>
          ) : (
            <div className="absolute left-0 right-0 bottom-0 flex items-center justify-center mono text-[12px]"
              style={{ top: 52, color: 'var(--text-mute)', background: 'var(--viewport-bg)' }}>
              Open a project in the editor window first.
            </div>
          )}
          {door}
        </div>
      </ProjectProvider>
    );
  }

  // No project open → welcome / new-project dialog instead of any module.
  if (!project) {
    return (
      <ProjectProvider value={ctxValue}>
        <RendererCrashNotice />
        {rename?.busy && rename.open ? (
          // The open project between its two names
          <div className="absolute inset-0 flex items-center justify-center mono text-[12px]" style={{ background: '#0a110d', color: 'var(--text-mute)' }}>
            Renaming the project…
          </div>
        ) : (
          <WelcomeScreen
            refreshTick={welcomeTick}
            onNew={() => setShowNewProject(true)}
            onOpen={() => handleProjectOpenDialog()}
            onOpenRecent={(folder) => handleProjectOpenDialog(folder)}
            onRename={(r) => startRename(r.folder, r.name)}
          />
        )}
        {showNewProject && (
          <NewProjectDialog
            onClose={() => setShowNewProject(false)}
            onCreated={(p) => { setProject(p); setShowNewProject(false); setActiveModule('editor'); }}
          />
        )}
        {door}
        {renameDialog}
      </ProjectProvider>
    );
  }

  // Modules mount once and stay mounted; we just toggle visibility to keep
  // their state (loaded cloud, dataset list, computed metrics) intact when
  // the user flips between tabs.
  return (
    <ProjectProvider value={ctxValue}>
      <div className="w-screen h-screen relative select-none">
        <RendererCrashNotice />
        <ModuleTabs active={activeModule} onChange={setActiveModule}
          project={project} onRenameProject={() => startRename(project.folder, project.meta.name)} />
        <div style={{ display: activeModule === 'editor' ? 'block' : 'none' }}>
          <ErrorBoundary label="Editor"><EditorModule /></ErrorBoundary>
        </div>
        <div style={{ display: activeModule === 'preprocessing' ? 'block' : 'none' }}>
          <ErrorBoundary label="Preprocessing"><PreprocessingModule /></ErrorBoundary>
        </div>
        <div style={{ display: activeModule === 'inventory' ? 'block' : 'none' }}>
          <ErrorBoundary label="Inventory"><InventoryModule /></ErrorBoundary>
        </div>
        <div style={{ display: activeModule === 'metrics' ? 'block' : 'none' }}>
          <ErrorBoundary label="Metrics"><MetricsModule /></ErrorBoundary>
        </div>
        {/* Mounted like the others and kept mounted: the module's whole
            workflow is "take a frame, go and edit, come back and take
            the second", so its folder, its settings and the frame it is
            holding must survive a tab switch. Its offscreen canvas is a
            third consumer of the streaming budget the two Compare panes
            already split — it exists only while a frame is being taken,
            which is why keeping the module alive costs nothing. */}
        <div style={{ display: activeModule === 'figures' ? 'block' : 'none' }}>
          <ErrorBoundary label="Figures"><FigureModule /></ErrorBoundary>
        </div>
        {/* Project → New Project… is on the menu while a project is open
            too; the dialog used to render only on the welcome screen, so
            the click set a flag nothing showed. */}
        {showNewProject && (
          <NewProjectDialog
            onClose={() => setShowNewProject(false)}
            onCreated={(p) => { setProject(p); setShowNewProject(false); setActiveModule('editor'); }}
          />
        )}
        {door}
        {renameDialog}
      </div>
    </ProjectProvider>
  );
}
