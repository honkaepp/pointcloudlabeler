// Tree Skeleton Transfer.
//
// ATTRIBUTION — THIS FILE IS PORTED, NOT REIMPLEMENTED.
//
//   Ported from the authors' MATLAB reference for
//   Honkanen, Yrttimaa et al. (2026), ISPRS Open Journal of
//   Photogrammetry and Remote Sensing 21, 100147 —
//   `TST_get_tree_skeletons_v3.m`, `TST_pc_tree_skeleton.m` and
//   `TST_tree_skeleton_transfer_TLS.m`.
//
// WHAT THE METHOD IS. A plot is scanned twice, years apart. The first
// scan has been segmented into individual trees and reconstructed with
// TreeQSM; the second has not. Sample points along every cylinder of
// every first-scan model, carrying the tree they belong to and the
// branching order of the cylinder they came from, and that set of
// points is a skeleton of the plot. Then every point of the second
// scan takes the tree of the skeleton point nearest it. The segmentation
// transfers without segmenting anything again, and — because the
// skeleton carries branching order — so does the stem/branch labelling.
//
// DEFECTS IN THE REFERENCE, AND WHAT WAS DONE ABOUT THEM. The same
// convention as the TreeQSM port: each is FIXED and marked at its site
// with "FIXED — TST defect N".
//
//  1. The reference restricts the skeleton to the CHUNK it is
//     processing — a 2 m buffer around the chunk's own convex hull —
//     and then gates the labels on the convex hull of THAT subset,
//     under a comment that says "only inside global skeleton convex
//     hull". A point near a chunk boundary can be inside the plot's
//     skeleton hull and outside its chunk's, so whether it keeps its
//     tree depends on how many points happened to land in the chunk
//     before it. The output depends on `cfg.chunk_size`. FIXED: the
//     gate is the hull of every skeleton point, computed once.
//
//  2. `class_lbl(D > threshold) = max(class_lbl) + 20` evaluates
//     `max(class_lbl)` over the chunk, so the class written for a
//     far point is 21 in a chunk that contained a stem point and 20
//     in one that did not. The same physical class carries two
//     different numbers in one output file. FIXED: near and far are
//     distinguished by a value that does not depend on what else was
//     in the chunk.
//
//  3. `tree_lbl(~inside) = 0` drops the tree of a point outside the
//     hull but leaves `class_lbl` alone, so such a point comes out
//     labelled a stem belonging to no tree. FIXED: a point outside
//     the hull carries no label at all.
//
// DELIBERATE DEVIATIONS, each because the reference's choice is an
// artefact of how it reads files rather than a decision about trees:
//
//   * The reference chunks the target cloud through a text reader and
//     runs each chunk on a worker. This streams the target's octree
//     nodes instead. Nothing about the method depends on either, and
//     removing the chunking is what makes defect 1 fixable.
//
//   * The reference removes ground with `pc_local(:,3) > 0.2` on a
//     column its own comment calls absolute height and which is in
//     fact height above ground — `round(h - z, 2) + z` reduces to
//     `z - round(ground, 2)`. This uses the height above the target's
//     own DTM, which is the same quantity computed honestly.
//
//   * The nearest-neighbour search is in absolute coordinates, not in
//     height above ground. Two scans of one plot have two independently
//     estimated ground surfaces, and matching in height above ground
//     would make the transfer depend on the difference between them.
//
// WHERE THE SKELETONS COME FROM, which is not this file's business but
// decides everything it does. The reference builds them by running
// MATLAB TreeQSM over one pre-cut point cloud per tree, filtered first
// with TreeQSM's own `filtering`. The application builds them from its
// own segmentation instead — the tree ids in the baseline dataset —
// which means the two start from different clouds however faithful the
// rest is. What HAS been made to match, in `build_skeleton_from_baseline`:
// ONE model per tree, `filtering` before each reconstruction as it does
// there, and a ground cut that is the caller's threshold rather than a
// hidden one — set it to zero and the baseline is handled as the
// reference handles it. The segmentation itself is the remaining
// difference, and it is not one this code can close.
//
// FIXED — TST defect 4, and it stops the reference's own skeleton step
// from running at all.
//
// `TST_get_tree_skeletons_v3.m` line 125 takes `inputs = create_input`,
// which sets PatchDiam1 = [0.08 0.12], PatchDiam2Min = [0.02 0.03] and
// PatchDiam2Max = [0.07 0.1] — eight combinations. `treeqsm.m` builds
// all eight and accumulates them into ONE struct array:
//
//     QSM = struct(...);            % line 278, once
//     nmodel = nmodel+1;            % line 461, per combination
//     QSM(nmodel) = qsm;            % line 462
//     str = [inputs.name,'_t',num2str(inputs.tree),'_m', ...
//            num2str(inputs.model)];        % inputs.model is never
//     save([resultsfolder,'/results/QSM_',str],'QSM')   % incremented
//
// so the file `QSM_tree_t<id>_m1.mat` ends up holding a 1x8 struct
// array. `TST_pc_tree_skeleton.m` then opens it and does
//
//     cylinders = QSM.cylinder;     % line 9
//
// which on a non-scalar struct array is a MATLAB error — "Expected one
// output ... but there were 8 results". The reference reconstructs each
// tree eight times and is then unable to read the result.
//
// What it can consume is one model, and it names `m1`, so the intended
// skeleton is `QSM(1)`: the first combination, (0.08, 0.02, 0.07).
// `create_input.m`'s own header points at the fix — "the PatchDiam and
// BallRad parameters can be conveniently defined by define_input" —
// and `define_input(P,1,1,1)` yields exactly one. This port builds one
// model by default for that reason. Nothing in that path calls
// `select_optimum`, so building eight and keeping the best would be a
// deviation as well as eight times the work.
//
// NOTED, not fixed — TST defect 5. `create_input.m` sets
// `inputs.filter.plot = 1` and TST_get_tree_skeletons_v3.m clears
// `inputs.plot` but not `inputs.filter.plot`, so `filtering.m` line 229
// opens a figure for every tree inside the `parfor`. Nothing here
// plots, so there is nothing to fix; it is recorded because it is part
// of why the reference is slower than its arithmetic suggests.
//
// Two more things the reference does that this does NOT, both
// deliberate. It restricts the skeleton to each chunk's convex hull
// plus a 2 m buffer before the nearest-neighbour search, which is a
// speed measure with a boundary effect; this searches the whole
// skeleton. And its ground cut is `z > 0.20` on a height-above-ground
// column carried in the input file, where this samples a terrain
// model — the same intent, but it needs the ground classified rather
// than a column that happens to be there.

