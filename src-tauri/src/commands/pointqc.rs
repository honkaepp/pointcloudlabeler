// Per-tree point QC — reflectance, outlier and wind filtering with
// height-adaptive radii.
//
// A port of `pc_preprocess_aapo_V2.m`, the preprocessing step that runs
// on one tree's points before classification. The MATLAB is the
// specification; this file follows its stages, its parameter names and
// its four quality labels so a result can be compared against it
// directly:
//
//   1 = kept · 2 = removed by reflectance · 3 = outlier · 4 = wind
//
// The three stages, and why each exists:
//
//   1. REFLECTANCE. A return far outside the expected reflectance band
//      is not wood or leaf — it is a specular glint, a wet surface, or
//      a partial hit whose amplitude says so.
//
//   2. OUTLIER. A point with almost no neighbours inside a small radius
//      is a stray: multipath, a bird, rain, or an edge return. The
//      radius is height-adaptive because a crown is sparser than a
//      stem — using the stem's radius up in the branches deletes real
//      foliage, and using the crown's radius at the stem keeps noise.
//
//   3. WIND. This is the one that needs several scan positions. A
//      branch that moved between scans appears in one scan and not in
//      the others, so a point whose neighbourhood contains returns
//      from too few OTHER scan positions was measured while the tree
//      was moving. High in the crown one corroborating position is
//      demanded; low down, where movement is small and occlusion is
//      the real risk, two.
//
// Both radii and the corroboration count ramp with height through the
// same clamped linear function the MATLAB uses (`adaptive`): constant
// below `h_low`, constant above `h_high`, linear between, over height
// normalised to [0, 1] within each tree.
//
// WHAT DIFFERS FROM THE MATLAB, deliberately:
//
//   • Height above ground comes from the class-2 DTM the way every
//     other per-tree tool here gets it (`build_dtm_grid`), not from a
//     precomputed column. Same quantity, one less thing to keep in
//     sync — and it fails with a clear message when the cloud has no
//     ground classification, instead of silently normalising against
//     the lowest point of the tree.
//
//   • Neighbour search is a uniform grid rather than a k-d tree. At
//     these radii (3–12 cm) a grid is exact and faster: one bucket per
//     `radius_max` cell, 27 cells per query. The MATLAB's
//     stratum-batched `rangesearch` exists to amortise k-d tree
//     queries; a grid needs no batching, so the strata here only carry
//     the adaptive parameters, which is what they were for.
//
//   • `pcdenoise` (the `density` method) is reimplemented rather than
//     called: mean distance to the k nearest neighbours per point, then
//     reject points whose mean exceeds the cloud's mean by
//     `std_mult` standard deviations. That is what pcdenoise does; the
//     k nearest are found by expanding the grid search, which is exact
//     unless a point's k-th neighbour lies beyond the search cap, and
//     such a point is an outlier by any definition.
//
//   • Labels are written to the dataset as a `point_quality` extra
//     column, so the result is visible in the viewer, usable by the
//     filter panel and exportable — the MATLAB returns a table
//     instead. Points outside the processed set (no tree id, deleted,
//     or in a tree too small to process) get 0, which reads as "not
//     evaluated" rather than as a verdict.

use rustc_hash::FxHashMap;
use serde::Deserialize;

/// One point as the classifier sees it. Positions are world metres,
/// `hag` is height above ground in metres, `refl` is in whatever unit
/// the chosen reflectance column carries, and `scan` is the scan-
/// position id (-1 when the dataset has no such column).
#[derive(Clone, Copy, Debug)]
pub struct QcPoint {
    pub pos: [f64; 3],
    pub hag: f64,
    pub refl: f64,
    pub scan: i32,
}

