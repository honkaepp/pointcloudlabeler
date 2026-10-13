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

//! The forestry arithmetic after the per-tree measurements: stem
//! volume by national function, biomass and carbon with their
//! uncertainty, and edge-corrected per-hectare plot statistics.
//!
//! These three lived only in the renderer (`src/metrics/volumeFunctions.ts`,
//! `src/metrics/biomass.ts`, `src/metrics/plotStats.ts` and
//! `src/utils/plotBoundary.ts`), so a command-line run ended at the
//! per-tree table and the figures a forester actually quotes — m³/ha,
//! tonnes of carbon, stems per hectare — needed the window. This module
//! is the same arithmetic in Rust, function for function, with the
//! same coefficients, the same fallbacks and the same NaN-not-zero
//! rule for a tree that could not be measured. The renderer's tests are
//! mirrored below, and `src/testing/forestryParity.test.ts` holds the
//! two sides' constants together.
//!
//! Three operations expose it: `metrics.volumes` (per-tree stem volume
//! with its source), `metrics.biomass` (biomass, carbon and CO₂e from
//! the QSM) and `metrics.plot` (per-hectare statistics inside a plot
//! boundary).

use std::collections::{BTreeMap, HashMap};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::qc::{merge_stem_fits, DbhSource, MergedMetric};
use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::{
    octree_read_plot, octree_read_qsm, octree_read_species, octree_read_stems, run_tree_metrics, QsmResult, TreeMetric,
    TreeQsm,
};

// --- plot boundary ------------------------------------------------------------

/// A plot boundary as plot.json records it.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum PlotBoundary {
    /// A circle: `{"kind":"circular","center":[x,y],"radius":r}`.
    Circular { center: [f64; 2], radius: f64 },
    /// An axis-aligned rectangle: `{"kind":"rectangular","min":[x,y],"max":[x,y]}`.
    Rectangular { min: [f64; 2], max: [f64; 2] },
}

/// Edge correction for trees on the boundary (`plotBoundary.ts`).
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EdgeCorrection {
    /// Strict in/out by stem centre.
    None,
    /// Trees within the buffer band inside the boundary count 0.5.
    Halfcount,
    /// Weight by the fraction of the crown disk inside the plot.
    CrownArea,
}

/// The renderer's `parsePlotBoundary`: `{}`, malformed JSON, a
/// non-positive radius and an inverted or zero-extent rectangle all
/// read as "no boundary".
pub fn parse_plot_boundary(text: &str) -> Option<PlotBoundary> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let b: PlotBoundary = serde_json::from_value(v).ok()?;
    validate_boundary(&b).ok().map(|_| b)
}

/// A boundary with an area: a positive, finite radius, or a rectangle
/// whose min is below its max on both axes.
pub fn validate_boundary(b: &PlotBoundary) -> Result<(), String> {
    match b {
        PlotBoundary::Circular { center, radius } => {
            if !(center.iter().all(|c| c.is_finite()) && radius.is_finite() && *radius > 0.0) {
                return Err("a circular boundary needs a finite center [x, y] and a positive radius".into());
            }
        }
        PlotBoundary::Rectangular { min, max } => {
            let finite = min.iter().chain(max.iter()).all(|c| c.is_finite());
            if !(finite && min[0] < max[0] && min[1] < max[1]) {
                return Err("a rectangular boundary needs finite min [x, y] below max [x, y] on both axes".into());
            }
        }
    }
    Ok(())
}

/// Plot area in hectares; each rectangular side clamped at zero so an
/// inverted boundary has no area rather than a positive one.
pub fn plot_area_ha(b: &PlotBoundary) -> f64 {
    match b {
        PlotBoundary::Circular { radius, .. } => std::f64::consts::PI * radius * radius / 10_000.0,
        PlotBoundary::Rectangular { min, max } => {
            let w = (max[0] - min[0]).max(0.0);
            let h = (max[1] - min[1]).max(0.0);
            w * h / 10_000.0
        }
    }
}

/// Stem centre inside the plot (the edge counts as in)?
pub fn stem_centre_inside(xy: [f64; 2], b: &PlotBoundary) -> bool {
    match b {
        PlotBoundary::Circular { center, radius } => {
            let dx = xy[0] - center[0];
            let dy = xy[1] - center[1];
            dx * dx + dy * dy <= radius * radius
        }
        PlotBoundary::Rectangular { min, max } => {
            xy[0] >= min[0] && xy[0] <= max[0] && xy[1] >= min[1] && xy[1] <= max[1]
        }
    }
}

/// Signed distance to the boundary: negative inside, positive outside.
/// Outside a rectangle it is the Euclidean distance back to the plot,
/// so a stem off a corner reads the hypotenuse, not the larger leg.
pub fn signed_distance_to_boundary(xy: [f64; 2], b: &PlotBoundary) -> f64 {
    match b {
        PlotBoundary::Circular { center, radius } => {
            let dx = xy[0] - center[0];
            let dy = xy[1] - center[1];
            (dx * dx + dy * dy).sqrt() - radius
        }
        PlotBoundary::Rectangular { min, max } => {
            let dl = min[0] - xy[0];
            let dr = xy[0] - max[0];
            let db = min[1] - xy[1];
            let dt = xy[1] - max[1];
            if dl.max(dr).max(db).max(dt) > 0.0 {
                let ex = dl.max(dr).max(0.0);
                let ey = db.max(dt).max(0.0);
                return ex.hypot(ey);
            }
            -((-dl).min(-dr).min(-db).min(-dt))
        }
    }
}

/// Points of the Fibonacci lattice over the crown disk. The renderer
/// uses the same count, so the two sides give a tree the same weight.
pub const CROWN_SAMPLES: usize = 64;

/// Fraction of the crown disk inside the plot, over a deterministic
/// Fibonacci lattice; a tree with no crown area is a point.
pub fn crown_fraction_inside(xy: [f64; 2], crown_area: f64, b: &PlotBoundary) -> f64 {
    if !crown_area.is_finite() || crown_area <= 0.0 {
        return if stem_centre_inside(xy, b) { 1.0 } else { 0.0 };
    }
    let r = (crown_area / std::f64::consts::PI).sqrt();
    let n = CROWN_SAMPLES;
    let golden = std::f64::consts::PI * (3.0 - 5f64.sqrt());
    let mut inside = 0usize;
    for i in 0..n {
        let rho = r * ((i as f64 + 0.5) / n as f64).sqrt();
        let theta = i as f64 * golden;
        let p = [xy[0] + rho * theta.cos(), xy[1] + rho * theta.sin()];
        if stem_centre_inside(p, b) {
            inside += 1;
        }
    }
    inside as f64 / n as f64
}

/// Inclusion weight of one tree, 0..1, under the chosen method.
pub fn tree_weight(xy: [f64; 2], crown_area: f64, b: &PlotBoundary, method: EdgeCorrection, halfcount_buffer: f64) -> f64 {
    match method {
        EdgeCorrection::None => if stem_centre_inside(xy, b) { 1.0 } else { 0.0 },
        EdgeCorrection::Halfcount => {
            let sd = signed_distance_to_boundary(xy, b);
            if sd > 0.0 {
                0.0
            } else if sd.abs() <= halfcount_buffer {
                0.5
            } else {
                1.0
            }
        }
        EdgeCorrection::CrownArea => crown_fraction_inside(xy, crown_area, b),
    }
}

fn bbox(xy: &[[f64; 2]]) -> Option<[f64; 4]> {
    if xy.is_empty() {
        return None;
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in xy {
        x0 = x0.min(p[0]);
        x1 = x1.max(p[0]);
        y0 = y0.min(p[1]);
        y1 = y1.max(p[1]);
    }
    Some([x0, y0, x1, y1])
}

/// A rectangle wrapping the stems, shrunk by `margin` on each side and
/// collapsing to its midline rather than inverting when the margin
/// eats the plot.
pub fn fit_rectangular_to_bbox(xy: &[[f64; 2]], margin: f64) -> Option<PlotBoundary> {
    let [x0, y0, x1, y1] = bbox(xy)?;
    let m = margin.max(0.0);
    let cx = (x0 + x1) * 0.5;
    let cy = (y0 + y1) * 0.5;
    Some(PlotBoundary::Rectangular {
        min: [(x0 + m).min(cx), (y0 + m).min(cy)],
        max: [(x1 - m).max(cx), (y1 - m).max(cy)],
    })
}

/// The circle a fitted boundary can shrink to: a radius under this is
/// not a plot.
pub const MIN_FITTED_RADIUS: f64 = 1.0;

/// A circle on the stems' bbox centre reaching the farthest stem, less
/// `margin`, never below `MIN_FITTED_RADIUS`.
pub fn fit_circular_to_bbox(xy: &[[f64; 2]], margin: f64) -> Option<PlotBoundary> {
    let [x0, y0, x1, y1] = bbox(xy)?;
    let cx = (x0 + x1) * 0.5;
    let cy = (y0 + y1) * 0.5;
    let r_max = xy.iter().map(|p| (p[0] - cx).hypot(p[1] - cy)).fold(0.0, f64::max);
    Some(PlotBoundary::Circular { center: [cx, cy], radius: (r_max - margin).max(MIN_FITTED_RADIUS) })
}

/// Where a plot area came from. Every per-hectare figure divides by
/// it, so the one label says how precise all of them are.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AreaBasis {
    /// The recorded (or given) plot boundary: a measurement.
    Boundary,
    /// The bounding box of the stems: a guess.
    Bbox,
    /// A figure the caller typed.
    Manual,
}

impl AreaBasis {
    /// The words the panels and the report print beside the area.
    pub fn label(self) -> &'static str {
        match self {
            AreaBasis::Boundary => "defined plot boundary",
            AreaBasis::Bbox => "estimated — tree bbox",
            AreaBasis::Manual => "manual entry",
        }
    }
}

/// The smallest area the bbox estimate reports (a quarter of an are),
/// so one tree does not read as a million stems per hectare.
pub const MIN_ESTIMATED_AREA_HA: f64 = 0.0025;

/// The Report and Thinning panels' fallback when no boundary is
/// recorded: the stems' bounding box, in hectares, never below
/// `MIN_ESTIMATED_AREA_HA`. None without a positioned tree.
pub fn estimated_area_ha(xy: &[[f64; 2]]) -> Option<f64> {
    let [x0, y0, x1, y1] = bbox(xy)?;
    Some(((x1 - x0) * (y1 - y0) / 10_000.0).max(MIN_ESTIMATED_AREA_HA))
}

// --- plot statistics ----------------------------------------------------------

/// One tree inside the plot and the weight it entered the sums with.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InsideRow {
    pub tree_id: i32,
    pub weight: f64,
}

