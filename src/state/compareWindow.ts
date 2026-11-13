// The second window (src-tauri/src/commands/compare_window.rs)
// as the renderer sees it: which window this page is, whether its partner
// is open, how the two are linked, and whether the open dataset is
// read-only here because the other window holds it.
//
// The link is three settings both windows share:
//
//   camera 'off'    each window has its own camera
//          'orbit'  turning and zooming in one turns and zooms the other
//                   about ITS OWN target — two trees side by side, each
//                   centred in its window, seen from the same direction
//                   and distance
//          'world'  the same camera in world coordinates — two epochs or
//                   two processings of the same place, overlaid
//   colors          a colour mode chosen in one is chosen in the other
//
// The pages talk by one broadcast event ('pointcloudlabeler-compare', each
// message naming its sender, so a page ignores its own). Everything here
// apart from the store is pure and tested; the bridge
// (persistence/desktopBridge.ts) does the sending, CompareSync.tsx the
// camera.

import { useSyncExternalStore } from 'react';
import type { ColorMode } from '../components/shell/OctreeShellContext';

export type Vec3 = [number, number, number];

export type WindowRole = 'main' | 'compare';
export type CameraLink = 'off' | 'orbit' | 'world';

export interface CompareLink {
  camera: CameraLink;
  colors: boolean;
}

export const DEFAULT_LINK: CompareLink = { camera: 'orbit', colors: true };

/** A camera in scene coordinates (viewToolsStore's CameraPose). */
export interface ScenePose { position: Vec3; target: Vec3 }

export type CompareMessage =
  | { kind: 'hello'; from: string }
  | { kind: 'bye'; from: string }
  | { kind: 'link'; from: string; link: CompareLink }
  | { kind: 'pose'; from: string; world: ScenePose }
  | { kind: 'color'; from: string; colorMode: ColorMode };

/** A message as a page sends it: the bridge adds `from`. */
export type OutgoingCompareMessage = CompareMessage extends infer M ? (M extends { from: string } ? Omit<M, 'from'> : never) : never;

export const COMPARE_EVENT = 'pointcloudlabeler-compare';
export const COMPARE_LABEL = 'compare';
export const MAIN_LABEL = 'main';

// ---- Which window this is ---------------------------------------------

/** The page's role from its query string (`?window=compare`). */
export function windowRole(search: string): WindowRole {
  return new URLSearchParams(search).get('window') === 'compare' ? 'compare' : 'main';
}

/** The dataset the second window was opened with (`&dataset=…`). */
export function initialDataset(search: string): string | null {
  const d = new URLSearchParams(search).get('dataset');
  return d && d.trim() !== '' ? d : null;
}

export function currentRole(): WindowRole {
  return typeof window === 'undefined' ? 'main' : windowRole(window.location.search);
}

// ---- Camera ------------------------------------------------------------

// Scene axes are (east, up, −north) about the dataset's offset
// (io/sceneAxes.ts). Spelled out here for whole poses and for vectors.

export function sceneToWorldPoint(p: Vec3, offset: Vec3): Vec3 {
  return [p[0] + offset[0], offset[1] - p[2], p[1] + offset[2]];
}

export function worldToScenePoint(p: Vec3, offset: Vec3): Vec3 {
  return [p[0] - offset[0], p[2] - offset[2], offset[1] - p[1]];
}

export function poseToWorld(p: ScenePose, offset: Vec3): ScenePose {
  return { position: sceneToWorldPoint(p.position, offset), target: sceneToWorldPoint(p.target, offset) };
}

/** Where this window's camera goes for a pose the other window sent (in
 *  world coordinates): the same pose in 'world' mode; in 'orbit' mode
 *  the sender's view direction and distance, about this window's own
 *  target. Null when the link is off. */
export function followPose(link: CameraLink, remoteWorld: ScenePose, own: ScenePose, offset: Vec3): ScenePose | null {
  if (link === 'off') return null;
  if (link === 'world') {
    return { position: worldToScenePoint(remoteWorld.position, offset), target: worldToScenePoint(remoteWorld.target, offset) };
  }
  // The world vector target → camera, turned into scene axes (a vector:
  // no offset).
  const e = remoteWorld.position[0] - remoteWorld.target[0];
  const n = remoteWorld.position[1] - remoteWorld.target[1];
  const u = remoteWorld.position[2] - remoteWorld.target[2];
  const t = own.target;
  return { position: [t[0] + e, t[1] + u, t[2] - n], target: [t[0], t[1], t[2]] };
}

