//! A project's name, and renaming it.
//!
//! A project is its folder, and the folder's name is the project's name:
//!
//! * Rename Project renames the folder on disk and project.json's `name`
//!   together ([`rename_project`]), after checking the name is one Windows
//!   takes as a folder name, that no folder of that name is there already,
//!   and that no job is writing into the project. The open project is
//!   closed for the rename (Windows renames no folder a file inside is open
//!   in) and opened again under its new name.
//! * A folder renamed outside the application gives the project its new
//!   name. project.json remembers the folder it was last opened from
//!   (`lastFolder`); the recent list and the open project read the name
//!   from the folder when its name is no longer the one remembered
//!   ([`shown_name`]), and opening the project adopts it ([`adopt_folder`]).
//! * The recent list keeps no stale entry: a missing entry whose project was
//!   renamed in place is found again beside it — the one sibling whose
//!   `lastFolder` is the entry ([`find_renamed`]) — and an entry is dropped
//!   when its project is opened from somewhere else.
//!
//! What a project stores inside itself names its own folder in places: a
//! preprocessing manifest's source unpacked into `imports/`, project.db's
//! `source_file`. When the
//! folder has a new name or place, every such path is moved to it — in the
//! JSON files, string by string so nothing else in a file changes, and in
//! the database's text cells ([`rebase_project`]). The renderer is told
//! (`relocated`), so it moves the per-project keys of this machine's
//! storage too (persistence/projectName.ts).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::commands::project::{
    close_project, now_ms, open_project, read_meta, write_meta, ProjectState,
};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, ProjectMeta, DB_FILE, PROJECT_FILE};

/// The longest project name: the folder holds octrees four levels deep, and
/// a long name brings their paths near what older Windows tools can open.
pub const NAME_MAX: usize = 100;

/// Windows' reserved device names: no file or folder may be called these,
/// with or without an extension.
const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
    "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// What is wrong with `name` as a project (and so a folder) name, or None.
/// Kept in step with persistence/projectName.ts `projectNameProblem`.
pub fn name_problem(name: &str) -> Option<String> {
    let t = name.trim();
    if t.is_empty() {
        return Some("Give the project a name.".into());
    }
    if t.chars().count() > NAME_MAX {
        return Some(format!("A project name can be at most {NAME_MAX} characters."));
    }
    if t == "." || t == ".." {
        return Some("“.” and “..” are not names.".into());
    }
    if let Some(c) = t.chars().find(|c| r#"<>:"/\|?*"#.contains(*c) || (*c as u32) < 32) {
        let shown = if (c as u32) < 32 { "a control character".to_string() } else { format!("“{c}”") };
        return Some(format!("A project name cannot contain {shown} — it is its folder’s name too."));
    }
    if t.ends_with('.') {
        return Some("A project name cannot end in a dot: Windows drops it from the folder's name.".into());
    }
    let stem = t.split('.').next().unwrap_or(t).trim_end().to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        return Some(format!("“{t}” is a name Windows keeps for a device."));
    }
    None
}

// ---------------------------------------------------------------------------
// paths

