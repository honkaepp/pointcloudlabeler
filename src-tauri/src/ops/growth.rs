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

//! Multi-temporal per-tree increment between two epochs
//! (`src/metrics/growth.ts`): match the same tree across two scans on
//! its stem base, then difference what was measured. A difference is
//! only a growth figure when BOTH epochs measured the thing being
//! differenced: a stem circle that fitted in one scan and not the
//! other says nothing about growth, and substituting a zero would turn
//! a measurement failure into the tree's entire volume as an increment
//! or a loss.

use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::csvtext::csv_num;
use super::matching::{match_by_position, MatchMethod};
use super::qc::merge_stem_fits;
use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::{octree_read_stems, run_tree_metrics, TreeMetric};

#[derive(Clone, Debug)]
pub struct Pair {
    pub reference: TreeMetric,
    pub now: TreeMetric,
    pub distance: f64,
}

#[derive(Clone, Debug)]
pub struct GrowthResult {
    pub matches: Vec<Pair>,
    /// Reference trees with no partner now: harvested / fallen.
    pub harvested: Vec<TreeMetric>,
    /// Active trees with no partner before: ingrowth / new.
    pub ingrowth: Vec<TreeMetric>,
}

/// The optimal assignment on stem-base XY within `radius`: the base is
/// the one point on a leaning or swaying stem that does not move
/// between scans.
pub fn match_trees(refs: &[TreeMetric], nows: &[TreeMetric], radius: f64) -> GrowthResult {
    let a: Vec<[f64; 2]> = refs.iter().map(|t| [t.x, t.y]).collect();
    let b: Vec<[f64; 2]> = nows.iter().map(|t| [t.x, t.y]).collect();
    let r = match_by_position(&a, &b, radius, MatchMethod::Optimal);
    GrowthResult {
        matches: r.matches.iter().map(|p| Pair { reference: refs[p.a].clone(), now: nows[p.b].clone(), distance: p.distance }).collect(),
        harvested: r.unmatched_a.iter().map(|i| refs[*i].clone()).collect(),
        ingrowth: r.unmatched_b.iter().map(|j| nows[*j].clone()).collect(),
    }
}

/// Form-factor stem volume (m³): basal area × height × f; NaN when the
/// stem circle could not be fitted, and that NaN is the point.
pub fn vol(t: &TreeMetric, f: f64) -> f64 {
    if t.basal_area.is_finite() { t.basal_area * t.height * f } else { f64::NAN }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Matched pairs.
    pub n: usize,
    /// Pairs where both epochs produced a DBH.
    pub n_dbh_pairs: usize,
    /// Pairs where both epochs produced a volume.
    pub n_vol_pairs: usize,
    /// Mean DBH increment, metres, over `n_dbh_pairs`.
    pub mean_ddbh: f64,
    /// Mean height increment, metres, over the pairs with both heights.
    pub mean_dh: f64,
    /// Σ volume increment, m³, over `n_vol_pairs`.
    pub sum_dv: f64,
    pub harvested_count: usize,
    pub harvested_vol: f64,
    /// Harvested trees with no fitted stem, so no volume to remove.
    pub harvested_unmeasured: usize,
    pub ingrowth_count: usize,
    pub ingrowth_vol: f64,
    pub ingrowth_unmeasured: usize,
}

fn sum_measured(values: impl Iterator<Item = f64>) -> (f64, usize) {
    let (mut sum, mut missing) = (0.0, 0);
    for v in values {
        if v.is_finite() { sum += v } else { missing += 1 }
    }
    (sum, missing)
}

