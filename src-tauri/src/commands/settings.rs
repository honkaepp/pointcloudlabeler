// User settings file at <config dir>\settings.json (per §8A), where the
// config dir is named by the bundle identifier — see app_id.rs.
//
// Replaces / mirrors localStorage so user preferences survive WebView2
// profile resets. The on-disk shape is a single JSON object; the renderer
// reads it once at startup and writes it back debounced on every change.

use std::fs;
use std::path::PathBuf;

use serde_json::Value as JsonValue;

use crate::error::{AppError, AppResult, WithContext};

const SETTINGS_FILE: &str = "settings.json";

fn settings_path() -> AppResult<PathBuf> {
    let dir = crate::app_id::config_dir()
        .ok_or_else(|| AppError::msg("no application data directory"))?;
    fs::create_dir_all(&dir).ctx("creating settings dir")?;
    Ok(dir.join(SETTINGS_FILE))
}

#[tauri::command]
pub fn settings_load() -> AppResult<JsonValue> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(JsonValue::Object(serde_json::Map::new()));
    }
    let bytes = fs::read(&path).ctx("reading settings.json")?;
    if bytes.is_empty() {
        return Ok(JsonValue::Object(serde_json::Map::new()));
    }
    let value: JsonValue = serde_json::from_slice(&bytes).ctx("parsing settings.json")?;
    Ok(value)
}

#[tauri::command]
pub fn settings_save(value: JsonValue) -> AppResult<()> {
    let path = settings_path()?;
    // Atomic write: stage to a temp file then rename, so a crash mid-write
    // doesn't corrupt the canonical file.
    let tmp = path.with_extension("json.tmp");
    let serialized = serde_json::to_vec_pretty(&value).ctx("serialising settings")?;
    fs::write(&tmp, &serialized).ctx("writing settings.json.tmp")?;
    fs::rename(&tmp, &path).ctx("renaming settings.json.tmp")?;
    Ok(())
}
