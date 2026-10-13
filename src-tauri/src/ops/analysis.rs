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

//! Ground, terrain, segmentation, per-tree measurement and quality
//! control — the analysis passes, with the panels' defaults.
//!
//! After a segmenter has rewritten a column of octree.bin, the panel
//! clears that column's overrides from the edit overlay (patches.bin),
//! because an override that re-imposed the old tree id on reload would
//! undo the run. The operations here do the same, through
//! `clear_patch_columns`, and report how many overrides went.

use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::qc::{compute_flags, merge_stem_fits, worst_by_tree, Flag, MergedMetric, Severity};
use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::{
    clear_patch_columns, lock_dataset, normalize_core, octree_read_qsm, octree_read_stems, run_classify_ground,
    run_density_metrics, run_fit_stems, run_leaf_wood, run_point_qc, run_reset_attribute, run_reset_classification,
    run_segment_chm, run_segment_deadwood, run_segment_li2012, run_terrain, run_tree_isolation, run_tree_metrics,
    run_tree_qsm, run_tree_summary, DeadwoodResult, DensityMetricsResult, LeafWoodResult, Li2012Request,
    NormalizeResult, PatchColumns, PointQcSummary, QsmResult, SegmentResult, StemFit, TerrainResult,
    TreeIsoRequest, TreeMetric, TreeSummaryEntry,
};
use crate::commands::pointqc::PointQcParams;

// Defaults, each the panel's. Named for where they come from.
fn f_0_05() -> f64 { 0.05 }
fn f_0_1() -> f64 { 0.1 }
fn f_0_2() -> f64 { 0.2 }
fn f_0_25() -> f64 { 0.25 }
fn f_0_3() -> f64 { 0.3 }
fn f_0_35() -> f64 { 0.35 }
fn f_0_4() -> f64 { 0.4 }
fn f_0_5() -> f64 { 0.5 }
fn f_0_55() -> f64 { 0.55 }
fn f_0_6() -> f64 { 0.6 }
fn f_1() -> f64 { 1.0 }
fn f_1_2() -> f64 { 1.2 }
fn f_1_4() -> f64 { 1.4 }
fn f_1_5() -> f64 { 1.5 }
fn f_2() -> f64 { 2.0 }
fn f_2_5() -> f64 { 2.5 }
fn f_3() -> f64 { 3.0 }
fn f_5() -> f64 { 5.0 }
fn f_15() -> f64 { 15.0 }
fn f_20() -> f64 { 20.0 }
fn f_45() -> f64 { 45.0 }
fn f_60() -> f64 { 60.0 }
fn f_315() -> f64 { 315.0 }
fn f_0_01() -> f64 { 0.01 }
fn f_0_03() -> f64 { 0.03 }
fn f_0_06() -> f64 { 0.06 }
fn u_2() -> u32 { 2 }
fn u_5() -> u32 { 5 }
fn u_8() -> u32 { 8 }
fn u_12() -> u32 { 12 }
fn u_15() -> u32 { 15 }
fn u_20() -> u32 { 20 }
fn u_30() -> u32 { 30 }
fn u_600() -> u32 { 600 }
fn pmf() -> String { "pmf".into() }
fn p2r() -> String { "p2r".into() }
fn simple() -> String { "simple".into() }
fn yes() -> bool { true }

// --- ground ---------------------------------------------------------------

/// The Ground panel's parameters (`DEFAULT_GROUND_PARAMS`).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroundParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// "pmf" (progressive morphological filter, Zhang et al. 2003) or "csf" (cloth simulation, Zhang et al. 2016).
    #[serde(default = "pmf")]
    pub method: String,
    /// Raster cell size, metres.
    #[serde(default = "f_0_5")]
    pub cell_size: f64,
    /// Ground tolerance, metres (pmf).
    #[serde(default = "f_0_2")]
    pub tolerance: f64,
    /// Terrain slope allowance (pmf).
    #[serde(default = "f_0_2")]
    pub slope: f64,
    /// Initial elevation threshold, metres (pmf).
    #[serde(default = "f_0_3")]
    pub initial_threshold: f64,
    /// Largest elevation threshold, metres (pmf).
    #[serde(default = "f_2_5")]
    pub max_threshold: f64,
    /// Largest filter window, metres (pmf).
    #[serde(default = "f_20")]
    pub max_window_m: f64,
    /// Cloth rigidity (csf only).
    #[serde(default = "f_2")]
    pub rigidity: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CountResult {
    pub points: u64,
}

