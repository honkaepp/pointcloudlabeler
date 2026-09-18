// Figures module — publication-quality images of what is in the project,
// taken by the application instead of cropped off the screen.
//
// A screen capture fails publication on three counts, and all three are
// arithmetic rather than taste.
//
// RESOLUTION. A side panel renders about 500 CSS px wide. Captured at
// the display's pixel ratio and printed 8 cm wide it is about 160 dpi,
// where journals ask 300 for a photograph or a rendering and 500 for
// anything with type on it.
//
// THE RATIO, WHICH ZOOM DOES NOT FIX. Printed type size is the ratio of
// text height to panel width, and page zoom scales both together, so it
// raises dpi and leaves the point size exactly where it was. The only
// other lever is laying the panel out NARROWER than it sits on screen,
// and that is a thing a capture cannot do.
//
// REGISTRATION. A before-and-after pair, or a two-dataset comparison,
// must be the same camera, the same pixel size and the same crop.
// Matching those by eye is luck, costs an hour an image, and cannot be
// repeated when a number changes.
//
// So: panels are laid out here at a width you choose and rasterised at a
// pixel ratio you choose; viewport frames are rendered at their own size
// at the full node budget for the view; cameras are derived from the
// data, held between shots, and written down. Every image gets a
// specification beside it, which can be loaded back and taken again —
// so an image in a document can be traced to the data and the code that
// made it, and remade when either moves. Read-only throughout: nothing
// here writes to octree.bin, patches.bin or any sibling state file.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useProject } from '../context/ProjectContext';
import { listOctrees, type OctreeListEntry, type TreeMetric, type TreeQsm, type TreeSummaryEntry } from '../persistence/octreeReader';
import { loadTreeMetrics } from '../metrics/loadMetrics';
import { DEFAULT_METRIC_PARAMS } from '../metrics/params';
import { computeQcFlags, FLAG_LABEL, type Flag, type FlagCode } from '../metrics/qcFlags';
import { isolateGeomFor } from '../components/shell/treeNeighbourhood';
import { guessFrame } from '../components/shell/heightFrames';
import { type CameraPose, type Vec3 } from '../three/comparePose';
import { findDir } from '../persistence/datasetDirs';
import { useTheme } from '../ui/useTheme';
import FigureCanvas, { type ViewportExport, type ViewportRequest } from '../figures/FigureCanvas';
import { renderQcPanelSvg, selectFlags, checkLegibility, TEXT } from '../figures/panelSvg';
import { svgToPng, composeGrid, rgbaToPngOn, type ComposeInput } from '../figures/render';
import { checkDpi, type CropBox } from '../figures/compose';
import {
  FIGURE_SPEC_FORMAT, FIGURE_SPEC_VERSION, DEFAULT_UNCLASSIFIED_COLOR, figureFileName, frameExtent, parseSpec,
  serializeSidecar, serializeSpec,
  type FigurePart, type FigureSidecar, type FigureSpec, type PartResult, type ViewportPart,
  type Unclassified, type FigureColorMode,
} from '../figures/figureSpec';
import {
  orbitPose, treePose, standOff, unionBox, figurePointSize, compass, directionOf, viewNameOf, VIEWS,
  type Box, type Direction,
} from '../figures/recipes';
import { readSession, writeSession, HEIGHT_CHOICES, type FigureSession, type HeightChoice, type HeldFrame } from '../figures/figureSession';

interface Desktop {
  browseForFolder?: (title?: string) => Promise<string | null>;
  openFileDialog?: (opts?: { filters?: { name: string; extensions: string[] }[] }) => Promise<{ path: string; text?: string } | null>;
  readFile?: (path: string) => Promise<ArrayBuffer>;
  writeFile?: (path: string, content: string) => Promise<boolean>;
  writeFileBytes?: (path: string, bytes: Uint8Array) => Promise<boolean>;
  octreeTreeSummary?: (dir: string) => Promise<TreeSummaryEntry[]>;
  octreeReadQsm?: (dir: string) => Promise<{ trees: TreeQsm[] } | null>;
  octreeGroundReference?: (dir: string, within?: [number, number, number, number]) => Promise<{ z: number; from: string; cells: number }>;
  octreeTreeMetrics?: (dir: string, params: typeof DEFAULT_METRIC_PARAMS) => Promise<TreeMetric[]>;
}

/** Which checks a QC figure starts with hidden. The three QSM-derived
 *  ones and the missing-DBH one: on airborne data those fire on nearly
 *  every tree for scanning-geometry reasons, and a list that flags every
 *  tree cannot tell a reader which tree to open. Every check is a chip,
 *  so this is a starting point rather than a rule. */
const DEFAULT_HIDDEN: FlagCode[] = ['qsm-coverage', 'qsm-completeness', 'qsm-volume', 'no-dbh'];
const ALL_CODES = Object.keys(FLAG_LABEL) as FlagCode[];

type Phase = { text: string; kind: 'info' | 'ok' | 'warn' | 'err' };

/** One image taken this session, kept so it can be composed with the
 *  others without being written and read back. */
interface Shot {
  id: number;
  label: string;
  png: Uint8Array;
  width: number;
  height: number;
  kind: 'viewport' | 'panel';
  part: FigurePart;
  result: PartResult;
  /** Viewport shots take the shared crop; a crop measured on a rendered
   *  view means nothing on a panel. */
  croppable: boolean;
}

let shotSeq = 1;

