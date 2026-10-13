// PointCloudLabeler — Tree segmentation, editing and label transfer for close-range forest point clouds
// Copyright (C) 2026 Eppu Honkanen
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//! Tree Skeleton Transfer and Cloud Registration: build the baseline's
//! skeletons, transfer its tree identities into another acquisition of
//! the plot, measure and apply the horizontal alignment between the two.
//! Defaults are the Skeleton Transfer and Cloud registration panels'.

use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{non_empty, OpContext, OpDef};
use crate::commands::cancel::try_begin;
use crate::commands::octree::{
    clear_patch_columns, clear_stored_alignment, export_skeletons_to, lock_dataset, octree_clear_skeletons,
    octree_skeleton_info, read_stored_alignment, run_build_skeletons, run_skeleton_align, run_skeleton_transfer,
    shift_georeference_core, GeoreferenceShift, HeightFrame, PatchColumns, SkeletonBuildResult, SkeletonExportResult,
    SkeletonInfo, SkeletonTransferResult, StoredAlignment,
};
use crate::commands::skelalign::AlignmentParam;

fn f_0_02() -> f64 { 0.02 }
fn f_0_08() -> f64 { 0.08 }
fn f_0_2() -> f64 { 0.2 }
fn f_0_3() -> f64 { 0.3 }
fn f_0_5() -> f64 { 0.5 }
fn f_30() -> f64 { 30.0 }
fn u8_1() -> u8 { 1 }
fn yes() -> bool { true }
fn stored() -> String { "stored".into() }

fn busy_tst() -> String {
    "a skeleton build or transfer is already running — stop it first, or wait for it to finish".to_string()
}

/// Build parameters (the panel's: 20 mm spacing, 8 cm cover radius, one
/// QSM model, no point caps, fragments dropped).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuildParams {
    /// The segmented, corrected baseline dataset.
    pub baseline_dir: String,
    /// Centreline sampling interval, metres (default 0.02).
    #[serde(default = "f_0_02")]
    pub skeleton_spacing: f64,
    /// Cover-set radius for the QSM, metres (default 0.08).
    #[serde(default = "f_0_08")]
    pub r_cover: f64,
    /// Trees with fewer points are skipped (default 0: none skipped).
    #[serde(default)]
    pub min_tree_points: u32,
    /// Trees with more points are thinned to this many (default 0: no cap).
    #[serde(default)]
    pub max_tree_points: u32,
    /// DTM cell size for heights above ground, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub dtm_cell: f64,
    /// Points below this height above ground are left out (default 0).
    #[serde(default)]
    pub ground_threshold: f64,
    /// QSM models fitted per tree, the best kept (default 1, up to 8).
    #[serde(default = "u8_1")]
    pub qsm_models: u8,
    /// Leave out cylinders TreeQSM added without point support (default true).
    #[serde(default = "yes")]
    pub skip_added_cylinders: bool,
    /// Drop skeleton fragments far from the tree (default true).
    #[serde(default = "yes")]
    pub drop_far_fragments: bool,
}

fn skeletons_build(ctx: &OpContext, p: BuildParams) -> Result<SkeletonBuildResult, String> {
    non_empty(&p.baseline_dir, "baselineDir")?;
    let _run = try_begin("tst").ok_or_else(busy_tst)?;
    run_build_skeletons(
        &ctx.progress,
        &p.baseline_dir,
        p.skeleton_spacing.clamp(0.005, 0.50),
        p.r_cover.clamp(0.01, 0.50),
        p.min_tree_points,
        p.max_tree_points,
        p.dtm_cell.clamp(0.05, 5.0),
        p.ground_threshold.clamp(0.0, 5.0),
        p.qsm_models.clamp(1, 8) as usize,
        p.skip_added_cylinders,
        p.drop_far_fragments,
    )
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
}

fn skeletons_info(_ctx: &OpContext, p: DirParams) -> Result<Option<SkeletonInfo>, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    octree_skeleton_info(p.octree_dir)
}

