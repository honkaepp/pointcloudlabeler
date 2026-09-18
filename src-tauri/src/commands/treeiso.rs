// treeiso — Xi & Hopkinson 2022 (Remote Sensing 14(23):6116), "3D
// Graph-Based Individual-Tree Isolation from TLS". A bottom-up, trunk-
// aware individual-tree segmentation for dense terrestrial clouds; far
// better than a top-down CHM watershed where crowns interlock and the
// canopy hides the understorey.
//
// PORTED FROM THE AUTHORS' REFERENCE IMPLEMENTATION
//
//   Portions Copyright (c) 2022 Zhouxin Xi. MIT — the notice travels with
//   this file and is reproduced in full in THIRD-PARTY-NOTICES.md.
//
// github.com/truebelief/artemis_treeiso — `Matlab/treeiso.m` (the
// original, with `cutpursuit.m`, `overlapping.m`, `jitknnsearch.m`) and
// `Python/treeiso.py`. All three stages follow that code, including its
// parameter names and defaults (K1 = 5, λ1 = 1, K2 = 20, λ2 = 20,
// decimation 0.05 / 0.1 m, max gap 2 m, ρ = 0.5, w = 0.5, K3 = 20). The
// ℓ0 optimiser is our own `super::cutpursuit` rather than Landrieu's C++
// — see that module's header for how the two differ.
//
// Where this deliberately departs from the reference, and why:
//
//   * `overlapping()` — the reference rasterises both convex hulls into
//     a shared binary image at 10 px/m and counts pixels. This clips one
//     hull against the other and takes the exact intersection area: the
//     same ratio without the 0.1 m quantisation, and no dependence on
//     where the hulls happen to fall relative to the pixel grid. (The
//     MATLAB version also forgets to shift the hulls to the origin
//     before rasterising, so a plot at negative coordinates silently
//     scores 0 overlap everywhere; the Python version fixes that.)
//
//   * The stem identifier writes `toMergeIds[i] = i` in the Python port,
//     so group 0 — the lowest-numbered segment — can never be flagged,
//     because 0 also means "not flagged". MATLAB is 1-based and does not
//     have the bug. This follows MATLAB: a separate flag array.
//
//   * The reference's final "attach the never-merged segments" step
//     indexes `groupFeatures` / `groupVGroup` (positions from the START
//     of the last iteration) with positions derived from `clusterMapU`
//     (rebuilt at its END). Those two agree only when the last iteration
//     merged nothing. This recomputes the grouping from the final labels
//     instead, which is what the step is for.
//
//   * `min_tree_pts` is ours, not the reference's, and it is applied
//     BEFORE stage 3 as well as after. Stage 3's tail attaches every
//     never-a-stem segment to its nearest neighbour with no distance at
//     which it gives up, so without that a speck of noise across the plot
//     does not become a spurious tree — it becomes part of a real one,
//     fifty metres from its stem. The reference is entitled to that: it
//     tells you to remove the noise first.
//
//   * The iteration is capped (`MAX_REFINE_ITERS`). The reference's loop
//     has no bound; it stops when the number of flagged segments stops
//     changing, which is not a monotone quantity.
//
// The algorithm's own limit, measured rather than assumed: two crowns
// separate cleanly until a single stage-1 superpoint contains points from
// both of them, and fuse into one tree from there on — see
// `interlocking_crowns_separate_down_to_a_touching_boundary` for the
// numbers and the mechanism. Finer decimation is the lever against it.
//
// The cascade:
//
//   Stage 1 (over-segmentation): a 3D k-NN graph over the working points,
//     features = coordinates, unit edge weights, cut with a SMALL λ1 →
//     many small, geometrically-coherent "superpoints" (clusters).
//   Stage 2 (interim segmentation): each cluster is re-decimated at
//     `decimate2`, and every surviving point becomes a graph NODE. An
//     edge exists between two nodes only when they are k-NN of each
//     other AND their clusters are within `max_gap` measured cluster-to-
//     cluster, and it is weighted 0.1/(gap + 0.01) — so nearby clusters
//     bind tightly and a cluster across an occlusion gap does not bind at
//     all. Cut-pursuit on the HORIZONTAL (xy) coordinates with a larger
//     λ2 collapses a stem's vertical stack into one segment; each cluster
//     then takes the MODE of its nodes' labels.
//   Stage 3 (global edge refinement): iteratively, each segment gets a
//     trimmed-mean centroid, a minimum elevation and a vertical length. A
//     segment sitting high above its K3 neighbours relative to its own
//     length (ratio > ρ) is a crown fragment, not a stem, and is merged
//     into whichever neighbouring segment scores best on 2D convex-hull
//     overlap, 1D vertical overlap, and the 3D/2D nearest-cluster
//     distances, with the vertical term weighted by w. Longer fragments
//     go first. Whatever is still never-a-stem at the end attaches to its
//     nearest merged segment by minimum 3D cluster distance.
//
// The heavy stages run on a DECIMATED working set (the caller voxel-
// downsamples first); labels propagate back to full resolution by voxel
// key. This module is the pure algorithm — the octree gather /
// decimation / tree_id write-back live with the command that calls it —
// so it can be unit-tested on synthetic stems.

use rustc_hash::{FxHashMap, FxHashSet};
use std::cmp::Ordering;

use super::cutpursuit::cut_pursuit_l0;

pub struct TreeIsoParams {
    /// K1 — k for the stage-1 3D k-NN graph. Reference: 5.
    pub k1: usize,
    /// λ1 — stage-1 cut-pursuit regularisation (small → fine
    /// superpoints). Reference: 1.0.
    pub lambda1: f32,
    /// K2 — k for BOTH stage-2 k-NN searches (cluster centroids, and the
    /// decimated nodes). Reference: 20.
    pub k2: usize,
    /// λ2 — stage-2 cut-pursuit regularisation (larger → stem-length
    /// segments). Reference: 20.
    pub lambda2: f32,
    /// PR_DECIMATE_RES2 — each stage-1 cluster is re-decimated to this
    /// resolution (m) to make the stage-2 graph nodes. Reference: 0.1.
    pub decimate2: f32,
    /// PR_MAX_GAP — the largest point gap (m) assumed to be occlusion
    /// WITHIN one tree. Two clusters further apart than this never get a
    /// stage-2 edge, so cut-pursuit cannot fuse them. Reference: 2.0.
    pub max_gap: f32,
    /// K3 — k for the stage-3 segment-neighbourhood searches. Reference: 20.
    pub k3: usize,
    /// ρ (PR_REL_HEIGHT_LENGTH_RATIO) — a segment whose base sits this
    /// many of its own lengths above the lowest of its K3 neighbours is a
    /// crown fragment to be merged, not a stem. Reference: 0.5.
    pub rho: f32,
    /// w (PR_VERTICAL_WEIGHT) — how much the vertical-overlap term counts
    /// against the horizontal one when choosing what to merge a fragment
    /// into. Reference: 0.5.
    pub vertical_weight: f32,
    /// Ours, not the reference's: final clusters with fewer than this
    /// many working points come back unassigned (id 0).
    pub min_tree_pts: usize,
}

/// PR_SCORE_CANDIDATE_THRESH — a merge candidate stays in the running
/// while its score is within this fraction of the best.
const SCORE_CANDIDATE_THRESH: f32 = 0.7;
/// PR_INIT_STEM_REL_LENGTH_THRESH — on the first pass only the segments
/// longer than this multiple of their neighbours' median length are
/// merged, so the long trunk-like fragments claim their crowns first.
const INIT_STEM_REL_LENGTH_THRESH: f32 = 1.5;
/// The reference's `trimmean(pts, 0.2)` — 0.2 is a PERCENT, so this trims
/// 0.1 % off each tail. On anything under 500 points it is exactly the
/// plain mean, which is what the reference actually computes despite the
/// name.
const TRIM_PERCENT: f64 = 0.2;
/// The reference's refinement loop has no bound; it stops when the number
/// of flagged segments stops changing, which is not monotone.
const MAX_REFINE_ITERS: usize = 100;
/// Beyond this many shells a grid query gives up rather than sweeping the
/// whole grid for a point that has no neighbours anywhere near it.
const MAX_SHELLS: i32 = 64;
/// Not a segment: a stage-2 segment too small to be anything but noise.
/// Stage 3 never sees these, so they cannot be attached to a tree — see
/// where `min_tree_pts` is applied in `isolate_trees`.
const UNASSIGNED: u32 = u32::MAX;

/// Isolate individual trees. `points` is the (already decimated) working
/// set; returns a tree id per working point (0 = unassigned).
pub fn isolate_trees(points: &[[f32; 3]], p: &TreeIsoParams) -> Vec<u32> {
    let n = points.len();
    if n == 0 { return Vec::new(); }
    if n == 1 { return vec![u32::from(p.min_tree_pts <= 1)]; }

    // ---- Stage 1: 3D k-NN graph → cut-pursuit → superpoint clusters. ----
    let cluster_of_pt = stage1_clusters(points, p);
    let n_clusters = cluster_of_pt.iter().copied().max().unwrap_or(0) as usize + 1;

    let mut cluster_members: Vec<Vec<u32>> = vec![Vec::new(); n_clusters];
    for (i, &c) in cluster_of_pt.iter().enumerate() {
        cluster_members[c as usize].push(i as u32);
    }
    // The reference's per-cluster centroid is the mean over ALL the
    // cluster's points, not over its decimated nodes.
    let cluster_centroid: Vec<[f32; 3]> =
        cluster_members.iter().map(|m| mean_of(points, m)).collect();

    // ---- Stage 2: bottom-up 2D segmentation over the re-decimated nodes. ----
    let mut seg_of_cluster = stage2_segments(points, &cluster_members, &cluster_centroid, p);

    // ---- `min_tree_pts`, applied BEFORE the refinement. ----
    //
    // Ours, not the reference's, and it has to go here rather than only at
    // the end. Stage 3's tail attaches every never-a-stem segment to its
    // nearest neighbour UNCONDITIONALLY — there is no distance at which it
    // gives up — so a five-point speck of noise fifty metres from the plot
    // does not come back as a spurious tree, it comes back as part of a
    // real one, fifty metres from its stem, quietly wrecking that tree's
    // height and crown extent. The reference is entitled to that: it says
    // to remove the noise before running it. Dropping the too-small
    // segments here keeps that promise without touching the algorithm —
    // they never enter the refinement and end up unassigned.
    {
        let mut pts_per_seg: FxHashMap<u32, usize> = FxHashMap::default();
        for (c, m) in cluster_members.iter().enumerate() {
            *pts_per_seg.entry(seg_of_cluster[c]).or_default() += m.len();
        }
        for s in seg_of_cluster.iter_mut() {
            if pts_per_seg.get(s).copied().unwrap_or(0) < p.min_tree_pts { *s = UNASSIGNED; }
        }
    }

    // ---- Stage 3: iterative global edge refinement. ----
    let label_of_cluster =
        stage3_refine(points, &cluster_members, &cluster_centroid, &seg_of_cluster, p);

    // ---- Compose, drop the small clusters, and number 1..T. ----
    let mut pts_per_label: FxHashMap<u32, usize> = FxHashMap::default();
    for (c, m) in cluster_members.iter().enumerate() {
        *pts_per_label.entry(label_of_cluster[c]).or_default() += m.len();
    }
    // Numbered in order of FIRST APPEARANCE over the input points, never
    // in hash order: review.json and species.json are keyed by tree id and
    // are not cleared when isolation re-runs, so a permuted numbering
    // silently moves every review status onto a different tree.
    let mut id_of_label: FxHashMap<u32, u32> = FxHashMap::default();
    let mut next = 1u32;
    let mut out = vec![0u32; n];
    for (i, &c) in cluster_of_pt.iter().enumerate() {
        let l = label_of_cluster[c as usize];
        if l == UNASSIGNED || pts_per_label.get(&l).copied().unwrap_or(0) < p.min_tree_pts { continue; }
        let id = *id_of_label.entry(l).or_insert_with(|| { let x = next; next += 1; x });
        out[i] = id;
    }
    out
}

