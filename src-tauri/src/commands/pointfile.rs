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

//! Point files other than LAS: ASCII text (TXT / XYZ / CSV / PTS), PLY
//! and E57 — into a dataset, and a dataset out as any of them.
//!
//! The octree importer reads LAS, and the exporter writes LAS. Rather
//! than teach each of them three more formats, the other formats go
//! THROUGH a LAS: an import stages the file as a LAS 1.4 next to the
//! dataset it is about to become (every column of the file in it —
//! the standard fields where the record keeps them, everything else
//! as a 64-bit Extra Bytes dimension under its own name) and hands
//! that to the importer, which deletes it afterwards; an export writes
//! its LAS to a temporary file and transcodes it. Both halves are
//! therefore the same code path as a LAS import or export — the same
//! column handling, the same filters, the same normalisation and
//! reprojection — with one translation in front or behind.
//!
//! What each format carries:
//!
//! * TEXT: the columns of the file under their header names (or
//!   `column_1 … column_N` when there is no header), mapped to the
//!   record's fields by name or by hand. A text file has no types: a
//!   value is a double, written back with the shortest representation
//!   that reads to the same double.
//! * PLY: the scalar properties of the `vertex` element, ascii or
//!   binary of either endianness. Typed on the way out.
//! * E57: every point cloud of the file, poses applied, in one dataset
//!   — each scan's index as the point source id, so the Point QC wind
//!   stage can tell the scans apart. Cartesian or spherical, intensity
//!   and colour as recorded (the importer scales them to the record's
//!   16 bits), the time stamp, return index and count, and any
//!   attribute of an extension under its own name. Out again with the
//!   record's fields as standard E57 attributes and every other column
//!   under a `pcl` extension namespace.

use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::octree::{
    parse_extra_dims, read_extra_raw_f64, run_convert, LasExtraDim, OctreeImportResult, ProgressSink,
    StagedSink,
};
use super::pointscale::{ColourScale, IntensityScale};
use super::xyz::{name_to_delim, parse_f64, sniff_delimiter, sniff_header, split_cells, strip_bom};

// ---------------------------------------------------------------------
// Kinds, roles, mapping
// ---------------------------------------------------------------------

/// A point file the importer does not read directly.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum PointFileKind {
    Text,
    Ply,
    E57,
}

impl PointFileKind {
    /// By extension; None for LAS/LAZ and anything unknown.
    pub fn of_path(path: &str) -> Option<PointFileKind> {
        let ext = Path::new(path).extension()?.to_str()?.to_ascii_lowercase();
        match ext.as_str() {
            "txt" | "xyz" | "csv" | "asc" | "pts" | "tsv" | "dat" => Some(PointFileKind::Text),
            "ply" => Some(PointFileKind::Ply),
            "e57" => Some(PointFileKind::E57),
            _ => None,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PointFileKind::Text => "text",
            PointFileKind::Ply => "PLY",
            PointFileKind::E57 => "E57",
        }
    }
}

/// The fields of the record a source column can fill, besides X, Y
/// and Z. Order is the order of `PointFileMapping`'s fields and of the
/// per-point value array.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Intensity,
    Red,
    Green,
    Blue,
    Classification,
    GpsTime,
    TreeId,
    Semantic,
    ReturnNumber,
    NumberOfReturns,
    PointSourceId,
    ScanAngle,
    UserData,
    Nir,
    StandingDeadwood,
    LayingDeadwood,
}

pub const ROLES: [Role; 16] = [
    Role::Intensity, Role::Red, Role::Green, Role::Blue, Role::Classification, Role::GpsTime,
    Role::TreeId, Role::Semantic, Role::ReturnNumber, Role::NumberOfReturns, Role::PointSourceId,
    Role::ScanAngle, Role::UserData, Role::Nir, Role::StandingDeadwood, Role::LayingDeadwood,
];

impl Role {
    fn index(self) -> usize {
        ROLES.iter().position(|r| *r == self).expect("every role is listed")
    }

    /// Column names that mean this field, in files seen so far. The
    /// first spelling is the reserved one.
    fn aliases(self) -> &'static [&'static str] {
        match self {
            Role::Intensity => &["intensity", "intens", "scalar_intensity", "i", "int"],
            Role::Red => &["red", "r", "diffuse_red"],
            Role::Green => &["green", "g", "diffuse_green"],
            Role::Blue => &["blue", "b", "diffuse_blue"],
            Role::Classification => &["classification", "class", "cls", "classif", "scalar_classification"],
            Role::GpsTime => &["gps_time", "gpstime", "time", "timestamp", "t", "gps_time_s"],
            Role::TreeId => &["tree_id", "treeid", "tree", "instance", "instance_id", "instance_pred", "segment_id", "segmentid"],
            Role::Semantic => &["semantic", "semantic_class", "semantic_pred", "sem"],
            Role::ReturnNumber => &["return_number", "returnnumber", "return_num", "return_index", "return"],
            Role::NumberOfReturns => &["number_of_returns", "numberofreturns", "n_returns", "num_returns", "return_count", "returns"],
            Role::PointSourceId => &["point_source_id", "pointsourceid", "scan_id", "scanid", "pointcloud_id", "scan", "scan_position", "scanpos"],
            Role::ScanAngle => &["scan_angle", "scanangle", "scan_angle_rank"],
            Role::UserData => &["user_data", "userdata"],
            Role::Nir => &["nir", "near_infrared", "nearinfrared"],
            Role::StandingDeadwood => &["standing_deadwood"],
            Role::LayingDeadwood => &["laying_deadwood"],
        }
    }
}

/// Which source column fills which field of the record. Columns are
/// named as the probe lists them; a name that is not in the file is
/// refused before anything is written. `extras` are carried as
/// 64-bit columns under their own names — a column may be both a role
/// and an extra (the intensity scaled into the record's 16 bits, and
/// the same value exact beside it).
#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PointFileMapping {
    pub x: Option<String>,
    pub y: Option<String>,
    pub z: Option<String>,
    #[serde(default)] pub intensity: Option<String>,
    #[serde(default)] pub red: Option<String>,
    #[serde(default)] pub green: Option<String>,
    #[serde(default)] pub blue: Option<String>,
    #[serde(default)] pub classification: Option<String>,
    #[serde(default)] pub gps_time: Option<String>,
    #[serde(default)] pub tree_id: Option<String>,
    #[serde(default)] pub semantic: Option<String>,
    #[serde(default)] pub return_number: Option<String>,
    #[serde(default)] pub number_of_returns: Option<String>,
    #[serde(default)] pub point_source_id: Option<String>,
    #[serde(default)] pub scan_angle: Option<String>,
    #[serde(default)] pub user_data: Option<String>,
    #[serde(default)] pub nir: Option<String>,
    #[serde(default)] pub standing_deadwood: Option<String>,
    #[serde(default)] pub laying_deadwood: Option<String>,
    /// Every other column to carry, each as a float64 column under its own name.
    #[serde(default)] pub extras: Vec<String>,
}

impl PointFileMapping {
    pub fn get(&self, r: Role) -> Option<&str> {
        let s = match r {
            Role::Intensity => &self.intensity,
            Role::Red => &self.red,
            Role::Green => &self.green,
            Role::Blue => &self.blue,
            Role::Classification => &self.classification,
            Role::GpsTime => &self.gps_time,
            Role::TreeId => &self.tree_id,
            Role::Semantic => &self.semantic,
            Role::ReturnNumber => &self.return_number,
            Role::NumberOfReturns => &self.number_of_returns,
            Role::PointSourceId => &self.point_source_id,
            Role::ScanAngle => &self.scan_angle,
            Role::UserData => &self.user_data,
            Role::Nir => &self.nir,
            Role::StandingDeadwood => &self.standing_deadwood,
            Role::LayingDeadwood => &self.laying_deadwood,
        };
        s.as_deref().map(str::trim).filter(|s| !s.is_empty())
    }

    fn set(&mut self, r: Role, v: Option<String>) {
        let slot = match r {
            Role::Intensity => &mut self.intensity,
            Role::Red => &mut self.red,
            Role::Green => &mut self.green,
            Role::Blue => &mut self.blue,
            Role::Classification => &mut self.classification,
            Role::GpsTime => &mut self.gps_time,
            Role::TreeId => &mut self.tree_id,
            Role::Semantic => &mut self.semantic,
            Role::ReturnNumber => &mut self.return_number,
            Role::NumberOfReturns => &mut self.number_of_returns,
            Role::PointSourceId => &mut self.point_source_id,
            Role::ScanAngle => &mut self.scan_angle,
            Role::UserData => &mut self.user_data,
            Role::Nir => &mut self.nir,
            Role::StandingDeadwood => &mut self.standing_deadwood,
            Role::LayingDeadwood => &mut self.laying_deadwood,
        };
        *slot = v;
    }

    fn has_colour(&self) -> bool {
        self.get(Role::Red).is_some() && self.get(Role::Green).is_some() && self.get(Role::Blue).is_some()
    }
}

/// A column name as it is matched: trimmed, lower-case, spaces and
/// dashes as underscores.
fn norm(name: &str) -> String {
    name.trim().to_ascii_lowercase().replace([' ', '-'], "_")
}

fn find_col(columns: &[String], names: &[&str]) -> Option<String> {
    let lc: Vec<String> = columns.iter().map(|c| norm(c)).collect();
    for n in names {
        if let Some(i) = lc.iter().position(|c| c == n) {
            return Some(columns[i].clone());
        }
    }
    None
}

/// A mapping guessed from the column names alone: X, Y, Z by name or
/// the first three columns, each role by its usual spellings, and
/// every column no role claimed as an extra. An amplitude column
/// stands in for a missing intensity (the same quantity under the
/// scanner's name) and stays an extra too, so the exact value is kept
/// beside the scaled one. A reflectance is not an intensity and is
/// never taken for one; it stays a column of its own.
pub fn suggest_mapping(columns: &[String]) -> PointFileMapping {
    let mut m = PointFileMapping::default();
    let mut claimed: Vec<String> = Vec::new();
    let claim = |c: &Option<String>, claimed: &mut Vec<String>| {
        if let Some(c) = c { claimed.push(c.clone()); }
    };
    m.x = find_col(columns, &["x", "easting", "east"]);
    m.y = find_col(columns, &["y", "northing", "north"]);
    m.z = find_col(columns, &["z", "elevation", "altitude", "alt"]);
    if m.x.is_none() && m.y.is_none() && m.z.is_none() && columns.len() >= 3 {
        m.x = Some(columns[0].clone());
        m.y = Some(columns[1].clone());
        m.z = Some(columns[2].clone());
    }
    claim(&m.x, &mut claimed);
    claim(&m.y, &mut claimed);
    claim(&m.z, &mut claimed);
    for r in ROLES {
        let c = find_col(columns, r.aliases());
        claim(&c, &mut claimed);
        m.set(r, c);
    }
    if m.get(Role::Intensity).is_none() {
        // Not claimed: the exact value is worth more than the scaled one.
        m.intensity = find_col(columns, &["amplitude", "amp", "amplitude_db"]);
    }
    m.extras = columns
        .iter()
        .filter(|c| !claimed.iter().any(|k| k == *c))
        .cloned()
        .collect();
    m
}

