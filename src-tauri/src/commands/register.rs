// PointCloudLabeler — Tree segmentation, editing and label transfer for close-range forest point clouds
// Copyright (C) 2026 Eppu Honkanen
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//! Fine registration of one point cloud onto another: the rigid
//! transform that puts a moving cloud on a reference, to the millimetre,
//! with the figure that says how sure that millimetre is.
//!
//! The Preprocessing module registers SCAN POSITIONS — the stations of
//! one scanner project, each with its pose in the project's manifest.
//! This module registers DATASETS: two clouds of one plot however they
//! were made — two TLS epochs, a TLS plot and the MLS walk through it, a
//! drone flight over both — put on each other in six degrees of
//! freedom. Every tool that pairs two clouds (M3C2, tree growth, the
//! skeleton transfer, the ALS ↔ TLS join) assumes they already sit on
//! each other, and none of them can tell a misregistration from a real
//! difference.
//!
//! What runs, and why each part is there:
//!
//!   • A PYRAMID. Both clouds voxel-decimated at a coarse cell first and
//!     a fine one last (8×, 4×, 2×, 1× the chosen voxel), each level
//!     starting from the one before. The coarse levels have the wide
//!     basin — a start half a metre off still converges — and the fine
//!     level has the precision; neither alone has both.
//!
//!   • SYMMETRIC POINT-TO-PLANE (Rusinkiewicz 2019, "A symmetric
//!     objective function for ICP"). Point-to-plane (Chen & Medioni 1991)
//!     minimises each source point's distance to the tangent plane of
//!     its nearest target point; the symmetric form uses the sum of the
//!     two normals and rotates both clouds half-way towards each other.
//!     It is exact — zero residual — for pairs on the same locally
//!     quadratic surface, where point-to-plane only is for the same
//!     plane, and it converges in fewer iterations from further away.
//!     Point-to-plane and point-to-point (Besl & McKay 1992) remain as
//!     choices, the last for clouds with no surfaces to speak of.
//!
//!   • A ROBUST KERNEL (Welsch by default; Cauchy, Tukey, or none) with
//!     its scale set each iteration from the median absolute residual.
//!     Two clouds of a forest never overlap entirely: the other cloud's
//!     occluded side, foliage that moved, a stem that fell. Those pairs
//!     get a weight near zero instead of pulling the fit, and no fixed
//!     threshold has to be guessed right.
//!
//!   • A GAUSS–NEWTON step on the six parameters (rotation vector about
//!     the moving cloud's centroid, translation), with the step halved
//!     while it does not reduce the cost, and the levelled (xyz + yaw)
//!     and translation-only variants as parameter masks — a scanner on
//!     its tribrach is level already, and not letting the fit tilt it is
//!     one less thing to go wrong.
//!
//!   • THE UNCERTAINTY. The transform is a least-squares estimate, so it
//!     has a covariance: σ²(JᵀWJ)⁻¹ at the solution, with σ² from the
//!     weighted residuals. Its diagonal is the standard error of each
//!     parameter — the "±" after the translation — and its scaled
//!     spectrum says what the geometry does not constrain at all
//!     (Gelfand et al. 2003): a flat field constrains height and tilt
//!     and nothing else, and a fit that converged there did not measure
//!     the horizontal shift, it chose one. Reported, not hidden.
//!
//! Pure geometry over slices of points; the dataset reading, the coarse
//! search by stems and crowns, and the writing of the moved copy are in
//! the octree command (`run_register`, `run_transform_dataset`).

// Fixed-dimension (3 × 3, 6 × 6) index loops read clearer than iterator
// adaptors throughout this numeric module, as in m3c2.rs.
#![allow(clippy::needless_range_loop)]

use rayon::prelude::*;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// =====================================================================
// Small linear algebra
// =====================================================================

pub type Mat3 = [[f64; 3]; 3];
pub type Vec3 = [f64; 3];

pub const IDENTITY3: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

#[inline] fn dot(a: Vec3, b: Vec3) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
#[inline] fn cross(a: Vec3, b: Vec3) -> Vec3 { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
#[inline] fn sub(a: Vec3, b: Vec3) -> Vec3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
#[inline] fn add(a: Vec3, b: Vec3) -> Vec3 { [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
#[inline] fn scale(a: Vec3, s: f64) -> Vec3 { [a[0] * s, a[1] * s, a[2] * s] }
#[inline] fn norm(a: Vec3) -> f64 { dot(a, a).sqrt() }
#[inline] fn normalise(a: Vec3) -> Option<Vec3> { let n = norm(a); if n > 0.0 && n.is_finite() { Some(scale(a, 1.0 / n)) } else { None } }

#[inline]
pub fn mat3_apply(m: &Mat3, v: Vec3) -> Vec3 {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

pub fn mat3_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for (i, row) in out.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    out
}

pub fn mat3_transpose(m: &Mat3) -> Mat3 {
    [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]]
}

/// Rodrigues: the rotation by the vector `w` (axis × angle, radians).
pub fn exp_so3(w: Vec3) -> Mat3 {
    let theta = norm(w);
    if theta < 1e-12 {
        // Second-order expansion, exact enough below the threshold.
        let k = skew(w);
        let mut r = IDENTITY3;
        for i in 0..3 { for j in 0..3 { r[i][j] += k[i][j] + 0.5 * (k[i][0] * k[0][j] + k[i][1] * k[1][j] + k[i][2] * k[2][j]); } }
        return r;
    }
    let a = scale(w, 1.0 / theta);
    let (s, c) = theta.sin_cos();
    let k = skew(a);
    let kk = mat3_mul(&k, &k);
    let mut r = IDENTITY3;
    for i in 0..3 { for j in 0..3 { r[i][j] += s * k[i][j] + (1.0 - c) * kk[i][j]; } }
    r
}

fn skew(v: Vec3) -> Mat3 {
    [[0.0, -v[2], v[1]], [v[2], 0.0, -v[0]], [-v[1], v[0], 0.0]]
}

/// Roll, pitch, yaw (degrees) of R = Rz(yaw) · Ry(pitch) · Rx(roll).
pub fn euler_zyx_deg(r: &Mat3) -> Vec3 {
    let yaw = r[1][0].atan2(r[0][0]);
    let pitch = (-r[2][0]).clamp(-1.0, 1.0).asin();
    let roll = r[2][1].atan2(r[2][2]);
    [roll.to_degrees(), pitch.to_degrees(), yaw.to_degrees()]
}

/// A rigid transform, p' = R·p + t.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rigid {
    pub r: Mat3,
    pub t: Vec3,
}

impl Rigid {
    pub const IDENTITY: Rigid = Rigid { r: IDENTITY3, t: [0.0; 3] };

    #[inline]
    pub fn apply(&self, p: Vec3) -> Vec3 { add(mat3_apply(&self.r, p), self.t) }

    /// self ∘ inner: `inner` first, then `self`.
    pub fn compose(&self, inner: &Rigid) -> Rigid {
        Rigid { r: mat3_mul(&self.r, &inner.r), t: add(mat3_apply(&self.r, inner.t), self.t) }
    }

    pub fn inverse(&self) -> Rigid {
        let rt = mat3_transpose(&self.r);
        Rigid { r: rt, t: scale(mat3_apply(&rt, self.t), -1.0) }
    }

    /// Rotation `r` about `centre`, then translation `t`: p' = R(p − c) + c + t.
    pub fn about(r: Mat3, t: Vec3, centre: Vec3) -> Rigid {
        Rigid { r, t: sub(add(centre, t), mat3_apply(&r, centre)) }
    }

    /// Yaw (radians, about +z) and a translation.
    pub fn yaw(yaw: f64, t: Vec3) -> Rigid {
        Rigid { r: exp_so3([0.0, 0.0, yaw]), t }
    }

    /// Row-major 4 × 4, the convention the scanner-project poses use.
    pub fn to_mat4(&self) -> Vec<f64> {
        vec![
            self.r[0][0], self.r[0][1], self.r[0][2], self.t[0],
            self.r[1][0], self.r[1][1], self.r[1][2], self.t[1],
            self.r[2][0], self.r[2][1], self.r[2][2], self.t[2],
            0.0, 0.0, 0.0, 1.0,
        ]
    }

    /// From a row-major 4 × 4. The rotation block must be a rotation —
    /// orthonormal, determinant +1 — within 1e-6: a scaled or mirrored
    /// matrix is refused, because a rigid move is all a dataset may get.
    pub fn from_mat4(m: &[f64]) -> Result<Rigid, String> {
        if m.len() != 16 { return Err(format!("a 4 × 4 matrix has 16 numbers, not {}", m.len())); }
        if m.iter().any(|v| !v.is_finite()) { return Err("the matrix has a non-finite entry".into()); }
        let r = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
        let t = [m[3], m[7], m[11]];
        let rtr = mat3_mul(&mat3_transpose(&r), &r);
        for i in 0..3 { for j in 0..3 {
            let want = if i == j { 1.0 } else { 0.0 };
            if (rtr[i][j] - want).abs() > 1e-6 { return Err("the rotation block is not orthonormal — a rigid transform has no scale or shear".into()); }
        } }
        if det3(&r) < 0.0 { return Err("the rotation block is a reflection".into()); }
        if (m[12] != 0.0) || (m[13] != 0.0) || (m[14] != 0.0) || (m[15] - 1.0).abs() > 1e-9 {
            return Err("the last row must be 0 0 0 1".into());
        }
        Ok(Rigid { r, t })
    }

    /// The same transform in a frame shifted by `o`: p_w = p + o.
    /// A transform measured on origin-relative points, carried to world
    /// coordinates (or back with the negated offset).
    pub fn shifted_frame(&self, o: Vec3) -> Rigid {
        // p_w' = R(p_w − o) + t + o
        Rigid { r: self.r, t: add(sub(self.t, mat3_apply(&self.r, o)), o) }
    }

    /// Angle of the rotation, radians.
    pub fn angle(&self) -> f64 {
        let tr = self.r[0][0] + self.r[1][1] + self.r[2][2];
        ((tr - 1.0) * 0.5).clamp(-1.0, 1.0).acos()
    }
}

fn det3(m: &Mat3) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

/// Eigen-decomposition of a symmetric n × n matrix (n ≤ 6) by cyclic
/// Jacobi rotations: the eigenvalues ascending and the matching unit
/// eigenvectors as columns.
pub fn jacobi_eigen(a: &[Vec<f64>]) -> (Vec<f64>, Vec<Vec<f64>>) {
    let n = a.len();
    let mut m: Vec<Vec<f64>> = a.to_vec();
    let mut v: Vec<Vec<f64>> = (0..n).map(|i| (0..n).map(|j| if i == j { 1.0 } else { 0.0 }).collect()).collect();
    for _sweep in 0..100 {
        let mut off = 0.0;
        for i in 0..n { for j in 0..n { if i != j { off += m[i][j] * m[i][j]; } } }
        if off < 1e-30 { break; }
        for p in 0..n {
            for q in p + 1..n {
                if m[p][q].abs() < 1e-300 { continue; }
                let theta = (m[q][q] - m[p][p]) / (2.0 * m[p][q]);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let t = if theta == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..n {
                    let mkp = m[k][p];
                    let mkq = m[k][q];
                    m[k][p] = c * mkp - s * mkq;
                    m[k][q] = s * mkp + c * mkq;
                }
                for k in 0..n {
                    let mpk = m[p][k];
                    let mqk = m[q][k];
                    m[p][k] = c * mpk - s * mqk;
                    m[q][k] = s * mpk + c * mqk;
                }
                for row in v.iter_mut() {
                    let vp = row[p];
                    let vq = row[q];
                    row[p] = c * vp - s * vq;
                    row[q] = s * vp + c * vq;
                }
            }
        }
    }
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&x, &y| m[x][x].partial_cmp(&m[y][y]).unwrap_or(std::cmp::Ordering::Equal));
    let values: Vec<f64> = order.iter().map(|&i| m[i][i]).collect();
    let vectors: Vec<Vec<f64>> = (0..n).map(|row| order.iter().map(|&col| v[row][col]).collect()).collect();
    (values, vectors)
}

/// Solve the symmetric positive system `a x = b` by Gaussian elimination
/// with partial pivoting. None when a pivot vanishes.
fn solve_dense(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    let scale_ref = a.iter().flatten().fold(0.0f64, |m, v| m.max(v.abs()));
    if scale_ref <= 0.0 || !scale_ref.is_finite() { return None; }
    for col in 0..n {
        let mut piv = col;
        for r in col + 1..n { if a[r][col].abs() > a[piv][col].abs() { piv = r; } }
        if a[piv][col].abs() < 1e-13 * scale_ref { return None; }
        a.swap(col, piv);
        b.swap(col, piv);
        for r in col + 1..n {
            let f = a[r][col] / a[col][col];
            if f == 0.0 { continue; }
            for c in col..n { let v = a[col][c]; a[r][c] -= f * v; }
            b[r] -= f * b[col];
        }
    }
    let mut x = vec![0.0; n];
    for i in (0..n).rev() {
        let mut s = b[i];
        for j in i + 1..n { s -= a[i][j] * x[j]; }
        x[i] = s / a[i][i];
    }
    if x.iter().all(|v| v.is_finite()) { Some(x) } else { None }
}

