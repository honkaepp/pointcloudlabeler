// Co-registration: align scan positions across the imported
// Preprocessing projects (Riegl / E57 / PTX) into a shared frame.
//
// What's here (v1):
//  ✓ list_scans — flat list of every scan position across all
//    importers' manifests, with each scan's current 4×4 pose. The
//    UI's source / target dropdowns are populated from this.
//  ✓ solve — given N ≥ 3 tie-point pairs (source-world, target-world),
//    find the rigid 4×4 transform that maps source onto target in a
//    least-squares sense. Closed-form via Kabsch (SVD of the
//    cross-covariance H), pure Rust 3×3 Jacobi-eigenvalue SVD — no
//    nalgebra / glam dependency. Returns the matrix + per-tie residuals
//    + RMSE so the UI can show alignment quality before the user
//    commits.
//  ✓ apply — overwrites the named scan's pose in its importer's
//    manifest. The original importer files on disk stay untouched
//    (poses live only in our cached manifest, so we just rewrite that).
//
//  ✓ icp — fine-refinement via Iterative Closest Point (Besl & McKay
//    1992, point-to-point). Reads sub-sampled points from the source +
//    target scans (E57 via the e57 crate, PTX via the byte-offset in
//    the manifest), applies their CURRENT manifest poses to bring both
//    into the shared frame, then iterates closest-point correspondence
//    + Kabsch until convergence. Returns the refined source pose plus
//    the per-iteration RMSE history so the UI can show the curve.
//    Reuses the same Kabsch core as the manual solve. Riegl scans need
//    rdblib (phase 2) before ICP can read their points — until then
//    ICP rejects a Riegl source/target with a clear message.
//
// Not yet implemented (deliberate, follow-up commits):
//  - Target-based registration with sphere / chessboard detection
//    (autodetection from point data).

use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use e57::{CartesianCoordinate, E57Reader};
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Window};

// --- types ----------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedScan {
    /// "riegl" | "e57" | "ptx" — which importer owns this scan.
    pub importer: String,
    pub project_id: String,
    pub project_name: String,
    pub scan_id: String,
    pub scan_name: String,
    /// Current 4×4 pose, row-major. For Riegl this is the SOP
    /// (SOCS → PRCS); for E57 it's the per-Data3D pose; for PTX it's
    /// the per-section matrix.
    pub pose: Vec<f64>,
    /// World-frame translation read off the pose (column 3 of the
    /// 4×4). The UI uses this for the "current position" hint per
    /// scan so the user knows roughly where each scanner sat.
    pub world_translation: [f64; 3],
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TiePoint {
    pub source: [f64; 3],
    pub target: [f64; 3],
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CoregisterResult {
    /// New 4×4 pose to assign to the source scan, row-major. The UI
    /// shows this; the user clicks Apply to persist it via
    /// coregister_apply.
    pub pose: Vec<f64>,
    /// Root-mean-square residual after applying the transform to the
    /// source tie-points (in metres — same units as the input).
    pub rmse: f64,
    /// Per-tie residual length so the user can spot a bad tie pair.
    pub residuals: Vec<f64>,
}

// --- public commands ------------------------------------------------

#[tauri::command]
pub fn coregister_list_scans(project_folder: String) -> Result<Vec<UnifiedScan>, String> {
    let mut out: Vec<UnifiedScan> = Vec::new();
    collect_riegl(&project_folder, &mut out)?;
    collect_e57(&project_folder, &mut out)?;
    collect_ptx(&project_folder, &mut out)?;
    // Stable ordering: importer name, then project, then scan name.
    out.sort_by(|a, b| a.importer.cmp(&b.importer)
        .then_with(|| a.project_name.cmp(&b.project_name))
        .then_with(|| a.scan_name.cmp(&b.scan_name)));
    Ok(out)
}

#[tauri::command]
pub fn coregister_solve(ties: Vec<TiePoint>) -> Result<CoregisterResult, String> {
    if ties.len() < 3 {
        return Err(format!("Need at least 3 tie points (got {}).", ties.len()));
    }
    // The returned pose is a world→world CORRECTION, not an absolute
    // pose: tie points are in world coordinates, so the scan's current
    // pose is already in them. Apply it with `coregister_apply_delta`.
    //
    // Collinear input is refused inside solve_kabsch rather than left to
    // the residuals: it reports ZERO residual for any rotation about the
    // line, so the residuals cannot tell the user anything.
    solve_kabsch(&ties)
}

/// Apply a world→world CORRECTION to a scan, composing it onto whatever
/// pose the scan already has.
///
/// The distinction from `coregister_apply` is the whole point of there
/// being two commands. Tie points — typed by hand, or found by
/// auto-match — are in WORLD coordinates, so the scan's current pose is
/// already baked into every one of them, and Kabsch therefore returns a
/// correction, not an absolute pose. Writing that correction straight
/// into the manifest replaces the scan's real pose with it.
///
/// That was the bug, and it was invisible: confirming an
/// already-correct alignment yields R ≈ I, t ≈ 0, which then REPLACES a
/// genuine pose with the identity — measured at 8.25 m of displacement
/// for an ordinary 90°-yaw scan, after the panel reported a perfect
/// RMSE. The residual could not warn about it, because the residual is
/// computed in world tie-point space where the solve genuinely was
/// perfect; the error is in what gets written.
///
/// ICP and MSA both already return absolute poses (ICP composes
/// internally, MSA composes in the panel), so they keep using
/// `coregister_apply`. Two meanings flowing into one parameter is what
/// let this happen once; naming them apart is what stops it happening
/// again.
/// Reject a 4x4 that would destroy a scan's registration.
///
/// The length check alone is not enough, and the way it fails is silent
/// end to end. `serde_json::Value::from` cannot represent a non-finite
/// f64, so it writes `null`; the read path collects the array with
/// `filter_map(as_f64)`, which DROPS those nulls; the resulting length
/// is no longer 16, so the reader substitutes identity. Measured:
///
/// ```text
/// [NaN, 1.0, inf, 2.0]  ->  [null,1.0,null,2.0]  ->  [1.0, 2.0]
/// ```
///
/// The scan snaps to the world origin, unrotated, and the panel reports
/// "poses applied to all manifests". What is lost is the field survey's
/// registration, which is not recomputable from the point data alone.
///
/// A singular or mirroring rotation block is refused for the same
/// reason: it is not a pose, and writing it would silently distort every
/// coordinate the scan contributes downstream.
fn validate_pose(pose: &[f64], what: &str) -> Result<(), String> {
    if pose.len() != 16 {
        return Err(format!("{what} must be 16 floats (got {}).", pose.len()));
    }
    if let Some(i) = pose.iter().position(|v| !v.is_finite()) {
        return Err(format!(
            "{what} element {i} is {} — a non-finite pose is written to the \
             manifest as null and read back as identity, which would discard \
             this scan's registration.",
            pose[i]
        ));
    }
    // det(R) must be +1 for a rotation. Allow generous slack for the
    // accumulated float error of a long ICP composition; the point is to
    // catch a collapsed or mirrored block, not to police the last bit.
    let det = pose[0] * (pose[5] * pose[10] - pose[6] * pose[9])
        - pose[1] * (pose[4] * pose[10] - pose[6] * pose[8])
        + pose[2] * (pose[4] * pose[9] - pose[5] * pose[8]);
    if !(det > 0.9 && det < 1.1) {
        return Err(format!(
            "{what} has determinant {det:.6}; a rigid pose needs +1. A value \
             near 0 means the rotation collapsed, and a negative one means it \
             mirrors — either would move every point of this scan."
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn coregister_apply_delta(
    project_folder: String,
    importer: String,
    project_id: String,
    scan_id: String,
    delta: Vec<f64>,
) -> Result<(), String> {
    validate_pose(&delta, "Delta")?;
    let scan = IcpScanRef { importer: importer.clone(), project_id: project_id.clone(), scan_id: scan_id.clone() };
    let current = read_scan_pose(&project_folder, &scan)?;
    let composed = mat4_mul(&delta, &current);
    coregister_apply(project_folder, importer, project_id, scan_id, composed)
}

#[tauri::command]
pub fn coregister_apply(
    project_folder: String,
    importer: String,
    project_id: String,
    scan_id: String,
    pose: Vec<f64>,
) -> Result<(), String> {
    validate_pose(&pose, "Pose")?;
    match importer.as_str() {
        "riegl" => apply_riegl(&project_folder, &project_id, &scan_id, &pose),
        "e57" => apply_e57(&project_folder, &project_id, &scan_id, &pose),
        "ptx" => apply_ptx(&project_folder, &project_id, &scan_id, &pose),
        other => Err(format!("Unknown importer: {other}")),
    }
}

/// One scan to feed ICP — which importer + project + scan, resolved
/// from the front end's unified-list selection.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IcpScanRef {
    pub importer: String,
    pub project_id: String,
    pub scan_id: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IcpParams {
    /// Stop after this many iterations even if not converged.
    pub max_iters: u32,
    /// Reject a correspondence whose nearest-neighbour distance exceeds
    /// this (metres). Also the voxel-grid cell size.
    pub max_corr_dist: f64,
    /// Cap on points sampled per cloud (uniform stride). Keeps ICP
    /// responsive on huge scans; 60 k is plenty for a rigid fit.
    pub sample_points: u32,
    /// "pointToPoint" (Besl & McKay 1992, default — fast, robust on
    /// blob-like targets) or "pointToPlane" (Chen & Medioni 1991 — what
    /// RiSCAN PRO's MSA / Cyclone REGISTER 360's ICP refine uses; ~3×
    /// faster convergence + tight fits on locally-planar surfaces like
    /// stems, trunks, walls, floors, water surfaces). Default keeps
    /// existing behaviour.
    #[serde(default = "default_icp_method")]
    pub method: String,
    /// k-NN size for normal estimation (point-to-plane only). Default 12.
    #[serde(default = "default_normal_k")]
    pub normal_k: u32,
}

fn default_icp_method() -> String { "pointToPoint".to_string() }
fn default_normal_k() -> u32 { 12 }

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IcpResult {
    /// Refined 4×4 pose to assign to the SOURCE scan, row-major.
    pub pose: Vec<f64>,
    /// RMSE of the accepted correspondences after the final iteration.
    pub rmse: f64,
    /// RMSE after each iteration — the UI plots this as a convergence
    /// curve so the user sees ICP settle (or diverge).
    pub rmse_history: Vec<f64>,
    /// Number of accepted correspondences in the final iteration.
    pub correspondences: u32,
    /// How many points were actually sampled from each cloud.
    pub source_points: u32,
    pub target_points: u32,
    /// True if the RMSE-delta convergence test fired before max_iters.
    pub converged: bool,
}

#[tauri::command]
pub async fn coregister_icp(
    window: Window,
    project_folder: String,
    source: IcpScanRef,
    target: IcpScanRef,
    params: IcpParams,
) -> Result<IcpResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_icp(&window, &project_folder, &source, &target, &params)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[derive(Serialize, Clone, Copy)]
struct ProgressMsg<'a> {
    stage: &'a str,
    pct: f32,
}

fn emit_progress(window: &Window, pct: f32) {
    let _ = window.emit("icp-progress", ProgressMsg { stage: "icp", pct });
}

fn run_icp(
    window: &Window,
    project_folder: &str,
    source: &IcpScanRef,
    target: &IcpScanRef,
    params: &IcpParams,
) -> Result<IcpResult, String> {
    if params.max_corr_dist <= 0.0 {
        return Err("max_corr_dist must be > 0".into());
    }
    let sample = params.sample_points.max(1000) as usize;
    emit_progress(window, 0.0);

    // Read both clouds in WORLD coords (current manifest pose applied).
    // We deliberately apply the manifest pose ourselves rather than the
    // file's embedded pose, so a prior manual solve (which updated the
    // manifest, not the file) is respected.
    let src_world = read_scan_world(project_folder, source, sample)
        .map_err(|e| format!("read source: {e}"))?;
    emit_progress(window, 0.25);
    let tgt_world = read_scan_world(project_folder, target, sample)
        .map_err(|e| format!("read target: {e}"))?;
    emit_progress(window, 0.4);

    if src_world.len() < 3 || tgt_world.len() < 3 {
        return Err(format!(
            "Too few points to register (source {}, target {}).",
            src_world.len(), tgt_world.len()
        ));
    }

    // Spatial index on the target for nearest-neighbour lookup.
    let grid = VoxelGrid::build(&tgt_world, params.max_corr_dist);

    // For point-to-plane we need a per-target-point surface normal —
    // PCA on the k-NN around each target point, smallest eigenvector
    // = local normal. Pre-computed once and reused every iteration.
    //
    // Measured, 60 k points, release, 4 cores: 57 ms on a plot-like
    // target, 79 ms on a uniform cube (see `normals_timing`). The
    // comment here used to claim ~50 ms while the loop was serial and
    // actually took 229–280 ms; parallelising it made the claim true
    // rather than making the comment vaguer. A debug build is roughly
    // 8× that, which is why the test's bound is generous.
    let normals: Option<Vec<[f64; 3]>> = if params.method == "pointToPlane" {
        Some(compute_normals_pca(&tgt_world, &grid, params.normal_k.max(6) as usize))
    } else {
        None
    };

    // ICP: accumulate the world-frame delta (R_total, t_total) such
    // that applying it to the source world points aligns them to the
    // target. `cur` holds the source points after the accumulated
    // delta so each iteration's correspondences use the latest pose.
    let mut cur = src_world.clone();
    let mut r_total = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut t_total = [0.0f64; 3];
    let mut rmse_history: Vec<f64> = Vec::new();
    let max_d2 = params.max_corr_dist * params.max_corr_dist;
    let mut last_rmse = f64::INFINITY;
    let mut converged = false;
    let mut final_pairs = 0usize;

    // Residual of a given source-point set against the target, using the
    // same correspondence rule and the same point-to-plane vs
    // point-to-point choice as the loop below. Split out so it can be
    // run ONE more time after the loop: the loop scores at the TOP of an
    // iteration and applies its increment at the bottom, so the last
    // value it recorded belongs to the pose one step before the one
    // actually returned. Converged, that gap is smaller than the
    // convergence threshold by definition; stopped at max_iters while
    // still descending, it is a full step — and either way it is not the
    // residual of the transform the user is about to apply, which is
    // what the number claims to be.
    let score = |pts: &[[f64; 3]]| -> (f64, usize) {
        let mut sum_sq = 0.0;
        let mut n = 0usize;
        for &p in pts {
            if let Some((j, d2)) = grid.nearest(p) {
                if d2 <= max_d2 {
                    if let Some(ns) = &normals {
                        let nrm = ns[j];
                        if nrm[0].is_finite() {
                            let dp = (p[0] - tgt_world[j][0]) * nrm[0]
                                + (p[1] - tgt_world[j][1]) * nrm[1]
                                + (p[2] - tgt_world[j][2]) * nrm[2];
                            sum_sq += dp * dp;
                            n += 1;
                        }
                    } else {
                        sum_sq += d2;
                        n += 1;
                    }
                }
            }
        }
        if n == 0 { (f64::NAN, 0) } else { ((sum_sq / n as f64).sqrt(), n) }
    };

    for iter in 0..params.max_iters {
        // 1. Correspondences: nearest target point within threshold.
        let mut pairs: Vec<([f64; 3], [f64; 3])> = Vec::with_capacity(cur.len());
        // For point-to-plane the residual is signed perpendicular
        // distance to the target's tangent plane; we collect normals
        // alongside the correspondences when needed.
        let mut plane_terms: Vec<([f64; 3], [f64; 3], [f64; 3])> = Vec::new();
        let mut sum_sq = 0.0;
        for &p in &cur {
            if let Some((j, d2)) = grid.nearest(p) {
                if d2 <= max_d2 {
                    pairs.push((p, tgt_world[j]));
                    if let Some(ns) = &normals {
                        let n = ns[j];
                        // Skip points with invalid normals (degenerate
                        // PCA — e.g. < 3 neighbours found in a sparse
                        // patch).
                        if n[0].is_finite() {
                            plane_terms.push((p, tgt_world[j], n));
                            // Use the signed plane distance for the
                            // running RMSE so the convergence figure
                            // matches what point-to-plane is minimising.
                            let dp = (p[0] - tgt_world[j][0]) * n[0]
                                + (p[1] - tgt_world[j][1]) * n[1]
                                + (p[2] - tgt_world[j][2]) * n[2];
                            sum_sq += dp * dp;
                            continue;
                        }
                    }
                    sum_sq += d2;
                }
            }
        }
        let active_n = if normals.is_some() { plane_terms.len() } else { pairs.len() };
        if active_n < 3 {
            return Err(format!(
                "ICP lost correspondence at iteration {iter} (only {active_n} pairs within {:.3} m). \
                 Try a larger max correspondence distance or a coarse manual solve first.",
                params.max_corr_dist
            ));
        }
        let rmse = (sum_sq / active_n as f64).sqrt();
        rmse_history.push(rmse);
        final_pairs = active_n;

        // 2. Best-fit incremental transform for this correspondence set.
        let (rd, td) = if normals.is_some() {
            // Point-to-plane: linearise the small rotation and solve a
            // 6-vector linear least-squares for (α, β, γ, tx, ty, tz)
            // that minimises Σ ((R·p + t − q) · n)².
            match solve_point_to_plane(&plane_terms) {
                Some(x) => x,
                None => (
                    [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
                    [0.0; 3],
                ),
            }
        } else {
            kabsch_rt(&pairs)
        };

        // 3. Apply the increment to the working source points + fold it
        //    into the accumulated delta.
        for p in cur.iter_mut() {
            *p = apply_rt(&rd, &td, *p);
        }
        let (r_new, t_new) = compose_rt(&rd, &td, &r_total, &t_total);
        r_total = r_new;
        t_total = t_new;

        emit_progress(window, 0.4 + 0.55 * (iter as f32 + 1.0) / params.max_iters as f32);

        // 4. Convergence: RMSE-delta below 0.1 mm.
        if (last_rmse - rmse).abs() < 1e-4 {
            converged = true;
            break;
        }
        last_rmse = rmse;
    }

    // Score the pose actually being returned. See `score`.
    let (final_rmse, final_n) = score(&cur);
    if final_n >= 3 && final_rmse.is_finite() {
        rmse_history.push(final_rmse);
        final_pairs = final_n;
    }

    // The refined SOURCE pose is the accumulated world-frame delta
    // composed onto the source's current manifest pose.
    let src_pose = read_scan_pose(project_folder, source)?;
    let delta = rt_to_mat4(&r_total, &t_total);
    let new_pose = mat4_mul(&delta, &src_pose);

    emit_progress(window, 1.0);
    Ok(IcpResult {
        pose: new_pose,
        rmse: *rmse_history.last().unwrap_or(&0.0),
        rmse_history,
        correspondences: final_pairs as u32,
        source_points: src_world.len() as u32,
        target_points: tgt_world.len() as u32,
        converged,
    })
}

// --- point readers (world frame, current manifest pose applied) ------

/// Read a scan's points into world coords using its CURRENT manifest
/// pose. Dispatches by importer. Riegl is rejected here (needs rdblib
/// — phase 2). XYZ isn't a scan position so it never reaches here.
fn read_scan_world(project_folder: &str, scan: &IcpScanRef, max_points: usize) -> Result<Vec<[f64; 3]>, String> {
    let pose = read_scan_pose(project_folder, scan)?;
    let local = match scan.importer.as_str() {
        "e57" => read_e57_local(project_folder, scan, max_points)?,
        "ptx" => read_ptx_local(project_folder, scan, max_points)?,
        "riegl" => return Err(
            "ICP can't read Riegl points yet — that needs rdblib (Riegl phase 2). Export the \
             Riegl scan to LAS first, or use the manual tie-point solve.".into()
        ),
        other => return Err(format!("ICP doesn't support importer '{other}'.")),
    };
    Ok(local.into_iter().map(|p| {
        let w = apply_pose(&pose, p);
        w
    }).collect())
}

fn read_scan_pose(project_folder: &str, scan: &IcpScanRef) -> Result<Vec<f64>, String> {
    let (sub, field) = match scan.importer.as_str() {
        "riegl" => ("riegl", "sop"),
        "e57" => ("e57", "pose"),
        "ptx" => ("ptx", "pose"),
        other => return Err(format!("unknown importer '{other}'")),
    };
    let manifest = Path::new(project_folder).join("preprocessing").join(sub).join(&scan.project_id).join("manifest.json");
    let bytes = std::fs::read(&manifest).map_err(|e| format!("read manifest {}: {e}", manifest.display()))?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?;
    let scans = v.get("summary").and_then(|s| s.get("scanPositions")).and_then(|s| s.as_array())
        .ok_or("manifest missing scanPositions")?;
    for sp in scans {
        if sp.get("id").and_then(|x| x.as_str()) == Some(scan.scan_id.as_str()) {
            let pose: Vec<f64> = sp.get(field).and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
            return Ok(if pose.len() == 16 { pose } else { identity_4x4() });
        }
    }
    Err(format!("scan id not found: {}", scan.scan_id))
}

/// E57: re-open the file, find the Data3D section (sp_NNN → index NNN),
/// read LOCAL cartesian coords with a uniform stride to cap the count.
fn read_e57_local(project_folder: &str, scan: &IcpScanRef, max_points: usize) -> Result<Vec<[f64; 3]>, String> {
    let source_path = manifest_source_path(project_folder, "e57", &scan.project_id)?;
    let index = scan_index_from_id(&scan.scan_id);
    let mut reader = E57Reader::from_file(&source_path).map_err(|e| format!("open e57: {e}"))?;
    let pcs = reader.pointclouds();
    let pc = pcs.get(index).ok_or_else(|| format!("scan index {index} out of range"))?.clone();
    let stride = ((pc.records as usize) / max_points).max(1);
    let mut iter = reader.pointcloud_simple(&pc).map_err(|e| format!("open scan reader: {e}"))?;
    iter.spherical_to_cartesian(true);
    iter.apply_pose(false); // LOCAL — we apply the manifest pose ourselves
    let mut out: Vec<[f64; 3]> = Vec::with_capacity(max_points);
    for (i, p) in iter.enumerate() {
        if i % stride != 0 { continue; }
        let p = p.map_err(|e| format!("read point: {e}"))?;
        if let CartesianCoordinate::Valid { x, y, z } = p.cartesian {
            out.push([x, y, z]);
        }
    }
    Ok(out)
}

/// PTX: seek to the section's byte offset (cached in the manifest),
/// read points with a uniform stride, dropping the 0 0 0 markers.
fn read_ptx_local(project_folder: &str, scan: &IcpScanRef, max_points: usize) -> Result<Vec<[f64; 3]>, String> {
    let source_path = manifest_source_path(project_folder, "ptx", &scan.project_id)?;
    // Find the scan's byte offset + point count in the manifest.
    let manifest = Path::new(project_folder).join("preprocessing").join("ptx").join(&scan.project_id).join("manifest.json");
    let bytes = std::fs::read(&manifest).map_err(|e| format!("read ptx manifest: {e}"))?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| format!("parse ptx manifest: {e}"))?;
    let scans = v.get("summary").and_then(|s| s.get("scanPositions")).and_then(|s| s.as_array())
        .ok_or("ptx manifest missing scanPositions")?;
    let sp = scans.iter().find(|s| s.get("id").and_then(|x| x.as_str()) == Some(scan.scan_id.as_str()))
        .ok_or_else(|| format!("scan id not found: {}", scan.scan_id))?;
    let offset = sp.get("pointByteOffset").and_then(|x| x.as_u64()).unwrap_or(0);
    let count = sp.get("pointCount").and_then(|x| x.as_u64()).unwrap_or(0);
    if count == 0 { return Ok(Vec::new()); }
    let stride = ((count as usize) / max_points).max(1);

    let mut file = BufReader::with_capacity(1 << 20, File::open(&source_path).map_err(|e| format!("open ptx: {e}"))?);
    file.seek(SeekFrom::Start(offset)).map_err(|e| format!("seek ptx: {e}"))?;
    let mut out: Vec<[f64; 3]> = Vec::with_capacity(max_points);
    let mut line = String::new();
    let mut i: u64 = 0;
    while i < count {
        line.clear();
        let n = file.read_line(&mut line).map_err(|e| format!("read ptx line: {e}"))?;
        if n == 0 { break; }
        let idx = i;
        i += 1;
        if idx % stride as u64 != 0 { continue; }
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }
        let mut it = trimmed.split_ascii_whitespace();
        let (Some(xs), Some(ys), Some(zs)) = (it.next(), it.next(), it.next()) else { continue; };
        let (Ok(x), Ok(y), Ok(z)) = (xs.parse::<f64>(), ys.parse::<f64>(), zs.parse::<f64>()) else { continue; };
        if x == 0.0 && y == 0.0 && z == 0.0 { continue; }
        out.push([x, y, z]);
    }
    Ok(out)
}

fn manifest_source_path(project_folder: &str, sub: &str, project_id: &str) -> Result<String, String> {
    let manifest = Path::new(project_folder).join("preprocessing").join(sub).join(project_id).join("manifest.json");
    let bytes = std::fs::read(&manifest).map_err(|e| format!("read manifest: {e}"))?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?;
    v.get("summary").and_then(|s| s.get("sourcePath")).and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "manifest missing sourcePath".into())
}

fn scan_index_from_id(scan_id: &str) -> usize {
    // ids are "sp_NNN" — parse the numeric tail; default 0.
    scan_id.rsplit('_').next().and_then(|s| s.parse::<usize>().ok()).unwrap_or(0)
}

// --- voxel-grid nearest neighbour ------------------------------------

/// Uniform spatial hash for nearest-neighbour queries. Cell size =
/// the ICP correspondence threshold, so the nearest accepted point is
/// always within the queried cell's 3×3×3 neighbourhood.
struct VoxelGrid {
    inv: f64,
    map: FxHashMap<(i64, i64, i64), Vec<u32>>,
    pts: Vec<[f64; 3]>,
}

impl VoxelGrid {
    fn build(pts: &[[f64; 3]], cell: f64) -> Self {
        let inv = 1.0 / cell;
        let mut map: FxHashMap<(i64, i64, i64), Vec<u32>> = FxHashMap::default();
        for (i, p) in pts.iter().enumerate() {
            map.entry(Self::key(*p, inv)).or_default().push(i as u32);
        }
        VoxelGrid { inv, map, pts: pts.to_vec() }
    }

    fn key(p: [f64; 3], inv: f64) -> (i64, i64, i64) {
        ((p[0] * inv).floor() as i64, (p[1] * inv).floor() as i64, (p[2] * inv).floor() as i64)
    }

    /// `k` nearest stored points to `q`, returning (index, squared
    /// distance) pairs sorted by distance ascending. The search shell
    /// expands until at least `k` candidates are seen or 4 shells are
    /// exhausted, so even sparse grids return useful neighbours.
    fn knn(&self, q: [f64; 3], k: usize) -> Vec<(usize, f64)> {
        let (cx, cy, cz) = Self::key(q, self.inv);
        let mut out: Vec<(usize, f64)> = Vec::with_capacity(k * 2);
        for radius in 1..=4i64 {
            for dx in -radius..=radius {
                for dy in -radius..=radius {
                    for dz in -radius..=radius {
                        // Skip cells we already covered with a smaller radius.
                        if radius > 1 && dx.abs() != radius && dy.abs() != radius && dz.abs() != radius {
                            continue;
                        }
                        if let Some(bucket) = self.map.get(&(cx + dx, cy + dy, cz + dz)) {
                            for &idx in bucket {
                                let p = self.pts[idx as usize];
                                let d2 = (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2);
                                out.push((idx as usize, d2));
                            }
                        }
                    }
                }
            }
            if out.len() >= k { break; }
        }
        out.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        out.truncate(k);
        out
    }

    /// Nearest stored point to `q`, returning (index, squared distance).
    /// Searches the 27 cells around `q`; None when all are empty.
    fn nearest(&self, q: [f64; 3]) -> Option<(usize, f64)> {
        let (kx, ky, kz) = Self::key(q, self.inv);
        let mut best: Option<(usize, f64)> = None;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(bucket) = self.map.get(&(kx + dx, ky + dy, kz + dz)) {
                        for &idx in bucket {
                            let p = self.pts[idx as usize];
                            let d2 = (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2);
                            if best.map_or(true, |(_, bd)| d2 < bd) {
                                best = Some((idx as usize, d2));
                            }
                        }
                    }
                }
            }
        }
        best
    }
}