/// Quality labels, matching the MATLAB's `point_quality`.
pub const Q_KEPT: u8 = 1;
pub const Q_REFLECTANCE: u8 = 2;
pub const Q_OUTLIER: u8 = 3;
pub const Q_WIND: u8 = 4;
/// Not evaluated — no tree id, deleted, or a tree below the size floor.
pub const Q_UNEVALUATED: u8 = 0;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PointQcParams {
    /// Reflectance band to keep, in the units of the chosen column.
    /// MATLAB defaults: -20 … 5 dB.
    pub refl_min: f64,
    pub refl_max: f64,
    /// Name of the numeric extra column holding reflectance. None (or
    /// empty) uses the base record's u16 intensity, in which case the
    /// band is in intensity units — the UI says which, because a dB
    /// band silently applied to 0…65535 keeps everything.
    #[serde(default)]
    pub refl_column: Option<String>,

    /// "radius" (MATLAB default) or "density".
    pub outlier_method: String,
    pub outlier_knn: u32,
    pub outlier_std_mult: f64,
    pub outlier_min_neighbors: u32,
    pub outlier_radius_min: f64,
    pub outlier_radius_max: f64,

    pub wind_radius_min: f64,
    pub wind_radius_max: f64,
    /// Corroborating scan positions demanded low in the tree and high
    /// in it. Rounded per stratum, as in the MATLAB.
    pub wind_min_other_scans_low: f64,
    pub wind_min_other_scans_high: f64,
    /// Extra column holding the per-point scan-position id. Without
    /// one the wind stage cannot run at all and is skipped, which the
    /// result reports rather than passing every point silently.
    #[serde(default)]
    pub scan_column: Option<String>,

    /// The ramp's normalised-height bounds and the stratum count.
    pub h_low: f64,
    pub h_high: f64,
    pub n_strata: u32,

    /// Trees to process; empty = every segmented tree.
    #[serde(default)]
    pub tree_ids: Vec<i32>,
    /// Trees with fewer points than this are left unevaluated — the
    /// stages are neighbourhood statistics and a handful of points has
    /// none worth computing.
    pub min_tree_points: u32,
    /// DTM cell size for the height-above-ground surface.
    pub dtm_cell: f64,
    /// Write the labels to the dataset's `point_quality` column.
    /// False = report only, touch nothing.
    pub write_column: bool,
}

impl Default for PointQcParams {
    fn default() -> Self {
        Self {
            // Every default here is the MATLAB's.
            refl_min: -20.0,
            refl_max: 5.0,
            refl_column: None,
            outlier_method: "radius".to_string(),
            outlier_knn: 8,
            outlier_std_mult: 3.0,
            outlier_min_neighbors: 3,
            outlier_radius_min: 0.04,
            outlier_radius_max: 0.12,
            wind_radius_min: 0.03,
            wind_radius_max: 0.10,
            wind_min_other_scans_low: 2.0,
            wind_min_other_scans_high: 1.0,
            scan_column: None,
            h_low: 0.60,
            h_high: 0.75,
            n_strata: 5,
            tree_ids: Vec::new(),
            min_tree_points: 50,
            dtm_cell: 0.5,
            write_column: true,
        }
    }
}

/// The MATLAB's `adaptive`: `vLow` below `h_low`, `vHigh` above
/// `h_high`, linear in between, over normalised height.
///
/// Written as its own function because both radii and the scan-count
/// demand ride on it, and because a ramp with `h_low == h_high` is a
/// step — division by zero in the MATLAB — which is worth handling
/// once rather than at three call sites.
pub fn adaptive(v_low: f64, v_high: f64, h_norm: f64, h_low: f64, h_high: f64) -> f64 {
    let t = if h_high > h_low {
        ((h_norm - h_low) / (h_high - h_low)).clamp(0.0, 1.0)
    } else if h_norm >= h_high {
        1.0
    } else {
        0.0
    };
    v_low + (v_high - v_low) * t
}

