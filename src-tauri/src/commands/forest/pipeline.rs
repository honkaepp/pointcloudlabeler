//! The whole run: `prepare` does the expensive part that depends only on
//! the points (graph, shape, flow, wood/leaf) and can be kept; `segment`
//! does the trees from seeds, detected or the user's, in a fraction of the
//! time — so stems corrected by hand re-cut the stand at once.

use std::time::Instant;

use super::flags::{tree_info, TreeInfo};
use super::graph::{bridge, knn_graph, reachable, roots, Csr, StepCost};
use super::instance::{attach_forks, drop_rooted_elsewhere, label_trees, InstanceParams, TieBranch};
use super::merge::{apply_merges, find_splits, MergeParams, Suggestion};
use super::stems::{detect_seeds, Seed, StemParams};
use super::wood::{carried, ground_paths, ground_sources, heaviest_child, likelihood, wood_mask, WoodParams};
use super::WorkSet;
use crate::commands::kdtree::KdTree3;

#[derive(Clone, Debug)]
pub struct Params {
    /// Neighbours per node in the graph, and the longest edge (m).
    pub k: usize,
    pub max_gap: f32,
    /// Stranded pieces get this much reach (m).
    pub bridge_gap: f32,
    /// Step cost: length exponent and level-step factor.
    pub pow: f32,
    pub horizontal: f32,
    /// The lowest band (m) the flow starts from.
    pub ground_band: f32,
    pub wood: WoodParams,
    pub stems: StemParams,
    pub instance: InstanceParams,
    pub merge: MergeParams,
    /// Trees standing this close to the data's edge are flagged (m).
    pub edge_buffer: f64,
    /// Trees lower than this are understory (m).
    pub understory: f32,
    /// Stems joined through their wood below this height within this
    /// radius are one tree (`instance::attach_forks`); 0: off.
    pub attach_radius: f64,
    pub attach_height: f32,
    /// A node below `rooted_height` whose flow reaches the ground further
    /// than its stem's radius plus `rooted_margin` from the axis of every
    /// stem of its tree stands on its own roots — understory — and is
    /// left without a tree (`instance::drop_rooted_elsewhere`); 0: off.
    pub rooted_margin: f64,
    pub rooted_height: f32,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            k: 10,
            max_gap: 0.5,
            bridge_gap: 1.5,
            pow: 2.0,
            horizontal: 10.0,
            ground_band: 0.3,
            wood: WoodParams::default(),
            stems: StemParams::default(),
            instance: InstanceParams::default(),
            merge: MergeParams::default(),
            edge_buffer: 2.0,
            understory: 2.0,
            attach_radius: 1.0,
            attach_height: 1.5,
            rooted_margin: 1.0,
            rooted_height: 2.0,
        }
    }
}

/// The settings for a scan that went round every stem and every branch
/// (MLS), tuned against the hand-segmented MLS plots: there a gap in the
/// points is a gap between trees, so the trees are grown in one search over
/// every node whose steps cost their length to the 6th power (a path keeps
/// to continuous wood and twigs rather than jumping), with a mild upward
/// preference; a stem without a circle needs more carried before it is one;
/// and growth below 3 m that reaches the ground more than 0.3 m outside its
/// tree's stems is understory; a step that climbs the flow to the ground
/// costs as much more as it climbs, so a tree does not take a neighbour's
/// branch from its tip (field trees' IoU FP05 0.919 -> 0.920, FP07 0.749 ->
/// 0.754, FP08 0.623 -> 0.638; FP08's point accuracy 0.672 -> 0.724). A
/// single TLS position keeps the defaults: its
/// shadows make gaps inside trees, and the 6th power then cuts trees apart.
pub fn for_mls(prm: &mut Params) {
    prm.stems.flow_carry = super::stems::MLS_FLOW_CARRY;
    prm.instance.single_pass = true;
    prm.instance.pow = 6.0;
    prm.instance.angle_per_degree = 1.02;
    prm.instance.climb_pow = 1.0;
    // the reach of a crown by its stem's size (FP05 0.920 -> 0.920, FP07
    // 0.754 -> 0.756, FP08 0.638 -> 0.640; nothing measured got worse)
    prm.instance.crown_k = 2.0;
    // …measured from a centre moved 0.7 R away from the trees round it
    // (FP05 0.9200 -> 0.9192, FP07 0.7562 -> 0.7596, FP08 0.6402 -> 0.6463)
    prm.instance.crown_shift = 0.7;
    // the branches that were nearly another tree's, for the user to check,
    // and those the owner model is sure of moved (`ties`; trained on the
    // three hand-segmented plots as corrected in October 2026: on each plot
    // left out of the training, field trees' IoU FP05 +0.0017, FP07 +0.0046,
    // FP08 +0.0009 at 0.6, the lowest bar none of them lost at)
    prm.instance.tie_ratio = 0.99;
    prm.instance.tie_move = 0.6;
    // a top a neighbour took from the side goes back to the tree whose
    // leader climbs to it (field trees more than 2 m short of their
    // reference 23 -> 14 of 311; field trees' IoU FP05 0.9334 -> 0.9346,
    // FP07 0.7786 -> 0.7822, FP08 0.6765 -> 0.6778)
    prm.instance.leader_carry = 30.0;
    prm.rooted_margin = 0.3;
    prm.rooted_height = 3.0;
}