fn ground_classify(ctx: &OpContext, p: GroundParams) -> Result<CountResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let _guard = lock_dataset(&p.octree_dir)?;
    let sink = ctx.progress.under("classify_ground");
    let n = run_classify_ground(
        &sink, &p.octree_dir, p.cell_size, p.tolerance, p.slope, p.initial_threshold, p.max_threshold,
        p.max_window_m, &p.method, p.rigidity,
    )?;
    Ok(CountResult { points: n })
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResetClassParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// The class to reset; -1 for every point.
    pub from_class: i32,
    /// The class to set (default 1, "unclassified").
    #[serde(default = "one_u8")]
    pub to_class: u8,
}
fn one_u8() -> u8 { 1 }

fn ground_reset(ctx: &OpContext, p: ResetClassParams) -> Result<CountResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let _guard = lock_dataset(&p.octree_dir)?;
    let n = run_reset_classification(&ctx.progress, &p.octree_dir, p.from_class, p.to_class)?;
    Ok(CountResult { points: n })
}

/// Terrain rasters from the ground classification: DTM, DSM, CHM and the
/// morphometric and hydrological derivatives, as GeoTIFF and ESRI ASCII.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerrainParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Raster cell size, metres.
    #[serde(default = "f_0_5")]
    pub cell_size: f64,
    /// "p2r" (per-cell maxima) or "pit_free" (Khosravipour et al. 2014).
    #[serde(default = "p2r")]
    pub dsm_method: String,
    /// Height thresholds for the pit-free method; empty for its defaults.
    #[serde(default)]
    pub dsm_layers: Vec<f64>,
    /// EPSG code written into the GeoTIFFs; defaults to the dataset's recorded CRS.
    #[serde(default)]
    pub epsg: Option<u32>,
    /// Latitude for the heat-load index (default 60).
    #[serde(default = "f_60")]
    pub hli_latitude_deg: f64,
    /// Flow-accumulation fraction that starts a stream (default 0.01).
    #[serde(default = "f_0_01")]
    pub stream_fraction: f64,
    /// Sun altitude for the hillshade, degrees.
    #[serde(default = "f_45")]
    pub hillshade_altitude_deg: f64,
    /// Sun azimuth for the hillshade, degrees.
    #[serde(default = "f_315")]
    pub hillshade_azimuth_deg: f64,
}

fn terrain_compute(ctx: &OpContext, p: TerrainParams) -> Result<TerrainResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let sink = ctx.progress.under("terrain");
    run_terrain(
        &sink, &p.octree_dir, p.cell_size, &p.dsm_method, &p.dsm_layers, p.epsg, p.hli_latitude_deg,
        p.stream_fraction.clamp(0.001, 0.5), p.hillshade_altitude_deg.clamp(0.0, 90.0),
        p.hillshade_azimuth_deg.rem_euclid(360.0),
    )
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizeParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// DTM cell size, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub cell_size: f64,
}

fn ground_normalize(ctx: &OpContext, p: NormalizeParams) -> Result<NormalizeResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let _guard = lock_dataset(&p.octree_dir)?;
    let sink = ctx.progress.under("normalize");
    normalize_core(Path::new(&p.octree_dir), p.cell_size, &sink)
}

// --- segmentation -----------------------------------------------------------

/// What a segmenter did, plus the overlay overrides cleared afterwards.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentOutcome {
    pub tree_count: u32,
    pub assigned_points: u64,
    pub overrides_cleared: u64,
}

fn after_segment(dir: &str, r: SegmentResult, cols: PatchColumns) -> Result<SegmentOutcome, String> {
    let cleared = clear_patch_columns(dir, cols)?;
    Ok(SegmentOutcome { tree_count: r.tree_count, assigned_points: r.assigned_points, overrides_cleared: cleared })
}

/// The Auto-segment panel's watershed parameters (`DEFAULT_SEGMENT_PARAMS`).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SegmentChmParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Raster cell size, metres.
    #[serde(default = "f_0_5")]
    pub cell_size: f64,
    /// Gaussian smoothing of the CHM, in cells (default 1).
    #[serde(default = "f_1")]
    pub smooth: f64,
    /// Trees shorter than this are not seeded (default 2 m).
    #[serde(default = "f_2")]
    pub min_height: f64,
    /// Crown radius at zero height, metres.
    #[serde(default = "f_1_5")]
    pub crown_base_radius: f64,
    /// Crown radius growth per metre of tree height.
    #[serde(default = "f_0_05")]
    pub crown_radius_per_m: f64,
    /// Largest crown radius, metres.
    #[serde(default = "f_5")]
    pub crown_max_radius: f64,
}

