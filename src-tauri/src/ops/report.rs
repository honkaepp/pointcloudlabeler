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

//! The HTML inventory report (`src/report/generate.ts`), in Rust for
//! the headless surfaces: one self-contained .html file the forester
//! can save, e-mail or print to PDF, every chart an inline SVG, no
//! external assets.
//!
//! The sections the desktop panel fills from other panels' in-memory
//! state — field-data validation, tree growth, M3C2 change, stem
//! taper — have nothing on disk to read from and are not rendered
//! here; the report says what it can back up and nothing else. The
//! per-plot summary, the volume / biomass / carbon block, the revenue
//! line, the density metrics, the distributions, the plot map, the
//! per-tree table and the methodology are the same markup as the
//! renderer's, and a figure that could not be measured is an em dash,
//! never "NaN".

use std::collections::HashMap;
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::forestry::{
    biomass_params_for_species, compute_biomass_totals, compute_species_aware_biomass, fallback_density_label,
    species_density, tree_stats, validate_biomass_params, AreaBasis, BiomassParams, CUSTOM_SPECIES_KEY,
    DEFAULT_BIOMASS_PARAMS, SPECIES_DENSITIES,
};
use super::qc::{median, merge_stem_fits, DbhSource, MergedMetric};
use super::thinning::{normalise_currency, resolve_plot_area, DEFAULT_CURRENCY};
use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::{
    octree_read_plot, octree_read_qsm, octree_read_species, octree_read_stems, run_density_metrics, run_tree_metrics,
    DensityMetricsResult, QsmResult, TreeMetric, TreeQsm,
};

pub const PRODUCT_NAME: &str = "PointCloudLabeler";
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The uniform-grade price behind the revenue line.
#[derive(Clone, Debug)]
pub struct Bucking {
    pub unit_price: f64,
    pub currency: String,
}

/// The species-aware biomass block, already computed per tree and
/// summed by the caller; the report only renders it.
#[derive(Clone, Debug, Default)]
pub struct BiomassBlock {
    /// Per-species tree counts behind the totals, richest first.
    pub species_mix: Vec<(String, usize)>,
    pub fallback_count: usize,
    pub fallback_label: String,
    /// The basic density the unassigned trees were computed at.
    pub fallback_density: Option<f64>,
    /// The preset's provenance; None when the analyst supplied the figure.
    pub fallback_source: Option<String>,
    pub biomass_kg: f64,
    pub biomass_kg_ci95: f64,
    pub carbon_kg: f64,
    pub carbon_kg_ci95: f64,
    pub co2e_kg: f64,
    pub co2e_kg_ci95: f64,
}

/// What the density block prints, lifted off `DensityMetricsResult`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DensitySummary {
    pub cell_size: f64,
    pub cols: usize,
    pub rows: usize,
    pub min_height: f64,
    pub plot_count: u64,
    pub plot_density: f64,
    pub plot_mean: f64,
    pub plot_sd: f64,
    pub plot_p25: f64,
    pub plot_p50: f64,
    pub plot_p75: f64,
    pub plot_p90: f64,
    pub plot_p95: f64,
    pub canopy_threshold: f64,
    pub plot_canopy_cover: f64,
    pub plot_skew: f64,
    pub plot_kurt: f64,
}

impl From<&DensityMetricsResult> for DensitySummary {
    fn from(d: &DensityMetricsResult) -> Self {
        DensitySummary {
            cell_size: d.cell_size,
            cols: d.cols,
            rows: d.rows,
            min_height: d.min_height,
            plot_count: d.plot_count,
            plot_density: d.plot_density,
            plot_mean: d.plot_mean,
            plot_sd: d.plot_sd,
            plot_p25: d.plot_p25,
            plot_p50: d.plot_p50,
            plot_p75: d.plot_p75,
            plot_p90: d.plot_p90,
            plot_p95: d.plot_p95,
            canopy_threshold: d.canopy_threshold,
            plot_canopy_cover: d.plot_canopy_cover,
            plot_skew: d.plot_skew,
            plot_kurt: d.plot_kurt,
        }
    }
}

/// The field-validation block: the DBH figures in centimetres, as the
/// Validation panel hands them to the report.
pub use super::validation::ValidationSummary;

/// The tree-growth block, from `change.growth`.
#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GrowthBlock {
    pub years: f64,
    pub n_matched: usize,
    pub mean_dbh_growth_cm_per_year: f64,
    pub mean_height_growth_m_per_year: f64,
    pub volume_change_m3: f64,
    pub harvested: usize,
    pub ingrowth: usize,
}

/// The M3C2 block, from `change.m3c2`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct M3c2Block {
    pub reference_name: String,
    pub core_points: u64,
    pub significant_pct: f64,
    pub mean_change_cm: f64,
    pub median_change_cm: f64,
}

pub struct ReportInputs<'a> {
    pub m3c2: Option<&'a M3c2Block>,
    pub field_validation: Option<ValidationSummary>,
    pub growth: Option<GrowthBlock>,
    pub project_name: &'a str,
    pub description: Option<&'a str>,
    pub plot_area_ha: f64,
    pub plot_area_basis: AreaBasis,
    pub crs_label: Option<&'a str>,
    pub metrics: &'a [MergedMetric],
    pub qsm: Option<&'a QsmResult>,
    pub density: Option<&'a DensitySummary>,
    pub bucking: Option<&'a Bucking>,
    pub biomass: Option<&'a BiomassBlock>,
    /// The date printed on the cover, YYYY-MM-DD.
    pub date: &'a str,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Moments {
    pub dbh: f64,
    pub height: f64,
}

/// The plot summary the report prints (`summarise`). Each statistic
/// ranges over the trees that have what it needs; a figure with nothing
/// to rest on is NaN (null in JSON).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReportSummary {
    pub tree_count: usize,
    pub n_with_dbh: usize,
    pub n_with_height: usize,
    /// Diameters that came from the RANSAC stem fit.
    pub n_refined_dbh: usize,
    pub mean_dbh: f64,
    pub mean_height: f64,
    pub mean_basal_area: f64,
    pub mean_crown_area: f64,
    pub sd: Moments,
    pub median: Moments,
    pub lorey_mean_height: f64,
    pub dominant_height: f64,
    pub top_n_count: usize,
    pub basal_area_total_m2: f64,
    pub basal_area_per_ha: f64,
    pub stems_per_ha: f64,
    pub total_stem_volume_m3: Option<f64>,
    pub stem_volume_ci95: Option<f64>,
    pub total_branch_volume_m3: Option<f64>,
    pub mean_confidence: Option<f64>,
    pub biomass_kg: Option<f64>,
    pub carbon_kg: Option<f64>,
    pub co2e_kg: Option<f64>,
}

fn mean(values: &[f64]) -> f64 {
    let (mut sum, mut n) = (0.0, 0usize);
    for v in values.iter().filter(|v| v.is_finite()) {
        sum += v;
        n += 1;
    }
    if n == 0 { f64::NAN } else { sum / n as f64 }
}

/// Sample standard deviation (n − 1); NaN below two measurable values.
fn std_dev(values: &[f64]) -> f64 {
    let finite: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if finite.len() < 2 {
        return f64::NAN;
    }
    let m = mean(&finite);
    let acc: f64 = finite.iter().map(|v| (v - m) * (v - m)).sum();
    (acc / (finite.len() - 1) as f64).sqrt()
}

fn basal_area(dbh: f64) -> f64 {
    std::f64::consts::PI * (dbh * 0.5) * (dbh * 0.5)
}

/// The smallest area the per-hectare division uses.
const HA_FLOOR: f64 = 0.0001;

pub fn summarise(inp: &ReportInputs) -> ReportSummary {
    let rows: Vec<TreeMetric> = inp.metrics.iter().map(|m| m.metric.clone()).collect();
    let ts = tree_stats(&rows);
    let with_dbh: Vec<&TreeMetric> = rows.iter().filter(|t| t.dbh.is_finite() && t.dbh > 0.0).collect();
    let dbhs: Vec<f64> = with_dbh.iter().map(|t| t.dbh).collect();
    let heights: Vec<f64> = rows.iter().filter(|t| t.height.is_finite() && t.height > 0.0).map(|t| t.height).collect();
    let bas: Vec<f64> = dbhs.iter().map(|d| basal_area(*d)).collect();
    let crowns: Vec<f64> = rows.iter().map(|t| t.crown_area).filter(|c| c.is_finite()).collect();

    let (mut total_vol, mut vol_ci, mut total_branch, mut mean_conf) = (None, None, None, None);
    if let Some(q) = inp.qsm {
        total_vol = Some(q.trees.iter().map(|t| if t.stem_volume.is_finite() { t.stem_volume } else { 0.0 }).sum());
        let sum_var: f64 = q.trees.iter().map(|t| if t.stem_volume_ci95.is_finite() { t.stem_volume_ci95 * t.stem_volume_ci95 } else { 0.0 }).sum();
        vol_ci = Some(sum_var.sqrt());
        total_branch = Some(q.trees.iter().map(|t| if t.branch_volume.is_finite() { t.branch_volume } else { 0.0 }).sum());
        let confs: Vec<f64> = q.trees.iter().map(|t| t.confidence).filter(|c| c.is_finite()).collect();
        mean_conf = if confs.is_empty() { None } else { Some(confs.iter().sum::<f64>() / confs.len() as f64) };
    }

    let ha = inp.plot_area_ha.max(HA_FLOOR);
    ReportSummary {
        tree_count: ts.tree_count,
        n_with_dbh: ts.n_with_dbh,
        n_with_height: ts.n_with_height,
        n_refined_dbh: inp.metrics.iter().filter(|m| m.dbh_source == DbhSource::StemFit).count(),
        mean_dbh: mean(&dbhs),
        mean_height: mean(&heights),
        mean_basal_area: mean(&bas),
        mean_crown_area: if crowns.is_empty() { f64::NAN } else { mean(&crowns) },
        sd: Moments { dbh: std_dev(&dbhs), height: std_dev(&heights) },
        median: Moments { dbh: median(&dbhs), height: median(&heights) },
        lorey_mean_height: ts.lorey_mean_height,
        dominant_height: ts.dominant_height,
        top_n_count: ts.top_n_count,
        basal_area_total_m2: ts.basal_area_total,
        basal_area_per_ha: ts.basal_area_total / ha,
        stems_per_ha: ts.tree_count as f64 / ha,
        total_stem_volume_m3: total_vol,
        stem_volume_ci95: vol_ci,
        total_branch_volume_m3: total_branch,
        mean_confidence: mean_conf,
        biomass_kg: inp.biomass.map(|b| b.biomass_kg),
        carbon_kg: inp.biomass.map(|b| b.carbon_kg),
        co2e_kg: inp.biomass.map(|b| b.co2e_kg),
    }
}

