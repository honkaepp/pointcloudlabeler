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

//! The console interface: PointCloudLabeler in a terminal, over SSH if
//! need be. No points are drawn — that is the desktop application's
//! job — but everything else a session needs is here: open a project,
//! see its datasets, pick an operation from the catalogue, fill its
//! parameters in a form built from its schema, run it with a progress
//! bar and a log, read the result, and work through a QC table
//! recording verdicts tree by tree, as Tree Review does.
//!
//! The application state (`App`) and its key handling are plain Rust
//! with no terminal in them, so the behaviour is tested by feeding keys
//! and reading state; drawing is a function of the state, tested
//! against ratatui's buffer backend.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Gauge, List, ListItem, ListState, Paragraph, Row, Table, TableState, Wrap};
use ratatui::Frame;
use serde_json::{json, Map, Value};

use super::schema::{self, Kind, Param};
use crate::ops::{self, OpContext, OpDef};
use crate::progress::Progress;
use crate::state::AppState;

/// Which pane has the keyboard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Focus {
    Datasets,
    Operations,
    Params,
    Result,
}

/// What the result pane shows.
#[derive(Clone, Debug, PartialEq)]
pub enum View {
    /// Pretty JSON, scrollable.
    Json,
    /// A QC report as a table of flags with verdict keys.
    Qc,
}

/// One row of the parameter form.
#[derive(Clone, Debug)]
pub struct Field {
    pub param: Param,
    /// The value as typed; empty means "use the default".
    pub value: String,
}

/// What the run thread sends back.
pub enum Msg {
    Progress(String, f32),
    Done(Result<Value, String>),
}

/// A finished or running operation, for the log and the result pane.
#[derive(Clone, Debug, Default)]
pub struct Run {
    pub op: String,
    pub stage: String,
    pub pct: f32,
    pub running: bool,
    pub log: Vec<String>,
    pub result: Option<Value>,
    pub error: Option<String>,
}

/// One flag row of a QC table, as the pane lists it.
#[derive(Clone, Debug)]
pub struct QcRow {
    pub tree_id: i64,
    pub severity: String,
    pub code: String,
    pub reason: String,
}

pub struct App {
    pub project: Option<String>,
    pub datasets: Vec<(String, String)>, // (name, dir)
    pub dataset_state: ListState,
    pub ops: Vec<&'static OpDef>,
    pub op_state: ListState,
    pub fields: Vec<Field>,
    pub field_index: usize,
    pub editing: Option<String>,
    pub focus: Focus,
    pub run: Run,
    pub view: View,
    pub qc_rows: Vec<QcRow>,
    pub qc_state: TableState,
    pub verdicts: std::collections::BTreeMap<i64, String>,
    pub result_scroll: u16,
    pub status: String,
    pub prompt: Option<(String, String)>, // (label, text) for a path prompt
    pub quit: bool,
    state: Arc<AppState>,
    rx: Option<Receiver<Msg>>,
}

const SEV_ORDER: [&str; 3] = ["critical", "warning", "info"];

impl App {
    pub fn new(state: Arc<AppState>) -> App {
        let ops: Vec<&'static OpDef> = ops::catalogue().iter().filter(|o| o.group != ops::Group::Run).collect();
        let mut op_state = ListState::default();
        op_state.select(Some(0));
        let mut app = App {
            project: None,
            datasets: Vec::new(),
            dataset_state: ListState::default(),
            ops,
            op_state,
            fields: Vec::new(),
            field_index: 0,
            editing: None,
            focus: Focus::Operations,
            run: Run::default(),
            view: View::Json,
            qc_rows: Vec::new(),
            qc_state: TableState::default(),
            verdicts: Default::default(),
            result_scroll: 0,
            status: "Tab: next pane · Enter: run / edit · P: open project · R: refresh · q: quit".into(),
            prompt: None,
            quit: false,
            state,
            rx: None,
        };
        app.load_fields();
        app
    }

    fn ctx(&self, progress: Progress) -> OpContext {
        OpContext::new(progress, self.state.clone())
    }

    /// Open a project and list its datasets.
    pub fn open_project(&mut self, folder: &str) {
        match ops::run("project.open", json!({ "folder": folder }), &self.ctx(Progress::silent())) {
            Ok(_) => {
                self.project = Some(folder.to_string());
                self.status = format!("project: {folder}");
                self.refresh_datasets();
            }
            Err(e) => self.status = format!("could not open {folder}: {e}"),
        }
    }