fn segment_chm(ctx: &OpContext, p: SegmentChmParams) -> Result<SegmentOutcome, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let _guard = lock_dataset(&p.octree_dir)?;
    let sink = ctx.progress.under("segment");
    let r = run_segment_chm(
        &sink, &p.octree_dir, p.cell_size, p.smooth, p.min_height, p.crown_base_radius, p.crown_radius_per_m,
        p.crown_max_radius,
    )?;
    after_segment(&p.octree_dir, r, PatchColumns::TREE_ID)
}

/// treeiso (Xi & Hopkinson 2022) with the ℓ0 cut-pursuit optimiser (`DEFAULT_TREEISO_PARAMS`).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TreeIsoParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Voxel size, metres.
    #[serde(default = "f_0_1")]
    pub voxel_size: f64,
    /// Neighbours in the first (local) cut (treeiso k1).
    #[serde(default = "u_5")]
    pub k1: u32,
    /// Regularisation strength of the first cut.
    #[serde(default = "f_1")]
    pub lambda1: f64,
    /// Neighbours in the second (global) cut.
    #[serde(default = "u_20")]
    pub k2: u32,
    /// Regularisation strength of the second cut.
    #[serde(default = "f_20")]
    pub lambda2: f64,
    /// Decimation fraction before the second cut.
    #[serde(default = "f_0_1")]
    pub decimate2: f64,
    /// Largest gap bridged between segments, metres.
    #[serde(default = "f_2")]
    pub max_gap: f64,
    /// Neighbours in the final merge.
    #[serde(default = "u_20")]
    pub k3: u32,
    /// Relative height weight in the final merge.
    #[serde(default = "f_0_5")]
    pub rho: f64,
    /// Weight of the vertical axis in the final merge.
    #[serde(default = "f_0_5")]
    pub vertical_weight: f64,
    /// Segments with fewer points are not trees.
    #[serde(default = "u_20")]
    pub min_tree_pts: u32,
}

fn segment_treeiso(ctx: &OpContext, p: TreeIsoParams) -> Result<SegmentOutcome, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let _guard = lock_dataset(&p.octree_dir)?;
    let req = TreeIsoRequest {
        k1: p.k1, lambda1: p.lambda1, k2: p.k2, lambda2: p.lambda2, decimate2: p.decimate2, max_gap: p.max_gap,
        k3: p.k3, rho: p.rho, vertical_weight: p.vertical_weight, min_tree_pts: p.min_tree_pts,
    };
    let r = run_tree_isolation(&ctx.progress, &p.octree_dir, p.voxel_size, &req)?;
    after_segment(&p.octree_dir, r, PatchColumns::TREE_ID)
}

/// Li et al. (2012) top-down segmentation (`DEFAULT_LI2012_PARAMS`).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Li2012Params {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Voxel size, metres.
    #[serde(default = "f_0_5")]
    pub voxel_size: f64,
    /// DTM cell size for heights above ground, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub dtm_cell: f64,
    /// Spacing threshold below zu, metres.
    #[serde(default = "f_1_5")]
    pub dt1: f64,
    /// Spacing threshold above zu, metres.
    #[serde(default = "f_2")]
    pub dt2: f64,
    /// Height at which the spacing threshold switches, metres.
    #[serde(default = "f_15")]
    pub zu: f64,
    /// Search window radius, metres.
    #[serde(default = "f_2")]
    pub search_window: f64,
    /// Trees shorter than this are not seeded, metres.
    #[serde(default = "f_2")]
    pub min_height: f64,
    /// Segments with fewer points are not trees.
    #[serde(default = "u_30")]
    pub min_tree_pts: u32,
}

fn segment_li2012(ctx: &OpContext, p: Li2012Params) -> Result<SegmentOutcome, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let _guard = lock_dataset(&p.octree_dir)?;
    let req = Li2012Request {
        dt1: p.dt1, dt2: p.dt2, zu: p.zu, search_window: p.search_window, min_height: p.min_height,
        min_tree_pts: p.min_tree_pts,
    };
    let r = run_segment_li2012(&ctx.progress, &p.octree_dir, p.voxel_size, p.dtm_cell, &req)?;
    after_segment(&p.octree_dir, r, PatchColumns::TREE_ID)
}

