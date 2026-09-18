// The figure specification — what a figure was made of, written beside
// it, and enough to make it again.
//
// This is the part that matters six months from now, when a reviewer
// asks for a change and the plot has been re-segmented since: the author
// loads `fig3.json`, presses run, and gets the same figure from the
// current data. Without it the figures rot the moment anything upstream
// changes, and a reviewer cannot check how any of them was made — which
// is the thing that cannot be checked today.

export const FIGURE_SPEC_FORMAT = 'pointcloudlabeler-figure-spec';
export const FIGURE_SPEC_VERSION = 1;

export type Background = 'white' | 'dark';
export type FigureColorMode = 'tree_id' | 'semantic';
/** What happens to points the transfer did not label. Both states are
 *  needed on one dataset: a side elevation must HIDE them because they
 *  occlude the stems behind them, while an oblique view must SHOW them
 *  because they are what proves which points the transfer did and did
 *  not reach. 'grey' is the shown state — the name is historical; the
 *  colour they are shown in is `unclassifiedColor`, grey by default. */
export type Unclassified = 'hidden' | 'grey';

/** The colour unclassified points are drawn in unless the figure says
 *  otherwise — the viewer's own neutral grey, so a figure and the screen
 *  agree by default. Pinned to DEFAULT_DISPLAY.unlabeledColor by test. */
export const DEFAULT_UNCLASSIFIED_COLOR = '#787878';

export interface CameraSpec {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
}

export interface ViewportPart {
  kind: 'viewport';
  /** File name this part writes, without a directory. */
  file: string;
  datasetDir: string;
  datasetName: string;
  width: number;
  height: number;
  background: Background;
  colorMode: FigureColorMode;
  unclassified: Unclassified;
  /** The colour the unclassified points are drawn in when shown, as
   *  #rrggbb. Grey is the usual choice, but grey on a white page can be
   *  too quiet for what the figure is about, and black or a dark tone
   *  reads better in print. */
  unclassifiedColor: string;
  camera: CameraSpec;
  /** One tree id and nothing else, with the unclassified points inside
   *  its bounding box padded by `isolateMargin` metres. Null draws the
   *  whole plot. */
  isolateTreeId: number | null;
  isolateMargin: number;
  /** Point size in OUTPUT pixels. A 1 px splat that reads correctly on
   *  screen disappears at 2400 px, so this is never inherited from the
   *  screen. */
  pointSize: number;
  scaleBar: boolean;
}

export interface PanelPart {
  kind: 'panel';
  file: string;
  panel: 'qc' | 'tree-review';
  datasetDir: string;
  datasetName: string;
  /** CSS px the panel is laid out at — the lever that sets printed type
   *  size. */
  layoutWidth: number;
  /** The render's device pixel ratio — the lever that sets dpi. */
  dpr: number;
  rowCount: number;
  sort: 'severity' | 'tree';
  hiddenCodes: string[];
  severities: string[];
  background: Background;
}

export type FigurePart = ViewportPart | PanelPart;

export interface ComposeSpec {
  rows: number;
  cols: number;
  gutter: number;
  margin: number;
  /** Applied to every viewport cell, in source pixels. Null crops none. */
  crop: { x: number; y: number; width: number; height: number } | null;
  printedWidthCm: number;
  file: string;
}

export interface FigureSpec {
  format: typeof FIGURE_SPEC_FORMAT;
  version: number;
  /** The figure's name, e.g. "fig2". */
  name: string;
  title: string;
  parts: FigurePart[];
  compose: ComposeSpec | null;
}

/** What a run actually produced, recorded beside the images. Everything
 *  a caption or a reviewer would ask: which datasets and how many points
 *  each, the camera, the colouring, the layout width and DPR, the sort
 *  and filters, the row count, the world extent of the frame, the
 *  application version and commit, and when. */
export interface FigureSidecar {
  format: typeof FIGURE_SPEC_FORMAT;
  version: number;
  name: string;
  title: string;
  appVersion: string;
  commit: string;
  exportedAt: string;
  spec: FigureSpec;
  results: PartResult[];
  composed?: {
    file: string;
    width: number;
    height: number;
    printedWidthCm: number;
    dpi: number;
    dpiOk: boolean;
    resampled: boolean;
  };
}

export interface PartResult {
  file: string;
  kind: 'viewport' | 'panel';
  width: number;
  height: number;
  /** Viewport: points actually rendered, and whether the streamer had
   *  everything the view needed before the frame was taken. */
  pointsRendered?: number;
  settled?: boolean;
  /** Viewport: the world-space width and height of the rendered frame,
   *  in metres, so a caption can state the plot extent without
   *  measuring by hand. */
  worldWidthM?: number;
  worldHeightM?: number;
  /** Panel: the rows drawn and the smallest type's printed size. */
  rows?: number;
  smallestPrintedPt?: number;
}

/** A figure's own sub-folder name and its files' prefix. Stable, so a
 *  re-run overwrites its own outputs rather than piling up. */
export function figureFileName(name: string, part: string, ext: string): string {
  return `${name}_${part}.${ext}`;
}

/** The world width and height a perspective camera sees at the distance
 *  of its target — the frame's extent, for the caption. */
export function frameExtent(cam: CameraSpec, aspect: number): { widthM: number; heightM: number } {
  const dx = cam.position[0] - cam.target[0];
  const dy = cam.position[1] - cam.target[1];
  const dz = cam.position[2] - cam.target[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const heightM = 2 * dist * Math.tan((cam.fov * Math.PI) / 180 / 2);
  return { heightM, widthM: heightM * aspect };
}

export function serializeSpec(spec: FigureSpec): string {
  return JSON.stringify(spec, null, 2);
}

/** Parse a saved specification, refusing anything that is not one —
 *  a re-run against a file the application did not write would fail
 *  somewhere deeper and less clearly. */
export function parseSpec(text: string): FigureSpec {
  const v = JSON.parse(text) as Partial<FigureSpec>;
  if (v.format !== FIGURE_SPEC_FORMAT) throw new Error('not a PointCloudLabeler figure specification');
  if (typeof v.version !== 'number' || v.version > FIGURE_SPEC_VERSION) {
    throw new Error(`figure specification version ${String(v.version)} is newer than this build understands`);
  }
  if (!Array.isArray(v.parts) || v.parts.length === 0) throw new Error('the specification has no parts');
  if (typeof v.name !== 'string' || v.name === '') throw new Error('the specification has no name');
  return {
    format: FIGURE_SPEC_FORMAT,
    version: v.version,
    name: v.name,
    title: typeof v.title === 'string' ? v.title : v.name,
    // A specification an earlier build wrote has no unclassified colour:
    // it drew them grey, so that is what it says.
    parts: (v.parts as FigurePart[]).map((p) => (
      p.kind === 'viewport' && !isHexColor(p.unclassifiedColor)
        ? { ...p, unclassifiedColor: DEFAULT_UNCLASSIFIED_COLOR }
        : p
    )),
    compose: (v.compose ?? null) as ComposeSpec | null,
  };
}

/** A #rrggbb colour and nothing else — what a colour input yields and
 *  what the renderer's hex parser reads. */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

export function serializeSidecar(s: FigureSidecar): string {
  return JSON.stringify(s, null, 2);
}
