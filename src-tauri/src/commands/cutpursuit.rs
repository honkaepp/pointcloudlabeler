// Cut-pursuit — Landrieu & Obozinski 2017, "Cut Pursuit: fast algorithms
// to learn piecewise constant functions on general weighted graphs"
// (SIAM J. Imaging Sci. 10(4)). This is the ℓ0 ("minimal partition")
// variant treeiso (Xi & Hopkinson 2022) builds its individual-tree
// isolation on.
//
// CHECKED AGAINST THE REFERENCE
//
// Landrieu's own C++ implementation (github.com/loicland/cut-pursuit,
// MIT) is the reference. This is an independent implementation of the
// same algorithm, not a translation of it, and the differences that
// survive that comparison are:
//
//   • Components are kept CONNECTED, as the reference does by calling
//     `compute_connected_components` inside `reduce()` every
//     iteration. This module did not, and a component could span two
//     pieces of the graph that touch nowhere — see
//     `split_disconnected` and the test named for it.
//
//   • The binary partition is seeded from the component's principal
//     axis (mean ± σ along the top eigenvector), deterministically.
//     The reference seeds it with k-means++ over the features, 5 Lloyd
//     iterations, 3 random restarts, keeping the best. Ours is
//     reproducible run to run; the reference's can find a better seed
//     on a component whose two natural halves are not separated along
//     the principal axis.
//
//   • Alternations per split: 8 here, `flow_steps = 3` in the
//     reference's defaults. More refinement, same fixed point.
//
//   • Max-flow: Dinic here, Boykov-Kolmogorov in the reference. Both
//     exact, so the cut VALUE agrees; which of several equally minimal
//     cuts is returned can differ.
//
//   • Not implemented: the reference's `cutoff` (merge components below
//     a size), `weight_decay` (λ decayed across flow steps) and
//     `backward_step` (a merge pass that can undo a split). treeiso's
//     reference pipeline runs with cutoff = 0 and the defaults for the
//     other two, so their absence changes the partition on hard cases
//     rather than the common one.
//
// It minimises, over x with each x_v ∈ R^d,
//
//     E(x) = Σ_v ‖x_v − f_v‖²  +  λ Σ_{(u,v)∈E} w_uv · [x_u ≠ x_v]
//
// i.e. fit the per-vertex features f_v while paying λ·w for every graph
// edge whose two endpoints end up in different constant pieces. The
// minimiser is piecewise constant on a partition of the graph; we return
// that partition (a component id per vertex).
//
// Algorithm (coarse-to-fine): start with the whole graph as one
// component (its optimal constant value is the mean of f, since the
// fidelity is quadratic). Repeatedly take each component and find the
// binary split that most reduces the energy — the "steepest cut" — by
// solving an exact max-flow / min-cut: for two candidate values (a, b)
// every vertex's data cost of joining side A vs. B becomes a t-link and
// every intra-component edge a λ·w n-link, so the min-cut is the optimal
// A/B labelling; a few Lloyd-style refinements of (a, b) follow. Keep the
// split only if it strictly lowers the true energy. Stop when no
// component can be beneficially split. λ therefore controls granularity:
// large λ → few, coarse pieces; small λ → many, fine pieces.
//
// The max-flow is Dinic's algorithm with f64 capacities. Nothing here is
// TLS-specific — the treeiso stages (kNN-graph construction, decimation,
// the 3D→2D→grouping cascade) live with the octree command that calls
// this; this module is just the optimiser, kept standalone so it can be
// unit-tested against known energy minima.

use std::collections::{HashMap, HashSet, VecDeque};

/// Dinic max-flow on a directed graph with f64 capacities. Edges are
/// stored in forward/back pairs, so the residual of edge `e` is `e ^ 1`.
struct Dinic {
    to: Vec<u32>,
    cap: Vec<f64>,
    adj: Vec<Vec<u32>>,
    level: Vec<i32>,
    iter: Vec<usize>,
}

impl Dinic {
    fn new(n: usize) -> Self {
        Dinic { to: Vec::new(), cap: Vec::new(), adj: vec![Vec::new(); n], level: vec![-1; n], iter: vec![0; n] }
    }

    /// Directed edge u→v with capacity `c`, plus its zero-capacity
    /// residual v→u. Every edge goes through here, so `to.len()` is even
    /// before each call and `e ^ 1` always flips forward↔back.
    fn add_edge(&mut self, u: usize, v: usize, c: f64) {
        let e = self.to.len();
        self.to.push(v as u32);
        self.cap.push(c);
        self.adj[u].push(e as u32);
        self.to.push(u as u32);
        self.cap.push(0.0);
        self.adj[v].push((e + 1) as u32);
    }

