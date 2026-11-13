// Data files as layers: what each file is, the points and lines
// read from CSV, GeoJSON and shapefiles, and that the panels, the data door
// and the Layers panel open them so.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import { LAYER_KINDS, classifyOutput, groundGridOf, isElevationGrid, parseFeatures, parseGeoJson, parsePointTable, parseShapefile, splitCsv } from './fileLayers';
import {
  insideFolder, layerState, layersToSave, openFileLayer, removeFileLayer, setLayerVisible,
} from '../components/shell/fileLayerActions';
import { getSurveyState, resetSurveyStore } from '../components/shell/surveyStore';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('what a run\'s file is', () => {
  it.each([
    ['C:/p/run/plot/plot.laz', 'cloud'],
    ['C:/p/run/plot/plot_clean.laz', 'cloud'],
    ['C:/p/run/plot/plot.ply', 'cloud'],
    ['C:/p/run/plot/plot_traj.txt', 'trajectory'],
    ['C:/p/run/plot/plot_traj_map.txt', 'trajectory'],
    ['C:/p/run/plot/plot_frames.txt', 'trajectory'],
    ['C:/p/run/plot/plot_report.json', 'report'],
    ['C:/p/run/plot/plot_crop_region.shp', 'region'],
    ['C:/p/run/plot/plot_crop_region.geojson', 'region'],
    ['C:/p/run/plot/plot_stems.csv', 'stems'],
    ['C:/p/run/plot/plot_georef.csv', 'matrix'],
    ['C:/p/run/plot/plot_gaps_pad.ply', 'voxels'],
    ['C:/p/run/plot/plot_gaps_cover.asc', 'raster'],
    ['C:/p/run/plot/plot_gaps_summary.txt', 'report'],
    ['C:/p/scan/evo/evo_scan_positions.csv', 'positions'],
    ['C:/p/scan/evo/evo_scan_positions.geojson', 'other'],
    ['C:/p/scan/evo/evo_targets.csv', 'targets'],
    ['C:/p/scan/evo/evo_control_points.csv', 'other'],
    ['C:/p/scan/evo/evo_report.json', 'report'],
    ['C:/p/scan/evo/evo_align_trees.csv', 'stems'],
    ['C:/p/octrees/a/qsm/trees.ply', 'mesh'],
    ['C:/p/qsm/forest.qsf', 'qsm'],
    ['C:/p/mesh/ground.obj', 'mesh'],
    ['C:/p/scan/evo/panoramas/ScanPos001.jpg', 'image'],
  ] as const)('%s → %s', (path, kind) => {
    expect(classifyOutput(path)).toBe(kind);
  });
  it('a grid is an elevation, or a quantity draped on its run\'s ground', () => {
    expect(classifyOutput('C:/p/octrees/a/terrain/dtm.tif')).toBe('other');
    expect(isElevationGrid('C:/p/run/plot/plot_gaps_ground.asc')).toBe(true);
    expect(isElevationGrid('C:/p/octrees/a/terrain/dtm.asc')).toBe(true);
    expect(isElevationGrid('C:/p/run/plot/plot_gaps_cover.asc')).toBe(false);
    expect(groundGridOf('C:/p/run/plot/plot_gaps_cover.asc')).toBe('C:/p/run/plot/plot_gaps_ground.asc');
    expect(groundGridOf('C:\\p\\plot_gaps_pai.asc')).toBe('C:\\p\\plot_gaps_ground.asc');
    expect(groundGridOf('C:/p/run/plot/plot_gaps_ground.asc')).toBeNull();
    expect(groundGridOf('C:/p/octrees/a/terrain/chm.asc')).toBeNull();
  });
});

