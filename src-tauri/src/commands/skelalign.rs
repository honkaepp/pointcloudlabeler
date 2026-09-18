//! Putting a plot's skeletons where the target cloud's trees are.
//!
//! A TLS plot and the HeliALS epoch flown over it are georeferenced by
//! different people with different instruments, and the two can stand
//! metres apart — tens, when a plot centre came from a handheld GNSS
//! under canopy. The transfer labels each target point from the nearest
//! skeleton sample within a few decimetres, so with the skeletons beside
//! the trees it labels nothing right, and nothing in it can tell a
//! misregistration from a segmentation difference.
//!
//! This module measures the transform from the skeletons onto the
//! target's trees. THE SKELETONS ARE THE ONES THAT ARE RIGHT — a TLS
//! plot's registration is the tighter of the two — so the fix is to move
//! the TARGET by the inverse (octree_shift_georeference); until then the
//! transfer and the views can take the skeletons through the transform,
//! which labels the same. It does NOT run ICP on raw stem points:
//! a helicopter's returns off stems under a closed canopy are sparse and
//! patchy, and point-to-point ICP from a metres-off start converges on
//! whatever clutter is nearest. It works from what both clouds show of
//! every tree, rasterised:
//!
//!   • STEMS. From the skeleton, each tree's stem axis at 1–8 m above its
//!     own base. From the target, a VERTICALITY raster: per 0.25 m cell,
//!     how many 0.5 m height layers between 1 and 9 m above ground hold
//!     a point. A stem fills many layers; foliage and understorey a few.
//!   • TOPS. From the skeleton, each tree's highest sample. From the
//!     target, the local maxima of its canopy height model.
//!
//! COARSE: every skeleton anchor votes for every translation that would
//! put it on a weighted target cell, over a window of tens of metres and
//! a fan of small rotations; the two channels' votes are normalised and
//! summed, and the peak is the plot's shift. Sixty stems voting together
//! make a peak that clutter does not. FINE: after the shift, each tree's
//! stem is matched to the densest vertical structure within reach, and a
//! weighted rigid fit (rotation + translation, trimmed of outliers) is
//! iterated with a shrinking reach. The result is a 2-D rigid transform
//! in the skeleton origin's frame; heights are left to the height frames.

use serde::{Deserialize, Serialize};

/// A rigid transform of the plane: rotation by `theta` about (cx, cy),
/// then translation by (dx, dy). In the skeleton origin's frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rigid2 {
    pub theta: f64,
    pub dx: f64,
    pub dy: f64,
    pub cx: f64,
    pub cy: f64,
}

impl Rigid2 {
    pub fn identity(cx: f64, cy: f64) -> Rigid2 { Rigid2 { theta: 0.0, dx: 0.0, dy: 0.0, cx, cy } }

    pub fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        let (s, c) = self.theta.sin_cos();
        let rx = x - self.cx;
        let ry = y - self.cy;
        (self.cx + c * rx - s * ry + self.dx, self.cy + s * rx + c * ry + self.dy)
    }

    /// The transform taking a moved point back.
    pub fn inverse(&self) -> Rigid2 {
        // apply: p' = c + R (p − c) + d  ⇒  p = c + R⁻¹ (p' − c − d)
        // As a Rigid2 about the same centre: theta' = −theta, and the
        // translation d' with p = c + R⁻¹(p' − c) + d' ⇒ d' = −R⁻¹ d.
        let (s, c) = (-self.theta).sin_cos();
        Rigid2 {
            theta: -self.theta,
            dx: -(c * self.dx - s * self.dy),
            dy: -(s * self.dx + c * self.dy),
            cx: self.cx,
            cy: self.cy,
        }
    }
}

/// The transform as the panel sends it back to the transfer, in the
/// skeleton origin's frame.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentParam {
    pub dx: f64,
    pub dy: f64,
    pub theta: f64,
    pub cx: f64,
    pub cy: f64,
}

