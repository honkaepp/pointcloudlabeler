// Survey analyses of a dataset, the ones a survey office asks for:
//
// * contour lines of the ground model (marching squares on the DTM), as
//   GeoJSON and DXF;
// * volumes above and below a reference (a level plane, a plane fitted to
//   the area's rim, or the ground model) inside a polygon;
// * voxel change against another acquisition of the same place: which
//   voxels appeared and which are gone, with a per-point column;
// * ortho images: a top view, or a vertical view looking along a bearing,
//   as PNG and (top view) GeoTIFF;
// * section profiles along a polyline, as CSV and SVG.
//
// A child module of `octree`, so it reads a dataset with the same helpers
// as every other pass (metadata, the editor's deletions, the column
// rewrite) — see `mod survey` there.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use rustc_hash::FxHashMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{
    build_dtm_grid, extra_layout, json_f64_3, layout_find, parse_export_patches, point_bytes_of, rewrite_octree_with_stride,
    update_metadata_extras, ExtraCol, ProgressSink,
};

/// The per-point column the voxel comparison writes.
pub const VOXEL_CHANGE_NAME: &str = "voxel_change";

// ---------------------------------------------------------------------------
// reading a dataset

/// What a pass needs of a dataset's metadata.
pub(super) struct Frame {
    scale: [f64; 3],
    offset: [f64; 3],
    stride: usize,
    extras: Vec<ExtraCol>,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub epsg: Option<u32>,
}

pub(super) fn frame(dir: &Path) -> Result<Frame, String> {
    let bytes = std::fs::read(dir.join("metadata.json")).map_err(|e| format!("read metadata.json: {e}"))?;
    let meta: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| format!("parse metadata.json: {e}"))?;
    let bbox = meta.get("boundingBox").ok_or("metadata.boundingBox missing")?;
    Ok(Frame {
        scale: json_f64_3(&meta, "scale")?,
        offset: json_f64_3(&meta, "offset")?,
        stride: point_bytes_of(&meta)?,
        extras: extra_layout(&meta),
        min: json_f64_3(bbox, "min")?,
        max: json_f64_3(bbox, "max")?,
        epsg: meta.get("crs").and_then(|c| c.get("epsg")).and_then(|v| v.as_u64()).and_then(|v| u32::try_from(v).ok()),
    })
}

impl Frame {
    #[inline]
    fn xyz(&self, r: &[u8]) -> [f64; 3] {
        let i = |o: usize| i32::from_le_bytes(r[o..o + 4].try_into().unwrap()) as f64;
        [i(0) * self.scale[0] + self.offset[0], i(4) * self.scale[1] + self.offset[1], i(8) * self.scale[2] + self.offset[2]]
    }
}

#[inline]
fn intensity(r: &[u8]) -> u16 {
    u16::from_le_bytes(r[16..18].try_into().unwrap())
}

#[inline]
pub(super) fn class(r: &[u8]) -> u8 {
    r[18]
}

/// Calls `f(index, world xyz, record)` for every point the editor has not
/// deleted, in the stream order of octree.bin (the order a column rewrite
/// visits). Progress runs from `from` to `to`; a Stop on `stage` ends the
/// pass with an error before anything is written.
pub(super) fn for_each_point(
    dir: &Path,
    fr: &Frame,
    stage: &str,
    progress: ProgressSink,
    from: f32,
    to: f32,
    mut f: impl FnMut(u64, [f64; 3], &[u8]),
) -> Result<u64, String> {
    let cancel = crate::commands::cancel::token(stage);
    let hier = std::fs::read(dir.join("hierarchy.bin")).map_err(|e| format!("read hierarchy.bin: {e}"))?;
    if hier.len() % 24 != 0 {
        return Err(format!("hierarchy.bin length {} not a multiple of 24", hier.len()));
    }
    let n_records = hier.len() / 24;
    let patches = parse_export_patches(&dir.join("patches.bin"))?;
    let mut bin = BufReader::with_capacity(4 << 20, File::open(dir.join("octree.bin")).map_err(|e| format!("open octree.bin: {e}"))?);
    let mut block: Vec<u8> = Vec::new();
    let mut cur = 0u64;
    let mut index = 0u64;
    for rec in 0..n_records {
        let h = &hier[rec * 24..rec * 24 + 24];
        let off = u64::from_le_bytes(h[8..16].try_into().unwrap());
        let size = u64::from_le_bytes(h[16..24].try_into().unwrap()) as usize;
        if size == 0 {
            continue;
        }
        block.resize(size, 0);
        if off != cur {
            bin.seek(SeekFrom::Start(off)).map_err(|e| format!("seek octree.bin: {e}"))?;
            cur = off;
        }
        bin.read_exact(&mut block).map_err(|e| format!("read octree.bin block: {e}"))?;
        cur += size as u64;
        for p in 0..size / fr.stride {
            let i = index;
            index += 1;
            if let Some(&(_, _, del)) = patches.get(&(rec as u32, p as u32)) {
                if del == 1 {
                    continue;
                }
            }
            let r = &block[p * fr.stride..(p + 1) * fr.stride];
            f(i, fr.xyz(r), r);
        }
        if rec % 256 == 0 {
            if crate::commands::cancel::stopped(&cancel) {
                return Err("Stopped — nothing was changed.".to_string());
            }
            progress(from + (to - from) * rec as f32 / n_records.max(1) as f32);
        }
    }
    Ok(index)
}

pub(super) fn survey_dir(dir: &Path) -> Result<PathBuf, String> {
    let d = dir.join("survey");
    std::fs::create_dir_all(&d).map_err(|e| format!("create {}: {e}", d.display()))?;
    Ok(d)
}

/// A file name from what the user typed: letters, digits, `-`, `_`, `.`.
pub(super) fn safe_name(name: &str, fallback: &str) -> String {
    let s: String = name.trim().chars().map(|c| if c.is_ascii_alphanumeric() || "-_.".contains(c) { c } else { '_' }).collect();
    let s = s.trim_matches('.').to_string();
    if s.is_empty() { fallback.to_string() } else { s }
}

pub(super) fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Even-odd point in polygon (closing edge implied).
pub fn point_in_polygon(poly: &[[f64; 2]], x: f64, y: f64) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (poly[i], poly[j]);
        if (a[1] > y) != (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Area of a polygon (shoelace), square metres.
pub fn polygon_area(poly: &[[f64; 2]]) -> f64 {
    let n = poly.len();
    (0..n).map(|i| poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1]).sum::<f64>().abs() / 2.0
}

// ---------------------------------------------------------------------------
// DXF (R12, the version every CAD and GIS reads)

/// Polylines, points and text in a minimal DXF R12.
pub struct Dxf {
    layers: Vec<(String, i32)>,
    entities: String,
}

impl Dxf {
    pub fn new() -> Self {
        Dxf { layers: Vec::new(), entities: String::new() }
    }

    /// A layer with an AutoCAD colour index.
    pub fn layer(&mut self, name: &str, color: i32) {
        if !self.layers.iter().any(|(n, _)| n == name) {
            self.layers.push((name.to_string(), color));
        }
    }

    /// A 3D polyline.
    pub fn polyline(&mut self, layer: &str, pts: &[[f64; 3]], closed: bool) {
        use std::fmt::Write as _;
        if pts.len() < 2 {
            return;
        }
        let e = &mut self.entities;
        let _ = write!(e, "0\nPOLYLINE\n8\n{layer}\n66\n1\n10\n0.0\n20\n0.0\n30\n0.0\n70\n{}\n", 8 | i32::from(closed));
        for p in pts {
            let _ = write!(e, "0\nVERTEX\n8\n{layer}\n10\n{:.4}\n20\n{:.4}\n30\n{:.4}\n70\n32\n", p[0], p[1], p[2]);
        }
        let _ = write!(e, "0\nSEQEND\n8\n{layer}\n");
    }

    pub fn point(&mut self, layer: &str, p: [f64; 3]) {
        use std::fmt::Write as _;
        let _ = write!(self.entities, "0\nPOINT\n8\n{layer}\n10\n{:.4}\n20\n{:.4}\n30\n{:.4}\n", p[0], p[1], p[2]);
    }

    /// Entities written by the caller (group codes and values, newline separated).
    pub fn raw(&mut self, s: &str) {
        self.entities.push_str(s);
    }

    pub fn text(&mut self, layer: &str, p: [f64; 3], height: f64, s: &str) {
        use std::fmt::Write as _;
        let _ = write!(self.entities, "0\nTEXT\n8\n{layer}\n10\n{:.4}\n20\n{:.4}\n30\n{:.4}\n40\n{height:.3}\n1\n{s}\n", p[0], p[1], p[2]);
    }

    pub fn write(&self, path: &Path) -> Result<(), String> {
        use std::fmt::Write as _;
        let mut s = String::from("0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n");
        let _ = write!(s, "0\nTABLE\n2\nLAYER\n70\n{}\n", self.layers.len());
        for (n, c) in &self.layers {
            let _ = write!(s, "0\nLAYER\n2\n{n}\n70\n0\n62\n{c}\n6\nCONTINUOUS\n");
        }
        s.push_str("0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n");
        s.push_str(&self.entities);
        s.push_str("0\nENDSEC\n0\nEOF\n");
        std::fs::write(path, s).map_err(|e| format!("write {}: {e}", path.display()))
    }
}

