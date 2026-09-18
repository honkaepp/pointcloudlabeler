// Top-level Project context. Per the post-Phase-7 architecture, the only
// state every module (Editor / Inventory / Metrics) shares is which
// project is open. Each module then reads its own data straight from disk
// — Inventory + Metrics list the project's octrees and run native
// commands against the chosen dataset; the Editor owns its viewer state.
// No more cross-module CloudEntry plumbing or save-tick coordination.

import { createContext, useContext } from 'react';
import type { ProjectState } from '../persistence/projectStore';

export interface ProjectContextValue {
  project: ProjectState | null;
  setProject: (p: ProjectState | null) => void;
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