impl AlignmentParam {
    pub fn rigid(&self) -> Rigid2 { Rigid2 { theta: self.theta, dx: self.dx, dy: self.dy, cx: self.cx, cy: self.cy } }
}

/// A weight per square cell, row-major, in the skeleton origin's frame.
#[derive(Clone, Debug)]
pub struct Raster2 {
    pub min_x: f64,
    pub min_y: f64,
    pub cell: f64,
    pub cols: usize,
    pub rows: usize,
    pub w: Vec<f32>,
}

impl Raster2 {
    pub fn new(min_x: f64, min_y: f64, cell: f64, cols: usize, rows: usize) -> Raster2 {
        Raster2 { min_x, min_y, cell, cols, rows, w: vec![0.0; cols * rows] }
    }

    pub fn index(&self, x: f64, y: f64) -> Option<usize> {
        let cx = ((x - self.min_x) / self.cell).floor();
        let cy = ((y - self.min_y) / self.cell).floor();
        if cx < 0.0 || cy < 0.0 || cx >= self.cols as f64 || cy >= self.rows as f64 { return None; }
        Some(cy as usize * self.cols + cx as usize)
    }

    pub fn centre(&self, idx: usize) -> (f64, f64) {
        let cx = idx % self.cols;
        let cy = idx / self.cols;
        (self.min_x + (cx as f64 + 0.5) * self.cell, self.min_y + (cy as f64 + 0.5) * self.cell)
    }

    pub fn add(&mut self, x: f64, y: f64, w: f32) {
        if let Some(i) = self.index(x, y) { self.w[i] += w; }
    }

    /// The cells that carry weight, as (centre x, centre y, weight) —
    /// what the votes iterate, so an empty square kilometre costs
    /// nothing.
    pub fn nonzero(&self) -> Vec<(f64, f64, f32)> {
        let mut out = Vec::new();
        for (i, &w) in self.w.iter().enumerate() {
            if w > 0.0 { let (x, y) = self.centre(i); out.push((x, y, w)); }
        }
        out
    }
}

/// Height layers the verticality raster counts: 0.5 m steps from 1 m
/// to 9 m above ground, one bit each in a u16.
pub const VERT_BAND: (f64, f64) = (1.0, 9.0);
pub const VERT_LAYER: f64 = 0.5;
pub const VERT_LAYERS: u32 = 16;
/// A cell counts as vertical structure from this many layers up.
pub const VERT_MIN_LAYERS: u32 = 3;
/// Cell sizes of the two target rasters (m).
pub const VERT_CELL: f64 = 0.25;
pub const CHM_CELL: f64 = 0.5;

/// The layer a height above ground falls in, or None outside the band.
pub fn vert_layer(hag: f64) -> Option<u32> {
    if hag < VERT_BAND.0 || hag >= VERT_BAND.1 { return None; }
    let l = ((hag - VERT_BAND.0) / VERT_LAYER).floor() as u32;
    (l < VERT_LAYERS).then_some(l)
}

/// Layer masks → weights: the layer count, zero below the minimum.
pub fn verticality_weights(masks: &[u16], out: &mut [f32]) {
    for (i, &m) in masks.iter().enumerate() {
        let n = m.count_ones();
        out[i] = if n >= VERT_MIN_LAYERS { n as f32 } else { 0.0 };
    }
}