/// A path as compared: forward slashes, no verbatim prefix, no trailing
/// slash, and on Windows in lower case.
fn norm(p: &str) -> String {
    let mut s = p.replace('\\', "/");
    if let Some(r) = s.strip_prefix("//?/UNC/") {
        s = format!("//{r}");
    } else if let Some(r) = s.strip_prefix("//?/") {
        s = r.to_string();
    }
    while s.len() > 1 && s.ends_with('/') && !s.ends_with(":/") {
        s.pop();
    }
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// Do `a` and `b` name the same folder, however each is spelled?
pub fn same_folder(a: &str, b: &str) -> bool {
    norm(a) == norm(b)
}

/// The last component of a path as written.
pub fn folder_name(p: &str) -> String {
    p.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

fn chars_match(a: char, b: char) -> bool {
    let sep = |c: char| c == '/' || c == '\\';
    if sep(a) || sep(b) {
        return sep(a) && sep(b);
    }
    if cfg!(windows) { a.to_lowercase().eq(b.to_lowercase()) } else { a == b }
}

/// `s` with the folder `from` at its start replaced by `to`, when `s` is
/// that folder or a path inside it; None otherwise. `to` is written the
/// way `s` was: with its separator, a verbatim prefix kept, and in lower
/// case when the matched part was (a key some code built from a
/// lower-cased path). Kept in step with persistence/projectName.ts `rebasePath`.
pub fn rebase(s: &str, from: &str, to: &str) -> Option<String> {
    let (prefix, body) = if let Some(b) = s.strip_prefix(r"\\?\") {
        (r"\\?\", b)
    } else if let Some(b) = s.strip_prefix("//?/") {
        ("//?/", b)
    } else {
        ("", s)
    };
    let from_body = from.strip_prefix(r"\\?\").or_else(|| from.strip_prefix("//?/")).unwrap_or(from);
    let from_body = from_body.trim_end_matches(['/', '\\']);
    if from_body.is_empty() {
        return None;
    }
    let mut it = body.char_indices();
    let mut end = 0usize;
    for f in from_body.chars() {
        let (i, c) = it.next()?;
        if !chars_match(c, f) {
            return None;
        }
        end = i + c.len_utf8();
    }
    let rest = &body[end..];
    if !(rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\')) {
        return None;
    }
    let matched = &body[..end];
    let to_body = to.strip_prefix(r"\\?\").or_else(|| to.strip_prefix("//?/")).unwrap_or(to);
    let to_body = to_body.trim_end_matches(['/', '\\']);
    let mut out = if matched.contains('\\') {
        to_body.replace('/', "\\")
    } else if matched.contains('/') {
        to_body.replace('\\', "/")
    } else {
        to_body.to_string()
    };
    if matched.chars().any(|c| c.is_alphabetic()) && matched == matched.to_lowercase() && matched != from_body {
        out = out.to_lowercase();
    }
    Some(format!("{prefix}{out}{rest}"))
}

/// Every JSON string literal in `text` that is a path under one of `from`,
/// moved to `to`; the rest of the text byte for byte. None when nothing
/// changed. Keys are strings too: a map keyed by path moves with it.
pub fn rebase_json_text(text: &str, from: &[String], to: &str) -> Option<(String, usize)> {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut last = 0usize;
    let mut changed = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] != b'"' {
            i += 1;
            continue;
        }
        let start = i;
        i += 1;
        while i < bytes.len() && bytes[i] != b'"' {
            i += if bytes[i] == b'\\' { 2 } else { 1 };
        }
        let end = (i + 1).min(bytes.len());
        i = end;
        let literal = &text[start..end];
        let Ok(value) = serde_json::from_str::<String>(literal) else { continue };
        let Some(moved) = from.iter().find_map(|f| rebase(&value, f, to)) else { continue };
        let Ok(encoded) = serde_json::to_string(&moved) else { continue };
        out.push_str(&text[last..start]);
        out.push_str(&encoded);
        last = end;
        changed += 1;
    }
    if changed == 0 {
        return None;
    }
    out.push_str(&text[last..]);
    Some((out, changed))
}

/// JSON files larger than this are not data a path would be kept in.
const JSON_MAX_BYTES: u64 = 256 << 20;

fn json_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        let p = e.path();
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            json_files(&p, out);
        } else if ft.is_file()
            && p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("json"))
            && p.file_name().and_then(|n| n.to_str()) != Some(PROJECT_FILE)
            && e.metadata().map(|m| m.len() <= JSON_MAX_BYTES).unwrap_or(false)
        {
            out.push(p);
        }
    }
}

/// Write `text` over `path` through a temporary file beside it.
fn replace_file(path: &Path, text: &str) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".pcl-tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)
}

