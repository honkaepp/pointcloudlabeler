//! The geodetic data folder — where PointCloudLabeler looks for grid files.
//!
//! Geodesy needs data files PointCloudLabeler cannot ship: horizontal datum-shift
//! grids (NTv2 `.gsb`, see `nadgrid.rs`) and geoid models (`.gtx`, see
//! `geoid.rs`). Both are national data products under their own
//! licences, both run to hundreds of megabytes together, and both are
//! things a machine with PROJ or QGIS installed already has.
//!
//! They are also, from the user's point of view, one setting: a folder.
//! This module owns it, so that neither grid kind is a client of the
//! other — a geoid model is NTv2's peer, not something that belongs
//! behind an NTv2 module's API — and so that a third kind (ISG, PROJ's
//! modern GeoTIFF grids) plugs in without touching either.
//!
//! SEARCH ORDER
//! ------------
//! The folder the user configured, then PROJ's own `PROJ_NADGRIDS` /
//! `PROJ_DATA` — read, never written. PointCloudLabeler deliberately does not use
//! proj4rs's built-in file finder, which resolves against the process
//! working directory and those same variables: a GUI app's working
//! directory is wherever the launcher happened to be, and making the
//! folder settable from the UI would mean mutating the environment of a
//! running multi-threaded process (unsound, and `unsafe` from the 2024
//! edition on). Honouring the variables read-only keeps the benefit —
//! an existing PROJ or QGIS install needs no configuration at all —
//! without the hazard.
//!
//! NAME RESOLUTION
//! ---------------
//! Grid names arrive from proj4 strings, which can come from the EPSG
//! table *or* from whatever the user typed into the "Other (proj4
//! string)…" box, so `resolve` reduces a name to its final path
//! component before looking: `+nadgrids=../../etc/passwd` must not read
//! outside the searched folders. Matching is case-insensitive, which is
//! needed in its own right — the EPSG registry's spelling of a file
//! (`OSTN15_NTv2_OSGBtoETRS.gsb`) frequently differs in case from what
//! the agency ships.

use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// The folder the user pointed PointCloudLabeler at, or `None` when unconfigured
/// (the default — PointCloudLabeler ships no grids).
static GRID_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

/// localStorage / settings.json key holding the folder. Kept next to
/// `apply_persisted_dir` so the two spellings cannot drift apart, and
/// mirrored in `settingsStore.ts`'s `PERSISTED_KEYS`.
pub const SETTINGS_KEY: &str = "pointcloudlabeler-geodetic-data-dir";

/// The configured folder, if any.
pub fn grid_dir() -> Option<PathBuf> {
    GRID_DIR.read().ok().and_then(|g| g.clone())
}

/// Point PointCloudLabeler at a folder of grid files (or `None` to unconfigure).
///
/// Takes effect immediately for grids not yet loaded; already-loaded
/// grids are sticky — see `nadgrid`'s THREADING note for why, and how
/// its `status()` surfaces that.
pub fn set_grid_dir(dir: Option<PathBuf>) {
    if let Ok(mut g) = GRID_DIR.write() {
        *g = dir;
    }
}

/// Read the persisted folder out of the settings blob and apply it.
///
/// Called once at startup (see `lib.rs`) so a folder configured in a
/// previous session is live before the first transform, rather than only
/// after the renderer mounts. The renderer owns the key — it is in
/// `settingsStore.ts`'s `PERSISTED_KEYS` and written by the same
/// debounced mirror as every other preference — so this is a read, never
/// a write: two writers to one settings file is how a preference gets
/// silently dropped.
pub fn apply_persisted_dir(settings: &serde_json::Value) {
    let raw = settings.get(SETTINGS_KEY).and_then(|v| v.as_str()).unwrap_or("").trim();
    if !raw.is_empty() {
        set_grid_dir(Some(PathBuf::from(raw)));
    }
}

/// Every folder searched, in priority order. See the module doc.
pub fn search_dirs() -> Vec<PathBuf> {
    // The platform's PATH separator rather than the ':' proj4rs
    // hardcodes — on Windows ':' would split "C:\OSGeo4W\share" straight
    // through the drive letter.
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = grid_dir() {
        dirs.push(d);
    }
    for var in ["PROJ_NADGRIDS", "PROJ_DATA"] {
        let Ok(val) = std::env::var(var) else { continue };
        for part in val.split(sep) {
            let part = part.trim();
            if !part.is_empty() {
                let p = PathBuf::from(part);
                if !dirs.contains(&p) {
                    dirs.push(p);
                }
            }
        }
        // PROJ_DATA is the fallback for an unset PROJ_NADGRIDS, not an
        // addition to it — PROJ's own precedence, not a choice made here.
        break;
    }
    dirs
}

/// Find a file by name across every folder in `search_dirs()`.
pub fn resolve(name: &str) -> Option<PathBuf> {
    search_dirs().iter().find_map(|d| resolve_in_dir(d, name))
}

