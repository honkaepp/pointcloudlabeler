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

//! The command line.
//!
//! Every operation of the catalogue is a subcommand, built at start-up
//! from the catalogue itself: `segment.chm` is `pointcloudlabeler segment
//! chm`, and its parameters are its flags, with the types, defaults and
//! descriptions of its JSON Schema. Nothing here names an operation, so
//! an operation added to the catalogue is on the command line, in
//! `--help` and in the console the moment it exists, spelled the same
//! way everywhere.
//!
//! Results are JSON on stdout — one object, pretty-printed unless
//! `--compact` — so a shell pipeline can read them with `jq`. Progress
//! goes to stderr as `stage  42.0%` lines that overwrite in a terminal,
//! or nothing under `--quiet`. Exit status is 0 for a result, 1 for an
//! operation that failed (its message on stderr), 2 for a usage error.
//!
//! `ops list`, `ops describe <name>` and `ops run <name> --params
//! '{…}'` are the same catalogue by name, for scripts that would rather
//! build parameters as JSON than as flags. `recipe run` runs a sequence
//! of operations over many plots — see `recipe.rs`.

use std::io::{IsTerminal, Write};
use std::sync::{Arc, Mutex};

use clap::{Arg, ArgAction, ArgMatches, Command};
use serde_json::{json, Map, Value};

use super::schema::{self, Kind};
use crate::ops::{self, OpContext, OpDef};
use crate::progress::Progress;
use crate::state::AppState;

pub const BIN: &str = "pointcloudlabeler";

/// Build the whole command tree from the catalogue.
pub fn command() -> Command {
    let mut root = Command::new(BIN)
        .version(env!("CARGO_PKG_VERSION"))
        .about("PointCloudLabeler without its window: every analysis of the desktop application, from the command line.")
        .long_about(
            "PointCloudLabeler without its window. Each subcommand is one operation of the \
             operation catalogue the desktop application's panels also run — the same Rust \
             passes, the same defaults — grouped as the panels group them. Results are JSON \
             on stdout; progress and errors go to stderr.\n\n\
             Examples:\n  \
             pointcloudlabeler project new --folder ./evo --name Evo\n  \
             pointcloudlabeler dataset import --src-path plot1001.laz --project-folder ./evo\n  \
             pointcloudlabeler ground classify --octree-dir ./evo/octrees/plot1001\n  \
             pointcloudlabeler segment chm --octree-dir ./evo/octrees/plot1001 --min-height 3\n  \
             pointcloudlabeler qc flags --octree-dir ./evo/octrees/plot1001 | jq '.flags[] | select(.severity == \"critical\")'\n  \
             pointcloudlabeler ops describe transfer.run",
        )
        .subcommand_required(true)
        .arg_required_else_help(true)
        .next_help_heading("Global options")
        .arg(Arg::new("quiet").long("quiet").short('q').global(true).action(ArgAction::SetTrue).help("No progress output on stderr"))
        .arg(Arg::new("compact").long("compact").global(true).action(ArgAction::SetTrue).help("One-line JSON output instead of pretty-printed"))
        .arg(Arg::new("project").long("project").short('P').global(true).value_name("FOLDER").help("Open this project first (the default projectFolder for operations that take one)"));

    // One subcommand per group, one per operation under it.
    let mut groups: Vec<ops::Group> = Vec::new();
    for op in ops::catalogue() {
        if !groups.contains(&op.group) {
            groups.push(op.group);
        }
    }
    for g in groups {
        let mut gc = Command::new(g.as_str()).about(group_about(g)).subcommand_required(true).arg_required_else_help(true);
        for op in ops::catalogue().iter().filter(|o| o.group == g) {
            gc = gc.subcommand(op_command(op));
        }
        root = root.subcommand(gc);
    }

    root = root.subcommand(
        Command::new("ops")
            .about("The catalogue by name: list it, describe an operation, run one with JSON parameters")
            .subcommand_required(true)
            .arg_required_else_help(true)
            .subcommand(Command::new("list").about("Every operation: name, group, summary"))
            .subcommand(Command::new("docs").about("The operation reference as Markdown (what docs/OPERATIONS.md holds)"))
            .subcommand(
                Command::new("describe")
                    .about("One operation with its parameter schema")
                    .arg(Arg::new("name").required(true).help("Operation name, e.g. segment.chm")),
            )
            .subcommand(
                Command::new("run")
                    .about("Run an operation with parameters given as JSON")
                    .arg(Arg::new("name").required(true).help("Operation name, e.g. segment.chm"))
                    .arg(Arg::new("params").long("params").short('p').value_name("JSON").help("The parameters object"))
                    .arg(Arg::new("params-file").long("params-file").short('f').value_name("FILE").help("A file holding the parameters object (\"-\" for stdin)")),
            ),
    );
    root = root.subcommand(
        Command::new("recipe")
            .about("Batch: run a sequence of operations over many plots from a recipe file")
            .subcommand_required(true)
            .arg_required_else_help(true)
            .subcommand(
                Command::new("run")
                    .about("Run a recipe")
                    .arg(Arg::new("file").required(true).value_name("RECIPE.json").help("The recipe file — see `recipe example`"))
                    .arg(Arg::new("plots").long("plot").value_name("PATH").action(ArgAction::Append).help("A plot to run on (repeatable); overrides the recipe's own list"))
                    .arg(Arg::new("stop").long("stop-on-error").action(ArgAction::SetTrue).help("Stop at the first failing plot instead of going on to the next"))
                    .arg(Arg::new("report").long("report").value_name("FILE").help("Write the run report (JSON) here as well as to stdout")),
            )
            .subcommand(Command::new("example").about("Print an example recipe to start from")),
    );
    root = super::surfaces(root);
    root
}

