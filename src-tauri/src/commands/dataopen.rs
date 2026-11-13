// One door for data.
//
// The editor imports point clouds; the Preprocessing module takes PTX; and a
// PointCloudLabeler project is a folder. The user should not have to know
// which of those a file belongs to before opening it. This module says what a
// file or folder IS, and the renderer (src/io/dataOpen.ts) sends it where it
// belongs:
//
//   cloud          LAS / LAZ / text / PLY / E57            → the editor's import
//   ptx            a structured PTX                        → Preprocessing
//   project        a PointCloudLabeler project folder      → opened
//   archive        a .zip holding any of the above         → unpacked, then routed
//   folder         any other folder: what it holds is listed in `contents`
//   unknown        anything else
//
// A dropped path comes from the operating system's drop event, not from the
// renderer, so the drop handler here grants it (fsgrant.rs) before telling
// the renderer — the renderer cannot name a path and so be allowed to read
// it. A picked path was granted by its dialog; `data_classify` only looks at
// paths that are already allowed.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde::Serialize;

#[cfg(feature = "gui")]
use tauri::State;

use crate::commands::cancel;
use crate::progress::Progress;
#[cfg(feature = "gui")]
use crate::state::AppState;

/// The event the renderer hears a drop on, with the classified entries.
pub const DROP_EVENT: &str = "data-drop";
/// Progress of an unpack, and its cancel stage.
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
const PROGRESS_EVENT: &str = "data-progress";
pub const EXTRACT_STAGE: &str = "data-extract";

/// Entries listed of a folder or an archive, at most.
const MAX_CONTENTS: usize = 500;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DataEntry {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// cloud, ptx, project, archive, folder or unknown.
    pub kind: String,
    /// A folder or an archive: the entries in it that can be opened (a folder's own
    /// files; an archive's files at any depth).
    pub contents: Vec<DataEntry>,
}

/// What a file is, by its name.
pub fn kind_of_name(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    match ext {
        "las" | "laz" | "ply" | "e57" | "txt" | "xyz" | "csv" | "asc" | "pts" | "tsv" | "dat" => "cloud",
        "ptx" => "ptx",
        "zip" => "archive",
        _ => "unknown",
    }
}

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| lossy(p))
}

fn entry(path: &Path, is_dir: bool, size: u64, kind: &str, contents: Vec<DataEntry>) -> DataEntry {
    DataEntry { path: lossy(path), name: file_name(path), is_dir, size, kind: kind.into(), contents }
}

/// What a file or folder is. A missing path is `unknown`.
pub fn classify(path: &Path) -> DataEntry {
    let Ok(meta) = fs::metadata(path) else {
        return entry(path, false, 0, "unknown", Vec::new());
    };
    if !meta.is_dir() {
        let kind = kind_of_name(&file_name(path));
        let contents = if kind == "archive" { archive_contents(path).unwrap_or_default() } else { Vec::new() };
        return entry(path, false, meta.len(), kind, contents);
    }
    if path.join("project.json").is_file() {
        return entry(path, true, 0, "project", Vec::new());
    }
    entry(path, true, 0, "folder", folder_contents(path))
}

/// The entries of a folder that can be opened, sorted by name: its own files
/// (not its subfolders).
fn folder_contents(dir: &Path) -> Vec<DataEntry> {
    let Ok(read) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<DataEntry> = read
        .filter_map(Result::ok)
        .filter_map(|e| {
            let p = e.path();
            let meta = e.metadata().ok()?;
            if meta.is_dir() {
                return None;
            }
            let kind = kind_of_name(&file_name(&p));
            (kind != "unknown").then(|| entry(&p, false, meta.len(), kind, Vec::new()))
        })
        .take(MAX_CONTENTS)
        .collect();
    out.sort_by_key(|e| e.name.to_lowercase());
    out
}

/// The files of an archive that can be opened (archives inside it aside), with
/// their unpacked sizes; `path` is the name inside the archive.
fn archive_contents(path: &Path) -> Result<Vec<DataEntry>, String> {
    let file = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut out = Vec::new();
    for i in 0..zip.len() {
        let Ok(f) = zip.by_index(i) else { continue };
        if f.is_dir() {
            continue;
        }
        let Some(inner) = f.enclosed_name() else { continue };
        let kind = kind_of_name(&file_name(&inner));
        if kind == "unknown" || kind == "archive" {
            continue;
        }
        out.push(DataEntry {
            // the name in the archive, as `by_name` looks it up ("./plot.laz", "tiles/a.las")
            path: f.name().to_string(),
            name: file_name(&inner),
            is_dir: false,
            size: f.size(),
            kind: kind.into(),
            contents: Vec::new(),
        });
        if out.len() >= MAX_CONTENTS {
            break;
        }
    }
    Ok(out)
}

