//! Which tree every point belongs to, from the seeds.
//!
//! 1. Each seed claims its own stem: the nodes around its axis up to its
//!    highest circle (a node two stems could claim goes to the one it sits
//!    closer to the surface of). Those claims are fixed — a neighbouring
//!    tree cannot take them.
//! 2. Wood grows out of the stems over wood alone: one search from every
//!    seed at once, so each wood node takes the seed it is geodesically
//!    nearest to along the wood, upward steps cheap.
//! 3. Foliage — and wood the first search could not reach through wood —
//!    takes the tree of the wood it is nearest to through the foliage: a
//!    second search from every node the first labelled. A leaf goes with
//!    the branch it hangs from, not with the crown it happens to touch.
//! 4. What is still unreached (pieces with no path at all) joins the
//!    nearest labelled node if one is close, else stays unassigned.
//! 5. Each tree's wood splits into its stem and its branches: the main axis
//!    is followed up the first search's path tree, at every fork the child
//!    whose subtree reaches highest (the leader; a heavy low branch must not
//!    take the stem with it); the stem is the wood around that axis (its centre
//!    re-estimated in 25 cm steps from the points), the rest is branch.

use rayon::prelude::*;

use super::graph::{children, dijkstra, dijkstra_from, dijkstra_under, subtree_sum, Csr, StepCost, NONE};
use super::stems::Seed;
use super::{WorkSet, BRANCH, LEAF, STEM};
use crate::commands::kdtree::KdTree3;

#[derive(Clone, Debug)]
pub struct InstanceParams {
    /// Length exponent of a step and the cost of a level step, over wood
    /// and over foliage.
    pub pow: f32,
    pub wood_horizontal: f32,
    pub leaf_horizontal: f32,
    /// Unreached nodes join a labelled one this close, metres.
    pub orphan_radius: f32,
    /// The factor of a step straight down, over wood and over foliage.
    pub wood_down: f32,
    pub leaf_down: f32,
    /// Foliage starts from the wood it touches at this share of that
    /// wood's own distance from its stem (0: wherever the wood is), so a
    /// twig goes with the tree whose wood it is near the nearer that wood
    /// is to its stem.
    pub leaf_from_wood: f32,
    /// One search from the stems over every node, wood and foliage alike,
    /// each step costing its length to `pow` times `angle_per_degree` to
    /// the power of its angle from straight up (at most `angle_cap`).
    pub single_pass: bool,
    pub angle_per_degree: f32,
    pub angle_cap: f32,
    /// Single pass: a step onto a node that carries more of the flow to the
    /// ground than the one it leaves costs (that ratio, at most `climb_cap`)
    /// to the power `climb_pow` times more (0: no such cost). A tree grows
    /// out along its branches, from what carries much to what carries
    /// little; a path that enters a neighbour's branch from its tip climbs
    /// it. Compared with TreeQSM models of the hand-segmented MLS plots,
    /// that is how most branches went to the wrong tree: their real
    /// junction was at the far end, on the neighbour.
    pub climb_pow: f32,
    pub climb_cap: f32,
    /// Single pass: list the branches whose boundary with another tree was
    /// this close to a tie (a node's distance from its own stem over the
    /// other tree's, across an edge; 0: none), for the user to check
    /// (`near_ties`). A branch is what the tree reached through the
    /// weakest step of its path within `tie_reach` metres of the tie, and
    /// is listed when it has at least `tie_min_nodes` nodes.
    pub tie_ratio: f32,
    pub tie_reach: f32,
    pub tie_min_nodes: usize,
    /// …and only when that weakest step costs at least this many times the
    /// median step of the walk: a gap the branch hangs across, not one of
    /// a run of like steps.
    pub tie_gap: f32,
    /// Give a near-tie branch to the other tree when the learned owner
    /// model (`ties::TieModel`) puts it at least this likely (0: never).
    pub tie_move: f32,
    /// Single pass: a step to a node farther, in plan, from the growing
    /// tree's stems than R = `crown_base` + `crown_per_dbh` × its stem's
    /// diameter costs 1 + `crown_k` × (distance / R − 1) times more (0: no
    /// such cost). The reach of a crown as the hand-segmented MLS plots
    /// show it: their trees' points reach some 1.8 m round a 10 cm stem,
    /// 3 m round 20 cm, 5 m round 40 cm (98th percentiles), well inside
    /// R; past it a small tree under a big one is the less likely owner.
    pub crown_k: f32,
    pub crown_base: f32,
    pub crown_per_dbh: f32,
    /// …measured from the stem moved this share of R away from the trees
    /// round it (their stems within 6 m, each pulling by its diameter over
    /// its distance squared; 0: round the stem). On the hand-segmented MLS
    /// plots three crowns in four lean away from their crowded side, their
    /// centres 0.5–1 m (0.13–0.25 R) off the stem; the share that served
    /// them best, 0.7, is more: it narrows the reach towards the neighbours
    /// as much as it moves the crown.
    pub crown_shift: f32,
    /// Single pass: the tops a tree lost to a neighbour go back to it. Each
    /// tree's leader is the flow's main line up from its stem
    /// (`wood::heaviest_child`), as far as it carries at least
    /// `leader_carry` (0: off), keeps rising and stays within 1 m +
    /// `leader_drift` × its height of the stem. Grown again with each tree
    /// climbing its leader at `leader_cost` times a step's price, what a
    /// tree then reaches above its own top that another tree had goes back
    /// to it (`returned_tops`).
    pub leader_carry: f32,
    pub leader_cost: f32,
    pub leader_drift: f32,
}

impl Default for InstanceParams {
    fn default() -> Self {
        // wood steps cost alike in every direction: on the MLS reference
        // plots an upward bias (10× level, 100× down) gave drooping spruce
        // limbs to the saplings under them
        InstanceParams {
            pow: 2.0, wood_horizontal: 1.0, leaf_horizontal: 3.0, orphan_radius: 0.5,
            wood_down: 1.0, leaf_down: 9.0, leaf_from_wood: 0.3,
            single_pass: false, angle_per_degree: 1.012, angle_cap: 100.0,
            climb_pow: 0.0, climb_cap: 1e4,
            tie_ratio: 0.0, tie_reach: 4.0, tie_min_nodes: 25, tie_gap: 4.0, tie_move: 0.0,
            crown_k: 0.0, crown_base: 1.0, crown_per_dbh: 15.0, crown_shift: 0.0,
            leader_carry: 0.0, leader_cost: 0.0, leader_drift: 0.1,
        }
    }
}

/// The trees and the semantic label of every node.
pub struct Trees {
    /// Tree id per node, 0 for none.
    pub label: Vec<u32>,
    /// STEM, BRANCH or LEAF per node.
    pub sem: Vec<u8>,
    /// The branches that were nearly another tree's (`InstanceParams::tie_ratio`).
    pub ties: Vec<TieBranch>,
    /// The tops that go back to the tree that lost them
    /// (`InstanceParams::leader_carry`): (node, tree, the tree that has it in
    /// `label`). Not in `label`: the caller gives them back once the rest is
    /// decided on the trees as grown.
    pub tops: Vec<(u32, u32, u32)>,
}