fn group_about(g: ops::Group) -> &'static str {
    match g {
        ops::Group::Project => "Projects: create, open, list datasets",
        ops::Group::Preprocess => "Scanner projects: import E57 / PTX / XYZ, register scan positions, export a region as LAS",
        ops::Group::Dataset => "Datasets: import, describe, clean, remove",
        ops::Group::Ground => "Ground classification, terrain rasters, height normalisation",
        ops::Group::Segment => "Tree segmentation and the label columns",
        ops::Group::Metrics => "Per-tree measurements, stem fits, stem models",
        ops::Group::Qc => "Quality control: per-tree and per-point checks",
        ops::Group::Review => "Review verdicts, species, plot boundary, merge map",
        ops::Group::Transfer => "Skeletons, label transfer between acquisitions, registration",
        ops::Group::Export => "Exports: LAS/LAZ, subsets",
        ops::Group::Change => "Change detection between acquisitions",
        ops::Group::Run => "Running operations: stop one, ask whether one runs",
    }
}

/// The subcommand for one operation: its leaf name in kebab-case, a
/// flag per parameter.
fn op_command(op: &'static OpDef) -> Command {
    let leaf = op.name.split('.').nth(1).unwrap_or(op.name);
    let mut c = Command::new(schema::flag_name(leaf)).about(op.summary);
    let mut long = op.summary.to_string();
    if let Some(stage) = op.stage {
        long.push_str(&format!("\n\nStage: {stage} (stop it with `{BIN} run cancel --stage {stage}`)."));
    }
    if op.mutates {
        long.push_str("\n\nWrites to the dataset or project it names.");
    }
    c = c.long_about(long).next_help_heading("Parameters");
    for p in schema::params_of(&op.params_schema()) {
        let flag = schema::flag_name(&p.name);
        let mut help = p.description.clone();
        if let Some(d) = &p.default {
            if !help.is_empty() {
                help.push(' ');
            }
            help.push_str(&format!("[default: {}]", schema::default_text(d)));
        }
        if !p.choices.is_empty() {
            help.push_str(&format!(" [one of: {}]", p.choices.join(", ")));
        }
        let value_name = match p.kind {
            Kind::String => "TEXT",
            Kind::Number => "NUMBER",
            Kind::Integer => "INTEGER",
            Kind::Boolean => "true|false",
            Kind::Json => "JSON",
        };
        let arg = Arg::new(p.name.clone())
            .long(flag)
            .value_name(value_name)
            .required(p.required)
            .help(help)
            .action(ArgAction::Set);
        c = c.arg(arg);
    }
    c
}

