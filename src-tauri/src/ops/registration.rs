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

//! Fine registration of one dataset onto another (the Editor's Fine
//! registration panel): `change.register` measures the rigid transform
//! and `dataset.transform` writes a dataset moved by one.

use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::project::safe_output_name;
use super::{non_empty, OpContext, OpDef};
use crate::commands::cancel::try_begin;
use crate::commands::octree::{
    run_register, run_transform_dataset, DatasetRegistration, OctreeImportResult, RegisterInit, RegisterInitMode,
};
use crate::commands::register::{Dof, Kernel, Method, RegisterParams};

fn dflt() -> RegisterParams { RegisterParams::default() }
fn d_method() -> Method { dflt().method }
fn d_kernel() -> Kernel { dflt().kernel }
fn d_dof() -> Dof { dflt().dof }
fn d_voxel() -> f64 { dflt().voxel }
fn d_levels() -> u32 { dflt().levels }
fn d_corr() -> f64 { dflt().max_corr_dist }
fn d_iters() -> u32 { dflt().max_iters }
fn d_normal_k() -> u32 { dflt().normal_k }
fn d_angle() -> f64 { dflt().max_normal_angle_deg }
fn d_floor() -> f64 { dflt().kernel_floor }
fn d_max_points() -> u32 { dflt().max_points }
fn d_variation() -> f64 { dflt().max_variation }
fn d_block() -> f64 { dflt().jackknife_block }
fn d_feature_voxel() -> f64 { init_dflt().feature_voxel }
fn d_feature_iterations() -> u32 { init_dflt().feature_iterations }
fn init_dflt() -> RegisterInit { RegisterInit::default() }
fn d_init() -> RegisterInitMode { init_dflt().mode }
fn d_search() -> f64 { init_dflt().search_radius }
fn d_yaw_range() -> f64 { init_dflt().yaw_range_deg }
fn d_dtm_cell() -> f64 { init_dflt().dtm_cell }

