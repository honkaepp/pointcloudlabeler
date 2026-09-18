use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::state::{
    open_db, AppState, CoordinateSystem, OpenProject, ProjectMeta, CLOUDS_DIR, PROJECT_FILE,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectState {
    pub folder: String,
    pub meta: ProjectMeta,
}

#[derive(Debug, Deserialize)]
pub struct CreateOptions {
    pub folder: String,
    pub name: String,
    #[serde(default, rename = "coordinateSystem")]
    pub coordinate_system: Option<CoordinateSystem>,
    #[serde(default, rename = "defaultCloudFormat")]
    pub default_cloud_format: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MetaPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, rename = "coordinateSystem")]
    pub coordinate_system: Option<CoordinateSystem>,
    #[serde(default, rename = "defaultCloudFormat")]
    pub default_cloud_format: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RecentProject {
    pub folder: String,
    pub name: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub exists: bool,
}

const RECENT_PROJECTS_FILE: &str = "recentProjects.json";
const RECENT_MAX: usize = 12;

fn read_meta(folder: &std::path::Path) -> AppResult<ProjectMeta> {
    let raw = fs::read_to_string(folder.join(PROJECT_FILE))
        .map_err(|e| AppError::msg(format!("read project.json: {e}")))?;
    let meta: ProjectMeta = serde_json::from_str(&raw)
        .map_err(|e| AppError::msg(format!("parse project.json: {e}")))?;
    Ok(meta)
}

/// Write project.json atomically: stage to a temp file, then rename.
///
/// project.json is what makes a folder a project at all — `is_project_folder`
/// tests for it and `read_meta` must parse it. A crash mid-write therefore
/// does not damage one dataset, it makes the entire project unopenable. The
/// window is small because the file is tiny, but the blast radius is not, and
/// the tmp+rename pattern is already used everywhere else in this codebase.
fn write_meta(folder: &std::path::Path, meta: &ProjectMeta) -> AppResult<()> {
    let s = serde_json::to_string_pretty(meta)?;
    let path = folder.join(PROJECT_FILE);
    let tmp = folder.join(format!("{PROJECT_FILE}.tmp"));
    fs::write(&tmp, s)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}

fn is_project_folder(folder: &std::path::Path) -> bool {
    folder.join(PROJECT_FILE).is_file()
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn ensure_clouds_dir(folder: &std::path::Path) -> AppResult<()> {
    let dir = folder.join(CLOUDS_DIR);
    if !dir.exists() {
        fs::create_dir_all(&dir)?;
    }
    Ok(())
}

fn payload(proj: &OpenProject) -> ProjectState {
    ProjectState {
        folder: proj.folder.to_string_lossy().to_string(),
        meta: proj.meta.clone(),
    }
}

fn recent_projects_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::msg(format!("app_config_dir: {e}")))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(RECENT_PROJECTS_FILE))
}

fn load_recent(app: &AppHandle) -> Vec<String> {
    let Ok(p) = recent_projects_path(app) else {
        return Vec::new();
    };
    let Ok(text) = fs::read_to_string(&p) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<String>>(&text)
        .map(|mut v| {
            v.truncate(RECENT_MAX);
            v
        })
        .unwrap_or_default()
}

fn save_recent(app: &AppHandle, list: &[String]) {
    if let Ok(p) = recent_projects_path(app) {
        if let Ok(text) = serde_json::to_string(list) {
            let _ = fs::write(p, text);
        }
    }
}

fn add_recent(app: &AppHandle, folder: &str) {
    let mut list = load_recent(app);
    list.retain(|p| p != folder);
    list.insert(0, folder.to_string());
    list.truncate(RECENT_MAX);
    save_recent(app, &list);
}

