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

//! The Metrics module's per-tree CSV (`src/modules/MetricsModule.tsx`,
//! `src/metrics/qsmAttributesCsv.ts`), column for column: the
//! measured row, which diameter it carries and the stem fit behind it,
//! the QSM volumes with their uncertainty, the species-aware biomass
//! and carbon with their 95 % intervals, and TreeQSM's own attribute
//! table where it was computed. A column is present when any tree has
//! it, so the file's shape says what was run; an unmeasured cell is
//! empty, never "NaN".

use std::collections::HashMap;
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::csvtext::{csv_num, csv_text};
use super::forestry::{
    biomass_params_for_species, compute_species_aware_biomass, species_density, validate_biomass_params, BiomassParams,
    TreeBiomass, CUSTOM_SPECIES_KEY, DEFAULT_BIOMASS_PARAMS, SPECIES_DENSITIES,
};
use super::qc::{merge_stem_fits, DbhSource};
use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::{octree_read_qsm, octree_read_species, octree_read_stems, run_tree_metrics, StemFit, TreeQsm};
use crate::commands::treeqsm::QsmAttributes;

pub const BASE_HEADER: [&str; 14] = [
    "tree_id", "points", "height_m", "dbh_m", "dbh_method", "basal_area_m2", "crown_area_m2", "crown_diameter_m",
    "stem_inliers", "stem_rmse_m", "base_x", "base_y", "base_z", "lean_deg",
];

pub const TQSM_COLUMNS: [&str; 31] = [
    "tqsm_total_volume_l", "tqsm_trunk_volume_l", "tqsm_branch_volume_l", "tqsm_tree_height_m", "tqsm_trunk_length_m",
    "tqsm_branch_length_m", "tqsm_branches", "tqsm_branches_modelled", "tqsm_max_branch_order", "tqsm_trunk_area_m2",
    "tqsm_branch_area_m2", "tqsm_total_area_m2", "tqsm_dbh_qsm_m", "tqsm_dbh_cyl_m", "tqsm_crown_diam_ave_m",
    "tqsm_crown_diam_max_m", "tqsm_crown_area_conv_m2", "tqsm_crown_area_alpha_m2", "tqsm_crown_base_height_m",
    "tqsm_crown_length_m", "tqsm_crown_ratio", "tqsm_crown_volume_conv_m3", "tqsm_crown_volume_alpha_m3",
    "tqsm_point_dist_mean_m", "tqsm_point_dist_max_m", "tqsm_point_dist_trunk_mean_m", "tqsm_point_dist_branch_mean_m",
    "tqsm_unsupported_cylinders", "tqsm_patch_diam1_m", "tqsm_patch_diam2_min_m", "tqsm_patch_diam2_max_m",
];

/// TreeQSM's attribute block; empty cells for a tree without one.
pub fn tqsm_row(a: Option<&QsmAttributes>) -> Vec<String> {
    let Some(a) = a else { return TQSM_COLUMNS.iter().map(|_| String::new()).collect() };
    vec![
        csv_num(a.total_volume, 3), csv_num(a.trunk_volume, 3), csv_num(a.branch_volume, 3), csv_num(a.tree_height, 3),
        csv_num(a.trunk_length, 3), csv_num(a.branch_length, 3), a.number_branches.to_string(),
        a.number_branches_modelled.to_string(), a.max_branch_order.to_string(), csv_num(a.trunk_area, 4),
        csv_num(a.branch_area, 4), csv_num(a.total_area, 4), csv_num(a.dbh_qsm, 4), csv_num(a.dbh_cyl, 4),
        csv_num(a.crown_diam_ave, 3), csv_num(a.crown_diam_max, 3), csv_num(a.crown_area_conv, 3),
        csv_num(a.crown_area_alpha, 3), csv_num(a.crown_base_height, 3), csv_num(a.crown_length, 3),
        csv_num(a.crown_ratio, 3), csv_num(a.crown_volume_conv, 3), csv_num(a.crown_volume_alpha, 3),
        csv_num(a.point_distance_mean, 5), csv_num(a.point_distance_max, 5), csv_num(a.point_distance_trunk_mean, 5),
        csv_num(a.point_distance_branch_mean, 5), a.unsupported_cylinders.to_string(), csv_num(a.patch_diam1, 3),
        csv_num(a.patch_diam2_min, 3), csv_num(a.patch_diam2_max, 3),
    ]
}