// --- 4×4 / R,t helpers for ICP composition ---------------------------

/// Compose an incremental (Rd, td) onto the accumulated (R, t):
/// the result applies (R, t) first, then (Rd, td) — i.e. delta on the
/// left. R' = Rd·R, t' = Rd·t + td.
fn compose_rt(rd: &[[f64; 3]; 3], td: &[f64; 3], r: &[[f64; 3]; 3], t: &[f64; 3]) -> ([[f64; 3]; 3], [f64; 3]) {
    let mut rn = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let mut s = 0.0;
            for k in 0..3 { s += rd[i][k] * r[k][j]; }
            rn[i][j] = s;
        }
    }
    let tn = [
        rd[0][0] * t[0] + rd[0][1] * t[1] + rd[0][2] * t[2] + td[0],
        rd[1][0] * t[0] + rd[1][1] * t[1] + rd[1][2] * t[2] + td[1],
        rd[2][0] * t[0] + rd[2][1] * t[1] + rd[2][2] * t[2] + td[2],
    ];
    (rn, tn)
}

fn rt_to_mat4(r: &[[f64; 3]; 3], t: &[f64; 3]) -> Vec<f64> {
    vec![
        r[0][0], r[0][1], r[0][2], t[0],
        r[1][0], r[1][1], r[1][2], t[1],
        r[2][0], r[2][1], r[2][2], t[2],
        0.0,     0.0,     0.0,     1.0,
    ]
}

/// Row-major 4×4 multiply, a·b.
fn mat4_mul(a: &[f64], b: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0f64; 16];
    for i in 0..4 {
        for j in 0..4 {
            let mut s = 0.0;
            for k in 0..4 { s += a[i * 4 + k] * b[k * 4 + j]; }
            out[i * 4 + j] = s;
        }
    }
    out
}

// --- listing: walk every importer's manifests ------------------------

fn collect_riegl(project_folder: &str, out: &mut Vec<UnifiedScan>) -> Result<(), String> {
    let dir = Path::new(project_folder).join("preprocessing").join("riegl");
    if !dir.is_dir() { return Ok(()); }
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("read riegl dir: {e}"))?.flatten() {
        let manifest = entry.path().join("manifest.json");
        let Ok(bytes) = std::fs::read(&manifest) else { continue; };
        let Ok(v): Result<serde_json::Value, _> = serde_json::from_slice(&bytes) else { continue; };
        let s = v.get("summary").unwrap_or(&serde_json::Value::Null);
        let project_id = s.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let project_name = s.get("name").and_then(|v| v.as_str()).unwrap_or(&project_id).to_string();
        let scans = s.get("scanPositions").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for sp in scans {
            let scan_id = sp.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let scan_name = sp.get("name").and_then(|v| v.as_str()).unwrap_or(&scan_id).to_string();
            let pose: Vec<f64> = sp.get("sop").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
            let pose = if pose.len() == 16 { pose } else { identity_4x4() };
            let world_translation = [pose[3], pose[7], pose[11]];
            out.push(UnifiedScan {
                importer: "riegl".to_string(),
                project_id: project_id.clone(),
                project_name: project_name.clone(),
                scan_id, scan_name, pose, world_translation,
            });
        }
    }
    Ok(())
}

fn collect_e57(project_folder: &str, out: &mut Vec<UnifiedScan>) -> Result<(), String> {
    let dir = Path::new(project_folder).join("preprocessing").join("e57");
    if !dir.is_dir() { return Ok(()); }
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("read e57 dir: {e}"))?.flatten() {
        let manifest = entry.path().join("manifest.json");
        let Ok(bytes) = std::fs::read(&manifest) else { continue; };
        let Ok(v): Result<serde_json::Value, _> = serde_json::from_slice(&bytes) else { continue; };
        let s = v.get("summary").unwrap_or(&serde_json::Value::Null);
        let project_id = s.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let project_name = s.get("name").and_then(|v| v.as_str()).unwrap_or(&project_id).to_string();
        let scans = s.get("scanPositions").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for sp in scans {
            let scan_id = sp.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let scan_name = sp.get("name").and_then(|v| v.as_str()).unwrap_or(&scan_id).to_string();
            let pose: Vec<f64> = sp.get("pose").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
            let pose = if pose.len() == 16 { pose } else { identity_4x4() };
            let world_translation = [pose[3], pose[7], pose[11]];
            out.push(UnifiedScan {
                importer: "e57".to_string(),
                project_id: project_id.clone(),
                project_name: project_name.clone(),
                scan_id, scan_name, pose, world_translation,
            });
        }
    }
    Ok(())
}

fn collect_ptx(project_folder: &str, out: &mut Vec<UnifiedScan>) -> Result<(), String> {
    let dir = Path::new(project_folder).join("preprocessing").join("ptx");
    if !dir.is_dir() { return Ok(()); }
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("read ptx dir: {e}"))?.flatten() {
        let manifest = entry.path().join("manifest.json");
        let Ok(bytes) = std::fs::read(&manifest) else { continue; };
        let Ok(v): Result<serde_json::Value, _> = serde_json::from_slice(&bytes) else { continue; };
        let s = v.get("summary").unwrap_or(&serde_json::Value::Null);
        let project_id = s.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let project_name = s.get("name").and_then(|v| v.as_str()).unwrap_or(&project_id).to_string();
        let scans = s.get("scanPositions").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        for sp in scans {
            let scan_id = sp.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let scan_name = sp.get("name").and_then(|v| v.as_str()).unwrap_or(&scan_id).to_string();
            let pose: Vec<f64> = sp.get("pose").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
            let pose = if pose.len() == 16 { pose } else { identity_4x4() };
            let world_translation = [pose[3], pose[7], pose[11]];
            out.push(UnifiedScan {
                importer: "ptx".to_string(),
                project_id: project_id.clone(),
                project_name: project_name.clone(),
                scan_id, scan_name, pose, world_translation,
            });
        }
    }
    Ok(())
}

// --- apply: overwrite the named scan's pose in its manifest ----------

fn apply_riegl(project_folder: &str, project_id: &str, scan_id: &str, pose: &[f64]) -> Result<(), String> {
    let manifest_path = Path::new(project_folder).join("preprocessing").join("riegl").join(project_id).join("manifest.json");
    let mut v = read_manifest_json(&manifest_path)?;
    set_pose_in_scan(&mut v, scan_id, "sop", pose, false)?;
    write_manifest_atomic(&manifest_path, &v)
}

fn apply_e57(project_folder: &str, project_id: &str, scan_id: &str, pose: &[f64]) -> Result<(), String> {
    let manifest_path = Path::new(project_folder).join("preprocessing").join("e57").join(project_id).join("manifest.json");
    let mut v = read_manifest_json(&manifest_path)?;
    set_pose_in_scan(&mut v, scan_id, "pose", pose, true)?;
    write_manifest_atomic(&manifest_path, &v)
}

fn apply_ptx(project_folder: &str, project_id: &str, scan_id: &str, pose: &[f64]) -> Result<(), String> {
    let manifest_path = Path::new(project_folder).join("preprocessing").join("ptx").join(project_id).join("manifest.json");
    let mut v = read_manifest_json(&manifest_path)?;
    set_pose_in_scan(&mut v, scan_id, "pose", pose, false)?;
    write_manifest_atomic(&manifest_path, &v)
}

fn read_manifest_json(path: &Path) -> Result<serde_json::Value, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse {}: {e}", path.display()))
}

/// Find the scanPosition with the given id, set its pose field, also
/// update the world-centre derived from the new pose if the manifest
/// caches one (E57). The field name differs by importer: "sop" for
/// Riegl, "pose" for E57 + PTX.
fn set_pose_in_scan(
    v: &mut serde_json::Value,
    scan_id: &str,
    field: &str,
    pose: &[f64],
    update_world_centre: bool,
) -> Result<(), String> {
    let summary = v.get_mut("summary").ok_or("manifest missing 'summary'")?;
    let scans = summary
        .get_mut("scanPositions")
        .and_then(|s| s.as_array_mut())
        .ok_or("manifest missing 'scanPositions' array")?;
    let mut found = false;
    for sp in scans.iter_mut() {
        if sp.get("id").and_then(|v| v.as_str()) == Some(scan_id) {
            let arr = serde_json::Value::Array(pose.iter().map(|&f| serde_json::Value::from(f)).collect());
            if let Some(obj) = sp.as_object_mut() {
                obj.insert(field.to_string(), arr);
                if update_world_centre {
                    // E57 manifest caches worldCentre = pose · local centroid.
                    // The local centroid lives under localBounds; if it's
                    // null we leave worldCentre alone.
                    let local_bounds = obj.get("localBounds").cloned();
                    if let Some(serde_json::Value::Array(b)) = local_bounds {
                        if b.len() == 6 {
                            let xn = b[0].as_f64().unwrap_or(0.0);
                            let xx = b[1].as_f64().unwrap_or(0.0);
                            let yn = b[2].as_f64().unwrap_or(0.0);
                            let yx = b[3].as_f64().unwrap_or(0.0);
                            let zn = b[4].as_f64().unwrap_or(0.0);
                            let zx = b[5].as_f64().unwrap_or(0.0);
                            let centroid = [(xn + xx) * 0.5, (yn + yx) * 0.5, (zn + zx) * 0.5];
                            let wc = apply_pose(pose, centroid);
                            let wc_arr = serde_json::Value::Array(vec![
                                serde_json::Value::from(wc[0]),
                                serde_json::Value::from(wc[1]),
                                serde_json::Value::from(wc[2]),
                            ]);
                            obj.insert("worldCentre".to_string(), wc_arr);
                        }
                    }
                }
            }
            found = true;
            break;
        }
    }
    if !found {
        return Err(format!("scan id not found: {scan_id}"));
    }
    Ok(())
}

fn write_manifest_atomic(path: &Path, v: &serde_json::Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| format!("encode manifest: {e}"))?;
    let tmp: PathBuf = path.with_extension("json.tmp");
    {
        let mut f = File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(&bytes).map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync tmp: {e}"))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("rename tmp: {e}"))?;
    Ok(())
}

// --- maths: Kabsch alignment via 3×3 SVD -----------------------------

fn solve_kabsch(ties: &[TiePoint]) -> Result<CoregisterResult, String> {
    let pairs: Vec<([f64; 3], [f64; 3])> = ties.iter().map(|t| (t.source, t.target)).collect();
    // Collinear tie points leave the rotation about that line free, and
    // Kabsch answers anyway with a residual of zero — every point lies
    // on the axis it was free to spin about, so the RMSE the panel shows
    // cannot be the check. Refuse instead of writing a pose that happens
    // to score perfectly.
    if kabsch_is_degenerate(&pairs) {
        return Err(
            "these tie points are collinear (or too few), so they do not determine a rotation.              Kabsch would still report a perfect fit — the residual is zero for any spin about              that line. Add a point clearly off the line through the others."
                .to_string(),
        );
    }
    let (r, t) = kabsch_rt(&pairs);

    // 4×4 row-major pose.
    let pose = vec![
        r[0][0], r[0][1], r[0][2], t[0],
        r[1][0], r[1][1], r[1][2], t[1],
        r[2][0], r[2][1], r[2][2], t[2],
        0.0,     0.0,     0.0,     1.0,
    ];

    // Residuals + RMSE.
    let mut residuals: Vec<f64> = Vec::with_capacity(ties.len());
    let mut sum_sq = 0.0;
    for tp in ties {
        let mapped = apply_rt(&r, &t, tp.source);
        let d = [mapped[0] - tp.target[0], mapped[1] - tp.target[1], mapped[2] - tp.target[2]];
        let res = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        residuals.push(res);
        sum_sq += res * res;
    }
    let rmse = (sum_sq / ties.len() as f64).sqrt();
    Ok(CoregisterResult { pose, rmse, residuals })
}

/// The Kabsch core: least-squares rigid transform (R, t) mapping the
/// `source` of each pair onto its `target`. Shared by the manual
/// tie-point solve and the ICP correspondence step. `pairs` must hold
/// at least one entry (callers guarantee ≥ 3). Reflection is corrected
/// via the det-sign fix so the result is always a proper rotation.
fn kabsch_rt(pairs: &[([f64; 3], [f64; 3])]) -> ([[f64; 3]; 3], [f64; 3]) {
    let n = pairs.len().max(1) as f64;
    let mut cs = [0.0f64; 3];
    let mut ct = [0.0f64; 3];
    for (s, t) in pairs {
        for i in 0..3 { cs[i] += s[i]; ct[i] += t[i]; }
    }
    for i in 0..3 { cs[i] /= n; ct[i] /= n; }

    let mut h = [[0.0f64; 3]; 3];
    for (s, t) in pairs {
        let sc = [s[0] - cs[0], s[1] - cs[1], s[2] - cs[2]];
        let tc = [t[0] - ct[0], t[1] - ct[1], t[2] - ct[2]];
        for r in 0..3 {
            for c in 0..3 {
                h[r][c] += sc[r] * tc[c];
            }
        }
    }

    let (u, sigma, v) = svd_3x3(&h);
    let mut vut = [[0.0f64; 3]; 3];
    for r in 0..3 {
        for c in 0..3 {
            let mut sum = 0.0;
            for k in 0..3 { sum += v[r][k] * u[c][k]; }
            vut[r][c] = sum;
        }
    }
    let det = mat3_det(&vut);
    let d = if det >= 0.0 { 1.0 } else { -1.0 };
    // Kabsch's reflection fix flips the singular vector belonging to the
    // SMALLEST singular value — that is the axis the data constrains
    // least, so flipping it costs the least. Index 2 is only the
    // smallest if the singular values happen to come out sorted, and
    // jacobi_eigen_3x3 makes no such promise: it returns them in
    // whatever order the elimination lands them. Flipping a
    // well-constrained axis instead yields a valid rigid transform that
    // is simply not the least-squares one — measured at roughly 100x
    // the optimal residual on an axis-aligned reflection case, and the
    // wrong rotation entirely.
    let flip = (0..3).min_by(|&x, &y| sigma[x].partial_cmp(&sigma[y]).unwrap_or(std::cmp::Ordering::Equal)).unwrap_or(2);
    let mut r = [[0.0f64; 3]; 3];
    for row in 0..3 {
        for col in 0..3 {
            let mut sum = 0.0;
            for k in 0..3 {
                let dk = if k == flip { d } else { 1.0 };
                sum += v[row][k] * dk * u[col][k];
            }
            r[row][col] = sum;
        }
    }
    let rt = [
        r[0][0] * cs[0] + r[0][1] * cs[1] + r[0][2] * cs[2],
        r[1][0] * cs[0] + r[1][1] * cs[1] + r[1][2] * cs[2],
        r[2][0] * cs[0] + r[2][1] * cs[1] + r[2][2] * cs[2],
    ];
    let t = [ct[0] - rt[0], ct[1] - rt[1], ct[2] - rt[2]];
    (r, t)
}

fn apply_rt(r: &[[f64; 3]; 3], t: &[f64; 3], p: [f64; 3]) -> [f64; 3] {
    [
        r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2] + t[0],
        r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2] + t[1],
        r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2] + t[2],
    ]
}

/// Whether a tie-point set determines a rotation at all.
///
/// Two or more vanishing singular values in the cross-covariance mean
/// the points are collinear, and the rotation about that line is not
/// constrained by any of them. Kabsch will still return *a* rigid
/// transform — with a residual of zero, because every point lies on the
/// axis it was free to spin about — so the number the panel shows is not
/// the check. This is.
pub fn kabsch_is_degenerate(pairs: &[([f64; 3], [f64; 3])]) -> bool {
    if pairs.len() < 3 { return true; }
    let n = pairs.len() as f64;
    let (mut cs, mut ct) = ([0.0f64; 3], [0.0f64; 3]);
    for (s, t) in pairs {
        for i in 0..3 { cs[i] += s[i]; ct[i] += t[i]; }
    }
    for i in 0..3 { cs[i] /= n; ct[i] /= n; }
    let mut h = [[0.0f64; 3]; 3];
    for (s, t) in pairs {
        for r in 0..3 {
            for c in 0..3 {
                h[r][c] += (s[r] - cs[r]) * (t[c] - ct[c]);
            }
        }
    }
    let (_, sigma, _) = svd_3x3(&h);
    let peak = sigma.iter().cloned().fold(0.0f64, f64::max);
    if peak <= 0.0 { return true; }
    // Relative to the largest, so the test is scale-free: a 1 mm survey
    // and a 100 m one degenerate at the same shape, not the same size.
    sigma.iter().filter(|&&x| x / peak < 1e-6).count() >= 2
}

/// 3×3 SVD via the Jacobi eigenvalue method on A^T A. Returns (U,
/// sigma, V) such that A = U · diag(sigma) · V^T. For Kabsch we only
/// need the orthogonal frames (sigma is unused once R is computed).
fn svd_3x3(a: &[[f64; 3]; 3]) -> ([[f64; 3]; 3], [f64; 3], [[f64; 3]; 3]) {
    // ATA = A^T A (symmetric).
    let mut ata = [[0.0f64; 3]; 3];
    for r in 0..3 {
        for c in 0..3 {
            let mut sum = 0.0;
            for k in 0..3 { sum += a[k][r] * a[k][c]; }
            ata[r][c] = sum;
        }
    }
    let (v, eig) = jacobi_eigen_3x3(ata);
    let sigma = [eig[0].max(0.0).sqrt(), eig[1].max(0.0).sqrt(), eig[2].max(0.0).sqrt()];

    // U_i = A · V_i / sigma_i, which is undefined where sigma_i ~ 0.
    //
    // Leaving that column at zero — as this did — does NOT produce a
    // stable orthogonal R, whatever the reflection fix does afterwards.
    // U simply stops being orthogonal, and R = V·diag(1,1,d)·U^T comes
    // out rank-deficient: for four tie points lying in one plane (an
    // ordinary thing to click — a wall, a floor, a road) the recovered
    // R had a zero third row and det = 0, and applying it FLATTENED the
    // whole scan onto a plane. The tie-point residual was exactly zero,
    // so the panel reported a perfect fit while writing a transform that
    // destroys the geometry.
    //
    // A vanishing singular value means the data does not determine that
    // axis. With ONE of them vanishing the axis is still fixed by the
    // other two (three non-collinear points always lie in a plane, and
    // that case is perfectly well posed), so the column is completed as
    // the cross product of the other two — which keeps U orthonormal and
    // recovers the correct rotation. With two or more vanishing the
    // points are collinear and the rotation about that line is genuinely
    // unconstrained; `sigma` carries that out to the caller, which
    // refuses rather than inventing one.
    let mut u = [[0.0f64; 3]; 3];
    let mut ok = [false; 3];
    for col in 0..3 {
        if sigma[col] > 1e-12 {
            for row in 0..3 {
                let mut sum = 0.0;
                for k in 0..3 { sum += a[row][k] * v[k][col]; }
                u[row][col] = sum / sigma[col];
            }
            ok[col] = true;
        }
    }
    let missing: Vec<usize> = (0..3).filter(|&c| !ok[c]).collect();
    if missing.len() == 1 {
        // (i, j, k) cyclic keeps the frame right-handed.
        let k = missing[0];
        let (i, j) = ((k + 1) % 3, (k + 2) % 3);
        let ci = [u[0][i], u[1][i], u[2][i]];
        let cj = [u[0][j], u[1][j], u[2][j]];
        let cross = [
            ci[1] * cj[2] - ci[2] * cj[1],
            ci[2] * cj[0] - ci[0] * cj[2],
            ci[0] * cj[1] - ci[1] * cj[0],
        ];
        for row in 0..3 { u[row][k] = cross[row]; }
    }
    (u, sigma, v)
}