/// LAS point-source id for the `index`-th scan of an export, 1-based.
///
/// The contract between the preprocessing exporters and this file's
/// wind stage. LAS has exactly one standard field for "which sensor
/// pass produced this point" — `point_source_id`, a u16 where 0 means
/// unassigned — so a merged export writes each scan position's number
/// there and the importer can carry it back as a column. Without it a
/// merged cloud has no scan identity at all and the wind stage has
/// nothing to corroborate against.
///
/// The id is the scan's position in that export's own list, which is
/// all the wind stage needs: it asks whether a point's neighbours came
/// from OTHER positions, never which one. 0 is never handed out, so a
/// point that kept the LAS default is distinguishable from a scan.
///
/// Beware the other use of this field: the Editor's LAS export writes
/// `tree_id` into it for viewers that cannot read Extra-Bytes. Such a
/// file re-imported gives a "scan id" that is constant within each
/// tree — which `classify_tree` sees as one distinct scan and declines
/// to filter on, rather than declaring every point wind. That is the
/// safe direction, and it is tested.
pub fn scan_position_psid(index: usize) -> u16 {
    (index as u64 + 1).min(u16::MAX as u64) as u16
}

/// Uniform-grid neighbour index. Cell size is the largest radius any
/// query will use, so the 27 cells around a point contain every
/// neighbour within that radius — exact, not approximate.
struct Grid {
    cell: f64,
    map: FxHashMap<(i64, i64, i64), Vec<u32>>,
}

impl Grid {
    fn build(pts: &[[f64; 3]], cell: f64) -> Self {
        let cell = cell.max(1e-6);
        let inv = 1.0 / cell;
        let mut map: FxHashMap<(i64, i64, i64), Vec<u32>> = FxHashMap::default();
        for (i, p) in pts.iter().enumerate() {
            let key = (
                (p[0] * inv).floor() as i64,
                (p[1] * inv).floor() as i64,
                (p[2] * inv).floor() as i64,
            );
            map.entry(key).or_default().push(i as u32);
        }
        Self { cell, map }
    }

    /// Every index within `radius` of `p`, self included — the caller
    /// excludes itself, as the MATLAB does. `radius` must not exceed
    /// the cell size, which is why `build` is given the maximum.
    fn within<F: FnMut(u32, f64)>(&self, pts: &[[f64; 3]], p: [f64; 3], radius: f64, mut f: F) {
        let inv = 1.0 / self.cell;
        let (bx, by, bz) = (
            (p[0] * inv).floor() as i64,
            (p[1] * inv).floor() as i64,
            (p[2] * inv).floor() as i64,
        );
        let r2 = radius * radius;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    let Some(bucket) = self.map.get(&(bx + dx, by + dy, bz + dz)) else { continue };
                    for &idx in bucket {
                        let q = pts[idx as usize];
                        let d2 = (q[0] - p[0]) * (q[0] - p[0])
                            + (q[1] - p[1]) * (q[1] - p[1])
                            + (q[2] - p[2]) * (q[2] - p[2]);
                        if d2 <= r2 {
                            f(idx, d2);
                        }
                    }
                }
            }
        }
    }

    /// Mean distance to the `k` nearest neighbours, searching outward
    /// ring by ring until `k` are found or the cap is reached. Returns
    /// None when the point has no neighbour at all inside the cap —
    /// which the density method treats as an outlier.
    fn knn_mean_distance(&self, pts: &[[f64; 3]], p: [f64; 3], k: usize, max_rings: i64) -> Option<f64> {
        let inv = 1.0 / self.cell;
        let (bx, by, bz) = (
            (p[0] * inv).floor() as i64,
            (p[1] * inv).floor() as i64,
            (p[2] * inv).floor() as i64,
        );
        let mut d2s: Vec<f64> = Vec::with_capacity(k * 4);
        for ring in 0..=max_rings {
            d2s.clear();
            for dx in -ring..=ring {
                for dy in -ring..=ring {
                    for dz in -ring..=ring {
                        let Some(bucket) = self.map.get(&(bx + dx, by + dy, bz + dz)) else { continue };
                        for &idx in bucket {
                            let q = pts[idx as usize];
                            let d2 = (q[0] - p[0]) * (q[0] - p[0])
                                + (q[1] - p[1]) * (q[1] - p[1])
                                + (q[2] - p[2]) * (q[2] - p[2]);
                            // Exclude self by position: the query point
                            // is one of the indexed points.
                            if d2 > 0.0 {
                                d2s.push(d2);
                            }
                        }
                    }
                }
            }
            // A full ring of cells beyond the k-th neighbour guarantees
            // the k nearest are all in hand.
            if d2s.len() >= k && ring > 0 {
                break;
            }
        }
        if d2s.is_empty() {
            return None;
        }
        d2s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let take = k.min(d2s.len());
        Some(d2s[..take].iter().map(|d2| d2.sqrt()).sum::<f64>() / take as f64)
    }
}

