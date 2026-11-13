//! What each tree is, and what to be careful with: where it stands, how
//! tall it is, and flags — never deletions.
//!
//! * `edge`: it stands within `edge_buffer` of the edge of the data (the
//!   convex hull of the working set in plan view), where the scan saw it
//!   from one side and its crown runs out of the data;
//! * `understory`: it does not reach `understory` metres above ground;
//! * `noStemFit`: its stem gave no circle (seeded from the flow skeleton or
//!   by hand), so its position and diameter are less certain.

use serde::Serialize;

use super::stems::Seed;
use super::WorkSet;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeInfo {
    pub tree: u32,
    /// Working-set coordinates of the stem base.
    pub x: f64,
    pub y: f64,
    pub z: f64,
    /// Highest point above ground, metres.
    pub height: f32,
    /// Stem radius from its circles, 0 when unknown.
    pub r: f64,
    /// Working-set nodes (voxels).
    pub nodes: u32,
    pub flags: Vec<String>,
}

/// The convex hull (Andrew's monotone chain), counter-clockwise.
pub fn convex_hull(pts: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut p: Vec<(f64, f64)> = pts.to_vec();
    p.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    p.dedup();
    if p.len() < 3 { return p; }
    let cross = |o: (f64, f64), a: (f64, f64), b: (f64, f64)| (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0);
    let mut h: Vec<(f64, f64)> = Vec::with_capacity(p.len() * 2);
    for &q in &p {
        while h.len() >= 2 && cross(h[h.len() - 2], h[h.len() - 1], q) <= 0.0 { h.pop(); }
        h.push(q);
    }
    let lower = h.len() + 1;
    for &q in p.iter().rev().skip(1) {
        while h.len() >= lower && cross(h[h.len() - 2], h[h.len() - 1], q) <= 0.0 { h.pop(); }
        h.push(q);
    }
    h.pop();
    h
}

/// Distance from `q` to the hull's boundary, positive inside, negative out.
pub fn inside_distance(hull: &[(f64, f64)], q: (f64, f64)) -> f64 {
    if hull.len() < 3 { return f64::NEG_INFINITY; }
    let mut best = f64::INFINITY;
    let mut inside = true;
    for i in 0..hull.len() {
        let a = hull[i];
        let b = hull[(i + 1) % hull.len()];
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len2 = dx * dx + dy * dy;
        let t = if len2 > 0.0 { (((q.0 - a.0) * dx + (q.1 - a.1) * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
        let d = ((q.0 - a.0 - t * dx).powi(2) + (q.1 - a.1 - t * dy).powi(2)).sqrt();
        best = best.min(d);
        if dx * (q.1 - a.1) - dy * (q.0 - a.0) < 0.0 { inside = false; }
    }
    if inside { best } else { -best }
}

pub fn tree_info(ws: &WorkSet, label: &[u32], seeds: &[Seed], edge_buffer: f64, understory: f32) -> Vec<TreeInfo> {
    let max_id = label.iter().copied().max().unwrap_or(0) as usize;
    let mut height = vec![0.0f32; max_id + 1];
    let mut nodes = vec![0u32; max_id + 1];
    for (i, &l) in label.iter().enumerate() {
        if l == 0 { continue; }
        nodes[l as usize] += 1;
        height[l as usize] = height[l as usize].max(ws.hag[i]);
    }
    // the hull of the data, from a thinned plan view
    let step = (ws.len() / 200_000).max(1);
    let plan: Vec<(f64, f64)> = ws.p.iter().step_by(step).map(|q| (q[0] as f64, q[1] as f64)).collect();
    let hull = convex_hull(&plan);
    let mut out = Vec::new();
    for t in 1..=max_id {
        if nodes[t] == 0 { continue; }
        let mine: Vec<&Seed> = seeds.iter().filter(|s| s.tree as usize == t).collect();
        let Some(s) = mine.iter().max_by(|a, b| a.r.partial_cmp(&b.r).unwrap_or(std::cmp::Ordering::Equal)) else { continue };
        let mut flags = Vec::new();
        if inside_distance(&hull, (s.x, s.y)) < edge_buffer { flags.push("edge".to_string()); }
        if height[t] < understory { flags.push("understory".to_string()); }
        if mine.iter().all(|s| s.circles == 0) { flags.push("noStemFit".to_string()); }
        out.push(TreeInfo { tree: t as u32, x: s.x, y: s.y, z: s.z, height: height[t], r: s.r, nodes: nodes[t], flags });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hull_and_how_far_inside() {
        let pts = vec![(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (5.0, 5.0), (2.0, 8.0)];
        let h = convex_hull(&pts);
        assert_eq!(h.len(), 4);
        assert!((inside_distance(&h, (5.0, 5.0)) - 5.0).abs() < 1e-9);
        assert!((inside_distance(&h, (1.0, 5.0)) - 1.0).abs() < 1e-9);
        assert!((inside_distance(&h, (-2.0, 5.0)) + 2.0).abs() < 1e-9);
    }

    #[test]
    fn edge_understory_and_no_fit() {
        let mut p = Vec::new();
        let mut label = Vec::new();
        for x in 0..21 { for y in 0..21 { p.push([x as f32, y as f32, 0.5]); label.push(0); } }
        p.push([10.0, 10.0, 15.0]); label.push(1);
        p.push([0.5, 10.0, 12.0]); label.push(2);
        p.push([15.0, 15.0, 1.2]); label.push(3);
        let hag = p.iter().map(|q| q[2]).collect();
        let ws = WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.04 };
        let s = |t: u32, x: f64, y: f64, c: u32| Seed { id: t, tree: t, x, y, z: 0.0, r: 0.1, lean: [0.0; 2], top: 2.0, circles: c, source: "circle".into() };
        let info = tree_info(&ws, &label, &[s(1, 10.0, 10.0, 4), s(2, 0.5, 10.0, 3), s(3, 15.0, 15.0, 0)], 2.0, 2.0);
        assert_eq!(info.len(), 3);
        assert!(info[0].flags.is_empty());
        assert_eq!(info[1].flags, vec!["edge"]);
        assert_eq!(info[2].flags, vec!["understory", "noStemFit"]);
        assert_eq!(info[0].height, 15.0);
    }
}
