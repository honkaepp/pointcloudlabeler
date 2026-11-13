// The Views & video panel's state and timing (ViewToolsPanel.tsx
// draws it, three/ViewTools.tsx applies it inside the viewer):
//
//   X-ray       the cloud drawn additively without depth: dense structure
//               (stems, walls, the ground's edge) shines through the canopy
//   fly-through camera keyframes, played along a smooth curve
//   slice       a slab moved through the cloud (the Filters' plane slab)
//   time lapse  datasets of the same place shown one after another
//
// Any of the three animations can be recorded as a video of the viewer's
// canvas (MP4 where the web view can encode it, else WebM).

import { useSyncExternalStore } from 'react';
import * as THREE from 'three';

export type Vec3 = [number, number, number];

export interface CameraPose { position: Vec3; target: Vec3 }

/** What the viewer registers so the panel can read and move the camera. */
export interface ViewerHandles {
  getPose: () => CameraPose;
  setPose: (p: CameraPose) => void;
  canvas: HTMLCanvasElement;
}

export type AnimationKind = 'fly' | 'slice' | 'timelapse';

export interface ViewToolsState {
  dir: string | null;
  xray: boolean;
  /** 0.01 … 0.5: how much one point adds. */
  xrayStrength: number;
  keyframes: CameraPose[];
  flySeconds: string;
  loop: boolean;
  /** height: horizontal slices bottom to top; east / north: vertical slices moving that way;
   *  bearing: vertical slices moving toward a compass bearing. */
  slice: { axis: 'height' | 'east' | 'north' | 'bearing'; bearingDeg: string; thickness: string; seconds: string };
  timelapse: { dirs: string[]; secondsEach: string };
  record: boolean;
  /** The dataset's saved views. */
  savedViews: SavedView[];
  playing: AnimationKind | null;
  /** 0 … 1 of the running animation. */
  progress: number;
  note: string | null;
  error: string | null;
}

export function initialViewTools(): ViewToolsState {
  return {
    dir: null,
    xray: false,
    xrayStrength: 0.12,
    keyframes: [],
    flySeconds: '12',
    loop: false,
    slice: { axis: 'height', bearingDeg: '0', thickness: '0.5', seconds: '15' },
    timelapse: { dirs: [], secondsEach: '3' },
    record: false,
    savedViews: [],
    playing: null,
    progress: 0,
    note: null,
    error: null,
  };
}

let state: ViewToolsState = initialViewTools();
let handles: ViewerHandles | null = null;
const listeners = new Set<() => void>();

export function getViewTools(): ViewToolsState {
  return state;
}

export function setViewTools(patch: Partial<ViewToolsState> | ((s: ViewToolsState) => Partial<ViewToolsState>)): void {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  for (const l of listeners) l();
}

export function resetViewTools(): void {
  state = initialViewTools();
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

export function useViewTools(): ViewToolsState {
  return useSyncExternalStore(subscribe, getViewTools, getViewTools);
}

/** The viewer registers itself while it is mounted. */
export function registerViewer(h: ViewerHandles | null): void {
  handles = h;
}

export function viewer(): ViewerHandles | null {
  return handles;
}

/** Keyframes and the time lapse belong to one dataset's scene. */
export function bindViewDataset(dir: string | null): void {
  if (state.dir !== dir) setViewTools({ dir, keyframes: [], playing: null, progress: 0, note: null, error: null, savedViews: loadSavedViews(dir) });
}

// ---------------------------------------------------------------------------
// Saved views — named camera positions of one dataset, with the
// projection, kept between sessions (this machine's storage).

export interface SavedView extends CameraPose {
  name: string;
  projection: 'perspective' | 'ortho';
}

const VIEWS_KEY = 'pointcloudlabeler-views:';

export function loadSavedViews(dir: string | null): SavedView[] {
  if (!dir) return [];
  try {
    const v = JSON.parse(localStorage.getItem(VIEWS_KEY + dir) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is SavedView => !!x && typeof (x as SavedView).name === 'string'
      && Array.isArray((x as SavedView).position) && Array.isArray((x as SavedView).target)) : [];
  } catch { return []; }
}

function storeViews(views: SavedView[]): void {
  setViewTools({ savedViews: views });
  if (!state.dir) return;
  try { localStorage.setItem(VIEWS_KEY + state.dir, JSON.stringify(views)); } catch { /* storage unavailable */ }
}

/** The next free "View n" name. */
export function nextViewName(views: SavedView[]): string {
  let n = views.length + 1;
  while (views.some((v) => v.name === `View ${n}`)) n++;
  return `View ${n}`;
}

/** Save the camera as it is now under `name` (replacing one of that name). */
export function saveView(name: string, projection: 'perspective' | 'ortho'): SavedView | null {
  const h = handles;
  if (!h) return null;
  const view: SavedView = { ...h.getPose(), name: name.trim() || nextViewName(state.savedViews), projection };
  storeViews([...state.savedViews.filter((v) => v.name !== view.name), view]);
  return view;
}

export function deleteView(name: string): void {
  storeViews(state.savedViews.filter((v) => v.name !== name));
}

export function renameView(name: string, to: string): void {
  const t = to.trim();
  if (!t || state.savedViews.some((v) => v.name === t)) return;
  storeViews(state.savedViews.map((v) => (v.name === name ? { ...v, name: t } : v)));
}

// ---------------------------------------------------------------------------
// the fly-through

/** The camera at `u` (0 … 1) along the keyframes: a centripetal
 *  Catmull-Rom curve through the positions and one through the targets,
 *  so the camera passes every keyframe and turns smoothly between them. */
export function poseAt(keys: CameraPose[], u: number): CameraPose | null {
  if (keys.length === 0) return null;
  if (keys.length === 1) return keys[0];
  const t = Math.min(1, Math.max(0, u));
  const curve = (pts: Vec3[]) => new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
  const p = curve(keys.map((k) => k.position)).getPoint(t);
  const q = curve(keys.map((k) => k.target)).getPoint(t);
  return { position: [p.x, p.y, p.z], target: [q.x, q.y, q.z] };
}

// ---------------------------------------------------------------------------
// the slice

/** The slab in world coordinates (the Filters panel's plane slab) at `u`:
 *  its anchor runs across the dataset's extent along the normal. */
export function slabAt(
  axis: ViewToolsState['slice']['axis'], bearingDeg: number, thickness: number,
  min: Vec3, max: Vec3, u: number,
): { anchor: Vec3; normal: Vec3; halfHeight: number } {
  const t = Math.min(1, Math.max(0, u));
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  let normal: Vec3;
  if (axis === 'height') normal = [0, 0, 1];
  else if (axis === 'east') normal = [1, 0, 0];
  else if (axis === 'north') normal = [0, 1, 0];
  else {
    const b = (bearingDeg * Math.PI) / 180;
    normal = [Math.sin(b), Math.cos(b), 0];
  }
  // the extent of the box along the normal, from the centre
  const half = 0.5 * (Math.abs(normal[0]) * (max[0] - min[0]) + Math.abs(normal[1]) * (max[1] - min[1]) + Math.abs(normal[2]) * (max[2] - min[2]));
  const d = -half + t * 2 * half;
  return {
    anchor: [centre[0] + normal[0] * d, centre[1] + normal[1] * d, centre[2] + normal[2] * d],
    normal,
    halfHeight: Math.max(thickness / 2, 0.001),
  };
}

// ---------------------------------------------------------------------------
// the time lapse

/** Which dataset of the lapse shows at `u`. */
export function lapseIndex(count: number, u: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.floor(Math.min(1, Math.max(0, u)) * count));
}