/// Lying dead wood (`DEFAULT_DEADWOOD_PARAMS`).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeadwoodParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Raster cell size, metres.
    #[serde(default = "f_0_5")]
    pub cell_size: f64,
    /// Lowest height above ground considered, metres.
    #[serde(default = "f_0_05")]
    pub hag_min: f64,
    /// Highest height above ground considered, metres.
    #[serde(default = "f_1_5")]
    pub hag_max: f64,
    /// Neighbourhood radius for the geometry, metres.
    #[serde(default = "f_0_4")]
    pub neighbor_radius: f64,
    /// Least linearity a log point needs.
    #[serde(default = "f_0_6")]
    pub min_linearity: f64,
    /// Most vertical a log axis may be (0 flat, 1 upright).
    #[serde(default = "f_0_4")]
    pub max_axis_verticality: f64,
    /// Clustering distance, metres.
    #[serde(default = "f_0_3")]
    pub cluster_eps: f64,
    /// Smallest cluster kept.
    #[serde(default = "u_20")]
    pub min_cluster_points: u32,
    /// Shortest log kept, metres.
    #[serde(default = "f_0_6")]
    pub min_log_length: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeadwoodOutcome {
    #[serde(flatten)]
    pub result: DeadwoodResult,
    pub overrides_cleared: u64,
}

fn segment_deadwood(ctx: &OpContext, p: DeadwoodParams) -> Result<DeadwoodOutcome, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let _guard = lock_dataset(&p.octree_dir)?;
    let result = run_segment_deadwood(
        &ctx.progress, &p.octree_dir, p.cell_size, p.hag_min, p.hag_max, p.neighbor_radius, p.min_linearity,
        p.max_axis_verticality, p.cluster_eps, p.min_cluster_points, p.min_log_length,
    )?;
    let overrides_cleared = clear_patch_columns(&p.octree_dir, PatchColumns::LAYING_DEADWOOD)?;
    Ok(DeadwoodOutcome { result, overrides_cleared })
}

/// Leaf–wood separation from local PCA eigenfeatures (`DEFAULT_LEAFWOOD_PARAMS`).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LeafWoodParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Neighbourhood radius for the eigenfeatures, metres.
    #[serde(default = "f_0_06")]
    pub search_radius: f64,
    /// Fewest neighbours a point needs to be classified.
    #[serde(default = "u_8")]
    pub min_neighbors: u32,
    /// Least linearity that reads as wood.
    #[serde(default = "f_0_6")]
    pub linearity_min: f64,
    /// Least planarity that reads as wood.
    #[serde(default = "f_0_55")]
    pub planarity_min: f64,
    /// Most scatter that still reads as wood.
    #[serde(default = "f_0_35")]
    pub scatter_max: f64,
    /// Neighbourhood majority passes over the result.
    #[serde(default = "u_2")]
    pub smooth_passes: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeafWoodOutcome {
    #[serde(flatten)]
    pub result: LeafWoodResult,
    pub overrides_cleared: u64,
}

fn segment_leafwood(ctx: &OpContext, p: LeafWoodParams) -> Result<LeafWoodOutcome, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let _guard = lock_dataset(&p.octree_dir)?;
    let result = run_leaf_wood(
        &ctx.progress, &p.octree_dir, p.search_radius, p.min_neighbors, p.linearity_min, p.planarity_min,
        p.scatter_max, p.smooth_passes,
    )?;
    let overrides_cleared = clear_patch_columns(&p.octree_dir, PatchColumns::SEMANTIC)?;
    Ok(LeafWoodOutcome { result, overrides_cleared })
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResetAttributeParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// "tree_id", "semantic", "standing_deadwood" or "laying_deadwood".
    pub attr: String,
}