describe('points and lines from files', () => {
  it('splits CSV fields, quoted ones whole', () => {
    expect(splitCsv('a,"b, c",3')).toEqual(['a', 'b, c', '3']);
    expect(splitCsv('x;y;z')).toEqual(['x', 'y', 'z']);
    expect(splitCsv('1\t2')).toEqual(['1', '2']);
  });
  it('reads scan positions with their names', () => {
    const f = parsePointTable('name,number,scans,x,y,z,crs\nScanPos001,1,a,500000.1,7000000.2,101.3,"EPSG:3067"\nScanPos002,2,b,500010,7000005,102\n');
    expect(f.points).toEqual([
      { x: 500000.1, y: 7000000.2, z: 101.3, label: 'ScanPos001' },
      { x: 500010, y: 7000005, z: 102, label: 'ScanPos002' },
    ]);
  });
  it('reads stems as circles at breast height, and targets with their diameter', () => {
    const stems = parsePointTable('id,x,y,ground_z,dbh_cm,residual_sd_mm\n1,10,20,100,30,2\n2,11,21,,24,3\n');
    expect(stems.points[0]).toEqual({ x: 10, y: 20, z: 101.3, label: '1', radius: 0.15 });
    expect(stems.points[1].z).toBeNull();
    expect(stems.points[1].radius).toBeCloseTo(0.12);
    const targets = parsePointTable('id,x,y,z,crs,shape,diameter\nT1,1,2,3,"x",Disc,0.1\n');
    expect(targets.points[0]).toMatchObject({ label: 'T1', radius: 0.05, z: 3 });
    expect(() => parsePointTable('a,b\n1,2\n')).toThrow(/x and y/);
  });
  it('reads GeoJSON points, lines and polygons, and knows degrees from metres', () => {
    const f = parseGeoJson(JSON.stringify({
      type: 'FeatureCollection', features: [
        { type: 'Feature', properties: { name: 'P' }, geometry: { type: 'Point', coordinates: [500000, 7000000, 100] } },
        { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10]]] } },
        { type: 'Feature', properties: null, geometry: { type: 'MultiLineString', coordinates: [[[1, 1], [2, 2]], [[3, 3], [4, 4]]] } },
      ],
    }));
    expect(f.points).toEqual([{ x: 500000, y: 7000000, z: 100, label: 'P' }]);
    expect(f.lines[0]).toEqual([[0, 0, null], [10, 0, null], [10, 10, null], [0, 0, null]]);
    expect(f.lines.length).toBe(3);
    expect(f.lonLat).toBe(false);
    expect(parseGeoJson(JSON.stringify({ type: 'Point', coordinates: [29.7, 62.6] })).lonLat).toBe(true);
  });
  it('reads a polygon shapefile (the crop region)', () => {
    // one polygon record: a square of four points (closed by the file)
    const pts = [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]];
    const content = 4 + 32 + 4 + 4 + 4 + 16 * pts.length;
    const buf = new ArrayBuffer(100 + 8 + content);
    const dv = new DataView(buf);
    dv.setInt32(0, 9994, false);
    dv.setInt32(24, buf.byteLength / 2, false);
    dv.setInt32(32, 5, true);
    dv.setInt32(100, 1, false);
    dv.setInt32(104, content / 2, false);
    const r = 108;
    dv.setInt32(r, 5, true);
    dv.setInt32(r + 36, 1, true);
    dv.setInt32(r + 40, pts.length, true);
    dv.setInt32(r + 44, 0, true);
    pts.forEach(([x, y], i) => { dv.setFloat64(r + 48 + 16 * i, x, true); dv.setFloat64(r + 56 + 16 * i, y, true); });
    const f = parseShapefile(buf);
    expect(f.lines).toEqual([pts.map(([x, y]) => [x, y, null])]);
    expect(parseFeatures('C:/x/region.shp', buf).lines.length).toBe(1);
    expect(() => parseShapefile(new ArrayBuffer(120))).toThrow(/shapefile/);
  });
});