    fn bfs(&mut self, s: usize, t: usize) -> bool {
        for l in self.level.iter_mut() { *l = -1; }
        let mut q = VecDeque::new();
        self.level[s] = 0;
        q.push_back(s);
        while let Some(u) = q.pop_front() {
            for k in 0..self.adj[u].len() {
                let ei = self.adj[u][k] as usize;
                let v = self.to[ei] as usize;
                if self.cap[ei] > 1e-12 && self.level[v] < 0 {
                    self.level[v] = self.level[u] + 1;
                    q.push_back(v);
                }
            }
        }
        self.level[t] >= 0
    }

    fn dfs(&mut self, u: usize, t: usize, f: f64) -> f64 {
        if u == t { return f; }
        while self.iter[u] < self.adj[u].len() {
            let ei = self.adj[u][self.iter[u]] as usize;
            let v = self.to[ei] as usize;
            if self.cap[ei] > 1e-12 && self.level[v] == self.level[u] + 1 {
                let d = self.dfs(v, t, f.min(self.cap[ei]));
                if d > 1e-12 {
                    self.cap[ei] -= d;
                    self.cap[ei ^ 1] += d;
                    return d;
                }
            }
            self.iter[u] += 1;
        }
        0.0
    }

    fn max_flow(&mut self, s: usize, t: usize) -> f64 {
        let mut flow = 0.0;
        while self.bfs(s, t) {
            for it in self.iter.iter_mut() { *it = 0; }
            loop {
                let f = self.dfs(s, t, f64::INFINITY);
                if f <= 1e-12 { break; }
                flow += f;
            }
        }
        flow
    }

    /// Vertices reachable from `s` along edges with residual capacity —
    /// the source side of the min-cut. `side[v]` true ⇒ v on the S side.
    fn min_cut_side(&self, s: usize) -> Vec<bool> {
        let mut side = vec![false; self.adj.len()];
        let mut q = VecDeque::new();
        side[s] = true;
        q.push_back(s);
        while let Some(u) = q.pop_front() {
            for k in 0..self.adj[u].len() {
                let ei = self.adj[u][k] as usize;
                let v = self.to[ei] as usize;
                if self.cap[ei] > 1e-9 && !side[v] {
                    side[v] = true;
                    q.push_back(v);
                }
            }
        }
        side
    }
}

/// Top eigenvector of the (d×d) covariance of the component's features,
/// via power iteration. `None` if the features carry no spread (all
/// equal) — such a component can't be usefully split.
fn principal_axis(verts: &[u32], features: &[f32], mean: &[f64], d: usize) -> Option<Vec<f64>> {
    let mut cov = vec![0f64; d * d];
    for &g in verts {
        let f = &features[g as usize * d..g as usize * d + d];
        for i in 0..d {
            let ei = f[i] as f64 - mean[i];
            for j in 0..d {
                cov[i * d + j] += ei * (f[j] as f64 - mean[j]);
            }
        }
    }
    // Start from the covariance column with the largest norm, NOT from
    // the first basis vector.
    //
    // Power iteration cannot escape a start vector orthogonal to the
    // dominant eigenvector: cov · v comes out zero, the norm check trips
    // and the function reports "no axis". Starting at [1,0,0] made that
    // happen for any component with no variance along x — which is not
    // an exotic shape here, it is a vertical stem. Those components were
    // silently never split, so a segmentation would leave a whole trunk
    // fused with whatever it touched, with nothing reported.
    //
    // For a symmetric positive-semidefinite matrix the largest-norm
    // column always has a non-zero component along the dominant
    // eigenvector unless the matrix is entirely zero — which is the one
    // case that genuinely has no axis, and is still caught below.
    let mut v = vec![0f64; d];
    {
        let (mut best, mut best_n2) = (0usize, -1.0f64);
        for i in 0..d {
            let n2: f64 = (0..d).map(|j| cov[j * d + i] * cov[j * d + i]).sum();
            if n2 > best_n2 { best_n2 = n2; best = i; }
        }
        if best_n2 <= 0.0 { return None; }
        for j in 0..d { v[j] = cov[j * d + best]; }
        let l = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        if l < 1e-15 { return None; }
        for x in v.iter_mut() { *x /= l; }
    }
    let mut last_norm = 0.0;
    for _ in 0..64 {
        let mut nv = vec![0f64; d];
        for i in 0..d {
            for j in 0..d {
                nv[i] += cov[i * d + j] * v[j];
            }
        }
        let norm = nv.iter().map(|x| x * x).sum::<f64>().sqrt();
        if norm < 1e-15 { return None; }
        for x in nv.iter_mut() { *x /= norm; }
        v = nv;
        last_norm = norm;
    }
    if last_norm < 1e-12 { None } else { Some(v) }
}