    pub fn refresh_datasets(&mut self) {
        let Some(folder) = self.project.clone() else { return };
        match ops::run("project.datasets", json!({ "projectFolder": folder }), &self.ctx(Progress::silent())) {
            Ok(Value::Array(list)) => {
                self.datasets = list
                    .iter()
                    .map(|d| (d["name"].as_str().unwrap_or("?").to_string(), d["dir"].as_str().unwrap_or("").to_string()))
                    .collect();
                if self.datasets.is_empty() {
                    self.dataset_state.select(None);
                } else if self.dataset_state.selected().map_or(true, |i| i >= self.datasets.len()) {
                    self.dataset_state.select(Some(0));
                }
                self.load_fields();
            }
            Ok(_) => {}
            Err(e) => self.status = format!("datasets: {e}"),
        }
    }

    pub fn selected_op(&self) -> Option<&'static OpDef> {
        self.op_state.selected().and_then(|i| self.ops.get(i).copied())
    }

    pub fn selected_dataset(&self) -> Option<&(String, String)> {
        self.dataset_state.selected().and_then(|i| self.datasets.get(i))
    }

    /// Build the form for the selected operation, filling the dataset
    /// and project directories from the selection.
    pub fn load_fields(&mut self) {
        let Some(op) = self.selected_op() else {
            self.fields.clear();
            return;
        };
        let dataset = self.selected_dataset().map(|d| d.1.clone());
        let project = self.project.clone();
        self.fields = schema::params_of(&op.params_schema())
            .into_iter()
            .map(|param| {
                let value = match param.name.as_str() {
                    "octreeDir" | "srcDir" | "targetDir" => dataset.clone().unwrap_or_default(),
                    "projectFolder" | "folder" => project.clone().unwrap_or_default(),
                    _ => String::new(),
                };
                Field { param, value }
            })
            .collect();
        self.field_index = 0;
    }

    /// The parameters object the form describes: typed values for the
    /// filled fields, defaults left to the catalogue.
    pub fn params(&self) -> Result<Value, String> {
        let mut obj = Map::new();
        for f in &self.fields {
            if f.value.trim().is_empty() {
                if f.param.required {
                    return Err(format!("{} is required", f.param.name));
                }
                continue;
            }
            obj.insert(f.param.name.clone(), schema::parse_value(&f.param, &f.value)?);
        }
        Ok(Value::Object(obj))
    }

    /// Start the selected operation on a thread.
    pub fn start(&mut self) {
        if self.run.running {
            self.status = "an operation is already running — c cancels it".into();
            return;
        }
        let Some(op) = self.selected_op() else { return };
        let params = match self.params() {
            Ok(p) => p,
            Err(e) => {
                self.status = e;
                return;
            }
        };
        let (tx, rx): (Sender<Msg>, Receiver<Msg>) = mpsc::channel();
        let progress_tx = tx.clone();
        let progress = Progress::new(move |stage, pct| {
            let _ = progress_tx.send(Msg::Progress(stage.to_string(), pct));
        });
        let ctx = self.ctx(progress);
        let name = op.name;
        std::thread::Builder::new()
            .name("tui-op".into())
            .spawn(move || {
                let r = ops::run(name, params, &ctx);
                let _ = tx.send(Msg::Done(r));
            })
            .ok();
        self.rx = Some(rx);
        self.run = Run { op: name.to_string(), running: true, log: vec![format!("▶ {name}")], ..Run::default() };
        self.view = View::Json;
        self.result_scroll = 0;
        self.status = format!("running {name} — c cancels");
    }

    /// Ask the running operation to stop.
    pub fn cancel(&mut self) {
        if !self.run.running {
            return;
        }
        if let Some(stage) = ops::find(&self.run.op).and_then(|o| o.stage) {
            let _ = ops::run("run.cancel", json!({ "stage": stage }), &self.ctx(Progress::silent()));
            self.run.log.push(format!("stop requested on stage {stage}"));
        } else {
            self.run.log.push("this operation has no stage to stop".into());
        }
    }

    /// Drain the run thread's messages. Called every tick.
    pub fn tick(&mut self) {
        let Some(rx) = &self.rx else { return };
        let mut done = None;
        loop {
            match rx.try_recv() {
                Ok(Msg::Progress(stage, pct)) => {
                    let pct = if pct <= 1.0 { pct * 100.0 } else { pct };
                    if stage != self.run.stage {
                        self.run.log.push(format!("  {stage}"));
                        self.run.stage = stage;
                    }
                    self.run.pct = pct;
                }
                Ok(Msg::Done(r)) => {
                    done = Some(r);
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    done = Some(Err("the operation thread ended without a result".into()));
                    break;
                }
            }
        }
        if let Some(r) = done {
            self.rx = None;
            self.run.running = false;
            self.run.pct = 100.0;
            match r {
                Ok(v) => {
                    self.run.log.push("✔ done".into());
                    self.after_result(&v);
                    self.run.result = Some(v);
                    self.status = format!("{} finished", self.run.op);
                }
                Err(e) => {
                    self.run.log.push(format!("✘ {e}"));
                    self.run.error = Some(e.clone());
                    self.status = format!("{} failed: {e}", self.run.op);
                }
            }
            self.focus = Focus::Result;
        }
    }

    /// What a result changes besides the pane: a new dataset lists, a
    /// QC report becomes a table.
    fn after_result(&mut self, v: &Value) {
        match self.run.op.as_str() {
            "dataset.import" | "export.subset" | "dataset.clean" | "dataset.downsample" | "dataset.remove" | "project.create" | "project.open" => {
                if self.run.op.starts_with("project.") {
                    if let Some(folder) = v.get("folder").and_then(Value::as_str) {
                        self.project = Some(folder.to_string());
                    }
                }
                self.refresh_datasets();
            }
            "qc.flags" => {
                self.qc_rows = v["flags"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .map(|f| QcRow {
                                tree_id: f["treeId"].as_i64().unwrap_or(0),
                                severity: f["severity"].as_str().unwrap_or("").to_string(),
                                code: f["code"].as_str().unwrap_or("").to_string(),
                                reason: f["reason"].as_str().unwrap_or("").to_string(),
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.qc_state.select(if self.qc_rows.is_empty() { None } else { Some(0) });
                self.view = View::Qc;
                self.load_verdicts();
            }
            "review.set" | "review.get" => {
                if let Some(m) = v.get("verdicts").and_then(Value::as_object) {
                    self.verdicts = m.iter().filter_map(|(k, v)| Some((k.parse().ok()?, v.as_str()?.to_string()))).collect();
                }
            }
            _ => {}
        }
    }

    fn load_verdicts(&mut self) {
        let Some(dir) = self.selected_dataset().map(|d| d.1.clone()) else { return };
        if let Ok(v) = ops::run("review.get", json!({ "octreeDir": dir }), &self.ctx(Progress::silent())) {
            if let Some(m) = v.get("verdicts").and_then(Value::as_object) {
                self.verdicts = m.iter().filter_map(|(k, v)| Some((k.parse().ok()?, v.as_str()?.to_string()))).collect();
            }
        }
    }

    /// Record a verdict for the QC table's selected tree, as Tree Review's
    /// keys do, and write it through `review.set`.
    pub fn verdict(&mut self, verdict: Option<&str>) {
        let Some(row) = self.qc_state.selected().and_then(|i| self.qc_rows.get(i)) else { return };
        let Some(dir) = self.selected_dataset().map(|d| d.1.clone()) else { return };
        let tree = row.tree_id;
        let params = json!({ "octreeDir": dir, "verdicts": { tree.to_string(): verdict } });
        match ops::run("review.set", params, &self.ctx(Progress::silent())) {
            Ok(v) => {
                if let Some(m) = v.get("verdicts").and_then(Value::as_object) {
                    self.verdicts = m.iter().filter_map(|(k, v)| Some((k.parse().ok()?, v.as_str()?.to_string()))).collect();
                }
                self.status = match verdict {
                    Some(v) => format!("tree {tree}: {v}"),
                    None => format!("tree {tree}: verdict cleared"),
                };
                // On to the next tree, as the panel's sequential review does.
                let n = self.qc_rows.len();
                if let Some(i) = self.qc_state.selected() {
                    if i + 1 < n {
                        self.qc_state.select(Some(i + 1));
                    }
                }
            }
            Err(e) => self.status = format!("verdict: {e}"),
        }
    }

    pub fn on_key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        // A path prompt swallows everything until Enter or Esc.
        if let Some((_, text)) = &mut self.prompt {
            match key.code {
                KeyCode::Esc => self.prompt = None,
                KeyCode::Enter => {
                    let folder = text.trim().to_string();
                    self.prompt = None;
                    if !folder.is_empty() {
                        self.open_project(&folder);
                    }
                }
                KeyCode::Backspace => {
                    text.pop();
                }
                KeyCode::Char(c) => text.push(c),
                _ => {}
            }
            return;
        }
        // Editing a field.
        if let Some(buf) = &mut self.editing {
            match key.code {
                KeyCode::Esc => self.editing = None,
                KeyCode::Enter => {
                    let v = buf.clone();
                    self.editing = None;
                    if let Some(f) = self.fields.get_mut(self.field_index) {
                        f.value = v;
                    }
                }
                KeyCode::Backspace => {
                    buf.pop();
                }
                KeyCode::Char(c) => buf.push(c),
                _ => {}
            }
            return;
        }
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            self.quit = true;
            return;
        }
        match key.code {
            KeyCode::Char('q') => self.quit = true,
            KeyCode::Tab => self.focus = next_focus(self.focus),
            KeyCode::BackTab => self.focus = prev_focus(self.focus),
            KeyCode::Char('P') => self.prompt = Some(("Project folder".into(), self.project.clone().unwrap_or_default())),
            KeyCode::Char('R') => self.refresh_datasets(),
            KeyCode::Char('c') => self.cancel(),
            KeyCode::Char('?') => self.status = "Tab/Shift-Tab panes · ↑↓ move · Enter run/edit · Space clear field · P project · R refresh · c cancel · o/f/x verdict in QC · q quit".into(),
            _ => match self.focus {
                Focus::Datasets => match key.code {
                    KeyCode::Up => { move_list(&mut self.dataset_state, self.datasets.len(), -1); self.load_fields(); }
                    KeyCode::Down => { move_list(&mut self.dataset_state, self.datasets.len(), 1); self.load_fields(); }
                    KeyCode::Enter => self.focus = Focus::Operations,
                    _ => {}
                },
                Focus::Operations => match key.code {
                    KeyCode::Up => { move_list(&mut self.op_state, self.ops.len(), -1); self.load_fields(); }
                    KeyCode::Down => { move_list(&mut self.op_state, self.ops.len(), 1); self.load_fields(); }
                    KeyCode::PageUp => { move_list(&mut self.op_state, self.ops.len(), -10); self.load_fields(); }
                    KeyCode::PageDown => { move_list(&mut self.op_state, self.ops.len(), 10); self.load_fields(); }
                    KeyCode::Enter => self.focus = Focus::Params,
                    _ => {}
                },
                Focus::Params => match key.code {
                    KeyCode::Up => self.field_index = self.field_index.saturating_sub(1),
                    KeyCode::Down => self.field_index = (self.field_index + 1).min(self.fields.len().saturating_sub(1)),
                    KeyCode::Char(' ') => {
                        if let Some(f) = self.fields.get_mut(self.field_index) {
                            f.value.clear();
                        }
                    }
                    KeyCode::Char('e') => {
                        if let Some(f) = self.fields.get(self.field_index) {
                            self.editing = Some(f.value.clone());
                        }
                    }
                    KeyCode::Enter => {
                        // Enter on a field edits it; Enter with Shift, or on the
                        // run line, runs. The run key is always `r` too.
                        if key.modifiers.contains(KeyModifiers::SHIFT) || self.fields.is_empty() {
                            self.start();
                        } else if let Some(f) = self.fields.get(self.field_index) {
                            self.editing = Some(f.value.clone());
                        }
                    }
                    KeyCode::Char('r') => self.start(),
                    _ => {}
                },
                Focus::Result => match (self.view.clone(), key.code) {
                    (View::Qc, KeyCode::Up) => move_table(&mut self.qc_state, self.qc_rows.len(), -1),
                    (View::Qc, KeyCode::Down) => move_table(&mut self.qc_state, self.qc_rows.len(), 1),
                    (View::Qc, KeyCode::Char('o')) => self.verdict(Some("ok")),
                    (View::Qc, KeyCode::Char('f')) => self.verdict(Some("flag")),
                    (View::Qc, KeyCode::Char('x')) => self.verdict(None),
                    (View::Qc, KeyCode::Char('j')) => self.view = View::Json,
                    (View::Json, KeyCode::Up) => self.result_scroll = self.result_scroll.saturating_sub(1),
                    (View::Json, KeyCode::Down) => self.result_scroll = self.result_scroll.saturating_add(1),
                    (View::Json, KeyCode::PageUp) => self.result_scroll = self.result_scroll.saturating_sub(20),
                    (View::Json, KeyCode::PageDown) => self.result_scroll = self.result_scroll.saturating_add(20),
                    (View::Json, KeyCode::Char('t')) if !self.qc_rows.is_empty() => self.view = View::Qc,
                    (_, KeyCode::Char('r')) => self.start(),
                    _ => {}
                },
            },
        }
    }
}

