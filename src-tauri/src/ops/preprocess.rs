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

//! The Preprocessing module without its window: scanner projects
//! imported from E57, PTX / PTS and XYZ files (and the development
//! edition's scanner project directories), their scan
//! positions co-registered into one frame, and a region of them
//! exported as the LAS / LAZ that `dataset.import` then takes.
//!
//! Registration is the same arithmetic the Preprocessing panel runs:
//! Kabsch over tie points (a correction composed onto the scan's
//! current pose), ICP fine refinement (an absolute pose), sphere and
//! plane target detection with their RANSAC matching, and the
//! multi-station adjustment over every E57 / PTX scan. Each step
//! reports its result and writes a pose only when asked (`apply`),
//! as the panel's Apply buttons do, because a pose overwrite cannot
//! be undone short of re-importing the project.

use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{non_empty, OpContext, OpDef};
use crate::commands::coregister::{
    coregister_apply, coregister_apply_delta, coregister_list_scans, coregister_solve, detect_sphere_targets,
    extract_plane_patches, match_plane_pairs, match_sphere_pairs, read_scan_world, run_icp, run_msa, IcpParams,
    IcpScanRef, MsaCorrespondence, MsaParams, PlaneExtractParams, PlaneMatchParams, PlanePatch, SphereDetectParams,
    SphereMatchParams, SphereTarget, TiePoint, UnifiedScan,
};
use crate::commands::e57::{e57_import_project, e57_list_projects, e57_remove_project, run_e57_export, E57ExportBbox};
use crate::commands::ptx::{ptx_list_projects, ptx_remove_project, run_ptx_export, run_ptx_import, PtxExportBbox};
use crate::commands::xyz::{run_xyz_export, xyz_import_project, xyz_list_projects, xyz_remove_project, xyz_set_mapping, XyzExportBbox, XyzMapping};

fn project_folder(ctx: &OpContext, given: &Option<String>) -> Result<String, String> {
    if let Some(f) = given.as_deref().filter(|f| !f.trim().is_empty()) {
        return Ok(f.to_string());
    }
    ctx.state
        .project_folder()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "no project is open — pass projectFolder or run project.open first".to_string())
}

fn to_value<T: Serialize>(t: T) -> Result<Value, String> {
    serde_json::to_value(t).map_err(|e| format!("serialise: {e}"))
}

/// Which importer a scanner project belongs to.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Importer {
    E57,
    Ptx,
    Xyz,
}

/// The importer names `format` takes.
const IMPORTER_NAMES: &[&str] = &[
    "e57",
    "ptx",
    "xyz",
];

impl Importer {
    pub fn as_str(self) -> &'static str {
        match self {
            Importer::E57 => "e57",
            Importer::Ptx => "ptx",
            Importer::Xyz => "xyz",
        }
    }

    fn parse(s: &str) -> Result<Importer, String> {
        match s.trim().to_lowercase().as_str() {
            "e57" => Ok(Importer::E57),
            "ptx" | "pts" => Ok(Importer::Ptx),
            "xyz" => Ok(Importer::Xyz),
            other => Err(format!("unknown importer '{other}': use {}", IMPORTER_NAMES.join(", "))),
        }
    }
}

/// The importer a source path belongs to: an .e57 file, a .ptx / .pts
/// file, or any other text file as XYZ / ASCII.
pub fn importer_for(source_path: &str) -> Result<Importer, String> {
    let p = Path::new(source_path);
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("e57") => Ok(Importer::E57),
        Some("ptx") | Some("pts") => Ok(Importer::Ptx),
        Some("xyz") | Some("txt") | Some("csv") | Some("asc") | Some("tsv") => Ok(Importer::Xyz),
        Some(other) => Err(format!("cannot tell the importer from '.{other}': pass format ({})", IMPORTER_NAMES.join(", "))),
        None => Err("cannot tell the importer from a file with no extension: pass format".into()),
    }
}

// --- projects ---------------------------------------------------------------

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectsParams {
    /// The project folder; defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
}