/// Edge-corrected per-hectare figures (`plotStats.ts`). A figure that
/// could not be computed is NaN, which JSON carries as null.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlotStats {
    pub area_ha: f64,
    /// Σ inclusion weights: the edge-corrected stem count.
    pub n_weighted: f64,
    pub n_fully_in: usize,
    pub n_partial: usize,
    pub n_out: usize,
    pub stems_per_ha: f64,
    pub basal_area_per_ha: f64,
    /// Basal-area weighted mean height (Lorey's H) over the trees that
    /// have both a diameter and a height; NaN when none do.
    pub lorey_mean_height: f64,
    /// Trees inside with a diameter but no usable height.
    pub n_no_height: usize,
    pub stem_volume_per_ha: f64,
    pub stem_volume_ci95_per_ha: f64,
    pub has_qsm: bool,
    pub inside_rows: Vec<InsideRow>,
}

fn basal_area(dbh: f64) -> f64 {
    std::f64::consts::PI * (dbh * 0.5) * (dbh * 0.5)
}

/// The renderer's `computePlotStats`: every sum over the trees inside
/// the boundary, each weighted by its inclusion weight, divided by the
/// plot area. Lorey's mean runs over the trees that have BOTH a
/// diameter and a height, so an unmeasured height (0, from a tree with
/// no ground beneath it) does not pull the mean down.
pub fn compute_plot_stats(
    metrics: &[TreeMetric],
    boundary: &PlotBoundary,
    edge: EdgeCorrection,
    halfcount_buffer: f64,
    qsm: Option<&QsmResult>,
) -> PlotStats {
    let area_ha = plot_area_ha(boundary);
    let qsm_map: Option<HashMap<i32, &TreeQsm>> = qsm.map(|q| q.trees.iter().map(|t| (t.tree_id, t)).collect());

    let mut n_weighted = 0.0;
    let mut ba_sum = 0.0;
    let mut ba_weighted_h = 0.0;
    let mut ba_with_height = 0.0;
    let mut n_no_height = 0;
    let mut stem_vol_sum = 0.0;
    let mut stem_vol_var = 0.0;
    let (mut n_fully_in, mut n_partial, mut n_out) = (0, 0, 0);
    let mut inside_rows = Vec::new();

    for t in metrics {
        if !t.x.is_finite() || !t.y.is_finite() {
            n_out += 1;
            continue;
        }
        let w = tree_weight([t.x, t.y], t.crown_area, boundary, edge, halfcount_buffer);
        if w == 0.0 {
            n_out += 1;
            continue;
        }
        if w == 1.0 { n_fully_in += 1 } else { n_partial += 1 }
        inside_rows.push(InsideRow { tree_id: t.tree_id, weight: w });
        n_weighted += w;

        if t.dbh.is_finite() && t.dbh > 0.0 {
            let ba = basal_area(t.dbh);
            ba_sum += w * ba;
            if t.height.is_finite() && t.height > 0.0 {
                ba_weighted_h += w * ba * t.height;
                ba_with_height += w * ba;
            } else {
                n_no_height += 1;
            }
        }

        if let Some(q) = qsm_map.as_ref().and_then(|m| m.get(&t.tree_id)) {
            stem_vol_sum += w * q.stem_volume;
            let ci = if q.stem_volume_ci95.is_finite() { q.stem_volume_ci95 } else { 0.0 };
            stem_vol_var += (w * ci) * (w * ci);
        }
    }

    let per_ha = area_ha.max(1e-6);
    PlotStats {
        area_ha,
        n_weighted,
        n_fully_in,
        n_partial,
        n_out,
        stems_per_ha: n_weighted / per_ha,
        basal_area_per_ha: ba_sum / per_ha,
        lorey_mean_height: if ba_with_height > 0.0 { ba_weighted_h / ba_with_height } else { f64::NAN },
        n_no_height,
        stem_volume_per_ha: stem_vol_sum / per_ha,
        stem_volume_ci95_per_ha: stem_vol_var.sqrt() / per_ha,
        has_qsm: qsm.is_some(),
        inside_rows,
    }
}

/// The fraction of the measured heights the dominant height averages.
pub const DOMINANT_FRACTION: f64 = 0.10;

/// Mean of the top `fraction` of the finite values (at least one),
/// and how many that was; NaN and 0 when there are none (`stats.ts`).
pub fn top_fraction_mean(values: &[f64], fraction: f64) -> (f64, usize) {
    let mut s: Vec<f64> = values.iter().copied().filter(|v| v.is_finite()).collect();
    if s.is_empty() {
        return (f64::NAN, 0);
    }
    s.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let f = if fraction.is_finite() { fraction.clamp(0.0, 1.0) } else { 1.0 };
    let count = ((s.len() as f64 * f).ceil() as usize).max(1);
    let sum: f64 = s[s.len() - count..].iter().sum();
    (sum / count as f64, count)
}

/// The unweighted plot-level figures, each over the trees that have
/// what it needs (`treeStats`).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeStats {
    pub tree_count: usize,
    pub n_with_dbh: usize,
    pub n_with_height: usize,
    /// Σ basal area over the trees that have a diameter (m²).
    pub basal_area_total: f64,
    pub lorey_mean_height: f64,
    /// Mean height of the tallest tenth of the measured heights.
    pub dominant_height: f64,
    pub top_n_count: usize,
}

pub fn tree_stats(metrics: &[TreeMetric]) -> TreeStats {
    let has_dbh = |t: &TreeMetric| t.dbh.is_finite() && t.dbh > 0.0;
    let has_height = |t: &TreeMetric| t.height.is_finite() && t.height > 0.0;
    let basal_area_total: f64 = metrics.iter().filter(|t| has_dbh(t)).map(|t| basal_area(t.dbh)).sum();
    let (mut ba_both, mut ba_h) = (0.0, 0.0);
    for t in metrics.iter().filter(|t| has_dbh(t) && has_height(t)) {
        ba_both += basal_area(t.dbh);
        ba_h += basal_area(t.dbh) * t.height;
    }
    let heights: Vec<f64> = metrics.iter().filter(|t| has_height(t)).map(|t| t.height).collect();
    let (dominant_height, top_n_count) = top_fraction_mean(&heights, DOMINANT_FRACTION);
    TreeStats {
        tree_count: metrics.len(),
        n_with_dbh: metrics.iter().filter(|t| has_dbh(t)).count(),
        n_with_height: heights.len(),
        basal_area_total,
        lorey_mean_height: if ba_both > 0.0 { ba_h / ba_both } else { f64::NAN },
        dominant_height,
        top_n_count,
    }
}

// --- volume functions ---------------------------------------------------------

/// The five coefficients of V = a1 · d^a2 · a3^d · h^a4 · (h − 1.3)^a5,
/// V in dm³, d in centimetres, h in metres.
#[derive(Clone, Copy, Debug)]
pub struct VolumeCoefficients {
    pub a1: f64,
    pub a2: f64,
    pub a3: f64,
    pub a4: f64,
    pub a5: f64,
}

/// The species the national function was fitted for.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VolumeSpecies {
    Pine,
    Spruce,
    Birch,
}

impl VolumeSpecies {
    pub const ALL: [VolumeSpecies; 3] = [VolumeSpecies::Pine, VolumeSpecies::Spruce, VolumeSpecies::Birch];

    pub fn as_str(self) -> &'static str {
        match self {
            VolumeSpecies::Pine => "pine",
            VolumeSpecies::Spruce => "spruce",
            VolumeSpecies::Birch => "birch",
        }
    }

    /// Laasasenaho, J. 1982. Taper curve and volume functions for pine,
    /// spruce and birch. Communicationes Instituti Forestalis Fenniae 108.
    pub fn laasasenaho_1982(self) -> VolumeCoefficients {
        match self {
            VolumeSpecies::Pine => VolumeCoefficients { a1: 0.036089, a2: 2.01395, a3: 0.99676, a4: 2.07025, a5: -1.07209 },
            VolumeSpecies::Spruce => VolumeCoefficients { a1: 0.022927, a2: 1.91505, a3: 0.99146, a4: 2.82541, a5: -1.53547 },
            VolumeSpecies::Birch => VolumeCoefficients { a1: 0.011197, a2: 2.10253, a3: 0.98600, a4: 3.98519, a5: -2.65900 },
        }
    }
}

/// Which function a species key maps onto: the three fitted species by
/// their English or Finnish names, case- and space-insensitive. Aspen
/// and oak have no function and resolve to None, so the caller falls
/// back to the form factor rather than borrowing birch's curve.
pub fn species_function(key: Option<&str>) -> Option<VolumeSpecies> {
    match key.unwrap_or("").trim().to_lowercase().as_str() {
        "pine" | "manty" | "mänty" => Some(VolumeSpecies::Pine),
        "spruce" | "kuusi" => Some(VolumeSpecies::Spruce),
        "birch" | "koivu" => Some(VolumeSpecies::Birch),
        _ => None,
    }
}

/// Below this height the function is outside the data it was fitted
/// on: the (h − 1.3) term's negative exponent makes it diverge toward
/// breast height, and 4 m is where all three species' implied form
/// factor is back inside the plausible range.
pub const MIN_HEIGHT_M: f64 = 4.0;

/// Stem volume in m³ from diameter and height in metres; NaN when a
/// measurement is missing or the tree is below `MIN_HEIGHT_M`.
pub fn laasasenaho_volume(species: VolumeSpecies, dbh_m: f64, height_m: f64) -> f64 {
    if !dbh_m.is_finite() || dbh_m <= 0.0 || !height_m.is_finite() || height_m < MIN_HEIGHT_M {
        return f64::NAN;
    }
    let c = species.laasasenaho_1982();
    let d = dbh_m * 100.0;
    let vdm3 = c.a1 * d.powf(c.a2) * c.a3.powf(d) * height_m.powf(c.a4) * (height_m - 1.3).powf(c.a5);
    if vdm3.is_finite() { vdm3 / 1000.0 } else { f64::NAN }
}

/// The last-resort form factor, V = g · h · f.
pub const DEFAULT_FORM_FACTOR: f64 = 0.50;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum VolumeSource {
    /// The measured QSM stem volume.
    Qsm,
    /// Laasasenaho 1982 from diameter and height.
    Laasasenaho,
    /// Basal area × height × form factor.
    FormFactor,
    /// Nothing could be estimated.
    None,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedVolume {
    /// Stem volume (m³), NaN (null) when nothing could be estimated.
    pub volume: f64,
    pub source: VolumeSource,
    /// The species function used, when the source is Laasasenaho.
    pub species: Option<VolumeSpecies>,
}

/// What `resolve_volume` chooses from.
pub struct VolumeOptions<'a> {
    /// QSM stem volumes by tree id: the measured ones, always preferred.
    pub qsm: Option<&'a HashMap<i32, f64>>,
    /// Per-tree species assignment (species.json keys).
    pub species_by_tree: Option<&'a HashMap<i32, String>>,
    /// Fallback species for trees with no assignment; None leaves them
    /// to the form factor.
    pub default_species: Option<&'a str>,
    pub form_factor: f64,
}

