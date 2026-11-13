//! Two clouds of one plot put on each other by their stem maps:
//! where the stems stand and how thick they are at breast height.
//!
//! A stem is the one thing every ground-based scan of a forest shows the
//! same way — TLS from one side or from all round, MLS walked past it,
//! two epochs years apart — and its place hardly moves while its crown,
//! its foliage and the undergrowth do. The positions of the stems are a
//! map, and two maps of one plot differ by a turn about the vertical and
//! a shift: no start is needed, and no skeletons or trees.
//!
//! What runs:
//!
//!   • THE STEMS. The forest pass's stems where the dataset has them
//!     (forest/seeds.json: the axis at breast height and the radius
//!     measured there); otherwise found here, from the points 0.8–2.2 m
//!     above the ground (`find_stems`): circles fitted in four thin slices
//!     and chained up the stem, so a shrub or a branch that happens to be
//!     round in one slice is not a stem.
//!
//!   • PAIRS OF STEMS. Two stems of the moving map a few metres apart are
//!     matched to every pair of the reference the same distance apart
//!     whose radii agree with theirs — the radius is what tells one pair
//!     of alike stems from another. Each such match is a turn and a shift
//!     (two points fix both), any heading and any offset; it is judged by
//!     how many of the moving map's thickest stems it puts on a reference
//!     stem of their thickness.
//!
//!   • THE FIT. The best hypotheses are refined by least squares over
//!     every stem they pair, one to one, with the pairing tightened as the
//!     fit settles; the height is the median difference of the ground
//!     under the paired stems. The runner-up — the best hypothesis that is
//!     elsewhere — says whether the answer is unambiguous: a plantation's
//!     rows can match themselves one row over.
//!
//! The result is a start for the fine registration (`run_register`),
//! which then fits the surfaces in six degrees of freedom: four are found
//! here, and tilt is left to the surfaces.
//!
//! Pure geometry; the dataset reading is in the octree command
//! (`stem_map_of`).

use rayon::prelude::*;
use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};

use crate::commands::forest::stems::{arc_cover, cluster2d, cover_bins, trimmed_circle_n};

/// A stem on the map: its axis at breast height, the ground under it, its
/// radius (0 when not measured), in a common frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MapStem {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub r: f64,
}

/// The matching's settings.
#[derive(Clone, Debug)]
pub struct MatchParams {
    /// The shortest and the longest pair of stems a hypothesis is made from, metres.
    pub pair_min: f64,
    pub pair_max: f64,
    /// How far a pair's two lengths may differ: `pair_tol` + `pair_tol_rel` × the length.
    pub pair_tol: f64,
    pub pair_tol_rel: f64,
    /// Radii agree within `radius_tol` + `radius_tol_rel` × the larger.
    pub radius_tol: f64,
    pub radius_tol_rel: f64,
    /// A moving stem lands on a reference stem within this, metres —
    /// widest for judging the hypotheses, tightest at the end.
    pub land_wide: f64,
    pub land_tight: f64,
    /// Moving stems hypotheses are made from (the thickest), each paired
    /// with its `neighbours` nearest within the pair range.
    pub anchors: usize,
    pub neighbours: usize,
    /// The moving stems a hypothesis is judged by (the thickest).
    pub judges: usize,
    /// Reference stems at most (the thickest).
    pub reference_max: usize,
    /// Fewest stems the answer must pair.
    pub min_matched: usize,
}

impl Default for MatchParams {
    fn default() -> Self {
        MatchParams {
            pair_min: 2.0, pair_max: 30.0, pair_tol: 0.10, pair_tol_rel: 0.005,
            radius_tol: 0.03, radius_tol_rel: 0.3,
            land_wide: 0.35, land_tight: 0.15,
            anchors: 60, neighbours: 10, judges: 60, reference_max: 4000,
            min_matched: 4,
        }
    }
}

/// What the stem-map match found.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StemMapReport {
    /// Stems on each map, and where they came from: "forest" (the forest
    /// pass's stems) or "found" (found here at breast height).
    pub reference_stems: usize,
    pub moving_stems: usize,
    pub reference_source: String,
    pub moving_source: String,
    /// Stems paired one to one by the answer, and their horizontal RMS, metres.
    pub matched: usize,
    pub rms: f64,
    /// The turn (degrees, counter-clockwise from above) and the shift of
    /// the moving stems' centre, metres east, north, up.
    pub yaw_deg: f64,
    pub dx: f64,
    pub dy: f64,
    pub dz: f64,
    /// Stems the best answer elsewhere pairs: well under `matched`, the
    /// answer is unambiguous; near it, a guess.
    pub runner_up: usize,
    /// Hypotheses judged.
    pub hypotheses: usize,
}

