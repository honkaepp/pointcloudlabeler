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

//! Field-data validation (`src/metrics/fieldValidation.ts`): read a
//! field crew's CSV (id, x, y, caliper DBH in cm, hypsometer height),
//! match each field tree to the nearest measured tree within a radius,
//! and report bias, RMSE and the least-squares fit of the measured
//! against the calipered diameter and height. Anything that gets into
//! these figures IS the answer to "how accurate is it", so a pair with
//! an unmeasured side (a height of 0 is unmeasured, not short) is left
//! out and counted.

use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::csvtext::{csv_field, csv_num, csv_unguard, parse_csv, parse_number};
use super::matching::{match_by_position, MatchMethod};
use super::qc::merge_stem_fits;
use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::{octree_read_stems, run_tree_metrics, TreeMetric};

/// Which CSV column holds what; None for a column that is not there.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
    pub x_col: Option<usize>,
    pub y_col: Option<usize>,
    /// Caliper DBH, centimetres.
    pub dbh_col: Option<usize>,
    /// Hypsometer height, metres.
    pub height_col: Option<usize>,
    pub species_col: Option<usize>,
    pub id_col: Option<usize>,
}

/// The renderer's `autoMap`: an exact header first, then a prefixed
/// one (`dbh_cm`, `height m`), English and Finnish names.
pub fn auto_map(headers: &[String]) -> Mapping {
    let lc: Vec<String> = headers.iter().map(|h| h.trim().to_lowercase()).collect();
    let find = |names: &[&str]| -> Option<usize> {
        for n in names {
            if let Some(i) = lc.iter().position(|h| h == n) {
                return Some(i);
            }
        }
        for (i, h) in lc.iter().enumerate() {
            for n in names {
                if h.starts_with(&format!("{n}_")) || h.starts_with(&format!("{n} ")) {
                    return Some(i);
                }
            }
        }
        None
    };
    Mapping {
        x_col: find(&["x", "easting", "lon", "longitude", "gps_x"]),
        y_col: find(&["y", "northing", "lat", "latitude", "gps_y"]),
        dbh_col: find(&["dbh", "diameter", "d13", "d", "d_cm", "lapimitta"]),
        height_col: find(&["height", "h", "tot_h", "height_m", "pituus"]),
        species_col: find(&["species", "sp", "puulaji"]),
        id_col: find(&["id", "tree", "tree_no", "treenumber", "puunumero", "no"]),
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FieldTree {
    pub row_idx: usize,
    pub field_id: String,
    pub x: f64,
    pub y: f64,
    /// Caliper DBH in metres (CSV centimetres × 0.01), NaN when absent.
    pub caliper_dbh: f64,
    /// Hypsometer height in metres, NaN when absent.
    pub hyp_height: f64,
    pub species: String,
}

/// Rows to field trees: a row with no position is dropped, a row whose
/// measurements are missing is kept (the position still matches).
pub fn rows_to_field_trees(rows: &[Vec<String>], m: &Mapping, decimal_comma: bool) -> Vec<FieldTree> {
    let cell = |r: &Vec<String>, c: Option<usize>| -> Option<String> { c.and_then(|i| r.get(i)).cloned() };
    let mut out = Vec::new();
    for (i, r) in rows.iter().enumerate() {
        let x = parse_number(cell(r, m.x_col).as_deref(), decimal_comma);
        let y = parse_number(cell(r, m.y_col).as_deref(), decimal_comma);
        if !x.is_finite() || !y.is_finite() {
            continue;
        }
        out.push(FieldTree {
            row_idx: i,
            field_id: match m.id_col {
                Some(_) => csv_unguard(cell(r, m.id_col).unwrap_or_default().trim()),
                None => format!("{}", i + 1),
            },
            x,
            y,
            caliper_dbh: if m.dbh_col.is_some() { parse_number(cell(r, m.dbh_col).as_deref(), decimal_comma) * 0.01 } else { f64::NAN },
            hyp_height: if m.height_col.is_some() { parse_number(cell(r, m.height_col).as_deref(), decimal_comma) } else { f64::NAN },
            species: match m.species_col {
                Some(_) => csv_unguard(cell(r, m.species_col).unwrap_or_default().trim()),
                None => String::new(),
            },
        });
    }
    out
}

#[derive(Clone, Debug)]
pub struct Match {
    pub field: FieldTree,
    pub measured: TreeMetric,
    pub distance: f64,
}

#[derive(Clone, Debug)]
pub struct MatchOutcome {
    pub matches: Vec<Match>,
    pub unmatched_field: Vec<FieldTree>,
    pub unmatched_measured: Vec<TreeMetric>,
}

pub fn match_trees(fields: &[FieldTree], metrics: &[TreeMetric], radius: f64) -> MatchOutcome {
    let a: Vec<[f64; 2]> = fields.iter().map(|f| [f.x, f.y]).collect();
    let b: Vec<[f64; 2]> = metrics.iter().map(|t| [t.x, t.y]).collect();
    let r = match_by_position(&a, &b, radius, MatchMethod::Optimal);
    MatchOutcome {
        matches: r.matches.iter().map(|p| Match { field: fields[p.a].clone(), measured: metrics[p.b].clone(), distance: p.distance }).collect(),
        unmatched_field: r.unmatched_a.iter().map(|i| fields[*i].clone()).collect(),
        unmatched_measured: r.unmatched_b.iter().map(|j| metrics[*j].clone()).collect(),
    }
}

/// Bias, RMSE and the fit over the usable pairs (both sides finite and
/// positive). NaN slope / intercept / r² when the caliper axis has no
/// spread: no fit rather than a fabricated one.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetricStats {
    pub n: usize,
    /// Matched pairs where one side had no usable measurement.
    pub n_unusable: usize,
    /// Mean (measured − caliper); positive = overestimates.
    pub bias: f64,
    /// About the 1:1 line, so it carries the bias.
    pub rmse: f64,
    pub r2: f64,
    pub slope: f64,
    pub intercept: f64,
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
}

/// `pairs` as (caliper, measured); None below two usable pairs.
pub fn stats_for(pairs: &[(f64, f64)]) -> Option<MetricStats> {
    let (mut xs, mut ys) = (Vec::new(), Vec::new());
    let mut n_unusable = 0;
    for (c, t) in pairs {
        if c.is_finite() && *c > 0.0 && t.is_finite() && *t > 0.0 {
            xs.push(*c);
            ys.push(*t);
        } else {
            n_unusable += 1;
        }
    }
    let n = xs.len();
    if n < 2 {
        return None;
    }
    let sx = xs.iter().sum::<f64>() / n as f64;
    let sy = ys.iter().sum::<f64>() / n as f64;
    let (mut sxx, mut syy, mut sxy, mut ss) = (0.0, 0.0, 0.0, 0.0);
    for i in 0..n {
        let (dx, dy) = (xs[i] - sx, ys[i] - sy);
        sxx += dx * dx;
        syy += dy * dy;
        sxy += dx * dy;
        ss += (ys[i] - xs[i]) * (ys[i] - xs[i]);
    }
    let (mut slope, mut intercept, mut r2) = (f64::NAN, f64::NAN, f64::NAN);
    if sxx > 0.0 {
        slope = sxy / sxx;
        intercept = sy - slope * sx;
        let ss_res: f64 = (0..n).map(|i| (ys[i] - (slope * xs[i] + intercept)).powi(2)).sum();
        r2 = if syy > 0.0 { 1.0 - ss_res / syy } else { f64::NAN };
    }
    let fold = |v: &[f64], init: f64, f: fn(f64, f64) -> f64| v.iter().copied().fold(init, f);
    Some(MetricStats {
        n,
        n_unusable,
        bias: (0..n).map(|i| ys[i] - xs[i]).sum::<f64>() / n as f64,
        rmse: (ss / n as f64).sqrt(),
        r2,
        slope,
        intercept,
        x_min: fold(&xs, f64::INFINITY, f64::min),
        x_max: fold(&xs, f64::NEG_INFINITY, f64::max),
        y_min: fold(&ys, f64::INFINITY, f64::min),
        y_max: fold(&ys, f64::NEG_INFINITY, f64::max),
    })
}

/// The Validation panel's CSV: matched pairs, then the unmatched field
/// rows with every measured-side column blank.
pub fn validation_csv(r: &MatchOutcome) -> String {
    let mut out = String::from("field_id,field_x,field_y,caliper_dbh_cm,pointcloudlabeler_dbh_cm,dbh_diff_cm,hyp_height_m,pointcloudlabeler_height_m,height_diff_m,match_distance_m,status\n");
    for m in &r.matches {
        let caliper_cm = m.field.caliper_dbh * 100.0;
        let measured_cm = m.measured.dbh * 100.0;
        out.push_str(&[
            csv_field(&m.field.field_id), csv_num(m.field.x, 3), csv_num(m.field.y, 3),
            csv_num(caliper_cm, 2), csv_num(measured_cm, 2), csv_num(measured_cm - caliper_cm, 2),
            csv_num(m.field.hyp_height, 2), csv_num(m.measured.height, 2), csv_num(m.measured.height - m.field.hyp_height, 2),
            csv_num(m.distance, 3), "matched".to_string(),
        ].join(","));
        out.push('\n');
    }
    for f in &r.unmatched_field {
        out.push_str(&[
            csv_field(&f.field_id), csv_num(f.x, 3), csv_num(f.y, 3), csv_num(f.caliper_dbh * 100.0, 2),
            String::new(), String::new(), csv_num(f.hyp_height, 2), String::new(), String::new(), String::new(), "unmatched".to_string(),
        ].join(","));
        out.push('\n');
    }
    out
}

// --- the operation ------------------------------------------------------------

fn f_0_25() -> f64 { 0.25 }
fn f_0_5() -> f64 { 0.5 }
fn f_1_2() -> f64 { 1.2 }
fn f_1_4() -> f64 { 1.4 }
fn f_2() -> f64 { 2.0 }
fn yes() -> bool { true }

/// The Validation panel's inputs.
#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ValidationParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// The field crew's CSV: id, x, y, caliper DBH (cm), height (m); delimiter, header and decimal comma are detected.
    pub field_csv: String,
    /// Match radius around each field position, metres (default 2.0).
    #[serde(default = "f_2")]
    pub search_radius: f64,
    /// Column of the caliper DBH (0-based) when the header is not recognised; null auto-maps.
    #[serde(default)]
    pub dbh_col: Option<usize>,
    /// Column of the height (0-based) when the header is not recognised.
    #[serde(default)]
    pub height_col: Option<usize>,
    /// Column of X.
    #[serde(default)]
    pub x_col: Option<usize>,
    /// Column of Y.
    #[serde(default)]
    pub y_col: Option<usize>,
    /// Column of the field id.
    #[serde(default)]
    pub id_col: Option<usize>,
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
    /// Write the matched pairs and the unmatched field rows as CSV here (the panel's "Export CSV").
    #[serde(default)]
    pub out_csv: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MatchedRow {
    pub field_id: String,
    pub tree_id: i32,
    pub distance: f64,
    pub caliper_dbh: f64,
    pub measured_dbh: f64,
    pub hyp_height: f64,
    pub measured_height: f64,
}

/// What the report's field-validation block prints, in centimetres.
#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ValidationSummary {
    pub n_matched: usize,
    pub bias_cm: f64,
    pub rmse_cm: f64,
    pub r2: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub field_csv: String,
    pub delimiter: String,
    pub decimal_comma: bool,
    pub headers: Vec<String>,
    pub mapping: Mapping,
    pub search_radius: f64,
    pub field_trees: usize,
    pub measured_trees: usize,
    pub n_matched: usize,
    pub unmatched_field: usize,
    pub unmatched_measured: usize,
    /// DBH: measured against caliper, metres; null below two usable pairs.
    pub dbh: Option<MetricStats>,
    /// Height: measured against hypsometer, metres.
    pub height: Option<MetricStats>,
    /// The DBH figures as the report quotes them.
    pub summary: Option<ValidationSummary>,
    pub matches: Vec<MatchedRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csv_path: Option<String>,
}

