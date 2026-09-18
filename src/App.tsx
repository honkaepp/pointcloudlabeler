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

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import { ProjectProvider } from './context/ProjectContext';
import {
  getCurrent as getCurrentProject,
  openProject,
  closeProject,
  browseForFolder,
  type ProjectState,
} from './persistence/projectStore';

export default function App() {
  const [project, setProject] = useState<ProjectState | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);
  const [welcomeTick, setWelcomeTick] = useState(0);
  const [activeModule, setActiveModule] = useState<ModuleId>('editor');

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
    getCurrentProject().then(p => p && setProject(p)).catch(() => { /* ignore */ });
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
          setProject((payload as ProjectState | null) ?? null);
          break;
      }
    });
    return unsub;
  }, [handleProjectOpenDialog, handleProjectClose]);

  const ctxValue = useMemo(() => ({ project, setProject }), [project]);

  // No project open → welcome / new-project dialog instead of any module.
  if (!project) {
    return (
      <ProjectProvider value={ctxValue}>
        <RendererCrashNotice />
        <WelcomeScreen
          refreshTick={welcomeTick}
          onNew={() => setShowNewProject(true)}
          onOpen={() => handleProjectOpenDialog()}
          onOpenRecent={(folder) => handleProjectOpenDialog(folder)}
        />
        {showNewProject && (
          <NewProjectDialog
            onClose={() => setShowNewProject(false)}
            onCreated={(p) => { setProject(p); setShowNewProject(false); setActiveModule('editor'); }}
          />
        )}
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
        <ModuleTabs active={activeModule} onChange={setActiveModule} />
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
      </div>
    </ProjectProvider>
  );
}
