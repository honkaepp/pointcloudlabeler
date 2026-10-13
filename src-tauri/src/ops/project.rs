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

//! Projects and datasets: create, open, list, import, describe, remove.

use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::{
    octree_dataset_fingerprint, octree_list, octree_realign_to_source, octree_remove_dataset, octree_set_crs,
    run_convert, run_filter_outliers, run_import_pointfile, run_voxel_downsample, CleanResult, OctreeImportResult,
    OctreeListEntry, RealignResult, HARD_MAX_DEPTH,
};
use crate::commands::pointfile::{probe, PointFileKind, PointFileMapping, PointFileProbe};
use crate::commands::project::{
    close_project, create_project, current_project, open_project, recent_projects, CreateOptions, ProjectState,
    RecentProject,
};
use crate::state::CoordinateSystem;

fn f_zero() -> f64 { 0.0 }
fn u_14() -> u32 { 14 }
fn other() -> String { "other".to_string() }

/// The `<project>/octrees/<name>` directory name for a dataset name —
/// the renderer's `safeOutputName`: the extension dropped, every run of
/// characters outside `[A-Za-z0-9._-]` folded to one underscore, at
/// most 80 characters.
pub fn safe_output_name(name: &str) -> String {
    let stem = match name.rfind('.') {
        Some(i) if i > 0 && !name[i + 1..].is_empty() && !name[i + 1..].contains('/') && !name[i + 1..].contains('\\') => &name[..i],
        _ => name,
    };
    let mut out = String::new();
    let mut in_run = false;
    for c in stem.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    out.chars().take(80).collect()
}

/// The folder operations take, or the open project's.
fn project_folder(ctx: &OpContext, given: &Option<String>) -> Result<String, String> {
    if let Some(f) = given.as_deref().filter(|f| !f.trim().is_empty()) {
        return Ok(f.to_string());
    }
    ctx.state
        .project_folder()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "no project is open — pass projectFolder or run project.open first".to_string())
}

// --- project ------------------------------------------------------------

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectCreate {
    /// Folder to create the project in (made if missing; must not already hold one).
    pub folder: String,
    /// The name of the thing created.
    pub name: String,
    /// EPSG code of the project's coordinate reference system, if known.
    #[serde(default)]
    pub epsg: Option<i64>,
    /// Name of the coordinate reference system (default "unknown").
    #[serde(default)]
    pub crs_name: Option<String>,
    /// Free-text notes stored in project.json.
    #[serde(default)]
    pub notes: Option<String>,
}

fn project_create(ctx: &OpContext, p: ProjectCreate) -> Result<ProjectState, String> {
    non_empty(&p.folder, "folder")?;
    non_empty(&p.name, "name")?;
    let coordinate_system = if p.epsg.is_some() || p.crs_name.is_some() {
        Some(CoordinateSystem {
            epsg: p.epsg,
            name: p.crs_name.unwrap_or_else(|| match p.epsg { Some(c) => format!("EPSG:{c}"), None => "unknown".into() }),
            vertical: None,
        })
    } else {
        None
    };
    create_project(&ctx.state, CreateOptions {
        folder: p.folder,
        name: p.name,
        coordinate_system,
        default_cloud_format: None,
        notes: p.notes,
    })
    .map_err(|e| e.to_string())
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectOpen {
    /// A folder holding project.json.
    pub folder: String,
}

fn project_open(ctx: &OpContext, p: ProjectOpen) -> Result<ProjectState, String> {
    non_empty(&p.folder, "folder")?;
    open_project(&ctx.state, Path::new(&p.folder)).map_err(|e| e.to_string())
}

#[derive(Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoParams {}

fn project_current(ctx: &OpContext, _p: NoParams) -> Result<Option<ProjectState>, String> {
    Ok(current_project(&ctx.state))
}

fn project_close(ctx: &OpContext, _p: NoParams) -> Result<bool, String> {
    let was_open = current_project(&ctx.state).is_some();
    close_project(&ctx.state);
    Ok(was_open)
}

fn project_recent(_ctx: &OpContext, _p: NoParams) -> Result<Vec<RecentProject>, String> {
    Ok(recent_projects())
}

#[derive(Deserialize, JsonSchema, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFolderParams {
    /// The project folder. Defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
}