/// The paths under one of `from` that the JSON files inside `folder` keep,
/// moved to `folder`. Returns how many strings moved.
fn rebase_json_files(folder: &Path, from: &[String], to: &str) -> usize {
    let needles: Vec<String> = from.iter().map(|f| folder_name(f).to_lowercase()).filter(|n| !n.is_empty()).collect();
    // A writer that escapes non-ASCII (ä) hides such a name from the look.
    let look = needles.iter().all(|n| n.is_ascii());
    let mut files = Vec::new();
    json_files(folder, &mut files);
    let mut moved = 0usize;
    for path in files {
        let Ok(text) = fs::read_to_string(&path) else { continue };
        // a cheap look first: a path into the old folder has its name in it
        if look {
            let lower = text.to_ascii_lowercase();
            if !needles.iter().any(|n| lower.contains(n.as_str())) {
                continue;
            }
        }
        let Some((new_text, n)) = rebase_json_text(&text, from, to) else { continue };
        if serde_json::from_str::<serde_json::Value>(&new_text).is_err() {
            continue;
        }
        match replace_file(&path, &new_text) {
            Ok(()) => moved += n,
            Err(e) => eprintln!("project rename: {} not updated: {e}", path.display()),
        }
    }
    moved
}

/// The same for project.db: every text cell holding such a path.
fn rebase_db(folder: &Path, from: &[String], to: &str) -> AppResult<usize> {
    let db_path = folder.join(DB_FILE);
    if !db_path.is_file() {
        return Ok(0);
    }
    let mut conn = rusqlite::Connection::open(&db_path)?;
    let tables: Vec<String> = {
        let mut st = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        rows.flatten().collect()
    };
    let tx = conn.transaction()?;
    let mut moved = 0usize;
    for table in tables {
        let columns: Vec<String> = {
            let Ok(mut st) = tx.prepare(&format!("PRAGMA table_info(\"{table}\")")) else { continue };
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
            rows.flatten()
                .filter(|(_, ty)| ty.is_empty() || ty.to_ascii_uppercase().contains("TEXT"))
                .map(|(name, _)| name)
                .collect()
        };
        for col in columns {
            let Ok(mut st) = tx.prepare(&format!(
                "SELECT rowid, \"{col}\" FROM \"{table}\" WHERE typeof(\"{col}\") = 'text'"
            )) else {
                continue;
            };
            let hits: Vec<(i64, String)> = st
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
                .flatten()
                .filter_map(|(id, v)| from.iter().find_map(|f| rebase(&v, f, to)).map(|n| (id, n)))
                .collect();
            drop(st);
            for (id, v) in hits {
                tx.execute(&format!("UPDATE \"{table}\" SET \"{col}\" = ?1 WHERE rowid = ?2"), rusqlite::params![v, id])?;
                moved += 1;
            }
        }
    }
    tx.commit()?;
    Ok(moved)
}

/// Move every path the project at `folder` keeps that names one of `from`
/// (its earlier places) to `folder`. Returns how many moved.
pub fn rebase_project(folder: &Path, from: &[String]) -> usize {
    let to = folder.to_string_lossy().into_owned();
    let from: Vec<String> = from.iter().filter(|f| !same_folder(f, &to)).cloned().collect();
    if from.is_empty() {
        return 0;
    }
    let mut moved = rebase_json_files(folder, &from, &to);
    match rebase_db(folder, &from, &to) {
        Ok(n) => moved += n,
        Err(e) => eprintln!("project rename: project.db paths not updated: {e}"),
    }
    moved
}

// ---------------------------------------------------------------------------
// the project's name and place

/// A project found somewhere other than where it was last opened.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Relocation {
    /// Where the project was before.
    pub from: String,
    /// The project is still there too: this is a copy, not a move.
    pub kept: bool,
    /// Paths stored in the project that were moved to its new place.
    pub paths: usize,
}

/// The name a project shows: the folder's name when the folder has been
/// renamed since the project was last opened, else the name it has.
pub fn shown_name(meta: &ProjectMeta, folder: &Path) -> String {
    let here = folder.to_string_lossy();
    match &meta.last_folder {
        Some(prev) if folder_name(prev) != folder_name(&here) => folder_name(&here),
        _ => meta.name.clone(),
    }
}

