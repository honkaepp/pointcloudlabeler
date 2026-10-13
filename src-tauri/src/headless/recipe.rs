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

//! Batch recipes: one sequence of operations, run over many plots.
//!
//! A recipe is a JSON file with the steps and, optionally, the plots.
//! Each step names an operation and its parameters; a parameter value
//! may carry placeholders that are filled per plot:
//!
//! - `{{plot}}` — the plot's path as given;
//! - `{{plotName}}` — its file name without the extension;
//! - `{{dataset}}` — the dataset directory the most recent
//!   `dataset.import` (or subset, clean, downsample) in this plot's run
//!   produced;
//! - `{{project}}` — the recipe's `projectFolder`;
//! - `{{steps.<n>.<field>}}` — a field of step n's result (0-based), for
//!   wiring one step's output into another's parameters.
//!
//! Plots run one after another; a failing step ends that plot's run and
//! the next plot starts, unless `stopOnError`. The report lists every
//! step's outcome per plot, so an overnight run over two hundred plots
//! reads as a table in the morning.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ops::{self, OpContext};

#[derive(Deserialize, Serialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    /// The operation, e.g. "ground.classify".
    pub op: String,
    /// Its parameters, with placeholders.
    #[serde(default)]
    pub params: Value,
    /// Go on with the next step when this one fails (default false).
    #[serde(default)]
    pub optional: bool,
}

#[derive(Deserialize, Serialize, JsonSchema, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recipe {
    /// A name for the report.
    #[serde(default)]
    pub name: String,
    /// The project every plot is imported into; `{{project}}` in the steps.
    #[serde(default)]
    pub project_folder: Option<String>,
    /// The plots (LAS/LAZ paths, or dataset directories when the first
    /// step is not an import). `--plot` on the command line overrides.
    #[serde(default)]
    pub plots: Vec<String>,
    pub steps: Vec<Step>,
    #[serde(default)]
    pub stop_on_error: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StepReport {
    pub op: String,
    pub ok: bool,
    pub seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The result, with large arrays dropped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlotReport {
    pub plot: String,
    pub ok: bool,
    pub seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dataset: Option<String>,
    pub steps: Vec<StepReport>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub name: String,
    pub plots: Vec<PlotReport>,
    pub succeeded: usize,
    pub failed: usize,
    pub seconds: f64,
}

/// An example recipe, the manuscript's workflow on each plot.
pub fn example() -> Value {
    json!({
        "name": "plots 2023: import, ground, segment, measure, QC",
        "projectFolder": "./evo-2023",
        "plots": ["./laz/plot1001.laz", "./laz/plot1002.laz"],
        "steps": [
            { "op": "dataset.import", "params": { "srcPath": "{{plot}}", "projectFolder": "{{project}}", "scannerType": "tls" } },
            { "op": "ground.classify", "params": { "octreeDir": "{{dataset}}" } },
            { "op": "ground.terrain", "params": { "octreeDir": "{{dataset}}", "cellSize": 0.5 } },
            { "op": "segment.chm", "params": { "octreeDir": "{{dataset}}", "minHeight": 3.0 } },
            { "op": "metrics.stems", "params": { "octreeDir": "{{dataset}}" } },
            { "op": "metrics.qsm", "params": { "octreeDir": "{{dataset}}" }, "optional": true },
            { "op": "metrics.volumes", "params": { "octreeDir": "{{dataset}}", "defaultSpecies": "pine" } },
            { "op": "metrics.plot", "params": { "octreeDir": "{{dataset}}", "fit": "rectangular" } },
            { "op": "metrics.biomass", "params": { "octreeDir": "{{dataset}}" }, "optional": true },
            { "op": "metrics.bucking", "params": { "octreeDir": "{{dataset}}", "outCsv": "{{project}}/exports/{{plotName}}_bucking.csv" }, "optional": true },
            { "op": "qc.flags", "params": { "octreeDir": "{{dataset}}" } },
            { "op": "export.las", "params": { "octreeDir": "{{dataset}}", "outPath": "{{project}}/exports/{{plotName}}_segmented.laz" } },
            { "op": "export.report", "params": { "octreeDir": "{{dataset}}", "outPath": "{{project}}/exports/{{plotName}}_report.html", "projectName": "{{plotName}}" } }
        ],
        "stopOnError": false
    })
}

/// What `{{…}}` can refer to while a plot runs.
struct Scope<'a> {
    plot: &'a str,
    plot_name: String,
    project: Option<&'a str>,
    dataset: Option<String>,
    results: Vec<Option<Value>>,
}