/// What the table carries, decided over every tree as the module does.
pub struct CsvShape {
    pub has_qsm: bool,
    pub has_branches: bool,
    pub has_treeqsm: bool,
}

pub fn header(shape: &CsvShape) -> Vec<&'static str> {
    let mut h: Vec<&'static str> = BASE_HEADER.to_vec();
    if shape.has_qsm {
        h.extend(["qsm_stem_volume_m3", "qsm_stem_volume_std_m3", "qsm_stem_volume_ci95_m3"]);
        if shape.has_branches {
            h.extend(["qsm_branch_volume_m3", "qsm_branch_count", "qsm_total_volume_m3"]);
        }
        h.extend(["qsm_confidence", "qsm_completeness", "qsm_accepted_slices", "qsm_rejected_slices"]);
        h.extend(["biomass_kg", "biomass_ci95_kg", "carbon_kg", "carbon_ci95_kg", "co2e_kg", "co2e_ci95_kg"]);
    }
    if shape.has_treeqsm {
        h.extend(TQSM_COLUMNS);
    }
    h
}

/// The module's table as text: rows in tree-id order, the BOM first.
pub fn metrics_csv(
    rows: &[super::qc::MergedMetric],
    stems: Option<&[StemFit]>,
    qsm: Option<&HashMap<i32, &TreeQsm>>,
    biomass: Option<&HashMap<i32, TreeBiomass>>,
) -> (String, CsvShape) {
    let fits: HashMap<i32, &StemFit> = stems.map(|s| s.iter().map(|f| (f.tree_id, f)).collect()).unwrap_or_default();
    let shape = CsvShape {
        has_qsm: qsm.is_some(),
        has_branches: qsm.is_some_and(|q| q.values().any(|t| t.branch_count > 0)),
        has_treeqsm: qsm.is_some_and(|q| q.values().any(|t| t.treeqsm.is_some())),
    };
    let mut lines = vec![header(&shape).join(",")];
    let mut sorted: Vec<&super::qc::MergedMetric> = rows.iter().collect();
    sorted.sort_by_key(|m| m.metric.tree_id);
    for m in sorted {
        let t = &m.metric;
        let fit = fits.get(&t.tree_id).filter(|f| f.dbh.is_finite());
        let refined = m.dbh_source == DbhSource::StemFit && fit.is_some();
        let mut cells: Vec<String> = vec![
            t.tree_id.to_string(), t.count.to_string(),
            csv_num(t.height, 2), csv_num(t.dbh, 3), if refined { "ransac" } else { "algebraic" }.to_string(), csv_num(t.basal_area, 4),
            csv_num(t.crown_area, 2), csv_num(t.crown_diameter, 2),
            if refined { fit.unwrap().inlier_count.to_string() } else { String::new() },
            if refined { csv_num(fit.unwrap().rmse, 4) } else { String::new() },
            csv_num(t.x, 3), csv_num(t.y, 3), csv_num(t.base_z, 3), csv_num(t.lean_deg, 1),
        ];
        if let Some(q) = qsm {
            let tq = q.get(&t.tree_id);
            let n = |v: Option<f64>, d: usize| v.map(|v| csv_num(v, d)).unwrap_or_default();
            cells.push(n(tq.map(|q| q.stem_volume), 4));
            cells.push(n(tq.map(|q| q.stem_volume_std), 5));
            cells.push(n(tq.map(|q| q.stem_volume_ci95), 5));
            if shape.has_branches {
                cells.push(n(tq.map(|q| q.branch_volume), 4));
                cells.push(tq.map(|q| q.branch_count.to_string()).unwrap_or_default());
                cells.push(n(tq.map(|q| q.total_volume), 4));
            }
            cells.push(n(tq.map(|q| q.confidence), 3));
            cells.push(n(tq.map(|q| q.completeness), 3));
            cells.push(tq.map(|q| q.accepted_slices.to_string()).unwrap_or_default());
            cells.push(tq.map(|q| q.rejected_slices.to_string()).unwrap_or_default());
            let bm = biomass.and_then(|b| b.get(&t.tree_id));
            cells.push(n(bm.map(|b| b.biomass), 2));
            cells.push(n(bm.map(|b| 1.96 * b.biomass_std), 2));
            cells.push(n(bm.map(|b| b.carbon), 2));
            cells.push(n(bm.map(|b| 1.96 * b.carbon_std), 2));
            cells.push(n(bm.map(|b| b.co2e), 2));
            cells.push(n(bm.map(|b| 1.96 * b.co2e_std), 2));
            if shape.has_treeqsm {
                cells.extend(tqsm_row(tq.and_then(|q| q.treeqsm.as_ref())));
            }
        }
        lines.push(cells.join(","));
    }
    (csv_text(&lines), shape)
}

