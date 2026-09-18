// The TreeQSM attribute block of the tree-metrics CSV.
//
// It is here rather than inline in the exporter because a header list
// and a value list that must line up, written twenty-nine entries
// apart in a React component, is the shape of bug that ships: insert a
// column in one list and every column after it is labelled with its
// neighbour's name, and nothing fails — the file just means something
// else. As one pair with one test, the correspondence is checked.

import { csvNum } from '../io/csv';
import type { QsmAttributes } from '../persistence/octreeReader';

/** The block's column names, in order.
 *
 *  Volumes are LITRES and areas square metres, as TreeQSM reports
 *  them; crown volumes are cubic metres, as it reports those. The unit
 *  is in the name because a column called `volume` in a file that also
 *  carries `qsm_stem_volume_m3` is an invitation to add the two. */
export const TQSM_COLUMNS = [
  'tqsm_total_volume_l',
  'tqsm_trunk_volume_l',
  'tqsm_branch_volume_l',
  'tqsm_tree_height_m',
  'tqsm_trunk_length_m',
  'tqsm_branch_length_m',
  'tqsm_branches',
  'tqsm_branches_modelled',
  'tqsm_max_branch_order',
  'tqsm_trunk_area_m2',
  'tqsm_branch_area_m2',
  'tqsm_total_area_m2',
  'tqsm_dbh_qsm_m',
  'tqsm_dbh_cyl_m',
  'tqsm_crown_diam_ave_m',
  'tqsm_crown_diam_max_m',
  'tqsm_crown_area_conv_m2',
  'tqsm_crown_area_alpha_m2',
  'tqsm_crown_base_height_m',
  'tqsm_crown_length_m',
  'tqsm_crown_ratio',
  'tqsm_crown_volume_conv_m3',
  'tqsm_crown_volume_alpha_m3',
  'tqsm_point_dist_mean_m',
  'tqsm_point_dist_max_m',
  'tqsm_point_dist_trunk_mean_m',
  'tqsm_point_dist_branch_mean_m',
  'tqsm_unsupported_cylinders',
  'tqsm_patch_diam1_m',
  'tqsm_patch_diam2_min_m',
  'tqsm_patch_diam2_max_m',
] as const;

/** The block's cells for one tree, in the same order.
 *
 *  A tree with no TreeQSM model gets empty cells rather than zeros —
 *  the measurement was not made, and a zero crown volume is a claim
 *  that the tree has no crown. */
export function tqsmRow(a: QsmAttributes | undefined): (string | number)[] {
  if (!a) return TQSM_COLUMNS.map(() => '');
  return [
    csvNum(a.totalVolume, 3),
    csvNum(a.trunkVolume, 3),
    csvNum(a.branchVolume, 3),
    csvNum(a.treeHeight, 3),
    csvNum(a.trunkLength, 3),
    csvNum(a.branchLength, 3),
    a.numberBranches,
    a.numberBranchesModelled,
    a.maxBranchOrder,
    csvNum(a.trunkArea, 4),
    csvNum(a.branchArea, 4),
    csvNum(a.totalArea, 4),
    csvNum(a.dbhQsm, 4),
    csvNum(a.dbhCyl, 4),
    csvNum(a.crownDiamAve, 3),
    csvNum(a.crownDiamMax, 3),
    csvNum(a.crownAreaConv, 3),
    csvNum(a.crownAreaAlpha, 3),
    csvNum(a.crownBaseHeight, 3),
    csvNum(a.crownLength, 3),
    csvNum(a.crownRatio, 3),
    csvNum(a.crownVolumeConv, 3),
    csvNum(a.crownVolumeAlpha, 3),
    csvNum(a.pointDistanceMean, 5),
    csvNum(a.pointDistanceMax, 5),
    csvNum(a.pointDistanceTrunkMean, 5),
    csvNum(a.pointDistanceBranchMean, 5),
    a.unsupportedCylinders,
    csvNum(a.patchDiam1, 3),
    csvNum(a.patchDiam2Min, 3),
    csvNum(a.patchDiam2Max, 3),
  ];
}