/// Attempt the energy-reducing binary split of one component. Returns the
/// two sides (as global vertex ids) if a split strictly lowers the energy,
/// else `None` (leave the component whole).
// `li` here is the local vertex index — it doubles as the max-flow node id
// (`2 + li`) and indexes several parallel arrays, so range loops are the
// clear form rather than an iterator.
#[allow(clippy::needless_range_loop)]
fn try_split(
    verts: &[u32],
    adj: &[Vec<(u32, f64)>],
    features: &[f32],
    d: usize,
    lambda: f64,
) -> Option<(Vec<u32>, Vec<u32>)> {
    let m = verts.len();
    if m < 2 { return None; }

    // Local (0..m) index for each global vertex, and the intra-component
    // edges expressed in local indices.
    let mut local: HashMap<u32, usize> = HashMap::with_capacity(m);
    for (li, &g) in verts.iter().enumerate() { local.insert(g, li); }
    let mut intra: Vec<(usize, usize, f64)> = Vec::new();
    for (li, &g) in verts.iter().enumerate() {
        for &(nb, w) in &adj[g as usize] {
            if let Some(&lj) = local.get(&nb) {
                if lj > li { intra.push((li, lj, w)); }
            }
        }
    }

    let ffeat = |g: u32| -> &[f32] { &features[g as usize * d..g as usize * d + d] };

    // Component mean + baseline (single-value) energy.
    let mut mean = vec![0f64; d];
    for &g in verts {
        let f = ffeat(g);
        for k in 0..d { mean[k] += f[k] as f64; }
    }
    for x in mean.iter_mut() { *x /= m as f64; }
    let mut e_base = 0f64;
    for &g in verts {
        let f = ffeat(g);
        for k in 0..d { let dd = f[k] as f64 - mean[k]; e_base += dd * dd; }
    }
    if e_base < 1e-12 { return None; }

    // Initialise the two candidate values ±σ along the principal axis.
    let dir = principal_axis(verts, features, &mean, d)?;
    let mut spread = 0f64;
    for &g in verts {
        let f = ffeat(g);
        let mut p = 0f64;
        for k in 0..d { p += (f[k] as f64 - mean[k]) * dir[k]; }
        spread += p * p;
    }
    spread = (spread / m as f64).sqrt().max(1e-6);
    let mut a: Vec<f64> = (0..d).map(|k| mean[k] + spread * dir[k]).collect();
    let mut b: Vec<f64> = (0..d).map(|k| mean[k] - spread * dir[k]).collect();

    // Lloyd-style refinement: min-cut assignment given (a, b), then update
    // (a, b) to the side means. A handful of rounds is plenty.
    let mut is_a = vec![true; m];
    for _round in 0..8 {
        let s = 0usize;
        let t = 1usize;
        let mut mf = Dinic::new(m + 2);
        for li in 0..m {
            let f = ffeat(verts[li]);
            let mut da = 0f64;
            let mut db = 0f64;
            for k in 0..d {
                let ea = f[k] as f64 - a[k];
                da += ea * ea;
                let eb = f[k] as f64 - b[k];
                db += eb * eb;
            }
            // S-side = label A. Cutting v→T (cap D(v,A)) keeps v on S ⇒ pays
            // A's data cost; cutting S→v (cap D(v,B)) puts v on T ⇒ pays B's.
            mf.add_edge(2 + li, t, da);
            mf.add_edge(s, 2 + li, db);
        }
        for &(li, lj, w) in &intra {
            let c = lambda * w;
            mf.add_edge(2 + li, 2 + lj, c);
            mf.add_edge(2 + lj, 2 + li, c);
        }
        mf.max_flow(s, t);
        let side = mf.min_cut_side(s);
        let new_is_a: Vec<bool> = (0..m).map(|li| side[2 + li]).collect();
        let na = new_is_a.iter().filter(|&&x| x).count();
        if na == 0 || na == m { break; } // degenerate — keep the last good split

        // Update (a, b) to the side means.
        let mut ca = vec![0f64; d];
        let mut cb = vec![0f64; d];
        let (mut nca, mut ncb) = (0usize, 0usize);
        for li in 0..m {
            let f = ffeat(verts[li]);
            if new_is_a[li] {
                for k in 0..d { ca[k] += f[k] as f64; }
                nca += 1;
            } else {
                for k in 0..d { cb[k] += f[k] as f64; }
                ncb += 1;
            }
        }
        for k in 0..d { ca[k] /= nca as f64; cb[k] /= ncb as f64; }
        let mut delta = 0f64;
        for k in 0..d { delta += (ca[k] - a[k]).abs() + (cb[k] - b[k]).abs(); }
        a = ca;
        b = cb;
        is_a = new_is_a;
        if delta < 1e-9 { break; }
    }

    let na = is_a.iter().filter(|&&x| x).count();
    if na == 0 || na == m { return None; }

    // True post-split energy: fidelity to each side's mean + λ·(cut weight).
    let mut mean_a = vec![0f64; d];
    let mut mean_b = vec![0f64; d];
    let (mut nca, mut ncb) = (0usize, 0usize);
    for li in 0..m {
        let f = ffeat(verts[li]);
        if is_a[li] { for k in 0..d { mean_a[k] += f[k] as f64; } nca += 1; }
        else { for k in 0..d { mean_b[k] += f[k] as f64; } ncb += 1; }
    }
    for k in 0..d { mean_a[k] /= nca as f64; mean_b[k] /= ncb as f64; }
    let mut fidelity = 0f64;
    for li in 0..m {
        let f = ffeat(verts[li]);
        let mref = if is_a[li] { &mean_a } else { &mean_b };
        for k in 0..d { let dd = f[k] as f64 - mref[k]; fidelity += dd * dd; }
    }
    let mut cut_w = 0f64;
    for &(li, lj, w) in &intra {
        if is_a[li] != is_a[lj] { cut_w += w; }
    }
    let e_split = fidelity + lambda * cut_w;

    if e_split + 1e-6 < e_base {
        let mut side_a = Vec::with_capacity(nca);
        let mut side_b = Vec::with_capacity(ncb);
        for li in 0..m {
            if is_a[li] { side_a.push(verts[li]); } else { side_b.push(verts[li]); }
        }
        Some((side_a, side_b))
    } else {
        None
    }
}

