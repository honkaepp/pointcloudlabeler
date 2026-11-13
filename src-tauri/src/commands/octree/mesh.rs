// Triangle meshes from a dataset, the two kinds a survey asks for:
//
// * 2.5D: a height field — the highest, lowest, ground or mean point of every grid cell
//   inside an area, two triangles per square of cells (terrain, a pile, a roof);
// * 3D: a closed isosurface around the voxels the points occupy (naive surface nets over the
//   blurred occupancy) — stumps, rocks, stem sections, objects of any shape. It encloses the
//   points: the surface lies up to about one voxel outside them.
//
// Then optionally smoothed (Taubin λ|μ, which does not shrink the mesh; the edge of an open
// mesh stays put) and decimated (vertex clustering), and written as PLY (binary, double
// precision — the viewer reads this one), OBJ (text, world coordinates), STL (binary float,
// relative to the origin named in its header) and DXF (3DFACE).

use std::collections::HashSet;
use std::io::Write;
use std::path::Path;

use rustc_hash::{FxHashMap, FxHashSet};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::survey::{class, for_each_point, frame, lossy, safe_name, surface_grid, voxel_key, Dxf};
use super::ProgressSink;

#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeshParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// "2.5d" (a height field over a grid) or "3d" (a closed surface around the points' voxels).
    #[serde(default = "d_method")]
    pub method: String,
    /// Grid cell (2.5D) or voxel (3D), metres (default 0.1).
    #[serde(default = "d_cell")]
    pub cell_size: f64,
    /// 2.5D: the height of a cell — "top", "lowest", "ground" (class 2) or "mean".
    #[serde(default = "d_top")]
    pub surface: String,
    /// The area: a polygon of world [x, y] vertices; empty = everything.
    #[serde(default)]
    pub polygon: Vec<[f64; 2]>,
    /// Only points of these classes (empty = all).
    #[serde(default)]
    pub classes: Vec<u8>,
    /// Only points between these heights, metres ([low, high]; empty = all).
    #[serde(default)]
    pub z_range: Option<[f64; 2]>,
    /// 2.5D: empty cells inside the area take the mean of their neighbours (default true).
    #[serde(default = "d_true")]
    pub fill_gaps: bool,
    /// 3D: points a voxel needs (default 1).
    #[serde(default = "d_one")]
    pub min_points: u32,
    /// Smoothing iterations (Taubin; 0 = none, default 0).
    #[serde(default)]
    pub smooth: u32,
    /// Decimation: vertices closer than this merge (vertex clustering), metres; 0 = none.
    #[serde(default)]
    pub decimate: f64,
    /// Files to write: any of "ply", "obj", "stl", "dxf" (PLY always, the viewer reads it).
    #[serde(default = "d_formats")]
    pub formats: Vec<String>,
    /// Name of the files in `mesh/` (default "mesh").
    #[serde(default = "d_name")]
    pub out_name: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MeshResult {
    pub vertices: usize,
    pub triangles: usize,
    /// Total triangle area, square metres.
    pub area_m2: f64,
    /// Enclosed volume of a closed (3D) mesh, cubic metres.
    pub volume_m3: Option<f64>,
    pub min: [f64; 3],
    pub max: [f64; 3],
    /// The PLY the viewer shows.
    pub ply: String,
    pub files: Vec<String>,
}

/// An indexed triangle mesh in world coordinates.
#[derive(Debug, Clone, Default)]
pub struct Mesh {
    pub v: Vec<[f64; 3]>,
    pub t: Vec<[u32; 3]>,
}

impl Mesh {
    pub fn area(&self) -> f64 {
        self.t.iter().map(|t| tri_area(self.v[t[0] as usize], self.v[t[1] as usize], self.v[t[2] as usize])).sum()
    }

    /// Signed volume (divergence theorem); positive for an outward-facing closed mesh.
    pub fn volume(&self) -> f64 {
        let o = self.v.first().copied().unwrap_or([0.0; 3]);
        self.t
            .iter()
            .map(|t| {
                let [a, b, c] = t.map(|i| sub(self.v[i as usize], o));
                dot(a, cross(b, c)) / 6.0
            })
            .sum()
    }

