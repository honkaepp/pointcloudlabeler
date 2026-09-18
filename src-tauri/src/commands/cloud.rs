//! Binary .tcloud save/load.
//!
//! File layout (all little-endian):
//!   [4 B: header JSON length N] [N B: JSON metadata]
//!   [4 B: positions byte length] [positions f32 bytes]
//!   [4 B: treeIds byte length]   [treeIds i32 bytes]
//!   [4 B: deleted byte length]   [deleted u8 bytes] (0 when no deleted set)
//!   for each extra column (in meta.extras order):
//!     [4 B: bytes length]   [packed UTF-8 bytes]
//!     [4 B: offsets length] [Uint32 offsets]
//!
//! Renderer chunks raw bytes at ~256 MiB and the Rust side appends each
//! chunk to a persistent BufWriter-wrapped fd — no structured-clone IPC,
//! no 2 GiB Node Buffer cap, no main-process middleman.

use std::fs;
use std::path::PathBuf;
use std::io::{Read, Seek, SeekFrom, Write};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::{ipc::Response, State};

use crate::error::{AppError, AppResult};
use crate::state::{AppState, CloudHandle};

#[derive(Debug, Serialize)]
pub struct CloudWriteOpen {
    pub handle: u64,
    pub id: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
}

#[derive(Debug, Serialize)]
pub struct CloudReadOpen {
    pub handle: u64,
    #[serde(rename = "totalSize")]
    pub total_size: u64,
}

#[derive(Debug, Serialize)]
pub struct CloudListItem {
    pub id: String,
    pub name: String,
    pub count: u64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    pub size: u64,
}

fn new_cloud_id() -> String {
    use std::time::SystemTime;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let rand: u32 = {
        // Cheap pseudo-random suffix; collisions are vanishingly unlikely combined with ms.
        let mut s = ms as u64;
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        (s & 0xFFFFFF) as u32
    };
    format!("{ms}_{rand:x}")
}

/// Pure helper used by both `cloud_list` and tests. Reads just the metadata
/// The largest .tcloud metadata header this will read.
///
/// `header_len` is four bytes out of the file, so an unbounded read of
/// it asks the allocator for up to 4 GiB on the word of a file that may
/// be damaged or hostile. 1 MiB is orders of magnitude above any real
/// header; the same bound was already applied in `parse_cloud_header`
/// and missing from `cloud_rename`, which read the same field.
const MAX_CLOUD_HEADER: usize = 1024 * 1024;

/// A cloud id names ONE entry in the clouds directory.
///
/// `dir.join(format!("{id}.tcloud"))` with an id of `../../x` lands
/// outside the directory the join was supposed to confine it to. The
/// `.tcloud` suffix limited what could be reached but did not confine
/// it, and "limited" is not the property wanted from a delete.
fn valid_cloud_id(id: &str) -> AppResult<()> {
    crate::fsgrant::safe_component(id).map_err(AppError::msg)
}

/// header from a .tcloud file. Returns the parsed JSON value plus the modified
/// timestamp from the filesystem (used as fallback when meta.savedAt is missing).
pub fn parse_cloud_header(path: &std::path::Path) -> Option<(serde_json::Value, std::fs::Metadata)> {
    let stat = std::fs::metadata(path).ok()?;
    let mut f = std::fs::File::open(path).ok()?;
    let mut len_buf = [0u8; 4];
    f.read_exact(&mut len_buf).ok()?;
    let header_len = u32::from_le_bytes(len_buf) as usize;
    if header_len == 0 || header_len > MAX_CLOUD_HEADER {
        return None;
    }
    let mut header_bytes = vec![0u8; header_len];
    f.read_exact(&mut header_bytes).ok()?;
    let meta_val: serde_json::Value = serde_json::from_slice(&header_bytes).ok()?;
    Some((meta_val, stat))
}

/// Open `dest` for a streaming write, staged through a sibling temp file.
///
/// The write used to go straight at the destination with
/// `truncate(true)`, which destroys it before a single byte of the new
/// content exists. Anything that then went wrong — a full disk, a
/// crash, or the renderer calling abort — left the user with a
/// truncated file and no original, and `cloud_write_abort` finished the
/// job by deleting it outright. Re-saving an existing cloud was
/// therefore a destructive operation with no way back.
///
/// Staging costs nothing here (same directory, so the rename is atomic
/// on every platform PointCloudLabeler targets) and is what the rest of the codebase
/// already does for every sidecar it writes.
///
/// The temp name carries the handle so two writers aimed at one path
/// cannot stage over each other.
fn open_staged(dest: &std::path::Path, handle: u64) -> AppResult<(fs::File, PathBuf)> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    let name = dest.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = match dest.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.join(format!(".{name}.{handle}.part")),
        _ => PathBuf::from(format!(".{name}.{handle}.part")),
    };
    let file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&temp)?;
    Ok((file, temp))
}