/// A positional guess for a headerless text file, after the layouts
/// seen most: X Y Z, X Y Z I, X Y Z R G B, X Y Z I R G B ….
fn suggest_positional(columns: &[String]) -> PointFileMapping {
    let mut m = PointFileMapping::default();
    let n = columns.len();
    if n >= 3 {
        m.x = Some(columns[0].clone());
        m.y = Some(columns[1].clone());
        m.z = Some(columns[2].clone());
    }
    let mut claimed = 3usize;
    if n == 4 {
        m.intensity = Some(columns[3].clone());
        claimed = 4;
    } else if n == 6 {
        m.red = Some(columns[3].clone());
        m.green = Some(columns[4].clone());
        m.blue = Some(columns[5].clone());
        claimed = 6;
    } else if n >= 7 {
        m.intensity = Some(columns[3].clone());
        m.red = Some(columns[4].clone());
        m.green = Some(columns[5].clone());
        m.blue = Some(columns[6].clone());
        claimed = 7;
    }
    m.extras = columns.iter().skip(claimed.min(n)).cloned().collect();
    m
}

// ---------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------

/// What a file has, for the import dialog and the catalogue: its
/// columns, a few rows of them, and a mapping to start from.
#[derive(Clone, Debug, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PointFileProbe {
    pub kind: PointFileKind,
    /// The columns, as the mapping names them.
    pub columns: Vec<String>,
    /// Text: whether the first line was column names.
    pub has_header: bool,
    /// Text: "space", "tab", "comma" or "semicolon".
    pub delimiter: Option<String>,
    /// The first rows, one cell per column, as text.
    pub preview: Vec<Vec<String>>,
    /// Points in the file — exact for PLY and E57, estimated for text.
    pub approx_point_count: u64,
    /// E57: the point clouds in the file, by name.
    pub scans: Vec<String>,
    pub suggested: PointFileMapping,
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn pointfile_probe(
    state: tauri::State<'_, crate::state::AppState>,
    path: String,
) -> Result<PointFileProbe, String> {
    // The renderer names the file; it must be one the user picked.
    let path = state.authorise_path(&path).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    crate::rt::spawn_blocking(move || probe(&path)).await.map_err(|e| format!("join error: {e}"))?
}

pub fn probe(path: &str) -> Result<PointFileProbe, String> {
    let kind = PointFileKind::of_path(path)
        .ok_or_else(|| format!("{path}: not a text, PLY or E57 point file"))?;
    let mut src = open_source(kind, path)?;
    let columns = src.columns().to_vec();
    let suggested = match (kind, src.has_header()) {
        (PointFileKind::Text, false) => suggest_positional(&columns),
        _ => suggest_mapping(&columns),
    };
    // A few rows, through the same reader the import uses.
    let mut preview: Vec<Vec<String>> = Vec::new();
    src.rows(&mut |row| {
        preview.push(row.iter().map(|v| if v.is_nan() { String::new() } else { format!("{v}") }).collect());
        Ok(preview.len() < 10)
    })?;
    Ok(PointFileProbe {
        kind,
        columns,
        has_header: src.has_header(),
        delimiter: src.delimiter_name().map(|s| s.to_string()),
        preview,
        approx_point_count: src.estimated_points(),
        scans: src.scan_names(),
        suggested,
    })
}

// ---------------------------------------------------------------------
// Sources: one row of f64 cells per point, NaN where a column has no
// value for this point
// ---------------------------------------------------------------------

trait RowSource {
    fn columns(&self) -> &[String];
    fn has_header(&self) -> bool { true }
    fn delimiter_name(&self) -> Option<&'static str> { None }
    fn scan_names(&self) -> Vec<String> { Vec::new() }
    fn estimated_points(&self) -> u64;
    /// The quantisation step the file's own precision asks for, when
    /// the file says (a text file's decimals in its X, Y and Z columns).
    fn native_step(&self, _xyz: [usize; 3]) -> Option<f64> { None }
    /// Every point, in file order; `f` returns false to stop early.
    fn rows(&mut self, f: &mut dyn FnMut(&[f64]) -> Result<bool, String>) -> Result<u64, String>;
}

fn open_source(kind: PointFileKind, path: &str) -> Result<Box<dyn RowSource>, String> {
    Ok(match kind {
        PointFileKind::Text => Box::new(TextSource::open(path)?),
        PointFileKind::Ply => Box::new(PlySource::open(path)?),
        PointFileKind::E57 => Box::new(E57Source::open(path)?),
    })
}

// ---- text ------------------------------------------------------------

struct TextSource {
    path: String,
    delim: char,
    delim_name: &'static str,
    has_header: bool,
    columns: Vec<String>,
    approx: u64,
    /// The most decimals seen in each column's first cells.
    decimals: Vec<u32>,
}

impl TextSource {
    fn open(path: &str) -> Result<Self, String> {
        let file_size = std::fs::metadata(path).map_err(|e| format!("stat {path}: {e}"))?.len();
        let mut head = Vec::<u8>::new();
        {
            let f = File::open(path).map_err(|e| format!("open {path}: {e}"))?;
            f.take((256 * 1024u64).min(file_size)).read_to_end(&mut head).map_err(|e| format!("read {path}: {e}"))?;
        }
        let head_text = strip_bom(&String::from_utf8_lossy(&head)).to_owned();
        let head_lines: Vec<&str> = head_text
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("//"))
            .collect();
        if head_lines.is_empty() {
            return Err(format!("{path}: no lines with data"));
        }
        let (delim, delim_name) = sniff_delimiter(&head_lines);
        let column_count = split_cells(head_lines[0], delim).len() as u32;
        let (has_header, names) = sniff_header(head_lines[0], delim, column_count);
        let columns: Vec<String> = if has_header {
            // A blank or repeated header cell still needs a name.
            let mut seen: Vec<String> = Vec::new();
            names
                .iter()
                .enumerate()
                .map(|(i, n)| {
                    let base = if n.trim().is_empty() { format!("column_{}", i + 1) } else { n.trim().to_string() };
                    let mut name = base.clone();
                    let mut k = 2;
                    while seen.iter().any(|s| s.eq_ignore_ascii_case(&name)) {
                        name = format!("{base}_{k}");
                        k += 1;
                    }
                    seen.push(name.clone());
                    name
                })
                .collect()
        } else {
            (0..column_count).map(|i| format!("column_{}", i + 1)).collect()
        };
        let data_lines: Vec<&str> = head_lines.iter().copied().skip(if has_header { 1 } else { 0 }).collect();
        let mut decimals = vec![0u32; columns.len()];
        for l in data_lines.iter().take(20) {
            for (k, cell) in split_cells(l, delim).into_iter().enumerate().take(columns.len()) {
                let c = cell.trim();
                if c.parse::<f64>().is_err() || c.contains(['e', 'E']) { continue; }
                if let Some(dot) = c.find('.') {
                    decimals[k] = decimals[k].max((c.len() - dot - 1) as u32);
                }
            }
        }
        let approx = if head.is_empty() {
            0
        } else {
            let lines_in_head = head_text.lines().count().max(1) as f64;
            let per_line = head.len() as f64 / lines_in_head;
            ((file_size as f64 / per_line) as u64).saturating_sub(if has_header { 1 } else { 0 })
        };
        Ok(TextSource { path: path.to_string(), delim, delim_name, has_header, columns, approx, decimals })
    }
}

impl RowSource for TextSource {
    fn columns(&self) -> &[String] { &self.columns }
    fn has_header(&self) -> bool { self.has_header }
    fn delimiter_name(&self) -> Option<&'static str> { Some(self.delim_name) }
    fn estimated_points(&self) -> u64 { self.approx }
    fn native_step(&self, xyz: [usize; 3]) -> Option<f64> {
        // Three decimals (a millimetre) at least, six at most: finer than
        // that is noise in any survey, and the record's i32 would not
        // reach across a plot.
        let d = xyz.iter().map(|&i| self.decimals.get(i).copied().unwrap_or(0)).max().unwrap_or(0);
        Some(10f64.powi(-(d.clamp(3, 6) as i32)))
    }
    fn rows(&mut self, f: &mut dyn FnMut(&[f64]) -> Result<bool, String>) -> Result<u64, String> {
        let mut file = BufReader::with_capacity(1 << 20, File::open(&self.path).map_err(|e| format!("open {}: {e}", self.path))?);
        let n_cols = self.columns.len();
        let mut row = vec![f64::NAN; n_cols];
        let mut line = String::new();
        let mut first = true;
        let mut n = 0u64;
        loop {
            line.clear();
            let got = file.read_line(&mut line).map_err(|e| format!("read {}: {e}", self.path))?;
            if got == 0 { break; }
            let t = strip_bom(line.trim());
            if t.is_empty() || t.starts_with('#') || t.starts_with("//") { continue; }
            if first {
                first = false;
                if self.has_header { continue; }
            }
            for v in row.iter_mut() { *v = f64::NAN; }
            for (i, cell) in split_cells(t, self.delim).into_iter().enumerate().take(n_cols) {
                row[i] = parse_f64(Some(&cell)).unwrap_or(f64::NAN);
            }
            n += 1;
            if !f(&row)? { break; }
        }
        Ok(n)
    }
}

// ---- PLY -------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PlyFormat { Ascii, BinaryLe, BinaryBe }

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PlyType { I8, U8, I16, U16, I32, U32, F32, F64 }

impl PlyType {
    fn parse(s: &str) -> Option<PlyType> {
        Some(match s {
            "char" | "int8" => PlyType::I8,
            "uchar" | "uint8" => PlyType::U8,
            "short" | "int16" => PlyType::I16,
            "ushort" | "uint16" => PlyType::U16,
            "int" | "int32" => PlyType::I32,
            "uint" | "uint32" => PlyType::U32,
            "float" | "float32" => PlyType::F32,
            "double" | "float64" => PlyType::F64,
            _ => return None,
        })
    }
    fn size(self) -> usize {
        match self {
            PlyType::I8 | PlyType::U8 => 1,
            PlyType::I16 | PlyType::U16 => 2,
            PlyType::I32 | PlyType::U32 | PlyType::F32 => 4,
            PlyType::F64 => 8,
        }
    }
    fn name(self) -> &'static str {
        match self {
            PlyType::I8 => "char", PlyType::U8 => "uchar", PlyType::I16 => "short", PlyType::U16 => "ushort",
            PlyType::I32 => "int", PlyType::U32 => "uint", PlyType::F32 => "float", PlyType::F64 => "double",
        }
    }
    fn decode(self, b: &[u8], be: bool) -> f64 {
        macro_rules! rd { ($t:ty, $n:expr) => {{ let a: [u8; $n] = b[..$n].try_into().unwrap(); if be { <$t>::from_be_bytes(a) as f64 } else { <$t>::from_le_bytes(a) as f64 } }} }
        match self {
            PlyType::I8 => rd!(i8, 1), PlyType::U8 => rd!(u8, 1),
            PlyType::I16 => rd!(i16, 2), PlyType::U16 => rd!(u16, 2),
            PlyType::I32 => rd!(i32, 4), PlyType::U32 => rd!(u32, 4),
            PlyType::F32 => rd!(f32, 4), PlyType::F64 => rd!(f64, 8),
        }
    }
    fn encode_le(self, v: f64, out: &mut Vec<u8>) {
        match self {
            PlyType::I8 => out.push(v.round().clamp(-128.0, 127.0) as i8 as u8),
            PlyType::U8 => out.push(v.round().clamp(0.0, 255.0) as u8),
            PlyType::I16 => out.extend_from_slice(&(v.round().clamp(-32768.0, 32767.0) as i16).to_le_bytes()),
            PlyType::U16 => out.extend_from_slice(&(v.round().clamp(0.0, 65535.0) as u16).to_le_bytes()),
            PlyType::I32 => out.extend_from_slice(&(v.round().clamp(i32::MIN as f64, i32::MAX as f64) as i32).to_le_bytes()),
            PlyType::U32 => out.extend_from_slice(&(v.round().clamp(0.0, u32::MAX as f64) as u32).to_le_bytes()),
            PlyType::F32 => out.extend_from_slice(&(v as f32).to_le_bytes()),
            PlyType::F64 => out.extend_from_slice(&v.to_le_bytes()),
        }
    }
}

