import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';
import {
  FINE_REG_DEFAULTS, REGISTER_STAGE, TRANSFORM_STAGE, coarseVerdict, constraintVerdict, copyOutDir, defaultCopyName,
  describeTranslation, histogramBars, isWorthApplying, lengthText, plusMinus, quotedStdErr, registerStageLabel, rotationAtPlotEdge,
  type FineRegistrationReport,
} from './fineRegistration';

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

/** The Cloud registration panel measures a horizontal shift from
 *  skeletons and cannot rotate; the Preprocessing module registers scan
 *  positions, not datasets. Two datasets on each other in six degrees of
 *  freedom, with the error bar on every parameter, is this panel —
 *  and its numbers have to read in the units a person judges them in. */
describe('the fine registration arithmetic', () => {
  it('reads a length in the unit it is best read in', () => {
    expect(lengthText(0.00042)).toBe('0.42 mm');
    expect(lengthText(0.0312)).toBe('3.12 cm');
    expect(lengthText(1.5)).toBe('1.500 m');
    expect(lengthText(NaN)).toBe('—');
  });

  it('prints a value with its standard error in the finer unit', () => {
    expect(plusMinus(0.6131, 0.00012, 'm')).toBe('+0.6131 m ± 0.12 mm');
    expect(plusMinus(-0.4, 0.0031, 'm')).toBe('−0.4000 m ± 3.1 mm');
    expect(plusMinus(-1.97, 0.0003, 'deg')).toBe('−1.9700° ± 3.0e-4°');
    expect(plusMinus(0.5, 0.012, 'deg')).toBe('+0.5000° ± 0.0120°');
    expect(plusMinus(0.5, 0, 'm')).toBe('+0.5000 m');
    expect(plusMinus(NaN, 1, 'm')).toBe('—');
  });

  it('describes a move with its signs and its length', () => {
    expect(describeTranslation([0.6, -0.4, 0.1])).toBe('+0.600 m east, −0.400 m north, +0.100 m up (0.728 m)');
  });

  it('puts the rotation at the plot\u2019s edge, as a distance', () => {
    // A 30 × 30 m plot, 1.5° of yaw: 21.2 m × 0.02618 rad = 0.555 m.
    expect(rotationAtPlotEdge([0, 0, 1.5], [0, 0, 0], [30, 30, 20])).toBeCloseTo(0.555, 3);
    expect(rotationAtPlotEdge([0, 0, 0], [0, 0, 0], [30, 30, 20])).toBe(0);
  });

  it('reads the condition number as a verdict on what was measured', () => {
    expect(constraintVerdict(15, 'translation along x')).toMatchObject({ ok: true, label: 'every direction constrained' });
    expect(constraintVerdict(725, 'translation along y').label).toMatch(/weakly constrained along translation along y/);
    expect(constraintVerdict(3e8, 'translation along x').label).toMatch(/chosen, not measured/);
    expect(constraintVerdict(Infinity, 'rotation about z (yaw)').label).toMatch(/was not measured/);
    expect(constraintVerdict(725, 'x').ok).toBe(false);
  });

  it('quotes the larger error bar — the jackknife where it has one', () => {
    expect(quotedStdErr(0.0001, 0.0003)).toBe(0.0003);
    expect(quotedStdErr(0.0003, 0.0001)).toBe(0.0003);
    expect(quotedStdErr(0.0002, NaN)).toBe(0.0002);
  });

  it('reads the coarse vote\u2019s confidence as words', () => {
    expect(coarseVerdict(2.0)).toBe('unambiguous');
    expect(coarseVerdict(1.15)).toBe('likely');
    expect(coarseVerdict(1.0)).toMatch(/guess/);
  });

  it('labels the run\u2019s stages at the milestones the Rust side reports', () => {
    expect(registerStageLabel(0.05, 'auto')).toMatch(/Coarse search/);
    expect(registerStageLabel(0.05, 'current')).toMatch(/Starting/);
    expect(registerStageLabel(0.05, 'features')).toMatch(/Feature search/);
    expect(registerStageLabel(0.2, 'current')).toMatch(/reference/);
    expect(registerStageLabel(0.4, 'current')).toMatch(/moving/);
    expect(registerStageLabel(0.8, 'current')).toMatch(/Fitting/);
  });

  it('names and places the moved copy beside its source, as the Subset panel does', () => {
    expect(defaultCopyName('plot 2025')).toBe('plot 2025 registered');
    expect(copyOutDir('/evo/octrees/plot_2025', 'plot 2025 registered')).toBe('/evo/octrees/plot 2025 registered');
    expect(copyOutDir('C:\\evo\\octrees\\plot_2025\\', 'a/b:c')).toBe('C:\\evo\\octrees/a_b_c');
  });

  it('scales the histogram to its tallest bar and marks the centre', () => {
    const bars = histogramBars([1, 4, 2]);
    expect(bars.map((b) => b.h)).toEqual([0.25, 1, 0.5]);
    expect(bars.map((b) => b.centre)).toEqual([false, true, false]);
    expect(histogramBars([0, 0]).every((b) => b.h === 0)).toBe(true);
  });

  it('does not call a tenth of a millimetre a move', () => {
    const base = {
      referenceDir: 'r', movingDir: 'm', referenceName: 'r', movingName: 'm', matrix: [], initMatrix: [], initMode: 'current',
      origin: [0, 0, 0], centreWorld: [0, 0, 0], referencePoints: 1, movingPoints: 1, seconds: 1,
      report: {
        translation: [0.0001, 0, 0], rotationDeg: [0, 0, 0], translationStdErr: [0, 0, 0], rotationStdErrDeg: [0, 0, 0],
        rmse: 0, medianAbs: 0, sigma: 0, inliers: 0, inlierFraction: 0, overlapFraction: 0, iterations: 0, converged: true,
        levels: [], condition: 1, weakest: '', wellConstrained: true, histMin: 0, histWidth: 0, histBins: [],
      },
    } as unknown as FineRegistrationReport;
    expect(isWorthApplying(base, [0, 0, 0], [30, 30, 10])).toBe(false);
    const turned = { ...base, report: { ...base.report, rotationDeg: [0, 0, 0.01] } } as FineRegistrationReport;
    // 0.01° over a 30 m plot is 3.7 mm at the edge: a move.
    expect(isWorthApplying(turned, [0, 0, 0], [30, 30, 10])).toBe(true);
    const moved = { ...base, report: { ...base.report, translation: [0.002, 0, 0] } } as FineRegistrationReport;
    expect(isWorthApplying(moved, [0, 0, 0], [30, 30, 10])).toBe(true);
  });
});