/// A branch of `tree` whose boundary with `other` was close to a tie in
/// the growth: the nodes `tree` reached through the weakest step of its
/// path near that boundary — where a branch of the other tree, entered from
/// its tip, would hang on it.
#[derive(Clone, Debug, PartialEq)]
pub struct TieBranch {
    pub tree: u32,
    pub other: u32,
    /// The closest the branch came to a tie: its own distance over the
    /// other tree's, across an edge (1: a tie).
    pub ratio: f32,
    pub nodes: Vec<u32>,
    /// The node it hangs from (after the weakest step) and the node of its
    /// closest tie: its two ends.
    pub start: u32,
    pub tie: u32,
}

/// The near ties of a single-pass growth `s` (`step`: its step cost).
fn near_ties<F: Fn(usize, usize, u32) -> f32 + Sync>(ws: &WorkSet, csr: &Csr, s: &super::graph::Sssp, step: F, prm: &InstanceParams) -> Vec<TieBranch> {
    let n = ws.len();
    // every node's closest competitor across an edge: (ratio, its label)
    let best: Vec<(f32, u32)> = (0..n).into_par_iter().map(|x| {
        let a = s.label[x];
        if a == NONE || !(s.dist[x] > 0.0) || !s.dist[x].is_finite() { return (0.0, NONE); }
        let mut b = (0.0f32, NONE);
        for &y in csr.neighbours(x) {
            let y = y as usize;
            let l = s.label[y];
            if l == NONE || l == a || !s.dist[y].is_finite() { continue; }
            let alt = s.dist[y] + step(y, x, l);
            if alt > 0.0 {
                let r = s.dist[x] / alt;
                if r > b.0 { b = (r, l); }
            }
        }
        b
    }).collect();
    let near: Vec<u32> = (0..n as u32).filter(|&x| best[x as usize].0 >= prm.tie_ratio).collect();
    if near.is_empty() { return Vec::new(); }
    // the weakest step of each tie's path, within reach of it: the branch
    // hangs from the node that step arrives at — when it is a gap
    let cut: Vec<u32> = near.par_iter().map(|&x| {
        let mut v = x as usize;
        let mut walked = 0.0f32;
        let mut worst = (-1.0f32, x);
        let mut steps: Vec<f32> = Vec::new();
        loop {
            let p = s.pred[v];
            if p == NONE { break; }
            let p = p as usize;
            let c = s.dist[v] - s.dist[p];
            steps.push(c);
            if c > worst.0 { worst = (c, v as u32); }
            let (a, b) = (ws.p[v], ws.p[p]);
            walked += ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
            v = p;
            if walked > prm.tie_reach { break; }
        }
        if steps.len() < 3 { return NONE; }
        let mid = steps.len() / 2;
        let median = *steps.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)).1;
        if worst.0 < prm.tie_gap * median { NONE } else { worst.1 }
    }).collect();
    let mut is_cut = vec![false; n];
    for &c in &cut { if c != NONE { is_cut[c as usize] = true; } }
    // each node to the nearest branch above it (settled after its parent)
    let mut owner = vec![NONE; n];
    for &v in &s.order {
        let v = v as usize;
        owner[v] = if is_cut[v] { v as u32 } else {
            let p = s.pred[v];
            if p == NONE { NONE } else { owner[p as usize] }
        };
    }
    let mut other: rustc_hash::FxHashMap<u32, (f32, u32, u32)> = rustc_hash::FxHashMap::default();
    for &x in &near {
        let o = owner[x as usize];
        if o == NONE { continue; }
        let (r, l) = best[x as usize];
        let e = other.entry(o).or_insert((r, l, x));
        if r > e.0 { *e = (r, l, x); }
    }
    let mut nodes: rustc_hash::FxHashMap<u32, Vec<u32>> = rustc_hash::FxHashMap::default();
    let mut size: rustc_hash::FxHashMap<u32, usize> = rustc_hash::FxHashMap::default();
    for v in 0..n {
        if s.label[v] != NONE { *size.entry(s.label[v]).or_insert(0) += 1; }
        let o = owner[v];
        if o != NONE && other.contains_key(&o) { nodes.entry(o).or_default().push(v as u32); }
    }
    let mut out: Vec<TieBranch> = nodes.into_iter().filter_map(|(o, list)| {
        let tree = s.label[o as usize];
        let (ratio, b, tie) = other[&o];
        // a branch that is most of its tree is the tree, not a branch
        if list.len() < prm.tie_min_nodes || 2 * list.len() > size.get(&tree).copied().unwrap_or(0) { return None; }
        Some(TieBranch { tree, other: b, ratio, nodes: list, start: o, tie })
    }).collect();
    out.sort_by(|a, b| b.nodes.len().cmp(&a.nodes.len()).then(a.nodes[0].cmp(&b.nodes[0])));
    out
}

/// The nodes each seed claims as its own stem: (node, tree).
pub fn seed_sources(ws: &WorkSet, seeds: &[Seed]) -> Vec<(u32, u32)> {
    if seeds.is_empty() { return Vec::new(); }
    let top = seeds.iter().map(|s| s.top).fold(0.0, f32::max) + 0.3;
    // seeds by 1 m cell of their axis at mid height
    let mut grid: rustc_hash::FxHashMap<(i32, i32), Vec<usize>> = rustc_hash::FxHashMap::default();
    for (k, s) in seeds.iter().enumerate() {
        let (x, y) = s.axis_at(1.0);
        grid.entry(((x.floor()) as i32, (y.floor()) as i32)).or_default().push(k);
    }
    (0..ws.len())
        .into_par_iter()
        .filter_map(|i| {
            let h = ws.hag[i];
            if h > top { return None; }
            let q = ws.p[i];
            let (gx, gy) = ((q[0] as f64).floor() as i32, (q[1] as f64).floor() as i32);
            let mut best: Option<(f64, u32)> = None;
            for dx in -2..=2 {
                for dy in -2..=2 {
                    let Some(ks) = grid.get(&(gx + dx, gy + dy)) else { continue };
                    for &k in ks {
                        let s = &seeds[k];
                        if h > s.top + 0.3 { continue; }
                        let (ax, ay) = s.axis_at(h as f64);
                        let d = ((q[0] as f64 - ax).powi(2) + (q[1] as f64 - ay).powi(2)).sqrt();
                        if d > s.reach() { continue; }
                        let margin = d - s.r;
                        if best.map_or(true, |b| margin < b.0) { best = Some((margin, s.tree)); }
                    }
                }
            }
            best.map(|(_, t)| (i as u32, t))
        })
        .collect()
}

/// Understory out of the trees: a node lower than `height` whose flow
/// (the shortest path down to the ground, `root`) reaches the ground
/// further than `margin` beyond the stem surface of every stem of its
/// tree stands on roots of its own — a shrub or a sapling round the foot
/// of the tree, which the tree's wood grew into where they touch. It is
/// left without a tree. A tree's own low branches reach the ground through
/// its stem. Returns how many nodes were let go.
pub fn drop_rooted_elsewhere(ws: &WorkSet, root: &[u32], label: &mut [u32], seeds: &[Seed], margin: f64, height: f32) -> usize {
    let mut by_tree: rustc_hash::FxHashMap<u32, Vec<&Seed>> = rustc_hash::FxHashMap::default();
    for s in seeds { by_tree.entry(s.tree).or_default().push(s); }
    let drop: Vec<bool> = (0..ws.len())
        .into_par_iter()
        .map(|i| {
            let t = label[i];
            if t == 0 || ws.hag[i] >= height { return false; }
            let r = root[i];
            if r == NONE { return false; }
            let Some(ss) = by_tree.get(&t) else { return false };
            let q = ws.p[r as usize];
            let h = ws.hag[r as usize] as f64;
            !ss.iter().any(|s| {
                let (ax, ay) = s.axis_at(h);
                ((q[0] as f64 - ax).powi(2) + (q[1] as f64 - ay).powi(2)).sqrt() <= s.r + margin
            })
        })
        .collect();
    let mut n = 0;
    for (l, d) in label.iter_mut().zip(drop) { if d { *l = 0; n += 1; } }
    n
}