#[derive(Clone, Debug)]
struct PlyProp {
    name: String,
    ty: PlyType,
    /// A list property: the type of its count.
    list_count: Option<PlyType>,
}

#[derive(Clone, Debug)]
struct PlyElement {
    name: String,
    count: u64,
    props: Vec<PlyProp>,
}

struct PlySource {
    path: String,
    format: PlyFormat,
    elements: Vec<PlyElement>,
    /// Byte offset of the first data byte.
    data_start: u64,
    /// The scalar properties of the vertex element, as columns.
    columns: Vec<String>,
    vertex_index: usize,
}

impl PlySource {
    fn open(path: &str) -> Result<Self, String> {
        let mut r = BufReader::new(File::open(path).map_err(|e| format!("open {path}: {e}"))?);
        let mut line = String::new();
        r.read_line(&mut line).map_err(|e| format!("read {path}: {e}"))?;
        if line.trim() != "ply" {
            return Err(format!("{path}: not a PLY file (no 'ply' magic)"));
        }
        let mut format: Option<PlyFormat> = None;
        let mut elements: Vec<PlyElement> = Vec::new();
        let mut data_start = line.len() as u64;
        loop {
            line.clear();
            let got = r.read_line(&mut line).map_err(|e| format!("read {path}: {e}"))?;
            if got == 0 {
                return Err(format!("{path}: header never ends (no end_header)"));
            }
            data_start += got as u64;
            let t = line.trim();
            let mut it = t.split_whitespace();
            match it.next() {
                Some("format") => {
                    format = Some(match it.next() {
                        Some("ascii") => PlyFormat::Ascii,
                        Some("binary_little_endian") => PlyFormat::BinaryLe,
                        Some("binary_big_endian") => PlyFormat::BinaryBe,
                        other => return Err(format!("{path}: unknown PLY format {other:?}")),
                    });
                }
                Some("comment") | Some("obj_info") => {}
                Some("element") => {
                    let name = it.next().ok_or("element without a name")?.to_string();
                    let count: u64 = it.next().and_then(|c| c.parse().ok()).ok_or_else(|| format!("element {name} without a count"))?;
                    elements.push(PlyElement { name, count, props: Vec::new() });
                }
                Some("property") => {
                    let el = elements.last_mut().ok_or("property before any element")?;
                    let first = it.next().ok_or("property without a type")?;
                    if first == "list" {
                        let count_ty = it.next().and_then(PlyType::parse).ok_or("list property without a count type")?;
                        let ty = it.next().and_then(PlyType::parse).ok_or("list property without an item type")?;
                        let name = it.next().ok_or("list property without a name")?.to_string();
                        el.props.push(PlyProp { name, ty, list_count: Some(count_ty) });
                    } else {
                        let ty = PlyType::parse(first).ok_or_else(|| format!("unknown PLY property type '{first}'"))?;
                        let name = it.next().ok_or("property without a name")?.to_string();
                        el.props.push(PlyProp { name, ty, list_count: None });
                    }
                }
                Some("end_header") => break,
                Some(other) => return Err(format!("{path}: unexpected header line '{other}'")),
                None => {}
            }
        }
        let format = format.ok_or_else(|| format!("{path}: header has no format line"))?;
        let vertex_index = elements
            .iter()
            .position(|e| e.name == "vertex")
            .ok_or_else(|| format!("{path}: no 'vertex' element"))?;
        let columns: Vec<String> = elements[vertex_index]
            .props
            .iter()
            .filter(|p| p.list_count.is_none())
            .map(|p| p.name.clone())
            .collect();
        Ok(PlySource { path: path.to_string(), format, elements, data_start, columns, vertex_index })
    }

    /// Read one list element (count + items) of a binary element and
    /// drop it.
    fn skip_binary_element(r: &mut BufReader<File>, el: &PlyElement, be: bool) -> Result<(), String> {
        let fixed: usize = el.props.iter().filter(|p| p.list_count.is_none()).map(|p| p.ty.size()).sum();
        let has_list = el.props.iter().any(|p| p.list_count.is_some());
        if !has_list {
            let bytes = fixed as u64 * el.count;
            r.seek_relative(bytes as i64).map_err(|e| format!("seek: {e}"))?;
            return Ok(());
        }
        let mut buf = [0u8; 8];
        for _ in 0..el.count {
            for p in &el.props {
                match p.list_count {
                    None => {
                        r.read_exact(&mut buf[..p.ty.size()]).map_err(|e| format!("read: {e}"))?;
                    }
                    Some(ct) => {
                        r.read_exact(&mut buf[..ct.size()]).map_err(|e| format!("read: {e}"))?;
                        let n = ct.decode(&buf[..ct.size()], be) as i64;
                        let bytes = n.max(0) * p.ty.size() as i64;
                        r.seek_relative(bytes).map_err(|e| format!("seek: {e}"))?;
                    }
                }
            }
        }
        Ok(())
    }
}

impl RowSource for PlySource {
    fn columns(&self) -> &[String] { &self.columns }
    fn estimated_points(&self) -> u64 { self.elements[self.vertex_index].count }
    fn native_step(&self, _xyz: [usize; 3]) -> Option<f64> { Some(1e-4) }
    fn rows(&mut self, f: &mut dyn FnMut(&[f64]) -> Result<bool, String>) -> Result<u64, String> {
        let mut r = BufReader::with_capacity(1 << 20, File::open(&self.path).map_err(|e| format!("open {}: {e}", self.path))?);
        r.seek(SeekFrom::Start(self.data_start)).map_err(|e| format!("seek: {e}"))?;
        let vertex = self.elements[self.vertex_index].clone();
        let n_cols = self.columns.len();
        let mut row = vec![f64::NAN; n_cols];
        let mut n = 0u64;
        match self.format {
            PlyFormat::Ascii => {
                let mut line = String::new();
                // Elements before the vertices: one line each.
                for el in self.elements.iter().take(self.vertex_index) {
                    for _ in 0..el.count {
                        line.clear();
                        r.read_line(&mut line).map_err(|e| format!("read: {e}"))?;
                    }
                }
                for _ in 0..vertex.count {
                    line.clear();
                    let got = r.read_line(&mut line).map_err(|e| format!("read: {e}"))?;
                    if got == 0 { break; }
                    let mut cells = line.split_whitespace();
                    let mut k = 0usize;
                    for p in &vertex.props {
                        match p.list_count {
                            None => {
                                row[k] = cells.next().and_then(|c| c.parse::<f64>().ok()).unwrap_or(f64::NAN);
                                k += 1;
                            }
                            Some(_) => {
                                let cnt = cells.next().and_then(|c| c.parse::<usize>().ok()).unwrap_or(0);
                                for _ in 0..cnt { cells.next(); }
                            }
                        }
                    }
                    n += 1;
                    if !f(&row)? { break; }
                }
            }
            PlyFormat::BinaryLe | PlyFormat::BinaryBe => {
                let be = self.format == PlyFormat::BinaryBe;
                for el in self.elements.iter().take(self.vertex_index) {
                    PlySource::skip_binary_element(&mut r, el, be)?;
                }
                let has_list = vertex.props.iter().any(|p| p.list_count.is_some());
                let rec: usize = vertex.props.iter().filter(|p| p.list_count.is_none()).map(|p| p.ty.size()).sum();
                let mut buf = vec![0u8; rec.max(8)];
                for _ in 0..vertex.count {
                    if !has_list {
                        if r.read_exact(&mut buf[..rec]).is_err() { break; }
                        let mut o = 0usize;
                        for (k, p) in vertex.props.iter().enumerate() {
                            row[k] = p.ty.decode(&buf[o..o + p.ty.size()], be);
                            o += p.ty.size();
                        }
                    } else {
                        let mut k = 0usize;
                        for p in &vertex.props {
                            match p.list_count {
                                None => {
                                    r.read_exact(&mut buf[..p.ty.size()]).map_err(|e| format!("read: {e}"))?;
                                    row[k] = p.ty.decode(&buf[..p.ty.size()], be);
                                    k += 1;
                                }
                                Some(ct) => {
                                    r.read_exact(&mut buf[..ct.size()]).map_err(|e| format!("read: {e}"))?;
                                    let cnt = ct.decode(&buf[..ct.size()], be).max(0.0) as i64;
                                    r.seek_relative(cnt * p.ty.size() as i64).map_err(|e| format!("seek: {e}"))?;
                                }
                            }
                        }
                    }
                    n += 1;
                    if !f(&row)? { break; }
                }
            }
        }
        Ok(n)
    }
}

// ---- E57 -------------------------------------------------------------

/// A column of an E57 file, as the union of its point clouds' prototypes
/// offers it.
#[derive(Clone, Debug)]
struct E57Col {
    name: String,
    source: E57ColSource,
}

#[derive(Clone, Debug, PartialEq)]
enum E57ColSource {
    X, Y, Z,
    Intensity,
    Red, Green, Blue,
    Time,
    ReturnIndex,
    ReturnCount,
    Row,
    Column,
    /// The 1-based index of the scan the point came from.
    Scan,
    Unknown { namespace: String, name: String },
}

struct E57Source {
    path: String,
    columns: Vec<String>,
    cols: Vec<E57Col>,
    scans: Vec<String>,
    total: u64,
}

impl E57Source {
    fn open(path: &str) -> Result<Self, String> {
        let reader = e57::E57Reader::from_file(Path::new(path)).map_err(|e| format!("open {path}: {e}"))?;
        let pcs = reader.pointclouds();
        if pcs.is_empty() {
            return Err(format!("{path}: no point clouds in this E57"));
        }
        let mut cols: Vec<E57Col> = vec![
            E57Col { name: "x".into(), source: E57ColSource::X },
            E57Col { name: "y".into(), source: E57ColSource::Y },
            E57Col { name: "z".into(), source: E57ColSource::Z },
        ];
        let add = |name: &str, source: E57ColSource, cols: &mut Vec<E57Col>| {
            if !cols.iter().any(|c| c.source == source) {
                cols.push(E57Col { name: name.to_string(), source });
            }
        };
        for pc in &pcs {
            for rec in &pc.prototype {
                use e57::RecordName as R;
                match &rec.name {
                    R::Intensity => add("intensity", E57ColSource::Intensity, &mut cols),
                    R::ColorRed => add("red", E57ColSource::Red, &mut cols),
                    R::ColorGreen => add("green", E57ColSource::Green, &mut cols),
                    R::ColorBlue => add("blue", E57ColSource::Blue, &mut cols),
                    R::TimeStamp => add("gps_time", E57ColSource::Time, &mut cols),
                    R::ReturnIndex => add("return_number", E57ColSource::ReturnIndex, &mut cols),
                    R::ReturnCount => add("number_of_returns", E57ColSource::ReturnCount, &mut cols),
                    R::RowIndex => add("row", E57ColSource::Row, &mut cols),
                    R::ColumnIndex => add("column", E57ColSource::Column, &mut cols),
                    R::Unknown { namespace, name } => {
                        let src = E57ColSource::Unknown { namespace: namespace.clone(), name: name.clone() };
                        add(name, src, &mut cols);
                    }
                    _ => {}
                }
            }
        }
        cols.push(E57Col { name: "scan".into(), source: E57ColSource::Scan });
        // Names unique however the extensions spell theirs.
        let mut names: Vec<String> = Vec::new();
        for c in &cols {
            let mut name = c.name.clone();
            let mut k = 2;
            while names.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
                name = format!("{}_{k}", c.name);
                k += 1;
            }
            names.push(name);
        }
        let scans = pcs
            .iter()
            .enumerate()
            .map(|(i, pc)| pc.name.clone().unwrap_or_else(|| format!("scan {}", i + 1)))
            .collect();
        let total = pcs.iter().map(|pc| pc.records).sum();
        Ok(E57Source { path: path.to_string(), columns: names, cols, scans, total })
    }
}