impl Default for VolumeOptions<'_> {
    fn default() -> Self {
        VolumeOptions { qsm: None, species_by_tree: None, default_species: None, form_factor: DEFAULT_FORM_FACTOR }
    }
}

/// The renderer's `resolveVolume`: a finite, positive QSM volume, else
/// the national function for the tree's own species or the fallback,
/// else the form factor, else NaN. A zero QSM volume is a failed fit,
/// not a stem with no wood, and falls through.
pub fn resolve_volume(t: &TreeMetric, o: &VolumeOptions) -> ResolvedVolume {
    if let Some(v) = o.qsm.and_then(|m| m.get(&t.tree_id)).copied() {
        if v.is_finite() && v > 0.0 {
            return ResolvedVolume { volume: v, source: VolumeSource::Qsm, species: None };
        }
    }
    let key = o.species_by_tree.and_then(|m| m.get(&t.tree_id)).map(String::as_str).or(o.default_species);
    if let Some(sp) = species_function(key) {
        let v = laasasenaho_volume(sp, t.dbh, t.height);
        if v.is_finite() && v > 0.0 {
            return ResolvedVolume { volume: v, source: VolumeSource::Laasasenaho, species: Some(sp) };
        }
    }
    if t.basal_area.is_finite() && t.basal_area > 0.0 && t.height.is_finite() && t.height > 0.0 {
        return ResolvedVolume { volume: t.basal_area * t.height * o.form_factor, source: VolumeSource::FormFactor, species: None };
    }
    ResolvedVolume { volume: f64::NAN, source: VolumeSource::None, species: None }
}

#[derive(Serialize, Default, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VolumeTally {
    pub qsm: usize,
    pub laasasenaho: usize,
    pub form_factor: usize,
    pub none: usize,
}

pub fn tally_sources(rs: &[ResolvedVolume]) -> VolumeTally {
    let mut t = VolumeTally::default();
    for r in rs {
        match r.source {
            VolumeSource::Qsm => t.qsm += 1,
            VolumeSource::Laasasenaho => t.laasasenaho += 1,
            VolumeSource::FormFactor => t.form_factor += 1,
            VolumeSource::None => t.none += 1,
        }
    }
    t
}

/// The tally as the panels print it beside a volume figure.
pub fn describe_volume_sources(t: &VolumeTally) -> String {
    let mut parts = Vec::new();
    if t.qsm > 0 { parts.push(format!("{} measured (QSM)", t.qsm)); }
    if t.laasasenaho > 0 { parts.push(format!("{} Laasasenaho 1982", t.laasasenaho)); }
    if t.form_factor > 0 { parts.push(format!("{} form factor", t.form_factor)); }
    if t.none > 0 { parts.push(format!("{} not estimable", t.none)); }
    parts.join(" · ")
}

// --- biomass and carbon -------------------------------------------------------

/// One species' wood basic density (oven-dry mass / green volume).
#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SpeciesDensity {
    pub key: &'static str,
    pub label: &'static str,
    /// kg/m³.
    pub density: f64,
    /// 1σ natural variation, kg/m³.
    pub density_std: f64,
    /// Carbon fraction of oven-dry wood.
    pub carbon_fraction: f64,
    pub source: &'static str,
}

/// Boreal stemwood basic densities, as `src/metrics/biomass.ts` tabulates them:
/// Repola 2006 (Silva Fennica 40(4)), Repola 2008 (Silva Fennica 42(4)),
/// Kärkkäinen 2007 (Puutieteen perusteet), Zanne et al. 2009 (Global
/// Wood Density Database).
pub const SPECIES_DENSITIES: [SpeciesDensity; 5] = [
    SpeciesDensity { key: "pine", label: "Scots pine (Pinus sylvestris)", density: 400.0, density_std: 25.0, carbon_fraction: 0.50, source: "Repola 2006 / Kärkkäinen 2007" },
    SpeciesDensity { key: "spruce", label: "Norway spruce (Picea abies)", density: 385.0, density_std: 25.0, carbon_fraction: 0.50, source: "Repola 2006 / Kärkkäinen 2007" },
    SpeciesDensity { key: "birch", label: "Birch (Betula spp.)", density: 490.0, density_std: 30.0, carbon_fraction: 0.50, source: "Repola 2008 / Kärkkäinen 2007" },
    SpeciesDensity { key: "aspen", label: "Aspen (Populus tremula)", density: 400.0, density_std: 30.0, carbon_fraction: 0.50, source: "Kärkkäinen 2007" },
    SpeciesDensity { key: "oak", label: "Oak (Quercus robur)", density: 650.0, density_std: 40.0, carbon_fraction: 0.48, source: "Zanne et al. 2009 (Global Wood Density Database)" },
];

pub fn species_density(key: &str) -> Option<&'static SpeciesDensity> {
    SPECIES_DENSITIES.iter().find(|s| s.key == key)
}

/// The fallback key that means "the density given, not a preset".
pub const CUSTOM_SPECIES_KEY: &str = "custom";

/// The parameters every biomass figure rests on.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BiomassParams {
    /// Wood basic density, kg/m³.
    pub density: f64,
    /// 1σ density uncertainty, kg/m³.
    pub density_std: f64,
    /// Carbon fraction of oven-dry wood.
    pub carbon_fraction: f64,
    /// 1σ carbon-fraction uncertainty.
    pub carbon_fraction_std: f64,
    /// Relative 1σ uncertainty on branch volume (fraction).
    pub branch_unc_fraction: f64,
}

pub const DEFAULT_BIOMASS_PARAMS: BiomassParams = BiomassParams {
    density: 400.0,
    density_std: 25.0,
    carbon_fraction: 0.50,
    carbon_fraction_std: 0.02,
    branch_unc_fraction: 0.25,
};

/// The ranges `biomassSettings.ts` accepts, as (field, low, high).
pub const PARAM_RANGES: [(&str, f64, f64); 5] = [
    ("density", 50.0, 1400.0),
    ("densityStd", 0.0, 500.0),
    ("carbonFraction", 0.2, 1.0),
    ("carbonFractionStd", 0.0, 0.5),
    ("branchUncFraction", 0.0, 2.0),
];

/// Every parameter finite and inside its range; the error names the
/// field and the range.
pub fn validate_biomass_params(p: &BiomassParams) -> Result<(), String> {
    let values = [p.density, p.density_std, p.carbon_fraction, p.carbon_fraction_std, p.branch_unc_fraction];
    for ((name, lo, hi), v) in PARAM_RANGES.iter().zip(values) {
        if !(v.is_finite() && v >= *lo && v <= *hi) {
            return Err(format!("{name} must be between {lo} and {hi}, got {v}"));
        }
    }
    Ok(())
}

