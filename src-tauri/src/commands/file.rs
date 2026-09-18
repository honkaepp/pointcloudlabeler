//! Reading and writing the files the user chose, and the dialogs they
//! choose them in.
//!
//! The dialogs live HERE, in Rust, rather than in the renderer calling
//! the dialog plugin directly — which is what it used to do. That is
//! the whole mechanism behind `fsgrant`: if the renderer opens the
//! dialog, the Rust side never learns which file the user picked, and
//! then it has no way to tell a path the user chose from a path the
//! renderer made up. Opening it here means the answer arrives on the
//! side that has to enforce it, and every path below is checked against
//! what the user actually chose (see fsgrant.rs).
//!
//! The renderer's API is unchanged: each dialog still returns the
//! chosen path, or null when the user cancels.

use std::fs;
use std::io::{Read, Seek, SeekFrom};

use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::State;
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::fsgrant::checked_read_len;
use crate::state::AppState;

#[derive(Serialize)]
pub struct FileStat {
    pub size: u64,
    pub name: String,
}

/// One entry of a native dialog's format dropdown.
#[derive(Deserialize)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// What the import flow needs about a picked file up front: the name
/// for the dataset, the byte size for the header-probe slice bounds.
#[derive(Serialize)]
pub struct PickedFile {
    pub name: String,
    pub size: u64,
    pub path: String,
}

fn apply_filters(
    mut builder: tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>,
    filters: &[DialogFilter],
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    for f in filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        builder = builder.add_filter(&f.name, &exts);
    }
    builder
}

/// Native open dialog. `async` deliberately: the blocking dialog calls
/// must not run on the main thread, and an async command does not.
#[tauri::command]
pub async fn dialog_pick_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    filters: Option<Vec<DialogFilter>>,
) -> AppResult<Option<PickedFile>> {
    let builder = apply_filters(app.dialog().file(), &filters.unwrap_or_default());
    let Some(picked) = builder.blocking_pick_file() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| AppError::msg(format!("dialog returned an unusable path: {e}")))?;
    state.grants.grant_file(&path);
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    // A size of 0 is fine — every caller that needs the real one reads
    // it back through file_stat, and a ranged read does not need it.
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(Some(PickedFile {
        name,
        size,
        path: path.to_string_lossy().into_owned(),
    }))
}

/// Native folder picker. Grants the folder and everything under it —
/// picking a scan directory is consent to read the scans in it.
#[tauri::command]
pub async fn dialog_pick_folder(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
) -> AppResult<Option<String>> {
    let mut builder = app.dialog().file();
    if let Some(t) = title {
        builder = builder.set_title(t);
    }
    let Some(picked) = builder.blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| AppError::msg(format!("dialog returned an unusable path: {e}")))?;
    state.grants.grant_dir(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Native save dialog. Grants exactly the file the user named, not the
/// folder it is in: naming one export is not consent to overwrite its
/// neighbours.
#[tauri::command]
pub async fn dialog_save_file(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    default_name: Option<String>,
    filters: Option<Vec<DialogFilter>>,
    title: Option<String>,
) -> AppResult<Option<String>> {
    let mut builder = apply_filters(app.dialog().file(), &filters.unwrap_or_default());
    if let Some(name) = default_name {
        builder = builder.set_file_name(name);
    }
    if let Some(t) = title {
        builder = builder.set_title(t);
    }
    let Some(picked) = builder.blocking_save_file() else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| AppError::msg(format!("dialog returned an unusable path: {e}")))?;
    state.grants.grant_file(&path);
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// A yes/no question in a native message box. True for OK.
///
/// The renderer used to call `window.confirm`. Under Tauri the dialog
/// plugin replaces that with an asynchronous stand-in which, in the
/// plugin version shipped here, invokes a command the plugin no longer
/// registers — so it never asked anything, and rejected instead once
/// the plugin's permissions were left out of the capability. Either way
/// the code after it ran, because a Promise is truthy. The question is
/// now this command, awaited (src/ui/dialogs.ts), and the plugin's own
/// command surface stays closed to the renderer as before.
#[tauri::command]
pub async fn dialog_confirm(app: tauri::AppHandle, message: String, title: Option<String>) -> bool {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    let mut dialog = app
        .dialog()
        .message(message)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancel);
    if let Some(t) = title {
        dialog = dialog.title(t);
    }
    dialog.blocking_show()
}