/// Finish a staged write: get the bytes onto the disk, then replace the
/// destination in one step.
///
/// `sync_all` rather than `flush`: `File`'s `flush` is a no-op, because
/// `write_all` has already handed everything to the OS. Without the
/// sync, a save the user was told had succeeded can still be lost to a
/// power cut, and the rename can land before the contents do.
///
/// A failed rename leaves the temp in place and says where it is — the
/// data has been written, and deleting it because the last step failed
/// would be the worse of the two outcomes.
fn commit_staged(file: fs::File, temp: &std::path::Path, dest: &std::path::Path) -> AppResult<()> {
    file.sync_all()?;
    drop(file);
    fs::rename(temp, dest).map_err(|e| {
        AppError::msg(format!(
            "could not move the finished write onto {}: {e}. The data is intact at {}",
            dest.display(), temp.display(),
        ))
    })?;
    Ok(())
}

#[tauri::command]
pub fn cloud_write_open(
    state: State<'_, AppState>,
    #[allow(non_snake_case)] existingId: Option<String>,
) -> AppResult<CloudWriteOpen> {
    let dir = state.clouds_dir()?;
    let id = existingId.unwrap_or_else(new_cloud_id);
    let file_path = dir.join(format!("{id}.tcloud"));
    let handle_id = state.allocate_handle();
    let (file, temp) = open_staged(&file_path, handle_id)?;
    let entry = CloudHandle {
        file,
        temp,
        path: file_path.clone(),
        id: id.clone(),
        total_size: 0,
    };
    state.cloud_writes.lock().insert(handle_id, entry);
    Ok(CloudWriteOpen {
        handle: handle_id,
        id,
        file_path: file_path.to_string_lossy().to_string(),
    })
}