/// The f64 of a raw E57 value under its record type.
fn e57_f64(v: &e57::RecordValue, dt: &e57::RecordDataType) -> f64 {
    v.to_f64(dt).unwrap_or(f64::NAN)
}

impl RowSource for E57Source {
    fn columns(&self) -> &[String] { &self.columns }
    fn scan_names(&self) -> Vec<String> { self.scans.clone() }
    fn estimated_points(&self) -> u64 { self.total }
    fn native_step(&self, _xyz: [usize; 3]) -> Option<f64> { Some(1e-4) }
    fn rows(&mut self, f: &mut dyn FnMut(&[f64]) -> Result<bool, String>) -> Result<u64, String> {
        use e57::RecordName as R;
        let mut reader = e57::E57Reader::from_file(Path::new(&self.path)).map_err(|e| format!("open {}: {e}", self.path))?;
        let pcs = reader.pointclouds();
        let n_cols = self.cols.len();
        let mut row = vec![f64::NAN; n_cols];
        let mut n = 0u64;
        'scans: for (scan_no, pc) in pcs.iter().enumerate() {
            let proto = &pc.prototype;
            let fi = |name: &R| proto.iter().position(|r| &r.name == name);
            let cart = (fi(&R::CartesianX), fi(&R::CartesianY), fi(&R::CartesianZ));
            let cart_invalid = fi(&R::CartesianInvalidState);
            let sph = (fi(&R::SphericalRange), fi(&R::SphericalAzimuth), fi(&R::SphericalElevation));
            let sph_invalid = fi(&R::SphericalInvalidState);
            let int_invalid = fi(&R::IsIntensityInvalid);
            let col_invalid = fi(&R::IsColorInvalid);
            let time_invalid = fi(&R::IsTimeStampInvalid);
            // Each column's slot in this scan's prototype.
            let slots: Vec<Option<usize>> = self
                .cols
                .iter()
                .map(|c| match &c.source {
                    E57ColSource::Intensity => fi(&R::Intensity),
                    E57ColSource::Red => fi(&R::ColorRed),
                    E57ColSource::Green => fi(&R::ColorGreen),
                    E57ColSource::Blue => fi(&R::ColorBlue),
                    E57ColSource::Time => fi(&R::TimeStamp),
                    E57ColSource::ReturnIndex => fi(&R::ReturnIndex),
                    E57ColSource::ReturnCount => fi(&R::ReturnCount),
                    E57ColSource::Row => fi(&R::RowIndex),
                    E57ColSource::Column => fi(&R::ColumnIndex),
                    E57ColSource::Unknown { namespace, name } => {
                        fi(&R::Unknown { namespace: namespace.clone(), name: name.clone() })
                    }
                    _ => None,
                })
                .collect();
            let pose = super::e57::transform_to_row_major(pc.transform.as_ref());
            let t0 = pc.acquisition_start.as_ref().map(|d| d.gps_time).unwrap_or(0.0);
            let iter = reader.pointcloud_raw(pc).map_err(|e| format!("open scan {}: {e}", scan_no + 1))?;
            for values in iter {
                let values = values.map_err(|e| format!("read point: {e}"))?;
                let val = |i: usize| e57_f64(&values[i], &proto[i].data_type);
                let flag = |i: Option<usize>| i.map(val).unwrap_or(0.0) != 0.0;
                // Position: cartesian when valid, else from spherical.
                let xyz = match cart {
                    (Some(ix), Some(iy), Some(iz)) if !flag(cart_invalid) => Some([val(ix), val(iy), val(iz)]),
                    _ => match sph {
                        (Some(ir), Some(ia), Some(ie)) if !flag(sph_invalid) => {
                            let (r, az, el) = (val(ir), val(ia), val(ie));
                            Some([r * el.cos() * az.cos(), r * el.cos() * az.sin(), r * el.sin()])
                        }
                        _ => None,
                    },
                };
                let Some(p) = xyz else { continue };
                if !(p[0].is_finite() && p[1].is_finite() && p[2].is_finite()) { continue; }
                let w = super::e57::apply_pose_4x4(&pose, p);
                for (k, c) in self.cols.iter().enumerate() {
                    row[k] = match &c.source {
                        E57ColSource::X => w[0],
                        E57ColSource::Y => w[1],
                        E57ColSource::Z => w[2],
                        E57ColSource::Scan => (scan_no + 1) as f64,
                        E57ColSource::Intensity => match slots[k] {
                            Some(i) if !flag(int_invalid) => val(i),
                            _ => f64::NAN,
                        },
                        E57ColSource::Red | E57ColSource::Green | E57ColSource::Blue => match slots[k] {
                            Some(i) if !flag(col_invalid) => val(i),
                            _ => f64::NAN,
                        },
                        E57ColSource::Time => match slots[k] {
                            Some(i) if !flag(time_invalid) => val(i) + t0,
                            _ => f64::NAN,
                        },
                        // E57 counts returns from zero; LAS from one.
                        E57ColSource::ReturnIndex => slots[k].map(|i| val(i) + 1.0).unwrap_or(f64::NAN),
                        _ => slots[k].map(val).unwrap_or(f64::NAN),
                    };
                }
                n += 1;
                if !f(&row)? { break 'scans; }
            }
        }
        Ok(n)
    }
}

// ---------------------------------------------------------------------
// Staging: a source → the LAS the importer takes
// ---------------------------------------------------------------------

/// The columns of the mapping resolved to column indices.
struct Resolved {
    x: usize,
    y: usize,
    z: usize,
    roles: [Option<usize>; 16],
    /// (column index, the column's name as the dataset will carry it)
    extras: Vec<(usize, String)>,
}

fn resolve(mapping: &PointFileMapping, columns: &[String]) -> Result<Resolved, String> {
    let index = |name: &str| -> Result<usize, String> {
        columns
            .iter()
            .position(|c| c.eq_ignore_ascii_case(name.trim()))
            .ok_or_else(|| format!("column '{name}' is not in this file (columns: {})", columns.join(", ")))
    };
    let need = |v: &Option<String>, what: &str| -> Result<usize, String> {
        match v.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(n) => index(n),
            None => Err(format!("the mapping names no {what} column")),
        }
    };
    let x = need(&mapping.x, "X")?;
    let y = need(&mapping.y, "Y")?;
    let z = need(&mapping.z, "Z")?;
    let mut roles = [None; 16];
    for (k, r) in ROLES.iter().enumerate() {
        if let Some(name) = mapping.get(*r) {
            roles[k] = Some(index(name)?);
        }
    }
    let mut extras: Vec<(usize, String)> = Vec::new();
    for name in &mapping.extras {
        let name = name.trim();
        if name.is_empty() { continue; }
        let i = index(name)?;
        if extras.iter().any(|(j, _)| *j == i) { continue; }
        if [x, y, z].contains(&i) { continue; }
        let carried = extra_name(&columns[i]);
        if extras.iter().any(|(_, n)| n.eq_ignore_ascii_case(&carried)) { continue; }
        extras.push((i, carried));
    }
    Ok(Resolved { x, y, z, roles, extras })
}

/// The reserved names the importer gives the role columns, which an
/// extra must not collide with.
const RESERVED: [&str; 20] = [
    "x", "y", "z", "tree_id", "semantic_class", "standing_deadwood", "laying_deadwood", "intensity",
    "classification", "return_number", "number_of_returns", "gps_time", "red", "green", "blue", "nir",
    "scan_angle", "user_data", "point_source_id", "semantic",
];

/// A column name as the dataset carries it: at most 31 bytes (the LAS
/// descriptor's name field), and not one of the record's own names.
fn extra_name(name: &str) -> String {
    let mut n: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    if RESERVED.contains(&norm(&n).as_str()) {
        n = format!("{n}_value");
    }
    while n.len() > 31 {
        n.pop();
    }
    n
}

/// What the staging left for the importer.
#[derive(Debug)]
pub struct StageReport {
    pub points: u64,
    /// Lines or records without a usable position.
    pub skipped: u64,
    /// The names of the columns the importer should carry (`extraNames`).
    pub carried: Vec<String>,
    pub tree_id: bool,
    pub semantic: bool,
    pub standing_deadwood: bool,
    pub laying_deadwood: bool,
}

