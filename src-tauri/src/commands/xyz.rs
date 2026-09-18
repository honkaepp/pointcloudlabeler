// Generic ASCII (XYZ / CSV / TXT) preprocessing commands.
//
// The safety net for forestry researchers who arrive with one-off
// datasets — anything that's "column-separated text with at least X,
// Y, Z somewhere". Auto-detects the delimiter (space / tab / comma /
// semicolon), sniffs whether the first line is a header, lets the
// user map columns to roles (X / Y / Z / intensity / R / G / B /
// classification), and converts to LAS / LAZ the Editor can import as
// an octree.
//
// Unlike Riegl / E57 / PTX, an ASCII cloud has no concept of "scan
// position" — it's one big bag of points. The Preprocessing UI still
// keeps the per-file manifest pattern (one panel entry per imported
// file with its column mapping cached) so re-opening the PointCloudLabeler project
// re-lists every prepared file with its mapping ready.

use tauri::State;

use crate::state::AppState;
use std::fs::{create_dir_all, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::pointscale::{ColourScale, IntensityScale};
use tauri::{Emitter, Window};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct XyzProjectSummary {
    pub id: String,
    pub source_path: String,
    pub name: String,
    /// "space" | "tab" | "comma" | "semicolon" — what the sniffer found.
    pub delimiter: String,
    /// True when the first line looks like column names (any non-numeric
    /// token). The mapping uses zero-based column indices either way.
    pub has_header: bool,
    /// Header names (one per column), empty when has_header = false.
    pub header_names: Vec<String>,
    pub column_count: u32,
    /// First N lines as parsed cells — the right-pane UI shows this as
    /// a preview so the user picks the right column-to-role assignment.
    pub preview: Vec<Vec<String>>,
    /// Extrapolated from a small slice of the file × the total size, so
    /// the UI can show "~12 M points" up front without scanning the
    /// whole file. ±10 % is normal.
    pub approx_point_count: u64,
    /// File size in bytes (cached so the UI can show MB / GB without a
    /// fresh stat).
    pub file_size: u64,
    /// Current column-to-role mapping. Updated by xyz_set_mapping when
    /// the user edits it in the panel; the manifest re-writes after
    /// every change so settings survive a PointCloudLabeler reload.
    pub mapping: XyzMapping,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct XyzMapping {
    pub x: u32,
    pub y: u32,
    pub z: u32,
    /// Each numeric extra is optional; -1 (encoded as null in JSON via
    /// Option) = "skip that channel". The intensity / RGB / class
    /// roles map to first-class LAS fields in the writer; anything
    /// else is dropped (we don't write Extra-Bytes from ASCII imports
    /// in v1 — that's a follow-up).
    pub intensity: Option<u32>,
    pub r: Option<u32>,
    pub g: Option<u32>,
    pub b: Option<u32>,
    pub classification: Option<u32>,
}

const MANIFEST_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    summary: XyzProjectSummary,
}

#[derive(Serialize, Clone, Copy)]
struct ProgressMsg<'a> {
    stage: &'a str,
    pct: f32,
}

fn emit_progress(window: &Window, pct: f32) {
    let _ = window.emit("xyz-progress", ProgressMsg { stage: "xyz", pct });
}

// --- public commands ------------------------------------------------