/// The canopy's local maxima: cells at least `min_h` high that are the
/// highest within `radius_cells`, as a raster of ones on those cells.
pub fn canopy_tops(chm: &Raster2, min_h: f32, radius_cells: i64) -> Raster2 {
    let mut out = Raster2::new(chm.min_x, chm.min_y, chm.cell, chm.cols, chm.rows);
    for r in 0..chm.rows as i64 {
        for c in 0..chm.cols as i64 {
            let h = chm.w[r as usize * chm.cols + c as usize];
            if h.is_nan() || h < min_h { continue; }
            let mut top = true;
            'scan: for dr in -radius_cells..=radius_cells {
                for dc in -radius_cells..=radius_cells {
                    if dr == 0 && dc == 0 { continue; }
                    let rr = r + dr;
                    let cc = c + dc;
                    if rr < 0 || cc < 0 || rr >= chm.rows as i64 || cc >= chm.cols as i64 { continue; }
                    let o = chm.w[rr as usize * chm.cols + cc as usize];
                    // A strict neighbour higher, or an equal one earlier
                    // in scan order, owns the top.
                    if o > h || (o == h && (dr < 0 || (dr == 0 && dc < 0))) { top = false; break 'scan; }
                }
            }
            if top { out.w[r as usize * chm.cols + c as usize] = 1.0; }
        }
    }
    out
}

/// Votes for translations, binned.
#[derive(Clone, Debug)]
pub struct VoteGrid {
    pub bin: f64,
    /// The offset the (0, 0) bin's lower corner stands for.
    pub dx0: f64,
    pub dy0: f64,
    pub n: usize,
    pub v: Vec<f32>,
}

impl VoteGrid {
    pub fn new(window: f64, bin: f64) -> VoteGrid {
        let n = ((2.0 * window) / bin).ceil() as usize + 1;
        VoteGrid { bin, dx0: -window, dy0: -window, n, v: vec![0.0; n * n] }
    }

    fn add(&mut self, dx: f64, dy: f64, w: f32) {
        let bx = ((dx - self.dx0) / self.bin).floor();
        let by = ((dy - self.dy0) / self.bin).floor();
        if bx < 0.0 || by < 0.0 || bx >= self.n as f64 || by >= self.n as f64 { return; }
        self.v[by as usize * self.n + bx as usize] += w;
    }

    pub fn max(&self) -> f32 { self.v.iter().cloned().fold(0.0, f32::max) }

    /// self += other / other.max(), so channels add on one scale.
    pub fn add_normalised(&mut self, other: &VoteGrid) {
        let m = other.max();
        if m <= 0.0 { return; }
        for (a, b) in self.v.iter_mut().zip(other.v.iter()) { *a += b / m; }
    }
}

/// Every anchor, moved by `rigid`, votes for each translation that puts
/// it on a weighted raster cell within `window` of where it stands.
pub fn vote(anchors: &[[f64; 2]], raster: &Raster2, window: f64, bin: f64, rigid: &Rigid2) -> VoteGrid {
    vote_cells(anchors, &raster.nonzero(), window, bin, rigid)
}

/// `vote` over a raster's weighted cells (see Raster2::nonzero), so the
/// cells are gathered once for the whole fan of rotations.
pub fn vote_cells(anchors: &[[f64; 2]], cells: &[(f64, f64, f32)], window: f64, bin: f64, rigid: &Rigid2) -> VoteGrid {
    let mut grid = VoteGrid::new(window, bin);
    for a in anchors {
        let (ax, ay) = rigid.apply(a[0], a[1]);
        for &(cx, cy, w) in cells {
            let dx = cx - ax;
            let dy = cy - ay;
            if dx < -window || dx > window || dy < -window || dy > window { continue; }
            grid.add(dx, dy, w);
        }
    }
    grid
}

/// The vote grid's peak after a 3 × 3 smoothing, with the best score at
/// least `exclude` away from it for a confidence ratio.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Peak {
    pub dx: f64,
    pub dy: f64,
    pub score: f32,
    pub second: f32,
}