pub fn summarise(res: &GrowthResult, f: f64) -> Summary {
    let (mut sum_ddbh, mut n_dbh, mut sum_dh, mut n_h, mut sum_dv, mut n_vol) = (0.0, 0, 0.0, 0, 0.0, 0);
    for m in &res.matches {
        if m.now.dbh.is_finite() && m.reference.dbh.is_finite() {
            sum_ddbh += m.now.dbh - m.reference.dbh;
            n_dbh += 1;
        }
        if m.now.height.is_finite() && m.reference.height.is_finite() {
            sum_dh += m.now.height - m.reference.height;
            n_h += 1;
        }
        let (v_now, v_ref) = (vol(&m.now, f), vol(&m.reference, f));
        if v_now.is_finite() && v_ref.is_finite() {
            sum_dv += v_now - v_ref;
            n_vol += 1;
        }
    }
    let harvested = sum_measured(res.harvested.iter().map(|t| vol(t, f)));
    let ingrowth = sum_measured(res.ingrowth.iter().map(|t| vol(t, f)));
    Summary {
        n: res.matches.len(),
        n_dbh_pairs: n_dbh,
        n_vol_pairs: n_vol,
        mean_ddbh: if n_dbh > 0 { sum_ddbh / n_dbh as f64 } else { 0.0 },
        mean_dh: if n_h > 0 { sum_dh / n_h as f64 } else { 0.0 },
        sum_dv,
        harvested_count: res.harvested.len(),
        harvested_vol: harvested.0,
        harvested_unmeasured: harvested.1,
        ingrowth_count: res.ingrowth.len(),
        ingrowth_vol: ingrowth.0,
        ingrowth_unmeasured: ingrowth.1,
    }
}

/// The Tree Growth panel's CSV, column for column.
pub fn growth_csv(res: &GrowthResult, f: f64) -> String {
    let mut out = String::from("status,ref_id,now_id,x,y,dbh_ref_cm,dbh_now_cm,ddbh_cm,h_ref_m,h_now_m,dh_m,v_ref_m3,v_now_m3,dv_m3\n");
    let cm = |m: f64| csv_num(m * 100.0, 1);
    for m in &res.matches {
        let (r, n) = (&m.reference, &m.now);
        out.push_str(&[
            "grown".to_string(), r.tree_id.to_string(), n.tree_id.to_string(), csv_num(n.x, 3), csv_num(n.y, 3),
            cm(r.dbh), cm(n.dbh), csv_num((n.dbh - r.dbh) * 100.0, 1),
            csv_num(r.height, 2), csv_num(n.height, 2), csv_num(n.height - r.height, 2),
            csv_num(vol(r, f), 4), csv_num(vol(n, f), 4), csv_num(vol(n, f) - vol(r, f), 4),
        ].join(","));
        out.push('\n');
    }
    for t in &res.harvested {
        out.push_str(&["harvested".to_string(), t.tree_id.to_string(), String::new(), csv_num(t.x, 3), csv_num(t.y, 3), cm(t.dbh), String::new(), String::new(), csv_num(t.height, 2), String::new(), String::new(), csv_num(vol(t, f), 4), String::new(), String::new()].join(","));
        out.push('\n');
    }
    for t in &res.ingrowth {
        out.push_str(&["ingrowth".to_string(), String::new(), t.tree_id.to_string(), csv_num(t.x, 3), csv_num(t.y, 3), String::new(), cm(t.dbh), String::new(), String::new(), csv_num(t.height, 2), String::new(), String::new(), csv_num(vol(t, f), 4), String::new()].join(","));
        out.push('\n');
    }
    out
}

// --- the operation ------------------------------------------------------------

fn f_0_25() -> f64 { 0.25 }
fn f_0_5() -> f64 { 0.5 }
fn f_1_2() -> f64 { 1.2 }
fn f_1_4() -> f64 { 1.4 }
fn f_1_5() -> f64 { 1.5 }
fn f_5() -> f64 { 5.0 }
fn yes() -> bool { true }