/// Give every connected piece of every component its own id. Returns
/// true when anything was renumbered.
///
/// Breadth-first from each unvisited vertex, crossing only edges whose
/// endpoints already share a component id, so the pieces of one
/// component are found without touching the others.
fn split_disconnected(comp: &mut [u32], adj: &[Vec<(u32, f64)>], next_id: &mut u32) -> bool {
    let n = comp.len();
    let mut seen = vec![false; n];
    let mut claimed: HashSet<u32> = HashSet::new();
    let mut changed = false;
    let mut queue: Vec<u32> = Vec::new();
    for start in 0..n {
        if seen[start] { continue; }
        let cid = comp[start];
        // First piece of this id keeps it; later pieces get new ids.
        // Tracked in a set rather than by scanning the labels, which
        // would make this quadratic in the vertex count — and the
        // working set here is tens of thousands of points.
        let assign = if claimed.insert(cid) {
            cid
        } else {
            let id = *next_id;
            *next_id += 1;
            changed = true;
            id
        };
        queue.clear();
        queue.push(start as u32);
        seen[start] = true;
        while let Some(v) = queue.pop() {
            comp[v as usize] = assign;
            for &(u, _) in &adj[v as usize] {
                if !seen[u as usize] && comp[u as usize] == cid {
                    seen[u as usize] = true;
                    queue.push(u);
                }
            }
        }
    }
    changed
}