fn segment_reset(ctx: &OpContext, p: ResetAttributeParams) -> Result<SegmentOutcome, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let cols = match p.attr.as_str() {
        "tree_id" => PatchColumns::TREE_ID,
        "semantic" => PatchColumns::SEMANTIC,
        "standing_deadwood" => PatchColumns { standing_deadwood: true, ..PatchColumns::default() },
        "laying_deadwood" => PatchColumns::LAYING_DEADWOOD,
        other => return Err(format!("unknown attribute '{other}': use tree_id, semantic, standing_deadwood or laying_deadwood")),
    };
    let _guard = lock_dataset(&p.octree_dir)?;
    let n = run_reset_attribute(&ctx.progress, &p.octree_dir, &p.attr)?;
    let cleared = clear_patch_columns(&p.octree_dir, cols)?;
    Ok(SegmentOutcome { tree_count: 0, assigned_points: n, overrides_cleared: cleared })
}

// --- metrics ----------------------------------------------------------------

/// The band every panel measures over (`DEFAULT_METRIC_PARAMS`).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetricsParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Crown raster cell, metres (default 0.25).
    #[serde(default = "f_0_25")]
    pub crown_cell: f64,
    /// Breast-height band, metres above ground (default 1.2 to 1.4).
    #[serde(default = "f_1_2")]
    pub bh_low: f64,
    /// Breast-height band, upper bound above ground, metres.
    #[serde(default = "f_1_4")]
    pub bh_high: f64,
    /// DTM cell size for heights above ground, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub dtm_cell: f64,
    /// Replace the algebraic DBH with the RANSAC stem fit from stems.json where one exists (default true).
    #[serde(default = "yes")]
    pub merge_stems: bool,
}

fn metrics_trees(ctx: &OpContext, p: MetricsParams) -> Result<Vec<MergedMetric>, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let sink = ctx.progress.under("metrics");
    let metrics = run_tree_metrics(&sink, &p.octree_dir, p.crown_cell, p.bh_low, p.bh_high, p.dtm_cell)?;
    let stems = if p.merge_stems { octree_read_stems(p.octree_dir.clone())? } else { None };
    Ok(merge_stem_fits(&metrics, stems.as_deref()))
}

/// RANSAC stem circles (the Metrics module's `DEFAULT_STEM`).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StemsParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Stem band, metres above ground (default 1.0 to 3.0).
    #[serde(default = "f_1")]
    pub band_low: f64,
    /// Stem band, upper bound above ground, metres.
    #[serde(default = "f_3")]
    pub band_high: f64,
    /// Inlier tolerance, metres (default 0.03).
    #[serde(default = "f_0_03")]
    pub inlier_tol: f64,
    /// RANSAC iterations per tree.
    #[serde(default = "u_600")]
    pub iterations: u32,
    /// Fewest inliers for a fit to count.
    #[serde(default = "u_12")]
    pub min_inliers: u32,
    /// Also label the fitted band's inliers as stem in octree.bin (default false).
    #[serde(default)]
    pub write_semantic: bool,
    /// DTM cell size for heights above ground, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub dtm_cell: f64,
}

fn metrics_stems(ctx: &OpContext, p: StemsParams) -> Result<Vec<StemFit>, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let _guard = lock_dataset(&p.octree_dir)?;
    let sink = ctx.progress.under("stemfit");
    run_fit_stems(
        &sink, &p.octree_dir, p.band_low, p.band_high, p.inlier_tol, p.iterations, p.min_inliers,
        p.write_semantic, p.dtm_cell,
    )
}

/// Sliced stem model with volume and uncertainty (the Metrics module's QSM defaults).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QsmParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Slice height, metres.
    #[serde(default = "f_0_25")]
    pub slice_height: f64,
    /// Fewest points a slice needs to be fitted.
    #[serde(default = "u_15")]
    pub min_points_per_slice: u32,
    /// Trees shorter than this get no stem model, metres.
    #[serde(default = "f_3")]
    pub min_tree_height: f64,
    /// DTM cell size for heights above ground, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub dtm_cell: f64,
    /// Also fit branch cylinders.
    #[serde(default)]
    pub enable_branches: bool,
    /// "simple" or "treeqsm".
    #[serde(default = "simple")]
    pub branch_method: String,
    /// Voxel size for the branch fit, metres.
    #[serde(default = "f_0_1")]
    pub branch_voxel: f64,
}

fn metrics_qsm(ctx: &OpContext, p: QsmParams) -> Result<QsmResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let sink = ctx.progress.under("qsm");
    run_tree_qsm(
        &sink, &p.octree_dir, p.slice_height, p.min_points_per_slice, p.min_tree_height, p.dtm_cell,
        p.enable_branches, &p.branch_method, p.branch_voxel.max(0.02),
    )
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SummaryParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Include each tree's node record list (large; the viewer uses it, a table does not).
    #[serde(default)]
    pub with_records: bool,
}

