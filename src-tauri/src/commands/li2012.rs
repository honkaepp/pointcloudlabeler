// Individual-tree segmentation from the point cloud, top down.
//
//   Li, W., Guo, Q., Jakubowski, M.K. & Kelly, M. 2012. A new method for
//   segmenting individual trees from the lidar point cloud.
//   Photogrammetric Engineering & Remote Sensing 78(1): 75–84.
//
// Implemented from the published method, and checked line by line against
// lidR's `C_li2012` (`src/LAS.cpp`, r-lidar/lidR), which its own docs
// describe as "an implementation by lidR authors, from the original
// paper, as close as possible from the original description".
//
// PointCloudLabeler already has two detectors and this is a third on purpose. The
// brief asks for accuracies to be COMPARED, and a method cannot be
// compared with itself:
//
//   * segment_chm  — local maxima on a canopy height model, then a
//     marker-controlled watershed. Fast, and it inherits every property
//     of the raster: a crown that never reaches the top of the CHM has
//     no maximum, so a suppressed tree under a dominant one does not
//     exist at all.
//   * treeiso      — cut-pursuit over the point cloud (Xi & Hopkinson
//     2022). Strong on interlocking crowns, slow, many knobs.
//   * this         — no raster anywhere. Points are walked in descending
//     height and grown into whichever tree they are nearest, so a
//     suppressed stem CAN be found: it needs only to be nearer its own
//     crown than anyone else's, not to be a local maximum.
//
// The three fail differently, which is the whole value of having them.
//
// The algorithm, from the paper:
//
//   1. Sort the points by height, descending.
//   2. The highest unassigned point seeds a new tree T.
//   3. Walk the rest in descending order. For each point u compute
//        dmin1 = horizontal distance to the nearest point already in T
//        dmin2 = horizontal distance to the nearest point already
//                rejected this round (i.e. belonging to some other tree)
//      and decide by whether u is a LOCAL MAXIMUM — the highest point
//      within `search_window`/2 horizontally, i.e. a possible treetop of
//      its own:
//        a local maximum joins T only if `dmin1 <= dt` AND
//          `dmin1 <= dmin2` — it has to be both close to this tree and
//          closer to it than to any other;
//        anything else joins T if `dmin1 <= dmin2`, with no distance
//          limit at all — a branch tip belongs to whichever crown it is
//          nearest, however far that is.
//   4. The rejected set becomes the working set; repeat from 2.
//
// `dt` is the spacing threshold, and it is height-dependent because
// crown WIDTH scales with tree height: the taller trees (points above
// `zu`) get the larger threshold, the understorey below it the smaller
// one. Note the direction — the paper's dt1 = 1.5 m is the value BELOW
// zu and dt2 = 2 m the value above, which is the opposite of what
// "narrow at the top, wide at the bottom" would suggest. It is about the
// size of the tree a point probably belongs to, not about where in one
// crown the point sits.

use rustc_hash::FxHashMap;

pub struct Li2012Params {
    /// dt1 — spacing threshold (m) for points at or BELOW `zu`, the
    /// understorey. The paper's value is 1.5 m.
    pub dt1: f32,
    /// dt2 — spacing threshold (m) for points ABOVE `zu`. Larger,
    /// because the trees up there are bigger and their crowns wider.
    /// The paper's value is 2 m.
    pub dt2: f32,
    /// Zu — height above ground (m) separating the two thresholds.
    pub zu: f32,
    /// R — the window (m, a DIAMETER: the search radius is half of it)
    /// a point must be the highest in to count as a local maximum, and
    /// so to be held to the `dt` limit at all. 0 makes every point a
    /// local maximum, which is much faster and is lidR's documented
    /// escape hatch.
    pub search_window: f32,
    /// Points below this height above ground are never assigned — they
    /// are understorey, not crown.
    pub min_height: f32,
    /// A cluster smaller than this is not reported as a tree. It goes
    /// back to unassigned (id 0) rather than becoming a one-point tree
    /// that every per-tree statistic downstream would then average in.
    /// Ours, not the paper's.
    pub min_tree_pts: usize,
}