/// moving → reference: p' = R(yaw) p + t, horizontal; z shifted by `t[2]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Planar {
    pub yaw: f64,
    pub t: [f64; 3],
}

impl Planar {
    #[inline]
    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        let (s, c) = self.yaw.sin_cos();
        (c * x - s * y + self.t[0], s * x + c * y + self.t[1])
    }
}

fn radii_agree(a: f64, b: f64, p: &MatchParams) -> bool {
    if a <= 0.0 || b <= 0.0 { return true; }
    (a - b).abs() <= p.radius_tol + p.radius_tol_rel * a.max(b)
}

/// The reference stems on a grid, for "which stem is within d of here".
struct Grid {
    cell: f64,
    map: FxHashMap<(i32, i32), Vec<u32>>,
}

impl Grid {
    fn new(s: &[MapStem], cell: f64) -> Grid {
        let mut map: FxHashMap<(i32, i32), Vec<u32>> = FxHashMap::default();
        for (i, q) in s.iter().enumerate() {
            map.entry(((q.x / cell).floor() as i32, (q.y / cell).floor() as i32)).or_default().push(i as u32);
        }
        Grid { cell, map }
    }
    /// The nearest stem within `d` whose radius agrees with `r`.
    fn nearest(&self, s: &[MapStem], x: f64, y: f64, r: f64, d: f64, p: &MatchParams) -> Option<(u32, f64)> {
        let reach = (d / self.cell).ceil() as i32;
        let (gx, gy) = ((x / self.cell).floor() as i32, (y / self.cell).floor() as i32);
        let mut best: Option<(u32, f64)> = None;
        for ix in gx - reach..=gx + reach {
            for iy in gy - reach..=gy + reach {
                let Some(cell) = self.map.get(&(ix, iy)) else { continue };
                for &k in cell {
                    let q = &s[k as usize];
                    let e = ((q.x - x).powi(2) + (q.y - y).powi(2)).sqrt();
                    if e <= d && radii_agree(r, q.r, p) && best.map_or(true, |(_, b)| e < b) { best = Some((k, e)); }
                }
            }
        }
        best
    }
}

/// The stems in order of thickness, thickest first (ties by place in the list).
fn by_thickness(s: &[MapStem]) -> Vec<u32> {
    let mut o: Vec<u32> = (0..s.len() as u32).collect();
    o.sort_by(|&a, &b| s[b as usize].r.partial_cmp(&s[a as usize].r).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b)));
    o
}

/// Pairs of `s` within `lo..=hi` metres, by length.
fn pairs_by_length(s: &[MapStem], keep: &[u32], lo: f64, hi: f64) -> Vec<(f32, u32, u32)> {
    let sub: Vec<MapStem> = keep.iter().map(|&i| s[i as usize]).collect();
    let g = Grid::new(&sub, hi.max(1.0));
    let mut out: Vec<(f32, u32, u32)> = (0..sub.len()).into_par_iter().flat_map_iter(|a| {
        let q = sub[a];
        let (gx, gy) = ((q.x / g.cell).floor() as i32, (q.y / g.cell).floor() as i32);
        let mut v = Vec::new();
        for ix in gx - 1..=gx + 1 {
            for iy in gy - 1..=gy + 1 {
                let Some(cell) = g.map.get(&(ix, iy)) else { continue };
                for &b in cell {
                    if (b as usize) <= a { continue; }
                    let o = sub[b as usize];
                    let d = ((o.x - q.x).powi(2) + (o.y - q.y).powi(2)).sqrt();
                    if d >= lo && d <= hi { v.push((d as f32, keep[a], keep[b as usize])); }
                }
            }
        }
        v
    }).collect();
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    out
}

/// The turn and shift taking moving points `a`, `b` onto reference `ra`, `rb`.
fn from_two(a: (f64, f64), b: (f64, f64), ra: (f64, f64), rb: (f64, f64)) -> Planar {
    let yaw = (rb.1 - ra.1).atan2(rb.0 - ra.0) - (b.1 - a.1).atan2(b.0 - a.0);
    let (s, c) = yaw.sin_cos();
    Planar { yaw, t: [ra.0 - (c * a.0 - s * a.1), ra.1 - (s * a.0 + c * a.1), 0.0] }
}

/// How many of `judges` land on a reference stem of their thickness.
fn judge(h: &Planar, moving: &[MapStem], judges: &[u32], reference: &[MapStem], g: &Grid, d: f64, p: &MatchParams) -> usize {
    judges.iter().filter(|&&i| {
        let m = moving[i as usize];
        let (x, y) = h.apply(m.x, m.y);
        g.nearest(reference, x, y, m.r, d, p).is_some()
    }).count()
}

