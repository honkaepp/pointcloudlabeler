//! Near-tie branches decided by a learned owner model.
//!
//! A near-tie branch (`instance::near_ties`) hangs on its tree by the
//! weakest link of the growth near another tree. Whose it is cannot be read
//! off one cue — compared with the hand-segmented MLS plots, no single
//! feature of the branch or its junctions tells — but together, measured
//! against both trees, they do better: where the branch lies against each
//! stem and each crown's reach, its height in each crown, which way it
//! points from each stem, and how much of each tree is round it.
//! `features` measures those; `TieModel` is a gradient-boosted classifier
//! trained on the plots (`p`: the branch is the other tree's), and
//! `move_ties` gives the branches it is sure of to the other tree.

use rustc_hash::FxHashMap;

use super::instance::TieBranch;
use super::stems::Seed;
use super::WorkSet;

/// The features, in the model's order.
pub const FEATURES: [&str; 22] = [
    "ratio", "dA_R", "dB_R", "d_ratio", "h_rel_A", "h_rel_B", "hA", "hB", "dbhA", "dbhB",
    "cos_axis_radA", "cos_axis_radB", "start_to_A", "tie_to_B", "start_to_B", "tie_to_A",
    "dens_A", "dens_B", "dens_ratio", "zmin", "zmax", "logn",
];

/// What each tree is to the features: its stem, height and crown base.
struct TreeShape {
    stem: Option<usize>,
    height: f32,
    crown_base: f32,
}

fn shapes(ws: &WorkSet, label: &[u32], seeds: &[Seed]) -> FxHashMap<u32, TreeShape> {
    // heights by tree, weighted by points
    let mut hs: FxHashMap<u32, Vec<(f32, u32)>> = FxHashMap::default();
    for i in 0..ws.len() {
        if label[i] != 0 { hs.entry(label[i]).or_default().push((ws.hag[i], ws.n[i])); }
    }
    let pct = |v: &mut Vec<(f32, u32)>, q: f64| -> Option<f32> {
        if v.is_empty() { return None; }
        v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let total: u64 = v.iter().map(|x| x.1 as u64).sum();
        let want = (total as f64 * q).ceil() as u64;
        let mut acc = 0u64;
        for &(h, n) in v.iter() { acc += n as u64; if acc >= want { return Some(h); } }
        v.last().map(|x| x.0)
    };
    let mut out = FxHashMap::default();
    for (t, mut v) in hs {
        let height = pct(&mut v, 0.99).unwrap_or(0.0);
        let mut hi: Vec<(f32, u32)> = v.iter().copied().filter(|x| x.0 > 2.0).collect();
        let crown_base = if hi.len() > 20 { pct(&mut hi, 0.05).unwrap_or(2.0) } else { 2.0 };
        let stem = seeds.iter().enumerate().filter(|(_, s)| s.tree == t)
            .max_by(|a, b| a.1.r.partial_cmp(&b.1.r).unwrap_or(std::cmp::Ordering::Equal)).map(|(k, _)| k);
        out.insert(t, TreeShape { stem, height, crown_base });
    }
    out
}

