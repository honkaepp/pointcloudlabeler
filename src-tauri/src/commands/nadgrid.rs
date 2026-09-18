//! NTv2 datum-shift grids (`.gsb`).
//!
//! WHY THIS EXISTS
//! ---------------
//! A datum shift between two geodetic systems is only a Helmert
//! transformation to first order. The residual — the part the seven
//! parameters cannot express, because the old triangulation network was
//! distorted — is up to a couple of metres in the legacy datums still in
//! everyday use (NAD27, OSGB36, NTF, RD, the pre-EUREF national systems).
//! National mapping agencies publish that residual as a grid of
//! interpolated corrections in the NTv2 format, and QGIS / PROJ / RiSCAN
//! PRO all reach centimetre agreement with the official values *only*
//! when that grid is loaded. Without it you get the Helmert answer, which
//! is a metre-level answer wearing a centimetre-level coordinate.
//!
//! 309 of the entries in the vendored EPSG registry (`epsg.tsv`) name a
//! grid file in their proj4 definition. proj4rs refuses those definitions
//! outright (`NadGridNotAvailable`) rather than quietly dropping the
//! shift — the safe failure, and the reason it is worth turning into a
//! working feature rather than a nicer error message.
//!
//! WHAT PointCloudLabeler DOES AND DOES NOT SHIP
//! ---------------------------------
//! It does not ship the grids. They are national data products under
//! their own licences (some redistributable, some not) and together run
//! to hundreds of megabytes. What PointCloudLabeler ships is the ability to *use*
//! them: point the app at a folder of `.gsb` files — the one PROJ
//! already uses, if PROJ is installed, or a folder downloaded from the
//! national agency — and every `+nadgrids=` CRS whose file is present
//! starts working, at the same accuracy as PROJ, because it is the same
//! grid interpolated the same way.
//!
//! The NTv2 *parser* is proj4rs's (`proj4rs::nadgrids::files`) — this
//! module deliberately does not write a second one. What it adds is
//! everything around it:
//!
//!   * **Where to look, safely.** PointCloudLabeler replaces proj4rs's built-in file
//!     finder with a loader that searches the shared geodetic data
//!     folder — see `geodata.rs` for the search order, why the
//!     environment is read but never written, and why a grid name from a
//!     user-supplied proj4 string cannot escape that folder.
//!
//!   * **Saying what happened.** `status()` reports the folder, every
//!     grid file in it, and for each one whether proj4rs could actually
//!     parse it and what it contains. A silently-ignored grid folder
//!     would be the worst outcome of all: the transform would keep
//!     working and keep being wrong by a metre.
//!
//! THREADING
//! ---------
//! proj4rs is built here without its `multi-thread` feature, so its grid
//! catalog — and the builder callback that populates it — is
//! **thread-local**. A builder registered on the main thread is invisible
//! to a Tauri command thread or a rayon worker, which would show up as
//! "the grid works in one place and not another". `ensure_registered()`
//! therefore registers per thread and is called from every path that
//! parses a proj string; see `crs::resolve_proj`.
//!
//! Loaded grids are `Box::leak`ed by proj4rs and there is no eviction
//! API, so a grid parsed before the folder changed stays resolvable on
//! that thread. Rather than pretend otherwise, `status()` reports
//! `restart_required` once that has actually happened.

use std::cell::Cell;
use std::collections::BTreeSet;
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use super::geodata;

use proj4rs::errors::Error as ProjError;
use proj4rs::nadgrids::{catalog, Catalog, GridRef};
use serde::Serialize;

/// Every (grid file name, folder it was parsed from) pair that has
/// actually been loaded into some thread's catalog. Only used to answer
/// "is a grid from a previous folder still live in this process?" — see
/// the module doc's THREADING note.
static LOADED: RwLock<BTreeSet<(String, PathBuf)>> = RwLock::new(BTreeSet::new());

/// Extension of an NTv2 grid file, matched case-insensitively.
const GSB_EXT: &str = "gsb";

// ---------------------------------------------------------------------------
// Grid loading
// ---------------------------------------------------------------------------

