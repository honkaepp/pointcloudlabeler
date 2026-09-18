// E57 preprocessing commands.
//
// E57 (ASTM E2807) is the universal interchange format for terrestrial
// and mobile laser scanning. Every major vendor (FARO Focus / Orbis,
// Leica BLK360 / RTC360 / Cyclone, Trimble X7 / X9, NavVis VLX, Emesent
// Hovermap / Aura, XGRIDS Lixel, GreenValley LiDAR360) can export E57
// from their processing software, so one importer covers a wide swath
// of the Preprocessing module without per-vendor SDKs.
//
// Unlike the Riegl importer (which is metadata-only until rdblib lands),
// E57 is fully pure-Rust here: we read both metadata AND point bytes via
// the `e57` crate (MIT, no FFI, no unsafe). `e57_export_region` actually
// produces a LAS / LAZ.
//
// What's here:
//  ✓ List + import — parse the per-scan metadata (name, guid, point
//    count, pose) and persist a manifest mirroring the Riegl shape so
//    the same Preprocessing scan-position UI can render it.
//  ✓ Export region — read points from selected scans, apply each scan's
//    pose to put them in a shared world frame, optionally crop to a
//    world-coord bbox, write a LAS / LAZ. The Editor module can then
//    import the result as an octree like any other cloud.
//
// What's NOT here (deliberately):
//  - Co-registration tools (manual 3-point alignment + ICP). Planned as
//    a follow-up once we have multiple registered scan positions to
//    operate on; lives in its own commands.

use tauri::State;

use crate::state::AppState;
use std::fs::{create_dir_all, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use e57::{CartesianCoordinate, E57Reader, Transform};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Window};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct E57ProjectSummary {
    pub id: String,
    pub source_path: String,
    pub name: String,
    /// E57 file's top-level GUID (from the `e57Root.guid` XML element).
    pub guid: Option<String>,
    /// Library that wrote the file (for diagnostics — "FARO SCENE",
    /// "Cyclone REGISTER 360", ...). Some writers leave this blank.
    pub library_version: Option<String>,
    /// Free-form coordinate-reference metadata the writer stored (often a
    /// WKT string for projected CRS — surfaced as-is, no parsing).
    pub coordinate_metadata: Option<String>,
    pub scan_positions: Vec<E57ScanPosition>,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct E57ScanPosition {
    /// PointCloudLabeler-side stable id (`sp_000` … `sp_NNN`, by file order).
    pub id: String,
    /// Display name from the E57 (often "Scan 001" / "Station A"). Falls
    /// back to the id when the file has no name.
    pub name: String,
    /// E57's per-scan guid, if present.
    pub guid: Option<String>,
    pub point_count: u64,
    /// 4×4 SOP-equivalent (per-scan local → world / project frame),
    /// row-major. Built from the E57 `pose` element (quaternion +
    /// translation). Identity when the scan has no pose stored.
    pub pose: Vec<f64>,
    /// Bbox in the scan's LOCAL frame (pre-pose), if the writer recorded
    /// CartesianBounds. Used by the UI as a hint; the user's bbox crop
    /// is interpreted in WORLD coords (post-pose).
    pub local_bounds: Option<[f64; 6]>,
    /// Centroid in WORLD coords (post-pose). Useful for the map / table.
    pub world_centre: Option<[f64; 3]>,
    pub has_cartesian: bool,
    pub has_spherical: bool,
    pub has_intensity: bool,
    pub has_color: bool,
}

const MANIFEST_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    summary: E57ProjectSummary,
}

// --- progress channel ------------------------------------------------

#[derive(Serialize, Clone, Copy)]
struct ProgressMsg<'a> {
    stage: &'a str,
    pct: f32,
}

fn emit_progress(window: &Window, pct: f32) {
    let _ = window.emit("e57-progress", ProgressMsg { stage: "e57", pct });
}

// --- public commands ------------------------------------------------