/// The features of every branch, against its tree and the other.
pub fn features(ws: &WorkSet, label: &[u32], seeds: &[Seed], ties: &[TieBranch]) -> Vec<Option<[f32; 22]>> {
    if ties.is_empty() { return Vec::new(); }
    let shape = shapes(ws, label, seeds);
    // the labelled nodes by 1 m cell, for the trees round a branch
    let cell = |q: [f32; 3]| (q[0].floor() as i32, q[1].floor() as i32, q[2].floor() as i32);
    let mut grid: FxHashMap<(i32, i32, i32), Vec<u32>> = FxHashMap::default();
    for i in 0..ws.len() { if label[i] != 0 { grid.entry(cell(ws.p[i])).or_default().push(i as u32); } }
    let axis = |t: u32, h: f32| -> Option<([f64; 2], f64)> {
        let s = &seeds[shape.get(&t)?.stem?];
        let (x, y) = s.axis_at(h as f64);
        Some(([x, y], 2.0 * s.r.max(0.03)))
    };
    let plan = |a: [f64; 2], q: [f32; 3]| ((q[0] as f64 - a[0]).powi(2) + (q[1] as f64 - a[1]).powi(2)).sqrt();
    ties.iter().map(|b| {
        let (ta, tb) = (b.tree, b.other);
        let (sa, sb) = (shape.get(&ta)?, shape.get(&tb)?);
        let mut c = [0.0f64; 3];
        let (mut w, mut h, mut zmin, mut zmax) = (0.0f64, 0.0f64, f32::MAX, f32::MIN);
        for &i in &b.nodes {
            let (q, m) = (ws.p[i as usize], ws.n[i as usize] as f64);
            for k in 0..3 { c[k] += q[k] as f64 * m; }
            h += ws.hag[i as usize] as f64 * m;
            w += m;
            zmin = zmin.min(ws.hag[i as usize]); zmax = zmax.max(ws.hag[i as usize]);
        }
        if w <= 0.0 { return None; }
        let cf = [(c[0] / w) as f32, (c[1] / w) as f32, (c[2] / w) as f32];
        let hb = (h / w) as f32;
        let (aa, dbha) = axis(ta, hb)?;
        let (ab, dbhb) = axis(tb, hb)?;
        let (ra, rb) = (1.0 + 15.0 * dbha, 1.0 + 15.0 * dbhb);
        let (da, db) = (plan(aa, cf), plan(ab, cf));
        let (st, ti) = (ws.p[b.start as usize], ws.p[b.tie as usize]);
        let (hs, ht) = (ws.hag[b.start as usize], ws.hag[b.tie as usize]);
        let ax = [(ti[0] - st[0]) as f64, (ti[1] - st[1]) as f64];
        let axn = (ax[0] * ax[0] + ax[1] * ax[1]).sqrt().max(1e-6);
        let rad = |a: [f64; 2], d: f64| [(cf[0] as f64 - a[0]) / d.max(1e-6), (cf[1] as f64 - a[1]) / d.max(1e-6)];
        let (rad_a, rad_b) = (rad(aa, da), rad(ab, db));
        let cos = |r: [f64; 2]| (ax[0] * r[0] + ax[1] * r[1]) / axn;
        // the two trees' points within 1 m of the branch's centre
        let (mut na, mut nb) = (0.0f64, 0.0f64);
        let k0 = cell(cf);
        for dx in -1..=1 { for dy in -1..=1 { for dz in -1..=1 {
            let Some(v) = grid.get(&(k0.0 + dx, k0.1 + dy, k0.2 + dz)) else { continue };
            for &i in v {
                let q = ws.p[i as usize];
                if (q[0] - cf[0]).powi(2) + (q[1] - cf[1]).powi(2) + (q[2] - cf[2]).powi(2) > 1.0 { continue; }
                let l = label[i as usize];
                if l == ta { na += ws.n[i as usize] as f64; } else if l == tb { nb += ws.n[i as usize] as f64; }
            }
        }}}
        let at = |t: u32, q: [f32; 3], hq: f32| axis(t, hq).map(|(a, _)| plan(a, q)).unwrap_or(f64::NAN);
        let rel = |s: &TreeShape| ((hb - s.crown_base) / (s.height - s.crown_base).max(0.5)) as f64;
        let f = [
            b.ratio as f64, da / ra, db / rb, (da / ra) / (db / rb).max(1e-6), rel(sa), rel(sb),
            sa.height as f64, sb.height as f64, dbha, dbhb, cos(rad_a), cos(rad_b),
            at(ta, st, hs), at(tb, ti, ht), at(tb, st, hs), at(ta, ti, ht),
            na, nb, (nb + 1.0) / (na + 1.0), zmin as f64, zmax as f64, w.ln(),
        ];
        let mut out = [0.0f32; 22];
        for k in 0..22 { out[k] = f[k] as f32; }
        Some(out)
    }).collect()
}

/// A gradient-boosted classifier (scikit-learn's HistGradientBoosting,
/// exported): p = sigmoid(baseline + the sum of every tree's leaf).
#[derive(serde::Deserialize, Debug, Clone)]
pub struct TieModel {
    pub features: Vec<String>,
    pub baseline: f64,
    pub trees: Vec<Vec<Node>>,
}

