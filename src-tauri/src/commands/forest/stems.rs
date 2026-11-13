//! Where the stems stand: circles in thin horizontal slices above the
//! ground, chained up each stem into a seed.
//!
//! A slice's wood points are clustered in plan view and each cluster gets a
//! trimmed circle fit (Taubin, refitted on its inliers until they settle;
//! points of a branch or a neighbouring stem in the cluster drop out as
//! outliers, and what is left over is tried again for a second stem). A
//! circle is believed by how much of it the points cover — the share of
//! 10° sectors with points, and the widest empty arc — and by the share of
//! the cluster that fits it, the bar set by the radius: a thin stem must be
//! seen round more of itself than a thick one before it is a stem.
//!
//! Circles chain upward slice by slice to the one each lines up with
//! (allowing for lean and taper), at most one per slice; the chain gives a
//! stem axis (least squares, weighted by fit), a lean and a radius. A seed
//! needs two circles, or one very clean one. Stems with no circle at all —
//! saplings thinner than the points resolve, stems hidden behind others —
//! still carry their whole crown to the ground, so the flow skeleton near
//! the ground, away from the circle seeds, seeds them too.

use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};

use super::WorkSet;
use crate::commands::circlefit::taubin_circle;

#[derive(Clone, Debug)]
pub struct StemParams {
    /// Heights above ground of the slices, metres.
    pub slices: Vec<f32>,
    /// Half the slice thickness, metres.
    pub half: f32,
    /// Plan-view link distance of a cluster, metres.
    pub eps: f32,
    pub min_pts: usize,
    pub r_min: f64,
    pub r_max: f64,
    /// Carried cells (wood::carried) that seed a stem without a circle.
    /// For a scan that sees round every stem, a stem without a circle is
    /// rarely a stem, and `MLS_FLOW_CARRY` is the bar.
    pub flow_carry: f32,
    /// …below this height above ground.
    pub flow_max_hag: f32,
    /// A single thick, clean circle seeds a stem on its own. Off: on the
    /// MLS reference plots most such seeds stood on a big tree's buttress
    /// or a low limb.
    pub lone_circle: bool,
}

impl Default for StemParams {
    fn default() -> Self {
        StemParams {
            slices: vec![0.45, 0.8, 1.15, 1.5, 1.85, 2.2],
            half: 0.05,
            eps: 0.07,
            min_pts: 8,
            r_min: 0.02,
            r_max: 1.2,
            flow_carry: 40.0,
            flow_max_hag: 1.2,
            lone_circle: false,
        }
    }
}

/// A circle found in a slice.
#[derive(Clone, Debug)]
pub struct Circle {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
    /// The slice's height above ground.
    pub h: f32,
    /// Share of the 36 sectors with points, 0 … 1.
    pub cover: f32,
    /// The widest arc without points, degrees.
    pub gap: f32,
    /// Share of the points around the circle (within its radius plus a
    /// margin) that are on it — neighbours further out do not count.
    pub fit: f32,
    /// Points inside the circle, as a share of those on it.
    pub interior: f32,
    /// Its points (working-set nodes).
    pub nodes: Vec<u32>,
    /// Mean ground height under its points (z − hag).
    pub ground: f32,
}

impl Circle {
    fn score(&self) -> f32 { self.cover * self.fit }
}

/// A stem: where it stands and how it leans. Coordinates are those of the
/// working set (relative to the dataset offset) in memory; the dataset's
/// seeds.json holds world ones.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Seed {
    pub id: u32,
    /// The tree it grows (several seeds may grow one tree).
    pub tree: u32,
    /// The axis at the ground.
    pub x: f64,
    pub y: f64,
    /// The ground under it.
    pub z: f64,
    /// Radius, metres; 0 when unknown.
    pub r: f64,
    /// The axis' horizontal drift per metre of height (east, north).
    pub lean: [f64; 2],
    /// Height above ground of its highest circle (or flow point).
    pub top: f32,
    pub circles: u32,
    /// "circle", "flow" or "user".
    pub source: String,
}

impl Seed {
    pub fn axis_at(&self, h: f64) -> (f64, f64) { (self.x + self.lean[0] * h, self.y + self.lean[1] * h) }
    /// Horizontal reach of the seed around its axis: its own points.
    pub fn reach(&self) -> f64 { if self.r > 0.0 { self.r + (0.15 * self.r).max(0.03) } else { 0.12 } }
}