impl Scope<'_> {
    fn lookup(&self, key: &str) -> Result<Value, String> {
        match key {
            "plot" => Ok(Value::String(self.plot.to_string())),
            "plotName" => Ok(Value::String(self.plot_name.clone())),
            "project" => self.project.map(|p| Value::String(p.to_string())).ok_or_else(|| "{{project}} used but the recipe has no projectFolder".to_string()),
            "dataset" => self.dataset.clone().map(Value::String).ok_or_else(|| "{{dataset}} used before any step produced a dataset".to_string()),
            other => {
                let rest = other.strip_prefix("steps.").ok_or_else(|| format!("unknown placeholder {{{{{other}}}}}"))?;
                let (idx, field) = rest.split_once('.').ok_or_else(|| format!("{{{{steps.{rest}}}}} needs a field: {{{{steps.N.field}}}}"))?;
                let n: usize = idx.parse().map_err(|_| format!("{{{{steps.{idx}…}}}}: not a step number"))?;
                let r = self.results.get(n).and_then(|r| r.as_ref()).ok_or_else(|| format!("step {n} has no result yet"))?;
                let mut v = r;
                for part in field.split('.') {
                    v = v.get(part).ok_or_else(|| format!("step {n}'s result has no field '{field}'"))?;
                }
                Ok(v.clone())
            }
        }
    }

    /// Fill the placeholders of one value. A string that is exactly one
    /// placeholder takes the referenced value as is (so a number stays a
    /// number); otherwise placeholders are spliced in as text.
    fn fill(&self, v: &Value) -> Result<Value, String> {
        match v {
            Value::String(s) => {
                let trimmed = s.trim();
                if trimmed.starts_with("{{") && trimmed.ends_with("}}") && trimmed.matches("{{").count() == 1 {
                    return self.lookup(trimmed[2..trimmed.len() - 2].trim());
                }
                let mut out = String::new();
                let mut rest = s.as_str();
                while let Some(start) = rest.find("{{") {
                    out.push_str(&rest[..start]);
                    let after = &rest[start + 2..];
                    let end = after.find("}}").ok_or_else(|| format!("unclosed placeholder in '{s}'"))?;
                    let key = after[..end].trim();
                    match self.lookup(key)? {
                        Value::String(t) => out.push_str(&t),
                        other => out.push_str(&other.to_string()),
                    }
                    rest = &after[end + 2..];
                }
                out.push_str(rest);
                Ok(Value::String(out))
            }
            Value::Array(a) => a.iter().map(|x| self.fill(x)).collect::<Result<Vec<_>, _>>().map(Value::Array),
            Value::Object(o) => {
                let mut m = serde_json::Map::new();
                for (k, x) in o {
                    m.insert(k.clone(), self.fill(x)?);
                }
                Ok(Value::Object(m))
            }
            other => Ok(other.clone()),
        }
    }
}

/// Drop the large arrays a result may carry, so a report stays readable.
fn trimmed(v: Value) -> Value {
    match v {
        Value::Array(a) if a.len() > 50 => json!({ "items": a.len(), "note": "array elided in the report" }),
        Value::Array(a) => Value::Array(a.into_iter().map(trimmed).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, trimmed(v))).collect()),
        other => other,
    }
}