/// Write `src` as a LAS 1.4 at `out_las` with every mapped column in it.
pub fn stage_to_las(
    progress: ProgressSink,
    src_path: &str,
    kind: PointFileKind,
    mapping: &PointFileMapping,
    out_las: &str,
) -> Result<StageReport, String> {
    use las::{Builder, Color, Point, Transform, Vector, Writer};
    let mut src = open_source(kind, src_path)?;
    let columns = src.columns().to_vec();
    let res = resolve(mapping, &columns)?;
    let ri = |r: Role| res.roles[r.index()];
    let total_hint = src.estimated_points().max(1);

    // Pass 1: bounds, and the ranges that decide how intensity and
    // colour scale into the record.
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    let (mut imin, mut imax) = (f64::INFINITY, f64::NEG_INFINITY);
    let mut cmax = f64::NEG_INFINITY;
    let mut n_ok = 0u64;
    let (ix, iy, iz) = (res.x, res.y, res.z);
    let i_int = ri(Role::Intensity);
    let rgb = (ri(Role::Red), ri(Role::Green), ri(Role::Blue));
    src.rows(&mut |row| {
        let (x, y, z) = (row[ix], row[iy], row[iz]);
        if !(x.is_finite() && y.is_finite() && z.is_finite()) { return Ok(true); }
        for (k, v) in [x, y, z].into_iter().enumerate() {
            if v < lo[k] { lo[k] = v; }
            if v > hi[k] { hi[k] = v; }
        }
        if let Some(i) = i_int {
            let v = row[i];
            if v.is_finite() {
                if v < imin { imin = v; }
                if v > imax { imax = v; }
            }
        }
        for c in [rgb.0, rgb.1, rgb.2].into_iter().flatten() {
            let v = row[c];
            if v.is_finite() && v > cmax { cmax = v; }
        }
        n_ok += 1;
        if n_ok % 262_144 == 0 {
            progress(0.45 * (n_ok as f32 / total_hint as f32).min(1.0));
        }
        Ok(true)
    })?;
    if n_ok == 0 {
        return Err("no point with a finite X, Y and Z — check the column mapping".to_string());
    }
    let iscale = IntensityScale::from_range(imin, imax);
    let cscale = ColourScale::from_max(cmax);

    // The grid: the file's own precision, as long as the i32 reaches
    // across the cloud; the offset at the middle, in whole metres.
    let mut step = src.native_step([ix, iy, iz]).unwrap_or(1e-4);
    let extent = (0..3).map(|k| hi[k] - lo[k]).fold(0.0f64, f64::max);
    while extent / step > 2.0e9 {
        step *= 10.0;
    }
    let offset = [((lo[0] + hi[0]) * 0.5).round(), ((lo[1] + hi[1]) * 0.5).round(), ((lo[2] + hi[2]) * 0.5).round()];

    // The record: LAS 1.4, format 6 — 7 with colour, 8 with NIR — and
    // one 64-bit Extra Bytes dimension per carried column.
    let has_colour = mapping.has_colour();
    let has_nir = ri(Role::Nir).is_some();
    let fmt = if has_nir { 8 } else if has_colour { 7 } else { 6 };
    // Extra Bytes: the role columns the octree keeps as its own fields
    // first, under the names the importer reads them by, then the extras.
    let mut eb: Vec<(String, usize)> = Vec::new();
    if let Some(i) = ri(Role::TreeId) { eb.push(("tree_id".into(), i)); }
    if let Some(i) = ri(Role::Semantic) { eb.push(("semantic_class".into(), i)); }
    if let Some(i) = ri(Role::StandingDeadwood) { eb.push(("standing_deadwood".into(), i)); }
    if let Some(i) = ri(Role::LayingDeadwood) { eb.push(("laying_deadwood".into(), i)); }
    for (i, name) in &res.extras {
        eb.push((name.clone(), *i));
    }
    let mut builder = Builder::from((1, 4));
    let mut format = las::point::Format::new(fmt).map_err(|e| format!("las format: {e}"))?;
    format.extra_bytes = (eb.len() * 8) as u16;
    builder.point_format = format;
    builder.transforms = Vector {
        x: Transform { scale: step, offset: offset[0] },
        y: Transform { scale: step, offset: offset[1] },
        z: Transform { scale: step, offset: offset[2] },
    };
    builder.generating_software = "PointCloudLabeler file import".to_string();
    if ri(Role::GpsTime).is_some() {
        builder.gps_time_type = las::GpsTimeType::Standard;
    }
    if !eb.is_empty() {
        let mut data = vec![0u8; eb.len() * 192];
        for (k, (name, _)) in eb.iter().enumerate() {
            let base = k * 192;
            data[base + 2] = 10; // f64
            let nb = name.as_bytes();
            let n = nb.len().min(31);
            data[base + 4..base + 4 + n].copy_from_slice(&nb[..n]);
            let desc = format!("PointCloudLabeler column '{name}'");
            let db = desc.as_bytes();
            let d = db.len().min(31);
            data[base + 160..base + 160 + d].copy_from_slice(&db[..d]);
        }
        builder.vlrs.push(las::Vlr {
            user_id: "LASF_Spec".to_string(),
            record_id: 4,
            description: "PointCloudLabeler columns".to_string(),
            data,
        });
    }
    let header = builder.into_header().map_err(|e| format!("build las header: {e}"))?;
    let mut writer = Writer::from_path(out_las, header).map_err(|e| format!("create {out_las}: {e}"))?;

    // Pass 2: the points.
    let mut written = 0u64;
    let mut skipped = 0u64;
    let mut seen = 0u64;
    let cell = |row: &[f64], r: Role| -> Option<f64> { ri(r).map(|i| row[i]).filter(|v| v.is_finite()) };
    let mut extra_bytes = vec![0u8; eb.len() * 8];
    let mut result = src.rows(&mut |row| {
        seen += 1;
        if seen % 262_144 == 0 {
            progress(0.45 + 0.5 * (seen as f32 / total_hint as f32).min(1.0));
        }
        let (x, y, z) = (row[ix], row[iy], row[iz]);
        if !(x.is_finite() && y.is_finite() && z.is_finite()) {
            skipped += 1;
            return Ok(true);
        }
        let to_u8 = |v: Option<f64>| v.map(|v| v.round().clamp(0.0, 255.0) as u8).unwrap_or(0);
        let to_u16 = |v: Option<f64>| v.map(|v| v.round().clamp(0.0, 65535.0) as u16).unwrap_or(0);
        let ret = cell(row, Role::ReturnNumber).map(|v| v.round().clamp(1.0, 15.0) as u8).unwrap_or(1);
        let nret = cell(row, Role::NumberOfReturns).map(|v| v.round().clamp(1.0, 15.0) as u8).unwrap_or(ret.max(1));
        let mut p = Point {
            x, y, z,
            intensity: cell(row, Role::Intensity).map(|v| iscale.map(v)).unwrap_or(0),
            return_number: ret,
            number_of_returns: nret.max(ret),
            classification: las::point::Classification::new(to_u8(cell(row, Role::Classification)))
                .unwrap_or(las::point::Classification::Unclassified),
            scan_angle: cell(row, Role::ScanAngle).map(|v| v.clamp(-180.0, 180.0) as f32).unwrap_or(0.0),
            user_data: to_u8(cell(row, Role::UserData)),
            point_source_id: to_u16(cell(row, Role::PointSourceId)),
            gps_time: Some(cell(row, Role::GpsTime).unwrap_or(0.0)),
            ..Default::default()
        };
        if has_colour {
            let (r, g, b) = cscale.map_rgb(
                cell(row, Role::Red).unwrap_or(0.0),
                cell(row, Role::Green).unwrap_or(0.0),
                cell(row, Role::Blue).unwrap_or(0.0),
            );
            p.color = Some(Color { red: r, green: g, blue: b });
        } else if fmt == 8 {
            p.color = Some(Color { red: 0, green: 0, blue: 0 });
        }
        if has_nir {
            p.nir = Some(cell(row, Role::Nir).map(|v| cscale.map(v)).unwrap_or(0));
        }
        for (k, (_, i)) in eb.iter().enumerate() {
            let v = row[*i];
            extra_bytes[k * 8..k * 8 + 8].copy_from_slice(&(if v.is_finite() { v } else { 0.0 }).to_le_bytes());
        }
        p.extra_bytes = extra_bytes.clone();
        writer.write_point(p).map_err(|e| format!("write point: {e}"))?;
        written += 1;
        Ok(true)
    });
    if let Err(e) = writer.close().map_err(|e| format!("close {out_las}: {e}")) {
        result = result.and(Err(e));
    }
    result?;
    progress(1.0);
    let mut carried: Vec<String> = res.extras.iter().map(|(_, n)| n.clone()).collect();
    for (r, name) in [
        (Role::GpsTime, "gps_time"), (Role::Red, "red"), (Role::Green, "green"), (Role::Blue, "blue"),
        (Role::Nir, "nir"), (Role::ScanAngle, "scan_angle"), (Role::UserData, "user_data"),
        (Role::PointSourceId, "point_source_id"),
    ] {
        if ri(r).is_some() && !carried.iter().any(|c| c.eq_ignore_ascii_case(name)) {
            carried.push(name.to_string());
        }
    }
    Ok(StageReport {
        points: written,
        skipped,
        carried,
        tree_id: ri(Role::TreeId).is_some(),
        semantic: ri(Role::Semantic).is_some(),
        standing_deadwood: ri(Role::StandingDeadwood).is_some(),
        laying_deadwood: ri(Role::LayingDeadwood).is_some(),
    })
}

/// A text, PLY or E57 file into a dataset: staged as a LAS inside the
/// dataset directory, converted, the staging file removed.
#[allow(clippy::too_many_arguments)]
pub fn import_pointfile(
    progress: StagedSink,
    src_path: &str,
    out_dir: &str,
    name: &str,
    scanner_type: &str,
    root_spacing: f64,
    max_depth: u32,
    mapping: &PointFileMapping,
    include_deadwood: bool,
) -> Result<OctreeImportResult, String> {
    let kind = PointFileKind::of_path(src_path)
        .ok_or_else(|| format!("{src_path}: not a text, PLY or E57 point file"))?;
    std::fs::create_dir_all(out_dir).map_err(|e| format!("create {out_dir}: {e}"))?;
    let staged = Path::new(out_dir).join(".import_stage.las");
    let staged_s = staged.to_string_lossy().into_owned();
    progress("stage", 0.0);
    let stage = |pct: f32| progress("stage", pct);
    let report = match stage_to_las(&stage, src_path, kind, mapping, &staged_s) {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_file(&staged);
            return Err(e);
        }
    };
    let result = run_convert(
        progress,
        &staged_s,
        out_dir,
        name,
        scanner_type,
        root_spacing,
        max_depth,
        if report.tree_id { "tree_id" } else { "" },
        if report.semantic { "semantic_class" } else { "" },
        if report.standing_deadwood { "standing_deadwood" } else { "" },
        if report.laying_deadwood { "laying_deadwood" } else { "" },
        &report.carried,
        include_deadwood,
    );
    let _ = std::fs::remove_file(&staged);
    result
}

// ---------------------------------------------------------------------
// Writing: the exporter's LAS → text / PLY / E57
// ---------------------------------------------------------------------

/// How a text export is laid out.
#[derive(Clone, Debug)]
pub struct TextOptions {
    pub delimiter: char,
    pub header: bool,
    /// Decimal places for X, Y and Z; None writes the shortest text
    /// that reads back to the same number.
    pub decimals: Option<u32>,
}

impl Default for TextOptions {
    fn default() -> Self {
        TextOptions { delimiter: ' ', header: true, decimals: None }
    }
}

pub fn delimiter_from_name(name: &str) -> char {
    name_to_delim(name.trim().to_ascii_lowercase().as_str())
}

