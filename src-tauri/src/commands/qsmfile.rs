//! Quantitative structure models to files and meshes, and back.
//!
//! * The open `.qsm` format (one tree per file: an ASCII header ending in
//!   `DATA binary`, then little-endian nodes and edges; the edge FORMAT 2
//!   record carries source, target, radius, quality, axis, branch order,
//!   subtree length and distance to the root) and its `.qsf` manifest of a
//!   forest's files — so a model from here opens in other QSM software
//!   (Arbor's among them) and theirs opens here. The specification does not
//!   say whether node indices count from 0 or 1; Arbor, the format's
//!   author, writes them from 1 (its R heritage), so they are written from
//!   1 here and read from either.
//! * A tree's model as a rooted graph (`graph_of`): the stem from its
//!   slices, every branch cylinder an edge, a branch's first cylinder tied
//!   to the nearest node of what it grows from. Quality runs low → high
//!   with confidence: 1 a gap bridge, 2 a radius the corrections moved, 3
//!   fitted to points seen from one side, 4 fitted to points seen round;
//!   0 a connector the format needs and nothing measured.
//! * Tube meshes: one continuous tube per axis (rings carried along it by
//!   parallel transport, so they do not twist), coloured by quality — OBJ
//!   with one object per tree (Blender keeps them apart; the coordinates
//!   are shifted near the origin, where Blender's single precision holds,
//!   and the shift is written beside), binary PLY in world coordinates
//!   with the colours (what the viewer's mesh layers draw).

use std::io::{BufRead, Read, Write};
use std::path::Path;

use crate::commands::octree::{cylinder_quality, TreeQsm};

#[derive(Clone, Debug, PartialEq)]
pub struct QsmEdge {
    pub source: u32,
    pub target: u32,
    pub radius: f32,
    pub quality: u8,
    pub axis: u32,
    pub order: u8,
    pub subtree_length: f32,
    pub distance_to_root: f32,
}

/// A tree's model as a rooted graph: node 0 is the root, every other node
/// has exactly one incoming edge.
#[derive(Clone, Debug, Default)]
pub struct QsmGraph {
    pub tree_id: i32,
    pub name: String,
    pub nodes: Vec<[f64; 3]>,
    pub edges: Vec<QsmEdge>,
    pub messages: Vec<String>,
}

fn dist(a: [f64; 3], b: [f64; 3]) -> f64 { ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt() }

impl QsmGraph {
    /// Lengths along the tree: each edge's distance from the root (at its
    /// source) and the length of everything from it outward.
    pub fn measure(&mut self) {
        let n = self.nodes.len();
        let mut out: Vec<Vec<usize>> = vec![Vec::new(); n];
        for (k, e) in self.edges.iter().enumerate() { out[e.source as usize].push(k); }
        let mut depth = vec![0.0f64; n];
        let mut order: Vec<usize> = Vec::with_capacity(self.edges.len());
        let mut stack = vec![0usize];
        while let Some(u) = stack.pop() {
            for &k in &out[u] {
                let e = &self.edges[k];
                depth[e.target as usize] = depth[u] + dist(self.nodes[u], self.nodes[e.target as usize]);
                order.push(k);
                stack.push(e.target as usize);
            }
        }
        let mut below = vec![0.0f64; n];
        for &k in order.iter().rev() {
            let (s, t) = (self.edges[k].source as usize, self.edges[k].target as usize);
            let len = dist(self.nodes[s], self.nodes[t]);
            self.edges[k].subtree_length = (len + below[t]) as f32;
            below[s] += len + below[t];
            self.edges[k].distance_to_root = depth[s] as f32;
        }
    }

    pub fn bbox(&self) -> ([f64; 3], [f64; 3]) {
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for p in &self.nodes { for a in 0..3 { lo[a] = lo[a].min(p[a]); hi[a] = hi[a].max(p[a]); } }
        (lo, hi)
    }
}