/// The Fine registration panel's settings, flat.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterOpParams {
    /// The dataset that stays.
    pub reference_dir: String,
    /// The dataset to move onto it.
    pub moving_dir: String,
    /// Where the fit starts: "current" (as they stand), "auto" (a coarse search by stems and crowns), "skeleton" (the stored skeleton alignment), "manual" (the offset below), "features" (a global search by surface features, any heading).
    #[serde(default = "d_init")]
    pub init: RegisterInitMode,
    /// Manual start: metres east, north, up, and degrees of yaw about the moving cloud's centre.
    #[serde(default)]
    pub dx: f64,
    #[serde(default)]
    pub dy: f64,
    #[serde(default)]
    pub dz: f64,
    #[serde(default)]
    pub yaw_deg: f64,
    /// Automatic start: how far the moving cloud may have to move, metres (default 30).
    #[serde(default = "d_search")]
    pub search_radius: f64,
    /// Automatic start: the yaw fan, ± degrees (default 5).
    #[serde(default = "d_yaw_range")]
    pub yaw_range_deg: f64,
    /// Automatic start: the ground cell for heights above ground, metres (default 0.5).
    #[serde(default = "d_dtm_cell")]
    pub dtm_cell: f64,
    /// Feature start: the cell the features are computed on, metres (default 0.3).
    #[serde(default = "d_feature_voxel")]
    pub feature_voxel: f64,
    /// Feature start: transform hypotheses at most (default 50000) — eight per feature pair, the pairs agreeing with the most others first.
    #[serde(default = "d_feature_iterations")]
    pub feature_iterations: u32,
    /// "symmetric" (Rusinkiewicz 2019, default), "pointToPlane", "pointToPoint" or "gicp" (Segal 2009, plane-to-plane).
    #[serde(default = "d_method")]
    pub method: Method,
    /// "welsch" (default), "cauchy", "tukey" or "none".
    #[serde(default = "d_kernel")]
    pub kernel: Kernel,
    /// "full" (default), "levelled" (xyz + yaw) or "translation".
    #[serde(default = "d_dof")]
    pub dof: Dof,
    /// The finest decimation cell, metres (default 0.05).
    #[serde(default = "d_voxel")]
    pub voxel: f64,
    /// Pyramid levels (default 4).
    #[serde(default = "d_levels")]
    pub levels: u32,
    /// Correspondence reach at the coarsest level, metres (default 1.0).
    #[serde(default = "d_corr")]
    pub max_corr_dist: f64,
    /// Iterations at most per level (default 50).
    #[serde(default = "d_iters")]
    pub max_iters: u32,
    /// Neighbours for the normals (default 16).
    #[serde(default = "d_normal_k")]
    pub normal_k: u32,
    /// Pairs whose normals disagree by more, degrees, are dropped (default 45).
    #[serde(default = "d_angle")]
    pub max_normal_angle_deg: f64,
    /// The robust scale's floor, metres (default 0.002).
    #[serde(default = "d_floor")]
    pub kernel_floor: f64,
    /// Points at most per cloud per level (default 1000000).
    #[serde(default = "d_max_points")]
    pub max_points: u32,
    /// Surface variation above which a neighbourhood has no normal (default 0.15).
    #[serde(default = "d_variation")]
    pub max_variation: f64,
    /// The side of the spatial blocks the jackknife covariance leaves out one at a time, metres (default 2.0).
    #[serde(default = "d_block")]
    pub jackknife_block: f64,
    /// Also write the moving dataset, moved, as a new dataset (default false).
    #[serde(default)]
    pub apply: bool,
    /// The moved copy's name (default "<moving> registered").
    #[serde(default)]
    pub name: Option<String>,
    /// Where the moved copy goes; defaults to `<project>/octrees/<safe name>` beside the moving dataset.
    #[serde(default)]
    pub out_dir: Option<String>,
    /// Write the registration (matrix and report) as JSON here — what `dataset.transform` takes as `registrationJson`.
    #[serde(default)]
    pub out_json: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterOutcome {
    #[serde(flatten)]
    pub registration: DatasetRegistration,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dataset: Option<OctreeImportResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub json_path: Option<String>,
}

/// The record `dataset.transform` writes into the moved copy's metadata.
fn provenance(r: &DatasetRegistration) -> serde_json::Value {
    serde_json::json!({
        "referenceDir": r.reference_dir,
        "referenceName": r.reference_name,
        "initMode": r.init_mode,
        "rmse": r.report.rmse,
        "sigma": r.report.sigma,
        "positionStdErr": r.report.position_std_err,
        "translationStdErrBlocks": r.report.translation_std_err_blocks,
        "rotationStdErrDegBlocks": r.report.rotation_std_err_deg_blocks,
        "inliers": r.report.inliers,
        "translation": r.report.translation,
        "translationStdErr": r.report.translation_std_err,
        "rotationDeg": r.report.rotation_deg,
        "rotationStdErrDeg": r.report.rotation_std_err_deg,
        "wellConstrained": r.report.well_constrained,
    })
}

fn derived_dir(src_dir: &str, name: &str, out_dir: &Option<String>) -> Result<String, String> {
    let out = match out_dir.as_deref().filter(|d| !d.trim().is_empty()) {
        Some(d) => d.to_string(),
        None => {
            let safe = safe_output_name(name);
            if safe.is_empty() {
                return Err(format!("'{name}' leaves no usable directory name — pass outDir"));
            }
            let octrees = Path::new(src_dir).parent().ok_or("the dataset has no parent directory")?;
            octrees.join(safe).to_string_lossy().into_owned()
        }
    };
    if Path::new(&out).exists() {
        return Err(format!("{out} already exists"));
    }
    Ok(out)
}

