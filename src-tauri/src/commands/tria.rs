// Stem triangulation.
//
// ATTRIBUTION — THIS FILE IS PORTED, NOT REIMPLEMENTED.
//
//   Portions Copyright (C) 2015-2022 Pasi Raumonen, Tampere University,
//   ported from TreeQSM 2.4.0 <https://github.com/InverseTampere/TreeQSM>,
//   GPL-3.0-or-later — src/triangulation/curve_based_triangulation.m,
//   boundary_curve.m, boundary_curve2.m, initial_boundary_curve.m and
//   check_self_intersection.m, together with the `triangulate_stem`
//   subfunction of src/main_steps/tree_data.m.
//
// WHAT IT IS FOR. A cylinder is a poor model of the bottom two metres
// of a buttressed stem: the cross-section there is not a circle, and
// fitting one to it either swallows the buttresses or is inflated by
// them. This reconstructs that section as a triangle mesh instead —
// horizontal boundary curves a triangle-height apart, stitched into a
// surface — and reports the volume that surface encloses. Above the
// first major branch the cylinder model takes over again, and the
// "mix" volumes are the triangulated butt plus the cylinders above it.
//
// IT IS OFF BY DEFAULT, in the reference (`inputs.Tria = 0`) and here.
//
// THE ONE PLACE THE REFERENCE IS NOT REPRODUCIBLE AGAINST ITSELF.
// `initial_boundary_curve` searches for a centre to measure angles
// from by jittering the mean with `randn` until the centre is at least
// 7.5 cm from every point of the cross-section, and `triangulate_stem`
// wraps the whole reconstruction in four nested retry loops — up to
// fifteen attempts at the first curve, five at the triangulation,
// three triangle sizes, four stem lengths — because an attempt often
// fails. Two runs of the reference over one tree can therefore produce
// two different meshes, or one mesh and no mesh. This port replaces the
// jitter with a deterministic sequence of offsets, documented at the
// site, so a stem triangulates the same way every time; the retry
// count then means "try the next offset" rather than "roll again".
//
// DEFECTS IN THE REFERENCE, marked "FIXED — reference defect N" at
// their sites and numbered into the same register as the rest of the
// port, in commands/treeqsm.rs.

use super::geom;
use rustc_hash::FxHashMap;

/// A cell index in the 2-D grid the curve fitting partitions by.
type Cell = (i64, i64);

fn cell_of(x: f64, y: f64, r: f64) -> Cell {
    ((x / r).floor() as i64, (y / r).floor() as i64)
}

/// The reference builds a dense `N(1) x N(2)` cell array with a
/// three-cell margin so its neighbourhood indexing cannot fall off the
/// edge. A hash has no edge, so the margin and the clamping that goes
/// with it are not ported.
fn partition2(p: &[[f64; 3]], r: f64) -> FxHashMap<Cell, Vec<u32>> {
    let mut g: FxHashMap<Cell, Vec<u32>> = FxHashMap::default();
    for (i, q) in p.iter().enumerate() {
        g.entry(cell_of(q[0], q[1], r)).or_default().push(i as u32);
    }
    g
}

fn gather(g: &FxHashMap<Cell, Vec<u32>>, c: Cell, ring: i64, out: &mut Vec<u32>) {
    out.clear();
    for dx in -ring..=ring {
        for dy in -ring..=ring {
            if let Some(v) = g.get(&(c.0 + dx, c.1 + dy)) { out.extend_from_slice(v); }
        }
    }
}

/// `check_self_intersection` — does a closed curve cross itself, and
/// how far along each element the first crossing is.
///
/// Only the two-dimensional branch is ported: every caller passes the
/// curve's x and y.
///
/// The returned vector holds, for each line element, the smallest
/// distance along it to a crossing — the reference's
/// `IntersectLines{i,2}` after its `min`. `None` where the element
/// crosses nothing.
pub fn check_self_intersection(curve: &[[f64; 2]]) -> (bool, Vec<Option<f64>>) {
    let n = curve.len();
    let mut cross: Vec<Option<f64>> = vec![None; n];
    if n < 4 { return (false, cross); }

    let mut dir = Vec::with_capacity(n);
    let mut len = Vec::with_capacity(n);
    for i in 0..n {
        let b = curve[(i + 1) % n];
        let v = [b[0] - curve[i][0], b[1] - curve[i][1]];
        let l = (v[0] * v[0] + v[1] * v[1]).sqrt();
        len.push(l);
        dir.push(if l > 0.0 { [v[0] / l, v[1] / l] } else { [0.0, 0.0] });
    }

    let mut intersect = false;
    let note = |i: usize, x: f64, c: &mut [Option<f64>]| {
        c[i] = Some(match c[i] { Some(p) if p <= x => p, _ => x });
    };
    for i in 0..n.saturating_sub(1) {
        for j in 0..n {
            // The reference's neighbour exclusion: an element cannot
            // cross itself or the two it shares a vertex with.
            let skip = if i > 0 { j <= i + 1 && j + 1 >= i } else { j <= 1 || j + 1 >= n };
            if skip { continue; }
            // Solve Curve(i) - Curve(j) = [dir(j) -dir(i)] * x.
            let det = dir[j][0] * (-dir[i][1]) - (-dir[i][0]) * dir[j][1];
            if det.abs() < 1e-15 { continue; }
            let b = [curve[i][0] - curve[j][0], curve[i][1] - curve[j][1]];
            let xj = (-dir[i][1] * b[0] + dir[i][0] * b[1]) / det;
            let xi = (-dir[j][1] * b[0] + dir[j][0] * b[1]) / det;
            if xj >= 0.0 && xj <= len[j] && xi >= 0.0 && xi <= len[i] {
                intersect = true;
                note(i, xi, &mut cross);
                note(j, xj, &mut cross);
            }
        }
    }
    (intersect, cross)
}

/// Push each element of a self-intersecting curve back to just short
/// of where it crosses — the repair both `boundary_curve` and
/// `curve_based_triangulation` attempt before giving up.
///
/// Returns whether the curve still intersects after `rounds` attempts.
fn repair_self_intersection(curve: &mut [[f64; 3]], rounds: usize) -> bool {
    let flat = |c: &[[f64; 3]]| -> Vec<[f64; 2]> { c.iter().map(|q| [q[0], q[1]]).collect() };
    let (mut hit, mut cross) = check_self_intersection(&flat(curve));
    let mut round = 0;
    while hit && round < rounds {
        let n = curve.len();
        let lines: Vec<usize> = (0..n).filter(|&i| cross[i].is_some()).collect();
        if lines.is_empty() { break; }
        let ele: Vec<[f64; 3]> = (0..n).map(|i| {
            let b = curve[(i + 1) % n];
            [b[0] - curve[i][0], b[1] - curve[i][1], b[2] - curve[i][2]]
        }).collect();
        // Every other crossing element, as the reference's `1:2:m`.
        for k in (0..lines.len()).step_by(2) {
            let i = lines[k];
            let d = (ele[i][0] * ele[i][0] + ele[i][1] * ele[i][1] + ele[i][2] * ele[i][2]).sqrt();
            if d <= 0.0 || d.is_nan() { continue; }
            let f = 0.9 * cross[i].unwrap_or(0.0) / d;
            let moved = [curve[i][0] + f * ele[i][0],
                         curve[i][1] + f * ele[i][1],
                         curve[i][2] + f * ele[i][2]];
            curve[(i + 1) % n] = moved;
        }
        let r = check_self_intersection(&flat(curve));
        hit = r.0;
        cross = r.1;
        round += 1;
    }
    hit
}

/// The segment each cross-section point belongs to: the seed point
/// nearest it within `rball`, or none.
fn segment_by_seed(
    p: &[[f64; 3]], seeds: &[[f64; 3]], rball: f64, ring: i64,
) -> Vec<Vec<u32>> {
    let g = partition2(p, rball);
    let mut best = vec![(f64::INFINITY, usize::MAX); p.len()];
    let mut near: Vec<u32> = Vec::new();
    for (i, s) in seeds.iter().enumerate() {
        gather(&g, cell_of(s[0], s[1], rball), ring, &mut near);
        for &j in &near {
            let q = p[j as usize];
            let d = (q[0] - s[0]).powi(2) + (q[1] - s[1]).powi(2);
            if d < rball * rball && d < best[j as usize].0 { best[j as usize] = (d, i); }
        }
    }
    let mut seg: Vec<Vec<u32>> = vec![Vec::new(); seeds.len()];
    for (j, &(_, i)) in best.iter().enumerate() {
        if i != usize::MAX { seg[i].push(j as u32); }
    }
    seg
}

fn mean_of(p: &[[f64; 3]], idx: &[u32]) -> [f64; 3] {
    let n = idx.len() as f64;
    let mut m = [0.0f64; 3];
    for &i in idx { for k in 0..3 { m[k] += p[i as usize][k]; } }
    for x in m.iter_mut() { *x /= n; }
    m
}

