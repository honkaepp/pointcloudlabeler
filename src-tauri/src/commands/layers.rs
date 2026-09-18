// Analysis layers on disk — `<dataset>/layers/<id>.json` + `<id>.bin`.
//
// The renderer owns the format (src/layers/analysisLayers.ts encodes
// and decodes the payloads, and writes both files through the ordinary
// file bridge). What it cannot do from there is list a directory,
// make one, or delete a file, so those three are here — each confined
// to the `layers/` folder of the dataset it was asked about, with the
// id checked as one path component, so a renderer bug or a crafted
// header cannot name a file anywhere else.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// The header of a saved layer, as listed. The renderer parses the
/// JSON itself; this hands it over as text so the format has one owner.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerEntry {
    pub id: String,
    /// The header file's text.
    pub header: String,
    /// The payload file's length in bytes, 0 when it is missing — the
    /// renderer refuses a header whose payload does not match.
    pub payload_bytes: u64,
}

/// The paths a layer is saved at, both inside `layers/`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerPaths {
    pub json_path: String,
    pub bin_path: String,
}

fn layers_dir(octree_dir: &str) -> PathBuf {
    Path::new(octree_dir).join("layers")
}

/// The id as one path component. The renderer makes ids of the form
/// `<kind>-<timestamp>`; anything with a separator, a `..` or a control
/// character is refused before it reaches the file system.
fn check_id(id: &str) -> Result<(), String> {
    crate::fsgrant::safe_component(id)?;
    if id.is_empty() || id.len() > 128 || id.starts_with('.') {
        return Err(format!("layer id '{id}' is not a plain file stem"));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err(format!("layer id '{id}' has characters a file name cannot carry"));
    }
    Ok(())
}

/// Every saved layer of a dataset: the header text of each `*.json`
/// under `layers/`, with its payload's size. No folder means no layers,
/// not an error — a dataset that never had one is the usual case.
pub fn list_layers(octree_dir: &str) -> Result<Vec<LayerEntry>, String> {
    let dir = layers_dir(octree_dir);
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", dir.display())),
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("json")) != Some(true) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { continue };
        if check_id(stem).is_err() { continue; }
        let header = match std::fs::read_to_string(&path) {
            Ok(h) => h,
            Err(_) => continue,
        };
        let payload_bytes = std::fs::metadata(dir.join(format!("{stem}.bin"))).map(|m| m.len()).unwrap_or(0);
        out.push(LayerEntry { id: stem.to_string(), header, payload_bytes });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// Make sure `layers/` exists and say where this id's two files go.
pub fn prepare_layer(octree_dir: &str, id: &str) -> Result<LayerPaths, String> {
    check_id(id)?;
    let dir = layers_dir(octree_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    Ok(LayerPaths {
        json_path: dir.join(format!("{id}.json")).to_string_lossy().into_owned(),
        bin_path: dir.join(format!("{id}.bin")).to_string_lossy().into_owned(),
    })
}

/// Remove both files of a layer. A file already gone is not an error:
/// the outcome asked for is "not there", and it is.
pub fn delete_layer(octree_dir: &str, id: &str) -> Result<(), String> {
    check_id(id)?;
    let dir = layers_dir(octree_dir);
    for ext in ["json", "bin"] {
        let p = dir.join(format!("{id}.{ext}"));
        match std::fs::remove_file(&p) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("delete {}: {e}", p.display())),
        }
    }
    Ok(())
}

#[tauri::command]
pub fn octree_layers_list(octree_dir: String) -> Result<Vec<LayerEntry>, String> {
    list_layers(&octree_dir)
}

/// The two commands that create or remove files take the dataset
/// directory through the same gate every file command uses (see
/// fsgrant.rs): it must be inside the open project, or a folder the
/// user chose in a dialog. A renderer naming any other directory is
/// refused, so nothing here can make or delete a file outside what the
/// user opened.
#[tauri::command]
pub fn octree_layer_prepare(
    state: tauri::State<'_, crate::state::AppState>,
    octree_dir: String,
    id: String,
) -> Result<LayerPaths, String> {
    let dir = state.authorise_path(&octree_dir).map_err(|e| e.to_string())?;
    prepare_layer(&dir.to_string_lossy(), &id)
}

#[tauri::command]
pub fn octree_layer_delete(
    state: tauri::State<'_, crate::state::AppState>,
    octree_dir: String,
    id: String,
) -> Result<(), String> {
    let dir = state.authorise_path(&octree_dir).map_err(|e| e.to_string())?;
    delete_layer(&dir.to_string_lossy(), &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pointcloudlabeler-layers-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_dataset_without_layers_lists_none() {
        let d = scratch("none");
        assert!(list_layers(&d.to_string_lossy()).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn prepare_list_delete_round_trip() {
        let d = scratch("rt");
        let dir = d.to_string_lossy().into_owned();
        let p = prepare_layer(&dir, "m3c2-20260917-101500").unwrap();
        assert!(Path::new(&p.json_path).parent().unwrap().is_dir(), "layers/ was not created");
        std::fs::write(&p.json_path, r#"{"format":"pointcloudlabeler-layer","version":1,"id":"m3c2-20260917-101500"}"#).unwrap();
        std::fs::write(&p.bin_path, [0u8; 13]).unwrap();
        // A stray file that is not a layer is ignored, not an error.
        std::fs::write(d.join("layers").join("notes.txt"), "x").unwrap();
        let list = list_layers(&dir).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "m3c2-20260917-101500");
        assert_eq!(list[0].payload_bytes, 13);
        assert!(list[0].header.contains("pointcloudlabeler-layer"));
        delete_layer(&dir, "m3c2-20260917-101500").unwrap();
        assert!(list_layers(&dir).unwrap().is_empty());
        // Deleting what is already gone is fine.
        delete_layer(&dir, "m3c2-20260917-101500").unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_id_cannot_leave_the_layers_folder() {
        let d = scratch("ids");
        let dir = d.to_string_lossy().into_owned();
        for bad in ["../metadata", "a/b", "a\\b", "..", ".hidden", "", "x\u{0}y", "läyer"] {
            assert!(prepare_layer(&dir, bad).is_err(), "accepted {bad:?}");
            assert!(delete_layer(&dir, bad).is_err(), "accepted {bad:?}");
        }
        assert!(prepare_layer(&dir, "centerlines-20260917-1200.v2").is_ok());
        let _ = std::fs::remove_dir_all(&d);
    }
}