/// Open an arbitrary file path for writing. Returns a handle compatible with
/// `cloud_write_append_raw` and `cloud_write_commit` so we can stream large
/// payloads (e.g. multi-GB TXT exports) directly to disk without going through
/// a JS-side string accumulator. This is the export path that fixes the OOM
/// crash in WebView2 when the user tried to dump a 90M-point cloud as TXT.
#[tauri::command]
pub fn file_write_open(
    state: State<'_, AppState>,
    path: String,
) -> AppResult<CloudWriteOpen> {
    let file_path = state.authorise_path(&path)?;
    let handle_id = state.allocate_handle();
    let (file, temp) = open_staged(&file_path, handle_id)?;
    let entry = CloudHandle {
        file,
        temp,
        path: file_path.clone(),
        id: String::new(),
        total_size: 0,
    };
    state.cloud_writes.lock().insert(handle_id, entry);
    Ok(CloudWriteOpen {
        handle: handle_id,
        id: String::new(),
        file_path: file_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn cloud_write_append(
    state: State<'_, AppState>,
    handle: u64,
    bytes: Vec<u8>,
) -> AppResult<bool> {
    let mut writes = state.cloud_writes.lock();
    let entry = writes
        .get_mut(&handle)
        .ok_or_else(|| AppError::msg(format!("Invalid write handle {handle}")))?;
    entry.file.write_all(&bytes)?;
    Ok(true)
}

/// Raw binary append. Renderer sends an ArrayBuffer as the IPC body (no JSON
/// number-array round trip) and passes the write handle via the `x-handle`
/// header. This is the fast path used by the Tauri bridge.
#[tauri::command]
pub fn cloud_write_append_raw(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> AppResult<bool> {
    let handle: u64 = request
        .headers()
        .get("x-handle")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| AppError::msg("missing x-handle header"))?;
    let bytes: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(b) => b.as_slice(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err(AppError::msg("expected raw binary body"));
        }
    };
    let mut writes = state.cloud_writes.lock();
    let entry = writes
        .get_mut(&handle)
        .ok_or_else(|| AppError::msg(format!("Invalid write handle {handle}")))?;
    entry.file.write_all(bytes)?;
    Ok(true)
}

#[tauri::command]
pub fn cloud_write_commit(state: State<'_, AppState>, handle: u64) -> AppResult<bool> {
    let mut writes = state.cloud_writes.lock();
    let entry = writes
        .remove(&handle)
        .ok_or_else(|| AppError::msg(format!("Invalid write handle {handle}")))?;
    commit_staged(entry.file, &entry.temp, &entry.path)?;
    Ok(true)
}

#[tauri::command]
pub fn cloud_write_abort(state: State<'_, AppState>, handle: u64) -> AppResult<bool> {
    let mut writes = state.cloud_writes.lock();
    if let Some(entry) = writes.remove(&handle) {
        // Throw away the staged bytes and leave the destination exactly
        // as it was. Aborting a re-save used to delete the existing
        // cloud, which is the one thing an abort must never do.
        drop(entry.file);
        let _ = fs::remove_file(&entry.temp);
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub fn cloud_read_open(state: State<'_, AppState>, id: String) -> AppResult<CloudReadOpen> {
    let dir = state.clouds_dir()?;
    let file_path = dir.join(format!("{id}.tcloud"));
    let file = fs::File::open(&file_path)?;
    let total = file.metadata()?.len();
    let handle_id = state.allocate_handle();
    let entry = CloudHandle {
        file,
        // A read handle stages nothing; it only ever reads the path it
        // opened.
        temp: file_path.clone(),
        path: file_path,
        id,
        total_size: total,
    };
    state.cloud_reads.lock().insert(handle_id, entry);
    Ok(CloudReadOpen {
        handle: handle_id,
        total_size: total,
    })
}

#[tauri::command]
pub fn cloud_read_chunk(
    state: State<'_, AppState>,
    handle: u64,
    offset: u64,
    length: u64,
) -> AppResult<Response> {
    let mut reads = state.cloud_reads.lock();
    let entry = reads
        .get_mut(&handle)
        .ok_or_else(|| AppError::msg(format!("Invalid read handle {handle}")))?;
    entry.file.seek(SeekFrom::Start(offset))?;
    let len = crate::fsgrant::checked_read_len(length)?;
    let mut buf = vec![0u8; len];
    let mut read = 0usize;
    while read < len {
        match entry.file.read(&mut buf[read..])? {
            0 => break,
            n => read += n,
        }
    }
    buf.truncate(read);
    Ok(Response::new(buf))
}

#[tauri::command]
pub fn cloud_read_close(state: State<'_, AppState>, handle: u64) -> bool {
    state.cloud_reads.lock().remove(&handle).is_some()
}

#[tauri::command]
pub fn cloud_list(state: State<'_, AppState>) -> AppResult<Vec<CloudListItem>> {
    let dir = match state.clouds_dir() {
        Ok(d) => d,
        Err(_) => return Ok(Vec::new()),
    };
    let mut out: Vec<CloudListItem> = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(_) => return Ok(out),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("tcloud") {
            continue;
        }
        let Some((meta_val, stat)) = parse_cloud_header(&path) else { continue };
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = meta_val
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&id)
            .to_string();
        let count = meta_val
            .get("count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let saved_at = meta_val
            .get("savedAt")
            .and_then(|v| v.as_i64())
            .unwrap_or_else(|| {
                stat.modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0)
            });
        out.push(CloudListItem {
            id,
            name,
            count,
            updated_at: saved_at,
            size: stat.len(),
        });
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub fn cloud_delete(state: State<'_, AppState>, id: String) -> bool {
    if valid_cloud_id(&id).is_err() { return false }
    let Ok(dir) = state.clouds_dir() else { return false };
    let path = dir.join(format!("{id}.tcloud"));
    fs::remove_file(&path).is_ok()
}

#[tauri::command]
pub fn cloud_rename(state: State<'_, AppState>, id: String, name: String) -> AppResult<bool> {
    valid_cloud_id(&id)?;
    let dir = state.clouds_dir()?;
    let path = dir.join(format!("{id}.tcloud"));
    let mut file = fs::OpenOptions::new().read(true).write(true).open(&path)?;
    let mut len_buf = [0u8; 4];
    file.read_exact(&mut len_buf)?;
    let header_len = u32::from_le_bytes(len_buf) as usize;
    if header_len == 0 || header_len > MAX_CLOUD_HEADER {
        return Err(AppError::msg(format!(
            "{id}.tcloud declares a {header_len}-byte metadata header; the limit is {MAX_CLOUD_HEADER}"
        )));
    }
    let mut header_bytes = vec![0u8; header_len];
    file.read_exact(&mut header_bytes)?;
    let mut meta: serde_json::Value = serde_json::from_slice(&header_bytes)?;
    if let Some(obj) = meta.as_object_mut() {
        obj.insert("name".to_string(), serde_json::Value::String(name));
    }
    let new_json = serde_json::to_vec(&meta)?;
    if new_json.len() == header_len {
        file.seek(SeekFrom::Start(4))?;
        file.write_all(&new_json)?;
        return Ok(true);
    }
    // Caller must re-save full file with new metadata when size changes.
    Ok(false)
}


/// Saving a cloud, and what happens when it does not finish.
///
/// The write path opened the destination with `truncate(true)`, so the
/// existing file was destroyed before any of the replacement existed.
/// Abort then deleted what was left. Re-saving an existing cloud was a
/// destructive operation with no way back — which is the one thing a
/// save must never be.
#[cfg(test)]
mod staged_write_tests {
    use super::*;
    use std::io::Write;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pointcloudlabeler-staged-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn opening_a_write_does_not_touch_the_existing_file() {
        let dir = tmp_dir("open");
        let dest = dir.join("cloud.tcloud");
        fs::write(&dest, b"the original contents").unwrap();

        let (mut file, temp) = open_staged(&dest, 1).unwrap();
        file.write_all(b"partial new").unwrap();

        assert_eq!(fs::read(&dest).unwrap(), b"the original contents",
            "the destination was truncated before the new write finished");
        assert_ne!(temp, dest, "the staged write must go somewhere else");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_replaces_the_destination_and_removes_the_temp() {
        let dir = tmp_dir("commit");
        let dest = dir.join("cloud.tcloud");
        fs::write(&dest, b"old").unwrap();

        let (mut file, temp) = open_staged(&dest, 2).unwrap();
        file.write_all(b"brand new contents").unwrap();
        commit_staged(file, &temp, &dest).unwrap();

        assert_eq!(fs::read(&dest).unwrap(), b"brand new contents");
        assert!(!temp.exists(), "the temp should be gone after the rename");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The case that used to destroy data: a re-save that is abandoned.
    #[test]
    fn abandoning_a_write_leaves_the_original_intact() {
        let dir = tmp_dir("abort");
        let dest = dir.join("cloud.tcloud");
        fs::write(&dest, b"the original contents").unwrap();

        let (mut file, temp) = open_staged(&dest, 3).unwrap();
        file.write_all(b"half a cloud").unwrap();
        // What cloud_write_abort does.
        drop(file);
        let _ = fs::remove_file(&temp);

        assert_eq!(fs::read(&dest).unwrap(), b"the original contents");
        assert!(!temp.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Writing a cloud that does not exist yet must still work, and must
    /// not leave a stray temp behind.
    #[test]
    fn a_new_file_is_created_by_the_commit_not_the_open() {
        let dir = tmp_dir("new");
        let dest = dir.join("fresh.tcloud");

        let (mut file, temp) = open_staged(&dest, 4).unwrap();
        assert!(!dest.exists(), "nothing should exist at the destination yet");
        file.write_all(b"fresh").unwrap();
        commit_staged(file, &temp, &dest).unwrap();

        assert_eq!(fs::read(&dest).unwrap(), b"fresh");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1, "a temp was left behind");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Two writers aimed at one destination must not stage over each
    /// other — the temp name carries the handle for exactly this.
    #[test]
    fn two_writers_to_one_path_get_separate_temps() {
        let dir = tmp_dir("race");
        let dest = dir.join("cloud.tcloud");

        let (mut a, ta) = open_staged(&dest, 10).unwrap();
        let (mut b, tb) = open_staged(&dest, 11).unwrap();
        assert_ne!(ta, tb, "both writers staged to the same temp");
        a.write_all(b"aaaa").unwrap();
        b.write_all(b"bbbb").unwrap();

        commit_staged(a, &ta, &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"aaaa");
        commit_staged(b, &tb, &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"bbbb", "the second commit should win");
        let _ = fs::remove_dir_all(&dir);
    }

    /// A path whose parent does not exist yet is created — the export
    /// path lets the user pick anywhere.
    #[test]
    fn a_missing_parent_directory_is_created() {
        let dir = tmp_dir("parent");
        let dest = dir.join("nested").join("deeper").join("out.txt");
        let (mut file, temp) = open_staged(&dest, 5).unwrap();
        file.write_all(b"x").unwrap();
        commit_staged(file, &temp, &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"x");
        let _ = fs::remove_dir_all(&dir);
    }

    /// The temp is hidden and named for what it is, so a user who finds
    /// one after a crash can tell what it belongs to.
    #[test]
    fn the_temp_sits_beside_its_destination() {
        let dir = tmp_dir("name");
        let dest = dir.join("scan.tcloud");
        let (_f, temp) = open_staged(&dest, 42).unwrap();
        assert_eq!(temp.parent(), dest.parent(), "the rename must stay within one filesystem");
        let name = temp.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with('.'), "temp name {name}");
        assert!(name.contains("scan.tcloud"), "temp name {name}");
        let _ = fs::remove_dir_all(&dir);
    }
}