/// Where a column of the output comes from in a LAS point.
#[derive(Clone, Debug, PartialEq)]
enum OutSrc {
    X, Y, Z,
    Intensity, ReturnNumber, NumberOfReturns, Classification,
    GpsTime, Red, Green, Blue, Nir, ScanAngle, UserData, PointSourceId,
    ScanDirection, EdgeOfFlightLine, Synthetic, KeyPoint, Withheld, Overlap, ScannerChannel,
    Extra(usize),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OutType { F64, F32, U8, I8, U16, I16, U32, I32, I64 }

#[derive(Clone, Debug)]
struct OutCol {
    name: String,
    src: OutSrc,
    ty: OutType,
}

/// The columns an export carries: X Y Z, the record's own fields, each
/// standard field the dataset carried as a column (`carried`, by
/// reserved name — the exporter wrote zeros in the others), and every
/// Extra Bytes dimension.
fn out_columns(header: &las::Header, dims: &[LasExtraDim], carried: &[String]) -> Vec<OutCol> {
    let f = header.point_format();
    let has = |n: &str| carried.iter().any(|c| c.eq_ignore_ascii_case(n));
    let mut cols = vec![
        OutCol { name: "x".into(), src: OutSrc::X, ty: OutType::F64 },
        OutCol { name: "y".into(), src: OutSrc::Y, ty: OutType::F64 },
        OutCol { name: "z".into(), src: OutSrc::Z, ty: OutType::F64 },
        OutCol { name: "intensity".into(), src: OutSrc::Intensity, ty: OutType::U16 },
        OutCol { name: "return_number".into(), src: OutSrc::ReturnNumber, ty: OutType::U8 },
        OutCol { name: "number_of_returns".into(), src: OutSrc::NumberOfReturns, ty: OutType::U8 },
        OutCol { name: "classification".into(), src: OutSrc::Classification, ty: OutType::U8 },
    ];
    if f.has_gps_time && has("gps_time") {
        cols.push(OutCol { name: "gps_time".into(), src: OutSrc::GpsTime, ty: OutType::F64 });
    }
    if f.has_color && has("red") {
        cols.push(OutCol { name: "red".into(), src: OutSrc::Red, ty: OutType::U16 });
        cols.push(OutCol { name: "green".into(), src: OutSrc::Green, ty: OutType::U16 });
        cols.push(OutCol { name: "blue".into(), src: OutSrc::Blue, ty: OutType::U16 });
    }
    if f.has_nir && has("nir") {
        cols.push(OutCol { name: "nir".into(), src: OutSrc::Nir, ty: OutType::U16 });
    }
    for (name, src, ty) in [
        ("scan_angle", OutSrc::ScanAngle, OutType::F32),
        ("user_data", OutSrc::UserData, OutType::U8),
        ("point_source_id", OutSrc::PointSourceId, OutType::U16),
        ("scan_direction", OutSrc::ScanDirection, OutType::U8),
        ("edge_of_flight_line", OutSrc::EdgeOfFlightLine, OutType::U8),
        ("synthetic", OutSrc::Synthetic, OutType::U8),
        ("key_point", OutSrc::KeyPoint, OutType::U8),
        ("withheld", OutSrc::Withheld, OutType::U8),
        ("overlap", OutSrc::Overlap, OutType::U8),
        ("scanner_channel", OutSrc::ScannerChannel, OutType::U8),
    ] {
        if has(name) {
            cols.push(OutCol { name: name.into(), src, ty });
        }
    }
    for (i, d) in dims.iter().enumerate() {
        if d.size == 0 { continue; }
        let scaled = d.val_scale != 1.0 || d.val_offset != 0.0;
        let ty = if scaled {
            OutType::F64
        } else {
            match d.data_type {
                1 => OutType::U8, 2 => OutType::I8, 3 => OutType::U16, 4 => OutType::I16,
                5 => OutType::U32, 6 => OutType::I32, 7 | 8 => OutType::I64, 9 => OutType::F32,
                _ => OutType::F64,
            }
        };
        let name = if d.name.is_empty() { format!("extra_{}", i + 1) } else { d.name.clone() };
        cols.push(OutCol { name, src: OutSrc::Extra(i), ty });
    }
    cols
}

fn out_value(p: &las::Point, dims: &[LasExtraDim], src: &OutSrc) -> f64 {
    match src {
        OutSrc::X => p.x,
        OutSrc::Y => p.y,
        OutSrc::Z => p.z,
        OutSrc::Intensity => p.intensity as f64,
        OutSrc::ReturnNumber => p.return_number as f64,
        OutSrc::NumberOfReturns => p.number_of_returns as f64,
        OutSrc::Classification => u8::from(p.classification) as f64,
        OutSrc::GpsTime => p.gps_time.unwrap_or(0.0),
        OutSrc::Red => p.color.map(|c| c.red as f64).unwrap_or(0.0),
        OutSrc::Green => p.color.map(|c| c.green as f64).unwrap_or(0.0),
        OutSrc::Blue => p.color.map(|c| c.blue as f64).unwrap_or(0.0),
        OutSrc::Nir => p.nir.unwrap_or(0) as f64,
        OutSrc::ScanAngle => p.scan_angle as f64,
        OutSrc::UserData => p.user_data as f64,
        OutSrc::PointSourceId => p.point_source_id as f64,
        OutSrc::ScanDirection => (p.scan_direction == las::point::ScanDirection::LeftToRight) as u8 as f64,
        OutSrc::EdgeOfFlightLine => p.is_edge_of_flight_line as u8 as f64,
        OutSrc::Synthetic => p.is_synthetic as u8 as f64,
        OutSrc::KeyPoint => p.is_key_point as u8 as f64,
        OutSrc::Withheld => p.is_withheld as u8 as f64,
        OutSrc::Overlap => p.is_overlap as u8 as f64,
        OutSrc::ScannerChannel => p.scanner_channel as f64,
        OutSrc::Extra(i) => read_extra_raw_f64(&p.extra_bytes, &dims[*i], p.extra_bytes.len(), 0),
    }
}

/// A value as text: integers as integers, floats as the shortest text
/// that reads back to the same number — the value as it was.
fn fmt_value(v: f64, ty: OutType, decimals: Option<u32>) -> String {
    match ty {
        OutType::F64 | OutType::F32 => match decimals {
            Some(d) => format!("{v:.*}", d as usize),
            None => {
                if v.is_finite() && v == v.trunc() && v.abs() < 1e15 { format!("{}", v as i64) } else { format!("{v}") }
            }
        },
        _ => format!("{}", v.round() as i64),
    }
}

fn ply_type(ty: OutType) -> PlyType {
    match ty {
        OutType::F64 | OutType::I64 => PlyType::F64,
        OutType::F32 => PlyType::F32,
        OutType::U8 => PlyType::U8,
        OutType::I8 => PlyType::I8,
        OutType::U16 => PlyType::U16,
        OutType::I16 => PlyType::I16,
        OutType::U32 => PlyType::U32,
        OutType::I32 => PlyType::I32,
    }
}

/// A name PLY and E57 accept: letters, digits and underscores, not
/// starting with a digit or "xml".
fn attr_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    if s.is_empty() || s.starts_with(|c: char| c.is_ascii_digit()) || s.to_ascii_lowercase().starts_with("xml") {
        s = format!("c_{s}");
    }
    s
}

/// Transcode the LAS at `las_path` to `out_path` as `kind`. `carried`
/// names the standard fields the dataset held as columns.
pub fn write_from_las(
    progress: ProgressSink,
    kind: PointFileKind,
    las_path: &str,
    out_path: &str,
    carried: &[String],
    text: &TextOptions,
    ply_ascii: bool,
) -> Result<u64, String> {
    let mut reader = las::Reader::from_path(las_path).map_err(|e| format!("open {las_path}: {e}"))?;
    let header = reader.header().clone();
    let dims = parse_extra_dims(header.vlrs());
    let cols = out_columns(&header, &dims, carried);
    let total = header.number_of_points();
    match kind {
        PointFileKind::Text => write_text(progress, &mut reader, &dims, &cols, total, out_path, text),
        PointFileKind::Ply => write_ply(progress, &mut reader, &dims, &cols, total, out_path, ply_ascii),
        PointFileKind::E57 => write_e57(progress, &mut reader, &header, &dims, &cols, total, out_path),
    }
}

fn write_text(
    progress: ProgressSink,
    reader: &mut las::Reader,
    dims: &[LasExtraDim],
    cols: &[OutCol],
    total: u64,
    out_path: &str,
    text: &TextOptions,
) -> Result<u64, String> {
    let mut w = BufWriter::with_capacity(1 << 20, File::create(out_path).map_err(|e| format!("create {out_path}: {e}"))?);
    let d = text.delimiter.to_string();
    if text.header {
        let names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
        writeln!(w, "{}", names.join(&d)).map_err(|e| format!("write {out_path}: {e}"))?;
    }
    let mut n = 0u64;
    let mut line = String::new();
    for p in reader.points() {
        let p = p.map_err(|e| format!("read point: {e}"))?;
        line.clear();
        for (k, c) in cols.iter().enumerate() {
            if k > 0 { line.push_str(&d); }
            let v = out_value(&p, dims, &c.src);
            let dec = if matches!(c.src, OutSrc::X | OutSrc::Y | OutSrc::Z) { text.decimals } else { None };
            line.push_str(&fmt_value(v, c.ty, dec));
        }
        line.push('\n');
        w.write_all(line.as_bytes()).map_err(|e| format!("write {out_path}: {e}"))?;
        n += 1;
        if n % 200_000 == 0 {
            progress(0.9 + 0.1 * (n as f32 / total.max(1) as f32).min(1.0));
        }
    }
    w.flush().map_err(|e| format!("write {out_path}: {e}"))?;
    Ok(n)
}

fn write_ply(
    progress: ProgressSink,
    reader: &mut las::Reader,
    dims: &[LasExtraDim],
    cols: &[OutCol],
    total: u64,
    out_path: &str,
    ascii: bool,
) -> Result<u64, String> {
    let mut w = BufWriter::with_capacity(1 << 20, File::create(out_path).map_err(|e| format!("create {out_path}: {e}"))?);
    let mut header = String::new();
    header.push_str("ply\n");
    header.push_str(if ascii { "format ascii 1.0\n" } else { "format binary_little_endian 1.0\n" });
    header.push_str("comment PointCloudLabeler export\n");
    header.push_str(&format!("element vertex {total}\n"));
    let mut names: Vec<String> = Vec::new();
    for c in cols {
        let mut name = attr_name(&c.name);
        let mut k = 2;
        while names.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
            name = format!("{}_{k}", attr_name(&c.name));
            k += 1;
        }
        header.push_str(&format!("property {} {}\n", ply_type(c.ty).name(), name));
        names.push(name);
    }
    header.push_str("end_header\n");
    w.write_all(header.as_bytes()).map_err(|e| format!("write {out_path}: {e}"))?;
    let mut n = 0u64;
    let mut buf: Vec<u8> = Vec::with_capacity(cols.len() * 8);
    let mut line = String::new();
    for p in reader.points() {
        let p = p.map_err(|e| format!("read point: {e}"))?;
        if ascii {
            line.clear();
            for (k, c) in cols.iter().enumerate() {
                if k > 0 { line.push(' '); }
                line.push_str(&fmt_value(out_value(&p, dims, &c.src), c.ty, None));
            }
            line.push('\n');
            w.write_all(line.as_bytes()).map_err(|e| format!("write {out_path}: {e}"))?;
        } else {
            buf.clear();
            for c in cols {
                ply_type(c.ty).encode_le(out_value(&p, dims, &c.src), &mut buf);
            }
            w.write_all(&buf).map_err(|e| format!("write {out_path}: {e}"))?;
        }
        n += 1;
        if n % 200_000 == 0 {
            progress(0.9 + 0.1 * (n as f32 / total.max(1) as f32).min(1.0));
        }
    }
    w.flush().map_err(|e| format!("write {out_path}: {e}"))?;
    if n != total {
        return Err(format!("the LAS header counts {total} points but {n} were read; the PLY header is wrong"));
    }
    Ok(n)
}

/// The namespace the record's other columns go out under.
const E57_NAMESPACE: &str = "pcl";