/// The project at `folder` is the one that was at `prev` (same project.json
/// identity), still there.
fn same_project_at(prev: &str, meta: &ProjectMeta) -> bool {
    let p = PathBuf::from(prev);
    p.join(PROJECT_FILE).is_file() && read_meta(&p).map(|m| m.created_at == meta.created_at).unwrap_or(false)
}

/// Opening the project at `folder`: if it was last opened somewhere else,
/// take the folder's name, move the paths it keeps, and remember the new
/// place. Writing project.json may fail (a read-only copy): the project
/// still opens, under the folder's name.
pub fn adopt_folder(folder: &Path, meta: &mut ProjectMeta) -> Option<Relocation> {
    let here = folder.to_string_lossy().into_owned();
    match meta.last_folder.clone() {
        Some(prev) if same_folder(&prev, &here) => None,
        None => {
            meta.last_folder = Some(here);
            if let Err(e) = write_meta(folder, meta) {
                eprintln!("project: lastFolder not recorded: {e}");
            }
            None
        }
        Some(prev) => {
            let paths = rebase_project(folder, std::slice::from_ref(&prev));
            meta.name = shown_name(meta, folder);
            let kept = same_project_at(&prev, meta);
            meta.last_folder = Some(here);
            if let Err(e) = write_meta(folder, meta) {
                eprintln!("project: new place not recorded: {e}");
            }
            Some(Relocation { from: prev, kept, paths })
        }
    }
}

/// A missing recent project that was renamed in place: the one folder beside
/// where it was whose project was last opened at `missing`. None when there
/// is none, or more than one (copies) and so no telling.
pub fn find_renamed(missing: &Path) -> Option<PathBuf> {
    let parent = missing.parent()?;
    let was = missing.to_string_lossy();
    let mut found = None;
    for e in fs::read_dir(parent).ok()?.flatten().take(5000) {
        let p = e.path();
        if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) || !p.join(PROJECT_FILE).is_file() {
            continue;
        }
        let Ok(meta) = read_meta(&p) else { continue };
        if meta.last_folder.as_deref().is_some_and(|f| same_folder(f, &was)) {
            if found.is_some() {
                return None;
            }
            found = Some(p);
        }
    }
    found
}

// ---------------------------------------------------------------------------
// renaming

/// What a rename did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    /// The project's folder now.
    pub folder: String,
    pub name: String,
    /// The folder before, and the paths moved with it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relocated: Option<Relocation>,
    /// The project, open again, when it was the open one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectState>,
}

/// Rename one folder, giving Windows a moment when something (the search
/// indexer, an antivirus scan, a thumbnail) holds a file inside briefly.
fn rename_folder(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tries = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if tries < 8 && (e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(32)) => {
                tries += 1;
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            Err(e) => return Err(e),
        }
    }
}

fn in_use_message(e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(32) {
        format!(
            "Windows would not rename the folder: something has a file in it open — an Explorer window or preview, \
             another PointCloudLabeler, a terminal, or a sync client. Close it and try again. ({e})"
        )
    } else {
        format!("The folder could not be renamed: {e}")
    }
}

/// The checks a rename passes before anything is closed or moved: the name,
/// the folder being a project of ours, no other folder of that name beside
/// it, and no job writing into it. Returns the project and where its folder
/// goes. What only trying shows — a file held open by another program — the
/// rename itself reports.
pub fn check_rename(folder: &Path, new_name: &str) -> AppResult<(ProjectMeta, PathBuf)> {
    let name = new_name.trim();
    if let Some(problem) = name_problem(name) {
        return Err(AppError::msg(problem));
    }
    if !folder.join(PROJECT_FILE).is_file() {
        return Err(AppError::msg(format!("Not a project folder: {}", folder.display())));
    }
    let meta = read_meta(folder)?;
    let parent = folder
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| AppError::msg("A project at the root of a drive cannot be renamed"))?;
    let here = folder.to_string_lossy();
    let target = parent.join(name);
    if folder_name(&here) != name {
        if !same_folder(&target.to_string_lossy(), &here) && fs::symlink_metadata(&target).is_ok() {
            return Err(AppError::msg(format!("There is already a folder called “{name}” in {}.", parent.display())));
        }
        if crate::commands::octree::any_dataset_busy_under(folder) {
            return Err(AppError::msg(
                "A job is still writing into a dataset of this project. Wait for it to finish, or stop it, then rename.",
            ));
        }
    }
    Ok((meta, target))
}

