// PTX / PTS preprocessing commands.
//
// PTX is Leica Cyclone's ASCII interchange format; PTS is its
// transform-less sibling. Both are published informally (no ISO/ASTM
// spec) but the schema is stable enough that every TLS vendor that
// touches Leica's ecosystem exports them: Cyclone REGISTER 360,
// Topcon MAGNET Collage, 3D Forest's input path, and Stonex's
// round-trip via CloudCompare all use PTX/PTS.
//
// Format summary (PTX):
//   line 1:      <ncols>
//   line 2:      <nrows>
//   lines 3-6:   scanner registered position + axis vectors X / Y / Z
//                (4 lines of 3 floats — redundant with the matrix
//                below, used for cross-checking the parse)
//   lines 7-10:  4×4 transformation matrix, COLUMN-MAJOR
//                (4 lines of 4 floats — same convention as RIEGL's
//                project.rsp SOP; we transpose into row-major to match
//                the rest of the codebase)
//   then:        ncols×nrows lines of point data
//                  - 3 cols: x y z
//                  - 4 cols: x y z intensity
//                  - 6 cols: x y z r g b
//                  - 7 cols: x y z intensity r g b
//   then:        another scan section header (multiple scans per file)
//
// Format summary (PTS):
//   line 1:      <total point count>
//   then:        point data, same column variants as PTX
//   (no transform — single scan, identity pose)
//
// What's here:
//  ✓ Import — walk the file, parse every scan section's header, count
//    points, record byte offsets so the export step can seek to each
//    section's point block without rescanning headers.
//  ✓ Export — read points from the selected sections, apply each
//    section's pose, optionally crop to a world-coord bbox, write
//    LAS / LAZ via the same las + laz crates the Editor exporter uses.

use tauri::State;

use crate::state::AppState;
use std::fs::{create_dir_all, File};
use std::io::{BufRead, BufReader, Seek, SeekFrom, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Window};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtxProjectSummary {
    pub id: String,
    pub source_path: String,
    pub name: String,
    /// Either "ptx" or "pts" — the parser detects this from the file
    /// extension and confirms it by sniffing the header shape.
    pub kind: String,
    pub scan_positions: Vec<PtxScanPosition>,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PtxScanPosition {
    pub id: String,
    pub name: String,
    pub point_count: u64,
    /// 4×4 SOP-equivalent (per-scan local → world), row-major. Identity
    /// for PTS files which carry no transform. Matches the same shape
    /// the Riegl / E57 panels render.
    pub pose: Vec<f64>,
    /// Whether the section carries intensity and/or RGB. Read off the
    /// first data line of the section.
    pub has_intensity: bool,
    pub has_color: bool,
    /// Byte offset into the source file where this section's point data
    /// (first data line after the header) starts. Lets the export step
    /// seek directly to the right block instead of re-walking the file.
    pub point_byte_offset: u64,
    /// Detected column count (3 / 4 / 6 / 7). Cached so the export
    /// doesn't re-sniff.
    pub columns_per_point: u8,
}

const MANIFEST_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    summary: PtxProjectSummary,
}

#[derive(Serialize, Clone, Copy)]
struct ProgressMsg<'a> {
    stage: &'a str,
    pct: f32,
}

fn emit_progress(window: &Window, pct: f32) {
    let _ = window.emit("ptx-progress", ProgressMsg { stage: "ptx", pct });
}

// --- public commands ------------------------------------------------

