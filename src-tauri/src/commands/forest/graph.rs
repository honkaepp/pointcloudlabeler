//! The neighbourhood graph of the working set and shortest paths over it.
//!
//! * `knn_graph`: i—j when either is among the other's k nearest and the
//!   two are closer than the largest gap allowed. Kept as one flat
//!   adjacency (CSR); a pair found from both ends is listed twice, which a
//!   shortest-path search shrugs off and saves a sort of every row.
//! * `StepCost`: what a step costs — its length to a power (long jumps
//!   across gaps are dear) times a factor that grows as the step turns
//!   from upward: exp(β (1 − cos θ)), 1 straight up, `horizontal` level,
//!   `horizontal`² straight down. Wood grows up and out from the ground;
//!   paths that have to descend are probably jumping between trees.
//! * `dijkstra`: from many sources at once, each carrying a label, so one
//!   search answers both "how far from the ground" and "which seed is
//!   nearest". It records the settling order, which is all a subtree sum
//!   over the shortest-path tree needs (`subtree_sum`).

use std::cmp::Reverse;
use std::collections::BinaryHeap;

use rayon::prelude::*;

use crate::commands::kdtree::KdTree3;

pub const NONE: u32 = u32::MAX;

/// A graph as compressed rows: node i's neighbours are
/// `nbr[off[i]..off[i + 1]]`.
pub struct Csr {
    pub off: Vec<u32>,
    pub nbr: Vec<u32>,
}

impl Csr {
    pub fn nodes(&self) -> usize { self.off.len().saturating_sub(1) }
    #[inline]
    pub fn neighbours(&self, i: usize) -> &[u32] { &self.nbr[self.off[i] as usize..self.off[i + 1] as usize] }
}

/// The symmetric k-nearest-neighbour graph, edges no longer than `max_gap`.
pub fn knn_graph(p: &[[f32; 3]], tree: &KdTree3, k: usize, max_gap: f32) -> Csr {
    let n = p.len();
    let k = k.max(1);
    let max_d2 = max_gap * max_gap;
    // each node's k nearest (itself excluded), NONE-padded
    let mut out = vec![NONE; n * k];
    out.par_chunks_mut(k).enumerate().for_each_init(Vec::new, |buf, (i, row)| {
        tree.knn(p[i], k + 1, max_d2, buf);
        let mut j = 0;
        for &(q, _) in buf.iter() {
            if q as usize == i || j == k { continue; }
            row[j] = q;
            j += 1;
        }
    });
    // both directions of every edge
    let mut deg = vec![0u32; n + 1];
    for i in 0..n {
        for &j in &out[i * k..i * k + k] {
            if j == NONE { break; }
            deg[i] += 1;
            deg[j as usize] += 1;
        }
    }
    let mut off = vec![0u32; n + 1];
    for i in 0..n { off[i + 1] = off[i] + deg[i]; }
    let mut cur: Vec<u32> = off[..n].to_vec();
    let mut nbr = vec![0u32; off[n] as usize];
    for i in 0..n {
        for &j in &out[i * k..i * k + k] {
            if j == NONE { break; }
            nbr[cur[i] as usize] = j;
            cur[i] += 1;
            nbr[cur[j as usize] as usize] = i as u32;
            cur[j as usize] += 1;
        }
    }
    Csr { off, nbr }
}

/// The graph with more edges for the nodes `stranded` marks: each gets its
/// `k` nearest within `max_gap`, both ways. For the pieces a plain k-nearest
/// graph leaves cut off (a twig behind a gap in the scan) — they are given a
/// longer reach, and the step cost still makes the jump dear.
pub fn bridge(p: &[[f32; 3]], tree: &KdTree3, csr: &Csr, stranded: &[bool], k: usize, max_gap: f32) -> Csr {
    let n = p.len();
    let max_d2 = max_gap * max_gap;
    let extra: Vec<(u32, u32)> = (0..n)
        .into_par_iter()
        .filter(|&i| stranded[i])
        .flat_map_iter(|i| {
            let mut buf = Vec::new();
            tree.knn(p[i], k + 1, max_d2, &mut buf);
            buf.into_iter().filter(move |&(j, _)| j as usize != i).map(move |(j, _)| (i as u32, j))
        })
        .collect();
    if extra.is_empty() {
        return Csr { off: csr.off.clone(), nbr: csr.nbr.clone() };
    }
    let mut deg: Vec<u32> = (0..n).map(|i| csr.off[i + 1] - csr.off[i]).collect();
    for &(a, b) in &extra { deg[a as usize] += 1; deg[b as usize] += 1; }
    let mut off = vec![0u32; n + 1];
    for i in 0..n { off[i + 1] = off[i] + deg[i]; }
    let mut cur: Vec<u32> = off[..n].to_vec();
    let mut nbr = vec![0u32; off[n] as usize];
    for i in 0..n {
        for &j in csr.neighbours(i) { nbr[cur[i] as usize] = j; cur[i] += 1; }
    }
    for &(a, b) in &extra {
        nbr[cur[a as usize] as usize] = b; cur[a as usize] += 1;
        nbr[cur[b as usize] as usize] = a; cur[b as usize] += 1;
    }
    Csr { off, nbr }
}