fn dist3(a: [f64; 3], b: [f64; 3]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

/// Split every edge longer than `dmax` in half, then drop points that
/// ended up closer than a third of it — the resampling both boundary
/// curve routines do after averaging.
fn resample(curve: Vec<[f64; 3]>, dmax: f64) -> Vec<[f64; 3]> {
    let nc = curve.len();
    if nc < 2 { return curve; }
    let mut out: Vec<[f64; 3]> = Vec::with_capacity(nc + nc / 2);
    for i in 0..nc {
        let b = curve[(i + 1) % nc];
        let v = [b[0] - curve[i][0], b[1] - curve[i][1], b[2] - curve[i][2]];
        out.push(curve[i]);
        if v[0] * v[0] + v[1] * v[1] + v[2] * v[2] > dmax * dmax {
            out.push([curve[i][0] + 0.5 * v[0], curve[i][1] + 0.5 * v[1], curve[i][2] + 0.5 * v[2]]);
        }
    }
    let nc = out.len();
    let mut small = vec![false; nc];
    for i in 0..nc {
        let b = out[(i + 1) % nc];
        let d2 = (b[0] - out[i][0]).powi(2) + (b[1] - out[i][1]).powi(2) + (b[2] - out[i][2]).powi(2);
        small[i] = d2 < (0.333 * dmax) * (0.333 * dmax);
    }
    // Never drop two in a row, and never drop the first when the last
    // survives — the reference's own two rules for keeping the curve
    // from collapsing.
    for i in 0..nc.saturating_sub(1) {
        if small[i] && small[i + 1] { small[i + 1] = false; }
    }
    if nc > 1 && !small[nc - 1] && small[0] { small[0] = false; small[nc - 1] = true; }
    let kept: Vec<[f64; 3]> = (0..nc).filter(|&i| !small[i]).map(|i| out[i]).collect();
    if kept.len() < 3 { out } else { kept }
}

/// `boundary_curve2` — the smoothing pass `initial_boundary_curve` ends
/// with: replace each curve point by the mean of the section points
/// nearest it, keeping the old point where the mean would move it more
/// than `1.25*dmax` or where nothing is near.
pub fn boundary_curve2(
    p: &[[f64; 3]], curve0: &[[f64; 3]], rball: f64, dmax: f64,
) -> Vec<[f64; 3]> {
    let nc = curve0.len();
    if nc == 0 || p.is_empty() || rball <= 0.0 || rball.is_nan() { return curve0.to_vec(); }
    let seg = segment_by_seed(p, curve0, rball, 1);
    let filled = seg.iter().filter(|s| !s.is_empty()).count();
    if filled as f64 <= 0.05 * nc as f64 { return curve0.to_vec(); }

    let mut curve: Vec<[f64; 3]> = Vec::with_capacity(nc);
    for i in 0..nc {
        if seg[i].is_empty() { curve.push(curve0[i]); continue; }
        let m = mean_of(p, &seg[i]);
        curve.push(if dist3(m, curve0[i]) > 1.25 * dmax { curve0[i] } else { m });
    }
    resample(curve, dmax)
}

/// How the new curve's points line up with the old one's, which is what
/// tells `curve_based_triangulation` how to stitch the two together.
///
/// `[a, b]` with `b >= 0` means this point spans old points a and b;
/// `NO_SECOND` means it hangs off old point a alone, which is what a
/// point inserted to split a long edge does; `DROPPED` marks where a
/// point was removed for being too close to its neighbour, and the
/// stitching there needs an extra triangle to swallow the old point
/// left over.
///
/// The two markers are separate values and not both zero, which they
/// would be in a naive reading of the reference. MATLAB writes `[i 1]`
/// for the last element — a wrap to the FIRST point, which is index 1
/// there — and `[i+1 0]` for a split, where 0 is "none". One-based
/// indexing keeps those apart; zero-based indexing does not, and
/// collapsing them leaves the closing edge of every boundary curve
/// stitched on one side only. The mesh is then not closed, and the
/// volume the divergence theorem gives for it moves with the plot's
/// coordinates.
pub type CurveLinks = Vec<[i32; 2]>;

/// This curve point hangs off a single point of the previous curve.
pub const NO_SECOND: i32 = -2;
/// A point of the previous curve was dropped here.
pub const DROPPED: i32 = -1;

/// `boundary_curve` — the next cross-section's curve, grown from the
/// previous one.
pub fn boundary_curve(
    p: &[[f64; 3]], curve0: &[[f64; 3]], rball: f64, dmax: f64,
) -> (Vec<[f64; 3]>, CurveLinks) {
    let nc = curve0.len();
    let identity: CurveLinks = (0..nc)
        .map(|i| [i as i32, if i + 1 < nc { i as i32 + 1 } else { 0 }]).collect();
    if nc == 0 || p.is_empty() || rball <= 0.0 || rball.is_nan() { return (curve0.to_vec(), identity); }

    let seg = segment_by_seed(p, curve0, rball, 2);
    let filled = seg.iter().filter(|s| !s.is_empty()).count();
    if filled as f64 <= 0.05 * nc as f64 { return (curve0.to_vec(), identity); }

    let mut curve: Vec<[f64; 3]> = vec![[0.0; 3]; nc];
    let mut empty = vec![false; nc];
    for i in 0..nc {
        if seg[i].is_empty() { empty[i] = true; continue; }
        let m = mean_of(p, &seg[i]);
        curve[i] = if dist3(m, curve0[i]) > 1.25 * dmax { curve0[i] } else { m };
    }

    // Fill the gaps by interpolating between the nearest non-empty
    // neighbours, unless the gap is five points or more, where the
    // seeds are kept instead.
    //
    // FIXED — reference defect 18. The reference walks every index and
    // recomputes the gap from there, without marking the gap it has
    // just filled — so a gap of five, kept as seeds on its first
    // index, is re-examined from its second index as a gap of four and
    // interpolated after all. Every long gap is overwritten except its
    // first point, and the rule that a gap of five or more is too long
    // to interpolate across never takes effect past that point.
    if empty.iter().any(|&e| e) && filled > 0 {
        let mut i = 0usize;
        while i < nc {
            if !empty[i] { i += 1; continue; }
            let mut k = 0usize;
            while i + k < nc && empty[i + k] { k += 1; }
            if i > 0 && i + k < nc {
                let (a, b) = (curve[i - 1], curve[i + k]);
                if k < 5 {
                    for j in 1..=k {
                        let f = j as f64 / (k + 1) as f64;
                        curve[i + j - 1] = [a[0] + f * (b[0] - a[0]),
                                            a[1] + f * (b[1] - a[1]),
                                            a[2] + f * (b[2] - a[2])];
                    }
                } else {
                    curve[i..i + k].copy_from_slice(&curve0[i..i + k]);
                }
            } else {
                // A gap that wraps the ends, or one that runs to the
                // end of the curve: interpolate between the last
                // non-empty before it and the first after it, round the
                // loop.
                let prev = (0..nc).rev().find(|&j| !empty[j]);
                let next = (0..nc).find(|&j| !empty[j]);
                match (prev, next) {
                    (Some(pj), Some(nj)) if k < 5 => {
                        let (a, b) = (curve[pj], curve[nj]);
                        let span = ((nj + nc - pj) % nc).max(1);
                        for j in 0..k {
                            let step = ((i + j + nc - pj) % nc) as f64 / span as f64;
                            curve[i + j] = [a[0] + step * (b[0] - a[0]),
                                            a[1] + step * (b[1] - a[1]),
                                            a[2] + step * (b[2] - a[2])];
                        }
                    }
                    _ => curve[i..i + k].copy_from_slice(&curve0[i..i + k]),
                }
            }
            i += k;
        }
    }

    // One height for the whole curve.
    let zmin = curve.iter().map(|q| q[2]).fold(f64::INFINITY, f64::min);
    for q in curve.iter_mut() { q[2] = zmin; }

    repair_self_intersection(&mut curve, 5);

    // Split long edges, recording for each new point which old points
    // it lies between, then drop points that ended up too close.
    let nc = curve.len();
    let mut out: Vec<[f64; 3]> = Vec::with_capacity(nc + nc / 2);
    let mut ind: CurveLinks = Vec::with_capacity(nc + nc / 2);
    for i in 0..nc {
        let nxt = (i + 1) % nc;
        let v = [curve[nxt][0] - curve[i][0], curve[nxt][1] - curve[i][1],
                 curve[nxt][2] - curve[i][2]];
        out.push(curve[i]);
        ind.push([i as i32, nxt as i32]);
        if v[0] * v[0] + v[1] * v[1] + v[2] * v[2] > dmax * dmax {
            out.push([curve[i][0] + 0.5 * v[0], curve[i][1] + 0.5 * v[1],
                      curve[i][2] + 0.5 * v[2]]);
            ind.push([nxt as i32, NO_SECOND]);
        }
    }
    // See the note on CurveLinks: a split point's "no second" marker
    // and a wrap to point 0 are different values here, because
    // zero-based indexing cannot tell them apart the way MATLAB's
    // one-based indexing does.
    let n2 = out.len();
    let mut small = vec![false; n2];
    for i in 0..n2 {
        let b = out[(i + 1) % n2];
        let d2 = (b[0] - out[i][0]).powi(2) + (b[1] - out[i][1]).powi(2)
            + (b[2] - out[i][2]).powi(2);
        small[i] = d2 < (0.333 * dmax) * (0.333 * dmax);
    }
    if small.iter().any(|&s| s) {
        for i in 0..n2.saturating_sub(1) {
            if !small[i] && small[i + 1] { ind[i][1] = DROPPED; }
            else if small[i] && small[i + 1] { small[i + 1] = false; }
        }
        if n2 > 1 && !small[n2 - 1] && small[0] {
            ind[n2 - 1][1] = DROPPED;
            ind[0][1] = DROPPED;
            small[0] = false;
            small[n2 - 1] = true;
        }
        let keep: Vec<usize> = (0..n2).filter(|&i| !small[i]).collect();
        if keep.len() >= 3 {
            out = keep.iter().map(|&i| out[i]).collect();
            ind = keep.iter().map(|&i| ind[i]).collect();
        }
    }
    (out, ind)
}

/// Perpendicular distance to a line, and how far along it, for each
/// point — the reference's `distances_to_line` restricted to the plane
/// the curve fitting works in.
fn to_line(p: &[[f64; 3]], idx: &[u32], dir: [f64; 3], p0: [f64; 3]) -> Vec<(f64, f64)> {
    let n = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
    if n <= 0.0 || n.is_nan() { return vec![(f64::INFINITY, 0.0); idx.len()]; }
    let u = [dir[0] / n, dir[1] / n, dir[2] / n];
    idx.iter().map(|&i| {
        let q = p[i as usize];
        let a = [q[0] - p0[0], q[1] - p0[1], q[2] - p0[2]];
        let h = a[0] * u[0] + a[1] * u[1] + a[2] * u[2];
        let w = [a[0] - h * u[0], a[1] - h * u[1], a[2] - h * u[2]];
        ((w[0] * w[0] + w[1] * w[1] + w[2] * w[2]).sqrt(), h)
    }).collect()
}

/// The offsets the centre search tries, in place of the reference's
/// `randn`.
///
/// DELIBERATE DEVIATION, and the only one that changes what this
/// subsystem does. The reference moves the centre by
/// `3*ShortestDist*randn(1,2)` until it is at least 7.5 cm from every
/// point of the cross-section, and its callers retry the whole
/// reconstruction up to fifteen times because the search often lands
/// somewhere useless. Two runs over one tree can therefore give two
/// different meshes, or one mesh and no mesh — the reference is not
/// reproducible against itself here.
///
/// This walks a fixed spiral instead: the golden angle between
/// successive attempts, with the radius growing as the square root of
/// the attempt number, so the offsets spread evenly rather than
/// clustering. Attempt 0 is no offset at all, which is what the
/// reference's first iteration does.
fn centre_offset(attempt: usize) -> [f64; 2] {
    if attempt == 0 { return [0.0, 0.0]; }
    const GOLDEN: f64 = 2.399_963_229_728_653; // pi * (3 - sqrt 5)
    let t = attempt as f64 * GOLDEN;
    let r = (attempt as f64).sqrt();
    [r * t.cos(), r * t.sin()]
}

/// `initial_boundary_curve` — the first cross-section's curve, built
/// from nothing but the points.
///
/// `attempt` selects one of the deterministic centre offsets above; the
/// caller walks it up while the curve comes back empty, which is what
/// the reference's retry loop does with fresh random numbers.
pub fn initial_boundary_curve(
    section: &[[f64; 3]], tria_width: f64, attempt: usize,
) -> Vec<[f64; 3]> {
    let np = section.len();
    if np < 18 || tria_width <= 0.0 || tria_width.is_nan() { return Vec::new(); }
    // The reference flattens the section to its top before working.
    let top = section.iter().map(|q| q[2]).fold(f64::NEG_INFINITY, f64::max);
    let p: Vec<[f64; 3]> = section.iter().map(|q| [q[0], q[1], top]).collect();

    let mut c0 = [0.0f64; 2];
    for q in &p { c0[0] += q[0]; c0[1] += q[1]; }
    c0[0] /= np as f64;
    c0[1] /= np as f64;

    // A centre far enough inside the section that every direction from
    // it has points in it. The reference wants the nearest point at
    // least 7.5 cm away and at least 61 of the 72 five-degree sectors
    // occupied; both are relaxed as the search goes on, because on a
    // stem thinner than 15 cm across the first can never be met.
    let mut first_point = usize::MAX;
    let mut shortest = 0.0f64;
    let mut sectors_wanted = 61usize;
    let mut angles: Vec<f64> = Vec::new();
    let mut dists: Vec<f64> = Vec::new();
    for k in 0..400usize {
        let off = centre_offset(attempt + k);
        let scale = 3.0 * if shortest > 0.0 { shortest } else { 0.025 };
        let centre = [c0[0] + scale * off[0], c0[1] + scale * off[1]];
        angles.clear();
        dists.clear();
        let mut seen = [false; 72];
        let mut nearest = (f64::INFINITY, usize::MAX);
        for (i, q) in p.iter().enumerate() {
            let v = [q[0] - centre[0], q[1] - centre[1]];
            let a = 180.0 / std::f64::consts::PI * v[1].atan2(v[0]) + 180.0;
            let d = (v[0] * v[0] + v[1] * v[1]).sqrt();
            let s = ((a / 5.0).ceil() as isize).clamp(1, 72) as usize - 1;
            seen[s] = true;
            if d < nearest.0 { nearest = (d, i); }
            angles.push(a);
            dists.push(d);
        }
        let occupied = seen.iter().filter(|&&s| s).count();
        if occupied >= sectors_wanted && nearest.0 >= 0.075 {
            first_point = nearest.1;
            break;
        }
        // Accept a nearer centre once the sector test has been relaxed
        // far enough that it is no longer asking for anything: a stem
        // 10 cm across cannot have a centre 7.5 cm from every point,
        // and the reference reaches the same place by letting its own
        // threshold run down past zero.
        if sectors_wanted == 0 && occupied > 0 {
            first_point = nearest.1;
            break;
        }
        shortest = nearest.0;
        if k % 25 == 24 { sectors_wanted = sectors_wanted.saturating_sub(2); }
    }
    if first_point == usize::MAX { return Vec::new(); }

    // Turn the angles so the nearest point is at zero, then take the
    // closest point in each of eighteen sectors twenty degrees apart.
    let a0 = angles[first_point];
    for a in angles.iter_mut() { *a = if *a < a0 { *a + 360.0 - a0 } else { *a - a0 }; }
    let mut curve_idx: Vec<u32> = Vec::with_capacity(18);
    for i in 2..=18usize {
        let lo = 12.5 + 20.0 * (i - 2) as f64;
        let hi = 27.5 + 20.0 * (i - 2) as f64;
        let pick = |lo: f64, hi: f64| -> Option<u32> {
            let mut best = (f64::INFINITY, u32::MAX);
            for j in 0..np {
                if angles[j] > lo && angles[j] < hi && dists[j] < best.0 {
                    best = (dists[j], j as u32);
                }
            }
            if best.1 == u32::MAX { None } else { Some(best.1) }
        };
        if let Some(j) = pick(lo, hi).or_else(|| pick(lo - 1.5, hi + 1.5)) {
            curve_idx.push(j);
        }
    }
    if curve_idx.len() < 3 { return Vec::new(); }

    let mut free: Vec<u32> = (0..np as u32).filter(|j| !curve_idx.contains(j)).collect();

    // Fill in the long edges by reaching outward from each edge's
    // midpoint for the nearest point that is not already on the curve.
    // Two passes, as the reference has: one that only splits edges over
    // 1.25 triangle widths, one that goes down to half a width.
    for (round, gate) in [(0usize, 1.25f64), (1, 0.5)] {
        let mut n0 = if round == 0 { 1 } else { curve_idx.len().saturating_sub(1) };
        loop {
            let n = curve_idx.len();
            if n <= n0 || n > 4096 { break; }
            let mut next: Vec<u32> = Vec::with_capacity(n * 2);
            for i in 0..n {
                let a = p[curve_idx[i] as usize];
                let b = p[curve_idx[(i + 1) % n] as usize];
                let v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                let d = (v[0] * v[0] + v[1] * v[1]).sqrt();
                next.push(curve_idx[i]);
                if d <= gate * tria_width || free.is_empty() { continue; }
                // The outward normal of this edge, and its midpoint.
                let nvec = [v[1], -v[0], v[2]];
                let mid = [a[0] + 0.5 * v[0], a[1] + 0.5 * v[1], a[2] + 0.5 * v[2]];
                // Do not reach past another part of the curve.
                let hcurve = to_line(&p, &curve_idx, nvec, mid);
                let h_limit = hcurve.iter()
                    .filter(|&&(dd, hh)| hh > 0.01 && dd < d / 2.0)
                    .map(|&(_, hh)| hh).fold(f64::INFINITY, f64::min);
                let h_limit = if h_limit.is_finite() { h_limit } else { 1.0 };
                let hmin = if round == 0 { -tria_width / 2.0 } else { -tria_width / 3.0 };
                let cand = to_line(&p, &free, nvec, mid);
                let mut best = (f64::INFINITY, usize::MAX);
                for (k, &(dd, hh)) in cand.iter().enumerate() {
                    if dd < d / 3.0 && hh > hmin && hh < h_limit && hh < best.0 {
                        best = (hh, k);
                    }
                }
                if best.1 == usize::MAX { continue; }
                if round == 1 && best.0 <= tria_width / 10.0 { continue; }
                let j = free[best.1];
                free.remove(best.1);
                next.push(j);
            }
            n0 = n;
            curve_idx = next;
        }
    }

    // Smooth, then space the points evenly along the curve.
    let mut curve: Vec<[f64; 3]> = curve_idx.iter().map(|&i| p[i as usize]).collect();
    curve = boundary_curve2(&p, &curve, 0.04, tria_width);
    if curve.len() < 3 { return Vec::new(); }
    curve = equalise(&curve, tria_width);
    if curve.len() < 3 { return Vec::new(); }
    if check_self_intersection(&curve.iter().map(|q| [q[0], q[1]]).collect::<Vec<_>>()).0 {
        return Vec::new();
    }
    curve
}

/// Re-space a closed curve so its points sit an equal distance apart,
/// that distance being the curve's own length divided into whole steps
/// of about `width`.
fn equalise(curve: &[[f64; 3]], width: f64) -> Vec<[f64; 3]> {
    let n = curve.len();
    if n < 3 || width <= 0.0 || width.is_nan() { return curve.to_vec(); }
    // Split anything longer than a width first, as the reference does,
    // so the walk below has somewhere to land.
    let mut dense: Vec<[f64; 3]> = Vec::with_capacity(n * 2);
    for i in 0..n {
        let b = curve[(i + 1) % n];
        let v = [b[0] - curve[i][0], b[1] - curve[i][1], b[2] - curve[i][2]];
        let d = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        dense.push(curve[i]);
        if d > width {
            let m = (d / width).floor() as usize;
            for j in 1..=m {
                let f = j as f64 / (m + 1) as f64;
                dense.push([curve[i][0] + f * v[0], curve[i][1] + f * v[1],
                            curve[i][2] + f * v[2]]);
            }
        }
    }
    let n = dense.len();
    let mut cum = Vec::with_capacity(n);
    let mut total = 0.0;
    let mut seg = Vec::with_capacity(n);
    for i in 0..n {
        let b = dense[(i + 1) % n];
        let v = [b[0] - dense[i][0], b[1] - dense[i][1], b[2] - dense[i][2]];
        let d = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        total += d;
        cum.push(total);
        seg.push((v, d));
    }
    if total <= 0.0 || total.is_nan() { return dense; }
    let m = (total / width).ceil().max(3.0) as usize;
    let step = total / m as f64;
    let mut out: Vec<[f64; 3]> = Vec::with_capacity(m);
    out.push(dense[0]);
    let mut b = 0usize;
    for i in 1..m {
        let target = i as f64 * step;
        while b + 1 < n && cum[b] < target { b += 1; }
        let before = if b == 0 { 0.0 } else { cum[b - 1] };
        let (v, d) = seg[b];
        let a = if d > 0.0 { (target - before) / d } else { 0.0 };
        out.push([dense[b][0] + a * v[0], dense[b][1] + a * v[1], dense[b][2] + a * v[2]]);
    }
    out
}

/// The stem mesh and everything measured from it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Triangulation {
    pub vert: Vec<[f64; 3]>,
    pub facet: Vec<[u32; 3]>,
    /// Litres, the volume the surface encloses.
    pub volume: f64,
    /// Square metres.
    pub side_area: f64,
    pub bottom_area: f64,
    pub top_area: f64,
    pub bottom: f64,
    pub top: f64,
    pub tria_height: f64,
    pub tria_width: f64,
    /// How many trunk cylinders the mesh replaces.
    pub cyl_ind: usize,
}

