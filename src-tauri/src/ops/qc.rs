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

//! Per-tree quality control, headless.
//!
//! The QC panel and Tree Review rank trees by ten checks over the
//! per-tree metrics and the QSM cache: robust population statistics
//! (median and MAD, which a few bad trees do not move) plus a handful
//! of absolute tests. The checks live in the renderer, in
//! `src/metrics/qcFlags.ts`, and this is the same ten, rule for rule
//! and threshold for threshold, so the command line, the console and
//! the API rank a plot exactly as the panel does.
//!
//! Two implementations of one rule set is a liability, so the rules
//! are also pinned from both sides: `src/metrics/qcFlags.test.ts`
//! holds the fixtures for the renderer, the tests below hold the same
//! fixtures for this module, and `src/testing/qcParity.test.ts` reads
//! the thresholds out of both sources and refuses a drift in either.
//!
//! Also here: `merge_stem_fits`, the renderer's rule that a RANSAC
//! stem fit replaces the algebraic breast-height diameter wherever one
//! exists (`src/metrics/plotStats.ts`), because a QC run on the
//! command line has to see the same diameters the panel sees.

use serde::{Deserialize, Serialize};

use crate::commands::octree::{StemFit, TreeMetric, TreeQsm};

/// Which check produced a flag. Stable and machine-readable: the CSV
/// carries it, filters key on it, and the tests assert on it, so a
/// reworded message cannot break any of them.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum FlagCode {
    NoDbh,
    CrownLarge,
    CrownSmall,
    Slenderness,
    HeightHigh,
    HeightLow,
    FewPoints,
    QsmCoverage,
    QsmCompleteness,
    QsmVolume,
}

impl FlagCode {
    pub const ALL: [FlagCode; 10] = [
        FlagCode::NoDbh,
        FlagCode::CrownLarge,
        FlagCode::CrownSmall,
        FlagCode::Slenderness,
        FlagCode::HeightHigh,
        FlagCode::HeightLow,
        FlagCode::FewPoints,
        FlagCode::QsmCoverage,
        FlagCode::QsmCompleteness,
        FlagCode::QsmVolume,
    ];

    /// The stable identifier, as the renderer spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            FlagCode::NoDbh => "no-dbh",
            FlagCode::CrownLarge => "crown-large",
            FlagCode::CrownSmall => "crown-small",
            FlagCode::Slenderness => "slenderness",
            FlagCode::HeightHigh => "height-high",
            FlagCode::HeightLow => "height-low",
            FlagCode::FewPoints => "few-points",
            FlagCode::QsmCoverage => "qsm-coverage",
            FlagCode::QsmCompleteness => "qsm-completeness",
            FlagCode::QsmVolume => "qsm-volume",
        }
    }

    /// Short label per check, as the panel's filter chips show it.
    pub fn label(self) -> &'static str {
        match self {
            FlagCode::NoDbh => "no DBH fit",
            FlagCode::CrownLarge => "crown too big",
            FlagCode::CrownSmall => "crown too small",
            FlagCode::Slenderness => "slenderness",
            FlagCode::HeightHigh => "tall outlier",
            FlagCode::HeightLow => "short outlier",
            FlagCode::FewPoints => "few points",
            FlagCode::QsmCoverage => "QSM coverage",
            FlagCode::QsmCompleteness => "QSM gaps",
            FlagCode::QsmVolume => "QSM volume",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info = 1,
    Warning = 2,
    Critical = 3,
}

impl Severity {
    /// Sort key: higher is more severe. The same numbers as the
    /// renderer's `SEV_RANK`.
    pub fn rank(self) -> u8 {
        self as u8
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Critical => "critical",
            Severity::Warning => "warning",
            Severity::Info => "info",
        }
    }
}

/// One finding about one tree.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Flag {
    pub tree_id: i32,
    pub code: FlagCode,
    pub severity: Severity,
    /// Human-readable reason; lists show this verbatim.
    pub reason: String,
    /// What the user should do about it.
    pub hint: String,
    /// Where the tree is, when the caller knows: `[min, max]`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<[[f64; 3]; 2]>,
}

