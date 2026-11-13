// Long jobs (the editor's octree
// conversion, unpacking an archive), for the job indicator in the module
// strip (components/JobsIndicator.tsx).

import { useSyncExternalStore } from 'react';

export interface AppJob {
  id: string;
  label: string;
  stage: string;
  /** 0–100, or null when unknown. */
  pct: number | null;
  /** The module that shows it. */
  module: 'editor' | 'preprocessing';
}

let jobs: AppJob[] = [];
const listeners = new Set<() => void>();

/** Set (or with null, clear) a job by its id. */
export function setJob(id: string, job: Omit<AppJob, 'id'> | null): void {
  const rest = jobs.filter((j) => j.id !== id);
  jobs = job ? [...rest, { ...job, id }] : rest;
  for (const l of listeners) l();
}

export function getJobs(): AppJob[] {
  return jobs;
}

export function useJobs(): AppJob[] {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    getJobs,
    getJobs,
  );
}

/** When the window is not in front, say so in its title (the taskbar shows
 *  it) until it is focused again. */
export function callAttention(text: string): void {
  if (typeof document === 'undefined' || document.hasFocus()) return;
  const original = document.title.replace(/^● [^—]* — /, '');
  document.title = `● ${text} — ${original}`;
  window.addEventListener('focus', () => { document.title = original; }, { once: true });
}
