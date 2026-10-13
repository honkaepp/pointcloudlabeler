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

//! The operation catalogue: every analysis the application can run
//! without its window, as one named, typed, self-describing registry.
//!
//! The desktop application reaches the Rust passes through 146 Tauri
//! commands, each with its own argument list and its own panel. The
//! command line, the console interface, the HTTP API and the MCP
//! server need the same passes, and they need them described: a
//! `--help`, an endpoint listing and a `tools/list` are the same
//! information in three encodings. So each operation here is one
//! `OpDef`: a stable dotted name (`segment.chm`, `metrics.trees`,
//! `transfer.run`), a one-line summary, the group it belongs to,
//! whether it writes to the dataset it names, the cancel stage it runs
//! under, a JSON Schema for its parameters derived from the very struct
//! the parameters are parsed into, and the function that runs it.
//!
//! The operations call the same `run_*` functions the Tauri commands
//! call, with the same defaults the panels send — the numbers are
//! copied from the panels' `DEFAULT_*` constants and the wrappers'
//! `unwrap_or` calls, and named in each parameter's doc. Where the
//! panel does a step in TypeScript after a pass (clearing an attribute's
//! overrides from the edit overlay after a segmenter rewrote it), the
//! operation does that step too, so a headless run leaves the dataset
//! exactly as the panel would.
//!
//! Parameter names are the wire names the Tauri commands use
//! (camelCase: `octreeDir`, `cellSize`), so the panels' documentation,
//! the TypeScript types and this catalogue agree on every field.

#![allow(clippy::too_many_arguments)]

use std::sync::{Arc, OnceLock};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

use crate::progress::Progress;
use crate::state::AppState;

/// Define one operation. `$f` is a `fn(&OpContext, $params) -> Result<T, String>`
/// with `T: Serialize`; the parameters are parsed from JSON and the
/// result serialised back, so every surface speaks JSON to the catalogue
/// and nothing else.
macro_rules! op {
    ($name:literal, $group:ident, mutates: $m:expr, stage: $st:expr, $summary:literal, $params:ty, $f:path) => {
        $crate::ops::OpDef {
            name: $name,
            summary: $summary,
            group: $crate::ops::Group::$group,
            mutates: $m,
            stage: $st,
            params: || schemars::schema_for!($params),
            run: |ctx, v| {
                let p: $params = $crate::ops::parse(v)?;
                let r = $f(ctx, p)?;
                $crate::ops::to_json(&r)
            },
        }
    };
}

pub mod analysis;
pub mod bucking;
pub mod crosssensor;
pub mod csvtext;
#[cfg(test)]
mod e2e_tests;
pub mod export;
pub mod forestry;
pub mod growth;
pub mod matching;
pub mod metricscsv;
pub mod preprocess;
pub mod project;
pub mod qc;
pub mod registration;
pub mod report;
pub mod review;
pub mod thinning;
pub mod transfer;
pub mod validation;

/// What an operation runs with: where to report progress, and the
/// application state (the open project) the project operations use.
pub struct OpContext {
    pub progress: Progress,
    pub state: Arc<AppState>,
}

impl OpContext {
    pub fn new(progress: Progress, state: Arc<AppState>) -> Self {
        OpContext { progress, state }
    }

    /// No progress output, a fresh state. For tests and one-shot runs.
    pub fn silent() -> Self {
        OpContext::new(Progress::silent(), Arc::new(AppState::default()))
    }
}

/// The catalogue's sections, as a help listing groups them.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    Project,
    Preprocess,
    Dataset,
    Ground,
    Segment,
    Metrics,
    Qc,
    Review,
    Transfer,
    Export,
    Change,
    Run,
}

impl Group {
    pub fn as_str(self) -> &'static str {
        match self {
            Group::Project => "project",
            Group::Preprocess => "preprocess",
            Group::Dataset => "dataset",
            Group::Ground => "ground",
            Group::Segment => "segment",
            Group::Metrics => "metrics",
            Group::Qc => "qc",
            Group::Review => "review",
            Group::Transfer => "transfer",
            Group::Export => "export",
            Group::Change => "change",
            Group::Run => "run",
        }
    }
}

/// One operation.
pub struct OpDef {
    /// Stable dotted name, e.g. `segment.chm`.
    pub name: &'static str,
    pub summary: &'static str,
    pub group: Group,
    /// Writes to the dataset or project it names.
    pub mutates: bool,
    /// The cancellation stage a long run holds (`run.cancel` takes it).
    pub stage: Option<&'static str>,
    params: fn() -> schemars::Schema,
    run: fn(&OpContext, Value) -> Result<Value, String>,
}

impl OpDef {
    /// JSON Schema of the parameters object.
    pub fn params_schema(&self) -> Value {
        serde_json::to_value((self.params)()).unwrap_or(Value::Null)
    }

    pub fn run(&self, ctx: &OpContext, params: Value) -> Result<Value, String> {
        (self.run)(ctx, params)
    }

    /// The operation as a listing shows it.
    pub fn describe(&self) -> Value {
        json!({
            "name": self.name,
            "summary": self.summary,
            "group": self.group,
            "mutates": self.mutates,
            "stage": self.stage,
            "params": self.params_schema(),
        })
    }
}

/// Parse an operation's parameters. `null` and a missing object both
/// mean "all defaults".
pub(crate) fn parse<T: DeserializeOwned>(v: Value) -> Result<T, String> {
    let v = if v.is_null() { Value::Object(Default::default()) } else { v };
    serde_json::from_value(v).map_err(|e| format!("invalid parameters: {e}"))
}