/// `StemParams::flow_carry` where the scanner went round the stems (MLS):
/// on the MLS reference plots the flow places on real small trees carried a
/// median of 300–1 800 cells, those on shrubs and on a big tree's low limbs
/// 80–160, and at 40 every second one was a shrub or a piece of a
/// neighbour. A single TLS position sees many stems from one side only and
/// keeps 40: the flow is how those are found.
pub const MLS_FLOW_CARRY: f32 = 250.0;

/// The breast-height band the stems are measured in from the full points
/// (`refine_at_breast_height`), metres above ground.
pub const BH_BAND: (f64, f64) = (1.2, 1.4);

/// How far from a seed's axis its breast-height points are gathered.
pub fn bh_reach(s: &Seed) -> f64 { s.r.max(0.05) * 1.5 + 0.08 }

/// A stem's circle at breast height from the full points around its axis
/// (`pts`, in `BH_BAND`), where the working set's voxels are too coarse: a
/// stem 9 cm across is about one 5 cm voxel wide, and a circle fitted to
/// voxels there ringed the twigs round it (two to three times the field
/// DBH on the MLS plots). The trimmed fit at 1 cm, believed when its points
/// cover the circle well enough, nothing much is inside it, and it stays
/// on the seed's own stem. (centre x, centre y, radius).
pub fn refine_at_breast_height(seed: &Seed, pts: &[(f64, f64)]) -> Option<(f64, f64, f64)> {
    if pts.len() < 10 { return None; }
    // 3 cm: an MLS stem's shell of points is 1–3 cm thick (noise and the
    // passes' registration); a 1 cm band fitted a small circle to a stretch
    // of it (median error 2.0 cm against the calipers; 3 cm: 1.2 cm)
    let (cx, cy, r, inl) = trimmed_circle_n(pts, 0.03, 400, true)?;
    if inl.len() < 10 || !(0.01..=1.2).contains(&r) { return None; }
    let on: Vec<(f64, f64)> = inl.iter().map(|&k| pts[k]).collect();
    let (cover, gap) = arc_cover(&on, cx, cy, cover_bins(r, 0.01));
    if cover < 0.35 || gap > 220.0 { return None; }
    let band = (0.12 * r).max(0.03);
    let inside = pts.iter().filter(|p| ((p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sqrt() < r - 2.0 * band).count();
    if inside as f64 > 0.3 * inl.len() as f64 { return None; }
    let (ax, ay) = seed.axis_at((BH_BAND.0 + BH_BAND.1) * 0.5);
    if ((cx - ax).powi(2) + (cy - ay).powi(2)).sqrt() > seed.r.max(0.05) + 0.1 { return None; }
    Some((cx, cy, r))
}

/// Plan-view clusters of `idx` with links up to `eps`.
pub fn cluster2d(p: &[[f32; 3]], idx: &[u32], eps: f32) -> Vec<Vec<u32>> {
    let inv = 1.0 / eps;
    let key = |q: &[f32; 3]| ((q[0] * inv).floor() as i32, (q[1] * inv).floor() as i32);
    let mut grid: FxHashMap<(i32, i32), Vec<u32>> = FxHashMap::default();
    for (k, &i) in idx.iter().enumerate() { grid.entry(key(&p[i as usize])).or_default().push(k as u32); }
    let e2 = eps * eps;
    let mut seen = vec![false; idx.len()];
    let mut out = Vec::new();
    let mut stack = Vec::new();
    for s in 0..idx.len() {
        if seen[s] { continue; }
        seen[s] = true;
        stack.push(s as u32);
        let mut members = Vec::new();
        while let Some(k) = stack.pop() {
            let q = p[idx[k as usize] as usize];
            members.push(idx[k as usize]);
            let (gx, gy) = key(&q);
            for dx in -1..=1 {
                for dy in -1..=1 {
                    if let Some(cell) = grid.get(&(gx + dx, gy + dy)) {
                        for &m in cell {
                            if seen[m as usize] { continue; }
                            let o = p[idx[m as usize] as usize];
                            if (o[0] - q[0]).powi(2) + (o[1] - q[1]).powi(2) <= e2 {
                                seen[m as usize] = true;
                                stack.push(m);
                            }
                        }
                    }
                }
            }
        }
        out.push(members);
    }
    out
}

/// The circle through three points.
fn circumcircle(a: (f64, f64), b: (f64, f64), c: (f64, f64)) -> Option<(f64, f64, f64)> {
    let d = 2.0 * (a.0 * (b.1 - c.1) + b.0 * (c.1 - a.1) + c.0 * (a.1 - b.1));
    if d.abs() < 1e-12 { return None; }
    let (a2, b2, c2) = (a.0 * a.0 + a.1 * a.1, b.0 * b.0 + b.1 * b.1, c.0 * c.0 + c.1 * c.1);
    let ux = (a2 * (b.1 - c.1) + b2 * (c.1 - a.1) + c2 * (a.1 - b.1)) / d;
    let uy = (a2 * (c.0 - b.0) + b2 * (a.0 - c.0) + c2 * (b.0 - a.0)) / d;
    Some((ux, uy, ((a.0 - ux).powi(2) + (a.1 - uy).powi(2)).sqrt()))
}

/// A robust circle fit: the best of Taubin on everything and of circles
/// through three points sampled deterministically (the one with most
/// points near it), then Taubin on its inliers until they settle. The
/// circle and its inliers' positions in `xy`.
pub fn trimmed_circle(xy: &[(f64, f64)], tol: f64) -> Option<(f64, f64, f64, Vec<usize>)> {
    trimmed_circle_n(xy, tol, 96, false)
}

/// `trimmed_circle` with `samples` three-point circles: more where the
/// stem is a small share of the points (a whole breast-height band of a
/// spruce, its branches all round). `arc`: a circle's points count by how
/// much of it they go round (twelve sectors) — the band on the circle
/// widens with its radius, so without it a circle of metres through a
/// compact cluster holds every point of it on a sliver of its rim and
/// wins (a stem 9 cm across inside its twigs read 5.8 m).
pub fn trimmed_circle_n(xy: &[(f64, f64)], tol: f64, samples: usize, arc: bool) -> Option<(f64, f64, f64, Vec<usize>)> {
    let n = xy.len();
    if n < 5 { return None; }
    // points on the circle, less twice those inside it: a stem is hollow,
    // a shrub or a crown blob is not
    let count = |cx: f64, cy: f64, r: f64| -> f64 {
        let band = tol.max(0.12 * r);
        let (mut on, mut inside) = (0usize, 0usize);
        let mut sectors = 0u16;
        for p in xy {
            let d = ((p.0 - cx).powi(2) + (p.1 - cy).powi(2)).sqrt();
            if (d - r).abs() <= band {
                on += 1;
                if arc {
                    let a = (p.1 - cy).atan2(p.0 - cx) + std::f64::consts::PI;
                    sectors |= 1 << ((a / std::f64::consts::TAU * 12.0) as u32).min(11);
                }
            } else if d < r - band { inside += 1; }
        }
        let on = if arc { on as f64 * sectors.count_ones() as f64 / 12.0 } else { on as f64 };
        (on - 2.0 * inside as f64).max(0.0)
    };
    let mut best: Option<((f64, f64, f64), f64)> = taubin_circle(xy).map(|c| (c, count(c.0, c.1, c.2)));
    if best.map_or(true, |(_, k)| k < 0.8 * n as f64) {
        let mut st = 0x9E37_79B9_7F4A_7C15u64 ^ n as u64;
        let mut pick = || { st = st.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); ((st >> 33) as usize) % n };
        for _ in 0..samples {
            let (i, j, k) = (pick(), pick(), pick());
            if i == j || j == k || i == k { continue; }
            let Some(c) = circumcircle(xy[i], xy[j], xy[k]) else { continue };
            if c.2 > 3.0 { continue; }
            let m = count(c.0, c.1, c.2);
            if best.map_or(true, |(_, b)| m > b) { best = Some((c, m)); }
        }
    }
    let ((mut cx, mut cy, mut r), _) = best?;
    let mut inl: Vec<usize> = Vec::new();
    for _ in 0..5 {
        let band = tol.max(0.12 * r);
        let next: Vec<usize> = (0..xy.len())
            .filter(|&i| (((xy[i].0 - cx).powi(2) + (xy[i].1 - cy).powi(2)).sqrt() - r).abs() <= band)
            .collect();
        if next.len() < 5 { return None; }
        if next == inl { break; }
        let sub: Vec<(f64, f64)> = next.iter().map(|&i| xy[i]).collect();
        let (a, b, c) = taubin_circle(&sub)?;
        cx = a; cy = b; r = c;
        inl = next;
    }
    Some((cx, cy, r, inl))
}

/// Share of `bins` sectors the points cover, and the widest empty arc (°).
pub fn arc_cover(xy: &[(f64, f64)], cx: f64, cy: f64, bins: usize) -> (f32, f32) {
    let bins = bins.clamp(4, 72);
    let mut occ = vec![false; bins];
    let w = 360.0 / bins as f64;
    for &(x, y) in xy {
        let a = (y - cy).atan2(x - cx).to_degrees().rem_euclid(360.0);
        occ[((a / w) as usize).min(bins - 1)] = true;
    }
    let filled = occ.iter().filter(|&&b| b).count();
    if filled == 0 { return (0.0, 360.0); }
    let (mut gap, mut run) = (0usize, 0usize);
    for i in 0..2 * bins {
        if occ[i % bins] { run = 0; } else { run += 1; gap = gap.max(run); }
    }
    (filled as f32 / bins as f32, (gap.min(bins) as f64 * w) as f32)
}

/// Sectors to judge a circle's cover by: no finer than the points can fill.
/// A stem 10 cm in radius at 4 cm voxels has some 15 points round it, and
/// 36 sectors would call it 40 % covered when it is seen all round.
pub fn cover_bins(r: f64, voxel: f64) -> usize {
    ((std::f64::consts::TAU * r / (1.5 * voxel.max(0.005))).round() as usize).clamp(8, 36)
}

/// Whether a circle is a stem. `relaxed`: for a place the flow already says
/// a stem stands, a partial view is enough.
fn believable(c: &Circle, prm: &StemParams, relaxed: bool) -> bool {
    if c.r < prm.r_min || c.r > prm.r_max || c.interior > 0.3 { return false; }
    if relaxed {
        return c.fit >= 0.45 && c.cover >= if c.r < 0.05 { 0.33 } else { 0.22 } && c.gap <= 280.0;
    }
    if c.fit < 0.6 { return false; }
    if c.r < 0.05 { c.cover >= 0.5 && c.gap <= 180.0 }
    else if c.r < 0.15 { c.cover >= 0.36 && c.gap <= 230.0 }
    else { c.cover >= 0.28 && c.gap <= 250.0 }
}

/// Why circles were turned down, for FOREST_DEBUG.
#[derive(Default, Debug)]
struct Tally { clusters: usize, fits: usize, accepted: usize, radius: usize, interior: usize, fit: usize, cover: usize }

/// The believable circles among `idx` (one slice's nodes).
fn circles_in(ws: &WorkSet, idx: &[u32], h: f32, prm: &StemParams, relaxed: bool, tally: &mut Tally) -> Vec<Circle> {
    let mut out = Vec::new();
    let tol = (ws.voxel as f64 * 0.6).max(0.015);
    for cluster in cluster2d(&ws.p, idx, prm.eps) {
        tally.clusters += 1;
        let mut rest = cluster;
        // a cluster may hold a stem among shrubs, or two stems that touch:
        // whatever a fit leaves over is tried again
        for _ in 0..4 {
            if rest.len() < prm.min_pts { break; }
            let xy: Vec<(f64, f64)> = rest.iter().map(|&i| (ws.p[i as usize][0] as f64, ws.p[i as usize][1] as f64)).collect();
            let Some((cx, cy, r, inl)) = trimmed_circle(&xy, tol) else { break };
            tally.fits += 1;
            let band = tol.max(0.12 * r);
            let around = r + band + (0.3 * r).max(0.05);
            let (mut local, mut inside) = (0usize, 0usize);
            for &(x, y) in &xy {
                let d = ((x - cx).powi(2) + (y - cy).powi(2)).sqrt();
                if d <= around { local += 1; }
                // clearly inside: past the shell's own voxel noise
                if d < r - 2.0 * band { inside += 1; }
            }
            let pts: Vec<(f64, f64)> = inl.iter().map(|&k| xy[k]).collect();
            let (cover, gap) = arc_cover(&pts, cx, cy, cover_bins(r, ws.voxel as f64));
            let nodes: Vec<u32> = inl.iter().map(|&k| rest[k]).collect();
            let ground = nodes.iter().map(|&i| ws.p[i as usize][2] - ws.hag[i as usize]).sum::<f32>() / nodes.len() as f32;
            let c = Circle {
                cx, cy, r, h, cover, gap,
                fit: inl.len() as f32 / local.max(1) as f32,
                interior: inside as f32 / inl.len().max(1) as f32,
                nodes, ground,
            };
            let used: std::collections::HashSet<u32> = c.nodes.iter().copied().collect();
            if believable(&c, prm, relaxed) { tally.accepted += 1; out.push(c); }
            else if c.r < prm.r_min || c.r > prm.r_max { tally.radius += 1; }
            else if c.interior > 0.3 { tally.interior += 1; }
            else if c.fit < if relaxed { 0.45 } else { 0.6 } { tally.fit += 1; }
            else { tally.cover += 1; }
            rest.retain(|i| !used.contains(i));
        }
    }
    // two circles of one slice on the same stem: keep the better
    out.sort_by(|a, b| b.score().partial_cmp(&a.score()).unwrap_or(std::cmp::Ordering::Equal));
    let mut kept: Vec<Circle> = Vec::new();
    for c in out {
        if kept.iter().all(|k| ((k.cx - c.cx).powi(2) + (k.cy - c.cy).powi(2)).sqrt() > 0.7 * (k.r + c.r)) { kept.push(c); }
    }
    kept
}

/// The believable circles of one slice among the `member` nodes.
pub fn slice_circles(ws: &WorkSet, member: &[bool], h: f32, prm: &StemParams) -> Vec<Circle> {
    let idx: Vec<u32> = (0..ws.len() as u32)
        .filter(|&i| member[i as usize] && (ws.hag[i as usize] - h).abs() <= prm.half)
        .collect();
    let mut tally = Tally::default();
    let out = circles_in(ws, &idx, h, prm, false, &mut tally);
    if std::env::var("FOREST_DEBUG").is_ok() { eprintln!("slice {h:.2} m: {} nodes, {tally:?}", idx.len()); }
    out
}

/// Chain circles up the slices into stems: each circle joins the chain whose
/// last circle (one or two slices down) it lines up with best, one circle
/// per chain per slice. Circles by slice, in slice order.
fn chain(per_slice: &[Vec<Circle>]) -> Vec<Vec<(usize, usize)>> {
    let mut chains: Vec<Vec<(usize, usize)>> = Vec::new();
    for (s, cs) in per_slice.iter().enumerate() {
        let mut claimed: Vec<Option<(usize, f64)>> = vec![None; chains.len()];
        let mut choice: Vec<Option<usize>> = vec![None; cs.len()];
        for (ci, c) in cs.iter().enumerate() {
            let mut best: Option<(usize, f64)> = None;
            for (k, ch) in chains.iter().enumerate() {
                let &(ls, li) = ch.last().unwrap();
                if s - ls > 2 { continue; }
                let l = &per_slice[ls][li];
                let dh = (c.h - l.h) as f64;
                let d = ((c.cx - l.cx).powi(2) + (c.cy - l.cy).powi(2)).sqrt();
                let ratio = c.r / l.r;
                if !(0.55..=1.8).contains(&ratio) { continue; }
                if d > 0.35 * c.r.max(l.r) + 0.25 * dh + 0.03 { continue; }
                if best.map_or(true, |b| d < b.1) { best = Some((k, d)); }
            }
            if let Some((k, d)) = best {
                match claimed[k] {
                    Some((_, od)) if od <= d => {}
                    _ => { claimed[k] = Some((ci, d)); }
                }
                choice[ci] = Some(k);
            }
        }
        for (ci, ch) in choice.iter().enumerate() {
            match ch {
                Some(k) if claimed[*k].map(|c| c.0) == Some(ci) => chains[*k].push((s, ci)),
                _ => chains.push(vec![(s, ci)]),
            }
        }
    }
    chains
}

/// A seed from a chain of circles: the axis by weighted least squares of
/// the centres against height, the median radius.
fn seed_of(cs: &[&Circle]) -> Seed {
    let w: Vec<f64> = cs.iter().map(|c| (c.score() as f64).max(1e-3)).collect();
    let sw: f64 = w.iter().sum();
    let mh = cs.iter().zip(&w).map(|(c, w)| c.h as f64 * w).sum::<f64>() / sw;
    let mx = cs.iter().zip(&w).map(|(c, w)| c.cx * w).sum::<f64>() / sw;
    let my = cs.iter().zip(&w).map(|(c, w)| c.cy * w).sum::<f64>() / sw;
    let shh = cs.iter().zip(&w).map(|(c, w)| (c.h as f64 - mh).powi(2) * w).sum::<f64>();
    let (lx, ly) = if shh > 1e-6 {
        (
            cs.iter().zip(&w).map(|(c, w)| (c.h as f64 - mh) * (c.cx - mx) * w).sum::<f64>() / shh,
            cs.iter().zip(&w).map(|(c, w)| (c.h as f64 - mh) * (c.cy - my) * w).sum::<f64>() / shh,
        )
    } else { (0.0, 0.0) };
    // more than ~40° of lean is a branch, not a stem
    let (lx, ly) = { let l = (lx * lx + ly * ly).sqrt(); if l > 0.85 { (lx * 0.85 / l, ly * 0.85 / l) } else { (lx, ly) } };
    let mut rs: Vec<f64> = cs.iter().map(|c| c.r).collect();
    rs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let ground = cs.iter().map(|c| c.ground as f64).sum::<f64>() / cs.len() as f64;
    Seed {
        id: 0, tree: 0,
        x: mx - lx * mh, y: my - ly * mh, z: ground,
        r: rs[rs.len() / 2], lean: [lx, ly],
        top: cs.iter().map(|c| c.h).fold(0.0, f32::max),
        circles: cs.len() as u32, source: "circle".into(),
    }
}

/// The seeds of a stand: stems by their circles, then by the flow skeleton
/// where no circle is. `member`: the nodes a stem may be made of (wood);
/// `carry`: what each node carries (wood::carried).
pub fn detect_seeds(ws: &WorkSet, member: &[bool], carry: &[f32], prm: &StemParams) -> (Vec<Seed>, Vec<Circle>) {
    use rayon::prelude::*;
    let mut slices: Vec<f32> = prm.slices.clone();
    slices.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let per_slice: Vec<Vec<Circle>> = slices.par_iter().map(|&h| slice_circles(ws, member, h, prm)).collect();
    let mut seeds: Vec<Seed> = Vec::new();
    let mut all_circles: Vec<Circle> = Vec::new();
    for ch in chain(&per_slice) {
        let cs: Vec<&Circle> = ch.iter().map(|&(s, i)| &per_slice[s][i]).collect();
        // one slice alone is a stem only when it is thick and seen well
        // (a shrub's stem or a twig makes a clean small circle as easily)
        let lone_clean = prm.lone_circle && cs.len() == 1 && cs[0].r >= 0.08 && cs[0].cover >= 0.6 && cs[0].fit >= 0.75;
        if cs.len() < 2 && !lone_clean { continue; }
        seeds.push(seed_of(&cs));
        all_circles.extend(cs.into_iter().cloned());
    }
    // places the flow says a stem stands, away from the circle seeds: the
    // stems a strict circle missed (seen from one side, among shrubs) and
    // the ones too thin for any
    let near_seed = |q: &[f32; 3], h: f32| seeds.iter().any(|s| {
        let (ax, ay) = s.axis_at(h as f64);
        ((q[0] as f64 - ax).powi(2) + (q[1] as f64 - ay).powi(2)).sqrt() < s.reach() + 0.25
    });
    let flow: Vec<u32> = (0..ws.len() as u32)
        .filter(|&i| {
            let i = i as usize;
            carry[i] >= prm.flow_carry && ws.hag[i] <= prm.flow_max_hag && !near_seed(&ws.p[i], ws.hag[i])
        })
        .collect();
    // one place per stem: a stem's surface carries in columns, so cluster wide
    let places = cluster2d(&ws.p, &flow, 0.3);
    // each slice's stem material in 1 m plan cells, for the places to look in
    let slice_cells: Vec<FxHashMap<(i32, i32), Vec<u32>>> = slices
        .iter()
        .map(|&h| {
            let mut g: FxHashMap<(i32, i32), Vec<u32>> = FxHashMap::default();
            for i in 0..ws.len() {
                if member[i] && (ws.hag[i] - h).abs() <= prm.half {
                    g.entry((ws.p[i][0].floor() as i32, ws.p[i][1].floor() as i32)).or_default().push(i as u32);
                }
            }
            g
        })
        .collect();
    let rescued: Vec<(Option<(Seed, Vec<Circle>)>, Option<Seed>)> = places
        .par_iter()
        .filter(|cl| cl.len() >= 3)
        .map(|cl| {
            // the heaviest columns mark where the stem is
            let wsum: f64 = cl.iter().map(|&i| carry[i as usize] as f64).sum();
            let x = cl.iter().map(|&i| ws.p[i as usize][0] as f64 * carry[i as usize] as f64).sum::<f64>() / wsum;
            let y = cl.iter().map(|&i| ws.p[i as usize][1] as f64 * carry[i as usize] as f64).sum::<f64>() / wsum;
            // a partial circle there, slice by slice
            let mut per: Vec<Vec<Circle>> = Vec::new();
            for (si, &h) in slices.iter().enumerate() {
                let (gx, gy) = (x.floor() as i32, y.floor() as i32);
                let mut idx: Vec<u32> = Vec::new();
                for dx in -1..=1 { for dy in -1..=1 {
                    if let Some(cell) = slice_cells[si].get(&(gx + dx, gy + dy)) {
                        idx.extend(cell.iter().copied().filter(|&i| {
                            let q = ws.p[i as usize];
                            (q[0] as f64 - x).powi(2) + (q[1] as f64 - y).powi(2) <= 0.6 * 0.6
                        }));
                    }
                }}
                let mut t = Tally::default();
                per.push(circles_in(ws, &idx, h, prm, true, &mut t));
            }
            let best = chain(&per).into_iter().max_by_key(|c| c.len());
            if let Some(ch) = best {
                let cs: Vec<&Circle> = ch.iter().map(|&(s, i)| &per[s][i]).collect();
                if cs.len() >= 2 {
                    let seed = seed_of(&cs);
                    if ((seed.x - x).powi(2) + (seed.y - y).powi(2)).sqrt() < 0.5 {
                        let circles = cs.into_iter().cloned().collect();
                        return (Some((seed, circles)), None);
                    }
                }
            }
            let z = cl.iter().map(|&i| (ws.p[i as usize][2] - ws.hag[i as usize]) as f64).sum::<f64>() / cl.len() as f64;
            let top = cl.iter().map(|&i| ws.hag[i as usize]).fold(0.0, f32::max);
            (None, Some(Seed { id: 0, tree: 0, x, y, z, r: 0.0, lean: [0.0, 0.0], top, circles: 0, source: "flow".into() }))
        })
        .collect();
    let strict = seeds.len();
    for (c, f) in rescued {
        if let Some((s, cs)) = c { seeds.push(s); all_circles.extend(cs); }
        if let Some(s) = f { seeds.push(s); }
    }
    if std::env::var("FOREST_DEBUG").is_ok() {
        let circ = seeds.iter().filter(|s| s.circles > 0).count();
        eprintln!("seeds: {strict} by strict circles, {} rescued by partial circles, {} by flow alone", circ - strict, seeds.len() - circ);
    }
    // ids west to east, south to north, so a re-run numbers alike
    seeds.sort_by(|a, b| (a.x, a.y).partial_cmp(&(b.x, b.y)).unwrap_or(std::cmp::Ordering::Equal));
    for (k, s) in seeds.iter_mut().enumerate() { s.id = k as u32 + 1; s.tree = k as u32 + 1; }
    (seeds, all_circles)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::forest::lcg;

    fn ring(cx: f32, cy: f32, r: f32, z: f32, n: usize, from_deg: f32, to_deg: f32) -> Vec<[f32; 3]> {
        (0..n).map(|i| {
            let t = (from_deg + (to_deg - from_deg) * i as f32 / n as f32).to_radians();
            [cx + r * t.cos(), cy + r * t.sin(), z]
        }).collect()
    }

    #[test]
    fn a_full_circle_a_half_circle_and_an_arc_too_thin_to_trust() {
        let full: Vec<(f64, f64)> = ring(0.0, 0.0, 0.2, 0.0, 60, 0.0, 360.0).iter().map(|q| (q[0] as f64, q[1] as f64)).collect();
        let (cx, cy, r, inl) = trimmed_circle(&full, 0.01).unwrap();
        assert!(cx.abs() < 1e-6 && cy.abs() < 1e-6 && (r - 0.2).abs() < 1e-6 && inl.len() == 60);
        let (cover, gap) = arc_cover(&full, cx, cy, 36);
        assert!(cover > 0.95 && gap <= 10.0);
        let half: Vec<(f64, f64)> = ring(0.0, 0.0, 0.2, 0.0, 30, 0.0, 180.0).iter().map(|q| (q[0] as f64, q[1] as f64)).collect();
        let (cover, gap) = arc_cover(&half, 0.0, 0.0, 36);
        assert!((cover - 0.5).abs() < 0.06 && (gap - 180.0).abs() <= 10.0);
    }

    #[test]
    fn outliers_drop_out_of_the_fit() {
        let mut seed = 9u64;
        let mut pts: Vec<(f64, f64)> = ring(1.0, 2.0, 0.15, 0.0, 50, 0.0, 360.0).iter().map(|q| (q[0] as f64, q[1] as f64)).collect();
        for _ in 0..15 { pts.push((1.0 + 0.6 * lcg(&mut seed) as f64, 2.2 + 0.4 * lcg(&mut seed) as f64)); }
        let (cx, cy, r, inl) = trimmed_circle(&pts, 0.01).unwrap();
        assert!((cx - 1.0).abs() < 0.01 && (cy - 2.0).abs() < 0.01 && (r - 0.15).abs() < 0.01, "{cx} {cy} {r}");
        assert!(inl.len() >= 50);
    }

    /// Two leaning stems and a pole too thin for a circle.
    fn stand() -> WorkSet {
        let mut p = Vec::new();
        let mut h = 0.2f32;
        while h < 3.0 {
            p.extend(ring(0.0 + 0.1 * h, 0.0, 0.2, h, 40, 0.0, 360.0));
            p.extend(ring(3.0, 1.0 - 0.15 * h, 0.12, h, 30, 0.0, 250.0)); // seen from one side
            h += 0.04;
        }
        let hag = p.iter().map(|q| q[2]).collect();
        WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.03 }
    }

    #[test]
    fn stems_chain_into_seeds_with_their_lean() {
        let ws = stand();
        let member = vec![true; ws.len()];
        let carry = vec![0.0; ws.len()];
        let (seeds, circles) = detect_seeds(&ws, &member, &carry, &StemParams::default());
        assert_eq!(seeds.len(), 2, "{seeds:?}");
        assert!(circles.len() >= 10);
        let a = &seeds[0];
        assert!(a.x.abs() < 0.02 && a.y.abs() < 0.02 && (a.r - 0.2).abs() < 0.02, "{a:?}");
        assert!((a.lean[0] - 0.1).abs() < 0.02 && a.lean[1].abs() < 0.02, "{a:?}");
        let b = &seeds[1];
        assert!((b.x - 3.0).abs() < 0.03 && (b.y - 1.0).abs() < 0.03 && (b.lean[1] + 0.15).abs() < 0.03, "{b:?}");
        assert_eq!((a.id, b.id), (1, 2));
        assert_eq!(a.source, "circle");
    }

    #[test]
    fn a_stem_without_a_circle_seeds_from_the_flow() {
        let mut ws = stand();
        let n0 = ws.len();
        // a thin pole: a few points per slice, no circle
        for k in 0..20 { ws.p.push([6.0, 6.0, 0.2 + k as f32 * 0.05]); ws.hag.push(0.2 + k as f32 * 0.05); ws.n.push(1); }
        let member = vec![true; ws.len()];
        let mut carry = vec![0.0; ws.len()];
        for c in carry[n0..].iter_mut() { *c = 100.0; }
        let (seeds, _) = detect_seeds(&ws, &member, &carry, &StemParams::default());
        assert_eq!(seeds.len(), 3);
        // where every stem is seen round, it takes more
        let mls = StemParams { flow_carry: MLS_FLOW_CARRY, ..StemParams::default() };
        assert_eq!(detect_seeds(&ws, &member, &carry, &mls).0.len(), 2, "too little carried for a stem");
        let pole = seeds.iter().find(|s| s.source == "flow").unwrap();
        assert!((pole.x - 6.0).abs() < 0.01 && pole.r == 0.0);
    }

    #[test]
    fn a_thin_stem_inside_a_ring_of_twigs_is_measured_as_itself() {
        // a stem 9 cm across; around it, 15 cm out, the twigs a 5 cm voxel
        // circle took for the stem
        let mut seed = 4u64;
        let mut pts: Vec<(f64, f64)> = ring(2.0, 3.0, 0.045, 0.0, 60, 0.0, 360.0).iter().map(|q| (q[0] as f64, q[1] as f64)).collect();
        for k in 0..18 {
            let a = k as f64 / 18.0 * std::f64::consts::TAU;
            let r = 0.15 + 0.04 * (lcg(&mut seed) as f64 - 0.5);
            pts.push((2.0 + r * a.cos(), 3.0 + r * a.sin()));
        }
        let s = Seed { id: 1, tree: 1, x: 2.01, y: 3.0, z: 0.0, r: 0.15, lean: [0.0; 2], top: 2.2, circles: 3, source: "circle".into() };
        let (cx, cy, r) = refine_at_breast_height(&s, &pts).unwrap();
        assert!((r - 0.045).abs() < 0.004 && (cx - 2.0).abs() < 0.005 && (cy - 3.0).abs() < 0.005, "{cx} {cy} {r}");
        // a few strays are no stem
        assert!(refine_at_breast_height(&s, &pts[60..66]).is_none());
        // nor is a circle on someone else's stem a metre away
        let other: Vec<(f64, f64)> = ring(3.0, 3.0, 0.1, 0.0, 60, 0.0, 360.0).iter().map(|q| (q[0] as f64, q[1] as f64)).collect();
        assert!(refine_at_breast_height(&s, &other).is_none());
    }
}
