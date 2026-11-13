//! Eigenvalues (and the main axis) of a symmetric 3 × 3 covariance in closed
//! form — the trigonometric solution of the characteristic cubic. A few
//! dozen flops against an iterative Jacobi sweep, for the millions of
//! neighbourhoods the wood test looks at.

/// A covariance as its six distinct entries: xx, xy, xz, yy, yz, zz.
pub type Cov = [f64; 6];

/// The eigenvalues, largest first, never negative.
pub fn eigenvalues(c: &Cov) -> [f64; 3] {
    let [a00, a01, a02, a11, a12, a22] = *c;
    let p1 = a01 * a01 + a02 * a02 + a12 * a12;
    let mut e = if p1 <= 1e-30 * (a00 * a00 + a11 * a11 + a22 * a22).max(1e-300) {
        let mut d = [a00, a11, a22];
        d.sort_by(|x, y| y.partial_cmp(x).unwrap_or(std::cmp::Ordering::Equal));
        d
    } else {
        let q = (a00 + a11 + a22) / 3.0;
        let p2 = (a00 - q).powi(2) + (a11 - q).powi(2) + (a22 - q).powi(2) + 2.0 * p1;
        let p = (p2 / 6.0).sqrt();
        let inv = 1.0 / p;
        let (b00, b11, b22) = ((a00 - q) * inv, (a11 - q) * inv, (a22 - q) * inv);
        let (b01, b02, b12) = (a01 * inv, a02 * inv, a12 * inv);
        let det = b00 * (b11 * b22 - b12 * b12) - b01 * (b01 * b22 - b12 * b02) + b02 * (b01 * b12 - b11 * b02);
        let r = (det / 2.0).clamp(-1.0, 1.0);
        let phi = r.acos() / 3.0;
        let e0 = q + 2.0 * p * phi.cos();
        let e2 = q + 2.0 * p * (phi + 2.0 * std::f64::consts::PI / 3.0).cos();
        [e0, 3.0 * q - e0 - e2, e2]
    };
    for v in &mut e { if *v < 0.0 { *v = 0.0; } }
    e
}

/// The unit eigenvector of eigenvalue `l` (the cross product of two rows of
/// A − lI, the largest of the three), or straight up when degenerate.
pub fn eigenvector(c: &Cov, l: f64) -> [f64; 3] {
    let [a00, a01, a02, a11, a12, a22] = *c;
    let r0 = [a00 - l, a01, a02];
    let r1 = [a01, a11 - l, a12];
    let r2 = [a02, a12, a22 - l];
    let cross = |a: [f64; 3], b: [f64; 3]| [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let n2 = |v: [f64; 3]| v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    let cands = [cross(r0, r1), cross(r0, r2), cross(r1, r2)];
    let mut best = cands[0];
    for v in cands { if n2(v) > n2(best) { best = v; } }
    let n = n2(best).sqrt();
    if n <= 1e-20 { return [0.0, 0.0, 1.0]; }
    [best[0] / n, best[1] / n, best[2] / n]
}

/// The covariance of points (relative to their mean).
pub fn covariance<I: Iterator<Item = [f32; 3]> + Clone>(pts: I) -> Option<(Cov, [f64; 3], usize)> {
    let mut n = 0usize;
    let mut m = [0.0f64; 3];
    for q in pts.clone() { n += 1; m[0] += q[0] as f64; m[1] += q[1] as f64; m[2] += q[2] as f64; }
    if n < 3 { return None; }
    let inv = 1.0 / n as f64;
    m = [m[0] * inv, m[1] * inv, m[2] * inv];
    let mut c = [0.0f64; 6];
    for q in pts {
        let (x, y, z) = (q[0] as f64 - m[0], q[1] as f64 - m[1], q[2] as f64 - m[2]);
        c[0] += x * x; c[1] += x * y; c[2] += x * z; c[3] += y * y; c[4] += y * z; c[5] += z * z;
    }
    for v in &mut c { *v *= inv; }
    Some((c, m, n))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagonal_and_rotated_matrices() {
        let e = eigenvalues(&[3.0, 0.0, 0.0, 1.0, 0.0, 2.0]);
        assert_eq!(e, [3.0, 2.0, 1.0]);
        // a rotation of diag(5, 2, 1) about z by 30°
        let (s, c) = (0.5f64, 0.75f64.sqrt());
        let m = [5.0 * c * c + 2.0 * s * s, (5.0 - 2.0) * c * s, 0.0, 5.0 * s * s + 2.0 * c * c, 0.0, 1.0];
        let e = eigenvalues(&m);
        for (a, b) in e.iter().zip([5.0, 2.0, 1.0]) { assert!((a - b).abs() < 1e-9, "{e:?}"); }
        let v = eigenvector(&m, e[0]);
        assert!((v[0].abs() - c).abs() < 1e-9 && (v[1].abs() - s).abs() < 1e-9 && v[2].abs() < 1e-9, "{v:?}");
    }

    #[test]
    fn a_line_a_plane_and_a_blob() {
        let line: Vec<[f32; 3]> = (0..50).map(|i| [0.0, 0.0, i as f32 * 0.01]).collect();
        let (c, _, _) = covariance(line.iter().copied()).unwrap();
        let e = eigenvalues(&c);
        assert!(e[1] < 1e-9 && e[0] > 1e-3);
        let v = eigenvector(&c, e[0]);
        assert!(v[2].abs() > 0.999);
        let mut seed = 3u64;
        let blob: Vec<[f32; 3]> = (0..400).map(|_| [crate::commands::forest::lcg(&mut seed), crate::commands::forest::lcg(&mut seed), crate::commands::forest::lcg(&mut seed)]).collect();
        let (c, _, _) = covariance(blob.iter().copied()).unwrap();
        let e = eigenvalues(&c);
        assert!(e[2] / e[0] > 0.7, "{e:?}");
    }
}