export default function FigureModule() {
  const { project } = useProject();
  const desktop = (window as unknown as { desktop?: Desktop }).desktop;
  const theme = useTheme();
  const [list, setList] = useState<OctreeListEntry[]>([]);
  const [log, setLog] = useState<Phase[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  /** The step a run is on, shown beside the button. */
  const [stage, setStage] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);

  // EVERY SETTING IS REMEMBERED. The workflow is "take a frame, go to
  // the Editor and change something, come back and take the second", so
  // nothing here may be forgotten on the way — not the folder, not the
  // settings, and above all not the frame being held.
  const saved = useRef<FigureSession>(readSession()).current;
  const [folder, setFolder] = useState(saved.folder);
  const [name, setName] = useState(saved.name);

  // What every render shares.
  const [dark, setDark] = useState(saved.dark);
  const [figW, setFigW] = useState(saved.width);
  const [figH, setFigH] = useState(saved.height);
  const [pointBudget, setPointBudget] = useState(saved.pointBudget);
  const [colorMode, setColorMode] = useState<FigureColorMode>(saved.colorMode);
  const [heights, setHeights] = useState<HeightChoice>(saved.heights);
  // The colour unclassified points take wherever a frame shows them.
  // Grey is the viewer's, and right on a dark screen; on a white page
  // a darker tone, or black, is often what print wants.
  const [unclassifiedColor, setUnclassifiedColor] = useState(saved.unclassifiedColor);

  // A single frame.
  const [frameDir, setFrameDir] = useState(saved.frameDir);
  const [direction, setDirection] = useState<Direction>(saved.direction);
  const [unclassified, setUnclassified] = useState<Unclassified>(saved.unclassified);
  const [isolate, setIsolate] = useState(saved.isolate);
  const [treeId, setTreeId] = useState(saved.treeId);
  const [isolateMargin, setIsolateMargin] = useState(saved.isolateMargin);

  // Two datasets, one camera per row.
  const [sourceDir, setSourceDir] = useState(saved.sourceDir);
  const [targetDir, setTargetDir] = useState(saved.targetDir);
  const [rowA, setRowA] = useState(saved.rowA);
  const [rowB, setRowB] = useState(saved.rowB);
  // The comparison's own isolate, independent of the single frame's: a
  // user often wants the whole plot in one section and one tree in the
  // other.
  const [cmpIsolate, setCmpIsolate] = useState(saved.cmpIsolate);
  const [cmpTreeId, setCmpTreeId] = useState(saved.cmpTreeId);
  const [cmpIsolateMargin, setCmpIsolateMargin] = useState(saved.cmpIsolateMargin);
  // How far the comparison's cameras stand: a multiple of the fitted
  // distance, so 1 fills the frame with the shared box and 2 shows it
  // at half the size with the stand around it.
  const [cmpDistance, setCmpDistance] = useState(saved.cmpDistance);

  // A panel.
  const [panelDir, setPanelDir] = useState(saved.panelDir);
  const [rowCount, setRowCount] = useState(saved.rowCount);
  const [layoutWidth, setLayoutWidth] = useState(saved.layoutWidth);
  const [dpr, setDpr] = useState(saved.dpr);
  const [panelPrintedCm, setPanelPrintedCm] = useState(saved.panelPrintedCm);
  const [hiddenCodes, setHiddenCodes] = useState<FlagCode[]>(saved.hiddenCodes as FlagCode[]);
  const [flagCounts, setFlagCounts] = useState<Map<FlagCode, number> | null>(null);

  // Composing.
  const [cols, setCols] = useState(saved.cols);
  const [gutter, setGutter] = useState(saved.gutter);
  const [margin, setMargin] = useState(saved.margin);
  const [composedCm, setComposedCm] = useState(saved.composedCm);
  const [crop, setCrop] = useState<CropBox | null>(saved.crop);

  // The first frame of a pair, waiting for its second. Its pixels live
  // in `beforeShot` while the module is up and on disk after that, so a
  // restart between the two frames does not lose it.
  const [held, setHeld] = useState<HeldFrame | null>(saved.held);

  const say = useCallback((text: string, kind: Phase['kind'] = 'info') => {
    setLog((l) => [...l.slice(-200), { text, kind }]);
  }, []);

  /** A step of a run: what it is, how long it took, and a bound. A
   *  native command that never returns used to leave the button reading
   *  "Rendering…" with nothing in the log and nothing on disk — a state
   *  with no way to tell a slow pass over a 450 M-point cloud from a
   *  hang. Now every step announces itself, reports its own seconds, and
   *  fails by name if it runs past its bound. */
  const step = useCallback(async <T,>(what: string, limitS: number, run: () => Promise<T>): Promise<T> => {
    setStage(what);
    const t0 = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${what} did not finish within ${limitS} s — stopped rather than waiting for ever`)), limitS * 1000);
        }),
      ]);
      const s = (performance.now() - t0) / 1000;
      if (s > 2) say(`${what} — ${s.toFixed(1)} s`);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      setStage(null);
    }
  }, [say]);

  useEffect(() => {
    writeSession({
      folder, name, dark, width: figW, height: figH, pointBudget, colorMode, heights, unclassifiedColor,
      frameDir, direction, unclassified, isolate, treeId, isolateMargin,
      sourceDir, targetDir, rowA, rowB, cmpIsolate, cmpTreeId, cmpIsolateMargin, cmpDistance,
      panelDir, rowCount, layoutWidth, dpr, panelPrintedCm, hiddenCodes,
      cols, gutter, margin, composedCm, crop, held,
    });
  }, [folder, name, dark, figW, figH, pointBudget, colorMode, heights, unclassifiedColor, frameDir, direction, unclassified,
    isolate, treeId, isolateMargin, sourceDir, targetDir, rowA, rowB, cmpIsolate, cmpTreeId,
    cmpIsolateMargin, cmpDistance, panelDir, rowCount,
    layoutWidth, dpr, panelPrintedCm, hiddenCodes, cols, gutter, margin, composedCm, crop, held]);

  useEffect(() => {
    if (!project?.folder) { setList([]); return; }
    let cancelled = false;
    void listOctrees(project.folder).then((l) => { if (!cancelled) setList(l); }).catch(() => { if (!cancelled) setList([]); });
    return () => { cancelled = true; };
  }, [project?.folder]);

  useEffect(() => {
    if (list.length === 0) return;
    const first = list[0].dir;
    const second = (list[1] ?? list[0]).dir;
    setFrameDir((d) => (findDir(list, d) ? d : first));
    setPanelDir((d) => (findDir(list, d) ? d : second));
    setSourceDir((d) => (findDir(list, d) ? d : first));
    setTargetDir((d) => (findDir(list, d) ? d : second));
  }, [list]);

  // With nothing remembered, the module opens on whatever the
  // application is set to, so what is on screen is what comes out.
  // After that the choice is the module's own.
  const themeSeen = useRef(saved.folder !== '' || saved.name !== 'figure');
  useEffect(() => {
    if (themeSeen.current) return;
    themeSeen.current = true;
    setDark(theme === 'dark');
  }, [theme]);

  // ---- The offscreen canvas. One dataset at a time: the streamer is a
  // third consumer of the budget the two Compare panes already split, so
  // it exists only while a frame is being taken.
  const [canvasDir, setCanvasDir] = useState<string | null>(null);
  const exporterRef = useRef<ViewportExport | null>(null);
  const onCanvasReady = useCallback((e: ViewportExport | null) => { exporterRef.current = e; }, []);
  const onCanvasError = useCallback((m: string) => { say(`Could not open the dataset: ${m}`, 'err'); }, [say]);

  const withCanvas = useCallback(async <T,>(entry: OctreeListEntry, fn: (exp: ViewportExport) => Promise<T>): Promise<T> => {
    exporterRef.current = null;
    setCanvasDir(entry.dir);
    const until = Date.now() + 300_000;
    await step(`Opening ${entry.name}`, 300, async () => {
      while (!exporterRef.current) {
        if (Date.now() > until) throw new Error(`${entry.name} did not open`);
        await new Promise((r) => setTimeout(r, 50));
      }
    }).catch((e) => { setCanvasDir(null); throw e; });
    try { return await fn(exporterRef.current!); }
    finally { setCanvasDir(null); exporterRef.current = null; }
  }, [step]);

  const write = useCallback(async (path: string, bytes: Uint8Array) => {
    if (!desktop?.writeFileBytes) throw new Error('no file writer in this build');
    await desktop.writeFileBytes(path, bytes);
  }, [desktop]);
  const writeText = useCallback(async (path: string, text: string) => {
    if (!desktop?.writeFile) throw new Error('no file writer in this build');
    await desktop.writeFile(path, text);
  }, [desktop]);

  const pickFolder = useCallback(async () => {
    const f = await desktop?.browseForFolder?.('Folder for the images');
    if (f) { setFolder(f); say(`Images will be written to ${f}`, 'ok'); }
  }, [desktop, say]);

  /** One tree's box in a dataset, or null when that dataset does not
   *  have the id. Shared by the single frame and the comparison. */
  const treeBoxIn = useCallback(async (entry: OctreeListEntry, id: number): Promise<[[number, number, number], [number, number, number]] | null> => {
    const summary = await step(`Reading ${entry.name}'s tree list`, 300, async () =>
      desktop?.octreeTreeSummary?.(entry.dir).catch(() => []));
    const tree = summary?.find((t) => t.treeId === id);
    return tree ? isolateGeomFor(tree).box : null;
  }, [desktop, step]);

  /** A dataset's ground level: the median of its classified ground, or
   *  its floor when it has none. Zero for a cloud already normalised —
   *  its z IS a height above ground. */
  const groundCache = useRef(new Map<string, number>());
  const groundLevelOf = useCallback(async (e: OctreeListEntry): Promise<number> => {
    if (guessFrame(e.bboxMin[2], e.bboxMax[2]) !== 'absolute') return 0;
    const had = groundCache.current.get(e.dir);
    if (had !== undefined) return had;
    let z = e.bboxMin[2];
    try {
      // THE ONE LONG WAIT IN A FIGURE. The first call on a cloud whose
      // ground surface has not been built yet is a whole pass over its
      // points — minutes on a plot of hundreds of millions — and it was
      // silent, so the button read "Rendering…" with nothing happening
      // and the run looked hung. It is cached on disk afterwards, which
      // is why a second attempt comes back at once. Named, timed and
      // bounded, and said out loud before it starts.
      say(`${e.name}: building the ground surface — one pass over the whole cloud, minutes the first time, kept on disk afterwards`);
      const g = await step(`Building ${e.name}'s ground surface (first time only)`, 1800, async () =>
        desktop?.octreeGroundReference?.(e.dir));
      if (g && Number.isFinite(g.z)) z = g.z;
      if (g) say(`${e.name}: ground at z ${g.z.toFixed(2)} m, from ${g.from === 'ground' ? `${g.cells} classified ground cells` : "the cloud's floor — it has no ground classification"}`, g.from === 'ground' ? 'ok' : 'warn');
    } catch (err) {
      say(`${e.name}: ${err instanceof Error ? err.message : String(err)} — using the cloud's floor instead`, 'warn');
    }
    groundCache.current.set(e.dir, z);
    return z;
  }, [desktop, step, say]);

  /** ONE HEIGHT FRAME FOR A SET OF CLOUDS. Two clouds only stand in the
   *  same place if their heights mean the same thing.
   *
   *  Both already in elevation, or both already normalised: their z is
   *  the same quantity, so it is used as it is — nothing to do, and no
   *  terrain read.
   *
   *  One of each: the elevation cloud is drawn at its height above the
   *  ground under each point, which is what the normalised one already
   *  is. A single ground level per cloud is NOT enough here and was the
   *  defect — it takes the plot's median ground off every point, so the
   *  terrain's relief stays in the elevation cloud and not in the
   *  normalised one, and the two stand at different heights tree by
   *  tree. The base is the terrain's own reference, which is where a
   *  flattened cloud's ground ends up. */
  const heightFrameFor = useCallback(async (entries: OctreeListEntry[]): Promise<Map<string, { base: number; flatten: boolean }>> => {
    const guesses = entries.map((e) => guessFrame(e.bboxMin[2], e.bboxMax[2]));
    const mixed = guesses.includes('above_ground') && guesses.includes('absolute');
    const wanted = heights === 'auto' ? (mixed ? 'above_ground' : 'stored') : heights;
    const out = new Map<string, { base: number; flatten: boolean }>();
    for (let i = 0; i < entries.length; i++) {
      const absolute = guesses[i] === 'absolute';
      if (wanted === 'stored' || !absolute) { out.set(entries[i].dir, { base: 0, flatten: false }); continue; }
      out.set(entries[i].dir, { base: await groundLevelOf(entries[i]), flatten: true });
    }
    return out;
  }, [heights, groundLevelOf]);

  /** A world box in the shared height frame. */
  const shiftBox = (b: [[number, number, number], [number, number, number]], base: number): Box => ({
    min: [b[0][0], b[0][1], b[0][2] - base] as Vec3,
    max: [b[1][0], b[1][1], b[1][2] - base] as Vec3,
  });

  const boxOf = (e: OctreeListEntry, base: number): Box => ({
    min: [e.bboxMin[0], e.bboxMin[1], e.bboxMin[2] - base] as Vec3,
    max: [e.bboxMax[0], e.bboxMax[1], e.bboxMax[2] - base] as Vec3,
  });

  const addShot = useCallback((s: Omit<Shot, 'id'>) => {
    setShots((prev) => [...prev, { ...s, id: shotSeq++ }]);
  }, []);

  const background = dark ? 'dark' as const : 'white' as const;
  const backgroundHex = dark ? '#0b0d10' : '#ffffff';

  /** Take one viewport frame, write it, and keep it for composing. */
  const shoot = useCallback(async (
    exp: ViewportExport, part: string, label: string, entry: OctreeListEntry, req: ViewportRequest, spec: Omit<ViewportPart, 'file' | 'datasetDir' | 'datasetName'>,
  ): Promise<Shot> => {
    const render = await step(`Rendering ${label}`, 600, () => exp(req, (what) => setStage(`${label} — ${what}`)));
    const png = await step(`Encoding ${label}`, 120, () => rgbaToPngOn(render.rgba, render.width, render.height));
    const file = figureFileName(name, part, 'png');
    await step(`Writing ${file}`, 300, () => write(`${folder}/${file}`, png));
    const extent = frameExtent(req.camera, req.width / req.height);
    if (!render.settled) say(`${file}: the streamer had not gone quiet — the frame may be short of points`, 'warn');
    say(`${file} — ${render.pointsRendered.toLocaleString()} points, ${render.width} × ${render.height} px, `
      + `${extent.widthM.toFixed(1)} × ${extent.heightM.toFixed(1)} m`, 'ok');
    const shot: Shot = {
      id: 0, label, png, width: render.width, height: render.height, kind: 'viewport', croppable: true,
      part: { ...spec, file, datasetDir: entry.dir, datasetName: entry.name },
      result: {
        file, kind: 'viewport', width: render.width, height: render.height,
        pointsRendered: render.pointsRendered, settled: render.settled,
        worldWidthM: extent.widthM, worldHeightM: extent.heightM,
      },
    };
    addShot(shot);
    return shot;
  }, [name, folder, write, say, addShot, step]);

  /** The specification and the record of what a run produced. */
  const writeSpec = useCallback(async (
    suffix: string, title: string, parts: FigurePart[], results: PartResult[], composed?: FigureSidecar['composed'],
  ) => {
    const full = suffix ? `${name}_${suffix}` : name;
    const spec: FigureSpec = {
      format: FIGURE_SPEC_FORMAT, version: FIGURE_SPEC_VERSION, name: full, title, parts,
      compose: composed
        ? { rows: Math.ceil(parts.length / cols), cols, gutter, margin, crop, printedWidthCm: composed.printedWidthCm, file: composed.file }
        : null,
    };
    const sidecar: FigureSidecar = {
      format: FIGURE_SPEC_FORMAT, version: FIGURE_SPEC_VERSION, name: full, title,
      appVersion: __APP_VERSION__, commit: __GIT_COMMIT__,
      exportedAt: new Date().toISOString(), spec, results, composed,
    };
    await step(`Writing ${full}.json`, 120, async () => {
      await writeText(`${folder}/${full}.json`, serializeSidecar(sidecar));
      await writeText(`${folder}/${full}.spec.json`, serializeSpec(spec));
    });
    say(`${full}.json written — the specification beside it takes this image again`, 'ok');
  }, [name, folder, cols, gutter, margin, crop, writeText, say, step]);

  /** The isolate box and the camera for one dataset's frame. */
  const frameFor = useCallback(async (entry: OctreeListEntry, dir: Direction): Promise<{
    camera: CameraPose; zBase: number; flatten: boolean; box: [[number, number, number], [number, number, number]] | null;
  }> => {
    const frame = (await heightFrameFor([entry])).get(entry.dir)!;
    const base = frame.base;
    if (!isolate) return { camera: orbitPose(boxOf(entry, base), figW / figH, dir), zBase: base, flatten: frame.flatten, box: null };
    const geomBox = await treeBoxIn(entry, treeId);
    if (!geomBox) throw new Error(`Tree ${treeId} is not in ${entry.name}'s summary`);
    return {
      camera: treePose(shiftBox(geomBox, base), figW / figH, isolateMargin, dir),
      zBase: base, flatten: frame.flatten, box: geomBox,
    };
  }, [heightFrameFor, isolate, treeBoxIn, treeId, figW, figH, isolateMargin]);

  const viewportSpec = useCallback((
    camera: CameraPose, unc: Unclassified,
    box: [[number, number, number], [number, number, number]] | null,
    iso: { treeId: number; margin: number } = { treeId, margin: isolateMargin },
  ) => ({
    kind: 'viewport' as const, width: figW, height: figH, background,
    colorMode, unclassified: unc, unclassifiedColor, camera,
    isolateTreeId: box ? iso.treeId : null, isolateMargin: box ? iso.margin : 0,
    pointSize: figurePointSize(1, 900, figH), scaleBar: false,
  }), [figW, figH, background, colorMode, unclassifiedColor, treeId, isolateMargin]);


  // ---- A single frame. ----------------------------------------------
  const takeFrame = useCallback(async () => {
    const entry = findDir(list, frameDir);
    if (!entry) { say('Pick a dataset first.', 'err'); return; }
    const { camera, zBase, flatten, box } = await frameFor(entry, direction);
    const spec = viewportSpec(camera, unclassified, box);
    const req: ViewportRequest = {
      width: figW, height: figH, background, colorMode, unclassified, unclassifiedColor, camera, zBase, flatten,
      isolateTreeId: box ? treeId : null, isolateBox: box, isolateMargin: box ? isolateMargin : 0,
      pointSize: spec.pointSize, pointBudget,
    };
    const part = `${describeDirection(direction).file}${box ? `_tree${treeId}` : ''}`;
    const label = `${entry.name} · ${describeDirection(direction).text}${box ? ` · tree ${treeId}` : ''}`;
    const shot = await withCanvas(entry, (exp) => shoot(exp, part, label, entry, req, spec));
    await writeSpec(part, label, [shot.part], [shot.result]);
  }, [list, frameDir, frameFor, direction, viewportSpec, unclassified, unclassifiedColor, figW, figH, background, colorMode, treeId, isolateMargin, pointBudget, withCanvas, shoot, say, writeSpec]);

  // ---- A pair from one held camera: the same frame before and after an
  // edit made in the Editor in between. --------------------------------
  const [beforeShot, setBeforeShot] = useState<Shot | null>(null);

  /** The first frame's pixels: still in memory, or read back from the
   *  file it was written to. Either way the pair composes — including
   *  after the application has been closed and opened in between. */
  const beforePixels = useCallback(async (): Promise<Shot | null> => {
    if (beforeShot) return beforeShot;
    if (!held || !desktop?.readFile) return null;
    try {
      const bytes = new Uint8Array(await step(`Reading ${held.file}`, 300, () => desktop.readFile!(`${folder}/${held.file}`)));
      say(`Read the held frame back from ${held.file}`);
      return {
        id: 0, label: `${held.file} (held)`, png: bytes, width: held.width, height: held.height,
        kind: 'viewport', croppable: true, part: held.part, result: held.result,
      };
    } catch (e) {
      say(`The held frame ${held.file} could not be read back: ${e instanceof Error ? e.message : String(e)}`, 'err');
      return null;
    }
  }, [beforeShot, held, desktop, folder, say, step]);

  const takePair = useCallback(async (which: 'before' | 'after') => {
    const entry = findDir(list, frameDir);
    if (!entry) { say('Pick a dataset first.', 'err'); return; }
    const frame = which === 'before' || !held || held.dir !== entry.dir
      ? await frameFor(entry, direction)
      : { camera: held.camera, zBase: held.zBase, flatten: held.flatten, box: held.box };
    const spec = viewportSpec(frame.camera, unclassified, frame.box);
    const req: ViewportRequest = {
      width: figW, height: figH, background, colorMode, unclassified, unclassifiedColor,
      camera: frame.camera, zBase: frame.zBase, flatten: frame.flatten,
      isolateTreeId: frame.box ? treeId : null, isolateBox: frame.box,
      isolateMargin: frame.box ? isolateMargin : 0,
      pointSize: spec.pointSize, pointBudget,
    };
    const shot = await withCanvas(entry, (exp) => shoot(exp, `pair_${which}`, `${entry.name} · ${which}`, entry, req, spec));
    if (which === 'before') {
      setBeforeShot(shot);
      setHeld({
        camera: frame.camera, zBase: frame.zBase, flatten: frame.flatten, box: frame.box, dir: entry.dir,
        file: shot.result.file, width: shot.width, height: shot.height,
        part: shot.part, result: shot.result,
      });
      say('Make the edit in the Editor, come back and take "after" — the camera is held, and it survives a restart.', 'info');
      return;
    }
    const before = await beforePixels();
    if (!before) { say('Only the "after" frame was taken; a pair needs a "before" too.', 'warn'); return; }
    const composed = await step('Composing the pair', 300, () => composeGrid(
      [{ png: before.png, cropped: true }, { png: shot.png, cropped: true }],
      { rows: 1, cols: 2, gutter, margin }, crop, backgroundHex,
    ));
    const file = figureFileName(name, 'pair', 'png');
    await step(`Writing ${file}`, 300, () => write(`${folder}/${file}`, composed.png));
    const dpiV = checkDpi(composed.width, composedCm, 'halftone');
    say(`${file} — ${composed.width} × ${composed.height} px · ${dpiV.message}`, dpiV.ok ? 'ok' : 'warn');
    await writeSpec('pair', `${entry.name}, before and after`, [before.part, shot.part], [before.result, shot.result], {
      file, width: composed.width, height: composed.height,
      printedWidthCm: composedCm, dpi: dpiV.dpi, dpiOk: dpiV.ok, resampled: composed.resampled,
    });
    setHeld(null);
    setBeforeShot(null);
  }, [list, frameDir, held, frameFor, direction, viewportSpec, unclassified, figW, figH, background, colorMode, treeId, isolateMargin, pointBudget, withCanvas, shoot, beforePixels, gutter, margin, crop, backgroundHex, name, write, folder, composedCm, writeSpec, say, step]);

  // ---- Two datasets, one camera per row. ------------------------------
  const takeComparison = useCallback(async () => {
    const src = findDir(list, sourceDir);
    const tgt = findDir(list, targetDir);
    if (!src || !tgt || src.dir === tgt.dir) { say('Pick two different datasets.', 'err'); return; }
    const frames = await heightFrameFor([src, tgt]);
    const srcFrame = frames.get(src.dir)!;
    const tgtFrame = frames.get(tgt.dir)!;
    for (const [e, f] of [[src, srcFrame], [tgt, tgtFrame]] as const) {
      if (f.flatten) say(`${e.name} is drawn at its height above the ground under each point (ground at z ${f.base.toFixed(1)} m)`);
    }
    if (!srcFrame.flatten && !tgtFrame.flatten) say('Both clouds are already in the same height, so their z is used as it is');
    // ONE TREE, IN BOTH COLUMNS. Each dataset is isolated to its own
    // copy of the id — the boxes differ, because the two clouds saw the
    // tree differently, which is the comparison's whole subject — while
    // the camera comes from the box they SHARE, so the columns still
    // register. An id one of them does not have is refused rather than
    // rendered as an empty half.
    const isoBoxes = new Map<string, [[number, number, number], [number, number, number]] | null>();
    if (cmpIsolate) {
      for (const e of [src, tgt]) {
        const b = await treeBoxIn(e, cmpTreeId);
        if (!b) throw new Error(`Tree ${cmpTreeId} is not in ${e.name}'s summary — the comparison would have an empty column`);
        isoBoxes.set(e.dir, b);
      }
    }
    const framed = cmpIsolate
      ? [shiftBox(isoBoxes.get(src.dir)!, srcFrame.base), shiftBox(isoBoxes.get(tgt.dir)!, tgtFrame.base)]
      : [boxOf(src, srcFrame.base), boxOf(tgt, tgtFrame.base)];
    const box = unionBox(framed);
    const rows = rowB ? [rowA, rowB] : [rowA];
    // ONE camera per row, from the box the two share, so the columns
    // register by construction rather than by a careful hand — then
    // stood off by the user's distance, which moves it along its own
    // line of sight and so keeps the registration.
    const cameras = rows.map((r) => standOff(cmpIsolate
      ? treePose(box, figW / figH, cmpIsolateMargin, r.direction)
      : orbitPose(box, figW / figH, r.direction), cmpDistance));
    const taken: Shot[][] = [];
    for (const [side, entry, frame] of [['left', src, srcFrame], ['right', tgt, tgtFrame]] as const) {
      const col: Shot[] = [];
      await withCanvas(entry, async (exp) => {
        for (let r = 0; r < rows.length; r++) {
          const isoBox = cmpIsolate ? isoBoxes.get(entry.dir)! : null;
          const spec = viewportSpec(cameras[r], rows[r].unclassified, isoBox, { treeId: cmpTreeId, margin: cmpIsolateMargin });
          const req: ViewportRequest = {
            width: figW, height: figH, background, colorMode, unclassified: rows[r].unclassified, unclassifiedColor,
            camera: cameras[r], zBase: frame.base, flatten: frame.flatten,
            isolateTreeId: isoBox ? cmpTreeId : null, isolateBox: isoBox,
            isolateMargin: isoBox ? cmpIsolateMargin : 0,
            pointSize: spec.pointSize, pointBudget,
          };
          col.push(await shoot(exp, `r${r + 1}_${side}`,
            `${entry.name} · ${describeDirection(rows[r].direction).text}${cmpIsolate ? ` · tree ${cmpTreeId}` : ''}`,
            entry, req, spec));
        }
      });
      taken.push(col);
    }
    // Row-major: (row 1 left, row 1 right, row 2 left, row 2 right).
    const ordered: Shot[] = [];
    for (let r = 0; r < rows.length; r++) { ordered.push(taken[0][r], taken[1][r]); }
    const composed = await step('Composing the comparison', 300, () => composeGrid(
      ordered.map((s) => ({ png: s.png, cropped: true })),
      { rows: rows.length, cols: 2, gutter, margin }, crop, backgroundHex,
    ));
    const dpiV = checkDpi(composed.width, composedCm, 'halftone');
    say(dpiV.message, dpiV.ok ? 'ok' : 'warn');
    const file = figureFileName(name, 'comparison', 'png');
    await step(`Writing ${file}`, 300, () => write(`${folder}/${file}`, composed.png));
    say(`${file} — ${composed.width} × ${composed.height} px`, 'ok');
    await writeSpec(cmpIsolate ? `comparison_tree${cmpTreeId}` : 'comparison',
      `${src.name} and ${tgt.name}${cmpIsolate ? `, tree ${cmpTreeId}` : ''}`,
      ordered.map((s) => s.part), ordered.map((s) => s.result), {
      file, width: composed.width, height: composed.height,
      printedWidthCm: composedCm, dpi: dpiV.dpi, dpiOk: dpiV.ok, resampled: composed.resampled,
    });
  }, [list, sourceDir, targetDir, heightFrameFor, rowA, rowB, cmpIsolate, cmpTreeId, cmpIsolateMargin, cmpDistance, treeBoxIn, figW, figH, viewportSpec, background, colorMode, unclassifiedColor, pointBudget, withCanvas, shoot, gutter, margin, crop, backgroundHex, composedCm, name, write, folder, writeSpec, say, step]);

  // ---- A panel. -------------------------------------------------------
  const readFlags = useCallback(async (): Promise<{ all: Flag[]; treeCount: number; entry: OctreeListEntry } | null> => {
    const entry = findDir(list, panelDir);
    if (!entry || !desktop) { say('Pick a dataset for the panel first.', 'err'); return null; }
    const metrics = await step(`Reading ${entry.name}'s tree metrics`, 900, () =>
      loadTreeMetrics(desktop, entry.dir, DEFAULT_METRIC_PARAMS, { force: false }));
    const qsmRes = await step(`Reading ${entry.name}'s QSM cache`, 300, () =>
      desktop.octreeReadQsm?.(entry.dir).catch(() => null) ?? Promise.resolve(null));
    const qsm = qsmRes ? new Map(qsmRes.trees.map((t) => [t.treeId, t])) : null;
    const summary = await step(`Reading ${entry.name}'s tree list`, 300, () =>
      desktop.octreeTreeSummary?.(entry.dir).catch(() => []) ?? Promise.resolve([]));
    const bboxes = summary && summary.length > 0
      ? new Map(summary.map((r) => [r.treeId, { min: r.bboxMin, max: r.bboxMax }]))
      : null;
    const all = computeQcFlags(metrics, qsm, bboxes);
    const counts = new Map<FlagCode, number>();
    for (const f of all) counts.set(f.code, (counts.get(f.code) ?? 0) + 1);
    setFlagCounts(counts);
    if (all.length === 0) { say('No QC flags on that dataset — run the metrics in the editor first.', 'warn'); return null; }
    return { all, treeCount: metrics.length, entry };
  }, [list, panelDir, desktop, say, step]);

  const takePanel = useCallback(async () => {
    const loaded = await readFlags();
    if (!loaded) return;
    const { all, treeCount, entry } = loaded;
    const shown = selectFlags(all, { hiddenCodes, sort: 'severity', rowCount });
    if (shown.length === 0) { say('Every check is hidden — nothing would be in the figure.', 'err'); return; }
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const f of all) counts[f.severity]++;
    const byCode = new Map<FlagCode, number>();
    for (const f of all) byCode.set(f.code, (byCode.get(f.code) ?? 0) + 1);
    const legible = checkLegibility(layoutWidth, panelPrintedCm, TEXT.code);
    if (!legible.ok) { say(`Refused: ${legible.message}`, 'err'); return; }
    const rendered = renderQcPanelSvg({
      flags: shown,
      shown: selectFlags(all, { hiddenCodes }).length,
      total: all.length,
      flaggedTrees: new Set(all.map((f) => f.treeId)).size,
      treeCount,
      counts,
      byCode: [...byCode.entries()].sort((a, b) => b[1] - a[1]),
      hiddenCodes,
      sort: 'severity',
      width: layoutWidth,
    }, { dark, printedWidthCm: panelPrintedCm });
    const raster = await step('Rasterising the panel', 300, () => svgToPng(rendered.svg, rendered.width, rendered.height, dpr));
    const dpiV = checkDpi(raster.width, panelPrintedCm, 'combination');
    say(dpiV.message, dpiV.ok ? 'ok' : 'warn');
    const pngName = figureFileName(name, 'qc_panel', 'png');
    const svgName = figureFileName(name, 'qc_panel', 'svg');
    await step(`Writing ${pngName}`, 300, async () => {
      await write(`${folder}/${pngName}`, raster.png);
      // Text stays text: sharp at any size, small, selectable in a PDF.
      await writeText(`${folder}/${svgName}`, rendered.svg);
    });
    say(`${pngName} — ${rendered.rows} rows, ${raster.width} × ${raster.height} px (+ ${svgName})`, 'ok');
    const part: FigurePart = {
      kind: 'panel', file: pngName, panel: 'qc', datasetDir: entry.dir, datasetName: entry.name,
      layoutWidth, dpr, rowCount, sort: 'severity', hiddenCodes, severities: ['critical', 'warning', 'info'], background,
    };
    const result: PartResult = {
      file: pngName, kind: 'panel', width: raster.width, height: raster.height,
      rows: rendered.rows, smallestPrintedPt: rendered.legibility.printedCm * 28.35,
    };
    addShot({ label: `QC panel · ${entry.name}`, png: raster.png, width: raster.width, height: raster.height, kind: 'panel', part, result, croppable: false });
    await writeSpec('qc_panel', `Quality control · ${entry.name}`, [part], [result]);
  }, [readFlags, hiddenCodes, rowCount, layoutWidth, panelPrintedCm, dark, dpr, name, folder, write, writeText, background, addShot, writeSpec, say, step]);

  // ---- Compose whatever has been taken. --------------------------------
  const composeShots = useCallback(async () => {
    if (shots.length === 0) { say('Nothing has been taken yet.', 'err'); return; }
    const cells: ComposeInput[] = shots.map((s) => ({ png: s.png, cropped: s.croppable }));
    const rows = Math.ceil(shots.length / cols);
    const composed = await step(`Composing ${shots.length} images`, 300, () => composeGrid(cells, { rows, cols, gutter, margin }, crop, backgroundHex));
    const dpiV = checkDpi(composed.width, composedCm, shots.every((s) => s.kind === 'viewport') ? 'halftone' : 'combination');
    say(dpiV.message, dpiV.ok ? 'ok' : 'warn');
    const file = figureFileName(name, 'composed', 'png');
    await step(`Writing ${file}`, 300, () => write(`${folder}/${file}`, composed.png));
    say(`${file} — ${rows} × ${cols}, ${composed.width} × ${composed.height} px`, 'ok');
    await writeSpec('composed', `${shots.length} images, ${rows} × ${cols}`, shots.map((s) => s.part), shots.map((s) => s.result), {
      file, width: composed.width, height: composed.height,
      printedWidthCm: composedCm, dpi: dpiV.dpi, dpiOk: dpiV.ok, resampled: composed.resampled,
    });
  }, [shots, cols, gutter, margin, crop, backgroundHex, composedCm, name, write, folder, writeSpec, say, step]);

  /** Load a saved specification back into the controls, so an image can
   *  be taken again from the data as it is now. */
  const rerun = useCallback(async () => {
    const picked = await desktop?.openFileDialog?.({ filters: [{ name: 'Figure specification', extensions: ['json'] }] });
    if (!picked) return;
    const text = picked.text ?? new TextDecoder().decode(await desktop!.readFile!(picked.path));
    const spec = parseSpec(text);
    setName(spec.name.replace(/_(qc_panel|composed|pair|comparison|oblique|side|top)(_tree\d+)?$/, ''));
    for (const p of spec.parts) {
      if (p.kind === 'panel') {
        setLayoutWidth(p.layoutWidth); setDpr(p.dpr); setRowCount(p.rowCount);
        setHiddenCodes(p.hiddenCodes as FlagCode[]); setPanelDir(p.datasetDir);
        setDark(p.background === 'dark');
      } else {
        setFigW(p.width); setFigH(p.height); setDark(p.background === 'dark');
        setColorMode(p.colorMode); setUnclassified(p.unclassified); setUnclassifiedColor(p.unclassifiedColor);
        setFrameDir(p.datasetDir);
        setDirection(directionFromCamera(p.camera));
        if (p.isolateTreeId != null) { setIsolate(true); setTreeId(p.isolateTreeId); setIsolateMargin(p.isolateMargin); }
      }
    }
    if (spec.compose) { setCols(spec.compose.cols); setGutter(spec.compose.gutter); setMargin(spec.compose.margin); setComposedCm(spec.compose.printedWidthCm); setCrop(spec.compose.crop); }
    say(`${spec.name} loaded into the controls — press the section's own button to take it again.`, 'ok');
  }, [desktop, say]);

  const run = useCallback((what: string, fn: () => Promise<unknown>) => {
    if (!folder) { say('Choose a folder for the images first.', 'err'); return; }
    setBusy(what);
    void (async () => {
      try { await fn(); }
      catch (e) { say(e instanceof Error ? e.message : String(e), 'err'); }
      finally { setBusy(null); }
    })();
  }, [folder, say]);

  const canRun = !!folder && !busy && list.length > 0;
  const busyLabel = (what: string, idle: string) => (busy === what ? (stage ? `${stage}…` : 'Working…') : idle);
  const tone: Record<Phase['kind'], string> = {
    info: 'var(--text-mute)', ok: 'var(--accent)', warn: '#e6c068', err: '#e0506b',
  };
  const shotTotalWidth = useMemo(() => margin * 2 + (shots.slice(0, cols).reduce((a, s) => a + s.width, 0)) + gutter * Math.max(0, Math.min(cols, shots.length) - 1), [shots, cols, gutter, margin]);

  return (
    <div className="absolute inset-0 overflow-auto" style={{ paddingTop: 64, background: 'var(--bg)' }}>
      {canvasDir && <FigureCanvas dir={canvasDir} onReady={onCanvasReady} onError={onCanvasError} />}
      <div className="mx-auto px-6 pb-10 flex flex-col gap-3" style={{ maxWidth: 1180 }}>
        <div>
          <h1 className="mono text-[15px]" style={{ color: 'var(--text)' }}>Figures</h1>
          <p className="mono text-[10.5px] mt-1" style={{ color: 'var(--text-mute)', lineHeight: 1.6, maxWidth: 800 }}>
            Publication-quality images of what is in the project. A viewport frame is rendered at its own pixel size
            and at the full node budget for the view, not at whatever detail is on screen; a panel is laid out at a
            width you choose and rasterised at a pixel ratio you choose, which is the only way to raise printed type
            size and dpi at once. Cameras are derived from the data and held between shots, so a pair registers to
            the pixel. Every image gets a specification beside it that takes it again.
          </p>
        </div>

        <Section title="Where the images go">
          <Row label="Folder">
            <button className="btn !h-7 mono text-[11px] px-2" disabled={!desktop?.browseForFolder} onClick={() => void pickFolder()}>Choose…</button>
            <span className="mono text-[10px] flex-1 truncate" style={{ color: folder ? 'var(--text-dim)' : '#e6c068' }}>
              {folder || 'no folder chosen — nothing can be written'}
            </span>
          </Row>
          <Row label="Name">
            <input value={name} onChange={(e) => setName(e.target.value.replace(/[\\/:*?"<>|\s]+/g, '_'))}
              className="mono text-[10.5px] rounded-md px-1.5 py-1"
              style={{ width: 200, background: 'var(--wash)', border: '1px solid var(--line)', color: 'var(--text)' }} />
            <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
              every file this session starts with it — {name}_oblique.png, {name}_qc_panel.svg, {name}_composed.png
            </span>
          </Row>
          <Row label="Rendered on">
            <Toggle on={!dark} label="white" onClick={() => setDark(false)} />
            <Toggle on={dark} label="dark" onClick={() => setDark(true)} />
            <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>white is the usual choice for print</span>
          </Row>
          <Row label="Frame size">
            <Num value={figW} min={400} max={12000} step={100} onChange={setFigW} unit="px wide" />
            <Num value={figH} min={300} max={12000} step={100} onChange={setFigH} unit="px tall" />
            <Num value={Math.round(pointBudget / 1e6)} min={1} max={400} step={1} onChange={(v) => setPointBudget(v * 1e6)} unit="M points" />
          </Row>
          <Row label="Points coloured">
            <Toggle on={colorMode === 'tree_id'} label="by tree" onClick={() => setColorMode('tree_id')} />
            <Toggle on={colorMode === 'semantic'} label="by class" onClick={() => setColorMode('semantic')} />
          </Row>
          <Row label="Unlabelled in">
            {UNCLASSIFIED_SWATCHES.map((c) => (
              <Swatch key={c.hex} hex={c.hex} label={c.label} on={unclassifiedColor.toLowerCase() === c.hex}
                onClick={() => setUnclassifiedColor(c.hex)} />
            ))}
            <label className="mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }} title="Any colour, as #rrggbb">
              <input type="color" value={unclassifiedColor} onChange={(e) => setUnclassifiedColor(e.target.value)}
                style={{ width: 28, height: 20, padding: 0, border: '1px solid var(--line)', borderRadius: 4, background: 'transparent' }} />
              <span className="tnum">{unclassifiedColor}</span>
            </label>
            <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
              wherever a frame shows the unlabelled points — grey is the viewer's, a darker tone often reads better on white
            </span>
          </Row>
          <Row label="Heights">
            {HEIGHT_CHOICES.map((h) => (
              <Toggle key={h.id} on={heights === h.id} label={h.label} title={h.hint} onClick={() => setHeights(h.id)} />
            ))}
          </Row>
          <Verdict>
            Two clouds only stand in the same place if their heights mean the same thing. Matched takes them as they
            are when both are in elevation or both are normalised, and draws the elevation one at its height above the
            ground under each point when they differ — a single ground level per cloud is not enough, because it
            leaves the terrain in one of them and not the other. The first frame that needs a cloud's ground surface
            builds it in one pass over the whole cloud — minutes on a plot of hundreds of millions of points — and
            keeps it on disk, so every frame after that starts at once. The button says which cloud it is on.
          </Verdict>
        </Section>

        <Section title="A single frame">
          <p className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            One dataset from a derived camera. Hide the unlabelled points when their grey would stand in front of what
            the frame is about, show them when the grey is the evidence.
          </p>
          <Row label="Dataset"><Picker value={frameDir} onChange={setFrameDir} list={list} /></Row>
          <Row label="Direction">
            {VIEWS.map((v) => (
              <Toggle key={v.id} on={viewNameOf(direction) === v.id} label={v.label} title={v.hint}
                onClick={() => setDirection(directionOf(v.id))} />
            ))}
          </Row>
          <Row label="…or any other">
            <Num value={direction.azimuth} min={0} max={359} step={5}
              onChange={(v) => setDirection({ ...direction, azimuth: v })} unit={`° bearing (${compass(direction.azimuth)})`} />
            <Num value={direction.elevation} min={-90} max={90} step={5}
              onChange={(v) => setDirection({ ...direction, elevation: v })} unit="° above the horizon" />
            <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
              where the camera stands: 0° is north of the subject, 90° east, 180° south
            </span>
          </Row>
          <Row label="Unlabelled">
            <Toggle on={unclassified === 'grey'} label="shown" title="In the colour chosen above" onClick={() => setUnclassified('grey')} />
            <Toggle on={unclassified === 'hidden'} label="hidden" onClick={() => setUnclassified('hidden')} />
          </Row>
          <Row label="One tree only">
            <label className="mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
              <input type="checkbox" checked={isolate} onChange={(e) => setIsolate(e.target.checked)} />
              isolate
            </label>
            {isolate && <Num value={treeId} min={1} max={100000} step={1} onChange={setTreeId} unit="tree id" />}
            {isolate && <Num value={isolateMargin} min={0} max={500} step={0.5} onChange={setIsolateMargin} unit="m margin" />}
          </Row>
          <button className="btn !h-7 mono text-[11px] justify-center" disabled={!canRun}
            onClick={() => run('frame', takeFrame)}>{busyLabel('frame', 'Take the frame')}</button>
        </Section>

        <Section title="A pair from one camera — before and after an edit">
          <p className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            Uses the settings above. Take &ldquo;before&rdquo;, make the edit in the Editor, come back and take
            &ldquo;after&rdquo;: the first shot&rsquo;s camera is held, so the two register, and the pair is composed
            straight away — and the held frame outlives the module, so switching to the Editor, or closing the
            application altogether, does not lose it.
          </p>
          <div className="mono text-[9.5px] px-2 py-1.5 rounded-md" style={{ color: 'var(--text)', background: 'color-mix(in oklch, var(--warn) 10%, transparent)', border: '1px solid color-mix(in oklch, var(--warn) 35%, transparent)', lineHeight: 1.5 }}>
            Save the edit before taking &ldquo;after&rdquo;. Every frame here is rendered from the dataset as it is
            <b style={{ color: 'var(--text)' }}> on disk</b>, so an edit still sitting in the Editor&rsquo;s undo
            history is not in it: press <b style={{ color: 'var(--text)' }}>Save edits</b> (⌘S / Ctrl+S) in the
            Editor first, or the second frame comes back identical to the first.
          </div>
          {held && (
            <div className="mono text-[9.5px] flex items-center gap-2" style={{ color: 'var(--accent)' }}>
              <span className="flex-1">Holding {held.file} — {held.width} × {held.height} px, {describeDirection(directionFromCamera(held.camera)).text}.</span>
              <button className="btn !h-5 !px-1.5 mono text-[9px]" onClick={() => { setHeld(null); setBeforeShot(null); }}>forget it</button>
            </div>
          )}
          <div className="flex gap-1.5">
            <button className="btn !h-7 mono text-[11px] justify-center flex-1" disabled={!canRun}
              onClick={() => run('before', () => takePair('before'))}>{busyLabel('before', '1 · Take “before”')}</button>
            <button className="btn !h-7 mono text-[11px] justify-center flex-1" disabled={!canRun || !held}
              title={held ? `The same camera as ${held.file}` : 'Take the before frame first'}
              onClick={() => run('after', () => takePair('after'))}>{busyLabel('after', '2 · Take “after” + compose')}</button>
          </div>
        </Section>

        <Section title="Two datasets, one camera per row">
          <p className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            The same camera on both sides of each row, derived from the box the two clouds share and from their
            ground levels when they are in different height frames — so an object is in the same place in both
            columns, and an id that was inherited is the same colour on both sides. The distance sets how far the
            camera stands from that box.
          </p>
          <Row label="Left"><Picker value={sourceDir} onChange={setSourceDir} list={list} /></Row>
          <Row label="Right"><Picker value={targetDir} onChange={setTargetDir} list={list} /></Row>
          <RowDirection label="Row 1" value={rowA} onChange={setRowA} />
          <Row label="Row 2">
            <label className="mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}>
              <input type="checkbox" checked={rowB !== null}
                onChange={(e) => setRowB(e.target.checked ? { direction: directionOf('oblique'), unclassified: 'grey' } : null)} />
              second row
            </label>
          </Row>
          {rowB && <RowDirection label="" value={rowB} onChange={(v) => setRowB(v)} />}
          <Row label="One tree only">
            <label className="mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}
              title="Isolate the same id in both columns. Each cloud is cut to its own copy of the tree — they differ, which is the point — while the camera still comes from the box the two share, so the columns register.">
              <input type="checkbox" checked={cmpIsolate} onChange={(e) => setCmpIsolate(e.target.checked)} />
              isolate, in both columns
            </label>
            {cmpIsolate && <Num value={cmpTreeId} min={1} max={100000} step={1} onChange={setCmpTreeId} unit="tree id" />}
            {cmpIsolate && <Num value={cmpIsolateMargin} min={0} max={500} step={0.5} onChange={setCmpIsolateMargin} unit="m margin" />}
          </Row>
          <Row label="Distance">
            <Num value={cmpDistance} min={0.2} max={10} step={0.1} onChange={setCmpDistance} unit="× the fitted distance" />
            <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
              1 fills the frame with what the two clouds share{cmpIsolate ? ', the tree and its margin' : ''}; 2 stands twice as far,
              0.5 twice as close. The camera moves along its own line of sight, so the columns still register.
            </span>
          </Row>
          <button className="btn !h-7 mono text-[11px] justify-center" disabled={!canRun}
            onClick={() => run('comparison', takeComparison)}>
            {busyLabel('comparison', `Take the ${rowB ? '2 × 2' : '1 × 2'} comparison`)}
          </button>
        </Section>

        <Section title="A panel">
          <p className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>
            The quality-control list, drawn from its data at a layout width you choose and rendered at a pixel ratio
            you choose: the width sets the printed type size, the ratio sets the dpi, and neither alone is enough.
            The header counters, the severity chips, the check chips and the sort state are all in the image, and no
            text is cut off — a reason or a hint takes another line instead.
          </p>
          <Row label="Dataset"><Picker value={panelDir} onChange={setPanelDir} list={list} /></Row>
          <Row label="Checks">
            <div className="flex flex-wrap gap-1 flex-1">
              {ALL_CODES.map((code) => {
                const on = !hiddenCodes.includes(code);
                const n = flagCounts?.get(code);
                return (
                  <button key={code}
                    onClick={() => setHiddenCodes((h) => (h.includes(code) ? h.filter((c) => c !== code) : [...h, code]))}
                    className="mono text-[9.5px] px-1.5 py-0.5 rounded-sm"
                    style={{
                      color: on ? 'var(--text-dim)' : 'var(--text-mute)',
                      background: on ? 'var(--wash-strong)' : 'transparent',
                      border: `1px solid ${on ? 'var(--line-strong)' : 'var(--line)'}`,
                    }}
                    title={on ? `Leave the "${FLAG_LABEL[code]}" check in the figure` : `Keep the "${FLAG_LABEL[code]}" check out`}>
                    {FLAG_LABEL[code]}{n != null && <span className="tnum" style={{ color: 'var(--text-mute)' }}> {n}</span>}
                  </button>
                );
              })}
            </div>
          </Row>
          <Row label="">
            <button className="btn !h-5 !px-1.5 mono text-[10px]" disabled={!!busy}
              onClick={() => run('flags', async () => { await readFlags(); })}>
              {busyLabel('flags', 'Read the counts')}
            </button>
            <button className="btn !h-5 !px-1.5 mono text-[10px]" onClick={() => setHiddenCodes([])}>all checks</button>
            <button className="btn !h-5 !px-1.5 mono text-[10px]" onClick={() => setHiddenCodes(DEFAULT_HIDDEN)}>reset</button>
          </Row>
          <Row label="Layout">
            <Num value={layoutWidth} min={320} max={900} step={10} onChange={setLayoutWidth} unit="CSS px" />
            <Num value={dpr} min={1} max={6} step={1} onChange={setDpr} unit="× ratio" />
            <Num value={panelPrintedCm} min={4} max={19} step={0.5} onChange={setPanelPrintedCm} unit="cm printed" />
            <Num value={rowCount} min={1} max={60} step={1} onChange={setRowCount} unit="rows" />
          </Row>
          <Verdict>{describePanel(layoutWidth, dpr, panelPrintedCm)}</Verdict>
          <button className="btn !h-7 mono text-[11px] justify-center" disabled={!canRun}
            onClick={() => run('panel', takePanel)}>{busyLabel('panel', 'Take the panel')}</button>
        </Section>

        <Section title="Compose what has been taken">
          <Row label="Grid">
            <Num value={cols} min={1} max={6} step={1} onChange={setCols} unit="columns" />
            <Num value={gutter} min={0} max={400} step={10} onChange={setGutter} unit="px gutter" />
            <Num value={margin} min={0} max={400} step={10} onChange={setMargin} unit="px margin" />
            <Num value={composedCm} min={4} max={19} step={0.5} onChange={setComposedCm} unit="cm printed" />
          </Row>
          <Row label="Shared crop">
            <label className="mono text-[10px] flex items-center gap-1.5" style={{ color: 'var(--text-dim)' }}
              title="One rectangle, in source pixels, applied to every rendered frame — so registration survives the crop. Panels are never cropped.">
              <input type="checkbox" checked={crop !== null}
                onChange={(e) => setCrop(e.target.checked ? { x: 0, y: 0, width: Math.round(figW * 0.8), height: Math.round(figH * 0.8) } : null)} />
              crop every rendered frame with one rectangle
            </label>
            {crop && <><Num value={crop.x} min={0} max={figW} step={10} onChange={(v) => setCrop({ ...crop, x: v })} unit="x" />
              <Num value={crop.y} min={0} max={figH} step={10} onChange={(v) => setCrop({ ...crop, y: v })} unit="y" />
              <Num value={crop.width} min={10} max={figW} step={10} onChange={(v) => setCrop({ ...crop, width: v })} unit="w" />
              <Num value={crop.height} min={10} max={figH} step={10} onChange={(v) => setCrop({ ...crop, height: v })} unit="h" /></>}
          </Row>
          <div className="flex flex-col gap-0.5">
            {shots.length === 0
              ? <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>Nothing taken this session yet. Every frame and panel above joins this list.</span>
              : shots.map((s, i) => (
                <div key={s.id} className="mono text-[9.5px] flex items-center gap-2" style={{ color: 'var(--text-dim)' }}>
                  <span style={{ color: 'var(--text-mute)', width: 24 }}>{i + 1}.</span>
                  <span className="flex-1 truncate">{s.label}</span>
                  <span className="tnum" style={{ color: 'var(--text-mute)' }}>{s.width} × {s.height}</span>
                  <button className="btn !h-4 !px-1 mono text-[9px]" onClick={() => setShots((p) => p.filter((x) => x.id !== s.id))}>remove</button>
                </div>
              ))}
          </div>
          {shots.length > 0 && <Verdict>{`${shots.length} image(s), ${Math.ceil(shots.length / cols)} × ${cols} — ${checkDpi(shotTotalWidth, composedCm, 'halftone').message}`}</Verdict>}
          <div className="flex gap-1.5">
            <button className="btn !h-7 mono text-[11px] justify-center flex-1" disabled={!canRun || shots.length === 0}
              onClick={() => run('compose', composeShots)}>{busyLabel('compose', 'Compose them')}</button>
            <button className="btn !h-7 mono text-[11px] justify-center" disabled={shots.length === 0 || !!busy}
              onClick={() => setShots([])}>Clear the list</button>
          </div>
        </Section>

        <Section title="A saved specification">
          <Row label="Take it again">
            <button className="btn !h-7 mono text-[11px] px-2" disabled={!desktop?.openFileDialog || !!busy}
              onClick={() => run('rerun', rerun)}>Load a specification…</button>
            <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>
              puts that image&rsquo;s own settings back into these controls
            </span>
          </Row>
        </Section>

        <div className="rounded-md px-2.5 py-2 flex flex-col gap-0.5" style={{ border: '1px solid var(--line)', minHeight: 90, background: 'var(--wash)' }}>
          {log.length === 0
            ? <span className="mono text-[10px]" style={{ color: 'var(--text-mute)' }}>Nothing taken yet.</span>
            : log.map((l, i) => (
              <span key={i} className="mono text-[10px]" style={{ color: tone[l.kind], lineHeight: 1.5 }}>{l.text}</span>
            ))}
        </div>
      </div>
    </div>
  );
}

/** How a direction reads, and how it names a file. */
function describeDirection(d: Direction): { text: string; file: string } {
  const named = viewNameOf(d);
  if (named) {
    const v = VIEWS.find((x) => x.id === named)!;
    return { text: v.label.toLowerCase(), file: named };
  }
  const az = Math.round(d.azimuth);
  const el = Math.round(d.elevation);
  return { text: `from the ${compass(az)} (${az}°), ${el}° up`, file: `az${az}_el${el}` };
}

/** The bearing and angle a saved camera was taken from, so a
 *  specification puts the controls back where they were. */
function directionFromCamera(cam: { position: [number, number, number]; target: [number, number, number] }): Direction {
  const dx = cam.position[0] - cam.target[0];
  const dy = cam.position[1] - cam.target[1];
  const dz = cam.position[2] - cam.target[2];
  const horiz = Math.hypot(dx, dy);
  const azimuth = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  const elevation = (Math.atan2(dz, horiz) * 180) / Math.PI;
  return { azimuth: Math.round(azimuth * 10) / 10, elevation: Math.round(elevation * 10) / 10 };
}

function describePanel(width: number, dpr: number, printedCm: number): string {
  const px = Math.round(width * dpr);
  const dpiV = checkDpi(px, printedCm, 'combination');
  const leg = checkLegibility(width, printedCm, TEXT.code);
  const bodyPt = ((TEXT.reason / width) * printedCm * 28.35).toFixed(1);
  return `${width} CSS px at ${dpr}× is ${px} device px — ${dpiV.message}. Body text sets at ${bodyPt} pt`
    + (leg.ok ? '.' : `; ${leg.message}.`);
}

// --- Small pieces, so the module reads as a form rather than a wall. ---

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md px-3 py-2.5 flex flex-col gap-2" style={{ border: '1px solid var(--line)', background: 'var(--wash)' }}>
      <div className="mono text-[11px]" style={{ color: 'var(--text)' }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="mono text-[10px]" style={{ color: 'var(--text-dim)', width: 128 }}>{label}</span>
      {children}
    </div>
  );
}

function RowDirection({ label, value, onChange }: {
  label: string;
  value: { direction: Direction; unclassified: Unclassified };
  onChange: (v: { direction: Direction; unclassified: Unclassified }) => void;
}) {
  return (
    <Row label={label}>
      {VIEWS.map((v) => (
        <Toggle key={v.id} on={viewNameOf(value.direction) === v.id} label={v.label} title={v.hint}
          onClick={() => onChange({ ...value, direction: directionOf(v.id) })} />
      ))}
      <Num value={value.direction.azimuth} min={0} max={359} step={5}
        onChange={(a) => onChange({ ...value, direction: { ...value.direction, azimuth: a } })} unit={`° ${compass(value.direction.azimuth)}`} />
      <Num value={value.direction.elevation} min={-90} max={90} step={5}
        onChange={(e) => onChange({ ...value, direction: { ...value.direction, elevation: e } })} unit="° up" />
      <Toggle on={value.unclassified === 'hidden'} label="unlabelled hidden"
        onClick={() => onChange({ ...value, unclassified: value.unclassified === 'hidden' ? 'grey' : 'hidden' })} />
    </Row>
  );
}

/** The colours people reach for first when the grey is wrong for the
 *  page — the viewer's grey stays first and is the default. */
const UNCLASSIFIED_SWATCHES: { hex: string; label: string }[] = [
  { hex: DEFAULT_UNCLASSIFIED_COLOR, label: 'grey' },
  { hex: '#b4b4b4', label: 'light grey' },
  { hex: '#3c3c3c', label: 'dark grey' },
  { hex: '#000000', label: 'black' },
  { hex: '#8c6d3f', label: 'brown' },
];

function Swatch({ hex, label, on, onClick }: { hex: string; label: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={`${label} — ${hex}`}
      className="mono text-[10px] flex items-center gap-1.5 px-1.5 py-0.5 rounded-md whitespace-nowrap"
      style={{
        color: on ? 'var(--accent)' : 'var(--text-dim)',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
        background: on ? 'color-mix(in oklch, var(--accent) 12%, transparent)' : 'transparent',
      }}>
      <span aria-hidden style={{ width: 12, height: 12, borderRadius: 3, background: hex, border: '1px solid var(--line)', display: 'inline-block' }} />
      {label}
    </button>
  );
}

function Verdict({ children }: { children: React.ReactNode }) {
  return <div className="mono text-[9.5px]" style={{ color: 'var(--text-mute)', lineHeight: 1.5 }}>{children}</div>;
}

function Num({ value, min, max, step, onChange, unit }: {
  value: number; min: number; max: number; step: number; onChange: (v: number) => void; unit: string;
}) {
  return (
    <span className="flex items-center gap-1">
      <input
        type="number" value={value} min={min} max={max} step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
        className="mono text-[10.5px] rounded-md px-1.5 py-0.5"
        style={{ width: 82, background: 'var(--wash)', border: '1px solid var(--line)', color: 'var(--text)' }}
      />
      <span className="mono text-[9.5px]" style={{ color: 'var(--text-mute)' }}>{unit}</span>
    </span>
  );
}

function Toggle({ on, label, onClick, title }: { on: boolean; label: string; onClick: () => void; title?: string }) {
  return (
    <button onClick={onClick} title={title} className="rounded-md px-2 py-0.5 mono text-[10.5px] whitespace-nowrap"
      style={{
        border: `1px solid ${on ? 'color-mix(in oklch, var(--accent) 55%, transparent)' : 'var(--line)'}`,
        background: on ? 'color-mix(in oklch, var(--accent) 10%, transparent)' : 'transparent',
        color: on ? 'var(--text)' : 'var(--text-dim)',
      }}>{label}</button>
  );
}

function Picker({ value, onChange, list }: { value: string; onChange: (v: string) => void; list: OctreeListEntry[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="mono text-[10.5px] rounded-md px-1.5 py-1 flex-1"
      style={{ background: 'var(--wash)', border: '1px solid var(--line)', color: 'var(--text)', maxWidth: 520 }}>
      {list.length === 0 && <option value="">no datasets in this project</option>}
      {list.map((e) => <option key={e.dir} value={e.dir}>{e.name}</option>)}
    </select>
  );
}