impl Default for Dxf {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// contour lines

#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContourParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Height between two contour lines, metres (default 0.5).
    #[serde(default = "d_0_5")]
    pub interval: f64,
    /// Every n-th line is an index contour (default 5).
    #[serde(default = "d_5")]
    pub index_every: u32,
    /// DTM cell size, metres (default 0.5).
    #[serde(default = "d_0_5")]
    pub cell_size: f64,
    /// Smoothing passes over the DTM before contouring (3×3 mean, default 2).
    #[serde(default = "d_2")]
    pub smooth: u32,
    /// Lines shorter than this are left out, metres (default 2).
    #[serde(default = "d_2f")]
    pub min_length: f64,
    /// Only inside this polygon of world [x, y] vertices (empty = the whole ground model).
    #[serde(default)]
    pub polygon: Vec<[f64; 2]>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContourLine {
    pub z: f64,
    pub index: bool,
    pub closed: bool,
    pub points: Vec<[f64; 3]>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContourResult {
    pub lines: Vec<ContourLine>,
    pub levels: usize,
    pub min_z: f64,
    pub max_z: f64,
    pub length_m: f64,
    pub files: Vec<String>,
}

/// Contour polylines of `z` (rows × cols, row 0 south, values at the cell
/// lattice; non-finite = no data) at `level`, in lattice coordinates
/// (column, row). Marching squares; a saddle is decided by the mean of its
/// four corners. Returns each line and whether it closes on itself.
pub fn contour_level(z: &[f32], cols: usize, rows: usize, level: f64) -> Vec<(Vec<[f64; 2]>, bool)> {
    if cols < 2 || rows < 2 {
        return Vec::new();
    }
    let at = |r: usize, c: usize| z[r * cols + c] as f64;
    // edges: 2·(r·cols + c) horizontal (r, c)→(r, c+1), +1 vertical (r, c)→(r+1, c)
    let h = |r: usize, c: usize| 2 * (r * cols + c);
    let v = |r: usize, c: usize| 2 * (r * cols + c) + 1;
    let point = |e: usize| -> [f64; 2] {
        let cell = e / 2;
        let (r, c) = (cell / cols, cell % cols);
        let (r2, c2) = if e % 2 == 0 { (r, c + 1) } else { (r + 1, c) };
        let (a, b) = (at(r, c), at(r2, c2));
        let t = if (b - a).abs() > 0.0 { ((level - a) / (b - a)).clamp(0.0, 1.0) } else { 0.5 };
        [c as f64 + t * (c2 as f64 - c as f64), r as f64 + t * (r2 as f64 - r as f64)]
    };
    let mut segs: Vec<(usize, usize)> = Vec::new();
    for r in 0..rows - 1 {
        for c in 0..cols - 1 {
            let q = [at(r, c), at(r, c + 1), at(r + 1, c + 1), at(r + 1, c)];
            if q.iter().any(|x| !x.is_finite()) {
                continue;
            }
            let up = |x: f64| x > level;
            let case = usize::from(up(q[0])) | usize::from(up(q[1])) << 1 | usize::from(up(q[2])) << 2 | usize::from(up(q[3])) << 3;
            let (b, rt, t, l) = (h(r, c), v(r, c + 1), h(r + 1, c), v(r, c));
            let centre_up = up((q[0] + q[1] + q[2] + q[3]) / 4.0);
            match case {
                1 | 14 => segs.push((l, b)),
                2 | 13 => segs.push((b, rt)),
                3 | 12 => segs.push((l, rt)),
                4 | 11 => segs.push((rt, t)),
                6 | 9 => segs.push((b, t)),
                7 | 8 => segs.push((l, t)),
                5 => {
                    if centre_up {
                        segs.push((b, rt));
                        segs.push((t, l));
                    } else {
                        segs.push((l, b));
                        segs.push((rt, t));
                    }
                }
                10 => {
                    if centre_up {
                        segs.push((l, b));
                        segs.push((rt, t));
                    } else {
                        segs.push((b, rt));
                        segs.push((t, l));
                    }
                }
                _ => {}
            }
        }
    }
    // link the segments through their shared edges
    let mut by_edge: FxHashMap<usize, Vec<usize>> = FxHashMap::default();
    for (i, &(a, b)) in segs.iter().enumerate() {
        by_edge.entry(a).or_default().push(i);
        by_edge.entry(b).or_default().push(i);
    }
    let mut used = vec![false; segs.len()];
    let mut out = Vec::new();
    // open lines first (they start at an edge only one segment touches), then loops
    let mut starts: Vec<usize> = (0..segs.len()).filter(|&i| by_edge[&segs[i].0].len() == 1 || by_edge[&segs[i].1].len() == 1).collect();
    starts.extend(0..segs.len());
    for s in starts {
        if used[s] {
            continue;
        }
        used[s] = true;
        let (a, b) = segs[s];
        // walk from the open end when there is one
        let (first, mut end) = if by_edge[&a].len() == 1 { (a, b) } else { (b, a) };
        let mut edges = vec![first, end];
        loop {
            let next = by_edge[&end].iter().copied().find(|&j| !used[j]);
            let Some(j) = next else { break };
            used[j] = true;
            end = if segs[j].0 == end { segs[j].1 } else { segs[j].0 };
            edges.push(end);
        }
        // a loop has walked only one way; an open line started at one end
        let closed = edges.len() > 2 && edges.first() == edges.last();
        if !closed {
            // extend backwards from the start (when started mid-line)
            let mut back = vec![];
            let mut e = edges[0];
            while let Some(j) = by_edge[&e].iter().copied().find(|&j| !used[j]) {
                used[j] = true;
                e = if segs[j].0 == e { segs[j].1 } else { segs[j].0 };
                back.push(e);
            }
            if !back.is_empty() {
                back.reverse();
                back.extend(edges);
                edges = back;
            }
        }
        out.push((edges.iter().map(|&e| point(e)).collect(), closed));
    }
    out
}

fn smooth_grid(z: &mut [f32], cols: usize, rows: usize, passes: u32) {
    for _ in 0..passes {
        let prev = z.to_vec();
        for r in 0..rows {
            for c in 0..cols {
                if !prev[r * cols + c].is_finite() {
                    continue;
                }
                let (mut s, mut n) = (0f64, 0u32);
                for dr in -1i64..=1 {
                    for dc in -1i64..=1 {
                        let (rr, cc) = (r as i64 + dr, c as i64 + dc);
                        if rr < 0 || cc < 0 || rr as usize >= rows || cc as usize >= cols {
                            continue;
                        }
                        let x = prev[rr as usize * cols + cc as usize];
                        if x.is_finite() {
                            s += x as f64;
                            n += 1;
                        }
                    }
                }
                z[r * cols + c] = (s / n as f64) as f32;
            }
        }
    }
}

fn line_length(p: &[[f64; 3]]) -> f64 {
    p.windows(2).map(|w| ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt()).sum()
}

fn number_label(v: f64) -> String {
    let s = format!("{v:.3}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

pub fn run_contours(p: &ContourParams, progress: ProgressSink) -> Result<ContourResult, String> {
    if !(p.interval > 0.0) || !p.interval.is_finite() {
        return Err("the contour interval must be a positive number of metres".into());
    }
    let dir = Path::new(&p.octree_dir);
    let fr = frame(dir)?;
    progress(0.05);
    let dtm = build_dtm_grid(dir, p.cell_size)?;
    progress(0.6);
    let (cols, rows) = (dtm.cols, dtm.rows);
    let mut z: Vec<f32> = dtm.z.iter().map(|v| if v.is_finite() { *v } else { f32::NAN }).collect();
    smooth_grid(&mut z, cols, rows, p.smooth.min(10));
    if p.polygon.len() >= 3 {
        for r in 0..rows {
            for c in 0..cols {
                let (x, y) = (dtm.min_x + (c as f64 + 0.5) * dtm.cell, dtm.min_y + (r as f64 + 0.5) * dtm.cell);
                if !point_in_polygon(&p.polygon, x, y) {
                    z[r * cols + c] = f32::NAN;
                }
            }
        }
    }
    let finite = z.iter().filter(|v| v.is_finite());
    let (lo, hi) = finite.fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), v| (a.min(*v as f64), b.max(*v as f64)));
    if !lo.is_finite() {
        return Err("the ground model is empty — classify the ground first".into());
    }
    let first = (lo / p.interval).ceil() as i64;
    let last = (hi / p.interval).floor() as i64;
    if last - first > 2000 {
        return Err(format!("{} contour levels between {lo:.1} and {hi:.1} m: use a larger interval", last - first + 1));
    }
    let to_world = |q: [f64; 2], level: f64| [dtm.min_x + (q[0] + 0.5) * dtm.cell, dtm.min_y + (q[1] + 0.5) * dtm.cell, level];
    let mut lines = Vec::new();
    let every = p.index_every.max(1) as i64;
    for k in first..=last {
        let level = k as f64 * p.interval;
        for (pts, closed) in contour_level(&z, cols, rows, level) {
            let pts: Vec<[f64; 3]> = pts.into_iter().map(|q| to_world(q, level)).collect();
            if line_length(&pts) >= p.min_length {
                lines.push(ContourLine { z: level, index: k.rem_euclid(every) == 0, closed, points: pts });
            }
        }
        progress(0.6 + 0.3 * (k - first + 1) as f32 / (last - first + 1).max(1) as f32);
    }
    let length_m = lines.iter().map(|l| line_length(&l.points)).sum();
    // files: GeoJSON (with the dataset's CRS when it is known) and DXF
    let tdir = dir.join("terrain");
    std::fs::create_dir_all(&tdir).map_err(|e| format!("create terrain/: {e}"))?;
    let stem = format!("contours_{}m", number_label(p.interval));
    let features: Vec<serde_json::Value> = lines
        .iter()
        .map(|l| {
            let mut coords: Vec<[f64; 3]> = l.points.clone();
            if l.closed && coords.first() != coords.last() {
                coords.push(coords[0]);
            }
            serde_json::json!({
                "type": "Feature",
                "geometry": {"type": "LineString", "coordinates": coords},
                "properties": {"elevation": l.z, "index": l.index},
            })
        })
        .collect();
    let mut gj = serde_json::json!({"type": "FeatureCollection", "name": stem, "features": features});
    if let Some(code) = fr.epsg {
        gj["crs"] = serde_json::json!({"type": "name", "properties": {"name": format!("urn:ogc:def:crs:EPSG::{code}")}});
    }
    let gj_path = tdir.join(format!("{stem}.geojson"));
    std::fs::write(&gj_path, serde_json::to_string(&gj).unwrap_or_default()).map_err(|e| format!("write {}: {e}", gj_path.display()))?;
    let mut dxf = Dxf::new();
    dxf.layer("CONTOUR", 8);
    dxf.layer("CONTOUR_INDEX", 30);
    for l in &lines {
        dxf.polyline(if l.index { "CONTOUR_INDEX" } else { "CONTOUR" }, &l.points, l.closed);
    }
    let dxf_path = tdir.join(format!("{stem}.dxf"));
    dxf.write(&dxf_path)?;
    progress(1.0);
    Ok(ContourResult { levels: (last - first + 1).max(0) as usize, lines, min_z: lo, max_z: hi, length_m, files: vec![lossy(&gj_path), lossy(&dxf_path)] })
}

// ---------------------------------------------------------------------------
// volumes

#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VolumeParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// The area: a polygon of world [x, y] vertices (closed implicitly); empty = the whole dataset.
    #[serde(default)]
    pub polygon: Vec<[f64; 2]>,
    /// The measured surface per cell: "top" (highest point — a pile, a canopy), "lowest" (lowest point), "ground" (lowest ground point, class 2) or "mean".
    #[serde(default = "d_top")]
    pub surface: String,
    /// What it is compared with: "rim" (a plane fitted to the surface along the area's edge — a pile on uneven ground), "plane" (a level plane at planeZ), "lowest" (a level plane at the lowest surface cell) or "dtm" (the ground model).
    #[serde(default = "d_rim")]
    pub reference: String,
    /// Height of the level plane for reference "plane", metres.
    #[serde(default)]
    pub plane_z: Option<f64>,
    /// Grid cell, metres (default 0.1).
    #[serde(default = "d_0_1")]
    pub cell_size: f64,
    /// Only points of these classes make the surface (empty = all).
    #[serde(default)]
    pub classes: Vec<u8>,
    /// Empty cells inside the area take the mean of their filled neighbours instead of being left out.
    #[serde(default = "d_true")]
    pub fill_gaps: bool,
    /// Name of the height-difference raster written to `survey/<name>.tif` (default "volume").
    #[serde(default = "d_volume")]
    pub out_name: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VolumeResult {
    /// The area (the polygon's, or the dataset's extent), square metres.
    pub area_m2: f64,
    /// Cells with a surface (measured or filled), square metres.
    pub covered_m2: f64,
    pub filled_cells: usize,
    /// Volume of the surface above the reference (fill) and below it (cut), cubic metres.
    pub above_m3: f64,
    pub below_m3: f64,
    pub net_m3: f64,
    pub max_above: f64,
    pub max_below: f64,
    /// The reference, in words.
    pub reference: String,
    pub files: Vec<String>,
}

/// Least squares plane z = a·(x−x0) + b·(y−y0) + c through `pts`.
fn fit_plane(pts: &[[f64; 3]]) -> Option<([f64; 3], [f64; 2])> {
    if pts.len() < 3 {
        return None;
    }
    let n = pts.len() as f64;
    let (x0, y0) = (pts.iter().map(|p| p[0]).sum::<f64>() / n, pts.iter().map(|p| p[1]).sum::<f64>() / n);
    let (mut sxx, mut sxy, mut syy, mut sxz, mut syz, mut sz) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for p in pts {
        let (x, y) = (p[0] - x0, p[1] - y0);
        sxx += x * x;
        sxy += x * y;
        syy += y * y;
        sxz += x * p[2];
        syz += y * p[2];
        sz += p[2];
    }
    let det = sxx * syy - sxy * sxy;
    if det.abs() < 1e-12 {
        return Some(([0.0, 0.0, sz / n], [x0, y0]));
    }
    let a = (sxz * syy - syz * sxy) / det;
    let b = (syz * sxx - sxz * sxy) / det;
    Some(([a, b, sz / n], [x0, y0]))
}

/// A height per grid cell inside an area: the highest, lowest, ground or mean point of the
/// cell (`surface`), empty cells optionally filled from their neighbours.
pub(super) struct SurfaceGrid {
    /// Row-major (row 0 south); NaN = no surface.
    pub z: Vec<f64>,
    /// The cell's centre is inside the area.
    pub inside: Vec<bool>,
    pub cols: usize,
    pub rows: usize,
    pub min: [f64; 2],
    pub max: [f64; 2],
    pub cell: f64,
}

impl SurfaceGrid {
    pub fn centre(&self, c: usize, r: usize) -> [f64; 2] {
        [self.min[0] + (c as f64 + 0.5) * self.cell, self.min[1] + (r as f64 + 0.5) * self.cell]
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn surface_grid(
    dir: &Path,
    fr: &Frame,
    poly: &[[f64; 2]],
    surface: &str,
    classes: &[u8],
    cell: f64,
    fill_gaps: bool,
    z_range: Option<[f64; 2]>,
    stage: &str,
    progress: ProgressSink,
    span: (f32, f32),
) -> Result<SurfaceGrid, String> {
    let cell = cell.max(0.01);
    if !poly.is_empty() && poly.len() < 3 {
        return Err("the area needs at least three vertices".into());
    }
    let (min, max) = if poly.is_empty() {
        ([fr.min[0], fr.min[1]], [fr.max[0], fr.max[1]])
    } else {
        poly.iter().fold(([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]), |(a, b), q| ([a[0].min(q[0]), a[1].min(q[1])], [b[0].max(q[0]), b[1].max(q[1])]))
    };
    let cols = (((max[0] - min[0]) / cell).ceil() as usize).max(1);
    let rows = (((max[1] - min[1]) / cell).ceil() as usize).max(1);
    if cols.saturating_mul(rows) > 50_000_000 {
        return Err(format!("{cols} × {rows} cells: use a larger cell or a smaller area"));
    }
    let centre = move |c: usize, r: usize| [min[0] + (c as f64 + 0.5) * cell, min[1] + (r as f64 + 0.5) * cell];
    let inside: Vec<bool> = (0..rows * cols).map(|i| poly.is_empty() || { let q = centre(i % cols, i / cols); point_in_polygon(poly, q[0], q[1]) }).collect();
    let mode = surface.to_ascii_lowercase();
    if !["top", "lowest", "ground", "mean"].contains(&mode.as_str()) {
        return Err(format!("unknown surface {surface:?} (top, lowest, ground, mean)"));
    }
    let mut acc = vec![f64::NAN; rows * cols];
    let mut cnt = vec![0u32; rows * cols];
    for_each_point(dir, fr, stage, progress, span.0, span.1, |_, q, r| {
        let cls = class(r);
        if mode == "ground" && cls != 2 {
            return;
        }
        if !classes.is_empty() && !classes.contains(&cls) {
            return;
        }
        if let Some([lo, hi]) = z_range {
            if q[2] < lo || q[2] > hi {
                return;
            }
        }
        if q[0] < min[0] || q[1] < min[1] {
            return;
        }
        let (c, rr) = (((q[0] - min[0]) / cell) as usize, ((q[1] - min[1]) / cell) as usize);
        if c >= cols || rr >= rows {
            return;
        }
        let i = rr * cols + c;
        if !inside[i] {
            return;
        }
        let a = &mut acc[i];
        *a = match mode.as_str() {
            "top" => if a.is_nan() { q[2] } else { a.max(q[2]) },
            "mean" => if a.is_nan() { q[2] } else { *a + q[2] },
            _ => if a.is_nan() { q[2] } else { a.min(q[2]) },
        };
        cnt[i] += 1;
    })?;
    if mode == "mean" {
        for (a, n) in acc.iter_mut().zip(&cnt) {
            if *n > 0 {
                *a /= *n as f64;
            }
        }
    }
    let measured = acc.iter().filter(|v| v.is_finite()).count();
    if measured == 0 {
        return Err("no points in the area".into());
    }
    if fill_gaps {
        let measured: Vec<bool> = acc.iter().map(|v| v.is_finite()).collect();
        for _ in 0..200 {
            let prev = acc.clone();
            let mut changed = false;
            for r in 0..rows {
                for c in 0..cols {
                    let i = r * cols + c;
                    if !inside[i] || prev[i].is_finite() {
                        continue;
                    }
                    let (mut s, mut n) = (0.0, 0u32);
                    for (dr, dc) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)] {
                        let (rr, cc) = (r as i64 + dr, c as i64 + dc);
                        if rr >= 0 && cc >= 0 && (rr as usize) < rows && (cc as usize) < cols {
                            let v = prev[rr as usize * cols + cc as usize];
                            if v.is_finite() {
                                s += v;
                                n += 1;
                            }
                        }
                    }
                    if n > 0 {
                        acc[i] = s / n as f64;
                        changed = true;
                    }
                }
            }
            if !changed {
                break;
            }
        }
        // the spreading leaves terraces in large gaps: relax the filled cells towards the
        // mean of their neighbours (a harmonic surface between the measured cells, which stay)
        let gaps: Vec<usize> = (0..rows * cols).filter(|&i| inside[i] && !measured[i] && acc[i].is_finite()).collect();
        for _ in 0..60 {
            for &i in &gaps {
                let (r, c) = (i / cols, i % cols);
                let (mut s, mut n) = (0.0, 0u32);
                for (dr, dc) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1)] {
                    let (rr, cc) = (r as i64 + dr, c as i64 + dc);
                    if rr >= 0 && cc >= 0 && (rr as usize) < rows && (cc as usize) < cols {
                        let v = acc[rr as usize * cols + cc as usize];
                        if v.is_finite() {
                            s += v;
                            n += 1;
                        }
                    }
                }
                if n > 0 {
                    acc[i] = s / n as f64;
                }
            }
        }
    }
    Ok(SurfaceGrid { z: acc, inside, cols, rows, min, max, cell })
}

