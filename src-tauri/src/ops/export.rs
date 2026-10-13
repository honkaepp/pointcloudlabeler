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

//! Exports and change detection: the dataset as LAS/LAZ, a filtered
//! subset as a new dataset, and M3C2 distances against a reference.

use std::io::Write;
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::project::safe_output_name;
use super::{non_empty, OpContext, OpDef};
use crate::commands::cancel::try_begin;
use crate::commands::octree::{
    run_export_request, run_m3c2, run_subset, ExportReport, ExportRequest, OctreeImportResult, SubsetFilter,
};

fn f_0_02() -> f64 { 0.02 }
fn f_0_1() -> f64 { 0.1 }
fn f_0_5() -> f64 { 0.5 }
fn f_1() -> f64 { 1.0 }
fn f_3() -> f64 { 3.0 }
fn other() -> String { "other".into() }

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportLasParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// The file to write: `.las`, `.laz` (compressed), or — transcoded from the same export — `.txt`/`.xyz`/`.csv`/`.asc`/`.pts` (text, see `delimiter` and `header`), `.ply` (see `plyAscii`) or `.e57`.
    pub out_path: String,
    /// The export options; every field optional, the defaults being a loss-less, everything-in export.
    #[serde(default, flatten)]
    pub options: ExportRequest,
}

fn export_las(ctx: &OpContext, p: ExportLasParams) -> Result<ExportReport, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    non_empty(&p.out_path, "outPath")?;
    if let Some(parent) = Path::new(&p.out_path).parent().filter(|d| !d.as_os_str().is_empty()) {
        if !parent.is_dir() {
            return Err(format!("{} is not a directory", parent.display()));
        }
    }
    let sink = ctx.progress.under("export");
    run_export_request(&sink, &p.octree_dir, &p.out_path, p.options)
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubsetParams {
    /// The dataset to take the points from.
    pub src_dir: String,
    /// The new dataset's name.
    pub name: String,
    /// Where the new dataset goes. Defaults to `<project>/octrees/<safe name>` beside the source.
    #[serde(default)]
    pub out_dir: Option<String>,
    /// "tls", "mls", "als", "uls" or "other".
    #[serde(default = "other")]
    pub scanner_type: String,
    /// What to keep — the Subset panel's filter: coordinate, intensity and
    /// tree-id ranges, a class keep-list, extra-column ranges, a plane slab.
    #[serde(default)]
    pub filter: SubsetFilter,
}

fn export_subset(ctx: &OpContext, p: SubsetParams) -> Result<OctreeImportResult, String> {
    non_empty(&p.src_dir, "srcDir")?;
    non_empty(&p.name, "name")?;
    let out_dir = match p.out_dir.as_deref().filter(|d| !d.trim().is_empty()) {
        Some(d) => d.to_string(),
        None => {
            let safe = safe_output_name(&p.name);
            if safe.is_empty() {
                return Err(format!("'{}' leaves no usable directory name — pass outDir", p.name));
            }
            let octrees = Path::new(&p.src_dir).parent().ok_or("srcDir has no parent directory")?;
            octrees.join(safe).to_string_lossy().into_owned()
        }
    };
    if Path::new(&out_dir).exists() {
        return Err(format!("{out_dir} already exists"));
    }
    run_subset(&ctx.progress, &p.src_dir, &out_dir, &p.name, &p.scanner_type, &p.filter)
}