/// 3×3 symmetric eigenvalue problem via cyclic Jacobi rotations.
/// Returns (eigenvectors as columns, eigenvalues by column index).
fn jacobi_eigen_3x3(mut m: [[f64; 3]; 3]) -> ([[f64; 3]; 3], [f64; 3]) {
    let mut v = [[1.0f64, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..30 {
        // Pick the off-diagonal with the largest magnitude.
        let mut p = 0usize; let mut q = 1usize; let mut max_abs = m[0][1].abs();
        for &(pi, qi) in &[(0usize, 2usize), (1, 2)] {
            if m[pi][qi].abs() > max_abs { p = pi; q = qi; max_abs = m[pi][qi].abs(); }
        }
        if max_abs < 1e-14 { break; }

        // Jacobi rotation angle.
        let theta = (m[q][q] - m[p][p]) / (2.0 * m[p][q]);
        let t = if theta.abs() > 1e10 {
            0.5 / theta
        } else {
            let sign = if theta >= 0.0 { 1.0 } else { -1.0 };
            sign / (theta.abs() + (theta * theta + 1.0).sqrt())
        };
        let c = 1.0 / (t * t + 1.0).sqrt();
        let s = t * c;

        // Apply rotation to M.
        let mpp = m[p][p]; let mqq = m[q][q]; let mpq = m[p][q];
        m[p][p] = c * c * mpp - 2.0 * s * c * mpq + s * s * mqq;
        m[q][q] = s * s * mpp + 2.0 * s * c * mpq + c * c * mqq;
        m[p][q] = 0.0; m[q][p] = 0.0;
        for k in 0..3 {
            if k != p && k != q {
                let mpk = m[p][k]; let mqk = m[q][k];
                m[p][k] = c * mpk - s * mqk;
                m[k][p] = m[p][k];
                m[q][k] = s * mpk + c * mqk;
                m[k][q] = m[q][k];
            }
        }
        // Accumulate eigenvectors into V.
        for k in 0..3 {
            let vkp = v[k][p]; let vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
        }
    }
    ([v[0], v[1], v[2]], [m[0][0], m[1][1], m[2][2]])
}

fn mat3_det(m: &[[f64; 3]; 3]) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

fn apply_pose(m: &[f64], p: [f64; 3]) -> [f64; 3] {
    if m.len() != 16 { return p; }
    [
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ]
}

// --- Point-to-plane ICP (Chen & Medioni 1991) ----------------------------
//
// For each correspondence (p_i, q_i, n_i) where n_i is the local surface
// normal at q_i, the residual is the signed perpendicular distance from
// the transformed source point to the target's tangent plane:
//
//     r_i = ((R·p_i + t) − q_i) · n_i
//
// Linearising R around small angles ω = (α, β, γ) via R·p ≈ p + ω × p:
//
//     r_i ≈ (p_i − q_i)·n_i + (p_i × n_i)·ω + n_i·t
//
// = d_i + a_i · x  with  x = [ω, t] ∈ ℝ⁶,  a_i = [p_i × n_i, n_i]
//
// Solve  Σ (d_i + a_i·x)² → minimum  via the normal equations
//
//     (A^T A) x = − A^T d            (6×6 linear system).
//
// Then x → incremental (R, t) via the exponential map (small-angle:
// R = I + Ω + ½ Ω², adequate for sub-degree increments).

/// Compute per-point surface normals via PCA on the k-NN. The
/// eigenvector of the smallest eigenvalue is the surface normal.
/// Points with too few neighbours (degenerate cluster) get a NaN
/// normal so the caller can skip them.
fn compute_normals_pca(pts: &[[f64; 3]], grid: &VoxelGrid, k: usize) -> Vec<[f64; 3]> {
    // One independent k-NN + PCA per point, so it parallelises exactly.
    // `map` on a parallel iterator preserves order, which matters: the
    // caller indexes this by target-point index.
    use rayon::prelude::*;
    pts.par_iter().map(|&p| {
        let neigh = grid.knn(p, k);
        if neigh.len() < 3 {
            return [f64::NAN; 3];
        }
        // Centroid.
        let n_f = neigh.len() as f64;
        let mut c = [0.0f64; 3];
        for &(i, _) in &neigh {
            let q = pts[i];
            c[0] += q[0]; c[1] += q[1]; c[2] += q[2];
        }
        c[0] /= n_f; c[1] /= n_f; c[2] /= n_f;
        // Covariance matrix.
        let mut m = [[0.0f64; 3]; 3];
        for &(i, _) in &neigh {
            let q = pts[i];
            let d = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
            for a in 0..3 { for b in 0..3 { m[a][b] += d[a] * d[b]; } }
        }
        // Eigendecomp; smallest-eigenvalue column = normal.
        let (v, e) = jacobi_eigen_3x3(m);
        let mut min_k = 0usize;
        let mut min_e = e[0];
        for k in 1..3 { if e[k] < min_e { min_e = e[k]; min_k = k; } }
        let mut n = [v[0][min_k], v[1][min_k], v[2][min_k]];
        let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if len < 1e-12 { return [f64::NAN; 3]; }
        n[0] /= len; n[1] /= len; n[2] /= len;
        n
    }).collect()
}

/// Solve the point-to-plane increment by linearised least-squares.
/// Returns (R, t) where R is the incremental rotation (exp-map of the
/// 3 angular components) and t is the translation. None on a
/// rank-deficient system (e.g. all-coplanar planes — happens on
/// degenerate inputs).
fn solve_point_to_plane(
    terms: &[([f64; 3], [f64; 3], [f64; 3])],
) -> Option<([[f64; 3]; 3], [f64; 3])> {
    // Build the 6×6 normal-equation matrix A^T A and the 6-vector A^T d.
    let mut ata = [[0.0f64; 6]; 6];
    let mut atd = [0.0f64; 6];
    for &(p, q, n) in terms {
        // a = [p × n, n]  (6-vector).
        let a: [f64; 6] = [
            p[1] * n[2] - p[2] * n[1],
            p[2] * n[0] - p[0] * n[2],
            p[0] * n[1] - p[1] * n[0],
            n[0], n[1], n[2],
        ];
        let d = (p[0] - q[0]) * n[0] + (p[1] - q[1]) * n[1] + (p[2] - q[2]) * n[2];
        for i in 0..6 {
            for j in i..6 { ata[i][j] += a[i] * a[j]; }
            atd[i] -= a[i] * d;
        }
    }
    // Symmetrise.
    for i in 0..6 { for j in 0..i { ata[i][j] = ata[j][i]; } }
    // Solve via Gauss elimination with partial pivot.
    let x = solve_6x6(&mut ata, &mut atd)?;
    // x = [α, β, γ, tx, ty, tz]. Build the rotation from ω.
    let omega = [x[0], x[1], x[2]];
    let r = exp_map(omega);
    let t = [x[3], x[4], x[5]];
    Some((r, t))
}

/// Rodrigues' formula on a small angular vector ω.  Returns R such
/// that for any vector v, R·v ≈ v + ω × v + ½ ω × (ω × v).
fn exp_map(omega: [f64; 3]) -> [[f64; 3]; 3] {
    let theta = (omega[0] * omega[0] + omega[1] * omega[1] + omega[2] * omega[2]).sqrt();
    let kx = [[0.0, -omega[2], omega[1]],
              [omega[2], 0.0, -omega[0]],
              [-omega[1], omega[0], 0.0]];
    let i33 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    if theta < 1e-9 {
        // First-order Taylor — adequate for sub-mrad increments.
        let mut r = i33;
        for a in 0..3 { for b in 0..3 { r[a][b] += kx[a][b]; } }
        return r;
    }
    let s = theta.sin() / theta;
    let c = (1.0 - theta.cos()) / (theta * theta);
    let kx2 = {
        let mut m = [[0.0f64; 3]; 3];
        for a in 0..3 { for b in 0..3 {
            let mut sum = 0.0;
            for k in 0..3 { sum += kx[a][k] * kx[k][b]; }
            m[a][b] = sum;
        } }
        m
    };
    let mut r = [[0.0f64; 3]; 3];
    for a in 0..3 { for b in 0..3 {
        r[a][b] = i33[a][b] + s * kx[a][b] + c * kx2[a][b];
    } }
    r
}

/// Solve a 6×6 symmetric positive-definite system via Gauss elimination
/// with partial pivot. Returns None when the pivot is too small (rank-
/// deficient input — coplanar planes, all-parallel normals, …).
fn solve_6x6(a: &mut [[f64; 6]; 6], b: &mut [f64; 6]) -> Option<[f64; 6]> {
    // Forward elimination.
    for i in 0..6 {
        // Partial pivot.
        let mut piv = i;
        for k in i + 1..6 {
            if a[k][i].abs() > a[piv][i].abs() { piv = k; }
        }
        if piv != i {
            a.swap(piv, i);
            b.swap(piv, i);
        }
        let p = a[i][i];
        if p.abs() < 1e-12 { return None; }
        for k in i + 1..6 {
            let f = a[k][i] / p;
            for j in i..6 { a[k][j] -= f * a[i][j]; }
            b[k] -= f * b[i];
        }
    }
    // Back substitution.
    let mut x = [0.0f64; 6];
    for i in (0..6).rev() {
        let mut s = b[i];
        for j in i + 1..6 { s -= a[i][j] * x[j]; }
        x[i] = s / a[i][i];
    }
    Some(x)
}

#[cfg(test)]
mod p2plane_tests {
    use super::*;

    /// Point-to-plane ICP on a synthetic forestry-flavoured set —
    /// a horizontal ground plane (z=0, normal +Z) plus a vertical
    /// "stem" wall along X (y=0, normal +Y), totalling two normal
    /// directions so the 6-DoF system is fully constrained. The
    /// source is the same set translated 5 cm in Z and rotated 1.5°
    /// around X. A single Gauss-Newton step on the linearised
    /// normal-equations should collapse the residual to sub-mm.
    #[test]
    fn point_to_plane_aligns_synthetic_planar_slab() {
        let mut target: Vec<[f64; 3]> = Vec::new();
        let mut normals: Vec<[f64; 3]> = Vec::new();
        // Ground plane (n = +Z).
        for ix in 0..10 {
            for iy in 0..10 {
                target.push([ix as f64 * 0.1, iy as f64 * 0.1, 0.0]);
                normals.push([0.0, 0.0, 1.0]);
            }
        }
        // Vertical wall along X (n = +Y).
        for ix in 0..10 {
            for iz in 0..10 {
                target.push([ix as f64 * 0.1, 0.0, iz as f64 * 0.1 + 0.05]);
                normals.push([0.0, 1.0, 0.0]);
            }
        }
        // Vertical wall along Y (n = +X) — needed for full 6-DoF
        // observability. Without it the translation along X is in
        // the null space of the normal-equations (a point-to-plane
        // residual where n_x = 0 in every term puts no constraint
        // on T_x).
        for iy in 0..10 {
            for iz in 0..10 {
                target.push([0.0, iy as f64 * 0.1, iz as f64 * 0.1 + 0.05]);
                normals.push([1.0, 0.0, 0.0]);
            }
        }
        // Source: same grid but lifted +5 cm and rotated 1.5° around X.
        let theta = 1.5_f64.to_radians();
        let (cs, sn) = (theta.cos(), theta.sin());
        let source_world: Vec<[f64; 3]> = target.iter().map(|p| {
            let y = p[1] * cs - p[2] * sn;
            let z = p[1] * sn + p[2] * cs + 0.05;
            [p[0], y, z]
        }).collect();
        let pairs: Vec<([f64; 3], [f64; 3], [f64; 3])> = source_world.iter()
            .zip(target.iter()).zip(normals.iter())
            .map(|((s, t), n)| (*s, *t, *n)).collect();
        let (r, t) = solve_point_to_plane(&pairs).expect("solve");
        // Apply the increment and check residuals collapse.
        let mut max_resid: f64 = 0.0;
        for (i, (p, _, n)) in pairs.iter().enumerate() {
            let pr = apply_rt(&r, &t, *p);
            let resid = ((pr[0] - target[i][0]) * n[0]
                + (pr[1] - target[i][1]) * n[1]
                + (pr[2] - target[i][2]) * n[2]).abs();
            if resid > max_resid { max_resid = resid; }
        }
        assert!(max_resid < 1e-3,
            "point-to-plane step left {:.4} m residual (expected < 1e-3)", max_resid);
    }

    /// PCA-based normal estimator on a flat XY plane (z = 0) returns
    /// a ±Z normal (sign ambiguous but vertical).
    #[test]
    fn pca_normals_recover_horizontal_plane() {
        let mut pts: Vec<[f64; 3]> = Vec::new();
        for ix in 0..10 {
            for iy in 0..10 {
                pts.push([ix as f64 * 0.05, iy as f64 * 0.05, 0.0]);
            }
        }
        let grid = VoxelGrid::build(&pts, 0.10);
        let normals = compute_normals_pca(&pts, &grid, 8);
        // Centre cell — well-fed neighbourhood.
        let centre = 55; // (5, 5) approx
        let n = normals[centre];
        assert!(n[0].abs() < 0.05, "nx should be ~0, got {}", n[0]);
        assert!(n[1].abs() < 0.05, "ny should be ~0, got {}", n[1]);
        assert!(n[2].abs() > 0.95, "|nz| should be ~1, got {}", n[2]);
    }

    /// Rodrigues exp-map on a small rotation reproduces a small-angle
    /// rotation around the chosen axis.
    #[test]
    fn exp_map_small_z_rotation() {
        let r = exp_map([0.0, 0.0, 0.01]); // 0.01 rad around Z.
        // (1, 0, 0) should rotate to about (cos 0.01, sin 0.01, 0).
        let v = [1.0, 0.0, 0.0];
        let rv = [
            r[0][0] * v[0] + r[0][1] * v[1] + r[0][2] * v[2],
            r[1][0] * v[0] + r[1][1] * v[1] + r[1][2] * v[2],
            r[2][0] * v[0] + r[2][1] * v[1] + r[2][2] * v[2],
        ];
        assert!((rv[0] - 0.01_f64.cos()).abs() < 1e-9);
        assert!((rv[1] - 0.01_f64.sin()).abs() < 1e-9);
        assert!(rv[2].abs() < 1e-9);
    }
}

fn identity_4x4() -> Vec<f64> {
    vec![
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
}

// =====================================================================
// Plane patch extraction (RiSCAN PRO MSA-style)
//
// Region-growing over voxels. Per voxel we run a 3×3 PCA: planarity =
// λ_min / Σλ. A "planar" voxel has λ_min ≪ λ_mid ≈ λ_max — the points
// inside lie on a thin sheet. Connected planar voxels with matching
// normals merge into a plane patch via flood-fill (26-connectivity).
//
// Output per patch:
//   • centroid (m)            — best-fit plane anchor
//   • normal (unit)           — smallest-eigenvalue direction
//   • RMSE (m)                — radial residual of the patch points
//   • extent (m)              — bbox diagonal in the tangent plane
//   • area_estimate (m²)      — tangent-plane bbox area, rough
//   • planarity (0..1)        — λ_min / Σλ (smaller = flatter)
//   • n_points
//
// Same primitive RiSCAN PRO's plane-patch extractor produces; same role
// in MSA: each patch becomes a registration feature that can match a
// patch on another scan via centroid + normal alignment.
// =====================================================================

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlanePatch {
    pub centroid: [f64; 3],
    pub normal: [f64; 3],
    pub rmse: f64,
    pub extent: f64,
    pub area_estimate: f64,
    pub planarity: f64,
    pub n_points: u32,
}

// --- where these defaults come from ---------------------------------
//
// The plane, matcher and adjustment defaults below are RIEGL's own,
// read out of a `regsettings.json` in a RiSCAN PRO project rather than
// picked by taste. The point is that a forester who registers a plot
// in RiSCAN PRO and then in PointCloudLabeler should not be comparing
// two different sets of thresholds while trying to compare two
// registrations.
//
// The rule that decides what to take: **physical parameters transfer,
// counts do not.** A length or an angle means the same thing in both
// programs, so 0.03 m, 0.125 m, 5 m, 0.5 m, 0.25 m and 2.5° are
// RIEGL's numbers now, as are its iteration cap and tolerance. A
// minimum point count is a statement about sampling density, and this
// extractor is not fed the same density: `coregister_extract_planes`
// reads a 200 000-point subsample of a scan, while RIEGL's runs on the
// whole thing. Ten points there is a small patch; ten points here is
// noise — `random_cloud_emits_no_patches` demonstrates it, yielding
// four "patches" from a parametric curve the moment the counts were
// lowered to RIEGL's. So `min_voxel_points` and `min_patch_points`
// stay ours.
//
// Where RIEGL parameterises something differently, copying the number
// over would be worse than useless, so it is left alone and said so
// here:
//
//   • `planarity_max` (ours: λ_min / Σλ, dimensionless) is NOT
//     RIEGL's `voxelExtractor.planeThreshold` = 0.25. Both gate "is
//     this voxel planar", but they are different ratios of different
//     quantities; 0.25 in our definition would pass almost anything.
//     Ours stays at 0.015, and RIEGL's `maxStdDev` — a length, which
//     transfers exactly — now does the physical thinness test.
//
//   • `normal_angle_tol_deg` (ours: region-growing tolerance between
//     neighbouring voxels) is neither of RIEGL's two merge angles:
//     `voxelMerger.planeMergeThreshold` = 45° merges voxel planes and
//     `planeMerger.maxAngleDifference` = 1° merges finished patches.
//     Ours does one job that RIEGL splits in two, so 10° stays.
//
//   • `minInclination` / `maxInclination` (0° / 90°) span the whole
//     range at RIEGL's defaults, so implementing them would add a
//     knob that does nothing until someone narrows it. Skipped.
//
//   • `minReflectance` = -25 dB, `maxDeviation` = 40 and
//     `maxReflectanceDifference` = 100 filter on per-point attributes
//     our plane patches do not carry (a patch here is geometry only).
//     Skipped rather than faked.
//
//   • `cauchyParam` = 0 disables RIEGL's robust loss, so there is
//     nothing to adopt: our least squares is already unweighted.
//
//   • `planePatchesMustOverlap` = true describes an overlap test our
//     matcher does not have; its inlier test is angle + perpendicular
//     distance. Not adopted, and not pretended.
//
//   • `planeExtractor.maxSize` = 5 m was adopted, then measured, then
//     dropped — see `PlaneExtractParams::max_size`. It bounds the
//     pieces RIEGL's extractor cuts a surface into; ours grows one
//     patch per surface, so the same number deletes a 6 m ground
//     plane instead of splitting it, and the ground is the best
//     feature a forest plot has. `a_ground_plane_larger_than_riegls_
//     max_size_survives` is the test that found it.

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaneExtractParams {
    /// Voxel size for the per-voxel PCA. RIEGL's
    /// `voxelExtractor.voxelSize` = 0.50 m. Was 0.30 m here, which is
    /// finer than RIEGL works at; the coarser cell holds more points
    /// per PCA and reaches the same patches through region growing.
    pub voxel_size: f64,
    /// λ_min / Σλ above which a voxel is rejected as non-planar.
    /// 0.015. Deliberately NOT RIEGL's `planeThreshold` — see the note
    /// above.
    pub planarity_max: f64,
    /// Minimum points per voxel before PCA is meaningful. 16, ours:
    /// RIEGL's `minPointsPerVoxel` = 5 counts points at full scan
    /// density, and this runs on a 200 k subsample — see the note
    /// above.
    pub min_voxel_points: u32,
    /// Region-growing tolerance between neighbouring voxels (deg).
    /// 10°, ours — see the note above.
    pub normal_angle_tol_deg: f64,
    /// Minimum points in a finished patch. 200, ours, for the same
    /// density reason as `min_voxel_points` — RIEGL's `minPointCount`
    /// is 10. The size and thinness tests below are the ones that
    /// decide what a patch IS; this one only keeps the subsample's
    /// noise out.
    pub min_patch_points: u32,
    /// Maximum RMS point-to-plane distance of a finished patch (m).
    /// RIEGL's `planeExtractor.maxStdDev` = 0.03 m. This is the test
    /// that makes a patch physically flat rather than merely
    /// eigenvalue-flat: a broad gentle curve can satisfy a ratio and
    /// still bulge three centimetres.
    #[serde(default = "riegl_max_std_dev")]
    pub max_std_dev: f64,
    /// Smallest patch accepted, measured as the longer side of its
    /// in-plane bounding box (m). RIEGL's `planeExtractor.minSize` =
    /// 0.125 m.
    ///
    /// Note this is the longer SIDE, not `PlanePatch::extent`, which
    /// is that box's diagonal — the matcher's `min_extent` uses the
    /// diagonal and predates this. Two different lengths, kept apart
    /// on purpose.
    #[serde(default = "riegl_min_size")]
    pub min_size: f64,
    /// Largest patch accepted (same measure), or 0 for no ceiling —
    /// which is the default, and NOT RIEGL's `maxSize` of 5 m.
    ///
    /// This one was adopted and then measured, and the measurement
    /// said no: a 6 m square of ground with 5 mm of noise is one
    /// patch here, and a 5 m ceiling deletes it. On a forest plot the
    /// ground is the most reliable registration feature there is.
    ///
    /// The reason it does not transfer is that it is not really a
    /// filter in RIEGL's extractor — that one tiles a surface into
    /// patches of at most `maxSize`, so the ceiling bounds the size of
    /// the pieces it produces. Ours grows one patch per surface and
    /// stops, so the same number becomes a delete instead of a split.
    /// Subdividing large patches would be the faithful port (and
    /// several ground tiles give the matcher more constraints than one
    /// big centroid does) — but that is an algorithm, not a
    /// parameter, and this file's rule is that only parameters cross.
    #[serde(default = "no_max_size")]
    pub max_size: f64,
}

fn riegl_max_std_dev() -> f64 { 0.03 }
fn riegl_min_size() -> f64 { 0.125 }
fn no_max_size() -> f64 { 0.0 }

impl Default for PlaneExtractParams {
    fn default() -> Self {
        Self {
            voxel_size: 0.50, planarity_max: 0.015, min_voxel_points: 16,
            normal_angle_tol_deg: 10.0, min_patch_points: 200,
            max_std_dev: riegl_max_std_dev(),
            min_size: riegl_min_size(),
            max_size: no_max_size(),
        }
    }
}

#[tauri::command]
pub async fn coregister_extract_planes(
    project_folder: String,
    scan: IcpScanRef,
    params: PlaneExtractParams,
) -> Result<Vec<PlanePatch>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Read in WORLD coords (manifest pose applied) so each patch's
        // centroid/normal is already in the same frame the MSA + ICP
        // operate in.
        let pts = read_scan_world(&project_folder, &scan, 200_000)?;
        Ok(extract_plane_patches(&pts, &params))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Region-growing voxel-PCA plane extractor. Pure function — same
/// algorithm whether called from the Tauri command or a unit test.
pub fn extract_plane_patches(pts: &[[f64; 3]], params: &PlaneExtractParams) -> Vec<PlanePatch> {
    if pts.is_empty() || params.voxel_size <= 0.0 { return Vec::new(); }
    let cell = params.voxel_size;
    let inv = 1.0 / cell;
    // 1. Bucket points into voxels.
    let mut voxels: FxHashMap<(i64, i64, i64), Vec<u32>> = FxHashMap::default();
    for (i, p) in pts.iter().enumerate() {
        let key = (
            (p[0] * inv).floor() as i64,
            (p[1] * inv).floor() as i64,
            (p[2] * inv).floor() as i64,
        );
        voxels.entry(key).or_default().push(i as u32);
    }
    // 2. Per voxel: PCA → centroid + smallest eigenvector + planarity.
    // Planarity is a gate here (λ_min / Σλ against `planarity_max`),
    // not a property carried forward: the patch's own planarity is
    // recomputed over all its points in step 4.
    struct VoxelInfo {
        centroid: [f64; 3],
        normal: [f64; 3],
        indices: Vec<u32>,
    }
    let mut info: FxHashMap<(i64, i64, i64), VoxelInfo> = FxHashMap::default();
    for (key, idx) in voxels {
        if (idx.len() as u32) < params.min_voxel_points { continue; }
        let nf = idx.len() as f64;
        let mut c = [0.0f64; 3];
        for &i in &idx {
            let q = pts[i as usize];
            c[0] += q[0]; c[1] += q[1]; c[2] += q[2];
        }
        c[0] /= nf; c[1] /= nf; c[2] /= nf;
        let mut m = [[0.0f64; 3]; 3];
        for &i in &idx {
            let q = pts[i as usize];
            let d = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
            for a in 0..3 { for b in 0..3 { m[a][b] += d[a] * d[b]; } }
        }
        let (v, e) = jacobi_eigen_3x3(m);
        let sum = e[0] + e[1] + e[2];
        if sum <= 0.0 { continue; }
        let mut min_k = 0;
        if e[1] < e[min_k] { min_k = 1; }
        if e[2] < e[min_k] { min_k = 2; }
        let planarity = e[min_k] / sum;
        if planarity > params.planarity_max { continue; }
        let n = [v[0][min_k], v[1][min_k], v[2][min_k]];
        let nl = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
        if nl < 1e-12 { continue; }
        let normal = [n[0] / nl, n[1] / nl, n[2] / nl];
        info.insert(key, VoxelInfo { centroid: c, normal, indices: idx });
    }
    // 3. Region grow with 26-connectivity. Two voxels merge if their
    //    normals are aligned within the angle tolerance AND the
    //    co-planarity test (centroid-to-other-plane distance) passes.
    let cos_tol = params.normal_angle_tol_deg.to_radians().cos();
    let coplanar_tol = cell;
    let mut visited: FxHashMap<(i64, i64, i64), bool> = FxHashMap::default();
    let mut patches_pts: Vec<Vec<u32>> = Vec::new();
    let keys: Vec<(i64, i64, i64)> = info.keys().copied().collect();
    for &seed in &keys {
        if *visited.get(&seed).unwrap_or(&false) { continue; }
        let mut queue: Vec<(i64, i64, i64)> = vec![seed];
        let mut patch: Vec<u32> = Vec::new();
        let seed_normal = info[&seed].normal;
        let seed_centroid = info[&seed].centroid;
        while let Some(cur) = queue.pop() {
            if *visited.get(&cur).unwrap_or(&false) { continue; }
            let Some(ci) = info.get(&cur) else { visited.insert(cur, true); continue; };
            let dot = (ci.normal[0] * seed_normal[0]
                + ci.normal[1] * seed_normal[1]
                + ci.normal[2] * seed_normal[2]).abs();
            if dot < cos_tol { visited.insert(cur, true); continue; }
            // Co-planarity: centroid-to-seed-plane distance.
            let d = [
                ci.centroid[0] - seed_centroid[0],
                ci.centroid[1] - seed_centroid[1],
                ci.centroid[2] - seed_centroid[2],
            ];
            let normal_dist = (d[0] * seed_normal[0]
                + d[1] * seed_normal[1]
                + d[2] * seed_normal[2]).abs();
            if normal_dist > coplanar_tol * 4.0 {
                visited.insert(cur, true);
                continue;
            }
            visited.insert(cur, true);
            patch.extend(ci.indices.iter().copied());
            for dx in -1..=1 {
                for dy in -1..=1 {
                    for dz in -1..=1 {
                        if dx == 0 && dy == 0 && dz == 0 { continue; }
                        let nk = (cur.0 + dx, cur.1 + dy, cur.2 + dz);
                        if !*visited.get(&nk).unwrap_or(&false) && info.contains_key(&nk) {
                            queue.push(nk);
                        }
                    }
                }
            }
        }
        if (patch.len() as u32) >= params.min_patch_points {
            patches_pts.push(patch);
        }
    }
    // 4. Per patch, do a single PCA over ALL its points to produce the
    //    output plane (the per-voxel anchors are just the seed shape).
    let mut out: Vec<PlanePatch> = Vec::with_capacity(patches_pts.len());
    for pat in patches_pts {
        let n = pat.len();
        let nf = n as f64;
        let mut c = [0.0f64; 3];
        for &i in &pat {
            let q = pts[i as usize];
            c[0] += q[0]; c[1] += q[1]; c[2] += q[2];
        }
        c[0] /= nf; c[1] /= nf; c[2] /= nf;
        let mut m = [[0.0f64; 3]; 3];
        for &i in &pat {
            let q = pts[i as usize];
            let d = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
            for a in 0..3 { for b in 0..3 { m[a][b] += d[a] * d[b]; } }
        }
        let (v, e) = jacobi_eigen_3x3(m);
        let sum = e[0] + e[1] + e[2];
        let mut min_k = 0;
        if e[1] < e[min_k] { min_k = 1; }
        if e[2] < e[min_k] { min_k = 2; }
        let n_vec = {
            let raw = [v[0][min_k], v[1][min_k], v[2][min_k]];
            let nl = (raw[0] * raw[0] + raw[1] * raw[1] + raw[2] * raw[2]).sqrt();
            if nl < 1e-12 { continue; }
            [raw[0] / nl, raw[1] / nl, raw[2] / nl]
        };
        // Tangent-plane basis for extent / area.
        let (u_ax, v_ax) = perpendicular_basis(n_vec);
        let mut sum_sq = 0.0;
        let mut mn = [f64::INFINITY; 2];
        let mut mx = [f64::NEG_INFINITY; 2];
        for &i in &pat {
            let q = pts[i as usize];
            let d = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
            let dn = d[0] * n_vec[0] + d[1] * n_vec[1] + d[2] * n_vec[2];
            sum_sq += dn * dn;
            let u = d[0] * u_ax[0] + d[1] * u_ax[1] + d[2] * u_ax[2];
            let v_ = d[0] * v_ax[0] + d[1] * v_ax[1] + d[2] * v_ax[2];
            if u < mn[0] { mn[0] = u; } if u > mx[0] { mx[0] = u; }
            if v_ < mn[1] { mn[1] = v_; } if v_ > mx[1] { mx[1] = v_; }
        }
        let rmse = (sum_sq / nf).sqrt();
        let eu = mx[0] - mn[0]; let ev = mx[1] - mn[1];
        // RIEGL's maxStdDev / minSize / maxSize, in RIEGL's units: the
        // RMS distance to the fitted plane, and the longer side of the
        // in-plane bounding box. Applied here rather than earlier
        // because both need the finished patch's own PCA.
        if params.max_std_dev > 0.0 && rmse > params.max_std_dev { continue; }
        let side = eu.max(ev);
        if params.min_size > 0.0 && side < params.min_size { continue; }
        if params.max_size > 0.0 && side > params.max_size { continue; }
        let extent = (eu * eu + ev * ev).sqrt();
        let area_estimate = eu * ev;
        let planarity = if sum > 0.0 { e[min_k] / sum } else { 1.0 };
        out.push(PlanePatch {
            centroid: c, normal: n_vec, rmse, extent, area_estimate, planarity,
            n_points: n as u32,
        });
    }
    // Sort by point count desc so the UI lists the biggest features first.
    out.sort_by(|a, b| b.n_points.cmp(&a.n_points));
    out
}

/// Build an orthonormal basis (u, v) for the tangent plane of normal n.
fn perpendicular_basis(n: [f64; 3]) -> ([f64; 3], [f64; 3]) {
    // Pick a helper that's not nearly parallel to n.
    let helper = if n[2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
    let u_raw = [
        n[1] * helper[2] - n[2] * helper[1],
        n[2] * helper[0] - n[0] * helper[2],
        n[0] * helper[1] - n[1] * helper[0],
    ];
    let ul = (u_raw[0] * u_raw[0] + u_raw[1] * u_raw[1] + u_raw[2] * u_raw[2]).sqrt();
    let u = [u_raw[0] / ul, u_raw[1] / ul, u_raw[2] / ul];
    let v = [
        n[1] * u[2] - n[2] * u[1],
        n[2] * u[0] - n[0] * u[2],
        n[0] * u[1] - n[1] * u[0],
    ];
    (u, v)
}

#[cfg(test)]
mod kabsch_tests {
    use super::*;

    fn frob_off_orthogonal(r: &[[f64; 3]; 3]) -> f64 {
        let mut sum = 0.0;
        for i in 0..3 {
            for j in 0..3 {
                let mut d = 0.0;
                for k in 0..3 { d += r[k][i] * r[k][j]; }
                let want = if i == j { 1.0 } else { 0.0 };
                sum += (d - want) * (d - want);
            }
        }
        sum.sqrt()
    }

    /// COPLANAR tie points are ordinary — a wall, a floor, a road — and
    /// three non-collinear points always lie in a plane, so this case is
    /// perfectly well posed. It used to return a rank-deficient "rotation"
    /// with a zero third row and det = 0, which FLATTENS the entire scan
    /// onto a plane when applied. The tie-point residual was exactly zero
    /// throughout, so the panel reported a perfect fit.
    #[test]
    fn coplanar_tie_points_still_give_a_real_rotation() {
        let ang: f64 = 30f64.to_radians();
        let (c, si) = (ang.cos(), ang.sin());
        let truth = [[c, -si, 0.0], [si, c, 0.0], [0.0, 0.0, 1.0]];
        let shift = [4.0, -2.0, 7.0];
        let src = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [2.0, 3.0, 0.0]];
        let pairs: Vec<([f64; 3], [f64; 3])> =
            src.iter().map(|&p| (p, apply_rt(&truth, &shift, p))).collect();

        assert!(!kabsch_is_degenerate(&pairs), "coplanar is not degenerate — it determines a rotation");
        let (r, t) = kabsch_rt(&pairs);
        assert!(frob_off_orthogonal(&r) < 1e-9, "R must stay orthogonal, got ||RtR-I|| = {}", frob_off_orthogonal(&r));
        assert!((mat3_det(&r) - 1.0).abs() < 1e-9, "det must be +1, got {}", mat3_det(&r));
        for i in 0..3 {
            for j in 0..3 {
                assert!((r[i][j] - truth[i][j]).abs() < 1e-9, "R[{i}][{j}] = {} want {}", r[i][j], truth[i][j]);
            }
        }
        for i in 0..3 { assert!((t[i] - shift[i]).abs() < 1e-9); }

        // The failure this replaces: a point OFF the tie-point plane must
        // still move off it. A flattened R sends every z to a constant.
        let off_plane = apply_rt(&r, &t, [0.0, 0.0, 5.0]);
        assert!((off_plane[2] - (shift[2] + 5.0)).abs() < 1e-9,
            "a rank-deficient R flattens the scan: z came back {}", off_plane[2]);
    }

    /// COLLINEAR tie points genuinely do not determine the rotation about
    /// their own line — and Kabsch reports a residual of zero for any of
    /// them, because every point lies on the axis it was free to spin
    /// about. The RMSE cannot be the check, so the solver refuses.
    #[test]
    fn collinear_tie_points_are_refused_rather_than_answered() {
        let pairs: Vec<([f64; 3], [f64; 3])> = (0..5)
            .map(|i| {
                let p = [i as f64, 0.0, 0.0];
                (p, [p[0] + 3.0, 1.0, 2.0])
            })
            .collect();
        assert!(kabsch_is_degenerate(&pairs), "points on one line do not determine a rotation");

        let ties: Vec<TiePoint> = pairs.iter().map(|&(s, t)| TiePoint { source: s, target: t }).collect();
        let err = match solve_kabsch(&ties) {
            Err(e) => e,
            Ok(_) => panic!("a collinear set must be refused, not answered"),
        };
        assert!(err.contains("collinear"), "{err}");
        assert!(err.contains("perfect fit"), "the message must say why the RMSE cannot be trusted: {err}");
    }

    /// The reflection fix must flip the axis the data constrains LEAST —
    /// the smallest singular value. jacobi_eigen_3x3 does not sort, so
    /// index 2 is not reliably the smallest; flipping a well-constrained
    /// axis gives a valid rigid transform that is simply not the
    /// least-squares one.
    #[test]
    fn reflection_fix_picks_the_least_constrained_axis() {
        // Spread is deliberately unequal and NOT descending in index
        // order, which is what makes "index 2" the wrong choice.
        let src = [
            [0.3, 0.0, 0.0], [-0.3, 0.0, 0.0],
            [0.0, 2.0, 0.0], [0.0, -2.0, 0.0],
            [0.0, 0.0, 3.0], [0.0, 0.0, -3.0],
        ];
        // Target = source reflected through x, forcing det < 0.
        let pairs: Vec<([f64; 3], [f64; 3])> =
            src.iter().map(|&p| (p, [-p[0], p[1], p[2]])).collect();

        let (r, t) = kabsch_rt(&pairs);
        assert!(frob_off_orthogonal(&r) < 1e-9, "the result must still be a rotation");
        assert!((mat3_det(&r) - 1.0).abs() < 1e-9, "and proper, det = {}", mat3_det(&r));

        let sse: f64 = pairs.iter()
            .map(|&(s, tg)| {
                let q = apply_rt(&r, &t, s);
                (0..3).map(|i| (q[i] - tg[i]).powi(2)).sum::<f64>()
            })
            .sum();
        // Flipping the LARGEST axis instead scored 72.0 here; flipping
        // the smallest is the optimum at 0.72. Anything near 72 means the
        // hardcoded index is back.
        assert!(sse < 1.0, "flipped the wrong axis: SSE {sse:.3} (optimum is ~0.72)");
    }

    /// A correction must COMPOSE onto the scan's existing pose, not
    /// replace it.
    ///
    /// The case that made this invisible: confirming an already-correct
    /// alignment. The tie points agree, so Kabsch correctly returns
    /// R = I, t = 0 — and writing that in place of a real pose replaces
    /// it with the identity. The RMSE cannot warn about it, because the
    /// solve genuinely was perfect; the error is in what gets written.
    /// A pose that is not a pose must never reach a manifest.
    ///
    /// The length check that used to be the only guard passes a matrix
    /// full of NaN, and every step after that is silent:
    /// `serde_json::Value::from` cannot hold a non-finite f64 so it
    /// writes `null`; the reader collects the array with
    /// `filter_map(as_f64)`, which drops the nulls; the length is then
    /// not 16, so it substitutes identity. The scan snaps to the world
    /// origin, unrotated, and the panel reports success. What is lost is
    /// the field survey's registration, which the point data alone
    /// cannot reproduce.
    #[test]
    fn a_non_finite_pose_is_refused_rather_than_written() {
        for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            for slot in [0usize, 3, 10, 15] {
                let mut p = identity_4x4();
                p[slot] = bad;
                let err = validate_pose(&p, "Pose")
                    .expect_err(&format!("{bad} at {slot} was accepted"));
                assert!(err.contains("non-finite"), "unhelpful message: {err}");
                assert!(err.contains(&slot.to_string()), "should name the slot: {err}");
            }
        }
    }

    /// The silent path itself, so the reason for the guard is on record
    /// and not only in a comment. If serde_json ever gained NaN support,
    /// or the reader stopped dropping nulls, this test would change and
    /// the guard could be revisited on evidence.
    #[test]
    fn a_non_finite_pose_would_read_back_as_identity() {
        let mut p = identity_4x4();
        p[3] = f64::NAN;
        p[7] = f64::INFINITY;
        let written = serde_json::Value::Array(
            p.iter().map(|&f| serde_json::Value::from(f)).collect(),
        );
        assert_eq!(written[3], serde_json::Value::Null, "NaN is written as null");
        assert_eq!(written[7], serde_json::Value::Null, "inf is written as null");

        // read_scan_pose's collector, verbatim.
        let read: Vec<f64> = written.as_array().unwrap()
            .iter().filter_map(|x| x.as_f64()).collect();
        assert_eq!(read.len(), 14, "the nulls are dropped, not read as zero");
        let effective = if read.len() == 16 { read } else { identity_4x4() };
        assert_eq!(effective, identity_4x4(),
            "a 14-element pose falls back to identity — the registration is gone");
    }

    /// A rotation block that collapsed or mirrored is not a pose either,
    /// and unlike NaN it survives the round-trip perfectly — it would be
    /// written, read back intact, and quietly move every point of the
    /// scan.
    #[test]
    fn a_degenerate_rotation_is_refused() {
        let mut collapsed = identity_4x4();
        collapsed[0] = 0.0; collapsed[5] = 0.0; collapsed[10] = 0.0;
        let err = validate_pose(&collapsed, "Pose").expect_err("a zero rotation was accepted");
        assert!(err.contains("determinant"), "unhelpful message: {err}");

        // A reflection: det = -1. Rigid registration cannot mirror.
        let mut mirrored = identity_4x4();
        mirrored[0] = -1.0;
        validate_pose(&mirrored, "Pose").expect_err("a mirroring pose was accepted");

        // A uniform scale is not rigid either — it would resize the scan.
        let mut scaled = identity_4x4();
        scaled[0] = 2.0; scaled[5] = 2.0; scaled[10] = 2.0;
        validate_pose(&scaled, "Pose").expect_err("a scaling pose was accepted");
    }

    /// …but a real pose, including one carrying the float drift of a
    /// long ICP composition, must pass. A guard that rejects good input
    /// is worse than none: the user retries, it fails again, and the
    /// alignment cannot be applied at all.
    #[test]
    fn an_ordinary_pose_passes() {
        validate_pose(&identity_4x4(), "Pose").expect("identity");

        // 90 degrees of yaw, 10 m east — the fixture below.
        let yawed = vec![
            0.0, -1.0, 0.0, 10.0,
            1.0,  0.0, 0.0,  0.0,
            0.0,  0.0, 1.0,  0.0,
            0.0,  0.0, 0.0,  1.0,
        ];
        validate_pose(&yawed, "Pose").expect("a 90-degree yaw");

        // An arbitrary rotation with accumulated error in the last bits.
        let (c, s2) = (0.3f64.cos(), 0.3f64.sin());
        let drifted = vec![
            c, -s2, 0.0, 1234.5,
            s2 + 1e-12, c - 1e-12, 0.0, -6789.0,
            0.0, 0.0, 1.0 + 1e-11, 42.0,
            0.0, 0.0, 0.0, 1.0,
        ];
        validate_pose(&drifted, "Pose").expect("float drift must not be refused");

        // Large survey translations are ordinary, not suspicious.
        let mut far = identity_4x4();
        far[3] = 500_000.0; far[7] = 6_800_000.0; far[11] = 120.0;
        validate_pose(&far, "Pose").expect("a UTM-scale translation");
    }

    /// The validator is worth nothing if the commands stop calling it.
    ///
    /// Both entry points reject before touching the filesystem, so an
    /// unknown importer is a clean marker for "validation passed": a bad
    /// pose must fail on the pose, and a good one must get as far as the
    /// importer dispatch. Removing either `validate_pose` call left
    /// every other test in this file green, which is exactly how a guard
    /// goes quietly inert in a refactor.
    #[test]
    fn the_apply_commands_actually_validate() {
        let mut bad = identity_4x4();
        bad[5] = f64::NAN;

        let e = coregister_apply(
            "/nonexistent".into(), "nosuchimporter".into(),
            "p".into(), "s".into(), bad.clone(),
        ).expect_err("a NaN pose reached the importer dispatch");
        assert!(e.contains("non-finite"), "coregister_apply skipped validation: {e}");

        let e = coregister_apply_delta(
            "/nonexistent".into(), "nosuchimporter".into(),
            "p".into(), "s".into(), bad,
        ).expect_err("a NaN delta reached the importer dispatch");
        assert!(e.contains("non-finite"), "coregister_apply_delta skipped validation: {e}");

        // …and a good pose gets past validation to the dispatch, so the
        // guard is not simply refusing everything.
        let e = coregister_apply(
            "/nonexistent".into(), "nosuchimporter".into(),
            "p".into(), "s".into(), identity_4x4(),
        ).expect_err("should still fail on the unknown importer");
        assert!(e.contains("Unknown importer"), "a valid pose was refused: {e}");
    }

    #[test]
    fn a_wrong_length_pose_still_says_so() {
        let err = validate_pose(&[1.0, 2.0, 3.0], "Delta").expect_err("length");
        assert!(err.contains("16 floats"), "unhelpful message: {err}");
        assert!(err.contains("Delta"), "should use the caller's name: {err}");
        validate_pose(&[], "Pose").expect_err("empty");
    }

    #[test]
    fn a_correction_composes_onto_the_existing_pose() {
        // An ordinary scan pose: 90 degrees of yaw, translated 10 m east.
        let p0 = vec![
            0.0, -1.0, 0.0, 10.0,
            1.0,  0.0, 0.0,  0.0,
            0.0,  0.0, 1.0,  0.0,
            0.0,  0.0, 0.0,  1.0,
        ];
        let identity = vec![
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
        ];

        // Confirming a good alignment: the correction is the identity, so
        // composing must leave the pose exactly as it was.
        let composed = mat4_mul(&identity, &p0);
        for i in 0..16 {
            assert!((composed[i] - p0[i]).abs() < 1e-12,
                "an identity correction must not change the pose (element {i})");
        }

        // And the overwrite this replaces would have produced the
        // identity, moving a point that belongs at (10, 2, 0) to (2, 0, 0)
        // — 8.25 m away, after a perfect RMSE.
        let local = [0.0f64, 2.0, 0.0];
        let by_pose = |m: &[f64]| [
            m[0] * local[0] + m[1] * local[1] + m[2] * local[2] + m[3],
            m[4] * local[0] + m[5] * local[1] + m[6] * local[2] + m[7],
            m[8] * local[0] + m[9] * local[1] + m[10] * local[2] + m[11],
        ];
        let right = by_pose(&composed);
        let wrong = by_pose(&identity);
        let err = ((right[0] - wrong[0]).powi(2) + (right[1] - wrong[1]).powi(2)).sqrt();
        assert!(err > 8.0, "the overwrite bug displaced by {err:.2} m — the test fixture is wrong if this is small");
        assert!((right[0] - 8.0).abs() < 1e-12 && (right[1] - 0.0).abs() < 1e-12,
            "composed pose should place the point at (8, 0, 0), got {right:?}");
    }

    /// The mainline case must be untouched by all of the above.
    #[test]
    fn a_well_conditioned_set_is_recovered_exactly() {
        let ang: f64 = 17f64.to_radians();
        let (c, si) = (ang.cos(), ang.sin());
        let truth = [[c, 0.0, si], [0.0, 1.0, 0.0], [-si, 0.0, c]];
        let shift = [1.5, -0.25, 3.0];
        let src = [[0.0, 0.0, 0.0], [2.0, 0.0, 0.0], [0.0, 3.0, 0.0], [0.0, 0.0, 4.0], [1.0, 1.0, 1.0]];
        let pairs: Vec<([f64; 3], [f64; 3])> =
            src.iter().map(|&p| (p, apply_rt(&truth, &shift, p))).collect();
        assert!(!kabsch_is_degenerate(&pairs));
        let (r, t) = kabsch_rt(&pairs);
        for i in 0..3 {
            for j in 0..3 { assert!((r[i][j] - truth[i][j]).abs() < 1e-9); }
            assert!((t[i] - shift[i]).abs() < 1e-9);
        }
    }
}

#[cfg(test)]
mod plane_extract_tests {
    use super::*;

    /// Synthetic floor — 30×30 grid at z = 0 + 1 mm noise, with one
    /// vertical wall along X (y = 1.5). Two plane patches must come
    /// out, with horizontal + vertical normals respectively.
    #[test]
    fn extract_floor_and_wall() {
        let mut pts: Vec<[f64; 3]> = Vec::new();
        // Floor — 5 cm spacing → ~36 points per 30 cm voxel → above
        // the default min_voxel_points = 16.
        for ix in 0..40 {
            for iy in 0..40 {
                let x = (ix as f64) * 0.05;
                let y = (iy as f64) * 0.05;
                pts.push([x, y, 0.0]);
            }
        }
        // Vertical wall along X (n = +Y).
        for ix in 0..40 {
            for iz in 0..30 {
                let x = (ix as f64) * 0.05;
                let z = (iz as f64) * 0.05;
                pts.push([x, 1.5, z]);
            }
        }
        let p = PlaneExtractParams::default();
        let out = extract_plane_patches(&pts, &p);
        assert!(out.len() >= 2, "expected ≥ 2 patches, got {}", out.len());
        // Look for one near-vertical normal (|n_z| ≈ 1) and one near-
        // horizontal normal (|n_y| ≈ 1).
        let has_floor = out.iter().any(|pp| pp.normal[2].abs() > 0.95);
        let has_wall = out.iter().any(|pp| pp.normal[1].abs() > 0.95);
        assert!(has_floor, "floor plane (n ≈ ±Z) not found in {:?}", out);
        assert!(has_wall, "wall plane (n ≈ ±Y) not found in {:?}", out);
        // RMSE on synthetic flat surfaces should be sub-millimetre.
        let floor = out.iter().find(|pp| pp.normal[2].abs() > 0.95).unwrap();
        assert!(floor.rmse < 1e-3, "floor RMSE {} too high", floor.rmse);
    }

    /// A flat grid with a given half-thickness of scatter — enough
    /// points per voxel to survive the count thresholds, so the metre
    /// filters are what decide.
    fn slab(side: f64, half_thickness: f64) -> Vec<[f64; 3]> {
        // Fixed ~5 cm spacing rather than a fixed point count, so a
        // large fixture stays dense enough for the 0.5 m voxels — and
        // the voxel grid buckets in z as well, halving each cell's
        // population along the slab.
        let step = (side / 59.0).min(0.05);
        let n = ((side / step).round() as usize) + 1;
        (0..n)
            .flat_map(|ix| (0..n).map(move |iy| (ix, iy)))
            .map(|(ix, iy)| {
                let x = ix as f64 * step;
                let y = iy as f64 * step;
                // Deterministic scatter that fills the band evenly.
                let phase = (ix * 7 + iy * 13) % 5;
                let z = half_thickness * (phase as f64 / 2.0 - 1.0);
                [x, y, z]
            })
            .collect()
    }

    /// Two flat halves with the same normal, offset from each other
    /// along it — a wall and a recessed panel beside it, a floor and a
    /// low platform. Every voxel is perfectly flat, so nothing in the
    /// per-voxel test objects, and the normals are identical, so region
    /// growing merges them into one patch whose fitted plane lies
    /// halfway between two surfaces and belongs to neither.
    fn offset_pair(side: f64, offset: f64) -> Vec<[f64; 3]> {
        let step = (side / 59.0).min(0.05);
        let n = ((side / step).round() as usize) + 1;
        (0..n)
            .flat_map(|ix| (0..n).map(move |iy| (ix, iy)))
            .map(|(ix, iy)| {
                let x = ix as f64 * step;
                let y = iy as f64 * step;
                [x, y, if y > side * 0.5 { offset } else { 0.0 }]
            })
            .collect()
    }

    /// RIEGL's `planeExtractor.maxStdDev` = 0.03 m, and what it
    /// catches is a case the eigenvalue ratio structurally cannot:
    /// **two parallel surfaces merged into one patch.** Every voxel is
    /// flat, every normal agrees, so both the per-voxel ratio and the
    /// region-growing angle test are satisfied — and the patch's own
    /// ratio stays tiny because it is dominated by the two metres of
    /// extent, not by the ten centimetres of offset. The fitted plane
    /// then sits halfway between a wall and the panel beside it, and a
    /// matcher registering against its centroid is registering against
    /// a surface that is not there. (A plane fitted to a step tilts to
    /// split the difference, so the RMS lands near a quarter of the
    /// offset, not half of it — hence 20 cm here to clear 3 cm.)
    ///
    /// (Scatter is NOT the interesting case: at a 0.5 m voxel our
    /// `planarity_max` of 0.015 already corresponds to about 2.5 cm of
    /// thickness, so noisy voxels are rejected before a patch forms.
    /// The two gates cover different failures, which is why both are
    /// worth having.)
    #[test]
    fn two_surfaces_merged_into_one_patch_are_rejected_by_riegls_std_dev() {
        let p = PlaneExtractParams::default();

        let flat = extract_plane_patches(&slab(2.0, 0.01), &p);
        assert!(!flat.is_empty(), "a 1 cm-thick 2 m patch must be accepted");
        assert!(flat.iter().all(|q| q.rmse <= p.max_std_dev));

        let merged = extract_plane_patches(&offset_pair(2.0, 0.20), &p);
        assert!(
            merged.is_empty(),
            "two surfaces 20 cm apart must not pass as one patch, got rmse {:?}",
            merged.iter().map(|q| q.rmse).collect::<Vec<_>>(),
        );

        // …and it is the std-dev test doing it, not the ratio. With the
        // filter off the pair comes through as one patch whose
        // planarity is well inside `planarity_max` — which is exactly
        // why the ratio alone was not enough.
        let unfiltered = PlaneExtractParams { max_std_dev: 0.0, ..p.clone() };
        let through = extract_plane_patches(&offset_pair(2.0, 0.20), &unfiltered);
        assert!(!through.is_empty(), "the ratio alone should have passed this pair");
        assert!(
            through[0].planarity < p.planarity_max,
            "planarity {} should be inside {}", through[0].planarity, p.planarity_max,
        );
        assert!(
            through[0].rmse > p.max_std_dev,
            "and its RMS departure {} should exceed {}", through[0].rmse, p.max_std_dev,
        );
    }

    /// RIEGL's `minSize` = 0.125 m, measured on the longer side of the
    /// patch: below it, a patch is a fragment whose normal is noise.
    #[test]
    fn a_patch_below_riegls_min_size_is_rejected() {
        let p = PlaneExtractParams::default();
        assert!(!extract_plane_patches(&slab(2.0, 0.005), &p).is_empty(), "2 m is in range");
        assert!(
            extract_plane_patches(&slab(0.10, 0.005), &p).is_empty(),
            "0.10 m is below RIEGL's minSize of {} m", p.min_size,
        );
    }

    /// The counter-test, and the reason `max_size` defaults to off:
    /// RIEGL's `maxSize` of 5 m bounds the pieces its extractor cuts a
    /// surface INTO, while ours grows one patch per surface. Adopting
    /// the number deleted a 6 m square of ground — the most reliable
    /// registration feature a forest plot has — instead of splitting
    /// it. The knob still works for anyone who wants the ceiling.
    #[test]
    fn a_ground_plane_larger_than_riegls_max_size_survives() {
        let p = PlaneExtractParams::default();
        let ground = slab(6.0, 0.005);
        let kept = extract_plane_patches(&ground, &p);
        assert!(
            !kept.is_empty(),
            "a 6 m ground plane must not be thrown away by a size ceiling",
        );

        let capped = PlaneExtractParams { max_size: 5.0, ..p };
        assert!(
            extract_plane_patches(&ground, &capped).is_empty(),
            "…but the ceiling has to work when it is asked for",
        );
    }

    /// The defaults are RIEGL's, read out of a RiSCAN PRO project's
    /// `regsettings.json`. Pinned so that changing one is a decision
    /// somebody makes on purpose, with this test to update — and so
    /// the provenance cannot quietly drift away from the comment
    /// above that claims it.
    #[test]
    fn the_physical_defaults_are_riegls_own() {
        let p = PlaneExtractParams::default();
        assert_eq!(p.voxel_size, 0.50, "voxelExtractor.voxelSize");
        assert_eq!(p.max_std_dev, 0.03, "planeExtractor.maxStdDev");
        assert_eq!(p.min_size, 0.125, "planeExtractor.minSize");
        assert_eq!(p.max_size, 0.0, "NOT planeExtractor.maxSize — see max_size's doc comment");

        let m = PlaneMatchParams::default();
        assert_eq!(m.normal_angle_tol_deg, 2.5, "planeMatcher.maxAngleDifference");
        assert_eq!(m.centroid_dist_tol, 0.25, "planeMatcher.maxDistance");
        assert_eq!(m.min_extent, 0.125, "planeExtractor.minSize");

        let a = MsaParams::default();
        assert_eq!(a.max_iters, 1000, "lsqFitter.maxIterations");
        assert_eq!(a.rmse_eps, 1e-6, "lsqFitter.tolerance");
        assert!(a.preserve_roll_pitch, "lsqFitterPlanes.preserveRollAndPitch");

        // And the ones deliberately NOT taken from RIEGL, so a future
        // "finish the job" edit has to read the reasoning first.
        assert_eq!(p.min_voxel_points, 16, "ours: RIEGL's 5 is a full-density count");
        assert_eq!(p.min_patch_points, 200, "ours: RIEGL's 10 is a full-density count");
        assert_eq!(p.planarity_max, 0.015, "ours: not RIEGL's planeThreshold");
        assert_eq!(p.normal_angle_tol_deg, 10.0, "ours: RIEGL splits this into two merges");
    }

    /// Random point clouds (no structure) should produce zero patches.
    #[test]
    fn random_cloud_emits_no_patches() {
        let mut pts: Vec<[f64; 3]> = Vec::new();
        // 1000 points in a 1 m cube — fully isotropic.
        for i in 0..1000 {
            let theta = i as f64 * 0.137;
            let phi = i as f64 * 0.273;
            pts.push([theta.sin(), phi.cos(), (theta + phi).sin()]);
        }
        let p = PlaneExtractParams::default();
        let out = extract_plane_patches(&pts, &p);
        assert!(out.is_empty(), "random cloud yielded {} patches", out.len());
    }

}

// =====================================================================
// Sphere target auto-detection (RIEGL / Leica retro-targets)
//
// RIEGL VZ/VUX users place retroreflective sphere targets in the
// scene; the SDK detects them via intensity filtering + cluster fit +
// sphere LSQ. We do the same but with a geometry-only path so a scan
// without intensity (the common PointCloudLabeler case) still works:
//
//   1. Bucket points into voxels at the target diameter scale.
//   2. For each well-populated voxel, gather its 3³-neighbour points
//      → candidate cluster.
//   3. Sphere fit: a closed-form algebraic seed (Kåsa/Coope), then
//      Gauss–Newton on the GEOMETRIC distance. The seed alone is
//      biased on a cap and these are always caps — see `fit_sphere`.
//   4. Validate:
//        • radius within search window (RIEGL std: 7.5 cm or 14.5 cm
//          diameter spheres → radius 0.075 / 0.145 m; the params
//          take min/max).
//        • RMSE small compared to radius.
//        • Cluster points span ≥ a hemisphere worth of the sphere
//          (cluster bbox at least 1.4·r in each axis → geometric
//          sanity that it's not a planar fragment).
//   5. NMS: dedupe near-duplicate detections within 1 voxel.
//
// Output: sphere centres + radii + RMSE + inlier count. Used as
// registration tie points — far more precise than hand-clicked
// correspondences.
// =====================================================================

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SphereTarget {
    pub center: [f64; 3],
    pub radius: f64,
    pub rmse: f64,
    pub n_points: u32,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SphereDetectParams {
    /// Minimum sphere radius accepted (m). Default 0.05.
    pub r_min: f64,
    /// Maximum sphere radius accepted (m). Default 0.20.
    pub r_max: f64,
    /// Maximum fit RMSE as a fraction of the radius. Default 0.10
    /// (sub-cm RMSE on a 10 cm target).
    pub rmse_rel_max: f64,
    /// Minimum points in a candidate cluster. Default 30 — well below
    /// what a properly-scanned sphere produces but above noise.
    pub min_cluster_points: u32,
    /// Voxel size for the candidate search; should be roughly the
    /// target's diameter so a sphere lives in a 3³ neighbour set.
    pub voxel_size: f64,
}

impl Default for SphereDetectParams {
    fn default() -> Self {
        Self {
            r_min: 0.05, r_max: 0.20, rmse_rel_max: 0.10,
            min_cluster_points: 30, voxel_size: 0.20,
        }
    }
}

#[tauri::command]
pub async fn coregister_detect_spheres(
    project_folder: String,
    scan: IcpScanRef,
    params: SphereDetectParams,
) -> Result<Vec<SphereTarget>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let pts = read_scan_world(&project_folder, &scan, 200_000)?;
        Ok(detect_sphere_targets(&pts, &params))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Pure-function sphere finder — same algorithm whether invoked from
/// the Tauri command or a test.
pub fn detect_sphere_targets(pts: &[[f64; 3]], params: &SphereDetectParams) -> Vec<SphereTarget> {
    if pts.is_empty() || params.voxel_size <= 0.0 { return Vec::new(); }
    let cell = params.voxel_size;
    let inv = 1.0 / cell;
    // Voxel bucket of all points.
    let mut buckets: FxHashMap<(i64, i64, i64), Vec<u32>> = FxHashMap::default();
    for (i, p) in pts.iter().enumerate() {
        let key = (
            (p[0] * inv).floor() as i64,
            (p[1] * inv).floor() as i64,
            (p[2] * inv).floor() as i64,
        );
        buckets.entry(key).or_default().push(i as u32);
    }

    // Per non-empty voxel, gather 27-neighbour points → candidate cluster.
    let mut out: Vec<SphereTarget> = Vec::new();
    let mut claimed: FxHashMap<(i64, i64, i64), bool> = FxHashMap::default();
    // Iterate seeds in deterministic order (sorted) so the same input
    // produces the same output.
    let mut seeds: Vec<((i64, i64, i64), usize)> = buckets.iter()
        .map(|(k, v)| (*k, v.len()))
        .collect();
    seeds.sort_by(|a, b| b.1.cmp(&a.1)); // start with the densest voxels

    for (seed, _n) in seeds {
        if *claimed.get(&seed).unwrap_or(&false) { continue; }
        // Collect the 27 voxels' points.
        let mut idx: Vec<u32> = Vec::with_capacity(128);
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(b) = buckets.get(&(seed.0 + dx, seed.1 + dy, seed.2 + dz)) {
                        idx.extend(b.iter().copied());
                    }
                }
            }
        }
        if (idx.len() as u32) < params.min_cluster_points { continue; }
        // BBox sanity — sphere needs > 1.4·r span in every axis.
        let mut mn = [f64::INFINITY; 3];
        let mut mx = [f64::NEG_INFINITY; 3];
        for &i in &idx {
            let q = pts[i as usize];
            for a in 0..3 { if q[a] < mn[a] { mn[a] = q[a]; } if q[a] > mx[a] { mx[a] = q[a]; } }
        }
        let span = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];

        let cluster: Vec<[f64; 3]> = idx.iter().map(|&i| pts[i as usize]).collect();
        let Some((center, radius, rmse)) = fit_sphere(&cluster) else { continue; };

        if radius < params.r_min || radius > params.r_max { continue; }
        if rmse > params.rmse_rel_max * radius { continue; }
        if span[0] < radius * 1.4 || span[1] < radius * 1.4 || span[2] < radius * 1.4 { continue; }

        out.push(SphereTarget {
            center, radius, rmse, n_points: cluster.len() as u32,
        });
        // NMS: claim the seed + immediate neighbours so we don't emit
        // the same sphere centred on adjacent voxels.
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    claimed.insert((seed.0 + dx, seed.1 + dy, seed.2 + dz), true);
                }
            }
        }
    }
    // Sort by point count descending (best fits surface first).
    out.sort_by(|a, b| b.n_points.cmp(&a.n_points));
    out
}