fn preprocess_projects(ctx: &OpContext, p: ProjectsParams) -> Result<Value, String> {
    let folder = project_folder(ctx, &p.project_folder)?;
    Ok(json!({
        "projectFolder": folder,
        "e57": e57_list_projects(folder.clone())?,
        "ptx": ptx_list_projects(folder.clone())?,
        "xyz": xyz_list_projects(folder)?,
    }))
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportParams {
    /// The .e57 file, the .ptx / .pts file or the XYZ / ASCII file.
    pub source_path: String,
    /// The project folder; defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
    /// Project name; defaults to the file or directory name.
    #[serde(default)]
    pub name: Option<String>,
    /// "e57", "ptx" or "xyz"; null tells from the path.
    #[serde(default)]
    pub format: Option<String>,
}

fn preprocess_import(ctx: &OpContext, p: ImportParams) -> Result<Value, String> {
    non_empty(&p.source_path, "sourcePath")?;
    let folder = project_folder(ctx, &p.project_folder)?;
    let importer = match p.format.as_deref().filter(|f| !f.trim().is_empty()) {
        Some(f) => Importer::parse(f)?,
        None => importer_for(&p.source_path)?,
    };
    let name = p
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .or_else(|| Path::new(&p.source_path).file_stem().map(|s| s.to_string_lossy().into_owned()))
        .ok_or("name is required")?;
    let summary = match importer {
        Importer::E57 => to_value(e57_import_project(folder, p.source_path, name)?)?,
        Importer::Ptx => to_value(run_ptx_import(&ctx.progress, &folder, &p.source_path, &name)?)?,
        Importer::Xyz => to_value(xyz_import_project(folder, p.source_path, name)?)?,
    };
    Ok(json!({ "importer": importer, "project": summary }))
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectRefParams {
    /// "e57", "ptx" or "xyz".
    pub format: String,
    /// The project id, as preprocess.projects lists it.
    pub id: String,
    /// The project folder; defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
}

fn preprocess_remove(ctx: &OpContext, p: ProjectRefParams) -> Result<Value, String> {
    non_empty(&p.id, "id")?;
    let folder = project_folder(ctx, &p.project_folder)?;
    let importer = Importer::parse(&p.format)?;
    match importer {
        Importer::E57 => e57_remove_project(folder, p.id.clone())?,
        Importer::Ptx => ptx_remove_project(folder, p.id.clone())?,
        Importer::Xyz => xyz_remove_project(folder, p.id.clone())?,
    }
    Ok(json!({ "importer": importer, "id": p.id, "removed": true }))
}

/// Which columns of an XYZ / ASCII file hold what (0-based).
#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XyzMappingParams {
    pub x: u32,
    pub y: u32,
    pub z: u32,
    #[serde(default)]
    pub intensity: Option<u32>,
    #[serde(default)]
    pub r: Option<u32>,
    #[serde(default)]
    pub g: Option<u32>,
    #[serde(default)]
    pub b: Option<u32>,
    #[serde(default)]
    pub classification: Option<u32>,
    /// A per-point time column, written as the LAS GPS time.
    #[serde(default)]
    pub gps_time: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct XyzMappingOpParams {
    /// The XYZ project id.
    pub id: String,
    /// The column mapping.
    pub mapping: XyzMappingParams,
    /// The project folder; defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
}

fn preprocess_xyz_mapping(ctx: &OpContext, p: XyzMappingOpParams) -> Result<Value, String> {
    non_empty(&p.id, "id")?;
    let folder = project_folder(ctx, &p.project_folder)?;
    let m = p.mapping;
    let mapping = XyzMapping { x: m.x, y: m.y, z: m.z, intensity: m.intensity, r: m.r, g: m.g, b: m.b, classification: m.classification, gps_time: m.gps_time };
    to_value(xyz_set_mapping(folder, p.id, mapping)?)
}

// --- scans and export ---------------------------------------------------------

fn preprocess_scans(ctx: &OpContext, p: ProjectsParams) -> Result<Vec<UnifiedScan>, String> {
    coregister_list_scans(project_folder(ctx, &p.project_folder)?)
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportParams {
    /// "e57", "ptx" or "xyz".
    pub format: String,
    /// The project id, as preprocess.projects lists it.
    pub id: String,
    /// Where to write the LAS / LAZ (the extension decides).
    pub out_path: String,
    /// The scan positions to export, by id; null exports every one (XYZ has none).
    #[serde(default)]
    pub scan_position_ids: Option<Vec<String>>,
    /// Crop in world coordinates: minimum X, or null for no bound.
    #[serde(default)]
    pub x_min: Option<f64>,
    #[serde(default)]
    pub x_max: Option<f64>,
    #[serde(default)]
    pub y_min: Option<f64>,
    #[serde(default)]
    pub y_max: Option<f64>,
    #[serde(default)]
    pub z_min: Option<f64>,
    #[serde(default)]
    pub z_max: Option<f64>,
    /// The project folder; defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
}

fn out_dir_exists(out: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(out).parent().filter(|d| !d.as_os_str().is_empty()) {
        if !parent.is_dir() {
            return Err(format!("{} is not a directory", parent.display()));
        }
    }
    Ok(())
}

fn manifest_value(folder: &str, importer: Importer, id: &str) -> Result<Value, String> {
    crate::fsgrant::safe_component(id)?;
    let path = Path::new(folder).join("preprocessing").join(importer.as_str()).join(id).join("manifest.json");
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn scan_ids_of(manifest: &Value) -> Vec<String> {
    manifest["summary"]["scanPositions"]
        .as_array()
        .map(|a| a.iter().filter_map(|s| s["id"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn preprocess_export(ctx: &OpContext, p: ExportParams) -> Result<Value, String> {
    non_empty(&p.id, "id")?;
    non_empty(&p.out_path, "outPath")?;
    out_dir_exists(&p.out_path)?;
    for (name, lo, hi) in [("x", p.x_min, p.x_max), ("y", p.y_min, p.y_max), ("z", p.z_min, p.z_max)] {
        if let (Some(lo), Some(hi)) = (lo, hi) {
            if !(lo < hi) {
                return Err(format!("{name}Min must be below {name}Max"));
            }
        }
    }
    let folder = project_folder(ctx, &p.project_folder)?;
    let importer = Importer::parse(&p.format)?;
    let manifest = manifest_value(&folder, importer, &p.id)?;
    let ids = match &p.scan_position_ids {
        Some(ids) if !ids.is_empty() => ids.clone(),
        _ => scan_ids_of(&manifest),
    };
    let point_count = match importer {
        Importer::E57 => {
            let all = scan_ids_of(&manifest);
            let want: Vec<usize> = all.iter().enumerate().filter(|(_, id)| ids.contains(id)).map(|(i, _)| i).collect();
            if want.is_empty() {
                return Err("no scan positions selected".into());
            }
            let source = manifest["summary"]["sourcePath"].as_str().ok_or("manifest has no sourcePath")?.to_string();
            let bbox = E57ExportBbox { x_min: p.x_min, x_max: p.x_max, y_min: p.y_min, y_max: p.y_max, z_min: p.z_min, z_max: p.z_max };
            run_e57_export(&ctx.progress, &source, &want, &bbox, &p.out_path)?.point_count
        }
        Importer::Ptx => {
            let scans: Vec<crate::commands::ptx::PtxScanPosition> = serde_json::from_value(manifest["summary"]["scanPositions"].clone())
                .map_err(|e| format!("parse scan positions: {e}"))?;
            let want: Vec<_> = scans.into_iter().filter(|s| ids.contains(&s.id)).collect();
            if want.is_empty() {
                return Err("no scan positions selected".into());
            }
            let source = manifest["summary"]["sourcePath"].as_str().ok_or("manifest has no sourcePath")?.to_string();
            let bbox = PtxExportBbox { x_min: p.x_min, x_max: p.x_max, y_min: p.y_min, y_max: p.y_max, z_min: p.z_min, z_max: p.z_max };
            run_ptx_export(&ctx.progress, &source, &want, &bbox, &p.out_path)?.point_count
        }
        Importer::Xyz => {
            let summary: crate::commands::xyz::XyzProjectSummary = serde_json::from_value(manifest["summary"].clone())
                .map_err(|e| format!("parse manifest: {e}"))?;
            let bbox = XyzExportBbox { x_min: p.x_min, x_max: p.x_max, y_min: p.y_min, y_max: p.y_max, z_min: p.z_min, z_max: p.z_max };
            run_xyz_export(&ctx.progress, &summary, &bbox, &p.out_path)?.point_count
        }
    };
    Ok(json!({ "importer": importer, "id": p.id, "outPath": p.out_path, "scanPositionIds": if importer == Importer::Xyz { Vec::new() } else { ids }, "pointCount": point_count }))
}

// --- registration -------------------------------------------------------------

/// One scan position of one imported project.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScanRef {
    /// "e57" or "ptx".
    pub importer: String,
    pub project_id: String,
    pub scan_id: String,
}

impl ScanRef {
    fn to_icp(&self) -> Result<IcpScanRef, String> {
        non_empty(&self.project_id, "projectId")?;
        non_empty(&self.scan_id, "scanId")?;
        let importer = Importer::parse(&self.importer)?;
        if importer == Importer::Xyz {
            return Err("an XYZ project has no scan positions to register".into());
        }
        Ok(IcpScanRef { importer: importer.as_str().to_string(), project_id: self.project_id.clone(), scan_id: self.scan_id.clone() })
    }
}

/// A pair of world-coordinate points: the same target seen from the
/// source scan and from the target scan.
#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Tie {
    pub source: [f64; 3],
    pub target: [f64; 3],
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SolveParams {
    /// At least three tie points, in world coordinates.
    pub ties: Vec<Tie>,
    /// Apply the correction to this scan's pose (composed onto its current one).
    #[serde(default)]
    pub apply_to: Option<ScanRef>,
    /// The project folder; defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
}

fn finite3(p: &[f64; 3]) -> bool {
    p.iter().all(|v| v.is_finite())
}

fn preprocess_solve(ctx: &OpContext, p: SolveParams) -> Result<Value, String> {
    if p.ties.len() < 3 {
        return Err(format!("need at least 3 tie points, got {}", p.ties.len()));
    }
    if !p.ties.iter().all(|t| finite3(&t.source) && finite3(&t.target)) {
        return Err("every tie point needs finite coordinates".into());
    }
    let ties: Vec<TiePoint> = p.ties.iter().map(|t| TiePoint { source: t.source, target: t.target }).collect();
    let res = coregister_solve(ties)?;
    let mut applied = false;
    if let Some(scan) = &p.apply_to {
        let r = scan.to_icp()?;
        let folder = project_folder(ctx, &p.project_folder)?;
        coregister_apply_delta(folder, r.importer, r.project_id, r.scan_id, res.pose.clone())?;
        applied = true;
    }
    Ok(json!({ "pose": res.pose, "rmse": res.rmse, "residuals": res.residuals, "ties": p.ties.len(), "applied": applied }))
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyParams {
    pub scan: ScanRef,
    /// The 4×4 pose, row-major, 16 numbers.
    pub pose: Vec<f64>,
    /// Compose onto the scan's current pose (a correction) rather than replace it (default false).
    #[serde(default)]
    pub delta: bool,
    /// The project folder; defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
}

fn preprocess_apply(ctx: &OpContext, p: ApplyParams) -> Result<Value, String> {
    let r = p.scan.to_icp()?;
    if p.pose.len() != 16 || !p.pose.iter().all(|v| v.is_finite()) {
        return Err("pose must be 16 finite numbers".into());
    }
    let folder = project_folder(ctx, &p.project_folder)?;
    if p.delta {
        coregister_apply_delta(folder, r.importer.clone(), r.project_id.clone(), r.scan_id.clone(), p.pose)?;
    } else {
        coregister_apply(folder, r.importer.clone(), r.project_id.clone(), r.scan_id.clone(), p.pose)?;
    }
    Ok(json!({ "scan": p.scan, "delta": p.delta, "applied": true }))
}

fn u_30() -> u32 { 30 }
fn f_0_5() -> f64 { 0.5 }
fn u_60000() -> u32 { 60_000 }
fn u_12() -> u32 { 12 }
fn point_to_point() -> String { "pointToPoint".into() }

/// The panel's ICP settings.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IcpOpParams {
    pub source: ScanRef,
    pub target: ScanRef,
    /// Iterations at most (default 30).
    #[serde(default = "u_30")]
    pub max_iters: u32,
    /// Correspondence distance cap, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub max_corr_dist: f64,
    /// Points sampled from each scan (default 60000).
    #[serde(default = "u_60000")]
    pub sample_points: u32,
    /// "pointToPoint" (Besl & McKay 1992) or "pointToPlane" (Chen & Medioni 1991).
    #[serde(default = "point_to_point")]
    pub method: String,
    /// Neighbours for the point-to-plane normals (default 12).
    #[serde(default = "u_12")]
    pub normal_k: u32,
    /// Write the refined pose to the source scan (default false).
    #[serde(default)]
    pub apply: bool,
    /// The project folder; defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
}

fn preprocess_icp(ctx: &OpContext, p: IcpOpParams) -> Result<Value, String> {
    let source = p.source.to_icp()?;
    let target = p.target.to_icp()?;
    if !(p.max_corr_dist.is_finite() && p.max_corr_dist > 0.0) {
        return Err("maxCorrDist must be positive".into());
    }
    if p.max_iters == 0 || p.sample_points == 0 {
        return Err("maxIters and samplePoints must be positive".into());
    }
    if p.method != "pointToPoint" && p.method != "pointToPlane" {
        return Err(format!("method '{}' is not pointToPoint or pointToPlane", p.method));
    }
    let folder = project_folder(ctx, &p.project_folder)?;
    let params = IcpParams { max_iters: p.max_iters, max_corr_dist: p.max_corr_dist, sample_points: p.sample_points, method: p.method.clone(), normal_k: p.normal_k };
    let res = run_icp(&ctx.progress, &folder, &source, &target, &params)?;
    let mut applied = false;
    if p.apply && res.pose.len() == 16 && res.pose.iter().all(|v| v.is_finite()) {
        coregister_apply(folder, source.importer.clone(), source.project_id.clone(), source.scan_id.clone(), res.pose.clone())?;
        applied = true;
    }
    Ok(json!({
        "pose": res.pose, "rmse": res.rmse, "rmseHistory": res.rmse_history, "correspondences": res.correspondences,
        "sourcePoints": res.source_points, "targetPoints": res.target_points, "converged": res.converged,
        "method": p.method, "applied": applied,
    }))
}

fn f_0_05() -> f64 { 0.05 }
fn f_0_2() -> f64 { 0.2 }
fn f_0_1() -> f64 { 0.1 }
fn u_30s() -> u32 { 30 }
fn f_0_01() -> f64 { 0.01 }
fn u_500() -> u32 { 500 }

/// Sphere target detection and matching (the panel's defaults).
#[derive(Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SphereParams {
    /// Smallest sphere radius, metres (default 0.05).
    #[serde(default = "f_0_05")]
    pub r_min: f64,
    /// Largest sphere radius, metres (default 0.20).
    #[serde(default = "f_0_2")]
    pub r_max: f64,
    /// Largest fit RMSE as a fraction of the radius (default 0.10).
    #[serde(default = "f_0_1")]
    pub rmse_rel_max: f64,
    /// Fewest points in a cluster (default 30).
    #[serde(default = "u_30s")]
    pub min_cluster_points: u32,
    /// Clustering voxel, metres (default 0.20).
    #[serde(default = "f_0_2")]
    pub voxel_size: f64,
    /// Radius tolerance when pairing spheres, metres (default 0.01).
    #[serde(default = "f_0_01")]
    pub radius_tol: f64,
    /// RANSAC inlier tolerance, metres (default 0.05).
    #[serde(default = "f_0_05")]
    pub inlier_tol: f64,
    /// RANSAC iterations (default 500).
    #[serde(default = "u_500")]
    pub iterations: u32,
}

impl Default for SphereParams {
    fn default() -> Self {
        SphereParams { r_min: 0.05, r_max: 0.20, rmse_rel_max: 0.10, min_cluster_points: 30, voxel_size: 0.20, radius_tol: 0.01, inlier_tol: 0.05, iterations: 500 }
    }
}

impl SphereParams {
    fn detect(&self) -> SphereDetectParams {
        SphereDetectParams { r_min: self.r_min, r_max: self.r_max, rmse_rel_max: self.rmse_rel_max, min_cluster_points: self.min_cluster_points, voxel_size: self.voxel_size }
    }
    fn matching(&self) -> SphereMatchParams {
        SphereMatchParams { radius_tol: self.radius_tol, inlier_tol: self.inlier_tol, iterations: self.iterations }
    }
    fn validate(&self) -> Result<(), String> {
        for (name, v) in [("rMin", self.r_min), ("rMax", self.r_max), ("rmseRelMax", self.rmse_rel_max), ("voxelSize", self.voxel_size), ("radiusTol", self.radius_tol), ("inlierTol", self.inlier_tol)] {
            if !(v.is_finite() && v > 0.0) {
                return Err(format!("{name} must be positive"));
            }
        }
        if self.r_min >= self.r_max {
            return Err("rMin must be below rMax".into());
        }
        Ok(())
    }
}

fn f_0_015() -> f64 { 0.015 }
fn u_16() -> u32 { 16 }
fn f_10() -> f64 { 10.0 }
fn u_200() -> u32 { 200 }
fn f_0_03() -> f64 { 0.03 }
fn f_0_125() -> f64 { 0.125 }
fn f_2_5() -> f64 { 2.5 }
fn f_0_25() -> f64 { 0.25 }
fn u_4() -> u32 { 4 }

/// Plane patch extraction and matching (the panel's defaults; the
/// vendor-derived ones are named for where they come from).
#[derive(Deserialize, JsonSchema, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaneParams {
    /// Voxel for the patch growth, metres (default 0.50, the vendor's voxelExtractor.voxelSize).
    #[serde(default = "f_0_5")]
    pub voxel_size: f64,
    /// Largest planarity (smallest / largest eigenvalue) of a voxel (default 0.015).
    #[serde(default = "f_0_015")]
    pub planarity_max: f64,
    /// Fewest points in a voxel (default 16).
    #[serde(default = "u_16")]
    pub min_voxel_points: u32,
    /// Normal angle tolerance when merging voxels, degrees (default 10).
    #[serde(default = "f_10")]
    pub normal_angle_tol_deg: f64,
    /// Fewest points in a patch (default 200).
    #[serde(default = "u_200")]
    pub min_patch_points: u32,
    /// Largest standard deviation off the plane, metres (default 0.03, the vendor's planeExtractor.maxStdDev).
    #[serde(default = "f_0_03")]
    pub max_std_dev: f64,
    /// Smallest patch size, metres (default 0.125, the vendor's planeExtractor.minSize).
    #[serde(default = "f_0_125")]
    pub min_size: f64,
    /// Largest planarity of a patch to match (default 0.01).
    #[serde(default = "f_0_01")]
    pub max_planarity: f64,
    /// Smallest extent of a patch to match, metres (default 0.125).
    #[serde(default = "f_0_125")]
    pub min_extent: f64,
    /// Normal angle tolerance when pairing patches, degrees (default 2.5, the vendor's planeMatcher.maxAngleDifference).
    #[serde(default = "f_2_5")]
    pub match_angle_tol_deg: f64,
    /// Centroid distance tolerance when pairing patches, metres (default 0.25, the vendor's planeMatcher.maxDistance).
    #[serde(default = "f_0_25")]
    pub centroid_dist_tol: f64,
    /// RANSAC iterations (default 500).
    #[serde(default = "u_500")]
    pub iterations: u32,
    /// Correspondence samples per matched pair (default 4).
    #[serde(default = "u_4")]
    pub samples_per_pair: u32,
}

impl Default for PlaneParams {
    fn default() -> Self {
        PlaneParams {
            voxel_size: 0.5, planarity_max: 0.015, min_voxel_points: 16, normal_angle_tol_deg: 10.0, min_patch_points: 200,
            max_std_dev: 0.03, min_size: 0.125, max_planarity: 0.01, min_extent: 0.125, match_angle_tol_deg: 2.5,
            centroid_dist_tol: 0.25, iterations: 500, samples_per_pair: 4,
        }
    }
}

impl PlaneParams {
    fn extract(&self) -> Result<PlaneExtractParams, String> {
        // The command's struct carries two fields with serde defaults the
        // panel never sets; go through JSON so they take their defaults.
        serde_json::from_value(json!({
            "voxelSize": self.voxel_size, "planarityMax": self.planarity_max, "minVoxelPoints": self.min_voxel_points,
            "normalAngleTolDeg": self.normal_angle_tol_deg, "minPatchPoints": self.min_patch_points,
            "maxStdDev": self.max_std_dev, "minSize": self.min_size,
        }))
        .map_err(|e| format!("plane parameters: {e}"))
    }
    fn matching(&self) -> PlaneMatchParams {
        PlaneMatchParams {
            max_planarity: self.max_planarity, min_extent: self.min_extent, normal_angle_tol_deg: self.match_angle_tol_deg,
            centroid_dist_tol: self.centroid_dist_tol, iterations: self.iterations, samples_per_pair: self.samples_per_pair,
        }
    }
    fn validate(&self) -> Result<(), String> {
        for (name, v) in [("voxelSize", self.voxel_size), ("planarityMax", self.planarity_max), ("normalAngleTolDeg", self.normal_angle_tol_deg), ("maxStdDev", self.max_std_dev), ("minSize", self.min_size), ("centroidDistTol", self.centroid_dist_tol)] {
            if !(v.is_finite() && v > 0.0) {
                return Err(format!("{name} must be positive"));
            }
        }
        Ok(())
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetsParams {
    pub scan: ScanRef,
    /// Sphere detection settings (defaults when omitted).
    #[serde(default)]
    pub spheres: SphereParams,
    /// Plane extraction settings (defaults when omitted).
    #[serde(default)]
    pub planes: PlaneParams,
    /// Also extract plane patches (default true).
    #[serde(default = "yes")]
    pub with_planes: bool,
    /// The project folder; defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
}

fn yes() -> bool { true }

/// Points of one scan in the shared frame, as the panel reads them.
const SCAN_SAMPLE: usize = 200_000;

fn preprocess_targets(ctx: &OpContext, p: TargetsParams) -> Result<Value, String> {
    let scan = p.scan.to_icp()?;
    p.spheres.validate()?;
    p.planes.validate()?;
    let folder = project_folder(ctx, &p.project_folder)?;
    let pts = read_scan_world(&folder, &scan, SCAN_SAMPLE)?;
    let spheres: Vec<SphereTarget> = detect_sphere_targets(&pts, &p.spheres.detect());
    let planes: Vec<PlanePatch> = if p.with_planes { extract_plane_patches(&pts, &p.planes.extract()?) } else { Vec::new() };
    Ok(json!({ "scan": p.scan, "points": pts.len(), "spheres": spheres, "planes": planes }))
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MatchParams {
    pub source: ScanRef,
    pub target: ScanRef,
    /// Sphere detection and matching settings (defaults when omitted).
    #[serde(default)]
    pub spheres: SphereParams,
    /// Apply the Kabsch correction over the matched spheres to the source scan (default false).
    #[serde(default)]
    pub apply: bool,
    /// The project folder; defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
}

/// The panel's Auto-match: detect spheres in both scans, pair them by
/// RANSAC, then solve the correction over the pairs as tie points.
fn preprocess_match_spheres(ctx: &OpContext, p: MatchParams) -> Result<Value, String> {
    let source = p.source.to_icp()?;
    let target = p.target.to_icp()?;
    p.spheres.validate()?;
    let folder = project_folder(ctx, &p.project_folder)?;
    let src = detect_sphere_targets(&read_scan_world(&folder, &source, SCAN_SAMPLE)?, &p.spheres.detect());
    let tgt = detect_sphere_targets(&read_scan_world(&folder, &target, SCAN_SAMPLE)?, &p.spheres.detect());
    if src.is_empty() || tgt.is_empty() {
        return Err(format!("no sphere targets detected (source {}, target {}): place spheres in the scene or use tie points", src.len(), tgt.len()));
    }
    let m = match_sphere_pairs(&src, &tgt, &p.spheres.matching());
    if m.pairs.len() < 3 {
        return Err(format!("RANSAC found only {} sphere pairs; need at least 3", m.pairs.len()));
    }
    let ties: Vec<TiePoint> = m.pairs.iter().map(|pr| TiePoint { source: pr.source_center, target: pr.target_center }).collect();
    let solved = coregister_solve(ties)?;
    let mut applied = false;
    if p.apply {
        coregister_apply_delta(folder, source.importer.clone(), source.project_id.clone(), source.scan_id.clone(), solved.pose.clone())?;
        applied = true;
    }
    Ok(json!({
        "sourceSpheres": src.len(), "targetSpheres": tgt.len(), "candidates": m.candidates, "pairs": m.pairs,
        "matchRmse": m.rmse, "pose": solved.pose, "rmse": solved.rmse, "residuals": solved.residuals, "applied": applied,
    }))
}

fn u_1000() -> u32 { 1000 }
fn f_1e_4() -> f64 { 1e-4 }
fn f_1e_6() -> f64 { 1e-6 }

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MsaOpParams {
    /// The scans to adjust; null takes every E57 and PTX scan position of the project.
    #[serde(default)]
    pub scans: Option<Vec<ScanRef>>,
    /// Sphere detection and matching settings (defaults when omitted).
    #[serde(default)]
    pub spheres: SphereParams,
    /// Plane extraction and matching settings (defaults when omitted).
    #[serde(default)]
    pub planes: PlaneParams,
    /// Also use plane correspondences (default true).
    #[serde(default = "yes")]
    pub with_planes: bool,
    /// Iterations at most (default 1000, the vendor's lsqFitter.maxIterations).
    #[serde(default = "u_1000")]
    pub max_iters: u32,
    /// Levenberg–Marquardt damping to start from (default 1e-4).
    #[serde(default = "f_1e_4")]
    pub lambda_init: f64,
    /// Stop when the RMSE improves by less than this, metres (default 1e-6, the vendor's lsqFitter.tolerance).
    #[serde(default = "f_1e_6")]
    pub rmse_eps: f64,
    /// Keep each scan's roll and pitch, adjusting yaw and position only (default true, the vendor's lsqFitterPlanes.preserveRollAndPitch).
    #[serde(default = "yes")]
    pub preserve_roll_pitch: bool,
    /// Write the adjusted poses to the manifests (default false).
    #[serde(default)]
    pub apply: bool,
    /// The project folder; defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
}

fn pose_delta(m: &[f64]) -> (f64, f64) {
    let t = (m[3] * m[3] + m[7] * m[7] + m[11] * m[11]).sqrt();
    let tr = m[0] + m[5] + m[10];
    let cos_a = ((tr - 1.0) * 0.5).clamp(-1.0, 1.0);
    (t, cos_a.acos())
}

/// The panel's MSA: targets in every usable scan, sphere and plane
/// correspondences for every pair, one adjustment over all of them;
/// the result is a correction per scan, composed onto its pose on
/// apply.
fn preprocess_msa(ctx: &OpContext, p: MsaOpParams) -> Result<Value, String> {
    p.spheres.validate()?;
    p.planes.validate()?;
    if !(p.lambda_init.is_finite() && p.lambda_init > 0.0 && p.rmse_eps.is_finite() && p.rmse_eps > 0.0) || p.max_iters == 0 {
        return Err("maxIters, lambdaInit and rmseEps must be positive".into());
    }
    let folder = project_folder(ctx, &p.project_folder)?;
    let all = coregister_list_scans(folder.clone())?;
    let usable: Vec<UnifiedScan> = match &p.scans {
        Some(refs) => refs
            .iter()
            .map(|r| {
                let icp = r.to_icp()?;
                all.iter()
                    .find(|s| s.importer == icp.importer && s.project_id == icp.project_id && s.scan_id == icp.scan_id)
                    .cloned()
                    .ok_or_else(|| format!("scan {}/{}/{} is not in the project", icp.importer, icp.project_id, icp.scan_id))
            })
            .collect::<Result<Vec<_>, String>>()?,
        None => {
            let usable: Vec<UnifiedScan> = all.clone();
            usable
        }
    };
    if usable.len() < 2 {
        return Err("MSA needs at least 2 E57 / PTX scans".into());
    }
    let mut per_spheres: Vec<Vec<SphereTarget>> = Vec::new();
    let mut per_planes: Vec<Vec<PlanePatch>> = Vec::new();
    let extract = p.planes.extract()?;
    for (k, s) in usable.iter().enumerate() {
        ctx.progress.report("targets", k as f32 / usable.len() as f32);
        let r = IcpScanRef { importer: s.importer.clone(), project_id: s.project_id.clone(), scan_id: s.scan_id.clone() };
        let pts = read_scan_world(&folder, &r, SCAN_SAMPLE)?;
        per_spheres.push(detect_sphere_targets(&pts, &p.spheres.detect()));
        per_planes.push(if p.with_planes { extract_plane_patches(&pts, &extract) } else { Vec::new() });
    }
    let mut correspondences: Vec<MsaCorrespondence> = Vec::new();
    let (mut sphere_corr, mut plane_corr, mut pairs_with_spheres) = (0usize, 0usize, 0usize);
    for i in 0..usable.len() {
        for j in i + 1..usable.len() {
            if per_spheres[i].len() >= 3 && per_spheres[j].len() >= 3 {
                let m = match_sphere_pairs(&per_spheres[i], &per_spheres[j], &p.spheres.matching());
                for pr in &m.pairs {
                    correspondences.push(MsaCorrespondence { i: i as u32, j: j as u32, p_i_local: pr.source_center, p_j_local: pr.target_center });
                }
                sphere_corr += m.pairs.len();
                pairs_with_spheres += 1;
            }
            if p.with_planes && per_planes[i].len() >= 3 && per_planes[j].len() >= 3 {
                let m = match_plane_pairs(&per_planes[i], &per_planes[j], &p.planes.matching());
                for c in &m.correspondences {
                    correspondences.push(MsaCorrespondence { i: i as u32, j: j as u32, p_i_local: c.p_i_local, p_j_local: c.p_j_local });
                }
                plane_corr += m.correspondences.len();
            }
        }
    }
    if correspondences.len() < 3 {
        return Err(format!("only {} correspondences across {} scan pairs with spheres; need at least 3: place more targets", correspondences.len(), pairs_with_spheres));
    }
    ctx.progress.report("msa", 0.0);
    let identity: Vec<f64> = vec![1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    let initial: Vec<Vec<f64>> = usable.iter().map(|_| identity.clone()).collect();
    let params = MsaParams { max_iters: p.max_iters, lambda_init: p.lambda_init, rmse_eps: p.rmse_eps, preserve_roll_pitch: p.preserve_roll_pitch };
    let result = run_msa(&initial, &correspondences, &params)?;
    let mut per_scan = Vec::new();
    let mut applied = 0usize;
    for (k, s) in usable.iter().enumerate() {
        let m = &result.poses[k];
        let (dt, dr) = pose_delta(m);
        let changed = dt >= 1e-6 || dr >= 1e-6;
        let usable_pose = dt.is_finite() && dr.is_finite();
        if p.apply && changed && usable_pose {
            let next = crate::commands::coregister::mat4_mul(m, &s.pose);
            coregister_apply(folder.clone(), s.importer.clone(), s.project_id.clone(), s.scan_id.clone(), next)?;
            applied += 1;
        }
        per_scan.push(json!({
            "importer": s.importer, "projectId": s.project_id, "scanId": s.scan_id, "scanName": s.scan_name,
            "spheres": per_spheres[k].len(), "planes": per_planes[k].len(),
            "correction": m, "deltaT": dt, "deltaR": dr, "changed": changed, "applied": p.apply && changed && usable_pose,
        }));
    }
    ctx.progress.report("msa", 1.0);
    Ok(json!({
        "scans": per_scan.len(), "sphereCorrespondences": sphere_corr, "planeCorrespondences": plane_corr,
        "scanPairsWithSpheres": pairs_with_spheres, "converged": result.converged, "finalRmse": result.final_rmse,
        "rmseHistory": result.rmse_history, "iterations": result.rmse_history.len(), "applied": applied, "perScan": per_scan,
    }))
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![
        op!("preprocess.projects", Preprocess, mutates: false, stage: None,
            "The scanner projects imported into a project folder, by importer, with their scan positions.", ProjectsParams, preprocess_projects),
        op!("preprocess.import", Preprocess, mutates: true, stage: None,
            "Import a scanner project: an .e57 file, a .ptx / .pts file or an XYZ / ASCII file; the poses and scan positions go into the project folder's manifest.", ImportParams, preprocess_import),
        op!("preprocess.remove", Preprocess, mutates: true, stage: None,
            "Remove an imported scanner project's manifest (the source files are untouched).", ProjectRefParams, preprocess_remove),
        op!("preprocess.xyzMapping", Preprocess, mutates: true, stage: None,
            "Set which columns of an XYZ / ASCII project hold x, y, z, intensity, colour, classification and time.", XyzMappingOpParams, preprocess_xyz_mapping),
        op!("preprocess.scans", Preprocess, mutates: false, stage: None,
            "Every scan position across the imported scanner projects, with its current pose.", ProjectsParams, preprocess_scans),
        op!("preprocess.export", Preprocess, mutates: false, stage: None,
            "Export selected scan positions of an imported project, cropped to a box, as one LAS / LAZ for dataset.import.", ExportParams, preprocess_export),
        op!("preprocess.solve", Preprocess, mutates: true, stage: None,
            "Solve the rigid correction over at least three tie points (Kabsch); optionally compose it onto a scan's pose.", SolveParams, preprocess_solve),
        op!("preprocess.apply", Preprocess, mutates: true, stage: None,
            "Write a pose to a scan position: an absolute pose, or a correction composed onto the current one.", ApplyParams, preprocess_apply),
        op!("preprocess.icp", Preprocess, mutates: true, stage: None,
            "ICP fine refinement of a source scan against a target (point-to-point or point-to-plane); optionally write the refined pose.", IcpOpParams, preprocess_icp),
        op!("preprocess.targets", Preprocess, mutates: false, stage: None,
            "Detect sphere targets and plane patches in one scan position's points.", TargetsParams, preprocess_targets),
        op!("preprocess.matchSpheres", Preprocess, mutates: true, stage: None,
            "Detect spheres in two scans, pair them by RANSAC and solve the correction over the pairs; optionally apply it to the source.", MatchParams, preprocess_match_spheres),
        op!("preprocess.msa", Preprocess, mutates: true, stage: None,
            "Multi-station adjustment over every E57 / PTX scan: sphere and plane correspondences for every pair, one least-squares fit; optionally write the adjusted poses.", MsaOpParams, preprocess_msa),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_importer_is_told_from_the_path_or_named() {
        assert_eq!(importer_for("/a/plot.E57").unwrap(), Importer::E57);
        assert_eq!(importer_for("/a/scan.ptx").unwrap(), Importer::Ptx);
        assert_eq!(importer_for("/a/scan.pts").unwrap(), Importer::Ptx);
        assert_eq!(importer_for("/a/cloud.xyz").unwrap(), Importer::Xyz);
        assert_eq!(importer_for("/a/cloud.txt").unwrap(), Importer::Xyz);
        assert!(importer_for("/a/cloud.laz").unwrap_err().contains("format"));
        assert!(importer_for("/a/noext").is_err());
        assert_eq!(Importer::parse(" PTS ").unwrap(), Importer::Ptx);
        assert!(Importer::parse("las").is_err());
    }

    #[test]
    fn the_operations_are_catalogued_with_the_panels_defaults() {
        for name in ["preprocess.projects", "preprocess.import", "preprocess.remove", "preprocess.xyzMapping", "preprocess.scans", "preprocess.export", "preprocess.solve", "preprocess.apply", "preprocess.icp", "preprocess.targets", "preprocess.matchSpheres", "preprocess.msa"] {
            let op = super::super::find(name).unwrap_or_else(|| panic!("{name} missing"));
            assert_eq!(op.group, super::super::Group::Preprocess);
        }
        let icp = super::super::find("preprocess.icp").unwrap().params_schema();
        assert_eq!(icp["properties"]["maxIters"]["default"], 30);
        assert_eq!(icp["properties"]["maxCorrDist"]["default"], 0.5);
        assert_eq!(icp["properties"]["samplePoints"]["default"], 60000);
        assert_eq!(icp["properties"]["method"]["default"], "pointToPoint");
        let msa = super::super::find("preprocess.msa").unwrap().params_schema();
        assert_eq!(msa["properties"]["maxIters"]["default"], 1000);
        assert_eq!(msa["properties"]["preserveRollPitch"]["default"], true);
        let d = SphereParams::default();
        assert_eq!((d.r_min, d.r_max, d.rmse_rel_max, d.min_cluster_points, d.voxel_size), (0.05, 0.20, 0.10, 30, 0.20));
        assert_eq!((d.radius_tol, d.inlier_tol, d.iterations), (0.01, 0.05, 500));
        let p = PlaneParams::default();
        assert_eq!((p.voxel_size, p.planarity_max, p.min_voxel_points, p.normal_angle_tol_deg, p.min_patch_points), (0.5, 0.015, 16, 10.0, 200));
        assert_eq!((p.max_std_dev, p.min_size, p.max_planarity, p.min_extent, p.match_angle_tol_deg, p.centroid_dist_tol, p.iterations, p.samples_per_pair), (0.03, 0.125, 0.01, 0.125, 2.5, 0.25, 500, 4));
        let ex = p.extract().unwrap();
        assert_eq!((ex.voxel_size, ex.min_patch_points, ex.max_std_dev, ex.min_size), (0.5, 200, 0.03, 0.125));
    }

    #[test]
    fn the_operations_refuse_bad_parameters_before_touching_a_project() {
        let ctx = OpContext::silent();
        let run = |name: &str, v: Value| super::super::run(name, v, &ctx).unwrap_err();
        assert!(run("preprocess.import", json!({ "sourcePath": "" })).contains("sourcePath"));
        assert!(run("preprocess.import", json!({ "sourcePath": "/a/x.laz", "projectFolder": "/p" })).contains("format"));
        assert!(run("preprocess.solve", json!({ "ties": [{ "source": [0, 0, 0], "target": [1, 0, 0] }] })).contains("at least 3"));
        let scan = json!({ "importer": "ptx", "projectId": "p", "scanId": "s" });
        assert!(run("preprocess.apply", json!({ "scan": scan, "pose": [1, 2, 3], "projectFolder": "/p" })).contains("16"));
        assert!(run("preprocess.apply", json!({ "scan": { "importer": "xyz", "projectId": "p", "scanId": "s" }, "pose": vec![0.0; 16], "projectFolder": "/p" })).contains("XYZ"));
        assert!(run("preprocess.icp", json!({ "source": scan, "target": scan, "maxCorrDist": 0, "projectFolder": "/p" })).contains("maxCorrDist"));
        assert!(run("preprocess.icp", json!({ "source": scan, "target": scan, "method": "magic", "projectFolder": "/p" })).contains("method"));
        assert!(run("preprocess.targets", json!({ "scan": scan, "spheres": { "rMin": 0.3, "rMax": 0.2 }, "projectFolder": "/p" })).contains("rMin"));
        assert!(run("preprocess.export", json!({ "format": "ptx", "id": "p", "outPath": "/no/such/dir/x.las", "xMin": 5, "xMax": 1, "projectFolder": "/p" })).contains("not a directory"));
        let out = std::env::temp_dir().join("pcl-pre.las").to_string_lossy().to_string();
        assert!(run("preprocess.export", json!({ "format": "ptx", "id": "p", "outPath": out, "xMin": 5, "xMax": 1, "projectFolder": "/p" })).contains("xMin"));
        assert!(run("preprocess.remove", json!({ "format": "las", "id": "p", "projectFolder": "/p" })).contains("unknown importer"));
        assert!(run("preprocess.msa", json!({ "projectFolder": "/p", "maxIters": 0 })).contains("maxIters"));
    }

    #[test]
    fn a_pose_delta_reads_translation_and_rotation() {
        let identity = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        assert_eq!(pose_delta(&identity), (0.0, 0.0));
        let shifted = [1.0, 0.0, 0.0, 3.0, 0.0, 1.0, 0.0, 4.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        assert_eq!(pose_delta(&shifted), (5.0, 0.0));
        let (c, s) = (0.0f64, 1.0f64);
        let turned = [c, -s, 0.0, 0.0, s, c, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        let (t, r) = pose_delta(&turned);
        assert_eq!(t, 0.0);
        assert!((r - std::f64::consts::FRAC_PI_2).abs() < 1e-12);
    }
}