pub fn peak(grid: &VoteGrid, exclude: f64) -> Option<Peak> {
    let n = grid.n as i64;
    let at = |bx: i64, by: i64| -> f32 {
        if bx < 0 || by < 0 || bx >= n || by >= n { 0.0 } else { grid.v[(by * n + bx) as usize] }
    };
    let mut smooth = vec![0.0f32; grid.v.len()];
    let mut best = (0.0f32, 0i64, 0i64);
    for by in 0..n {
        for bx in 0..n {
            let mut s = 0.0;
            for dy in -1..=1 { for dx in -1..=1 { s += at(bx + dx, by + dy); } }
            smooth[(by * n + bx) as usize] = s;
            if s > best.0 { best = (s, bx, by); }
        }
    }
    if best.0 <= 0.0 { return None; }
    // Sub-bin position: the centroid of the smoothed votes within a bin
    // of the peak.
    let (mut sx, mut sy, mut sw) = (0.0f64, 0.0f64, 0.0f64);
    for dy in -1..=1 {
        for dx in -1..=1 {
            let w = at(best.1 + dx, best.2 + dy) as f64;
            sx += w * ((best.1 + dx) as f64 + 0.5);
            sy += w * ((best.2 + dy) as f64 + 0.5);
            sw += w;
        }
    }
    let (px, py) = if sw > 0.0 { (sx / sw, sy / sw) } else { (best.1 as f64 + 0.5, best.2 as f64 + 0.5) };
    let ex = (exclude / grid.bin).ceil() as i64;
    let mut second = 0.0f32;
    for by in 0..n {
        for bx in 0..n {
            if (bx - best.1).abs() <= ex && (by - best.2).abs() <= ex { continue; }
            let s = smooth[(by * n + bx) as usize];
            if s > second { second = s; }
        }
    }
    Some(Peak { dx: grid.dx0 + px * grid.bin, dy: grid.dy0 + py * grid.bin, score: best.0, second })
}

/// The densest vertical structure within `radius` of (x, y): the cell of
/// most weight, then the weighted centroid of the cells within 0.4 m of
/// it. None when nothing there carries weight.
pub fn match_anchor(raster: &Raster2, x: f64, y: f64, radius: f64) -> Option<([f64; 2], f32)> {
    let c0 = (((x - radius) - raster.min_x) / raster.cell).floor().max(0.0) as usize;
    let c1 = ((((x + radius) - raster.min_x) / raster.cell).ceil().max(0.0) as usize).min(raster.cols);
    let r0 = (((y - radius) - raster.min_y) / raster.cell).floor().max(0.0) as usize;
    let r1 = ((((y + radius) - raster.min_y) / raster.cell).ceil().max(0.0) as usize).min(raster.rows);
    let r2 = radius * radius;
    let mut best: Option<(usize, f32, f64)> = None;
    for r in r0..r1 {
        for c in c0..c1 {
            let i = r * raster.cols + c;
            let w = raster.w[i];
            if w <= 0.0 { continue; }
            let (cx, cy) = raster.centre(i);
            let d2 = (cx - x).powi(2) + (cy - y).powi(2);
            if d2 > r2 { continue; }
            // Heavier wins; of equal weight, the nearer.
            let better = match best { None => true, Some((_, bw, bd)) => w > bw || (w == bw && d2 < bd) };
            if better { best = Some((i, w, d2)); }
        }
    }
    let (bi, _, _) = best?;
    let (bx, by) = raster.centre(bi);
    let reach = 0.4f64.max(raster.cell);
    let (mut sx, mut sy, mut sw) = (0.0f64, 0.0f64, 0.0f64);
    for r in r0..r1 {
        for c in c0..c1 {
            let i = r * raster.cols + c;
            let w = raster.w[i] as f64;
            if w <= 0.0 { continue; }
            let (cx, cy) = raster.centre(i);
            if (cx - bx).powi(2) + (cy - by).powi(2) > reach * reach { continue; }
            sx += w * cx; sy += w * cy; sw += w;
        }
    }
    if sw <= 0.0 { return None; }
    Some(([sx / sw, sy / sw], sw as f32))
}

/// One matched tree: where its skeleton anchor is, where the target's
/// structure is, and how much to trust it.
#[derive(Clone, Copy, Debug)]
pub struct Pair {
    pub source: [f64; 2],
    pub target: [f64; 2],
    pub weight: f64,
}

