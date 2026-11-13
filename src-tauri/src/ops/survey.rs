// The survey analyses for the headless surfaces (command line,
// console, API, MCP): the same `run_*` functions the Survey panel's
// commands call, see commands/octree/survey.rs.

use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::mesh::{run_mesh, MeshParams, MeshResult};
use crate::commands::octree::survey::{
    run_contours, run_dxf_points, run_ortho, run_profile, run_volume, run_voxel_change, save_geometry, ContourParams, ContourResult,
    DxfPointsParams, DxfPointsResult, GeometryParams,
    GeometryResult, OrthoParams, OrthoResult, ProfileParams, ProfileResult, VolumeParams, VolumeResult, VoxelChangeParams,
    VoxelChangeResult,
};

fn contours(ctx: &OpContext, p: ContourParams) -> Result<ContourResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let sink = ctx.progress.under("contours");
    run_contours(&p, &sink)
}

fn volume(ctx: &OpContext, p: VolumeParams) -> Result<VolumeResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let sink = ctx.progress.under("volume");
    run_volume(&p, &sink)
}

fn voxels(ctx: &OpContext, p: VoxelChangeParams) -> Result<VoxelChangeResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    non_empty(&p.reference_dir, "referenceDir")?;
    let sink = ctx.progress.under("voxel_change");
    run_voxel_change(&p, &sink)
}

fn ortho(ctx: &OpContext, p: OrthoParams) -> Result<OrthoResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let sink = ctx.progress.under("ortho");
    run_ortho(&p, &sink)
}

fn profile(ctx: &OpContext, p: ProfileParams) -> Result<ProfileResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let sink = ctx.progress.under("profile");
    run_profile(&p, &sink)
}

fn mesh(ctx: &OpContext, p: MeshParams) -> Result<MeshResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let sink = ctx.progress.under("mesh");
    run_mesh(&p, &sink)
}

fn dxf_points(ctx: &OpContext, p: DxfPointsParams) -> Result<DxfPointsResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let sink = ctx.progress.under("dxf_points");
    run_dxf_points(&p, &sink)
}

fn geometry(_ctx: &OpContext, p: GeometryParams) -> Result<GeometryResult, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    save_geometry(&p)
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![
        op!("ground.contours", Ground, mutates: true, stage: Some("contours"),
            "Contour lines of the ground model at an interval (index lines every n-th), written as GeoJSON and DXF into the dataset's terrain/ folder.", ContourParams, contours),
        op!("ground.volume", Ground, mutates: true, stage: Some("volume"),
            "Volume of a surface above and below a reference (a plane fitted to the area's edge, a level plane or the ground model) inside a polygon; writes the height-difference raster to survey/.", VolumeParams, volume),
        op!("change.voxels", Change, mutates: true, stage: Some("voxel_change"),
            "Voxel change against another acquisition: voxels that appeared and that are gone, their volume, and a voxel_change column (1 = new) on the points.", VoxelChangeParams, voxels),
        op!("export.ortho", Export, mutates: true, stage: Some("ortho"),
            "Ortho image of the dataset: a top view (PNG with world file and RGBA GeoTIFF) or a side view along a bearing, coloured by RGB, intensity, height, class or a column.", OrthoParams, ortho),
        op!("export.profile", Export, mutates: true, stage: Some("profile"),
            "Section profile along a polyline: the points of a corridor with station and offset (CSV), a drawing (SVG) and the ground line (DXF).", ProfileParams, profile),
        op!("export.mesh", Export, mutates: true, stage: Some("mesh"),
            "Triangle mesh of the dataset: a 2.5D height field or a closed 3D surface around the points, smoothed and decimated as asked; PLY, OBJ, STL and DXF into mesh/.", MeshParams, mesh),
        op!("export.dxf", Export, mutates: true, stage: Some("dxf_points"),
            "The points as DXF POINT entities, one layer per class (CLASS_<n>), inside an area, of chosen classes, every n-th; into survey/.", DxfPointsParams, dxf_points),
        op!("export.geometry", Export, mutates: true, stage: None,
            "Measure a polyline or polygon (3D and plan length, plan area, heights) and write it to survey/ as GeoJSON, DXF and CSV.", GeometryParams, geometry),
    ]
}
