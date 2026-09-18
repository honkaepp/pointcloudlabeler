// M3C2 — Lague, Brodu & Leroux 2013 (ISPRS J. 82:10-26), "Accurate 3D
// comparison of complex topography with terrestrial laser scanner:
// Application to the Rangitikei canyon". The standard method for signed
// change detection between two point clouds of the same scene at two
// epochs — here, plot re-scans a year apart: canopy/stem growth, sway,
// blowdown.
//
// Per core point:
//   1. a local surface NORMAL N from PCA over the compared cloud within
//      the "normal scale" D (oriented +z so growth reads positive);
//   2. project both clouds' points that fall inside a CYLINDER (radius
//      = projection scale / 2, half-length `max_depth`, axis N) onto N,
//      giving mean positions i1 (reference) and i2 (compared) with their
//      spreads σ1, σ2 and counts n1, n2;
//   3. the signed M3C2 distance  L = i2 − i1  along N;
//   4. the 95 % level of detection, the paper's eq. 1
//        LOD = 1.96·( √(σ1²/n1 + σ2²/n2) + reg_error )
//      — |L| > LOD marks a statistically significant change; smaller is
//      within registration + roughness noise.
//
//      The registration error is INSIDE the 1.96, not added after it.
//      This module had it outside, which under-states the detection
//      floor by 0.96·reg — 9.6 mm at a 1 cm declared registration
//      error — and the floor is the entire output: every core point
//      between the true LOD and the under-stated one was reported as
//      real change when the method says it is noise. CloudCompare's
//      qM3C2, the reference implementation, computes
//      `1.96 * (sqrt(LODStdDev) + registrationRms)`.
//
// Pure geometry (PCA + cylinder projection + stats), no octree/IO here —
// the octree command decimates the core points, gathers the two clouds
// and renders the result; this module is the tested algorithm.

// Fixed-dimension (3×3 / xyz) index loops read clearer than iterator
// adaptors throughout this numeric module.
#![allow(clippy::needless_range_loop)]

use std::collections::HashMap;

pub struct M3C2Params {
    /// Normal scale D (m): PCA neighbourhood *diameter* for the normal.
    pub normal_scale: f32,
    /// Projection scale d (m): cylinder *diameter* the points are gathered in.
    pub projection_scale: f32,
    /// Cylinder half-length (m) along the normal each way.
    pub max_depth: f32,
    /// Registration error (m) added into the level of detection.
    pub reg_error: f32,
}

#[derive(Clone, Copy)]
pub struct M3C2Point {
    /// Signed distance along the normal (compared − reference); NaN when
    /// undefined (a cloud had no points in the cylinder).
    pub distance: f32,
    /// 95 % level of detection at this point.
    pub lod: f32,
    /// |distance| > lod — the change exceeds the noise floor.
    pub significant: bool,
    pub n_ref: u32,
    pub n_cmp: u32,
}

/// Uniform spatial hash with a radius query returning candidate indices in
/// the covering cell ring (the caller applies the exact test).
struct Hash {
    inv: f32,
    origin: [f32; 3],
    map: HashMap<(i32, i32, i32), Vec<u32>>,
}

impl Hash {
    fn build(pts: &[[f32; 3]], cell: f32) -> Self {
        let inv = 1.0 / cell.max(1e-4);
        let mut origin = [f32::INFINITY; 3];
        for q in pts {
            for a in 0..3 { if q[a] < origin[a] { origin[a] = q[a]; } }
        }
        if !origin[0].is_finite() { origin = [0.0; 3]; }
        let mut map: HashMap<(i32, i32, i32), Vec<u32>> = HashMap::new();
        for (i, q) in pts.iter().enumerate() {
            map.entry(Self::key(inv, &origin, q)).or_default().push(i as u32);
        }
        Hash { inv, origin, map }
    }

    fn key(inv: f32, origin: &[f32; 3], q: &[f32; 3]) -> (i32, i32, i32) {
        (
            ((q[0] - origin[0]) * inv).floor() as i32,
            ((q[1] - origin[1]) * inv).floor() as i32,
            ((q[2] - origin[2]) * inv).floor() as i32,
        )
    }