/// Why a reconstruction gave up, which the reference prints and throws
/// away. Kept because "no triangulation" with no reason is the least
/// useful thing this can report.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriaFailure {
    /// Under the reference's own floor of a thousand stem points.
    TooFewPoints,
    /// The section to be meshed is under a metre of stem.
    SectionTooShort,
    NoFirstCurve,
    EmptyCurve,
    SelfIntersection,
    BottomCurveTooSmall,
    BottomCap,
    TopCap,
    NegativeVolume,
}

/// `curve_based_triangulation` — the stem's butt as a triangle mesh.
///
/// `p` is the stem's own points. The mesh runs from the top of them
/// downward in layers `tria_height` apart, each layer a closed boundary
/// curve whose points are about `tria_width` apart, and the layers are
/// stitched together into a surface which is then capped top and
/// bottom.
pub fn curve_based_triangulation(
    p: &[[f64; 3]], tria_height: f64, tria_width: f64,
) -> Result<Triangulation, TriaFailure> {
    if p.len() < 100 || !(tria_height > 0.0 && tria_width > 0.0) {
        return Err(TriaFailure::NoFirstCurve);
    }
    // Sorted from the top down, as the reference sorts descending.
    let mut pts: Vec<[f64; 3]> = p.to_vec();
    pts.sort_by(|a, b| b[2].total_cmp(&a[2]));
    let np = pts.len();
    // The bottom is the mean of the lowest hundred, not the single
    // lowest point — one stray point below the stem would otherwise set
    // the whole model's floor.
    let tail = np.saturating_sub(101);
    let hbot = pts[tail..].iter().map(|q| q[2]).sum::<f64>() / (np - tail) as f64;
    let htop = pts[0][2];
    if htop <= hbot || htop.is_nan() { return Err(TriaFailure::NoFirstCurve); }
    let mut n_layers = ((htop - hbot) / tria_height).ceil() as usize;

    // ---- The first curve, from the highest cross-section that gives
    // one. The reference tries fifteen times per layer with fresh
    // random numbers; this walks the deterministic offsets instead.
    let mut curve: Vec<[f64; 3]> = Vec::new();
    let mut layer = 0usize;
    let mut pe = 0usize;
    while layer < n_layers / 4 && curve.is_empty() {
        layer += 1;
        let ps = (pe + 1).min(np);
        let floor = htop - layer as f64 * tria_height;
        let mut k = ps;
        while k < np && pts[k][2] > floor { k += 1; }
        pe = k.saturating_sub(1);
        if pe <= ps { continue; }
        let section = &pts[ps..=pe.min(np - 1)];
        for attempt in 0..16usize {
            curve = initial_boundary_curve(section, tria_width, attempt);
            if !curve.is_empty() { break; }
        }
    }
    if curve.is_empty() { return Err(TriaFailure::NoFirstCurve); }
    let zmax = curve.iter().map(|q| q[2]).fold(f64::NEG_INFINITY, f64::max);
    for q in curve.iter_mut() { q[2] = zmax; }

    let mut vert: Vec<[f64; 3]> = curve.clone();
    let mut vert_layer: Vec<usize> = vec![layer; curve.len()];
    let mut tria: Vec<[u32; 3]> = Vec::new();
    let first_layer = layer;
    let mut m00 = curve.len();
    let mut height = tria_height;

    // ---- Downward, one layer at a time.
    let mut nv0 = 0usize;             // index of the previous curve's first vertex
    let mut prev_len = curve.len();   // and how many points it has
    let mut nv1;                      // index of this curve's first vertex
    layer = first_layer + 1;
    let mut layer_bottom = htop - layer as f64 * height;
    while layer <= n_layers && pe + 1 < np && vert.len() < 400_000 {
        let ps = pe + 1;
        let mut k = ps;
        while k < np && pts[k][2] > layer_bottom { k += 1; }
        pe = k.saturating_sub(1);
        let section: Vec<[f64; 3]> = if pe >= ps { pts[ps..=pe.min(np - 1)].to_vec() } else { Vec::new() };

        for q in curve.iter_mut() { q[2] -= height; }
        let curve0 = curve.clone();

        let (mut newc, ind) = boundary_curve(&section, &curve0, 2.0 * tria_width, 1.5 * tria_width);
        if newc.len() < 3 { return Err(TriaFailure::EmptyCurve); }
        let zmax = newc.iter().map(|q| q[2]).fold(f64::NEG_INFINITY, f64::max);
        for q in newc.iter_mut() { q[2] = zmax; }

        // NOT REACHED BY ANY FIXTURE HERE, and said so rather than
        // left to be assumed: the synthetic stems this is tested on
        // never produce a boundary curve that crosses itself, so the
        // extrapolation below runs only on real data. The repair and
        // the crossing test it uses have tests of their own.
        if repair_self_intersection(&mut newc, 10) {
            // The reference extrapolates the previous curve to the
            // bottom when the crossing is low enough, and gives up when
            // it is not.
            let h = curve0[0][2] - hbot;
            if h > 0.75 { return Err(TriaFailure::SelfIntersection); }
            let m = curve0.len();
            let straight: CurveLinks = (0..m)
                .map(|i| [i as i32, if i + 1 < m { i as i32 + 1 } else { 0 }]).collect();
            let nadd = ((h / height).floor().max(0.0) as usize) + 1;
            let t = h / nadd as f64;
            let mut c = curve0.clone();
            for q in c.iter_mut() { q[2] -= height; }
            for step in 0..nadd {
                if step > 0 { for q in c.iter_mut() { q[2] -= t; } }
                nv1 = vert.len();
                vert.extend_from_slice(&c);
                vert_layer.extend(std::iter::repeat(layer).take(m));
                stitch(&mut tria, &straight, nv0, prev_len, nv1, m);
                nv0 = nv1;
                prev_len = m;
                layer += 1;
            }
            break;
        }

        // Stop when the curve has stopped changing: more than seven in
        // ten of its points came back exactly as their seeds, which
        // means the section under it held almost nothing.
        let same = newc.iter().filter(|q| curve0.iter().any(|s| s == *q)).count();
        if same as f64 > 0.7 * newc.len() as f64 { n_layers = layer; }
        // A curve that has grown three times its original length is
        // following a buttress spreading faster than the layer height
        // can track; halve the height.
        if newc.len() > 3 * m00 {
            height /= 2.0;
            n_layers += (n_layers.saturating_sub(layer)).div_ceil(2);
            m00 = newc.len();
        }

        nv1 = vert.len();
        vert.extend_from_slice(&newc);
        vert_layer.extend(std::iter::repeat(layer).take(newc.len()));
        stitch(&mut tria, &ind, nv0, prev_len, nv1, newc.len());
        nv0 = nv1;
        prev_len = newc.len();
        curve = newc;
        layer += 1;
        layer_bottom -= height;
    }
    if tria.is_empty() { return Err(TriaFailure::EmptyCurve); }

    // ---- Make the side normals point outward. The reference decides
    // from the top tenth of the triangles and flips them all together.
    orient_outward(&mut tria, &vert);

    // ---- Cap the bottom and the top.
    let bottom_layer = *vert_layer.iter().max().unwrap_or(&0);
    let bottom_idx: Vec<usize> = (0..vert.len()).filter(|&i| vert_layer[i] == bottom_layer).collect();
    if bottom_idx.len() < 10 { return Err(TriaFailure::BottomCurveTooSmall); }
    for &i in &bottom_idx { vert[i][2] = hbot; }
    let (bottom_tri, bottom_area) = cap(&vert, &bottom_idx, false)
        .ok_or(TriaFailure::BottomCap)?;

    let top_layer = *vert_layer.iter().min().unwrap_or(&0);
    let top_idx: Vec<usize> = (0..vert.len()).filter(|&i| vert_layer[i] == top_layer).collect();
    let (top_tri, top_area) = cap(&vert, &top_idx, true).ok_or(TriaFailure::TopCap)?;

    // ---- Areas and the volume, by the divergence theorem.
    //
    // FIXED — reference defect 19. The reference picks the side
    // triangles out with `TriaLay <= max(VertLay) & TriaLay > 1`, which
    // works only when the first boundary curve was found in layer 1.
    // When it was not — the reference tries the top quarter of the
    // stem's layers until one gives a curve — the TOP CAP's own layer
    // index passes that test as well, so the cap is counted as side
    // area AND as top area, and its contribution enters the volume
    // twice. Here the caps are known by construction and the side is
    // what is left.
    let side_area: f64 = tria.iter().map(|&t| tri_area(&vert, t)).sum();
    let mut volume = 0.0f64;
    for &t in &tria { volume += tri_flux(&vert, t); }
    for &t in &bottom_tri { volume += tri_flux(&vert, t); }
    for &t in &top_tri { volume += tri_flux(&vert, t); }
    volume /= 3.0;
    // Litres, to a tenth, as the reference rounds it.
    let volume = (10_000.0 * volume).round() / 10.0;
    if volume < 0.0 { return Err(TriaFailure::NegativeVolume); }

    tria.extend_from_slice(&bottom_tri);
    tria.extend_from_slice(&top_tri);

    Ok(Triangulation {
        bottom: vert.iter().map(|q| q[2]).fold(f64::INFINITY, f64::min),
        top: vert.iter().map(|q| q[2]).fold(f64::NEG_INFINITY, f64::max),
        vert,
        facet: tria,
        volume,
        side_area,
        bottom_area,
        top_area,
        tria_height,
        tria_width,
        cyl_ind: 0,
    })
}