/// Parameters from the flags the user gave.
fn params_from_matches(op: &OpDef, m: &ArgMatches) -> Result<Value, String> {
    let mut obj = Map::new();
    for p in schema::params_of(&op.params_schema()) {
        if let Some(text) = m.get_one::<String>(&p.name) {
            obj.insert(p.name.clone(), schema::parse_value(&p, text)?);
        }
    }
    Ok(Value::Object(obj))
}

/// Progress on stderr: one line per stage, overwritten in a terminal.
pub fn stderr_progress() -> Progress {
    let last: Arc<Mutex<(String, i32)>> = Arc::new(Mutex::new((String::new(), -1)));
    let tty = std::io::stderr().is_terminal();
    Progress::new(move |stage, pct| {
        let pct = if pct <= 1.0 { pct * 100.0 } else { pct };
        let bucket = (pct * 2.0) as i32; // half-percent steps
        let mut l = last.lock().unwrap_or_else(|e| e.into_inner());
        if l.0 == stage && l.1 == bucket {
            return;
        }
        let new_stage = l.0 != stage;
        *l = (stage.to_string(), bucket);
        let mut err = std::io::stderr().lock();
        if tty {
            if new_stage && !l.0.is_empty() && bucket > 0 {
                let _ = write!(err, "\r\x1b[2K");
            }
            let _ = write!(err, "\r\x1b[2K{stage:<16} {pct:>5.1}%");
            if pct >= 99.95 {
                let _ = writeln!(err);
            }
        } else if new_stage || pct >= 99.95 || bucket % 20 == 0 {
            let _ = writeln!(err, "{stage:<16} {pct:>5.1}%");
        }
        let _ = err.flush();
    })
}

fn print_value(v: &Value, compact: bool) {
    let text = if compact { v.to_string() } else { serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()) };
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{text}");
    let _ = out.flush();
}