use super::geom;

/// Where along one cylinder the skeleton is sampled, as interpolation
/// parameters from 0 at the start to 1 at the end.
///
/// The reference takes `numPoints = floor(len/spacing)` values of
/// `linspace(0, 1, numPoints)`, so the spacing is `len/(numPoints-1)`
/// rather than exactly `spacing`, and a cylinder shorter than one
/// spacing contributes nothing at all.
///
/// NOTE, not a fix: a cylinder between one and two spacings long gets
/// a single sample, and MATLAB's `linspace(a, b, 1)` returns `b`, so
/// that sample sits at the cylinder's far END rather than in its
/// middle. Ported as written — it is documented behaviour of
/// `linspace` and may well be what was wanted — but it does mean the
/// shortest cylinders are represented by their tips.
pub fn skeleton_samples(length: f64, spacing: f64) -> Vec<f64> {
    // Written so that a NaN length or spacing falls out here: every
    // comparison against NaN is false. The "shorter than one spacing"
    // case is NOT tested here — `floor(length/spacing)` is then zero
    // and the next line catches it, and stating it twice would leave
    // one of the two statements untestable.
    if !(spacing > 0.0 && length.is_finite()) { return Vec::new(); }
    let n = (length / spacing).floor();
    if !(n.is_finite() && n >= 1.0) { return Vec::new(); }
    let n = (n as usize).min(1_000_000);
    if n == 1 { return vec![1.0]; }
    (0..n).map(|i| i as f64 / (n - 1) as f64).collect()
}

/// The plot's skeleton seen from above: the convex hull of every
/// skeleton point, which is the boundary outside of which the transfer
/// claims nothing.
#[derive(Clone, Debug, Default)]
pub struct SkeletonHull {
    pub poly: Vec<[f64; 2]>,
}

impl SkeletonHull {
    /// FIXED — TST defect 1. The reference builds this from the
    /// skeleton points near the chunk it happens to be processing, so
    /// the boundary moves with the chunking. This is the hull of all
    /// of them.
    pub fn of(points: &[[f32; 3]]) -> Self {
        let flat: Vec<[f64; 2]> = points.iter().map(|p| [p[0] as f64, p[1] as f64]).collect();
        let idx = geom::convex_hull_2d(&flat);
        SkeletonHull { poly: idx.into_iter().map(|i| flat[i]).collect() }
    }