/// Solve the ℓ0 minimal-partition problem by cut-pursuit and return a
/// compact component id (0..k) per vertex.
///
/// * `features` — `n*d` row-major; vertex `v`'s feature is
///   `features[v*d .. v*d+d]`.
/// * `edges` — undirected `(u, v, w)`, `w > 0`. Self-loops ignored.
/// * `lambda` — regularisation strength (granularity knob).
/// * `max_rounds` — hard cap on coarse-to-fine passes (each pass splits
///   every current component at most once).
pub fn cut_pursuit_l0(
    features: &[f32],
    n: usize,
    d: usize,
    edges: &[(u32, u32, f32)],
    lambda: f32,
    max_rounds: usize,
) -> Vec<u32> {
    assert!(features.len() >= n * d, "features shorter than n*d");
    let lambda = lambda as f64;

    let mut adj: Vec<Vec<(u32, f64)>> = vec![Vec::new(); n];
    for &(u, v, w) in edges {
        if u == v || u as usize >= n || v as usize >= n { continue; }
        adj[u as usize].push((v, w as f64));
        adj[v as usize].push((u, w as f64));
    }

    let mut comp = vec![0u32; n];
    let mut next_id: u32 = 1;
    let mut round = 0;
    let mut changed = true;
    while changed && round < max_rounds {
        changed = false;
        round += 1;

        // Snapshot the current components so ids created this round wait
        // for the next round to be considered for further splitting.
        let mut members: HashMap<u32, Vec<u32>> = HashMap::new();
        for (i, &c) in comp.iter().enumerate() {
            members.entry(c).or_default().push(i as u32);
        }
        let comp_ids: Vec<u32> = members.keys().copied().collect();
        for cid in comp_ids {
            let verts = &members[&cid];
            if verts.len() < 2 { continue; }
            if let Some((_a, side_b)) = try_split(verts, &adj, features, d, lambda) {
                let new_id = next_id;
                next_id += 1;
                for &vi in &side_b { comp[vi as usize] = new_id; }
                changed = true;
            }
        }

        // A min cut splits a component into two SIDES, and a side need
        // not be one connected piece: the cut follows feature values,
        // and two parts of a component that agree on the features can
        // sit either side of a part that does not, reachable from each
        // other only through it. Landrieu's reference implementation
        // calls `compute_connected_components` inside `reduce()` on
        // every iteration for exactly this reason, and the components
        // it works with are therefore always connected subgraphs.
        //
        // Without this pass a component's members can be scattered,
        // which matters downstream rather than here: treeiso takes each
        // component's CENTROID as a node for its next stage, and the
        // centroid of two distant blobs is a point where the tree has
        // nothing. Splitting the pieces here, before the next round,
        // also lets each of them be cut further on its own terms — the
        // reason the reference does it inside the loop and not at the
        // end.
        if split_disconnected(&mut comp, &adj, &mut next_id) {
            changed = true;
        }
    }

    // Compact the surviving ids to 0..k in first-seen order.
    let mut remap: HashMap<u32, u32> = HashMap::new();
    let mut next = 0u32;
    for c in comp.iter_mut() {
        let id = *remap.entry(*c).or_insert_with(|| { let x = next; next += 1; x });
        *c = id;
    }
    comp
}

#[cfg(test)]
mod stress_tests {
    use super::*;

    /// A 1-D chain graph of `n` nodes with unit edge weights.
    fn chain(n: usize) -> Vec<(u32, u32, f32)> {
        (0..n.saturating_sub(1)).map(|i| (i as u32, i as u32 + 1, 1.0f32)).collect()
    }

    /// Total energy of a labelling: squared deviation from each
    /// component's mean, plus lambda per cut edge. This is the objective
    /// cut-pursuit minimises, written independently of the solver so the
    /// tests below score the RESULT rather than trusting the solver's own
    /// bookkeeping.
    fn energy(features: &[f32], d: usize, edges: &[(u32, u32, f32)], comp: &[u32], lambda: f64) -> f64 {
        use std::collections::HashMap;
        let mut sums: HashMap<u32, (Vec<f64>, f64)> = HashMap::new();
        for (i, &c) in comp.iter().enumerate() {
            let e = sums.entry(c).or_insert_with(|| (vec![0.0; d], 0.0));
            for k in 0..d { e.0[k] += features[i * d + k] as f64; }
            e.1 += 1.0;
        }
        let means: HashMap<u32, Vec<f64>> = sums.iter()
            .map(|(&c, (s, n))| (c, s.iter().map(|v| v / n).collect()))
            .collect();
        let mut fit = 0.0;
        for (i, &c) in comp.iter().enumerate() {
            let m = &means[&c];
            for k in 0..d {
                let r = features[i * d + k] as f64 - m[k];
                fit += r * r;
            }
        }
        let cuts: f64 = edges.iter()
            .filter(|&&(u, v, _)| comp[u as usize] != comp[v as usize])
            .map(|&(_, _, w)| w as f64)
            .sum();
        fit + lambda * cuts
    }

    fn n_components(comp: &[u32]) -> usize {
        comp.iter().collect::<std::collections::HashSet<_>>().len()
    }

