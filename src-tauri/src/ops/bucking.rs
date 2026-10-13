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

//! Stem taper and log assortment — bucking, apteeraus
//! (`src/metrics/bucking.ts`), in Rust for the headless surfaces.
//!
//! Greedy bucking from the stump upward with descending priority — the
//! heuristic a harvester applies when no smart bucker is configured:
//! at the current height try the highest-priority assortment, take the
//! longest module whose top end still meets that assortment's minimum
//! top diameter, cut, advance, repeat.
//!
//! The rule that holds it together: every volume here is integrated
//! over the same taper, the same way the QSM integrated it. Logs, the
//! stump and the residue all come out of one integrator, so they add
//! up to the QSM's own stem volume rather than to two approximations
//! of it reconciled by subtraction. Bucking stops at the highest slice
//! a circle was fitted to: no log is sold out of stem nobody measured.

use std::collections::BTreeMap;
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::thinning::{normalise_currency, DEFAULT_CURRENCY};
use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::{octree_read_qsm, TreeQsm};

/// One timber assortment, highest priority first in the list.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assortment {
    pub id: String,
    pub name: String,
    /// Minimum acceptable top-end diameter, cm.
    pub min_top_dcm: f64,
    /// Length modules, metres; the bucker tries from the longest down.
    pub lengths: Vec<f64>,
    /// Price per cubic metre.
    pub price_per_m3: f64,
    /// Colour for the panel's overlays; carried for the CSV's sake only.
    #[serde(default)]
    pub colour: String,
}

/// The Bucking panel's defaults: Nordic sawlog, pulpwood and energy
/// wood modules and prices.
pub fn default_assortments() -> Vec<Assortment> {
    vec![
        Assortment { id: "saw".into(), name: "Sawlog".into(), min_top_dcm: 16.0, lengths: vec![3.7, 4.0, 4.3, 4.6, 4.9, 5.2, 5.5], price_per_m3: 60.0, colour: "#6fa8dc".into() },
        Assortment { id: "pulp".into(), name: "Pulpwood".into(), min_top_dcm: 7.0, lengths: vec![2.7, 3.0, 3.3, 3.6, 3.9, 4.2, 4.5, 4.8, 5.0], price_per_m3: 30.0, colour: "#67d391".into() },
        Assortment { id: "energy".into(), name: "Energy".into(), min_top_dcm: 5.0, lengths: vec![2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0], price_per_m3: 15.0, colour: "#e6c068".into() },
    ]
}

/// The panel's default stump height, metres.
pub const DEFAULT_STUMP_HEIGHT: f64 = 0.10;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Log {
    pub assortment_id: String,
    /// Lower edge, height above ground (m).
    pub h_low: f64,
    /// Upper edge, height above ground (m).
    pub h_high: f64,
    pub length: f64,
    /// Butt-end diameter (m).
    pub d_butt: f64,
    /// Top-end diameter (m).
    pub d_top: f64,
    pub volume: f64,
    pub revenue: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuckingResult {
    pub tree_id: i32,
    /// Full tree height from the metrics pass (m): the crown top.
    pub height: f64,
    /// Highest point on the stem the QSM fitted a circle to (m).
    /// Bucking stops here; under a closed canopy it sits well below `height`.
    pub measured_top: f64,
    pub logs: Vec<Log>,
    pub per_class: BTreeMap<String, f64>,
    pub revenue_per_class: BTreeMap<String, f64>,
    /// Σ log volumes (m³).
    pub logged_volume: f64,
    /// Below the first cut (m³).
    pub stump_volume: f64,
    /// Measured stem above the last cut (m³).
    pub residue_volume: f64,
    /// stump + residue: measured but not sold (m³).
    pub waste_volume: f64,
    /// stump + logged + residue; equals the QSM's own stem volume.
    pub taper_volume: f64,
    pub qsm_stem_volume: f64,
    pub total_revenue: f64,
}

/// A point on the measured taper: fitted diameter at a known height.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TaperPoint {
    pub h: f64,
    pub d: f64,
}

/// The measured taper: one point per accepted slice at the slice's MID
/// height, ascending. The slice height is the gap between the first
/// two slices (the TreeQSM path supplies cylinders of its own lengths
/// through the same record), 0.25 m for a single slice. No zero-diameter
/// anchor at the tree top: that invented stem nobody measured.
pub fn taper_points(t: &TreeQsm) -> Vec<TaperPoint> {
    let mut slices: Vec<(f64, f64)> = t.slices.iter().map(|s| (s.hag, s.radius)).collect();
    slices.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    if slices.is_empty() {
        return Vec::new();
    }
    let spacing = if slices.len() >= 2 { (slices[1].0 - slices[0].0).max(0.05) } else { 0.25 };
    slices.iter().map(|(hag, r)| TaperPoint { h: hag + spacing * 0.5, d: r * 2.0 }).collect()
}