fn change_register(ctx: &OpContext, p: RegisterOpParams) -> Result<RegisterOutcome, String> {
    non_empty(&p.reference_dir, "referenceDir")?;
    non_empty(&p.moving_dir, "movingDir")?;
    let params = RegisterParams {
        method: p.method, kernel: p.kernel, dof: p.dof, voxel: p.voxel, levels: p.levels, max_corr_dist: p.max_corr_dist,
        max_iters: p.max_iters, normal_k: p.normal_k, max_normal_angle_deg: p.max_normal_angle_deg, kernel_floor: p.kernel_floor,
        max_points: p.max_points, max_variation: p.max_variation, jackknife_block: p.jackknife_block, ..RegisterParams::default()
    };
    params.validate()?;
    let init = RegisterInit {
        mode: p.init, dx: p.dx, dy: p.dy, dz: p.dz, yaw_deg: p.yaw_deg,
        search_radius: p.search_radius, yaw_range_deg: p.yaw_range_deg, dtm_cell: p.dtm_cell,
        feature_voxel: p.feature_voxel, feature_iterations: p.feature_iterations,
    };
    let name = p.name.clone().filter(|n| !n.trim().is_empty());
    let _run = try_begin("register").ok_or_else(|| "a registration is already in progress — stop it first".to_string())?;
    let registration = run_register(&ctx.progress, &p.reference_dir, &p.moving_dir, &init, &params)?;
    let json_path = match &p.out_json {
        Some(path) if !path.trim().is_empty() => {
            let text = serde_json::to_string_pretty(&registration).map_err(|e| e.to_string())?;
            std::fs::write(path, text).map_err(|e| format!("write {path}: {e}"))?;
            Some(path.clone())
        }
        _ => None,
    };
    let dataset = if p.apply {
        let name = name.unwrap_or_else(|| format!("{} registered", registration.moving_name));
        let out_dir = derived_dir(&p.moving_dir, &name, &p.out_dir)?;
        let _write = try_begin("transform").ok_or_else(|| "a moved copy is already being written — wait for it".to_string())?;
        Some(run_transform_dataset(&ctx.progress, &p.moving_dir, &out_dir, &name, &registration.matrix, Some(provenance(&registration)))?)
    } else { None };
    Ok(RegisterOutcome { registration, dataset, json_path })
}

/// A dataset moved by a rigid transform, as a new dataset.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransformParams {
    /// The dataset to move.
    pub octree_dir: String,
    /// The new dataset's name.
    pub name: String,
    /// Where it goes; defaults to `<project>/octrees/<safe name>` beside the source.
    #[serde(default)]
    pub out_dir: Option<String>,
    /// The transform, row-major 4 × 4 in world coordinates (16 numbers); a rotation and a translation, nothing else.
    #[serde(default)]
    pub matrix: Option<Vec<f64>>,
    /// Or the JSON `change.register` wrote with `outJson`: its matrix, and its report as the copy's provenance.
    #[serde(default)]
    pub registration_json: Option<String>,
}