    /// Components must be CONNECTED subgraphs, which a min cut does not
    /// guarantee on its own.
    ///
    /// This chain is three blocks — 0, 10, 0 — so the best two-way
    /// split by feature value puts the two OUTER blocks together, and
    /// they touch each other nowhere in the graph. Landrieu's reference
    /// implementation calls `compute_connected_components` inside
    /// `reduce()` every iteration for this case; without that pass one
    /// component id spanned both ends of the chain, and treeiso would
    /// have taken the centroid of the pair — a point midway up, where
    /// the tree has nothing — as a node for its next stage.
    #[test]
    fn a_component_never_spans_two_disconnected_pieces() {
        let mut feats: Vec<f32> = Vec::new();
        for _ in 0..8 { feats.push(0.0); }
        for _ in 0..8 { feats.push(10.0); }
        for _ in 0..8 { feats.push(0.0); }
        let n = feats.len();
        let edges = chain(n);
        let comp = cut_pursuit_l0(&feats, n, 1, &edges, 1.0, 10);

        assert_eq!(n_components(&comp), 3, "three blocks, three components: {comp:?}");
        assert_ne!(comp[0], comp[n - 1], "the two ends are not connected to each other");
        // Each block is internally whole.
        for i in 0..7 { assert_eq!(comp[i], comp[i + 1], "left block at {i}"); }
        for i in 8..15 { assert_eq!(comp[i], comp[i + 1], "middle block at {i}"); }
        for i in 16..n - 1 { assert_eq!(comp[i], comp[i + 1], "right block at {i}"); }

        // …and every component is connected, checked generally rather
        // than by reading this fixture's answer off the labels.
        let mut adj: Vec<Vec<u32>> = vec![Vec::new(); n];
        for &(u, v, _) in &edges {
            adj[u as usize].push(v);
            adj[v as usize].push(u);
        }
        for cid in comp.iter().copied().collect::<std::collections::HashSet<_>>() {
            let members: Vec<usize> = (0..n).filter(|&i| comp[i] == cid).collect();
            let mut seen = vec![false; n];
            let mut stack = vec![members[0]];
            seen[members[0]] = true;
            let mut reached = 0;
            while let Some(v) = stack.pop() {
                reached += 1;
                for &u in &adj[v] {
                    if !seen[u as usize] && comp[u as usize] == cid {
                        seen[u as usize] = true;
                        stack.push(u as usize);
                    }
                }
            }
            assert_eq!(reached, members.len(), "component {cid} is not connected");
        }
    }

    /// A clean step function must be recovered exactly: one cut, in the
    /// right place. This is the case the method exists for, and getting
    /// the cut one node off is the archetypal off-by-one that leaves the
    /// segmentation looking right at a glance.
    #[test]
    fn a_clean_step_is_cut_exactly_once_in_the_right_place() {
        let n = 40;
        let feats: Vec<f32> = (0..n).map(|i| if i < 20 { 0.0f32 } else { 10.0 }).collect();
        let edges = chain(n);
        let comp = cut_pursuit_l0(&feats, n, 1, &edges, 1.0, 10);

        assert_eq!(n_components(&comp), 2, "a single step is two components");
        for i in 0..19 { assert_eq!(comp[i], comp[i + 1], "left side must stay whole at {i}"); }
        for i in 20..n - 1 { assert_eq!(comp[i], comp[i + 1], "right side must stay whole at {i}"); }
        assert_ne!(comp[19], comp[20], "the cut belongs exactly at the step");
    }

    /// lambda is the price of a cut, so it has to behave monotonically:
    /// free cuts fragment, expensive cuts merge. A solver that ignored
    /// lambda would return the same partition either way and still look
    /// plausible on any single example.
    #[test]
    fn lambda_controls_fragmentation_monotonically() {
        let n = 60;
        // A ramp: every neighbouring pair differs, so the partition is
        // decided purely by what a cut costs.
        let feats: Vec<f32> = (0..n).map(|i| i as f32 * 0.5).collect();
        let edges = chain(n);

        let mut prev = usize::MAX;
        for &lambda in &[0.01f32, 0.5, 5.0, 50.0, 500.0] {
            let comp = cut_pursuit_l0(&feats, n, 1, &edges, lambda, 12);
            let k = n_components(&comp);
            assert!(
                k <= prev,
                "raising lambda from below must never ADD components: {prev} then {k} at lambda {lambda}",
            );
            prev = k;
        }
        // Note the price it actually takes: on this ramp, splitting in
        // half still pays at lambda 500 (fit 1624 vs 4499 for one
        // component) and only stops paying around 5000. The first
        // version of this test asserted merging at 500 and was simply
        // wrong about the arithmetic — the solver was right.
        let merged = cut_pursuit_l0(&feats, n, 1, &edges, 20_000.0, 12);
        assert_eq!(n_components(&merged), 1, "a cut price that dwarfs the fit must merge everything");
    }