/// Whether every grid in `names` is present in the configured folder.
///
/// Answers "can this CRS definition work?" WITHOUT parsing the grid —
/// `crs::proj_string_for_epsg` calls it to decide whether a supplied
/// grid should displace a curated Helmert fallback, and parsing a
/// several-hundred-megabyte national grid merely to answer a question
/// about a dropdown entry would be absurd. An empty list is `false`:
/// "needs no grids" is not "its grids are available", and the caller
/// distinguishes the two.
pub fn grids_available(names: &[String]) -> bool {
    if names.is_empty() {
        return false;
    }
    names.iter().all(|n| geodata::resolve(n).is_some())
}

/// The `proj4rs::nadgrids::catalog::GridBuilder` PointCloudLabeler registers in
/// place of proj4rs's own file finder. Plain `fn` pointer by necessity
/// (that is the callback type), hence the process-global folder.
fn load_grid(catalog: &Catalog, key: &str) -> Result<(), ProjError> {
    let path = geodata::resolve(key).ok_or_else(|| ProjError::GridFileNotFound(key.to_string()))?;
    let file = File::open(&path).map_err(ProjError::from)?;
    proj4rs::nadgrids::files::read(catalog, key, &mut BufReader::new(file))?;
    if let Ok(mut loaded) = LOADED.write() {
        // Record the FOLDER, not the file: `restart_required` asks
        // whether a resident grid came from somewhere PointCloudLabeler no longer
        // searches.
        let from = path.parent().map(Path::to_path_buf).unwrap_or_default();
        loaded.insert((key.to_string(), from));
    }
    Ok(())
}

thread_local! {
    static REGISTERED: Cell<bool> = const { Cell::new(false) };
}