/// Every moving stem paired with the reference stem it lands nearest,
/// one to one (the closest pairs first), within `d`.
fn pair_up(h: &Planar, moving: &[MapStem], reference: &[MapStem], g: &Grid, d: f64, p: &MatchParams) -> Vec<(u32, u32, f64)> {
    let mut c: Vec<(u32, u32, f64)> = moving.iter().enumerate().filter_map(|(i, m)| {
        let (x, y) = h.apply(m.x, m.y);
        g.nearest(reference, x, y, m.r, d, p).map(|(k, e)| (i as u32, k, e))
    }).collect();
    c.sort_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    let mut used = vec![false; reference.len()];
    c.retain(|&(_, k, _)| if used[k as usize] { false } else { used[k as usize] = true; true });
    c
}

/// The least-squares turn and shift over paired stems.
fn fit_pairs(pairs: &[(u32, u32, f64)], moving: &[MapStem], reference: &[MapStem]) -> Option<Planar> {
    if pairs.len() < 2 { return None; }
    let n = pairs.len() as f64;
    let (mut mx, mut my, mut rx, mut ry) = (0.0, 0.0, 0.0, 0.0);
    for &(i, k, _) in pairs {
        mx += moving[i as usize].x; my += moving[i as usize].y;
        rx += reference[k as usize].x; ry += reference[k as usize].y;
    }
    let (mx, my, rx, ry) = (mx / n, my / n, rx / n, ry / n);
    let (mut sc, mut ss) = (0.0, 0.0);
    for &(i, k, _) in pairs {
        let (ax, ay) = (moving[i as usize].x - mx, moving[i as usize].y - my);
        let (bx, by) = (reference[k as usize].x - rx, reference[k as usize].y - ry);
        sc += ax * bx + ay * by;
        ss += ax * by - ay * bx;
    }
    let yaw = ss.atan2(sc);
    let (s, c) = yaw.sin_cos();
    Some(Planar { yaw, t: [rx - (c * mx - s * my), ry - (s * mx + c * my), 0.0] })
}

/// Refine a hypothesis: pair, fit, tighten. Its pairs at the end.
fn refine(h0: Planar, moving: &[MapStem], reference: &[MapStem], g: &Grid, p: &MatchParams) -> (Planar, Vec<(u32, u32, f64)>) {
    let mut h = h0;
    let steps = [p.land_wide, (p.land_wide + p.land_tight) * 0.5, p.land_tight, p.land_tight, p.land_tight];
    for &d in &steps {
        let pairs = pair_up(&h, moving, reference, g, d, p);
        match fit_pairs(&pairs, moving, reference) {
            Some(n) => h = n,
            None => break,
        }
    }
    let pairs = pair_up(&h, moving, reference, g, p.land_tight, p);
    (h, pairs)
}

fn wrap(a: f64) -> f64 {
    let t = std::f64::consts::TAU;
    let mut v = a.rem_euclid(t);
    if v > std::f64::consts::PI { v -= t; }
    v
}