pub fn run_volume(p: &VolumeParams, progress: ProgressSink) -> Result<VolumeResult, String> {
    let dir = Path::new(&p.octree_dir);
    let fr = frame(dir)?;
    let poly = &p.polygon;
    let g = surface_grid(dir, &fr, poly, &p.surface, &p.classes, p.cell_size, p.fill_gaps, None, "volume", progress, (0.0, 0.7))?;
    let (cols, rows, cell, min, max) = (g.cols, g.rows, g.cell, g.min, g.max);
    let centre = move |c: usize, r: usize| [min[0] + (c as f64 + 0.5) * cell, min[1] + (r as f64 + 0.5) * cell];
    let inside = &g.inside;
    let acc = &g.z;
    let mode = p.surface.to_ascii_lowercase();
    progress(0.75);
    // the reference per cell
    let reference = p.reference.to_ascii_lowercase();
    let (refz, words): (Box<dyn Fn(usize, usize) -> Option<f64> + '_>, String) = match reference.as_str() {
        "plane" => {
            let z = p.plane_z.ok_or("reference \"plane\" needs planeZ")?;
            (Box::new(move |_, _| Some(z)), format!("level plane at z = {z:.3} m"))
        }
        "lowest" => {
            let z = acc.iter().copied().filter(|v| v.is_finite()).fold(f64::INFINITY, f64::min);
            (Box::new(move |_, _| Some(z)), format!("level plane at the lowest cell, z = {z:.3} m"))
        }
        "rim" => {
            // the area's edge: inside cells with a neighbour outside (or on the grid border)
            let mut rim = Vec::new();
            for r in 0..rows {
                for c in 0..cols {
                    let i = r * cols + c;
                    if !inside[i] || !acc[i].is_finite() {
                        continue;
                    }
                    let edge = r == 0 || c == 0 || r + 1 == rows || c + 1 == cols
                        || [(r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)].iter().any(|&(rr, cc)| !inside[rr * cols + cc]);
                    if edge {
                        let q = centre(c, r);
                        rim.push([q[0], q[1], acc[i]]);
                    }
                }
            }
            let (abc, o) = fit_plane(&rim).ok_or("the area's edge has too few measured cells for a plane")?;
            let slope = (abc[0].powi(2) + abc[1].powi(2)).sqrt().atan().to_degrees();
            (
                Box::new(move |c, r| {
                    let q = centre(c, r);
                    Some(abc[0] * (q[0] - o[0]) + abc[1] * (q[1] - o[1]) + abc[2])
                }),
                format!("plane fitted to the edge ({} cells): z = {:.3} m at the centre, slope {slope:.2}°", rim.len(), abc[2]),
            )
        }
        "dtm" => {
            // at the volume's own cell: the model keeps each cell's lowest ground
            // point, which on a slope lies below the cell's centre by half a cell
            // times the slope — a finer cell, a smaller bias
            let dtm = build_dtm_grid(dir, cell)?;
            (Box::new(move |c, r| {
                let q = centre(c, r);
                dtm.sample(q[0], q[1]).map(|v| v as f64)
            }), "the ground model (DTM)".to_string())
        }
        other => return Err(format!("unknown reference {other:?} (rim, plane, lowest, dtm)")),
    };
    let area = cell * cell;
    let (mut above, mut below, mut max_above, mut max_below) = (0.0, 0.0, 0.0f64, 0.0f64);
    let mut filled = 0usize;
    let mut diff = vec![f32::NAN; rows * cols];
    for r in 0..rows {
        for c in 0..cols {
            let i = r * cols + c;
            if !inside[i] || !acc[i].is_finite() {
                continue;
            }
            let Some(z0) = refz(c, r) else { continue };
            let d = acc[i] - z0;
            diff[i] = d as f32;
            filled += 1;
            if d > 0.0 {
                above += d * area;
                max_above = max_above.max(d);
            } else {
                below -= d * area;
                max_below = max_below.max(-d);
            }
        }
    }
    progress(0.9);
    let sdir = survey_dir(dir)?;
    let name = safe_name(&p.out_name, "volume");
    let tif = sdir.join(format!("{name}.tif"));
    crate::commands::geotiff::write_geotiff_f32(&tif, &diff, cols, rows, min[0], min[1], cell, fr.epsg)?;
    let res = VolumeResult {
        area_m2: if poly.is_empty() { (max[0] - min[0]) * (max[1] - min[1]) } else { polygon_area(poly) },
        covered_m2: filled as f64 * area,
        filled_cells: filled,
        above_m3: above,
        below_m3: below,
        net_m3: above - below,
        max_above,
        max_below,
        reference: words,
        files: vec![lossy(&tif)],
    };
    let js = sdir.join(format!("{name}.json"));
    let mut v = serde_json::to_value(&res).unwrap_or_default();
    v["polygon"] = serde_json::to_value(poly).unwrap_or_default();
    v["surface"] = serde_json::Value::String(mode);
    v["cellSize"] = serde_json::json!(cell);
    std::fs::write(&js, serde_json::to_string_pretty(&v).unwrap_or_default()).map_err(|e| format!("write {}: {e}", js.display()))?;
    progress(1.0);
    Ok(VolumeResult { files: vec![lossy(&tif), lossy(&js)], ..res })
}

// ---------------------------------------------------------------------------
// voxel change

#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoxelChangeParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// The other acquisition of the same place (a dataset directory), in the same coordinates.
    pub reference_dir: String,
    /// Voxel edge, metres (default 0.1).
    #[serde(default = "d_0_1")]
    pub voxel_size: f64,
    /// A voxel is unchanged when the other acquisition occupies it or one of its 26 neighbours (absorbs registration noise; default true).
    #[serde(default = "d_true")]
    pub neighbours: bool,
    /// Points a voxel needs to count as occupied (default 1).
    #[serde(default = "d_1u")]
    pub min_points: u32,
    /// Write the per-point column `voxel_change` (1 = in a voxel the reference does not have, 0 = unchanged).
    #[serde(default = "d_true")]
    pub write_column: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VoxelChangeResult {
    pub voxels: u64,
    pub reference_voxels: u64,
    pub unchanged: u64,
    /// Voxels only this dataset occupies (new) and only the reference occupies (gone).
    pub appeared: u64,
    pub disappeared: u64,
    pub appeared_m3: f64,
    pub disappeared_m3: f64,
    pub points: u64,
    pub points_new: u64,
    pub column_written: Option<String>,
    /// Centres of the gone voxels (at most 200 000, for the viewer).
    pub gone: Vec<[f64; 3]>,
    pub files: Vec<String>,
}

const VOXEL_BIAS: i64 = 1 << 20;

/// A voxel's key: 21 bits per axis around `origin`; None outside ±2^20 voxels.
#[inline]
pub(super) fn voxel_key(q: [f64; 3], origin: [f64; 3], size: f64) -> Option<u64> {
    let mut k = 0u64;
    for d in 0..3 {
        let i = ((q[d] - origin[d]) / size).floor() as i64 + VOXEL_BIAS;
        if !(0..2 * VOXEL_BIAS).contains(&i) {
            return None;
        }
        k = (k << 21) | i as u64;
    }
    Some(k)
}

#[inline]
fn voxel_neighbours(k: u64) -> impl Iterator<Item = u64> {
    let (x, y, z) = ((k >> 42) as i64, ((k >> 21) & 0x1f_ffff) as i64, (k & 0x1f_ffff) as i64);
    (0..27).filter_map(move |n| {
        let (dx, dy, dz) = (n % 3 - 1, n / 3 % 3 - 1, n / 9 - 1);
        let (a, b, c) = (x + dx, y + dy, z + dz);
        let ok = |v: i64| (0..2 * VOXEL_BIAS).contains(&v);
        (ok(a) && ok(b) && ok(c)).then_some(((a as u64) << 42) | ((b as u64) << 21) | c as u64)
    })
}

pub(super) fn voxel_centre(k: u64, origin: [f64; 3], size: f64) -> [f64; 3] {
    let idx = [(k >> 42) as i64, ((k >> 21) & 0x1f_ffff) as i64, (k & 0x1f_ffff) as i64];
    [0, 1, 2].map(|d| origin[d] + ((idx[d] - VOXEL_BIAS) as f64 + 0.5) * size)
}

fn occupied(counts: &FxHashMap<u64, u32>, min_points: u32) -> rustc_hash::FxHashSet<u64> {
    counts.iter().filter(|(_, n)| **n >= min_points.max(1)).map(|(k, _)| *k).collect()
}