/// M3C2 (Lague et al. 2013) with the panel's defaults, in metres.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct M3c2Params {
    /// The compared (later) dataset.
    pub octree_dir: String,
    /// The reference (earlier) dataset.
    pub reference_dir: String,
    /// Voxel size, metres.
    #[serde(default = "f_0_1")]
    pub voxel_size: f64,
    /// Normal estimation scale, metres (default 1.0).
    #[serde(default = "f_1")]
    pub normal_scale: f64,
    /// Projection cylinder diameter, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub projection_scale: f64,
    /// Cylinder half-depth, metres (default 3.0).
    #[serde(default = "f_3")]
    pub max_depth: f64,
    /// Registration error, metres (default 0.02).
    #[serde(default = "f_0_02")]
    pub reg_error: f64,
    /// The JSON `change.register` wrote with `outJson`: its `positionStdErr` replaces `regError`.
    #[serde(default)]
    pub registration_json: Option<String>,
    /// Core point spacing, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub core_spacing: f64,
    /// Write every core point (x, y, z, distance, significant) as CSV here.
    #[serde(default)]
    pub out_csv: Option<String>,
    /// Return the per-core-point arrays in the result (large).
    #[serde(default)]
    pub with_points: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct M3c2Outcome {
    /// The registration error used, metres.
    pub reg_error: f64,
    pub core_count: u64,
    pub defined_count: u64,
    pub significant_count: u64,
    pub mean_distance: f32,
    pub median_distance: f32,
    pub std_distance: f32,
    pub stopped: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csv_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xyz: Option<Vec<f32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distance: Option<Vec<f32>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub significant: Option<Vec<u8>>,
}

fn change_m3c2(ctx: &OpContext, p: M3c2Params) -> Result<M3c2Outcome, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    non_empty(&p.reference_dir, "referenceDir")?;
    let reg_error = match p.registration_json.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(path) => {
            let text = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
            let r: crate::commands::octree::DatasetRegistration = serde_json::from_str(&text).map_err(|e| format!("{path} is not a registration: {e}"))?;
            if !(r.report.position_std_err.is_finite() && r.report.position_std_err >= 0.0) {
                return Err(format!("{path} carries no finite registration error"));
            }
            r.report.position_std_err
        }
        None => p.reg_error,
    };
    let _run = try_begin("m3c2").ok_or_else(|| "an M3C2 run is already in progress — stop it first".to_string())?;
    let r = run_m3c2(
        &ctx.progress, &p.octree_dir, &p.reference_dir, p.voxel_size, p.normal_scale, p.projection_scale,
        p.max_depth, reg_error, Some(p.core_spacing),
    )?;
    let csv_path = match &p.out_csv {
        Some(path) if !path.trim().is_empty() => {
            let mut f = std::io::BufWriter::new(std::fs::File::create(path).map_err(|e| format!("create {path}: {e}"))?);
            writeln!(f, "x,y,z,distance,significant").map_err(|e| e.to_string())?;
            for i in 0..r.distance.len() {
                let (x, y, z) = (r.xyz[i * 3], r.xyz[i * 3 + 1], r.xyz[i * 3 + 2]);
                let d = r.distance[i];
                let dist = if d.is_finite() { format!("{d}") } else { String::new() };
                writeln!(f, "{x},{y},{z},{dist},{}", r.significant.get(i).copied().unwrap_or(0)).map_err(|e| e.to_string())?;
            }
            f.flush().map_err(|e| e.to_string())?;
            Some(path.clone())
        }
        _ => None,
    };
    Ok(M3c2Outcome {
        reg_error,
        core_count: r.core_count,
        defined_count: r.defined_count,
        significant_count: r.significant_count,
        mean_distance: r.mean_distance,
        median_distance: r.median_distance,
        std_distance: r.std_distance,
        stopped: r.stopped,
        csv_path,
        xyz: if p.with_points { Some(r.xyz) } else { None },
        distance: if p.with_points { Some(r.distance) } else { None },
        significant: if p.with_points { Some(r.significant) } else { None },
    })
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![
        op!("export.las", Export, mutates: false, stage: Some("export"),
            "Write the dataset, edits applied, as LAS, LAZ, text, PLY or E57: optionally filtered, normalised, reprojected, every column along.", ExportLasParams, export_las),
        op!("export.subset", Export, mutates: true, stage: Some("subset"),
            "Build a new dataset from the points a filter keeps.", SubsetParams, export_subset),
        op!("change.m3c2", Change, mutates: false, stage: Some("m3c2"),
            "M3C2 surface change of the dataset against a reference acquisition, with an optional CSV of core points.", M3c2Params, change_m3c2),
    ]
}
