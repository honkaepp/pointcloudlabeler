//! Algebraic circle fitting — the one implementation.
//!
//! Every diameter PointCloudLabeler reports comes from fitting a circle to a
//! horizontal band of stem points: DBH, each QSM slice, the virtual
//! caliper, the stem taper profile. That made it three separate copies
//! of the same algebra in two modules, which is how a fix reaches one
//! caller and not the others.
//!
//! WHY NOT KÅSA
//! ------------
//! The classic Kåsa/Coope fit minimises the raw algebraic distance
//! `(x−a)² + (y−b)² − r²`, which is weighted by distance from the
//! centre. On a full circle that is harmless. On a partial arc it is
//! not: a fit that pulls the centre toward the observed arc and shrinks
//! the radius scores well, so Kåsa systematically reads SMALL — and the
//! error is not noise. A stem scanned from one position is occluded on
//! the same side at every height, so the bias has the same sign all the
//! way up the trunk and does not average out into the volume.
//!
//! Measured on synthetic arcs (see `arc_coverage_bias_of_kasa_vs_taubin`
//! below — 30 cm stem, 5 mm noise, 200 trials):
//!
//! | visible arc | Kåsa radius bias | Taubin radius bias |
//! |-------------|------------------|--------------------|
//! | 100 %       | +0.05 mm         | +0.05 mm           |
//! | 50 %        | −0.61 mm         | +0.05 mm           |
//! | 33 %        | −4.43 mm         | +0.33 mm           |
//! | 25 %        | −14.36 mm        | −0.04 mm           |
//!
//! At quarter coverage — an ordinary boundary tree seen from one scan
//! position — Kåsa under-reads the DIAMETER by nearly 29 mm: a 30 cm
//! stem measures 27 cm. Basal area goes as D², so that is roughly 9 % of
//! the tree's volume, missing, on exactly the trees the QC panel already
//! marks as low-coverage. It had been calling that "lower confidence"
//! when it was a predictable under-reading.
//!
//! Taubin's fit (Taubin 1991; reference implementation in Chernov,
//! *Circular and Linear Regression*, §5.7) minimises a
//! gradient-normalised objective instead, costs the same single pass,
//! and is effectively unbiased across the whole range. There is no
//! trade-off to weigh here — it is better everywhere and worse nowhere.
//!
//! `kasa_circle` is kept only so the comparison test can keep proving
//! that. Nothing in production calls it.

/// Taubin's algebraic circle fit. Returns `(centre_x, centre_y, radius)`.
///
/// `None` when there are fewer than three points or the geometry is
/// degenerate (collinear points, a vanishing determinant) — a caller
/// getting `None` has no circle, not a bad one.
pub fn taubin_circle(pts: &[(f64, f64)]) -> Option<(f64, f64, f64)> {
    let n = pts.len();
    if n < 3 {
        return None;
    }
    let nf = n as f64;
    let mx = pts.iter().map(|p| p.0).sum::<f64>() / nf;
    let my = pts.iter().map(|p| p.1).sum::<f64>() / nf;

    let (mut mxx, mut myy, mut mxy, mut mxz, mut myz, mut mzz) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
    for &(px, py) in pts {
        let u = px - mx;
        let v = py - my;
        let z = u * u + v * v;
        mxx += u * u;
        myy += v * v;
        mxy += u * v;
        mxz += u * z;
        myz += v * z;
        mzz += z * z;
    }
    mxx /= nf;
    myy /= nf;
    mxy /= nf;
    mxz /= nf;
    myz /= nf;
    mzz /= nf;

    let mz = mxx + myy;
    let cov_xy = mxx * myy - mxy * mxy;
    let var_z = mzz - mz * mz;

    // Characteristic polynomial of the Taubin objective; its smallest
    // non-negative root gives the fit.
    let a3 = 4.0 * mz;
    let a2 = -3.0 * mz * mz - mzz;
    let a1 = var_z * mz + 4.0 * cov_xy * mz - mxz * mxz - myz * myz;
    let a0 = mxz * (mxz * myy - myz * mxy) + myz * (myz * mxx - mxz * mxy) - var_z * cov_xy;
    let a22 = a2 + a2;
    let a33 = a3 + a3 + a3;

    // Newton from x = 0, the root's known lower bound: it converges in a
    // handful of steps and cannot leave the bracket. The `y_new.abs() >=
    // y.abs()` guard stops it wandering if the polynomial is flat.
    let (mut x, mut y) = (0.0f64, a0);
    for _ in 0..99 {
        let dy = a1 + x * (a22 + a33 * x);
        if dy.abs() < 1e-300 {
            break;
        }
        let x_new = x - y / dy;
        if x_new == x || !x_new.is_finite() {
            break;
        }
        let y_new = a0 + x_new * (a1 + x_new * (a2 + x_new * a3));
        if y_new.abs() >= y.abs() {
            break;
        }
        x = x_new;
        y = y_new;
    }

    let det = x * x - x * mz + cov_xy;
    if det.abs() < 1e-16 {
        return None;
    }
    let xc = (mxz * (myy - x) - myz * mxy) / (det * 2.0);
    let yc = (myz * (mxx - x) - mxz * mxy) / (det * 2.0);
    let r2 = xc * xc + yc * yc + mz;
    if r2 <= 0.0 || !r2.is_finite() {
        return None;
    }
    Some((xc + mx, yc + my, r2.sqrt()))
}