fn present(set: &rustc_hash::FxHashSet<u64>, k: u64, neighbours: bool) -> bool {
    if neighbours { voxel_neighbours(k).any(|n| set.contains(&n)) } else { set.contains(&k) }
}

pub fn run_voxel_change(p: &VoxelChangeParams, progress: ProgressSink) -> Result<VoxelChangeResult, String> {
    let dir = Path::new(&p.octree_dir);
    let rdir = Path::new(&p.reference_dir);
    if dir == rdir {
        return Err("choose another dataset to compare with".into());
    }
    let size = p.voxel_size.max(0.005);
    let fr = frame(dir)?;
    let rf = frame(rdir)?;
    let origin = fr.min;
    let mut cur: FxHashMap<u64, u32> = FxHashMap::default();
    let mut points = 0u64;
    for_each_point(dir, &fr, "voxel_change", progress, 0.0, 0.3, |_, q, _| {
        points += 1;
        if let Some(k) = voxel_key(q, origin, size) {
            *cur.entry(k).or_default() += 1;
        }
    })?;
    let mut refc: FxHashMap<u64, u32> = FxHashMap::default();
    for_each_point(rdir, &rf, "voxel_change", progress, 0.3, 0.6, |_, q, _| {
        if let Some(k) = voxel_key(q, origin, size) {
            *refc.entry(k).or_default() += 1;
        }
    })?;
    let a = occupied(&cur, p.min_points);
    let b = occupied(&refc, p.min_points);
    drop(refc);
    let appeared: rustc_hash::FxHashSet<u64> = a.iter().copied().filter(|&k| !present(&b, k, p.neighbours)).collect();
    let gone: Vec<u64> = b.iter().copied().filter(|&k| !present(&a, k, p.neighbours)).collect();
    progress(0.65);
    // points in new voxels
    let mut points_new = 0u64;
    for (k, n) in &cur {
        if appeared.contains(k) {
            points_new += *n as u64;
        }
    }
    let v3 = size * size * size;
    let sdir = survey_dir(dir)?;
    let mut files = Vec::new();
    // the gone voxels as points (x, y, z) for a GIS or another import
    {
        let path = sdir.join("voxel_change_gone.csv");
        let mut w = std::io::BufWriter::new(File::create(&path).map_err(|e| format!("create {}: {e}", path.display()))?);
        writeln!(w, "x,y,z").map_err(|e| e.to_string())?;
        for &k in &gone {
            let c = voxel_centre(k, origin, size);
            writeln!(w, "{:.3},{:.3},{:.3}", c[0], c[1], c[2]).map_err(|e| e.to_string())?;
        }
        files.push(lossy(&path));
    }
    let mut column_written = None;
    if p.write_column {
        let _guard = super::lock_dataset(&p.octree_dir)?;
        let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("metadata.json")).map_err(|e| format!("read metadata.json: {e}"))?)
            .map_err(|e| format!("parse metadata.json: {e}"))?;
        let stride = point_bytes_of(&meta)?;
        let layout = extra_layout(&meta);
        let value = |r: &[u8]| -> f32 {
            match voxel_key(fr.xyz(r), origin, size) {
                Some(k) if appeared.contains(&k) => 1.0,
                Some(_) => 0.0,
                None => f32::NAN,
            }
        };
        let sub = |f: f32| progress(0.7 + 0.3 * f);
        match layout_find(&layout, VOXEL_CHANGE_NAME) {
            Some(col) => {
                let col = col.clone();
                rewrite_octree_with_stride(&sub, dir, stride, stride, |pt, out| {
                    let start = out.len();
                    out.extend_from_slice(pt);
                    col.write(&mut out[start..], value(pt) as f64);
                })?;
            }
            None => {
                rewrite_octree_with_stride(&sub, dir, stride, stride + 4, |pt, out| {
                    out.extend_from_slice(pt);
                    out.extend_from_slice(&value(pt).to_le_bytes());
                })?;
                update_metadata_extras(dir, Some((VOXEL_CHANGE_NAME, 0.0, 1.0)), None)?;
            }
        }
        column_written = Some(VOXEL_CHANGE_NAME.to_string());
    }
    let res = VoxelChangeResult {
        voxels: a.len() as u64,
        reference_voxels: b.len() as u64,
        unchanged: (a.len() - appeared.len()) as u64,
        appeared: appeared.len() as u64,
        disappeared: gone.len() as u64,
        appeared_m3: appeared.len() as f64 * v3,
        disappeared_m3: gone.len() as f64 * v3,
        points,
        points_new,
        column_written,
        gone: gone.iter().take(200_000).map(|&k| voxel_centre(k, origin, size)).collect(),
        files,
    };
    let js = sdir.join("voxel_change.json");
    let mut v = serde_json::to_value(&res).unwrap_or_default();
    if let Some(o) = v.as_object_mut() {
        o.remove("gone");
        o.insert("referenceDir".into(), serde_json::Value::String(p.reference_dir.clone()));
        o.insert("voxelSize".into(), serde_json::json!(size));
    }
    std::fs::write(&js, serde_json::to_string_pretty(&v).unwrap_or_default()).map_err(|e| format!("write {}: {e}", js.display()))?;
    progress(1.0);
    let mut res = res;
    res.files.push(lossy(&js));
    Ok(res)
}

// ---------------------------------------------------------------------------
// ortho images

#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrthoParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// "top" (looking down) or "side" (a vertical plane, looking toward bearingDeg).
    #[serde(default = "d_top_view")]
    pub view: String,
    /// Side view: the direction looked in, degrees clockwise from grid north.
    #[serde(default)]
    pub bearing_deg: f64,
    /// Pixel size, metres (default 0.02).
    #[serde(default = "d_0_02")]
    pub pixel_size: f64,
    /// "rgb", "intensity", "height", "class", or the name of an extra column (a ramp).
    #[serde(default = "d_height")]
    pub color: String,
    /// The area: a polygon of world [x, y] vertices; a top view images its bounding box (outside transparent), a side view the points inside it. Empty = everything.
    #[serde(default)]
    pub polygon: Vec<[f64; 2]>,
    /// Side view: only points this far in front of / behind the plane through the area's centre, metres ([near, far]; empty = all).
    #[serde(default)]
    pub depth: Option<[f64; 2]>,
    /// Shade by the relief of the nearest surface (default true).
    #[serde(default = "d_true")]
    pub shade: bool,
    /// Name of the files in `survey/` (default "ortho").
    #[serde(default = "d_ortho")]
    pub out_name: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OrthoResult {
    pub width: usize,
    pub height: usize,
    pub pixel_size: f64,
    /// Share of the pixels that hold a point, percent.
    pub filled_pct: f64,
    /// World coordinates of the image's top-left corner (top view: x, y; side view: the plane's origin and axes are in the JSON file).
    pub top_left: [f64; 2],
    pub files: Vec<String>,
}

/// A colour ramp (dark blue → teal → green → yellow → light).
fn ramp(t: f64) -> [u8; 3] {
    const STOPS: [[f64; 3]; 5] = [[48.0, 18.0, 59.0], [33.0, 145.0, 140.0], [94.0, 201.0, 98.0], [253.0, 231.0, 37.0], [255.0, 250.0, 220.0]];
    let t = t.clamp(0.0, 1.0) * 4.0;
    let i = (t.floor() as usize).min(3);
    let f = t - i as f64;
    [0, 1, 2].map(|k| (STOPS[i][k] + (STOPS[i + 1][k] - STOPS[i][k]) * f).round() as u8)
}

fn class_color(c: u8) -> [u8; 3] {
    match c {
        2 => [160, 120, 80],
        3 => [150, 200, 110],
        4 => [80, 170, 70],
        5 => [30, 120, 40],
        6 => [210, 70, 60],
        7 => [230, 60, 200],
        9 => [70, 130, 220],
        _ => [170, 170, 170],
    }
}

fn percentile(sorted: &[f32], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() - 1) as f64 * q).round() as usize] as f64
}