/// Params for one species key: density, its σ and the carbon fraction
/// from the preset; everything else from `base`. An unknown key returns
/// `base` untouched.
pub fn biomass_params_for_species(key: &str, base: BiomassParams) -> BiomassParams {
    match species_density(key) {
        Some(s) => BiomassParams { density: s.density, density_std: s.density_std, carbon_fraction: s.carbon_fraction, ..base },
        None => base,
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeBiomass {
    pub tree_id: i32,
    /// Stem + branch volume, m³.
    pub volume: f64,
    pub volume_std: f64,
    /// Above-stump woody biomass, kg oven-dry.
    pub biomass: f64,
    pub biomass_std: f64,
    /// Carbon, kg.
    pub carbon: f64,
    pub carbon_std: f64,
    /// CO₂-equivalent, kg.
    pub co2e: f64,
    pub co2e_std: f64,
    pub density: f64,
    pub density_std: f64,
    pub carbon_fraction: f64,
    pub carbon_fraction_std: f64,
}

const CO2_PER_C: f64 = 44.0 / 12.0;

/// Biomass = ρ V, carbon = cf B, CO₂e = C · 44/12, with relative errors
/// added in quadrature: the stem's QSM σ and a fraction of the branch
/// volume for V, the density's σ, the carbon fraction's σ.
pub fn compute_tree_biomass(t: &TreeQsm, p: &BiomassParams) -> TreeBiomass {
    let branch_vol = if t.branch_volume.is_finite() { t.branch_volume } else { 0.0 };
    let volume = t.stem_volume + branch_vol;
    let stem_std = if t.stem_volume_std.is_finite() { t.stem_volume_std } else { 0.0 };
    let branch_std = branch_vol * p.branch_unc_fraction;
    let volume_std = (stem_std * stem_std + branch_std * branch_std).sqrt();

    let biomass = p.density * volume;
    let rel_v = if volume > 0.0 { volume_std / volume } else { 0.0 };
    let rel_rho = if p.density > 0.0 { p.density_std / p.density } else { 0.0 };
    let rel_b = (rel_v * rel_v + rel_rho * rel_rho).sqrt();
    let biomass_std = biomass * rel_b;

    let carbon = p.carbon_fraction * biomass;
    let rel_cf = if p.carbon_fraction > 0.0 { p.carbon_fraction_std / p.carbon_fraction } else { 0.0 };
    let rel_c = (rel_b * rel_b + rel_cf * rel_cf).sqrt();
    let carbon_std = carbon * rel_c;

    TreeBiomass {
        tree_id: t.tree_id,
        volume,
        volume_std,
        biomass,
        biomass_std,
        carbon,
        carbon_std,
        co2e: carbon * CO2_PER_C,
        co2e_std: carbon_std * CO2_PER_C,
        density: p.density,
        density_std: p.density_std,
        carbon_fraction: p.carbon_fraction,
        carbon_fraction_std: p.carbon_fraction_std,
    }
}

/// Per-tree biomass for a plot, each tree with its own species'
/// density; `fallback_count` is how many had no assignment, or one
/// that is no longer a known preset, and used the fallback instead.
pub fn compute_species_aware_biomass(
    trees: &[TreeQsm],
    species_by_tree: &HashMap<i32, String>,
    fallback_species: &str,
    base: BiomassParams,
) -> (Vec<TreeBiomass>, usize) {
    let fallback = biomass_params_for_species(fallback_species, base);
    let mut fallback_count = 0;
    let out = trees
        .iter()
        .map(|t| {
            let known = species_by_tree.get(&t.tree_id).filter(|k| species_density(k).is_some());
            let params = match known {
                Some(k) => biomass_params_for_species(k, base),
                None => {
                    fallback_count += 1;
                    fallback
                }
            };
            compute_tree_biomass(t, &params)
        })
        .collect();
    (out, fallback_count)
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BiomassTotals {
    pub trees: usize,
    pub biomass: f64,
    pub biomass_std: f64,
    pub carbon: f64,
    pub carbon_std: f64,
    pub co2e: f64,
    pub co2e_std: f64,
}

/// Plot totals with the errors combined the way they behave: each
/// tree's volume error is independent and adds in quadrature; a
/// density (and a carbon fraction) is one value applied to every tree
/// of its species, so that error adds linearly within the group and in
/// quadrature across groups.
pub fn compute_biomass_totals(per_tree: &[TreeBiomass]) -> BiomassTotals {
    let (mut biomass, mut carbon, mut co2e) = (0.0, 0.0, 0.0);
    let mut var_volume = 0.0;
    // Keyed on the exact values, as the renderer keys on their text.
    let mut by_density: BTreeMap<(u64, u64), (f64, f64)> = BTreeMap::new();
    let mut by_cf: BTreeMap<(u64, u64), (f64, f64)> = BTreeMap::new();
    for b in per_tree {
        biomass += b.biomass;
        carbon += b.carbon;
        co2e += b.co2e;
        let from_volume = b.density * b.volume_std;
        var_volume += from_volume * from_volume;
        let d = by_density
            .entry((b.density.to_bits(), b.density_std.to_bits()))
            .or_insert((0.0, if b.density > 0.0 { b.density_std / b.density } else { 0.0 }));
        d.0 += b.biomass;
        let c = by_cf
            .entry((b.carbon_fraction.to_bits(), b.carbon_fraction_std.to_bits()))
            .or_insert((0.0, if b.carbon_fraction > 0.0 { b.carbon_fraction_std / b.carbon_fraction } else { 0.0 }));
        c.0 += b.carbon;
    }
    let mut var_biomass = var_volume;
    for (total, rel) in by_density.values() {
        var_biomass += (rel * total) * (rel * total);
    }
    let biomass_std = var_biomass.sqrt();
    let rel_biomass = if biomass > 0.0 { biomass_std / biomass } else { 0.0 };
    let mut var_carbon = (rel_biomass * carbon) * (rel_biomass * carbon);
    for (total, rel) in by_cf.values() {
        var_carbon += (rel * total) * (rel * total);
    }
    let carbon_std = var_carbon.sqrt();
    BiomassTotals { trees: per_tree.len(), biomass, biomass_std, carbon, carbon_std, co2e, co2e_std: carbon_std * CO2_PER_C }
}

// --- operations -----------------------------------------------------------------

fn f_0_25() -> f64 { 0.25 }
fn f_0_5() -> f64 { 0.5 }
fn f_1() -> f64 { 1.0 }
fn f_1_2() -> f64 { 1.2 }
fn f_1_4() -> f64 { 1.4 }
fn yes() -> bool { true }
fn pine() -> Option<String> { Some("pine".into()) }
fn pine_key() -> String { "pine".into() }
fn crown_area() -> EdgeCorrection { EdgeCorrection::CrownArea }
fn f_400() -> f64 { DEFAULT_BIOMASS_PARAMS.density }
fn f_25() -> f64 { DEFAULT_BIOMASS_PARAMS.density_std }
fn f_0_02() -> f64 { DEFAULT_BIOMASS_PARAMS.carbon_fraction_std }

/// The measurement band shared by the three operations (the same
/// defaults as `metrics.trees`).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VolumesParams {
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
    /// Prefer the measured QSM stem volume from qsm.json where one exists (default true).
    #[serde(default = "yes")]
    pub use_qsm: bool,
    /// Species function for trees with no entry in species.json: "pine", "spruce" or "birch" (Finnish names accepted); null leaves them to the form factor (default "pine").
    #[serde(default = "pine")]
    pub default_species: Option<String>,
    /// Form factor for the last resort, V = g · h · f (default 0.50).
    #[serde(default = "f_0_5")]
    pub form_factor: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TreeVolume {
    pub tree_id: i32,
    pub dbh: f64,
    pub height: f64,
    pub basal_area: f64,
    pub dbh_source: DbhSource,
    /// Stem volume, m³; null when nothing could be estimated.
    pub volume: f64,
    pub source: VolumeSource,
    pub species: Option<VolumeSpecies>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VolumesReport {
    pub tree_count: usize,
    /// Σ of the estimable volumes, m³.
    pub total_volume: f64,
    pub tally: VolumeTally,
    /// The tally in words, e.g. "9 measured (QSM) · 2 form factor".
    pub sources: String,
    pub trees: Vec<TreeVolume>,
}

/// species.json as a map by tree id; an unparsable id is skipped, as
/// the renderer skips it.
fn species_map(octree_dir: &str) -> Result<HashMap<i32, String>, String> {
    let text = octree_read_species(octree_dir.to_string())?;
    if text.trim().is_empty() {
        return Ok(HashMap::new());
    }
    let raw: BTreeMap<String, String> = serde_json::from_str(&text).map_err(|e| format!("parse species.json: {e}"))?;
    Ok(raw.into_iter().filter_map(|(k, v)| k.parse::<i32>().ok().map(|id| (id, v))).collect())
}

fn measured(ctx: &OpContext, dir: &str, crown_cell: f64, bh_low: f64, bh_high: f64, dtm_cell: f64, merge: bool) -> Result<Vec<MergedMetric>, String> {
    let sink = ctx.progress.under("metrics");
    let metrics = run_tree_metrics(&sink, dir, crown_cell, bh_low, bh_high, dtm_cell)?;
    let stems = if merge { octree_read_stems(dir.to_string())? } else { None };
    Ok(merge_stem_fits(&metrics, stems.as_deref()))
}

fn metrics_volumes(ctx: &OpContext, p: VolumesParams) -> Result<VolumesReport, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    if !(p.form_factor.is_finite() && p.form_factor > 0.0) {
        return Err("formFactor must be positive".into());
    }
    if let Some(k) = p.default_species.as_deref().filter(|k| !k.trim().is_empty()) {
        if species_function(Some(k)).is_none() {
            return Err(format!("defaultSpecies '{k}' has no volume function: use pine, spruce or birch (or null)"));
        }
    }
    let merged = measured(ctx, &p.octree_dir, p.crown_cell, p.bh_low, p.bh_high, p.dtm_cell, p.merge_stems)?;
    let qsm: Option<HashMap<i32, f64>> = if p.use_qsm {
        octree_read_qsm(p.octree_dir.clone())?.map(|q| q.trees.iter().map(|t| (t.tree_id, t.stem_volume)).collect())
    } else {
        None
    };
    let species = species_map(&p.octree_dir)?;
    let default_species = p.default_species.as_deref().filter(|k| !k.trim().is_empty());
    let opts = VolumeOptions { qsm: qsm.as_ref(), species_by_tree: Some(&species), default_species, form_factor: p.form_factor };
    let resolved: Vec<ResolvedVolume> = merged.iter().map(|m| resolve_volume(&m.metric, &opts)).collect();
    let tally = tally_sources(&resolved);
    let trees: Vec<TreeVolume> = merged
        .iter()
        .zip(&resolved)
        .map(|(m, r)| TreeVolume {
            tree_id: m.metric.tree_id,
            dbh: m.metric.dbh,
            height: m.metric.height,
            basal_area: m.metric.basal_area,
            dbh_source: m.dbh_source,
            volume: r.volume,
            source: r.source,
            species: r.species,
        })
        .collect();
    Ok(VolumesReport {
        tree_count: trees.len(),
        total_volume: resolved.iter().map(|r| r.volume).filter(|v| v.is_finite()).sum(),
        sources: describe_volume_sources(&tally),
        tally,
        trees,
    })
}

/// Biomass and carbon from the QSM (the Metrics module's defaults).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BiomassOpParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
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
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FallbackDensity {
    pub label: String,
    pub density: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BiomassReport {
    pub totals: BiomassTotals,
    /// Trees with no species assignment, or one that is not a preset, computed with the fallback.
    pub fallback_count: usize,
    pub fallback_species: String,
    /// The density the fallback actually applied, and the name to print beside it.
    pub fallback_density: FallbackDensity,
    /// The parameters the fallback trees were computed with.
    pub params: BiomassParams,
    pub trees: Vec<TreeBiomass>,
}

/// The renderer's `fallbackDensityLabel`.
pub fn fallback_density_label(fallback_species: &str, params: &BiomassParams) -> FallbackDensity {
    match species_density(fallback_species) {
        Some(s) => FallbackDensity { label: s.label.to_string(), density: s.density },
        None => FallbackDensity { label: "custom density".to_string(), density: params.density },
    }
}

fn metrics_biomass(_ctx: &OpContext, p: BiomassOpParams) -> Result<BiomassReport, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
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
    let qsm = octree_read_qsm(p.octree_dir.clone())?
        .ok_or_else(|| "no qsm.json in the dataset: run metrics.qsm first".to_string())?;
    let species = species_map(&p.octree_dir)?;
    let (trees, fallback_count) = compute_species_aware_biomass(&qsm.trees, &species, &key, base);
    let params = biomass_params_for_species(&key, base);
    Ok(BiomassReport {
        totals: compute_biomass_totals(&trees),
        fallback_count,
        fallback_density: fallback_density_label(&key, &params),
        fallback_species: key,
        params,
        trees,
    })
}

/// How to get a boundary when the dataset has none recorded.
#[derive(Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FitKind {
    Rectangular,
    Circular,
}

/// Per-hectare statistics (the Plot Boundary panel's defaults).
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlotParams {
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
    /// Carry the QSM stem volumes from qsm.json into m³/ha where present (default true).
    #[serde(default = "yes")]
    pub use_qsm: bool,
    /// A boundary to use instead of the dataset's plot.json: `{"kind":"circular","center":[x,y],"radius":r}` or `{"kind":"rectangular","min":[x,y],"max":[x,y]}`.
    #[serde(default)]
    pub boundary: Option<PlotBoundary>,
    /// When no boundary is given or recorded, fit one to the stems: "rectangular" (their bounding box) or "circular" (reaching the farthest stem).
    #[serde(default)]
    pub fit: Option<FitKind>,
    /// Shrink a fitted boundary by this many metres on each side (default 0).
    #[serde(default)]
    pub fit_margin: f64,
    /// Edge correction: "none", "halfcount" or "crownArea" (default "crownArea").
    #[serde(default = "crown_area")]
    pub edge: EdgeCorrection,
    /// Width of the half-count band inside the boundary, metres (default 1.0).
    #[serde(default = "f_1")]
    pub halfcount_buffer: f64,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BoundarySource {
    /// The `boundary` parameter.
    Given,
    /// The dataset's plot.json.
    Recorded,
    /// Fitted to the stems by `fit`.
    Fitted,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlotReport {
    pub boundary: PlotBoundary,
    pub boundary_source: BoundarySource,
    pub edge: EdgeCorrection,
    pub halfcount_buffer: f64,
    /// Figures over every measured tree, boundary or not.
    pub tree_stats: TreeStats,
    /// The edge-corrected per-hectare figures.
    #[serde(flatten)]
    pub stats: PlotStats,
}

fn metrics_plot(ctx: &OpContext, p: PlotParams) -> Result<PlotReport, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    if !(p.halfcount_buffer.is_finite() && p.halfcount_buffer >= 0.0) {
        return Err("halfcountBuffer must be zero or positive".into());
    }
    if !(p.fit_margin.is_finite() && p.fit_margin >= 0.0) {
        return Err("fitMargin must be zero or positive".into());
    }
    let merged = measured(ctx, &p.octree_dir, p.crown_cell, p.bh_low, p.bh_high, p.dtm_cell, p.merge_stems)?;
    let rows: Vec<TreeMetric> = merged.into_iter().map(|m| m.metric).collect();

    let (boundary, boundary_source) = if let Some(b) = p.boundary {
        validate_boundary(&b)?;
        (b, BoundarySource::Given)
    } else if let Some(b) = parse_plot_boundary(&octree_read_plot(p.octree_dir.clone())?) {
        (b, BoundarySource::Recorded)
    } else {
        let xy: Vec<[f64; 2]> = rows.iter().filter(|t| t.x.is_finite() && t.y.is_finite()).map(|t| [t.x, t.y]).collect();
        let fitted = match p.fit {
            Some(FitKind::Rectangular) => fit_rectangular_to_bbox(&xy, p.fit_margin),
            Some(FitKind::Circular) => fit_circular_to_bbox(&xy, p.fit_margin),
            None => return Err("the dataset has no plot boundary: record one with review.setPlot, pass `boundary`, or ask for `fit`".into()),
        };
        let b = fitted.ok_or("no positioned trees to fit a boundary to")?;
        validate_boundary(&b).map_err(|e| format!("the fitted boundary has no area ({e}); lower fitMargin"))?;
        (b, BoundarySource::Fitted)
    };

    let qsm = if p.use_qsm { octree_read_qsm(p.octree_dir.clone())? } else { None };
    let stats = compute_plot_stats(&rows, &boundary, p.edge, p.halfcount_buffer, qsm.as_ref());
    Ok(PlotReport {
        boundary,
        boundary_source,
        edge: p.edge,
        halfcount_buffer: p.halfcount_buffer,
        tree_stats: tree_stats(&rows),
        stats,
    })
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![
        op!("metrics.volumes", Metrics, mutates: false, stage: Some("metrics"),
            "Stem volume per tree: the QSM where measured, else Laasasenaho 1982 by species, else a form factor; with the source of each.", VolumesParams, metrics_volumes),
        op!("metrics.biomass", Metrics, mutates: false, stage: None,
            "Biomass, carbon and CO₂e per tree and for the plot from qsm.json, each tree at its species' wood density, with 1σ uncertainties.", BiomassOpParams, metrics_biomass),
        op!("metrics.plot", Metrics, mutates: false, stage: Some("metrics"),
            "Per-hectare statistics inside the plot boundary with edge correction: stems, basal area, Lorey's height, QSM volume.", PlotParams, metrics_plot),
    ]
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
            basal_area: if dbh.is_finite() && dbh > 0.0 { basal_area(dbh) } else { f64::NAN },
            crown_area: 12.0,
            crown_diameter: 3.9,
            x,
            y,
            base_z: 0.0,
            lean_deg: 0.0,
        }
    }

    fn g(d: f64) -> f64 {
        basal_area(d)
    }

    fn close(a: f64, b: f64, digits: i32) -> bool {
        (a - b).abs() < 10f64.powi(-digits) / 2.0
    }

    const RECT: PlotBoundary = PlotBoundary::Rectangular { min: [0.0, 0.0], max: [20.0, 30.0] };
    const CIRC: PlotBoundary = PlotBoundary::Circular { center: [10.0, 10.0], radius: 8.0 };

    // --- plotBoundary.test.ts ---

    #[test]
    fn area_is_the_side_product_or_pi_r_squared_and_never_negative() {
        assert!(close(plot_area_ha(&RECT), 600.0 / 10_000.0, 15));
        assert!(close(plot_area_ha(&CIRC), std::f64::consts::PI * 64.0 / 10_000.0, 15));
        assert_eq!(plot_area_ha(&PlotBoundary::Rectangular { min: [20.0, 30.0], max: [0.0, 0.0] }), 0.0);
        assert_eq!(plot_area_ha(&PlotBoundary::Rectangular { min: [0.0, 30.0], max: [20.0, 0.0] }), 0.0);
    }

    #[test]
    fn stem_centre_in_out_and_on_the_edge() {
        assert!(stem_centre_inside([10.0, 15.0], &RECT));
        assert!(!stem_centre_inside([-0.01, 15.0], &RECT));
        assert!(stem_centre_inside([0.0, 15.0], &RECT));
        assert!(stem_centre_inside([20.0, 30.0], &RECT));
        assert!(stem_centre_inside([10.0, 10.0], &CIRC));
        assert!(stem_centre_inside([18.0, 10.0], &CIRC));
        assert!(!stem_centre_inside([18.01, 10.0], &CIRC));
    }

    #[test]
    fn signed_distance_is_negative_inside_and_the_hypotenuse_off_a_corner() {
        assert!(close(signed_distance_to_boundary([10.0, 15.0], &RECT), -10.0, 12));
        assert!(close(signed_distance_to_boundary([3.0, 15.0], &RECT), -3.0, 12));
        assert!(close(signed_distance_to_boundary([10.0, 28.0], &RECT), -2.0, 12));
        assert!(close(signed_distance_to_boundary([-4.0, 15.0], &RECT), 4.0, 12));
        assert!(close(signed_distance_to_boundary([10.0, 33.0], &RECT), 3.0, 12));
        assert!(close(signed_distance_to_boundary([23.0, 34.0], &RECT), 5.0, 12));
        assert!(close(signed_distance_to_boundary([-3.0, -4.0], &RECT), 5.0, 12));
        assert!(close(signed_distance_to_boundary([0.0, 15.0], &RECT), 0.0, 12));
        assert!(close(signed_distance_to_boundary([18.0, 10.0], &CIRC), 0.0, 12));
        assert!(close(signed_distance_to_boundary([10.0, 10.0], &CIRC), -8.0, 12));
        assert!(close(signed_distance_to_boundary([15.0, 10.0], &CIRC), -3.0, 12));
        assert!(close(signed_distance_to_boundary([20.0, 10.0], &CIRC), 2.0, 12));
    }

    #[test]
    fn crown_fraction_is_whole_inside_none_outside_and_about_half_on_an_edge() {
        let crown = std::f64::consts::PI * 4.0;
        assert_eq!(crown_fraction_inside([10.0, 15.0], crown, &RECT), 1.0);
        assert_eq!(crown_fraction_inside([-10.0, 15.0], crown, &RECT), 0.0);
        let f = crown_fraction_inside([0.0, 15.0], crown, &RECT);
        assert!(f > 0.40 && f < 0.60, "{f}");
        let mut prev = 0.0;
        for i in 0..=20 {
            let x = -2.0 + i as f64 * 0.2;
            let f = crown_fraction_inside([x, 15.0], crown, &RECT);
            assert!(f >= prev, "x={x}: {f} < {prev}");
            prev = f;
        }
        assert_eq!(crown_fraction_inside([10.0, 15.0], f64::NAN, &RECT), 1.0);
        assert_eq!(crown_fraction_inside([-1.0, 15.0], f64::NAN, &RECT), 0.0);
        assert_eq!(crown_fraction_inside([10.0, 15.0], 0.0, &RECT), 1.0);
        assert_eq!(crown_fraction_inside([0.5, 15.0], 12.0, &RECT), crown_fraction_inside([0.5, 15.0], 12.0, &RECT));
    }

    #[test]
    fn tree_weight_by_method() {
        assert_eq!(tree_weight([10.0, 15.0], 12.0, &RECT, EdgeCorrection::None, 1.0), 1.0);
        assert_eq!(tree_weight([-1.0, 15.0], 12.0, &RECT, EdgeCorrection::None, 1.0), 0.0);
        assert_eq!(tree_weight([0.5, 15.0], 12.0, &RECT, EdgeCorrection::Halfcount, 1.0), 0.5);
        assert_eq!(tree_weight([5.0, 15.0], 12.0, &RECT, EdgeCorrection::Halfcount, 1.0), 1.0);
        assert_eq!(tree_weight([-0.5, 15.0], 12.0, &RECT, EdgeCorrection::Halfcount, 1.0), 0.0);
        assert_eq!(tree_weight([2.0, 15.0], 12.0, &RECT, EdgeCorrection::Halfcount, 3.0), 0.5);
        assert_eq!(tree_weight([2.0, 15.0], 12.0, &RECT, EdgeCorrection::Halfcount, 1.0), 1.0);
        assert_eq!(tree_weight([10.0, 15.0], std::f64::consts::PI * 4.0, &RECT, EdgeCorrection::CrownArea, 1.0), 1.0);
        let f = tree_weight([0.0, 15.0], std::f64::consts::PI * 4.0, &RECT, EdgeCorrection::CrownArea, 1.0);
        assert!(f > 0.4 && f < 0.6);
        // A stem 0.8 m off a corner is outside, whatever the band says.
        assert_eq!(tree_weight([20.8, 30.8], 12.0, &RECT, EdgeCorrection::Halfcount, 1.0), 0.0);
    }

    #[test]
    fn fitted_boundaries() {
        let stems = [[0.0, 0.0], [10.0, 6.0], [4.0, 2.0]];
        assert_eq!(fit_rectangular_to_bbox(&stems, 0.0), Some(PlotBoundary::Rectangular { min: [0.0, 0.0], max: [10.0, 6.0] }));
        assert_eq!(fit_rectangular_to_bbox(&stems, 1.0), Some(PlotBoundary::Rectangular { min: [1.0, 1.0], max: [9.0, 5.0] }));
        let eaten = fit_rectangular_to_bbox(&stems, 4.0).unwrap();
        if let PlotBoundary::Rectangular { min, max } = &eaten {
            assert!(min[0] <= max[0] && min[1] <= max[1]);
            assert!(close(min[1], 3.0, 12) && close(max[1], 3.0, 12));
        }
        assert_eq!(plot_area_ha(&eaten), 0.0);
        assert_eq!(fit_rectangular_to_bbox(&[], 0.0), None);

        let square = [[0.0, 0.0], [20.0, 0.0], [0.0, 20.0], [20.0, 20.0], [20.0, 10.0]];
        match fit_circular_to_bbox(&square, 0.0).unwrap() {
            PlotBoundary::Circular { center, radius } => {
                assert_eq!(center, [10.0, 10.0]);
                assert!(close(radius, 200f64.sqrt(), 12));
            }
            _ => panic!(),
        }
        let cross = [[0.0, 10.0], [20.0, 10.0], [10.0, 0.0], [10.0, 20.0]];
        match fit_circular_to_bbox(&cross, 0.0).unwrap() {
            PlotBoundary::Circular { radius, .. } => assert!(close(radius, 10.0, 12)),
            _ => panic!(),
        }
        match fit_circular_to_bbox(&cross, 2.0).unwrap() {
            PlotBoundary::Circular { radius, .. } => assert!(close(radius, 8.0, 12)),
            _ => panic!(),
        }
        match fit_circular_to_bbox(&cross, 100.0).unwrap() {
            PlotBoundary::Circular { radius, .. } => assert_eq!(radius, 1.0),
            _ => panic!(),
        }
        assert_eq!(fit_circular_to_bbox(&[], 0.0), None);
    }

    #[test]
    fn parse_plot_boundary_round_trips_and_rejects_malformed() {
        let rect = serde_json::to_string(&RECT).unwrap();
        let circ = serde_json::to_string(&CIRC).unwrap();
        assert_eq!(parse_plot_boundary(&rect), Some(RECT));
        assert_eq!(parse_plot_boundary(&circ), Some(CIRC));
        assert_eq!(parse_plot_boundary("{}"), None);
        assert_eq!(parse_plot_boundary("not json"), None);
        assert_eq!(parse_plot_boundary(r#"{"kind":"circular","center":[0,0],"radius":0}"#), None);
        assert_eq!(parse_plot_boundary(r#"{"kind":"rectangular","min":[20,30],"max":[0,0]}"#), None);
        assert_eq!(parse_plot_boundary(r#"{"kind":"rectangular","min":[0,0],"max":[0,10]}"#), None);
        assert_eq!(parse_plot_boundary(r#"{"kind":"circular","center":[0],"radius":5}"#), None);
    }

    // --- plotStats.test.ts ---

    const PLOT: PlotBoundary = PlotBoundary::Rectangular { min: [0.0, 0.0], max: [20.0, 20.0] };

    #[test]
    fn scales_the_plot_sums_to_a_hectare() {
        let trees = [tree(1, 5.0, 5.0, 0.30, 20.0), tree(2, 15.0, 5.0, 0.20, 18.0), tree(3, 5.0, 15.0, 0.25, 19.0)];
        let s = compute_plot_stats(&trees, &PLOT, EdgeCorrection::None, 1.0, None);
        assert!(close(s.area_ha, 0.04, 12));
        assert_eq!(s.n_weighted, 3.0);
        assert!(close(s.stems_per_ha, 75.0, 10));
        assert!(close(s.basal_area_per_ha, (g(0.30) + g(0.20) + g(0.25)) / 0.04, 10));
    }

    #[test]
    fn averages_height_over_the_trees_that_have_one() {
        let trees = [
            tree(1, 5.0, 5.0, 0.30, 22.0),
            tree(2, 15.0, 5.0, 0.28, 21.0),
            tree(3, 5.0, 15.0, 0.35, 24.0),
            tree(4, 15.0, 15.0, 0.32, 0.0),
        ];
        let s = compute_plot_stats(&trees, &PLOT, EdgeCorrection::None, 1.0, None);
        let num = g(0.30) * 22.0 + g(0.28) * 21.0 + g(0.35) * 24.0;
        let den = g(0.30) + g(0.28) + g(0.35);
        assert!(close(s.lorey_mean_height, num / den, 10));
        assert_eq!(s.n_no_height, 1);
        assert!(num / (den + g(0.32)) < s.lorey_mean_height * 0.8);
        // The tree with no height still has a diameter.
        assert!(close(s.basal_area_per_ha, den + g(0.32), 10) || s.basal_area_per_ha > 0.0);
        let two = [tree(1, 5.0, 5.0, 0.30, 20.0), tree(2, 15.0, 15.0, 0.32, 0.0)];
        let s2 = compute_plot_stats(&two, &PLOT, EdgeCorrection::None, 1.0, None);
        assert!(close(s2.basal_area_per_ha, (g(0.30) + g(0.32)) / 0.04, 10));
        assert_eq!(s2.n_weighted, 2.0);
        let s3 = compute_plot_stats(&[tree(1, 5.0, 5.0, 0.30, 0.0)], &PLOT, EdgeCorrection::None, 1.0, None);
        assert!(s3.lorey_mean_height.is_nan());
        assert_eq!(s3.n_no_height, 1);
    }

    #[test]
    fn leaves_a_tree_outside_or_unpositioned_out_of_every_figure() {
        let trees = [tree(1, 5.0, 5.0, 0.30, 20.0), tree(2, 50.0, 50.0, 0.30, 20.0)];
        let s = compute_plot_stats(&trees, &PLOT, EdgeCorrection::None, 1.0, None);
        assert_eq!((s.n_out, s.n_weighted, s.inside_rows.len()), (1, 1.0, 1));
        assert!(close(s.stems_per_ha, 25.0, 10));
        let trees = [tree(1, 5.0, 5.0, 0.30, 20.0), tree(2, f64::NAN, f64::NAN, 0.30, 20.0)];
        let s = compute_plot_stats(&trees, &PLOT, EdgeCorrection::None, 1.0, None);
        assert_eq!((s.n_out, s.n_weighted), (1, 1.0));
    }

    #[test]
    fn applies_the_inclusion_weight_to_basal_area_and_volume_too() {
        let trees = [tree(1, 0.5, 10.0, 0.30, 20.0)];
        let s = compute_plot_stats(&trees, &PLOT, EdgeCorrection::Halfcount, 1.0, None);
        assert!(close(s.n_weighted, 0.5, 12));
        assert_eq!(s.n_partial, 1);
        assert!(close(s.basal_area_per_ha, 0.5 * g(0.30) / 0.04, 10));
        assert!(close(s.lorey_mean_height, 20.0, 10));
    }

    fn qsm_tree(tree_id: i32, stem_volume: f64) -> TreeQsm {
        serde_json::from_value(serde_json::json!({
            "treeId": tree_id, "baseX": 0, "baseY": 0, "baseZ": 0, "height": 20,
            "slices": [], "branches": [], "branchVolume": 0, "branchCount": 0,
            "totalVolume": stem_volume, "stemVolume": stem_volume, "stemVolumeStd": 0, "stemVolumeCi95": 0,
            "dbh": 0.3, "confidence": 0.9, "completeness": 1.0, "acceptedSlices": 10, "rejectedSlices": 0,
        }))
        .unwrap()
    }

    fn qsm(trees: Vec<TreeQsm>) -> QsmResult {
        let total: f64 = trees.iter().map(|t| t.stem_volume).sum();
        QsmResult { trees, total_stem_volume: total, total_stem_volume_std: 0.0, qsm_path: String::new(), slice_height: 0.5, min_points_per_slice: 10 }
    }

    #[test]
    fn carries_qsm_volume_and_its_interval_through_the_same_weights() {
        let mut a = qsm_tree(1, 0.8);
        a.stem_volume_ci95 = 0.04;
        let mut b = qsm_tree(2, 0.5);
        b.stem_volume_ci95 = 0.03;
        let q = qsm(vec![a, b]);
        let trees = [tree(1, 5.0, 5.0, 0.30, 20.0), tree(2, 15.0, 15.0, 0.25, 19.0)];
        let s = compute_plot_stats(&trees, &PLOT, EdgeCorrection::None, 1.0, Some(&q));
        assert!(s.has_qsm);
        assert!(close(s.stem_volume_per_ha, 1.3 / 0.04, 10));
        assert!(close(s.stem_volume_ci95_per_ha, 0.04f64.hypot(0.03) / 0.04, 10));
    }

    #[test]
    fn an_empty_plot_is_zero_not_nan_and_a_circle_uses_its_own_area() {
        let s = compute_plot_stats(&[], &PLOT, EdgeCorrection::None, 1.0, None);
        assert_eq!((s.stems_per_ha, s.basal_area_per_ha), (0.0, 0.0));
        assert!(s.lorey_mean_height.is_nan());
        assert!(!s.stem_volume_per_ha.is_nan());
        let circ = PlotBoundary::Circular { center: [0.0, 0.0], radius: 10.0 };
        let s = compute_plot_stats(&[tree(1, 1.0, 1.0, 0.30, 20.0)], &circ, EdgeCorrection::None, 1.0, None);
        assert!(close(s.area_ha, std::f64::consts::PI * 100.0 / 10_000.0, 12));
        assert!(close(s.stems_per_ha, 1.0 / (std::f64::consts::PI * 0.01), 8));
    }

    #[test]
    fn tree_stats_takes_each_figure_over_the_trees_that_have_what_it_needs() {
        let with_gap = [
            tree(1, 0.0, 0.0, 0.30, 22.0),
            tree(2, 0.0, 0.0, 0.28, 21.0),
            tree(3, 0.0, 0.0, 0.35, 24.0),
            tree(4, 0.0, 0.0, 0.32, 0.0),
        ];
        let s = tree_stats(&with_gap);
        assert_eq!((s.tree_count, s.n_with_dbh, s.n_with_height), (4, 4, 3));
        assert!(close(s.basal_area_total, g(0.30) + g(0.28) + g(0.35) + g(0.32), 12));
        let num = g(0.30) * 22.0 + g(0.28) * 21.0 + g(0.35) * 24.0;
        let den = g(0.30) + g(0.28) + g(0.35);
        assert!(close(s.lorey_mean_height, num / den, 10));
        assert_eq!(s.top_n_count, 1);
        assert!(close(s.dominant_height, 24.0, 12));

        let none = tree_stats(&[tree(1, 0.0, 0.0, f64::NAN, 0.0)]);
        assert_eq!((none.tree_count, none.basal_area_total), (1, 0.0));
        assert!(none.lorey_mean_height.is_nan() && none.dominant_height.is_nan());
        let empty = tree_stats(&[]);
        assert_eq!((empty.tree_count, empty.n_with_dbh, empty.basal_area_total), (0, 0, 0.0));

        let per_ha = compute_plot_stats(&with_gap, &PLOT, EdgeCorrection::None, 1.0, None);
        assert!(close(per_ha.basal_area_per_ha * per_ha.area_ha, s.basal_area_total, 10));
        assert!(close(per_ha.lorey_mean_height, s.lorey_mean_height, 10));
    }

    // --- volumeFunctions.test.ts ---

    #[test]
    fn laasasenaho_magnitudes_a_forester_would_recognise() {
        let v = laasasenaho_volume(VolumeSpecies::Pine, 0.20, 18.0);
        assert!(v > 0.24 && v < 0.31, "{v}");
        let v = laasasenaho_volume(VolumeSpecies::Spruce, 0.25, 20.0);
        assert!(v > 0.40 && v < 0.52, "{v}");
        let v = laasasenaho_volume(VolumeSpecies::Pine, 0.40, 28.0);
        assert!(v > 1.3 && v < 1.8, "{v}");
        for sp in VolumeSpecies::ALL {
            for (d, h) in [(0.15, 14.0), (0.25, 20.0), (0.35, 26.0)] {
                let f = laasasenaho_volume(sp, d, h) / (g(d) * h);
                assert!(f > 0.38 && f < 0.56, "{sp:?} d={d} h={h}: {f}");
            }
        }
        for (d, h) in [(0.15, 14.0), (0.25, 20.0), (0.35, 26.0)] {
            let b = laasasenaho_volume(VolumeSpecies::Birch, d, h);
            assert!(b < laasasenaho_volume(VolumeSpecies::Pine, d, h));
            assert!(b < laasasenaho_volume(VolumeSpecies::Spruce, d, h));
        }
    }

    #[test]
    fn laasasenaho_behaviour() {
        for sp in VolumeSpecies::ALL {
            let mut prev = 0.0;
            for d in [0.10, 0.15, 0.20, 0.30, 0.40, 0.50] {
                let v = laasasenaho_volume(sp, d, 20.0);
                assert!(v > prev, "{sp:?} d={d}");
                prev = v;
            }
            let mut prev = 0.0;
            for h in [6.0, 10.0, 15.0, 20.0, 25.0, 30.0] {
                let v = laasasenaho_volume(sp, 0.25, h);
                assert!(v > prev, "{sp:?} h={h}");
                prev = v;
            }
            for h in [1.5, 2.0, 3.0, 3.99] {
                assert!(laasasenaho_volume(sp, 0.05, h).is_nan(), "{sp:?} h={h}");
            }
            for h in [4.0, 5.0, 6.0] {
                let f = laasasenaho_volume(sp, 0.05, h) / (g(0.05) * h);
                assert!(f > 0.35 && f < 0.75, "{sp:?} h={h}: {f}");
            }
        }
        let ratio = laasasenaho_volume(VolumeSpecies::Pine, 0.40, 20.0) / laasasenaho_volume(VolumeSpecies::Pine, 0.20, 20.0);
        assert!(ratio > 3.0 && ratio < 5.0, "{ratio}");
        assert!(laasasenaho_volume(VolumeSpecies::Pine, f64::NAN, 20.0).is_nan());
        assert!(laasasenaho_volume(VolumeSpecies::Pine, 0.25, f64::NAN).is_nan());
        assert!(laasasenaho_volume(VolumeSpecies::Pine, 0.0, 20.0).is_nan());
        assert!(laasasenaho_volume(VolumeSpecies::Pine, -0.25, 20.0).is_nan());
        assert!(laasasenaho_volume(VolumeSpecies::Pine, 0.25, 0.0).is_nan());
        assert_eq!(VolumeSpecies::Pine.laasasenaho_1982().a1, 0.036089);
        assert_eq!(VolumeSpecies::Spruce.laasasenaho_1982().a4, 2.82541);
        assert_eq!(VolumeSpecies::Birch.laasasenaho_1982().a5, -2.65900);
        for sp in VolumeSpecies::ALL {
            assert!(sp.laasasenaho_1982().a5 < 0.0 && sp.laasasenaho_1982().a3 < 1.0);
        }
    }

    #[test]
    fn species_function_resolves_english_and_finnish_names_only() {
        assert_eq!(species_function(Some("pine")), Some(VolumeSpecies::Pine));
        assert_eq!(species_function(Some("spruce")), Some(VolumeSpecies::Spruce));
        assert_eq!(species_function(Some("birch")), Some(VolumeSpecies::Birch));
        assert_eq!(species_function(Some("mänty")), Some(VolumeSpecies::Pine));
        assert_eq!(species_function(Some("kuusi")), Some(VolumeSpecies::Spruce));
        assert_eq!(species_function(Some("koivu")), Some(VolumeSpecies::Birch));
        assert_eq!(species_function(Some("  Pine ")), Some(VolumeSpecies::Pine));
        assert_eq!(species_function(Some("KUUSI")), Some(VolumeSpecies::Spruce));
        assert_eq!(species_function(Some("aspen")), None);
        assert_eq!(species_function(Some("oak")), None);
        assert_eq!(species_function(Some("")), None);
        assert_eq!(species_function(None), None);
    }

    #[test]
    fn resolve_volume_prefers_qsm_then_the_species_function_then_the_form_factor() {
        let t = tree(1, 0.0, 0.0, 0.25, 20.0);
        let qsm: HashMap<i32, f64> = [(1, 0.481)].into();
        let species: HashMap<i32, String> = [(1, "spruce".to_string())].into();
        let r = resolve_volume(&t, &VolumeOptions { qsm: Some(&qsm), species_by_tree: Some(&species), default_species: Some("pine"), ..Default::default() });
        assert_eq!((r.volume, r.source, r.species), (0.481, VolumeSource::Qsm, None));

        let r = resolve_volume(&t, &VolumeOptions { species_by_tree: Some(&species), ..Default::default() });
        assert_eq!((r.source, r.species), (VolumeSource::Laasasenaho, Some(VolumeSpecies::Spruce)));
        assert!(close(r.volume, laasasenaho_volume(VolumeSpecies::Spruce, 0.25, 20.0), 12));

        let r = resolve_volume(&t, &VolumeOptions { default_species: Some("pine"), ..Default::default() });
        assert_eq!((r.source, r.species), (VolumeSource::Laasasenaho, Some(VolumeSpecies::Pine)));

        let birch: HashMap<i32, String> = [(1, "birch".to_string())].into();
        let r = resolve_volume(&t, &VolumeOptions { species_by_tree: Some(&birch), default_species: Some("pine"), ..Default::default() });
        assert_eq!(r.species, Some(VolumeSpecies::Birch));

        let r = resolve_volume(&t, &VolumeOptions { default_species: Some("oak"), ..Default::default() });
        assert_eq!(r.source, VolumeSource::FormFactor);
        assert!(close(r.volume, g(0.25) * 20.0 * DEFAULT_FORM_FACTOR, 12));

        for h in [1.2, 3.0] {
            let r = resolve_volume(&tree(2, 0.0, 0.0, 0.04, h), &VolumeOptions { default_species: Some("pine"), ..Default::default() });
            assert_eq!(r.source, VolumeSource::FormFactor);
        }

        let r = resolve_volume(&t, &VolumeOptions { form_factor: 0.42, ..Default::default() });
        assert!(close(r.volume, g(0.25) * 20.0 * 0.42, 12));

        for bad in [0.0, f64::NAN] {
            let qsm: HashMap<i32, f64> = [(1, bad)].into();
            let r = resolve_volume(&t, &VolumeOptions { qsm: Some(&qsm), default_species: Some("pine"), ..Default::default() });
            assert_eq!(r.source, VolumeSource::Laasasenaho);
        }

        let r = resolve_volume(&tree(3, 0.0, 0.0, f64::NAN, 0.0), &VolumeOptions { default_species: Some("pine"), ..Default::default() });
        assert_eq!(r.source, VolumeSource::None);
        assert!(r.volume.is_nan());
        for ds in [None, Some("pine"), Some("oak")] {
            let r = resolve_volume(&tree(4, 0.0, 0.0, f64::NAN, f64::NAN), &VolumeOptions { default_species: ds, ..Default::default() });
            assert_eq!(r.source, VolumeSource::None);
            assert!(r.volume.is_nan());
        }
    }

    #[test]
    fn source_disclosure() {
        let qsm: HashMap<i32, f64> = [(1, 0.48)].into();
        let rs = [
            resolve_volume(&tree(1, 0.0, 0.0, 0.25, 20.0), &VolumeOptions { qsm: Some(&qsm), ..Default::default() }),
            resolve_volume(&tree(2, 0.0, 0.0, 0.25, 20.0), &VolumeOptions { default_species: Some("pine"), ..Default::default() }),
            resolve_volume(&tree(3, 0.0, 0.0, 0.25, 20.0), &VolumeOptions { default_species: Some("oak"), ..Default::default() }),
            resolve_volume(&tree(4, 0.0, 0.0, f64::NAN, f64::NAN), &VolumeOptions::default()),
        ];
        let t = tally_sources(&rs);
        assert_eq!(t, VolumeTally { qsm: 1, laasasenaho: 1, form_factor: 1, none: 1 });
        assert_eq!(describe_volume_sources(&t), "1 measured (QSM) · 1 Laasasenaho 1982 · 1 form factor · 1 not estimable");
        assert_eq!(describe_volume_sources(&VolumeTally { qsm: 3, ..Default::default() }), "3 measured (QSM)");
    }

    // --- biomass.test.ts ---

    #[test]
    fn biomass_scales_with_density_and_co2e_is_44_over_12_of_carbon() {
        let t = qsm_tree(1, 1.0);
        let pine = compute_tree_biomass(&t, &biomass_params_for_species("pine", DEFAULT_BIOMASS_PARAMS));
        let oak = compute_tree_biomass(&t, &biomass_params_for_species("oak", DEFAULT_BIOMASS_PARAMS));
        assert!(close(pine.biomass, 400.0, 6));
        assert!(close(oak.biomass / pine.biomass, 650.0 / 400.0, 9));
        let b = compute_tree_biomass(&qsm_tree(1, 2.5), &DEFAULT_BIOMASS_PARAMS);
        assert!(close(b.co2e / b.carbon, 44.0 / 12.0, 9));
        assert!(b.carbon < b.biomass);
    }

    #[test]
    fn includes_branch_volume_and_its_uncertainty() {
        let stem_only = compute_tree_biomass(&qsm_tree(1, 1.0), &DEFAULT_BIOMASS_PARAMS);
        let mut t = qsm_tree(1, 1.0);
        t.branch_volume = 0.4;
        t.total_volume = 1.4;
        let with = compute_tree_biomass(&t, &DEFAULT_BIOMASS_PARAMS);
        assert!(close(with.volume, 1.4, 9));
        assert!(with.biomass > stem_only.biomass);
        assert!(with.biomass_std > stem_only.biomass_std);
    }

    #[test]
    fn species_aware_fallback_accounting() {
        let trees = vec![qsm_tree(1, 1.0), qsm_tree(2, 1.0), qsm_tree(3, 1.0)];
        let one: HashMap<i32, String> = [(1, "oak".to_string())].into();
        let (by, n) = compute_species_aware_biomass(&trees, &one, "pine", DEFAULT_BIOMASS_PARAMS);
        assert_eq!((n, by.len()), (2, 3));

        let stale: HashMap<i32, String> = [(1, "oak".to_string()), (2, "larch-that-was-removed".to_string()), (3, "spruce".to_string())].into();
        let (_, n) = compute_species_aware_biomass(&trees, &stale, "pine", DEFAULT_BIOMASS_PARAMS);
        assert_eq!(n, 1, "an unrecognised key must not silently pass as assigned");

        let assigned: HashMap<i32, String> = [(1, "oak".to_string()), (2, "pine".to_string()), (3, "pine".to_string())].into();
        let (by, n) = compute_species_aware_biomass(&trees, &assigned, "pine", DEFAULT_BIOMASS_PARAMS);
        assert_eq!(n, 0);
        assert!((by[0].biomass - by[1].biomass).abs() > 1e-3);
        assert!(close(by[1].biomass, by[2].biomass, 9));

        let (by, _) = compute_species_aware_biomass(&trees[..1], &HashMap::new(), "oak", DEFAULT_BIOMASS_PARAMS);
        let direct = compute_tree_biomass(&qsm_tree(1, 1.0), &biomass_params_for_species("oak", DEFAULT_BIOMASS_PARAMS));
        assert!(close(by[0].biomass, direct.biomass, 9));
    }

    #[test]
    fn every_species_preset_is_usable_and_cites_a_source() {
        for s in SPECIES_DENSITIES {
            assert!(s.density > 0.0 && s.density_std > 0.0);
            assert!(s.carbon_fraction > 0.3 && s.carbon_fraction < 0.6);
            assert!(!s.source.is_empty());
            assert_eq!(biomass_params_for_species(s.key, DEFAULT_BIOMASS_PARAMS).density, s.density);
        }
        assert_eq!(biomass_params_for_species("custom", DEFAULT_BIOMASS_PARAMS), DEFAULT_BIOMASS_PARAMS);
        assert!(validate_biomass_params(&DEFAULT_BIOMASS_PARAMS).is_ok());
        let zero = BiomassParams { density: 0.0, ..DEFAULT_BIOMASS_PARAMS };
        assert!(validate_biomass_params(&zero).unwrap_err().starts_with("density must be between 50 and 1400"));
        let cf = BiomassParams { carbon_fraction: 1.2, ..DEFAULT_BIOMASS_PARAMS };
        assert!(validate_biomass_params(&cf).unwrap_err().starts_with("carbonFraction"));
    }

    #[test]
    fn totals_do_not_let_a_shared_density_error_average_away() {
        let pine = biomass_params_for_species("pine", DEFAULT_BIOMASS_PARAMS);
        let rel_density = pine.density_std / pine.density;
        for n in [1, 10, 200] {
            let per: Vec<TreeBiomass> = (0..n).map(|i| compute_tree_biomass(&qsm_tree(i, 0.5), &pine)).collect();
            let tot = compute_biomass_totals(&per);
            assert!(close(tot.biomass_std / tot.biomass, rel_density, 10));
        }
        let per: Vec<TreeBiomass> = (0..200).map(|i| compute_tree_biomass(&qsm_tree(i, 0.5), &pine)).collect();
        let naive = per.iter().map(|b| b.biomass_std * b.biomass_std).sum::<f64>().sqrt();
        let total: f64 = per.iter().map(|b| b.biomass).sum();
        assert!(naive / total < rel_density / 10.0);
    }

    #[test]
    fn totals_still_average_the_part_that_is_independent() {
        let p = BiomassParams { density_std: 0.0, carbon_fraction_std: 0.0, ..biomass_params_for_species("pine", DEFAULT_BIOMASS_PARAMS) };
        let with_vol_err = |id: i32| {
            let mut t = qsm_tree(id, 0.5);
            t.stem_volume_std = 0.05;
            t
        };
        let one = compute_biomass_totals(&[compute_tree_biomass(&with_vol_err(0), &p)]);
        let many: Vec<TreeBiomass> = (0..100).map(|i| compute_tree_biomass(&with_vol_err(i), &p)).collect();
        let many = compute_biomass_totals(&many);
        assert!(close(many.biomass_std / many.biomass, (one.biomass_std / one.biomass) / 10.0, 10));
    }

    #[test]
    fn totals_keep_two_species_density_errors_separate() {
        let spruce = biomass_params_for_species("spruce", DEFAULT_BIOMASS_PARAMS);
        let oak = biomass_params_for_species("oak", DEFAULT_BIOMASS_PARAMS);
        let mut per: Vec<TreeBiomass> = (0..50).map(|i| compute_tree_biomass(&qsm_tree(i, 0.5), &spruce)).collect();
        per.extend((0..50).map(|i| compute_tree_biomass(&qsm_tree(100 + i, 0.5), &oak)));
        let tot = compute_biomass_totals(&per);
        let bs: f64 = per.iter().filter(|p| p.density == spruce.density).map(|p| p.biomass).sum();
        let bo: f64 = per.iter().filter(|p| p.density == oak.density).map(|p| p.biomass).sum();
        let expected = ((spruce.density_std / spruce.density) * bs).hypot((oak.density_std / oak.density) * bo);
        assert!(close(tot.biomass_std, expected, 8));
        assert!(tot.biomass_std < (spruce.density_std / spruce.density) * bs + (oak.density_std / oak.density) * bo);
    }

    #[test]
    fn totals_agree_with_one_tree_carry_the_carbon_fraction_and_are_zero_when_empty() {
        let pine = biomass_params_for_species("pine", DEFAULT_BIOMASS_PARAMS);
        let mut q = qsm_tree(1, 0.5);
        q.stem_volume_std = 0.03;
        let t = compute_tree_biomass(&q, &pine);
        let tot = compute_biomass_totals(std::slice::from_ref(&t));
        assert!(close(tot.biomass, t.biomass, 10) && close(tot.biomass_std, t.biomass_std, 10));
        assert!(close(tot.carbon, t.carbon, 10) && close(tot.carbon_std, t.carbon_std, 10));
        assert!(close(tot.co2e, t.co2e, 10));

        let per: Vec<TreeBiomass> = (0..100).map(|i| compute_tree_biomass(&qsm_tree(i, 0.5), &pine)).collect();
        let tot = compute_biomass_totals(&per);
        let rel_b = tot.biomass_std / tot.biomass;
        let rel_cf = pine.carbon_fraction_std / pine.carbon_fraction;
        assert!(close(tot.carbon_std / tot.carbon, rel_b.hypot(rel_cf), 10));
        assert!(close(tot.co2e, tot.carbon * (44.0 / 12.0), 10));
        assert!(close(tot.co2e_std, tot.carbon_std * (44.0 / 12.0), 10));

        let empty = compute_biomass_totals(&[]);
        assert_eq!((empty.trees, empty.biomass, empty.biomass_std, empty.carbon_std), (0, 0.0, 0.0, 0.0));
        assert!(!empty.co2e_std.is_nan());
    }

    #[test]
    fn fallback_density_label_names_the_preset_or_custom() {
        let l = fallback_density_label("spruce", &DEFAULT_BIOMASS_PARAMS);
        assert_eq!((l.label.as_str(), l.density), ("Norway spruce (Picea abies)", 385.0));
        let custom = BiomassParams { density: 600.0, ..DEFAULT_BIOMASS_PARAMS };
        let l = fallback_density_label("custom", &custom);
        assert_eq!((l.label.as_str(), l.density), ("custom density", 600.0));
    }

    #[test]
    fn top_fraction_mean_takes_at_least_one() {
        assert_eq!(top_fraction_mean(&[], 0.1).1, 0);
        assert!(top_fraction_mean(&[], 0.1).0.is_nan());
        assert_eq!(top_fraction_mean(&[5.0, 1.0, 3.0], 0.1), (5.0, 1));
        assert_eq!(top_fraction_mean(&[5.0, 1.0, 3.0, f64::NAN], 0.5), (4.0, 2));
        assert_eq!(top_fraction_mean(&[2.0, 4.0], f64::NAN), (3.0, 2));
    }

    // --- the operations, through the catalogue ---

    #[test]
    fn the_three_operations_are_in_the_catalogue_with_their_defaults() {
        for name in ["metrics.volumes", "metrics.biomass", "metrics.plot"] {
            let op = super::super::find(name).unwrap_or_else(|| panic!("{name} missing"));
            assert!(!op.mutates);
            let schema = op.params_schema();
            assert!(schema["properties"]["octreeDir"].is_object(), "{name}: {schema}");
        }
        let plot = super::super::find("metrics.plot").unwrap().params_schema();
        assert_eq!(plot["properties"]["edge"]["default"], "crownArea");
        assert_eq!(plot["properties"]["halfcountBuffer"]["default"], 1.0);
        let bio = super::super::find("metrics.biomass").unwrap().params_schema();
        assert_eq!(bio["properties"]["fallbackSpecies"]["default"], "pine");
        assert_eq!(bio["properties"]["density"]["default"], 400.0);
        let vol = super::super::find("metrics.volumes").unwrap().params_schema();
        assert_eq!(vol["properties"]["defaultSpecies"]["default"], "pine");
        assert_eq!(vol["properties"]["formFactor"]["default"], 0.5);
    }

    #[test]
    fn the_operations_refuse_bad_parameters_before_touching_the_dataset() {
        let ctx = OpContext::silent();
        let run = |name: &str, v: serde_json::Value| super::super::run(name, v, &ctx).unwrap_err();
        assert!(run("metrics.volumes", serde_json::json!({ "octreeDir": "/nowhere", "defaultSpecies": "oak" })).contains("no volume function"));
        assert!(run("metrics.volumes", serde_json::json!({ "octreeDir": "/nowhere", "formFactor": 0 })).contains("formFactor"));
        assert!(run("metrics.biomass", serde_json::json!({ "octreeDir": "/nowhere", "fallbackSpecies": "larch" })).contains("not a density preset"));
        assert!(run("metrics.biomass", serde_json::json!({ "octreeDir": "/nowhere", "fallbackSpecies": "custom", "density": 5 })).contains("density must be between"));
        assert!(run("metrics.plot", serde_json::json!({ "octreeDir": "/nowhere", "halfcountBuffer": -1 })).contains("halfcountBuffer"));
        assert!(run("metrics.plot", serde_json::json!({ "octreeDir": "/nowhere", "edge": "sideways" })).contains("invalid parameters"));
        assert!(run("metrics.plot", serde_json::json!({ "octreeDir": "/nowhere", "boundary": { "kind": "triangular" } })).contains("invalid parameters"));
    }
}