/// Match two stem maps: the turn and shift taking `moving` onto
/// `reference`, with its report (the stem counts and sources left for the
/// caller to fill). `stop` returns true to stop.
pub fn match_maps(reference: &[MapStem], moving: &[MapStem], p: &MatchParams, stop: &(dyn Fn() -> bool + Sync)) -> Result<(Planar, StemMapReport), String> {
    if reference.len() < p.min_matched || moving.len() < p.min_matched {
        return Err(format!(
            "too few stems to match: {} on the reference, {} on the moving cloud (at least {} each)",
            reference.len(), moving.len(), p.min_matched
        ));
    }
    let r_order = by_thickness(reference);
    let r_keep: Vec<u32> = r_order.iter().take(p.reference_max).copied().collect();
    let tol_max = p.pair_tol + p.pair_tol_rel * p.pair_max;
    let r_pairs = pairs_by_length(reference, &r_keep, (p.pair_min - tol_max).max(0.0), p.pair_max + tol_max);
    let g = Grid::new(reference, 1.0);
    let m_order = by_thickness(moving);
    let judges: Vec<u32> = m_order.iter().take(p.judges).copied().collect();
    let anchors: Vec<u32> = m_order.iter().take(p.anchors).copied().collect();
    // each anchor's neighbours: the nearest moving stems in the pair range
    let pool: Vec<u32> = m_order.iter().take(p.judges.max(300)).copied().collect();
    let found: Vec<Vec<(usize, Planar)>> = anchors.par_iter().map(|&a| {
        if stop() { return Vec::new(); }
        let ma = moving[a as usize];
        let mut nb: Vec<(f64, u32)> = pool.iter().filter(|&&b| b != a).map(|&b| {
            let mb = moving[b as usize];
            (((mb.x - ma.x).powi(2) + (mb.y - ma.y).powi(2)).sqrt(), b)
        }).filter(|&(d, _)| d >= p.pair_min && d <= p.pair_max).collect();
        nb.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(std::cmp::Ordering::Equal).then(x.1.cmp(&y.1)));
        nb.truncate(p.neighbours);
        let mut best: Vec<(usize, Planar)> = Vec::new();
        for &(d, b) in &nb {
            let mb = moving[b as usize];
            let tol = p.pair_tol + p.pair_tol_rel * d;
            let lo = r_pairs.partition_point(|q| (q.0 as f64) < d - tol);
            for q in &r_pairs[lo..] {
                if q.0 as f64 > d + tol { break; }
                let (rk, rl) = (reference[q.1 as usize], reference[q.2 as usize]);
                for (x, y) in [(rk, rl), (rl, rk)] {
                    if !radii_agree(ma.r, x.r, p) || !radii_agree(mb.r, y.r, p) { continue; }
                    let h = from_two((ma.x, ma.y), (mb.x, mb.y), (x.x, x.y), (y.x, y.y));
                    let s = judge(&h, moving, &judges, reference, &g, p.land_wide, p);
                    if s < 3 { continue; }
                    best.push((s, h));
                }
            }
            // keep the few best of this anchor
            best.sort_by_key(|y| std::cmp::Reverse(y.0));
            best.truncate(4);
        }
        best
    }).collect();
    if stop() { return Err("stopped".into()); }
    let hypotheses: usize = found.iter().map(|v| v.len()).sum();
    let mut cands: Vec<(usize, usize, Planar)> = found.into_iter().enumerate()
        .flat_map(|(ai, v)| v.into_iter().map(move |(s, h)| (s, ai, h))).collect();
    cands.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    if cands.is_empty() {
        return Err("no pair of moving stems matches a pair of reference stems of the same spacing and thickness — are both clouds of the same plot, with stems at breast height?".into());
    }
    // refine the best, distinct ones
    let mut refined: Vec<(Planar, Vec<(u32, u32, f64)>)> = Vec::new();
    let (cmx, cmy) = {
        let n = moving.len() as f64;
        (moving.iter().map(|m| m.x).sum::<f64>() / n, moving.iter().map(|m| m.y).sum::<f64>() / n)
    };
    let differs = |a: &Planar, b: &Planar| -> bool {
        let (ax, ay) = a.apply(cmx, cmy);
        let (bx, by) = b.apply(cmx, cmy);
        ((ax - bx).powi(2) + (ay - by).powi(2)).sqrt() > 1.0 || wrap(a.yaw - b.yaw).abs() > 3f64.to_radians()
    };
    for (_, _, h) in cands.iter().take(48) {
        if refined.iter().any(|(r, _)| !differs(r, h)) { continue; }
        refined.push(refine(*h, moving, reference, &g, p));
        if refined.len() >= 16 { break; }
    }
    let score = |pairs: &Vec<(u32, u32, f64)>| -> (usize, f64) {
        let rms = if pairs.is_empty() { f64::INFINITY } else { (pairs.iter().map(|q| q.2 * q.2).sum::<f64>() / pairs.len() as f64).sqrt() };
        (pairs.len(), rms)
    };
    // how far the paired radii disagree, on average: where two answers
    // pair as many stems (a plantation's rows, a lattice turned a quarter),
    // the thicknesses tell them apart
    let radius_misfit = |pairs: &Vec<(u32, u32, f64)>| -> f64 {
        let d: Vec<f64> = pairs.iter().filter_map(|&(i, k, _)| {
            let (a, b) = (moving[i as usize].r, reference[k as usize].r);
            (a > 0.0 && b > 0.0).then(|| (a - b).abs())
        }).collect();
        if d.is_empty() { 0.0 } else { d.iter().sum::<f64>() / d.len() as f64 }
    };
    refined.sort_by(|a, b| {
        let (na, ra) = score(&a.1);
        let (nb, rb) = score(&b.1);
        nb.cmp(&na)
            .then(radius_misfit(&a.1).partial_cmp(&radius_misfit(&b.1)).unwrap_or(std::cmp::Ordering::Equal))
            .then(ra.partial_cmp(&rb).unwrap_or(std::cmp::Ordering::Equal))
    });
    let (best, pairs) = refined[0].clone();
    let (matched, rms) = score(&pairs);
    let runner_up = refined.iter().skip(1).find(|(h, _)| differs(h, &best)).map_or(0, |(_, q)| q.len());
    if matched < p.min_matched {
        return Err(format!(
            "the stem maps do not match: the best turn and shift pair only {matched} stems (at least {} needed) — are both clouds of the same plot?",
            p.min_matched
        ));
    }
    // the height: the ground under the paired stems
    let mut dz: Vec<f64> = pairs.iter().map(|&(i, k, _)| reference[k as usize].z - moving[i as usize].z).filter(|v| v.is_finite()).collect();
    dz.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let tz = if dz.is_empty() { 0.0 } else if dz.len() % 2 == 1 { dz[dz.len() / 2] } else { 0.5 * (dz[dz.len() / 2 - 1] + dz[dz.len() / 2]) };
    let best = Planar { yaw: wrap(best.yaw), t: [best.t[0], best.t[1], tz] };
    let (ex, ey) = best.apply(cmx, cmy);
    Ok((best, StemMapReport {
        reference_stems: reference.len(),
        moving_stems: moving.len(),
        reference_source: String::new(),
        moving_source: String::new(),
        matched,
        rms,
        yaw_deg: best.yaw.to_degrees(),
        dx: ex - cmx,
        dy: ey - cmy,
        dz: tz,
        runner_up,
        hypotheses,
    }))
}