/// Unpack the openable files of `archive` (`only`: these names inside it; empty =
/// all of them) into `dest`, flat, and return them classified. Files already
/// there with the same size are kept, so a second drop of the same archive does
/// not unpack it again.
pub fn extract(progress: &Progress, stop: &AtomicBool, archive: &Path, dest: &Path, only: &[String]) -> Result<Vec<DataEntry>, String> {
    let wanted: Vec<DataEntry> =
        archive_contents(archive)?.into_iter().filter(|e| only.is_empty() || only.contains(&e.path)).collect();
    if wanted.is_empty() {
        return Err(format!("{}: nothing in it that PointCloudLabeler opens", archive.display()));
    }
    fs::create_dir_all(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    let total: u64 = wanted.iter().map(|e| e.size).sum::<u64>().max(1);
    let file = fs::File::open(archive).map_err(|e| format!("{}: {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("{}: {e}", archive.display()))?;
    let mut done = 0u64;
    let mut out = Vec::new();
    for w in &wanted {
        let target = dest.join(&w.name);
        if fs::metadata(&target).map(|m| m.len() == w.size).unwrap_or(false) {
            done += w.size;
            out.push(classify(&target));
            continue;
        }
        let mut src = zip.by_name(&w.path).map_err(|e| format!("{}: {e}", w.path))?;
        let part = target.with_extension(format!("{}.part", target.extension().and_then(|e| e.to_str()).unwrap_or("")));
        let mut dst = std::io::BufWriter::new(fs::File::create(&part).map_err(|e| format!("{}: {e}", part.display()))?);
        let mut buf = vec![0u8; 1 << 20];
        loop {
            if cancel::stopped(stop) {
                drop(dst);
                let _ = fs::remove_file(&part);
                return Err("Stopped — the unpacking was cancelled.".into());
            }
            let n = src.read(&mut buf).map_err(|e| format!("{}: {e}", w.path))?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n]).map_err(|e| format!("{}: {e}", part.display()))?;
            done += n as u64;
            progress.report(&format!("unpacking {}", w.name), (100.0 * done as f64 / total as f64).min(99.0) as f32);
        }
        dst.flush().map_err(|e| format!("{}: {e}", part.display()))?;
        drop(dst);
        fs::rename(&part, &target).map_err(|e| format!("{}: {e}", target.display()))?;
        out.push(classify(&target));
    }
    progress.report("done", 100.0);
    Ok(out)
}

// ---------------------------------------------------------------------------
// Tauri side

/// The drop handler: grant what the user dropped, then tell the renderer what
/// it is. Folders are granted whole (dropping a folder is choosing it, as the
/// folder dialog is); files one by one.
#[cfg(feature = "gui")]
pub fn on_webview_event<R: tauri::Runtime>(webview: &tauri::Webview<R>, event: &tauri::WebviewEvent) {
    use tauri::{Emitter, Manager};
    let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event else {
        return;
    };
    let state = webview.state::<AppState>();
    let entries: Vec<DataEntry> = paths
        .iter()
        .map(|p| {
            if p.is_dir() {
                state.grants.grant_dir(p);
            } else {
                state.grants.grant_file(p);
            }
            classify(p)
        })
        .collect();
    // To this window only — with a second window open
    // (commands/compare_window.rs) a drop on one must not open in both.
    let _ = webview.emit(DROP_EVENT, DataDrop { window: webview.label().to_string(), entries });
}

/// What a drop sends: the window it landed on, and what was dropped.
#[cfg(feature = "gui")]
#[derive(serde::Serialize, Clone)]
struct DataDrop {
    window: String,
    entries: Vec<DataEntry>,
}

/// What a path the user picked is.
#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn data_classify(state: State<'_, AppState>, path: String) -> Result<DataEntry, String> {
    let p = state.authorise_path(&path).map_err(|e| e.to_string())?;
    crate::rt::spawn_blocking(move || classify(&p)).await.map_err(|e| format!("join error: {e}"))
}