/// The rooted graph of a fitted tree. In TreeQSM mode the trunk rides in
/// `branches` (order 0) and is taken from there; otherwise from the slices.
pub fn graph_of(t: &TreeQsm) -> QsmGraph {
    let mut g = QsmGraph { tree_id: t.tree_id, name: format!("tree {}", t.tree_id), ..QsmGraph::default() };
    let trunk_cyls = t.branches.iter().any(|b| b.branch_order == 0);
    let mut slices: Vec<_> = if trunk_cyls { Vec::new() } else {
        t.slices.iter().filter(|s| s.radius.is_finite() && s.radius > 0.0).collect()
    };
    slices.sort_by(|a, b| a.z.partial_cmp(&b.z).unwrap_or(std::cmp::Ordering::Equal));
    // the stem: the ground under its lowest slice, then slice by slice
    let root = match slices.first() {
        Some(s) => [s.center_x, s.center_y, t.base_z.min(s.z)],
        None => match t.branches.iter().filter(|b| b.branch_order == 0).min_by(|a, b| a.start[2].partial_cmp(&b.start[2]).unwrap_or(std::cmp::Ordering::Equal)) {
            Some(b) => b.start,
            None => [t.base_x, t.base_y, t.base_z],
        },
    };
    g.nodes.push(root);
    let mut prev = 0u32;
    let mut stem_nodes: Vec<u32> = vec![0];
    for (k, s) in slices.iter().enumerate() {
        let p = [s.center_x, s.center_y, s.z];
        if dist(p, g.nodes[prev as usize]) < 1e-6 { continue; }
        g.nodes.push(p);
        let id = (g.nodes.len() - 1) as u32;
        let r = if k == 0 { s.radius } else { 0.5 * (s.radius + slices[k - 1].radius) };
        g.edges.push(QsmEdge {
            source: prev, target: id, radius: r as f32, quality: if s.coverage >= 0.5 { 4 } else { 3 },
            axis: 1, order: 1, subtree_length: 0.0, distance_to_root: 0.0,
        });
        stem_nodes.push(id);
        prev = id;
    }
    // the branches, parents first. A cylinder continues from the end of the
    // one before it in its segment (TreeQSM's parent_cylinder): fitted one
    // by one they leave gaps of centimetres (3 cm median on plot 1041), and
    // a tube should not break at every joint. A segment's first cylinder
    // is tied to the nearest node it can grow from.
    let mut idx: Vec<usize> = (0..t.branches.len()).collect();
    idx.sort_by_key(|&i| { let b = &t.branches[i]; (b.branch_order, b.segment_id, b.position_in_branch) });
    let mut end_of: Vec<Option<u32>> = vec![None; t.branches.len()];
    for &i in &idx {
        let b = &t.branches[i];
        let q = t.cylinder_quality.get(i).copied().unwrap_or_else(|| cylinder_quality(b));
        // the trunk is axis 1, order 1; a branch of order k is order k + 1
        let (axis, order) = if b.branch_order == 0 { (1, 1) } else { (b.segment_id + 2, b.branch_order.saturating_add(1)) };
        let s = match b.parent_cylinder.and_then(|p| end_of.get(p as usize).copied().flatten()) {
            Some(n) => n,
            None => {
                let mut best = (0u32, f64::INFINITY);
                for (m, p) in g.nodes.iter().enumerate() {
                    let d = dist(*p, b.start);
                    if d < best.1 { best = (m as u32, d); }
                }
                if best.1 < 1e-3 { best.0 } else {
                    g.nodes.push(b.start);
                    let n = (g.nodes.len() - 1) as u32;
                    g.edges.push(QsmEdge {
                        source: best.0, target: n, radius: b.radius as f32, quality: 0, axis, order,
                        subtree_length: 0.0, distance_to_root: 0.0,
                    });
                    n
                }
            }
        };
        g.nodes.push(b.end);
        let e = (g.nodes.len() - 1) as u32;
        g.edges.push(QsmEdge {
            source: s, target: e, radius: b.radius as f32, quality: q, axis, order, subtree_length: 0.0, distance_to_root: 0.0,
        });
        end_of[i] = Some(e);
    }
    let _ = stem_nodes;
    for n in &t.notes { g.messages.push(format!("[{}] {}", n.code, n.text)); }
    g.measure();
    g
}

// ---------------------------------------------------------------- .qsm

fn put_f32(w: &mut Vec<u8>, v: f32) { w.extend_from_slice(&v.to_le_bytes()); }

/// Write one tree, FORMAT 2, the root as the offset.
pub fn write_qsm(path: &Path, g: &QsmGraph, crs_wkt: Option<&str>) -> Result<(), String> {
    let off = g.nodes.first().copied().unwrap_or([0.0; 3]);
    let off = [off[0].round(), off[1].round(), off[2].round()];
    let (lo, hi) = g.bbox();
    let mut h = String::new();
    h.push_str("SIGNATURE QSMF\nVERSION 1.0\nFORMAT 2\n");
    h.push_str(&format!("NODES {}\nEDGES {}\n", g.nodes.len(), g.edges.len()));
    h.push_str(&format!("X_OFFSET {:.3}\nY_OFFSET {:.3}\nZ_OFFSET {:.3}\n", off[0], off[1], off[2]));
    h.push_str(&format!("XMIN {:.4}\nYMIN {:.4}\nZMIN {:.4}\nXMAX {:.4}\nYMAX {:.4}\nZMAX {:.4}\n", lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]));
    h.push_str(&format!("SOFTWARE PointCloudLabeler {}\n", env!("CARGO_PKG_VERSION")));
    if let Some(c) = crs_wkt { if !c.is_empty() { h.push_str(&format!("CRS {}\n", c.replace('\n', " "))); } }
    h.push_str(&format!("TREEID {}\nTREENAME {}\n", g.tree_id, g.name.replace('\n', " ")));
    for m in &g.messages { h.push_str(&format!("MESSAGE {}\n", m.replace('\n', "\\n"))); }
    h.push_str("DATA binary\n");
    let mut b: Vec<u8> = h.into_bytes();
    for p in &g.nodes { for a in 0..3 { put_f32(&mut b, (p[a] - off[a]) as f32); } }
    // node indices from 1, as Arbor writes and reads them
    for e in &g.edges {
        b.extend_from_slice(&(e.source + 1).to_le_bytes());
        b.extend_from_slice(&(e.target + 1).to_le_bytes());
        put_f32(&mut b, e.radius);
        b.push(e.quality);
        b.extend_from_slice(&e.axis.to_le_bytes());
        b.push(e.order);
        put_f32(&mut b, e.subtree_length);
        put_f32(&mut b, e.distance_to_root);
    }
    std::fs::write(path, b).map_err(|e| format!("write {}: {e}", path.display()))
}

