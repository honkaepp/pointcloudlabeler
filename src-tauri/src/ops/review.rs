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

//! The per-tree records a reviewer keeps beside a dataset: review
//! verdicts (`review.json`), species (`species.json`), the plot boundary
//! (`plot.json`) and the merge map (`treemap.json`). Tree Review writes
//! them from the GUI; here they are read and written whole, through the
//! same validating, atomic writers.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{non_empty, OpContext, OpDef};
use crate::commands::octree::{
    octree_read_plot, octree_read_review, octree_read_species, octree_read_treemap, octree_write_plot,
    octree_write_review, octree_write_species,
};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
}

fn parse_map(text: &str, what: &str) -> Result<BTreeMap<String, String>, String> {
    if text.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    serde_json::from_str(text).map_err(|e| format!("parse {what}: {e}"))
}

/// A review verdict per tree.
#[derive(Serialize, Deserialize, JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// Inspected and accepted.
    Ok,
    /// Inspected and found wanting.
    Flag,
}

impl Verdict {
    fn as_str(self) -> &'static str {
        match self {
            Verdict::Ok => "ok",
            Verdict::Flag => "flag",
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewState {
    /// Tree id → verdict; a tree absent here is unreviewed.
    pub verdicts: BTreeMap<String, String>,
    pub reviewed: usize,
    pub ok: usize,
    pub flagged: usize,
}

fn state_from(map: BTreeMap<String, String>) -> ReviewState {
    let ok = map.values().filter(|v| v.as_str() == "ok").count();
    let flagged = map.values().filter(|v| v.as_str() == "flag").count();
    ReviewState { reviewed: map.len(), ok, flagged, verdicts: map }
}

fn review_get(_ctx: &OpContext, p: DirParams) -> Result<ReviewState, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    Ok(state_from(parse_map(&octree_read_review(p.octree_dir)?, "review.json")?))
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSetParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Tree id → "ok" | "flag", or null to forget a verdict.
    pub verdicts: BTreeMap<String, Option<Verdict>>,
    /// Replace the whole file rather than merging into it (default false).
    #[serde(default)]
    pub replace: bool,
}

fn review_set(_ctx: &OpContext, p: ReviewSetParams) -> Result<ReviewState, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let mut map = if p.replace { BTreeMap::new() } else { parse_map(&octree_read_review(p.octree_dir.clone())?, "review.json")? };
    for (id, v) in p.verdicts {
        if id.parse::<i64>().is_err() {
            return Err(format!("'{id}' is not a tree id"));
        }
        match v {
            Some(v) => { map.insert(id, v.as_str().to_string()); }
            None => { map.remove(&id); }
        }
    }
    let text = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    octree_write_review(p.octree_dir, text)?;
    Ok(state_from(map))
}

fn species_get(_ctx: &OpContext, p: DirParams) -> Result<BTreeMap<String, String>, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    parse_map(&octree_read_species(p.octree_dir)?, "species.json")
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeciesSetParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// Tree id → species key ("pine", "spruce", "birch", "aspen", "oak", …), or null to clear.
    pub species: BTreeMap<String, Option<String>>,
    /// Replace the whole file rather than merging into it.
    #[serde(default)]
    pub replace: bool,
}

fn species_set(_ctx: &OpContext, p: SpeciesSetParams) -> Result<BTreeMap<String, String>, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let mut map = if p.replace { BTreeMap::new() } else { parse_map(&octree_read_species(p.octree_dir.clone())?, "species.json")? };
    for (id, v) in p.species {
        if id.parse::<i64>().is_err() {
            return Err(format!("'{id}' is not a tree id"));
        }
        match v {
            Some(s) if !s.trim().is_empty() => { map.insert(id, s); }
            _ => { map.remove(&id); }
        }
    }
    let text = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    octree_write_species(p.octree_dir, text)?;
    Ok(map)
}

fn plot_get(_ctx: &OpContext, p: DirParams) -> Result<Value, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let text = octree_read_plot(p.octree_dir)?;
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(&text).map_err(|e| format!("parse plot.json: {e}"))
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlotSetParams {
    /// The dataset directory (`<project>/octrees/<name>`).
    pub octree_dir: String,
    /// `{"kind":"circular","center":[x,y],"radius":r}`,
    /// `{"kind":"rectangular","min":[x,y],"max":[x,y]}`, or `{}` for none.
    pub boundary: Value,
}

fn plot_set(_ctx: &OpContext, p: PlotSetParams) -> Result<Value, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let obj = p.boundary.as_object().ok_or_else(|| "boundary must be a JSON object".to_string())?;
    match obj.get("kind").and_then(|k| k.as_str()) {
        None if obj.is_empty() => {}
        Some("circular") => {
            let r = obj.get("radius").and_then(|v| v.as_f64()).ok_or("a circular boundary needs a positive radius")?;
            let c = obj.get("center").and_then(|v| v.as_array()).filter(|a| a.len() == 2 && a.iter().all(|x| x.as_f64().is_some_and(f64::is_finite)));
            if !(r.is_finite() && r > 0.0) || c.is_none() {
                return Err("a circular boundary needs center [x, y] and a positive radius".into());
            }
        }
        Some("rectangular") => {
            let ok = ["min", "max"].iter().all(|k| obj.get(*k).and_then(|v| v.as_array()).is_some_and(|a| a.len() == 2 && a.iter().all(|x| x.as_f64().is_some_and(f64::is_finite))));
            if !ok {
                return Err("a rectangular boundary needs min [x, y] and max [x, y]".into());
            }
        }
        Some(other) => return Err(format!("unknown boundary kind '{other}': use circular or rectangular")),
        None => return Err("boundary needs a kind (circular or rectangular), or be {} for none".into()),
    }
    octree_write_plot(p.octree_dir, p.boundary.to_string())?;
    Ok(p.boundary)
}

