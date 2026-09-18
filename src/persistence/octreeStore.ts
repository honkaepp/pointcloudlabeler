// Front-end facade for the out-of-core LAZ → octree converter.
//
// The heavy lifting runs in Rust (src-tauri/src/commands/octree.rs) — the
// `las` crate streams the source file from disk so >2 GB compressed
// clouds decode without ever sitting in memory whole. This module just
// hands the call off to that command and surfaces progress events.
//
// The output is one directory per converted cloud:
//   <projectFolder>/octrees/<safeName>/{metadata.json, hierarchy.bin, octree.bin}
// — see octree.rs for the format spec. The runtime reader + LOD renderer
// that streams nodes on demand lives in octreeReader.ts + OctreeView.tsx.

/** Result returned by the Rust converter. Mirrors OctreeImportResult in
 *  octree.rs (camelCased through serde). */
export interface OctreeImportResult {
  outDir: string;
  pointCount: number;
  tileCount: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  scale: [number, number, number];
  offset: [number, number, number];
  rootSpacing: number;
  maxDepth: number;
  durationMs: number;
  /** Observed tree_id range when a tree_id source column was mapped, so
   *  the status bar can surface "tree_id: 5017..8020" as a sanity check.
   *  A surprisingly narrow range (e.g. 0..255) is the fingerprint of a
   *  too-small source type — the original writer packed wider ids into
   *  u8 / u16 and saturated them. Undefined when no tree_id was mapped. */
  treeIdRange?: [number, number];
}

export interface OctreeImportOptions {
  /** Source LAZ/LAS path (native filesystem path, not a File object). */
  srcPath: string;
  /** Target directory the converter writes into. Will be created if it
   *  doesn't exist; existing files inside are overwritten. */
  outDir: string;
  /** Human-readable name stored in metadata.json. */
  name: string;
  /** Acquisition mode (§9.4) — stored in metadata.json so plugins keep
   *  their applicability filters after conversion. */
  scannerType: 'TLS' | 'MLS' | 'ULS' | 'ALS' | 'other';
  /** Spacing of the root LOD level in metres, halving at every deeper
   *  level. Pass 0 to auto-derive it from the cloud cube in Rust
   *  (recommended — keeps the LOD pyramid scale-appropriate). A
   *  positive value is honoured as a manual override. */
  rootSpacing: number;
  /** Hard cap on subdivision depth. The Rust side clamps to a safe
   *  internal maximum, so anything reasonable (12–16) works. */
  maxDepth: number;
  /** Optional name of a LAS Extra-Bytes dimension whose value should be
   *  imported as tree_id (e.g. "instance_pred" for ForestSemantic
   *  pipelines). Empty / undefined ⇒ tree_id starts at 0 and gets
   *  assigned interactively in the editor. */
  treeIdExtraName?: string;
  /** Optional name of a LAS Extra-Bytes dimension whose value should be
   *  imported as the per-point semantic label (1 = stem, 2 = branch,
   *  others ignored). Empty / undefined ⇒ semantic starts unlabelled. */
  semanticExtraName?: string;
  /** Optional source columns to seed the standing / laying deadwood id
   *  channels. Empty / undefined ⇒ those channels are still created but
   *  start all-zero (the editor labels them). */
  standingDeadwoodExtraName?: string;
  layingDeadwoodExtraName?: string;
  /** Names of LAS Extra-Bytes dimensions to carry into the octree as
   *  numeric (f32) extras — surfaced as colour-by options in the
   *  Display panel after conversion (one entry per name in
   *  metadata.extras). Omit / empty for the legacy compact layout. */
  extraNames?: string[];
  /** When false the two reserved deadwood id channels (standing + laying)
   *  are NOT created on import — 8 bytes/point saved, noticeable on big
   *  TLS clouds. They can be added later in-app via the Segment panel's
   *  "Enable deadwood labelling" affordance. Missing / true keeps the
   *  legacy behaviour (channels always created). */
  includeDeadwood?: boolean;
}

type DesktopApi = {
  cloudImportOctree?: (args: OctreeImportOptions) => Promise<unknown>;
  onOctreeProgress?: (cb: (e: { stage: string; pct: number }) => void) => Promise<() => void>;
};

function getApi(): DesktopApi | null {
  const api = (window as unknown as { desktop?: DesktopApi }).desktop;
  return api?.cloudImportOctree ? api : null;
}

export function octreeImportAvailable(): boolean {
  return getApi() !== null;
}

/** Subscribe to converter progress events. The Rust side emits stages
 *  `open` (0) → `bin` (0–0.55) → `build` (0.55–0.9) → `write`
 *  (0.9–1.0) → `done` (1.0). Returns an unsubscribe function. */
export async function onOctreeProgress(cb: (stage: string, pct: number) => void): Promise<() => void> {
  const api = getApi();
  if (!api?.onOctreeProgress) return () => { /* noop */ };
  const unlisten = await api.onOctreeProgress(({ stage, pct }) => cb(stage, pct));
  return unlisten;
}


/** Sanitise a filename into a path-safe directory name. The converter
 *  output goes under <project>/octrees/<safeName>/. */
export function safeOutputName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

/** Run the converter end-to-end. The caller subscribes via
 *  onOctreeProgress() if it wants progress updates. */
export async function importLazAsOctree(opts: OctreeImportOptions): Promise<OctreeImportResult> {
  const api = getApi();
  if (!api?.cloudImportOctree) {
    throw new Error('Octree import is only available in the desktop build.');
  }
  const res = await api.cloudImportOctree(opts) as OctreeImportResult;
  return res;
}