/// Run the command line. Returns the process exit status.
pub fn main() -> i32 {
    let matches = match command().try_get_matches() {
        Ok(m) => m,
        Err(e) => {
            // --help and --version print and exit 0; usage errors exit 2.
            let code = if e.use_stderr() { 2 } else { 0 };
            let _ = e.print();
            return code;
        }
    };
    let quiet = matches.get_flag("quiet");
    let compact = matches.get_flag("compact");
    let progress = if quiet { Progress::silent() } else { stderr_progress() };
    let ctx = OpContext::new(progress, Arc::new(AppState::default()));
    if let Some(folder) = matches.get_one::<String>("project") {
        if let Err(e) = ops::run("project.open", json!({ "folder": folder }), &ctx) {
            eprintln!("error: {e}");
            return 1;
        }
    }
    match dispatch(&matches, &ctx) {
        Ok(Some(v)) => {
            print_value(&v, compact);
            0
        }
        Ok(None) => 0,
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

fn dispatch(matches: &ArgMatches, ctx: &OpContext) -> Result<Option<Value>, String> {
    let Some((group, gm)) = matches.subcommand() else { return Ok(None) };
    match group {
        "ops" => match gm.subcommand() {
            Some(("docs", _)) => {
                let mut out = std::io::stdout().lock();
                let _ = write!(out, "{}", super::docs::operations_markdown());
                let _ = out.flush();
                Ok(None)
            }
            Some(("list", _)) => Ok(Some(Value::Array(
                ops::catalogue()
                    .iter()
                    .map(|o| json!({ "name": o.name, "group": o.group, "summary": o.summary, "mutates": o.mutates, "stage": o.stage }))
                    .collect(),
            ))),
            Some(("describe", m)) => {
                let name = m.get_one::<String>("name").unwrap();
                let op = ops::find(name).ok_or_else(|| unknown(name))?;
                Ok(Some(op.describe()))
            }
            Some(("run", m)) => {
                let name = m.get_one::<String>("name").unwrap();
                let op = ops::find(name).ok_or_else(|| unknown(name))?;
                let params = match (m.get_one::<String>("params"), m.get_one::<String>("params-file")) {
                    (Some(_), Some(_)) => return Err("give --params or --params-file, not both".into()),
                    (Some(text), None) => serde_json::from_str(text).map_err(|e| format!("--params is not valid JSON: {e}"))?,
                    (None, Some(file)) => {
                        let text = if file == "-" {
                            let mut s = String::new();
                            std::io::Read::read_to_string(&mut std::io::stdin(), &mut s).map_err(|e| format!("read stdin: {e}"))?;
                            s
                        } else {
                            std::fs::read_to_string(file).map_err(|e| format!("read {file}: {e}"))?
                        };
                        serde_json::from_str(&text).map_err(|e| format!("{file} is not valid JSON: {e}"))?
                    }
                    (None, None) => Value::Object(Map::new()),
                };
                op.run(ctx, params).map(Some)
            }
            _ => Ok(None),
        },
        "recipe" => match gm.subcommand() {
            Some(("example", _)) => Ok(Some(super::recipe::example())),
            Some(("run", m)) => {
                let file = m.get_one::<String>("file").unwrap();
                let text = std::fs::read_to_string(file).map_err(|e| format!("read {file}: {e}"))?;
                let mut recipe: super::recipe::Recipe = serde_json::from_str(&text).map_err(|e| format!("{file}: {e}"))?;
                if let Some(plots) = m.get_many::<String>("plots") {
                    recipe.plots = plots.cloned().collect();
                }
                recipe.stop_on_error |= m.get_flag("stop");
                let report = super::recipe::run(&recipe, ctx, &mut |line| eprintln!("{line}"));
                let value = serde_json::to_value(&report).map_err(|e| e.to_string())?;
                if let Some(path) = m.get_one::<String>("report") {
                    std::fs::write(path, serde_json::to_string_pretty(&value).unwrap_or_default()).map_err(|e| format!("write {path}: {e}"))?;
                }
                if report.failed > 0 {
                    print_value(&value, false);
                    return Err(format!("{} of {} plots failed", report.failed, report.plots.len()));
                }
                Ok(Some(value))
            }
            _ => Ok(None),
        },
        group if super::is_surface(group) => super::run_surface(group, gm, ctx).map(|_| None),
        group => {
            let Some((leaf, m)) = gm.subcommand() else { return Ok(None) };
            let name = format!("{group}.{}", schema::camel_name(leaf));
            let op = ops::find(&name).ok_or_else(|| unknown(&name))?;
            let params = params_from_matches(op, m)?;
            op.run(ctx, params).map(Some)
        }
    }
}

fn unknown(name: &str) -> String {
    format!("unknown operation '{name}' — `{BIN} ops list` names them all")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_command_tree_has_every_operation_and_clap_accepts_it() {
        let cmd = command();
        cmd.clone().debug_assert();
        for op in ops::catalogue() {
            let (group, leaf) = op.name.split_once('.').unwrap();
            let gc = cmd.find_subcommand(group).unwrap_or_else(|| panic!("no group {group}"));
            let lc = gc.find_subcommand(schema::flag_name(leaf)).unwrap_or_else(|| panic!("no subcommand for {}", op.name));
            for p in schema::params_of(&op.params_schema()) {
                assert!(lc.get_arguments().any(|a| a.get_id() == p.name.as_str()), "{}: no flag for {}", op.name, p.name);
            }
        }
    }

    #[test]
    fn flags_become_typed_parameters() {
        let cmd = command();
        let m = cmd
            .try_get_matches_from(["pointcloudlabeler", "segment", "chm", "--octree-dir", "/d", "--cell-size", "1", "--min-height", "3.5"])
            .unwrap();
        let ("segment", gm) = m.subcommand().unwrap() else { panic!() };
        let ("chm", lm) = gm.subcommand().unwrap() else { panic!() };
        let op = ops::find("segment.chm").unwrap();
        let params = params_from_matches(op, lm).unwrap();
        assert_eq!(params, json!({ "octreeDir": "/d", "cellSize": 1.0, "minHeight": 3.5 }));
        // A required flag missing is a usage error, not a run.
        let err = command().try_get_matches_from(["pointcloudlabeler", "segment", "chm"]).unwrap_err();
        assert_eq!(err.kind(), clap::error::ErrorKind::MissingRequiredArgument);
        // Booleans and JSON.
        let m = command()
            .try_get_matches_from(["pointcloudlabeler", "review", "set", "--octree-dir", "/d", "--verdicts", "{\"3\":\"ok\"}", "--replace", "true"])
            .unwrap();
        let (_, gm) = m.subcommand().unwrap();
        let (_, lm) = gm.subcommand().unwrap();
        let params = params_from_matches(ops::find("review.set").unwrap(), lm).unwrap();
        assert_eq!(params, json!({ "octreeDir": "/d", "verdicts": { "3": "ok" }, "replace": true }));
    }

    #[test]
    fn help_carries_defaults_and_the_stage() {
        let mut cmd = command();
        let sc = cmd.find_subcommand_mut("ground").unwrap().find_subcommand_mut("classify").unwrap();
        let help = sc.render_long_help().to_string();
        assert!(help.contains("--cell-size"), "{help}");
        assert!(help.contains("[default: 0.5]"), "{help}");
        assert!(help.contains("Stage: classify_ground"), "{help}");
        assert!(help.contains("Writes to the dataset"), "{help}");
    }

    #[test]
    fn the_catalogue_by_name_lists_describes_and_runs() {
        let ctx = OpContext::silent();
        let m = command().try_get_matches_from(["pointcloudlabeler", "ops", "list"]).unwrap();
        let v = dispatch(&m, &ctx).unwrap().unwrap();
        assert!(v.as_array().unwrap().len() >= 40);
        let m = command().try_get_matches_from(["pointcloudlabeler", "ops", "describe", "qc.flags"]).unwrap();
        let v = dispatch(&m, &ctx).unwrap().unwrap();
        assert_eq!(v["name"], "qc.flags");
        assert!(v["params"]["properties"]["octreeDir"].is_object());
        let m = command().try_get_matches_from(["pointcloudlabeler", "ops", "run", "run.status", "--params", "{\"stage\":\"cli-test\"}"]).unwrap();
        let v = dispatch(&m, &ctx).unwrap().unwrap();
        assert_eq!(v["running"], false);
        let m = command().try_get_matches_from(["pointcloudlabeler", "ops", "run", "nothing.here"]).unwrap();
        assert!(dispatch(&m, &ctx).unwrap_err().contains("unknown operation"));
        let m = command().try_get_matches_from(["pointcloudlabeler", "ops", "run", "run.status", "--params", "{not json"]).unwrap();
        assert!(dispatch(&m, &ctx).unwrap_err().contains("not valid JSON"));
    }

    #[test]
    fn the_progress_printer_tolerates_both_scales_and_never_panics() {
        let p = stderr_progress();
        p.report("bin", 0.5);
        p.report("bin", 0.5);
        p.report("bin", 1.0);
        p.report("build", 42.0);
        p.report("build", 100.0);
    }
}