/// Stems that share their wood low down are one tree: a fork below the
/// slices, a sprout or a low limb read as a stem of its own. From each
/// seed's stem, a walk over wood below `height` (and below the seed's top
/// circle) and within `radius` of its axis; reaching a bigger stem (a
/// larger radius, then more circles) joins the seed to that stem's tree.
/// Returns how many seeds were joined.
pub fn attach_forks(ws: &WorkSet, csr: &Csr, wood: &[bool], seeds: &mut [Seed], radius: f64, height: f32) -> usize {
    if seeds.len() < 2 || radius <= 0.0 { return 0; }
    let sources = seed_sources(ws, seeds);
    let n = ws.len();
    let mut claim = vec![0u32; n];
    let mut by_tree: rustc_hash::FxHashMap<u32, Vec<u32>> = rustc_hash::FxHashMap::default();
    for &(i, t) in &sources { claim[i as usize] = t; by_tree.entry(t).or_default().push(i); }
    // each tree's size: its largest stem
    let mut size: rustc_hash::FxHashMap<u32, (f64, u32, u32)> = rustc_hash::FxHashMap::default();
    for s in seeds.iter() {
        let e = size.entry(s.tree).or_insert((s.r, s.circles, s.id));
        if (s.r, s.circles) > (e.0, e.1) { *e = (s.r, s.circles, e.2.min(s.id)); }
    }
    let bigger = |a: u32, b: u32| -> bool {
        let (sa, sb) = (size[&a], size[&b]);
        sa.0 > sb.0 || (sa.0 == sb.0 && (sa.1 > sb.1 || (sa.1 == sb.1 && sa.2 < sb.2)))
    };
    let link2 = (ws.voxel * 2.6).powi(2);
    let r2 = radius * radius;
    let found: Vec<(u32, u32)> = seeds
        .par_iter()
        .filter_map(|b| {
            let start = by_tree.get(&b.tree)?;
            let cap = b.top.min(height) + 0.15;
            let mut seen: rustc_hash::FxHashSet<u32> = start.iter().copied().collect();
            let mut stack: Vec<u32> = start.iter().copied().filter(|&i| ws.hag[i as usize] <= cap).collect();
            let mut best: Option<u32> = None;
            while let Some(u) = stack.pop() {
                if seen.len() > 200_000 { break; }
                let pu = ws.p[u as usize];
                for &v in csr.neighbours(u as usize) {
                    let vi = v as usize;
                    if !wood[vi] || ws.hag[vi] > cap || seen.contains(&v) { continue; }
                    let q = ws.p[vi];
                    if (q[0] - pu[0]).powi(2) + (q[1] - pu[1]).powi(2) + (q[2] - pu[2]).powi(2) > link2 { continue; }
                    let (ax, ay) = b.axis_at(ws.hag[vi] as f64);
                    if (q[0] as f64 - ax).powi(2) + (q[1] as f64 - ay).powi(2) > r2 { continue; }
                    seen.insert(v);
                    let a = claim[vi];
                    if a != 0 && a != b.tree && bigger(a, b.tree) && best.map_or(true, |c| bigger(a, c)) { best = Some(a); }
                    stack.push(v);
                }
            }
            best.map(|a| (b.tree, a))
        })
        .collect();
    if found.is_empty() { return 0; }
    // every seed to the biggest stem it reaches, through chains
    let mut to: rustc_hash::FxHashMap<u32, u32> = found.into_iter().collect();
    let keys: Vec<u32> = to.keys().copied().collect();
    for k in keys {
        let mut r = to[&k];
        let mut hops = 0;
        while let Some(&nx) = to.get(&r) { if nx == k || hops > 64 { break; } r = nx; hops += 1; }
        to.insert(k, r);
    }
    let mut joined = 0;
    for s in seeds.iter_mut() { if let Some(&r) = to.get(&s.tree) { if r != s.tree { s.tree = r; joined += 1; } } }
    joined
}

/// Each tree's leader (`InstanceParams::leader_carry`): the nodes up the
/// flow's main line (`up`) from the node of its stem claim that carries most,
/// past the claim, as far as the line carries `leader_carry`, keeps rising
/// and stays near the tree's stems. (tree, the claimed node it leaves from,
/// its nodes upward).
fn leaders(ws: &WorkSet, sources: &[(u32, u32)], up: &[u32], carry: &[f32], seeds: &[Seed], prm: &InstanceParams) -> Vec<(u32, u32, Vec<u32>)> {
    let n = ws.len();
    let mut claim = vec![NONE; n];
    let mut start: rustc_hash::FxHashMap<u32, u32> = rustc_hash::FxHashMap::default();
    for &(i, t) in sources {
        claim[i as usize] = t;
        let e = start.entry(t).or_insert(i);
        if carry[i as usize] > carry[*e as usize] || (carry[i as usize] == carry[*e as usize] && i < *e) { *e = i; }
    }
    let mut stems_of: rustc_hash::FxHashMap<u32, Vec<(f64, f64)>> = rustc_hash::FxHashMap::default();
    for s in seeds { stems_of.entry(s.tree).or_default().push((s.x, s.y)); }
    let mut starts: Vec<(u32, u32)> = start.into_iter().collect();
    starts.sort_unstable();
    starts.par_iter().map(|&(t, s)| {
        let stems = stems_of.get(&t).map(|v| v.as_slice()).unwrap_or(&[]);
        let mut line = Vec::new();
        let mut v = s as usize;
        let mut from = s;
        let mut top = ws.hag[v];
        loop {
            let w = up[v];
            if w == NONE { break; }
            let w = w as usize;
            let c = claim[w];
            if carry[w] < prm.leader_carry || (c != NONE && c != t) || ws.hag[w] < top - 0.5 { break; }
            let q = ws.p[w];
            let d = stems.iter().map(|&(x, y)| ((q[0] as f64 - x).powi(2) + (q[1] as f64 - y).powi(2)).sqrt()).fold(f64::INFINITY, f64::min);
            if d > 1.0 + prm.leader_drift as f64 * ws.hag[w] as f64 { break; }
            top = top.max(ws.hag[w]);
            if c == NONE { line.push(w as u32); } else { from = w as u32; }
            v = w;
        }
        (t, from, line)
    }).filter(|l| !l.2.is_empty()).collect()
}