fn extra_size(t: &str) -> Result<usize, String> {
    Ok(match t {
        "I8" | "U8" => 1, "I16" | "U16" => 2, "I32" | "U32" | "F32" => 4, "I64" | "U64" | "F64" => 8,
        _ => return Err(format!("unknown extra-bytes type {t}")),
    })
}

/// Read one tree, any FORMAT 0–3, extra bytes skipped.
pub fn read_qsm(path: &Path) -> Result<QsmGraph, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut rd = std::io::Cursor::new(&bytes);
    let mut g = QsmGraph::default();
    let (mut format, mut nodes, mut edges) = (0u8, 0usize, 0usize);
    let mut off = [0.0f64; 3];
    let (mut node_extra, mut edge_extra) = (0usize, 0usize);
    let mut signed = false;
    let mut line = String::new();
    loop {
        line.clear();
        if rd.read_line(&mut line).map_err(|e| e.to_string())? == 0 { return Err("no DATA line: not a .qsm file".into()); }
        let l = line.trim_end_matches(['\n', '\r']);
        if l.starts_with('#') || l.is_empty() { continue; }
        let (k, v) = l.split_once(' ').unwrap_or((l, ""));
        match k {
            "SIGNATURE" => { if v != "QSMF" { return Err("not a .qsm file (signature)".into()); } signed = true; }
            "FORMAT" => format = v.trim().parse().map_err(|_| "bad FORMAT")?,
            "NODES" => nodes = v.trim().parse().map_err(|_| "bad NODES")?,
            "EDGES" => edges = v.trim().parse().map_err(|_| "bad EDGES")?,
            "X_OFFSET" => off[0] = v.trim().parse().map_err(|_| "bad X_OFFSET")?,
            "Y_OFFSET" => off[1] = v.trim().parse().map_err(|_| "bad Y_OFFSET")?,
            "Z_OFFSET" => off[2] = v.trim().parse().map_err(|_| "bad Z_OFFSET")?,
            "TREEID" => g.tree_id = v.trim().parse().unwrap_or(0),
            "TREENAME" => g.name = v.to_string(),
            "MESSAGE" => g.messages.push(v.replace("\\n", "\n")),
            "NODE_EXTRABYTES" => node_extra += extra_size(v.split_whitespace().next().unwrap_or(""))?,
            "EDGE_EXTRABYTES" => edge_extra += extra_size(v.split_whitespace().next().unwrap_or(""))?,
            "DATA" => break,
            _ => {}
        }
    }
    if !signed { return Err("not a .qsm file (no signature)".into()); }
    let base = match format { 0 => 13, 1 => 18, 2 => 26, 3 => 28, f => return Err(format!("unknown edge FORMAT {f}")) };
    let start = rd.position() as usize;
    let need = start + nodes * (12 + node_extra) + edges * (base + edge_extra);
    if bytes.len() < need { return Err(format!("{}: truncated ({} of {need} bytes)", path.display(), bytes.len())); }
    let f32_at = |o: usize| f32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let u32_at = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
    let mut o = start;
    for _ in 0..nodes {
        g.nodes.push([f32_at(o) as f64 + off[0], f32_at(o + 4) as f64 + off[1], f32_at(o + 8) as f64 + off[2]]);
        o += 12 + node_extra;
    }
    for _ in 0..edges {
        let mut e = QsmEdge { source: u32_at(o), target: u32_at(o + 4), radius: f32_at(o + 8), quality: bytes[o + 12],
            axis: 0, order: 0, subtree_length: -1.0, distance_to_root: 0.0 };
        if format >= 1 { e.axis = u32_at(o + 13); e.order = bytes[o + 17]; }
        if format >= 2 { e.subtree_length = f32_at(o + 18); e.distance_to_root = f32_at(o + 22); }
        g.edges.push(e);
        o += base + edge_extra;
    }
    // indices from 0 or from 1: a file that names node 0 counts from 0, one
    // that names node `nodes` counts from 1
    let lo = g.edges.iter().map(|e| e.source.min(e.target)).min().unwrap_or(0);
    let hi = g.edges.iter().map(|e| e.source.max(e.target)).max().unwrap_or(0) as usize;
    let from_one = lo >= 1 && hi == nodes;
    if from_one { for e in &mut g.edges { e.source -= 1; e.target -= 1; } }
    if g.edges.iter().any(|e| e.source as usize >= nodes || e.target as usize >= nodes) {
        return Err(format!("{}: an edge names a node that is not there", path.display()));
    }
    // the root first, as this side's graphs have it
    if !g.edges.is_empty() {
        let mut has_parent = vec![false; nodes];
        for e in &g.edges { has_parent[e.target as usize] = true; }
        if let Some(r) = (0..nodes).find(|&i| !has_parent[i]) {
            if r != 0 {
                g.nodes.swap(0, r);
                let r = r as u32;
                for e in &mut g.edges {
                    for v in [&mut e.source, &mut e.target] { if *v == 0 { *v = r } else if *v == r { *v = 0 } }
                }
            }
        }
    }
    Ok(g)
}

// ---------------------------------------------------------------- .qsf