#[tauri::command]
pub fn e57_list_projects(project_folder: String) -> Result<Vec<E57ProjectSummary>, String> {
    let dir = Path::new(&project_folder).join("preprocessing").join("e57");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<E57ProjectSummary> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read e57 dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = path.join("manifest.json");
        let Ok(bytes) = std::fs::read(&manifest) else { continue; };
        let Ok(m) = serde_json::from_slice::<Manifest>(&bytes) else { continue; };
        out.push(m.summary);
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub fn e57_import_project(
    project_folder: String,
    source_path: String,
    name: String,
) -> Result<E57ProjectSummary, String> {
    let src = Path::new(&source_path);
    if !src.is_file() {
        return Err(format!(
            "Not a file: {source_path}. An E57 dataset is a single .e57 file.",
        ));
    }

    let reader = E57Reader::from_file(src).map_err(|e| format!("open E57: {e}"))?;
    let file_guid = {
        let g = reader.guid().to_string();
        if g.is_empty() { None } else { Some(g) }
    };
    let library_version = reader.library_version().map(|s| s.to_string());
    let coordinate_metadata = reader.coordinate_metadata().map(|s| s.to_string());

    let mut scan_positions: Vec<E57ScanPosition> = Vec::new();
    for (i, pc) in reader.pointclouds().iter().enumerate() {
        let id = format!("sp_{i:03}");
        let name = pc.name.clone().unwrap_or_else(|| id.clone());
        let pose = transform_to_row_major(pc.transform.as_ref());
        let local_bounds = pc.cartesian_bounds.as_ref().and_then(|b| {
            // Only return a usable bbox if every face is set — otherwise
            // the UI can't draw it. Partially-bounded files exist; we
            // skip the hint there.
            match (b.x_min, b.x_max, b.y_min, b.y_max, b.z_min, b.z_max) {
                (Some(xn), Some(xx), Some(yn), Some(yx), Some(zn), Some(zx)) => {
                    Some([xn, xx, yn, yx, zn, zx])
                }
                _ => None,
            }
        });
        let world_centre = local_bounds.map(|b| {
            let cx = 0.5 * (b[0] + b[1]);
            let cy = 0.5 * (b[2] + b[3]);
            let cz = 0.5 * (b[4] + b[5]);
            // Apply pose to the local centroid to get world coords.
            apply_pose_4x4(&pose, [cx, cy, cz])
        });
        scan_positions.push(E57ScanPosition {
            id,
            name,
            guid: pc.guid.clone(),
            point_count: pc.records,
            pose,
            local_bounds,
            world_centre,
            has_cartesian: pc.has_cartesian(),
            has_spherical: pc.has_spherical(),
            has_intensity: pc.has_intensity(),
            has_color: pc.has_color(),
        });
    }

    let id = safe_folder_name(&name);
    let target = Path::new(&project_folder)
        .join("preprocessing")
        .join("e57")
        .join(&id);
    create_dir_all(&target).map_err(|e| format!("create target dir: {e}"))?;

    let summary = E57ProjectSummary {
        id: id.clone(),
        source_path: source_path.clone(),
        name: name.clone(),
        guid: file_guid,
        library_version,
        coordinate_metadata,
        scan_positions,
        updated_at: now_ms(),
    };
    write_manifest(&target, &summary)?;
    Ok(summary)
}

#[tauri::command]
pub fn e57_remove_project(project_folder: String, e57_id: String) -> Result<(), String> {
    // One path component, not a path: this is joined onto the
    // preprocessing directory, and a join confines nothing.
    // See fsgrant::safe_component.
    crate::fsgrant::safe_component(&e57_id)?;
    let dir = Path::new(&project_folder)
        .join("preprocessing")
        .join("e57")
        .join(&e57_id);
    if !dir.is_dir() {
        return Err(format!("not a registered E57 project: {e57_id}"));
    }
    if !dir.join("manifest.json").is_file() {
        return Err(format!("refusing to remove '{e57_id}' — no manifest.json"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("remove: {e}"))?;
    Ok(())
}

/// World-coord (post-pose) crop bbox. Each axis is optional.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct E57ExportBbox {
    pub x_min: Option<f64>,
    pub x_max: Option<f64>,
    pub y_min: Option<f64>,
    pub y_max: Option<f64>,
    pub z_min: Option<f64>,
    pub z_max: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E57ExportResult {
    pub out_path: String,
    pub point_count: u64,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn e57_export_region(
    state: State<'_, AppState>,
    window: Window,
    project_folder: String,
    e57_id: String,
    scan_position_ids: Vec<String>,
    bbox: E57ExportBbox,
    out_path: String,
) -> Result<E57ExportResult, String> {
    // One path component, not a path: this is joined onto the
    // preprocessing directory, and a join confines nothing.
    // See fsgrant::safe_component.
    crate::fsgrant::safe_component(&e57_id)?;
    // The renderer names this file; it is only allowed to name one the
    // user chose in a save dialog, or one inside the open project. See
    // fsgrant.rs — every write out of this application goes through it.
    let out_path = state
        .authorise_path(&out_path)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    // Resolve the manifest first so we know the source path + which
    // scan indices the picked ids map to. This is fast (no file open
    // yet) so we do it on the async runtime before jumping to the
    // blocking thread that does the actual work.
    let manifest_dir = Path::new(&project_folder)
        .join("preprocessing")
        .join("e57")
        .join(&e57_id);
    let manifest_bytes = std::fs::read(manifest_dir.join("manifest.json"))
        .map_err(|e| format!("read manifest.json: {e}"))?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("parse manifest.json: {e}"))?;
    let want: Vec<usize> = manifest
        .summary
        .scan_positions
        .iter()
        .enumerate()
        .filter(|(_, sp)| scan_position_ids.iter().any(|w| w == &sp.id))
        .map(|(i, _)| i)
        .collect();
    if want.is_empty() {
        return Err("No scan positions selected.".into());
    }
    let source_path = manifest.summary.source_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        run_e57_export(&window, &source_path, &want, &bbox, &out_path)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn run_e57_export(
    window: &Window,
    source_path: &str,
    scan_indices: &[usize],
    bbox: &E57ExportBbox,
    out_path: &str,
) -> Result<E57ExportResult, String> {
    use las::{Builder, Color as LasColor, Point as LasPoint, Transform as LasTransform, Vector, Writer};
    use las::point::Format;

    emit_progress(window, 0.0);

    let mut reader = E57Reader::from_file(Path::new(source_path))
        .map_err(|e| format!("open {source_path}: {e}"))?;

    // -- Pass 1: pick a sensible LAS scale + offset --
    //
    // LAS stores point coords as i32 plus a per-axis (scale, offset)
    // affine: world = i32 * scale + offset. With scale=1mm (0.001) the
    // i32 range is ~±2 100 km from the offset — fine for any real
    // survey. The offset just needs to be near the data center so the
    // ints stay well-bounded. We seed it from the union of selected
    // scans' world-bbox centroids: cheap (metadata only) and works
    // even when the user crops to a tiny region.
    let pointclouds = reader.pointclouds();
    let mut bbox_seed: Option<[f64; 6]> = None;
    for &idx in scan_indices {
        let pc = pointclouds.get(idx).ok_or_else(|| format!("scan index {idx} out of range"))?;
        let pose = transform_to_row_major(pc.transform.as_ref());
        if let Some(b) = pc.cartesian_bounds.as_ref() {
            if let (Some(xn), Some(xx), Some(yn), Some(yx), Some(zn), Some(zx)) =
                (b.x_min, b.x_max, b.y_min, b.y_max, b.z_min, b.z_max)
            {
                // Apply pose to all 8 corners — rotation can swap which
                // local corner becomes the world min/max.
                for &(x, y, z) in &[
                    (xn, yn, zn), (xx, yn, zn), (xn, yx, zn), (xx, yx, zn),
                    (xn, yn, zx), (xx, yn, zx), (xn, yx, zx), (xx, yx, zx),
                ] {
                    let w = apply_pose_4x4(&pose, [x, y, z]);
                    let cur = bbox_seed.get_or_insert([w[0], w[0], w[1], w[1], w[2], w[2]]);
                    cur[0] = cur[0].min(w[0]); cur[1] = cur[1].max(w[0]);
                    cur[2] = cur[2].min(w[1]); cur[3] = cur[3].max(w[1]);
                    cur[4] = cur[4].min(w[2]); cur[5] = cur[5].max(w[2]);
                }
            }
        }
    }
    // Fall back to the origin when no scan carried cartesian_bounds —
    // happens for spherical-only files. The i32 range with 1mm scale
    // is plenty even centered on (0,0,0) for plot-scale TLS work.
    let (ox, oy, oz) = if let Some(b) = bbox_seed {
        // Round the offset to whole metres for human-readable LAS
        // headers; nothing about the math depends on this.
        (
            ((b[0] + b[1]) * 0.5).round(),
            ((b[2] + b[3]) * 0.5).round(),
            ((b[4] + b[5]) * 0.5).round(),
        )
    } else {
        (0.0, 0.0, 0.0)
    };

    // -- Build the LAS / LAZ writer. --
    // Point format 2 = legacy color + intensity, no GPS time — the right
    // fit for static TLS scans where time of acquisition isn't useful.
    let mut builder = Builder::from((1, 4));
    builder.point_format = Format::new(2).map_err(|e| format!("las format: {e}"))?;
    builder.transforms = Vector {
        x: LasTransform { scale: 0.001, offset: ox },
        y: LasTransform { scale: 0.001, offset: oy },
        z: LasTransform { scale: 0.001, offset: oz },
    };
    builder.generating_software = "PointCloudLabeler — E57 preprocessing".to_string();
    // The E57 header often states its coordinate system as WKT. It was
    // read, shown in the scan list, and then discarded — so the octree
    // built from this LAS arrived with no CRS and the user had to
    // re-derive one from a truncated WKT string. Carried through as a
    // GeoKey VLR, which the octree importer reads back (see
    // octree::crs_from_las_vlrs). Nothing is written when the WKT states
    // no usable code: an unrecorded CRS the user can supply, a wrong one
    // they cannot notice.
    if let Some(code) = reader.coordinate_metadata()
        .and_then(super::crs::epsg_from_wkt)
    {
        if let Some(vlr) = super::octree::crs_vlr_for_las_crate(code) {
            builder.vlrs.push(vlr);
        }
    }
    let header = builder.into_header().map_err(|e| format!("build las header: {e}"))?;
    let mut writer = Writer::from_path(out_path, header)
        .map_err(|e| format!("create {out_path}: {e}"))?;

    // -- Pass 2: stream points. --
    let approx_total: u64 = scan_indices
        .iter()
        .map(|&i| pointclouds.get(i).map(|pc| pc.records).unwrap_or(0))
        .sum();
    let mut written: u64 = 0;
    let mut read: u64 = 0;
    let last_pct_emit = std::cell::Cell::new(0.0f32);
    let report = |read: u64| {
        if approx_total == 0 { return; }
        let pct = (read as f32 / approx_total as f32).clamp(0.0, 0.99);
        if pct - last_pct_emit.get() >= 0.01 {
            emit_progress(window, pct);
            last_pct_emit.set(pct);
        }
    };

    for (scan_no, &idx) in scan_indices.iter().enumerate() {
        let pc = pointclouds.get(idx).ok_or_else(|| format!("scan index {idx} out of range"))?.clone();
        let mut iter = reader
            .pointcloud_simple(&pc)
            .map_err(|e| format!("open scan {}: {e}", pc.name.as_deref().unwrap_or("?")))?;
        // Project the points into the shared world frame and normalise
        // intensity / colour to [0, 1] so we can rescale them to LAS u16
        // without per-file scaling games. Spherical-only scans get
        // converted to cartesian on the fly.
        iter.spherical_to_cartesian(true);
        iter.apply_pose(true);
        iter.normalize_intensity(true);
        iter.normalize_color(true);

        for point in iter {
            let p = point.map_err(|e| format!("read point: {e}"))?;
            read += 1;
            if read & 0xFFFF == 0 { report(read); }
            let (x, y, z) = match p.cartesian {
                CartesianCoordinate::Valid { x, y, z } => (x, y, z),
                _ => continue,
            };
            // World-coord bbox crop. Any axis left unset = no clip.
            if let Some(v) = bbox.x_min { if x < v { continue; } }
            if let Some(v) = bbox.x_max { if x > v { continue; } }
            if let Some(v) = bbox.y_min { if y < v { continue; } }
            if let Some(v) = bbox.y_max { if y > v { continue; } }
            if let Some(v) = bbox.z_min { if z < v { continue; } }
            if let Some(v) = bbox.z_max { if z > v { continue; } }

            // intensity / colour: e57 hands them as f32 in [0,1]; LAS
            // wants u16. Clamp to keep header-out-of-range files sane.
            let intensity = p.intensity
                .map(|v| (v.clamp(0.0, 1.0) * 65535.0) as u16)
                .unwrap_or(0);
            let color = p.color.map(|c| LasColor {
                red: (c.red.clamp(0.0, 1.0) * 65535.0) as u16,
                green: (c.green.clamp(0.0, 1.0) * 65535.0) as u16,
                blue: (c.blue.clamp(0.0, 1.0) * 65535.0) as u16,
            });
            let mut lp = LasPoint {
                x, y, z,
                intensity,
                // Which scan this point came from, so a merged cloud
                // keeps its scan identity — see
                // pointqc::scan_position_psid.
                point_source_id: crate::commands::pointqc::scan_position_psid(scan_no),
                // ASPRS return numbers start at 1; Default gives 0, which every
            // strict validator flags on every point. These sources are
            // single-echo, so 1 of 1 is also the truthful value.
            return_number: 1,
            number_of_returns: 1,
            ..Default::default()
            };
            lp.color = color;
            writer.write_point(lp).map_err(|e| format!("write point: {e}"))?;
            written += 1;
        }
    }

    writer.close().map_err(|e| format!("close las/laz: {e}"))?;
    emit_progress(window, 1.0);
    Ok(E57ExportResult {
        out_path: out_path.to_string(),
        point_count: written,
    })
}

// --- helpers --------------------------------------------------------

/// Convert E57's pose (quaternion + translation) into a 4×4 row-major
/// transform compatible with our existing scan-position UI (which already
/// renders Riegl SOPs in the same shape).
fn transform_to_row_major(t: Option<&Transform>) -> Vec<f64> {
    let Some(t) = t else { return identity_4x4(); };
    let q = &t.rotation;
    let tr = &t.translation;
    // Normalise first. The formula below is `1 − 2(y²+z²)` on the
    // diagonal, which is a rotation only when |q| = 1 — a quaternion 1 %
    // long turns it into a 2 % scale plus a shear, and the result is no
    // longer a rotation at all.
    //
    // It also matters for agreement. The e57 crate applies the pose to
    // the POINTS using the general form `w²+x²−y²−z²`, while this matrix
    // is what the manifest's per-scan centroid and the world bbox behind
    // the LAS offset are built from. The two forms coincide exactly when
    // |q| = 1 and diverge otherwise, so without this the metadata would
    // describe a different rotation than the points received.
    //
    // A zero quaternion — which some writers emit meaning "no rotation"
    // — has no direction to normalise, so it becomes the identity.
    let n = (q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z).sqrt();
    // Explicitly NaN-safe: a NaN norm must take the identity path too.
    if n.is_nan() || n <= 1e-12 {
        return vec![
            1.0, 0.0, 0.0, tr.x,
            0.0, 1.0, 0.0, tr.y,
            0.0, 0.0, 1.0, tr.z,
            0.0, 0.0, 0.0, 1.0,
        ];
    }
    let q = e57::Quaternion { w: q.w / n, x: q.x / n, y: q.y / n, z: q.z / n };
    let q = &q;
    let xx = q.x * q.x;
    let yy = q.y * q.y;
    let zz = q.z * q.z;
    let xy = q.x * q.y;
    let xz = q.x * q.z;
    let yz = q.y * q.z;
    let wx = q.w * q.x;
    let wy = q.w * q.y;
    let wz = q.w * q.z;
    let r00 = 1.0 - 2.0 * (yy + zz);
    let r01 = 2.0 * (xy - wz);
    let r02 = 2.0 * (xz + wy);
    let r10 = 2.0 * (xy + wz);
    let r11 = 1.0 - 2.0 * (xx + zz);
    let r12 = 2.0 * (yz - wx);
    let r20 = 2.0 * (xz - wy);
    let r21 = 2.0 * (yz + wx);
    let r22 = 1.0 - 2.0 * (xx + yy);
    vec![
        r00, r01, r02, tr.x,
        r10, r11, r12, tr.y,
        r20, r21, r22, tr.z,
        0.0, 0.0, 0.0, 1.0,
    ]
}

fn identity_4x4() -> Vec<f64> {
    vec![
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
}

fn apply_pose_4x4(m: &[f64], p: [f64; 3]) -> [f64; 3] {
    if m.len() != 16 { return p; }
    [
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ]
}

fn write_manifest(dir: &Path, summary: &E57ProjectSummary) -> Result<(), String> {
    let m = Manifest { version: MANIFEST_VERSION, summary: summary.clone() };
    let bytes = serde_json::to_vec_pretty(&m).map_err(|e| format!("encode manifest: {e}"))?;
    let tmp = dir.join("manifest.json.tmp");
    {
        let mut f = File::create(&tmp).map_err(|e| format!("create manifest tmp: {e}"))?;
        f.write_all(&bytes).map_err(|e| format!("write manifest tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync manifest tmp: {e}"))?;
    }
    std::fs::rename(&tmp, dir.join("manifest.json")).map_err(|e| format!("rename manifest: {e}"))?;
    Ok(())
}

fn safe_folder_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    if s.is_empty() { s.push_str("e57_project"); }
    s.truncate(80);
    s
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Quiet the unused-import lint when PathBuf is only conditionally used.
#[allow(dead_code)]
fn _pathbuf_anchor(_p: PathBuf) {}

/// The pose maths, which decides where a scan sits in the world.
///
/// The e57 crate applies the pose to the POINTS. This module converts
/// the same quaternion itself, for the manifest's per-scan centroid and
/// for the world bbox the LAS offset is chosen from — so the two have to
/// agree, and a sign error here puts a scan's reported position
/// somewhere the points are not.
#[cfg(test)]
mod e57_pose_tests {
    use super::*;
    use e57::{Quaternion, Translation};

    fn xf(w: f64, x: f64, y: f64, z: f64, tx: f64, ty: f64, tz: f64) -> Transform {
        Transform {
            rotation: Quaternion { w, x, y, z },
            translation: Translation { x: tx, y: ty, z: tz },
        }
    }

    /// No transform at all is the identity, not a zeroed matrix.
    #[test]
    fn an_absent_transform_is_the_identity() {
        assert_eq!(transform_to_row_major(None), identity_4x4());
        let p = apply_pose_4x4(&transform_to_row_major(None), [3.0, -4.0, 5.0]);
        assert_eq!(p, [3.0, -4.0, 5.0]);
    }

    /// The identity quaternion must produce the identity rotation. A
    /// scan with no rotation but a translation moves without turning.
    #[test]
    fn the_identity_quaternion_only_translates() {
        let m = transform_to_row_major(Some(&xf(1.0, 0.0, 0.0, 0.0, 10.0, 20.0, 30.0)));
        assert_eq!(apply_pose_4x4(&m, [0.0, 0.0, 0.0]), [10.0, 20.0, 30.0]);
        let p = apply_pose_4x4(&m, [1.0, 2.0, 3.0]);
        assert!((p[0] - 11.0).abs() < 1e-12 && (p[1] - 22.0).abs() < 1e-12 && (p[2] - 33.0).abs() < 1e-12);
    }

    /// Known rotations, checked by where they send the basis vectors —
    /// the form a sign error cannot survive.
    #[test]
    fn known_rotations_send_the_axes_where_they_should() {
        let s = (0.5f64).sqrt(); // sin(45°) = cos(45°) for a 90° rotation
        // 90° about +Z: x → y, y → −x, z → z.
        let m = transform_to_row_major(Some(&xf(s, 0.0, 0.0, s, 0.0, 0.0, 0.0)));
        let ax = apply_pose_4x4(&m, [1.0, 0.0, 0.0]);
        let ay = apply_pose_4x4(&m, [0.0, 1.0, 0.0]);
        let az = apply_pose_4x4(&m, [0.0, 0.0, 1.0]);
        assert!((ax[0]).abs() < 1e-12 && (ax[1] - 1.0).abs() < 1e-12, "x → {ax:?}");
        assert!((ay[0] + 1.0).abs() < 1e-12 && (ay[1]).abs() < 1e-12, "y → {ay:?}");
        assert!((az[2] - 1.0).abs() < 1e-12, "z → {az:?}");

        // 90° about +X: y → z, z → −y.
        let m = transform_to_row_major(Some(&xf(s, s, 0.0, 0.0, 0.0, 0.0, 0.0)));
        let ay = apply_pose_4x4(&m, [0.0, 1.0, 0.0]);
        let az = apply_pose_4x4(&m, [0.0, 0.0, 1.0]);
        assert!((ay[2] - 1.0).abs() < 1e-12, "y → {ay:?}");
        assert!((az[1] + 1.0).abs() < 1e-12, "z → {az:?}");

        // 180° about +Y: x → −x, z → −z, y unchanged.
        let m = transform_to_row_major(Some(&xf(0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0)));
        let ax = apply_pose_4x4(&m, [1.0, 0.0, 0.0]);
        let ay = apply_pose_4x4(&m, [0.0, 1.0, 0.0]);
        assert!((ax[0] + 1.0).abs() < 1e-12, "x → {ax:?}");
        assert!((ay[1] - 1.0).abs() < 1e-12, "y → {ay:?}");
    }

    /// A rotation preserves lengths and angles and does not mirror. If
    /// the determinant came out −1 the scan would be reflected, which
    /// looks like a plausible cloud until it is compared to another one.
    #[test]
    fn the_rotation_is_orthonormal_and_not_a_reflection() {
        let mut seed = 3u64;
        let mut rnd = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1); (seed >> 33) as f64 / 2147483648.0 - 0.5 };
        for _ in 0..50 {
            let (a, b, c, d) = (rnd(), rnd(), rnd(), rnd());
            let n = (a * a + b * b + c * c + d * d).sqrt();
            if n < 1e-6 { continue; }
            let m = transform_to_row_major(Some(&xf(a / n, b / n, c / n, d / n, 0.0, 0.0, 0.0)));
            let r = |i: usize, j: usize| m[i * 4 + j];
            // Rows are unit length and mutually orthogonal.
            for i in 0..3 {
                let len = (0..3).map(|j| r(i, j) * r(i, j)).sum::<f64>().sqrt();
                assert!((len - 1.0).abs() < 1e-9, "row {i} length {len}");
                for k in (i + 1)..3 {
                    let dot: f64 = (0..3).map(|j| r(i, j) * r(k, j)).sum();
                    assert!(dot.abs() < 1e-9, "rows {i},{k} dot {dot}");
                }
            }
            let det = r(0, 0) * (r(1, 1) * r(2, 2) - r(1, 2) * r(2, 1))
                    - r(0, 1) * (r(1, 0) * r(2, 2) - r(1, 2) * r(2, 0))
                    + r(0, 2) * (r(1, 0) * r(2, 1) - r(1, 1) * r(2, 0));
            assert!((det - 1.0).abs() < 1e-9, "determinant {det} — the scan would be mirrored");
        }
    }

    /// Rotation happens about the scan's own origin, then the
    /// translation is added — not the other way round. Getting that
    /// backwards puts a scan the same distance away in the wrong
    /// direction.
    #[test]
    fn the_translation_is_applied_after_the_rotation() {
        let s = (0.5f64).sqrt();
        // 90° about Z, then move to (100, 0, 0).
        let m = transform_to_row_major(Some(&xf(s, 0.0, 0.0, s, 100.0, 0.0, 0.0)));
        // A point 1 m along local +x ends up 1 m along world +y FROM the
        // translated origin.
        let p = apply_pose_4x4(&m, [1.0, 0.0, 0.0]);
        assert!((p[0] - 100.0).abs() < 1e-12, "x {p:?}");
        assert!((p[1] - 1.0).abs() < 1e-12, "y {p:?}");
    }

    /// A quaternion that is not unit length must still give a rotation.
    ///
    /// The diagonal form used here is `1 − 2(y²+z²)`, which is a rotation
    /// only when |q| = 1: one 1 % too long turns it into a 2 % scale plus
    /// a shear. The e57 crate transforms the POINTS with the general
    /// form `w²+x²−y²−z²`, which coincides with this one exactly when the
    /// quaternion is unit and diverges otherwise — so an unnormalised
    /// pose would have the manifest's centroid and the LAS offset built
    /// from a different rotation than the points received.
    #[test]
    fn a_denormalised_quaternion_still_gives_a_rotation() {
        let s = (0.5f64).sqrt();
        let unit = transform_to_row_major(Some(&xf(s, 0.0, 0.0, s, 1.0, 2.0, 3.0)));
        for scale in [1.01f64, 0.9, 2.0, 1e-3] {
            let scaled = transform_to_row_major(Some(&xf(
                s * scale, 0.0, 0.0, s * scale, 1.0, 2.0, 3.0,
            )));
            for i in 0..16 {
                assert!(
                    (scaled[i] - unit[i]).abs() < 1e-9,
                    "|q| × {scale}: element {i} came out {} instead of {}", scaled[i], unit[i],
                );
            }
        }
    }

    /// A zero quaternion has no direction to normalise. Some writers
    /// emit one meaning "no rotation", so it must become the identity
    /// rather than a degenerate matrix that collapses the scan.
    #[test]
    fn a_zero_quaternion_is_the_identity() {
        let m = transform_to_row_major(Some(&xf(0.0, 0.0, 0.0, 0.0, 7.0, 8.0, 9.0)));
        assert_eq!(apply_pose_4x4(&m, [1.0, 2.0, 3.0]), [8.0, 10.0, 12.0]);
    }

    /// A malformed pose must leave the point alone rather than zero it —
    /// a scan at the origin looks like data, a missing scan does not.
    #[test]
    fn a_malformed_pose_passes_the_point_through() {
        assert_eq!(apply_pose_4x4(&[], [1.0, 2.0, 3.0]), [1.0, 2.0, 3.0]);
        assert_eq!(apply_pose_4x4(&[1.0, 0.0, 0.0], [1.0, 2.0, 3.0]), [1.0, 2.0, 3.0]);
    }
}