/// The weighted rigid transform about `centre` taking the sources onto
/// the targets — rotation from the cross-covariance, translation from
/// the centroids. Translation alone with `allow_rotation` off.
pub fn fit_rigid(pairs: &[Pair], centre: [f64; 2], allow_rotation: bool) -> Option<Rigid2> {
    let sw: f64 = pairs.iter().map(|p| p.weight).sum();
    if pairs.is_empty() || sw <= 0.0 { return None; }
    let ms = pairs.iter().fold([0.0, 0.0], |m, p| [m[0] + p.weight * p.source[0], m[1] + p.weight * p.source[1]]);
    let mt = pairs.iter().fold([0.0, 0.0], |m, p| [m[0] + p.weight * p.target[0], m[1] + p.weight * p.target[1]]);
    let ms = [ms[0] / sw, ms[1] / sw];
    let mt = [mt[0] / sw, mt[1] / sw];
    let theta = if allow_rotation && pairs.len() >= 3 {
        let (mut a, mut b) = (0.0, 0.0);
        for p in pairs {
            let sx = p.source[0] - ms[0]; let sy = p.source[1] - ms[1];
            let tx = p.target[0] - mt[0]; let ty = p.target[1] - mt[1];
            a += p.weight * (sx * ty - sy * tx);
            b += p.weight * (sx * tx + sy * ty);
        }
        if b == 0.0 && a == 0.0 { 0.0 } else { a.atan2(b) }
    } else { 0.0 };
    // p' = c + R (p − c) + d must take ms to mt: d = mt − c − R (ms − c).
    let (s, co) = theta.sin_cos();
    let rx = ms[0] - centre[0];
    let ry = ms[1] - centre[1];
    Some(Rigid2 {
        theta,
        dx: mt[0] - centre[0] - (co * rx - s * ry),
        dy: mt[1] - centre[1] - (s * rx + co * ry),
        cx: centre[0],
        cy: centre[1],
    })
}

/// What the fine fit ended with.
#[derive(Clone, Debug, PartialEq)]
pub struct Refined {
    pub rigid: Rigid2,
    pub rmse: f64,
    pub matched: usize,
    /// Per anchor: the residual after the fit (m), or None when nothing
    /// was matched to it.
    pub residuals: Vec<Option<f64>>,
}

