//! Wood or leaf, point by point.
//!
//! Two kinds of evidence:
//!
//! * **Shape.** Wood is structured — a branch is a line, a stem a surface —
//!   at its own scale; foliage is a scatter at every scale past a single
//!   leaf. The share of a neighbourhood's spread across its flattest
//!   direction, σ = λ2 / (λ0 + λ1 + λ2), is ~0 for a line or a surface and
//!   ~0.2 for a scatter; the smaller of it over the 24 and the 48 nearest
//!   (one search) — a stem's curved surface reads flat at the finer, a
//!   branch thicker than the finer is long reads as a line at the coarser —
//!   mapped from `sigma_leaf` (0) to `sigma_wood` (1) is the shape
//!   likelihood. Measured on synthetic stems, branches and foliage at 4 cm:
//!   wood ≤ 0.05, foliage ≥ 0.13 (anisotropy and linearity / planarity
//!   overlap there: a handful of scattered points looks structured). Where the scanner recorded reflectance, bark
//!   returns more than leaves at the near-infrared wavelengths of TLS, and
//!   it can be blended in.
//! * **What a point carries.** Over the shortest-path tree from the ground,
//!   a point on a stem or a branch has everything above it routed through;
//!   a leaf has only itself. The carried amount is counted in cells of
//!   `carry_cell` metres (each node weighs 1 / the nodes in its cell), so it
//!   reads the same whatever the scanner's density.
//!
//! The mask is hysteresis: strong evidence seeds wood, weaker shape evidence
//! joins it where connected, small isolated pieces with nothing carried go
//! back to leaf.

use rayon::prelude::*;
use rustc_hash::FxHashMap;

use super::eigen::{covariance, eigenvalues};
use super::graph::{components, dijkstra, subtree_sum, Csr, Sssp, StepCost, NONE};
use super::WorkSet;
use crate::commands::kdtree::KdTree3;

#[derive(Clone, Debug)]
pub struct WoodParams {
    /// Neighbours of the small and the large shape scale.
    pub k_small: usize,
    pub k_large: usize,
    /// Scatter λ2 / (λ0 + λ1 + λ2) that is surely wood, and surely foliage.
    pub sigma_wood: f64,
    pub sigma_leaf: f64,
    /// Weight of the reflectance in the likelihood, 0 … 1 (0 without it).
    pub refl_weight: f32,
    /// The cell the carried amount is counted in, metres.
    pub carry_cell: f32,
    /// Carried cells that make a point skeleton.
    pub skeleton_carry: f32,
    /// Likelihood that is wood on its own, and that joins wood it touches.
    pub strong: f32,
    pub weak: f32,
    /// Shape a skeleton point needs at least. 0 by default: a thin stem
    /// or a twig inside foliage reads as a scatter at the shape scales, and
    /// what it carries is the better witness (on the synthetic stand 88 %
    /// of branch points carry over three cells, 3 % of leaves do).
    pub skeleton_shape: f32,
    /// Shape a skeleton point's close neighbour needs to join it as wood.
    pub surface: f32,
    /// Wood pieces smaller than this (nodes) with no skeleton go back to leaf.
    pub min_piece: u32,
}

impl Default for WoodParams {
    fn default() -> Self {
        WoodParams {
            k_small: 24,
            k_large: 48,
            sigma_wood: 0.05,
            sigma_leaf: 0.15,
            refl_weight: 0.0,
            carry_cell: 0.2,
            skeleton_carry: 3.0,
            strong: 0.88,
            weak: 0.62,
            skeleton_shape: 0.0,
            surface: 0.35,
            min_piece: 25,
        }
    }
}