/// Inverse of a symmetric positive matrix (n ≤ 6), by solving against
/// the identity. None when singular.
fn invert_dense(a: &[Vec<f64>]) -> Option<Vec<Vec<f64>>> {
    let n = a.len();
    let mut cols: Vec<Vec<f64>> = Vec::with_capacity(n);
    for j in 0..n {
        let mut e = vec![0.0; n];
        e[j] = 1.0;
        cols.push(solve_dense(a.to_vec(), e)?);
    }
    Some((0..n).map(|i| (0..n).map(|j| cols[j][i]).collect()).collect())
}

// =====================================================================
// A k-d tree over f64 points: nearest within a bound, and the k nearest
// =====================================================================

/// Points in tree order with their input indices; a node is the middle
/// of its range, the split axis cycles by depth. Built in parallel.
pub struct KdTree {
    pts: Vec<Vec3>,
    ids: Vec<u32>,
}

const PARALLEL_BUILD_MIN: usize = 1 << 15;

impl KdTree {
    pub fn build(points: &[Vec3]) -> KdTree {
        let mut idx: Vec<u32> = (0..points.len() as u32).collect();
        build_rec(points, &mut idx, 0);
        let pts = idx.iter().map(|&i| points[i as usize]).collect();
        KdTree { pts, ids: idx }
    }

    pub fn len(&self) -> usize { self.pts.len() }
    pub fn is_empty(&self) -> bool { self.pts.is_empty() }

    /// The nearest point with squared distance below `max_d2`: its input
    /// index and the squared distance.
    pub fn nearest(&self, q: Vec3, max_d2: f64) -> Option<(u32, f64)> {
        if self.pts.is_empty() { return None; }
        let mut best = (u32::MAX, max_d2);
        self.search(0, self.pts.len(), 0, q, &mut best);
        if best.0 == u32::MAX { None } else { Some((self.ids[best.0 as usize], best.1)) }
    }

    fn search(&self, lo: usize, hi: usize, depth: usize, q: Vec3, best: &mut (u32, f64)) {
        if lo >= hi { return; }
        let mid = lo + (hi - lo) / 2;
        let p = self.pts[mid];
        let d = sub(p, q);
        let d2 = dot(d, d);
        if d2 < best.1 { *best = (mid as u32, d2); }
        let axis = depth % 3;
        let diff = q[axis] - p[axis];
        let (near, far) = if diff < 0.0 { ((lo, mid), (mid + 1, hi)) } else { ((mid + 1, hi), (lo, mid)) };
        self.search(near.0, near.1, depth + 1, q, best);
        if diff * diff < best.1 { self.search(far.0, far.1, depth + 1, q, best); }
    }

    /// Every point within `r2` (squared) of `q`, as (input index, squared
    /// distance), in tree order. `out` is cleared first.
    pub fn radius(&self, q: Vec3, r2: f64, out: &mut Vec<(u32, f64)>) {
        out.clear();
        if self.pts.is_empty() { return; }
        self.radius_rec(0, self.pts.len(), 0, q, r2, out);
        for e in out.iter_mut() { e.0 = self.ids[e.0 as usize]; }
    }

    fn radius_rec(&self, lo: usize, hi: usize, depth: usize, q: Vec3, r2: f64, out: &mut Vec<(u32, f64)>) {
        if lo >= hi { return; }
        let mid = lo + (hi - lo) / 2;
        let p = self.pts[mid];
        let d = sub(p, q);
        let d2 = dot(d, d);
        if d2 <= r2 { out.push((mid as u32, d2)); }
        let axis = depth % 3;
        let diff = q[axis] - p[axis];
        if diff <= 0.0 || diff * diff <= r2 { self.radius_rec(lo, mid, depth + 1, q, r2, out); }
        if diff >= 0.0 || diff * diff <= r2 { self.radius_rec(mid + 1, hi, depth + 1, q, r2, out); }
    }

    /// The `k` nearest points, nearest first, as (input index, squared
    /// distance). `out` is cleared first and reused across calls.
    pub fn knn(&self, q: Vec3, k: usize, out: &mut Vec<(u32, f64)>) {
        out.clear();
        if k == 0 || self.pts.is_empty() { return; }
        self.knn_rec(0, self.pts.len(), 0, q, k, out);
        for e in out.iter_mut() { e.0 = self.ids[e.0 as usize]; }
    }

    fn knn_rec(&self, lo: usize, hi: usize, depth: usize, q: Vec3, k: usize, out: &mut Vec<(u32, f64)>) {
        if lo >= hi { return; }
        let mid = lo + (hi - lo) / 2;
        let p = self.pts[mid];
        let d = sub(p, q);
        let d2 = dot(d, d);
        if out.len() < k || d2 < out[out.len() - 1].1 {
            let pos = out.partition_point(|e| e.1 <= d2);
            out.insert(pos, (mid as u32, d2));
            if out.len() > k { out.pop(); }
        }
        let axis = depth % 3;
        let diff = q[axis] - p[axis];
        let (near, far) = if diff < 0.0 { ((lo, mid), (mid + 1, hi)) } else { ((mid + 1, hi), (lo, mid)) };
        self.knn_rec(near.0, near.1, depth + 1, q, k, out);
        let bound = if out.len() < k { f64::INFINITY } else { out[out.len() - 1].1 };
        if diff * diff < bound { self.knn_rec(far.0, far.1, depth + 1, q, k, out); }
    }
}

fn build_rec(points: &[Vec3], idx: &mut [u32], depth: usize) {
    let n = idx.len();
    if n <= 1 { return; }
    let axis = depth % 3;
    let mid = n / 2;
    idx.select_nth_unstable_by(mid, |&a, &b| {
        points[a as usize][axis].partial_cmp(&points[b as usize][axis]).unwrap_or(std::cmp::Ordering::Equal)
    });
    let (left, right) = idx.split_at_mut(mid);
    let right = &mut right[1..];
    if n >= PARALLEL_BUILD_MIN {
        rayon::join(|| build_rec(points, left, depth + 1), || build_rec(points, right, depth + 1));
    } else {
        build_rec(points, left, depth + 1);
        build_rec(points, right, depth + 1);
    }
}

// =====================================================================
// Decimation and normals
// =====================================================================

type VoxelKey = (i32, i32, i32);

/// One point per occupied voxel of `cell` metres: the centroid of the
/// points in it. The output is sorted by voxel so it is the same for
/// the same input whatever the hash map did.
pub fn decimate(pts: &[Vec3], cell: f64) -> Vec<Vec3> {
    if cell <= 0.0 || !cell.is_finite() { return pts.to_vec(); }
    let inv = 1.0 / cell;
    let mut map: rustc_hash::FxHashMap<VoxelKey, (Vec3, u32)> = rustc_hash::FxHashMap::default();
    for &p in pts {
        if !(p[0].is_finite() && p[1].is_finite() && p[2].is_finite()) { continue; }
        let key = ((p[0] * inv).floor() as i32, (p[1] * inv).floor() as i32, (p[2] * inv).floor() as i32);
        let e = map.entry(key).or_insert(([0.0; 3], 0));
        e.0 = add(e.0, p);
        e.1 += 1;
    }
    let mut cells: Vec<(VoxelKey, (Vec3, u32))> = map.into_iter().collect();
    cells.sort_unstable_by_key(|(k, _)| *k);
    cells.into_iter().map(|(_, (s, n))| scale(s, 1.0 / n as f64)).collect()
}

/// At most `max_points`, by a uniform stride — the same points every time.
pub fn thin(pts: &[Vec3], max_points: usize) -> Vec<Vec3> {
    if max_points == 0 || pts.len() <= max_points { return pts.to_vec(); }
    let step = pts.len() as f64 / max_points as f64;
    (0..max_points).map(|i| pts[((i as f64 + 0.5) * step) as usize]).collect()
}

/// PCA normals over the `k` nearest neighbours: the smallest
/// eigenvector, with the surface variation λ₀/(λ₀+λ₁+λ₂) beside it.
/// NaN where the neighbourhood is too small or has no surface in it
/// (`max_variation` — a third is isotropic scatter, a tenth already a
/// rough surface; foliage is kept out of the plane terms by this).
pub fn normals(pts: &[Vec3], tree: &KdTree, k: usize, max_variation: f64) -> Vec<Vec3> {
    normals_with_variation(pts, tree, k, max_variation).into_iter().map(|(n, _)| n).collect()
}

/// `normals`, with each point's surface variation beside it (NaN where
/// there was no neighbourhood).
pub fn normals_with_variation(pts: &[Vec3], tree: &KdTree, k: usize, max_variation: f64) -> Vec<(Vec3, f64)> {
    let k = k.max(4);
    pts.par_iter()
        .map_init(Vec::new, |buf, &p| {
            tree.knn(p, k, buf);
            if buf.len() < 4 { return ([f64::NAN; 3], f64::NAN); }
            let mut c = [0.0; 3];
            for &(j, _) in buf.iter() { c = add(c, pts[j as usize]); }
            c = scale(c, 1.0 / buf.len() as f64);
            let mut cov = [[0.0; 3]; 3];
            for &(j, _) in buf.iter() {
                let d = sub(pts[j as usize], c);
                for a in 0..3 { for b in 0..3 { cov[a][b] += d[a] * d[b]; } }
            }
            let (vals, vecs) = jacobi_eigen(&cov.iter().map(|r| r.to_vec()).collect::<Vec<_>>());
            let sum = vals[0] + vals[1] + vals[2];
            if sum <= 0.0 || sum.is_nan() { return ([f64::NAN; 3], f64::NAN); }
            let variation = vals[0].max(0.0) / sum;
            if variation > max_variation { return ([f64::NAN; 3], variation); }
            let n = [vecs[0][0], vecs[1][0], vecs[2][0]];
            (normalise(n).unwrap_or([f64::NAN; 3]), variation)
        })
        .collect()
}