/// Resolve a file name against `dir` without letting it escape. See the
/// module doc's NAME RESOLUTION note for why both halves matter.
pub fn resolve_in_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    let wanted = Path::new(name).file_name()?.to_str()?.to_ascii_lowercase();
    if wanted.is_empty() {
        return None;
    }
    // Exact hit first: avoids listing the directory for the common case,
    // which matters when the folder is a PROJ data directory holding
    // thousands of files.
    let direct = dir.join(&wanted);
    if direct.is_file() {
        return Some(direct);
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let file_name = entry.file_name();
        let Some(candidate) = file_name.to_str() else { continue };
        if candidate.to_ascii_lowercase() == wanted && entry.path().is_file() {
            return Some(entry.path());
        }
    }
    None
}

/// Every file in the searched folders whose extension matches `ext`
/// (case-insensitively), as (name, folder, size) triples, in search
/// order and then by name.
///
/// The first folder wins on a name clash, matching `resolve`; a shadowed
/// duplicate is skipped rather than listed, because listing it would
/// imply it is in use. Sizes come along because both callers need to
/// decide whether a file is small enough to parse eagerly.
pub fn list_by_extension(ext: &str) -> Vec<(String, PathBuf, u64)> {
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut out: Vec<(String, PathBuf, u64)> = Vec::new();
    for dir in search_dirs() {
        let mut found: Vec<(String, u64)> = std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| {
                e.path()
                    .extension()
                    .and_then(|x| x.to_str())
                    .map(|x| x.eq_ignore_ascii_case(ext))
                    .unwrap_or(false)
            })
            .filter_map(|e| {
                let meta = e.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                Some((e.file_name().to_str()?.to_string(), meta.len()))
            })
            .collect();
        found.sort_by(|a, b| a.0.to_ascii_lowercase().cmp(&b.0.to_ascii_lowercase()));
        for (name, size) in found {
            if seen.insert(name.to_ascii_lowercase()) {
                out.push((name, dir.clone(), size));
            }
        }
    }
    out
}

/// Serialises every test that touches the process-global folder.
///
/// The folder has to be process-global (proj4rs's grid-builder callback
/// is a bare `fn` pointer with nowhere to hang context), and the test
/// harness runs tests in parallel threads of a single process — so a
/// test setting the folder races every other test clearing it. The lock
/// lives here rather than in any one module's `mod tests` because
/// `nadgrid`, `geoid` and `crs` all set the folder in their tests, and
/// per-module locks would serialise each file against itself while still
/// letting the files race each other.
#[cfg(test)]
pub(crate) fn test_serial() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
    // A panicking test poisons the lock; the folder is reset by whichever
    // test runs next anyway, so recover rather than cascade one failure
    // into every later test.
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pointcloudlabeler-geodata-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn configured_folder_is_searched_first() {
        let _guard = test_serial();
        let dir = fixture_dir("first");
        set_grid_dir(Some(dir.clone()));
        assert_eq!(search_dirs().first(), Some(&dir), "the user's own folder outranks PROJ's env vars");
        set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Names reach `resolve` from user-supplied proj4 strings, so a
    /// traversal path must not read outside the searched folders.
    #[test]
    fn a_name_cannot_escape_the_folder() {
        let _guard = test_serial();
        let dir = fixture_dir("escape");
        let outside = dir.join("outside");
        let inside = dir.join("inside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::write(outside.join("secret.gsb"), b"x").unwrap();

        assert!(resolve_in_dir(&inside, "../outside/secret.gsb").is_none());
        assert!(resolve_in_dir(&inside, "/etc/passwd").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The EPSG registry's spelling of a grid file routinely differs in
    /// case from what the national agency ships.
    #[test]
    fn resolution_ignores_case() {
        let _guard = test_serial();
        let dir = fixture_dir("case");
        std::fs::write(dir.join("MixedCase.GSB"), b"x").unwrap();
        assert!(resolve_in_dir(&dir, "mixedcase.gsb").is_some());
        assert!(resolve_in_dir(&dir, "MIXEDCASE.GSB").is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_by_extension_filters_and_sizes() {
        let _guard = test_serial();
        let dir = fixture_dir("list");
        std::fs::write(dir.join("b.gtx"), b"1234").unwrap();
        std::fs::write(dir.join("a.GTX"), b"12").unwrap();
        std::fs::write(dir.join("ignored.txt"), b"x").unwrap();
        set_grid_dir(Some(dir.clone()));

        let listed: Vec<(String, PathBuf, u64)> =
            list_by_extension("gtx").into_iter().filter(|(_, d, _)| d == &dir).collect();
        assert_eq!(listed.len(), 2, "only the matching extension, matched case-insensitively");
        // Sorted case-insensitively by name, so a.GTX precedes b.gtx.
        assert_eq!(listed[0].0, "a.GTX");
        assert_eq!(listed[0].2, 2);
        assert_eq!(listed[1].2, 4);

        set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