    fn query(&self, c: &[f32; 3], r: f32, out: &mut Vec<u32>) {
        out.clear();
        let (kx, ky, kz) = Self::key(self.inv, &self.origin, c);
        let rc = (r * self.inv).ceil() as i32;
        for dz in -rc..=rc {
            for dy in -rc..=rc {
                for dx in -rc..=rc {
                    if let Some(b) = self.map.get(&(kx + dx, ky + dy, kz + dz)) {
                        out.extend_from_slice(b);
                    }
                }
            }
        }
    }
}

/// Cyclic Jacobi eigen-decomposition of a symmetric 3×3 matrix. Returns
/// eigenvalues ASCENDING and eigenvectors as columns (`vecs[row][k]`), so
/// column 0 is the least-variance direction = the surface normal.
fn jacobi3(a_in: [[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut a = a_in;
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..24 {
        let mut off = 0.0;
        for &(p, q) in &[(0usize, 1usize), (0, 2), (1, 2)] { off += a[p][q] * a[p][q]; }
        if off < 1e-20 { break; }
        for &(p, q) in &[(0usize, 1usize), (0, 2), (1, 2)] {
            let apq = a[p][q];
            if apq.abs() < 1e-18 { continue; }
            let theta = (a[q][q] - a[p][p]) / (2.0 * apq);
            let t = if theta == 0.0 { 1.0 } else {
                let s = if theta > 0.0 { 1.0 } else { -1.0 };
                s / (theta.abs() + (theta * theta + 1.0).sqrt())
            };
            let c = 1.0 / (t * t + 1.0).sqrt();
            let s = t * c;
            let tau = s / (1.0 + c);
            let app = a[p][p];
            let aqq = a[q][q];
            a[p][p] = app - t * apq;
            a[q][q] = aqq + t * apq;
            a[p][q] = 0.0;
            a[q][p] = 0.0;
            for r in 0..3 {
                if r != p && r != q {
                    let arp = a[r][p];
                    let arq = a[r][q];
                    a[r][p] = arp - s * (arq + tau * arp);
                    a[p][r] = a[r][p];
                    a[r][q] = arq + s * (arp - tau * arq);
                    a[q][r] = a[r][q];
                }
            }
            for r in 0..3 {
                let vrp = v[r][p];
                let vrq = v[r][q];
                v[r][p] = vrp - s * (vrq + tau * vrp);
                v[r][q] = vrq + s * (vrp - tau * vrq);
            }
        }
    }
    let mut order = [0usize, 1, 2];
    order.sort_by(|&i, &j| a[i][i].partial_cmp(&a[j][j]).unwrap_or(std::cmp::Ordering::Equal));
    let vals = [a[order[0]][order[0]], a[order[1]][order[1]], a[order[2]][order[2]]];
    let mut vecs = [[0.0; 3]; 3];
    for k in 0..3 {
        for r in 0..3 { vecs[r][k] = v[r][order[k]]; }
    }
    (vals, vecs)
}

/// Local normal at `c` from PCA over `hash`'s points within radius
/// `normal_scale/2`. Oriented so nz ≥ 0 (growth upward reads positive).
/// `None` if too few neighbours for a stable normal.
fn normal_at(c: &[f32; 3], pts: &[[f32; 3]], hash: &Hash, normal_scale: f32, scratch: &mut Vec<u32>) -> Option<[f32; 3]> {
    let r = normal_scale * 0.5;
    let r2 = r * r;
    hash.query(c, r, scratch);
    let mut mean = [0f64; 3];
    let mut count = 0usize;
    let mut kept: Vec<u32> = Vec::new();
    for &j in scratch.iter() {
        let q = &pts[j as usize];
        let d2 = (q[0] - c[0]).powi(2) + (q[1] - c[1]).powi(2) + (q[2] - c[2]).powi(2);
        if d2 <= r2 {
            for a in 0..3 { mean[a] += q[a] as f64; }
            count += 1;
            kept.push(j);
        }
    }
    if count < 4 { return None; }
    let inv_n = 1.0 / count as f64;
    for a in 0..3 { mean[a] *= inv_n; }
    let mut cov = [[0f64; 3]; 3];
    for &j in &kept {
        let q = &pts[j as usize];
        let e = [q[0] as f64 - mean[0], q[1] as f64 - mean[1], q[2] as f64 - mean[2]];
        for i in 0..3 {
            for k in 0..3 { cov[i][k] += e[i] * e[k]; }
        }
    }
    let (_vals, vecs) = jacobi3(cov);
    let mut n = [vecs[0][0] as f32, vecs[1][0] as f32, vecs[2][0] as f32];
    let len = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    if len < 1e-9 { return None; }
    for x in n.iter_mut() { *x /= len; }
    if n[2] < 0.0 { for x in n.iter_mut() { *x = -*x; } } // orient +z
    Some(n)
}

/// Mean + sample-std of the along-normal projection `t = (q−c)·N` over the
/// cloud's points inside the cylinder (perp ≤ proj/2, |t| ≤ max_depth).
/// Returns (mean, std, count).
fn project_cylinder(
    c: &[f32; 3], n: &[f32; 3], pts: &[[f32; 3]], hash: &Hash,
    half_proj: f32, max_depth: f32, scratch: &mut Vec<u32>,
) -> (f64, f64, u32) {
    let query_r = (half_proj * half_proj + max_depth * max_depth).sqrt();
    hash.query(c, query_r, scratch);
    let hp2 = half_proj * half_proj;
    let mut ts: Vec<f64> = Vec::new();
    for &j in scratch.iter() {
        let q = &pts[j as usize];
        let e = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
        let t = e[0] * n[0] + e[1] * n[1] + e[2] * n[2];
        if t.abs() > max_depth { continue; }
        let perp2 = e[0] * e[0] + e[1] * e[1] + e[2] * e[2] - t * t;
        if perp2 <= hp2 { ts.push(t as f64); }
    }
    let n_pts = ts.len();
    if n_pts == 0 { return (f64::NAN, 0.0, 0); }
    let mean = ts.iter().sum::<f64>() / n_pts as f64;
    let var = if n_pts > 1 {
        ts.iter().map(|t| (t - mean).powi(2)).sum::<f64>() / (n_pts as f64 - 1.0)
    } else { 0.0 };
    (mean, var.sqrt(), n_pts as u32)
}

/// Compute M3C2 at each core point. `reference` is the "before" epoch,
/// `compared` the "after"; positive distance ⇒ the compared surface sits
/// farther along +normal (upward growth).
pub fn m3c2(reference: &[[f32; 3]], compared: &[[f32; 3]], core: &[[f32; 3]], p: &M3C2Params) -> Vec<M3C2Point> {
    m3c2_with(reference, compared, core, p, &|_, _| true)
}

/// Core points are worked in chunks of this many, across every thread;
/// the caller hears from `on_chunk` after each.
pub const CHUNK: usize = 16_384;

/// One core point's M3C2, against the two hashed clouds.
fn m3c2_at(
    c: &[f32; 3], reference: &[[f32; 3]], compared: &[[f32; 3]],
    h_ref: &Hash, h_cmp: &Hash, p: &M3C2Params,
    normal_scale: f32, half_proj: f32, max_depth: f32, scratch: &mut Vec<u32>,
) -> M3C2Point {
    let n = match normal_at(c, compared, h_cmp, normal_scale, scratch) {
        Some(n) => n,
        None => return M3C2Point { distance: f32::NAN, lod: f32::NAN, significant: false, n_ref: 0, n_cmp: 0 },
    };
    let (i1, s1, n1) = project_cylinder(c, &n, reference, h_ref, half_proj, max_depth, scratch);
    let (i2, s2, n2) = project_cylinder(c, &n, compared, h_cmp, half_proj, max_depth, scratch);
    if n1 == 0 || n2 == 0 {
        return M3C2Point { distance: f32::NAN, lod: f32::NAN, significant: false, n_ref: n1, n_cmp: n2 };
    }
    let distance = (i2 - i1) as f32;
    let spread = (s1 * s1 / n1 as f64 + s2 * s2 / n2 as f64).sqrt();
    let lod = (1.96 * (spread + p.reg_error as f64)) as f32;
    M3C2Point {
        distance,
        lod,
        significant: distance.abs() > lod,
        n_ref: n1,
        n_cmp: n2,
    }
}

/// M3C2 over the core points, in parallel and in chunks, with a word
/// after every chunk: `on_chunk(done, total)` is told how many core
/// points are finished, and returns false to stop — the points done so
/// far are returned, in core order, and nothing after them.
///
/// WHY. The whole plot's worth of core points went through ONE thread
/// with no word until the end. On a 438-million-point plot decimated to
/// ten centimetres that is tens of millions of core points, each asking
/// two clouds for every point in a three-metre cylinder — hours, while
/// the bar stood at 60 % and the button read "Comparing…". The work is
/// the same; it is now spread over every core, reported every chunk,
/// and stoppable between chunks.
pub fn m3c2_with(
    reference: &[[f32; 3]], compared: &[[f32; 3]], core: &[[f32; 3]], p: &M3C2Params,
    on_chunk: &(dyn Fn(usize, usize) -> bool + Sync),
) -> Vec<M3C2Point> {
    use rayon::prelude::*;
    let normal_scale = p.normal_scale.max(1e-3);
    let half_proj = (p.projection_scale.max(1e-3)) * 0.5;
    let max_depth = p.max_depth.max(1e-3);

    // One cell size that serves both the (small) normal query and the
    // (possibly long) cylinder query without a silly cell count.
    let cell = normal_scale.max(p.projection_scale).max(0.01);
    let h_ref = Hash::build(reference, cell);
    let h_cmp = Hash::build(compared, cell);

    let total = core.len();
    let mut out: Vec<M3C2Point> = Vec::with_capacity(total);
    for chunk in core.chunks(CHUNK.max(1)) {
        let part: Vec<M3C2Point> = chunk
            .par_iter()
            .map_init(Vec::<u32>::new, |scratch, c| {
                m3c2_at(c, reference, compared, &h_ref, &h_cmp, p, normal_scale, half_proj, max_depth, scratch)
            })
            .collect();
        out.extend(part);
        if !on_chunk(out.len(), total) { break; }
    }
    out
}

/// Voxel-centroid decimation of a point set — what turns the compared
/// cloud into the core points at the spacing the user asked for. One
/// point per occupied cell, at the mean of the points in it, in the
/// order the cells were first seen.
pub fn decimate(pts: &[[f32; 3]], cell: f32) -> Vec<[f32; 3]> {
    let inv = 1.0 / cell.max(1e-4);
    let mut sums: HashMap<(i32, i32, i32), ([f64; 3], u32)> = HashMap::new();
    let mut order: Vec<(i32, i32, i32)> = Vec::new();
    for q in pts {
        let k = ((q[0] * inv).floor() as i32, (q[1] * inv).floor() as i32, (q[2] * inv).floor() as i32);
        let e = sums.entry(k).or_insert_with(|| { order.push(k); ([0.0; 3], 0) });
        for a in 0..3 { e.0[a] += q[a] as f64; }
        e.1 += 1;
    }
    order.iter().map(|k| {
        let (s, n) = sums[k];
        [(s[0] / n as f64) as f32, (s[1] / n as f64) as f32, (s[2] / n as f64) as f32]
    }).collect()
}

#[cfg(test)]
mod stress_tests {
    use super::*;

    /// A planar patch with unit normal `n`, centred at `centre`, sampled
    /// on a regular grid in the plane. `jitter` displaces each point
    /// along the normal by a deterministic pseudo-random amount.
    fn plane(centre: [f32; 3], n: [f32; 3], half: f32, step: f32, jitter: f32, seed: u64)
        -> Vec<[f32; 3]>
    {
        // Any two vectors spanning the plane.
        let up = if n[2].abs() < 0.9 { [0.0f32, 0.0, 1.0] } else { [1.0f32, 0.0, 0.0] };
        let u = {
            let c = [n[1] * up[2] - n[2] * up[1], n[2] * up[0] - n[0] * up[2], n[0] * up[1] - n[1] * up[0]];
            let l = (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]).sqrt();
            [c[0] / l, c[1] / l, c[2] / l]
        };
        let v = [
            n[1] * u[2] - n[2] * u[1],
            n[2] * u[0] - n[0] * u[2],
            n[0] * u[1] - n[1] * u[0],
        ];
        let mut s = seed | 1;
        let mut rnd = move || {
            s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((s >> 33) as f32) / ((1u64 << 31) as f32) - 0.5
        };
        let steps = (half / step) as i32;
        let mut out = Vec::new();
        for a in -steps..=steps {
            for b in -steps..=steps {
                let (da, db) = (a as f32 * step, b as f32 * step);
                let j = if jitter > 0.0 { jitter * rnd() } else { 0.0 };
                out.push([
                    centre[0] + u[0] * da + v[0] * db + n[0] * j,
                    centre[1] + u[1] * da + v[1] * db + n[1] * j,
                    centre[2] + u[2] * da + v[2] * db + n[2] * j,
                ]);
            }
        }
        out
    }

    /// The chunked, parallel path is the single-threaded one's equal —
    /// same distances in the same order — and a stop between chunks
    /// returns exactly the chunks done.
    #[test]
    fn the_chunked_path_matches_and_stops_where_told() {
        // 141 × 141 points: more than one chunk, so the stop below has a
        // second chunk not to do.
        let before = plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 7.0, 0.1, 0.0, 1);
        let after = plane([0.0, 0.0, 0.05], [0.0, 0.0, 1.0], 7.0, 0.1, 0.0, 2);
        let p = params();
        let whole = m3c2(&before, &after, &after, &p);
        let chunked = m3c2_with(&before, &after, &after, &p, &|_, _| true);
        assert_eq!(whole.len(), chunked.len());
        for (a, b) in whole.iter().zip(&chunked) {
            assert!((a.distance - b.distance).abs() < 1e-6 || (a.distance.is_nan() && b.distance.is_nan()));
            assert_eq!(a.significant, b.significant);
        }
        // Stop after the first chunk: exactly CHUNK points come back (the
        // plane has more than that), all of them defined.
        assert!(after.len() > CHUNK, "fixture too small to need a second chunk: {}", after.len());
        let mut calls = 0usize;
        let calls_ref = std::sync::Mutex::new(&mut calls);
        let partial = m3c2_with(&before, &after, &after, &p, &|done, total| {
            **calls_ref.lock().unwrap() += 1;
            assert!(done <= total);
            false
        });
        assert_eq!(partial.len(), CHUNK);
        assert_eq!(calls, 1);
    }

    /// Core spacing: a 10 cm plane decimated at 50 cm has about 1/25 of
    /// the points, each the centroid of its cell.
    #[test]
    fn decimation_thins_to_one_point_per_cell() {
        let pts = plane([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 5.0, 0.1, 0.0, 3);
        let thin = decimate(&pts, 0.5);
        let ratio = pts.len() as f64 / thin.len() as f64;
        assert!(ratio > 20.0 && ratio < 30.0, "ratio {ratio} from {} → {}", pts.len(), thin.len());
        for q in &thin { assert!(q[2].abs() < 1e-6, "centroid left the plane: {q:?}"); }
        assert_eq!(decimate(&[], 0.5).len(), 0);
    }

    fn params() -> M3C2Params {
        M3C2Params { normal_scale: 0.6, projection_scale: 0.4, max_depth: 1.0, reg_error: 0.0 }
    }

    fn norm(v: [f32; 3]) -> [f32; 3] {
        let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        [v[0] / l, v[1] / l, v[2] / l]
    }

    /// The distance must be measured along the SURFACE normal, not along
    /// the vertical.
    ///
    /// This is the test that separates a real M3C2 from a height
    /// difference. Tilt a plane 30 degrees and move it 0.20 m along its
    /// OWN normal: the answer is 0.20. Measuring vertically instead
    /// gives 0.20/cos(30) = 0.231 — a plausible number, 15 % high, and
    /// on a sloping forest floor that error is systematic rather than
    /// noise.
    #[test]
    fn distance_follows_the_surface_normal_not_the_vertical() {
        let n = norm([0.5, 0.0, 0.866]); // 30 degrees off vertical
        let d = 0.20f32;
        let reference = plane([0.0, 0.0, 0.0], n, 1.5, 0.04, 0.0, 1);
        let compared = plane([n[0] * d, n[1] * d, n[2] * d], n, 1.5, 0.04, 0.0, 2);
        let core = [[0.0f32, 0.0, 0.0]];

        let out = m3c2(&reference, &compared, &core, &params());
        let got = out[0].distance;
        assert!(got.is_finite(), "a well-populated cylinder must produce a distance");
        assert!(
            (got - d).abs() < 0.01,
            "expected {d} m along the surface normal, got {got}              (a vertical measurement would give {})",
            d / 0.866,
        );
    }

    /// Sliding a plane WITHIN itself is not change along the normal, and
    /// must read as ~zero. An implementation that compared centroids in
    /// 3D instead of projecting onto the normal would report the slide
    /// as displacement — the same magnitude, entirely fictitious.
    #[test]
    fn a_slide_within_the_surface_is_not_change() {
        let n = [0.0f32, 0.0, 1.0];
        let reference = plane([0.0, 0.0, 0.0], n, 2.0, 0.04, 0.0, 3);
        // Shifted 0.5 m sideways, same plane.
        let compared = plane([0.5, 0.0, 0.0], n, 2.0, 0.04, 0.0, 4);
        let core = [[0.0f32, 0.0, 0.0]];

        let out = m3c2(&reference, &compared, &core, &params());
        assert!(
            out[0].distance.abs() < 0.005,
            "an in-plane slide is not normal-direction change, got {}",
            out[0].distance,
        );
    }

    /// Sign: the compared epoch farther along +normal is POSITIVE.
    /// A flipped sign turns growth into loss in every growth report, and
    /// the magnitude stays right, so nothing else looks wrong.
    #[test]
    fn growth_along_the_normal_is_positive() {
        let n = [0.0f32, 0.0, 1.0];
        let reference = plane([0.0, 0.0, 0.0], n, 1.5, 0.04, 0.0, 5);
        let grown = plane([0.0, 0.0, 0.15], n, 1.5, 0.04, 0.0, 6);
        let core = [[0.0f32, 0.0, 0.0]];

        let up = m3c2(&reference, &grown, &core, &params())[0].distance;
        assert!(up > 0.0, "compared above reference must be positive, got {up}");
        assert!((up - 0.15).abs() < 0.01, "magnitude wrong: {up}");

        // And the reverse must be the negation, not merely negative.
        let down = m3c2(&grown, &reference, &core, &params())[0].distance;
        assert!((down + up).abs() < 0.005, "swapping the epochs must negate: {up} vs {down}");
    }

    /// An empty cylinder must yield NaN, never 0.
    ///
    /// Zero is the dangerous answer: it reads as "measured, no change",
    /// and on a change map it colours as stable ground. NaN says "not
    /// measured", which is the truth.
    #[test]
    fn no_data_reads_as_unmeasured_rather_than_unchanged() {
        let n = [0.0f32, 0.0, 1.0];

        // Case 1: neither cloud reaches the core point, so not even the
        // normal can be estimated.
        let reference = plane([0.0, 0.0, 0.0], n, 1.0, 0.05, 0.0, 7);
        let compared = plane([0.0, 0.0, 0.05], n, 1.0, 0.05, 0.0, 8);
        let far = [[50.0f32, 50.0, 0.0]];
        let out = m3c2(&reference, &compared, &far, &params());
        assert!(out[0].distance.is_nan(), "got {} — zero would read as 'no change'", out[0].distance);
        assert!(!out[0].significant, "an unmeasured point cannot be a significant change");

        // Case 2 — the one that matters, and which case 1 does NOT
        // reach: the COMPARED epoch covers the core (so a normal is
        // estimated fine) while the REFERENCE has nothing in the
        // cylinder. This is an ordinary edge of a re-scan with different
        // coverage. There is no "before" to difference against, so there
        // is no distance; treating the missing side as zero would
        // fabricate a change exactly equal to the compared surface's
        // offset, which looks like a real measurement.
        let cmp_only = plane([0.0, 0.0, 0.30], n, 1.5, 0.04, 0.0, 9);
        let ref_elsewhere = plane([20.0, 20.0, 0.0], n, 1.5, 0.04, 0.0, 10);
        let core = [[0.0f32, 0.0, 0.30]];
        let out = m3c2(&ref_elsewhere, &cmp_only, &core, &params())[0];
        assert!(out.n_cmp > 0, "the compared cloud must be present, or this tests case 1 again");
        assert_eq!(out.n_ref, 0, "the reference side must genuinely be empty");
        assert!(
            out.distance.is_nan(),
            "one-sided coverage has no distance; got {} — a number here is invented",
            out.distance,
        );
        assert!(!out.significant);
    }

    /// The level of detection has to behave like a confidence interval:
    /// it GROWS with surface roughness and SHRINKS as more points
    /// support the estimate. A LOD that ignored the sample count would
    /// mark real change as insignificant on dense data — the failure
    /// that makes a change map say "nothing happened".
    #[test]
    fn level_of_detection_tracks_noise_and_sample_count() {
        let n = [0.0f32, 0.0, 1.0];
        let core = [[0.0f32, 0.0, 0.0]];

        let quiet_ref = plane([0.0, 0.0, 0.0], n, 1.5, 0.04, 0.002, 11);
        let quiet_cmp = plane([0.0, 0.0, 0.10], n, 1.5, 0.04, 0.002, 12);
        let noisy_ref = plane([0.0, 0.0, 0.0], n, 1.5, 0.04, 0.05, 13);
        let noisy_cmp = plane([0.0, 0.0, 0.10], n, 1.5, 0.04, 0.05, 14);

        let quiet = m3c2(&quiet_ref, &quiet_cmp, &core, &params())[0];
        let noisy = m3c2(&noisy_ref, &noisy_cmp, &core, &params())[0];
        assert!(
            noisy.lod > quiet.lod * 3.0,
            "a rougher surface must raise the detection floor: quiet {} vs noisy {}",
            quiet.lod, noisy.lod,
        );

        // Same roughness, four times the points: the floor must drop
        // roughly as 1/sqrt(n).
        let dense_ref = plane([0.0, 0.0, 0.0], n, 1.5, 0.02, 0.05, 15);
        let dense_cmp = plane([0.0, 0.0, 0.10], n, 1.5, 0.02, 0.05, 16);
        let dense = m3c2(&dense_ref, &dense_cmp, &core, &params())[0];
        assert!(dense.n_ref > noisy.n_ref * 2, "fixture should be much denser");
        assert!(
            dense.lod < noisy.lod,
            "more supporting points must lower the floor: {} points → {}, {} points → {}",
            noisy.n_ref, noisy.lod, dense.n_ref, dense.lod,
        );
    }

    /// `significant` must agree with the numbers beside it. The map
    /// colours by this flag and the popup shows the distance; if they can
    /// disagree, one of them is lying.
    #[test]
    fn significance_agrees_with_the_distance_and_the_floor() {
        let n = [0.0f32, 0.0, 1.0];
        let core = [[0.0f32, 0.0, 0.0]];
        for shift in [0.0f32, 0.002, 0.05, 0.30] {
            let r = plane([0.0, 0.0, 0.0], n, 1.5, 0.04, 0.01, 21);
            let c = plane([0.0, 0.0, shift], n, 1.5, 0.04, 0.01, 22);
            let out = m3c2(&r, &c, &core, &params())[0];
            assert_eq!(
                out.significant,
                out.distance.abs() > out.lod,
                "shift {shift}: flag {} but |{}| vs floor {}",
                out.significant, out.distance, out.lod,
            );
        }
    }

    /// A declared registration error must make detection MORE
    /// conservative. Getting this backwards would turn an admission of
    /// uncertainty into extra confidence.
    #[test]
    fn registration_error_raises_the_floor() {
        let n = [0.0f32, 0.0, 1.0];
        let core = [[0.0f32, 0.0, 0.0]];
        let r = plane([0.0, 0.0, 0.0], n, 1.5, 0.04, 0.005, 31);
        let c = plane([0.0, 0.0, 0.02], n, 1.5, 0.04, 0.005, 32);

        let bare = m3c2(&r, &c, &core, &params())[0];
        let mut p = params();
        p.reg_error = 0.10;
        let declared = m3c2(&r, &c, &core, &p)[0];

        assert!(declared.lod > bare.lod + 0.09, "reg error must be added to the floor");
        assert!((declared.distance - bare.distance).abs() < 1e-6, "it must not change the measurement");
        assert!(!declared.significant, "a 2 cm change must not survive a declared 10 cm registration error");
    }

    /// The level of detection is eq. 1 of the paper EXACTLY, with the
    /// registration error INSIDE the 1.96:
    ///
    /// ```text
    ///     LOD = 1.96 · ( √(σ1²/n1 + σ2²/n2) + reg )
    /// ```
    ///
    /// It used to be `1.96·√(…) + reg`, which under-states the floor by
    /// 0.96·reg — 9.6 mm at a 1 cm declared registration error. Every
    /// point between the two floors was reported as real change when the
    /// method calls it noise, and no test noticed because the previous
    /// one only checks that the floor goes UP.
    ///
    /// Two perfectly flat, noiseless planes make σ vanish, so the whole
    /// LOD is the registration term and the factor is measurable on its
    /// own rather than tangled up with the spread.
    #[test]
    fn the_registration_error_is_inside_the_confidence_factor() {
        let n = [0.0f32, 0.0, 1.0];
        let core = [[0.0f32, 0.0, 0.0]];
        // Noise 0 ⇒ σ1 = σ2 = 0 ⇒ LOD = 1.96 · reg, and nothing else.
        let r = plane([0.0, 0.0, 0.0], n, 1.5, 0.04, 0.0, 31);
        let c = plane([0.0, 0.0, 0.02], n, 1.5, 0.04, 0.0, 32);
        for reg in [0.005f32, 0.01, 0.05] {
            let mut p = params();
            p.reg_error = reg;
            let out = m3c2(&r, &c, &core, &p)[0];
            let want = 1.96 * reg;
            assert!(
                (out.lod - want).abs() < 1e-4,
                "reg {reg}: LOD {} should be 1.96·reg = {want} — off by {:.5} m,                  which is what putting reg outside the 1.96 costs",
                out.lod, (out.lod - want).abs(),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plane(z: f32) -> Vec<[f32; 3]> {
        let mut v = Vec::new();
        let mut x = -1.0f32;
        while x <= 1.0001 {
            let mut y = -1.0f32;
            while y <= 1.0001 {
                v.push([x, y, z]);
                y += 0.1;
            }
            x += 0.1;
        }
        v
    }

    #[test]
    fn measures_a_known_vertical_offset() {
        // Compared plane sits 0.5 m above the reference ⇒ M3C2 ≈ +0.5,
        // and (perfectly flat, so σ≈0) significant.
        let reference = plane(0.0);
        let compared = plane(0.5);
        let core = [[0.0f32, 0.0, 0.5]];
        let p = M3C2Params { normal_scale: 1.0, projection_scale: 0.5, max_depth: 3.0, reg_error: 0.0 };
        let r = m3c2(&reference, &compared, &core, &p);
        assert_eq!(r.len(), 1);
        assert!(r[0].n_ref > 0 && r[0].n_cmp > 0, "both clouds present in cylinder");
        assert!((r[0].distance - 0.5).abs() < 0.05, "distance {} ≈ 0.5", r[0].distance);
        assert!(r[0].significant, "0.5 m ≫ LOD should be significant");
    }

    #[test]
    fn identical_clouds_show_no_change() {
        let a = plane(0.0);
        let core = [[0.0f32, 0.0, 0.0]];
        // A little reg_error so the zero-noise LOD isn't exactly 0.
        let p = M3C2Params { normal_scale: 1.0, projection_scale: 0.5, max_depth: 3.0, reg_error: 0.02 };
        let r = m3c2(&a, &a, &core, &p);
        assert!(r[0].distance.abs() < 0.02, "no offset ⇒ ~0 distance: {}", r[0].distance);
        assert!(!r[0].significant, "identical clouds ⇒ not significant");
    }

    #[test]
    fn empty_cylinder_is_undefined() {
        let reference = plane(0.0);
        let compared = plane(0.0);
        // Core far away ⇒ nothing in the cylinder ⇒ NaN distance.
        let core = [[100.0f32, 100.0, 100.0]];
        let p = M3C2Params { normal_scale: 1.0, projection_scale: 0.5, max_depth: 1.0, reg_error: 0.0 };
        let r = m3c2(&reference, &compared, &core, &p);
        assert!(r[0].distance.is_nan(), "no neighbours ⇒ undefined");
        assert!(!r[0].significant);
    }
}