/// Stitch one boundary curve to the one above it, following the links
/// `boundary_curve` recorded.
///
/// `nv0` is where the previous curve's vertices start and `m0` how many
/// there are; `nv1` and `m` the same for this one. A link of `[a, b]`
/// with `b > 0` spans two of the previous curve's points, `b == 0`
/// hangs off one, and `b == -1` marks where a point was dropped for
/// being too close to its neighbour — there the previous curve has one
/// more point than this one to account for, and the reference emits an
/// extra triangle to swallow it. Its first element is a special case
/// with five triangles, which closes the ring at the seam.
///
/// The reference's index arithmetic into the previous curve —
/// `nv0+Ind(j,1)+1` and `+2` — does not wrap, so it can walk off the
/// end of that curve. Here it wraps, which is what the ring it is
/// walking round means.
fn stitch(
    tria: &mut Vec<[u32; 3]>, ind: &CurveLinks,
    nv0: usize, m0: usize, nv1: usize, m: usize,
) {
    if m == 0 || m0 == 0 { return; }
    let old = |k: i32| -> u32 { (nv0 + (k.rem_euclid(m0 as i32)) as usize) as u32 };
    let new = |k: usize| -> u32 { (nv1 + k % m) as u32 };
    let mut pass = false;
    for (j, link) in ind.iter().enumerate().take(m) {
        let (i0, i1) = (link[0], link[1]);
        let a = new(j);
        let nxt = new(j + 1);
        let last = j + 1 == m;
        if i1 >= 0 && !last {
            tria.push([a, old(i0), old(i1)]);
            tria.push([a, old(i1), nxt]);
        } else if i1 >= 0 && !pass {
            tria.push([a, old(i0), old(i1)]);
            tria.push([a, old(i1), new(0)]);
        } else if i1 == NO_SECOND && !last {
            tria.push([a, old(i0), nxt]);
        } else if i1 == NO_SECOND && !pass {
            tria.push([a, old(i0), new(0)]);
        } else if j == 0 && i1 == DROPPED {
            tria.push([new(m - 1), (nv1 as u32).wrapping_sub(1), old(0)]);
            tria.push([new(m - 1), old(0), new(0)]);
            tria.push([old(0), old(1), new(0)]);
            tria.push([new(0), old(1), old(2)]);
            tria.push([new(0), old(2), new(1)]);
            pass = true;
        } else if i1 == DROPPED && !last {
            tria.push([a, old(i0), old(i0 + 1)]);
            tria.push([a, old(i0 + 1), nxt]);
            tria.push([old(i0 + 1), old(i0 + 2), nxt]);
        } else if i1 == DROPPED && !pass {
            tria.push([a, old(i0), old(i0 + 1)]);
            tria.push([a, old(i0 + 1), new(0)]);
            tria.push([old(i0 + 1), old(0), new(0)]);
        }
    }
}