/// Rename the project at `folder` to `new_name`: its folder (beside where it
/// is) and project.json's name, with the paths it keeps moved along. The
/// open project is closed for it and opened again under the new name; a
/// rename that fails leaves everything as it was.
pub fn rename_project(state: &AppState, folder: &Path, new_name: &str) -> AppResult<RenameOutcome> {
    let name = new_name.trim();
    let (meta, target) = check_rename(folder, name)?;
    let parent = target.parent().unwrap_or(folder);
    let here = folder.to_string_lossy().into_owned();
    let target_s = target.to_string_lossy().into_owned();
    let was_open = state.project_folder().is_some_and(|f| same_folder(&f.to_string_lossy(), &here));

    // The same folder name: only project.json's name, if it differs.
    if folder_name(&here) == name {
        if meta.name != name {
            if was_open {
                crate::commands::project::save_meta(
                    state,
                    crate::commands::project::MetaPatch {
                        name: Some(name.to_string()),
                        coordinate_system: None,
                        default_cloud_format: None,
                        notes: None,
                    },
                )?;
            } else {
                let mut m = meta;
                m.name = name.to_string();
                m.updated_at = now_ms();
                write_meta(folder, &m)?;
            }
        }
        let project = if was_open { crate::commands::project::current_project(state) } else { None };
        return Ok(RenameOutcome { folder: here, name: name.to_string(), relocated: None, project });
    }
    let case_only = same_folder(&target_s, &here);
    if was_open {
        close_project(state);
    }
    let renamed = if case_only {
        // Windows takes "plot" → "Plot" only by way of a third name.
        let step = parent.join(format!("{name}.renaming-{}", std::process::id()));
        rename_folder(folder, &step).and_then(|()| {
            rename_folder(&step, &target).inspect_err(|_| {
                let _ = fs::rename(&step, folder);
            })
        })
    } else {
        rename_folder(folder, &target)
    };
    if let Err(e) = renamed {
        if was_open {
            let _ = open_project(state, folder);
        }
        return Err(AppError::msg(in_use_message(&e)));
    }

    // The paths it keeps: from where it was opened last and where it was.
    let mut meta = read_meta(&target)?;
    let mut from = vec![here.clone()];
    if let Some(prev) = meta.last_folder.clone() {
        if !same_folder(&prev, &here) {
            from.push(prev);
        }
    }
    let paths = rebase_project(&target, &from);
    let last = meta.last_folder.clone().unwrap_or_else(|| here.clone());
    meta.name = name.to_string();
    meta.updated_at = now_ms();
    meta.last_folder = Some(target_s.clone());
    write_meta(&target, &meta)?;
    replace_recent(&here, &target_s);
    let relocated = Some(Relocation { from: last, kept: false, paths });

    let project = if was_open {
        let mut p = open_project(state, &target)?;
        p.relocated = relocated.clone();
        Some(p)
    } else {
        None
    };
    Ok(RenameOutcome { folder: target_s, name: name.to_string(), relocated, project })
}

/// The recent list with `old` replaced by `new` where it stood.
fn replace_recent(old: &str, new: &str) {
    // the user's list, never a test's (see add_recent)
    if cfg!(test) {
        return;
    }
    let mut list = crate::commands::project::load_recent();
    let mut placed = false;
    list = list
        .into_iter()
        .filter_map(|f| {
            if same_folder(&f, old) || same_folder(&f, new) {
                if placed {
                    return None;
                }
                placed = true;
                return Some(new.to_string());
            }
            Some(f)
        })
        .collect();
    crate::commands::project::save_recent(&list);
}