    /// Every edge is shared by exactly two triangles.
    pub fn is_closed(&self) -> bool {
        let mut count: FxHashMap<(u32, u32), u32> = FxHashMap::default();
        for t in &self.t {
            for k in 0..3 {
                let (a, b) = (t[k], t[(k + 1) % 3]);
                *count.entry((a.min(b), a.max(b))).or_default() += 1;
            }
        }
        !count.is_empty() && count.values().all(|n| *n == 2)
    }

    pub fn bounds(&self) -> ([f64; 3], [f64; 3]) {
        self.v.iter().fold(([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]), |(lo, hi), p| {
            ([lo[0].min(p[0]), lo[1].min(p[1]), lo[2].min(p[2])], [hi[0].max(p[0]), hi[1].max(p[1]), hi[2].max(p[2])])
        })
    }
}

#[inline]
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
#[inline]
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
#[inline]
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn tri_area(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    let n = cross(sub(b, a), sub(c, a));
    dot(n, n).sqrt() / 2.0
}

// ---------------------------------------------------------------------------
// 2.5D

/// Two triangles per square of four cells with a height (split along the shorter diagonal),
/// one where only three have one.
pub fn height_field(z: &[f64], cols: usize, rows: usize, at: impl Fn(usize, usize) -> [f64; 2]) -> Mesh {
    let mut index = vec![u32::MAX; z.len()];
    let mut m = Mesh::default();
    for r in 0..rows {
        for c in 0..cols {
            let i = r * cols + c;
            if z[i].is_finite() {
                index[i] = m.v.len() as u32;
                let q = at(c, r);
                m.v.push([q[0], q[1], z[i]]);
            }
        }
    }
    for r in 0..rows.saturating_sub(1) {
        for c in 0..cols.saturating_sub(1) {
            // counter-clockwise seen from above: a (c, r), b (c+1, r), d (c+1, r+1), e (c, r+1)
            let [a, b, d, e] = [r * cols + c, r * cols + c + 1, (r + 1) * cols + c + 1, (r + 1) * cols + c].map(|k| index[k]);
            let have = [a, b, d, e].map(|k| k != u32::MAX);
            match have.iter().filter(|h| **h).count() {
                4 => {
                    let diag_ad = (m.v[a as usize][2] - m.v[d as usize][2]).abs();
                    let diag_be = (m.v[b as usize][2] - m.v[e as usize][2]).abs();
                    if diag_ad <= diag_be {
                        m.t.push([a, b, d]);
                        m.t.push([a, d, e]);
                    } else {
                        m.t.push([a, b, e]);
                        m.t.push([b, d, e]);
                    }
                }
                3 => {
                    let tri: Vec<u32> = [a, b, d, e].into_iter().filter(|k| *k != u32::MAX).collect();
                    m.t.push([tri[0], tri[1], tri[2]]);
                }
                _ => {}
            }
        }
    }
    m
}

// ---------------------------------------------------------------------------
// 3D: naive surface nets over the blurred voxel occupancy

const ISO: f64 = 0.15;

fn unpack(k: u64) -> [i64; 3] {
    [(k >> 42) as i64, ((k >> 21) & 0x1f_ffff) as i64, (k & 0x1f_ffff) as i64]
}

fn pack(i: [i64; 3]) -> Option<u64> {
    let ok = |v: i64| (0..(1i64 << 21)).contains(&v);
    (ok(i[0]) && ok(i[1]) && ok(i[2])).then(|| ((i[0] as u64) << 42) | ((i[1] as u64) << 21) | i[2] as u64)
}