#[tauri::command]
pub fn xyz_list_projects(project_folder: String) -> Result<Vec<XyzProjectSummary>, String> {
    let dir = Path::new(&project_folder).join("preprocessing").join("xyz");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<XyzProjectSummary> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read xyz dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let manifest = path.join("manifest.json");
        let Ok(bytes) = std::fs::read(&manifest) else { continue; };
        let Ok(m) = serde_json::from_slice::<Manifest>(&bytes) else { continue; };
        out.push(m.summary);
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub fn xyz_import_project(
    project_folder: String,
    source_path: String,
    name: String,
) -> Result<XyzProjectSummary, String> {
    let src = Path::new(&source_path);
    if !src.is_file() {
        return Err(format!("Not a file: {source_path}"));
    }
    let file_size = std::fs::metadata(src).map_err(|e| format!("stat: {e}"))?.len();

    // Sniff: read up to 64 KB and pull out delimiter, header detection,
    // column count, a 10-line preview.
    let mut head = Vec::<u8>::new();
    {
        let f = File::open(src).map_err(|e| format!("open: {e}"))?;
        let take_bytes = 64 * 1024u64.min(file_size);
        f.take(take_bytes).read_to_end(&mut head).map_err(|e| format!("read head: {e}"))?;
    }
    // strip_bom before anything looks at the first line — see that
    // function for what a byte-order mark does to a headerless file.
    let head_text = strip_bom(&String::from_utf8_lossy(&head)).to_owned();
    let head_lines: Vec<&str> = head_text.lines().filter(|l| !l.trim().is_empty()).collect();
    if head_lines.len() < 2 {
        return Err("File has fewer than 2 non-empty lines — doesn't look like a point cloud.".into());
    }

    let (delimiter_char, delimiter_name) = sniff_delimiter(&head_lines);
    let column_count = count_columns(head_lines[0], delimiter_char);
    let (has_header, header_names) = sniff_header(head_lines[0], delimiter_char, column_count);
    let preview_start = if has_header { 1 } else { 0 };
    let preview: Vec<Vec<String>> = head_lines.iter()
        .skip(preview_start)
        .take(10)
        .map(|l| l.split(delimiter_char)
            .map(|s| s.trim().to_string())
            .collect::<Vec<_>>())
        .collect();

    // Approximate the point count: rough lines per byte from the head
    // slice, scaled to the full file. Off by ~5–10 % is OK for the UI.
    let head_lines_total = head_text.lines().count() as u64;
    let approx_point_count = if head.len() > 0 {
        let avg_bytes_per_line = (head.len() as f64) / (head_lines_total.max(1) as f64);
        let est = (file_size as f64 / avg_bytes_per_line) as u64;
        est.saturating_sub(if has_header { 1 } else { 0 })
    } else {
        0
    };

    // Default mapping: first three columns = X / Y / Z. The user can
    // re-shuffle in the panel via xyz_set_mapping.
    let mut mapping = XyzMapping::default();
    mapping.x = 0;
    mapping.y = if column_count >= 2 { 1 } else { 0 };
    mapping.z = if column_count >= 3 { 2 } else { 0 };
    // Common idiomatic layouts get sensible auto-mappings.
    if column_count == 4 {
        // X Y Z intensity
        mapping.intensity = Some(3);
    } else if column_count == 6 {
        // X Y Z R G B
        mapping.r = Some(3); mapping.g = Some(4); mapping.b = Some(5);
    } else if column_count >= 7 {
        // X Y Z intensity R G B [...]
        mapping.intensity = Some(3);
        mapping.r = Some(4); mapping.g = Some(5); mapping.b = Some(6);
    }
    // Also try matching by header name when present.
    if has_header {
        for (i, n) in header_names.iter().enumerate() {
            let n_lc = n.to_ascii_lowercase();
            match n_lc.as_str() {
                "x" => mapping.x = i as u32,
                "y" => mapping.y = i as u32,
                "z" => mapping.z = i as u32,
                "i" | "intensity" | "amp" | "amplitude" | "reflectance" => mapping.intensity = Some(i as u32),
                "r" | "red" => mapping.r = Some(i as u32),
                "g" | "green" => mapping.g = Some(i as u32),
                "b" | "blue" => mapping.b = Some(i as u32),
                "class" | "classification" => mapping.classification = Some(i as u32),
                _ => {}
            }
        }
    }

    let id = safe_folder_name(&name);
    let target = Path::new(&project_folder)
        .join("preprocessing")
        .join("xyz")
        .join(&id);
    create_dir_all(&target).map_err(|e| format!("create target dir: {e}"))?;

    let summary = XyzProjectSummary {
        id: id.clone(),
        source_path: source_path.clone(),
        name: name.clone(),
        delimiter: delimiter_name.to_string(),
        has_header,
        header_names,
        column_count,
        preview,
        approx_point_count,
        file_size,
        mapping,
        updated_at: now_ms(),
    };
    write_manifest(&target, &summary)?;
    Ok(summary)
}

#[tauri::command]
pub fn xyz_set_mapping(
    project_folder: String,
    xyz_id: String,
    mapping: XyzMapping,
) -> Result<XyzProjectSummary, String> {
    // One path component, not a path: this is joined onto the
    // preprocessing directory, and a join confines nothing.
    // See fsgrant::safe_component.
    crate::fsgrant::safe_component(&xyz_id)?;
    let dir = Path::new(&project_folder)
        .join("preprocessing")
        .join("xyz")
        .join(&xyz_id);
    let manifest_path = dir.join("manifest.json");
    let bytes = std::fs::read(&manifest_path).map_err(|e| format!("read manifest: {e}"))?;
    let mut m: Manifest = serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?;
    m.summary.mapping = mapping;
    m.summary.updated_at = now_ms();
    write_manifest(&dir, &m.summary)?;
    Ok(m.summary)
}

#[tauri::command]
pub fn xyz_remove_project(project_folder: String, xyz_id: String) -> Result<(), String> {
    // One path component, not a path: this is joined onto the
    // preprocessing directory, and a join confines nothing.
    // See fsgrant::safe_component.
    crate::fsgrant::safe_component(&xyz_id)?;
    let dir = Path::new(&project_folder)
        .join("preprocessing")
        .join("xyz")
        .join(&xyz_id);
    if !dir.is_dir() {
        return Err(format!("not a registered XYZ project: {xyz_id}"));
    }
    if !dir.join("manifest.json").is_file() {
        return Err(format!("refusing to remove '{xyz_id}' — no manifest.json"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("remove: {e}"))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XyzExportBbox {
    pub x_min: Option<f64>,
    pub x_max: Option<f64>,
    pub y_min: Option<f64>,
    pub y_max: Option<f64>,
    pub z_min: Option<f64>,
    pub z_max: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XyzExportResult {
    pub out_path: String,
    pub point_count: u64,
}

#[tauri::command]
pub async fn xyz_export(
    state: State<'_, AppState>,
    window: Window,
    project_folder: String,
    xyz_id: String,
    bbox: XyzExportBbox,
    out_path: String,
) -> Result<XyzExportResult, String> {
    // One path component, not a path: this is joined onto the
    // preprocessing directory, and a join confines nothing.
    // See fsgrant::safe_component.
    crate::fsgrant::safe_component(&xyz_id)?;
    // The renderer names this file; it is only allowed to name one the
    // user chose in a save dialog, or one inside the open project. See
    // fsgrant.rs — every write out of this application goes through it.
    let out_path = state
        .authorise_path(&out_path)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let manifest_path = Path::new(&project_folder)
        .join("preprocessing")
        .join("xyz")
        .join(&xyz_id)
        .join("manifest.json");
    let bytes = std::fs::read(&manifest_path).map_err(|e| format!("read manifest: {e}"))?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest: {e}"))?;
    let summary = manifest.summary;
    tauri::async_runtime::spawn_blocking(move || {
        run_xyz_export(&window, &summary, &bbox, &out_path)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

fn run_xyz_export(
    window: &Window,
    summary: &XyzProjectSummary,
    bbox: &XyzExportBbox,
    out_path: &str,
) -> Result<XyzExportResult, String> {
    use las::{Builder, Color as LasColor, Point as LasPoint, Transform as LasTransform, Vector, Writer};
    use las::point::Format;

    emit_progress(window, 0.0);

    let delim = name_to_delim(&summary.delimiter);
    let m = &summary.mapping;
    let need_cols = max_index(m);
    if need_cols >= summary.column_count {
        return Err(format!(
            "Mapping uses column {need_cols} but the file only has {} columns.",
            summary.column_count
        ));
    }

    // -- Pass 1: bbox so the LAS offset lands near the data center.
    // The first pass is bbox-only, no parsing of intensity/colour — the
    // hot loop only touches the X/Y/Z columns. For most files this is
    // ~half the runtime of pass 2, so the total cost is ~1.5× a single
    // pass. Worth it for clean LAS offsets that keep i32 in range.
    let mut file = BufReader::with_capacity(1 << 20, File::open(&summary.source_path)
        .map_err(|e| format!("open {}: {e}", summary.source_path))?);
    if summary.has_header {
        let mut throwaway = String::new();
        let _ = file.read_line(&mut throwaway);
    }
    let mut bbox_total: u64 = summary.approx_point_count.max(1);
    let mut seen: u64 = 0;
    let mut xmin = f64::INFINITY; let mut xmax = f64::NEG_INFINITY;
    let mut ymin = f64::INFINITY; let mut ymax = f64::NEG_INFINITY;
    let mut zmin = f64::INFINITY; let mut zmax = f64::NEG_INFINITY;
    // The intensity and colour SCALES are properties of the file, not of
    // any one value — see commands/pointscale.rs. The bbox pass already
    // reads every line, so observe their ranges here rather than guess
    // per value in the write loop.
    let mut imin = f64::INFINITY; let mut imax = f64::NEG_INFINITY;
    let mut cmax = f64::NEG_INFINITY;
    let mut line = String::new();
    loop {
        line.clear();
        let n = file.read_line(&mut line).map_err(|e| format!("read line: {e}"))?;
        if n == 0 { break; }
        let trimmed = strip_bom(line.trim());
        if trimmed.is_empty() { continue; }
        let cells: Vec<&str> = split_cells(trimmed, delim);
        if cells.len() <= need_cols as usize { continue; }
        let Some(x) = parse_f64(cells.get(m.x as usize)) else { continue; };
        let Some(y) = parse_f64(cells.get(m.y as usize)) else { continue; };
        let Some(z) = parse_f64(cells.get(m.z as usize)) else { continue; };
        xmin = xmin.min(x); xmax = xmax.max(x);
        ymin = ymin.min(y); ymax = ymax.max(y);
        zmin = zmin.min(z); zmax = zmax.max(z);
        if let Some(v) = m.intensity.and_then(|c| parse_f64(cells.get(c as usize))) {
            imin = imin.min(v); imax = imax.max(v);
        }
        for c in [m.r, m.g, m.b].into_iter().flatten() {
            if let Some(v) = parse_f64(cells.get(c as usize)) { cmax = cmax.max(v); }
        }
        seen += 1;
        if seen & 0x3FFFF == 0 {
            bbox_total = bbox_total.max(seen);
            emit_progress(window, 0.45 * (seen as f32 / bbox_total as f32).clamp(0.0, 1.0));
        }
    }
    let iscale = IntensityScale::from_range(imin, imax);
    let cscale = ColourScale::from_max(cmax);
    if !xmin.is_finite() {
        return Err("No valid XYZ points found — check the column mapping.".into());
    }
    let ox = ((xmin + xmax) * 0.5).round();
    let oy = ((ymin + ymax) * 0.5).round();
    let oz = ((zmin + zmax) * 0.5).round();
    let total_points = seen;

    // -- Pass 2: write LAS / LAZ. --
    let mut builder = Builder::from((1, 4));
    builder.point_format = Format::new(2).map_err(|e| format!("las format: {e}"))?;
    builder.transforms = Vector {
        x: LasTransform { scale: 0.001, offset: ox },
        y: LasTransform { scale: 0.001, offset: oy },
        z: LasTransform { scale: 0.001, offset: oz },
    };
    builder.generating_software = "PointCloudLabeler — XYZ/CSV preprocessing".to_string();
    let header = builder.into_header().map_err(|e| format!("build las header: {e}"))?;
    let mut writer = Writer::from_path(out_path, header)
        .map_err(|e| format!("create {out_path}: {e}"))?;

    let mut file = BufReader::with_capacity(1 << 20, File::open(&summary.source_path)
        .map_err(|e| format!("open {}: {e}", summary.source_path))?);
    if summary.has_header {
        let mut throwaway = String::new();
        let _ = file.read_line(&mut throwaway);
    }
    let mut written: u64 = 0;
    let mut read: u64 = 0;
    let mut line = String::new();
    loop {
        line.clear();
        let n = file.read_line(&mut line).map_err(|e| format!("read line: {e}"))?;
        if n == 0 { break; }
        let trimmed = strip_bom(line.trim());
        if trimmed.is_empty() { continue; }
        read += 1;
        if read & 0x3FFFF == 0 && total_points > 0 {
            let pct = 0.5 + 0.49 * (read as f32 / total_points as f32).clamp(0.0, 1.0);
            emit_progress(window, pct);
        }
        let cells: Vec<&str> = split_cells(trimmed, delim);
        if cells.len() <= need_cols as usize { continue; }
        let Some(x) = parse_f64(cells.get(m.x as usize)) else { continue; };
        let Some(y) = parse_f64(cells.get(m.y as usize)) else { continue; };
        let Some(z) = parse_f64(cells.get(m.z as usize)) else { continue; };
        if let Some(v) = bbox.x_min { if x < v { continue; } }
        if let Some(v) = bbox.x_max { if x > v { continue; } }
        if let Some(v) = bbox.y_min { if y < v { continue; } }
        if let Some(v) = bbox.y_max { if y > v { continue; } }
        if let Some(v) = bbox.z_min { if z < v { continue; } }
        if let Some(v) = bbox.z_max { if z > v { continue; } }

        let intensity = m.intensity
            .and_then(|c| parse_f64(cells.get(c as usize)))
            .map(|v| iscale.map(v))
            .unwrap_or(0);
        let color = match (m.r, m.g, m.b) {
            (Some(rc), Some(gc), Some(bc)) => {
                let r = parse_f64(cells.get(rc as usize)).unwrap_or(0.0);
                let g = parse_f64(cells.get(gc as usize)).unwrap_or(0.0);
                let b = parse_f64(cells.get(bc as usize)).unwrap_or(0.0);
                let (r, g, b) = cscale.map_rgb(r, g, b);
                Some(LasColor { red: r, green: g, blue: b })
            }
            _ => None,
        };
        let classification = m.classification
            .and_then(|c| parse_f64(cells.get(c as usize)))
            .map(|v| v.clamp(0.0, 255.0) as u8)
            .unwrap_or(0);

        let mut lp = LasPoint {
            x, y, z,
            intensity,
            // ASPRS return numbers start at 1; Default gives 0, which every
            // strict validator flags on every point. These sources are
            // single-echo, so 1 of 1 is also the truthful value.
            return_number: 1,
            number_of_returns: 1,
            ..Default::default()
        };
        lp.color = color;
        lp.classification = las::point::Classification::new(classification)
            .unwrap_or(las::point::Classification::Unclassified);
        writer.write_point(lp).map_err(|e| format!("write point: {e}"))?;
        written += 1;
    }

    writer.close().map_err(|e| format!("close las/laz: {e}"))?;
    emit_progress(window, 1.0);
    Ok(XyzExportResult {
        out_path: out_path.to_string(),
        point_count: written,
    })
}

// --- helpers --------------------------------------------------------

/// Count occurrences of each candidate delimiter on the first 4 lines
/// of the head slice; pick whichever is most consistent (i.e. has the
/// same count on every line). Falls back to whitespace if no
/// single-char delimiter dominates.
fn sniff_delimiter<'a>(head_lines: &'a [&'a str]) -> (char, &'static str) {
    let candidates: &[(char, &'static str)] = &[
        (',', "comma"),
        ('\t', "tab"),
        (';', "semicolon"),
        (' ', "space"),
    ];
    let probe = head_lines.iter().take(5).copied().collect::<Vec<_>>();
    let mut best = (' ', "space", 0.0_f64);
    for &(c, name) in candidates {
        let counts: Vec<usize> = probe.iter().map(|l| l.matches(c).count()).collect();
        if counts.is_empty() { continue; }
        let avg = counts.iter().sum::<usize>() as f64 / counts.len() as f64;
        if avg < 1.0 { continue; }
        let var = counts.iter().map(|&v| (v as f64 - avg).powi(2)).sum::<f64>() / counts.len() as f64;
        // Score: many delimiters + low variance = good.
        let score = avg / (1.0 + var);
        if score > best.2 {
            best = (c, name, score);
        }
    }
    (best.0, best.1)
}

/// Split one data line into cells.
///
/// The rule depends on the delimiter, and getting it uniform matters
/// more than which rule wins: the sniffing code filtered empty cells
/// while the two parse loops did not, so the column indices the user
/// was shown and the ones the parser used were different arrays.
///
/// For a SPACE-delimited file, runs of spaces are alignment, not data.
/// Fixed-width ASCII dumps — the most classic "xyz" file there is —
/// wrote `1.0   2.0   3.0`, which the sniff reported as three columns
/// and the parser split into seven. Mapping x/y/z to 0/1/2 then read
/// "1.0", "" and "", so every point failed to parse and the import came
/// back "No valid XYZ points found — check the column mapping", blaming
/// a mapping that was correct.
///
/// For comma, tab and semicolon the opposite holds: an empty cell is a
/// real column with a missing value. Filtering those, which the sniff
/// did, counted `1.0,,3.0` as two columns where there are three, so the
/// user's mapping was offset from what the parser indexed.
fn split_cells(line: &str, delim: char) -> Vec<&str> {
    if delim == ' ' {
        line.split_ascii_whitespace().collect()
    } else {
        line.split(delim).collect()
    }
}

fn count_columns(line: &str, delim: char) -> u32 {
    split_cells(line, delim).len() as u32
}

/// Drop a leading UTF-8 byte-order mark, U+FEFF.
///
/// Excel writes one at the front of every file saved as "CSV UTF-8",
/// and it is what makes Excel read the file back as UTF-8 instead of as
/// the machine's ANSI codepage — so a great many of the .csv and .txt
/// clouds a forester hands this importer start with one.
///
/// `str::trim` does NOT remove it: U+FEFF is a format character (Cf),
/// not Unicode White_Space, so it survives every trim in the parse loop
/// and stays glued to the first cell of the first line. In a file WITH a
/// header that only made the first column's name unreadable. In a
/// headerless one it made "123.45" fail to parse, so `sniff_header`
/// concluded the data row was a header — and the first point of the
/// cloud silently never arrived.
fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

fn sniff_header(first_line: &str, delim: char, column_count: u32) -> (bool, Vec<String>) {
    let cells: Vec<&str> = split_cells(first_line, delim).into_iter().map(|s| s.trim()).collect();
    if cells.is_empty() { return (false, vec![]); }
    // If ANY cell on the first line fails to parse as a float, treat it
    // as a header. ASCII point clouds with no header start with three
    // numbers; with a header they start with letters.
    let all_numeric = cells.iter().all(|c| c.parse::<f64>().is_ok());
    if all_numeric {
        (false, vec![])
    } else {
        let names: Vec<String> = cells.iter().map(|s| s.to_string()).collect();
        // Pad / truncate to match column_count.
        let mut padded = names;
        padded.resize(column_count as usize, String::new());
        (true, padded)
    }
}

fn name_to_delim(name: &str) -> char {
    match name {
        "comma" => ',',
        "tab" => '\t',
        "semicolon" => ';',
        _ => ' ',
    }
}

fn parse_f64(s: Option<&&str>) -> Option<f64> {
    s.and_then(|t| t.trim().parse::<f64>().ok())
}

fn max_index(m: &XyzMapping) -> u32 {
    let mut max = m.x.max(m.y).max(m.z);
    for opt in [m.intensity, m.r, m.g, m.b, m.classification].iter().copied().flatten() {
        if opt > max { max = opt; }
    }
    max
}

fn write_manifest(dir: &Path, summary: &XyzProjectSummary) -> Result<(), String> {
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
    if s.is_empty() { s.push_str("xyz_project"); }
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

// Quiet unused-import warning when SeekFrom + Seek aren't reached
// (compiler can't see through the conditional branches).
#[allow(dead_code)]
fn _seek_anchor<R: Seek>(mut r: R) {
    let _ = r.seek(SeekFrom::Start(0));
}

/// The heuristics that decide what an arbitrary ASCII file's columns
/// are. Everything downstream — the mapping dialog, the bbox, the
/// export — indexes the cells these produce, so a disagreement between
/// them and the parser is not a bad guess, it is a different array.
#[cfg(test)]
mod xyz_tests {
    use super::*;

    /// A cloud saved from Excel as "CSV UTF-8" starts with U+FEFF, and
    /// the first line is where every decision about the file is made.
    #[test]
    fn a_byte_order_mark_is_not_the_first_column() {
        const BOM: char = '\u{feff}';

        // The costly case: no header. Left in place, "1.0" does not
        // parse, so the sniff called a row of DATA a header and the
        // first point of the cloud never arrived.
        let headerless = format!("{BOM}1.0 2.0 3.0");
        let (has_header, _) = sniff_header(strip_bom(&headerless), ' ', 3);
        assert!(!has_header, "a numeric first row is data, mark or no mark");
        // …and without the strip it would have been read as a header,
        // which is the behaviour being fixed.
        let (mistaken, _) = sniff_header(&headerless, ' ', 3);
        assert!(mistaken, "guard: the mark really does break the sniff");

        // With a header, the first COLUMN NAME must be usable — the
        // mapping matches on names like "x", and "\u{feff}x" matches
        // nothing.
        let headed = format!("{BOM}x y z");
        let (yes, names) = sniff_header(strip_bom(&headed), ' ', 3);
        assert!(yes);
        assert_eq!(names[0], "x", "the mark must not be part of the name");

        // And the parse loop's own guard: trim does NOT remove it,
        // because U+FEFF is a format character and not whitespace. This
        // is the property the whole fix rests on, so it is asserted
        // rather than assumed.
        assert_eq!(headerless.trim(), headerless, "trim must not be doing this job");
        assert_eq!(strip_bom(headerless.trim()), "1.0 2.0 3.0");
        // Only a LEADING mark, and only one — anywhere else it is content.
        assert_eq!(strip_bom("plain"), "plain");
        assert_eq!(strip_bom(&format!("{BOM}{BOM}x")), format!("{BOM}x"));
        assert_eq!(strip_bom(&format!("a{BOM}b")), format!("a{BOM}b"));
    }

    /// The sniff and the parse must split a line the same way. They did
    /// not: the sniff filtered empty cells and the parse did not.
    #[test]
    fn the_column_count_matches_what_the_parser_will_index() {
        for (line, delim) in [
            ("1.0 2.0 3.0", ' '),
            ("1.0   2.0   3.0", ' '),          // fixed-width alignment
            ("  1.0\t\t2.0   3.0  ", ' '),     // mixed whitespace
            ("1.0,2.0,3.0", ','),
            ("1.0,,3.0", ','),                 // a real empty field
            ("1.0;2.0;3.0;4.0", ';'),
            ("1.0\t2.0\t3.0", '\t'),
        ] {
            let n = count_columns(line, delim);
            let cells = split_cells(line.trim(), delim);
            assert_eq!(
                n as usize, cells.len(),
                "{line:?} with {delim:?}: counted {n}, parser sees {}", cells.len(),
            );
        }
    }

    /// A fixed-width ASCII dump is the most ordinary xyz file there is,
    /// and it used to import as nothing at all: the parse split
    /// `1.0   2.0   3.0` into seven cells, so x/y/z mapped to 0/1/2 read
    /// "1.0", "" and "".
    #[test]
    fn an_aligned_file_parses_its_own_columns() {
        let cells = split_cells("1.0   2.0   3.0", ' ');
        assert_eq!(cells, vec!["1.0", "2.0", "3.0"]);
        assert_eq!(parse_f64(cells.first()), Some(1.0));
        assert_eq!(parse_f64(cells.get(1)), Some(2.0));
        assert_eq!(parse_f64(cells.get(2)), Some(3.0));
    }

    /// The opposite rule for the other delimiters: an empty cell in a
    /// CSV is a column with a missing value, not padding. Dropping it
    /// shifts every column after it.
    #[test]
    fn an_empty_csv_field_stays_a_column() {
        let cells = split_cells("1.0,,3.0", ',');
        assert_eq!(cells, vec!["1.0", "", "3.0"]);
        assert_eq!(count_columns("1.0,,3.0", ','), 3);
        // The third column is still readable, which is the point.
        assert_eq!(parse_f64(cells.get(2)), Some(3.0));
        assert_eq!(parse_f64(cells.get(1)), None);
    }

    /// The delimiter is chosen from the head of the file. A wrong choice
    /// puts the coordinates on the wrong columns.
    #[test]
    fn the_delimiter_is_recognised_from_a_few_lines() {
        for (lines, want) in [
            (vec!["1.0,2.0,3.0", "4.0,5.0,6.0", "7.0,8.0,9.0"], ','),
            (vec!["1.0\t2.0\t3.0", "4.0\t5.0\t6.0"], '\t'),
            (vec!["1.0;2.0;3.0", "4.0;5.0;6.0"], ';'),
            (vec!["1.0 2.0 3.0", "4.0 5.0 6.0"], ' '),
        ] {
            let (got, _) = sniff_delimiter(&lines);
            assert_eq!(got, want, "for {lines:?}");
        }
    }

    /// A consistent delimiter beats one that merely appears more often.
    /// Decimal commas inside a space-delimited file are the case that
    /// matters — they are frequent AND regular, so the count alone is
    /// not enough to tell them apart from a real CSV.
    #[test]
    fn the_delimiter_choice_prefers_a_consistent_count() {
        // Semicolon-separated with decimal commas: three semicolons per
        // line, and commas too. Both are regular, so this documents
        // which one wins rather than asserting it is obvious.
        let lines = vec!["1,5;2,5;3,5", "4,5;5,5;6,5", "7,5;8,5;9,5"];
        let (got, _) = sniff_delimiter(&lines);
        assert!(got == ';' || got == ',', "picked {got:?}");
        // Whichever it picks, the count and the parse agree — which is
        // the property that stops a wrong guess from silently shifting
        // columns rather than failing visibly.
        assert_eq!(count_columns(lines[0], got) as usize, split_cells(lines[0], got).len());
    }

    /// A first line of numbers is data; a first line with a word is a
    /// header. Getting that backwards either eats a point or reads a
    /// header as coordinates.
    #[test]
    fn a_header_is_told_from_a_data_line() {
        let (has, names) = sniff_header("x,y,z", ',', 3);
        assert!(has);
        assert_eq!(names, vec!["x", "y", "z"]);

        let (has, _) = sniff_header("1.0,2.0,3.0", ',', 3);
        assert!(!has, "a line of numbers is data");

        // Scientific notation and signs are still numbers.
        let (has, _) = sniff_header("-1.5e3,2.0,+3.0", ',', 3);
        assert!(!has);

        // One non-numeric cell is enough to call it a header.
        let (has, names) = sniff_header("1.0,2.0,intensity", ',', 3);
        assert!(has);
        assert_eq!(names.len(), 3);

        // Names are padded to the column count so the dialog can index
        // them positionally.
        let (_, names) = sniff_header("x,y", ',', 4);
        assert_eq!(names.len(), 4);
    }

    /// `max_index` decides how many cells a line must have before the
    /// parser will touch it. Missing an optional column there makes the
    /// importer read past the end of short lines.
    #[test]
    fn the_required_column_count_covers_every_mapped_column() {
        let base = XyzMapping { x: 0, y: 1, z: 2, intensity: None, r: None, g: None, b: None, classification: None };
        assert_eq!(max_index(&base), 2);
        assert_eq!(max_index(&XyzMapping { intensity: Some(7), ..base }), 7);
        assert_eq!(max_index(&XyzMapping { r: Some(4), g: Some(5), b: Some(9), ..base }), 9);
        assert_eq!(max_index(&XyzMapping { classification: Some(12), ..base }), 12);
        // An out-of-order mapping still reports the largest index.
        assert_eq!(max_index(&XyzMapping { x: 5, y: 0, z: 2, ..base }), 5);
    }

    #[test]
    fn a_cell_that_is_not_a_number_is_not_a_coordinate() {
        assert_eq!(parse_f64(Some(&" 1.5 ")), Some(1.5));
        assert_eq!(parse_f64(Some(&"-2e3")), Some(-2000.0));
        assert_eq!(parse_f64(Some(&"")), None);
        assert_eq!(parse_f64(Some(&"n/a")), None);
        assert_eq!(parse_f64(None), None);
    }
}