/// RGBA GeoTIFF (uncompressed, one strip; transparent where no point).
fn write_geotiff_rgba(path: &Path, rgba: &[u8], width: usize, height: usize, left: f64, top: f64, pixel: f64, epsg: Option<u32>) -> Result<(), String> {
    // (tag, type, count, value bytes): SHORT 3, LONG 4, DOUBLE 12
    let mut tags: Vec<(u16, u16, u32, Vec<u8>)> = Vec::new();
    let short = |v: &[u16]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let long = |v: u32| v.to_le_bytes().to_vec();
    let dbl = |v: &[f64]| v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>();
    let geographic = epsg.map(crate::commands::crs::is_geographic).unwrap_or(false);
    let mut keys: Vec<[u16; 4]> = vec![[1024, 0, 1, if geographic { 2 } else { 1 }], [1025, 0, 1, 1]];
    if let Some(code) = epsg.filter(|c| *c <= u16::MAX as u32) {
        keys.push([if geographic { 2048 } else { 3072 }, 0, 1, code as u16]);
    }
    let mut gk: Vec<u16> = vec![1, 1, 0, keys.len() as u16];
    for k in &keys {
        gk.extend_from_slice(k);
    }
    let strip = (width * height * 4) as u32;
    tags.push((256, 4, 1, long(width as u32)));
    tags.push((257, 4, 1, long(height as u32)));
    tags.push((258, 3, 4, short(&[8, 8, 8, 8])));
    tags.push((259, 3, 1, short(&[1])));
    tags.push((262, 3, 1, short(&[2])));
    tags.push((273, 4, 1, long(0))); // strip offset, patched below
    tags.push((277, 3, 1, short(&[4])));
    tags.push((278, 4, 1, long(height as u32)));
    tags.push((279, 4, 1, long(strip)));
    tags.push((284, 3, 1, short(&[1])));
    tags.push((338, 3, 1, short(&[2])));
    tags.push((33550, 12, 3, dbl(&[pixel, pixel, 0.0])));
    tags.push((33922, 12, 6, dbl(&[0.0, 0.0, 0.0, left, top, 0.0])));
    tags.push((34735, 3, gk.len() as u32, short(&gk)));
    let ifd_len = 2 + tags.len() * 12 + 4;
    let mut ext_at = 8 + ifd_len;
    let mut ext: Vec<u8> = Vec::new();
    let mut entries: Vec<(u16, u16, u32, [u8; 4])> = Vec::new();
    for (tag, typ, count, bytes) in &tags {
        let mut v = [0u8; 4];
        if bytes.len() <= 4 {
            v[..bytes.len()].copy_from_slice(bytes);
        } else {
            if ext_at % 2 == 1 {
                ext.push(0);
                ext_at += 1;
            }
            v = (ext_at as u32).to_le_bytes();
            ext.extend_from_slice(bytes);
            ext_at += bytes.len();
        }
        entries.push((*tag, *typ, *count, v));
    }
    let strip_off = (ext_at + ext_at % 2) as u32;
    for e in entries.iter_mut() {
        if e.0 == 273 {
            e.3 = strip_off.to_le_bytes();
        }
    }
    let mut buf: Vec<u8> = Vec::with_capacity(strip_off as usize + rgba.len());
    buf.extend_from_slice(b"II");
    buf.extend_from_slice(&42u16.to_le_bytes());
    buf.extend_from_slice(&8u32.to_le_bytes());
    buf.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    for (tag, typ, count, v) in &entries {
        buf.extend_from_slice(&tag.to_le_bytes());
        buf.extend_from_slice(&typ.to_le_bytes());
        buf.extend_from_slice(&count.to_le_bytes());
        buf.extend_from_slice(v);
    }
    buf.extend_from_slice(&0u32.to_le_bytes());
    buf.extend_from_slice(&ext);
    buf.resize(strip_off as usize, 0);
    buf.extend_from_slice(rgba);
    std::fs::write(path, buf).map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn run_ortho(p: &OrthoParams, progress: ProgressSink) -> Result<OrthoResult, String> {
    let dir = Path::new(&p.octree_dir);
    let fr = frame(dir)?;
    let px = p.pixel_size.max(0.001);
    let side = match p.view.to_ascii_lowercase().as_str() {
        "top" => false,
        "side" => true,
        other => return Err(format!("unknown view {other:?} (top, side)")),
    };
    let poly = &p.polygon;
    if !poly.is_empty() && poly.len() < 3 {
        return Err("the area needs at least three vertices".into());
    }
    let (amin, amax) = if poly.is_empty() {
        ([fr.min[0], fr.min[1]], [fr.max[0], fr.max[1]])
    } else {
        poly.iter().fold(([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]), |(a, b), q| ([a[0].min(q[0]), a[1].min(q[1])], [b[0].max(q[0]), b[1].max(q[1])]))
    };
    let centre = [(amin[0] + amax[0]) / 2.0, (amin[1] + amax[1]) / 2.0];
    let b = p.bearing_deg.to_radians();
    let dirv = [b.sin(), b.cos()];
    let right = [b.cos(), -b.sin()];
    // the points a side view takes: inside the area, within the depth window
    let in_side = |q: [f64; 3]| -> Option<(f64, f64)> {
        if !poly.is_empty() && !point_in_polygon(poly, q[0], q[1]) {
            return None;
        }
        let (dx, dy) = (q[0] - centre[0], q[1] - centre[1]);
        let d = dx * dirv[0] + dy * dirv[1];
        if let Some([near, far]) = p.depth {
            if d < near || d > far {
                return None;
            }
        }
        Some((dx * right[0] + dy * right[1], d))
    };
    // image axes: u to the right, v up; the extent in u, v
    let (umin, umax, vmin, vmax) = if side {
        // a first pass for the extent of those points; the height from the
        // 0.05 … 99.95 % quantiles, so a bird or a noise echo high above does
        // not make the image mostly sky
        let (zlo, zhi) = (fr.min[2], fr.max[2]);
        let bins = (((zhi - zlo) / px).ceil() as usize).clamp(1, 200_000);
        let mut hist = vec![0u64; bins];
        let (mut ulo, mut uhi) = (f64::INFINITY, f64::NEG_INFINITY);
        for_each_point(dir, &fr, "ortho", progress, 0.0, 0.3, |_, q, _| {
            if let Some((u, _)) = in_side(q) {
                ulo = ulo.min(u);
                uhi = uhi.max(u);
                hist[(((q[2] - zlo) / px) as usize).min(bins - 1)] += 1;
            }
        })?;
        let total: u64 = hist.iter().sum();
        if total == 0 {
            return Err("no points in the side view (area or depth window empty)".into());
        }
        let quantile = |q: f64| {
            let target = (total as f64 * q) as u64;
            let mut acc = 0u64;
            for (k, n) in hist.iter().enumerate() {
                acc += n;
                if acc > target {
                    return k;
                }
            }
            bins - 1
        };
        let (k0, k1) = (quantile(0.0005), quantile(0.9995));
        (ulo, uhi + px, zlo + k0 as f64 * px, zlo + (k1 + 1) as f64 * px)
    } else {
        (amin[0], amax[0], amin[1], amax[1])
    };
    let width = (((umax - umin) / px).ceil() as usize).max(1);
    let height = (((vmax - vmin) / px).ceil() as usize).max(1);
    if width.saturating_mul(height) > 64_000_000 {
        return Err(format!("{width} × {height} pixels: use a larger pixel or a smaller area"));
    }
    let color = p.color.to_ascii_lowercase();
    let rgb_cols = ["red", "green", "blue"].map(|n| layout_find(&fr.extras, n).cloned());
    let extra = layout_find(&fr.extras, &p.color).cloned();
    match color.as_str() {
        "rgb" if rgb_cols.iter().any(Option::is_none) => return Err("the dataset has no RGB colours".into()),
        "rgb" | "intensity" | "height" | "class" => {}
        _ if extra.is_none() => return Err(format!("no column {:?} (rgb, intensity, height, class or an extra column)", p.color)),
        _ => {}
    }
    // per pixel: depth (smaller = nearer the viewer) and the value
    let n = width * height;
    let mut depth = vec![f32::INFINITY; n];
    let mut val = vec![0f32; n];
    let mut rgbv = vec![[0f32; 3]; if color == "rgb" { n } else { 0 }];
    for_each_point(dir, &fr, "ortho", progress, if side { 0.3 } else { 0.0 }, 0.85, |_, q, r| {
        let (u, v, d) = if side {
            let Some((u, d)) = in_side(q) else { return };
            (u, q[2], d)
        } else {
            if !poly.is_empty() && !point_in_polygon(poly, q[0], q[1]) {
                return;
            }
            (q[0], q[1], -q[2])
        };
        if u < umin || v < vmin || v > vmax {
            return;
        }
        let (c, row) = (((u - umin) / px) as usize, ((vmax - v) / px) as usize);
        if c >= width || row >= height {
            return;
        }
        let i = row * width + c;
        if (d as f32) >= depth[i] {
            return;
        }
        depth[i] = d as f32;
        val[i] = match color.as_str() {
            "intensity" => intensity(r) as f32,
            "height" => q[2] as f32,
            "class" => class(r) as f32,
            "rgb" => {
                rgbv[i] = [0, 1, 2].map(|k| rgb_cols[k].as_ref().map_or(0.0, |col| col.read(r) as f32));
                0.0
            }
            _ => extra.as_ref().map_or(0.0, |col| col.read(r) as f32),
        };
    })?;
    // colours
    let filled: Vec<usize> = (0..n).filter(|&i| depth[i].is_finite()).collect();
    if filled.is_empty() {
        return Err("no points in the image".into());
    }
    let mut vals: Vec<f32> = filled.iter().map(|&i| val[i]).filter(|v| v.is_finite()).collect();
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let (lo, hi) = (percentile(&vals, 0.02), percentile(&vals, 0.98));
    let rgb_div = if color == "rgb" && filled.iter().any(|&i| rgbv[i].iter().any(|c| *c > 255.0)) { 257.0 } else { 1.0 };
    let mut img = vec![0u8; n * 4];
    for &i in &filled {
        let c = match color.as_str() {
            "rgb" => rgbv[i].map(|v| (v / rgb_div).clamp(0.0, 255.0) as u8),
            "class" => class_color(val[i] as u8),
            "intensity" => {
                let g = (((val[i] as f64 - lo) / (hi - lo).max(1e-9)).clamp(0.0, 1.0) * 255.0) as u8;
                [g, g, g]
            }
            _ => ramp((val[i] as f64 - lo) / (hi - lo).max(1e-9)),
        };
        img[i * 4..i * 4 + 3].copy_from_slice(&c);
        img[i * 4 + 3] = 255;
    }
    if p.shade {
        // relief: light from the upper left over the nearest surface's depth
        let (w, h) = (width as i64, height as i64);
        let at = |c: i64, r: i64| -> Option<f32> { (c >= 0 && r >= 0 && c < w && r < h).then(|| depth[(r * w + c) as usize]).filter(|d| d.is_finite()) };
        for &i in &filled {
            let (c, r) = ((i % width) as i64, (i / width) as i64);
            let d0 = depth[i];
            let dx = at(c + 1, r).unwrap_or(d0) - at(c - 1, r).unwrap_or(d0);
            let dy = at(c, r + 1).unwrap_or(d0) - at(c, r - 1).unwrap_or(d0);
            // the surface's slopes toward the right and the top of the image (the
            // depth grows away from the viewer, rows grow downward); light from
            // the upper left, a flat surface keeps its colour
            let (zx, zy) = (-dx as f64 / (2.0 * px), dy as f64 / (2.0 * px));
            let nrm = (zx * zx + zy * zy + 1.0).sqrt();
            let light = ((0.5 * zx - 0.5 * zy + 0.707) / nrm).clamp(0.0, 1.0);
            let k = (0.55 + 0.45 * light / 0.707).clamp(0.35, 1.15);
            for ch in 0..3 {
                img[i * 4 + ch] = (img[i * 4 + ch] as f64 * k).clamp(0.0, 255.0) as u8;
            }
        }
    }
    progress(0.9);
    let sdir = survey_dir(dir)?;
    let name = safe_name(&p.out_name, "ortho");
    let png = sdir.join(format!("{name}.png"));
    image::save_buffer(&png, &img, width as u32, height as u32, image::ExtendedColorType::Rgba8).map_err(|e| format!("write {}: {e}", png.display()))?;
    let mut files = vec![lossy(&png)];
    let top_left = if side { [umin, vmax] } else { [umin, vmax] };
    if side {
        let js = sdir.join(format!("{name}.json"));
        let v = serde_json::json!({
            "view": "side", "bearingDeg": p.bearing_deg, "pixelSize": px, "width": width, "height": height,
            "planeOrigin": centre, "right": right, "lookDirection": dirv,
            "u0": umin, "zTop": vmax,
            "note": "pixel (col, row) is at world = planeOrigin + right·(u0 + (col+0.5)·pixelSize), z = zTop − (row+0.5)·pixelSize",
        });
        std::fs::write(&js, serde_json::to_string_pretty(&v).unwrap_or_default()).map_err(|e| format!("write {}: {e}", js.display()))?;
        files.push(lossy(&js));
    } else {
        // world file: pixel size, rotations, −pixel size, centre of the top-left pixel
        let pgw = sdir.join(format!("{name}.pgw"));
        std::fs::write(&pgw, format!("{px}\n0\n0\n{}\n{}\n{}\n", -px, umin + px / 2.0, vmax - px / 2.0)).map_err(|e| format!("write {}: {e}", pgw.display()))?;
        let tif = sdir.join(format!("{name}.tif"));
        write_geotiff_rgba(&tif, &img, width, height, umin, vmax, px, fr.epsg)?;
        files.push(lossy(&pgw));
        files.push(lossy(&tif));
    }
    progress(1.0);
    Ok(OrthoResult { width, height, pixel_size: px, filled_pct: filled.len() as f64 * 100.0 / n as f64, top_left, files })
}

// ---------------------------------------------------------------------------
// section profiles

#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// The section line: world [x, y] vertices, at least two.
    pub line: Vec<[f64; 2]>,
    /// Width of the corridor around the line, metres (default 0.5: 0.25 m to each side).
    #[serde(default = "d_0_5")]
    pub width: f64,
    /// Points returned for drawing, at most (default 200 000); the files hold every point.
    #[serde(default = "d_preview")]
    pub max_preview: usize,
    /// Name of the files in `survey/` (default "profile").
    #[serde(default = "d_profile")]
    pub out_name: String,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePreview {
    pub station: Vec<f32>,
    pub offset: Vec<f32>,
    pub z: Vec<f32>,
    pub class: Vec<u8>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProfileResult {
    pub length_m: f64,
    pub points: u64,
    pub z_min: f64,
    pub z_max: f64,
    pub preview: ProfilePreview,
    /// The ground line: [station, z] of the lowest ground point per 0.25 m.
    pub ground: Vec<[f64; 2]>,
    pub files: Vec<String>,
}

/// Station (along the line) and signed offset (left positive) of a point
/// against the polyline, from the nearest segment it projects onto; None
/// when it projects onto none.
pub fn station_offset(line: &[[f64; 2]], cum: &[f64], x: f64, y: f64) -> Option<(f64, f64)> {
    let mut best: Option<(f64, f64, f64)> = None;
    for i in 0..line.len() - 1 {
        let (a, b) = (line[i], line[i + 1]);
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        if l2 <= 0.0 {
            continue;
        }
        let t = ((x - a[0]) * dx + (y - a[1]) * dy) / l2;
        if !(0.0..=1.0).contains(&t) {
            continue;
        }
        let l = l2.sqrt();
        let off = (dx * (y - a[1]) - dy * (x - a[0])) / l;
        if best.map_or(true, |bst| off.abs() < bst.2.abs()) {
            best = Some((cum[i] + t * l, off, off));
        }
    }
    best.map(|b| (b.0, b.1))
}

fn profile_svg(st: &[f32], z: &[f32], cls: &[u8], ground: &[[f64; 2]], length: f64, zmin: f64, zmax: f64) -> String {
    use std::fmt::Write as _;
    let (w, margin) = (1600.0, 50.0);
    let span_z = (zmax - zmin).max(1.0);
    let scale = ((w - 2.0 * margin) / length.max(1e-6)).min(700.0 / span_z);
    let h = span_z * scale + 2.0 * margin;
    let x = |s: f64| margin + s * scale;
    let y = |v: f64| h - margin - (v - zmin) * scale;
    let mut s = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w}\" height=\"{h:.0}\" viewBox=\"0 0 {w} {h:.0}\" font-family=\"sans-serif\" font-size=\"11\">\n<rect width=\"100%\" height=\"100%\" fill=\"white\"/>\n"
    );
    // grid and labels
    let step = |range: f64| {
        let raw = range / 8.0;
        let p = 10f64.powf(raw.log10().floor());
        [1.0, 2.0, 5.0, 10.0].iter().map(|k| k * p).find(|k| *k >= raw).unwrap_or(10.0 * p)
    };
    let (ss, zs) = (step(length), step(span_z));
    let mut v = 0.0;
    while v <= length + 1e-9 {
        let _ = writeln!(s, "<line x1=\"{0:.1}\" y1=\"{1:.1}\" x2=\"{0:.1}\" y2=\"{2:.1}\" stroke=\"#ddd\"/><text x=\"{0:.1}\" y=\"{3:.1}\" text-anchor=\"middle\">{4}</text>", x(v), margin, h - margin, h - margin + 15.0, number_label(v));
        v += ss;
    }
    let mut v = (zmin / zs).ceil() * zs;
    while v <= zmax + 1e-9 {
        let _ = writeln!(s, "<line x1=\"{0:.1}\" y1=\"{1:.1}\" x2=\"{2:.1}\" y2=\"{1:.1}\" stroke=\"#ddd\"/><text x=\"{3:.1}\" y=\"{4:.1}\" text-anchor=\"end\">{5}</text>", margin, y(v), w - margin, margin - 5.0, y(v) + 4.0, number_label(v));
        v += zs;
    }
    s.push_str("<g>\n");
    for i in 0..st.len() {
        let c = class_color(cls[i]);
        let _ = writeln!(s, "<rect x=\"{:.1}\" y=\"{:.1}\" width=\"1.5\" height=\"1.5\" fill=\"rgb({},{},{})\"/>", x(st[i] as f64), y(z[i] as f64), c[0], c[1], c[2]);
    }
    s.push_str("</g>\n");
    if ground.len() > 1 {
        let pts: Vec<String> = ground.iter().map(|g| format!("{:.1},{:.1}", x(g[0]), y(g[1]))).collect();
        let _ = writeln!(s, "<polyline points=\"{}\" fill=\"none\" stroke=\"#8b5a2b\" stroke-width=\"1.5\"/>", pts.join(" "));
    }
    let _ = writeln!(s, "<text x=\"{margin}\" y=\"20\">section {} m, heights {} – {} m (1:1)</text>\n</svg>", number_label(length), number_label(zmin), number_label(zmax));
    s
}