fn tri_area(v: &[[f64; 3]], t: [u32; 3]) -> f64 {
    let (a, b, c) = (v[t[0] as usize], v[t[1] as usize], v[t[2] as usize]);
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
}

/// One triangle's contribution to the integral of `x . n` over the
/// surface, which summed over a closed one and divided by three is the
/// volume it encloses.
///
/// Any point of the triangle's own plane gives the same dot product,
/// because the offsets from a vertex lie in the plane and the normal is
/// perpendicular to them — which is why the reference's quarter-way
/// point works as well as the centroid does.
fn tri_flux(v: &[[f64; 3]], t: [u32; 3]) -> f64 {
    let (a, b, c) = (v[t[0] as usize], v[t[1] as usize], v[t[2] as usize]);
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    0.5 * (a[0] * n[0] + a[1] * n[1] + a[2] * n[2])
}

/// Flip every side triangle when most of the top ones face inward.
fn orient_outward(tria: &mut [[u32; 3]], vert: &[[f64; 3]]) {
    let t = tria.len();
    if t == 0 || vert.is_empty() { return; }
    let a = (t as f64 / 10.0).round().max(1.0) as usize;
    let mut centre = [0.0f64; 2];
    for q in vert { centre[0] += q[0]; centre[1] += q[1]; }
    centre[0] /= vert.len() as f64;
    centre[1] /= vert.len() as f64;
    let mut inward = 0usize;
    for tr in tria.iter().take(a) {
        let (p0, p1, p2) = (vert[tr[0] as usize], vert[tr[1] as usize], vert[tr[2] as usize]);
        let u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        let w = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2]];
        let c = [p0[0] + 0.25 * (u[0] + w[0]), p0[1] + 0.25 * (u[1] + w[1])];
        let out = [c[0] - centre[0], c[1] - centre[1]];
        if n[0] * out[0] + n[1] * out[1] < 0.0 { inward += 1; }
    }
    if inward as f64 > 0.5 * a as f64 {
        for tr in tria.iter_mut() { tr.swap(0, 1); }
    }
}