/// Which stratum a normalised height belongs to, with the MATLAB's
/// half-open edges and closed top: `[e_s, e_{s+1})` except the last,
/// which is `[e_s, 1]`. Getting this wrong drops the topmost point of
/// every tree out of every stratum, so it is its own function with its
/// own test.
pub fn stratum_of(h_norm: f64, n_strata: u32) -> usize {
    let n = n_strata.max(1) as f64;
    let s = (h_norm * n).floor();
    (s.max(0.0).min(n - 1.0)) as usize
}

/// Classify one tree's points. The heart of the port: same order, same
/// subsets, same labels as the MATLAB.
///
/// `hag_min` / `hag_max` are the tree's own height range, so the
/// normalisation is per tree exactly as in the MATLAB.
pub fn classify_tree(points: &[QcPoint], params: &PointQcParams) -> Vec<u8> {
    let n = points.len();
    let mut quality = vec![Q_KEPT; n];
    if n == 0 {
        return quality;
    }

    // Normalise height within this tree.
    let (mut hag_min, mut hag_max) = (f64::INFINITY, f64::NEG_INFINITY);
    for p in points {
        if p.hag.is_finite() {
            if p.hag < hag_min { hag_min = p.hag; }
            if p.hag > hag_max { hag_max = p.hag; }
        }
    }
    let span = hag_max - hag_min;
    let h_norm: Vec<f64> = points
        .iter()
        .map(|p| {
            if span > 0.0 && p.hag.is_finite() {
                ((p.hag - hag_min) / span).clamp(0.0, 1.0)
            } else {
                0.0
            }
        })
        .collect();

    // ---- 1. Reflectance ------------------------------------------
    let mut idx_ref: Vec<u32> = Vec::with_capacity(n);
    for i in 0..n {
        if points[i].refl >= params.refl_min && points[i].refl <= params.refl_max {
            idx_ref.push(i as u32);
        } else {
            quality[i] = Q_REFLECTANCE;
        }
    }

    // ---- 2. Outlier removal, over the reflectance-passed subset ---
    let pts_ref: Vec<[f64; 3]> = idx_ref.iter().map(|&i| points[i as usize].pos).collect();
    let mut keep_outlier = vec![true; idx_ref.len()];
    let radius_cell = params.outlier_radius_min.max(params.outlier_radius_max);

    match params.outlier_method.as_str() {
        "density" => {
            if idx_ref.len() > params.outlier_knn as usize + 1 {
                let grid = Grid::build(&pts_ref, radius_cell);
                let k = params.outlier_knn.max(1) as usize;
                let mut means: Vec<f64> = Vec::with_capacity(pts_ref.len());
                for p in &pts_ref {
                    means.push(grid.knn_mean_distance(&pts_ref, *p, k, 4).unwrap_or(f64::INFINITY));
                }
                let finite: Vec<f64> = means.iter().copied().filter(|m| m.is_finite()).collect();
                if !finite.is_empty() {
                    let mean = finite.iter().sum::<f64>() / finite.len() as f64;
                    let var = finite.iter().map(|m| (m - mean) * (m - mean)).sum::<f64>()
                        / finite.len() as f64;
                    let thr = mean + params.outlier_std_mult * var.sqrt();
                    for (j, m) in means.iter().enumerate() {
                        if !(*m <= thr) {
                            keep_outlier[j] = false;
                        }
                    }
                }
            }
        }
        // "radius" and anything else: the MATLAB errors on an unknown
        // method, but a typo in a UI field should not throw away a run
        // — the radius method is its documented default.
        _ => {
            if idx_ref.len() > params.outlier_min_neighbors as usize {
                let grid = Grid::build(&pts_ref, radius_cell);
                for (j, &i) in idx_ref.iter().enumerate() {
                    let hs = h_norm[i as usize];
                    let r = adaptive(
                        params.outlier_radius_min,
                        params.outlier_radius_max,
                        stratum_mid(hs, params.n_strata),
                        params.h_low,
                        params.h_high,
                    );
                    let mut count = 0u32;
                    grid.within(&pts_ref, pts_ref[j], r, |idx, _| {
                        if idx as usize != j {
                            count += 1;
                        }
                    });
                    if count < params.outlier_min_neighbors {
                        keep_outlier[j] = false;
                    }
                }
            }
        }
    }
    let mut idx_after: Vec<u32> = Vec::with_capacity(idx_ref.len());
    for (j, &i) in idx_ref.iter().enumerate() {
        if keep_outlier[j] {
            idx_after.push(i);
        } else {
            quality[i as usize] = Q_OUTLIER;
        }
    }

    // ---- 3. Wind, over the post-outlier subset -------------------
    let pts_wind: Vec<[f64; 3]> = idx_after.iter().map(|&i| points[i as usize].pos).collect();
    let scans: Vec<i32> = idx_after.iter().map(|&i| points[i as usize].scan).collect();
    let distinct_scans: std::collections::BTreeSet<i32> = scans.iter().copied().collect();
    if pts_wind.len() > 3 && distinct_scans.len() > 1 {
        let cell = params.wind_radius_min.max(params.wind_radius_max);
        let grid = Grid::build(&pts_wind, cell);
        for j in 0..pts_wind.len() {
            let hs = h_norm[idx_after[j] as usize];
            let mid = stratum_mid(hs, params.n_strata);
            let r = adaptive(
                params.wind_radius_min,
                params.wind_radius_max,
                mid,
                params.h_low,
                params.h_high,
            );
            let min_scans = adaptive(
                params.wind_min_other_scans_low,
                params.wind_min_other_scans_high,
                mid,
                params.h_low,
                params.h_high,
            )
            .round()
            .max(0.0) as usize;
            let mut others: std::collections::BTreeSet<i32> = std::collections::BTreeSet::new();
            grid.within(&pts_wind, pts_wind[j], r, |idx, _| {
                if idx as usize != j && scans[idx as usize] != scans[j] {
                    others.insert(scans[idx as usize]);
                }
            });
            if others.len() < min_scans {
                quality[idx_after[j] as usize] = Q_WIND;
            }
        }
    }

    quality
}

