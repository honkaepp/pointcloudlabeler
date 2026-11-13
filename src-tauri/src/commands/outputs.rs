//! The files the processing runs left in the open project, for the Layers panel.
//!
//! Archives opened or dropped on the window unpack into the project's `imports/` folder (a
//! folder per archive, commands/dataopen.rs). Clouds go to the editor as datasets; most of the
//! rest is something to see over them — trajectories, positions, stems, meshes, grids — which
//! the Layers panel lists from here and opens as layers (`src/layers/fileLayers.ts` says what
//! each file is). Everything listed is inside the project, so the viewer may read it
//! (fsgrant.rs).

use std::path::Path;

/// One file a run wrote.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFile {
    pub path: String,
    /// The folder it is in, relative to the project, with `/` (`imports/plot_1001`).
    pub folder: String,
    pub name: String,
    pub bytes: u64,
    /// Last written, ms since 1970.
    pub modified: f64,
}

/// The project folders the runs write into.
pub const OUTPUT_ROOTS: [&str; 1] = ["imports"];
const MAX_DEPTH: usize = 4;
const MAX_FILES: usize = 5000;

/// Folders that hold no layer: caches and hidden folders.
fn skipped_dir(name: &str) -> bool {
    name.starts_with('.')
}

/// Files still being written or left by a stopped run.
fn skipped_file(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".part") || n.ends_with(".tmp") || n.starts_with('.')
}

/// The files under the project's output folders, newest folder first and by name within one.
pub fn list_project_files(project: &Path) -> Vec<ProjectFile> {
    let mut out = Vec::new();
    for root in OUTPUT_ROOTS {
        walk(project, &project.join(root), 0, &mut out);
    }
    // newest run first: a folder sorts by its newest file
    let mut newest: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for f in &out {
        let e = newest.entry(f.folder.clone()).or_insert(0.0);
        *e = e.max(f.modified);
    }
    out.sort_by(|a, b| newest[&b.folder].total_cmp(&newest[&a.folder]).then_with(|| a.folder.cmp(&b.folder)).then_with(|| a.name.cmp(&b.name)));
    out
}

fn walk(project: &Path, dir: &Path, depth: usize, out: &mut Vec<ProjectFile>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(md) = e.metadata() else { continue };
        if md.is_dir() {
            if !skipped_dir(&name) {
                walk(project, &e.path(), depth + 1, out);
            }
            continue;
        }
        if skipped_file(&name) {
            continue;
        }
        if out.len() >= MAX_FILES {
            return;
        }
        let folder = dir.strip_prefix(project).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        let modified = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        out.push(ProjectFile { path: e.path().to_string_lossy().into_owned(), folder, name, bytes: md.len(), modified });
    }
}

/// The open project's run outputs.
#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn project_files(state: tauri::State<'_, crate::state::AppState>) -> Result<Vec<ProjectFile>, String> {
    let project = state.project_folder().ok_or_else(|| "open or create a project first".to_string())?;
    crate::rt::spawn_blocking(move || list_project_files(&project)).await.map_err(|e| format!("join error: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runs_files_are_listed_by_folder_without_what_holds_no_layer() {
        let p = std::env::temp_dir().join(format!("pcl_outputs_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        let w = |rel: &str| {
            let f = p.join(rel);
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(&f, b"x").unwrap();
        };
        w("imports/plot/plot.laz");
        w("imports/plot/plot_traj.txt");
        w("imports/plot/.cache/tile.bin");
        w("imports/evo/evo_positions.csv");
        w("imports/evo/evo.laz.part");
        w("imports/evo/.hidden.txt");
        w("imports/tiles/sub/a.las");
        w("octrees/x/metadata.json");
        let files = list_project_files(&p);
        let mut names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        names.sort();
        assert_eq!(names, ["a.las", "evo_positions.csv", "plot.laz", "plot_traj.txt"]);
        let traj = files.iter().find(|f| f.name == "plot_traj.txt").unwrap();
        assert_eq!(traj.folder, "imports/plot");
        assert_eq!(traj.bytes, 1);
        assert!(traj.modified > 0.0);
        assert!(Path::new(&traj.path).is_file());
        // one folder's files together
        let folders: Vec<&str> = files.iter().map(|f| f.folder.as_str()).collect();
        let first = folders.iter().position(|f| *f == "imports/plot").unwrap();
        assert_eq!(folders[first + 1], "imports/plot");
        let _ = std::fs::remove_dir_all(&p);
    }
}