// ---------------------------------------------------------------------
// Stage 1 — initial 3D segmentation.
// ---------------------------------------------------------------------

fn stage1_clusters(points: &[[f32; 3]], p: &TreeIsoParams) -> Vec<u32> {
    let n = points.len();
    let grid = Grid::build(points, false);
    let k = p.k1.max(1);

    // The reference concatenates each node's neighbour list and hands the
    // pairs to cut-pursuit, which then adds a reverse edge for each — so
    // a MUTUAL k-NN pair is present twice and costs twice as much to cut.
    // Accumulating here reproduces that; deduplicating to weight 1 would
    // quietly halve λ1.
    let mut w: FxHashMap<(u32, u32), f32> = FxHashMap::default();
    let mut buf: Vec<(f32, u32)> = Vec::new();
    for (i, q) in points.iter().enumerate() {
        grid.knn(q, k, Some(i as u32), &mut buf);
        for &(_, j) in buf.iter() {
            *w.entry(canonical(i as u32, j)).or_insert(0.0) += 1.0;
        }
    }
    let edges = sorted_edges(w);

    // Centred, because cut-pursuit accumulates squared deviations in f32
    // and a plot at UTM-scale coordinates loses most of its mantissa to
    // the offset. The partition itself is translation-invariant.
    let c = centroid_of(points);
    let feat: Vec<f32> = points.iter()
        .flat_map(|q| [q[0] - c[0], q[1] - c[1], q[2] - c[2]])
        .collect();
    cut_pursuit_l0(&feat, n, 3, &edges, p.lambda1, 40)
}

// ---------------------------------------------------------------------
// Stage 2 — bottom-up 2D segmentation.
// ---------------------------------------------------------------------

fn stage2_segments(
    points: &[[f32; 3]],
    cluster_members: &[Vec<u32>],
    cluster_centroid: &[[f32; 3]],
    p: &TreeIsoParams,
) -> Vec<u32> {
    let nc = cluster_members.len();
    if nc <= 1 { return vec![0; nc]; }

    // (a) Re-decimate every cluster; each surviving point is a graph node.
    //     The reference keys the voxel grid off each cluster's OWN minimum
    //     and keeps one point per cell — which point is an arbitrary
    //     choice worth less than the cell size either way.
    let res = p.decimate2.max(1e-3);
    let mut dec: Vec<[f32; 3]> = Vec::new();
    let mut dec_cluster: Vec<u32> = Vec::new();
    let mut node_range: Vec<(u32, u32)> = Vec::with_capacity(nc);
    let mut seen: FxHashSet<(i32, i32, i32)> = FxHashSet::default();
    for (c, mem) in cluster_members.iter().enumerate() {
        let start = dec.len() as u32;
        let mut lo = [f32::INFINITY; 3];
        for &i in mem {
            for (a, l) in lo.iter_mut().enumerate() { *l = l.min(points[i as usize][a]); }
        }
        seen.clear();
        for &i in mem {
            let q = points[i as usize];
            let key = (
                ((q[0] - lo[0]) / res).floor() as i32,
                ((q[1] - lo[1]) / res).floor() as i32,
                ((q[2] - lo[2]) / res).floor() as i32,
            );
            if seen.insert(key) {
                dec.push(q);
                dec_cluster.push(c as u32);
            }
        }
        node_range.push((start, dec.len() as u32));
    }
    let cluster_bbox: Vec<([f32; 3], [f32; 3])> = node_range.iter()
        .map(|&(s, e)| bbox_of(&dec[s as usize..e as usize]))
        .collect();

    // (b) Each cluster's K2 nearest centroids (itself first), and the
    //     MINIMUM node-to-node distance to each of them. That distance is
    //     the "gap" the edge weight and the max_gap gate are built on.
    let kc = p.k2.max(1).min(nc);
    let cgrid = Grid::build(cluster_centroid, false);
    let mut centroid_nn: Vec<Vec<u32>> = Vec::with_capacity(nc);
    let mut gap: Vec<Vec<f32>> = Vec::with_capacity(nc);
    let mut memo: FxHashMap<(u32, u32), f32> = FxHashMap::default();
    let mut buf: Vec<(f32, u32)> = Vec::new();
    for c in 0..nc {
        cgrid.knn(&cluster_centroid[c], kc.saturating_sub(1), Some(c as u32), &mut buf);
        let mut nb: Vec<u32> = Vec::with_capacity(buf.len() + 1);
        nb.push(c as u32);
        nb.extend(buf.iter().map(|&(_, j)| j));
        let mut g = vec![0.0f32; nb.len()];
        for (t, &o) in nb.iter().enumerate().skip(1) {
            let key = canonical(c as u32, o);
            g[t] = match memo.get(&key) {
                Some(&d) => d,
                None => {
                    let (sa, ea) = node_range[c];
                    let (sb, eb) = node_range[o as usize];
                    let d = set_min_dist(
                        &dec[sa as usize..ea as usize], &dec[sb as usize..eb as usize],
                        &cluster_bbox[c], &cluster_bbox[o as usize], p.max_gap,
                    );
                    memo.insert(key, d);
                    d
                }
            };
        }
        centroid_nn.push(nb);
        gap.push(g);
    }

    // (c) The node graph. An edge survives only when the neighbour's
    //     cluster is among this cluster's K2 nearest AND the two clusters
    //     are within max_gap — the reference's occlusion gate, and the
    //     reason two stems either side of a void cannot fuse.
    let ngrid = Grid::build(&dec, false);
    let mut w: FxHashMap<(u32, u32), f32> = FxHashMap::default();
    for (i, q) in dec.iter().enumerate() {
        ngrid.knn(q, p.k2.max(1), Some(i as u32), &mut buf);
        let ci = dec_cluster[i] as usize;
        for &(_, j) in buf.iter() {
            let cj = dec_cluster[j as usize];
            let Some(t) = centroid_nn[ci].iter().position(|&x| x == cj) else { continue };
            let g = gap[ci][t];
            if g < p.max_gap {
                // 10/((gap + 0.01)/0.01). The reference's MATLAB drops the
                // +0.01 and so hands an intra-cluster pair (gap 0) an
                // INFINITE weight; the Python keeps it and caps at 10.
                *w.entry(canonical(i as u32, j)).or_insert(0.0) += 0.1 / (g + 0.01);
            }
        }
    }
    let edges = sorted_edges(w);

    // (d) Cut-pursuit on the HORIZONTAL coordinates only — that is what
    //     collapses a stem's vertical stack of clusters into one segment.
    let c2 = centroid_of(&dec);
    let feat: Vec<f32> = dec.iter().flat_map(|q| [q[0] - c2[0], q[1] - c2[1]]).collect();
    let node_seg = cut_pursuit_l0(&feat, dec.len(), 2, &edges, p.lambda2, 40);

    // (e) Every cluster takes the MODE of its nodes' labels; ties to the
    //     lowest label, as MATLAB's `mode` does.
    node_range.iter().map(|&(s, e)| {
        let mut count: FxHashMap<u32, usize> = FxHashMap::default();
        for &l in &node_seg[s as usize..e as usize] { *count.entry(l).or_default() += 1; }
        count.into_iter()
            .max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0)))
            .map(|(l, _)| l)
            .unwrap_or(0)
    }).collect()
}

// ---------------------------------------------------------------------
// Stage 3 — global edge refinement.
//
// Stage 2 leaves crowns over-segmented: a branch mass that never touched
// its own stem inside `max_gap` is its own segment, sitting high in the
// air. This is the reference's iterative repair. Each round it decides
// which segments are stems (they start low relative to their length) and
// which are floating fragments, and merges each fragment into the
// neighbour it fits best — hull overlap, vertical overlap, and how close
// the two segments' clusters actually come.
// ---------------------------------------------------------------------

/// What the refinement knows about one segment. Hulls are NOT here: they
/// are only needed for the segments that actually take part in a merge
/// decision, and hulling every segment every round is the expensive part.
struct GroupFeat {
    /// Trimmed-mean xyz over the segment's points.
    centroid: [f32; 3],
    /// Minimum z — the segment's "elevation", what the stem test reads.
    elev: f32,
    /// Vertical extent (max z − min z).
    length: f32,
}