/// `a > b`, false when either is NaN — spelled out so the negation
/// below reads as the NaN-aware guard it is.
fn above(a: f64, b: f64) -> bool {
    a.partial_cmp(&b) == Some(std::cmp::Ordering::Greater)
}

/// Diameter at height `h` (m): the butt diameter as a cylinder below the
/// first slice centre, linear between centres, 0 above the last one
/// (no measurement there).
pub fn diameter_at(pts: &[TaperPoint], h: f64) -> f64 {
    let Some(first) = pts.first() else { return 0.0 };
    let last = pts[pts.len() - 1];
    if h <= first.h {
        return first.d;
    }
    if h >= last.h {
        return if h == last.h { last.d } else { 0.0 };
    }
    let (mut lo, mut hi) = (0usize, pts.len() - 1);
    while hi - lo > 1 {
        let m = (lo + hi) >> 1;
        if pts[m].h <= h { lo = m } else { hi = m }
    }
    let (a, b) = (pts[lo], pts[hi]);
    let span = b.h - a.h;
    if !above(span, 0.0) {
        return a.d;
    }
    a.d + (b.d - a.d) * ((h - a.h) / span)
}

/// Cone-frustum volume, π/12 · L · (d_b² + d_b·d_t + d_t²).
pub fn frustum_volume(d_butt: f64, d_top: f64, length: f64) -> f64 {
    (std::f64::consts::PI / 12.0) * length * (d_butt * d_butt + d_butt * d_top + d_top * d_top)
}

/// Volume of the taper between two heights (m³), integrated the way the
/// QSM integrated it: a cylinder below the first slice centre, then one
/// frustum per slice interval, clipped to the span.
pub fn integrate_taper(pts: &[TaperPoint], h_low: f64, h_high: f64) -> f64 {
    if pts.is_empty() || !above(h_high, h_low) {
        return 0.0;
    }
    let top = pts[pts.len() - 1].h;
    let lo = h_low.max(0.0);
    let hi = h_high.min(top);
    if !above(hi, lo) {
        return 0.0;
    }
    let mut v = 0.0;
    let first = pts[0].h;
    if lo < first {
        let cyl_top = hi.min(first);
        v += std::f64::consts::PI * (pts[0].d * 0.5) * (pts[0].d * 0.5) * (cyl_top - lo);
        if cyl_top >= hi {
            return v;
        }
    }
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        if b.h <= lo {
            continue;
        }
        if a.h >= hi {
            break;
        }
        let s = a.h.max(lo);
        let e = b.h.min(hi);
        if !above(e, s) {
            continue;
        }
        v += frustum_volume(diameter_at(pts, s), diameter_at(pts, e), e - s);
    }
    v
}

/// Drop what cannot be a log length, sort ascending. Hygiene at the
/// input; termination is `buck_tree`'s own property.
pub fn sanitize_lengths(lengths: &[f64]) -> Vec<f64> {
    let mut out: Vec<f64> = lengths.iter().copied().filter(|l| l.is_finite() && *l > 0.0).collect();
    out.sort_by(|a, b| a.partial_cmp(b).unwrap());
    out
}