describe('opening a file as what it is', () => {
  beforeEach(() => { resetSurveyStore(); (globalThis as Record<string, unknown>).window = { desktop: {}, dispatchEvent: () => true }; });
  afterEach(() => { delete (globalThis as Record<string, unknown>).window; });

  it('a trajectory, a mesh and a feature file each go to their layer list', async () => {
    expect(await openFileLayer('C:/p/run/plot/plot_traj.txt')).toBe('trajectory');
    expect(await openFileLayer('C:/p/mesh/ground.obj')).toBe('mesh');
    expect(await openFileLayer('C:/p/scan/evo/evo_scan_positions.csv')).toBe('positions');
    const s = getSurveyState();
    expect(s.trajectories.map((t) => t.path)).toEqual(['C:/p/run/plot/plot_traj.txt']);
    expect(s.meshes.map((m) => m.path)).toEqual(['C:/p/mesh/ground.obj']);
    expect(s.features).toMatchObject([{ path: 'C:/p/scan/evo/evo_scan_positions.csv', kind: 'positions', visible: true }]);
    expect(await openFileLayer('C:/p/run/plot/plot_gaps_cover.asc')).toBe('raster');
    expect(getSurveyState().features.at(-1)).toMatchObject({ kind: 'raster', visible: true });
    removeFileLayer('C:/p/run/plot/plot_gaps_cover.asc');
    setLayerVisible('C:/p/scan/evo/evo_scan_positions.csv', false);
    expect(layerState('C:/p/scan/evo/evo_scan_positions.csv')).toEqual({ shown: true, visible: false });
    removeFileLayer('C:/p/scan/evo/evo_scan_positions.csv');
    expect(layerState('C:/p/scan/evo/evo_scan_positions.csv').shown).toBe(false);
    await expect(openFileLayer('C:/p/run/plot/plot_report.json')).rejects.toThrow(/not shown as a layer/);
  });
  it('a project keeps the layers inside its folder', async () => {
    await openFileLayer('C:/proj/run/plot/plot_traj.txt');
    await openFileLayer('D:/elsewhere/x_traj.txt');
    await openFileLayer('C:\\proj\\scan\\evo\\evo_targets.csv');
    const saved = layersToSave(getSurveyState(), 'C:/proj');
    expect(saved.map((l) => [l.kind, l.path])).toEqual([
      ['trajectory', 'C:/proj/run/plot/plot_traj.txt'],
      ['targets', 'C:\\proj\\scan\\evo\\evo_targets.csv'],
    ]);
    expect(insideFolder('C:/proj2/a.txt', 'C:/proj')).toBe(false);
    expect(insideFolder('c:\\PROJ\\a.txt', 'C:/proj/')).toBe(true);
  });
});

describe('the files are reachable', () => {
  it('Layers lists the run outputs, opens files and shows the layers as rows', () => {
    const layers = read('../components/shell/LayersPanel.tsx');
    expect(layers).toContain('<ProjectFiles datasets={list} onOpenDataset={onOpen} />');
    expect(layers).toContain('<FileLayerRows Row={Row} />');
    expect(layers).toContain('onClick={() => void pickFileLayer((m) => setLayerError(m))}');
    expect(read('../three/OctreeView.tsx')).toContain('zSpan={layerZSpan}');
    expect(read('../three/SurveyOverlay.tsx')).toContain('<SurveyFeatures offset={offset} terrain={terrain} zSpan={zSpan} />');
    // a raster file: an ASCII grid as a surface, on its run's ground
    expect(read('../three/SurveyOverlay.tsx')).toContain("? <RasterFileLayer key={f.id} path={f.path} offset={offset} terrain={terrain} zSpan={zSpan} />");
  });
  it('the backend lists them, registered and bridged', () => {
    expect(read('../../src-tauri/src/lib.rs')).toContain('commands::outputs::project_files,');
    expect(read('../persistence/desktopBridge.ts')).toContain("projectFiles: () => ctx.invoke<unknown>('project_files'),");
  });
  it('a dropped layer file opens as a layer; a project restores its layers', () => {
    const door = read('../components/DataDoor.tsx');
    expect(door).toContain("const isLayer = (e: DataEntry) => !e.isDir && (LAYER_KINDS.has(classifyOutput(e.path)) || classifyOutput(e.path) === 'qsm');");
    expect(door).toContain('useProjectFileLayers(project?.folder ?? null);');
    expect(LAYER_KINDS.has('trajectory') && LAYER_KINDS.has('positions') && !LAYER_KINDS.has('cloud')).toBe(true);
  });
});