fn project_datasets(ctx: &OpContext, p: ProjectFolderParams) -> Result<Vec<OctreeListEntry>, String> {
    octree_list(project_folder(ctx, &p.project_folder)?)
}

// --- dataset ------------------------------------------------------------

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatasetParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
}

/// What a dataset directory holds, for a listing or a status line.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatasetInfo {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// metadata.json as written by the importer and the passes since.
    pub metadata: Value,
    pub octree_bytes: u64,
    /// Which sidecars exist beside the octree, with their sizes in bytes.
    pub sidecars: std::collections::BTreeMap<String, u64>,
    /// Trees with a review verdict in review.json.
    pub reviewed_trees: usize,
    pub fingerprint: String,
}

fn dataset_info(_ctx: &OpContext, p: DatasetParams) -> Result<DatasetInfo, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let dir = Path::new(&p.octree_dir);
    let meta_path = dir.join("metadata.json");
    let bytes = std::fs::read(&meta_path).map_err(|e| format!("{} is not a dataset: {e}", dir.display()))?;
    let metadata: Value = serde_json::from_slice(&bytes).map_err(|e| format!("parse metadata.json: {e}"))?;
    let size = |name: &str| std::fs::metadata(dir.join(name)).map(|m| m.len()).ok();
    let mut sidecars = std::collections::BTreeMap::new();
    for name in [
        "patches.bin", "treemap.json", "review.json", "species.json", "plot.json", "stems.json", "qsm.json",
        "skeletons.bin", "qsm_cylinders.csv", "skeleton_alignment.json", "terrain.bin", "compare_views.json",
    ] {
        if let Some(n) = size(name) {
            sidecars.insert(name.to_string(), n);
        }
    }
    for folder in ["terrain", "density", "layers"] {
        if dir.join(folder).is_dir() {
            let total: u64 = std::fs::read_dir(dir.join(folder))
                .map(|rd| rd.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum())
                .unwrap_or(0);
            sidecars.insert(format!("{folder}/"), total);
        }
    }
    let reviewed_trees = std::fs::read_to_string(dir.join("review.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Map<String, Value>>(&t).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(DatasetInfo {
        octree_bytes: size("octree.bin").unwrap_or(0),
        metadata,
        sidecars,
        reviewed_trees,
        fingerprint: octree_dataset_fingerprint(p.octree_dir.clone())?,
        octree_dir: p.octree_dir,
    })
}

fn dataset_remove(_ctx: &OpContext, p: DatasetParams) -> Result<bool, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    octree_remove_dataset(p.octree_dir)?;
    Ok(true)
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RealignParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// The LAS/LAZ file this dataset was imported from.
    pub las_path: String,
}

fn dataset_realign(_ctx: &OpContext, p: RealignParams) -> Result<RealignResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    non_empty(&p.las_path, "lasPath")?;
    octree_realign_to_source(p.octree_dir, p.las_path)
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetCrsParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// The CRS record to store in metadata.json (`{"epsg": 3067, ...}`),
    /// or null to clear it. Recording a CRS never moves a point.
    pub crs: Value,
}

