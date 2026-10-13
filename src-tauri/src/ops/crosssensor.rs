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

//! The cross-sensor comparison (`src/metrics/crossSensor.ts`) and the
//! tree model (`src/metrics/treeModel.ts`): match ALS- and TLS-based
//! tree positions, say how well they agree — with the detection rate
//! broken down by size, which is what a single F1 hides — write the
//! joined table a model is fitted on, fit that model (log-log or
//! linear, Duan's smearing for the back-transform, striped
//! cross-validation for the honest error) and predict a stem volume
//! for the trees the ground-based scan missed, marked where the
//! prediction extrapolates.

use std::collections::HashMap;
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::csvtext::{csv_field, csv_num, csv_text};
use super::matching::{match_by_position, MatchMethod};
use super::qc::merge_stem_fits;
use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::{octree_read_qsm, octree_read_stems, run_tree_metrics, TreeMetric};

// --- the join -------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct JoinedTree {
    pub als: Option<TreeMetric>,
    pub tls: Option<TreeMetric>,
    /// Separation of the two stem positions (m); NaN when unmatched.
    pub distance: f64,
    /// Reference diameter for the size breakdown: the TLS one where it
    /// exists, since that is the measured one.
    pub dbh: f64,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Detection {
    Matched,
    AlsOnly,
    TlsOnly,
}

impl Detection {
    pub fn as_str(self) -> &'static str {
        match self {
            Detection::Matched => "matched",
            Detection::AlsOnly => "alsOnly",
            Detection::TlsOnly => "tlsOnly",
        }
    }
}

pub fn classify(t: &JoinedTree) -> Detection {
    match (&t.als, &t.tls) {
        (Some(_), Some(_)) => Detection::Matched,
        (Some(_), None) => Detection::AlsOnly,
        _ => Detection::TlsOnly,
    }
}

pub struct JoinResult {
    pub rows: Vec<JoinedTree>,
    pub n_matched: usize,
    pub n_als_only: usize,
    pub n_tls_only: usize,
}

/// Every tree of both sensors exactly once: matched pairs, then the
/// ALS-only (a commission, or a TLS miss), then the TLS-only (an
/// omission).
pub fn join_sensors(als: &[TreeMetric], tls: &[TreeMetric], radius: f64, method: MatchMethod) -> JoinResult {
    let a: Vec<[f64; 2]> = als.iter().map(|t| [t.x, t.y]).collect();
    let b: Vec<[f64; 2]> = tls.iter().map(|t| [t.x, t.y]).collect();
    let r = match_by_position(&a, &b, radius, method);
    let mut rows = Vec::new();
    for p in &r.matches {
        rows.push(JoinedTree { als: Some(als[p.a].clone()), tls: Some(tls[p.b].clone()), distance: p.distance, dbh: tls[p.b].dbh });
    }
    for &i in &r.unmatched_a {
        rows.push(JoinedTree { als: Some(als[i].clone()), tls: None, distance: f64::NAN, dbh: als[i].dbh });
    }
    for &j in &r.unmatched_b {
        rows.push(JoinedTree { als: None, tls: Some(tls[j].clone()), distance: f64::NAN, dbh: tls[j].dbh });
    }
    JoinResult { rows, n_matched: r.matches.len(), n_als_only: r.unmatched_a.len(), n_tls_only: r.unmatched_b.len() }
}

// --- detection ------------------------------------------------------------------

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectionStats {
    pub true_positives: usize,
    pub false_positives: usize,
    pub false_negatives: usize,
    /// TP / (TP + FN); NaN when there were no real trees to find.
    pub recall: f64,
    /// TP / (TP + FP); NaN when there were no detections.
    pub precision: f64,
    pub f1: f64,
}

/// A rate over nothing is not zero, it is unknown: recall 0 for a plot
/// with no reference trees would read as total failure.
pub fn detection_stats(rows: &[JoinedTree]) -> DetectionStats {
    let (mut tp, mut fp, mut fnn) = (0usize, 0usize, 0usize);
    for t in rows {
        match classify(t) {
            Detection::Matched => tp += 1,
            Detection::AlsOnly => fp += 1,
            Detection::TlsOnly => fnn += 1,
        }
    }
    let recall = if tp + fnn > 0 { tp as f64 / (tp + fnn) as f64 } else { f64::NAN };
    let precision = if tp + fp > 0 { tp as f64 / (tp + fp) as f64 } else { f64::NAN };
    let f1 = if recall.is_finite() && precision.is_finite() && recall + precision > 0.0 {
        2.0 * recall * precision / (recall + precision)
    } else {
        f64::NAN
    };
    DetectionStats { true_positives: tp, false_positives: fp, false_negatives: fnn, recall, precision, f1 }
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SizeClassStats {
    /// Lower edge of the diameter class (m).
    pub dbh_low: f64,
    /// Upper edge, exclusive (m); null for the open top class.
    pub dbh_high: Option<f64>,
    /// Reference trees in this class (TP + FN), what recall rests on.
    pub n_reference: usize,
    #[serde(flatten)]
    pub stats: DetectionStats,
}

/// The size classes the breakdown uses when none are given (m).
pub const DEFAULT_DBH_CLASSES: [f64; 5] = [0.05, 0.15, 0.25, 0.35, 0.45];

/// The detection rate per diameter class: a tree on an edge goes in
/// the class above; one with no usable diameter, or below the lowest
/// edge, is set aside rather than called small.
pub fn detection_by_size(rows: &[JoinedTree], edges: &[f64]) -> (Vec<SizeClassStats>, DetectionStats) {
    let mut bounds: Vec<f64> = edges.to_vec();
    bounds.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut buckets: Vec<Vec<JoinedTree>> = bounds.iter().map(|_| Vec::new()).collect();
    let mut unplaced = Vec::new();
    for t in rows {
        let d = t.dbh;
        if bounds.is_empty() || !d.is_finite() || d <= 0.0 || d < bounds[0] {
            unplaced.push(t.clone());
            continue;
        }
        let mut k = 0;
        while k + 1 < bounds.len() && d >= bounds[k + 1] {
            k += 1;
        }
        buckets[k].push(t.clone());
    }
    let classes = buckets
        .iter()
        .enumerate()
        .map(|(k, b)| SizeClassStats {
            dbh_low: bounds[k],
            dbh_high: bounds.get(k + 1).copied(),
            n_reference: b.iter().filter(|t| t.tls.is_some()).count(),
            stats: detection_stats(b),
        })
        .collect();
    (classes, detection_stats(&unplaced))
}

// --- the deliverable table --------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct JoinedRow {
    pub detection: Detection,
    pub separation_m: f64,
    pub tls_tree_id: Option<i32>,
    pub tls_dbh_m: Option<f64>,
    pub tls_height_m: Option<f64>,
    /// TLS / MLS stem volume (m³): the response variable.
    pub tls_stem_volume_m3: Option<f64>,
    pub als_tree_id: Option<i32>,
    pub als_height_m: Option<f64>,
    pub als_crown_area_m2: Option<f64>,
    pub als_crown_diameter_m: Option<f64>,
    pub als_dbh_m: Option<f64>,
}

