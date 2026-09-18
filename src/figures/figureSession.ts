// What the Figures module remembers.
//
// The workflow it exists for is "take a frame, go to the Editor and
// change something, come back and take the second" — so everything it
// holds has to survive leaving the module, and the frame it is holding
// has to survive leaving the application. The module's own state covers
// the first; this covers the second, and it is also why the folder and
// the settings are not asked for twice.
//
// The held frame's pixels are NOT in here: a 2400 × 1800 PNG is
// megabytes and the browser store is not for that. It is already on
// disk, under a name this records — the module reads it back when it
// needs it.

import { DEFAULT_UNCLASSIFIED_COLOR, isHexColor, type FigurePart, type FigureColorMode, type PartResult, type Unclassified } from './figureSpec';
import type { CameraPose } from '../three/comparePose';
import type { Direction } from './recipes';

/** Mirrored to settings.json by settingsStore — must match the entry in
 *  its PERSISTED_KEYS. */
export const FIGURE_SESSION_KEY = 'tree-seg-figure-session';

/** How a set of clouds is put into one height frame — see the module's
 *  heightFrameFor. */
export type HeightChoice = 'auto' | 'stored' | 'above_ground';

export const HEIGHT_CHOICES: { id: HeightChoice; label: string; hint: string }[] = [
  { id: 'auto', label: 'Matched', hint: 'As stored when the clouds are already in the same height; above ground when one is in elevation and the other normalised.' },
  { id: 'stored', label: 'As stored', hint: 'Whatever z each file carries. Two clouds in different frames will stand hundreds of metres apart.' },
  { id: 'above_ground', label: 'Above ground', hint: 'Every cloud in elevation is drawn at its height above the ground under each point. Needs a ground classification.' },
];

export interface HeldFrame {
  /** The camera the pair's second frame must be taken from. */
  camera: CameraPose;
  zBase: number;
  /** Whether the frame was drawn at heights above the ground. */
  flatten: boolean;
  box: [[number, number, number], [number, number, number]] | null;
  /** The dataset it was taken of. */
  dir: string;
  /** The first frame, as written: enough to read it back and compose. */
  file: string;
  width: number;
  height: number;
  part: FigurePart;
  result: PartResult;
}

export interface FigureSession {
  folder: string;
  name: string;
  dark: boolean;
  width: number;
  height: number;
  pointBudget: number;
  colorMode: FigureColorMode;
  heights: HeightChoice;
  /** The colour unclassified points are drawn in wherever they are
   *  shown, #rrggbb. One choice for the whole module. */
  unclassifiedColor: string;
  frameDir: string;
  direction: Direction;
  unclassified: Unclassified;
  isolate: boolean;
  treeId: number;
  isolateMargin: number;
  sourceDir: string;
  targetDir: string;
  rowA: { direction: Direction; unclassified: Unclassified };
  rowB: { direction: Direction; unclassified: Unclassified } | null;
  /** The comparison's own isolate — one id, cut from both columns. */
  cmpIsolate: boolean;
  cmpTreeId: number;
  cmpIsolateMargin: number;
  /** How far the comparison's cameras stand, as a multiple of the
   *  fitted distance: 1 fills the frame, 2 stands twice as far. */
  cmpDistance: number;
  panelDir: string;
  rowCount: number;
  layoutWidth: number;
  dpr: number;
  panelPrintedCm: number;
  hiddenCodes: string[];
  cols: number;
  gutter: number;
  margin: number;
  composedCm: number;
  crop: { x: number; y: number; width: number; height: number } | null;
  /** The first frame of a pair, waiting for its second. */
  held: HeldFrame | null;
}

export const DEFAULT_SESSION: FigureSession = {
  folder: '', name: 'figure', dark: false,
  width: 2400, height: 1800, pointBudget: 24_000_000, colorMode: 'tree_id', heights: 'auto',
  unclassifiedColor: DEFAULT_UNCLASSIFIED_COLOR,
  frameDir: '', direction: { azimuth: 135, elevation: 25 }, unclassified: 'grey',
  isolate: false, treeId: 1, isolateMargin: 1,
  sourceDir: '', targetDir: '',
  rowA: { direction: { azimuth: 180, elevation: 0 }, unclassified: 'hidden' },
  rowB: { direction: { azimuth: 135, elevation: 25 }, unclassified: 'grey' },
  cmpIsolate: false, cmpTreeId: 1, cmpIsolateMargin: 1, cmpDistance: 1,
  panelDir: '', rowCount: 6, layoutWidth: 480, dpr: 4, panelPrintedCm: 8,
  hiddenCodes: ['qsm-coverage', 'qsm-completeness', 'qsm-volume', 'no-dbh'],
  cols: 2, gutter: 70, margin: 40, composedCm: 16, crop: null,
  held: null,
};

/** Merge what was stored over the defaults, field by field, so a
 *  session written by an older build — or a corrupt one — still opens.
 *  A setting that cannot be read is a setting at its default, never a
 *  module that will not mount. */