/// Solve a 4×4 system by Gauss elimination with partial pivoting.
/// `None` if it is rank-deficient — a caller getting `None` has no
/// answer, not a bad one.
fn solve4(mut a: [[f64; 4]; 4], mut b: [f64; 4]) -> Option<[f64; 4]> {
    for i in 0..4 {
        let mut piv = i;
        for k in i + 1..4 { if a[k][i].abs() > a[piv][i].abs() { piv = k; } }
        if piv != i { a.swap(piv, i); b.swap(piv, i); }
        let p = a[i][i];
        if p.abs() < 1e-12 { return None; }
        for k in i + 1..4 {
            let f = a[k][i] / p;
            for j in i..4 { a[k][j] -= f * a[i][j]; }
            b[k] -= f * b[i];
        }
    }
    let mut x = [0.0f64; 4];
    for i in (0..4).rev() {
        let mut s = b[i];
        for j in i + 1..4 { s -= a[i][j] * x[j]; }
        x[i] = s / a[i][i];
    }
    if x.iter().all(|v| v.is_finite()) { Some(x) } else { None }
}

/// Kåsa/Coope algebraic sphere fit: minimise Σ(‖p‖² + a·x + b·y + c·z + d)²,
/// giving centre = (−a/2, −b/2, −c/2) and r² = (a²+b²+c²)/4 − d in one
/// linear solve. Fast and closed-form, and BIASED on anything less than
/// a full sphere — which is why it is only the seed here.
fn fit_sphere_algebraic(pts: &[[f64; 3]]) -> Option<([f64; 3], f64)> {
    if pts.len() < 4 { return None; }
    let mut m = [[0.0f64; 4]; 4];
    let mut rhs = [0.0f64; 4];
    for p in pts {
        let r2 = p[0] * p[0] + p[1] * p[1] + p[2] * p[2];
        let row = [p[0], p[1], p[2], 1.0];
        for i in 0..4 {
            for j in 0..4 { m[i][j] += row[i] * row[j]; }
            rhs[i] -= row[i] * r2;
        }
    }
    let x = solve4(m, rhs)?;
    let centre = [-0.5 * x[0], -0.5 * x[1], -0.5 * x[2]];
    let r2 = 0.25 * (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]) - x[3];
    if r2 <= 0.0 || !r2.is_finite() { return None; }
    Some((centre, r2.sqrt()))
}