pub(crate) fn to_json<T: Serialize>(t: &T) -> Result<Value, String> {
    serde_json::to_value(t).map_err(|e| format!("serialise result: {e}"))
}

/// A JSON object, or a clear error naming what was expected.
pub(crate) fn non_empty(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field} is required"));
    }
    Ok(())
}

/// Every operation, in listing order.
pub fn catalogue() -> &'static [OpDef] {
    static ALL: OnceLock<Vec<OpDef>> = OnceLock::new();
    ALL.get_or_init(|| {
        let mut v = Vec::new();
        v.extend(project::ops());
        v.extend(preprocess::ops());
        v.extend(analysis::ops());
        v.extend(forestry::ops());
        v.extend(thinning::ops());
        v.extend(bucking::ops());
        v.extend(validation::ops());
        v.extend(review::ops());
        v.extend(transfer::ops());
        v.extend(export::ops());
        v.extend(metricscsv::ops());
        v.extend(report::ops());
        v.extend(growth::ops());
        v.extend(crosssensor::ops());
        v.extend(registration::ops());
        v.extend(run_ops());
        v
    })
}

pub fn find(name: &str) -> Option<&'static OpDef> {
    catalogue().iter().find(|o| o.name == name)
}

/// Run `name` with `params`. An unknown name lists what exists.
pub fn run(name: &str, params: Value, ctx: &OpContext) -> Result<Value, String> {
    match find(name) {
        Some(op) => op.run(ctx, params),
        None => {
            let names: Vec<&str> = catalogue().iter().map(|o| o.name).collect();
            Err(format!("unknown operation '{name}'; the catalogue has: {}", names.join(", ")))
        }
    }
}

/// The whole catalogue as a listing.
pub fn describe_all() -> Value {
    Value::Array(catalogue().iter().map(|o| o.describe()).collect())
}

// --- run control ------------------------------------------------------

#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageParams {
    /// The cancel stage a long operation holds — see each operation's
    /// `stage` in the listing (e.g. "segment", "tst", "export").
    pub stage: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageState {
    pub stage: String,
    pub running: bool,
    pub stop_requested: bool,
}

fn run_cancel(_ctx: &OpContext, p: StageParams) -> Result<StageState, String> {
    non_empty(&p.stage, "stage")?;
    crate::commands::cancel::octree_cancel(p.stage.clone());
    Ok(StageState {
        running: crate::commands::cancel::is_running(&p.stage),
        stop_requested: crate::commands::cancel::was_requested(&p.stage),
        stage: p.stage,
    })
}

fn run_status(_ctx: &OpContext, p: StageParams) -> Result<StageState, String> {
    non_empty(&p.stage, "stage")?;
    Ok(StageState {
        running: crate::commands::cancel::is_running(&p.stage),
        stop_requested: crate::commands::cancel::was_requested(&p.stage),
        stage: p.stage,
    })
}

fn run_ops() -> Vec<OpDef> {
    vec![
        op!("run.cancel", Run, mutates: false, stage: None,
            "Ask the operation running on a stage to stop at its next check; the run keeps what it finished.",
            StageParams, run_cancel),
        op!("run.status", Run, mutates: false, stage: None,
            "Whether a stage is running and whether a stop was requested.",
            StageParams, run_status),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_operation_has_a_unique_dotted_name_a_summary_and_a_schema() {
        let all = catalogue();
        assert!(all.len() >= 40, "the catalogue has {} operations", all.len());
        let mut seen = std::collections::HashSet::new();
        for op in all {
            assert!(seen.insert(op.name), "duplicate operation {}", op.name);
            assert!(op.name.contains('.'), "{} is not group.name", op.name);
            assert!(op.name.starts_with(op.group.as_str()) || op.group == Group::Dataset && op.name.starts_with("dataset.") || op.group == Group::Run,
                "{} is filed under {}", op.name, op.group.as_str());
            assert!(op.summary.ends_with('.'), "{}: a summary is a sentence", op.name);
            let schema = op.params_schema();
            assert!(schema.is_object(), "{} has no schema", op.name);
            let s = schema.to_string();
            assert!(s.contains("\"type\":\"object\""), "{}: {s}", op.name);
        }
    }

    #[test]
    fn the_listing_is_json_and_an_unknown_name_names_the_alternatives() {
        let listing = describe_all();
        assert!(listing.as_array().map(|a| a.len()).unwrap_or(0) >= 40);
        let err = run("nothing.here", Value::Null, &OpContext::silent()).unwrap_err();
        assert!(err.contains("unknown operation 'nothing.here'"));
        assert!(err.contains("segment.chm") && err.contains("metrics.trees"));
    }

    #[test]
    fn unknown_parameters_are_refused_rather_than_ignored() {
        // A typo in a parameter name must not silently run with the default.
        let err = run("ground.classify", json!({ "octreeDir": "x", "cellsize": 1.0 }), &OpContext::silent()).unwrap_err();
        assert!(err.contains("invalid parameters") && err.contains("cellsize"), "{err}");
    }

    #[test]
    fn stage_control_round_trips() {
        let ctx = OpContext::silent();
        let s = run("run.status", json!({ "stage": "ops-test-stage" }), &ctx).unwrap();
        assert_eq!(s["running"], false);
        let s = run("run.cancel", json!({ "stage": "ops-test-stage" }), &ctx).unwrap();
        assert_eq!(s["stopRequested"], true);
        assert!(run("run.cancel", json!({ "stage": "" }), &ctx).is_err());
    }
}
