import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import { treeIdColor } from '../three/palette';
import { sideElevationPose, obliquePose, type Box } from './recipes';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const module_ = stripComments(read('src/modules/FigureModule.tsx'));
const canvas = stripComments(read('src/figures/FigureCanvas.tsx'));

/** What a publication-quality image needs, as arithmetic and as pins on
 *  the parts that cannot be run without a GPU. */
describe('the figure exporter', () => {
  it('is a module of its own, and stays mounted across a tab switch', () => {
    // Its whole workflow is "take a frame, go to the Editor, come back"
    // — unmounting it on the way threw away the folder, the settings and
    // the frame it was holding.
    const app = stripComments(read('src/App.tsx'));
    expect(app).toMatch(/display: activeModule === 'figures' \? 'block' : 'none'/);
    expect(app, 'the module is torn down when another tab is shown').not.toMatch(/activeModule === 'figures' && \(/);
    expect(app).toMatch(/<ErrorBoundary label="Figures"><FigureModule \/><\/ErrorBoundary>/);
    expect(stripComments(read('src/components/ModuleTabs.tsx'))).toMatch(/id: 'figures'/);
  });

  it('remembers the folder, the settings and the held frame past a restart', () => {
    expect(module_).toMatch(/const saved = useRef<FigureSession>\(readSession\(\)\)\.current/);
    expect(module_).toMatch(/useState\(saved\.folder\)/);
    expect(module_).toMatch(/writeSession\(\{/);
    // The held frame is a file name, and the pixels come back from it —
    // so the pair composes after the application has been closed.
    expect(module_).toMatch(/const bytes = new Uint8Array\(await step\(`Reading \$\{held\.file\}`, 300, \(\) => desktop\.readFile!\(`\$\{folder\}\/\$\{held\.file\}`\)\)\)/);
    expect(module_).toMatch(/disabled=\{!canRun \|\| !held\}/);
    expect(read('src/persistence/settingsStore.ts')).toContain("'tree-seg-figure-session'");
    // Clearing the composing list must not throw the held frame away.
    expect(module_).toMatch(/onClick=\{\(\) => setShots\(\[\]\)\}>Clear the list/);
  });

  it('renders at the FIGURE’s node budget and blocks until the view is resident', () => {
    // A figure exported at whatever detail happens to be resident looks
    // sparse in print, and a reviewer cannot tell that from a genuinely
    // sparse airborne cloud.
    expect(canvas).toMatch(/planOverrideRef\.current = \{\s*width: req\.width, height: req\.height,\s*pointBudget: req\.pointBudget, pointSize: req\.pointSize,/);
    expect(canvas).toMatch(/settled = await settle\(statsRef, onProgress\)/);
    expect(canvas).toMatch(/pendingNodes \?\? 1\) === 0/);
    // …and the frame says so when it did not settle, rather than being
    // quietly short of points.
    expect(canvas).toMatch(/settled,/);
    expect(module_).toMatch(/the streamer had not gone quiet/);
    // The point size is the figure's own, in output pixels.
    expect(module_).toMatch(/figurePointSize\(1, 900, figH\)/);
  });

  it('names, times and bounds every wait, so a long one is not a hang', () => {
    // A figure's first frame in a matched height frame builds the
    // cloud's ground surface — one pass over the whole cloud, minutes on
    // a plot of hundreds of millions of points. That wait was silent and
    // unbounded, so the button read “Rendering…” and the run looked
    // broken; the ground is cached on disk, which is why a second
    // attempt came back at once.
    expect(module_).toMatch(/const step = useCallback\(async <T,>\(what: string, limitS: number, run: \(\) => Promise<T>\): Promise<T> => \{/);
    expect(module_).toMatch(/did not finish within \$\{limitS\} s/);
    // Every button shows the step it is on, not a fixed word.
    expect(module_).toMatch(/const busyLabel = \(what: string, idle: string\) => \(busy === what \? \(stage \? `\$\{stage\}…` : 'Working…'\) : idle\)/);
    expect(module_).toMatch(/exp\(req, \(what\) => setStage\(`\$\{label\} — \$\{what\}`\)\)/);
    // The ground surface: announced before it starts, bounded, and asked
    // for once per dataset.
    expect(module_).toMatch(/building the ground surface — one pass over the whole cloud/);
    expect(module_).toMatch(/await step\(`Building \$\{e\.name\}'s ground surface \(first time only\)`, 1800/);
    expect(module_).toMatch(/const had = groundCache\.current\.get\(e\.dir\);\s*if \(had !== undefined\) return had;/);
    // …and the streamer says what it is still waiting for while it
    // streams, rather than going quiet for minutes.
    expect(canvas).toMatch(/streaming — \$\{\(s\?\.visiblePoints \?\? 0\)\.toLocaleString\(\)\} points in/);
    // Opening a dataset is a step of its own, with its own deadline.
    expect(module_).toMatch(/await step\(`Opening \$\{entry\.name\}`, 300/);
  });

  it('draws the unclassified in the colour the user chose, in every frame', () => {
    // One choice for the module, carried in every request and written
    // into every specification, so a re-run draws the same colour.
    expect(module_).toMatch(/const \[unclassifiedColor, setUnclassifiedColor\] = useState\(saved\.unclassifiedColor\)/);
    expect(module_.match(/background, colorMode, unclassified(: rows\[r\]\.unclassified)?, unclassifiedColor,/g)?.length, 'every ViewportRequest carries it').toBe(3);
    expect(module_).toMatch(/colorMode, unclassified: unc, unclassifiedColor, camera,/);
    expect(module_).toMatch(/setUnclassifiedColor\(p\.unclassifiedColor\)/);
    expect(module_).toMatch(/<input type="color" value=\{unclassifiedColor\}/);
    expect(canvas).toMatch(/unlabeledColor: request\?\.unclassifiedColor \?\? DEFAULT_DISPLAY\.unlabeledColor/);
    // The comparison's distance is the user's, and remembered.
    expect(module_).toMatch(/<Num value=\{cmpDistance\} min=\{0\.2\} max=\{10\} step=\{0\.1\} onChange=\{setCmpDistance\}/);
    expect(module_).toMatch(/cmpIsolate, cmpTreeId, cmpIsolateMargin, cmpDistance,\s*panelDir/);
  });

  it('takes a pair from ONE camera, so the two frames register', () => {
    // A two-dataset comparison: one camera per row, derived from the box
    // the two clouds share, used for both columns.
    expect(module_).toMatch(/const cameras = rows\.map\(\(r\) => standOff\(cmpIsolate\s*\? treePose\(box, figW \/ figH, cmpIsolateMargin, r\.direction\)\s*: orbitPose\(box, figW \/ figH, r\.direction\), cmpDistance\)\)/);
    expect(module_).toMatch(/camera: cameras\[r\]/);
    expect(module_).toMatch(/: \[boxOf\(src, srcFrame\.base\), boxOf\(tgt, tgtFrame\.base\)\];/);
    expect(module_).toMatch(/const box = unionBox\(framed\);/);
    // A before-and-after pair: the first shot's camera is held for the
    // second, across whatever edit happens in between.
    expect(module_).toMatch(/\? await frameFor\(entry, direction\)\s*: \{ camera: held\.camera, zBase: held\.zBase, flatten: held\.flatten, box: held\.box \}/);
    expect(module_).toMatch(/setHeld\(\{\s*camera: frame\.camera/);
    // And the same box gives the same camera, to the last bit.
    const box: Box = { min: [0, 0, 0], max: [40, 40, 25] };
    expect(sideElevationPose(box, 4 / 3)).toEqual(sideElevationPose(box, 4 / 3));
    expect(obliquePose(box, 4 / 3)).toEqual(obliquePose(box, 4 / 3));
  });

  it('puts a set of clouds into ONE height frame, per point where they differ', () => {
    // A single ground level per cloud leaves the terrain's relief in the
    // one that is in elevation and not in the one already normalised,
    // and the two then stand at different heights tree by tree — which
    // is what a comparison came out as.
    expect(module_).toMatch(/const heightFrameFor = useCallback/);
    expect(module_).toMatch(/const mixed = guesses\.includes\('above_ground'\) && guesses\.includes\('absolute'\)/);
    expect(module_).toMatch(/const wanted = heights === 'auto' \? \(mixed \? 'above_ground' : 'stored'\) : heights/);
    expect(module_).toMatch(/out\.set\(entries\[i\]\.dir, \{ base: await groundLevelOf\(entries\[i\]\), flatten: true \}\)/);
    // …and the flattening is the renderer's own, per point, not a shift.
    // The ground is AWAITED before the frame is drawn: loading it beside
    // the render let the first frame of a pair come out unflattened.
    expect(canvas).toMatch(/if \(req\.flatten\) \{\s*onProgress\?\.\('reading the ground surface'\);\s*const t = await ensureTerrain\(\);/);
    expect(canvas, 'the ground is loaded beside the render again').not.toMatch(/void loadTerrain\(dir\)\.then/);
    expect(canvas).toMatch(/terrain=\{terrain\}/);
    expect(canvas).toMatch(/flatten: boolean;/);
    expect(module_).toMatch(/camera: cameras\[r\], zBase: frame\.base, flatten: frame\.flatten,/);
    // A cloud with no ground to flatten onto says so rather than coming
    // out silently in the wrong place.
    expect(canvas).toMatch(/has no ground classification, so its heights cannot be taken above ground/);
  });

  it('can cut a comparison to one tree, in both columns, from the box they share', () => {
    // Each cloud is isolated to ITS OWN copy of the id — the boxes
    // differ, which is what the comparison is about — while the camera
    // comes from the union, so the columns still register.
    expect(module_).toMatch(/const b = await treeBoxIn\(e, cmpTreeId\);/);
    expect(module_).toMatch(/const framed = cmpIsolate\s*\? \[shiftBox\(isoBoxes\.get\(src\.dir\)!, srcFrame\.base\), shiftBox\(isoBoxes\.get\(tgt\.dir\)!, tgtFrame\.base\)\]/);
    expect(module_).toMatch(/const box = unionBox\(framed\);/);
    expect(module_).toMatch(/const isoBox = cmpIsolate \? isoBoxes\.get\(entry\.dir\)! : null;/);
    expect(module_).toMatch(/isolateTreeId: isoBox \? cmpTreeId : null, isolateBox: isoBox,/);
    // An id one of the two does not have is refused, not rendered as an
    // empty half.
    expect(module_).toMatch(/the comparison would have an empty column/);
    expect(module_).toMatch(/isolate, in both columns/);
    expect(read('src/figures/figureSession.ts')).toMatch(/cmpIsolate: false, cmpTreeId: 1, cmpIsolateMargin: 1,/);
  });

  it('says that a frame comes from the dataset on disk', () => {
    expect(module_).toMatch(/Save the edit before taking/);
    expect(module_).toMatch(/Save edits<\/b> \(⌘S \/ Ctrl\+S\)/);
  });

  it('offers the general captures, not one fixed set of images', () => {
    // A frame from any view, of any dataset, whole or one tree.
    expect(module_).toMatch(/title="A single frame"/);
    expect(module_).toMatch(/title="A pair from one camera/);
    expect(module_).toMatch(/title="Two datasets, one camera per row"/);
    expect(module_).toMatch(/title="A panel"/);
    expect(module_).toMatch(/title="Compose what has been taken"/);
    // Every named view is a preset, and any other bearing and angle can
    // be typed — the camera is not limited to three directions.
    expect(module_).toMatch(/VIEWS\.map\(\(v\) => \(/);
    expect(module_).toMatch(/setDirection\(\{ \.\.\.direction, azimuth: v \}\)/);
    expect(module_).toMatch(/setDirection\(\{ \.\.\.direction, elevation: v \}\)/);
    expect(module_).toMatch(/function directionFromCamera\(/);
    expect(module_).toMatch(/const rows = Math\.ceil\(shots\.length \/ cols\)/);
    // The output name is the user's, not a fixed one.
    expect(module_).toMatch(/figureFileName\(name, 'composed', 'png'\)/);
  });

  it('names no publication, journal or manuscript', () => {
    const forbidden = /\bpaper\b|manuscript|SoftwareX|Elsevier|\bFig\. ?\d|figure \d/i;
    for (const [what, text] of [['module', module_], ['canvas', canvas]] as const) {
      const hit = text.split('\n').find((l) => forbidden.test(l));
      expect(hit, `${what} names a publication: ${hit ?? ''}`).toBeUndefined();
    }
  });

  it('lets the unlabelled points be hidden or greyed, per row and per frame', () => {
    // The grey occludes what a side view is about, and is the whole
    // evidence in an oblique one, so it is a choice and not a rule.
    expect(module_).toMatch(/unclassified: rows\[r\]\.unclassified/);
    expect(module_).toMatch(/unclassified: value\.unclassified === 'hidden' \? 'grey' : 'hidden'/);
    expect(read('src/figures/figureSession.ts')).toMatch(/rowA: \{ direction: \{ azimuth: 180, elevation: 0 \}, unclassified: 'hidden' \}/);
    expect(canvas).toMatch(/hideUnassigned: request\?\.unclassified === 'hidden'/);
    expect(canvas).toMatch(/isolateShowUnassigned: request\?\.unclassified !== 'hidden'/);
  });

  it('offers every QC check as its own chip, not one lump', () => {
    expect(module_).toMatch(/const ALL_CODES = Object\.keys\(FLAG_LABEL\) as FlagCode\[\]/);
    expect(module_).toMatch(/ALL_CODES\.map\(\(code\) => \{/);
    expect(module_).toMatch(/setHiddenCodes\(\(h\) => \(h\.includes\(code\) \? h\.filter\(\(c\) => c !== code\) : \[\.\.\.h, code\]\)\)/);
    // The starting set: the three QSM checks and the missing-DBH one
    // out, every other check in.
    expect(module_).toMatch(/const DEFAULT_HIDDEN: FlagCode\[\] = \['qsm-coverage', 'qsm-completeness', 'qsm-volume', 'no-dbh'\]/);
  });

  it('colours both datasets through the same palette, so an inherited id is one colour', () => {
    // The claim Fig. 3 exists to prove. The palette is a pure function
    // of the id — no dataset, no state, no restart.
    expect(treeIdColor(36)).toEqual(treeIdColor(36));
    expect(treeIdColor(36)).not.toEqual(treeIdColor(37));
    // The figure canvas takes the viewport's own display defaults and
    // only overrides what a figure must: it never substitutes a palette.
    expect(canvas).toMatch(/\.\.\.DEFAULT_DISPLAY,/);
    expect(canvas).not.toMatch(/treeIdColor|palette/);
  });

  it('writes a specification beside every figure, and can load one back', () => {
    expect(module_).toMatch(/serializeSidecar\(sidecar\)/);
    expect(module_).toMatch(/serializeSpec\(spec\)/);
    expect(module_).toMatch(/appVersion: __APP_VERSION__, commit: __GIT_COMMIT__/);
    expect(module_).toMatch(/parseSpec\(text\)/);
    expect(stripComments(read('vite.config.ts'))).toMatch(/__GIT_COMMIT__: JSON\.stringify\(gitCommit\(\)\)/);
  });

  it('saves through the writer the desktop build actually has', () => {
    expect(module_).toMatch(/desktop\.writeFileBytes\(path, bytes\)/);
    expect(module_, 'a figure saved through a browser download would silently do nothing')
      .not.toMatch(/createObjectURL|a\.download/);
  });

  it('is read-only: nothing in the figure code writes a dataset file', () => {
    const files = readdirSync(new URL('../../src/figures/', import.meta.url))
      .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.endsWith('.test.ts'))
      .map((f) => `src/figures/${f}`)
      .concat('src/modules/FigureModule.tsx');
    const guarded = /octree\.bin|patches\.bin|treemap\.json|review\.json|species\.json|savePatches|octreeWrite|octreeReset|octreeNormalize/;
    const offenders = files.filter((f) => guarded.test(stripComments(read(f))));
    expect(offenders, 'a figure export must not touch the dataset it renders').toEqual([]);
  });

  it('states the dpi and the printed type size before anything is written', () => {
    expect(module_).toMatch(/const dpiV = checkDpi\(raster\.width, panelPrintedCm, 'combination'\)/);
    expect(module_).toMatch(/function describePanel\(/);
    expect(module_).toMatch(/if \(!legible\.ok\) \{ say\(`Refused: \$\{legible\.message\}`, 'err'\)/);

  });
});
