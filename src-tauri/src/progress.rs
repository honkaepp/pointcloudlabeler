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

//! Where a long pass reports its progress.
//!
//! Every pass that streams a dataset — the importer, ground
//! classification, segmentation, the exporter, skeleton transfer — used
//! to take a `tauri::Window` and emit a percentage on it. That bound
//! seventy functions to the desktop runtime for one call each, and it
//! is the reason the library could not be built for a machine with no
//! display: a batch run on a compute server, a command-line pipeline,
//! a console session over SSH, an API process.
//!
//! `Progress` is the one thing those passes actually need from the
//! window: somewhere to say "stage, percent". The GUI builds one from
//! its window (`Progress::window`, behind the `gui` feature) and the
//! event name the panel listens to; the headless surfaces build one
//! from a closure that prints, logs, or sends on a channel; a test
//! builds a silent one. The passes do not know which.
//!
//! The older `ProgressSink` / `StagedSink` closure aliases in
//! `commands::octree` do the same job for the paths that were made
//! testable earlier; `Progress::staged` bridges into them.

use std::sync::Arc;

/// Progress event payload — what the GUI panels have always received.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq)]
pub struct ProgressMsg<'a> {
    pub stage: &'a str,
    pub pct: f32,
}

type Report = dyn Fn(&str, f32) + Send + Sync + 'static;

/// A handle a pass reports to. Cheap to clone; clones report to the
/// same place.
#[derive(Clone)]
pub struct Progress(Arc<Report>);

impl std::fmt::Debug for Progress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Progress(..)")
    }
}

impl Progress {
    /// Report through `f(stage, pct)`.
    pub fn new(f: impl Fn(&str, f32) + Send + Sync + 'static) -> Self {
        Progress(Arc::new(f))
    }

    /// Reports to nobody. For tests, and for callers that asked for no
    /// progress output.
    pub fn silent() -> Self {
        Progress::new(|_, _| {})
    }

    /// Say where a pass is. `pct` is 0..=100; stages are short names
    /// such as "open", "bin", "build", "stitch", "done".
    pub fn report(&self, stage: &str, pct: f32) {
        (self.0)(stage, pct)
    }

    /// A staged sink for the passes that take one — see
    /// `commands::octree::StagedSink`. Borrows this handle.
    pub fn staged(&self) -> impl Fn(&str, f32) + '_ {
        move |stage, pct| self.report(stage, pct)
    }

    /// A percent-only sink under a fixed stage name — see
    /// `commands::octree::ProgressSink`.
    pub fn under<'a>(&'a self, stage: &'a str) -> impl Fn(f32) + 'a {
        move |pct| self.report(stage, pct)
    }

    /// The GUI's handle: emits `ProgressMsg { stage, pct }` as `event` on
    /// the window the command came from — "octree-progress",
    /// "e57-progress" and the others the panels subscribe to. A failed
    /// emit (the window is gone) is dropped: a pass must never fail
    /// because nobody is watching it any more.
    #[cfg(feature = "gui")]
    pub fn window(window: tauri::Window, event: &'static str) -> Self {
        use tauri::Emitter;
        Progress::new(move |stage, pct| {
            let _ = window.emit(event, ProgressMsg { stage, pct });
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn a_report_reaches_the_closure_with_stage_and_percent() {
        let seen: Arc<Mutex<Vec<(String, f32)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let p = Progress::new(move |stage, pct| sink.lock().unwrap().push((stage.to_string(), pct)));
        p.report("bin", 12.5);
        let q = p.clone();
        q.report("build", 50.0);
        let staged = p.staged();
        staged("stitch", 90.0);
        let pct_only = p.under("done");
        pct_only(100.0);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                ("bin".to_string(), 12.5),
                ("build".to_string(), 50.0),
                ("stitch".to_string(), 90.0),
                ("done".to_string(), 100.0),
            ]
        );
    }

    #[test]
    fn the_silent_handle_accepts_anything() {
        let p = Progress::silent();
        p.report("anything", -1.0);
        p.report("", f32::NAN);
    }
}