// --- SVG chart helpers ----------------------------------------------------------

pub fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

/// JavaScript's `toFixed`.
fn fixed(v: f64, digits: usize) -> String {
    super::csvtext::to_fixed(v, digits)
}

/// `fixed`, with an em dash for a value that was not measured: the
/// renderer prints these three lines raw, so an empty plot said "NaN
/// cm" there; the rule that no figure is NaN holds everywhere here.
fn dash(v: f64, digits: usize) -> String {
    if v.is_finite() { fixed(v, digits) } else { "—".to_string() }
}

/// JavaScript's number-to-string for the values that reach the page:
/// an integral value prints without a fraction.
fn js_num(v: f64) -> String {
    format!("{v}")
}

fn nice_bins(min: f64, max: f64, target: f64) -> (f64, f64, usize, f64) {
    if !min.is_finite() || !max.is_finite() || max <= min {
        return (0.0, 1.0, 1, 1.0);
    }
    let rough = (max - min) / target;
    let pow = 10f64.powf(rough.log10().floor());
    let norm = rough / pow;
    let step = if norm < 1.5 { pow } else if norm < 3.0 { 2.0 * pow } else if norm < 7.0 { 5.0 * pow } else { 10.0 * pow };
    let lo = (min / step).floor() * step;
    let hi = (max / step).ceil() * step;
    (lo, hi, ((hi - lo) / step).round() as usize, step)
}

fn format_tick(v: f64) -> String {
    if v.abs() >= 100.0 { fixed(v, 0) } else if v.abs() >= 10.0 { fixed(v, 1) } else { fixed(v, 2) }
}

const MONO: &str = "ui-monospace,monospace";

