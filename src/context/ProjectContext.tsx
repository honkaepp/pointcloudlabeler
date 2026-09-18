// Top-level Project context. Per the post-Phase-7 architecture, the state
// every module (Editor / Inventory / Metrics / Figures) shares is which
// project is open and which module is showing. Each module then reads its
// own data straight from disk — Inventory + Metrics list the project's
// octrees and run native commands against the chosen dataset; the Editor
// owns its viewer state. No more cross-module CloudEntry plumbing or
// save-tick coordination.
//
// Why the active module is here: every module stays mounted behind the
// tabs, so a module that lists the project's datasets only when the
// project changes keeps the list it took at that moment. Open a new
// project, import a cloud in the Editor, switch to Inventory: the list
// taken when the project was empty still said "No datasets in this
// project yet". A module that reads `activeModule` can take the list
// again each time it is shown.

import { createContext, useContext } from 'react';
import type { ProjectState } from '../persistence/projectStore';
import type { ModuleId } from '../components/ModuleTabs';

export interface ProjectContextValue {
  project: ProjectState | null;
  setProject: (p: ProjectState | null) => void;
  /** The module whose tab is showing. */
  activeModule: ModuleId;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export const ProjectProvider = ProjectContext.Provider;

export function useProject(): ProjectContextValue {
  const v = useContext(ProjectContext);
  if (!v) {
    throw new Error('useProject() called outside of ProjectProvider — wrap the tree in <ProjectProvider value={…}>.');
  }
  return v;
}