// The negated float comparisons in here are deliberate and NaN-safe: a
// zero-length segment gives 0/0 for its height ratio, and `!(NaN > ρ)`
// skips it exactly as MATLAB's `NaN > x` does. Written the other way
// round — `rel.abs() <= p.rho` — a NaN would fall through and be flagged.
#[allow(clippy::neg_cmp_op_on_partial_ord)]
fn stage3_refine(
    points: &[[f32; 3]],
    cluster_members: &[Vec<u32>],
    cluster_centroid: &[[f32; 3]],
    seg_of_cluster: &[u32],
    p: &TreeIsoParams,
) -> Vec<u32> {
    let nc = cluster_members.len();
    let mut label = seg_of_cluster.to_vec();
    if nc <= 1 { return label; }

    // Label VALUES that have been a non-fragment ("remain") at least once.
    // Anything never in this set is attached by the tail step below.
    let mut ever_remained: FxHashSet<u32> = FxHashSet::default();
    let mut prev_flagged = 1usize; // the reference seeds numel(prevToMergeIds) = 1
    let mut flagged_n = 2usize;    //          and numel(toMergeIds) = 2
    let mut iter = 1usize;
    let mut buf: Vec<(f32, u32)> = Vec::new();

    while flagged_n != prev_flagged && flagged_n > 0 && iter <= MAX_REFINE_ITERS {
        prev_flagged = flagged_n;

        // Everything below is a SNAPSHOT taken at the top of the round.
        // Labels change as we merge, but the groups, features and cluster
        // sets do not until the next round — the reference works the same
        // way, and a fragment merged early in a round is therefore not yet
        // part of its new segment when a later fragment is scored.
        let (labels, groups) = group_by_label(&label);
        let ng = labels.len();
        if ng <= 1 { break; }

        let feats = group_features(points, cluster_members, &groups);
        let cent2: Vec<[f32; 3]> =
            feats.iter().map(|f| [f.centroid[0], f.centroid[1], 0.0]).collect();
        let ggrid = Grid::build(&cent2, true);

        // K3 nearest segments (self first), and σ_D, the mean distance
        // between a segment and its nearest neighbour.
        let k3 = p.k3.max(1).min(ng);
        let mut nn: Vec<Vec<u32>> = Vec::with_capacity(ng);
        let mut nearest_sum = 0f64;
        for (i, c) in cent2.iter().enumerate() {
            ggrid.knn(c, k3.saturating_sub(1), Some(i as u32), &mut buf);
            nearest_sum += buf.first().map(|&(d, _)| d as f64).unwrap_or(0.0);
            let mut v = Vec::with_capacity(buf.len() + 1);
            v.push(i as u32);
            v.extend(buf.iter().map(|&(_, j)| j));
            nn.push(v);
        }
        let sigma_d = ((nearest_sum / ng as f64) as f32).max(1e-6);

        // The stem identifier. A segment whose base is more than ρ of its
        // own length above the LOWEST base in its neighbourhood is not
        // standing on the ground — it is a crown fragment.
        //
        let mut flag = vec![0i64; ng];
        for i in 0..ng {
            let len = feats[i].length;
            if !(len > 0.0) { continue; }
            let min_elev = nn[i].iter()
                .map(|&g| feats[g as usize].elev)
                .fold(f32::INFINITY, f32::min);
            let rel = (feats[i].elev - min_elev) / len;
            if !(rel.abs() > p.rho) { continue; }
            let mut lens: Vec<f32> = nn[i].iter().map(|&g| feats[g as usize].length).collect();
            let med = median(&mut lens);
            // Positive = long enough to go first; negative = wait a round.
            flag[i] = if med > 0.0 && len / med > INIT_STEM_REL_LENGTH_THRESH {
                i as i64 + 1
            } else {
                -(i as i64 + 1)
            };
        }

        let remain: Vec<usize> = (0..ng).filter(|&i| flag[i] == 0).collect();
        let any_long = flag.iter().any(|&f| f > 0);
        let first_pass_long_only = iter == 1 && any_long;
        let to_merge: Vec<usize> = flag.iter()
            .filter(|&&f| f != 0 && !(first_pass_long_only && f < 0))
            .map(|&f| (f.abs() - 1) as usize)
            .collect();
        flagged_n = to_merge.len();

        for &i in &remain { ever_remained.insert(labels[i]); }
        if to_merge.is_empty() || remain.is_empty() { iter += 1; continue; }

        // Each fragment looks at the K3 nearest NON-fragment segments.
        let remain_cent: Vec<[f32; 3]> = remain.iter().map(|&i| cent2[i]).collect();
        let rgrid = Grid::build(&remain_cent, true);
        let kr = p.k3.max(1).min(remain.len());
        let mut hulls: Vec<Option<Option<Vec<[f64; 2]>>>> = vec![None; ng];

        for &tm in &to_merge {
            rgrid.knn(&cent2[tm], kr, None, &mut buf);
            let ca = gather(cluster_centroid, &groups[tm]);
            let (ba, ma) = (bbox_of(&ca), mean_all(&ca));
            // (score, min 3D cluster distance, group index)
            let mut cand: Vec<(f32, f32, usize)> = Vec::with_capacity(buf.len());
            for &(_, rj) in buf.iter() {
                let r = remain[rj as usize];

                // 1D vertical overlap of the two [base, top] intervals.
                let v = vertical_overlap_ratio(
                    feats[tm].elev, feats[tm].elev + feats[tm].length,
                    feats[r].elev, feats[r].elev + feats[r].length,
                );

                // 2D horizontal overlap of the two convex hulls.
                ensure_hull(tm, &mut hulls, points, cluster_members, &groups);
                ensure_hull(r, &mut hulls, points, cluster_members, &groups);
                let h = match (hulls[tm].as_ref().and_then(|h| h.as_deref()),
                               hulls[r].as_ref().and_then(|h| h.as_deref())) {
                    (Some(x), Some(y)) => hull_overlap_ratio(x, y),
                    _ => 0.0,
                };

                // How close the two segments' CLUSTER CENTROIDS come — in
                // 3D point-to-point, and in 2D centre-to-centre.
                let cb = gather(cluster_centroid, &groups[r]);
                let min3d = set_min_dist(&ca, &cb, &ba, &bbox_of(&cb), f32::INFINITY);
                let mb = mean_all(&cb);
                let min2d = ((mb[0] - ma[0]).powi(2) + (mb[1] - ma[1]).powi(2)).sqrt();

                let d = min3d.min(min2d) / sigma_d;
                let score = (-(1.0 - h).powi(2) - p.vertical_weight * (1.0 - v).powi(2) - d * d).exp();
                cand.push((if score.is_finite() { score } else { 0.0 }, min3d, r));
            }
            if cand.is_empty() { continue; }

            // Descending by score; `sort_by` is stable, so ties keep the
            // k-NN order exactly as MATLAB's `sort` would.
            let mut order: Vec<usize> = (0..cand.len()).collect();
            order.sort_by(|&x, &y| cand[y].0.partial_cmp(&cand[x].0).unwrap_or(Ordering::Equal));
            let top = cand[order[0]].0;
            if !(top > 0.0) { continue; }

            // Everything within SCORE_CANDIDATE_THRESH of the best is a
            // candidate; among those the smallest 3D gap wins.
            let short: Vec<usize> = order.iter().copied()
                .take_while(|&o| cand[o].0 / top > SCORE_CANDIDATE_THRESH)
                .collect();
            let pick = match short.len() {
                0 => continue,
                1 => short[0],
                _ => *short.iter()
                    .min_by(|&&a, &&b| cand[a].1.partial_cmp(&cand[b].1).unwrap_or(Ordering::Equal))
                    .unwrap(),
            };
            let target = labels[cand[pick].2];
            for &c in &groups[tm] { label[c as usize] = target; }
        }
        iter += 1;
    }

    // The tail: whatever was flagged as a fragment in every round it
    // existed, and still has its own label, attaches to the nearest
    // segment that WAS a stem, by minimum 3D cluster distance.
    let (labels, groups) = group_by_label(&label);
    let ng = labels.len();
    if ng > 1 {
        let orphans: Vec<usize> = (0..ng).filter(|&i| !ever_remained.contains(&labels[i])).collect();
        let anchors: Vec<usize> = (0..ng).filter(|&i| ever_remained.contains(&labels[i])).collect();
        if !orphans.is_empty() && !anchors.is_empty() {
            let feats = group_features(points, cluster_members, &groups);
            let cent2: Vec<[f32; 3]> =
                feats.iter().map(|f| [f.centroid[0], f.centroid[1], 0.0]).collect();
            let anchor_cent: Vec<[f32; 3]> = anchors.iter().map(|&i| cent2[i]).collect();
            let agrid = Grid::build(&anchor_cent, true);
            let k = p.k3.max(1).min(anchors.len());
            for &o in &orphans {
                agrid.knn(&cent2[o], k, None, &mut buf);
                let ca = gather(cluster_centroid, &groups[o]);
                let ba = bbox_of(&ca);
                let mut best: Option<(f32, u32)> = None;
                for &(_, aj) in buf.iter() {
                    let a = anchors[aj as usize];
                    let cb = gather(cluster_centroid, &groups[a]);
                    let d = set_min_dist(&ca, &cb, &ba, &bbox_of(&cb), f32::INFINITY);
                    let better = match best { None => true, Some((bd, _)) => d < bd };
                    if better { best = Some((d, labels[a])); }
                }
                if let Some((_, target)) = best {
                    for &c in &groups[o] { label[c as usize] = target; }
                }
            }
        }
    }
    label
}

/// Segments, keyed by their current label, in ASCENDING label order (the
/// reference's `unique` sorts, and stage 3's group indices are used to
/// index features and cluster sets interchangeably). `UNASSIGNED`
/// clusters are not a segment and are left out entirely.
fn group_by_label(label: &[u32]) -> (Vec<u32>, Vec<Vec<u32>>) {
    let mut labels: Vec<u32> = label.iter().copied().filter(|&l| l != UNASSIGNED).collect();
    labels.sort_unstable();
    labels.dedup();
    let pos: FxHashMap<u32, usize> =
        labels.iter().enumerate().map(|(i, &l)| (l, i)).collect();
    let mut groups: Vec<Vec<u32>> = vec![Vec::new(); labels.len()];
    for (c, &l) in label.iter().enumerate() {
        if let Some(&g) = pos.get(&l) { groups[g].push(c as u32); }
    }
    (labels, groups)
}