/// The renderer's `buckTree`. Terminates because every cut strictly
/// raises the height and an iteration that cuts nothing breaks: a
/// zero-length module passes every diameter test and is refused here,
/// whatever cleaned the input.
pub fn buck_tree(t: &TreeQsm, stump_height: f64, assortments: &[Assortment]) -> BuckingResult {
    let pts = taper_points(t);
    let measured_top = pts.last().map(|p| p.h).unwrap_or(0.0);
    let stump = if stump_height.is_finite() { stump_height.max(0.0) } else { 0.0 };
    let mut logs: Vec<Log> = Vec::new();
    let modules: Vec<Vec<f64>> = assortments
        .iter()
        .map(|a| {
            let mut m = a.lengths.clone();
            m.sort_by(|x, y| y.partial_cmp(x).unwrap_or(std::cmp::Ordering::Equal));
            m
        })
        .collect();

    let mut h = stump.min(measured_top);
    'outer: while h < measured_top {
        for (ai, a) in assortments.iter().enumerate() {
            for &len in &modules[ai] {
                let h_top = h + len;
                if !above(h_top, h) {
                    continue;
                }
                if h_top > measured_top {
                    continue;
                }
                let d_top = diameter_at(&pts, h_top);
                if d_top * 100.0 < a.min_top_dcm {
                    continue;
                }
                let d_butt = diameter_at(&pts, h);
                let v = integrate_taper(&pts, h, h_top);
                logs.push(Log { assortment_id: a.id.clone(), h_low: h, h_high: h_top, length: len, d_butt, d_top, volume: v, revenue: v * a.price_per_m3 });
                h = h_top;
                continue 'outer;
            }
        }
        break;
    }

    let mut per_class: BTreeMap<String, f64> = assortments.iter().map(|a| (a.id.clone(), 0.0)).collect();
    let mut revenue_per_class: BTreeMap<String, f64> = assortments.iter().map(|a| (a.id.clone(), 0.0)).collect();
    for log in &logs {
        *per_class.entry(log.assortment_id.clone()).or_insert(0.0) += log.volume;
        *revenue_per_class.entry(log.assortment_id.clone()).or_insert(0.0) += log.revenue;
    }
    let logged_volume: f64 = logs.iter().map(|l| l.volume).sum();
    let stump_volume = integrate_taper(&pts, 0.0, stump.min(measured_top));
    let residue_volume = integrate_taper(&pts, h, measured_top);
    let total_revenue: f64 = logs.iter().map(|l| l.revenue).sum();
    BuckingResult {
        tree_id: t.tree_id,
        height: t.height,
        measured_top,
        logs,
        per_class,
        revenue_per_class,
        logged_volume,
        stump_volume,
        residue_volume,
        waste_volume: stump_volume + residue_volume,
        taper_volume: stump_volume + logged_volume + residue_volume,
        qsm_stem_volume: t.stem_volume,
        total_revenue,
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlotTotals {
    pub per_class: BTreeMap<String, f64>,
    pub revenue_per_class: BTreeMap<String, f64>,
    pub waste: f64,
    /// Σ over trees of stump + logs + residue (m³).
    pub total_vol: f64,
    pub total_rev: f64,
    /// Trees whose stem was fitted to less than 80 % of the tree height.
    pub n_partially_measured: usize,
}

/// The fraction of the tree height below which a fitted stem counts as
/// partially measured.
pub const PARTIAL_MEASURE_FRACTION: f64 = 0.8;

pub fn plot_totals(results: &[BuckingResult], assortments: &[Assortment]) -> PlotTotals {
    let mut per_class: BTreeMap<String, f64> = assortments.iter().map(|a| (a.id.clone(), 0.0)).collect();
    let mut revenue_per_class: BTreeMap<String, f64> = assortments.iter().map(|a| (a.id.clone(), 0.0)).collect();
    let (mut waste, mut total_vol, mut total_rev, mut n_partial) = (0.0, 0.0, 0.0, 0);
    for r in results {
        for (k, v) in &r.per_class {
            *per_class.entry(k.clone()).or_insert(0.0) += v;
        }
        for (k, v) in &r.revenue_per_class {
            *revenue_per_class.entry(k.clone()).or_insert(0.0) += v;
        }
        waste += r.waste_volume;
        total_vol += r.taper_volume;
        total_rev += r.total_revenue;
        if r.height > 0.0 && r.measured_top < r.height * PARTIAL_MEASURE_FRACTION {
            n_partial += 1;
        }
    }
    PlotTotals { per_class, revenue_per_class, waste, total_vol, total_rev, n_partially_measured: n_partial }
}

// --- the operation ------------------------------------------------------------

fn stump() -> f64 { DEFAULT_STUMP_HEIGHT }
fn euro() -> String { DEFAULT_CURRENCY.into() }

/// The Bucking panel's inputs.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BuckingParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Stump height, metres above ground; nothing below it is cut (default 0.10).
    #[serde(default = "stump")]
    pub stump_height: f64,
    /// Assortments in priority order, each `{"id","name","minTopDcm","lengths":[m…],"pricePerM3"}`; null for the panel's sawlog / pulpwood / energy defaults.
    #[serde(default)]
    pub assortments: Option<Vec<Assortment>>,
    /// Currency symbol or code the prices and revenues are in (default "€").
    #[serde(default = "euro")]
    pub currency: String,
    /// Write the per-tree table as CSV here (the panel's "Export CSV").
    #[serde(default)]
    pub out_csv: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuckingReport {
    pub stump_height: f64,
    pub currency: String,
    pub assortments: Vec<Assortment>,
    pub totals: PlotTotals,
    pub trees: Vec<BuckingResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csv_path: Option<String>,
}

/// The money columns' suffix, from the currency's letters: `revenue_eur`
/// for "EUR", `revenue` for "€" (`currencyCsvSuffix`).
pub fn currency_csv_suffix(currency: &str) -> String {
    let letters: String = currency.chars().filter(|c| c.is_ascii_alphabetic()).map(|c| c.to_ascii_lowercase()).collect();
    if letters.is_empty() { "revenue".into() } else { format!("revenue_{letters}") }
}

fn csv_num(v: f64, decimals: usize) -> String {
    super::csvtext::csv_num(v, decimals)
}

/// The panel's CSV, column for column.
pub fn bucking_csv(results: &[BuckingResult], assortments: &[Assortment], currency: &str) -> String {
    let rev = currency_csv_suffix(currency);
    let mut headers = vec!["tree_id".to_string(), "height_m".into(), "measured_top_m".into(), "stem_volume_m3".into()];
    for a in assortments {
        headers.push(format!("{}_m3", a.id));
        headers.push(format!("{}_{rev}", a.id));
    }
    headers.extend(["stump_m3".to_string(), "residue_m3".into(), "waste_m3".into(), format!("total_{rev}")]);
    let mut out = headers.join(",");
    out.push('\n');
    for r in results {
        let mut row = vec![r.tree_id.to_string(), csv_num(r.height, 2), csv_num(r.measured_top, 2), csv_num(r.qsm_stem_volume, 4)];
        for a in assortments {
            row.push(csv_num(*r.per_class.get(&a.id).unwrap_or(&0.0), 4));
            row.push(csv_num(*r.revenue_per_class.get(&a.id).unwrap_or(&0.0), 2));
        }
        row.extend([csv_num(r.stump_volume, 4), csv_num(r.residue_volume, 4), csv_num(r.waste_volume, 4), csv_num(r.total_revenue, 2)]);
        out.push_str(&row.join(","));
        out.push('\n');
    }
    out
}

/// Every assortment usable: a non-empty, distinct id, a finite top
/// diameter and price, and lengths cleaned as the panel cleans them.
pub fn validate_assortments(given: &[Assortment]) -> Result<Vec<Assortment>, String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(given.len());
    for a in given {
        let id = a.id.trim();
        if id.is_empty() {
            return Err("every assortment needs an id".into());
        }
        if !seen.insert(id.to_string()) {
            return Err(format!("assortment id '{id}' is given twice"));
        }
        if !(a.min_top_dcm.is_finite() && a.min_top_dcm >= 0.0) {
            return Err(format!("assortment '{id}': minTopDcm must be zero or positive"));
        }
        if !(a.price_per_m3.is_finite() && a.price_per_m3 >= 0.0) {
            return Err(format!("assortment '{id}': pricePerM3 must be zero or positive"));
        }
        let lengths = sanitize_lengths(&a.lengths);
        if lengths.is_empty() {
            return Err(format!("assortment '{id}': lengths needs at least one positive module"));
        }
        out.push(Assortment { id: id.to_string(), lengths, ..a.clone() });
    }
    Ok(out)
}