/// A closed surface around the occupied voxels (keys of `voxel_key` around `origin`).
pub fn surface_nets(occupied: &FxHashSet<u64>, origin: [f64; 3], size: f64) -> Mesh {
    // the field: the share of a voxel's 27-neighbourhood that is occupied
    let mut field: FxHashMap<u64, f64> = FxHashMap::default();
    let value = |k: u64, field: &mut FxHashMap<u64, f64>| -> f64 {
        if let Some(v) = field.get(&k) {
            return *v;
        }
        let i = unpack(k);
        let mut n = 0;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if pack([i[0] + dx, i[1] + dy, i[2] + dz]).is_some_and(|q| occupied.contains(&q)) {
                        n += 1;
                    }
                }
            }
        }
        let v = n as f64 / 27.0;
        field.insert(k, v);
        v
    };
    // cells (by their lowest corner) that may cross the surface
    let mut cells: FxHashSet<u64> = FxHashSet::default();
    for &k in occupied {
        let i = unpack(k);
        for dx in -2..=1 {
            for dy in -2..=1 {
                for dz in -2..=1 {
                    if let Some(c) = pack([i[0] + dx, i[1] + dy, i[2] + dz]) {
                        cells.insert(c);
                    }
                }
            }
        }
    }
    let corner = |i: [i64; 3], c: usize| [i[0] + (c & 1) as i64, i[1] + ((c >> 1) & 1) as i64, i[2] + ((c >> 2) & 1) as i64];
    const EDGES: [(usize, usize); 12] = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)];
    let mut m = Mesh::default();
    let mut vid: FxHashMap<u64, u32> = FxHashMap::default();
    let mut sorted: Vec<u64> = cells.into_iter().collect();
    sorted.sort_unstable();
    for &ck in &sorted {
        let i = unpack(ck);
        let mut f = [0.0; 8];
        for (c, fc) in f.iter_mut().enumerate() {
            *fc = pack(corner(i, c)).map_or(0.0, |k| value(k, &mut field));
        }
        let inside = f.iter().filter(|v| **v > ISO).count();
        if inside == 0 || inside == 8 {
            continue;
        }
        let mut sum = [0.0; 3];
        let mut n = 0.0;
        for (a, b) in EDGES {
            if (f[a] > ISO) != (f[b] > ISO) {
                let t = (ISO - f[a]) / (f[b] - f[a]);
                let (pa, pb) = (corner(i, a), corner(i, b));
                for d in 0..3 {
                    sum[d] += pa[d] as f64 + t * (pb[d] - pa[d]) as f64;
                }
                n += 1.0;
            }
        }
        // voxel indices to world: index k is the centre of voxel k (bias as in voxel_key)
        let bias = (1i64 << 20) as f64;
        let p = [0, 1, 2].map(|d| origin[d] + (sum[d] / n - bias + 0.5) * size);
        vid.insert(ck, m.v.len() as u32);
        m.v.push(p);
    }
    // a quad across every grid edge whose ends differ, from the four cells around it
    for &ck in &sorted {
        let i = unpack(ck);
        let f0 = pack(i).map_or(0.0, |k| value(k, &mut field));
        for axis in 0..3 {
            let mut j = i;
            j[axis] += 1;
            let f1 = pack(j).map_or(0.0, |k| value(k, &mut field));
            if (f0 > ISO) == (f1 > ISO) {
                continue;
            }
            let (u, w) = ((axis + 1) % 3, (axis + 2) % 3);
            let cell = |a: i64, b: i64| {
                let mut q = i;
                q[u] -= a;
                q[w] -= b;
                pack(q).and_then(|k| vid.get(&k).copied())
            };
            let (Some(c00), Some(c10), Some(c11), Some(c01)) = (cell(0, 0), cell(1, 0), cell(1, 1), cell(0, 1)) else { continue };
            // the loop c00 → c10 → c11 → c01 faces +axis: right when the inside is below
            if f0 > ISO {
                m.t.push([c00, c10, c11]);
                m.t.push([c00, c11, c01]);
            } else {
                m.t.push([c00, c11, c10]);
                m.t.push([c00, c01, c11]);
            }
        }
    }
    m
}

// ---------------------------------------------------------------------------
// smoothing and decimation

/// Taubin smoothing (λ = 0.5, μ = −0.53): Laplacian steps that keep the volume. Vertices on
/// the edge of an open mesh stay put.
pub fn taubin(m: &mut Mesh, iterations: u32) {
    if iterations == 0 || m.v.is_empty() {
        return;
    }
    let mut nb: Vec<Vec<u32>> = vec![Vec::new(); m.v.len()];
    let mut edges: FxHashMap<(u32, u32), u32> = FxHashMap::default();
    for t in &m.t {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            *edges.entry((a.min(b), a.max(b))).or_default() += 1;
        }
    }
    let mut border = vec![false; m.v.len()];
    for (&(a, b), &n) in &edges {
        nb[a as usize].push(b);
        nb[b as usize].push(a);
        if n == 1 {
            border[a as usize] = true;
            border[b as usize] = true;
        }
    }
    for _ in 0..iterations {
        for factor in [0.5, -0.53] {
            let prev = m.v.clone();
            for (i, p) in m.v.iter_mut().enumerate() {
                if border[i] || nb[i].is_empty() {
                    continue;
                }
                let mut c = [0.0; 3];
                for &j in &nb[i] {
                    for d in 0..3 {
                        c[d] += prev[j as usize][d];
                    }
                }
                let k = nb[i].len() as f64;
                for d in 0..3 {
                    p[d] += factor * (c[d] / k - prev[i][d]);
                }
            }
        }
    }
}