fn skeletons_clear(_ctx: &OpContext, p: DirParams) -> Result<bool, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    octree_clear_skeletons(p.octree_dir)
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkeletonExportParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// File to write, or the directory for `perTree`.
    pub out_path: String,
    /// "csv", "txt" (the reference's combined layout), "ply", "las" or "laz".
    #[serde(default)]
    pub format: Option<String>,
    /// Export only this tree.
    #[serde(default)]
    pub only_tree_id: Option<i32>,
    /// One file per tree into `outPath` as a directory.
    #[serde(default)]
    pub per_tree: bool,
}

fn skeletons_export(_ctx: &OpContext, p: SkeletonExportParams) -> Result<SkeletonExportResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    non_empty(&p.out_path, "outPath")?;
    export_skeletons_to(p.octree_dir, p.out_path, p.format, p.only_tree_id, Some(p.per_tree))
}

/// Transfer parameters (the panel's: 30 cm threshold, 20 mm spacing,
/// 20 cm ground threshold on the target, labels beyond the threshold).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferParams {
    /// The segmented, corrected baseline (its skeletons.bin is built if missing).
    pub baseline_dir: String,
    /// The acquisition to label.
    pub target_dir: String,
    /// Points within this distance of a skeleton sample take its tree id, metres (default 0.30).
    #[serde(default = "f_0_3")]
    pub distance_threshold: f64,
    /// Centreline sampling interval, metres.
    #[serde(default = "f_0_02")]
    pub skeleton_spacing: f64,
    /// Target points below this height above ground are left unlabelled (default 0.20).
    #[serde(default = "f_0_2")]
    pub ground_threshold: f64,
    /// The same, when building the baseline's skeletons (default 0).
    #[serde(default)]
    pub baseline_ground_threshold: f64,
    /// Cover-set radius for the QSM, metres.
    #[serde(default = "f_0_08")]
    pub r_cover: f64,
    /// Trees with fewer points are skipped (0: none skipped).
    #[serde(default)]
    pub min_tree_points: u32,
    /// Trees with more points are thinned to this many (0: no cap).
    #[serde(default)]
    pub max_tree_points: u32,
    /// DTM cell size for heights above ground, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub dtm_cell: f64,
    /// Points slightly beyond the threshold but within reach take the tree id as "not wood" (default true).
    #[serde(default = "yes")]
    pub label_beyond_threshold: bool,
    /// QSM models fitted per tree, the best kept (1 to 8).
    #[serde(default = "u8_1")]
    pub qsm_models: u8,
    /// Leave out cylinders TreeQSM added without point support.
    #[serde(default = "yes")]
    pub skip_added_cylinders: bool,
    /// Drop skeleton fragments far from the tree.
    #[serde(default = "yes")]
    pub drop_far_fragments: bool,
    /// Which z the baseline is matched in: "stored" or "above_ground".
    #[serde(default = "stored")]
    pub baseline_height: String,
    /// Which z the target is matched in: "stored" or "above_ground".
    #[serde(default = "stored")]
    pub target_height: String,
    /// A horizontal rigid alignment to apply during matching; by default
    /// the one `align.measure` stored for the target, if any.
    #[serde(default)]
    pub alignment: Option<AlignmentParam>,
    /// Ignore a stored alignment (default false).
    #[serde(default)]
    pub ignore_stored_alignment: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferOutcome {
    #[serde(flatten)]
    pub result: SkeletonTransferResult,
    /// Tree-id and semantic overrides cleared from the target's edit overlay.
    pub overrides_cleared: u64,
}