fn metrics_summary(ctx: &OpContext, p: SummaryParams) -> Result<Vec<TreeSummaryEntry>, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let mut rows = run_tree_summary(&ctx.progress, &p.octree_dir)?;
    if !p.with_records {
        for r in &mut rows {
            r.records.clear();
        }
    }
    Ok(rows)
}

/// Gridded density metrics (the Density metrics panel's defaults).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DensityParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Raster cell size, metres.
    #[serde(default = "f_2")]
    pub cell_size: f64,
    /// Trees shorter than this are not seeded, metres.
    #[serde(default = "f_0_2")]
    pub min_height: f64,
    /// Height above ground where the canopy begins, metres.
    #[serde(default = "f_2")]
    pub canopy_threshold: f64,
    /// EPSG code written into the rasters; defaults to the dataset's recorded CRS.
    #[serde(default)]
    pub epsg: Option<u32>,
}

fn metrics_density(ctx: &OpContext, p: DensityParams) -> Result<DensityMetricsResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let sink = ctx.progress.under("density");
    run_density_metrics(&sink, &p.octree_dir, p.cell_size, p.min_height, p.canopy_threshold, p.epsg)
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PointQcOpParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// The Point QC panel's parameters, as it sends them.
    pub params: PointQcParams,
}

fn qc_points(ctx: &OpContext, p: PointQcOpParams) -> Result<PointQcSummary, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let _guard = lock_dataset(&p.octree_dir)?;
    let sink = ctx.progress.under("pointqc");
    run_point_qc(&sink, Path::new(&p.octree_dir), &p.params)
}

// --- quality control ------------------------------------------------------

/// Per-tree QC: the metrics (with stem fits merged), the QSM cache if
/// there is one, the ten checks, ranked.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QcParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Crown raster cell, metres.
    #[serde(default = "f_0_25")]
    pub crown_cell: f64,
    /// Breast-height band, lower bound above ground, metres.
    #[serde(default = "f_1_2")]
    pub bh_low: f64,
    /// Breast-height band, upper bound above ground, metres.
    #[serde(default = "f_1_4")]
    pub bh_high: f64,
    /// DTM cell size for heights above ground, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub dtm_cell: f64,
    /// Attach each tree's bounds to its flags (one more pass over the cloud).
    #[serde(default)]
    pub with_boxes: bool,
    /// Also return the merged per-tree metrics the flags were judged on.
    #[serde(default)]
    pub with_metrics: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QcReport {
    pub tree_count: usize,
    pub flagged_trees: usize,
    pub critical: usize,
    pub warnings: usize,
    pub info: usize,
    /// Whether qsm.json was present, so the three QSM checks ran.
    pub qsm_checked: bool,
    pub flags: Vec<Flag>,
    pub worst_by_tree: std::collections::BTreeMap<i32, Severity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Vec<MergedMetric>>,
}