/// Fill a boundary curve with triangles facing up or down, and report
/// their total area. `None` when the curve crosses itself, which is the
/// case the reference catches by comparing the triangles' area against
/// `polyarea`.
fn cap(vert: &[[f64; 3]], idx: &[usize], up: bool) -> Option<(Vec<[u32; 3]>, f64)> {
    if idx.len() < 3 { return None; }
    let poly: Vec<[f64; 2]> = idx.iter().map(|&i| [vert[i][0], vert[i][1]]).collect();
    let tris = geom::ear_clip(&poly);
    if tris.is_empty() { return None; }
    let want = geom::polygon_signed_area(&poly).abs();
    let got: f64 = tris.iter()
        .map(|t| geom::polygon_signed_area(&[poly[t[0]], poly[t[1]], poly[t[2]]]).abs()).sum();
    // The reference needs this check because `delaunayTriangulation`
    // can INSERT points where the constraints cross, and then the
    // triangles it keeps do not tile the polygon. Ear clipping cannot
    // insert anything — it either tiles the polygon exactly or returns
    // nothing at all — so this can no longer fail, and it stays as a
    // guard on the clipping rather than on the input.
    if (got - want).abs() > 0.001 * got.max(1e-12) { return None; }
    let mut out = Vec::with_capacity(tris.len());
    for t in &tris {
        let (a, b, c) = (idx[t[0]] as u32, idx[t[1]] as u32, idx[t[2]] as u32);
        // Orient so the cap's normal points out of the solid: up at the
        // top, down at the bottom.
        let facing_up = geom::polygon_signed_area(&[poly[t[0]], poly[t[1]], poly[t[2]]]) > 0.0;
        if facing_up == up { out.push([a, b, c]); } else { out.push([a, c, b]); }
    }
    Some((out, got))
}


#[cfg(test)]
mod tests {
    use super::*;

    /// A stem whose cross-section is an ellipse of semi-axes `a` and
    /// `b` at the bottom, scaled by `taper` at the top, sampled on its
    /// surface: rings every `dz`, `n` points to a ring. With `a == b`
    /// and `taper == 1` it is a cylinder.
    fn stem(a: f64, b: f64, h: f64, taper: f64, n: usize, dz: f64) -> Vec<[f64; 3]> {
        let mut p = Vec::new();
        let mut z = 0.0f64;
        while z <= h + 1e-9 {
            let s = 1.0 + (taper - 1.0) * z / h;
            for k in 0..n {
                let t = k as f64 / n as f64 * std::f64::consts::TAU;
                p.push([a * s * t.cos(), b * s * t.sin(), z]);
            }
            z += dz;
        }
        p
    }

    /// THE VOLUME OF A STEM WHOSE VOLUME IS KNOWN. A right cylinder of
    /// radius 0.20 over 1.5 m holds pi*r^2*h; the mesh's boundary
    /// curves are inscribed polygons, so it reads slightly under, and
    /// by less as the triangles get smaller. That convergence is the
    /// property — a fixed offset would be a bias, a shrinking one is
    /// discretisation.
    #[test]
    fn a_cylinder_triangulates_to_its_own_volume() {
        let p = stem(0.20, 0.20, 1.5, 1.0, 200, 0.005);
        let truth = 1000.0 * std::f64::consts::PI * 0.04 * 1.5;   // litres

        let coarse = curve_based_triangulation(&p, 0.05, 0.05).expect("a mesh");
        let fine = curve_based_triangulation(&p, 0.03, 0.03).expect("a mesh");
        for t in [&coarse, &fine] {
            assert!(t.volume < truth, "an inscribed mesh cannot exceed the solid");
            assert!((truth - t.volume) / truth < 0.05,
                "volume {:.2} L against {truth:.2}", t.volume);
            assert!((t.bottom - 0.0).abs() < 1e-9 && (t.top - 1.5).abs() < 1e-9,
                "the mesh spans {:.3} to {:.3}", t.bottom, t.top);
        }
        assert!(truth - fine.volume < truth - coarse.volume,
            "finer triangles must read closer: {:.2} then {:.2}", coarse.volume, fine.volume);

        // The caps are the cross-section and the side is the skin.
        let area = std::f64::consts::PI * 0.04;
        assert!((fine.bottom_area - area).abs() / area < 0.03,
            "bottom {:.4} against {area:.4}", fine.bottom_area);
        assert!((fine.top_area - area).abs() / area < 0.03);
        let skin = 2.0 * std::f64::consts::PI * 0.20 * 1.5;
        assert!((fine.side_area - skin).abs() / skin < 0.05,
            "side {:.4} against {skin:.4}", fine.side_area);
    }

    /// A STEM THAT IS NOT ROUND IS THE REASON THIS EXISTS. An ellipse
    /// twice as wide as it is deep holds pi*a*b*h, and no circle fitted
    /// to it holds that: the best circle by area has radius
    /// sqrt(a*b) = 0.212, and a fit to the points would land somewhere
    /// between 0.15 and 0.30 with no way to tell which.
    #[test]
    fn an_elliptical_stem_is_measured_as_an_ellipse() {
        let p = stem(0.30, 0.15, 1.5, 1.0, 200, 0.005);
        let t = curve_based_triangulation(&p, 0.03, 0.03).expect("a mesh");
        let truth = 1000.0 * std::f64::consts::PI * 0.30 * 0.15 * 1.5;
        assert!((truth - t.volume) / truth < 0.05,
            "volume {:.2} L against {truth:.2}", t.volume);

        // A cylinder of the mean of the two axes — the answer a fit
        // that split the difference would give — is 25 % out.
        let mean_axis = 1000.0 * std::f64::consts::PI * 0.225 * 0.225 * 1.5;
        assert!((mean_axis - truth).abs() / truth > 0.10,
            "the fixture has to be able to tell them apart");
        assert!((t.volume - truth).abs() < (t.volume - mean_axis).abs(),
            "the mesh reads the ellipse, not a circle: {:.1} L", t.volume);
    }

    /// A TAPERING STEM MAKES THE CURVE CHANGE EVERY LAYER, which is
    /// the path a straight prism never takes: each boundary curve has
    /// to grow out of the one above it rather than copy it.
    #[test]
    fn a_tapering_stem_is_tracked_layer_by_layer() {
        // A cone frustum from r = 0.25 at the bottom to 0.125 at 1.5 m.
        let p = stem(0.25, 0.25, 1.5, 0.5, 200, 0.005);
        let t = curve_based_triangulation(&p, 0.04, 0.04).expect("a mesh");
        let pi = std::f64::consts::PI;
        let truth = 1000.0 * pi / 3.0 * 1.5 * (0.25 * 0.25 + 0.25 * 0.125 + 0.125 * 0.125);
        assert!((truth - t.volume) / truth < 0.06,
            "volume {:.2} L against {truth:.2}", t.volume);
        // The bottom cap is wider than the top one, by the taper.
        assert!(t.bottom_area > 3.0 * t.top_area,
            "bottom {:.4} against top {:.4}", t.bottom_area, t.top_area);
        // And the mesh really is layered rather than two curves joined.
        let layers: std::collections::BTreeSet<i64> =
            t.vert.iter().map(|q| (q[2] * 1000.0).round() as i64).collect();
        assert!(layers.len() > 8, "{} distinct heights", layers.len());
    }

    /// THE MESH IS CLOSED, which is the condition the volume rests on
    /// and the one nothing else here would notice was missing.
    ///
    /// The volume comes from the divergence theorem, `3V = integral of
    /// x . n over the surface`, and that identity holds only for a
    /// surface with no holes and every normal consistently outward. On
    /// a closed surface the areas weighted by their normals cancel
    /// exactly, and every edge is walked once in each direction; on one
    /// with a hole, neither is true and the volume quietly depends on
    /// where the tree stands.
    ///
    /// This is what caught the port's own worst bug. MATLAB writes
    /// `[i 1]` for a boundary curve's last element — a wrap to the
    /// FIRST point, index 1 — and `[i+1 0]` for a point inserted to
    /// split a long edge, where 0 means "none". One-based indexing
    /// keeps those apart and zero-based indexing does not, and with
    /// both read as zero the closing edge of every layer was stitched
    /// on one side only. Fifty-one of seventeen hundred edges were
    /// open, the volume of a stem at the origin read 185 litres, and
    /// the same stem five hundred metres east read 4657.
    #[test]
    fn the_mesh_has_no_holes_and_no_inverted_faces() {
        for (a, b, taper) in [(0.20, 0.20, 1.0), (0.30, 0.15, 1.0), (0.25, 0.25, 0.5)] {
            let p = stem(a, b, 1.5, taper, 200, 0.005);
            let t = curve_based_triangulation(&p, 0.04, 0.04).expect("a mesh");

            // The areas weighted by their normals cancel.
            let mut sum = [0.0f64; 3];
            let mut area = 0.0f64;
            for f in &t.facet {
                let (x, y, z) = (t.vert[f[0] as usize], t.vert[f[1] as usize], t.vert[f[2] as usize]);
                let u = [y[0] - x[0], y[1] - x[1], y[2] - x[2]];
                let w = [z[0] - x[0], z[1] - x[1], z[2] - x[2]];
                let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2],
                         u[0] * w[1] - u[1] * w[0]];
                for k in 0..3 { sum[k] += 0.5 * n[k]; }
                area += 0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            }
            let residual = (sum[0] * sum[0] + sum[1] * sum[1] + sum[2] * sum[2]).sqrt();
            assert!(residual < 1e-9 * area.max(1.0),
                "the normals do not cancel: {sum:?} over {area:.4} m2 of surface");