/// The tops a growth up the leaders gave back (`InstanceParams::leader_carry`):
/// the nodes a tree reached in `led` above its top in `grown` (`top`, by
/// tree) that another tree had there, by that tree. A part goes back when its
/// highest node stands nearer the tree's stems than the other tree's, in the
/// top quarter of the other tree's height, and the other tree has nothing
/// higher within about a metre of it — a top beside the other's, not the
/// underside or the flank of its crown — and of it only the nodes nearer the
/// tree's stems. (node, tree, other tree).
fn returned_tops(ws: &WorkSet, grown: &[u32], top: &rustc_hash::FxHashMap<u32, f32>, led: &[u32], seeds: &[Seed]) -> Vec<(u32, u32, u32)> {
    let n = ws.len();
    let mut parts: rustc_hash::FxHashMap<(u32, u32), Vec<u32>> = rustc_hash::FxHashMap::default();
    for v in 0..n {
        let (t, l) = (led[v], grown[v]);
        if t == NONE || l == NONE || t == l || ws.hag[v] <= top.get(&t).copied().unwrap_or(f32::MAX) { continue; }
        parts.entry((t, l)).or_default().push(v as u32);
    }
    if parts.is_empty() { return Vec::new(); }
    // the highest node of each tree that lost a part, by 0.5 m cell
    let cell = |q: &[f32; 3]| ((q[0] / 0.5).floor() as i32, (q[1] / 0.5).floor() as i32);
    let losers: rustc_hash::FxHashSet<u32> = parts.keys().map(|k| k.1).collect();
    let mut high: rustc_hash::FxHashMap<(u32, i32, i32), f32> = rustc_hash::FxHashMap::default();
    for v in 0..n {
        if !losers.contains(&grown[v]) { continue; }
        let (cx, cy) = cell(&ws.p[v]);
        let e = high.entry((grown[v], cx, cy)).or_insert(f32::MIN);
        if ws.hag[v] > *e { *e = ws.hag[v]; }
    }
    let mut stems_of: rustc_hash::FxHashMap<u32, Vec<(f64, f64)>> = rustc_hash::FxHashMap::default();
    for s in seeds { stems_of.entry(s.tree).or_default().push((s.x, s.y)); }
    let off = |t: u32, q: &[f32; 3]| stems_of.get(&t).map_or(f64::INFINITY, |v| {
        v.iter().map(|&(x, y)| ((q[0] as f64 - x).powi(2) + (q[1] as f64 - y).powi(2)).sqrt()).fold(f64::INFINITY, f64::min)
    });
    let mut keys: Vec<(u32, u32)> = parts.keys().copied().collect();
    keys.sort_unstable();
    let mut back = Vec::new();
    for (t, l) in keys {
        let nodes = &parts[&(t, l)];
        let apex = nodes.iter().copied().fold(nodes[0], |a, b| if ws.hag[b as usize] > ws.hag[a as usize] { b } else { a });
        let q = ws.p[apex as usize];
        let h = ws.hag[apex as usize];
        if off(t, &q) >= off(l, &q) || h < 0.75 * top.get(&l).copied().unwrap_or(0.0) { continue; }
        let (cx, cy) = cell(&q);
        let under = (-2..=2).any(|dx| (-2..=2).any(|dy| high.get(&(l, cx + dx, cy + dy)).is_some_and(|&m| m > h)));
        if under { continue; }
        back.extend(nodes.iter().filter(|&&v| off(t, &ws.p[v as usize]) < off(l, &ws.p[v as usize])).map(|&v| (v, t, l)));
    }
    back
}

/// Each tree's crown centre off its stem (`InstanceParams::crown_shift`), by
/// tree id: `share` of its reach R away from the trees round it. The trees
/// round it are the other trees' biggest stems within 6 m, each pulling by
/// its diameter over its distance squared; a tree with none round it stays
/// centred.
fn crown_shifts(seeds: &[Seed], reach_of: &[f64], share: f64) -> Vec<[f64; 2]> {
    let mut shift_of = vec![[0.0f64; 2]; reach_of.len()];
    let mut main: Vec<Option<usize>> = vec![None; reach_of.len()];
    for (k, s) in seeds.iter().enumerate() {
        let t = s.tree as usize;
        if main[t].map_or(true, |m| seeds[m].r < s.r) { main[t] = Some(k); }
    }
    let mains: Vec<usize> = main.iter().flatten().copied().collect();
    for &k in &mains {
        let (s, t) = (&seeds[k], seeds[k].tree as usize);
        let mut c = [0.0f64; 2];
        for &j in &mains {
            if j == k { continue; }
            let (dx, dy) = (seeds[j].x - s.x, seeds[j].y - s.y);
            let d = (dx * dx + dy * dy).sqrt();
            if d > 0.2 && d < 6.0 {
                let w = 2.0 * seeds[j].r.max(0.03) / (d * d * d);
                c[0] += w * dx; c[1] += w * dy;
            }
        }
        let cn = (c[0] * c[0] + c[1] * c[1]).sqrt();
        if cn > 0.0 {
            let len = share * reach_of[t];
            shift_of[t] = [-c[0] * len / cn, -c[1] * len / cn];
        }
    }
    shift_of
}