fn or_none(v: Option<f64>) -> Option<f64> {
    v.filter(|v| v.is_finite() && *v > 0.0)
}

/// One row per tree; a zero or missing measurement is absent, not a
/// value, so a tree with no stem measured has no volume to fit on.
pub fn to_rows(join: &JoinResult, stem_volume: Option<&HashMap<i32, f64>>) -> Vec<JoinedRow> {
    join.rows
        .iter()
        .map(|t| JoinedRow {
            detection: classify(t),
            separation_m: t.distance,
            tls_tree_id: t.tls.as_ref().map(|x| x.tree_id),
            tls_dbh_m: t.tls.as_ref().and_then(|x| or_none(Some(x.dbh))),
            tls_height_m: t.tls.as_ref().and_then(|x| or_none(Some(x.height))),
            tls_stem_volume_m3: t.tls.as_ref().and_then(|x| or_none(stem_volume.and_then(|m| m.get(&x.tree_id).copied()))),
            als_tree_id: t.als.as_ref().map(|x| x.tree_id),
            als_height_m: t.als.as_ref().and_then(|x| or_none(Some(x.height))),
            als_crown_area_m2: t.als.as_ref().and_then(|x| or_none(Some(x.crown_area))),
            als_crown_diameter_m: t.als.as_ref().and_then(|x| or_none(Some(x.crown_diameter))),
            als_dbh_m: t.als.as_ref().and_then(|x| or_none(Some(x.dbh))),
        })
        .collect()
}

pub const JOINED_CSV_HEADER: [&str; 11] = [
    "detection", "separation_m",
    "tls_tree_id", "tls_dbh_m", "tls_height_m", "tls_stem_volume_m3",
    "als_tree_id", "als_height_m", "als_crown_area_m2", "als_crown_diameter_m", "als_dbh_m",
];

fn opt(v: Option<f64>, d: usize) -> String {
    v.map(|v| csv_num(v, d)).unwrap_or_default()
}

pub fn row_to_cells(r: &JoinedRow) -> Vec<String> {
    vec![
        r.detection.as_str().to_string(),
        csv_num(r.separation_m, 3),
        r.tls_tree_id.map(|i| i.to_string()).unwrap_or_default(),
        opt(r.tls_dbh_m, 4), opt(r.tls_height_m, 2), opt(r.tls_stem_volume_m3, 5),
        r.als_tree_id.map(|i| i.to_string()).unwrap_or_default(),
        opt(r.als_height_m, 2), opt(r.als_crown_area_m2, 2), opt(r.als_crown_diameter_m, 2), opt(r.als_dbh_m, 4),
    ]
}

/// The panel's CSV: the header, then one line per row, every cell
/// through the formula guard.
pub fn joined_csv(rows: &[JoinedRow]) -> String {
    let mut lines = vec![JOINED_CSV_HEADER.join(",")];
    for r in rows {
        lines.push(row_to_cells(r).iter().map(|c| csv_field(c)).collect::<Vec<_>>().join(","));
    }
    csv_text(&lines)
}

// --- the tree model ----------------------------------------------------------------

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Predictor {
    Height,
    CrownArea,
    CrownDiameter,
}