fn dataset_set_crs(_ctx: &OpContext, p: SetCrsParams) -> Result<bool, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    octree_set_crs(p.octree_dir, p.crs.to_string())?;
    Ok(true)
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportParams {
    /// The LAS or LAZ file to import.
    pub src_path: String,
    /// Dataset name. Defaults to the file name without its extension.
    #[serde(default)]
    pub name: Option<String>,
    /// Where the dataset directory goes. Defaults to
    /// `<projectFolder>/octrees/<safe name>`, as the Editor's import does.
    #[serde(default)]
    pub out_dir: Option<String>,
    /// The project folder, when `outDir` is not given. Defaults to the open project.
    #[serde(default)]
    pub project_folder: Option<String>,
    /// "tls", "mls", "als", "uls" or "other" (default "other"), as the import dialog offers.
    #[serde(default = "other")]
    pub scanner_type: String,
    /// Root node spacing in metres; 0 (the default) lets the converter choose.
    #[serde(default = "f_zero")]
    pub root_spacing: f64,
    /// Octree depth limit (default 14).
    #[serde(default = "u_14")]
    pub max_depth: u32,
    /// LAS Extra Bytes dimension to read as the tree id.
    #[serde(default)]
    pub tree_id_extra_name: Option<String>,
    /// LAS Extra Bytes dimension to read as the stem/branch label.
    #[serde(default)]
    pub semantic_extra_name: Option<String>,
    /// LAS Extra Bytes dimension to read as the standing-deadwood id.
    #[serde(default)]
    pub standing_deadwood_extra_name: Option<String>,
    /// LAS Extra Bytes dimension to read as the lying-deadwood id.
    #[serde(default)]
    pub laying_deadwood_extra_name: Option<String>,
    /// Columns to carry into the dataset: Extra Bytes dimensions by name, and the standard fields of the LAS record under their reserved names (gps_time, red, green, blue, nir, point_source_id, scan_angle, user_data, scan_direction, edge_of_flight_line, synthetic, key_point, withheld, overlap, scanner_channel), each where the point format carries it.
    #[serde(default)]
    pub extra_names: Vec<String>,
    /// Add the two deadwood columns even when no source dimension fills them.
    #[serde(default)]
    pub include_deadwood: bool,
    /// A text (.txt/.xyz/.csv/.asc/.pts), PLY or E57 file: which of its columns fills which field — x, y, z, intensity, red, green, blue, classification, gpsTime, treeId, semantic, returnNumber, numberOfReturns, pointSourceId, scanAngle, userData, nir, standingDeadwood, layingDeadwood, and `extras`, the columns carried under their own names. Column names as `dataset.probe` lists them; omitted, the probe's guess by name. Ignored for LAS/LAZ.
    #[serde(default)]
    pub mapping: Option<PointFileMapping>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeParams {
    /// A text, PLY or E57 point file.
    pub path: String,
}

/// What a point file has: its columns, a few rows, the mapping the import would guess.
fn file_probe(_ctx: &OpContext, p: ProbeParams) -> Result<PointFileProbe, String> {
    non_empty(&p.path, "path")?;
    if !Path::new(&p.path).is_file() {
        return Err(format!("{} is not a file", p.path));
    }
    probe(&p.path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    /// The name of the thing created.
    pub name: String,
    #[serde(flatten)]
    pub result: OctreeImportResult,
}

fn dataset_import(ctx: &OpContext, p: ImportParams) -> Result<ImportOutcome, String> {
    non_empty(&p.src_path, "srcPath")?;
    let src = Path::new(&p.src_path);
    if !src.is_file() {
        return Err(format!("{} is not a file", src.display()));
    }
    let name = match p.name.as_deref().filter(|n| !n.trim().is_empty()) {
        Some(n) => n.to_string(),
        None => src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "dataset".into()),
    };
    let out_dir = match p.out_dir.as_deref().filter(|d| !d.trim().is_empty()) {
        Some(d) => d.to_string(),
        None => {
            let folder = project_folder(ctx, &p.project_folder)?;
            let safe = safe_output_name(&name);
            if safe.is_empty() {
                return Err(format!("'{name}' leaves no usable directory name — pass outDir"));
            }
            Path::new(&folder).join("octrees").join(safe).to_string_lossy().into_owned()
        }
    };
    let staged = ctx.progress.staged();
    if PointFileKind::of_path(&p.src_path).is_some() {
        let result = run_import_pointfile(
            &staged,
            &p.src_path,
            &out_dir,
            &name,
            &p.scanner_type,
            p.root_spacing,
            p.max_depth.min(HARD_MAX_DEPTH),
            p.mapping.as_ref(),
            p.include_deadwood,
        )?;
        return Ok(ImportOutcome { name, result });
    }
    let result = run_convert(
        &staged,
        &p.src_path,
        &out_dir,
        &name,
        &p.scanner_type,
        p.root_spacing,
        p.max_depth.min(HARD_MAX_DEPTH),
        p.tree_id_extra_name.as_deref().unwrap_or(""),
        p.semantic_extra_name.as_deref().unwrap_or(""),
        p.standing_deadwood_extra_name.as_deref().unwrap_or(""),
        p.laying_deadwood_extra_name.as_deref().unwrap_or(""),
        &p.extra_names,
        p.include_deadwood,
    )?;
    Ok(ImportOutcome { name, result })
}

/// The output of a cleaning pass: where it goes, as `dataset.import` names it.
fn derived_out_dir(src_dir: &str, name: &str, out_dir: &Option<String>) -> Result<String, String> {
    match out_dir.as_deref().filter(|d| !d.trim().is_empty()) {
        Some(d) => Ok(d.to_string()),
        None => {
            let safe = safe_output_name(name);
            if safe.is_empty() {
                return Err(format!("'{name}' leaves no usable directory name — pass outDir"));
            }
            let octrees = Path::new(src_dir).parent().ok_or("srcDir has no parent directory")?;
            let out = octrees.join(safe);
            if out.exists() {
                return Err(format!("{} already exists", out.display()));
            }
            Ok(out.to_string_lossy().into_owned())
        }
    }
}

/// Outlier removal (the Layers panel's Clean section).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanParams {
    /// The dataset to read from.
    pub src_dir: String,
    /// The new dataset's name.
    pub name: String,
    /// Defaults to `<octrees>/<safe name>` beside the source.
    #[serde(default)]
    pub out_dir: Option<String>,
    /// "tls", "mls", "als", "uls" or "other".
    #[serde(default = "other")]
    pub scanner_type: String,
    /// "sor" (statistical, k neighbours and a standard-deviation multiplier) or "radius" (a radius and a neighbour count).
    #[serde(default = "sor")]
    pub method: String,
    /// Neighbours for "sor" (default 8).
    #[serde(default)]
    pub k: Option<u32>,
    /// Standard-deviation multiplier for "sor" (default 1.0).
    #[serde(default)]
    pub std_mult: Option<f64>,
    /// Search radius for "radius", metres (default 0.05).
    #[serde(default)]
    pub radius: Option<f64>,
    /// Neighbours a point needs within the radius (default 2).
    #[serde(default)]
    pub min_neighbours: Option<u32>,
}
fn sor() -> String { "sor".to_string() }

