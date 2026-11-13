// A data file opened as what it is (layers/fileLayers.ts says
// which): a cloud into the editor's import, a trajectory, mesh or feature file
// as a layer over the cloud, a QSM as tubes. The layers a project showed come
// back when it is opened again (the files inside its folder; per project, in
// this browser's storage).

import { useEffect, useRef } from 'react';
import { FEATURE_KINDS, KIND_LABEL, classifyOutput, type FeatureKind, type OutputKind } from '../../layers/fileLayers';
import {
  addFeature, addMesh, addTrajectory, getSurveyState, removeFeature, removeMesh, removeTrajectory, setSurveyState,
  updateFeature, updateMesh, updateTrajectory, useSurveyStore, type SurveyState,
} from './surveyStore';
import { requestEditorImport } from '../../state/editorImport';
import { importQsmFile } from './qsmFiles';

/** commands/outputs.rs ProjectFile. */
export interface ProjectFile { path: string; folder: string; name: string; bytes: number; modified: number }

interface LayerDesktop {
  projectFiles?: () => Promise<ProjectFile[]>;
  statFile?: (path: string) => Promise<unknown>;
}

function desktop(): LayerDesktop | undefined {
  return (window as unknown as { desktop?: LayerDesktop }).desktop;
}

/** The open project's run outputs (empty without a project or a desktop). */
export async function listProjectFiles(): Promise<ProjectFile[]> {
  const d = desktop();
  if (!d?.projectFiles) return [];
  return d.projectFiles();
}

/** The layer kinds a store keeps. */
export type ShownKind = 'trajectory' | 'mesh' | FeatureKind;

/** Is `path` shown as a layer now (and visible)? */
export function layerState(path: string, s: SurveyState = getSurveyState()): { shown: boolean; visible: boolean } {
  const hit = s.trajectories.find((t) => t.path === path) ?? s.meshes.find((m) => m.path === path) ?? s.features.find((f) => f.path === path);
  return { shown: !!hit, visible: !!hit?.visible };
}

/** Open `path` as what it is; what it was opened as. A cloud goes to the
 *  editor's import (`scannerType` from the run that wrote it). */
export async function openFileLayer(path: string, opts: { scannerType?: 'MLS' | 'TLS' } = {}): Promise<OutputKind> {
  const kind = classifyOutput(path);
  if (kind === 'trajectory') addTrajectory(path);
  else if (kind === 'mesh') addMesh(path);
  else if (FEATURE_KINDS.has(kind)) addFeature(path, kind as FeatureKind);
  else if (kind === 'qsm') await importQsmFile(path);
  else if (kind === 'cloud') await requestEditorImport(path, opts.scannerType ? { scannerType: opts.scannerType } : undefined);
  else throw new Error(`${path.split(/[\\/]/).pop()}: a ${KIND_LABEL[kind]} is not shown as a layer`);
  return kind;
}

/** Show or hide a file that is a layer. */
export function setLayerVisible(path: string, visible: boolean): void {
  const s = getSurveyState();
  if (s.trajectories.some((t) => t.path === path)) updateTrajectory(path, { visible });
  else if (s.meshes.some((m) => m.path === path)) updateMesh(path, { visible });
  else if (s.features.some((f) => f.path === path)) updateFeature(path, { visible });
  else if (visible) void openFileLayer(path).catch((e: unknown) => setSurveyState({ error: e instanceof Error ? e.message : String(e) }));
}

/** Take a file's layer off the view. */
export function removeFileLayer(path: string): void {
  removeTrajectory(path);
  removeMesh(path);
  removeFeature(path);
}

// ---------------------------------------------------------------------------
// the layers of a project, kept between sessions

interface SavedLayer { path: string; kind: ShownKind; visible: boolean }

const KEY_PREFIX = 'pointcloudlabeler-file-layers:';

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** `path` is inside `folder` (the only files a reopened project may read). */
export function insideFolder(path: string, folder: string): boolean {
  const f = norm(folder);
  return !!f && norm(path).startsWith(`${f}/`);
}

/** The layers of the store to keep for `folder`: files inside it. */
export function layersToSave(s: SurveyState, folder: string): SavedLayer[] {
  const out: SavedLayer[] = [];
  for (const t of s.trajectories) if (insideFolder(t.path, folder)) out.push({ path: t.path, kind: 'trajectory', visible: t.visible });
  for (const m of s.meshes) if (insideFolder(m.path, folder)) out.push({ path: m.path, kind: 'mesh', visible: m.visible });
  for (const f of s.features) if (insideFolder(f.path, folder)) out.push({ path: f.path, kind: f.kind, visible: f.visible });
  return out;
}

function readSaved(folder: string): SavedLayer[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY_PREFIX + norm(folder)) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as SavedLayer[]).filter((l) => typeof l?.path === 'string' && insideFolder(l.path, folder)) : [];
  } catch { return []; }
}

function writeSaved(folder: string, layers: SavedLayer[]): void {
  try { localStorage.setItem(KEY_PREFIX + norm(folder), JSON.stringify(layers)); } catch { /* storage unavailable */ }
}

/** Mounted once (DataDoor): a project opened shows the layers it showed —
 *  those of another project go — and what is shown is kept for it. */
export function useProjectFileLayers(folder: string | null): void {
  const s = useSurveyStore();
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    restoredFor.current = null;
    if (!folder) return;
    let alive = true;
    void (async () => {
      // the layers of the project before go
      const cur = getSurveyState();
      setSurveyState({
        trajectories: cur.trajectories.filter((t) => insideFolder(t.path, folder)),
        meshes: cur.meshes.filter((m) => insideFolder(m.path, folder)),
        features: cur.features.filter((f) => insideFolder(f.path, folder)),
      });
      const stat = desktop()?.statFile;
      for (const l of readSaved(folder)) {
        if (!alive) return;
        if (layerState(l.path).shown) continue;
        // a file removed since is let go
        try { if (stat) await stat(l.path); } catch { continue; }
        if (l.kind === 'trajectory') addTrajectory(l.path);
        else if (l.kind === 'mesh') addMesh(l.path);
        else addFeature(l.path, l.kind);
        if (!l.visible) setLayerVisible(l.path, false);
      }
      if (alive) restoredFor.current = folder;
    })();
    return () => { alive = false; };
  }, [folder]);
  useEffect(() => {
    if (!folder || restoredFor.current !== folder) return;
    writeSaved(folder, layersToSave(s, folder));
  }, [folder, s.trajectories, s.meshes, s.features]);
}
