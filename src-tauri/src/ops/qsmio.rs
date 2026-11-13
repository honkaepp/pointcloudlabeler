//! QSMs in and out as files: the open `.qsm` format and its
//! `.qsf` manifest, tube meshes for Blender and the viewer
//! (commands/qsmfile).

use schemars::JsonSchema;
use serde::Deserialize;

use super::{non_empty, OpContext, OpDef};
use crate::commands::qsmfile::{run_export_qsm, run_import_qsm, QsmExportResult, QsmImportResult};

fn all_formats() -> Vec<String> { vec!["qsm".into(), "obj".into(), "ply".into()] }
fn sides_12() -> u32 { 12 }

/// Write the dataset's QSM (from Tree QSM) as files.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QsmExportParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Folder to write into; the dataset's qsm/ when empty.
    #[serde(default)]
    pub out_dir: Option<String>,
    /// Any of "qsm" (one .qsm per tree and a .qsf manifest), "obj" (one object per tree, near the origin, for Blender) and "ply" (world coordinates, coloured by quality).
    #[serde(default = "all_formats")]
    pub formats: Vec<String>,
    /// Sides of each tube (default 12).
    #[serde(default = "sides_12")]
    pub sides: u32,
}

fn export_qsm(_ctx: &OpContext, p: QsmExportParams) -> Result<QsmExportResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    run_export_qsm(&p.octree_dir, p.out_dir.as_deref(), &p.formats, p.sides)
}

/// Read a .qsm or .qsf from any QSM software into tubes to show.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QsmImportParams {
    /// A .qsm file or a .qsf manifest.
    pub path: String,
    /// The PLY to write; `<name>_tubes.ply` beside it when empty.
    #[serde(default)]
    pub out_ply: Option<String>,
    /// Sides of each tube (default 12).
    #[serde(default = "sides_12")]
    pub sides: u32,
}

fn import_qsm(_ctx: &OpContext, p: QsmImportParams) -> Result<QsmImportResult, String> {
    non_empty(&p.path, "path")?;
    run_import_qsm(&p.path, p.out_ply.as_deref(), p.sides)
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![
        op!("export.qsm", Export, mutates: false, stage: None,
            "The dataset's QSM as files: one .qsm per tree with a .qsf manifest (the open QSM format other software reads), an OBJ of tubes with one object per tree (for Blender) and a PLY of tubes in world coordinates coloured by how each cylinder was measured.", QsmExportParams, export_qsm),
        op!("export.qsmTubes", Export, mutates: false, stage: None,
            "Read a .qsm or a .qsf from any QSM software into a PLY of tubes coloured by its quality levels, to show beside the cloud.", QsmImportParams, import_qsm),
    ]
}