/// The classic Kåsa/Coope fit. **Not used in production** — kept so the
/// comparison test can keep demonstrating why. See the module doc.
#[cfg_attr(not(test), allow(dead_code))]
pub fn kasa_circle(pts: &[(f64, f64)]) -> Option<(f64, f64, f64)> {
    let n = pts.len();
    if n < 3 {
        return None;
    }
    let nf = n as f64;
    let mx = pts.iter().map(|p| p.0).sum::<f64>() / nf;
    let my = pts.iter().map(|p| p.1).sum::<f64>() / nf;
    let (mut suu, mut svv, mut suv) = (0.0, 0.0, 0.0);
    let (mut suuu, mut svvv, mut suvv, mut svuu) = (0.0, 0.0, 0.0, 0.0);
    for &(px, py) in pts {
        let u = px - mx;
        let v = py - my;
        suu += u * u;
        svv += v * v;
        suv += u * v;
        suuu += u * u * u;
        svvv += v * v * v;
        suvv += u * v * v;
        svuu += v * u * u;
    }
    let det = suu * svv - suv * suv;
    if det.abs() < 1e-12 {
        return None;
    }
    let c1 = 0.5 * (suuu + suvv);
    let c2 = 0.5 * (svvv + svuu);
    let uc = (c1 * svv - c2 * suv) / det;
    let vc = (c2 * suu - c1 * suv) / det;
    let r2 = uc * uc + vc * vc + (suu + svv) / nf;
    if r2 <= 0.0 {
        return None;
    }
    Some((uc + mx, vc + my, r2.sqrt()))
}