// --- robust statistics, as src/metrics/stats.ts computes them -------

fn sorted_finite(values: &[f64]) -> Vec<f64> {
    let mut v: Vec<f64> = values.iter().copied().filter(|x| x.is_finite()).collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v
}

/// Linear-interpolation percentile over the finite values, `q` in 0..=1.
/// NaN for no values.
pub fn percentile(values: &[f64], q: f64) -> f64 {
    let s = sorted_finite(values);
    if s.is_empty() {
        return f64::NAN;
    }
    if s.len() == 1 {
        return s[0];
    }
    let qq = if q.is_finite() { q.clamp(0.0, 1.0) } else { 0.5 };
    let h = (s.len() - 1) as f64 * qq;
    let lo = h.floor() as usize;
    let hi = (lo + 1).min(s.len() - 1);
    let t = h - lo as f64;
    s[lo] * (1.0 - t) + s[hi] * t
}

pub fn median(values: &[f64]) -> f64 {
    percentile(values, 0.5)
}

/// Median absolute deviation about `centre`.
pub fn mad(values: &[f64], centre: f64) -> f64 {
    if !centre.is_finite() {
        return f64::NAN;
    }
    let dev: Vec<f64> = values.iter().filter(|v| v.is_finite()).map(|v| (v - centre).abs()).collect();
    median(&dev)
}

/// 1.4826 × MAD ≈ 1σ for normally distributed data.
fn robust_sigma(m: f64) -> f64 {
    1.4826 * m
}

/// How far above the plot median a value sits, and whether that counts.
///
/// The σ test when the plot has a spread: more than three robust
/// standard deviations above the median. A plot whose values are all
/// equal has σ = 0, so the σ test could never fire however extreme the
/// outlier; with no spread to measure against, three times the median
/// is two trees fused. `z` is None on that fallback path, and the text
/// then says how many TIMES the median rather than a σ figure it does
/// not have.
struct Excess {
    out: bool,
    z: Option<f64>,
    ratio: f64,
}

fn far_above(v: f64, med: f64, sig: f64) -> Excess {
    let ratio = if med > 0.0 { v / med } else { f64::NAN };
    if sig > 0.0 {
        let z = (v - med) / sig;
        Excess { out: z > 3.0, z: Some(z), ratio }
    } else {
        Excess { out: med > 0.0 && v > med * 3.0, z: None, ratio }
    }
}

fn excess_text(e: &Excess) -> String {
    match e.z {
        Some(z) => format!("{z:.1}σ above"),
        None => format!("{:.1}×", e.ratio),
    }
}