/// Forget `old` in the recent list (a project opened somewhere else).
pub fn forget_recent(old: &str) {
    if cfg!(test) {
        return;
    }
    let mut list = crate::commands::project::load_recent();
    let before = list.len();
    list.retain(|f| !same_folder(f, old));
    if list.len() != before {
        crate::commands::project::save_recent(&list);
    }
}

// ---------------------------------------------------------------------------
// command (desktop only)

/// A folder the renderer may rename: the open project, a recent one, or one
/// the user picked this run.
#[cfg(feature = "gui")]
fn may_rename(state: &AppState, folder: &str) -> bool {
    state.project_folder().is_some_and(|f| same_folder(&f.to_string_lossy(), folder))
        || crate::commands::project::load_recent().iter().any(|f| same_folder(f, folder))
        || state.authorise_path(folder).is_ok()
}

/// The checks alone, before the renderer closes the open project for a
/// rename: Ok with the folder's new path, or what is in the way.
#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub fn project_rename_check(state: tauri::State<'_, AppState>, folder: String, name: String) -> Result<String, String> {
    if !may_rename(&state, &folder) {
        return Err(format!("{folder} is not a project PointCloudLabeler has open or has opened recently"));
    }
    check_rename(&crate::fsgrant::os_path(&folder), &name)
        .map(|(_, target)| target.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn project_rename(app: tauri::AppHandle, folder: String, name: String) -> Result<RenameOutcome, String> {
    use tauri::Manager;
    let worker = app.clone();
    let out = crate::rt::spawn_blocking(move || {
        let state = worker.state::<AppState>();
        if !may_rename(&state, &folder) {
            return Err(format!("{folder} is not a project PointCloudLabeler has open or has opened recently"));
        }
        rename_project(&state, &crate::fsgrant::os_path(&folder), &name).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("join error: {e}"))??;
    // Both windows hear the project's new name; the Recent menu shows it.
    let main = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::commands::project::emit_changed(&main, &main.state::<AppState>());
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::project::{create_project, CreateOptions};

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pcl-rename-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn make(state: &AppState, folder: &Path, name: &str) -> ProjectState {
        create_project(state, CreateOptions {
            folder: folder.to_string_lossy().into_owned(),
            name: name.into(),
            coordinate_system: None,
            default_cloud_format: None,
            notes: None,
        })
        .unwrap()
    }

    #[test]
    fn a_name_is_one_windows_takes_as_a_folder_name() {
        for ok in ["Plot 1041", "Evo 2024 – kuusikko", "FP08_MLS_2023", "a.b", "Ääni"] {
            assert_eq!(name_problem(ok), None, "{ok}");
        }
        for bad in ["", "   ", "a/b", r"a\b", "a:b", "a*b", "a?b", "a\"b", "a<b", "a>b", "a|b", "plot.", ".", "..", "CON", "nul.txt", "com1", "a\tb"] {
            assert!(name_problem(bad).is_some(), "{bad:?} should be refused");
        }
        assert!(name_problem(&"x".repeat(NAME_MAX + 1)).is_some());
        assert_eq!(name_problem(&"x".repeat(NAME_MAX)), None);
    }

    #[test]
    fn a_path_moves_with_its_folder_and_keeps_its_spelling() {
        let from = r"C:\Plots\Evo";
        let to = r"C:\Plots\Evo 2024";
        assert_eq!(rebase(r"C:\Plots\Evo\octrees\a", from, to).as_deref(), Some(r"C:\Plots\Evo 2024\octrees\a"));
        assert_eq!(rebase("C:/Plots/Evo/octrees/a", from, to).as_deref(), Some("C:/Plots/Evo 2024/octrees/a"));
        assert_eq!(rebase(r"\\?\C:\Plots\Evo\imports\x.e57", from, to).as_deref(), Some(r"\\?\C:\Plots\Evo 2024\imports\x.e57"));
        assert_eq!(rebase(r"C:\Plots\Evo", from, to).as_deref(), Some(r"C:\Plots\Evo 2024"));
        // another folder that only starts the same
        assert_eq!(rebase(r"C:\Plots\Evo2\x", from, to), None);
        assert_eq!(rebase(r"D:\Plots\Evo\x", from, to), None);
        assert_eq!(rebase("not a path", from, to), None);
        if cfg!(windows) {
            assert_eq!(rebase(r"c:\plots\EVO\x", from, to).as_deref(), Some(r"C:\Plots\Evo 2024\x"));
            // a key built from a lower-cased path stays lower case
            assert_eq!(rebase("c:/plots/evo/octrees/a", from, to).as_deref(), Some("c:/plots/evo 2024/octrees/a"));
        }
    }

    #[test]
    fn json_text_changes_only_in_the_moved_strings() {
        let text = "{\n  \"source\": \"C:\\\\Plots\\\\Evo\\\\imports\\\\scan.e57\",\n  \"other\": \"C:\\\\Elsewhere\\\\x\",\n  \"n\": 3,\n  \"esc\": \"a \\\" b\"\n}";
        let (out, n) = rebase_json_text(text, &[r"C:\Plots\Evo".to_string()], r"C:\Plots\Uusi").unwrap();
        assert_eq!(n, 1);
        assert_eq!(out, text.replace("Evo", "Uusi"));
        assert!(rebase_json_text("{\"a\": \"C:/x\"}", &[r"C:\Plots\Evo".to_string()], r"C:\y").is_none());
    }

    #[test]
    fn renaming_moves_the_folder_its_name_and_the_paths_it_keeps() {
        let root = temp("move");
        let folder = root.join("Evo");
        let state = AppState::default();
        make(&state, &folder, "Evo");
        // a sidecar and a database cell naming the project's own folder
        let ds = folder.join("octrees").join("plot");
        fs::create_dir_all(&ds).unwrap();
        let inside = ds.join("seeds.json").to_string_lossy().into_owned();
        fs::write(ds.join("ref.json"), serde_json::to_string(&serde_json::json!({ "path": inside, "n": 1 })).unwrap()).unwrap();
        state
            .with_current(|p| {
                p.db.execute(
                    "INSERT INTO clouds (id, name, source_file, created_at, updated_at) VALUES ('c', 'c', ?1, 0, 0)",
                    [folder.join("imports").join("a.las").to_string_lossy()],
                )?;
                Ok(())
            })
            .unwrap();

        let out = rename_project(&state, &folder, "  Evo 2024 ").unwrap();
        let renamed = root.join("Evo 2024");
        assert_eq!(out.name, "Evo 2024");
        assert!(same_folder(&out.folder, &renamed.to_string_lossy()));
        assert!(!folder.exists() && renamed.join(PROJECT_FILE).is_file());
        // the open project is open again, under its new name
        let p = out.project.expect("reopened");
        assert_eq!(p.meta.name, "Evo 2024");
        assert!(same_folder(&p.folder, &renamed.to_string_lossy()));
        let rel = out.relocated.expect("relocated");
        assert!(same_folder(&rel.from, &folder.to_string_lossy()) && !rel.kept && rel.paths == 2);
        let side: serde_json::Value = serde_json::from_str(&fs::read_to_string(renamed.join("octrees/plot/ref.json")).unwrap()).unwrap();
        assert_eq!(side["path"], renamed.join("octrees").join("plot").join("seeds.json").to_string_lossy().as_ref());
        let cell: String = state.with_current(|p| Ok(p.db.query_row("SELECT source_file FROM clouds", [], |r| r.get(0))?)).unwrap();
        assert_eq!(cell, renamed.join("imports").join("a.las").to_string_lossy());
        let meta = read_meta(&renamed).unwrap();
        assert_eq!(meta.name, "Evo 2024");
        assert_eq!(meta.last_folder.as_deref(), Some(renamed.to_string_lossy().as_ref()));
        close_project(&state);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_rename_is_refused_for_a_bad_name_or_a_folder_that_is_there() {
        let root = temp("refuse");
        let state = AppState::default();
        let folder = root.join("A");
        make(&state, &folder, "A");
        close_project(&state);
        fs::create_dir_all(root.join("B")).unwrap();
        let err = rename_project(&state, &folder, "B").unwrap_err().to_string();
        assert!(err.contains("already a folder"), "{err}");
        let err = rename_project(&state, &folder, "B/C").unwrap_err().to_string();
        assert!(err.contains("cannot contain “/”"), "{err}");
        // the same checks, asked before anything is closed
        assert!(check_rename(&folder, "B").is_err());
        assert_eq!(check_rename(&folder, " C ").unwrap().1, root.join("C"));
        assert!(folder.join(PROJECT_FILE).is_file(), "nothing moved");
        // another program's folder with a project.json of its own: not ours
        let foreign = root.join("Scans");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join(PROJECT_FILE), r#"{"creationdate":"2026-05-05","scanner":{}}"#).unwrap();
        assert!(rename_project(&state, &foreign, "x").is_err());
        assert!(foreign.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_closed_project_renames_and_only_its_case_can_change() {
        let root = temp("case");
        let state = AppState::default();
        let folder = root.join("plot");
        make(&state, &folder, "plot");
        close_project(&state);
        let out = rename_project(&state, &folder, "Plot").unwrap();
        assert!(out.project.is_none(), "a closed project stays closed");
        assert_eq!(folder_name(&out.folder), "Plot");
        let names: Vec<String> = fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec!["Plot".to_string()]);
        assert_eq!(read_meta(&root.join("Plot")).unwrap().name, "Plot");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_renamed_outside_gives_the_project_its_name_and_moves_its_paths() {
        let root = temp("outside");
        let state = AppState::default();
        let folder = root.join("Old name");
        make(&state, &folder, "Old name");
        let inside = folder.join("imports").join("scan.e57").to_string_lossy().into_owned();
        fs::write(folder.join("manifest.json"), serde_json::to_string(&serde_json::json!({ "sourcePath": inside })).unwrap()).unwrap();
        close_project(&state);

        // Explorer renames it
        let renamed = root.join("New name");
        fs::rename(&folder, &renamed).unwrap();
        // the recent list finds it beside where it was, under its new name
        assert_eq!(find_renamed(&folder).as_deref(), Some(renamed.as_path()));
        assert_eq!(shown_name(&read_meta(&renamed).unwrap(), &renamed), "New name");

        let p = open_project(&state, &renamed).unwrap();
        assert_eq!(p.meta.name, "New name");
        let rel = p.relocated.expect("noticed");
        assert!(same_folder(&rel.from, &folder.to_string_lossy()) && !rel.kept && rel.paths == 1);
        let m: serde_json::Value = serde_json::from_str(&fs::read_to_string(renamed.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(m["sourcePath"], renamed.join("imports").join("scan.e57").to_string_lossy().as_ref());
        // opened again, nothing more to do
        close_project(&state);
        assert!(open_project(&state, &renamed).unwrap().relocated.is_none());
        close_project(&state);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_copied_folder_is_a_copy_and_a_moved_one_keeps_its_name() {
        let root = temp("copy");
        let state = AppState::default();
        let a = root.join("A");
        make(&state, &a, "Koeala A");
        close_project(&state);
        // a copy beside it: both last opened at A
        let b = root.join("B");
        fs::create_dir_all(&b).unwrap();
        fs::copy(a.join(PROJECT_FILE), b.join(PROJECT_FILE)).unwrap();
        assert_eq!(find_renamed(&root.join("gone")), None);
        let p = open_project(&state, &b).unwrap();
        assert!(p.relocated.as_ref().is_some_and(|r| r.kept), "A is still there");
        close_project(&state);
        // moved into a folder of the same name elsewhere: the name it had stays
        let elsewhere = root.join("sub");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::rename(&a, elsewhere.join("A")).unwrap();
        let p = open_project(&state, &elsewhere.join("A")).unwrap();
        assert_eq!(p.meta.name, "Koeala A");
        assert!(p.relocated.is_some_and(|r| !r.kept));
        close_project(&state);
        let _ = fs::remove_dir_all(&root);
    }
}