impl Predictor {
    pub fn label(self) -> &'static str {
        match self {
            Predictor::Height => "ALS height",
            Predictor::CrownArea => "crown area",
            Predictor::CrownDiameter => "crown diameter",
        }
    }
    fn raw(self, t: &TreeMetric) -> f64 {
        match self {
            Predictor::Height => t.height,
            Predictor::CrownArea => t.crown_area,
            Predictor::CrownDiameter => t.crown_diameter,
        }
    }
}

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelForm {
    Loglog,
    Linear,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSpec {
    pub predictors: Vec<Predictor>,
    pub form: ModelForm,
}

pub fn default_spec() -> ModelSpec {
    ModelSpec { predictors: vec![Predictor::Height, Predictor::CrownArea], form: ModelForm::Loglog }
}

pub struct TrainingPair {
    pub als: TreeMetric,
    /// Measured stem volume from the ground-based scan (m³).
    pub volume: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Range {
    pub lo: f64,
    pub hi: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FittedModel {
    pub spec: ModelSpec,
    /// Intercept, then one slope per predictor, in the fitting space.
    pub coefficients: Vec<f64>,
    /// Pairs the fit rests on.
    pub n: usize,
    /// R² in the fitting space: the optimistic number.
    pub r2: f64,
    /// Duan's smearing factor for the back-transform; 1 for a linear fit.
    pub smearing: f64,
    /// Leave-fold-out RMSE in m³: the error to quote. NaN below enough pairs.
    pub cv_rmse: f64,
    /// Leave-fold-out mean error (predicted − measured, m³).
    pub cv_bias: f64,
    /// Observed range of each predictor; outside it is extrapolation.
    pub range: Vec<Range>,
}

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Prediction {
    /// Predicted stem volume (m³), NaN when the tree lacks a predictor.
    pub volume: f64,
    /// At least one predictor is outside the fitted range; the
    /// prediction is still returned, marked.
    pub extrapolated: bool,
}

/// Gauss–Jordan with partial pivoting; None when singular.
fn solve(a: &[Vec<f64>], b: &[f64]) -> Option<Vec<f64>> {
    let n = b.len();
    let mut m: Vec<Vec<f64>> = a.iter().enumerate().map(|(i, row)| { let mut r = row.clone(); r.push(b[i]); r }).collect();
    for col in 0..n {
        let mut piv = col;
        for r in col + 1..n {
            if m[r][col].abs() > m[piv][col].abs() {
                piv = r;
            }
        }
        if !m[piv][col].is_finite() || m[piv][col].abs() < 1e-12 {
            return None;
        }
        m.swap(col, piv);
        let d = m[col][col];
        for v in &mut m[col][col..=n] {
            *v /= d;
        }
        for r in 0..n {
            if r == col {
                continue;
            }
            let f = m[r][col];
            if f == 0.0 {
                continue;
            }
            let pivot_row = m[col].clone();
            for (v, p) in m[r][col..=n].iter_mut().zip(&pivot_row[col..=n]) {
                *v -= f * p;
            }
        }
    }
    let x: Vec<f64> = m.iter().map(|row| row[n]).collect();
    if x.iter().all(|v| v.is_finite()) { Some(x) } else { None }
}

fn ols(rows: &[Vec<f64>], y: &[f64]) -> Option<Vec<f64>> {
    let k = rows[0].len() + 1;
    let mut ata = vec![vec![0.0; k]; k];
    let mut aty = vec![0.0; k];
    for (i, row) in rows.iter().enumerate() {
        let mut xi = Vec::with_capacity(k);
        xi.push(1.0);
        xi.extend_from_slice(row);
        for a in 0..k {
            aty[a] += xi[a] * y[i];
            for b in 0..k {
                ata[a][b] += xi[a] * xi[b];
            }
        }
    }
    solve(&ata, &aty)
}

fn features(t: &TreeMetric, spec: &ModelSpec) -> Option<Vec<f64>> {
    let mut out = Vec::with_capacity(spec.predictors.len());
    for p in &spec.predictors {
        let v = p.raw(t);
        if !v.is_finite() || v <= 0.0 {
            return None;
        }
        out.push(if spec.form == ModelForm::Loglog { v.ln() } else { v });
    }
    Some(out)
}

fn predict_raw(coefficients: &[f64], x: &[f64]) -> f64 {
    let mut y = coefficients[0];
    for (i, xi) in x.iter().enumerate() {
        y += coefficients[i + 1] * xi;
    }
    y
}

pub fn back_transform(y: f64, form: ModelForm, smearing: f64) -> f64 {
    if form == ModelForm::Loglog { y.exp() * smearing } else { y }
}

/// Fewest matched pairs per predictor before a model is fitted.
pub const MIN_PAIRS_PER_PREDICTOR: usize = 8;

/// The renderer's `fitVolumeModel`: OLS in the fitting space, Duan's
/// smearing for the log back-transform, `folds`-fold striped (not
/// shuffled, so the same pairs give the same number) cross-validation
/// with each fold's own smearing. None below enough pairs or when the
/// predictors are collinear.
pub fn fit_volume_model(pairs: &[TrainingPair], spec: &ModelSpec, folds: usize) -> Option<FittedModel> {
    if spec.predictors.is_empty() {
        return None;
    }
    let (mut xs, mut ys, mut vs): (Vec<Vec<f64>>, Vec<f64>, Vec<f64>) = (Vec::new(), Vec::new(), Vec::new());
    for p in pairs {
        if !p.volume.is_finite() || p.volume <= 0.0 {
            continue;
        }
        let Some(f) = features(&p.als, spec) else { continue };
        xs.push(f);
        ys.push(if spec.form == ModelForm::Loglog { p.volume.ln() } else { p.volume });
        vs.push(p.volume);
    }
    let n = xs.len();
    if n < spec.predictors.len() * MIN_PAIRS_PER_PREDICTOR {
        return None;
    }
    let coefficients = ols(&xs, &ys)?;
    let y_mean = ys.iter().sum::<f64>() / n as f64;
    let (mut ss_res, mut ss_tot) = (0.0, 0.0);
    let mut resid = Vec::with_capacity(n);
    for i in 0..n {
        let yh = predict_raw(&coefficients, &xs[i]);
        resid.push(ys[i] - yh);
        ss_res += (ys[i] - yh) * (ys[i] - yh);
        ss_tot += (ys[i] - y_mean) * (ys[i] - y_mean);
    }
    let r2 = if ss_tot > 0.0 { 1.0 - ss_res / ss_tot } else { f64::NAN };
    let smearing = if spec.form == ModelForm::Loglog { resid.iter().map(|r| r.exp()).sum::<f64>() / n as f64 } else { 1.0 };

    let k = folds.min(n).max(2);
    let (mut sse, mut sum_err, mut cv_n) = (0.0, 0.0, 0usize);
    for f in 0..k {
        let (mut tr_x, mut tr_y, mut te) = (Vec::new(), Vec::new(), Vec::new());
        for i in 0..n {
            if i % k == f { te.push(i) } else { tr_x.push(xs[i].clone()); tr_y.push(ys[i]); }
        }
        if tr_x.len() < spec.predictors.len() + 2 || te.is_empty() {
            continue;
        }
        let Some(c) = ols(&tr_x, &tr_y) else { continue };
        let sm = if spec.form == ModelForm::Loglog {
            tr_x.iter().enumerate().map(|(i, x)| (tr_y[i] - predict_raw(&c, x)).exp()).sum::<f64>() / tr_x.len() as f64
        } else {
            1.0
        };
        for &i in &te {
            let vh = back_transform(predict_raw(&c, &xs[i]), spec.form, sm);
            if !vh.is_finite() {
                continue;
            }
            let e = vh - vs[i];
            sse += e * e;
            sum_err += e;
            cv_n += 1;
        }
    }
    let range = spec
        .predictors
        .iter()
        .map(|p| {
            let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
            for pr in pairs {
                let v = p.raw(&pr.als);
                if !v.is_finite() || v <= 0.0 || !pr.volume.is_finite() || pr.volume <= 0.0 {
                    continue;
                }
                lo = lo.min(v);
                hi = hi.max(v);
            }
            Range { lo, hi }
        })
        .collect();
    Some(FittedModel {
        spec: spec.clone(),
        coefficients,
        n,
        r2,
        smearing,
        cv_rmse: if cv_n > 0 { (sse / cv_n as f64).sqrt() } else { f64::NAN },
        cv_bias: if cv_n > 0 { sum_err / cv_n as f64 } else { f64::NAN },
        range,
    })
}

/// NaN rather than a negative volume: a linear fit extrapolating below
/// zero is the model saying the tree is outside what it describes.
pub fn predict_volume(model: &FittedModel, t: &TreeMetric) -> Prediction {
    let Some(f) = features(t, &model.spec) else { return Prediction { volume: f64::NAN, extrapolated: false } };
    let mut extrapolated = false;
    for (i, p) in model.spec.predictors.iter().enumerate() {
        let v = p.raw(t);
        let r = &model.range[i];
        if r.lo.is_finite() && (v < r.lo || v > r.hi) {
            extrapolated = true;
        }
    }
    let v = back_transform(predict_raw(&model.coefficients, &f), model.spec.form, model.smearing);
    Prediction { volume: if v.is_finite() && v > 0.0 { v } else { f64::NAN }, extrapolated }
}

pub fn describe_model(m: Option<&FittedModel>) -> String {
    let Some(m) = m else { return "not enough matched trees to fit a model".into() };
    let preds = m.spec.predictors.iter().map(|p| p.label()).collect::<Vec<_>>().join(" + ");
    let form = if m.spec.form == ModelForm::Loglog { "log-log" } else { "linear" };
    let err = if m.cv_rmse.is_finite() { format!("cross-validated RMSE {:.3} m³", m.cv_rmse) } else { "too few pairs to cross-validate".into() };
    format!("{form} on {preds}, {} matched trees · {err}", m.n)
}

// --- the operation ----------------------------------------------------------------

fn f_0_25() -> f64 { 0.25 }
fn f_0_5() -> f64 { 0.5 }
fn f_1_2() -> f64 { 1.2 }
fn f_1_4() -> f64 { 1.4 }
fn f_2_5() -> f64 { 2.5 }
fn yes() -> bool { true }
fn optimal() -> MatchMethod { MatchMethod::Optimal }
fn classes() -> Vec<f64> { DEFAULT_DBH_CLASSES.to_vec() }
fn predictors() -> Vec<Predictor> { default_spec().predictors }
fn loglog() -> ModelForm { ModelForm::Loglog }
fn u_5() -> u32 { 5 }

/// The Cross-sensor panel's inputs.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrossSensorParams {
    /// The airborne (ALS) dataset directory.
    pub als_dir: String,
    /// The ground-based (TLS / MLS) dataset directory, over the same plot.
    pub tls_dir: String,
    /// Match radius between an ALS crown position and a TLS stem, metres (default 2.5).
    #[serde(default = "f_2_5")]
    pub radius: f64,
    /// "optimal" (the Hungarian assignment, default) or "greedy".
    #[serde(default = "optimal")]
    pub method: MatchMethod,
    /// Lower edges of the diameter classes for the detection breakdown, metres (default 0.05, 0.15, 0.25, 0.35, 0.45).
    #[serde(default = "classes")]
    pub dbh_classes: Vec<f64>,
    /// Model predictors: "height", "crownArea", "crownDiameter" (default height and crownArea).
    #[serde(default = "predictors")]
    pub predictors: Vec<Predictor>,
    /// "loglog" (default) or "linear".
    #[serde(default = "loglog")]
    pub form: ModelForm,
    /// Cross-validation folds (default 5).
    #[serde(default = "u_5")]
    pub folds: u32,
    /// Crown raster cell, metres (default 0.25).
    #[serde(default = "f_0_25")]
    pub crown_cell: f64,
    /// Breast-height band, metres above ground (default 1.2 to 1.4).
    #[serde(default = "f_1_2")]
    pub bh_low: f64,
    /// Breast-height band, upper bound above ground, metres.
    #[serde(default = "f_1_4")]
    pub bh_high: f64,
    /// DTM cell size for heights above ground, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub dtm_cell: f64,
    /// Replace the algebraic DBH with each dataset's RANSAC stem fit where one exists (default true).
    #[serde(default = "yes")]
    pub merge_stems: bool,
    /// Write the joined table as CSV here (the panel's export).
    #[serde(default)]
    pub out_csv: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Predicted {
    /// ALS-only trees given a volume.
    pub n: usize,
    /// Of those, outside the fitted range.
    pub extrapolated: usize,
    /// Σ predicted volume, m³.
    pub total: f64,
    /// Per tree: ALS tree id, volume, extrapolated.
    pub trees: Vec<PredictedTree>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PredictedTree {
    pub als_tree_id: i32,
    pub volume: f64,
    pub extrapolated: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CrossSensorReport {
    pub als_trees: usize,
    pub tls_trees: usize,
    pub n_matched: usize,
    pub n_als_only: usize,
    pub n_tls_only: usize,
    pub radius: f64,
    pub method: MatchMethod,
    pub overall: DetectionStats,
    pub by_size: Vec<SizeClassStats>,
    pub unclassified: DetectionStats,
    /// Rows with a measured TLS volume.
    pub n_with_volume: usize,
    /// Σ measured TLS stem volume, m³.
    pub measured_total: f64,
    pub model: Option<FittedModel>,
    /// The model in words, or why there is none.
    pub model_description: String,
    pub predicted: Option<Predicted>,
    pub rows: Vec<JoinedRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csv_path: Option<String>,
}

fn measured(ctx: &OpContext, dir: &str, p: &CrossSensorParams) -> Result<Vec<TreeMetric>, String> {
    let sink = ctx.progress.under("metrics");
    let metrics = run_tree_metrics(&sink, dir, p.crown_cell, p.bh_low, p.bh_high, p.dtm_cell)?;
    let stems = if p.merge_stems { octree_read_stems(dir.to_string())? } else { None };
    Ok(merge_stem_fits(&metrics, stems.as_deref()).into_iter().map(|m| m.metric).collect())
}

fn change_cross_sensor(ctx: &OpContext, p: CrossSensorParams) -> Result<CrossSensorReport, String> {
    non_empty(&p.als_dir, "alsDir")?;
    non_empty(&p.tls_dir, "tlsDir")?;
    if !(p.radius.is_finite() && p.radius >= 0.0) {
        return Err("radius must be zero or positive".into());
    }
    if p.dbh_classes.is_empty() || !p.dbh_classes.iter().all(|e| e.is_finite() && *e > 0.0) {
        return Err("dbhClasses needs positive class edges".into());
    }
    if p.predictors.is_empty() {
        return Err("predictors must name at least one of height, crownArea, crownDiameter".into());
    }
    if p.folds < 2 {
        return Err("folds must be at least 2".into());
    }
    if let Some(out) = &p.out_csv {
        non_empty(out, "outCsv")?;
        if let Some(parent) = Path::new(out).parent().filter(|d| !d.as_os_str().is_empty()) {
            if !parent.is_dir() {
                return Err(format!("{} is not a directory", parent.display()));
            }
        }
    }
    let als = measured(ctx, &p.als_dir, &p)?;
    let tls = measured(ctx, &p.tls_dir, &p)?;
    let volumes: Option<HashMap<i32, f64>> = octree_read_qsm(p.tls_dir.clone())?.map(|q| q.trees.iter().map(|t| (t.tree_id, t.stem_volume)).collect());

    let join = join_sensors(&als, &tls, p.radius, p.method);
    let overall = detection_stats(&join.rows);
    let (by_size, unclassified) = detection_by_size(&join.rows, &p.dbh_classes);
    let rows = to_rows(&join, volumes.as_ref());
    let n_with_volume = rows.iter().filter(|r| r.tls_stem_volume_m3.is_some()).count();
    let measured_total: f64 = rows.iter().filter_map(|r| r.tls_stem_volume_m3).sum();

    let spec = ModelSpec { predictors: p.predictors.clone(), form: p.form };
    let pairs: Vec<TrainingPair> = join
        .rows
        .iter()
        .filter_map(|t| match (&t.als, &t.tls) {
            (Some(a), Some(b)) => volumes.as_ref().and_then(|m| m.get(&b.tree_id)).map(|v| TrainingPair { als: a.clone(), volume: *v }),
            _ => None,
        })
        .collect();
    let model = fit_volume_model(&pairs, &spec, p.folds as usize);
    let predicted = model.as_ref().map(|m| {
        let mut trees = Vec::new();
        for t in &join.rows {
            let (Some(a), None) = (&t.als, &t.tls) else { continue };
            let pr = predict_volume(m, a);
            if !pr.volume.is_finite() {
                continue;
            }
            trees.push(PredictedTree { als_tree_id: a.tree_id, volume: pr.volume, extrapolated: pr.extrapolated });
        }
        Predicted { n: trees.len(), extrapolated: trees.iter().filter(|t| t.extrapolated).count(), total: trees.iter().map(|t| t.volume).sum(), trees }
    });
    let csv_path = match &p.out_csv {
        Some(out) => {
            std::fs::write(out, joined_csv(&rows)).map_err(|e| format!("write {out}: {e}"))?;
            Some(out.clone())
        }
        None => None,
    };
    Ok(CrossSensorReport {
        als_trees: als.len(),
        tls_trees: tls.len(),
        n_matched: join.n_matched,
        n_als_only: join.n_als_only,
        n_tls_only: join.n_tls_only,
        radius: p.radius,
        method: p.method,
        overall,
        by_size,
        unclassified,
        n_with_volume,
        measured_total,
        model_description: describe_model(model.as_ref()),
        model,
        predicted,
        rows,
        csv_path,
    })
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![op!("change.crossSensor", Change, mutates: false, stage: Some("metrics"),
        "Match ALS and TLS / MLS trees over one plot: detection rate overall and by diameter class, the joined table with the TLS stem volume beside the ALS metrics, a volume model fitted on the matched trees and applied to the ones TLS missed.", CrossSensorParams, change_cross_sensor)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(tree_id: i32, x: f64, y: f64, dbh: f64, height: f64) -> TreeMetric {
        TreeMetric {
            tree_id,
            count: 4000,
            height,
            dbh,
            basal_area: if dbh.is_finite() && dbh > 0.0 { std::f64::consts::PI * (dbh / 2.0).powi(2) } else { f64::NAN },
            crown_area: 12.0,
            crown_diameter: 3.9,
            x,
            y,
            base_z: 0.0,
            lean_deg: 0.0,
        }
    }

    fn joined(als: Option<TreeMetric>, tls: Option<TreeMetric>) -> JoinedTree {
        let dbh = tls.as_ref().map(|t| t.dbh).or(als.as_ref().map(|t| t.dbh)).unwrap_or(f64::NAN);
        let distance = if als.is_some() && tls.is_some() { 0.5 } else { f64::NAN };
        JoinedTree { als, tls, distance, dbh }
    }

    fn close(a: f64, b: f64, digits: i32) -> bool {
        (a - b).abs() < 10f64.powi(-digits) / 2.0
    }

    #[test]
    fn join_pairs_a_crown_with_the_stem_under_it_and_keeps_the_rest() {
        let r = join_sensors(&[tree(1, 0.0, 0.0, 0.31, 20.0), tree(2, 10.0, 0.0, 0.26, 20.0)], &[tree(101, 0.6, 0.0, 0.30, 20.0), tree(102, 10.4, 0.0, 0.25, 20.0)], 2.0, MatchMethod::Optimal);
        assert_eq!((r.n_matched, r.n_als_only, r.n_tls_only), (2, 0, 0));
        let m: Vec<(i32, i32)> = r.rows.iter().filter(|t| classify(t) == Detection::Matched).map(|t| (t.als.as_ref().unwrap().tree_id, t.tls.as_ref().unwrap().tree_id)).collect();
        assert_eq!(m, vec![(1, 101), (2, 102)]);
        assert!(close(r.rows[0].distance, 0.6, 9));

        let r = join_sensors(&[tree(1, 0.0, 0.0, 0.30, 20.0), tree(2, 50.0, 50.0, 0.28, 20.0)], &[tree(101, 0.4, 0.0, 0.30, 20.0), tree(102, 20.0, 0.0, 0.12, 20.0)], 2.0, MatchMethod::Optimal);
        assert_eq!(r.rows.len(), 3);
        assert_eq!((r.n_matched, r.n_als_only, r.n_tls_only), (1, 1, 1));
        let mut kinds: Vec<&str> = r.rows.iter().map(|t| classify(t).as_str()).collect();
        kinds.sort();
        assert_eq!(kinds, vec!["alsOnly", "matched", "tlsOnly"]);

        let r = join_sensors(&[tree(1, 0.0, 0.0, 0.99, 20.0)], &[tree(101, 0.3, 0.0, 0.30, 20.0)], 2.0, MatchMethod::Optimal);
        assert!(close(r.rows[0].dbh, 0.30, 9), "the measured diameter wins");

        let als: Vec<TreeMetric> = (0..9).map(|i| tree(i, i as f64 * 2.0, 0.0, 0.3, 20.0)).collect();
        let tls: Vec<TreeMetric> = (0..7).map(|i| tree(100 + i, i as f64 * 2.0 + 0.4, 0.0, 0.3, 20.0)).collect();
        let r = join_sensors(&als, &tls, 1.5, MatchMethod::Optimal);
        assert_eq!(r.rows.len(), r.n_matched + r.n_als_only + r.n_tls_only);
        assert_eq!((r.n_matched + r.n_als_only, r.n_matched + r.n_tls_only), (9, 7));

        assert_eq!(join_sensors(&[], &[tree(1, 0.0, 0.0, 0.3, 20.0)], 2.0, MatchMethod::Optimal).n_tls_only, 1);
        assert_eq!(join_sensors(&[tree(1, 0.0, 0.0, 0.3, 20.0)], &[], 2.0, MatchMethod::Optimal).n_als_only, 1);
        assert!(join_sensors(&[], &[], 2.0, MatchMethod::Optimal).rows.is_empty());
    }

    #[test]
    fn detection_stats_count_hits_false_alarms_and_misses_and_say_unknown_not_zero() {
        let rows = vec![
            joined(Some(tree(1, 0.0, 0.0, 0.3, 20.0)), Some(tree(101, 0.0, 0.0, 0.3, 20.0))),
            joined(Some(tree(2, 0.0, 0.0, 0.3, 20.0)), Some(tree(102, 0.0, 0.0, 0.3, 20.0))),
            joined(Some(tree(3, 0.0, 0.0, 0.3, 20.0)), None),
            joined(None, Some(tree(103, 0.0, 0.0, 0.3, 20.0))),
            joined(None, Some(tree(104, 0.0, 0.0, 0.3, 20.0))),
        ];
        let s = detection_stats(&rows);
        assert_eq!((s.true_positives, s.false_positives, s.false_negatives), (2, 1, 2));
        assert!(close(s.recall, 0.5, 12) && close(s.precision, 2.0 / 3.0, 12));
        assert!(close(s.f1, 2.0 * (0.5 * (2.0 / 3.0)) / (0.5 + 2.0 / 3.0), 12));
        let perfect = detection_stats(&[joined(Some(tree(1, 0.0, 0.0, 0.3, 20.0)), Some(tree(101, 0.0, 0.0, 0.3, 20.0)))]);
        assert_eq!((perfect.recall, perfect.precision, perfect.f1), (1.0, 1.0, 1.0));
        let none = detection_stats(&[]);
        assert!(none.true_positives == 0 && none.recall.is_nan() && none.precision.is_nan() && none.f1.is_nan());
        let missed = detection_stats(&[joined(None, Some(tree(1, 0.0, 0.0, 0.3, 20.0)))]);
        assert!(missed.recall == 0.0 && missed.precision.is_nan());
        let false_only = detection_stats(&[joined(Some(tree(1, 0.0, 0.0, 0.3, 20.0)), None)]);
        assert!(false_only.recall.is_nan() && false_only.precision == 0.0);
    }

    fn stand() -> Vec<JoinedTree> {
        let mut v: Vec<JoinedTree> = (0..4).map(|i| joined(None, Some(tree(200 + i, 0.0, 0.0, 0.10, 20.0)))).collect();
        v.push(joined(Some(tree(1, 0.0, 0.0, 0.20, 20.0)), Some(tree(210, 0.0, 0.0, 0.20, 20.0))));
        v.push(joined(Some(tree(2, 0.0, 0.0, 0.20, 20.0)), Some(tree(211, 0.0, 0.0, 0.20, 20.0))));
        v.push(joined(None, Some(tree(212, 0.0, 0.0, 0.20, 20.0))));
        v.push(joined(None, Some(tree(213, 0.0, 0.0, 0.20, 20.0))));
        for k in 0..3 {
            v.push(joined(Some(tree(3 + k, 0.0, 0.0, 0.40, 20.0)), Some(tree(220 + k, 0.0, 0.0, 0.40, 20.0))));
        }
        v
    }

    #[test]
    fn detection_by_size_shows_the_rate_rising_with_diameter_which_the_overall_figure_hides() {
        let (classes, _) = detection_by_size(&stand(), &DEFAULT_DBH_CLASSES);
        let by = |lo: f64| classes.iter().find(|c| c.dbh_low == lo).unwrap();
        assert_eq!(by(0.05).stats.recall, 0.0);
        assert!(close(by(0.15).stats.recall, 0.5, 12));
        assert_eq!(by(0.35).stats.recall, 1.0);
        assert!(close(detection_stats(&stand()).recall, 5.0 / 11.0, 12));
        assert_eq!(by(0.05).n_reference, 4);
        assert_eq!(classes.iter().map(|c| c.dbh_low).collect::<Vec<_>>(), DEFAULT_DBH_CLASSES.to_vec());
        assert_eq!(classes.last().unwrap().dbh_high, None);
        assert_eq!(classes.iter().map(|c| c.n_reference).sum::<usize>(), 11);

        let (classes, _) = detection_by_size(&[joined(None, Some(tree(1, 0.0, 0.0, 0.25, 20.0)))], &DEFAULT_DBH_CLASSES);
        assert_eq!(classes.iter().find(|c| c.dbh_low == 0.25).unwrap().n_reference, 1);
        assert_eq!(classes.iter().find(|c| c.dbh_low == 0.15).unwrap().n_reference, 0);
        let (classes, _) = detection_by_size(&[joined(None, Some(tree(1, 0.0, 0.0, 1.20, 20.0)))], &DEFAULT_DBH_CLASSES);
        assert_eq!(classes.last().unwrap().n_reference, 1);
        let (classes, unclassified) = detection_by_size(&[joined(None, Some(tree(1, 0.0, 0.0, f64::NAN, 20.0))), joined(None, Some(tree(2, 0.0, 0.0, 0.0, 20.0))), joined(None, Some(tree(3, 0.0, 0.0, 0.01, 20.0)))], &DEFAULT_DBH_CLASSES);
        assert_eq!((classes[0].n_reference, unclassified.false_negatives), (0, 3));
        let (classes, _) = detection_by_size(&[joined(None, Some(tree(1, 0.0, 0.0, 0.30, 20.0)))], &[0.20, 0.40]);
        assert_eq!((classes.len(), classes[0].n_reference, classes[1].dbh_high), (2, 1, None));
        let (classes, _) = detection_by_size(&[joined(None, Some(tree(1, 0.0, 0.0, 0.30, 20.0)))], &[0.40, 0.20]);
        assert_eq!(classes.iter().map(|c| c.dbh_low).collect::<Vec<_>>(), vec![0.20, 0.40]);
    }

    #[test]
    fn the_deliverable_table_leaves_the_unmeasured_empty() {
        let join = join_sensors(&[tree(1, 0.0, 0.0, 0.31, 20.0), tree(9, 50.0, 50.0, 0.28, 20.0)], &[tree(101, 0.4, 0.0, 0.30, 20.0), tree(109, 20.0, 0.0, 0.12, 20.0)], 2.0, MatchMethod::Optimal);
        let vols: HashMap<i32, f64> = [(101, 0.842), (109, 0.031)].into();
        let rows = to_rows(&join, Some(&vols));
        let m = rows.iter().find(|r| r.detection == Detection::Matched).unwrap();
        assert_eq!((m.tls_tree_id, m.als_tree_id), (Some(101), Some(1)));
        assert!(close(m.tls_stem_volume_m3.unwrap(), 0.842, 9) && close(m.als_crown_area_m2.unwrap(), 12.0, 9) && close(m.separation_m, 0.4, 9));
        let a = rows.iter().find(|r| r.detection == Detection::AlsOnly).unwrap();
        assert!(a.tls_stem_volume_m3.is_none());
        let col = JOINED_CSV_HEADER.iter().position(|h| *h == "tls_stem_volume_m3").unwrap();
        assert_eq!(row_to_cells(a)[col], "");
        let t = rows.iter().find(|r| r.detection == Detection::TlsOnly).unwrap();
        assert!(t.als_tree_id.is_none() && t.als_height_m.is_none());
        assert!(close(t.tls_stem_volume_m3.unwrap(), 0.031, 9));
        assert_eq!(row_to_cells(t)[1], "");
        for r in &rows {
            assert_eq!(row_to_cells(r).len(), JOINED_CSV_HEADER.len());
        }
        assert!(to_rows(&join, None).iter().all(|r| r.tls_stem_volume_m3.is_none()));
        let j = join_sensors(&[tree(1, 0.0, 0.0, 0.3, 0.0)], &[tree(101, 0.2, 0.0, f64::NAN, 20.0)], 2.0, MatchMethod::Optimal);
        let zero: HashMap<i32, f64> = [(101, 0.0)].into();
        let r = &to_rows(&j, Some(&zero))[0];
        assert!(r.als_height_m.is_none() && r.tls_dbh_m.is_none() && r.tls_stem_volume_m3.is_none());
        let csv = joined_csv(&rows);
        assert!(csv.starts_with("\u{feff}detection,separation_m,tls_tree_id"));
        assert_eq!(csv.lines().count(), 4);
    }

    // --- treeModel.test.ts ---

    fn mtree(height: f64, crown_area: f64, tree_id: i32) -> TreeMetric {
        TreeMetric {
            tree_id,
            count: 4000,
            height,
            dbh: 0.25,
            basal_area: std::f64::consts::PI * 0.125 * 0.125,
            crown_area,
            crown_diameter: 2.0 * (crown_area / std::f64::consts::PI).sqrt(),
            x: 0.0,
            y: 0.0,
            base_z: 0.0,
            lean_deg: 0.0,
        }
    }

    fn lcg(seed: u32) -> impl FnMut() -> f64 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            s as f64 / 4_294_967_296.0
        }
    }

    /// V = 0.02 · h^1.2 · A^0.6 with multiplicative noise.
    fn synthetic_plot(n: usize, noise: f64, seed: u32) -> Vec<TrainingPair> {
        let mut rnd = lcg(seed);
        (0..n)
            .map(|i| {
                let height = 8.0 + rnd() * 18.0;
                let crown_area = 4.0 + rnd() * 26.0;
                let truth = 0.02 * height.powf(1.2) * crown_area.powf(0.6);
                let v = truth * ((rnd() - 0.5) * 2.0 * noise).exp();
                TrainingPair { als: mtree(height, crown_area, i as i32 + 1), volume: v }
            })
            .collect()
    }

    fn plot(n: usize, noise: f64) -> Vec<TrainingPair> {
        synthetic_plot(n, noise, 20260821)
    }

    #[test]
    fn recovers_a_known_allometry_and_predicts_from_it() {
        let m = fit_volume_model(&plot(120, 0.0), &default_spec(), 5).unwrap();
        assert!(close(m.coefficients[0], 0.02f64.ln(), 6) && close(m.coefficients[1], 1.2, 6) && close(m.coefficients[2], 0.6, 6));
        assert!(close(m.r2, 1.0, 6));
        let truth = 0.02 * 20f64.powf(1.2) * 15f64.powf(0.6);
        assert!(close(predict_volume(&m, &mtree(20.0, 15.0, 1)).volume, truth, 4));
        let m = fit_volume_model(&plot(200, 0.25), &default_spec(), 5).unwrap();
        assert!(m.coefficients[1] > 0.9 && m.coefficients[1] < 1.5 && m.coefficients[2] > 0.4 && m.coefficients[2] < 0.8);
    }

    #[test]
    fn the_cross_validated_error_is_the_honest_one() {
        let noisy = fit_volume_model(&plot(150, 0.35), &default_spec(), 5).unwrap();
        assert!(noisy.cv_rmse.is_finite() && noisy.cv_rmse > 0.0);
        let clean = fit_volume_model(&plot(150, 0.0), &default_spec(), 5).unwrap();
        assert!(clean.cv_rmse < noisy.cv_rmse);

        let mut rnd = lcg(555);
        let mut pairs = Vec::new();
        let mut vols = Vec::new();
        for i in 0..80 {
            let v = 0.2 + rnd() * 1.6;
            pairs.push(TrainingPair { als: mtree(8.0 + rnd() * 18.0, 4.0 + rnd() * 26.0, i + 1), volume: v });
            vols.push(v);
        }
        let m = fit_volume_model(&pairs, &default_spec(), 5).unwrap();
        let mean = vols.iter().sum::<f64>() / vols.len() as f64;
        let sd = (vols.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / vols.len() as f64).sqrt();
        let in_sample = (pairs.iter().map(|p| (predict_volume(&m, &p.als).volume - p.volume).powi(2)).sum::<f64>() / pairs.len() as f64).sqrt();
        assert!(in_sample < sd);
        assert!(m.cv_rmse > in_sample && m.cv_rmse > sd * 0.9);

        let pairs = plot(90, 0.2);
        let a = fit_volume_model(&pairs, &default_spec(), 5).unwrap();
        let b = fit_volume_model(&pairs, &default_spec(), 5).unwrap();
        assert_eq!((a.cv_rmse, a.coefficients), (b.cv_rmse, b.coefficients));
    }

    #[test]
    fn corrects_the_log_back_transform_and_leaves_the_linear_form_alone() {
        let pairs = plot(200, 0.4);
        let m = fit_volume_model(&pairs, &default_spec(), 5).unwrap();
        assert!(m.smearing > 1.0);
        let with: f64 = pairs.iter().map(|p| predict_volume(&m, &p.als).volume).sum();
        let naive = with / m.smearing;
        let measured: f64 = pairs.iter().map(|p| p.volume).sum();
        assert!(naive < measured * 0.99);
        assert!((with / measured - 1.0).abs() < (naive / measured - 1.0).abs());
        let lin = fit_volume_model(&plot(120, 0.1), &ModelSpec { predictors: vec![Predictor::Height], form: ModelForm::Linear }, 5).unwrap();
        assert_eq!(lin.smearing, 1.0);
        assert_eq!(back_transform(3.5, ModelForm::Linear, 1.0), 3.5);
    }

    #[test]
    fn refuses_to_fit_what_it_cannot_and_drops_what_is_not_a_measurement() {
        let spec = default_spec();
        let need = 2 * MIN_PAIRS_PER_PREDICTOR;
        assert!(fit_volume_model(&plot(need - 1, 0.0), &spec, 5).is_none());
        assert!(fit_volume_model(&plot(need, 0.0), &spec, 5).is_some());
        assert!(fit_volume_model(&[], &spec, 5).is_none());
        assert!(fit_volume_model(&plot(100, 0.0), &ModelSpec { predictors: vec![], form: ModelForm::Loglog }, 5).is_none());
        let pairs: Vec<TrainingPair> = (0..60).map(|i| TrainingPair { als: mtree(10.0 + i as f64 * 0.2, 12.0, i), volume: 0.3 + i as f64 * 0.01 }).collect();
        assert!(fit_volume_model(&pairs, &ModelSpec { predictors: vec![Predictor::CrownArea, Predictor::CrownDiameter], form: ModelForm::Loglog }, 5).is_none(), "collinear");

        let mut good = plot(40, 0.0);
        let n_good = good.len();
        good.push(TrainingPair { als: mtree(20.0, 15.0, 900), volume: 0.0 });
        good.push(TrainingPair { als: mtree(21.0, 16.0, 901), volume: f64::NAN });
        good.push(TrainingPair { als: mtree(22.0, 17.0, 902), volume: -1.0 });
        good.push(TrainingPair { als: mtree(0.0, 15.0, 903), volume: 0.4 });
        good.push(TrainingPair { als: mtree(20.0, f64::NAN, 904), volume: 0.4 });
        assert_eq!(fit_volume_model(&good, &spec, 5).unwrap().n, n_good);
    }

    #[test]
    fn predictions_are_marked_outside_the_fitted_range_and_never_zero_or_negative() {
        let m = fit_volume_model(&plot(150, 0.2), &default_spec(), 5).unwrap();
        let p = predict_volume(&m, &mtree(18.0, 18.0, 1));
        assert!(!p.extrapolated && p.volume > 0.0);
        let p = predict_volume(&m, &mtree(4.0, 3.0, 1));
        assert!(p.extrapolated && p.volume > 0.0);
        assert!(predict_volume(&m, &mtree(40.0, 60.0, 1)).extrapolated);
        assert!(predict_volume(&m, &mtree(18.0, 200.0, 1)).extrapolated);
        assert!(predict_volume(&m, &mtree(f64::NAN, 15.0, 1)).volume.is_nan());
        assert!(predict_volume(&m, &mtree(20.0, 0.0, 1)).volume.is_nan());
        let lin = fit_volume_model(&plot(120, 0.0), &ModelSpec { predictors: vec![Predictor::Height], form: ModelForm::Linear }, 5).unwrap();
        let p = predict_volume(&lin, &mtree(0.5, 12.0, 1));
        assert!(p.volume.is_nan() || p.volume > 0.0);
    }

    #[test]
    fn describes_the_model_or_its_absence() {
        let s = describe_model(fit_volume_model(&plot(120, 0.2), &default_spec(), 5).as_ref());
        assert!(s.contains("log-log") && s.contains("ALS height") && s.contains("crown area") && s.contains("120 matched trees"));
        assert!(s.contains("cross-validated RMSE ") && s.contains(" m³"));
        assert!(describe_model(None).contains("not enough matched trees"));
        assert!(describe_model(fit_volume_model(&plot(3, 0.0), &default_spec(), 5).as_ref()).contains("not enough"));
        assert_eq!(default_spec(), ModelSpec { predictors: vec![Predictor::Height, Predictor::CrownArea], form: ModelForm::Loglog });
    }

    #[test]
    fn the_operation_is_catalogued_with_the_panels_defaults_and_refuses_bad_parameters() {
        let op = super::super::find("change.crossSensor").expect("change.crossSensor");
        let schema = op.params_schema();
        assert_eq!(schema["properties"]["radius"]["default"], 2.5);
        assert_eq!(schema["properties"]["method"]["default"], "optimal");
        assert_eq!(schema["properties"]["form"]["default"], "loglog");
        assert_eq!(schema["properties"]["predictors"]["default"], serde_json::json!(["height", "crownArea"]));
        assert_eq!(schema["properties"]["dbhClasses"]["default"], serde_json::json!([0.05, 0.15, 0.25, 0.35, 0.45]));
        let ctx = OpContext::silent();
        let run = |v: serde_json::Value| super::super::run("change.crossSensor", v, &ctx).unwrap_err();
        assert!(run(serde_json::json!({ "alsDir": "/a" })).contains("tlsDir"));
        assert!(run(serde_json::json!({ "alsDir": "/a", "tlsDir": "/b", "radius": -1 })).contains("radius"));
        assert!(run(serde_json::json!({ "alsDir": "/a", "tlsDir": "/b", "predictors": [] })).contains("predictors"));
        assert!(run(serde_json::json!({ "alsDir": "/a", "tlsDir": "/b", "folds": 1 })).contains("folds"));
        assert!(run(serde_json::json!({ "alsDir": "/a", "tlsDir": "/b", "method": "random" })).contains("invalid parameters"));
    }
}