/// Register PointCloudLabeler's grid loader on the calling thread, once.
///
/// Must be called before any `Proj` is parsed on that thread: proj4rs
/// resolves `+nadgrids=` while parsing the proj string, not while
/// transforming, so a builder registered afterwards is too late. See the
/// module doc's THREADING note for why "once per process" is not enough.
pub fn ensure_registered() {
    REGISTERED.with(|r| {
        if !r.get() {
            catalog::set_builder(load_grid);
            r.set(true);
        }
    });
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/// Split a proj4 definition into `+key=value` parameters, keeping a
/// double-quoted value together even when it contains spaces.
///
/// `str::split_whitespace` is right for almost every proj4 string and
/// wrong for the ones that need it most: a quoted value is exactly the
/// case where a name has a space in it, so naive splitting mangles
/// precisely the entries that cannot be recovered by guessing.
fn split_proj_params(proj_str: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in proj_str.chars() {
        match ch {
            '"' => {
                in_quotes = !in_quotes;
                cur.push(ch);
            }
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// The grid file names a proj4 definition needs, in order of appearance.
///
/// Skips the `null` / `@null` sentinels (which mean "no shift, and stop
/// looking") and strips the leading `@` that marks a grid as optional,
/// because for reporting purposes an optional grid is still a grid the
/// user may want to supply.
pub fn required_grids(proj_str: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in split_proj_params(proj_str) {
        let Some(list) = raw.strip_prefix("+nadgrids=") else { continue };
        // proj4 quotes a value containing spaces, and 9 EPSG entries use
        // it — the Australian AGD84 family names
        // `"National 84 (02.07.01).gsb"`. Splitting on whitespace alone
        // reported that grid as `"National`, so the CRS could not work
        // even for a user who had the file, and the error named a
        // filename that does not exist.
        for name in list.split(',') {
            // Quotes are trimmed per NAME, not off the whole list: in
            // `+nadgrids="a b.gsb",c.gsb` the closing quote sits in the
            // middle, so trimming the list would leave it stuck to the
            // first name.
            let name = name.trim().trim_matches('"').trim_start_matches('@').trim().trim_matches('"');
            if name.is_empty() || name.eq_ignore_ascii_case("null") {
                continue;
            }
            if !out.iter().any(|n: &String| n == name) {
                out.push(name.to_string());
            }
        }
    }
    out
}

/// Human-readable account of why a `+nadgrids=` definition failed, given
/// the grid names it asked for. Used by `crs::explain_proj_error`, which
/// is the single place proj4rs failures become user-facing text.
///
/// Three situations, three different things for the user to do, so three
/// different messages. Collapsing them would produce the most annoying
/// possible error: one that names a file sitting right there in the
/// folder and claims it is missing.
pub fn missing_grid_hint(names: &[String]) -> String {
    let dirs = geodata::search_dirs();
    if dirs.is_empty() {
        let list = names.join(", ");
        return format!(
            "needs the NTv2 datum-shift grid {list}, and no geodetic data folder is \
             configured. These grids are national data products that PointCloudLabeler does not \
             ship; download {list} from the national mapping agency (or point PointCloudLabeler \
             at an existing PROJ data folder) and set the folder under Layers → \
             Coordinate system → Geodetic data."
        );
    }
    let where_ = dirs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", ");

    // A name can be present but unreadable — a truncated download, an
    // NTv1/GTX file with a .gsb extension, a Git LFS pointer. Reporting
    // that as "not found" sends the user looking for a file they already
    // have.
    let (present, absent): (Vec<&String>, Vec<&String>) =
        names.iter().partition(|n| geodata::resolve(n).is_some());

    if absent.is_empty() {
        let list = present.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
        return format!(
            "needs the NTv2 datum-shift grid {list}, which WAS found ({where_}) but \
             could not be read — the file may be truncated, or not actually an NTv2 \
             grid. Layers → Coordinate system → Geodetic data lists the exact parse \
             error for each file."
        );
    }

    let list = absent.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ");
    format!(
        "needs the NTv2 datum-shift grid {list}, which is not in any folder PointCloudLabeler \
         searches ({where_}). Add the file to the geodetic data folder — the name \
         must match, apart from upper/lower case — or pick a CRS that does not need \
         a grid."
    )
}

/// One grid table inside a `.gsb` file, as proj4rs parsed it.
///
/// `details` is proj4rs's own `Display` rendering of the loaded grid
/// (extent, node spacing, matrix size). It is passed through verbatim
/// rather than re-derived from the file header: re-reading the header
/// here would be a second NTv2 parser whose answer could disagree with
/// the one actually doing the transforming, which is precisely the class
/// of bug this feature exists to remove.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NadGridInfo {
    /// Whether this is a top-level grid rather than a denser sub-grid
    /// nested inside another.
    pub root: bool,
    pub rows: usize,
    pub cols: usize,
    pub nodes: usize,
    pub details: String,
}

/// One `.gsb` file found in a searched folder.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NadGridFile {
    pub file: String,
    /// Folder it was found in — with several search folders (a
    /// configured one plus PROJ's own), two files can share a name and
    /// only the first wins.
    pub dir: String,
    pub size_bytes: u64,
    /// Whether PointCloudLabeler actually parsed this file. `false` means it was
    /// skipped as too large to verify eagerly (see `MAX_VERIFY_BYTES`),
    /// NOT that anything is wrong with it — `ok` is meaningless then.
    pub checked: bool,
    /// Whether proj4rs could parse it. A file that fails here is not
    /// usable for any transform, so it is reported rather than skipped.
    pub ok: bool,
    pub error: Option<String>,
    pub grids: Vec<NadGridInfo>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NadGridStatus {
    /// The folder the user configured, if any. Distinct from `searched`:
    /// grids can also come from PROJ's environment variables, which the
    /// user did not set here and cannot clear here.
    pub dir: Option<String>,
    /// Whether that folder exists right now. A folder that has been
    /// moved or is on a disconnected network drive reports `false`
    /// rather than an empty file list, which would read as "you have no
    /// grids".
    pub dir_exists: bool,
    /// Every folder searched, in priority order — including any picked
    /// up from `PROJ_NADGRIDS` / `PROJ_DATA`. Shown so that a grid
    /// resolving from a folder the user never configured is visible
    /// rather than mysterious.
    pub searched: Vec<String>,
    pub files: Vec<NadGridFile>,
    /// A grid from a folder no longer searched is still resident in this
    /// process and will keep being used for its name until restart. See
    /// the module doc's THREADING note.
    pub restart_required: bool,
}

/// Largest file `status()` will parse just to verify it.
///
/// Verifying means fully parsing the grid into memory: Germany's
/// BWTA2017.gsb is ~390 MB and 24.5 million nodes. Doing that for every
/// file in a PROJ data directory, on the off-chance the user opens the
/// panel, would freeze the app and balloon its memory for no benefit —
/// so large files are listed but not opened, and load on first real use
/// like any other. Real-world grids are mostly well under this (OSTN15
/// ~18 MB, Canada's NTV2_0 ~5 MB, France's ntf_r93 well under 1 MB), so
/// in practice the common case is still fully verified.
const MAX_VERIFY_BYTES: u64 = 64 * 1024 * 1024;

/// Enumerate every searched folder and report what is actually usable.
///
/// Parsing happens through the same catalog the transforms use, so a
/// file reported `ok` here is one a transform can rely on, and the parse
/// cost is paid once per thread rather than once per call.
pub fn status() -> NadGridStatus {
    ensure_registered();
    let configured = geodata::grid_dir();
    let dirs = geodata::search_dirs();

    let files: Vec<NadGridFile> = geodata::list_by_extension(GSB_EXT)
        .into_iter()
        .map(|(name, dir, size)| inspect(&name, &dir, size))
        .collect();

    let restart_required = LOADED
        .read()
        .map(|l| l.iter().any(|(_, from)| !dirs.contains(from)))
        .unwrap_or(false);

    NadGridStatus {
        dir: configured.as_ref().map(|d| d.display().to_string()),
        dir_exists: configured.as_ref().map(|d| d.is_dir()).unwrap_or(false),
        searched: dirs.iter().map(|d| d.display().to_string()).collect(),
        files,
        restart_required,
    }
}

/// Load one grid file through the real catalog and describe it, or
/// capture why it could not be loaded.
fn inspect(name: &str, dir: &Path, size: u64) -> NadGridFile {
    let base = |checked: bool, ok: bool, error: Option<String>, grids: Vec<NadGridInfo>| NadGridFile {
        file: name.to_string(),
        dir: dir.display().to_string(),
        size_bytes: size,
        checked,
        ok,
        error,
        grids,
    };

    if size > MAX_VERIFY_BYTES {
        return base(false, false, None, Vec::new());
    }

    let mut refs: Vec<GridRef> = Vec::new();
    if catalog::find_grids(name, &mut refs) {
        let grids = refs
            .into_iter()
            .map(|g| NadGridInfo {
                root: g.is_root(),
                rows: g.num_rows(),
                cols: g.row_len(),
                nodes: g.gs_count(),
                details: g.to_string(),
            })
            .collect();
        return base(true, true, None, grids);
    }

    // `find_grids` only reports success/failure — it logs the underlying
    // error and drops it. Re-run the load against a throwaway catalog to
    // recover the reason. Safe to do only on the failure path: a load
    // that failed added nothing, so the throwaway catalog leaks nothing
    // (grids proj4rs accepts are `Box::leak`ed and would).
    base(true, false, Some(replay_failure(name)), Vec::new())
}

fn replay_failure(name: &str) -> String {
    let scratch = Catalog::default();
    match load_grid(&scratch, name) {
        Ok(()) => "grid loaded on retry — try reopening the panel".to_string(),
        Err(ProjError::GridFileNotFound(_)) => "file could not be opened".to_string(),
        Err(e) => format!("{e:?}"),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn nadgrid_status() -> NadGridStatus {
    status()
}

/// Set (or clear, with an empty string) the geodetic data folder and
/// report the resulting state in one round trip, so the panel never
/// shows a folder it has not yet verified.
///
/// Rejects a path that is not a directory instead of accepting it and
/// reporting an empty grid list: "no grids found" and "that path is not
/// a folder" are different problems with different fixes.
#[tauri::command]
pub fn nadgrid_set_dir(dir: String) -> Result<NadGridStatus, String> {
    let trimmed = dir.trim();
    if trimmed.is_empty() {
        geodata::set_grid_dir(None);
        return Ok(status());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err(format!("not a folder: {}", path.display()));
    }
    geodata::set_grid_dir(Some(path));
    Ok(status())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Held for the whole body of any test that touches `GRID_DIR`. See
    /// `test_serial`'s own doc comment for why the lock is defined
    /// outside this module.
    use super::super::geodata::test_serial as serial;

    /// Write a minimal but standard-conforming NTv2 file with a single
    /// root sub-grid and a CONSTANT shift at every node.
    ///
    /// Constant is the point: bilinear interpolation of a constant field
    /// is that constant everywhere inside the grid, so the expected
    /// output of a transform is exact and independent of node ordering,
    /// interpolation weights and the row-reversal NTv2 requires. A grid
    /// with varying shifts would only let us assert "roughly moved",
    /// which would pass just as happily if the shift were being applied
    /// at half strength or to the wrong axis.
    ///
    /// Layout is NTv2's: an 11-record overview header then an 11-record
    /// sub-grid header, both 16 bytes per record, then 16 bytes per node
    /// (lat shift, lon shift, lat accuracy, lon accuracy — all f32
    /// seconds of arc). Longitudes in the header and in the node shifts
    /// are WEST-POSITIVE, which is the format's convention and the
    /// reason `lon_shift_sec` below is negated in the expected value.
    fn write_ntv2(
        path: &Path,
        south_deg: f64,
        north_deg: f64,
        west_deg: f64,
        east_deg: f64,
        inc_deg: f64,
        lat_shift_sec: f32,
        lon_shift_sec: f32,
    ) {
        fn rec(out: &mut Vec<u8>, tag: &[u8; 8], payload: &[u8]) {
            out.extend_from_slice(tag);
            out.extend_from_slice(payload);
            assert_eq!(payload.len(), 8, "NTv2 records are 8-byte tag + 8-byte value");
        }
        fn i32rec(out: &mut Vec<u8>, tag: &[u8; 8], v: i32) {
            let mut payload = [0u8; 8];
            payload[..4].copy_from_slice(&v.to_le_bytes());
            rec(out, tag, &payload);
        }
        fn f64rec(out: &mut Vec<u8>, tag: &[u8; 8], v: f64) {
            rec(out, tag, &v.to_le_bytes());
        }

        let sec = |deg: f64| deg * 3600.0;
        let s_lat = sec(south_deg);
        let n_lat = sec(north_deg);
        // West-positive: an eastern longitude is a negative NTv2 value.
        let e_long = -sec(east_deg);
        let w_long = -sec(west_deg);
        let inc = sec(inc_deg);

        // Matches proj4rs's `lim` computation, which is PROJ's.
        let cols = (((e_long - w_long).abs() / inc + 0.5) + 1.0).floor() as usize;
        let rows = (((n_lat - s_lat).abs() / inc + 0.5) + 1.0).floor() as usize;
        let count = rows * cols;

        let mut out: Vec<u8> = Vec::new();
        // Overview header. NUM_OREC's low byte is what proj4rs reads to
        // detect endianness, so 11-as-little-endian also declares "this
        // file is little-endian".
        i32rec(&mut out, b"NUM_OREC", 11);
        i32rec(&mut out, b"NUM_SREC", 11);
        i32rec(&mut out, b"NUM_FILE", 1);
        rec(&mut out, b"GS_TYPE ", b"SECONDS ");
        // Eight bytes, exactly, like every NTv2 value field. The
        // application name used to sit here ("PointCloudLabelerTST") and in
        // SUB_NAME below, which made this fixture break the moment
        // the product was renamed: a six-letter name pads to nine
        // and `assert_eq!(rec.len(), 8)` fires. Nothing about an
        // NTv2 version tag needs to know what this application is
        // called, so it no longer does.
        rec(&mut out, b"VERSION ", b"NTv2TEST");
        rec(&mut out, b"SYSTEM_F", b"TESTSRC ");
        rec(&mut out, b"SYSTEM_T", b"WGS84   ");
        f64rec(&mut out, b"MAJOR_F ", 6378137.0);
        f64rec(&mut out, b"MINOR_F ", 6356752.314);
        f64rec(&mut out, b"MAJOR_T ", 6378137.0);
        f64rec(&mut out, b"MINOR_T ", 6356752.314);
        assert_eq!(out.len(), 176);

        // Sub-grid header. PARENT "NONE" marks it as a root grid.
        rec(&mut out, b"SUB_NAME", b"TESTGRID");
        rec(&mut out, b"PARENT  ", b"NONE    ");
        rec(&mut out, b"CREATED ", b"01012026");
        rec(&mut out, b"UPDATED ", b"01012026");
        f64rec(&mut out, b"S_LAT   ", s_lat);
        f64rec(&mut out, b"N_LAT   ", n_lat);
        f64rec(&mut out, b"E_LONG  ", e_long);
        f64rec(&mut out, b"W_LONG  ", w_long);
        f64rec(&mut out, b"LAT_INC ", inc);
        f64rec(&mut out, b"LONG_INC", inc);
        i32rec(&mut out, b"GS_COUNT", count as i32);
        assert_eq!(out.len(), 352);

        for _ in 0..count {
            out.extend_from_slice(&lat_shift_sec.to_le_bytes());
            out.extend_from_slice(&lon_shift_sec.to_le_bytes());
            out.extend_from_slice(&0.001f32.to_le_bytes()); // lat accuracy
            out.extend_from_slice(&0.001f32.to_le_bytes()); // lon accuracy
        }

        let mut f = File::create(path).unwrap();
        f.write_all(&out).unwrap();
        f.flush().unwrap();
    }

    fn fixture_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pointcloudlabeler-ntv2-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The whole point of the feature: a `+nadgrids=` CRS that fails
    /// without a grid folder must, with one, both resolve AND move the
    /// point by exactly the amount the grid says.
    ///
    /// Asserting the magnitude is what makes this a real test. proj4rs
    /// happily returns a coordinate whether or not the shift was
    /// applied, so a test that only checked "no error" would pass with
    /// the grid silently ignored — the exact failure mode this feature
    /// is meant to eliminate.
    #[test]
    fn ntv2_grid_shift_is_applied_with_the_documented_sign() {
        let _guard = serial();
        let dir = fixture_dir("apply");
        let grid = dir.join("ntv2test_apply.gsb");
        let (lat_shift_sec, lon_shift_sec) = (10.0f32, 20.0f32);
        write_ntv2(&grid, 59.0, 71.0, 19.0, 32.0, 1.0, lat_shift_sec, lon_shift_sec);

        let src_proj = "+proj=longlat +ellps=WGS84 +nadgrids=ntv2test_apply.gsb +no_defs";
        let dst_proj = "+proj=longlat +datum=WGS84 +no_defs";

        // Without a folder the definition must not resolve at all —
        // proj4rs refusing beats proj4rs guessing.
        geodata::set_grid_dir(None);
        ensure_registered();
        assert!(
            proj4rs::Proj::from_proj_string(src_proj).is_err(),
            "a +nadgrids= CRS must not resolve while no grid folder is configured"
        );

        geodata::set_grid_dir(Some(dir.clone()));
        let src = proj4rs::Proj::from_proj_string(src_proj)
            .expect("+nadgrids= CRS should resolve once the grid folder is configured");
        let dst = proj4rs::Proj::from_proj_string(dst_proj).unwrap();

        let (lon_in, lat_in) = (25.0f64, 60.0f64);
        let mut point = (lon_in.to_radians(), lat_in.to_radians(), 0.0f64);
        proj4rs::transform::transform(&src, &dst, &mut point).unwrap();
        let (lon_out, lat_out) = (point.0.to_degrees(), point.1.to_degrees());

        // NTv2 stores longitude shifts west-positive; going from the
        // grid's source datum to WGS84 adds the latitude shift and
        // SUBTRACTS the longitude shift.
        let expect_lat = lat_in + f64::from(lat_shift_sec) / 3600.0;
        let expect_lon = lon_in - f64::from(lon_shift_sec) / 3600.0;

        // 1e-9° is about 0.1 mm — tight enough that a half-applied or
        // wrong-axis shift (both ~10⁻³°) fails loudly, loose enough to
        // absorb the geodetic↔geocentric round trip the datum transform
        // makes on the way through.
        assert!(
            (lat_out - expect_lat).abs() < 1e-9,
            "latitude {lat_out} should be {expect_lat} (shift {lat_shift_sec}\")"
        );
        assert!(
            (lon_out - expect_lon).abs() < 1e-9,
            "longitude {lon_out} should be {expect_lon} (shift {lon_shift_sec}\")"
        );

        geodata::set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A point outside the grid's coverage must fail rather than come
    /// back unshifted. An unshifted answer is indistinguishable from a
    /// correct one by inspection and wrong by up to a couple of metres.
    #[test]
    fn point_outside_grid_coverage_is_refused() {
        let _guard = serial();
        let dir = fixture_dir("outside");
        write_ntv2(&dir.join("ntv2test_outside.gsb"), 59.0, 71.0, 19.0, 32.0, 1.0, 10.0, 20.0);
        geodata::set_grid_dir(Some(dir.clone()));
        ensure_registered();

        let src = proj4rs::Proj::from_proj_string(
            "+proj=longlat +ellps=WGS84 +nadgrids=ntv2test_outside.gsb +no_defs",
        )
        .unwrap();
        let dst = proj4rs::Proj::from_proj_string("+proj=longlat +datum=WGS84 +no_defs").unwrap();

        // Central Europe — well outside the 19–32°E / 59–71°N fixture.
        let mut point = (10.0f64.to_radians(), 48.0f64.to_radians(), 0.0f64);
        assert!(
            proj4rs::transform::transform(&src, &dst, &mut point).is_err(),
            "a point outside the grid must be refused, not returned unshifted"
        );

        geodata::set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Grid names are matched case-insensitively, because the EPSG
    /// registry's spelling of a file routinely differs in case from what
    /// the national agency ships.
    #[test]
    fn grid_name_matching_ignores_case() {
        let _guard = serial();
        let dir = fixture_dir("case");
        // Deliberately spelled differently from the +nadgrids= name
        // below — that difference IS the test. Keep them case variants
        // of one another; rename one without the other and this passes
        // or fails for a reason that has nothing to do with case.
        write_ntv2(&dir.join("Ntv2Test_Case.GSB"), 59.0, 71.0, 19.0, 32.0, 1.0, 10.0, 20.0);
        geodata::set_grid_dir(Some(dir.clone()));
        ensure_registered();

        assert!(proj4rs::Proj::from_proj_string(
            "+proj=longlat +ellps=WGS84 +nadgrids=ntv2test_case.gsb +no_defs"
        )
        .is_ok());

        geodata::set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_lists_grid_files_and_reports_broken_ones() {
        let _guard = serial();
        let dir = fixture_dir("status");
        write_ntv2(&dir.join("ntv2test_status.gsb"), 59.0, 71.0, 19.0, 32.0, 1.0, 10.0, 20.0);
        std::fs::write(dir.join("broken.gsb"), b"not an ntv2 file at all").unwrap();
        std::fs::write(dir.join("ignored.txt"), b"not a grid").unwrap();
        geodata::set_grid_dir(Some(dir.clone()));

        let st = status();
        assert!(st.dir_exists);
        assert_eq!(st.searched.first().map(String::as_str), Some(dir.display().to_string().as_str()),
            "the configured folder must be searched first, ahead of any PROJ_DATA");
        // Filter to OUR folder: PROJ_NADGRIDS / PROJ_DATA may be set in
        // the environment this test runs in and contribute real grids.
        let ours: Vec<&NadGridFile> =
            st.files.iter().filter(|f| f.dir == dir.display().to_string()).collect();
        assert_eq!(ours.len(), 2, "only .gsb files are listed, got {:?}",
            ours.iter().map(|f| &f.file).collect::<Vec<_>>());

        let good = st.files.iter().find(|f| f.file == "ntv2test_status.gsb").unwrap();
        assert!(good.checked && good.ok, "valid grid should load: {:?}", good.error);
        assert!(good.size_bytes > 0);
        // 19–32°E and 59–71°N at 1° spacing.
        assert_eq!(good.grids.len(), 1);
        assert_eq!(good.grids[0].cols, 14);
        assert_eq!(good.grids[0].rows, 13);
        assert_eq!(good.grids[0].nodes, 182);
        assert!(good.grids[0].root);

        let bad = st.files.iter().find(|f| f.file == "broken.gsb").unwrap();
        assert!(!bad.ok, "a file that cannot be parsed must be reported, not skipped");
        assert!(bad.error.is_some());

        geodata::set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 9 EPSG entries (the Australian AGD84 family) quote a grid name
    /// containing spaces. Splitting on whitespace reported `"National`,
    /// so those CRSs could not work even for a user holding the right
    /// file, and the error named a file that does not exist.
    #[test]
    fn required_grids_handles_a_quoted_name_with_spaces() {
        assert_eq!(
            required_grids(r#"+proj=longlat +ellps=aust_SA +nadgrids="National 84 (02.07.01).gsb" +no_defs"#),
            vec!["National 84 (02.07.01).gsb".to_string()]
        );
        // A quoted name alongside an ordinary one still splits on the comma.
        assert_eq!(
            required_grids(r#"+proj=utm +nadgrids="a b.gsb",c.gsb +units=m"#),
            vec!["a b.gsb".to_string(), "c.gsb".to_string()]
        );
    }

    #[test]
    fn required_grids_reads_the_names_a_definition_needs() {
        assert_eq!(
            required_grids("+proj=longlat +nadgrids=a.gsb,@b.gsb +no_defs"),
            vec!["a.gsb".to_string(), "b.gsb".to_string()]
        );
        // The null sentinels mean "no shift", not "a grid named null".
        assert!(required_grids("+proj=longlat +nadgrids=@null +no_defs").is_empty());
        assert!(required_grids("+proj=longlat +nadgrids=null +no_defs").is_empty());
        assert!(required_grids("+proj=utm +zone=35 +ellps=GRS80").is_empty());
    }

    /// The two hints must differ: with no folder the fix is to configure
    /// one, with a folder the fix is to obtain a named file — so the
    /// second names both the file and where PointCloudLabeler looked.
    #[test]
    fn missing_grid_hint_names_the_file_and_the_folder() {
        let _guard = serial();
        let names = vec!["OSTN15_NTv2_OSGBtoETRS.gsb".to_string()];

        geodata::set_grid_dir(None);
        let unconfigured = missing_grid_hint(&names);
        assert!(unconfigured.contains("OSTN15_NTv2_OSGBtoETRS.gsb"));
        assert!(unconfigured.contains("no geodetic data folder is configured"));

        let dir = fixture_dir("hint");
        geodata::set_grid_dir(Some(dir.clone()));
        let configured = missing_grid_hint(&names);
        assert!(configured.contains("OSTN15_NTv2_OSGBtoETRS.gsb"));
        assert!(
            configured.contains(&dir.display().to_string()),
            "the hint must name the folder that was searched: {configured}"
        );
        assert!(configured.contains("not in any folder PointCloudLabeler searches"));

        geodata::set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A grid file that is present but unreadable must not be reported
    /// as missing — that sends the user hunting for a file they already
    /// have, and hides the real problem (a truncated download, an LFS
    /// pointer, a GTX file with a .gsb extension).
    #[test]
    fn missing_grid_hint_distinguishes_unreadable_from_absent() {
        let _guard = serial();
        let dir = fixture_dir("unreadable");
        std::fs::write(dir.join("present.gsb"), b"truncated").unwrap();
        geodata::set_grid_dir(Some(dir.clone()));

        let hint = missing_grid_hint(&["present.gsb".to_string()]);
        assert!(
            hint.contains("could not be read"),
            "a present-but-broken grid must be reported as unreadable: {hint}"
        );
        assert!(!hint.contains("not in any folder"), "…and not as absent: {hint}");

        geodata::set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `grids_available` answers a question about a dropdown entry, so
    /// it must not parse the grid — only check that the named files are
    /// there. (`crs::proj_string_for_epsg` calls it for every EPSG
    /// lookup.)
    #[test]
    fn grids_available_checks_presence_only() {
        let _guard = serial();
        let dir = fixture_dir("available");
        std::fs::write(dir.join("a.gsb"), b"not a valid grid").unwrap();

        geodata::set_grid_dir(None);
        assert!(!grids_available(&["a.gsb".to_string()]), "no folder means not available");

        geodata::set_grid_dir(Some(dir.clone()));
        assert!(grids_available(&["a.gsb".to_string()]));
        assert!(!grids_available(&["a.gsb".to_string(), "b.gsb".to_string()]), "all must be present");
        // "needs no grids" is a different answer from "its grids are there".
        assert!(!grids_available(&[]));

        geodata::set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