/// From a coarse transform, match each anchor to the target's structure
/// within a shrinking reach and refit, trimming what does not agree.
pub fn refine(anchors: &[[f64; 2]], stems: &Raster2, tops: Option<(&[[f64; 2]], &Raster2)>, start: Rigid2, allow_rotation: bool) -> Refined {
    let mut rigid = start;
    let reaches = [0.9, 0.6, 0.45, 0.35, 0.3, 0.3];
    let centre = [start.cx, start.cy];
    let mut last = Refined { rigid, rmse: f64::NAN, matched: 0, residuals: vec![None; anchors.len()] };
    for &reach in &reaches {
        let mut pairs: Vec<(usize, Pair)> = Vec::new();
        for (i, a) in anchors.iter().enumerate() {
            let (ax, ay) = rigid.apply(a[0], a[1]);
            if let Some((t, w)) = match_anchor(stems, ax, ay, reach) {
                pairs.push((i, Pair { source: *a, target: t, weight: w as f64 }));
            } else if let Some((ta, tr)) = tops {
                // No stem to be seen: the crown top, trusted less.
                let (tx, ty) = rigid.apply(ta[i][0], ta[i][1]);
                if let Some((t, _)) = match_anchor(tr, tx, ty, reach.max(1.0)) {
                    let d = [t[0] - tx, t[1] - ty];
                    pairs.push((i, Pair { source: *a, target: [ax + d[0], ay + d[1]], weight: 0.3 }));
                }
            }
        }
        // Sources go back to the untransformed anchors so the fit is the
        // whole transform, not an increment.
        let Some(fit) = fit_rigid(&pairs.iter().map(|p| p.1).collect::<Vec<_>>(), centre, allow_rotation) else { break };
        let res: Vec<f64> = pairs.iter().map(|(_, p)| { let (x, y) = fit.apply(p.source[0], p.source[1]); ((x - p.target[0]).powi(2) + (y - p.target[1]).powi(2)).sqrt() }).collect();
        let mut sorted = res.clone();
        sorted.sort_by(f64::total_cmp);
        let median = if sorted.is_empty() { 0.0 } else { sorted[sorted.len() / 2] };
        // Trim: a tree matched to the wrong structure disagrees with the
        // rest by far more than the rest disagree among themselves.
        let cut = (2.5 * median).max(0.15);
        let kept: Vec<Pair> = pairs.iter().zip(res.iter()).filter(|(_, &r)| r <= cut).map(|(p, _)| p.1).collect();
        let Some(fit) = fit_rigid(&kept, centre, allow_rotation) else { break };
        rigid = fit;
        let mut residuals = vec![None; anchors.len()];
        let mut se = 0.0;
        let mut n = 0usize;
        for ((i, p), _) in pairs.iter().zip(res.iter()) {
            let (x, y) = rigid.apply(p.source[0], p.source[1]);
            let r = ((x - p.target[0]).powi(2) + (y - p.target[1]).powi(2)).sqrt();
            residuals[*i] = Some(r);
            if r <= cut { se += r * r; n += 1; }
        }
        last = Refined { rigid, rmse: if n > 0 { (se / n as f64).sqrt() } else { f64::NAN }, matched: n, residuals };
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 33) as f64) / (1u64 << 31) as f64
    }

    /// A plot of stems, and a target raster of the same stems moved by a
    /// known transform, with clutter.
    fn forest(seed: u64, truth: &Rigid2, clutter: usize) -> (Vec<[f64; 2]>, Raster2) {
        let mut s = seed;
        let anchors: Vec<[f64; 2]> = (0..50).map(|_| [lcg(&mut s) * 40.0 - 20.0, lcg(&mut s) * 40.0 - 20.0]).collect();
        let mut raster = Raster2::new(-60.0, -60.0, VERT_CELL, 480, 480);
        for a in &anchors {
            let (x, y) = truth.apply(a[0], a[1]);
            // A stem: heavy cell, lighter ring around it.
            raster.add(x, y, 14.0);
            for k in 0..8 {
                let ang = k as f64 * std::f64::consts::FRAC_PI_4;
                raster.add(x + 0.2 * ang.cos(), y + 0.2 * ang.sin(), 6.0);
            }
        }
        for _ in 0..clutter {
            raster.add(lcg(&mut s) * 100.0 - 50.0, lcg(&mut s) * 100.0 - 50.0, (3.0 + 5.0 * lcg(&mut s)) as f32);
        }
        (anchors, raster)
    }

    #[test]
    fn a_rigid_transform_and_its_inverse_cancel() {
        let r = Rigid2 { theta: 0.3, dx: 12.0, dy: -7.0, cx: 3.0, cy: 4.0 };
        let (x, y) = r.apply(10.0, 20.0);
        let (bx, by) = r.inverse().apply(x, y);
        assert!((bx - 10.0).abs() < 1e-9 && (by - 20.0).abs() < 1e-9, "{bx} {by}");
    }

    #[test]
    fn the_votes_find_a_shift_of_tens_of_metres_through_clutter() {
        let truth = Rigid2 { theta: 0.0, dx: 17.3, dy: -9.8, cx: 0.0, cy: 0.0 };
        let (anchors, raster) = forest(3, &truth, 4000);
        let grid = vote(&anchors, &raster, 30.0, 0.2, &Rigid2::identity(0.0, 0.0));
        let p = peak(&grid, 3.0).unwrap();
        assert!((p.dx - 17.3).abs() < 0.2, "{}", p.dx);
        assert!((p.dy + 9.8).abs() < 0.2, "{}", p.dy);
        assert!(p.score > 1.5 * p.second, "peak {} vs second {}", p.score, p.second);
    }

    #[test]
    fn the_fine_fit_recovers_shift_and_rotation_to_centimetres() {
        let truth = Rigid2 { theta: 1.2f64.to_radians(), dx: 0.7, dy: -0.4, cx: 0.0, cy: 0.0 };
        let (anchors, raster) = forest(11, &truth, 3000);
        let start = Rigid2 { theta: 0.0, dx: 0.5, dy: -0.2, cx: 0.0, cy: 0.0 };
        let r = refine(&anchors, &raster, None, start, true);
        let (ax, ay) = truth.apply(10.0, 5.0);
        let (bx, by) = r.rigid.apply(10.0, 5.0);
        assert!(((ax - bx).powi(2) + (ay - by).powi(2)).sqrt() < 0.06, "{} {} vs {} {}", ax, ay, bx, by);
        assert!((r.rigid.theta - truth.theta).abs() < 0.1f64.to_radians(), "{}", r.rigid.theta.to_degrees());
        assert!(r.matched >= 40, "{}", r.matched);
        assert!(r.rmse < 0.1, "{}", r.rmse);
    }

    #[test]
    fn without_rotation_the_fit_is_a_translation() {
        let pairs = vec![
            Pair { source: [0.0, 0.0], target: [1.0, 2.0], weight: 1.0 },
            Pair { source: [5.0, 0.0], target: [6.0, 2.0], weight: 1.0 },
            Pair { source: [0.0, 5.0], target: [1.0, 7.0], weight: 1.0 },
        ];
        let r = fit_rigid(&pairs, [0.0, 0.0], false).unwrap();
        assert_eq!(r.theta, 0.0);
        assert!((r.dx - 1.0).abs() < 1e-12 && (r.dy - 2.0).abs() < 1e-12);
        assert!(fit_rigid(&[], [0.0, 0.0], true).is_none());
    }

    #[test]
    fn a_stem_is_matched_to_the_heaviest_structure_and_a_bare_patch_to_nothing() {
        let mut raster = Raster2::new(0.0, 0.0, 0.25, 40, 40);
        raster.add(5.1, 5.1, 12.0);
        raster.add(5.35, 5.1, 6.0);
        raster.add(5.9, 5.1, 4.0); // a clump farther off
        let (t, w) = match_anchor(&raster, 5.0, 5.0, 0.6).unwrap();
        assert!(t[0] > 5.1 && t[0] < 5.3, "{:?}", t);
        assert!(w >= 18.0);
        assert!(match_anchor(&raster, 8.0, 8.0, 0.6).is_none());
    }

    #[test]
    fn canopy_tops_are_the_local_maxima_above_the_floor() {
        let mut chm = Raster2::new(0.0, 0.0, 0.5, 20, 20);
        for r in 0..20 { for c in 0..20 { chm.w[r * 20 + c] = 3.0; } }
        chm.w[10 * 20 + 10] = 22.0;
        chm.w[10 * 20 + 11] = 21.0;
        chm.w[2 * 20 + 2] = 18.5;
        let tops = canopy_tops(&chm, 5.0, 3);
        assert_eq!(tops.w.iter().filter(|&&w| w > 0.0).count(), 2);
        assert_eq!(tops.w[10 * 20 + 10], 1.0);
        assert_eq!(tops.w[2 * 20 + 2], 1.0);
        assert_eq!(vert_layer(0.5), None);
        assert_eq!(vert_layer(1.0), Some(0));
        assert_eq!(vert_layer(8.99), Some(15));
        assert_eq!(vert_layer(9.0), None);
        let mut w = vec![0.0f32; 2];
        verticality_weights(&[0b111, 0b11], &mut w);
        assert_eq!(w, vec![3.0, 0.0]);
    }
}