/// The Tree Growth panel's defaults.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrowthParams {
    /// The later (active) dataset directory.
    pub octree_dir: String,
    /// The earlier (reference) dataset directory; both must be in one coordinate frame (register first).
    pub reference_dir: String,
    /// Years between the two scans (default 5).
    #[serde(default = "f_5")]
    pub years: f64,
    /// Match radius on the stem base, metres (default 1.5).
    #[serde(default = "f_1_5")]
    pub search_radius: f64,
    /// Form factor for the volume estimate, V = g · h · f (default 0.50).
    #[serde(default = "f_0_5")]
    pub form_factor: f64,
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
    /// Write the pairs, the harvested and the ingrowth as CSV here (the panel's "Export CSV").
    #[serde(default)]
    pub out_csv: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MatchedPair {
    pub ref_id: i32,
    pub now_id: i32,
    pub distance: f64,
    /// DBH increment, metres; null when either epoch has no DBH.
    pub ddbh: f64,
    pub dh: f64,
    /// Volume increment, m³; null when either epoch has no volume.
    pub dv: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GrowthReport {
    pub years: f64,
    pub search_radius: f64,
    pub form_factor: f64,
    pub reference_trees: usize,
    pub active_trees: usize,
    #[serde(flatten)]
    pub summary: Summary,
    /// The report's per-year figures.
    pub mean_dbh_growth_cm_per_year: f64,
    pub mean_height_growth_m_per_year: f64,
    pub volume_change_m3: f64,
    pub matches: Vec<MatchedPair>,
    pub harvested_ids: Vec<i32>,
    pub ingrowth_ids: Vec<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csv_path: Option<String>,
}

fn measured(ctx: &OpContext, dir: &str, p: &GrowthParams) -> Result<Vec<TreeMetric>, String> {
    let sink = ctx.progress.under("metrics");
    let metrics = run_tree_metrics(&sink, dir, p.crown_cell, p.bh_low, p.bh_high, p.dtm_cell)?;
    let stems = if p.merge_stems { octree_read_stems(dir.to_string())? } else { None };
    Ok(merge_stem_fits(&metrics, stems.as_deref()).into_iter().map(|m| m.metric).collect())
}

fn change_growth(ctx: &OpContext, p: GrowthParams) -> Result<GrowthReport, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    non_empty(&p.reference_dir, "referenceDir")?;
    if !(p.years.is_finite() && p.years > 0.0) {
        return Err("years must be positive".into());
    }
    if !(p.search_radius.is_finite() && p.search_radius >= 0.0) {
        return Err("searchRadius must be zero or positive".into());
    }
    if !(p.form_factor.is_finite() && p.form_factor > 0.0) {
        return Err("formFactor must be positive".into());
    }
    if let Some(out) = &p.out_csv {
        non_empty(out, "outCsv")?;
        if let Some(parent) = Path::new(out).parent().filter(|d| !d.as_os_str().is_empty()) {
            if !parent.is_dir() {
                return Err(format!("{} is not a directory", parent.display()));
            }
        }
    }
    let refs = measured(ctx, &p.reference_dir, &p)?;
    let nows = measured(ctx, &p.octree_dir, &p)?;
    let res = match_trees(&refs, &nows, p.search_radius);
    let summary = summarise(&res, p.form_factor);
    let csv_path = match &p.out_csv {
        Some(out) => {
            std::fs::write(out, growth_csv(&res, p.form_factor)).map_err(|e| format!("write {out}: {e}"))?;
            Some(out.clone())
        }
        None => None,
    };
    let f = p.form_factor;
    Ok(GrowthReport {
        years: p.years,
        search_radius: p.search_radius,
        form_factor: f,
        reference_trees: refs.len(),
        active_trees: nows.len(),
        mean_dbh_growth_cm_per_year: summary.mean_ddbh * 100.0 / p.years,
        mean_height_growth_m_per_year: summary.mean_dh / p.years,
        volume_change_m3: summary.sum_dv,
        matches: res
            .matches
            .iter()
            .map(|m| MatchedPair {
                ref_id: m.reference.tree_id,
                now_id: m.now.tree_id,
                distance: m.distance,
                ddbh: m.now.dbh - m.reference.dbh,
                dh: m.now.height - m.reference.height,
                dv: vol(&m.now, f) - vol(&m.reference, f),
            })
            .collect(),
        harvested_ids: res.harvested.iter().map(|t| t.tree_id).collect(),
        ingrowth_ids: res.ingrowth.iter().map(|t| t.tree_id).collect(),
        summary,
        csv_path,
    })
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![op!("change.growth", Change, mutates: false, stage: Some("metrics"),
        "Per-tree growth between two epochs: match stems by position, difference DBH, height and volume where both scans measured them; harvested and ingrowth lists.", GrowthParams, change_growth)]
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
            basal_area: if dbh.is_finite() { std::f64::consts::PI * (dbh / 2.0).powi(2) } else { f64::NAN },
            crown_area: 25.0,
            crown_diameter: 5.6,
            x,
            y,
            base_z: 0.0,
            lean_deg: 0.0,
        }
    }

    const F: f64 = 0.5;

    fn close(a: f64, b: f64, digits: i32) -> bool {
        (a - b).abs() < 10f64.powi(-digits) / 2.0
    }

    fn ids(ts: &[TreeMetric]) -> Vec<i32> {
        ts.iter().map(|t| t.tree_id).collect()
    }

    #[test]
    fn pairs_each_tree_with_its_own_stem_and_leaves_the_rest_unclaimed() {
        let refs = [tree(1, 0.0, 0.0, 0.20, 18.0), tree(2, 5.0, 0.0, 0.25, 20.0), tree(3, 10.0, 0.0, 0.30, 22.0)];
        let nows = [tree(11, 0.05, 0.02, 0.21, 18.4), tree(13, 10.03, 0.0, 0.31, 22.3), tree(14, 20.0, 0.0, 0.08, 6.0)];
        let r = match_trees(&refs, &nows, 1.0);
        let mut pairs: Vec<(i32, i32)> = r.matches.iter().map(|m| (m.reference.tree_id, m.now.tree_id)).collect();
        pairs.sort();
        assert_eq!(pairs, vec![(1, 11), (3, 13)]);
        assert_eq!(ids(&r.harvested), vec![2]);
        assert_eq!(ids(&r.ingrowth), vec![14]);

        let refs = [tree(1, 0.0, 0.0, 0.2, 18.0), tree(2, 0.6, 0.0, 0.2, 18.0)];
        let r = match_trees(&refs, &[tree(9, 0.55, 0.0, 0.21, 18.0)], 1.0);
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].reference.tree_id, 2);
        assert_eq!(ids(&r.harvested), vec![1]);

        let refs = [tree(1, 0.0, 0.0, 0.2, 18.0), tree(2, 0.1, 0.0, 0.2, 18.0), tree(3, 0.2, 0.0, 0.2, 18.0)];
        let r = match_trees(&refs, &[tree(9, 0.05, 0.0, 0.2, 18.0)], 5.0);
        assert_eq!((r.matches.len(), r.harvested.len()), (1, 2));

        let r = match_trees(&[tree(1, 0.0, 0.0, 0.2, 18.0)], &[tree(2, 3.0, 0.0, 0.2, 18.0)], 1.0);
        assert_eq!((r.matches.len(), r.harvested.len(), r.ingrowth.len()), (0, 1, 1));
    }

    #[test]
    fn differences_only_where_both_epochs_measured() {
        let refs = [tree(1, 0.0, 0.0, 0.30, 20.0), tree(2, 5.0, 0.0, 0.30, 20.0)];
        let nows = [tree(1, 0.0, 0.0, 0.31, 20.5), tree(2, 5.0, 0.0, f64::NAN, 20.5)];
        let s = summarise(&match_trees(&refs, &nows, 1.0), F);
        assert_eq!((s.n, s.n_vol_pairs), (2, 1));
        let expected = vol(&nows[0], F) - vol(&refs[0], F);
        assert!(close(s.sum_dv, expected, 12) && s.sum_dv > 0.0);
        assert!(expected + (0.0 - vol(&refs[1], F)) < 0.0, "the naive figure would say the plot shrank");

        let refs: Vec<TreeMetric> = (0..10).map(|i| tree(i, i as f64 * 5.0, 0.0, 0.3, 20.0)).collect();
        let nows: Vec<TreeMetric> = refs.iter().enumerate().map(|(i, t)| tree(t.tree_id, t.x, t.y, if i < 3 { f64::NAN } else { 0.31 }, 20.4)).collect();
        let s = summarise(&match_trees(&refs, &nows, 1.0), F);
        assert_eq!((s.n, s.n_vol_pairs, s.n_dbh_pairs), (10, 7, 7));

        let refs = [tree(1, 0.0, 0.0, 0.30, 20.0), tree(2, 5.0, 0.0, f64::NAN, 18.0)];
        let s = summarise(&match_trees(&refs, &[], 1.0), F);
        assert_eq!((s.harvested_count, s.harvested_unmeasured), (2, 1));
        assert!(close(s.harvested_vol, vol(&refs[0], F), 12) && s.harvested_vol.is_finite());

        let nows = [tree(1, 0.0, 0.0, 0.08, 6.0), tree(2, 5.0, 0.0, f64::NAN, 5.0)];
        let s = summarise(&match_trees(&[], &nows, 1.0), F);
        assert_eq!((s.ingrowth_count, s.ingrowth_unmeasured), (2, 1));
        assert!(close(s.ingrowth_vol, vol(&nows[0], F), 12));

        let refs = [tree(1, 0.0, 0.0, 0.30, 20.0), tree(2, 5.0, 0.0, f64::NAN, 20.0)];
        let nows = [tree(1, 0.0, 0.0, 0.32, 20.0), tree(2, 5.0, 0.0, 0.28, 20.0)];
        let s = summarise(&match_trees(&refs, &nows, 1.0), F);
        assert_eq!(s.n_dbh_pairs, 1);
        assert!(close(s.mean_ddbh, 0.02, 12));
    }

    #[test]
    fn recovers_a_known_increment_and_an_empty_comparison_is_zero() {
        let refs: Vec<TreeMetric> = (0..10).map(|i| tree(i, i as f64 * 4.0, 0.0, 0.25, 19.0)).collect();
        let nows: Vec<TreeMetric> = refs.iter().map(|t| tree(t.tree_id, t.x, t.y, 0.26, 19.4)).collect();
        let s = summarise(&match_trees(&refs, &nows, 1.0), F);
        assert_eq!(s.n, 10);
        assert!(close(s.mean_ddbh, 0.01, 12) && close(s.mean_dh, 0.4, 12));
        let per = vol(&nows[0], F) - vol(&refs[0], F);
        assert!(close(s.sum_dv, per * 10.0, 10));
        assert_eq!((s.harvested_count, s.ingrowth_count), (0, 0));

        let s = summarise(&GrowthResult { matches: vec![], harvested: vec![], ingrowth: vec![] }, F);
        assert_eq!((s.mean_ddbh, s.mean_dh, s.sum_dv), (0.0, 0.0, 0.0));
        assert!(!s.harvested_vol.is_nan() && !s.ingrowth_vol.is_nan());

        assert!(vol(&tree(1, 0.0, 0.0, f64::NAN, 20.0), F).is_nan());
        assert!(close(vol(&tree(1, 0.0, 0.0, 0.30, 20.0), F), std::f64::consts::PI * 0.15 * 0.15 * 20.0 * F, 12));
    }

    #[test]
    fn the_csv_is_the_panels_columns() {
        let refs = [tree(1, 0.0, 0.0, 0.30, 20.0), tree(2, 5.0, 0.0, f64::NAN, 18.0)];
        let nows = [tree(11, 0.0, 0.0, 0.32, 20.5), tree(14, 20.0, 0.0, 0.08, 6.0)];
        let res = match_trees(&refs, &nows, 1.0);
        let csv = growth_csv(&res, F);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "status,ref_id,now_id,x,y,dbh_ref_cm,dbh_now_cm,ddbh_cm,h_ref_m,h_now_m,dh_m,v_ref_m3,v_now_m3,dv_m3");
        assert!(lines[1].starts_with("grown,1,11,0.000,0.000,30.0,32.0,2.0,20.00,20.50,0.50,"));
        assert_eq!(lines[2], "harvested,2,,5.000,0.000,,,,18.00,,,,,");
        assert!(lines[3].starts_with("ingrowth,,14,20.000,0.000,,8.0,,,6.00,,,"));
        assert!(!csv.contains("NaN"));
    }

    #[test]
    fn the_operation_is_catalogued_and_refuses_bad_parameters_first() {
        let op = super::super::find("change.growth").expect("change.growth");
        assert!(!op.mutates);
        let schema = op.params_schema();
        assert_eq!(schema["properties"]["years"]["default"], 5.0);
        assert_eq!(schema["properties"]["searchRadius"]["default"], 1.5);
        assert_eq!(schema["properties"]["formFactor"]["default"], 0.5);
        let ctx = OpContext::silent();
        let run = |v: serde_json::Value| super::super::run("change.growth", v, &ctx).unwrap_err();
        assert!(run(serde_json::json!({ "octreeDir": "/a" })).contains("referenceDir"));
        assert!(run(serde_json::json!({ "octreeDir": "/a", "referenceDir": "/b", "years": 0 })).contains("years"));
        assert!(run(serde_json::json!({ "octreeDir": "/a", "referenceDir": "/b", "searchRadius": -1 })).contains("searchRadius"));
    }
}