fn group_features(
    points: &[[f32; 3]],
    cluster_members: &[Vec<u32>],
    groups: &[Vec<u32>],
) -> Vec<GroupFeat> {
    let mut axis: [Vec<f32>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    groups.iter().map(|g| {
        for v in axis.iter_mut() { v.clear(); }
        let mut zmin = f32::INFINITY;
        let mut zmax = f32::NEG_INFINITY;
        for &c in g {
            for &i in &cluster_members[c as usize] {
                let q = points[i as usize];
                for (a, v) in axis.iter_mut().enumerate() { v.push(q[a]); }
                zmin = zmin.min(q[2]);
                zmax = zmax.max(q[2]);
            }
        }
        let m = axis[0].len();
        let trim = (m as f64 * TRIM_PERCENT / 100.0 / 2.0).round() as usize;
        GroupFeat {
            centroid: [
                trimmed_mean(&mut axis[0], trim),
                trimmed_mean(&mut axis[1], trim),
                trimmed_mean(&mut axis[2], trim),
            ],
            elev: if m == 0 { 0.0 } else { zmin },
            length: if m == 0 { 0.0 } else { zmax - zmin },
        }
    }).collect()
}

/// Fill in the convex hull of a segment's xy footprint, once. The outer
/// `Option` is "have we looked yet", the inner one is "is there a hull" —
/// `None` for a segment the reference would not hull at all (its
/// `size(groupPts,1) > 3` test) or whose footprint is degenerate.
fn ensure_hull(
    g: usize,
    cache: &mut [Option<Option<Vec<[f64; 2]>>>],
    points: &[[f32; 3]],
    cluster_members: &[Vec<u32>],
    groups: &[Vec<u32>],
) {
    if cache[g].is_none() {
        let mut xy: Vec<[f64; 2]> = Vec::new();
        for &c in &groups[g] {
            for &i in &cluster_members[c as usize] {
                xy.push([points[i as usize][0] as f64, points[i as usize][1] as f64]);
            }
        }
        cache[g] = Some(if xy.len() > 3 {
            let h = convex_hull(xy);
            if h.len() >= 3 { Some(h) } else { None }
        } else {
            None
        });
    }
}

// ---------------------------------------------------------------------
// Convex hulls and their overlap.
//
// The reference rasterises both hulls into a shared binary image at
// 10 px/m and divides pixel counts. This clips one convex polygon against
// the other and divides exact areas — the same ratio, without a 0.1 m
// quantisation that would swallow a small crown whole.
// ---------------------------------------------------------------------

/// Andrew's monotone chain. Returns the hull counter-clockwise with the
/// collinear points dropped, or fewer than 3 vertices if the input is
/// degenerate (all coincident, or a straight line).
fn convex_hull(mut pts: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(Ordering::Equal)
        .then(a[1].partial_cmp(&b[1]).unwrap_or(Ordering::Equal)));
    pts.dedup();
    if pts.len() < 3 { return pts; }

    let cross = |o: [f64; 2], a: [f64; 2], b: [f64; 2]| {
        (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    };
    let mut hull: Vec<[f64; 2]> = Vec::with_capacity(pts.len() + 1);
    for &q in pts.iter() {
        while hull.len() >= 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], q) <= 0.0 {
            hull.pop();
        }
        hull.push(q);
    }
    let lower = hull.len() + 1;
    for &q in pts.iter().rev() {
        while hull.len() >= lower && cross(hull[hull.len() - 2], hull[hull.len() - 1], q) <= 0.0 {
            hull.pop();
        }
        hull.push(q);
    }
    hull.pop(); // the first point is repeated at the end
    hull
}

/// Signed shoelace area of a simple polygon; positive for CCW.
fn poly_area(p: &[[f64; 2]]) -> f64 {
    if p.len() < 3 { return 0.0; }
    let mut s = 0.0;
    for i in 0..p.len() {
        let j = (i + 1) % p.len();
        s += p[i][0] * p[j][1] - p[j][0] * p[i][1];
    }
    s * 0.5
}

/// Sutherland–Hodgman: clip the convex polygon `subject` against every
/// edge of the convex, counter-clockwise polygon `clip`.
fn clip_convex(subject: &[[f64; 2]], clip: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut out: Vec<[f64; 2]> = subject.to_vec();
    for i in 0..clip.len() {
        if out.is_empty() { break; }
        let (a, b) = (clip[i], clip[(i + 1) % clip.len()]);
        // Inside = left of the directed edge a→b.
        let side = |q: [f64; 2]| (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
        let input = std::mem::take(&mut out);
        for j in 0..input.len() {
            let (cur, prev) = (input[j], input[(j + input.len() - 1) % input.len()]);
            let (sc, sp) = (side(cur), side(prev));
            if sc >= 0.0 {
                if sp < 0.0 {
                    let t = sp / (sp - sc);
                    out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
                }
                out.push(cur);
            } else if sp >= 0.0 {
                let t = sp / (sp - sc);
                out.push([prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])]);
            }
        }
    }
    out
}

/// 1D overlap of two [base, top] intervals, as the reference computes it:
/// the shorter of the two "reaches" over the longer, floored at 0 when
/// they do not overlap at all.
fn vertical_overlap_ratio(a0: f32, a1: f32, b0: f32, b1: f32) -> f32 {
    let (lo, hi) = ((b1 - a0).min(a1 - b0), (b1 - a0).max(a1 - b0));
    if hi > 0.0 { (lo / hi).max(0.0) } else { 0.0 }
}

/// The reference's `overlapping()`: the intersection area over the
/// SMALLER of the two hulls (max of the two ratios), so a fragment
/// entirely inside a crown scores 1 however big the crown is.
fn hull_overlap_ratio(a: &[[f64; 2]], b: &[[f64; 2]]) -> f32 {
    let (aa, ab) = (poly_area(a).abs(), poly_area(b).abs());
    if aa <= 0.0 || ab <= 0.0 { return 0.0; }
    let inter = poly_area(&clip_convex(a, b)).abs();
    ((inter / aa).max(inter / ab) as f32).clamp(0.0, 1.0)
}

// ---------------------------------------------------------------------
// A uniform-grid nearest-neighbour index.
//
// Exact, not approximate: shells are expanded until the k-th candidate is
// nearer than the radius the scanned shells are guaranteed to cover, so
// nothing closer can be hiding outside. That guarantee is why the cell
// size below has to be right — see `Grid::build`.
// ---------------------------------------------------------------------

struct Grid<'a> {
    pts: &'a [[f32; 3]],
    planar: bool,
    lo: [f32; 3],
    cell: f32,
    inv: f32,
    max_shell: i32,
    bins: FxHashMap<(i32, i32, i32), Vec<u32>>,
}