            // Every edge is used once each way.
            let mut edges: std::collections::HashMap<(u32, u32), i32> =
                std::collections::HashMap::new();
            for f in &t.facet {
                for &(x, y) in &[(f[0], f[1]), (f[1], f[2]), (f[2], f[0])] {
                    *edges.entry((x.min(y), x.max(y))).or_insert(0) += if x < y { 1 } else { -1 };
                }
            }
            let open = edges.values().filter(|&&v| v != 0).count();
            assert_eq!(open, 0, "{open} of {} edges are open", edges.len());
        }
    }

    /// THE VOLUME DOES NOT DEPEND ON WHERE THE TREE STANDS. The
    /// divergence theorem integrates `x . n` over the whole surface, so
    /// it only comes out right if the surface is CLOSED and every
    /// face's normal points outward: leave off a cap, or point one the
    /// wrong way, and the answer starts moving with the elevation of
    /// the plot. That is invisible on a fixture whose base sits at
    /// zero, where the bottom cap's contribution is zero either way.
    #[test]
    fn the_volume_is_the_same_wherever_the_stem_stands() {
        let low = stem(0.20, 0.20, 1.5, 1.0, 200, 0.005);
        let high: Vec<[f64; 3]> = low.iter().map(|q| [q[0], q[1], q[2] + 100.0]).collect();
        let a = curve_based_triangulation(&low, 0.04, 0.04).expect("a mesh");
        let b = curve_based_triangulation(&high, 0.04, 0.04).expect("a mesh");
        // A tenth of a per cent, not nothing: the layer boundaries fall
        // between different points of the cloud at the two elevations,
        // so the curves differ slightly and so does the mesh. A missing
        // or inverted cap is not a tenth of a per cent — the bottom
        // cap of this stem at 100 m carries 4000 litres of flux.
        assert!((a.volume - b.volume).abs() / a.volume < 0.005,
            "at 0 m it reads {:.2} L and at 100 m {:.2} L", a.volume, b.volume);
        for (x, y, what) in [(a.side_area, b.side_area, "side"),
                             (a.bottom_area, b.bottom_area, "bottom"),
                             (a.top_area, b.top_area, "top")] {
            assert!((x - y).abs() / x < 0.005, "{what} area {x:.4} against {y:.4}");
        }
        // Moved sideways as well, so a missing cap cannot hide.
        let east: Vec<[f64; 3]> = low.iter().map(|q| [q[0] + 500.0, q[1] - 300.0, q[2]]).collect();
        let c = curve_based_triangulation(&east, 0.04, 0.04).expect("a mesh");
        assert!((a.volume - c.volume).abs() / a.volume < 0.005,
            "moved sideways it reads {:.2} L", c.volume);
    }

    /// THE FLOOR IS THE STEM'S, NOT ONE STRAY POINT'S. The reference
    /// takes the mean of the lowest hundred heights for exactly this:
    /// a single point under the tree would otherwise drag the whole
    /// model's bottom down with it and inflate the volume.
    #[test]
    fn one_point_below_the_stem_does_not_become_the_floor() {
        let clean = stem(0.20, 0.20, 1.5, 1.0, 200, 0.005);
        let mut strays = clean.clone();
        strays.push([0.01, 0.01, -0.6]);
        let a = curve_based_triangulation(&clean, 0.04, 0.04).expect("a mesh");
        let b = curve_based_triangulation(&strays, 0.04, 0.04).expect("a mesh");
        assert!((a.bottom - b.bottom).abs() < 0.01,
            "one stray point moved the floor from {:.3} to {:.3}", a.bottom, b.bottom);
        assert!((a.volume - b.volume).abs() / a.volume < 0.02,
            "and the volume from {:.2} to {:.2}", a.volume, b.volume);
    }

    /// THE FIRST CURVE IS EVENLY SPACED, which is what the layers
    /// below it are grown from — an uneven first curve puts long thin
    /// triangles all the way down the stem.
    #[test]
    fn the_first_curve_comes_back_evenly_spaced() {
        // A cross-section with the points bunched on one side, so an
        // unequalised curve would be bunched too.
        let mut section: Vec<[f64; 3]> = Vec::new();
        for i in 0..900 {
            let f = (i as f64 / 900.0).powi(2);
            let t = f * std::f64::consts::TAU;
            section.push([0.25 * t.cos(), 0.25 * t.sin(), 1.0 + (i % 3) as f64 * 0.001]);
        }
        let curve = initial_boundary_curve(&section, 0.05, 0);
        assert!(curve.len() >= 8, "{} points", curve.len());
        let n = curve.len();
        let d: Vec<f64> = (0..n).map(|i| {
            let b = curve[(i + 1) % n];
            ((b[0] - curve[i][0]).powi(2) + (b[1] - curve[i][1]).powi(2)).sqrt()
        }).collect();
        let mean = d.iter().sum::<f64>() / n as f64;
        let worst = d.iter().cloned().fold(0.0f64, f64::max);
        let shortest = d.iter().cloned().fold(f64::INFINITY, f64::min);
        assert!(worst < 1.35 * mean && shortest > 0.65 * mean,
            "steps run {shortest:.4} to {worst:.4} against a mean of {mean:.4}");
        // And it is the same curve every time, which the reference's
        // random centre cannot promise.
        assert_eq!(curve, initial_boundary_curve(&section, 0.05, 0));
    }

    /// A CURVE POINT DOES NOT JUMP TO A DISTANT CLUSTER. The mean of
    /// whatever fell in a seed's ball can sit far from the seed when
    /// the ball is wider than the spacing along the curve, and the
    /// reference keeps the seed rather than let the curve lurch.
    #[test]
    fn a_seed_whose_points_are_far_away_keeps_its_place() {
        let n = 40;
        let seeds: Vec<[f64; 3]> = (0..n).map(|i| {
            let t = i as f64 / n as f64 * std::f64::consts::TAU;
            [0.3 * t.cos(), 0.3 * t.sin(), 1.0]
        }).collect();
        // Points on the ring under every seed.
        let mut section: Vec<[f64; 3]> = Vec::new();
        for i in 0..n {
            let t = i as f64 / n as f64 * std::f64::consts::TAU;
            for k in 0..30 {
                let s = t + (k as f64 - 15.0) * 2e-4;
                section.push([0.3 * s.cos(), 0.3 * s.sin(), 0.98]);
            }
        }
        // A dense cluster 9.5 cm straight out from seed 7 — inside its
        // 10 cm ball, so the mean of what falls in that ball lands on
        // the cluster, and far past the 5 cm the guard allows.
        let t7 = 7.0 / n as f64 * std::f64::consts::TAU;
        for k in 0..600 {
            let j = (k % 20) as f64 * 1e-4;
            section.push([(0.3 + 0.095 + j) * t7.cos(), (0.3 + 0.095 + j) * t7.sin(), 0.98]);
        }
        let (curve, _) = boundary_curve(&section, &seeds, 0.10, 0.04);
        for (i, q) in curve.iter().enumerate() {
            let r = (q[0] * q[0] + q[1] * q[1]).sqrt();
            assert!(r < 0.33, "point {i} lurched out to r = {r:.4}");
        }
        // And with the cluster gone the curve does follow the points,
        // so the guard is not simply pinning everything in place.
        let plain: Vec<[f64; 3]> = section.iter().copied()
            .filter(|q| (q[0] * q[0] + q[1] * q[1]).sqrt() < 0.35).collect();
        let (moved, _) = boundary_curve(&plain, &seeds, 0.10, 0.04);
        assert!(moved.iter().all(|q| (q[2] - 0.98).abs() < 1e-9),
            "the curve came down to the section");
    }

    /// A CROSSING CURVE IS PUSHED APART OR REPORTED, never quietly
    /// used: a self-crossing boundary curve turns into a mesh that
    /// folds through itself and a volume that means nothing.
    #[test]
    fn a_crossing_curve_is_repaired_or_reported() {
        // A figure of eight: the repair pulls the crossing elements
        // back until they no longer meet, which on this one collapses
        // the curve — and that is fine, because a collapsed curve
        // fails the checks that follow. What must not happen is a
        // crossing curve being passed on as if it were sound.
        let mut eight = vec![[0.0, 0.0, 1.0], [1.0, 0.0, 1.0],
                             [0.0, 1.0, 1.0], [1.0, 1.0, 1.0]];
        let still = repair_self_intersection(&mut eight, 10);
        let flat: Vec<[f64; 2]> = eight.iter().map(|q| [q[0], q[1]]).collect();
        assert_eq!(still, check_self_intersection(&flat).0,
            "the repair's answer has to be the truth about the curve it leaves");
        assert!(!still, "and this one comes apart: {eight:?}");

        // A convex ring is not touched.
        let mut ring: Vec<[f64; 3]> = (0..20).map(|i| {
            let t = i as f64 / 20.0 * std::f64::consts::TAU;
            [t.cos(), t.sin(), 2.0]
        }).collect();
        let before = ring.clone();
        assert!(!repair_self_intersection(&mut ring, 10));
        assert_eq!(ring, before, "a curve that does not cross is left alone");
    }

    /// WHERE AN ELEMENT CROSSES TWICE, THE NEARER CROSSING IS THE ONE
    /// REPORTED — the repair shortens the element to just short of the
    /// first thing it hits, and the further crossing would leave it
    /// still crossing the nearer one.
    #[test]
    fn the_nearest_crossing_along_an_element_is_the_one_reported() {
        // A five-pointed star: every edge crosses two others.
        let star: Vec<[f64; 2]> = (0..5).map(|i| {
            let t = (i as f64 * 2.0) / 5.0 * std::f64::consts::TAU + std::f64::consts::FRAC_PI_2;
            [t.cos(), t.sin()]
        }).collect();
        let (hit, cross) = check_self_intersection(&star);
        assert!(hit, "a star crosses itself");
        assert_eq!(cross.iter().filter(|c| c.is_some()).count(), 5,
            "every edge of a star crosses something");
        // Each edge runs between two points of the star, length
        // 2*sin(2*pi/5) = 1.902, and meets the near crossing at
        // 1/(1+phi) of the way along, phi being the golden ratio.
        let edge = 2.0 * (std::f64::consts::TAU / 5.0).sin();
        let phi = (1.0 + 5.0f64.sqrt()) / 2.0;
        let near = edge / (1.0 + phi);
        for (i, c) in cross.iter().enumerate() {
            let x = c.expect("every edge crosses");
            assert!((x - near).abs() < 1e-9,
                "edge {i} reports {x:.6}, the near crossing is at {near:.6} \
                 and the far one at {:.6}", edge - near);
        }
    }

    /// NOTHING IS RETURNED WHEN NOTHING CAN BE BUILT, and the reason
    /// comes back with it.
    #[test]
    fn a_reconstruction_that_cannot_run_says_why() {
        assert_eq!(curve_based_triangulation(&[], 0.05, 0.05), Err(TriaFailure::NoFirstCurve));
        let p = stem(0.20, 0.20, 1.5, 1.0, 200, 0.005);
        assert_eq!(curve_based_triangulation(&p, 0.0, 0.05), Err(TriaFailure::NoFirstCurve));
        assert_eq!(curve_based_triangulation(&p, 0.05, -1.0), Err(TriaFailure::NoFirstCurve));
        // A flat sheet has no height to layer.
        let flat: Vec<[f64; 3]> = (0..500).map(|i| {
            let t = i as f64 / 500.0 * std::f64::consts::TAU * 7.0;
            [t.cos(), t.sin(), 0.0]
        }).collect();
        assert!(curve_based_triangulation(&flat, 0.05, 0.05).is_err());
    }

    /// A CURVE CROSSES ITSELF OR IT DOES NOT, and where it does the
    /// distance along each element to the crossing comes back with it.
    #[test]
    fn self_intersection_is_found_and_measured() {
        let square = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        assert!(!check_self_intersection(&square).0, "a square does not cross itself");
        let ring: Vec<[f64; 2]> = (0..24).map(|i| {
            let t = i as f64 / 24.0 * std::f64::consts::TAU;
            [t.cos(), t.sin()]
        }).collect();
        assert!(!check_self_intersection(&ring).0);

        // A figure of eight: swap two opposite vertices of the square.
        let eight = [[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]];
        let (hit, cross) = check_self_intersection(&eight);
        assert!(hit, "a figure of eight crosses itself");
        assert!(cross.iter().filter(|c| c.is_some()).count() >= 2,
            "both crossing elements are named");
        // Element 1 runs from (1,0) to (0,1) and element 3 from (1,1)
        // to (0,0); they cross at (0.5, 0.5), which is halfway along
        // each — a length of sqrt(2)/2.
        let half = 2.0f64.sqrt() / 2.0;
        assert!((cross[1].unwrap() - half).abs() < 1e-9, "{:?}", cross[1]);
        assert!((cross[3].unwrap() - half).abs() < 1e-9, "{:?}", cross[3]);

        // Too few points to cross anything.
        assert!(!check_self_intersection(&[[0.0, 0.0], [1.0, 0.0], [0.0, 1.0]]).0);
        assert!(!check_self_intersection(&[]).0);
    }

    /// THE CURVE IS RE-SPACED EVENLY, which is what makes the layers
    /// stitch into triangles of a usable shape.
    #[test]
    fn a_curve_is_respaced_to_an_even_step() {
        // A ring whose points are bunched on one side.
        let curve: Vec<[f64; 3]> = (0..24).map(|i| {
            let f = (i as f64 / 24.0).powi(2);
            let t = f * std::f64::consts::TAU;
            [t.cos(), t.sin(), 3.0]
        }).collect();
        let out = equalise(&curve, 0.25);
        assert!(out.len() >= 3);
        let n = out.len();
        let d: Vec<f64> = (0..n).map(|i| {
            let b = out[(i + 1) % n];
            ((b[0] - out[i][0]).powi(2) + (b[1] - out[i][1]).powi(2)).sqrt()
        }).collect();
        let mean = d.iter().sum::<f64>() / n as f64;
        for (i, &x) in d.iter().enumerate() {
            assert!((x - mean).abs() < 0.35 * mean,
                "step {i} is {x:.4} against a mean of {mean:.4}");
        }
        assert!((mean - 0.25).abs() < 0.10, "the step is about the width: {mean:.4}");
        // The height is untouched.
        for q in &out { assert!((q[2] - 3.0).abs() < 1e-12); }
    }

    /// THE NEXT CURVE GROWS OUT OF THE ONE ABOVE IT: given a ring of
    /// seeds and a cross-section of the same ring, the curve comes back
    /// as that ring.
    #[test]
    fn a_boundary_curve_follows_its_seeds() {
        let seeds: Vec<[f64; 3]> = (0..32).map(|i| {
            let t = i as f64 / 32.0 * std::f64::consts::TAU;
            [0.2 * t.cos(), 0.2 * t.sin(), 1.0]
        }).collect();
        let section: Vec<[f64; 3]> = (0..2000).map(|i| {
            let t = i as f64 / 2000.0 * std::f64::consts::TAU;
            [0.2 * t.cos(), 0.2 * t.sin(), 0.98]
        }).collect();
        let (curve, ind) = boundary_curve(&section, &seeds, 0.08, 0.06);
        assert_eq!(curve.len(), ind.len(), "one link per point");
        assert!(curve.len() >= 24, "{} points", curve.len());
        for q in &curve {
            let r = (q[0] * q[0] + q[1] * q[1]).sqrt();
            assert!((r - 0.2).abs() < 0.02, "a curve point sits at r = {r:.4}");
        }
        // Every point of the curve is at the section's own height.
        for q in &curve { assert!((q[2] - 0.98).abs() < 1e-9, "{:?}", q); }

        // With no points under it at all, the seeds come back unchanged.
        let (same, _) = boundary_curve(&[], &seeds, 0.08, 0.06);
        assert_eq!(same, seeds);
    }

    /// A GAP IN THE CROSS-SECTION IS BRIDGED, and a long one is not —
    /// reference defect 18, where the rule that a run of five or more
    /// missing points is too long to interpolate across is undone for
    /// every point of the run but its first.
    #[test]
    fn a_long_gap_keeps_its_seeds_rather_than_being_interpolated() {
        let n = 40;
        let seeds: Vec<[f64; 3]> = (0..n).map(|i| {
            let t = i as f64 / n as f64 * std::f64::consts::TAU;
            [0.2 * t.cos(), 0.2 * t.sin(), 1.0]
        }).collect();
        // A section that covers everything except seeds 10..20 — a run
        // of ten, well over the five the reference calls too long. The
        // points sit 2 cm inside the seeds so an interpolated point is
        // told apart from a kept one.
        let mut section: Vec<[f64; 3]> = Vec::new();
        for i in 0..n {
            if (10..20).contains(&i) { continue; }
            let t = i as f64 / n as f64 * std::f64::consts::TAU;
            for k in 0..40 {
                let s = t + (k as f64 - 20.0) * 1e-4;
                section.push([0.18 * s.cos(), 0.18 * s.sin(), 0.98]);
            }
        }
        let (curve, _) = boundary_curve(&section, &seeds, 0.03, 0.06);
        // The gap's points must still be out at the seeds' own radius,
        // not pulled in to a chord across the hole.
        let radii: Vec<f64> = curve.iter()
            .map(|q| (q[0] * q[0] + q[1] * q[1]).sqrt()).collect();
        let inside = radii.iter().filter(|&&r| r < 0.16).count();
        assert_eq!(inside, 0,
            "no curve point may be dragged inside the stem: radii {:?}",
            radii.iter().map(|r| (r * 1000.0).round() / 1000.0).collect::<Vec<_>>());
        assert!(radii.iter().any(|&r| r > 0.195),
            "the gap's seeds are kept at 0.20");
    }
}