// --- the operation ------------------------------------------------------------

fn f_0_25() -> f64 { 0.25 }
fn f_0_5() -> f64 { 0.5 }
fn f_1_2() -> f64 { 1.2 }
fn f_1_4() -> f64 { 1.4 }
fn yes() -> bool { true }
fn pine_key() -> String { "pine".into() }
fn f_400() -> f64 { DEFAULT_BIOMASS_PARAMS.density }
fn f_25() -> f64 { DEFAULT_BIOMASS_PARAMS.density_std }
fn f_0_02() -> f64 { DEFAULT_BIOMASS_PARAMS.carbon_fraction_std }

/// The Metrics module's table.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetricsCsvParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Where to write the CSV.
    pub out_path: String,
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
    /// Add the QSM, biomass and TreeQSM columns from qsm.json where present (default true).
    #[serde(default = "yes")]
    pub use_qsm: bool,
    /// Density preset for trees with no entry in species.json: "pine", "spruce", "birch", "aspen", "oak", or "custom" (default "pine").
    #[serde(default = "pine_key")]
    pub fallback_species: String,
    /// Wood basic density for the custom fallback, kg/m³ (default 400).
    #[serde(default = "f_400")]
    pub density: f64,
    /// 1σ density uncertainty for the custom fallback, kg/m³ (default 25).
    #[serde(default = "f_25")]
    pub density_std: f64,
    /// Carbon fraction for the custom fallback (default 0.50).
    #[serde(default = "f_0_5")]
    pub carbon_fraction: f64,
    /// 1σ carbon-fraction uncertainty (default 0.02).
    #[serde(default = "f_0_02")]
    pub carbon_fraction_std: f64,
    /// Relative 1σ uncertainty on branch volume (default 0.25).
    #[serde(default = "f_0_25")]
    pub branch_unc_fraction: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MetricsCsvOutcome {
    pub out_path: String,
    pub rows: usize,
    pub columns: Vec<&'static str>,
    pub has_qsm: bool,
    pub has_branches: bool,
    pub has_treeqsm: bool,
    /// Trees whose biomass used the fallback density.
    pub fallback_count: usize,
}

