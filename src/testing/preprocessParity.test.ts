import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { COREG_DEFAULTS } from '../components/preprocessing/CoregisterParams';

/** The Preprocessing module's registration — tie points, ICP, sphere
 *  and plane targets, the multi-station adjustment — runs headless as
 *  the `preprocess` operations. The arithmetic is the same Rust either
 *  way; what can drift is the defaults each side starts from, so the
 *  panel's are read out of its source and held against the operation
 *  parameters' `serde(default)` values. */
const rs = readFileSync(new URL('../../src-tauri/src/ops/preprocess.rs', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../components/preprocessing/CoregisterPanel.tsx', import.meta.url), 'utf8');

/** The literal a `serde(default = "fn")` on `field` resolves to. */
function rsDefault(field: string): string {
  const m = rs.match(new RegExp(`#\\[serde\\(default = "(\\w+)"\\)\\]\\s+pub ${field}:`));
  if (!m) throw new Error(`no default on ${field}`);
  const fn = rs.match(new RegExp(`fn ${m[1]}\\(\\) -> \\w+ \\{ ([^}]+) \\}`));
  if (!fn) throw new Error(`no fn ${m[1]}`);
  return fn[1].trim();
}
const num = (s: string) => Number(s.replace(/_/g, '').replace(/\.into\(\)|"/g, ''));

describe('the registration defaults agree between the panel and the headless core', () => {
  it('ICP', () => {
    expect(panel).toMatch(/setIcpMaxIters\] = useState\('30'\)/);
    expect(panel).toMatch(/setIcpMaxDist\] = useState\('0\.5'\)/);
    expect(panel).toMatch(/useState<'pointToPoint' \| 'pointToPlane'>\('pointToPoint'\)/);
    expect(num(rsDefault('max_iters'))).toBe(30);
    expect(num(rsDefault('max_corr_dist'))).toBe(0.5);
    expect(num(rsDefault('sample_points'))).toBe(num(COREG_DEFAULTS.icpSamplePoints));
    expect(rsDefault('method')).toBe('"pointToPoint".into()');
    expect(num(rsDefault('normal_k'))).toBe(12);
  });

  it('sphere detection and matching', () => {
    const d = rs.slice(rs.indexOf('impl Default for SphereParams'), rs.indexOf('impl SphereParams'));
    const pairs = Object.fromEntries([...d.matchAll(/(\w+): ([\d.]+)/g)].map(m => [m[1], num(m[2])]));
    expect(pairs).toEqual({
      r_min: num(COREG_DEFAULTS.sphRMin), r_max: num(COREG_DEFAULTS.sphRMax),
      rmse_rel_max: num(COREG_DEFAULTS.sphRmseRelMax), min_cluster_points: num(COREG_DEFAULTS.sphMinClusterPoints),
      voxel_size: num(COREG_DEFAULTS.sphVoxelSize), radius_tol: num(COREG_DEFAULTS.sphRadiusTol),
      inlier_tol: num(COREG_DEFAULTS.sphInlierTol), iterations: num(COREG_DEFAULTS.sphIterations),
    });
  });

  it('plane extraction and matching', () => {
    const d = rs.slice(rs.indexOf('impl Default for PlaneParams'), rs.indexOf('impl PlaneParams'));
    const pairs = Object.fromEntries([...d.matchAll(/(\w+): ([\d.]+)/g)].map(m => [m[1], num(m[2])]));
    expect(pairs).toEqual({
      voxel_size: num(COREG_DEFAULTS.plVoxelSize), planarity_max: num(COREG_DEFAULTS.plPlanarityMax),
      min_voxel_points: num(COREG_DEFAULTS.plMinVoxelPoints), normal_angle_tol_deg: num(COREG_DEFAULTS.plNormalAngleTolDeg),
      min_patch_points: num(COREG_DEFAULTS.plMinPatchPoints), max_std_dev: num(COREG_DEFAULTS.plMaxStdDev),
      min_size: num(COREG_DEFAULTS.plMinSize), max_planarity: num(COREG_DEFAULTS.pmMaxPlanarity),
      min_extent: num(COREG_DEFAULTS.pmMinExtent), match_angle_tol_deg: num(COREG_DEFAULTS.pmNormalAngleTolDeg),
      centroid_dist_tol: num(COREG_DEFAULTS.pmCentroidDistTol), iterations: num(COREG_DEFAULTS.pmIterations),
      samples_per_pair: num(COREG_DEFAULTS.pmSamplesPerPair),
    });
  });

  it('the multi-station adjustment', () => {
    expect(num(rsDefault('max_iters'))).toBe(30); // the ICP field comes first in the file
    const msa = rs.slice(rs.indexOf('pub struct MsaOpParams'));
    const first = (field: string) => {
      const m = msa.match(new RegExp(`#\\[serde\\(default = "(\\w+)"\\)\\]\\s+pub ${field}:`))!;
      return rs.match(new RegExp(`fn ${m[1]}\\(\\) -> \\w+ \\{ ([^}]+) \\}`))![1].trim();
    };
    expect(num(first('max_iters'))).toBe(num(COREG_DEFAULTS.msaMaxIters));
    expect(num(first('lambda_init'))).toBe(num(COREG_DEFAULTS.msaLambdaInit));
    expect(num(first('rmse_eps'))).toBe(num(COREG_DEFAULTS.msaRmseEps));
    expect(first('preserve_roll_pitch')).toBe('true');
    expect(COREG_DEFAULTS.msaPreserveRollPitch).toBe(true);
  });

  it('a pose write is opt-in on every registration step, as the panel\'s Apply buttons are', () => {
    for (const op of ['preprocess.solve', 'preprocess.icp', 'preprocess.matchSpheres', 'preprocess.msa']) {
      expect(rs).toContain(`"${op}"`);
    }
    expect(rs.match(/pub apply: bool/g)?.length).toBe(3);
    expect(rs).toMatch(/pub apply_to: Option<ScanRef>/);
  });
});