    /// Whether a target point is inside the plot. A hull that could not
    /// be formed — fewer than three skeleton points, or all of them on
    /// one line — gates nothing, because refusing every point would be
    /// a worse answer than not gating at all.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        if self.poly.len() < 3 { return true; }
        geom::point_in_polygon(&self.poly, [x, y])
    }
}

/// What a target point ends up carrying.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TransferLabel {
    /// 0 when the point is outside the plot's skeleton hull.
    pub tree_id: i32,
    /// The application's own byte: 0 not identified as wood, 1 stem,
    /// 2 branch.
    pub semantic: u8,
}

/// The nearest skeleton point to a target point: how far, whose, and
/// what branching order the cylinder it came from had.
#[derive(Clone, Copy, Debug)]
pub struct Nearest {
    pub distance: f64,
    pub tree_id: i32,
    pub branch_order: u8,
}

/// The application's semantic byte for a skeleton point of the given
/// branching order — 1 stem, 2 branch — the same rule for the point the
/// transfer labels and for the `class` column a skeleton export writes,
/// so the two never disagree.
pub fn semantic_class(branch_order: u8) -> u8 { if branch_order == 0 { 1 } else { 2 } }

/// The label one target point takes.
///
/// `label_beyond_threshold` is the reference's own behaviour and the
/// default: `tree_lbl = local_skel_id(idx)` is assigned from the
/// nearest skeleton point WHATEVER the distance, and only the class
/// records whether the point was close enough to be wood. On a leaf-on
/// scan that is the whole point — the crown belongs to its tree even
/// though none of it is within 30 cm of a cylinder axis. Turning it off
/// leaves distant points unassigned, which is the stricter reading and
/// the one to use when the target contains things that are not trees.
pub fn transfer_label(
    nearest: Option<Nearest>,
    threshold: f64,
    inside_hull: bool,
    label_beyond_threshold: bool,
) -> TransferLabel {
    // FIXED — TST defect 3. The reference clears the tree of a point
    // outside the hull and leaves its class, so the point comes back
    // labelled a stem belonging to no tree.
    if !inside_hull { return TransferLabel::default(); }
    let Some(n) = nearest else { return TransferLabel::default() };
    let near = n.distance <= threshold;
    // FIXED — TST defect 2. Near and far are told apart by the
    // semantic byte the rest of the application already speaks, not by
    // a number that depends on whether this chunk happened to contain a
    // stem point.
    let semantic = if !near { 0 } else { semantic_class(n.branch_order) };
    let tree_id = if near || label_beyond_threshold { n.tree_id } else { 0 };
    TransferLabel { tree_id, semantic }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE SAMPLES ARE THE REFERENCE'S `linspace(0, 1, floor(len/spacing))`
    /// — endpoints included, spacing therefore a little under the one
    /// asked for, and nothing at all from a cylinder too short to hold
    /// one sample.
    #[test]
    fn a_cylinder_is_sampled_from_end_to_end() {
        let t = skeleton_samples(1.0, 0.02);
        assert_eq!(t.len(), 50, "floor(1.0/0.02) samples");
        assert_eq!(t[0], 0.0, "the first is the cylinder's start");
        assert_eq!(*t.last().unwrap(), 1.0, "the last is its end, not past it");
        // Even spacing, of len/(n-1) rather than exactly `spacing`.
        let step = t[1] - t[0];
        assert!((step - 1.0 / 49.0).abs() < 1e-15, "step {step}");
        for w in t.windows(2) {
            assert!((w[1] - w[0] - step).abs() < 1e-12, "uneven at {}", w[0]);
        }

        // Shorter than one spacing: nothing.
        assert!(skeleton_samples(0.019, 0.02).is_empty());
        assert!(skeleton_samples(0.0, 0.02).is_empty());
        // Exactly one spacing: one sample, and MATLAB's linspace puts
        // it at the far end.
        assert_eq!(skeleton_samples(0.02, 0.02), vec![1.0]);
        assert_eq!(skeleton_samples(0.039, 0.02), vec![1.0]);
        // Two spacings: the two ends.
        assert_eq!(skeleton_samples(0.04, 0.02), vec![0.0, 1.0]);

        // Nonsense in, nothing out.
        assert!(skeleton_samples(1.0, 0.0).is_empty());
        assert!(skeleton_samples(1.0, -0.02).is_empty());
        assert!(skeleton_samples(f64::NAN, 0.02).is_empty());
        assert!(skeleton_samples(f64::INFINITY, 0.02).is_empty());
    }

    /// NO SAMPLE EVER LANDS PAST THE END OF ITS CYLINDER. Sampling one
    /// step beyond puts skeleton points in mid-air off every branch
    /// tip, and a target point near one of those takes a tree it is not
    /// on.
    #[test]
    fn no_sample_runs_past_the_cylinder() {
        for len in [0.02f64, 0.05, 0.1, 0.37, 1.0, 2.5] {
            for sp in [0.01f64, 0.02, 0.05] {
                for t in skeleton_samples(len, sp) {
                    assert!((0.0..=1.0).contains(&t),
                        "len {len} spacing {sp}: sample at {t}");
                }
            }
        }
    }

    fn near(d: f64, tree: i32, order: u8) -> Option<Nearest> {
        Some(Nearest { distance: d, tree_id: tree, branch_order: order })
    }

    /// A POINT ON A CYLINDER TAKES ITS TREE AND ITS PART.
    #[test]
    fn a_close_point_takes_the_tree_and_the_part() {
        let stem = transfer_label(near(0.10, 7, 0), 0.30, true, true);
        assert_eq!(stem, TransferLabel { tree_id: 7, semantic: 1 });
        let branch = transfer_label(near(0.29, 7, 2), 0.30, true, true);
        assert_eq!(branch, TransferLabel { tree_id: 7, semantic: 2 });
        // The threshold is inclusive, as `D > threshold` makes it.
        assert_eq!(transfer_label(near(0.30, 7, 0), 0.30, true, true).semantic, 1);
        assert_eq!(transfer_label(near(0.3001, 7, 0), 0.30, true, true).semantic, 0);
    }

    /// A LEAF KEEPS ITS TREE. The reference assigns the tree of the
    /// nearest skeleton point whatever the distance and lets the class
    /// say the point is not wood — which is the whole method on a
    /// leaf-on scan, where the crown is metres from any cylinder axis.
    #[test]
    fn a_point_beyond_the_threshold_still_belongs_to_its_tree() {
        let far = transfer_label(near(2.5, 7, 1), 0.30, true, true);
        assert_eq!(far.tree_id, 7, "the crown belongs to its tree");
        assert_eq!(far.semantic, 0, "but it is not stem or branch");

        // The stricter reading, for a target that is not all trees.
        let strict = transfer_label(near(2.5, 7, 1), 0.30, true, false);
        assert_eq!(strict, TransferLabel::default());
        // Close points are unaffected by the choice.
        assert_eq!(transfer_label(near(0.1, 7, 0), 0.30, true, false),
                   transfer_label(near(0.1, 7, 0), 0.30, true, true));
    }

    /// OUTSIDE THE PLOT, NOTHING IS CLAIMED — and nothing is claimed
    /// by halves either. The reference clears the tree and leaves the
    /// class, so a point outside the hull comes back a stem belonging
    /// to no tree.
    #[test]
    fn a_point_outside_the_hull_carries_no_label_at_all() {
        for &beyond in &[true, false] {
            let out = transfer_label(near(0.05, 7, 0), 0.30, false, beyond);
            assert_eq!(out, TransferLabel::default(),
                "outside the hull, even a point 5 cm from a stem");
        }
        // And a point with no skeleton anywhere near it.
        assert_eq!(transfer_label(None, 0.30, true, true), TransferLabel::default());
    }

    /// THE HULL IS THE PLOT'S, and it holds the plot.
    #[test]
    fn the_hull_is_over_every_skeleton_point() {
        let pts: Vec<[f32; 3]> = vec![
            [0.0, 0.0, 1.0], [10.0, 0.0, 1.0], [10.0, 10.0, 1.0], [0.0, 10.0, 1.0],
            [5.0, 5.0, 2.0],
        ];
        let h = SkeletonHull::of(&pts);
        assert_eq!(h.poly.len(), 4, "the interior point is not on the hull");
        assert!(h.contains(5.0, 5.0));
        assert!(h.contains(0.0, 0.0), "a corner is inside");
        assert!(h.contains(10.0, 5.0), "an edge is inside");
        assert!(!h.contains(-0.1, 5.0));
        assert!(!h.contains(10.1, 5.0));
        assert!(!h.contains(5.0, 10.1));

        // A hull that cannot be formed gates nothing rather than
        // everything: refusing every point would be a worse answer.
        let line: Vec<[f32; 3]> = (0..10).map(|i| [i as f32, 0.0, 1.0]).collect();
        assert!(SkeletonHull::of(&line).contains(500.0, 500.0));
        assert!(SkeletonHull::of(&[]).contains(0.0, 0.0));
    }
}