fn next_focus(f: Focus) -> Focus {
    match f {
        Focus::Datasets => Focus::Operations,
        Focus::Operations => Focus::Params,
        Focus::Params => Focus::Result,
        Focus::Result => Focus::Datasets,
    }
}

fn prev_focus(f: Focus) -> Focus {
    match f {
        Focus::Datasets => Focus::Result,
        Focus::Operations => Focus::Datasets,
        Focus::Params => Focus::Operations,
        Focus::Result => Focus::Params,
    }
}

fn move_list(state: &mut ListState, len: usize, by: i32) {
    if len == 0 {
        state.select(None);
        return;
    }
    let cur = state.selected().unwrap_or(0) as i32;
    state.select(Some((cur + by).clamp(0, len as i32 - 1) as usize));
}

fn move_table(state: &mut TableState, len: usize, by: i32) {
    if len == 0 {
        state.select(None);
        return;
    }
    let cur = state.selected().unwrap_or(0) as i32;
    state.select(Some((cur + by).clamp(0, len as i32 - 1) as usize));
}

// --- drawing ----------------------------------------------------------------

fn border(title: impl std::fmt::Display, focused: bool) -> Block<'static> {
    let style = if focused { Style::default().fg(Color::Yellow) } else { Style::default().fg(Color::DarkGray) };
    Block::default().borders(Borders::ALL).border_style(style).title(Span::styled(format!(" {title} "), Style::default().add_modifier(Modifier::BOLD)))
}

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    let rows = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Min(8), Constraint::Length(1)])
        .split(area);
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(32), Constraint::Percentage(68)])
        .split(rows[0]);
    let left = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(35), Constraint::Percentage(65)])
        .split(cols[0]);
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(40), Constraint::Length(7), Constraint::Min(5)])
        .split(cols[1]);

    draw_datasets(frame, app, left[0]);
    draw_ops(frame, app, left[1]);
    draw_params(frame, app, right[0]);
    draw_run(frame, app, right[1]);
    draw_result(frame, app, right[2]);

    // status line, or the prompt
    let line = match &app.prompt {
        Some((label, text)) => Line::from(vec![Span::styled(format!("{label}: "), Style::default().fg(Color::Yellow)), Span::raw(text.clone()), Span::styled("▏", Style::default().fg(Color::Yellow))]),
        None => Line::from(Span::styled(app.status.clone(), Style::default().fg(Color::Gray))),
    };
    frame.render_widget(Paragraph::new(line), rows[1]);
}