/// The shape likelihood of every node, blended with reflectance when given.
pub fn likelihood(ws: &WorkSet, tree: &KdTree3, prm: &WoodParams) -> Vec<f32> {
    let ks = prm.k_small.max(4);
    let kl = prm.k_large.max(ks + 2);
    let max_d2 = (ws.voxel * 12.0).powi(2);
    let mut lik: Vec<f32> = (0..ws.len())
        .into_par_iter()
        .map_init(Vec::new, |buf, i| {
            tree.knn(ws.p[i], kl, max_d2, buf);
            // how much of a scatter the neighbourhood is: the share of its
            // spread across its flattest direction, λ2 / (λ0 + λ1 + λ2)
            let sigma = |m: usize| -> Option<f64> {
                if m < 4 { return None; }
                let (c, _, _) = covariance(buf[..m].iter().map(|&(j, _)| ws.p[j as usize]))?;
                let e = eigenvalues(&c);
                let t = e[0] + e[1] + e[2];
                if t <= 1e-14 { return None; }
                Some(e[2] / t)
            };
            // wood is structured at its own scale: the finer one for a
            // stem's curved surface, the coarser for a branch thicker than
            // the finer neighbourhood is long
            let s = match (sigma(ks.min(buf.len())), sigma(buf.len())) {
                (Some(a), Some(b)) if buf.len() >= ks + 2 => a.min(b),
                (Some(a), _) => a + 0.03,
                _ => return 0.0,
            };
            (((prm.sigma_leaf - s) / (prm.sigma_leaf - prm.sigma_wood)) as f32).clamp(0.0, 1.0)
        })
        .collect();
    if let (Some(refl), w) = (&ws.refl, prm.refl_weight) {
        if w > 0.0 && !refl.is_empty() {
            let (lo, hi) = percentiles(refl, 0.1, 0.9);
            let inv = if hi > lo { 1.0 / (hi - lo) } else { 0.0 };
            lik.par_iter_mut().zip(refl.par_iter()).for_each(|(l, &r)| {
                let rn = ((r - lo) * inv).clamp(0.0, 1.0);
                *l = (1.0 - w) * *l + w * rn;
            });
        }
    }
    lik
}

fn percentiles(v: &[f32], a: f32, b: f32) -> (f32, f32) {
    let step = (v.len() / 200_000).max(1);
    let mut s: Vec<f32> = v.iter().step_by(step).copied().filter(|x| x.is_finite()).collect();
    if s.is_empty() { return (0.0, 1.0); }
    s.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    let at = |q: f32| s[((s.len() - 1) as f32 * q).round() as usize];
    (at(a), at(b))
}

/// Shortest paths from the lowest band of every stem and shrub up through
/// the graph (every node within `band` of the lowest height is a source).
pub fn ground_paths(ws: &WorkSet, csr: &Csr, cost: &StepCost, band: f32) -> Sssp {
    dijkstra(csr, &ground_sources(ws, band), |_| true, |a, b, _| cost.cost(&ws.p[a], &ws.p[b]))
}

/// Every node within `band` of the lowest height: where the flow starts.
pub fn ground_sources(ws: &WorkSet, band: f32) -> Vec<(u32, u32)> {
    let low = ws.hag.iter().copied().fold(f32::INFINITY, f32::min);
    let top = low + band;
    (0..ws.len()).filter(|&i| ws.hag[i] <= top).map(|i| (i as u32, 0)).collect()
}

/// What each node carries, in cells of `cell` metres.
pub fn carried(ws: &WorkSet, paths: &Sssp, cell: f32) -> Vec<f32> {
    let inv = 1.0 / cell.max(1e-3);
    let key = |q: &[f32; 3]| ((q[0] * inv).floor() as i32, (q[1] * inv).floor() as i32, (q[2] * inv).floor() as i32);
    let mut count: FxHashMap<(i32, i32, i32), u32> = FxHashMap::default();
    for q in &ws.p { *count.entry(key(q)).or_insert(0) += 1; }
    let w: Vec<f32> = ws.p.iter().map(|q| 1.0 / count[&key(q)] as f32).collect();
    let mut acc = subtree_sum(paths, &w);
    // unreached nodes carry nothing
    for (i, a) in acc.iter_mut().enumerate() { if paths.label[i] == NONE { *a = 0.0; } }
    acc
}

/// Each node's child in the flow that carries most (NONE at a tip): from a
/// stem, the flow's main line up the tree, node by node.
pub fn heaviest_child(paths: &Sssp, carry: &[f32]) -> Vec<u32> {
    let mut up = vec![NONE; carry.len()];
    for (v, &p) in paths.pred.iter().enumerate() {
        if p == NONE { continue; }
        let u = &mut up[p as usize];
        if *u == NONE || carry[v] > carry[*u as usize] { *u = v as u32; }
    }
    up
}