/// Tell the user something, in a native message box, and wait until it
/// has been dismissed. The renderer's `window.alert` — see above.
#[tauri::command]
pub async fn dialog_message(app: tauri::AppHandle, message: String, title: Option<String>) {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};
    let mut dialog = app
        .dialog()
        .message(message)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::Ok);
    if let Some(t) = title {
        dialog = dialog.title(t);
    }
    let _ = dialog.blocking_show();
}

#[tauri::command]
pub fn file_read(state: State<'_, AppState>, path: String) -> AppResult<Response> {
    let path = state.authorise_path(&path)?;
    // No length bound here, deliberately: the size read is the file's
    // own, not a number the renderer supplied, so there is nothing to
    // inflate. A cap would only refuse a legitimately large read — the
    // CHM and DSM grids this loads for a big plot are ASCII and run to
    // tens of megabytes. `file_read_chunk` is where the bound belongs.
    let bytes = fs::read(&path)?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn file_read_chunk(
    state: State<'_, AppState>,
    path: String,
    offset: u64,
    length: u64,
) -> AppResult<Response> {
    let path = state.authorise_path(&path)?;
    let len = checked_read_len(length)?;
    let mut f = fs::File::open(&path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; len];
    let mut read = 0usize;
    while read < len {
        match f.read(&mut buf[read..])? {
            0 => break,
            n => read += n,
        }
    }
    buf.truncate(read);
    Ok(Response::new(buf))
}

#[tauri::command]
pub fn file_stat(state: State<'_, AppState>, path: String) -> AppResult<FileStat> {
    let path = state.authorise_path(&path)?;
    let stat = fs::metadata(&path)?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    Ok(FileStat {
        size: stat.len(),
        name,
    })
}

#[tauri::command]
pub fn file_write(state: State<'_, AppState>, path: String, content: String) -> AppResult<bool> {
    let resolved = state.authorise_path(&path)?;
    fs::write(&resolved, content.as_bytes())
        .map_err(|e| AppError::msg(format!("write {path}: {e}")))?;
    Ok(true)
}

/// Undo the percent-encoding the bridge applies to a path it sends in
/// a request header. A header value is Latin-1 at best and a Finnish
/// path ("Työpöytä") is not, so the bridge encodes it and this decodes
/// it. Only `%XX` escapes are undone; `+` stays `+`.
pub(crate) fn percent_decode(s: &str) -> AppResult<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 3 > bytes.len() {
                return Err(AppError::msg("truncated percent escape in x-path"));
            }
            let v = std::str::from_utf8(&bytes[i + 1..i + 3])
                .ok()
                .and_then(|h| u8::from_str_radix(h, 16).ok())
                .ok_or_else(|| AppError::msg("bad percent escape in x-path"))?;
            out.push(v);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| AppError::msg("x-path is not UTF-8"))
}

/// The binary sibling of `file_write`, for the PNGs the Compare view
/// exports. The bytes are the raw request body — a JSON array of
/// numbers would be five times the size — and the path travels in the
/// `x-path` header, percent-encoded (see percent_decode). Same
/// authorisation as every other write: a granted folder or the
/// project's own.
#[tauri::command]
pub fn file_write_bytes(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<bool> {
    let raw = request
        .headers()
        .get("x-path")
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| AppError::msg("missing x-path header"))?;
    let path = percent_decode(raw)?;
    let bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(AppError::msg("expected raw binary body"));
        }
    };
    let resolved = state.authorise_path(&path)?;
    fs::write(&resolved, bytes).map_err(|e| AppError::msg(format!("write {path}: {e}")))?;
    Ok(true)
}

#[cfg(test)]
mod percent_tests {
    use super::percent_decode;

    #[test]
    fn a_finnish_path_comes_back_as_it_was() {
        let path = "C:\\Users\\eppu\\Työpöytä\\kuvat\\compare_2026 (1)_source.png";
        // encodeURIComponent's output for the same string.
        let encoded = "C%3A%5CUsers%5Ceppu%5CTy%C3%B6p%C3%B6yt%C3%A4%5Ckuvat%5Ccompare_2026%20(1)_source.png";
        assert_eq!(percent_decode(encoded).unwrap(), path);
        assert_eq!(percent_decode("plain/ascii.png").unwrap(), "plain/ascii.png");
        assert_eq!(percent_decode("a+b").unwrap(), "a+b", "a plus is a plus, not a space");
    }

    #[test]
    fn a_broken_escape_is_refused_rather_than_guessed() {
        assert!(percent_decode("abc%4").is_err(), "truncated");
        assert!(percent_decode("abc%zz").is_err(), "not hex");
        assert!(percent_decode("%ff%fe").is_err(), "not UTF-8");
    }
}