/// Radial RMSE of a fitted circle — how far the points sit from it.
pub fn radial_rmse(pts: &[(f64, f64)], cx: f64, cy: f64, r: f64) -> f64 {
    if pts.is_empty() {
        return f64::NAN;
    }
    let sq: f64 = pts
        .iter()
        .map(|&(px, py)| {
            let d = ((px - cx).powi(2) + (py - cy).powi(2)).sqrt() - r;
            d * d
        })
        .sum();
    (sq / pts.len() as f64).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic standard normal over a fixed LCG — no dependency,
    /// and a regression is a real change rather than an unlucky reroll.
    fn gaussian_source(seed: u64) -> impl FnMut() -> f64 {
        let mut s = seed;
        let mut uniform = move || {
            s = s
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((s >> 11) as f64) / ((1u64 << 53) as f64)
        };
        move || {
            let u1: f64 = uniform().max(1e-12);
            let u2: f64 = uniform();
            (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
        }
    }

    fn arc(r: f64, frac: f64, n: usize, noise: f64, g: &mut impl FnMut() -> f64) -> Vec<(f64, f64)> {
        let span = std::f64::consts::TAU * frac;
        let start = std::f64::consts::TAU * 0.137; // fixed, arbitrary phase
        (0..n)
            .map(|i| {
                let a = start + span * (i as f64) / (n as f64 - 1.0);
                let rr = r + noise * g();
                (rr * a.cos(), rr * a.sin())
            })
            .collect()
    }

    #[test]
    fn recovers_a_clean_circle_exactly() {
        let mut g = || 0.0;
        let pts = arc(0.15, 1.0, 64, 0.0, &mut g);
        let (cx, cy, r) = taubin_circle(&pts).unwrap();
        assert!(cx.abs() < 1e-9 && cy.abs() < 1e-9, "centre {cx},{cy}");
        assert!((r - 0.15).abs() < 1e-9, "radius {r}");
    }

    /// The measurement the production choice rests on. Printed, not just
    /// asserted, so the numbers in the module doc can be re-checked
    /// rather than taken on trust.
    #[test]
    fn arc_coverage_bias_of_kasa_vs_taubin() {
        const R: f64 = 0.15; // 30 cm DBH — an ordinary sawlog stem
        const NOISE: f64 = 0.005; // 5 mm, realistic TLS range noise
        const N_PTS: usize = 120;
        const TRIALS: usize = 200;

        let mut g = gaussian_source(0x2545F4914F6CDD1D);
        println!("\n  arc      Kasa bias      Taubin bias   ({TRIALS} trials, R = {R} m)");
        let (mut worst_kasa, mut worst_taubin) = (0.0f64, 0.0f64);

        for &frac in &[1.0f64, 0.75, 0.5, 0.33, 0.25] {
            let (mut sum_k, mut sum_t) = (0.0f64, 0.0f64);
            for _ in 0..TRIALS {
                let pts = arc(R, frac, N_PTS, NOISE, &mut g);
                sum_k += kasa_circle(&pts).map(|(_, _, r)| r - R).unwrap_or(0.0);
                sum_t += taubin_circle(&pts).map(|(_, _, r)| r - R).unwrap_or(0.0);
            }
            let (bk, bt) = (sum_k / TRIALS as f64, sum_t / TRIALS as f64);
            println!(
                "  {:>4.0}%   {:>+8.2} mm     {:>+8.2} mm",
                frac * 100.0,
                bk * 1000.0,
                bt * 1000.0
            );
            worst_kasa = worst_kasa.max(bk.abs());
            worst_taubin = worst_taubin.max(bt.abs());
        }
        println!(
            "  worst |bias|: Kasa {:.2} mm, Taubin {:.2} mm\n",
            worst_kasa * 1000.0,
            worst_taubin * 1000.0
        );

        // Pins the CONCLUSION — Taubin is the safer default — not the
        // exact millimetres, which move with the noise draw.
        assert!(
            worst_taubin <= worst_kasa,
            "Taubin ({worst_taubin:.5} m) must not be worse than Kasa ({worst_kasa:.5} m) anywhere"
        );
        assert!(
            worst_taubin < 0.002,
            "Taubin should stay within ~2 mm across the range, got {worst_taubin:.5} m"
        );
        assert!(
            worst_kasa > 0.005,
            "if Kasa's partial-arc bias has vanished, this comparison no longer justifies the switch \
             and the module doc's table needs redoing (got {worst_kasa:.5} m)"
        );
    }

    #[test]
    fn degenerate_input_yields_no_circle_rather_than_a_bad_one() {
        assert!(taubin_circle(&[]).is_none());
        assert!(taubin_circle(&[(0.0, 0.0), (1.0, 0.0)]).is_none());
        // Collinear points describe no circle.
        let line: Vec<(f64, f64)> = (0..20).map(|i| (i as f64 * 0.01, 0.0)).collect();
        assert!(taubin_circle(&line).is_none(), "collinear points must not produce a circle");
    }

    #[test]
    fn radial_rmse_is_zero_on_a_perfect_circle_and_grows_with_scatter() {
        let mut g = || 0.0;
        let clean = arc(0.15, 1.0, 64, 0.0, &mut g);
        let (cx, cy, r) = taubin_circle(&clean).unwrap();
        assert!(radial_rmse(&clean, cx, cy, r) < 1e-9);

        let mut noisy_g = gaussian_source(7);
        let noisy = arc(0.15, 1.0, 64, 0.01, &mut noisy_g);
        let (nx, ny, nr) = taubin_circle(&noisy).unwrap();
        assert!(radial_rmse(&noisy, nx, ny, nr) > 0.003);
    }
}