/// Wood (true) or leaf, by hysteresis over the graph.
pub fn wood_mask(ws: &WorkSet, csr: &Csr, lik: &[f32], carry: &[f32], prm: &WoodParams) -> Vec<bool> {
    let n = ws.len();
    let link2 = (ws.voxel * 2.6).powi(2);
    let near = |a: usize, b: usize| {
        let (p, q) = (&ws.p[a], &ws.p[b]);
        (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2) <= link2
    };
    let skeleton: Vec<bool> = (0..n).map(|i| carry[i] >= prm.skeleton_carry && lik[i] >= prm.skeleton_shape).collect();
    let strong: Vec<bool> = (0..n).map(|i| skeleton[i] || lik[i] >= prm.strong).collect();
    // grow strong into weak
    let mut wood = strong.clone();
    let mut stack: Vec<u32> = (0..n as u32).filter(|&i| strong[i as usize]).collect();
    while let Some(u) = stack.pop() {
        for &v in csr.neighbours(u as usize) {
            let v = v as usize;
            if !wood[v] && lik[v] >= prm.weak && near(u as usize, v) {
                wood[v] = true;
                stack.push(v as u32);
            }
        }
    }
    // the skeleton's own surface: its close neighbours that are not scatter
    let close2 = (ws.voxel * 1.6).powi(2);
    for i in 0..n {
        if !skeleton[i] { continue; }
        for &v in csr.neighbours(i) {
            let v = v as usize;
            let (p, q) = (&ws.p[i], &ws.p[v]);
            let d2 = (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2);
            if !wood[v] && lik[v] >= prm.surface && d2 <= close2 { wood[v] = true; }
        }
    }
    // small pieces with nothing carried go back to leaf
    let (comp, sizes) = components(csr, |i| wood[i], near);
    let mut has_skel = vec![false; sizes.len()];
    for i in 0..n { if comp[i] != NONE && skeleton[i] { has_skel[comp[i] as usize] = true; } }
    for i in 0..n {
        let c = comp[i];
        if c != NONE && !has_skel[c as usize] && sizes[c as usize] < prm.min_piece { wood[i] = false; }
    }
    wood
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::forest::graph::knn_graph;
    use crate::commands::forest::lcg;

    /// A stem (a cylinder surface) and a leaf ball beside it.
    fn stem_and_leaves() -> (WorkSet, usize) {
        let mut seed = 5u64;
        let mut p = Vec::new();
        let r = 0.15f32;
        let mut z = 0.0f32;
        while z < 4.0 {
            for a in 0..24 {
                let t = a as f32 / 24.0 * std::f32::consts::TAU;
                p.push([r * t.cos(), r * t.sin(), z]);
            }
            z += 0.04;
        }
        let n_stem = p.len();
        for _ in 0..3000 {
            let (u, v, w) = (lcg(&mut seed) - 0.5, lcg(&mut seed) - 0.5, lcg(&mut seed) - 0.5);
            p.push([1.5 + u * 1.2, v * 1.2, 3.0 + w * 1.2]);
        }
        let hag = p.iter().map(|q| q[2]).collect();
        (WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.04 }, n_stem)
    }

    #[test]
    fn a_stem_is_wood_a_leaf_ball_is_not() {
        let (ws, n_stem) = stem_and_leaves();
        let tree = KdTree3::build(&ws.p);
        let prm = WoodParams::default();
        let lik = likelihood(&ws, &tree, &prm);
        let stem_mean = lik[..n_stem].iter().sum::<f32>() / n_stem as f32;
        let leaf_mean = lik[n_stem..].iter().sum::<f32>() / (ws.len() - n_stem) as f32;
        assert!(stem_mean > 0.85 && leaf_mean < 0.6, "stem {stem_mean} leaf {leaf_mean}");
        let g = knn_graph(&ws.p, &tree, 10, 0.5);
        let cost = StepCost::new(2.0, 10.0);
        let paths = ground_paths(&ws, &g, &cost, 0.2);
        let carry = carried(&ws, &paths, 0.2);
        // the stem carries what is above it; the leaf ball, cut off from
        // the ground, nothing
        let low = (0..n_stem).filter(|&i| (ws.hag[i] - 1.0).abs() < 0.03).map(|i| carry[i]).fold(0.0, f32::max);
        assert!(low > 1.0, "{low}");
        assert!(carry[n_stem..].iter().all(|&c| c == 0.0));
        let wood = wood_mask(&ws, &g, &lik, &carry, &prm);
        let stem_wood = wood[..n_stem].iter().filter(|&&w| w).count() as f32 / n_stem as f32;
        let leaf_wood = wood[n_stem..].iter().filter(|&&w| w).count() as f32 / (ws.len() - n_stem) as f32;
        assert!(stem_wood > 0.97 && leaf_wood < 0.1, "stem {stem_wood} leaf {leaf_wood}");
    }

    #[test]
    fn reflectance_moves_the_likelihood() {
        let (mut ws, n_stem) = stem_and_leaves();
        ws.refl = Some((0..ws.len()).map(|i| if i < n_stem { -3.0 } else { -14.0 }).collect());
        let tree = KdTree3::build(&ws.p);
        let lik = likelihood(&ws, &tree, &WoodParams { refl_weight: 0.5, ..WoodParams::default() });
        let leaf_mean = lik[n_stem..].iter().sum::<f32>() / (ws.len() - n_stem) as f32;
        assert!(leaf_mean < 0.3, "{leaf_mean}");
    }
}

