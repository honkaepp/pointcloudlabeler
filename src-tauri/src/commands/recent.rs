#[cfg_attr(not(feature = "gui"), allow(dead_code, unused_imports))]
use std::fs;
#[cfg_attr(not(feature = "gui"), allow(dead_code, unused_imports))]
use std::path::PathBuf;

#[cfg(feature = "gui")]

use tauri::State;

#[cfg_attr(not(feature = "gui"), allow(dead_code, unused_imports))]
use crate::error::{AppError, AppResult};
#[cfg_attr(not(feature = "gui"), allow(dead_code, unused_imports))]
use crate::state::AppState;

#[cfg_attr(not(feature = "gui"), allow(dead_code, unused_imports))]
const RECENT_MAX: usize = 10;
#[cfg_attr(not(feature = "gui"), allow(dead_code, unused_imports))]
const RECENT_FILE: &str = "recent.json";

/// The application's config directory — see `app_id::config_dir`; the
/// same directory Tauri's `app_config_dir()` names.
#[cfg_attr(not(feature = "gui"), allow(dead_code, unused_imports))]
fn recent_path() -> AppResult<PathBuf> {
    let dir = crate::app_id::config_dir()
        .ok_or_else(|| AppError::msg("no application data directory"))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(RECENT_FILE))
}

#[cfg_attr(not(feature = "gui"), allow(dead_code, unused_imports))]
fn load_from_disk(path: &std::path::Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .take(RECENT_MAX)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg_attr(not(feature = "gui"), allow(dead_code, unused_imports))]
fn save_to_disk(path: &std::path::Path, list: &[String]) {
    if let Ok(text) = serde_json::to_string(list) {
        let _ = fs::write(path, text);
    }
}

#[cfg(feature = "gui")]
fn ensure_loaded(state: &State<'_, AppState>) -> AppResult<()> {
    let mut current = state.recent_files.lock();
    if current.is_empty() {
        let p = recent_path()?;
        *current = load_from_disk(&p);
    }
    Ok(())
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub fn recent_add(state: State<'_, AppState>, path: String) -> AppResult<()> {
    if path.is_empty() {
        return Ok(());
    }
    ensure_loaded(&state)?;
    let mut list = state.recent_files.lock();
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(RECENT_MAX);
    let file = recent_path()?;
    save_to_disk(&file, &list);
    Ok(())
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub fn recent_get(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    ensure_loaded(&state)?;
    Ok(state.recent_files.lock().clone())
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub fn recent_clear(state: State<'_, AppState>) -> AppResult<()> {
    state.recent_files.lock().clear();
    let file = recent_path()?;
    save_to_disk(&file, &[]);
    Ok(())
}