pub fn run_profile(p: &ProfileParams, progress: ProgressSink) -> Result<ProfileResult, String> {
    if p.line.len() < 2 {
        return Err("the section line needs at least two points".into());
    }
    let dir = Path::new(&p.octree_dir);
    let fr = frame(dir)?;
    let half = (p.width / 2.0).max(0.001);
    let mut cum = vec![0.0];
    for w in p.line.windows(2) {
        cum.push(cum.last().unwrap() + ((w[1][0] - w[0][0]).powi(2) + (w[1][1] - w[0][1]).powi(2)).sqrt());
    }
    let length = *cum.last().unwrap();
    if length <= 0.0 {
        return Err("the section line has no length".into());
    }
    let (lo, hi) = p.line.iter().fold(([f64::INFINITY; 2], [f64::NEG_INFINITY; 2]), |(a, b), q| ([a[0].min(q[0]), a[1].min(q[1])], [b[0].max(q[0]), b[1].max(q[1])]));
    let (lo, hi) = ([lo[0] - half, lo[1] - half], [hi[0] + half, hi[1] + half]);
    struct Row {
        st: f32,
        off: f32,
        x: f64,
        y: f64,
        z: f64,
        cls: u8,
        int: u16,
    }
    let mut rows: Vec<Row> = Vec::new();
    for_each_point(dir, &fr, "profile", progress, 0.0, 0.85, |_, q, r| {
        if q[0] < lo[0] || q[1] < lo[1] || q[0] > hi[0] || q[1] > hi[1] {
            return;
        }
        if let Some((st, off)) = station_offset(&p.line, &cum, q[0], q[1]) {
            if off.abs() <= half {
                rows.push(Row { st: st as f32, off: off as f32, x: q[0], y: q[1], z: q[2], cls: class(r), int: intensity(r) });
            }
        }
    })?;
    if rows.is_empty() {
        return Err("no points along the section line".into());
    }
    rows.sort_by(|a, b| a.st.partial_cmp(&b.st).unwrap());
    let (zmin, zmax) = rows.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), r| (a.min(r.z), b.max(r.z)));
    // the ground line: lowest ground point per 0.25 m of station
    let bin = 0.25;
    let mut gbins: Vec<f64> = vec![f64::NAN; (length / bin).ceil() as usize + 1];
    for r in rows.iter().filter(|r| r.cls == 2) {
        let k = (r.st as f64 / bin) as usize;
        if k < gbins.len() && (gbins[k].is_nan() || r.z < gbins[k]) {
            gbins[k] = r.z;
        }
    }
    let ground: Vec<[f64; 2]> = gbins.iter().enumerate().filter(|(_, z)| z.is_finite()).map(|(k, z)| [(k as f64 + 0.5) * bin, *z]).collect();
    let step = rows.len().div_ceil(p.max_preview.max(1));
    let mut preview = ProfilePreview::default();
    for r in rows.iter().step_by(step) {
        preview.station.push(r.st);
        preview.offset.push(r.off);
        preview.z.push(r.z as f32);
        preview.class.push(r.cls);
    }
    progress(0.9);
    let sdir = survey_dir(dir)?;
    let name = safe_name(&p.out_name, "profile");
    let csv = sdir.join(format!("{name}.csv"));
    {
        let mut w = std::io::BufWriter::new(File::create(&csv).map_err(|e| format!("create {}: {e}", csv.display()))?);
        writeln!(w, "station,offset,z,x,y,class,intensity").map_err(|e| e.to_string())?;
        for r in &rows {
            writeln!(w, "{:.3},{:.3},{:.3},{:.3},{:.3},{},{}", r.st, r.off, r.z, r.x, r.y, r.cls, r.int).map_err(|e| e.to_string())?;
        }
    }
    let svg_step = rows.len().div_ceil(60_000);
    let sv: Vec<&Row> = rows.iter().step_by(svg_step.max(1)).collect();
    let svg = sdir.join(format!("{name}.svg"));
    let st: Vec<f32> = sv.iter().map(|r| r.st).collect();
    let zz: Vec<f32> = sv.iter().map(|r| r.z as f32).collect();
    let cc: Vec<u8> = sv.iter().map(|r| r.cls).collect();
    std::fs::write(&svg, profile_svg(&st, &zz, &cc, &ground, length, zmin, zmax)).map_err(|e| format!("write {}: {e}", svg.display()))?;
    // the line and its ground as DXF: the line in plan, the ground in 3D
    let mut dxf = Dxf::new();
    dxf.layer("SECTION_LINE", 1);
    dxf.layer("SECTION_GROUND", 32);
    let z0 = ground.first().map_or(zmin, |g| g[1]);
    dxf.polyline("SECTION_LINE", &p.line.iter().map(|q| [q[0], q[1], z0]).collect::<Vec<_>>(), false);
    let ground3: Vec<[f64; 3]> = ground
        .iter()
        .filter_map(|g| {
            // back to plan coordinates along the line
            let i = cum.windows(2).position(|w| g[0] >= w[0] && g[0] <= w[1])?;
            let t = (g[0] - cum[i]) / (cum[i + 1] - cum[i]).max(1e-12);
            let (a, b) = (p.line[i], p.line[i + 1]);
            Some([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), g[1]])
        })
        .collect();
    dxf.polyline("SECTION_GROUND", &ground3, false);
    let dxf_path = sdir.join(format!("{name}.dxf"));
    dxf.write(&dxf_path)?;
    progress(1.0);
    Ok(ProfileResult { length_m: length, points: rows.len() as u64, z_min: zmin, z_max: zmax, preview, ground, files: vec![lossy(&csv), lossy(&svg), lossy(&dxf_path)] })
}

// ---------------------------------------------------------------------------
// measured lines and areas

#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeometryParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Name of the files in `survey/` (default "polyline").
    #[serde(default = "d_polyline")]
    pub name: String,
    /// The vertices, world [x, y, z].
    pub points: Vec<[f64; 3]>,
    /// An area (the last vertex joins the first) rather than a line.
    #[serde(default)]
    pub closed: bool,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Measures {
    /// Along the vertices: in 3D and in plan, metres (an area: its perimeter).
    pub length_3d: f64,
    pub length_2d: f64,
    /// Plan area of a closed polygon, square metres (0 for a line).
    pub area_2d: f64,
    /// Highest minus lowest vertex, and the first-to-last height change, metres.
    pub height_range: f64,
    pub rise: f64,
}

/// Lengths, plan area and heights of a polyline or polygon.
pub fn measures(points: &[[f64; 3]], closed: bool) -> Measures {
    let n = points.len();
    if n == 0 {
        return Measures::default();
    }
    let seg = |a: [f64; 3], b: [f64; 3]| {
        let (dx, dy, dz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        ((dx * dx + dy * dy + dz * dz).sqrt(), (dx * dx + dy * dy).sqrt())
    };
    let mut m = Measures::default();
    let edges = if closed && n > 2 { n } else { n - 1 };
    for i in 0..edges {
        let (l3, l2) = seg(points[i], points[(i + 1) % n]);
        m.length_3d += l3;
        m.length_2d += l2;
    }
    if closed && n > 2 {
        let plan: Vec<[f64; 2]> = points.iter().map(|q| [q[0], q[1]]).collect();
        m.area_2d = polygon_area(&plan);
    }
    let (lo, hi) = points.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), q| (a.min(q[2]), b.max(q[2])));
    m.height_range = hi - lo;
    m.rise = points[n - 1][2] - points[0][2];
    m
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GeometryResult {
    pub measures: Measures,
    pub files: Vec<String>,
}

/// Writes a measured line or area into `survey/`: GeoJSON (with its
/// measures), DXF and a CSV of the vertices.
pub fn save_geometry(p: &GeometryParams) -> Result<GeometryResult, String> {
    if p.points.len() < 2 {
        return Err("a line needs at least two points".into());
    }
    let dir = Path::new(&p.octree_dir);
    let fr = frame(dir)?;
    let m = measures(&p.points, p.closed);
    let sdir = survey_dir(dir)?;
    let name = safe_name(&p.name, "polyline");
    let mut coords = p.points.clone();
    if p.closed {
        coords.push(coords[0]);
    }
    let geometry = if p.closed {
        serde_json::json!({"type": "Polygon", "coordinates": [coords]})
    } else {
        serde_json::json!({"type": "LineString", "coordinates": coords})
    };
    let mut gj = serde_json::json!({
        "type": "FeatureCollection", "name": name,
        "features": [{"type": "Feature", "geometry": geometry, "properties": serde_json::to_value(&m).unwrap_or_default()}],
    });
    if let Some(code) = fr.epsg {
        gj["crs"] = serde_json::json!({"type": "name", "properties": {"name": format!("urn:ogc:def:crs:EPSG::{code}")}});
    }
    let gj_path = sdir.join(format!("{name}.geojson"));
    std::fs::write(&gj_path, serde_json::to_string_pretty(&gj).unwrap_or_default()).map_err(|e| format!("write {}: {e}", gj_path.display()))?;
    let mut dxf = Dxf::new();
    dxf.layer("SURVEY", 2);
    dxf.polyline("SURVEY", &p.points, p.closed);
    let dxf_path = sdir.join(format!("{name}.dxf"));
    dxf.write(&dxf_path)?;
    let csv_path = sdir.join(format!("{name}.csv"));
    let mut csv = String::from("vertex,x,y,z\n");
    for (i, q) in p.points.iter().enumerate() {
        csv.push_str(&format!("{},{:.4},{:.4},{:.4}\n", i + 1, q[0], q[1], q[2]));
    }
    std::fs::write(&csv_path, csv).map_err(|e| format!("write {}: {e}", csv_path.display()))?;
    Ok(GeometryResult { measures: m, files: vec![lossy(&gj_path), lossy(&dxf_path), lossy(&csv_path)] })
}

// ---------------------------------------------------------------------------
// points as DXF

#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DxfPointsParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// The area: a polygon of world [x, y] vertices; empty = everything.
    #[serde(default)]
    pub polygon: Vec<[f64; 2]>,
    /// Only points of these classes (empty = all).
    #[serde(default)]
    pub classes: Vec<u8>,
    /// Only points between these heights, metres ([low, high]; empty = all).
    #[serde(default)]
    pub z_range: Option<[f64; 2]>,
    /// Keep every n-th point (default 1 = all).
    #[serde(default = "d_1u")]
    pub every: u32,
    /// Refuse to write more points than this (DXF is large and slow to read; default 5 000 000).
    #[serde(default = "d_max_dxf")]
    pub max_points: u64,
    /// Name of the file in `survey/` (default "points").
    #[serde(default = "d_points")]
    pub out_name: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DxfPointsResult {
    pub points: u64,
    /// Points per class (layer CLASS_<n>).
    pub classes: Vec<(u8, u64)>,
    pub files: Vec<String>,
}

