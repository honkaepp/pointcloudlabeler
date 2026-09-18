import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';

const read = (p: string) => stripComments(readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8'));
const rust = readFileSync(new URL('../../../src-tauri/src/commands/octree.rs', import.meta.url), 'utf8');

/** A tool's output has to be something the user can take back — the
 *  overlay off, the result dropped, the Report entry withdrawn, a written
 *  column removed — and a run that takes minutes has to say where it is
 *  and stop when told. This holds each analysis panel to that. */
describe('every analysis panel can be stopped and its output taken back', () => {
  it('M3C2: core spacing, chunked progress, stop, clear', () => {
    const panel = read('src/components/shell/M3C2Panel.tsx');
    expect(panel).toMatch(/coreSpacing: coreCm \/ 100,/);
    expect(panel).toMatch(/desktop\.octreeCancel\('m3c2'\)/);
    // The change map is a layer: added on a run, shown or hidden by
    // the layer's visibility, removed on Clear along with the summary.
    expect(panel).toMatch(/setLayerId\(overlay \? addAnalysisLayer\(\{\s*kind: 'm3c2',/);
    expect(panel).toMatch(/void setAnalysisLayerVisible\(layerId, !layer\.visible\)/);
    expect(panel).toMatch(/const clearAll = useCallback\(\(\) => \{\s*setResult\(null\); setError\(null\);\s*if \(layerId\) void removeAnalysisLayer\(layerId\);\s*setLayerId\(null\);\s*setM3c2Summary\(null\);/);
    expect(panel).toMatch(/Stopped — \{result\.coreCount\.toLocaleString\(\)\} core points were compared/);
    // The backend: one run at a time, reported per chunk, stoppable, and
    // the core points thinned to the spacing asked for.
    expect(rust).toMatch(/cancel::try_begin\("m3c2"\)/);
    expect(rust).toMatch(/cancel::token\("m3c2"\)/);
    expect(rust).toMatch(/super::m3c2::m3c2_with\(&ref_pts, &cmp_pts, &core, &params, &\|done, total\| \{/);
    expect(rust).toMatch(/Some\(cs\) if cs > voxel \* 1\.01 => super::m3c2::decimate\(&cmp_pts, cs as f32\)/);
    expect(rust).toMatch(/let stopped = res\.len\(\) < core\.len\(\);/);
    // …and the reads of the two clouds report and stop too — the first
    // 60 % of the bar.
    expect(rust).toMatch(/fn m3c2_load_decimated\(\s*dir: &Path, voxel: f64, off: \[f64; 3\],\s*cancel: &std::sync::atomic::AtomicBool, progress: &dyn Fn\(f32\),/);
    const core = readFileSync(new URL('../../../src-tauri/src/commands/m3c2.rs', import.meta.url), 'utf8');
    expect(core).toMatch(/\.par_iter\(\)\s*\.map_init\(Vec::<u32>::new,/);
    expect(core).toMatch(/if !on_chunk\(out\.len\(\), total\) \{ break; \}/);
  });

  it('tree growth and the ALS↔TLS join: progress per epoch, stop, clear', () => {
    for (const f of ['TreeGrowthPanel', 'CrossSensorPanel']) {
      const panel = read(`src/components/shell/${f}.tsx`);
      expect(panel, `${f} does not listen to the metrics channel`).toMatch(/if \(e\.stage === 'metrics'\) set(Metrics)?Pct\(e\.pct\)/);
      expect(panel, `${f} cannot stop the measurement`).toMatch(/desktop\.octreeCancel\('metrics'\)/);
      expect(panel, `${f} measures both clouds at once, so the bar means nothing`).not.toMatch(/Promise\.all\(\[\s*loadTreeMetrics/);
    }
    expect(read('src/components/shell/TreeGrowthPanel.tsx')).toMatch(/const clearAll = useCallback\(\(\) => \{\s*setResult\(null\); setError\(null\);\s*metricsRef\.current = null;\s*setGrowthSummary\(null\);/);
    expect(read('src/components/shell/CrossSensorPanel.tsx')).toMatch(/onClick=\{\(\) => \{ setLoaded\(null\); setError\(null\); \}\}/);
    // The measurement itself honours the stop.
    expect(rust).toMatch(/cancel::token\("metrics"\)/);
    expect(rust).toMatch(/if crate::commands::cancel::stopped\(&cancel\) \{ return Err\("stopped"\.to_string\(\)\); \}\s*progress\(0\.15 \+ 0\.7/);
  });

  it('stem taper: overlay off, or everything gone including the Report entry', () => {
    const panel = read('src/components/shell/StemTaperPanel.tsx');
    expect(panel).toMatch(/const clearAll = useCallback\(\(\) => \{\s*setResult\(null\);\s*setError\(null\);\s*void removeAnalysisLayer\(TAPER_LAYER\);\s*setTaperMeasurements\(null\);/);
    expect(panel).toMatch(/onClick=\{hideOverlay\}/);
    expect(panel).toMatch(/void setAnalysisLayerVisible\(TAPER_LAYER, !taperLayer\.visible\)/);
  });

  it('point QC: the column it writes can be removed again', () => {
    const panel = read('src/components/shell/PointQcPanel.tsx');
    expect(panel).toMatch(/desktop\.octreeRemoveExtra\(octree\.dir, 'point_quality'\)/);
    expect(panel).toMatch(/const hasColumn = !!octree\?\.meta\.extras\?\.some\(\(e\) => e\.name\.toLowerCase\(\) === 'point_quality'\)/);
    expect(panel).toMatch(/Remove the point_quality column/);
  });

  it('every overlay is a layer: one list, derived overlays, no panel-owned setter left', () => {
    const shell = read('src/components/shell/EditorShell.tsx');
    expect(shell).toMatch(/const \{ m3c2Overlay, stemCenterlines, skeletonOverlay \} = useMemo\(\(\) => deriveOverlays\(analysisLayers\), \[analysisLayers\]\)/);
    // A saved layer comes back hidden when the dataset opens; rasters at once.
    expect(shell).toMatch(/void listSavedLayers\(d, octreeDir\)\.then\(async \(\{ layers, headers \}\) => \{/);
    expect(shell).toMatch(/setAnalysisLayers\(\[\]\);\s*layerHeadersRef\.current\.clear\(\);/);
    for (const f of ['M3C2Panel', 'StemCenterlinePanel', 'StemTaperPanel', 'TreeHandlePanel']) {
      const panel = read(`src/components/shell/${f}.tsx`);
      expect(panel, `${f} still writes an overlay slot directly`).not.toMatch(/setStemCenterlines|setM3c2Overlay/);
      expect(panel, `${f} does not add a layer`).toMatch(/addAnalysisLayer\(/);
    }
    // The Layers panel is where the list is: eye, save, remove.
    const layers = read('src/components/shell/LayersPanel.tsx');
    expect(layers).toMatch(/analysisLayers\.map\(l => \(\s*<AnalysisRow/);
    expect(layers).toMatch(/onSave=\{\(\) => layerAction\(\(\) => saveAnalysisLayer\(l\.id\)\)\}/);
    expect(layers).toMatch(/await removeAnalysisLayer\(l\.id, \{ deleteFile: true \}\)/);
    expect(layers).toMatch(/onSave=\{\(\) => layerAction\(\(\) => saveRasterLayer\(l\.id\)\)\}/);
  });

  it('stem centrelines: overlay cleared, run stoppable', () => {
    const panel = read('src/components/shell/StemCenterlinePanel.tsx');
    expect(panel).toMatch(/const clearOverlay = useCallback\(\(\) => \{\s*void removeAnalysisLayer\(PLOT_LAYER\);\s*setResult\(null\);/);
    expect(panel).toMatch(/desktop\.octreeCancel\('centerlines'\)/);
  });
});

/** Every long run must be stoppable while it is running — and a stop
 *  must never leave a half-written dataset: the analysis passes honour
 *  it, the write-back at the end does not, so a stopped run changes
 *  nothing. Rewrites that cannot pause half-way (adding columns) have
 *  no Cancel, on purpose. */
describe('every long run can be stopped', () => {
  const stages = ['segment', 'li2012', 'treeiso', 'leafwood', 'deadwood', 'qsm', 'pointqc', 'terrain', 'density', 'stemfit', 'classify_ground', 'export', 'subset', 'metrics', 'm3c2', 'centerlines', 'tst', 'align'];

  it('takes a stop token in every stage that reports progress and runs for minutes', () => {
    for (const st of stages) {
      expect(rust, `stage ${st} has no cancel token`).toMatch(new RegExp(`cancel::token\\("${st}"\\)`));
    }
    // A stop is answered at a progress point of the analysis passes…
    expect((rust.match(/if crate::commands::cancel::stopped\(&cancel\) \{ return Err\("Stopped — nothing was changed\."\.to_string\(\)\); \}/g) ?? []).length).toBeGreaterThanOrEqual(12);
    // …and a stopped run that was building a new dataset or a file removes what it had made.
    expect(rust).toMatch(/Stopped — the partial dataset was removed\./);
    expect(rust).toMatch(/if matches!\(&r, Err\(e\) if e\.starts_with\("Stopped"\)\) \{ let _ = std::fs::remove_file\(out_path\); \}/);
  });

  it('offers Cancel wherever a stoppable run is started', () => {
    const helper = read('src/ui/cancelStage.ts');
    expect(helper).toMatch(/export function cancelStage\(\.\.\.stages: string\[\]\)/);
    const want: Array<[string, string[]]> = [
      ['src/components/shell/SegmentPanel.tsx', ["'segment'", "'li2012'", "'treeiso'", "'leafwood'", "'deadwood'"]],
      ['src/modules/MetricsModule.tsx', ["cancelStage('metrics')", "cancelStage('stemfit')", "cancelStage('qsm')"]],
      ['src/components/shell/GroundPanel.tsx', ["cancelStage('classify_ground', 'terrain')", "cancelStage('terrain', 'classify_ground')"]],
      ['src/components/shell/DensityMetricsPanel.tsx', ["cancelStage('density')"]],
      ['src/components/shell/PointQcPanel.tsx', ["cancelStage('pointqc')"]],
      ['src/components/shell/SubsetPanel.tsx', ["cancelStage('subset')"]],
      ['src/components/shell/EditorShell.tsx', ["cancelStage('export')"]],
      ['src/components/shell/RegistrationPanel.tsx', ['cancelStage(ALIGN_STAGE)']],
    ];
    for (const [file, needles] of want) {
      const src = read(file);
      for (const n of needles) expect(src, `${file} lacks ${n}`).toContain(n);
    }
    // The one rewrite that cannot stop half-way has no Cancel.
    expect(read('src/components/shell/SegmentPanel.tsx')).toMatch(/onClick=\{run\} label="Add deadwood columns"/);
  });
});