#[tauri::command]
pub fn ptx_list_projects(project_folder: String) -> Result<Vec<PtxProjectSummary>, String> {
    let dir = Path::new(&project_folder).join("preprocessing").join("ptx");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<PtxProjectSummary> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read ptx dir: {e}"))?;
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
pub async fn ptx_import_project(
    window: Window,
    project_folder: String,
    source_path: String,
    name: String,
) -> Result<PtxProjectSummary, String> {
    // The import walks the entire file (one scan = at most one full
    // sweep over its point lines so we can find where the next section
    // starts), so it can take a moment for big files. Run on the
    // blocking pool so we don't stall the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        run_ptx_import(&window, &project_folder, &source_path, &name)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[tauri::command]
pub fn ptx_remove_project(project_folder: String, ptx_id: String) -> Result<(), String> {
    // One path component, not a path: this is joined onto the
    // preprocessing directory, and a join confines nothing.
    // See fsgrant::safe_component.
    crate::fsgrant::safe_component(&ptx_id)?;
    let dir = Path::new(&project_folder)
        .join("preprocessing")
        .join("ptx")
        .join(&ptx_id);
    if !dir.is_dir() {
        return Err(format!("not a registered PTX project: {ptx_id}"));
    }
    if !dir.join("manifest.json").is_file() {
        return Err(format!("refusing to remove '{ptx_id}' — no manifest.json"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("remove: {e}"))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtxExportBbox {
    pub x_min: Option<f64>,
    pub x_max: Option<f64>,
    pub y_min: Option<f64>,
    pub y_max: Option<f64>,
    pub z_min: Option<f64>,
    pub z_max: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtxExportResult {
    pub out_path: String,
    pub point_count: u64,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn ptx_export_region(
    state: State<'_, AppState>,
    window: Window,
    project_folder: String,
    ptx_id: String,
    scan_position_ids: Vec<String>,
    bbox: PtxExportBbox,
    out_path: String,
) -> Result<PtxExportResult, String> {
    // One path component, not a path: this is joined onto the
    // preprocessing directory, and a join confines nothing.
    // See fsgrant::safe_component.
    crate::fsgrant::safe_component(&ptx_id)?;
    // The renderer names this file; it is only allowed to name one the
    // user chose in a save dialog, or one inside the open project. See
    // fsgrant.rs — every write out of this application goes through it.
    let out_path = state
        .authorise_path(&out_path)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let manifest_dir = Path::new(&project_folder)
        .join("preprocessing")
        .join("ptx")
        .join(&ptx_id);
    let manifest_bytes = std::fs::read(manifest_dir.join("manifest.json"))
        .map_err(|e| format!("read manifest.json: {e}"))?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("parse manifest.json: {e}"))?;

    let want: Vec<PtxScanPosition> = manifest
        .summary
        .scan_positions
        .iter()
        .filter(|sp| scan_position_ids.iter().any(|w| w == &sp.id))
        .cloned()
        .collect();
    if want.is_empty() {
        return Err("No scan positions selected.".into());
    }
    let source_path = manifest.summary.source_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        run_ptx_export(&window, &source_path, &want, &bbox, &out_path)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

// --- implementation -------------------------------------------------

fn run_ptx_import(
    window: &Window,
    project_folder: &str,
    source_path: &str,
    display_name: &str,
) -> Result<PtxProjectSummary, String> {
    let src = Path::new(source_path);
    if !src.is_file() {
        return Err(format!(
            "Not a file: {source_path}. A PTX / PTS dataset is a single ASCII text file.",
        ));
    }
    let kind = src
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| s == "ptx" || s == "pts")
        .ok_or_else(|| format!(
            "File extension must be .ptx or .pts: {source_path}",
        ))?;
    let file_size = std::fs::metadata(src).map_err(|e| format!("stat: {e}"))?.len();

    let raw = File::open(src).map_err(|e| format!("open {source_path}: {e}"))?;
    let mut file = BufReader::with_capacity(1 << 16, raw);
    let scan_positions = if kind == "ptx" {
        scan_ptx(window, &mut file, file_size)?
    } else {
        scan_pts(&mut file, file_size, display_name)?
    };
    emit_progress(window, 1.0);

    let id = safe_folder_name(display_name);
    let target = Path::new(project_folder)
        .join("preprocessing")
        .join("ptx")
        .join(&id);
    create_dir_all(&target).map_err(|e| format!("create target dir: {e}"))?;

    let summary = PtxProjectSummary {
        id: id.clone(),
        source_path: source_path.to_string(),
        name: display_name.to_string(),
        kind,
        scan_positions,
        updated_at: now_ms(),
    };
    write_manifest(&target, &summary)?;
    Ok(summary)
}

/// Walk every scan section in a PTX file. After each section header we
/// know the point count (rows × cols), so we read exactly that many
/// lines forward (without parsing them as numbers — just consuming
/// newlines) and the next bytes are either EOF or the next section's
/// `ncols` line.
fn scan_ptx<R: BufRead + Seek>(window: &Window, file: &mut R, file_size: u64) -> Result<Vec<PtxScanPosition>, String> {
    let mut out: Vec<PtxScanPosition> = Vec::new();
    // Use our own line-reading loop instead of BufRead::lines() so we
    // can track byte positions exactly (lines() owns the iterator).
    let mut header_buf = String::new();
    file.seek(SeekFrom::Start(0)).map_err(|e| format!("seek 0: {e}"))?;
    loop {
        // Try to read the section's ncols line; EOF here = clean end.
        header_buf.clear();
        let read = file.read_line(&mut header_buf).map_err(|e| format!("read header: {e}"))?;
        if read == 0 {
            break;
        }
        // Skip empty / whitespace-only trailing lines.
        if header_buf.trim().is_empty() {
            continue;
        }
        let ncols: u64 = header_buf.trim().parse().map_err(|_| format!(
            "expected scan-section ncols on line, got: {header_buf:?}"
        ))?;
        let nrows: u64 = read_int_line(file, "nrows")?;
        let position = read_vec3_line(file, "scanner position")?;
        let axis_x = read_vec3_line(file, "axis X")?;
        let axis_y = read_vec3_line(file, "axis Y")?;
        let axis_z = read_vec3_line(file, "axis Z")?;
        let _ = (axis_x, axis_y, axis_z); // cross-check vs matrix later; not stored.
        let mat_row_a = read_vec4_line(file, "matrix row 0")?;
        let mat_row_b = read_vec4_line(file, "matrix row 1")?;
        let mat_row_c = read_vec4_line(file, "matrix row 2")?;
        let mat_row_d = read_vec4_line(file, "matrix row 3")?;
        // PTX writes the matrix as 4 rows of 4 values, column-major
        // (same convention as RIEGL's project.rsp SOP). We transpose
        // into row-major for the rest of the codebase to consume.
        let raw_matrix = [
            mat_row_a[0], mat_row_a[1], mat_row_a[2], mat_row_a[3],
            mat_row_b[0], mat_row_b[1], mat_row_b[2], mat_row_b[3],
            mat_row_c[0], mat_row_c[1], mat_row_c[2], mat_row_c[3],
            mat_row_d[0], mat_row_d[1], mat_row_d[2], mat_row_d[3],
        ];
        let pose = transpose_4x4(&raw_matrix);
        // Cross-check: the transpose puts translation in (m[3], m[7],
        // m[11]) — should match the scanner position from line 3.
        // We only warn (not fail) — some writers leave the position
        // line as zero and only fill the matrix.
        let tr_x = pose[3];
        let tr_y = pose[7];
        let tr_z = pose[11];
        if (tr_x - position[0]).abs() + (tr_y - position[1]).abs() + (tr_z - position[2]).abs() > 1e-3
            && position[0].abs() + position[1].abs() + position[2].abs() > 0.0
        {
            // Mismatch — the file's matrix is probably stored row-major
            // (translation in column 3) instead of column-major. Use
            // the raw form straight from disk in that case.
            let alt_tr = [raw_matrix[3], raw_matrix[7], raw_matrix[11]];
            if (alt_tr[0] - position[0]).abs() + (alt_tr[1] - position[1]).abs() + (alt_tr[2] - position[2]).abs() < 1e-3 {
                // raw_matrix is already row-major; use it as-is.
                return scan_ptx_with_pose_layout(window, file, file_size, /* column_major = */ false);
            }
        }
        // Sniff the first data line to detect columns_per_point + the
        // section's point-block byte offset.
        let block_start = file.stream_position().map_err(|e| format!("stream_position: {e}"))?;
        let mut first_line = String::new();
        let first_read = file.read_line(&mut first_line).map_err(|e| format!("read first point: {e}"))?;
        let columns_per_point = if first_read > 0 {
            detect_columns(&first_line)
        } else {
            3
        };
        let has_intensity = matches!(columns_per_point, 4 | 7);
        let has_color = matches!(columns_per_point, 6 | 7);
        // Skip the remaining (rows × cols - 1) point lines so we land at
        // either EOF or the next section header.
        let total = nrows.saturating_mul(ncols);
        let to_skip = total.saturating_sub(1); // we already consumed line 1
        skip_lines(file, to_skip)?;
        let id = format!("sp_{:03}", out.len());
        let name = format!("Scan {}", out.len() + 1);
        out.push(PtxScanPosition {
            id,
            name,
            point_count: total,
            pose,
            has_intensity,
            has_color,
            point_byte_offset: block_start,
            columns_per_point,
        });
        // Progress: rough — based on current byte position over total.
        let pos = file.stream_position().unwrap_or(0);
        if file_size > 0 {
            emit_progress(window, (pos as f32 / file_size as f32).clamp(0.0, 0.99));
        }
    }
    Ok(out)
}

/// Retry path: same walker but stops transposing the matrix because
/// the file is using row-major storage. Called when the first attempt
/// detects the (rare) row-major variant.
fn scan_ptx_with_pose_layout<R: BufRead + Seek>(
    window: &Window,
    file: &mut R,
    file_size: u64,
    column_major: bool,
) -> Result<Vec<PtxScanPosition>, String> {
    let mut out: Vec<PtxScanPosition> = Vec::new();
    let mut header_buf = String::new();
    file.seek(SeekFrom::Start(0)).map_err(|e| format!("seek 0: {e}"))?;
    loop {
        header_buf.clear();
        let read = file.read_line(&mut header_buf).map_err(|e| format!("read header: {e}"))?;
        if read == 0 { break; }
        if header_buf.trim().is_empty() { continue; }
        let ncols: u64 = header_buf.trim().parse().map_err(|_| format!("expected ncols: {header_buf:?}"))?;
        let nrows: u64 = read_int_line(file, "nrows")?;
        let _ = read_vec3_line(file, "position")?;
        let _ = read_vec3_line(file, "axis X")?;
        let _ = read_vec3_line(file, "axis Y")?;
        let _ = read_vec3_line(file, "axis Z")?;
        let r0 = read_vec4_line(file, "matrix row 0")?;
        let r1 = read_vec4_line(file, "matrix row 1")?;
        let r2 = read_vec4_line(file, "matrix row 2")?;
        let r3 = read_vec4_line(file, "matrix row 3")?;
        let raw = [
            r0[0], r0[1], r0[2], r0[3],
            r1[0], r1[1], r1[2], r1[3],
            r2[0], r2[1], r2[2], r2[3],
            r3[0], r3[1], r3[2], r3[3],
        ];
        let pose = if column_major { transpose_4x4(&raw) } else { raw.to_vec() };
        let block_start = file.stream_position().map_err(|e| format!("stream_position: {e}"))?;
        let mut first_line = String::new();
        let first_read = file.read_line(&mut first_line).map_err(|e| format!("read first point: {e}"))?;
        let columns_per_point = if first_read > 0 { detect_columns(&first_line) } else { 3 };
        let has_intensity = matches!(columns_per_point, 4 | 7);
        let has_color = matches!(columns_per_point, 6 | 7);
        let total = nrows.saturating_mul(ncols);
        let to_skip = total.saturating_sub(1);
        skip_lines(file, to_skip)?;
        let id = format!("sp_{:03}", out.len());
        let name = format!("Scan {}", out.len() + 1);
        out.push(PtxScanPosition {
            id, name, point_count: total, pose,
            has_intensity, has_color,
            point_byte_offset: block_start, columns_per_point,
        });
        let pos = file.stream_position().unwrap_or(0);
        if file_size > 0 {
            emit_progress(window, (pos as f32 / file_size as f32).clamp(0.0, 0.99));
        }
    }
    Ok(out)
}

/// PTS = single scan, identity pose, no header transform. First line
/// is the total point count; subsequent lines are XYZ[I][RGB].
fn scan_pts<R: BufRead + Seek>(file: &mut R, _file_size: u64, display_name: &str) -> Result<Vec<PtxScanPosition>, String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| format!("seek 0: {e}"))?;
    let mut count_line = String::new();
    let read = file.read_line(&mut count_line).map_err(|e| format!("read count: {e}"))?;
    if read == 0 {
        return Err("PTS file is empty".into());
    }
    let total: u64 = count_line.trim().parse().map_err(|_| format!(
        "expected point count on line 1, got: {count_line:?}"
    ))?;
    let block_start = file.stream_position().map_err(|e| format!("stream_position: {e}"))?;
    let mut first_line = String::new();
    let first_read = file.read_line(&mut first_line).map_err(|e| format!("read first point: {e}"))?;
    let columns_per_point = if first_read > 0 { detect_columns(&first_line) } else { 3 };
    let has_intensity = matches!(columns_per_point, 4 | 7);
    let has_color = matches!(columns_per_point, 6 | 7);
    Ok(vec![PtxScanPosition {
        id: "sp_000".to_string(),
        name: display_name.to_string(),
        point_count: total,
        pose: identity_4x4(),
        has_intensity,
        has_color,
        point_byte_offset: block_start,
        columns_per_point,
    }])
}

fn run_ptx_export(
    window: &Window,
    source_path: &str,
    scans: &[PtxScanPosition],
    bbox: &PtxExportBbox,
    out_path: &str,
) -> Result<PtxExportResult, String> {
    use las::{Builder, Color as LasColor, Point as LasPoint, Transform as LasTransform, Vector, Writer};
    use las::point::Format;

    emit_progress(window, 0.0);

    // Pick a LAS offset near the data center. The pose translations
    // (column 3 of the row-major matrix) are the scanner positions in
    // world coords, so averaging them is a cheap good-enough hint.
    let (mut sx, mut sy, mut sz) = (0.0f64, 0.0f64, 0.0f64);
    for sp in scans {
        if sp.pose.len() == 16 {
            sx += sp.pose[3];
            sy += sp.pose[7];
            sz += sp.pose[11];
        }
    }
    let n = scans.len() as f64;
    let (ox, oy, oz) = if n > 0.0 {
        ((sx / n).round(), (sy / n).round(), (sz / n).round())
    } else {
        (0.0, 0.0, 0.0)
    };

    let mut builder = Builder::from((1, 4));
    builder.point_format = Format::new(2).map_err(|e| format!("las format: {e}"))?;
    builder.transforms = Vector {
        x: LasTransform { scale: 0.001, offset: ox },
        y: LasTransform { scale: 0.001, offset: oy },
        z: LasTransform { scale: 0.001, offset: oz },
    };
    builder.generating_software = "PointCloudLabeler — PTX/PTS preprocessing".to_string();
    let header = builder.into_header().map_err(|e| format!("build las header: {e}"))?;
    let mut writer = Writer::from_path(out_path, header)
        .map_err(|e| format!("create {out_path}: {e}"))?;

    let total: u64 = scans.iter().map(|s| s.point_count).sum();
    let mut written: u64 = 0;
    let mut read: u64 = 0;

    let mut file = BufReader::new(File::open(source_path)
        .map_err(|e| format!("open {source_path}: {e}"))?);

    for (scan_no, sp) in scans.iter().enumerate() {
        // Decide the intensity convention ONCE for this section, from
        // what it actually contains — see IntensityScale.
        let iscale = sniff_intensity_scale(
            &mut file, sp.point_byte_offset, sp.point_count, sp.columns_per_point,
        )?;
        file.seek(SeekFrom::Start(sp.point_byte_offset))
            .map_err(|e| format!("seek to {} for {}: {e}", sp.point_byte_offset, sp.name))?;
        let mut line = String::new();
        for _ in 0..sp.point_count {
            line.clear();
            let read_bytes = file.read_line(&mut line).map_err(|e| format!("read point line: {e}"))?;
            if read_bytes == 0 { break; }
            read += 1;
            if read & 0xFFFF == 0 && total > 0 {
                emit_progress(window, (read as f32 / total as f32).clamp(0.0, 0.99));
            }
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            let mut iter = trimmed.split_ascii_whitespace();
            let Some(x_s) = iter.next() else { continue; };
            let Some(y_s) = iter.next() else { continue; };
            let Some(z_s) = iter.next() else { continue; };
            let (Ok(lx), Ok(ly), Ok(lz)) = (x_s.parse::<f64>(), y_s.parse::<f64>(), z_s.parse::<f64>()) else { continue; };
            // Cyclone's "missing point" marker — drop it instead of
            // sticking a fake point at the origin.
            if lx == 0.0 && ly == 0.0 && lz == 0.0 {
                continue;
            }
            // Parse intensity / colour using the section's known layout.
            let (intensity, color) = match sp.columns_per_point {
                4 => {
                    let i_s = iter.next().unwrap_or("0");
                    let i = i_s.parse::<f64>().unwrap_or(0.0);
                    (iscale.map(i), None)
                }
                6 => {
                    let r = iter.next().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
                    let g = iter.next().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
                    let b = iter.next().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
                    (0u16, Some(rgb_to_u16(r, g, b)))
                }
                7 => {
                    let i_s = iter.next().unwrap_or("0");
                    let i = i_s.parse::<f64>().unwrap_or(0.0);
                    let r = iter.next().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
                    let g = iter.next().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
                    let b = iter.next().unwrap_or("0").parse::<f64>().unwrap_or(0.0);
                    (iscale.map(i), Some(rgb_to_u16(r, g, b)))
                }
                _ => (0u16, None),
            };

            // Apply the section's pose to put the point in the file's
            // shared world frame.
            let (wx, wy, wz) = apply_pose_4x4(&sp.pose, [lx, ly, lz]);

            if let Some(v) = bbox.x_min { if wx < v { continue; } }
            if let Some(v) = bbox.x_max { if wx > v { continue; } }
            if let Some(v) = bbox.y_min { if wy < v { continue; } }
            if let Some(v) = bbox.y_max { if wy > v { continue; } }
            if let Some(v) = bbox.z_min { if wz < v { continue; } }
            if let Some(v) = bbox.z_max { if wz > v { continue; } }

            let mut lp = LasPoint {
                x: wx, y: wy, z: wz,
                intensity,
                // Which section this point came from — see
                // pointqc::scan_position_psid.
                point_source_id: crate::commands::pointqc::scan_position_psid(scan_no),
                // ASPRS return numbers start at 1; Default gives 0, which every
            // strict validator flags on every point. These sources are
            // single-echo, so 1 of 1 is also the truthful value.
            return_number: 1,
            number_of_returns: 1,
            ..Default::default()
            };
            lp.color = color.map(|(r, g, b)| LasColor { red: r, green: g, blue: b });
            writer.write_point(lp).map_err(|e| format!("write point: {e}"))?;
            written += 1;
        }
    }

    writer.close().map_err(|e| format!("close las/laz: {e}"))?;
    emit_progress(window, 1.0);
    Ok(PtxExportResult {
        out_path: out_path.to_string(),
        point_count: written,
    })
}

// --- helpers --------------------------------------------------------

fn read_int_line<R: BufRead>(file: &mut R, what: &str) -> Result<u64, String> {
    let mut s = String::new();
    let n = file.read_line(&mut s).map_err(|e| format!("read {what}: {e}"))?;
    if n == 0 { return Err(format!("unexpected EOF reading {what}")); }
    s.trim().parse::<u64>().map_err(|_| format!("expected {what} integer, got: {s:?}"))
}

fn read_vec3_line<R: BufRead>(file: &mut R, what: &str) -> Result<[f64; 3], String> {
    let mut s = String::new();
    let n = file.read_line(&mut s).map_err(|e| format!("read {what}: {e}"))?;
    if n == 0 { return Err(format!("unexpected EOF reading {what}")); }
    let parts: Vec<f64> = s.split_ascii_whitespace().filter_map(|t| t.parse().ok()).collect();
    if parts.len() < 3 { return Err(format!("expected 3 floats for {what}, got: {s:?}")); }
    Ok([parts[0], parts[1], parts[2]])
}

fn read_vec4_line<R: BufRead>(file: &mut R, what: &str) -> Result<[f64; 4], String> {
    let mut s = String::new();
    let n = file.read_line(&mut s).map_err(|e| format!("read {what}: {e}"))?;
    if n == 0 { return Err(format!("unexpected EOF reading {what}")); }
    let parts: Vec<f64> = s.split_ascii_whitespace().filter_map(|t| t.parse().ok()).collect();
    if parts.len() < 4 { return Err(format!("expected 4 floats for {what}, got: {s:?}")); }
    Ok([parts[0], parts[1], parts[2], parts[3]])
}

fn detect_columns(line: &str) -> u8 {
    let count = line.split_ascii_whitespace().count();
    match count {
        3 => 3,
        4 => 4,
        6 => 6,
        7 => 7,
        // Defensive: round to nearest known shape so the export still
        // parses correctly even with a slightly off line.
        n if n >= 7 => 7,
        n if n >= 6 => 6,
        n if n >= 4 => 4,
        _ => 3,
    }
}

fn skip_lines<R: BufRead>(file: &mut R, count: u64) -> Result<(), String> {
    let mut buf = String::with_capacity(96);
    for _ in 0..count {
        buf.clear();
        let n = file.read_line(&mut buf).map_err(|e| format!("skip line: {e}"))?;
        if n == 0 { break; }
    }
    Ok(())
}

fn transpose_4x4(raw: &[f64; 16]) -> Vec<f64> {
    let mut out = vec![0.0f64; 16];
    for r in 0..4 {
        for c in 0..4 {
            out[r * 4 + c] = raw[c * 4 + r];
        }
    }
    out
}

fn identity_4x4() -> Vec<f64> {
    vec![
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]
}

fn apply_pose_4x4(m: &[f64], p: [f64; 3]) -> (f64, f64, f64) {
    if m.len() != 16 { return (p[0], p[1], p[2]); }
    (
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    )
}

/// Sample a scan section's intensity column to decide its convention.
///
/// Bounded: enough lines to see the range, not the whole section. Null
/// points (Cyclone's 0 0 0 marker) are skipped — they carry intensity 0
/// and would drag a signed file's minimum to a value it never really
/// reaches.
use super::pointscale::IntensityScale;

fn sniff_intensity_scale<R: BufRead + Seek>(
    file: &mut R, offset: u64, count: u64, columns_per_point: u8,
) -> Result<IntensityScale, String> {
    // Only columns 4 and 7 carry intensity at all.
    if columns_per_point != 4 && columns_per_point != 7 {
        return Ok(IntensityScale::Unit);
    }
    const SAMPLE: u64 = 200_000;
    file.seek(SeekFrom::Start(offset)).map_err(|e| format!("seek for intensity sniff: {e}"))?;
    let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut line = String::new();
    for _ in 0..count.min(SAMPLE) {
        line.clear();
        if file.read_line(&mut line).map_err(|e| format!("read for intensity sniff: {e}"))? == 0 { break; }
        let mut it = line.split_ascii_whitespace();
        let (Some(x), Some(y), Some(z), Some(i)) = (it.next(), it.next(), it.next(), it.next()) else { continue };
        let (Ok(x), Ok(y), Ok(z), Ok(i)) =
            (x.parse::<f64>(), y.parse::<f64>(), z.parse::<f64>(), i.parse::<f64>()) else { continue };
        if x == 0.0 && y == 0.0 && z == 0.0 { continue; }
        if !i.is_finite() { continue; }
        if i < min { min = i; }
        if i > max { max = i; }
    }
    Ok(IntensityScale::from_range(min, max))
}

/// PTX colour is conventionally 0..255 per channel. Convert to u16
/// LAS format by left-shifting (×257 = (x << 8) | x).
fn rgb_to_u16(r: f64, g: f64, b: f64) -> (u16, u16, u16) {
    let c = |v: f64| -> u16 {
        let v = v.clamp(0.0, 255.0);
        let i = v as u16;
        (i << 8) | i
    };
    (c(r), c(g), c(b))
}

fn write_manifest(dir: &Path, summary: &PtxProjectSummary) -> Result<(), String> {
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
    if s.is_empty() { s.push_str("ptx_project"); }
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

/// PTX has no tests, and its correctness rests entirely on conventions:
/// a column-major transform, a `0 0 0` null marker, and an intensity
/// column whose scale the format never states. Those are exactly the
/// things a later tidy-up breaks without noticing.
#[cfg(test)]
mod ptx_tests {
    use super::*;
    use std::io::Cursor;

    // ---- Intensity ----

    /// The one property the old per-value guess did not have.
    ///
    /// Whatever convention a file uses, a brighter return must come out
    /// brighter. The previous code branched on each value's own sign and
    /// magnitude, so −0.10 mapped to 29490 while +0.10 mapped to 6553,
    /// and 1.001 mapped to 32 where 1.000 mapped to 65535.
    #[test]
    fn every_scale_is_monotonic() {
        for (scale, samples) in [
            (IntensityScale::Signed, vec![-1.0, -0.9, -0.5, -0.1, 0.0, 0.1, 0.5, 0.9, 1.0]),
            (IntensityScale::Unit, vec![0.0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0]),
            (IntensityScale::Legacy2047, vec![0.0, 1.0, 100.0, 1023.0, 2047.0]),
            (IntensityScale::Raw, vec![0.0, 1.0, 1000.0, 32768.0, 65535.0]),
        ] {
            let mut prev = 0u16;
            for (k, v) in samples.iter().enumerate() {
                let out = scale.map(*v);
                if k > 0 {
                    assert!(out >= prev, "{scale:?}: {v} mapped to {out}, below the previous {prev}");
                }
                prev = out;
            }
        }
    }

    /// Each convention spans the full output range, so no file is
    /// squeezed into a corner of it.
    #[test]
    fn every_scale_uses_the_whole_range() {
        assert_eq!(IntensityScale::Signed.map(-1.0), 0);
        assert_eq!(IntensityScale::Signed.map(1.0), 65535);
        assert_eq!(IntensityScale::Signed.map(0.0), 32768);
        assert_eq!(IntensityScale::Unit.map(0.0), 0);
        assert_eq!(IntensityScale::Unit.map(1.0), 65535);
        assert_eq!(IntensityScale::Legacy2047.map(0.0), 0);
        assert_eq!(IntensityScale::Legacy2047.map(2047.0), 65535);
        assert_eq!(IntensityScale::Raw.map(65535.0), 65535);
        // Out of range clamps rather than wrapping.
        assert_eq!(IntensityScale::Unit.map(-5.0), 0);
        assert_eq!(IntensityScale::Raw.map(1e9), 65535);
        assert_eq!(IntensityScale::Unit.map(f64::NAN), 0);
    }

    /// The convention is chosen from what the file contains, which is
    /// the only place the information exists.
    #[test]
    fn the_convention_comes_from_the_observed_range() {
        assert_eq!(IntensityScale::from_range(-1.0, 1.0), IntensityScale::Signed);
        assert_eq!(IntensityScale::from_range(-0.4, 0.8), IntensityScale::Signed);
        assert_eq!(IntensityScale::from_range(0.0, 1.0), IntensityScale::Unit);
        assert_eq!(IntensityScale::from_range(0.0, 2047.0), IntensityScale::Legacy2047);
        assert_eq!(IntensityScale::from_range(0.0, 60000.0), IntensityScale::Raw);
        // An empty section leaves min/max infinite; pick something safe
        // rather than propagate that into the mapping.
        assert_eq!(IntensityScale::from_range(f64::INFINITY, f64::NEG_INFINITY), IntensityScale::Unit);
    }

    /// A section of signed reflectance must be recognised as signed even
    /// though every null point in it carries a literal 0.
    #[test]
    fn the_sniff_ignores_null_points() {
        let body = "\
0 0 0 0\n\
1.0 2.0 3.0 -0.8\n\
0 0 0 0\n\
1.1 2.1 3.1 0.4\n\
0 0 0 0\n";
        let mut cur = Cursor::new(body.as_bytes().to_vec());
        let scale = sniff_intensity_scale(&mut cur, 0, 5, 4).unwrap();
        assert_eq!(scale, IntensityScale::Signed, "the -0.8 return must be seen");
    }

    /// A file with no intensity column must not be sniffed for one.
    #[test]
    fn a_three_column_section_needs_no_sniff() {
        let mut cur = Cursor::new(b"1 2 3\n4 5 6\n".to_vec());
        assert_eq!(sniff_intensity_scale(&mut cur, 0, 2, 3).unwrap(), IntensityScale::Unit);
    }

    // ---- Geometry ----

    /// PTX writes its transform column-major; the rest of the codebase
    /// wants row-major, with the translation in m[3], m[7], m[11]. A
    /// transpose that is silently a no-op would rotate every scan.
    #[test]
    fn the_transform_is_transposed_into_row_major() {
        // Column-major on disk: translation lands in indices 12, 13, 14.
        let mut raw = [0.0f64; 16];
        for (i, v) in raw.iter_mut().enumerate() { *v = i as f64; }
        let t = transpose_4x4(&raw);
        assert_eq!(t.len(), 16);
        for r in 0..4 { for c in 0..4 { assert_eq!(t[r * 4 + c], raw[c * 4 + r]); } }
        // Identity transposes to itself — the case a broken transpose
        // would pass, which is why it is not the only one here.
        let id = identity_4x4();
        let mut id_arr = [0.0f64; 16];
        id_arr.copy_from_slice(&id);
        assert_eq!(transpose_4x4(&id_arr), id);
    }

    /// The pose puts a scanner-local point into the file's shared world
    /// frame. Applied transposed, a scan lands rotated; applied not at
    /// all, every scan piles onto the origin.
    #[test]
    fn the_pose_places_a_local_point_in_the_world() {
        // 90° about Z, then translate by (10, 20, 30). Row-major.
        let m = vec![
            0.0, -1.0, 0.0, 10.0,
            1.0,  0.0, 0.0, 20.0,
            0.0,  0.0, 1.0, 30.0,
            0.0,  0.0, 0.0, 1.0,
        ];
        // The scanner origin goes to the translation.
        let o = apply_pose_4x4(&m, [0.0, 0.0, 0.0]);
        assert!((o.0 - 10.0).abs() < 1e-12 && (o.1 - 20.0).abs() < 1e-12 && (o.2 - 30.0).abs() < 1e-12);
        // +x local becomes +y world.
        let p = apply_pose_4x4(&m, [1.0, 0.0, 0.0]);
        assert!((p.0 - 10.0).abs() < 1e-12, "x {p:?}");
        assert!((p.1 - 21.0).abs() < 1e-12, "y {p:?}");
        // A malformed pose leaves the point alone rather than zeroing it.
        assert_eq!(apply_pose_4x4(&[1.0, 2.0], [7.0, 8.0, 9.0]), (7.0, 8.0, 9.0));
    }

    /// The column count decides which fields are read; guessing it wrong
    /// reads intensity as a coordinate.
    #[test]
    fn the_column_count_is_detected_from_a_data_line() {
        assert_eq!(detect_columns("1.0 2.0 3.0"), 3);
        assert_eq!(detect_columns("1.0 2.0 3.0 0.5"), 4);
        assert_eq!(detect_columns("1.0 2.0 3.0 10 20 30"), 6);
        assert_eq!(detect_columns("1.0 2.0 3.0 0.5 10 20 30"), 7);
        // Extra trailing junk rounds down to the nearest known shape
        // rather than failing the whole import.
        assert_eq!(detect_columns("1 2 3 4 5 6 7 8 9"), 7);
        assert_eq!(detect_columns("1 2"), 3);
        assert_eq!(detect_columns(""), 3);
    }

    /// Colour is 0..255 in the file and 16-bit in LAS. ×257 rather than
    /// ×256 so full-scale maps to full-scale.
    #[test]
    fn colour_is_widened_not_shifted_short() {
        assert_eq!(rgb_to_u16(255.0, 0.0, 128.0), (65535, 0, 32896));
        assert_eq!(rgb_to_u16(-5.0, 300.0, 1.0), (0, 65535, 257));
    }
}