fn dataset_transform(ctx: &OpContext, p: TransformParams) -> Result<OctreeImportResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    non_empty(&p.name, "name")?;
    let (matrix, record) = match (&p.matrix, &p.registration_json) {
        (Some(m), None) => (m.clone(), None),
        (None, Some(path)) if !path.trim().is_empty() => {
            let text = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
            let r: DatasetRegistration = serde_json::from_str(&text).map_err(|e| format!("{path} is not a registration: {e}"))?;
            (r.matrix.clone(), Some(provenance(&r)))
        }
        (Some(_), Some(_)) => return Err("pass matrix or registrationJson, not both".into()),
        _ => return Err("pass matrix (16 numbers) or registrationJson".into()),
    };
    crate::commands::register::Rigid::from_mat4(&matrix)?;
    let out_dir = derived_dir(&p.octree_dir, &p.name, &p.out_dir)?;
    let _run = try_begin("transform").ok_or_else(|| "a moved copy is already being written — wait for it".to_string())?;
    run_transform_dataset(&ctx.progress, &p.octree_dir, &out_dir, &p.name, &matrix, record)
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![
        op!("change.register", Change, mutates: false, stage: Some("register"),
            "Fine registration of one dataset onto another: the rigid transform (symmetric ICP over a pyramid, robust, with its uncertainty), optionally written as a moved copy.", RegisterOpParams, change_register),
        op!("dataset.transform", Dataset, mutates: true, stage: Some("transform"),
            "Write a dataset moved by a rigid transform as a new dataset, every edit baked in.", TransformParams, dataset_transform),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(name: &str, v: serde_json::Value) -> String {
        super::super::run(name, v, &OpContext::silent()).unwrap_err()
    }

    #[test]
    fn the_operations_are_catalogued_with_the_panels_defaults() {
        let reg = super::super::find("change.register").unwrap();
        assert_eq!(reg.group, super::super::Group::Change);
        assert_eq!(reg.stage, Some("register"));
        let s = reg.params_schema();
        assert_eq!(s["properties"]["voxel"]["default"], 0.05);
        assert_eq!(s["properties"]["levels"]["default"], 4);
        assert_eq!(s["properties"]["maxCorrDist"]["default"], 1.0);
        assert_eq!(s["properties"]["maxIters"]["default"], 50);
        assert_eq!(s["properties"]["normalK"]["default"], 16);
        assert_eq!(s["properties"]["maxNormalAngleDeg"]["default"], 45.0);
        assert_eq!(s["properties"]["kernelFloor"]["default"], 0.002);
        assert_eq!(s["properties"]["maxPoints"]["default"], 1_000_000);
        assert_eq!(s["properties"]["method"]["default"], "symmetric");
        assert_eq!(s["properties"]["kernel"]["default"], "welsch");
        assert_eq!(s["properties"]["dof"]["default"], "full");
        assert_eq!(s["properties"]["init"]["default"], "current");
        assert_eq!(s["properties"]["searchRadius"]["default"], 30.0);
        assert_eq!(s["properties"]["yawRangeDeg"]["default"], 5.0);
        assert_eq!(s["properties"]["featureVoxel"]["default"], 0.3);
        assert_eq!(s["properties"]["jackknifeBlock"]["default"], 2.0);
        assert!(s["properties"]["method"]["oneOf"].to_string().contains("gicp") || s["properties"]["method"].to_string().contains("gicp"));
        let t = super::super::find("dataset.transform").unwrap();
        assert_eq!(t.group, super::super::Group::Dataset);
        assert!(t.mutates);
    }

    #[test]
    fn bad_parameters_are_refused_before_anything_is_read() {
        assert!(run("change.register", json!({ "referenceDir": "/a", "movingDir": "/a" })).contains("same"));
        assert!(run("change.register", json!({ "referenceDir": "/a", "movingDir": "/b", "voxel": 0 })).contains("voxel"));
        assert!(run("change.register", json!({ "referenceDir": "/a", "movingDir": "/b", "levels": 0 })).contains("levels"));
        assert!(run("change.register", json!({ "referenceDir": "/a", "movingDir": "/b", "method": "best" })).contains("unknown variant"));
        assert!(run("change.register", json!({ "referenceDir": "", "movingDir": "/b" })).contains("referenceDir"));
        assert!(run("dataset.transform", json!({ "octreeDir": "/a", "name": "x" })).contains("matrix"));
        assert!(run("dataset.transform", json!({ "octreeDir": "/a", "name": "x", "matrix": [1.0, 2.0] })).contains("16"));
        let mut m = vec![0.0; 16];
        m[0] = 2.0; m[5] = 1.0; m[10] = 1.0; m[15] = 1.0;
        assert!(run("dataset.transform", json!({ "octreeDir": "/a", "name": "x", "matrix": m })).contains("orthonormal"));
        let id = crate::commands::register::Rigid::IDENTITY.to_mat4();
        assert!(run("dataset.transform", json!({ "octreeDir": "/a", "name": "x", "matrix": id, "registrationJson": "/r.json" })).contains("not both"));
    }
}