/// Settings from a flat JSON object of `"section.field": value` (the
/// sections are `wood`, `stems`, `instance` and `merge`; the rest are
/// top-level) — for tuning runs, see `octree::forest` (`FOREST_TUNE`).
pub fn apply_tune(prm: &mut Params, v: &serde_json::Value) -> Result<(), String> {
    let obj = v.as_object().ok_or("FOREST_TUNE: a JSON object of \"section.field\": value")?;
    for (k, val) in obj {
        let f = || val.as_f64().ok_or(format!("FOREST_TUNE {k}: a number"));
        let b = || val.as_bool().ok_or(format!("FOREST_TUNE {k}: true or false"));
        match k.as_str() {
            "k" => prm.k = f()? as usize,
            "max_gap" => prm.max_gap = f()? as f32,
            "bridge_gap" => prm.bridge_gap = f()? as f32,
            "pow" => prm.pow = f()? as f32,
            "horizontal" => prm.horizontal = f()? as f32,
            "ground_band" => prm.ground_band = f()? as f32,
            "attach_radius" => prm.attach_radius = f()?,
            "attach_height" => prm.attach_height = f()? as f32,
            "rooted_margin" => prm.rooted_margin = f()?,
            "rooted_height" => prm.rooted_height = f()? as f32,
            "wood.k_small" => prm.wood.k_small = f()? as usize,
            "wood.k_large" => prm.wood.k_large = f()? as usize,
            "wood.sigma_wood" => prm.wood.sigma_wood = f()?,
            "wood.sigma_leaf" => prm.wood.sigma_leaf = f()?,
            "wood.carry_cell" => prm.wood.carry_cell = f()? as f32,
            "wood.skeleton_carry" => prm.wood.skeleton_carry = f()? as f32,
            "wood.strong" => prm.wood.strong = f()? as f32,
            "wood.weak" => prm.wood.weak = f()? as f32,
            "wood.surface" => prm.wood.surface = f()? as f32,
            "wood.min_piece" => prm.wood.min_piece = f()? as u32,
            "stems.min_pts" => prm.stems.min_pts = f()? as usize,
            "stems.r_min" => prm.stems.r_min = f()?,
            "stems.r_max" => prm.stems.r_max = f()?,
            "stems.flow_carry" => prm.stems.flow_carry = f()? as f32,
            "stems.flow_max_hag" => prm.stems.flow_max_hag = f()? as f32,
            "stems.lone_circle" => prm.stems.lone_circle = b()?,
            "instance.pow" => prm.instance.pow = f()? as f32,
            "instance.wood_horizontal" => prm.instance.wood_horizontal = f()? as f32,
            "instance.leaf_horizontal" => prm.instance.leaf_horizontal = f()? as f32,
            "instance.wood_down" => prm.instance.wood_down = f()? as f32,
            "instance.leaf_down" => prm.instance.leaf_down = f()? as f32,
            "instance.orphan_radius" => prm.instance.orphan_radius = f()? as f32,
            "instance.leaf_from_wood" => prm.instance.leaf_from_wood = f()? as f32,
            "instance.single_pass" => prm.instance.single_pass = b()?,
            "instance.angle_per_degree" => prm.instance.angle_per_degree = f()? as f32,
            "instance.angle_cap" => prm.instance.angle_cap = f()? as f32,
            "instance.climb_pow" => prm.instance.climb_pow = f()? as f32,
            "instance.climb_cap" => prm.instance.climb_cap = f()? as f32,
            "instance.tie_ratio" => prm.instance.tie_ratio = f()? as f32,
            "instance.tie_reach" => prm.instance.tie_reach = f()? as f32,
            "instance.tie_min_nodes" => prm.instance.tie_min_nodes = f()? as usize,
            "instance.tie_gap" => prm.instance.tie_gap = f()? as f32,
            "instance.tie_move" => prm.instance.tie_move = f()? as f32,
            "instance.crown_k" => prm.instance.crown_k = f()? as f32,
            "instance.crown_base" => prm.instance.crown_base = f()? as f32,
            "instance.crown_per_dbh" => prm.instance.crown_per_dbh = f()? as f32,
            "instance.crown_shift" => prm.instance.crown_shift = f()? as f32,
            "instance.leader_carry" => prm.instance.leader_carry = f()? as f32,
            "instance.leader_cost" => prm.instance.leader_cost = f()? as f32,
            "instance.leader_drift" => prm.instance.leader_drift = f()? as f32,
            "merge.from" => prm.merge.from = f()? as f32,
            "merge.to" => prm.merge.to = f()? as f32,
            "merge.min_share" => prm.merge.min_share = f()? as f32,
            "merge.votes" => prm.merge.votes = f()? as u32,
            _ => return Err(format!("FOREST_TUNE: no setting {k}")),
        }
    }
    Ok(())
}