/// Thousands separator, as the renderer's `toLocaleString()` prints a
/// count in an English locale.
fn with_commas(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// A tree's bounds, for the fly-to box on a flag.
pub type TreeBox = [[f64; 3]; 2];

/// Every anomaly flag for the tree population, sorted by severity
/// (most severe first) and then by tree id. `qsm` is the QSM cache by
/// tree id (None skips the three QSM checks); `bbox` looks up a tree's
/// bounds (None leaves the flags without one).
pub fn compute_flags(
    metrics: &[TreeMetric],
    qsm: Option<&dyn Fn(i32) -> Option<TreeQsm>>,
    qsm_volumes: Option<&[f64]>,
    bbox: Option<&dyn Fn(i32) -> Option<TreeBox>>,
) -> Vec<Flag> {
    if metrics.is_empty() {
        return Vec::new();
    }
    let finite = |sel: &dyn Fn(&TreeMetric) -> f64| -> Vec<f64> {
        metrics.iter().map(sel).filter(|v| v.is_finite()).collect()
    };
    let heights = finite(&|t| t.height);
    let dbhs = finite(&|t| t.dbh);
    let crowns = finite(&|t| t.crown_area);
    let counts = finite(&|t| t.count as f64);

    let h_med = median(&heights);
    let h_sig = robust_sigma(mad(&heights, h_med));
    let d_med = median(&dbhs);
    let _d_sig = robust_sigma(mad(&dbhs, d_med));
    let c_med = median(&crowns);
    let c_sig = robust_sigma(mad(&crowns, c_med));
    let n_med = median(&counts);

    // Volume statistics only when a QSM cache exists.
    let (v_med, v_sig) = match qsm_volumes {
        Some(vols) => {
            let v_med = median(vols);
            (v_med, robust_sigma(mad(vols, v_med)))
        }
        None => (f64::NAN, 0.0),
    };

    let mut out: Vec<Flag> = Vec::new();
    for t in metrics {
        let bx = bbox.and_then(|f| f(t.tree_id));
        let push = |out: &mut Vec<Flag>, code: FlagCode, severity: Severity, reason: String, hint: &str| {
            out.push(Flag { tree_id: t.tree_id, code, severity, reason, hint: hint.to_string(), bbox: bx });
        };

        // (1) Stemless tree: the DBH fit failed. Critical, because every
        // downstream per-tree metric depends on DBH.
        if !t.dbh.is_finite() {
            push(&mut out, FlagCode::NoDbh, Severity::Critical, "No DBH fit".into(),
                "Breast-height band missed the stem. Run RANSAC stem fit or check whether the trunk is visible at 1.3 m above ground.");
        }

        // (2) Under-segmented: crown area far above the plot median.
        if t.crown_area.is_finite() {
            let e = far_above(t.crown_area, c_med, c_sig);
            if e.out {
                push(&mut out, FlagCode::CrownLarge, Severity::Warning,
                    format!("Crown area {:.1} m² is {} the plot median ({:.1} m²)", t.crown_area, excess_text(&e), c_med),
                    "Likely two trees fused into one. Isolate this tree, lasso the half to peel off, click Split.");
            }
        }

        // (3) Over-segmented: tiny crown and few points, a fragment.
        if t.crown_area.is_finite() && t.crown_area < c_med * 0.15 && (t.count as f64) < n_med * 0.10 {
            push(&mut out, FlagCode::CrownSmall, Severity::Warning,
                format!("Crown area {:.1} m² and only {} points", t.crown_area, with_commas(t.count)),
                "Likely a fragment of a neighbouring crown. Merge it into the right tree.");
        }

        // (4) Slenderness outside 0.3–4.0 cm of diameter per metre of
        // height. An absolute range, never σ-gated: a stem outside it is
        // a bad fit whatever the rest of the plot looks like.
        if t.dbh.is_finite() && t.height.is_finite() && t.dbh > 0.0 && t.height > 0.0 {
            let ratio = (t.dbh * 100.0) / t.height;
            if !(0.3..=4.0).contains(&ratio) {
                push(&mut out, FlagCode::Slenderness, Severity::Warning,
                    format!("Slenderness DBH/H = {ratio:.2} cm/m is outside the typical 0.3–4.0 range"),
                    "Height–DBH mismatch usually means the DBH fit caught a branch instead of the stem, or the height includes leaf scatter above the canopy. Recompute or check by eye.");
            }
        }

        // (5) Height outliers, info only; σ-gated because a tall tree has
        // no ratio at which it stops being plausible.
        if t.height.is_finite() && h_sig > 0.0 {
            let z = (t.height - h_med) / h_sig;
            if z > 4.0 {
                push(&mut out, FlagCode::HeightHigh, Severity::Info,
                    format!("Height {:.1} m is {z:.1}σ above plot median ({:.1} m)", t.height, h_med),
                    "Real emergent tree, or the height captured a stray noise point in the crown. Inspect.");
            } else if z < -3.0 && t.height < 3.0 {
                push(&mut out, FlagCode::HeightLow, Severity::Info,
                    format!("Height {:.1} m well below plot median ({:.1} m)", t.height, h_med),
                    "May be a shrub or seedling rather than a tree. Consider raising the min-tree-height threshold.");
            }
        }

        // (6) Few points: statistics unreliable. Info.
        if n_med > 0.0 && (t.count as f64) < n_med * 0.05 {
            push(&mut out, FlagCode::FewPoints, Severity::Info,
                format!("Only {} points (median {})", with_commas(t.count), with_commas(n_med.round() as u64)),
                "Tree may be partially occluded or beyond effective scan range. Metrics will be noisier than usual.");
        }

        // QSM-derived checks, when a cache exists.
        if let Some(q) = qsm.and_then(|f| f(t.tree_id)) {
            // (7) Low angular coverage: the stem seen from one side only.
            if q.confidence < 0.50 {
                push(&mut out, FlagCode::QsmCoverage, Severity::Warning,
                    format!("QSM angular coverage {:.0} % — stem seen from one side only", q.confidence * 100.0),
                    "Add a scan position on the missing side before relying on volume / biomass for this tree.");
            }
            // (8) Low height completeness: gaps in the slice fit.
            if q.completeness < 0.50 {
                push(&mut out, FlagCode::QsmCompleteness, Severity::Warning,
                    format!("QSM height completeness {:.0} % — {} of {} slices rejected",
                        q.completeness * 100.0, q.rejected_slices, q.accepted_slices + q.rejected_slices),
                    "Stem partially occluded or noisy mid-canopy. Volume CI will be wide; consider re-scanning.");
            }
            // (9) Outlier stem volume: more than 4σ above the median.
            if v_sig > 0.0 {
                let z = (q.stem_volume - v_med) / v_sig;
                if z > 4.0 {
                    push(&mut out, FlagCode::QsmVolume, Severity::Warning,
                        format!("Stem volume {:.2} m³ is {z:.1}σ above plot median ({:.2} m³)", q.stem_volume, v_med),
                        "Likely a runaway slice radius. Check the taper sparkline (Metrics panel) and consider re-running QSM with a smaller continuity tolerance.");
                }
            }
        }
    }

    out.sort_by(|a, b| b.severity.rank().cmp(&a.severity.rank()).then(a.tree_id.cmp(&b.tree_id)));
    out
}

/// Worst severity per tree.
pub fn worst_by_tree(flags: &[Flag]) -> std::collections::BTreeMap<i32, Severity> {
    let mut m = std::collections::BTreeMap::new();
    for f in flags {
        let e = m.entry(f.tree_id).or_insert(f.severity);
        if f.severity.rank() > e.rank() {
            *e = f.severity;
        }
    }
    m
}

/// Where a tree's reported diameter came from.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DbhSource {
    /// The algebraic fit `run_tree_metrics` made over the breast-height band.
    Metrics,
    /// A RANSAC stem fit from stems.json replaced it.
    StemFit,
}