/// Vertex clustering: vertices in one `cell`-sized cube become their mean; triangles that
/// collapse or repeat are dropped.
pub fn decimate(m: &Mesh, cell: f64) -> Mesh {
    if cell <= 0.0 || m.v.is_empty() {
        return m.clone();
    }
    let key = |p: [f64; 3]| [(p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64, (p[2] / cell).floor() as i64];
    let mut slot: FxHashMap<[i64; 3], u32> = FxHashMap::default();
    let mut sums: Vec<([f64; 3], f64)> = Vec::new();
    let remap: Vec<u32> = m
        .v
        .iter()
        .map(|p| {
            let k = key(*p);
            let s = *slot.entry(k).or_insert_with(|| {
                sums.push(([0.0; 3], 0.0));
                (sums.len() - 1) as u32
            });
            let e = &mut sums[s as usize];
            for d in 0..3 {
                e.0[d] += p[d];
            }
            e.1 += 1.0;
            s
        })
        .collect();
    let v: Vec<[f64; 3]> = sums.iter().map(|(s, n)| [s[0] / n, s[1] / n, s[2] / n]).collect();
    let mut seen: HashSet<[u32; 3]> = HashSet::new();
    let mut t = Vec::new();
    for tri in &m.t {
        let r = tri.map(|i| remap[i as usize]);
        if r[0] == r[1] || r[1] == r[2] || r[0] == r[2] {
            continue;
        }
        let mut s = r;
        s.sort_unstable();
        if seen.insert(s) {
            t.push(r);
        }
    }
    Mesh { v, t }
}

// ---------------------------------------------------------------------------
// files

pub fn write_ply(path: &Path, m: &Mesh) -> Result<(), String> {
    let f = std::fs::File::create(path).map_err(|e| format!("create {}: {e}", path.display()))?;
    let mut w = std::io::BufWriter::new(f);
    let io = |e: std::io::Error| format!("write {}: {e}", path.display());
    write!(
        w,
        "ply\nformat binary_little_endian 1.0\ncomment PointCloudLabeler mesh\nelement vertex {}\nproperty double x\nproperty double y\nproperty double z\nelement face {}\nproperty list uchar int vertex_indices\nend_header\n",
        m.v.len(),
        m.t.len()
    )
    .map_err(io)?;
    for p in &m.v {
        for c in p {
            w.write_all(&c.to_le_bytes()).map_err(io)?;
        }
    }
    for t in &m.t {
        w.write_all(&[3u8]).map_err(io)?;
        for i in t {
            w.write_all(&(*i as i32).to_le_bytes()).map_err(io)?;
        }
    }
    w.flush().map_err(io)
}

pub fn write_obj(path: &Path, m: &Mesh) -> Result<(), String> {
    let f = std::fs::File::create(path).map_err(|e| format!("create {}: {e}", path.display()))?;
    let mut w = std::io::BufWriter::new(f);
    let io = |e: std::io::Error| format!("write {}: {e}", path.display());
    writeln!(w, "# PointCloudLabeler mesh: {} vertices, {} triangles", m.v.len(), m.t.len()).map_err(io)?;
    for p in &m.v {
        writeln!(w, "v {:.4} {:.4} {:.4}", p[0], p[1], p[2]).map_err(io)?;
    }
    for t in &m.t {
        writeln!(w, "f {} {} {}", t[0] + 1, t[1] + 1, t[2] + 1).map_err(io)?;
    }
    w.flush().map_err(io)
}

/// Binary STL: 32-bit floats, so the coordinates are relative to `origin` (named in the
/// 80-byte header).
pub fn write_stl(path: &Path, m: &Mesh, origin: [f64; 3]) -> Result<(), String> {
    let f = std::fs::File::create(path).map_err(|e| format!("create {}: {e}", path.display()))?;
    let mut w = std::io::BufWriter::new(f);
    let io = |e: std::io::Error| format!("write {}: {e}", path.display());
    let mut header = format!("PointCloudLabeler mesh; origin {:.3} {:.3} {:.3}", origin[0], origin[1], origin[2]).into_bytes();
    header.resize(80, b' ');
    w.write_all(&header).map_err(io)?;
    w.write_all(&(m.t.len() as u32).to_le_bytes()).map_err(io)?;
    for t in &m.t {
        let [a, b, c] = t.map(|i| sub(m.v[i as usize], origin));
        let n = cross(sub(b, a), sub(c, a));
        let l = dot(n, n).sqrt().max(1e-30);
        for x in [n[0] / l, n[1] / l, n[2] / l] {
            w.write_all(&(x as f32).to_le_bytes()).map_err(io)?;
        }
        for p in [a, b, c] {
            for x in p {
                w.write_all(&(x as f32).to_le_bytes()).map_err(io)?;
            }
        }
        w.write_all(&[0u8, 0u8]).map_err(io)?;
    }
    w.flush().map_err(io)
}

pub fn write_dxf_faces(path: &Path, m: &Mesh) -> Result<(), String> {
    use std::fmt::Write as _;
    let mut d = Dxf::new();
    d.layer("MESH", 7);
    let mut s = String::new();
    for t in &m.t {
        let [a, b, c] = t.map(|i| m.v[i as usize]);
        let _ = write!(s, "0\n3DFACE\n8\nMESH\n");
        for (k, p) in [a, b, c, c].iter().enumerate() {
            let _ = write!(s, "1{k}\n{:.4}\n2{k}\n{:.4}\n3{k}\n{:.4}\n", p[0], p[1], p[2]);
        }
    }
    d.raw(&s);
    d.write(path)
}

// ---------------------------------------------------------------------------

pub fn run_mesh(p: &MeshParams, progress: ProgressSink) -> Result<MeshResult, String> {
    let dir = Path::new(&p.octree_dir);
    let fr = frame(dir)?;
    let cell = p.cell_size.max(0.005);
    let mut mesh = match p.method.to_ascii_lowercase().replace(['-', '_', ' '], "").as_str() {
        "2.5d" | "25d" | "grid" | "heightfield" => {
            let g = surface_grid(dir, &fr, &p.polygon, &p.surface, &p.classes, cell, p.fill_gaps, p.z_range, "mesh", progress, (0.0, 0.7))?;
            let z: Vec<f64> = g.z.iter().zip(&g.inside).map(|(z, i)| if *i { *z } else { f64::NAN }).collect();
            height_field(&z, g.cols, g.rows, |c, r| g.centre(c, r))
        }
        "3d" | "surface" => {
            if !p.polygon.is_empty() && p.polygon.len() < 3 {
                return Err("the area needs at least three vertices".into());
            }
            let origin = fr.min;
            let mut counts: FxHashMap<u64, u32> = FxHashMap::default();
            for_each_point(dir, &fr, "mesh", progress, 0.0, 0.6, |_, q, r| {
                if !p.classes.is_empty() && !p.classes.contains(&class(r)) {
                    return;
                }
                if let Some([lo, hi]) = p.z_range {
                    if q[2] < lo || q[2] > hi {
                        return;
                    }
                }
                if p.polygon.len() >= 3 && !super::survey::point_in_polygon(&p.polygon, q[0], q[1]) {
                    return;
                }
                if let Some(k) = voxel_key(q, origin, cell) {
                    *counts.entry(k).or_default() += 1;
                }
            })?;
            let occupied: FxHashSet<u64> = counts.iter().filter(|(_, n)| **n >= p.min_points.max(1)).map(|(k, _)| *k).collect();
            if occupied.is_empty() {
                return Err("no points to mesh".into());
            }
            if occupied.len() > 30_000_000 {
                return Err(format!("{} voxels: use a larger voxel or a smaller area", occupied.len()));
            }
            surface_nets(&occupied, origin, cell)
        }
        other => return Err(format!("unknown method {other:?} (2.5d, 3d)")),
    };
    progress(0.75);
    taubin(&mut mesh, p.smooth.min(100));
    if p.decimate > 0.0 {
        mesh = decimate(&mesh, p.decimate);
    }
    if mesh.t.is_empty() {
        return Err("the mesh has no triangles (too few points, or too large a cell)".into());
    }
    progress(0.85);
    let mdir = dir.join("mesh");
    std::fs::create_dir_all(&mdir).map_err(|e| format!("create {}: {e}", mdir.display()))?;
    let name = safe_name(&p.out_name, "mesh");
    let (lo, hi) = mesh.bounds();
    let ply = mdir.join(format!("{name}.ply"));
    write_ply(&ply, &mesh)?;
    let mut files = vec![lossy(&ply)];
    for f in &p.formats {
        match f.to_ascii_lowercase().as_str() {
            "ply" => {}
            "obj" => {
                let path = mdir.join(format!("{name}.obj"));
                write_obj(&path, &mesh)?;
                files.push(lossy(&path));
            }
            "stl" => {
                let path = mdir.join(format!("{name}.stl"));
                write_stl(&path, &mesh, lo.map(|v| v.floor()))?;
                files.push(lossy(&path));
            }
            "dxf" => {
                let path = mdir.join(format!("{name}.dxf"));
                write_dxf_faces(&path, &mesh)?;
                files.push(lossy(&path));
            }
            other => return Err(format!("unknown mesh format {other:?} (ply, obj, stl, dxf)")),
        }
    }
    progress(1.0);
    let closed = mesh.is_closed();
    Ok(MeshResult {
        vertices: mesh.v.len(),
        triangles: mesh.t.len(),
        area_m2: mesh.area(),
        volume_m3: closed.then(|| mesh.volume().abs()),
        min: lo,
        max: hi,
        ply: lossy(&ply),
        files,
    })
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn survey_mesh(window: tauri::Window, params: MeshParams) -> Result<MeshResult, String> {
    let progress = crate::progress::Progress::window(window, "octree-progress");
    crate::rt::spawn_blocking(move || run_mesh(&params, &|f| super::emit_progress(&progress, "mesh", f)))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn d_method() -> String {
    "2.5d".into()
}
fn d_cell() -> f64 {
    0.1
}
fn d_top() -> String {
    "top".into()
}
fn d_true() -> bool {
    true
}
fn d_one() -> u32 {
    1
}
fn d_formats() -> Vec<String> {
    vec!["ply".into(), "obj".into()]
}
fn d_name() -> String {
    "mesh".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_height_field_triangulates_its_cells() {
        let (cols, rows) = (4, 3);
        let mut z: Vec<f64> = (0..cols * rows).map(|i| (i % cols) as f64 * 0.1).collect();
        let m = height_field(&z, cols, rows, |c, r| [c as f64, r as f64]);
        assert_eq!((m.v.len(), m.t.len()), (12, 12));
        // a tilted plane 3 × 2 m: its area is the plane's
        assert!((m.area() - 6.0 * (1.0f64 + 0.01).sqrt()).abs() < 1e-9);
        // facing up
        let t = m.t[0];
        let n = cross(sub(m.v[t[1] as usize], m.v[t[0] as usize]), sub(m.v[t[2] as usize], m.v[t[0] as usize]));
        assert!(n[2] > 0.0);
        // a hole: the squares around it lose triangles, a corner keeps one
        z[5] = f64::NAN;
        let holed = height_field(&z, cols, rows, |c, r| [c as f64, r as f64]);
        assert_eq!(holed.v.len(), 11);
        assert_eq!(holed.t.len(), 12 - 8 + 4);
        assert!(!holed.is_closed());
    }

    /// The voxels inside a sphere of `radius` voxels.
    fn ball(radius: i64) -> (FxHashSet<u64>, [f64; 3]) {
        let origin = [100.0, 200.0, 50.0];
        let mut s = FxHashSet::default();
        for x in -radius..=radius {
            for y in -radius..=radius {
                for z in -radius..=radius {
                    if x * x + y * y + z * z <= radius * radius {
                        let q = [origin[0] + x as f64 * 0.1 + 0.05, origin[1] + y as f64 * 0.1 + 0.05, origin[2] + z as f64 * 0.1 + 0.05];
                        s.insert(voxel_key(q, origin, 0.1).unwrap());
                    }
                }
            }
        }
        (s, origin)
    }

    #[test]
    fn surface_nets_close_around_a_ball_facing_out() {
        let (occ, origin) = ball(8);
        let m = surface_nets(&occ, origin, 0.1);
        assert!(m.is_closed(), "watertight");
        // outward: a positive signed volume, near the ball's (r = 0.85 m: one voxel outside)
        let v = m.volume();
        let r = 0.8 + 0.05;
        assert!(v > 0.0);
        let want = 4.0 / 3.0 * std::f64::consts::PI * r * r * r;
        assert!((v - want).abs() / want < 0.2, "{v} vs {want}");
        // centred on the ball's centre
        let (lo, hi) = m.bounds();
        for d in 0..3 {
            assert!(((lo[d] + hi[d]) / 2.0 - (origin[d] + 0.05)).abs() < 0.06, "{lo:?} {hi:?}");
        }
        // smoothing keeps it closed and about as large; decimation keeps it a surface
        let mut s = m.clone();
        taubin(&mut s, 10);
        assert!((s.volume() - v).abs() / v < 0.05);
        let d = decimate(&s, 0.25);
        assert!(d.t.len() < s.t.len() / 3 && d.volume() > 0.5 * v);
    }

    #[test]
    fn meshes_of_a_dataset_end_to_end() {
        let dir = super::super::survey::tests::dataset("mesh", true);
        let d = dir.to_string_lossy().into_owned();
        let quiet = |_: f32| {};
        let base = MeshParams {
            octree_dir: d.clone(), method: "2.5d".into(), cell_size: 0.2, surface: "top".into(),
            polygon: vec![[6.0, 6.0], [14.0, 6.0], [14.0, 14.0], [6.0, 14.0]], classes: vec![], z_range: None, fill_gaps: true,
            min_points: 1, smooth: 0, decimate: 0.0, formats: vec!["obj".into(), "stl".into()], out_name: "pile".into(),
        };
        let r = run_mesh(&base, &quiet).unwrap();
        // 8 × 8 m at 0.2 m: 40 × 40 cells, 39 × 39 squares of two triangles
        assert_eq!((r.vertices, r.triangles), (1600, 2 * 39 * 39));
        assert!(r.volume_m3.is_none(), "an open height field has no volume");
        assert!(r.area_m2 > 7.8 * 7.8 && r.area_m2 < 7.8 * 7.8 * 1.2, "{}", r.area_m2);
        assert!((r.max[2] - (1.0 + 1.5)).abs() < 0.05, "the top of the pile: {:?}", r.max);
        assert_eq!(r.files.len(), 3);
        assert!(r.files.iter().all(|f| Path::new(f).is_file()));
        // decimated: fewer triangles, the same extent
        let dec = run_mesh(&MeshParams { decimate: 0.6, out_name: "pile_dec".into(), formats: vec![], ..base.clone() }, &quiet).unwrap();
        assert!(dec.triangles < r.triangles / 4, "{}", dec.triangles);
        assert!((dec.max[2] - r.max[2]).abs() < 0.3);
        // 3D around the pile's points only: closed, with a volume
        let solid = run_mesh(&MeshParams { method: "3d".into(), classes: vec![1], cell_size: 0.2, smooth: 3, formats: vec![], out_name: "pile3d".into(), ..base.clone() }, &quiet).unwrap();
        assert!(solid.volume_m3.is_some_and(|v| v > 1.0), "{solid:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_round_trip_their_counts() {
        let (occ, origin) = ball(3);
        let m = surface_nets(&occ, origin, 0.1);
        let dir = std::env::temp_dir().join(format!("tp_mesh_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_ply(&dir.join("m.ply"), &m).unwrap();
        write_obj(&dir.join("m.obj"), &m).unwrap();
        write_stl(&dir.join("m.stl"), &m, [100.0, 200.0, 50.0]).unwrap();
        write_dxf_faces(&dir.join("m.dxf"), &m).unwrap();
        let ply = std::fs::read(dir.join("m.ply")).unwrap();
        let head = String::from_utf8_lossy(&ply[..ply.windows(10).position(|w| w == b"end_header").unwrap()]).to_string();
        assert!(head.contains(&format!("element vertex {}", m.v.len())) && head.contains(&format!("element face {}", m.t.len())));
        let body = ply.len() - head.len() - "end_header\n".len();
        assert_eq!(body, m.v.len() * 24 + m.t.len() * 13);
        let obj = std::fs::read_to_string(dir.join("m.obj")).unwrap();
        assert_eq!(obj.lines().filter(|l| l.starts_with("v ")).count(), m.v.len());
        let stl = std::fs::read(dir.join("m.stl")).unwrap();
        assert_eq!(stl.len(), 84 + 50 * m.t.len());
        assert!(String::from_utf8_lossy(&stl[..80]).contains("origin 100.000 200.000 50.000"));
        let dxf = std::fs::read_to_string(dir.join("m.dxf")).unwrap();
        assert_eq!(dxf.matches("3DFACE").count(), m.t.len());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