pub fn summary_of(dbh: &MetricStats) -> ValidationSummary {
    ValidationSummary { n_matched: dbh.n, bias_cm: dbh.bias * 100.0, rmse_cm: dbh.rmse * 100.0, r2: dbh.r2 }
}

/// Parse the field CSV and map its columns, honouring the overrides.
pub fn read_field_csv(path: &str, over: &Mapping) -> Result<(super::csvtext::ParsedCsv, Mapping, Vec<FieldTree>), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("read {path}: {e}"))?;
    let parsed = parse_csv(&text).ok_or_else(|| format!("{path} is empty"))?;
    let auto = auto_map(&parsed.headers);
    let m = Mapping {
        x_col: over.x_col.or(auto.x_col),
        y_col: over.y_col.or(auto.y_col),
        dbh_col: over.dbh_col.or(auto.dbh_col),
        height_col: over.height_col.or(auto.height_col),
        species_col: over.species_col.or(auto.species_col),
        id_col: over.id_col.or(auto.id_col),
    };
    if m.x_col.is_none() || m.y_col.is_none() {
        return Err(format!("no x / y columns found in {path} (headers: {}); pass xCol and yCol", parsed.headers.join(", ")));
    }
    let n = parsed.headers.len();
    for (name, c) in [("xCol", m.x_col), ("yCol", m.y_col), ("dbhCol", m.dbh_col), ("heightCol", m.height_col), ("idCol", m.id_col)] {
        if let Some(c) = c {
            if c >= n {
                return Err(format!("{name} {c} is beyond the {n} columns of {path}"));
            }
        }
    }
    let trees = rows_to_field_trees(&parsed.rows, &m, parsed.decimal_comma);
    Ok((parsed, m, trees))
}