/// What a step from a to b costs.
#[derive(Clone)]
pub struct StepCost {
    /// The direction factor by the step's cos θ to the vertical, sampled.
    table: Vec<f32>,
    pow: f32,
}

const COS_STEPS: usize = 512;

impl StepCost {
    /// `pow`: the length exponent; `horizontal`: the factor of a level step
    /// (and its square straight down).
    pub fn new(pow: f32, horizontal: f32) -> StepCost {
        StepCost::with_down(pow, horizontal, horizontal.max(1.0).powi(2))
    }

    /// As `new`, with the factor of a step straight down given apart:
    /// exp(β (1 − cos θ)) up to level, then rising from `horizontal` to
    /// `down` as the step turns downward.
    pub fn with_down(pow: f32, horizontal: f32, down: f32) -> StepCost {
        let h = horizontal.max(1.0);
        let beta = h.ln();
        let beta_down = (down.max(h) / h).ln();
        let table = (0..=COS_STEPS)
            .map(|i| {
                let c = i as f32 / COS_STEPS as f32 * 2.0 - 1.0;
                if c >= 0.0 { (beta * (1.0 - c)).exp() } else { h * (beta_down * -c).exp() }
            })
            .collect();
        StepCost { table, pow }
    }

    /// A step's factor growing with its angle from straight up: `per_degree`
    /// to the power of the angle in degrees, at most `cap` (1 straight up).
    pub fn by_angle(pow: f32, per_degree: f32, cap: f32) -> StepCost {
        let table = (0..=COS_STEPS)
            .map(|i| {
                let c = (i as f32 / COS_STEPS as f32 * 2.0 - 1.0).clamp(-1.0, 1.0);
                per_degree.max(1.0).powf(c.acos().to_degrees()).min(cap.max(1.0))
            })
            .collect();
        StepCost { table, pow }
    }