/// A per-tree metric row as the panels show it: the RANSAC diameter
/// where one exists, the basal area recomputed from it, and a note of
/// which it is.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergedMetric {
    #[serde(flatten)]
    pub metric: TreeMetric,
    pub dbh_source: DbhSource,
}

/// The renderer's `mergeStemFits`: a finite, positive RANSAC diameter
/// replaces the algebraic one and the basal area follows it. Everything
/// else about the tree is left as measured.
pub fn merge_stem_fits(metrics: &[TreeMetric], stems: Option<&[StemFit]>) -> Vec<MergedMetric> {
    let by_id: std::collections::HashMap<i32, &StemFit> = stems
        .map(|s| s.iter().map(|f| (f.tree_id, f)).collect())
        .unwrap_or_default();
    metrics
        .iter()
        .map(|t| {
            let mut m = t.clone();
            let mut source = DbhSource::Metrics;
            if let Some(f) = by_id.get(&t.tree_id) {
                if f.dbh.is_finite() && f.dbh > 0.0 {
                    m.dbh = f.dbh;
                    m.basal_area = std::f64::consts::PI * (f.dbh * 0.5) * (f.dbh * 0.5);
                    source = DbhSource::StemFit;
                }
            }
            MergedMetric { metric: m, dbh_source: source }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tree that trips no rule, so a test can perturb exactly one
    /// thing and attribute the resulting flag to it. The same fixture as
    /// src/metrics/qcFlags.test.ts.
    fn ok(tree_id: i32) -> TreeMetric {
        TreeMetric {
            tree_id,
            count: 5000,
            height: 20.0,
            dbh: 0.30,
            basal_area: std::f64::consts::PI * 0.15 * 0.15,
            crown_area: 30.0,
            crown_diameter: 6.2,
            x: tree_id as f64 * 10.0,
            y: 0.0,
            base_z: 0.0,
            lean_deg: 0.0,
        }
    }

    /// A plot of near-identical trees with a small deterministic wobble:
    /// tight enough that an injected outlier is unambiguous, spread
    /// enough that the σ rules have a σ to work with.
    fn plot(n: i32) -> Vec<TreeMetric> {
        (0..n)
            .map(|i| {
                let mut t = ok(i + 1);
                t.height = 20.0 + (i % 5) as f64 * 0.4;
                t.crown_area = 30.0 + (i % 7) as f64 * 1.5;
                t.count = 5000 + (i % 4) as u64 * 300;
                t
            })
            .collect()
    }

    fn flags(metrics: &[TreeMetric]) -> Vec<Flag> {
        compute_flags(metrics, None, None, None)
    }

    fn of(fs: &[Flag], id: i32) -> Vec<&Flag> {
        fs.iter().filter(|f| f.tree_id == id).collect()
    }

    #[test]
    fn nothing_to_judge_yields_nothing() {
        assert!(flags(&[]).is_empty());
    }

    #[test]
    fn a_tree_with_no_dbh_fit_is_critical() {
        let mut p = plot(30);
        let mut bad = ok(99);
        bad.dbh = f64::NAN;
        p.push(bad);
        let fs = flags(&p);
        let mine = of(&fs, 99);
        assert!(!mine.is_empty());
        assert!(mine.iter().any(|f| f.severity == Severity::Critical && f.code == FlagCode::NoDbh));
        assert!(mine.iter().any(|f| f.reason.contains("DBH")));
        // Critical sorts first.
        assert_eq!(fs[0].severity, Severity::Critical);
    }

    #[test]
    fn a_uniform_plot_is_unflagged() {
        let fs = flags(&plot(30));
        assert!(fs.is_empty(), "a uniform plot produced: {:?}", fs.iter().map(|f| &f.reason).collect::<Vec<_>>());
    }

    #[test]
    fn an_extreme_outlier_is_still_flagged_in_a_plot_with_zero_spread() {
        let mut p: Vec<TreeMetric> = (1..=30).map(ok).collect();
        let mut big = ok(99);
        big.crown_area = 300.0;
        p.push(big);
        let fs = flags(&p);
        let crown = of(&fs, 99).into_iter().find(|f| f.code == FlagCode::CrownLarge).expect("a 10× crown must be flagged with no spread");
        assert!(!crown.reason.contains("inf") && !crown.reason.contains("NaN"), "{}", crown.reason);
        assert!(crown.reason.contains("10.0× the plot median"), "{}", crown.reason);
        assert!(crown.reason.contains("30.0 m²"), "{}", crown.reason);
    }

    #[test]
    fn a_merely_large_crown_is_not_flagged_when_there_is_no_spread() {
        let mut p: Vec<TreeMetric> = (1..=30).map(ok).collect();
        let mut t = ok(99);
        t.crown_area = 60.0;
        p.push(t);
        assert!(of(&flags(&p), 99).iter().all(|f| f.code != FlagCode::CrownLarge));
    }

    #[test]
    fn a_fused_crown_reads_in_sigmas_when_the_plot_has_spread() {
        let mut p = plot(30);
        let mut t = ok(99);
        t.crown_area = 120.0;
        p.push(t);
        let fs = flags(&p);
        let crown = of(&fs, 99).into_iter().find(|f| f.code == FlagCode::CrownLarge).expect("flagged");
        assert!(crown.reason.contains("σ above the plot median"), "{}", crown.reason);
        assert!(!crown.reason.contains('×'), "{}", crown.reason);
        assert!(!crown.hint.is_empty());
    }

    #[test]
    fn slenderness_is_checked_whether_or_not_the_plot_has_spread() {
        let mut spread = plot(30);
        let mut fat = ok(99);
        fat.dbh = 2.0; // 10 cm/m
        spread.push(fat.clone());
        assert!(of(&flags(&spread), 99).iter().any(|f| f.code == FlagCode::Slenderness));

        let mut flat: Vec<TreeMetric> = (1..=30).map(ok).collect();
        flat.push(fat);
        let mut thin = ok(98);
        thin.dbh = 0.02; // 0.1 cm/m
        flat.push(thin);
        let fs = flags(&flat);
        assert!(of(&fs, 99).iter().any(|f| f.code == FlagCode::Slenderness));
        assert!(of(&fs, 98).iter().any(|f| f.code == FlagCode::Slenderness));
    }

    #[test]
    fn height_outliers_are_information_and_the_counts_are_printed_with_commas() {
        let mut p = plot(30);
        let mut tall = ok(99);
        tall.height = 60.0;
        p.push(tall);
        let mut sparse = ok(98);
        sparse.count = 40;
        p.push(sparse);
        let fs = flags(&p);
        let tall_flag = of(&fs, 99).into_iter().find(|f| f.code == FlagCode::HeightHigh).expect("tall");
        assert_eq!(tall_flag.severity, Severity::Info);
        let few = of(&fs, 98).into_iter().find(|f| f.code == FlagCode::FewPoints).expect("few points");
        assert!(few.reason.contains("median 5,300") || few.reason.contains("median 5,"), "{}", few.reason);
        // Severity order: everything critical, then warning, then info.
        let ranks: Vec<u8> = fs.iter().map(|f| f.severity.rank()).collect();
        let mut sorted = ranks.clone();
        sorted.sort_by(|a, b| b.cmp(a));
        assert_eq!(ranks, sorted);
    }

    fn qsm(tree_id: i32, confidence: f64, completeness: f64, stem_volume: f64) -> TreeQsm {
        TreeQsm {
            tree_id,
            base_x: 0.0,
            base_y: 0.0,
            base_z: 0.0,
            height: 20.0,
            slices: Vec::new(),
            branches: Vec::new(),
            branch_volume: 0.0,
            branch_count: 0,
            total_volume: stem_volume,
            stem_volume,
            stem_volume_std: 0.0,
            stem_volume_ci95: 0.0,
            dbh: 0.3,
            confidence,
            completeness,
            accepted_slices: 70,
            rejected_slices: 10,
            treeqsm: None,
        }
    }

    #[test]
    fn the_qsm_checks_fire_only_with_a_cache_and_use_the_volume_population() {
        let p = plot(30);
        let mut vols: Vec<f64> = Vec::new();
        let models: std::collections::HashMap<i32, TreeQsm> = p
            .iter()
            .map(|t| {
                let v = 1.0 + (t.tree_id % 3) as f64 * 0.05;
                vols.push(v);
                let q = match t.tree_id {
                    1 => qsm(1, 0.2, 0.9, v),  // one side only
                    2 => qsm(2, 0.9, 0.3, v),  // gaps
                    3 => qsm(3, 0.9, 0.9, 50.0), // runaway volume
                    _ => qsm(t.tree_id, 0.9, 0.9, v),
                };
                (t.tree_id, q)
            })
            .collect();
        vols[2] = 50.0;
        let lookup = |id: i32| models.get(&id).cloned();
        let fs = compute_flags(&p, Some(&lookup), Some(&vols), None);
        assert!(of(&fs, 1).iter().any(|f| f.code == FlagCode::QsmCoverage));
        assert!(of(&fs, 2).iter().any(|f| f.code == FlagCode::QsmCompleteness));
        assert!(of(&fs, 2).iter().any(|f| f.reason.contains("10 of 80 slices rejected")));
        assert!(of(&fs, 3).iter().any(|f| f.code == FlagCode::QsmVolume));
        assert!(of(&fs, 4).is_empty());
        // Without the cache, none of the three.
        assert!(flags(&p).is_empty());
    }

    #[test]
    fn the_bbox_travels_when_known_and_is_absent_otherwise() {
        let mut p = plot(30);
        let mut bad = ok(99);
        bad.dbh = f64::NAN;
        p.push(bad);
        let boxes = |id: i32| if id == 99 { Some([[0.0, 0.0, 0.0], [1.0, 1.0, 20.0]]) } else { None };
        let fs = compute_flags(&p, None, None, Some(&boxes));
        assert!(of(&fs, 99).iter().all(|f| f.bbox.is_some()));
        let fs = flags(&p);
        assert!(of(&fs, 99).iter().all(|f| f.bbox.is_none()));
        let json = serde_json::to_value(&fs[0]).unwrap();
        assert!(json.get("bbox").is_none(), "an unknown bbox is left out, not written as null");
        assert_eq!(json["code"], "no-dbh");
        assert_eq!(json["severity"], "critical");
    }

    #[test]
    fn worst_by_tree_keeps_the_most_severe_whatever_the_order() {
        let mk = |id, sev| Flag { tree_id: id, code: FlagCode::FewPoints, severity: sev, reason: String::new(), hint: String::new(), bbox: None };
        let fs = vec![mk(1, Severity::Info), mk(1, Severity::Critical), mk(2, Severity::Critical), mk(2, Severity::Info)];
        let w = worst_by_tree(&fs);
        assert_eq!(w[&1], Severity::Critical);
        assert_eq!(w[&2], Severity::Critical);
        assert!(Severity::Critical.rank() > Severity::Warning.rank() && Severity::Warning.rank() > Severity::Info.rank());
    }

    #[test]
    fn every_code_has_a_label_and_a_stable_name() {
        let names: std::collections::HashSet<&str> = FlagCode::ALL.iter().map(|c| c.as_str()).collect();
        assert_eq!(names.len(), 10);
        for c in FlagCode::ALL {
            assert!(!c.label().is_empty());
            assert_eq!(serde_json::to_value(c).unwrap(), c.as_str());
        }
    }

    #[test]
    fn the_robust_statistics_match_the_renderer() {
        assert!(median(&[]).is_nan());
        assert_eq!(median(&[3.0]), 3.0);
        assert_eq!(median(&[1.0, 2.0, 3.0, 4.0]), 2.5);
        assert_eq!(median(&[4.0, f64::NAN, 1.0, 3.0, 2.0]), 2.5);
        assert_eq!(percentile(&[0.0, 10.0], 0.25), 2.5);
        assert_eq!(mad(&[1.0, 2.0, 3.0, 4.0, 100.0], 3.0), 1.0);
        assert_eq!(with_commas(5300), "5,300");
        assert_eq!(with_commas(999), "999");
        assert_eq!(with_commas(1_234_567), "1,234,567");
    }

    #[test]
    fn a_ransac_fit_replaces_the_algebraic_diameter_and_the_basal_area_follows() {
        let p = plot(3);
        let stems = vec![
            StemFit { tree_id: 1, dbh: 0.40, center_x: 0.0, center_y: 0.0, inlier_count: 100, band_count: 120, rmse: 0.01, written_stem_points: 0 },
            StemFit { tree_id: 2, dbh: f64::NAN, center_x: 0.0, center_y: 0.0, inlier_count: 0, band_count: 0, rmse: f64::NAN, written_stem_points: 0 },
        ];
        let merged = merge_stem_fits(&p, Some(&stems));
        assert_eq!(merged[0].dbh_source, DbhSource::StemFit);
        assert!((merged[0].metric.dbh - 0.40).abs() < 1e-12);
        assert!((merged[0].metric.basal_area - std::f64::consts::PI * 0.2 * 0.2).abs() < 1e-12);
        assert_eq!(merged[1].dbh_source, DbhSource::Metrics, "a NaN fit changes nothing");
        assert_eq!(merged[1].metric.dbh, 0.30);
        assert_eq!(merged[2].dbh_source, DbhSource::Metrics, "no fit, no change");
        let none = merge_stem_fits(&p, None);
        assert!(none.iter().all(|m| m.dbh_source == DbhSource::Metrics));
        let json = serde_json::to_value(&merged[0]).unwrap();
        assert_eq!(json["dbhSource"], "stemFit");
        assert_eq!(json["treeId"], 1);
    }
}