/** Two poses the same to within `eps` metres — a camera that has not
 *  moved, or the pose just taken from the other window. */
export function posesClose(a: ScenePose, b: ScenePose, eps = 1e-6): boolean {
  for (let i = 0; i < 3; i++) {
    if (Math.abs(a.position[i] - b.position[i]) > eps) return false;
    if (Math.abs(a.target[i] - b.target[i]) > eps) return false;
  }
  return true;
}

// ---- Read-only datasets --------------------------------------------------

/** One spelling per folder, as the backend's claims use (case and
 *  separators folded, no trailing separator). */
export function dirKey(dir: string): string {
  let s = dir.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s.toLowerCase();
}

/** Commands that change a dataset in place or write its sidecars. With
 *  the dataset open in the other window too, these are refused here:
 *  two pages writing one dataset each overwrite the other's work. */
const WRITES = /^(octree_(write_|bake_|set_|classify_|reset_|segment_|remove_|add_|clear_|shift_|transform_|forest_save_|layer_delete|layer_prepare|leaf_wood|fit_stems|skeleton_alignment_clear)|file_write|survey_save|survey_dxf|survey_mesh)/;

export const READ_ONLY_MESSAGE = 'This dataset is open in the other window, so it is read-only here. Make changes in the window that opened it first.';

/** Would `cmd` with these arguments write into one of the read-only
 *  datasets? Any string argument (or the x-path header a byte write
 *  carries) naming the folder or a path inside it counts. */
export function blocksWrite(
  cmd: string, args: unknown, headers: Record<string, string> | undefined, readOnlyKeys: ReadonlySet<string>,
): boolean {
  if (readOnlyKeys.size === 0 || !WRITES.test(cmd)) return false;
  const paths: string[] = [];
  if (args && typeof args === 'object' && !(args instanceof ArrayBuffer) && !ArrayBuffer.isView(args)) {
    for (const v of Object.values(args as Record<string, unknown>)) if (typeof v === 'string') paths.push(v);
  }
  const xp = headers?.['x-path'];
  if (xp) { try { paths.push(decodeURIComponent(xp)); } catch { paths.push(xp); } }
  for (const p of paths) {
    const k = dirKey(p);
    for (const ro of readOnlyKeys) if (k === ro || k.startsWith(`${ro}/`)) return true;
  }
  return false;
}

// ---- The store -----------------------------------------------------------

export interface CompareState {
  role: WindowRole;
  /** The partner window is open (always true in the second window). */
  otherOpen: boolean;
  link: CompareLink;
  /** The open dataset is held by the other window. */
  readOnly: { dir: string; holder: string } | null;
}

const LINK_KEY = 'pointcloudlabeler-compare-link';

function loadLink(): CompareLink {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LINK_KEY) : null;
    if (raw) {
      const o = JSON.parse(raw) as Partial<CompareLink>;
      return {
        camera: o.camera === 'off' || o.camera === 'world' || o.camera === 'orbit' ? o.camera : DEFAULT_LINK.camera,
        colors: typeof o.colors === 'boolean' ? o.colors : DEFAULT_LINK.colors,
      };
    }
  } catch { /* storage unavailable */ }
  return DEFAULT_LINK;
}

let state: CompareState = {
  role: currentRole(),
  otherOpen: currentRole() === 'compare',
  link: loadLink(),
  readOnly: null,
};
const listeners = new Set<() => void>();

export function getCompare(): CompareState {
  return state;
}

export function setCompare(patch: Partial<CompareState>): void {
  state = { ...state, ...patch };
  if (patch.link) {
    try { localStorage.setItem(LINK_KEY, JSON.stringify(state.link)); } catch { /* storage unavailable */ }
  }
  for (const l of listeners) l();
}

export function subscribeCompare(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useCompare(): CompareState {
  return useSyncExternalStore(subscribeCompare, getCompare, getCompare);
}