    #[inline]
    pub fn cost(&self, a: &[f32; 3], b: &[f32; 3]) -> f32 {
        let (dx, dy, dz) = (b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        let d2 = dx * dx + dy * dy + dz * dz;
        if d2 <= 0.0 { return 0.0; }
        let d = d2.sqrt();
        let c = dz / d;
        let f = self.table[(((c + 1.0) * 0.5 * COS_STEPS as f32) + 0.5) as usize];
        let len = if self.pow == 2.0 { d2 } else if self.pow == 3.0 { d2 * d } else if self.pow == 1.0 { d } else if self.pow == 6.0 { d2 * d2 * d2 } else if self.pow == 8.0 { let q = d2 * d2; q * q } else { d.powf(self.pow) };
        len * f
    }
}

/// A shortest-path forest.
pub struct Sssp {
    pub dist: Vec<f32>,
    /// The node a node was reached from; NONE for sources and the unreached.
    pub pred: Vec<u32>,
    /// The label of the source a node was reached from; NONE when unreached.
    pub label: Vec<u32>,
    /// The nodes in the order they were settled.
    pub order: Vec<u32>,
}

/// Shortest paths from labelled sources over the nodes `allowed` lets in
/// (sources always count), stepping at `cost(from, to, label of from)` — the
/// label lets each source weigh its own steps.
pub fn dijkstra<A, C>(csr: &Csr, sources: &[(u32, u32)], allowed: A, cost: C) -> Sssp
where
    A: Fn(usize) -> bool,
    C: Fn(usize, usize, u32) -> f32,
{
    dijkstra_from(csr, sources, &[], allowed, cost)
}

/// As `dijkstra`, with the sources starting at the distances `start`
/// gives (parallel to `sources`; empty: all 0).
pub fn dijkstra_from<A, C>(csr: &Csr, sources: &[(u32, u32)], start: &[f32], allowed: A, cost: C) -> Sssp
where
    A: Fn(usize) -> bool,
    C: Fn(usize, usize, u32) -> f32,
{
    search(csr, sources, start, None, allowed, cost)
}

/// As `dijkstra_from` over every node, a node reached only below `bound`
/// (its distance in another search): what these sources would win from
/// that search. A node they do not win keeps its bound and no label.
pub fn dijkstra_under<C>(csr: &Csr, bound: &[f32], sources: &[(u32, u32)], start: &[f32], cost: C) -> Sssp
where
    C: Fn(usize, usize, u32) -> f32,
{
    search(csr, sources, start, Some(bound), |_| true, cost)
}

fn search<A, C>(csr: &Csr, sources: &[(u32, u32)], start: &[f32], bound: Option<&[f32]>, allowed: A, cost: C) -> Sssp
where
    A: Fn(usize) -> bool,
    C: Fn(usize, usize, u32) -> f32,
{
    let n = csr.nodes();
    let mut dist = bound.map_or_else(|| vec![f32::INFINITY; n], |b| b.to_vec());
    let mut pred = vec![NONE; n];
    let mut label = vec![NONE; n];
    let mut done = vec![false; n];
    let mut order = if bound.is_some() { Vec::new() } else { Vec::with_capacity(n) };
    // (distance bits, node) packed into one word: a non-negative f32
    // orders like its bits, and one u64 compare is the cheapest heap key
    let key = |d: f32, v: usize| ((d.to_bits() as u64) << 32) | v as u64;
    let mut heap = RadixQueue::new();
    for (k, &(s, l)) in sources.iter().enumerate() {
        let s = s as usize;
        if s >= n { continue; }
        let d0 = start.get(k).copied().unwrap_or(0.0).max(0.0);
        if d0 < dist[s] || (bound.is_none() && d0 == dist[s] && label[s] == NONE) {
            dist[s] = d0;
            label[s] = l;
            heap.push(key(d0, s));
        }
    }
    while let Some(k) = heap.pop() {
        let u = (k & 0xFFFF_FFFF) as usize;
        if done[u] { continue; }
        let du = f32::from_bits((k >> 32) as u32);
        if du > dist[u] { continue; }
        done[u] = true;
        order.push(u as u32);
        let lu = label[u];
        for &v in csr.neighbours(u) {
            let v = v as usize;
            if done[v] || !allowed(v) { continue; }
            let nd = du + cost(u, v, lu);
            if nd < dist[v] {
                dist[v] = nd;
                pred[v] = u as u32;
                label[v] = lu;
                heap.push(key(nd, v));
            }
        }
    }
    Sssp { dist, pred, label, order }
}

/// The priority queue of `dijkstra`: keys are (distance bits << 32 | node),
/// popped in exactly the order a binary heap of them would give —
/// smallest distance, then smallest node — so the paths are the same, at
/// a fraction of the cost. A radix heap over the distance's bits (a
/// non-negative f32 orders like its bits, and the search never pushes a
/// distance below the one it last popped), with the keys at the current
/// distance in a small binary heap for the node order among ties.
struct RadixQueue {
    last: u32,
    cur: BinaryHeap<Reverse<u64>>,
    /// Bucket b holds distances whose highest bit differing from `last`
    /// is bit b − 1.
    buckets: Vec<Vec<u64>>,
}

impl RadixQueue {
    fn new() -> RadixQueue { RadixQueue { last: 0, cur: BinaryHeap::new(), buckets: (0..33).map(|_| Vec::new()).collect() } }

    #[inline]
    fn push(&mut self, k: u64) {
        let d = (k >> 32) as u32;
        debug_assert!(d >= self.last, "a shortest-path search pushed below its last pop");
        if d == self.last { self.cur.push(Reverse(k)); } else { self.buckets[32 - (d ^ self.last).leading_zeros() as usize].push(k); }
    }