fn write_e57(
    progress: ProgressSink,
    reader: &mut las::Reader,
    header: &las::Header,
    dims: &[LasExtraDim],
    cols: &[OutCol],
    total: u64,
    out_path: &str,
) -> Result<u64, String> {
    use e57::{Record, RecordDataType, RecordName, RecordValue};
    let guid = format!(
        "pointcloudlabeler-{:x}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
    );
    let mut writer = e57::E57Writer::from_file(out_path, &guid).map_err(|e| format!("create {out_path}: {e}"))?;
    writer
        .register_extension(e57::Extension::new(E57_NAMESPACE, "urn:pointcloudlabeler:e57:columns"))
        .map_err(|e| format!("e57 extension: {e}"))?;
    // The prototype: the standard attributes where E57 has them, the
    // rest under the extension. Integer records carry their range.
    let int = |min: i64, max: i64| RecordDataType::Integer { min, max };
    let mut proto: Vec<Record> = Vec::with_capacity(cols.len());
    let mut names: Vec<String> = Vec::new();
    for c in cols {
        let name = match &c.src {
            OutSrc::X => RecordName::CartesianX,
            OutSrc::Y => RecordName::CartesianY,
            OutSrc::Z => RecordName::CartesianZ,
            OutSrc::Intensity => RecordName::Intensity,
            OutSrc::Red => RecordName::ColorRed,
            OutSrc::Green => RecordName::ColorGreen,
            OutSrc::Blue => RecordName::ColorBlue,
            OutSrc::GpsTime => RecordName::TimeStamp,
            OutSrc::ReturnNumber => RecordName::ReturnIndex,
            OutSrc::NumberOfReturns => RecordName::ReturnCount,
            _ => {
                let mut n = attr_name(&c.name);
                let mut k = 2;
                while names.iter().any(|m| m.eq_ignore_ascii_case(&n)) {
                    n = format!("{}_{k}", attr_name(&c.name));
                    k += 1;
                }
                names.push(n.clone());
                RecordName::Unknown { namespace: E57_NAMESPACE.to_string(), name: n }
            }
        };
        let data_type = match (&c.src, c.ty) {
            // E57 counts returns from zero.
            (OutSrc::ReturnNumber, _) => int(0, 14),
            (OutSrc::NumberOfReturns, _) => int(0, 15),
            (_, OutType::F64) => RecordDataType::F64,
            (_, OutType::F32) => RecordDataType::F32,
            (_, OutType::U8) => int(0, 255),
            (_, OutType::I8) => int(-128, 127),
            (_, OutType::U16) => int(0, 65535),
            (_, OutType::I16) => int(-32768, 32767),
            (_, OutType::U32) => int(0, u32::MAX as i64),
            (_, OutType::I32) => int(i32::MIN as i64, i32::MAX as i64),
            (_, OutType::I64) => RecordDataType::F64,
        };
        proto.push(Record { name, data_type });
    }
    let mut pcw = writer.add_pointcloud(&format!("{guid}-points"), proto.clone()).map_err(|e| format!("e57 point cloud: {e}"))?;
    pcw.set_name(Some("PointCloudLabeler export".to_string()));
    if cols.iter().any(|c| c.src == OutSrc::Intensity) {
        pcw.set_intensity_limits(Some(e57::IntensityLimits {
            intensity_min: Some(RecordValue::Integer(0)),
            intensity_max: Some(RecordValue::Integer(65535)),
        }));
    }
    if cols.iter().any(|c| c.src == OutSrc::Red) {
        pcw.set_color_limits(Some(e57::ColorLimits {
            red_min: Some(RecordValue::Integer(0)), red_max: Some(RecordValue::Integer(65535)),
            green_min: Some(RecordValue::Integer(0)), green_max: Some(RecordValue::Integer(65535)),
            blue_min: Some(RecordValue::Integer(0)), blue_max: Some(RecordValue::Integer(65535)),
        }));
    }
    let b = header.bounds();
    pcw.set_cartesian_bounds(Some(e57::CartesianBounds {
        x_min: Some(b.min.x), x_max: Some(b.max.x),
        y_min: Some(b.min.y), y_max: Some(b.max.y),
        z_min: Some(b.min.z), z_max: Some(b.max.z),
    }));
    let mut n = 0u64;
    let mut values: Vec<RecordValue> = Vec::with_capacity(cols.len());
    for p in reader.points() {
        let p = p.map_err(|e| format!("read point: {e}"))?;
        values.clear();
        for (c, rec) in cols.iter().zip(proto.iter()) {
            let mut v = out_value(&p, dims, &c.src);
            if matches!(c.src, OutSrc::ReturnNumber) { v -= 1.0; }
            values.push(match &rec.data_type {
                RecordDataType::Double { .. } => RecordValue::Double(if v.is_finite() { v } else { 0.0 }),
                RecordDataType::Single { .. } => RecordValue::Single(if v.is_finite() { v as f32 } else { 0.0 }),
                RecordDataType::Integer { min, max } => {
                    RecordValue::Integer(if v.is_finite() { (v.round() as i64).clamp(*min, *max) } else { (*min).max(0).min(*max) })
                }
                RecordDataType::ScaledInteger { .. } => RecordValue::ScaledInteger(v.round() as i64),
            });
        }
        pcw.add_point(values.clone()).map_err(|e| format!("e57 point: {e}"))?;
        n += 1;
        if n % 200_000 == 0 {
            progress(0.9 + 0.1 * (n as f32 / total.max(1) as f32).min(1.0));
        }
    }
    pcw.finalize().map_err(|e| format!("e57 point cloud: {e}"))?;
    writer.finalize().map_err(|e| format!("finish {out_path}: {e}"))?;
    Ok(n)
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pcl-pointfile-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A text file with a header, nine columns, the kind a scanner's
    /// software exports: a dB reflectance beside the intensity, a tree
    /// id, a GPS time with microseconds, and colour as bytes.
    fn write_text_fixture(path: &Path) -> Vec<[f64; 9]> {
        let mut rows = Vec::new();
        let mut s = String::from("X,Y,Z,Intensity,Reflectance,tree_id,gps_time,red,green,blue\n");
        for i in 0..200 {
            let r = [
                500000.0 + i as f64 * 0.013,
                6800000.0 + (i % 17) as f64 * 0.021,
                100.0 + (i % 5) as f64 * 0.5,
                (i * 37 % 1000) as f64,
                -12.5 + (i % 9) as f64 * 0.125,
                (i % 4) as f64,
                1_234_567.000001 + i as f64 * 0.000001,
                (i % 256) as f64,
                ((i * 3) % 256) as f64,
                ((i * 7) % 256) as f64,
            ];
            s.push_str(&format!(
                "{:.3},{:.3},{:.3},{},{},{},{:.6},{},{},{}\n",
                r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9]
            ));
            rows.push([r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]]);
        }
        std::fs::write(path, s).unwrap();
        rows
    }

    #[test]
    fn the_kind_follows_the_extension() {
        assert_eq!(PointFileKind::of_path("a/b.TXT"), Some(PointFileKind::Text));
        assert_eq!(PointFileKind::of_path("b.xyz"), Some(PointFileKind::Text));
        assert_eq!(PointFileKind::of_path("b.csv"), Some(PointFileKind::Text));
        assert_eq!(PointFileKind::of_path("c.ply"), Some(PointFileKind::Ply));
        assert_eq!(PointFileKind::of_path("d.e57"), Some(PointFileKind::E57));
        assert_eq!(PointFileKind::of_path("e.las"), None);
        assert_eq!(PointFileKind::of_path("e.laz"), None);
        assert_eq!(PointFileKind::of_path("noext"), None);
    }

    /// The probe names the columns as the header spells them, guesses
    /// the roles by name, and leaves the rest as extras — reflectance
    /// among them, exact, while also standing in for nothing because
    /// the file has an intensity.
    #[test]
    fn a_text_header_is_mapped_by_name() {
        let dir = scratch("probe");
        let path = dir.join("cloud.txt");
        write_text_fixture(&path);
        let p = probe(path.to_str().unwrap()).unwrap();
        assert_eq!(p.kind, PointFileKind::Text);
        assert!(p.has_header);
        assert_eq!(p.delimiter.as_deref(), Some("comma"));
        assert_eq!(p.columns, ["X", "Y", "Z", "Intensity", "Reflectance", "tree_id", "gps_time", "red", "green", "blue"]);
        let m = &p.suggested;
        assert_eq!(m.x.as_deref(), Some("X"));
        assert_eq!(m.z.as_deref(), Some("Z"));
        assert_eq!(m.intensity.as_deref(), Some("Intensity"));
        assert_eq!(m.tree_id.as_deref(), Some("tree_id"));
        assert_eq!(m.gps_time.as_deref(), Some("gps_time"));
        assert_eq!(m.red.as_deref(), Some("red"));
        assert_eq!(m.extras, ["Reflectance"]);
        assert_eq!(p.preview.len(), 10);
        assert_eq!(p.preview[0].len(), 10);
        assert!(p.approx_point_count > 150 && p.approx_point_count < 250, "{}", p.approx_point_count);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No header: the columns are numbered and the classic layouts are
    /// guessed by position. A reflectance stands in for a missing
    /// intensity without leaving the extras.
    #[test]
    fn a_headerless_file_is_mapped_by_position() {
        let dir = scratch("headerless");
        let path = dir.join("cloud.xyz");
        std::fs::write(&path, "1.0 2.0 3.0 0.5 10 20 30\n1.1 2.1 3.1 0.7 11 21 31\n").unwrap();
        let p = probe(path.to_str().unwrap()).unwrap();
        assert!(!p.has_header);
        assert_eq!(p.columns.len(), 7);
        assert_eq!(p.suggested.x.as_deref(), Some("column_1"));
        assert_eq!(p.suggested.intensity.as_deref(), Some("column_4"));
        assert_eq!(p.suggested.blue.as_deref(), Some("column_7"));
        assert!(p.suggested.extras.is_empty());

        let m = suggest_mapping(&["x", "y", "z", "amplitude", "reflectance", "deviation"].map(String::from));
        assert_eq!(m.intensity.as_deref(), Some("amplitude"), "the amplitude stands in for the intensity");
        assert_eq!(m.extras, ["amplitude", "reflectance", "deviation"], "and stays exact; the reflectance is its own column");
        let m = suggest_mapping(&["x", "y", "z", "reflectance"].map(String::from));
        assert!(m.intensity.is_none(), "a reflectance is not an intensity");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A column the mapping names but the file lacks is refused before
    /// anything is written.
    #[test]
    fn a_missing_column_is_refused() {
        let dir = scratch("missing");
        let path = dir.join("cloud.txt");
        write_text_fixture(&path);
        let mut m = suggest_mapping(&probe(path.to_str().unwrap()).unwrap().columns);
        m.semantic = Some("label".into());
        let out = dir.join("stage.las");
        let err = stage_to_las(&|_| {}, path.to_str().unwrap(), PointFileKind::Text, &m, out.to_str().unwrap()).unwrap_err();
        assert!(err.contains("'label'"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Text → LAS: the record's fields where they go, the extras as
    /// doubles, the GPS time to the microsecond, the coordinates on the
    /// file's own millimetre grid.
    #[test]
    fn a_text_file_stages_as_a_las_with_every_column() {
        let dir = scratch("stage");
        let path = dir.join("cloud.txt");
        let rows = write_text_fixture(&path);
        let p = probe(path.to_str().unwrap()).unwrap();
        let out = dir.join("stage.las");
        let rep = stage_to_las(&|_| {}, path.to_str().unwrap(), PointFileKind::Text, &p.suggested, out.to_str().unwrap()).unwrap();
        assert_eq!(rep.points, 200);
        assert_eq!(rep.skipped, 0);
        assert!(rep.tree_id);
        assert_eq!(rep.carried, ["Reflectance", "gps_time", "red", "green", "blue"]);

        let mut r = las::Reader::from_path(&out).unwrap();
        let h = r.header().clone();
        assert_eq!(h.point_format().to_u8().unwrap(), 7);
        assert_eq!(h.number_of_points(), 200);
        let tr = h.transforms();
        assert!((tr.x.scale - 0.001).abs() < 1e-12, "{}", tr.x.scale);
        let dims = parse_extra_dims(h.vlrs());
        assert_eq!(dims.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(), ["tree_id", "Reflectance"]);
        let pts: Vec<las::Point> = r.points().map(|p| p.unwrap()).collect();
        for (p, want) in pts.iter().zip(rows.iter()) {
            assert!((p.x - want[0]).abs() < 1e-9 && (p.y - want[1]).abs() < 1e-9 && (p.z - want[2]).abs() < 1e-9);
            assert!((p.gps_time.unwrap() - want[6]).abs() < 1e-7);
            let refl = read_extra_raw_f64(&p.extra_bytes, &dims[1], 16, 0);
            assert_eq!(refl, want[4]);
            let tid = read_extra_raw_f64(&p.extra_bytes, &dims[0], 16, 0);
            assert_eq!(tid, want[5]);
            // Colour bytes scale to 16 bits; intensity 0..999 to 16 bits.
            let c = p.color.unwrap();
            assert_eq!(c.red, ColourScale::Byte255.map(want[7]));
            assert_eq!(p.intensity, IntensityScale::Legacy2047.map(want[3]));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Out again as text, PLY (both encodings) and E57, and back in
    /// through the same readers: every column equal to what the LAS
    /// held.
    #[test]
    fn a_las_goes_out_as_text_ply_and_e57_and_reads_back() {
        let dir = scratch("roundtrip");
        let path = dir.join("cloud.txt");
        write_text_fixture(&path);
        let p = probe(path.to_str().unwrap()).unwrap();
        let staged = dir.join("stage.las");
        stage_to_las(&|_| {}, path.to_str().unwrap(), PointFileKind::Text, &p.suggested, staged.to_str().unwrap()).unwrap();
        let carried = vec!["gps_time".to_string(), "red".into(), "green".into(), "blue".into()];
        let las_s = staged.to_str().unwrap();

        // The LAS as the reference.
        let mut r = las::Reader::from_path(&staged).unwrap();
        let dims = parse_extra_dims(r.header().vlrs());
        let cols = out_columns(r.header(), &dims, &carried);
        assert_eq!(
            cols.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["x", "y", "z", "intensity", "return_number", "number_of_returns", "classification", "gps_time", "red", "green", "blue", "tree_id", "Reflectance"]
        );
        let reference: Vec<Vec<f64>> = r
            .points()
            .map(|p| { let p = p.unwrap(); cols.iter().map(|c| out_value(&p, &dims, &c.src)).collect() })
            .collect();

        let check = |kind: PointFileKind, out: &Path, expect_cols: &[&str]| {
            let n = write_from_las(&|_| {}, kind, las_s, out.to_str().unwrap(), &carried, &TextOptions::default(), kind == PointFileKind::Ply && out.to_str().unwrap().contains("ascii")).unwrap();
            assert_eq!(n, 200);
            let mut src = open_source(kind, out.to_str().unwrap()).unwrap();
            assert_eq!(src.columns(), expect_cols, "{}", out.display());
            let mut got: Vec<Vec<f64>> = Vec::new();
            src.rows(&mut |row| { got.push(row.to_vec()); Ok(true) }).unwrap();
            assert_eq!(got.len(), 200, "{}", out.display());
            for (g, want) in got.iter().zip(reference.iter()) {
                for (k, c) in cols.iter().enumerate() {
                    let gi = expect_cols.iter().position(|n| n.eq_ignore_ascii_case(&c.name)).unwrap();
                    let (a, b) = (g[gi], want[k]);
                    let tol = if c.ty == OutType::F32 { 1e-4 } else { 1e-9 };
                    assert!((a - b).abs() <= tol * b.abs().max(1.0), "{} column {}: {a} vs {b}", out.display(), c.name);
                }
            }
        };
        let text_cols = ["x", "y", "z", "intensity", "return_number", "number_of_returns", "classification", "gps_time", "red", "green", "blue", "tree_id", "Reflectance"];
        check(PointFileKind::Text, &dir.join("out.txt"), &text_cols);
        check(PointFileKind::Ply, &dir.join("out.ply"), &text_cols);
        check(PointFileKind::Ply, &dir.join("out_ascii.ply"), &text_cols);
        // E57: the time is a standard attribute (read back under the
        // reserved name), returns too; the rest under the extension.
        let e57_cols = ["x", "y", "z", "intensity", "return_number", "number_of_returns", "classification", "gps_time", "red", "green", "blue", "tree_id", "Reflectance", "scan"];
        check(PointFileKind::E57, &dir.join("out.e57"), &e57_cols);

        // The text file reads as a text file should: a header, and the
        // reflectance exactly as the source wrote it.
        let txt = std::fs::read_to_string(dir.join("out.txt")).unwrap();
        let mut lines = txt.lines();
        assert_eq!(lines.next().unwrap(), text_cols.join(" "));
        let first: Vec<&str> = lines.next().unwrap().split(' ').collect();
        assert_eq!(first[0], "500000");
        assert_eq!(first[12], "-12.5");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// PLY of every encoding, with an element before the vertices and a
    /// list property in it, reads the vertex properties as columns.
    #[test]
    fn ply_ascii_and_binary_of_both_endiannesses_read_alike() {
        let dir = scratch("ply");
        let header = |fmt: &str| format!(
            "ply\nformat {fmt} 1.0\ncomment test\nelement face 1\nproperty list uchar int vertex_indices\nelement vertex 3\nproperty float x\nproperty float y\nproperty double z\nproperty ushort intensity\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
        );
        let want: [[f64; 7]; 3] = [[1.5, 2.5, 3.25, 100.0, 1.0, 2.0, 3.0], [-1.5, 0.0, 10.0, 65535.0, 255.0, 0.0, 128.0], [7.0, 8.0, -9.5, 0.0, 9.0, 9.0, 9.0]];
        // ascii
        let mut s = header("ascii");
        s.push_str("3 0 1 2\n");
        for w in &want { s.push_str(&format!("{} {} {} {} {} {} {}\n", w[0], w[1], w[2], w[3], w[4], w[5], w[6])); }
        std::fs::write(dir.join("a.ply"), s).unwrap();
        // binary, both
        for (fmt, be) in [("binary_little_endian", false), ("binary_big_endian", true)] {
            let mut b = header(fmt).into_bytes();
            b.push(3);
            for i in [0i32, 1, 2] { b.extend_from_slice(&if be { i.to_be_bytes() } else { i.to_le_bytes() }); }
            for w in &want {
                let f = |v: f32| if be { v.to_be_bytes() } else { v.to_le_bytes() };
                b.extend_from_slice(&f(w[0] as f32));
                b.extend_from_slice(&f(w[1] as f32));
                b.extend_from_slice(&if be { w[2].to_be_bytes() } else { w[2].to_le_bytes() });
                let u = w[3] as u16;
                b.extend_from_slice(&if be { u.to_be_bytes() } else { u.to_le_bytes() });
                b.push(w[4] as u8); b.push(w[5] as u8); b.push(w[6] as u8);
            }
            std::fs::write(dir.join(format!("{}.ply", if be { "be" } else { "le" })), b).unwrap();
        }
        for name in ["a.ply", "le.ply", "be.ply"] {
            let p = probe(dir.join(name).to_str().unwrap()).unwrap();
            assert_eq!(p.kind, PointFileKind::Ply);
            assert_eq!(p.columns, ["x", "y", "z", "intensity", "red", "green", "blue"], "{name}");
            assert_eq!(p.approx_point_count, 3);
            assert_eq!(p.suggested.intensity.as_deref(), Some("intensity"));
            assert_eq!(p.suggested.red.as_deref(), Some("red"));
            assert_eq!(p.preview.len(), 3, "{name}");
            let mut src = open_source(PointFileKind::Ply, dir.join(name).to_str().unwrap()).unwrap();
            let mut got = Vec::new();
            src.rows(&mut |r| { got.push(r.to_vec()); Ok(true) }).unwrap();
            assert_eq!(got, want.iter().map(|w| w.to_vec()).collect::<Vec<_>>(), "{name}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An E57 with two scans, each posed, reads as one cloud in the world
    /// frame with the scan index as a column, the time stamps offset by
    /// each scan's acquisition start.
    #[test]
    fn an_e57_reads_every_scan_in_the_world_frame() {
        use e57::{Record, RecordDataType, RecordName, RecordValue};
        let dir = scratch("e57");
        let path = dir.join("two.e57");
        {
            let mut w = e57::E57Writer::from_file(&path, "guid-two-scans").unwrap();
            for scan in 0..2u32 {
                let proto = vec![
                    Record::CARTESIAN_X_F64, Record::CARTESIAN_Y_F64, Record::CARTESIAN_Z_F64,
                    Record::INTENSITY_U16,
                    Record { name: RecordName::TimeStamp, data_type: RecordDataType::F64 },
                ];
                let mut pc = w.add_pointcloud(&format!("guid-scan-{scan}"), proto).unwrap();
                pc.set_name(Some(format!("position {}", scan + 1)));
                pc.set_transform(Some(e57::Transform {
                    rotation: e57::Quaternion { w: 1.0, x: 0.0, y: 0.0, z: 0.0 },
                    translation: e57::Translation { x: 10.0 * scan as f64, y: 0.0, z: 0.0 },
                }));
                pc.set_acquisition_start(Some(e57::DateTime { gps_time: 1000.0 * (scan + 1) as f64, atomic_reference: false }));
                for i in 0..5 {
                    pc.add_point(vec![
                        RecordValue::Double(i as f64), RecordValue::Double(1.0), RecordValue::Double(2.0),
                        RecordValue::Integer(i * 100), RecordValue::Double(i as f64 * 0.5),
                    ]).unwrap();
                }
                pc.finalize().unwrap();
            }
            w.finalize().unwrap();
        }
        let p = probe(path.to_str().unwrap()).unwrap();
        assert_eq!(p.kind, PointFileKind::E57);
        assert_eq!(p.columns, ["x", "y", "z", "intensity", "gps_time", "scan"]);
        assert_eq!(p.scans, ["position 1", "position 2"]);
        assert_eq!(p.approx_point_count, 10);
        assert_eq!(p.suggested.point_source_id.as_deref(), Some("scan"));
        assert_eq!(p.suggested.gps_time.as_deref(), Some("gps_time"));
        let mut src = open_source(PointFileKind::E57, path.to_str().unwrap()).unwrap();
        let mut got = Vec::new();
        src.rows(&mut |r| { got.push(r.to_vec()); Ok(true) }).unwrap();
        assert_eq!(got.len(), 10);
        assert_eq!(got[0], [0.0, 1.0, 2.0, 0.0, 1000.0, 1.0]);
        assert_eq!(got[7], [12.0, 1.0, 2.0, 200.0, 2001.0, 2.0]);

        // Through the stager: the scan index is the point source id.
        let out = dir.join("stage.las");
        let rep = stage_to_las(&|_| {}, path.to_str().unwrap(), PointFileKind::E57, &p.suggested, out.to_str().unwrap()).unwrap();
        assert_eq!(rep.points, 10);
        assert!(rep.carried.iter().any(|c| c == "point_source_id"));
        let mut r = las::Reader::from_path(&out).unwrap();
        let pts: Vec<las::Point> = r.points().map(|p| p.unwrap()).collect();
        assert_eq!(pts[0].point_source_id, 1);
        assert_eq!(pts[9].point_source_id, 2);
        assert!((pts[9].x - 14.0).abs() < 1e-6);
        assert_eq!(pts[9].gps_time, Some(2002.0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Names the formats cannot take are made acceptable, and the
    /// record's own names are not reused for an extra.
    #[test]
    fn names_are_made_safe() {
        assert_eq!(attr_name("Reflectance (dB)"), "Reflectance__dB_");
        assert_eq!(attr_name("1st"), "c_1st");
        assert_eq!(attr_name("xmlish"), "c_xmlish");
        assert_eq!(extra_name("intensity"), "intensity_value");
        assert_eq!(extra_name("Reflectance"), "Reflectance");
        assert_eq!(extra_name(&"a".repeat(40)).len(), 31);
        assert_eq!(fmt_value(3.0, OutType::F64, None), "3");
        assert_eq!(fmt_value(-12.5, OutType::F64, None), "-12.5");
        assert_eq!(fmt_value(500000.123, OutType::F64, Some(2)), "500000.12");
        assert_eq!(fmt_value(7.6, OutType::U8, None), "8");
    }
}