/// Fit a sphere to a scanned target. Returns (centre, radius, RMSE of
/// the radial residual), or None if the geometry cannot support a fit.
///
/// WHY NOT THE ALGEBRAIC FIT ALONE
///
/// This used to be the closed-form solve above and nothing else, under a
/// comment attributing it to Pratt 1987. It is not Pratt's: Pratt
/// minimises the same algebraic distance under the constraint
/// B²+C²+D²−4AE = 1, which is a generalised eigenproblem. Fixing A = 1
/// and solving ordinary least squares for the rest is the Kåsa/Coope
/// fit, and its error weight grows with distance from the centre — so on
/// a partial surface a fit that pulls the centre TOWARD the visible cap
/// and shrinks the radius scores well. `circlefit.rs` rejects exactly
/// this estimator for stem diameters, for exactly this reason.
///
/// A scanned sphere target is always a cap: the scanner sees at most a
/// hemisphere, and less when the target is tilted or partly occluded.
/// The bias therefore always applies, and it is directional — every
/// sphere seen from one scan position is displaced the same way, along
/// that scanner's line of sight, so it does not average out over targets
/// the way random error would. It biases the registration itself.
///
/// Measured, radial noise, 400 points, 300 trials (centre error along
/// the view axis / radius error):
///
/// | target | visible cap | noise | algebraic       | + Gauss–Newton  |
/// |--------|-------------|-------|-----------------|-----------------|
/// | 75 mm  | hemisphere  | 3 mm  | +0.74 / −0.30mm | +0.03 / −0.00mm |
/// | 75 mm  | 60°         | 3 mm  | +4.19 / −3.04mm | +0.05 / −0.05mm |
/// | 145 mm | hemisphere  | 3 mm  | +0.35 / −0.13mm | −0.02 / +0.03mm |
/// | 145 mm | 60°         | 3 mm  | +2.21 / −1.61mm | −0.02 / +0.03mm |
///
/// So: keep the algebraic solve for what it is good at — a starting
/// point with no initial guess needed — and then run Gauss–Newton on the
/// GEOMETRIC objective Σ(‖p − c‖ − r)², which is the maximum-likelihood
/// fit under isotropic range noise and is unbiased at every coverage.
/// It converges in a handful of steps from that seed.
fn fit_sphere(pts: &[[f64; 3]]) -> Option<([f64; 3], f64, f64)> {
    let (mut centre, mut r) = fit_sphere_algebraic(pts)?;
    let n = pts.len() as f64;

    // Gauss–Newton. Residual_i = ‖p_i − c‖ − r, so ∂/∂c = −û_i and
    // ∂/∂r = −1; the normal equations are 4×4 whatever the point count.
    for _ in 0..25 {
        let mut jtj = [[0.0f64; 4]; 4];
        let mut jtr = [0.0f64; 4];
        let mut degenerate = false;
        for p in pts {
            let d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
            let len = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
            if len < 1e-12 { degenerate = true; break; }
            let row = [-d[0] / len, -d[1] / len, -d[2] / len, -1.0];
            let res = len - r;
            for i in 0..4 {
                for j in 0..4 { jtj[i][j] += row[i] * row[j]; }
                jtr[i] -= row[i] * res;
            }
        }
        // A point exactly at the centre has no gradient direction; stop
        // rather than divide by zero, keeping the last good estimate.
        if degenerate { break; }
        let Some(step) = solve4(jtj, jtr) else { break };
        centre = [centre[0] + step[0], centre[1] + step[1], centre[2] + step[2]];
        r += step[3];
        if !(r > 0.0) || !centre.iter().all(|v| v.is_finite()) { return None; }
        // Converged once the step is far below any scanner's precision.
        if step.iter().all(|v| v.abs() < 1e-12) { break; }
    }

    let mut sq = 0.0;
    for p in pts {
        let d = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
        let dr = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt() - r;
        sq += dr * dr;
    }
    Some((centre, r, (sq / n).sqrt()))
}