/// AutoCAD colour index of a class layer.
fn class_aci(c: u8) -> i32 {
    match c {
        2 => 34,
        3 => 82,
        4 => 92,
        5 => 102,
        6 => 1,
        9 => 150,
        _ => 8,
    }
}

/// The points (inside the area, of the classes, every n-th) as DXF POINT entities, one layer
/// per class. Two passes: the layers go before the entities.
pub fn run_dxf_points(p: &DxfPointsParams, progress: ProgressSink) -> Result<DxfPointsResult, String> {
    let dir = Path::new(&p.octree_dir);
    let fr = frame(dir)?;
    if !p.polygon.is_empty() && p.polygon.len() < 3 {
        return Err("the area needs at least three vertices".into());
    }
    let every = p.every.max(1) as u64;
    let keep = |q: [f64; 3], r: &[u8]| -> bool {
        (p.classes.is_empty() || p.classes.contains(&class(r)))
            && p.z_range.map_or(true, |[lo, hi]| q[2] >= lo && q[2] <= hi)
            && (p.polygon.is_empty() || point_in_polygon(&p.polygon, q[0], q[1]))
    };
    let mut counts = [0u64; 256];
    let mut seen = 0u64;
    for_each_point(dir, &fr, "dxf_points", progress, 0.0, 0.3, |_, q, r| {
        if keep(q, r) {
            if seen % every == 0 {
                counts[class(r) as usize] += 1;
            }
            seen += 1;
        }
    })?;
    let total: u64 = counts.iter().sum();
    if total == 0 {
        return Err("no points to write".into());
    }
    if total > p.max_points {
        return Err(format!("{total} points: more than {} — keep every n-th point or a smaller area", p.max_points));
    }
    let sdir = survey_dir(dir)?;
    let name = safe_name(&p.out_name, "points");
    let path = sdir.join(format!("{name}.dxf"));
    let io = |e: std::io::Error| format!("write {}: {e}", path.display());
    let mut w = std::io::BufWriter::with_capacity(4 << 20, File::create(&path).map_err(|e| format!("create {}: {e}", path.display()))?);
    let used: Vec<(u8, u64)> = (0..256).filter(|&c| counts[c] > 0).map(|c| (c as u8, counts[c])).collect();
    write!(w, "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n{}\n", used.len()).map_err(io)?;
    for (c, _) in &used {
        write!(w, "0\nLAYER\n2\nCLASS_{c}\n70\n0\n62\n{}\n6\nCONTINUOUS\n", class_aci(*c)).map_err(io)?;
    }
    w.write_all(b"0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n").map_err(io)?;
    let mut seen = 0u64;
    let mut err: Option<String> = None;
    for_each_point(dir, &fr, "dxf_points", progress, 0.3, 1.0, |_, q, r| {
        if err.is_some() || !keep(q, r) {
            return;
        }
        if seen % every == 0 {
            if let Err(e) = write!(w, "0\nPOINT\n8\nCLASS_{}\n10\n{:.4}\n20\n{:.4}\n30\n{:.4}\n", class(r), q[0], q[1], q[2]) {
                err = Some(e.to_string());
            }
        }
        seen += 1;
    })?;
    if let Some(e) = err {
        return Err(format!("write {}: {e}", path.display()));
    }
    w.write_all(b"0\nENDSEC\n0\nEOF\n").map_err(io)?;
    w.flush().map_err(io)?;
    Ok(DxfPointsResult { points: total, classes: used, files: vec![lossy(&path)] })
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn survey_dxf_points(window: tauri::Window, params: DxfPointsParams) -> Result<DxfPointsResult, String> {
    blocking(window, "dxf_points", move |pr| run_dxf_points(&params, pr)).await
}

// ---------------------------------------------------------------------------
// defaults

fn d_max_dxf() -> u64 {
    5_000_000
}
fn d_points() -> String {
    "points".into()
}

fn d_polyline() -> String {
    "polyline".into()
}

fn d_0_5() -> f64 {
    0.5
}
fn d_0_1() -> f64 {
    0.1
}
fn d_0_02() -> f64 {
    0.02
}
fn d_2f() -> f64 {
    2.0
}
fn d_5() -> u32 {
    5
}
fn d_2() -> u32 {
    2
}
fn d_1u() -> u32 {
    1
}
fn d_true() -> bool {
    true
}
fn d_preview() -> usize {
    200_000
}
fn d_top() -> String {
    "top".into()
}
fn d_rim() -> String {
    "rim".into()
}
fn d_volume() -> String {
    "volume".into()
}
fn d_top_view() -> String {
    "top".into()
}
fn d_height() -> String {
    "height".into()
}
fn d_ortho() -> String {
    "ortho".into()
}
fn d_profile() -> String {
    "profile".into()
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    #[test]
    fn contours_of_a_cone_are_closed_circles() {
        // a cone: z = 10 − distance from the centre, 41 × 41 lattice
        let n = 41;
        let z: Vec<f32> = (0..n * n).map(|i| { let (c, r) = ((i % n) as f64 - 20.0, (i / n) as f64 - 20.0); (10.0 - (c * c + r * r).sqrt()) as f32 }).collect();
        let lines = contour_level(&z, n, n, 5.0);
        assert_eq!(lines.len(), 1);
        let (pts, closed) = &lines[0];
        assert!(*closed);
        for q in pts {
            let d = ((q[0] - 20.0).powi(2) + (q[1] - 20.0).powi(2)).sqrt();
            assert!((d - 5.0).abs() < 0.1, "{q:?} at {d}");
        }
    }

    #[test]
    fn contours_of_a_slope_are_open_lines_across_it() {
        // a plane rising along x: every level is one straight open line
        let (cols, rows) = (20, 10);
        let z: Vec<f32> = (0..cols * rows).map(|i| (i % cols) as f32 * 0.5).collect();
        let lines = contour_level(&z, cols, rows, 2.25);
        assert_eq!(lines.len(), 1);
        let (pts, closed) = &lines[0];
        assert!(!*closed);
        assert_eq!(pts.len(), rows);
        assert!(pts.iter().all(|q| (q[0] - 4.5).abs() < 1e-9));
        // holes split a line, they never join across no data
        let mut holed = z.clone();
        holed[5 * cols + 4] = f32::NAN;
        holed[5 * cols + 5] = f32::NAN;
        assert_eq!(contour_level(&holed, cols, rows, 2.25).len(), 2);
    }

    #[test]
    fn polygons_and_planes() {
        let sq = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        assert!(point_in_polygon(&sq, 5.0, 5.0) && !point_in_polygon(&sq, 11.0, 5.0));
        assert!((polygon_area(&sq) - 100.0).abs() < 1e-12);
        let pts: Vec<[f64; 3]> = (0..25).map(|i| { let (x, y) = ((i % 5) as f64, (i / 5) as f64); [x, y, 2.0 + 0.1 * x - 0.2 * y] }).collect();
        let (abc, o) = fit_plane(&pts).unwrap();
        assert!((abc[0] - 0.1).abs() < 1e-12 && (abc[1] + 0.2).abs() < 1e-12);
        assert!((abc[2] - (2.0 + 0.1 * o[0] - 0.2 * o[1])).abs() < 1e-12);
    }

    #[test]
    fn voxel_keys_round_trip_and_reach_their_neighbours() {
        let o = [400_000.0, 6_700_000.0, 100.0];
        let k = voxel_key([400_012.34, 6_700_005.0, 101.0], o, 0.1).unwrap();
        let c = voxel_centre(k, o, 0.1);
        assert!((c[0] - 400_012.35).abs() < 1e-6 && (c[1] - 6_700_005.05).abs() < 1e-6 && (c[2] - 101.05).abs() < 1e-6);
        let k2 = voxel_key([400_012.44, 6_700_005.0, 101.0], o, 0.1).unwrap();
        assert!(voxel_neighbours(k).any(|n| n == k2));
        assert_eq!(voxel_neighbours(k).count(), 27);
        assert!(voxel_key([400_000.0 - 200_000.0, 6_700_000.0, 100.0], o, 0.1).is_none());
    }

    #[test]
    fn stations_and_offsets_along_a_bent_line() {
        let line = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]];
        let cum = [0.0, 10.0, 20.0];
        let (s, o) = station_offset(&line, &cum, 4.0, 0.3).unwrap();
        assert!((s - 4.0).abs() < 1e-12 && (o - 0.3).abs() < 1e-12, "left of the line is positive");
        let (s, o) = station_offset(&line, &cum, 10.2, 6.0).unwrap();
        assert!((s - 16.0).abs() < 1e-12 && (o + 0.2).abs() < 1e-12);
        // before the start only the bend projects: far to the side, outside any corridor
        let (s, o) = station_offset(&line, &cum, -1.0, 0.0).unwrap();
        assert!((s - 10.0).abs() < 1e-12 && (o - 11.0).abs() < 1e-12);
        assert!(station_offset(&line, &cum, -1.0, -5.0).is_none());
    }

    #[test]
    fn dxf_has_the_sections_a_reader_expects() {
        let mut d = Dxf::new();
        d.layer("A", 1);
        d.polyline("A", &[[0.0, 0.0, 1.0], [1.0, 0.0, 1.0]], false);
        d.point("A", [1.0, 2.0, 3.0]);
        let path = std::env::temp_dir().join(format!("tp_dxf_{}.dxf", std::process::id()));
        d.write(&path).unwrap();
        let s = std::fs::read_to_string(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        for k in ["AC1009", "TABLES", "LAYER", "ENTITIES", "POLYLINE", "VERTEX", "SEQEND", "POINT", "EOF"] {
            assert!(s.contains(k), "{k}");
        }
        assert_eq!(s.matches("VERTEX").count(), 2);
    }

    #[test]
    fn the_rgba_geotiff_is_a_tiff_with_its_georeference() {
        let path = std::env::temp_dir().join(format!("tp_rgba_{}.tif", std::process::id()));
        let img: Vec<u8> = (0..3 * 2 * 4).map(|i| i as u8).collect();
        write_geotiff_rgba(&path, &img, 3, 2, 1000.0, 2000.0, 0.5, Some(3067)).unwrap();
        let b = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(&b[0..4], b"II\x2a\x00");
        let n = u16::from_le_bytes([b[8], b[9]]) as usize;
        let tag = |t: u16| (0..n).map(|k| 10 + k * 12).find(|&o| u16::from_le_bytes([b[o], b[o + 1]]) == t);
        let strip = tag(273).map(|o| u32::from_le_bytes(b[o + 8..o + 12].try_into().unwrap()) as usize).unwrap();
        assert_eq!(&b[strip..], &img[..]);
        let tie = tag(33922).map(|o| u32::from_le_bytes(b[o + 8..o + 12].try_into().unwrap()) as usize).unwrap();
        let f = |k: usize| f64::from_le_bytes(b[tie + 8 * k..tie + 8 * k + 8].try_into().unwrap());
        assert_eq!((f(3), f(4)), (1000.0, 2000.0));
        // tags ascending, as TIFF requires
        let ids: Vec<u16> = (0..n).map(|k| u16::from_le_bytes([b[10 + k * 12], b[11 + k * 12]])).collect();
        assert!(ids.windows(2).all(|w| w[0] < w[1]));
    }

    /// A dataset of `pts` (x, y, z, class) at millimetre resolution.
    fn write_dataset(dir: &Path, pts: &[([f64; 3], u8)]) {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).unwrap();
        let pb = 21usize;
        let mut bin = vec![0u8; pts.len() * pb];
        let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
        for (i, (p, cls)) in pts.iter().enumerate() {
            for a in 0..3 {
                bin[i * pb + a * 4..i * pb + a * 4 + 4].copy_from_slice(&((p[a] / 0.001).round() as i32).to_le_bytes());
                lo[a] = lo[a].min(p[a]);
                hi[a] = hi[a].max(p[a]);
            }
            bin[i * pb + 16..i * pb + 18].copy_from_slice(&(1000u16 + (p[2] * 100.0) as u16).to_le_bytes());
            bin[i * pb + 18] = *cls;
            bin[i * pb + 19] = 0x11;
        }
        std::fs::write(dir.join("octree.bin"), &bin).unwrap();
        let mut hier = vec![0u8; 24];
        hier[4..8].copy_from_slice(&(pts.len() as u32).to_le_bytes());
        hier[16..24].copy_from_slice(&((pts.len() * pb) as u64).to_le_bytes());
        std::fs::write(dir.join("hierarchy.bin"), &hier).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            format!(
                r#"{{"scale":[0.001,0.001,0.001],"offset":[0,0,0],"pointBytes":{pb},"crs":{{"epsg":3067}},"boundingBox":{{"min":[{},{},{}],"max":[{},{},{}]}}}}"#,
                lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]
            ),
        )
        .unwrap();
    }

    /// Ground rising 0.1 m per metre eastward over 20 × 20 m; with `pile`, a
    /// cone (radius 3 m, height 1.5 m, 14.14 m³) on it at (10, 10).
    fn scene(pile: bool) -> Vec<([f64; 3], u8)> {
        let mut v = Vec::new();
        for i in 0..=200 {
            for j in 0..=200 {
                let (x, y) = (i as f64 * 0.1, j as f64 * 0.1);
                v.push(([x, y, 0.1 * x], 2));
                let d = ((x - 10.0).powi(2) + (y - 10.0).powi(2)).sqrt();
                if pile && d < 3.0 {
                    v.push(([x, y, 0.1 * x + 1.5 * (1.0 - d / 3.0)], 1));
                }
            }
        }
        v
    }

    pub(in crate::commands::octree) fn dataset(name: &str, pile: bool) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tp_survey_{name}_{}", std::process::id()));
        write_dataset(&dir, &scene(pile));
        dir
    }

    fn quiet() -> impl Fn(f32) {
        |_| {}
    }

    #[test]
    fn contours_volumes_ortho_and_profile_on_a_pile() {
        let dir = dataset("pile", true);
        let d = dir.to_string_lossy().into_owned();
        let pr = quiet();
        // contours of the ground (the pile is not ground): straight lines every 0.5 m, i.e. every 5 m east
        let c = run_contours(&ContourParams { octree_dir: d.clone(), interval: 0.5, index_every: 2, cell_size: 0.5, smooth: 0, min_length: 2.0, polygon: vec![] }, &pr).unwrap();
        assert!(c.lines.iter().any(|l| (l.z - 1.0).abs() < 1e-9 && l.index));
        for l in &c.lines {
            for q in &l.points {
                assert!((0.1 * q[0] - l.z).abs() < 0.03, "{q:?} on the {} m line", l.z);
            }
        }
        assert!(c.files.iter().all(|f| Path::new(f).is_file()));
        let gj: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&c.files[0]).unwrap()).unwrap();
        assert_eq!(gj["crs"]["properties"]["name"], "urn:ogc:def:crs:EPSG::3067");
        // inside an area only: the lines stop at its edge
        let inner = vec![[5.0, 5.0], [15.0, 5.0], [15.0, 15.0], [5.0, 15.0]];
        let c = run_contours(&ContourParams { octree_dir: d.clone(), interval: 0.5, index_every: 2, cell_size: 0.5, smooth: 0, min_length: 2.0, polygon: inner }, &pr).unwrap();
        assert!(!c.lines.is_empty());
        assert!(c.lines.iter().flat_map(|l| l.points.iter()).all(|q| q[0] > 4.4 && q[0] < 15.6 && q[1] > 4.4 && q[1] < 15.6));
        // the pile's volume above a plane fitted to the area's edge, and above the ground model
        let sq = vec![[6.0, 6.0], [14.0, 6.0], [14.0, 14.0], [6.0, 14.0]];
        let base = VolumeParams {
            octree_dir: d.clone(), polygon: sq, surface: "top".into(), reference: "rim".into(), plane_z: None,
            cell_size: 0.1, classes: vec![], fill_gaps: true, out_name: "pile".into(),
        };
        let v = run_volume(&base, &pr).unwrap();
        let cone = std::f64::consts::PI * 9.0 * 1.5 / 3.0;
        assert!((v.above_m3 - cone).abs() / cone < 0.03, "{v:?} vs {cone}");
        assert!(v.below_m3 < 0.05, "{v:?}");
        assert!((v.area_m2 - 64.0).abs() < 1e-9 && v.reference.contains("slope 5.7"), "{}", v.reference);
        let v = run_volume(&VolumeParams { reference: "dtm".into(), ..base.clone() }, &pr).unwrap();
        assert!((v.above_m3 - cone).abs() / cone < 0.05, "{v:?}");
        // only the ground: nothing above it
        let v = run_volume(&VolumeParams { surface: "ground".into(), ..base.clone() }, &pr).unwrap();
        assert!(v.above_m3 < 0.05 && v.below_m3 < 0.05, "{v:?}");
        // the ortho image of the classes and its georeference
        let o = run_ortho(&OrthoParams {
            octree_dir: d.clone(), view: "top".into(), bearing_deg: 0.0, pixel_size: 0.2, color: "class".into(),
            polygon: vec![], depth: None, shade: true, out_name: "top".into(),
        }, &pr).unwrap();
        assert_eq!((o.width, o.height), (100, 100));
        assert!(o.filled_pct > 99.0, "{o:?}");
        let img = image::open(&o.files[0]).unwrap().to_rgba8();
        assert_eq!(img.dimensions(), (100, 100));
        let pgw = std::fs::read_to_string(&o.files[1]).unwrap();
        assert!(pgw.starts_with("0.2\n0\n0\n-0.2\n0.1\n19.9"), "{pgw}");
        // a side view looking north: the pile's flank
        let s = run_ortho(&OrthoParams {
            octree_dir: d.clone(), view: "side".into(), bearing_deg: 0.0, pixel_size: 0.1, color: "height".into(),
            polygon: vec![], depth: Some([-1.0, 1.0]), shade: false, out_name: "side".into(),
        }, &pr).unwrap();
        // the window's points: x 0 … 20 (u −10 … 10), z 0 … 2.5 at most
        assert!(s.files[1].ends_with("side.json") && s.width == 201 && (24..=26).contains(&s.height), "{s:?}");
        // a section through the pile from west to east
        let p = run_profile(&ProfileParams { octree_dir: d.clone(), line: vec![[0.0, 10.0], [20.0, 10.0]], width: 0.1, max_preview: 1000, out_name: "x".into() }, &pr).unwrap();
        assert!((p.length_m - 20.0).abs() < 1e-12 && p.preview.station.len() <= 1000);
        assert!((p.z_max - 2.5).abs() < 0.02, "{}", p.z_max);
        assert!(p.ground.iter().all(|g| (g[1] - 0.1 * g[0]).abs() < 0.03));
        assert!(std::fs::read_to_string(&p.files[1]).unwrap().starts_with("<svg"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn voxel_change_finds_the_new_pile_and_marks_its_points() {
        let now = dataset("now", true);
        let before = dataset("before", false);
        let pr = quiet();
        let params = VoxelChangeParams {
            octree_dir: now.to_string_lossy().into_owned(), reference_dir: before.to_string_lossy().into_owned(),
            voxel_size: 0.2, neighbours: true, min_points: 1, write_column: true,
        };
        let r = run_voxel_change(&params, &pr).unwrap();
        assert_eq!(r.disappeared, 0);
        assert!(r.appeared > 100 && r.points_new > 1000, "{r:?}");
        assert_eq!(r.column_written.as_deref(), Some(VOXEL_CHANGE_NAME));
        // the column: 1 on the pile's upper part, 0 on the ground
        let fr = frame(&now).unwrap();
        let col = layout_find(&fr.extras, VOXEL_CHANGE_NAME).unwrap().clone();
        let (mut ground_new, mut top_new, mut top) = (0, 0, 0);
        for_each_point(&now, &fr, "voxel_change", &pr, 0.0, 1.0, |_, q, rec| {
            let v = col.read(rec);
            if class(rec) == 2 && v > 0.5 {
                ground_new += 1;
            }
            let d = ((q[0] - 10.0).powi(2) + (q[1] - 10.0).powi(2)).sqrt();
            if class(rec) == 1 && d < 1.5 {
                top += 1;
                if v > 0.5 {
                    top_new += 1;
                }
            }
        })
        .unwrap();
        assert_eq!(ground_new, 0);
        assert_eq!(top_new, top);
        // a second run overwrites the column in place
        let r2 = run_voxel_change(&params, &pr).unwrap();
        assert_eq!(r2.appeared, r.appeared);
        assert_eq!(frame(&now).unwrap().stride, 25);
        // the other way round: the pile is gone
        let back = run_voxel_change(&VoxelChangeParams { octree_dir: params.reference_dir.clone(), reference_dir: params.octree_dir.clone(), write_column: false, ..params.clone() }, &pr).unwrap();
        assert_eq!((back.appeared, back.disappeared), (0, r.appeared));
        let _ = std::fs::remove_dir_all(&now);
        let _ = std::fs::remove_dir_all(&before);
    }

    #[test]
    fn measures_of_a_line_and_an_area() {
        let sq = [[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [3.0, 4.0, 1.0], [0.0, 4.0, 1.0]];
        let line = measures(&sq, false);
        assert!((line.length_2d - 10.0).abs() < 1e-12);
        assert!((line.length_3d - (3.0 + 17f64.sqrt() + 3.0)).abs() < 1e-12);
        assert_eq!((line.area_2d, line.height_range, line.rise), (0.0, 1.0, 1.0));
        let area = measures(&sq, true);
        assert!((area.length_2d - 14.0).abs() < 1e-12 && (area.area_2d - 12.0).abs() < 1e-12);
        let dir = dataset("geom", false);
        let r = save_geometry(&GeometryParams { octree_dir: dir.to_string_lossy().into_owned(), name: "plot edge".into(), points: sq.to_vec(), closed: true }).unwrap();
        assert!(r.files[0].ends_with("plot_edge.geojson"));
        let gj: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&r.files[0]).unwrap()).unwrap();
        assert_eq!(gj["features"][0]["geometry"]["type"], "Polygon");
        assert_eq!(gj["features"][0]["properties"]["area2d"], 12.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn points_as_dxf_by_class() {
        let dir = dataset("dxf", true);
        let d = dir.to_string_lossy().into_owned();
        let pr = quiet();
        let p = DxfPointsParams { octree_dir: d.clone(), polygon: vec![], classes: vec![], z_range: None, every: 10, max_points: 5_000_000, out_name: "pts".into() };
        let r = run_dxf_points(&p, &pr).unwrap();
        let text = std::fs::read_to_string(&r.files[0]).unwrap();
        assert_eq!(text.matches("\nPOINT\n").count() as u64, r.points);
        assert_eq!(r.classes.iter().map(|c| c.0).collect::<Vec<_>>(), vec![1, 2]);
        assert!(text.contains("CLASS_2") && text.ends_with("EOF\n"));
        // the limit says what to do
        let e = run_dxf_points(&DxfPointsParams { every: 1, max_points: 1000, ..p }, &pr).unwrap_err();
        assert!(e.contains("every n-th"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ramps_and_names() {
        assert_eq!(ramp(0.0), [48, 18, 59]);
        assert_eq!(ramp(1.0), [255, 250, 220]);
        assert_eq!(safe_name(" my pile #1 ", "x"), "my_pile__1");
        assert_eq!(safe_name("..", "x"), "x");
        assert_eq!(number_label(0.5), "0.5");
        assert_eq!(number_label(2.0), "2");
    }
}

// ---------------------------------------------------------------------------
// the panel's commands (progress on "octree-progress", like the other dataset passes)

#[cfg(feature = "gui")]
async fn blocking<T: Send + 'static>(
    window: tauri::Window,
    stage: &'static str,
    f: impl FnOnce(ProgressSink) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let progress = crate::progress::Progress::window(window, "octree-progress");
    crate::rt::spawn_blocking(move || f(&|p| super::emit_progress(&progress, stage, p))).await.map_err(|e| format!("join error: {e}"))?
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn survey_contours(window: tauri::Window, params: ContourParams) -> Result<ContourResult, String> {
    blocking(window, "contours", move |pr| run_contours(&params, pr)).await
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn survey_volume(window: tauri::Window, params: VolumeParams) -> Result<VolumeResult, String> {
    blocking(window, "volume", move |pr| run_volume(&params, pr)).await
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn survey_voxel_change(window: tauri::Window, params: VoxelChangeParams) -> Result<VoxelChangeResult, String> {
    blocking(window, "voxel_change", move |pr| run_voxel_change(&params, pr)).await
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn survey_ortho(window: tauri::Window, params: OrthoParams) -> Result<OrthoResult, String> {
    blocking(window, "ortho", move |pr| run_ortho(&params, pr)).await
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn survey_save_geometry(params: GeometryParams) -> Result<GeometryResult, String> {
    crate::rt::spawn_blocking(move || save_geometry(&params)).await.map_err(|e| format!("join error: {e}"))?
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn survey_profile(window: tauri::Window, params: ProfileParams) -> Result<ProfileResult, String> {
    blocking(window, "profile", move |pr| run_profile(&params, pr)).await
}