    fn pop(&mut self) -> Option<u64> {
        if self.cur.is_empty() {
            let b = self.buckets.iter().position(|v| !v.is_empty())?;
            let mut items = std::mem::take(&mut self.buckets[b]);
            let m = items.iter().map(|&k| (k >> 32) as u32).min().unwrap_or(self.last);
            self.last = m;
            for &k in &items {
                let d = (k >> 32) as u32;
                if d == m { self.cur.push(Reverse(k)); } else { self.buckets[32 - (d ^ m).leading_zeros() as usize].push(k); }
            }
            items.clear();
            self.buckets[b] = items;
        }
        self.cur.pop().map(|Reverse(k)| k)
    }
}

/// The nodes a breadth-first walk from `sources` reaches — which nodes a
/// shortest-path search would reach, at a fraction of its cost.
pub fn reachable(csr: &Csr, sources: &[u32]) -> Vec<bool> {
    let mut seen = vec![false; csr.nodes()];
    let mut stack: Vec<u32> = Vec::with_capacity(sources.len());
    for &s in sources { if !seen[s as usize] { seen[s as usize] = true; stack.push(s); } }
    while let Some(u) = stack.pop() {
        for &v in csr.neighbours(u as usize) {
            if !seen[v as usize] { seen[v as usize] = true; stack.push(v); }
        }
    }
    seen
}

/// The source each node's shortest path starts from (NONE when unreached),
/// in one pass over the settling order.
pub fn roots(s: &Sssp) -> Vec<u32> {
    let mut r = vec![NONE; s.pred.len()];
    for &v in &s.order {
        let p = s.pred[v as usize];
        r[v as usize] = if p == NONE { v } else { r[p as usize] };
    }
    r
}

/// Each node's value plus everything below it in the shortest-path tree,
/// in one pass backwards over the settling order.
pub fn subtree_sum(s: &Sssp, w: &[f32]) -> Vec<f32> {
    let mut acc: Vec<f32> = w.to_vec();
    for &v in s.order.iter().rev() {
        let pv = s.pred[v as usize];
        if pv != NONE { acc[pv as usize] += acc[v as usize]; }
    }
    acc
}

/// The children of every node in the shortest-path tree, as rows.
pub fn children(pred: &[u32]) -> Csr {
    let n = pred.len();
    let mut off = vec![0u32; n + 1];
    for &p in pred { if p != NONE { off[p as usize + 1] += 1; } }
    for i in 0..n { off[i + 1] += off[i]; }
    let mut cur: Vec<u32> = off[..n].to_vec();
    let mut nbr = vec![0u32; off[n] as usize];
    for (v, &p) in pred.iter().enumerate() {
        if p != NONE {
            nbr[cur[p as usize] as usize] = v as u32;
            cur[p as usize] += 1;
        }
    }
    Csr { off, nbr }
}

/// Connected components over the edges `keep(a, b)` lets through, among the
/// nodes `member` lets in; the component id of every member, NONE for the
/// rest, and each component's size.
pub fn components<M, K>(csr: &Csr, member: M, keep: K) -> (Vec<u32>, Vec<u32>)
where
    M: Fn(usize) -> bool,
    K: Fn(usize, usize) -> bool,
{
    let n = csr.nodes();
    let mut comp = vec![NONE; n];
    let mut sizes = Vec::new();
    let mut stack = Vec::new();
    for s in 0..n {
        if comp[s] != NONE || !member(s) { continue; }
        let c = sizes.len() as u32;
        comp[s] = c;
        stack.push(s as u32);
        let mut size = 0u32;
        while let Some(u) = stack.pop() {
            size += 1;
            for &v in csr.neighbours(u as usize) {
                let v = v as usize;
                if comp[v] == NONE && member(v) && keep(u as usize, v) {
                    comp[v] = c;
                    stack.push(v as u32);
                }
            }
        }
        sizes.push(size);
    }
    (comp, sizes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chain(n: usize, step: f32) -> Vec<[f32; 3]> { (0..n).map(|i| [0.0, 0.0, i as f32 * step]).collect() }

    #[test]
    fn the_graph_is_symmetric_and_gaps_cut_it() {
        let mut p = chain(10, 0.05);
        p.extend(chain(10, 0.05).into_iter().map(|q| [5.0, 0.0, q[2]]));
        let tree = KdTree3::build(&p);
        let g = knn_graph(&p, &tree, 3, 0.2);
        for i in 0..p.len() {
            for &j in g.neighbours(i) {
                assert!(g.neighbours(j as usize).contains(&(i as u32)));
                assert!((p[i][0] - p[j as usize][0]).abs() < 1.0, "no edge across the 5 m gap");
            }
        }
        let (comp, sizes) = components(&g, |_| true, |_, _| true);
        assert_eq!(sizes, vec![10, 10]);
        assert_ne!(comp[0], comp[10]);
    }

    #[test]
    fn up_is_cheap_down_is_dear() {
        let c = StepCost::new(2.0, 10.0);
        let up = c.cost(&[0.0, 0.0, 0.0], &[0.0, 0.0, 0.1]);
        let level = c.cost(&[0.0, 0.0, 0.0], &[0.1, 0.0, 0.0]);
        let down = c.cost(&[0.0, 0.0, 0.0], &[0.0, 0.0, -0.1]);
        assert!((up - 0.01).abs() < 1e-6);
        assert!((level / up - 10.0).abs() < 0.1, "{level}");
        assert!((down / up - 100.0).abs() < 1.0, "{down}");
    }

    #[test]
    fn what_a_stem_carries_is_everything_above_it() {
        // a vertical chain: node i carries the n − i nodes from it upward
        let p = chain(20, 0.05);
        let tree = KdTree3::build(&p);
        let g = knn_graph(&p, &tree, 2, 0.2);
        let cost = StepCost::new(2.0, 10.0);
        let s = dijkstra(&g, &[(0, 7)], |_| true, |a, b, _| cost.cost(&p[a], &p[b]));
        assert_eq!(s.order.len(), 20);
        assert!(s.label.iter().all(|&l| l == 7));
        let acc = subtree_sum(&s, &vec![1.0; 20]);
        for (i, a) in acc.iter().enumerate() { assert_eq!(*a, (20 - i) as f32); }
        let ch = children(&s.pred);
        assert_eq!(ch.neighbours(0), &[1]);
        assert!(ch.neighbours(19).is_empty());
    }

    #[test]
    fn every_node_knows_the_source_its_path_starts_from() {
        let p = chain(21, 0.05);
        let tree = KdTree3::build(&p);
        let g = knn_graph(&p, &tree, 2, 0.2);
        let cost = StepCost::new(1.0, 1.0);
        let s = dijkstra(&g, &[(0, 1), (20, 2)], |_| true, |a, b, _| cost.cost(&p[a], &p[b]));
        let r = roots(&s);
        assert!(r[..10].iter().all(|&x| x == 0));
        assert!(r[11..].iter().all(|&x| x == 20));
    }

    #[test]
    fn the_queue_pops_as_a_binary_heap_does() {
        let mut seed = 77u64;
        let mut q = RadixQueue::new();
        let mut h: BinaryHeap<Reverse<u64>> = BinaryHeap::new();
        let mut last = 0.0f32;
        for round in 0..2000 {
            // pushes never below the last pop, ties included
            for _ in 0..(1 + round % 5) {
                let d = last + if crate::commands::forest::lcg(&mut seed) < 0.2 { 0.0 } else { crate::commands::forest::lcg(&mut seed) * 0.01 };
                let v = (crate::commands::forest::lcg(&mut seed) * 1000.0) as u64;
                let k = ((d.to_bits() as u64) << 32) | v;
                q.push(k);
                h.push(Reverse(k));
            }
            let a = q.pop();
            let b = h.pop().map(|Reverse(k)| k);
            assert_eq!(a, b);
            if let Some(k) = a { last = f32::from_bits((k >> 32) as u32); }
        }
        while let Some(Reverse(k)) = h.pop() { assert_eq!(q.pop(), Some(k)); }
        assert_eq!(q.pop(), None);
    }

    #[test]
    fn many_sources_split_the_nodes_between_them() {
        let p = chain(21, 0.05);
        let tree = KdTree3::build(&p);
        let g = knn_graph(&p, &tree, 2, 0.2);
        let cost = StepCost::new(1.0, 1.0);
        let s = dijkstra(&g, &[(0, 1), (20, 2)], |_| true, |a, b, _| cost.cost(&p[a], &p[b]));
        assert!(s.label[..10].iter().all(|&l| l == 1));
        assert!(s.label[11..].iter().all(|&l| l == 2));
        // a node shut out stays unreached
        let s = dijkstra(&g, &[(0, 1)], |v| v != 5, |a, b, _| cost.cost(&p[a], &p[b]));
        assert_eq!(s.label[6], NONE);
        assert_eq!(s.order.len(), 5);
    }

    #[test]
    fn a_search_under_another_wins_only_what_it_is_nearer() {
        let p = chain(21, 0.05);
        let tree = KdTree3::build(&p);
        let g = knn_graph(&p, &tree, 2, 0.2);
        let cost = StepCost::new(1.0, 1.0);
        let first = dijkstra(&g, &[(0, 1)], |_| true, |a, b, _| cost.cost(&p[a], &p[b]));
        // a source at node 16 starting 0.52 in: nearer from node 14 on
        let s = dijkstra_under(&g, &first.dist, &[(16, 2)], &[0.52], |a, b, _| cost.cost(&p[a], &p[b]));
        assert!(s.label[..14].iter().all(|&l| l == NONE));
        assert!(s.label[14..].iter().all(|&l| l == 2));
        assert_eq!(s.dist[3], first.dist[3]);
        assert_eq!(s.order.len(), 7, "it settles only what it wins");
    }
}