#[cfg(test)]
mod sphere_target_tests {
    use super::*;

    /// Sphere fit recovers a clean synthetic sphere to mm precision.
    #[test]
    fn sphere_fit_recovers_clean_sphere() {
        let cx = 1.0; let cy = 2.0; let cz = 3.0; let r = 0.075;
        let mut pts: Vec<[f64; 3]> = Vec::new();
        // 200 points evenly distributed on a sphere via Fibonacci
        // lattice — better coverage than naïve theta/phi grid.
        let n = 200usize;
        let golden = std::f64::consts::PI * (3.0 - 5.0_f64.sqrt());
        for i in 0..n {
            let y = 1.0 - (i as f64 / (n - 1) as f64) * 2.0;
            let rad = (1.0 - y * y).max(0.0).sqrt();
            let theta = golden * i as f64;
            pts.push([
                cx + r * theta.cos() * rad,
                cy + r * y,
                cz + r * theta.sin() * rad,
            ]);
        }
        let (c, fr, rmse) = fit_sphere(&pts).expect("fit");
        assert!((c[0] - cx).abs() < 1e-6, "cx {} ≠ {}", c[0], cx);
        assert!((c[1] - cy).abs() < 1e-6, "cy {} ≠ {}", c[1], cy);
        assert!((c[2] - cz).abs() < 1e-6, "cz {} ≠ {}", c[2], cz);
        assert!((fr - r).abs() < 1e-6, "r {} ≠ {}", fr, r);
        assert!(rmse < 1e-9, "RMSE {} too high", rmse);
    }


    /// A scanned sphere target is a CAP, never a whole sphere, and the
    /// algebraic fit reads a cap wrong in a way that does not average
    /// out: the centre slides toward the visible surface, along the
    /// scanner's line of sight, by the same amount for every target that
    /// scanner sees. Registration then inherits it as a translation.
    ///
    /// This is the test that would have caught the fit being shipped as
    /// "Pratt 1987" when it was Kåsa. The gate is on the BIAS — the mean
    /// over many trials — not on a single fit's error, because a single
    /// fit's error is dominated by noise and looks fine either way.
    #[test]
    fn the_geometric_refinement_removes_the_cap_bias() {
        // Deterministic pseudo-noise: a fixed LCG, so a failure here is
        // reproducible rather than a coin flip in CI.
        let mut seed = 12345u32;
        // A fixed LCG, taken by &mut so the same stream feeds both the
        // sampling and the noise.
        fn u01(seed: &mut u32) -> f64 {
            *seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (*seed >> 8) as f64 / 16_777_216.0
        }
        // Four uniforms summed — Gaussian enough for a bias measurement,
        // and exactly reproducible. Scaled to UNIT standard deviation:
        // four uniforms on [−½, ½] sum to variance 4/12, so √3 brings it
        // to 1. Getting that scale wrong silently shrinks the bias being
        // measured, which is second order in the noise.
        fn noise(seed: &mut u32) -> f64 {
            (0..4).map(|_| u01(seed) - 0.5).sum::<f64>() * 3.0f64.sqrt()
        }

        let r = 0.075f64;
        let cap_cos = 0.5f64; // a 60° cap — a tilted or partly occluded target
        let trials = 200;
        let (mut alg_dz, mut geo_dz) = (0.0f64, 0.0f64);
        let (mut alg_dr, mut geo_dr) = (0.0f64, 0.0f64);

        for _ in 0..trials {
            let mut pts: Vec<[f64; 3]> = Vec::with_capacity(300);
            for _ in 0..300 {
                let u = cap_cos + (1.0 - cap_cos) * u01(&mut seed);
                let phi = std::f64::consts::TAU * u01(&mut seed);
                let st = (1.0 - u * u).max(0.0).sqrt();
                // 3 mm of radial range noise, the scale of a TLS return.
                let rr = r + 0.003 * noise(&mut seed);
                pts.push([rr * st * phi.cos(), rr * st * phi.sin(), rr * u]);
            }
            let (ca, ra) = fit_sphere_algebraic(&pts).expect("algebraic fit");
            let (cg, rg, _) = fit_sphere(&pts).expect("geometric fit");
            alg_dz += ca[2]; alg_dr += ra - r;
            geo_dz += cg[2]; geo_dr += rg - r;
        }
        let (n, mm) = (trials as f64, 1000.0);
        let (alg_dz, alg_dr) = (alg_dz / n * mm, alg_dr / n * mm);
        let (geo_dz, geo_dr) = (geo_dz / n * mm, geo_dr / n * mm);

        // The seed is biased, and the test says so out loud — if this
        // ever stops being true the refinement is measuring nothing.
        assert!(alg_dz > 1.0,
            "the algebraic seed should read a 60° cap high by millimetres, got {alg_dz:+.3} mm");
        assert!(alg_dr < -1.0,
            "…and its radius low, got {alg_dr:+.3} mm");

        // The refinement removes it. 0.2 mm is well inside any scanner's
        // own precision and an order of magnitude below the seed's bias.
        assert!(geo_dz.abs() < 0.2,
            "centre bias survived the refinement: {geo_dz:+.3} mm (seed {alg_dz:+.3} mm)");
        assert!(geo_dr.abs() < 0.2,
            "radius bias survived the refinement: {geo_dr:+.3} mm (seed {alg_dr:+.3} mm)");
    }