fn metrics_bucking(_ctx: &OpContext, p: BuckingParams) -> Result<BuckingReport, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    if !(p.stump_height.is_finite() && p.stump_height >= 0.0) {
        return Err("stumpHeight must be zero or positive".into());
    }
    let currency = normalise_currency(&p.currency)?;
    let assortments = match &p.assortments {
        Some(a) if a.is_empty() => return Err("assortments must not be empty; omit it for the defaults".into()),
        Some(a) => validate_assortments(a)?,
        None => default_assortments(),
    };
    if let Some(out) = &p.out_csv {
        non_empty(out, "outCsv")?;
        if let Some(parent) = Path::new(out).parent().filter(|d| !d.as_os_str().is_empty()) {
            if !parent.is_dir() {
                return Err(format!("{} is not a directory", parent.display()));
            }
        }
    }
    let qsm = octree_read_qsm(p.octree_dir.clone())?.ok_or_else(|| "no qsm.json in the dataset: run metrics.qsm first".to_string())?;
    let trees: Vec<BuckingResult> = qsm.trees.iter().map(|t| buck_tree(t, p.stump_height, &assortments)).collect();
    let totals = plot_totals(&trees, &assortments);
    let csv_path = match &p.out_csv {
        Some(out) => {
            std::fs::write(out, bucking_csv(&trees, &assortments, &currency)).map_err(|e| format!("write {out}: {e}"))?;
            Some(out.clone())
        }
        None => None,
    };
    Ok(BuckingReport { stump_height: p.stump_height, currency, assortments, totals, trees, csv_path })
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![op!("metrics.bucking", Metrics, mutates: false, stage: None,
        "Buck every QSM stem into log assortments from the stump up (greedy, priority order, longest module first); volumes and revenue per class, per tree and for the plot; optionally as CSV.", BuckingParams, metrics_bucking)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::octree::QsmSlice;

    const SLICE: f64 = 0.25;

    fn slice(hag: f64, radius: f64) -> QsmSlice {
        serde_json::from_value(serde_json::json!({
            "hag": hag, "z": hag, "centerX": 0, "centerY": 0, "radius": radius, "rmse": 0.003, "nPoints": 400, "coverage": 1,
        }))
        .unwrap()
    }

    /// The QSM integrator, from its own description: a cylinder of the
    /// first slice's radius from the ground to the first slice centre,
    /// then a frustum between consecutive centres.
    fn qsm_stem_volume(slices: &[QsmSlice]) -> f64 {
        if slices.is_empty() {
            return 0.0;
        }
        let step = if slices.len() >= 2 { (slices[1].hag - slices[0].hag).max(0.0) } else { SLICE };
        let mut v = std::f64::consts::PI * slices[0].radius.powi(2) * (slices[0].hag + step * 0.5);
        for w in slices.windows(2) {
            let dh = (w[1].hag - w[0].hag).max(0.0);
            v += (std::f64::consts::PI / 3.0) * dh * (w[0].radius.powi(2) + w[0].radius * w[1].radius + w[1].radius.powi(2));
        }
        v
    }

    /// A stem measured from the ground to `top_slice`, tapering as
    /// d(h) = d0 · (1 − h/H)^exp; `height` is the crown top.
    fn tree(height: f64, top_slice: f64, d0: f64, exp: f64, tree_id: i32) -> TreeQsm {
        let mut slices = Vec::new();
        let mut hag = 0.0;
        while hag + SLICE <= top_slice + 1e-9 {
            let hc = hag + SLICE / 2.0;
            slices.push(slice(hag, d0 * (1.0 - hc / height).max(0.0).powf(exp) * 0.5));
            hag += SLICE;
        }
        let stem_volume = qsm_stem_volume(&slices);
        let mut t: TreeQsm = serde_json::from_value(serde_json::json!({
            "treeId": tree_id, "baseX": 0, "baseY": 0, "baseZ": 0, "height": height,
            "slices": [], "branches": [], "branchVolume": 0, "branchCount": 0,
            "totalVolume": 0, "stemVolume": stem_volume, "stemVolumeStd": 0.01, "stemVolumeCi95": 0.02,
            "dbh": 0.3, "confidence": 1, "completeness": 1, "acceptedSlices": slices.len(), "rejectedSlices": 0,
        }))
        .unwrap();
        t.slices = slices;
        t
    }

    fn std_tree(height: f64, top_slice: f64) -> TreeQsm {
        tree(height, top_slice, 0.34, 0.6, 1)
    }

    fn close(a: f64, b: f64, digits: i32) -> bool {
        (a - b).abs() < 10f64.powi(-digits) / 2.0
    }

    fn pts3() -> Vec<TaperPoint> {
        vec![TaperPoint { h: 1.0, d: 0.30 }, TaperPoint { h: 2.0, d: 0.26 }, TaperPoint { h: 3.0, d: 0.20 }]
    }

    #[test]
    fn taper_points_sit_at_slice_mid_height_sorted_and_stop_at_the_last_slice() {
        let t = std_tree(20.0, 1.0);
        let pts = taper_points(&t);
        assert!(close(pts[0].h, 0.125, 12) && close(pts[1].h, 0.375, 12));
        assert!(close(pts[0].d, t.slices[0].radius * 2.0, 12));
        let mut rev = std_tree(20.0, 2.0);
        rev.slices.reverse();
        let pts = taper_points(&rev);
        assert!(pts.windows(2).all(|w| w[1].h > w[0].h));
        let t = std_tree(22.0, 10.0);
        let pts = taper_points(&t);
        let top = pts.last().unwrap().h;
        assert!(close(top, 9.875, 9) && top < t.height);
        assert!(pts.iter().all(|p| p.d != 0.0));
        let mut none = std_tree(20.0, 10.0);
        none.slices.clear();
        assert!(taper_points(&none).is_empty());
    }

    #[test]
    fn diameter_interpolates_holds_the_butt_and_is_zero_above_the_last_slice() {
        let pts = pts3();
        assert!(close(diameter_at(&pts, 1.5), 0.28, 12) && close(diameter_at(&pts, 2.5), 0.23, 12));
        assert!(close(diameter_at(&pts, 1.0), 0.30, 12) && close(diameter_at(&pts, 3.0), 0.20, 12));
        assert!(close(diameter_at(&pts, 0.5), 0.30, 12) && close(diameter_at(&pts, 0.0), 0.30, 12));
        assert_eq!(diameter_at(&pts, 3.0001), 0.0);
        assert_eq!(diameter_at(&pts, 50.0), 0.0);
        assert_eq!(diameter_at(&[], 1.0), 0.0);
        let same = [TaperPoint { h: 1.0, d: 0.3 }, TaperPoint { h: 1.0, d: 0.2 }];
        assert!(diameter_at(&same, 1.0).is_finite());
    }

    #[test]
    fn frustum_reduces_to_cylinder_and_cone_and_is_the_qsm_formula() {
        assert!(close(frustum_volume(0.4, 0.4, 2.0), std::f64::consts::PI * 0.2 * 0.2 * 2.0, 12));
        assert!(close(frustum_volume(0.4, 0.0, 3.0), std::f64::consts::PI * 0.2 * 0.2 * 3.0 / 3.0, 12));
        let (db, dt, l) = (0.36, 0.22, 4.3);
        let (rb, rt) = (db / 2.0, dt / 2.0);
        assert!(close(frustum_volume(db, dt, l), (std::f64::consts::PI / 3.0) * l * (rb * rb + rb * rt + rt * rt), 15));
    }

    #[test]
    fn integrate_taper_agrees_with_the_qsm_integrator() {
        for (h, top, exp) in [(22.0, 22.0, 0.6), (22.0, 10.0, 0.6), (18.0, 18.0, 1.5), (30.0, 25.0, 0.4)] {
            let t = tree(h, top, 0.34, exp, 1);
            let pts = taper_points(&t);
            let whole = integrate_taper(&pts, 0.0, pts.last().unwrap().h);
            assert!(close(whole, t.stem_volume, 12), "H={h} top={top}: {whole} vs {}", t.stem_volume);
        }
        let pts = taper_points(&std_tree(22.0, 22.0));
        let top = pts.last().unwrap().h;
        for cut in [0.1, 1.0, 4.37, 13.2, top - 0.01] {
            assert!(close(integrate_taper(&pts, 0.0, cut) + integrate_taper(&pts, cut, top), integrate_taper(&pts, 0.0, top), 12));
        }
        let pts = taper_points(&std_tree(22.0, 10.0));
        let top = pts.last().unwrap().h;
        assert!(close(integrate_taper(&pts, 0.0, 1000.0), integrate_taper(&pts, 0.0, top), 12));
        assert_eq!(integrate_taper(&pts, top, 1000.0), 0.0);
        assert_eq!(integrate_taper(&pts, 5.0, 5.0), 0.0);
        assert_eq!(integrate_taper(&pts, 5.0, 4.0), 0.0);
        assert_eq!(integrate_taper(&[], 0.0, 10.0), 0.0);
        let pts = taper_points(&std_tree(22.0, 22.0));
        let chord = frustum_volume(diameter_at(&pts, 0.1), diameter_at(&pts, 5.6), 5.5);
        let real = integrate_taper(&pts, 0.1, 5.6);
        assert!((chord / real - 1.0).abs() > 0.002);
    }

    #[test]
    fn sanitize_lengths_drops_what_cannot_be_a_log_and_sorts() {
        assert_eq!(sanitize_lengths(&[0.0, 3.7, 4.0]), vec![3.7, 4.0]);
        assert_eq!(sanitize_lengths(&[-1.0, 3.0]), vec![3.0]);
        assert_eq!(sanitize_lengths(&[f64::NAN, f64::INFINITY, f64::NEG_INFINITY, 3.0]), vec![3.0]);
        assert_eq!(sanitize_lengths(&[4.0, 3.0, 5.0]), vec![3.0, 4.0, 5.0]);
        assert!(sanitize_lengths(&[]).is_empty() && sanitize_lengths(&[0.0, -2.0, f64::NAN]).is_empty());
    }

    const STUMP: f64 = 0.10;

    fn asst() -> Vec<Assortment> {
        default_assortments()
    }

    #[test]
    fn cuts_highest_priority_longest_first_contiguously_respecting_top_diameters() {
        let a = asst();
        let r = buck_tree(&std_tree(22.0, 22.0), STUMP, &a);
        assert!(r.logs.len() > 2);
        assert_eq!(r.logs[0].assortment_id, "saw");
        assert_eq!(r.logs[0].length, 5.5);
        assert!(close(r.logs[0].h_low, STUMP, 12));
        for w in r.logs.windows(2) {
            assert!(close(w[1].h_low, w[0].h_high, 12));
        }
        let rank = |id: &str| a.iter().position(|x| x.id == id).unwrap();
        for w in r.logs.windows(2) {
            assert!(rank(&w[1].assortment_id) >= rank(&w[0].assortment_id));
        }
        for log in &r.logs {
            let x = a.iter().find(|x| x.id == log.assortment_id).unwrap();
            assert!(log.d_top * 100.0 >= x.min_top_dcm - 1e-9);
            assert!(close(log.revenue, log.volume * x.price_per_m3, 12));
        }
        assert!(close(r.total_revenue, r.logs.iter().map(|l| l.revenue).sum(), 12));
        assert!(close(r.total_revenue, r.revenue_per_class.values().sum(), 12));
        assert!(close(r.per_class.values().sum::<f64>(), r.logged_volume, 12));
    }

    #[test]
    fn accounts_for_every_cubic_metre_and_never_sells_more_than_measured() {
        for top in [22.0, 15.0, 10.0, 5.0] {
            let t = std_tree(22.0, top);
            let r = buck_tree(&t, STUMP, &asst());
            assert!(close(r.stump_volume + r.logged_volume + r.residue_volume, r.taper_volume, 12), "top={top}");
            assert!(close(r.taper_volume, t.stem_volume, 12), "top={top}");
            assert!(close(r.waste_volume, r.stump_volume + r.residue_volume, 12));
            assert!(r.logged_volume <= t.stem_volume + 1e-12);
            assert!(r.measured_top <= t.height);
            assert!(r.logs.iter().all(|l| l.h_high <= r.measured_top + 1e-12));
        }
        let r = buck_tree(&std_tree(22.0, 10.0), STUMP, &asst());
        assert_eq!(r.height, 22.0);
        assert!(close(r.measured_top, 9.875, 9));
    }

    #[test]
    fn the_stump_is_uncut_waste_and_a_taller_one_leaves_less() {
        let r = buck_tree(&std_tree(22.0, 22.0), 0.30, &asst());
        assert!(close(r.logs[0].h_low, 0.30, 12));
        assert!(r.stump_volume > 0.0);
        let low = buck_tree(&std_tree(22.0, 22.0), 0.05, &asst());
        assert!(r.stump_volume > low.stump_volume);
        assert_eq!(buck_tree(&std_tree(22.0, 22.0), -1.0, &asst()).logs[0].h_low, 0.0);
        let t = std_tree(22.0, 1.0);
        let r = buck_tree(&t, 5.0, &asst());
        assert!(r.logs.is_empty());
        assert!(close(r.stump_volume, t.stem_volume, 12));
        assert_eq!(r.residue_volume, 0.0);
    }

    #[test]
    fn terminates_on_zero_negative_empty_or_unmeasured_input() {
        let saw = asst()[0].clone();
        let r = buck_tree(&std_tree(22.0, 22.0), STUMP, &[Assortment { lengths: vec![0.0, 4.0], ..saw.clone() }]);
        assert!(r.logs.iter().all(|l| l.length > 0.0) && r.logs.len() < 100 && !r.logs.is_empty());
        assert!(r.logs.iter().all(|l| l.length == 4.0));
        let r = buck_tree(&std_tree(22.0, 22.0), STUMP, &[Assortment { lengths: vec![0.0], ..saw.clone() }]);
        assert!(r.logs.is_empty());
        let r = buck_tree(&std_tree(22.0, 22.0), STUMP, &[Assortment { lengths: vec![-1.0], ..saw.clone() }]);
        assert!(r.logs.is_empty());
        assert!(close(r.residue_volume, r.qsm_stem_volume - r.stump_volume, 10));
        let shuffled = Assortment { lengths: vec![4.0, 5.5, 3.7], ..saw.clone() };
        let r = buck_tree(&std_tree(22.0, 22.0), STUMP, std::slice::from_ref(&shuffled));
        assert_eq!(r.logs[0].length, 5.5);
        assert_eq!(shuffled.lengths, vec![4.0, 5.5, 3.7], "the caller's assortment is not reordered");
        let r = buck_tree(&std_tree(22.0, 22.0), STUMP, &[]);
        assert!(r.logs.is_empty() && r.logged_volume == 0.0 && close(r.taper_volume, r.qsm_stem_volume, 12));
        let mut none = std_tree(22.0, 10.0);
        none.slices.clear();
        let r = buck_tree(&none, STUMP, &asst());
        assert!(r.logs.is_empty() && r.measured_top == 0.0 && r.taper_volume == 0.0 && r.total_revenue == 0.0);
    }

    #[test]
    fn plot_totals_add_up_and_count_the_partially_measured() {
        let trees = [std_tree(22.0, 22.0), tree(20.0, 20.0, 0.28, 0.6, 2), tree(22.0, 8.0, 0.34, 0.6, 3)];
        let a = asst();
        let results: Vec<BuckingResult> = trees.iter().map(|t| buck_tree(t, 0.10, &a)).collect();
        let p = plot_totals(&results, &a);
        assert!(close(p.total_rev, results.iter().map(|r| r.total_revenue).sum(), 10));
        assert!(close(p.waste, results.iter().map(|r| r.waste_volume).sum(), 10));
        for x in &a {
            assert!(close(p.per_class[&x.id], results.iter().map(|r| r.per_class[&x.id]).sum(), 12));
        }
        assert!(close(p.total_vol, trees.iter().map(|t| t.stem_volume).sum(), 10));
        let logged: f64 = p.per_class.values().sum();
        assert!(close(logged + p.waste, p.total_vol, 10));
        assert_eq!(p.n_partially_measured, 1);
        let empty = plot_totals(&[], &a);
        assert_eq!((empty.total_vol, empty.total_rev, empty.per_class["saw"], empty.n_partially_measured), (0.0, 0.0, 0.0, 0));
    }

    #[test]
    fn the_csv_is_the_panels_columns_named_for_the_currency() {
        assert_eq!(currency_csv_suffix("€"), "revenue");
        assert_eq!(currency_csv_suffix("EUR"), "revenue_eur");
        assert_eq!(currency_csv_suffix("US$"), "revenue_us");
        let a = asst();
        let results = vec![buck_tree(&std_tree(22.0, 22.0), STUMP, &a)];
        let csv = bucking_csv(&results, &a, "CLP");
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "tree_id,height_m,measured_top_m,stem_volume_m3,saw_m3,saw_revenue_clp,pulp_m3,pulp_revenue_clp,energy_m3,energy_revenue_clp,stump_m3,residue_m3,waste_m3,total_revenue_clp");
        let cells: Vec<&str> = lines[1].split(',').collect();
        assert_eq!(cells.len(), 14);
        assert_eq!(cells[0], "1");
        assert_eq!(cells[1], "22.00");
        assert_eq!(cells[13], format!("{:.2}", results[0].total_revenue));
    }

    #[test]
    fn assortments_are_validated_and_the_operation_refuses_bad_parameters_first() {
        let ok = validate_assortments(&[Assortment { id: " saw ".into(), name: "s".into(), min_top_dcm: 16.0, lengths: vec![4.0, 0.0, 3.0], price_per_m3: 60.0, colour: String::new() }]).unwrap();
        assert_eq!((ok[0].id.as_str(), ok[0].lengths.as_slice()), ("saw", &[3.0, 4.0][..]));
        let dup = asst().into_iter().chain(asst()).collect::<Vec<_>>();
        assert!(validate_assortments(&dup).unwrap_err().contains("twice"));
        let none = Assortment { lengths: vec![0.0], ..asst()[0].clone() };
        assert!(validate_assortments(&[none]).unwrap_err().contains("lengths"));

        let op = super::super::find("metrics.bucking").expect("metrics.bucking");
        assert!(!op.mutates);
        assert_eq!(op.params_schema()["properties"]["stumpHeight"]["default"], 0.1);
        let ctx = OpContext::silent();
        let run = |v: serde_json::Value| super::super::run("metrics.bucking", v, &ctx).unwrap_err();
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "stumpHeight": -1 })).contains("stumpHeight"));
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "assortments": [] })).contains("assortments"));
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "assortments": [{ "id": "a", "name": "A", "minTopDcm": 5, "lengths": [3], "pricePerM3": -1 }] })).contains("pricePerM3"));
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere" })).contains("qsm.json") || run(serde_json::json!({ "octreeDir": "/nowhere" })).contains("read"));
    }
}