fn export_csv(ctx: &OpContext, p: MetricsCsvParams) -> Result<MetricsCsvOutcome, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    non_empty(&p.out_path, "outPath")?;
    if let Some(parent) = Path::new(&p.out_path).parent().filter(|d| !d.as_os_str().is_empty()) {
        if !parent.is_dir() {
            return Err(format!("{} is not a directory", parent.display()));
        }
    }
    let key = p.fallback_species.trim().to_lowercase();
    if key != CUSTOM_SPECIES_KEY && species_density(&key).is_none() {
        let keys: Vec<&str> = SPECIES_DENSITIES.iter().map(|s| s.key).collect();
        return Err(format!("fallbackSpecies '{}' is not a density preset: use {} or custom", p.fallback_species, keys.join(", ")));
    }
    let base = BiomassParams { density: p.density, density_std: p.density_std, carbon_fraction: p.carbon_fraction, carbon_fraction_std: p.carbon_fraction_std, branch_unc_fraction: p.branch_unc_fraction };
    validate_biomass_params(&base)?;
    let _ = biomass_params_for_species(&key, base);

    let sink = ctx.progress.under("metrics");
    let metrics = run_tree_metrics(&sink, &p.octree_dir, p.crown_cell, p.bh_low, p.bh_high, p.dtm_cell)?;
    let stems = if p.merge_stems { octree_read_stems(p.octree_dir.clone())? } else { None };
    let merged = merge_stem_fits(&metrics, stems.as_deref());
    let qsm = if p.use_qsm { octree_read_qsm(p.octree_dir.clone())? } else { None };
    let qsm_map: Option<HashMap<i32, &TreeQsm>> = qsm.as_ref().map(|q| q.trees.iter().map(|t| (t.tree_id, t)).collect());
    let mut fallback_count = 0;
    let biomass: Option<HashMap<i32, TreeBiomass>> = qsm.as_ref().map(|q| {
        let species: HashMap<i32, String> = {
            let text = octree_read_species(p.octree_dir.clone()).unwrap_or_default();
            let raw: std::collections::BTreeMap<String, String> = if text.trim().is_empty() { Default::default() } else { serde_json::from_str(&text).unwrap_or_default() };
            raw.into_iter().filter_map(|(k, v)| k.parse::<i32>().ok().map(|id| (id, v))).collect()
        };
        let (per_tree, n) = compute_species_aware_biomass(&q.trees, &species, &key, base);
        fallback_count = n;
        per_tree.into_iter().map(|b| (b.tree_id, b)).collect()
    });
    let (text, shape) = metrics_csv(&merged, stems.as_deref(), qsm_map.as_ref(), biomass.as_ref());
    std::fs::write(&p.out_path, &text).map_err(|e| format!("write {}: {e}", p.out_path))?;
    Ok(MetricsCsvOutcome {
        out_path: p.out_path,
        rows: merged.len(),
        columns: header(&shape),
        has_qsm: shape.has_qsm,
        has_branches: shape.has_branches,
        has_treeqsm: shape.has_treeqsm,
        fallback_count,
    })
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![op!("export.csv", Export, mutates: false, stage: Some("metrics"),
        "Write the per-tree metrics table as CSV: the measured row with its diameter source, the QSM volumes, biomass and carbon with 95 % intervals, and TreeQSM's attributes where computed.", MetricsCsvParams, export_csv)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::octree::TreeMetric;

    fn tree(tree_id: i32, dbh: f64, height: f64) -> TreeMetric {
        TreeMetric { tree_id, count: 4000, height, dbh, basal_area: std::f64::consts::PI * (dbh / 2.0).powi(2), crown_area: 12.0, crown_diameter: 3.9, x: 1.0, y: 2.0, base_z: 0.5, lean_deg: 1.25 }
    }

    fn fit(tree_id: i32, dbh: f64) -> StemFit {
        serde_json::from_value(serde_json::json!({ "treeId": tree_id, "dbh": dbh, "centerX": 0, "centerY": 0, "inlierCount": 40, "bandCount": 60, "rmse": 0.004, "writtenStemPoints": 0 })).unwrap()
    }

    fn qsm_tree(tree_id: i32, branches: u32) -> TreeQsm {
        serde_json::from_value(serde_json::json!({
            "treeId": tree_id, "baseX": 0, "baseY": 0, "baseZ": 0, "height": 20, "slices": [], "branches": [],
            "branchVolume": if branches > 0 { 0.1 } else { 0.0 }, "branchCount": branches, "totalVolume": 0.9, "stemVolume": 0.8,
            "stemVolumeStd": 0.02, "stemVolumeCi95": 0.0392, "dbh": 0.3, "confidence": 0.9, "completeness": 0.95, "acceptedSlices": 10, "rejectedSlices": 1,
        }))
        .unwrap()
    }

    #[test]
    fn the_table_has_the_modules_columns_and_shape() {
        let rows = merge_stem_fits(&[tree(2, 0.30, 20.0), tree(1, 0.25, f64::NAN)], Some(&[fit(1, 0.26)]));
        let (text, shape) = metrics_csv(&rows, Some(&[fit(1, 0.26)]), None, None);
        assert!(!shape.has_qsm);
        let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
        assert_eq!(lines[0], BASE_HEADER.join(","));
        // 1.25° prints as 1.3, as the renderer's toFixed prints it.
        assert_eq!(lines[1], "1,4000,,0.260,ransac,0.0531,12.00,3.90,40,0.0040,1.000,2.000,0.500,1.3");
        assert_eq!(lines[2], "2,4000,20.00,0.300,algebraic,0.0707,12.00,3.90,,,1.000,2.000,0.500,1.3");
        assert!(!text.contains("NaN"));

        let q1 = qsm_tree(1, 0);
        let q2 = qsm_tree(2, 3);
        let qsm: HashMap<i32, &TreeQsm> = [(1, &q1), (2, &q2)].into();
        let (text, shape) = metrics_csv(&rows, None, Some(&qsm), None);
        assert!(shape.has_qsm && shape.has_branches && !shape.has_treeqsm);
        let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
        assert!(lines[0].ends_with("qsm_stem_volume_m3,qsm_stem_volume_std_m3,qsm_stem_volume_ci95_m3,qsm_branch_volume_m3,qsm_branch_count,qsm_total_volume_m3,qsm_confidence,qsm_completeness,qsm_accepted_slices,qsm_rejected_slices,biomass_kg,biomass_ci95_kg,carbon_kg,carbon_ci95_kg,co2e_kg,co2e_ci95_kg"));
        assert!(lines[2].contains(",0.8000,0.02000,0.03920,0.1000,3,0.9000,0.900,0.950,10,1,,,,,,"));
        assert_eq!(header(&shape).len(), lines[0].split(',').count());
        assert_eq!(lines[2].split(',').count(), header(&shape).len());

        let q_only_one: HashMap<i32, &TreeQsm> = [(1, &q1)].into();
        let (text, shape) = metrics_csv(&rows, None, Some(&q_only_one), None);
        assert!(!shape.has_branches);
        let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
        let cells: Vec<&str> = lines[2].split(',').collect();
        assert_eq!(cells.len(), header(&shape).len());
        assert!(cells[BASE_HEADER.len()..].iter().all(|c| c.is_empty()), "no QSM for tree 2: empty cells, {}", lines[2]);
        assert_eq!(tqsm_row(None).len(), TQSM_COLUMNS.len());
    }

    #[test]
    fn the_operation_is_catalogued_and_refuses_bad_parameters_first() {
        let op = super::super::find("export.csv").expect("export.csv");
        assert!(!op.mutates);
        let ctx = OpContext::silent();
        let run = |v: serde_json::Value| super::super::run("export.csv", v, &ctx).unwrap_err();
        assert!(run(serde_json::json!({ "octreeDir": "/a" })).contains("outPath"));
        assert!(run(serde_json::json!({ "octreeDir": "/a", "outPath": "/no/such/dir/x.csv" })).contains("not a directory"));
        let out = std::env::temp_dir().join("pcl-metrics.csv").to_string_lossy().to_string();
        assert!(run(serde_json::json!({ "octreeDir": "/a", "outPath": out, "fallbackSpecies": "larch" })).contains("not a density preset"));
    }
}