fn qc_flags(ctx: &OpContext, p: QcParams) -> Result<QcReport, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let sink = ctx.progress.under("metrics");
    let metrics = run_tree_metrics(&sink, &p.octree_dir, p.crown_cell, p.bh_low, p.bh_high, p.dtm_cell)?;
    let stems = octree_read_stems(p.octree_dir.clone())?;
    let merged = merge_stem_fits(&metrics, stems.as_deref());
    let rows: Vec<TreeMetric> = merged.iter().map(|m| m.metric.clone()).collect();
    let qsm = octree_read_qsm(p.octree_dir.clone())?;
    let qsm_by_id: Option<std::collections::HashMap<i32, _>> =
        qsm.as_ref().map(|q| q.trees.iter().map(|t| (t.tree_id, t.clone())).collect());
    let volumes: Option<Vec<f64>> =
        qsm.as_ref().map(|q| q.trees.iter().map(|t| t.stem_volume).filter(|v| v.is_finite()).collect());
    let boxes: Option<std::collections::HashMap<i32, [[f64; 3]; 2]>> = if p.with_boxes {
        Some(run_tree_summary(&ctx.progress, &p.octree_dir)?.into_iter().map(|e| (e.tree_id, [e.bbox_min, e.bbox_max])).collect())
    } else {
        None
    };
    let qsm_lookup = |id: i32| qsm_by_id.as_ref().and_then(|m| m.get(&id).cloned());
    let box_lookup = |id: i32| boxes.as_ref().and_then(|m| m.get(&id).copied());
    let flags = compute_flags(
        &rows,
        qsm_by_id.as_ref().map(|_| &qsm_lookup as &dyn Fn(i32) -> Option<_>),
        volumes.as_deref(),
        boxes.as_ref().map(|_| &box_lookup as &dyn Fn(i32) -> Option<_>),
    );
    let worst = worst_by_tree(&flags);
    let count = |s: Severity| flags.iter().filter(|f| f.severity == s).count();
    Ok(QcReport {
        tree_count: rows.len(),
        flagged_trees: worst.len(),
        critical: count(Severity::Critical),
        warnings: count(Severity::Warning),
        info: count(Severity::Info),
        qsm_checked: qsm.is_some(),
        flags,
        worst_by_tree: worst,
        metrics: if p.with_metrics { Some(merged) } else { None },
    })
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![
        op!("ground.classify", Ground, mutates: true, stage: Some("classify_ground"),
            "Classify ground points (class 2) with the progressive morphological or the cloth simulation filter.", GroundParams, ground_classify),
        op!("ground.reset", Ground, mutates: true, stage: Some("reset_class"),
            "Rewrite the classification of every point of one class (or of all points).", ResetClassParams, ground_reset),
        op!("ground.terrain", Ground, mutates: true, stage: Some("terrain"),
            "Write the DTM, DSM, CHM and the terrain derivatives into the dataset's terrain/ folder.", TerrainParams, terrain_compute),
        op!("ground.normalize", Ground, mutates: true, stage: Some("normalize"),
            "Add a height-above-ground column computed against the DTM.", NormalizeParams, ground_normalize),
        op!("segment.chm", Segment, mutates: true, stage: Some("segment"),
            "Segment trees by watershed over the canopy height model; writes tree ids and clears their overlay overrides.", SegmentChmParams, segment_chm),
        op!("segment.treeiso", Segment, mutates: true, stage: Some("treeiso"),
            "Segment trees with treeiso (cut-pursuit on a voxel graph); writes tree ids.", TreeIsoParams, segment_treeiso),
        op!("segment.li2012", Segment, mutates: true, stage: Some("li2012"),
            "Segment trees top-down after Li et al. (2012); writes tree ids.", Li2012Params, segment_li2012),
        op!("segment.deadwood", Segment, mutates: true, stage: Some("deadwood"),
            "Detect lying dead wood near the ground; writes the laying-deadwood column.", DeadwoodParams, segment_deadwood),
        op!("segment.leafwood", Segment, mutates: true, stage: Some("leafwood"),
            "Separate wood from foliage by local geometry; writes the stem/branch label.", LeafWoodParams, segment_leafwood),
        op!("segment.reset", Segment, mutates: true, stage: Some("reset_attr"),
            "Zero one label column (tree id, semantic or a deadwood column) in the dataset and its overlay.", ResetAttributeParams, segment_reset),
        op!("metrics.trees", Metrics, mutates: false, stage: Some("metrics"),
            "Per-tree height, DBH, basal area, crown area and diameter, position and lean, with RANSAC stem fits merged in.", MetricsParams, metrics_trees),
        op!("metrics.stems", Metrics, mutates: true, stage: Some("stemfit"),
            "Fit RANSAC stem circles in the stem band and save them to stems.json.", StemsParams, metrics_stems),
        op!("metrics.qsm", Metrics, mutates: true, stage: Some("qsm"),
            "Fit the sliced stem model per tree (volume with uncertainty, taper) and save qsm.json.", QsmParams, metrics_qsm),
        op!("metrics.summary", Metrics, mutates: false, stage: Some("tree_summary"),
            "Per-tree point counts, bounds and centroids from the complete edited dataset.", SummaryParams, metrics_summary),
        op!("metrics.density", Metrics, mutates: true, stage: Some("density"),
            "Gridded canopy density metrics written to the dataset's density/ folder.", DensityParams, metrics_density),
        op!("qc.flags", Qc, mutates: false, stage: Some("metrics"),
            "Run the ten per-tree checks over the metrics and the QSM cache; flags ranked by severity.", QcParams, qc_flags),
        op!("qc.points", Qc, mutates: true, stage: Some("pointqc"),
            "Per-point quality classification (reflectance, outliers, wind), optionally written as a column.", PointQcOpParams, qc_points),
    ]
}