/// Where the stems are looked for, metres above the ground: four slices
/// about these heights, `SLICE_REACH` at most either side (thinner where
/// the points are dense: `find_stems`). The caller reads that much.
pub const SLICES: [f64; 4] = [0.9, 1.3, 1.7, 2.1];
pub const SLICE_REACH: f64 = 0.1;
/// Breast height, where a stem's place is read.
const BH: f64 = 1.3;

#[derive(Clone, Copy, Debug)]
struct Ring { x: f64, y: f64, r: f64 }

/// The points' spacing: the median distance to the nearest other point,
/// over a sample — 1 cm for a close TLS scan thinned to 1 cm, several
/// for a drone's or a thinned cloud.
fn spacing(pts: &[[f64; 3]], floor: f64) -> f64 {
    if pts.len() < 2 { return floor; }
    let cell = 0.1;
    let key = |q: &[f64; 3]| ((q[0] / cell).floor() as i32, (q[1] / cell).floor() as i32, (q[2] / cell).floor() as i32);
    let mut grid: FxHashMap<(i32, i32, i32), Vec<u32>> = FxHashMap::default();
    for (i, q) in pts.iter().enumerate() { grid.entry(key(q)).or_default().push(i as u32); }
    let step = (pts.len() / 20_000).max(1);
    let mut d: Vec<f64> = (0..pts.len()).step_by(step).filter_map(|i| {
        let q = pts[i];
        let (kx, ky, kz) = key(&q);
        let mut best = f64::INFINITY;
        for x in kx - 1..=kx + 1 { for y in ky - 1..=ky + 1 { for z in kz - 1..=kz + 1 {
            let Some(c) = grid.get(&(x, y, z)) else { continue };
            for &j in c {
                if j as usize == i { continue; }
                let o = pts[j as usize];
                best = best.min(((o[0] - q[0]).powi(2) + (o[1] - q[1]).powi(2) + (o[2] - q[2]).powi(2)).sqrt());
            }
        }}}
        best.is_finite().then_some(best)
    }).collect();
    if d.is_empty() { return cell; }
    d.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    d[d.len() / 2].max(floor)
}