    /// The returned partition must actually beat the trivial ones on the
    /// objective. A solver that silently gave up — returning everything
    /// in one component — would pass a "does it run" test and produce a
    /// segmentation with no trees in it.
    #[test]
    fn the_partition_beats_the_trivial_alternatives() {
        let n = 60;
        let feats: Vec<f32> = (0..n)
            .map(|i| if i < 20 { 0.0f32 } else if i < 40 { 8.0 } else { 16.0 })
            .collect();
        let edges = chain(n);
        let lambda = 1.0f64;
        let comp = cut_pursuit_l0(&feats, n, 1, &edges, lambda as f32, 12);

        let got = energy(&feats, 1, &edges, &comp, lambda);
        let all_one = energy(&feats, 1, &edges, &vec![0u32; n], lambda);
        let all_separate: Vec<u32> = (0..n as u32).collect();
        let each_alone = energy(&feats, 1, &edges, &all_separate, lambda);

        assert!(got < all_one, "must beat one big component: {got:.3} vs {all_one:.3}");
        assert!(got < each_alone, "must beat splitting every point: {got:.3} vs {each_alone:.3}");
        assert_eq!(n_components(&comp), 3, "three plateaus are three components");
    }

    /// Edge weights are the geometry: a strong edge is expensive to cut.
    /// Two plateaus joined by a WEAK edge must separate at a lambda where
    /// the same plateaus joined by a strong edge stay together.
    #[test]
    fn edge_weight_decides_where_a_cut_is_affordable() {
        let n = 20;
        let feats: Vec<f32> = (0..n).map(|i| if i < 10 { 0.0f32 } else { 3.0 }).collect();

        let mut weak = chain(n);
        weak[9] = (9, 10, 0.01);           // the seam is barely connected
        let mut strong = chain(n);
        strong[9] = (9, 10, 1000.0);       // the seam is welded

        let lambda = 2.0f32;
        let weak_comp = cut_pursuit_l0(&feats, n, 1, &weak, lambda, 12);
        let strong_comp = cut_pursuit_l0(&feats, n, 1, &strong, lambda, 12);

        assert_ne!(weak_comp[9], weak_comp[10], "a weak seam at the step must be cut");
        assert_eq!(strong_comp[9], strong_comp[10], "a welded seam must survive the same lambda");
    }

    /// Degenerate inputs must not panic and must not invent structure.
    #[test]
    fn degenerate_inputs_return_something_sane() {
        // Constant signal: nothing to separate.
        let flat = vec![2.5f32; 30];
        let comp = cut_pursuit_l0(&flat, 30, 1, &chain(30), 1.0, 10);
        assert_eq!(n_components(&comp), 1, "a constant signal has no boundary to find");

        // No edges at all: every point is its own island, and the solver
        // must say so rather than fusing unrelated points.
        let feats: Vec<f32> = (0..10).map(|i| i as f32).collect();
        let comp = cut_pursuit_l0(&feats, 10, 1, &[], 1.0, 10);
        assert_eq!(n_components(&comp), 10, "unconnected points cannot be one component");

        // A single point.
        let comp = cut_pursuit_l0(&[1.0f32], 1, 1, &[], 1.0, 10);
        assert_eq!(comp.len(), 1);

        // Every point labelled — no gaps, whatever the input.
        let feats: Vec<f32> = (0..25).map(|i| ((i % 4) as f32) * 3.0).collect();
        let comp = cut_pursuit_l0(&feats, 25, 1, &chain(25), 0.7, 10);
        assert_eq!(comp.len(), 25);
    }