/// What depends only on the points.
pub struct Prepared {
    pub csr: Csr,
    pub lik: Vec<f32>,
    pub carry: Vec<f32>,
    pub wood: Vec<bool>,
    /// Where each node's flow reaches the ground (graph::roots).
    pub root: Vec<u32>,
    /// Each node's child in the flow that carries most (wood::heaviest_child).
    pub up: Vec<u32>,
    pub timings: Vec<(String, f64)>,
}

/// `progress(stage, fraction)` returns false to stop.
pub fn prepare(ws: &WorkSet, prm: &Params, progress: &dyn Fn(&str, f32) -> bool) -> Result<Prepared, String> {
    let mut timings = Vec::new();
    let mut t = Instant::now();
    let mut lap = |name: &str, timings: &mut Vec<(String, f64)>| {
        timings.push((name.to_string(), t.elapsed().as_secs_f64()));
        t = Instant::now();
    };
    let stop = || Err::<Prepared, String>("Stopped — nothing was changed.".into());
    if !progress("graph", 0.0) { return stop(); }
    let tree = KdTree3::build(&ws.p);
    let mut csr = knn_graph(&ws.p, &tree, prm.k, prm.max_gap);
    lap("graph", &mut timings);
    if !progress("shape", 0.2) { return stop(); }
    let lik = likelihood(ws, &tree, &prm.wood);
    lap("shape", &mut timings);
    if !progress("flow", 0.45) { return stop(); }
    let cost = StepCost::new(prm.pow, prm.horizontal);
    // pieces with no path to the ground get a longer reach first (a walk,
    // not a search, finds them), so the one search reaches them
    let src: Vec<u32> = ground_sources(ws, prm.ground_band).into_iter().map(|(i, _)| i).collect();
    let seen = reachable(&csr, &src);
    let stranded: Vec<bool> = seen.iter().map(|&s| !s).collect();
    if stranded.iter().any(|&s| s) {
        csr = bridge(&ws.p, &tree, &csr, &stranded, prm.k * 3, prm.bridge_gap);
    }
    let paths = ground_paths(ws, &csr, &cost, prm.ground_band);
    let carry = carried(ws, &paths, prm.wood.carry_cell);
    let root = roots(&paths);
    let up = heaviest_child(&paths, &carry);
    lap("flow", &mut timings);
    if !progress("wood", 0.65) { return stop(); }
    let wood = wood_mask(ws, &csr, &lik, &carry, &prm.wood);
    lap("wood", &mut timings);
    Ok(Prepared { csr, lik, carry, wood, root, up, timings })
}

/// The trees.
pub struct Outcome {
    /// Tree id per node, 0 for none.
    pub label: Vec<u32>,
    /// STEM, BRANCH or LEAF per node.
    pub sem: Vec<u8>,
    pub seeds: Vec<Seed>,
    /// Pairs joined as one tree (from, into).
    pub merged: Vec<(u32, u32)>,
    pub suggestions: Vec<Suggestion>,
    pub trees: Vec<TreeInfo>,
    /// Branches whose boundary with another tree was nearly a tie, in the
    /// final trees' ids and nodes (`instance::near_ties`); those the owner
    /// model moved to the other tree are listed the other way round.
    pub ties: Vec<TieBranch>,
    /// Each branch's features (`ties::features`), the owner model's belief
    /// that it is the other tree's, and whether it was moved.
    pub tie_features: Vec<Option<[f32; 22]>>,
    pub tie_p: Vec<f64>,
    pub tie_moved: Vec<bool>,
    pub timings: Vec<(String, f64)>,
}

