use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const RECENT_MAX: usize = 10;
const RECENT_FILE: &str = "recent.json";

fn recent_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::msg(format!("app_config_dir: {e}")))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(RECENT_FILE))
}

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

fn save_to_disk(path: &std::path::Path, list: &[String]) {
    if let Ok(text) = serde_json::to_string(list) {
        let _ = fs::write(path, text);
    }
}

fn ensure_loaded(app: &AppHandle, state: &State<'_, AppState>) -> AppResult<()> {
    let mut current = state.recent_files.lock();
    if current.is_empty() {
        let p = recent_path(app)?;
        *current = load_from_disk(&p);
    }
    Ok(())
}

#[tauri::command]
pub fn recent_add(app: AppHandle, state: State<'_, AppState>, path: String) -> AppResult<()> {
    if path.is_empty() {
        return Ok(());
    }
    ensure_loaded(&app, &state)?;
    let mut list = state.recent_files.lock();
    list.retain(|p| p != &path);
    list.insert(0, path);
    list.truncate(RECENT_MAX);
    let file = recent_path(&app)?;
    save_to_disk(&file, &list);
    Ok(())
}

#[tauri::command]
pub fn recent_get(app: AppHandle, state: State<'_, AppState>) -> AppResult<Vec<String>> {
    ensure_loaded(&app, &state)?;
    Ok(state.recent_files.lock().clone())
}

#[tauri::command]
pub fn recent_clear(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    state.recent_files.lock().clear();
    let file = recent_path(&app)?;
    save_to_disk(&file, &[]);
    Ok(())
}