fn plot_name(plot: &str) -> String {
    let p = std::path::Path::new(plot);
    p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| plot.to_string())
}

/// Run the recipe. `log` receives one line per step as it happens.
pub fn run(recipe: &Recipe, ctx: &OpContext, log: &mut dyn FnMut(String)) -> Report {
    let started = std::time::Instant::now();
    let mut plots = Vec::new();
    // Unknown operation names fail before any plot runs.
    let unknown: Vec<&str> = recipe.steps.iter().filter(|s| ops::find(&s.op).is_none()).map(|s| s.op.as_str()).collect();
    if !unknown.is_empty() {
        for plot in &recipe.plots {
            plots.push(PlotReport { plot: plot.clone(), ok: false, seconds: 0.0, dataset: None, steps: vec![StepReport {
                op: unknown.join(", "), ok: false, seconds: 0.0, error: Some(format!("unknown operation(s): {}", unknown.join(", "))), result: None }] });
        }
        return Report { name: recipe.name.clone(), failed: plots.len(), succeeded: 0, plots, seconds: started.elapsed().as_secs_f64() };
    }
    let targets: Vec<String> = if recipe.plots.is_empty() { vec![String::new()] } else { recipe.plots.clone() };
    for plot in &targets {
        let plot_started = std::time::Instant::now();
        let mut scope = Scope {
            plot,
            plot_name: plot_name(plot),
            project: recipe.project_folder.as_deref(),
            dataset: if plot.is_empty() { None } else if std::path::Path::new(plot).join("metadata.json").is_file() { Some(plot.clone()) } else { None },
            results: Vec::new(),
        };
        let mut steps = Vec::new();
        let mut ok = true;
        for (i, step) in recipe.steps.iter().enumerate() {
            let step_started = std::time::Instant::now();
            log(format!("[{}] step {}/{} {}", if plot.is_empty() { "-" } else { &scope.plot_name }, i + 1, recipe.steps.len(), step.op));
            let outcome = scope.fill(&step.params).and_then(|params| ops::run(&step.op, params, ctx));
            match outcome {
                Ok(result) => {
                    if let Some(dir) = result.get("outDir").and_then(Value::as_str) {
                        if matches!(step.op.as_str(), "dataset.import" | "export.subset" | "dataset.clean" | "dataset.downsample") {
                            scope.dataset = Some(dir.to_string());
                        }
                    }
                    scope.results.push(Some(result.clone()));
                    steps.push(StepReport { op: step.op.clone(), ok: true, seconds: step_started.elapsed().as_secs_f64(), error: None, result: Some(trimmed(result)) });
                }
                Err(e) => {
                    log(format!("    failed: {e}"));
                    scope.results.push(None);
                    steps.push(StepReport { op: step.op.clone(), ok: false, seconds: step_started.elapsed().as_secs_f64(), error: Some(e), result: None });
                    if !step.optional {
                        ok = false;
                        break;
                    }
                }
            }
        }
        plots.push(PlotReport { plot: plot.clone(), ok, seconds: plot_started.elapsed().as_secs_f64(), dataset: scope.dataset.clone(), steps });
        if !ok && recipe.stop_on_error {
            break;
        }
    }
    let succeeded = plots.iter().filter(|p| p.ok).count();
    Report { name: recipe.name.clone(), failed: plots.len() - succeeded, succeeded, plots, seconds: started.elapsed().as_secs_f64() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn placeholders_fill_from_the_scope_and_keep_types() {
        let scope = Scope {
            plot: "/laz/plot1001.laz",
            plot_name: "plot1001".into(),
            project: Some("/evo"),
            dataset: Some("/evo/octrees/plot1001".into()),
            results: vec![Some(json!({ "treeCount": 9, "nested": { "x": 1.5 } }))],
        };
        assert_eq!(scope.fill(&json!("{{dataset}}")).unwrap(), json!("/evo/octrees/plot1001"));
        assert_eq!(scope.fill(&json!("{{project}}/exports/{{plotName}}.laz")).unwrap(), json!("/evo/exports/plot1001.laz"));
        assert_eq!(scope.fill(&json!("{{steps.0.treeCount}}")).unwrap(), json!(9));
        assert_eq!(scope.fill(&json!("{{steps.0.nested.x}}")).unwrap(), json!(1.5));
        assert_eq!(scope.fill(&json!({ "a": ["{{plot}}", 2], "b": true })).unwrap(), json!({ "a": ["/laz/plot1001.laz", 2], "b": true }));
        assert!(scope.fill(&json!("{{nothing}}")).unwrap_err().contains("unknown placeholder"));
        assert!(scope.fill(&json!("{{steps.3.x}}")).unwrap_err().contains("no result"));
        assert!(scope.fill(&json!("{{open")).unwrap_err().contains("unclosed"));
        let bare = Scope { plot: "", plot_name: String::new(), project: None, dataset: None, results: vec![] };
        assert!(bare.fill(&json!("{{dataset}}")).unwrap_err().contains("before any step"));
        assert!(bare.fill(&json!("{{project}}")).unwrap_err().contains("no projectFolder"));
    }

    #[test]
    fn the_example_recipe_parses_and_names_only_real_operations() {
        let r: Recipe = serde_json::from_value(example()).unwrap();
        assert!(r.steps.len() >= 6);
        for s in &r.steps {
            assert!(ops::find(&s.op).is_some(), "{} is not an operation", s.op);
        }
        assert!(!r.stop_on_error);
    }

    #[test]
    fn a_run_reports_per_plot_and_goes_on_after_a_failure() {
        let dir = std::env::temp_dir().join(format!("pcl-recipe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let recipe = Recipe {
            name: "t".into(),
            project_folder: Some(dir.join("p").to_string_lossy().into_owned()),
            plots: vec!["a".into(), "b".into()],
            steps: vec![
                Step { op: "project.create".into(), params: json!({ "folder": "{{project}}/{{plotName}}", "name": "{{plotName}}" }), optional: false },
                Step { op: "run.status".into(), params: json!({ "stage": "{{plotName}}" }), optional: false },
                Step { op: "dataset.info".into(), params: json!({ "octreeDir": "{{project}}/nowhere" }), optional: true },
                Step { op: "dataset.import".into(), params: json!({ "srcPath": "{{project}}/missing.las" }), optional: false },
                Step { op: "run.status".into(), params: json!({ "stage": "never" }), optional: false },
            ],
            stop_on_error: false,
        };
        let ctx = OpContext::silent();
        let mut lines = Vec::new();
        let report = run(&recipe, &ctx, &mut |l| lines.push(l));
        assert_eq!(report.plots.len(), 2);
        assert_eq!(report.failed, 2);
        for p in &report.plots {
            assert!(!p.ok);
            assert_eq!(p.steps.len(), 4, "stops at the first non-optional failure");
            assert!(p.steps[0].ok && p.steps[1].ok);
            assert!(!p.steps[2].ok, "the optional step failed but did not stop the run");
            assert!(!p.steps[3].ok);
            assert!(p.steps[3].error.as_deref().unwrap().contains("is not a file"));
        }
        assert!(lines.iter().any(|l| l.contains("step 1/5 project.create")));
        assert!(dir.join("p").join("a").join("project.json").is_file());

        let stopping = Recipe { stop_on_error: true, ..recipe.clone() };
        let report = run(&stopping, &ctx, &mut |_| {});
        assert_eq!(report.plots.len(), 1, "stopOnError ends the run at the first failing plot");

        let bad = Recipe { steps: vec![Step { op: "no.such".into(), params: json!({}), optional: false }], ..recipe };
        let report = run(&bad, &ctx, &mut |_| {});
        assert_eq!(report.failed, 2);
        assert!(report.plots[0].steps[0].error.as_deref().unwrap().contains("unknown operation"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
