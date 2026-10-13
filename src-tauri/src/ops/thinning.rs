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

//! The thinning simulator (`src/metrics/thinning.ts`), in Rust for the
//! headless surfaces.
//!
//! Set a target post-thinning basal area (m²/ha); this decides which
//! trees come out and where the strip roads run:
//!
//! 1. strip-road centrelines, parallel at the chosen heading and
//!    spacing across the stand;
//! 2. forced removal: anything within road_width / 2 of a centreline
//!    has to go so the harvester can pass;
//! 3. boom-reach candidates: within boom_reach of a centreline; beyond
//!    that the harvester cannot get to it;
//! 4. score the candidates, sort descending, remove greedily until the
//!    target basal area is reached or the pool runs out.
//!
//! The simulation is advisory: nothing on disk changes. What the panel
//! owes the user beyond the numbers — which stems the arithmetic could
//! not include, where the removed volume came from, when a selected
//! strategy has no input to work with — the operation reports too.

use std::collections::HashMap;
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::forestry::{
    describe_volume_sources, estimated_area_ha, parse_plot_boundary, plot_area_ha, resolve_volume, tally_sources,
    AreaBasis, ResolvedVolume, VolumeOptions, VolumeSource, VolumeTally,
};
use super::qc::merge_stem_fits;
use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::{
    octree_read_plot, octree_read_qsm, octree_read_species, octree_read_stems, run_tree_metrics, run_tree_summary,
    QsmResult, TreeMetric,
};

#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Strategy {
    /// Thinning from below: the small stems go first.
    Low,
    /// Thinning from above: the large stems go first.
    High,
    /// Poorly covered QSM stems go first; size second.
    Quality,
    /// Half quality, half from below.
    Mixed,
}