// =====================================================================
// Parameters and the report
// =====================================================================

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    /// Rusinkiewicz 2019: the sum of both normals, both clouds rotated half-way. Default.
    Symmetric,
    /// Chen & Medioni 1991: distance to the target's tangent plane.
    PointToPlane,
    /// Besl & McKay 1992: distance to the nearest point.
    PointToPoint,
    /// Segal et al. 2009, plane-to-plane: each point a disc of covariance, the Mahalanobis distance between the two.
    Gicp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Kernel {
    /// exp(−(r/c)²), c = 3σ. Default: a smooth, redescending weight.
    Welsch,
    /// 1 / (1 + (r/c)²), c = 2.385σ: heavier tails kept in.
    Cauchy,
    /// (1 − (r/c)²)² inside c = 4.685σ, zero outside: a hard cut.
    Tukey,
    /// Every pair within the correspondence distance weighs the same.
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Dof {
    /// Rotation and translation, six parameters. Default.
    Full,
    /// Translation and the rotation about the vertical only — a levelled instrument stays level.
    Levelled,
    /// Translation only.
    Translation,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterParams {
    /// The objective. Default symmetric.
    #[serde(default = "d_method")]
    pub method: Method,
    /// The robust weight. Default Welsch.
    #[serde(default = "d_kernel")]
    pub kernel: Kernel,
    /// The degrees of freedom. Default full.
    #[serde(default = "d_dof")]
    pub dof: Dof,
    /// The finest decimation cell, metres (default 0.05). The coarser levels are 2×, 4×, 8× it.
    #[serde(default = "d_voxel")]
    pub voxel: f64,
    /// Pyramid levels (default 4): voxel × 8, × 4, × 2, × 1.
    #[serde(default = "d_levels")]
    pub levels: u32,
    /// How far a correspondence may reach at the coarsest level, metres (default 1.0); halved per level, never below three cells.
    #[serde(default = "d_corr")]
    pub max_corr_dist: f64,
    /// Iterations at most per level (default 50).
    #[serde(default = "d_iters")]
    pub max_iters: u32,
    /// Neighbours for the normals (default 16).
    #[serde(default = "d_normal_k")]
    pub normal_k: u32,
    /// Pairs whose normals disagree by more than this, degrees, are dropped (default 45).
    #[serde(default = "d_angle")]
    pub max_normal_angle_deg: f64,
    /// The robust scale never shrinks below this, metres (default 0.002): the noise floor of the instruments.
    #[serde(default = "d_floor")]
    pub kernel_floor: f64,
    /// Points at most per cloud per level (default 1000000); more are thinned by a stride.
    #[serde(default = "d_max_points")]
    pub max_points: u32,
    /// Converged when a step rotates less than this, radians (default 1e-7)…
    #[serde(default = "d_rot_tol")]
    pub rot_tol: f64,
    /// …and moves less than this, metres (default 1e-6).
    #[serde(default = "d_trans_tol")]
    pub trans_tol: f64,
    /// Surface variation above which a neighbourhood has no normal (default 0.15).
    #[serde(default = "d_variation")]
    pub max_variation: f64,
    /// The side of the spatial blocks the jackknife covariance leaves out one at a time, metres (default 2.0).
    #[serde(default = "d_block")]
    pub jackknife_block: f64,
}

fn d_method() -> Method { Method::Symmetric }
fn d_kernel() -> Kernel { Kernel::Welsch }
fn d_dof() -> Dof { Dof::Full }
fn d_voxel() -> f64 { 0.05 }
fn d_levels() -> u32 { 4 }
fn d_corr() -> f64 { 1.0 }
fn d_iters() -> u32 { 50 }
fn d_normal_k() -> u32 { 16 }
fn d_angle() -> f64 { 45.0 }
fn d_floor() -> f64 { 0.002 }
fn d_max_points() -> u32 { 1_000_000 }
fn d_rot_tol() -> f64 { 1e-7 }
fn d_trans_tol() -> f64 { 1e-6 }
fn d_variation() -> f64 { 0.15 }
fn d_block() -> f64 { 2.0 }

impl Default for RegisterParams {
    fn default() -> Self {
        RegisterParams {
            method: d_method(), kernel: d_kernel(), dof: d_dof(), voxel: d_voxel(), levels: d_levels(),
            max_corr_dist: d_corr(), max_iters: d_iters(), normal_k: d_normal_k(), max_normal_angle_deg: d_angle(),
            kernel_floor: d_floor(), max_points: d_max_points(), rot_tol: d_rot_tol(), trans_tol: d_trans_tol(),
            max_variation: d_variation(), jackknife_block: d_block(),
        }
    }
}

impl RegisterParams {
    pub fn validate(&self) -> Result<(), String> {
        if !(self.voxel > 0.0 && self.voxel.is_finite()) { return Err("voxel must be positive".into()); }
        if !(1..=8).contains(&self.levels) { return Err("levels must be 1–8".into()); }
        if !(self.max_corr_dist > 0.0 && self.max_corr_dist.is_finite()) { return Err("maxCorrDist must be positive".into()); }
        if self.max_iters == 0 { return Err("maxIters must be at least 1".into()); }
        if !(self.max_normal_angle_deg > 0.0 && self.max_normal_angle_deg <= 180.0) { return Err("maxNormalAngleDeg must be in (0, 180]".into()); }
        if !(self.kernel_floor >= 0.0 && self.kernel_floor.is_finite()) { return Err("kernelFloor must be non-negative".into()); }
        if !(self.rot_tol >= 0.0 && self.trans_tol >= 0.0) { return Err("the tolerances must be non-negative".into()); }
        if !(self.max_variation > 0.0 && self.max_variation <= 1.0) { return Err("maxVariation must be in (0, 1]".into()); }
        if !(self.jackknife_block > 0.0 && self.jackknife_block.is_finite()) { return Err("jackknifeBlock must be positive".into()); }
        Ok(())
    }
}

/// What one pyramid level did.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelReport {
    pub voxel: f64,
    pub corr_dist: f64,
    pub reference_points: usize,
    pub moving_points: usize,
    pub iterations: u32,
    pub converged: bool,
    /// RMS plane distance of the inliers at the level's end, metres.
    pub rmse: f64,
    pub inliers: usize,
}

/// The registration, and how much to trust it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterReport {
    /// Moving → reference, in the frame the points came in.
    pub transform: Rigid,
    /// The moving cloud's centroid: the rotation is about it, and the
    /// translation and its error are where it moved.
    pub centre: Vec3,
    /// Where the centre moved, metres.
    pub translation: Vec3,
    /// Roll, pitch, yaw of the rotation, degrees.
    pub rotation_deg: Vec3,
    /// Standard error of each, from the covariance at the solution —
    /// which takes the residuals as independent.
    pub translation_std_err: Vec3,
    pub rotation_std_err_deg: Vec3,
    /// The same by a spatial block jackknife: the pairs cut into blocks
    /// of `jackknife_block` metres and the fit re-solved with each
    /// block left out (one Gauss–Newton step from the solution, which
    /// is the reduced solution to second order), so what neighbouring
    /// pairs share — a target point, a normal's neighbourhood, a stem's
    /// systematic lean — is counted once, not n times. NaN with fewer
    /// than eight blocks. The larger of the two is the one to quote.
    pub translation_std_err_blocks: Vec3,
    pub rotation_std_err_deg_blocks: Vec3,
    pub jackknife_blocks: usize,
    /// The uncertainty of a moved point at the cloud's RMS radius,
    /// metres: the larger standard errors combined — what M3C2 takes as
    /// its registration error.
    pub position_std_err: f64,
    /// RMS, median absolute and robust (1.4826 · MAD) plane distance of
    /// the final inliers, metres.
    pub rmse: f64,
    pub median_abs: f64,
    pub sigma: f64,
    /// Pairs that weighed in at the end, and their share of the moving
    /// cloud's points at the finest level.
    pub inliers: usize,
    pub inlier_fraction: f64,
    /// Moving points that found a target within reach at all.
    pub overlap_fraction: f64,
    pub iterations: u32,
    pub converged: bool,
    pub levels: Vec<LevelReport>,
    /// Condition number of the scaled normal matrix (Gelfand et al.
    /// 2003): rotation in metres at the cloud's RMS radius, so the six
    /// are comparable. Below ~100 every direction is constrained.
    pub condition: f64,
    /// What the weakest direction mostly is.
    pub weakest: String,
    pub well_constrained: bool,
    /// Histogram of the final signed plane residuals: `hist_bins` counts
    /// from `hist_min`, each `hist_width` wide.
    pub hist_min: f64,
    pub hist_width: f64,
    pub hist_bins: Vec<u32>,
}

// =====================================================================
// The registration
// =====================================================================

/// One correspondence after rejection: the moving point (transformed,
/// centred), its target (centred), the unit normal the residual is
/// along, and the signed residual.
#[derive(Clone, Copy)]
struct Row {
    p: Vec3,
    q: Vec3,
    /// The unit normal the objective's residual is along (the target's,
    /// or the symmetric sum); zero for the point objectives.
    n: Vec3,
    /// The moving point's own normal, rotated into place — the
    /// plane-to-plane objective's other covariance.
    np: Vec3,
    /// The objective's residual: what the kernel and the step see.
    r: f64,
    /// The plane distance to the target's normal (the point distance
    /// when there is none): what the figures report, the same for
    /// every objective.
    plane: f64,
    /// For the symmetric objective: the agreement of the two normals,
    /// a weight; 1 elsewhere.
    agree: f64,
}

/// Segal et al. 2009: a surface's covariance is a disc — ε along the
/// normal, 1 across it.
const GICP_EPSILON: f64 = 0.001;

/// The plane-to-plane covariance of a point with normal `n`.
fn disc_cov(n: Vec3) -> Mat3 {
    let mut c = IDENTITY3;
    for i in 0..3 { for j in 0..3 { c[i][j] -= (1.0 - GICP_EPSILON) * n[i] * n[j]; } }
    c
}