impl<'a> Grid<'a> {
    /// `planar` bins and measures in xy only — z is ignored entirely.
    fn build(pts: &'a [[f32; 3]], planar: bool) -> Grid<'a> {
        let dims = if planar { 2 } else { 3 };
        let mut lo = [f32::INFINITY; 3];
        let mut hi = [f32::NEG_INFINITY; 3];
        for q in pts {
            for a in 0..3 { lo[a] = lo[a].min(q[a]); hi[a] = hi[a].max(q[a]); }
        }
        if pts.is_empty() { lo = [0.0; 3]; hi = [0.0; 3]; }

        // Size the cell to hold about one point — but only over the axes
        // the points actually spread along. A stem is a line: its x and y
        // extents are ~0, and multiplying them into the volume drags the
        // geometric mean to the floor, putting every point alone in its
        // own cell with its true neighbours thousands of cells away.
        // Measuring only the axes that carry structure makes the cell
        // match the intrinsic dimension: a line gets spacing, a slab area.
        let span: Vec<f64> = (0..dims).map(|a| (hi[a] - lo[a]) as f64).collect();
        let max_span = span.iter().copied().fold(0.0f64, f64::max);
        let floor = (max_span * 1e-3).max(1e-9);
        let mut ext = 1.0f64;
        let mut eff = 0usize;
        for &s in &span { if s > floor { ext *= s; eff += 1; } }
        let cell = if eff == 0 || pts.is_empty() {
            1e-4
        } else {
            ((ext / pts.len() as f64).powf(1.0 / eff as f64) as f32).max(1e-4)
        };

        let inv = 1.0 / cell;
        let along = span.iter().fold(0.0f64, |m, &s| m.max(s / cell as f64)).ceil() as i32;
        let max_shell = (along + 1).clamp(2, MAX_SHELLS);

        let mut bins: FxHashMap<(i32, i32, i32), Vec<u32>> = FxHashMap::default();
        let mut g = Grid { pts, planar, lo, cell, inv, max_shell, bins: FxHashMap::default() };
        for (i, q) in pts.iter().enumerate() { bins.entry(g.key(q)).or_default().push(i as u32); }
        g.bins = bins;
        g
    }

    fn key(&self, q: &[f32; 3]) -> (i32, i32, i32) {
        (
            ((q[0] - self.lo[0]) * self.inv).floor() as i32,
            ((q[1] - self.lo[1]) * self.inv).floor() as i32,
            if self.planar { 0 } else { ((q[2] - self.lo[2]) * self.inv).floor() as i32 },
        )
    }

    fn dist2(&self, a: &[f32; 3], b: &[f32; 3]) -> f32 {
        let mut s = (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2);
        if !self.planar { s += (a[2] - b[2]).powi(2); }
        s
    }

    /// The `k` points nearest `q`, ascending by distance, written into
    /// `out` as (distance, index). `skip` drops one index — the query
    /// point itself, when querying the set the grid was built from. Ties
    /// break on the index, so the answer never depends on bin order.
    ///
    /// Exact. Shells stop only once the k-th candidate is nearer than the
    /// radius the scanned shells are GUARANTEED to cover; if that never
    /// happens the grid has not answered the question and the whole set is
    /// scanned instead. That fallback is not a rare-case nicety: three of
    /// the callers query a grid built over a DIFFERENT set (a fragment
    /// against the non-fragments, a cluster against its neighbour), so the
    /// query can sit far outside the indexed extent, in a cell the shells
    /// would need thousands of steps to walk back from. Answering "no
    /// neighbours" there reads exactly like "nothing to merge into".
    fn knn(&self, q: &[f32; 3], k: usize, skip: Option<u32>, out: &mut Vec<(f32, u32)>) {
        out.clear();
        if k == 0 || self.pts.is_empty() { return; }
        let (cx, cy, cz) = self.key(q);
        let zr = if self.planar { 0 } else { 1 };
        let mut r = 0i32;
        let mut exact = false;
        loop {
            for dz in -zr * r..=zr * r {
                for dy in -r..=r {
                    for dx in -r..=r {
                        // Only the new shell — the inner cells were scanned
                        // on an earlier pass.
                        if r > 0 && dx.abs() != r && dy.abs() != r && !(zr == 1 && dz.abs() == r) {
                            continue;
                        }
                        let Some(b) = self.bins.get(&(cx + dx, cy + dy, cz + dz)) else { continue };
                        for &j in b {
                            if skip == Some(j) { continue; }
                            out.push((self.dist2(q, &self.pts[j as usize]), j));
                        }
                    }
                }
            }
            if out.len() >= k {
                // Everything within r*cell has now been seen: a point in a
                // cell further out than shell r differs by at least r cells
                // along some axis, so it is at least r*cell away.
                let covered = (r as f32 * self.cell).powi(2);
                let (_, kth, _) = out.select_nth_unstable_by(k - 1, cmp_cand);
                if kth.0 <= covered { exact = true; break; }
            }
            // Nothing at all after a few shells means the query is not in
            // this grid's neighbourhood; walking out to the cap would cost
            // more than scanning every point.
            if r >= self.max_shell || (r >= 8 && out.is_empty()) { break; }
            r += 1;
        }
        if !exact {
            out.clear();
            for (j, o) in self.pts.iter().enumerate() {
                if skip == Some(j as u32) { continue; }
                out.push((self.dist2(q, o), j as u32));
            }
        }
        out.sort_unstable_by(cmp_cand);
        out.truncate(k);
        for e in out.iter_mut() { e.0 = e.0.sqrt(); }
    }
}

fn cmp_cand(a: &(f32, u32), b: &(f32, u32)) -> Ordering {
    a.0.partial_cmp(&b.0).unwrap_or(Ordering::Equal).then(a.1.cmp(&b.1))
}

// ---------------------------------------------------------------------
// Small numeric helpers.
// ---------------------------------------------------------------------

fn canonical(a: u32, b: u32) -> (u32, u32) { if a < b { (a, b) } else { (b, a) } }

/// Fold an accumulated edge map into the list cut-pursuit wants, sorted
/// so the optimiser sees the same graph in the same order every run.
fn sorted_edges(w: FxHashMap<(u32, u32), f32>) -> Vec<(u32, u32, f32)> {
    let mut e: Vec<(u32, u32, f32)> = w.into_iter().map(|((u, v), x)| (u, v, x)).collect();
    e.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    e
}

fn centroid_of(pts: &[[f32; 3]]) -> [f32; 3] {
    if pts.is_empty() { return [0.0; 3]; }
    let mut s = [0f64; 3];
    for q in pts { for a in 0..3 { s[a] += q[a] as f64; } }
    let n = pts.len() as f64;
    [(s[0] / n) as f32, (s[1] / n) as f32, (s[2] / n) as f32]
}

fn mean_of(pts: &[[f32; 3]], idx: &[u32]) -> [f32; 3] {
    if idx.is_empty() { return [0.0; 3]; }
    let mut s = [0f64; 3];
    for &i in idx { for a in 0..3 { s[a] += pts[i as usize][a] as f64; } }
    let n = idx.len() as f64;
    [(s[0] / n) as f32, (s[1] / n) as f32, (s[2] / n) as f32]
}

fn mean_all(pts: &[[f32; 3]]) -> [f32; 3] { centroid_of(pts) }

fn gather(pts: &[[f32; 3]], idx: &[u32]) -> Vec<[f32; 3]> {
    idx.iter().map(|&i| pts[i as usize]).collect()
}

/// MATLAB's `trimmean(x, percent)`: drop `trim` values off each tail and
/// average the rest. `trim == 0` is the plain mean, which is what the
/// reference's 0.2 % actually gives below 500 points.
fn trimmed_mean(v: &mut [f32], trim: usize) -> f32 {
    let m = v.len();
    if m == 0 { return 0.0; }
    if trim == 0 || 2 * trim >= m {
        return (v.iter().map(|&x| x as f64).sum::<f64>() / m as f64) as f32;
    }
    v.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let s: f64 = v[trim..m - trim].iter().map(|&x| x as f64).sum();
    (s / (m - 2 * trim) as f64) as f32
}

/// MATLAB's `median`: the middle value, or the mean of the two middles.
fn median(v: &mut [f32]) -> f32 {
    let m = v.len();
    if m == 0 { return 0.0; }
    v.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    if m % 2 == 1 { v[m / 2] } else { 0.5 * (v[m / 2 - 1] + v[m / 2]) }
}

fn bbox_of(pts: &[[f32; 3]]) -> ([f32; 3], [f32; 3]) {
    let mut lo = [f32::INFINITY; 3];
    let mut hi = [f32::NEG_INFINITY; 3];
    for q in pts {
        for a in 0..3 { lo[a] = lo[a].min(q[a]); hi[a] = hi[a].max(q[a]); }
    }
    (lo, hi)
}

/// Distance between two axis-aligned boxes — a lower bound on the
/// distance between any point of one set and any point of the other.
fn bbox_gap(a: &([f32; 3], [f32; 3]), b: &([f32; 3], [f32; 3])) -> f32 {
    let mut s = 0f32;
    for i in 0..3 {
        let d = (a.0[i] - b.1[i]).max(b.0[i] - a.1[i]).max(0.0);
        s += d * d;
    }
    s.sqrt()
}

/// The smallest distance between any point of `a` and any point of `b`.
/// `cutoff` only licenses an early bail: the answer is exact whenever it
/// is below `cutoff`, and at least `cutoff` otherwise, which is all the
/// max-gap gate needs. Pass `f32::INFINITY` for the exact value always.
fn set_min_dist(
    a: &[[f32; 3]], b: &[[f32; 3]],
    ba: &([f32; 3], [f32; 3]), bb: &([f32; 3], [f32; 3]),
    cutoff: f32,
) -> f32 {
    if a.is_empty() || b.is_empty() { return f32::INFINITY; }
    let lb = bbox_gap(ba, bb);
    if lb >= cutoff { return lb; }
    if a.len().saturating_mul(b.len()) <= 65_536 {
        let mut best = f32::INFINITY;
        for p in a {
            for q in b {
                let d = (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2);
                if d < best { best = d; if best == 0.0 { return 0.0; } }
            }
        }
        return best.sqrt();
    }
    let (big, small) = if a.len() >= b.len() { (a, b) } else { (b, a) };
    let g = Grid::build(big, false);
    let mut buf: Vec<(f32, u32)> = Vec::new();
    let mut best = f32::INFINITY;
    for q in small {
        g.knn(q, 1, None, &mut buf);
        if let Some(&(d, _)) = buf.first() { if d < best { best = d; } }
    }
    best
}


#[cfg(test)]
mod tests {
    use super::*;

    fn n_ids(ids: &[u32]) -> usize {
        let mut v: Vec<u32> = ids.iter().copied().filter(|&x| x != 0).collect();
        v.sort_unstable();
        v.dedup();
        v.len()
    }

    /// The reference's own parameters, with `min_tree_pts` low enough that
    /// a small synthetic cloud is not filtered away.
    fn reference(min_tree_pts: usize) -> TreeIsoParams {
        TreeIsoParams {
            k1: 5, lambda1: 1.0,
            k2: 20, lambda2: 20.0,
            decimate2: 0.1, max_gap: 2.0,
            k3: 20, rho: 0.5, vertical_weight: 0.5,
            min_tree_pts,
        }
    }

    #[test]
    fn isolates_two_separated_stems() {
        // Two vertical stems 5 m apart in xy, each 20 points up the z axis
        // with a hair of jitter so covariances aren't singular.
        let mut pts: Vec<[f32; 3]> = Vec::new();
        for t in 0..2 {
            let (bx, by) = if t == 0 { (0.0f32, 0.0) } else { (5.0, 5.0) };
            for i in 0..20 {
                let jx = ((i * 7) % 3) as f32 * 0.01;
                let jy = ((i * 5) % 3) as f32 * 0.01;
                pts.push([bx + jx, by + jy, i as f32 * 0.5]);
            }
        }
        let ids = isolate_trees(&pts, &reference(5));
        assert_eq!(n_ids(&ids), 2, "two stems → two trees: {ids:?}");
        assert_eq!(ids[0], ids[19], "stem A is one id");
        assert_eq!(ids[20], ids[39], "stem B is one id");
        assert_ne!(ids[0], ids[20], "A and B are distinct trees");
    }

    #[test]
    fn tiny_cluster_dropped_by_min_pts() {
        let pts = [[0.0f32, 0.0, 0.0], [0.05, 0.0, 0.1], [0.0, 0.05, 0.2]];
        let ids = isolate_trees(&pts, &reference(10));
        assert!(ids.iter().all(|&x| x == 0), "below min_tree_pts ⇒ unassigned: {ids:?}");
    }

    // ---------------------------------------------------------------
    // The pieces stage 3 is built out of. Each of these is a formula
    // straight from the reference, and each of them fails silently: a
    // wrong overlap ratio still produces a plausible-looking merge.
    // ---------------------------------------------------------------

