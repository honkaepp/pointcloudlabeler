//! The hierarchy as the viewer opens it, without the JSON.
//!
//! `octree_read_meta` sends hierarchy.bin decoded into one serde record per
//! node, about 85 bytes of JSON each, and the page parses that back into
//! one object per node on its main thread. For the test plot (44 k nodes)
//! that is nothing; a billion-point cloud has over a million nodes, which
//! is some 110 MB of JSON and a second or two of parsing before anything
//! draws. These commands send metadata.json as before and hierarchy.bin as
//! it is on disk, through the raw binary IPC; the front end decodes the
//! 24-byte records itself (`octreeReader.decodeHierarchy`).

use std::path::Path;

/// One hierarchy.bin record: child mask, level, 2 reserved, u32 point
/// count, u64 byte offset, u64 byte size (little-endian).
pub const HIERARCHY_RECORD_BYTES: usize = 24;

/// hierarchy.bin's bytes, checked to be whole records.
pub fn read_hierarchy_bytes(octree_dir: &str) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(Path::new(octree_dir).join("hierarchy.bin"))
        .map_err(|e| format!("read hierarchy.bin: {e}"))?;
    if bytes.len() % HIERARCHY_RECORD_BYTES != 0 {
        return Err(format!(
            "hierarchy.bin length {} is not a multiple of {HIERARCHY_RECORD_BYTES} — file may be corrupt",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// metadata.json, parsed; the front end interprets the schema.
pub fn read_metadata(octree_dir: &str) -> Result<serde_json::Value, String> {
    let bytes = std::fs::read(Path::new(octree_dir).join("metadata.json"))
        .map_err(|e| format!("read metadata.json: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse metadata.json: {e}"))
}

#[cfg_attr(feature = "gui", tauri::command)]
pub async fn octree_read_metadata(octree_dir: String) -> Result<serde_json::Value, String> {
    crate::rt::spawn_blocking(move || read_metadata(&octree_dir))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

#[cfg(feature = "gui")]
#[cfg_attr(feature = "gui", tauri::command)]
pub async fn octree_read_hierarchy(octree_dir: String) -> Result<tauri::ipc::Response, String> {
    let buf = crate::rt::spawn_blocking(move || read_hierarchy_bytes(&octree_dir))
        .await
        .map_err(|e| format!("join error: {e}"))??;
    Ok(tauri::ipc::Response::new(buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tp_hierarchy_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn whole_records_come_back_as_they_are_on_disk() {
        let d = dir("ok");
        let body: Vec<u8> = (0..48u8).collect();
        std::fs::write(d.join("hierarchy.bin"), &body).unwrap();
        assert_eq!(read_hierarchy_bytes(d.to_str().unwrap()).unwrap(), body);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_torn_record_is_an_error() {
        let d = dir("torn");
        std::fs::write(d.join("hierarchy.bin"), vec![0u8; 47]).unwrap();
        let e = read_hierarchy_bytes(d.to_str().unwrap()).unwrap_err();
        assert!(e.contains("not a multiple of 24"), "{e}");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn metadata_is_parsed_json() {
        let d = dir("meta");
        std::fs::write(d.join("metadata.json"), br#"{"pointCount": 7, "tiles": []}"#).unwrap();
        let m = read_metadata(d.to_str().unwrap()).unwrap();
        assert_eq!(m["pointCount"], 7);
        let _ = std::fs::remove_dir_all(&d);
    }
}