fn inv3(m: &Mat3) -> Option<Mat3> {
    let d = det3(m);
    if d.abs() <= 1e-300 || !d.is_finite() { return None; }
    let inv = 1.0 / d;
    Some([
        [(m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv, (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv, (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv],
        [(m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv, (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv, (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv],
        [(m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv, (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv, (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv],
    ])
}

/// The plane-to-plane information matrix of a pair: (C_q + C_p)⁻¹.
fn gicp_information(row: &Row) -> Mat3 {
    let cq = disc_cov(row.n);
    let cp = disc_cov(row.np);
    let mut sum = [[0.0; 3]; 3];
    for i in 0..3 { for j in 0..3 { sum[i][j] = cq[i][j] + cp[i][j]; } }
    inv3(&sum).unwrap_or(IDENTITY3)
}

/// What the finest level ends with: its rows and weights, the moving
/// points that found a target, the moving count, and the robust scale.
type FinalState = (Vec<Row>, Vec<f64>, usize, usize, f64);

fn parameter_mask(dof: Dof) -> [bool; 6] {
    match dof {
        Dof::Full => [true; 6],
        Dof::Levelled => [false, false, true, true, true, true],
        Dof::Translation => [false, false, false, true, true, true],
    }
}

fn kernel_weight(kernel: Kernel, r: f64, sigma: f64) -> f64 {
    match kernel {
        Kernel::None => 1.0,
        Kernel::Welsch => { let c = 3.0 * sigma; (-(r / c) * (r / c)).exp() }
        Kernel::Cauchy => { let c = 2.3849 * sigma; 1.0 / (1.0 + (r / c) * (r / c)) }
        Kernel::Tukey => { let c = 4.6851 * sigma; let u = r / c; if u.abs() >= 1.0 { 0.0 } else { (1.0 - u * u).powi(2) } }
    }
}

fn median_abs(v: &mut [f64]) -> f64 {
    if v.is_empty() { return f64::NAN; }
    for x in v.iter_mut() { *x = x.abs(); }
    let mid = v.len() / 2;
    let (_, m, _) = v.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    *m
}

/// The rows for the moving points under `cur` against the target.
#[allow(clippy::too_many_arguments)]
fn correspondences(
    moving: &[Vec3], moving_normals: Option<&[Vec3]>, target: &[Vec3], target_normals: Option<&[Vec3]>, tree: &KdTree,
    cur: &Rigid, centre: Vec3, corr: f64, cos_max: f64, method: Method,
) -> (Vec<Row>, usize) {
    let max_d2 = corr * corr;
    let found = std::sync::atomic::AtomicUsize::new(0);
    let rows: Vec<Row> = moving.par_iter().enumerate().filter_map(|(i, &p0)| {
        let p = cur.apply(p0);
        let (j, d2) = tree.nearest(p, max_d2)?;
        found.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let q = target[j as usize];
        let pc = sub(p, centre);
        let qc = sub(q, centre);
        match method {
            Method::PointToPoint => {
                let d = d2.sqrt();
                Some(Row { p: pc, q: qc, n: [0.0; 3], np: [0.0; 3], r: d, plane: d, agree: 1.0 })
            }
            Method::PointToPlane => {
                let nq = target_normals?[j as usize];
                if !nq[0].is_finite() { return None; }
                let plane = dot(sub(p, q), nq);
                Some(Row { p: pc, q: qc, n: nq, np: [0.0; 3], r: plane, plane, agree: 1.0 })
            }
            Method::Symmetric | Method::Gicp => {
                let nq = target_normals?[j as usize];
                if !nq[0].is_finite() { return None; }
                let np0 = moving_normals?[i];
                if !np0[0].is_finite() { return None; }
                let mut np = mat3_apply(&cur.r, np0);
                let mut agree = dot(np, nq);
                if agree < 0.0 { np = scale(np, -1.0); agree = -agree; }
                if agree < cos_max { return None; }
                let plane = dot(sub(p, q), nq);
                if method == Method::Gicp {
                    let row = Row { p: pc, q: qc, n: nq, np, r: 0.0, plane, agree: 1.0 };
                    let m = gicp_information(&row);
                    let d = sub(p, q);
                    let r = dot(d, mat3_apply(&m, d)).max(0.0).sqrt();
                    return Some(Row { r, ..row });
                }
                let n = normalise(add(np, nq))?;
                Some(Row { p: pc, q: qc, n, np, r: dot(sub(p, q), n), plane, agree })
            }
        }
    }).collect();
    (rows, found.load(std::sync::atomic::Ordering::Relaxed))
}

/// The weighted normal equations H δ = −g over the rows, in the six
/// parameters (ω about the centre, τ), plus the weighted cost.
type NormalEq = ([[f64; 6]; 6], [f64; 6], f64);

/// One pair's share of the normal equations: w JᵀJ, w Jᵀr and w r².
fn row_normal_eq(row: &Row, w: f64, method: Method, h: &mut [[f64; 6]; 6], g: &mut [f64; 6], cost: &mut f64) {
    match method {
        Method::PointToPoint => {
            // d = p − q; ∂(p + ω×p + τ)/∂ω = −[p]×, ∂/∂τ = I.
            let d = sub(row.p, row.q);
            let jw = [
                [0.0, row.p[2], -row.p[1]],
                [-row.p[2], 0.0, row.p[0]],
                [row.p[1], -row.p[0], 0.0],
            ];
            for axis in 0..3 {
                let mut j = [0.0; 6];
                j[0] = jw[axis][0]; j[1] = jw[axis][1]; j[2] = jw[axis][2];
                j[3 + axis] = 1.0;
                accumulate(h, g, cost, &j, d[axis], w);
            }
        }
        Method::Gicp => {
            // The same rows, weighted by the pair's information matrix
            // M: H += w JᵀMJ, g += w JᵀMd, cost += w dᵀMd.
            let d = sub(row.p, row.q);
            let m = gicp_information(row);
            let jw = [
                [0.0, row.p[2], -row.p[1]],
                [-row.p[2], 0.0, row.p[0]],
                [row.p[1], -row.p[0], 0.0],
            ];
            let mut j = [[0.0f64; 6]; 3];
            for axis in 0..3 {
                j[axis][0] = jw[axis][0]; j[axis][1] = jw[axis][1]; j[axis][2] = jw[axis][2];
                j[axis][3 + axis] = 1.0;
            }
            let md = mat3_apply(&m, d);
            for a in 0..6 {
                let mut ja_m = [0.0; 3];
                for k in 0..3 { for l in 0..3 { ja_m[l] += j[k][a] * m[k][l]; } }
                g[a] += w * (ja_m[0] * d[0] + ja_m[1] * d[1] + ja_m[2] * d[2]);
                for b in 0..6 {
                    h[a][b] += w * (ja_m[0] * j[0][b] + ja_m[1] * j[1][b] + ja_m[2] * j[2][b]);
                }
            }
            *cost += w * dot(d, md);
        }
        Method::PointToPlane => {
            let c = cross(row.p, row.n);
            let j = [c[0], c[1], c[2], row.n[0], row.n[1], row.n[2]];
            accumulate(h, g, cost, &j, row.r, w);
        }
        Method::Symmetric => {
            let c = cross(add(row.p, row.q), row.n);
            let j = [c[0], c[1], c[2], row.n[0], row.n[1], row.n[2]];
            accumulate(h, g, cost, &j, row.r, w);
        }
    }
}

fn normal_equations(rows: &[Row], weights: &[f64], method: Method) -> NormalEq {
    // Summed per fixed chunk in parallel and across the chunks in
    // order, so the same rows give the same bits every run: a parallel
    // reduce would add the terms in whatever order the threads finished.
    let parts: Vec<NormalEq> = rows.par_chunks(CHUNK).zip(weights.par_chunks(CHUNK)).map(|(rows, weights)| {
        rows.iter().zip(weights.iter()).fold(([[0.0f64; 6]; 6], [0.0f64; 6], 0.0f64), |(mut h, mut g, mut cost), (row, &w)| {
            if w > 0.0 { row_normal_eq(row, w, method, &mut h, &mut g, &mut cost); }
            (h, g, cost)
        })
    }).collect();
    parts.into_iter().fold(([[0.0f64; 6]; 6], [0.0f64; 6], 0.0f64), |(mut ha, mut ga, ca), (hb, gb, cb)| {
        for i in 0..6 { for j in 0..6 { ha[i][j] += hb[i][j]; } ga[i] += gb[i]; }
        (ha, ga, ca + cb)
    })
}

/// The spatial block jackknife of the solution: the rows cut into cubes
/// of `block` metres, and for each block the one-step solution with
/// that block left out. Returns the standard error of each parameter
/// (zero where masked) and the number of blocks; NaN with fewer than
/// eight. With g ≈ 0 at the solution, the step on the reduced data is
/// (H − H_b)⁻¹ g_b.
fn block_jackknife(rows: &[Row], weights: &[f64], method: Method, mask: &[bool; 6], block: f64, h: &[[f64; 6]; 6]) -> ([f64; 6], usize) {
    let inv = 1.0 / block;
    let mut blocks: rustc_hash::FxHashMap<VoxelKey, NormalEq> = rustc_hash::FxHashMap::default();
    for (row, &w) in rows.iter().zip(weights.iter()) {
        if w <= 0.0 { continue; }
        let key = ((row.p[0] * inv).floor() as i32, (row.p[1] * inv).floor() as i32, (row.p[2] * inv).floor() as i32);
        let e = blocks.entry(key).or_insert(([[0.0; 6]; 6], [0.0; 6], 0.0));
        row_normal_eq(row, w, method, &mut e.0, &mut e.1, &mut e.2);
    }
    let mut keys: Vec<VoxelKey> = blocks.keys().cloned().collect();
    keys.sort_unstable();
    let b = keys.len();
    if b < 8 { return ([f64::NAN; 6], b); }
    let mut steps: Vec<[f64; 6]> = Vec::with_capacity(b);
    for k in &keys {
        let (hb, gb, _) = &blocks[k];
        let mut hr = *h;
        for i in 0..6 { for j in 0..6 { hr[i][j] -= hb[i][j]; } }
        let mut gneg = [0.0; 6];
        for i in 0..6 { gneg[i] = -gb[i]; }
        // solve_masked solves H δ = −g; the step wanted is (H − H_b)⁻¹ g_b.
        match solve_masked(&hr, &gneg, mask, 0.0) {
            Some(d) => steps.push(d),
            None => return ([f64::NAN; 6], b),
        }
    }
    let mut mean = [0.0; 6];
    for s in &steps { for i in 0..6 { mean[i] += s[i] / b as f64; } }
    let mut var = [0.0; 6];
    for s in &steps { for i in 0..6 { var[i] += (s[i] - mean[i]) * (s[i] - mean[i]); } }
    let f = (b as f64 - 1.0) / b as f64;
    let mut se = [0.0; 6];
    for i in 0..6 { se[i] = if mask[i] { (f * var[i]).sqrt() } else { 0.0 }; }
    (se, b)
}

/// Rows per parallel chunk of the sums.
const CHUNK: usize = 4096;

#[inline]
fn accumulate(h: &mut [[f64; 6]; 6], g: &mut [f64; 6], cost: &mut f64, j: &[f64; 6], r: f64, w: f64) {
    for a in 0..6 {
        g[a] += w * j[a] * r;
        for b in 0..6 { h[a][b] += w * j[a] * j[b]; }
    }
    *cost += w * r * r;
}

/// Solve the masked system; the step as the full six (zeros where masked).
fn solve_masked(h: &[[f64; 6]; 6], g: &[f64; 6], mask: &[bool; 6], damping: f64) -> Option<[f64; 6]> {
    let active: Vec<usize> = (0..6).filter(|&i| mask[i]).collect();
    let a: Vec<Vec<f64>> = active.iter().map(|&i| active.iter().map(|&j| h[i][j] * if i == j { 1.0 + damping } else { 1.0 }).collect()).collect();
    let b: Vec<f64> = active.iter().map(|&i| -g[i]).collect();
    let x = solve_dense(a, b)?;
    let mut out = [0.0; 6];
    for (k, &i) in active.iter().enumerate() { out[i] = x[k]; }
    Some(out)
}

/// The update a step means for the moving cloud, about the centre.
fn step_transform(delta: &[f64; 6], method: Method, centre: Vec3) -> Rigid {
    let w = [delta[0], delta[1], delta[2]];
    let t = [delta[3], delta[4], delta[5]];
    match method {
        Method::Symmetric => {
            // Both clouds rotated half-way: relative to the target the
            // moving cloud turns by the whole, and the translation,
            // measured between the half-turned pair, is carried by the
            // other half: p'' = R(ω)(R(ω)(p − c) + τ) + c.
            let half = exp_so3(w);
            Rigid::about(mat3_mul(&half, &half), mat3_apply(&half, t), centre)
        }
        _ => Rigid::about(exp_so3(w), t, centre),
    }
}

/// The weighted cost of the rows under `candidate`, with the weights
/// held — what a step is judged by.
fn cost_under(rows: &[Row], weights: &[f64], candidate: &Rigid, cur: &Rigid, centre: Vec3, method: Method) -> f64 {
    // The rows hold p transformed by `cur` (centred); the candidate is
    // cur followed by the step, so re-apply the step to p.
    let step = candidate.compose(&cur.inverse());
    let parts: Vec<f64> = rows.par_chunks(CHUNK).zip(weights.par_chunks(CHUNK)).map(|(rows, weights)| {
        rows.iter().zip(weights.iter()).map(|(row, &w)| {
            if w <= 0.0 { return 0.0; }
            let p = sub(step.apply(add(row.p, centre)), centre);
            match method {
                Method::PointToPoint => { let d = sub(p, row.q); w * dot(d, d) }
                Method::Gicp => { let d = sub(p, row.q); let m = gicp_information(row); w * dot(d, mat3_apply(&m, d)) }
                _ => { let r = dot(sub(p, row.q), row.n); w * r * r }
            }
        }).sum::<f64>()
    }).collect();
    parts.iter().sum()
}

/// Register `moving` onto `reference`: the rigid transform that puts the
/// moving points on the reference, from the start `init`. Both clouds in
/// one frame (origin-relative coordinates keep the arithmetic in f64's
/// comfortable range). `progress` is called with the fraction done and
/// may return false to stop; a stopped run is `Err("stopped")`.
pub fn register(
    reference: &[Vec3], moving: &[Vec3], init: Rigid, params: &RegisterParams, progress: &dyn Fn(f32) -> bool,
) -> Result<RegisterReport, String> {
    params.validate()?;
    if reference.len() < 10 || moving.len() < 10 {
        return Err(format!("too few points to register (reference {}, moving {})", reference.len(), moving.len()));
    }
    let centre = {
        let s = moving.iter().fold([0.0; 3], |a, &p| add(a, p));
        scale(s, 1.0 / moving.len() as f64)
    };
    let mask = parameter_mask(params.dof);
    let cos_max = params.max_normal_angle_deg.to_radians().cos();
    let mut cur = init;
    let mut levels: Vec<LevelReport> = Vec::new();
    let mut total_iters = 0u32;
    let mut converged_last = false;
    let n_levels = params.levels as usize;
    let mut final_state: Option<FinalState> = None;

    // The fine pass over the clouds is made once; every level is a
    // decimation of that, the coarsest first and the finest the pass
    // itself.
    let ref_base = decimate(reference, params.voxel);
    let mov_base = decimate(moving, params.voxel);
    for l in 0..n_levels {
        let voxel = params.voxel * (1u32 << (n_levels - 1 - l)) as f64;
        let ref_level = thin(&if l + 1 == n_levels { ref_base.clone() } else { decimate(&ref_base, voxel) }, params.max_points as usize);
        let mov_level = thin(&if l + 1 == n_levels { mov_base.clone() } else { decimate(&mov_base, voxel) }, params.max_points as usize);
        if ref_level.len() < 10 || mov_level.len() < 10 {
            return Err(format!("too few points at a {voxel:.3} m cell (reference {}, moving {})", ref_level.len(), mov_level.len()));
        }
        let corr = (params.max_corr_dist / (1u32 << l) as f64).max(3.0 * voxel);
        let tree = KdTree::build(&ref_level);
        let ref_normals = if params.method == Method::PointToPoint { None } else {
            Some(normals(&ref_level, &tree, params.normal_k as usize, params.max_variation))
        };
        let mov_normals = if matches!(params.method, Method::Symmetric | Method::Gicp) {
            let mt = KdTree::build(&mov_level);
            Some(normals(&mov_level, &mt, params.normal_k as usize, params.max_variation))
        } else { None };
        if let Some(n) = &ref_normals {
            if n.iter().filter(|v| v[0].is_finite()).count() < 10 {
                return Err("the reference has no surfaces a normal can be fitted to — try point-to-point".into());
            }
        }
        let floor = params.kernel_floor.max(0.05 * voxel);

        let mut converged = false;
        let mut iters = 0u32;
        let mut last_rows: Vec<Row> = Vec::new();
        let mut last_weights: Vec<f64> = Vec::new();
        let mut last_found = 0usize;
        let mut last_sigma = f64::NAN;
        for it in 0..params.max_iters {
            let done = (l as f32 + it as f32 / params.max_iters as f32) / n_levels as f32;
            if !progress(done) { return Err("stopped".into()); }
            let (rows, found) = correspondences(
                &mov_level, mov_normals.as_deref(), &ref_level, ref_normals.as_deref(), &tree, &cur, centre, corr, cos_max, params.method,
            );
            if rows.len() < 12 {
                return Err(format!(
                    "lost correspondence at a {voxel:.3} m cell ({} pairs within {corr:.3} m) — start closer, or widen the correspondence distance",
                    rows.len()
                ));
            }
            let mut abs: Vec<f64> = rows.iter().map(|r| r.r).collect();
            let sigma = (1.4826 * median_abs(&mut abs)).max(floor);
            let weights: Vec<f64> = rows.iter().map(|r| kernel_weight(params.kernel, r.r, sigma) * r.agree).collect();
            let (h, g, cost) = normal_equations(&rows, &weights, params.method);
            iters = it + 1;
            total_iters += 1;

            // The step, damped until the system solves, then halved
            // while it does not lower the cost on these pairs.
            let mut damping = 0.0;
            let mut delta = None;
            for _ in 0..6 {
                if let Some(d) = solve_masked(&h, &g, &mask, damping) { delta = Some(d); break; }
                damping = if damping == 0.0 { 1e-6 } else { damping * 100.0 };
            }
            let Some(mut delta) = delta else {
                return Err("the normal equations are singular — the geometry does not constrain the fit".into());
            };
            let mut accepted: Option<Rigid> = None;
            for _ in 0..5 {
                let step = step_transform(&delta, params.method, centre);
                let candidate = step.compose(&cur);
                if cost_under(&rows, &weights, &candidate, &cur, centre, params.method) < cost {
                    accepted = Some(candidate);
                    break;
                }
                for d in delta.iter_mut() { *d *= 0.5; }
            }
            last_rows = rows;
            last_weights = weights;
            last_found = found;
            last_sigma = sigma;
            let Some(next) = accepted else {
                // No step lowers the cost: the fit has arrived.
                converged = true;
                break;
            };
            let moved = next.compose(&cur.inverse());
            let rot = moved.angle();
            let trans = norm(sub(next.apply(centre), cur.apply(centre)));
            cur = next;
            // The coarse levels need not settle to the micrometre: their
            // tolerance is the finest level's, scaled by their cell.
            let tol_scale = voxel / params.voxel;
            if rot < params.rot_tol * tol_scale && trans < params.trans_tol * tol_scale {
                converged = true;
                break;
            }
        }
        // The rows above belong to the pose before the last step; score
        // the pose actually carried forward.
        let (rows, found) = correspondences(
            &mov_level, mov_normals.as_deref(), &ref_level, ref_normals.as_deref(), &tree, &cur, centre, corr, cos_max, params.method,
        );
        let (rows, weights, found, sigma) = if rows.len() >= 12 {
            let mut abs: Vec<f64> = rows.iter().map(|r| r.r).collect();
            let sigma = (1.4826 * median_abs(&mut abs)).max(floor);
            let weights: Vec<f64> = rows.iter().map(|r| kernel_weight(params.kernel, r.r, sigma) * r.agree).collect();
            (rows, weights, found, sigma)
        } else { (last_rows, last_weights, last_found, last_sigma) };
        let (rmse, inliers) = inlier_rmse(&rows, sigma);
        levels.push(LevelReport {
            voxel, corr_dist: corr, reference_points: ref_level.len(), moving_points: mov_level.len(),
            iterations: iters, converged, rmse, inliers,
        });
        converged_last = converged;
        final_state = Some((rows, weights, found, mov_level.len(), sigma));
    }
    progress(1.0);

    let (rows, weights, found, n_moving, sigma) = final_state.ok_or("no level ran")?;
    // The final figures are plane distances to the TARGET's normal for
    // every method, so a symmetric fit and a point-to-plane fit report
    // the same kind of number; point-to-point has only its distances.
    let residuals: Vec<f64> = rows.iter().map(|r| r.plane).collect();
    let (rmse, inliers) = inlier_rmse(&rows, sigma);
    let mut abs = residuals.clone();
    let median = median_abs(&mut abs);

    // The covariance at the solution: σ² (JᵀWJ)⁻¹ over the active
    // parameters, σ² from the weighted residuals and the weight sum.
    let (h, _g, cost) = normal_equations(&rows, &weights, params.method);
    let active: Vec<usize> = (0..6).filter(|&i| mask[i]).collect();
    let wsum: f64 = weights.iter().sum::<f64>() * if matches!(params.method, Method::PointToPoint | Method::Gicp) { 3.0 } else { 1.0 };
    let sigma2 = if wsum > active.len() as f64 + 1.0 { cost / (wsum - active.len() as f64) } else { f64::NAN };
    let ha: Vec<Vec<f64>> = active.iter().map(|&i| active.iter().map(|&j| h[i][j]).collect()).collect();
    let mut rot_se = [0.0; 3];
    let mut trans_se = [0.0; 3];
    if let Some(inv) = invert_dense(&ha) {
        for (k, &i) in active.iter().enumerate() {
            let se = (sigma2 * inv[k][k]).max(0.0).sqrt();
            if i < 3 { rot_se[i] = se.to_degrees(); } else { trans_se[i - 3] = se; }
        }
    } else {
        for &i in &active { if i < 3 { rot_se[i] = f64::NAN; } else { trans_se[i - 3] = f64::NAN; } }
    }

    // The block jackknife: what the pairs share, counted once.
    let (jk, jackknife_blocks) = block_jackknife(&rows, &weights, params.method, &mask, params.jackknife_block, &h);
    let rot_se_blocks = [jk[0].to_degrees(), jk[1].to_degrees(), jk[2].to_degrees()];
    let trans_se_blocks = [jk[3], jk[4], jk[5]];

    // Observability: the rotation block in metres at the RMS radius, so
    // a weak eigenvalue means a weak direction whatever its kind.
    let rho = {
        let s: f64 = mov_level_rms(&rows);
        if s > 0.0 { s } else { 1.0 }
    };
    // A moved point's uncertainty at that radius: the larger of the two
    // standard errors of each parameter, combined.
    let position_std_err = {
        let pick = |a: f64, b: f64| if b.is_finite() && b > a { b } else { a };
        let mut s2 = 0.0;
        for i in 0..3 {
            let t = pick(trans_se[i], trans_se_blocks[i]);
            let r = pick(rot_se[i], rot_se_blocks[i]).to_radians() * rho;
            s2 += t * t + r * r;
        }
        s2.sqrt()
    };
    let scaled: Vec<Vec<f64>> = active.iter().map(|&i| active.iter().map(|&j| {
        let si = if i < 3 { 1.0 / rho } else { 1.0 };
        let sj = if j < 3 { 1.0 / rho } else { 1.0 };
        h[i][j] * si * sj
    }).collect()).collect();
    let (vals, vecs) = jacobi_eigen(&scaled);
    let (condition, weakest) = if vals.is_empty() { (f64::NAN, String::new()) } else {
        let lmin = vals[0].max(0.0);
        let lmax = vals[vals.len() - 1];
        let cond = if lmin > 0.0 { lmax / lmin } else { f64::INFINITY };
        let v: Vec<f64> = (0..active.len()).map(|k| vecs[k][0]).collect();
        (cond, describe_direction(&active, &v))
    };
    let well_constrained = condition.is_finite() && condition < 100.0;

    // The histogram: 41 bins over ±4σ (at least ±1 cm).
    let half = (4.0 * sigma).max(0.01);
    let nb = 41usize;
    let width = 2.0 * half / nb as f64;
    let mut bins = vec![0u32; nb];
    for &r in &residuals {
        let k = ((r + half) / width).floor();
        if k >= 0.0 && (k as usize) < nb { bins[k as usize] += 1; }
    }

    let translation = sub(cur.apply(centre), centre);
    Ok(RegisterReport {
        transform: cur,
        centre,
        translation,
        rotation_deg: euler_zyx_deg(&cur.r),
        translation_std_err: trans_se,
        rotation_std_err_deg: rot_se,
        translation_std_err_blocks: trans_se_blocks,
        rotation_std_err_deg_blocks: rot_se_blocks,
        jackknife_blocks,
        position_std_err,
        rmse,
        median_abs: median,
        sigma,
        inliers,
        inlier_fraction: inliers as f64 / n_moving.max(1) as f64,
        overlap_fraction: found as f64 / n_moving.max(1) as f64,
        iterations: total_iters,
        converged: converged_last,
        levels,
        condition,
        weakest,
        well_constrained,
        hist_min: -half,
        hist_width: width,
        hist_bins: bins,
    })
}

/// RMS over the rows within 3σ, and their count.
fn inlier_rmse(rows: &[Row], sigma: f64) -> (f64, usize) {
    let lim = 3.0 * sigma;
    let mut s = 0.0;
    let mut n = 0usize;
    for r in rows { if r.r.abs() <= lim { s += r.plane * r.plane; n += 1; } }
    (if n > 0 { (s / n as f64).sqrt() } else { f64::NAN }, n)
}

fn mov_level_rms(rows: &[Row]) -> f64 {
    if rows.is_empty() { return 0.0; }
    (rows.iter().map(|r| dot(r.p, r.p)).sum::<f64>() / rows.len() as f64).sqrt()
}

/// "rotation about z (yaw)" / "translation along x" — the component the
/// unit vector `v` over the active parameters mostly points along, with
/// its share.
fn describe_direction(active: &[usize], v: &[f64]) -> String {
    let names = ["rotation about x (roll)", "rotation about y (pitch)", "rotation about z (yaw)", "translation along x", "translation along y", "translation along z"];
    let mut best = 0usize;
    for k in 0..v.len() { if v[k].abs() > v[best].abs() { best = k; } }
    let share = v[best] * v[best] / v.iter().map(|x| x * x).sum::<f64>().max(1e-300);
    if share >= 0.6 {
        names[active[best]].to_string()
    } else {
        let mut parts: Vec<(f64, usize)> = v.iter().enumerate().map(|(k, x)| (x * x, k)).collect();
        parts.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        format!("{} with {}", names[active[parts[0].1]], names[active[parts[1].1]])
    }
}

// =====================================================================
// Global alignment: FPFH features and RANSAC
// =====================================================================
//
// When the two clouds stand nowhere near each other — a heading
// unknown, an offset of a hundred metres — no local fit finds the way.
// Rusu et al. 2009 ("Fast Point Feature Histograms (FPFH) for 3D
// registration"): each point gets a 33-bin histogram of the angles
// between its normal and its neighbours' (invariant to where the cloud
// stands), points with alike histograms are paired across the clouds,
// and RANSAC over the pairs — three at a time, their mutual distances
// checked before any transform is tried — finds the rigid transform
// most pairs agree on. A start, not a fit: the pyramid takes it from
// there.

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GlobalParams {
    /// The decimation the features are computed on, metres (default 0.3).
    #[serde(default = "g_voxel")]
    pub voxel: f64,
    /// The radius the histograms gather neighbours in, metres (default 0 = five cells).
    #[serde(default)]
    pub feature_radius: f64,
    /// Points at most per cloud after decimation (default 40000) …
    #[serde(default = "g_max_points")]
    pub max_points: u32,
    /// … and keypoints at most per cloud that are paired (default 5000).
    #[serde(default = "g_max_keypoints")]
    pub max_keypoints: u32,
    /// Transform hypotheses at most (default 50000) — eight per feature pair, the pairs agreeing with the most others first; fewer when the pairs agree early.
    #[serde(default = "g_iterations")]
    pub iterations: u32,
    /// A pair agrees with a transform when it lands within this, metres (default 0 = 1.5 cells).
    #[serde(default)]
    pub inlier_dist: f64,
    /// Only pairs that are each other's nearest feature are kept (default true).
    #[serde(default = "g_true")]
    pub mutual: bool,
}

fn g_voxel() -> f64 { 0.3 }
fn g_max_points() -> u32 { 40_000 }
fn g_max_keypoints() -> u32 { 5_000 }
fn g_iterations() -> u32 { 50_000 }
fn g_true() -> bool { true }

impl Default for GlobalParams {
    fn default() -> Self {
        GlobalParams { voxel: g_voxel(), feature_radius: 0.0, max_points: g_max_points(), max_keypoints: g_max_keypoints(), iterations: g_iterations(), inlier_dist: 0.0, mutual: g_true() }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalReport {
    pub reference_keypoints: usize,
    pub moving_keypoints: usize,
    pub correspondences: usize,
    pub inliers: usize,
    pub inlier_fraction: f64,
    pub iterations: u32,
    /// RMS distance of the inlier pairs under the transform, metres.
    pub rmse: f64,
    /// The share of the moving cloud's cells that land within reach of a
    /// reference cell under the transform — what chose it among the
    /// best hypotheses.
    pub overlap: f64,
}

const FPFH_BINS: usize = 11;
const FPFH_DIM: usize = 3 * FPFH_BINS;

/// The simplified point feature histogram of every point: the Darboux
/// angles to each neighbour within `radius`, binned.
fn spfh(pts: &[Vec3], normals: &[Vec3], tree: &KdTree, radius: f64) -> Vec<[f32; FPFH_DIM]> {
    let r2 = radius * radius;
    pts.par_iter().enumerate().map_init(Vec::new, |buf, (i, &p)| {
        let mut h = [0f32; FPFH_DIM];
        let n1 = normals[i];
        if !n1[0].is_finite() { return h; }
        tree.radius(p, r2, buf);
        let mut count = 0u32;
        for &(j, _) in buf.iter() {
            if j as usize == i { continue; }
            let n2 = normals[j as usize];
            if !n2[0].is_finite() { continue; }
            if let Some((f1, f2, f3)) = pair_features(p, n1, pts[j as usize], n2) {
                let b1 = (((f1 + std::f64::consts::PI) / (2.0 * std::f64::consts::PI)) * FPFH_BINS as f64).floor().clamp(0.0, FPFH_BINS as f64 - 1.0) as usize;
                let b2 = (((f2 + 1.0) * 0.5) * FPFH_BINS as f64).floor().clamp(0.0, FPFH_BINS as f64 - 1.0) as usize;
                let b3 = (((f3 + 1.0) * 0.5) * FPFH_BINS as f64).floor().clamp(0.0, FPFH_BINS as f64 - 1.0) as usize;
                h[b1] += 1.0;
                h[FPFH_BINS + b2] += 1.0;
                h[2 * FPFH_BINS + b3] += 1.0;
                count += 1;
            }
        }
        if count > 0 { for v in h.iter_mut() { *v *= 100.0 / count as f32; } }
        h
    }).collect()
}

/// The three Darboux-frame angles of a pair (PCL's computePairFeatures).
fn pair_features(p1: Vec3, n1: Vec3, p2: Vec3, n2: Vec3) -> Option<(f64, f64, f64)> {
    let mut d = sub(p2, p1);
    let len = norm(d);
    if len <= 0.0 { return None; }
    let (mut na, mut nb) = (n1, n2);
    let a1 = dot(na, d) / len;
    let a2 = dot(nb, d) / len;
    let f3 = if a1.abs().acos() > a2.abs().acos() {
        std::mem::swap(&mut na, &mut nb);
        d = scale(d, -1.0);
        -a2
    } else { a1 };
    let v = normalise(cross(d, na))?;
    let w = cross(na, v);
    let f2 = dot(v, nb);
    let f1 = dot(w, nb).atan2(dot(na, nb));
    Some((f1, f2, f3))
}

/// FPFH: a point's own histogram plus its neighbours', weighted by the
/// inverse distance.
fn fpfh(pts: &[Vec3], s: &[[f32; FPFH_DIM]], tree: &KdTree, radius: f64) -> Vec<[f32; FPFH_DIM]> {
    let r2 = radius * radius;
    pts.par_iter().enumerate().map_init(Vec::new, |buf, (i, &p)| {
        let mut h = s[i];
        tree.radius(p, r2, buf);
        let mut acc = [0f32; FPFH_DIM];
        let mut k = 0u32;
        for &(j, d2) in buf.iter() {
            if j as usize == i || d2 <= 0.0 { continue; }
            let w = 1.0 / d2.sqrt() as f32;
            for b in 0..FPFH_DIM { acc[b] += w * s[j as usize][b]; }
            k += 1;
        }
        if k > 0 { for b in 0..FPFH_DIM { h[b] += acc[b] / k as f32; } }
        h
    }).collect()
}

fn feature_d2(a: &[f32; FPFH_DIM], b: &[f32; FPFH_DIM]) -> f32 {
    let mut s = 0.0;
    for k in 0..FPFH_DIM { let d = a[k] - b[k]; s += d * d; }
    s
}

/// For each feature in `from`, the `k` nearest in `to` by brute force,
/// nearest first.
fn nearest_features(from: &[[f32; FPFH_DIM]], to: &[[f32; FPFH_DIM]], k: usize) -> Vec<Vec<usize>> {
    from.par_iter().map(|f| {
        let mut best: Vec<(usize, f32)> = Vec::with_capacity(k + 1);
        for (j, t) in to.iter().enumerate() {
            let d = feature_d2(f, t);
            if best.len() < k || d < best[best.len() - 1].1 {
                let pos = best.partition_point(|e| e.1 <= d);
                best.insert(pos, (j, d));
                if best.len() > k { best.pop(); }
            }
        }
        best.into_iter().map(|(j, _)| j).collect()
    }).collect()
}

/// Kabsch: the rigid transform taking the first of each pair onto the
/// second in the least-squares sense. None for fewer than three pairs
/// or collinear ones.
pub fn kabsch(pairs: &[(Vec3, Vec3)]) -> Option<Rigid> {
    if pairs.len() < 3 { return None; }
    let n = pairs.len() as f64;
    let ca = scale(pairs.iter().fold([0.0; 3], |m, (a, _)| add(m, *a)), 1.0 / n);
    let cb = scale(pairs.iter().fold([0.0; 3], |m, (_, b)| add(m, *b)), 1.0 / n);
    let mut h = [[0.0; 3]; 3];
    for (a, b) in pairs {
        let da = sub(*a, ca);
        let db = sub(*b, cb);
        for i in 0..3 { for j in 0..3 { h[i][j] += da[i] * db[j]; } }
    }
    // SVD of H by the eigenvectors of HᵀH: H = U Σ Vᵀ, R = V Uᵀ.
    let hth = mat3_mul(&mat3_transpose(&h), &h);
    let (vals, vecs) = jacobi_eigen(&hth.iter().map(|r| r.to_vec()).collect::<Vec<_>>());
    // Descending.
    let order = [2usize, 1, 0];
    let mut v = [[0.0; 3]; 3];
    let mut u = [[0.0; 3]; 3];
    let mut sig = [0.0; 3];
    for (k, &c) in order.iter().enumerate() {
        sig[k] = vals[c].max(0.0).sqrt();
        for i in 0..3 { v[i][k] = vecs[i][c]; }
    }
    if sig[1] <= 1e-6 * sig[0].max(1e-300) { return None; }
    for k in 0..2 {
        let vk = [v[0][k], v[1][k], v[2][k]];
        let hv = mat3_apply(&h, vk);
        for i in 0..3 { u[i][k] = hv[i] / sig[k]; }
    }
    // The third columns: right-handed completions of the first two.
    let v3 = cross([v[0][0], v[1][0], v[2][0]], [v[0][1], v[1][1], v[2][1]]);
    let u3 = cross([u[0][0], u[1][0], u[2][0]], [u[0][1], u[1][1], u[2][1]]);
    for i in 0..3 { v[i][2] = v3[i]; u[i][2] = u3[i]; }
    let mut r = mat3_mul(&v, &mat3_transpose(&u));
    if det3(&r) < 0.0 {
        for i in 0..3 { v[i][2] = -v[i][2]; }
        r = mat3_mul(&v, &mat3_transpose(&u));
    }
    Some(Rigid { r, t: sub(cb, mat3_apply(&r, ca)) })
}

/// The global alignment of `moving` onto `reference`: a rigid transform
/// most feature pairs agree on, from any start. Both clouds in one
/// frame; the result is a start for `register`.
pub fn global_align(reference: &[Vec3], moving: &[Vec3], params: &GlobalParams, progress: &dyn Fn(f32) -> bool) -> Result<(Rigid, GlobalReport), String> {
    if !(params.voxel > 0.0 && params.voxel.is_finite()) { return Err("the feature voxel must be positive".into()); }
    let radius = if params.feature_radius > 0.0 { params.feature_radius } else { 5.0 * params.voxel };
    let inlier_dist = if params.inlier_dist > 0.0 { params.inlier_dist } else { 1.5 * params.voxel };
    let ref_d = thin(&decimate(reference, params.voxel), params.max_points as usize);
    let mov_d = thin(&decimate(moving, params.voxel), params.max_points as usize);
    if ref_d.len() < 50 || mov_d.len() < 50 {
        return Err(format!("too few points for features at a {} m cell (reference {}, moving {})", params.voxel, ref_d.len(), mov_d.len()));
    }
    if !progress(0.05) { return Err("stopped".into()); }
    let ref_tree = KdTree::build(&ref_d);
    let mov_tree = KdTree::build(&mov_d);
    let ref_nv = normals_with_variation(&ref_d, &ref_tree, 16, 0.4);
    let mov_nv = normals_with_variation(&mov_d, &mov_tree, 16, 0.4);
    let ref_n: Vec<Vec3> = ref_nv.iter().map(|(n, _)| *n).collect();
    let mov_n: Vec<Vec3> = mov_nv.iter().map(|(n, _)| *n).collect();
    if !progress(0.15) { return Err("stopped".into()); }
    let ref_f = fpfh(&ref_d, &spfh(&ref_d, &ref_n, &ref_tree, radius), &ref_tree, radius);
    let mov_f = fpfh(&mov_d, &spfh(&mov_d, &mov_n, &mov_tree, radius), &mov_tree, radius);
    if !progress(0.45) { return Err("stopped".into()); }

    // Keypoints: the points with a normal, the most structured first —
    // a plane says nothing about where it is, a stem's edge does.
    let keypoints = |nv: &[(Vec3, f64)]| -> Vec<usize> {
        let mut idx: Vec<usize> = (0..nv.len()).filter(|&i| nv[i].0[0].is_finite()).collect();
        idx.sort_by(|&a, &b| nv[b].1.partial_cmp(&nv[a].1).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b)));
        idx.truncate(params.max_keypoints as usize);
        idx
    };
    let ref_k = keypoints(&ref_nv);
    let mov_k = keypoints(&mov_nv);
    if ref_k.len() < 10 || mov_k.len() < 10 {
        return Err("too few points with a surface normal for features".into());
    }
    let ref_kf: Vec<[f32; FPFH_DIM]> = ref_k.iter().map(|&i| ref_f[i]).collect();
    let mov_kf: Vec<[f32; FPFH_DIM]> = mov_k.iter().map(|&i| mov_f[i]).collect();
    // Each moving keypoint paired with its nearest feature; with
    // `mutual`, only where the reference keypoint's nearest is it in
    // turn — alike surfaces pair with the wrong twin as readily as the
    // right one, and a mutual pair is the one both sides chose.
    let m2r = nearest_features(&mov_kf, &ref_kf, 1);
    let mut pairs: Vec<(Vec3, Vec3, Vec3, Vec3)> = Vec::new();
    if params.mutual {
        let r2m = nearest_features(&ref_kf, &mov_kf, 1);
        for (a, cands) in m2r.iter().enumerate() {
            let b = cands[0];
            if r2m[b][0] == a { pairs.push((mov_d[mov_k[a]], ref_d[ref_k[b]], mov_n[mov_k[a]], ref_n[ref_k[b]])); }
        }
    }
    if pairs.len() < 20 {
        pairs = m2r.iter().enumerate().map(|(a, c)| (mov_d[mov_k[a]], ref_d[ref_k[c[0]]], mov_n[mov_k[a]], ref_n[ref_k[c[0]]])).collect();
    }
    if !progress(0.6) { return Err("stopped".into()); }

    // Hypotheses from pairs that agree with each other. Three pairs drawn
    // at random are all right with probability w³ for a right-pair share
    // w, and on a plot of alike stems w is a few per cent — a hundred
    // thousand draws for one all-right triple. But right pairs agree
    // with every other right pair on the distance between their points
    // (the same two surfaces, the same two places), while a wrong pair
    // agrees with few. So each pair is a seed, the pairs agreeing with
    // the most others first, and its triples are drawn from the pairs
    // that agree with it and with each other: a right seed draws a
    // right triple one time in ten, not one in a hundred thousand.
    let n = pairs.len();
    let d_in2 = inlier_dist * inlier_dist;
    let d_loose2 = 4.0 * d_in2;
    let min_edge = 2.0 * params.voxel;
    // Two decimated points of one surface sit up to a cell apart, so
    // their distance is good to a cell or so each; a little more with
    // the distance itself.
    let tol = 1.5 * inlier_dist;
    let compat_of = |i: usize, j: usize| -> bool {
        let da = norm(sub(pairs[i].0, pairs[j].0));
        let db = norm(sub(pairs[i].1, pairs[j].1));
        da >= min_edge && db >= min_edge && (da - db).abs() <= tol + 0.02 * da.max(db)
    };
    let compat: Vec<Vec<u32>> = (0..n)
        .into_par_iter()
        .map(|i| (0..n).filter(|&j| j != i && compat_of(i, j)).map(|j| j as u32).collect())
        .collect();
    let mut seeds: Vec<usize> = (0..n).collect();
    seeds.sort_by(|&a, &b| compat[b].len().cmp(&compat[a].len()).then(a.cmp(&b)));
    const DRAWS: u32 = 8;
    let count_inliers = |t: &Rigid, d2_limit: f64| -> (usize, f64) {
        let mut c = 0usize;
        let mut s = 0.0;
        for (a, b, _, _) in &pairs {
            let d = sub(t.apply(*a), *b);
            let d2 = dot(d, d);
            if d2 > d2_limit { continue; }
            c += 1;
            s += d2;
        }
        (c, if c > 0 { (s / c as f64).sqrt() } else { f64::NAN })
    };
    // The hypotheses are ranked by the pairs that agree, but chosen by
    // the clouds themselves: under the right transform most of the
    // moving cloud lands on the reference, under a wrong one that
    // happens to satisfy a few pairs it does not. Repetitive structure
    // — twenty alike stems — fools the pairs and not the overlap.
    let probe = thin(&mov_d, 4000);
    let overlap_of = |t: &Rigid| -> f64 {
        let hits = probe.par_iter().filter(|&&p| ref_tree.nearest(t.apply(p), d_in2).is_some()).count();
        hits as f64 / probe.len().max(1) as f64
    };
    const KEEP: usize = 32;
    let mut top: Vec<(usize, f64, Rigid)> = Vec::new();
    let mut best: Option<(usize, f64, Rigid)> = None;
    let mut done = 0u32;
    let planned = (n as u32).saturating_mul(DRAWS).min(params.iterations).max(1);
    let seeds_per_chunk = (512 / DRAWS as usize).max(1);
    for chunk in seeds.chunks(seeds_per_chunk) {
        if done >= params.iterations { break; }
        let results: Vec<Option<(usize, f64, Rigid)>> = chunk
            .par_iter()
            .flat_map_iter(|&i| {
                let c = &compat[i];
                // References for the draws below to copy, not the vectors.
                let pairs = &*pairs;
                let (compat_of, count_inliers) = (&compat_of, &count_inliers);
                let mut seed = 0x9E37_79B9_7F4A_7C15u64 ^ (i as u64).wrapping_mul(0xD1B5_4A32_D192_ED03);
                let mut draw = move |m: usize| -> usize {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    ((seed >> 33) as usize) % m
                };
                (0..DRAWS).map(move |_| {
                    if c.len() < 2 { return None; }
                    let j = c[draw(c.len())] as usize;
                    let l = c[draw(c.len())] as usize;
                    if j == l || !compat_of(j, l) { return None; }
                    let s = [(pairs[i].0, pairs[i].1), (pairs[j].0, pairs[j].1), (pairs[l].0, pairs[l].1)];
                    let t = kabsch(&s)?;
                    let (cnt, rmse) = count_inliers(&t, d_in2);
                    // A hypothesis its own triple does not fit is none.
                    if cnt < 3 { return None; }
                    Some((cnt, rmse, t))
                })
            })
            .collect();
        for r in results.into_iter().flatten() {
            let better = match &best { None => true, Some((bc, br, _)) => r.0 > *bc || (r.0 == *bc && r.1 < *br) };
            if better { best = Some(r); }
            if top.len() < KEEP || r.0 > top[top.len() - 1].0 {
                let pos = top.partition_point(|e| e.0 > r.0 || (e.0 == r.0 && e.1 <= r.1));
                top.insert(pos, r);
                if top.len() > KEEP { top.pop(); }
            }
        }
        done += chunk.len() as u32 * DRAWS;
        if !progress(0.6 + 0.35 * (done.min(planned) as f32 / planned as f32)) { return Err("stopped".into()); }
        // Enough draws to have seen an all-inlier triple with 99.9 %
        // confidence at the inlier share found so far, even drawn blind.
        if let Some((bc, _, _)) = &best {
            let w = *bc as f64 / n as f64;
            if w > 0.0 {
                let p_triple = w * w * w;
                let needed = if p_triple >= 1.0 { 1.0 } else { (1.0 - 0.999f64).ln() / (1.0 - p_triple).ln() };
                if done as f64 >= needed { break; }
            }
        }
    }
    if best.is_none() {
        return Err("no three feature pairs agreed on a transform — the clouds may not overlap, or show no structure to pair".into());
    }
    // Among the best-supported hypotheses, the one the clouds agree on.
    let scored: Vec<(f64, usize, f64, Rigid)> = top.iter().map(|(c, r, t)| (overlap_of(t), *c, *r, *t)).collect();
    let mut chosen = scored[0];
    for s in &scored[1..] { if s.0 > chosen.0 || (s.0 == chosen.0 && s.1 > chosen.1) { chosen = *s; } }
    let (mut overlap, mut count, mut rmse, mut t) = chosen;
    if overlap < 0.15 {
        return Err(format!(
            "the best transform puts only {:.0} % of the moving cloud on the reference ({count} feature pairs agree) — the clouds may not overlap, or show no structure to pair; start from a manual offset instead",
            overlap * 100.0
        ));
    }
    // Refit on the inliers, first with a looser reach so the pairs a
    // three-point hypothesis put a cell off come back in, then tight —
    // kept only while the clouds overlap no less.
    for limit in [d_loose2, d_in2, d_in2, d_in2] {
        let inl: Vec<(Vec3, Vec3)> = pairs.iter().filter(|(a, b, _, _)| {
            let d = sub(t.apply(*a), *b);
            dot(d, d) <= limit
        }).map(|(a, b, _, _)| (*a, *b)).collect();
        if inl.len() < 3 { break; }
        let Some(t2) = kabsch(&inl) else { break };
        let o2 = overlap_of(&t2);
        if o2 + 1e-9 < overlap { break; }
        let (c2, r2) = count_inliers(&t2, d_in2);
        t = t2; count = c2; rmse = r2; overlap = o2;
    }
    progress(1.0);
    Ok((t, GlobalReport {
        reference_keypoints: ref_k.len(),
        moving_keypoints: mov_k.len(),
        correspondences: n,
        inliers: count,
        inlier_fraction: count as f64 / n.max(1) as f64,
        iterations: done,
        rmse,
        overlap,
    }))
}

// =====================================================================
// Tests
// =====================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f64 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 11) as f64) / (1u64 << 53) as f64
    }

    /// A 30 × 30 m plot: a gently undulating ground and twelve vertical
    /// stems of 12–25 cm radius, sampled at random — a different sample
    /// every seed, so the two clouds share surfaces and never a point.
    fn plot(seed: u64, ground_n: usize, stem_n: usize) -> Vec<Vec3> {
        let mut s = seed;
        let mut out = Vec::with_capacity(ground_n + 12 * stem_n);
        for _ in 0..ground_n {
            let x = lcg(&mut s) * 30.0 - 15.0;
            let y = lcg(&mut s) * 30.0 - 15.0;
            let z = 0.08 * (x / 3.0).sin() * (y / 4.0).cos() + 0.004 * x - 0.002 * y;
            out.push([x, y, z]);
        }
        let mut stems = 7u64;
        for k in 0..12 {
            let cx = lcg(&mut stems) * 26.0 - 13.0;
            let cy = lcg(&mut stems) * 26.0 - 13.0;
            let r = 0.12 + 0.01 * k as f64;
            for _ in 0..stem_n {
                let a = lcg(&mut s) * std::f64::consts::TAU;
                let h = lcg(&mut s) * 12.0;
                out.push([cx + r * a.cos(), cy + r * a.sin(), h]);
            }
        }
        out
    }

    fn truth() -> Rigid {
        // 2° of yaw, 0.3° of tilt, and most of a metre.
        let r = mat3_mul(&exp_so3([0.0, 0.0, 2.0f64.to_radians()]), &exp_so3([0.3f64.to_radians(), -0.2f64.to_radians(), 0.0]));
        Rigid::about(r, [0.8, -0.5, 0.2], [0.0; 3])
    }

    fn apply_all(t: &Rigid, pts: &[Vec3]) -> Vec<Vec3> { pts.iter().map(|&p| t.apply(p)).collect() }

    fn quick() -> RegisterParams {
        RegisterParams { voxel: 0.04, max_corr_dist: 1.5, max_points: 200_000, ..Default::default() }
    }

    /// How far the recovered transform is from the truth: metres over the
    /// plot's extent and degrees.
    fn error(found: &Rigid, want: &Rigid) -> (f64, f64) {
        let d = found.compose(&want.inverse());
        let mut worst = 0.0f64;
        for p in [[-15.0, -15.0, 0.0], [15.0, 15.0, 12.0], [15.0, -15.0, 6.0], [-15.0, 15.0, 3.0]] {
            worst = worst.max(norm(sub(d.apply(p), p)));
        }
        (worst, d.angle().to_degrees())
    }

    #[test]
    fn the_rigid_algebra_composes_inverts_and_round_trips() {
        let a = Rigid::about(exp_so3([0.1, -0.2, 0.3]), [1.0, 2.0, 3.0], [5.0, 5.0, 0.0]);
        let b = Rigid::yaw(0.5, [-1.0, 0.0, 2.0]);
        let p = [3.0, -4.0, 1.5];
        let ab = a.compose(&b);
        let want = a.apply(b.apply(p));
        assert!(norm(sub(ab.apply(p), want)) < 1e-12);
        let back = a.inverse().apply(a.apply(p));
        assert!(norm(sub(back, p)) < 1e-12);
        let m = ab.to_mat4();
        let again = Rigid::from_mat4(&m).unwrap();
        assert!(norm(sub(again.apply(p), ab.apply(p))) < 1e-12);
        // The world frame: a transform on origin-relative points, carried.
        let o = [500_000.0, 6_800_000.0, 100.0];
        let w = a.shifted_frame(o);
        let pw = add(p, o);
        assert!(norm(sub(w.apply(pw), add(a.apply(p), o))) < 1e-6);
        assert!((Rigid::yaw(0.3, [0.0; 3]).angle() - 0.3).abs() < 1e-12);
        let e = euler_zyx_deg(&Rigid::yaw(10f64.to_radians(), [0.0; 3]).r);
        assert!((e[2] - 10.0).abs() < 1e-9 && e[0].abs() < 1e-9 && e[1].abs() < 1e-9);
    }

    #[test]
    fn a_matrix_that_is_not_rigid_is_refused() {
        let mut m = Rigid::IDENTITY.to_mat4();
        m[0] = 2.0;
        assert!(Rigid::from_mat4(&m).unwrap_err().contains("orthonormal"));
        let mut m = Rigid::IDENTITY.to_mat4();
        m[0] = -1.0;
        assert!(Rigid::from_mat4(&m).unwrap_err().contains("reflection"));
        assert!(Rigid::from_mat4(&[1.0; 12]).unwrap_err().contains("16"));
        let mut m = Rigid::IDENTITY.to_mat4();
        m[15] = 2.0;
        assert!(Rigid::from_mat4(&m).unwrap_err().contains("last row"));
    }

    #[test]
    fn the_kd_tree_agrees_with_brute_force() {
        let mut s = 3u64;
        let pts: Vec<Vec3> = (0..4000).map(|_| [lcg(&mut s) * 40.0, lcg(&mut s) * 40.0, lcg(&mut s) * 20.0]).collect();
        let tree = KdTree::build(&pts);
        assert_eq!(tree.len(), pts.len());
        let mut buf = Vec::new();
        for _ in 0..200 {
            let q = [lcg(&mut s) * 50.0 - 5.0, lcg(&mut s) * 50.0 - 5.0, lcg(&mut s) * 30.0 - 5.0];
            let mut brute: Vec<(u32, f64)> = pts.iter().enumerate().map(|(i, p)| (i as u32, dot(sub(*p, q), sub(*p, q)))).collect();
            brute.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
            let (i, d2) = tree.nearest(q, f64::INFINITY).unwrap();
            assert!((d2 - brute[0].1).abs() < 1e-9);
            assert!(i == brute[0].0 || (pts[i as usize] == pts[brute[0].0 as usize]));
            tree.knn(q, 7, &mut buf);
            assert_eq!(buf.len(), 7);
            for k in 0..7 { assert!((buf[k].1 - brute[k].1).abs() < 1e-9, "k={k}"); }
            // A bound that nothing meets.
            assert!(tree.nearest(q, 1e-12).is_none() || brute[0].1 < 1e-12);
        }
        assert!(KdTree::build(&[]).nearest([0.0; 3], 1.0).is_none());
    }

    #[test]
    fn decimation_is_the_centroid_per_cell_and_deterministic() {
        let pts = vec![[0.01, 0.01, 0.01], [0.04, 0.02, 0.03], [0.11, 0.0, 0.0], [f64::NAN, 0.0, 0.0]];
        let d = decimate(&pts, 0.05);
        assert_eq!(d.len(), 2);
        assert!((d[0][0] - 0.025).abs() < 1e-12 && (d[0][1] - 0.015).abs() < 1e-12);
        assert_eq!(decimate(&pts, 0.05), d);
        let t = thin(&(0..100).map(|i| [i as f64, 0.0, 0.0]).collect::<Vec<_>>(), 10);
        assert_eq!(t.len(), 10);
        assert_eq!(t[0][0], 5.0);
    }

    #[test]
    fn normals_of_a_plane_and_a_cylinder_point_the_right_way() {
        let mut s = 11u64;
        let plane: Vec<Vec3> = (0..3000).map(|_| [lcg(&mut s) * 10.0, lcg(&mut s) * 10.0, 0.001 * lcg(&mut s)]).collect();
        let tree = KdTree::build(&plane);
        let n = normals(&plane, &tree, 16, 0.15);
        let ok = n.iter().filter(|v| v[0].is_finite() && v[2].abs() > 0.999).count();
        assert!(ok > 2900, "{ok}");
        let cyl: Vec<Vec3> = (0..4000).map(|_| { let a = lcg(&mut s) * std::f64::consts::TAU; [0.3 * a.cos(), 0.3 * a.sin(), lcg(&mut s) * 5.0] }).collect();
        let tree = KdTree::build(&cyl);
        let n = normals(&cyl, &tree, 16, 0.15);
        let radial = cyl.iter().zip(&n).filter(|(p, v)| v[0].is_finite() && (dot(**v, normalise([p[0], p[1], 0.0]).unwrap())).abs() > 0.98).count();
        assert!(radial > 3800, "{radial}");
        // Scatter has no normal.
        let blob: Vec<Vec3> = (0..2000).map(|_| [lcg(&mut s), lcg(&mut s), lcg(&mut s)]).collect();
        let tree = KdTree::build(&blob);
        let n = normals(&blob, &tree, 16, 0.15);
        let with = n.iter().filter(|v| v[0].is_finite()).count();
        assert!(with < 1000, "{with} of 2000 scattered points got a normal");
    }

    #[test]
    fn the_jacobi_eigen_solver_and_the_inverse_agree_with_hand_values() {
        let a = vec![vec![2.0, 1.0, 0.0], vec![1.0, 2.0, 0.0], vec![0.0, 0.0, 5.0]];
        let (vals, vecs) = jacobi_eigen(&a);
        assert!((vals[0] - 1.0).abs() < 1e-12 && (vals[1] - 3.0).abs() < 1e-12 && (vals[2] - 5.0).abs() < 1e-12);
        // Eigenvector of 1: (1, −1, 0)/√2.
        assert!((vecs[0][0].abs() - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-9);
        assert!((vecs[0][0] + vecs[1][0]).abs() < 1e-9);
        let inv = invert_dense(&a).unwrap();
        for i in 0..3 { for j in 0..3 {
            let s: f64 = (0..3).map(|k| a[i][k] * inv[k][j]).sum();
            assert!((s - if i == j { 1.0 } else { 0.0 }).abs() < 1e-12);
        } }
        assert!(invert_dense(&[vec![1.0, 2.0], vec![2.0, 4.0]]).is_none());
    }

    #[test]
    fn a_known_transform_is_recovered_to_the_millimetre_by_every_method() {
        let reference = plot(1, 40_000, 1500);
        let moving = apply_all(&truth(), &plot(2, 40_000, 1500));
        let want = truth().inverse();
        for method in [Method::Symmetric, Method::PointToPlane, Method::PointToPoint, Method::Gicp] {
            let params = RegisterParams { method, ..quick() };
            let rep = register(&reference, &moving, Rigid::IDENTITY, &params, &|_| true).unwrap();
            let (m, deg) = error(&rep.transform, &want);
            assert!(m < 0.004, "{method:?}: {m} m at the edge");
            assert!(deg < 0.01, "{method:?}: {deg}°");
            assert!(rep.converged, "{method:?} did not converge");
            // Two samplings of one surface: the plane distance between
            // them is noise, the point distance is the sampling itself.
            let rmse_limit = if method == Method::PointToPoint { 0.1 } else { 0.01 };
            assert!(rep.jackknife_blocks >= 8, "{method:?}: {} blocks", rep.jackknife_blocks);
            assert!(rep.translation_std_err_blocks.iter().all(|v| v.is_finite() && *v > 0.0), "{method:?}: {:?}", rep.translation_std_err_blocks);
            assert!(rep.position_std_err.is_finite() && rep.position_std_err > 0.0 && rep.position_std_err < 0.01, "{method:?}: {}", rep.position_std_err);
            assert!(rep.rmse.is_finite() && rep.rmse < rmse_limit, "{method:?}: rmse {}", rep.rmse);
            assert!(rep.inlier_fraction > 0.8, "{method:?}: inliers {}", rep.inlier_fraction);
            assert!(rep.well_constrained, "{method:?}: condition {} ({})", rep.condition, rep.weakest);
            assert!(rep.translation_std_err.iter().all(|v| v.is_finite() && *v > 0.0 && *v < 0.002), "{method:?}: {:?}", rep.translation_std_err);
            assert_eq!(rep.levels.len(), 4);
            assert_eq!(rep.hist_bins.len(), 41);
            let in_hist = rep.hist_bins.iter().sum::<u32>() as usize;
            // The histogram holds the plane residuals within ±4σ; the inliers
            // are within 3σ of the objective's own residual, nearly the same set.
            assert!(in_hist as f64 >= 0.95 * rep.inliers as f64 && in_hist <= rep.levels[3].moving_points, "{method:?}: {in_hist} in the histogram, {} inliers, {} moving points", rep.inliers, rep.levels[3].moving_points);
        }
    }

    #[test]
    fn noise_and_outliers_are_weighed_out() {
        let mut s = 99u64;
        let reference = plot(3, 40_000, 1500);
        let mut moving = apply_all(&truth(), &plot(4, 40_000, 1500));
        // 3 mm of noise on every point and a fifth of the cloud as
        // clutter nowhere near a surface.
        for p in moving.iter_mut() {
            for a in p.iter_mut() { *a += (lcg(&mut s) - 0.5) * 0.006; }
        }
        let n_out = moving.len() / 5;
        for _ in 0..n_out {
            moving.push([lcg(&mut s) * 30.0 - 15.0, lcg(&mut s) * 30.0 - 15.0, lcg(&mut s) * 12.0]);
        }
        let want = truth().inverse();
        let rep = register(&reference, &moving, Rigid::IDENTITY, &quick(), &|_| true).unwrap();
        let (m, deg) = error(&rep.transform, &want);
        assert!(m < 0.006, "{m} m at the edge");
        assert!(deg < 0.015, "{deg}°");
        assert!(rep.inlier_fraction < 0.95 && rep.inlier_fraction > 0.5, "{}", rep.inlier_fraction);
        assert!(rep.sigma > 0.001 && rep.sigma < 0.02, "{}", rep.sigma);
        // No kernel: the clutter pulls.
        let plain = register(&reference, &moving, Rigid::IDENTITY, &RegisterParams { kernel: Kernel::None, ..quick() }, &|_| true).unwrap();
        let (m2, _) = error(&plain.transform, &want);
        assert!(m2 > m, "the kernel made no difference: {m2} vs {m}");
    }

    #[test]
    fn the_pyramid_converges_from_metres_away() {
        let reference = plot(5, 40_000, 1500);
        let far = Rigid::yaw(4.0f64.to_radians(), [2.5, -1.8, 0.4]);
        let moving = apply_all(&far, &plot(6, 40_000, 1500));
        let params = RegisterParams { voxel: 0.05, max_corr_dist: 4.0, levels: 5, max_points: 200_000, ..Default::default() };
        let rep = register(&reference, &moving, Rigid::IDENTITY, &params, &|_| true).unwrap();
        let (m, deg) = error(&rep.transform, &far.inverse());
        assert!(m < 0.006, "{m} m at the edge");
        assert!(deg < 0.02, "{deg}°");
        assert_eq!(rep.levels.len(), 5);
        assert!(rep.levels[0].corr_dist >= rep.levels[4].corr_dist);
    }

    #[test]
    fn a_flat_field_is_reported_as_unconstrained() {
        let mut s = 21u64;
        let field = |seed: &mut u64| -> Vec<Vec3> {
            (0..30_000).map(|_| [lcg(seed) * 30.0 - 15.0, lcg(seed) * 30.0 - 15.0, 0.0005 * lcg(seed)]).collect()
        };
        let reference = field(&mut s);
        let moving = apply_all(&Rigid::about(exp_so3([0.002, -0.001, 0.0]), [0.0, 0.0, 0.05], [0.0; 3]), &field(&mut s));
        let rep = register(&reference, &moving, Rigid::IDENTITY, &quick(), &|_| true).unwrap();
        assert!(!rep.well_constrained, "condition {}", rep.condition);
        assert!(rep.weakest.contains("translation along") || rep.weakest.contains("yaw"), "{}", rep.weakest);
        // What the field does constrain, it constrains well.
        assert!(rep.translation[2].abs() < 0.0515 && rep.translation[2].abs() > 0.0485, "{:?}", rep.translation);
        assert!(rep.translation_std_err[2] < rep.translation_std_err[0], "{:?}", rep.translation_std_err);
    }

    #[test]
    fn the_levelled_and_translation_only_fits_hold_what_they_promise() {
        let reference = plot(7, 40_000, 1500);
        let moving = apply_all(&truth(), &plot(8, 40_000, 1500));
        let levelled = register(&reference, &moving, Rigid::IDENTITY, &RegisterParams { dof: Dof::Levelled, ..quick() }, &|_| true).unwrap();
        assert!(levelled.rotation_deg[0].abs() < 1e-9 && levelled.rotation_deg[1].abs() < 1e-9, "{:?}", levelled.rotation_deg);
        assert!((levelled.rotation_deg[2] + 2.0).abs() < 0.5, "{:?}", levelled.rotation_deg);
        assert_eq!(levelled.rotation_std_err_deg[0], 0.0);
        let only = register(&reference, &moving, Rigid::IDENTITY, &RegisterParams { dof: Dof::Translation, ..quick() }, &|_| true).unwrap();
        assert_eq!(only.transform.r, IDENTITY3);
        assert!(only.translation_std_err.iter().all(|v| *v > 0.0));
    }

    #[test]
    fn a_stop_is_honoured_and_a_run_is_deterministic() {
        let reference = plot(9, 20_000, 800);
        let moving = apply_all(&truth(), &plot(10, 20_000, 800));
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let err = register(&reference, &moving, Rigid::IDENTITY, &quick(), &|_| calls.fetch_add(1, std::sync::atomic::Ordering::Relaxed) < 3).unwrap_err();
        assert_eq!(err, "stopped");
        let a = register(&reference, &moving, Rigid::IDENTITY, &quick(), &|_| true).unwrap();
        let b = register(&reference, &moving, Rigid::IDENTITY, &quick(), &|_| true).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn kabsch_recovers_a_rotation_from_three_points_and_more() {
        let t = Rigid::about(exp_so3([0.3, -0.7, 1.9]), [4.0, -2.0, 0.5], [0.0; 3]);
        let pts = [[0.0, 0.0, 0.0], [3.0, 0.0, 0.0], [0.0, 2.0, 0.0], [1.0, 1.0, 4.0], [-2.0, 3.0, 1.0]];
        for n in [3usize, 5] {
            let pairs: Vec<(Vec3, Vec3)> = pts[..n].iter().map(|&p| (p, t.apply(p))).collect();
            let k = kabsch(&pairs).unwrap();
            for &p in &pts { assert!(norm(sub(k.apply(p), t.apply(p))) < 1e-9, "n={n}"); }
            assert!((det3(&k.r) - 1.0).abs() < 1e-9);
        }
        // Collinear points do not determine a rotation.
        let line: Vec<(Vec3, Vec3)> = (0..4).map(|i| { let p = [i as f64, 0.0, 0.0]; (p, t.apply(p)) }).collect();
        assert!(kabsch(&line).is_none());
    }

    #[test]
    fn the_radius_search_agrees_with_brute_force() {
        let mut s = 5u64;
        let pts: Vec<Vec3> = (0..3000).map(|_| [lcg(&mut s) * 20.0, lcg(&mut s) * 20.0, lcg(&mut s) * 10.0]).collect();
        let tree = KdTree::build(&pts);
        let mut buf = Vec::new();
        for _ in 0..50 {
            let q = [lcg(&mut s) * 20.0, lcg(&mut s) * 20.0, lcg(&mut s) * 10.0];
            tree.radius(q, 2.25, &mut buf);
            let mut got: Vec<u32> = buf.iter().map(|e| e.0).collect();
            got.sort_unstable();
            let mut want: Vec<u32> = pts.iter().enumerate().filter(|(_, p)| dot(sub(**p, q), sub(**p, q)) <= 2.25).map(|(i, _)| i as u32).collect();
            want.sort_unstable();
            assert_eq!(got, want);
        }
    }

    #[test]
    fn the_global_alignment_finds_a_quarter_turn_and_a_long_offset() {
        let reference = plot(11, 30_000, 1200);
        let far = Rigid::about(exp_so3([0.0, 0.0, 90f64.to_radians()]), [12.0, -7.0, 0.6], [0.0; 3]);
        let moving = apply_all(&far, &plot(12, 30_000, 1200));
        let (t, rep) = global_align(&reference, &moving, &GlobalParams::default(), &|_| true).unwrap();
        let (m, deg) = error(&t, &far.inverse());
        assert!(m < 0.4, "{m} m at the edge ({rep:?})");
        assert!(deg < 2.0, "{deg}° ({rep:?})");
        assert!(rep.inliers >= 6 && rep.inlier_fraction > 0.02, "{rep:?}");
        // And the fine fit takes it the rest of the way.
        let fine = register(&reference, &moving, t, &RegisterParams { max_corr_dist: 1.5, voxel: 0.05, max_points: 200_000, ..Default::default() }, &|_| true).unwrap();
        let (m2, deg2) = error(&fine.transform, &far.inverse());
        assert!(m2 < 0.006, "{m2} m at the edge after the fine fit");
        assert!(deg2 < 0.02, "{deg2}° after the fine fit");
    }

    #[test]
    fn the_global_alignment_is_deterministic_and_stoppable() {
        let reference = plot(13, 12_000, 600);
        let truth = Rigid::yaw(0.6, [5.0, 3.0, 0.0]);
        let moving = apply_all(&truth, &plot(14, 12_000, 600));
        let p = GlobalParams { iterations: 4000, ..Default::default() };
        let a = global_align(&reference, &moving, &p, &|_| true).unwrap();
        let b = global_align(&reference, &moving, &p, &|_| true).unwrap();
        assert_eq!(a, b);
        // And right: twelve alike stems on a smooth ground, 34 degrees
        // off, found from the surfaces alone — the moving cloud back on
        // the reference to a cell at the plot's corners.
        let (t, rep) = &a;
        assert!(rep.inliers >= 10 && rep.rmse.is_finite(), "{rep:?}");
        assert!(rep.overlap > 0.9, "{rep:?}");
        for c in [[-15.0, -15.0, 0.0], [15.0, -15.0, 0.0], [-15.0, 15.0, 0.0], [15.0, 15.0, 5.0]] {
            let back = t.apply(truth.apply(c));
            assert!(norm(sub(back, c)) < 0.3, "{c:?} came back at {back:?}; {rep:?}");
        }
        assert_eq!(global_align(&reference, &moving, &p, &|f| f < 0.1).unwrap_err(), "stopped");
    }

    #[test]
    fn bad_parameters_and_too_few_points_are_refused() {
        let few = vec![[0.0; 3]; 5];
        assert!(register(&few, &few, Rigid::IDENTITY, &quick(), &|_| true).unwrap_err().contains("too few"));
        assert!(RegisterParams { voxel: 0.0, ..Default::default() }.validate().unwrap_err().contains("voxel"));
        assert!(RegisterParams { levels: 9, ..Default::default() }.validate().unwrap_err().contains("levels"));
        assert!(RegisterParams { max_corr_dist: -1.0, ..Default::default() }.validate().unwrap_err().contains("maxCorrDist"));
        let p: RegisterParams = serde_json::from_value(serde_json::json!({ "method": "pointToPlane", "kernel": "tukey" })).unwrap();
        assert_eq!(p.method, Method::PointToPlane);
        assert_eq!(p.kernel, Kernel::Tukey);
        assert_eq!(p.voxel, 0.05);
        assert!(serde_json::from_value::<RegisterParams>(serde_json::json!({ "methd": "x" })).is_err());
    }
}
