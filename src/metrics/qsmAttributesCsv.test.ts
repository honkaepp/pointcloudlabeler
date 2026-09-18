import { describe, it, expect } from 'vitest';
import { TQSM_COLUMNS, tqsmRow } from './qsmAttributesCsv';
import type { QsmAttributes } from '../persistence/octreeReader';

/** Every field distinct, so a cell written into the wrong column can
 *  be seen rather than guessed at. */
function attrs(): QsmAttributes {
  return {
    totalVolume: 271.341, trunkVolume: 250.111, branchVolume: 21.23,
    treeHeight: 8.001, trunkLength: 7.902, branchLength: 3.503, totalLength: 11.405,
    numberBranches: 7, numberBranchesModelled: 5, maxBranchOrder: 2,
    trunkArea: 4.5001, branchArea: 0.5178, totalArea: 5.0179,
    dbhQsm: 0.2653, dbhCyl: 0.2677,
    crownDiamAve: 3.111, crownDiamMax: 4.222,
    crownAreaConv: 8.333, crownAreaAlpha: 2.444,
    crownBaseHeight: 2.555, crownLength: 5.446, crownRatio: 0.681,
    crownVolumeConv: 12.777, crownVolumeAlpha: 3.888,
    pointDistanceMean: 0.00046, pointDistanceMax: 0.00312,
    pointDistanceTrunkMean: 0.00031, pointDistanceBranchMean: 0.00092,
    unsupportedCylinders: 3,
    patchDiam1: 0.12, patchDiam2Min: 0.02, patchDiam2Max: 0.07,
    stemTaper: [[0, 0.3], [8, 0.1]],
  };
}

describe('the TreeQSM block of the metrics CSV', () => {
  it('writes exactly one cell per column', () => {
    expect(tqsmRow(attrs())).toHaveLength(TQSM_COLUMNS.length);
    expect(tqsmRow(undefined)).toHaveLength(TQSM_COLUMNS.length);
    expect(new Set(TQSM_COLUMNS).size).toBe(TQSM_COLUMNS.length);
  });

  it('puts each value under the column that names it', () => {
    const row = tqsmRow(attrs());
    const cell = (name: string) => row[TQSM_COLUMNS.indexOf(name as never)];

    expect(cell('tqsm_total_volume_l')).toBe('271.341');
    expect(cell('tqsm_trunk_volume_l')).toBe('250.111');
    expect(cell('tqsm_branch_volume_l')).toBe('21.230');
    expect(cell('tqsm_tree_height_m')).toBe('8.001');
    expect(cell('tqsm_branches')).toBe(7);
    expect(cell('tqsm_branches_modelled')).toBe(5);
    expect(cell('tqsm_max_branch_order')).toBe(2);
    // The two diameters at breast height are different numbers and
    // must not be swapped: one is off the cylinder chain, the other
    // refitted to the trunk's own points.
    expect(cell('tqsm_dbh_qsm_m')).toBe('0.2653');
    expect(cell('tqsm_dbh_cyl_m')).toBe('0.2677');
    // Nor may the crown's two areas or its two volumes swap: the hull
    // one is always the larger, and reporting the alpha shape under the
    // hull's name would understate the crown by a factor of three here.
    expect(cell('tqsm_crown_area_conv_m2')).toBe('8.333');
    expect(cell('tqsm_crown_area_alpha_m2')).toBe('2.444');
    expect(cell('tqsm_crown_volume_conv_m3')).toBe('12.777');
    expect(cell('tqsm_crown_volume_alpha_m3')).toBe('3.888');
    // Point distances are millimetres, so they get five decimals
    // rather than three, or a good fit rounds to zero.
    expect(cell('tqsm_point_dist_mean_m')).toBe('0.00046');
    expect(cell('tqsm_point_dist_max_m')).toBe('0.00312');
    expect(cell('tqsm_point_dist_trunk_mean_m')).toBe('0.00031');
    expect(cell('tqsm_point_dist_branch_mean_m')).toBe('0.00092');
    expect(cell('tqsm_unsupported_cylinders')).toBe(3);
    expect(cell('tqsm_patch_diam1_m')).toBe('0.120');
  });

  it('leaves the cells empty for a tree with no model, rather than zero', () => {
    // A zero crown volume is a claim that the tree has no crown; an
    // empty cell says the measurement was not made.
    for (const c of tqsmRow(undefined)) expect(c).toBe('');
  });

  it('writes an empty cell rather than NaN when a measurement failed', () => {
    const a = { ...attrs(), dbhCyl: NaN, crownRatio: NaN };
    const row = tqsmRow(a);
    expect(row[TQSM_COLUMNS.indexOf('tqsm_dbh_cyl_m' as never)]).toBe('');
    expect(row[TQSM_COLUMNS.indexOf('tqsm_crown_ratio' as never)]).toBe('');
    // and the rest still come through.
    expect(row[TQSM_COLUMNS.indexOf('tqsm_dbh_qsm_m' as never)]).toBe('0.2653');
  });
});