/// A tree as the simulator sees it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Tree {
    pub tree_id: i32,
    pub x: f64,
    pub y: f64,
    pub dbh: f64,
    pub height: f64,
    /// Basal area (m²).
    pub ba: f64,
    /// Stem volume (m³): the QSM's when there is one, otherwise an
    /// estimate; `volume_source` says which. 0 for a tree nothing could
    /// be estimated for.
    pub volume: f64,
    pub volume_source: VolumeSource,
    /// QSM angular coverage (0..1). NaN when the tree has no QSM — not
    /// 1: an unassessed tree is not a tree that scored perfectly.
    pub confidence: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<[[f64; 3]; 2]>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Road {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

#[derive(Clone, Debug)]
pub struct Plan {
    pub forced: Vec<Tree>,
    /// Scored order, highest first.
    pub candidates: Vec<Tree>,
    pub unreachable: Vec<Tree>,
    /// The forced trees, then the selected candidates.
    pub removed: Vec<Tree>,
    pub roads: Vec<Road>,
    pub ba_after: f64,
    pub ba_before: f64,
    pub plot_area_ha: f64,
    pub cannot_reach_target: bool,
    /// Whether the quality term had any input; false when no tree
    /// carries a QSM confidence, and the weight was redistributed.
    pub quality_available: bool,
}

/// Trees for the simulator, plus what had to be left out of it.
#[derive(Debug)]
pub struct TreeSet {
    pub trees: Vec<Tree>,
    pub volume_sources: VolumeTally,
    /// Metrics rows with no usable DBH, so absent from every figure.
    pub n_no_dbh: usize,
    /// Trees whose volume is the form-factor guess rather than a QSM
    /// or the national function.
    pub n_allometric: usize,
    /// Trees whose volume could not be estimated at all (no height).
    pub n_no_height: usize,
}

/// Conservative boreal-softwood form factor for the fallback volume.
pub const FORM_FACTOR: f64 = 0.50;

/// The renderer's `buildTrees`: one tree per metrics row with a usable
/// diameter, its volume resolved QSM > national function > form factor.
pub fn build_trees(
    metrics: &[TreeMetric],
    qsm: Option<&QsmResult>,
    bboxes: Option<&HashMap<i32, [[f64; 3]; 2]>>,
    species_by_tree: Option<&HashMap<i32, String>>,
    default_species: Option<&str>,
) -> TreeSet {
    let qsm_map: HashMap<i32, (f64, f64)> = qsm
        .map(|q| q.trees.iter().map(|t| (t.tree_id, (t.stem_volume, t.confidence))).collect())
        .unwrap_or_default();
    let qsm_volumes: HashMap<i32, f64> = qsm_map.iter().map(|(id, (v, _))| (*id, *v)).collect();
    let opts = VolumeOptions { qsm: Some(&qsm_volumes), species_by_tree, default_species, form_factor: FORM_FACTOR };

    let mut trees = Vec::new();
    let mut resolved: Vec<ResolvedVolume> = Vec::new();
    let (mut n_no_dbh, mut n_allometric, mut n_no_height) = (0, 0, 0);
    for t in metrics {
        if !t.dbh.is_finite() || t.dbh <= 0.0 {
            n_no_dbh += 1;
            continue;
        }
        let ba = std::f64::consts::PI * (t.dbh * 0.5) * (t.dbh * 0.5);
        let rv = resolve_volume(t, &opts);
        let volume = if rv.volume.is_finite() { rv.volume } else { 0.0 };
        match rv.source {
            VolumeSource::FormFactor => n_allometric += 1,
            VolumeSource::None => n_no_height += 1,
            _ => {}
        }
        trees.push(Tree {
            tree_id: t.tree_id,
            x: t.x,
            y: t.y,
            dbh: t.dbh,
            height: t.height,
            ba,
            volume,
            volume_source: rv.source,
            confidence: qsm_map.get(&t.tree_id).map(|q| q.1).unwrap_or(f64::NAN),
            bbox: bboxes.and_then(|b| b.get(&t.tree_id).copied()),
        });
        resolved.push(rv);
    }
    TreeSet { trees, volume_sources: tally_sources(&resolved), n_no_dbh, n_allometric, n_no_height }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Weights {
    pub qual: f64,
    pub small: f64,
    pub large: f64,
}

/// Weights for a strategy. Without a quality signal (no tree carries a
/// QSM confidence) the quality weight is redistributed over the size
/// terms, so "quality thinning" without a QSM is the size thinning it
/// has become rather than a mostly-random selection.
pub fn strategy_weights(strategy: Strategy, has_quality: bool) -> Weights {
    let w = match strategy {
        Strategy::Low => Weights { qual: 0.30, small: 0.70, large: 0.0 },
        Strategy::High => Weights { qual: 0.30, small: 0.0, large: 0.70 },
        Strategy::Quality => Weights { qual: 0.80, small: 0.20, large: 0.0 },
        Strategy::Mixed => Weights { qual: 0.50, small: 0.50, large: 0.0 },
    };
    if has_quality {
        return w;
    }
    let rest = w.small + w.large;
    if rest <= 0.0 {
        return Weights { qual: 0.0, small: 1.0, large: 0.0 };
    }
    let k = 1.0 / rest;
    Weights { qual: 0.0, small: w.small * k, large: w.large * k }
}

/// Deterministic per-tree tie-breaker in [0, 1): Knuth's multiplicative
/// hash, so the same tree gets the same value on every run. Exact
/// integer arithmetic here; the renderer's double-precision product is
/// the same for every id under about 3.4 million.
pub fn tree_jitter(tree_id: i32) -> f64 {
    let id = tree_id as u32 as u64;
    ((id.wrapping_mul(2_654_435_761)) % 4_294_967_296) as f64 / 4_294_967_296.0
}

/// How much of the score the tie-breaker may move: enough to split
/// trees the weighted terms rank equally, no more.
pub const JITTER_WEIGHT: f64 = 0.05;

/// Low confidence → high score → removed first. An unassessed tree
/// (NaN) scores 0 on the quality term rather than counting as a perfect
/// stem.
pub fn score_tree(t: &Tree, w: &Weights, jitter: f64, dbh_max: f64) -> f64 {
    let conf = if t.confidence.is_finite() { t.confidence.clamp(0.0, 1.0) } else { 1.0 };
    let s_qual = 1.0 - conf;
    let s_small = if dbh_max > 0.0 { 1.0 - t.dbh / dbh_max } else { 0.0 };
    let s_large = if dbh_max > 0.0 { t.dbh / dbh_max } else { 0.0 };
    w.qual * s_qual + w.small * s_small + w.large * s_large + jitter * JITTER_WEIGHT
}

#[derive(Clone, Copy, Debug)]
pub struct Bbox {
    pub x_min: f64,
    pub y_min: f64,
    pub x_max: f64,
    pub y_max: f64,
}

/// Strip-road centrelines covering the bbox at the given spacing and
/// heading. Empty for a non-positive spacing or an empty bbox, rather
/// than walking forever.
pub fn generate_roads(bbox: Bbox, heading_deg: f64, spacing: f64) -> Vec<Road> {
    // `spacing <= 0.0` is false for NaN, so the test is written to
    // reject NaN too.
    if spacing.is_nan() || spacing <= 0.0 || !bbox.x_min.is_finite() || !bbox.x_max.is_finite() {
        return Vec::new();
    }
    let theta = heading_deg.to_radians();
    let dir = [theta.cos(), theta.sin()];
    let norm = [-theta.sin(), theta.cos()];
    let cx = (bbox.x_min + bbox.x_max) * 0.5;
    let cy = (bbox.y_min + bbox.y_max) * 0.5;
    let corners = [[bbox.x_min, bbox.y_min], [bbox.x_max, bbox.y_min], [bbox.x_max, bbox.y_max], [bbox.x_min, bbox.y_max]];
    let (mut n_min, mut n_max, mut d_min, mut d_max) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY);
    for [x, y] in corners {
        let (rx, ry) = (x - cx, y - cy);
        let n = rx * norm[0] + ry * norm[1];
        let d = rx * dir[0] + ry * dir[1];
        n_min = n_min.min(n);
        n_max = n_max.max(n);
        d_min = d_min.min(d);
        d_max = d_max.max(d);
    }
    let mut out = Vec::new();
    let mut n = (n_min / spacing).ceil() * spacing;
    while n <= n_max {
        out.push(Road {
            x1: cx + dir[0] * d_min + norm[0] * n,
            y1: cy + dir[1] * d_min + norm[1] * n,
            x2: cx + dir[0] * d_max + norm[0] * n,
            y2: cy + dir[1] * d_max + norm[1] * n,
        });
        n += spacing;
    }
    out
}

/// Distance from a point to the nearest road centreline; infinity when
/// there are no roads, since nothing is reachable without one.
pub fn dist_to_nearest_road(x: f64, y: f64, roads: &[Road]) -> f64 {
    let mut best = f64::INFINITY;
    for r in roads {
        let (dx, dy) = (r.x2 - r.x1, r.y2 - r.y1);
        let l2 = dx * dx + dy * dy;
        if l2 == 0.0 {
            continue;
        }
        let t = (((x - r.x1) * dx + (y - r.y1) * dy) / l2).clamp(0.0, 1.0);
        let (px, py) = (r.x1 + dx * t, r.y1 + dy * t);
        let d = (x - px).hypot(y - py);
        if d < best {
            best = d;
        }
    }
    best
}

#[derive(Clone, Copy, Debug)]
pub struct SimulateOptions {
    pub target_ba_per_ha: f64,
    pub plot_area_ha: f64,
    pub heading_deg: f64,
    pub road_spacing: f64,
    pub road_width: f64,
    pub boom_reach: f64,
    pub strategy: Strategy,
}

/// The renderer's `simulate`. A tree with no position never moves the
/// bbox (NaN fails both comparisons), measures NaN to every road and
/// lands in `unreachable`; its basal area still counts toward the stand.
pub fn simulate(trees: &[Tree], o: &SimulateOptions) -> Plan {
    let area = if o.plot_area_ha > 0.0 { o.plot_area_ha } else { 1e-6 };

    let (mut x_min, mut y_min, mut x_max, mut y_max) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for t in trees {
        if t.x < x_min { x_min = t.x }
        if t.x > x_max { x_max = t.x }
        if t.y < y_min { y_min = t.y }
        if t.y > y_max { y_max = t.y }
    }
    let pad = o.road_width;
    let roads = generate_roads(
        Bbox { x_min: x_min - pad, y_min: y_min - pad, x_max: x_max + pad, y_max: y_max + pad },
        o.heading_deg,
        o.road_spacing,
    );

    let half_width = o.road_width * 0.5;
    let (mut forced, mut candidates, mut unreachable) = (Vec::new(), Vec::new(), Vec::new());
    for t in trees {
        let d = dist_to_nearest_road(t.x, t.y, &roads);
        if d <= half_width {
            forced.push(t.clone());
        } else if d <= o.boom_reach {
            candidates.push(t.clone());
        } else {
            unreachable.push(t.clone());
        }
    }

    let ba_total: f64 = trees.iter().map(|t| t.ba).sum();
    let ba_before = ba_total / area;
    let ba_forced: f64 = forced.iter().map(|t| t.ba).sum::<f64>() / area;
    let ba_to_remove = (ba_before - ba_forced - o.target_ba_per_ha).max(0.0);

    let quality_available = trees.iter().any(|t| t.confidence.is_finite());
    let w = strategy_weights(o.strategy, quality_available);
    let dbh_max = trees.iter().map(|t| t.dbh).fold(0.0, |m, d| if d > m { d } else { m });
    let mut scored: Vec<(Tree, f64)> = candidates
        .into_iter()
        .map(|t| {
            let s = score_tree(&t, &w, tree_jitter(t.tree_id), dbh_max);
            (t, s)
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut removed_cands: Vec<Tree> = Vec::new();
    let mut ba_out = 0.0;
    for (t, _) in &scored {
        if ba_out / area >= ba_to_remove {
            break;
        }
        ba_out += t.ba;
        removed_cands.push(t.clone());
    }
    let n_removed_cands = removed_cands.len();
    let mut removed = forced.clone();
    removed.extend(removed_cands);
    let ba_after = (ba_total - removed.iter().map(|t| t.ba).sum::<f64>()) / area;
    let cannot_reach_target = ba_after > o.target_ba_per_ha + 0.05 && n_removed_cands == scored.len();

    Plan {
        forced,
        candidates: scored.into_iter().map(|(t, _)| t).collect(),
        unreachable,
        removed,
        roads,
        ba_after,
        ba_before,
        plot_area_ha: o.plot_area_ha,
        cannot_reach_target,
        quality_available,
    }
}

// --- the operation ------------------------------------------------------------

fn f_0_25() -> f64 { 0.25 }
fn f_0_5() -> f64 { 0.5 }
fn f_1_2() -> f64 { 1.2 }
fn f_1_4() -> f64 { 1.4 }
fn f_4() -> f64 { 4.0 }
fn f_10() -> f64 { 10.0 }
fn f_18() -> f64 { 18.0 }
fn f_20() -> f64 { 20.0 }
fn f_35() -> f64 { 35.0 }
fn yes() -> bool { true }
fn low() -> Strategy { Strategy::Low }
fn pine() -> Option<String> { Some("pine".into()) }
fn euro() -> String { DEFAULT_CURRENCY.into() }

/// The currency the price and the revenue are quoted in when none is
/// given (`src/metrics/currency.ts`).
pub const DEFAULT_CURRENCY: &str = "€";
/// Longest currency symbol or code accepted.
pub const MAX_CURRENCY_LEN: usize = 8;

/// Trim; empty falls back to the default; longer than the cap is an
/// error rather than a silent truncation.
pub fn normalise_currency(s: &str) -> Result<String, String> {
    let t = s.trim();
    if t.is_empty() {
        return Ok(DEFAULT_CURRENCY.to_string());
    }
    if t.chars().count() > MAX_CURRENCY_LEN {
        return Err(format!("currency must be at most {MAX_CURRENCY_LEN} characters, got '{t}'"));
    }
    Ok(t.to_string())
}

/// The Thinning panel's defaults.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThinningParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
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
    /// Take stem volumes and QSM confidence from qsm.json where present (default true).
    #[serde(default = "yes")]
    pub use_qsm: bool,
    /// Species function for trees with no entry in species.json ("pine", "spruce", "birch"); null leaves them to the form factor (default "pine").
    #[serde(default = "pine")]
    pub default_species: Option<String>,
    /// Post-thinning basal area to leave, m²/ha (default 18).
    #[serde(default = "f_18")]
    pub target_ba_per_ha: f64,
    /// Plot area in hectares; null takes the recorded plot boundary's area, or the stems' bounding box when there is none.
    #[serde(default)]
    pub plot_area_ha: Option<f64>,
    /// Strip-road heading, degrees from +x (default 0).
    #[serde(default)]
    pub heading_deg: f64,
    /// Distance between strip-road centrelines, metres (default 20).
    #[serde(default = "f_20")]
    pub road_spacing: f64,
    /// Strip-road width; everything within half of it is removed, metres (default 4).
    #[serde(default = "f_4")]
    pub road_width: f64,
    /// Harvester boom reach from a centreline, metres (default 10).
    #[serde(default = "f_10")]
    pub boom_reach: f64,
    /// Which trees go first: "low", "high", "quality" or "mixed" (default "low").
    #[serde(default = "low")]
    pub strategy: Strategy,
    /// Uniform price per m³ for the revenue estimate (default 35).
    #[serde(default = "f_35")]
    pub price_per_m3: f64,
    /// Currency symbol or code the price and revenue are in (default "€").
    #[serde(default = "euro")]
    pub currency: String,
    /// Carry each tree's bounding box into the removed list (reads the tree summary; default false).
    #[serde(default)]
    pub with_boxes: bool,
    /// Write the removed trees as CSV here (the panel's "Export removed CSV").
    #[serde(default)]
    pub out_csv: Option<String>,
}

/// Why a tree is on the removed list.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemovalReason {
    /// Standing in a strip-road corridor.
    Road,
    /// Chosen by the strategy to reach the target basal area.
    Selected,
}

impl RemovalReason {
    fn as_str(self) -> &'static str {
        match self {
            RemovalReason::Road => "road",
            RemovalReason::Selected => "selected",
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemovedTree {
    pub reason: RemovalReason,
    #[serde(flatten)]
    pub tree: Tree,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThinningReport {
    pub plot_area_ha: f64,
    pub area_basis: AreaBasis,
    pub target_ba_per_ha: f64,
    pub strategy: Strategy,
    /// Whether any tree carried a QSM confidence for the quality term.
    pub quality_available: bool,
    /// The road layout exposed too few trees to reach the target.
    pub cannot_reach_target: bool,
    pub n_total: usize,
    pub n_forced: usize,
    pub n_selected: usize,
    pub n_unreachable: usize,
    pub n_kept: usize,
    pub ba_before: f64,
    pub ba_after: f64,
    pub ba_removed: f64,
    /// Σ volume of the removed trees, m³.
    pub vol_removed: f64,
    pub price_per_m3: f64,
    pub currency: String,
    pub revenue: f64,
    pub volume_sources: VolumeTally,
    /// The tally in words.
    pub sources: String,
    /// Metrics rows with no usable DBH, absent from every figure.
    pub n_no_dbh: usize,
    pub n_allometric: usize,
    pub n_no_height: usize,
    pub roads: Vec<Road>,
    pub removed: Vec<RemovedTree>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csv_path: Option<String>,
}

fn csv_num(v: f64, decimals: usize) -> String {
    super::csvtext::csv_num(v, decimals)
}

/// The panel's removed-tree CSV, column for column.
pub fn removed_csv(removed: &[RemovedTree]) -> String {
    let mut out = String::from("tree_id,reason,x,y,dbh_cm,height_m,ba_m2,volume_m3,volume_source,confidence\n");
    for r in removed {
        let t = &r.tree;
        let source = match t.volume_source {
            VolumeSource::Qsm => "qsm",
            VolumeSource::Laasasenaho => "laasasenaho",
            VolumeSource::FormFactor => "formFactor",
            VolumeSource::None => "none",
        };
        out.push_str(&format!(
            "{},{},{},{},{},{},{},{},{},{}\n",
            t.tree_id,
            r.reason.as_str(),
            csv_num(t.x, 2),
            csv_num(t.y, 2),
            csv_num(t.dbh * 100.0, 1),
            csv_num(t.height, 1),
            csv_num(t.ba, 4),
            csv_num(t.volume, 4),
            source,
            csv_num(t.confidence, 3),
        ));
    }
    out
}

fn species_map(octree_dir: &str) -> Result<HashMap<i32, String>, String> {
    let text = octree_read_species(octree_dir.to_string())?;
    if text.trim().is_empty() {
        return Ok(HashMap::new());
    }
    let raw: std::collections::BTreeMap<String, String> =
        serde_json::from_str(&text).map_err(|e| format!("parse species.json: {e}"))?;
    Ok(raw.into_iter().filter_map(|(k, v)| k.parse::<i32>().ok().map(|id| (id, v))).collect())
}

/// The plot area the panels would use: a given figure, else the
/// recorded boundary, else the stems' bounding box.
pub fn resolve_plot_area(given: Option<f64>, plot_json: &str, xy: &[[f64; 2]]) -> Result<(f64, AreaBasis), String> {
    if let Some(a) = given {
        if !(a.is_finite() && a > 0.0) {
            return Err("plotAreaHa must be positive".into());
        }
        return Ok((a, AreaBasis::Manual));
    }
    if let Some(b) = parse_plot_boundary(plot_json) {
        return Ok((plot_area_ha(&b), AreaBasis::Boundary));
    }
    match estimated_area_ha(xy) {
        Some(a) => Ok((a, AreaBasis::Bbox)),
        None => Err("no positioned trees to estimate a plot area from; pass plotAreaHa or record a boundary with review.setPlot".into()),
    }
}

fn metrics_thinning(ctx: &OpContext, p: ThinningParams) -> Result<ThinningReport, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    if !(p.target_ba_per_ha.is_finite() && p.target_ba_per_ha >= 0.0) {
        return Err("targetBaPerHa must be zero or positive".into());
    }
    if !(p.road_spacing.is_finite() && p.road_spacing > 0.0) {
        return Err("roadSpacing must be positive".into());
    }
    for (name, v) in [("roadWidth", p.road_width), ("boomReach", p.boom_reach), ("pricePerM3", p.price_per_m3)] {
        if !(v.is_finite() && v >= 0.0) {
            return Err(format!("{name} must be zero or positive"));
        }
    }
    if !p.heading_deg.is_finite() {
        return Err("headingDeg must be a number".into());
    }
    let currency = normalise_currency(&p.currency)?;
    if let Some(out) = &p.out_csv {
        non_empty(out, "outCsv")?;
        if let Some(parent) = Path::new(out).parent().filter(|d| !d.as_os_str().is_empty()) {
            if !parent.is_dir() {
                return Err(format!("{} is not a directory", parent.display()));
            }
        }
    }

    let sink = ctx.progress.under("metrics");
    let metrics = run_tree_metrics(&sink, &p.octree_dir, p.crown_cell, p.bh_low, p.bh_high, p.dtm_cell)?;
    let stems = if p.merge_stems { octree_read_stems(p.octree_dir.clone())? } else { None };
    let rows: Vec<TreeMetric> = merge_stem_fits(&metrics, stems.as_deref()).into_iter().map(|m| m.metric).collect();
    let qsm = if p.use_qsm { octree_read_qsm(p.octree_dir.clone())? } else { None };
    let boxes: Option<HashMap<i32, [[f64; 3]; 2]>> = if p.with_boxes {
        Some(run_tree_summary(&ctx.progress, &p.octree_dir)?.into_iter().map(|e| (e.tree_id, [e.bbox_min, e.bbox_max])).collect())
    } else {
        None
    };
    let species = species_map(&p.octree_dir)?;
    let default_species = p.default_species.as_deref().filter(|k| !k.trim().is_empty());
    let set = build_trees(&rows, qsm.as_ref(), boxes.as_ref(), Some(&species), default_species);

    let xy: Vec<[f64; 2]> = set.trees.iter().filter(|t| t.x.is_finite() && t.y.is_finite()).map(|t| [t.x, t.y]).collect();
    let (plot_area, area_basis) = resolve_plot_area(p.plot_area_ha, &octree_read_plot(p.octree_dir.clone())?, &xy)?;

    let plan = simulate(
        &set.trees,
        &SimulateOptions {
            target_ba_per_ha: p.target_ba_per_ha,
            plot_area_ha: plot_area,
            heading_deg: p.heading_deg,
            road_spacing: p.road_spacing,
            road_width: p.road_width,
            boom_reach: p.boom_reach,
            strategy: p.strategy,
        },
    );

    let forced: std::collections::HashSet<i32> = plan.forced.iter().map(|t| t.tree_id).collect();
    let removed: Vec<RemovedTree> = plan
        .removed
        .iter()
        .map(|t| RemovedTree {
            reason: if forced.contains(&t.tree_id) { RemovalReason::Road } else { RemovalReason::Selected },
            tree: t.clone(),
        })
        .collect();
    let csv_path = match &p.out_csv {
        Some(out) => {
            std::fs::write(out, removed_csv(&removed)).map_err(|e| format!("write {out}: {e}"))?;
            Some(out.clone())
        }
        None => None,
    };
    let ba_removed: f64 = plan.removed.iter().map(|t| t.ba).sum::<f64>() / plot_area;
    let vol_removed: f64 = plan.removed.iter().map(|t| t.volume).sum();
    Ok(ThinningReport {
        plot_area_ha: plot_area,
        area_basis,
        target_ba_per_ha: p.target_ba_per_ha,
        strategy: p.strategy,
        quality_available: plan.quality_available,
        cannot_reach_target: plan.cannot_reach_target,
        n_total: set.trees.len(),
        n_forced: plan.forced.len(),
        n_selected: plan.removed.len() - plan.forced.len(),
        n_unreachable: plan.unreachable.len(),
        n_kept: set.trees.len() - plan.removed.len(),
        ba_before: plan.ba_before,
        ba_after: plan.ba_after,
        ba_removed,
        vol_removed,
        revenue: vol_removed * p.price_per_m3,
        price_per_m3: p.price_per_m3,
        currency,
        sources: describe_volume_sources(&set.volume_sources),
        volume_sources: set.volume_sources,
        n_no_dbh: set.n_no_dbh,
        n_allometric: set.n_allometric,
        n_no_height: set.n_no_height,
        roads: plan.roads,
        removed,
        csv_path,
    })
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![op!("metrics.thinning", Metrics, mutates: false, stage: Some("metrics"),
        "Simulate a thinning to a target basal area: strip roads, forced corridor removal, boom-reach candidates scored by strategy; the removed list, optionally as CSV.", ThinningParams, metrics_thinning)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::octree::TreeQsm;

    fn metric(tree_id: i32, x: f64, y: f64, dbh: f64, height: f64) -> TreeMetric {
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

    fn tree(tree_id: i32, x: f64, y: f64, dbh: f64, confidence: f64) -> Tree {
        Tree {
            tree_id,
            x,
            y,
            dbh,
            height: 20.0,
            ba: std::f64::consts::PI * (dbh / 2.0).powi(2),
            volume: 0.5,
            volume_source: VolumeSource::FormFactor,
            confidence,
            bbox: None,
        }
    }

    fn qsm_tree(tree_id: i32, stem_volume: f64, confidence: f64) -> TreeQsm {
        serde_json::from_value(serde_json::json!({
            "treeId": tree_id, "baseX": 0, "baseY": 0, "baseZ": 0, "height": 20,
            "slices": [], "branches": [], "branchVolume": 0, "branchCount": 0,
            "totalVolume": stem_volume, "stemVolume": stem_volume, "stemVolumeStd": 0, "stemVolumeCi95": 0,
            "dbh": 0.3, "confidence": confidence, "completeness": 1.0, "acceptedSlices": 10, "rejectedSlices": 0,
        }))
        .unwrap()
    }

    fn qsm(trees: Vec<TreeQsm>) -> QsmResult {
        QsmResult { trees, total_stem_volume: 0.0, total_stem_volume_std: 0.0, qsm_path: String::new(), slice_height: 0.5, min_points_per_slice: 10 }
    }

    const OPTS: SimulateOptions = SimulateOptions {
        target_ba_per_ha: 18.0,
        plot_area_ha: 0.04,
        heading_deg: 0.0,
        road_spacing: 20.0,
        road_width: 4.0,
        boom_reach: 10.0,
        strategy: Strategy::Low,
    };

    fn g(d: f64) -> f64 {
        std::f64::consts::PI * (d / 2.0).powi(2)
    }

    fn close(a: f64, b: f64, digits: i32) -> bool {
        (a - b).abs() < 10f64.powi(-digits) / 2.0
    }

    // --- buildTrees ---

    #[test]
    fn build_trees_counts_what_it_left_out_and_says_where_each_volume_came_from() {
        let s = build_trees(&[metric(1, 0.0, 0.0, 0.30, 20.0), metric(2, 1.0, 0.0, f64::NAN, 20.0), metric(3, 2.0, 0.0, 0.0, 20.0), metric(4, 3.0, 0.0, -1.0, 20.0)], None, None, None, None);
        assert_eq!((s.trees.len(), s.n_no_dbh), (1, 3));

        let q = qsm(vec![qsm_tree(1, 0.83, 0.62)]);
        let s = build_trees(&[metric(1, 0.0, 0.0, 0.30, 20.0)], Some(&q), None, None, None);
        assert!(close(s.trees[0].volume, 0.83, 12) && close(s.trees[0].confidence, 0.62, 12));
        assert_eq!((s.trees[0].volume_source, s.n_allometric), (VolumeSource::Qsm, 0));

        let s = build_trees(&[metric(1, 0.0, 0.0, 0.30, 22.0)], None, None, None, None);
        assert!(close(s.trees[0].volume, g(0.30) * 22.0 * FORM_FACTOR, 12));
        assert_eq!((s.trees[0].volume_source, s.n_allometric), (VolumeSource::FormFactor, 1));
        assert!(s.trees[0].confidence.is_nan(), "no QSM is not a perfect stem");

        let s = build_trees(&[metric(1, 0.0, 0.0, 0.30, 0.0)], None, None, None, None);
        assert_eq!((s.trees[0].volume, s.trees[0].volume_source, s.n_no_height), (0.0, VolumeSource::None, 1));

        let s = build_trees(&[], None, None, None, None);
        assert!(s.trees.is_empty());
        assert_eq!((s.n_no_dbh, s.n_allometric, s.n_no_height), (0, 0, 0));
        assert_eq!(s.volume_sources, VolumeTally::default());

        let m = [metric(1, 0.0, 0.0, 0.25, 20.0)];
        let pine: HashMap<i32, String> = [(1, "pine".to_string())].into();
        let with_sp = build_trees(&m, None, None, Some(&pine), None);
        let without = build_trees(&m, None, None, None, None);
        assert_eq!(with_sp.trees[0].volume_source, VolumeSource::Laasasenaho);
        assert_eq!(without.trees[0].volume_source, VolumeSource::FormFactor);
        assert!((with_sp.trees[0].volume - without.trees[0].volume).abs() > 1e-3);
        let s = build_trees(&m, None, None, None, Some("spruce"));
        assert_eq!(s.trees[0].volume_source, VolumeSource::Laasasenaho);

        let q = qsm(vec![qsm_tree(1, 0.8, 0.7)]);
        let sp: HashMap<i32, String> = [(2, "pine".to_string())].into();
        let s = build_trees(&[metric(1, 0.0, 0.0, 0.30, 20.0), metric(2, 1.0, 0.0, 0.25, 20.0), metric(3, 2.0, 0.0, 0.25, 0.0)], Some(&q), None, Some(&sp), None);
        assert_eq!(s.volume_sources, VolumeTally { qsm: 1, laasasenaho: 1, form_factor: 0, none: 1 });
    }

    // --- strategyWeights / scoreTree / treeJitter ---

    #[test]
    fn weights_sum_to_one_and_redistribute_without_a_quality_signal() {
        for s in [Strategy::Low, Strategy::High, Strategy::Quality, Strategy::Mixed] {
            for has in [true, false] {
                let w = strategy_weights(s, has);
                assert!(close(w.qual + w.small + w.large, 1.0, 12), "{s:?}/{has}");
            }
        }
        let w = strategy_weights(Strategy::Quality, false);
        assert_eq!(w.qual, 0.0);
        assert!(close(w.small, 1.0, 12));
        let w = strategy_weights(Strategy::High, false);
        assert!(w.qual == 0.0 && w.small == 0.0 && close(w.large, 1.0, 12));
        assert_eq!(strategy_weights(Strategy::Quality, true), Weights { qual: 0.80, small: 0.20, large: 0.0 });
        assert_eq!(strategy_weights(Strategy::Low, true), Weights { qual: 0.30, small: 0.70, large: 0.0 });
        let w = strategy_weights(Strategy::Quality, false);
        assert!(JITTER_WEIGHT / (w.small + w.large) <= 0.05);
        // The size weight 'quality' used to keep: a quarter of the ordering was noise.
        let old_size_weight = strategy_weights(Strategy::Quality, true).small;
        assert!(JITTER_WEIGHT / old_size_weight > 0.2);
    }

    #[test]
    fn score_ranks_by_strategy_and_treats_an_unassessed_tree_as_unremarkable() {
        let w = strategy_weights(Strategy::Low, true);
        assert!(score_tree(&tree(1, 0.0, 0.0, 0.10, f64::NAN), &w, 0.0, 0.40) > score_tree(&tree(2, 0.0, 0.0, 0.40, f64::NAN), &w, 0.0, 0.40));
        let wh = strategy_weights(Strategy::High, true);
        assert!(score_tree(&tree(2, 0.0, 0.0, 0.40, f64::NAN), &wh, 0.0, 0.40) > score_tree(&tree(1, 0.0, 0.0, 0.10, f64::NAN), &wh, 0.0, 0.40));
        let wq = strategy_weights(Strategy::Quality, true);
        assert!(score_tree(&tree(1, 0.0, 0.0, 0.30, 0.20), &wq, 0.0, 0.40) > score_tree(&tree(2, 0.0, 0.0, 0.30, 0.95), &wq, 0.0, 0.40));
        assert!(close(score_tree(&tree(1, 0.0, 0.0, 0.30, f64::NAN), &wq, 0.0, 0.40), score_tree(&tree(2, 0.0, 0.0, 0.30, 1.0), &wq, 0.0, 0.40), 12));
        assert!(close(score_tree(&tree(1, 0.0, 0.0, 0.30, 5.0), &wq, 0.0, 0.40), score_tree(&tree(2, 0.0, 0.0, 0.30, 1.0), &wq, 0.0, 0.40), 12));
        assert!(close(score_tree(&tree(3, 0.0, 0.0, 0.30, -5.0), &wq, 0.0, 0.40), score_tree(&tree(4, 0.0, 0.0, 0.30, 0.0), &wq, 0.0, 0.40), 12));
        for s in [Strategy::Low, Strategy::High, Strategy::Quality, Strategy::Mixed] {
            let v = score_tree(&tree(1, 0.0, 0.0, 0.2, 0.5), &strategy_weights(s, true), 1.0, 0.4);
            assert!((0.0..=1.0 + JITTER_WEIGHT).contains(&v));
        }
        assert!(score_tree(&tree(1, 0.0, 0.0, 0.3, f64::NAN), &w, 0.0, 0.0).is_finite());
    }

    #[test]
    fn jitter_is_stable_bounded_and_spread() {
        assert_eq!(tree_jitter(4711), tree_jitter(4711));
        for id in [0, 1, 2, 255, 65535, 1_000_000, i32::MAX] {
            let j = tree_jitter(id);
            assert!((0.0..1.0).contains(&j), "id {id}: {j}");
        }
        let vs: Vec<f64> = (1..=200).map(tree_jitter).collect();
        let distinct: std::collections::BTreeSet<u64> = vs.iter().map(|v| v.to_bits()).collect();
        assert_eq!(distinct.len(), 200);
        let mut buckets = [0usize; 10];
        for v in &vs {
            buckets[((v * 10.0).floor() as usize).min(9)] += 1;
        }
        assert!(buckets.iter().all(|b| *b > 0));
        // The renderer's double-precision product: exact for small ids.
        assert_eq!(tree_jitter(1), 2_654_435_761.0 / 4_294_967_296.0);
    }

    // --- roads ---

    #[test]
    fn roads_are_parallel_at_the_spacing_turn_with_the_heading_and_span_the_bbox() {
        let bbox = Bbox { x_min: -50.0, y_min: -50.0, x_max: 50.0, y_max: 50.0 };
        let roads = generate_roads(bbox, 0.0, 20.0);
        assert!(roads.len() > 2);
        for r in &roads {
            assert!(close(r.y1, r.y2, 9));
        }
        let mut ys: Vec<f64> = roads.iter().map(|r| r.y1).collect();
        ys.sort_by(|a, b| a.partial_cmp(b).unwrap());
        for w in ys.windows(2) {
            assert!(close(w[1] - w[0], 20.0, 9));
        }
        assert!(ys[0] <= bbox.y_min + 20.0 && *ys.last().unwrap() >= bbox.y_max - 20.0);
        for r in generate_roads(bbox, 90.0, 20.0) {
            assert!(close(r.x1, r.x2, 9));
        }
        assert!(generate_roads(bbox, 0.0, 0.0).is_empty());
        assert!(generate_roads(bbox, 0.0, -20.0).is_empty());
        assert!(generate_roads(bbox, 0.0, f64::NAN).is_empty());
        let empty = Bbox { x_min: f64::INFINITY, y_min: f64::INFINITY, x_max: f64::NEG_INFINITY, y_max: f64::NEG_INFINITY };
        assert!(generate_roads(empty, 0.0, 20.0).is_empty());
    }

    #[test]
    fn distance_to_the_nearest_road() {
        let roads = [Road { x1: -50.0, y1: 0.0, x2: 50.0, y2: 0.0 }, Road { x1: -50.0, y1: 20.0, x2: 50.0, y2: 20.0 }];
        assert!(close(dist_to_nearest_road(0.0, 3.0, &roads), 3.0, 12));
        assert!(close(dist_to_nearest_road(0.0, 16.0, &roads), 4.0, 12));
        assert!(close(dist_to_nearest_road(0.0, 0.0, &roads), 0.0, 12));
        assert_eq!(dist_to_nearest_road(0.0, 0.0, &[]), f64::INFINITY);
        assert_eq!(dist_to_nearest_road(0.0, 5.0, &[Road { x1: 1.0, y1: 1.0, x2: 1.0, y2: 1.0 }]), f64::INFINITY);
    }

    // --- simulate ---

    /// A 100 × 100 m stand on a 3 m grid, DBH varying with position:
    /// dense enough (≈ 47 m²/ha) that an 18 m²/ha target needs real
    /// candidate thinning and not just the road corridors.
    fn stand() -> Vec<Tree> {
        let mut out = Vec::new();
        let mut id = 1;
        let mut x = -45.0;
        while x <= 45.0 {
            let mut y = -45.0;
            while y <= 45.0 {
                out.push(tree(id, x, y, 0.12 + ((id * 7) % 23) as f64 * 0.01, f64::NAN));
                id += 1;
                y += 3.0;
            }
            x += 3.0;
        }
        out
    }

    const OPT: SimulateOptions = SimulateOptions { plot_area_ha: 1.0, ..OPTS };

    fn ba_after_forced(p: &Plan) -> f64 {
        p.ba_before - p.forced.iter().map(|t| t.ba).sum::<f64>() / p.plot_area_ha
    }

    fn ids(ts: &[Tree]) -> Vec<i32> {
        let mut v: Vec<i32> = ts.iter().map(|t| t.tree_id).collect();
        v.sort();
        v
    }

    #[test]
    fn every_tree_is_in_exactly_one_class_and_the_corridor_is_forced() {
        let trees = stand();
        let p = simulate(&trees, &OPT);
        assert_eq!(p.forced.len() + p.candidates.len() + p.unreachable.len(), trees.len());
        let all: std::collections::BTreeSet<i32> = p.forced.iter().chain(&p.candidates).chain(&p.unreachable).map(|t| t.tree_id).collect();
        assert_eq!(all.len(), trees.len());
        assert!(!p.forced.is_empty());
        for t in &p.forced {
            assert!(dist_to_nearest_road(t.x, t.y, &p.roads) <= OPT.road_width * 0.5 + 1e-9);
        }
        let unreach: std::collections::BTreeSet<i32> = p.unreachable.iter().map(|t| t.tree_id).collect();
        assert!(p.removed.iter().all(|t| !unreach.contains(&t.tree_id)));
    }

    #[test]
    fn removes_down_to_the_target_overshooting_by_at_most_one_tree() {
        let trees = stand();
        let p = simulate(&trees, &OPT);
        assert!(p.ba_before > OPT.target_ba_per_ha);
        assert!(ba_after_forced(&p) > OPT.target_ba_per_ha);
        assert!(p.ba_after <= OPT.target_ba_per_ha);
        assert!(!p.cannot_reach_target);
        let max_ba = trees.iter().map(|t| t.ba).fold(0.0, f64::max);
        assert!(p.ba_after > OPT.target_ba_per_ha - max_ba / OPT.plot_area_ha);

        let p = simulate(&trees, &SimulateOptions { target_ba_per_ha: 1000.0, ..OPT });
        assert_eq!(ids(&p.removed), ids(&p.forced));

        let p = simulate(&trees, &SimulateOptions { target_ba_per_ha: 0.1, boom_reach: 2.5, ..OPT });
        assert!(p.cannot_reach_target && p.ba_after > 0.1);
    }

    #[test]
    fn the_plan_is_deterministic_and_order_independent() {
        let a = simulate(&stand(), &OPT).removed.iter().map(|t| t.tree_id).collect::<Vec<_>>();
        let b = simulate(&stand(), &OPT).removed.iter().map(|t| t.tree_id).collect::<Vec<_>>();
        assert_eq!(a, b);
        let mut rev = stand();
        rev.reverse();
        assert_eq!(ids(&simulate(&rev, &OPT).removed), ids(&simulate(&stand(), &OPT).removed));

        let same: Vec<Tree> = stand().into_iter().map(|t| Tree { dbh: 0.25, ba: std::f64::consts::PI * 0.125 * 0.125, ..t }).collect();
        let mut same_rev = same.clone();
        same_rev.reverse();
        assert_eq!(ids(&simulate(&same_rev, &OPT).removed), ids(&simulate(&same, &OPT).removed));
    }

    fn mean_dbh(ts: &[&Tree]) -> f64 {
        ts.iter().map(|t| t.dbh).sum::<f64>() / ts.len() as f64
    }

    #[test]
    fn low_takes_the_small_stems_high_the_large_and_quality_without_qsm_sorts_by_size() {
        for (strategy, small_first) in [(Strategy::Low, true), (Strategy::High, false), (Strategy::Quality, true)] {
            let p = simulate(&stand(), &SimulateOptions { strategy, ..OPT });
            let forced: std::collections::BTreeSet<i32> = p.forced.iter().map(|t| t.tree_id).collect();
            let sel: Vec<&Tree> = p.removed.iter().filter(|t| !forced.contains(&t.tree_id)).collect();
            let sel_ids: std::collections::BTreeSet<i32> = sel.iter().map(|t| t.tree_id).collect();
            let kept: Vec<&Tree> = p.candidates.iter().filter(|t| !sel_ids.contains(&t.tree_id)).collect();
            assert!(!sel.is_empty() && !kept.is_empty(), "{strategy:?}");
            if small_first {
                assert!(mean_dbh(&sel) < mean_dbh(&kept), "{strategy:?}");
            } else {
                assert!(mean_dbh(&sel) > mean_dbh(&kept), "{strategy:?}");
            }
        }
        assert!(!simulate(&stand(), &OPT).quality_available);
        let with_qsm: Vec<Tree> = stand().into_iter().enumerate().map(|(i, t)| Tree { confidence: if i % 2 == 1 { 0.4 } else { 0.9 }, ..t }).collect();
        assert!(simulate(&with_qsm, &OPT).quality_available);
    }

    #[test]
    fn empty_stand_zero_area_and_a_tree_with_no_position() {
        let p = simulate(&[], &OPT);
        assert!(p.removed.is_empty() && p.roads.is_empty());
        assert_eq!((p.ba_before, p.ba_after), (0.0, 0.0));

        let p = simulate(&stand(), &SimulateOptions { plot_area_ha: 0.0, ..OPT });
        assert!(p.ba_before.is_finite() && p.ba_after.is_finite());

        let lost = tree(9999, f64::NAN, f64::NAN, 0.3, f64::NAN);
        let mut with_lost = stand();
        with_lost.push(lost.clone());
        let p = simulate(&with_lost, &OPT);
        let r = simulate(&stand(), &OPT);
        assert_eq!(p.roads.len(), r.roads.len());
        assert!(p.unreachable.iter().any(|t| t.tree_id == 9999));
        assert!(!p.removed.iter().any(|t| t.tree_id == 9999));
        assert!(close(p.ba_before, r.ba_before + lost.ba / OPT.plot_area_ha, 10));
    }

    #[test]
    fn accounts_for_every_removed_tree_exactly_once() {
        let p = simulate(&stand(), &OPT);
        let distinct: std::collections::BTreeSet<i32> = p.removed.iter().map(|t| t.tree_id).collect();
        assert_eq!(distinct.len(), p.removed.len());
        let ba_sum: f64 = p.removed.iter().map(|t| t.ba).sum();
        assert!(close(p.ba_before - ba_sum / p.plot_area_ha, p.ba_after, 10));
    }

    // --- the operation's own pieces ---

    #[test]
    fn the_csv_is_the_panels_columns_with_blanks_for_the_unmeasured() {
        let removed = vec![
            RemovedTree { reason: RemovalReason::Road, tree: tree(7, 1.234, 5.678, 0.3, f64::NAN) },
            RemovedTree { reason: RemovalReason::Selected, tree: Tree { volume_source: VolumeSource::Qsm, confidence: 0.75, ..tree(8, 0.0, 0.0, 0.25, 0.75) } },
        ];
        let csv = removed_csv(&removed);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "tree_id,reason,x,y,dbh_cm,height_m,ba_m2,volume_m3,volume_source,confidence");
        assert_eq!(lines[1], format!("7,road,1.23,5.68,30.0,20.0,{:.4},0.5000,formFactor,", g(0.3)));
        assert_eq!(lines[2], format!("8,selected,0.00,0.00,25.0,20.0,{:.4},0.5000,qsm,0.750", g(0.25)));
    }

    #[test]
    fn plot_area_comes_from_the_given_figure_the_boundary_or_the_bbox() {
        let xy = [[0.0, 0.0], [20.0, 0.0], [0.0, 10.0]];
        assert_eq!(resolve_plot_area(Some(0.5), "{}", &xy).unwrap(), (0.5, AreaBasis::Manual));
        assert!(resolve_plot_area(Some(0.0), "{}", &xy).is_err());
        let (a, basis) = resolve_plot_area(None, r#"{"kind":"rectangular","min":[0,0],"max":[20,20]}"#, &xy).unwrap();
        assert!(close(a, 0.04, 12));
        assert_eq!(basis, AreaBasis::Boundary);
        assert_eq!(resolve_plot_area(None, "{}", &xy).unwrap(), (0.02, AreaBasis::Bbox));
        assert_eq!(resolve_plot_area(None, "", &[[1.0, 1.0]]).unwrap(), (0.0025, AreaBasis::Bbox));
        assert!(resolve_plot_area(None, "", &[]).unwrap_err().contains("plotAreaHa"));
        assert_eq!(normalise_currency("  ").unwrap(), "€");
        assert_eq!(normalise_currency(" CLP ").unwrap(), "CLP");
        assert!(normalise_currency("a paragraph").is_err());
    }

    #[test]
    fn the_operation_is_catalogued_and_refuses_bad_parameters_first() {
        let op = super::super::find("metrics.thinning").expect("metrics.thinning");
        assert!(!op.mutates);
        let schema = op.params_schema();
        assert_eq!(schema["properties"]["targetBaPerHa"]["default"], 18.0);
        assert_eq!(schema["properties"]["strategy"]["default"], "low");
        assert_eq!(schema["properties"]["currency"]["default"], "€");
        let ctx = OpContext::silent();
        let run = |v: serde_json::Value| super::super::run("metrics.thinning", v, &ctx).unwrap_err();
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "roadSpacing": 0 })).contains("roadSpacing"));
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "targetBaPerHa": -1 })).contains("targetBaPerHa"));
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "strategy": "sideways" })).contains("invalid parameters"));
        assert!(run(serde_json::json!({ "octreeDir": "/nowhere", "currency": "far too long a currency" })).contains("currency"));
    }
}