fn draw_datasets(frame: &mut Frame, app: &mut App, area: Rect) {
    let title = match &app.project {
        Some(p) => format!("Datasets — {}", std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone())),
        None => "Datasets — no project (P)".to_string(),
    };
    let items: Vec<ListItem> = if app.datasets.is_empty() {
        vec![ListItem::new(Span::styled("(none — P to open a project)", Style::default().fg(Color::DarkGray)))]
    } else {
        app.datasets.iter().map(|(name, _)| ListItem::new(name.clone())).collect()
    };
    let list = List::new(items)
        .block(border(&title, app.focus == Focus::Datasets))
        .highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow))
        .highlight_symbol("▶ ");
    frame.render_stateful_widget(list, area, &mut app.dataset_state);
}

fn draw_ops(frame: &mut Frame, app: &mut App, area: Rect) {
    let mut last_group = None;
    let items: Vec<ListItem> = app
        .ops
        .iter()
        .map(|op| {
            let group = op.group.as_str();
            let head = if last_group != Some(group) {
                last_group = Some(group);
                Span::styled(format!("{group:<9}"), Style::default().fg(Color::Cyan))
            } else {
                Span::raw(" ".repeat(9))
            };
            ListItem::new(Line::from(vec![head, Span::raw(op.name.to_string())]))
        })
        .collect();
    let list = List::new(items)
        .block(border("Operations", app.focus == Focus::Operations))
        .highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow))
        .highlight_symbol("▶ ");
    frame.render_stateful_widget(list, area, &mut app.op_state);
}