/// `carry`: what each node carries of the flow to the ground (`wood::carried`;
/// empty when there is none, and then `InstanceParams::climb_pow` is unused);
/// `up`: each node's heaviest child in that flow (`wood::heaviest_child`;
/// empty: no leaders).
pub fn label_trees(ws: &WorkSet, csr: &Csr, wood: &[bool], carry: &[f32], up: &[u32], seeds: &[Seed], prm: &InstanceParams) -> Trees {
    let n = ws.len();
    let sources = seed_sources(ws, seeds);
    let cw = StepCost::with_down(prm.pow, prm.wood_horizontal, prm.wood_down);
    let cl = StepCost::with_down(prm.pow, prm.leaf_horizontal, prm.leaf_down);
    let is_source = {
        let mut v = vec![false; n];
        for &(i, _) in &sources { v[i as usize] = true; }
        v
    };
    // 2. wood from the stems (or, single pass, everything)
    let ca = StepCost::by_angle(prm.pow, prm.angle_per_degree, prm.angle_cap);
    let mut ties = Vec::new();
    let mut tops: Vec<(u32, u32, u32)> = Vec::new();
    let first = if prm.single_pass {
        let climb = prm.climb_pow > 0.0 && carry.len() == n;
        let cap = prm.climb_cap.max(1.0);
        let step = |a: usize, b: usize| -> f32 {
            let c = ca.cost(&ws.p[a], &ws.p[b]);
            if !climb { return c; }
            // nothing carried (unreached by the flow) counts as a little
            let up = ((carry[b] + 1e-3) / (carry[a] + 1e-3)).clamp(1.0, cap);
            if prm.climb_pow == 1.0 { c * up } else { c * up.powf(prm.climb_pow) }
        };
        // each tree's reach round its stems (`crown_k`)
        let max_id = seeds.iter().map(|s| s.tree).max().unwrap_or(0) as usize;
        let mut stems_of: Vec<Vec<usize>> = vec![Vec::new(); max_id + 1];
        let mut reach_of = vec![0.0f64; max_id + 1];
        for (k, s) in seeds.iter().enumerate() {
            stems_of[s.tree as usize].push(k);
            let r = prm.crown_base as f64 + prm.crown_per_dbh as f64 * 2.0 * s.r.max(0.03);
            if r > reach_of[s.tree as usize] { reach_of[s.tree as usize] = r; }
        }
        // …and the crown's centre off the stem, away from the trees round it
        let shift_of = if prm.crown_k > 0.0 && prm.crown_shift > 0.0 {
            crown_shifts(seeds, &reach_of, prm.crown_shift as f64)
        } else { vec![[0.0f64; 2]; max_id + 1] };
        let crown = |b: usize, l: u32| -> f32 {
            if prm.crown_k <= 0.0 { return 1.0; }
            let Some(ks) = stems_of.get(l as usize) else { return 1.0 };
            let h = ws.hag[b] as f64;
            let q = ws.p[b];
            let sh = shift_of[l as usize];
            let mut d = f64::INFINITY;
            for &k in ks {
                let (ax, ay) = seeds[k].axis_at(h);
                let (ax, ay) = (ax + sh[0], ay + sh[1]);
                d = d.min(((q[0] as f64 - ax).powi(2) + (q[1] as f64 - ay).powi(2)).sqrt());
            }
            let r = reach_of[l as usize];
            if !d.is_finite() || r <= 0.0 || d <= r { 1.0 } else { 1.0 + prm.crown_k * (d / r - 1.0) as f32 }
        };
        let cost = |a: usize, b: usize, l: u32| step(a, b) * crown(b, l);
        let grown = dijkstra(csr, &sources, |_| true, cost);
        if prm.tie_ratio > 0.0 { ties = near_ties(ws, csr, &grown, &cost, prm); }
        // …and the tops the trees lost (`leader_carry`): what the trees whose
        // leader rises past their top win from that growth climbing it
        if prm.leader_carry > 0.0 && up.len() == n && carry.len() == n {
            let mut top_of: rustc_hash::FxHashMap<u32, f32> = rustc_hash::FxHashMap::default();
            for v in 0..n {
                if grown.label[v] == NONE { continue; }
                let e = top_of.entry(grown.label[v]).or_insert(f32::MIN);
                if ws.hag[v] > *e { *e = ws.hag[v]; }
            }
            let lines: Vec<(u32, u32, Vec<u32>)> = leaders(ws, &sources, up, carry, seeds, prm).into_iter()
                .filter(|(t, _, line)| line.iter().any(|&v| ws.hag[v as usize] > top_of.get(t).copied().unwrap_or(f32::MAX)))
                .collect();
            let mut lead = vec![NONE; n];
            let (mut src, mut start) = (Vec::new(), Vec::new());
            for (t, from, line) in &lines {
                let mut d = 0.0f32;
                let mut a = *from as usize;
                for &v in line {
                    d += prm.leader_cost * step(a, v as usize);
                    lead[v as usize] = *t;
                    src.push((v, *t));
                    start.push(d);
                    a = v as usize;
                }
            }
            if !src.is_empty() {
                let won = dijkstra_under(csr, &grown.dist, &src, &start, |a, b, l| {
                    if lead[b] == l && up[a] == b as u32 { prm.leader_cost * step(a, b) } else { cost(a, b, l) }
                });
                let led: Vec<u32> = (0..n).map(|v| if won.label[v] != NONE { won.label[v] } else { grown.label[v] }).collect();
                tops = returned_tops(ws, &grown.label, &top_of, &led, seeds);
            }
        }
        grown
    } else {
        dijkstra(csr, &sources, |v| wood[v] || is_source[v], |a, b, _| cw.cost(&ws.p[a], &ws.p[b]))
    };
    // 3. foliage (and unreached wood) from everything labelled — from its
    //    frontier: a labelled node with no unlabelled neighbour has nothing
    //    to give the search (none in a single pass: it reached all it could)
    let second = if prm.single_pass { None } else {
        let src2: Vec<(u32, u32)> = (0..n as u32)
            .filter(|&i| first.label[i as usize] != NONE && csr.neighbours(i as usize).iter().any(|&v| first.label[v as usize] == NONE))
            .map(|i| (i, first.label[i as usize]))
            .collect();
        let start2: Vec<f32> = if prm.leaf_from_wood > 0.0 {
            src2.iter().map(|&(i, _)| prm.leaf_from_wood * first.dist[i as usize]).collect()
        } else { Vec::new() };
        Some(dijkstra_from(csr, &src2, &start2, |v| first.label[v] == NONE, |a, b, _| cl.cost(&ws.p[a], &ws.p[b])))
    };
    let mut label: Vec<u32> = (0..n).map(|i| {
        let l = if first.label[i] != NONE { first.label[i] } else { second.as_ref().map_or(NONE, |s| s.label[i]) };
        if l == NONE { 0 } else { l }
    }).collect();
    // 4. orphans
    let labelled: Vec<u32> = (0..n as u32).filter(|&i| label[i as usize] != 0).collect();
    if !labelled.is_empty() && labelled.len() < n {
        let pts: Vec<[f32; 3]> = labelled.iter().map(|&i| ws.p[i as usize]).collect();
        let kd = KdTree3::build(&pts);
        let r2 = prm.orphan_radius * prm.orphan_radius;
        let fill: Vec<(usize, u32)> = (0..n)
            .into_par_iter()
            .filter(|&i| label[i] == 0)
            .filter_map(|i| kd.nearest(ws.p[i], r2).map(|(j, _)| (i, label[labelled[j as usize] as usize])))
            .collect();
        for (i, l) in fill { label[i] = l; }
    }
    // 5. stem and branches
    let mut sem: Vec<u8> = (0..n).map(|i| if wood[i] { BRANCH } else { LEAF }).collect();
    let carried = subtree_sum(&first, &vec![1.0; n]);
    // how high each node's subtree reaches: the leader reaches the top
    let mut reach: Vec<f32> = ws.hag.clone();
    for &v in first.order.iter().rev() {
        let pv = first.pred[v as usize];
        if pv != NONE && reach[v as usize] > reach[pv as usize] { reach[pv as usize] = reach[v as usize]; }
    }
    let kids = children(&first.pred);
    let max_id = seeds.iter().map(|s| s.tree).max().unwrap_or(0) as usize;
    // the source node of each tree that carries most
    let mut root: Vec<u32> = vec![NONE; max_id + 1];
    for &(i, t) in &sources {
        let r = &mut root[t as usize];
        if *r == NONE || carried[i as usize] > carried[*r as usize] { *r = i; }
    }
    // the wood nodes of each tree
    let mut by_tree: Vec<Vec<u32>> = vec![Vec::new(); max_id + 1];
    for i in 0..n { if wood[i] && (label[i] as usize) <= max_id && label[i] != 0 { by_tree[label[i] as usize].push(i as u32); } }
    let r0_of: Vec<f64> = {
        let mut r = vec![0.0f64; max_id + 1];
        for s in seeds { if s.r > r[s.tree as usize] { r[s.tree as usize] = s.r; } }
        r
    };
    let stems: Vec<Vec<u32>> = (0..=max_id)
        .into_par_iter()
        .map(|t| {
            if root[t] == NONE || by_tree[t].is_empty() { return Vec::new(); }
            // the main axis: up the path tree, at forks the child whose
            // subtree reaches highest (the leader), the heavier on a tie
            let mut path = vec![root[t]];
            let mut u = root[t] as usize;
            loop {
                let next = kids.neighbours(u).iter().copied().filter(|&c| wood[c as usize])
                    .max_by(|&a, &b| {
                        let (a, b) = (a as usize, b as usize);
                        let ra = (reach[a] * 10.0).round();
                        let rb = (reach[b] * 10.0).round();
                        ra.partial_cmp(&rb).unwrap_or(std::cmp::Ordering::Equal)
                            .then(carried[a].partial_cmp(&carried[b]).unwrap_or(std::cmp::Ordering::Equal))
                    });
                match next { Some(c) => { path.push(c); u = c as usize; } None => break }
            }
            let h0 = ws.hag[path[0] as usize];
            let h1 = path.iter().map(|&i| ws.hag[i as usize]).fold(h0, f32::max);
            if h1 - h0 < 0.5 { return Vec::new(); }
            let r0 = if r0_of[t] > 0.0 { r0_of[t] } else { 0.08 };
            let rad = |h: f32| -> f64 { (r0 * (1.0 - ((h - h0) / (h1 - h0 + 1e-3)).clamp(0.0, 1.0) as f64).powf(0.8)).max(0.02) };
            // the axis in 25 cm steps: the path, re-centred on the wood around it
            let step = 0.25f32;
            let steps = (((h1 - h0) / step).ceil() as usize).max(1);
            let mut centre: Vec<Option<(f64, f64)>> = vec![None; steps + 1];
            let mut path_at: Vec<Option<(f64, f64)>> = vec![None; steps + 1];
            for &i in &path {
                let k = (((ws.hag[i as usize] - h0) / step).round() as usize).min(steps);
                if path_at[k].is_none() { path_at[k] = Some((ws.p[i as usize][0] as f64, ws.p[i as usize][1] as f64)); }
            }
            // fill gaps in the path by carrying the last position up
            let mut last = path_at[0];
            for v in path_at.iter_mut() { if v.is_none() { *v = last; } else { last = *v; } }
            let mut sums = vec![(0.0f64, 0.0f64, 0u32); steps + 1];
            for &i in &by_tree[t] {
                let h = ws.hag[i as usize];
                if h < h0 - step || h > h1 + step { continue; }
                let k = (((h - h0) / step).round().max(0.0) as usize).min(steps);
                let Some((px, py)) = path_at[k] else { continue };
                let (x, y) = (ws.p[i as usize][0] as f64, ws.p[i as usize][1] as f64);
                if ((x - px).powi(2) + (y - py).powi(2)).sqrt() <= 2.2 * rad(h) + 0.05 {
                    let s = &mut sums[k]; s.0 += x; s.1 += y; s.2 += 1;
                }
            }
            for k in 0..=steps {
                centre[k] = if sums[k].2 >= 4 { Some((sums[k].0 / sums[k].2 as f64, sums[k].1 / sums[k].2 as f64)) } else { path_at[k] };
            }
            by_tree[t].iter().copied().filter(|&i| {
                let h = ws.hag[i as usize];
                if h > h1 + 0.1 { return false; }
                let k = (((h - h0) / step).round().max(0.0) as usize).min(steps);
                let Some((cx, cy)) = centre[k] else { return false };
                let (x, y) = (ws.p[i as usize][0] as f64, ws.p[i as usize][1] as f64);
                ((x - cx).powi(2) + (y - cy).powi(2)).sqrt() <= 1.3 * rad(h) + 0.03
            }).collect()
        })
        .collect();
    for s in stems { for i in s { sem[i as usize] = STEM; } }
    Trees { label, sem, ties, tops }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::forest::graph::knn_graph;

    #[test]
    fn a_seed_claims_its_stem_and_the_nearer_one_wins() {
        let mut p = Vec::new();
        for k in 0..30 { let h = 0.3 + k as f32 * 0.05; p.push([0.1, 0.0, h]); p.push([0.42, 0.0, h]); }
        let hag = p.iter().map(|q| q[2]).collect();
        let ws = WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.03 };
        let s = |id: u32, x: f64| Seed { id, tree: id, x, y: 0.0, z: 0.0, r: 0.15, lean: [0.0; 2], top: 1.5, circles: 3, source: "circle".into() };
        let src = seed_sources(&ws, &[s(1, 0.0), s(2, 0.55)]);
        for (i, t) in src {
            let x = ws.p[i as usize][0];
            assert_eq!(t, if x < 0.3 { 1 } else { 2 }, "{x}");
            assert!(ws.hag[i as usize] <= 1.8);
        }
    }

    /// Points on a ring round (cx, cy), radius r, every 4 cm of height.
    fn column(p: &mut Vec<[f32; 3]>, cx: f32, cy: f32, r: f32, lean: f32, h0: f32, h1: f32) {
        let mut h = h0;
        while h < h1 {
            let n = ((std::f32::consts::TAU * r / 0.03).ceil() as usize).max(4);
            for a in 0..n {
                let t = a as f32 / n as f32 * std::f32::consts::TAU;
                p.push([cx + lean * h + r * t.cos(), cy + r * t.sin(), h]);
            }
            h += 0.04;
        }
    }

    #[test]
    fn a_fork_is_one_tree_and_a_neighbour_is_not() {
        // stem A; stem B leaning out of A from its foot (a fork); stem C
        // standing 1.4 m away on its own
        let mut p = Vec::new();
        column(&mut p, 0.0, 0.0, 0.15, 0.0, 0.3, 3.0);
        column(&mut p, 0.0, 0.0, 0.06, 0.4, 0.3, 3.0);
        column(&mut p, 1.4, 0.0, 0.08, 0.0, 0.3, 3.0);
        let hag = p.iter().map(|q| q[2]).collect();
        let ws = WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.04 };
        let tree = KdTree3::build(&ws.p);
        let g = knn_graph(&ws.p, &tree, 10, 0.5);
        let wood = vec![true; ws.len()];
        let s = |id: u32, x: f64, r: f64, lean: f64, circles: u32| Seed { id, tree: id, x, y: 0.0, z: 0.0, r, lean: [lean, 0.0], top: 2.2, circles, source: "circle".into() };
        let mut seeds = vec![s(1, 0.0, 0.15, 0.0, 6), s(2, 0.0, 0.06, 0.4, 4), s(3, 1.4, 0.08, 0.0, 6)];
        let joined = attach_forks(&ws, &g, &wood, &mut seeds, 1.0, 1.5);
        assert_eq!(joined, 1);
        assert_eq!(seeds[1].tree, 1, "the fork joins the bigger stem");
        assert_eq!(seeds[2].tree, 3, "the neighbour stays its own tree");
    }

    #[test]
    fn a_shrub_on_its_own_roots_leaves_the_tree_and_a_low_limb_stays() {
        // a stem, a limb out of it at 1 m, and a shrub 2 m away that the
        // stem's tree took
        let mut p = Vec::new();
        column(&mut p, 0.0, 0.0, 0.15, 0.0, 0.3, 4.0);
        let limb0 = p.len();
        for k in 0..20 { p.push([0.16 + k as f32 * 0.04, 0.0, 1.0]); }
        let shrub0 = p.len();
        column(&mut p, 2.0, 0.0, 0.05, 0.0, 0.3, 1.2);
        let hag: Vec<f32> = p.iter().map(|q| q[2]).collect();
        let ws = WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.04 };
        let tree = KdTree3::build(&ws.p);
        let g = knn_graph(&ws.p, &tree, 10, 0.5);
        let cost = StepCost::new(2.0, 10.0);
        let paths = crate::commands::forest::wood::ground_paths(&ws, &g, &cost, 0.3);
        let root = super::super::graph::roots(&paths);
        let mut label = vec![1u32; ws.len()];
        let seed = Seed { id: 1, tree: 1, x: 0.0, y: 0.0, z: 0.0, r: 0.15, lean: [0.0; 2], top: 2.2, circles: 6, source: "circle".into() };
        let n = drop_rooted_elsewhere(&ws, &root, &mut label, &[seed], 1.0, 2.0);
        assert!(label[..shrub0].iter().all(|&l| l == 1), "the stem and its limb stay");
        assert!(label[limb0..shrub0].iter().all(|&l| l == 1));
        assert!(label[shrub0..].iter().all(|&l| l == 0), "the shrub goes");
        assert_eq!(n, ws.len() - shrub0);
    }

    #[test]
    fn a_tree_does_not_climb_a_neighbours_branch_from_its_tip() {
        // stem 1 at x = 0 with a twig at 2 m out to x = 0.6; stem 2 at x = 3
        // with a thick branch at 2 m back to x = 0.76 and a thin twig on its
        // end that touches tree 1's twig. In steps the branch's outer part is
        // nearer stem 1; up the flow it is stem 2's
        let mut p: Vec<[f32; 3]> = Vec::new();
        let mut carry: Vec<f32> = Vec::new();
        for k in 0..50 { p.push([0.0, 0.0, k as f32 * 0.04]); carry.push(2000.0); }
        for k in 0..50 { p.push([3.0, 0.0, k as f32 * 0.04]); carry.push(2000.0); }
        for k in 1..=15 { p.push([k as f32 * 0.04, 0.0, 2.0]); carry.push((16 - k) as f32); }
        let branch0 = p.len();
        for k in 1..=56 { p.push([3.0 - k as f32 * 0.04, 0.0, 2.0]); carry.push(1000.0); }
        let tip0 = p.len();
        for k in 1..=3 { p.push([0.76 - k as f32 * 0.04, 0.0, 2.0]); carry.push((4 - k) as f32); }
        let hag: Vec<f32> = p.iter().map(|q| q[2]).collect();
        let ws = WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.04 };
        let tree = KdTree3::build(&ws.p);
        let g = knn_graph(&ws.p, &tree, 6, 0.1);
        let wood = vec![true; ws.len()];
        let s = |id: u32, x: f64| Seed { id, tree: id, x, y: 0.0, z: 0.0, r: 0.05, lean: [0.0; 2], top: 1.5, circles: 3, source: "circle".into() };
        let mut prm = InstanceParams { single_pass: true, pow: 6.0, angle_per_degree: 1.02, ..InstanceParams::default() };
        let taken = |prm: &InstanceParams| {
            let t = label_trees(&ws, &g, &wood, &carry, &[], &[s(1, 0.0), s(2, 3.0)], prm);
            t.label[branch0..tip0].iter().filter(|&&l| l == 1).count()
        };
        let before = taken(&prm);
        assert!(before >= 10, "by steps alone tree 1 takes the branch's outer part ({before})");
        prm.climb_pow = 1.0;
        assert_eq!(taken(&prm), 0, "climbing the flow, it does not");
    }

    #[test]
    fn a_branch_a_tree_reached_from_its_tip_is_listed_as_a_near_tie() {
        // stem 1 at x = 0 with a twig at 2 m out to x = 0.56; stem 2 at
        // x = 6 with a long branch at 2 m back to x = 0.64, 8 cm past the
        // twig's end. By steps tree 1 is nearer the branch's end and takes
        // it, through that gap — the weakest step of its path there
        let mut p: Vec<[f32; 3]> = Vec::new();
        for k in 0..50 { p.push([0.0, 0.0, k as f32 * 0.04]); }
        for k in 0..50 { p.push([6.0, 0.0, k as f32 * 0.04]); }
        for k in 1..=14 { p.push([k as f32 * 0.04, 0.0, 2.0]); }
        let branch0 = p.len();
        for k in 1..=134 { p.push([6.0 - k as f32 * 0.04, 0.0, 2.0]); }
        let hag: Vec<f32> = p.iter().map(|q| q[2]).collect();
        let ws = WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.04 };
        let tree = KdTree3::build(&ws.p);
        let g = knn_graph(&ws.p, &tree, 6, 0.1);
        let wood = vec![true; ws.len()];
        let s = |id: u32, x: f64| Seed { id, tree: id, x, y: 0.0, z: 0.0, r: 0.05, lean: [0.0; 2], top: 1.5, circles: 3, source: "circle".into() };
        let prm = InstanceParams {
            single_pass: true, pow: 6.0, angle_per_degree: 1.02, tie_ratio: 0.98, tie_min_nodes: 5, ..InstanceParams::default()
        };
        let t = label_trees(&ws, &g, &wood, &[], &[], &[s(1, 0.0), s(2, 6.0)], &prm);
        let taken: Vec<u32> = (branch0..ws.len() as usize).filter(|&i| t.label[i] == 1).map(|i| i as u32).collect();
        assert!(taken.len() >= 10, "tree 1 took {} nodes of tree 2's branch", taken.len());
        assert_eq!(t.ties.len(), 1, "{:?}", t.ties.iter().map(|b| (b.tree, b.other, b.nodes.len())).collect::<Vec<_>>());
        let b = &t.ties[0];
        assert_eq!((b.tree, b.other), (1, 2));
        assert!(b.ratio >= prm.tie_ratio);
        let mut nodes = b.nodes.clone();
        nodes.sort_unstable();
        assert_eq!(nodes, taken, "the branch is what tree 1 took past the gap, all of it and no more");
        // no competitor, no tie
        let alone = label_trees(&ws, &g, &wood, &[], &[], &[s(1, 0.0)], &prm);
        assert!(alone.ties.is_empty());
    }

    #[test]
    fn a_small_tree_does_not_reach_far_into_a_big_trees_crown() {
        // a big stem at x = 0 (40 cm) with a branch at 3 m out to x = 6, and
        // a sapling (6 cm) at x = 5 whose top touches the branch. By steps
        // the sapling takes the branch back to halfway between them, 2.5 m
        // from its stem; a 6 cm stem's crown does not reach that far
        let mut p: Vec<[f32; 3]> = Vec::new();
        for k in 0..75 { p.push([0.0, 0.0, k as f32 * 0.04]); }
        let branch0 = p.len();
        for k in 1..=150 { p.push([k as f32 * 0.04, 0.0, 3.0]); }
        for k in 0..75 { p.push([5.0, 0.0, k as f32 * 0.04]); }
        let hag: Vec<f32> = p.iter().map(|q| q[2]).collect();
        let ws = WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.04 };
        let tree = KdTree3::build(&ws.p);
        let g = knn_graph(&ws.p, &tree, 6, 0.1);
        let wood = vec![true; ws.len()];
        let s = |id: u32, x: f64, y: f64, r: f64| Seed { id, tree: id, x, y, z: 0.0, r, lean: [0.0; 2], top: 1.5, circles: 3, source: "circle".into() };
        let seeds = [s(1, 0.0, 0.0, 0.2), s(2, 5.0, 0.0, 0.03)];
        let mut prm = InstanceParams { single_pass: true, pow: 6.0, angle_per_degree: 1.02, ..InstanceParams::default() };
        let far = |prm: &InstanceParams| {
            let t = label_trees(&ws, &g, &wood, &[], &[], &seeds, prm);
            // the sapling's nodes on the branch well past its reach (the
            // cost grows with the distance past it)
            (branch0..branch0 + 150).filter(|&i| t.label[i] == 2 && (ws.p[i][0] - 5.0).abs() > 1.0 + 15.0 * 0.06 + 0.25).count()
        };
        let before = far(&prm);
        assert!(before >= 5, "by steps alone the sapling reaches far ({before})");
        // a gentle prior (the MLS setting) gives some back; a strong one all
        prm.crown_k = 2.0;
        let after = far(&prm);
        assert!(after < before, "with its reach it takes {after} of those {before}");
        prm.crown_k = 20.0;
        let strong = far(&prm);
        assert!(strong <= 2, "with a strong prior it takes {strong} of those {before}");
    }

    #[test]
    fn a_top_taken_across_a_gap_goes_back_up_the_leader() {
        // stem 1 at x = 0 up to 9 m, unseen from 6.0 to 6.16 m; stem 2 at
        // x = 1.2 up to 6.4 m with a branch at 6.4 m back to x = 0.08, beside
        // stem 1's upper part. By steps tree 2 is nearer that part (the
        // gap costs more than the branch); the flow comes down stem 1
        let mut p: Vec<[f32; 3]> = Vec::new();
        for k in 0..=150 { p.push([0.0, 0.0, k as f32 * 0.04]); }
        let top0 = p.len();
        for k in 0..=71 { p.push([0.0, 0.0, 6.16 + k as f32 * 0.04]); }
        let top1 = p.len();
        for k in 0..=160 { p.push([1.2, 0.0, k as f32 * 0.04]); }
        for k in 1..=28 { p.push([1.2 - k as f32 * 0.04, 0.0, 6.4]); }
        let hag: Vec<f32> = p.iter().map(|q| q[2]).collect();
        let ws = WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.04 };
        let tree = KdTree3::build(&ws.p);
        let g = knn_graph(&ws.p, &tree, 12, 0.5);
        let paths = crate::commands::forest::wood::ground_paths(&ws, &g, &StepCost::new(2.0, 10.0), 0.3);
        let carry = crate::commands::forest::wood::carried(&ws, &paths, 0.2);
        let up = crate::commands::forest::wood::heaviest_child(&paths, &carry);
        let wood = vec![true; ws.len()];
        let s = |id: u32, x: f64| Seed { id, tree: id, x, y: 0.0, z: 0.0, r: 0.05, lean: [0.0; 2], top: 1.5, circles: 3, source: "circle".into() };
        let seeds = [s(1, 0.0), s(2, 1.2)];
        let mut prm = InstanceParams { single_pass: true, pow: 6.0, angle_per_degree: 1.02, ..InstanceParams::default() };
        let kept = |prm: &InstanceParams| {
            let t = label_trees(&ws, &g, &wood, &carry, &up, &seeds, prm);
            let mut label = t.label.clone();
            for &(v, to, from) in &t.tops { assert_eq!(label[v as usize], from); label[v as usize] = to; }
            (label[top0..top1].iter().filter(|&&l| l == 1).count(), label[top1..].iter().filter(|&&l| l == 2).count())
        };
        let (before, _) = kept(&prm);
        assert!(before < 10, "by steps alone tree 2 takes stem 1's top ({before} of {} kept)", top1 - top0);
        prm.leader_carry = 3.0;
        let (after, theirs) = kept(&prm);
        assert_eq!(after, top1 - top0, "up its leader, tree 1 gets its top back");
        assert!(theirs >= 161 + 20, "tree 2 keeps its stem and most of its branch ({theirs})");
    }

    #[test]
    fn a_crown_is_moved_away_from_the_trees_round_it() {
        let s = |id: u32, x: f64, y: f64, r: f64| Seed { id, tree: id, x, y, z: 0.0, r, lean: [0.0; 2], top: 1.5, circles: 3, source: "circle".into() };
        // tree 1 between a big tree 2 close on its east and a small tree 3
        // farther north; tree 4 alone 20 m off; tree 1's second, thinner
        // stem does not count
        let mut seeds = vec![s(1, 0.0, 0.0, 0.1), s(2, 2.0, 0.0, 0.2), s(3, 0.0, 4.0, 0.05), s(4, 20.0, 20.0, 0.1)];
        seeds.push(Seed { id: 5, ..s(1, 0.5, 0.5, 0.04) });
        let reach = vec![0.0, 4.0, 7.0, 2.5, 4.0];
        let sh = crown_shifts(&seeds, &reach, 0.5);
        // away from the pull: mostly west (tree 2), a little south (tree 3)
        let [x, y] = sh[1];
        assert!(((x * x + y * y).sqrt() - 2.0).abs() < 1e-9, "half of R = 4 m: {x}, {y}");
        assert!(x < -1.9 && y < 0.0 && y > -0.3, "{x}, {y}");
        assert_eq!(sh[4], [0.0, 0.0], "a tree with none round it stays centred");
    }

    #[test]
    fn leaves_go_with_the_branch_they_hang_from() {
        // two stems; tree 1's branch reaches over towards tree 2 and ends in
        // a leaf clump that is nearer tree 2's stem than tree 1's
        let mut p: Vec<[f32; 3]> = Vec::new();
        let mut wood = Vec::new();
        for k in 0..100 { p.push([0.0, 0.0, 0.3 + k as f32 * 0.04]); wood.push(true); }
        for k in 0..100 { p.push([3.0, 0.0, 0.3 + k as f32 * 0.04]); wood.push(true); }
        for k in 1..50 { p.push([k as f32 * 0.04, 0.0, 3.0 + k as f32 * 0.01]); wood.push(true); }
        for a in 0..5 { for b in 0..5 { for c in 0..3 {
            p.push([2.3 + a as f32 * 0.04, -0.1 + b as f32 * 0.04, 3.45 + c as f32 * 0.04]); wood.push(false);
        }}}
        let hag: Vec<f32> = p.iter().map(|q| q[2]).collect();
        let ws = WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.04 };
        let tree = KdTree3::build(&ws.p);
        let g = knn_graph(&ws.p, &tree, 10, 0.5);
        let s = |id: u32, x: f64| Seed { id, tree: id, x, y: 0.0, z: 0.0, r: 0.05, lean: [0.0; 2], top: 1.5, circles: 3, source: "circle".into() };
        let t = label_trees(&ws, &g, &wood, &[], &[], &[s(1, 0.0), s(2, 3.0)], &InstanceParams::default());
        assert!(t.label[..100].iter().all(|&l| l == 1));
        assert!(t.label[100..200].iter().all(|&l| l == 2));
        assert!(t.label[200..249].iter().all(|&l| l == 1), "the branch is tree 1's");
        let leaves = &t.label[249..];
        let ones = leaves.iter().filter(|&&l| l == 1).count();
        assert!(ones as f32 / leaves.len() as f32 > 0.9, "{ones} of {}", leaves.len());
        // the stems are stem, the branch is branch, the clump leaf
        assert!(t.sem[10..90].iter().all(|&s| s == STEM));
        assert!(t.sem[230..249].iter().filter(|&&s| s == BRANCH).count() > 10);
        assert!(t.sem[249..].iter().all(|&s| s == LEAF));
    }
}
