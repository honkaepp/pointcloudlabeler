import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SURVEY_COLORS, addMesh, areaPolygon, bindDataset, changeParams, contourParams, corridor, dxfParams, fmtArea, getSurveyState,
  measure, meshParams, orthoParams, parseClasses, polygonArea, profileParams, removeMesh, resetSurveyStore, runSurveyJob,
  setSurveyState, surveyOverlay, updateMesh, volumeParams, type Vec3,
} from './surveyStore';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const RUST = read('../../../src-tauri/src/commands/octree/survey.rs') + read('../../../src-tauri/src/commands/octree/mesh.rs');

/** The fields of a Rust parameter struct, as serde renames them (camelCase). */
function rustFields(name: string): string[] {
  const m = RUST.match(new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`no struct ${name}`);
  return [...m[1].matchAll(/pub (\w+):/g)].map((f) => f[1].replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())).sort();
}

const SQUARE: Vec3[] = [[0, 0, 0], [3, 0, 0], [3, 4, 1], [0, 4, 1]];

describe('measuring', () => {
  it('matches the backend: lengths, plan area, heights', () => {
    // the same numbers as survey.rs measures_of_a_line_and_an_area
    const line = measure(SQUARE, false);
    expect(line.length2d).toBeCloseTo(10, 12);
    expect(line.length3d).toBeCloseTo(3 + Math.sqrt(17) + 3, 12);
    expect([line.area2d, line.heightRange, line.rise]).toEqual([0, 1, 1]);
    const area = measure(SQUARE, true);
    expect(area.length2d).toBeCloseTo(14, 12);
    expect(area.area2d).toBeCloseTo(12, 12);
    expect(measure([], false).length3d).toBe(0);
    expect(polygonArea([[0, 0], [2, 0], [2, 2], [0, 2]])).toBe(4);
    expect(fmtArea(25_000)).toMatch(/2\.5000 ha/);
  });

  it('draws a corridor the given width around a bent line', () => {
    const [left, right] = corridor([[0, 0, 0], [10, 0, 0], [10, 10, 0]], 2);
    expect(left[0]).toEqual([0, 1, 0]);
    expect(right[0]).toEqual([0, -1, 0]);
    // at the bend: on the bisector, √2 · half the width... from the vertex along it
    expect(left[1][0]).toBeCloseTo(10 - Math.SQRT1_2, 9);
    expect(left[1][1]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(right[2]).toEqual([11, 10, 0]);
  });
});

describe('the parameters are the backend structs', () => {
  beforeEach(() => resetSurveyStore());

  it('sends exactly the fields each Rust struct has', () => {
    setSurveyState({ points: SQUARE, closed: true, change: { ...getSurveyState().change, referenceDir: 'D:/b' } });
    const s = getSurveyState();
    expect(Object.keys(contourParams(s, 'D:/a')).sort()).toEqual(rustFields('ContourParams'));
    expect(Object.keys(volumeParams(s, 'D:/a')).sort()).toEqual(rustFields('VolumeParams'));
    expect(Object.keys(changeParams(s, 'D:/a')).sort()).toEqual(rustFields('VoxelChangeParams'));
    expect(Object.keys(orthoParams(s, 'D:/a')).sort()).toEqual(rustFields('OrthoParams'));
    expect(Object.keys(profileParams(s, 'D:/a')).sort()).toEqual(rustFields('ProfileParams'));
    expect(['octreeDir', 'name', 'points', 'closed'].sort()).toEqual(rustFields('GeometryParams'));
    expect(Object.keys(meshParams(s, 'D:/a')).sort()).toEqual(rustFields('MeshParams'));
    expect(Object.keys(dxfParams(s, 'D:/a')).sort()).toEqual(rustFields('DxfPointsParams'));
    const m = meshParams({ ...s, mesh: { ...s.mesh, stl: true, zLow: '150', zHigh: '' } }, 'D:/a');
    expect(m.formats).toEqual(['ply', 'obj', 'stl']);
    expect(m.zRange).toEqual([150, 1e9]);
    expect(meshParams(s, 'D:/a').zRange).toBeNull();
  });

  it('says what is missing', () => {
    const s = getSurveyState();
    expect(() => volumeParams(s, 'D:/a')).toThrow(/Draw an area/);
    expect(volumeParams({ ...s, volume: { ...s.volume, wholeDataset: true } }, 'D:/a').polygon).toEqual([]);
    expect(() => profileParams(s, 'D:/a')).toThrow(/section line/);
    expect(() => changeParams(s, 'D:/a')).toThrow(/compare with/);
    expect(() => contourParams({ ...s, contour: { ...s.contour, interval: '0' } }, 'D:/a')).toThrow(/Interval/);
    expect(() => parseClasses('2, x')).toThrow(/class x/);
    expect(parseClasses('2, 3;5')).toEqual([2, 3, 5]);
    // a line is not an area
    expect(areaPolygon({ ...s, points: SQUARE, closed: false })).toEqual([]);
    expect(areaPolygon({ ...s, points: SQUARE, closed: true })).toHaveLength(4);
    // the side view's depth window, open ended
    const side = orthoParams({ ...s, ortho: { ...s.ortho, view: 'side', depthNear: '-1', depthFar: '' } }, 'D:/a');
    expect(side.depth).toEqual([-1, 1e9]);
    expect(orthoParams(s, 'D:/a').depth).toBeNull();
  });
});

describe('the store', () => {
  beforeEach(() => resetSurveyStore());

  it('starts afresh for another dataset and keeps the settings', () => {
    bindDataset('D:/a');
    setSurveyState({ points: SQUARE, contour: { ...getSurveyState().contour, interval: '1' } });
    bindDataset('D:/a');
    expect(getSurveyState().points).toHaveLength(4);
    bindDataset('D:/b');
    expect(getSurveyState().points).toHaveLength(0);
    expect(getSurveyState().contour.interval).toBe('1');
  });

  it('draws the line, the corridor of a profile, contours and gone voxels', () => {
    setSurveyState({ points: SQUARE, closed: true });
    let o = surveyOverlay(getSurveyState());
    expect(o.segments).toHaveLength(4);
    expect(o.dots).toHaveLength(4);
    setSurveyState({ closed: false, tab: 'profile' });
    o = surveyOverlay(getSurveyState());
    expect(o.segments.filter((s) => s.color === SURVEY_COLORS.corridor)).toHaveLength(6);
    setSurveyState({
      contours: { lines: [{ z: 1, index: true, closed: false, points: [[0, 0, 1], [1, 0, 1], [2, 0, 1]] }], levels: 1, minZ: 0, maxZ: 2, lengthM: 2, files: [] },
      changeResult: { voxels: 1, referenceVoxels: 2, unchanged: 1, appeared: 0, disappeared: 1, appearedM3: 0, disappearedM3: 0.001, points: 1, pointsNew: 0, columnWritten: null, gone: [[5, 5, 5]], files: [] },
    });
    o = surveyOverlay(getSurveyState());
    expect(o.segments.filter((s) => s.color === SURVEY_COLORS.contourIndex)).toHaveLength(2);
    expect(o.dots.filter((d) => d.color === SURVEY_COLORS.gone)).toHaveLength(1);
    setSurveyState({ showContours: false, showGone: false });
    o = surveyOverlay(getSurveyState());
    expect(o.segments.some((s) => s.color === SURVEY_COLORS.contourIndex)).toBe(false);
  });
});

describe('meshes in the view', () => {
  beforeEach(() => resetSurveyStore());
  it('adds a file once, shows it again when made anew, and removes it', () => {
    addMesh('D:/p/mesh/a.ply');
    addMesh('D:/p/mesh/b.obj');
    expect(getSurveyState().meshes.map((m) => m.name)).toEqual(['a.ply', 'b.obj']);
    const id = getSurveyState().meshes[0].id;
    updateMesh('D:/p/mesh/a.ply', { visible: false });
    addMesh('D:/p/mesh/a.ply');
    const a = getSurveyState().meshes[0];
    expect(getSurveyState().meshes).toHaveLength(2);
    expect(a.visible).toBe(true);
    expect(a.id).not.toBe(id);
    removeMesh('D:/p/mesh/b.obj');
    expect(getSurveyState().meshes).toHaveLength(1);
  });
});

describe('a run', () => {
  const w = globalThis as Record<string, unknown>;
  let listener: ((e: { stage: string; pct: number }) => void) | null = null;
  beforeEach(() => {
    resetSurveyStore();
    w.window = { desktop: { onOctreeProgress: (cb: typeof listener) => { listener = cb; return () => { listener = null; }; } } };
  });
  afterEach(() => { delete w.window; });

  it('follows its stage, keeps the result and clears the job', async () => {
    const seen: number[] = [];
    const r = await runSurveyJob('volume', async () => {
      listener?.({ stage: 'volume', pct: 0.4 });
      listener?.({ stage: 'ortho', pct: 0.9 });
      seen.push(getSurveyState().job!.pct);
      return 42;
    });
    expect(r).toBe(42);
    expect(seen).toEqual([0.4]);
    expect(getSurveyState().job).toBeNull();
    expect(listener).toBeNull();
  });

  it('a failure is the error, and one run at a time', async () => {
    expect(await runSurveyJob('ortho', async () => { throw new Error('no points in the image'); })).toBeNull();
    expect(getSurveyState().error).toBe('no points in the image');
    let release: () => void = () => {};
    const first = runSurveyJob('profile', () => new Promise<number>((res) => { release = () => res(1); }));
    expect(await runSurveyJob('contours', async () => 2)).toBeNull();
    release();
    expect(await first).toBe(1);
  });
});

describe('the panel is wired in', () => {
  it('has its commands, ops, bridge, panel, overlay, menu and palette', () => {
    const lib = read('../../../src-tauri/src/lib.rs');
    for (const c of ['survey_contours', 'survey_volume', 'survey_voxel_change', 'survey_ortho', 'survey_profile', 'survey_save_geometry', 'survey_mesh', 'survey_dxf_points']) {
      expect(lib, c).toContain(`::${c},`);
      expect(read('../../persistence/desktopBridge.ts'), c).toContain(`'${c}', { params }`);
    }
    const ops = read('../../../src-tauri/src/ops/survey.rs');
    for (const o of ['ground.contours', 'ground.volume', 'change.voxels', 'export.ortho', 'export.profile', 'export.geometry', 'export.mesh', 'export.dxf']) expect(ops).toContain(`op!("${o}"`);
    expect(read('../../../src-tauri/src/ops/mod.rs')).toContain('v.extend(survey::ops());');
    expect(read('./OctreeShellContext.tsx')).toContain("export type PanelId = 'survey' | 'viewtools' |");
    expect(read('./ActivityBar.tsx')).toContain('<PanelToggle id="survey"');
    const shell = read('./EditorShell.tsx');
    expect(shell).toContain('<FloatingPanel id="survey"');
    expect(shell).toContain("surveyPaletteCommands(() => togglePanel('survey'))");
    expect(read('../../three/OctreeView.tsx')).toContain('<SurveyOverlay offset={octree.meta.offset} terrain={heights.flattenWith} zSpan={layerZSpan} />');
    expect(read('../../../src-tauri/src/menu.rs')).toContain('"panel-survey"');
    expect(read('./menuActions.ts')).toContain("'panel-survey': panel('survey')");
  });
});