fn draw_params(frame: &mut Frame, app: &mut App, area: Rect) {
    let title = match app.selected_op() {
        Some(op) => format!("Parameters — {}", op.name),
        None => "Parameters".into(),
    };
    let mut lines: Vec<Line> = Vec::new();
    if let Some(op) = app.selected_op() {
        lines.push(Line::from(Span::styled(op.summary.to_string(), Style::default().fg(Color::Gray))));
        lines.push(Line::raw(""));
    }
    for (i, f) in app.fields.iter().enumerate() {
        let selected = i == app.field_index && app.focus == Focus::Params;
        let marker = if selected { "▶ " } else { "  " };
        let value = match (&app.editing, selected) {
            (Some(buf), true) => format!("{buf}▏"),
            _ if f.value.is_empty() => match &f.param.default {
                Some(d) => format!("({})", schema::default_text(d)),
                None if f.param.required => "<required>".into(),
                None => "(none)".into(),
            },
            _ => f.value.clone(),
        };
        let value_style = if f.value.is_empty() && app.editing.is_none() {
            Style::default().fg(if f.param.required { Color::Red } else { Color::DarkGray })
        } else {
            Style::default().fg(Color::White)
        };
        let kind = match f.param.kind {
            Kind::String => "text",
            Kind::Number => "number",
            Kind::Integer => "integer",
            Kind::Boolean => "true/false",
            Kind::Json => "json",
        };
        lines.push(Line::from(vec![
            Span::raw(marker),
            Span::styled(format!("{:<26}", f.param.name), Style::default().fg(Color::Yellow)),
            Span::styled(value, value_style),
            Span::styled(format!("  {kind}"), Style::default().fg(Color::DarkGray)),
        ]));
    }
    lines.push(Line::raw(""));
    lines.push(Line::from(Span::styled("Enter/e: edit field · Space: clear · r or Shift-Enter: run", Style::default().fg(Color::DarkGray))));
    let scroll = app.field_index.saturating_sub(area.height.saturating_sub(5) as usize) as u16;
    frame.render_widget(Paragraph::new(lines).block(border(&title, app.focus == Focus::Params)).scroll((scroll, 0)), area);
}