    #[test]
    fn convex_hull_is_ccw_and_drops_interior_points() {
        let sq = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0], [0.5, 0.5], [0.2, 0.7]];
        let h = convex_hull(sq);
        assert_eq!(h.len(), 4, "the two interior points must not be on the hull: {h:?}");
        assert!(poly_area(&h) > 0.0, "the hull must come back counter-clockwise");
        assert!((poly_area(&h) - 1.0).abs() < 1e-9, "unit square area: {}", poly_area(&h));
    }

    #[test]
    fn convex_hull_of_a_line_is_degenerate() {
        let line: Vec<[f64; 2]> = (0..10).map(|i| [i as f64 * 0.1, 0.0]).collect();
        assert!(convex_hull(line).len() < 3, "a collinear set has no 2D hull");
    }

    #[test]
    fn hull_overlap_ratio_matches_hand_computed_areas() {
        let unit = convex_hull(vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]);
        assert!((hull_overlap_ratio(&unit, &unit) - 1.0).abs() < 1e-6, "identical hulls fully overlap");

        // Half-overlapping unit squares: intersection 0.5, both areas 1.
        let shifted = convex_hull(vec![[0.5, 0.0], [1.5, 0.0], [1.5, 1.0], [0.5, 1.0]]);
        assert!((hull_overlap_ratio(&unit, &shifted) - 0.5).abs() < 1e-6,
            "got {}", hull_overlap_ratio(&unit, &shifted));

        // Disjoint.
        let far = convex_hull(vec![[9.0, 9.0], [10.0, 9.0], [10.0, 10.0], [9.0, 10.0]]);
        assert_eq!(hull_overlap_ratio(&unit, &far), 0.0);

        // Contained: the ratio is taken over the SMALLER hull, so a
        // fragment sitting wholly inside a crown scores 1 — which is the
        // whole point of the reference's `max` of the two ratios.
        let small = convex_hull(vec![[0.2, 0.2], [0.4, 0.2], [0.4, 0.4], [0.2, 0.4]]);
        assert!((hull_overlap_ratio(&unit, &small) - 1.0).abs() < 1e-6,
            "got {}", hull_overlap_ratio(&unit, &small));

        // Negative coordinates: the MATLAB reference rasterises without
        // shifting to the origin and scores this 0. It must not.
        let a = convex_hull(vec![[-5.0, -5.0], [-4.0, -5.0], [-4.0, -4.0], [-5.0, -4.0]]);
        let b = convex_hull(vec![[-4.5, -5.0], [-3.5, -5.0], [-3.5, -4.0], [-4.5, -4.0]]);
        assert!((hull_overlap_ratio(&a, &b) - 0.5).abs() < 1e-6,
            "a plot at negative coordinates must overlap like any other: {}",
            hull_overlap_ratio(&a, &b));
    }

    #[test]
    fn vertical_overlap_ratio_is_the_references_formula() {
        // Identical spans overlap fully.
        assert!((vertical_overlap_ratio(0.0, 10.0, 0.0, 10.0) - 1.0).abs() < 1e-6);
        // A 2 m fragment at 8–10 m over a 0–10 m stem: reaches 2 and 10.
        assert!((vertical_overlap_ratio(8.0, 10.0, 0.0, 10.0) - 0.2).abs() < 1e-6);
        // Disjoint spans give a negative reach, floored at 0.
        assert_eq!(vertical_overlap_ratio(8.0, 10.0, 0.0, 5.0), 0.0);
        // Degenerate (zero-length, coincident) spans must not divide by 0.
        assert_eq!(vertical_overlap_ratio(3.0, 3.0, 3.0, 3.0), 0.0);
    }

    #[test]
    fn trimmed_mean_and_median_match_matlab() {
        // trim 0 is the plain mean — which is what the reference's 0.2 %
        // actually gives on anything under 500 points.
        let mut v = vec![1.0f32, 2.0, 3.0, 100.0];
        assert!((trimmed_mean(&mut v.clone(), 0) - 26.5).abs() < 1e-4);
        // One off each tail.
        assert!((trimmed_mean(&mut v, 1) - 2.5).abs() < 1e-4);
        // Over-trimming falls back to the plain mean rather than dividing
        // by zero.
        assert!((trimmed_mean(&mut [1.0f32, 2.0], 1) - 1.5).abs() < 1e-4);

        assert_eq!(median(&mut [3.0f32, 1.0, 2.0]), 2.0);
        assert_eq!(median(&mut [4.0f32, 1.0, 3.0, 2.0]), 2.5, "even count → mean of the middles");
    }

    /// The grid's exactness is load-bearing: the max-gap gate and the
    /// stage-3 candidate lists are both k-NN answers, and an approximate
    /// one silently changes which segments can merge at all.
    #[test]
    fn grid_knn_matches_brute_force() {
        let mut seed = 17u32;
        let mut rnd = || { seed = seed.wrapping_mul(1664525).wrapping_add(1013904223); ((seed >> 8) as f32 / 16_777_216.0) - 0.5 };
        for &planar in &[false, true] {
            let pts: Vec<[f32; 3]> = (0..400).map(|_| [10.0 * rnd(), 10.0 * rnd(), 4.0 * rnd()]).collect();
            let g = Grid::build(&pts, planar);
            let mut buf = Vec::new();
            for i in 0..pts.len() {
                g.knn(&pts[i], 8, Some(i as u32), &mut buf);
                let mut truth: Vec<(f32, u32)> = (0..pts.len() as u32)
                    .filter(|&j| j as usize != i)
                    .map(|j| (g.dist2(&pts[i], &pts[j as usize]).sqrt(), j))
                    .collect();
                truth.sort_unstable_by(cmp_cand);
                truth.truncate(8);
                let got: Vec<u32> = buf.iter().map(|&(_, j)| j).collect();
                let want: Vec<u32> = truth.iter().map(|&(_, j)| j).collect();
                assert_eq!(got, want, "planar={planar}, vertex {i}");
            }
        }
    }

    /// The degenerate extents that broke the old grid: a vertical line
    /// (two zero axes) and a flat slab (one). Sizing the cell from the
    /// product of all three extents collapses it to the floor, and every
    /// point ends up alone in its own cell with no neighbours at all.
    #[test]
    fn grid_handles_degenerate_extents() {
        let stem: Vec<[f32; 3]> = (0..40).map(|i| [0.0, 0.0, i as f32 * 0.25]).collect();
        let g = Grid::build(&stem, false);
        let mut buf = Vec::new();
        for (i, q) in stem.iter().enumerate() {
            g.knn(q, 5, Some(i as u32), &mut buf);
            assert_eq!(buf.len(), 5, "stem point {i} found no neighbours");
            assert!(buf[0].0 <= 0.26, "nearest neighbour of {i} is {:.3} m away", buf[0].0);
        }

        let coincident = vec![[1.0f32, 2.0, 3.0]; 20];
        let g = Grid::build(&coincident, false);
        g.knn(&coincident[0], 5, Some(0), &mut buf);
        assert_eq!(buf.len(), 5, "coincident points must still find each other");
        assert!(buf.iter().all(|&(d, _)| d == 0.0));
    }

    #[test]
    fn set_min_dist_is_the_true_minimum() {
        let a: Vec<[f32; 3]> = (0..50).map(|i| [0.0, 0.0, i as f32 * 0.1]).collect();
        let b: Vec<[f32; 3]> = (0..50).map(|i| [3.0, 0.0, i as f32 * 0.1]).collect();
        let d = set_min_dist(&a, &b, &bbox_of(&a), &bbox_of(&b), f32::INFINITY);
        assert!((d - 3.0).abs() < 1e-4, "got {d}");
        // Past the cutoff it is allowed to answer "at least this far", and
        // the answer must still be past the cutoff.
        let d = set_min_dist(&a, &b, &bbox_of(&a), &bbox_of(&b), 2.0);
        assert!(d >= 2.0, "the bail must not report a distance inside the cutoff: {d}");
    }
}

/// Adversarial tests for the isolation cascade.
///
/// The unit tests above check the formulas. These check the cases where a
/// wrong answer looks exactly like a right one — the failure mode that
/// matters here, because nothing downstream can tell a mis-numbered or
/// mis-split tree from a correct one.
#[cfg(test)]
mod stress_tests {
    use super::*;

    /// The parameters the UI actually ships (OctreeShellContext's
    /// DEFAULT_TREEISO_PARAMS), which are the reference's own. Tests that
    /// tune λ to make a case pass prove nothing about what a user gets.
    fn shipped() -> TreeIsoParams {
        TreeIsoParams {
            k1: 5, lambda1: 1.0,
            k2: 20, lambda2: 20.0,
            decimate2: 0.1, max_gap: 2.0,
            k3: 20, rho: 0.5, vertical_weight: 0.5,
            min_tree_pts: 20,
        }
    }

    /// Deterministic jitter — a fixed LCG, so a failure is reproducible
    /// rather than a coin flip that lands badly once a month in CI.
    fn lcg(seed: &mut u32) -> f32 {
        *seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        ((*seed >> 8) as f32 / 16_777_216.0) - 0.5
    }

    /// A stem plus a crown shell at (cx, cy) — the shape treeiso is for.
    /// `crown_r` is what makes neighbouring crowns interlock.
    fn tree(cx: f32, cy: f32, crown_r: f32, top: f32, seed: &mut u32) -> Vec<[f32; 3]> {
        let mut v = Vec::new();
        let stem_top = top - 1.1 * crown_r;
        let mut z = 0.0f32;
        while z < stem_top {
            for s in 0..4 {
                let a = s as f32 * std::f32::consts::FRAC_PI_2;
                v.push([
                    cx + 0.09 * a.cos() + 0.01 * lcg(seed),
                    cy + 0.09 * a.sin() + 0.01 * lcg(seed),
                    z + 0.01 * lcg(seed),
                ]);
            }
            z += 0.25;
        }
        let cz = top - crown_r * 0.55;
        let step = 0.45f32;
        let n = (2.0 * crown_r / step).ceil() as i32;
        for i in -n..=n {
            for j in -n..=n {
                for k in -n..=n {
                    let (dx, dy, dz) = (i as f32 * step, j as f32 * step, k as f32 * step * 0.7);
                    let r = (dx * dx + dy * dy + (dz / 0.7).powi(2)).sqrt();
                    if r > crown_r || r < crown_r - step { continue; }
                    v.push([
                        cx + dx + 0.02 * lcg(seed),
                        cy + dy + 0.02 * lcg(seed),
                        cz + dz + 0.02 * lcg(seed),
                    ]);
                }
            }
        }
        v
    }

    fn uniq(v: &[u32]) -> Vec<u32> {
        let mut s: Vec<u32> = v.to_vec();
        s.sort_unstable();
        s.dedup();
        s
    }

    /// How many points on one side of a two-tree cloud did NOT get that
    /// side's majority id — the crown points that leaked to the neighbour.
    fn leaked(side: &[u32]) -> usize {
        let mut best = (0u32, 0usize);
        for &c in &uniq(side) {
            let n = side.iter().filter(|&&x| x == c).count();
            if c != 0 && n > best.1 { best = (c, n); }
        }
        side.iter().filter(|&&x| x != best.0).count()
    }

    /// One tree must come back as ONE tree. Over-segmentation is the
    /// quieter half of the failure: a stem split from its own crown gives
    /// two plausible-looking trees, one of them a crown with no DBH.
    #[test]
    fn a_single_tree_is_not_fragmented() {
        let mut seed = 42u32;
        let t = tree(0.0, 0.0, 1.8, 11.0, &mut seed);
        let ids = isolate_trees(&t, &shipped());
        assert_eq!(uniq(&ids), vec![1], "one tree fragmented into {:?}", uniq(&ids));
    }