fn emit_changed(app: &AppHandle, state: &AppState) {
    use tauri::Emitter;
    let payload_value = {
        let guard = state.current.lock();
        guard.as_ref().map(payload)
    };
    let _ = app.emit("project:changed", payload_value);
    // Rebuild the native menu so File/Project items reflect the new state
    // (Save enabled/disabled, Recent submenu, Close Project enabled, …).
    crate::menu::apply(app);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn project_current(state: State<'_, AppState>) -> Option<ProjectState> {
    let guard = state.current.lock();
    guard.as_ref().map(payload)
}

#[tauri::command]
pub fn project_create(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: CreateOptions,
) -> AppResult<ProjectState> {
    if opts.folder.is_empty() {
        return Err(AppError::msg("folder is required"));
    }
    if opts.name.is_empty() {
        return Err(AppError::msg("name is required"));
    }
    let folder = PathBuf::from(&opts.folder);
    if folder.join(PROJECT_FILE).exists() {
        return Err(AppError::msg(format!(
            "A project already exists in {}",
            folder.display()
        )));
    }
    fs::create_dir_all(&folder)?;
    ensure_clouds_dir(&folder)?;
    let now = now_ms();
    let meta = ProjectMeta {
        version: 1,
        name: opts.name.clone(),
        created_at: now,
        updated_at: now,
        coordinate_system: opts.coordinate_system.unwrap_or(CoordinateSystem {
            epsg: None,
            name: "unknown".into(),
            vertical: None,
        }),
        default_cloud_format: opts.default_cloud_format.unwrap_or_else(|| "txt".into()),
        notes: opts.notes.unwrap_or_default(),
    };
    write_meta(&folder, &meta)?;
    // Initialise DB.
    let db = open_db(&folder)?;
    drop(db);

    // Open it.
    open_internal(&app, &state, &folder)
}

#[tauri::command]
pub fn project_open(
    app: AppHandle,
    state: State<'_, AppState>,
    folder: String,
) -> AppResult<ProjectState> {
    let folder = PathBuf::from(folder);
    open_internal(&app, &state, &folder)
}

fn open_internal(
    app: &AppHandle,
    state: &AppState,
    folder: &std::path::Path,
) -> AppResult<ProjectState> {
    if !is_project_folder(folder) {
        return Err(AppError::msg(format!(
            "Not a project folder: {}",
            folder.display()
        )));
    }
    // Close existing project first.
    {
        let mut guard = state.current.lock();
        if guard.is_some() {
            *guard = None;
        }
    }
    ensure_clouds_dir(folder)?;
    let meta = read_meta(folder)?;
    let db = open_db(folder)?;
    let proj = OpenProject {
        folder: folder.to_path_buf(),
        meta,
        db,
    };
    let snapshot = payload(&proj);
    *state.current.lock() = Some(proj);

    add_recent(app, &snapshot.folder);
    emit_changed(app, state);
    Ok(snapshot)
}

#[tauri::command]
pub fn project_close(app: AppHandle, state: State<'_, AppState>) -> bool {
    {
        let mut guard = state.current.lock();
        *guard = None;
    }
    {
        let mut writes = state.cloud_writes.lock();
        writes.clear();
        let mut reads = state.cloud_reads.lock();
        reads.clear();
    }
    emit_changed(&app, &state);
    true
}

#[tauri::command]
pub fn project_save_meta(
    state: State<'_, AppState>,
    patch: MetaPatch,
) -> AppResult<ProjectMeta> {
    state.with_current(|proj| {
        if let Some(n) = patch.name {
            proj.meta.name = n;
        }
        if let Some(c) = patch.coordinate_system {
            proj.meta.coordinate_system = c;
        }
        if let Some(f) = patch.default_cloud_format {
            proj.meta.default_cloud_format = f;
        }
        if let Some(n) = patch.notes {
            proj.meta.notes = n;
        }
        proj.meta.updated_at = now_ms();
        write_meta(&proj.folder, &proj.meta)?;
        Ok(proj.meta.clone())
    })
}

/// Public helper used by menu.rs to populate the Recent Projects submenu.
/// Reuses the on-disk recentProjects.json populated by add_recent.
pub fn load_recent_public<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Vec<RecentProject> {
    let cfg_dir = match app.path().app_config_dir() {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let recent_file = cfg_dir.join(RECENT_PROJECTS_FILE);
    let text = match std::fs::read_to_string(&recent_file) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let list: Vec<String> = serde_json::from_str(&text).unwrap_or_default();
    list.into_iter()
        .take(RECENT_MAX)
        .map(|folder| {
            let path = PathBuf::from(&folder);
            match read_meta(&path) {
                Ok(meta) => RecentProject {
                    folder,
                    name: meta.name,
                    updated_at: meta.updated_at,
                    exists: true,
                },
                Err(_) => RecentProject {
                    folder: folder.clone(),
                    name: path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or(&folder)
                        .to_string(),
                    updated_at: 0,
                    exists: false,
                },
            }
        })
        .collect()
}

#[tauri::command]
pub fn project_recent(app: AppHandle) -> Vec<RecentProject> {
    load_recent_public(&app)
}

#[tauri::command]
pub fn project_remove_recent(app: AppHandle, folder: String) -> Vec<String> {
    let mut list = load_recent(&app);
    list.retain(|p| p != &folder);
    save_recent(&app, &list);
    crate::menu::apply(&app);
    list
}