fn draw_run(frame: &mut Frame, app: &mut App, area: Rect) {
    let parts = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(1)])
        .split(area);
    let label = if app.run.op.is_empty() {
        "idle".to_string()
    } else if app.run.running {
        format!("{} · {} {:.0}%", app.run.op, app.run.stage, app.run.pct)
    } else if app.run.error.is_some() {
        format!("{} · failed", app.run.op)
    } else {
        format!("{} · done", app.run.op)
    };
    let colour = if app.run.error.is_some() { Color::Red } else if app.run.running { Color::Yellow } else { Color::Green };
    let gauge = Gauge::default()
        .block(Block::default().borders(Borders::ALL).title(" Run "))
        .gauge_style(Style::default().fg(colour))
        .ratio((app.run.pct as f64 / 100.0).clamp(0.0, 1.0))
        .label(label);
    frame.render_widget(gauge, parts[0]);
    let n = parts[1].height as usize;
    let start = app.run.log.len().saturating_sub(n);
    let lines: Vec<Line> = app.run.log[start..].iter().map(|l| Line::raw(l.clone())).collect();
    frame.render_widget(Paragraph::new(lines), parts[1]);
}

fn draw_result(frame: &mut Frame, app: &mut App, area: Rect) {
    let focused = app.focus == Focus::Result;
    match app.view {
        View::Qc => {
            let header = Row::new(vec!["tree", "verdict", "severity", "code", "reason"]).style(Style::default().add_modifier(Modifier::BOLD));
            let rows: Vec<Row> = app
                .qc_rows
                .iter()
                .map(|r| {
                    let sev_colour = match r.severity.as_str() {
                        "critical" => Color::Red,
                        "warning" => Color::Yellow,
                        _ => Color::Blue,
                    };
                    let verdict = app.verdicts.get(&r.tree_id).cloned().unwrap_or_default();
                    Row::new(vec![
                        Span::raw(r.tree_id.to_string()),
                        Span::styled(verdict, Style::default().fg(Color::Green)),
                        Span::styled(r.severity.clone(), Style::default().fg(sev_colour)),
                        Span::raw(r.code.clone()),
                        Span::raw(r.reason.clone()),
                    ])
                })
                .collect();
            let n_flags = app.qc_rows.len();
            let widths = [Constraint::Length(7), Constraint::Length(8), Constraint::Length(9), Constraint::Length(17), Constraint::Min(10)];
            let table = Table::new(rows, widths)
                .header(header)
                .block(border(format!("QC — {n_flags} flags · o ok · f flag · x clear · j json"), focused))
                .row_highlight_style(Style::default().fg(Color::Black).bg(Color::Yellow));
            frame.render_stateful_widget(table, area, &mut app.qc_state);
        }
        View::Json => {
            let text = match (&app.run.result, &app.run.error) {
                (Some(v), _) => serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()),
                (None, Some(e)) => format!("error: {e}"),
                (None, None) => String::from("Pick an operation, fill its parameters, run it. The result appears here."),
            };
            let order = SEV_ORDER.len(); // keeps the constant used in both views
            let _ = order;
            let title = if app.qc_rows.is_empty() { "Result — ↑↓ scroll".to_string() } else { "Result — ↑↓ scroll · t table".to_string() };
            frame.render_widget(
                Paragraph::new(text).block(border(&title, focused)).wrap(Wrap { trim: false }).scroll((app.result_scroll, 0)),
                area,
            );
        }
    }
}