/// Stems from points around breast height: `pts` (any frame, z unused)
/// and their heights above the ground, `cell` the spacing they were
/// thinned to at least. The slices, the reach of a cluster and the
/// points a circle needs follow the spacing the points really have, so a
/// sparse cloud (a drone's, one thinned for storage) finds its stems too.
/// The z of every stem found is 0 — the caller puts the ground under it.
pub fn find_stems(pts: &[[f64; 3]], hag: &[f32], cell: f64) -> Vec<MapStem> {
    let p32: Vec<[f32; 3]> = pts.iter().map(|q| [q[0] as f32, q[1] as f32, q[2] as f32]).collect();
    let s = spacing(pts, cell).min(0.1);
    let half = (1.25 * s).clamp(0.05, SLICE_REACH);
    let eps = (s * 2.5).clamp(0.03, 0.15) as f32;
    let tol = (0.4 * s).max(0.015);
    let (min_pts, min_inl) = if s > 0.02 { (8, 6) } else { (12, 10) };
    let rings: Vec<Vec<Ring>> = SLICES.par_iter().map(|&h| {
        let idx: Vec<u32> = (0..pts.len() as u32).filter(|&i| (hag[i as usize] as f64 - h).abs() <= half).collect();
        let mut out = Vec::new();
        for c in cluster2d(&p32, &idx, eps) {
            if c.len() < min_pts { continue; }
            let xy: Vec<(f64, f64)> = c.iter().map(|&i| (pts[i as usize][0], pts[i as usize][1])).collect();
            let (mut lo, mut hi) = ((f64::INFINITY, f64::INFINITY), (f64::NEG_INFINITY, f64::NEG_INFINITY));
            for q in &xy { lo = (lo.0.min(q.0), lo.1.min(q.1)); hi = (hi.0.max(q.0), hi.1.max(q.1)); }
            if (hi.0 - lo.0).max(hi.1 - lo.1) > 1.8 { continue; }
            let Some((cx, cy, r, inl)) = trimmed_circle_n(&xy, tol, 96, true) else { continue };
            if !(0.03..=0.8).contains(&r) || inl.len() < min_inl || (inl.len() as f64) < 0.3 * xy.len() as f64 { continue; }
            let band = tol.max(0.12 * r);
            let inside = xy.iter().filter(|q| ((q.0 - cx).powi(2) + (q.1 - cy).powi(2)).sqrt() < r - band).count();
            if inside as f64 > 0.15 * xy.len() as f64 { continue; }
            let on: Vec<(f64, f64)> = inl.iter().map(|&i| xy[i]).collect();
            let (cover, _gap) = arc_cover(&on, cx, cy, cover_bins(r, s));
            if cover < 0.3 { continue; }
            out.push(Ring { x: cx, y: cy, r });
        }
        out
    }).collect();
    // chain up the stem, bottom to top: a ring joins the nearest chain
    // whose last ring is one or two slices below and agrees with it
    let mut chains: Vec<Vec<(usize, Ring)>> = Vec::new();
    for (s, rs) in rings.iter().enumerate() {
        let mut cand: Vec<(f64, usize, usize)> = Vec::new();
        for (ri, ring) in rs.iter().enumerate() {
            for (ci, ch) in chains.iter().enumerate() {
                let &(ls, last) = ch.last().unwrap();
                if ls >= s || s - ls > 2 { continue; }
                let dh = SLICES[s] - SLICES[ls];
                let d = ((ring.x - last.x).powi(2) + (ring.y - last.y).powi(2)).sqrt();
                let ratio = ring.r / last.r;
                if d <= (0.3 * last.r).max(0.05) + 0.15 * dh && (0.6..=1.65).contains(&ratio) { cand.push((d, ri, ci)); }
            }
        }
        cand.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
        let mut ring_used = vec![false; rs.len()];
        let mut chain_used = vec![false; chains.len()];
        for (_, ri, ci) in cand {
            if ring_used[ri] || chain_used[ci] { continue; }
            ring_used[ri] = true;
            chain_used[ci] = true;
            chains[ci].push((s, rs[ri]));
        }
        for (ri, ring) in rs.iter().enumerate() {
            if !ring_used[ri] { chains.push(vec![(s, *ring)]); }
        }
    }
    let mut stems: Vec<(usize, MapStem)> = chains.into_iter().filter(|c| c.len() >= 2).map(|c| {
        // the axis through the rings, read at breast height
        let n = c.len() as f64;
        let hm = c.iter().map(|q| SLICES[q.0]).sum::<f64>() / n;
        let (xm, ym) = (c.iter().map(|q| q.1.x).sum::<f64>() / n, c.iter().map(|q| q.1.y).sum::<f64>() / n);
        let shh = c.iter().map(|q| (SLICES[q.0] - hm).powi(2)).sum::<f64>();
        let (bx, by) = if shh > 1e-9 {
            (c.iter().map(|q| (SLICES[q.0] - hm) * (q.1.x - xm)).sum::<f64>() / shh,
             c.iter().map(|q| (SLICES[q.0] - hm) * (q.1.y - ym)).sum::<f64>() / shh)
        } else { (0.0, 0.0) };
        let mut rr: Vec<f64> = c.iter().map(|q| q.1.r).collect();
        rr.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let r = if rr.len() % 2 == 1 { rr[rr.len() / 2] } else { 0.5 * (rr[rr.len() / 2 - 1] + rr[rr.len() / 2]) };
        (c.len(), MapStem { x: xm + bx * (BH - hm), y: ym + by * (BH - hm), z: 0.0, r })
    }).collect();
    // one stem where two chains found the same one: the longer chain
    stems.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.x.partial_cmp(&b.1.x).unwrap_or(std::cmp::Ordering::Equal)).then(a.1.y.partial_cmp(&b.1.y).unwrap_or(std::cmp::Ordering::Equal)));
    let mut out: Vec<MapStem> = Vec::new();
    for (_, s) in stems {
        if out.iter().any(|o| ((o.x - s.x).powi(2) + (o.y - s.y).powi(2)).sqrt() < o.r.max(s.r).max(0.1)) { continue; }
        out.push(s);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 33) as f64) / (1u64 << 31) as f64
    }

    /// A plot of `n` stems over `w` × `w` metres, radii 4–35 cm.
    fn plot(n: usize, w: f64, seed: u64) -> Vec<MapStem> {
        let mut s = seed;
        (0..n).map(|_| MapStem { x: lcg(&mut s) * w, y: lcg(&mut s) * w, z: 100.0 + lcg(&mut s) * 2.0, r: 0.04 + lcg(&mut s).powi(2) * 0.31 }).collect()
    }

    /// The same stems seen again: moved by `h` (inverse applied), with
    /// noise, some lost, some extra.
    fn seen_again(truth: &[MapStem], yaw: f64, t: [f64; 3], noise: f64, lose: f64, extra: usize, seed: u64) -> Vec<MapStem> {
        let mut s = seed;
        let (sn, cs) = (-yaw).sin_cos();
        let mut out: Vec<MapStem> = truth.iter().filter_map(|q| {
            if lcg(&mut s) < lose { return None; }
            // moving = R⁻¹ (reference − t)
            let (x, y) = (q.x - t[0], q.y - t[1]);
            let (mx, my) = (cs * x - sn * y, sn * x + cs * y);
            Some(MapStem {
                x: mx + (lcg(&mut s) - 0.5) * 2.0 * noise,
                y: my + (lcg(&mut s) - 0.5) * 2.0 * noise,
                z: q.z - t[2],
                r: q.r * (1.0 + (lcg(&mut s) - 0.5) * 0.2),
            })
        }).collect();
        let (cx, cy) = (out.iter().map(|m| m.x).sum::<f64>() / out.len() as f64, out.iter().map(|m| m.y).sum::<f64>() / out.len() as f64);
        for _ in 0..extra {
            out.push(MapStem { x: cx + (lcg(&mut s) - 0.5) * 50.0, y: cy + (lcg(&mut s) - 0.5) * 50.0, z: 0.0, r: 0.04 + lcg(&mut s) * 0.1 });
        }
        out
    }

    fn never() -> bool { false }

    #[test]
    fn a_plot_turned_any_way_and_far_off_comes_back() {
        let truth = plot(150, 50.0, 7);
        for (k, &yaw_deg) in [0.0f64, 37.0, 90.0, 179.0, -123.0].iter().enumerate() {
            let yaw = yaw_deg.to_radians();
            let t = [412.3, -87.6, 1.25];
            let moving = seen_again(&truth, yaw, t, 0.03, 0.2, 15, 11 + k as u64);
            let (h, rep) = match_maps(&truth, &moving, &MatchParams::default(), &never).unwrap();
            assert!(wrap(h.yaw - yaw).abs() < 0.3f64.to_radians(), "yaw {yaw_deg}: got {}", h.yaw.to_degrees());
            // every true stem's moving copy lands within a few cm of it
            let probe = seen_again(&truth, yaw, t, 0.0, 0.0, 0, 3);
            let worst = probe.iter().zip(&truth).map(|(m, q)| {
                let (x, y) = h.apply(m.x, m.y);
                ((x - q.x).powi(2) + (y - q.y).powi(2)).sqrt()
            }).fold(0.0, f64::max);
            assert!(worst < 0.06, "yaw {yaw_deg}: worst {worst}");
            assert!((h.t[2] - t[2]).abs() < 1e-9, "dz {}", h.t[2]);
            assert!(rep.matched >= 100, "matched {}", rep.matched);
            assert!(rep.runner_up * 3 < rep.matched, "runner-up {} of {}", rep.runner_up, rep.matched);
        }
    }

    #[test]
    fn a_part_of_the_plot_is_found_in_the_whole() {
        // the moving cloud saw a 20 × 20 m corner, from another heading
        let truth = plot(200, 60.0, 21);
        let corner: Vec<MapStem> = truth.iter().filter(|q| q.x < 25.0 && q.y < 25.0).copied().collect();
        let moving = seen_again(&corner, 1.1, [-30.0, 55.0, -0.4], 0.02, 0.1, 5, 4);
        let (h, rep) = match_maps(&truth, &moving, &MatchParams::default(), &never).unwrap();
        assert!(wrap(h.yaw - 1.1).abs() < 0.5f64.to_radians(), "yaw {}", h.yaw.to_degrees());
        assert!(rep.matched as f64 >= 0.7 * corner.len() as f64, "matched {} of {}", rep.matched, corner.len());
    }

    #[test]
    fn a_lattice_turned_a_quarter_is_told_apart_by_the_thicknesses() {
        // nine stems on a 10 m lattice, thicker towards one corner
        let truth: Vec<MapStem> = (0..9).map(|i| {
            let (tx, ty) = ((i / 3) as f64, (i % 3) as f64);
            MapStem { x: 5.0 + tx * 10.0, y: 5.0 + ty * 10.0, z: 100.0 + tx * 0.2, r: 0.12 + (tx + ty) * 0.01 }
        }).collect();
        // turned a quarter about its middle: the places alone match four ways
        let yaw = std::f64::consts::FRAC_PI_2;
        let moving = seen_again(&truth, yaw, [30.0, 0.0, 0.0], 0.0, 0.0, 0, 8);
        let (h, rep) = match_maps(&truth, &moving, &MatchParams::default(), &never).unwrap();
        assert!(wrap(h.yaw - yaw).abs() < 1e-6, "yaw {}", h.yaw.to_degrees());
        assert!((h.t[0] - 30.0).abs() < 1e-6 && h.t[1].abs() < 1e-6, "{:?}", h.t);
        assert_eq!(rep.matched, 9);
        // …and the report says the places alone did not decide it
        assert_eq!(rep.runner_up, 9);
    }

    #[test]
    fn unrelated_maps_are_refused_and_the_match_is_deterministic() {
        let a = plot(80, 40.0, 1);
        let b = plot(80, 40.0, 2);
        match match_maps(&a, &b, &MatchParams::default(), &never) {
            Err(_) => {}
            Ok((_, rep)) => assert!(rep.matched < 12 && rep.runner_up * 2 > rep.matched, "{rep:?}"),
        }
        let moving = seen_again(&a, 0.7, [5.0, 6.0, 0.0], 0.02, 0.1, 5, 9);
        let x = match_maps(&a, &moving, &MatchParams::default(), &never).unwrap();
        let y = match_maps(&a, &moving, &MatchParams::default(), &never).unwrap();
        assert_eq!(x, y);
        assert!(match_maps(&a[..3], &moving, &MatchParams::default(), &never).is_err());
    }

    /// Points on stems (a cylinder each, seen from one side or all round)
    /// `step` apart, and on clutter, 0.8–2.2 m above a flat ground.
    fn stand(stems: &[MapStem], half_seen: bool, step: f64, seed: u64) -> (Vec<[f64; 3]>, Vec<f32>) {
        let mut s = seed;
        let (mut p, mut h) = (Vec::new(), Vec::new());
        for st in stems {
            let mut z = 0.8;
            while z < 2.2 {
                let n = ((std::f64::consts::TAU * st.r) / step) as usize;
                for k in 0..n {
                    let a = k as f64 / n as f64 * std::f64::consts::TAU;
                    if half_seen && a.cos() < 0.0 { continue; }
                    let rr = st.r + (lcg(&mut s) - 0.5) * 0.006;
                    p.push([st.x + rr * a.cos() + 0.03 * (z - 1.3), st.y + rr * a.sin(), z]);
                    h.push(z as f32);
                }
                z += step;
            }
        }
        // shrubs: blobs of points
        for _ in 0..40 {
            let (cx, cy) = (lcg(&mut s) * 30.0, lcg(&mut s) * 30.0);
            for _ in 0..300 {
                let z = 0.8 + lcg(&mut s) * 1.4;
                p.push([cx + (lcg(&mut s) - 0.5) * 0.6, cy + (lcg(&mut s) - 0.5) * 0.6, z]);
                h.push(z as f32);
            }
        }
        (p, h)
    }

    #[test]
    fn stems_are_found_at_breast_height_and_shrubs_are_not() {
        // stems at least a metre apart
        let mut truth: Vec<MapStem> = Vec::new();
        for q in plot(25, 30.0, 5) {
            if !truth.iter().any(|o| ((o.x - q.x).powi(2) + (o.y - q.y).powi(2)).sqrt() < 1.0) { truth.push(q); }
        }
        // dense as a close scan, and sparse as a drone's or a thinned cloud
        for (step, near, share) in [(0.01, 0.03, 0.9), (0.04, 0.05, 0.8)] {
            for half in [false, true] {
                let (p, h) = stand(&truth, half, step, 3);
                let found = find_stems(&p, &h, 0.01);
                let hits = truth.iter().filter(|q| found.iter().any(|f| ((f.x - q.x).powi(2) + (f.y - q.y).powi(2)).sqrt() < near && (f.r - q.r).abs() < 0.03)).count();
                assert!(hits as f64 >= share * truth.len() as f64, "step {step}, half {half}: {hits} of {}", truth.len());
                let false_stems = found.iter().filter(|f| !truth.iter().any(|q| ((f.x - q.x).powi(2) + (f.y - q.y).powi(2)).sqrt() < 0.1)).count();
                assert!(false_stems <= 3, "step {step}, half {half}: {false_stems} false stems");
            }
        }
    }
}