fn histogram_svg(values: &[f64], x_label: &str, x_unit: &str) -> String {
    let (w, h) = (520.0, 200.0);
    let (pad_l, pad_r, pad_t, pad_b) = (36.0, 8.0, 8.0, 28.0);
    let (inner_w, inner_h) = (w - pad_l - pad_r, h - pad_t - pad_b);
    let xs: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if xs.is_empty() {
        return format!(r##"<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg"><text x="{}" y="{}" text-anchor="middle" font-family="{MONO}" font-size="12" fill="#888">no data</text></svg>"##, w / 2.0, h / 2.0);
    }
    let min = xs.iter().copied().fold(f64::INFINITY, f64::min);
    let max = xs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let (lo, hi, nbins, step) = nice_bins(min, max, 16.0);
    let mut bins = vec![0usize; nbins];
    for v in &xs {
        let idx = (((v - lo) / step).floor().max(0.0) as usize).min(nbins - 1);
        bins[idx] += 1;
    }
    let ymax = bins.iter().copied().max().unwrap_or(1).max(1) as f64;
    let x_px = |b: f64| pad_l + (b / nbins as f64) * inner_w;
    let y_px = |c: f64| pad_t + inner_h - (c / ymax) * inner_h;
    let bars: String = bins
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(r##"<rect x="{}" y="{}" width="{}" height="{}" fill="#67d391" />"##, x_px(i as f64) + 0.5, y_px(*c as f64), (inner_w / nbins as f64) - 1.0, pad_t + inner_h - y_px(*c as f64))
        })
        .collect();
    let mn = mean(&xs);
    let md = median(&xs);
    let mn_px = pad_l + ((mn - lo) / (hi - lo)) * inner_w;
    let md_px = pad_l + ((md - lo) / (hi - lo)) * inner_w;
    let ticks: String = (0..=nbins)
        .map(|i| {
            let x = pad_l + (i as f64 / nbins as f64) * inner_w;
            format!(r##"<text x="{x}" y="{}" text-anchor="middle" font-family="{MONO}" font-size="9" fill="#888">{}</text>"##, h - 8.0, format_tick(lo + i as f64 * step))
        })
        .collect();
    format!(
        r##"<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg">
  <rect x="{pad_l}" y="{pad_t}" width="{inner_w}" height="{inner_h}" fill="#1c1c20" stroke="#333" />
  {bars}
  <line x1="{mn_px}" y1="{pad_t}" x2="{mn_px}" y2="{}" stroke="#e6c068" stroke-dasharray="3,3" />
  <line x1="{md_px}" y1="{pad_t}" x2="{md_px}" y2="{}" stroke="#6fa8dc" stroke-dasharray="3,3" />
  <text x="{}" y="{}" font-family="{MONO}" font-size="9" fill="#e6c068">mean {}</text>
  <text x="{}" y="{}" font-family="{MONO}" font-size="9" fill="#6fa8dc">median {}</text>
  {ticks}
  <text x="{}" y="{}" text-anchor="middle" font-family="{MONO}" font-size="9.5" fill="#aaa">{} ({})</text>
</svg>"##,
        pad_t + inner_h,
        pad_t + inner_h,
        mn_px + 4.0,
        pad_t + 10.0,
        fixed(mn, 1),
        md_px + 4.0,
        pad_t + 22.0,
        fixed(md, 1),
        pad_l + inner_w / 2.0,
        h - 2.0,
        escape_xml(x_label),
        escape_xml(x_unit),
    )
}

fn scatter_svg(points: &[(f64, f64)], x_label: &str, y_label: &str) -> String {
    let (w, h) = (480.0, 280.0);
    let (pad_l, pad_r, pad_t, pad_b) = (40.0, 8.0, 8.0, 28.0);
    let (inner_w, inner_h) = (w - pad_l - pad_r, h - pad_t - pad_b);
    let valid: Vec<(f64, f64)> = points.iter().copied().filter(|(x, y)| x.is_finite() && y.is_finite()).collect();
    if valid.is_empty() {
        return format!(r##"<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg"><text x="{}" y="{}" text-anchor="middle" font-family="{MONO}" font-size="12" fill="#888">no data</text></svg>"##, w / 2.0, h / 2.0);
    }
    let xmin = valid.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let xmax = valid.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let ymin = valid.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let ymax = valid.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);
    let xspan = if xmax - xmin == 0.0 { 1.0 } else { xmax - xmin };
    let yspan = if ymax - ymin == 0.0 { 1.0 } else { ymax - ymin };
    let dots: String = valid
        .iter()
        .map(|(x, y)| {
            let px = pad_l + ((x - xmin) / xspan) * inner_w;
            let py = pad_t + inner_h - ((y - ymin) / yspan) * inner_h;
            format!(r##"<circle cx="{}" cy="{}" r="2.2" fill="#6fa8dc" fill-opacity="0.7" />"##, fixed(px, 1), fixed(py, 1))
        })
        .collect();
    format!(
        r##"<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg">
  <rect x="{pad_l}" y="{pad_t}" width="{inner_w}" height="{inner_h}" fill="#1c1c20" stroke="#333" />
  {dots}
  <text x="{}" y="{}" text-anchor="middle" font-family="{MONO}" font-size="9.5" fill="#aaa">{}</text>
  <text x="12" y="{}" text-anchor="middle" transform="rotate(-90 12 {})" font-family="{MONO}" font-size="9.5" fill="#aaa">{}</text>
  <text x="{}" y="{}" font-family="{MONO}" font-size="9" fill="#666">{}</text>
  <text x="{}" y="{}" font-family="{MONO}" font-size="9" fill="#666">{}</text>
  <text x="{}" y="{}" font-family="{MONO}" font-size="9" fill="#666">{}</text>
</svg>"##,
        pad_l + inner_w / 2.0,
        h - 6.0,
        escape_xml(x_label),
        pad_t + inner_h / 2.0,
        pad_t + inner_h / 2.0,
        escape_xml(y_label),
        pad_l + 4.0,
        pad_t + inner_h - 4.0,
        fixed(xmin, 2),
        pad_l + inner_w - 30.0,
        pad_t + inner_h - 4.0,
        fixed(xmax, 2),
        pad_l + 4.0,
        pad_t + 12.0,
        fixed(ymax, 2),
    )
}

fn plot_map_svg(trees: &[TreeMetric]) -> String {
    let (w, h) = (520.0, 480.0);
    let pad = 24.0;
    let valid: Vec<&TreeMetric> = trees.iter().filter(|t| t.x.is_finite() && t.y.is_finite()).collect();
    if valid.is_empty() {
        return format!(r##"<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg"><text x="{}" y="{}" text-anchor="middle" font-family="{MONO}" font-size="12" fill="#888">no positioned trees</text></svg>"##, w / 2.0, h / 2.0);
    }
    let xmin = valid.iter().map(|t| t.x).fold(f64::INFINITY, f64::min);
    let xmax = valid.iter().map(|t| t.x).fold(f64::NEG_INFINITY, f64::max);
    let ymin = valid.iter().map(|t| t.y).fold(f64::INFINITY, f64::min);
    let ymax = valid.iter().map(|t| t.y).fold(f64::NEG_INFINITY, f64::max);
    let xspan = if xmax - xmin == 0.0 { 1.0 } else { xmax - xmin };
    let yspan = if ymax - ymin == 0.0 { 1.0 } else { ymax - ymin };
    let s = ((w - 2.0 * pad) / xspan).min((h - 2.0 * pad) / yspan);
    let ox = pad + (w - 2.0 * pad - xspan * s) * 0.5;
    let oy = pad + (h - 2.0 * pad - yspan * s) * 0.5;
    let finite_dbh: Vec<f64> = valid.iter().map(|t| t.dbh).filter(|d| d.is_finite()).collect();
    let m_min = finite_dbh.iter().copied().fold(f64::INFINITY, f64::min);
    let m_max = finite_dbh.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let m_span = if m_max - m_min == 0.0 || !(m_max - m_min).is_finite() { 1.0 } else { m_max - m_min };
    let color_at = |v: f64| -> String {
        let t = ((v - m_min) / m_span).clamp(0.0, 1.0);
        let t = if t.is_finite() { t } else { 0.0 };
        let stops: [[f64; 3]; 5] = [[40.0, 70.0, 50.0], [90.0, 150.0, 60.0], [210.0, 200.0, 70.0], [220.0, 120.0, 40.0], [200.0, 50.0, 40.0]];
        let f = t * (stops.len() - 1) as f64;
        let i = (f.floor() as usize).min(stops.len() - 2);
        let k = f - i as f64;
        let (a, b) = (stops[i], stops[i + 1]);
        format!("rgb({},{},{})", (a[0] + (b[0] - a[0]) * k) as i64, (a[1] + (b[1] - a[1]) * k) as i64, (a[2] + (b[2] - a[2]) * k) as i64)
    };
    let dots: String = valid
        .iter()
        .map(|t| {
            let px = ox + (t.x - xmin) * s;
            let py = h - (oy + (t.y - ymin) * s);
            let r = (2.0 + if t.dbh.is_finite() { t.dbh * 12.0 } else { 0.0 }).clamp(2.0, 7.0);
            format!(r##"<circle cx="{}" cy="{}" r="{}" fill="{}" stroke="#000" stroke-opacity="0.3" stroke-width="0.6" />"##, fixed(px, 1), fixed(py, 1), fixed(r, 1), color_at(t.dbh))
        })
        .collect();
    format!(
        r##"<svg width="{w}" height="{h}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="{w}" height="{h}" fill="#1c1c20" />
  <rect x="{}" y="{}" width="{}" height="{}" fill="#161618" stroke="#333" />
  {dots}
  <text x="{}" y="{}" font-family="{MONO}" font-size="10" fill="#aaa">N ↑</text>
  <text x="{}" y="{}" font-family="{MONO}" font-size="9.5" fill="#888">colour = DBH · size = DBH · n = {}</text>
</svg>"##,
        pad - 0.5,
        pad - 0.5,
        w - 2.0 * pad + 1.0,
        h - 2.0 * pad + 1.0,
        w - 28.0,
        pad + 14.0,
        pad + 4.0,
        h - 8.0,
        valid.len(),
    )
}

// --- HTML composition -----------------------------------------------------------

const INLINE_CSS: &str = r##"
:root { --bg:#fafaf8; --fg:#222; --dim:#666; --mute:#999; --line:#ddd; --accent:#3a7e57; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.5; font-size: 14px; }
.report { max-width: 880px; margin: 0 auto; padding: 32px; }
h1 { font-size: 28px; margin: 0 0 4px 0; letter-spacing: -0.01em; }
h2 { font-size: 18px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); color: var(--accent); }
h3 { font-size: 14px; margin: 16px 0 6px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
.cover { padding: 36px 0 24px; border-bottom: 2px solid var(--accent); margin-bottom: 8px; }
.cover .sub { color: var(--dim); font-size: 13px; }
.headline { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 18px 0; }
.head-card { border: 1px solid var(--line); padding: 12px; border-radius: 6px; background: #fff; }
.head-card .label { font-size: 11px; color: var(--mute); text-transform: uppercase; letter-spacing: 0.05em; }
.head-card .value { font-size: 20px; margin-top: 4px; color: var(--fg); }
.head-card .unit { font-size: 11px; color: var(--dim); margin-left: 4px; }
.head-card .ci { font-size: 10px; color: var(--mute); margin-top: 2px; }
table.tree-table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 11px; }
table.tree-table th { text-align: right; padding: 4px 6px; border-bottom: 2px solid var(--line); color: var(--dim); font-weight: 600; font-size: 10.5px; }
table.tree-table td { text-align: right; padding: 3px 6px; border-bottom: 1px solid var(--line); }
table.tree-table th:first-child, table.tree-table td:first-child { text-align: left; }
.svg-wrap { background: #1c1c20; border-radius: 6px; padding: 8px; margin: 8px 0; display: inline-block; max-width: 100%; }
.kvs { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-family: ui-monospace, monospace; font-size: 12px; margin: 8px 0; }
.kvs .k { color: var(--dim); }
.kvs .v { color: var(--fg); }
.method { background: #fff; border: 1px solid var(--line); border-radius: 6px; padding: 14px; font-size: 12px; color: var(--dim); margin-top: 16px; }
.method b { color: var(--fg); font-weight: 600; }
footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid var(--line); color: var(--mute); font-size: 11px; }
.charts-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
.biomass-fallback { color: #b45309; font-weight: 600; }
@media print {
  body { background: white; font-size: 11pt; }
  .report { max-width: none; padding: 0; }
  h2 { page-break-after: avoid; }
  table.tree-table { page-break-inside: auto; font-size: 9pt; }
  table.tree-table tr { page-break-inside: avoid; }
  .svg-wrap { background: transparent; padding: 0; }
}
"##;

/// Every number the report prints: a non-finite value is an em dash,
/// never "NaN".
fn fmt_n(v: f64, digits: usize, unit: &str) -> String {
    if !v.is_finite() {
        return "—".to_string();
    }
    let s = if unit == "cm" && v.abs() < 1.0 { fixed(v * 100.0, digits) } else { fixed(v, digits) };
    if unit.is_empty() { s } else { format!(r##"{s} <span class="unit">{}</span>"##, escape_xml(unit)) }
}

fn head_card(label: &str, value: &str, ci: Option<&str>) -> String {
    format!(
        r##"<div class="head-card">
    <div class="label">{}</div>
    <div class="value">{value}</div>
    {}
  </div>"##,
        escape_xml(label),
        ci.map(|c| format!(r##"<div class="ci">{c}</div>"##)).unwrap_or_default()
    )
}

fn kv_section(rows: &[(String, String)]) -> String {
    let inner: String = rows.iter().map(|(k, v)| format!(r##"<div class="k">{}</div><div class="v">{v}</div>"##, escape_xml(k))).collect();
    format!(r##"<div class="kvs">{inner}</div>"##)
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// YYYY-MM-DD for a Unix timestamp.
pub fn iso_date(unix_seconds: i64) -> String {
    let (y, m, d) = civil_from_days(unix_seconds.div_euclid(86_400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Today's date in UTC. There is no timezone database in the headless
/// binary, so the renderer's local-calendar date is not available
/// here; the operation takes a `date` parameter for a pipeline that
/// knows its own.
pub fn today_utc() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    iso_date(secs)
}

pub fn generate_report_html(inp: &ReportInputs) -> String {
    let s = summarise(inp);
    let today = inp.date;
    let rows: Vec<&TreeMetric> = inp.metrics.iter().map(|m| &m.metric).collect();
    let valid: Vec<&TreeMetric> = rows.iter().copied().filter(|t| t.dbh.is_finite() && t.dbh > 0.0).collect();
    let dbhs_cm: Vec<f64> = valid.iter().map(|t| t.dbh * 100.0).collect();
    let heights: Vec<f64> = valid.iter().map(|t| t.height).collect();
    let ha = inp.plot_area_ha.max(HA_FLOOR);

    let headline = [
        head_card("Stems / ha", &fmt_n(s.stems_per_ha, 0, ""), None),
        head_card("Mean DBH", &format!(r##"{} <span class="unit">cm</span>"##, fmt_n(s.mean_dbh * 100.0, 1, "")), Some(&format!("± {} cm SD", fmt_n(s.sd.dbh * 100.0, 1, "")))),
        head_card("Lorey's mean H", &format!(r##"{} <span class="unit">m</span>"##, fmt_n(s.lorey_mean_height, 1, "")), Some(&format!("dominant {} m", fmt_n(s.dominant_height, 1, "")))),
        head_card("Basal area", &format!(r##"{} <span class="unit">m²/ha</span>"##, fmt_n(s.basal_area_per_ha, 1, "")), Some(&format!("{} m² total", fmt_n(s.basal_area_total_m2, 2, "")))),
    ]
    .concat();

    let mut volume_block = String::new();
    if let Some(total_vol) = s.total_stem_volume_m3 {
        let stem_per_ha = total_vol / ha;
        let ci95_per_ha = s.stem_volume_ci95.unwrap_or(0.0) / ha;
        let mut cards = vec![
            head_card("Stem volume", &format!(r##"{} <span class="unit">m³/ha</span>"##, fmt_n(stem_per_ha, 1, "")), Some(&format!("± {} m³/ha · 95 % CI", fmt_n(ci95_per_ha, 2, "")))),
            head_card(
                "Mean QSM confidence",
                &s.mean_confidence.map(|c| format!(r##"{} <span class="unit">%</span>"##, fmt_n(c * 100.0, 0, ""))).unwrap_or_else(|| "—".to_string()),
                Some("angular coverage"),
            ),
        ];
        let mut biomass_note = String::new();
        if let (Some(biomass_kg), Some(b)) = (s.biomass_kg, inp.biomass) {
            let ton_per_ha = (biomass_kg / 1000.0) / ha;
            let biomass_ci_per_ha = (b.biomass_kg_ci95 / 1000.0) / ha;
            let co2 = (s.co2e_kg.unwrap_or(f64::NAN) / 1000.0) / ha;
            let co2_ci_per_ha = (b.co2e_kg_ci95 / 1000.0) / ha;
            cards.push(head_card("Above-stump biomass", &format!(r##"{} <span class="unit">t/ha</span>"##, fmt_n(ton_per_ha, 1, "")), Some(&format!("± {} t/ha · 95 % CI", fmt_n(biomass_ci_per_ha, 2, "")))));
            cards.push(head_card("CO₂-equivalent", &format!(r##"{} <span class="unit">t/ha</span>"##, fmt_n(co2, 1, "")), Some(&format!("± {} t/ha · 95 % CI", fmt_n(co2_ci_per_ha, 2, "")))));
            let mix_text = if b.species_mix.is_empty() {
                "none assigned".to_string()
            } else {
                b.species_mix.iter().map(|(label, n)| format!("{} ({n})", escape_xml(label))).collect::<Vec<_>>().join(", ")
            };
            let rho_text = match b.fallback_density {
                Some(rho) if rho.is_finite() => format!(" at {} kg/m³", fmt_n(rho, 0, "")),
                _ => String::new(),
            };
            let fallback = if b.fallback_count > 0 {
                format!(
                    r##" <span class="biomass-fallback">{} tree{} had no species assignment and used the {} fallback density{rho_text} — assign species in Tree Review for a fully species-aware figure.</span>"##,
                    b.fallback_count,
                    if b.fallback_count == 1 { "" } else { "s" },
                    escape_xml(&b.fallback_label)
                )
            } else {
                " Every tree carried its own species assignment.".to_string()
            };
            biomass_note = format!(r##"<p class="sub" style="color:var(--dim);font-size:12px;">Species mix: {mix_text}.{fallback}</p>"##);
        }
        let qsm_note = inp
            .qsm
            .map(|q| format!(r##"<p class="sub" style="color:var(--dim);font-size:12px;">From the cached TreeQSM (Raumonen 2013, {} trees fitted). Per-tree stem volume CIs sum in quadrature for the plot total.</p>"##, q.trees.len()))
            .unwrap_or_default();
        volume_block = format!(
            r##"
<h2>Volume · biomass · carbon</h2>
<div class="headline">{}</div>
{qsm_note}
{biomass_note}
"##,
            cards.concat()
        );
    }

    let mut revenue_block = String::new();
    if let (Some(total_vol), Some(bk)) = (s.total_stem_volume_m3, inp.bucking) {
        let total = total_vol + s.total_branch_volume_m3.unwrap_or(0.0);
        let rev_per_ha = (total * bk.unit_price) / ha;
        let cur = escape_xml(&bk.currency);
        revenue_block = format!(
            r##"<div class="headline"><div class="head-card">
      <div class="label">Revenue estimate</div>
      <div class="value">{} <span class="unit">{cur}/ha</span></div>
      <div class="ci">uniform-grade {} {cur}/m³ × {} m³ total · use the Bucking panel for sawlog / pulp / energy breakdown</div>
    </div></div>"##,
            fmt_n(rev_per_ha, 0, ""),
            js_num(bk.unit_price),
            fmt_n(total, 1, "")
        );
    }

    let mut validation_block = String::new();
    if let Some(v) = inp.field_validation {
        validation_block = format!(
            r##"
<h2>Field-data validation</h2>
<div class="headline">
  {}
  {}
  {}
  {}
</div>
"##,
            head_card("Matched stems", &fmt_n(v.n_matched as f64, 0, ""), None),
            head_card("DBH bias", &format!(r##"{}{} <span class="unit">cm</span>"##, if v.bias_cm >= 0.0 { "+" } else { "" }, fmt_n(v.bias_cm, 2, "")), Some("PointCloudLabeler − caliper, positive = overestimates")),
            head_card("DBH RMSE", &format!(r##"{} <span class="unit">cm</span>"##, fmt_n(v.rmse_cm, 2, "")), None),
            head_card("R²", &fmt_n(v.r2, 3, ""), None),
        );
    }

    let mut growth_block = String::new();
    if let Some(g) = inp.growth {
        growth_block = format!(
            r##"
<h2>Tree growth — {}-year interval</h2>
<div class="headline">
  {}
  {}
  {}
  {}
</div>
"##,
            fmt_n(g.years, 1, ""),
            head_card("Matched stems", &fmt_n(g.n_matched as f64, 0, ""), None),
            head_card("Mean DBH growth", &format!(r##"{} <span class="unit">cm/yr</span>"##, fmt_n(g.mean_dbh_growth_cm_per_year, 2, "")), None),
            head_card("Mean height growth", &format!(r##"{} <span class="unit">m/yr</span>"##, fmt_n(g.mean_height_growth_m_per_year, 2, "")), None),
            head_card("Volume change", &format!(r##"{}{} <span class="unit">m³</span>"##, if g.volume_change_m3 >= 0.0 { "+" } else { "" }, fmt_n(g.volume_change_m3, 2, "")), Some(&format!("{} harvested / fallen · {} ingrowth", g.harvested, g.ingrowth))),
        );
    }

    let mut m3c2_block = String::new();
    if let Some(c) = inp.m3c2 {
        let signed = |v: f64, digits: usize| format!("{}{}", if v >= 0.0 { "+" } else { "" }, fmt_n(v, digits, ""));
        m3c2_block = format!(
            r##"
<h2>M3C2 surface change — vs. {}</h2>
<div class="headline">
  {}
  {}
  {}
  {}
</div>
<p class="sub" style="color:var(--dim);font-size:12px;">Positive = the active cloud sits above the reference epoch (upward growth); negative = loss.</p>
"##,
            escape_xml(&c.reference_name),
            head_card("Core points", &fmt_n(c.core_points as f64, 0, ""), None),
            head_card("Significant change", &format!(r##"{} <span class="unit">%</span>"##, fmt_n(c.significant_pct, 1, "")), None),
            head_card("Mean change", &format!(r##"{} <span class="unit">cm</span>"##, signed(c.mean_change_cm, 1)), None),
            head_card("Median change", &format!(r##"{} <span class="unit">cm</span>"##, signed(c.median_change_cm, 1)), None),
        );
    }

    let mut density_block = String::new();
    if let Some(d) = inp.density {
        density_block = format!(
            "\n<h2>Point-cloud density metrics</h2>\n{}\n",
            kv_section(&[
                ("Cell size".into(), format!("{} m · {}×{} grid", fixed(d.cell_size, 2), d.cols, d.rows)),
                ("Min height filter".into(), format!("{} m above ground", fixed(d.min_height, 2))),
                ("Returns".into(), format!("{} M · {} pts/m²", fixed(d.plot_count as f64 / 1e6, 2), fixed(d.plot_density, 1))),
                ("Mean ± SD".into(), format!("{} ± {} m", fixed(d.plot_mean, 2), fixed(d.plot_sd, 2))),
                ("Median (P50)".into(), format!("{} m", fixed(d.plot_p50, 2))),
                ("P25 → P95".into(), format!("{} → {} m", fixed(d.plot_p25, 2), fixed(d.plot_p95, 2))),
                ("P75 / P90".into(), format!("{} / {} m", fixed(d.plot_p75, 2), fixed(d.plot_p90, 2))),
                (format!("Canopy cover ≥ {} m", fixed(d.canopy_threshold, 1)), format!("{} %", fixed(d.plot_canopy_cover * 100.0, 1))),
                ("Skewness · kurtosis".into(), format!("{} · {}", fixed(d.plot_skew, 2), fixed(d.plot_kurt, 2))),
            ])
        );
    }

    let show_qsm = inp.qsm.is_some_and(|q| !q.trees.is_empty());
    let table = if show_qsm {
        let q = inp.qsm.unwrap();
        let by_id: HashMap<i32, &TreeQsm> = q.trees.iter().map(|t| (t.tree_id, t)).collect();
        let mut with_q: Vec<(&TreeMetric, &TreeQsm)> = valid.iter().filter_map(|t| by_id.get(&t.tree_id).map(|q| (*t, *q))).collect();
        with_q.sort_by(|a, b| b.1.stem_volume.partial_cmp(&a.1.stem_volume).unwrap_or(std::cmp::Ordering::Equal));
        with_q.truncate(50);
        let body: String = with_q
            .iter()
            .map(|(t, q)| {
                format!(
                    r##"
    <tr>
      <td>#{}</td>
      <td>{}</td>
      <td>{}</td>
      <td>{}</td>
      <td>{}</td>
      <td>{}</td>
    </tr>"##,
                    t.tree_id,
                    fmt_n(t.dbh * 100.0, 1, ""),
                    fmt_n(t.height, 1, ""),
                    fmt_n(q.stem_volume, 3, ""),
                    if q.stem_volume_ci95.is_finite() { format!("±{}", fmt_n(q.stem_volume_ci95, 3, "")) } else { "—".into() },
                    if q.confidence.is_finite() { format!("{} %", fmt_n(q.confidence * 100.0, 0, "")) } else { "—".into() },
                )
            })
            .collect();
        format!(
            r##"
<table class="tree-table">
  <thead><tr>
    <th>Tree</th><th>DBH (cm)</th><th>Height (m)</th><th>Stem vol (m³)</th><th>± 95 % CI</th><th>Conf</th>
  </tr></thead>
  <tbody>{body}</tbody>
</table>"##
        )
    } else {
        let mut sorted = valid.clone();
        sorted.sort_by(|a, b| b.dbh.partial_cmp(&a.dbh).unwrap_or(std::cmp::Ordering::Equal));
        sorted.truncate(50);
        let body: String = sorted
            .iter()
            .map(|t| {
                format!(
                    r##"
    <tr>
      <td>#{}</td>
      <td>{}</td>
      <td>{}</td>
      <td>{}</td>
      <td>{}</td>
    </tr>"##,
                    t.tree_id,
                    fmt_n(t.dbh * 100.0, 1, ""),
                    fmt_n(t.height, 1, ""),
                    fmt_n(basal_area(t.dbh), 3, ""),
                    fmt_n(t.crown_area, 1, ""),
                )
            })
            .collect();
        format!(
            r##"
<table class="tree-table">
  <thead><tr>
    <th>Tree</th><th>DBH (cm)</th><th>Height (m)</th><th>Basal area (m²)</th><th>Crown area (m²)</th>
  </tr></thead>
  <tbody>{body}</tbody>
</table>"##
        )
    };

    let mut refs: Vec<String> = vec![
        "<b>QSM (volume + uncertainty)</b>: Raumonen, P. et al. (2013), <i>Fast Automatic Precision Tree Models from Terrestrial Laser Scanner Data</i>, Remote Sensing 5(2):491–520.".into(),
    ];
    if s.biomass_kg.is_some() {
        refs.push(match inp.biomass.and_then(|b| b.fallback_source.as_deref()) {
            Some(src) => format!("<b>Biomass density</b>: {}. Repola, J. (2006), <i>Models for vertical wood density of Scots pine, Norway spruce and birch stems</i>, Silva Fennica 40(4):673–685; Repola, J. (2008), <i>Biomass equations for birch in Finland</i>, Silva Fennica 42(4):605–624; Kärkkäinen, M. (2007), <i>Puutieteen perusteet</i>; Zanne, A.E. et al. (2009), <i>Global wood density database</i>, Dryad.", escape_xml(src)),
            None => "<b>Biomass density</b>: supplied by the analyst, not taken from a published table. Biomass is (basic density) × (stem + branch volume); carbon is the carbon fraction of that.".into(),
        });
    }
    refs.push("<b>Terrain derivatives</b>: Horn, B.K.P. (1981) slope/aspect and hillshade, Mark, R.K. (1992) multidirectional hillshade, Weiss, A. (2001) TPI, Zevenbergen, L.W. & Thorne, C.R. (1987) curvature.".into());
    if inp.density.is_some() {
        refs.push("<b>Forestry density metrics</b>: Pixel-level statistics matching lidR's <code>pixel_metrics</code> output; type-7 percentile interpolation matches R's default.".into());
    }
    if inp.field_validation.is_some() {
        refs.push("<b>Field validation</b>: Greedy bipartite nearest-neighbour matching within the configured search radius; linear regression for the R² figure.".into());
    }
    if inp.growth.is_some() {
        refs.push("<b>Tree growth</b>: Greedy bipartite nearest-neighbour stem matching between the reference and active epoch by planimetric position; unmatched reference stems are harvested/fallen, unmatched active stems are ingrowth.".into());
    }
    if inp.m3c2.is_some() {
        refs.push("<b>M3C2 (surface change)</b>: Lague, D., Brodu, N. &amp; Leroux, J. (2013), <i>Accurate 3D comparison of complex topography with terrestrial laser scanner: application to the Rangitikei canyon (N-Z)</i>, ISPRS Journal of Photogrammetry and Remote Sensing 82:10–26.".into());
    }
    let refs_html: String = refs.iter().map(|r| format!(r##"<li style="margin-bottom: 6px;">{r}</li>"##)).collect();

    let trees_line = if s.n_with_dbh < s.tree_count || s.n_with_height < s.tree_count {
        format!("{} ({} with a diameter, {} with a height)", s.tree_count, s.n_with_dbh, s.n_with_height)
    } else {
        format!("{}", s.tree_count)
    };
    let median_dbh_line = format!(
        "{} cm{}",
        dash(s.median.dbh * 100.0, 1),
        if s.n_refined_dbh > 0 {
            format!(" — {} of {} diameter{} from the RANSAC stem fit, the rest algebraic", s.n_refined_dbh, s.n_with_dbh, if s.n_with_dbh == 1 { "" } else { "s" })
        } else {
            String::new()
        }
    );
    let glance = kv_section(&[
        ("Plot area".into(), format!("{} ha ({} m²) — {}", fixed(inp.plot_area_ha, 3), fixed(inp.plot_area_ha * 10_000.0, 0), inp.plot_area_basis.label())),
        ("Trees".into(), trees_line),
        ("Median DBH".into(), median_dbh_line),
        ("Mean height".into(), format!("{} m (median {})", dash(s.mean_height, 1), dash(s.median.height, 1))),
        ("Mean crown area".into(), if s.mean_crown_area.is_finite() { format!("{} m²", fixed(s.mean_crown_area, 1)) } else { "—".into() }),
    ]);

    let scatter: Vec<(f64, f64)> = valid.iter().map(|t| (t.dbh * 100.0, t.height)).collect();
    let project = escape_xml(inp.project_name);
    let crs = inp.crs_label.map(|c| format!(" · {}", escape_xml(c))).unwrap_or_default();
    let description = inp.description.map(|d| format!(r##"<p style="margin-top:12px;color:var(--dim);">{}</p>"##, escape_xml(d))).unwrap_or_default();
    let rows_owned: Vec<TreeMetric> = rows.iter().map(|t| (*t).clone()).collect();

    format!(
        r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{project} — {PRODUCT_NAME} forestry report</title>
  <meta name="generator" content="{PRODUCT_NAME}">
  <style>{INLINE_CSS}</style>
</head>
<body>
<div class="report">
  <div class="cover">
    <h1>{project}</h1>
    <div class="sub">{PRODUCT_NAME} forestry inventory report · {today}{crs}</div>
    {description}
  </div>

  <h2>Plot at a glance</h2>
  <div class="headline">{headline}</div>
  {glance}

  {volume_block}
  {revenue_block}

  {validation_block}

  {growth_block}

  {m3c2_block}

  {density_block}

  <h2>Distributions</h2>
  <div class="charts-row">
    <div>
      <h3>DBH distribution (cm)</h3>
      <div class="svg-wrap">{}</div>
    </div>
    <div>
      <h3>Height distribution (m)</h3>
      <div class="svg-wrap">{}</div>
    </div>
    <div>
      <h3>DBH × Height (allometry)</h3>
      <div class="svg-wrap">{}</div>
    </div>
  </div>

  <h2>Plot map</h2>
  <div class="svg-wrap">{}</div>

  <h2>Per-tree (top 50 by {})</h2>
  {table}

  <h2>Methodology</h2>
  <div class="method">
    <p style="margin-top:0;">All figures in this report were derived from a single point-cloud dataset using {PRODUCT_NAME}'s in-tree analytics (no external R / Python step). The references below cover the algorithms behind the headline numbers.</p>
    <ul style="margin: 8px 0; padding-left: 18px;">
      {refs_html}
    </ul>
    <p>Generated by {PRODUCT_NAME} {APP_VERSION}. Cite the version: the
    methods above are implemented from their published descriptions and
    what this program measures differs between releases.</p>
  </div>

  <footer>{project} · {PRODUCT_NAME} · {today}<br>
  Generated by {PRODUCT_NAME} — © 2026 Eppu Honkanen, GPL-3.0-or-later. Measurements carry the uncertainty stated beside them.</footer>
</div>
</body>
</html>"##,
        histogram_svg(&dbhs_cm, "DBH", "cm"),
        histogram_svg(&heights, "Height", "m"),
        scatter_svg(&scatter, "DBH (cm)", "Height (m)"),
        plot_map_svg(&rows_owned),
        if show_qsm { "stem volume" } else { "DBH" },
    )
}

// --- the operation ------------------------------------------------------------

fn f_0_25() -> f64 { 0.25 }
fn f_0_5() -> f64 { 0.5 }
fn f_1_2() -> f64 { 1.2 }
fn f_1_4() -> f64 { 1.4 }
fn f_35() -> f64 { 35.0 }
fn f_2() -> f64 { 2.0 }
fn f_5() -> f64 { 5.0 }
fn f_1_5() -> f64 { 1.5 }
fn f_1() -> f64 { 1.0 }
fn f_3() -> f64 { 3.0 }
fn f_0_1() -> f64 { 0.1 }
fn yes() -> bool { true }
fn pine_key() -> String { "pine".into() }
fn euro() -> String { DEFAULT_CURRENCY.into() }
fn f_400() -> f64 { DEFAULT_BIOMASS_PARAMS.density }
fn f_25() -> f64 { DEFAULT_BIOMASS_PARAMS.density_std }
fn f_0_02() -> f64 { DEFAULT_BIOMASS_PARAMS.carbon_fraction_std }

/// The Report panel's inputs.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Where to write the self-contained .html file.
    pub out_path: String,
    /// Plot name on the cover (default: the dataset's name).
    #[serde(default)]
    pub project_name: Option<String>,
    /// One or two short lines under the title.
    #[serde(default)]
    pub description: Option<String>,
    /// Plot area in hectares; null takes the recorded plot boundary's area, or the stems' bounding box when there is none.
    #[serde(default)]
    pub plot_area_ha: Option<f64>,
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
    /// Replace the algebraic DBH with the RANSAC stem fit from stems.json where one exists (default true).
    #[serde(default = "yes")]
    pub merge_stems: bool,
    /// Uniform-grade price per m³ for the revenue line (default 35).
    #[serde(default = "f_35")]
    pub unit_price: f64,
    /// Currency symbol or code the price and revenue are in (default "€").
    #[serde(default = "euro")]
    pub currency: String,
    /// Density preset for trees with no entry in species.json: "pine", "spruce", "birch", "aspen", "oak", or "custom" to use the density given here (default "pine").
    #[serde(default = "pine_key")]
    pub fallback_species: String,
    /// Wood basic density for the custom fallback, kg/m³ (default 400; a preset overrides it).
    #[serde(default = "f_400")]
    pub density: f64,
    /// 1σ density uncertainty for the custom fallback, kg/m³ (default 25).
    #[serde(default = "f_25")]
    pub density_std: f64,
    /// Carbon fraction for the custom fallback (default 0.50).
    #[serde(default = "f_0_5")]
    pub carbon_fraction: f64,
    /// 1σ carbon-fraction uncertainty, every tree (default 0.02).
    #[serde(default = "f_0_02")]
    pub carbon_fraction_std: f64,
    /// Relative 1σ uncertainty on branch volume, every tree (default 0.25).
    #[serde(default = "f_0_25")]
    pub branch_unc_fraction: f64,
    /// Also compute the point-cloud density metrics for the report (the panel's 2 m cells, 0.2 m floor, 2 m canopy); writes the dataset's density/ folder as metrics.density does (default false).
    #[serde(default)]
    pub with_density: bool,
    /// The date on the cover, YYYY-MM-DD (default: today, UTC).
    #[serde(default)]
    pub date: Option<String>,
    /// A field crew's CSV to validate against (see qc.validate); adds the field-data validation block.
    #[serde(default)]
    pub field_csv: Option<String>,
    /// Match radius for the field validation, metres (default 2.0).
    #[serde(default = "f_2")]
    pub validation_radius: f64,
    /// An earlier epoch of the same plot (see change.growth); adds the tree-growth block.
    #[serde(default)]
    pub reference_dir: Option<String>,
    /// Years between the reference epoch and this one (default 5).
    #[serde(default = "f_5")]
    pub years: f64,
    /// Match radius on the stem base for the growth pairing, metres (default 1.5).
    #[serde(default = "f_1_5")]
    pub growth_radius: f64,
    /// Form factor for the growth volume estimate (default 0.50).
    #[serde(default = "f_0_5")]
    pub form_factor: f64,
    /// A reference acquisition to run M3C2 against (see change.m3c2); adds the surface-change block.
    #[serde(default)]
    pub m3c2_reference_dir: Option<String>,
    /// M3C2 core point spacing, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub m3c2_core_spacing: f64,
    /// M3C2 normal estimation scale, metres (default 1.0).
    #[serde(default = "f_1")]
    pub m3c2_normal_scale: f64,
    /// M3C2 projection cylinder diameter, metres (default 0.5).
    #[serde(default = "f_0_5")]
    pub m3c2_projection_scale: f64,
    /// M3C2 cylinder half-depth, metres (default 3.0).
    #[serde(default = "f_3")]
    pub m3c2_max_depth: f64,
    /// M3C2 registration error, metres (default 0.02).
    #[serde(default = "f_0_02")]
    pub m3c2_reg_error: f64,
    /// M3C2 voxel size, metres (default 0.1).
    #[serde(default = "f_0_1")]
    pub m3c2_voxel_size: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReportOutcome {
    pub out_path: String,
    pub bytes: usize,
    pub project_name: String,
    pub date: String,
    pub plot_area_ha: f64,
    pub plot_area_basis: AreaBasis,
    pub has_qsm: bool,
    pub has_biomass: bool,
    pub has_density: bool,
    pub has_validation: bool,
    pub has_growth: bool,
    pub has_m3c2: bool,
    /// Trees with no species assignment that used the fallback density.
    pub fallback_count: usize,
    pub summary: ReportSummary,
}

fn species_map(octree_dir: &str) -> Result<HashMap<i32, String>, String> {
    let text = octree_read_species(octree_dir.to_string())?;
    if text.trim().is_empty() {
        return Ok(HashMap::new());
    }
    let raw: std::collections::BTreeMap<String, String> = serde_json::from_str(&text).map_err(|e| format!("parse species.json: {e}"))?;
    Ok(raw.into_iter().filter_map(|(k, v)| k.parse::<i32>().ok().map(|id| (id, v))).collect())
}

/// Per-species tree counts over the QSM trees, richest first, labelled
/// with the preset's name where the key is one.
pub fn species_mix(qsm: &QsmResult, species: &HashMap<i32, String>) -> Vec<(String, usize)> {
    let mut order: Vec<String> = Vec::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    for t in &qsm.trees {
        if let Some(k) = species.get(&t.tree_id) {
            if !counts.contains_key(k) {
                order.push(k.clone());
            }
            *counts.entry(k.clone()).or_insert(0) += 1;
        }
    }
    let mut mix: Vec<(String, usize)> = order
        .into_iter()
        .map(|k| (species_density(&k).map(|s| s.label.to_string()).unwrap_or(k.clone()), counts[&k]))
        .collect();
    mix.sort_by(|a, b| b.1.cmp(&a.1));
    mix
}

fn valid_date(s: &str) -> Result<(), String> {
    let b = s.as_bytes();
    let ok = b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit());
    if ok { Ok(()) } else { Err(format!("date must be YYYY-MM-DD, got '{s}'")) }
}

fn export_report(ctx: &OpContext, p: ReportParams) -> Result<ReportOutcome, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    non_empty(&p.out_path, "outPath")?;
    if let Some(parent) = Path::new(&p.out_path).parent().filter(|d| !d.as_os_str().is_empty()) {
        if !parent.is_dir() {
            return Err(format!("{} is not a directory", parent.display()));
        }
    }
    if !(p.unit_price.is_finite() && p.unit_price >= 0.0) {
        return Err("unitPrice must be zero or positive".into());
    }
    let currency = normalise_currency(&p.currency)?;
    let key = p.fallback_species.trim().to_lowercase();
    if key != CUSTOM_SPECIES_KEY && species_density(&key).is_none() {
        let keys: Vec<&str> = SPECIES_DENSITIES.iter().map(|s| s.key).collect();
        return Err(format!("fallbackSpecies '{}' is not a density preset: use {} or custom", p.fallback_species, keys.join(", ")));
    }
    let base = BiomassParams {
        density: p.density,
        density_std: p.density_std,
        carbon_fraction: p.carbon_fraction,
        carbon_fraction_std: p.carbon_fraction_std,
        branch_unc_fraction: p.branch_unc_fraction,
    };
    validate_biomass_params(&base)?;
    let date = match &p.date {
        Some(d) => {
            valid_date(d)?;
            d.clone()
        }
        None => today_utc(),
    };

    // The dataset's name and scanner, for the cover.
    let meta: serde_json::Value = std::fs::read(Path::new(&p.octree_dir).join("metadata.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(serde_json::Value::Null);
    let dataset_name = meta["name"]
        .as_str()
        .map(str::to_string)
        .or_else(|| Path::new(&p.octree_dir).file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| "PointCloudLabeler plot".to_string());
    let project_name = p.project_name.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or(dataset_name);
    let crs_label = meta["scannerType"].as_str().map(str::to_string);

    let sink = ctx.progress.under("metrics");
    let metrics = run_tree_metrics(&sink, &p.octree_dir, p.crown_cell, p.bh_low, p.bh_high, p.dtm_cell)?;
    let stems = if p.merge_stems { octree_read_stems(p.octree_dir.clone())? } else { None };
    let merged = merge_stem_fits(&metrics, stems.as_deref());
    let qsm = octree_read_qsm(p.octree_dir.clone())?;
    let species = species_map(&p.octree_dir)?;

    let xy: Vec<[f64; 2]> = merged.iter().filter(|m| m.metric.x.is_finite() && m.metric.y.is_finite()).map(|m| [m.metric.x, m.metric.y]).collect();
    let (plot_area, basis) = resolve_plot_area(p.plot_area_ha, &octree_read_plot(p.octree_dir.clone())?, &xy)?;

    let mut fallback_count = 0;
    let biomass = qsm.as_ref().filter(|q| !q.trees.is_empty()).map(|q| {
        let (per_tree, n_fallback) = compute_species_aware_biomass(&q.trees, &species, &key, base);
        fallback_count = n_fallback;
        let totals = compute_biomass_totals(&per_tree);
        let params = biomass_params_for_species(&key, base);
        let label = fallback_density_label(&key, &params);
        BiomassBlock {
            species_mix: species_mix(q, &species),
            fallback_count: n_fallback,
            fallback_label: label.label,
            fallback_density: Some(label.density),
            fallback_source: species_density(&key).map(|s| s.source.to_string()),
            biomass_kg: totals.biomass,
            biomass_kg_ci95: 1.96 * totals.biomass_std,
            carbon_kg: totals.carbon,
            carbon_kg_ci95: 1.96 * totals.carbon_std,
            co2e_kg: totals.co2e,
            co2e_kg_ci95: 1.96 * totals.co2e_std,
        }
    });

    if !(p.validation_radius.is_finite() && p.validation_radius >= 0.0) {
        return Err("validationRadius must be zero or positive".into());
    }
    if !(p.years.is_finite() && p.years > 0.0) {
        return Err("years must be positive".into());
    }
    if !(p.growth_radius.is_finite() && p.growth_radius >= 0.0) {
        return Err("growthRadius must be zero or positive".into());
    }
    if !(p.form_factor.is_finite() && p.form_factor > 0.0) {
        return Err("formFactor must be positive".into());
    }
    let rows: Vec<TreeMetric> = merged.iter().map(|m| m.metric.clone()).collect();
    let field_validation = match p.field_csv.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(path) => {
            let none = super::validation::Mapping { x_col: None, y_col: None, dbh_col: None, height_col: None, species_col: None, id_col: None };
            let (_, _, fields) = super::validation::read_field_csv(path, &none)?;
            let r = super::validation::match_trees(&fields, &rows, p.validation_radius);
            let pairs: Vec<(f64, f64)> = r.matches.iter().map(|m| (m.field.caliper_dbh, m.measured.dbh)).collect();
            super::validation::stats_for(&pairs).as_ref().map(super::validation::summary_of)
        }
        None => None,
    };
    let growth = match p.reference_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(ref_dir) => {
            let ref_metrics = run_tree_metrics(&sink, ref_dir, p.crown_cell, p.bh_low, p.bh_high, p.dtm_cell)?;
            let ref_stems = if p.merge_stems { octree_read_stems(ref_dir.to_string())? } else { None };
            let refs: Vec<TreeMetric> = merge_stem_fits(&ref_metrics, ref_stems.as_deref()).into_iter().map(|m| m.metric).collect();
            let res = super::growth::match_trees(&refs, &rows, p.growth_radius);
            let sm = super::growth::summarise(&res, p.form_factor);
            Some(GrowthBlock {
                years: p.years,
                n_matched: sm.n,
                mean_dbh_growth_cm_per_year: sm.mean_ddbh * 100.0 / p.years,
                mean_height_growth_m_per_year: sm.mean_dh / p.years,
                volume_change_m3: sm.sum_dv,
                harvested: sm.harvested_count,
                ingrowth: sm.ingrowth_count,
            })
        }
        None => None,
    };

    let m3c2 = match p.m3c2_reference_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(ref_dir) => {
            let outcome = super::run(
                "change.m3c2",
                serde_json::json!({
                    "octreeDir": p.octree_dir, "referenceDir": ref_dir, "coreSpacing": p.m3c2_core_spacing,
                    "normalScale": p.m3c2_normal_scale, "projectionScale": p.m3c2_projection_scale,
                    "maxDepth": p.m3c2_max_depth, "regError": p.m3c2_reg_error, "voxelSize": p.m3c2_voxel_size,
                }),
                ctx,
            )?;
            let defined = outcome["definedCount"].as_u64().unwrap_or(0);
            let significant = outcome["significantCount"].as_u64().unwrap_or(0);
            let ref_meta: serde_json::Value = std::fs::read(Path::new(ref_dir).join("metadata.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or(serde_json::Value::Null);
            let reference_name = ref_meta["name"]
                .as_str()
                .map(str::to_string)
                .or_else(|| Path::new(ref_dir).file_name().map(|n| n.to_string_lossy().to_string()))
                .unwrap_or_else(|| "the reference epoch".to_string());
            Some(M3c2Block {
                reference_name,
                core_points: defined,
                significant_pct: if defined > 0 { significant as f64 / defined as f64 * 100.0 } else { 0.0 },
                mean_change_cm: outcome["meanDistance"].as_f64().unwrap_or(f64::NAN) * 100.0,
                median_change_cm: outcome["medianDistance"].as_f64().unwrap_or(f64::NAN) * 100.0,
            })
        }
        None => None,
    };

    let density = if p.with_density {
        let dsink = ctx.progress.under("density");
        Some(DensitySummary::from(&run_density_metrics(&dsink, &p.octree_dir, 2.0, 0.2, 2.0, None)?))
    } else {
        None
    };

    let bucking = Bucking { unit_price: p.unit_price, currency };
    let inputs = ReportInputs {
        m3c2: m3c2.as_ref(),
        field_validation,
        growth,
        project_name: &project_name,
        description: p.description.as_deref().map(str::trim).filter(|s| !s.is_empty()),
        plot_area_ha: plot_area,
        plot_area_basis: basis,
        crs_label: crs_label.as_deref(),
        metrics: &merged,
        qsm: qsm.as_ref(),
        density: density.as_ref(),
        bucking: Some(&bucking),
        biomass: biomass.as_ref(),
        date: &date,
    };
    let html = generate_report_html(&inputs);
    let summary = summarise(&inputs);
    std::fs::write(&p.out_path, &html).map_err(|e| format!("write {}: {e}", p.out_path))?;
    Ok(ReportOutcome {
        out_path: p.out_path,
        bytes: html.len(),
        project_name: project_name.clone(),
        date: date.clone(),
        plot_area_ha: plot_area,
        plot_area_basis: basis,
        has_qsm: qsm.is_some(),
        has_biomass: biomass.is_some(),
        has_density: density.is_some(),
        has_validation: field_validation.is_some(),
        has_growth: growth.is_some(),
        has_m3c2: m3c2.is_some(),
        fallback_count,
        summary,
    })
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![op!("export.report", Export, mutates: false, stage: Some("metrics"),
        "Write the self-contained HTML inventory report: plot summary, volume / biomass / carbon, revenue, distributions, plot map, per-tree table, methodology.", ReportParams, export_report)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::octree::StemFit;

    fn tree(tree_id: i32, dbh: f64, height: f64, crown_area: f64) -> TreeMetric {
        TreeMetric {
            tree_id,
            count: 4000,
            height,
            dbh,
            basal_area: if dbh.is_finite() && dbh > 0.0 { basal_area(dbh) } else { f64::NAN },
            crown_area,
            crown_diameter: 2.0 * (crown_area / std::f64::consts::PI).sqrt(),
            x: tree_id as f64 * 3.0,
            y: 0.0,
            base_z: 0.0,
            lean_deg: 0.0,
        }
    }

    fn plain(ms: &[TreeMetric]) -> Vec<MergedMetric> {
        merge_stem_fits(ms, None)
    }

    fn fit(tree_id: i32, dbh: f64) -> StemFit {
        serde_json::from_value(serde_json::json!({
            "treeId": tree_id, "dbh": dbh, "centerX": 0, "centerY": 0, "inlierCount": 40, "bandCount": 60, "rmse": 0.004, "writtenStemPoints": 0,
        }))
        .unwrap()
    }

    fn qsm_tree(tree_id: i32, stem_volume: f64, ci95: f64, confidence: f64, branch: f64) -> TreeQsm {
        serde_json::from_value(serde_json::json!({
            "treeId": tree_id, "baseX": 0, "baseY": 0, "baseZ": 0, "height": 20,
            "slices": [], "branches": [], "branchVolume": branch, "branchCount": 0,
            "totalVolume": stem_volume + branch, "stemVolume": stem_volume, "stemVolumeStd": 0, "stemVolumeCi95": ci95,
            "dbh": 0.3, "confidence": confidence, "completeness": 1.0, "acceptedSlices": 10, "rejectedSlices": 0,
        }))
        .unwrap()
    }

    fn qsm(trees: Vec<TreeQsm>) -> QsmResult {
        QsmResult { trees, total_stem_volume: 0.0, total_stem_volume_std: 0.0, qsm_path: String::new(), slice_height: 0.5, min_points_per_slice: 10 }
    }

    fn inputs<'a>(metrics: &'a [MergedMetric], plot_area_ha: f64) -> ReportInputs<'a> {
        ReportInputs {
            m3c2: None,
            field_validation: None,
            growth: None,
            project_name: "Plot 1",
            description: None,
            plot_area_ha,
            plot_area_basis: AreaBasis::Boundary,
            crs_label: None,
            metrics,
            qsm: None,
            density: None,
            bucking: None,
            biomass: None,
            date: "2026-01-06",
        }
    }

    fn g(d: f64) -> f64 {
        basal_area(d)
    }

    fn close(a: f64, b: f64, digits: i32) -> bool {
        (a - b).abs() < 10f64.powi(-digits) / 2.0
    }

    fn with_gap() -> Vec<TreeMetric> {
        vec![tree(1, 0.30, 22.0, 12.0), tree(2, 0.28, 21.0, 12.0), tree(3, 0.35, 24.0, 12.0), tree(4, 0.32, 0.0, 12.0)]
    }

    // --- summarise ---

    #[test]
    fn counts_every_tree_and_takes_each_statistic_over_the_trees_that_have_it() {
        let m = plain(&with_gap());
        let s = summarise(&inputs(&m, 0.04));
        assert_eq!((s.tree_count, s.n_with_dbh, s.n_with_height), (4, 4, 3));
        assert!(close(s.basal_area_total_m2, g(0.30) + g(0.28) + g(0.35) + g(0.32), 12));
        assert!(close(s.mean_dbh, (0.30 + 0.28 + 0.35 + 0.32) / 4.0, 12));
        assert!(close(s.median.dbh, (0.30 + 0.32) / 2.0, 12));
        assert!(close(s.mean_height, (22.0 + 21.0 + 24.0) / 3.0, 12));
        assert!(close(s.median.height, 22.0, 12));
        let num = g(0.30) * 22.0 + g(0.28) * 21.0 + g(0.35) * 24.0;
        let den = g(0.30) + g(0.28) + g(0.35);
        assert!(close(s.lorey_mean_height, num / den, 10));
        assert_eq!(s.top_n_count, 1);
        assert!(close(s.dominant_height, 24.0, 12));
        assert!(close(s.stems_per_ha, 4.0 / 0.04, 10));
        assert!(close(s.basal_area_per_ha, (g(0.30) + g(0.28) + g(0.35) + g(0.32)) / 0.04, 10));
        assert!(close(s.mean_crown_area, 12.0, 12));
        assert_eq!(s.n_refined_dbh, 0);
    }

    #[test]
    fn nan_rather_than_a_number_when_nothing_can_be_measured_and_no_zero_division() {
        let m = plain(&[tree(1, f64::NAN, 0.0, f64::NAN)]);
        let s = summarise(&inputs(&m, 0.04));
        assert_eq!((s.tree_count, s.n_with_dbh, s.n_with_height), (1, 0, 0));
        assert!(s.mean_dbh.is_nan() && s.median.height.is_nan() && s.lorey_mean_height.is_nan() && s.dominant_height.is_nan() && s.mean_crown_area.is_nan());
        assert_eq!(s.basal_area_total_m2, 0.0);
        let s = summarise(&inputs(&[], 0.0));
        assert_eq!((s.tree_count, s.stems_per_ha, s.basal_area_per_ha), (0, 0.0, 0.0));
        let mixed = plain(&[tree(1, 0.30, 20.0, 10.0), tree(2, 0.30, 20.0, f64::NAN), tree(3, 0.30, 20.0, 14.0)]);
        assert!(close(summarise(&inputs(&mixed, 0.04)).mean_crown_area, 12.0, 12));
    }

    #[test]
    fn qsm_totals_and_the_biomass_block_carry_through() {
        let m = plain(&with_gap());
        let q = qsm(vec![qsm_tree(1, 0.8, 0.04, 0.9, 0.1), qsm_tree(2, 0.5, 0.03, 0.7, 0.0)]);
        let mut inp = inputs(&m, 0.04);
        inp.qsm = Some(&q);
        let b = BiomassBlock { biomass_kg: 520.0, carbon_kg: 260.0, co2e_kg: 953.3, ..Default::default() };
        inp.biomass = Some(&b);
        let s = summarise(&inp);
        assert!(close(s.total_stem_volume_m3.unwrap(), 1.3, 12));
        assert!(close(s.stem_volume_ci95.unwrap(), 0.04f64.hypot(0.03), 12));
        assert!(close(s.total_branch_volume_m3.unwrap(), 0.1, 12));
        assert!(close(s.mean_confidence.unwrap(), 0.8, 12));
        assert_eq!((s.biomass_kg, s.carbon_kg, s.co2e_kg), (Some(520.0), Some(260.0), Some(953.3)));
    }

    // --- provenance ---

    #[test]
    fn counts_the_refined_diameters_and_says_so_only_when_there_are_any() {
        let merged = merge_stem_fits(&with_gap(), Some(&[fit(1, 0.31), fit(3, 0.34)]));
        assert_eq!(summarise(&inputs(&merged, 0.04)).n_refined_dbh, 2);
        let one = merge_stem_fits(&with_gap(), Some(&[fit(1, 0.31)]));
        let html = generate_report_html(&inputs(&one, 0.04));
        assert!(html.contains("1 of 4 diameters from the RANSAC stem fit"));
        let plain_html = generate_report_html(&inputs(&plain(&with_gap()), 0.04));
        assert!(!plain_html.contains("RANSAC"));
    }

    // --- rendered report ---

    #[test]
    fn quotes_revenue_in_the_currency_it_was_given() {
        let m = plain(&with_gap());
        let q = qsm(vec![qsm_tree(1, 2.0, 0.0, 0.9, 0.0)]);
        let mut inp = inputs(&m, 0.5);
        inp.project_name = "Fundo Los Alerces";
        inp.qsm = Some(&q);
        let clp = Bucking { unit_price: 35000.0, currency: "CLP".into() };
        inp.bucking = Some(&clp);
        let html = generate_report_html(&inp);
        assert!(html.contains("CLP/ha"));
        assert!(html.contains("35000 CLP/m³"));
        assert!(!html.contains('€'));
        assert!(html.contains("140000"), "2 m³ at 35000 over half a hectare");

        let eur = Bucking { unit_price: 35.0, currency: "€".into() };
        inp.bucking = Some(&eur);
        assert!(generate_report_html(&inp).contains("€/ha"));

        let nasty = Bucking { unit_price: 1.0, currency: "<b>x".into() };
        inp.bucking = Some(&nasty);
        let html = generate_report_html(&inp);
        assert!(!html.contains("<b>x"));
        assert!(html.contains("&lt;b&gt;x"));
    }

    fn biomass_block() -> BiomassBlock {
        BiomassBlock {
            species_mix: vec![],
            fallback_count: 4,
            fallback_label: "custom density".into(),
            fallback_density: Some(655.0),
            fallback_source: None,
            biomass_kg: 1310.0,
            biomass_kg_ci95: 80.0,
            carbon_kg: 655.0,
            carbon_kg_ci95: 40.0,
            co2e_kg: 2401.0,
            co2e_kg_ci95: 150.0,
        }
    }

    #[test]
    fn states_the_density_its_carbon_figure_was_computed_at() {
        let m = plain(&with_gap());
        let q = qsm(vec![qsm_tree(1, 2.0, 0.0, 0.9, 0.0)]);
        let mut inp = inputs(&m, 0.5);
        inp.qsm = Some(&q);
        let b = biomass_block();
        inp.biomass = Some(&b);
        let html = generate_report_html(&inp);
        assert!(html.contains("655 kg/m³"));
        assert!(html.contains("custom density"));
        assert!(html.contains("biomass-fallback"));
        assert!(html.contains("4 trees had no species assignment"));

        let older = BiomassBlock { fallback_density: None, ..biomass_block() };
        inp.biomass = Some(&older);
        let html = generate_report_html(&inp);
        assert!(html.contains("custom density") && !html.contains("kg/m³"));
        let broken = BiomassBlock { fallback_density: Some(f64::NAN), ..biomass_block() };
        inp.biomass = Some(&broken);
        assert!(!generate_report_html(&inp).contains("kg/m³"));

        let assigned = BiomassBlock { fallback_count: 0, species_mix: vec![("Scots pine (Pinus sylvestris)".into(), 3), ("Birch (Betula spp.)".into(), 1)], ..biomass_block() };
        inp.biomass = Some(&assigned);
        let html = generate_report_html(&inp);
        assert!(html.contains("Species mix: Scots pine (Pinus sylvestris) (3), Birch (Betula spp.) (1). Every tree carried its own species assignment."));
    }

    #[test]
    fn prints_no_nan_anywhere_whatever_the_caches_are_missing() {
        let m = plain(&with_gap());
        let mut t = qsm_tree(1, 2.0, 0.0, 0.0, 0.0);
        t.stem_volume_ci95 = f64::NAN;
        t.confidence = f64::NAN;
        t.branch_volume = f64::NAN;
        let old = qsm(vec![t]);
        let mut inp = inputs(&m, 0.5);
        inp.qsm = Some(&old);
        let html = generate_report_html(&inp);
        assert!(!html.contains("NaN") && !html.contains("undefined"));
        assert!(html.contains("#1") && html.contains("—"));

        let mut ms = with_gap();
        ms.push(TreeMetric { tree_id: 9, crown_area: f64::NAN, height: f64::NAN, ..with_gap()[0].clone() });
        let m = plain(&ms);
        let html = generate_report_html(&inputs(&m, 0.5));
        assert!(!html.contains("NaN"));
        assert!(html.contains("#9"));

        // No tree at all: the charts say so rather than failing.
        let html = generate_report_html(&inputs(&[], 0.5));
        assert!(html.contains("no data") && html.contains("no positioned trees") && !html.contains("NaN"));
    }

    #[test]
    fn credits_a_source_only_when_the_number_came_from_it_and_names_every_terrain_source() {
        let m = plain(&with_gap());
        let q = qsm(vec![qsm_tree(1, 2.0, 0.0, 0.9, 0.0)]);
        let mut inp = inputs(&m, 0.5);
        inp.qsm = Some(&q);
        let preset = BiomassBlock { fallback_label: "Scots pine".into(), fallback_density: Some(400.0), fallback_source: Some("Repola 2006 / Kärkkäinen 2007".into()), ..biomass_block() };
        inp.biomass = Some(&preset);
        let html = generate_report_html(&inp);
        assert!(html.contains("Repola, J. (2006)") && html.contains("Silva Fennica 40(4):673–685"));

        let custom = biomass_block();
        inp.biomass = Some(&custom);
        let html = generate_report_html(&inp);
        assert!(!html.contains("Repola") && !html.contains("Silva Fennica"));
        assert!(html.contains("supplied by the analyst") && html.contains("655 kg/m³"));

        let html = generate_report_html(&inputs(&m, 0.5));
        for src in ["Horn, B.K.P. (1981)", "Mark, R.K. (1992)", "Weiss, A. (2001)", "Zevenbergen, L.W."] {
            assert!(html.contains(src), "{src}");
        }
        assert!(!html.contains("pixel_metrics"), "no density block, no density citation");
    }

    #[test]
    fn the_density_block_prints_the_grid_and_the_plot_statistics() {
        let m = plain(&with_gap());
        let d = DensitySummary {
            cell_size: 2.0, cols: 15, rows: 15, min_height: 0.2, plot_count: 1_234_567, plot_density: 1371.7,
            plot_mean: 8.12, plot_sd: 5.43, plot_p25: 2.5, plot_p50: 7.9, plot_p75: 12.1, plot_p90: 15.4, plot_p95: 17.2,
            canopy_threshold: 2.0, plot_canopy_cover: 0.876, plot_skew: 0.12, plot_kurt: 1.98,
        };
        let mut inp = inputs(&m, 0.09);
        inp.density = Some(&d);
        let html = generate_report_html(&inp);
        assert!(html.contains("2.00 m · 15×15 grid"));
        assert!(html.contains("1.23 M · 1371.7 pts/m²"));
        assert!(html.contains("Canopy cover ≥ 2.0 m"), "{html}");
        assert!(html.contains("87.6 %"));
        assert!(html.contains("pixel_metrics"));
    }

    #[test]
    fn the_cover_carries_the_date_the_name_the_area_basis_and_the_version() {
        let m = plain(&with_gap());
        let mut inp = inputs(&m, 0.04);
        inp.description = Some("Evo, plot 1001 <test>");
        inp.crs_label = Some("tls");
        let html = generate_report_html(&inp);
        assert!(html.contains("forestry inventory report · 2026-01-06 · tls"));
        assert!(html.contains("Evo, plot 1001 &lt;test&gt;"));
        assert!(html.contains("0.040 ha (400 m²) — defined plot boundary"));
        assert!(html.contains(&format!("Generated by {PRODUCT_NAME} {APP_VERSION}.")));
        assert!(html.contains("4 (4 with a diameter, 3 with a height)"));
        inp.plot_area_basis = AreaBasis::Bbox;
        assert!(generate_report_html(&inp).contains("estimated — tree bbox"));
    }

    #[test]
    fn the_validation_and_growth_blocks_render_with_their_sources() {
        let m = plain(&with_gap());
        let mut inp = inputs(&m, 0.04);
        let html = generate_report_html(&inp);
        assert!(!html.contains("Field-data validation") && !html.contains("Tree growth"));
        assert!(!html.contains("Greedy bipartite"));
        inp.field_validation = Some(ValidationSummary { n_matched: 42, bias_cm: 0.37, rmse_cm: 1.25, r2: 0.912 });
        inp.growth = Some(GrowthBlock { years: 5.0, n_matched: 40, mean_dbh_growth_cm_per_year: 0.42, mean_height_growth_m_per_year: 0.31, volume_change_m3: 1.5, harvested: 2, ingrowth: 3 });
        let html = generate_report_html(&inp);
        assert!(html.contains("<h2>Field-data validation</h2>") && html.contains("+0.37") && html.contains("1.25") && html.contains("0.912"));
        assert!(html.contains("<h2>Tree growth — 5.0-year interval</h2>") && html.contains("+1.50") && html.contains("2 harvested / fallen · 3 ingrowth"));
        assert!(html.contains("<b>Field validation</b>") && html.contains("<b>Tree growth</b>"));
        assert!(!html.contains("NaN"));
        inp.growth = Some(GrowthBlock { volume_change_m3: -0.25, ..inp.growth.unwrap() });
        assert!(generate_report_html(&inp).contains("-0.25"));

        let block = M3c2Block { reference_name: "plot 2023 <ref>".into(), core_points: 12345, significant_pct: 37.25, mean_change_cm: -1.234, median_change_cm: 0.5 };
        inp.m3c2 = Some(&block);
        let html = generate_report_html(&inp);
        assert!(html.contains("<h2>M3C2 surface change — vs. plot 2023 &lt;ref&gt;</h2>"));
        assert!(html.contains("12345") && html.contains("37.3") && html.contains("-1.2") && html.contains("+0.5"));
        assert!(html.contains("Lague, D., Brodu, N."));
        assert!(!html.contains("NaN"));
    }

    #[test]
    fn dates_are_civil_dates() {
        assert_eq!(iso_date(0), "1970-01-01");
        assert_eq!(iso_date(1_767_659_400), "2026-01-06"); // 2026-01-06T00:30:00Z
        assert_eq!(iso_date(1_788_998_399), "2026-09-09"); // 2026-09-09T23:59:59Z
        assert_eq!(iso_date(1_798_761_599), "2026-12-31");
        assert_eq!(iso_date(1_767_225_600), "2026-01-01");
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(today_utc().len(), 10);
        assert!(valid_date("2026-01-06").is_ok());
        assert!(valid_date("6.1.2026").is_err());
    }

    #[test]
    fn species_mix_is_richest_first_with_preset_labels() {
        let q = qsm(vec![qsm_tree(1, 1.0, 0.0, 0.9, 0.0), qsm_tree(2, 1.0, 0.0, 0.9, 0.0), qsm_tree(3, 1.0, 0.0, 0.9, 0.0), qsm_tree(4, 1.0, 0.0, 0.9, 0.0)]);
        let species: HashMap<i32, String> = [(1, "birch".to_string()), (2, "pine".to_string()), (3, "pine".to_string()), (4, "larch".to_string())].into();
        let mix = species_mix(&q, &species);
        assert_eq!(mix, vec![("Scots pine (Pinus sylvestris)".to_string(), 2), ("Birch (Betula spp.)".to_string(), 1), ("larch".to_string(), 1)]);
    }

    #[test]
    fn agrees_with_the_plot_statistics_on_stems_and_basal_area() {
        let m = plain(&with_gap());
        let s = summarise(&inputs(&m, 0.04));
        let rows: Vec<TreeMetric> = m.iter().map(|x| x.metric.clone()).collect();
        let rect = super::super::forestry::PlotBoundary::Rectangular { min: [0.0, -1.0], max: [20.0, 19.0] };
        let p = super::super::forestry::compute_plot_stats(&rows, &rect, super::super::forestry::EdgeCorrection::None, 1.0, None);
        assert!(close(p.basal_area_per_ha, s.basal_area_per_ha, 10));
        assert!(close(p.stems_per_ha, s.stems_per_ha, 10));
    }

    #[test]
    fn the_operation_is_catalogued_and_refuses_bad_parameters_first() {
        let op = super::super::find("export.report").expect("export.report");
        assert!(!op.mutates);
        let schema = op.params_schema();
        assert_eq!(schema["properties"]["unitPrice"]["default"], 35.0);
        assert_eq!(schema["properties"]["currency"]["default"], "€");
        assert_eq!(schema["properties"]["fallbackSpecies"]["default"], "pine");
        let ctx = OpContext::silent();
        let run = |v: serde_json::Value| super::super::run("export.report", v, &ctx).unwrap_err();
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere" })).contains("outPath"));
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "outPath": "/no/such/dir/r.html" })).contains("not a directory"));
        let tmp = std::env::temp_dir().join("pcl-report-test.html");
        let out = tmp.to_string_lossy().to_string();
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "outPath": out, "unitPrice": -1 })).contains("unitPrice"));
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "outPath": out, "fallbackSpecies": "larch" })).contains("not a density preset"));
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "outPath": out, "date": "yesterday" })).contains("YYYY-MM-DD"));
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "outPath": out, "density": 5, "fallbackSpecies": "custom" })).contains("density must be between"));
    }
}