    /// Multi-dimensional features: a split must be driven by the whole
    /// vector, not just the first component. Segmentation feeds this 3-D
    /// position data, so a solver reading only x would still produce
    /// tidy-looking components — separated along the wrong axis.
    #[test]
    fn a_split_uses_every_feature_dimension() {
        let n = 40;
        // x is constant; the separation lives entirely in y.
        let mut feats = Vec::with_capacity(n * 3);
        for i in 0..n {
            feats.extend_from_slice(&[5.0f32, if i < 20 { 0.0 } else { 9.0 }, 0.0]);
        }
        let comp = cut_pursuit_l0(&feats, n, 3, &chain(n), 1.0, 12);
        assert_eq!(n_components(&comp), 2, "the separation is in y and must still be found");
        assert_ne!(comp[19], comp[20]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n_components(comp: &[u32]) -> usize {
        let mut s: Vec<u32> = comp.to_vec();
        s.sort_unstable();
        s.dedup();
        s.len()
    }

    #[test]
    fn dinic_matches_known_maxflow() {
        // Classic 4-node network (CLRS-style): value 23 becomes, with these
        // caps, a max flow of 5 on a tiny diamond.
        //   s=0, a=1, b=2, t=3
        //   s->a 3, s->b 2, a->b 1, a->t 2, b->t 3
        let mut mf = Dinic::new(4);
        mf.add_edge(0, 1, 3.0);
        mf.add_edge(0, 2, 2.0);
        mf.add_edge(1, 2, 1.0);
        mf.add_edge(1, 3, 2.0);
        mf.add_edge(2, 3, 3.0);
        let f = mf.max_flow(0, 3);
        // Max flow = min cut = 5 (saturate both sink edges: a->t 2 + b->t 3).
        assert!((f - 5.0).abs() < 1e-9, "max flow was {f}");
    }

    #[test]
    fn splits_two_constant_regions_on_a_path() {
        // Path 0-1-2-3-4-5, features 1-D: [0,0,0,5,5,5]. One clean boundary.
        let features = [0.0f32, 0.0, 0.0, 5.0, 5.0, 5.0];
        let edges = [(0u32, 1u32, 1.0f32), (1, 2, 1.0), (2, 3, 1.0), (3, 4, 1.0), (4, 5, 1.0)];
        // baseline energy of the whole = 6*(2.5^2) = 37.5; the {012}|{345}
        // split costs only λ·1, so any λ < 37.5 must split.
        let comp = cut_pursuit_l0(&features, 6, 1, &edges, 1.0, 20);
        assert_eq!(n_components(&comp), 2, "small λ must recover the two regions: {comp:?}");
        assert_eq!(comp[0], comp[1]);
        assert_eq!(comp[1], comp[2]);
        assert_eq!(comp[3], comp[4]);
        assert_eq!(comp[4], comp[5]);
        assert_ne!(comp[2], comp[3]);

        // A λ far above the baseline energy makes every cut too dear ⇒ one piece.
        let comp_big = cut_pursuit_l0(&features, 6, 1, &edges, 1000.0, 20);
        assert_eq!(n_components(&comp_big), 1, "large λ must keep one component: {comp_big:?}");
    }

    #[test]
    fn recovers_three_regions() {
        // Path of 9, three flat plateaus [0,0,0, 4,4,4, 8,8,8].
        let features = [0.0f32, 0.0, 0.0, 4.0, 4.0, 4.0, 8.0, 8.0, 8.0];
        let edges: Vec<(u32, u32, f32)> = (0..8).map(|i| (i, i + 1, 1.0)).collect();
        let comp = cut_pursuit_l0(&features, 9, 1, &edges, 1.0, 30);
        assert_eq!(n_components(&comp), 3, "should recover 3 plateaus: {comp:?}");
        assert_eq!(comp[0], comp[2]);
        assert_eq!(comp[3], comp[5]);
        assert_eq!(comp[6], comp[8]);
        assert_ne!(comp[2], comp[3]);
        assert_ne!(comp[5], comp[6]);
    }

    #[test]
    fn constant_graph_stays_one_component() {
        // No feature spread ⇒ nothing to gain from any cut.
        let features = [2.0f32; 5];
        let edges: Vec<(u32, u32, f32)> = (0..4).map(|i| (i, i + 1, 1.0)).collect();
        let comp = cut_pursuit_l0(&features, 5, 1, &edges, 0.001, 20);
        assert_eq!(n_components(&comp), 1, "flat features ⇒ one component: {comp:?}");
    }

    #[test]
    fn separates_two_2d_clusters() {
        // Two tight 2-D clusters joined by a single weak edge. d = 2.
        // cluster A around (0,0): verts 0,1,2 ; cluster B around (10,10): 3,4,5
        let features = [
            0.0f32, 0.1, 0.1, 0.0, -0.1, 0.0, // A
            10.0, 10.1, 10.1, 9.9, 9.9, 10.0, // B
        ];
        let mut edges: Vec<(u32, u32, f32)> = vec![
            (0, 1, 1.0), (1, 2, 1.0), (0, 2, 1.0),
            (3, 4, 1.0), (4, 5, 1.0), (3, 5, 1.0),
        ];
        edges.push((2, 3, 1.0)); // the bridge
        let comp = cut_pursuit_l0(&features, 6, 2, &edges, 1.0, 20);
        assert_eq!(n_components(&comp), 2, "two clusters expected: {comp:?}");
        assert_eq!(comp[0], comp[2]);
        assert_eq!(comp[3], comp[5]);
        assert_ne!(comp[2], comp[3]);
    }
}