// ---------------------------------------------------------------------------
// recording

/** The best video type the web view can record: MP4 (H.264) when it can,
 *  else WebM (VP9, VP8). */
export function videoType(isSupported: (t: string) => boolean): { mime: string; ext: 'mp4' | 'webm' } | null {
  for (const [mime, ext] of [
    ['video/mp4;codecs=avc1', 'mp4'], ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9', 'webm'], ['video/webm;codecs=vp8', 'webm'], ['video/webm', 'webm'],
  ] as const) {
    if (isSupported(mime)) return { mime, ext };
  }
  return null;
}

export interface Recording { stop: () => Promise<Blob>; ext: 'mp4' | 'webm' }

/** Records the canvas until `stop`; 30 frames a second, 12 Mbit/s. */
export function startRecording(canvas: HTMLCanvasElement): Recording {
  const MR = (globalThis as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
  if (!MR || !canvas.captureStream) throw new Error('This web view cannot record video.');
  const type = videoType((t) => MR.isTypeSupported(t));
  if (!type) throw new Error('No video format to record in.');
  const stream = canvas.captureStream(30);
  const rec = new MR(stream, { mimeType: type.mime, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  rec.start(500);
  return {
    ext: type.ext,
    stop: () => new Promise<Blob>((resolve) => {
      rec.onstop = () => {
        for (const t of stream.getTracks()) t.stop();
        resolve(new Blob(chunks, { type: type.mime.split(';')[0] }));
      };
      rec.stop();
    }),
  };
}

// ---------------------------------------------------------------------------
// X-ray on a material

const XRAY_KEY = 'pointcloudlabelerXray';

/** Puts a point material into X-ray (additive, `strength` per point, no
 *  depth) or back as it was. Returns whether anything changed. */
export function applyXray(m: THREE.Material, on: boolean, strength: number): boolean {
  const saved = m.userData[XRAY_KEY] as { blending: THREE.Blending; transparent: boolean; depthTest: boolean; depthWrite: boolean } | undefined;
  if (on) {
    if (!saved) {
      m.userData[XRAY_KEY] = { blending: m.blending, transparent: m.transparent, depthTest: m.depthTest, depthWrite: m.depthWrite };
    }
    const k = Math.min(1, Math.max(0.005, strength));
    if (saved && m.blendColor.r === k) return false;
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation;
    m.blendSrc = THREE.ConstantColorFactor;
    m.blendDst = THREE.OneFactor;
    m.blendColor.setRGB(k, k, k);
    m.transparent = true;
    m.depthTest = false;
    m.depthWrite = false;
    m.needsUpdate = true;
    return true;
  }
  if (!saved) return false;
  m.blending = saved.blending;
  m.transparent = saved.transparent;
  m.depthTest = saved.depthTest;
  m.depthWrite = saved.depthWrite;
  delete m.userData[XRAY_KEY];
  m.needsUpdate = true;
  return true;
}

// ---------------------------------------------------------------------------
// the palette

let mounted = 0;

export function viewToolsPanelMounted(): () => void {
  mounted += 1;
  return () => { mounted -= 1; };
}

export interface ViewPaletteCommand { id: string; group?: string; title: string; keywords?: string; run: () => void }

export function viewToolsPaletteCommands(togglePanel: () => void): ViewPaletteCommand[] {
  const open = () => { if (mounted === 0) togglePanel(); };
  return [
    { id: 'view.xray', group: 'View', title: 'X-ray view on / off', keywords: 'xray transparent additive see through', run: () => setViewTools((s) => ({ xray: !s.xray })) },
    { id: 'view.video', group: 'View', title: 'Views & video: fly-through, slice, time lapse…', keywords: 'animation video record flythrough movie keyframes', run: open },
    { id: 'panel.viewtools', group: 'Panels', title: 'Toggle Views & video panel', run: togglePanel },
  ];
}