    /// A stem with no crown at all — a cropped-out trunk, or a stem-only
    /// working set. Two of the three grid extents are zero here, which is
    /// the shape that used to give every point an empty neighbour list.
    #[test]
    fn a_bare_vertical_stem_is_one_tree() {
        let stem: Vec<[f32; 3]> = (0..60).map(|i| [0.0, 0.0, i as f32 * 0.2]).collect();
        let ids = isolate_trees(&stem, &shipped());
        assert_eq!(uniq(&ids), vec![1], "a bare stem came back as {:?}", uniq(&ids));
    }

    /// Well-separated trees: the easy case, and the one that must be
    /// perfect. Any leakage here is a bug, not a limitation.
    #[test]
    fn separated_trees_are_labelled_cleanly() {
        let mut seed = 999u32;
        let mut pts = tree(0.0, 0.0, 1.8, 11.0, &mut seed);
        let na = pts.len();
        pts.extend(tree(6.0, 0.0, 1.8, 10.0, &mut seed));
        let ids = isolate_trees(&pts, &shipped());

        assert_eq!(uniq(&ids).len(), 2, "expected 2 trees, got {:?}", uniq(&ids));
        assert_eq!(uniq(&ids[..na]).len(), 1, "tree A split");
        assert_eq!(uniq(&ids[na..]).len(), 1, "tree B split");
        assert_ne!(ids[0], ids[na], "A and B got the same id");
        assert!(!ids.contains(&0), "no point should be left unassigned here");
    }

    /// Two bare stems must stay two trees at EVERY separation past
    /// `max_gap`, and the failure is not monotonic in the gap — which is
    /// why a test that picks one separation has even odds of missing it.
    ///
    /// This is what the reference's max-gap gate is for, and it replaces
    /// the reach heuristic this module used to need: a plain k-NN graph
    /// fills its quota of k whatever it costs, so a stem holding fewer
    /// than K2 clusters reaches across the void to the NEXT tree, and
    /// cutting those fabricated edges then costs λ2 apiece. Under the
    /// reference's stage 2 those edges are never created at all, because
    /// the two clusters are further apart than `max_gap`.
    #[test]
    fn bare_stems_stay_separate_at_every_distance() {
        let p = shipped(); // max_gap 2.0
        for dx in [3.0f32, 4.5, 6.0, 7.5, 9.0, 12.0, 25.0, 60.0] {
            let mut seed = 3u32;
            let mut v = Vec::new();
            for base in [0.0f32, dx] {
                for i in 0..30 {
                    v.push([base + 0.02 * lcg(&mut seed), 0.02 * lcg(&mut seed), i as f32 * 0.2]);
                }
            }
            let ids = isolate_trees(&v, &p);
            assert_eq!(
                uniq(&ids).len(), 2,
                "stems {dx} m apart (max_gap 2.0) came back as {:?}", uniq(&ids),
            );
            assert_eq!(uniq(&ids[..30]).len(), 1, "stem A split at {dx} m");
            assert_eq!(uniq(&ids[30..]).len(), 1, "stem B split at {dx} m");
        }
    }

    /// `max_gap` is the reference's occlusion gate, not a merge radius:
    /// two clusters further apart than it never get a stage-2 edge, so
    /// cut-pursuit cannot fuse them however cheap that would be.
    ///
    /// Driven at stage 2 directly, because end to end the gate is
    /// invisible — stage 3 exists to repair precisely what it blocks (see
    /// `an_occlusion_hole_in_a_stem_is_repaired_whatever_the_gate_allows`),
    /// so a whole-cascade test would pass with the gate deleted. λ2 is set
    /// absurdly high so cut-pursuit has no reason to cut ANY edge: the
    /// segment count is then a pure statement about which edges existed.
    #[test]
    fn max_gap_gates_the_stage2_graph() {
        let mut seed = 3u32;
        let mut cloud: Vec<[f32; 3]> = Vec::new();
        for base in [0.0f32, 1.5] {
            for i in 0..40 {
                cloud.push([base + 0.02 * lcg(&mut seed), 0.02 * lcg(&mut seed), i as f32 * 0.2]);
            }
        }
        let segments = |gap: f32| -> usize {
            let p = TreeIsoParams { max_gap: gap, lambda2: 1e6, ..shipped() };
            let c1 = stage1_clusters(&cloud, &p);
            let nc = c1.iter().copied().max().unwrap() as usize + 1;
            let mut mem: Vec<Vec<u32>> = vec![Vec::new(); nc];
            for (i, &c) in c1.iter().enumerate() { mem[c as usize].push(i as u32); }
            let cent: Vec<[f32; 3]> = mem.iter().map(|m| mean_of(&cloud, m)).collect();
            uniq(&stage2_segments(&cloud, &mem, &cent, &p)).len()
        };
        assert_eq!(segments(2.0), 1,
            "at max_gap 2.0 the 1.5 m gap is bridgeable and nothing should be cut");
        assert!(segments(0.5) >= 2,
            "at max_gap 0.5 no edge may cross the 1.5 m gap, whatever λ2 says");
    }

    /// The flip side, and the reason the gate has to be tested at stage 2:
    /// a stem with a metre and a half of missing returns in the middle is
    /// ONE tree either way. Stage 2 splits it when the gate is narrow, and
    /// stage 3's stem identifier notices that the upper half starts 4.4 m
    /// up while being only 5.9 m long and puts it back.
    #[test]
    fn an_occlusion_hole_in_a_stem_is_repaired_whatever_the_gate_allows() {
        let cloud = || -> Vec<[f32; 3]> {
            let mut seed = 3u32;
            let mut v = Vec::new();
            for i in 0..60 { let z = i as f32 * 0.1; v.push([0.02 * lcg(&mut seed), 0.02 * lcg(&mut seed), z]); }
            for i in 0..60 { let z = 4.4 + i as f32 * 0.1; v.push([0.02 * lcg(&mut seed), 0.02 * lcg(&mut seed), z]); }
            v
        };
        for gap in [2.0f32, 0.5] {
            let ids = isolate_trees(&cloud(), &TreeIsoParams { max_gap: gap, ..shipped() });
            assert_eq!(uniq(&ids), vec![1],
                "a 1.5 m hole in one stem came back as {:?} at max_gap {gap}", uniq(&ids));
        }
    }

    /// Stage 3, the part this module did not have before. A crown mass
    /// floating clear of its own stem is the over-segmentation stage 2
    /// leaves behind; the stem identifier is what notices that a segment
    /// starting 8 m up and only 2 m tall cannot be standing on the ground,
    /// and the score is what picks the stem underneath it rather than the
    /// stem next door.
    #[test]
    fn a_floating_crown_fragment_is_merged_into_the_stem_below_it() {
        let mut seed = 7u32;
        let mut pts: Vec<[f32; 3]> = Vec::new();
        // A 9 m stem at the origin.
        for i in 0..90 {
            pts.push([0.03 * lcg(&mut seed), 0.03 * lcg(&mut seed), i as f32 * 0.1]);
        }
        let stem_n = pts.len();
        // A crown blob 8–10 m up, centred over that stem but separated
        // from its top by more than max_gap so stage 2 cannot join them.
        for i in 0..6 {
            for j in 0..6 {
                for k in 0..6 {
                    pts.push([
                        -0.5 + i as f32 * 0.2 + 0.02 * lcg(&mut seed),
                        -0.5 + j as f32 * 0.2 + 0.02 * lcg(&mut seed),
                        11.5 + k as f32 * 0.2 + 0.02 * lcg(&mut seed),
                    ]);
                }
            }
        }
        let p = TreeIsoParams { max_gap: 1.0, min_tree_pts: 10, ..shipped() };

        // Without stage 3 the blob is its own segment: check the premise,
        // so this does not quietly become a test of nothing.
        let ids = isolate_trees(&pts, &p);
        assert_eq!(uniq(&ids), vec![1],
            "the floating crown must be merged into the stem below it, got {:?}", uniq(&ids));
        assert!(ids[..stem_n].iter().all(|&x| x == 1));
        assert!(ids[stem_n..].iter().all(|&x| x == 1));
    }

    /// …and it must merge into the RIGHT stem. Two stems, one crown
    /// fragment sitting over the second one: the score's job is to prefer
    /// the segment it overlaps horizontally over the one it does not.
    #[test]
    fn a_floating_fragment_picks_the_stem_it_sits_over() {
        let mut seed = 11u32;
        let mut pts: Vec<[f32; 3]> = Vec::new();
        for base in [0.0f32, 6.0] {
            for i in 0..90 {
                pts.push([base + 0.03 * lcg(&mut seed), 0.03 * lcg(&mut seed), i as f32 * 0.1]);
            }
        }
        let stems_n = pts.len();
        for i in 0..6 {
            for j in 0..6 {
                for k in 0..6 {
                    pts.push([
                        5.5 + i as f32 * 0.2 + 0.02 * lcg(&mut seed),
                        -0.5 + j as f32 * 0.2 + 0.02 * lcg(&mut seed),
                        11.5 + k as f32 * 0.2 + 0.02 * lcg(&mut seed),
                    ]);
                }
            }
        }
        let ids = isolate_trees(&pts, &TreeIsoParams { max_gap: 1.0, min_tree_pts: 10, ..shipped() });
        assert_eq!(uniq(&ids).len(), 2, "two stems and a fragment must give two trees: {:?}", uniq(&ids));
        assert_eq!(ids[stems_n], ids[stems_n - 1],
            "the fragment joined the far stem instead of the one underneath it");
        assert_ne!(ids[0], ids[stems_n], "…and it must not have dragged both stems together");
    }