/// One line of a forest manifest.
#[derive(Clone, Debug, PartialEq)]
pub struct QsfEntry {
    pub path: String,
    pub id: i32,
    pub bbox: Option<([f64; 3], [f64; 3])>,
    pub name: String,
}

pub fn write_qsf(path: &Path, entries: &[QsfEntry], crs_wkt: Option<&str>) -> Result<(), String> {
    let mut s = String::from("SIGNATURE QSFM\nVERSION 1.0\nKIND VIRTUAL\n");
    s.push_str(&format!("SOFTWARE PointCloudLabeler {}\n", env!("CARGO_PKG_VERSION")));
    if let Some(c) = crs_wkt { if !c.is_empty() { s.push_str(&format!("CRS {}\n", c.replace('\n', " "))); } }
    s.push_str(&format!("COUNT {}\n", entries.len()));
    for e in entries {
        match e.bbox {
            Some((lo, hi)) => s.push_str(&format!("ENTRY {} {} 1 {:.4} {:.4} {:.4} {:.4} {:.4} {:.4} {}\n", e.path, e.id, lo[0], lo[1], lo[2], hi[0], hi[1], hi[2], e.name)),
            None => s.push_str(&format!("ENTRY {} {} 0 0 0 0 0 0 0 {}\n", e.path, e.id, e.name)),
        }
    }
    s.push_str("END\n");
    std::fs::write(path, s).map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn read_qsf(path: &Path) -> Result<Vec<QsfEntry>, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut out = Vec::new();
    let mut signed = false;
    for line in std::io::BufReader::new(f).lines() {
        let line = line.map_err(|e| e.to_string())?;
        let w: Vec<&str> = line.split_whitespace().collect();
        match w.first().copied() {
            Some("SIGNATURE") => signed = w.get(1) == Some(&"QSFM"),
            Some("ENTRY") if w.len() >= 4 => {
                let has = w[3] == "1";
                let num = |i: usize| w.get(i).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
                out.push(QsfEntry {
                    path: w[1].to_string(),
                    id: w[2].parse().unwrap_or(0),
                    bbox: if has { Some(([num(4), num(5), num(6)], [num(7), num(8), num(9)])) } else { None },
                    name: w.get(10..).map(|r| r.join(" ")).unwrap_or_default(),
                });
            }
            Some("END") => break,
            _ => {}
        }
    }
    if !signed { return Err("not a .qsf manifest (signature)".into()); }
    Ok(out)
}

// ---------------------------------------------------------------- meshes

/// A triangle mesh with a colour per vertex.
#[derive(Default, Clone)]
pub struct Mesh {
    pub v: Vec<[f64; 3]>,
    pub c: Vec<[u8; 3]>,
    pub f: Vec<[u32; 3]>,
}

/// The colour of a quality level.
pub fn quality_rgb(q: u8) -> [u8; 3] {
    match q {
        0 => [148, 163, 184],
        1 => [239, 68, 68],
        2 => [249, 115, 22],
        3 => [250, 204, 21],
        _ => [74, 222, 128],
    }
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn norm(a: [f64; 3]) -> [f64; 3] { let l = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt(); if l > 0.0 { [a[0] / l, a[1] / l, a[2] / l] } else { [0.0, 0.0, 1.0] } }
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }

/// The tree as tubes: one continuous tube per chain of edges along an
/// axis, `sides` around, rings carried by parallel transport.
pub fn tube_mesh(g: &QsmGraph, sides: usize) -> Mesh {
    let sides = sides.clamp(3, 64);
    let n = g.nodes.len();
    let mut out_edges: Vec<Vec<usize>> = vec![Vec::new(); n];
    for (k, e) in g.edges.iter().enumerate() { out_edges[e.source as usize].push(k); }
    let mut m = Mesh::default();
    let mut used = vec![false; g.edges.len()];
    for start in 0..g.edges.len() {
        if used[start] { continue; }
        // a chain starts at an edge whose source has no incoming edge of
        // the same axis
        let axis = g.edges[start].axis;
        let src = g.edges[start].source as usize;
        let continues = g.edges.iter().any(|e| e.target as usize == src && e.axis == axis);
        if continues { continue; }
        let mut chain = vec![start];
        used[start] = true;
        let mut tip = g.edges[start].target as usize;
        while let Some(&k) = out_edges[tip].iter().find(|&&k| !used[k] && g.edges[k].axis == axis) {
            used[k] = true;
            chain.push(k);
            tip = g.edges[k].target as usize;
        }
        let pts: Vec<[f64; 3]> = std::iter::once(g.nodes[g.edges[chain[0]].source as usize])
            .chain(chain.iter().map(|&k| g.nodes[g.edges[k].target as usize])).collect();
        let radius = |i: usize| -> f64 {
            if i == 0 { g.edges[chain[0]].radius as f64 }
            else if i == chain.len() { g.edges[chain[i - 1]].radius as f64 }
            else { 0.5 * (g.edges[chain[i - 1]].radius + g.edges[chain[i]].radius) as f64 }
        };
        let col = |i: usize| quality_rgb(g.edges[chain[i.min(chain.len() - 1)]].quality);
        // the first frame, then carried along
        let t0 = norm(sub(pts[1], pts[0]));
        let helper = if t0[2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
        let mut u = norm(cross(t0, helper));
        let mut prev_t = t0;
        let base = m.v.len() as u32;
        for i in 0..pts.len() {
            let t = if i == 0 { t0 } else if i == pts.len() - 1 { norm(sub(pts[i], pts[i - 1])) } else { norm(sub(pts[i + 1], pts[i - 1])) };
            // rotate u by the turn from prev_t to t (parallel transport)
            let axis_r = cross(prev_t, t);
            let s = (axis_r[0] * axis_r[0] + axis_r[1] * axis_r[1] + axis_r[2] * axis_r[2]).sqrt();
            if s > 1e-9 {
                let k = [axis_r[0] / s, axis_r[1] / s, axis_r[2] / s];
                let c = dot(prev_t, t).clamp(-1.0, 1.0);
                let kxu = cross(k, u);
                let kd = dot(k, u);
                u = [
                    u[0] * c + kxu[0] * s + k[0] * kd * (1.0 - c),
                    u[1] * c + kxu[1] * s + k[1] * kd * (1.0 - c),
                    u[2] * c + kxu[2] * s + k[2] * kd * (1.0 - c),
                ];
            }
            u = norm(sub(u, [t[0] * dot(u, t), t[1] * dot(u, t), t[2] * dot(u, t)]));
            let w = cross(t, u);
            prev_t = t;
            let r = radius(i);
            let cc = col(i);
            for j in 0..sides {
                let a = j as f64 / sides as f64 * std::f64::consts::TAU;
                let (ca, sa) = (a.cos() * r, a.sin() * r);
                m.v.push([pts[i][0] + u[0] * ca + w[0] * sa, pts[i][1] + u[1] * ca + w[1] * sa, pts[i][2] + u[2] * ca + w[2] * sa]);
                m.c.push(cc);
            }
        }
        for i in 0..pts.len() - 1 {
            for j in 0..sides {
                let a = base + (i * sides + j) as u32;
                let b = base + (i * sides + (j + 1) % sides) as u32;
                let c = a + sides as u32;
                let d = b + sides as u32;
                m.f.push([a, b, d]);
                m.f.push([a, d, c]);
            }
        }
    }
    m
}

/// OBJ, one object per tree, coordinates less `origin` (written as a
/// comment and returned by the caller beside the file).
pub fn write_obj(path: &Path, trees: &[(i32, Mesh)], origin: [f64; 3]) -> Result<(), String> {
    let f = std::fs::File::create(path).map_err(|e| format!("create {}: {e}", path.display()))?;
    let mut w = std::io::BufWriter::new(f);
    let io = |e: std::io::Error| e.to_string();
    writeln!(w, "# PointCloudLabeler QSM tubes, one object per tree").map_err(io)?;
    writeln!(w, "# origin {:.3} {:.3} {:.3} (add to every vertex for world coordinates)", origin[0], origin[1], origin[2]).map_err(io)?;
    let mut base = 1u64;
    for (id, m) in trees {
        writeln!(w, "o tree_{id}").map_err(io)?;
        for (p, c) in m.v.iter().zip(&m.c) {
            writeln!(w, "v {:.4} {:.4} {:.4} {:.3} {:.3} {:.3}", p[0] - origin[0], p[1] - origin[1], p[2] - origin[2],
                c[0] as f64 / 255.0, c[1] as f64 / 255.0, c[2] as f64 / 255.0).map_err(io)?;
        }
        for t in &m.f { writeln!(w, "f {} {} {}", t[0] as u64 + base, t[1] as u64 + base, t[2] as u64 + base).map_err(io)?; }
        base += m.v.len() as u64;
    }
    w.flush().map_err(io)
}

/// Binary PLY in world coordinates (double), colours, the tree of each face.
pub fn write_ply(path: &Path, trees: &[(i32, Mesh)]) -> Result<(), String> {
    let nv: usize = trees.iter().map(|t| t.1.v.len()).sum();
    let nf: usize = trees.iter().map(|t| t.1.f.len()).sum();
    let mut b: Vec<u8> = format!(
        "ply\nformat binary_little_endian 1.0\ncomment PointCloudLabeler QSM tubes, colour = quality\nelement vertex {nv}\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face {nf}\nproperty list uchar int vertex_indices\nproperty int tree\nend_header\n"
    ).into_bytes();
    b.reserve(nv * 27 + nf * 17);
    for (_, m) in trees {
        for (p, c) in m.v.iter().zip(&m.c) {
            for a in 0..3 { b.extend_from_slice(&p[a].to_le_bytes()); }
            b.extend_from_slice(c);
        }
    }
    let mut base = 0u32;
    for (id, m) in trees {
        for t in &m.f {
            b.push(3);
            for k in t { b.extend_from_slice(&((k + base) as i32).to_le_bytes()); }
            b.extend_from_slice(&id.to_le_bytes());
        }
        base += m.v.len() as u32;
    }
    std::fs::write(path, b).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Read every tree a `.qsm` or a `.qsf` names.
pub fn read_any(path: &Path) -> Result<Vec<QsmGraph>, String> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext == "qsf" {
        let dir = path.parent().unwrap_or(Path::new("."));
        let mut out = Vec::new();
        for e in read_qsf(path)? {
            let mut g = read_qsm(&dir.join(&e.path))?;
            if g.tree_id == 0 { g.tree_id = e.id; }
            out.push(g);
        }
        Ok(out)
    } else {
        let mut f = std::fs::File::open(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let mut sig = [0u8; 14];
        let _ = f.read(&mut sig);
        read_qsm(path).map(|g| vec![g])
    }
}

// ---------------------------------------------------------------- runs

/// The desktop's entry points (the ops call the same runs).
#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn qsm_export_files(
    state: tauri::State<'_, crate::state::AppState>,
    octree_dir: String,
    out_dir: Option<String>,
    formats: Vec<String>,
    sides: Option<u32>,
) -> Result<QsmExportResult, String> {
    // The dataset and an out folder elsewhere, as every file command takes them (fsgrant.rs).
    let octree_dir = state.authorise_path(&octree_dir).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    let out_dir = match out_dir.filter(|d| !d.trim().is_empty()) {
        Some(d) => Some(state.authorise_path(&d).map_err(|e| e.to_string())?.to_string_lossy().into_owned()),
        None => None,
    };
    let r = crate::rt::spawn_blocking(move || run_export_qsm(&octree_dir, out_dir.as_deref(), &formats, sides.unwrap_or(12)))
        .await
        .map_err(|e| format!("join error: {e}"))??;
    // the viewer reads the tubes next
    for p in [&r.ply, &r.obj, &r.qsf].into_iter().flatten() {
        state.grants.grant_file(Path::new(p));
    }
    Ok(r)
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn qsm_import_file(
    state: tauri::State<'_, crate::state::AppState>,
    path: String,
    out_ply: Option<String>,
    sides: Option<u32>,
) -> Result<QsmImportResult, String> {
    // The file was picked in a dialog (granted); the tubes written beside it are granted
    // so the viewer may read them (a file outside the project is otherwise refused).
    let path = state.authorise_path(&path).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    let out_ply = match out_ply.filter(|d| !d.trim().is_empty()) {
        Some(d) => Some(state.authorise_path(&d).map_err(|e| e.to_string())?.to_string_lossy().into_owned()),
        None => None,
    };
    let r = crate::rt::spawn_blocking(move || run_import_qsm(&path, out_ply.as_deref(), sides.unwrap_or(12)))
        .await
        .map_err(|e| format!("join error: {e}"))??;
    state.grants.grant_file(Path::new(&r.ply));
    Ok(r)
}

/// What an export wrote.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QsmExportResult {
    pub trees: u32,
    /// The forest manifest, when .qsm files were written.
    pub qsf: Option<String>,
    pub obj: Option<String>,
    pub ply: Option<String>,
    /// What the OBJ's coordinates are relative to.
    pub origin: [f64; 3],
    pub files: u32,
}

/// The dataset's fitted trees (qsm.json, from Tree QSM) to `.qsm` files
/// with a `.qsf` manifest, an OBJ (one object per tree, near the origin)
/// and a PLY (world coordinates, coloured by quality), into `out_dir`
/// (default: the dataset's qsm/ folder).
pub fn run_export_qsm(octree_dir: &str, out_dir: Option<&str>, formats: &[String], sides: u32) -> Result<QsmExportResult, String> {
    let q = crate::commands::octree::octree_read_qsm(octree_dir.to_string())?
        .ok_or("this dataset has no QSM yet — run Tree QSM (Metrics) first")?;
    if q.trees.is_empty() { return Err("the QSM has no trees".into()); }
    let out = match out_dir { Some(d) if !d.is_empty() => std::path::PathBuf::from(d), _ => Path::new(octree_dir).join("qsm") };
    std::fs::create_dir_all(&out).map_err(|e| format!("create {}: {e}", out.display()))?;
    let want = |f: &str| formats.is_empty() || formats.iter().any(|x| x.eq_ignore_ascii_case(f));
    let graphs: Vec<QsmGraph> = q.trees.iter().map(graph_of).filter(|g| !g.edges.is_empty()).collect();
    let mut res = QsmExportResult { trees: graphs.len() as u32, qsf: None, obj: None, ply: None, origin: [0.0; 3], files: 0 };
    if want("qsm") {
        let dir = out.join("trees");
        std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let mut entries = Vec::new();
        for g in &graphs {
            let name = format!("tree_{}.qsm", g.tree_id);
            write_qsm(&dir.join(&name), g, None)?;
            entries.push(QsfEntry { path: format!("trees/{name}"), id: g.tree_id, bbox: Some(g.bbox()), name: g.name.replace(' ', "_") });
            res.files += 1;
        }
        let m = out.join("forest.qsf");
        write_qsf(&m, &entries, None)?;
        res.qsf = Some(m.to_string_lossy().into_owned());
        res.files += 1;
    }
    if want("obj") || want("ply") {
        let meshes: Vec<(i32, Mesh)> = graphs.iter().map(|g| (g.tree_id, tube_mesh(g, sides as usize))).collect();
        if want("obj") {
            // near the origin, where a renderer's single precision holds
            let n = graphs.len().max(1) as f64;
            let c = graphs.iter().fold([0.0; 3], |a, g| { let r = g.nodes[0]; [a[0] + r[0] / n, a[1] + r[1] / n, a[2] + r[2] / n] });
            res.origin = [c[0].floor(), c[1].floor(), c[2].floor()];
            let p = out.join("trees.obj");
            write_obj(&p, &meshes, res.origin)?;
            std::fs::write(out.join("trees_origin.txt"), format!("{:.3} {:.3} {:.3}
", res.origin[0], res.origin[1], res.origin[2]))
                .map_err(|e| e.to_string())?;
            res.obj = Some(p.to_string_lossy().into_owned());
            res.files += 2;
        }
        if want("ply") {
            let p = out.join("trees.ply");
            write_ply(&p, &meshes)?;
            res.ply = Some(p.to_string_lossy().into_owned());
            res.files += 1;
        }
    }
    Ok(res)
}

/// What an import read.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QsmImportResult {
    pub trees: u32,
    pub edges: u32,
    /// The tubes, ready to show as a mesh layer.
    pub ply: String,
    /// The files' own messages (their QC log), per tree.
    pub messages: Vec<String>,
}

/// A `.qsm` or a `.qsf` from elsewhere to a PLY of tubes coloured by its
/// quality levels (default: beside it, `<name>_tubes.ply`).
pub fn run_import_qsm(path: &str, out_ply: Option<&str>, sides: u32) -> Result<QsmImportResult, String> {
    let p = Path::new(path);
    let graphs = read_any(p)?;
    let meshes: Vec<(i32, Mesh)> = graphs.iter().map(|g| (g.tree_id, tube_mesh(g, sides as usize))).collect();
    let out = match out_ply { Some(o) if !o.is_empty() => std::path::PathBuf::from(o), _ => p.with_file_name(format!("{}_tubes.ply", p.file_stem().and_then(|s| s.to_str()).unwrap_or("qsm"))) };
    write_ply(&out, &meshes)?;
    Ok(QsmImportResult {
        trees: graphs.len() as u32,
        edges: graphs.iter().map(|g| g.edges.len() as u32).sum(),
        ply: out.to_string_lossy().into_owned(),
        messages: graphs.iter().flat_map(|g| g.messages.iter().map(move |m| format!("tree {}: {m}", g.tree_id))).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> QsmGraph {
        // a stem of three edges and a branch of two from its middle node
        let mut g = QsmGraph { tree_id: 7, name: "tree 7".into(), ..QsmGraph::default() };
        g.nodes = vec![[400000.0, 6800000.0, 100.0], [400000.0, 6800000.0, 101.0], [400000.0, 6800000.0, 102.0],
            [400000.0, 6800000.0, 103.0], [400000.5, 6800000.0, 102.5], [400001.0, 6800000.0, 103.0]];
        let e = |s: u32, t: u32, r: f32, q: u8, axis: u32, order: u8| QsmEdge { source: s, target: t, radius: r, quality: q, axis, order, subtree_length: 0.0, distance_to_root: 0.0 };
        g.edges = vec![e(0, 1, 0.2, 4, 1, 1), e(1, 2, 0.18, 4, 1, 1), e(2, 3, 0.15, 3, 1, 1), e(2, 4, 0.05, 2, 2, 2), e(4, 5, 0.04, 1, 2, 2)];
        g.messages = vec!["[taper-reversal] thickens\nat 2 m".into()];
        g.measure();
        g
    }

    #[test]
    fn lengths_run_from_the_root_and_out_to_the_tips() {
        let g = sample();
        assert!((g.edges[0].subtree_length - (3.0 + 2.0 * 0.5f32.sqrt() * 1.0)).abs() < 1e-4, "{}", g.edges[0].subtree_length);
        assert_eq!(g.edges[0].distance_to_root, 0.0);
        assert!((g.edges[3].distance_to_root - 2.0).abs() < 1e-6);
        assert!((g.edges[4].subtree_length - 0.5f32.sqrt()).abs() < 1e-5);
    }

    #[test]
    fn a_qsm_file_round_trips() {
        let g = sample();
        let dir = std::env::temp_dir().join(format!("pcl_qsmfile_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("tree_7.qsm");
        write_qsm(&p, &g, Some("PROJCS[\"ETRS89 / TM35FIN\"]")).unwrap();
        let text = std::fs::read(&p).unwrap();
        let head = String::from_utf8_lossy(&text[..text.windows(12).position(|w| w == b"DATA binary\n").unwrap() + 12]).to_string();
        assert!(head.starts_with("SIGNATURE QSMF\nVERSION 1.0\nFORMAT 2\nNODES 6\nEDGES 5\n"), "{head}");
        assert!(head.contains("XMIN 400000.0000") && head.contains("ZMAX 103.0000") && head.contains("TREEID 7"));
        assert_eq!(text.len(), head.len() + 6 * 12 + 5 * 26);
        // the first edge names nodes 1 and 2 in the file (Arbor counts from 1)
        let e0 = head.len() + 6 * 12;
        assert_eq!(u32::from_le_bytes(text[e0..e0 + 4].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(text[e0 + 4..e0 + 8].try_into().unwrap()), 2);
        let r = read_qsm(&p).unwrap();
        assert_eq!(r.tree_id, 7);
        assert_eq!(r.edges.len(), 5);
        for (a, b) in r.nodes.iter().zip(&g.nodes) { assert!(dist(*a, *b) < 1e-3); }
        assert_eq!(r.edges[3], QsmEdge { ..g.edges[3].clone() });
        assert_eq!(r.messages, g.messages);
        // and the manifest
        let m = dir.join("forest.qsf");
        let (lo, hi) = g.bbox();
        write_qsf(&m, &[QsfEntry { path: "tree_7.qsm".into(), id: 7, bbox: Some((lo, hi)), name: "tree 7".into() }], None).unwrap();
        let all = read_any(&m).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].nodes.len(), 6);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn treeqsm_chains_continue_from_joint_to_joint() {
        use crate::commands::octree::BranchCylinder;
        let c = |start: [f64; 3], end: [f64; 3], seg: u32, pos: u32, parent: Option<u32>, order: u8| BranchCylinder {
            added: false, extension: None, position_in_branch: pos, unmod_radius: 0.1, start, end, radius: 0.1, length: 1.0,
            volume: 0.03, n_voxels: 10, rmse: 0.001, segment_id: seg, parent_cylinder: parent, parent_segment: None,
            branch_order: order, coverage: 1.0, sector_mask: 0xFFF,
        };
        let mut t: TreeQsm = serde_json::from_value(serde_json::json!({
            "treeId": 3, "baseX": 0, "baseY": 0, "baseZ": 0, "height": 3, "slices": [{ "hag": 0, "z": 0.5, "centerX": 0, "centerY": 0, "radius": 0.2, "rmse": 0, "nPoints": 50, "coverage": 1 }],
            "branches": [], "branchVolume": 0, "branchCount": 0, "totalVolume": 0, "stemVolume": 0, "stemVolumeStd": 0, "stemVolumeCi95": 0,
            "dbh": 0.3, "confidence": 1, "completeness": 1, "acceptedSlices": 1, "rejectedSlices": 0,
        })).unwrap();
        // the trunk in two cylinders with a 3 cm gap, a branch off it
        t.branches = vec![
            c([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0, 1, None, 0),
            c([0.0, 0.0, 1.03], [0.0, 0.0, 2.0], 0, 2, Some(0), 0),
            c([0.05, 0.0, 1.5], [0.8, 0.0, 2.0], 1, 1, None, 1),
        ];
        let g = graph_of(&t);
        // the trunk replaces the slices; three cylinders, one connector
        assert_eq!(g.nodes[0], [0.0, 0.0, 0.0]);
        assert_eq!(g.edges.len(), 4);
        assert_eq!(g.edges[1].source, g.edges[0].target, "the second trunk cylinder starts where the first ends");
        assert_eq!((g.edges[0].axis, g.edges[0].order), (1, 1));
        assert_eq!(g.edges[2].quality, 0, "the branch is tied to the trunk by a connector");
        assert_eq!((g.edges[3].axis, g.edges[3].order), (3, 2));
        // one tube for the trunk, one for the branch with its connector
        let m = tube_mesh(&g, 6);
        assert_eq!(m.v.len(), (3 + 3) * 6);
    }

    #[test]
    fn a_file_counting_nodes_from_zero_reads_too() {
        // the same tree written with 0-based indices, as another writer might
        let g = sample();
        let dir = std::env::temp_dir().join(format!("pcl_qsm0_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.qsm");
        write_qsm(&p, &g, None).unwrap();
        let mut b = std::fs::read(&p).unwrap();
        let start = b.windows(12).position(|w| w == b"DATA binary\n").unwrap() + 12 + g.nodes.len() * 12;
        for k in 0..g.edges.len() {
            for f in [0usize, 4] {
                let o = start + k * 26 + f;
                let v = u32::from_le_bytes(b[o..o + 4].try_into().unwrap()) - 1;
                b[o..o + 4].copy_from_slice(&v.to_le_bytes());
            }
        }
        std::fs::write(&p, b).unwrap();
        let r = read_qsm(&p).unwrap();
        assert_eq!(r.edges.iter().map(|e| (e.source, e.target)).collect::<Vec<_>>(), g.edges.iter().map(|e| (e.source, e.target)).collect::<Vec<_>>());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tubes_follow_the_axes_and_close_round() {
        let g = sample();
        let m = tube_mesh(&g, 8);
        // the stem: four rings, the branch: three (its own first ring at the fork)
        assert_eq!(m.v.len(), (4 + 3) * 8);
        assert_eq!(m.f.len(), (3 + 2) * 8 * 2);
        // the stem's rings sit at the radius
        let r0 = dist(m.v[0], g.nodes[0]);
        assert!((r0 - 0.2).abs() < 1e-6, "{r0}");
        assert_eq!(m.c[0], quality_rgb(4));
        // the stem's rings are horizontal: no twist on a straight axis
        assert!(m.v[..8].iter().all(|p| (p[2] - 100.0).abs() < 1e-9));
        let dir = std::env::temp_dir().join(format!("pcl_qsmmesh_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        write_ply(&dir.join("t.ply"), &[(7, m.clone())]).unwrap();
        write_obj(&dir.join("t.obj"), &[(7, m)], [400000.0, 6800000.0, 100.0]).unwrap();
        let obj = std::fs::read_to_string(dir.join("t.obj")).unwrap();
        assert!(obj.contains("o tree_7") && obj.contains("\nv 0.2000 0.0000 0.0000 ") && obj.contains("\nf 1 2 10\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