fn transfer_run(ctx: &OpContext, p: TransferParams) -> Result<TransferOutcome, String> {
    non_empty(&p.baseline_dir, "baselineDir")?;
    non_empty(&p.target_dir, "targetDir")?;
    let _guard = lock_dataset(&p.target_dir)?;
    let baseline_frame = HeightFrame::parse(Some(&p.baseline_height))?;
    let target_frame = HeightFrame::parse(Some(&p.target_height))?;
    let alignment = match p.alignment {
        Some(a) => Some(a),
        None if p.ignore_stored_alignment => None,
        None => read_stored_alignment(&p.target_dir)?.map(|a| AlignmentParam { dx: a.dx, dy: a.dy, theta: a.theta, cx: a.cx, cy: a.cy }),
    };
    let _run = try_begin("tst").ok_or_else(busy_tst)?;
    let result = run_skeleton_transfer(
        &ctx.progress,
        &p.baseline_dir,
        &p.target_dir,
        p.distance_threshold.clamp(0.01, 5.0),
        p.skeleton_spacing.clamp(0.005, 0.50),
        p.ground_threshold.clamp(0.0, 5.0),
        p.r_cover.clamp(0.01, 0.50),
        p.min_tree_points,
        p.max_tree_points,
        p.dtm_cell.clamp(0.05, 5.0),
        p.label_beyond_threshold,
        p.baseline_ground_threshold.clamp(0.0, 5.0),
        p.qsm_models.clamp(1, 8) as usize,
        p.skip_added_cylinders,
        p.drop_far_fragments,
        baseline_frame,
        target_frame,
        alignment,
    )?;
    let overrides_cleared = clear_patch_columns(&p.target_dir, PatchColumns::TREE_ID_AND_SEMANTIC)?;
    Ok(TransferOutcome { result, overrides_cleared })
}

/// Registration parameters (the panel's: 30 m search radius, rotation allowed).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AlignParams {
    /// The segmented, corrected baseline dataset.
    pub baseline_dir: String,
    /// The dataset the operation acts on (the later acquisition).
    pub target_dir: String,
    /// DTM cell size for heights above ground, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub dtm_cell: f64,
    /// Largest horizontal offset searched, metres (default 30).
    #[serde(default = "f_30")]
    pub search_radius: f64,
    /// Also solve a rotation about the vertical axis.
    #[serde(default = "yes")]
    pub allow_rotation: bool,
}