fn treemap_get(_ctx: &OpContext, p: DirParams) -> Result<Value, String> {
    non_empty(&p.octree_dir, "octreeDir")?;
    let text = octree_read_treemap(p.octree_dir)?;
    if text.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(&text).map_err(|e| format!("parse treemap.json: {e}"))
}

pub(super) fn ops() -> Vec<OpDef> {
    vec![
        op!("review.get", Review, mutates: false, stage: None,
            "The review verdicts (ok / flag) recorded for a dataset's trees.", DirParams, review_get),
        op!("review.set", Review, mutates: true, stage: None,
            "Record or clear review verdicts for trees, merged into review.json.", ReviewSetParams, review_set),
        op!("review.species", Review, mutates: false, stage: None,
            "The species assigned to a dataset's trees.", DirParams, species_get),
        op!("review.setSpecies", Review, mutates: true, stage: None,
            "Assign or clear species for trees, merged into species.json.", SpeciesSetParams, species_set),
        op!("review.plot", Review, mutates: false, stage: None,
            "The plot boundary recorded for a dataset.", DirParams, plot_get),
        op!("review.setPlot", Review, mutates: true, stage: None,
            "Record a circular or rectangular plot boundary (or none) for per-hectare statistics.", PlotSetParams, plot_set),
        op!("review.treemap", Review, mutates: false, stage: None,
            "The tree merge map (from id → to id) the editor's merges produced.", DirParams, treemap_get),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pcl-ops-review-{}-{}", std::process::id(), rand_tag()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rand_tag() -> u128 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    }

    #[test]
    fn verdicts_merge_clear_and_replace() {
        let dir = scratch();
        let d = dir.to_string_lossy().to_string();
        let ctx = OpContext::silent();
        let run = |name: &str, v: Value| super::super::run(name, v, &ctx);
        let empty = run("review.get", json!({ "octreeDir": d })).unwrap();
        assert_eq!(empty["reviewed"], 0);
        let s = run("review.set", json!({ "octreeDir": d, "verdicts": { "12": "ok", "50": "flag" } })).unwrap();
        assert_eq!(s["reviewed"], 2);
        assert_eq!(s["ok"], 1);
        assert_eq!(s["flagged"], 1);
        let s = run("review.set", json!({ "octreeDir": d, "verdicts": { "12": null, "7": "ok" } })).unwrap();
        assert_eq!(s["verdicts"], json!({ "50": "flag", "7": "ok" }));
        // The file is what Tree Review reads: a flat id → verdict map.
        let on_disk: BTreeMap<String, String> = serde_json::from_str(&std::fs::read_to_string(dir.join("review.json")).unwrap()).unwrap();
        assert_eq!(on_disk.get("50").map(String::as_str), Some("flag"));
        let s = run("review.set", json!({ "octreeDir": d, "verdicts": { "1": "ok" }, "replace": true })).unwrap();
        assert_eq!(s["reviewed"], 1);
        assert!(run("review.set", json!({ "octreeDir": d, "verdicts": { "x": "ok" } })).unwrap_err().contains("not a tree id"));
        assert!(run("review.set", json!({ "octreeDir": d, "verdicts": { "1": "maybe" } })).unwrap_err().contains("invalid parameters"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn species_and_the_plot_boundary_are_validated_and_written() {
        let dir = scratch();
        let d = dir.to_string_lossy().to_string();
        let ctx = OpContext::silent();
        let run = |name: &str, v: Value| super::super::run(name, v, &ctx);
        let s = run("review.setSpecies", json!({ "octreeDir": d, "species": { "3": "pine", "4": "spruce" } })).unwrap();
        assert_eq!(s, json!({ "3": "pine", "4": "spruce" }));
        let s = run("review.setSpecies", json!({ "octreeDir": d, "species": { "3": null } })).unwrap();
        assert_eq!(s, json!({ "4": "spruce" }));
        assert_eq!(run("review.species", json!({ "octreeDir": d })).unwrap(), json!({ "4": "spruce" }));

        assert_eq!(run("review.plot", json!({ "octreeDir": d })).unwrap(), json!({}));
        let b = json!({ "kind": "circular", "center": [500010.0, 6900010.0], "radius": 12.62 });
        assert_eq!(run("review.setPlot", json!({ "octreeDir": d, "boundary": b })).unwrap(), b);
        assert_eq!(run("review.plot", json!({ "octreeDir": d })).unwrap(), b);
        let err = run("review.setPlot", json!({ "octreeDir": d, "boundary": { "kind": "circular", "radius": -1 } })).unwrap_err();
        assert!(err.contains("positive radius"), "{err}");
        let err = run("review.setPlot", json!({ "octreeDir": d, "boundary": { "kind": "hexagonal" } })).unwrap_err();
        assert!(err.contains("unknown boundary kind"), "{err}");
        assert_eq!(run("review.setPlot", json!({ "octreeDir": d, "boundary": {} })).unwrap(), json!({}));
        assert_eq!(run("review.treemap", json!({ "octreeDir": d })).unwrap(), json!({}));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