/// The trees from `seeds`, or from the seeds found when there are none. The
/// user's seeds are taken as they are: splits found are only suggested.
pub fn segment(ws: &WorkSet, prep: &Prepared, seeds: Option<Vec<Seed>>, prm: &Params) -> Outcome {
    let mut timings = Vec::new();
    let t = Instant::now();
    let given = seeds.is_some();
    let mut seeds = match seeds {
        Some(s) => s,
        None => {
            let mut s = detect_seeds(ws, &prep.wood, &prep.carry, &prm.stems).0;
            attach_forks(ws, &prep.csr, &prep.wood, &mut s, prm.attach_radius, prm.attach_height);
            s
        }
    };
    timings.push(("stems".to_string(), t.elapsed().as_secs_f64()));
    let t = Instant::now();
    let trees = label_trees(ws, &prep.csr, &prep.wood, &prep.carry, &prep.up, &seeds, &prm.instance);
    let mut label = trees.label;
    timings.push(("trees".to_string(), t.elapsed().as_secs_f64()));
    let t = Instant::now();
    let (merges, mut suggestions) = find_splits(ws, &prep.wood, &label, &prm.merge, &prm.stems);
    let mut merged = Vec::new();
    if given {
        // the user drew these stems: offer, do not decide
        for (a, b) in merges {
            suggestions.push(Suggestion { a, b, votes: prm.merge.votes, x: 0.0, y: 0.0, z: 0.0 });
        }
    } else {
        let map = apply_merges(&mut label, &merges);
        for s in seeds.iter_mut() { if let Some(&to) = map.get(&s.tree) { merged.push((s.tree, to)); s.tree = to; } }
    }
    if prm.rooted_margin > 0.0 {
        drop_rooted_elsewhere(ws, &prep.root, &mut label, &seeds, prm.rooted_margin, prm.rooted_height);
    }
    timings.push(("merge".to_string(), t.elapsed().as_secs_f64()));
    // the near ties in the trees as they ended: through the merges, and
    // only the nodes still the branch's tree's
    let into: rustc_hash::FxHashMap<u32, u32> = merged.iter().copied().collect();
    let to = |t: u32| into.get(&t).copied().unwrap_or(t);
    let mut ties: Vec<TieBranch> = trees.ties.into_iter().filter_map(|b| {
        let (a, o) = (to(b.tree), to(b.other));
        if a == o { return None; }
        let nodes: Vec<u32> = b.nodes.into_iter().filter(|&i| label[i as usize] == a).collect();
        if nodes.len() < prm.instance.tie_min_nodes { return None; }
        Some(TieBranch { tree: a, other: o, ratio: b.ratio, nodes, start: b.start, tie: b.tie })
    }).collect();
    // the owner model on each, and the branches it is sure of moved
    let t = Instant::now();
    let tie_features = super::ties::features(ws, &label, &seeds, &ties);
    let model = super::ties::trained();
    let tie_p: Vec<f64> = tie_features.iter().map(|f| match (f, &model) { (Some(x), Some(m)) => m.p(x), _ => 0.0 }).collect();
    let tie_moved: Vec<bool> = tie_p.iter().map(|&p| prm.instance.tie_move > 0.0 && p >= prm.instance.tie_move as f64).collect();
    if prm.instance.tie_move > 0.0 {
        super::ties::move_ties(&mut label, &ties, &tie_p, prm.instance.tie_move as f64);
        for (b, &m) in ties.iter_mut().zip(&tie_moved) { if m { std::mem::swap(&mut b.tree, &mut b.other); } }
    }
    timings.push(("ties".to_string(), t.elapsed().as_secs_f64()));
    // the tops that go back to the trees that lost them, now that the owner
    // model has seen the trees as grown (it was trained on them so); a node
    // something since gave elsewhere stays
    for &(v, t, f) in &trees.tops {
        if label[v as usize] == to(f) { label[v as usize] = to(t); }
    }
    let info = tree_info(ws, &label, &seeds, prm.edge_buffer, prm.understory);
    Outcome { label, sem: trees.sem, seeds, merged, suggestions, trees: info, ties, tie_features, tie_p, tie_moved, timings }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::forest::{lcg, BRANCH, LEAF, STEM};

    /// What each synthetic point is.
    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Kind { Stem, Branch, Leaf }

    /// A small stand: four trees, one leaning, crowns that interlock.
    fn stand() -> (WorkSet, Vec<u32>, Vec<Kind>) {
        let mut seed = 21u64;
        let trees: [(f32, f32, f32, f32, f32); 4] = [
            (0.0, 0.0, 0.18, 14.0, 0.0),
            (3.4, 0.6, 0.15, 12.0, 0.0),
            (1.4, 3.2, 0.2, 15.0, 0.0),
            (5.6, 3.8, 0.12, 11.0, 0.12),
        ];
        let (mut p, mut truth, mut kind) = (Vec::new(), Vec::new(), Vec::new());
        for (t, &(x0, y0, r0, height, lean)) in trees.iter().enumerate() {
            let id = t as u32 + 1;
            let mut h = 0.3f32;
            while h < height {
                let r = (r0 * (1.0 - h / height)).max(0.025);
                let (cx, cy) = (x0 + lean * h, y0);
                let n = ((std::f32::consts::TAU * r / 0.04).ceil() as usize).max(6);
                for a in 0..n {
                    let ang = a as f32 / n as f32 * std::f32::consts::TAU + h;
                    p.push([cx + r * ang.cos(), cy + r * ang.sin(), h]);
                    truth.push(id);
                    kind.push(Kind::Stem);
                }
                h += 0.04;
            }
            let mut bh = height * 0.4;
            while bh < height - 0.5 {
                for _ in 0..3 {
                    let az = lcg(&mut seed) * std::f32::consts::TAU;
                    let len = 1.2 + 1.3 * lcg(&mut seed) * (1.0 - bh / height + 0.3);
                    let (bx, by) = (x0 + lean * bh, y0);
                    let steps = (len / 0.04) as usize;
                    for s in 1..steps {
                        let d = s as f32 * 0.04;
                        let q = [bx + d * 0.87 * az.cos(), by + d * 0.87 * az.sin(), bh + d * 0.5];
                        p.push(q);
                        truth.push(id);
                        kind.push(Kind::Branch);
                        // leaves on the outer half
                        if d > len * 0.5 && s % 4 == 0 {
                            for _ in 0..14 {
                                let (u, v, w) = (lcg(&mut seed) - 0.5, lcg(&mut seed) - 0.5, lcg(&mut seed) - 0.5);
                                p.push([q[0] + u * 0.35, q[1] + v * 0.35, q[2] + w * 0.35]);
                                truth.push(id);
                                kind.push(Kind::Leaf);
                            }
                        }
                    }
                }
                bh += 0.9;
            }
        }
        let hag = p.iter().map(|q| q[2]).collect();
        (WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.04 }, truth, kind)
    }

    #[test]
    fn a_synthetic_stand_comes_apart_tree_by_tree() {
        let (ws, truth, kind) = stand();
        let prm = Params::default();
        let prep = prepare(&ws, &prm, &|_, _| true).unwrap();
        let out = segment(&ws, &prep, None, &prm);
        assert_eq!(out.seeds.len(), 4, "{:?}", out.seeds);
        assert!(out.seeds.iter().all(|s| s.source == "circle"));
        // the trees found map one to one onto the true ones
        let mut map = std::collections::HashMap::new();
        for s in &out.seeds {
            let t = (0..ws.len())
                .filter(|&i| out.label[i] == s.tree && kind[i] == Kind::Stem)
                .map(|i| truth[i])
                .fold(std::collections::HashMap::new(), |mut m, t| { *m.entry(t).or_insert(0u32) += 1; m })
                .into_iter().max_by_key(|&(_, c)| c).map(|(t, _)| t).unwrap();
            map.insert(s.tree, t);
        }
        let acc = |k: Kind| {
            let idx: Vec<usize> = (0..ws.len()).filter(|&i| kind[i] == k).collect();
            idx.iter().filter(|&&i| map.get(&out.label[i]) == Some(&truth[i])).count() as f32 / idx.len() as f32
        };
        let (a_stem, a_branch, a_leaf) = (acc(Kind::Stem), acc(Kind::Branch), acc(Kind::Leaf));
        assert!(a_stem > 0.99 && a_branch > 0.95 && a_leaf > 0.9, "stem {a_stem} branch {a_branch} leaf {a_leaf}");
        let sem_ok = |k: Kind, want: &[u8]| {
            let idx: Vec<usize> = (0..ws.len()).filter(|&i| kind[i] == k).collect();
            idx.iter().filter(|&&i| want.contains(&out.sem[i])).count() as f32 / idx.len() as f32
        };
        let (s_stem, s_wood, s_leaf) = (sem_ok(Kind::Stem, &[STEM]), sem_ok(Kind::Branch, &[STEM, BRANCH]), sem_ok(Kind::Leaf, &[LEAF]));
        if std::env::var("FOREST_PROBE").is_ok() {
            let frac = |f: &dyn Fn(usize) -> bool, g: &dyn Fn(usize) -> bool| { let idx: Vec<usize> = (0..ws.len()).filter(|&i| f(i)).collect(); (idx.iter().filter(|&&i| g(i)).count() as f32 / idx.len().max(1) as f32, idx.len()) };
            println!("stem wood {:?}", frac(&|i| kind[i] == Kind::Stem, &|i| prep.wood[i]));
            println!("branch wood {:?}", frac(&|i| kind[i] == Kind::Branch, &|i| prep.wood[i]));
            println!("leaf wood {:?}", frac(&|i| kind[i] == Kind::Leaf, &|i| prep.wood[i]));
            println!("branch lik>.62 {:?}", frac(&|i| kind[i] == Kind::Branch, &|i| prep.lik[i] > 0.62));
            println!("branch carry>3 {:?}", frac(&|i| kind[i] == Kind::Branch, &|i| prep.carry[i] > 3.0));
            println!("leaf carry>3 {:?}", frac(&|i| kind[i] == Kind::Leaf, &|i| prep.carry[i] > 3.0));
            for band in 0..8 { let lo = band as f32 * 2.0; println!("stem {lo}-{} wood {:?} STEM {:?}", lo + 2.0, frac(&|i| kind[i] == Kind::Stem && ws.hag[i] >= lo && ws.hag[i] < lo + 2.0, &|i| prep.wood[i]), frac(&|i| kind[i] == Kind::Stem && ws.hag[i] >= lo && ws.hag[i] < lo + 2.0, &|i| out.sem[i] == STEM)); }
        }
        assert!(s_stem > 0.85 && s_wood > 0.8 && s_leaf > 0.8, "stem {s_stem} wood {s_wood} leaf {s_leaf}");
        assert_eq!(out.trees.len(), 4);
        assert!(out.trees.iter().all(|t| !t.flags.contains(&"understory".to_string())));
        // re-cutting with the seeds as found gives the same trees
        let again = segment(&ws, &prep, Some(out.seeds.clone()), &prm);
        assert_eq!(again.label, out.label);
    }

    #[test]
    fn the_mls_settings_take_the_stand_apart_too() {
        let (ws, truth, kind) = stand();
        let mut prm = Params::default();
        for_mls(&mut prm);
        let prep = prepare(&ws, &prm, &|_, _| true).unwrap();
        let out = segment(&ws, &prep, None, &prm);
        assert_eq!(out.seeds.len(), 4, "{:?}", out.seeds);
        let mut map = std::collections::HashMap::new();
        for s in &out.seeds {
            let t = (0..ws.len())
                .filter(|&i| out.label[i] == s.tree && kind[i] == Kind::Stem)
                .map(|i| truth[i])
                .fold(std::collections::HashMap::new(), |mut m, t| { *m.entry(t).or_insert(0u32) += 1; m })
                .into_iter().max_by_key(|&(_, c)| c).map(|(t, _)| t).unwrap();
            map.insert(s.tree, t);
        }
        let acc = |k: Kind| {
            let idx: Vec<usize> = (0..ws.len()).filter(|&i| kind[i] == k).collect();
            idx.iter().filter(|&&i| map.get(&out.label[i]) == Some(&truth[i])).count() as f32 / idx.len() as f32
        };
        let (a_stem, a_branch, a_leaf) = (acc(Kind::Stem), acc(Kind::Branch), acc(Kind::Leaf));
        assert!(a_stem > 0.99 && a_branch > 0.95 && a_leaf > 0.9, "stem {a_stem} branch {a_branch} leaf {a_leaf}");
    }
}