/// One node of a tree: a split (feature ≤ threshold goes left; a missing
/// value goes where `missing_left` says) or a leaf with its value. In
/// `tie_model.json` each node is an array of these fields in this order.
#[derive(serde::Deserialize, Debug, Clone)]
pub struct Node {
    pub leaf: bool,
    pub value: f64,
    pub feature: usize,
    pub threshold: f64,
    pub left: usize,
    pub right: usize,
    pub missing_left: bool,
}

impl TieModel {
    pub fn p(&self, x: &[f32]) -> f64 {
        let mut s = self.baseline;
        for t in &self.trees {
            let mut k = 0usize;
            loop {
                let n = &t[k];
                if n.leaf { s += n.value; break; }
                let v = x[n.feature] as f64;
                k = if v.is_nan() { if n.missing_left { n.left } else { n.right } } else if v <= n.threshold { n.left } else { n.right };
            }
        }
        1.0 / (1.0 + (-s).exp())
    }
}

/// The model trained on the hand-segmented MLS plots.
pub fn trained() -> Option<TieModel> {
    serde_json::from_str(include_str!("tie_model.json")).ok()
}

/// Give the branches the model is sure of (`p` at least `threshold`) to the
/// other tree; how many nodes moved. Only nodes still the branch's tree's.
pub fn move_ties(label: &mut [u32], ties: &[TieBranch], p: &[f64], threshold: f64) -> usize {
    let mut moved = 0;
    for (b, &pb) in ties.iter().zip(p) {
        if pb < threshold { continue; }
        for &i in &b.nodes {
            if label[i as usize] == b.tree { label[i as usize] = b.other; moved += 1; }
        }
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_adds_its_trees_leaves_and_squashes_them() {
        // one stump on feature 1 at 0.5, and a single leaf
        let m: TieModel = serde_json::from_str(r#"{
            "features": ["a", "b"], "baseline": -1.0,
            "trees": [
                [ {"leaf": false, "value": 0, "feature": 1, "threshold": 0.5, "left": 1, "right": 2, "missing_left": true},
                  {"leaf": true, "value": -2.0, "feature": 0, "threshold": 0, "left": 0, "right": 0, "missing_left": false},
                  {"leaf": true, "value": 3.0, "feature": 0, "threshold": 0, "left": 0, "right": 0, "missing_left": false} ],
                [ {"leaf": true, "value": 0.5, "feature": 0, "threshold": 0, "left": 0, "right": 0, "missing_left": false} ]
            ]}"#).unwrap();
        let sig = |s: f64| 1.0 / (1.0 + (-s).exp());
        assert!((m.p(&[0.0, 0.2]) - sig(-1.0 - 2.0 + 0.5)).abs() < 1e-12);
        assert!((m.p(&[0.0, 0.9]) - sig(-1.0 + 3.0 + 0.5)).abs() < 1e-12);
        assert!((m.p(&[0.0, f32::NAN]) - sig(-1.0 - 2.0 + 0.5)).abs() < 1e-12, "a missing value goes left here");
    }

    #[test]
    fn only_the_branches_the_model_is_sure_of_move() {
        let b = |tree: u32, other: u32, nodes: Vec<u32>| TieBranch { tree, other, ratio: 0.99, nodes, start: 0, tie: 0 };
        let ties = vec![b(1, 2, vec![0, 1]), b(1, 3, vec![2, 3])];
        let mut label = vec![1, 4, 1, 1];
        let n = move_ties(&mut label, &ties, &[0.9, 0.4], 0.6);
        assert_eq!(n, 1, "node 1 is no longer tree 1's");
        assert_eq!(label, vec![2, 4, 1, 1]);
    }

    #[test]
    fn the_shipped_model_reads_and_names_its_features() {
        let m = trained().expect("tie_model.json parses");
        assert_eq!(m.features, FEATURES.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(m.trees.len(), 300);
        // every split points inside its tree, at a feature there is
        for t in &m.trees {
            for n in t.iter().filter(|n| !n.leaf) {
                assert!(n.feature < FEATURES.len() && n.left < t.len() && n.right < t.len());
            }
        }
        let p = m.p(&[0.99; 22]);
        assert!(p > 0.0 && p < 1.0);
    }
}