/// Unpack an archive the user dropped or picked into a folder of the open
/// project (`dest`, which must be inside it).
#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn data_extract(state: State<'_, AppState>, window: tauri::Window, archive: String, dest: String, only: Vec<String>) -> Result<Vec<DataEntry>, String> {
    let archive = state.authorise_path(&archive).map_err(|e| e.to_string())?;
    let project = state.project_folder().ok_or_else(|| "open or create a project first".to_string())?;
    let dest = std::path::PathBuf::from(&dest);
    if !dest.starts_with(&project) {
        return Err(format!("{}: unpacking goes into the open project's folder", dest.display()));
    }
    let run = cancel::try_begin(EXTRACT_STAGE).ok_or_else(|| "An archive is already being unpacked.".to_string())?;
    let stop = cancel::token(EXTRACT_STAGE);
    let progress = Progress::window(window, PROGRESS_EVENT);
    let entries = crate::rt::spawn_blocking(move || {
        let _run = run;
        extract(&progress, &stop, &archive, &dest, &only)
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;
    for e in &entries {
        state.grants.grant_file(Path::new(&e.path));
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pcl_dataopen_{name}_{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_name_says_where_a_file_goes() {
        assert_eq!(kind_of_name("plot.LAZ"), "cloud");
        assert_eq!(kind_of_name("tile.e57"), "cloud");
        assert_eq!(kind_of_name("points.pts"), "cloud");
        assert_eq!(kind_of_name("scan.ptx"), "ptx");
        assert_eq!(kind_of_name("Plots.zip"), "archive");
        assert_eq!(kind_of_name("notes.docx"), "unknown");
        assert_eq!(kind_of_name("README"), "unknown");
    }

    #[test]
    fn a_folder_is_a_project_or_what_it_holds() {
        let d = temp("folders");
        let proj = d.join("plot 1041");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("project.json"), "{}").unwrap();
        assert_eq!(classify(&proj).kind, "project");
        let tiles = d.join("tiles");
        fs::create_dir_all(tiles.join("sub")).unwrap();
        fs::write(tiles.join("b.laz"), [0u8; 10]).unwrap();
        fs::write(tiles.join("A.las"), [0u8; 3]).unwrap();
        fs::write(tiles.join("readme.md"), "x").unwrap();
        let e = classify(&tiles);
        assert_eq!(e.kind, "folder");
        assert_eq!(e.contents.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["A.las", "b.laz"]);
        assert_eq!(e.contents[1].size, 10);
        assert_eq!(classify(&d.join("missing.laz")).kind, "unknown");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn an_archive_lists_and_unpacks_what_can_be_opened() {
        let d = temp("zip");
        let archive = d.join("Plots.zip");
        {
            let mut z = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
            let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
            z.add_directory("./", opts).unwrap();
            z.start_file("./plot_1041.laz", opts).unwrap();
            z.write_all(&vec![7u8; 300_000]).unwrap();
            z.start_file("objects/0", opts).unwrap();
            z.write_all(b"not data").unwrap();
            z.finish().unwrap();
        }
        let e = classify(&archive);
        assert_eq!(e.kind, "archive");
        assert_eq!(e.contents.len(), 1);
        assert_eq!(e.contents[0].kind, "cloud");
        assert_eq!(e.contents[0].size, 300_000);
        let dest = d.join("project").join("imports").join("Plots");
        let got = extract(&Progress::silent(), &AtomicBool::new(false), &archive, &dest, &[]).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, "cloud");
        assert_eq!(fs::read(&got[0].path).unwrap(), vec![7u8; 300_000]);
        // a second drop of the same archive does not unpack it again
        let modified = fs::metadata(&got[0].path).unwrap().modified().unwrap();
        let again = extract(&Progress::silent(), &AtomicBool::new(false), &archive, &dest, &[]).unwrap();
        assert_eq!(fs::metadata(&again[0].path).unwrap().modified().unwrap(), modified);
        // stopped: nothing half-written is left
        let stopped = extract(&Progress::silent(), &AtomicBool::new(true), &archive, &d.join("other"), &[]);
        assert!(stopped.unwrap_err().starts_with("Stopped"));
        assert!(fs::read_dir(d.join("other")).unwrap().next().is_none());
        let _ = fs::remove_dir_all(&d);
    }
}