/** The panel starts from the Rust side's defaults; what can drift is the
 *  two copies of them. The literals are read out of register.rs and
 *  octree.rs and held against the panel's. */
describe('the defaults agree between the panel and the Rust core', () => {
  const core = read('src-tauri/src/commands/register.rs');
  const octree = read('src-tauri/src/commands/octree.rs');
  const literal = (src: string, fn: string): string => {
    const m = src.match(new RegExp(`fn ${fn}\\(\\) -> [\\w:]+ \\{ ([^}]+) \\}`));
    if (!m) throw new Error(`no fn ${fn}`);
    return m[1].trim();
  };
  const num = (s: string) => Number(s.replace(/_/g, ''));

  it('the fit', () => {
    expect(num(literal(core, 'd_voxel')) * 100).toBe(FINE_REG_DEFAULTS.voxelCm);
    expect(num(literal(core, 'd_levels'))).toBe(FINE_REG_DEFAULTS.levels);
    expect(num(literal(core, 'd_corr'))).toBe(FINE_REG_DEFAULTS.maxCorrDist);
    expect(num(literal(core, 'd_iters'))).toBe(FINE_REG_DEFAULTS.maxIters);
    expect(num(literal(core, 'd_normal_k'))).toBe(FINE_REG_DEFAULTS.normalK);
    expect(num(literal(core, 'd_angle'))).toBe(FINE_REG_DEFAULTS.maxNormalAngleDeg);
    expect(num(literal(core, 'd_floor')) * 1000).toBe(FINE_REG_DEFAULTS.kernelFloorMm);
    expect(num(literal(core, 'd_max_points'))).toBe(FINE_REG_DEFAULTS.maxPoints);
    expect(num(literal(core, 'd_block'))).toBe(FINE_REG_DEFAULTS.jackknifeBlock);
    expect(literal(core, 'd_method')).toBe('Method::Symmetric');
    expect(literal(core, 'd_kernel')).toBe('Kernel::Welsch');
    expect(literal(core, 'd_dof')).toBe('Dof::Full');
    expect(FINE_REG_DEFAULTS.method).toBe('symmetric');
    expect(FINE_REG_DEFAULTS.kernel).toBe('welsch');
    expect(FINE_REG_DEFAULTS.dof).toBe('full');
  });

  it('the start', () => {
    expect(literal(octree, 'init_current')).toBe('RegisterInitMode::Current');
    expect(FINE_REG_DEFAULTS.init).toBe('current');
    expect(num(literal(octree, 'f_30'))).toBe(FINE_REG_DEFAULTS.searchRadius);
    expect(num(literal(octree, 'f_5'))).toBe(FINE_REG_DEFAULTS.yawRangeDeg);
    expect(octree).toMatch(/#\[serde\(default = "f_30"\)\]\s+pub search_radius: f64,/);
    expect(octree).toMatch(/#\[serde\(default = "f_5"\)\]\s+pub yaw_range_deg: f64,/);
    expect(octree).toMatch(/#\[serde\(default = "f_0_5"\)\]\s+pub dtm_cell: f64,/);
    expect(num(literal(octree, 'f_0_5'))).toBe(FINE_REG_DEFAULTS.dtmCell);
    expect(octree).toMatch(/#\[serde\(default = "f_0_3"\)\]\s+pub feature_voxel: f64,/);
    expect(num(literal(octree, 'f_0_3'))).toBe(FINE_REG_DEFAULTS.featureVoxel);
  });

  it('the headless operation takes the same defaults from the core', () => {
    const ops = read('src-tauri/src/ops/registration.rs');
    expect(ops).toMatch(/fn d_voxel\(\) -> f64 \{ dflt\(\)\.voxel \}/);
    expect(ops).toMatch(/fn d_search\(\) -> f64 \{ init_dflt\(\)\.search_radius \}/);
  });
});

describe('the Fine registration panel', () => {
  const panel = stripComments(read('src/components/shell/FineRegistrationPanel.tsx'));
  const rust = stripComments(read('src-tauri/src/commands/octree.rs'));

  it('is a panel of its own, reachable like the others', () => {
    expect(read('src/components/shell/OctreeShellContext.tsx')).toMatch(/\| 'finereg' \|/);
    const shell = read('src/components/shell/EditorShell.tsx');
    expect(shell).toMatch(/import FineRegistrationPanel from '\.\/FineRegistrationPanel';/);
    expect(shell).toMatch(/<FloatingPanel id="finereg" title="Fine registration"[\s\S]*?>\s*<FineRegistrationPanel \/>/);
    expect(shell).toMatch(/panel\('finereg', 'Toggle Fine registration panel'\);/);
    expect(read('src/components/shell/ActivityBar.tsx')).toMatch(/<PanelToggle id="finereg"/);
    expect(read('src/components/shell/menuActions.ts')).toMatch(/'panel-finereg': panel\('finereg'\),/);
    expect(read('src-tauri/src/menu.rs')).toMatch(/"Fine Registration…", "panel-finereg"/);
  });

  it('measures through the bridge on its own stage, with a Stop, and writes through the other', () => {
    expect(panel).toMatch(/desktop\.octreeRegister\(referenceDir, movingDir, \{/);
    expect(panel).toMatch(/desktop\.octreeTransformDataset\(movingDir, copyOutDir\(movingDir, name\), name, result\.matrix, \{/);
    expect(panel).toMatch(/cancelStage\(busy === 'apply' \? TRANSFORM_STAGE : REGISTER_STAGE\)/);
    expect(panel).toMatch(/if \(s === stage\) setPct\(p\);/);
    expect(REGISTER_STAGE).toBe('register');
    expect(TRANSFORM_STAGE).toBe('transform');
    // The open cloud's edits reach the disk before the clouds are read.
    expect(panel).toMatch(/await saveOpenIfNeeded\(\);\s*const r = await desktop\.octreeRegister/);
    // The copy is a new dataset, and the list learns of it.
    expect(panel).toMatch(/await refreshDatasets\?\.\(\);/);
    const bridge = read('src/persistence/desktopBridge.ts');
    expect(bridge).toMatch(/'octree_register', \{ referenceDir, movingDir, init, params \}/);
    expect(bridge).toMatch(/'octree_transform_dataset', \{ octreeDir, outDir, name, matrix, record \}/);
    expect(read('src-tauri/src/lib.rs')).toMatch(/octree::octree_register,\s*octree::octree_transform_dataset,/);
  });

  it('runs one at a time, stoppable, and a stopped copy is removed', () => {
    expect(rust).toMatch(/cancel::try_begin\("register"\)/);
    expect(rust).toMatch(/cancel::token\("register"\)/);
    expect(rust).toMatch(/cancel::try_begin\("transform"\)/);
    expect(rust).toMatch(/cancel::token\("transform"\)/);
    expect(rust).toMatch(/if crate::commands::cancel::stopped\(&cancel\) \{ let _ = std::fs::remove_dir_all\(&out_path\); return Err\("Stopped — the partial dataset was removed\."\.to_string\(\)\); \}\s*emit_progress\(progress, "transform"/);
    // The fit itself answers the stop between iterations.
    expect(rust).toMatch(/!crate::commands::cancel::stopped\(&cancel\)\s*\}\)\.map_err\(\|e\| if e == "stopped"/);
  });

  it('says what the geometry did not constrain, before Apply', () => {
    expect(panel).toMatch(/constraintVerdict\(result\.report\.condition, result\.report\.weakest\)/);
    expect(panel).toMatch(/does not fix \{result\.report\.weakest\}/);
    expect(panel).toMatch(/plusMinus\(result\.report\.translation\[0\], quotedStdErr\(result\.report\.translationStdErr\[0\], result\.report\.translationStdErrBlocks\[0\]\), 'm'\)/);
    // The registration's error reaches the M3C2 panel, and leaves with Clear.
    expect(panel).toMatch(/setRegistrationError\(\{ metres: r\.report\.positionStdErr, movingName: r\.movingName, referenceName: r\.referenceName \}\)/);
    expect(panel).toMatch(/setResult\(null\); setError\(null\); setNote\(null\);\s*setRegistrationError\(null\);/);
    const m3c2 = stripComments(read('src/components/shell/M3C2Panel.tsx'));
    expect(m3c2).toMatch(/Use the registration's error: \{\(registrationError\.metres \* 1000\)\.toFixed\(2\)\} mm/);
    expect(m3c2).toMatch(/setRegMm\(Math\.min\(100, Math\.max\(0, Math\.round\(registrationError\.metres \* 1000\)\)\)\)/);
    // The source is never touched, and the panel says so.
    expect(panel).toMatch(/The source stays — removing the copy in Layers undoes the move\./);
  });
});