impl Default for Li2012Params {
    fn default() -> Self {
        // The paper's own values for a mixed-conifer plot. They are a
        // starting point, not a constant of nature: the right dt is a
        // property of the stand's crown spacing and of the point spacing
        // the cloud was decimated to, so the panel exposes all three.
        Self {
            dt1: 1.5,
            dt2: 2.0,
            zu: 15.0,
            search_window: 2.0,
            min_height: 2.0,
            min_tree_pts: 30,
        }
    }
}

/// How far a point that is NOT a local maximum may reach for the tree it
/// is nearest. The paper's rule for those points has no distance limit at
/// all; the reference bounds every search at its `speed_up` radius,
/// documented as "maximum radius of a crown … any value greater than a
/// crown is good because this parameter does not affect the result", and
/// defaulting to 10 m. Same number, same reasoning.
const NON_MAXIMUM_REACH: f32 = 10.0;

/// Which points are the highest within `window`/2 horizontally — the
/// paper's local maxima, i.e. the points that could be a treetop and are
/// therefore held to the spacing threshold. `window <= 0` makes every
/// point a local maximum (the reference's `R = 0`).
///
/// Ties do not disqualify: a point is a local maximum unless something
/// STRICTLY higher is inside the window, so a flat top of equal-height
/// points is all maxima rather than none.
fn local_maxima(points: &[[f32; 3]], candidates: &[u32], window: f32) -> Vec<bool> {
    let mut lm = vec![true; points.len()];
    // NaN or non-positive: no window, so nothing is disqualified.
    if window.is_nan() || window <= 0.0 { return lm; }
    let r = window * 0.5;

    let mut grid: FxHashMap<(i32, i32), Vec<u32>> = FxHashMap::default();
    let inv = 1.0 / r;
    let key = |x: f32, y: f32| ((x * inv).floor() as i32, (y * inv).floor() as i32);
    for &i in candidates {
        let q = points[i as usize];
        grid.entry(key(q[0], q[1])).or_default().push(i);
    }
    let r2 = r * r;
    for &i in candidates {
        let q = points[i as usize];
        let (cx, cy) = key(q[0], q[1]);
        'outer: for gx in cx - 1..=cx + 1 {
            for gy in cy - 1..=cy + 1 {
                let Some(b) = grid.get(&(gx, gy)) else { continue };
                for &j in b {
                    if j == i { continue; }
                    let o = points[j as usize];
                    if o[2] > q[2] && (o[0] - q[0]).powi(2) + (o[1] - q[1]).powi(2) <= r2 {
                        lm[i as usize] = false;
                        break 'outer;
                    }
                }
            }
        }
    }
    lm
}

/// A uniform grid over the horizontal plane, for "is there a point of
/// this set within r of (x, y)?".
///
/// The sets grow only — a point joins the tree or joins the rejected
/// pile and never moves — so an insert-and-query grid is enough and no
/// deletion is ever needed. Rebuilt per round, which is why the cell
/// size is tied to the query radius rather than to the data.
struct Grid {
    inv: f32,
    /// Cell key → the points in it, as (x, y).
    cells: FxHashMap<(i32, i32), Vec<(f32, f32)>>,
}

impl Grid {
    fn new(cell: f32) -> Self {
        let c = if cell.is_finite() && cell > 1e-3 { cell } else { 1.0 };
        Self { inv: 1.0 / c, cells: FxHashMap::default() }
    }

    #[inline]
    fn key(&self, x: f32, y: f32) -> (i32, i32) {
        ((x * self.inv).floor() as i32, (y * self.inv).floor() as i32)
    }

    fn insert(&mut self, x: f32, y: f32) {
        self.cells.entry(self.key(x, y)).or_default().push((x, y));
    }