    /// The refinement must not wander off a fit that is already right,
    /// and must survive the degenerate shapes a voxel of clutter can
    /// hand it.
    #[test]
    fn sphere_fit_is_stable_on_awkward_input() {
        // Fewer than 4 points cannot define a sphere.
        assert!(fit_sphere(&[[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]).is_none());
        // Coplanar points: the algebraic system is rank-deficient.
        let flat: Vec<[f64; 3]> = (0..25)
            .map(|i| [(i % 5) as f64 * 0.1, (i / 5) as f64 * 0.1, 0.0])
            .collect();
        assert!(fit_sphere(&flat).is_none(), "a flat patch is not a sphere");
        // Coincident points.
        assert!(fit_sphere(&[[1.0, 1.0, 1.0]; 8]).is_none());
    }

    /// Full pipeline: synthetic scan with a planar floor + one RIEGL
    /// 7.5 cm target. The detector finds the sphere; the floor stays
    /// off the candidate list because its points span more than the
    /// target diameter in only 2 axes.
    #[test]
    fn detect_one_riegl_target_among_floor_clutter() {
        let mut pts: Vec<[f64; 3]> = Vec::new();
        // Floor — 50 × 50 points at 5 cm spacing.
        for ix in 0..50 {
            for iy in 0..50 {
                pts.push([ix as f64 * 0.05, iy as f64 * 0.05, 0.0]);
            }
        }
        // RIEGL 7.5 cm radius sphere at (1.0, 1.0, 0.5).
        let cx = 1.0; let cy = 1.0; let cz = 0.5; let r = 0.075;
        let n = 400usize;
        let golden = std::f64::consts::PI * (3.0 - 5.0_f64.sqrt());
        for i in 0..n {
            let y = 1.0 - (i as f64 / (n - 1) as f64) * 2.0;
            let rad = (1.0 - y * y).max(0.0).sqrt();
            let theta = golden * i as f64;
            pts.push([
                cx + r * theta.cos() * rad,
                cy + r * y,
                cz + r * theta.sin() * rad,
            ]);
        }
        let p = SphereDetectParams::default();
        let out = detect_sphere_targets(&pts, &p);
        assert_eq!(out.len(), 1, "expected exactly 1 sphere, got {} ({:?})", out.len(), out);
        let s = &out[0];
        assert!((s.center[0] - cx).abs() < 1e-3, "cx {} ≠ {}", s.center[0], cx);
        assert!((s.center[1] - cy).abs() < 1e-3, "cy {} ≠ {}", s.center[1], cy);
        assert!((s.center[2] - cz).abs() < 1e-3, "cz {} ≠ {}", s.center[2], cz);
        assert!((s.radius - r).abs() < 1e-3, "r {} ≠ {}", s.radius, r);
    }

    /// Random isotropic clouds produce zero spheres.
    #[test]
    fn random_cloud_emits_no_spheres() {
        let mut pts: Vec<[f64; 3]> = Vec::new();
        for i in 0..2000 {
            let t = i as f64 * 0.137;
            let u = i as f64 * 0.273;
            let v = i as f64 * 0.491;
            pts.push([t.sin(), u.cos(), v.sin()]);
        }
        let p = SphereDetectParams::default();
        let out = detect_sphere_targets(&pts, &p);
        assert!(out.is_empty(), "random cloud yielded {} spheres", out.len());
    }
}

// =====================================================================
// Multi-Station Adjustment (MSA) — global pose graph optimisation
//
// RiSCAN PRO's MSA + Cyclone REGISTER 360's bundle adjustment + the
// open-source g2o framework all do the same thing: given N scans with
// current pose estimates T_0..T_{N-1} (from pairwise Kabsch / ICP)
// and K correspondences each anchoring a pair of scans, find a
// globally consistent pose set that minimises the residual energy.
//
// Parameterisation:
//   • Scan 0 is fixed as the reference (T_0 stays equal to its input).
//   • Each non-reference scan's perturbation is a 6-vector
//     ξ_i = (ω_i, τ_i): small rotation (angular vector) + translation
//     applied on the LEFT of the current pose:
//       T_i^new = exp(ξ_i) · T_i^current
//   • State vector x = (ξ_1, ..., ξ_{N-1}) ∈ ℝ^{6(N-1)}.
//
// Residuals per correspondence (scan_i, scan_j, p_i^local, p_j^local):
//       r_k = (R_i · p_i^local + t_i) − (R_j · p_j^local + t_j)   ∈ ℝ³
//
// Linearising R_i^new · v ≈ v + ω_i × v with w_i = R_i · p_i + t_i:
//   r_k^new ≈ r_k + ((ω_i × w_i) + τ_i) − ((ω_j × w_j) + τ_j).
// Two 3×6 Jacobian blocks at columns 6(i−1)+0..5 and 6(j−1)+0..5 of
// the form [−[w]_× | I] and [+[w]_× | −I]. Reference (idx 0) → no block.
//
// Solver: Levenberg-Marquardt — (J^T J + λI) δ = −J^T r — dense Gauss
// elimination on the 6(N−1) × 6(N−1) normal equations. λ doubles on a
// step that worsens residual, halves on success. Standard LM.
// =====================================================================

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MsaCorrespondence {
    pub i: u32,
    pub j: u32,
    pub p_i_local: [f64; 3],
    pub p_j_local: [f64; 3],
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MsaParams {
    /// Iteration cap. RIEGL's `lsqFitterPlanes.maxIterations` = 1000.
    /// A cap, not a target: the RMSE test below normally stops it in
    /// a handful of iterations, and each one costs one dense solve of
    /// a 6(N−1)-square system.
    pub max_iters: u32,
    pub lambda_init: f64,
    /// Stop when an accepted step improves the RMSE by less than this.
    /// RIEGL's `lsqFitter*.tolerance` = 1e-6. Was 1e-5.
    pub rmse_eps: f64,
    /// Solve for yaw and translation only, leaving each scan's roll and
    /// pitch exactly as they are. RIEGL's
    /// `lsqFitterPlanes.preserveRollAndPitch`, on by default there and
    /// here.
    ///
    /// It is the right default for tripod TLS: the scanner's
    /// inclination sensors measure roll and pitch to about a
    /// hundredth of a degree, which is better than a plane- or
    /// sphere-based fit will recover them, so letting the adjustment
    /// move them trades a good measurement for a fitted guess — and
    /// tilts the whole plot when the correspondences are one-sided.
    ///
    /// Implemented by zeroing the two world-frame rotation columns
    /// (ω_x, ω_y) of every scan's Jacobian block, which leaves those
    /// parameters with no gradient and no update — an exact
    /// constraint, not a penalty. This assumes the project frame is
    /// Z-up, which is what PRCS is.
    #[serde(default = "riegl_preserve_roll_pitch")]
    pub preserve_roll_pitch: bool,
}

fn riegl_preserve_roll_pitch() -> bool { true }

impl Default for MsaParams {
    fn default() -> Self {
        Self {
            max_iters: 1000,
            lambda_init: 1e-4,
            rmse_eps: 1e-6,
            preserve_roll_pitch: riegl_preserve_roll_pitch(),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MsaResult {
    pub poses: Vec<Vec<f64>>,
    pub rmse_history: Vec<f64>,
    pub converged: bool,
    pub final_rmse: f64,
    pub correspondences: u32,
}

#[tauri::command]
pub async fn coregister_msa(
    poses: Vec<Vec<f64>>,
    correspondences: Vec<MsaCorrespondence>,
    params: MsaParams,
) -> Result<MsaResult, String> {
    tauri::async_runtime::spawn_blocking(move || run_msa(&poses, &correspondences, &params))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

pub fn run_msa(
    initial_poses: &[Vec<f64>],
    corrs: &[MsaCorrespondence],
    params: &MsaParams,
) -> Result<MsaResult, String> {
    let n = initial_poses.len();
    if n < 2 { return Err("MSA needs at least 2 scans".into()); }
    if corrs.is_empty() { return Err("MSA needs at least one correspondence".into()); }
    for p in initial_poses {
        if p.len() != 16 { return Err("each pose must be 16-element row-major 4×4".into()); }
    }
    for c in corrs {
        if (c.i as usize) >= n || (c.j as usize) >= n {
            return Err(format!("correspondence indices {}/{} exceed scan count {n}", c.i, c.j));
        }
        if c.i == c.j { return Err("correspondence i and j must differ".into()); }
    }
    let mut rs: Vec<[[f64; 3]; 3]> = initial_poses.iter().map(|p| {
        [[p[0], p[1], p[2]], [p[4], p[5], p[6]], [p[8], p[9], p[10]]]
    }).collect();
    let mut ts: Vec<[f64; 3]> = initial_poses.iter().map(|p| [p[3], p[7], p[11]]).collect();

    let m_params = 6 * (n - 1);
    let initial_rmse = msa_compute_rmse(&rs, &ts, corrs);
    let mut history: Vec<f64> = vec![initial_rmse];
    let mut lambda = params.lambda_init;
    let mut converged = false;
    let mut last_rmse = initial_rmse;

    for _iter in 0..params.max_iters {
        let mut jtj = vec![vec![0.0f64; m_params]; m_params];
        let mut jtr = vec![0.0f64; m_params];
        for c in corrs {
            let i = c.i as usize;
            let j = c.j as usize;
            let w_i = mat3_apply(&rs[i], c.p_i_local, ts[i]);
            let w_j = mat3_apply(&rs[j], c.p_j_local, ts[j]);
            let r_xyz = [w_i[0] - w_j[0], w_i[1] - w_j[1], w_i[2] - w_j[2]];
            for axis in 0..3 {
                let mut row = vec![0.0f64; m_params];
                // With roll and pitch preserved, the ω_x and ω_y
                // columns are dropped from the system entirely: their
                // rows of JᵗJ and Jᵗr come out zero, the λ ridge keeps
                // the matrix invertible, and the solve returns exactly
                // zero for them. No update, no drift, no penalty term
                // to tune.
                // Parameter order per scan is (ω_x, ω_y, ω_z, τ), so
                // the two constrained ones are the leading pair.
                let fixed = if params.preserve_roll_pitch { 2 } else { 0 };
                if i != 0 {
                    let block = jac_block_pos(w_i, axis);
                    let off = 6 * (i - 1);
                    for k in fixed..6 { row[off + k] = block[k]; }
                }
                if j != 0 {
                    let block = jac_block_neg(w_j, axis);
                    let off = 6 * (j - 1);
                    for k in fixed..6 { row[off + k] += block[k]; }
                }
                for a in 0..m_params {
                    if row[a] == 0.0 { continue; }
                    jtr[a] -= row[a] * r_xyz[axis];
                    for b in 0..m_params {
                        if row[b] == 0.0 { continue; }
                        jtj[a][b] += row[a] * row[b];
                    }
                }
            }
        }
        for a in 0..m_params { jtj[a][a] += lambda; }
        let Some(delta) = solve_dense_n(jtj, jtr.clone()) else {
            lambda *= 4.0;
            if lambda > 1e8 { break; }
            continue;
        };
        let (rs_trial, ts_trial) = msa_apply_step(&rs, &ts, &delta);
        let trial_rmse = msa_compute_rmse(&rs_trial, &ts_trial, corrs);
        if trial_rmse < last_rmse {
            rs = rs_trial; ts = ts_trial;
            history.push(trial_rmse);
            if (last_rmse - trial_rmse) < params.rmse_eps {
                converged = true;
                last_rmse = trial_rmse;
                break;
            }
            last_rmse = trial_rmse;
            lambda *= 0.5;
        } else {
            lambda *= 4.0;
            if lambda > 1e8 { break; }
        }
    }

    let mut poses: Vec<Vec<f64>> = Vec::with_capacity(n);
    for k in 0..n {
        poses.push(vec![
            rs[k][0][0], rs[k][0][1], rs[k][0][2], ts[k][0],
            rs[k][1][0], rs[k][1][1], rs[k][1][2], ts[k][1],
            rs[k][2][0], rs[k][2][1], rs[k][2][2], ts[k][2],
            0.0, 0.0, 0.0, 1.0,
        ]);
    }
    Ok(MsaResult {
        poses, rmse_history: history, converged,
        final_rmse: last_rmse, correspondences: corrs.len() as u32,
    })
}

fn mat3_apply(r: &[[f64; 3]; 3], p: [f64; 3], t: [f64; 3]) -> [f64; 3] {
    [
        r[0][0] * p[0] + r[0][1] * p[1] + r[0][2] * p[2] + t[0],
        r[1][0] * p[0] + r[1][1] * p[1] + r[1][2] * p[2] + t[1],
        r[2][0] * p[0] + r[2][1] * p[1] + r[2][2] * p[2] + t[2],
    ]
}

fn jac_block_pos(w: [f64; 3], axis: usize) -> [f64; 6] {
    // ∂(ω × w + τ)_axis / ∂(ω_x, ω_y, ω_z, τ_x, τ_y, τ_z)
    let mut b = [0.0f64; 6];
    match axis {
        0 => { b[1] =  w[2]; b[2] = -w[1]; b[3] = 1.0; }
        1 => { b[0] = -w[2]; b[2] =  w[0]; b[4] = 1.0; }
        _ => { b[0] =  w[1]; b[1] = -w[0]; b[5] = 1.0; }
    }
    b
}

fn jac_block_neg(w: [f64; 3], axis: usize) -> [f64; 6] {
    let p = jac_block_pos(w, axis);
    [-p[0], -p[1], -p[2], -p[3], -p[4], -p[5]]
}

fn msa_compute_rmse(
    rs: &[[[f64; 3]; 3]], ts: &[[f64; 3]], corrs: &[MsaCorrespondence],
) -> f64 {
    let mut sum = 0.0;
    for c in corrs {
        let w_i = mat3_apply(&rs[c.i as usize], c.p_i_local, ts[c.i as usize]);
        let w_j = mat3_apply(&rs[c.j as usize], c.p_j_local, ts[c.j as usize]);
        let r = [w_i[0] - w_j[0], w_i[1] - w_j[1], w_i[2] - w_j[2]];
        sum += r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    }
    (sum / (3.0 * corrs.len() as f64)).sqrt()
}

fn msa_apply_step(
    rs: &[[[f64; 3]; 3]], ts: &[[f64; 3]], delta: &[f64],
) -> (Vec<[[f64; 3]; 3]>, Vec<[f64; 3]>) {
    let mut rs_new = rs.to_vec();
    let mut ts_new = ts.to_vec();
    let n = rs.len();
    for k in 1..n {
        let off = 6 * (k - 1);
        let omega = [delta[off], delta[off + 1], delta[off + 2]];
        let tau = [delta[off + 3], delta[off + 4], delta[off + 5]];
        let r_inc = exp_map(omega);
        rs_new[k] = mat3_mul(&r_inc, &rs[k]);
        let rt = mat3_apply(&r_inc, ts[k], [0.0; 3]);
        ts_new[k] = [rt[0] + tau[0], rt[1] + tau[1], rt[2] + tau[2]];
    }
    (rs_new, ts_new)
}

fn mat3_mul(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let mut s = 0.0;
            for k in 0..3 { s += a[i][k] * b[k][j]; }
            out[i][j] = s;
        }
    }
    out
}

fn solve_dense_n(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    if a.len() != n { return None; }
    for i in 0..n {
        let mut piv = i;
        for k in i + 1..n { if a[k][i].abs() > a[piv][i].abs() { piv = k; } }
        if piv != i { a.swap(piv, i); b.swap(piv, i); }
        let p = a[i][i];
        if p.abs() < 1e-15 { return None; }
        for k in i + 1..n {
            let f = a[k][i] / p;
            for j in i..n { a[k][j] -= f * a[i][j]; }
            b[k] -= f * b[i];
        }
    }
    let mut x = vec![0.0f64; n];
    for i in (0..n).rev() {
        let mut s = b[i];
        for j in i + 1..n { s -= a[i][j] * x[j]; }
        x[i] = s / a[i][i];
    }
    Some(x)
}

#[cfg(test)]
mod msa_tests {
    use super::*;

    /// 3 scans with known true poses, perturbed initial guesses, 30
    /// world points → 90 pairwise correspondences. MSA collapses RMSE
    /// to sub-mm and recovers true translations to mm precision.
    ///
    /// Explicitly unconstrained: the perturbations include roll and
    /// pitch, and this test is about the full six-degree-of-freedom
    /// solve. The default now preserves roll and pitch (RIEGL's
    /// `preserveRollAndPitch`), which by construction cannot undo a
    /// roll perturbation — `msa_preserving_roll_and_pitch_*` below
    /// test that behaviour instead.
    #[test]
    fn msa_recovers_three_perturbed_poses() {
        let r1 = exp_map([0.0, 0.0, 5.0_f64.to_radians()]);
        let t1 = [1.0, 0.5, 0.0];
        let r2 = mat3_mul(
            &exp_map([(-3.0_f64).to_radians(), 0.0, 0.0]),
            &exp_map([0.0, 2.0_f64.to_radians(), 0.0]),
        );
        let t2 = [0.2, -1.0, 0.3];

        let mut corrs: Vec<MsaCorrespondence> = Vec::new();
        for i in 0..30 {
            let t = i as f64;
            let wp = [t.sin() * 2.0, (t * 0.7).cos() * 1.5, ((t * 0.5) + 0.3).sin() * 0.8];
            let p1 = world_to_local(&r1, &t1, wp);
            let p2 = world_to_local(&r2, &t2, wp);
            corrs.push(MsaCorrespondence { i: 0, j: 1, p_i_local: wp, p_j_local: p1 });
            corrs.push(MsaCorrespondence { i: 0, j: 2, p_i_local: wp, p_j_local: p2 });
            corrs.push(MsaCorrespondence { i: 1, j: 2, p_i_local: p1, p_j_local: p2 });
        }
        let init_r1 = mat3_mul(&exp_map([0.01, -0.005, 0.0]), &r1);
        let init_t1 = [t1[0] + 0.02, t1[1] - 0.01, t1[2] + 0.015];
        let init_r2 = mat3_mul(&exp_map([-0.008, 0.012, 0.005]), &r2);
        let init_t2 = [t2[0] - 0.018, t2[1] + 0.022, t2[2] - 0.012];
        let initial_poses = vec![
            identity_4x4(),
            pose_from_rt(&init_r1, &init_t1),
            pose_from_rt(&init_r2, &init_t2),
        ];
        let free = MsaParams { preserve_roll_pitch: false, ..MsaParams::default() };
        let res = run_msa(&initial_poses, &corrs, &free).expect("MSA");
        assert!(res.final_rmse < 1e-4,
            "final RMSE {} should be ≤ 0.1 mm", res.final_rmse);
        for w in res.rmse_history.windows(2) {
            assert!(w[1] <= w[0] + 1e-9,
                "RMSE history non-monotonic: {} → {}", w[0], w[1]);
        }
        let rec_t1 = [res.poses[1][3], res.poses[1][7], res.poses[1][11]];
        let rec_t2 = [res.poses[2][3], res.poses[2][7], res.poses[2][11]];
        for i in 0..3 {
            assert!((rec_t1[i] - t1[i]).abs() < 1e-3, "t1[{i}] {} ≠ {}", rec_t1[i], t1[i]);
            assert!((rec_t2[i] - t2[i]).abs() < 1e-3, "t2[{i}] {} ≠ {}", rec_t2[i], t2[i]);
        }
    }

    /// Zero-residual input must stay at zero.
    #[test]
    fn msa_no_op_on_zero_residual() {
        let r = exp_map([0.0, 0.0, 0.1]);
        let t = [0.5, 0.0, 0.0];
        let mut corrs = Vec::new();
        for &w in &[[1.0, 2.0, 0.5_f64], [0.0, 1.0, 2.0], [-1.5, 0.5, 1.5]] {
            corrs.push(MsaCorrespondence {
                i: 0, j: 1, p_i_local: w, p_j_local: world_to_local(&r, &t, w),
            });
        }
        let res = run_msa(&[identity_4x4(), pose_from_rt(&r, &t)], &corrs, &MsaParams::default())
            .expect("MSA");
        assert!(res.final_rmse < 1e-9,
            "RMSE on zero-residual input should be ~0, got {}", res.final_rmse);
    }

    /// What the constrained solve is FOR: a yaw-and-translation error
    /// is exactly what a tripod TLS registration has to fix, and
    /// preserving roll and pitch must not stop it from fixing it.
    #[test]
    fn msa_preserving_roll_and_pitch_still_fixes_yaw_and_translation() {
        let r_true = exp_map([0.0, 0.0, 7.0_f64.to_radians()]);
        let t_true = [1.5, -0.75, 0.25];
        let mut corrs: Vec<MsaCorrespondence> = Vec::new();
        for i in 0..24 {
            let t = i as f64;
            let wp = [t.sin() * 3.0, (t * 0.6).cos() * 2.0, ((t * 0.4) + 0.2).sin() * 1.0];
            corrs.push(MsaCorrespondence {
                i: 0, j: 1, p_i_local: wp, p_j_local: world_to_local(&r_true, &t_true, wp),
            });
        }
        // Off by 2° of yaw and a couple of centimetres.
        let init_r = mat3_mul(&exp_map([0.0, 0.0, 2.0_f64.to_radians()]), &r_true);
        let init_t = [t_true[0] + 0.03, t_true[1] - 0.02, t_true[2] + 0.01];
        let res = run_msa(
            &[identity_4x4(), pose_from_rt(&init_r, &init_t)],
            &corrs,
            &MsaParams::default(),
        )
        .expect("MSA");
        assert!(res.final_rmse < 1e-4, "final RMSE {} should be ≤ 0.1 mm", res.final_rmse);
        for i in 0..3 {
            let got = res.poses[1][[3, 7, 11][i]];
            assert!((got - t_true[i]).abs() < 1e-3, "t[{i}] {got} ≠ {}", t_true[i]);
        }
    }

    /// And what it is against: a roll error must come back unchanged,
    /// because the inclination sensors measured it better than this
    /// fit can. The unconstrained solve does correct it — the two
    /// halves together are what make this a behaviour and not an
    /// accident of convergence.
    #[test]
    fn msa_preserving_roll_and_pitch_leaves_roll_alone() {
        let r_true = exp_map([0.0, 0.0, 0.0]);
        let t_true = [0.0, 0.0, 0.0];
        let mut corrs: Vec<MsaCorrespondence> = Vec::new();
        for i in 0..24 {
            let t = i as f64;
            let wp = [t.sin() * 3.0, (t * 0.6).cos() * 2.0, ((t * 0.4) + 0.2).sin() * 1.5];
            corrs.push(MsaCorrespondence {
                i: 0, j: 1, p_i_local: wp, p_j_local: world_to_local(&r_true, &t_true, wp),
            });
        }
        // A pure roll error: 1.5° about world X.
        let roll = 1.5_f64.to_radians();
        let init = pose_from_rt(&exp_map([roll, 0.0, 0.0]), &[0.0, 0.0, 0.0]);

        let kept = run_msa(&[identity_4x4(), init.clone()], &corrs, &MsaParams::default())
            .expect("MSA (roll preserved)");
        // R[2][1] = sin(roll) for a rotation about X — unchanged.
        assert!(
            (kept.poses[1][9] - roll.sin()).abs() < 1e-6,
            "roll moved: {} vs {}", kept.poses[1][9], roll.sin(),
        );
        // The residual it cannot fix is still reported honestly.
        assert!(kept.final_rmse > 1e-3, "a roll error should leave residual, got {}", kept.final_rmse);

        let free = MsaParams { preserve_roll_pitch: false, ..MsaParams::default() };
        let fixed = run_msa(&[identity_4x4(), init], &corrs, &free).expect("MSA (free)");
        assert!(fixed.poses[1][9].abs() < 1e-4, "the free solve should undo the roll, got {}", fixed.poses[1][9]);
        assert!(fixed.final_rmse < kept.final_rmse * 0.1, "the free solve should fit better");
    }

    fn pose_from_rt(r: &[[f64; 3]; 3], t: &[f64; 3]) -> Vec<f64> {
        vec![
            r[0][0], r[0][1], r[0][2], t[0],
            r[1][0], r[1][1], r[1][2], t[1],
            r[2][0], r[2][1], r[2][2], t[2],
            0.0, 0.0, 0.0, 1.0,
        ]
    }
    fn transpose3(r: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
        [[r[0][0], r[1][0], r[2][0]],
         [r[0][1], r[1][1], r[2][1]],
         [r[0][2], r[1][2], r[2][2]]]
    }
    fn world_to_local(r: &[[f64; 3]; 3], t: &[f64; 3], w: [f64; 3]) -> [f64; 3] {
        let d = [w[0] - t[0], w[1] - t[1], w[2] - t[2]];
        let ri = transpose3(r);
        [ri[0][0]*d[0]+ri[0][1]*d[1]+ri[0][2]*d[2],
         ri[1][0]*d[0]+ri[1][1]*d[1]+ri[1][2]*d[2],
         ri[2][0]*d[0]+ri[2][1]*d[1]+ri[2][2]*d[2]]
    }
}

// =====================================================================
// Pairwise feature matching — sphere-RANSAC
//
// Given the sphere centres detected on two scans, find the assignment
// (source_idx → target_idx) that maximises the inlier count under a
// rigid 4×4 transform. This is the "automatic tie-point" step that
// replaces hand-clicking corresponding spheres across scans in RiSCAN
// PRO / Cyclone REGISTER 360.
//
// RANSAC:
//   1. Candidate pairs = every (i, j) where |r_i − r_j| < radius_tol.
//   2. For `iterations` rounds, pick 3 candidate pairs at random,
//      solve Kabsch, transform every source centre, count how many
//      target centres land within `inlier_tol` of a transformed
//      source. The triple with the most inliers wins.
//   3. Output the inlier pair set + the estimated transform + RMSE.
//
// The frontend pushes the inlier sphere centres into the existing
// tie-point list so the Kabsch-solve / ICP-refine pipeline runs
// unchanged.
// =====================================================================

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MatchedSpherePair {
    /// Index into the source-scan sphere list.
    pub source_idx: u32,
    /// Index into the target-scan sphere list.
    pub target_idx: u32,
    /// Centre of the source sphere in the source scan's WORLD frame.
    pub source_center: [f64; 3],
    /// Centre of the target sphere in the target scan's WORLD frame.
    pub target_center: [f64; 3],
    /// Mean of the two sphere radii — for the UI to label the pair.
    pub radius_mean: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SphereMatchResult {
    pub pairs: Vec<MatchedSpherePair>,
    /// Refined source pose (Kabsch over every inlier pair) — same
    /// 4×4 row-major shape coregister_solve produces, so the
    /// caller can feed it straight into `coregister_apply`.
    pub pose: Vec<f64>,
    /// RMSE over the inlier pairs after the transform.
    pub rmse: f64,
    /// How many candidate pairs (radius-compatible) were considered.
    pub candidates: u32,
    /// How many RANSAC iterations were spent.
    pub iterations: u32,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SphereMatchParams {
    /// Reject pairs whose radii differ by more than this (m). Default
    /// 0.01 m (RIEGL standard sizes differ by 7 cm, so this is well
    /// inside the gap).
    pub radius_tol: f64,
    /// Accept an inlier when a transformed source centre lands within
    /// this distance (m) of a target centre. Default 0.05 m.
    pub inlier_tol: f64,
    /// RANSAC iterations. Default 500.
    pub iterations: u32,
}

impl Default for SphereMatchParams {
    fn default() -> Self { Self { radius_tol: 0.01, inlier_tol: 0.05, iterations: 500 } }
}

#[tauri::command]
pub fn coregister_match_spheres(
    source: Vec<SphereTarget>,
    target: Vec<SphereTarget>,
    params: SphereMatchParams,
) -> Result<SphereMatchResult, String> {
    Ok(match_sphere_pairs(&source, &target, &params))
}

pub fn match_sphere_pairs(
    source: &[SphereTarget],
    target: &[SphereTarget],
    params: &SphereMatchParams,
) -> SphereMatchResult {
    // 1. Candidate pool by radius compatibility.
    let mut candidates: Vec<(usize, usize)> = Vec::new();
    for (i, s) in source.iter().enumerate() {
        for (j, t) in target.iter().enumerate() {
            if (s.radius - t.radius).abs() <= params.radius_tol {
                candidates.push((i, j));
            }
        }
    }
    if candidates.len() < 3 {
        return SphereMatchResult {
            pairs: Vec::new(), pose: identity_4x4(), rmse: f64::INFINITY,
            candidates: candidates.len() as u32, iterations: 0,
        };
    }

    let tol2 = params.inlier_tol * params.inlier_tol;
    let mut best_inliers: Vec<(usize, usize)> = Vec::new();
    let mut best_r = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut best_t = [0.0f64; 3];

    // Deterministic LCG so the same input gives the same output
    // (helpful for testing + reproducibility).
    let mut rng_state: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut rand_usize = |limit: usize| -> usize {
        rng_state = rng_state.wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((rng_state >> 33) as usize) % limit
    };

    for _ in 0..params.iterations {
        // Pick 3 distinct candidate pairs (no source/target index reuse).
        let mut chosen: Vec<(usize, usize)> = Vec::with_capacity(3);
        let mut used_src: Vec<bool> = vec![false; source.len()];
        let mut used_tgt: Vec<bool> = vec![false; target.len()];
        for _ in 0..3 {
            for _attempt in 0..40 {
                let idx = rand_usize(candidates.len());
                let (a, b) = candidates[idx];
                if !used_src[a] && !used_tgt[b] {
                    chosen.push((a, b));
                    used_src[a] = true; used_tgt[b] = true;
                    break;
                }
            }
        }
        if chosen.len() < 3 { continue; }
        // Solve Kabsch for the trial transform.
        let pts: Vec<([f64; 3], [f64; 3])> = chosen.iter()
            .map(|&(a, b)| (source[a].center, target[b].center))
            .collect();
        // Reject a near-collinear seed, the way match_plane_pairs already
        // rejects a coplanar normal triple. Sphere targets down a
        // corridor or along a fence line land in a row often enough for
        // this to matter, and a collinear triple leaves the rotation
        // about that line unconstrained — Kabsch answers anyway, with a
        // zero residual, so the scoring below cannot reject it either.
        if kabsch_is_degenerate(&pts) { continue; }
        let (r, t) = kabsch_rt(&pts);
        // Score: count inliers over the FULL candidate set.
        let mut inliers: Vec<(usize, usize)> = Vec::new();
        let mut consumed_src: Vec<bool> = vec![false; source.len()];
        let mut consumed_tgt: Vec<bool> = vec![false; target.len()];
        // For each source sphere, find the closest transformed-vs-target
        // match within tolerance.
        for (i, s) in source.iter().enumerate() {
            let p = apply_rt(&r, &t, s.center);
            let mut best: Option<(usize, f64)> = None;
            for (j, tgt) in target.iter().enumerate() {
                if (s.radius - tgt.radius).abs() > params.radius_tol { continue; }
                let dx = p[0] - tgt.center[0];
                let dy = p[1] - tgt.center[1];
                let dz = p[2] - tgt.center[2];
                let d2 = dx * dx + dy * dy + dz * dz;
                if d2 <= tol2 && best.map_or(true, |(_, bd)| d2 < bd) {
                    best = Some((j, d2));
                }
            }
            if let Some((j, _)) = best {
                if !consumed_src[i] && !consumed_tgt[j] {
                    inliers.push((i, j));
                    consumed_src[i] = true;
                    consumed_tgt[j] = true;
                }
            }
        }
        if inliers.len() > best_inliers.len() {
            best_inliers = inliers;
            best_r = r; best_t = t;
        }
        if best_inliers.len() == candidates.len().min(source.len()).min(target.len()) { break; }
    }

    // Final Kabsch over EVERY inlier (refinement; the 3-point RANSAC
    // step only seeded the structure).
    let mut rmse = f64::INFINITY;
    let mut pose = identity_4x4();
    if best_inliers.len() >= 3 {
        let pts: Vec<([f64; 3], [f64; 3])> = best_inliers.iter()
            .map(|&(a, b)| (source[a].center, target[b].center))
            .collect();
        let (r, t) = kabsch_rt(&pts);
        best_r = r; best_t = t;
        // Residual.
        let mut sum_sq = 0.0;
        for &(a, b) in &best_inliers {
            let p = apply_rt(&r, &t, source[a].center);
            let d = [
                p[0] - target[b].center[0],
                p[1] - target[b].center[1],
                p[2] - target[b].center[2],
            ];
            sum_sq += d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        }
        rmse = (sum_sq / best_inliers.len() as f64).sqrt();
        pose = rt_to_mat4(&best_r, &best_t);
    }

    let pairs: Vec<MatchedSpherePair> = best_inliers.iter().map(|&(a, b)| {
        let s = &source[a];
        let t = &target[b];
        MatchedSpherePair {
            source_idx: a as u32, target_idx: b as u32,
            source_center: s.center, target_center: t.center,
            radius_mean: 0.5 * (s.radius + t.radius),
        }
    }).collect();
    let _ = best_r; let _ = best_t;

    SphereMatchResult {
        pairs, pose, rmse,
        candidates: candidates.len() as u32,
        iterations: params.iterations,
    }
}

#[cfg(test)]
mod sphere_match_tests {
    use super::*;

    fn sphere(c: [f64; 3], r: f64) -> SphereTarget {
        SphereTarget { center: c, radius: r, rmse: 0.001, n_points: 200 }
    }

    /// 4 spheres in source, the same 4 in target after a known
    /// rigid transform (rotation around Z + translation). The matcher
    /// should find all 4 pairs and recover the transform to mm
    /// precision.
    #[test]
    fn match_finds_known_transform() {
        let r_true = exp_map([0.0, 0.0, 7.0_f64.to_radians()]);
        let t_true = [2.0, 1.0, 0.0];
        let raw_src = [
            sphere([0.0, 0.0, 0.5], 0.075),
            sphere([3.0, 0.0, 0.5], 0.075),
            sphere([0.0, 3.0, 0.5], 0.075),
            sphere([3.0, 3.0, 0.5], 0.075),
        ];
        let target: Vec<SphereTarget> = raw_src.iter().map(|s| {
            let c = apply_rt(&r_true, &t_true, s.center);
            sphere(c, s.radius)
        }).collect();
        let res = match_sphere_pairs(&raw_src.to_vec(), &target, &SphereMatchParams::default());
        assert_eq!(res.pairs.len(), 4, "expected 4 inlier pairs, got {}", res.pairs.len());
        assert!(res.rmse < 1e-6, "RMSE {} should be near 0", res.rmse);
    }

    /// Outliers: 3 matching spheres + 2 random extra spheres on each
    /// side. Matcher returns the 3 real correspondences and ignores
    /// the noise.
    #[test]
    fn match_rejects_outliers() {
        let raw_src = vec![
            sphere([0.0, 0.0, 0.5], 0.075),
            sphere([5.0, 0.0, 0.5], 0.075),
            sphere([0.0, 5.0, 0.5], 0.075),
            sphere([10.0, 10.0, 0.5], 0.075),
            sphere([-3.0, 7.0, 0.5], 0.145), // different radius — radius_tol filters this
        ];
        // Real target = first 3 spheres translated, plus 2 extra random spheres.
        let mut target: Vec<SphereTarget> = (&raw_src[..3]).iter().map(|s| {
            sphere([s.center[0] + 1.0, s.center[1] + 2.0, s.center[2]], s.radius)
        }).collect();
        target.push(sphere([8.0, -4.0, 0.5], 0.075));
        target.push(sphere([12.0, 12.0, 0.5], 0.075));

        let res = match_sphere_pairs(&raw_src, &target, &SphereMatchParams::default());
        assert_eq!(res.pairs.len(), 3, "expected 3 inlier pairs, got {}", res.pairs.len());
        // All inliers should be among the first 3 source indices.
        for p in &res.pairs {
            assert!(p.source_idx < 3, "matched outlier source idx {}", p.source_idx);
        }
        assert!(res.rmse < 1e-6, "RMSE {} should be near 0", res.rmse);
    }
}

// =====================================================================
// Pairwise plane patch matching — RANSAC + Procrustes-on-normals
//
// Sphere matching solves the rigid-transform via Kabsch on three
// uniquely-identifiable centres. Plane matching is fundamentally more
// constrained:
//
//   • One plane match constrains 3 DOF (1 perpendicular distance + 2
//     rotational DOF — the third rotation is in the tangent plane).
//   • THREE plane matches with non-coplanar normals fully constrain a
//     rigid 6-DOF transform → minimum RANSAC seed.
//
// Algorithm (Mokroš 2018, modernised):
//
//   1. Candidate pool: every (P_a, P_b) source/target plane pair —
//      filtered by minimum planarity + area gates so noise patches
//      don't pollute the search.
//
//   2. RANSAC over plane-pair triples:
//      • Pick 3 distinct candidate pairs, each pair claiming
//        a different source AND target index.
//      • Require the 3 source normals to be linearly independent
//        (|det(N_a)| > 0.15) and same for targets — coplanar normal
//        sets yield a singular rotation.
//      • Solve the rigid transform from the triple (see below).
//
//   3. Closed-form transform from a triple:
//      • Rotation R by SVD on H = Σ n_a^k (n_b^k)^T, then R = V·U^T
//        with sign-flip on det. This is Kabsch without the centroid-
//        subtraction step — the normals are direction vectors, not
//        points.
//      • Translation t from 3 plane-incidence equations
//        (R·c_a^k + t − c_b^k) · n_b^k = 0  for k = 1..3
//        → 3×3 linear system N_b^T · t = (c_b^k − R·c_a^k) · n_b^k.
//
//   4. Scoring: apply (R, t) to every source plane. An inlier is a
//      plane pair where the transformed source normal is within the
//      angle tolerance AND the transformed source centroid lies on
//      the target plane within the distance tolerance.
//
//   5. Final refinement: re-solve over every inlier (least-squares
//      versions of the steps above) to tighten the transform.
//
// Output for MSA: each matched plane pair generates `samples_per_pair`
// point correspondences by sampling K points uniformly on the
// transformed source plane's tangent rectangle and projecting each
// onto the matching target plane along the target normal — a
// "plane-to-plane sliding" constraint that's equivalent to repeated
// point-to-plane correspondences in the MSA Jacobian.
// =====================================================================

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MatchedPlanePair {
    pub source_idx: u32,
    pub target_idx: u32,
    /// |n_source_after_transform · n_target| (1.0 = perfectly aligned).
    pub normal_dot: f64,
    /// Perpendicular distance from the transformed source centroid to
    /// the target plane (m). 0 = perfect incidence.
    pub centroid_distance: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaneMatchResult {
    pub pairs: Vec<MatchedPlanePair>,
    /// Refined source pose, 4×4 row-major (same shape as the Kabsch
    /// / ICP results so the caller's `coregister_apply` path takes
    /// it without translation).
    pub pose: Vec<f64>,
    /// Mean inlier residual = √(½·(angle_residual_var + distance_var)).
    /// Sub-cm on tight TLS data, sub-mm on synthetics.
    pub rmse: f64,
    /// Sampled point-pair correspondences per matched plane pair —
    /// suitable as direct input to coregister_msa.
    pub correspondences: Vec<MsaCorrespondence>,
    pub candidates: u32,
    pub iterations: u32,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaneMatchParams {
    /// Reject candidate planes with planarity above this. Default 0.01.
    pub max_planarity: f64,
    /// Reject candidate planes with extent below this (m). 0.125,
    /// from RIEGL's `planeExtractor.minSize` — the same "smallest
    /// patch worth using" length, though measured on the diagonal
    /// here (see PlaneExtractParams::min_size). Was 0.30.
    pub min_extent: f64,
    /// Inlier normal-alignment threshold (deg). RIEGL's
    /// `planeMatcher.maxAngleDifference` = 2.5°. Was 5°.
    pub normal_angle_tol_deg: f64,
    /// Inlier perpendicular distance threshold (m). RIEGL's
    /// `planeMatcher.maxDistance` = 0.25 m. Was 0.05 m, which is
    /// tighter than the pose error a registration starts from —
    /// candidates that should have matched were being rejected for
    /// being exactly as far apart as the misalignment being solved.
    pub centroid_dist_tol: f64,
    /// RANSAC iterations. Default 500.
    pub iterations: u32,
    /// Point correspondences sampled per matched plane pair.
    /// Default 4 — enough for MSA to constrain the residual but
    /// not so many that one mis-match dominates the result.
    pub samples_per_pair: u32,
}

impl Default for PlaneMatchParams {
    fn default() -> Self {
        Self {
            max_planarity: 0.01, min_extent: 0.125,
            normal_angle_tol_deg: 2.5, centroid_dist_tol: 0.25,
            iterations: 500, samples_per_pair: 4,
        }
    }
}

#[tauri::command]
pub fn coregister_match_planes(
    source: Vec<PlanePatch>,
    target: Vec<PlanePatch>,
    params: PlaneMatchParams,
) -> Result<PlaneMatchResult, String> {
    Ok(match_plane_pairs(&source, &target, &params))
}

pub fn match_plane_pairs(
    source: &[PlanePatch],
    target: &[PlanePatch],
    params: &PlaneMatchParams,
) -> PlaneMatchResult {
    // Filter source + target to substantive patches.
    let src_idx: Vec<usize> = source.iter().enumerate()
        .filter(|(_, p)| p.planarity <= params.max_planarity && p.extent >= params.min_extent)
        .map(|(i, _)| i).collect();
    let tgt_idx: Vec<usize> = target.iter().enumerate()
        .filter(|(_, p)| p.planarity <= params.max_planarity && p.extent >= params.min_extent)
        .map(|(i, _)| i).collect();
    if src_idx.len() < 3 || tgt_idx.len() < 3 {
        return PlaneMatchResult {
            pairs: Vec::new(), pose: identity_4x4(), rmse: f64::INFINITY,
            correspondences: Vec::new(),
            candidates: 0, iterations: 0,
        };
    }
    // Cartesian product of candidates — small enough on real scans
    // (typically <50 patches per scan) that a flat list is fine.
    let mut candidates: Vec<(usize, usize)> = Vec::with_capacity(src_idx.len() * tgt_idx.len());
    for &a in &src_idx {
        for &b in &tgt_idx { candidates.push((a, b)); }
    }
    let n_cand = candidates.len();

    let cos_tol = params.normal_angle_tol_deg.to_radians().cos();
    let dist_tol = params.centroid_dist_tol;

    let mut best_inliers: Vec<(usize, usize)> = Vec::new();
    let mut best_r = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut best_t = [0.0f64; 3];

    let mut rng_state: u64 = 0xA1B2_C3D4_E5F6_0708;
    let mut rand_usize = |limit: usize| -> usize {
        rng_state = rng_state.wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((rng_state >> 33) as usize) % limit.max(1)
    };

    for _ in 0..params.iterations {
        // Pick 3 distinct candidate pairs with non-coplanar normals on
        // BOTH sides.
        let mut chosen: Vec<(usize, usize)> = Vec::with_capacity(3);
        let mut used_src = vec![false; source.len()];
        let mut used_tgt = vec![false; target.len()];
        for _slot in 0..3 {
            for _attempt in 0..40 {
                let (a, b) = candidates[rand_usize(n_cand)];
                if !used_src[a] && !used_tgt[b] {
                    chosen.push((a, b));
                    used_src[a] = true; used_tgt[b] = true;
                    break;
                }
            }
        }
        if chosen.len() < 3 { continue; }
        // Linear independence check on both normal triples.
        let n_a = [source[chosen[0].0].normal, source[chosen[1].0].normal, source[chosen[2].0].normal];
        let n_b = [target[chosen[0].1].normal, target[chosen[1].1].normal, target[chosen[2].1].normal];
        if mat3_triple_det(&n_a).abs() < 0.15 { continue; }
        if mat3_triple_det(&n_b).abs() < 0.15 { continue; }
        // Solve transform from the triple.
        let Some((r, t)) = solve_transform_from_planes(
            &n_a, &n_b,
            &[source[chosen[0].0].centroid, source[chosen[1].0].centroid, source[chosen[2].0].centroid],
            &[target[chosen[0].1].centroid, target[chosen[1].1].centroid, target[chosen[2].1].centroid],
        ) else { continue; };
        // Score: greedy 1-to-1 inlier assignment.
        let mut consumed_src = vec![false; source.len()];
        let mut consumed_tgt = vec![false; target.len()];
        let mut inliers: Vec<(usize, usize)> = Vec::new();
        for &a in &src_idx {
            let n_t = apply_mat3(&r, source[a].normal);
            let c_t = apply_rt(&r, &t, source[a].centroid);
            // Find best target plane.
            let mut best: Option<(usize, f64)> = None;
            for &b in &tgt_idx {
                if consumed_tgt[b] { continue; }
                let dot = (n_t[0] * target[b].normal[0]
                    + n_t[1] * target[b].normal[1]
                    + n_t[2] * target[b].normal[2]).abs();
                if dot < cos_tol { continue; }
                let dx = c_t[0] - target[b].centroid[0];
                let dy = c_t[1] - target[b].centroid[1];
                let dz = c_t[2] - target[b].centroid[2];
                let perp = (dx * target[b].normal[0]
                    + dy * target[b].normal[1]
                    + dz * target[b].normal[2]).abs();
                if perp > dist_tol { continue; }
                // Score = normalised distance (smaller = better).
                if best.map_or(true, |(_, bp)| perp < bp) {
                    best = Some((b, perp));
                }
            }
            if let Some((b, _)) = best {
                if !consumed_src[a] {
                    inliers.push((a, b));
                    consumed_src[a] = true;
                    consumed_tgt[b] = true;
                }
            }
        }
        if inliers.len() > best_inliers.len() {
            best_inliers = inliers;
            best_r = r; best_t = t;
        }
    }

    // Final refinement: re-solve the rotation + translation over EVERY
    // inlier (least-squares form of the same equations the 3-pair
    // triple solves) so the output transform is tight.
    let mut rmse = f64::INFINITY;
    let mut pose = identity_4x4();
    let mut pairs_out: Vec<MatchedPlanePair> = Vec::new();
    let mut correspondences: Vec<MsaCorrespondence> = Vec::new();
    if best_inliers.len() >= 3 {
        // Re-fit rotation: SVD on H = Σ n_a^k (n_b^k)^T over all inliers.
        let n_a_list: Vec<[f64; 3]> = best_inliers.iter().map(|&(a, _)| source[a].normal).collect();
        let n_b_list: Vec<[f64; 3]> = best_inliers.iter().map(|&(_, b)| target[b].normal).collect();
        if let Some(r_final) = procrustes_normals(&n_a_list, &n_b_list) {
            // Re-fit translation: least-squares on N_b^T · t = Σ ...
            let mut a_mat = [[0.0f64; 3]; 3];
            let mut b_vec = [0.0f64; 3];
            for (&(a_i, b_i), n_b) in best_inliers.iter().zip(n_b_list.iter()) {
                let r_ca = apply_mat3(&r_final, source[a_i].centroid);
                let d = (target[b_i].centroid[0] - r_ca[0]) * n_b[0]
                    + (target[b_i].centroid[1] - r_ca[1]) * n_b[1]
                    + (target[b_i].centroid[2] - r_ca[2]) * n_b[2];
                for i in 0..3 {
                    for j in 0..3 { a_mat[i][j] += n_b[i] * n_b[j]; }
                    b_vec[i] += n_b[i] * d;
                }
            }
            if let Some(t_final) = solve_3x3(&a_mat, &b_vec) {
                best_r = r_final;
                best_t = t_final;
            }
        }
        // Build outputs.
        let mut sum_sq = 0.0;
        let mut sum_w: f64 = 0.0;
        for &(a_i, b_i) in &best_inliers {
            let n_t = apply_mat3(&best_r, source[a_i].normal);
            let c_t = apply_rt(&best_r, &best_t, source[a_i].centroid);
            let n_b = target[b_i].normal;
            let dot = (n_t[0] * n_b[0] + n_t[1] * n_b[1] + n_t[2] * n_b[2]).abs();
            let perp = (c_t[0] - target[b_i].centroid[0]) * n_b[0]
                + (c_t[1] - target[b_i].centroid[1]) * n_b[1]
                + (c_t[2] - target[b_i].centroid[2]) * n_b[2];
            sum_sq += perp * perp + (1.0 - dot).abs();
            sum_w += 1.0;
            pairs_out.push(MatchedPlanePair {
                source_idx: a_i as u32, target_idx: b_i as u32,
                normal_dot: dot, centroid_distance: perp.abs(),
            });
            // Sample MSA correspondences on the source plane's
            // tangent rectangle and project each onto the matching
            // target plane along the target normal. We sample on the
            // SOURCE plane in its LOCAL frame so the MSA call (which
            // expects p_local coords) can be fed directly.
            let s = &source[a_i];
            let (u_ax, v_ax) = perpendicular_basis(s.normal);
            // Sample in a square covering 50 % of the patch extent.
            let half = s.extent * 0.25;
            let step = if params.samples_per_pair > 1 { 1.0 / ((params.samples_per_pair as f64).sqrt().ceil()) } else { 1.0 };
            let grid_n = ((params.samples_per_pair as f64).sqrt().ceil() as usize).max(1);
            let mut emitted = 0u32;
            for ui in 0..grid_n {
                for vi in 0..grid_n {
                    if emitted >= params.samples_per_pair { break; }
                    let u_off = (-half) + (ui as f64 + 0.5) * step * 2.0 * half;
                    let v_off = (-half) + (vi as f64 + 0.5) * step * 2.0 * half;
                    let p_source_local = [
                        s.centroid[0] + u_ax[0] * u_off + v_ax[0] * v_off,
                        s.centroid[1] + u_ax[1] * u_off + v_ax[1] * v_off,
                        s.centroid[2] + u_ax[2] * u_off + v_ax[2] * v_off,
                    ];
                    // Project that point onto the target plane (via target
                    // normal) — closest point that lies in the target plane.
                    let q_world = apply_rt(&best_r, &best_t, p_source_local);
                    let d_perp = (q_world[0] - target[b_i].centroid[0]) * n_b[0]
                        + (q_world[1] - target[b_i].centroid[1]) * n_b[1]
                        + (q_world[2] - target[b_i].centroid[2]) * n_b[2];
                    let p_target = [
                        q_world[0] - d_perp * n_b[0],
                        q_world[1] - d_perp * n_b[1],
                        q_world[2] - d_perp * n_b[2],
                    ];
                    correspondences.push(MsaCorrespondence {
                        i: 0, j: 1,
                        p_i_local: p_source_local,
                        p_j_local: p_target,
                    });
                    emitted += 1;
                }
            }
        }
        rmse = (sum_sq / sum_w).sqrt();
        pose = rt_to_mat4(&best_r, &best_t);
    }

    PlaneMatchResult {
        pairs: pairs_out, pose, rmse, correspondences,
        candidates: n_cand as u32, iterations: params.iterations,
    }
}

/// 3×3 determinant of three column-stacked vectors. Used to gate
/// out coplanar normal triples — singular rotation otherwise.
fn mat3_triple_det(cols: &[[f64; 3]; 3]) -> f64 {
    let a = cols[0]; let b = cols[1]; let c = cols[2];
    a[0] * (b[1] * c[2] - b[2] * c[1])
        - a[1] * (b[0] * c[2] - b[2] * c[0])
        + a[2] * (b[0] * c[1] - b[1] * c[0])
}

/// Apply a 3×3 rotation to a vector.
fn apply_mat3(r: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        r[0][0] * v[0] + r[0][1] * v[1] + r[0][2] * v[2],
        r[1][0] * v[0] + r[1][1] * v[1] + r[1][2] * v[2],
        r[2][0] * v[0] + r[2][1] * v[1] + r[2][2] * v[2],
    ]
}

/// Procrustes rotation aligning 3D direction vectors (NOT points —
/// the centroid subtraction is skipped). Returns R such that R·a^k ≈
/// b^k for k = 1..K via SVD on H = Σ a^k (b^k)^T → R = V·U^T with
/// the sign correction on det.
fn procrustes_normals(a: &[[f64; 3]], b: &[[f64; 3]]) -> Option<[[f64; 3]; 3]> {
    if a.len() < 3 || a.len() != b.len() { return None; }
    let mut h = [[0.0f64; 3]; 3];
    for (av, bv) in a.iter().zip(b.iter()) {
        for i in 0..3 {
            for j in 0..3 { h[i][j] += av[i] * bv[j]; }
        }
    }
    let (u, _, v) = svd_3x3(&h);
    let mut r = [[0.0f64; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            let mut s = 0.0;
            for k in 0..3 { s += v[i][k] * u[j][k]; }
            r[i][j] = s;
        }
    }
    // det(R) should be +1; flip the sign of the smallest-singular
    // column of V if it's a reflection.
    if mat3_det(&r) < 0.0 {
        let mut v_corr = v;
        for i in 0..3 { v_corr[i][2] = -v_corr[i][2]; }
        for i in 0..3 {
            for j in 0..3 {
                let mut s = 0.0;
                for k in 0..3 { s += v_corr[i][k] * u[j][k]; }
                r[i][j] = s;
            }
        }
    }
    Some(r)
}

/// Solve a 3×3 linear system via Cramer's rule. Returns None on a
/// near-singular matrix.
fn solve_3x3(m: &[[f64; 3]; 3], b: &[f64; 3]) -> Option<[f64; 3]> {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det.abs() < 1e-15 { return None; }
    let inv = 1.0 / det;
    let x = (b[0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (b[1] * m[2][2] - m[1][2] * b[2])
        + m[0][2] * (b[1] * m[2][1] - m[1][1] * b[2])) * inv;
    let y = (m[0][0] * (b[1] * m[2][2] - m[1][2] * b[2])
        - b[0] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * b[2] - b[1] * m[2][0])) * inv;
    let z = (m[0][0] * (m[1][1] * b[2] - b[1] * m[2][1])
        - m[0][1] * (m[1][0] * b[2] - b[1] * m[2][0])
        + b[0] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])) * inv;
    Some([x, y, z])
}

/// Closed-form transform from a TRIPLE of plane-pair correspondences.
/// Returns (R, t) where R aligns the source normals to the target
/// normals (Procrustes) and t makes each transformed source centroid
/// lie on the matching target plane (3×3 linear system).
fn solve_transform_from_planes(
    n_a: &[[f64; 3]; 3], n_b: &[[f64; 3]; 3],
    c_a: &[[f64; 3]; 3], c_b: &[[f64; 3]; 3],
) -> Option<([[f64; 3]; 3], [f64; 3])> {
    let r = procrustes_normals(&[n_a[0], n_a[1], n_a[2]], &[n_b[0], n_b[1], n_b[2]])?;
    // Translation from
    //   (R·c_a^k + t − c_b^k) · n_b^k = 0
    //   → t · n_b^k = (c_b^k − R·c_a^k) · n_b^k
    // Stack the 3 equations into N_b^T · t = d.
    let mut mat = [[0.0f64; 3]; 3];
    let mut rhs = [0.0f64; 3];
    for k in 0..3 {
        let nb = n_b[k];
        let r_ca = apply_mat3(&r, c_a[k]);
        let d = (c_b[k][0] - r_ca[0]) * nb[0]
            + (c_b[k][1] - r_ca[1]) * nb[1]
            + (c_b[k][2] - r_ca[2]) * nb[2];
        for i in 0..3 { mat[k][i] = nb[i]; }
        rhs[k] = d;
    }
    solve_3x3(&mat, &rhs).map(|t| (r, t))
}

#[cfg(test)]
mod plane_match_tests {
    use super::*;

    fn plane(c: [f64; 3], n_raw: [f64; 3]) -> PlanePatch {
        let nl = (n_raw[0]*n_raw[0] + n_raw[1]*n_raw[1] + n_raw[2]*n_raw[2]).sqrt();
        let n = [n_raw[0] / nl, n_raw[1] / nl, n_raw[2] / nl];
        PlanePatch {
            centroid: c, normal: n,
            rmse: 0.001, extent: 2.0, area_estimate: 1.5,
            planarity: 0.001, n_points: 1000,
        }
    }

    /// 3 source planes (floor + two perpendicular walls) and the same
    /// 3 target planes after a known rigid transform. Matcher must
    /// find all 3 pairs and recover the transform to mm precision.
    #[test]
    fn match_finds_known_transform_three_planes() {
        let r_true = exp_map([0.0, 0.0, 5.0_f64.to_radians()]);
        let t_true = [1.5, 0.8, 0.0];
        let source = vec![
            plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]),  // floor
            plane([2.0, 0.0, 0.5], [0.0, 1.0, 0.0]),  // wall y=0
            plane([0.0, 2.0, 0.5], [1.0, 0.0, 0.0]),  // wall x=0
        ];
        let target: Vec<PlanePatch> = source.iter().map(|p| {
            let c = apply_rt(&r_true, &t_true, p.centroid);
            let n = apply_mat3(&r_true, p.normal);
            plane(c, n)
        }).collect();
        let res = match_plane_pairs(&source, &target, &PlaneMatchParams::default());
        assert_eq!(res.pairs.len(), 3, "expected 3 matched pairs, got {}", res.pairs.len());
        assert!(res.rmse < 1e-3, "RMSE {} should be ≤ 1 mm", res.rmse);
        // Verify pose recovers the true transform.
        let rec_t = [res.pose[3], res.pose[7], res.pose[11]];
        for i in 0..3 {
            assert!((rec_t[i] - t_true[i]).abs() < 1e-3,
                "t[{i}] {} ≠ {}", rec_t[i], t_true[i]);
        }
        // Each matched pair should produce >= 1 MSA correspondence.
        assert!(res.correspondences.len() >= 3,
            "expected ≥ 3 MSA correspondences (1 per plane), got {}", res.correspondences.len());
    }

    /// 3 real planes + 2 distractor source planes + 2 distractor
    /// target planes. The matcher should find the 3 real pairs and
    /// ignore the noise.
    #[test]
    fn match_rejects_distractor_planes() {
        let mut source = vec![
            plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
            plane([5.0, 0.0, 0.5], [0.0, 1.0, 0.0]),
            plane([0.0, 5.0, 0.5], [1.0, 0.0, 0.0]),
        ];
        // Distractors with normals far from any target.
        source.push(plane([10.0, 10.0, 0.0], [0.7, 0.7, 0.1]));
        source.push(plane([20.0, 0.0, 0.5], [-0.7, 0.7, 0.1]));
        let mut target: Vec<PlanePatch> = source[..3].iter().map(|p| {
            plane([p.centroid[0] + 1.0, p.centroid[1] + 2.0, p.centroid[2]], p.normal)
        }).collect();
        target.push(plane([15.0, 15.0, 5.0], [0.5, 0.5, 0.7]));
        target.push(plane([-10.0, 5.0, 0.5], [0.9, 0.1, 0.4]));
        let res = match_plane_pairs(&source, &target, &PlaneMatchParams::default());
        assert_eq!(res.pairs.len(), 3, "expected 3 inlier pairs, got {}", res.pairs.len());
        for p in &res.pairs {
            assert!(p.source_idx < 3, "matched distractor source {}", p.source_idx);
            assert!(p.target_idx < 3, "matched distractor target {}", p.target_idx);
        }
    }

    /// Procrustes-on-normals recovers a known rotation when given 3
    /// linearly independent source normals + their rotated images.
    #[test]
    fn procrustes_normals_recovers_rotation() {
        let r_true = exp_map([0.05, -0.03, 0.02]);
        let a = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let b: Vec<[f64; 3]> = a.iter().map(|v| apply_mat3(&r_true, *v)).collect();
        let r_rec = procrustes_normals(&a, &b).expect("solve");
        // Compare row-by-row to mm precision (Procrustes on
        // orthonormal-basis input is exact up to floating-point).
        for i in 0..3 { for j in 0..3 {
            assert!((r_rec[i][j] - r_true[i][j]).abs() < 1e-9,
                "R[{i}][{j}] {} ≠ {}", r_rec[i][j], r_true[i][j]);
        } }
    }
}


/// Timings for the claims this file makes about its own cost.
///
/// A number in a comment that nothing runs is a claim, not a
/// measurement — the normals step was documented as ~50 ms while
/// actually taking five times that. These print what they measure, and
/// assert only a bound loose enough not to flake on a busy machine but
/// tight enough to catch an order-of-magnitude regression.
#[cfg(test)]
mod timing_tests {
    use super::*;

    /// A plot-like target: most returns on the ground and on stems,
    /// which is what an ICP target actually is — not a uniform cube.
    fn scan_like(n: usize) -> Vec<[f64; 3]> {
        let mut seed = 12345u64;
        let mut rnd = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1); (seed >> 33) as f64 / 2147483648.0 };
        let mut v = Vec::with_capacity(n);
        for i in 0..n {
            if i % 3 == 0 {
                v.push([rnd() * 30.0 - 15.0, rnd() * 30.0 - 15.0, rnd() * 0.05]);
            } else {
                let t = (i % 40) as f64;
                let (cx, cy) = ((t * 7.3) % 30.0 - 15.0, (t * 11.7) % 30.0 - 15.0);
                let a = rnd() * std::f64::consts::TAU;
                v.push([cx + 0.15 * a.cos(), cy + 0.15 * a.sin(), rnd() * 18.0]);
            }
        }
        v
    }

    #[test]
    fn normals_timing() {
        let pts = scan_like(60_000);
        let grid = VoxelGrid::build(&pts, 0.5);
        let t = std::time::Instant::now();
        let n = compute_normals_pca(&pts, &grid, 12);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        println!("12-NN PCA normals, {} pts: {ms:.0} ms", n.len());
        assert_eq!(n.len(), pts.len());
        // Release on 4 cores measures ~57 ms, debug ~465 ms. Five
        // seconds only trips if the step has regressed by an order of
        // magnitude — e.g. by losing its parallelism again.
        assert!(ms < 5000.0, "normals took {ms:.0} ms");
    }

    /// Every normal must belong to the point at the same index.
    ///
    /// `grid.knn` returns indices into the SAME slice, so the function
    /// only works when the result is read positionally — and
    /// `par_iter().map().collect()` preserving order is what makes that
    /// safe after parallelising. A reordering would attach each normal
    /// to the wrong point, which no downstream check would notice: every
    /// normal is individually plausible.
    ///
    /// Two patches far apart with perpendicular orientations make that
    /// visible. A horizontal sheet must give ±z and a vertical one ±x,
    /// so a swap is unmistakable.
    #[test]
    fn each_normal_belongs_to_the_point_at_its_own_index() {
        let mut pts: Vec<[f64; 3]> = Vec::new();
        // Patch A: horizontal, at the origin. Normal ≈ ±z.
        for i in 0..30 { for j in 0..30 {
            pts.push([i as f64 * 0.05, j as f64 * 0.05, 0.0]);
        }}
        let n_a = pts.len();
        // Patch B: vertical (in the y–z plane), 50 m away. Normal ≈ ±x.
        for i in 0..30 { for j in 0..30 {
            pts.push([50.0, i as f64 * 0.05, j as f64 * 0.05]);
        }}

        let grid = VoxelGrid::build(&pts, 0.5);
        let n = compute_normals_pca(&pts, &grid, 12);
        assert_eq!(n.len(), pts.len());

        for (i, v) in n.iter().enumerate() {
            if !v[0].is_finite() { continue; }
            if i < n_a {
                assert!(v[2].abs() > 0.99, "point {i} is on the horizontal patch, normal {v:?}");
            } else {
                assert!(v[0].abs() > 0.99, "point {i} is on the vertical patch, normal {v:?}");
            }
        }
        // And the run is not all-NaN, which would pass the loop vacuously.
        assert!(n.iter().filter(|v| v[0].is_finite()).count() > pts.len() / 2);
    }
}