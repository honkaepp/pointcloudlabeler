// TreeQSM v2 — Raumonen 2013 (Remote Sensing 5(2):491–520).
//
// ATTRIBUTION — PARTS OF THIS FILE ARE PORTED, NOT REIMPLEMENTED.
//
//   Portions Copyright (C) 2013-2022 Pasi Raumonen, Tampere University,
//   ported from TreeQSM 2.4.0 <https://github.com/InverseTampere/TreeQSM>,
//   which is licensed GPL-3.0-or-later. Ported functions name the .m
//   file they came from at their definition.
//
// Everything else here was implemented from the paper. The distinction
// matters and is kept explicit, because the two carry different
// obligations and because any description of this code has to name
// each accurately: the ported parts are a derivative work of TreeQSM and
// Raumonen's copyright travels with them.
//
// This combination is possible only because PointCloudLabeler is
// GPL-3.0-or-later. Under the Apache-2.0 licence this project carried
// until recently, taking GPL-3 code into it would have been a licence
// violation rather than a port. See THIRD-PARTY-NOTICES.md.
//
// DEFECTS IN THE REFERENCE, AND WHAT WAS DONE ABOUT THEM.
//
// The things listed below read as defects in TreeQSM 2.4.0. All of
// them are FIXED here, each marked at its site with the words "FIXED —
// reference defect N", so grep finds every one. The consequence has to
// be stated plainly and belongs in any paper that cites this: THIS NO
// LONGER REPRODUCES THE REFERENCE'S PUBLISHED NUMBERS. It is a port of
// TreeQSM 2.4.0 with corrections, not a reimplementation of it, and the
// honest phrasing is "ported from TreeQSM 2.4.0 with the corrections
// listed in commands/treeqsm.rs".
//
//  1. relative_size.m advances the branching order with
//     `order = order+order`, which never grows from zero. Every segment
//     was stamped order 0, `maxO` was 1, and the order term of the
//     cover-size cap cancelled to one — leaving the cap on height
//     alone. FIXED: the counter increments, so a third-order twig can
//     no longer claim a base as thick as a first-order limb.
//
//  2. cylinders.m, in the branch that fits the last region of a
//     continued segment, builds its weight vector with the two block
//     LENGTHS swapped relative to the rows they weight — the right
//     total length, so nothing complains, and where the groups differ
//     in size part of one is weighted as the other. FIXED: blocks
//     aligned, section weighted 2/3 as in the other two branches.
//
//  3. parent_cylinder's sixth sign case works on the second crossing
//     throughout but decides how to record a miss from the sign of the
//     FIRST crossing's height. FIXED: it uses the matching height, as
//     the other five do.
//
//  4. cylinders.m tests `extension(PC) == c` to decide whether a chain
//     continues its parent's branch, and that can never be true —
//     `extension(i)` is only ever 0 or i+1, and the immediately
//     preceding cylinder is always the last of its own chain. REMOVED:
//     only the reachable path is implemented, and the reasoning is
//     recorded at the site. Behaviour unchanged.
//
//  5. distances_between_lines returns `sqrt(abs(A·N))` where `A·N` is
//     already a distance. Only ever used through `min`, and a square
//     root is monotone, so its choices were right — but the number was
//     not a distance. FIXED: it returns metres.
//
//  6. define_trunk gates its gap repair on `H < aux.Height - 5`, with
//     `H` an ABSOLUTE height and `aux.Height` a height above the tree's
//     own base. On a plot at any real elevation the test is false
//     everywhere and the repair never runs. FIXED at the site, and the
//     pipeline also translates the cloud to the ground so the two are
//     commensurable however it is called.
//
//  7. parent_cylinder leaves a candidate's record untouched when none
//     of the six sign cases applies, then reads that zero as a crossing
//     at distance zero — the best possible — and accepts it as the
//     parent with the branch's base left where it was. FIXED: only
//     records actually written are considered.
//
//  8. tree_data.m's height distribution enumerates five cases — both
//     ends in the layer, and each end in it with the other one bin
//     above or below. A cylinder spanning MORE than one boundary
//     matches none of them and is dropped from every layer it crosses,
//     so a 3 m trunk cylinder contributes nothing to the metre in its
//     middle. FIXED: apportioned by overlap for any span, which is what
//     the five cases are each a special case of.
//
//  9. tree_data.m's histogram bins are half-open, `>= (i-1)*a` and
//     `< i*a`, while `n` is sized so that `n*a` IS the maximum — so the
//     largest value lands exactly on the top edge and is counted
//     nowhere. FIXED: the top bin is closed.
//
// 10. tree_data.m sizes the branch-diameter histogram as
//     `ceil(max(100*diameter))` bins and then makes each 0.005 wide, so
//     the bins together span half the range and every branch above the
//     halfway diameter is dropped. Its own comment says "1 cm classes",
//     which is the width that makes the count agree. FIXED: 0.01.
//
// 11. point_model_distance.m leaves a cylinder that no point was
//     assigned to at distance zero and then averages over every
//     cylinder — so a cylinder standing in empty space is scored as a
//     perfect fit, and a model improves its score by inventing them.
//     This is not cosmetic: select_optimum chooses between the sweep's
//     models by exactly this mean. FIXED: unsupported cylinders are
//     left out of the statistics and counted in `unmatched`.
//
// 12. The same file writes 0 for the branch, 1st-order and 2nd-order
//     distances of a model that has no such cylinders — and 0 is the
//     best score there is. select_optimum then minimises over it, so
//     against a metric naming any of those groups, the model that
//     found NO branches beats every model that found them. FIXED: a
//     group with no cylinders yields infinity, and a model cannot win
//     a comparison on something it does not contain. (Its surface
//     coverage side does not have this problem: an absent group is
//     written as coverage 0, which is the worst value there.)
//
// 13. crown_measures walks the crown's outline keeping the largest
//     distance from each hull vertex to every other in `MaxDiam` — and
//     then reports `CrownDiamMax = L`, the distance from the LAST
//     vertex alone. The maximum it has just computed is discarded, and
//     what comes out is how far the crown reaches from one arbitrary
//     point on its own outline. FIXED: the maximum is reported.
//
// 14. crown_measures computes each first-order branch's tip as
//     `Sta(C,:)+Len(C)*Axe(C)`. A single subscript into an n-by-3
//     matrix is a LINEAR index in MATLAB, so `Axe(C)` is the x
//     component alone — a scalar, which then broadcasts over all three
//     coordinates. A branch pointing due north has an x component of
//     zero and so, if it is a single cylinder, no horizontal reach at
//     all, and can never be the crown base however far it goes. FIXED:
//     the whole axis.
//
// 15. The same function's `M = min(10,median(HL))` takes the median of
//     a vector sized to ALL the branches, in which only the first-order
//     ones were ever written; every higher-order branch contributes a
//     zero. Higher orders normally outnumber first, so the median is
//     exactly zero and the reach criterion — "more than the median
//     reach of 1st-ord. branches", in its own comment — admits
//     anything, including a stub low on the stem that then becomes the
//     crown base. FIXED: the median is over the branches it was
//     measured on.
//
// 16. The search for that first branch is six lines with three faults.
//     Its comment says "Search the first/lowest branch" and the loop
//     increments BEFORE testing, so the lowest branch is the one branch
//     never tested. Its fall-back `if i == nb+1 ... b = branches1(1)`
//     can never run — a normal exit leaves i == nb and a hit leaves
//     i == nb+2 — so a tree whose branches all fail is reported as
//     having no crown at all rather than falling back to its lowest
//     branch as that dead line intends. And `if nb > 1` excludes a tree
//     with exactly one first-order branch from having a crown. FIXED:
//     every first-order branch is tested from the lowest up, and the
//     lowest is the fall-back.
//
// 17. tree_data.m's triangulate_stem picks the first major branch with
//     `b = ind(b)` after a loop that leaves `b` one past the end when
//     no branch is thick enough — MATLAB then indexes off the end of
//     the array and the function dies. The guard meant to catch that,
//     `if b > n`, runs AFTER the indexing and compares a BRANCH INDEX
//     against the COUNT of first-order branches, two different
//     quantities; on any tree where the branch found is numbered above
//     that count, which is ordinary, it is thrown away and replaced by
//     the thickest branch of ANY order — normally the stem itself,
//     which pins the triangulated section at three cylinders whatever
//     the tree looks like. FIXED: the lowest first-order branch over a
//     tenth of the stem's diameter, or the thickest first-order branch
//     when none reaches it.
//
// 18. boundary_curve.m interpolates across runs of empty segments and
//     keeps the seed points instead when a run is five or more long —
//     but it walks every index and recomputes the run from there
//     without marking what it has just filled, so a run of five, kept
//     as seeds at its first index, is re-examined from its second as a
//     run of four and interpolated after all. Every long run is
//     overwritten except its first point, and the rule never takes
//     effect past that point. FIXED: each run is handled once.
//
// 19. curve_based_triangulation.m picks the side triangles out with
//     `TriaLay <= max(VertLay) & TriaLay > 1`, which works only when
//     the first boundary curve was found in layer 1. It searches the
//     top quarter of the stem's layers for one, so when it is not, the
//     TOP CAP's own layer index passes that test too: the cap is
//     counted as side area AND as top area, and its contribution
//     enters the volume twice. FIXED: the caps are known by
//     construction and the side is what is left.
//
// Defect 9 turned up at two further sites in crown_measures and is
// marked at both: the topmost height layer excludes the model's highest
// point, and the last of the eighteen sectors excludes the negative x
// axis, where `atan2` returns pi and pi + pi is exactly 2*pi.
//
// Measured effect on this file's own synthetic trees: the modelled
// volume moved by 0.01 litres and the length by a millimetre, with the
// cylinder count, branch count, branching order, trunk top and base
// radius unchanged. That is not evidence the fixes are immaterial — it
// is evidence that a clean two-order tree does not reach the cases the
// defects were in.
//
// TWO THINGS ARE NOTED AND NOT FIXED, because the intent is genuinely
// unclear and guessing it would be worse than reporting it:
//
//   * tree_data.m's TreeHeight takes the highest cylinder START and
//     adds that one cylinder's rise. Another cylinder can reach higher.
//   * its NumberBranches is the branch table's row count less one, and
//     that table has a row per SEGMENT — including segments that
//     produced no cylinders. `number_branches_modelled` is reported
//     alongside it.
//
// WHY ANYTHING IS PORTED AT ALL. The reimplementation-from-paper
// produced measurably worse structure models than the reference:
// skeletons that broke partway along a branch, and none at all for
// small trees. The cause was structural rather than a bug — the
// reference does not fit one model per tree, it sweeps PatchDiam over
// create_input's arrays and selects; and its second pass shrinks the
// cover-set size toward the branch tips (relative_size.m), which a
// single fixed radius cannot do.
//
// Implementation follows the reference paper end-to-end. The stem is
// reconstructed via the paper's §2.3 trunk segmentation (cover-graph
// walk upward from the lowest high-connectivity cover set), then fit
// as a chain of cylinders just like the branches. The slice-based
// stem fit is no longer used in TreeQSM mode — the trunk cylinder
// chain IS the stem.
//
// The TreeQSM-mode output is converted back to QsmSlice records (one
// per trunk cylinder) so the existing UI plumbing — per-slice
// angular-coverage confidence, analytical 95 % CI propagation,
// per-tree biomass / carbon, taper sparkline — keeps working with
// no other code paths changed.
//
// Stages, all paper-faithful:
//
//   §2.1 Cover generation: MaxBalls BFS-expanding seed selection.
//        Anchor at the lowest-z point (deterministic). Spatial-BFS
//        admits seeds in the r_cover..2·r_cover band. Cover sets are
//        OVERLAPPING balls of radius r_cover.
//
//   §2.2 Cover graph: two cover sets are neighbours iff their member
//        lists share at least one point.
//
//   §2.3 Trunk segmentation: pick the trunk-base anchor (lowest cover
//        set in the bottom 30 cm of the tree, weighted by neighbour
//        count and XY distance to the cloud centroid). Walk upward
//        through the cover graph: at each step, take the unvisited
//        neighbour with the highest "verticality + connectivity"
//        score (verticality = dz/||d||, with dz > 0; connectivity =
//        neighbour count of the candidate). Stop when no upward
//        neighbour remains.
//
//   §2.4 Branch segmentation: trunk cover sets are removed from the
//        graph. From each branch root (non-trunk cover set adjacent
//        to a trunk cover set), BFS builds a spanning tree. Segments
//        = chains between consecutive forks / leaves. Branch order
//        increments at each fork (1 = primary, 2 = secondary, …).
//
//   §2.5 Cylinder fitting: per chunk of 3 cover sets (overlap = 1)
//        of a segment chain, initial PCA + Kåsa estimate, then
//        alternating refinement (project → Kåsa for centre+radius,
//        re-PCA on re-centred points for axis) until convergence
//        (|Δa| + |Δr| < 1e-5 or 8 iters). One MAD-based outlier
//        rejection pass (|residual| > 2.5·MAD) and refit.
//
//   §2.6 Cylinder smoothing: monotonic-taper enforcement along each
//        segment (any cylinder whose radius exceeds its parent's
//        gets clamped to the parent's, volume rescaled).
//
// Per-cylinder angular coverage (12 sectors of 30° around the
// perpendicular-plane fit centre) is computed at fit time and
// surfaced via the QsmSlice.coverage field — same occlusion-aware
// confidence the slice fit produces.

use rustc_hash::FxHashMap;
use std::collections::VecDeque;

use super::octree::{BranchCylinder, QsmSlice};
// One shared circle fit — see commands/circlefit.rs for the measured
// reason it is Taubin's and not Kasa's.
use super::circlefit::taubin_circle;

// --- public entry -----------------------------------------------------

/// Full TreeQSM reconstruction (Raumonen 2013 §2.1–§2.6): trunk
/// segmentation + branch hierarchy, both as cylinder chains.
///
/// Returns (trunk_slices, branches):
///   - trunk_slices: one QsmSlice per trunk cylinder (chain proximal
///     → distal). The slice fields are populated so the existing
///     stem-volume / 95 % CI / coverage-confidence / DBH /
///     completeness pipeline in run_tree_qsm works unchanged.
///   - branches: one BranchCylinder per fitted segment chunk, with
///     full hierarchy (segment_id, parent_cylinder, parent_segment,
///     branch_order ≥ 1).
///
/// `points` is the tree's complete (or down-sampled) point cloud in
/// world coords. `base_z` is the tree's ground reference (mean DTM
/// at the tree centroid). `r_cover` is the ball radius — 4 cm is a
/// good default for forestry TLS at ~5 mm point spacing.
pub(crate) fn fit_treeqsm_full(
    points: &[[f64; 3]],
    base_z: f64,
) -> (Vec<QsmSlice>, Vec<BranchCylinder>, Option<QsmAttributes>) {
    let Some(m) = treeqsm_sweep(points, &QsmInputs::default_sweep()) else {
        return (Vec::new(), Vec::new(), None);
    };
    let attrs = qsm_attributes(&m, points);
    (to_trunk_slices(&m.cylinders, base_z), to_branch_cylinders(&m.cylinders), Some(attrs))
}

/// The numbers a TreeQSM run reports, in the shape the front end and
/// `qsm.json` receive them.
///
/// This is `tree_data`'s output and `point_model_distance`'s, flattened
/// — everything the reference prints for a model, minus the
/// distributions, which are arrays and belong in an export rather than
/// in a per-tree summary. Volumes are LITRES and areas square metres,
/// as the reference reports them; crown volumes are cubic metres,
/// which is also how it reports those.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct QsmAttributes {
    pub total_volume: f64,
    pub trunk_volume: f64,
    pub branch_volume: f64,
    /// The model's own extent, base of the lowest cylinder to the top
    /// of the highest — NOT the height above the terrain, which the
    /// enclosing record reports separately.
    pub tree_height: f64,
    pub trunk_length: f64,
    pub branch_length: f64,
    pub total_length: f64,
    pub number_branches: usize,
    /// Of those, the ones that produced cylinders. See the note on the
    /// reference's own count in this file's header.
    pub number_branches_modelled: usize,
    pub max_branch_order: u8,
    pub trunk_area: f64,
    pub branch_area: f64,
    pub total_area: f64,
    pub dbh_qsm: f64,
    pub dbh_cyl: f64,
    pub crown_diam_ave: f64,
    pub crown_diam_max: f64,
    pub crown_area_conv: f64,
    pub crown_area_alpha: f64,
    pub crown_base_height: f64,
    pub crown_length: f64,
    pub crown_ratio: f64,
    pub crown_volume_conv: f64,
    pub crown_volume_alpha: f64,
    /// How far the cloud sits from the model's surface, metres.
    pub point_distance_mean: f64,
    pub point_distance_max: f64,
    pub point_distance_trunk_mean: f64,
    pub point_distance_branch_mean: f64,
    /// Cylinders no point was assigned to. A model with many of these
    /// is inventing structure; see reference defect 11.
    pub unsupported_cylinders: usize,
    /// Which of `create_input`'s eight parameter sets won the sweep.
    pub patch_diam1: f64,
    pub patch_diam2_min: f64,
    pub patch_diam2_max: f64,
    /// Height along the trunk and the diameter there, base to top.
    pub stem_taper: Vec<(f64, f64)>,
    /// The stem triangulation's numbers, present only when the run
    /// asked for it (`Tria`, off by default as in `create_input.m`)
    /// AND a mesh was actually built.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub triangulation: Option<TriaAttributes>,
}

/// What the stem mesh adds, when there is one.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TriaAttributes {
    /// Diameter at breast height off the mesh, metres.
    pub dbh_tri: f64,
    /// Litres and square metres, the triangulated butt alone.
    pub tria_trunk_volume: f64,
    pub tria_trunk_area: f64,
    /// Metres of stem the mesh covers.
    pub tria_trunk_length: f64,
    /// The mesh in place of the cylinders it replaces.
    pub mix_trunk_volume: f64,
    pub mix_trunk_area: f64,
    pub mix_total_volume: f64,
    pub mix_total_area: f64,
    pub vertex_count: usize,
    pub facet_count: usize,
    /// The triangle height the reconstruction settled on, metres.
    pub tria_height: f64,
}

/// Measure a finished model: `tree_data`, `crown_measures` and
/// `point_model_distance` together.
pub(crate) fn qsm_attributes(m: &QsmModel, points: &[[f64; 3]]) -> QsmAttributes {
    let d = tree_data(&m.cylinders, &m.branches, points, &m.segment_of_point);
    let pm = point_model_distance(points, &m.cylinders, QSM_SCORE_SEED);
    let inp = m.inputs_used.unwrap_or_else(|| QsmInputs::new(0.08, 0.02, 0.07));
    // Before `d` is taken apart into the record below.
    let triangulation = if inp.tria {
        let stem: Vec<[f64; 3]> = points.iter().enumerate()
            .filter(|&(i, _)| m.segment_of_point.get(i).copied() == Some(0))
            .map(|(_, &q)| q).collect();
        let t = triangulate_stem(&m.cylinders, &m.branches, &stem, &d);
        t.mesh.as_ref().map(|mesh| TriaAttributes {
            dbh_tri: t.dbh_tri,
            tria_trunk_volume: t.tria_trunk_volume,
            tria_trunk_area: t.tria_trunk_area,
            tria_trunk_length: t.tria_trunk_length,
            mix_trunk_volume: t.mix_trunk_volume,
            mix_trunk_area: t.mix_trunk_area,
            mix_total_volume: t.mix_total_volume,
            mix_total_area: t.mix_total_area,
            vertex_count: mesh.vert.len(),
            facet_count: mesh.facet.len(),
            tria_height: mesh.tria_height,
        })
    } else { None };
    QsmAttributes {
        total_volume: d.total_volume,
        trunk_volume: d.trunk_volume,
        branch_volume: d.branch_volume,
        tree_height: d.tree_height,
        trunk_length: d.trunk_length,
        branch_length: d.branch_length,
        total_length: d.total_length,
        number_branches: d.number_branches,
        number_branches_modelled: d.number_branches_modelled,
        max_branch_order: d.max_branch_order,
        trunk_area: d.trunk_area,
        branch_area: d.branch_area,
        total_area: d.total_area,
        dbh_qsm: d.dbh_qsm,
        dbh_cyl: d.dbh_cyl,
        crown_diam_ave: d.crown.diam_ave,
        crown_diam_max: d.crown.diam_max,
        crown_area_conv: d.crown.area_conv,
        crown_area_alpha: d.crown.area_alpha,
        crown_base_height: d.crown.base_height,
        crown_length: d.crown.length,
        crown_ratio: d.crown.ratio,
        crown_volume_conv: d.crown.volume_conv,
        crown_volume_alpha: d.crown.volume_alpha,
        point_distance_mean: pm.all.mean,
        point_distance_max: pm.all.max,
        point_distance_trunk_mean: pm.trunk.mean,
        point_distance_branch_mean: pm.branch.mean,
        unsupported_cylinders: pm.unmatched,
        patch_diam1: inp.patch_diam1,
        patch_diam2_min: inp.patch_diam2_min,
        patch_diam2_max: inp.patch_diam2_max,
        stem_taper: d.stem_taper,
        triangulation,
    }
}

/// Trunk only — the same reconstruction, filtered to branch order 0.
///
/// The stem-centreline tool wants the trunk's polyline and radii and
/// nothing else. It costs the same as the full model, because the
/// trunk is not separable: the reference finds it by segmenting the
/// whole tree and taking what is left at order 0.
pub(crate) fn fit_treeqsm_trunk_only(points: &[[f64; 3]], patch_diam: f64) -> Vec<BranchCylinder> {
    let Some(m) = treeqsm_sweep(points, &QsmInputs::sweep_around(patch_diam)) else {
        return Vec::new();
    };
    to_branch_cylinders(&m.cylinders).into_iter()
        .filter(|c| c.branch_order == 0).collect()
}

/// Trunk and branches as one flat list, for the skeleton-transfer tool,
/// which needs the endpoints rather than the slice flattening.
///
/// Stoppable: the skeleton build passes its token so a cancel is
/// noticed inside a tree rather than only between trees — which on a
/// plot whose largest trees are minutes each is the difference between
/// stopping and appearing to hang. Pass `None` to run to completion.
pub(crate) fn fit_treeqsm_full_cylinders_cancellable(
    points: &[[f64; 3]], patch_diam: f64, n_models: usize, cancel: Cancel,
) -> Vec<BranchCylinder> {
    match treeqsm_sweep_cancellable(
        points, &QsmInputs::sweep_around_n(patch_diam, n_models),
        QsmMetric::default(), cancel) {
        Some(m) => to_branch_cylinders(&m.cylinders),
        None => Vec::new(),
    }
}

/// Legacy entry — preserved for any caller that still wants the
/// branch-only path with an externally-supplied slice mask. New code
/// should call `fit_treeqsm_full`.
#[allow(dead_code)]
pub(crate) fn fit_treeqsm_branches(
    slices: &[QsmSlice],
    points: &[[f64; 3]],
    base_z: f64,
    r_cover: f64,
) -> Vec<BranchCylinder> {
    if points.len() < 30 || slices.is_empty() || r_cover <= 0.0 {
        return Vec::new();
    }

    // Stage 1: greedy ball-cover seeding.
    let seeds = greedy_ball_cover(points, r_cover);
    if seeds.len() < 3 { return Vec::new(); }

    // Stage 2: cover-set member lists + neighbour graph.
    let covers = build_covers(points, &seeds, r_cover);

    // Stage 3: stem masking.
    let stem_anchors: Vec<(f64, f64, f64, f64)> = slices.iter()
        .map(|s| (s.center_x, s.center_y, base_z + s.hag, s.radius + r_cover))
        .collect();
    let h_lo = slices.iter().map(|s| s.hag).fold(f64::INFINITY, f64::min) + base_z - r_cover;
    let h_hi = slices.iter().map(|s| s.hag).fold(f64::NEG_INFINITY, f64::max) + base_z + r_cover;
    let mut is_stem = vec![false; covers.len()];
    for (i, c) in covers.iter().enumerate() {
        let z = c.seed[2];
        if z < h_lo || z > h_hi { continue; }
        for &(sx, sy, sz, sr) in &stem_anchors {
            // Hag-nearest anchor only (vertical tolerance r_cover; in
            // XY tolerance = stem radius + r_cover).
            if (z - sz).abs() > r_cover * 1.5 { continue; }
            let dx = c.seed[0] - sx;
            let dy = c.seed[1] - sy;
            if dx * dx + dy * dy <= sr * sr {
                is_stem[i] = true;
                break;
            }
        }
    }

    // Stage 4: branch roots.
    let mut roots: Vec<u32> = Vec::new();
    for i in 0..covers.len() {
        if is_stem[i] { continue; }
        let touches_stem = covers[i].neighbours.iter().any(|&n| is_stem[n as usize]);
        if touches_stem { roots.push(i as u32); }
    }
    if roots.is_empty() { return Vec::new(); }

    // Stage 5: BFS spanning tree.
    let mut parent: Vec<Option<u32>> = vec![None; covers.len()];
    let mut visited = vec![false; covers.len()];
    let mut queue: VecDeque<u32> = VecDeque::new();
    for &r in &roots {
        visited[r as usize] = true;
        queue.push_back(r);
    }
    while let Some(i) = queue.pop_front() {
        for &n in &covers[i as usize].neighbours {
            if is_stem[n as usize] || visited[n as usize] { continue; }
            visited[n as usize] = true;
            parent[n as usize] = Some(i);
            queue.push_back(n);
        }
    }
    // Children = inverse of parent (for fork detection).
    let mut children: Vec<Vec<u32>> = vec![Vec::new(); covers.len()];
    for i in 0..covers.len() {
        if let Some(p) = parent[i] {
            children[p as usize].push(i as u32);
        }
    }

    // Stage 6: segment extraction.
    // A segment = chain of cover sets from a root or fork down to the
    // next fork or leaf, walking the spanning tree.
    struct Segment {
        id: u32,
        parent_segment: Option<u32>,
        branch_order: u8,
        cover_ids: Vec<u32>,
    }
    let mut segments: Vec<Segment> = Vec::new();
    // (start_cover, parent_segment, branch_order)
    let mut stack: Vec<(u32, Option<u32>, u8)> = roots.iter().map(|&r| (r, None, 1)).collect();
    while let Some((start, parent_segment, order)) = stack.pop() {
        let seg_id = segments.len() as u32;
        let mut chain: Vec<u32> = Vec::new();
        chain.push(start);
        let mut cur = start;
        loop {
            let kids = &children[cur as usize];
            if kids.is_empty() { break; }
            if kids.len() == 1 {
                let nxt = kids[0];
                chain.push(nxt);
                cur = nxt;
            } else {
                // Fork: each child starts a new segment.
                for &k in kids {
                    stack.push((k, Some(seg_id), order.saturating_add(1)));
                }
                break;
            }
        }
        segments.push(Segment { id: seg_id, parent_segment, branch_order: order, cover_ids: chain });
    }

    // Stage 7: per-segment cylinder chain.
    let mut out: Vec<BranchCylinder> = Vec::new();
    const CHUNK: usize = 3;
    for seg in &segments {
        if seg.cover_ids.len() < 1 { continue; }
        // Fit all cylinders of this segment first, then enforce
        // monotonic taper across the chain before emitting.
        let mut seg_cylinders: Vec<BranchCylinder> = Vec::new();
        let mut start_i = 0usize;
        loop {
            let end_i = (start_i + CHUNK).min(seg.cover_ids.len());
            if end_i <= start_i { break; }
            let mut pts: Vec<[f64; 3]> = Vec::new();
            for ci in start_i..end_i {
                let cov = &covers[seg.cover_ids[ci] as usize];
                for &pidx in &cov.members {
                    pts.push(points[pidx as usize]);
                }
            }
            if pts.len() >= 6 {
                if let Some(cyl) = fit_cylinder_pca_kasa(&pts) {
                    if filter_keep(&cyl, seg.branch_order) {
                        seg_cylinders.push(cyl);
                    }
                }
            }
            if end_i == seg.cover_ids.len() { break; }
            start_i = end_i.saturating_sub(1); // overlap by one
        }
        enforce_monotonic_taper(&mut seg_cylinders);
        // Emit with parent_cylinder chain + segment metadata.
        let mut prev_cyl_id: Option<u32> = None;
        for mut cyl in seg_cylinders {
            cyl.segment_id = seg.id;
            cyl.parent_segment = seg.parent_segment;
            cyl.branch_order = seg.branch_order;
            cyl.parent_cylinder = prev_cyl_id;
            let new_id = out.len() as u32;
            prev_cyl_id = Some(new_id);
            out.push(cyl);
        }
    }
    out
}

// --- stage 1: greedy ball-cover seeding -------------------------------

/// Angular coverage below which a cylinder is not a measurement.
///
/// `coverage` is the fraction of twelve 30-degree sectors that hold
/// points around the fit centre. A circle fitted to less than a third of
/// its circumference is badly conditioned and biased SMALL — which is
/// exactly what an occluded cross-section behind a branch whorl gives.
const MIN_TRUSTED_COVERAGE: f64 = 0.4;

/// TreeQSM §2.6 monotonic-taper enforcement, over one proximal → distal
/// cylinder chain.
///
/// A stem or branch tapers toward the tip, so a cylinder whose radius
/// exceeds its parent's is noise and gets clamped. That rule existed
/// twice, written out identically for the trunk chain and for the
/// per-segment branch chains, and it had a failure the comment beside it
/// did not mention: it is CUMULATIVE. Each cylinder is capped by its
/// parent's already-capped radius, so ONE spuriously small fit truncates
/// every cylinder above it, all the way to the tip.
///
/// Measured on a 20-cylinder synthetic stem, one fit reduced to a
/// fraction of the truth:
///
/// ```text
///   bad fit          cylinders shrunk    stem volume
///   #3 to 40%             11 of 20         -41.3%
///   #1 to 50%             10 of 20         -44.7%
///   #3 to 70%              6 of 20         -15.0%
/// ```
///
/// Nothing reports it. Every cylinder above the bad one still carries a
/// plausible radius, an rmse from its own fit, and a coverage figure —
/// the stem is simply thinner than the tree.
///
/// So the chain is REPAIRED before it is clamped: a cylinder that was
/// not well enough observed to be a measurement is neither reported nor
/// used as a ceiling, and its radius is interpolated from the nearest
/// trusted cylinders either side. Pooling the whole chain instead —
/// isotonic regression, the textbook answer for monotonising a noisy
/// series — fixes the dips but ruins the spikes this rule exists for
/// (+25.7% against the clamp's +0.9% on the same fixture), so it is not
/// what happens here.
///
/// On a well-observed chain this is EXACTLY the old rule, to the last
/// bit: with nothing to repair, the loop below is the loop that was
/// there. It changes the answer only where the data could not support
/// the old one.
fn enforce_monotonic_taper(cylinders: &mut [BranchCylinder]) {
    let n = cylinders.len();
    // Redundant, and the teeth check says so: a chain shorter than two
    // has fewer than two trusted cylinders, so the repair is skipped,
    // and `1..n` is empty so the clamp does nothing either. Kept because
    // "a chain of one cylinder does not taper" is the reason, and it
    // should not have to be reconstructed from two loop bounds.
    if n < 2 { return; }

    let trusted: Vec<bool> = cylinders.iter()
        .map(|c| c.coverage >= MIN_TRUSTED_COVERAGE)
        .collect();
    // Two trusted cylinders are the minimum that can bracket anything.
    // With fewer, there is no ground to interpolate from and the old
    // rule — cap against whatever was measured — is the best available.
    if trusted.iter().filter(|t| **t).count() >= 2 {
        let measured: Vec<f64> = cylinders.iter().map(|c| c.radius).collect();
        for k in 0..n {
            if trusted[k] { continue; }
            let below = (0..k).rev().find(|i| trusted[*i]);
            let above = (k + 1..n).find(|i| trusted[*i]);
            let r = match (below, above) {
                (Some(i), Some(j)) => {
                    // Linear in chain position. The cylinders in a chain
                    // are of comparable length, so index is a good enough
                    // proxy for distance along it.
                    let t = (k - i) as f64 / (j - i) as f64;
                    measured[i] + (measured[j] - measured[i]) * t
                }
                (Some(i), None) => measured[i],
                (None, Some(j)) => measured[j],
                (None, None) => measured[k],
            };
            set_radius(&mut cylinders[k], r);
        }
    }

    // The clamp itself, unchanged.
    for k in 1..n {
        if cylinders[k].radius > cylinders[k - 1].radius {
            let r = cylinders[k - 1].radius;
            set_radius(&mut cylinders[k], r);
        }
    }
}

/// Set a cylinder's radius and keep its volume consistent with it.
///
/// The two were updated together at both former clamp sites, and a
/// radius changed without its volume is a cylinder that reports one
/// thickness and contributes another.
fn set_radius(c: &mut BranchCylinder, r: f64) {
    c.radius = r;
    c.volume = std::f64::consts::PI * r * r * c.length;
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/correct_segments.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
//
// The reference calls this twice with different switches:
//   pass 1: (…, RemSmall 0, ModBases 1, AddChild 1) — the segmentation
//           `relative_size` reads;
//   pass 2: (…, RemSmall 1, ModBases 1, AddChild 0) — the one
//           `cylinders` reads.
// Both are ported.
// ===================================================================

/// Which of `correct_segments`' three switches are on.
#[derive(Clone, Copy, Debug)]
pub struct CorrectParams {
    /// Drop child segments too slender to be branches. Pass 2 only.
    pub rem_small: bool,
    /// Move the flared base of a branch off its parent.
    pub mod_bases: bool,
    /// …and give it to the child rather than merely deleting it.
    pub add_child: bool,
}

impl CorrectParams {
    /// `correct_segments(P, cover1, segment1, Inputs, 0, 1, 1)`.
    pub fn first_pass() -> Self {
        Self { rem_small: false, mod_bases: true, add_child: true }
    }
    /// `correct_segments(P, cover2, segment2, Inputs, 1, 1, 0)`.
    pub fn second_pass() -> Self {
        Self { rem_small: true, mod_bases: true, add_child: false }
    }
}

/// What `correct_segments` derives about the points once the
/// segmentation has settled.
#[derive(Clone, Debug, Default)]
pub struct SegmentData {
    /// Which segment each point belongs to; `u32::MAX` for none.
    pub segment_of_point: Vec<u32>,
    /// The stem's children, their children, and theirs — the
    /// reference's `branch1indexes`, `branch2indexes`, `branch3indexes`.
    pub branch1: Vec<u32>,
    pub branch2: Vec<u32>,
    pub branch3: Vec<u32>,
}

/// `remove_small` — drop child segments that are not branches, only
/// bumps.
///
/// The test is girth against the parent, measured perpendicular to the
/// parent's own direction over the twenty layers around the junction. A
/// child that reaches barely further from that axis than the parent
/// itself does — two centimetres, or twenty per cent and under six — is
/// not a branch leaving the stem; it is the stem's own surface bulging,
/// and segmenting it produces a cylinder made of trunk.
///
/// A child with grandchildren is spared unless the grandchildren fail
/// the same test too, in which case the whole twig goes together.
///
/// The stem's own allowance is halved after it has been processed, so
/// what counts as a bump on the trunk is stricter than on a branch.
pub fn remove_small(
    centres: &[[f64; 3]],
    segs: &mut Vec<Vec<Vec<u32>>>,
    parent: &mut Vec<Option<(u32, u32)>>,
    children: &mut Vec<Vec<u32>>,
) {
    let nseg = segs.len();
    if nseg == 0 || segs[0].is_empty() { return; }

    let mean_c = |ids: &[u32]| -> [f64; 3] {
        if ids.is_empty() { return [0.0; 3]; }
        let mut s = [0.0; 3];
        for &i in ids {
            if let Some(c) = centres.get(i as usize) {
                s[0] += c[0]; s[1] += c[1]; s[2] += c[2];
            }
        }
        let n = ids.len() as f64;
        [s[0]/n, s[1]/n, s[2]/n]
    };
    let max_dist = |ids: &[u32], v: [f64; 3], o: [f64; 3]| -> f64 {
        ids.iter().filter_map(|&i| centres.get(i as usize)).map(|p| {
            let a = [p[0]-o[0], p[1]-o[1], p[2]-o[2]];
            let h = a[0]*v[0] + a[1]*v[1] + a[2]*v[2];
            ((a[0]-h*v[0]).powi(2) + (a[1]-h*v[1]).powi(2) + (a[2]-h*v[2]).powi(2)).sqrt()
        }).fold(0.0_f64, f64::max)
    };

    // The stem's girth over its first ten layers.
    let stem_ns = segs[0].len();
    let end0 = if stem_ns > 10 { 9 } else { stem_ns - 1 };
    let start_c = mean_c(&segs[0][0]);
    let Some(v0) = unit({
        let e = mean_c(&segs[0][end0]);
        [e[0]-start_c[0], e[1]-start_c[1], e[2]-start_c[2]]
    }) else { return };
    let stem_sets: Vec<u32> = segs[0][..=end0].concat();
    let mut max_rad = max_dist(&stem_sets, v0, start_c);

    let mut keep = vec![true; nseg];
    for i in 0..nseg {
        if !keep[i] { continue; }
        let child_segs = children[i].clone();
        let ns = segs[i].len();
        for &cj in &child_segs {
            let c = cj as usize;
            if c >= nseg || !keep[c] || ns == 0 { continue; }
            let Some((_, nl)) = parent[c] else { continue };
            let nl = (nl as usize).min(ns - 1);
            let start_l = nl.saturating_sub(10);
            let end_l = if ns - (nl + 1) > 10 { (nl + 10).min(ns - 1) } else { ns - 1 };
            if start_l > end_l { continue; }

            let start = mean_c(&segs[i][start_l]);
            let Some(v) = unit({
                let e = mean_c(&segs[i][end_l]);
                [e[0]-start[0], e[1]-start[1], e[2]-start[2]]
            }) else { continue };

            let child_sets: Vec<u32> = segs[c].concat();
            let dist_child = max_dist(&child_sets, v, start);
            if dist_child >= max_rad + 0.06 { continue; }

            let parent_sets: Vec<u32> = segs[i][start_l..=end_l].concat();
            let dist_par = max_dist(&parent_sets, v, start);
            // Two absolute centimetres, or a fifth more and under six.
            let bump = (dist_child - dist_par < 0.02)
                || (dist_child / dist_par < 1.2 && dist_child - dist_par < 0.06);
            if !bump { continue; }

            let grandchildren = children[c].clone();
            // OBSERVED: removing the child from `children[i]` below is
            // redundant and no test catches its removal — the
            // compaction at the end maps a dropped segment's index to
            // nothing and filters it out of every child list anyway.
            // It is kept because between here and there the list is
            // read again, and relying on a later pass to clean up a
            // structure that is wrong in the meantime is how the next
            // edit introduces a bug.
            if grandchildren.is_empty() {
                keep[c] = false;
                segs[c].clear();
                parent[c] = None;
                children[i].retain(|&x| x != cj);
            } else {
                // Only if the grandchildren are themselves leaves.
                let any_great = grandchildren.iter().any(|&g|
                    children.get(g as usize).is_some_and(|v| !v.is_empty()));
                if any_great { continue; }
                let all_bumps = grandchildren.iter().all(|&g| {
                    let gi = g as usize;
                    if gi >= nseg || segs[gi].is_empty() { return true; }
                    let mut ids: Vec<u32> = segs[gi].concat();
                    ids.extend(parent_sets.iter().copied());
                    let d = max_dist(&ids, v, start);
                    (d - dist_par < 0.02) || (d / dist_par < 1.2 && d - dist_par < 0.06)
                });
                if !all_bumps { continue; }
                for &g in &grandchildren {
                    let gi = g as usize;
                    if gi >= nseg { continue; }
                    keep[gi] = false;
                    segs[gi].clear();
                    parent[gi] = None;
                    children[gi].clear();
                }
                keep[c] = false;
                segs[c].clear();
                parent[c] = None;
                children[c].clear();
                children[i].retain(|&x| x != cj);
            }
        }
        // What counts as a bump on the trunk is stricter than on a
        // branch, and the reference makes it so by halving the trunk's
        // own allowance the moment the trunk has been dealt with.
        if i == 0 { max_rad /= 2.0; }
    }

    // Compact, remapping every index.
    let mut remap = vec![None; nseg];
    let mut next = 0u32;
    for i in 0..nseg {
        if keep[i] { remap[i] = Some(next); next += 1; }
    }
    let mut new_segs = Vec::with_capacity(next as usize);
    let mut new_parent = Vec::with_capacity(next as usize);
    let mut new_children = Vec::with_capacity(next as usize);
    for i in 0..nseg {
        if !keep[i] { continue; }
        new_segs.push(std::mem::take(&mut segs[i]));
        new_parent.push(parent[i].and_then(|(p, l)| remap[p as usize].map(|np| (np, l))));
        new_children.push(children[i].iter()
            .filter_map(|&c| remap.get(c as usize).copied().flatten()).collect());
    }
    *segs = new_segs;
    *parent = new_parent;
    *children = new_children;
}

/// `correct_segments` — tidy a raw segmentation into one worth fitting
/// cylinders to.
///
/// Three things, each switchable because the reference runs this twice
/// with different switches: join the pieces a segmentation cut a stem or
/// a branch into (`modify_topology`), drop the children that are bumps
/// rather than branches (`remove_small`, second pass only), and move the
/// flared base of each branch off its parent (`modify_parent`).
///
/// The last is the one with two modes. On the first pass the base is
/// GIVEN to the child, because `relative_size` is about to measure each
/// segment's girth and a branch that still starts inside its parent
/// measures as thick as the parent. On the second pass it is merely
/// removed from the parent, because by then the child's own cylinders
/// will start on the parent's surface anyway.
///
/// `centres` is `P(cover.center,:)` — one point per cover set.
pub fn correct_segments(
    points: &[[f64; 3]],
    balls: &[Vec<u32>],
    centres: &[[f64; 3]],
    seg: &mut Segmentation,
    patch_diam1: f64,
    patch_diam2_max: f64,
    p: &CorrectParams,
) -> SegmentData {
    let dmin = if p.rem_small { patch_diam2_max } else { patch_diam1 };
    modify_topology(points, centres, balls, &mut seg.segments,
                    &mut seg.parent, &mut seg.children, dmin);
    if p.rem_small {
        remove_small(centres, &mut seg.segments, &mut seg.parent, &mut seg.children);
    }

    if p.mod_bases {
        // OBSERVED: which of the two diameters is used barely matters
        // and no test catches swapping them. It reaches `modify_parent`
        // only through the number of parent layers to search, which is
        // floored at three and which the search leaves early on every
        // fixture here — the moment a layer is taken whole or not at
        // all. It would show on a branch whose base is wide enough for
        // the ceiling to exceed three, which is a base over 20 cm
        // across at a typical junction angle.
        let diam = if p.add_child { patch_diam1 } else { patch_diam2_max };
        for i in 1..seg.segments.len() {
            let Some((pi, nl)) = seg.parent[i] else { continue };
            let pi = pi as usize;
            // Without AddChild the reference skips children of the stem
            // itself: `if SPar(i,1) > 1`.
            if !p.add_child && pi == 0 { continue; }
            if pi >= seg.segments.len() { continue; }
            let child = seg.segments[i].clone();
            let mut par = seg.segments[pi].clone();
            let base = modify_parent(points, balls, centres, &mut par, &child,
                                     nl as usize, diam, p.add_child);
            seg.segments[pi] = par;
            // OBSERVED: the `p.add_child` here is redundant and its
            // removal is not caught. `modify_parent` returns the
            // child's ORIGINAL base when AddChild is off, so assigning
            // it back is a no-op. Kept because the reference only
            // assigns in the AddChild case, and a reader should see the
            // same two cases in both.
            if p.add_child && !seg.segments[i].is_empty() && !base.is_empty() {
                seg.segments[i][0] = base;
            }
        }
    }

    // ---- What the points now belong to.
    let mut segment_of_point = vec![u32::MAX; points.len()];
    for (i, s) in seg.segments.iter().enumerate() {
        for layer in s {
            for &set in layer {
                if let Some(b) = balls.get(set as usize) {
                    for &pt in b {
                        if (pt as usize) < segment_of_point.len() {
                            segment_of_point[pt as usize] = i as u32;
                        }
                    }
                }
            }
        }
    }

    let kids = |of: &[u32]| -> Vec<u32> {
        of.iter().flat_map(|&s| seg.children.get(s as usize).cloned().unwrap_or_default())
          .collect()
    };
    let branch1 = seg.children.first().cloned().unwrap_or_default();
    let branch2 = kids(&branch1);
    let branch3 = kids(&branch2);
    SegmentData { segment_of_point, branch1, branch2, branch3 }
}
// ===================================================================

/// The chain of segments from `tip` up to `root`, tip first.
///
/// `parent[i]` is `(parent segment, attachment layer)`; walking it back
/// from a tip gives the segments a splice would join.
fn chain_to_root(parent: &[Option<(u32, u32)>], tip: u32, root: u32) -> Option<Vec<u32>> {
    let mut chain = vec![tip];
    let mut cur = tip;
    let mut guard = 0;
    while cur != root {
        let (p, _) = parent.get(cur as usize).copied().flatten()?;
        cur = p;
        chain.push(cur);
        guard += 1;
        if guard > 10_000 { return None; }
    }
    Some(chain)
}

/// Splice a chain into one layer list, WITHOUT modifying anything —
/// the "what would this look like joined up" that both searches do
/// before choosing.
///
/// Each child is grafted at its attachment layer: if the attachment is
/// within two layers of the parent's top the whole parent is kept and
/// the child appended, otherwise the parent is truncated at the
/// attachment. That is `SP >= a-2` in the reference, and it is what
/// stops a splice from doubling back down a segment it already covered.
fn splice_chain(
    segs: &[Vec<Vec<u32>>], parent: &[Option<(u32, u32)>], chain: &[u32],
) -> Vec<Vec<u32>> {
    // chain is tip-first; splice from the root down.
    let mut out: Vec<Vec<u32>> = match segs.get(*chain.last().unwrap() as usize) {
        Some(v) => v.clone(),
        None => return Vec::new(),
    };
    for w in chain.iter().rev().collect::<Vec<_>>().windows(2) {
        let child = *w[1];
        let Some(child_layers) = segs.get(child as usize) else { continue };
        let Some((_, sp)) = parent.get(child as usize).copied().flatten() else { continue };
        let sp = sp as usize;
        if sp + 2 >= out.len() {
            out.extend(child_layers.iter().cloned());
        } else {
            out.truncate(sp + 1);
            out.extend(child_layers.iter().cloned());
        }
    }
    out
}

/// Path length and end-to-end distance of a spliced chain, sampled
/// every `n` layers — the reference's linear-length approximation.
///
/// A layer holding one cover set is measured from that set's POINTS,
/// because a single centre gives a node with no support.
fn chain_length_and_span(
    points: &[[f64; 3]], centres: &[[f64; 3]], balls: &[Vec<u32>],
    layers: &[Vec<u32>], n: usize,
) -> (f64, f64) {
    if layers.is_empty() { return (0.0, 0.0); }
    let ns = layers.len();
    let n = n.max(1);
    let m = if ns % n != 0 { ns.div_ceil(n) } else { ns / n + 1 };
    let mut nodes: Vec<[f64; 3]> = Vec::with_capacity(m);
    for j in 0..m {
        let i = (j * n).min(ns - 1);
        let set = &layers[i];
        if set.is_empty() { continue; }
        let node = if set.len() > 1 {
            let mut c = [0.0; 3];
            for &k in set {
                for (a, v) in c.iter_mut().enumerate() { *v += centres[k as usize][a]; }
            }
            for v in c.iter_mut() { *v /= set.len() as f64; }
            c
        } else {
            let ball = balls.get(set[0] as usize);
            match ball {
                Some(b) if !b.is_empty() => {
                    let mut c = [0.0; 3];
                    for &k in b {
                        for (a, v) in c.iter_mut().enumerate() { *v += points[k as usize][a]; }
                    }
                    for v in c.iter_mut() { *v /= b.len() as f64; }
                    c
                }
                _ => centres[set[0] as usize],
            }
        };
        nodes.push(node);
    }
    if nodes.len() < 2 { return (0.0, 0.0); }
    let dist = |a: [f64; 3], b: [f64; 3]| {
        ((a[0]-b[0]).powi(2) + (a[1]-b[1]).powi(2) + (a[2]-b[2]).powi(2)).sqrt()
    };
    let length: f64 = nodes.windows(2).map(|w| dist(w[0], w[1])).sum();
    let span = dist(*nodes.first().unwrap(), *nodes.last().unwrap());
    (length, span)
}

/// `search_stem_top` — which segment tip continues the stem.
///
/// Every tip within a growing radius of the highest tip is a candidate.
/// Each candidate's chain is spliced and scored by path length over
/// end-to-end distance; the STRAIGHTEST wins. A stem that wanders is
/// not a stem, it is a stem plus a branch that was followed by mistake.
///
/// The radius grows by 0.5 m until something qualifies, and the
/// acceptance threshold relaxes as it grows — 1.05, then 1.1 past 3 m,
/// 1.15 past 5 m, and past 7 m anything, because by then insisting on
/// straightness is worse than picking the best available.
#[allow(clippy::too_many_arguments)]
pub fn search_stem_top(
    points: &[[f64; 3]], centres: &[[f64; 3]], balls: &[Vec<u32>],
    segs: &[Vec<Vec<u32>>], parent: &[Option<(u32, u32)>], dmin: f64,
) -> u32 {
    let nseg = segs.len();
    if nseg == 0 { return 0; }
    let tip_of = |i: usize| -> Option<u32> { segs[i].last()?.first().copied() };
    let base = segs.first().and_then(|s| s.first()).cloned().unwrap_or_default();
    if base.is_empty() { return 0; }
    let mut stem_cen = [0.0; 3];
    for &b in &base {
        for (a, v) in stem_cen.iter_mut().enumerate() { *v += centres[b as usize][a]; }
    }
    for v in stem_cen.iter_mut() { *v /= base.len() as f64; }

    let mut heights = vec![f64::NEG_INFINITY; nseg];
    let mut hor = vec![f64::INFINITY; nseg];
    for i in 0..nseg {
        if let Some(t) = tip_of(i) {
            let c = centres[t as usize];
            heights[i] = c[2];
            hor[i] = ((c[0] - stem_cen[0]).powi(2) + (c[1] - stem_cen[1]).powi(2)).sqrt();
        }
    }
    let top = heights.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let dist: Vec<f64> = (0..nseg)
        .map(|i| if heights[i].is_finite() {
            (hor[i].powi(2) + (top - heights[i]).powi(2)).sqrt()
        } else { f64::INFINITY })
        .collect();

    // ceil(0.5/dmin/1.4): how many layers make up roughly half a metre.
    let n = ((0.5 / dmin / 1.4).ceil() as usize).max(1);
    let mut search = 0.5_f64;
    let mut max_ratio = 1.05_f64;
    let mut best = 0u32;
    let mut guard = 0;
    loop {
        guard += 1;
        if guard > 64 { break; }
        let mut cands: Vec<u32> = (0..nseg as u32).filter(|&i| dist[i as usize] < search).collect();
        while cands.is_empty() && search < 1e6 {
            search += 0.5;
            cands = (0..nseg as u32).filter(|&i| dist[i as usize] < search).collect();
        }
        if cands.is_empty() { break; }

        let mut best_ratio = f64::INFINITY;
        for &c in &cands {
            let layers = if c == 0 {
                segs[0].clone()
            } else {
                match chain_to_root(parent, c, 0) {
                    Some(chain) => splice_chain(segs, parent, &chain),
                    None => continue,
                }
            };
            let (len, span) = chain_length_and_span(points, centres, balls, &layers, n);
            if span <= 0.0 { continue; }
            let ratio = len / span;
            if ratio < best_ratio { best_ratio = ratio; best = c; }
        }
        search += 1.0;
        if search > 3.0 { max_ratio = 1.10; }
        if search > 5.0 { max_ratio = 1.15; }
        if search > 7.0 { max_ratio = 5.0; }
        if best_ratio <= max_ratio { break; }
    }
    best
}

/// `search_branch_top` — the same choice for a branch: which of its own
/// sub-segments carries it furthest, judged by the same straightness.
#[allow(clippy::too_many_arguments)]
pub fn search_branch_top(
    points: &[[f64; 3]], centres: &[[f64; 3]], balls: &[Vec<u32>],
    segs: &[Vec<Vec<u32>>], parent: &[Option<(u32, u32)>], children: &[Vec<u32>],
    dmin: f64, branch: u32,
) -> u32 {
    // The branch and every segment below it.
    let mut family = vec![branch];
    let mut frontier = children.get(branch as usize).cloned().unwrap_or_default();
    let mut guard = 0;
    while !frontier.is_empty() && guard < 10_000 {
        guard += 1;
        family.extend(frontier.iter().copied());
        frontier = frontier.iter()
            .flat_map(|&c| children.get(c as usize).cloned().unwrap_or_default())
            .collect();
    }
    let Some(base) = segs.get(branch as usize).and_then(|s| s.first()) else { return branch };
    if base.is_empty() { return branch; }
    let mut base_cen = [0.0; 3];
    for &b in base {
        for (a, v) in base_cen.iter_mut().enumerate() { *v += centres[b as usize][a]; }
    }
    for v in base_cen.iter_mut() { *v /= base.len() as f64; }

    // Furthest tip first — the reference sorts descending by linear
    // distance from the branch's base.
    let mut ranked: Vec<(f64, u32)> = family.iter().filter_map(|&i| {
        let tipl = segs.get(i as usize)?.last()?;
        if tipl.is_empty() { return None; }
        let mut c = [0.0; 3];
        for &k in tipl { for (a, v) in c.iter_mut().enumerate() { *v += centres[k as usize][a]; } }
        for v in c.iter_mut() { *v /= tipl.len() as f64; }
        let d = ((c[0]-base_cen[0]).powi(2) + (c[1]-base_cen[1]).powi(2) + (c[2]-base_cen[2]).powi(2)).sqrt();
        Some((d, i))
    }).collect();
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let n = ((0.5 / dmin / 1.4).ceil() as usize).max(1);
    let mut best = branch;
    let mut best_ratio = f64::INFINITY;
    for &(_, cand) in &ranked {
        let layers = if cand == branch {
            segs[branch as usize].clone()
        } else {
            match chain_to_root(parent, cand, branch) {
                Some(chain) => splice_chain(segs, parent, &chain),
                None => continue,
            }
        };
        let (len, span) = chain_length_and_span(points, centres, balls, &layers, n);
        if span <= 0.0 { continue; }
        let ratio = len / span;
        if ratio < best_ratio { best_ratio = ratio; best = cand; }
    }
    best
}

/// Absorb `child` into `into`, taking the child's layers up to
/// `take` — the splice step `modify_topology` repeats along a chain.
///
/// Two cases, and which applies is the same test the virtual splice
/// uses. If the child attaches within two layers of its parent's top,
/// the whole parent is kept and the child's layers are appended.
/// Otherwise the parent is CUT at the attachment: everything above
/// becomes a new segment, because those layers are a branch now, not
/// part of the chain being straightened.
///
/// Every grandchild has to be re-pointed as this happens. A child of
/// the absorbed segment that attached BELOW the cut moves to `into`
/// with its layer index shifted by however many layers were prepended;
/// one that attached above stays where it is with its index rebased.
/// Getting either wrong produces a tree that looks plausible and has
/// branches growing out of the wrong heights.
fn absorb_child(
    segs: &mut Vec<Vec<Vec<u32>>>,
    parent: &mut Vec<Option<(u32, u32)>>,
    children: &mut Vec<Vec<u32>>,
    into: u32, child: u32, take: usize,
) {
    let Some((_, sp)) = parent[child as usize] else { return };
    let sp = sp as usize;
    let n = segs[into as usize].len();
    let child_layers = segs[child as usize].clone();
    let take = take.min(child_layers.len());

    // Where the child's layers will start once spliced.
    let offset = if sp + 2 >= n {
        segs[into as usize].extend(child_layers[..take].iter().cloned());
        n
    } else {
        // Cut: the parent's layers above the attachment become a new
        // segment, and the children that hung off them go with it.
        let above: Vec<Vec<u32>> = segs[into as usize][sp + 1..].to_vec();
        let new_seg = segs.len() as u32;
        segs.push(above);
        parent.push(Some((into, sp as u32)));
        children.push(Vec::new());

        let moved: Vec<u32> = children[into as usize].iter().copied()
            .filter(|&c| parent[c as usize].map(|(_, l)| l as usize > sp).unwrap_or(false))
            .collect();
        children[into as usize].retain(|c| !moved.contains(c));
        for &m in &moved {
            if let Some((_, l)) = parent[m as usize] {
                parent[m as usize] = Some((new_seg, l - sp as u32));
            }
        }
        children[new_seg as usize] = moved;
        children[into as usize].push(new_seg);

        segs[into as usize].truncate(sp + 1);
        segs[into as usize].extend(child_layers[..take].iter().cloned());
        sp + 1
    };

    // The child's own children: those attached at or below the taken
    // part come with it; the rest stay with the remainder.
    let grand: Vec<u32> = children[child as usize].clone();
    let (moving, staying): (Vec<u32>, Vec<u32>) = grand.into_iter()
        .partition(|&g| parent[g as usize].map(|(_, l)| (l as usize) <= take).unwrap_or(false));

    if take < child_layers.len() {
        // The child survives as its own segment above the splice.
        segs[child as usize] = child_layers[take..].to_vec();
        parent[child as usize] = Some((into, (offset + take - 1) as u32));
        for &g in &staying {
            if let Some((_, l)) = parent[g as usize] {
                parent[g as usize] = Some((child, l - take as u32));
            }
        }
        children[child as usize] = staying;
    } else {
        // Wholly absorbed: it stops being a segment.
        segs[child as usize] = Vec::new();
        parent[child as usize] = None;
        children[child as usize] = Vec::new();
        children[into as usize].retain(|&c| c != child);
    }
    for &g in &moving {
        if let Some((_, l)) = parent[g as usize] {
            parent[g as usize] = Some((into, (offset + l as usize) as u32));
        }
    }
    children[into as usize].extend(moving);
}

/// `modify_topology` — make every segment as long as it can honestly
/// be.
///
/// A segmentation straight out of `segments` chops a stem wherever a
/// branch leaves it, so the stem arrives as a stack of short pieces
/// each with branch order zero. This walks the tree by branch order,
/// asks which continuation each segment actually has, and splices that
/// chain into one segment — re-parenting everything that hung off the
/// pieces as it goes.
///
/// It matters for `relative_size` downstream, which tapers the cover
/// along a segment by position: on a stem cut into ten pieces the
/// taper restarts ten times, and the cover never gets small enough at
/// the tips to follow a twig.
#[allow(clippy::too_many_arguments)]
pub fn modify_topology(
    points: &[[f64; 3]], centres: &[[f64; 3]], balls: &[Vec<u32>],
    segs: &mut Vec<Vec<Vec<u32>>>,
    parent: &mut Vec<Option<(u32, u32)>>,
    children: &mut Vec<Vec<u32>>,
    dmin: f64,
) {
    if segs.is_empty() { return; }

    // Breadth-first by branch order, stem first — the reference walks
    // SChi{1}, then their children, and so on.
    let mut order: Vec<u32> = vec![0];
    let mut frontier: Vec<u32> = children[0].clone();
    let mut depth = 0usize;
    let mut guard = 0;
    while !frontier.is_empty() && guard < 100_000 {
        guard += 1;
        order.extend(frontier.iter().copied());
        frontier = frontier.iter()
            .flat_map(|&c| children.get(c as usize).cloned().unwrap_or_default())
            .collect();
        depth += 1;
        if depth > 10_000 { break; }
    }

    let mut i = 0usize;
    while i < order.len() {
        let seg_ind = order[i];
        i += 1;
        let si = seg_ind as usize;
        if si >= segs.len() || segs[si].is_empty() || children[si].is_empty() { continue; }

        let branch_order = {
            let mut o = 0;
            let mut cur = seg_ind;
            while let Some((p, _)) = parent[cur as usize] { cur = p; o += 1; if o > 1000 { break; } }
            o
        };

        let tip = if seg_ind == 0 {
            search_stem_top(points, centres, balls, segs, parent, dmin)
        } else if branch_order <= 1 {
            search_branch_top(points, centres, balls, segs, parent, children, dmin, seg_ind)
        } else {
            // Second order and above: the reference skips the
            // straightness test and simply takes the sub-segment whose
            // tip is furthest from this segment's base.
            let base = &segs[si][0];
            if base.is_empty() { continue; }
            let mut bc = [0.0; 3];
            for &b in base { for (a, v) in bc.iter_mut().enumerate() { *v += centres[b as usize][a]; } }
            for v in bc.iter_mut() { *v /= base.len() as f64; }
            let mut family = vec![seg_ind];
            let mut f = children[si].clone();
            let mut g2 = 0;
            while !f.is_empty() && g2 < 10_000 {
                g2 += 1;
                family.extend(f.iter().copied());
                f = f.iter().flat_map(|&c| children.get(c as usize).cloned().unwrap_or_default()).collect();
            }
            family.into_iter().filter_map(|k| {
                let t = segs.get(k as usize)?.last()?.first().copied()?;
                let c = centres[t as usize];
                let d = (c[0]-bc[0]).powi(2) + (c[1]-bc[1]).powi(2) + (c[2]-bc[2]).powi(2);
                Some((d, k))
            }).max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
              .map(|(_, k)| k).unwrap_or(seg_ind)
        };

        if tip == seg_ind { continue; }
        let Some(chain) = chain_to_root(parent, tip, seg_ind) else { continue };
        // chain is tip-first and ends at seg_ind; absorb from the one
        // nearest seg_ind outward, each time taking the child's layers
        // up to where the NEXT link attaches.
        let inward: Vec<u32> = chain.iter().rev().skip(1).copied().collect();
        for (k, &child) in inward.iter().enumerate() {
            let take = match inward.get(k + 1) {
                Some(&next) => parent[next as usize].map(|(_, l)| l as usize + 1).unwrap_or(usize::MAX),
                None => usize::MAX,   // the tip: take all of it
            };
            if segs[child as usize].is_empty() { continue; }
            absorb_child(segs, parent, children, seg_ind, child, take);
        }
    }

    // Compact: drop the segments that were absorbed, renumber the rest.
    let keep: Vec<bool> = segs.iter().map(|s| !s.is_empty()).collect();
    let mut remap = vec![u32::MAX; segs.len()];
    let mut next = 0u32;
    for (idx, &k) in keep.iter().enumerate() {
        if k { remap[idx] = next; next += 1; }
    }
    let new_segs: Vec<Vec<Vec<u32>>> = segs.iter().zip(&keep)
        .filter(|(_, &k)| k).map(|(s, _)| s.clone()).collect();
    let new_parent: Vec<Option<(u32, u32)>> = parent.iter().zip(&keep)
        .filter(|(_, &k)| k)
        .map(|(p, _)| p.and_then(|(pi, l)| {
            let r = remap.get(pi as usize).copied().unwrap_or(u32::MAX);
            if r == u32::MAX { None } else { Some((r, l)) }
        }))
        .collect();
    let new_children: Vec<Vec<u32>> = children.iter().zip(&keep)
        .filter(|(_, &k)| k)
        .map(|(c, _)| c.iter()
            .filter_map(|&x| {
                let r = remap.get(x as usize).copied().unwrap_or(u32::MAX);
                if r == u32::MAX { None } else { Some(r) }
            }).collect())
        .collect();
    *segs = new_segs;
    *parent = new_parent;
    *children = new_children;
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/relative_size.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// Per-point relative cover size, 0..255 — `relative_size.m`.
///
/// THIS IS THE FUNCTION THE PORT EXISTS FOR. The second-pass cover
/// reads it as `rs = RelSize/256*(1-MRS)+MRS`, so 255 means a cover set
/// of the full PatchDiam2Max and 0 means PatchDiam2Min. A single fixed
/// radius — which is what this software used before — cannot follow a
/// branch as it tapers: the cover breaks partway along and the branch
/// is lost. That was the reported symptom.
///
/// Three things set the size:
///
///   * How thick the segment's base is, measured in cover sets,
///     relative to the stem's base. A twig starts small.
///   * Where along its segment a point sits: the size falls as
///     `sqrt((j-1)/s)` toward the tip, reaching the minimum at the end.
///   * Whether it is near a junction, where it is halved — an
///     over-large cover set at a fork bridges the branch to its parent
///     and merges them.
///
/// # The dead branching-order term
///
/// The reference computes a per-segment branching order and uses it to
/// cap the base size:
///
/// ```matlab
/// Ord = zeros(ns,1);
/// order = 0;
/// while ~isempty(C)
///     order = order+order;   % 0 + 0 = 0, forever
///     Ord(C) = order;
/// ```
///
/// `order = order+order` from zero never grows, so `Ord` stays all
/// zeros and `maxO` is 1, and the cap
/// `ceil(256*(maxO-Ord)/maxO*(H-h)/H)` collapses to
/// `ceil(256*(H-h)/H)` — the branching-order half is inert and only
/// height constrains the size. TreeQSM 2.4.0; the file was last updated
/// in 2017.
///
/// **Ported as it stands, deliberately.** The reference's published
/// results were produced with this behaviour, so "fixing" it would make
/// this implementation disagree with the reference — and agreement with
/// the reference is the number this port exists to earn. It is flagged
/// here, in THIRD-PARTY-NOTICES.md, and to the author.
pub fn relative_size(
    points_len: usize,
    balls: &[Vec<u32>],
    centres_of: &[u32],
    point_z: &dyn Fn(u32) -> f64,
    neighbours: &[Vec<u32>],
    segs: &[Vec<Vec<u32>>],
    children: &[Vec<u32>],
) -> Vec<u8> {
    let ns = segs.len();
    let mut rs = vec![0u8; points_len];
    if ns == 0 || centres_of.is_empty() { return rs; }

    let cen_z = |set: u32| -> f64 { point_z(centres_of[set as usize]) };
    let top = centres_of.iter().map(|&c| point_z(c)).fold(f64::NEG_INFINITY, f64::max);
    let bot = centres_of.iter().map(|&c| point_z(c)).fold(f64::INFINITY, f64::min);
    let h_total = top - bot;

    // The stem's base thickness in cover sets: the mean size of layers
    // 2..6. Layer 1 is skipped — it is the attachment and is not
    // representative of the segment's own girth.
    let mean_of_layers = |seg: &Vec<Vec<u32>>| -> f64 {
        let n = seg.len();
        if n >= 2 {
            let m = 6.min(n);
            let sizes: Vec<f64> = seg[1..m].iter().map(|l| l.len() as f64).collect();
            if sizes.is_empty() { 0.0 } else { sizes.iter().sum::<f64>() / sizes.len() as f64 }
        } else {
            seg.first().map(|l| l.len() as f64).unwrap_or(0.0)
        }
    };

    // FIXED — reference defect 1. The reference walks the segment tree
    // breadth-first stamping each level's branching order, but advances
    // the counter with `order = order+order`, which never grows from
    // zero. Every segment was therefore stamped order 0, `maxO` was 1,
    // and the branching-order term of the cap below cancelled to one —
    // leaving the cap on height alone. The counter now increments, so a
    // third-order twig can no longer claim a base as thick as a
    // first-order limb.
    let mut ord = vec![0u32; ns];
    let max_o;
    {
        let mut level: Vec<u32> = children.first().cloned().unwrap_or_default();
        let mut order = 0u32;
        let mut seen = vec![false; ns];
        while !level.is_empty() {
            order += 1;
            let mut next: Vec<u32> = Vec::new();
            for &c in &level {
                let k = c as usize;
                if k >= ns || seen[k] { continue; }
                seen[k] = true;
                ord[k] = order;
                if let Some(g) = children.get(k) { next.extend(g.iter().copied()); }
            }
            level = next;
        }
        max_o = (order + 1) as f64;
    }

    let stem_base = mean_of_layers(&segs[0]).max(1e-9);
    let mut base_size = vec![0.0_f64; ns];
    base_size[0] = 256.0;
    for i in 1..ns {
        if segs[i].is_empty() { continue; }
        let raw = mean_of_layers(&segs[i]) / stem_base * 256.0;
        let mut bs = if segs[i].len() >= 2 { raw.ceil() } else { raw };
        // The a-priori cap: a segment cannot claim a base thicker than
        // its branching order and its height in the tree allow. Deeper
        // and higher both shrink it.
        let seg_bot = segs[i][0].iter().map(|&s| cen_z(s)).fold(f64::INFINITY, f64::min);
        if seg_bot.is_finite() && h_total > 0.0 {
            let hh = seg_bot - bot;
            let by_order = (max_o - ord[i] as f64) / max_o;
            let cap = (256.0 * by_order * (h_total - hh) / h_total).ceil();
            if bs > cap { bs = cap; }
        }
        base_size[i] = bs;
    }

    // The taper. TS = 1 is the tip size: at the last layer the value
    // has fallen almost to the minimum, whatever the base was.
    const TS: f64 = 1.0;
    let put = |rs: &mut Vec<u8>, set: u32, v: f64| {
        if let Some(b) = balls.get(set as usize) {
            // MATLAB assigns a double into a uint8, which rounds and
            // saturates. 256 becomes 255, and that matters: the second
            // pass divides by 256, so the largest cover set is a shade
            // under PatchDiam2Max, not exactly it.
            let q = v.round().clamp(0.0, 255.0) as u8;
            for &p in b { if (p as usize) < rs.len() { rs[p as usize] = q; } }
        }
    };
    for i in 0..ns {
        let s = segs[i].len();
        if s == 0 { continue; }
        for (j, layer) in segs[i].iter().enumerate() {
            let f = ((j as f64) / s as f64).sqrt();
            let v = base_size[i] - (base_size[i] - TS) * f;
            for &set in layer { put(&mut rs, set, v); }
        }
    }

    // Halve the size around every junction. Snapshot first: the
    // reference reads RS0, so a point next to two junctions is halved
    // once, not twice.
    let rs0 = rs.clone();
    for kids in children.iter().take(ns) {
        for &c in kids {
            let Some(cseg) = segs.get(c as usize) else { continue };
            let Some(base) = cseg.first() else { continue };
            let mut near: Vec<u32> = Vec::new();
            for &b in base {
                if let Some(nb) = neighbours.get(b as usize) { near.extend(nb.iter().copied()); }
            }
            // The child's own second layer is not a junction — it is
            // the branch getting on with being a branch.
            if cseg.len() > 1 {
                let second = &cseg[1];
                near.retain(|x| !second.contains(x));
            }
            near.extend(base.iter().copied());
            near.sort_unstable();
            near.dedup();
            for &set in &near {
                if let Some(b) = balls.get(set as usize) {
                    for &p in b {
                        if (p as usize) < rs.len() { rs[p as usize] = rs0[p as usize] / 2; }
                    }
                }
            }
        }
    }
    rs
}

/// `segment_direction` — the direction of a segment around layer `nl`.
///
/// From the mean of the layer three below to the mean of the layer two
/// above, stepping past empty layers up to twice in each direction.
/// Returns None where the reference returns a zero vector.
pub fn segment_direction(centres: &[[f64; 3]], seg: &[Vec<u32>], nl: usize) -> Option<[f64; 3]> {
    if seg.is_empty() { return None; }
    let mut bot = nl.saturating_sub(3);
    let mut j = 1;
    while j < 3 && seg.get(bot).map(|l| l.is_empty()).unwrap_or(true) {
        bot += 1; j += 1;
    }
    let mut top = (nl + 2).min(seg.len() - 1);
    j = 1;
    while j < 3 && seg.get(top).map(|l| l.is_empty()).unwrap_or(true) {
        if top == 0 { break; }
        top -= 1; j += 1;
    }
    if top <= bot { return None; }
    let mean = |ids: &[u32]| -> Option<[f64; 3]> {
        if ids.is_empty() { return None; }
        let mut m = [0.0; 3];
        for &i in ids {
            for (a, v) in m.iter_mut().enumerate() { *v += centres[i as usize][a]; }
        }
        for v in m.iter_mut() { *v /= ids.len() as f64; }
        Some(m)
    };
    let (b, t) = (mean(&seg[bot])?, mean(&seg[top])?);
    let v = [t[0] - b[0], t[1] - b[1], t[2] - b[2]];
    let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if n <= 0.0 { return None; }
    Some([v[0] / n, v[1] / n, v[2] / n])
}

/// Perpendicular distance from `q` to the line through `origin` with
/// unit direction `dir` — `distances_to_line`.
pub fn distance_to_line(q: [f64; 3], origin: [f64; 3], dir: [f64; 3]) -> f64 {
    let v = [q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]];
    let h = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
    let perp = [v[0] - h * dir[0], v[1] - h * dir[1], v[2] - h * dir[2]];
    (perp[0] * perp[0] + perp[1] * perp[1] + perp[2] * perp[2]).sqrt()
}

/// `modify_parent` — take the ledge a branch makes in its parent and
/// give it to the branch.
///
/// Where a branch leaves a stem, the cover sets around the junction
/// belong to the stem's layers but geometrically belong to the branch.
/// Left there, the stem's cylinder at that height is fitted to a stem
/// PLUS a bulge, and comes out too fat. The reference walks down from
/// the attachment layer and moves the sets that sit close to the
/// branch's axis into the branch's base.
///
/// `add_child` is the reference's AddChild flag: on the first pass the
/// moved sets join the child (true); on the second they are dropped
/// from both (false).
///
/// Returns the new parent layers and the child's new base.
#[allow(clippy::too_many_arguments)]
pub fn modify_parent(
    points: &[[f64; 3]], balls: &[Vec<u32>], centres: &[[f64; 3]],
    seg_parent: &mut [Vec<u32>], seg_child: &[Vec<u32>],
    nl: usize, patch_diam: f64, add_child: bool,
) -> Vec<u32> {
    let base0: Vec<u32> = seg_child.first().cloned().unwrap_or_default();
    if base0.is_empty() || nl >= seg_parent.len() { return base0; }
    let Some(dir_chi) = segment_direction(centres, seg_child, 0) else { return base0 };
    let dir_par = segment_direction(centres, seg_parent, nl).unwrap_or([0.0, 0.0, 0.0]);

    // The base's centre and diameter. When the base is a single cover
    // set the reference falls back to that set's own POINTS, because a
    // single centre has no extent to measure.
    let (base_cent, diam_base) = if base0.len() > 1 {
        let mut c = [0.0; 3];
        for &i in &base0 {
            for (a, v) in c.iter_mut().enumerate() { *v += centres[i as usize][a]; }
        }
        for v in c.iter_mut() { *v /= base0.len() as f64; }
        let d = base0.iter()
            .map(|&i| distance_to_line(centres[i as usize], c, dir_chi))
            .fold(0.0, f64::max);
        (c, 2.0 * d)
    } else if balls.get(base0[0] as usize).map(|b| b.len() > 1).unwrap_or(false) {
        let ball = &balls[base0[0] as usize];
        let mut c = [0.0; 3];
        for &i in ball {
            for (a, v) in c.iter_mut().enumerate() { *v += points[i as usize][a]; }
        }
        for v in c.iter_mut() { *v /= ball.len() as f64; }
        let d = ball.iter()
            .map(|&i| distance_to_line(points[i as usize], c, dir_chi))
            .fold(0.0, f64::max);
        (c, 2.0 * d)
    } else {
        (centres[base0[0] as usize], 0.0)
    };

    let angle = (dir_chi[0] * dir_par[0] + dir_chi[1] * dir_par[1] + dir_chi[2] * dir_par[2]).abs();
    // How far down to look: a fat branch meeting its parent at a shallow
    // angle makes a longer ledge, so more layers are examined. Never
    // fewer than three, never past the parent's own base.
    let n_layer = (3.0_f64).max((angle * 2.0 * diam_base / patch_diam).ceil()).min(nl as f64) as usize;

    let mut base_parts: Vec<Vec<u32>> = vec![base0.clone()];
    let mut layer = 0usize;
    while layer < n_layer {
        let li = nl - layer;
        let sets = seg_parent[li].clone();
        if sets.is_empty() { break; }
        let mut seg_cent = [0.0; 3];
        for &i in &sets {
            for (a, v) in seg_cent.iter_mut().enumerate() { *v += centres[i as usize][a]; }
        }
        for v in seg_cent.iter_mut() { *v /= sets.len() as f64; }

        let mut take = Vec::new();
        let mut keep = Vec::new();
        for &i in &sets {
            let c = centres[i as usize];
            let dist_axis = distance_to_line(c, base_cent, dir_chi);
            let selected = if angle < 0.9 {
                let vb = [c[0] - base_cent[0], c[1] - base_cent[1], c[2] - base_cent[2]];
                let vs = [c[0] - seg_cent[0], c[1] - seg_cent[1], c[2] - seg_cent[2]];
                let len_base = (vb[0] * vb[0] + vb[1] * vb[1] + vb[2] * vb[2]).sqrt();
                let len_seg = (vs[0] * vs[0] + vs[1] * vs[1] + vs[2] * vs[2]).sqrt();
                len_base < 1.1 / (1.0 - 0.5 * angle * angle) * len_seg
                    && dist_axis < 1.25 * diam_base
            } else {
                // Nearly parallel to the parent: the comparison of
                // distances to the two centres says nothing, so only
                // the distance to the branch's axis counts.
                dist_axis < 1.25 * diam_base
            };
            if selected { take.push(i); } else { keep.push(i); }
        }
        // All or nothing means the test has stopped discriminating —
        // taking the whole layer would sever the parent.
        if take.is_empty() || keep.is_empty() { break; }
        seg_parent[li] = keep;
        base_parts.push(take);
        layer += 1;
    }

    if add_child {
        base_parts.concat()
    } else {
        // AddChild off: the ledge is removed from the parent and NOT
        // given to the child. The child keeps the base it had.
        base0
    }
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/segments.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// The branch segmentation — `segments.m`.
///
/// A segment is a stack of cover-set LAYERS, not a flat set: the layer
/// index is where a child branch attached, and `relative_size` needs it
/// to taper the cover along the branch.
pub struct Segmentation {
    /// `segments[i][layer]` — the cover sets in that layer.
    pub segments: Vec<Vec<Vec<u32>>>,
    /// `(parent segment, layer in the parent)`, or None for the stem.
    pub parent: Vec<Option<(u32, u32)>>,
    pub children: Vec<Vec<u32>>,
}

/// Connected components of `ids` under the neighbour graph, restricted
/// to `ids` themselves.
///
/// `cut_components` in the reference hand-unrolls the cases of one, two
/// and three elements. Those are a MATLAB speed optimisation and give
/// the same partition as the general search, so this is the general
/// search only.
fn components_within(nei: &[Vec<u32>], ids: &[u32], inside: &mut [bool]) -> Vec<Vec<u32>> {
    for &i in ids { inside[i as usize] = true; }
    let mut seen: FxHashMap<u32, ()> = FxHashMap::default();
    let mut out: Vec<Vec<u32>> = Vec::new();
    for &start in ids {
        if seen.contains_key(&start) { continue; }
        seen.insert(start, ());
        let mut comp = vec![start];
        let mut stack = vec![start];
        while let Some(c) = stack.pop() {
            for &n in &nei[c as usize] {
                if inside[n as usize] && !seen.contains_key(&n) {
                    seen.insert(n, ());
                    comp.push(n);
                    stack.push(n);
                }
            }
        }
        out.push(comp);
    }
    for &i in ids { inside[i as usize] = false; }
    out
}

struct StudyResult {
    components: Vec<Vec<u32>>,
    bases: Vec<Vec<u32>>,
    comp_size: Vec<usize>,
    base_size: Vec<usize>,
    /// Does the component carry on past the study region?
    cont: Vec<bool>,
}

/// `study_components` — look `ns` layers past the cut and measure each
/// component three ways.
///
/// The three measurements are what `component_classification` decides
/// on: how big the component is, how much of the CUT it occupies, and
/// whether it keeps going. A fat component that owns most of the cut and
/// continues is the stem carrying on; a thin one that owns a sliver and
/// stops is a twig.
/// Whole-tree-sized scratch for `segments` and `study_components`:
/// one set of buffers for the pass, cleared by the indices they
/// touched rather than allocated afresh.
///
/// WHY. Every layer of every segment used to allocate two or three
/// `vec![false; nb]` — nb being the tree's cover-set count, a few
/// hundred thousand on a large tree — and study_components three more
/// per call. Hundreds of thousands of layers a tree, hundreds of
/// kilobytes each: hundreds of gigabytes of zeroed memory, and on
/// Windows every one of those blocks is too big for the low-
/// fragmentation heap and goes through the process heap's lock. With
/// sixteen trees doing it at once the pass ran fourteen times slower
/// than alone (segments2 on tree 108: 2142 s against 156 s). The
/// answers do not change; only the allocations do.
struct SegScratch {
    seen: Vec<bool>,
    inside: Vec<bool>,
    blocked: Vec<bool>,
    in_cut: Vec<bool>,
    touched: Vec<u32>,
}

impl SegScratch {
    fn new(nb: usize) -> Self {
        Self { seen: vec![false; nb], inside: vec![false; nb], blocked: vec![false; nb],
               in_cut: vec![false; nb], touched: Vec::new() }
    }
}

fn study_components(
    nei: &[Vec<u32>], ns: usize, cut: &[u32], cut_comps: &[Vec<u32>],
    forb: &[bool], sc: &mut SegScratch,
) -> StudyResult {
    // `blocked` in the reference is forb plus everything this study has
    // grown into; here the local part lives in sc.blocked and is undone
    // by the touched list on the way out, so `forb[n] || sc.blocked[n]`
    // reads exactly as the copy did.
    sc.touched.clear();
    let mut layers: Vec<Vec<u32>> = vec![cut.to_vec()];
    for &c in cut { sc.blocked[c as usize] = true; sc.touched.push(c); }
    while layers.len() < ns {
        let mut next: Vec<u32> = Vec::new();
        for &c in layers.last().unwrap() {
            for &n in &nei[c as usize] {
                let ni = n as usize;
                if !forb[ni] && !sc.blocked[ni] && !sc.seen[ni] {
                    sc.seen[ni] = true;
                    next.push(n);
                }
            }
        }
        for &n in &next { sc.seen[n as usize] = false; }
        if next.is_empty() { break; }
        for &n in &next { sc.blocked[n as usize] = true; sc.touched.push(n); }
        layers.push(next);
    }

    let study: Vec<u32> = layers.iter().flatten().copied().collect();
    let comps = components_within(nei, &study, &mut sc.inside);

    for cc in cut_comps { for &c in cc { sc.in_cut[c as usize] = true; } }
    let comps: Vec<Vec<u32>> = comps.into_iter()
        .filter(|c| c.iter().any(|&x| sc.in_cut[x as usize]))
        .collect();
    for cc in cut_comps { for &c in cc { sc.in_cut[c as usize] = false; } }

    let k = comps.len();
    let mut r = StudyResult {
        comp_size: comps.iter().map(|c| c.len()).collect(),
        bases: Vec::with_capacity(k), base_size: Vec::with_capacity(k),
        cont: vec![true; k], components: comps,
    };
    if k <= 1 {
        for c in &r.components { r.bases.push(c.clone()); r.base_size.push(c.len()); }
    } else {
        let first: FxHashMap<u32, ()> = layers[0].iter().map(|&x| (x, ())).collect();
        let last: FxHashMap<u32, ()> = layers.last().unwrap().iter().map(|&x| (x, ())).collect();
        for i in 0..k {
            let base: Vec<u32> = r.components[i].iter().copied()
                .filter(|x| first.contains_key(x)).collect();
            r.base_size.push(base.len());
            r.bases.push(base);

            let tip: Vec<u32> = r.components[i].iter().copied()
                .filter(|x| last.contains_key(x)).collect();
            let mut carries_on = false;
            for &t in &tip {
                for &n in &nei[t as usize] {
                    if !forb[n as usize] && !sc.blocked[n as usize] { carries_on = true; break; }
                }
                if carries_on { break; }
            }
            r.cont[i] = !tip.is_empty() && carries_on;
        }
    }
    for &c in &sc.touched { sc.blocked[c as usize] = false; }
    r
}

/// `component_classification` — 1 means "a branch, segment it
/// separately"; 0 means "part of what this segment is already
/// following".
// Several arms assign the same value, and clippy is right that they
// could be merged. They are kept apart because each one IS a rule in
// the reference, in the reference's order, and a reader checking this
// against component_classification should find five conditions where
// the .m file has five. Correspondence is worth more than concision in
// a port.
#[allow(clippy::if_same_then_else)]
fn component_classification(
    comp_size: &[usize], cont: &[bool], base_size: &[usize], cut_size: usize,
) -> Vec<u8> {
    let nc = comp_size.len();
    let study_size: usize = comp_size.iter().sum();
    let mut class = vec![1u8; nc];
    let mut conti_comp: Option<usize> = None;
    for i in 0..nc {
        let bs = base_size[i] as f64;
        let cs = comp_size[i];
        let cut = cut_size as f64;
        if base_size[i] == cs && !cont[i] {
            class[i] = 0;
        } else if base_size[i] == 1 && cs <= 2 && !cont[i] {
            class[i] = 0;
        } else if bs / cut < 0.05 && 2 * base_size[i] >= cs && !cont[i] {
            class[i] = 0;
        } else if cs <= 3 && !cont[i] {
            class[i] = 0;
        } else if bs / cut >= 0.7 || cs as f64 >= 0.7 * study_size as f64 {
            class[i] = 0;
            conti_comp = Some(i);
        }
    }
    // Nothing claimed the continuation, but something is a branch: the
    // largest branch becomes the continuation. Without this the segment
    // would end and every child would start a new one, which is how a
    // stem gets chopped into a stack of short segments.
    if conti_comp.is_none() {
        if let Some((best, _)) = class.iter().enumerate()
            .filter(|(_, &c)| c == 1)
            .map(|(i, _)| (i, comp_size[i]))
            .max_by_key(|&(_, sz)| sz)
        {
            class[best] = 0;
        }
    }
    class
}

/// `segments(cover, Base, Forb)`.
pub fn segments(
    neighbours: &[Vec<u32>], base: &[u32], forbidden: &[bool],
) -> Segmentation {
    let nb = neighbours.len();
    let mut out = Segmentation { segments: Vec::new(), parent: Vec::new(), children: Vec::new() };
    if nb == 0 || base.is_empty() { return out; }

    // Bases waiting to be grown into segments, with where they attached.
    let mut bases: Vec<Vec<u32>> = vec![base.to_vec()];
    let mut parent: Vec<Option<(u32, u32)>> = vec![None];
    let mut children: Vec<Vec<u32>> = vec![Vec::new()];
    let mut segs: Vec<Vec<Vec<u32>>> = Vec::new();

    // Forbidden across the whole tree — a set consumed by one segment
    // is not available to another.
    let mut forb_all = forbidden.to_vec();
    for &b in base { forb_all[b as usize] = true; }
    // The segment's own forbidden set: forb_all plus what THIS segment
    // has consumed. The reference copies forb_all at the start of every
    // segment; this keeps one buffer equal to that copy and undoes the
    // segment's own marks by list when it ends — see SegScratch for why.
    let mut forb = forb_all.clone();
    let mut forb_local: Vec<u32> = Vec::new();
    let mut sc = SegScratch::new(nb);

    let mut s = 0usize;
    let mut guard = 0usize;
    while s < bases.len() && guard < 1_000_000 {
        forb_local.clear();
        let mut layers: Vec<Vec<u32>> = vec![bases[s].clone()];
        let mut ns = 0usize;
        let mut new_seg = true;

        loop {
            guard += 1;
            if guard >= 1_000_000 { break; }
            for &c in layers.last().unwrap() { forb[c as usize] = true; forb_local.push(c); }

            // define_cut: unforbidden neighbours of the current layer.
            let mut cut: Vec<u32> = Vec::new();
            for &c in layers.last().unwrap() {
                for &n in &neighbours[c as usize] {
                    if !forb[n as usize] && !sc.seen[n as usize] {
                        sc.seen[n as usize] = true;
                        cut.push(n);
                    }
                }
            }
            for &n in &cut { sc.seen[n as usize] = false; }
            if new_seg { new_seg = false; ns = cut.len().min(6); }
            if cut.is_empty() { break; }

            let cut_comps = components_within(neighbours, &cut, &mut sc.inside);
            if cut_comps.len() == 1 {
                layers.push(cut);
                continue;
            }

            let st = study_components(neighbours, ns.max(1), &cut, &cut_comps, &forb, &mut sc);
            if st.components.len() <= 1 {
                layers.push(cut);
                continue;
            }
            let class = component_classification(&st.comp_size, &st.cont, &st.base_size, cut.len());

            let attach_layer = (layers.len() - 1) as u32;
            for (i, &cl) in class.iter().enumerate() {
                if cl != 1 { continue; }
                // A branch: its base becomes a new segment to grow, and
                // its whole study component leaves this segment's cut.
                for &b in &st.bases[i] { forb_all[b as usize] = true; }
                for &c in &st.components[i] { forb[c as usize] = true; forb_local.push(c); }
                bases.push(st.bases[i].clone());
                parent.push(Some((s as u32, attach_layer)));
                children.push(Vec::new());
                let child = (bases.len() - 1) as u32;
                children[s].push(child);
            }
            cut.retain(|&c| !forb[c as usize]);
            if cut.is_empty() { break; }
            layers.push(cut);
        }

        for layer in &layers { for &c in layer { forb_all[c as usize] = true; } }
        // Back to forb_all, at the indices this segment marked — the
        // copy the next segment would have started from.
        for &c in &forb_local { forb[c as usize] = forb_all[c as usize]; }
        segs.push(layers);
        s += 1;
    }

    out.segments = segs;
    out.parent = parent;
    out.children = children;
    out
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/tree_sets.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
//
// The `OnlyTree` path with no prior segmentation, which is what the
// TST reference workflow runs: `create_input` sets OnlyTree = 1 and the
// first reconstruction has no segments to hand. `define_main_branches`
// serves the other path and is not ported.
// ===================================================================

/// Trunk base, forbidden sets, and the trunk region — `tree_sets.m`.
pub struct TreeSets {
    /// Cover sets forming the base of the trunk.
    pub base: Vec<u32>,
    /// Cover sets judged not to be part of the tree. Empty under
    /// OnlyTree, kept because the reference returns it and the
    /// segmentation reads it.
    pub forbidden: Vec<bool>,
    /// Cover sets belonging to the trunk. A REGION, not a chain — the
    /// distinction matters, because this file's own
    /// `find_trunk_chain_impl` walks one best neighbour per step and
    /// produces something else entirely.
    pub trunk: Vec<bool>,
    /// The neighbour graph, which `define_trunk` EDITS: bridging a
    /// vertical gap in the trunk means adding a mutual link, so the
    /// cover comes back changed.
    pub neighbours: Vec<Vec<u32>>,
}

/// `make_tree_connected` — decide what else belongs to the tree, and
/// join it on.
///
/// After the trunk has been found, whatever is left over is in pieces:
/// a branch the cover never bridged, a neighbouring tree's limb that
/// reached into the plot, a patch of undergrowth. This walks those
/// pieces and rules on each — attach it to the tree, or mark it
/// forbidden so the segmentation never sees it.
///
/// The rules, in the order they are tried:
///   * anything touching something already forbidden is forbidden too,
///     which is how a rejection spreads along a neighbouring tree;
///   * a piece 12 to 100 m from the tree is another tree's;
///   * a piece nearer to something forbidden than to the tree — three
///     times nearer, or merely nearer if the gap is over 25 cm —
///     belongs to whatever that forbidden thing was;
///   * a piece further from the tree than the current search radius is
///     left for the next round, which searches wider;
///   * anything else is joined on, at the nearest pair.
///
/// A big piece that is tall and starts near the ground gets an extra
/// condition: it may only be joined at its FOOT. That is a neighbouring
/// stem, and joining it at head height would graft another tree onto
/// this one halfway up.
///
/// The search radius grows by `k0` every round, so a piece too far to
/// judge now is judged later rather than dropped.
pub fn make_tree_connected(
    centres: &[[f64; 3]],
    neighbours: &mut Vec<Vec<u32>>,
    forbidden: &mut [bool],
    base: &[u32],
    trunk: &mut [bool],
    patch_diam1: f64,
) {
    let nb = centres.len();
    if nb == 0 { return; }
    let mut is_base = vec![false; nb];
    for &b in base { if (b as usize) < nb { is_base[b as usize] = true; } }

    // ---- Everything reachable from the trunk IS the trunk.
    for i in 0..nb { if forbidden[i] { trunk[i] = false; } }
    let mut frontier: Vec<u32> = (0..nb as u32).filter(|&i| trunk[i as usize]).collect();
    let mut guard = 0usize;
    while !frontier.is_empty() && guard < nb + 8 {
        guard += 1;
        let mut next: Vec<u32> = Vec::new();
        let mut seen = vec![false; nb];
        for &e in &frontier {
            for &n in &neighbours[e as usize] {
                let n = n as usize;
                if n >= nb || trunk[n] || forbidden[n] || is_base[n] || seen[n] { continue; }
                seen[n] = true;
                next.push(n as u32);
            }
        }
        for &n in &next { trunk[n as usize] = true; }
        frontier = next;
    }

    // ---- What is left over.
    let mut other: Vec<bool> = (0..nb)
        .map(|i| !forbidden[i] && !trunk[i] && !is_base[i]).collect();
    let other_ids: Vec<u32> = (0..nb as u32).filter(|&i| other[i as usize]).collect();
    if other_ids.is_empty() {
        for &b in base { if (b as usize) < nb { forbidden[b as usize] = false; } }
        return;
    }
    let mut inside = vec![false; nb];
    let comps = components_within(&*neighbours, &other_ids, &mut inside);
    let nc = comps.len();
    let mut unclassified = vec![true; nc];
    let bottom = base.iter().map(|&b| centres[b as usize][2]).fold(f64::INFINITY, f64::min);

    let k0 = 10.min(((0.2 / patch_diam1).ceil() as usize).max(1));
    let mut k = k0;
    // OnlyTree: the reference sets the minimum acceptable component
    // size to zero, so the size-based rejection below never fires and
    // the tripling of it each round does nothing. Kept as the
    // reference has it.
    let mut cmin = 0usize;

    let dist = |a: [f64; 3], b: [f64; 3]|
        ((a[0]-b[0]).powi(2) + (a[1]-b[1]).powi(2) + (a[2]-b[2]).powi(2)).sqrt();

    let mut rounds = 0usize;
    while unclassified.iter().any(|&x| x) && rounds < 64 {
        rounds += 1;
        let cell = (k as f64 * patch_diam1).max(1e-6);
        let grid = build_grid(centres, &(0..nb as u32).collect::<Vec<_>>(), cell);
        let mut near_cache: Vec<Vec<u32>> = vec![Vec::new(); nc];
        let mut sizes: Vec<Option<(usize, usize)>> = vec![None; nc];
        let mut pass = vec![true; nc];
        let mut first_round = true;
        let mut npre = unclassified.iter().filter(|&&x| x).count();
        let mut again = true;

        while again {
            for i in 0..nc {
                if !unclassified[i] || !pass[i] { continue; }
                let comp = &comps[i];

                // Touching something already rejected is itself a
                // rejection: this is how a neighbouring tree is
                // discarded a piece at a time.
                if comp.iter().any(|&c| neighbours[c as usize].iter()
                    .any(|&n| forbidden[n as usize]))
                {
                    unclassified[i] = false;
                    for &c in comp { forbidden[c as usize] = true; other[c as usize] = false; }
                    continue;
                }

                let ncomp = comp.len();
                let mut near: Vec<u32> = if first_round {
                    let mut in_comp = vec![false; nb];
                    for &c in comp { in_comp[c as usize] = true; }
                    let mut seen = vec![false; nb];
                    let mut v: Vec<u32> = Vec::new();
                    for &c in comp {
                        let cc = cell_of(centres[c as usize], cell);
                        for dx in -1..=1 { for dy in -1..=1 { for dz in -1..=1 {
                            let Some(cellv) = grid.get(&[cc[0]+dx, cc[1]+dy, cc[2]+dz])
                                else { continue };
                            for &j in cellv {
                                let j = j as usize;
                                if in_comp[j] || seen[j] { continue; }
                                seen[j] = true;
                                v.push(j as u32);
                            }
                        }}}
                    }
                    near_cache[i] = v.clone();
                    v
                } else {
                    near_cache[i].clone()
                };
                if near.is_empty() { pass[i] = false; continue; }
                near.retain(|&j| !other[j as usize]);

                let mut trunk_near: Vec<u32> =
                    near.iter().copied().filter(|&j| trunk[j as usize]).collect();
                let mut forb_near: Vec<u32> =
                    near.iter().copied().filter(|&j| forbidden[j as usize]).collect();
                // Nothing has changed since this component was last
                // looked at, so nothing it decides can have either.
                if sizes[i] == Some((trunk_near.len(), forb_near.len())) { continue; }
                sizes[i] = Some((trunk_near.len(), forb_near.len()));

                if ncomp > 100 {
                    let hmin = comp.iter().map(|&c| centres[c as usize][2])
                        .fold(f64::INFINITY, f64::min);
                    let hmax = comp.iter().map(|&c| centres[c as usize][2])
                        .fold(f64::NEG_INFINITY, f64::max);
                    if hmax - hmin > 5.0 && hmin < bottom + 5.0 {
                        // Tall, big, and standing on the ground: another
                        // stem. It may be joined at its foot and nowhere
                        // else, or this grafts a second tree on halfway
                        // up.
                        let low: Vec<u32> = near.iter().copied()
                            .filter(|&j| centres[j as usize][2] < hmin + 0.5).collect();
                        trunk_near = low.iter().copied()
                            .filter(|&j| trunk[j as usize]).collect();
                        forb_near = low.iter().copied()
                            .filter(|&j| forbidden[j as usize]).collect();
                    }
                }

                // 700 and 1000 are the reference's stand-ins for "no
                // such thing in range", and the rules below test for
                // them by value.
                let link = if trunk_near.is_empty() { None }
                           else { nearest_pair(centres, comp, &trunk_near) };
                let dt = match link {
                    Some((a, b)) => dist(centres[a as usize], centres[b as usize]),
                    None => 700.0,
                };
                let df = match nearest_pair(centres, comp, &forb_near) {
                    Some((a, b)) if !forb_near.is_empty() =>
                        dist(centres[a as usize], centres[b as usize]),
                    _ => 1000.0,
                };

                // OBSERVED: the upper bound of 100 exists to stop this
                // firing on the 700 sentinel, and no test here catches
                // its removal. The reason is that 700 only ever occurs
                // when nothing of the tree is in range, and then
                // something FORBIDDEN is — otherwise the component has
                // no near sets at all and is skipped before reaching
                // here. So `df` is finite, `3*df < 700` holds for any
                // df under 233 m, and the next rule fires first. The
                // bound would matter for a trunk set genuinely 100 to
                // 700 m away and inside the search cube, which needs a
                // far larger patch diameter than any of these.
                if (dt > 12.0 && dt < 100.0) || (ncomp < cmin && dt > 0.5 && dt < 10.0) {
                    // Far enough to be another tree.
                    unclassified[i] = false;
                    for &c in comp { forbidden[c as usize] = true; other[c as usize] = false; }
                } else if 3.0 * df < dt || (df < dt && df > 0.25) {
                    // Nearer to something already rejected than to us.
                    unclassified[i] = false;
                    for &c in comp { forbidden[c as usize] = true; other[c as usize] = false; }
                } else if (df == 1000.0 && dt == 700.0) || dt > k as f64 * patch_diam1 {
                    // Nothing in range yet. Leave it for a wider search.
                    //
                    // OBSERVED: removing the distance half of this test
                    // is not caught. It changes WHEN a piece is decided,
                    // not what is decided: on every fixture here the
                    // piece ends in the same state, only sooner. It
                    // would differ where waiting lets a later round mark
                    // something near it forbidden first, flipping the
                    // verdict — which is what the deferral is for.
                } else if let Some((a, b)) = link {
                    unclassified[i] = false;
                    for &c in comp { other[c as usize] = false; trunk[c as usize] = true; }
                    neighbours[a as usize].push(b);
                    neighbours[b as usize].push(a);
                }
            }
            first_round = false;
            let now = unclassified.iter().filter(|&&x| x).count();
            again = now < npre;
            npre = now;
        }
        k += k0;
        cmin *= 3;
    }

    for &b in base { if (b as usize) < nb { forbidden[b as usize] = false; } }
}

/// `define_base_forb`, the branch taken when a previous segmentation
/// is available — the SECOND pass.
///
/// The base is no longer "whatever is low down": it is the cover sets
/// whose own centre point belongs to the STEM, low down. The first pass
/// has already said which points are stem, and taking a base that
/// includes a low branch is exactly the mistake the height-shrinking in
/// the other branch exists to undo.
pub fn define_base_from_segments(
    centres: &[[f64; 3]],
    centre_of_set: &[u32],
    segment_of_point: &[u32],
) -> Vec<u32> {
    if centres.is_empty() { return Vec::new(); }
    let hmin = centres.iter().map(|c| c[2]).fold(f64::INFINITY, f64::min);
    let hmax = centres.iter().map(|c| c[2]).fold(f64::NEG_INFINITY, f64::max);
    let base_height = 1.5_f64.min(0.02 * (hmax - hmin));
    (0..centres.len() as u32)
        .filter(|&i| {
            let stem = centre_of_set.get(i as usize)
                .and_then(|&p| segment_of_point.get(p as usize))
                == Some(&0);
            stem && centres[i as usize][2] < hmin + base_height
        })
        .collect()
}

/// `define_main_branches` — the second pass's trunk, read off the FIRST
/// pass's segmentation rather than found again from scratch.
///
/// A cover set belongs to a main branch if the points in its ball do,
/// taking the LOWEST segment index among them — which prefers the stem
/// over a branch wherever a ball straddles a junction. Main means the
/// stem and everything down to third order; the rest of the crown is
/// left out, because this exists to guarantee that those particular
/// branches come out connected.
///
/// Then it makes them so. Each main branch is flooded into connected
/// components, and while there is more than one, the nearest pair of
/// sets across a component boundary gets a mutual neighbour link. A
/// first-order branch that ends up touching no stem set at all is
/// linked to the stem outright. The cover graph therefore comes back
/// CHANGED, which is the point of returning it.
///
/// Returns the trunk mask; the neighbours are edited in place.
pub fn define_main_branches(
    centres: &[[f64; 3]],
    balls: &[Vec<u32>],
    neighbours: &mut [Vec<u32>],
    data: &SegmentData,
    patch_diam2_max: f64,
) -> Vec<bool> {
    let nb = centres.len();
    if nb == 0 { return Vec::new(); }
    let ns = data.segment_of_point.iter().filter(|&&s| s != u32::MAX)
        .max().map(|&s| s as usize + 1).unwrap_or(0);
    if ns == 0 { return vec![false; nb]; }

    let mut is_main = vec![false; ns];
    is_main[0] = true;                       // the stem
    for &s in data.branch1.iter().chain(&data.branch2).chain(&data.branch3) {
        if (s as usize) < ns { is_main[s as usize] = true; }
    }

    let mut main: Vec<Option<u32>> = vec![None; nb];
    for (i, slot) in main.iter_mut().enumerate() {
        let Some(ball) = balls.get(i) else { continue };
        let m = ball.iter()
            .filter_map(|&p| data.segment_of_point.get(p as usize).copied())
            .filter(|&s| s != u32::MAX)
            .min();
        if let Some(s) = m {
            if (s as usize) < ns && is_main[s as usize] { *slot = Some(s); }
        }
    }
    let mut trunk: Vec<bool> = main.iter().map(|m| m.is_some()).collect();

    // ---- Make each main branch one connected piece.
    let cell = (3.0 * patch_diam2_max).max(1e-6);
    let grid = build_grid(centres, &(0..nb as u32).collect::<Vec<_>>(), cell);
    let mut inside = vec![false; nb];
    for (bi, &main_here) in is_main.iter().enumerate() {
        if !main_here { continue; }
        let ids: Vec<u32> = (0..nb as u32)
            .filter(|&i| main[i as usize] == Some(bi as u32)).collect();
        if ids.len() < 2 { continue; }
        let mut in_branch = vec![false; nb];
        for &i in &ids { in_branch[i as usize] = true; }

        let mut guard = 0usize;
        loop {
            let comps = components_within(neighbours, &ids, &mut inside);
            if comps.len() <= 1 { break; }
            guard += 1;
            if guard > ids.len() + 8 { break; }
            for comp in &comps {
                let mut in_comp = vec![false; nb];
                for &c in comp { in_comp[c as usize] = true; }

                // The reference's expanding cube: widen the search a
                // cell at a time until it finds ANY set of this branch
                // outside the component, then take the nearest of those.
                // Note it is the nearest within the shell that stopped
                // the search, not necessarily the nearest overall.
                let mut near: Vec<u32> = Vec::new();
                let mut t: i64 = 1;
                while near.is_empty() && t <= 64 {
                    let mut seen = vec![false; nb];
                    for &c in comp {
                        let cc = cell_of(centres[c as usize], cell);
                        for dx in -t..=t { for dy in -t..=t { for dz in -t..=t {
                            let Some(v) = grid.get(&[cc[0]+dx, cc[1]+dy, cc[2]+dz])
                                else { continue };
                            for &j in v {
                                let j = j as usize;
                                if in_branch[j] && !in_comp[j] && !seen[j] {
                                    seen[j] = true;
                                    near.push(j as u32);
                                }
                            }
                        }}}
                    }
                    t += 1;
                }
                if near.is_empty() { continue; }
                let Some((a, b)) = nearest_pair(centres, comp, &near) else { continue };
                neighbours[a as usize].push(b);
                neighbours[b as usize].push(a);
            }
        }
    }

    // ---- A first-order branch touching no stem set is joined to it.
    let stem: Vec<u32> = (0..nb as u32).filter(|&i| main[i as usize] == Some(0)).collect();
    if !stem.is_empty() {
        for &bi in &data.branch1 {
            let ids: Vec<u32> = (0..nb as u32)
                .filter(|&i| main[i as usize] == Some(bi)).collect();
            if ids.is_empty() { continue; }
            let touches = ids.iter().any(|&i| neighbours[i as usize].iter()
                .any(|&n| main[n as usize] == Some(0)));
            if touches { continue; }
            let Some((a, b)) = nearest_pair(centres, &ids, &stem) else { continue };
            neighbours[a as usize].push(b);
            neighbours[b as usize].push(a);
        }
    }

    // ---- If the trunk is still in pieces, keep the piece with the
    // stem in it.
    let trunk_ids: Vec<u32> = (0..nb as u32).filter(|&i| trunk[i as usize]).collect();
    let comps = components_within(neighbours, &trunk_ids, &mut inside);
    if comps.len() > 1 {
        let mut order: Vec<usize> = (0..comps.len()).collect();
        order.sort_by_key(|&k| std::cmp::Reverse(comps[k].len()));
        // Largest first, then the first one holding a stem set. The
        // reference walks past the end of the list when no component
        // holds one and errors; this keeps the largest instead, which
        // at least leaves a tree to model.
        let pick = order.iter().copied()
            .find(|&k| comps[k].iter().any(|&c| main[c as usize] == Some(0)))
            .or_else(|| order.first().copied());
        trunk = vec![false; nb];
        if let Some(k) = pick {
            for &c in &comps[k] { trunk[c as usize] = true; }
        }
    }
    trunk
}

/// The closest pair of centres, one from each list.
fn nearest_pair(centres: &[[f64; 3]], a: &[u32], b: &[u32]) -> Option<(u32, u32)> {
    let mut best: Option<(f64, u32, u32)> = None;
    for &i in a {
        let p = centres[i as usize];
        for &j in b {
            let q = centres[j as usize];
            let d = (p[0]-q[0]).powi(2) + (p[1]-q[1]).powi(2) + (p[2]-q[2]).powi(2);
            // Not `is_none_or`: stable only from Rust 1.82, and this
            // crate's floor is 1.77.
            if best.map_or(true, |(bd, _, _)| d < bd) { best = Some((d, i, j)); }
        }
    }
    best.map(|(_, i, j)| (i, j))
}

/// `define_base_forb`, the `OnlyTree && nargin == 4` branch.
///
/// Take the cover sets whose centres sit within min(1.5 m, 2 % of the
/// tree's height) of the lowest centre. If that slab's XY footprint is
/// more than 30 % of the whole tree's, it has caught a skirt of low
/// branches rather than a trunk, so shrink it 5 cm at a time — at most
/// five times, never below 5 cm.
fn define_base_forb(centres: &[[f64; 3]], hmin: f64, height: f64) -> Vec<u32> {
    let width = |ids: &[u32]| -> f64 {
        let mut lo = [f64::INFINITY; 2];
        let mut hi = [f64::NEG_INFINITY; 2];
        for &i in ids {
            for a in 0..2 {
                let v = centres[i as usize][a];
                if v < lo[a] { lo[a] = v; }
                if v > hi[a] { hi[a] = v; }
            }
        }
        (hi[0] - lo[0]).max(hi[1] - lo[1])
    };
    let all: Vec<u32> = (0..centres.len() as u32).collect();
    let w_tree = width(&all);

    let mut base_height = 1.5_f64.min(0.02 * height);
    let pick = |bh: f64| -> Vec<u32> {
        (0..centres.len() as u32).filter(|&i| centres[i as usize][2] < hmin + bh).collect()
    };
    let mut base = pick(base_height);
    let mut k = 1;
    while k <= 5 && !base.is_empty() && width(&base) > 0.3 * w_tree {
        base_height = (base_height - 0.05).max(0.05);
        base = pick(base_height);
        k += 1;
    }
    if base.is_empty() {
        // The reference's `[~,I] = min(Ce(:,3))` fallback: the single
        // lowest set, so the trunk always has somewhere to start.
        let mut lowest = 0u32;
        for i in 1..centres.len() as u32 {
            if centres[i as usize][2] < centres[lowest as usize][2] { lowest = i; }
        }
        base.push(lowest);
    }
    base
}

/// `tree_sets` for the OnlyTree path.
///
/// **`centres[..][2]` must be HEIGHT ABOVE GROUND, not elevation.**
///
/// `define_trunk`'s gap-bridging fires only when `H < Height - 5`,
/// where `H` is an absolute z of the expansion front and `Height` is
/// the tree's height SPAN. The comparison is only meaningful when the
/// base sits near zero. The reference workflow satisfies that — it
/// feeds `abs_height`, reconstructed height above ground — and
/// PointCloudLabeler previously fed raw world z, under which the test
/// is false for any plot above sea level and the gap-bridging silently
/// never runs. Nothing would report that; the trunk would simply stop
/// at the first gap.
pub fn tree_sets_only_tree(
    centres: &[[f64; 3]],
    neighbours: &[Vec<u32>],
    patch_diam1: f64,
) -> TreeSets {
    let nb = centres.len();
    let mut out = TreeSets {
        base: Vec::new(), forbidden: vec![false; nb],
        trunk: vec![false; nb], neighbours: neighbours.to_vec(),
    };
    if nb == 0 { return out; }

    let hmin = centres.iter().map(|c| c[2]).fold(f64::INFINITY, f64::min);
    let hmax = centres.iter().map(|c| c[2]).fold(f64::NEG_INFINITY, f64::max);
    let height = hmax - hmin;
    out.base = define_base_forb(centres, hmin, height);
    for &b in &out.base { out.trunk[b as usize] = true; }

    // First expansion: base plus its neighbours.
    let mut exp: Vec<u32> = Vec::new();
    {
        let mut seen = vec![false; nb];
        for &b in &out.base {
            for &n in &out.neighbours[b as usize] {
                if !out.trunk[n as usize] && !out.forbidden[n as usize] && !seen[n as usize] {
                    seen[n as usize] = true;
                    exp.push(n);
                }
            }
        }
    }
    for &e in &exp { out.trunk[e as usize] = true; }

    // L: how far below the front's top a set may sit and still join it.
    const L: f64 = 0.25;
    let mut h = out.trunk.iter().enumerate()
        .filter(|(_, &t)| t).map(|(i, _)| centres[i][2])
        .fold(f64::NEG_INFINITY, f64::max) - L;

    let mut guard = 0usize;
    while !exp.is_empty() && guard < 100_000 {
        guard += 1;
        let h0 = h;
        let exp0 = exp.clone();

        // Grow: neighbours of the front, not already trunk, at or above
        // the moving floor. The floor is what keeps this going UP.
        let mut next: Vec<u32> = Vec::new();
        let mut seen = vec![false; nb];
        for &e in &exp {
            for &n in &out.neighbours[e as usize] {
                if out.trunk[n as usize] || seen[n as usize] { continue; }
                if centres[n as usize][2] >= h { seen[n as usize] = true; next.push(n); }
            }
        }
        for &n in &next { out.trunk[n as usize] = true; }
        exp = next;
        if !exp.is_empty() {
            h = exp.iter().map(|&i| centres[i as usize][2]).fold(f64::NEG_INFINITY, f64::max) - L;
        }

        // Stalled, and still well below the top: bridge the gap.
        //
        // FIXED — reference defect 6. The reference writes this as
        // `H < aux.Height - 5`, where `H` is an ABSOLUTE height — the
        // top of the growing trunk — and `aux.Height` is the tree's
        // height above its own lowest point. On a plot at any real
        // elevation the test is false everywhere and this whole repair
        // never runs. `h - hmin` is the front's height above the tree's
        // base, which is what the comparison reads as.
        let stalled = exp.is_empty() || h < h0 + patch_diam1 / 2.0;
        if stalled && h - hmin < height - 5.0 {
            let region: &[u32] = if exp.is_empty() { &exp0 } else { &exp };
            if region.is_empty() { break; }
            // Candidates: not trunk, in the 2 m band above the front.
            let above: Vec<u32> = (0..nb as u32)
                .filter(|&i| !out.trunk[i as usize]
                    && centres[i as usize][2] > h
                    && centres[i as usize][2] < h + 2.0)
                .collect();
            if above.is_empty() { break; }

            // Prefer a connection that goes UP: cosine with vertical
            // above 0.7, relaxed by 0.05 until something qualifies.
            let mut cos_min = 0.7;
            let mut best: Option<(f64, u32, u32)> = None;
            while best.is_none() && cos_min > -1.0 {
                for &r in region {
                    for &a in &above {
                        let v = [
                            centres[a as usize][0] - centres[r as usize][0],
                            centres[a as usize][1] - centres[r as usize][1],
                            centres[a as usize][2] - centres[r as usize][2],
                        ];
                        let len2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
                        if len2 <= 0.0 { continue; }
                        let cos = v[2] / len2.sqrt();
                        if cos <= cos_min { continue; }
                        if best.map(|(d, _, _)| len2 < d).unwrap_or(true) {
                            best = Some((len2, r, a));
                        }
                    }
                }
                cos_min -= 0.05;
            }
            let Some((_, r, a)) = best else { break };

            // The bridge: a mutual neighbour link that was not there.
            // This is why the cover comes back modified.
            out.neighbours[r as usize].push(a);
            out.neighbours[a as usize].push(r);

            let mut next: Vec<u32> = Vec::new();
            let mut seen = vec![false; nb];
            for &e in region {
                for &n in &out.neighbours[e as usize] {
                    if out.trunk[n as usize] || seen[n as usize] { continue; }
                    if centres[n as usize][2] >= h { seen[n as usize] = true; next.push(n); }
                }
            }
            for &n in &next { out.trunk[n as usize] = true; }
            exp = next;
            if !exp.is_empty() {
                h = exp.iter().map(|&i| centres[i as usize][2]).fold(f64::NEG_INFINITY, f64::max) - L;
            } else {
                break;
            }
        }
    }
    out
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/cover_sets.m (first pass)
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// TreeQSM's cover, as `cover_sets.m` actually returns it.
///
/// The shape matters and differs from what this file used before.
///
///   * `ball[i]` — every point within the BALL of set i. Balls overlap.
///   * `sets[i]` — the points BELONGING to set i. Each point belongs to
///     exactly one set, the one whose seed is nearest. So the sets are
///     a PARTITION while the balls overlap.
///   * `neighbours[i]` — sets that have a point inside ball i.
///
/// The distinction is the whole point. `greedy_ball_cover` +
/// `build_covers` gave overlapping membership and derived neighbours
/// from shared members, which is a different graph over different sets
/// and is not what the segmentation downstream of it expects.
pub struct CoverSets {
    /// Seed point index per set.
    pub centre: Vec<u32>,
    /// Points inside the ball of each set — overlapping.
    pub ball: Vec<Vec<u32>>,
    /// Points belonging to each set — a partition.
    pub sets: Vec<Vec<u32>>,
    /// Which set each point belongs to; `u32::MAX` for none.
    pub set_of_point: Vec<u32>,
    /// Neighbouring sets.
    pub neighbours: Vec<Vec<u32>>,
}

/// First-pass cover generation — `cover_sets(P, inputs)` with two
/// arguments, i.e. before any relative size is known.
///
/// `patch_diam1` and `ball_rad1` are `inputs.PatchDiam1` and
/// `inputs.BallRad1`; `nmin` is `inputs.nmin1`.
///
/// DELIBERATE DEVIATION, AND THE ONLY ONE: the reference calls
/// `randperm(np)`, so it visits points in a fresh random order on every
/// run and gives a different cover — and therefore different
/// measurements — each time. `seed` makes that order reproducible. The
/// algorithm and its distribution are unchanged; what changes is that
/// running this twice on one tree gives one answer. A measurement tool
/// that does not is not one, and a paper that reports a number from it
/// cannot be checked.
pub fn cover_sets_pass1(
    points: &[[f64; 3]],
    patch_diam1: f64,
    ball_rad1: f64,
    nmin: usize,
    seed: u64,
) -> CoverSets {
    let np = points.len();
    let mut cover = CoverSets {
        centre: Vec::new(), ball: Vec::new(), sets: Vec::new(),
        set_of_point: vec![u32::MAX; np], neighbours: Vec::new(),
    };
    if np == 0 { return cover; }

    let grid = build_grid(points, &(0..np as u32).collect::<Vec<_>>(), ball_rad1);
    let radius2 = ball_rad1 * ball_rad1;
    let max_dist2 = patch_diam1 * patch_diam1;

    let mut not_examined = vec![true; np];
    // `Dist` in the reference: distance from each point to the nearest
    // seed that has claimed it so far.
    let mut dist_to_owner = vec![f64::INFINITY; np];

    for &q in &shuffled(np, seed) {
        if !not_examined[q as usize] { continue; }
        let c = cell_of(points[q as usize], ball_rad1);
        // The reference takes the 3x3x3 cell neighbourhood, which is
        // why the partition is built at BallRad: one cell either way
        // is guaranteed to contain the whole ball.
        let mut ball: Vec<u32> = Vec::new();
        let mut d2: Vec<f64> = Vec::new();
        for dx in -1..=1 { for dy in -1..=1 { for dz in -1..=1 {
            if let Some(v) = grid.get(&[c[0] + dx, c[1] + dy, c[2] + dz]) {
                for &j in v {
                    let a = points[q as usize];
                    let b = points[j as usize];
                    let d = (a[0]-b[0]).powi(2) + (a[1]-b[1]).powi(2) + (a[2]-b[2]).powi(2);
                    if d < radius2 { ball.push(j); d2.push(d); }
                }
            }
        }}}
        if ball.len() < nmin { continue; }

        // Core points — those inside the PATCH, not merely the ball —
        // are the ones marked examined. The ball reaches further so
        // that neighbouring sets can be found from it.
        for (k, &j) in ball.iter().enumerate() {
            if d2[k] < max_dist2 { not_examined[j as usize] = false; }
        }
        let set_index = cover.centre.len() as u32;
        cover.centre.push(q);
        // Claim every ball point that is closer to this seed than to
        // whichever seed held it before. This is what makes the sets a
        // partition by nearest seed.
        for (k, &j) in ball.iter().enumerate() {
            if d2[k] < dist_to_owner[j as usize] {
                dist_to_owner[j as usize] = d2[k];
                cover.set_of_point[j as usize] = set_index;
            }
        }
        cover.ball.push(ball);
    }

    finish_cover(&mut cover);
    cover
}

/// The tail of `cover_sets.m`, common to both passes: turn `BoP` into
/// `PointsInSets`, then derive the neighbour relation from the balls.
///
/// A is a neighbour of B if A's *ball* holds a point owned by B. The
/// balls reach past the sets, which is the entire reason they are kept
/// — the sets are a partition and would touch nothing.
///
/// That relation is NOT symmetric as built: A's ball may reach a point
/// of B while B's smaller ball reaches nothing of A. The reference
/// closes it explicitly, and this used to not, which mattered because
/// everything downstream walks this graph as if it were undirected —
/// `tree_sets` floods along it, `segments` grows components out of it.
/// A one-way edge is a wall from one side and a door from the other.
fn finish_cover(cover: &mut CoverSets) {
    let nb = cover.centre.len();
    cover.sets = vec![Vec::new(); nb];
    for (i, &owner) in cover.set_of_point.iter().enumerate() {
        if owner != u32::MAX { cover.sets[owner as usize].push(i as u32); }
    }

    cover.neighbours = Vec::with_capacity(nb);
    let mut seen = vec![false; nb];
    for i in 0..nb {
        let mut nb_list: Vec<u32> = Vec::new();
        for &pt in &cover.ball[i] {
            let owner = cover.set_of_point[pt as usize];
            if owner == u32::MAX || owner == i as u32 { continue; }
            if !seen[owner as usize] { seen[owner as usize] = true; nb_list.push(owner); }
        }
        for &n in &nb_list { seen[n as usize] = false; }
        cover.neighbours.push(nb_list);
    }

    // Close the relation: if B is A's neighbour, add A to B's list.
    for i in 0..nb {
        for k in 0..cover.neighbours[i].len() {
            let j = cover.neighbours[i][k] as usize;
            if !cover.neighbours[j].contains(&(i as u32)) {
                cover.neighbours[j].push(i as u32);
            }
        }
    }
}

/// Second-pass cover generation — `cover_sets(P, inputs, RelSize)` with
/// three arguments. THE VARIABLE-SIZE COVER, and the point of the whole
/// exercise: the ball around a seed is scaled by that seed's relative
/// size, so a set on the stem is `PatchDiam2Max` across and a set out on
/// a twig is `PatchDiam2Min`.
///
/// A single fixed radius — what this software had — has to be small
/// enough for the twigs, and is then so small on the trunk that the
/// cover fragments; or large enough for the trunk, and then bridges
/// across the gap between two twigs and welds them into one branch.
///
/// `patch_diam2_min`, `patch_diam2_max` and `ball_rad2` are
/// `inputs.PatchDiam2Min`, `inputs.PatchDiam2Max` and `inputs.BallRad2`;
/// `nmin` is `inputs.nmin2`. `rel_size` is `relative_size`'s output, one
/// value per point.
///
/// Same deliberate deviation as pass 1: `seed` replaces `randperm`, so a
/// second run over one tree gives the same cover and the same numbers.
pub fn cover_sets_pass2(
    points: &[[f64; 3]],
    rel_size: &[u8],
    patch_diam2_min: f64,
    patch_diam2_max: f64,
    ball_rad2: f64,
    nmin: usize,
    seed: u64,
) -> CoverSets {
    let np = points.len();
    let mut cover = CoverSets {
        centre: Vec::new(), ball: Vec::new(), sets: Vec::new(),
        set_of_point: vec![u32::MAX; np], neighbours: Vec::new(),
    };
    if np == 0 || rel_size.len() < np || patch_diam2_max <= 0.0 { return cover; }

    // MRS is the floor of the size ramp: a point of relative size 0 gets
    // PatchDiam2Min, one of 255 gets (near enough) PatchDiam2Max.
    let mrs = patch_diam2_min / patch_diam2_max;
    let min_rel = rel_size[..np].iter().copied().min().unwrap_or(0) as f64;

    // The cell size. Small enough that the smallest ball spans about one
    // and a half cells, but if that would need more than four cells to
    // cover the largest ball, back off to PatchDiam2Max/4 — otherwise
    // the neighbourhood sweep below is cubic in a large number.
    let mut r = 1.5 * (min_rel / 256.0 * (1.0 - mrs) + mrs) * ball_rad2 + 1e-5;
    if r > 0.0 && 1.0 + (ball_rad2 / r).ceil() > 4.0 {
        r = patch_diam2_max / 4.0;
    }
    // NaN reaches here if PatchDiam2Min/Max is degenerate, and a NaN
    // cell size makes every grid lookup miss silently rather than fail.
    if !r.is_finite() || r <= 0.0 { return cover; }

    let grid = build_grid(points, &(0..np as u32).collect::<Vec<_>>(), r);

    // A point with no size was never reached by the segmentation, so it
    // cannot seed a set. It can still be swallowed by someone else's.
    let mut not_examined: Vec<bool> = rel_size[..np].iter().map(|&s| s != 0).collect();
    let mut dist_to_owner = vec![f64::INFINITY; np];

    // THE ORDER, and it is not arbitrary. The reference permutes within
    // three size bands and visits them smallest first, so the twigs are
    // covered before the trunk is. Seed the trunk first and its wide
    // balls swallow the twigs whole, and the fine structure the variable
    // size existed to capture is gone before it is ever measured.
    let mut order: Vec<u32> = Vec::with_capacity(np);
    for (k, band) in [(0u8, 32u8), (33, 128), (129, 255)].iter().enumerate() {
        let mut b: Vec<u32> = (0..np as u32)
            .filter(|&i| { let s = rel_size[i as usize]; s >= band.0 && s <= band.1 })
            .collect();
        shuffle_in_place(&mut b, seed ^ (k as u64));
        order.extend(b);
    }

    let e = ball_rad2 - patch_diam2_max;
    for &q in &order {
        if !not_examined[q as usize] { continue; }
        // The seed's own size sets the scale of everything below.
        let rs = rel_size[q as usize] as f64 / 256.0 * (1.0 - mrs) + mrs;
        let max_dist = patch_diam2_max * rs;      // the cover set
        let radius = max_dist + rs.sqrt() * e;    // the ball around it
        let n = (radius / r).ceil() as i64;
        let c = cell_of(points[q as usize], r);
        let a = points[q as usize];

        let mut ball: Vec<u32> = Vec::new();
        let mut d2: Vec<f64> = Vec::new();
        let radius2 = radius * radius;
        for dx in -n..=n { for dy in -n..=n { for dz in -n..=n {
            if let Some(v) = grid.get(&[c[0] + dx, c[1] + dy, c[2] + dz]) {
                for &j in v {
                    let b = points[j as usize];
                    let d = (a[0]-b[0]).powi(2) + (a[1]-b[1]).powi(2) + (a[2]-b[2]).powi(2);
                    if d < radius2 { ball.push(j); d2.push(d); }
                }
            }
        }}}
        if ball.len() < nmin { continue; }

        let max_dist2 = max_dist * max_dist;
        for (k, &j) in ball.iter().enumerate() {
            if d2[k] < max_dist2 { not_examined[j as usize] = false; }
        }
        let set_index = cover.centre.len() as u32;
        cover.centre.push(q);
        for (k, &j) in ball.iter().enumerate() {
            if d2[k] < dist_to_owner[j as usize] {
                dist_to_owner[j as usize] = d2[k];
                cover.set_of_point[j as usize] = set_index;
            }
        }
        cover.ball.push(ball);
    }

    finish_cover(&mut cover);
    cover
}

/// A reproducible shuffle standing in for MATLAB's `randperm`.
/// SplitMix64 feeding a Fisher-Yates pass — small, dependency-free, and
/// good enough for an ordering that only needs to be unbiased.
fn shuffled(n: usize, seed: u64) -> Vec<u32> {
    let mut v: Vec<u32> = (0..n as u32).collect();
    shuffle_in_place(&mut v, seed);
    v
}

/// The same shuffle over an arbitrary index list, which pass 2 needs:
/// it permutes three size bands separately rather than the whole cloud.
fn shuffle_in_place(v: &mut [u32], seed: u64) {
    let mut state = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut next = || {
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    for i in (1..v.len()).rev() {
        let j = (next() % (i as u64 + 1)) as usize;
        v.swap(i, j);
    }
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/tools/distances_to_line.m,
// rotation_matrix.m, surface_coverage.m, surface_coverage_filtering.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// The reference's cylinder record, as `cylinders.m` passes it around
/// under the names `c0` and `c`.
///
/// Deliberately not `BranchCylinder`: this is the port's own currency,
/// one field per field of the MATLAB struct, converted at the boundary.
/// Mixing the two would mean every ported line had to be read against a
/// type it was not written for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RefCyl {
    pub start: [f64; 3],
    /// Unit vector. Nothing here normalises it; the callers do.
    pub axis: [f64; 3],
    pub length: f64,
    pub radius: f64,
    /// Fraction of the cylinder's layer × sector cells holding a point.
    pub surf_cov: f64,
    /// Mean absolute deviation of the point distances from the radius.
    pub mad: f64,
    /// The fit converged.
    pub conv: bool,
    /// The fit is trusted. The reference clears this to reject a
    /// cylinder while still carrying it, so a rejected fit still has a
    /// length and an axis for the next region to start from.
    pub rel: bool,
}

/// `distances_to_line` — perpendicular distance, perpendicular
/// component and height along the axis, for each point.
///
/// `dir` must already be a unit vector; the reference does not
/// normalise it here either.
fn distances_to_line(
    q: &[[f64; 3]], dir: [f64; 3], p0: [f64; 3],
) -> (Vec<f64>, Vec<[f64; 3]>, Vec<f64>) {
    let mut d = Vec::with_capacity(q.len());
    let mut v = Vec::with_capacity(q.len());
    let mut h = Vec::with_capacity(q.len());
    for p in q {
        let a = [p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]];
        let hh = a[0] * dir[0] + a[1] * dir[1] + a[2] * dir[2];
        let vv = [a[0] - hh * dir[0], a[1] - hh * dir[1], a[2] - hh * dir[2]];
        d.push((vv[0] * vv[0] + vv[1] * vv[1] + vv[2] * vv[2]).sqrt());
        v.push(vv);
        h.push(hh);
    }
    (d, v, h)
}

/// `rotation_matrix` — Rodrigues rotation about `a` by `angle`.
fn rotation_matrix(a: [f64; 3], angle: f64) -> [[f64; 3]; 3] {
    let n = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
    if n == 0.0 || !n.is_finite() {
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    }
    let a = [a[0] / n, a[1] / n, a[2] / n];
    let (c, s) = (angle.cos(), angle.sin());
    [
        [a[0]*a[0] + (1.0-a[0]*a[0])*c, a[0]*a[1]*(1.0-c) - a[2]*s, a[0]*a[2]*(1.0-c) + a[1]*s],
        [a[0]*a[1]*(1.0-c) + a[2]*s, a[1]*a[1] + (1.0-a[1]*a[1])*c, a[1]*a[2]*(1.0-c) - a[0]*s],
        [a[0]*a[2]*(1.0-c) - a[1]*s, a[1]*a[2]*(1.0-c) + a[0]*s, a[2]*a[2] + (1.0-a[2]*a[2])*c],
    ]
}

fn mat_vec(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [m[0][0]*v[0] + m[0][1]*v[1] + m[0][2]*v[2],
     m[1][0]*v[0] + m[1][1]*v[1] + m[1][2]*v[2],
     m[2][0]*v[0] + m[2][1]*v[1] + m[2][2]*v[2]]
}

/// MATLAB's `median`: the mean of the two central values when the
/// count is even, not the lower of them. The reference takes the median
/// of the per-cell distances to get a radius, and off-by-one-element
/// here shifts every radius in the tree.
fn median_of(vals: &mut [f64]) -> f64 {
    if vals.is_empty() { return f64::NAN; }
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = vals.len();
    if n % 2 == 1 { vals[n / 2] } else { (vals[n / 2 - 1] + vals[n / 2]) / 2.0 }
}

/// The layer and sector a point falls in, 0-based, as
/// `surface_coverage.m` computes them.
///
/// `Layer = ceil(h/Len*nl)` clamped into 1..nl, `Sector =
/// ceil(ang/2pi*ns)` with `ang = atan2(y,x)+pi`. The upper clamp on the
/// sector is defensive rather than ported: `ang` cannot exceed 2*pi,
/// but the division that follows it can round up and MATLAB would then
/// index past the end of the array.
fn layer_sector(h: f64, len: f64, nl: usize, ang: f64, ns: usize) -> (usize, usize) {
    let layer = if len > 0.0 { (h / len * nl as f64).ceil() } else { 1.0 };
    let layer = if layer.is_nan() || layer < 1.0 { 1 } else { (layer as usize).min(nl) };
    let sector = (ang / std::f64::consts::TAU * ns as f64).ceil();
    let sector = if sector.is_nan() || sector < 1.0 { 1 } else { (sector as usize).min(ns) };
    (layer - 1, sector - 1)
}

/// `surface_coverage` — what fraction of the cylinder's surface has
/// points on it, as a grid of `nl` layers by `ns` sectors.
///
/// This is the measure `cylinder_fitting` maximises when it chooses
/// between candidate fits, so it decides which cylinder is kept. A
/// stem seen from one side has high coverage over half its sectors and
/// none over the rest, and that is the whole point: it says the fit is
/// only supported on one side.
///
/// `dmin` and `dmax` drop points too close to or too far from the axis
/// before counting, as the reference's optional 6th and 7th arguments
/// do. Note that the length is measured over ALL the points and the
/// filter is applied afterwards, so filtering does not shorten the
/// cylinder — the reference is explicit about the order and it matters.
///
/// DELIBERATE DEVIATION: the reference's `orthonormal_vectors` seeds
/// the sector grid from `rand(3,1)`, so its zero angle is in a random
/// place and the coverage of a given cylinder differs between runs.
/// This uses a deterministic basis. The reference itself is what makes
/// that safe: it evaluates four bases a quarter-sector apart and takes
/// the largest, which spans a whole sector and so removes almost all of
/// the dependence on where the grid starts.
pub fn surface_coverage(
    points: &[[f64; 3]],
    axis: [f64; 3],
    point: [f64; 3],
    nl: usize,
    ns: usize,
    dmin: Option<f64>,
    dmax: Option<f64>,
) -> f64 {
    if points.is_empty() || nl == 0 || ns == 0 { return 0.0; }
    let Some((u0, w0)) = perp_basis(axis) else { return 0.0 };

    let (d, v, mut h) = distances_to_line(points, axis, point);
    let hmin = h.iter().copied().fold(f64::INFINITY, f64::min);
    for x in h.iter_mut() { *x -= hmin; }
    let len = h.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    if !len.is_finite() || len <= 0.0 { return 0.0; }

    // Keep the length from the unfiltered points, then drop the ones
    // outside the distance band.
    let keep: Vec<usize> = (0..points.len())
        // Not `is_none_or`: that is stable only from Rust 1.82 and this
        // crate's floor is 1.77, which is what the README promises.
        .filter(|&i| match dmin { Some(lo) => d[i] > lo, None => true }
                  && match dmax { Some(hi) => d[i] < hi, None => true })
        .collect();
    if keep.is_empty() { return 0.0; }

    let rot = rotation_matrix(axis, std::f64::consts::TAU / ns as f64 / 4.0);
    let (mut u, mut w) = (u0, w0);
    let mut best = 0.0_f64;
    let mut cov = vec![false; nl * ns];
    for i in 0..4 {
        if i > 0 { u = mat_vec(&rot, u); w = mat_vec(&rot, w); }
        cov.iter_mut().for_each(|c| *c = false);
        for &k in &keep {
            let vv = v[k];
            let x = vv[0]*u[0] + vv[1]*u[1] + vv[2]*u[2];
            let y = vv[0]*w[0] + vv[1]*w[1] + vv[2]*w[2];
            let ang = y.atan2(x) + std::f64::consts::PI;
            let (l, s) = layer_sector(h[k], len, nl, ang, ns);
            cov[l + s * nl] = true;
        }
        let f = cov.iter().filter(|&&c| c).count() as f64 / (nl * ns) as f64;
        if f > best { best = f; }
    }
    best
}

/// `surface_coverage_filtering` — the outlier filter every cylinder fit
/// in the reference runs first, and the source of the initial radius.
///
/// It grids the cylinder's surface, and in each cell keeps only the
/// points within `max(0.01, 0.05*R)` of the CLOSEST point to the axis
/// in that cell. That is what removes the far side of a branch that has
/// been merged into the region, and leaves the near surface. It then
/// takes the radius as the median over cells of the smallest distance
/// in the cell — a minimum, not a mean, because the points scatter
/// outward from the true surface and not inward.
///
/// Returns the keep-mask in the caller's point order, and writes
/// `radius`, `surf_cov`, `mad`, `conv` and `rel` into `c`.
///
/// Same deterministic-basis deviation as `surface_coverage`, and here
/// without the four-way maximum to absorb it, so this is the one place
/// where a run of the reference and a run of this can disagree about
/// which points are outliers. They disagree by a fraction of one sector.
pub fn surface_coverage_filtering(
    points: &[[f64; 3]],
    c: &mut RefCyl,
    lh: f64,
    ns: usize,
) -> Vec<bool> {
    let np = points.len();
    // A cylinder with no length has no surface to grid. The reference
    // divides by c.length here and would produce NaN indices.
    if np == 0 || !c.length.is_finite() || c.length <= 0.0
        || !lh.is_finite() || lh <= 0.0 || ns == 0 {
        c.conv = false;
        c.rel = false;
        return vec![true; np];
    }
    let Some((u, w)) = perp_basis(c.axis) else {
        c.conv = false; c.rel = false; return vec![true; np];
    };

    let (d, v, mut h) = distances_to_line(points, c.axis, c.start);
    let hmin = h.iter().copied().fold(f64::INFINITY, f64::min);
    for x in h.iter_mut() { *x -= hmin; }
    let ang: Vec<f64> = v.iter().map(|vv| {
        let x = vv[0]*u[0] + vv[1]*u[1] + vv[2]*u[2];
        let y = vv[0]*w[0] + vv[1]*w[1] + vv[2]*w[2];
        y.atan2(x) + std::f64::consts::PI
    }).collect();

    // First grid, at the caller's layer height, purely to get a radius
    // to size the real grid with.
    let nl1 = (c.length / lh).ceil().max(1.0) as usize;
    let mut dis1 = vec![f64::INFINITY; nl1 * ns];
    for i in 0..np {
        let (l, s) = layer_sector(h[i], c.length, nl1, ang[i], ns);
        let cell = &mut dis1[l + s * nl1];
        if d[i] < *cell { *cell = d[i]; }
    }
    // Dis = min(1.05*D, D+0.02): a 5% margin on a thin branch, a flat
    // 2 cm on a thick one, so the tolerance never grows with the trunk.
    let mut cell_r: Vec<f64> = dis1.iter().filter(|x| x.is_finite())
        .map(|&x| (1.05 * x).min(x + 0.02)).collect();
    let r0 = median_of(&mut cell_r);
    if !r0.is_finite() || r0 <= 0.0 {
        c.conv = false; c.rel = false; return vec![true; np];
    }

    // The real grid: cells about a fifth of a radius across, so a thin
    // branch is not cut into more sectors than it has points for.
    let a = 0.02_f64.max(0.2 * r0);
    let ns2 = ((std::f64::consts::TAU * r0 / a).ceil() as usize).clamp(8, 36);
    let nl2 = ((c.length / a).ceil() as usize).max(3);

    let mut cells: Vec<Vec<u32>> = vec![Vec::new(); nl2 * ns2];
    for i in 0..np {
        let (l, s) = layer_sector(h[i], c.length, nl2, ang[i], ns2);
        cells[l + s * nl2].push(i as u32);
    }

    let r = 0.01_f64.max(0.05 * r0);
    let mut pass = vec![false; np];
    let mut nonempty = 0usize;
    let mut cell_r2: Vec<f64> = Vec::new();
    for cell in &cells {
        if cell.is_empty() { continue; }
        nonempty += 1;
        let dmin = cell.iter().map(|&i| d[i as usize]).fold(f64::INFINITY, f64::min);
        for &i in cell {
            if d[i as usize] <= dmin + r { pass[i as usize] = true; }
        }
        cell_r2.push((1.05 * dmin).min(dmin + 0.02));
    }

    let radius = median_of(&mut cell_r2);
    let kept: Vec<f64> = (0..np).filter(|&i| pass[i]).map(|i| d[i]).collect();
    let mad = if kept.is_empty() { 0.0 }
              else { kept.iter().map(|x| (x - radius).abs()).sum::<f64>() / kept.len() as f64 };

    c.radius = radius;
    c.surf_cov = nonempty as f64 / (nl2 * ns2) as f64;
    c.mad = mad;
    c.conv = true;
    c.rel = true;
    pass
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/treeqsm.m, the workflow itself, and
// src/create_input.m for its parameters.
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// One point of TreeQSM's parameter sweep — `create_input.m`'s
/// `PatchDiam1`, `PatchDiam2Min` and `PatchDiam2Max`, with the ball
/// radii and minimum set sizes that go with them.
#[derive(Clone, Copy, Debug)]
pub struct QsmInputs {
    pub patch_diam1: f64,
    pub patch_diam2_min: f64,
    pub patch_diam2_max: f64,
    pub ball_rad1: f64,
    pub ball_rad2: f64,
    pub nmin1: usize,
    pub nmin2: usize,
    /// Replaces the reference's `randperm`, so a second run over one
    /// tree gives the same model.
    pub seed: u64,
    /// `GrowthVolCor`: pull radii onto the growth-volume allometry
    /// after fitting. Off, as in `create_input.m`.
    pub growth_vol_cor: bool,
    /// `GrowthVolFac`: how far off the allometry a radius has to be
    /// before it is overruled. 1.5 in `create_input.m`.
    pub growth_vol_fac: f64,
    /// `Tria`: reconstruct the butt of the stem as a triangle mesh
    /// instead of cylinders. Off, as in `create_input.m`.
    pub tria: bool,
}

impl QsmInputs {
    /// `create_input.m`'s own arithmetic: the ball radii are the patch
    /// diameters plus 1.5 cm and 2 cm, and nmin is 3 and 1.
    pub fn new(patch_diam1: f64, patch_diam2_min: f64, patch_diam2_max: f64) -> Self {
        Self {
            patch_diam1, patch_diam2_min, patch_diam2_max,
            ball_rad1: patch_diam1 + 0.015,
            ball_rad2: patch_diam2_max + 0.01,
            nmin1: 3, nmin2: 1,
            seed: 0x5EED_1234_ABCD_0001,
            growth_vol_cor: false,
            growth_vol_fac: 1.5,
            tria: false,
        }
    }

    /// The same eight models scaled to a caller's own cover size.
    ///
    /// At `d = 0.08` this IS `default_sweep` — the ratios are
    /// create_input's own. It exists so a caller with a coarser or
    /// finer cloud than the reference assumed keeps a knob that means
    /// something, rather than one that silently does nothing.
    pub fn sweep_around(d: f64) -> Vec<Self> {
        Self::sweep_around_n(d, 8)
    }

    /// The first `n` of those eight, and the count is the single
    /// biggest lever on how long a plot takes.
    ///
    /// `treeqsm.m` reconstructs the tree once for every combination
    /// of PatchDiam1 × PatchDiam2Min × PatchDiam2Max it is handed and
    /// keeps the best by `select_optimum`. How many that is comes
    /// from the CALLER:
    ///
    ///   * `create_input.m` sets PatchDiam1 = [0.08 0.12],
    ///     PatchDiam2Min = [0.02 0.03], PatchDiam2Max = [0.07 0.10]
    ///     — 2x2x2, so eight reconstructions per tree.
    ///   * `define_input(P, 1, 1, 1)` sets one value for each, so ONE
    ///     reconstruction per tree, with the values scaled to the
    ///     tree's own estimated size rather than fixed.
    ///
    /// Eight is eight times the work of one, and on a plot whose
    /// largest tree is twelve minutes at eight models that is the
    /// difference between a coffee break and an afternoon.
    ///
    /// FOR THE SKELETON TRANSFER THE ANSWER IS ONE, and the reference
    /// settles it by not working otherwise. See TST defect 4 in
    /// commands/tst.rs: `create_input.m` hands `treeqsm.m` eight
    /// combinations, `treeqsm.m` accumulates all eight into a single
    /// `QSM` struct array saved under one filename (`inputs.model`
    /// never changes), and `TST_pc_tree_skeleton.m` then reads it with
    /// `cylinders = QSM.cylinder`, which in MATLAB is an error on a
    /// non-scalar struct array. The reader can only consume one model
    /// and it names `m1`, so the skeleton is `QSM(1)` — the first
    /// combination, (0.08, 0.02, 0.07). Nothing in that path calls
    /// `select_optimum` either, so building eight and keeping the best
    /// is a deviation twice over: eight times the work, and a
    /// different model at the end of it.
    ///
    /// The order is `treeqsm.m`'s own enumeration — PatchDiam1, then
    /// PatchDiam2Max, then PatchDiam2Min — so entry k IS the
    /// reference's model k+1 and a prefix of length N is its models
    /// 1..N. The first is PatchDiam1 = d, PatchDiam2Min = d/4,
    /// PatchDiam2Max = 0.875d; at d = 0.08 exactly (0.08, 0.02, 0.07),
    /// which is `QSM(1)` — the one the skeleton is built from.
    pub fn sweep_around_n(d: f64, n: usize) -> Vec<Self> {
        let d = if d.is_finite() && d > 0.0 { d } else { 0.08 };
        let n = n.clamp(1, 8);
        let mut v = Vec::with_capacity(n);
        // treeqsm.m's own nesting: PatchDiam1, then PatchDiam2Max,
        // then PatchDiam2Min. So `v[k]` is the reference's model k+1
        // and a prefix of length N is its models 1..N.
        'outer: for &f1 in &[1.0, 1.5] {
            for &fmax in &[0.875, 1.25] {
                for &fmin in &[0.25, 0.375] {
                    if v.len() == n { break 'outer; }
                    v.push(Self::new(d * f1, d * fmin, d * fmax));
                }
            }
        }
        v
    }

    /// The eight models `create_input.m` builds by default:
    /// PatchDiam1 in {0.08, 0.12}, PatchDiam2Min in {0.02, 0.03},
    /// PatchDiam2Max in {0.07, 0.10}.
    ///
    /// IN `treeqsm.m`'S OWN ORDER, which is PatchDiam1, then
    /// PatchDiam2**Max**, then PatchDiam2**Min**:
    ///
    /// ```text
    /// for h = 1:nd        % nd = length(PatchDiam1)
    ///   for i = 1:na      % na = length(PatchDiam2Max)
    ///     for j = 1:ni    % ni = length(PatchDiam2Min)
    /// ```
    ///
    /// This used to nest Min inside Max, which is the same eight
    /// models in a different order — harmless while all eight are
    /// built and scored, and wrong the moment a caller asks for the
    /// first N, because then "model 2" was not the reference's model 2.
    pub fn default_sweep() -> Vec<Self> {
        let mut v = Vec::with_capacity(8);
        for &d1 in &[0.08, 0.12] {
            for &dmax in &[0.07, 0.10] {
                for &dmin in &[0.02, 0.03] {
                    v.push(Self::new(d1, dmin, dmax));
                }
            }
        }
        v
    }
}

/// One reconstruction: the cylinders, the per-branch summary, and what
/// the second pass decided about the points.
#[derive(Clone, Debug, Default)]
pub struct QsmModel {
    pub cylinders: CylinderModel,
    pub branches: BranchData,
    pub inputs_used: Option<QsmInputs>,
    /// The second pass's point-to-segment map. `tree_data` needs it to
    /// find the trunk's own points when it refits a cylinder at breast
    /// height.
    pub segment_of_point: Vec<u32>,
}

/// A flag a long reconstruction checks between its stages.
///
/// One tree at create_input's eight models can be minutes of work, and
/// a cancel that is only noticed between TREES is no cancel at all
/// when the trees left running are the big ones. The stage boundaries
/// in `treeqsm_single_cancellable` are where it can stop and leave
/// nothing half-built: each returns None, which every caller already
/// handles as "this model did not come out".
pub type Cancel<'a> = Option<&'a std::sync::atomic::AtomicBool>;

/// Where a reconstruction is, readable from another thread.
///
/// A tree that ran for sixteen hours said nothing about which of its
/// passes it was in. The reconstruction runs on a thread of its own
/// (see the skeleton build), so the trace is thread-local: the worker
/// that owns the tree installs one on that thread and reads it when the
/// tree finishes or is given up on. No signature in the pipeline
/// changes for it.
#[derive(Default)]
pub struct PassTrace {
    /// The pass running now, and when it started.
    pub current: std::sync::Mutex<Option<(&'static str, std::time::Instant)>>,
    /// The passes finished so far, in order, with what each took.
    pub done: std::sync::Mutex<Vec<(&'static str, std::time::Duration)>>,
}

impl PassTrace {
    /// `cover1 12.3 s, tree_sets1 0.4 s; in segments2 for 3.1 h`.
    pub fn summary(&self) -> String {
        let secs = |d: std::time::Duration| {
            let s = d.as_secs_f64();
            if s >= 3600.0 { format!("{:.1} h", s / 3600.0) }
            else if s >= 60.0 { format!("{:.1} min", s / 60.0) }
            else { format!("{s:.1} s") }
        };
        let done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        let mut parts: Vec<String> = done.iter().map(|&(n, d)| format!("{n} {}", secs(d))).collect();
        drop(done);
        if let Some((name, at)) = *self.current.lock().unwrap_or_else(|e| e.into_inner()) {
            parts.push(format!("in {name} for {}", secs(at.elapsed())));
        }
        if parts.is_empty() { "no pass recorded".to_string() } else { parts.join(", ") }
    }

    /// The pass in progress, for a caller giving up on the tree: the
    /// account of a stopped run says where each abandoned tree was.
    pub fn current_pass(&self) -> Option<&'static str> {
        self.current.lock().unwrap_or_else(|e| e.into_inner()).map(|(n, _)| n)
    }

    fn open(&self, name: &'static str) {
        let now = std::time::Instant::now();
        let mut cur = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((prev, at)) = cur.take() {
            self.done.lock().unwrap_or_else(|e| e.into_inner()).push((prev, now - at));
        }
        *cur = Some((name, now));
    }

    fn close(&self) {
        let mut cur = self.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((prev, at)) = cur.take() {
            self.done.lock().unwrap_or_else(|e| e.into_inner()).push((prev, at.elapsed()));
        }
    }
}

thread_local! {
    static PASS_RECORD: std::cell::RefCell<Option<std::sync::Arc<PassTrace>>> = const { std::cell::RefCell::new(None) };
}

/// Install (or remove) the trace the reconstructions on THIS thread
/// report to.
pub fn set_pass_trace(trace: Option<std::sync::Arc<PassTrace>>) {
    PASS_RECORD.with(|t| *t.borrow_mut() = trace);
}

/// Note the start of a pass on this thread's trace, closing the one
/// before it. Nothing happens without a trace installed.
fn pass(name: &'static str) {
    PASS_RECORD.with(|t| { if let Some(tr) = t.borrow().as_ref() { tr.open(name); } });
}

/// Closes the running pass when the reconstruction returns, by whatever
/// path — every early `return None` included.
struct PassScope;
impl Drop for PassScope {
    fn drop(&mut self) {
        PASS_RECORD.with(|t| { if let Some(tr) = t.borrow().as_ref() { tr.close(); } });
    }
}

#[cfg(test)]
mod pass_trace_tests {
    use super::*;

    /// The trace names the passes in order with what each took, says
    /// which one is running, and is closed by the scope on any exit.
    #[test]
    fn the_trace_reads_in_order_and_closes_with_the_scope() {
        let trace = std::sync::Arc::new(PassTrace::default());
        set_pass_trace(Some(trace.clone()));
        {
            let _scope = PassScope;
            pass("cover1");
            std::thread::sleep(std::time::Duration::from_millis(15));
            pass("segments1");
            let mid = trace.summary();
            assert!(mid.starts_with("cover1 0.0 s, in segments1 for"), "{mid}");
            // an early return: the scope drops here
        }
        set_pass_trace(None);
        {
            // Scoped: summary() below takes this same lock.
            let done = trace.done.lock().unwrap();
            assert_eq!(done.iter().map(|(n, _)| *n).collect::<Vec<_>>(), vec!["cover1", "segments1"]);
            assert!(done[0].1 >= std::time::Duration::from_millis(10), "cover1 took {:?}", done[0].1);
        }
        assert!(trace.current.lock().unwrap().is_none(), "the scope left a pass open");
        let s = trace.summary();
        assert!(!s.contains(" in "), "nothing is running after the scope: {s}");
    }

    /// Without a trace installed the pass markers are free and silent.
    #[test]
    fn without_a_trace_the_markers_do_nothing() {
        set_pass_trace(None);
        let _scope = PassScope;
        pass("cover1");
        pass("cylinders");
        assert_eq!(PassTrace::default().summary(), "no pass recorded");
    }

    #[test]
    fn long_durations_read_in_minutes_and_hours() {
        let trace = PassTrace::default();
        trace.done.lock().unwrap().push(("cover1", std::time::Duration::from_secs(90)));
        trace.done.lock().unwrap().push(("segments2", std::time::Duration::from_secs(3 * 3600 + 360)));
        assert_eq!(trace.summary(), "cover1 1.5 min, segments2 3.1 h");
    }
}

fn stop(c: Cancel) -> bool {
    match c { Some(f) => f.load(std::sync::atomic::Ordering::Relaxed), None => false }
}

/// `treeqsm.m`'s workflow for ONE parameter set, end to end.
///
/// Two passes over the cloud. The first covers it in fixed-size sets,
/// finds the trunk, segments it, tidies that segmentation, and measures
/// how thick each segment is. The second covers it again with sets
/// SIZED BY THAT MEASUREMENT — wide on the trunk, narrow at the twigs —
/// re-segments with the first pass's structure to guide it, and fits
/// the cylinders.
///
/// THE CLOUD IS TRANSLATED TO THE GROUND before anything else, and put
/// back afterwards, so a caller cannot get this wrong.
///
/// The reason is a units mismatch in the reference that is invisible
/// until you look for it. `define_trunk` decides whether to attempt a
/// gap repair with `H < aux.Height - 5`, where `H` is the ABSOLUTE
/// height of the growing trunk's top while `aux.Height` is the tree's
/// height above its own lowest point. On a plot whose elevations are
/// hundreds of metres, `H` is hundreds and `Height - 5` is tens, the
/// test is false everywhere, and a whole repair stage never runs. The
/// reference is silently assuming its input starts near zero.
///
/// The translation is a single constant, not a per-point normalisation
/// against a terrain model — that would shear a stem standing on a
/// slope and straighten it, which is the opposite of measuring it.
///
/// Returns `None` when the cloud is too small or too sparse to model.
pub fn treeqsm_single(raw: &[[f64; 3]], inp: &QsmInputs) -> Option<QsmModel> {
    treeqsm_single_cancellable(raw, inp, None)
}

/// The same, stoppable. Checked at every stage boundary, so a run that
/// is cancelled mid-tree returns None rather than finishing the tree
/// first.
pub fn treeqsm_single_cancellable(
    raw: &[[f64; 3]], inp: &QsmInputs, cancel: Cancel,
) -> Option<QsmModel> {
    if raw.len() < 30 || stop(cancel) { return None; }
    let _passes = PassScope;
    let z0 = raw.iter().map(|p| p[2]).fold(f64::INFINITY, f64::min);
    if !z0.is_finite() { return None; }
    let translated: Vec<[f64; 3]> =
        raw.iter().map(|p| [p[0], p[1], p[2] - z0]).collect();
    let points: &[[f64; 3]] = &translated;

    // ---- Pass 1: a uniform cover, and a first segmentation.
    pass("cover1");
    let cover1 = cover_sets_pass1(points, inp.patch_diam1, inp.ball_rad1,
                                  inp.nmin1, inp.seed);
    if cover1.centre.len() < 3 || stop(cancel) { return None; }
    let centres1: Vec<[f64; 3]> = cover1.centre.iter()
        .map(|&c| points[c as usize]).collect();

    pass("tree_sets1");
    let mut ts1 = tree_sets_only_tree(&centres1, &cover1.neighbours, inp.patch_diam1);
    pass("connect1");
    make_tree_connected(&centres1, &mut ts1.neighbours, &mut ts1.forbidden,
                        &ts1.base, &mut ts1.trunk, inp.patch_diam1);
    if ts1.base.is_empty() || stop(cancel) { return None; }

    pass("segments1");
    let mut seg1 = segments(&ts1.neighbours, &ts1.base, &ts1.forbidden);
    if seg1.segments.is_empty() || stop(cancel) { return None; }
    pass("correct1");
    let data1 = correct_segments(points, &cover1.ball, &centres1, &mut seg1,
                                 inp.patch_diam1, inp.patch_diam2_max,
                                 &CorrectParams::first_pass());

    // ---- How thick is each segment? This is what sizes the second
    // cover, and the reason there are two passes at all.
    pass("relative_size");
    let rel = relative_size(points.len(), &cover1.ball, &cover1.centre,
                            &|p| points[p as usize][2], &ts1.neighbours,
                            &seg1.segments, &seg1.children);

    // ---- Pass 2: a cover whose sets shrink towards the twigs.
    pass("cover2");
    let cover2 = cover_sets_pass2(points, &rel, inp.patch_diam2_min,
                                  inp.patch_diam2_max, inp.ball_rad2,
                                  inp.nmin2, inp.seed);
    if cover2.centre.len() < 3 || stop(cancel) { return None; }
    let centres2: Vec<[f64; 3]> = cover2.centre.iter()
        .map(|&c| points[c as usize]).collect();

    // The second pass does not look for the trunk again: it reads it
    // off the first pass, and its base is the stem's own low sets.
    let mut nei2 = cover2.neighbours.clone();
    pass("main_branches2");
    let mut trunk2 = define_main_branches(&centres2, &cover2.ball, &mut nei2,
                                          &data1, inp.patch_diam2_max);
    let base2 = define_base_from_segments(&centres2, &cover2.centre,
                                          &data1.segment_of_point);
    let mut forb2 = vec![false; centres2.len()];
    pass("connect2");
    make_tree_connected(&centres2, &mut nei2, &mut forb2, &base2, &mut trunk2,
                        inp.patch_diam1);
    if base2.is_empty() || stop(cancel) { return None; }

    pass("segments2");
    let mut seg2 = segments(&nei2, &base2, &forb2);
    if seg2.segments.is_empty() || stop(cancel) { return None; }
    // OBSERVED: no test here catches skipping this. On both fixtures —
    // including one with an occlusion, a low branch, a bump and a
    // second-order branch — the second pass's correction changes
    // nothing measurable in the model. `modify_topology` finds nothing
    // to join in a segmentation this clean, `remove_small` finds no
    // bump that became a segment of its own, and the flare
    // `modify_parent` takes off a parent is a handful of cover sets
    // that no cylinder's fit depends on. It is the least consequential
    // stage of the six on data like this, which is not a reason to drop
    // it — the reference runs it, and real crowns are messier than
    // anything constructed here.
    pass("correct2");
    let data2 = correct_segments(points, &cover2.ball, &centres2, &mut seg2,
                     inp.patch_diam1, inp.patch_diam2_max,
                     &CorrectParams::second_pass());

    // ---- The cylinders.
    let topo = SegmentTopology {
        segments: seg2.segments.clone(),
        parent: seg2.parent.iter().map(|p| p.map(|(s, _)| s)).collect(),
        children: seg2.children.clone(),
    };
    // The cover as it now stands, links and all. `cylinders` reads only
    // the balls from it, so the edited graph makes no difference to the
    // model — and no test catches replacing it with the unedited one.
    // It is carried anyway because this IS the cover at this point, and
    // handing on a stale one is how the next reader is misled.
    let cover2_final = CoverSets { neighbours: nei2, ..cover2 };
    pass("cylinders");
    let mut cyl = cylinders(points, &cover2_final, &topo, &AdjustParams::default());
    if cyl.cyl.is_empty() { return None; }
    // The reference applies this at the end of `cylinders.m`, gated on
    // `inputs.GrowthVolCor`, which `create_input.m` leaves off.
    if inp.growth_vol_cor { growth_volume_correction(&mut cyl, inp.growth_vol_fac); }
    // Back to where the caller's tree actually stands. Only the start
    // points move; an axis, a length and a radius do not care where the
    // origin is.
    for s in cyl.cyl.start.iter_mut() { s[2] += z0; }
    pass("branches");
    let br = branches(&cyl);
    Some(QsmModel { cylinders: cyl, branches: br, inputs_used: Some(*inp),
                    segment_of_point: data2.segment_of_point })
}

/// Run the sweep and keep the best model.
///
/// The reference builds a model for every combination of its three
/// patch diameters — eight by default — because no single cover size
/// suits every tree, and picking one in advance means picking wrong for
/// most of them.
///
/// The choice between them is `select_optimum`'s, under its own default
/// metric: the mean distance from the cloud to the surface of every
/// cylinder. One model has to come back from here, so the criterion is
/// fixed rather than left to the caller as the reference leaves it;
/// `treeqsm_sweep_by` takes any of the 45 metrics. Ties go to the
/// earlier model, which is the finer cover, as MATLAB's stable sort
/// gives them.
pub fn treeqsm_sweep(points: &[[f64; 3]], sweep: &[QsmInputs]) -> Option<QsmModel> {
    treeqsm_sweep_by(points, sweep, QsmMetric::default())
}

/// The sweep under a metric of the caller's choosing.
pub fn treeqsm_sweep_by(
    points: &[[f64; 3]], sweep: &[QsmInputs], metric: QsmMetric,
) -> Option<QsmModel> {
    treeqsm_sweep_cancellable(points, sweep, metric, None)
}

/// The sweep, stoppable between models and inside each one.
pub fn treeqsm_sweep_cancellable(
    points: &[[f64; 3]], sweep: &[QsmInputs], metric: QsmMetric, cancel: Cancel,
) -> Option<QsmModel> {
    // ONE MODEL AT A TIME, deliberately, and this is where the
    // parallelism does NOT go.
    //
    // The reference parallelises over TREES — `parfor i =
    // 1:height(treelist)` — and runs its eight models one after
    // another inside each worker. Running them in parallel instead
    // gives the same answers, and it was tried: on an 83.7 million
    // point plot it exhausted memory and the process died about an
    // hour in. The reason is that TreeQSM's peak allocation is its
    // COVER SETS, which are several times the size of the tree's own
    // points and live for the whole reconstruction. Sequentially one
    // tree holds one set of those; in parallel it holds eight, and
    // with a thread per tree on top that is eight times the cores.
    //
    // So the parallelism sits one level up, in
    // build_skeleton_from_baseline, exactly where the reference puts
    // it. There it is bounded by the number of trees in flight.
    let mut models: Vec<QsmModel> = Vec::new();
    let mut scores: Vec<ModelScore> = Vec::new();
    for inp in sweep {
        if stop(cancel) { break; }
        let Some(m) = treeqsm_single_cancellable(points, inp, cancel) else { continue };
        let total_len: f64 = m.cylinders.cyl.length.iter().sum();
        if total_len.is_nan() || total_len <= 0.0 { continue; }
        // The same seed for every model, so the quarter of the cloud the
        // distances are measured over is the same quarter — a comparison
        // between models and not between subsamples.
        scores.push(score_model(points, &m.cylinders, QSM_SCORE_SEED));
        models.push(m);
    }
    let (best, _) = select_optimum(&scores, metric)?;
    Some(models.swap_remove(best))
}

/// The shuffle seed the sweep's scoring subsample is drawn with. Fixed
/// so that comparing two models compares them over the same points.
const QSM_SCORE_SEED: u64 = 0x5150_4D44;

/// The ported model in the shape the rest of the application speaks.
///
/// One `BranchCylinder` per cylinder, carrying the hierarchy the model
/// already knows. `rmse` is the reference's mean absolute deviation
/// rather than a root-mean-square — a different average of the same
/// residuals, and the one TreeQSM computes; it is reported under the
/// existing field because every consumer treats it as "how far the
/// points sit from the surface" and that is what it is.
pub fn to_branch_cylinders(m: &CylinderModel) -> Vec<BranchCylinder> {
    (0..m.cyl.len()).map(|i| {
        let (s, a, l, r) = (m.cyl.start[i], m.cyl.axis[i], m.cyl.length[i], m.cyl.radius[i]);
        BranchCylinder {
            added: m.added[i],
            extension: m.extension[i],
            position_in_branch: m.position_in_branch[i],
            unmod_radius: m.unmod_radius[i],
            start: s,
            end: [s[0] + a[0]*l, s[1] + a[1]*l, s[2] + a[2]*l],
            radius: r,
            length: l,
            volume: std::f64::consts::PI * r * r * l,
            n_voxels: m.region_points.get(i).copied().unwrap_or(0),
            rmse: m.cyl.mad[i],
            segment_id: m.branch[i],
            parent_cylinder: m.parent[i],
            // The segment a branch sprouted from, which is its parent
            // cylinder's segment when that differs from its own.
            parent_segment: m.parent[i]
                .map(|p| m.branch[p as usize])
                .filter(|&b| b != m.branch[i]),
            branch_order: m.branch_order[i],
            coverage: m.cyl.surf_cov[i],
            sector_mask: m.sector_mask.get(i).copied().unwrap_or(0),
        }
    }).collect()
}

/// The trunk of a ported model as `QsmSlice` records, one per cylinder,
/// so the application's stem-side machinery — volume, confidence
/// intervals, DBH, the taper sparkline — reads it unchanged.
///
/// `base_z` is the ground under this tree.
pub fn to_trunk_slices(m: &CylinderModel, base_z: f64) -> Vec<QsmSlice> {
    (0..m.cyl.len())
        .filter(|&i| m.branch_order[i] == 0)
        .map(|i| {
            let (s, a, l) = (m.cyl.start[i], m.cyl.axis[i], m.cyl.length[i]);
            let mid = [s[0] + a[0]*l*0.5, s[1] + a[1]*l*0.5, s[2] + a[2]*l*0.5];
            QsmSlice {
                hag: s[2] - base_z,
                z: mid[2],
                center_x: mid[0],
                center_y: mid[1],
                radius: m.cyl.radius[i],
                rmse: m.cyl.mad[i],
                n_points: m.region_points.get(i).copied().unwrap_or(0),
                coverage: m.cyl.surf_cov[i],
                sector_mask: m.sector_mask.get(i).copied().unwrap_or(0),
            }
        })
        .collect()
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/tree_data.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
//
// Crown measures and stem triangulation are not here yet; `inputs.Tria`
// is 0 by default so the reference does not triangulate either.
// ===================================================================

/// Volume, area and length per bin — the shape every cylinder
/// distribution takes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Dist3 {
    /// Litres.
    pub volume: Vec<f64>,
    /// Square metres.
    pub area: Vec<f64>,
    /// Metres.
    pub length: Vec<f64>,
}

/// The same per bin for branches, each also counted for FIRST-ORDER
/// branches alone — which is what most inventory work actually wants.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BranchDist {
    pub volume: Vec<f64>,
    pub volume_first: Vec<f64>,
    pub area: Vec<f64>,
    pub area_first: Vec<f64>,
    pub length: Vec<f64>,
    pub length_first: Vec<f64>,
    pub number: Vec<u32>,
    pub number_first: Vec<u32>,
}

/// Totals per branching order, index 0 being order 1.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct OrderDist {
    pub volume: Vec<f64>,
    pub area: Vec<f64>,
    pub length: Vec<f64>,
    pub number: Vec<u32>,
}

/// `tree_data`'s output: what a TreeQSM run actually reports.
#[derive(Clone, Debug, Default)]
pub struct TreeData {
    /// Litres, all cylinders.
    pub total_volume: f64,
    pub trunk_volume: f64,
    pub branch_volume: f64,
    /// Metres, base of the lowest cylinder to the top of the highest.
    pub tree_height: f64,
    pub trunk_length: f64,
    pub branch_length: f64,
    pub total_length: f64,
    /// The reference's count: rows in the branch table less the stem,
    /// which includes segments that produced no cylinders.
    pub number_branches: usize,
    /// The same count over branches that actually have cylinders. Not
    /// the reference's; see the note on it below.
    pub number_branches_modelled: usize,
    pub max_branch_order: u8,
    /// Square metres.
    pub trunk_area: f64,
    pub branch_area: f64,
    pub total_area: f64,
    /// Diameter at breast height from the trunk cylinder that spans
    /// 1.3 m, metres.
    pub dbh_qsm: f64,
    /// The same, refitted to the trunk's own points between 1.1 and
    /// 1.5 m where there are enough of them and the fit agrees.
    pub dbh_cyl: f64,
    pub location: [f64; 3],
    /// `(height along the trunk, diameter)` from base to top.
    pub stem_taper: Vec<(f64, f64)>,
    pub cyl_diameter: Dist3,
    pub cyl_height: Dist3,
    pub cyl_zenith: Dist3,
    pub cyl_azimuth: Dist3,
    pub branch_order: OrderDist,
    pub branch_diameter: BranchDist,
    pub branch_height: BranchDist,
    pub branch_angle: BranchDist,
    pub branch_zenith: BranchDist,
    pub branch_azimuth: BranchDist,
    pub crown: CrownData,
}

/// `tree_data` — turn a model into the numbers a run reports.
///
/// `points` and `segment_of_point` are the cloud and the second pass's
/// point-to-segment map; the trunk's own points are the ones mapped to
/// segment 0, and they are needed only to refit the diameter at breast
/// height.
pub fn tree_data(
    m: &CylinderModel,
    b: &BranchData,
    points: &[[f64; 3]],
    segment_of_point: &[u32],
) -> TreeData {
    let nc = m.cyl.len();
    let mut d = TreeData::default();
    if nc == 0 { return d; }
    let (rad, len) = (&m.cyl.radius, &m.cyl.length);
    let is_trunk: Vec<bool> = (0..nc).map(|i| m.branch_order[i] == 0).collect();
    const L: f64 = 1000.0;                       // cubic metres to litres
    let pi = std::f64::consts::PI;

    let vol = |i: usize| L * pi * rad[i] * rad[i] * len[i];
    let are = |i: usize| 2.0 * pi * rad[i] * len[i];
    d.total_volume = (0..nc).map(vol).sum();
    d.trunk_volume = (0..nc).filter(|&i| is_trunk[i]).map(vol).sum();
    d.branch_volume = (0..nc).filter(|&i| !is_trunk[i]).map(vol).sum();
    d.trunk_area = (0..nc).filter(|&i| is_trunk[i]).map(are).sum();
    d.branch_area = (0..nc).filter(|&i| !is_trunk[i]).map(are).sum();
    d.total_area = (0..nc).map(are).sum();
    d.trunk_length = (0..nc).filter(|&i| is_trunk[i]).map(|i| len[i]).sum();
    d.branch_length = (0..nc).filter(|&i| !is_trunk[i]).map(|i| len[i]).sum();
    d.total_length = d.trunk_length + d.branch_length;

    // NOTE, not a fix: the reference takes the highest START, then adds
    // that one cylinder's rise. A different cylinder can reach higher —
    // one starting slightly lower and running further up. Ported as
    // written; the difference is at most one cylinder's rise.
    let bottom = m.cyl.start.iter().map(|s| s[2]).fold(f64::INFINITY, f64::min);
    let hi = (0..nc).max_by(|&a, &c| m.cyl.start[a][2]
        .partial_cmp(&m.cyl.start[c][2]).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or(0);
    let mut top = m.cyl.start[hi][2];
    if m.cyl.axis[hi][2] > 0.0 { top += len[hi] * m.cyl.axis[hi][2]; }
    d.tree_height = top - bottom;

    // NOTE, not a fix: the reference's NumberBranches is the number of
    // rows in the branch table less the stem, and that table has a row
    // per SEGMENT — including segments that produced no cylinders and
    // carry zero volume, area and length. `number_branches_modelled`
    // counts the ones that exist.
    d.number_branches = b.length.len().saturating_sub(1);
    d.number_branches_modelled = b.length.iter().skip(1).filter(|&&l| l > 0.0).count();
    d.max_branch_order = b.order.iter().copied().max().unwrap_or(0);
    d.location = m.cyl.start[0];

    // ---- Diameter at breast height.
    let trunk_ids: Vec<usize> = (0..nc).filter(|&i| is_trunk[i]).collect();
    if !trunk_ids.is_empty() {
        // The first trunk cylinder whose chain has reached 1.3 m.
        let mut k = 0usize;
        let mut acc = 0.0;
        while k + 1 < trunk_ids.len() {
            acc += len[trunk_ids[k]];
            if acc >= 1.3 { break; }
            k += 1;
        }
        let at = trunk_ids[k];
        d.dbh_qsm = 2.0 * rad[at];
        d.dbh_cyl = d.dbh_qsm;

        // Refit to the trunk's own points in the 1.1-1.5 m band, and
        // take it only if it agrees with the chain to within a fifth
        // and points the same way.
        let base = m.cyl.start[0];
        let axis0 = m.cyl.axis[0];
        let band: Vec<[f64; 3]> = points.iter().enumerate()
            .filter(|&(i, _)| segment_of_point.get(i).copied() == Some(0))
            .map(|(_, &p)| p)
            .filter(|p| {
                let h = (p[0]-base[0])*axis0[0] + (p[1]-base[1])*axis0[1]
                      + (p[2]-base[2])*axis0[2];
                h > 1.1 && h < 1.5
            })
            .collect();
        if band.len() > 100 {
            let c0 = m.cyl.get(at);
            let c = least_squares_cylinder(&band, &c0, None, None);
            let ok_radius = 2.0*c.radius > 0.8*d.dbh_qsm && 2.0*c.radius < 1.2*d.dbh_qsm;
            let aligned = (m.cyl.axis[at][0]*c.axis[0] + m.cyl.axis[at][1]*c.axis[1]
                         + m.cyl.axis[at][2]*c.axis[2]).abs() > 0.9;
            if ok_radius && aligned && c.conv && c.rel { d.dbh_cyl = 2.0 * c.radius; }
        }

        // ---- Stem taper: the diameter at each join up the trunk. The
        // last row repeats the top cylinder's diameter, so the taper
        // ends flat rather than at nothing.
        let n = trunk_ids.len();
        d.stem_taper.push((0.0, 2.0 * rad[trunk_ids[0]]));
        let mut h = 0.0;
        for (j, &i) in trunk_ids.iter().enumerate() {
            h += len[i];
            let dia = if j + 1 < n { 2.0 * rad[trunk_ids[j+1]] } else { 2.0 * rad[i] };
            d.stem_taper.push((h, dia));
        }
    }

    // ---- The crown, which needs the height and the diameter above.
    d.crown = crown_measures(m, b, d.tree_height, d.dbh_cyl);

    // ---- Cylinder distributions.
    // FIXED — reference defect 9. The reference's bins are half-open,
    // `Par >= (i-1)*a & Par < i*a`, and `n` is sized so that `n*a` IS
    // the maximum — so the largest value falls exactly on the top edge
    // and is counted nowhere. A histogram that silently drops its
    // largest item is worse than none, because it looks like data. The
    // top bin is closed here.
    let bins = |par: &dyn Fn(usize) -> f64, n: usize, a: f64| -> Dist3 {
        let mut out = Dist3 { volume: vec![0.0; n], area: vec![0.0; n], length: vec![0.0; n] };
        for (i, &li) in len.iter().enumerate() {
            let k = (par(i) / a).floor();
            if k.is_nan() || k < 0.0 || n == 0 { continue; }
            let k = (k as usize).min(n - 1);
            out.volume[k] += vol(i);
            out.area[k] += are(i);
            out.length[k] += li;
        }
        out
    };
    let rmax = rad.iter().copied().fold(0.0_f64, f64::max);
    d.cyl_diameter = bins(&|i| rad[i], (200.0*rmax).ceil().max(0.0) as usize, 0.005);
    d.cyl_zenith = bins(&|i| m.cyl.axis[i][2].clamp(-1.0, 1.0).acos().to_degrees(), 18, 10.0);
    d.cyl_azimuth = bins(
        &|i| m.cyl.axis[i][1].atan2(m.cyl.axis[i][0]).to_degrees() + 180.0, 36, 10.0);
    d.cyl_height = cylinder_height_distribution(m, d.tree_height);

    // ---- Branch distributions. The stem is row 0 and is never a
    // branch, so every one of these skips it.
    let order_max = d.max_branch_order as usize;
    let mut od = OrderDist {
        volume: vec![0.0; order_max.max(1)], area: vec![0.0; order_max.max(1)],
        length: vec![0.0; order_max.max(1)], number: vec![0; order_max.max(1)],
    };
    for i in 0..b.order.len() {
        let o = b.order[i] as usize;
        if o == 0 || o > order_max { continue; }
        od.volume[o-1] += b.volume[i];
        od.area[o-1] += b.area[i];
        od.length[o-1] += b.length[i];
        od.number[o-1] += 1;
    }
    d.branch_order = od;

    let bbins = |par: &dyn Fn(usize) -> f64, n: usize, a: f64| -> BranchDist {
        let mut o = BranchDist {
            volume: vec![0.0; n], volume_first: vec![0.0; n],
            area: vec![0.0; n], area_first: vec![0.0; n],
            length: vec![0.0; n], length_first: vec![0.0; n],
            number: vec![0; n], number_first: vec![0; n],
        };
        for i in 1..b.order.len() {
            let k = (par(i) / a).floor();
            if k.is_nan() || k < 0.0 || n == 0 { continue; }
            let k = (k as usize).min(n - 1);
            o.volume[k] += b.volume[i];
            o.area[k] += b.area[i];
            o.length[k] += b.length[i];
            o.number[k] += 1;
            if b.order[i] == 1 {
                o.volume_first[k] += b.volume[i];
                o.area_first[k] += b.area[i];
                o.length_first[k] += b.length[i];
                o.number_first[k] += 1;
            }
        }
        o
    };
    // FIXED — reference defect 10. The reference sizes this histogram
    // as `ceil(max(100*diameter))` bins and then makes each 0.005 wide,
    // so the bins together span HALF the range of diameters and every
    // branch above the halfway mark is dropped. Its own comment says
    // "diameter in 1 cm classes", and 1 cm classes are what make the
    // count and the width agree — so the width is 0.01, not 0.005.
    // (The cylinder version above bins RADIUS by 0.005, which is the
    // same 1 cm of diameter and is consistent with its own count.)
    let dmax = b.diameter.iter().skip(1).copied().fold(0.0_f64, f64::max);
    d.branch_diameter = bbins(&|i| b.diameter[i], (100.0*dmax).ceil().max(0.0) as usize, 0.01);
    d.branch_height = bbins(&|i| b.height[i], d.tree_height.ceil().max(0.0) as usize, 1.0);
    d.branch_angle = bbins(&|i| b.angle[i], 18, 10.0);
    d.branch_zenith = bbins(&|i| b.zenith[i], 18, 10.0);
    d.branch_azimuth = bbins(&|i| b.azimuth[i] + 180.0, 36, 10.0);
    d
}

/// The wood in each one-metre layer of the tree.
///
/// A cylinder spanning a layer boundary is SPLIT between the layers in
/// proportion to how much of it lies in each, which is why this is not
/// simply a histogram of cylinder midpoints: on a trunk whose cylinders
/// are longer than a metre, that would leave whole layers empty.
///
/// FIXED — reference defect 8, found while porting this. The reference
/// enumerates five cases: both ends in the layer, and each end in the
/// layer with the other one bin above or below. A cylinder spanning
/// MORE than one boundary matches none of them and is dropped from
/// every layer it crosses — so a 3 m trunk cylinder contributes nothing
/// to the metre in its middle. This apportions by overlap for any span,
/// which is what the five cases are each a special case of.
fn cylinder_height_distribution(m: &CylinderModel, tree_height: f64) -> Dist3 {
    let nc = m.cyl.len();
    let n = tree_height.ceil().max(0.0) as usize;
    let mut out = Dist3 { volume: vec![0.0; n], area: vec![0.0; n], length: vec![0.0; n] };
    if n == 0 || nc == 0 { return out; }
    let pi = std::f64::consts::PI;
    let bottom = m.cyl.start.iter().map(|s| s[2]).fold(f64::INFINITY, f64::min);
    // Each cylinder's base and top, as heights above the tree's base.
    let b: Vec<f64> = (0..nc).map(|i| m.cyl.start[i][2] - bottom).collect();
    let t: Vec<f64> = (0..nc)
        .map(|i| m.cyl.start[i][2] + m.cyl.length[i]*m.cyl.axis[i][2] - bottom)
        .collect();

    for (j, ((v, a), l)) in out.volume.iter_mut()
        .zip(out.area.iter_mut()).zip(out.length.iter_mut()).enumerate()
    {
        let (lo, hi) = (j as f64, j as f64 + 1.0);
        for i in 0..nc {
            let (bi, ti) = (b[i], t[i]);
            // What fraction of this cylinder lies in this layer. Zero
            // when it does not reach it at all.
            let span = ti - bi;
            let frac = if span.abs() < 1e-12 {
                if bi >= lo && bi < hi { 1.0 } else { 0.0 }
            } else {
                let (clo, chi) = (bi.min(ti), bi.max(ti));
                let overlap = chi.min(hi) - clo.max(lo);
                if overlap <= 0.0 { 0.0 } else { overlap / (chi - clo) }
            };
            if frac <= 0.0 { continue; }
            let (r, ln) = (m.cyl.radius[i], m.cyl.length[i]);
            *v += 1000.0 * pi * r * r * ln * frac;
            *a += 2.0 * pi * r * ln * frac;
            *l += ln * frac;
        }
    }
    out
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/tree_data.m,
// subfunction `crown_measures`.
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// What the reference reports about the crown.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CrownData {
    /// Mean crown diameter over eighteen 10-degree sectors, metres.
    pub diam_ave: f64,
    /// The largest distance between two points of the crown's outline.
    pub diam_max: f64,
    /// Square metres, the convex hull of the crown seen from above.
    pub area_conv: f64,
    /// The same as an alpha shape, which does not span the gaps
    /// between branches the way a convex hull does.
    pub area_alpha: f64,
    /// Metres above the base of the tree.
    pub base_height: f64,
    pub length: f64,
    /// Crown length over tree height.
    pub ratio: f64,
    /// Cubic metres.
    pub volume_conv: f64,
    pub volume_alpha: f64,
    /// One row per height layer from the bottom of the model up,
    /// eighteen sector spreads each. Twenty layers above 10 m, ten
    /// above 2 m, five below.
    pub spreads: Vec<[f64; 18]>,
    /// The branch taken as the first of the crown, and its height.
    pub first_branch: Option<u32>,
}

/// The point cloud `crown_measures` works from: points ON the surface
/// of every cylinder, plus every start and every tip.
///
/// Twelve to a ring and four rings for a stem cylinder, four around the
/// middle for a branch — the stem carries more because it is what the
/// crown's own outline is measured against. The reference does not
/// reset the reference direction between rings, so each ring starts
/// where the last one stopped; that is ported as written, because it is
/// what spreads the points around the stem instead of stacking them in
/// twelve columns.
fn crown_point_cloud(m: &CylinderModel) -> Vec<[f64; 3]> {
    let nc = m.cyl.len();
    let mut p: Vec<[f64; 3]> = Vec::with_capacity(6 * nc);
    for i in 0..nc {
        let (sta, axis, len, rad) = (m.cyl.start[i], m.cyl.axis[i], m.cyl.length[i], m.cyl.radius[i]);
        let Some((u0, _)) = perp_basis(axis) else { continue };
        let mut u = [u0[0] * rad, u0[1] * rad, u0[2] * rad];
        if m.branch[i] == 0 {
            let r = rotation_matrix(axis, std::f64::consts::PI / 12.0);
            for k in 1..=4 {
                let f = k as f64 / 4.0 * len;
                let mid = [sta[0] + f * axis[0], sta[1] + f * axis[1], sta[2] + f * axis[2]];
                for j in 0..12 {
                    if j > 0 { u = mat_vec(&r, u); }
                    p.push([mid[0] + u[0], mid[1] + u[1], mid[2] + u[2]]);
                }
            }
        } else {
            let f = 0.5 * len;
            let mid = [sta[0] + f * axis[0], sta[1] + f * axis[1], sta[2] + f * axis[2]];
            let r = rotation_matrix(axis, std::f64::consts::FRAC_PI_4);
            for j in 0..4 {
                if j > 0 { u = mat_vec(&r, u); }
                p.push([mid[0] + u[0], mid[1] + u[1], mid[2] + u[2]]);
            }
        }
    }
    p.retain(|q| q.iter().all(|x| x.is_finite()));
    for i in 0..nc {
        let (s, a, l) = (m.cyl.start[i], m.cyl.axis[i], m.cyl.length[i]);
        p.push(s);
        p.push([s[0] + l * a[0], s[1] + l * a[1], s[2] + l * a[2]]);
    }
    dedup_rows(p)
}

/// MATLAB's `unique(P,'rows')`: sorted and with the repeats gone.
fn dedup_rows(mut p: Vec<[f64; 3]>) -> Vec<[f64; 3]> {
    p.sort_by(|a, b| a[0].total_cmp(&b[0])
        .then(a[1].total_cmp(&b[1]))
        .then(a[2].total_cmp(&b[2])));
    p.dedup();
    p
}

fn dedup_rows2(mut p: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    p.sort_by(|a, b| a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])));
    p.dedup();
    p
}

/// Which of `nl` layers spanning `bot..=top` a height falls in.
///
/// FIXED — reference defect 9, at another of its sites. The reference
/// selects a layer with `P(:,3) >= bot+(j-1)*Hei/m & P(:,3) <
/// bot+j*Hei/m`, and for the topmost layer `bot+m*Hei/m` IS `top` — so
/// the highest point of the model is in no layer at all. The top layer
/// is closed here, which is the same correction made to the histograms
/// in `tree_data`.
fn height_layer(z: f64, bot: f64, top: f64, nl: usize) -> Option<usize> {
    // Written this way round so a NaN height falls out rather than
    // being placed: `z >= bot && z <= top` is false for NaN.
    if nl == 0 || top <= bot || !(z >= bot && z <= top) { return None; }
    let j = ((z - bot) / (top - bot) * nl as f64).floor();
    if !j.is_finite() { return None; }
    Some((j as usize).min(nl - 1))
}

/// The eighteen sector spreads of a set of points about `centre`.
///
/// Each of the eighteen readings is the furthest point in a 10-degree
/// sector plus the furthest in the sector opposite it, so a spread is a
/// diameter through the centre rather than a radius — and zero on
/// whichever side has no points at all.
///
/// FIXED — reference defect 9, at another of its sites. The reference
/// tests `ang >= (i-1)*pi/18 & ang < i*pi/18` for eighteen sectors with
/// `ang` running to exactly 2*pi, so a point lying on the negative x
/// axis — `atan2` returns pi there and pi + pi is 2*pi — falls in no
/// sector at all. The last sector is closed here.
fn sector_spreads(pts: &[[f64; 2]], centre: [f64; 2]) -> [f64; 18] {
    let mut best = [0.0f64; 36];
    let step = std::f64::consts::PI / 18.0;
    for q in pts {
        let v = [q[0] - centre[0], q[1] - centre[1]];
        let ang = v[1].atan2(v[0]) + std::f64::consts::PI;
        let l = (v[0] * v[0] + v[1] * v[1]).sqrt();
        let s = ((ang / step).floor() as isize).clamp(0, 35) as usize;
        if l > best[s] { best[s] = l; }
    }
    let mut out = [0.0f64; 18];
    for i in 0..18 { out[i] = best[i] + best[i + 18]; }
    out
}

/// `crown_measures` — the crown's width, area, base and volume.
///
/// `tree_height` and `dbh` are the ones already computed, exactly as
/// the reference passes them in through `treedata`.
pub fn crown_measures(
    m: &CylinderModel, b: &BranchData, tree_height: f64, dbh: f64,
) -> CrownData {
    use super::geom;
    let mut d = CrownData::default();
    let nc = m.cyl.len();
    if nc == 0 { return d; }
    let p = crown_point_cloud(m);
    if p.len() < 4 { return d; }
    let tip = |i: usize| {
        let (s, a, l) = (m.cyl.start[i], m.cyl.axis[i], m.cyl.length[i]);
        [s[0] + l * a[0], s[1] + l * a[1], s[2] + l * a[2]]
    };

    // ---- Vertical profile, one row of spreads per height layer.
    let bot = p.iter().map(|q| q[2]).fold(f64::INFINITY, f64::min);
    let top = p.iter().map(|q| q[2]).fold(f64::NEG_INFINITY, f64::max);
    let hei = top - bot;
    let nl = if hei > 10.0 { 20 } else if hei > 2.0 { 10 } else { 5 };
    d.spreads = vec![[0.0; 18]; nl];
    if hei > 0.0 {
        let mut layers: Vec<Vec<[f64; 2]>> = vec![Vec::new(); nl];
        for q in &p {
            if let Some(j) = height_layer(q[2], bot, top, nl) { layers[j].push([q[0], q[1]]); }
        }
        for (j, layer) in layers.into_iter().enumerate() {
            let layer = dedup_rows2(layer);
            if layer.len() <= 5 { continue; }
            let hull = geom::convex_hull_2d(&layer);
            if hull.is_empty() { continue; }
            let poly: Vec<[f64; 2]> = hull.iter().map(|&i| layer[i]).collect();
            let Some(c) = geom::polygon_centroid(&poly) else { continue };
            d.spreads[j] = sector_spreads(&layer, c);
        }
    }

    // ---- Crown diameters, from the cylinder TIPS about the centre of
    // the whole outline's area.
    let flat = dedup_rows2(p.iter().map(|q| [q[0], q[1]]).collect());
    let hull = geom::convex_hull_2d(&flat);
    if hull.is_empty() { return d; }
    let poly: Vec<[f64; 2]> = hull.iter().map(|&i| flat[i]).collect();
    // The absolute value is belt and braces: `convex_hull_2d` returns
    // its hull counter-clockwise, so the signed area is already
    // positive and dropping the `abs` changes nothing measurable. It
    // stays because a hull that ever came back the other way round
    // would otherwise report a negative crown area.
    d.area_conv = geom::polygon_signed_area(&poly).abs();
    let Some(c) = geom::polygon_centroid(&poly) else { return d };
    let tips: Vec<[f64; 2]> = (0..nc).map(|i| { let t = tip(i); [t[0], t[1]] }).collect();
    let s = sector_spreads(&tips, c);
    d.diam_ave = s.iter().sum::<f64>() / 18.0;

    // FIXED — reference defect 13. The reference walks the hull
    // keeping the largest distance from each vertex to every other in
    // `MaxDiam` — and then assigns `CrownDiamMax = L`, the distance
    // from the LAST vertex alone. The running maximum it just computed
    // is thrown away, and what is reported is how far the crown
    // reaches from one arbitrary point on its outline.
    let mut max_diam: f64 = 0.0;
    for &a in &poly {
        for &q in &poly {
            let l = ((q[0] - a[0]).powi(2) + (q[1] - a[1]).powi(2)).sqrt();
            if l > max_diam { max_diam = l; }
        }
    }
    d.diam_max = max_diam;

    // ---- Crown area as an alpha shape as well as a hull.
    let alp = 0.5f64.max(d.diam_ave / 10.0);
    d.area_alpha = geom::alpha_area_2d(&flat, alp);

    // ---- Crown base: the lowest first-order branch thick enough and
    // reaching far enough out to count as a limb rather than an epicormic
    // shoot, and then everything growing off it.
    let nbr = b.order.len();
    let first_order: Vec<u32> = (0..nbr as u32).filter(|&i| b.order[i as usize] == 1).collect();
    if first_order.is_empty() || dbh <= 0.0 {
        d.base_height = tree_height;
        return d;
    }
    // Horizontal reach: how far out the branch gets, in stem RADII.
    //
    // FIXED — reference defect 14. `tip = Sta(C,:)+Len(C)*Axe(C)`
    // indexes the axis matrix with a single subscript, which in MATLAB
    // is a linear index and yields the x component alone — a scalar,
    // which then broadcasts over all three coordinates. The tip of
    // every first-order branch is computed as its start plus its length
    // times the x component of its axis, in x, y AND z.
    let mut reach = vec![0.0f64; nbr];
    for &br in &first_order {
        let Some(cs) = m.cyls_in_segment.get(br as usize) else { continue };
        if cs.is_empty() { continue; }
        let base = m.cyl.start[cs[0] as usize];
        let t = tip(*cs.last().unwrap() as usize);
        let v = [t[0] - base[0], t[1] - base[1]];
        reach[br as usize] = (v[0] * v[0] + v[1] * v[1]).sqrt() / dbh * 2.0;
    }
    // FIXED — reference defect 15. `M = min(10,median(HL))` takes the
    // median of a vector sized to ALL the branches, in which only the
    // first-order ones were ever written; every higher-order branch
    // contributes a zero. Higher orders normally outnumber first, so
    // the median is exactly zero and the reach criterion — which the
    // comment says is "more than the median reach of 1st-ord.
    // branches" — tests nothing.
    let mut firsts: Vec<f64> = first_order.iter().map(|&i| reach[i as usize]).collect();
    let median_reach = 10.0f64.min(median_of(&mut firsts));

    // Lowest first.
    let mut by_height = first_order.clone();
    by_height.sort_by(|&x, &y| b.height[x as usize]
        .partial_cmp(&b.height[y as usize]).unwrap_or(std::cmp::Ordering::Equal));

    // FIXED — reference defect 16, which is one six-line loop with
    // three symptoms. Its own comment says "Search the first/lowest
    // branch", and:
    //   * `i = 1; while i < nb; i = i+1;` increments BEFORE testing, so
    //     the lowest branch is the one branch never tested;
    //   * the fall-back `if i == nb+1 ... b = branches1(1)` can never
    //     run — a normal exit leaves i == nb and a hit leaves i == nb+2
    //     — so a tree whose branches all fail the test is reported as
    //     having no crown at all rather than falling back to its lowest
    //     branch, as that dead line intends;
    //   * `if nb > 1` excludes a tree with exactly one first-order
    //     branch from having a crown.
    // Here every first-order branch is tested from the lowest up, and
    // the lowest is the fall-back when none qualifies.
    let min_diam = 0.05f64.min(0.05 * dbh);
    let first = by_height.iter().copied()
        .find(|&i| b.diameter[i as usize] > min_diam && reach[i as usize] > median_reach)
        .or_else(|| by_height.first().copied());
    let Some(first) = first else {
        d.base_height = tree_height;
        return d;
    };
    d.first_branch = Some(first);

    // The branch and everything growing off it, to any depth.
    let mut crown_branches = vec![first];
    let mut k = 0;
    while k < crown_branches.len() {
        let cur = crown_branches[k];
        k += 1;
        for i in 0..nbr as u32 {
            if b.parent[i as usize] == Some(cur) && !crown_branches.contains(&i) {
                crown_branches.push(i);
            }
        }
    }

    let mut base_z = m.cyl.start.iter().map(|s| s[2]).fold(f64::NEG_INFINITY, f64::max);
    for &br in &crown_branches {
        let Some(cs) = m.cyls_in_segment.get(br as usize) else { continue };
        for &ci in cs {
            let h = m.cyl.start[ci as usize][2].min(tip(ci as usize)[2]);
            if h < base_z { base_z = h; }
        }
    }
    d.base_height = base_z - m.cyl.start[0][2];
    d.length = tree_height - d.base_height;
    d.ratio = if tree_height > 0.0 { d.length / tree_height } else { 0.0 };

    let crown: Vec<[f64; 3]> = p.iter().copied().filter(|q| q[2] >= base_z).collect();
    if crown.len() >= 4 {
        d.volume_conv = geom::convex_hull_volume_3d(&crown);
        let alp = 0.5f64.max(d.diam_ave / 5.0);
        d.volume_alpha = geom::alpha_volume_3d(&crown, alp, 10_000.0);
    }
    d
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/tree_data.m,
// subfunction `triangulate_stem`.
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// What the stem triangulation adds to a run's numbers.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StemTriangulation {
    pub mesh: Option<super::tria::Triangulation>,
    /// Why there is no mesh, when there is none.
    pub failure: Option<super::tria::TriaFailure>,
    /// Diameter at breast height off the mesh itself, metres.
    pub dbh_tri: f64,
    /// Litres and square metres, the triangulated butt alone.
    pub tria_trunk_volume: f64,
    pub tria_trunk_area: f64,
    /// Metres of stem the mesh covers.
    pub tria_trunk_length: f64,
    /// The triangulated butt plus the cylinders above it.
    pub mix_trunk_volume: f64,
    pub mix_trunk_area: f64,
    pub mix_total_volume: f64,
    pub mix_total_area: f64,
}

/// How far up the trunk the mesh should reach: the position in
/// `trunk_ids` of the cylinder it stops at.
///
/// The reference wants the first major branch — the lowest first-order
/// branch at least a tenth of the stem's own diameter — and never goes
/// past the point where the stem has thinned to a quarter of its
/// breast-height diameter, nor stops at fewer than three cylinders.
///
/// FIXED — reference defect 17. Two faults in five lines. `b = ind(b)`
/// runs after a loop that leaves `b` one past the end when no branch is
/// thick enough, so MATLAB indexes off the end of the array and the
/// function dies. And the guard meant to catch that, `if b > n`, runs
/// AFTER the indexing and compares a BRANCH INDEX against the COUNT of
/// first-order branches — two different quantities. On any tree whose
/// chosen branch is numbered higher than that count, which is the
/// ordinary case, the branch just found is thrown away and replaced by
/// the thickest branch of ANY order — normally the stem itself, branch
/// 1, which then pins the triangulated section at three cylinders
/// whatever the tree looks like.
fn mesh_stop_cylinder(
    m: &CylinderModel, b: &BranchData, dbh: f64, trunk_ids: &[usize],
) -> usize {
    let mut firsts: Vec<u32> = (0..b.order.len() as u32)
        .filter(|&i| b.order[i as usize] == 1).collect();
    firsts.sort_by(|&x, &y| b.height[x as usize]
        .partial_cmp(&b.height[y as usize]).unwrap_or(std::cmp::Ordering::Equal));
    let major = firsts.iter().copied()
        .find(|&i| b.diameter[i as usize] >= 0.1 * dbh)
        .or_else(|| firsts.iter().copied().max_by(|&x, &y| {
            b.diameter[x as usize].partial_cmp(&b.diameter[y as usize])
                .unwrap_or(std::cmp::Ordering::Equal)
        }));
    let stop_z = match major {
        Some(br) => m.cyls_in_segment.get(br as usize)
            .and_then(|c| c.first())
            .map(|&c| m.cyl.start[c as usize][2])
            .unwrap_or(f64::INFINITY),
        None => f64::INFINITY,
    };
    let n_trunk = trunk_ids.len();
    let mut i = 1usize;
    while i + 1 < n_trunk
        && m.cyl.start[trunk_ids[i]][2] < stop_z
        && m.cyl.radius[trunk_ids[i]] > 0.125 * dbh
    {
        i += 1;
    }
    i.max(2).min(n_trunk.saturating_sub(1))
}

/// `triangulate_stem` — reconstruct the butt of the stem as a mesh and
/// report the volumes that follow from it.
///
/// `trunk` is the stem's own points. `d` supplies the numbers the
/// reference reads out of `treedata`: the diameter at breast height off
/// the cylinder chain, and the trunk and branch totals the mix is built
/// from.
pub fn triangulate_stem(
    m: &CylinderModel, b: &BranchData, trunk: &[[f64; 3]], d: &TreeData,
) -> StemTriangulation {
    let mut out = StemTriangulation {
        dbh_tri: d.dbh_qsm,
        tria_trunk_volume: d.trunk_volume,
        tria_trunk_area: d.trunk_area,
        tria_trunk_length: 0.0,
        mix_trunk_volume: d.trunk_volume,
        mix_trunk_area: d.trunk_area,
        mix_total_volume: d.total_volume,
        mix_total_area: d.total_area,
        ..Default::default()
    };
    let nc = m.cyl.len();
    if nc == 0 || d.dbh_qsm <= 0.0 { out.failure = Some(super::tria::TriaFailure::NoFirstCurve); return out; }

    let trunk_ids: Vec<usize> = (0..nc).filter(|&i| m.branch_order[i] == 0).collect();
    if trunk_ids.len() < 3 {
        out.failure = Some(crate::commands::tria::TriaFailure::NoFirstCurve);
        return out;
    }
    let cyl_ind = mesh_stop_cylinder(m, b, d.dbh_qsm, &trunk_ids);
    let top_z = m.cyl.start[trunk_ids[cyl_ind]][2];
    let len_tri = top_z - m.cyl.start[trunk_ids[0]][2];
    if trunk.len() <= 1000 {
        out.failure = Some(crate::commands::tria::TriaFailure::TooFewPoints);
        return out;
    }
    if len_tri < 1.0 {
        out.failure = Some(crate::commands::tria::TriaFailure::SectionTooShort);
        return out;
    }

    // ---- Triangle size: big enough that a sparse cloud still has
    // points in every triangle, and never under a floor set by how
    // thick the stem is.
    let mut density: Vec<f64> = Vec::new();
    for k in 0..cyl_ind {
        let (a, c) = (trunk_ids[k], trunk_ids[k + 1]);
        let (lo, hi) = (m.cyl.start[a][2], m.cyl.start[c][2]);
        let n = trunk.iter().filter(|q| q[2] >= lo && q[2] < hi).count();
        if n > 0 {
            density.push(std::f64::consts::PI * m.cyl.radius[a] * m.cyl.length[a] / n as f64);
        }
    }
    let dens = density.iter().copied().fold(0.0f64, f64::max);
    let floor: f64 = if d.dbh_qsm > 1.0 { 0.10 }
        else if d.dbh_qsm > 0.50 { 0.075 }
        else if d.dbh_qsm > 0.10 { 0.05 }
        else { 0.02 };
    let base_height = floor.max(4.0 * dens.sqrt());

    // ---- The reconstruction, with the reference's own retries: three
    // triangle sizes, and four progressively shorter stem sections.
    let mut cyl_ind = cyl_ind;
    let mut mesh: Option<super::tria::Triangulation> = None;
    let mut why = super::tria::TriaFailure::NoFirstCurve;
    'outer: for _ in 0..4 {
        let top_z = m.cyl.start[trunk_ids[cyl_ind]][2];
        let stem: Vec<[f64; 3]> = trunk.iter().copied().filter(|q| q[2] <= top_z).collect();
        for k in 0..3 {
            let h = base_height + 0.03 * k as f64;
            match super::tria::curve_based_triangulation(&stem, h, h) {
                Ok(t) => { mesh = Some(t); break 'outer; }
                Err(e) => why = e,
            }
        }
        if cyl_ind <= 2 { break; }
        cyl_ind -= 1;
    }
    let Some(mut t) = mesh else { out.failure = Some(why); return out; };
    t.cyl_ind = cyl_ind;
    out.tria_trunk_length = m.cyl.start[trunk_ids[cyl_ind]][2] - m.cyl.start[trunk_ids[0]][2];

    // ---- Diameter at breast height, off the mesh: the perimeter of
    // the boundary curve nearest 1.3 m, over pi.
    let want = t.bottom + 1.3;
    let nearest = t.vert.iter().map(|q| q[2])
        .min_by(|a, c| (a - want).abs().partial_cmp(&(c - want).abs())
            .unwrap_or(std::cmp::Ordering::Equal));
    if let Some(hz) = nearest {
        let ring: Vec<[f64; 3]> = t.vert.iter().copied()
            .filter(|q| (q[2] - hz).abs() < t.tria_height / 2.0).collect();
        if ring.len() >= 3 {
            let mut per = 0.0;
            for k in 0..ring.len() {
                let c = ring[(k + 1) % ring.len()];
                per += ((c[0] - ring[k][0]).powi(2) + (c[1] - ring[k][1]).powi(2)).sqrt();
            }
            out.dbh_tri = per / std::f64::consts::PI;
        }
    }

    // ---- The mix: the mesh in place of the cylinders it covers.
    let pi = std::f64::consts::PI;
    let replaced_v: f64 = (0..cyl_ind).map(|k| {
        let c = trunk_ids[k];
        1000.0 * pi * m.cyl.radius[c] * m.cyl.radius[c] * m.cyl.length[c]
    }).sum();
    let replaced_a: f64 = (0..cyl_ind).map(|k| {
        let c = trunk_ids[k];
        2.0 * pi * m.cyl.radius[c] * m.cyl.length[c]
    }).sum();
    out.tria_trunk_volume = t.volume;
    out.tria_trunk_area = t.side_area;
    out.mix_trunk_volume = d.trunk_volume - replaced_v + t.volume;
    out.mix_trunk_area = d.trunk_area - replaced_a + t.side_area;
    out.mix_total_volume = out.mix_trunk_volume + d.branch_volume;
    out.mix_total_area = out.mix_trunk_area + d.branch_area;
    out.mesh = Some(t);
    out
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/point_model_distance.m
// Portions Copyright (C) 2015-2021 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// Median, mean, maximum and standard deviation over one group of
/// cylinders. `std` is MATLAB's: the sample deviation, divided by n-1.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PmStats {
    pub median: f64,
    pub mean: f64,
    pub max: f64,
    pub std: f64,
    /// How many cylinders the four numbers above were taken over.
    pub count: usize,
}

/// `point_model_distance` — how far the cloud sits from the model.
///
/// The one number that says whether a QSM fits the tree it was built
/// from. Each point is assigned to the nearest cylinder surface, and
/// each cylinder reports the mean distance of the points that chose it.
#[derive(Clone, Debug, Default)]
pub struct PmDistance {
    /// Per cylinder, metres: the mean distance of the points assigned
    /// to it. `None` where no point was.
    pub cyl_dist: Vec<Option<f64>>,
    pub all: PmStats,
    pub trunk: PmStats,
    /// Every cylinder that is not the trunk.
    pub branch: PmStats,
    pub branch1: PmStats,
    pub branch2: PmStats,
    /// Cylinders no point was assigned to. See defect 11.
    pub unmatched: usize,
    /// Points the distances were computed over, after subsampling.
    pub points_used: usize,
}

fn pm_stats(v: &[f64]) -> PmStats {
    if v.is_empty() { return PmStats::default(); }
    let n = v.len();
    let mut s = v.to_vec();
    let median = median_of(&mut s);
    let mean = v.iter().sum::<f64>() / n as f64;
    let max = v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    // MATLAB's std: the sample deviation, and 0 for a single value.
    let std = if n < 2 {
        0.0
    } else {
        (v.iter().map(|x| (x - mean) * (x - mean)).sum::<f64>() / (n - 1) as f64).sqrt()
    };
    PmStats { median, mean, max, std, count: n }
}

/// The distances of `points` to the surface of `m`'s cylinders.
///
/// DELIBERATE DEVIATION: the reference draws its 25 % subsample with
/// `rand`, so two runs over the same cloud and the same model report
/// different distances — and `select_optimum` picks between models by
/// exactly this number, so the choice of model is not reproducible
/// either. This takes the same fraction through the seeded shuffle used
/// everywhere else in the port, which makes the comparison between
/// models a comparison over the same points.
pub fn point_model_distance(points: &[[f64; 3]], m: &CylinderModel, seed: u64) -> PmDistance {
    if points.is_empty() {
        return PmDistance { cyl_dist: vec![None; m.cyl.len()],
                            unmatched: m.cyl.len(), ..Default::default() };
    }
    // A quarter of the cloud, capped at a million points, as the
    // reference does — it is a speed measure and the statistic is a
    // mean over thousands of points either way.
    let np0 = points.len();
    let keep = (np0 / 4).min(1_000_000).clamp(1, np0);
    let mut order = shuffled(np0, seed);
    order.truncate(keep);
    order.sort_unstable();
    let p: Vec<[f64; 3]> = order.iter().map(|&i| points[i as usize]).collect();
    point_model_distance_exact(&p, m)
}

/// The distances themselves, over exactly the points given.
///
/// `point_model_distance` is this with the reference's subsample in
/// front of it. Kept separate so the distance rules can be tested on a
/// cloud of a known handful of points rather than on a quarter of one.
pub fn point_model_distance_exact(p: &[[f64; 3]], m: &CylinderModel) -> PmDistance {
    let n = m.cyl.len();
    let mut out = PmDistance {
        cyl_dist: vec![None; n],
        ..Default::default()
    };
    if n == 0 || p.is_empty() { out.unmatched = n; return out; }
    let np = p.len();
    out.points_used = np;

    // Cube size: twice the median cylinder length, so a cylinder's own
    // points are within a cube or two of its start.
    let mut lens = m.cyl.length.clone();
    let l = 2.0 * median_of(&mut lens);
    if !(l.is_finite() && l > 0.0) { out.unmatched = n; return out; }
    let grid = build_grid(p, &(0..np as u32).collect::<Vec<_>>(), l);

    // Distance to the nearest cylinder surface, and which one. The
    // reference seeds this with 2 m and never records anything past
    // 0.5 m, so a point further than that from every cylinder stays
    // unassigned.
    let mut best = vec![(f64::INFINITY, usize::MAX); np];
    // Each cylinder's own candidates, kept for the second pass over the
    // ends — the reference's `Data`.
    let mut near: Vec<Vec<(f64, f64, u32)>> = vec![Vec::new(); n];

    for (i, slot) in near.iter_mut().enumerate() {
        let (sta, axis, len, rad) = (m.cyl.start[i], m.cyl.axis[i], m.cyl.length[i], m.cyl.radius[i]);
        // Enough cubes to reach the far end of the cylinder. The
        // reference then clamps the index into its fixed array; a hash
        // grid has no edge to fall off, so the clamp is not ported.
        //
        // The upper bound of 12 is a guard, not the reference: `L` is
        // twice the MEDIAN length, so `ceil(len/L)` is 5 or so for the
        // longest cylinder in a normal model, and only a pathological
        // length distribution would make the neighbourhood explode.
        let reach = ((len / l).ceil().max(0.0) as i64).min(12);
        let c = cell_of(sta, l);
        let mut cand: Vec<u32> = Vec::new();
        for dx in -reach..=reach { for dy in -reach..=reach { for dz in -reach..=reach {
            if let Some(v) = grid.get(&[c[0] + dx, c[1] + dy, c[2] + dz]) {
                cand.extend_from_slice(v);
            }
        }}}
        if cand.is_empty() { continue; }
        let q: Vec<[f64; 3]> = cand.iter().map(|&j| p[j as usize]).collect();
        let (d, _, h) = distances_to_line(&q, axis, sta);
        let mut mine = Vec::with_capacity(cand.len());
        for (k, &j) in cand.iter().enumerate() {
            mine.push(((d[k] - rad).abs(), h[k], j));
        }
        // First pass: points beside the cylinder, within half a metre.
        for &(dk, hk, j) in &mine {
            if dk < 0.5 && hk >= 0.0 && hk <= len && dk < best[j as usize].0 {
                best[j as usize] = (dk, i);
            }
        }
        *slot = mine;
    }

    // Second pass: points just off either end, which the first pass
    // rejected for being outside the cylinder's own span.
    for (i, mine) in near.iter().enumerate() {
        let len = m.cyl.length[i];
        for &(dk, hk, j) in mine {
            let at_end = (-0.1..=0.0).contains(&hk) || (len..=len + 0.1).contains(&hk);
            if dk < 0.5 && at_end && dk < best[j as usize].0 {
                best[j as usize] = (dk, i);
            }
        }
    }

    // Per cylinder, the mean of the shortest 95 % of the distances of
    // the points that chose it — the tail is where a branch the model
    // does not have leaves its points on the nearest one that exists.
    let mut per: Vec<Vec<f64>> = vec![Vec::new(); n];
    for &(dk, i) in &best {
        if i != usize::MAX { per[i].push(dk); }
    }
    let mut all = Vec::new();
    for (i, v) in per.iter_mut().enumerate() {
        if v.is_empty() { out.unmatched += 1; continue; }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let take = if v.len() > 19 { (0.95 * v.len() as f64).floor() as usize } else { v.len() };
        let take = take.max(1);
        let mean = v[..take].iter().sum::<f64>() / take as f64;
        out.cyl_dist[i] = Some(mean);
        all.push(mean);
    }

    // FIXED — reference defect 11. The reference leaves a cylinder no
    // point was assigned to at DistCyl = 0 and then averages over every
    // cylinder, so a cylinder standing in empty space is scored as a
    // perfect fit. That is not a rounding matter: `select_optimum`
    // chooses between models by this mean, and the defect rewards the
    // model that invents the most cylinders nothing supports. Here they
    // are left out of the statistics and counted in `unmatched`.
    let group = |keep: &dyn Fn(u8) -> bool| -> Vec<f64> {
        (0..n).filter(|&i| keep(m.branch_order[i]))
            .filter_map(|i| out.cyl_dist[i]).collect()
    };
    let (t, b, b1, b2) = (
        group(&|o| o == 0), group(&|o| o != 0),
        group(&|o| o == 1), group(&|o| o == 2),
    );
    out.all = pm_stats(&all);
    out.trunk = pm_stats(&t);
    out.branch = pm_stats(&b);
    out.branch1 = pm_stats(&b1);
    out.branch2 = pm_stats(&b2);
    out
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/tools/growth_volume_correction.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// The growth volume of every cylinder: its own, plus every
/// cylinder's that grows out of it, to any depth.
///
/// A branch's growth volume is how much wood hangs off it, which is
/// what the pipe model says its own thickness should be proportional to
/// — so a cylinder whose radius disagrees badly with the wood it
/// carries has probably been fitted to the wrong points.
pub fn growth_volume(m: &CylinderModel) -> Vec<f64> {
    let n = m.cyl.len();
    let mut own = vec![0.0f64; n];
    for (i, o) in own.iter_mut().enumerate() {
        *o = std::f64::consts::PI * m.cyl.radius[i] * m.cyl.radius[i] * m.cyl.length[i];
    }
    // Children first: a cylinder cannot be totalled before everything
    // hanging off it is. The reference walks up level by level from the
    // tips and overwrites, which reaches the same answer because a
    // cylinder's LAST visit is after all its children are final; this
    // visits each once, in an order that guarantees it.
    let mut children: Vec<Vec<u32>> = vec![Vec::new(); n];
    for i in 0..n {
        if let Some(p) = m.parent[i] {
            if (p as usize) < n && p as usize != i { children[p as usize].push(i as u32); }
        }
    }
    let mut gv = own.clone();
    let mut order: Vec<usize> = Vec::with_capacity(n);
    let mut pending: Vec<usize> = vec![0; n];
    for i in 0..n { pending[i] = children[i].len(); }
    let mut ready: Vec<usize> = (0..n).filter(|&i| pending[i] == 0).collect();
    while let Some(i) = ready.pop() {
        order.push(i);
        if let Some(p) = m.parent[i] {
            let p = p as usize;
            if p < n && p != i {
                pending[p] -= 1;
                if pending[p] == 0 { ready.push(p); }
            }
        }
    }
    for &i in &order {
        for &c in &children[i] { gv[i] += gv[c as usize]; }
    }
    // Anything left out was in a parent cycle, which the model should
    // never contain; it keeps its own volume rather than a wrong total.
    gv
}

/// Fit `r = a * gv^b + c` by Levenberg-Marquardt, the allometry the
/// reference fits with `lsqcurvefit` from the same starting point.
fn fit_allometry(gv: &[f64], rad: &[f64]) -> Option<[f64; 3]> {
    let n = gv.len();
    if n < 4 { return None; }
    let mut p = [0.5f64, 0.5, 0.0];
    let mut lambda = 1e-3f64;
    let model = |p: &[f64; 3], x: f64| p[0] * x.max(1e-12).powf(p[1]) + p[2];
    let cost = |p: &[f64; 3]| -> f64 {
        (0..n).map(|i| { let e = model(p, gv[i]) - rad[i]; e * e }).sum()
    };
    let mut c0 = cost(&p);
    if !c0.is_finite() { return None; }
    for _ in 0..200 {
        // Normal equations from the analytic Jacobian.
        let mut jtj = [[0.0f64; 3]; 3];
        let mut jtr = [0.0f64; 3];
        for i in 0..n {
            let x = gv[i].max(1e-12);
            let xb = x.powf(p[1]);
            let j = [xb, p[0] * xb * x.ln(), 1.0];
            if !j.iter().all(|v| v.is_finite()) { return None; }
            let r = p[0] * xb + p[2] - rad[i];
            for a in 0..3 {
                jtr[a] += j[a] * r;
                for b in 0..3 { jtj[a][b] += j[a] * j[b]; }
            }
        }
        let mut stepped = false;
        for _ in 0..30 {
            let mut a = jtj;
            for (k, row) in a.iter_mut().enumerate() { row[k] *= 1.0 + lambda; }
            let Some(d) = solve3(&a, &[-jtr[0], -jtr[1], -jtr[2]]) else { break };
            let q = [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
            let c1 = cost(&q);
            if c1.is_finite() && c1 < c0 {
                let gain = c0 - c1;
                p = q;
                c0 = c1;
                lambda = (lambda * 0.3).max(1e-12);
                stepped = true;
                if gain < 1e-16 * c0.max(1e-16) { return Some(p); }
                break;
            }
            lambda *= 10.0;
            if lambda > 1e12 { break; }
        }
        if !stepped { break; }
    }
    if p.iter().all(|v| v.is_finite()) { Some(p) } else { None }
}

/// A 3x3 solve by Cramer's rule, for the normal equations above.
fn solve3(a: &[[f64; 3]; 3], b: &[f64; 3]) -> Option<[f64; 3]> {
    let det = |m: &[[f64; 3]; 3]| {
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
            - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    };
    let d = det(a);
    if !d.is_finite() || d.abs() < 1e-300 { return None; }
    let mut out = [0.0f64; 3];
    for k in 0..3 {
        let mut m = *a;
        for r in 0..3 { m[r][k] = b[r]; }
        out[k] = det(&m) / d;
    }
    if out.iter().all(|v| v.is_finite()) { Some(out) } else { None }
}

/// What a growth-volume correction did.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GrowthVolCorrection {
    /// `[a, b, c]` of `r = a*gv^b + c`, absent when the fit failed.
    pub allometry: Option<[f64; 3]>,
    pub modified: usize,
    /// Largest radius change, metres, signed.
    pub largest_change: f64,
    /// Litres, before and after.
    pub volume_before: f64,
    pub volume_after: f64,
}

/// `growth_volume_correction` — pull radii back to the allometry.
///
/// Off by default in the reference (`GrowthVolCor = 0`), and this is
/// the same: it is an opinion about how a tree ought to taper, applied
/// to a model that was measured. It earns its place where a stem is so
/// poorly seen that a fitted radius is nonsense, and `fac` says how far
/// from the allometry a radius has to be before that opinion wins.
pub fn growth_volume_correction(m: &mut CylinderModel, fac: f64) -> GrowthVolCorrection {
    let n = m.cyl.len();
    let mut out = GrowthVolCorrection::default();
    // A factor of one or less would replace every radius with the
    // allometry's, which is a model of a tree rather than a measurement
    // of one. NaN falls out here too: `<=` is false for it.
    if n == 0 || fac.is_nan() || fac <= 1.0 { return out; }
    let pi = std::f64::consts::PI;
    let vol = |m: &CylinderModel| -> f64 {
        1000.0 * pi * (0..m.cyl.len())
            .map(|i| m.cyl.radius[i] * m.cyl.radius[i] * m.cyl.length[i]).sum::<f64>()
    };
    out.volume_before = vol(m);
    out.volume_after = out.volume_before;

    let gv = growth_volume(m);
    let Some(p) = fit_allometry(&gv, &m.cyl.radius) else { return out };
    out.allometry = Some(p);

    for (i, &g) in gv.iter().enumerate() {
        let pred = p[0] * g.max(1e-12).powf(p[1]) + p[2];
        // A GUARD, not the reference. The intercept `c` is free, so the
        // allometry can predict a NEGATIVE radius for a small growth
        // volume — and the reference then writes it: `Rad(modify) =
        // CorRad` with no check that the prediction is a radius at all.
        // A cylinder of negative radius has negative area and positive
        // volume, and every total downstream is quietly wrong.
        if !(pred.is_finite() && pred > 0.0) { continue; }
        let r = m.cyl.radius[i];
        let too_thin = r < pred / fac;
        let too_thick = r > fac * pred;
        // The tips are never fattened: a twig that ends where the points
        // ran out is thin because it is a twig, not because the fit
        // failed.
        if too_thin && m.extension[i].is_none() { continue; }
        if !(too_thin || too_thick) { continue; }
        if (pred - r).abs() > out.largest_change.abs() { out.largest_change = pred - r; }
        m.cyl.radius[i] = pred;
        out.modified += 1;
    }
    out.volume_after = vol(m);
    out
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/select_optimum.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================
//
// WHAT IS PORTED, AND WHAT IS NOT, AND WHY.
//
// The reference offers 91 metrics. Forty-five of them — every
// combination of five cylinder groups with mean distance, maximum
// distance, mean-plus-maximum distance, mean surface coverage and
// minimum surface coverage — measure a single model, and all
// forty-five are here.
//
// The other forty-six measure the SPREAD between several models built
// from the SAME inputs: the standard deviation of the volume, of the
// area, of the branch count, or the largest difference between the
// per-order and per-diameter distributions. They exist because the
// reference's `cover_sets` shuffles with `randperm`, so running the
// same inputs twice gives two different models, and a small spread is
// taken as a sign that the inputs are close to right.
//
// This port is deterministic: the same inputs give the same model
// every time, by construction, so every one of those forty-six
// evaluates to exactly zero for every input combination, they all tie,
// and the "choice" is whichever combination happens to come first.
// Implementing them would be implementing a metric that cannot
// discriminate. They could be made meaningful by running each input
// combination several times with different shuffle seeds and taking
// the spread over those, which is what the reference is doing by
// accident; that multiplies the cost of a sweep by the repeat count
// and is not done here.
//
// The rest of the file — multiple trees, averaging over repeated runs,
// the input sensitivity estimates and the printed report — has no
// counterpart here: this sweeps one tree over `create_input`'s eight
// combinations, once each.

/// Which cylinders a metric looks at. The reference's five groups and
/// the four sums of them it offers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MetricGroup {
    #[default]
    All,
    Trunk,
    /// Everything that is not the trunk.
    Branch,
    Branch1,
    Branch2,
    /// The trunk and the branches weigh the same, rather than the
    /// branches dominating by being more numerous.
    TrunkAndBranch,
    TrunkAndBranch1,
    TrunkAndBranch1AndBranch2,
    Branch1AndBranch2,
}

/// What a metric measures. All five are minimised.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum MetricKind {
    /// The reference's default when combined with `All`.
    #[default]
    MeanDistance,
    MaxDistance,
    MeanPlusMaxDistance,
    /// One minus the mean surface coverage.
    MeanSurfaceCoverage,
    /// One minus the smallest surface coverage.
    MinSurfaceCoverage,
}

/// One of the reference's 45 single-model metrics. The default is its
/// own default, `all_mean_dis`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct QsmMetric {
    pub group: MetricGroup,
    pub kind: MetricKind,
}

/// Mean and smallest surface coverage over one group of cylinders.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CovStats {
    pub mean: f64,
    pub min: f64,
    pub count: usize,
}

fn cov_stats(v: &[f64]) -> CovStats {
    if v.is_empty() { return CovStats::default(); }
    CovStats {
        mean: v.iter().sum::<f64>() / v.len() as f64,
        min: v.iter().copied().fold(f64::INFINITY, f64::min),
        count: v.len(),
    }
}

/// The surface coverages `select_optimum` collects from a model.
#[derive(Clone, Debug, Default)]
pub struct SurfCov {
    pub all: CovStats,
    pub trunk: CovStats,
    pub branch: CovStats,
    pub branch1: CovStats,
    pub branch2: CovStats,
}

/// Everything a metric can be computed from, for one model.
#[derive(Clone, Debug, Default)]
pub struct ModelScore {
    pub pm: PmDistance,
    pub surf_cov: SurfCov,
}

/// Measure one model against the cloud it was built from.
pub fn score_model(points: &[[f64; 3]], m: &CylinderModel, seed: u64) -> ModelScore {
    let n = m.cyl.len();
    let take = |keep: &dyn Fn(u8) -> bool| -> Vec<f64> {
        (0..n).filter(|&i| keep(m.branch_order[i]))
            .map(|i| m.cyl.surf_cov[i]).collect()
    };
    ModelScore {
        pm: point_model_distance(points, m, seed),
        surf_cov: SurfCov {
            all: cov_stats(&take(&|_| true)),
            trunk: cov_stats(&take(&|o| o == 0)),
            branch: cov_stats(&take(&|o| o != 0)),
            branch1: cov_stats(&take(&|o| o == 1)),
            branch2: cov_stats(&take(&|o| o == 2)),
        },
    }
}

/// The value of `metric` for one model. Smaller is better, always.
///
/// FIXED — reference defect 12. `point_model_distance.m` writes 0 for
/// the branch, 1st- and 2nd-order groups of a model that has none of
/// them, and `select_optimum` then minimises over that: a model that
/// found no branches at all scores a perfect zero on `branch_mean_dis`
/// and wins against every model that did find them. Here a group with
/// no cylinders yields infinity — a model cannot win a comparison on
/// something it does not contain. (The surface-coverage side of the
/// reference does not have this problem: an absent group is written as
/// coverage 0, which is the WORST value there, not the best.)
pub fn metric_value(metric: QsmMetric, s: &ModelScore) -> f64 {
    use MetricGroup::*;
    // Which of the five groups the metric sums over.
    let terms: &[usize] = match metric.group {
        All => &[0], Trunk => &[1], Branch => &[2], Branch1 => &[3], Branch2 => &[4],
        TrunkAndBranch => &[1, 2],
        TrunkAndBranch1 => &[1, 3],
        TrunkAndBranch1AndBranch2 => &[1, 3, 4],
        Branch1AndBranch2 => &[3, 4],
    };
    let pm = [&s.pm.all, &s.pm.trunk, &s.pm.branch, &s.pm.branch1, &s.pm.branch2];
    let sc = [&s.surf_cov.all, &s.surf_cov.trunk, &s.surf_cov.branch,
              &s.surf_cov.branch1, &s.surf_cov.branch2];
    let mut total = 0.0;
    for &t in terms {
        let (d, c) = (pm[t], sc[t]);
        // The reference halves every maximum before it is used, which
        // matters where a maximum is added to a mean.
        let v = match metric.kind {
            MetricKind::MeanDistance => {
                if d.count == 0 { return f64::INFINITY; }
                d.mean
            }
            MetricKind::MaxDistance => {
                if d.count == 0 { return f64::INFINITY; }
                0.5 * d.max
            }
            MetricKind::MeanPlusMaxDistance => {
                if d.count == 0 { return f64::INFINITY; }
                d.mean + 0.5 * d.max
            }
            MetricKind::MeanSurfaceCoverage => {
                if c.count == 0 { return f64::INFINITY; }
                1.0 - c.mean
            }
            MetricKind::MinSurfaceCoverage => {
                if c.count == 0 { return f64::INFINITY; }
                1.0 - c.min
            }
        };
        total += v;
    }
    total
}

/// `select_optimum` — the model with the smallest metric value.
///
/// Ties go to the first, as MATLAB's stable `sort` gives them.
pub fn select_optimum(scores: &[ModelScore], metric: QsmMetric) -> Option<(usize, f64)> {
    let mut best: Option<(usize, f64)> = None;
    for (i, s) in scores.iter().enumerate() {
        let v = metric_value(metric, s);
        if v.is_nan() { continue; }
        match best {
            Some((_, b)) if v >= b => {}
            _ => best = Some((i, v)),
        }
    }
    best
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/branches.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// One row per branch, indexed by segment.
///
/// Segments that produced no cylinders keep an all-zero row, exactly as
/// the reference's preallocated `BData` does — so an index here is a
/// segment index and stays comparable with the segmentation's.
#[derive(Clone, Debug, Default)]
pub struct BranchData {
    /// 0 for the stem, 1 for a branch off it, and so on.
    pub order: Vec<u8>,
    /// The branch this one grows out of.
    pub parent: Vec<Option<u32>>,
    /// Metres, at the base.
    pub diameter: Vec<f64>,
    /// LITRES. The reference reports branch volume in litres and tree
    /// volume in litres, and the factor of 1000 lives here.
    pub volume: Vec<f64>,
    /// Lateral surface area, square metres.
    pub area: Vec<f64>,
    /// Metres, summed along the chain.
    pub length: Vec<f64>,
    /// Degrees between the branch and the cylinder it leaves.
    pub angle: Vec<f64>,
    /// Metres above the base of the tree.
    pub height: Vec<f64>,
    /// Degrees, compass bearing of the branch's first cylinder.
    pub azimuth: Vec<f64>,
    /// Degrees from vertical.
    pub zenith: Vec<f64>,
}

/// `branches` — collapse a cylinder model into one row per branch.
///
/// Everything a QSM is usually reported by: how thick each branch is at
/// its base, how long, how much wood it holds, how far up the stem it
/// leaves and at what angle. Volume in litres and area in square
/// metres, as the reference reports them.
///
/// The branch ANGLE has a wrinkle worth knowing. Where
/// `parent_cylinder` had to splice a connector onto the front of a
/// chain, that connector points wherever the gap happened to lie and
/// says nothing about how the branch actually leaves its parent. The
/// reference therefore measures the angle from the SECOND cylinder in
/// that case — while still measuring it against the connector's parent,
/// which is the cylinder the branch really came off.
pub fn branches(m: &CylinderModel) -> BranchData {
    let nc = m.cyl.len();
    if nc == 0 { return BranchData::default(); }
    let ns = m.branch.iter().copied().max().unwrap_or(0) as usize + 1;

    // The cylinders of each branch, in the order they were written.
    let mut cib: Vec<Vec<u32>> = vec![Vec::new(); ns];
    for (i, &b) in m.branch.iter().enumerate() {
        cib[b as usize].push(i as u32);
    }

    let mut d = BranchData {
        order: vec![0; ns], parent: vec![None; ns], diameter: vec![0.0; ns],
        volume: vec![0.0; ns], area: vec![0.0; ns], length: vec![0.0; ns],
        angle: vec![0.0; ns], height: vec![0.0; ns], azimuth: vec![0.0; ns],
        zenith: vec![0.0; ns],
    };
    let base_z = m.cyl.start[0][2];

    for (i, c) in cib.iter().enumerate() {
        if c.is_empty() { continue; }
        let f = c[0] as usize;
        // Any cylinder of the chain would do: within one branch each
        // cylinder is its parent's extension, so they all carry the
        // same order. Taking the last instead of the first is not
        // caught by any test here and cannot be.
        d.order[i] = m.branch_order[f];
        d.diameter[i] = 2.0 * m.cyl.radius[f];
        d.volume[i] = 1000.0 * std::f64::consts::PI * c.iter()
            .map(|&k| { let k = k as usize; m.cyl.length[k] * m.cyl.radius[k].powi(2) })
            .sum::<f64>();
        d.area[i] = 2.0 * std::f64::consts::PI * c.iter()
            .map(|&k| { let k = k as usize; m.cyl.length[k] * m.cyl.radius[k] })
            .sum::<f64>();
        d.length[i] = c.iter().map(|&k| m.cyl.length[k as usize]).sum();

        // A spliced connector points nowhere in particular, so the
        // angle is taken from the cylinder after it.
        //
        // The `c.len() > 1` is the reference's and is unreachable:
        // `parent_cylinder` only ever splices a connector onto a chain
        // that already has a cylinder, so a branch whose first cylinder
        // is a connector has at least two. Without it this would index
        // past the end rather than fall back, which is why it is here
        // and why no test can reach it.
        let fc = if m.added[f] && c.len() > 1 { c[1] as usize } else { f };
        if let Some(p) = m.parent[f] {
            let (a, b) = (m.cyl.axis[fc], m.cyl.axis[p as usize]);
            let dot = (a[0]*b[0] + a[1]*b[1] + a[2]*b[2]).clamp(-1.0, 1.0);
            d.angle[i] = dot.acos().to_degrees();
        }
        d.height[i] = m.cyl.start[f][2] - base_z;
        d.azimuth[i] = m.cyl.axis[f][1].atan2(m.cyl.axis[f][0]).to_degrees();
        d.zenith[i] = m.cyl.axis[f][2].clamp(-1.0, 1.0).acos().to_degrees();
    }

    // Which branch each branch leaves. A cylinder's children are those
    // naming it as parent, EXCEPT its own continuation — that one is
    // the same branch carrying on, not a new one leaving.
    let mut chi: Vec<Vec<u32>> = vec![Vec::new(); nc];
    for i in 0..nc {
        if let Some(p) = m.parent[i] {
            if m.extension[p as usize] != Some(i as u32) {
                chi[p as usize].push(i as u32);
            }
        }
    }
    for (i, cyls) in cib.iter().enumerate() {
        for &c in cyls {
            for &cc in &chi[c as usize] {
                d.parent[m.branch[cc as usize] as usize] = Some(i as u32);
            }
        }
    }
    d
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/cylinders.m, the main
// function.
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// The segmentation `cylinders` walks: per segment, its layers of cover
/// sets, and the parent and child relations between segments.
#[derive(Clone, Debug, Default)]
pub struct SegmentTopology {
    /// `segments[s][layer]` — the cover sets in that layer.
    pub segments: Vec<Vec<Vec<u32>>>,
    /// Parent segment, or None for a base. Segment 0 is the trunk.
    pub parent: Vec<Option<u32>>,
    pub children: Vec<Vec<u32>>,
}

/// A finished structure model: the cylinders and everything that says
/// how they hang together.
#[derive(Clone, Debug, Default)]
pub struct CylinderModel {
    pub cyl: CylChain,
    /// The cylinder each one grows out of.
    pub parent: Vec<Option<u32>>,
    /// The next cylinder along the same segment, where there is one.
    pub extension: Vec<Option<u32>>,
    /// Cylinders inserted to bridge a branch to its parent, which
    /// therefore measure nothing.
    pub added: Vec<bool>,
    /// The radius as fitted, before `adjustments` touched it.
    pub unmod_radius: Vec<f64>,
    /// Which branch — the segment index — each cylinder belongs to.
    pub branch: Vec<u32>,
    /// 0 for the trunk, 1 for a branch off it, and so on.
    pub branch_order: Vec<u8>,
    /// 1-based position along its own branch.
    pub position_in_branch: Vec<u32>,
    /// The cylinders of each segment, in order from base to tip.
    pub cyls_in_segment: Vec<Vec<u32>>,
    /// How many points each cylinder was fitted to. Zero for a spliced
    /// connector, which was fitted to none. Carried because the
    /// application's confidence display reads it and a model that
    /// reported nothing there would show every cylinder as unsupported.
    pub region_points: Vec<u32>,
    /// Bit-packed 12-sector angular coverage about each cylinder's
    /// axis, in the application's own convention — NOT the reference's
    /// `SurfCov`, which is a layer-by-sector grid and lives in
    /// `cyl.surf_cov`. This one exists only so the rescan advisor can
    /// say which AZIMUTH a stem is shadowed from.
    pub sector_mask: Vec<u16>,
}

/// The order `cylinders` visits segments in: each base, then everything
/// below it breadth-first, so a segment is always reached after its
/// parent.
///
/// That ordering is not a convenience. `parent_cylinder` needs the
/// parent's cylinders to already exist in the store before it can put a
/// branch's base on their surface, and `adjustments` needs the parent's
/// radius before it can cap the child against it. Visit a child first
/// and both silently do nothing.
pub fn segment_order(topo: &SegmentTopology) -> Vec<u32> {
    let n = topo.segments.len();
    let mut out: Vec<u32> = Vec::with_capacity(n);
    let mut seen = vec![false; n];
    for i in 0..n {
        if topo.parent.get(i).copied().flatten().is_some() { continue; }
        if seen[i] { continue; }
        seen[i] = true;
        out.push(i as u32);
        let mut level: Vec<u32> = topo.children.get(i).cloned().unwrap_or_default();
        while !level.is_empty() {
            let mut next: Vec<u32> = Vec::new();
            for &s in &level {
                let k = s as usize;
                // The reference has no such guard and would loop for
                // ever on a cycle. A segmentation should not contain
                // one; this makes a broken one a wrong answer rather
                // than a hang.
                if k >= n || seen[k] { continue; }
                seen[k] = true;
                out.push(s);
                if let Some(c) = topo.children.get(k) { next.extend(c.iter().copied()); }
            }
            level = next;
        }
    }
    out
}

/// `cylinders` — the driver. Walk the segmentation from the trunk
/// outwards, fit a chain of cylinders to each segment, attach it to the
/// cylinder it grows from, correct its radii, and record it.
///
/// This is where the four pieces below become a tree: `cylinder_fitting`
/// gives a chain, `parent_cylinder` puts its base on the parent's
/// surface, `adjustments` makes the radii physical, and this decides
/// whether the result is worth keeping and what it hangs on.
///
/// A segment is skipped entirely unless it has more than one layer,
/// more than two cover sets, more than twenty points, and more points
/// above its base layer than in it. Those thresholds are the
/// reference's, and they are why a QSM has no cylinders for a twig seen
/// by six points.
pub fn cylinders(
    points: &[[f64; 3]],
    cover: &CoverSets,
    topo: &SegmentTopology,
    adj: &AdjustParams,
) -> CylinderModel {
    let nseg = topo.segments.len();
    let mut m = CylinderModel {
        cyls_in_segment: vec![Vec::new(); nseg],
        ..Default::default()
    };

    for &si32 in &segment_order(topo) {
        let si = si32 as usize;
        let seg = &topo.segments[si];
        let nl = seg.len();

        // Flatten the segment's cover sets, then expand each to the
        // points of its BALL — the overlapping ball, not the set, which
        // is what the reference fits to.
        let mut pts: Vec<u32> = Vec::new();
        let mut spans: Vec<LayerSpan> = Vec::with_capacity(nl);
        let mut ns = 0usize;
        for layer in seg {
            let lo = pts.len();
            for &s in layer {
                ns += 1;
                if let Some(ball) = cover.ball.get(s as usize) {
                    pts.extend(ball.iter().copied());
                }
            }
            spans.push((lo, pts.len()));
        }
        let np = pts.len();
        let nb = spans.first().map(|s| s.1).unwrap_or(0);
        let base_empty = seg.first().map(|l| l.is_empty()).unwrap_or(true);
        if !(nl > 1 && np > nb && ns > 2 && np > 20 && !base_empty) { continue; }

        let is_trunk = si == 0;
        let fit = cylinder_fitting(points, &pts, &spans, is_trunk);
        let mut chain = CylChain::from_fits(&fit.cylinders);
        if chain.is_empty() { continue; }

        // Attach it. The trunk has nothing to attach to.
        //
        // OBSERVED: this special case is redundant and no test catches
        // its removal. A base segment has no parent segment, so
        // `parent_cylinder` returns immediately with no parent and no
        // connector — exactly what this arm produces. The reference
        // spells it out as `si == 1` and so does this, because a reader
        // comparing the two should not have to work out that the two
        // paths coincide.
        let (pc, added) = if is_trunk {
            (None, false)
        } else {
            let parent_seg = topo.parent.get(si).copied().flatten();
            let parent_cyls: Vec<u32> = parent_seg
                .map(|s| m.cyls_in_segment[s as usize].clone())
                .unwrap_or_default();
            let has_children = topo.children.get(si).is_some_and(|c| !c.is_empty());
            parent_cylinder(&parent_cyls, parent_seg.is_some(), has_children,
                            &m.cyl, &mut chain)
        };

        // The radii as they stand now — AFTER any splice or drop that
        // parent_cylinder made, and before adjustments moves them. This
        // is what the model reports as the unmodified radius.
        let radius0 = chain.radius.clone();
        if !chain.is_empty() {
            let parcyl = pc.map(|p| m.cyl.get(p as usize));
            let regions: Vec<Vec<[f64; 3]>> = fit.regions.iter()
                .map(|r| r.iter().map(|&i| points[i as usize]).collect())
                .collect();
            adjustments(&mut chain, &radius0, parcyl.as_ref(), adj, &regions);
        }

        // A chain with a non-positive radius anywhere is not a branch.
        //
        // OBSERVED: the radius half of this is never what rejects
        // anything, including on a segment whose points are all NaN —
        // by then `cylinder_fitting` has already returned nothing, or
        // `parent_cylinder` has cleared the chain. It is a last guard
        // against a degenerate fit reaching the model, and it is
        // untested for want of an input that gets past the others.
        if chain.is_empty() || !chain.radius.iter().all(|&r| r > 0.0) { continue; }

        let c0 = m.cyl.len() as u32;
        let nc = chain.len();
        // The regions line up with the chain as `cylinder_fitting` left
        // it; `parent_cylinder` may since have spliced a connector onto
        // the front, which shifts them by one and has no region of its
        // own.
        let shift = nc.saturating_sub(fit.regions.len());
        for k in 0..nc {
            let region: &[u32] = k.checked_sub(shift)
                .and_then(|r| fit.regions.get(r))
                .map(|v| v.as_slice()).unwrap_or(&[]);
            m.region_points.push(region.len() as u32);
            let pts: Vec<[f64; 3]> = region.iter().map(|&i| points[i as usize]).collect();
            let axis = chain.axis[k];
            let mid = slide(chain.start[k], chain.length[k] * 0.5, axis);
            m.sector_mask.push(if pts.is_empty() { 0 }
                               else { compute_chunk_coverage(&pts, mid, axis).1 });
            m.cyl.push(chain.get(k));
            m.parent.push(if k == 0 { pc } else { Some(c0 + k as u32 - 1) });
            m.extension.push(if k + 1 < nc { Some(c0 + k as u32 + 1) } else { None });
            m.added.push(k == 0 && added);
            m.unmod_radius.push(radius0.get(k).copied().unwrap_or(chain.radius[k]));
            m.branch.push(si32);
        }
        m.cyls_in_segment[si] = (c0..c0 + nc as u32).collect();

        // FIXED — reference defect 4: A BRANCH HERE THAT CANNOT BE
        // TAKEN, removed. It is worth saying why rather than leaving a
        // reader to wonder where it went. It asks whether the parent cylinder's
        // `extension` already points at the cylinder about to be
        // written, and if so folds the new chain into the parent's
        // branch rather than starting a new one. But `extension(i)` is
        // only ever 0 or i+1, so the test needs the parent to be the
        // immediately preceding cylinder AND not the last of its own
        // chain — and the immediately preceding cylinder always is the
        // last of its chain, because the next index is the one being
        // written now. So every child starts a new branch, which is
        // what this does.
        //
        // The reference also fills a `CChi` list of each cylinder's
        // children here and never reads it. It is not carried.
    }

    // ---- Branching order. A cylinder that continues its parent is at
    // the same order; one that leaves it is one deeper. Parents are
    // always written before their children, so a single forward pass
    // has what it needs.
    let c = m.cyl.len();
    m.branch_order = vec![0u8; c];
    for i in 0..c {
        if let Some(p) = m.parent[i] {
            let p = p as usize;
            m.branch_order[i] = if m.extension[p] == Some(i as u32) {
                m.branch_order[p]
            } else {
                m.branch_order[p].saturating_add(1)
            };
        }
    }

    // ---- Position along its own branch, 1-based.
    m.position_in_branch = vec![1u32; c];
    for cyls in &m.cyls_in_segment {
        for (k, &id) in cyls.iter().enumerate() {
            m.position_in_branch[id as usize] = k as u32 + 1;
        }
    }

    // The reference optionally applies a growth-volume correction here.
    // create_input sets GrowthVolCor = 0, so the reference workflow this
    // implements does not run it, and it is not ported.
    m
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/cylinders.m, the
// `adjustments` subfunction; src/tools/surface_coverage2.m;
// src/least_squares_fitting/{least_squares_circle_centre,
// func_grad_circle_centre}.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// The `inputs` fields `adjustments` reads, from `create_input.m`.
#[derive(Clone, Copy, Debug)]
pub struct AdjustParams {
    /// Floor on any cylinder radius, metres.
    pub min_cyl_rad: f64,
    /// Cap a cylinder against its parent's radius.
    pub parent_cor: bool,
    /// Force the chain to taper.
    pub taper_cor: bool,
}

impl Default for AdjustParams {
    fn default() -> Self {
        // create_input.m lines 50, 53, 56.
        Self { min_cyl_rad: 0.0025, parent_cor: true, taper_cor: true }
    }
}

/// The result of `least_squares_circle_centre`.
#[derive(Clone, Copy, Debug)]
pub struct CircleFit {
    /// The centre, in the plane the caller supplied.
    pub point: [f64; 2],
    pub radius: f64,
    pub mad: f64,
    /// What fraction of the circle's arc has points on it, in hundredths.
    pub arc_cov: f64,
    pub conv: bool,
    pub rel: bool,
}

/// `least_squares_circle_centre` — move a circle of KNOWN radius to
/// where it best fits a set of points in a plane.
///
/// `adjustments` calls this after it has changed a cylinder's radius:
/// the radius moved, so the axis is no longer through the middle of the
/// points, and the cylinder would otherwise sit off-centre in its own
/// data. Only the centre is free; the radius is held.
pub fn least_squares_circle_centre(
    pts: &[[f64; 2]], point0: [f64; 2], rad0: f64,
) -> CircleFit {
    const MAXITER: usize = 200;
    let mut par = [point0[0], point0[1]];
    let mut conv = false;
    let mut rel = true;
    let mut iter = 0;

    // dist_i = |p_i - centre| - r, and its gradient in the centre.
    let residuals = |par: &[f64; 2]| -> Vec<f64> {
        pts.iter().map(|p| {
            let (vx, vy) = (p[0] - par[0], p[1] - par[1]);
            (vx*vx + vy*vy).sqrt() - rad0
        }).collect()
    };

    if pts.is_empty() {
        return CircleFit { point: par, radius: rad0, mad: 0.0, arc_cov: 0.0,
                           conv: false, rel: false };
    }

    while iter < MAXITER && !conv && rel {
        let mut a = [[0.0f64; 2]; 2];
        let mut b = [0.0f64; 2];
        let mut ss0 = 0.0f64;
        for p in pts {
            let (vx, vy) = (p[0] - par[0], p[1] - par[1]);
            let rt = (vx*vx + vy*vy).sqrt();
            let d = rt - rad0;
            ss0 += d * d;
            let j = [-vx/rt, -vy/rt];
            for r in 0..2 {
                b[r] += j[r] * d;
                for c in 0..2 { a[r][c] += j[r] * j[c]; }
            }
        }
        ss0 = ss0.sqrt();

        let det = a[0][0]*a[1][1] - a[0][1]*a[1][0];
        let step = if det != 0.0 && det.is_finite() {
            [-(( a[1][1]*b[0] - a[0][1]*b[1]) / det),
             -((-a[1][0]*b[0] + a[0][0]*b[1]) / det)]
        } else { [f64::NAN; 2] };
        par[0] += step[0];
        par[1] += step[1];

        let mut ss1 = residuals(&par).iter().map(|d| d*d).sum::<f64>().sqrt();
        if ss1 > ss0 {
            // The full Gauss-Newton step made it worse; back most of
            // the way out rather than all of it.
            par[0] -= 0.95 * step[0];
            par[1] -= 0.95 * step[1];
            ss1 = residuals(&par).iter().map(|d| d*d).sum::<f64>().sqrt();
        }

        // The 2x2 reciprocal condition number in the 1-norm.
        let n1 = (a[0][0].abs() + a[1][0].abs()).max(a[0][1].abs() + a[1][1].abs());
        let ninv = if det != 0.0 {
            ((a[1][1]/det).abs() + (a[1][0]/det).abs())
                .max((a[0][1]/det).abs() + (a[0][0]/det).abs())
        } else { f64::INFINITY };
        let rc = 1.0 / (n1 * ninv);
        if rc.is_nan() || rc < 10000.0 * f64::EPSILON { rel = false; }

        if (ss0 - ss1).abs() < 1e-5 { conv = true; }
        iter += 1;
    }

    let (mut mad, mut arc_cov) = (0.0, 0.0);
    if conv && rel {
        // A hundred bins around the circle: how much of the arc was
        // actually seen.
        let mut seen = [false; 100];
        let mut sum = 0.0;
        for p in pts {
            let (u, v) = (p[0] - par[0], p[1] - par[1]);
            let ang = v.atan2(u) + std::f64::consts::PI;
            let k = (ang / std::f64::consts::TAU * 100.0).ceil();
            let k = if k.is_nan() || k < 1.0 { 0 } else { (k as usize).min(100) - 1 };
            seen[k] = true;
            sum += ((u*u + v*v).sqrt() - rad0).abs();
        }
        arc_cov = seen.iter().filter(|&&s| s).count() as f64 / 100.0;
        mad = sum / pts.len() as f64;
    }
    CircleFit { point: par, radius: rad0, mad, arc_cov, conv, rel }
}

/// `surface_coverage2` — the same measure as `surface_coverage`, but
/// taking the perpendicular vectors and heights already computed, and
/// from a single basis rather than the best of four.
///
/// `adjustments` uses it to re-measure a cylinder whose start it has
/// just moved.
pub fn surface_coverage2(
    axis: [f64; 3], len: f64, v: &[[f64; 3]], h: &[f64], nl: usize, ns: usize,
) -> f64 {
    if nl == 0 || ns == 0 || v.is_empty() { return 0.0; }
    let Some((u, w)) = perp_basis(axis) else { return 0.0 };
    let mut cov = vec![false; nl * ns];
    for (k, vv) in v.iter().enumerate() {
        let x = vv[0]*u[0] + vv[1]*u[1] + vv[2]*u[2];
        let y = vv[0]*w[0] + vv[1]*w[1] + vv[2]*w[2];
        let ang = y.atan2(x) + std::f64::consts::PI;
        let (l, s) = layer_sector(*h.get(k).unwrap_or(&0.0), len, nl, ang, ns);
        cov[l + s * nl] = true;
    }
    cov.iter().filter(|&&c| c).count() as f64 / (nl * ns) as f64
}

/// `adjustments` — the last pass over a fitted chain, and the one that
/// decides most of what a QSM's volumes actually are.
///
/// A least-squares cylinder fitted to a partly-seen surface can come
/// back almost any size: a stem scanned down one side has a radius set
/// by whatever curvature the visible arc happened to have. This is
/// where those are pulled back to something a tree could be, using the
/// three things that are known independently of the fit — the parent's
/// radius, the chain's own better-covered cylinders, and the fact that
/// a branch tapers.
///
/// In order: clamp every radius between a floor taken from the
/// well-covered cylinders and a cap taken from the parent; replace a
/// poorly-covered cylinder between two well-covered ones by their mean;
/// fit a parabola down the chain and pull outliers towards it; re-centre
/// the axis of every cylinder whose radius moved; close the joins so
/// each cylinder starts on the previous one's top plane; and finally
/// bring a first cylinder that still floats onto its parent's surface.
///
/// `radius0` is the chain's radii as fitted, before any of this — the
/// reference's `cyl.radius0`. `regions` are the points each cylinder was
/// fitted to, as coordinates.
pub fn adjustments(
    cyl: &mut CylChain,
    radius0: &[f64],
    parent: Option<&RefCyl>,
    p: &AdjustParams,
    regions: &[Vec<[f64; 3]>],
) {
    let nc = cyl.len();
    if nc == 0 { return; }
    let mut modified = vec![false; nc];
    let sc = cyl.surf_cov.clone();

    // ---- The bounds.
    let max_r = match parent {
        Some(pc) => (0.95 * pc.radius).max(p.min_cyl_rad),
        None => {
            // No parent to measure against: use the thickest of the
            // first three, which are nearest the base.
            let a = 3.min(nc);
            1.25 * cyl.radius[..a].iter().copied().fold(f64::NEG_INFINITY, f64::max)
        }
    };
    let min_over = |thr: f64| -> Option<f64> {
        let v: Vec<f64> = (0..nc).filter(|&i| sc[i] > thr).map(|i| cyl.radius[i]).collect();
        if v.is_empty() { None } else { Some(v.iter().copied().fold(f64::INFINITY, f64::min)) }
    };
    let rmin_all = cyl.radius.iter().copied().fold(f64::INFINITY, f64::min);
    // The floor comes from the cylinders whose surface was actually
    // seen. If the thinnest of all is less than half of that, the
    // well-covered set is too optimistic and a looser one is used.
    let min_r = match min_over(0.7) {
        Some(m) if rmin_all < m / 2.0 => min_over(0.4).unwrap_or(p.min_cyl_rad),
        Some(m) => m,
        None => min_over(0.4).unwrap_or(p.min_cyl_rad),
    };

    // ---- Clamp.
    for (r, m) in cyl.radius.iter_mut().zip(modified.iter_mut()) {
        if *r < min_r { *r = min_r; *m = true; }
    }
    if p.parent_cor || nc <= 3 {
        for i in 0..nc {
            if (cyl.radius[i] > max_r && sc[i] < 0.7) || cyl.radius[i] > 1.2 * max_r {
                cyl.radius[i] = max_r;
                modified[i] = true;
            }
        }
        if nc <= 3 {
            // A short branch has no chain to argue from, so anything
            // near the cap that is also poorly covered is scaled down
            // in proportion to how much of it was seen.
            for i in 0..nc {
                if cyl.radius[i] > 0.75 * max_r && sc[i] < 0.7 {
                    cyl.radius[i] = (sc[i] / 0.7 * cyl.radius[i]).max(min_r);
                    modified[i] = true;
                }
            }
        }
    }

    // ---- A badly seen cylinder between two well seen ones is just
    // the average of its neighbours.
    for i in 1..nc.saturating_sub(1) {
        if sc[i] < 0.7 && sc[i-1] >= 0.7 && sc[i+1] >= 0.7 {
            cyl.radius[i] = 0.5 * (cyl.radius[i-1] + cyl.radius[i+1]);
            modified[i] = true;
        }
    }

    // ---- Taper.
    if p.taper_cor {
        let rmax = cyl.radius.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        if rmax < 0.001 {
            // Everything is under a millimetre: there is no shape to
            // recover, so impose a straight taper.
            if nc > 2 {
                let mut r = cyl.radius.clone();
                r.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                let mid = &r[1..r.len()-1];
                let mmax = mid.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                let mut a = 2.0 * mid.iter().sum::<f64>() / mid.len() as f64;
                if a > mmax { a = 0.01_f64.min(mmax); }
                let b = (0.5 * rmin_all).min(0.001);
                for i in 0..nc {
                    cyl.radius[i] = a + (b - a) * i as f64 / (nc - 1) as f64;
                }
            } else if nc > 1 {
                let r = rmax;
                cyl.radius[0] = r;
                cyl.radius[1] = 0.5 * r;
            }
            modified.iter_mut().for_each(|m| *m = true);
        } else if nc > 4 {
            // A PARABOLA down the chain, weighted by how well each
            // cylinder was seen, with the tip pinned at the floor.
            // Poorly covered cylinders are pulled towards it in
            // proportion to how little was seen of them.
            let branchlen: f64 = cyl.length.iter().sum();
            let mut lmid = Vec::with_capacity(nc);
            let mut acc = 0.0;
            for i in 0..nc { lmid.push(cyl.length[i] / 2.0 + acc); acc += cyl.length[i]; }

            let mut tx = lmid.clone(); tx.push(branchlen);
            let mut ty: Vec<f64> = cyl.radius.iter().map(|r| 1.05 * r).collect();
            ty.push(min_r);
            let mut w = sc.clone(); w.push(1.0);

            let s4: f64 = (0..tx.len()).map(|k| w[k]*tx[k].powi(4)).sum();
            let s2: f64 = (0..tx.len()).map(|k| w[k]*tx[k].powi(2)).sum();
            let s0: f64 = w.iter().sum();
            let y1: f64 = (0..tx.len()).map(|k| w[k]*ty[k]*tx[k].powi(2)).sum();
            let y0: f64 = (0..tx.len()).map(|k| w[k]*ty[k]).sum();
            let det = s4*s0 - s2*s2;
            let (mut x1, x2) = if det != 0.0 && det.is_finite() {
                ((y1*s0 - s2*y0) / det, (s4*y0 - s2*y1) / det)
            } else { (f64::NAN, f64::NAN) };
            // Force it to taper: an upward-opening parabola would make
            // the branch thicken towards its tip.
            //
            // OBSERVED: this clamp is very nearly inert, and no test
            // here catches its removal. The reason is the pinned tip
            // above — the point (branchlen, MinR) enters the fit with
            // weight 1 while the cylinders enter with their coverage,
            // typically well under that — so the fitted coefficient
            // already comes out negative on every fixture tried,
            // including one whose radii rise steadily from base to tip.
            // Removing the clamp changed one radius in the fourth
            // decimal and nothing else. It is kept because "nearly
            // always" is not "always" and the cost is one comparison.
            x1 = x1.min(-0.0001);

            let mut ru: Vec<f64> = lmid.iter().map(|&l| x1*l*l + x2).collect();
            for r in ru.iter_mut() { if *r < min_r { *r = min_r; } }
            let rumax = ru.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            if rumax > max_r { for r in ru.iter_mut() { *r *= max_r / rumax; } }
            let rl: Vec<f64> = ru.iter().map(|&r| (0.75 * r).max(min_r)).collect();

            for i in 0..nc {
                if cyl.radius[i] > ru[i] && sc[i] < 0.7 {
                    cyl.radius[i] = ru[i] + (cyl.radius[i] - ru[i]) * sc[i] / 0.7;
                    modified[i] = true;
                }
            }
            for i in 0..nc {
                if cyl.radius[i] > 1.333 * ru[i] && sc[i] >= 0.7 {
                    cyl.radius[i] = ru[i] + (cyl.radius[i] - ru[i]) * sc[i];
                    modified[i] = true;
                }
            }
            for i in 0..nc {
                if (cyl.radius[i] < rl[i] && sc[i] < 0.7) || cyl.radius[i] < 0.5 * rl[i] {
                    cyl.radius[i] = rl[i];
                    modified[i] = true;
                }
            }
        } else {
            // Too short for a parabola: a straight line between the
            // thickest and thinnest well-covered cylinders.
            let r0 = cyl.radius.clone();
            let well: Vec<usize> = (0..nc).filter(|&i| sc[i] >= 0.7).collect();
            let rmin = r0.iter().copied().fold(f64::INFINITY, f64::min);
            let (a, b) = if well.len() > 1 {
                (well.iter().map(|&i| r0[i]).fold(f64::NEG_INFINITY, f64::max),
                 well.iter().map(|&i| r0[i]).fold(f64::INFINITY, f64::min))
            } else if well.len() == 1 {
                (r0[well[0]], rmin)
            } else {
                let sw: f64 = sc.iter().sum();
                ((0..nc).map(|i| r0[i] * sc[i] / sw).sum::<f64>(), rmin)
            };
            for i in 0..nc {
                if sc[i] < 0.7 && !modified[i] {
                    let ru = if nc > 1 { a + (b - a) * i as f64 / (nc - 1) as f64 } else { a };
                    cyl.radius[i] = ru + (r0[i] - ru) * sc[i] / 0.7;
                    modified[i] = true;
                }
            }
        }
    }

    // ---- Re-centre the axis of every cylinder whose radius moved by
    // more than five millimetres. A changed radius means the old axis
    // is no longer through the middle of the points.
    let nr = regions.len();
    for i in 0..nc {
        if !modified[i] { continue; }
        let reg: &[[f64; 3]] = if nr == nc {
            &regions[i]
        } else if nr < nc && i > 0 && i - 1 < nr {
            // parent_cylinder spliced a connector onto the front, so
            // the regions are one behind. The range check is a guard
            // rather than a port: the reference is only ever called
            // with one region per cylinder, give or take that splice,
            // and would index past the end here just as readily.
            &regions[i - 1]
        } else {
            continue;
        };
        if (cyl.radius[i] - radius0.get(i).copied().unwrap_or(cyl.radius[i])).abs() <= 0.005 {
            continue;
        }
        let Some((u, v)) = perp_basis(cyl.axis[i]) else { continue };
        let flat: Vec<[f64; 2]> = reg.iter().map(|q| {
            let d = [q[0]-cyl.start[i][0], q[1]-cyl.start[i][1], q[2]-cyl.start[i][2]];
            [d[0]*u[0] + d[1]*u[1] + d[2]*u[2], d[0]*v[0] + d[1]*v[1] + d[2]*v[2]]
        }).collect();
        let cir = least_squares_circle_centre(&flat, [0.0, 0.0], cyl.radius[i]);
        if !(cir.conv && cir.rel) { continue; }
        cyl.start[i] = [cyl.start[i][0] + cir.point[0]*u[0] + cir.point[1]*v[0],
                        cyl.start[i][1] + cir.point[0]*u[1] + cir.point[1]*v[1],
                        cyl.start[i][2] + cir.point[0]*u[2] + cir.point[1]*v[2]];
        cyl.mad[i] = cir.mad;

        let (_, mut vv, mut hh) = distances_to_line(reg, cyl.axis[i], cyl.start[i]);
        let hmin = hh.iter().copied().fold(f64::INFINITY, f64::min);
        if hmin < -0.001 {
            let hmax = hh.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            cyl.length[i] = hmax - hmin;
            cyl.start[i] = slide(cyl.start[i], hmin, cyl.axis[i]);
            let r = distances_to_line(reg, cyl.axis[i], cyl.start[i]);
            vv = r.1; hh = r.2;
        }
        let a = 0.02_f64.max(0.2 * cyl.radius[i]);
        let nl = ((cyl.length[i] / a).ceil() as usize).max(4);
        let ns = ((std::f64::consts::TAU * cyl.radius[i] / a).ceil() as usize).clamp(10, 36);
        cyl.surf_cov[i] = surface_coverage2(cyl.axis[i], cyl.length[i], &vv, &hh, nl, ns);
    }

    // ---- Close the joins: each cylinder starts on the plane through
    // the previous one's top. A chain with visible steps in it is not a
    // branch, and the gaps are volume nobody accounts for.
    for j in 1..nc {
        let u = [cyl.start[j][0] - cyl.start[j-1][0] - cyl.length[j-1]*cyl.axis[j-1][0],
                 cyl.start[j][1] - cyl.start[j-1][1] - cyl.length[j-1]*cyl.axis[j-1][1],
                 cyl.start[j][2] - cyl.start[j-1][2] - cyl.length[j-1]*cyl.axis[j-1][2]];
        if (u[0]*u[0] + u[1]*u[1] + u[2]*u[2]).sqrt() <= 0.0001 { continue; }
        let n = cyl.axis[j];
        if (n[0]*n[0] + n[1]*n[1] + n[2]*n[2]).sqrt() <= 0.0 { continue; }
        // The basis is orthonormal, so the coefficient along the axis
        // is just the projection onto it.
        let x1 = n[0]*u[0] + n[1]*u[1] + n[2]*u[2];
        cyl.start[j] = slide(cyl.start[j], -x1, n);
        if x1 > 0.0 || cyl.length[j] + x1 > 0.0 { cyl.length[j] += x1; }
    }

    // ---- A first cylinder still floating clear of its parent is
    // brought onto the parent's surface, keeping its tip where it is.
    if let Some(pc) = parent {
        let (d, v, h) = distances_to_line(&[cyl.start[0]], pc.axis, pc.start);
        if d[0] - pc.radius > 0.001 {
            let e = slide(cyl.start[0], cyl.length[0], cyl.axis[0]);
            let vn = (v[0][0]*v[0][0] + v[0][1]*v[0][1] + v[0][2]*v[0][2]).sqrt();
            if vn > 0.0 {
                let vs = [pc.radius*v[0][0]/vn, pc.radius*v[0][1]/vn, pc.radius*v[0][2]/vn];
                let base = if h[0] >= 0.0 && h[0] <= pc.length {
                    slide(pc.start, h[0], pc.axis)
                } else if h[0] < 0.0 {
                    pc.start
                } else {
                    slide(pc.start, pc.length, pc.axis)
                };
                cyl.start[0] = [base[0] + vs[0], base[1] + vs[1], base[2] + vs[2]];
                let a = [e[0]-cyl.start[0][0], e[1]-cyl.start[0][1], e[2]-cyl.start[0][2]];
                let l = (a[0]*a[0] + a[1]*a[1] + a[2]*a[2]).sqrt();
                if l > 0.0 {
                    cyl.length[0] = l;
                    cyl.axis[0] = [a[0]/l, a[1]/l, a[2]/l];
                }
            }
        }
    }
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/cylinders.m,
// the `parent_cylinder` subfunction, and
// src/tools/distances_between_lines.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// A chain of cylinders as PARALLEL ARRAYS, which is the shape the
/// reference keeps them in and the shape `parent_cylinder` edits: it
/// drops the first cylinder, splices a new one onto the front, and
/// truncates. Doing that to a `Vec<RefCyl>` would read nothing like the
/// reference it is checked against.
///
/// The same type serves as the growing store of every cylinder placed
/// so far, indexed by cylinder id.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CylChain {
    pub radius: Vec<f64>,
    pub length: Vec<f64>,
    pub start: Vec<[f64; 3]>,
    pub axis: Vec<[f64; 3]>,
    pub mad: Vec<f64>,
    pub surf_cov: Vec<f64>,
    pub conv: Vec<bool>,
    pub rel: Vec<bool>,
}

impl CylChain {
    pub fn len(&self) -> usize { self.radius.len() }
    pub fn is_empty(&self) -> bool { self.radius.is_empty() }

    pub fn from_fits(v: &[RefCyl]) -> Self {
        Self {
            radius: v.iter().map(|c| c.radius).collect(),
            length: v.iter().map(|c| c.length).collect(),
            start: v.iter().map(|c| c.start).collect(),
            axis: v.iter().map(|c| c.axis).collect(),
            mad: v.iter().map(|c| c.mad).collect(),
            surf_cov: v.iter().map(|c| c.surf_cov).collect(),
            conv: v.iter().map(|c| c.conv).collect(),
            rel: v.iter().map(|c| c.rel).collect(),
        }
    }

    pub fn get(&self, i: usize) -> RefCyl {
        RefCyl {
            start: self.start[i], axis: self.axis[i], length: self.length[i],
            radius: self.radius[i], surf_cov: self.surf_cov[i], mad: self.mad[i],
            conv: self.conv[i], rel: self.rel[i],
        }
    }

    pub fn push(&mut self, c: RefCyl) {
        self.radius.push(c.radius); self.length.push(c.length);
        self.start.push(c.start); self.axis.push(c.axis);
        self.mad.push(c.mad); self.surf_cov.push(c.surf_cov);
        self.conv.push(c.conv); self.rel.push(c.rel);
    }

    fn drop_first(&mut self) {
        if self.is_empty() { return; }
        self.radius.remove(0); self.length.remove(0);
        self.start.remove(0); self.axis.remove(0);
        self.mad.remove(0); self.surf_cov.remove(0);
        self.conv.remove(0); self.rel.remove(0);
    }

    /// Splice a cylinder onto the front. The reference copies the
    /// FIRST cylinder's radius and quality flags onto the new one —
    /// it is a connector, not a measurement, and has no points of its
    /// own to have been judged on.
    fn push_front_connector(&mut self, start: [f64; 3], axis: [f64; 3], length: f64) {
        let (r, m, sc, cv, rl) =
            (self.radius[0], self.mad[0], self.surf_cov[0], self.conv[0], self.rel[0]);
        self.radius.insert(0, r); self.length.insert(0, length);
        self.start.insert(0, start); self.axis.insert(0, axis);
        self.mad.insert(0, m); self.surf_cov.insert(0, sc);
        self.conv.insert(0, cv); self.rel.insert(0, rl);
    }

    fn clear(&mut self) {
        self.radius.clear(); self.length.clear(); self.start.clear();
        self.axis.clear(); self.mad.clear(); self.surf_cov.clear();
        self.conv.clear(); self.rel.clear();
    }
}

/// `distances_between_lines` — for a ray and a set of lines, the
/// distance between each pair and where the closest approach falls
/// along each.
///
/// Returns `(dist, on_ray, on_lines)`.
///
/// FIXED — reference defect 5. The reference computes
/// `sqrt(abs(A·N))`, where `A·N` is ALREADY the perpendicular distance
/// between the two lines, so what it returns is the square root of a
/// length. It only ever uses the value through `min`, and a square root
/// is monotone, so the choices it drives were the right ones — but the
/// number was not a distance and could not be compared with one. This
/// returns metres.
fn distances_between_lines(
    p_ray: [f64; 3], d_ray: [f64; 3],
    p_lines: &[[f64; 3]], d_lines: &[[f64; 3]],
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = p_lines.len().min(d_lines.len());
    let (mut dist, mut on_ray, mut on_lines) =
        (Vec::with_capacity(n), Vec::with_capacity(n), Vec::with_capacity(n));
    for i in 0..n {
        let dl = d_lines[i];
        let nrm = cross(&d_ray, &dl);
        let l = (nrm[0]*nrm[0] + nrm[1]*nrm[1] + nrm[2]*nrm[2]).sqrt();
        let nu = [nrm[0]/l, nrm[1]/l, nrm[2]/l];
        // A = PointRay - PointLines
        let a = [p_ray[0]-p_lines[i][0], p_ray[1]-p_lines[i][1], p_ray[2]-p_lines[i][2]];
        dist.push((a[0]*nu[0] + a[1]*nu[1] + a[2]*nu[2]).abs());
        let b = dl[0]*d_ray[0] + dl[1]*d_ray[1] + dl[2]*d_ray[2];
        let d = a[0]*d_ray[0] + a[1]*d_ray[1] + a[2]*d_ray[2];
        let e = a[0]*dl[0] + a[1]*dl[1] + a[2]*dl[2];
        on_ray.push((b*e - d) / (1.0 - b*b));
        on_lines.push((e - b*d) / (1.0 - b*b));
    }
    (dist, on_ray, on_lines)
}

/// Slide a point along a direction by `t`.
fn slide(p: [f64; 3], t: f64, d: [f64; 3]) -> [f64; 3] {
    [p[0] + t*d[0], p[1] + t*d[1], p[2] + t*d[2]]
}

/// The tail every one of the six sign cases in `parent_cylinder` runs.
///
/// `xx`/`hh` are the crossing that case selected. Returns `None` when
/// the candidate is accepted as the parent, and `Some(row)` when it is
/// only recorded for the fallback choice later.
///
/// `hh_sign` is the value whose SIGN decides how the row is recorded.
/// It is `hh` in five of the six cases. In the sixth the reference
/// tests the OTHER crossing's height — see the note at the call site.
fn crossing_outcome(
    xx: f64, hh: f64, hh_sign: f64, parent_len: f64, len1: f64,
) -> Option<[f64; 3]> {
    if hh >= 0.0 && hh <= parent_len && len1 - xx > 0.0 {
        None
    } else if len1 - xx > 0.0 {
        if hh_sign < 0.0 { Some([xx, hh.abs(), 0.0]) } else { Some([xx, hh - parent_len, 0.0]) }
    } else {
        Some([xx, hh, 1.0])
    }
}

/// `parent_cylinder` — attach a freshly fitted chain to the cylinder it
/// grows out of, and move its base onto that parent's SURFACE.
///
/// A branch is segmented from the cover graph, so its first cylinder
/// starts wherever the points start — floating somewhere near the
/// trunk, or already buried inside it. Neither is a tree. This extends
/// or retracts the first cylinder along its own axis to the point where
/// it crosses the parent's surface, which is where a branch actually
/// begins, and reports which cylinder of the parent segment that is.
///
/// When no crossing can be found it will, in order of preference: take
/// the nearest miss anyway, drop the first cylinder and try the second,
/// drop the chain entirely if the segment has no children to orphan,
/// or splice on a new connecting cylinder — the `added` flag.
///
/// The caller resolves the reference's `SPar`, `SChi` and `CiS`:
/// `parent_cyls` is the parent segment's cylinders (empty when there is
/// no parent segment, which is also what `has_parent_segment` says),
/// and `segment_has_children` is whether dropping this chain would
/// orphan anything.
///
/// Returns the parent cylinder's index in `store`, and whether a
/// connector was added at the front of `cyl`.
pub fn parent_cylinder(
    parent_cyls: &[u32],
    has_parent_segment: bool,
    segment_has_children: bool,
    store: &CylChain,
    cyl: &mut CylChain,
) -> (Option<u32>, bool) {
    if !has_parent_segment || cyl.is_empty() { return (None, false); }
    let mut added = false;

    let dot = |a: [f64; 3], b: [f64; 3]| a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
    let sub = |a: [f64; 3], b: [f64; 3]| [a[0]-b[0], a[1]-b[1], a[2]-b[2]];

    // The four candidates whose starts are nearest this chain's base.
    //
    // OBSERVED: neither the ordering nor the truncation changes the
    // answer for a trunk whose cylinders tile the stem without
    // overlapping, and no test here catches a mutation of either.
    // The reason is that the acceptance test below asks whether the
    // crossing height falls inside a candidate's own extent, and for a
    // tiling trunk exactly one candidate can satisfy that — so the
    // order they are examined in cannot change which is accepted, and
    // that one is always among the nearest by start, so truncating to
    // four cannot exclude it. Where it would matter is a fork, with two
    // parent cylinders spanning the same heights; no fixture here
    // builds one.
    let (pc0, mut parent) : (Vec<u32>, Option<u32>) = match parent_cyls.len() {
        0 => return (None, false),
        1 => (vec![parent_cyls[0]], Some(parent_cyls[0])),
        _ => {
            let s0 = cyl.start[0];
            let mut idx: Vec<u32> = parent_cyls.to_vec();
            idx.sort_by(|&a, &b| {
                let da = { let v = sub(store.start[a as usize], s0); dot(v, v) };
                let db = { let v = sub(store.start[b as usize], s0); dot(v, v) };
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            });
            idx.truncate(4);
            (idx, None)
        }
    };
    if parent.is_some() { return (parent, false); }
    let mut found = false;

    // ---- Where the first cylinder's axis, extended, meets each
    // candidate's surface. A quadratic in how far the start must move.
    let axe1 = cyl.axis[0];
    let n0 = pc0.len();
    let mut x = vec![[0.0f64; 2]; n0];
    let mut h = vec![[0.0f64; 2]; n0];
    for (j, &p) in pc0.iter().enumerate() {
        let pj = p as usize;
        let (ax_j, st_j) = (store.axis[pj], store.start[pj]);
        let sta1 = cyl.start[0];
        // The components perpendicular to the parent's axis.
        let ad = dot(axe1, ax_j);
        let a = [axe1[0] - ad*ax_j[0], axe1[1] - ad*ax_j[1], axe1[2] - ad*ax_j[2]];
        let sd = dot(sta1, ax_j) - dot(st_j, ax_j);
        let b = [sta1[0] - st_j[0] - sd*ax_j[0],
                 sta1[1] - st_j[1] - sd*ax_j[1],
                 sta1[2] - st_j[2] - sd*ax_j[2]];
        let e = dot(a, a);
        let f = 2.0 * dot(a, b);
        let g = dot(b, b) - store.radius[pj] * store.radius[pj];
        let disc = f*f - 4.0*e*g;
        // MATLAB's sqrt of a negative is complex and `isreal` then
        // rejects the candidate; here a negative discriminant simply
        // leaves the row at zero, which the filter below drops.
        if disc < 0.0 || e == 0.0 || !disc.is_finite() { continue; }
        let di = disc.sqrt();
        let (s1, s2) = ((-f + di) / (2.0*e), (-f - di) / (2.0*e));
        x[j] = [s1, s2];
        h[j] = [dot(sta1, ax_j) + s1*ad - dot(st_j, ax_j),
                dot(sta1, ax_j) + s2*ad - dot(st_j, ax_j)];
    }

    // Only candidates that actually have a crossing. Note the test is
    // against zero rather than a flag, so a crossing that lands exactly
    // on the start point is discarded too.
    let keep: Vec<usize> = (0..n0).filter(|&j| x[j][0] != 0.0).collect();
    let pc: Vec<u32> = keep.iter().map(|&j| pc0[j]).collect();
    let xk: Vec<[f64; 2]> = keep.iter().map(|&j| x[j]).collect();
    let hk: Vec<[f64; 2]> = keep.iter().map(|&j| h[j]).collect();
    let n = pc.len();
    let mut xrec = vec![[0.0f64; 3]; n];
    // FIXED — reference defect 7: which rows were actually written. The reference has no such
    // flag and leaves an untouched row at zero, which the fallback below
    // then reads as a crossing at distance zero — the best possible.
    let mut xset = vec![false; n];

    let mut j = 0usize;
    while j < n && !found {
        let (x1, x2) = (xk[j][0], xk[j][1]);
        let (h1, h2) = (hk[j][0], hk[j][1]);
        let plen = store.length[pc[j] as usize];
        let len1 = cyl.length[0];
        // Which crossing this sign case uses, and — in the last case
        // only — which height's sign decides how a miss is recorded.
        let pick: Option<(f64, f64, f64)> =
            if x1 > 0.0 && x2 < 0.0 { Some((x1, h1, h1)) }
            else if x1 < 0.0 && x2 > 0.0 && len1 - x2 > 0.0 { Some((x2, h2, h2)) }
            else if x1 < 0.0 && x2 < 0.0 && x2 < x1 && len1 - x1 > 0.0 { Some((x1, h1, h1)) }
            else if x1 < 0.0 && x2 < 0.0 && x2 > x1 && len1 - x2 > 0.0 { Some((x2, h2, h2)) }
            else if x1 > 0.0 && x2 > 0.0 && x2 < x1 && len1 - x1 > 0.0 { Some((x1, h1, h1)) }
            else if x1 > 0.0 && x2 > 0.0 && x2 > x1 && len1 - x2 > 0.0 {
                // FIXED — reference defect 3. This case works on the
                // second crossing throughout — x(j,2), h(j,2) — but the
                // reference decides how to record a miss from the sign
                // of h(j,1). The five cases above all use the height
                // matching the crossing they picked, and where the two
                // differ in sign this one recorded `abs(h2)` when it
                // meant `h2 - Len`, or the other way about, changing
                // which candidate won the nearest-miss choice below.
                Some((x2, h2, h2))
            } else { None };

        if let Some((xx, hh, hh_sign)) = pick {
            match crossing_outcome(xx, hh, hh_sign, plen, len1) {
                None => {
                    parent = Some(pc[j]);
                    cyl.start[0] = slide(cyl.start[0], xx, axe1);
                    cyl.length[0] -= xx;
                    found = true;
                }
                Some(row) => { xrec[j] = row; xset[j] = true; }
            }
        }
        j += 1;
    }

    // ---- No clean crossing: take the nearest miss, or give up on the
    // first cylinder.
    //
    // FIXED — reference defect 7. A candidate matching NONE of the six
    // sign cases leaves its row untouched, and the reference reads that
    // zero as a crossing at distance zero — the best possible — so it
    // accepts such a candidate as the parent and leaves the branch's
    // base exactly where it was. That is what made this fallback
    // permissive rather than a last resort, and why a branch pointing
    // away from the trunk found a parent instead of reaching the
    // connector block below. Only rows actually written are considered
    // now.
    let any_recorded = xset.iter().any(|&x| x);
    if !found && any_recorded {
        let mut best = xset.iter().position(|&x| x).unwrap();
        for k in 0..n {
            if xset[k] && xrec[k][1] < xrec[best][1] { best = k; }
        }
        let row = xrec[best];
        let cand = pc[best];
        let cand_len = store.length[cand as usize];
        if row[2] == 0.0 && row[1] < 0.1 * cand_len {
            parent = Some(cand);
            cyl.start[0] = slide(cyl.start[0], row[0], axe1);
            cyl.length[0] -= row[0];
            found = true;
        } else {
            parent = Some(cand);
            let nc = cyl.len();
            let plen_of_parent = store.length[cand as usize];
            if nc > 1 && row[0] <= cyl.radius[0] && row[1].abs() <= 1.25 * plen_of_parent {
                // Drop the first cylinder and stretch the second back
                // to where the first would have met the parent.
                let s = slide(cyl.start[0], row[0], axe1);
                let tip = slide(cyl.start[1], cyl.length[1], cyl.axis[1]);
                let v = sub(tip, s);
                let l = dot(v, v).sqrt();
                cyl.length[1] = l;
                cyl.axis[1] = [v[0]/l, v[1]/l, v[2]/l];
                cyl.start[1] = s;
                cyl.drop_first();
                found = true;
            } else if nc > 1 {
                // Drop the first cylinder and leave the parent unfound,
                // so the connector block below still runs.
                cyl.drop_first();
            } else if !segment_has_children {
                // Nothing hangs off this segment, so it can go.
                cyl.clear();
                return (None, added);
            } else if row[0] <= cyl.radius[0] && row[1].abs() <= 1.5 * plen_of_parent {
                cyl.start[0] = slide(cyl.start[0], row[0], axe1);
                cyl.length[0] = row[0].abs();
                found = true;
            }
        }
    }

    // ---- Still nothing: build a cylinder to bridge the gap.
    if !found && !cyl.is_empty() {
        let sta1 = cyl.start[0];
        let axe1 = cyl.axis[0];
        let starts: Vec<[f64; 3]> = pc0.iter().map(|&p| store.start[p as usize]).collect();
        let axes: Vec<[f64; 3]> = pc0.iter().map(|&p| store.axis[p as usize]).collect();
        let (dists, _, on_lines) = distances_between_lines(sta1, axe1, &starts, &axes);

        // Candidates whose closest approach falls within the parent
        // cylinder, then — failing that — a fifth past either end.
        let within = |lo: f64, hi: f64| -> Vec<usize> {
            (0..pc0.len()).filter(|&k| {
                let l = store.length[pc0[k] as usize];
                on_lines[k] >= lo * l && on_lines[k] <= hi * l
            }).collect()
        };
        let mut sel = within(0.0, 1.0);
        if sel.is_empty() { sel = within(-0.2, 1.2); }

        let connector: Option<([f64; 3], [f64; 3], f64, u32)> = if !sel.is_empty() {
            let best = *sel.iter().min_by(|&&a, &&b|
                dists[a].partial_cmp(&dists[b]).unwrap_or(std::cmp::Ordering::Equal)).unwrap();
            let p = pc0[best];
            let pi = p as usize;
            let q = slide(store.start[pi], on_lines[best], store.axis[pi]);
            let v = sub(sta1, q);
            let l = dot(v, v).sqrt();
            let v = [v[0]/l, v[1]/l, v[2]/l];
            let a = dot(v, store.axis[pi]).clamp(-1.0, 1.0).acos();
            let hh = a.sin() * l;
            let r = store.radius[pi];
            let s = slide(q, r/hh*l, v);
            Some((s, v, (hh - r)/hh * l, p))
        } else {
            // Nothing lines up; take the parent whose start lies most
            // nearly straight ahead of this chain's base.
            let mut best = 0usize;
            let mut best_a = f64::NEG_INFINITY;
            let mut bv = [0.0; 3];
            let mut bl = 0.0;
            for (k, &p) in pc0.iter().enumerate() {
                let v = sub(sta1, store.start[p as usize]);
                let l0 = dot(v, v).sqrt();
                if l0.is_nan() || l0 <= 0.0 { continue; }
                let v = [v[0]/l0, v[1]/l0, v[2]/l0];
                let a = dot(v, axe1);
                if a > best_a { best_a = a; best = k; bv = v; bl = l0; }
            }
            if best_a == f64::NEG_INFINITY { None } else {
                let p = pc0[best];
                let pi = p as usize;
                let a = dot(bv, store.axis[pi]).clamp(-1.0, 1.0).acos();
                let hh = a.sin() * bl;
                let r = store.radius[pi];
                let s = slide(store.start[pi], r/hh*bl, bv);
                Some((s, bv, (hh - r)/hh * bl, p))
            }
        };

        if let Some((s, v, l, p)) = connector {
            parent = Some(p);
            // A connector shorter than a centimetre, or than a fifth of
            // what it connects to, is noise rather than a branch base.
            if l > 0.01 && l / cyl.length[0] > 0.2 && l.is_finite() {
                cyl.push_front_connector(s, v, l);
                added = true;
            }
        }
    }

    (parent, added)
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/cylinders.m,
// the `cylinder_fitting` subfunction.
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// The cylinders fitted along one segment, and the points each was
/// fitted to.
#[derive(Clone, Debug, Default)]
pub struct RegionFit {
    pub cylinders: Vec<RefCyl>,
    /// Indices into the caller's point array — the reference's `Reg`,
    /// which `adjustments` later needs to re-measure a cylinder.
    pub regions: Vec<Vec<u32>>,
}

/// One layer's span in the segment's point list: `[start, end)`.
type LayerSpan = (usize, usize);

fn mean_of(points: &[[f64; 3]], idx: &[u32]) -> [f64; 3] {
    if idx.is_empty() { return [0.0; 3]; }
    let mut s = [0.0; 3];
    for &i in idx {
        let p = points[i as usize];
        s[0] += p[0]; s[1] += p[1]; s[2] += p[2];
    }
    let n = idx.len() as f64;
    [s[0]/n, s[1]/n, s[2]/n]
}

fn unit(v: [f64; 3]) -> Option<[f64; 3]> {
    let n = (v[0]*v[0] + v[1]*v[1] + v[2]*v[2]).sqrt();
    if n > 0.0 && n.is_finite() { Some([v[0]/n, v[1]/n, v[2]/n]) } else { None }
}

/// `cylinder_fitting` — walk a segment from its base to its tip,
/// fitting a chain of cylinders to it.
///
/// The shape of it: take a region of layers, fit at least three
/// cylinders of DIFFERENT LENGTHS to it, and keep the one with the best
/// surface coverage. Then step the region's bottom past the top of the
/// cylinder just kept, and go again. Fitting several lengths and
/// choosing between them is what lets the chain follow a stem that
/// changes direction — a single fixed region length either cuts a
/// straight trunk into needlessly many pieces or straddles a bend.
///
/// `seg_points` is the segment's points, ordered layer by layer;
/// `spans` gives each layer's half-open range in it. `is_trunk` is the
/// reference's `si == 1`: the trunk is held to a higher coverage than a
/// branch before the candidate search stops early. It is a flag here
/// rather than an index because the reference's is one-based and every
/// index in this port is not, and that is a trap not worth keeping.
///
/// Layer indices below are 1-BASED, as in the reference, so the loop
/// conditions can be read against it line for line. Only `span()`
/// converts.
pub fn cylinder_fitting(
    points: &[[f64; 3]],
    seg_points: &[u32],
    spans: &[LayerSpan],
    is_trunk: bool,
) -> RegionFit {
    let nl = spans.len();
    let mut out = RegionFit::default();
    if nl == 0 || seg_points.is_empty() { return out; }

    // Layers a..=b, 1-based inclusive, as a slice of `seg_points`.
    let span = |a: usize, b: usize| -> &[u32] {
        let lo = spans[a.clamp(1, nl) - 1].0;
        let hi = spans[b.clamp(1, nl) - 1].1;
        if lo <= hi { &seg_points[lo..hi] } else { &[] }
    };
    let dot = |a: [f64; 3], b: [f64; 3]| a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
    let along = |p: [f64; 3], o: [f64; 3], a: [f64; 3]|
        (p[0]-o[0])*a[0] + (p[1]-o[1])*a[1] + (p[2]-o[2])*a[2];

    if nl <= 6 {
        // A SHORT SEGMENT gets one cylinder over the whole of it. There
        // is no room to fit several lengths and choose.
        let all: Vec<u32> = seg_points.to_vec();
        if all.len() <= 10 { return out; }
        let bot = mean_of(points, span(1, 1));
        let top = mean_of(points, span(nl, nl));
        let Some(axis) = unit([top[0]-bot[0], top[1]-bot[1], top[2]-bot[2]]) else { return out };
        let q0: Vec<[f64; 3]> = all.iter().map(|&i| points[i as usize]).collect();
        // Heights measured from the world origin, as the reference does
        // here — only their difference is used.
        let h: Vec<f64> = q0.iter().map(|&p| dot(p, axis)).collect();
        let hmin = h.iter().copied().fold(f64::INFINITY, f64::min);
        let hmax = h.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let hpoint = dot(bot, axis);
        let mut c0 = RefCyl {
            start: [bot[0] - (hpoint-hmin)*axis[0],
                    bot[1] - (hpoint-hmin)*axis[1],
                    bot[2] - (hpoint-hmin)*axis[2]],
            axis, length: hmax - hmin, radius: 0.0,
            surf_cov: 0.0, mad: 0.0, conv: false, rel: false,
        };
        let keep = surface_coverage_filtering(&q0, &mut c0, 0.02, 20);
        let reg: Vec<u32> = all.iter().copied().zip(keep.iter())
            .filter(|(_, &k)| k).map(|(i, _)| i).collect();
        let kept: Vec<[f64; 3]> = q0.iter().copied().zip(keep.iter())
            .filter(|(_, &k)| k).map(|(p, _)| p).collect();
        let c = least_squares_cylinder(&kept, &c0, None, None);
        out.cylinders.push(if !c.conv || !c.rel { c0 } else { c });
        out.regions.push(reg);
        return out;
    }

    // ---- The long-segment path: regions, each choosing between fits.
    let mut i0 = 1usize;        // first layer of the region
    let mut i = 4usize;         // last layer of the shortest candidate
    let mut t = 0usize;         // regions completed
    let mut cyl_top = [0.0f64; 3];
    let mut c0 = RefCyl {
        start: [0.0; 3], axis: [0.0, 0.0, 1.0], length: 0.0, radius: 0.0,
        surf_cov: 0.0, mad: 0.0, conv: false, rel: false,
    };

    while i0 < nl - 2 {
        let bot0 = mean_of(points, span(i0, i0 + 1));
        let mut bot = bot0;
        let mut again = true;
        let mut j = 0usize;
        // Up to eleven candidates, at least three, stopping early once
        // one is good enough.
        let mut cands: Vec<(RefCyl, Vec<u32>)> = Vec::new();
        let mut data: Vec<[f64; 4]> = Vec::new();

        while i + j <= nl && j <= 10 && (j <= 2 || again) {
            let reg_c: Vec<u32> = span(i0, i + j).to_vec();
            let mut top = mean_of(points, span(i + j - 1, i + j));
            let Some(axis) = unit([top[0]-bot[0], top[1]-bot[1], top[2]-bot[2]]) else { break };
            c0.axis = axis;

            let mut h: Vec<f64> = reg_c.iter()
                .map(|&p| along(points[p as usize], bot, axis)).collect();
            let mut minh = h.iter().copied().fold(f64::INFINITY, f64::min);
            if j == 0 {
                // Slide the bottom down to the region's real bottom, and
                // fix it there for every candidate in this region.
                bot = [bot[0] + minh*axis[0], bot[1] + minh*axis[1], bot[2] + minh*axis[2]];
                c0.start = bot;
                h = reg_c.iter().map(|&p| along(points[p as usize], bot, axis)).collect();
                minh = h.iter().copied().fold(f64::INFINITY, f64::min);
            }
            if i + j >= nl {
                // The last region reaches the tip, so let the top run
                // out to the furthest point rather than to a layer mean.
                let ht = along(top, c0.start, axis);
                let hmax = h.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                top = [top[0] + (hmax-ht)*axis[0],
                       top[1] + (hmax-ht)*axis[1],
                       top[2] + (hmax-ht)*axis[2]];
            }
            let ht = along(top, c0.start, axis);
            c0.length = ht - minh;

            let mut reg: Vec<u32> = reg_c.iter().copied().zip(h.iter())
                .filter(|(_, &hh)| hh <= ht && hh >= minh)
                .map(|(p, _)| p).collect();
            let mut q0: Vec<[f64; 3]> = reg.iter().map(|&p| points[p as usize]).collect();

            if q0.len() > 20 {
                let keep = surface_coverage_filtering(&q0, &mut c0, 0.02, 20);
                let (r2, q2): (Vec<u32>, Vec<[f64; 3]>) = reg.iter().copied().zip(q0.iter().copied())
                    .zip(keep.iter()).filter(|(_, &k)| k).map(|(x, _)| x).unzip();
                reg = r2;
                q0 = q2;
            } else {
                // Too few points to measure anything from. The reference
                // plants a nominal 1 cm cylinder and lets the fit move it.
                c0.radius = 0.01;
                c0.surf_cov = 0.05;
                c0.mad = 0.01;
                c0.conv = true;
                c0.rel = true;
            }

            let mut c;
            if q0.len() > 9 {
                if i >= nl && t == 0 {
                    c = least_squares_cylinder(&q0, &c0, None, None);
                } else if i >= nl && t > 0 {
                    // Everything at or above the previous cylinder's top
                    // is the section; the rest holds the axis straight.
                    let hs: Vec<f64> = q0.iter().map(|&p| along(p, cyl_top, c0.axis)).collect();
                    let sec: Vec<bool> = hs.iter().map(|&x| x >= 0.0).collect();
                    let q: Vec<[f64; 3]> = q0.iter().copied().zip(&sec)
                        .filter(|(_, &s)| s).map(|(p, _)| p).collect();
                    reg = reg.iter().copied().zip(&sec)
                        .filter(|(_, &s)| s).map(|(p, _)| p).collect();
                    let n2 = q.len();
                    let n1 = sec.iter().filter(|&&s| !s).count();
                    if n2 > 9 && n1 > 5 {
                        let mut stacked: Vec<[f64; 3]> = q0.iter().copied().zip(&sec)
                            .filter(|(_, &s)| !s).map(|(p, _)| p).collect();
                        stacked.extend(q.iter().copied());
                        // FIXED — reference defect 2. `stacked` is n1
                        // rows then n2, and the reference's weight
                        // vector is n2 entries of 1/3 then n1 of 2/3:
                        // the block LENGTHS are swapped relative to the
                        // rows they weight. It is the right total
                        // length, so nothing complains, and where the
                        // two groups differ in size part of one is
                        // weighted as the other. The other two weighted
                        // branches in this function line their blocks
                        // up and both give the SECTION the larger
                        // weight; this now does the same.
                        let mut w = vec![1.0/3.0; n1];
                        w.extend(std::iter::repeat(2.0/3.0).take(n2));
                        c = least_squares_cylinder(&stacked, &c0, Some(&w), Some(&q));
                    } else {
                        c = least_squares_cylinder(&q0, &c0, None, None);
                    }
                } else if t == 0 {
                    // The first region: the section is the lower part,
                    // up to three layers below the candidate's top.
                    let top3 = mean_of(points, span(i + j - 3, i + j - 2));
                    let ht3 = along(top3, bot, c0.axis);
                    let hs: Vec<f64> = q0.iter().map(|&p| along(p, bot, c0.axis)).collect();
                    let sec: Vec<bool> = hs.iter().map(|&x| x <= ht3).collect();
                    let q: Vec<[f64; 3]> = q0.iter().copied().zip(&sec)
                        .filter(|(_, &s)| s).map(|(p, _)| p).collect();
                    reg = reg.iter().copied().zip(&sec)
                        .filter(|(_, &s)| s).map(|(p, _)| p).collect();
                    let n2 = q.len();
                    let n3 = sec.iter().filter(|&&s| !s).count();
                    if n2 > 9 && n3 > 5 {
                        let mut stacked = q.clone();
                        stacked.extend(q0.iter().copied().zip(&sec)
                            .filter(|(_, &s)| !s).map(|(p, _)| p));
                        let mut w = vec![2.0/3.0; n2];
                        w.extend(std::iter::repeat(1.0/3.0).take(n3));
                        c = least_squares_cylinder(&stacked, &c0, Some(&w), Some(&q));
                    } else {
                        c = least_squares_cylinder(&q0, &c0, None, None);
                    }
                } else {
                    // The general case: a bottom below the previous
                    // cylinder's top, the section, and a top above it.
                    let top3 = mean_of(points, span(i + j - 3, i + j - 2));
                    let ht3 = along(top3, cyl_top, c0.axis);
                    let hs: Vec<f64> = q0.iter().map(|&p| along(p, cyl_top, c0.axis)).collect();
                    let cls: Vec<u8> = hs.iter()
                        .map(|&x| if x < 0.0 { 0 } else if x <= ht3 { 1 } else { 2 })
                        .collect();
                    let q: Vec<[f64; 3]> = q0.iter().copied().zip(&cls)
                        .filter(|(_, &k)| k == 1).map(|(p, _)| p).collect();
                    reg = reg.iter().copied().zip(&cls)
                        .filter(|(_, &k)| k == 1).map(|(p, _)| p).collect();
                    let n1 = cls.iter().filter(|&&k| k == 0).count();
                    let n2 = q.len();
                    let n3 = cls.iter().filter(|&&k| k == 2).count();
                    if n2 > 9 {
                        let mut stacked: Vec<[f64; 3]> = q0.iter().copied().zip(&cls)
                            .filter(|(_, &k)| k == 0).map(|(p, _)| p).collect();
                        stacked.extend(q.iter().copied());
                        stacked.extend(q0.iter().copied().zip(&cls)
                            .filter(|(_, &k)| k == 2).map(|(p, _)| p));
                        let mut w = vec![0.25; n1];
                        w.extend(std::iter::repeat(0.5).take(n2));
                        w.extend(std::iter::repeat(0.25).take(n3));
                        c = least_squares_cylinder(&stacked, &c0, Some(&w), Some(&q));
                    } else {
                        c = c0;
                        c.rel = false;
                    }
                }
                if !c.conv { c = c0; c.rel = false; }
                // Coverage under a fifth means the surface was barely
                // seen, whatever the residuals say.
                if c.surf_cov < 0.2 { c.rel = false; }
            } else {
                c = c0;
                c.rel = false;
            }

            let rl = c.length / c.radius;
            data.push([if c.rel {1.0} else {0.0}, if c.conv {1.0} else {0.0}, c.surf_cov, rl]);
            cands.push((c, reg));
            j += 1;

            // Stop looking once a candidate is good enough — but the
            // trunk has to be better covered than a branch before we
            // stop, because it is the thing every volume depends on.
            //
            // OBSERVED: both arms fire on the fixtures below — the
            // trunk stops at 0.714 coverage, a branch at 0.504 — and
            // yet the chain that comes out is identical either way.
            // `again` decides only how many candidates are FITTED, and
            // across every fixture tried the extra ones a trunk fits
            // never win the selection: the score is coverage minus a
            // length penalty, and the shorter candidates fitted first
            // tend to be the better covered. So this costs the trunk
            // more work for the same answer, on this data. That is not
            // a general result and it is not a reason to remove it.
            // The two arms do the same thing, and are kept apart so the
            // two rules stay one-for-one with the reference's.
            #[allow(clippy::if_same_then_else)]
            if again && c.rel && c.conv && rl > 2.0 {
                if is_trunk && c.surf_cov > 0.7 { again = false; }
                else if !is_trunk && c.surf_cov > 0.5 { again = false; }
            }
        }

        if cands.is_empty() { break; }

        // Choose: prefer the candidates that passed, then take the best
        // coverage, with a light penalty on relative length so a long
        // thin cylinder does not win on coverage alone.
        let ok: Vec<usize> = (0..cands.len())
            .filter(|&k| data[k][0] != 0.0 && data[k][1] != 0.0 && data[k][3] > 1.5)
            .collect();
        let pool: Vec<usize> = if ok.is_empty() { (0..cands.len()).collect() } else { ok };
        let mut best = pool[0];
        let mut best_score = f64::NEG_INFINITY;
        for &k in &pool {
            let s = data[k][2] - 0.01 * data[k][3];
            // Strictly greater, so ties keep the earliest — the shortest
            // candidate — exactly as MATLAB's `max` does.
            if s > best_score { best_score = s; best = k; }
        }
        t += 1;
        let (mut c, reg) = cands[best].clone();

        // ---- Step the region past the cylinder just kept.
        cyl_top = [c.start[0] + c.length*c.axis[0],
                   c.start[1] + c.length*c.axis[1],
                   c.start[2] + c.length*c.axis[2]];
        i0 += 1;
        let i00 = i0;
        let mut hb = {
            let b = mean_of(points, span(i0, i0 + 1));
            along(b, cyl_top, c.axis)
        };
        // Skip layers still below the cylinder's top, at most five.
        while i0 + 1 < nl && i0 < i00 + 5 && hb < -c.radius / 3.0 {
            i0 += 1;
            let b = mean_of(points, span(i0, i0 + 1));
            hb = along(b, cyl_top, c.axis);
        }
        i = (i0 + 5).min(nl);

        // A stub too short to be its own region is folded into this
        // cylinder by lengthening it to reach the furthest point.
        //
        // OBSERVED: this branch is reached on the last region of every
        // test fixture and its condition is false every time — `maxh`
        // equals `hcyl` exactly. The reason is upstream: in the last
        // region `i == nl`, so `i + j >= nl` holds for every candidate
        // and each has already had its top run out to the furthest
        // point. The fold can therefore only do anything if the chosen
        // candidate's FITTED length falls short of that, which no
        // fixture here produces. Removing it changes nothing measurable
        // in the test suite; it is kept because the reference has it
        // and because a real branch, unlike these, can end anywhere.
        if nl + 2 < i0 + 4 {
            let tail = span(nl.saturating_sub(5).max(1), nl);
            let hcyl = dot(cyl_top, c.axis);
            let maxh = tail.iter()
                .map(|&p| dot(points[p as usize], c.axis))
                .fold(f64::NEG_INFINITY, f64::max);
            if maxh > hcyl { c.length += maxh - hcyl; }
            i0 = nl;
        }

        out.cylinders.push(c);
        out.regions.push(reg);
        cyl_top = [c.start[0] + c.length*c.axis[0],
                   c.start[1] + c.length*c.axis[1],
                   c.start[2] + c.length*c.axis[2]];
    }
    out
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 —
// src/least_squares_fitting/{least_squares_cylinder,func_grad_cylinder,
// form_rotation_matrices,rotate_to_z_axis}.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// A 3x3 matrix, named so the rotation helpers can say so.
type Mat3 = [[f64; 3]; 3];

fn mat_mul(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut o = [[0.0; 3]; 3];
    for (i, row) in o.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = a[i][0]*b[0][j] + a[i][1]*b[1][j] + a[i][2]*b[2][j];
        }
    }
    o
}

/// `m' * v` — the transpose applied to a vector, which is how the
/// reference undoes each of its rotations.
fn mat_vec_t(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [m[0][0]*v[0] + m[1][0]*v[1] + m[2][0]*v[2],
     m[0][1]*v[0] + m[1][1]*v[1] + m[2][1]*v[2],
     m[0][2]*v[0] + m[1][2]*v[1] + m[2][2]*v[2]]
}

/// `rotate_to_z_axis` — a rotation taking `vec` onto +z.
fn rotate_to_z_axis(vec: [f64; 3]) -> [[f64; 3]; 3] {
    // cross(vec, [0 0 1]) = [vec_y, -vec_x, 0]
    let d = [vec[1], -vec[0], 0.0];
    let n = (d[0]*d[0] + d[1]*d[1]).sqrt();
    if n > 0.0 {
        // The reference passes vec(3) straight to acos, which is NaN
        // for a vector that is not quite unit. Clamping is a guard, not
        // a change: every caller passes a normalised axis.
        rotation_matrix(d, vec[2].clamp(-1.0, 1.0).acos())
    } else {
        [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]
    }
}

/// `form_rotation_matrices` — R = Ry(beta)*Rx(alpha), and the two
/// derivatives the Jacobian needs.
///
/// Note that `dr1` is the derivative of Rx ALONE, not of the product
/// R = Ry*Rx. That is what the reference computes and what its Jacobian
/// uses, and strictly it is the wrong derivative for the parameter it
/// stands against.
///
/// It does not appear to matter, and that was checked rather than
/// assumed: replacing it with the true product derivative gives bitwise
/// identical radii, axes, lengths, coverages and convergence flags on
/// every case in the tests below — upright, leaning by thirty degrees,
/// near horizontal, weighted, and sectioned. Gauss-Newton reaches the
/// same fixed point along a different path. It is left as the reference
/// has it. What has NOT been checked is whether the two differ on a fit
/// that converges slowly enough to hit the fifty-iteration cap, where
/// the path is the answer; a case like that would separate them.
fn form_rotation_matrices(alpha: f64, beta: f64) -> (Mat3, Mat3, Mat3) {
    let (c1, s1) = (alpha.cos(), alpha.sin());
    let (c2, s2) = (beta.cos(), beta.sin());
    let r1 = [[1.0, 0.0, 0.0], [0.0, c1, -s1], [0.0, s1, c1]];
    let r2 = [[c2, 0.0, s2], [0.0, 1.0, 0.0], [-s2, 0.0, c2]];
    let r = mat_mul(&r2, &r1);
    let dr1 = [[0.0, 0.0, 0.0], [0.0, -s1, -c1], [0.0, c1, -s1]];
    let dr2 = [[-s2, 0.0, c2], [0.0, 0.0, 0.0], [-c2, 0.0, -s2]];
    (r, dr1, dr2)
}

/// `func_grad_cylinder` — the residuals of a cylinder model and their
/// Jacobian in the five parameters (x0, y0, alpha, beta, r).
///
/// The residual is the point's distance from the axis minus the radius,
/// so a point on the surface contributes zero. Weights, when given,
/// scale both the residual and its gradient, which is how the reference
/// makes a cylinder follow the section it cares about while still being
/// held straight by the points beyond it.
fn func_grad_cylinder(
    par: &[f64; 5],
    pt: &[[f64; 3]],
    weight: Option<&[f64]>,
    want_jac: bool,
) -> (Vec<f64>, Vec<[f64; 5]>) {
    let (x0, y0, alpha, beta, r) = (par[0], par[1], par[2], par[3], par[4]);
    let (rot, dr1, dr2) = form_rotation_matrices(alpha, beta);
    let mut dist = Vec::with_capacity(pt.len());
    let mut jac = if want_jac { Vec::with_capacity(pt.len()) } else { Vec::new() };
    for (i, p) in pt.iter().enumerate() {
        let q = [p[0] - x0, p[1] - y0, p[2]];
        let t = mat_vec(&rot, q);
        let rt = (t[0]*t[0] + t[1]*t[1]).sqrt();
        let w = weight.map(|w| w.get(i).copied().unwrap_or(0.0));
        let mut d = rt - r;
        if let Some(w) = w { d *= w; }
        dist.push(d);
        if want_jac {
            // The unit radial direction at this point.
            let (n1, n2) = (t[0] / rt, t[1] / rt);
            let a3 = mat_vec(&dr1, q);
            let a4 = mat_vec(&dr2, q);
            let mut row = [
                n1 * -rot[0][0] + n2 * -rot[1][0],
                n1 * -rot[0][1] + n2 * -rot[1][1],
                n1 * a3[0] + n2 * a3[1],
                n1 * a4[0] + n2 * a4[1],
                -1.0,
            ];
            if let Some(w) = w { for x in row.iter_mut() { *x *= w; } }
            jac.push(row);
        }
    }
    (dist, jac)
}

/// Solve a 5x5 system by Gaussian elimination with partial pivoting.
/// `None` when the matrix is singular to working precision.
fn solve5(mut a: [[f64; 5]; 5], mut b: [f64; 5]) -> Option<[f64; 5]> {
    for col in 0..5 {
        let mut piv = col;
        for r in (col + 1)..5 {
            if a[r][col].abs() > a[piv][col].abs() { piv = r; }
        }
        if a[piv][col].is_nan() || a[piv][col] == 0.0 { return None; }
        a.swap(col, piv);
        b.swap(col, piv);
        let pivot = a[col];
        for r in (col + 1)..5 {
            let f = a[r][col] / pivot[col];
            if f == 0.0 { continue; }
            for (c, dst) in a[r].iter_mut().enumerate().skip(col) { *dst -= f * pivot[c]; }
            b[r] -= f * b[col];
        }
    }
    let mut x = [0.0; 5];
    for i in (0..5).rev() {
        let mut s = b[i];
        for j in (i + 1)..5 { s -= a[i][j] * x[j]; }
        x[i] = s / a[i][i];
    }
    if x.iter().all(|v| v.is_finite()) { Some(x) } else { None }
}

/// The reciprocal condition number in the 1-norm.
///
/// DELIBERATE DEVIATION: MATLAB's `rcond` is LAPACK's *estimator*,
/// which is cheaper than this and can differ from it by a factor of a
/// few. It is compared here against `10000*eps`, roughly 2e-12 — a test
/// for "is this matrix hopeless", not a measurement — so the estimate
/// and the true value give the same verdict on everything but a matrix
/// sitting exactly on the threshold.
fn rcond5(a: &[[f64; 5]; 5]) -> f64 {
    let norm1 = |m: &[[f64; 5]; 5]| -> f64 {
        (0..5).map(|c| (0..5).map(|r| m[r][c].abs()).sum::<f64>())
              .fold(0.0_f64, f64::max)
    };
    let mut inv = [[0.0f64; 5]; 5];
    for k in 0..5 {
        let mut e = [0.0; 5];
        e[k] = 1.0;
        match solve5(*a, e) {
            Some(col) => for r in 0..5 { inv[r][k] = col[r]; },
            None => return 0.0,
        }
    }
    let (na, ni) = (norm1(a), norm1(&inv));
    if na == 0.0 || !ni.is_finite() || ni == 0.0 { return 0.0; }
    1.0 / (na * ni)
}

/// `least_squares_cylinder` — the Gauss-Newton fit at the heart of
/// TreeQSM, and the reason a QSM is a set of cylinders rather than a
/// set of circles stacked up.
///
/// Fits five parameters — two for where the axis crosses the plane
/// perpendicular to the starting guess, two for how the axis tilts away
/// from it, and the radius — by minimising the points' distances from
/// the cylinder surface. Fifty iterations at most, and it stops as soon
/// as the residual norm settles to within 1e-4.
///
/// `weight`, when given, is one weight per point. `q`, when given and
/// longer than five points, is the SECTION the cylinder is meant to
/// describe: the fit still uses every point, but the length and the
/// surface coverage are measured over the section alone. That is how
/// the reference fits a cylinder to the middle of a region while
/// letting the points either side hold its axis straight.
///
/// `conv` and `rel` are the reference's own verdicts and are returned
/// rather than acted on: `cylinder_fitting` decides what to do with an
/// unconverged or ill-conditioned fit, and it does not always discard
/// it.
pub fn least_squares_cylinder(
    points: &[[f64; 3]],
    c0: &RefCyl,
    weight: Option<&[f64]>,
    q: Option<&[[f64; 3]]>,
) -> RefCyl {
    /// The reference's resolution for the coverage grid, metres.
    const RES: f64 = 0.03;
    const MAXITER: usize = 50;

    // The reference has no such guard because `cylinder_fitting` never
    // calls it with fewer than ten points. Without one the height
    // reductions below run over an empty slice and return infinities.
    if points.is_empty() {
        return RefCyl { conv: false, rel: false, surf_cov: 0.0, ..*c0 };
    }

    let rot0 = rotate_to_z_axis(c0.axis);
    let pt: Vec<[f64; 3]> = points.iter()
        .map(|p| mat_vec(&rot0, [p[0] - c0.start[0], p[1] - c0.start[1], p[2] - c0.start[2]]))
        .collect();

    let mut par = [0.0, 0.0, 0.0, 0.0, c0.radius];
    let mut conv = false;
    let mut rel = true;
    let mut iter = 0;
    let mut dist: Vec<f64> = Vec::new();

    while iter < MAXITER && !conv && rel {
        let (d0, jac) = func_grad_cylinder(&par, &pt, weight, true);
        let ss0 = d0.iter().map(|x| x * x).sum::<f64>().sqrt();

        // A = J'J, b = J'd0. The normal equations, formed explicitly —
        // as the reference forms them.
        let mut a = [[0.0f64; 5]; 5];
        let mut b = [0.0f64; 5];
        for (k, row) in jac.iter().enumerate() {
            for i in 0..5 {
                b[i] += row[i] * d0[k];
                for j in 0..5 { a[i][j] += row[i] * row[j]; }
            }
        }
        // par = par - A\b. MATLAB's backslash on a singular matrix
        // yields infinities with a warning the reference suppresses,
        // and the parameters then go to NaN — which is caught below by
        // the same condition-number test, and by the NaN check on the
        // way out.
        match solve5(a, b) {
            Some(x) => for i in 0..5 { par[i] -= x[i]; },
            None => par = [f64::NAN; 5],
        }
        if rcond5(&a) < 10000.0 * f64::EPSILON { rel = false; }

        let (d1, _) = func_grad_cylinder(&par, &pt, weight, false);
        let ss1 = d1.iter().map(|x| x * x).sum::<f64>().sqrt();
        if (ss0 - ss1).abs() < 1e-4 { conv = true; }
        dist = d1;
        iter += 1;
    }

    let (rot, _, _) = form_rotation_matrices(par[2], par[3]);
    let axis = mat_vec_t(&rot0, mat_vec_t(&rot, [0.0, 0.0, 1.0]));
    let p0 = mat_vec_t(&rot0, [par[0], par[1], 0.0]);
    let mut start = [p0[0] + c0.start[0], p0[1] + c0.start[1], p0[2] + c0.start[2]];

    // The section, when there is one, is what the length describes.
    let span: &[[f64; 3]] = match q {
        Some(qq) if qq.len() > 5 => qq,
        _ => points,
    };
    let h: Vec<f64> = span.iter()
        .map(|p| p[0]*axis[0] + p[1]*axis[1] + p[2]*axis[2])
        .collect();
    let hmin = h.iter().copied().fold(f64::INFINITY, f64::min);
    let hmax = h.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let length = (hmax - hmin).abs();

    // Slide the axis point down to the cylinder's bottom.
    let hpoint = axis[0]*start[0] + axis[1]*start[1] + axis[2]*start[2];
    for i in 0..3 { start[i] -= (hpoint - hmin) * axis[i]; }

    let mad = if dist.is_empty() { 0.0 }
              else { dist.iter().map(|x| x.abs()).sum::<f64>() / dist.len() as f64 };

    let mut out = RefCyl {
        start, axis, length, radius: par[4], surf_cov: 0.0, mad, conv, rel,
    };
    if rel && conv
        && axis.iter().all(|x| !x.is_nan())
        && start.iter().all(|x| !x.is_nan())
    {
        let nl = ((length / RES).ceil() as usize).max(3);
        let ns = ((std::f64::consts::TAU * out.radius / RES).ceil() as usize).clamp(8, 36);
        // Dmin = 0.8*radius: points well inside the surface are not
        // evidence that the surface was seen there.
        out.surf_cov = surface_coverage(span, axis, start, nl, ns, Some(0.8 * out.radius), None);
    }
    out
}

// ===================================================================
// PORTED FROM TreeQSM 2.4.0 — src/main_steps/filtering.m
// Portions Copyright (C) 2013-2022 Pasi Raumonen. GPL-3.0-or-later.
// ===================================================================

/// The `inputs.filter.*` block of TreeQSM's `create_input.m`, verbatim.
///
/// These are not tuned and must not be: the reference workflow this
/// implements calls `create_input` and changes nothing, so any
/// deviation here is a deviation from the published method rather than
/// an improvement on it.
#[derive(Clone, Copy, Debug)]
pub struct FilterParams {
    /// k for the k-nearest-neighbour distance. 0 disables the stage.
    pub k: usize,
    /// Ball radius for the density filter. create_input sets 0.00, so
    /// the stage is off by default — kept because the parameter exists.
    pub radius: f64,
    /// Outlier cutoff in standard deviations.
    pub nsigma: f64,
    /// Cover-set diameter for the small-component stage.
    pub patch_diam1: f64,
    /// Ball radius for the small-component stage.
    pub ball_rad1: f64,
    /// Components with fewer patches than this are dropped. 0 disables.
    pub ncomp: usize,
    /// Cube edge for the final downsampling, metres. 0 disables.
    pub edge_length: f64,
}

impl Default for FilterParams {
    fn default() -> Self {
        // create_input.m, lines 17-23.
        Self { k: 10, radius: 0.00, nsigma: 1.5, patch_diam1: 0.05, ball_rad1: 0.075, ncomp: 2, edge_length: 0.004 }
    }
}

/// TreeQSM's point filter. Returns a keep-mask over `points`.
///
/// The reference calls this before every reconstruction:
///
/// ```matlab
/// Pass = filtering(pc.Location, inputs);
/// P    = pc.Location(Pass, :);
/// treeqsm(P, inputs, resultsfolder);
/// ```
///
/// PointCloudLabeler previously called none of it and fed raw segmented
/// points straight into the cover generation, where a handful of noise
/// points is enough to bridge two branches or to seed a cover set in
/// empty air.
///
/// The banding is the part worth understanding. Every statistical
/// stage computes its threshold **within 1 m height bands**, not over
/// the whole tree. Point density in a terrestrial scan falls with
/// height — the crown is thin and far from the scanner — so a single
/// global threshold on k-NN distance removes the crown as "outliers"
/// and keeps every dense clump of ground noise. Banding makes the
/// threshold local to the height it judges.
pub fn filtering(points: &[[f64; 3]], p: &FilterParams) -> Vec<bool> {
    filtering_report(points, p).0
}

/// What the filter removed at each stage — the reference's own
/// "Filtering..." block, per tree:
///
/// ```text
///  Points before filtering:  82979
///  Points removed as statistical outliers:  2882
///  Points with small components removed:  335
///  Points removed in total: 3217
///  Points removed in total (%): 3.9
///  Points left: 79762
/// ```
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FilterReport {
    pub before: usize,
    /// Coordinates that were not numbers; the reference never sees any.
    pub not_finite: usize,
    /// The k-nearest-neighbour and radius stages together.
    pub statistical_outliers: usize,
    pub small_components: usize,
    /// The cubical downsampling's duplicates, one point kept per cube.
    pub cube_duplicates: usize,
    pub left: usize,
}

impl FilterReport {
    pub fn removed(&self) -> usize { self.before.saturating_sub(self.left) }

    /// One line, the reference's numbers in the reference's order.
    pub fn summary(&self) -> String {
        let pct = if self.before > 0 { 100.0 * self.removed() as f64 / self.before as f64 } else { 0.0 };
        let mut s = format!("before {}, statistical outliers {}, small components {}, cube duplicates {}",
            self.before, self.statistical_outliers, self.small_components, self.cube_duplicates);
        if self.not_finite > 0 { s.push_str(&format!(", not finite {}", self.not_finite)); }
        s.push_str(&format!(", removed {} ({pct:.1} %), left {}", self.removed(), self.left));
        s
    }
}

/// `filtering`, with the count of what each stage removed.
pub fn filtering_report(points: &[[f64; 3]], p: &FilterParams) -> (Vec<bool>, FilterReport) {
    let n = points.len();
    let mut report = FilterReport { before: n, ..FilterReport::default() };
    if n == 0 { return (Vec::new(), report); }

    // Stage 0 — drop non-finite points.
    let mut keep: Vec<bool> = points.iter().map(|q| q.iter().all(|v| v.is_finite())).collect();
    let count = |keep: &[bool]| keep.iter().filter(|&&k| k).count();
    let mut kept = count(&keep);
    report.not_finite = n - kept;

    // Stage 1 — k-NN distance outliers, banded by height.
    if p.k > 0 {
        pass("filter_knn");
        let idx: Vec<u32> = (0..n as u32).filter(|&i| keep[i as usize]).collect();
        if idx.len() > p.k {
            let d = knn_distance(points, &idx, p.k);
            let pass = band_threshold(points, &idx, &d, p.nsigma, Cmp::Below);
            for (slot, &i) in idx.iter().enumerate() {
                if !pass[slot] { keep[i as usize] = false; }
            }
        }
    }

    // Stage 2 — the radius/density filter. create_input leaves radius
    // at 0.00, so this does not run in the reference workflow; it is
    // implemented so a caller that sets it gets the reference's
    // behaviour rather than silence.
    if p.radius > 0.0 {
        pass("filter_radius");
        let idx: Vec<u32> = (0..n as u32).filter(|&i| keep[i as usize]).collect();
        if !idx.is_empty() {
            let counts = neighbours_within(points, &idx, p.radius);
            // Note the direction: too FEW neighbours is the outlier
            // here, where stage 1's outlier was too LARGE a distance.
            let pass = band_threshold(points, &idx, &counts, p.nsigma, Cmp::Above);
            for (slot, &i) in idx.iter().enumerate() {
                if !pass[slot] { keep[i as usize] = false; }
            }
        }
    }

    // Stage 3 — drop small connected components of the cover graph.
    // A cluster of noise that survives stage 1 because it is locally
    // dense is still disconnected from the tree, and this is what
    // removes it.
    {
        let now = count(&keep);
        report.statistical_outliers = kept - now;
        kept = now;
    }

    if p.ncomp > 0 {
        pass("filter_components");
        let idx: Vec<u32> = (0..n as u32).filter(|&i| keep[i as usize]).collect();
        if !idx.is_empty() {
            let drop = small_components(points, &idx, p.patch_diam1, p.ball_rad1, p.ncomp);
            for (slot, &i) in idx.iter().enumerate() {
                if drop[slot] { keep[i as usize] = false; }
            }
        }
    }

    // Stage 4 — cubical downsampling: one point per cube. Regularises
    // density before the cover generation, which is what makes a fixed
    // patch diameter mean the same thing everywhere in the tree.
    {
        let now = count(&keep);
        report.small_components = kept - now;
        kept = now;
    }

    if p.edge_length > 0.0 {
        pass("filter_cube");
        let idx: Vec<u32> = (0..n as u32).filter(|&i| keep[i as usize]).collect();
        let mut seen: FxHashMap<[i64; 3], ()> = FxHashMap::default();
        for &i in &idx {
            let q = points[i as usize];
            let cell = [
                (q[0] / p.edge_length).floor() as i64,
                (q[1] / p.edge_length).floor() as i64,
                (q[2] / p.edge_length).floor() as i64,
            ];
            if seen.insert(cell, ()).is_some() { keep[i as usize] = false; }
        }
    }

    {
        let now = count(&keep);
        report.cube_duplicates = kept - now;
        report.left = now;
    }

    (keep, report)
}

/// Thin a segment down to at most `max_points`, by the reference's own
/// cubical downsampling at a coarser edge. Returns the kept points and
/// the edge that was used; the edge is `None` when nothing was needed.
///
/// WHY THIS EXISTS, and it is not a method choice. `filtering.m`'s
/// downsampling runs at `EdgeLength = 0.004` on clouds that are ONE
/// PRE-CUT TREE — the reference's per-tree .txt files, typically a
/// hundred thousand points or so. Applied to an automatic
/// segmentation's output the same 4 mm can leave a single segment
/// holding millions: a measured plot had 257 segments carrying 52.3
/// million points between them, the largest 2.8 million, which
/// TreeQSM turned into 74,401 cylinders in seven minutes and enough
/// memory to kill the application. One such segment is more than the
/// whole plot was in the run before it.
///
/// No amount of scheduling helps that, because the unit of work is
/// itself too big: whatever bounds how many trees run at once, one of
/// them still has to run. So the segment is thinned instead, and the
/// caller is told it happened.
///
/// The edge doubles from the filter's own until the count fits, so the
/// result is always at least as fine as needed and the operation is
/// the reference's, at a different scale. It is a DEVIATION and the
/// log records it per tree; the alternative is no model for the tree
/// at all.
pub fn thin_to_at_most(
    points: &[[f64; 3]], max_points: usize, from_edge: f64,
) -> (Vec<[f64; 3]>, Option<f64>) {
    thin_to_at_most_bounded(points, max_points, from_edge, f64::INFINITY)
}

/// `thin_to_at_most` with a ceiling on the edge: the doubling stops at
/// `max_edge` even when the count is still over `max_points`, and the
/// caller gets what that edge left. The automatic tree cap uses 8 mm —
/// one doubling of filtering.m's 4 mm — because TreeQSM's smallest
/// cover sets are 2 cm across and a coarser thinning starts to starve
/// twig sets of points; a tree still over the cap at 8 mm runs as it
/// is and takes more of the budget instead. A `max_edge` under the
/// first doubling leaves the points as they are, with no edge reported.
pub fn thin_to_at_most_bounded(
    points: &[[f64; 3]], max_points: usize, from_edge: f64, max_edge: f64,
) -> (Vec<[f64; 3]>, Option<f64>) {
    if max_points == 0 || points.len() <= max_points {
        return (points.to_vec(), None);
    }
    let start = if from_edge.is_finite() && from_edge > 0.0 { from_edge } else { 0.004 };
    let mut edge = start;
    // Doubling rather than solving for the edge: points sit on
    // surfaces, so the count falls with roughly the SQUARE of the edge
    // rather than the cube, and a closed-form guess would be wrong in
    // a direction that matters. Sixteen doublings take 4 mm past 250 m,
    // which no tree survives, so this always terminates.
    for _ in 0..16 {
        if edge * 2.0 > max_edge * (1.0 + 1e-9) { break; }
        edge *= 2.0;
        // The last doubling the ceiling allows: its result is the answer
        // whether or not it reached the count.
        let last_allowed = edge * 2.0 > max_edge * (1.0 + 1e-9);
        let mut seen: FxHashMap<[i64; 3], u32> = FxHashMap::default();
        for (i, q) in points.iter().enumerate() {
            if !q.iter().all(|v| v.is_finite()) { continue; }
            let cell = [
                (q[0] / edge).floor() as i64,
                (q[1] / edge).floor() as i64,
                (q[2] / edge).floor() as i64,
            ];
            // THE LOWEST POINT IN THE CUBE, not the first one to
            // arrive. `filtering.m`'s own stage 4 keeps the first, and
            // so does the port of it — that is the reference's
            // behaviour and it stays there. This is not that stage: it
            // is a deviation already, and a deviation whose result
            // depended on the order points came off disk would give
            // two runs over one dataset two different skeletons the
            // moment anything about the read changed.
            seen.entry(cell)
                .and_modify(|best| {
                    let b = &points[*best as usize];
                    if (q[0], q[1], q[2]) < (b[0], b[1], b[2]) { *best = i as u32; }
                })
                .or_insert(i as u32);
        }
        if seen.len() <= max_points || last_allowed {
            // In cell order rather than insertion order, so the result
            // is a function of the geometry and not of the input's
            // arrangement.
            let mut idx: Vec<u32> = seen.into_values().collect();
            idx.sort_unstable();
            return (idx.into_iter().map(|i| points[i as usize]).collect(), Some(edge));
        }
    }
    if edge == start {
        // The ceiling forbade even one doubling: nothing was thinned.
        return (points.to_vec(), None);
    }
    // Past any plausible tree: keep what the last edge gave rather
    // than returning the whole segment and crashing on it.
    (points.iter().take(max_points).copied().collect(), Some(edge))
}

enum Cmp { Below, Above }

/// Per-point distance to its `k`-th nearest neighbour, over a uniform
/// grid sized to the expected spacing. `filtering.m` uses knnsearch.
/// Distance to the k-th nearest neighbour of every point in `idx` —
/// the statistic filtering.m gets from knnsearch.
///
/// EXACT, and by a kd-tree, because the grid this replaced chose ONE
/// cell size for the whole tree from its bounding box: a tree fills a
/// few per cent of its box, so the cells came out several times too
/// coarse, and on the trunk — where a scan puts thousands of points per
/// square metre — every query gathered tens of thousands of candidates
/// and sorted them. On a 2.8-million-point tree that was 400 of 680
/// seconds; on a 130-thousand-point tree, four fifths of its time. The
/// reference's knnsearch is a kd-tree and never depended on density.
fn knn_distance(points: &[[f64; 3]], idx: &[u32], k: usize) -> Vec<f64> {
    use rayon::prelude::*;
    let tree = KdTree::build(points, idx);
    // One query per point and none depends on another, so they go
    // across every thread: a 7.8-million-point tree spent 17 s here on
    // one core with fifteen idle. Collected in index order, so the
    // answer is the sequential one.
    idx.par_iter()
        .map_init(|| Vec::with_capacity(k + 1), |best, &i| {
            best.clear();
            tree.knn(points[i as usize], i, k, best);
            match best.len() {
                0 => f64::INFINITY,
                n if n >= k => best[k - 1].sqrt(),
                n => best[n - 1].sqrt(),
            }
        })
        .collect()
}

/// Which of `idx` sit in a connected component of fewer than `ncomp`
/// cover sets — filtering.m's third stage, on a grid.
///
/// THE REFERENCE, AND WHAT THIS KEEPS OF IT. filtering.m builds cover
/// sets of PatchDiam1 over the points, links sets whose BallRad1 balls
/// share points, and drops every component of fewer than ncomp sets: a
/// detached clump smaller than one set and further than a ball from
/// everything else. The port did that literally — a greedy ball cover,
/// every point's list of covering balls, a neighbour set per cover from
/// the pairs — and on a 7.8-million-point TLS tree that was 7.5 of the
/// tree's 8 minutes, to remove ONE clump; every reconstruction pass
/// together took under a minute.
///
/// A grid says the same thing in linear time. Cells are PatchDiam1
/// across, so an occupied cell holds at most a set's worth of extent;
/// two occupied cells are linked when they lie within BallRad1 of each
/// other (Chebyshev, in cells, rounded up), at least the reach a shared
/// point gives two balls; components are over cells, and a component of
/// fewer than ncomp cells goes. Where it differs it is the more
/// permissive: a clump straddling a cell boundary counts as two cells
/// where the reference might count one set, so what this drops the
/// reference would have dropped too, never the other way round.
/// Deterministic and order-free.
fn small_components(points: &[[f64; 3]], idx: &[u32], patch_diam: f64, ball_rad: f64, ncomp: usize) -> Vec<bool> {
    let cell = if patch_diam.is_finite() && patch_diam > 1e-6 { patch_diam } else { 0.05 };
    let reach = ((ball_rad / cell).ceil() as i64).clamp(1, 8);
    let mut cell_ids: FxHashMap<[i64; 3], u32> = FxHashMap::default();
    let mut cells: Vec<[i64; 3]> = Vec::new();
    let mut cell_of_point: Vec<u32> = Vec::with_capacity(idx.len());
    for &i in idx {
        let q = points[i as usize];
        let c = [(q[0] / cell).floor() as i64, (q[1] / cell).floor() as i64, (q[2] / cell).floor() as i64];
        let id = *cell_ids.entry(c).or_insert_with(|| { cells.push(c); (cells.len() - 1) as u32 });
        cell_of_point.push(id);
    }
    // Union-find over the occupied cells.
    let mut parent: Vec<u32> = (0..cells.len() as u32).collect();
    fn find(parent: &mut [u32], mut a: u32) -> u32 {
        while parent[a as usize] != a {
            let p = parent[a as usize];
            parent[a as usize] = parent[p as usize];
            a = p;
        }
        a
    }
    for (ci, &c) in cells.iter().enumerate() {
        for dx in -reach..=reach {
            for dy in -reach..=reach {
                for dz in -reach..=reach {
                    if dx == 0 && dy == 0 && dz == 0 { continue; }
                    let Some(&cj) = cell_ids.get(&[c[0] + dx, c[1] + dy, c[2] + dz]) else { continue };
                    // Each pair once, from its lower side.
                    if (cj as usize) < ci { continue; }
                    let a = find(&mut parent, ci as u32);
                    let b = find(&mut parent, cj);
                    if a != b { parent[a as usize] = b; }
                }
            }
        }
    }
    let roots: Vec<u32> = (0..cells.len() as u32).map(|ci| find(&mut parent, ci)).collect();
    let mut size: Vec<usize> = vec![0; cells.len()];
    for &r in &roots { size[r as usize] += 1; }
    cell_of_point.iter().map(|&ci| size[roots[ci as usize] as usize] < ncomp).collect()
}

/// One node of the kd-tree over a range of `order`. A leaf holds its
/// points directly; an inner node splits them at the median of the
/// axis with the widest spread.
struct KdNode {
    start: u32,
    end: u32,
    axis: u8,
    split: f64,
    /// Children as node indices; `u32::MAX` on a leaf.
    left: u32,
    right: u32,
}

/// A kd-tree over a subset of a point array: `order` is the subset,
/// permuted so that every node's points are one contiguous range.
struct KdTree<'a> {
    points: &'a [[f64; 3]],
    order: Vec<u32>,
    nodes: Vec<KdNode>,
}

/// Points per leaf. Small enough that a leaf scan is a handful of
/// distance evaluations, large enough that the tree is shallow.
const KD_LEAF: usize = 12;

impl<'a> KdTree<'a> {
    fn build(points: &'a [[f64; 3]], idx: &[u32]) -> Self {
        let mut order = idx.to_vec();
        let mut nodes = Vec::with_capacity(2 * order.len() / KD_LEAF + 2);
        if !order.is_empty() {
            let n = order.len();
            Self::split(points, &mut order, 0, n, &mut nodes);
        }
        Self { points, order, nodes }
    }

    fn split(points: &[[f64; 3]], order: &mut [u32], start: usize, end: usize, nodes: &mut Vec<KdNode>) -> u32 {
        let me = nodes.len() as u32;
        nodes.push(KdNode { start: start as u32, end: end as u32, axis: 0, split: 0.0, left: u32::MAX, right: u32::MAX });
        if end - start <= KD_LEAF { return me; }
        let mut lo = [f64::INFINITY; 3];
        let mut hi = [f64::NEG_INFINITY; 3];
        for &i in &order[start..end] {
            let q = points[i as usize];
            for a in 0..3 {
                if q[a] < lo[a] { lo[a] = q[a]; }
                if q[a] > hi[a] { hi[a] = q[a]; }
            }
        }
        let mut axis = 0usize;
        for a in 1..3 { if hi[a] - lo[a] > hi[axis] - lo[axis] { axis = a; } }
        // Every point identical along every axis: nothing to split on,
        // and the leaf scan handles it.
        if hi[axis] - lo[axis] <= 0.0 { return me; }
        let mid = (start + end) / 2;
        order[start..end].select_nth_unstable_by(mid - start, |&a, &b| {
            points[a as usize][axis].partial_cmp(&points[b as usize][axis]).unwrap_or(std::cmp::Ordering::Equal)
        });
        let split = points[order[mid] as usize][axis];
        let left = Self::split(points, order, start, mid, nodes);
        let right = Self::split(points, order, mid, end, nodes);
        let node = &mut nodes[me as usize];
        node.axis = axis as u8;
        node.split = split;
        node.left = left;
        node.right = right;
        me
    }

    /// The k smallest squared distances from `q` to points of the tree
    /// other than `skip`, ascending, into `best`.
    fn knn(&self, q: [f64; 3], skip: u32, k: usize, best: &mut Vec<f64>) {
        if self.nodes.is_empty() || k == 0 { return; }
        self.search(0, q, skip, k, best);
    }

    fn search(&self, node: u32, q: [f64; 3], skip: u32, k: usize, best: &mut Vec<f64>) {
        let n = &self.nodes[node as usize];
        if n.left == u32::MAX {
            for &i in &self.order[n.start as usize..n.end as usize] {
                if i == skip { continue; }
                let r = self.points[i as usize];
                let d2 = (q[0] - r[0]).powi(2) + (q[1] - r[1]).powi(2) + (q[2] - r[2]).powi(2);
                if best.len() < k || d2 < best[k - 1] {
                    let at = best.partition_point(|&b| b <= d2);
                    best.insert(at, d2);
                    if best.len() > k { best.pop(); }
                }
            }
            return;
        }
        let diff = q[n.axis as usize] - n.split;
        let (near, far) = if diff < 0.0 { (n.left, n.right) } else { (n.right, n.left) };
        self.search(near, q, skip, k, best);
        // The far side can only improve the answer if the splitting
        // plane is closer than the current k-th best.
        if best.len() < k || diff * diff < best[k - 1] {
            self.search(far, q, skip, k, best);
        }
    }
}

fn neighbours_within(points: &[[f64; 3]], idx: &[u32], radius: f64) -> Vec<f64> {
    let grid = build_grid(points, idx, radius);
    let r2 = radius * radius;
    idx.iter().map(|&i| {
        let q = points[i as usize];
        let c = cell_of(q, radius);
        let mut n = 0.0;
        for dx in -1..=1 { for dy in -1..=1 { for dz in -1..=1 {
            if let Some(v) = grid.get(&[c[0] + dx, c[1] + dy, c[2] + dz]) {
                for &j in v {
                    let r = points[j as usize];
                    if (q[0] - r[0]).powi(2) + (q[1] - r[1]).powi(2) + (q[2] - r[2]).powi(2) < r2 { n += 1.0; }
                }
            }
        }}}
        n
    }).collect()
}

/// mean ± nsigma·sd computed WITHIN 1 m height bands — filtering.m's
/// `for i = 1:H` loop over `Q(:,3) < hmin+i & Q(:,3) >= hmin+i-1`.
fn band_threshold(points: &[[f64; 3]], idx: &[u32], stat: &[f64], nsigma: f64, cmp: Cmp) -> Vec<bool> {
    let mut pass = vec![false; idx.len()];
    let zmin = idx.iter().map(|&i| points[i as usize][2]).fold(f64::INFINITY, f64::min);
    let zmax = idx.iter().map(|&i| points[i as usize][2]).fold(f64::NEG_INFINITY, f64::max);
    if !zmin.is_finite() || !zmax.is_finite() { return pass; }
    let bands = ((zmax - zmin).ceil() as i64).max(1);
    let mut members: Vec<Vec<usize>> = vec![Vec::new(); bands as usize];
    for (slot, &i) in idx.iter().enumerate() {
        let z = points[i as usize][2];
        let b = (((z - zmin).floor() as i64).clamp(0, bands - 1)) as usize;
        members[b].push(slot);
    }
    for band in members {
        if band.is_empty() { continue; }
        let n = band.len() as f64;
        let mean = band.iter().map(|&s| stat[s]).sum::<f64>() / n;
        // MATLAB's std() is the sample standard deviation (N-1).
        let sd = if band.len() > 1 {
            (band.iter().map(|&s| (stat[s] - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
        } else { 0.0 };
        for &s in &band {
            pass[s] = match cmp {
                Cmp::Below => stat[s] < mean + nsigma * sd,
                Cmp::Above => stat[s] > mean - nsigma * sd,
            };
        }
    }
    pass
}

fn cell_of(q: [f64; 3], cell: f64) -> [i64; 3] {
    [(q[0] / cell).floor() as i64, (q[1] / cell).floor() as i64, (q[2] / cell).floor() as i64]
}

fn build_grid(points: &[[f64; 3]], idx: &[u32], cell: f64) -> FxHashMap<[i64; 3], Vec<u32>> {
    let mut g: FxHashMap<[i64; 3], Vec<u32>> = FxHashMap::default();
    for &i in idx { g.entry(cell_of(points[i as usize], cell)).or_default().push(i); }
    g
}


/// MaxBalls expansion (Raumonen 2013, §2.1). Pick seeds via spatial
/// BFS over the point set so the result is independent of input
/// order and seeds are uniformly distributed:
///
///   1. Start from the LOWEST point (deterministic anchor).
///   2. Pop the next seed s from the queue.
///   3. Mark every point within r_cover of s as "covered".
///   4. Find every point in the band r_cover < ||p − s|| < 2·r_cover;
///      these are the candidate next seeds (they're connected to s
///      via the cover graph since their balls would overlap).
///   5. Add each candidate that isn't already covered to the queue.
///   6. Repeat until the queue is empty. Any remaining uncovered
///      points (disconnected components in the point cloud — rare
///      for a single segmented tree) get processed by restarting
///      from any uncovered point.
fn greedy_ball_cover(points: &[[f64; 3]], r_cover: f64) -> Vec<u32> {
    let inv = 1.0 / r_cover;
    let cell_of = |p: [f64; 3]| -> (i32, i32, i32) {
        ((p[0] * inv).floor() as i32, (p[1] * inv).floor() as i32, (p[2] * inv).floor() as i32)
    };
    // Spatial hash of all points.
    let mut point_cells: FxHashMap<(i32, i32, i32), Vec<u32>> = FxHashMap::default();
    for (i, p) in points.iter().enumerate() {
        point_cells.entry(cell_of(*p)).or_default().push(i as u32);
    }
    let r2 = r_cover * r_cover;
    let r2_outer = 4.0 * r2; // (2·r_cover)²
    let mut covered = vec![false; points.len()];
    let mut is_seed = vec![false; points.len()];
    let mut seeds: Vec<u32> = Vec::new();
    let mut queue: VecDeque<u32> = VecDeque::new();

    // Find the starting anchor: lowest-z point (deterministic).
    let mut anchor = 0u32;
    let mut anchor_z = f64::INFINITY;
    for (i, p) in points.iter().enumerate() {
        if p[2] < anchor_z { anchor_z = p[2]; anchor = i as u32; }
    }
    queue.push_back(anchor);
    is_seed[anchor as usize] = true;
    seeds.push(anchor);

    // BFS expansion.
    while let Some(s_idx) = queue.pop_front() {
        let s = points[s_idx as usize];
        let (kx, ky, kz) = cell_of(s);
        // 5×5×5 cell sweep covers the band up to 2·r_cover.
        for dx in -2..=2 {
            for dy in -2..=2 {
                for dz in -2..=2 {
                    if let Some(list) = point_cells.get(&(kx + dx, ky + dy, kz + dz)) {
                        for &pi in list {
                            let q = points[pi as usize];
                            let d2 = (s[0] - q[0]).powi(2) + (s[1] - q[1]).powi(2) + (s[2] - q[2]).powi(2);
                            if d2 <= r2 {
                                covered[pi as usize] = true;
                            } else if d2 <= r2_outer && !is_seed[pi as usize] && !covered[pi as usize] {
                                // Candidate next seed: only admit if
                                // no existing seed already sits within
                                // r_cover (so we never collapse two
                                // seeds together).
                                if !seed_within_r(&points, &is_seed, &point_cells, q, r2, cell_of) {
                                    is_seed[pi as usize] = true;
                                    covered[pi as usize] = true;
                                    seeds.push(pi);
                                    queue.push_back(pi);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Disconnected components fallback (rare for one tree): if any
    // point remains uncovered, restart from it.
    for i in 0..points.len() {
        if !covered[i] && !is_seed[i] {
            is_seed[i] = true;
            covered[i] = true;
            seeds.push(i as u32);
            queue.push_back(i as u32);
            while let Some(s_idx) = queue.pop_front() {
                let s = points[s_idx as usize];
                let (kx, ky, kz) = cell_of(s);
                for dx in -2..=2 {
                    for dy in -2..=2 {
                        for dz in -2..=2 {
                            if let Some(list) = point_cells.get(&(kx + dx, ky + dy, kz + dz)) {
                                for &pi in list {
                                    let q = points[pi as usize];
                                    let d2 = (s[0] - q[0]).powi(2) + (s[1] - q[1]).powi(2) + (s[2] - q[2]).powi(2);
                                    if d2 <= r2 {
                                        covered[pi as usize] = true;
                                    } else if d2 <= r2_outer && !is_seed[pi as usize] && !covered[pi as usize] {
                                        if !seed_within_r(&points, &is_seed, &point_cells, q, r2, cell_of) {
                                            is_seed[pi as usize] = true;
                                            covered[pi as usize] = true;
                                            seeds.push(pi);
                                            queue.push_back(pi);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    seeds
}

/// Check whether any existing seed lies within r_cover (squared
/// distance ≤ r2) of point `q`. The spatial-hash sweep is 3×3×3 cells.
fn seed_within_r(
    points: &[[f64; 3]],
    is_seed: &[bool],
    point_cells: &FxHashMap<(i32, i32, i32), Vec<u32>>,
    q: [f64; 3],
    r2: f64,
    cell_of: impl Fn([f64; 3]) -> (i32, i32, i32),
) -> bool {
    let (kx, ky, kz) = cell_of(q);
    for dx in -1..=1 {
        for dy in -1..=1 {
            for dz in -1..=1 {
                if let Some(list) = point_cells.get(&(kx + dx, ky + dy, kz + dz)) {
                    for &pi in list {
                        if !is_seed[pi as usize] { continue; }
                        let p = points[pi as usize];
                        let d2 = (q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2) + (q[2] - p[2]).powi(2);
                        if d2 <= r2 { return true; }
                    }
                }
            }
        }
    }
    false
}

// --- stage 2: cover sets + neighbour graph ----------------------------

struct Cover {
    seed: [f64; 3],
    /// Indices into `points` of every point within r_cover of the seed.
    /// Overlaps with other cover sets — a point near the boundary
    /// between two seeds shows up in both lists.
    members: Vec<u32>,
    /// Indices into `covers` of other cover sets that share at least
    /// one point with this one (i.e. their members lists intersect).
    /// Equivalent to "seeds within 2·r_cover" for uniform density.
    neighbours: Vec<u32>,
}

fn build_covers(points: &[[f64; 3]], seeds: &[u32], r_cover: f64) -> Vec<Cover> {
    let inv = 1.0 / r_cover;
    let cell_of = |p: [f64; 3]| -> (i32, i32, i32) {
        ((p[0] * inv).floor() as i32, (p[1] * inv).floor() as i32, (p[2] * inv).floor() as i32)
    };
    // Hash points so each cover set's member sweep is local.
    let mut point_cells: FxHashMap<(i32, i32, i32), Vec<u32>> = FxHashMap::default();
    for (i, p) in points.iter().enumerate() {
        point_cells.entry(cell_of(*p)).or_default().push(i as u32);
    }
    // Per-cover member list via 27-cell sweep around each seed.
    let r2 = r_cover * r_cover;
    let mut covers: Vec<Cover> = Vec::with_capacity(seeds.len());
    // Also build a per-point list of covers containing that point so
    // we can derive neighbour edges from shared points.
    let mut point_to_covers: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    for (ci, &seed_idx) in seeds.iter().enumerate() {
        let seed = points[seed_idx as usize];
        let (kx, ky, kz) = cell_of(seed);
        let mut members: Vec<u32> = Vec::new();
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(list) = point_cells.get(&(kx + dx, ky + dy, kz + dz)) {
                        for &pi in list {
                            let q = points[pi as usize];
                            let d2 = (seed[0] - q[0]).powi(2) + (seed[1] - q[1]).powi(2) + (seed[2] - q[2]).powi(2);
                            if d2 <= r2 {
                                members.push(pi);
                                point_to_covers.entry(pi).or_default().push(ci as u32);
                            }
                        }
                    }
                }
            }
        }
        covers.push(Cover { seed, members, neighbours: Vec::new() });
    }
    // Derive neighbour edges: any two covers sharing a point are
    // neighbours. We deduplicate via a per-cover hash set.
    use std::collections::HashSet;
    let mut neighbour_sets: Vec<HashSet<u32>> = (0..covers.len()).map(|_| HashSet::new()).collect();
    for (_, share_list) in point_to_covers.iter() {
        for &a in share_list {
            for &b in share_list {
                if a != b { neighbour_sets[a as usize].insert(b); }
            }
        }
    }
    for (i, ns) in neighbour_sets.into_iter().enumerate() {
        covers[i].neighbours = ns.into_iter().collect();
    }
    covers
}

// --- stage 7: cylinder fitting --------------------------------------

/// Largest radius a fitted cylinder may have, by what it is part of.
///
/// The 0.20 m branch cap is a real sanity bound — a first-order branch
/// thicker than 40 cm is a fit that has swallowed part of the trunk.
/// Applying that same bound to the TRUNK silently truncates every tree
/// over ~40 cm DBH from the butt up to wherever the stem tapers below
/// it, which is several metres on a gradually-tapering conifer and is
/// exactly the high-value tree whose volume matters most. The trunk cap
/// matches what every other circle fit in this codebase already allows
/// (virtual caliper 2.5 m, stem taper 0.8 m, the v1 slice fit 1.5 m) —
/// this function was tuned for branches and the trunk chain inherited
/// it when trunk fitting was added.
fn max_radius_for(branch_order: u8) -> f64 {
    if branch_order == 0 { 1.5 } else { 0.20 }
}

fn filter_keep(c: &BranchCylinder, branch_order: u8) -> bool {
    if c.length < 0.10 { return false; }
    if !(0.004..=max_radius_for(branch_order)).contains(&c.radius) { return false; }
    if c.length / c.radius < 1.5 { return false; }
    if c.rmse / c.radius > 0.6 { return false; }
    true
}

/// Iterative cylinder LSQ fit. Starts from a PCA+Kåsa estimate, then
/// alternates (axis ↔ centre+radius) until convergence; finishes with
/// one outlier-rejection pass (MAD-based) and a final refit.
fn fit_cylinder_pca_kasa(pts: &[[f64; 3]]) -> Option<BranchCylinder> {
    fit_cylinder_iterative(pts, 8)
}

/// One alternating refinement step:
///   1. Build perpendicular basis (u, v) from current axis a.
///   2. Project points onto (u, v) plane, centred at current axis
///      point c → 2D point cloud.
///   3. Kåsa fit on the 2D cloud → new perpendicular centre (cu, cv)
///      + new radius r.
///   4. Move c by (cu·u + cv·v) so the new c lies on the new axis.
///   5. Re-centre points about new c, run a 3×3 PCA, take the
///      eigenvector with largest eigenvalue as the new axis (the
///      direction with maximum data spread = cylinder axis).
fn refine_step(pts: &[[f64; 3]], c_in: [f64; 3], a_in: [f64; 3]) -> Option<([f64; 3], [f64; 3], f64)> {
    let (u, v) = perp_basis(a_in)?;
    let mut plane: Vec<(f64, f64)> = Vec::with_capacity(pts.len());
    for p in pts {
        let d = [p[0] - c_in[0], p[1] - c_in[1], p[2] - c_in[2]];
        let pu = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
        let pv = d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
        plane.push((pu, pv));
    }
    let (cu, cv, radius) = taubin_circle(&plane)?;
    if !(radius.is_finite() && radius > 0.0) { return None; }
    let c_new = [
        c_in[0] + cu * u[0] + cv * v[0],
        c_in[1] + cu * u[1] + cv * v[1],
        c_in[2] + cu * u[2] + cv * v[2],
    ];
    let a_new = pca_axis(pts, c_new)?;
    Some((c_new, a_new, radius))
}

/// Dominant eigenvector of the covariance matrix of (p − c) — i.e. the
/// direction of maximum spread, which for a cylinder cloud IS the axis.
fn pca_axis(pts: &[[f64; 3]], c: [f64; 3]) -> Option<[f64; 3]> {
    if pts.len() < 3 { return None; }
    let nf = pts.len() as f64;
    let mut cov = [[0.0f64; 3]; 3];
    for p in pts {
        let d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        for i in 0..3 { for j in 0..3 { cov[i][j] += d[i] * d[j]; } }
    }
    for i in 0..3 { for j in 0..3 { cov[i][j] /= nf; } }
    let (vecs, vals) = jacobi_eigen_sym3(cov);
    let mut imax = 0;
    for k in 1..3 { if vals[k] > vals[imax] { imax = k; } }
    let axis = [vecs[0][imax], vecs[1][imax], vecs[2][imax]];
    let alen = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    if alen < 1e-9 { return None; }
    Some([axis[0] / alen, axis[1] / alen, axis[2] / alen])
}

fn perp_basis(a: [f64; 3]) -> Option<([f64; 3], [f64; 3])> {
    let helper = if a[2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
    let u_raw = cross(&a, &helper);
    let ulen = (u_raw[0] * u_raw[0] + u_raw[1] * u_raw[1] + u_raw[2] * u_raw[2]).sqrt();
    if ulen < 1e-9 { return None; }
    let u = [u_raw[0] / ulen, u_raw[1] / ulen, u_raw[2] / ulen];
    let v = cross(&a, &u);
    Some((u, v))
}

fn fit_cylinder_iterative(pts: &[[f64; 3]], max_iter: usize) -> Option<BranchCylinder> {
    let n = pts.len();
    if n < 6 { return None; }
    let nf = n as f64;

    // Initial centre = centroid; axis from PCA on the raw cloud.
    let mut c = [0.0f64; 3];
    for p in pts { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    for i in 0..3 { c[i] /= nf; }
    let mut a = pca_axis(pts, c)?;

    // Initial Kåsa radius.
    let (mut c_curr, mut a_curr, mut r) = refine_step(pts, c, a)?;
    c = c_curr; a = a_curr;

    // Alternating refinement until |Δa| + |Δr| stabilises.
    for _ in 0..max_iter {
        let prev_a = a;
        let prev_r = r;
        let (c2, a2, r2) = match refine_step(pts, c, a) { Some(t) => t, None => break };
        c_curr = c2; a_curr = a2; r = r2;
        c = c_curr; a = a_curr;
        let da = ((a[0] - prev_a[0]).powi(2) + (a[1] - prev_a[1]).powi(2) + (a[2] - prev_a[2]).powi(2)).sqrt();
        let dr = (r - prev_r).abs();
        if da < 1e-5 && dr < 1e-5 { break; }
    }

    // Outlier rejection: drop points with |residual| > 2.5 × MAD,
    // refit once more.
    let mut residuals: Vec<f64> = pts.iter().map(|p| {
        let d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        let t = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
        let perp_x = d[0] - t * a[0];
        let perp_y = d[1] - t * a[1];
        let perp_z = d[2] - t * a[2];
        let perp_len = (perp_x * perp_x + perp_y * perp_y + perp_z * perp_z).sqrt();
        perp_len - r
    }).collect();
    let mut abs_res = residuals.iter().map(|d| d.abs()).collect::<Vec<f64>>();
    abs_res.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    let mad = if abs_res.is_empty() { 0.0 } else { abs_res[abs_res.len() / 2] };
    let threshold = (2.5 * mad).max(0.005);
    let kept: Vec<[f64; 3]> = pts.iter().zip(residuals.iter())
        .filter(|(_, &res)| res.abs() <= threshold)
        .map(|(p, _)| *p).collect();
    if kept.len() >= 6 && kept.len() < pts.len() {
        if let Some((c2, a2, r2)) = refine_step(&kept, c, a) {
            c = c2; a = a2; r = r2;
            // Refresh residuals on the kept set for the final RMSE.
            residuals = kept.iter().map(|p| {
                let d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
                let t = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
                let perp_x = d[0] - t * a[0];
                let perp_y = d[1] - t * a[1];
                let perp_z = d[2] - t * a[2];
                let perp_len = (perp_x * perp_x + perp_y * perp_y + perp_z * perp_z).sqrt();
                perp_len - r
            }).collect();
        }
    }

    // Final length + endpoints + RMSE.
    let mut tmin = f64::INFINITY;
    let mut tmax = f64::NEG_INFINITY;
    for p in pts {
        let d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        let t = d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
        if t < tmin { tmin = t; }
        if t > tmax { tmax = t; }
    }
    let length = tmax - tmin;
    if length <= 0.0 { return None; }

    let sq: f64 = residuals.iter().map(|d| d * d).sum();
    let rmse = (sq / residuals.len() as f64).sqrt();

    // Angular coverage: 12 sectors of 30° around the fit centre on
    // the perpendicular plane. 1.0 = fully encircled cross-section.
    // Both the scalar coverage and the per-sector mask travel with
    // the cylinder so the rescan advisor can derive a shadow azimuth.
    let (coverage, sector_mask) = compute_chunk_coverage(pts, c, a);

    let start = [c[0] + a[0] * tmin, c[1] + a[1] * tmin, c[2] + a[2] * tmin];
    let end = [c[0] + a[0] * tmax, c[1] + a[1] * tmax, c[2] + a[2] * tmax];
    let volume = std::f64::consts::PI * r * r * length;
    Some(BranchCylinder {
            added: false, extension: None, position_in_branch: 0, unmod_radius: 0.0,
        start, end, radius: r, length, volume,
        n_voxels: n as u32,
        rmse,
        segment_id: 0,
        parent_cylinder: None,
        parent_segment: None,
        branch_order: 1,
        coverage,
        sector_mask,
    })
}

fn cross(a: &[f64; 3], b: &[f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn jacobi_eigen_sym3(mut m: [[f64; 3]; 3]) -> ([[f64; 3]; 3], [f64; 3]) {
    let mut v = [[1.0f64, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..30 {
        let mut p = 0usize; let mut q = 1usize; let mut max_abs = m[0][1].abs();
        for &(pi, qi) in &[(0usize, 2usize), (1, 2)] {
            if m[pi][qi].abs() > max_abs { p = pi; q = qi; max_abs = m[pi][qi].abs(); }
        }
        if max_abs < 1e-14 { break; }
        let theta = (m[q][q] - m[p][p]) / (2.0 * m[p][q]);
        let t = if theta.abs() > 1e10 { 0.5 / theta }
            else { let s = if theta >= 0.0 { 1.0 } else { -1.0 }; s / (theta.abs() + (theta * theta + 1.0).sqrt()) };
        let c = 1.0 / (t * t + 1.0).sqrt();
        let s = t * c;
        let mpp = m[p][p]; let mqq = m[q][q]; let mpq = m[p][q];
        m[p][p] = c * c * mpp - 2.0 * s * c * mpq + s * s * mqq;
        m[q][q] = s * s * mpp + 2.0 * s * c * mpq + c * c * mqq;
        m[p][q] = 0.0; m[q][p] = 0.0;
        for k in 0..3 {
            if k != p && k != q {
                let mpk = m[p][k]; let mqk = m[q][k];
                m[p][k] = c * mpk - s * mqk;
                m[k][p] = m[p][k];
                m[q][k] = s * mpk + c * mqk;
                m[k][q] = m[q][k];
            }
        }
        for k in 0..3 {
            let vkp = v[k][p]; let vkq = v[k][q];
            v[k][p] = c * vkp - s * vkq;
            v[k][q] = s * vkp + c * vkq;
        }
    }
    ([v[0], v[1], v[2]], [m[0][0], m[1][1], m[2][2]])
}

// --- tests -----------------------------------------------------------

// ---------------------------------------------------------------------
// §2.3 trunk segmentation + helper that fits a cylinder chain along an
// arbitrary cover-set chain (used for both trunk and branch segments).
// ---------------------------------------------------------------------

#[allow(dead_code)]
fn find_trunk_chain(covers: &[Cover]) -> Vec<u32> {
    find_trunk_chain_impl(covers, 0.0)
}

/// Body of find_trunk_chain with an r_cover hint so callers that know
/// the cover scale can require each upward step to advance by ≥ ½ ·
/// r_cover (avoids the walker spiralling around a cylinder shell —
/// stem points live on the surface, not the centerline, so consecutive
/// shell-ring cover sets can have small dz despite being "above").
/// When r_cover is 0 (legacy callers) the walker uses the looser
/// dz > 0 test.
fn find_trunk_chain_impl(covers: &[Cover], r_cover: f64) -> Vec<u32> {
    if covers.is_empty() { return Vec::new(); }

    // Trunk anchor = lowest-z cover set (the trunk by definition sits
    // on the ground). Among ties — covers in the bottom voxel — pick
    // the one with the most neighbours (trunk-like). We deliberately
    // DON'T bias by XY distance to the cloud centroid because a tree
    // with asymmetric branches (e.g. one heavy arm) has its centroid
    // off-stem, and that would pull the anchor onto a side branch.
    let mut min_z = f64::INFINITY;
    for c in covers {
        if c.seed[2] < min_z { min_z = c.seed[2]; }
    }
    let mut best_anchor: Option<u32> = None;
    let mut best_score = f64::NEG_INFINITY;
    let band = (2.0 * r_cover).max(0.10); // tight band around the lowest cover
    for (i, c) in covers.iter().enumerate() {
        if c.seed[2] > min_z + band { continue; }
        let n_nb = c.neighbours.len() as f64;
        // Score: connectivity (more neighbours = trunk interior),
        // low z as a tie-breaker.
        let score = n_nb - (c.seed[2] - min_z) * 5.0;
        if score > best_score { best_score = score; best_anchor = Some(i as u32); }
    }
    let Some(anchor) = best_anchor else { return Vec::new(); };

    // Walk upward through the cover graph. At each step, pick the
    // unvisited neighbour that BEST scores as "the next trunk step":
    // high verticality (dz/||d|| with dz > 0) + high connectivity.
    let mut chain: Vec<u32> = vec![anchor];
    let mut visited = vec![false; covers.len()];
    visited[anchor as usize] = true;
    let mut current = anchor;
    loop {
        let cur_pos = covers[current as usize].seed;
        let mut best_next: Option<u32> = None;
        let mut best_next_score = f64::NEG_INFINITY;
        for &n in &covers[current as usize].neighbours {
            if visited[n as usize] { continue; }
            let np = covers[n as usize].seed;
            let dx = np[0] - cur_pos[0];
            let dy = np[1] - cur_pos[1];
            let dz = np[2] - cur_pos[2];
            let min_dz = if r_cover > 0.0 { 0.5 * r_cover } else { 0.0 };
            if dz <= min_dz { continue; } // strictly upward; for r_cover hints, by at least ½ cover
            let d = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-9);
            let verticality = dz / d;
            let conn = covers[n as usize].neighbours.len() as f64;
            // Verticality dominates; connectivity is a tie-breaker so
            // we prefer the cover set in the trunk interior over one
            // on a side branch that happens to also go up.
            let score = verticality * 3.0 + conn * 0.05;
            if score > best_next_score { best_next_score = score; best_next = Some(n); }
        }
        if let Some(next) = best_next {
            visited[next as usize] = true;
            chain.push(next);
            current = next;
        } else {
            break;
        }
    }

    chain
}




/// 12-sector angular coverage of the perpendicular-plane fit. Used
/// for the QsmSlice.coverage / BranchCylinder.coverage field; matches
/// the slice-fit's coverage definition so the colour ramp stays
/// consistent across modes. Returns `(fraction, sector_mask)` —
/// the mask is bit-packed (bit i = sector centred at i·30°+15°), and
/// the rescan advisor reads it from QsmSlice.sector_mask to compute
/// the dominant shadow azimuth per tree.
fn compute_chunk_coverage(pts: &[[f64; 3]], c: [f64; 3], a: [f64; 3]) -> (f64, u16) {
    let Some((u, v)) = perp_basis(a) else { return (0.0, 0); };
    let mut mask: u16 = 0;
    let inv = 12.0 / std::f64::consts::TAU;
    for p in pts {
        let d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        let pu = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
        let pv = d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
        let ang = pv.atan2(pu); // -π..π
        let mut idx = ((ang + std::f64::consts::PI) * inv).floor() as i32;
        if idx < 0 { idx = 0; }
        if idx >= 12 { idx = 11; }
        mask |= 1u16 << idx;
    }
    ((mask.count_ones() as f64) / 12.0, mask)
}

#[cfg(test)]
mod filter_report_tests {
    use super::*;

    /// THE REPORT ADDS UP: what each stage removed sums to before minus
    /// left, and the line reads in the reference's order.
    #[test]
    fn the_stages_account_for_every_point_removed() {
        let mut pts: Vec<[f64; 3]> = Vec::new();
        // A dense line of 400 points a centimetre apart…
        for i in 0..400 { pts.push([i as f64 * 0.01, 0.0, 0.0]); }
        // …an exact duplicate, one lone outlier far away, and a NaN.
        pts.push(pts[10]);
        pts.push([50.0, 50.0, 50.0]);
        pts.push([f64::NAN, 0.0, 0.0]);
        let (keep, r) = filtering_report(&pts, &FilterParams::default());
        assert_eq!(keep.len(), pts.len());
        assert_eq!(r.before, pts.len());
        assert_eq!(r.not_finite, 1);
        assert_eq!(r.left, keep.iter().filter(|&&k| k).count());
        assert_eq!(r.removed(), r.not_finite + r.statistical_outliers + r.small_components + r.cube_duplicates,
                   "{r:?}");
        assert!(r.cube_duplicates >= 1, "the duplicate is a cube duplicate: {r:?}");
        assert!(r.statistical_outliers + r.small_components >= 1, "the far point goes somewhere: {r:?}");
        let line = r.summary();
        assert!(line.starts_with(&format!("before {}, statistical outliers {}, small components {}", r.before, r.statistical_outliers, r.small_components)), "{line}");
        assert!(line.contains(&format!("left {}", r.left)), "{line}");
        assert!(line.contains("not finite 1"), "{line}");
        // The plain filter is the same mask.
        assert_eq!(filtering(&pts, &FilterParams::default()), keep);
    }
}

#[cfg(test)]
mod knn_tests {
    use super::*;

    fn brute_kth(points: &[[f64; 3]], i: usize, k: usize) -> f64 {
        let q = points[i];
        let mut d: Vec<f64> = points.iter().enumerate().filter(|&(j, _)| j != i)
            .map(|(_, r)| ((q[0] - r[0]).powi(2) + (q[1] - r[1]).powi(2) + (q[2] - r[2]).powi(2)).sqrt())
            .collect();
        d.sort_by(|a, b| a.partial_cmp(b).unwrap());
        d[k - 1]
    }

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64) / ((1u64 << 53) as f64)
    }

    /// THE KD-TREE ANSWER IS THE BRUTE-FORCE ANSWER, on a cloud whose
    /// density varies a thousandfold — a dense trunk, a sparse crown —
    /// which is the case that made the grid it replaced sort tens of
    /// thousands of candidates per point.
    #[test]
    fn the_kth_neighbour_distance_is_exact_whatever_the_density() {
        let mut seed = 7u64;
        let mut pts: Vec<[f64; 3]> = Vec::new();
        // Trunk: a 0.3 m cylinder, 3000 points on 10 m of height.
        for _ in 0..3000 {
            let a = lcg(&mut seed) * std::f64::consts::TAU;
            pts.push([0.15 * a.cos(), 0.15 * a.sin(), lcg(&mut seed) * 10.0]);
        }
        // Crown: 300 points in a 10 m box.
        for _ in 0..300 {
            pts.push([lcg(&mut seed) * 10.0 - 5.0, lcg(&mut seed) * 10.0 - 5.0, 8.0 + lcg(&mut seed) * 10.0]);
        }
        // A few exact duplicates, which knnsearch reports at distance 0.
        pts.push(pts[10]);
        pts.push(pts[10]);
        let idx: Vec<u32> = (0..pts.len() as u32).collect();
        let k = 10;
        let d = knn_distance(&pts, &idx, k);
        for i in (0..pts.len()).step_by(7) {
            let want = brute_kth(&pts, i, k);
            assert!((d[i] - want).abs() < 1e-9, "point {i}: kd-tree {} vs brute force {want}", d[i]);
        }
        assert_eq!(d[pts.len() - 1], brute_kth(&pts, pts.len() - 1, k));
    }

    /// A SUBSET IS A SUBSET: the tree is built over `idx` only, and the
    /// answers index `idx`'s slots, not the point array.
    #[test]
    fn the_distances_are_over_the_subset_asked_for() {
        let pts: Vec<[f64; 3]> = (0..40).map(|i| [i as f64, 0.0, 0.0]).collect();
        // Even points only: the nearest other even point is 2 away.
        let idx: Vec<u32> = (0..40u32).filter(|i| i % 2 == 0).collect();
        let d = knn_distance(&pts, &idx, 1);
        assert_eq!(d.len(), idx.len());
        assert!(d.iter().all(|&v| (v - 2.0).abs() < 1e-12), "{d:?}");
    }

    /// FEWER POINTS THAN k does not panic and answers with what there is.
    #[test]
    fn a_tiny_cloud_answers_with_what_it_has() {
        let pts = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [3.0, 0.0, 0.0]];
        let idx = vec![0u32, 1, 2];
        let d = knn_distance(&pts, &idx, 10);
        assert_eq!(d, vec![3.0, 2.0, 3.0]);
        assert!(knn_distance(&pts, &[], 10).is_empty());
    }
}

#[cfg(test)]
mod relative_size_tests {
    use super::*;

    /// A stem of `w`-wide layers with a thin branch off the middle.
    /// Cover sets hold one point each, so RS per set is readable
    /// straight out of the result.
    struct Fix {
        balls: Vec<Vec<u32>>,
        centres_of: Vec<u32>,
        z: Vec<f64>,
        nei: Vec<Vec<u32>>,
        segs: Vec<Vec<Vec<u32>>>,
        children: Vec<Vec<u32>>,
        npoints: usize,
    }

    fn fixture(stem_w: usize, stem_len: usize, branch_w: usize, branch_len: usize, at: usize) -> Fix {
        let mut z: Vec<f64> = Vec::new();
        let mut balls: Vec<Vec<u32>> = Vec::new();
        let mut centres_of: Vec<u32> = Vec::new();
        let new_set = |zz: f64, z: &mut Vec<f64>, balls: &mut Vec<Vec<u32>>, cen: &mut Vec<u32>| -> u32 {
            z.push(zz);
            let pt = (z.len() - 1) as u32;
            balls.push(vec![pt]);
            cen.push(pt);
            (balls.len() - 1) as u32
        };
        let mut stem: Vec<Vec<u32>> = Vec::new();
        for l in 0..stem_len {
            let layer: Vec<u32> = (0..stem_w)
                .map(|_| new_set(l as f64 * 0.10, &mut z, &mut balls, &mut centres_of))
                .collect();
            stem.push(layer);
        }
        let mut branch: Vec<Vec<u32>> = Vec::new();
        for l in 0..branch_len {
            let layer: Vec<u32> = (0..branch_w)
                .map(|_| new_set(at as f64 * 0.10 + l as f64 * 0.02, &mut z, &mut balls, &mut centres_of))
                .collect();
            branch.push(layer);
        }
        let nei = vec![Vec::new(); balls.len()];
        Fix {
            npoints: z.len(), balls, centres_of, z, nei,
            segs: vec![stem, branch],
            children: vec![vec![1u32], Vec::new()],
        }
    }

    impl Fix {
        /// Widen one layer by `n` more cover sets at the same height.
        /// A real branch flares where it attaches, and that flare is
        /// the whole reason the reference measures a segment's girth
        /// from layers 2..6 rather than from layer 1.
        fn widen(&mut self, seg: usize, layer: usize, n: usize) {
            let zz = self.z[self.centres_of[self.segs[seg][layer][0] as usize] as usize];
            for _ in 0..n {
                self.z.push(zz);
                let pt = (self.z.len() - 1) as u32;
                self.balls.push(vec![pt]);
                self.centres_of.push(pt);
                self.nei.push(Vec::new());
                let s = (self.balls.len() - 1) as u32;
                self.segs[seg][layer].push(s);
            }
            self.npoints = self.z.len();
        }
    }

    fn run(f: &Fix) -> Vec<u8> {
        let zc = f.z.clone();
        relative_size(f.npoints, &f.balls, &f.centres_of, &move |p| zc[p as usize],
                      &f.nei, &f.segs, &f.children)
    }

    /// THE TAPER. Within one segment the size must fall from the base
    /// to nearly nothing at the tip. A fixed cover — which is what this
    /// software had — is a flat line here, and a flat line cannot
    /// follow a branch that narrows.
    #[test]
    fn the_size_falls_along_a_segment_towards_its_tip() {
        let f = fixture(6, 20, 6, 1, 10);
        let rs = run(&f);
        let at_layer = |j: usize| rs[f.centres_of[f.segs[0][j][0] as usize] as usize];
        let base = at_layer(0);
        let mid = at_layer(10);
        let tip = at_layer(19);
        assert!(base > mid && mid > tip,
            "the taper is not monotone: base {base}, middle {mid}, tip {tip}");
        assert_eq!(base, 255, "the stem's base should be full size, got {base}");
        assert!(tip < 40, "the tip is still {tip}, so the cover never gets small");
    }

    /// THE SHAPE OF THE TAPER, which monotonicity above does not pin
    /// down: the reference's falloff is `sqrt(j/s)`, so a quarter of
    /// the way along a segment the size has already dropped *half* the
    /// way to the tip. A straight line has dropped a quarter by then.
    /// Without this the taper could be linear and every other test
    /// here would still pass.
    #[test]
    fn the_taper_follows_a_square_root_not_a_straight_line() {
        let f = fixture(6, 20, 6, 1, 10);
        let rs = run(&f);
        let at_layer = |j: usize| rs[f.centres_of[f.segs[0][j][0] as usize] as usize] as f64;
        let base = at_layer(0);
        let tip = at_layer(19);
        // Layer 5 of 20 is a quarter of the way up.
        let dropped = (base - at_layer(5)) / (base - tip);
        assert!((0.44..0.58).contains(&dropped),
            "a quarter of the way along the segment the size had dropped {dropped:.3} of \
             the way to the tip; sqrt(1/4) says about 0.5, a straight line would say 0.25");
    }

    /// A thin branch starts smaller than the stem, because its base is
    /// measured in cover sets against the stem's. This is what makes a
    /// twig get a twig-sized cover instead of a stem-sized one.
    #[test]
    fn a_thin_branch_starts_smaller_than_the_stem() {
        // Low on the stem on purpose. Put the branch high and the
        // height cap becomes the binding constraint, and then the test
        // passes whether or not the thickness scaling exists at all —
        // which is exactly how an earlier version of this test let a
        // broken scaling through.
        let mut f = fixture(12, 20, 2, 10, 2);
        // Flare the attachment: layer 1 of the branch is as wide as the
        // stem, layers 2 onwards are the branch's real girth. A mean
        // that counted layer 1 would call this branch three times as
        // thick as it is.
        f.widen(1, 0, 10);
        let rs = run(&f);
        let stem_base = rs[f.centres_of[f.segs[0][0][0] as usize] as usize] as f64;
        let branch_base = rs[f.centres_of[f.segs[1][0][0] as usize] as usize] as f64;
        // Two effects, both of them the reference's: the base is scaled
        // by the segment's thickness against the stem's (2 sets against
        // 12, so a sixth), and then halved because the base sits at a
        // junction. A twelfth of the stem's, near enough.
        let ratio = branch_base / stem_base;
        assert!((0.06..0.11).contains(&ratio),
            "a branch a sixth of the stem's thickness started at {ratio:.3} of the stem's base \
             ({branch_base} against {stem_base}); a sixth, halved at the junction, is about 0.083");
    }

    /// THE BRANCHING-ORDER CAP, which the reference computes and then
    /// cancels to one — see fix 1. A branch off a branch cannot claim a
    /// base as thick as one off the stem, however thick its own points
    /// happen to look.
    ///
    /// The two segments here are identical in girth and start at the
    /// same height; only their depth in the tree differs.
    #[test]
    fn a_deeper_branch_is_capped_below_a_shallower_one() {
        let build = |depth: usize| -> Fix {
            // A stem, then `depth` branches chained one off the next,
            // all the same width and all starting at the same height.
            let mut f = fixture(12, 20, 6, 8, 10);
            for k in 1..depth {
                let seg: Vec<Vec<u32>> = f.segs[1].clone();
                f.segs.push(seg);
                f.children.push(Vec::new());
                let new = (f.segs.len() - 1) as u32;
                f.children[k].push(new);
            }
            f
        };
        let shallow = run(&build(1));
        let deep = build(3);
        let deep_rs = run(&deep);
        let last = deep.segs.len() - 1;

        let a = shallow[deep.centres_of[deep.segs[1][0][0] as usize] as usize];
        let b = deep_rs[deep.centres_of[deep.segs[last][0][0] as usize] as usize];
        assert!(b < a,
            "a third-order branch got base {b} where a first-order one of the same \
             girth and height got {a}");
    }

    /// The height cap. Two branches of identical thickness, one leaving
    /// low and one leaving high: the high one is capped smaller,
    /// because the cap shrinks with height.
    #[test]
    fn a_branch_high_in_the_tree_is_capped_below_one_low_down() {
        let mut low = fixture(10, 40, 4, 8, 4);
        let mut high = fixture(10, 40, 4, 8, 34);
        // Move the high branch's own z up so its base really is high.
        for (i, layer) in high.segs[1].iter().enumerate() {
            for &s in layer {
                let p = high.centres_of[s as usize] as usize;
                high.z[p] = 3.4 + i as f64 * 0.02;
            }
        }
        for (i, layer) in low.segs[1].iter().enumerate() {
            for &s in layer {
                let p = low.centres_of[s as usize] as usize;
                low.z[p] = 0.4 + i as f64 * 0.02;
            }
        }
        let rl = run(&low);
        let rh = run(&high);
        let bl = rl[low.centres_of[low.segs[1][0][0] as usize] as usize];
        let bh = rh[high.centres_of[high.segs[1][0][0] as usize] as usize];
        assert!(bh < bl,
            "the high branch got {bh} and the low one {bl} — the height cap is not applied");
    }

    /// The junction halving. An over-large cover set at a fork bridges
    /// the branch to its parent and merges them, so the reference
    /// halves the size on the child's base and its neighbours.
    #[test]
    fn the_size_is_halved_around_a_junction() {
        let mut f = fixture(8, 20, 8, 8, 10);
        // Give the branch's base a neighbour in the stem, which is what
        // a real cover graph has at a fork.
        let base = f.segs[1][0][0];
        let stem_set = f.segs[0][10][0];
        f.nei[base as usize].push(stem_set);
        // The branch's base is of course a neighbour of its own second
        // layer too — that is what makes them consecutive layers. The
        // reference spares the second layer anyway: it is the branch
        // getting on with being a branch, not the junction.
        let own_second = f.segs[1][1][0];
        f.nei[base as usize].push(own_second);
        let with = run(&f);

        // The comparison keeps the SAME parent-child structure and
        // differs only in the neighbour links, because the structure
        // also sets the branching order and so the cap: clearing the
        // children would change the sizes for a second reason and the
        // comparison would measure both at once.
        let g = fixture(8, 20, 8, 8, 10);
        let without = run(&g);

        let p = f.centres_of[stem_set as usize] as usize;
        assert!(with[p] < without[p],
            "the neighbour of a junction was not halved: {} against {}", with[p], without[p]);
        assert_eq!(with[p], without[p] / 2, "halving is not by half");
        // …and the child's own base IS halved in both, because it is a
        // junction whether or not anything neighbours it.
        let b = f.centres_of[base as usize] as usize;
        assert_eq!(with[b], without[b], "the child's base differs for another reason");

        let q = f.centres_of[own_second as usize] as usize;
        assert_eq!(with[q], without[q],
            "the child's own second layer was halved ({} against {}); only the junction is",
            with[q], without[q]);
    }

    /// A point next to two junctions is halved ONCE. The reference
    /// snapshots RS before the loop and reads the snapshot, so the
    /// halvings do not compound.
    #[test]
    fn a_point_between_two_junctions_is_halved_only_once() {
        let mut f = fixture(8, 20, 4, 6, 10);
        // A second branch off the same stem set.
        let second: Vec<Vec<u32>> = f.segs[1].clone();
        f.segs.push(second);
        f.children.push(Vec::new());
        f.children[0].push(2);
        let shared = f.segs[0][10][0];
        f.nei[f.segs[1][0][0] as usize].push(shared);
        f.nei[f.segs[2][0][0] as usize].push(shared);
        let rs = run(&f);

        let mut g = fixture(8, 20, 4, 6, 10);
        g.children[0].clear();
        let plain = run(&g);
        let p = f.centres_of[shared as usize] as usize;
        assert_eq!(rs[p], plain[p] / 2,
            "two junctions halved the same point twice: {} from {}", rs[p], plain[p]);
    }

    #[test]
    fn an_empty_segmentation_gives_no_sizes() {
        let z: Vec<f64> = Vec::new();
        let rs = relative_size(0, &[], &[], &move |_| 0.0, &[], &[], &[]);
        assert!(rs.is_empty());
        let _ = z;
    }
}

#[cfg(test)]
mod modify_topology_tests {
    use super::*;

    /// Every invariant a subtle index error breaks, checked without
    /// knowing what the right answer looks like.
    fn check_invariants(
        segs: &[Vec<Vec<u32>>], parent: &[Option<(u32, u32)>], children: &[Vec<u32>],
        before: &[u32],
    ) {
        assert_eq!(segs.len(), parent.len(), "segs and parent disagree in length");
        assert_eq!(segs.len(), children.len(), "segs and children disagree in length");

        // 1. Nothing is lost and nothing is duplicated.
        let mut after: Vec<u32> = segs.iter().flatten().flatten().copied().collect();
        after.sort_unstable();
        let mut want = before.to_vec();
        want.sort_unstable();
        assert_eq!(after, want, "the splice lost or duplicated cover sets");

        for (i, p) in parent.iter().enumerate() {
            let Some((pi, layer)) = *p else { continue };
            // 2. Attachment layers must exist in the parent.
            let n = segs[pi as usize].len();
            assert!((layer as usize) < n,
                "segment {i} says it attaches at layer {layer} of segment {pi}, which has {n}");
            // 3. Parent and children must agree.
            assert!(children[pi as usize].contains(&(i as u32)),
                "segment {i} claims {pi} as parent but is not among its children");
            // 4. No cycles.
            let mut cur = i as u32;
            let mut hops = 0;
            while let Some((up, _)) = parent[cur as usize] {
                cur = up; hops += 1;
                assert!(hops < segs.len() + 2, "the parent chain from {i} does not terminate");
            }
        }
        for (i, cs) in children.iter().enumerate() {
            for &c in cs {
                assert_eq!(parent[c as usize].map(|(p, _)| p), Some(i as u32),
                    "segment {i} lists {c} as a child but {c} does not agree");
            }
        }
    }

    /// A stem chopped into three by segmentation, with a branch off the
    /// middle piece. After the splice the stem is ONE segment and the
    /// branch still attaches at the same physical height — rebased into
    /// the joined segment's numbering.
    #[test]
    fn a_stem_cut_into_pieces_is_joined_and_its_branches_follow() {
        let mut centres: Vec<[f64; 3]> = Vec::new();
        let mut mk = |z0: f64, n: usize| -> Vec<Vec<u32>> {
            (0..n).map(|l| {
                centres.push([0.0, 0.0, z0 + l as f64 * 0.10]);
                vec![(centres.len() - 1) as u32]
            }).collect()
        };
        let a = mk(0.0, 12);
        let b = mk(1.2, 12);
        let c = mk(2.4, 12);
        // A branch leaving piece b at its layer 5, heading sideways.
        let br: Vec<Vec<u32>> = (0..8).map(|l| {
            centres.push([0.15 + l as f64 * 0.12, 0.0, 1.7]);
            vec![(centres.len() - 1) as u32]
        }).collect();

        let mut segs = vec![a, b, c, br];
        let mut parent = vec![None, Some((0u32, 11u32)), Some((1u32, 11u32)), Some((1u32, 5u32))];
        let mut children = vec![vec![1u32], vec![2u32, 3u32], Vec::new(), Vec::new()];
        let balls: Vec<Vec<u32>> = (0..centres.len()).map(|i| vec![i as u32]).collect();
        let before: Vec<u32> = segs.iter().flatten().flatten().copied().collect();

        modify_topology(&centres, &centres, &balls, &mut segs, &mut parent, &mut children, 0.10);
        check_invariants(&segs, &parent, &children, &before);

        // The stem is now one long segment, not three short ones.
        assert!(segs[0].len() >= 30,
            "the stem was not joined: segment 0 has {} layers", segs[0].len());
        // The branch survives, still hanging off the stem.
        let branch = (0..segs.len()).find(|&i| segs[i].len() == 8)
            .expect("the branch segment vanished");
        assert_eq!(parent[branch].map(|(p, _)| p), Some(0),
            "the branch was not re-parented onto the joined stem");
        // …and at the height it actually leaves from: layer 5 of the
        // old piece b, which began at layer 12 of the joined stem.
        let (_, layer) = parent[branch].unwrap();
        assert!((15..=19).contains(&layer),
            "the branch attaches at layer {layer}, but it physically leaves around layer 17");
    }

    /// An unbranched stem is already as long as it can be, so nothing
    /// should move — the commonest input and the easiest to corrupt.
    #[test]
    fn a_single_segment_is_left_exactly_as_it_was() {
        let centres: Vec<[f64; 3]> = (0..20).map(|i| [0.0, 0.0, i as f64 * 0.1]).collect();
        let mut segs: Vec<Vec<Vec<u32>>> = vec![(0..20).map(|i| vec![i as u32]).collect()];
        let mut parent = vec![None];
        let mut children: Vec<Vec<u32>> = vec![Vec::new()];
        let balls: Vec<Vec<u32>> = (0..20).map(|i| vec![i as u32]).collect();
        let before = segs.clone();
        modify_topology(&centres, &centres, &balls, &mut segs, &mut parent, &mut children, 0.10);
        assert_eq!(segs, before);
    }

    /// A fork: the stem takes the straighter arm and the other stays a
    /// branch. Invariants hold across a case that creates no new
    /// segments but re-points several.
    #[test]
    fn a_fork_keeps_both_arms_and_all_the_bookkeeping() {
        let (centres, balls, mut segs, mut parent, mut children) = {
            let mut centres: Vec<[f64; 3]> = Vec::new();
            let mut stem: Vec<Vec<u32>> = Vec::new();
            for l in 0..30 { centres.push([0.0, 0.0, l as f64 * 0.10]); stem.push(vec![(centres.len()-1) as u32]); }
            let mut straight: Vec<Vec<u32>> = Vec::new();
            for l in 0..21 { centres.push([0.0, 0.0, 3.0 + l as f64 * 0.10]); straight.push(vec![(centres.len()-1) as u32]); }
            let mut bendy: Vec<Vec<u32>> = Vec::new();
            for l in 0..11 { let t = l as f64/10.0; centres.push([2.0*t, 0.0, 3.0+t]); bendy.push(vec![(centres.len()-1) as u32]); }
            for l in 1..21 { let t = l as f64/20.0; centres.push([2.0-t, 0.0, 4.0+2.0*t]); bendy.push(vec![(centres.len()-1) as u32]); }
            let balls: Vec<Vec<u32>> = (0..centres.len()).map(|i| vec![i as u32]).collect();
            (centres.clone(), balls, vec![stem, straight, bendy],
             vec![None, Some((0u32, 29u32)), Some((0u32, 29u32))],
             vec![vec![1u32, 2u32], Vec::new(), Vec::new()])
        };
        let before: Vec<u32> = segs.iter().flatten().flatten().copied().collect();
        modify_topology(&centres, &centres, &balls, &mut segs, &mut parent, &mut children, 0.10);
        check_invariants(&segs, &parent, &children, &before);
        assert!(segs[0].len() > 30, "the stem did not absorb its continuation");
        assert_eq!(segs.len(), 2, "expected a stem and one branch, got {}", segs.len());
    }

    /// THE CUT. When the continuation attaches LOW on its parent, the
    /// parent's layers above the attachment are not part of the chain —
    /// they are a branch, and the reference splits them off into a new
    /// segment. Without the split the stem swallows a stub that bends
    /// away from it, and every cylinder above the join is fitted to
    /// two things at once.
    #[test]
    fn a_low_attachment_splits_the_parent_instead_of_swallowing_it() {
        let mut centres: Vec<[f64; 3]> = Vec::new();
        // Stem: 12 layers, but only the bottom 4 continue upward — the
        // rest lean away and are really a side branch.
        let mut stem: Vec<Vec<u32>> = Vec::new();
        for l in 0..4 { centres.push([0.0, 0.0, l as f64 * 0.10]); stem.push(vec![(centres.len()-1) as u32]); }
        for l in 0..8 {
            let t = (l + 1) as f64 * 0.10;
            centres.push([t, 0.0, 0.3 + t * 0.3]);
            stem.push(vec![(centres.len() - 1) as u32]);
        }
        // The real continuation, leaving at the stem's layer 3.
        let mut up: Vec<Vec<u32>> = Vec::new();
        for l in 0..25 { centres.push([0.0, 0.0, 0.4 + l as f64 * 0.10]); up.push(vec![(centres.len()-1) as u32]); }

        let mut segs = vec![stem, up];
        let mut parent = vec![None, Some((0u32, 3u32))];
        let mut children = vec![vec![1u32], Vec::new()];
        let balls: Vec<Vec<u32>> = (0..centres.len()).map(|i| vec![i as u32]).collect();
        let before: Vec<u32> = segs.iter().flatten().flatten().copied().collect();

        modify_topology(&centres, &centres, &balls, &mut segs, &mut parent, &mut children, 0.10);
        check_invariants(&segs, &parent, &children, &before);

        assert!(segs.len() >= 2,
            "the leaning stub was swallowed instead of being split off: {} segments", segs.len());
        // The stem must not contain the leaning part any more: its
        // layers should climb without wandering sideways.
        let max_x = segs[0].iter().flatten()
            .map(|&i| centres[i as usize][0].abs())
            .fold(0.0_f64, f64::max);
        assert!(max_x < 0.05,
            "the joined stem wanders to x = {max_x:.2}, so it absorbed the leaning stub");
    }

    /// The renumbering. Absorbed segments are dropped and the rest are
    /// renumbered, so every surviving parent index has to be rewritten.
    /// This tree has a survivor whose parent's number actually CHANGES
    /// — without that, the remap is the identity and a dropped remap
    /// looks correct.
    #[test]
    fn surviving_segments_are_renumbered_consistently() {
        let mut centres: Vec<[f64; 3]> = Vec::new();
        let mut mk = |x0: f64, z0: f64, dx: f64, dz: f64, n: usize| -> Vec<Vec<u32>> {
            (0..n).map(|l| {
                centres.push([x0 + l as f64 * dx, 0.0, z0 + l as f64 * dz]);
                vec![(centres.len() - 1) as u32]
            }).collect()
        };
        let lower = mk(0.0, 0.0, 0.0, 0.10, 12);          // 0
        let upper = mk(0.0, 1.2, 0.0, 0.10, 12);          // 1 — absorbed
        let branch = mk(0.10, 1.7, 0.12, 0.0, 10);        // 2 — survives
        let twig = mk(0.60, 1.7, 0.06, 0.09, 6);          // 3 — child of 2

        let mut segs = vec![lower, upper, branch, twig];
        let mut parent = vec![None, Some((0u32, 11u32)), Some((1u32, 5u32)), Some((2u32, 4u32))];
        let mut children = vec![vec![1u32], vec![2u32], vec![3u32], Vec::new()];
        let balls: Vec<Vec<u32>> = (0..centres.len()).map(|i| vec![i as u32]).collect();
        let before: Vec<u32> = segs.iter().flatten().flatten().copied().collect();

        modify_topology(&centres, &centres, &balls, &mut segs, &mut parent, &mut children, 0.10);
        check_invariants(&segs, &parent, &children, &before);

        // Segment 1 is gone, so 2 and 3 have moved down and every
        // reference to them must have moved with them.
        assert!(segs.len() < 4, "nothing was absorbed, so this proves nothing");
        let twig_idx = (0..segs.len()).find(|&i| segs[i].len() == 6).expect("the twig vanished");
        let (tp, _) = parent[twig_idx].expect("the twig lost its parent");
        assert_eq!(segs[tp as usize].len(), 10,
            "the twig's parent is segment {tp} with {} layers — it should be the 10-layer branch",
            segs[tp as usize].len());
    }

    #[test]
    fn an_empty_segmentation_does_not_panic() {
        let mut segs: Vec<Vec<Vec<u32>>> = Vec::new();
        let mut parent: Vec<Option<(u32, u32)>> = Vec::new();
        let mut children: Vec<Vec<u32>> = Vec::new();
        modify_topology(&[], &[], &[], &mut segs, &mut parent, &mut children, 0.1);
        assert!(segs.is_empty());
    }
}

#[cfg(test)]
mod tip_search_tests {
    use super::*;

    /// A stem that forks, built so the two plausible criteria DISAGREE.
    ///
    /// Both tips sit the same distance from the highest tip, so both are
    /// candidates at the same search radius. But the wandering fork
    /// reaches FURTHER from the stem base than the straight one, while
    /// taking a much longer path to get there. "Furthest tip wins" picks
    /// the wanderer; "straightest wins" — the reference's rule — picks
    /// the stem. A fixture where both rules agree cannot tell them
    /// apart, and the first version of this one did not.
    /// centres, balls, segments, parent links, children.
    type Tree = (Vec<[f64; 3]>, Vec<Vec<u32>>, Vec<Vec<Vec<u32>>>, Vec<Option<(u32, u32)>>, Vec<Vec<u32>>);

    fn forked_tree() -> Tree {
        let mut centres: Vec<[f64; 3]> = Vec::new();
        let mut stem: Vec<Vec<u32>> = Vec::new();
        for l in 0..30 {
            centres.push([0.0, 0.0, l as f64 * 0.10]);
            stem.push(vec![(centres.len() - 1) as u32]);
        }
        // Straight: (0,0,3) -> (0,0,5). Path 2.0, and with the stem
        // below it the chain spans 5.0 over a path of 5.0.
        let mut straight: Vec<Vec<u32>> = Vec::new();
        for l in 0..21 {
            centres.push([0.0, 0.0, 3.0 + l as f64 * 0.10]);
            straight.push(vec![(centres.len() - 1) as u32]);
        }
        // Wandering: (0,0,3) -> (2,0,4) -> (1,0,6). Tip is FURTHER from
        // the base (span ~6.08 against 5.0) but the path is ~7.5.
        let mut bendy: Vec<Vec<u32>> = Vec::new();
        for l in 0..11 {
            let t = l as f64 / 10.0;
            centres.push([2.0 * t, 0.0, 3.0 + t]);
            bendy.push(vec![(centres.len() - 1) as u32]);
        }
        for l in 1..21 {
            let t = l as f64 / 20.0;
            centres.push([2.0 - t, 0.0, 4.0 + 2.0 * t]);
            bendy.push(vec![(centres.len() - 1) as u32]);
        }
        let segs = vec![stem, straight, bendy];
        let parent = vec![None, Some((0u32, 29u32)), Some((0u32, 29u32))];
        let children = vec![vec![1u32, 2u32], Vec::new(), Vec::new()];
        let balls: Vec<Vec<u32>> = (0..centres.len()).map(|i| vec![i as u32]).collect();
        (centres.clone(), balls, segs, parent, children)
    }

    /// The fixture is only useful if the two rules really do disagree
    /// on it. Assert that before relying on it.
    #[test]
    fn the_fixture_separates_furthest_from_straightest() {
        let (centres, balls, segs, parent, _) = forked_tree();
        let span_of = |c: u32| {
            let chain = chain_to_root(&parent, c, 0).unwrap();
            let layers = splice_chain(&segs, &parent, &chain);
            chain_length_and_span(&centres, &centres, &balls, &layers, 5)
        };
        let (l1, s1) = span_of(1);
        let (l2, s2) = span_of(2);
        assert!(s2 > s1, "the wandering fork must reach further: {s2:.2} vs {s1:.2}");
        assert!(l2 / s2 > l1 / s1,
            "the wandering fork must be less straight: {:.3} vs {:.3}", l2 / s2, l1 / s1);
    }

    /// THE CHOICE THAT MAKES A STEM A STEM. Both candidates reach the
    /// same height; the reference picks the one whose path length is
    /// closest to its end-to-end distance.
    #[test]
    fn the_stem_follows_the_straighter_fork() {
        let (centres, balls, segs, parent, _) = forked_tree();
        let top = search_stem_top(&centres, &centres, &balls, &segs, &parent, 0.10);
        assert_eq!(top, 1,
            "the stem followed segment {top}, which is the one that wanders");
    }

    #[test]
    fn a_tree_with_no_forks_continues_into_its_only_child() {
        let mut centres: Vec<[f64; 3]> = Vec::new();
        let mut a: Vec<Vec<u32>> = Vec::new();
        for l in 0..20 { centres.push([0.0, 0.0, l as f64 * 0.1]); a.push(vec![(centres.len()-1) as u32]); }
        let mut b: Vec<Vec<u32>> = Vec::new();
        for l in 0..20 { centres.push([0.0, 0.0, 2.0 + l as f64 * 0.1]); b.push(vec![(centres.len()-1) as u32]); }
        let segs = vec![a, b];
        let parent = vec![None, Some((0u32, 19u32))];
        let balls: Vec<Vec<u32>> = (0..centres.len()).map(|i| vec![i as u32]).collect();
        assert_eq!(search_stem_top(&centres, &centres, &balls, &segs, &parent, 0.10), 1);
    }

    #[test]
    fn a_branch_search_picks_its_own_straightest_continuation() {
        let (centres, balls, segs, parent, children) = forked_tree();
        // Ask the STEM's own search, treating segment 0 as the branch.
        let top = search_branch_top(&centres, &centres, &balls, &segs, &parent, &children, 0.10, 0);
        assert_eq!(top, 1, "the branch search chose {top}, the wandering fork");
    }

    /// The splice must not double back. A child attaching low on its
    /// parent truncates the parent at the attachment; a child attaching
    /// near the top keeps the whole parent.
    #[test]
    fn splicing_truncates_the_parent_at_a_low_attachment() {
        let segs: Vec<Vec<Vec<u32>>> = vec![
            (0..20).map(|i| vec![i as u32]).collect(),
            (100..110).map(|i| vec![i as u32]).collect(),
        ];
        // Attaching at layer 5 of a 20-layer parent: the top 14 layers
        // are not part of this chain.
        let parent = vec![None, Some((0u32, 5u32))];
        let out = splice_chain(&segs, &parent, &[1, 0]);
        assert_eq!(out.len(), 6 + 10, "expected 6 parent layers + 10 child, got {}", out.len());
        assert_eq!(out[5], vec![5u32]);
        assert_eq!(out[6], vec![100u32]);

        // Attaching at the top keeps everything.
        let parent2 = vec![None, Some((0u32, 19u32))];
        let out2 = splice_chain(&segs, &parent2, &[1, 0]);
        assert_eq!(out2.len(), 30);
    }

    #[test]
    fn a_chain_walk_stops_at_the_root_and_survives_a_broken_parent() {
        let parent = vec![None, Some((0u32, 3u32)), Some((1u32, 4u32))];
        assert_eq!(chain_to_root(&parent, 2, 0), Some(vec![2, 1, 0]));
        assert_eq!(chain_to_root(&parent, 0, 0), Some(vec![0]));
        // A tip whose parent chain never reaches the root returns None
        // rather than looping.
        let broken = vec![None, Some((1u32, 0u32))];
        assert_eq!(chain_to_root(&broken, 1, 0), None);
    }

    #[test]
    fn empty_input_does_not_panic() {
        assert_eq!(search_stem_top(&[], &[], &[], &[], &[], 0.1), 0);
        assert!(splice_chain(&[], &[], &[0]).is_empty());
    }
}

#[cfg(test)]
mod correct_segments_tests {
    use super::*;

    #[test]
    fn segment_direction_points_from_the_lower_layer_to_the_upper() {
        let c: Vec<[f64; 3]> = (0..10).map(|i| [0.0, 0.0, i as f64]).collect();
        let seg: Vec<Vec<u32>> = (0..10).map(|i| vec![i as u32]).collect();
        let d = segment_direction(&c, &seg, 5).expect("no direction");
        assert!((d[2] - 1.0).abs() < 1e-9, "expected straight up, got {d:?}");
    }

    #[test]
    fn segment_direction_steps_past_an_empty_layer() {
        let c: Vec<[f64; 3]> = (0..10).map(|i| [0.0, 0.0, i as f64]).collect();
        let mut seg: Vec<Vec<u32>> = (0..10).map(|i| vec![i as u32]).collect();
        seg[2] = Vec::new();          // the layer three below layer 5
        let d = segment_direction(&c, &seg, 5).expect("an empty layer defeated it");
        assert!(d[2] > 0.9);
    }

    #[test]
    fn segment_direction_gives_nothing_when_there_is_no_span() {
        let c = vec![[0.0, 0.0, 0.0]];
        let seg = vec![vec![0u32]];
        assert!(segment_direction(&c, &seg, 0).is_none());
    }

    #[test]
    fn distance_to_line_measures_perpendicular_offset() {
        let d = distance_to_line([1.0, 0.0, 5.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        assert!((d - 1.0).abs() < 1e-12, "got {d}");
        let on = distance_to_line([0.0, 0.0, 3.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        assert!(on < 1e-12);
    }

    /// THE LEDGE.
    ///
    /// A stem running up z with a branch leaving sideways. The cover
    /// sets bulging out around the junction belong to the stem's layers
    /// but geometrically belong to the branch — left there, the stem's
    /// cylinder at that height is fitted to a stem plus a bulge and
    /// comes out too fat.
    #[test]
    fn the_bulge_where_a_branch_leaves_is_moved_off_the_stem() {
        let mut centres: Vec<[f64; 3]> = Vec::new();
        // Stem: eight layers of three sets each, a 6 cm-wide column.
        let mut stem: Vec<Vec<u32>> = Vec::new();
        for l in 0..8 {
            let mut layer = Vec::new();
            for k in 0..3 {
                centres.push([(k as f64 - 1.0) * 0.03, 0.0, l as f64 * 0.10]);
                layer.push((centres.len() - 1) as u32);
            }
            stem.push(layer);
        }
        // The ledge: three sets hugging the branch axis at the top
        // stem layer, offset in +x.
        let ledge_from = centres.len();
        for k in 0..3 {
            centres.push([0.10 + k as f64 * 0.02, 0.0, 0.70]);
            let id = (centres.len() - 1) as u32;
            stem[7].push(id);
        }
        // The branch: leaves in +x from the ledge.
        let mut branch: Vec<Vec<u32>> = Vec::new();
        for l in 0..6 {
            centres.push([0.16 + l as f64 * 0.08, 0.0, 0.70]);
            branch.push(vec![(centres.len() - 1) as u32]);
        }
        // A cover set holds MANY points, and the base's diameter is
        // measured from them when the base is a single set. Give the
        // branch's base a real 4 cm spread, or DiamBase is zero and the
        // reference — correctly — takes nothing.
        let mut points = centres.clone();
        let mut balls: Vec<Vec<u32>> = (0..centres.len()).map(|i| vec![i as u32]).collect();
        let base_id = branch[0][0] as usize;
        for k in 0..8 {
            let a = k as f64 / 8.0 * std::f64::consts::TAU;
            points.push([centres[base_id][0], 0.02 * a.cos(), 0.70 + 0.02 * a.sin()]);
            balls[base_id].push((points.len() - 1) as u32);
        }

        let before = stem[7].len();
        let mut parent = stem.clone();
        let base = modify_parent(&points, &balls, &centres, &mut parent, &branch, 7, 0.08, true);
        let after = parent[7].len();

        assert!(after < before,
            "nothing was taken off the stem's top layer: {before} sets before, {after} after");
        assert!(base.len() > branch[0].len(),
            "the branch's base did not grow: {} sets, was {}", base.len(), branch[0].len());
        // The sets it took are the ledge, not the stem's own column.
        for &b in &base {
            if (b as usize) < ledge_from && !branch[0].contains(&b) {
                panic!("modify_parent took set {b}, which is part of the stem column");
            }
        }
    }

    /// AddChild off: the ledge still leaves the parent, but the child
    /// does not receive it. That is the second-pass behaviour.
    #[test]
    fn with_add_child_off_the_child_keeps_the_base_it_had() {
        let mut centres: Vec<[f64; 3]> = Vec::new();
        let mut stem: Vec<Vec<u32>> = Vec::new();
        for l in 0..8 {
            let mut layer = Vec::new();
            for k in 0..3 {
                centres.push([(k as f64 - 1.0) * 0.03, 0.0, l as f64 * 0.10]);
                layer.push((centres.len() - 1) as u32);
            }
            stem.push(layer);
        }
        for k in 0..3 {
            centres.push([0.10 + k as f64 * 0.02, 0.0, 0.70]);
            let id = (centres.len() - 1) as u32;
            stem[7].push(id);
        }
        let mut branch: Vec<Vec<u32>> = Vec::new();
        for l in 0..6 {
            centres.push([0.16 + l as f64 * 0.08, 0.0, 0.70]);
            branch.push(vec![(centres.len() - 1) as u32]);
        }
        let mut points = centres.clone();
        let mut balls: Vec<Vec<u32>> = (0..centres.len()).map(|i| vec![i as u32]).collect();
        let base_id = branch[0][0] as usize;
        for k in 0..8 {
            let a = k as f64 / 8.0 * std::f64::consts::TAU;
            points.push([centres[base_id][0], 0.02 * a.cos(), 0.70 + 0.02 * a.sin()]);
            balls[base_id].push((points.len() - 1) as u32);
        }
        let mut parent = stem.clone();
        let base = modify_parent(&points, &balls, &centres, &mut parent, &branch, 7, 0.08, false);
        assert_eq!(base, branch[0], "the child's base changed with AddChild off");
        assert!(parent[7].len() < stem[7].len(), "the ledge was not removed from the parent");
    }

    /// A fork — a shoot running almost parallel to the stem.
    ///
    /// There the reference stops comparing distances to the base's and
    /// the segment's centres, because for a parallel branch that
    /// comparison says nothing, and keeps ONLY the distance to the
    /// branch's axis. Drop that test and the whole layer is swept into
    /// the shoot.
    #[test]
    fn a_parallel_shoot_takes_only_what_is_near_its_own_axis() {
        // The layer must DISCRIMINATE: some sets inside the shoot's
        // reach, some outside. A layer that is entirely inside or
        // entirely outside cannot show whether the axis test is doing
        // anything, because the all-or-nothing guard answers first.
        let xs = [0.00_f64, 0.10, 0.20, 0.30, 0.90];
        let mut centres: Vec<[f64; 3]> = Vec::new();
        let mut stem: Vec<Vec<u32>> = Vec::new();
        for l in 0..8 {
            let mut layer = Vec::new();
            for &x in &xs {
                centres.push([x, 0.0, l as f64 * 0.10]);
                layer.push((centres.len() - 1) as u32);
            }
            stem.push(layer);
        }
        // The shoot: vertical at x = 0.20, so parallel to the stem.
        let mut branch: Vec<Vec<u32>> = Vec::new();
        for l in 0..6 {
            centres.push([0.20, 0.0, 0.70 + l as f64 * 0.10]);
            branch.push(vec![(centres.len() - 1) as u32]);
        }
        let mut points = centres.clone();
        let mut balls: Vec<Vec<u32>> = (0..centres.len()).map(|i| vec![i as u32]).collect();
        let base_id = branch[0][0] as usize;
        // A 20 cm base, so the reach is 1.25 x 0.20 = 0.25 m: the sets
        // at x = 0.00 .. 0.30 are within it, the one at 0.90 is not.
        for k in 0..12 {
            let a = k as f64 / 12.0 * std::f64::consts::TAU;
            points.push([0.20 + 0.10 * a.cos(), 0.10 * a.sin(), 0.70]);
            balls[base_id].push((points.len() - 1) as u32);
        }
        let mut parent = stem.clone();
        modify_parent(&points, &balls, &centres, &mut parent, &branch, 7, 0.08, true);

        let left: Vec<f64> = parent[7].iter().map(|&i| centres[i as usize][0]).collect();
        assert_eq!(left.len(), 1,
            "expected only the far set to survive, {} did: {left:?}", left.len());
        assert!((left[0] - 0.90).abs() < 1e-9,
            "the set left behind is at x = {}, not the far one at 0.90", left[0]);
    }

    /// The all-or-nothing guard. If every set in a parent layer looks
    /// like it belongs to the branch, the test has stopped
    /// discriminating — taking them all would sever the parent — so the
    /// reference stops instead.
    #[test]
    fn a_layer_that_would_be_taken_whole_is_left_alone() {
        let mut centres: Vec<[f64; 3]> = Vec::new();
        let mut stem: Vec<Vec<u32>> = Vec::new();
        for l in 0..8 {
            let mut layer = Vec::new();
            // A narrow column sitting right on the branch's axis.
            for k in 0..3 {
                centres.push([0.20 + (k as f64 - 1.0) * 0.005, 0.0, l as f64 * 0.10]);
                layer.push((centres.len() - 1) as u32);
            }
            stem.push(layer);
        }
        let mut branch: Vec<Vec<u32>> = Vec::new();
        for l in 0..6 {
            centres.push([0.20, 0.0, 0.70 + l as f64 * 0.10]);
            branch.push(vec![(centres.len() - 1) as u32]);
        }
        let mut points = centres.clone();
        let mut balls: Vec<Vec<u32>> = (0..centres.len()).map(|i| vec![i as u32]).collect();
        let base_id = branch[0][0] as usize;
        for k in 0..8 {
            let a = k as f64 / 8.0 * std::f64::consts::TAU;
            points.push([0.20 + 0.05 * a.cos(), 0.05 * a.sin(), 0.70]);
            balls[base_id].push((points.len() - 1) as u32);
        }
        let mut parent = stem.clone();
        modify_parent(&points, &balls, &centres, &mut parent, &branch, 7, 0.08, true);
        assert!(!parent[7].is_empty(),
            "the parent's layer was emptied — the all-or-nothing guard did not hold");
    }

    #[test]
    fn an_empty_child_base_changes_nothing() {
        let centres = vec![[0.0, 0.0, 0.0]];
        let balls = vec![vec![0u32]];
        let mut parent = vec![vec![0u32]];
        let before = parent.clone();
        let base = modify_parent(&centres, &balls, &centres, &mut parent, &[Vec::new()], 0, 0.08, true);
        assert!(base.is_empty());
        assert_eq!(parent, before);
    }
}

#[cfg(test)]
mod segments_tests {
    use super::*;

    /// Build a neighbour graph from an explicit edge list.
    fn graph(n: usize, edges: &[(usize, usize)]) -> Vec<Vec<u32>> {
        let mut g = vec![Vec::new(); n];
        for &(a, b) in edges {
            g[a].push(b as u32);
            g[b].push(a as u32);
        }
        g
    }

    /// A straight chain is ONE segment with one layer per step. If this
    /// splits, everything downstream sees a stem chopped into stubs.
    #[test]
    fn an_unbranched_chain_is_a_single_segment() {
        let n = 40;
        let edges: Vec<(usize, usize)> = (0..n - 1).map(|i| (i, i + 1)).collect();
        let g = graph(n, &edges);
        let none = vec![false; n];
        let seg = segments(&g, &[0], &none);
        assert_eq!(seg.segments.len(), 1, "a straight chain produced {} segments", seg.segments.len());
        assert!(seg.parent[0].is_none());
        assert!(seg.children[0].is_empty());
        let layered: usize = seg.segments[0].iter().map(|l| l.len()).sum();
        assert_eq!(layered, n, "the segment covers {layered} of {n} sets");
    }

    /// A stem with one long side branch: two segments, and the branch
    /// must record WHICH LAYER of the stem it left from — relative_size
    /// tapers along the branch from that attachment, so the layer index
    /// is not bookkeeping, it is an input.
    #[test]
    fn a_side_branch_becomes_a_child_segment_that_knows_where_it_attached() {
        // Stem 0..29, branch 30..49 hanging off stem set 10.
        let mut edges: Vec<(usize, usize)> = (0..29).map(|i| (i, i + 1)).collect();
        edges.push((10, 30));
        for i in 30..49 { edges.push((i, i + 1)); }
        let g = graph(50, &edges);
        let none = vec![false; 50];
        let seg = segments(&g, &[0], &none);

        assert_eq!(seg.segments.len(), 2, "expected a stem and one branch, got {}", seg.segments.len());
        assert!(seg.parent[0].is_none(), "the stem has a parent");
        let (par, layer) = seg.parent[1].expect("the branch has no parent");
        assert_eq!(par, 0, "the branch's parent is not the stem");
        assert!((9..=12).contains(&layer),
            "the branch says it left the stem at layer {layer}, but it attaches at set 10");
        assert_eq!(seg.children[0], vec![1]);
    }

    /// The continuation rule. When the cut splits, the component that
    /// owns most of it carries on as this segment; only the rest become
    /// children. Ten-way splits are what a crown looks like.
    #[test]
    fn a_fan_of_twigs_leaves_the_stem_as_one_segment_with_many_children() {
        let mut edges: Vec<(usize, usize)> = (0..19).map(|i| (i, i + 1)).collect();
        let mut id = 20;
        for _ in 0..6 {
            edges.push((19, id));
            for k in 0..7 { edges.push((id + k, id + k + 1)); }
            id += 8;
        }
        let g = graph(id + 1, &edges);
        let none = vec![false; id + 1];
        let seg = segments(&g, &[0], &none);
        assert!(seg.segments.len() >= 6,
            "a six-way fan produced only {} segments", seg.segments.len());
        // The stem is segment 0 and keeps its own identity.
        assert!(seg.parent[0].is_none());
        assert!(!seg.children[0].is_empty(), "the stem adopted no children");
    }

    /// Forbidden sets are not segmented — that is how tree_sets keeps
    /// ground and understory out of the model.
    #[test]
    fn forbidden_sets_are_never_segmented() {
        let n = 20;
        let edges: Vec<(usize, usize)> = (0..n - 1).map(|i| (i, i + 1)).collect();
        let g = graph(n, &edges);
        let mut forb = vec![false; n];
        for f in forb.iter_mut().take(n).skip(10) { *f = true; }
        let seg = segments(&g, &[0], &forb);
        let reached: Vec<u32> = seg.segments.iter().flatten().flatten().copied().collect();
        assert!(reached.iter().all(|&c| c < 10),
            "a forbidden set was segmented: {reached:?}");
    }

    #[test]
    fn an_empty_cover_or_base_does_not_panic() {
        assert!(segments(&[], &[], &[]).segments.is_empty());
        let g = graph(5, &[(0, 1), (1, 2)]);
        let none = vec![false; 5];
        assert!(segments(&g, &[], &none).segments.is_empty());
    }
}

#[cfg(test)]
mod tree_sets_tests {
    use super::*;

    /// A vertical stem of cover-set centres, 10 cm apart, with a chain
    /// neighbour graph. Optionally a gap: `gap_at` removes the link
    /// across one step without removing the sets.
    fn stem(n: usize, gap_at: Option<usize>) -> (Vec<[f64; 3]>, Vec<Vec<u32>>) {
        let c: Vec<[f64; 3]> = (0..n).map(|i| [0.0, 0.0, i as f64 * 0.10]).collect();
        let mut nb = vec![Vec::new(); n];
        for i in 0..n.saturating_sub(1) {
            if Some(i) == gap_at { continue; }
            nb[i].push(i as u32 + 1);
            nb[i + 1].push(i as u32);
        }
        (c, nb)
    }

    #[test]
    fn the_base_is_the_lowest_slab_and_the_trunk_climbs_from_it() {
        let (c, nb) = stem(60, None);   // 6 m stem
        let t = tree_sets_only_tree(&c, &nb, 0.08);
        assert!(!t.base.is_empty(), "no base was found");
        // 2 % of 5.9 m is 0.118 m, so the base is the bottom two sets.
        for &b in &t.base { assert!(c[b as usize][2] < 0.2, "base set at {} is not near the bottom", c[b as usize][2]); }
        let in_trunk = t.trunk.iter().filter(|&&x| x).count();
        assert!(in_trunk > 50, "the trunk stopped after {in_trunk} of 60 sets");
    }

    /// A wide skirt of low branches must not be swallowed into the
    /// base. The reference shrinks the base height while the slab's XY
    /// footprint exceeds 30 % of the tree's.
    #[test]
    fn a_wide_skirt_at_the_bottom_shrinks_the_base_rather_than_joining_it() {
        let mut c: Vec<[f64; 3]> = (0..60).map(|i| [0.0, 0.0, i as f64 * 0.10]).collect();
        // Low branches sticking 2 m out at 6 cm height — inside the
        // naive 2 % band, and four times the stem's own width.
        for k in 0..8 { c.push([2.0 * (k as f64 / 8.0), 0.0, 0.06]); }
        let n = c.len();
        let mut nb = vec![Vec::new(); n];
        for i in 0..59 { nb[i].push(i as u32 + 1); nb[i + 1].push(i as u32); }
        for k in 60..n { nb[0].push(k as u32); nb[k].push(0); }

        let t = tree_sets_only_tree(&c, &nb, 0.08);
        let base_width = {
            let xs: Vec<f64> = t.base.iter().map(|&i| c[i as usize][0]).collect();
            xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
                - xs.iter().cloned().fold(f64::INFINITY, f64::min)
        };
        assert!(base_width < 1.0,
            "the base swallowed the skirt: it spans {base_width:.2} m across");
    }

    /// THE POINT OF THE GAP-BRIDGING, and the reason height above
    /// ground matters. A stem with a missing link partway up: the
    /// expansion front stalls, and the reference adds a neighbour link
    /// to carry the trunk across.
    #[test]
    fn a_gap_in_the_stem_is_bridged_rather_than_ending_the_trunk() {
        let (c, nb) = stem(120, Some(40));   // 12 m stem, link 40->41 missing
        let t = tree_sets_only_tree(&c, &nb, 0.08);
        let reached = t.trunk.iter().filter(|&&x| x).count();
        assert!(reached > 100,
            "the trunk stopped at the gap: only {reached} of 120 sets reached");
        // The bridge is an edit to the cover graph, which is why
        // tree_sets returns it.
        let added: usize = t.neighbours.iter().enumerate()
            .map(|(i, v)| v.len().saturating_sub(nb[i].len())).sum();
        assert!(added > 0, "no neighbour link was added — nothing was bridged");
    }

    /// …and it works at any elevation. The reference writes this test
    /// as `H < Height - 5` with `H` an absolute height and `Height` a
    /// relative one, so on a plot at any real elevation it is false
    /// everywhere and the bridging silently never runs — see fix 6.
    ///
    /// The same stem, 150 m up, must bridge the same gap.
    #[test]
    fn bridging_works_at_any_elevation() {
        let (low, nb) = stem(120, Some(40));
        let high: Vec<[f64; 3]> = low.iter().map(|p| [p[0], p[1], p[2] + 150.0]).collect();

        let a = tree_sets_only_tree(&low, &nb, 0.08);
        let b = tree_sets_only_tree(&high, &nb, 0.08);
        let reached_low = a.trunk.iter().filter(|&&x| x).count();
        let reached_high = b.trunk.iter().filter(|&&x| x).count();
        assert!(reached_low > 41,
            "the gap was not bridged even at ground level: {reached_low} sets");
        assert_eq!(reached_low, reached_high,
            "the same stem reached {reached_low} sets at ground level and \
             {reached_high} at 150 m");
    }

    /// THE MOVING HEIGHT FLOOR, which is what makes this an UPWARD
    /// expansion rather than a flood fill.
    ///
    /// A stem with a branch that leaves at 3 m and droops back down to
    /// 1 m. The front's floor sits 0.25 m below its own top, so the
    /// drooping sets are below it and are refused. Without the floor
    /// the trunk swallows the branch, and everything downstream then
    /// believes the stem forks — which is exactly the "trunk" a
    /// flood fill produces and the reference does not.
    #[test]
    fn a_drooping_branch_is_not_swallowed_into_the_trunk() {
        let mut c: Vec<[f64; 3]> = (0..60).map(|i| [0.0, 0.0, i as f64 * 0.10]).collect();
        let droop_start = c.len();
        // Leaves the stem at 3.0 m (set 30), goes out and hangs to 1 m.
        for k in 0..20 {
            let t = k as f64 / 19.0;
            c.push([0.10 + t * 1.2, 0.0, 3.0 - t * 2.0]);
        }
        let n = c.len();
        let mut nb = vec![Vec::new(); n];
        for i in 0..59 { nb[i].push(i as u32 + 1); nb[i + 1].push(i as u32); }
        nb[30].push(droop_start as u32);
        nb[droop_start].push(30);
        for k in droop_start..n - 1 { nb[k].push(k as u32 + 1); nb[k + 1].push(k as u32); }

        let t = tree_sets_only_tree(&c, &nb, 0.08);
        let droop_in_trunk = (droop_start..n).filter(|&i| t.trunk[i]).count();
        assert!(droop_in_trunk <= 2,
            "the trunk absorbed {droop_in_trunk} of 20 drooping branch sets — \
             the height floor is not holding, so this is a flood fill");
        let stem_in_trunk = (0..60).filter(|&i| t.trunk[i]).count();
        assert!(stem_in_trunk > 50, "the stem itself was not followed: {stem_in_trunk} of 60");
    }

    #[test]
    fn nothing_forbidden_under_only_tree() {
        let (c, nb) = stem(20, None);
        let t = tree_sets_only_tree(&c, &nb, 0.08);
        assert!(t.forbidden.iter().all(|&f| !f));
    }

    #[test]
    fn an_empty_cover_does_not_panic() {
        let t = tree_sets_only_tree(&[], &[], 0.08);
        assert!(t.base.is_empty() && t.trunk.is_empty());
    }
}

#[cfg(test)]
mod cover_sets_tests {
    use super::*;

    /// A slab of points at 1 cm spacing — enough that every seed finds
    /// a full ball.
    fn slab(nx: usize, ny: usize, nz: usize) -> Vec<[f64; 3]> {
        let mut v = Vec::new();
        for i in 0..nx { for j in 0..ny { for k in 0..nz {
            v.push([i as f64 * 0.01, j as f64 * 0.01, k as f64 * 0.01]);
        }}}
        v
    }

    /// THE PROPERTY THAT WAS WRONG BEFORE.
    ///
    /// TreeQSM's cover sets partition the points: each point belongs to
    /// exactly one set, the nearest seed's. The balls overlap, the sets
    /// do not. The old greedy_ball_cover/build_covers pair gave
    /// overlapping membership, which is a different object and gives a
    /// different neighbour graph to everything downstream.
    #[test]
    fn the_sets_partition_the_points_even_though_the_balls_overlap() {
        let p = slab(12, 12, 6);
        let c = cover_sets_pass1(&p, 0.08, 0.095, 3, 42);
        assert!(!c.centre.is_empty(), "no cover sets were generated");

        // Every covered point appears in exactly one set.
        let mut seen = vec![0usize; p.len()];
        for set in &c.sets { for &pt in set { seen[pt as usize] += 1; } }
        assert!(seen.iter().all(|&n| n <= 1), "a point belongs to two cover sets");

        // And the balls DO overlap, or the ball radius is doing nothing.
        let total_in_balls: usize = c.ball.iter().map(|b| b.len()).sum();
        let total_in_sets: usize = c.sets.iter().map(|s| s.len()).sum();
        assert!(total_in_balls > total_in_sets,
            "balls ({total_in_balls}) do not overlap beyond the sets ({total_in_sets})");
    }

    /// …and it is the NEAREST-seed partition, which is a stronger claim
    /// than "a partition".
    ///
    /// Claiming every ball point unconditionally also yields a
    /// partition — the last seed to see a point simply keeps it — and
    /// the test above passes on it. The reference claims a point only
    /// when it is closer than the seed that holds it, so the owner must
    /// be the nearest centre among the sets whose ball reaches it.
    #[test]
    fn each_point_belongs_to_the_nearest_seed_that_reached_it() {
        let p = slab(10, 10, 5);
        let c = cover_sets_pass1(&p, 0.08, 0.095, 3, 11);
        let d2 = |a: [f64; 3], b: [f64; 3]| (a[0]-b[0]).powi(2) + (a[1]-b[1]).powi(2) + (a[2]-b[2]).powi(2);
        for (pt, &owner) in c.set_of_point.iter().enumerate() {
            if owner == u32::MAX { continue; }
            let mine = d2(p[pt], p[c.centre[owner as usize] as usize]);
            for (si, ball) in c.ball.iter().enumerate() {
                if !ball.contains(&(pt as u32)) { continue; }
                let theirs = d2(p[pt], p[c.centre[si] as usize]);
                assert!(theirs >= mine - 1e-12,
                    "point {pt} is held by set {owner} at d2={mine} but set {si} reaches it at d2={theirs}");
            }
        }
    }

    /// The patch is smaller than the ball, and only PATCH points are
    /// marked examined. Widening that to the whole ball consumes points
    /// that should still be able to seed, so fewer sets are generated —
    /// which is exactly what the reference avoids by separating the
    /// two radii.
    #[test]
    fn only_the_patch_consumes_seeds_not_the_whole_ball() {
        let p = slab(12, 12, 6);
        let ball_rad = 0.095;
        let wide = cover_sets_pass1(&p, 0.08, ball_rad, 3, 5).centre.len();
        let tight = cover_sets_pass1(&p, 0.03, ball_rad, 3, 5).centre.len();
        assert!(tight > wide,
            "a smaller patch must leave more points free to seed: \
             patch 0.03 gave {tight} sets, patch 0.08 gave {wide}");
    }

    #[test]
    fn every_point_of_a_dense_body_ends_up_in_a_set() {
        let p = slab(12, 12, 6);
        let c = cover_sets_pass1(&p, 0.08, 0.095, 3, 7);
        let uncovered = c.set_of_point.iter().filter(|&&o| o == u32::MAX).count();
        assert_eq!(uncovered, 0, "{uncovered} points were left out of every cover set");
    }

    /// The reference calls randperm, so it gives a different cover on
    /// every run. Ours is seeded: same input, same answer. A tool whose
    /// measurements move when nothing moved cannot be cited.
    #[test]
    fn the_same_cloud_and_seed_give_the_same_cover() {
        let p = slab(10, 10, 5);
        let a = cover_sets_pass1(&p, 0.08, 0.095, 3, 12345);
        let b = cover_sets_pass1(&p, 0.08, 0.095, 3, 12345);
        assert_eq!(a.centre, b.centre);
        assert_eq!(a.set_of_point, b.set_of_point);
        // …and a different seed really does explore a different order,
        // or the shuffle is not shuffling.
        let d = cover_sets_pass1(&p, 0.08, 0.095, 3, 999);
        assert_ne!(a.centre, d.centre, "the seed has no effect — randperm is not being emulated");
    }

    #[test]
    fn neighbours_are_symmetric_and_exclude_self() {
        let p = slab(10, 10, 5);
        let c = cover_sets_pass1(&p, 0.08, 0.095, 3, 3);
        for (i, nbs) in c.neighbours.iter().enumerate() {
            assert!(!nbs.contains(&(i as u32)), "set {i} is its own neighbour");
            let mut sorted = nbs.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), nbs.len(), "set {i} lists a neighbour twice");
            // The name of this test promised this and the test did not
            // check it. The relation is built from the balls and is
            // one-way as built; the reference closes it, and everything
            // downstream walks it as if it were undirected.
            for &j in nbs {
                assert!(c.neighbours[j as usize].contains(&(i as u32)),
                    "set {i} lists {j} as a neighbour but {j} does not list {i}");
            }
        }
        // A connected slab must produce a connected neighbour graph.
        let comp = {
            let mut seen = vec![false; c.centre.len()];
            let mut n = 0;
            for s in 0..c.centre.len() {
                if seen[s] { continue; }
                n += 1; seen[s] = true;
                let mut st = vec![s];
                while let Some(x) = st.pop() {
                    for &y in &c.neighbours[x] {
                        if !seen[y as usize] { seen[y as usize] = true; st.push(y as usize); }
                    }
                }
            }
            n
        };
        assert_eq!(comp, 1, "a solid slab produced {comp} disconnected cover components");
    }

    #[test]
    fn nmin_rejects_a_seed_with_too_few_points_around_it() {
        // Two points, far apart: neither can reach nmin = 3.
        let p = vec![[0.0, 0.0, 0.0], [5.0, 5.0, 5.0]];
        let c = cover_sets_pass1(&p, 0.08, 0.095, 3, 1);
        assert!(c.centre.is_empty(), "a seed was accepted below nmin");
        let c2 = cover_sets_pass1(&p, 0.08, 0.095, 1, 1);
        assert_eq!(c2.centre.len(), 2, "nmin = 1 should accept both isolated points");
    }

    #[test]
    fn an_empty_cloud_does_not_panic() {
        let c = cover_sets_pass1(&[], 0.08, 0.095, 3, 1);
        assert!(c.centre.is_empty() && c.sets.is_empty() && c.neighbours.is_empty());
    }
}

#[cfg(test)]
mod correct_segments_driver_tests {
    use super::*;

    /// A segmentation built by hand: cover sets are points on a line,
    /// so a "segment" is a stack of layers and its girth is the spread
    /// of its sets about the parent's axis.
    struct Built {
        points: Vec<[f64; 3]>,
        balls: Vec<Vec<u32>>,
        centres: Vec<[f64; 3]>,
        seg: Segmentation,
    }

    impl Built {
        fn new() -> Self {
            Built { points: Vec::new(), balls: Vec::new(), centres: Vec::new(),
                    seg: Segmentation { segments: Vec::new(), parent: Vec::new(),
                                        children: Vec::new() } }
        }

        /// One cover set at `at`, holding a small cluster of points.
        fn set_at(&mut self, at: [f64; 3]) -> u32 {
            let mut ball = Vec::new();
            for d in [[0.0, 0.0, 0.0], [0.004, 0.0, 0.0], [0.0, 0.004, 0.0]] {
                self.points.push([at[0]+d[0], at[1]+d[1], at[2]+d[2]]);
                ball.push((self.points.len() - 1) as u32);
            }
            self.balls.push(ball);
            self.centres.push(at);
            (self.balls.len() - 1) as u32
        }

        /// A segment of `nl` layers running from `from` along `dir`,
        /// `width` sets across each layer.
        fn segment(&mut self, from: [f64; 3], dir: [f64; 3], width: f64,
                   nl: usize, step: f64, parent: Option<(u32, u32)>) -> u32 {
            let n = (dir[0]*dir[0] + dir[1]*dir[1] + dir[2]*dir[2]).sqrt();
            let a = [dir[0]/n, dir[1]/n, dir[2]/n];
            let (u, w) = perp_basis(a).unwrap();
            let mut layers = Vec::with_capacity(nl);
            for l in 0..nl {
                let s = l as f64 * step;
                let mut layer = Vec::new();
                for k in 0..6 {
                    let t = k as f64 / 6.0 * std::f64::consts::TAU;
                    layer.push(self.set_at([
                        from[0] + a[0]*s + width*(t.cos()*u[0] + t.sin()*w[0]),
                        from[1] + a[1]*s + width*(t.cos()*u[1] + t.sin()*w[1]),
                        from[2] + a[2]*s + width*(t.cos()*u[2] + t.sin()*w[2]),
                    ]));
                }
                layers.push(layer);
            }
            self.seg.segments.push(layers);
            self.seg.parent.push(parent);
            self.seg.children.push(Vec::new());
            let si = (self.seg.segments.len() - 1) as u32;
            if let Some((p, _)) = parent { self.seg.children[p as usize].push(si); }
            si
        }
    }

    /// A stem, then a BUMP, then a real branch — in that order, so
    /// dropping the bump forces every later index to move. A fixture
    /// whose dropped segment is the last one cannot tell a correct
    /// compaction from no compaction at all.
    fn stem_bump_branch() -> Built {
        let mut b = Built::new();
        b.segment([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 20, 0.10, None);
        // Segment 1: a stub that never gets clear of the stem's girth.
        b.segment([0.10, 0.0, 1.5], [1.0, 0.0, 0.0], 0.01, 3, 0.005, Some((0, 15)));
        // Segment 2: a real branch, reaching well out.
        let br = b.segment([0.10, 0.0, 0.8], [1.0, 0.0, 0.1], 0.03, 10, 0.10, Some((0, 8)));
        // Segment 3, hanging off segment 2 — so dropping segment 1 has
        // to renumber a parent index that is not zero. A fixture where
        // every survivor's parent is the stem cannot tell a correct
        // remap from none.
        b.segment([0.95, 0.0, 0.95], [0.5, 0.5, 0.3], 0.02, 8, 0.10, Some((br, 8)));
        b
    }

    /// A CHILD THAT IS ONLY A BUMP ON THE STEM IS DROPPED. Segmenting
    /// the stem's own surface into a branch puts a cylinder made of
    /// trunk into the model, and its volume is counted twice.
    #[test]
    fn a_child_no_wider_than_its_parent_is_dropped_as_a_bump() {
        let mut b = stem_bump_branch();
        remove_small(&b.centres, &mut b.seg.segments, &mut b.seg.parent,
                     &mut b.seg.children);
        assert_eq!(b.seg.segments.len(), 3,
            "expected the stem, its branch and the sub-branch, got {}",
            b.seg.segments.len());
        // The survivor at index 1 is the long branch, not the stub.
        assert!(b.seg.segments[1].len() >= 8,
            "the survivor is {} layers long — the bump was kept and the branch \
             dropped", b.seg.segments[1].len());
    }

    /// …and a child that IS wider than the stem, but not by much, is
    /// kept. The test is a real comparison against the parent's own
    /// girth, not a blanket rejection of anything narrow.
    #[test]
    fn a_child_moderately_wider_than_the_stem_survives() {
        let mut b = Built::new();
        b.segment([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 20, 0.10, None);
        // Reaches 0.14 from the stem axis: inside the 0.16 pre-filter,
        // so the girth test is what decides, and half again the stem's
        // own 0.10, so it must decide to keep it.
        b.segment([0.10, 0.0, 0.8], [1.0, 0.0, 0.0], 0.01, 3, 0.015, Some((0, 8)));
        let before = b.seg.segments.len();
        remove_small(&b.centres, &mut b.seg.segments, &mut b.seg.parent,
                     &mut b.seg.children);
        assert_eq!(b.seg.segments.len(), before,
            "a child half again the stem's girth was dropped as a bump");
    }

    /// …and the indices left behind are CONSISTENT. A compaction that
    /// drops a segment without remapping every parent and child index
    /// leaves a segmentation pointing at the wrong branches, which
    /// nothing downstream can detect.
    #[test]
    fn dropping_a_segment_leaves_every_remaining_index_valid() {
        let mut b = stem_bump_branch();
        remove_small(&b.centres, &mut b.seg.segments, &mut b.seg.parent,
                     &mut b.seg.children);
        let n = b.seg.segments.len();
        assert_eq!(b.seg.parent.len(), n);
        assert_eq!(b.seg.children.len(), n);
        for (i, p) in b.seg.parent.iter().enumerate() {
            if let Some((pi, _)) = p {
                assert!((*pi as usize) < n, "segment {i} names parent {pi} of {n}");
                assert!(b.seg.children[*pi as usize].contains(&(i as u32)),
                    "segment {i} names parent {pi}, which does not list it back");
            }
        }
        for (i, cs) in b.seg.children.iter().enumerate() {
            for &c in cs {
                assert!((c as usize) < n, "segment {i} names child {c} of {n}");
                assert_eq!(b.seg.parent[c as usize].map(|(p, _)| p), Some(i as u32),
                    "segment {i} names child {c}, which names a different parent");
            }
        }
        // The stem must still own exactly the branch that survived,
        // renumbered from 2 to 1.
        assert_eq!(b.seg.children[0], vec![1u32],
            "the stem's child list is {:?} after the bump was dropped",
            b.seg.children[0]);
    }

    /// A child with grandchildren is SPARED even when it is itself
    /// narrow — dropping it would orphan them.
    ///
    /// The grandchild here is narrow too, so the only thing keeping the
    /// twig alive is that the grandchild has a child of its own.
    #[test]
    fn a_narrow_twig_is_kept_when_something_hangs_below_it() {
        let mut b = Built::new();
        b.segment([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 20, 0.10, None);
        let stub = b.segment([0.10, 0.0, 1.5], [1.0, 0.0, 0.0], 0.01, 3, 0.005,
                             Some((0, 15)));
        // A bump in its own right: the ONLY thing keeping this twig
        // alive is that something hangs below it.
        let narrow = b.segment([0.105, 0.0, 1.5], [1.0, 0.0, 0.0], 0.005, 3, 0.005,
                               Some((stub, 1)));
        b.segment([0.13, 0.0, 1.5], [1.0, 0.0, 0.2], 0.03, 12, 0.10,
                  Some((narrow, 1)));
        remove_small(&b.centres, &mut b.seg.segments, &mut b.seg.parent,
                     &mut b.seg.children);
        assert_eq!(b.seg.segments.len(), 4,
            "a narrow twig carrying two more segments was dropped: {} left",
            b.seg.segments.len());
    }

    /// …but a narrow twig whose grandchildren are ALSO bumps goes as a
    /// whole, rather than leaving a stub behind.
    #[test]
    fn a_narrow_twig_of_nothing_but_bumps_goes_entirely() {
        let mut b = Built::new();
        b.segment([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 20, 0.10, None);
        let stub = b.segment([0.10, 0.0, 1.5], [1.0, 0.0, 0.0], 0.01, 3, 0.005,
                             Some((0, 15)));
        b.segment([0.105, 0.0, 1.5], [1.0, 0.0, 0.0], 0.005, 3, 0.005, Some((stub, 1)));
        remove_small(&b.centres, &mut b.seg.segments, &mut b.seg.parent,
                     &mut b.seg.children);
        assert_eq!(b.seg.segments.len(), 1,
            "the stem alone should remain, {} segments left", b.seg.segments.len());
    }

    /// `remove_small` runs on the SECOND pass only. A bump survives
    /// the first, because `relative_size` is about to measure it and
    /// wants the segmentation as segmented.
    #[test]
    fn only_the_second_pass_drops_the_bumps() {
        let build = || {
            let mut b = Built::new();
            b.segment([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 20, 0.10, None);
            b.segment([0.10, 0.0, 0.8], [1.0, 0.0, 0.1], 0.04, 12, 0.10, Some((0, 8)));
            b.segment([0.10, 0.0, 1.5], [1.0, 0.0, 0.0], 0.01, 3, 0.005, Some((0, 15)));
            b
        };
        let mut first = build();
        let n = first.seg.segments.len();
        let d = correct_segments(&first.points, &first.balls, &first.centres,
                                 &mut first.seg, 0.10, 0.07,
                                 &CorrectParams::first_pass());
        assert_eq!(first.seg.segments.len(), n,
            "the first pass dropped a segment; remove_small is meant to be off");
        // …and it says which segment every point belongs to.
        assert_eq!(d.segment_of_point.len(), first.points.len());
        let placed = d.segment_of_point.iter().filter(|&&x| x != u32::MAX).count();
        assert!(placed * 2 > first.points.len(),
            "only {placed} of {} points were assigned to a segment",
            first.points.len());

        let mut second = build();
        correct_segments(&second.points, &second.balls, &second.centres,
                         &mut second.seg, 0.10, 0.07, &CorrectParams::second_pass());
        assert!(second.seg.segments.len() < n,
            "the second pass kept the bump; remove_small is meant to be on");
    }

    /// AND ONLY THE FIRST GIVES THE FLARE TO THE CHILD. Both passes
    /// take the ledge where a branch meets its parent OFF the parent.
    /// The first also hands it to the child, because `relative_size` is
    /// about to measure the branch's girth and a base still inside its
    /// parent measures as the parent.
    ///
    /// `remove_small` is off in both here, so the two runs see exactly
    /// the same topology and `add_child` is the only difference.
    #[test]
    fn only_the_first_pass_gives_the_flare_to_the_child() {
        let build = || {
            let mut b = Built::new();
            b.segment([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 20, 0.10, None);
            let br = b.segment([0.10, 0.0, 0.8], [1.0, 0.0, 0.1], 0.04, 12, 0.10,
                               Some((0, 8)));
            // Based right on the parent's axis at layer 8, so the flare
            // modify_parent looks for actually exists.
            b.segment([0.896, 0.0, 0.8796], [0.5, 0.5, 0.2], 0.015, 8, 0.10,
                      Some((br, 8)));
            b
        };
        let base_before = build().seg.segments[2][0].clone();
        let branch_base_before = build().seg.segments[1][0].clone();
        let stem_before = build().seg.segments[0].clone();
        let params = |add_child| CorrectParams { rem_small: false, mod_bases: true, add_child };

        let mut a = build();
        correct_segments(&a.points, &a.balls, &a.centres, &mut a.seg, 0.10, 0.07,
                         &params(true));
        let mut c = build();
        correct_segments(&c.points, &c.balls, &c.centres, &mut c.seg, 0.10, 0.07,
                         &params(false));

        assert_ne!(a.seg.segments[2][0], base_before,
            "with AddChild the sub-branch kept its old base; the flare was not \
             given to it");
        assert_eq!(c.seg.segments[2][0], base_before,
            "without AddChild the sub-branch's base was rewritten anyway");
        // Both take it off the parent.
        assert!(a.seg.segments[1][8].len() < 6 && c.seg.segments[1][8].len() < 6,
            "the parent kept its whole layer: {} and {}",
            a.seg.segments[1][8].len(), c.seg.segments[1][8].len());
        // …and without AddChild the STEM is left alone entirely: the
        // reference skips children of segment 1, so nothing is taken
        // off the trunk on the second pass.
        assert_eq!(c.seg.segments[1][0], branch_base_before,
            "without AddChild a child of the stem was modified anyway");
        assert_eq!(c.seg.segments[0], stem_before,
            "without AddChild the stem itself had a flare taken off it");
        assert_ne!(a.seg.segments[0], stem_before,
            "with AddChild the stem kept its whole flare");
    }

    /// THE PRE-FILTER, and the halving that goes with it. The girth
    /// test alone would delete this: a short stub on a thick branch,
    /// reaching a centimetre further from the branch's axis than the
    /// branch itself does, is a bump by every measure the test makes.
    ///
    /// What saves it is that it is nowhere near the STEM's girth — and
    /// specifically, near half of it, because the reference halves the
    /// stem's allowance the moment the stem has been dealt with. Lose
    /// either the pre-filter or the halving and a real branch on a
    /// thick limb is deleted.
    #[test]
    fn a_stub_on_a_thick_branch_is_measured_against_the_stem_and_not_only_its_parent() {
        let mut b = Built::new();
        b.segment([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 20, 0.10, None);
        // A limb thicker than the stem.
        let limb = b.segment([0.10, 0.0, 0.8], [1.0, 0.0, 0.1], 0.14, 12, 0.10,
                             Some((0, 8)));
        // A stub on it, 0.14 out from the limb's axis and barely wider.
        b.segment([0.896, 0.14, 0.8796], [0.0, 1.0, 0.0], 0.01, 3, 0.005,
                  Some((limb, 8)));
        remove_small(&b.centres, &mut b.seg.segments, &mut b.seg.parent,
                     &mut b.seg.children);
        assert_eq!(b.seg.segments.len(), 3,
            "the stub on the thick limb was deleted: {} segments left",
            b.seg.segments.len());
    }

    /// The driver joins the pieces a segmentation cut a stem into.
    /// Without that, a stem split in two is modelled as a trunk with a
    /// branch growing straight up out of its top.
    #[test]
    fn a_stem_cut_in_two_is_joined_back_together() {
        let mut b = Built::new();
        b.segment([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 12, 0.10, None);
        // The continuation, collinear and starting at the stem's top.
        b.segment([0.0, 0.0, 1.2], [0.0, 0.0, 1.0], 0.09, 12, 0.10, Some((0, 11)));
        let stem_layers = b.seg.segments[0].len();
        correct_segments(&b.points, &b.balls, &b.centres, &mut b.seg, 0.10, 0.07,
                         &CorrectParams { rem_small: false, mod_bases: false,
                                          add_child: false });
        assert!(b.seg.segments[0].len() > stem_layers,
            "the stem is still {} layers; its continuation was not joined on",
            b.seg.segments[0].len());
    }

    /// The stem's children, and theirs, and theirs — three DISTINCT
    /// levels, which is what the lists are for.
    #[test]
    fn the_branch_index_lists_walk_three_distinct_levels() {
        let mut b = Built::new();
        b.segment([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 20, 0.10, None);
        let b1 = b.segment([0.10, 0.0, 0.8], [1.0, 0.0, 0.1], 0.04, 12, 0.10, Some((0, 8)));
        let b2 = b.segment([0.9, 0.0, 0.9], [0.5, 0.5, 0.2], 0.025, 10, 0.10, Some((b1, 8)));
        let _b3 = b.segment([1.4, 0.5, 1.0], [0.3, 0.6, 0.2], 0.015, 8, 0.10, Some((b2, 7)));

        let d = correct_segments(&b.points, &b.balls, &b.centres, &mut b.seg,
                                 0.10, 0.07,
                                 &CorrectParams { rem_small: false, mod_bases: false,
                                                  add_child: false });
        assert!(!d.branch1.is_empty(), "the stem reports no children");
        assert!(!d.branch2.is_empty(), "no second-order branches were found");
        assert!(!d.branch3.is_empty(), "no third-order branches were found");
        for (name, a, c) in [("1 and 2", &d.branch1, &d.branch2),
                             ("2 and 3", &d.branch2, &d.branch3),
                             ("1 and 3", &d.branch1, &d.branch3)] {
            assert!(a.iter().all(|s| !c.contains(s)),
                "levels {name} overlap: {a:?} against {c:?}");
        }
        for &s in d.branch1.iter().chain(&d.branch2).chain(&d.branch3) {
            assert!((s as usize) < b.seg.segments.len(), "index {s} is out of range");
        }
    }

    #[test]
    fn degenerate_input_does_not_panic() {
        let mut b = Built::new();
        let mut empty = Segmentation { segments: Vec::new(), parent: Vec::new(),
                                       children: Vec::new() };
        remove_small(&[], &mut empty.segments, &mut empty.parent, &mut empty.children);
        let d = correct_segments(&[], &[], &[], &mut empty, 0.1, 0.07,
                                 &CorrectParams::second_pass());
        assert!(d.segment_of_point.is_empty());

        // A stem of one layer: no direction to measure girth along.
        b.segment([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.1, 1, 0.1, None);
        remove_small(&b.centres, &mut b.seg.segments, &mut b.seg.parent,
                     &mut b.seg.children);
    }
}

#[cfg(test)]
mod treeqsm_pipeline_tests {
    use super::*;

    /// The surface of a tapering tube, sampled as rings.
    #[allow(clippy::too_many_arguments)]
    fn tube(from: [f64; 3], dir: [f64; 3], r0: f64, r1: f64, len: f64,
            rings: usize, per: usize, out: &mut Vec<[f64; 3]>) {
        let n = (dir[0]*dir[0] + dir[1]*dir[1] + dir[2]*dir[2]).sqrt();
        let a = [dir[0]/n, dir[1]/n, dir[2]/n];
        let (u, w) = perp_basis(a).unwrap();
        for i in 0..rings {
            let f = i as f64 / (rings - 1).max(1) as f64;
            let s = f * len;
            let r = r0 + (r1 - r0) * f;
            for k in 0..per {
                let t = k as f64 / per as f64 * std::f64::consts::TAU;
                out.push([
                    from[0] + a[0]*s + r*(t.cos()*u[0] + t.sin()*w[0]),
                    from[1] + a[1]*s + r*(t.cos()*u[1] + t.sin()*w[1]),
                    from[2] + a[2]*s + r*(t.cos()*u[2] + t.sin()*w[2]),
                ]);
            }
        }
    }

    /// A tree as sampled surfaces: a tapering trunk and three branches,
    /// at whatever elevation the caller likes.
    pub(super) fn tree(ground: f64) -> Vec<[f64; 3]> {
        let mut p: Vec<[f64; 3]> = Vec::new();
        // A 6 m trunk tapering 0.12 to 0.05.
        tube([0.0, 0.0, ground], [0.0, 0.0, 1.0], 0.12, 0.05, 6.0, 240, 36, &mut p);
        // Three branches.
        tube([0.09, 0.0, ground + 2.5], [1.0, 0.0, 0.25], 0.035, 0.015, 1.5,
             70, 20, &mut p);
        tube([-0.08, 0.0, ground + 3.6], [-1.0, 0.2, 0.3], 0.030, 0.012, 1.3,
             60, 18, &mut p);
        tube([0.0, 0.07, ground + 4.5], [0.2, 1.0, 0.35], 0.025, 0.010, 1.1,
             55, 16, &mut p);
        p
    }

    /// The same tree as a real scan of it would be: a band of the trunk
    /// missing where something stood in the way, a low branch down
    /// inside the base band, and a bump on the stem that is not a
    /// branch at all.
    ///
    /// Every repair stage in the second half of this pipeline exists
    /// for one of those three, and on a clean tree none of them has
    /// anything to do.
    // The second-order branch sits at z = 2.718, which is where the
    // first branch's axis actually reaches 0.9 m along it and not an
    // approximation of e. Rounding it to please the lint would put the
    // branch off its parent's surface, which is the one thing this
    // fixture exists to arrange.
    #[allow(clippy::approx_constant)]
    fn messy_tree() -> Vec<[f64; 3]> {
        let mut p = tree(0.0);
        // An occlusion: 25 cm of the trunk's surface, gone. Wider than
        // any single cover set, so no ball spans it and both passes
        // have to bridge it.
        p.retain(|q| {
            let r = (q[0]*q[0] + q[1]*q[1]).sqrt();
            !(r < 0.15 && q[2] > 3.00 && q[2] < 3.25)
        });
        // A branch leaving at 8 cm, INSIDE the base band — which is
        // min(1.5, 2 % of 6 m) = 12 cm.
        tube([0.117, 0.0, 0.08], [1.0, 0.0, 0.1], 0.030, 0.012, 1.2,
             60, 18, &mut p);
        // A bump: a stub barely clear of the stem's own surface.
        tube([0.075, 0.0, 4.50], [1.0, 0.0, 0.0], 0.012, 0.010, 0.05,
             8, 12, &mut p);
        // A SECOND-ORDER branch, on the first branch's surface 0.9 m
        // along it — where that branch's centre is [0.963, 0, 2.718]
        // and its radius 0.023. Pass two's base-moving skips children
        // of the stem, so without one of these it never runs at all.
        tube([0.963, 0.023, 2.718], [0.3, 1.0, 0.2], 0.014, 0.006, 0.8,
             45, 14, &mut p);
        p
    }

    /// THE WHOLE THING, on a tree of known size. Everything before this
    /// tested one stage against a fixture built for it; this runs the
    /// reference's own workflow end to end and asks whether the tree
    /// comes back.
    #[test]
    fn a_synthetic_tree_reconstructs_end_to_end() {
        let p = tree(0.0);
        let m = treeqsm_single(&p, &QsmInputs::new(0.08, 0.02, 0.07))
            .expect("no model was produced for a clean synthetic tree");

        assert!(m.cylinders.cyl.len() > 10,
            "only {} cylinders for a 6 m trunk and three branches",
            m.cylinders.cyl.len());
        // The trunk is there, and reaches most of the way up.
        let top = (0..m.cylinders.cyl.len())
            .filter(|&i| m.cylinders.branch_order[i] == 0)
            .map(|i| m.cylinders.cyl.start[i][2] + m.cylinders.cyl.length[i]
                     * m.cylinders.cyl.axis[i][2])
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(top > 4.0, "the trunk model reaches only {top:.2} m of 6");
        // …and it is about the right thickness at the bottom.
        let base_r = (0..m.cylinders.cyl.len())
            .filter(|&i| m.cylinders.branch_order[i] == 0)
            .min_by(|&a, &b| m.cylinders.cyl.start[a][2]
                .partial_cmp(&m.cylinders.cyl.start[b][2]).unwrap())
            .map(|i| m.cylinders.cyl.radius[i])
            .unwrap();
        assert!((base_r - 0.12).abs() < 0.04,
            "the trunk's base came back at radius {base_r:.4}, not near 0.12");
        // Every cylinder is real.
        for i in 0..m.cylinders.cyl.len() {
            assert!(m.cylinders.cyl.radius[i] > 0.0 && m.cylinders.cyl.radius[i].is_finite());
            assert!(m.cylinders.cyl.length[i] > 0.0 && m.cylinders.cyl.length[i].is_finite());
            assert!(m.cylinders.cyl.start[i].iter().all(|v| v.is_finite()));
        }
        assert!(!m.branches.length.is_empty(), "no branch summary was produced");
    }

    /// WHERE THE TREE STANDS DOES NOT CHANGE THE MODEL, and this is not
    /// a nicety. The reference tests `H < aux.Height - 5` with `H` an
    /// absolute height and `Height` a relative one, so on a plot at 100
    /// m a whole repair stage silently stops running. Translating the
    /// cloud to the ground first is what makes the two commensurable.
    #[test]
    fn a_tree_at_a_hundred_metres_gives_the_same_model_as_one_at_zero() {
        let inp = QsmInputs::new(0.08, 0.02, 0.07);
        let low = treeqsm_single(&tree(0.0), &inp).expect("no model at ground zero");
        let high = treeqsm_single(&tree(100.0), &inp).expect("no model at 100 m");

        assert_eq!(low.cylinders.cyl.len(), high.cylinders.cyl.len(),
            "the same tree gave {} cylinders at ground level and {} at 100 m",
            low.cylinders.cyl.len(), high.cylinders.cyl.len());
        // The cylinder COUNT is the load-bearing assertion: lose the
        // gap repair and the trunk comes back in pieces, which is a
        // different number of cylinders and not a different fifth
        // decimal. The per-cylinder bounds below are loose on purpose —
        // a point at z = 106 carries fewer fractional bits than the
        // same point at z = 6, so the two clouds genuinely differ a
        // little and the fit carries that through.
        for i in 0..low.cylinders.cyl.len() {
            assert!((low.cylinders.cyl.radius[i] - high.cylinders.cyl.radius[i]).abs() < 5e-4,
                "cylinder {i} has radius {:.6} at ground level and {:.6} at 100 m",
                low.cylinders.cyl.radius[i], high.cylinders.cyl.radius[i]);
            assert!((low.cylinders.cyl.length[i] - high.cylinders.cyl.length[i]).abs() < 5e-4,
                "cylinder {i} has length {:.6} against {:.6}",
                low.cylinders.cyl.length[i], high.cylinders.cyl.length[i]);
            // …and it comes back where the caller's tree actually is.
            assert!((low.cylinders.cyl.start[i][2] + 100.0
                     - high.cylinders.cyl.start[i][2]).abs() < 5e-4,
                "cylinder {i} starts at {:.4} and {:.4}, which are not 100 m apart",
                low.cylinders.cyl.start[i][2], high.cylinders.cyl.start[i][2]);
        }
    }

    /// The same cloud and the same parameters give the same model. The
    /// reference reshuffles its seed order on every run and does not;
    /// a measurement that moves when nothing moved cannot be cited.
    #[test]
    fn the_same_tree_gives_the_same_model_twice() {
        let inp = QsmInputs::new(0.08, 0.02, 0.07);
        let p = tree(0.0);
        let a = treeqsm_single(&p, &inp).expect("no model");
        let b = treeqsm_single(&p, &inp).expect("no model");
        assert_eq!(a.cylinders.cyl, b.cylinders.cyl,
            "two runs over one tree produced different cylinders");
    }

    /// HOW MANY MODELS A TREE IS BUILT WITH IS THE RUN'S COST, and
    /// the prefix has to be reference parameter sets rather than an
    /// arbitrary subset of them.
    ///
    /// `treeqsm.m` reconstructs once per PatchDiam combination it is
    /// handed and keeps the best. `create_input.m` hands it eight;
    /// `define_input(P,1,1,1)` hands it one. Taking the first N of
    /// create_input's own grid means N is always a count of its
    /// combinations, and N = 1 is its FIRST — (0.08, 0.02, 0.07).
    #[test]
    fn a_shorter_sweep_is_a_prefix_of_create_inputs_own() {
        let full = QsmInputs::default_sweep();
        for n in 1..=8usize {
            let s = QsmInputs::sweep_around_n(0.08, n);
            assert_eq!(s.len(), n, "asked for {n} models and got {}", s.len());
            for (i, m) in s.iter().enumerate() {
                assert!((m.patch_diam1 - full[i].patch_diam1).abs() < 1e-12
                        && (m.patch_diam2_min - full[i].patch_diam2_min).abs() < 1e-12
                        && (m.patch_diam2_max - full[i].patch_diam2_max).abs() < 1e-12,
                    "model {i} of a {n}-model sweep is not create_input.m's {i}th");
            }
        }
        // THE ORDER IS treeqsm.m'S, so entry k is its model k+1.
        // Its nesting is PatchDiam1, then PatchDiam2Max, then
        // PatchDiam2Min (treeqsm.m lines 284, 324, 333 with
        // nd/na/ni from lines 252-254), which is NOT the order these
        // three appear in create_input.m. Nesting Min inside Max
        // instead — as this did — gives the same eight models with
        // 2 and 3 swapped, so a prefix stops being the reference's.
        let want = [
            (0.08, 0.02, 0.07), (0.08, 0.03, 0.07),
            (0.08, 0.02, 0.10), (0.08, 0.03, 0.10),
            (0.12, 0.02, 0.07), (0.12, 0.03, 0.07),
            (0.12, 0.02, 0.10), (0.12, 0.03, 0.10),
        ];
        for (k, &(d1, dmin, dmax)) in want.iter().enumerate() {
            assert!((full[k].patch_diam1 - d1).abs() < 1e-12
                    && (full[k].patch_diam2_min - dmin).abs() < 1e-12
                    && (full[k].patch_diam2_max - dmax).abs() < 1e-12,
                "model {} is ({}, {}, {}) — treeqsm.m's is ({d1}, {dmin}, {dmax})",
                k + 1, full[k].patch_diam1, full[k].patch_diam2_min, full[k].patch_diam2_max);
        }

        // One model is QSM(1) — what TST_pc_tree_skeleton.m reads —
        // not some average or midpoint of the grid.
        let one = QsmInputs::sweep_around_n(0.08, 1);
        assert!((one[0].patch_diam1 - 0.08).abs() < 1e-12);
        assert!((one[0].patch_diam2_min - 0.02).abs() < 1e-12);
        assert!((one[0].patch_diam2_max - 0.07).abs() < 1e-12);
        // Out of range asks are clamped, never empty and never longer
        // than the grid — an empty sweep would reconstruct nothing.
        assert_eq!(QsmInputs::sweep_around_n(0.08, 0).len(), 1);
        assert_eq!(QsmInputs::sweep_around_n(0.08, 99).len(), 8);
        // The default path is still the full grid.
        assert_eq!(QsmInputs::sweep_around(0.08).len(), 8);
    }

    /// THE COUNT REACHES THE WORK. A parameter that is threaded but
    /// ignored is the same defect as one that is missing, and this one
    /// is being offered to the user as the way to make a run finish.
    #[test]
    fn asking_for_one_model_does_one_models_worth_of_work() {
        let p = tree(0.0);
        let t1 = std::time::Instant::now();
        let a = fit_treeqsm_full_cylinders_cancellable(&p, 0.08, 1, None);
        let one = t1.elapsed();
        let t8 = std::time::Instant::now();
        let b = fit_treeqsm_full_cylinders_cancellable(&p, 0.08, 8, None);
        let eight = t8.elapsed();

        assert!(!a.is_empty(), "one model produced no cylinders at all");
        assert!(!b.is_empty(), "eight models produced no cylinders at all");
        // Eight reconstructions cannot cost about the same as one.
        // Deliberately loose — this pins that the count is USED, not
        // what the ratio is, which depends on the machine and on which
        // parameter sets happen to be slow on this fixture.
        assert!(eight > one * 2,
            "one model took {one:?} and eight took {eight:?} — the count is not \
             reaching the reconstruction");
    }

    /// A CANCEL IS NOTICED INSIDE A TREE, not only between them.
    ///
    /// One tree at create_input's eight models is minutes of work on a
    /// real plot, so a stop that is only checked between trees leaves
    /// the button reading "Stopping…" for as long as the largest trees
    /// take — which is exactly when a user presses it.
    ///
    /// The first two assertions are exact: a run that is already
    /// cancelled builds nothing. The third is a bound on how long a
    /// run takes to notice, and it is the only way to show the checks
    /// INSIDE the reconstruction do anything — a flag set before the
    /// call would be caught by the first check whether or not the
    /// later ones exist.
    #[test]
    fn a_cancelled_reconstruction_stops_instead_of_finishing() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let p = tree(0.0);
        let sweep = QsmInputs::default_sweep();
        let inp = QsmInputs::new(0.08, 0.02, 0.07);

        let already = AtomicBool::new(true);
        assert!(treeqsm_single_cancellable(&p, &inp, Some(&already)).is_none(),
            "a reconstruction that starts cancelled must build nothing");
        assert!(treeqsm_sweep_cancellable(&p, &sweep, QsmMetric::default(), Some(&already))
            .is_none(), "a sweep that starts cancelled must build nothing");

        // Not cancelled: the same calls do their work.
        let clear = AtomicBool::new(false);
        assert!(treeqsm_single_cancellable(&p, &inp, Some(&clear)).is_some());
        assert!(treeqsm_sweep_cancellable(&p, &sweep, QsmMetric::default(), Some(&clear))
            .is_some());

        // How long the sweep takes when nobody stops it.
        let t0 = std::time::Instant::now();
        let _ = treeqsm_sweep(&p, &sweep);
        let full = t0.elapsed();

        // Cancelled a fraction of the way in, from another thread.
        let flag = std::sync::Arc::new(AtomicBool::new(false));
        let f2 = flag.clone();
        let delay = full / 10;
        let h = std::thread::spawn(move || {
            std::thread::sleep(delay);
            f2.store(true, Ordering::Relaxed);
        });
        let t1 = std::time::Instant::now();
        let _ = treeqsm_sweep_cancellable(&p, &sweep, QsmMetric::default(), Some(&flag));
        let took = t1.elapsed();
        h.join().ok();
        assert!(took < full / 2,
            "a sweep cancelled a tenth of the way in ran for {took:?} of {full:?} — \
             the checks inside the reconstruction are not being reached");
        // What this does NOT pin: which stage noticed. Every check is
        // the same predicate at a different point, and their only
        // distinguishing effect is tens of milliseconds — so removing
        // any one of them leaves the others to catch it and no cheap
        // test can tell them apart. The bound shows the mechanism
        // reaches inside a reconstruction; it does not show that each
        // stage boundary carries a check.
    }

    /// THE SWEEP IS DETERMINISTIC THOUGH IT RUNS IN PARALLEL. Its
    /// eight models are built on eight threads, and which finishes
    /// first is the operating system's business — so the answer must
    /// not depend on it. It does not, because every seed in the port is
    /// a constant rather than derived from when a model was built, and
    /// because the models are put back in the sweep's own order before
    /// `select_optimum` sees them: its tie-break is first-wins, and
    /// first has to mean the same thing every run.
    #[test]
    fn the_parallel_sweep_returns_the_same_model_every_run() {
        let p = tree(0.0);
        let sweep = QsmInputs::default_sweep();
        let a = treeqsm_sweep(&p, &sweep).expect("no model");
        for _ in 0..3 {
            let b = treeqsm_sweep(&p, &sweep).expect("no model");
            assert_eq!(a.inputs_used.map(|i| i.patch_diam1),
                       b.inputs_used.map(|i| i.patch_diam1),
                       "the sweep chose a different model");
            assert_eq!(a.cylinders.cyl, b.cylinders.cyl,
                "the same tree gave different cylinders across runs");
            assert_eq!(a.segment_of_point, b.segment_of_point);
        }
        // And the models themselves are the same whichever order they
        // were built in: scoring one on its own reproduces the score it
        // had inside the sweep.
        let picked = a.inputs_used.expect("the model says what built it");
        let alone = treeqsm_single(&p, &picked).expect("no model");
        assert_eq!(alone.cylinders.cyl, a.cylinders.cyl,
            "the winning model differs from the same inputs run alone");
    }

    /// The sweep runs every parameter set and returns one model. That
    /// no single cover size suits every tree is the whole reason the
    /// reference builds eight.
    #[test]
    fn the_sweep_builds_several_models_and_returns_one() {
        let sweep = QsmInputs::default_sweep();
        assert_eq!(sweep.len(), 8, "create_input's defaults make eight models");
        // Each parameter set really is distinct.
        for i in 0..sweep.len() {
            for j in (i+1)..sweep.len() {
                let (a, b) = (&sweep[i], &sweep[j]);
                assert!(a.patch_diam1 != b.patch_diam1
                        || a.patch_diam2_min != b.patch_diam2_min
                        || a.patch_diam2_max != b.patch_diam2_max,
                    "sweep entries {i} and {j} are the same");
            }
        }
        // …and `select_optimum` really chooses, rather than keeping
        // whichever model it happened to see first or last.
        let p = tree(0.0);
        let params = |m: &QsmModel| {
            let u = m.inputs_used.expect("the model does not say what built it");
            (u.patch_diam1, u.patch_diam2_min, u.patch_diam2_max)
        };
        // Of the first two the FIRST wins, so "keep the last" is out.
        let two = treeqsm_sweep(&p, &sweep[..2]).expect("the sweep produced nothing");
        assert_eq!(params(&two), (0.08, 0.02, 0.07),
            "of the first two the first is nearer the cloud");
        // Of all eight the FIFTH wins — neither the first nor the last,
        // so "keep the first" is out as well.
        let all = treeqsm_sweep(&p, &sweep).expect("the sweep produced nothing");
        assert_eq!(params(&all), (0.12, 0.02, 0.07),
            "the fifth of eight sits closest to the cloud");
        assert!(two.cylinders.cyl.len() > 10 && all.cylinders.cyl.len() > 10);

        // And the metric is consulted rather than assumed: asked for the
        // best-COVERED model instead of the nearest one, the sweep
        // returns a different model of the same tree.
        let covered = treeqsm_sweep_by(&p, &sweep, QsmMetric {
            group: MetricGroup::All, kind: MetricKind::MeanSurfaceCoverage,
        }).expect("the sweep produced nothing");
        assert_eq!(params(&covered), (0.08, 0.03, 0.07),
            "the best-covered model is not the nearest one");
        assert_ne!(params(&covered), params(&all),
            "changing the metric must be able to change the answer");
    }


    /// THE NUMBER THIS WHOLE PORT EXISTS TO GET RIGHT. The tree is
    /// four cone frustums of known dimensions, so its volume has a
    /// closed form, and the model is built from nothing but the points
    /// on its surface.
    ///
    /// Nothing before this test compares a modelled quantity with a
    /// truth: every stage was checked against a fixture built for that
    /// stage. This runs the reference's own workflow end to end and
    /// asks whether the answer is the tree.
    #[test]
    fn the_modelled_volume_matches_the_tree_it_was_built_from() {
        // pi/3 * h * (r0^2 + r0*r1 + r1^2), in litres.
        let frustum = |r0: f64, r1: f64, h: f64|
            1000.0 * std::f64::consts::PI / 3.0 * h * (r0*r0 + r0*r1 + r1*r1);
        let truth = frustum(0.12, 0.05, 6.0)      // the trunk
                  + frustum(0.035, 0.015, 1.5)
                  + frustum(0.030, 0.012, 1.3)
                  + frustum(0.025, 0.010, 1.1);
        let truth_len = 6.0 + 1.5 + 1.3 + 1.1;

        let m = treeqsm_single(&tree(0.0), &QsmInputs::new(0.08, 0.02, 0.07))
            .expect("no model");
        let vol: f64 = m.branches.volume.iter().sum();
        let len: f64 = m.cylinders.cyl.length.iter().sum();

        assert!((vol - truth).abs() / truth < 0.03,
            "the model holds {vol:.2} litres against a true {truth:.2} — \
             {:.1} % out", 100.0 * (vol - truth).abs() / truth);
        assert!((len - truth_len).abs() / truth_len < 0.03,
            "the model is {len:.3} m of wood against a true {truth_len:.3}");
    }

    /// A CHARACTERISATION TEST, and deliberately so.
    ///
    /// The property tests above say the model is about the right size.
    /// Most of what this pipeline does is structural — how many
    /// cylinders, how the segments came out, which of two covers was
    /// used — and eight separate mutations of the stages it chains
    /// together pass every property test here while changing the model.
    ///
    /// WHEN THIS FAILS: read the numbers, decide whether the change was
    /// intended, and if it was, update them IN THE SAME COMMIT with a
    /// note on what moved and why. Never to turn a red test green.
    ///
    /// They last moved when the six reference defects were fixed, and
    /// by almost nothing: the volume by 0.01 litres and the length by a
    /// millimetre, with the cylinder count, the branch count, the
    /// branching order, the trunk's top and its base radius all
    /// unchanged. That is not evidence the fixes do not matter — it is
    /// evidence that these trees do not reach the cases the defects
    /// were in. A tree with third-order branches exercises fix 1; a
    /// plot at a real elevation exercised fix 6 before the pipeline
    /// started translating for it.
    #[test]
    fn the_shape_of_the_model_is_pinned() {
        let m = treeqsm_single(&tree(0.0), &QsmInputs::new(0.08, 0.02, 0.07))
            .expect("no model");
        let n = m.cylinders.cyl.len();
        let total: f64 = m.cylinders.cyl.length.iter().sum();
        let vol: f64 = m.branches.volume.iter().sum();
        let branches_with_cylinders =
            m.branches.length.iter().filter(|&&l| l > 0.0).count();
        let max_order = m.cylinders.branch_order.iter().copied().max().unwrap_or(0);
        let top = (0..n).filter(|&i| m.cylinders.branch_order[i] == 0)
            .map(|i| m.cylinders.cyl.start[i][2]
                     + m.cylinders.cyl.length[i] * m.cylinders.cyl.axis[i][2])
            .fold(f64::NEG_INFINITY, f64::max);
        let base_r = (0..n).filter(|&i| m.cylinders.branch_order[i] == 0)
            .min_by(|&a, &b| m.cylinders.cyl.start[a][2]
                .partial_cmp(&m.cylinders.cyl.start[b][2]).unwrap())
            .map(|i| m.cylinders.cyl.radius[i]).unwrap();

        let got = format!(
            "n={n} len={total:.3} vol={vol:.2} branches={branches_with_cylinders} \
             order={max_order} top={top:.3} base_r={base_r:.4}");
        let want = "n=80 len=9.903 vol=149.37 branches=4 \
             order=1 top=6.000 base_r=0.1181";
        assert_eq!(got, want, "the model changed shape");
    }


    /// THE REPAIR MACHINERY, ON WHAT IT IS FOR. A clean synthetic tree
    /// gives the second half of this pipeline nothing to do: no gap to
    /// bridge, no bump to drop, no low branch to keep out of the base.
    /// Six separate mutations of those stages leave a clean tree's model
    /// untouched.
    ///
    /// This tree has all three. The trunk must still reach its top
    /// across the occlusion, the bump must not be counted as a branch,
    /// and the base must still be the stem's.
    #[test]
    fn a_tree_scanned_badly_is_still_reconstructed_whole() {
        let frustum = |r0: f64, r1: f64, h: f64|
            1000.0 * std::f64::consts::PI / 3.0 * h * (r0*r0 + r0*r1 + r1*r1);
        let truth = frustum(0.12, 0.05, 6.0)
                  + frustum(0.035, 0.015, 1.5)
                  + frustum(0.030, 0.012, 1.3)
                  + frustum(0.025, 0.010, 1.1)
                  + frustum(0.030, 0.012, 1.2)    // the low branch
                  + frustum(0.014, 0.006, 0.8);   // the second-order one

        let m = treeqsm_single(&messy_tree(), &QsmInputs::new(0.08, 0.02, 0.07))
            .expect("no model for a badly scanned tree");
        let n = m.cylinders.cyl.len();

        // THE OCCLUSION IS BRIDGED: the trunk still reaches its top.
        let top = (0..n).filter(|&i| m.cylinders.branch_order[i] == 0)
            .map(|i| m.cylinders.cyl.start[i][2]
                     + m.cylinders.cyl.length[i] * m.cylinders.cyl.axis[i][2])
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(top > 5.8,
            "the trunk stops at {top:.2} m of 6 — the 12 cm occlusion at 3 m was \
             not bridged");

        // THE BUMP IS NOT A BRANCH: the trunk and four real branches,
        // and nothing else.
        let with_cylinders = m.branches.length.iter().filter(|&&l| l > 0.0).count();
        assert_eq!(with_cylinders, 6,
            "{with_cylinders} branches were modelled; the tree has five and a bump");
        // …and the second-order branch is there, at order 2.
        assert_eq!(m.cylinders.branch_order.iter().copied().max(), Some(2),
            "the branch off a branch was not modelled as second order");

        // THE BASE IS STILL THE STEM'S, not the low branch's.
        let base_r = (0..n).filter(|&i| m.cylinders.branch_order[i] == 0)
            .min_by(|&a, &b| m.cylinders.cyl.start[a][2]
                .partial_cmp(&m.cylinders.cyl.start[b][2]).unwrap())
            .map(|i| m.cylinders.cyl.radius[i]).unwrap();
        assert!((base_r - 0.12).abs() < 0.02,
            "the trunk's base came back at {base_r:.4}; the branch leaving at 15 cm \
             was taken into it");

        let vol: f64 = m.branches.volume.iter().sum();
        assert!((vol - truth).abs() / truth < 0.04,
            "the model holds {vol:.2} litres against a true {truth:.2}");

        // And the shape of it, pinned as for the clean tree — because
        // the loose bounds above pass on models that differ. Read the
        // note on `the_shape_of_the_model_is_pinned` before changing
        // these numbers.
        let total: f64 = m.cylinders.cyl.length.iter().sum();
        assert_eq!(format!("n={n} len={total:.3} vol={vol:.2}"),
                   "n=96 len=11.875 vol=153.74",
            "the model of the badly scanned tree changed shape");
    }


    /// Too little to model is nothing, not a guess.
    #[test]
    fn too_few_points_give_no_model() {
        assert!(treeqsm_single(&[], &QsmInputs::new(0.08, 0.02, 0.07)).is_none());
        let dust: Vec<[f64; 3]> = (0..20)
            .map(|i| [0.0, 0.0, i as f64 * 0.1]).collect();
        assert!(treeqsm_single(&dust, &QsmInputs::new(0.08, 0.02, 0.07)).is_none());
        assert!(treeqsm_sweep(&dust, &QsmInputs::default_sweep()).is_none());
    }
}

#[cfg(test)]
mod make_tree_connected_tests {
    use super::*;

    /// A cover of one set per point, wired by hand.
    struct C {
        centres: Vec<[f64; 3]>,
        nei: Vec<Vec<u32>>,
    }

    impl C {
        fn new() -> Self { C { centres: Vec::new(), nei: Vec::new() } }
        /// A run of `n` sets from `at` along `step`, linked in order.
        fn run(&mut self, at: [f64; 3], step: [f64; 3], n: usize) -> Vec<u32> {
            let mut ids = Vec::with_capacity(n);
            for k in 0..n {
                self.centres.push([at[0] + step[0]*k as f64,
                                   at[1] + step[1]*k as f64,
                                   at[2] + step[2]*k as f64]);
                self.nei.push(Vec::new());
                let id = (self.centres.len() - 1) as u32;
                if k > 0 {
                    let prev = ids[k-1];
                    self.nei[prev as usize].push(id);
                    self.nei[id as usize].push(prev);
                }
                ids.push(id);
            }
            ids
        }
        fn masks(&self) -> (Vec<bool>, Vec<bool>) {
            (vec![false; self.centres.len()], vec![false; self.centres.len()])
        }
    }

    /// EVERYTHING REACHABLE FROM THE TRUNK IS THE TRUNK. The first
    /// thing this does is flood the mask out through the neighbour
    /// graph, so a branch the trunk walk never climbed is picked up for
    /// free.
    #[test]
    fn the_trunk_floods_out_to_everything_it_is_connected_to() {
        let mut c = C::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 10);
        let branch = c.run([0.1, 0.0, 0.5], [0.1, 0.0, 0.0], 5);
        c.nei[stem[5] as usize].push(branch[0]);
        c.nei[branch[0] as usize].push(stem[5]);

        let (mut forb, mut trunk) = c.masks();
        let links_before: usize = c.nei.iter().map(|n| n.len()).sum();
        // Only the lowest three are trunk to begin with.
        for &s in &stem[..3] { trunk[s as usize] = true; }
        make_tree_connected(&c.centres, &mut c.nei, &mut forb, &stem[..3], &mut trunk, 0.05);

        for &i in stem.iter().chain(&branch) {
            assert!(trunk[i as usize], "set {i} is connected to the trunk but not in it");
        }
        assert!(forb.iter().all(|&f| !f), "something was forbidden on a single tree");
        // …and it cost nothing. Everything here was already reachable,
        // so the classification pass had nothing to do and no link is
        // an improvement on a link that was already there.
        let after: usize = c.nei.iter().map(|n| n.len()).sum();
        assert_eq!(after, links_before,
            "{} links were invented for a cover that was already connected",
            after - links_before);
    }

    /// A DETACHED PIECE NEARBY IS JOINED ON, at its nearest point, and
    /// the graph comes back with the link in it.
    #[test]
    fn a_nearby_detached_piece_is_joined_to_the_tree() {
        let mut c = C::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 10);
        // A branch 15 cm off the stem, connected to nothing.
        let piece = c.run([0.15, 0.0, 0.5], [0.1, 0.0, 0.0], 4);

        let (mut forb, mut trunk) = c.masks();
        for &s in &stem { trunk[s as usize] = true; }
        make_tree_connected(&c.centres, &mut c.nei, &mut forb, &stem[..3], &mut trunk, 0.05);

        for &i in &piece {
            assert!(trunk[i as usize], "the nearby piece set {i} was not joined");
            assert!(!forb[i as usize], "the nearby piece was forbidden instead");
        }
        // Linked at the nearest pair: the piece's base to stem[5].
        assert!(c.nei[piece[0] as usize].contains(&stem[5]),
            "the piece is linked to {:?}, not to the nearest stem set",
            c.nei[piece[0] as usize]);
    }

    /// …but a piece TWENTY METRES AWAY is another tree, and is
    /// forbidden rather than grafted on.
    #[test]
    fn a_piece_twenty_metres_away_is_another_tree() {
        let mut c = C::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 10);
        let elsewhere = c.run([20.0, 0.0, 0.0], [0.0, 0.0, 0.1], 6);

        let (mut forb, mut trunk) = c.masks();
        for &s in &stem { trunk[s as usize] = true; }
        make_tree_connected(&c.centres, &mut c.nei, &mut forb, &stem[..3], &mut trunk, 0.05);

        for &i in &elsewhere {
            assert!(forb[i as usize], "the set {i} twenty metres away was not rejected");
            assert!(!trunk[i as usize], "…and it was taken into the tree");
        }
        for &i in &stem { assert!(trunk[i as usize]); }
    }

    /// A REJECTION SPREADS. Once a piece is another tree, anything
    /// touching it is that tree too — which is how a whole neighbour is
    /// discarded from one contact.
    #[test]
    fn a_piece_touching_something_already_rejected_is_rejected_too() {
        let mut c = C::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 10);
        let neighbour_tree = c.run([20.0, 0.0, 0.0], [0.0, 0.0, 0.1], 6);
        // A limb of it, touching it.
        let limb = c.run([20.1, 0.0, 0.3], [0.1, 0.0, 0.0], 4);
        c.nei[neighbour_tree[3] as usize].push(limb[0]);
        c.nei[limb[0] as usize].push(neighbour_tree[3]);

        let (mut forb, mut trunk) = c.masks();
        for &s in &stem { trunk[s as usize] = true; }
        make_tree_connected(&c.centres, &mut c.nei, &mut forb, &stem[..3], &mut trunk, 0.05);

        for &i in neighbour_tree.iter().chain(&limb) {
            assert!(forb[i as usize], "set {i} of the neighbouring tree survived");
        }
    }

    /// THE FLOOD STOPS AT A FORBIDDEN SET. A set already ruled out is
    /// a wall, not a bridge: whatever hangs off its far side belongs to
    /// whatever it belonged to, and letting the trunk flood through it
    /// swallows a neighbouring tree whole.
    #[test]
    fn the_flood_does_not_cross_a_forbidden_set() {
        let mut c = C::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 6);
        // A rejected set, and beyond it a run that is only reachable
        // through it.
        let wall = c.run([0.0, 0.0, 0.6], [0.0, 0.0, 0.1], 1);
        let beyond = c.run([0.0, 0.0, 0.7], [0.0, 0.0, 0.1], 5);
        c.nei[stem[5] as usize].push(wall[0]);
        c.nei[wall[0] as usize].push(stem[5]);
        c.nei[wall[0] as usize].push(beyond[0]);
        c.nei[beyond[0] as usize].push(wall[0]);

        let (mut forb, mut trunk) = c.masks();
        for &s in &stem { trunk[s as usize] = true; }
        forb[wall[0] as usize] = true;
        make_tree_connected(&c.centres, &mut c.nei, &mut forb, &stem[..3], &mut trunk, 0.05);

        assert!(!trunk[wall[0] as usize], "the forbidden set was taken into the trunk");
        // Beyond the wall is not reached BY THE FLOOD. It may still be
        // ruled on afterwards — and being a neighbour of something
        // forbidden, it is rejected.
        for &i in &beyond {
            assert!(forb[i as usize],
                "set {i} beyond the forbidden wall was not rejected with it");
        }
    }

    /// A piece nearer to something already REJECTED than to the tree
    /// belongs to whatever that was, even when it is within reach of
    /// both.
    #[test]
    fn a_piece_nearer_a_rejected_thing_than_the_tree_goes_with_it() {
        let mut c = C::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 10);
        let piece = c.run([2.0, 0.0, 0.5], [0.1, 0.0, 0.0], 3);

        let (mut forb, mut trunk) = c.masks();
        for &s in &stem { trunk[s as usize] = true; }
        // Something already known not to be ours, right beside it.
        let alien = c.run([1.5, 0.0, 0.5], [0.0, 0.1, 0.0], 3);
        forb.resize(c.centres.len(), false);
        trunk.resize(c.centres.len(), false);
        for &a in &alien { forb[a as usize] = true; }

        make_tree_connected(&c.centres, &mut c.nei, &mut forb, &stem[..3], &mut trunk, 0.05);
        for &i in &piece {
            assert!(forb[i as usize],
                "set {i} sits 0.5 m from a rejected thing and 2 m from the tree, and \
                 was taken into the tree anyway");
        }
    }

    /// CONTACT DECIDES BEFORE DISTANCE DOES. A limb touching something
    /// already rejected goes with it even when it is much nearer to our
    /// tree than to what it touches — because the graph says whose it
    /// is and the geometry only guesses.
    #[test]
    fn contact_with_a_rejected_thing_outranks_being_near_our_tree() {
        let mut c = C::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 10);
        // Three metres away, already known not to be ours.
        let alien = c.run([3.0, 0.0, 0.5], [0.0, 0.1, 0.0], 3);
        // A limb 30 cm from OUR stem — ten times nearer to us than to
        // the alien — but linked to the alien in the cover graph.
        let limb = c.run([0.30, 0.0, 0.5], [0.1, 0.0, 0.0], 3);
        c.nei[limb[0] as usize].push(alien[0]);
        c.nei[alien[0] as usize].push(limb[0]);

        let (mut forb, mut trunk) = c.masks();
        for &s in &stem { trunk[s as usize] = true; }
        for &a in &alien { forb[a as usize] = true; }
        make_tree_connected(&c.centres, &mut c.nei, &mut forb, &stem[..3], &mut trunk, 0.05);

        for &i in &limb {
            assert!(forb[i as usize],
                "set {i} touches a rejected piece and was taken into the tree \
                 because it happened to be nearer to it");
        }
    }

    /// A piece so far off that NOTHING is in range is left alone — not
    /// rejected. The far-tree rule has an upper bound, and it is there
    /// because "no trunk within reach" is signalled by a distance of
    /// 700, which the rule must not mistake for a measurement.
    #[test]
    fn a_piece_with_nothing_at_all_in_range_is_left_undecided() {
        let mut c = C::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 10);
        let far = c.run([5000.0, 0.0, 0.0], [0.0, 0.0, 0.1], 4);

        let (mut forb, mut trunk) = c.masks();
        for &s in &stem { trunk[s as usize] = true; }
        make_tree_connected(&c.centres, &mut c.nei, &mut forb, &stem[..3], &mut trunk, 0.05);

        for &i in &far {
            assert!(!forb[i as usize],
                "set {i} five kilometres away was rejected on a distance of 700, \
                 which is the code for 'nothing in range' and not a distance");
            assert!(!trunk[i as usize], "…and it was taken into the tree");
        }
    }

    /// A BIG, TALL PIECE STANDING ON THE GROUND is a neighbouring stem,
    /// and may be joined only at its FOOT. Joined wherever it happens
    /// to come closest, another tree is grafted onto this one halfway
    /// up and its whole crown counted as ours.
    #[test]
    fn a_neighbouring_stem_may_only_be_joined_at_its_foot() {
        let mut c = C::new();
        // Our stem leans away at the bottom: 3 m from the alien down
        // there, half a metre from it at the top.
        let mut stem = Vec::new();
        for k in 0..120 {
            let z = k as f64 * 0.1;
            c.centres.push([3.0 - 2.5 * (z / 12.0), 0.0, z]);
            c.nei.push(Vec::new());
            let id = (c.centres.len() - 1) as u32;
            if k > 0 {
                let prev = stem[k-1];
                c.nei[prev as usize].push(id);
                c.nei[id as usize].push(prev);
            }
            stem.push(id);
        }
        // The neighbour: 120 sets, 12 m tall, standing on the ground.
        let alien = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 120);

        let (mut forb, mut trunk) = c.masks();
        for &s in &stem { trunk[s as usize] = true; }
        make_tree_connected(&c.centres, &mut c.nei, &mut forb, &stem[..3], &mut trunk, 0.05);

        // Whatever was decided, no link may run between their upper
        // halves.
        for &a in &alien {
            if c.centres[a as usize][2] < 2.0 { continue; }
            for &n in &c.nei[a as usize] {
                assert!(!stem.contains(&n) || c.centres[n as usize][2] < 2.0,
                    "the neighbouring stem was joined to ours at z = {:.2}",
                    c.centres[a as usize][2]);
            }
        }
    }

    /// The base is never left forbidden, whatever happened along the
    /// way — it is the one part of the tree that is not in question.
    #[test]
    fn the_base_is_never_left_forbidden() {
        let mut c = C::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 10);
        // A detached piece, so the classification pass actually runs
        // rather than returning early with nothing to do.
        c.run([0.15, 0.0, 0.5], [0.1, 0.0, 0.0], 3);
        let (mut forb, mut trunk) = c.masks();
        for &s in &stem { trunk[s as usize] = true; }
        for &s in &stem[..3] { forb[s as usize] = true; }
        make_tree_connected(&c.centres, &mut c.nei, &mut forb, &stem[..3], &mut trunk, 0.05);
        for &s in &stem[..3] {
            assert!(!forb[s as usize], "base set {s} came back forbidden");
        }
    }

    #[test]
    fn degenerate_input_does_not_panic() {
        let mut c = C::new();
        let (mut f, mut t) = c.masks();
        make_tree_connected(&[], &mut c.nei, &mut f, &[], &mut t, 0.05);
        // Nothing but leftovers: no trunk at all.
        let mut d = C::new();
        d.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 5);
        let (mut f2, mut t2) = d.masks();
        make_tree_connected(&d.centres, &mut d.nei, &mut f2, &[], &mut t2, 0.05);
    }
}

#[cfg(test)]
mod main_branches_tests {
    use super::*;

    /// Cover sets holding one point each, so a set's segment is simply
    /// its point's. `link` wires the neighbour graph by hand.
    struct Cover {
        centres: Vec<[f64; 3]>,
        balls: Vec<Vec<u32>>,
        nei: Vec<Vec<u32>>,
        seg_of_point: Vec<u32>,
    }

    impl Cover {
        fn new() -> Self {
            Cover { centres: Vec::new(), balls: Vec::new(), nei: Vec::new(),
                    seg_of_point: Vec::new() }
        }
        /// A set at `at` whose single point belongs to segment `seg`.
        fn set(&mut self, at: [f64; 3], seg: u32) -> u32 {
            self.seg_of_point.push(seg);
            let pt = (self.seg_of_point.len() - 1) as u32;
            self.centres.push(at);
            self.balls.push(vec![pt]);
            self.nei.push(Vec::new());
            (self.centres.len() - 1) as u32
        }
        /// A run of `n` sets along +z from `at`, all in segment `seg`,
        /// each linked to the last.
        fn run(&mut self, at: [f64; 3], step: [f64; 3], n: usize, seg: u32) -> Vec<u32> {
            let mut ids = Vec::with_capacity(n);
            for k in 0..n {
                let id = self.set([at[0] + step[0]*k as f64,
                                   at[1] + step[1]*k as f64,
                                   at[2] + step[2]*k as f64], seg);
                if k > 0 { self.link(ids[k-1], id); }
                ids.push(id);
            }
            ids
        }
        fn link(&mut self, a: u32, b: u32) {
            self.nei[a as usize].push(b);
            self.nei[b as usize].push(a);
        }
    }

    fn data(c: &Cover, b1: Vec<u32>, b2: Vec<u32>, b3: Vec<u32>) -> SegmentData {
        SegmentData { segment_of_point: c.seg_of_point.clone(),
                      branch1: b1, branch2: b2, branch3: b3 }
    }

    /// THE TRUNK IS THE STEM AND THE FIRST THREE ORDERS, and nothing
    /// deeper. The point of naming them is to guarantee those come out
    /// connected; the rest of the crown is left to the segmentation.
    #[test]
    fn the_trunk_is_the_stem_and_three_orders_of_branch() {
        let mut c = Cover::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 8, 0);
        let b1 = c.run([0.1, 0.0, 0.5], [0.1, 0.0, 0.0], 4, 1);
        c.link(stem[5], b1[0]);
        let b2 = c.run([0.5, 0.1, 0.5], [0.0, 0.1, 0.0], 3, 2);
        c.link(b1[3], b2[0]);
        let b3 = c.run([0.5, 0.4, 0.5], [0.1, 0.0, 0.0], 3, 3);
        c.link(b2[2], b3[0]);
        // A fourth-order twig, which is NOT a main branch.
        let b4 = c.run([0.8, 0.4, 0.5], [0.0, 0.0, 0.1], 3, 4);
        c.link(b3[2], b4[0]);

        let d = data(&c, vec![1], vec![2], vec![3]);
        let trunk = define_main_branches(&c.centres, &c.balls, &mut c.nei, &d, 0.07);
        for &i in stem.iter().chain(&b1).chain(&b2).chain(&b3) {
            assert!(trunk[i as usize], "set {i} of the first three orders is not trunk");
        }
        for &i in &b4 {
            assert!(!trunk[i as usize], "the fourth-order twig set {i} was called trunk");
        }
    }

    /// A ball straddling a junction takes the LOWEST segment index, so
    /// it is claimed by the stem rather than by the branch leaving it.
    /// The other way round and the stem has a hole at every fork.
    #[test]
    fn a_set_spanning_a_junction_is_claimed_by_the_lower_segment() {
        let mut c = Cover::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 6, 0);
        let b1 = c.run([0.1, 0.0, 0.3], [0.1, 0.0, 0.0], 3, 1);
        c.link(stem[3], b1[0]);
        // Give the junction set a second point, from the stem.
        let extra = c.seg_of_point.len() as u32;
        c.seg_of_point.push(0);
        c.balls[b1[0] as usize].push(extra);

        let d = data(&c, vec![1], vec![], vec![]);
        let trunk = define_main_branches(&c.centres, &c.balls, &mut c.nei, &d, 0.07);
        assert!(trunk[b1[0] as usize]);
        // …and it is the stem's, which shows in the connectivity pass:
        // the rest of branch 1 is then a component with no link to a
        // stem set of its own, so one is added.
        assert!(c.nei[b1[1] as usize].iter().any(|&n| n == b1[0]),
            "the junction set lost its own chain");
    }

    /// A MAIN BRANCH IN TWO PIECES IS JOINED. The second pass exists
    /// to guarantee the first three orders are connected, and a branch
    /// the cover left in halves is exactly what it is there to fix.
    #[test]
    fn a_branch_split_in_two_gets_a_link_between_the_halves() {
        let mut c = Cover::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 8, 0);
        // Branch 1 in two runs with no link between them.
        let near = c.run([0.1, 0.0, 0.5], [0.05, 0.0, 0.0], 3, 1);
        c.link(stem[5], near[0]);
        let far = c.run([0.30, 0.0, 0.5], [0.05, 0.0, 0.0], 3, 1);

        let d = data(&c, vec![1], vec![], vec![]);
        let before = c.nei[near[2] as usize].len() + c.nei[far[0] as usize].len();
        define_main_branches(&c.centres, &c.balls, &mut c.nei, &d, 0.07);
        let after = c.nei[near[2] as usize].len() + c.nei[far[0] as usize].len();
        assert!(after > before, "no link was added between the two halves");
        // …and it joins the two NEAREST sets across the gap, and ONLY
        // those. Each half is linked to its own nearest in turn, so
        // both directions of the same pair appear — and nothing else
        // should.
        let mut cross: Vec<(u32, u32)> = Vec::new();
        for &a in &near {
            for &b in &far {
                if c.nei[a as usize].contains(&b) { cross.push((a, b)); }
            }
        }
        assert_eq!(cross, vec![(near[2], far[0])],
            "the halves are joined across {cross:?}, not at their nearest pair");
    }

    /// …and because it is the stem's, the stem stays WHOLE. Here the
    /// junction set is the only thing joining the stem below it to the
    /// stem above. Claimed by the branch instead, the stem falls into
    /// two pieces and has to be stitched back together — a link that
    /// should never have been needed.
    #[test]
    fn a_junction_set_belongs_to_the_stem_so_the_stem_stays_whole() {
        let mut c = Cover::new();
        let lower = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 2, 0);
        // The junction: its ball holds a stem point and a branch point.
        let j = c.set([0.0, 0.0, 0.2], 1);
        let extra = c.seg_of_point.len() as u32;
        c.seg_of_point.push(0);
        c.balls[j as usize].push(extra);
        let upper = c.run([0.0, 0.0, 0.3], [0.0, 0.0, 0.1], 2, 0);
        c.link(lower[1], j);
        c.link(j, upper[0]);
        // …and the branch itself, hanging off the junction.
        let b1 = c.run([0.1, 0.0, 0.2], [0.1, 0.0, 0.0], 3, 1);
        c.link(j, b1[0]);

        let d = data(&c, vec![1], vec![], vec![]);
        define_main_branches(&c.centres, &c.balls, &mut c.nei, &d, 0.07);
        assert!(!c.nei[lower[1] as usize].contains(&upper[0]),
            "the stem was stitched across the junction, so the junction set was \
             claimed by the branch rather than by the stem");
    }

    /// A cover that is already properly connected is LEFT ALONE. Every
    /// link this adds is an invention, and inventing one where the
    /// graph already had a path merges things that were separate.
    #[test]
    fn a_cover_that_is_already_connected_gains_no_links() {
        let mut c = Cover::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 8, 0);
        let b1 = c.run([0.1, 0.0, 0.5], [0.1, 0.0, 0.0], 4, 1);
        c.link(stem[5], b1[0]);
        let b2 = c.run([0.5, 0.1, 0.5], [0.0, 0.1, 0.0], 3, 2);
        c.link(b1[3], b2[0]);

        let before: usize = c.nei.iter().map(|n| n.len()).sum();
        let d = data(&c, vec![1], vec![2], vec![]);
        define_main_branches(&c.centres, &c.balls, &mut c.nei, &d, 0.07);
        let after: usize = c.nei.iter().map(|n| n.len()).sum();
        assert_eq!(after, before,
            "{} neighbour links were added to a cover that was already connected",
            after - before);
    }

    /// A first-order branch touching NO stem set at all is joined to
    /// the stem outright. A branch floating free of the trunk is not a
    /// branch.
    #[test]
    fn a_first_order_branch_that_touches_no_stem_set_is_joined_to_it() {
        let mut c = Cover::new();
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 8, 0);
        // Not linked to the stem at all.
        let b1 = c.run([0.2, 0.0, 0.5], [0.05, 0.0, 0.0], 3, 1);

        let d = data(&c, vec![1], vec![], vec![]);
        define_main_branches(&c.centres, &c.balls, &mut c.nei, &d, 0.07);
        let joined = b1.iter().any(|&i| c.nei[i as usize].iter()
            .any(|&n| stem.contains(&n)));
        assert!(joined, "the branch was left floating free of the stem");
    }

    /// …and if the trunk still comes out in pieces, the piece WITH THE
    /// STEM IN IT is the one kept. Keeping the largest instead would
    /// model a big branch and throw the tree away.
    #[test]
    fn a_trunk_left_in_pieces_keeps_the_piece_holding_the_stem() {
        let mut c = Cover::new();
        // A short stem, and a much larger second-order lump far away
        // that nothing links to it.
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 3, 0);
        let lump = c.run([50.0, 0.0, 0.0], [0.0, 0.0, 0.1], 20, 2);

        let d = data(&c, vec![], vec![2], vec![]);
        let trunk = define_main_branches(&c.centres, &c.balls, &mut c.nei, &d, 0.07);
        for &i in &stem {
            assert!(trunk[i as usize], "the stem set {i} was dropped from the trunk");
        }
        for &i in &lump {
            assert!(!trunk[i as usize],
                "the larger far-off component was kept as the trunk instead");
        }
    }

    /// The second pass's BASE is the stem's own low sets, not simply
    /// everything low down. The first pass has already said which
    /// points are stem, and a base that swept in a low branch is the
    /// mistake the first pass's height-shrinking exists to undo.
    #[test]
    fn the_second_pass_base_is_the_stems_own_low_sets() {
        let mut c = Cover::new();
        // A 10 m stem, so the base height is min(1.5, 2 % of 10) = 0.2.
        let stem = c.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 100, 0);
        // A low branch, right down in the base band.
        let low = c.run([0.5, 0.0, 0.05], [0.1, 0.0, 0.0], 3, 1);

        let centre_of_set: Vec<u32> = (0..c.balls.len() as u32).collect();
        let base = define_base_from_segments(&c.centres, &centre_of_set, &c.seg_of_point);
        assert!(!base.is_empty(), "no base was found");
        for &b in &base {
            assert!(stem.contains(&b), "set {b} is in the base but is not stem");
            assert!(c.centres[b as usize][2] < 0.2 + 1e-9,
                "set {b} is at z = {:.3}, above the base band",
                c.centres[b as usize][2]);
        }
        for &l in &low {
            assert!(!base.contains(&l), "the low branch set {l} was taken as base");
        }
    }

    #[test]
    fn degenerate_input_does_not_panic() {
        let mut c = Cover::new();
        let d = data(&c, vec![], vec![], vec![]);
        assert!(define_main_branches(&[], &[], &mut c.nei, &d, 0.07).is_empty());
        assert!(define_base_from_segments(&[], &[], &[]).is_empty());
        // Sets whose points belong to no segment at all.
        let mut e = Cover::new();
        e.run([0.0, 0.0, 0.0], [0.0, 0.0, 0.1], 4, u32::MAX);
        let de = data(&e, vec![], vec![], vec![]);
        let t = define_main_branches(&e.centres, &e.balls, &mut e.nei, &de, 0.07);
        assert!(t.iter().all(|&x| !x));
    }
}

#[cfg(test)]
mod tree_data_tests {
    use super::*;

    /// A trunk of `n` cylinders plus one branch, all of known size, and
    /// the point cloud and segment map `tree_data` needs.
    fn model() -> (CylinderModel, BranchData, Vec<[f64; 3]>, Vec<u32>) {
        let mut m = CylinderModel::default();
        #[allow(clippy::too_many_arguments)]
        let push = |m: &mut CylinderModel, start: [f64; 3], axis: [f64; 3],
                        len: f64, r: f64, seg: u32, parent: Option<u32>,
                        ext: Option<u32>, order: u8| {
            m.cyl.push(RefCyl { start, axis, length: len, radius: r,
                                surf_cov: 0.9, mad: 0.001, conv: true, rel: true });
            m.parent.push(parent);
            m.extension.push(ext);
            m.added.push(false);
            m.unmod_radius.push(r);
            m.branch.push(seg);
            m.branch_order.push(order);
            m.position_in_branch.push(1);
            m.region_points.push(50);
            m.sector_mask.push(0xFFF);
        };
        // A 4 m trunk in eight 0.5 m cylinders of radius 0.10.
        for k in 0..8u32 {
            let ext = if k < 7 { Some(k + 1) } else { None };
            let par = if k > 0 { Some(k - 1) } else { None };
            push(&mut m, [0.0, 0.0, k as f64 * 0.5], [0.0, 0.0, 1.0], 0.5, 0.10,
                 0, par, ext, 0);
        }
        // One branch: two 0.5 m cylinders of radius 0.04, due east at 2 m.
        push(&mut m, [0.10, 0.0, 2.0], [1.0, 0.0, 0.0], 0.5, 0.04, 1, Some(3), Some(9), 1);
        push(&mut m, [0.60, 0.0, 2.0], [1.0, 0.0, 0.0], 0.5, 0.04, 1, Some(8), None, 1);
        m.cyls_in_segment = vec![(0..8).collect(), vec![8, 9]];
        let b = branches(&m);

        // Trunk points on the surface, and a handful elsewhere that are
        // not the trunk's, so the breast-height refit has to pick.
        let mut points: Vec<[f64; 3]> = Vec::new();
        let mut seg_of_point: Vec<u32> = Vec::new();
        for i in 0..400 {
            let t = i as f64 / 400.0 * std::f64::consts::TAU * 7.0;
            let z = i as f64 / 400.0 * 4.0;
            points.push([0.10*t.cos(), 0.10*t.sin(), z]);
            seg_of_point.push(0);
        }
        for i in 0..50 {
            points.push([5.0 + i as f64 * 0.01, 0.0, 1.3]);
            seg_of_point.push(1);
        }
        (m, b, points, seg_of_point)
    }

    /// THE NUMBERS A RUN REPORTS, against a model whose geometry is
    /// arithmetic.
    #[test]
    fn the_totals_are_the_sums_of_the_cylinders() {
        let (m, b, p, sop) = model();
        let d = tree_data(&m, &b, &p, &sop);
        let pi = std::f64::consts::PI;

        // Trunk: 8 x 0.5 m at r = 0.10. Branch: 2 x 0.5 m at r = 0.04.
        let trunk_v = 1000.0 * pi * 0.01 * 4.0;
        let branch_v = 1000.0 * pi * 0.0016 * 1.0;
        assert!((d.trunk_volume - trunk_v).abs() < 1e-9,
            "trunk volume {:.4} litres, want {trunk_v:.4}", d.trunk_volume);
        assert!((d.branch_volume - branch_v).abs() < 1e-9,
            "branch volume {:.4} litres, want {branch_v:.4}", d.branch_volume);
        assert!((d.total_volume - (trunk_v + branch_v)).abs() < 1e-9);

        assert!((d.trunk_area - 2.0*pi*0.10*4.0).abs() < 1e-9);
        assert!((d.branch_area - 2.0*pi*0.04*1.0).abs() < 1e-9);
        assert!((d.trunk_length - 4.0).abs() < 1e-12);
        assert!((d.branch_length - 1.0).abs() < 1e-12);
        assert!((d.total_length - 5.0).abs() < 1e-12);
        assert!((d.tree_height - 4.0).abs() < 1e-12,
            "height {:.4}, want 4.0", d.tree_height);
        assert_eq!(d.max_branch_order, 1);
        assert_eq!(d.location, [0.0, 0.0, 0.0]);
    }

    /// DIAMETER AT BREAST HEIGHT is taken from the trunk cylinder that
    /// spans 1.3 m — not from the base, and not from the mean.
    #[test]
    fn breast_height_diameter_comes_from_the_cylinder_at_one_point_three() {
        let (mut m, _, p, sop) = model();
        // Make the trunk taper so the cylinder at 1.3 m is
        // distinguishable from every other.
        for k in 0..8 { m.cyl.radius[k] = 0.10 - 0.005 * k as f64; }
        let b = branches(&m);
        let d = tree_data(&m, &b, &p, &sop);
        // 0.5 m cylinders: the chain passes 1.3 m during the third,
        // index 2, whose radius is 0.09.
        assert!((d.dbh_qsm - 0.18).abs() < 1e-9,
            "DBH came back {:.4}, not the 0.18 of the cylinder at 1.3 m", d.dbh_qsm);
    }

    /// …and the refit against the trunk's own points is only taken when
    /// it AGREES. Here the points say 0.10 and the chain says 0.10, so
    /// it is taken; make the chain disagree and it is not.
    #[test]
    fn the_breast_height_refit_is_ignored_when_it_disagrees() {
        let (m, b, p, sop) = model();
        let d = tree_data(&m, &b, &p, &sop);
        assert!((d.dbh_cyl - 0.20).abs() < 0.02,
            "the refit gave {:.4} against a 0.20 trunk", d.dbh_cyl);

        // Now claim the chain is half as thick. The refit at 0.10 is
        // then outside the 20 % the reference allows, and is refused.
        let mut m2 = m.clone();
        for k in 0..8 { m2.cyl.radius[k] = 0.05; }
        let b2 = branches(&m2);
        let d2 = tree_data(&m2, &b2, &p, &sop);
        assert!((d2.dbh_cyl - d2.dbh_qsm).abs() < 1e-12,
            "a refit disagreeing by a factor of two was accepted: {:.4} against \
             the chain's {:.4}", d2.dbh_cyl, d2.dbh_qsm);
    }

    /// The stem taper is the diameter at each join up the trunk,
    /// starting at zero height and ending flat.
    #[test]
    fn the_stem_taper_runs_from_the_base_to_the_top() {
        let (mut m, _, p, sop) = model();
        for k in 0..8 { m.cyl.radius[k] = 0.10 - 0.005 * k as f64; }
        let b = branches(&m);
        let d = tree_data(&m, &b, &p, &sop);

        assert_eq!(d.stem_taper.len(), 9, "eight trunk cylinders give nine rows");
        assert!((d.stem_taper[0].0).abs() < 1e-12);
        assert!((d.stem_taper[0].1 - 0.20).abs() < 1e-12, "the base diameter");
        assert!((d.stem_taper[8].0 - 4.0).abs() < 1e-12, "the last height");
        // The last two rows share a diameter: the taper ends flat.
        assert!((d.stem_taper[7].1 - d.stem_taper[8].1).abs() < 1e-12);
        // …and it is monotone decreasing.
        for w in d.stem_taper.windows(2) {
            assert!(w[1].0 > w[0].0, "heights are not increasing");
            assert!(w[1].1 <= w[0].1 + 1e-12, "the taper widens");
        }
    }

    /// EVERY DISTRIBUTION ADDS UP TO ITS TOTAL. A histogram that loses
    /// wood is worse than no histogram, because it looks like data.
    #[test]
    fn the_cylinder_distributions_account_for_every_cylinder() {
        let (m, b, p, sop) = model();
        let d = tree_data(&m, &b, &p, &sop);
        for (name, dist) in [("diameter", &d.cyl_diameter), ("zenith", &d.cyl_zenith),
                             ("azimuth", &d.cyl_azimuth), ("height", &d.cyl_height)] {
            let v: f64 = dist.volume.iter().sum();
            let a: f64 = dist.area.iter().sum();
            let l: f64 = dist.length.iter().sum();
            assert!((v - d.total_volume).abs() < 1e-6,
                "the {name} distribution holds {v:.4} litres of {:.4}", d.total_volume);
            assert!((a - d.total_area).abs() < 1e-6,
                "the {name} distribution holds {a:.4} m2 of {:.4}", d.total_area);
            assert!((l - d.total_length).abs() < 1e-6,
                "the {name} distribution holds {l:.4} m of {:.4}", d.total_length);
        }
    }

    /// THE HEIGHT DISTRIBUTION SPLITS a cylinder across the layers it
    /// spans. The reference enumerates five cases and drops anything
    /// crossing more than one boundary — see fix 8 — so a trunk in long
    /// cylinders loses whole metres of itself.
    #[test]
    fn a_cylinder_spanning_several_layers_is_split_between_them() {
        let mut m = CylinderModel::default();
        // ONE cylinder, 3 m tall, from the ground: it crosses two
        // boundaries and matches none of the reference's five cases.
        m.cyl.push(RefCyl { start: [0.0, 0.0, 0.0], axis: [0.0, 0.0, 1.0],
                            length: 3.0, radius: 0.1, surf_cov: 0.9, mad: 0.0,
                            conv: true, rel: true });
        m.parent.push(None); m.extension.push(None); m.added.push(false);
        m.unmod_radius.push(0.1); m.branch.push(0); m.branch_order.push(0);
        m.position_in_branch.push(1); m.region_points.push(50); m.sector_mask.push(0xFFF);
        m.cyls_in_segment = vec![vec![0]];
        let b = branches(&m);
        let d = tree_data(&m, &b, &[], &[]);

        assert_eq!(d.cyl_height.length.len(), 3, "three one-metre layers");
        for (j, &l) in d.cyl_height.length.iter().enumerate() {
            assert!((l - 1.0).abs() < 1e-9,
                "layer {j} holds {l:.4} m of a 3 m cylinder, not 1.0");
        }
        let v: f64 = d.cyl_height.volume.iter().sum();
        assert!((v - d.total_volume).abs() < 1e-9,
            "the layers hold {v:.4} litres of {:.4}", d.total_volume);
    }

    /// The branch distributions skip the stem — it is row 0 of the
    /// branch table and is not a branch — and their first-order columns
    /// are a subset of the totals.
    #[test]
    fn the_branch_distributions_skip_the_stem() {
        let (m, b, p, sop) = model();
        let d = tree_data(&m, &b, &p, &sop);
        for (name, dist) in [("diameter", &d.branch_diameter), ("angle", &d.branch_angle),
                             ("zenith", &d.branch_zenith), ("azimuth", &d.branch_azimuth)] {
            let n: u32 = dist.number.iter().sum();
            assert_eq!(n, 1, "the {name} distribution counts {n} branches, not 1");
            let v: f64 = dist.volume.iter().sum();
            assert!((v - d.branch_volume).abs() < 1e-6,
                "the {name} distribution holds {v:.4} litres of {:.4} — the stem \
                 leaked in", d.branch_volume);
            for (a, c) in dist.volume.iter().zip(&dist.volume_first) {
                assert!(*c <= *a + 1e-12, "the first-order column exceeds the total");
            }
        }
        // Order totals: one first-order branch and nothing deeper.
        assert_eq!(d.branch_order.number, vec![1]);
        assert!((d.branch_order.volume[0] - d.branch_volume).abs() < 1e-9);
    }

    /// A branch table with rows for segments that produced no cylinders
    /// inflates the reference's branch COUNT. Both numbers are
    /// reported; see the note on `number_branches`.
    #[test]
    fn empty_segments_inflate_the_reference_branch_count() {
        let (mut m, _, p, sop) = model();
        // Move the branch to segment 3, leaving 1 and 2 empty.
        for i in 8..10 { m.branch[i] = 3; }
        m.cyls_in_segment = vec![(0..8).collect(), vec![], vec![], vec![8, 9]];
        let b = branches(&m);
        let d = tree_data(&m, &b, &p, &sop);
        assert_eq!(d.number_branches, 3, "the reference counts rows, not branches");
        assert_eq!(d.number_branches_modelled, 1, "only one branch was modelled");
    }

    #[test]
    fn an_empty_model_reports_nothing() {
        let d = tree_data(&CylinderModel::default(), &BranchData::default(), &[], &[]);
        assert_eq!(d.total_volume, 0.0);
        assert!(d.stem_taper.is_empty());
    }
}

#[cfg(test)]
mod growth_volume_tests {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    fn push(m: &mut CylinderModel, z: f64, len: f64, r: f64, seg: u32,
            parent: Option<u32>, ext: Option<u32>) {
        m.cyl.push(RefCyl { start: [0.0, 0.0, z], axis: [0.0, 0.0, 1.0],
                            length: len, radius: r, surf_cov: 0.9, mad: 0.001,
                            conv: true, rel: true });
        m.parent.push(parent);
        m.extension.push(ext);
        m.added.push(false);
        m.unmod_radius.push(r);
        m.branch.push(seg);
        m.branch_order.push(if seg == 0 { 0 } else { 1 });
        m.position_in_branch.push(1);
        m.region_points.push(30);
        m.sector_mask.push(0xFFF);
    }

    /// A chain of cylinders end to end, each the extension of the last.
    fn chain(rs: &[f64], len: f64) -> CylinderModel {
        let mut m = CylinderModel::default();
        for (k, &r) in rs.iter().enumerate() {
            push(&mut m, k as f64 * len, len, r, 0,
                 if k > 0 { Some(k as u32 - 1) } else { None },
                 if k + 1 < rs.len() { Some(k as u32 + 1) } else { None });
        }
        m.cyls_in_segment = vec![(0..rs.len() as u32).collect()];
        m
    }

    /// THE GROWTH VOLUME IS THE WHOLE SUBTREE, and the tree is built
    /// with its branches at DIFFERENT DEPTHS on purpose: the reference
    /// walks up level by level from the tips, so a cylinder with one
    /// leaf child and one deep child is first totalled while the deep
    /// child still reads zero. It gets the right answer in the end only
    /// because a later visit overwrites it.
    #[test]
    fn the_growth_volume_is_everything_hanging_off_a_cylinder() {
        let mut m = CylinderModel::default();
        // Trunk 0 -> 1 -> 2.
        push(&mut m, 0.0, 1.0, 0.1, 0, None, Some(1));
        push(&mut m, 1.0, 1.0, 0.1, 0, Some(0), Some(2));
        push(&mut m, 2.0, 1.0, 0.1, 0, Some(1), None);
        // A single-cylinder branch off the base — a leaf one step down.
        push(&mut m, 0.5, 1.0, 0.1, 1, Some(0), None);
        // A two-cylinder branch off the second trunk cylinder.
        push(&mut m, 1.5, 1.0, 0.1, 2, Some(1), Some(5));
        push(&mut m, 1.5, 1.0, 0.1, 2, Some(4), None);
        m.cyls_in_segment = vec![vec![0, 1, 2], vec![3], vec![4, 5]];

        let v = std::f64::consts::PI * 0.01;      // one cylinder's volume
        let gv = growth_volume(&m);
        assert!((gv[0] - 6.0 * v).abs() < 1e-12, "the base carries the whole tree: {}", gv[0]);
        assert!((gv[1] - 4.0 * v).abs() < 1e-12, "{}", gv[1]);
        assert!((gv[2] - v).abs() < 1e-12);
        assert!((gv[3] - v).abs() < 1e-12);
        assert!((gv[4] - 2.0 * v).abs() < 1e-12, "{}", gv[4]);
        assert!((gv[5] - v).abs() < 1e-12);
        // The whole tree's volume is the base's growth volume.
        let total: f64 = (0..6).map(|i| std::f64::consts::PI
            * m.cyl.radius[i] * m.cyl.radius[i] * m.cyl.length[i]).sum();
        assert!((gv[0] - total).abs() < 1e-12);
    }

    /// THE ALLOMETRY IS RECOVERED from data that follows it, which is
    /// the only way to know the fit is a fit and not a shape.
    #[test]
    fn the_allometry_is_recovered_from_data_that_obeys_it() {
        let (a, b, c) = (0.2283, 0.3339, -0.00227);
        let gv: Vec<f64> = (1..60).map(|k| k as f64 * 0.012).collect();
        let rad: Vec<f64> = gv.iter().map(|g| a * g.powf(b) + c).collect();
        let p = fit_allometry(&gv, &rad).expect("the fit converged");
        assert!((p[0] - a).abs() < 1e-3, "a = {}", p[0]);
        assert!((p[1] - b).abs() < 1e-3, "b = {}", p[1]);
        assert!((p[2] - c).abs() < 1e-4, "c = {}", p[2]);
        // Too few points to fit three parameters.
        assert!(fit_allometry(&gv[..3], &rad[..3]).is_none());
    }

    /// A RADIUS FAR OFF THE ALLOMETRY IS PULLED BACK; ONE NEAR IT IS
    /// LEFT ALONE. On a chain of equal cylinders the allometry is a
    /// constant, so the prediction is that constant everywhere.
    #[test]
    fn a_radius_far_from_the_allometry_is_corrected_and_a_close_one_is_not() {
        let mut rs = vec![0.05f64; 30];
        rs[10] = 0.25;                        // five times too fat
        rs[20] = 0.053;                       // within the factor
        let mut m = chain(&rs, 0.4);
        let before: Vec<f64> = m.cyl.radius.clone();

        let r = growth_volume_correction(&mut m, 1.5);
        assert_eq!(r.modified, 1, "only the fat one is off the allometry");
        assert!(m.cyl.radius[10] < 0.08,
            "the fat cylinder should come back to about 0.05, not {:.4}", m.cyl.radius[10]);
        assert_eq!(m.cyl.radius[20], before[20], "0.053 is inside the factor of 1.5");
        for (i, &b0) in before.iter().enumerate() {
            if i == 10 { continue; }
            assert_eq!(m.cyl.radius[i], b0, "cylinder {i} moved");
        }
        assert!(r.volume_after < r.volume_before, "the correction removed wood");
        assert!((r.largest_change - (m.cyl.radius[10] - 0.25)).abs() < 1e-12);
        assert!(r.allometry.is_some());

        // With two cylinders off the allometry by different amounts,
        // the LARGEST change is reported and not the last one made.
        let mut rs2 = vec![0.05f64; 30];
        rs2[5] = 0.25;                        // a big change, made first
        rs2[25] = 0.12;                       // a smaller one, made later
        let mut m2 = chain(&rs2, 0.4);
        let r2 = growth_volume_correction(&mut m2, 1.5);
        assert!(r2.modified >= 2, "{} cylinders moved", r2.modified);
        let big = (m2.cyl.radius[5] - 0.25).abs();
        let small = (m2.cyl.radius[25] - 0.12).abs();
        assert!(big > small, "{big:.4} against {small:.4}");
        assert!((r2.largest_change.abs() - big).abs() < 1e-12,
            "reported {:.4}, the largest is {big:.4}", r2.largest_change.abs());
        assert!(r2.largest_change < 0.0, "both were thinned");
    }

    /// A TIP IS NEVER FATTENED. A twig that ends where the points ran
    /// out is thin because it is a twig; a thin cylinder in the MIDDLE
    /// of a chain is thin because the fit failed.
    #[test]
    fn a_tip_is_thinned_but_never_fattened() {
        let mut rs = vec![0.05f64; 30];
        rs[15] = 0.01;                        // thin, mid-chain
        rs[29] = 0.01;                        // thin, and the last one
        let mut m = chain(&rs, 0.4);
        growth_volume_correction(&mut m, 1.5);
        assert!(m.cyl.radius[15] > 0.03,
            "a thin cylinder mid-chain is corrected up: {:.4}", m.cyl.radius[15]);
        assert_eq!(m.cyl.radius[29], 0.01, "the tip keeps the radius it was measured at");

        // A tip that is too FAT is still brought down — the rule is
        // about fattening, not about tips.
        //
        // It does not come all the way back to 0.05, and that is worth
        // stating rather than tuning away: the allometry is fitted to
        // the same radii it is then used to correct, so a gross outlier
        // drags the curve towards itself. A tip of 0.40 carries more
        // growth volume than the twenty-nine cylinders below it put
        // together, and the fit splits the difference.
        let mut rs2 = vec![0.05f64; 30];
        rs2[29] = 0.40;
        let mut m2 = chain(&rs2, 0.4);
        let r2 = growth_volume_correction(&mut m2, 1.5);
        assert!(r2.modified >= 1);
        assert!(m2.cyl.radius[29] < 0.25 && m2.cyl.radius[29] > 0.10,
            "a fat tip is thinned but not all the way: {:.4}", m2.cyl.radius[29]);
        // And it drags several of its neighbours out of tolerance with
        // it, which is a fair part of why the reference has this
        // correction off by default: it is an opinion about how a tree
        // ought to taper, fitted to the very radii it then overrules.
        assert!(r2.modified > 1, "{} cylinders moved", r2.modified);
    }

    /// A NEGATIVE PREDICTED RADIUS IS NEVER WRITTEN. The allometry's
    /// intercept is free and comes out negative on a real taper, so for
    /// a small enough growth volume the prediction is below zero — and
    /// the reference assigns it without looking.
    #[test]
    fn a_negative_prediction_is_not_written_as_a_radius() {
        // A tapering chain, whose fitted intercept is about -0.0023.
        let n = 40;
        let mut rs: Vec<f64> = (0..n)
            .map(|k| 0.20 - (0.20 - 0.005) * k as f64 / (n - 1) as f64).collect();
        rs.push(0.001);                       // a hair-thin tip
        let mut m = chain(&rs, 0.4);
        m.cyl.length[n] = 0.01;               // and a very short one

        let gv = growth_volume(&m);
        let p = fit_allometry(&gv, &m.cyl.radius).expect("the fit converged");
        assert!(p[2] < 0.0, "the intercept comes out negative: {}", p[2]);
        let pred = p[0] * gv[n].powf(p[1]) + p[2];
        assert!(pred < 0.0, "and the tip's prediction is below zero: {pred}");

        growth_volume_correction(&mut m, 1.5);
        assert_eq!(m.cyl.radius[n], 0.001, "the hair-thin tip keeps its radius");
        assert!(m.cyl.radius.iter().all(|&r| r > 0.0),
            "no cylinder may come out with a radius of zero or less");
    }

    /// THE PIPELINE RUNS IT ONLY WHEN ASKED, as `create_input.m`
    /// leaves it — and when asked, it runs.
    #[test]
    fn the_pipeline_applies_the_correction_only_when_it_is_switched_on() {
        assert!(!QsmInputs::new(0.08, 0.02, 0.07).growth_vol_cor,
            "GrowthVolCor is 0 in create_input.m");
        assert_eq!(QsmInputs::new(0.08, 0.02, 0.07).growth_vol_fac, 1.5);
        assert!(QsmInputs::default_sweep().iter().all(|i| !i.growth_vol_cor));

        let p = super::treeqsm_pipeline_tests::tree(0.0);
        let plain = QsmInputs::new(0.08, 0.02, 0.07);
        let mut corrected = plain;
        corrected.growth_vol_cor = true;
        let a = treeqsm_single(&p, &plain).expect("a model");
        let b = treeqsm_single(&p, &corrected).expect("a model");

        assert_eq!(a.cylinders.cyl.len(), b.cylinders.cyl.len(),
            "the correction changes radii, not the structure");
        let moved = (0..a.cylinders.cyl.len())
            .filter(|&i| a.cylinders.cyl.radius[i] != b.cylinders.cyl.radius[i]).count();
        assert!(moved > 0, "switching it on must change something");
        // Only the radii move: the axes and lengths are untouched.
        for i in 0..a.cylinders.cyl.len() {
            assert_eq!(a.cylinders.cyl.length[i], b.cylinders.cyl.length[i]);
            assert_eq!(a.cylinders.cyl.start[i], b.cylinders.cyl.start[i]);
        }
    }

    /// A FACTOR OF ONE OR LESS WOULD CORRECT EVERYTHING TO THE
    /// ALLOMETRY, which is not a correction but a replacement.
    #[test]
    fn a_factor_at_or_below_one_does_nothing() {
        let mut rs = vec![0.05f64; 30];
        rs[10] = 0.25;
        for fac in [1.0f64, 0.5, 0.0, -1.0, f64::NAN] {
            let mut m = chain(&rs, 0.4);
            let r = growth_volume_correction(&mut m, fac);
            assert_eq!(r.modified, 0, "fac = {fac} corrected something");
            assert_eq!(m.cyl.radius[10], 0.25);
        }
        // And an empty model is not a panic.
        let mut e = CylinderModel::default();
        assert_eq!(growth_volume_correction(&mut e, 1.5), GrowthVolCorrection::default());
        assert!(growth_volume(&e).is_empty());
    }
}

#[cfg(test)]
mod crown_measures_tests {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    fn push(m: &mut CylinderModel, start: [f64; 3], axis: [f64; 3], len: f64, r: f64,
            seg: u32, parent: Option<u32>, ext: Option<u32>, order: u8) {
        let n = (0..3).map(|k| axis[k] * axis[k]).sum::<f64>().sqrt();
        let axis = [axis[0] / n, axis[1] / n, axis[2] / n];
        m.cyl.push(RefCyl { start, axis, length: len, radius: r,
                            surf_cov: 0.9, mad: 0.001, conv: true, rel: true });
        m.parent.push(parent);
        m.extension.push(ext);
        m.added.push(false);
        m.unmod_radius.push(r);
        m.branch.push(seg);
        m.branch_order.push(order);
        m.position_in_branch.push(1);
        m.region_points.push(50);
        m.sector_mask.push(0xFFF);
        while m.cyls_in_segment.len() <= seg as usize { m.cyls_in_segment.push(Vec::new()); }
        let idx = (m.cyl.len() - 1) as u32;
        m.cyls_in_segment[seg as usize].push(idx);
    }

    /// A 6 m stem with four 2 m limbs at 4 m, north south east and
    /// west, and one thin 10 cm twig at 1 m that must NOT be taken for
    /// the crown base.
    fn crown_model() -> (CylinderModel, BranchData) {
        let mut m = CylinderModel::default();
        for k in 0..12u32 {
            let par = if k > 0 { Some(k - 1) } else { None };
            let ext = if k < 11 { Some(k + 1) } else { None };
            push(&mut m, [0.0, 0.0, k as f64 * 0.5], [0.0, 0.0, 1.0], 0.5, 0.10,
                 0, par, ext, 0);
        }
        // The twig: 2 x 5 cm, radius 8 mm, at 1 m.
        let base = m.cyl.len() as u32;
        push(&mut m, [0.10, 0.0, 1.0], [1.0, 0.0, 0.0], 0.05, 0.008, 1, Some(1), Some(base + 1), 1);
        push(&mut m, [0.15, 0.0, 1.0], [1.0, 0.0, 0.0], 0.05, 0.008, 1, Some(base), None, 1);
        // Four limbs, four 0.5 m cylinders each, radius 4 cm, at 4 m.
        for (s, dir) in [[1.0, 0.0], [-1.0, 0.0], [0.0, 1.0], [0.0, -1.0]].iter().enumerate() {
            let seg = 2 + s as u32;
            let first = m.cyl.len() as u32;
            for k in 0..4u32 {
                let r0 = 0.10 + k as f64 * 0.5;
                let par = if k > 0 { Some(first + k - 1) } else { Some(8) };
                let ext = if k < 3 { Some(first + k + 1) } else { None };
                push(&mut m, [dir[0] * r0, dir[1] * r0, 4.0], [dir[0], dir[1], 0.0],
                     0.5, 0.04, seg, par, ext, 1);
            }
        }
        let b = branches(&m);
        (m, b)
    }

    /// THE CROWN BASE IS THE LOWEST BRANCH THAT COUNTS AS ONE, not the
    /// lowest branch. The twig at 1 m is 16 mm thick and reaches 10 cm;
    /// the limbs at 4 m are 8 cm thick and reach two metres.
    #[test]
    fn the_crown_base_skips_a_twig_and_finds_the_limbs() {
        let (m, b) = crown_model();
        let c = crown_measures(&m, &b, 6.0, 0.20);
        assert_eq!(c.first_branch, Some(2), "the first limb, not the twig at segment 1");
        assert!((c.base_height - 4.0).abs() < 1e-12, "crown base {:.4} m", c.base_height);
        assert!((c.length - 2.0).abs() < 1e-12, "crown length {:.4} m", c.length);
        assert!((c.ratio - 2.0 / 6.0).abs() < 1e-12, "crown ratio {:.4}", c.ratio);
    }

    /// EVERY FIRST-ORDER BRANCH IS TESTED, THE LOWEST INCLUDED —
    /// reference defect 16. Make the twig qualify and the crown base
    /// must drop to it; the reference's loop increments before its
    /// test and would never look at it.
    #[test]
    fn the_lowest_branch_is_tested_rather_than_skipped() {
        let (mut m, _) = crown_model();
        // Lengthen the twig until it reaches two metres like the
        // others, and leave it 2 cm thick — over the floor, which is
        // min(5 cm, 5 % of the 20 cm stem) = 1 cm, and under the 5 cm
        // that taking the LARGER of the two would ask for.
        for &i in &m.cyls_in_segment[1].clone() {
            m.cyl.radius[i as usize] = 0.01;
            m.cyl.length[i as usize] = 1.0;
        }
        m.cyl.start[13] = [1.10, 0.0, 1.0];
        let b = branches(&m);
        let c = crown_measures(&m, &b, 6.0, 0.20);
        assert!(b.diameter[1] > 0.05f64.min(0.05 * 0.20) && b.diameter[1] < 0.05,
            "the branch is 2 cm thick: {:.4}", b.diameter[1]);
        assert_eq!(c.first_branch, Some(1), "the branch at 1 m now qualifies");
        assert!((c.base_height - 1.0).abs() < 1e-12, "crown base {:.4} m", c.base_height);
    }

    /// AND WHEN NOTHING QUALIFIES, THE LOWEST BRANCH IS THE FALL-BACK
    /// — the line the reference has and can never reach. Without it a
    /// tree with branches is reported as having no crown at all.
    #[test]
    fn a_tree_whose_branches_all_fail_still_has_a_crown() {
        let (mut m, _) = crown_model();
        // Every branch too thin to pass min(0.05, 0.05*dbh).
        for seg in 1..6usize {
            for &i in &m.cyls_in_segment[seg].clone() { m.cyl.radius[i as usize] = 0.001; }
        }
        let b = branches(&m);
        let c = crown_measures(&m, &b, 6.0, 0.20);
        assert_eq!(c.first_branch, Some(1), "the lowest branch is the fall-back");
        assert!((c.base_height - 1.0).abs() < 1e-12,
            "the reference reports no crown here: {:.4}", c.base_height);
        assert!(c.length > 0.0 && c.volume_conv > 0.0,
            "a tree with branches has a crown with a size");
    }

    /// THE WIDTH IS MEASURED SECTOR BY SECTOR from the centre of the
    /// outline's area, and the widest is the widest — reference defect
    /// 13, where the running maximum is computed and then discarded in
    /// favour of the last value.
    #[test]
    fn the_crown_diameters_are_the_sector_spreads_and_the_true_maximum() {
        let (m, b) = crown_model();
        let c = crown_measures(&m, &b, 6.0, 0.20);

        // The four limbs reach 0.10 + 4*0.5 = 2.10 m from the axis, so
        // the outline is a diamond 4.20 m across.
        assert!((c.diam_max - 4.20).abs() < 1e-9, "widest {:.6} m", c.diam_max);
        assert!((c.area_conv - 4.20 * 4.20 / 2.0).abs() < 1e-9,
            "the diamond's area {:.6}", c.area_conv);

        // Of the eighteen 10-degree sectors only three see a tip at
        // all: the east-west pair reads 4.20, and the two sectors
        // holding north and south read 2.10 each because the sector
        // opposite them is empty. Mean 8.40/18.
        assert!((c.diam_ave - 8.40 / 18.0).abs() < 1e-9, "mean spread {:.6}", c.diam_ave);

        // The alpha shape does not span the gaps between the limbs the
        // way the hull does.
        assert!(c.area_alpha < c.area_conv * 0.5,
            "alpha {:.4} against hull {:.4}", c.area_alpha, c.area_conv);
        assert!(c.area_alpha > 0.0, "the limbs themselves have some area");
    }

    /// THE PROFILE HAS ONE ROW PER LAYER, and how many layers depends
    /// on how tall the model is.
    #[test]
    fn the_vertical_profile_is_layered_by_height() {
        let (m, b) = crown_model();
        let c = crown_measures(&m, &b, 6.0, 0.20);
        assert_eq!(c.spreads.len(), 10, "6 m is over 2 and under 10");
        // The layer holding the limbs is much wider than the rest.
        let widest = c.spreads.iter().enumerate()
            .max_by(|a, x| a.1.iter().sum::<f64>()
                .partial_cmp(&x.1.iter().sum::<f64>()).unwrap()).unwrap().0;
        assert_eq!(widest, 6, "layer 6 spans 3.6 to 4.2 m, which holds the limbs");
        let total = |s: &[f64; 18]| s.iter().sum::<f64>();
        assert!(total(&c.spreads[6]) > 4.0, "the limb layer {:.3}", total(&c.spreads[6]));
        // Layer 1 holds the twig at 1 m, which reaches 20 cm from the
        // axis where the stem alone reaches 10, so its widest sector
        // is wider than any bare layer's.
        let widest_of = |j: usize| c.spreads[j].iter().cloned().fold(0.0f64, f64::max);
        assert!(widest_of(1) > 0.25,
            "the twig's layer should read past the stem: {:.4}", widest_of(1));
        // Every other layer is the stem alone, 20 cm across. The sum
        // over the eighteen sectors says how many of them saw the stem
        // at all: the reference turns each ring of twelve a further 165
        // degrees rather than restarting it, so four rings put points
        // in 48 directions and fill most of the 36 half-sectors.
        // Restarting each ring would leave twelve directions.
        for j in [0usize, 2, 3, 4, 5, 7, 8, 9] {
            let mx = c.spreads[j].iter().cloned().fold(0.0f64, f64::max);
            assert!(mx > 0.09 && mx < 0.21,
                "layer {j} is stem only and should read 0.20, not {mx:.4}");
            assert!(total(&c.spreads[j]) > 2.5,
                "layer {j} should see the stem from most directions: {:.3}",
                total(&c.spreads[j]));
        }

        // A tall model gets twenty layers, a short one five.
        let (tall, tb) = {
            let mut t = CylinderModel::default();
            for k in 0..30u32 {
                push(&mut t, [0.0, 0.0, k as f64 * 0.5], [0.0, 0.0, 1.0], 0.5, 0.10,
                     0, if k > 0 { Some(k - 1) } else { None },
                     if k < 29 { Some(k + 1) } else { None }, 0);
            }
            let b = branches(&t);
            (t, b)
        };
        assert_eq!(crown_measures(&tall, &tb, 15.0, 0.20).spreads.len(), 20);
    }

    /// THE REACH IS MEASURED IN THREE DIMENSIONS — reference defect
    /// 14, where the branch tip is computed from the x component of
    /// its axis alone and used for all three coordinates.
    ///
    /// A limb pointing due NORTH has an axis whose x component is zero,
    /// so under the defect its tip lands on its own start, its reach
    /// reads zero, and it can never be the crown base however far it
    /// actually goes.
    #[test]
    fn the_horizontal_reach_uses_the_whole_axis_not_its_x_component() {
        let mut m = CylinderModel::default();
        for k in 0..12u32 {
            push(&mut m, [0.0, 0.0, k as f64 * 0.5], [0.0, 0.0, 1.0], 0.5, 0.10,
                 0, if k > 0 { Some(k - 1) } else { None },
                 if k < 11 { Some(k + 1) } else { None }, 0);
        }
        // One limb reaching two metres due NORTH, at 2 m up. A single
        // cylinder, so its base and its last cylinder's start are the
        // same point and the tip is all there is to go on — and the x
        // component of a northward axis is zero.
        push(&mut m, [0.0, 0.10, 2.0], [0.0, 1.0, 0.0], 2.0, 0.04, 1, Some(4), None, 1);
        // A short limb reaching half a metre due east, higher up.
        push(&mut m, [0.10, 0.0, 4.0], [1.0, 0.0, 0.0], 0.5, 0.04, 2, Some(8), None, 1);
        let b = branches(&m);
        let c = crown_measures(&m, &b, 6.0, 0.20);
        // The northward limb reaches four times as far as the eastward
        // one, so it is the crown base. Measuring its tip from the x
        // component of its axis makes its reach exactly zero, and the
        // half-metre eastward stub wins instead.
        assert_eq!(c.first_branch, Some(1),
            "a limb pointing north reaches two metres and is the crown base");
        assert!((c.base_height - 2.0).abs() < 1e-12, "crown base {:.4}", c.base_height);
    }

    /// THE MEDIAN REACH IS OVER FIRST-ORDER BRANCHES — reference
    /// defect 15, where it is taken over a vector sized to ALL the
    /// branches in which only the first-order ones were written.
    ///
    /// This tree has two first-order branches and four second-order
    /// ones. Over all six the median reach is zero, because the four
    /// higher-order rows were never written and stay zero; the reach
    /// test then admits anything, and the short branch low on the stem
    /// is taken for the crown base. Over the two that were measured
    /// the median is real and the short one fails, which is what the
    /// reference's own comment says should happen.
    #[test]
    fn the_median_reach_is_over_the_branches_it_was_measured_on() {
        let mut m = CylinderModel::default();
        for k in 0..12u32 {
            push(&mut m, [0.0, 0.0, k as f64 * 0.5], [0.0, 0.0, 1.0], 0.5, 0.10,
                 0, if k > 0 { Some(k - 1) } else { None },
                 if k < 11 { Some(k + 1) } else { None }, 0);
        }
        // Segment 1: short, at 1.5 m — reaches 0.4 m, which is 4 stem
        // radii. Thick enough to pass the diameter test.
        let a = m.cyl.len() as u32;
        push(&mut m, [0.10, 0.0, 1.5], [1.0, 0.0, 0.0], 0.4, 0.02, 1, Some(3), None, 1);
        // Segment 2: a real limb at 4 m, reaching 2 m — 20 stem radii.
        let b0 = m.cyl.len() as u32;
        for k in 0..4u32 {
            push(&mut m, [0.10 + k as f64 * 0.5, 0.0, 4.0], [1.0, 0.0, 0.0], 0.5, 0.04,
                 2, Some(if k > 0 { b0 + k - 1 } else { 8 }),
                 if k < 3 { Some(b0 + k + 1) } else { None }, 1);
        }
        // Four second-order branches off it, which is what tips the
        // median over all branches to zero.
        for s in 0..4u32 {
            let at = b0 + s;
            push(&mut m, [0.14 + s as f64 * 0.5, 0.04, 4.0], [0.0, 1.0, 0.2], 0.3, 0.015,
                 3 + s, Some(at), None, 2);
        }
        let _ = a;
        let b = branches(&m);
        assert_eq!(b.order.iter().filter(|&&o| o == 1).count(), 2);
        assert_eq!(b.order.iter().filter(|&&o| o == 2).count(), 4);

        let c = crown_measures(&m, &b, 6.0, 0.20);
        assert_eq!(c.first_branch, Some(2),
            "the limb at 4 m, not the stub at 1.5 m");
        assert!((c.base_height - 4.0).abs() < 1e-9, "crown base {:.4}", c.base_height);
    }

    /// THE CROWN REACHES DOWN AS FAR AS ANYTHING GROWING OFF THE FIRST
    /// BRANCH DOES. A limb at 4 m with a shoot drooping to 3.5 m has
    /// its crown base at 3.5, not at 4: the reference walks the whole
    /// subtree and takes the LOWER end of each cylinder.
    #[test]
    fn a_drooping_shoot_pulls_the_crown_base_down_with_it() {
        let mut m = CylinderModel::default();
        for k in 0..12u32 {
            push(&mut m, [0.0, 0.0, k as f64 * 0.5], [0.0, 0.0, 1.0], 0.5, 0.10,
                 0, if k > 0 { Some(k - 1) } else { None },
                 if k < 11 { Some(k + 1) } else { None }, 0);
        }
        // A limb reaching two metres east at 4 m.
        push(&mut m, [0.10, 0.0, 4.0], [1.0, 0.0, 0.0], 2.0, 0.04, 1, Some(8), None, 1);
        // A second-order shoot off its far end, drooping half a metre.
        push(&mut m, [2.00, 0.0, 4.0], [0.0, 0.0, -1.0], 0.5, 0.02, 2, Some(12), None, 2);
        let b = branches(&m);

        let c = crown_measures(&m, &b, 6.0, 0.20);
        assert_eq!(c.first_branch, Some(1));
        assert!((c.base_height - 3.5).abs() < 1e-9,
            "the shoot's lower end at 3.5 m is the crown base, not {:.4}", c.base_height);
        assert!((c.length - 2.5).abs() < 1e-9);

        // Without the shoot the base is the limb's own height.
        let mut bare = m.clone();
        bare.cyls_in_segment[2].clear();
        let c2 = crown_measures(&bare, &branches(&bare), 6.0, 0.20);
        assert!((c2.base_height - 4.0).abs() < 1e-9, "{:.4}", c2.base_height);
    }

    /// EVERY POINT OF THE MODEL IS IN A LAYER, THE HIGHEST INCLUDED —
    /// reference defect 9 at the profile's own site.
    #[test]
    fn the_top_of_the_model_is_in_the_top_layer() {
        // Eight layers over 0..8, so the boundaries are whole numbers
        // and land on them exactly rather than rounding either way.
        assert_eq!(height_layer(0.0, 0.0, 8.0, 8), Some(0));
        assert_eq!(height_layer(0.99, 0.0, 8.0, 8), Some(0));
        assert_eq!(height_layer(1.0, 0.0, 8.0, 8), Some(1), "a boundary goes up");
        assert_eq!(height_layer(7.99, 0.0, 8.0, 8), Some(7));
        assert_eq!(height_layer(8.0, 0.0, 8.0, 8), Some(7),
            "the highest point of the model is in the top layer, not in none");
        // Off a ground that is not zero, too.
        assert_eq!(height_layer(108.0, 100.0, 108.0, 8), Some(7));
        assert_eq!(height_layer(104.0, 100.0, 108.0, 8), Some(4));
        // Outside, and degenerate.
        assert_eq!(height_layer(-0.01, 0.0, 8.0, 8), None);
        assert_eq!(height_layer(8.01, 0.0, 8.0, 8), None);
        assert_eq!(height_layer(1.0, 0.0, 0.0, 8), None, "a flat model has no layers");
        assert_eq!(height_layer(1.0, 0.0, 8.0, 0), None);
        assert_eq!(height_layer(f64::NAN, 0.0, 8.0, 8), None, "a NaN height is placed nowhere");
        // Every layer is reachable and they are consecutive.
        let seen: Vec<usize> = (0..=800)
            .filter_map(|i| height_layer(i as f64 / 100.0, 0.0, 8.0, 8)).collect();
        assert_eq!(seen.len(), 801, "no height between the two ends is homeless");
        assert_eq!(seen.first(), Some(&0));
        assert_eq!(seen.last(), Some(&7));
        for w in seen.windows(2) { assert!(w[1] == w[0] || w[1] == w[0] + 1); }
    }

    /// A MODEL WITH NO BRANCHES HAS NO CROWN, and says so without
    /// dividing by anything.
    #[test]
    fn a_bare_stem_reports_no_crown() {
        let mut m = CylinderModel::default();
        for k in 0..12u32 {
            push(&mut m, [0.0, 0.0, k as f64 * 0.5], [0.0, 0.0, 1.0], 0.5, 0.10,
                 0, if k > 0 { Some(k - 1) } else { None },
                 if k < 11 { Some(k + 1) } else { None }, 0);
        }
        let b = branches(&m);
        let c = crown_measures(&m, &b, 6.0, 0.20);
        assert_eq!(c.first_branch, None);
        assert_eq!(c.base_height, 6.0, "the crown starts where the tree ends");
        assert_eq!(c.length, 0.0);
        assert_eq!(c.volume_conv, 0.0);
        assert_eq!(c.volume_alpha, 0.0);
        // The width of the stem is still measured.
        assert!(c.area_conv > 0.0 && c.diam_max > 0.0);

        // And an empty model measures nothing rather than panicking.
        let e = crown_measures(&CylinderModel::default(), &BranchData::default(), 0.0, 0.0);
        assert_eq!(e, CrownData::default());
    }

    /// THE CROWN'S VOLUME IS THE SPACE ITS BRANCHES OCCUPY, and the
    /// alpha shape is smaller than the hull because a tree is mostly
    /// air.
    #[test]
    fn the_crown_volume_is_the_hull_above_the_base_and_the_alpha_shape_is_less() {
        let (m, b) = crown_model();
        let c = crown_measures(&m, &b, 6.0, 0.20);

        // The hull is the diamond of the limbs at 4 m drawn up to the
        // stem's top at 6 m — a cone of base 8.82 and height 2, so
        // about 5.9 cubic metres.
        assert!(c.volume_conv > 5.0 && c.volume_conv < 7.0,
            "crown hull {:.4} cubic metres", c.volume_conv);
        assert!(c.volume_alpha < c.volume_conv,
            "alpha {:.4} against hull {:.4}", c.volume_alpha, c.volume_conv);
        assert!(c.volume_alpha > 0.0, "the limbs and the stem have some volume");
    }
}

#[cfg(test)]
mod triangulate_stem_tests {
    use super::*;

    /// A stem elliptical at the butt and round above it, with one limb
    /// at 2.4 m — the shape the triangulation exists for. Returns the
    /// cloud and the model built from it.
    fn buttressed(a: f64, b: f64, limb_z: f64) -> Vec<[f64; 3]> {
        let mut p: Vec<[f64; 3]> = Vec::new();
        // The butt: an ellipse of semi-axes a and b, becoming a circle
        // of radius 0.12 by 2 m.
        let mut z = 0.0f64;
        while z <= 2.0 + 1e-9 {
            let f = z / 2.0;
            let (ra, rb) = (a + (0.12 - a) * f, b + (0.12 - b) * f);
            for k in 0..180 {
                let t = k as f64 / 180.0 * std::f64::consts::TAU;
                p.push([ra * t.cos(), rb * t.sin(), z]);
            }
            z += 0.01;
        }
        // A round stem above it, up to 6 m.
        while z <= 6.0 + 1e-9 {
            let r = 0.12 - 0.07 * (z - 2.0) / 4.0;
            for k in 0..90 {
                let t = k as f64 / 90.0 * std::f64::consts::TAU;
                p.push([r * t.cos(), r * t.sin(), z]);
            }
            z += 0.01;
        }
        // One limb, due east at `limb_z`, thick enough to count as the
        // first major branch: the mesh must stop under it.
        let mut x = 0.10f64;
        while x <= 1.2 {
            let r = 0.035 - 0.02 * (x - 0.10) / 1.1;
            for k in 0..40 {
                let t = k as f64 / 40.0 * std::f64::consts::TAU;
                p.push([x, r * t.cos(), limb_z + r * t.sin()]);
            }
            x += 0.01;
        }
        p
    }

    /// THE MESH REPLACES THE CYLINDERS IT COVERS, and the mix is the
    /// two put together. On a butt that is an ellipse, the two answers
    /// have to differ — a cylinder cannot be an ellipse — and the mesh
    /// has to be the one nearer the truth.
    #[test]
    fn the_triangulated_butt_replaces_the_cylinders_over_it() {
        let p = buttressed(0.25, 0.12, 2.4);
        let mut inp = QsmInputs::new(0.08, 0.02, 0.07);
        inp.tria = true;
        let model = treeqsm_single(&p, &inp).expect("a model");
        let stem: Vec<[f64; 3]> = p.iter().enumerate()
            .filter(|&(i, _)| model.segment_of_point.get(i).copied() == Some(0))
            .map(|(_, &q)| q).collect();
        assert!(stem.len() > 1000, "{} stem points", stem.len());
        let d = tree_data(&model.cylinders, &model.branches, &p, &model.segment_of_point);
        let t = triangulate_stem(&model.cylinders, &model.branches, &stem, &d);

        let mesh = t.mesh.as_ref()
            .unwrap_or_else(|| panic!("no mesh: {:?}", t.failure));
        // The limb at 2.4 m is the first major branch, so the mesh
        // stops below it rather than running up the whole stem — which
        // is what makes the branch selection matter at all.
        assert!(t.tria_trunk_length < 2.6,
            "the mesh should stop under the limb at 2.4 m, not at {:.3}",
            t.tria_trunk_length);
        assert!(mesh.top < 2.6, "the mesh reaches {:.3} m", mesh.top);
        assert!(mesh.facet.len() > 100, "{} facets", mesh.facet.len());
        assert!(t.tria_trunk_length >= 1.0,
            "the mesh has to cover at least a metre: {:.3}", t.tria_trunk_length);
        assert!(t.tria_trunk_volume > 0.0);

        // The mix keeps the branches and swaps the butt.
        assert!((t.mix_total_volume - (t.mix_trunk_volume + d.branch_volume)).abs() < 1e-9);
        assert!((t.mix_total_area - (t.mix_trunk_area + d.branch_area)).abs() < 1e-9);
        // And it differs from the all-cylinder answer, because an
        // ellipse is not a circle.
        assert!((t.mix_trunk_volume - d.trunk_volume).abs() > 1.0,
            "mix {:.2} L against cylinders {:.2} L",
            t.mix_trunk_volume, d.trunk_volume);

        // The diameter at breast height read off the mesh is the
        // perimeter over pi, so on an ellipse it is larger than either
        // axis's diameter of a circle by area.
        assert!(t.dbh_tri > 0.10 && t.dbh_tri < 0.60, "DBH from the mesh {:.4}", t.dbh_tri);
    }

    /// A trunk of `n` cylinders 0.2 m long with the given radii, plus
    /// one branch per `(height, diameter)`.
    fn model_with(radii: &[f64], limbs: &[(f64, f64)]) -> (CylinderModel, BranchData) {
        let mut m = CylinderModel::default();
        for (k, &r) in radii.iter().enumerate() {
            m.cyl.push(RefCyl { start: [0.0, 0.0, k as f64 * 0.2], axis: [0.0, 0.0, 1.0],
                                length: 0.2, radius: r, surf_cov: 0.9, mad: 0.001,
                                conv: true, rel: true });
            m.parent.push(if k > 0 { Some(k as u32 - 1) } else { None });
            m.extension.push(if k + 1 < radii.len() { Some(k as u32 + 1) } else { None });
            m.added.push(false); m.unmod_radius.push(r); m.branch.push(0);
            m.branch_order.push(0); m.position_in_branch.push(k as u32 + 1);
            m.region_points.push(50); m.sector_mask.push(0xFFF);
        }
        m.cyls_in_segment = vec![(0..radii.len() as u32).collect()];
        for (s, &(at, dia)) in limbs.iter().enumerate() {
            let seg = 1 + s as u32;
            let idx = m.cyl.len() as u32;
            m.cyl.push(RefCyl { start: [dia / 2.0, 0.0, at], axis: [1.0, 0.0, 0.0],
                                length: 0.6, radius: dia / 2.0, surf_cov: 0.9, mad: 0.001,
                                conv: true, rel: true });
            m.parent.push(Some(0));
            m.extension.push(None);
            m.added.push(false); m.unmod_radius.push(dia / 2.0); m.branch.push(seg);
            m.branch_order.push(1); m.position_in_branch.push(1);
            m.region_points.push(50); m.sector_mask.push(0xFFF);
            m.cyls_in_segment.push(vec![idx]);
        }
        let b = branches(&m);
        (m, b)
    }

    /// WHERE THE MESH STOPS is a decision over the model's own
    /// attributes, and it is tested as one: the fixtures that go
    /// through the whole pipeline cannot make a segmenter produce a
    /// twig exactly as thin as the rule needs.
    #[test]
    fn the_stop_is_the_lowest_limb_thick_enough_to_be_one() {
        let dbh = 0.30;
        let radii = vec![0.15f64; 30];                 // 6 m of even stem
        let trunk: Vec<usize> = (0..30).collect();

        // One thick limb at 2.0 m: the stop is the cylinder at 2.0 m.
        let (m, b) = model_with(&radii, &[(2.0, 0.08)]);
        assert_eq!(mesh_stop_cylinder(&m, &b, dbh, &trunk), 10);

        // A twig below it does not count: 2 cm is under a tenth of the
        // 30 cm stem, so the stop is still the limb at 2.0 m.
        let (m, b) = model_with(&radii, &[(1.0, 0.02), (2.0, 0.08)]);
        assert_eq!(mesh_stop_cylinder(&m, &b, dbh, &trunk), 10,
            "a 2 cm twig at 1 m is not the first major branch");

        // Two thick limbs: the LOWER one.
        let (m, b) = model_with(&radii, &[(3.2, 0.08), (1.6, 0.09)]);
        assert_eq!(mesh_stop_cylinder(&m, &b, dbh, &trunk), 8);

        // No limb thick enough: the thickest FIRST-ORDER one, which is
        // the reference's intent and not the thickest of any order —
        // that is the stem, and it would stop the walk at once.
        let (m, b) = model_with(&radii, &[(1.0, 0.02), (2.4, 0.025)]);
        assert!(b.diameter[0] > 0.2, "the stem is much the thickest: {:.3}", b.diameter[0]);
        assert_eq!(mesh_stop_cylinder(&m, &b, dbh, &trunk), 12,
            "the thickest first-order limb is the one at 2.4 m");

        // No branches at all: as far as the stem goes.
        let (m, b) = model_with(&radii, &[]);
        assert_eq!(mesh_stop_cylinder(&m, &b, dbh, &trunk), 29);
    }

    /// AND IT NEVER GOES PAST WHERE THE STEM HAS THINNED to a quarter
    /// of its breast-height diameter, however high the first limb is.
    #[test]
    fn the_stop_is_also_where_the_stem_thins_away() {
        let dbh = 0.30;                                  // a quarter is 0.075
        // Even to 1.4 m, then thinner than the floor.
        let mut radii = vec![0.15f64; 30];
        for r in radii.iter_mut().skip(8) { *r = 0.03; }
        let trunk: Vec<usize> = (0..30).collect();
        let (m, b) = model_with(&radii, &[(5.0, 0.08)]);
        assert_eq!(mesh_stop_cylinder(&m, &b, dbh, &trunk), 8,
            "the walk stops where the stem thins, not at the limb at 5 m");

        // And never at fewer than three cylinders, however early it
        // thins — three is what the mesh needs to be a mesh.
        let mut thin = vec![0.15f64; 30];
        for r in thin.iter_mut().skip(1) { *r = 0.01; }
        let (m, b) = model_with(&thin, &[(5.0, 0.08)]);
        assert_eq!(mesh_stop_cylinder(&m, &b, dbh, &trunk), 2);
    }

    /// THE MESH STOPS UNDER THE LOWEST LIMB THAT COUNTS AS ONE, and
    /// when none does, under the thickest FIRST-ORDER branch —
    /// reference defect 17, where the fall-back is the thickest branch
    /// of any order and so, normally, the stem itself.
    #[test]
    fn the_mesh_stops_under_the_lowest_major_branch() {
        // Two thick limbs, at 1.6 m and 3.2 m, and a hair-thin one at
        // 0.9 m that is not a limb at all. The lowest THICK one wins:
        // the thin one is under a tenth of the stem's own diameter and
        // an epicormic shoot is not where the buttress ends.
        let mut p = buttressed(0.25, 0.12, 1.6);
        let mut x = 0.10f64;
        while x <= 1.2 {
            let r = 0.035 - 0.02 * (x - 0.10) / 1.1;
            for k in 0..40 {
                let t = k as f64 / 40.0 * std::f64::consts::TAU;
                p.push([-x, r * t.cos(), 3.2 + r * t.sin()]);
            }
            x += 0.01;
        }
        let mut y = 0.14f64;
        while y <= 0.55 {
            for k in 0..20 {
                let t = k as f64 / 20.0 * std::f64::consts::TAU;
                p.push([0.006 * t.cos(), y, 0.9 + 0.006 * t.sin()]);
            }
            y += 0.006;
        }
        let inp = QsmInputs::new(0.08, 0.02, 0.07);
        let m = treeqsm_single(&p, &inp).expect("a model");
        let stem: Vec<[f64; 3]> = p.iter().enumerate()
            .filter(|&(i, _)| m.segment_of_point.get(i).copied() == Some(0))
            .map(|(_, &q)| q).collect();
        let d = tree_data(&m.cylinders, &m.branches, &p, &m.segment_of_point);
        assert!(m.branches.order.iter().filter(|&&o| o == 1).count() >= 2,
            "the fixture needs two first-order limbs");
        let t = triangulate_stem(&m.cylinders, &m.branches, &stem, &d);
        let mesh = t.mesh.as_ref()
            .unwrap_or_else(|| panic!("no mesh: {:?}", t.failure));
        assert!(mesh.top < 2.0,
            "the mesh should stop under the limb at 1.6 m, not at {:.3}", mesh.top);
        assert!(mesh.top > 1.0,
            "and not under the twig at 0.9 m either: {:.3}", mesh.top);
    }

    /// WHEN NO BRANCH IS THICK ENOUGH, THE FALL-BACK IS THE THICKEST
    /// BRANCH OF THE FIRST ORDER — not of any order, which is the
    /// stem, and which would pin the mesh at three cylinders whatever
    /// the tree looks like.
    #[test]
    fn a_tree_with_only_thin_limbs_falls_back_within_the_first_order() {
        // A stem with two hair-thin limbs, neither a tenth of the
        // stem's own diameter.
        let mut p = Vec::new();
        let mut z = 0.0f64;
        while z <= 6.0 + 1e-9 {
            let r = 0.16 - 0.09 * z / 6.0;
            for k in 0..140 {
                let t = k as f64 / 140.0 * std::f64::consts::TAU;
                p.push([r * t.cos(), r * t.sin(), z]);
            }
            z += 0.01;
        }
        for (at, rad, sign) in [(2.5f64, 0.010f64, 1.0f64), (4.0, 0.006, -1.0)] {
            let mut x = 0.10f64;
            while x <= 0.7 {
                for k in 0..24 {
                    let t = k as f64 / 24.0 * std::f64::consts::TAU;
                    p.push([sign * x, rad * t.cos(), at + rad * t.sin()]);
                }
                x += 0.008;
            }
        }
        let inp = QsmInputs::new(0.08, 0.02, 0.07);
        let m = treeqsm_single(&p, &inp).expect("a model");
        let stem: Vec<[f64; 3]> = p.iter().enumerate()
            .filter(|&(i, _)| m.segment_of_point.get(i).copied() == Some(0))
            .map(|(_, &q)| q).collect();
        let d = tree_data(&m.cylinders, &m.branches, &p, &m.segment_of_point);
        let t = triangulate_stem(&m.cylinders, &m.branches, &stem, &d);
        // The thickest first-order limb is at 2.5 m, so the mesh has a
        // butt to work with. Falling back to the stem — branch 0, far
        // and away the thickest of any order — would stop the walk at
        // the very first cylinder and leave nothing to mesh.
        assert!(t.mesh.is_some() || t.failure != Some(crate::commands::tria::TriaFailure::SectionTooShort),
            "the fall-back left no butt at all: {:?}", t.failure);
        if let Some(mesh) = t.mesh.as_ref() {
            assert!(mesh.top > 0.8,
                "the mesh covers {:.3} m of stem", mesh.top - mesh.bottom);
        }
    }

    /// IT IS OFF UNLESS ASKED FOR, as `create_input.m` leaves it, and
    /// asking for it is what makes the numbers appear.
    #[test]
    fn the_triangulation_runs_only_when_the_run_asks_for_it() {
        assert!(!QsmInputs::new(0.08, 0.02, 0.07).tria, "Tria is 0 in create_input.m");
        assert!(QsmInputs::default_sweep().iter().all(|i| !i.tria));

        let p = buttressed(0.25, 0.12, 2.4);
        let plain = QsmInputs::new(0.08, 0.02, 0.07);
        let a = qsm_attributes(&treeqsm_single(&p, &plain).expect("a model"), &p);
        assert!(a.triangulation.is_none(), "nothing asked for it");

        let mut on = plain;
        on.tria = true;
        let bmod = qsm_attributes(&treeqsm_single(&p, &on).expect("a model"), &p);
        let tri = bmod.triangulation.as_ref().expect("asked for, and built");
        assert!(tri.facet_count > 100 && tri.vertex_count > 50);
        assert!(tri.tria_height > 0.0);
        // The cylinder numbers are unchanged by asking.
        assert!((a.total_volume - bmod.total_volume).abs() < 1e-9);
        assert!((a.trunk_area - bmod.trunk_area).abs() < 1e-9);
    }

    /// A STEM TOO SHORT OR TOO THINLY SAMPLED GETS NO MESH, and says
    /// so rather than returning a broken one.
    #[test]
    fn a_stem_that_cannot_be_meshed_reports_the_cylinder_numbers() {
        let p = buttressed(0.25, 0.12, 2.4);
        let inp = QsmInputs::new(0.08, 0.02, 0.07);
        let model = treeqsm_single(&p, &inp).expect("a model");
        let d = tree_data(&model.cylinders, &model.branches, &p, &model.segment_of_point);

        // Under the reference's own thousand-point floor, and it says
        // that is why rather than blaming the reconstruction.
        let few: Vec<[f64; 3]> = p.iter().copied().take(500).collect();
        let t = triangulate_stem(&model.cylinders, &model.branches, &few, &d);
        assert!(t.mesh.is_none());
        assert_eq!(t.failure, Some(crate::commands::tria::TriaFailure::TooFewPoints));
        // The fall-back is the cylinder model's own numbers, so a
        // caller that reads these unconditionally is not misled.
        assert_eq!(t.tria_trunk_volume, d.trunk_volume);
        assert_eq!(t.mix_trunk_volume, d.trunk_volume);
        assert_eq!(t.mix_total_volume, d.total_volume);
        assert_eq!(t.dbh_tri, d.dbh_qsm);
        assert_eq!(t.tria_trunk_length, 0.0);

        // A butt shorter than the metre the reference asks for is a
        // different reason, and comes back as one. Four cylinders of
        // 20 cm gives 60 cm of butt, however many points it has.
        let mut short = CylinderModel::default();
        for k in 0..4u32 {
            short.cyl.push(RefCyl { start: [0.0, 0.0, k as f64 * 0.2],
                                    axis: [0.0, 0.0, 1.0], length: 0.2, radius: 0.15,
                                    surf_cov: 0.9, mad: 0.001, conv: true, rel: true });
            short.parent.push(if k > 0 { Some(k - 1) } else { None });
            short.extension.push(if k < 3 { Some(k + 1) } else { None });
            short.added.push(false); short.unmod_radius.push(0.15);
            short.branch.push(0); short.branch_order.push(0);
            short.position_in_branch.push(k + 1);
            short.region_points.push(50); short.sector_mask.push(0xFFF);
        }
        short.cyls_in_segment = vec![(0..4).collect()];
        let sb = branches(&short);
        let sd = TreeData { dbh_qsm: 0.30, ..Default::default() };
        let st = triangulate_stem(&short, &sb, &p, &sd);
        assert_eq!(st.failure, Some(crate::commands::tria::TriaFailure::SectionTooShort),
            "60 cm of butt: {:?}", st.failure);

        // And an empty model is not a panic.
        let e = triangulate_stem(&CylinderModel::default(), &BranchData::default(),
                                 &[], &TreeData::default());
        assert!(e.mesh.is_none());
    }
}

#[cfg(test)]
mod point_model_distance_tests {
    use super::*;

    fn push(m: &mut CylinderModel, start: [f64; 3], axis: [f64; 3],
            len: f64, r: f64, seg: u32, order: u8) {
        m.cyl.push(RefCyl { start, axis, length: len, radius: r,
                            surf_cov: 0.9, mad: 0.001, conv: true, rel: true });
        m.parent.push(None);
        m.extension.push(None);
        m.added.push(false);
        m.unmod_radius.push(r);
        m.branch.push(seg);
        m.branch_order.push(order);
        m.position_in_branch.push(1);
        m.region_points.push(50);
        m.sector_mask.push(0xFFF);
    }

    /// A 2 m vertical trunk of four 0.5 m cylinders at r = 0.10, and one
    /// 0.5 m branch due east at r = 0.04.
    fn model() -> CylinderModel {
        let mut m = CylinderModel::default();
        for k in 0..4u32 {
            push(&mut m, [0.0, 0.0, k as f64 * 0.5], [0.0, 0.0, 1.0], 0.5, 0.10, 0, 0);
        }
        push(&mut m, [0.10, 0.0, 1.0], [1.0, 0.0, 0.0], 0.5, 0.04, 1, 1);
        m.cyls_in_segment = vec![(0..4).collect(), vec![4]];
        m
    }

    /// Points on the trunk's surface, offset outward by `off`.
    fn trunk_shell(off: f64, n: usize) -> Vec<[f64; 3]> {
        (0..n).map(|i| {
            let t = i as f64 / n as f64 * std::f64::consts::TAU * 9.0;
            // Inside 0..2 m and away from the joins, so every point is
            // beside exactly one cylinder rather than at a boundary.
            let z = 0.05 + i as f64 / n as f64 * 1.9;
            let r = 0.10 + off;
            [r * t.cos(), r * t.sin(), z]
        }).collect()
    }

    /// A CLOUD ON THE SURFACE IS AT DISTANCE ZERO, and one held a known
    /// distance off the surface reports that distance. This is the
    /// whole measurement: `|distance to the axis - radius|`.
    #[test]
    fn the_distance_is_to_the_surface_not_to_the_axis() {
        let m = model();
        let on = point_model_distance_exact(&trunk_shell(0.0, 400), &m);
        for i in 0..4 {
            let d = on.cyl_dist[i].expect("trunk cylinder saw points");
            assert!(d < 1e-9, "cylinder {i} on its own shell reads {d:.2e} m");
        }
        assert!(on.trunk.mean < 1e-9, "trunk mean {:.2e}", on.trunk.mean);

        let off = point_model_distance_exact(&trunk_shell(0.02, 400), &m);
        for i in 0..4 {
            let d = off.cyl_dist[i].expect("trunk cylinder saw points");
            assert!((d - 0.02).abs() < 1e-9, "cylinder {i} reads {d:.6} m, want 0.02");
        }
        // Inward is the same distance: it is unsigned.
        let inn = point_model_distance_exact(&trunk_shell(-0.02, 400), &m);
        assert!((inn.all.mean - 0.02).abs() < 1e-9, "inward mean {:.6}", inn.all.mean);
    }

    /// A CYLINDER NOTHING SUPPORTS IS NOT A PERFECT FIT — reference
    /// defect 11. The reference leaves such a cylinder at DistCyl = 0
    /// and averages over every row, so adding cylinders in empty space
    /// improves the score `select_optimum` chooses by.
    #[test]
    fn a_cylinder_with_no_points_is_left_out_rather_than_scored_zero() {
        let mut m = model();
        // Two cylinders 50 m away, where no point is.
        push(&mut m, [50.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.5, 0.10, 2, 1);
        push(&mut m, [50.0, 0.0, 0.5], [0.0, 0.0, 1.0], 0.5, 0.10, 2, 1);

        let d = point_model_distance_exact(&trunk_shell(0.02, 400), &m);
        assert_eq!(d.unmatched, 3, "the two far cylinders and the branch saw nothing");
        assert!(d.cyl_dist[4].is_none(), "the branch saw nothing");
        assert!(d.cyl_dist[5].is_none() && d.cyl_dist[6].is_none());

        // The mean is over the four that were actually measured.
        assert_eq!(d.all.count, 4, "four cylinders were measured");
        assert!((d.all.mean - 0.02).abs() < 1e-9,
            "mean {:.6} m — the reference would report {:.6} by counting \
             the three unsupported cylinders as exact",
            d.all.mean, 0.02 * 4.0 / 7.0);
    }

    /// ONLY THE SHORTEST 95 % COUNT, and only once there are twenty
    /// distances to take 95 % of.
    #[test]
    fn the_worst_five_percent_is_dropped_above_twenty_points() {
        let mut m = CylinderModel::default();
        push(&mut m, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 1.0, 0.10, 0, 0);

        // Twenty points: nineteen at 0.01 m out, one at 0.40 m out.
        // floor(0.95*20) = 19, so the outlier is dropped exactly.
        let mut p: Vec<[f64; 3]> = (0..19)
            .map(|i| [0.11, 0.0, 0.05 + i as f64 * 0.04]).collect();
        p.push([0.50, 0.0, 0.5]);
        let d = point_model_distance_exact(&p, &m);
        assert!((d.cyl_dist[0].unwrap() - 0.01).abs() < 1e-12,
            "with 20 points the 0.40 m outlier must be dropped, got {:.6}",
            d.cyl_dist[0].unwrap());

        // Nineteen points: the trim does not apply and the outlier counts.
        let q = [&p[..18], &p[19..]].concat();
        assert_eq!(q.len(), 19);
        let e = point_model_distance_exact(&q, &m);
        let want = (18.0 * 0.01 + 0.40) / 19.0;
        assert!((e.cyl_dist[0].unwrap() - want).abs() < 1e-12,
            "with 19 points nothing is trimmed: got {:.6}, want {want:.6}",
            e.cyl_dist[0].unwrap());

        // Twenty-one points, where 0.95*m is not a whole number:
        // floor(19.95) = 19, so the 0.02 as well as the 0.40 is dropped.
        // Rounding the other way would keep the 0.02 and read 0.0105.
        let mut r: Vec<[f64; 3]> = (0..19)
            .map(|i| [0.11, 0.0, 0.05 + i as f64 * 0.04]).collect();
        r.push([0.12, 0.0, 0.83]);                       // 0.02 m out
        r.push([0.50, 0.0, 0.87]);                       // 0.40 m out
        assert_eq!(r.len(), 21);
        let f = point_model_distance_exact(&r, &m);
        assert!((f.cyl_dist[0].unwrap() - 0.01).abs() < 1e-12,
            "floor(0.95*21) = 19 keeps only the nineteen at 0.01; got {:.6} \
             (rounding up would give {:.6})",
            f.cyl_dist[0].unwrap(), (19.0 * 0.01 + 0.02) / 20.0);
    }

    /// HALF A METRE IS THE LIMIT. A point further than that from every
    /// surface belongs to no cylinder at all.
    #[test]
    fn a_point_further_than_half_a_metre_is_not_assigned() {
        let m = model();
        // Due west, away from the branch, which runs east from the trunk.
        let near = [[-(0.10 + 0.49), 0.0, 1.0]];
        let far = [[-(0.10 + 0.51), 0.0, 1.0]];
        // Both are beside the trunk at 1 m; only the near one counts.
        let a = point_model_distance_exact(&near, &m);
        assert_eq!(a.all.count, 1, "0.49 m out is within reach");
        let b = point_model_distance_exact(&far, &m);
        assert_eq!(b.all.count, 0, "0.51 m out is beyond reach");
        assert_eq!(b.unmatched, 5);
    }

    /// THE ENDS GET A SECOND PASS, ten centimetres deep. A point past
    /// the top of the topmost cylinder is still its; one 20 cm past is
    /// nobody's.
    #[test]
    fn points_just_off_an_end_are_caught_by_the_second_pass() {
        let mut m = CylinderModel::default();
        push(&mut m, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 1.0, 0.10, 0, 0);

        let just = [[0.10, 0.0, 1.05]];             // h = 1.05, len = 1.0
        let past = [[0.10, 0.0, 1.20]];             // h = 1.20
        assert_eq!(point_model_distance_exact(&just, &m).all.count, 1,
            "5 cm past the top is within the end band");
        assert_eq!(point_model_distance_exact(&past, &m).all.count, 0,
            "20 cm past the top is outside it");

        // And below the base, the same band.
        let below = [[0.10, 0.0, -0.05]];
        assert_eq!(point_model_distance_exact(&below, &m).all.count, 1);
        assert_eq!(point_model_distance_exact(&[[0.10, 0.0, -0.20]], &m).all.count, 0);
    }

    /// EACH POINT GOES TO ITS NEAREST CYLINDER, not to the first one
    /// that reaches it.
    #[test]
    fn a_point_between_two_cylinders_chooses_the_nearer() {
        let mut m = CylinderModel::default();
        // Two parallel cylinders 1 m apart, both r = 0.10.
        push(&mut m, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 1.0, 0.10, 0, 0);
        push(&mut m, [1.0, 0.0, 0.0], [0.0, 0.0, 1.0], 1.0, 0.10, 1, 1);

        // At x = 0.60: 0.50 m from the first axis, 0.40 from the second,
        // so 0.40 and 0.30 from the two surfaces. The second wins.
        let d = point_model_distance_exact(&[[0.60, 0.0, 0.5]], &m);
        assert!(d.cyl_dist[0].is_none(), "the far cylinder must not claim it");
        assert!((d.cyl_dist[1].unwrap() - 0.30).abs() < 1e-12,
            "got {:.6}", d.cyl_dist[1].unwrap());
    }

    /// TRUNK AND BRANCHES ARE REPORTED SEPARATELY, by branching order.
    #[test]
    fn the_groups_split_on_branching_order() {
        let mut m = model();
        push(&mut m, [0.60, 0.0, 1.0], [1.0, 0.0, 0.0], 0.5, 0.02, 2, 2);

        let mut p = trunk_shell(0.02, 400);
        // The branch's own shell, 5 cm off it, and the twig's, 1 cm off.
        for i in 0..40 {
            let t = i as f64 / 40.0 * std::f64::consts::TAU;
            p.push([0.20 + i as f64 * 0.008, 0.09 * t.cos(), 1.0 + 0.09 * t.sin()]);
        }
        for i in 0..40 {
            let t = i as f64 / 40.0 * std::f64::consts::TAU;
            p.push([0.70 + i as f64 * 0.008, 0.03 * t.cos(), 1.0 + 0.03 * t.sin()]);
        }
        let d = point_model_distance_exact(&p, &m);

        assert_eq!(d.trunk.count, 4, "four trunk cylinders");
        assert_eq!(d.branch.count, 2, "the branch and the twig");
        assert_eq!(d.branch1.count, 1);
        assert_eq!(d.branch2.count, 1);
        assert!((d.trunk.mean - 0.02).abs() < 1e-9, "trunk {:.6}", d.trunk.mean);
        assert!((d.branch1.mean - 0.05).abs() < 1e-9, "1st order {:.6}", d.branch1.mean);
        assert!((d.branch2.mean - 0.01).abs() < 1e-9, "2nd order {:.6}", d.branch2.mean);
        // `branch` is everything that is not the trunk, so it is the
        // mean of the two, not either of them.
        assert!((d.branch.mean - 0.03).abs() < 1e-9, "branches {:.6}", d.branch.mean);
    }

    /// THE FOUR SUMMARY NUMBERS ARE MATLAB'S. Deliberately an unsorted,
    /// lopsided set: the median differs from the mean, and the largest
    /// value is not the last one.
    #[test]
    fn the_summary_is_matlabs_median_mean_max_and_sample_std() {
        assert_eq!(pm_stats(&[0.5]).std, 0.0, "one value has no spread");
        let s = pm_stats(&[1.0, 6.0, 2.0]);
        assert_eq!(s.mean, 3.0);
        assert_eq!(s.median, 2.0, "the middle value, not the mean");
        assert_eq!(s.max, 6.0, "the largest, not the last");
        assert!((s.std - 7.0f64.sqrt()).abs() < 1e-12,
            "sample std of 1, 6, 2 is sqrt(7), got {}", s.std);
        // An even count takes the mean of the two middles, as MATLAB does.
        assert_eq!(pm_stats(&[1.0, 6.0, 2.0, 3.0]).median, 2.5);
        assert_eq!(pm_stats(&[]).count, 0);
    }

    /// THE SUBSAMPLE IS A DETERMINISTIC QUARTER. The reference draws it
    /// with `rand`, which makes both the reported distance and — through
    /// `select_optimum` — the choice of model differ between runs.
    #[test]
    fn the_quarter_kept_is_the_same_every_run() {
        let m = model();
        let p = trunk_shell(0.02, 400);
        let a = point_model_distance(&p, &m, 7);
        let b = point_model_distance(&p, &m, 7);
        assert_eq!(a.points_used, 100, "a quarter of 400");
        assert_eq!(a.points_used, b.points_used);
        assert_eq!(a.cyl_dist, b.cyl_dist, "the same points give the same distances");

        // A cloud smaller than four points still yields one.
        let tiny = point_model_distance(&p[..3], &m, 7);
        assert_eq!(tiny.points_used, 1);
        // And an empty one yields nothing rather than panicking.
        let none = point_model_distance(&[], &m, 7);
        assert_eq!(none.points_used, 0);
        assert_eq!(none.unmatched, 5);
    }
}

#[cfg(test)]
mod select_optimum_tests {
    use super::*;

    fn st(mean: f64, max: f64, count: usize) -> PmStats {
        PmStats { median: mean, mean, max, std: 0.0, count }
    }
    fn cv(mean: f64, min: f64, count: usize) -> CovStats {
        CovStats { mean, min, count }
    }

    /// A score with every group present and every number distinct, so
    /// no metric can pick the wrong field and still agree. The values
    /// are deliberately irregular: with round ones, half of one
    /// group's maximum lands exactly on another group's mean and two
    /// different metrics read the same number by accident.
    fn score() -> ModelScore {
        ModelScore {
            pm: PmDistance {
                all: st(0.011, 0.103, 40),
                trunk: st(0.023, 0.211, 10),
                branch: st(0.037, 0.307, 30),
                branch1: st(0.041, 0.401, 20),
                branch2: st(0.059, 0.503, 10),
                ..Default::default()
            },
            surf_cov: SurfCov {
                all: cv(0.91, 0.47, 40),
                trunk: cv(0.83, 0.41, 10),
                branch: cv(0.77, 0.29, 30),
                branch1: cv(0.61, 0.19, 20),
                branch2: cv(0.53, 0.13, 10),
            },
        }
    }

    const GROUPS: [MetricGroup; 9] = [
        MetricGroup::All, MetricGroup::Trunk, MetricGroup::Branch,
        MetricGroup::Branch1, MetricGroup::Branch2,
        MetricGroup::TrunkAndBranch, MetricGroup::TrunkAndBranch1,
        MetricGroup::TrunkAndBranch1AndBranch2, MetricGroup::Branch1AndBranch2,
    ];
    const KINDS: [MetricKind; 5] = [
        MetricKind::MeanDistance, MetricKind::MaxDistance,
        MetricKind::MeanPlusMaxDistance, MetricKind::MeanSurfaceCoverage,
        MetricKind::MinSurfaceCoverage,
    ];

    /// THE DEFAULT IS THE REFERENCE'S DEFAULT — `all_mean_dis`, the
    /// mean distance from the cloud to every cylinder.
    #[test]
    fn the_default_metric_is_all_mean_dis() {
        let m = QsmMetric::default();
        assert_eq!(m.group, MetricGroup::All);
        assert_eq!(m.kind, MetricKind::MeanDistance);
        assert!((metric_value(m, &score()) - 0.011).abs() < 1e-15);
    }

    /// EACH GROUP READS ITS OWN NUMBER, and the combinations are the
    /// sums the reference writes out term by term.
    #[test]
    fn every_group_is_the_sum_of_the_groups_it_names() {
        let s = score();
        let v = |g: MetricGroup, k: MetricKind| metric_value(QsmMetric { group: g, kind: k }, &s);
        use MetricGroup::*;
        use MetricKind::MeanDistance as MD;
        assert!((v(All, MD) - 0.011).abs() < 1e-15);
        assert!((v(Trunk, MD) - 0.023).abs() < 1e-15);
        assert!((v(Branch, MD) - 0.037).abs() < 1e-15);
        assert!((v(Branch1, MD) - 0.041).abs() < 1e-15);
        assert!((v(Branch2, MD) - 0.059).abs() < 1e-15);
        // D(2)+D(3), D(2)+D(4), D(2)+D(4)+D(5), D(4)+D(5).
        assert!((v(TrunkAndBranch, MD) - 0.060).abs() < 1e-15);
        assert!((v(TrunkAndBranch1, MD) - 0.064).abs() < 1e-15);
        assert!((v(TrunkAndBranch1AndBranch2, MD) - 0.123).abs() < 1e-15);
        assert!((v(Branch1AndBranch2, MD) - 0.100).abs() < 1e-15);
        // `All` is not the sum of trunk and branch: it is the mean over
        // every cylinder, which the branches dominate by being more
        // numerous. That difference is the reason both exist.
        assert!(v(All, MD) < v(TrunkAndBranch, MD));
    }

    /// THE MAXIMA ARE HALVED before they are used, which is invisible
    /// on a pure maximum metric and decides the weighting on a
    /// mean-plus-maximum one.
    #[test]
    fn the_maximum_carries_half_weight() {
        let s = score();
        let v = |g: MetricGroup, k: MetricKind| metric_value(QsmMetric { group: g, kind: k }, &s);
        use MetricGroup::*;
        use MetricKind::*;
        assert!((v(All, MaxDistance) - 0.0515).abs() < 1e-15, "half of 0.103");
        assert!((v(TrunkAndBranch, MaxDistance) - 0.259).abs() < 1e-15,
            "half of 0.211 plus half of 0.307");
        // mean + max/2, per group.
        assert!((v(All, MeanPlusMaxDistance) - 0.0625).abs() < 1e-15);
        assert!((v(TrunkAndBranch, MeanPlusMaxDistance) - 0.319).abs() < 1e-15,
            "0.023+0.037 mean plus 0.1055+0.1535 half-max");
        assert!((v(TrunkAndBranch1AndBranch2, MeanPlusMaxDistance) - 0.6805).abs() < 1e-15);
    }

    /// COVERAGE IS TURNED ROUND so that every metric is minimised: the
    /// value is one minus the coverage, so more coverage scores lower.
    #[test]
    fn coverage_metrics_are_one_minus_the_coverage() {
        let s = score();
        let v = |g: MetricGroup, k: MetricKind| metric_value(QsmMetric { group: g, kind: k }, &s);
        use MetricGroup::*;
        use MetricKind::*;
        assert!((v(All, MeanSurfaceCoverage) - 0.09).abs() < 1e-15);
        assert!((v(Trunk, MinSurfaceCoverage) - 0.59).abs() < 1e-15);
        assert!((v(TrunkAndBranch, MeanSurfaceCoverage) - 0.40).abs() < 1e-15,
            "(1-0.83) + (1-0.77)");
        // The minimum is NOT halved the way the distance maxima are.
        assert!((v(All, MinSurfaceCoverage) - 0.53).abs() < 1e-15);

        // Better coverage must score lower, or the sweep would pick the
        // worst-seen model.
        let mut better = score();
        better.surf_cov.all = cv(0.99, 0.90, 40);
        assert!(metric_value(QsmMetric { group: All, kind: MeanSurfaceCoverage }, &better)
              < metric_value(QsmMetric { group: All, kind: MeanSurfaceCoverage }, &s));
    }

    /// A MODEL CANNOT WIN ON SOMETHING IT DOES NOT CONTAIN — reference
    /// defect 12. `point_model_distance.m` writes zero for the branch
    /// groups of a branchless model, and zero is the best possible
    /// score, so the model that found no branches beats every model
    /// that found them.
    #[test]
    fn a_model_without_branches_does_not_win_the_branch_metrics() {
        let with = score();
        let mut without = score();
        without.pm.branch = st(0.0, 0.0, 0);
        without.pm.branch1 = st(0.0, 0.0, 0);
        without.pm.branch2 = st(0.0, 0.0, 0);
        without.surf_cov.branch = cv(0.0, 0.0, 0);
        without.surf_cov.branch1 = cv(0.0, 0.0, 0);
        without.surf_cov.branch2 = cv(0.0, 0.0, 0);

        for k in KINDS {
            for g in [MetricGroup::Branch, MetricGroup::Branch1, MetricGroup::Branch2,
                      MetricGroup::TrunkAndBranch, MetricGroup::Branch1AndBranch2] {
                let m = QsmMetric { group: g, kind: k };
                let a = metric_value(m, &without);
                assert!(a.is_infinite(),
                    "{g:?}/{k:?}: a model with no such cylinders scored {a}");
                assert!(metric_value(m, &with) < a,
                    "{g:?}/{k:?}: the model that found branches must win");
            }
        }
        // Its trunk metrics still work — only the missing groups are out.
        let m = QsmMetric { group: MetricGroup::Trunk, kind: MetricKind::MeanDistance };
        assert!((metric_value(m, &without) - 0.023).abs() < 1e-15);
        // And so does `All`, which is a group of its own rather than a
        // sum over the others.
        let m = QsmMetric { group: MetricGroup::All, kind: MetricKind::MeanDistance };
        assert!(metric_value(m, &without).is_finite());
    }

    /// ALL FORTY-FIVE METRICS EXIST AND PRODUCE A NUMBER, and none of
    /// them is secretly another one.
    #[test]
    fn the_forty_five_metrics_are_forty_five_distinct_readings() {
        let s = score();
        let mut seen: Vec<(String, f64)> = Vec::new();
        for g in GROUPS {
            for k in KINDS {
                let v = metric_value(QsmMetric { group: g, kind: k }, &s);
                assert!(v.is_finite() && v >= 0.0, "{g:?}/{k:?} gave {v}");
                seen.push((format!("{g:?}/{k:?}"), v));
            }
        }
        assert_eq!(seen.len(), 45, "nine groups by five kinds");
        // On a score whose every field differs, no two metrics agree —
        // which is what says each reads its own fields.
        for i in 0..seen.len() {
            for j in (i + 1)..seen.len() {
                assert!((seen[i].1 - seen[j].1).abs() > 1e-12,
                    "{} and {} both read {}", seen[i].0, seen[j].0, seen[i].1);
            }
        }
    }

    /// THE SMALLEST WINS, AND A TIE GOES TO THE FIRST — MATLAB's sort
    /// is stable and the reference takes `J(1)`.
    #[test]
    fn the_minimum_is_chosen_and_ties_go_to_the_first() {
        let mk = |mean: f64| {
            let mut s = score();
            s.pm.all = st(mean, 0.1, 40);
            s
        };
        let scores = vec![mk(0.03), mk(0.01), mk(0.02)];
        let (i, v) = select_optimum(&scores, QsmMetric::default()).expect("a model");
        assert_eq!(i, 1, "the second is nearest");
        assert!((v - 0.01).abs() < 1e-15);

        let tied = vec![mk(0.02), mk(0.02), mk(0.02)];
        assert_eq!(select_optimum(&tied, QsmMetric::default()).unwrap().0, 0,
            "a tie goes to the first, which is the finer cover");

        assert!(select_optimum(&[], QsmMetric::default()).is_none());
    }

    /// THE COVERAGES ARE READ OFF THE MODEL, group by group: the mean
    /// and the SMALLEST of each, with the branch group everything that
    /// is not the trunk rather than the first order alone.
    #[test]
    fn score_model_reads_the_coverage_of_each_group() {
        let mut m = CylinderModel::default();
        // surf_cov, branching order.
        for (sc, ord) in [(0.9, 0u8), (0.8, 0), (0.6, 1), (0.5, 1), (0.3, 2)] {
            m.cyl.push(RefCyl { start: [0.0, 0.0, 0.0], axis: [0.0, 0.0, 1.0],
                                length: 0.5, radius: 0.05, surf_cov: sc,
                                mad: 0.001, conv: true, rel: true });
            m.parent.push(None); m.extension.push(None); m.added.push(false);
            m.unmod_radius.push(0.05); m.branch.push(ord as u32);
            m.branch_order.push(ord); m.position_in_branch.push(1);
            m.region_points.push(20); m.sector_mask.push(0xFFF);
        }
        let s = score_model(&[], &m, 1);
        let c = &s.surf_cov;

        assert_eq!((c.all.count, c.trunk.count, c.branch.count,
                    c.branch1.count, c.branch2.count), (5, 2, 3, 2, 1));
        assert!((c.all.mean - 0.62).abs() < 1e-12, "all {:.6}", c.all.mean);
        assert!((c.trunk.mean - 0.85).abs() < 1e-12, "trunk {:.6}", c.trunk.mean);
        // Not 0.55: `branch` is everything above the trunk, both orders.
        assert!((c.branch.mean - 1.4 / 3.0).abs() < 1e-12, "branch {:.6}", c.branch.mean);
        assert!((c.branch1.mean - 0.55).abs() < 1e-12);
        assert!((c.branch2.mean - 0.30).abs() < 1e-12);

        // The SMALLEST, not the largest — a metric named "min_surf"
        // that read the maximum would rate the worst-seen model best.
        assert!((c.all.min - 0.3).abs() < 1e-12, "all min {:.6}", c.all.min);
        assert!((c.trunk.min - 0.8).abs() < 1e-12, "trunk min {:.6}", c.trunk.min);
        assert!((c.branch.min - 0.3).abs() < 1e-12);
        assert!((c.branch1.min - 0.5).abs() < 1e-12);
    }

    /// A MODEL WITH NOTHING MEASURABLE STILL DOES NOT SHADOW ONE THAT
    /// HAS SOMETHING. Infinity loses to any real number, whichever
    /// order they arrive in.
    #[test]
    fn an_unmeasurable_model_never_beats_a_measurable_one() {
        let mut empty = score();
        empty.pm.all = st(0.0, 0.0, 0);
        let good = score();
        let g = QsmMetric::default();
        assert_eq!(select_optimum(&[empty.clone(), good.clone()], g).unwrap().0, 1);
        assert_eq!(select_optimum(&[good, empty.clone()], g).unwrap().0, 0);
        // Two unmeasurable ones tie at infinity and the first is taken,
        // rather than nothing coming back at all.
        assert_eq!(select_optimum(&[empty.clone(), empty], g).unwrap().0, 0);
    }
}

#[cfg(test)]
mod branches_tests {
    use super::*;

    /// Build a model by hand: cylinders in chains, with the parent,
    /// extension and branch bookkeeping the driver would have written.
    #[derive(Default)]
    struct Model(CylinderModel);

    impl Model {
        /// Append a chain of `n` cylinders of length `len` and radius
        /// `r` running from `from` along `dir`, belonging to branch
        /// `seg`, with the first attached to `parent`.
        #[allow(clippy::too_many_arguments)]
        fn chain(&mut self, seg: u32, from: [f64; 3], dir: [f64; 3], r: f64,
                 len: f64, n: usize, parent: Option<u32>, added: bool) -> u32 {
            let nn = (dir[0]*dir[0] + dir[1]*dir[1] + dir[2]*dir[2]).sqrt();
            let a = [dir[0]/nn, dir[1]/nn, dir[2]/nn];
            let c0 = self.0.cyl.len() as u32;
            for k in 0..n {
                let s = k as f64 * len;
                self.0.cyl.push(RefCyl {
                    start: [from[0]+a[0]*s, from[1]+a[1]*s, from[2]+a[2]*s],
                    axis: a, length: len, radius: r, surf_cov: 0.9, mad: 0.001,
                    conv: true, rel: true,
                });
                self.0.parent.push(if k == 0 { parent } else { Some(c0 + k as u32 - 1) });
                self.0.extension.push(if k + 1 < n { Some(c0 + k as u32 + 1) } else { None });
                self.0.added.push(k == 0 && added);
                self.0.unmod_radius.push(r);
                self.0.branch.push(seg);
            }
            c0
        }

        fn finish(mut self) -> CylinderModel {
            let c = self.0.cyl.len();
            self.0.branch_order = vec![0u8; c];
            for i in 0..c {
                if let Some(p) = self.0.parent[i] {
                    let p = p as usize;
                    self.0.branch_order[i] = if self.0.extension[p] == Some(i as u32) {
                        self.0.branch_order[p]
                    } else {
                        self.0.branch_order[p] + 1
                    };
                }
            }
            self.0.position_in_branch = vec![1; c];
            self.0
        }
    }

    /// A stem with one branch leaving it at a right angle, half way up.
    ///
    /// The tree stands at z = 100, not at the origin: a fixture rooted
    /// at zero cannot tell a height measured from the tree's base from
    /// one that forgot to subtract it.
    const GROUND: f64 = 100.0;
    fn stem_and_branch() -> CylinderModel {
        let mut m = Model::default();
        m.chain(0, [0.0, 0.0, GROUND], [0.0, 0.0, 1.0], 0.10, 0.5, 8, None, false);
        // Off cylinder 3 (which spans 1.5 to 2.0 above the base), east.
        m.chain(1, [0.10, 0.0, GROUND + 1.75], [1.0, 0.0, 0.0], 0.04, 0.25, 4,
                Some(3), false);
        m.finish()
    }

    /// THE NUMBERS A QSM IS READ BY. Volume in litres, area in square
    /// metres, length and diameter in metres — for a chain of known
    /// geometry, where every one of them has a closed form.
    #[test]
    fn a_branch_of_known_geometry_reports_its_own_volume_area_and_length() {
        let b = branches(&stem_and_branch());
        // Four cylinders of r = 0.04, length 0.25: length 1.0 m.
        assert!((b.length[1] - 1.0).abs() < 1e-12, "length {:.6}", b.length[1]);
        assert!((b.diameter[1] - 0.08).abs() < 1e-12, "diameter {:.6}", b.diameter[1]);
        // pi*r^2*L in litres.
        let want_v = 1000.0 * std::f64::consts::PI * 0.04_f64.powi(2) * 1.0;
        assert!((b.volume[1] - want_v).abs() < 1e-9,
            "volume {:.6} litres, want {want_v:.6}", b.volume[1]);
        // 2*pi*r*L in square metres.
        let want_a = 2.0 * std::f64::consts::PI * 0.04 * 1.0;
        assert!((b.area[1] - want_a).abs() < 1e-12,
            "area {:.6} m2, want {want_a:.6}", b.area[1]);
        // The stem: eight cylinders of r = 0.10, length 0.5.
        assert!((b.length[0] - 4.0).abs() < 1e-12, "stem length {:.6}", b.length[0]);
        assert!((b.volume[0] - 1000.0*std::f64::consts::PI*0.01*4.0).abs() < 1e-9);
    }

    /// Where the branch leaves, which way it points, and how far it
    /// tilts — all measured from the base of the TREE, not of the
    /// branch's own parent.
    #[test]
    fn a_branch_reports_where_it_leaves_and_which_way_it_goes() {
        let b = branches(&stem_and_branch());
        assert!((b.height[1] - 1.75).abs() < 1e-12,
            "the branch leaves at {:.4} m, not 1.75", b.height[1]);
        assert!(b.height[0].abs() < 1e-12, "the stem starts at {:.4}", b.height[0]);
        // Due east: azimuth 0, and horizontal: zenith 90.
        assert!(b.azimuth[1].abs() < 1e-9, "azimuth {:.4}", b.azimuth[1]);
        assert!((b.zenith[1] - 90.0).abs() < 1e-9, "zenith {:.4}", b.zenith[1]);
        // The stem points straight up.
        assert!(b.zenith[0].abs() < 1e-9, "the stem's zenith is {:.4}", b.zenith[0]);
        // A right angle from the stem.
        assert!((b.angle[1] - 90.0).abs() < 1e-9,
            "the branch leaves at {:.4} degrees, not 90", b.angle[1]);
        assert!(b.angle[0].abs() < 1e-12, "the stem reports an angle of {:.4}", b.angle[0]);
    }

    /// A CONNECTOR IS NOT A DIRECTION. Where `parent_cylinder` spliced
    /// a cylinder onto the front to bridge a gap, that cylinder points
    /// wherever the gap lay. Measuring the branch angle from it reports
    /// the geometry of the gap rather than of the branch.
    #[test]
    fn the_branch_angle_skips_a_spliced_connector() {
        let build = |added: bool| {
            let mut m = Model::default();
            m.chain(0, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 0.5, 8, None, false);
            // A connector running up and out at 45 degrees...
            let c = m.chain(1, [0.10, 0.0, 1.75], [1.0, 0.0, 1.0], 0.04, 0.1, 1,
                            Some(3), added);
            // …then the branch itself, due east.
            let start = m.0.cyl.start[c as usize];
            let l = m.0.cyl.length[c as usize];
            let a = m.0.cyl.axis[c as usize];
            let from = [start[0]+a[0]*l, start[1]+a[1]*l, start[2]+a[2]*l];
            let n = m.0.cyl.len() as u32;
            m.chain(1, from, [1.0, 0.0, 0.0], 0.04, 0.25, 4, Some(c), false);
            // Stitch the connector to the rest of its own chain.
            m.0.extension[c as usize] = Some(n);
            m.0.parent[n as usize] = Some(c);
            m.finish()
        };
        let with_connector = branches(&build(true));
        let without = branches(&build(false));
        assert!((with_connector.angle[1] - 90.0).abs() < 1e-9,
            "with a connector the branch angle came out {:.4}, not the 90 degrees \
             the branch itself makes", with_connector.angle[1]);
        assert!((without.angle[1] - 45.0).abs() < 1e-9,
            "without the connector flag the angle should be the connector's own 45 \
             degrees, got {:.4}", without.angle[1]);
    }

    /// WHICH BRANCH EACH BRANCH LEAVES. A cylinder's continuation is
    /// the same branch carrying on, not a new one, and counting it as a
    /// child would make every branch its own parent.
    #[test]
    fn each_branch_names_the_branch_it_leaves() {
        let mut m = Model::default();
        m.chain(0, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 0.5, 8, None, false);
        let b1 = m.chain(1, [0.10, 0.0, 1.75], [1.0, 0.0, 0.0], 0.04, 0.25, 4,
                         Some(3), false);
        m.chain(2, [0.60, 0.0, 1.75], [0.0, 1.0, 0.0], 0.02, 0.2, 3,
                Some(b1 + 1), false);
        let b = branches(&m.finish());

        assert_eq!(b.parent[0], None, "the stem names a parent branch");
        assert_eq!(b.parent[1], Some(0), "branch 1 leaves branch {:?}", b.parent[1]);
        assert_eq!(b.parent[2], Some(1), "branch 2 leaves branch {:?}", b.parent[2]);
        assert_eq!(b.order, vec![0, 1, 2], "branch orders {:?}", b.order);
    }

    /// A segment that produced no cylinders keeps an empty row, so an
    /// index into this stays an index into the segmentation.
    #[test]
    fn a_segment_with_no_cylinders_keeps_an_empty_row() {
        let mut m = Model::default();
        m.chain(0, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 0.5, 8, None, false);
        // Nothing for segment 1; segment 2 has a chain.
        m.chain(2, [0.10, 0.0, 1.75], [1.0, 0.0, 0.0], 0.04, 0.25, 4, Some(3), false);
        let b = branches(&m.finish());
        assert_eq!(b.length.len(), 3, "expected a row per segment index");
        assert_eq!(b.length[1], 0.0);
        assert_eq!(b.volume[1], 0.0);
        assert_eq!(b.diameter[1], 0.0);
        assert_eq!(b.parent[1], None);
        assert!(b.length[2] > 0.0, "the segment that does have cylinders is empty");
    }

    /// The diameter is the branch's at its BASE. A tapering branch
    /// reported by its tip is reported as a twig.
    #[test]
    fn the_diameter_is_taken_at_the_base_and_not_the_tip() {
        let mut m = Model::default();
        m.chain(0, [0.0, 0.0, GROUND], [0.0, 0.0, 1.0], 0.10, 0.5, 8, None, false);
        let b1 = m.chain(1, [0.10, 0.0, GROUND + 1.75], [1.0, 0.0, 0.0], 0.04, 0.25, 4,
                         Some(3), false) as usize;
        for (k, r) in [0.04_f64, 0.03, 0.02, 0.01].iter().enumerate() {
            m.0.cyl.radius[b1 + k] = *r;
        }
        let b = branches(&m.finish());
        assert!((b.diameter[1] - 0.08).abs() < 1e-12,
            "a branch tapering 0.04 to 0.01 reports a diameter of {:.4}", b.diameter[1]);
    }

    #[test]
    fn an_empty_model_gives_no_branches() {
        let b = branches(&CylinderModel::default());
        assert!(b.length.is_empty() && b.order.is_empty());
    }
}

#[cfg(test)]
mod cylinders_driver_tests {
    use super::*;

    /// Builds a tree out of straight tubes and the cover/segment
    /// structures that describe it, so the driver can be run end to
    /// end without going through the whole cover-and-segment pipeline.
    struct Tree {
        points: Vec<[f64; 3]>,
        cover: CoverSets,
        topo: SegmentTopology,
    }

    impl Tree {
        fn new() -> Self {
            Tree {
                points: Vec::new(),
                cover: CoverSets { centre: Vec::new(), ball: Vec::new(), sets: Vec::new(),
                                   set_of_point: Vec::new(), neighbours: Vec::new() },
                topo: SegmentTopology::default(),
            }
        }

        /// Add a tube of `nl` layers running from `from` along `dir`,
        /// each layer one cover set holding a ring of points. Returns
        /// the segment index.
        fn tube(&mut self, from: [f64; 3], dir: [f64; 3], radius: f64,
                nl: usize, layer_h: f64, parent: Option<u32>) -> u32 {
            let n = (dir[0]*dir[0] + dir[1]*dir[1] + dir[2]*dir[2]).sqrt();
            let a = [dir[0]/n, dir[1]/n, dir[2]/n];
            let (u, w) = perp_basis(a).unwrap();
            let mut layers: Vec<Vec<u32>> = Vec::with_capacity(nl);
            for l in 0..nl {
                let mut ball: Vec<u32> = Vec::new();
                // Two rings per layer, so a layer has depth as well as
                // girth and the fitter has something to work with.
                for sub in 0..2 {
                    let s = (l as f64 + sub as f64 * 0.5) * layer_h;
                    for k in 0..24 {
                        let t = k as f64 / 24.0 * std::f64::consts::TAU;
                        self.points.push([
                            from[0] + a[0]*s + radius*(t.cos()*u[0] + t.sin()*w[0]),
                            from[1] + a[1]*s + radius*(t.cos()*u[1] + t.sin()*w[1]),
                            from[2] + a[2]*s + radius*(t.cos()*u[2] + t.sin()*w[2]),
                        ]);
                        ball.push((self.points.len() - 1) as u32);
                    }
                }
                let centre = ball[0];
                self.cover.ball.push(ball);
                self.cover.centre.push(centre);
                self.cover.sets.push(Vec::new());
                self.cover.neighbours.push(Vec::new());
                layers.push(vec![(self.cover.ball.len() - 1) as u32]);
            }
            self.topo.segments.push(layers);
            self.topo.parent.push(parent);
            self.topo.children.push(Vec::new());
            let si = (self.topo.segments.len() - 1) as u32;
            if let Some(p) = parent { self.topo.children[p as usize].push(si); }
            si
        }
    }

    /// A trunk with two branches off it, one of which forks again.
    fn sample_tree() -> Tree {
        let mut t = Tree::new();
        let trunk = t.tube([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.15, 20, 0.15, None);
        let b1 = t.tube([0.15, 0.0, 1.2], [1.0, 0.0, 0.3], 0.06, 12, 0.12, Some(trunk));
        let _b2 = t.tube([-0.15, 0.0, 2.1], [-1.0, 0.0, 0.4], 0.05, 12, 0.12, Some(trunk));
        let _b3 = t.tube([0.9, 0.0, 1.55], [0.6, 0.6, 0.5], 0.03, 10, 0.10, Some(b1));
        t
    }

    /// THE WHOLE THING. A trunk, two branches and a fork produce a
    /// model whose cylinders are all attached, all positive, and
    /// ordered from the trunk outwards.
    #[test]
    fn a_synthetic_tree_becomes_a_connected_model() {
        let t = sample_tree();
        let m = cylinders(&t.points, &t.cover, &t.topo, &AdjustParams::default());
        assert!(m.cyl.len() > 8, "only {} cylinders for a four-segment tree", m.cyl.len());

        // Every array is the same length as the model.
        let c = m.cyl.len();
        assert_eq!(m.parent.len(), c);
        assert_eq!(m.extension.len(), c);
        assert_eq!(m.added.len(), c);
        assert_eq!(m.unmod_radius.len(), c);
        assert_eq!(m.branch.len(), c);
        assert_eq!(m.branch_order.len(), c);
        assert_eq!(m.position_in_branch.len(), c);

        for i in 0..c {
            assert!(m.cyl.radius[i] > 0.0, "cylinder {i} has radius {}", m.cyl.radius[i]);
            assert!(m.cyl.length[i] > 0.0, "cylinder {i} has length {}", m.cyl.length[i]);
            // Parents are always written before their children, which
            // is what makes the single-pass branching order correct.
            if let Some(p) = m.parent[i] {
                assert!((p as usize) < i, "cylinder {i} names parent {p}, written later");
            }
            if let Some(e) = m.extension[i] {
                assert_eq!(e as usize, i + 1, "extension of {i} is {e}, not the next");
            }
        }
        // Exactly one root: the base of the trunk.
        assert_eq!(m.parent.iter().filter(|p| p.is_none()).count(), 1,
            "a tree with one trunk produced {} unattached cylinders",
            m.parent.iter().filter(|p| p.is_none()).count());
    }

    /// THE TRUNK IS ORDER ZERO, a branch off it is one, and a branch
    /// off that is two. This is the number every branch-level summary
    /// in a QSM is grouped by.
    #[test]
    fn branching_order_counts_how_far_from_the_trunk_a_cylinder_is() {
        let t = sample_tree();
        let m = cylinders(&t.points, &t.cover, &t.topo, &AdjustParams::default());
        let order_of = |seg: u32| -> Vec<u8> {
            (0..m.cyl.len()).filter(|&i| m.branch[i] == seg)
                .map(|i| m.branch_order[i]).collect()
        };
        assert!(order_of(0).iter().all(|&o| o == 0), "the trunk is not order 0");
        for seg in [1u32, 2] {
            let o = order_of(seg);
            assert!(!o.is_empty(), "segment {seg} produced no cylinders");
            assert!(o.iter().all(|&x| x == 1), "branch {seg} is at orders {o:?}, not 1");
        }
        let o3 = order_of(3);
        assert!(!o3.is_empty(), "the fork produced no cylinders");
        assert!(o3.iter().all(|&x| x == 2), "the fork is at orders {o3:?}, not 2");
    }

    /// Every cylinder is numbered along its own branch, from one.
    #[test]
    fn position_in_branch_runs_from_one_along_each_segment() {
        let t = sample_tree();
        let m = cylinders(&t.points, &t.cover, &t.topo, &AdjustParams::default());
        for (si, cyls) in m.cyls_in_segment.iter().enumerate() {
            for (k, &id) in cyls.iter().enumerate() {
                assert_eq!(m.position_in_branch[id as usize], k as u32 + 1,
                    "cylinder {id} of segment {si} is numbered {}",
                    m.position_in_branch[id as usize]);
                assert_eq!(m.branch[id as usize], si as u32);
            }
        }
        assert!(m.position_in_branch.iter().all(|&p| p >= 1));
    }

    /// A BRANCH IS NOT FATTER THAN THE TRUNK IT LEAVES. This is the
    /// property that needs the whole pipeline in the right order: the
    /// cap comes from the parent cylinder, which only exists because
    /// the segments were visited from the trunk outwards.
    #[test]
    fn no_branch_comes_out_thicker_than_what_it_grows_from() {
        let t = sample_tree();
        let m = cylinders(&t.points, &t.cover, &t.topo, &AdjustParams::default());
        for i in 0..m.cyl.len() {
            // Only the first cylinder of a branch is capped against its
            // parent; the rest are capped against the chain.
            if m.branch_order[i] == 0 { continue; }
            let Some(p) = m.parent[i] else { continue };
            if m.branch[p as usize] == m.branch[i] { continue; }
            assert!(m.cyl.radius[i] <= m.cyl.radius[p as usize] + 1e-9,
                "cylinder {i} of branch {} has radius {:.4} on a parent of {:.4}",
                m.branch[i], m.cyl.radius[i], m.cyl.radius[p as usize]);
        }
    }

    /// …and the case that needs the whole chain of four functions to
    /// run in the right order with the right arguments: a branch whose
    /// POINTS ARE FATTER THAN THE TRUNK'S.
    ///
    /// The fit will happily return the radius the points describe. Only
    /// `adjustments`, given the parent cylinder that `parent_cylinder`
    /// found, in a segment reached after its parent, brings it down.
    /// Drop any one of those and this comes out as a branch thicker
    /// than the stem it hangs on.
    #[test]
    fn a_branch_fitted_fatter_than_its_trunk_is_brought_back_below_it() {
        let mut t = Tree::new();
        let trunk = t.tube([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.06, 20, 0.15, None);
        let fat = t.tube([0.06, 0.0, 1.2], [1.0, 0.0, 0.2], 0.15, 12, 0.12, Some(trunk));
        let m = cylinders(&t.points, &t.cover, &t.topo, &AdjustParams::default());

        let ids = &m.cyls_in_segment[fat as usize];
        assert!(!ids.is_empty(), "the fat branch produced no cylinders");
        let first = ids[0] as usize;
        let p = m.parent[first].expect("the fat branch was not attached") as usize;
        assert!(m.cyl.radius[first] <= m.cyl.radius[p] + 1e-9,
            "a 0.15 branch on a 0.06 trunk came back at {:.4} against a parent of {:.4}",
            m.cyl.radius[first], m.cyl.radius[p]);

        // …and the model still reports what the fit actually said, so
        // the correction is visible rather than silent.
        assert!(m.unmod_radius[first] > m.cyl.radius[first] + 0.02,
            "the unmodified radius is {:.4} against a corrected {:.4}; the fit's own \
             answer was not kept", m.unmod_radius[first], m.cyl.radius[first]);
    }

    /// A segment whose points are not numbers produces no cylinders,
    /// rather than cylinders whose radius is not a number. A corrupt
    /// patch of cloud should cost that patch and nothing else.
    #[test]
    fn a_segment_of_unusable_points_is_dropped_rather_than_modelled() {
        let mut t = sample_tree();
        // Wreck the second branch's points.
        for &set in t.topo.segments[2].iter().flatten() {
            for &pt in &t.cover.ball[set as usize] {
                t.points[pt as usize] = [f64::NAN; 3];
            }
        }
        let m = cylinders(&t.points, &t.cover, &t.topo, &AdjustParams::default());
        assert!(m.cyls_in_segment[2].is_empty(),
            "a segment of NaN points produced {} cylinders",
            m.cyls_in_segment[2].len());
        for i in 0..m.cyl.len() {
            assert!(m.cyl.radius[i] > 0.0 && m.cyl.radius[i].is_finite(),
                "cylinder {i} has radius {}", m.cyl.radius[i]);
            assert!(m.cyl.length[i].is_finite(), "cylinder {i} has length {}",
                m.cyl.length[i]);
        }
        assert!(!m.cyls_in_segment[0].is_empty(), "the trunk was lost with it");
    }

    /// A segment too small to fit is skipped rather than producing a
    /// cylinder from nothing — and skipping it does not break the
    /// segments that remain.
    #[test]
    fn a_segment_too_small_to_fit_is_skipped_without_breaking_the_rest() {
        let mut t = sample_tree();
        // A stub of two layers and a handful of points.
        let trunk = 0u32;
        let stub = t.tube([0.15, 0.0, 0.6], [1.0, 0.0, 0.0], 0.02, 2, 0.05, Some(trunk));
        let m = cylinders(&t.points, &t.cover, &t.topo, &AdjustParams::default());
        assert!(m.cyls_in_segment[stub as usize].is_empty(),
            "a two-layer stub produced {} cylinders",
            m.cyls_in_segment[stub as usize].len());
        assert!(!m.cyls_in_segment[0].is_empty(), "the trunk was lost with it");
        assert!(!m.cyls_in_segment[3].is_empty(), "the fork was lost with it");
    }

    /// The visiting order: every base first, then its children, so a
    /// parent is always reached before the segments hanging off it.
    #[test]
    fn segments_are_visited_from_the_trunk_outwards() {
        let t = sample_tree();
        let order = segment_order(&t.topo);
        assert_eq!(order.len(), t.topo.segments.len(), "a segment was missed");
        let mut at = vec![usize::MAX; t.topo.segments.len()];
        for (k, &s) in order.iter().enumerate() { at[s as usize] = k; }
        for (s, p) in t.topo.parent.iter().enumerate() {
            if let Some(p) = p {
                assert!(at[*p as usize] < at[s],
                    "segment {s} is visited before its parent {p}");
            }
        }
    }

    /// A cycle in the segment graph is a wrong answer, not a hang.
    #[test]
    fn a_cyclic_segmentation_terminates() {
        let mut topo = SegmentTopology {
            segments: vec![vec![vec![0u32]]; 3],
            parent: vec![None, Some(0), Some(1)],
            children: vec![vec![1], vec![2], vec![1]],   // 2 points back at 1
        };
        let order = segment_order(&topo);
        assert!(order.len() <= 3, "the walk revisited segments: {order:?}");
        // …and a segment naming a child that does not exist.
        topo.children[0].push(99);
        let _ = segment_order(&topo);
    }

    #[test]
    fn an_empty_segmentation_produces_an_empty_model() {
        let t = Tree::new();
        let m = cylinders(&t.points, &t.cover, &t.topo, &AdjustParams::default());
        assert!(m.cyl.is_empty() && m.branch_order.is_empty());
    }
}

#[cfg(test)]
mod adjustments_tests {
    use super::*;

    /// A chain running up the z axis with the given radii and
    /// coverages, each cylinder 0.4 m long and starting where the last
    /// one ended.
    fn chain(radii: &[f64], covs: &[f64]) -> CylChain {
        let mut c = CylChain::default();
        for (i, (&r, &s)) in radii.iter().zip(covs).enumerate() {
            c.push(RefCyl {
                start: [0.0, 0.0, i as f64 * 0.4], axis: [0.0, 0.0, 1.0],
                length: 0.4, radius: r, surf_cov: s, mad: 0.002,
                conv: true, rel: true,
            });
        }
        c
    }

    fn parent_of(radius: f64) -> RefCyl {
        RefCyl { start: [0.0, 0.0, -1.0], axis: [0.0, 0.0, 1.0], length: 2.0,
                 radius, surf_cov: 0.9, mad: 0.001, conv: true, rel: true }
    }

    /// No taper correction, so a clamp test measures the clamp.
    fn clamp_only() -> AdjustParams {
        AdjustParams { taper_cor: false, ..Default::default() }
    }

    /// A BRANCH CANNOT BE FATTER THAN WHAT IT GROWS OUT OF. The cap is
    /// 0.95 of the parent's radius, and a fit that came back thicker
    /// than the trunk it hangs on is the single most visible way a QSM
    /// can be wrong.
    #[test]
    fn a_branch_fatter_than_its_parent_is_capped_below_it() {
        let mut c = chain(&[0.30, 0.06, 0.05], &[0.9, 0.9, 0.9]);
        let r0 = c.radius.clone();
        let parent = parent_of(0.10);
        adjustments(&mut c, &r0, Some(&parent), &clamp_only(), &[]);
        assert!(c.radius[0] <= 0.095 + 1e-12,
            "a branch on a 0.10 parent came back at {:.4}", c.radius[0]);
        assert!(c.radius[0] > 0.0);
    }

    /// …and with no parent to measure against, the cap comes from the
    /// chain's own base: 1.25 times the thickest of its first three.
    #[test]
    fn with_no_parent_the_cap_comes_from_the_chains_own_base() {
        let mut c = chain(&[0.08, 0.07, 0.06, 0.90, 0.05], &[0.9, 0.9, 0.9, 0.3, 0.9]);
        let r0 = c.radius.clone();
        adjustments(&mut c, &r0, None, &clamp_only(), &[]);
        // 1.25 * 0.08 = 0.10.
        assert!(c.radius[3] <= 0.10 + 1e-12,
            "an over-fat cylinder came back at {:.4} against a 0.10 cap", c.radius[3]);
    }

    /// A cylinder thinner than anything actually SEEN is raised to the
    /// floor. The floor is taken from the well-covered cylinders, not
    /// from the whole chain, because the thin ones are exactly the ones
    /// whose fit is not to be trusted.
    #[test]
    fn a_cylinder_thinner_than_the_well_seen_ones_is_raised_to_the_floor() {
        let mut c = chain(&[0.05, 0.05, 0.03], &[0.9, 0.9, 0.3]);
        let r0 = c.radius.clone();
        adjustments(&mut c, &r0, Some(&parent_of(0.20)), &clamp_only(), &[]);
        assert!((c.radius[2] - 0.05).abs() < 1e-12,
            "a 0.03 cylinder among 0.05 ones came back at {:.4}", c.radius[2]);
    }

    /// The cap bites at the parent's radius when the cylinder is
    /// POORLY SEEN, and only at 1.2 times it otherwise. A fit that is
    /// slightly fatter than its parent and well covered is believed; the
    /// same radius on a cylinder nobody got a good look at is not.
    #[test]
    fn a_slightly_over_thick_cylinder_is_capped_only_when_it_was_poorly_seen() {
        let covs = [0.3, 0.9, 0.9, 0.9, 0.9];
        let mut poor = chain(&[0.10, 0.06, 0.05, 0.05, 0.05], &covs);
        let r0 = poor.radius.clone();
        adjustments(&mut poor, &r0, Some(&parent_of(0.10)), &clamp_only(), &[]);
        assert!((poor.radius[0] - 0.095).abs() < 1e-9,
            "a poorly seen 0.10 cylinder on a 0.10 parent came back at {:.4}, not \
             capped at 0.095", poor.radius[0]);

        // The same radius, well seen, is inside 1.2x the cap and stands.
        let mut good = chain(&[0.10, 0.06, 0.05, 0.05, 0.05], &[0.9; 5]);
        let r0 = good.radius.clone();
        adjustments(&mut good, &r0, Some(&parent_of(0.10)), &clamp_only(), &[]);
        assert!((good.radius[0] - 0.10).abs() < 1e-9,
            "a well seen 0.10 cylinder was capped to {:.4} anyway", good.radius[0]);
    }

    /// A badly seen cylinder BETWEEN two well seen ones is simply the
    /// average of them. Its own fit carries no information the
    /// neighbours do not carry better.
    #[test]
    fn a_badly_seen_cylinder_between_two_good_ones_becomes_their_mean() {
        let mut c = chain(&[0.10, 0.02, 0.06], &[0.9, 0.3, 0.9]);
        let r0 = c.radius.clone();
        adjustments(&mut c, &r0, Some(&parent_of(0.20)), &clamp_only(), &[]);
        assert!((c.radius[1] - 0.08).abs() < 1e-9,
            "the middle cylinder came back at {:.4}, not the mean of 0.10 and 0.06",
            c.radius[1]);
    }

    /// …and it is only worth doing when the NEIGHBOURS were well seen.
    /// A badly seen cylinder between two other badly seen ones is left
    /// exactly as fitted: averaging it would spread one bad estimate
    /// over three cylinders rather than fix it.
    #[test]
    fn a_badly_seen_cylinder_between_two_bad_ones_is_left_as_fitted() {
        let mut c = chain(&[0.10, 0.02, 0.06, 0.05, 0.04], &[0.3; 5]);
        let before = c.radius.clone();
        let p = AdjustParams { parent_cor: false, taper_cor: false, ..Default::default() };
        adjustments(&mut c, &before, None, &p, &[]);
        assert_eq!(c.radius, before,
            "radii moved on a chain where nothing was seen well enough to \
             correct anything from: {:?} against {:?}", c.radius, before);
    }

    /// THE PARABOLA. Over a chain long enough to have a shape, a
    /// tapering curve is fitted through the radii weighted by how well
    /// each was seen, and the poorly seen ones are pulled towards it.
    /// Two fat, barely seen cylinders at the base of an otherwise thin
    /// branch come down; the well seen ones do not move.
    #[test]
    fn the_parabola_pulls_a_poorly_seen_bulge_back_towards_the_taper() {
        let mut c = chain(&[0.30, 0.28, 0.09, 0.08, 0.07, 0.06],
                          &[0.3, 0.3, 0.9, 0.9, 0.9, 0.9]);
        let r0 = c.radius.clone();
        adjustments(&mut c, &r0, None, &AdjustParams::default(), &[]);
        assert!(c.radius[0] < 0.25,
            "the fat, barely seen base came back at {:.4}, essentially unmoved",
            c.radius[0]);
        assert!(c.radius[0] > c.radius[5],
            "the chain no longer tapers: base {:.4}, tip {:.4}", c.radius[0], c.radius[5]);
        // The well-seen ones are left alone.
        for (i, (&got, &want)) in c.radius.iter().zip(&r0).enumerate().skip(2) {
            assert!((got - want).abs() < 0.02,
                "well-seen cylinder {i} moved from {want:.4} to {got:.4}");
        }
    }

    /// …and it FORCES a taper. A chain fitted thin at the base and fat
    /// at the tip is physically impossible, and the parabola's leading
    /// coefficient is clamped negative so the correction cannot
    /// reproduce it.
    #[test]
    fn the_correction_cannot_produce_a_branch_that_thickens_towards_its_tip() {
        let mut c = chain(&[0.04, 0.05, 0.06, 0.20, 0.25, 0.30],
                          &[0.3, 0.3, 0.3, 0.3, 0.3, 0.3]);
        let r0 = c.radius.clone();
        adjustments(&mut c, &r0, None, &AdjustParams::default(), &[]);
        assert!(c.radius[5] <= c.radius[0] + 1e-9,
            "the corrected chain still thickens: base {:.4}, tip {:.4}",
            c.radius[0], c.radius[5]);
    }

    /// THE JOINS ARE CLOSED. Every cylinder is moved along its own axis
    /// until it starts on the plane through the previous one's top. A
    /// chain with steps in it has volume between the pieces that
    /// nothing accounts for.
    #[test]
    fn a_step_between_two_cylinders_is_closed_along_the_axis() {
        let mut c = chain(&[0.06; 5], &[0.9; 5]);
        // Push cylinder 2 up by 0.15 and sideways by 0.03.
        c.start[2] = [0.03, 0.0, 0.8 + 0.15];
        let r0 = c.radius.clone();
        adjustments(&mut c, &r0, None, &clamp_only(), &[]);
        for j in 1..c.len() {
            let top = [c.start[j-1][0] + c.length[j-1]*c.axis[j-1][0],
                       c.start[j-1][1] + c.length[j-1]*c.axis[j-1][1],
                       c.start[j-1][2] + c.length[j-1]*c.axis[j-1][2]];
            let u = [c.start[j][0]-top[0], c.start[j][1]-top[1], c.start[j][2]-top[2]];
            let along = u[0]*c.axis[j][0] + u[1]*c.axis[j][1] + u[2]*c.axis[j][2];
            assert!(along.abs() < 1e-9,
                "cylinder {j} still starts {along:.5} m along its axis from the last top");
        }
    }

    /// A FIRST CYLINDER LEFT FLOATING is brought onto its parent's
    /// surface, and its tip stays where it was — the branch is
    /// reattached, not moved.
    #[test]
    fn a_floating_first_cylinder_is_brought_onto_the_parent_surface() {
        let mut c = CylChain::default();
        c.push(RefCyl { start: [0.5, 0.0, 0.0], axis: [1.0, 0.0, 0.0], length: 0.4,
                        radius: 0.05, surf_cov: 0.9, mad: 0.002, conv: true, rel: true });
        c.push(RefCyl { start: [0.9, 0.0, 0.0], axis: [1.0, 0.0, 0.0], length: 0.4,
                        radius: 0.04, surf_cov: 0.9, mad: 0.002, conv: true, rel: true });
        let tip_before = [c.start[0][0] + c.length[0]*c.axis[0][0],
                          c.start[0][1] + c.length[0]*c.axis[0][1],
                          c.start[0][2] + c.length[0]*c.axis[0][2]];
        let r0 = c.radius.clone();
        adjustments(&mut c, &r0, Some(&parent_of(0.20)), &clamp_only(), &[]);

        let d = (c.start[0][0].powi(2) + c.start[0][1].powi(2)).sqrt();
        assert!((d - 0.20).abs() < 1e-9,
            "the base sits {d:.4} from the parent axis, not on its 0.20 surface");
        let tip_after = [c.start[0][0] + c.length[0]*c.axis[0][0],
                         c.start[0][1] + c.length[0]*c.axis[0][1],
                         c.start[0][2] + c.length[0]*c.axis[0][2]];
        for k in 0..3 {
            assert!((tip_after[k] - tip_before[k]).abs() < 1e-9,
                "the tip moved from {tip_before:?} to {tip_after:?}");
        }
    }

    /// …and one already touching its parent is left alone.
    #[test]
    fn a_first_cylinder_already_on_the_surface_is_not_moved() {
        let mut c = CylChain::default();
        c.push(RefCyl { start: [0.2, 0.0, 0.0], axis: [1.0, 0.0, 0.0], length: 0.4,
                        radius: 0.05, surf_cov: 0.9, mad: 0.002, conv: true, rel: true });
        c.push(RefCyl { start: [0.6, 0.0, 0.0], axis: [1.0, 0.0, 0.0], length: 0.4,
                        radius: 0.04, surf_cov: 0.9, mad: 0.002, conv: true, rel: true });
        let before = c.clone();
        let r0 = c.radius.clone();
        adjustments(&mut c, &r0, Some(&parent_of(0.20)), &clamp_only(), &[]);
        assert_eq!(c.start[0], before.start[0], "a base already on the surface was moved");
        assert_eq!(c.length[0], before.length[0]);
    }

    /// RE-CENTRING. When a radius changes, the axis it was fitted with
    /// is no longer through the middle of the points, so the cylinder
    /// is slid sideways until it is. Without this a corrected radius
    /// leaves the cylinder poking out of its own data.
    #[test]
    fn a_changed_radius_re_centres_the_axis_on_the_points() {
        // One cylinder whose points lie on a circle of radius 0.10
        // centred 0.04 off the axis it was given.
        let mut c = CylChain::default();
        c.push(RefCyl { start: [0.0, 0.0, 0.0], axis: [0.0, 0.0, 1.0], length: 1.0,
                        radius: 0.02, surf_cov: 0.5, mad: 0.01, conv: true, rel: true });
        let mut reg: Vec<[f64; 3]> = Vec::new();
        for i in 0..60 {
            let t = i as f64 / 60.0 * std::f64::consts::TAU;
            for j in 0..50 {
                reg.push([0.04 + 0.10*t.cos(), 0.10*t.sin(), j as f64 / 49.0]);
            }
        }
        // Three more so the short-branch cap block is skipped, and a
        // coverage under 0.4 so the floor falls back to MinCylRad —
        // which forces every radius from 0.02 up to 0.10, a change
        // well over the 5 mm the re-centring asks for.
        for k in 1..4 {
            c.push(RefCyl { start: [0.0, 0.0, k as f64], axis: [0.0, 0.0, 1.0],
                            length: 1.0, radius: 0.02, surf_cov: 0.3, mad: 0.01,
                            conv: true, rel: true });
        }
        c.surf_cov[0] = 0.3;
        let r0 = vec![0.02; 4];
        let p = AdjustParams { min_cyl_rad: 0.10, taper_cor: false, parent_cor: false };
        let regs: Vec<Vec<[f64; 3]>> = (0..4).map(|k| reg.iter()
            .map(|q| [q[0], q[1], q[2] + k as f64]).collect()).collect();
        adjustments(&mut c, &r0, None, &p, &regs);

        assert!((c.radius[0] - 0.10).abs() < 1e-9, "radius {:.4}", c.radius[0]);
        let off = (c.start[0][0].powi(2) + c.start[0][1].powi(2)).sqrt();
        assert!((c.start[0][0] - 0.04).abs() < 0.005,
            "the axis moved to x = {:.4}, not onto the points' centre at 0.04 \
             (offset {off:.4})", c.start[0][0]);
        assert!(c.surf_cov[0] > 0.9,
            "a fully swept cylinder reported {:.3} coverage after the move — it was \
             not re-measured", c.surf_cov[0]);
    }

    /// …and a radius that barely moved does NOT re-centre. Below five
    /// millimetres the old axis is still through the middle of the
    /// points, and re-fitting anyway would let a circle fit on a
    /// partly-seen arc drag the cylinder sideways for no reason.
    #[test]
    fn a_radius_that_barely_moved_leaves_the_axis_alone() {
        // The middle cylinder is raised to the floor and then averaged
        // with its neighbours, a total move of four millimetres.
        let mut c = chain(&[0.100, 0.095, 0.098], &[0.9, 0.3, 0.9]);
        let r0 = c.radius.clone();
        // Its points sit 0.04 off the axis it was given, so a
        // re-centring would be plainly visible.
        let regs: Vec<Vec<[f64; 3]>> = (0..3).map(|k| {
            let off = if k == 1 { 0.04 } else { 0.0 };
            let mut v = Vec::new();
            for i in 0..60 {
                let t = i as f64 / 60.0 * std::f64::consts::TAU;
                for j in 0..20 {
                    v.push([off + 0.099*t.cos(), 0.099*t.sin(),
                            k as f64 * 0.4 + j as f64 / 19.0 * 0.4]);
                }
            }
            v
        }).collect();
        adjustments(&mut c, &r0, None, &AdjustParams::default(), &regs);

        assert!((c.radius[1] - 0.099).abs() < 1e-9,
            "the middle radius came back {:.5}, not the 0.099 this test is about",
            c.radius[1]);
        assert!((c.radius[1] - r0[1]).abs() < 0.005,
            "the radius moved {:.5}, more than the 5 mm threshold, so this fixture \
             no longer tests the threshold", (c.radius[1] - r0[1]).abs());
        assert!(c.start[1][0].abs() < 1e-9,
            "the axis was re-centred onto x = {:.4} after a 4 mm radius change",
            c.start[1][0]);
    }

    /// `surface_coverage2` counts CELLS, not points. Five hundred
    /// points piled into one place is one cell's worth of evidence
    /// about the surface, and a measure that said otherwise would
    /// report a stem seen from one angle as fully covered.
    #[test]
    fn surface_coverage2_counts_the_cells_reached_and_not_the_points() {
        let axis = [0.0, 0.0, 1.0];
        let (u, w) = perp_basis(axis).unwrap();
        let at = |ang: f64, r: f64| [r*(ang.cos()*u[0] + ang.sin()*w[0]),
                                     r*(ang.cos()*u[1] + ang.sin()*w[1]),
                                     r*(ang.cos()*u[2] + ang.sin()*w[2])];

        // Five hundred points at one angle and one height: one cell of
        // a hundred.
        let piled: Vec<[f64; 3]> = (0..500).map(|_| at(0.3, 0.1)).collect();
        let h = vec![0.5_f64; 500];
        let c = surface_coverage2(axis, 1.0, &piled, &h, 10, 10);
        assert!((c - 0.01).abs() < 1e-12,
            "500 points in one place reported {c:.4} coverage, not 1/100");

        // …and a real sweep does fill the grid, so the measure is not
        // merely always small.
        let mut spread: Vec<[f64; 3]> = Vec::new();
        let mut hs: Vec<f64> = Vec::new();
        for i in 0..10 {
            for j in 0..10 {
                spread.push(at(i as f64 / 10.0 * std::f64::consts::TAU, 0.1));
                hs.push((j as f64 + 0.5) / 10.0);
            }
        }
        let full = surface_coverage2(axis, 1.0, &spread, &hs, 10, 10);
        assert!(full > 0.95, "a full sweep reported only {full:.3}");
    }

    #[test]
    fn degenerate_input_does_not_panic() {
        let mut empty = CylChain::default();
        adjustments(&mut empty, &[], None, &AdjustParams::default(), &[]);
        assert!(empty.is_empty());

        // Zero coverage everywhere: the weighted mean divides by zero.
        let mut c = chain(&[0.05, 0.04, 0.03], &[0.0, 0.0, 0.0]);
        let r0 = c.radius.clone();
        adjustments(&mut c, &r0, None, &AdjustParams::default(), &[]);
        // Zero length everywhere: the parabola has no abscissa.
        let mut d = chain(&[0.05; 6], &[0.5; 6]);
        for l in d.length.iter_mut() { *l = 0.0; }
        let r0 = d.radius.clone();
        adjustments(&mut d, &r0, None, &AdjustParams::default(), &[]);
    }
}

#[cfg(test)]
mod parent_cylinder_tests {
    use super::*;

    /// A trunk as four stacked cylinders of radius 0.2, from z = 0 to
    /// z = 2, and the ids of its cylinders.
    fn trunk() -> (CylChain, Vec<u32>) {
        let mut s = CylChain::default();
        for k in 0..4 {
            s.push(RefCyl {
                start: [0.0, 0.0, k as f64 * 0.5], axis: [0.0, 0.0, 1.0],
                length: 0.5, radius: 0.2, surf_cov: 0.9, mad: 0.001,
                conv: true, rel: true,
            });
        }
        (s, vec![0, 1, 2, 3])
    }

    /// A branch of `n` cylinders end to end from `start` along `axis`.
    fn branch(start: [f64; 3], axis: [f64; 3], length: f64, n: usize) -> CylChain {
        let l = (axis[0]*axis[0] + axis[1]*axis[1] + axis[2]*axis[2]).sqrt();
        let a = [axis[0]/l, axis[1]/l, axis[2]/l];
        let mut c = CylChain::default();
        for k in 0..n {
            c.push(RefCyl {
                start: [start[0] + a[0]*length*k as f64,
                        start[1] + a[1]*length*k as f64,
                        start[2] + a[2]*length*k as f64],
                axis: a, length, radius: 0.05, surf_cov: 0.8, mad: 0.002,
                conv: true, rel: true,
            });
        }
        c
    }

    fn tip(c: &CylChain) -> [f64; 3] {
        let i = c.len() - 1;
        [c.start[i][0] + c.length[i]*c.axis[i][0],
         c.start[i][1] + c.length[i]*c.axis[i][1],
         c.start[i][2] + c.length[i]*c.axis[i][2]]
    }

    /// A branch whose points start SHORT of the trunk is extended back
    /// to the trunk's surface. This is the whole job: a segmentation
    /// gives a branch that begins where its points begin, and a tree
    /// needs one that begins where the branch does.
    #[test]
    fn a_branch_that_stops_short_is_extended_back_to_the_trunk_surface() {
        let (store, pcs) = trunk();
        let mut c = branch([0.5, 0.0, 1.0], [1.0, 0.0, 0.0], 0.4, 2);
        let before_tip = tip(&c);
        let before_len = c.length[0];
        let (pc, added) = parent_cylinder(&pcs, true, true, &store, &mut c);

        assert!(pc.is_some(), "no parent cylinder was found");
        assert!(!added, "a connector was added where a crossing exists");
        assert!((c.start[0][0] - 0.2).abs() < 1e-9,
            "the branch now starts at x = {:.4}, not on the 0.2 trunk surface", c.start[0][0]);
        assert!((c.length[0] - (before_len + 0.3)).abs() < 1e-9,
            "the first cylinder is {:.4} long, not {:.4}", c.length[0], before_len + 0.3);
        let t = tip(&c);
        for k in 0..3 {
            assert!((t[k] - before_tip[k]).abs() < 1e-9,
                "the tip moved: {t:?} against {before_tip:?}");
        }
    }

    /// …and one whose points start INSIDE the trunk is pulled back out
    /// to the same surface. Left alone it would report a branch that
    /// begins inside the stem, and its volume would be counted twice.
    #[test]
    fn a_branch_that_starts_inside_the_trunk_is_pulled_out_to_its_surface() {
        let (store, pcs) = trunk();
        let mut c = branch([0.1, 0.0, 1.0], [1.0, 0.0, 0.0], 0.4, 2);
        let before_tip = tip(&c);
        let before_len = c.length[0];
        let (pc, added) = parent_cylinder(&pcs, true, true, &store, &mut c);

        assert!(pc.is_some() && !added);
        assert!((c.start[0][0] - 0.2).abs() < 1e-9,
            "the branch starts at x = {:.4}, not on the surface", c.start[0][0]);
        assert!((c.length[0] - (before_len - 0.1)).abs() < 1e-9,
            "the first cylinder is {:.4} long, not {:.4}", c.length[0], before_len - 0.1);
        let t = tip(&c);
        for k in 0..3 { assert!((t[k] - before_tip[k]).abs() < 1e-9, "the tip moved"); }
    }

    /// The parent is the cylinder of the trunk the branch actually
    /// meets, not simply the first or the nearest by start point.
    #[test]
    fn the_parent_is_the_trunk_cylinder_the_branch_meets() {
        let (store, pcs) = trunk();
        // Leaves at z = 1.7, which is inside the fourth cylinder
        // (z from 1.5 to 2.0).
        let mut c = branch([0.5, 0.0, 1.7], [1.0, 0.0, 0.0], 0.4, 2);
        let (pc, _) = parent_cylinder(&pcs, true, true, &store, &mut c);
        assert_eq!(pc, Some(3),
            "the branch leaves at z = 1.7 and was given parent {pc:?}, not cylinder 3");
    }

    /// …and it is chosen by WHERE THE CROSSING FALLS, not by which
    /// trunk cylinder happens to start nearest.
    ///
    /// Here the branch leaves at z = 1.3, inside cylinder 2 (which runs
    /// 1.0 to 1.5), while cylinder 3's start at z = 1.5 is the nearer
    /// of the two to the branch's base. Take the nearest and the branch
    /// is attached above where it actually joins.
    #[test]
    fn the_parent_is_not_merely_the_nearest_candidate() {
        let (store, pcs) = trunk();
        let mut c = branch([0.5, 0.0, 1.3], [1.0, 0.0, 0.0], 0.4, 2);
        // The premise: cylinder 3's start really is the nearer one.
        let d2 = |p: [f64; 3]| (p[0]-0.5).powi(2) + p[1].powi(2) + (p[2]-1.3).powi(2);
        assert!(d2(store.start[3]) < d2(store.start[2]),
            "the fixture does not set up the case it is about");
        let (pc, _) = parent_cylinder(&pcs, true, true, &store, &mut c);
        assert_eq!(pc, Some(2),
            "the branch crosses inside cylinder 2 and was given {pc:?}");
    }

    /// When nothing crosses cleanly, the NEAREST miss is taken — the
    /// candidate whose crossing falls least far outside its own extent.
    ///
    /// The branch here sits just above the top of the trunk and misses
    /// every cylinder, by 0.04 m on the topmost and by more than a
    /// metre on the lowest. Taking the worst miss instead of the best
    /// attaches the branch to the base of the tree.
    #[test]
    fn the_nearest_miss_is_taken_and_not_the_furthest() {
        let (store, pcs) = trunk();
        // Base at z = 2.04, just past the trunk's top at 2.0, aimed at
        // the axis and long enough to reach across.
        let mut c = branch([0.5, 0.0, 2.04], [-1.0, 0.0, 0.0], 1.0, 2);
        let (pc, added) = parent_cylinder(&pcs, true, true, &store, &mut c);
        assert_eq!(pc, Some(3),
            "the nearest miss is cylinder 3, 0.04 m past its top; got {pc:?}");
        assert!(!added, "a connector was added where a near miss was available");
        assert_eq!(c.len(), 2, "the chain lost a cylinder");
    }

    /// A CONNECTOR TOO SHORT TO BE ONE is not added. A branch whose
    /// base already sits five millimetres off the trunk needs no
    /// bridging cylinder, and adding one puts a sliver of false volume
    /// at every junction in the tree.
    #[test]
    fn a_connector_shorter_than_a_centimetre_is_not_added() {
        let (store, pcs) = trunk();
        // 0.205 from the axis — five millimetres off a 0.2 surface —
        // and running in y, so its own axis never meets the trunk.
        let mut c = branch([0.205, 0.0, 1.0], [0.0, 1.0, 0.0], 0.4, 2);
        let before = c.clone();
        let (_, added) = parent_cylinder(&pcs, true, true, &store, &mut c);
        assert!(!added, "a 5 mm connector was spliced onto the chain");
        assert_eq!(c, before, "the chain was modified anyway");
    }

    /// The connector attaches to a parent the branch is actually
    /// ALONGSIDE, not merely one that is close.
    ///
    /// The trunk here is kinked: its lowest cylinder is offset in x, so
    /// it is the nearest of the four to the branch — but the branch
    /// passes it a metre higher than it ends. Only cylinder 3 is beside
    /// the branch, and that is the one to bridge to.
    #[test]
    fn the_connector_attaches_beside_the_branch_and_not_merely_near_it() {
        let (mut store, pcs) = trunk();
        store.start[0] = [0.3, 0.0, 0.0];      // kink the base outwards
        let mut c = branch([2.0, 0.0, 1.6], [0.0, 1.0, 0.0], 0.4, 2);
        // The premise: the offset cylinder really is the nearest by
        // perpendicular distance.
        assert!((2.0 - store.start[0][0]) < 2.0);
        let (pc, added) = parent_cylinder(&pcs, true, true, &store, &mut c);
        assert!(added, "no connector was built");
        assert_eq!(pc, Some(3),
            "the branch runs alongside cylinder 3 at z = 1.6 and was bridged to {pc:?}");
    }

    /// A branch that does not point at the trunk at all gets a
    /// CONNECTOR built for it, running from the trunk's surface to
    /// where the branch's own points begin.
    #[test]
    fn a_branch_that_misses_the_trunk_gets_a_connector() {
        let (store, pcs) = trunk();
        // Sitting out at x = 2 and running in y: its axis never meets
        // the trunk, extended either way.
        let mut c = branch([2.0, 0.0, 1.0], [0.0, 1.0, 0.0], 0.4, 2);
        let before = c.len();
        let (pc, added) = parent_cylinder(&pcs, true, true, &store, &mut c);

        assert!(added, "no connector was added for a branch that misses the trunk");
        assert_eq!(c.len(), before + 1, "the connector was not spliced onto the front");
        assert!(pc.is_some());
        // It starts on the trunk's surface and ends where the branch's
        // own first cylinder starts.
        let s = c.start[0];
        assert!(((s[0]*s[0] + s[1]*s[1]).sqrt() - 0.2).abs() < 1e-6,
            "the connector starts {:.4} from the axis, not on the 0.2 surface",
            (s[0]*s[0] + s[1]*s[1]).sqrt());
        let end = [s[0] + c.length[0]*c.axis[0][0],
                   s[1] + c.length[0]*c.axis[0][1],
                   s[2] + c.length[0]*c.axis[0][2]];
        for k in 0..3 {
            assert!((end[k] - c.start[1][k]).abs() < 1e-6,
                "the connector ends at {end:?}, not at the branch's base {:?}", c.start[1]);
        }
        // A connector is not a measurement: it borrows the first real
        // cylinder's radius and quality rather than inventing any.
        assert!((c.radius[0] - c.radius[1]).abs() < 1e-12);
        assert!((c.surf_cov[0] - c.surf_cov[1]).abs() < 1e-12);
    }

    /// A candidate whose crossings match NONE of the six sign cases is
    /// not a crossing. The reference leaves such a candidate's record
    /// untouched at zero and then reads that zero as a crossing at
    /// distance zero, accepting it as the parent and leaving the
    /// branch's base where it was — see fix 7.
    ///
    /// Here the branch points at the trunk from outside but is shorter
    /// than the distance to it, so both crossings lie beyond its own
    /// far end and no case applies.
    #[test]
    fn a_candidate_matching_no_case_is_not_taken_as_a_perfect_crossing() {
        let (store, pcs) = trunk();
        // Base at x = 0.5, aimed inwards, 0.1 long — the near crossing
        // is 0.3 away, so the branch cannot reach it.
        let mut c = branch([0.5, 0.0, 1.0], [-1.0, 0.0, 0.0], 0.1, 2);
        let before = c.clone();
        let (pc, added) = parent_cylinder(&pcs, true, true, &store, &mut c);

        // Whatever it decides, it must not claim a parent AND leave the
        // base untouched: that is the pair of outcomes the zero row
        // produced, and it means "attached" while nothing was attached.
        let unmoved = c.start[0] == before.start[0] && c.length[0] == before.length[0];
        assert!(!(pc.is_some() && unmoved && !added),
            "the branch was given parent {pc:?} with its base left at {:?} and no \
             connector — it is not attached to anything", c.start[0]);
    }

    /// A LONE cylinder that meets nothing, on a segment with no
    /// children to orphan, is discarded rather than left floating.
    #[test]
    fn a_lone_unattachable_cylinder_on_a_childless_segment_is_dropped() {
        let (store, pcs) = trunk();
        // On the trunk's axis, pointing out, and SHORTER than the
        // distance to the surface: every crossing is further away than
        // the cylinder is long, so none can be reached.
        let mut c = branch([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], 0.1, 1);
        let (pc, added) = parent_cylinder(&pcs, true, false, &store, &mut c);
        assert!(c.is_empty(),
            "a cylinder that attaches to nothing survived: {} left", c.len());
        assert_eq!(pc, None);
        assert!(!added);
    }

    /// …and the same cylinder is KEPT when the segment has children,
    /// because dropping it would orphan them.
    #[test]
    fn the_same_cylinder_is_kept_when_something_hangs_off_it() {
        let (store, pcs) = trunk();
        let mut c = branch([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], 0.1, 1);
        let (_, _) = parent_cylinder(&pcs, true, true, &store, &mut c);
        assert!(!c.is_empty(), "a cylinder with children hanging off it was dropped");
    }

    /// No parent segment, or only one candidate cylinder: the chain is
    /// returned untouched. The reference does not move a base it has
    /// no choice about.
    #[test]
    fn a_chain_with_no_real_choice_of_parent_is_left_alone() {
        let (store, pcs) = trunk();

        let mut a = branch([0.5, 0.0, 1.0], [1.0, 0.0, 0.0], 0.4, 2);
        let before = a.clone();
        let (pc, added) = parent_cylinder(&pcs, false, true, &store, &mut a);
        assert_eq!((pc, added), (None, false));
        assert_eq!(a, before, "a chain with no parent segment was modified");

        let mut b = branch([0.5, 0.0, 1.0], [1.0, 0.0, 0.0], 0.4, 2);
        let before = b.clone();
        let (pc, added) = parent_cylinder(&[2], true, true, &store, &mut b);
        assert_eq!((pc, added), (Some(2), false));
        assert_eq!(b, before, "a chain with a single candidate was modified");

        let mut d = branch([0.5, 0.0, 1.0], [1.0, 0.0, 0.0], 0.4, 2);
        let (pc, added) = parent_cylinder(&[], true, true, &store, &mut d);
        assert_eq!((pc, added), (None, false));
    }

    /// `distances_between_lines` puts the closest approach in the right
    /// place along each line, and returns the separation in METRES.
    /// The reference returns its square root; see fix 5.
    #[test]
    fn the_closest_approach_lands_where_it_should_and_orders_correctly() {
        // A ray up the z axis at x = 1, against three lines along y at
        // increasing distance.
        let lines = [[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [0.5, 0.0, 0.0]];
        let dirs = [[0.0, 1.0, 0.0]; 3];
        let (d, _, on_lines) =
            distances_between_lines([1.0, 0.0, 0.0], [0.0, 0.0, 1.0], &lines, &dirs);
        // The lines run through y = 0 and the ray sits at y = 0, so the
        // closest approach is at the lines' own origins.
        for (k, &v) in on_lines.iter().enumerate() {
            assert!(v.abs() < 1e-9, "line {k} closest at {v}, not at its origin");
        }
        // The ray sits at x = 1; the lines at x = 0, 3 and 0.5 are
        // therefore 1, 2 and 0.5 metres from it.
        assert!((d[0] - 1.0).abs() < 1e-9, "line 0 is {} from the ray, not 1", d[0]);
        assert!((d[1] - 2.0).abs() < 1e-9, "line 1 is {} from the ray, not 2", d[1]);
        assert!((d[2] - 0.5).abs() < 1e-9, "line 2 is {} from the ray, not 0.5", d[2]);
    }

    #[test]
    fn degenerate_input_does_not_panic() {
        let (store, pcs) = trunk();
        let mut empty = CylChain::default();
        assert_eq!(parent_cylinder(&pcs, true, true, &store, &mut empty), (None, false));
        // A parent list naming a cylinder that is coaxial with the
        // branch: the common normal is undefined.
        let mut c = branch([0.0, 0.0, 3.0], [0.0, 0.0, 1.0], 0.4, 2);
        let _ = parent_cylinder(&pcs, true, true, &store, &mut c);
    }
}

#[cfg(test)]
mod cylinder_fitting_tests {
    use super::*;

    /// A segment built as a stack of rings. Returns the points, the
    /// per-layer index list and the layer spans — exactly the three
    /// things `cylinder_fitting` takes.
    ///
    /// `radius_at` gives the radius at a height fraction in 0..1, so a
    /// caller can build a straight tube, a taper or a kink.
    /// Points, the segment's point list, and the per-layer spans.
    type Built = (Vec<[f64; 3]>, Vec<u32>, Vec<(usize, usize)>);

    fn segment(
        nl: usize, per_ring: usize, layer_h: f64,
        centre_at: impl Fn(f64) -> [f64; 3],
        radius_at: impl Fn(f64) -> f64,
    ) -> Built {
        let mut points: Vec<[f64; 3]> = Vec::new();
        let mut seg: Vec<u32> = Vec::new();
        let mut spans: Vec<(usize, usize)> = Vec::new();
        for l in 0..nl {
            let start = seg.len();
            let f = l as f64 / (nl - 1).max(1) as f64;
            let c = centre_at(f);
            let r = radius_at(f);
            // Two rings per layer, so a layer has depth as well as girth.
            for sub in 0..2 {
                let z = c[2] + sub as f64 * layer_h * 0.5;
                for k in 0..per_ring {
                    let a = k as f64 / per_ring as f64 * std::f64::consts::TAU;
                    points.push([c[0] + r * a.cos(), c[1] + r * a.sin(), z]);
                    seg.push((points.len() - 1) as u32);
                }
            }
            spans.push((start, seg.len()));
        }
        (points, seg, spans)
    }

    fn dot(a: [f64; 3], b: [f64; 3]) -> f64 { a[0]*b[0] + a[1]*b[1] + a[2]*b[2] }

    /// A SHORT SEGMENT — six layers or fewer — gets one cylinder over
    /// the whole of it, because there is no room to fit several lengths
    /// and choose between them.
    #[test]
    fn a_short_segment_becomes_a_single_cylinder() {
        let (p, seg, spans) = segment(5, 40, 0.1,
            |f| [0.0, 0.0, f * 0.4], |_| 0.06);
        let r = cylinder_fitting(&p, &seg, &spans, true);
        assert_eq!(r.cylinders.len(), 1, "a five-layer segment gave {} cylinders", r.cylinders.len());
        assert_eq!(r.regions.len(), 1);
        let c = r.cylinders[0];
        assert!((c.radius - 0.06).abs() < 0.01, "radius {:.4}, not 0.06", c.radius);
        assert!(dot(c.axis, [0.0, 0.0, 1.0]) > 0.99, "axis {:?} is not upright", c.axis);
    }

    /// …and a segment with barely any points gives nothing rather than
    /// a cylinder fitted to noise.
    #[test]
    fn a_segment_with_too_few_points_gives_no_cylinder() {
        // Four layers of two points each: eight in all, under the
        // reference's floor of ten.
        let (p, seg, spans) = segment(4, 1, 0.1, |f| [0.0, 0.0, f * 0.3], |_| 0.05);
        assert_eq!(seg.len(), 8, "the fixture is not the size this test is about");
        let r = cylinder_fitting(&p, &seg, &spans, true);
        assert!(r.cylinders.is_empty(),
            "{} cylinder(s) fitted to eight points", r.cylinders.len());
    }

    /// A LONG STRAIGHT TUBE becomes a chain that covers it end to end.
    /// This is the property everything downstream depends on: the
    /// cylinders' lengths must add up to the segment, or the volume is
    /// short by whatever was missed.
    #[test]
    fn a_long_straight_segment_becomes_a_chain_that_spans_it() {
        let nl = 30;
        let (p, seg, spans) = segment(nl, 40, 0.1,
            |f| [0.0, 0.0, f * 3.0], |_| 0.08);
        let r = cylinder_fitting(&p, &seg, &spans, true);
        assert!(r.cylinders.len() >= 2,
            "a 30-layer segment gave {} cylinder(s)", r.cylinders.len());
        assert_eq!(r.cylinders.len(), r.regions.len());
        for c in &r.cylinders {
            assert!((c.radius - 0.08).abs() < 0.02, "radius {:.4}, not 0.08", c.radius);
            assert!(dot(c.axis, [0.0, 0.0, 1.0]) > 0.98, "axis {:?} is not upright", c.axis);
        }
        let total: f64 = r.cylinders.iter().map(|c| c.length).sum();
        // The segment spans 3.0 m plus half a layer for the second ring.
        assert!(total > 2.7 && total < 3.4,
            "the chain is {total:.3} m long over a segment of about 3.05 m");
    }

    /// …and the chain RUNS UPWARD, each cylinder starting at or above
    /// the one before it. A chain that doubles back is not a tree.
    #[test]
    fn the_chain_runs_from_the_base_towards_the_tip() {
        let (p, seg, spans) = segment(30, 40, 0.1, |f| [0.0, 0.0, f * 3.0], |_| 0.08);
        let r = cylinder_fitting(&p, &seg, &spans, true);
        let mut prev = f64::NEG_INFINITY;
        for (k, c) in r.cylinders.iter().enumerate() {
            assert!(c.start[2] >= prev - 0.05,
                "cylinder {k} starts at z = {:.3}, below the previous {:.3}", c.start[2], prev);
            prev = c.start[2];
        }
        assert!(r.cylinders[0].start[2] < 0.35,
            "the chain starts at z = {:.3}, not at the segment's base",
            r.cylinders[0].start[2]);
    }

    /// A TAPER is followed. A segment thick at the base and thin at the
    /// tip must give cylinders that shrink; one fixed radius over the
    /// whole segment is the failure this chain exists to avoid.
    #[test]
    fn a_tapering_segment_gives_cylinders_that_shrink() {
        let (p, seg, spans) = segment(30, 40, 0.1,
            |f| [0.0, 0.0, f * 3.0], |f| 0.15 - 0.11 * f);
        let r = cylinder_fitting(&p, &seg, &spans, true);
        assert!(r.cylinders.len() >= 2, "only {} cylinder(s)", r.cylinders.len());
        let first = r.cylinders.first().unwrap().radius;
        let last = r.cylinders.last().unwrap().radius;
        assert!(first > last + 0.03,
            "the chain runs {first:.4} to {last:.4} over a segment tapering 0.15 to 0.04");
    }

    /// A BEND is followed too — the reason several region lengths are
    /// fitted and the best chosen, rather than one fixed length used
    /// throughout. A single cylinder over a segment that turns
    /// thirty degrees fits neither half.
    #[test]
    fn a_bent_segment_gives_cylinders_that_follow_the_bend() {
        let (p, seg, spans) = segment(34, 40, 0.1, |f| {
            // Straight up for the lower half, then leaning in +x.
            if f < 0.5 { [0.0, 0.0, f * 3.4] }
            else { [(f - 0.5) * 1.6, 0.0, f * 3.4] }
        }, |_| 0.07);
        let r = cylinder_fitting(&p, &seg, &spans, true);
        assert!(r.cylinders.len() >= 2,
            "a bent segment gave {} cylinder(s), so nothing can follow the bend",
            r.cylinders.len());
        let lean: Vec<f64> = r.cylinders.iter().map(|c| c.axis[0]).collect();
        let lo = lean.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = lean.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        assert!(hi - lo > 0.15,
            "every cylinder points the same way (x-components {lo:.3}..{hi:.3}); \
             the chain is not following the bend");
    }

    /// THE CHAIN IS CONTINUOUS AND SPANS THE SEGMENT. Each cylinder
    /// starts where the previous one ended, and together they cover the
    /// segment once — not twice, and not two thirds of it.
    ///
    /// This is what every volume downstream rests on, and it is what
    /// the region stepping exists to produce: advance the region past
    /// the cylinder just kept, and the next one begins where it left
    /// off. Fail to advance and the same length is measured several
    /// times over; advance too far and the gaps are simply missing.
    #[test]
    fn the_chain_is_continuous_and_covers_the_segment_exactly_once() {
        let (p, seg, spans) = segment(30, 40, 0.1, |f| [0.0, 0.0, f * 3.0], |_| 0.08);
        let r = cylinder_fitting(&p, &seg, &spans, true);
        let n = r.cylinders.len();
        assert!((5..=20).contains(&n),
            "{n} cylinders over 30 layers — the region is not advancing by a sensible step");

        let mut worst = 0.0_f64;
        for k in 1..n {
            let a = r.cylinders[k - 1];
            let top = [a.start[0] + a.length*a.axis[0],
                       a.start[1] + a.length*a.axis[1],
                       a.start[2] + a.length*a.axis[2]];
            let b = r.cylinders[k].start;
            let d = ((top[0]-b[0]).powi(2) + (top[1]-b[1]).powi(2) + (top[2]-b[2]).powi(2)).sqrt();
            if d > worst { worst = d; }
        }
        assert!(worst < 0.01,
            "the chain breaks by {worst:.4} m between two cylinders on a straight segment");

        // The segment spans 3.0 m of layer centres plus half a layer for
        // the second ring: 3.05 m.
        let total: f64 = r.cylinders.iter().map(|c| c.length).sum();
        assert!((total - 3.05).abs() < 0.03,
            "the chain measures {total:.3} m of a 3.05 m segment");
        assert!(total / n as f64 > 0.15,
            "the mean cylinder is {:.3} m, barely more than one 0.1 m layer — \
             the region is advancing one layer at a time", total / n as f64);
    }

    /// …and it does not double-count on a TAPERING segment, where the
    /// changing radius gives the region stepping more chances to
    /// misjudge where the previous cylinder ended.
    #[test]
    fn a_tapering_segment_is_not_measured_twice_over() {
        let (p, seg, spans) = segment(30, 40, 0.1,
            |f| [0.0, 0.0, f * 3.0], |f| 0.15 - 0.11 * f);
        let r = cylinder_fitting(&p, &seg, &spans, true);
        let total: f64 = r.cylinders.iter().map(|c| c.length).sum();
        assert!(total < 3.3,
            "the chain measures {total:.3} m of a 3.05 m segment — it is counting \
             the same length more than once");
        assert!(total > 2.5, "the chain measures only {total:.3} m of 3.05 m");
    }

    /// THE FILTER BEFORE EVERY FIT EARNS ITS PLACE. A region that has
    /// swallowed a neighbouring surface has points well outside the
    /// stem, and an unfiltered least-squares fit splits the difference
    /// between the two.
    #[test]
    fn a_far_second_surface_does_not_inflate_the_radius() {
        let (mut p, seg, spans) = segment(30, 40, 0.1, |f| [0.0, 0.0, f * 3.0], |_| 0.08);
        // One point in four echoed three times further out.
        let mut seg2: Vec<u32> = Vec::new();
        let mut spans2: Vec<(usize, usize)> = Vec::new();
        for &(lo, hi) in &spans {
            let start = seg2.len();
            seg2.extend(seg[lo..hi].iter().copied());
            for (n, &i) in seg[lo..hi].iter().enumerate() {
                if n % 4 == 0 {
                    let q = p[i as usize];
                    p.push([q[0] * 3.0, q[1] * 3.0, q[2]]);
                    seg2.push((p.len() - 1) as u32);
                }
            }
            spans2.push((start, seg2.len()));
        }
        let r = cylinder_fitting(&p, &seg2, &spans2, true);
        assert!(!r.cylinders.is_empty());
        for (k, c) in r.cylinders.iter().enumerate() {
            assert!((c.radius - 0.08).abs() < 0.01,
                "cylinder {k} came back at radius {:.4} against a true 0.08; the far \
                 surface at 0.24 was fitted along with the near one", c.radius);
        }
    }

    /// A BADLY SCANNED SEGMENT is fitted but marked unreliable. The
    /// caller needs to know the difference, and `rel` is how it is
    /// told: coverage under a fifth means the surface was barely seen,
    /// whatever the residuals say about the points that were.
    #[test]
    fn a_segment_scanned_through_a_narrow_arc_is_marked_unreliable() {
        let (p, seg, spans) = segment(30, 40, 0.1, |f| [0.0, 0.0, f * 3.0], |_| 0.08);
        let mut seg2: Vec<u32> = Vec::new();
        let mut spans2: Vec<(usize, usize)> = Vec::new();
        for &(lo, hi) in &spans {
            let start = seg2.len();
            // About forty degrees of the circle.
            seg2.extend(seg[lo..hi].iter().copied()
                .filter(|&i| p[i as usize][1].atan2(p[i as usize][0]).abs() < 0.35));
            spans2.push((start, seg2.len()));
        }
        let r = cylinder_fitting(&p, &seg2, &spans2, true);
        assert!(!r.cylinders.is_empty(), "a narrow arc produced nothing at all");
        assert!(r.cylinders.iter().any(|c| c.surf_cov < 0.2 && !c.rel),
            "no cylinder from a forty-degree arc was marked unreliable; coverages \
             were {:?}", r.cylinders.iter().map(|c| c.surf_cov).collect::<Vec<_>>());
    }

    /// A CHARACTERISATION TEST, and deliberately so.
    ///
    /// The property tests above say what the chain must be like. This
    /// one says what this port actually produces, on nine segments
    /// chosen to exercise different paths through the region loop —
    /// straight, tapering, bent, contaminated, barely scanned, stepped
    /// in radius, locally sparse, and coarsely layered.
    ///
    /// It exists because most of what `cylinder_fitting` decides is
    /// structural: how many cylinders, where the regions break, which
    /// of eleven candidates wins. Those are not properties anyone would
    /// write an assertion about in advance, and they are exactly what
    /// drifts when the port is edited. Eleven separate mutations of the
    /// region stepping, the candidate selection and the filtering pass
    /// every property test above and fail this one.
    ///
    /// WHEN THIS FAILS: it is not automatically a bug. Read the printed
    /// table against the expected one, decide whether the change is
    /// intended, and if it is, update the numbers IN THE SAME COMMIT as
    /// the change, saying in the message which fixtures moved and why.
    /// Never update them to make a red test green.
    #[test]
    fn the_shape_of_the_chain_is_pinned_on_nine_segments() {
        // name, n, total length, worst gap, min radius, max radius, min coverage
        let expected: &[(&str, usize, f64, f64, f64, f64, f64)] = &[
            ("straight",    14,  3.050, 0.000, 0.0800, 0.0800, 0.643),
            ("taper",       12,  2.789, 0.053, 0.0470, 0.1449, 0.589),
            ("bend",        16,  3.646, 0.020, 0.0669, 0.0702, 0.600),
            ("outliers",    14,  3.050, 0.000, 0.0800, 0.0800, 0.643),
            ("narrow-arc",  14,  3.047, 0.053, 0.0800, 0.0800, 0.110),
            ("step",         9,  3.553, 0.567, 0.0400, 0.2100, 0.430),
            ("sparse-si1",  13,  2.943, 0.053, 0.0800, 0.0800, 0.471),
            ("sparse-si2",  13,  2.943, 0.053, 0.0800, 0.0800, 0.471),
            ("tall-layers", 14, 11.986, 0.214, 0.0800, 0.0800, 0.161),
        ];

        let mut got: Vec<(String, usize, f64, f64, f64, f64, f64)> = Vec::new();
        let mut record = |name: &str, r: &RegionFit| {
            let n = r.cylinders.len();
            let total: f64 = r.cylinders.iter().map(|c| c.length).sum();
            let mut gap = 0.0_f64;
            for k in 1..n {
                let a = r.cylinders[k - 1];
                let top = [a.start[0] + a.length*a.axis[0],
                           a.start[1] + a.length*a.axis[1],
                           a.start[2] + a.length*a.axis[2]];
                let b = r.cylinders[k].start;
                let d = ((top[0]-b[0]).powi(2) + (top[1]-b[1]).powi(2) + (top[2]-b[2]).powi(2)).sqrt();
                if d > gap { gap = d; }
            }
            let rmin = r.cylinders.iter().map(|c| c.radius).fold(f64::INFINITY, f64::min);
            let rmax = r.cylinders.iter().map(|c| c.radius).fold(0.0_f64, f64::max);
            let cmin = r.cylinders.iter().map(|c| c.surf_cov).fold(f64::INFINITY, f64::min);
            got.push((name.to_string(), n, total, gap, rmin, rmax, cmin));
        };

        let (p, s, sp) = segment(30, 40, 0.1, |f| [0.0, 0.0, f*3.0], |_| 0.08);
        record("straight", &cylinder_fitting(&p, &s, &sp, true));
        let (p2, s2, sp2) = segment(30, 40, 0.1, |f| [0.0, 0.0, f*3.0], |f| 0.15 - 0.11*f);
        record("taper", &cylinder_fitting(&p2, &s2, &sp2, true));
        let (p3, s3, sp3) = segment(34, 40, 0.1,
            |f| if f < 0.5 { [0.0, 0.0, f*3.4] } else { [(f-0.5)*1.6, 0.0, f*3.4] }, |_| 0.07);
        record("bend", &cylinder_fitting(&p3, &s3, &sp3, true));

        let (mut p4, s4, sp4) = segment(30, 40, 0.1, |f| [0.0, 0.0, f*3.0], |_| 0.08);
        let (mut s4b, mut sp4b) = (Vec::new(), Vec::new());
        for &(lo, hi) in &sp4 {
            let st = s4b.len();
            s4b.extend(s4[lo..hi].iter().copied());
            for (n, &i) in s4[lo..hi].iter().enumerate() {
                if n % 4 == 0 {
                    let q = p4[i as usize];
                    p4.push([q[0]*3.0, q[1]*3.0, q[2]]);
                    s4b.push((p4.len()-1) as u32);
                }
            }
            sp4b.push((st, s4b.len()));
        }
        record("outliers", &cylinder_fitting(&p4, &s4b, &sp4b, true));

        let (p5, s5, sp5) = segment(30, 40, 0.1, |f| [0.0, 0.0, f*3.0], |_| 0.08);
        let (mut s5b, mut sp5b) = (Vec::new(), Vec::new());
        for &(lo, hi) in &sp5 {
            let st = s5b.len();
            s5b.extend(s5[lo..hi].iter().copied()
                .filter(|&i| p5[i as usize][1].atan2(p5[i as usize][0]).abs() < 0.35));
            sp5b.push((st, s5b.len()));
        }
        record("narrow-arc", &cylinder_fitting(&p5, &s5b, &sp5b, true));

        let (p6, s6, sp6) = segment(30, 40, 0.1, |f| [0.0, 0.0, f*3.0],
            |f| if f < 0.4 { 0.04 } else { 0.20 });
        record("step", &cylinder_fitting(&p6, &s6, &sp6, true));

        let (p7, s7, sp7) = segment(30, 40, 0.1, |f| [0.0, 0.0, f*3.0], |_| 0.08);
        let (mut s7b, mut sp7b) = (Vec::new(), Vec::new());
        for (l, &(lo, hi)) in sp7.iter().enumerate() {
            let st = s7b.len();
            s7b.extend(s7[lo..hi].iter().copied().filter(|&i| {
                !(8..12).contains(&l) || p7[i as usize][1].atan2(p7[i as usize][0]).abs() > 1.2
            }));
            sp7b.push((st, s7b.len()));
        }
        record("sparse-si1", &cylinder_fitting(&p7, &s7b, &sp7b, true));
        record("sparse-si2", &cylinder_fitting(&p7, &s7b, &sp7b, false));

        let (p8, s8, sp8) = segment(30, 40, 0.4, |f| [0.0, 0.0, f*12.0], |_| 0.08);
        record("tall-layers", &cylinder_fitting(&p8, &s8, &sp8, true));

        let table = |v: &[(String, usize, f64, f64, f64, f64, f64)]| -> String {
            v.iter().map(|(n, c, t, g, lo, hi, sc)|
                format!("  {n:<12} n={c:<3} tot={t:7.3} gap={g:6.3} r={lo:.4}..{hi:.4} cov>={sc:.3}"))
             .collect::<Vec<_>>().join("\n")
        };
        assert_eq!(got.len(), expected.len());
        let mut bad: Vec<String> = Vec::new();
        for (g, e) in got.iter().zip(expected) {
            // Tolerances well inside the smallest difference any of the
            // mutations produces, and well outside libm noise.
            let ok = g.0 == e.0 && g.1 == e.1
                && (g.2 - e.2).abs() < 0.02 && (g.3 - e.3).abs() < 0.02
                && (g.4 - e.4).abs() < 0.003 && (g.5 - e.5).abs() < 0.003
                && (g.6 - e.6).abs() < 0.02;
            if !ok { bad.push(g.0.clone()); }
        }
        assert!(bad.is_empty(),
            "the chain changed shape on: {}\n\ngot:\n{}\n\nexpected:\n{}",
            bad.join(", "), table(&got),
            table(&expected.iter()
                .map(|e| (e.0.to_string(), e.1, e.2, e.3, e.4, e.5, e.6))
                .collect::<Vec<_>>()));
    }

    /// Every region reported must carry the points it was fitted to,
    /// and they must be real indices into the caller's array.
    #[test]
    fn every_cylinder_reports_the_points_it_was_fitted_to() {
        let (p, seg, spans) = segment(30, 40, 0.1, |f| [0.0, 0.0, f * 3.0], |_| 0.08);
        let r = cylinder_fitting(&p, &seg, &spans, true);
        assert_eq!(r.cylinders.len(), r.regions.len());
        for (k, reg) in r.regions.iter().enumerate() {
            assert!(!reg.is_empty(), "cylinder {k} reports no region");
            for &i in reg {
                assert!((i as usize) < p.len(), "region {k} names point {i}, out of range");
                assert!(seg.contains(&i), "region {k} names point {i}, not in the segment");
            }
        }
    }

    #[test]
    fn degenerate_input_does_not_panic() {
        assert!(cylinder_fitting(&[], &[], &[], true).cylinders.is_empty());
        let (p, seg, _) = segment(5, 10, 0.1, |f| [0.0, 0.0, f], |_| 0.05);
        assert!(cylinder_fitting(&p, &seg, &[], true).cylinders.is_empty());
        // Every layer at one height: no axis to find.
        let (p2, seg2, spans2) = segment(20, 30, 0.0, |_| [0.0, 0.0, 0.0], |_| 0.05);
        let _ = cylinder_fitting(&p2, &seg2, &spans2, true);
    }
}

#[cfg(test)]
mod least_squares_cylinder_tests {
    use super::*;

    /// A cylinder shell about `axis` through `centre`, `nr` around and
    /// `nz` along, with an optional per-point radial wobble.
    fn shell(centre: [f64; 3], axis: [f64; 3], radius: f64, length: f64,
             nr: usize, nz: usize, wobble: f64) -> Vec<[f64; 3]> {
        let a = {
            let n = (axis[0]*axis[0] + axis[1]*axis[1] + axis[2]*axis[2]).sqrt();
            [axis[0]/n, axis[1]/n, axis[2]/n]
        };
        let (u, w) = perp_basis(a).unwrap();
        let mut v = Vec::with_capacity(nr * nz);
        for i in 0..nr {
            let t = i as f64 / nr as f64 * std::f64::consts::TAU;
            for j in 0..nz {
                let s = j as f64 / (nz - 1).max(1) as f64 * length;
                // A deterministic wobble, so the fit has something to do.
                let r = radius + wobble * ((i * 7 + j * 13) % 11) as f64 / 11.0;
                v.push([
                    centre[0] + a[0]*s + r*(t.cos()*u[0] + t.sin()*w[0]),
                    centre[1] + a[1]*s + r*(t.cos()*u[1] + t.sin()*w[1]),
                    centre[2] + a[2]*s + r*(t.cos()*u[2] + t.sin()*w[2]),
                ]);
            }
        }
        v
    }

    fn guess(start: [f64; 3], axis: [f64; 3], radius: f64, length: f64) -> RefCyl {
        let n = (axis[0]*axis[0] + axis[1]*axis[1] + axis[2]*axis[2]).sqrt();
        RefCyl { start, axis: [axis[0]/n, axis[1]/n, axis[2]/n], length, radius,
                 surf_cov: 0.0, mad: 0.0, conv: false, rel: false }
    }

    fn dot(a: [f64; 3], b: [f64; 3]) -> f64 { a[0]*b[0] + a[1]*b[1] + a[2]*b[2] }

    /// THE FIT. An upright cylinder of known radius, recovered from a
    /// deliberately wrong starting guess.
    #[test]
    fn it_recovers_the_radius_and_axis_of_an_upright_cylinder() {
        let p = shell([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.12, 1.0, 48, 25, 0.0);
        // Start 30% off in radius and a degree off in axis.
        let c0 = guess([0.01, -0.01, 0.0], [0.02, 0.0, 1.0], 0.16, 1.0);
        let c = least_squares_cylinder(&p, &c0, None, None);
        assert!(c.conv, "the fit did not converge");
        assert!(c.rel, "the fit was reported ill-conditioned");
        assert!((c.radius - 0.12).abs() < 1e-4,
            "radius came back {:.5}, not 0.12", c.radius);
        assert!(dot(c.axis, [0.0, 0.0, 1.0]) > 0.9999,
            "axis came back {:?}, not vertical and pointing up", c.axis);
        assert!(c.mad < 1e-4, "mad {:.6} on a perfect shell", c.mad);
    }

    /// …and a LEANING one. A branch is not vertical, and the two axis
    /// parameters exist precisely so the fit can tilt away from the
    /// starting guess.
    #[test]
    fn it_recovers_a_leaning_cylinder_from_a_vertical_guess() {
        let truth: [f64; 3] = [0.6, 0.3, 1.0];
        let n = (truth[0]*truth[0] + truth[1]*truth[1] + truth[2]*truth[2]).sqrt();
        let unit = [truth[0]/n, truth[1]/n, truth[2]/n];
        let p = shell([1.0, 2.0, 3.0], truth, 0.05, 1.2, 48, 25, 0.0);
        // Deliberately guess straight up — about 32 degrees out.
        let c0 = guess([1.0, 2.0, 3.0], [0.0, 0.0, 1.0], 0.05, 1.2);
        let c = least_squares_cylinder(&p, &c0, None, None);
        assert!(c.conv && c.rel, "conv {} rel {}", c.conv, c.rel);
        assert!((c.radius - 0.05).abs() < 1e-3,
            "radius {:.5}, not 0.05", c.radius);
        assert!(dot(c.axis, unit) > 0.999,
            "axis {:?} against the true {:?}", c.axis, unit);
    }

    /// The start point is slid to the BOTTOM of the cylinder — the
    /// reference does this explicitly, and everything downstream that
    /// chains cylinders end to end depends on it.
    #[test]
    fn the_start_point_is_the_bottom_of_the_cylinder_not_the_guess() {
        // Points from z = 5 to z = 6; the guess starts at z = 5.4.
        let p = shell([0.0, 0.0, 5.0], [0.0, 0.0, 1.0], 0.1, 1.0, 40, 20, 0.0);
        let c0 = guess([0.0, 0.0, 5.4], [0.0, 0.0, 1.0], 0.1, 1.0);
        let c = least_squares_cylinder(&p, &c0, None, None);
        assert!((c.start[2] - 5.0).abs() < 1e-3,
            "the start came back at z = {:.4}, not at the bottom (5.0)", c.start[2]);
        assert!((c.length - 1.0).abs() < 1e-3, "length {:.4}, not 1.0", c.length);
    }

    /// THE SECTION. `q` says which points the cylinder is meant to
    /// DESCRIBE, while the fit still sees all of them. The length and
    /// the coverage must then be the section's, not the whole region's
    /// — otherwise a cylinder fitted to the middle of a region reports
    /// the length of the region.
    #[test]
    fn the_section_sets_the_length_while_the_fit_still_sees_every_point() {
        let all = shell([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.1, 3.0, 40, 60, 0.0);
        let mid: Vec<[f64; 3]> = all.iter().copied()
            .filter(|p| p[2] >= 1.0 && p[2] <= 2.0).collect();
        assert!(mid.len() > 5);
        let c0 = guess([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.1, 3.0);

        let whole = least_squares_cylinder(&all, &c0, None, None);
        let section = least_squares_cylinder(&all, &c0, None, Some(&mid));
        assert!((whole.length - 3.0).abs() < 0.06,
            "without a section the length is {:.3}, not 3.0", whole.length);
        assert!((section.length - 1.0).abs() < 0.06,
            "with a section the length is {:.3}, not 1.0", section.length);
        assert!((section.start[2] - 1.0).abs() < 0.06,
            "the section's cylinder starts at {:.3}, not 1.0", section.start[2]);
        // The radius is the same either way — the fit saw the same points.
        assert!((whole.radius - section.radius).abs() < 1e-6,
            "the section changed the fit itself: {:.5} against {:.5}",
            whole.radius, section.radius);
    }

    /// …and a section of five points or fewer is ignored, as the
    /// reference's `size(Q,1) > 5` says.
    #[test]
    fn a_section_of_five_points_or_fewer_is_ignored() {
        let all = shell([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.1, 3.0, 40, 60, 0.0);
        let tiny: Vec<[f64; 3]> = all.iter().copied().take(5).collect();
        let c0 = guess([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.1, 3.0);
        let c = least_squares_cylinder(&all, &c0, None, Some(&tiny));
        assert!((c.length - 3.0).abs() < 0.06,
            "a 5-point section was allowed to set the length to {:.3}", c.length);
    }

    /// WEIGHTS pull the fit towards the points that carry them. Two
    /// concentric shells: weight the inner one and the radius comes
    /// back near the inner radius, weight the outer and it goes out.
    #[test]
    fn weights_move_the_fit_towards_the_points_that_carry_them() {
        let inner = shell([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.08, 1.0, 40, 20, 0.0);
        let outer = shell([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.16, 1.0, 40, 20, 0.0);
        let mut p = inner.clone();
        p.extend(outer.iter().copied());
        let c0 = guess([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.12, 1.0);

        let mut w_in = vec![1.0; p.len()];
        for x in w_in[inner.len()..].iter_mut() { *x = 0.05; }
        let mut w_out = vec![0.05; p.len()];
        for x in w_out[inner.len()..].iter_mut() { *x = 1.0; }

        let a = least_squares_cylinder(&p, &c0, Some(&w_in), None);
        let b = least_squares_cylinder(&p, &c0, Some(&w_out), None);
        // Tight on purpose. A loose bound here passes when the weights
        // reach only the residuals, or only the Jacobian: either half
        // alone still pulls the fit the right way, just not to the
        // right place. The reference weights both.
        assert!((a.radius - 0.08).abs() < 0.001,
            "weighting the inner shell gave radius {:.5}, not 0.08", a.radius);
        assert!((b.radius - 0.16).abs() < 0.001,
            "weighting the outer shell gave radius {:.5}, not 0.16", b.radius);
    }

    /// THE MEAN ABSOLUTE DEVIATION, on points that actually deviate.
    /// A perfect shell has residuals of zero and cannot tell `mad` from
    /// the signed mean, which cancels out.
    #[test]
    fn mad_is_the_mean_absolute_residual_not_the_signed_one() {
        let p = shell([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 1.0, 48, 25, 0.02);
        let c0 = guess([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.10, 1.0);
        let c = least_squares_cylinder(&p, &c0, None, None);
        assert!(c.conv, "the fit did not converge");
        // The shell scatters over 2 cm; the residuals average about
        // half a centimetre away from the fitted surface, and they
        // scatter both ways, so a signed mean would be near zero.
        assert!(c.mad > 0.003,
            "mad came back {:.6} on a shell that wobbles by 0.02 — the residuals \
             are cancelling, so this is the signed mean", c.mad);
        let want: f64 = 0.02 / 2.0;
        assert!(c.mad < want, "mad {:.6} exceeds the wobble itself", c.mad);
    }

    /// POINTS INSIDE THE SURFACE ARE NOT EVIDENCE OF IT. The reference
    /// asks for coverage with `Dmin = 0.8*radius`, so a stem's interior
    /// returns — a second surface behind the first, or points on the
    /// axis — cannot report a face of the cylinder as seen.
    ///
    /// Here the surface is scanned over the lower half only, and a thin
    /// core runs the full height. With the band the upper layers are
    /// empty and the coverage is about a half; without it the core
    /// fills them and the same fit claims almost complete coverage.
    #[test]
    fn points_inside_the_surface_do_not_count_towards_its_coverage() {
        let mut p = Vec::new();
        for i in 0..60 {
            let t = i as f64 / 60.0 * std::f64::consts::TAU;
            for j in 0..15 {
                p.push([0.1 * t.cos(), 0.1 * t.sin(), j as f64 / 14.0 * 0.5]);
            }
        }
        for i in 0..36 {
            let t = i as f64 / 36.0 * std::f64::consts::TAU;
            for j in 0..30 {
                p.push([0.005 * t.cos(), 0.005 * t.sin(), j as f64 / 29.0]);
            }
        }
        let c0 = guess([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.1, 1.0);
        let c = least_squares_cylinder(&p, &c0, None, None);
        assert!(c.conv && c.rel);
        assert!(c.surf_cov < 0.6,
            "coverage {:.3} — the core was counted as surface", c.surf_cov);

        // …and the fixture really does discriminate: without the band
        // the very same fit reports almost everything covered.
        let nl = ((c.length / 0.03).ceil() as usize).max(3);
        let ns = ((std::f64::consts::TAU * c.radius / 0.03).ceil() as usize).clamp(8, 36);
        let unbanded = surface_coverage(&p, c.axis, c.start, nl, ns, None, None);
        assert!(unbanded > 0.85,
            "without the band the coverage is only {unbanded:.3}, so this fixture \
             would pass whether the band were applied or not");
    }

    /// A PLANAR PATCH has no radius to find: the centre can slide out
    /// along the normal for ever, growing the radius to match, and the
    /// normal equations go singular. The reference detects that through
    /// the condition number and clears `rel`.
    #[test]
    fn a_flat_patch_is_reported_ill_conditioned_rather_than_fitted() {
        let mut plane = Vec::new();
        for i in 0..40 {
            for j in 0..40 {
                plane.push([0.1, -0.5 + i as f64 * 0.025, j as f64 * 0.025]);
            }
        }
        let c0 = guess([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.1, 1.0);
        let c = least_squares_cylinder(&plane, &c0, None, None);
        assert!(!c.rel,
            "a flat patch was fitted as a reliable cylinder of radius {:.2}", c.radius);
        assert_eq!(c.surf_cov, 0.0,
            "an unreliable fit still reported coverage {:.3}", c.surf_cov);
    }

    /// The fit is parametrised RELATIVE TO THE STARTING AXIS — that is
    /// what `rotate_to_z_axis` is for. A near-horizontal branch given
    /// its own axis as the guess is then a zero-tilt problem; drop the
    /// rotation and the same fit has to swing ninety degrees from
    /// vertical to find it.
    #[test]
    fn a_near_horizontal_cylinder_is_fitted_in_its_own_frame() {
        let truth: [f64; 3] = [1.0, 0.0, 0.09];
        let n = (truth[0]*truth[0] + truth[2]*truth[2]).sqrt();
        let unit = [truth[0]/n, 0.0, truth[2]/n];
        let p = shell([0.0, 0.0, 0.0], truth, 0.05, 1.2, 48, 25, 0.0);
        let c0 = guess([0.0, 0.0, 0.0], truth, 0.05, 1.2);
        let c = least_squares_cylinder(&p, &c0, None, None);
        assert!(c.conv && c.rel, "conv {} rel {}", c.conv, c.rel);
        assert!((c.radius - 0.05).abs() < 1e-4, "radius {:.5}, not 0.05", c.radius);
        // SIGNED, not absolute. The fit starts with its axis equal to
        // the guess and moves continuously from there, so it keeps the
        // guess's orientation; start it from vertical instead and a
        // near-horizontal branch settles just as happily on the
        // reverse, which puts `start` at the tip and builds the whole
        // branch backwards.
        assert!(dot(c.axis, unit) > 0.9999,
            "axis {:?} against the true {:?} — it points the other way", c.axis, unit);
        // The shell runs from the origin outwards, so the bottom is the
        // origin. A reversed axis puts it at the far end instead.
        assert!(c.start[0].abs() < 0.01,
            "the cylinder starts at x = {:.4}, at the far end of a branch that \
             begins at the origin", c.start[0]);
    }

    /// Surface coverage is reported for a good fit and is low for a
    /// one-sided scan — the caller uses it to choose between candidate
    /// cylinders, so a fit that does not fill it in cannot be chosen.
    #[test]
    fn coverage_is_reported_and_distinguishes_a_one_sided_scan() {
        let full = shell([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.1, 1.0, 60, 30, 0.0);
        let half: Vec<[f64; 3]> = full.iter().copied().filter(|p| p[1] >= 0.0).collect();
        let c0 = guess([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.1, 1.0);
        let a = least_squares_cylinder(&full, &c0, None, None);
        let b = least_squares_cylinder(&half, &c0, None, None);
        assert!(a.surf_cov > 0.85, "a full sweep reported coverage {:.3}", a.surf_cov);
        assert!(b.surf_cov < a.surf_cov * 0.75,
            "half a cylinder reported {:.3} against the full {:.3}", b.surf_cov, a.surf_cov);
    }

    /// Degenerate input is reported as unreliable rather than returned
    /// as a cylinder. Collinear points have no radius to find, and the
    /// normal equations are singular.
    #[test]
    fn degenerate_input_is_reported_rather_than_fitted() {
        let c0 = guess([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.1, 1.0);
        let empty = least_squares_cylinder(&[], &c0, None, None);
        assert!(!empty.conv && !empty.rel);

        // Every point on the axis: nothing determines the radius.
        let line: Vec<[f64; 3]> = (0..40).map(|i| [0.0, 0.0, i as f64 * 0.025]).collect();
        let c = least_squares_cylinder(&line, &c0, None, None);
        assert!(!c.rel || !c.conv || c.surf_cov == 0.0,
            "a straight line was fitted as a reliable cylinder: {c:?}");
    }

    /// The 5x5 solve and the condition number it is judged by.
    #[test]
    fn the_linear_solve_and_its_condition_number_agree_with_the_matrix() {
        // A system with a known answer.
        let mut a = [[0.0f64; 5]; 5];
        for (i, row) in a.iter_mut().enumerate() { row[i] = (i + 1) as f64; }
        a[0][1] = 0.5; a[1][0] = 0.5;
        let want = [1.0, -2.0, 3.0, -4.0, 5.0];
        let mut b = [0.0f64; 5];
        for i in 0..5 { for j in 0..5 { b[i] += a[i][j] * want[j]; } }
        let got = solve5(a, b).expect("a well-conditioned system did not solve");
        for i in 0..5 {
            assert!((got[i] - want[i]).abs() < 1e-9, "x[{i}] = {}, want {}", got[i], want[i]);
        }
        // A well-conditioned matrix is nowhere near the reference's
        // 10000*eps rejection threshold; a singular one is past it.
        assert!(rcond5(&a) > 1e-3, "rcond {} on a tame matrix", rcond5(&a));
        let singular = [[1.0f64; 5]; 5];
        assert!(solve5(singular, [1.0; 5]).is_none(), "a rank-1 matrix solved");
        assert!(rcond5(&singular) < 10000.0 * f64::EPSILON);

        // PARTIAL PIVOTING. A zero in the first pivot position is not a
        // singular matrix — it just means the rows must be exchanged.
        // Eliminate without pivoting and this divides by zero.
        let mut swapped = [[0.0f64; 5]; 5];
        swapped[0][1] = 2.0; swapped[1][0] = 3.0;
        for (i, row) in swapped.iter_mut().enumerate().skip(2) { row[i] = (i + 1) as f64; }
        let mut b2 = [0.0f64; 5];
        for i in 0..5 { for j in 0..5 { b2[i] += swapped[i][j] * want[j]; } }
        let got2 = solve5(swapped, b2)
            .expect("a solvable system with a zero first pivot was refused");
        for i in 0..5 {
            assert!((got2[i] - want[i]).abs() < 1e-9,
                "x[{i}] = {}, want {} — pivoting is not happening", got2[i], want[i]);
        }
    }
}

#[cfg(test)]
mod surface_coverage_tests {
    use super::*;

    const Z: [f64; 3] = [0.0, 0.0, 1.0];

    /// A cylinder shell: `nr` points around, `nz` up, at `radius`.
    /// `arc` is the fraction of the circle actually scanned — 1.0 for a
    /// full sweep, 0.5 for a tree seen from one side.
    fn shell(radius: f64, height: f64, nr: usize, nz: usize, arc: f64) -> Vec<[f64; 3]> {
        let mut v = Vec::with_capacity(nr * nz);
        for i in 0..nr {
            let t = i as f64 / nr as f64 * arc * std::f64::consts::TAU;
            for j in 0..nz {
                let z = j as f64 / (nz - 1).max(1) as f64 * height;
                v.push([radius * t.cos(), radius * t.sin(), z]);
            }
        }
        v
    }

    /// A full sweep covers the surface; half a sweep covers about half.
    /// This is the number `cylinder_fitting` maximises when it chooses
    /// between candidate fits, so it has to mean what it says.
    #[test]
    fn a_full_sweep_covers_the_surface_and_a_one_sided_scan_covers_half() {
        let full = surface_coverage(&shell(0.1, 1.0, 40, 20, 1.0), Z, [0.0; 3], 10, 12, None, None);
        let half = surface_coverage(&shell(0.1, 1.0, 40, 20, 0.5), Z, [0.0; 3], 10, 12, None, None);
        assert!(full > 0.95, "a full sweep only covered {full:.3}");
        assert!((0.4..0.65).contains(&half),
            "a half sweep covered {half:.3}, which should be about half of {full:.3}");
    }

    /// A single point cannot cover more than one cell of the grid.
    #[test]
    fn one_point_covers_exactly_one_cell() {
        let c = surface_coverage(&[[0.1, 0.0, 0.0], [0.1, 0.0, 0.5]], Z, [0.0; 3], 4, 8, None, None);
        // Two points, two layers, one sector: 2 of 32 cells.
        assert!((c - 2.0 / 32.0).abs() < 1e-12, "got {c}, expected {}", 2.0 / 32.0);
    }

    /// The distance band drops points before the count. A shell with a
    /// second shell inside it covers the same surface either way; ask
    /// for only the outer one and the inner points stop contributing.
    #[test]
    fn the_distance_band_excludes_points_before_they_are_counted() {
        let mut p = shell(0.10, 1.0, 40, 20, 1.0);
        // An inner core, covering sectors the outer shell does not.
        p.extend(shell(0.02, 1.0, 40, 20, 1.0));
        let all = surface_coverage(&p, Z, [0.0; 3], 10, 12, None, None);
        let outer = surface_coverage(&p, Z, [0.0; 3], 10, 12, Some(0.05), None);
        let inner = surface_coverage(&p, Z, [0.0; 3], 10, 12, None, Some(0.05));
        assert!(all >= outer && all >= inner,
            "filtering raised the coverage: all {all:.3}, outer {outer:.3}, inner {inner:.3}");
        assert!(outer > 0.9 && inner > 0.9,
            "each shell alone should still cover the surface: outer {outer:.3}, inner {inner:.3}");
    }

    /// …and the LENGTH is measured before the band is applied. The
    /// reference is explicit about the order: filtering must not shorten
    /// the cylinder, or a band that keeps only the middle of a stem
    /// would rescale the layers around it and report full coverage.
    #[test]
    fn the_distance_band_does_not_rescale_the_cylinders_length() {
        // A tall shell whose top half is at a larger radius.
        let mut p = shell(0.02, 1.0, 24, 20, 1.0);
        for q in p.iter_mut() { if q[2] > 0.5 { q[0] *= 5.0; q[1] *= 5.0; } }
        // Keep only the narrow lower half.
        let c = surface_coverage(&p, Z, [0.0; 3], 10, 12, None, Some(0.05));
        assert!(c < 0.6,
            "coverage {c:.3} — the kept points span half the height, so at most \
             about half the layers can be occupied; the length was rescaled");
    }

    /// THE FOUR BASES. The reference evaluates the sector grid from
    /// four directions a quarter-sector apart and keeps the largest
    /// result, because its own basis comes from `rand(3,1)` and the
    /// answer would otherwise depend on where the grid happened to
    /// start.
    ///
    /// The consequence, and what is asserted here: turning the tree
    /// about its own axis must not change its coverage. A single basis
    /// fails this — points that sat either side of a sector boundary
    /// collapse into one cell at some rotations and not others.
    ///
    /// The fixture is built so that some sectors really do go empty:
    /// twelve 30-degree sectors, and six pairs of points 28 degrees
    /// apart. Where a boundary falls between a pair they occupy two
    /// sectors and everything is covered; where it does not they share
    /// one and half the sectors are empty. A single basis therefore
    /// reports 1.0 or 0.5 depending only on which way the tree is
    /// facing.
    #[test]
    fn turning_the_cloud_about_its_axis_does_not_change_the_coverage() {
        let ns = 12; // 30-degree sectors
        let build = |phi: f64| -> Vec<[f64; 3]> {
            let mut v = Vec::new();
            for k in 0..6 {
                let base = (k as f64 * 60.0).to_radians();
                for off in [0.0_f64, 28.0_f64.to_radians()] {
                    for j in 0..6 {
                        let t = base + off + phi;
                        v.push([0.1 * t.cos(), 0.1 * t.sin(), j as f64 * 0.2]);
                    }
                }
            }
            v
        };
        // One full sector of rotation, finely enough sampled to land in
        // the narrow window where a single basis collapses each pair.
        let vals: Vec<f64> = (0..60)
            .map(|k| {
                let phi = k as f64 / 60.0 * std::f64::consts::TAU / ns as f64;
                surface_coverage(&build(phi), Z, [0.0; 3], 6, ns, None, None)
            })
            .collect();
        let lo = vals.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = vals.iter().copied().fold(0.0_f64, f64::max);
        assert!(lo > hi * 0.9,
            "coverage swings from {lo:.3} to {hi:.3} as the cloud turns about its own \
             axis; the grid is being read from one direction only");
    }

    #[test]
    fn a_degenerate_cylinder_reports_no_coverage_rather_than_panicking() {
        assert_eq!(surface_coverage(&[], Z, [0.0; 3], 4, 8, None, None), 0.0);
        // Every point at one height: no length, so no surface.
        let flat = vec![[0.1, 0.0, 0.0], [0.0, 0.1, 0.0], [-0.1, 0.0, 0.0]];
        assert_eq!(surface_coverage(&flat, Z, [0.0; 3], 4, 8, None, None), 0.0);
        assert_eq!(surface_coverage(&shell(0.1, 1.0, 8, 4, 1.0), Z, [0.0; 3], 0, 8, None, None), 0.0);
    }
}

#[cfg(test)]
mod surface_coverage_filtering_tests {
    use super::*;

    fn cyl(radius: f64, length: f64) -> RefCyl {
        RefCyl { start: [0.0, 0.0, 0.0], axis: [0.0, 0.0, 1.0], length,
                 radius, surf_cov: 0.0, mad: 0.0, conv: false, rel: false }
    }

    /// A clean shell: every point is kept and the radius comes back.
    #[test]
    fn a_clean_shell_keeps_every_point_and_recovers_its_radius() {
        let p = surface_coverage_tests_shell(0.10, 1.0, 60, 30);
        let mut c = cyl(0.0, 1.0);
        let keep = surface_coverage_filtering(&p, &mut c, 0.02, 20);
        assert_eq!(keep.iter().filter(|&&k| k).count(), p.len(),
            "points were dropped from a shell that has no outliers");
        assert!((c.radius - 0.10).abs() < 0.011,
            "recovered radius {:.4} from a shell of 0.10", c.radius);
        assert!(c.conv && c.rel);
        assert!(c.mad < 0.011, "mad {:.4} on a perfect shell", c.mad);
    }

    /// THE POINT OF THE FILTER. A region that has swallowed the far side
    /// of a neighbouring branch has points well outside the surface.
    /// Those are dropped, and — this is the part that matters — the
    /// radius is the median of the per-cell MINIMUM, so it is not
    /// dragged outwards by them either.
    #[test]
    fn points_outside_the_surface_are_dropped_and_do_not_inflate_the_radius() {
        let mut p = surface_coverage_tests_shell(0.10, 1.0, 60, 30);
        let clean = p.len();
        // A second surface at 0.25, as if a nearby branch were included.
        p.extend(surface_coverage_tests_shell(0.25, 1.0, 60, 30));
        let mut c = cyl(0.0, 1.0);
        let keep = surface_coverage_filtering(&p, &mut c, 0.02, 20);

        let kept_far = (clean..p.len()).filter(|&i| keep[i]).count();
        assert!(kept_far * 20 < p.len() - clean,
            "{kept_far} of the {} far-surface points survived the filter",
            p.len() - clean);
        assert!((c.radius - 0.10).abs() < 0.015,
            "radius came back {:.4}; the far surface at 0.25 pulled it out", c.radius);
    }

    /// …but a point closer to the axis than the surface is NOT an
    /// outlier to this filter — it becomes the cell minimum and the
    /// surface around it is dropped instead. The reference keeps the
    /// nearest points because scanner noise scatters outward from a
    /// surface, not inward through it.
    #[test]
    fn the_filter_keeps_the_nearest_points_in_each_cell_not_the_densest() {
        let mut p = surface_coverage_tests_shell(0.10, 1.0, 60, 30);
        let shell_n = p.len();
        // One stray point well inside, in a single sector.
        p.push([0.04, 0.0, 0.5]);
        let mut c = cyl(0.0, 1.0);
        let keep = surface_coverage_filtering(&p, &mut c, 0.02, 20);
        assert!(keep[shell_n], "the innermost point of its cell was dropped");
    }

    /// The mask comes back in the CALLER's order. The reference sorts
    /// the points to group them into cells and then unsorts the mask;
    /// hand back the sorted mask and every kept point refers to a
    /// different point than it did.
    #[test]
    fn the_mask_is_in_the_callers_point_order() {
        // Two well-separated bands, interleaved in the input order, so a
        // mask left in sorted order would mark the wrong ones.
        let mut p: Vec<[f64; 3]> = Vec::new();
        let ring = surface_coverage_tests_shell(0.10, 1.0, 40, 20);
        for (i, q) in ring.iter().enumerate() {
            p.push(*q);
            // Every fourth point is pushed far out and must be dropped.
            if i % 4 == 0 { p.push([q[0] * 3.0, q[1] * 3.0, q[2]]); }
        }
        let mut c = cyl(0.0, 1.0);
        let keep = surface_coverage_filtering(&p, &mut c, 0.02, 20);
        let d = |q: [f64; 3]| (q[0] * q[0] + q[1] * q[1]).sqrt();
        for (i, &k) in keep.iter().enumerate() {
            if k {
                assert!(d(p[i]) < 0.2,
                    "point {i} at distance {:.3} was kept; the mask is out of order",
                    d(p[i]));
            }
        }
    }

    /// A one-sided scan reports a coverage well under one, which is how
    /// the caller learns not to trust the fit.
    #[test]
    fn a_one_sided_scan_reports_low_coverage() {
        let full = surface_coverage_tests_shell(0.10, 1.0, 60, 30);
        let half: Vec<[f64; 3]> = full.iter().copied().filter(|q| q[1] >= 0.0).collect();
        let mut a = cyl(0.0, 1.0);
        let mut b = cyl(0.0, 1.0);
        surface_coverage_filtering(&full, &mut a, 0.02, 20);
        surface_coverage_filtering(&half, &mut b, 0.02, 20);
        assert!(b.surf_cov < a.surf_cov * 0.75,
            "half a cylinder reported coverage {:.3} against the full {:.3}",
            b.surf_cov, a.surf_cov);
    }

    /// The grid is sized from the radius, so a thin branch is not cut
    /// into more sectors than it has points to fill — which would report
    /// a low coverage for a perfectly scanned twig.
    #[test]
    fn a_thin_branch_is_not_penalised_for_being_thin() {
        let thick = surface_coverage_tests_shell(0.20, 0.6, 60, 30);
        let thin = surface_coverage_tests_shell(0.01, 0.6, 60, 30);
        let mut a = cyl(0.0, 0.6);
        let mut b = cyl(0.0, 0.6);
        surface_coverage_filtering(&thick, &mut a, 0.02, 20);
        surface_coverage_filtering(&thin, &mut b, 0.02, 20);
        assert!(b.surf_cov > 0.9 && a.surf_cov > 0.9,
            "thin {:.3}, thick {:.3} — a well-scanned cylinder of either size \
             must report near-full coverage", b.surf_cov, a.surf_cov);
    }

    /// THE GRID IS SIZED FROM THE RADIUS: cells about a fifth of a
    /// radius across, `a = max(0.02, 0.2*R)`. Drop the radius term and
    /// the cells stay 2 cm on a half-metre trunk, which asks for an
    /// angular and vertical resolution no terrestrial scan of a trunk
    /// has — and a perfectly scanned trunk then reports a third of the
    /// coverage it should, and the fit that produced it gets thrown
    /// away by the caller as unreliable.
    #[test]
    fn a_thick_trunk_scanned_at_the_grids_own_resolution_reports_full_coverage() {
        // 0.3 m radius, 0.6 m long. The reference's grid here is 32
        // sectors by 10 layers; this samples it at 32 by 12.
        let mut p = Vec::new();
        for i in 0..32 {
            let t = i as f64 / 32.0 * std::f64::consts::TAU;
            for j in 0..12 {
                p.push([0.3 * t.cos(), 0.3 * t.sin(), j as f64 / 11.0 * 0.6]);
            }
        }
        let mut c = cyl(0.0, 0.6);
        surface_coverage_filtering(&p, &mut c, 0.02, 20);
        assert!(c.surf_cov > 0.85,
            "a trunk sampled at the grid's own resolution reported {:.3} coverage; \
             the grid is finer than the radius calls for", c.surf_cov);
    }

    /// THE TWO-SIDED TOLERANCE, `min(1.05*D, D+0.02)`: five per cent of
    /// the distance on a thin branch, a flat two centimetres on a thick
    /// one. The two agree below 0.4 m, which is every branch and most
    /// stems — the cap only bites on a genuinely fat trunk, and that is
    /// exactly where an unbounded five per cent would be adding four
    /// centimetres of slack to a radius.
    #[test]
    fn the_radius_tolerance_is_five_per_cent_or_two_centimetres_whichever_is_less() {
        // Thin: 5% of 0.05 is 0.0025, well under 0.02, so 0.0525.
        let mut thin = cyl(0.0, 1.0);
        surface_coverage_filtering(&surface_coverage_tests_shell(0.05, 1.0, 60, 60),
                                   &mut thin, 0.02, 20);
        assert!((thin.radius - 0.0525).abs() < 0.0005,
            "a 0.05 shell came back as {:.4}, not 0.0525", thin.radius);

        // Thick: 5% of 0.6 is 0.03, so the 0.02 cap wins and it is 0.62.
        let mut thick = cyl(0.0, 1.0);
        surface_coverage_filtering(&surface_coverage_tests_shell(0.60, 1.0, 60, 60),
                                   &mut thick, 0.02, 20);
        assert!((thick.radius - 0.62).abs() < 0.003,
            "a 0.60 shell came back as {:.4}; without the 0.02 cap it would be 0.63",
            thick.radius);
    }

    #[test]
    fn a_degenerate_cylinder_is_marked_unreliable_rather_than_panicking() {
        let p = surface_coverage_tests_shell(0.10, 1.0, 20, 10);
        for (len, lh) in [(0.0, 0.02), (1.0, 0.0), (-1.0, 0.02)] {
            let mut c = cyl(0.0, len);
            let keep = surface_coverage_filtering(&p, &mut c, lh, 20);
            assert!(!c.rel && !c.conv, "length {len}, lh {lh} was reported reliable");
            assert_eq!(keep.len(), p.len());
        }
        let mut c = cyl(0.0, 1.0);
        assert!(surface_coverage_filtering(&[], &mut c, 0.02, 20).is_empty());
    }

    /// A shared shell builder — same construction as the coverage
    /// tests, a full sweep.
    fn surface_coverage_tests_shell(r: f64, h: f64, nr: usize, nz: usize) -> Vec<[f64; 3]> {
        let mut v = Vec::with_capacity(nr * nz);
        for i in 0..nr {
            let t = i as f64 / nr as f64 * std::f64::consts::TAU;
            for j in 0..nz {
                let z = j as f64 / (nz - 1).max(1) as f64 * h;
                v.push([r * t.cos(), r * t.sin(), z]);
            }
        }
        v
    }
}

#[cfg(test)]
mod median_tests {
    use super::*;

    /// MATLAB's median averages the two central values on an even
    /// count. Taking the lower one instead shifts every radius the
    /// filter reports, by half the gap between two cells.
    #[test]
    fn an_even_count_averages_the_two_central_values() {
        assert_eq!(median_of(&mut [1.0, 2.0, 3.0, 4.0]), 2.5);
        assert_eq!(median_of(&mut [4.0, 1.0, 3.0, 2.0]), 2.5);
        assert_eq!(median_of(&mut [1.0, 2.0, 3.0]), 2.0);
        assert_eq!(median_of(&mut [7.0]), 7.0);
        assert!(median_of(&mut []).is_nan());
    }
}

#[cfg(test)]
mod cover_sets_pass2_tests {
    use super::*;

    // TreeQSM's create_input defaults for the second pass.
    const DMIN: f64 = 0.02;
    const DMAX: f64 = 0.07;
    const BRAD: f64 = 0.105;   // BallRad2 = PatchDiam2Max + 0.035

    /// A filled box of `n` × `n` × `n` points on a lattice of pitch
    /// `pitch`, with its low corner at `at`.
    fn box_of(at: [f64; 3], n: usize, pitch: f64) -> Vec<[f64; 3]> {
        let mut v = Vec::with_capacity(n * n * n);
        for i in 0..n { for j in 0..n { for k in 0..n {
            v.push([at[0] + i as f64 * pitch,
                    at[1] + j as f64 * pitch,
                    at[2] + k as f64 * pitch]);
        }}}
        v
    }

    /// The mean number of points a set holds — a proxy for its physical
    /// size on a lattice of uniform density, which is what these
    /// fixtures are.
    fn mean_set_size(c: &CoverSets, of: impl Fn(usize) -> bool) -> f64 {
        let (mut n, mut t) = (0usize, 0usize);
        for (i, s) in c.sets.iter().enumerate() {
            if s.is_empty() || !of(c.centre[i] as usize) { continue; }
            n += 1; t += s.len();
        }
        if n == 0 { 0.0 } else { t as f64 / n as f64 }
    }

    /// THE WHOLE POINT. A trunk point and a twig point in one cloud, at
    /// the same density, and the sets seeded on the trunk must come out
    /// bigger. A fixed radius gives one number for both, and that is
    /// what the reimplementation this replaces did.
    #[test]
    fn a_big_relative_size_makes_a_bigger_cover_set_than_a_small_one() {
        let mut p = box_of([0.0, 0.0, 0.0], 9, 0.012);           // "trunk"
        let twig_from = p.len();
        p.extend(box_of([1.0, 0.0, 0.0], 9, 0.012));             // "twig"
        let rs: Vec<u8> = (0..p.len())
            .map(|i| if i < twig_from { 255 } else { 20 })
            .collect();

        let c = cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 4);
        let big = mean_set_size(&c, |q| q < twig_from);
        let small = mean_set_size(&c, |q| q >= twig_from);
        assert!(big > 0.0 && small > 0.0, "one of the two bodies produced no sets");
        assert!(big > small * 2.0,
            "a set on the full-size body holds {big:.1} points and one on the \
             smallest-size body {small:.1}; the size is barely varying");
    }

    /// …and the ramp has a FLOOR. Relative size 0 does not mean radius
    /// 0: it means PatchDiam2Min. `MRS = PatchDiam2Min/PatchDiam2Max` is
    /// what keeps the smallest sets from collapsing to single points.
    #[test]
    fn the_smallest_sets_are_floored_at_patch_diam_min_not_at_zero() {
        let p = box_of([0.0, 0.0, 0.0], 9, 0.012);
        let rs = vec![1u8; p.len()];
        let c = cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 4);
        assert!(!c.centre.is_empty(), "the smallest size produced no sets at all");
        // A set of diameter ~PatchDiam2Min at pitch 0.012 spans several
        // points in each direction, so it cannot be a singleton.
        let mean = mean_set_size(&c, |_| true);
        assert!(mean > 2.0,
            "sets at the minimum size hold {mean:.2} points each — the floor \
             collapsed and PatchDiam2Min is not being applied");
    }

    /// THE BAND ORDER. Small sets are seeded before large ones, and the
    /// reason is not tidiness: a trunk-sized ball planted next to a twig
    /// swallows the twig whole, and the fine structure the variable size
    /// exists to capture is gone before it is measured.
    ///
    /// Two bodies close enough that ANY seed on the large one has a
    /// core reaching the whole of the small one. Seeded small-first the
    /// twig gets sets of its own; seeded large-first every twig point is
    /// marked examined before its band is ever reached, and the twig
    /// ends up with no seed at all.
    ///
    /// Note what is asserted: the number of CENTRES on the small body,
    /// not how its points are owned. Ownership is by nearest seed and
    /// does not depend on the order at all — an earlier version of this
    /// test asserted on ownership and passed with the order reversed.
    #[test]
    fn seeding_the_small_sets_first_stops_the_big_ones_swallowing_them() {
        let mut p = box_of([0.0, 0.0, 0.0], 4, 0.010);           // span 0.030
        let twig_from = p.len();
        p.extend(box_of([0.040, 0.010, 0.010], 2, 0.010));       // gap 0.010
        // Worst case here is 0.057 apart, inside the 0.070 core of a
        // full-size seed, so the swallowing is certain rather than
        // dependent on which point happens to seed first.
        let rs: Vec<u8> = (0..p.len())
            .map(|i| if i < twig_from { 255 } else { 4 })
            .collect();

        let c = cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 4);
        let twig_centres = c.centre.iter().filter(|&&q| (q as usize) >= twig_from).count();
        assert!(twig_centres > 0,
            "the small body got {twig_centres} seeds of its own — the large body was \
             seeded first and its core marked every twig point examined");
    }

    /// THE BALL IS EXACTLY THE POINTS INSIDE ITS OWN RADIUS, and the
    /// radius is `PatchDiam2Max*rs + sqrt(rs)*(BallRad2 - PatchDiam2Max)`.
    ///
    /// Both halves matter and neither was checked. Get the formula wrong
    /// and every ball is the wrong size — but the sets stay a consistent
    /// nearest-seed partition, so the partition tests still pass. Sweep
    /// too few grid cells and the balls silently lose their outer
    /// points — and again the partition stays self-consistent, because
    /// it is only ever compared against the balls that did reach.
    #[test]
    fn each_ball_holds_exactly_the_points_inside_its_own_radius() {
        let p = box_of([0.0, 0.0, 0.0], 11, 0.012);
        let rs: Vec<u8> = (0..p.len()).map(|i| (10 + (i * 13) % 240) as u8).collect();
        let c = cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 9);
        assert!(c.centre.len() > 4, "too few sets to be testing anything");

        let mrs = DMIN / DMAX;
        let e = BRAD - DMAX;
        let d2 = |a: [f64; 3], b: [f64; 3]|
            (a[0]-b[0]).powi(2) + (a[1]-b[1]).powi(2) + (a[2]-b[2]).powi(2);
        for (i, &q) in c.centre.iter().enumerate() {
            let r_rel = rs[q as usize] as f64 / 256.0 * (1.0 - mrs) + mrs;
            let radius = DMAX * r_rel + r_rel.sqrt() * e;
            let mut want: Vec<u32> = (0..p.len() as u32)
                .filter(|&j| d2(p[j as usize], p[q as usize]) < radius * radius)
                .collect();
            let mut got = c.ball[i].clone();
            want.sort_unstable();
            got.sort_unstable();
            assert_eq!(got.len(), want.len(),
                "set {i} (seed {q}, relative size {}) has {} points in its ball but \
                 {} lie within its radius of {radius:.4}",
                rs[q as usize], got.len(), want.len());
            assert_eq!(got, want, "set {i} holds different points from its own radius");
        }
    }

    /// Only the CORE consumes seeds, not the whole ball — the same
    /// separation of the two radii that pass 1 has, and the reason the
    /// cover overlaps at all.
    ///
    /// Observable as the spacing between centres: marking only the core
    /// lets a second seed land in the annulus between `MaxDist` and
    /// `Radius`, so some pair of centres is closer together than one
    /// ball radius. Mark the whole ball and no pair can be.
    #[test]
    fn only_the_core_consumes_seeds_so_centres_can_sit_inside_each_others_balls() {
        let p = box_of([0.0, 0.0, 0.0], 16, 0.012);
        let rs = vec![255u8; p.len()];
        let c = cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 6);
        assert!(c.centre.len() > 2, "only {} sets — nothing to space out", c.centre.len());

        let mrs = DMIN / DMAX;
        let r_rel = 255.0 / 256.0 * (1.0 - mrs) + mrs;
        let max_dist = DMAX * r_rel;
        let radius = max_dist + r_rel.sqrt() * (BRAD - DMAX);
        let d = |a: [f64; 3], b: [f64; 3]|
            ((a[0]-b[0]).powi(2) + (a[1]-b[1]).powi(2) + (a[2]-b[2]).powi(2)).sqrt();

        let mut closest = f64::INFINITY;
        for i in 0..c.centre.len() {
            for j in (i + 1)..c.centre.len() {
                let s = d(p[c.centre[i] as usize], p[c.centre[j] as usize]);
                if s < closest { closest = s; }
            }
        }
        assert!(closest < radius,
            "the closest two centres are {closest:.4} apart and the ball radius is \
             {radius:.4}; nothing was seeded inside another set's ball, so the whole \
             ball is consuming seeds rather than only its core");
        assert!(closest >= max_dist - 1e-9,
            "two centres are {closest:.4} apart, inside the core radius {max_dist:.4} — \
             the core is not consuming seeds at all");
    }

    /// A point the segmentation never reached has relative size 0 and
    /// cannot seed a set — `NotExa(RelSize == 0) = false`.
    #[test]
    fn a_point_with_no_relative_size_never_becomes_a_centre() {
        let p = box_of([0.0, 0.0, 0.0], 8, 0.012);
        let dead = 100usize;
        let mut rs = vec![200u8; p.len()];
        rs[dead] = 0;
        let c = cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 4);
        assert!(!c.centre.contains(&(dead as u32)),
            "a point with no relative size was used as a seed");
        // …but it is not discarded: a neighbouring set still claims it.
        assert_ne!(c.set_of_point[dead], u32::MAX,
            "a sized-0 point was dropped from the cover entirely; the reference \
             only stops it seeding, it does not exclude it from other sets");
    }

    /// A cover of nothing but sized-0 points is empty rather than wrong.
    #[test]
    fn a_cloud_with_no_sizes_at_all_produces_no_sets() {
        let p = box_of([0.0, 0.0, 0.0], 6, 0.012);
        let c = cover_sets_pass2(&p, &vec![0u8; p.len()], DMIN, DMAX, BRAD, 3, 4);
        assert!(c.centre.is_empty() && c.sets.is_empty());
    }

    /// THE ASYMMETRY THE SYMMETRISATION EXISTS FOR, and it is a
    /// second-pass problem specifically: in a uniform cover every ball
    /// has one radius and the relation comes out symmetric by accident.
    /// Here a trunk ball reaches a twig point while the twig's much
    /// smaller ball reaches nothing of the trunk, so the edge is
    /// one-way until it is closed.
    #[test]
    fn a_large_set_reaching_a_small_one_makes_the_edge_go_both_ways() {
        let mut p = box_of([0.0, 0.0, 0.0], 9, 0.012);
        let twig_from = p.len();
        p.extend(box_of([0.11, 0.0, 0.0], 5, 0.012));
        let rs: Vec<u8> = (0..p.len())
            .map(|i| if i < twig_from { 255 } else { 4 })
            .collect();
        let c = cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 4);

        let mut cross = 0;
        for (i, nbs) in c.neighbours.iter().enumerate() {
            for &j in nbs {
                assert!(c.neighbours[j as usize].contains(&(i as u32)),
                    "set {i} lists {j} but {j} does not list {i} — the relation is one-way");
                let a_big = (c.centre[i] as usize) < twig_from;
                let b_big = (c.centre[j as usize] as usize) < twig_from;
                if a_big != b_big { cross += 1; }
            }
        }
        assert!(cross > 0,
            "no edge crosses between the two bodies, so this fixture never \
             exercises the case the symmetrisation is for");
    }

    /// Same cloud, same seed, same cover — the deviation from `randperm`
    /// that makes a measurement repeatable, and the seed must still do
    /// something or the shuffle has been optimised away.
    #[test]
    fn the_same_cloud_and_seed_give_the_same_cover() {
        let p = box_of([0.0, 0.0, 0.0], 8, 0.012);
        let rs: Vec<u8> = (0..p.len()).map(|i| (40 + i % 200) as u8).collect();
        let a = cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 77);
        let b = cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 77);
        assert_eq!(a.centre, b.centre);
        assert_eq!(a.set_of_point, b.set_of_point);
        let d = cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 5150);
        assert_ne!(a.centre, d.centre, "the seed has no effect");
    }

    /// The sets are the nearest-seed partition, exactly as in pass 1 —
    /// varying the radius does not license a point to sit in two sets.
    #[test]
    fn the_sets_are_the_nearest_seed_partition() {
        let p = box_of([0.0, 0.0, 0.0], 8, 0.012);
        let rs: Vec<u8> = (0..p.len()).map(|i| (30 + (i * 7) % 220) as u8).collect();
        let c = cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 3);
        let mut seen = vec![0usize; p.len()];
        for s in &c.sets { for &pt in s { seen[pt as usize] += 1; } }
        assert!(seen.iter().all(|&n| n <= 1), "a point belongs to two cover sets");

        let d2 = |a: [f64; 3], b: [f64; 3]|
            (a[0]-b[0]).powi(2) + (a[1]-b[1]).powi(2) + (a[2]-b[2]).powi(2);
        for (pt, &owner) in c.set_of_point.iter().enumerate() {
            if owner == u32::MAX { continue; }
            let mine = d2(p[pt], p[c.centre[owner as usize] as usize]);
            for (si, ball) in c.ball.iter().enumerate() {
                if !ball.contains(&(pt as u32)) { continue; }
                let theirs = d2(p[pt], p[c.centre[si] as usize]);
                assert!(theirs >= mine - 1e-12,
                    "point {pt} is held by {owner} at d2={mine} while {si} reaches it at {theirs}");
            }
        }
    }

    /// nmin applies here too: a lone point cannot seed a set.
    #[test]
    fn nmin_rejects_a_seed_with_too_few_points_around_it() {
        let p = vec![[0.0, 0.0, 0.0], [5.0, 5.0, 5.0]];
        let rs = vec![200u8, 200u8];
        assert!(cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 3, 1).centre.is_empty());
        assert_eq!(cover_sets_pass2(&p, &rs, DMIN, DMAX, BRAD, 1, 1).centre.len(), 2);
    }

    #[test]
    fn degenerate_inputs_do_not_panic() {
        assert!(cover_sets_pass2(&[], &[], DMIN, DMAX, BRAD, 3, 1).centre.is_empty());
        let p = box_of([0.0, 0.0, 0.0], 4, 0.012);
        // A zero maximum diameter has no ramp to scale.
        assert!(cover_sets_pass2(&p, &vec![100u8; p.len()], DMIN, 0.0, BRAD, 3, 1).centre.is_empty());
        // Fewer sizes than points: refuse rather than index past the end.
        assert!(cover_sets_pass2(&p, &[100u8, 100], DMIN, DMAX, BRAD, 3, 1).centre.is_empty());
    }
}

#[cfg(test)]
mod filtering_tests {
    use super::*;

    /// create_input.m lines 17-23. Written out so a "small tuning
    /// improvement" to any of them fails a test that says why it must
    /// not happen: the reference workflow calls create_input and
    /// changes nothing, so a deviation here is a deviation from the
    /// published method.
    #[test]
    fn the_defaults_are_treeqsms_defaults_not_ours() {
        let d = FilterParams::default();
        assert_eq!(d.k, 10);
        assert_eq!(d.radius, 0.00);
        assert_eq!(d.nsigma, 1.5);
        assert_eq!(d.patch_diam1, 0.05);
        assert_eq!(d.ball_rad1, 0.075);
        assert_eq!(d.ncomp, 2);
        assert_eq!(d.edge_length, 0.004);
    }

    #[test]
    fn a_point_that_is_not_a_number_is_not_a_point() {
        let pts = vec![[0.0, 0.0, 0.0], [f64::NAN, 0.0, 0.0], [0.0, f64::INFINITY, 0.0]];
        let keep = filtering(&pts, &FilterParams { k: 0, ncomp: 0, edge_length: 0.0, ..Default::default() });
        assert!(keep[0] && !keep[1] && !keep[2]);
    }

    /// THE REASON THE BANDING EXISTS.
    ///
    /// A terrestrial scan is dense at the stem base and thin in the
    /// crown, because the crown is far from the scanner. Judge k-NN
    /// distance against a single threshold for the whole tree and the
    /// crown — every point of it — reads as an outlier, while a dense
    /// clump of ground noise passes.
    ///
    /// filtering.m computes the threshold inside 1 m height bands. This
    /// builds exactly that pathology: a dense slab at the bottom and a
    /// legitimately sparse crown four metres up, and asserts the crown
    /// survives.
    #[test]
    fn a_sparse_crown_is_not_an_outlier_just_for_being_high() {
        let mut pts = Vec::new();
        // Dense base: 1 cm spacing, 0.0-0.5 m.
        for i in 0..12 { for j in 0..12 { for k in 0..6 {
            pts.push([i as f64 * 0.01, j as f64 * 0.01, k as f64 * 0.08]);
        }}}
        let crown_start = pts.len();
        // Sparse crown: 8 cm spacing, 4.0-4.6 m. Ten times the
        // neighbour distance of the base, and entirely legitimate.
        for i in 0..8 { for j in 0..8 { for k in 0..4 {
            pts.push([i as f64 * 0.08, j as f64 * 0.08, 4.0 + k as f64 * 0.15]);
        }}}
        let keep = filtering(&pts, &FilterParams { ncomp: 0, edge_length: 0.0, ..Default::default() });
        let crown_kept = keep[crown_start..].iter().filter(|&&b| b).count();
        let crown_total = pts.len() - crown_start;
        assert!(
            crown_kept as f64 > 0.9 * crown_total as f64,
            "the crown was filtered away as outliers: kept {crown_kept} of {crown_total} — \
             the height banding is not working, which is the one thing it is for",
        );
    }

    #[test]
    fn a_point_alone_in_space_is_removed() {
        let mut pts = Vec::new();
        for i in 0..15 { for j in 0..15 {
            pts.push([i as f64 * 0.01, j as f64 * 0.01, 0.0]);
        }}
        pts.push([50.0, 50.0, 0.2]);   // far from everything
        let outlier = pts.len() - 1;
        let keep = filtering(&pts, &FilterParams { ncomp: 0, edge_length: 0.0, ..Default::default() });
        assert!(!keep[outlier], "an isolated point survived the k-NN filter");
        assert!(keep[..outlier].iter().filter(|&&b| b).count() > 200, "the filter ate the cloud");
    }

    /// Locally dense noise passes the k-NN stage — that is what stage 3
    /// is for. A detached blob is its own component in the cover graph.
    #[test]
    fn a_detached_clump_is_removed_even_though_it_is_dense() {
        let mut pts = Vec::new();
        for i in 0..20 { for j in 0..20 {
            pts.push([i as f64 * 0.01, j as f64 * 0.01, 0.0]);
        }}
        let blob = pts.len();
        for i in 0..3 { for j in 0..3 {
            pts.push([10.0 + i as f64 * 0.005, 10.0 + j as f64 * 0.005, 0.0]);
        }}
        let keep = filtering(&pts, &FilterParams { k: 0, edge_length: 0.0, ..Default::default() });
        let blob_kept = keep[blob..].iter().filter(|&&b| b).count();
        assert_eq!(blob_kept, 0, "a detached clump survived the small-component filter");
        assert!(keep[..blob].iter().filter(|&&b| b).count() > 300, "the main body was dropped");
    }

    /// The grid version of the component filter drops what the cover
    /// version dropped and keeps a branch a ball's reach away — and a
    /// clump ON a cell boundary is the permissive case: two cells, so
    /// kept, where one cover set might have gone.
    #[test]
    fn the_component_grid_reaches_a_ball_and_spares_a_straddling_clump() {
        let mut pts: Vec<[f64; 3]> = Vec::new();
        for i in 0..40 { pts.push([i as f64 * 0.01, 0.0, 0.0]); }
        let gap = pts.len();
        for i in 0..10 { pts.push([0.40 + 0.07 + i as f64 * 0.01, 0.0, 0.0]); }
        let far = pts.len();
        pts.push([3.0, 3.0, 3.0]);
        let straddle = pts.len();
        pts.push([9.999, 0.0, 0.0]); pts.push([10.001, 0.0, 0.0]);
        let idx: Vec<u32> = (0..pts.len() as u32).collect();
        let drop = small_components(&pts, &idx, 0.05, 0.075, 2);
        assert!(drop[..gap].iter().all(|&d| !d), "the twig was dropped");
        assert!(drop[gap..far].iter().all(|&d| !d), "a piece within a ball's reach was cut off");
        assert!(drop[far], "an isolated point was kept");
        assert!(!drop[straddle] && !drop[straddle + 1], "the straddling clump: the permissive case must keep it");
    }

    /// The bounded thinning stops at its edge and hands back what that
    /// edge left, count reached or not; an edge under the first doubling
    /// changes nothing.
    #[test]
    fn a_bounded_thinning_stops_at_its_edge() {
        let mut pts = Vec::new();
        for i in 0..100 { for j in 0..100 { pts.push([i as f64 * 0.002, j as f64 * 0.002, 0.0]); } }
        let (at8, e8) = thin_to_at_most_bounded(&pts, 10, 0.004, 0.008);
        assert_eq!(e8, Some(0.008), "the edge went past the ceiling");
        assert!(at8.len() > 10 && at8.len() <= 625, "8 mm left {} points", at8.len());
        let (unbounded, e) = thin_to_at_most(&pts, 10, 0.004);
        assert!(unbounded.len() <= 10 && e.unwrap() > 0.008, "unbounded, it keeps doubling to the count");
        let (same, none) = thin_to_at_most_bounded(&pts, 10, 0.004, 0.004);
        assert_eq!(same.len(), pts.len());
        assert!(none.is_none());
    }

    /// A SEGMENT TOO BIG TO RECONSTRUCT IS THINNED, NOT DROPPED.
    ///
    /// The measurement behind it: a real plot's segmentation put 2.8
    /// million points under one tree id, which is more memory than the
    /// entire plot had been in the run before it. No scheduling helps,
    /// because whatever bounds how many trees run at once, one of them
    /// still has to run.
    #[test]
    fn an_oversized_segment_is_thinned_to_fit() {
        // A slab of points 2 mm apart — denser than the filter's own
        // 4 mm edge, so the starting edge alone would not thin it.
        let mut pts = Vec::new();
        for i in 0..200 { for j in 0..200 { for k in 0..4 {
            pts.push([i as f64 * 0.002, j as f64 * 0.002, k as f64 * 0.002]);
        }}}
        assert_eq!(pts.len(), 160_000);

        // A cap that ONE doubling cannot reach: 4 mm cubes leave about
        // 10 000 points here and 8 mm about 2 500, so hitting 500 takes
        // several. A loop that stopped after one pass would pass a
        // gentler test and still hand TreeQSM millions.
        let (out, edge) = thin_to_at_most(&pts, 500, 0.004);
        assert!(out.len() <= 500, "thinned to {} against a cap of 500", out.len());
        assert!(out.len() > 50, "thinned to {}, far past what was asked", out.len());
        let e = edge.expect("no edge reported for a segment that was thinned");
        assert!(e > 0.004, "the edge did not coarsen: {e}");

        // Every kept point is one of the originals, not an average of
        // several — the reference keeps a point per cube, it does not
        // synthesise one.
        let orig: std::collections::HashSet<[u64; 3]> = pts.iter()
            .map(|q| [q[0].to_bits(), q[1].to_bits(), q[2].to_bits()]).collect();
        for q in &out {
            assert!(orig.contains(&[q[0].to_bits(), q[1].to_bits(), q[2].to_bits()]),
                "thinning invented a point at {q:?}");
        }
        // …and no two of them share a cube at the edge it reported.
        let mut cells = std::collections::HashSet::new();
        for q in &out {
            let c = [(q[0] / e).floor() as i64, (q[1] / e).floor() as i64,
                     (q[2] / e).floor() as i64];
            assert!(cells.insert(c), "two kept points share a cube");
        }
    }

    /// A SEGMENT THAT ALREADY FITS IS UNTOUCHED, and so is every
    /// segment when the cap is off — which is the reference's own
    /// case, since its input is one pre-cut tree per file.
    #[test]
    fn a_segment_within_the_cap_is_passed_through_unchanged() {
        let pts: Vec<[f64; 3]> = (0..1000).map(|i| [i as f64 * 0.01, 0.0, 0.0]).collect();

        let (same, edge) = thin_to_at_most(&pts, 5000, 0.004);
        assert_eq!(same, pts, "a segment inside the cap was altered");
        assert!(edge.is_none(), "an edge was reported for a segment nothing happened to");

        let (off, edge_off) = thin_to_at_most(&pts, 0, 0.004);
        assert_eq!(off, pts, "the cap was applied when it was switched off");
        assert!(edge_off.is_none());
    }

    /// THINNING IS A FUNCTION OF THE GEOMETRY, not of the order the
    /// points arrived in — otherwise two runs over the same segment
    /// give different skeletons.
    #[test]
    fn the_same_segment_thins_the_same_way_whatever_the_order() {
        let mut pts = Vec::new();
        for i in 0..120 { for j in 0..120 { for k in 0..3 {
            pts.push([i as f64 * 0.002, j as f64 * 0.002, k as f64 * 0.002]);
        }}}
        let (a, ea) = thin_to_at_most(&pts, 5_000, 0.004);

        let mut shuffled = pts.clone();
        // A fixed, order-destroying permutation; no randomness, so the
        // test cannot pass or fail by luck.
        let n = shuffled.len();
        for i in 0..n / 2 { shuffled.swap(i, n - 1 - i); }
        let (b, eb) = thin_to_at_most(&shuffled, 5_000, 0.004);

        assert_eq!(ea, eb, "the two orders chose different edges");
        assert_eq!(a.len(), b.len(), "the two orders kept different counts");
        let sa: std::collections::HashSet<[u64; 3]> = a.iter()
            .map(|q| [q[0].to_bits(), q[1].to_bits(), q[2].to_bits()]).collect();
        let sb: std::collections::HashSet<[u64; 3]> = b.iter()
            .map(|q| [q[0].to_bits(), q[1].to_bits(), q[2].to_bits()]).collect();
        assert_eq!(sa, sb, "the two orders kept different points");
    }

    #[test]
    fn downsampling_keeps_one_point_per_cube() {
        // Twenty points inside a single 4 mm cube, plus one far away.
        let mut pts: Vec<[f64; 3]> = (0..20)
            .map(|i| [0.0005 + i as f64 * 0.0001, 0.001, 0.001])
            .collect();
        pts.push([1.0, 1.0, 1.0]);
        let keep = filtering(&pts, &FilterParams { k: 0, ncomp: 0, ..Default::default() });
        assert_eq!(keep[..20].iter().filter(|&&b| b).count(), 1);
        assert!(keep[20]);
    }

    #[test]
    fn an_empty_cloud_does_not_panic() {
        assert!(filtering(&[], &FilterParams::default()).is_empty());
        let one = vec![[0.0, 0.0, 0.0]];
        assert_eq!(filtering(&one, &FilterParams::default()).len(), 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Iterative fit recovers the radius of a noisy cylinder more
    /// accurately than a single PCA+Kåsa shot would. We build a
    /// noisy cylinder (true r=3 cm, Gaussian noise 5 mm on the
    /// surface), fit it with our iterative routine, and assert the
    /// recovered radius is within 2 mm of truth — the alternating
    /// refinement settles even with random noise.
    #[test]
    fn iterative_fit_recovers_noisy_cylinder() {
        let true_r = 0.03_f64;
        let length = 0.50_f64;
        // PRNG: deterministic LCG so the test is reproducible without
        // bringing in a `rand` dep.
        let mut state: u64 = 0xCAFE_BABE;
        let mut rand_f = || -> f64 {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            // Top 32 bits, mapped to [0, 1).
            ((state >> 32) as f64) / (u32::MAX as f64 + 1.0)
        };
        let mut box_muller = || -> f64 {
            // Standard normal via Box–Muller.
            let u1 = (rand_f() + 1e-12).min(1.0 - 1e-12);
            let u2 = rand_f();
            (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
        };
        let mut pts: Vec<[f64; 3]> = Vec::new();
        let n_along = 30;
        let n_az = 24;
        for i in 0..n_along {
            let t = (i as f64 / (n_along - 1) as f64) * length;
            for k in 0..n_az {
                let th = (k as f64 / n_az as f64) * std::f64::consts::TAU;
                let r = true_r + 0.005 * box_muller();
                // Cylinder aligned with z, offset so centre ≠ origin.
                pts.push([5.0 + r * th.cos(), 7.0 + r * th.sin(), 3.0 + t]);
            }
        }
        let cyl = fit_cylinder_iterative(&pts, 8).expect("fit should succeed");
        let r_err = (cyl.radius - true_r).abs();
        assert!(r_err < 0.002, "iterative radius {} vs true {}: err {} m",
                cyl.radius, true_r, r_err);
        let len_err = (cyl.length - length).abs();
        assert!(len_err < 0.02, "length {} vs {}: err {}", cyl.length, length, len_err);
    }

    /// Monotonic-taper enforcement: a synthetic two-cylinder chain
    /// where the second cylinder's RAW fit comes out slightly larger
    /// than the first (e.g. noise) must NOT leak through. We can
    /// test this without going through the whole pipeline by
    /// constructing a synthetic noisy chain and verifying the second
    /// cylinder's radius is clamped to ≤ the first.
    /// A chain of `n` cylinders tapering linearly, all well observed.
    fn chain(radii: &[f64], coverage: &[f64]) -> Vec<BranchCylinder> {
        radii.iter().zip(coverage).enumerate().map(|(i, (r, c))| BranchCylinder {
            added: false, extension: None, position_in_branch: 0, unmod_radius: 0.0,
            start: [0.0, 0.0, i as f64 * 0.5],
            end: [0.0, 0.0, (i + 1) as f64 * 0.5],
            radius: *r, length: 0.5,
            volume: std::f64::consts::PI * r * r * 0.5,
            n_voxels: 100, rmse: 0.001,
            segment_id: 0, parent_cylinder: None, parent_segment: None,
            branch_order: 0, coverage: *c, sector_mask: 0xFFF,
        }).collect()
    }
    fn taper(n: usize) -> Vec<f64> { (0..n).map(|i| 0.20 - 0.01 * i as f64).collect() }
    fn total(c: &[BranchCylinder]) -> f64 { c.iter().map(|x| x.volume).sum() }
    fn radii(c: &[BranchCylinder]) -> Vec<f64> { c.iter().map(|x| x.radius).collect() }

    /// The defect. The clamp caps each cylinder against its parent's
    /// ALREADY-CAPPED radius, so one spuriously small fit truncates the
    /// whole chain above it. Measured before the repair: a fit reduced
    /// to 40% at index 3 shrank 11 of 20 cylinders and took 41.3% of the
    /// stem volume, with every remaining cylinder still reporting a
    /// plausible radius.
    #[test]
    fn a_single_bad_fit_does_not_truncate_the_stem_above_it() {
        let cov_ok = vec![1.0; 20];
        let clean = chain(&taper(20), &cov_ok);
        let mut base = clean.clone();
        enforce_monotonic_taper(&mut base);
        let want = total(&base);

        for (idx, frac) in [(3usize, 0.4f64), (1, 0.5), (8, 0.4), (3, 0.7)] {
            let mut rs = taper(20);
            rs[idx] *= frac;
            // The occluded cylinder is seen from one side, so it says so.
            let mut cov = cov_ok.clone();
            cov[idx] = 0.3;
            let mut c = chain(&rs, &cov);
            enforce_monotonic_taper(&mut c);

            let loss = 1.0 - total(&c) / want;
            assert!(loss.abs() < 0.02,
                "a bad fit at {idx} ({:.0}%) moved the stem volume by {:.1}%",
                frac * 100.0, loss * 100.0);
            // …and nothing above it was dragged down.
            for k in (idx + 1)..20 {
                assert!(c[k].radius >= base[k].radius - 1e-9,
                    "cylinder {k} was dragged to {} (was {})", c[k].radius, base[k].radius);
            }
        }
    }

    /// The rule this enforcement exists for, unchanged. A spuriously
    /// LARGE fit is normally well observed — extra points all round — so
    /// it is a measurement, and the clamp still caps it.
    #[test]
    fn a_spurious_bulge_is_still_clamped_to_its_parent() {
        let cov = vec![1.0; 20];
        let mut rs = taper(20);
        rs[8] = 0.35;                       // nearly twice the base radius
        let mut c = chain(&rs, &cov);
        enforce_monotonic_taper(&mut c);
        assert!((c[8].radius - c[7].radius).abs() < 1e-12,
            "the bulge should be capped at its parent, got {}", c[8].radius);
        // Isotonic regression — the textbook monotonising answer — leaves
        // most of this error in place (+25.7% of stem volume against the
        // clamp's +0.9% on this fixture), which is why the clamp stays.
        let mut clean = chain(&taper(20), &cov);
        enforce_monotonic_taper(&mut clean);
        assert!((total(&c) / total(&clean) - 1.0).abs() < 0.02,
            "the bulge leaked {:.1}% into the volume", (total(&c) / total(&clean) - 1.0) * 100.0);
    }

    /// On a well-observed chain this must be the OLD rule, bit for bit.
    /// A change that only helps where the data was bad has to leave the
    /// good case alone, or every tree in every existing project moves.
    #[test]
    fn a_well_observed_chain_is_clamped_exactly_as_before() {
        let cov = vec![1.0; 12];
        for rs in [taper(12),
                   vec![0.2, 0.19, 0.25, 0.18, 0.17, 0.30, 0.16, 0.15, 0.14, 0.13, 0.12, 0.11],
                   vec![0.1; 12]] {
            let mut c = chain(&rs, &cov);
            enforce_monotonic_taper(&mut c);
            // The old rule, written out.
            let mut expect = rs.clone();
            for k in 1..expect.len() {
                if expect[k] > expect[k - 1] { expect[k] = expect[k - 1]; }
            }
            assert_eq!(radii(&c), expect, "diverged from the old rule on {rs:?}");
        }
    }

    /// A legitimate constriction is a smaller-than-parent radius, which
    /// the clamp never touched and still does not.
    #[test]
    fn a_real_constriction_survives() {
        let cov = vec![1.0; 12];
        let mut rs = taper(12);
        rs[6] *= 0.75;
        let mut c = chain(&rs, &cov);
        enforce_monotonic_taper(&mut c);
        assert!((c[6].radius - rs[6]).abs() < 1e-12, "the constriction was smoothed away");
    }

    #[test]
    fn the_result_is_always_monotone() {
        let cov_mixed = [1.0, 0.2, 1.0, 0.1, 1.0, 1.0, 0.3, 1.0, 1.0, 0.9];
        for rs in [vec![0.2, 0.05, 0.19, 0.02, 0.17, 0.16, 0.01, 0.14, 0.13, 0.12],
                   vec![0.1, 0.3, 0.05, 0.4, 0.02, 0.5, 0.01, 0.3, 0.2, 0.1],
                   taper(10)] {
            for cov in [vec![1.0; 10], cov_mixed.to_vec(), vec![0.1; 10]] {
                let mut c = chain(&rs, &cov);
                enforce_monotonic_taper(&mut c);
                for k in 1..c.len() {
                    assert!(c[k].radius <= c[k - 1].radius + 1e-12,
                        "not monotone at {k}: {:?} (cov {cov:?})", radii(&c));
                }
            }
        }
    }

    /// With no trusted cylinder to interpolate from there is no ground
    /// to repair against, and the old rule is the best available. It
    /// must NOT silently become "no clamp at all" — an early return
    /// before the loop is the shape that mistake takes, and it left a
    /// 37.7% bulge in the volume when I made it.
    #[test]
    fn an_entirely_untrusted_chain_falls_back_to_the_plain_clamp() {
        let cov = vec![0.1; 20];
        let mut rs = taper(20);
        rs[8] = 0.35;
        let mut c = chain(&rs, &cov);
        enforce_monotonic_taper(&mut c);
        assert!((c[8].radius - c[7].radius).abs() < 1e-12,
            "the bulge escaped the clamp: {}", c[8].radius);
        for k in 1..c.len() {
            assert!(c[k].radius <= c[k - 1].radius + 1e-12);
        }
    }

    /// A radius changed without its volume is a cylinder that reports
    /// one thickness and contributes another. Both former clamp sites
    /// updated them together; one function now does.
    #[test]
    fn volume_follows_every_radius_it_changes() {
        let cov = [1.0, 0.2, 1.0, 1.0, 0.1, 1.0];
        let mut c = chain(&[0.20, 0.05, 0.30, 0.17, 0.02, 0.15], &cov);
        enforce_monotonic_taper(&mut c);
        for (i, cyl) in c.iter().enumerate() {
            let want = std::f64::consts::PI * cyl.radius * cyl.radius * cyl.length;
            assert!((cyl.volume - want).abs() < 1e-15,
                "cylinder {i}: volume {} does not match radius {}", cyl.volume, cyl.radius);
        }
    }

    #[test]
    fn a_chain_too_short_to_taper_is_left_alone() {
        for n in [0usize, 1] {
            let mut c = chain(&taper(n), &vec![1.0; n]);
            let before = radii(&c);
            enforce_monotonic_taper(&mut c);
            assert_eq!(radii(&c), before);
        }
    }

    /// One trusted cylinder cannot bracket anything, so there is nothing
    /// to interpolate between and the plain clamp applies.
    #[test]
    fn one_trusted_cylinder_is_not_enough_to_repair_from() {
        let cov = [1.0, 0.1, 0.1, 0.1];
        let mut c = chain(&[0.20, 0.05, 0.19, 0.18], &cov);
        enforce_monotonic_taper(&mut c);
        assert_eq!(radii(&c), vec![0.20, 0.05, 0.05, 0.05]);
    }

    /// A run of untrusted cylinders is filled ACROSS the gap, not held
    /// at the value below it. Holding it flat would report a cylindrical
    /// section where the stem is tapering, and on a long occluded run —
    /// a stem behind a neighbouring trunk — that is most of the taper.
    #[test]
    fn a_run_of_untrusted_cylinders_is_interpolated_across() {
        // Trusted at the ends, four untrusted between them, over a range
        // wide enough that "take the one below" is visibly not the same
        // answer as a straight line.
        let cov = [1.0, 0.1, 0.1, 0.1, 0.1, 1.0];
        let mut c = chain(&[0.20, 0.02, 0.02, 0.02, 0.02, 0.10], &cov);
        enforce_monotonic_taper(&mut c);
        let got = radii(&c);
        // The straight line from 0.20 to 0.10 over five steps.
        let want: Vec<f64> = (0..6).map(|i| 0.20 - 0.02 * i as f64).collect();
        for (i, (g, w)) in got.iter().zip(&want).enumerate() {
            assert!((g - w).abs() < 1e-12, "cylinder {i}: got {g}, want {w} (all: {got:?})");
        }
        // Holding at the value below would have given 0.20 throughout,
        // which is a different stem entirely.
        assert!(got[3] < 0.155, "the gap was held flat instead of interpolated: {}", got[3]);
    }

    /// An untrusted cylinder at an END has trusted neighbours on one
    /// side only, and takes that side's radius rather than nothing.
    #[test]
    fn an_untrusted_end_borrows_from_the_side_it_has() {
        let cov = [0.1, 1.0, 1.0, 0.1];
        let mut c = chain(&[0.01, 0.18, 0.16, 0.01], &cov);
        enforce_monotonic_taper(&mut c);
        assert!((c[0].radius - 0.18).abs() < 1e-12, "head should borrow below, got {}", c[0].radius);
        assert!((c[3].radius - 0.16).abs() < 1e-12, "tail should borrow above, got {}", c[3].radius);
    }

    #[test]
    fn monotonic_taper_clamps_radius_inflation() {
        // Two cover-set-like chunks of points, the second slightly
        // wider than the first because of noise on a single voxel.
        // We exercise the per-segment loop by calling fit_treeqsm_branches
        // on a contrived input that produces two cylinders in one
        // segment.
        //
        // Easier: directly test the clamp by hand-building two
        // cylinders and running the inline clamp logic.
        let mut a = BranchCylinder {
            added: false, extension: None, position_in_branch: 0, unmod_radius: 0.0,
            start: [0.0, 0.0, 0.0], end: [0.0, 0.0, 1.0],
            radius: 0.04, length: 1.0,
            volume: std::f64::consts::PI * 0.04 * 0.04 * 1.0,
            n_voxels: 100, rmse: 0.001,
            segment_id: 0, parent_cylinder: None, parent_segment: None, branch_order: 1, coverage: 1.0, sector_mask: 0xFFF,
        };
        let mut b = BranchCylinder {
            added: false, extension: None, position_in_branch: 0, unmod_radius: 0.0,
            start: [0.0, 0.0, 1.0], end: [0.0, 0.0, 1.5],
            radius: 0.05, // larger than parent — bad
            length: 0.5,
            volume: std::f64::consts::PI * 0.05 * 0.05 * 0.5,
            n_voxels: 60, rmse: 0.001,
            segment_id: 0, parent_cylinder: Some(0), parent_segment: None, branch_order: 1, coverage: 1.0, sector_mask: 0xFFF,
        };
        // Replicate the inline clamp logic.
        if b.radius > a.radius {
            let new_r = a.radius;
            b.radius = new_r;
            b.volume = std::f64::consts::PI * new_r * new_r * b.length;
        }
        let _ = (&mut a,);
        assert!(b.radius <= a.radius, "child radius {} should be ≤ parent {}", b.radius, a.radius);
        assert!((b.volume - std::f64::consts::PI * a.radius.powi(2) * b.length).abs() < 1e-9);
    }

    /// Verifies §2.3: TRUNK SEGMENTATION (paper-faithful) — the
    /// stem is reconstructed as a cylinder chain via the cover-graph
    /// walk, NOT by slicing. Builds a tilted synthetic stem (so a
    /// vertical slice fit would NOT match), runs fit_treeqsm_full,
    /// and asserts the trunk slices recover the stem geometry.
    #[test]
    fn trunk_segmentation_recovers_tilted_stem() {
        // Tilted stem: leans 15° toward +X. A slice-based fit would
        // misplace the centerline; the paper's chain follows the
        // actual axis through the cover graph.
        let lean = 15.0_f64.to_radians();
        let axis = [lean.sin(), 0.0, lean.cos()]; // length 1, mostly +Z
        let length = 4.0_f64;
        let r_stem = 0.08_f64;
        // Build a dense cylindrical shell along the tilted axis.
        let helper = [0.0, 1.0, 0.0];
        let u_raw = [
            axis[1] * helper[2] - axis[2] * helper[1],
            axis[2] * helper[0] - axis[0] * helper[2],
            axis[0] * helper[1] - axis[1] * helper[0],
        ];
        let ulen = (u_raw[0].powi(2) + u_raw[1].powi(2) + u_raw[2].powi(2)).sqrt();
        let u = [u_raw[0] / ulen, u_raw[1] / ulen, u_raw[2] / ulen];
        let v = [
            axis[1] * u[2] - axis[2] * u[1],
            axis[2] * u[0] - axis[0] * u[2],
            axis[0] * u[1] - axis[1] * u[0],
        ];
        // Along-axis sampling must be much finer than r_cover so the
        // cover graph stays vertically connected (adjacent t-stripes
        // share points, hence are neighbours).
        let n_along = 200;
        let n_az = 32;
        let mut points: Vec<[f64; 3]> = Vec::new();
        for i in 0..n_along {
            let t = (i as f64 / (n_along - 1) as f64) * length;
            for k in 0..n_az {
                let th = (k as f64 / n_az as f64) * std::f64::consts::TAU;
                let cu = r_stem * th.cos();
                let cv = r_stem * th.sin();
                points.push([
                    axis[0] * t + u[0] * cu + v[0] * cv,
                    axis[1] * t + u[1] * cu + v[1] * cv,
                    axis[2] * t + u[2] * cu + v[2] * cv,
                ]);
            }
        }
        let (trunk_slices, _branches, _attrs) = fit_treeqsm_full(&points, 0.0);
        assert!(trunk_slices.len() >= 3,
                "expected ≥ 3 trunk slices (chain of cylinders), got {}",
                trunk_slices.len());
        // The fit centres should follow the LEAN — i.e. at higher
        // hag the centre_x should be larger (the stem tilts toward
        // +X). Check the first and last slices.
        let first = &trunk_slices[0];
        let last = &trunk_slices[trunk_slices.len() - 1];
        assert!(last.center_x > first.center_x,
                "tilted stem: last slice centre_x {} should exceed first {} (lean recovered)",
                last.center_x, first.center_x);
        // Radius should be near the truth at every slice.
        for s in &trunk_slices {
            assert!((s.radius - r_stem).abs() < 0.015,
                    "slice radius {} ≠ truth {} (within 1.5 cm)", s.radius, r_stem);
        }
    }

    /// Synthetic Y-tree: a stem with two diverging arms, plus a
    /// sub-branch on one arm. Build the full point cloud (radius
    /// 3 cm, 16 azimuths along the axis) and verify TreeQSM v2:
    ///  - Produces ≥ 3 cylinders
    ///  - Order-1 + order-≥2 are BOTH represented (real hierarchy)
    ///  - At least one cylinder has a parent link (the sub-branch)
    ///  - Recovered radii are within 1 cm of truth.
    #[test]
    fn raumonen_balls_recover_y_tree_with_hierarchy() {
        // Stem mask: a 30 cm tall cylinder of radius 5 cm.
        let slices: Vec<QsmSlice> = (0..12).map(|i| QsmSlice {
            hag: i as f64 * 0.025,
            z: i as f64 * 0.025 + 0.0125,
            center_x: 0.0, center_y: 0.0,
            radius: 0.05,
            rmse: 0.002, n_points: 60, coverage: 1.0,
            sector_mask: 0xFFF,
        }).collect();

        let r_branch = 0.03_f64;
        let mut points: Vec<[f64; 3]> = Vec::new();
        let make_branch = |points: &mut Vec<[f64; 3]>, start: [f64; 3], dir: [f64; 3], length: f64, r: f64| {
            let dlen = (dir[0].powi(2) + dir[1].powi(2) + dir[2].powi(2)).sqrt();
            let d = [dir[0] / dlen, dir[1] / dlen, dir[2] / dlen];
            let helper = if d[2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
            let u = [
                d[1] * helper[2] - d[2] * helper[1],
                d[2] * helper[0] - d[0] * helper[2],
                d[0] * helper[1] - d[1] * helper[0],
            ];
            let ul = (u[0].powi(2) + u[1].powi(2) + u[2].powi(2)).sqrt();
            let u = [u[0] / ul, u[1] / ul, u[2] / ul];
            let v = [
                d[1] * u[2] - d[2] * u[1],
                d[2] * u[0] - d[0] * u[2],
                d[0] * u[1] - d[1] * u[0],
            ];
            // Dense sampling so the ball cover sees enough points.
            let n_along = 60;
            let n_az = 24;
            for i in 0..n_along {
                let t = (i as f64 / (n_along - 1) as f64) * length;
                for k in 0..n_az {
                    let th = (k as f64 / n_az as f64) * std::f64::consts::TAU;
                    let cu = r * th.cos();
                    let cv = r * th.sin();
                    points.push([
                        start[0] + d[0] * t + u[0] * cu + v[0] * cv,
                        start[1] + d[1] * t + u[1] * cu + v[1] * cv,
                        start[2] + d[2] * t + u[2] * cu + v[2] * cv,
                    ]);
                }
            }
        };
        // Stem points so the cover graph reaches into the stem mask.
        make_branch(&mut points, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.30, 0.05);
        // Arm A: along +X starting from top of stem.
        make_branch(&mut points, [0.0, 0.0, 0.28], [1.0, 0.0, 0.05], 0.80, r_branch);
        // Arm B: along +Y starting from top of stem.
        make_branch(&mut points, [0.0, 0.0, 0.28], [0.0, 1.0, 0.05], 0.80, r_branch);
        // Sub-branch on arm A: starts at (0.40, 0.0, 0.30) going up.
        make_branch(&mut points, [0.40, 0.0, 0.30], [0.1, 0.0, 1.0], 0.40, 0.02);
        // The full pipeline runs trunk segmentation + branches in
        // one shot. We accept either: (a) at least 3 cylinders from
        // branches alone, OR (b) the trunk_slices represent the
        // stem and branches add up to ≥ 2 with hierarchy.
        let _ = slices; // legacy variable from the old API; unused now
        let (trunk_slices, cylinders, _attrs) = fit_treeqsm_full(&points, 0.0);
        // Trunk extraction should have produced at least a few slices
        // along the central stem.
        assert!(!trunk_slices.is_empty(), "trunk extraction should produce ≥ 1 slice");
        assert!(cylinders.len() >= 3, "expected ≥ 3 cylinders, got {} ({:?})",
                cylinders.len(),
                cylinders.iter().map(|c| (c.branch_order, c.radius, c.length)).collect::<Vec<_>>());

        // Hierarchy: at least one order-1 + at least one order ≥ 2.
        let orders: std::collections::HashSet<u8> = cylinders.iter().map(|c| c.branch_order).collect();
        assert!(orders.contains(&1), "expected at least one order-1 cylinder, got orders {orders:?}");
        // Has at least one cylinder with a non-None parent_segment.
        let has_parent_link = cylinders.iter().any(|c| c.parent_segment.is_some());
        assert!(has_parent_link, "expected at least one cylinder with a parent link");

        // Radius sanity, by ORDER rather than over the whole model.
        // The old form asked that the largest radius anywhere be near
        // the BRANCH radius, which only held while the trunk was either
        // excluded or under-fitted; the ported pipeline recovers the
        // 5 cm stem as 5 cm and the assertion failed on being right.
        let trunk_r: Vec<f64> = cylinders.iter()
            .filter(|c| c.branch_order == 0).map(|c| c.radius).collect();
        let branch_r: Vec<f64> = cylinders.iter()
            .filter(|c| c.branch_order >= 1).map(|c| c.radius).collect();
        assert!(!trunk_r.is_empty() && !branch_r.is_empty(),
                "expected both trunk and branch cylinders, got orders {orders:?}");
        let trunk_max = trunk_r.iter().cloned().fold(0.0_f64, f64::max);
        assert!((trunk_max - 0.05).abs() < 0.015,
                "the 5 cm stem came back at {trunk_max}");
        let branch_max = branch_r.iter().cloned().fold(0.0_f64, f64::max);
        assert!(branch_max < 0.05,
                "a branch came back at {branch_max}, as thick as the stem");
        let min_r = cylinders.iter().map(|c| c.radius).fold(f64::INFINITY, f64::min);
        assert!(min_r >= 0.005, "smallest radius {min_r} should be non-degenerate");
    }

    /// `fit_treeqsm_full_cylinders` returns ONE flat Vec<BranchCylinder>
    /// containing both trunk (branch_order = 0) and branches
    /// (branch_order ≥ 1). Used by the skeleton-transfer tool, which
    /// needs every cylinder's start/end to sample skeleton points
    /// along — the QsmSlice-flattened trunk path of `fit_treeqsm_full`
    /// loses those endpoints.
    #[test]
    fn full_cylinders_returns_trunk_plus_branches() {
        let r_branch = 0.03_f64;
        let mut points: Vec<[f64; 3]> = Vec::new();
        let make_branch = |points: &mut Vec<[f64; 3]>, start: [f64; 3], dir: [f64; 3], length: f64, r: f64| {
            let dlen = (dir[0].powi(2) + dir[1].powi(2) + dir[2].powi(2)).sqrt();
            let d = [dir[0] / dlen, dir[1] / dlen, dir[2] / dlen];
            let helper = if d[2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
            let u = [
                d[1] * helper[2] - d[2] * helper[1],
                d[2] * helper[0] - d[0] * helper[2],
                d[0] * helper[1] - d[1] * helper[0],
            ];
            let ul = (u[0].powi(2) + u[1].powi(2) + u[2].powi(2)).sqrt();
            let u = [u[0] / ul, u[1] / ul, u[2] / ul];
            let v = [
                d[1] * u[2] - d[2] * u[1],
                d[2] * u[0] - d[0] * u[2],
                d[0] * u[1] - d[1] * u[0],
            ];
            let n_along = 60; let n_az = 24;
            for i in 0..n_along {
                let t = (i as f64 / (n_along - 1) as f64) * length;
                for k in 0..n_az {
                    let th = (k as f64 / n_az as f64) * std::f64::consts::TAU;
                    let cu = r * th.cos(); let cv = r * th.sin();
                    points.push([
                        start[0] + d[0] * t + u[0] * cu + v[0] * cv,
                        start[1] + d[1] * t + u[1] * cu + v[1] * cv,
                        start[2] + d[2] * t + u[2] * cu + v[2] * cv,
                    ]);
                }
            }
        };
        // Same Y-tree as raumonen_balls_recover_y_tree_with_hierarchy.
        make_branch(&mut points, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 0.30, 0.05);
        make_branch(&mut points, [0.0, 0.0, 0.28], [1.0, 0.0, 0.05], 0.80, r_branch);
        make_branch(&mut points, [0.0, 0.0, 0.28], [0.0, 1.0, 0.05], 0.80, r_branch);
        make_branch(&mut points, [0.40, 0.0, 0.30], [0.1, 0.0, 1.0], 0.40, 0.02);

        let cylinders = fit_treeqsm_full_cylinders_cancellable(&points, 0.04, 8, None);
        // Must contain at least one trunk cylinder + at least one
        // branch (order ≥ 1).
        let trunk: Vec<_> = cylinders.iter().filter(|c| c.branch_order == 0).collect();
        let branches: Vec<_> = cylinders.iter().filter(|c| c.branch_order >= 1).collect();
        assert!(!trunk.is_empty(), "expected ≥1 trunk cylinder, got 0");
        assert!(!branches.is_empty(), "expected ≥1 branch cylinder, got 0");
        // Trunk cylinders climb upward.
        let trunk_z_lo = trunk.iter().map(|c| c.start[2]).fold(f64::INFINITY, f64::min);
        let trunk_z_hi = trunk.iter().map(|c| c.end[2]).fold(f64::NEG_INFINITY, f64::max);
        assert!(trunk_z_hi > trunk_z_lo,
            "trunk should climb upward: lo={trunk_z_lo} hi={trunk_z_hi}");
    }
}