    /// Squared distance to the nearest inserted point within `r`, or
    /// None. Squared throughout: the comparisons the algorithm makes are
    /// all between distances, and a square root per candidate pair is
    /// the hot loop.
    fn nearest_within(&self, x: f32, y: f32, r: f32) -> Option<f32> {
        if self.cells.is_empty() { return None; }
        let r2 = r * r;
        // How many cells out the radius reaches. With cell == r this is
        // 1, so 9 cells are scanned; the guard keeps it correct if the
        // caller ever passes a radius larger than the cell.
        let span = (r * self.inv).ceil() as i32;
        let (cx, cy) = self.key(x, y);
        let mut best: Option<f32> = None;
        for gx in (cx - span)..=(cx + span) {
            for gy in (cy - span)..=(cy + span) {
                let Some(pts) = self.cells.get(&(gx, gy)) else { continue };
                for &(px, py) in pts {
                    let dx = px - x;
                    let dy = py - y;
                    let d2 = dx * dx + dy * dy;
                    // map_or, not is_none_or: the latter is stable only
                    // since Rust 1.82 and this crate declares 1.77.
                    if d2 <= r2 && best.map_or(true, |b| d2 < b) { best = Some(d2); }
                }
            }
        }
        best
    }
}

/// Segment `points` — each `[x, y, height_above_ground]`, in metres —
/// into individual trees.
///
/// Returns one id per input point, in input order: 1..=n for trees, and
/// 0 for a point that belongs to none (below `min_height`, or in a
/// cluster too small to call a tree).
pub fn segment_trees(points: &[[f32; 3]], p: &Li2012Params) -> Vec<u32> {
    let n = points.len();
    let mut out = vec![0u32; n];
    if n == 0 { return out; }

    let min_h = p.min_height;
    let dt1 = p.dt1.max(0.0);
    let dt2 = p.dt2.max(0.0);
    let dt_max = dt1.max(dt2);
    let zu = p.zu;

    // Candidates: everything tall enough, sorted by height descending.
    // Ties broken by index so the result does not depend on the order
    // the caller happened to build the slice in.
    let mut working: Vec<u32> = (0..n as u32)
        .filter(|&i| {
            let q = points[i as usize];
            q[0].is_finite() && q[1].is_finite() && q[2].is_finite() && q[2] >= min_h
        })
        .collect();
    working.sort_unstable_by(|&a, &b| {
        let (ha, hb) = (points[a as usize][2], points[b as usize][2]);
        hb.partial_cmp(&ha).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b))
    });

    // Which points are local maxima. The reference computes this ONCE
    // over the whole cloud, before any tree is grown, so a point's status
    // never changes as the rounds proceed — and it is deliberately over
    // the whole cloud rather than over the round's working set, or the
    // last few stragglers would all become "treetops" of their own.
    let is_lm = local_maxima(points, &working, p.search_window);

    let mut next_id: u32 = 1;
    // Members of the tree currently being grown, so it can be undone
    // when it turns out too small to be a tree.
    let mut members: Vec<u32> = Vec::new();

    while !working.is_empty() {
        // The highest remaining point is the treetop.
        let mut tree = Grid::new(NON_MAXIMUM_REACH.max(dt_max));
        let mut others = Grid::new(NON_MAXIMUM_REACH.max(dt_max));
        // The non-local-maximum branch has NO distance limit, so it
        // needs a radius the grid can still answer in. The reference
        // reaches the same place from the other side: it caps the search
        // at `speed_up` (default 10 m, documented as "any value greater
        // than a crown"), because a point further than that from the
        // seed cannot be in this tree anyway.
        let dt_far = NON_MAXIMUM_REACH.max(dt_max);
        let mut rejected: Vec<u32> = Vec::new();
        members.clear();

        let seed = working[0];
        let sp = points[seed as usize];
        tree.insert(sp[0], sp[1]);
        members.push(seed);

        for &ui in working.iter().skip(1) {
            let q = points[ui as usize];
            // A local maximum is held to the spacing threshold; anything
            // else is not, and goes to whichever tree it is nearest.
            let limit = if is_lm[ui as usize] {
                if q[2] > zu { dt2 } else { dt1 }
            } else {
                dt_far
            };
            // dmin1: nearest point of this tree, within the limit. Absent
            // means the point is further than that from the whole tree,
            // which is the paper's first rejection rule.
            let d1 = tree.nearest_within(q[0], q[1], limit);
            let take = match d1 {
                None => false,
                Some(d1sq) => {
                    // dmin2: nearest already-rejected point, i.e. the
                    // nearest point belonging to some other tree. Only
                    // needs looking for inside d1 — beyond that it
                    // cannot win the comparison.
                    match others.nearest_within(q[0], q[1], d1sq.sqrt()) {
                        Some(d2sq) => d1sq <= d2sq,
                        None => true,
                    }
                }
            };
            if take {
                tree.insert(q[0], q[1]);
                members.push(ui);
            } else {
                others.insert(q[0], q[1]);
                rejected.push(ui);
            }
        }

        if members.len() >= p.min_tree_pts.max(1) {
            for &i in &members { out[i as usize] = next_id; }
            next_id += 1;
        } else {
            // Too small to be a tree. Its points are NOT thrown back
            // into the working set: they lost to this seed once and the
            // next round would re-run the same comparison with the same
            // answer, forever. They stay unassigned, which is the honest
            // outcome — something was there and it was not a tree.
            for &i in &members { out[i as usize] = 0; }
        }

        // Every round must shrink the working set, or this loop does not
        // terminate. It does: the seed always joins its own tree, so at
        // least one point leaves `working` each time.
        debug_assert!(rejected.len() < working.len());
        working = rejected;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cone of points around (cx, cy) whose top is at `top` metres and
    /// whose crown widens toward the bottom — the shape the spacing
    /// threshold is meant to follow.
    fn crown(cx: f32, cy: f32, top: f32, rings: usize) -> Vec<[f32; 3]> {
        let mut v = vec![[cx, cy, top]];
        for r in 1..=rings {
            let frac = r as f32 / rings as f32;
            let h = top - frac * top * 0.6;
            let rad = 0.35 * frac * top * 0.25;
            for k in 0..8 {
                let a = k as f32 * std::f32::consts::TAU / 8.0;
                v.push([cx + rad * a.cos(), cy + rad * a.sin(), h]);
            }
        }
        v
    }

    fn params(min_pts: usize) -> Li2012Params {
        Li2012Params { min_tree_pts: min_pts, ..Default::default() }
    }

    fn ids_of(out: &[u32], from: usize, len: usize) -> Vec<u32> {
        out[from..from + len].to_vec()
    }

    #[test]
    fn finds_two_well_separated_trees() {
        let a = crown(0.0, 0.0, 20.0, 3);
        let b = crown(12.0, 0.0, 18.0, 3);
        let mut pts = a.clone();
        pts.extend_from_slice(&b);

        let out = segment_trees(&pts, &params(5));
        let ida = ids_of(&out, 0, a.len());
        let idb = ids_of(&out, a.len(), b.len());

        // Each crown is one tree, and the two are different trees.
        assert!(ida.iter().all(|&i| i != 0 && i == ida[0]), "crown A split: {ida:?}");
        assert!(idb.iter().all(|&i| i != 0 && i == idb[0]), "crown B split: {idb:?}");
        assert_ne!(ida[0], idb[0]);
    }

    #[test]
    fn the_tallest_point_seeds_the_first_tree() {
        let mut pts = crown(0.0, 0.0, 15.0, 2);
        pts.extend_from_slice(&crown(20.0, 0.0, 25.0, 2));
        let out = segment_trees(&pts, &params(3));
        // The 25 m crown starts at index a.len(); it must be tree 1.
        let first_of_tall = out[crown(0.0, 0.0, 15.0, 2).len()];
        assert_eq!(first_of_tall, 1, "the tallest crown should be found first");
    }

    /// The reason this detector exists. A suppressed stem under a
    /// dominant crown has no local maximum on a canopy height model, so
    /// the CHM watershed cannot see it at all. Here it needs only to be
    /// nearer its own points than anyone else's.
    #[test]
    fn finds_a_suppressed_tree_with_no_local_maximum() {
        let dominant = crown(0.0, 0.0, 24.0, 4);
        // A small tree 5 m away, entirely below the dominant canopy.
        let suppressed = crown(5.0, 0.0, 9.0, 3);
        let mut pts = dominant.clone();
        pts.extend_from_slice(&suppressed);

        let out = segment_trees(&pts, &params(5));
        let idd = ids_of(&out, 0, dominant.len());
        let ids = ids_of(&out, dominant.len(), suppressed.len());
        assert!(ids.iter().all(|&i| i != 0), "suppressed tree was not found");
        assert_ne!(ids[0], idd[0], "suppressed tree merged into the dominant one");
    }

    /// The rule at the heart of the method, and the only one that fires
    /// when crowns interlock: a point can be INSIDE the spacing threshold
    /// of the tree being grown and still belong to a different tree,
    /// because it is nearer a point that tree already rejected.
    ///
    /// Geometry, all above the 15 m cutoff so dt is 1.5 m:
    ///   A top at (0.0, 0), 20 m   — seeds tree 1
    ///   B top at (2.5, 0), 19 m   — 2.5 m from A, beyond dt, rejected
    ///   P      at (1.4, 0), 18 m  — 1.4 m from A (inside dt!) but only
    ///                               1.1 m from B, so it is B's.
    ///
    /// Drop the comparison and P is swallowed by A: two interlocking
    /// crowns become one fat tree and one thin one, with no error
    /// anywhere to say so.
    #[test]
    fn a_point_inside_the_threshold_still_goes_to_the_nearer_tree() {
        let pts = vec![
            [0.0f32, 0.0, 20.0],   // 0: A top
            [2.5, 0.0, 19.0],      // 1: B top
            [1.4, 0.0, 18.0],      // 2: P — inside A's dt, nearer B
        ];
        let out = segment_trees(&pts, &Li2012Params {
            dt1: 1.5, dt2: 2.0, zu: 15.0, search_window: 2.0,
            min_height: 2.0, min_tree_pts: 1,
        });
        assert_ne!(out[0], out[1], "the two crowns should be different trees");
        assert_eq!(out[2], out[1], "P is nearer B, so it belongs to B");
        assert_ne!(out[2], out[0], "P was swallowed by the tree it merely sat inside");
    }

    #[test]
    fn leaves_understorey_below_min_height_unassigned() {
        let mut pts = crown(0.0, 0.0, 20.0, 3);
        let n_crown = pts.len();
        // Ground clutter at 0.5 m — below the 2 m default.
        for k in 0..20 { pts.push([k as f32 * 0.3, 0.0, 0.5]); }

        let out = segment_trees(&pts, &params(5));
        assert!(out[n_crown..].iter().all(|&i| i == 0), "understorey was assigned to a tree");
        assert!(out[..n_crown].iter().all(|&i| i != 0));
    }

    /// A handful of points is not a tree. Reporting it as one puts a
    /// phantom stem into every per-tree statistic downstream.
    #[test]
    fn a_cluster_too_small_is_not_a_tree() {
        let pts = crown(0.0, 0.0, 20.0, 2);   // 17 points
        assert!(pts.len() < 30);
        let out = segment_trees(&pts, &Li2012Params { min_tree_pts: 30, ..Default::default() });
        assert!(out.iter().all(|&i| i == 0), "a 9-point cluster was called a tree");

        // …and with the threshold lowered, the same points are a tree.
        let out2 = segment_trees(&pts, &params(5));
        assert!(out2.iter().all(|&i| i == 1));
    }


    /// The direction of the height-dependent threshold, which this code
    /// had backwards. dt2 (the LARGER, 2 m) applies ABOVE zu and dt1
    /// (1.5 m) below — because crown width scales with tree height, so
    /// the big trees up top need the wider spacing, not the narrower one.
    ///
    /// Two points 1.8 m apart sit between the two thresholds, so the
    /// answer is opposite on the two sides of zu — and inverting the
    /// mapping swaps both answers without producing anything that looks
    /// wrong on its own.
    #[test]
    fn the_larger_threshold_applies_above_zu_not_below() {
        let p = || Li2012Params { min_tree_pts: 1, ..Default::default() }; // dt1 1.5, dt2 2, zu 15

        // Both above zu ⇒ dt2 = 2 m ⇒ 1.8 m is inside ⇒ one tree.
        let high = segment_trees(&[[0.0f32, 0.0, 20.0], [1.8, 0.0, 19.0]], &p());
        assert_eq!(high[0], high[1], "above zu the 2 m threshold applies, so 1.8 m is one tree");

        // Both below zu ⇒ dt1 = 1.5 m ⇒ 1.8 m is outside ⇒ two trees.
        let low = segment_trees(&[[0.0f32, 0.0, 10.0], [1.8, 0.0, 9.0]], &p());
        assert_ne!(low[0], low[1], "below zu the 1.5 m threshold applies, so 1.8 m is two trees");
    }

    /// `local_maxima` is the paper's "is this point a possible treetop",
    /// and the window is a DIAMETER — the search radius is half of it,
    /// which is easy to get wrong by a factor of two in either direction.
    #[test]
    fn local_maxima_uses_half_the_window_as_its_radius() {
        //   0: (0,0,10)  the tallest
        //   1: (0.9,0,9) inside a 2 m window (radius 1) of point 0
        //   2: (1.5,0,9) outside it
        let pts = [[0.0f32, 0.0, 10.0], [0.9, 0.0, 9.0], [1.5, 0.0, 9.0]];
        let all: Vec<u32> = (0..3).collect();
        let lm = local_maxima(&pts, &all, 2.0);
        assert_eq!(lm, vec![true, false, true], "radius must be window/2 = 1 m");

        // A window of 0 makes everything a maximum — the reference's R=0.
        assert_eq!(local_maxima(&pts, &all, 0.0), vec![true, true, true]);

        // Equal heights do not disqualify each other, so a flat top is
        // all maxima rather than none.
        let flat = [[0.0f32, 0.0, 5.0], [0.3, 0.0, 5.0]];
        assert_eq!(local_maxima(&flat, &[0, 1], 2.0), vec![true, true]);
    }

    /// The two branches of the rule. A point that could be a treetop of
    /// its own is held to `dt`; a point that could not is not held to it
    /// at all and simply goes to whichever crown it is nearest.
    ///
    /// The window has to be wider than `dt` for the difference to show:
    /// at the reference's defaults (window 2 m, radius 1 m; dt 1.5–2 m)
    /// the disqualifying neighbour is always nearer than `dt`, so within
    /// a single round the two branches agree. They part company across
    /// rounds, once that neighbour has gone to an earlier tree.
    #[test]
    fn a_point_that_cannot_be_a_treetop_is_not_held_to_the_threshold() {
        // 2.5 m apart, both above zu ⇒ dt2 = 2 m ⇒ outside the threshold.
        let pts = [[0.0f32, 0.0, 20.0], [2.5, 0.0, 18.0]];

        // Treated as a local maximum: rejected, and becomes its own tree.
        let strict = segment_trees(&pts, &Li2012Params {
            search_window: 0.0, min_tree_pts: 1, ..Default::default()
        });
        assert_ne!(strict[0], strict[1], "a treetop 2.5 m out is past dt2 and must not join");

        // Not a local maximum (a 6 m window puts it inside the seed's
        // 3 m radius, and it is lower): the threshold does not apply.
        let loose = segment_trees(&pts, &Li2012Params {
            search_window: 6.0, min_tree_pts: 1, ..Default::default()
        });
        assert_eq!(loose[0], loose[1], "a non-treetop goes to the nearest crown, dt or no dt");
    }

    #[test]
    fn tree_ids_are_contiguous_from_one() {
        let mut pts = Vec::new();
        for k in 0..4 { pts.extend_from_slice(&crown(k as f32 * 14.0, 0.0, 20.0 - k as f32, 3)); }
        let out = segment_trees(&pts, &params(5));
        let mut ids: Vec<u32> = out.iter().copied().filter(|&i| i != 0).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids, vec![1, 2, 3, 4]);
    }

    #[test]
    fn every_point_gets_exactly_one_id() {
        let mut pts = crown(0.0, 0.0, 20.0, 3);
        pts.extend_from_slice(&crown(12.0, 0.0, 17.0, 3));
        let out = segment_trees(&pts, &params(5));
        assert_eq!(out.len(), pts.len());
    }

    /// A result that depends on the order the caller built the slice in
    /// is a coincidence, not a segmentation.
    #[test]
    fn is_order_independent() {
        let mut pts = crown(0.0, 0.0, 20.0, 3);
        pts.extend_from_slice(&crown(12.0, 3.0, 18.0, 3));
        pts.extend_from_slice(&crown(4.0, 14.0, 22.0, 3));

        let a = segment_trees(&pts, &params(5));
        let mut rev: Vec<[f32; 3]> = pts.clone();
        rev.reverse();
        let b = segment_trees(&rev, &params(5));

        // Compare as a partition: same groups, whatever the ids.
        let group = |ids: &[u32], pts: &[[f32; 3]]| {
            let mut g: Vec<(u32, Vec<String>)> = Vec::new();
            let mut by: FxHashMap<u32, Vec<String>> = FxHashMap::default();
            for (i, &id) in ids.iter().enumerate() {
                if id == 0 { continue; }
                by.entry(id).or_default().push(format!("{:.3},{:.3}", pts[i][0], pts[i][1]));
            }
            for (k, mut v) in by { v.sort(); g.push((k, v)); }
            let mut only: Vec<Vec<String>> = g.into_iter().map(|(_, v)| v).collect();
            only.sort();
            only
        };
        assert_eq!(group(&a, &pts), group(&b, &rev));
    }

    #[test]
    fn survives_degenerate_input() {
        assert!(segment_trees(&[], &Li2012Params::default()).is_empty());
        // All below min_height.
        let low = vec![[0.0, 0.0, 0.1], [1.0, 0.0, 0.2]];
        assert_eq!(segment_trees(&low, &params(1)), vec![0, 0]);
        // One point, min_tree_pts 1.
        assert_eq!(segment_trees(&[[0.0, 0.0, 10.0]], &params(1)), vec![1]);
    }

    #[test]
    fn ignores_a_point_with_no_position() {
        let mut pts = crown(0.0, 0.0, 20.0, 3);
        let n = pts.len();
        pts.push([f32::NAN, 0.0, 15.0]);
        pts.push([0.0, f32::NAN, 15.0]);
        pts.push([0.0, 0.0, f32::NAN]);
        let out = segment_trees(&pts, &params(5));
        assert!(out[n..].iter().all(|&i| i == 0), "a point with no position was assigned");
    }

    /// Every round must remove at least the seed, or the loop never
    /// ends. The pathological case is many points at one spot.
    #[test]
    fn terminates_on_coincident_points() {
        let pts = vec![[3.0f32, 4.0, 12.0]; 200];
        let out = segment_trees(&pts, &params(1));
        assert!(out.iter().all(|&i| i == 1), "coincident points should be one tree");
    }

    #[test]
    fn a_wider_threshold_merges_what_a_narrow_one_splits() {
        let mut pts = crown(0.0, 0.0, 20.0, 3);
        pts.extend_from_slice(&crown(3.0, 0.0, 19.5, 3));
        let count = |p: &Li2012Params| {
            let out = segment_trees(&pts, p);
            let mut ids: Vec<u32> = out.iter().copied().filter(|&i| i != 0).collect();
            ids.sort_unstable(); ids.dedup(); ids.len()
        };
        let narrow = count(&Li2012Params { dt1: 0.6, dt2: 0.6, min_tree_pts: 3, ..Default::default() });
        let wide = count(&Li2012Params { dt1: 6.0, dt2: 6.0, min_tree_pts: 3, ..Default::default() });
        assert!(wide < narrow, "wide dt {wide} should merge more than narrow dt {narrow}");
    }
}