fn align_measure(ctx: &OpContext, p: AlignParams) -> Result<StoredAlignment, String> {
    non_empty(&p.baseline_dir, "baselineDir")?;
    non_empty(&p.target_dir, "targetDir")?;
    let _run = try_begin("align").ok_or_else(|| {
        "a registration is already running — stop it first, or wait for it to finish".to_string()
    })?;
    run_skeleton_align(
        &ctx.progress, &p.baseline_dir, &p.target_dir, p.dtm_cell.clamp(0.05, 5.0),
        p.search_radius.clamp(2.0, 300.0), p.allow_rotation,
    )
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetParams {
    /// The dataset the operation acts on (the later acquisition).
    pub target_dir: String,
}

fn align_read(_ctx: &OpContext, p: TargetParams) -> Result<Option<StoredAlignment>, String> {
    non_empty(&p.target_dir, "targetDir")?;
    read_stored_alignment(&p.target_dir)
}

fn align_clear(_ctx: &OpContext, p: TargetParams) -> Result<bool, String> {
    non_empty(&p.target_dir, "targetDir")?;
    clear_stored_alignment(&p.target_dir)
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyParams {
    /// The dataset the operation acts on (the later acquisition).
    pub target_dir: String,
    /// A note stored with the record.
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    /// False when the measured offset was under a millimetre and nothing moved.
    pub moved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shift: Option<GeoreferenceShift>,
}

/// The panel's `shiftOntoReference`: the stored alignment says where the
/// target sits relative to the baseline, so the target moves by the
/// negative of it, and only when the move is worth a millimetre.
pub fn shift_onto_reference(a: &StoredAlignment) -> Option<(f64, f64)> {
    let (dx, dy) = (-a.dx, -a.dy);
    if dx.hypot(dy) < 0.001 { None } else { Some((dx, dy)) }
}

fn align_apply(_ctx: &OpContext, p: ApplyParams) -> Result<ApplyOutcome, String> {
    non_empty(&p.target_dir, "targetDir")?;
    let a = read_stored_alignment(&p.target_dir)?.ok_or_else(|| "no stored alignment — run align.measure first".to_string())?;
    let Some((dx, dy)) = shift_onto_reference(&a) else {
        return Ok(ApplyOutcome { moved: false, shift: None });
    };
    let _guard = lock_dataset(&p.target_dir)?;
    let shift = shift_georeference_core(Path::new(&p.target_dir), dx, dy, p.note.as_deref())?;
    Ok(ApplyOutcome { moved: true, shift: Some(shift) })
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShiftParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Easting shift, metres.
    pub dx: f64,
    /// Northing shift, metres.
    pub dy: f64,
    /// A note stored with the record.
    #[serde(default)]
    pub note: Option<String>,
}

fn dataset_shift(_ctx: &OpContext, p: ShiftParams) -> Result<GeoreferenceShift, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    if !p.dx.is_finite() || !p.dy.is_finite() {
        return Err("the shift must be finite".into());
    }
    let _guard = lock_dataset(&p.octree_dir)?;
    shift_georeference_core(Path::new(&p.octree_dir), p.dx, p.dy, p.note.as_deref())
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![
        op!("transfer.buildSkeletons", Transfer, mutates: true, stage: Some("tst"),
            "Fit a TreeQSM per tree of the baseline and save the skeletons (tree id, branch order) to skeletons.bin.", BuildParams, skeletons_build),
        op!("transfer.skeletonInfo", Transfer, mutates: false, stage: None,
            "What skeletons.bin beside a dataset holds.", DirParams, skeletons_info),
        op!("transfer.clearSkeletons", Transfer, mutates: true, stage: None,
            "Delete a dataset's skeletons.bin.", DirParams, skeletons_clear),
        op!("transfer.exportSkeletons", Transfer, mutates: false, stage: None,
            "Write the skeletons as CSV, TXT, PLY, LAS or LAZ, whole or one file per tree.", SkeletonExportParams, skeletons_export),
        op!("transfer.run", Transfer, mutates: true, stage: Some("tst"),
            "Transfer the baseline's tree identities and stem/branch labels into another acquisition of the plot.", TransferParams, transfer_run),
        op!("transfer.align", Transfer, mutates: true, stage: Some("align"),
            "Measure the horizontal offset (and rotation) between the baseline's skeletons and the target; stored beside the target.", AlignParams, align_measure),
        op!("transfer.alignment", Transfer, mutates: false, stage: None,
            "The stored alignment beside a target, if any.", TargetParams, align_read),
        op!("transfer.clearAlignment", Transfer, mutates: true, stage: None,
            "Forget the stored alignment.", TargetParams, align_clear),
        op!("transfer.applyAlignment", Transfer, mutates: true, stage: None,
            "Move the target onto the baseline by the stored alignment, losslessly, through its georeferencing offset.", ApplyParams, align_apply),
        op!("transfer.shift", Transfer, mutates: true, stage: None,
            "Shift a dataset's georeferencing offset by dx, dy without rewriting a point.", ShiftParams, dataset_shift),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_target_moves_by_the_negative_of_the_measured_offset_and_not_for_a_hair() {
        let a = |dx: f64, dy: f64| StoredAlignment {
            format: String::new(), baseline_dir: String::new(), target_dir: String::new(), origin: [0.0; 3],
            dx, dy, theta: 0.0, cx: 0.0, cy: 0.0, rmse: 0.0, matched_trees: 0, tree_count: 0, confidence: 0.0,
            coarse: AlignmentParam { dx, dy, theta: 0.0, cx: 0.0, cy: 0.0 }, created_at: String::new(),
            target_shifted: [0.0, 0.0],
        };
        assert_eq!(shift_onto_reference(&a(0.5, -0.25)), Some((-0.5, 0.25)));
        assert_eq!(shift_onto_reference(&a(0.0004, 0.0004)), None);
    }

    #[test]
    fn the_alignment_operations_read_an_absent_file_as_none() {
        let dir = std::env::temp_dir().join(format!("pcl-ops-align-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = OpContext::silent();
        let d = dir.to_string_lossy().to_string();
        let v = super::super::run("transfer.alignment", serde_json::json!({ "targetDir": d }), &ctx).unwrap();
        assert!(v.is_null());
        let err = super::super::run("transfer.applyAlignment", serde_json::json!({ "targetDir": d }), &ctx).unwrap_err();
        assert!(err.contains("no stored alignment"), "{err}");
        assert_eq!(super::super::run("transfer.clearAlignment", serde_json::json!({ "targetDir": d }), &ctx).unwrap(), false);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