export function mergeSession(raw: unknown): FigureSession {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SESSION };
  const v = raw as Partial<FigureSession>;
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  const str = (x: unknown, d: string) => (typeof x === 'string' ? x : d);
  const dir = (x: unknown, d: Direction): Direction => (
    x && typeof x === 'object'
      ? { azimuth: num((x as Direction).azimuth, d.azimuth), elevation: num((x as Direction).elevation, d.elevation) }
      : d
  );
  const unc = (x: unknown, d: Unclassified): Unclassified => (x === 'hidden' || x === 'grey' ? x : d);
  const row = (x: unknown, d: { direction: Direction; unclassified: Unclassified }) => (
    x && typeof x === 'object'
      ? { direction: dir((x as typeof d).direction, d.direction), unclassified: unc((x as typeof d).unclassified, d.unclassified) }
      : d
  );
  return {
    folder: str(v.folder, DEFAULT_SESSION.folder),
    name: str(v.name, DEFAULT_SESSION.name),
    dark: typeof v.dark === 'boolean' ? v.dark : DEFAULT_SESSION.dark,
    width: num(v.width, DEFAULT_SESSION.width),
    height: num(v.height, DEFAULT_SESSION.height),
    pointBudget: num(v.pointBudget, DEFAULT_SESSION.pointBudget),
    colorMode: v.colorMode === 'semantic' ? 'semantic' : 'tree_id',
    heights: v.heights === 'stored' || v.heights === 'above_ground' ? v.heights : 'auto',
    unclassifiedColor: isHexColor(v.unclassifiedColor) ? v.unclassifiedColor : DEFAULT_UNCLASSIFIED_COLOR,
    frameDir: str(v.frameDir, ''),
    direction: dir(v.direction, DEFAULT_SESSION.direction),
    unclassified: unc(v.unclassified, DEFAULT_SESSION.unclassified),
    isolate: typeof v.isolate === 'boolean' ? v.isolate : false,
    treeId: num(v.treeId, DEFAULT_SESSION.treeId),
    isolateMargin: num(v.isolateMargin, DEFAULT_SESSION.isolateMargin),
    sourceDir: str(v.sourceDir, ''),
    targetDir: str(v.targetDir, ''),
    rowA: row(v.rowA, DEFAULT_SESSION.rowA),
    rowB: v.rowB === null ? null : row(v.rowB, DEFAULT_SESSION.rowB!),
    cmpIsolate: typeof v.cmpIsolate === 'boolean' ? v.cmpIsolate : false,
    cmpTreeId: num(v.cmpTreeId, DEFAULT_SESSION.cmpTreeId),
    cmpIsolateMargin: num(v.cmpIsolateMargin, DEFAULT_SESSION.cmpIsolateMargin),
    // A distance of zero or less would put the camera in the subject.
    cmpDistance: num(v.cmpDistance, DEFAULT_SESSION.cmpDistance) > 0 ? num(v.cmpDistance, DEFAULT_SESSION.cmpDistance) : DEFAULT_SESSION.cmpDistance,
    panelDir: str(v.panelDir, ''),
    rowCount: num(v.rowCount, DEFAULT_SESSION.rowCount),
    layoutWidth: num(v.layoutWidth, DEFAULT_SESSION.layoutWidth),
    dpr: num(v.dpr, DEFAULT_SESSION.dpr),
    panelPrintedCm: num(v.panelPrintedCm, DEFAULT_SESSION.panelPrintedCm),
    hiddenCodes: Array.isArray(v.hiddenCodes) ? v.hiddenCodes.filter((c) => typeof c === 'string') : DEFAULT_SESSION.hiddenCodes,
    cols: num(v.cols, DEFAULT_SESSION.cols),
    gutter: num(v.gutter, DEFAULT_SESSION.gutter),
    margin: num(v.margin, DEFAULT_SESSION.margin),
    composedCm: num(v.composedCm, DEFAULT_SESSION.composedCm),
    crop: v.crop && typeof v.crop === 'object' ? v.crop : null,
    held: isHeld(v.held) ? v.held : null,
  };
}

function isHeld(h: unknown): h is HeldFrame {
  if (!h || typeof h !== 'object') return false;
  const v = h as Partial<HeldFrame>;
  return typeof v.file === 'string' && v.file !== ''
    && typeof v.dir === 'string' && typeof v.flatten === 'boolean'
    && typeof v.width === 'number' && typeof v.height === 'number'
    && !!v.camera && Array.isArray(v.camera.position) && Array.isArray(v.camera.target);
}

/** The store to read and write. A parameter so the round trip can be
 *  tested without a browser — the tests run in node, where there is no
 *  localStorage at all and an untested round trip would be exactly the
 *  part that silently stops working. */
export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStore(): SessionStore | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function readSessionFrom(store: SessionStore | null): FigureSession {
  if (!store) return { ...DEFAULT_SESSION };
  try { return mergeSession(JSON.parse(store.getItem(FIGURE_SESSION_KEY) ?? 'null')); }
  catch { return { ...DEFAULT_SESSION }; }
}

export function writeSessionTo(store: SessionStore | null, s: FigureSession): void {
  if (!store) return;
  try { store.setItem(FIGURE_SESSION_KEY, JSON.stringify(s)); }
  catch { /* the module keeps it in memory either way */ }
}

export function readSession(): FigureSession {
  return readSessionFrom(browserStore());
}

export function writeSession(s: FigureSession): void {
  writeSessionTo(browserStore(), s);
}