fn dataset_clean(ctx: &OpContext, p: CleanParams) -> Result<CleanResult, String> {
    non_empty(&p.src_dir, "srcDir")?;
    non_empty(&p.name, "name")?;
    let out_dir = derived_out_dir(&p.src_dir, &p.name, &p.out_dir)?;
    run_filter_outliers(
        &ctx.progress, &p.src_dir, &out_dir, &p.name, &p.scanner_type, &p.method, p.k, p.std_mult, p.radius,
        p.min_neighbours,
    )
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DownsampleParams {
    /// The dataset to read from.
    pub src_dir: String,
    /// The name of the thing created.
    pub name: String,
    /// Where the new dataset goes.
    #[serde(default)]
    pub out_dir: Option<String>,
    /// "tls", "mls", "als", "uls" or "other".
    #[serde(default = "other")]
    pub scanner_type: String,
    /// One point kept per voxel of this size, metres.
    pub voxel_size: f64,
}

fn dataset_downsample(ctx: &OpContext, p: DownsampleParams) -> Result<CleanResult, String> {
    non_empty(&p.src_dir, "srcDir")?;
    non_empty(&p.name, "name")?;
    if !(p.voxel_size.is_finite() && p.voxel_size > 0.0) {
        return Err("voxelSize must be a positive number of metres".into());
    }
    let out_dir = derived_out_dir(&p.src_dir, &p.name, &p.out_dir)?;
    run_voxel_downsample(&ctx.progress, &p.src_dir, &out_dir, &p.name, &p.scanner_type, p.voxel_size)
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![
        op!("project.create", Project, mutates: true, stage: None,
            "Create a project folder (project.json, clouds/) and open it.", ProjectCreate, project_create),
        op!("project.open", Project, mutates: false, stage: None,
            "Open a project folder; it becomes the default for operations that take a projectFolder.", ProjectOpen, project_open),
        op!("project.current", Project, mutates: false, stage: None,
            "The open project, or null.", NoParams, project_current),
        op!("project.close", Project, mutates: false, stage: None,
            "Close the open project.", NoParams, project_close),
        op!("project.recent", Project, mutates: false, stage: None,
            "Recently opened projects, newest first, each checked for still existing.", NoParams, project_recent),
        op!("project.datasets", Project, mutates: false, stage: None,
            "The datasets under a project's octrees/ folder.", ProjectFolderParams, project_datasets),
        op!("dataset.probe", Dataset, mutates: false, stage: None,
            "What a text, PLY or E57 point file has: its columns, the first rows, and the column mapping an import would guess.", ProbeParams, file_probe),
        op!("dataset.import", Dataset, mutates: true, stage: Some("import"),
            "Convert a LAS/LAZ, text (.txt/.xyz/.csv), PLY or E57 file into an octree dataset, on the file's own coordinate grid.", ImportParams, dataset_import),
        op!("dataset.info", Dataset, mutates: false, stage: None,
            "A dataset's metadata, sidecar files and fingerprint.", DatasetParams, dataset_info),
        op!("dataset.remove", Dataset, mutates: true, stage: None,
            "Delete a dataset directory.", DatasetParams, dataset_remove),
        op!("dataset.realignToSource", Dataset, mutates: true, stage: None,
            "Move a dataset imported before grid alignment back onto its source file's grid (metadata only).", RealignParams, dataset_realign),
        op!("dataset.setCrs", Dataset, mutates: true, stage: None,
            "Record the coordinate reference system a dataset's coordinates are in (metadata only).", SetCrsParams, dataset_set_crs),
        op!("dataset.clean", Dataset, mutates: true, stage: Some("clean"),
            "Remove outliers (statistical or radius) into a new dataset.", CleanParams, dataset_clean),
        op!("dataset.downsample", Dataset, mutates: true, stage: Some("downsample"),
            "Voxel-downsample into a new dataset.", DownsampleParams, dataset_downsample),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_output_name_matches_the_renderer() {
        assert_eq!(safe_output_name("2023-03-29_FP08_MLS.laz"), "2023-03-29_FP08_MLS");
        assert_eq!(safe_output_name("Koeala ä 1.las"), "Koeala_1");
        assert_eq!(safe_output_name("a b   c"), "a_b_c");
        assert_eq!(safe_output_name("plot"), "plot");
        assert_eq!(safe_output_name(".hidden"), ".hidden", "a leading dot is a name, not an extension");
        assert_eq!(safe_output_name(&"x".repeat(100)).len(), 80);
    }

    #[test]
    fn a_project_round_trips_through_the_catalogue() {
        let dir = std::env::temp_dir().join(format!("pcl-ops-project-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ctx = OpContext::silent();
        let created = super::super::run("project.create", json!({ "folder": dir.to_string_lossy(), "name": "Evo", "epsg": 3067 }), &ctx).unwrap();
        assert_eq!(created["meta"]["name"], "Evo");
        assert_eq!(created["meta"]["coordinateSystem"]["epsg"], 3067);
        assert!(dir.join("project.json").is_file());
        let current = super::super::run("project.current", Value::Null, &ctx).unwrap();
        assert_eq!(current["meta"]["name"], "Evo");
        let datasets = super::super::run("project.datasets", Value::Null, &ctx).unwrap();
        assert_eq!(datasets, json!([]));
        let err = super::super::run("project.create", json!({ "folder": dir.to_string_lossy(), "name": "Again" }), &ctx).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(super::super::run("project.close", Value::Null, &ctx).unwrap(), json!(true));
        assert_eq!(super::super::run("project.current", Value::Null, &ctx).unwrap(), Value::Null);
        let err = super::super::run("project.datasets", Value::Null, &ctx).unwrap_err();
        assert!(err.contains("no project is open"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