    /// ρ is the stem identifier's only threshold. Raising it past the
    /// fragment's height-over-length ratio must stop the merge — if it
    /// does not, the parameter is not wired to anything.
    #[test]
    fn rho_controls_whether_a_fragment_counts_as_a_crown() {
        let mut seed = 7u32;
        let mut pts: Vec<[f32; 3]> = Vec::new();
        for i in 0..90 {
            pts.push([0.03 * lcg(&mut seed), 0.03 * lcg(&mut seed), i as f32 * 0.1]);
        }
        for i in 0..6 {
            for j in 0..6 {
                for k in 0..6 {
                    pts.push([
                        -0.5 + i as f32 * 0.2 + 0.02 * lcg(&mut seed),
                        -0.5 + j as f32 * 0.2 + 0.02 * lcg(&mut seed),
                        11.5 + k as f32 * 0.2 + 0.02 * lcg(&mut seed),
                    ]);
                }
            }
        }
        let base = TreeIsoParams { max_gap: 1.0, min_tree_pts: 10, ..shipped() };
        // The fragment sits 11.5 m up and is 1 m tall ⇒ ratio ≈ 11.5.
        let merged = isolate_trees(&pts, &TreeIsoParams { rho: 0.5, ..base });
        assert_eq!(uniq(&merged).len(), 1, "ρ = 0.5 must call this a crown fragment");
        let split = isolate_trees(&pts, &TreeIsoParams { rho: 50.0, ..base });
        assert_eq!(uniq(&split).len(), 2, "ρ = 50 must leave it alone: {:?}", uniq(&split));
    }

    /// Crowns touching. This is the case a top-down CHM watershed starts
    /// losing, and the reason treeiso exists — it must still be exact.
    #[test]
    fn trees_with_touching_crowns_stay_two() {
        let mut seed = 999u32;
        let mut pts = tree(0.0, 0.0, 1.8, 11.0, &mut seed);
        let na = pts.len();
        pts.extend(tree(4.0, 0.0, 1.8, 10.0, &mut seed)); // 3.6 m crowns, 4 m apart
        let ids = isolate_trees(&pts, &shipped());

        assert_eq!(uniq(&ids).len(), 2, "touching crowns merged/split: {:?}", uniq(&ids));
        assert_eq!(leaked(&ids[..na]), 0, "crown points leaked out of A");
        assert_eq!(leaked(&ids[na..]), 0, "crown points leaked out of B");
    }

    /// Crowns interlocking, swept to the limit — and this test says where
    /// that limit is, because the algorithm HAS one and a passing test
    /// that hides it is worse than no test.
    ///
    /// Two 3.6 m-wide crowns, stems moved together (604 points, shipped
    /// parameters). Measured:
    ///
    ///   stem gap   crown overlap   stage-1 superpoints spanning both   trees   mislabelled
    ///     6.0 m       none                   0                           2         0
    ///     4.5 m       none                   0                           2         0
    ///     4.0 m       none                   0                           2         0
    ///     3.6 m       touching               0                           2         0
    ///     3.2 m       0.4 m                  1                           2         1
    ///     3.0 m       0.6 m                  2                           1         —
    ///     2.5 m       1.1 m                  2                           1         —
    ///
    /// The crossover is not λ2's: it is exactly where a stage-1 superpoint
    /// first contains points from BOTH trees. Stage 2 weights an edge by
    /// the gap between the two nodes' clusters, so an intra-cluster pair
    /// gets the maximum weight (10) — separating the trees would mean
    /// cutting through the middle of a cluster at λ2·10 per edge, and it
    /// will not pay that. Once two crowns interpenetrate far enough that
    /// cut-pursuit groups their points together at 5 cm, treeiso reports
    /// one tree. That is the authors' algorithm, and it is a large part of
    /// why the paper reports ~86 % rather than ~100 %.
    ///
    /// Finer decimation is the lever a user has: stage 1 runs on the
    /// caller's voxel-decimated working set, and the reference decimates
    /// to 0.05 m for it.
    #[test]
    fn interlocking_crowns_separate_down_to_a_touching_boundary() {
        let cloud = |dx: f32| -> (Vec<[f32; 3]>, usize) {
            let mut seed = 999u32;
            let mut pts = tree(0.0, 0.0, 1.8, 11.0, &mut seed);
            let na = pts.len();
            pts.extend(tree(dx, 0.0, 1.8, 10.0, &mut seed));
            (pts, na)
        };

        // Down to touching, exactly two trees and nothing leaks.
        for dx in [6.0f32, 4.5, 4.0, 3.6] {
            let (pts, na) = cloud(dx);
            let ids = isolate_trees(&pts, &shipped());
            assert_eq!(uniq(&ids).len(), 2, "stems {dx} m apart gave {:?}", uniq(&ids));
            assert_eq!(leaked(&ids[..na]) + leaked(&ids[na..]), 0,
                "points leaked across the boundary at {dx} m");
        }

        // 0.4 m of overlap: still two trees, and the leakage is bounded
        // rather than hidden.
        let (pts, na) = cloud(3.2);
        let ids = isolate_trees(&pts, &shipped());
        assert_eq!(uniq(&ids).len(), 2, "0.4 m of crown overlap gave {:?}", uniq(&ids));
        let bad = leaked(&ids[..na]) + leaked(&ids[na..]);
        assert!(bad <= 5, "{bad} points on the wrong tree at 0.4 m overlap");

        // Past that they fuse — the documented limit. What must still hold
        // is that the answer is ONE clean tree and not a pile of
        // fragments or unassigned points, because that is what the rest of
        // the app has to render and measure.
        let (pts, _) = cloud(2.5);
        let ids = isolate_trees(&pts, &shipped());
        assert_eq!(uniq(&ids), vec![1],
            "1.1 m of crown overlap must fuse cleanly into one tree, got {:?}", uniq(&ids));
    }

    // ---------------------------------------------------------------
    // The output contract. review.json and species.json are keyed by
    // tree id and survive a re-run of isolation, so these are not
    // cosmetic properties.
    // ---------------------------------------------------------------

    /// The same cloud, segmented twice, must produce the same NUMBERS —
    /// not merely the same partition. Ids used to be handed out while
    /// iterating a `HashMap`, and std seeds a fresh `RandomState` per map,
    /// so every run permuted them and every saved review status landed on
    /// a different tree.
    #[test]
    fn tree_ids_are_reproducible() {
        let mut seed = 999u32;
        let mut pts = tree(0.0, 0.0, 1.8, 11.0, &mut seed);
        pts.extend(tree(6.0, 0.0, 1.8, 10.0, &mut seed));
        pts.extend(tree(0.0, 6.0, 1.6, 9.0, &mut seed));
        pts.extend(tree(6.0, 6.0, 1.7, 12.0, &mut seed));

        let first = isolate_trees(&pts, &shipped());
        assert!(uniq(&first).len() >= 2, "need several trees for the numbering to matter");
        for run in 1..8 {
            assert_eq!(
                isolate_trees(&pts, &shipped()), first,
                "run {run} numbered the same trees differently",
            );
        }
    }

    /// Ids must be exactly 1..T with no gaps: the viewer's colour ramp
    /// and the tree map index by id, and a hole reads as a missing tree.
    #[test]
    fn tree_ids_are_contiguous_from_one() {
        let mut seed = 5u32;
        let mut pts = tree(0.0, 0.0, 1.8, 11.0, &mut seed);
        pts.extend(tree(6.0, 0.0, 1.8, 10.0, &mut seed));
        pts.extend(tree(0.0, 6.0, 1.6, 9.0, &mut seed));
        let ids = isolate_trees(&pts, &shipped());

        let trees: Vec<u32> = uniq(&ids).into_iter().filter(|&x| x != 0).collect();
        assert_eq!(
            trees, (1..=trees.len() as u32).collect::<Vec<_>>(),
            "tree ids are not 1..T: {trees:?}",
        );
    }

    /// One label per input point, always — the caller indexes
    /// `tree_of_voxel[vi]` straight off this, so a short return is an
    /// out-of-bounds panic in the write-back and a long one silently
    /// mislabels.
    #[test]
    fn every_point_gets_exactly_one_label() {
        let mut seed = 11u32;
        for n in [2usize, 3, 17, 64] {
            let pts: Vec<[f32; 3]> = (0..n)
                .map(|_| [5.0 * lcg(&mut seed), 5.0 * lcg(&mut seed), 5.0 * lcg(&mut seed)])
                .collect();
            assert_eq!(isolate_trees(&pts, &shipped()).len(), n, "n = {n}");
        }
    }

    /// A small blob far from a real tree is noise, not a tree. It must
    /// come back unassigned rather than as an extra stem in the tally.
    #[test]
    fn min_tree_pts_drops_noise_but_keeps_the_tree() {
        let mut seed = 21u32;
        let mut pts = tree(0.0, 0.0, 1.8, 11.0, &mut seed);
        let na = pts.len();
        for i in 0..5 {
            pts.push([50.0 + 0.1 * i as f32, 50.0, 1.0 + 0.1 * i as f32]);
        }
        let ids = isolate_trees(&pts, &shipped()); // min_tree_pts = 20

        assert_eq!(uniq(&ids[..na]), vec![1], "the real tree must survive");
        assert!(
            ids[na..].iter().all(|&x| x == 0),
            "a 5-point blob was counted as a tree: {:?}", &ids[na..],
        );
    }

    /// Degenerate inputs must neither panic nor invent structure.
    #[test]
    fn degenerate_inputs_are_handled() {
        let p = shipped();

        assert!(isolate_trees(&[], &p).is_empty(), "empty in, empty out");
        assert_eq!(isolate_trees(&[[1.0, 2.0, 3.0]], &p), vec![0], "1 point < min_tree_pts");

        // Every point identical: one cluster if it clears min_tree_pts,
        // and never more than one — there is nothing to split.
        let same = vec![[1.0f32, 2.0, 3.0]; 25];
        assert_eq!(uniq(&isolate_trees(&same, &p)), vec![1], "identical points are one tree");
        let few = vec![[1.0f32, 2.0, 3.0]; 4];
        assert!(isolate_trees(&few, &p).iter().all(|&x| x == 0), "4 identical points are not a tree");

        // Two points, and two points a long way apart.
        assert_eq!(isolate_trees(&[[0.0, 0.0, 0.0], [0.0, 0.0, 1.0]], &p).len(), 2);
        assert_eq!(isolate_trees(&[[0.0, 0.0, 0.0], [1e4, 1e4, 1e4]], &p).len(), 2);

        // A tree far from the origin: the working set is offset-relative
        // in the caller, but nothing here may assume small coordinates.
        let mut seed = 8u32;
        let far = tree(2500.0, -1800.0, 1.8, 11.0, &mut seed);
        assert_eq!(uniq(&isolate_trees(&far, &p)), vec![1], "a tree away from the origin is still one tree");
    }
}