/// The height the adaptive parameters are evaluated at: the midpoint of
/// the point's stratum, not the point's own height.
///
/// This is the MATLAB's behaviour and it is deliberate — one radius per
/// stratum, so every point in a band is filtered on the same terms and
/// the result does not depend on where in the band a point happens to
/// sit. It also means `n_strata` is a real parameter rather than only a
/// batching detail.
pub fn stratum_mid(h_norm: f64, n_strata: u32) -> f64 {
    let n = n_strata.max(1) as f64;
    let s = stratum_of(h_norm, n_strata) as f64;
    (s + 0.5) / n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64, z: f64, hag: f64, refl: f64, scan: i32) -> QcPoint {
        QcPoint { pos: [x, y, z], hag, refl, scan }
    }

    /// A dense blob of `n` points inside a 2 cm ball, so it survives the
    /// outlier stage at any of these radii and the later stages have
    /// something to work on.
    fn blob(cx: f64, hag: f64, n: usize, refl: f64, scan: i32) -> Vec<QcPoint> {
        (0..n)
            .map(|i| {
                let t = i as f64 * 0.004;
                p(cx + t, t * 0.5, hag, hag, refl, scan)
            })
            .collect()
    }

    /// The MATLAB's `adaptive`: constant below `hLow`, constant above
    /// `hHigh`, linear between. Getting the clamp wrong makes the whole
    /// height adaptation either constant or unbounded.
    #[test]
    fn the_ramp_is_flat_below_and_above_and_linear_between() {
        let (lo, hi, h_low, h_high) = (0.04, 0.12, 0.60, 0.75);
        assert_eq!(adaptive(lo, hi, 0.0, h_low, h_high), lo);
        assert_eq!(adaptive(lo, hi, 0.60, h_low, h_high), lo);
        assert_eq!(adaptive(lo, hi, 0.75, h_low, h_high), hi);
        assert_eq!(adaptive(lo, hi, 1.0, h_low, h_high), hi);
        let mid = adaptive(lo, hi, 0.675, h_low, h_high);
        assert!((mid - 0.08).abs() < 1e-12, "halfway up the ramp should be halfway: {mid}");
        // A degenerate ramp is a step, not a division by zero.
        assert_eq!(adaptive(lo, hi, 0.5, 0.6, 0.6), lo);
        assert_eq!(adaptive(lo, hi, 0.7, 0.6, 0.6), hi);
    }

    /// Every normalised height belongs to exactly one stratum, and the
    /// top one is closed — the MATLAB's last stratum uses `<=` so the
    /// tallest point of every tree does not fall out of all of them.
    #[test]
    fn every_height_lands_in_exactly_one_stratum() {
        assert_eq!(stratum_of(0.0, 5), 0);
        assert_eq!(stratum_of(0.199, 5), 0);
        assert_eq!(stratum_of(0.2, 5), 1);
        assert_eq!(stratum_of(0.999, 5), 4);
        assert_eq!(stratum_of(1.0, 5), 4, "the top of the tree must be in the top stratum");
        // Midpoints are what the adaptive parameters are evaluated at.
        assert_eq!(stratum_mid(0.0, 5), 0.1);
        assert_eq!(stratum_mid(1.0, 5), 0.9);
        // A single stratum degenerates to one band at its middle.
        assert_eq!(stratum_of(0.7, 1), 0);
        assert_eq!(stratum_mid(0.7, 1), 0.5);
    }

    #[test]
    fn reflectance_outside_the_band_is_labelled_2() {
        let params = PointQcParams::default();
        let mut pts = blob(0.0, 5.0, 8, -10.0, 1);
        pts.push(p(0.0, 0.0, 5.0, 5.0, -40.0, 1)); // too dark
        pts.push(p(0.0, 0.0, 5.0, 5.0, 30.0, 1)); // glint
        let q = classify_tree(&pts, &params);
        assert_eq!(q[8], Q_REFLECTANCE);
        assert_eq!(q[9], Q_REFLECTANCE);
        assert!(q[..8].iter().all(|&v| v == Q_KEPT), "{q:?}");
    }

    /// A stray point has no neighbours; a dense cluster has plenty.
    #[test]
    fn a_stray_point_is_an_outlier_and_a_cluster_is_not() {
        let params = PointQcParams::default();
        let mut pts = blob(0.0, 2.0, 10, -10.0, 1);
        pts.push(p(5.0, 5.0, 2.0, 2.0, -10.0, 1)); // metres from anything
        let q = classify_tree(&pts, &params);
        assert_eq!(q[10], Q_OUTLIER);
        assert!(q[..10].iter().all(|&v| v == Q_KEPT), "{q:?}");
    }

    /// The point of the height ramp: the same sparse geometry is noise
    /// at the stem and foliage in the crown. With the default radii
    /// (4 cm low, 12 cm high) a 7 cm spacing is too sparse to survive
    /// low down and dense enough high up.
    #[test]
    fn the_outlier_radius_grows_with_height() {
        let params = PointQcParams::default();
        // A 3×3 patch at 5 cm spacing: nothing within 4 cm, plenty
        // within 12 cm. A line would not do — its endpoints are short
        // of neighbours at any radius, which is a property of the
        // fixture and not of the filter.
        let patch = |x0: f64, hag: f64| -> Vec<QcPoint> {
            (0..3)
                .flat_map(|i| (0..3).map(move |j| (i, j)))
                .map(|(i, j)| p(x0 + i as f64 * 0.05, j as f64 * 0.05, hag, hag, -10.0, 1))
                .collect::<Vec<_>>()
        };
        let mut pts = patch(0.0, 0.5); // hNorm ≈ 0.05 → r = 4 cm
        pts.extend(patch(10.0, 9.5)); // hNorm ≈ 0.95 → r = 12 cm
        let q = classify_tree(&pts, &params);
        assert!(
            q[..9].iter().all(|&v| v == Q_OUTLIER),
            "5 cm spacing at the stem should not survive a 4 cm radius: {:?}", &q[..9],
        );
        assert!(
            q[9..].iter().all(|&v| v == Q_KEPT),
            "the same spacing in the crown should survive a 12 cm radius: {:?}", &q[9..],
        );
    }

    /// The wind stage: a point whose neighbourhood holds returns from
    /// too few OTHER scan positions was measured while the branch was
    /// moving. High in the crown one other position is enough; low
    /// down the default demands two.
    #[test]
    fn a_point_too_few_other_scans_saw_is_wind() {
        let params = PointQcParams::default();
        // Crown: two scans, 1 demanded → kept.
        let mut pts = blob(0.0, 9.5, 6, -10.0, 1);
        pts.extend(blob(0.01, 9.5, 6, -10.0, 2));
        // Stem: two scans, 2 demanded → wind, though the geometry is
        // the same and both survived the earlier stages.
        pts.extend(blob(10.0, 0.5, 6, -10.0, 1));
        pts.extend(blob(10.01, 0.5, 6, -10.0, 2));
        let q = classify_tree(&pts, &params);
        assert!(
            q[..12].iter().all(|&v| v == Q_KEPT),
            "one corroborating scan is enough in the crown: {:?}", &q[..12],
        );
        assert!(
            q[12..].iter().all(|&v| v == Q_WIND),
            "two are demanded at the stem: {:?}", &q[12..],
        );
    }

    /// One scan position cannot corroborate anything, and the MATLAB
    /// skips the stage rather than deleting the cloud. Reproduced here:
    /// a single-scan tree comes back with no wind labels at all.
    #[test]
    fn a_single_scan_tree_gets_no_wind_labels() {
        let params = PointQcParams::default();
        let pts = blob(0.0, 1.0, 20, -10.0, 7);
        let q = classify_tree(&pts, &params);
        assert!(q.iter().all(|&v| v == Q_KEPT), "{q:?}");
        // …and with three scan positions the stage runs and keeps
        // them: a point in scan 7 now has TWO other positions
        // corroborating it, which is what the default demands this low
        // in the tree. Two scans in total would be one other, and
        // would be labelled wind — the demand is on *other* positions,
        // not on how many scans exist.
        let mut three = blob(0.0, 1.0, 20, -10.0, 7);
        three.extend(blob(0.005, 1.0, 20, -10.0, 8));
        three.extend(blob(0.010, 1.0, 20, -10.0, 9));
        assert!(
            classify_tree(&three, &params).iter().all(|&v| v == Q_KEPT),
            "two other positions is what the stem stratum demands",
        );
    }

    /// Each stage runs on what the previous one left, exactly as the
    /// MATLAB builds its trees over `idxRef` and then `idxAfterOutlier`.
    /// A point whose only neighbours failed the reflectance test is
    /// therefore alone by the time the outlier stage sees it — and a
    /// version that searched the full cloud would keep it.
    #[test]
    fn each_stage_runs_on_what_the_previous_one_left() {
        let params = PointQcParams::default();
        // One point, surrounded by glints only.
        let mut pts = vec![p(0.0, 0.0, 1.0, 1.0, -10.0, 1)];
        for i in 0..8 {
            pts.push(p(0.005 * (i as f64 + 1.0), 0.0, 1.0, 1.0, 40.0, 1));
        }
        // Enough other points elsewhere that the stage runs at all.
        pts.extend(blob(9.0, 1.0, 6, -10.0, 1));
        let q = classify_tree(&pts, &params);
        assert_eq!(
            q[0], Q_OUTLIER,
            "its neighbours were all rejected first, so it stands alone: {q:?}",
        );
        assert!(q[1..9].iter().all(|&v| v == Q_REFLECTANCE));
    }

    /// The density method is the other one the MATLAB offers
    /// (`pcdenoise`): mean distance to the k nearest, rejected beyond
    /// `std_mult` standard deviations of the cloud's mean.
    #[test]
    fn the_density_method_also_finds_a_stray() {
        let params = PointQcParams { outlier_method: "density".to_string(), ..Default::default() };
        let mut pts = blob(0.0, 2.0, 40, -10.0, 1);
        pts.push(p(3.0, 3.0, 2.0, 2.0, -10.0, 1));
        let q = classify_tree(&pts, &params);
        assert_eq!(q[40], Q_OUTLIER, "{q:?}");
        let kept = q[..40].iter().filter(|&&v| v == Q_KEPT).count();
        assert!(kept >= 38, "the dense blob should survive, kept {kept}/40");
    }

    /// The exporters' side of the contract: 1-based, never 0 (which
    /// LAS reserves for "unassigned"), and clamped rather than wrapped
    /// so scan 65536 does not come back as scan 0.
    #[test]
    fn scan_ids_start_at_one_and_never_wrap() {
        assert_eq!(scan_position_psid(0), 1);
        assert_eq!(scan_position_psid(1), 2);
        assert_eq!(scan_position_psid(65533), 65534);
        assert_eq!(scan_position_psid(65534), 65535);
        assert_eq!(scan_position_psid(65535), 65535, "clamped, not wrapped to 0");
        assert_eq!(scan_position_psid(10_000_000), 65535);
    }

    /// The documented hazard: the Editor's LAS export writes `tree_id`
    /// into `point_source_id`, so re-importing such a file gives a
    /// "scan id" that is constant within each tree. The wind stage must
    /// decline to filter — one distinct value is no corroboration — and
    /// not declare every point wind, which is what a naive
    /// implementation does since no point has a neighbour from another
    /// "scan".
    #[test]
    fn a_scan_column_that_is_really_a_tree_id_disables_the_wind_stage() {
        let params = PointQcParams::default();
        // Every point of this tree carries the same id, as a tree-id
        // column would. Low in the tree, where two other positions are
        // demanded — the harshest case.
        let pts = blob(0.0, 0.5, 30, -10.0, 4242);
        let q = classify_tree(&pts, &params);
        assert!(
            q.iter().all(|&v| v == Q_KEPT),
            "a constant scan column must disable the stage, not empty the tree: {q:?}",
        );
    }

    /// An empty tree is not an error, and a tree with no height span
    /// (every point at one height) normalises to a single stratum
    /// rather than dividing by zero.
    #[test]
    fn degenerate_trees_do_not_panic() {
        assert!(classify_tree(&[], &PointQcParams::default()).is_empty());
        let flat = blob(0.0, 3.0, 12, -10.0, 1);
        let q = classify_tree(&flat, &PointQcParams::default());
        assert_eq!(q.len(), 12);
        assert!(q.iter().all(|&v| v == Q_KEPT), "{q:?}");
    }
}