fn qc_validate(ctx: &OpContext, p: ValidationParams) -> Result<ValidationReport, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    non_empty(&p.field_csv, "fieldCsv")?;
    if !(p.search_radius.is_finite() && p.search_radius >= 0.0) {
        return Err("searchRadius must be zero or positive".into());
    }
    if let Some(out) = &p.out_csv {
        non_empty(out, "outCsv")?;
        if let Some(parent) = Path::new(out).parent().filter(|d| !d.as_os_str().is_empty()) {
            if !parent.is_dir() {
                return Err(format!("{} is not a directory", parent.display()));
            }
        }
    }
    let over = Mapping { x_col: p.x_col, y_col: p.y_col, dbh_col: p.dbh_col, height_col: p.height_col, species_col: None, id_col: p.id_col };
    let (parsed, mapping, fields) = read_field_csv(&p.field_csv, &over)?;
    if fields.is_empty() {
        return Err(format!("{} has no row with a position", p.field_csv));
    }

    let sink = ctx.progress.under("metrics");
    let metrics = run_tree_metrics(&sink, &p.octree_dir, p.crown_cell, p.bh_low, p.bh_high, p.dtm_cell)?;
    let stems = if p.merge_stems { octree_read_stems(p.octree_dir.clone())? } else { None };
    let rows: Vec<TreeMetric> = merge_stem_fits(&metrics, stems.as_deref()).into_iter().map(|m| m.metric).collect();

    let r = match_trees(&fields, &rows, p.search_radius);
    let dbh = stats_for(&r.matches.iter().map(|m| (m.field.caliper_dbh, m.measured.dbh)).collect::<Vec<_>>());
    let height = stats_for(&r.matches.iter().map(|m| (m.field.hyp_height, m.measured.height)).collect::<Vec<_>>());
    let csv_path = match &p.out_csv {
        Some(out) => {
            std::fs::write(out, validation_csv(&r)).map_err(|e| format!("write {out}: {e}"))?;
            Some(out.clone())
        }
        None => None,
    };
    Ok(ValidationReport {
        field_csv: p.field_csv,
        delimiter: parsed.delimiter.to_string(),
        decimal_comma: parsed.decimal_comma,
        headers: parsed.headers,
        mapping,
        search_radius: p.search_radius,
        field_trees: fields.len(),
        measured_trees: rows.len(),
        n_matched: r.matches.len(),
        unmatched_field: r.unmatched_field.len(),
        unmatched_measured: r.unmatched_measured.len(),
        summary: dbh.as_ref().map(summary_of),
        dbh,
        height,
        matches: r
            .matches
            .iter()
            .map(|m| MatchedRow {
                field_id: m.field.field_id.clone(),
                tree_id: m.measured.tree_id,
                distance: m.distance,
                caliper_dbh: m.field.caliper_dbh,
                measured_dbh: m.measured.dbh,
                hyp_height: m.field.hyp_height,
                measured_height: m.measured.height,
            })
            .collect(),
        csv_path,
    })
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![op!("qc.validate", Qc, mutates: false, stage: Some("metrics"),
        "Validate the measured trees against a field CSV: match by position, then bias, RMSE and the fit of DBH and height against the caliper and hypsometer.", ValidationParams, qc_validate)]
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn field(row_idx: usize, x: f64, y: f64, dbh: f64, h: f64) -> FieldTree {
        FieldTree { row_idx, field_id: row_idx.to_string(), x, y, caliper_dbh: dbh, hyp_height: h, species: String::new() }
    }

    fn hs(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn close(a: f64, b: f64, digits: i32) -> bool {
        (a - b).abs() < 10f64.powi(-digits) / 2.0
    }

    #[test]
    fn auto_map_finds_english_finnish_and_prefixed_headers() {
        let m = auto_map(&hs(&["id", "x", "y", "dbh", "height", "species"]));
        assert_eq!(m, Mapping { id_col: Some(0), x_col: Some(1), y_col: Some(2), dbh_col: Some(3), height_col: Some(4), species_col: Some(5) });
        assert_eq!(auto_map(&hs(&["x", "y", "dbh_cm", "height_m"])).dbh_col, Some(2));
        let m = auto_map(&hs(&["puunumero", "x", "y", "lapimitta", "pituus", "puulaji"]));
        assert_eq!((m.id_col, m.dbh_col, m.height_col, m.species_col), (Some(0), Some(3), Some(4), Some(5)));
        assert_eq!(auto_map(&hs(&[" X ", "Y", "DBH"])).dbh_col, Some(2));
        let m = auto_map(&hs(&["x", "y"]));
        assert_eq!((m.dbh_col, m.height_col), (None, None));
    }

    const M: Mapping = Mapping { x_col: Some(1), y_col: Some(2), dbh_col: Some(3), height_col: Some(4), species_col: None, id_col: Some(0) };

    #[test]
    fn rows_to_field_trees_converts_units_reads_decimal_commas_and_keeps_positions() {
        let t = &rows_to_field_trees(&[hs(&["1", "10", "20", "24.7", "18.4"])], &M, false)[0];
        assert!(close(t.caliper_dbh, 0.247, 12) && close(t.hyp_height, 18.4, 12));
        let t = &rows_to_field_trees(&[hs(&["1", "10", "20", "24,7", "18,4"])], &M, true)[0];
        assert!(close(t.caliper_dbh, 0.247, 12) && close(t.hyp_height, 18.4, 12));
        assert!(rows_to_field_trees(&[hs(&["1", "", "20", "24.7", "18"])], &M, false).is_empty());
        let t = &rows_to_field_trees(&[hs(&["1", "10", "20", "", ""])], &M, false)[0];
        assert!(t.x == 10.0 && t.caliper_dbh.is_nan() && t.hyp_height.is_nan());
        let no_id = Mapping { id_col: None, ..M };
        assert_eq!(rows_to_field_trees(&[hs(&["1", "10", "20", "24", "18"])], &no_id, false)[0].field_id, "1");
        let guarded = &rows_to_field_trees(&[hs(&["'=A1", "10", "20", "24", "18"])], &M, false)[0];
        assert_eq!(guarded.field_id, "=A1");
    }

    #[test]
    fn match_trees_pairs_nearest_within_the_radius_each_side_once() {
        let metrics = [metric(1, 0.0, 0.0, 0.30, 20.0), metric(2, 10.0, 0.0, 0.25, 18.0)];
        let r = match_trees(&[field(0, 0.4, 0.0, 0.29, 20.0), field(1, 10.2, 0.0, 0.26, 18.0)], &metrics, 2.0);
        let mut ids: Vec<i32> = r.matches.iter().map(|m| m.measured.tree_id).collect();
        ids.sort();
        assert_eq!(ids, vec![1, 2]);
        let r = match_trees(&[field(0, 0.2, 0.0, 0.3, 20.0), field(1, 0.5, 0.0, 0.3, 20.0)], &metrics[..1], 2.0);
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].field.row_idx, 0);
        assert_eq!(r.unmatched_field[0].row_idx, 1);
        let r = match_trees(&[field(0, 50.0, 50.0, 0.3, 20.0)], &metrics, 2.0);
        assert_eq!((r.matches.len(), r.unmatched_field.len(), r.unmatched_measured.len()), (0, 1, 2));
        let r = match_trees(&[field(0, 3.0, 4.0, 0.3, 20.0)], &metrics[..1], 10.0);
        assert!(close(r.matches[0].distance, 5.0, 12));
        assert!(match_trees(&[], &metrics, 2.0).matches.is_empty());
        assert!(match_trees(&[field(0, 0.0, 0.0, 0.3, 20.0)], &[], 2.0).matches.is_empty());
    }

    #[test]
    fn stats_report_bias_rmse_and_the_fit_over_usable_pairs_only() {
        let s = stats_for(&[(0.30, 0.32), (0.25, 0.27)]).unwrap();
        assert!(close(s.bias, 0.02, 12) && s.n == 2);
        let s = stats_for(&[(10.0, 11.0), (20.0, 21.0)]).unwrap();
        assert!(close(s.rmse, 1.0, 12) && close(s.bias, 1.0, 12) && close(s.rmse * s.rmse, s.bias * s.bias, 12));
        let s = stats_for(&[(1.0, 2.0), (2.0, 4.0), (3.0, 6.0)]).unwrap();
        assert!(close(s.slope, 2.0, 12) && close(s.intercept, 0.0, 12) && close(s.r2, 1.0, 12));

        let good = [(18.0, 18.1), (20.0, 19.9), (22.0, 22.2)];
        let mut with_gap = good.to_vec();
        with_gap.push((18.0, 0.0));
        let s = stats_for(&with_gap).unwrap();
        let r = stats_for(&good).unwrap();
        assert_eq!((s.n, s.n_unusable), (3, 1));
        assert!(close(s.bias, r.bias, 12) && close(s.rmse, r.rmse, 12));
        let s = stats_for(&[(18.0, 18.1), (20.0, 19.9), (0.0, 21.0)]).unwrap();
        assert_eq!((s.n, s.n_unusable), (2, 1));
        let s = stats_for(&[(18.0, 18.1), (20.0, 19.9), (f64::NAN, 20.0), (20.0, f64::NAN), (-1.0, 20.0), (20.0, -1.0)]).unwrap();
        assert_eq!((s.n, s.n_unusable), (2, 4));

        let good: Vec<(f64, f64)> = (0..19).map(|i| (18.0 + i as f64 * 0.2, 18.0 + i as f64 * 0.2 - 0.1)).collect();
        let mut with_gap = good.clone();
        with_gap.push((18.0, 0.0));
        let clean = stats_for(&with_gap).unwrap();
        let dirty_bias = with_gap.iter().map(|(c, t)| t - c).sum::<f64>() / with_gap.len() as f64;
        let dirty_rmse = (with_gap.iter().map(|(c, t)| (t - c) * (t - c)).sum::<f64>() / with_gap.len() as f64).sqrt();
        assert!(close(clean.bias, -0.1, 12));
        assert!(dirty_bias.abs() > clean.bias.abs() * 8.0 && dirty_rmse > clean.rmse * 6.0);

        let s = stats_for(&[(0.30, 0.31), (0.30, 0.29)]).unwrap();
        assert!(s.slope.is_nan() && s.intercept.is_nan() && s.r2.is_nan());
        assert!(close(s.bias, 0.0, 12) && close(s.rmse, 0.01, 12));
        assert!(stats_for(&[]).is_none() && stats_for(&[(0.3, 0.31)]).is_none() && stats_for(&[(0.3, 0.31), (0.3, 0.0)]).is_none());
        let s = stats_for(&[(10.0, 11.0), (20.0, 21.0), (5.0, 0.0)]).unwrap();
        assert_eq!((s.x_min, s.x_max, s.y_min, s.y_max), (10.0, 20.0, 11.0, 21.0));
    }

    #[test]
    fn the_csv_is_the_panels_columns_and_the_field_file_is_read_with_its_mapping() {
        let metrics = [metric(1, 0.0, 0.0, 0.30, 20.0)];
        let r = match_trees(&[field(0, 0.4, 0.0, 0.29, 19.5), field(1, 50.0, 0.0, 0.2, f64::NAN)], &metrics, 2.0);
        let csv = validation_csv(&r);
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines[0], "field_id,field_x,field_y,caliper_dbh_cm,pointcloudlabeler_dbh_cm,dbh_diff_cm,hyp_height_m,pointcloudlabeler_height_m,height_diff_m,match_distance_m,status");
        assert_eq!(lines[1], "0,0.400,0.000,29.00,30.00,1.00,19.50,20.00,0.50,0.400,matched");
        assert_eq!(lines[2], "1,50.000,0.000,20.00,,,,,,,unmatched");

        let dir = std::env::temp_dir().join(format!("pcl-validation-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("field.csv");
        std::fs::write(&path, "puunumero;x;y;lapimitta;pituus\n7;100,5;200,3;24,7;18,4\n8;;1;2;3\n").unwrap();
        let none = Mapping { x_col: None, y_col: None, dbh_col: None, height_col: None, species_col: None, id_col: None };
        let (parsed, m, trees) = read_field_csv(&path.to_string_lossy(), &none).unwrap();
        assert_eq!((parsed.delimiter, parsed.decimal_comma), (';', true));
        assert_eq!(m.dbh_col, Some(3));
        assert_eq!(trees.len(), 1);
        assert_eq!(trees[0].field_id, "7");
        assert!(close(trees[0].caliper_dbh, 0.247, 12));
        std::fs::write(&path, "a,b,c\n1,2,3\n").unwrap();
        assert!(read_field_csv(&path.to_string_lossy(), &none).unwrap_err().contains("xCol"));
        let over = Mapping { x_col: Some(1), y_col: Some(2), ..none };
        assert_eq!(read_field_csv(&path.to_string_lossy(), &over).unwrap().2.len(), 1);
        let beyond = Mapping { x_col: Some(1), y_col: Some(2), dbh_col: Some(9), ..none };
        assert!(read_field_csv(&path.to_string_lossy(), &beyond).unwrap_err().contains("beyond"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_operation_is_catalogued_and_refuses_bad_parameters_first() {
        let op = super::super::find("qc.validate").expect("qc.validate");
        assert!(!op.mutates);
        assert_eq!(op.params_schema()["properties"]["searchRadius"]["default"], 2.0);
        let ctx = OpContext::silent();
        let run = |v: serde_json::Value| super::super::run("qc.validate", v, &ctx).unwrap_err();
        assert!(run(serde_json::json!({ "octreeDir": "/a" })).contains("fieldCsv"));
        assert!(run(serde_json::json!({ "octreeDir": "/a", "fieldCsv": "/no/such.csv", "searchRadius": -1 })).contains("searchRadius"));
        assert!(run(serde_json::json!({ "octreeDir": "/a", "fieldCsv": "/no/such.csv" })).contains("read /no/such.csv"));
    }
}