/// Run the console interface until the user quits.
pub fn run(ctx: &OpContext) -> Result<(), String> {
    let mut app = App::new(ctx.state.clone());
    if let Some(folder) = ctx.state.project_folder() {
        app.open_project(&folder.to_string_lossy());
    }
    let mut terminal = ratatui::init();
    let result = event_loop(&mut terminal, &mut app);
    ratatui::restore();
    result
}

fn event_loop(terminal: &mut ratatui::DefaultTerminal, app: &mut App) -> Result<(), String> {
    loop {
        terminal.draw(|f| draw(f, app)).map_err(|e| format!("draw: {e}"))?;
        if event::poll(Duration::from_millis(80)).map_err(|e| format!("poll: {e}"))? {
            if let Event::Key(key) = event::read().map_err(|e| format!("read: {e}"))? {
                app.on_key(key);
            }
        }
        app.tick();
        if app.quit {
            if app.run.running {
                app.cancel();
            }
            return Ok(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn app() -> App {
        App::new(Arc::new(AppState::default()))
    }

    fn select_op(app: &mut App, name: &str) {
        let i = app.ops.iter().position(|o| o.name == name).expect(name);
        app.op_state.select(Some(i));
        app.load_fields();
    }

    #[test]
    fn the_form_follows_the_selected_operation_and_the_selected_dataset() {
        let mut a = app();
        a.datasets = vec![("plot1001".into(), "/evo/octrees/plot1001".into()), ("plot1002".into(), "/evo/octrees/plot1002".into())];
        a.dataset_state.select(Some(1));
        select_op(&mut a, "segment.chm");
        let dir = a.fields.iter().find(|f| f.param.name == "octreeDir").unwrap();
        assert_eq!(dir.value, "/evo/octrees/plot1002");
        assert_eq!(a.params().unwrap(), json!({ "octreeDir": "/evo/octrees/plot1002" }));
        // Edit a field through the keys.
        a.focus = Focus::Params;
        let i = a.fields.iter().position(|f| f.param.name == "minHeight").unwrap();
        a.field_index = i;
        a.on_key(key(KeyCode::Enter));
        for c in "3.5".chars() {
            a.on_key(key(KeyCode::Char(c)));
        }
        a.on_key(key(KeyCode::Enter));
        assert_eq!(a.params().unwrap(), json!({ "octreeDir": "/evo/octrees/plot1002", "minHeight": 3.5 }));
        // A bad value is reported, not run.
        a.on_key(key(KeyCode::Char('e')));
        a.on_key(key(KeyCode::Char('x')));
        a.on_key(key(KeyCode::Enter));
        assert!(a.params().unwrap_err().contains("wants a number"));
        a.on_key(key(KeyCode::Char(' ')));
        assert_eq!(a.params().unwrap(), json!({ "octreeDir": "/evo/octrees/plot1002" }));
        // Moving the dataset moves the directory.
        a.focus = Focus::Datasets;
        a.on_key(key(KeyCode::Up));
        assert_eq!(a.fields.iter().find(|f| f.param.name == "octreeDir").unwrap().value, "/evo/octrees/plot1001");
    }

    #[test]
    fn a_required_field_left_empty_stops_the_run_with_its_name() {
        let mut a = app();
        select_op(&mut a, "ground.classify");
        assert_eq!(a.params().unwrap_err(), "octreeDir is required");
        a.focus = Focus::Params;
        a.on_key(key(KeyCode::Char('r')));
        assert_eq!(a.status, "octreeDir is required");
        assert!(!a.run.running);
    }

    #[test]
    fn running_an_operation_reports_progress_and_the_result_arrives_on_tick() {
        let mut a = app();
        // A quick read-only operation on a scratch directory.
        let dir = std::env::temp_dir().join(format!("pcl-tui-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        select_op(&mut a, "review.treemap");
        a.fields[0].value = dir.to_string_lossy().into_owned();
        a.focus = Focus::Params;
        a.on_key(key(KeyCode::Char('r')));
        assert!(a.run.running);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while a.run.running && std::time::Instant::now() < deadline {
            a.tick();
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(!a.run.running, "the run did not finish");
        assert_eq!(a.run.result, Some(json!({})));
        assert_eq!(a.focus, Focus::Result);
        assert!(a.run.log.iter().any(|l| l.contains("done")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_qc_table_takes_verdicts_and_writes_them() {
        let dir = std::env::temp_dir().join(format!("pcl-tui-qc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut a = app();
        a.datasets = vec![("d".into(), dir.to_string_lossy().into_owned())];
        a.dataset_state.select(Some(0));
        a.run.op = "qc.flags".into();
        a.after_result(&json!({ "flags": [
            { "treeId": 7, "severity": "critical", "code": "no-dbh", "reason": "No DBH fit" },
            { "treeId": 3, "severity": "warning", "code": "crown-large", "reason": "big" },
        ] }));
        assert_eq!(a.view, View::Qc);
        assert_eq!(a.qc_rows.len(), 2);
        a.focus = Focus::Result;
        a.on_key(key(KeyCode::Char('o')));
        assert_eq!(a.verdicts.get(&7).map(String::as_str), Some("ok"));
        assert_eq!(a.qc_state.selected(), Some(1), "the selection moves to the next tree");
        a.on_key(key(KeyCode::Char('f')));
        assert_eq!(a.verdicts.get(&3).map(String::as_str), Some("flag"));
        let on_disk: std::collections::BTreeMap<String, String> = serde_json::from_str(&std::fs::read_to_string(dir.join("review.json")).unwrap()).unwrap();
        assert_eq!(on_disk.get("7").map(String::as_str), Some("ok"));
        assert_eq!(on_disk.get("3").map(String::as_str), Some("flag"));
        a.on_key(key(KeyCode::Char('x')));
        assert!(!a.verdicts.contains_key(&3));
        a.on_key(key(KeyCode::Char('j')));
        assert_eq!(a.view, View::Json);
        a.on_key(key(KeyCode::Char('t')));
        assert_eq!(a.view, View::Qc);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn panes_cycle_the_prompt_opens_a_project_and_q_quits() {
        let mut a = app();
        assert_eq!(a.focus, Focus::Operations);
        a.on_key(key(KeyCode::Tab));
        assert_eq!(a.focus, Focus::Params);
        a.on_key(key(KeyCode::BackTab));
        a.on_key(key(KeyCode::BackTab));
        assert_eq!(a.focus, Focus::Datasets);
        // The prompt takes a path and opens it; a bad one reports.
        a.on_key(key(KeyCode::Char('P')));
        assert!(a.prompt.is_some());
        for c in "/nowhere/at/all".chars() {
            a.on_key(key(KeyCode::Char(c)));
        }
        a.on_key(key(KeyCode::Enter));
        assert!(a.prompt.is_none());
        assert!(a.status.contains("could not open"), "{}", a.status);
        a.on_key(key(KeyCode::Char('q')));
        assert!(a.quit);
    }

    #[test]
    fn the_screen_draws_every_pane_into_a_buffer() {
        let mut a = app();
        a.datasets = vec![("plot1001".into(), "/x".into())];
        a.dataset_state.select(Some(0));
        select_op(&mut a, "qc.flags");
        a.status = "ready".into();
        let backend = TestBackend::new(120, 40);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|f| draw(f, &mut a)).unwrap();
        let text = terminal.backend().to_string();
        for needle in ["Datasets", "plot1001", "Operations", "qc.flags", "Parameters", "octreeDir", "Run", "Result", "ready"] {
            assert!(text.contains(needle), "the screen lacks {needle:?}:\n{text}");
        }
        a.run.op = "qc.flags".into();
        a.after_result(&json!({ "flags": [{ "treeId": 7, "severity": "critical", "code": "no-dbh", "reason": "No DBH fit" }] }));
        terminal.draw(|f| draw(f, &mut a)).unwrap();
        let text = terminal.backend().to_string();
        assert!(text.contains("QC — 1 flags") && text.contains("no-dbh"), "{text}");
    }
}
