//! Geoid undulation grids (`.gtx`) — converting GNSS/LiDAR heights to
//! heights foresters can actually use.
//!
//! WHY THIS EXISTS
//! ---------------
//! LiDAR height comes from GNSS and is ELLIPSOIDAL (h): height above a
//! mathematical ellipsoid, the same one the horizontal coordinates are
//! defined on. Every forestry height/volume model, every national height
//! system, and "how tall is this tree" all mean ORTHOMETRIC height (H):
//! height above the geoid, which follows the direction gravity actually
//! points and roughly tracks mean sea level. The two differ by the geoid
//! undulation N, H = h - N, and N is not small: it is about +17 to +25 m
//! across Finland and exceeds 100 m in parts of the world. A cloud held
//! in ellipsoidal heights is therefore tens of metres "wrong" against any
//! height system that matters to a forester, and nothing about the
//! numbers themselves reveals it — a stem at h=42 m looks exactly as
//! plausible as one at H=42 m.
//!
//! National and international geodetic agencies publish N as a grid
//! (EGM96 / EGM2008 globally; national refinements for many countries).
//! This module is the reader and bilinear interpolator for that grid, in
//! the GTX format NOAA/NGS uses and that PROJ's legacy datum-grid
//! packages ship (`egm96_15.gtx` worldwide, plus national grids for
//! Finland, Sweden, the US and others). It is `nadgrid.rs`'s sibling —
//! same shared folder, same shape of status report, same reason for
//! existing — for the vertical axis instead of the horizontal one.
//!
//! WHAT THIS MODULE DOES NOT DO
//! -----------------------------
//! It does not apply H = h - N to anything, and it does not decide or
//! record which vertical datum a dataset is in. Those are a separate,
//! parallel piece of work (an export-time step, built on `undulation`
//! below) — this module's job stops at "given a model name and a point,
//! what does the grid say N is there", which is exactly the shape an
//! eventual per-point export loop needs to call.
//!
//! WHAT PointCloudLabeler DOES AND DOES NOT SHIP
//! ----------------------------------
//! Same story as `nadgrid.rs`: geoid grids are national (or, for
//! EGM96/EGM2008, global) data products under their own licences, not
//! shipped with PointCloudLabeler. PointCloudLabeler reads whatever the user points it at —
//! `geodata`'s shared geodetic data folder, the same one `.gsb` files
//! live in, via `geodata::resolve` — so a machine with an existing
//! PROJ/QGIS install already has what's needed, and a user who lacks it
//! downloads exactly one file for exactly the region (or the world) they
//! need.
//!
//! FORMAT, AND WHERE EACH TRAP IS HANDLED
//! ----------------------------------------
//! A GTX file is a 40-byte big-endian header (south latitude, west
//! longitude, latitude step, longitude step — all f64 degrees — then row
//! count and column count as i32), followed by rows*cols big-endian f32
//! undulations, row-major, first row SOUTHERNMOST, west to east within a
//! row. (Note the contrast with NTv2's `.gsb`, which `nadgrid.rs` reads
//! north-first and has to reverse: GTX needs no such flip, because its
//! own first row already is the southernmost one — see `read_gtx`.)
//! Three details will silently produce a wrong answer if ignored, so
//! each is handled explicitly rather than assumed:
//!
//!   * ENDIANNESS. Some GTX files circulating in the wild are
//!     little-endian despite the format nominally being big-endian only.
//!     `parse_header` tries big-endian first and accepts the result only
//!     if it is PLAUSIBLE (see its own doc comment) — not merely
//!     "decoded without error", since 40 arbitrary bytes almost always
//!     decode to SOME f64/i32 bit pattern. An implausible big-endian read
//!     is retried little-endian before the file is rejected.
//!
//!   * LONGITUDE CONVENTION. US-produced grids are commonly written with
//!     longitude 0..360; others use -180..180. `GeoidGrid::undulation`
//!     folds the query longitude into whichever 360-degree window the
//!     grid's own `west` starts, so a lookup is correct regardless of
//!     which convention the specific file happens to use — see that
//!     method's doc comment.
//!
//!   * NODATA. A rectangular grid array covering an irregular coastline
//!     or a national boundary has cells with no real geoid value; GTX
//!     files mark those with an implausible sentinel magnitude rather
//!     than any dedicated flag. `is_nodata` treats anything with
//!     |N| > 1000 m as one — no real geoid undulation gets remotely
//!     close to that, real values worldwide running roughly -110..+90 m
//!     — and `GeoidGrid::undulation` refuses to interpolate any cell
//!     touching one, rather than blending a sentinel into the answer and
//!     returning a number that still looks like a plausible undulation.
//!
//! Symmetrically, a point outside the grid's rectangle entirely is
//! `None`, never the nearest edge value clamped into range: silently
//! returning the edge would produce a wrong height with no signal that
//! anything was wrong, and replacing exactly that kind of silent
//! wrongness with an honest, actionable failure is what this module is
//! for.
//!
//! CACHING
//! -------
//! A geoid lookup will eventually run once per exported point (the
//! H = h - N step this module feeds, not implemented here). Re-parsing a
//! multi-megabyte grid file per point would dominate export time, so the
//! free function `undulation` parses a given file at most once per
//! process and keeps it in `CACHE`, keyed by its resolved path. See
//! `CACHE`'s own doc comment for why a plain `Mutex<HashMap<...>>` is
//! enough here — deliberately the simplest thing that works, not a
//! concurrent map.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;

use super::geodata;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Byte length of a GTX header: 4 `f64` fields then 2 `i32` fields.
const HEADER_LEN: usize = 40;

/// One parsed GTX grid: a regular lat/lon lattice of geoid undulations
/// (metres), row-major, with row 0 the SOUTHERNMOST row and, within a
/// row, column 0 the WESTERNMOST column — the file's own layout, kept
/// as-is (see the module doc comment for why no row reversal is needed,
/// unlike NTv2).
#[derive(Debug)]
pub struct GeoidGrid {
    /// Latitude of the south-west corner, degrees.
    pub south: f64,
    /// Longitude of the south-west corner, degrees. May be in -180..180
    /// or 0..360 depending on how the file was produced — see
    /// `GeoidGrid::undulation`'s LONGITUDE CONVENTION note; nothing else
    /// in this module assumes one convention over the other.
    pub west: f64,
    pub lat_step: f64,
    pub lon_step: f64,
    pub rows: usize,
    pub cols: usize,
    /// `rows * cols` values, row-major, row 0 = south, west -> east
    /// within a row.
    pub values: Vec<f32>,
}

impl GeoidGrid {
    fn at(&self, row: usize, col: usize) -> f32 {
        self.values[row * self.cols + col]
    }
}

/// The four numbers a GTX header stores, decoded under one assumed
/// endianness. Kept separate from `GeoidGrid` because a header can be
/// successfully decoded and still be nonsense (see `parse_header`) —
/// this is only promoted to a `GeoidGrid` once it has also been checked
/// against the file's real size.
struct GtxHeader {
    south: f64,
    west: f64,
    lat_step: f64,
    lon_step: f64,
    rows: usize,
    cols: usize,
    big_endian: bool,
}

/// Try to decode `b` as a GTX header under the given endianness, and
/// accept it only if the result is PLAUSIBLE — not merely "decoded
/// without error". 40 arbitrary bytes almost always decode to some
/// finite f64/i32 bit pattern, so a wrong-endianness read (or a file
/// that isn't GTX at all) has to be caught by what the header CLAIMS,
/// not by whether decoding panicked; it never panics either way, since
/// `from_be_bytes`/`from_le_bytes` on a fixed-size array cannot fail.
///
/// Plausible means: latitude of origin in -90..90, longitude of origin
/// in -360..360 (wide enough to admit both the -180..180 and 0..360
/// conventions), both steps positive and no more than 10 degrees, rows
/// and cols at least 2 (a 1-node grid cannot be bilinearly interpolated
/// at all), and — the check that actually catches almost every garbage
/// or wrong-endianness header that slips past the others — rows * cols
/// * 4 exactly equal to the number of bytes actually left in the file
/// after the header. A header that claims more (or less) data than the
/// file holds is rejected here, cleanly, rather than left for a slice
/// index to panic on later.
fn parse_header(b: &[u8; HEADER_LEN], big_endian: bool, remaining_bytes: u64) -> Option<GtxHeader> {
    let f = |at: usize| -> f64 {
        let raw: [u8; 8] = b[at..at + 8].try_into().unwrap();
        if big_endian { f64::from_be_bytes(raw) } else { f64::from_le_bytes(raw) }
    };
    let i = |at: usize| -> i32 {
        let raw: [u8; 4] = b[at..at + 4].try_into().unwrap();
        if big_endian { i32::from_be_bytes(raw) } else { i32::from_le_bytes(raw) }
    };

    let south = f(0);
    let west = f(8);
    let lat_step = f(16);
    let lon_step = f(24);
    let rows_raw = i(32);
    let cols_raw = i(36);

    if !(-90.0..=90.0).contains(&south) {
        return None;
    }
    if !(-360.0..=360.0).contains(&west) {
        return None;
    }
    if !(lat_step > 0.0 && lat_step <= 10.0) {
        return None;
    }
    if !(lon_step > 0.0 && lon_step <= 10.0) {
        return None;
    }
    if rows_raw < 2 || cols_raw < 2 {
        return None;
    }

    let (rows, cols) = (rows_raw as usize, cols_raw as usize);
    // checked_mul: a byte-swapped garbage header can claim a row/column
    // count in the billions, and rows*cols*4 must not be allowed to wrap
    // around before it gets compared against `remaining_bytes` — a wrap
    // could coincidentally compare equal and let a bogus header through.
    let expected = (rows as u64).checked_mul(cols as u64)?.checked_mul(4)?;
    if expected != remaining_bytes {
        return None;
    }

    Some(GtxHeader { south, west, lat_step, lon_step, rows, cols, big_endian })
}

/// Parse a GTX geoid grid file into memory.
///
/// Reads the whole file at once rather than streaming: GTX grids in
/// practice run from a few kilobytes (a small national refinement) to a
/// few megabytes (EGM96's global 15-arc-minute grid), and `GeoidGrid`
/// keeping every value in memory is exactly what `undulation` needs to
/// interpolate without touching the disk again — see the module doc
/// comment's CACHING note for why that matters.
pub fn read_gtx(path: &Path) -> Result<GeoidGrid, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if bytes.len() < HEADER_LEN {
        return Err(format!(
            "{}: {} bytes, too short for a GTX header ({HEADER_LEN} bytes minimum)",
            path.display(),
            bytes.len()
        ));
    }
    let header_bytes: [u8; HEADER_LEN] = bytes[..HEADER_LEN].try_into().unwrap();
    let remaining = (bytes.len() - HEADER_LEN) as u64;

    // Big-endian is the documented format; little-endian is the observed
    // real-world exception. See the module doc comment's ENDIANNESS note.
    let header = parse_header(&header_bytes, true, remaining)
        .or_else(|| parse_header(&header_bytes, false, remaining))
        .ok_or_else(|| {
            format!(
                "{}: not a valid GTX grid (header failed sanity checks in both big- and \
                 little-endian, or its row/column count does not match the file's actual \
                 size)",
                path.display()
            )
        })?;

    // `parse_header` already proved `remaining` (== data.len()) equals
    // `rows * cols * 4` exactly, so this is exactly `rows * cols` whole
    // 4-byte chunks with nothing left over.
    let data = &bytes[HEADER_LEN..];
    let mut values = Vec::with_capacity(header.rows * header.cols);
    for chunk in data.chunks_exact(4) {
        let raw: [u8; 4] = chunk.try_into().unwrap();
        values.push(if header.big_endian { f32::from_be_bytes(raw) } else { f32::from_le_bytes(raw) });
    }

    Ok(GeoidGrid {
        south: header.south,
        west: header.west,
        lat_step: header.lat_step,
        lon_step: header.lon_step,
        rows: header.rows,
        cols: header.cols,
        values,
    })
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/// Real geoid undulations worldwide run roughly -110..+90 m. GTX files
/// mark nodes with no real value (outside a national grid's actual
/// coverage, inside the rectangular array the format requires) with an
/// implausible sentinel magnitude instead of a dedicated flag — nothing
/// about a sentinel's bit pattern looks invalid in isolation, so the
/// only defence is a magnitude no real undulation gets near. `1000` m
/// leaves an order of magnitude of margin on the real range in both
/// directions while comfortably catching the sentinels actually used in
/// practice (commonly ±9999 or larger).
const NODATA_ABS_THRESHOLD: f32 = 1000.0;

/// Also catches NaN/Inf, which `abs() > THRESHOLD` alone would not (NaN
/// compares false against everything): a non-finite value is exactly as
/// untrustworthy as an out-of-range sentinel and must be treated the
/// same way, not propagated into an interpolated answer that would
/// itself come out NaN.
fn is_nodata(v: f32) -> bool {
    !v.is_finite() || v.abs() > NODATA_ABS_THRESHOLD
}

impl GeoidGrid {
    /// Bilinear interpolation of the geoid undulation at
    /// `(lat_deg, lon_deg)`.
    ///
    /// `None` covers two situations this method deliberately does not
    /// distinguish for its caller: the point falls outside the grid's
    /// rectangle, or it falls inside but at least one of the four nodes
    /// bracketing it is a nodata sentinel (see `is_nodata`). Both return
    /// `None` rather than a nearby-but-wrong number — silently using the
    /// nearest valid edge, or interpolating through a sentinel, would
    /// produce a wrong height with no signal that anything was off. The
    /// free function `undulation` below, which has the grid's extent
    /// available, reports the two possibilities together in its error
    /// text rather than guessing which one actually happened.
    pub fn undulation(&self, lat_deg: f64, lon_deg: f64) -> Option<f64> {
        // `read_gtx` always produces rows/cols >= 2 (see `parse_header`),
        // but the fields are `pub`, so a `GeoidGrid` built by hand with a
        // degenerate size is guarded here too — `self.rows - 2` below
        // would otherwise underflow.
        if self.rows < 2 || self.cols < 2 || !lat_deg.is_finite() || !lon_deg.is_finite() {
            return None;
        }

        // LONGITUDE CONVENTION: fold the query into whichever 360-degree
        // window the grid's own `west` starts. This is correct whether
        // the file uses -180..180 or 0..360, because the two conventions
        // differ only in which window of the same repeating circle they
        // picked — rem_euclid always lands in [0, 360), so `lon` always
        // lands in [self.west, self.west + 360), regardless of the sign
        // or range of the input.
        let lon = (lon_deg - self.west).rem_euclid(360.0) + self.west;

        let row_f = (lat_deg - self.south) / self.lat_step;
        let col_f = (lon - self.west) / self.lon_step;

        let max_row = (self.rows - 1) as f64;
        let max_col = (self.cols - 1) as f64;

        // A hair of tolerance absorbs float round-off for a point that
        // is mathematically exactly on the grid's edge; anything beyond
        // that really is outside and must be refused — never silently
        // clamped into range, which would hide exactly the kind of
        // out-of-coverage mistake this method exists to surface. See the
        // module doc comment.
        const EDGE_EPS: f64 = 1e-9;
        if row_f < -EDGE_EPS || row_f > max_row + EDGE_EPS || col_f < -EDGE_EPS || col_f > max_col + EDGE_EPS {
            return None;
        }
        let row_f = row_f.clamp(0.0, max_row);
        let col_f = col_f.clamp(0.0, max_col);

        // `.min(rows - 2)` rather than a plain floor(): a point exactly
        // on the last row/column (row_f == max_row) still needs a
        // "next" node to interpolate towards, so the lower index is
        // pulled back one and the fractional weight below comes out as
        // exactly 1.0 — full weight on the true edge value, not an
        // out-of-bounds row1/col1 index. Safe because of the rows/cols
        // >= 2 guard above.
        let row0 = (row_f.floor() as usize).min(self.rows - 2);
        let col0 = (col_f.floor() as usize).min(self.cols - 2);
        let row1 = row0 + 1;
        let col1 = col0 + 1;

        let v00 = self.at(row0, col0);
        let v01 = self.at(row0, col1);
        let v10 = self.at(row1, col0);
        let v11 = self.at(row1, col1);
        if is_nodata(v00) || is_nodata(v01) || is_nodata(v10) || is_nodata(v11) {
            return None;
        }

        let fy = row_f - row0 as f64; // 0 at row0 (south side of the cell), 1 at row1
        let fx = col_f - col0 as f64; // 0 at col0 (west side of the cell), 1 at col1

        let row0_interp = v00 as f64 * (1.0 - fx) + v01 as f64 * fx;
        let row1_interp = v10 as f64 * (1.0 - fx) + v11 as f64 * fx;
        Some(row0_interp * (1.0 - fy) + row1_interp * fy)
    }
}

// ---------------------------------------------------------------------------
// Cache + top-level lookup
// ---------------------------------------------------------------------------

/// Parsed grids, keyed by the resolved absolute file path (not the
/// caller's `model` string) — two spellings of a name differing only in
/// case (`geodata::resolve` matches case-insensitively) resolve to the
/// same file and must share one cache entry rather than parse it twice.
///
/// `Mutex<HashMap<...>>` rather than anything fancier: there are at most
/// a handful of distinct geoid models in play in any one session, so a
/// cache miss — the only time the lock is held for more than a HashMap
/// lookup's worth of time — is rare enough that a concurrent map would
/// only add complexity for no measurable benefit. The lock itself is
/// held only for the HashMap read/insert, never across the file parse;
/// see `load`.
static CACHE: OnceLock<Mutex<HashMap<String, Arc<GeoidGrid>>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, Arc<GeoidGrid>>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Parse `path` once and cache the result, or return the already-cached
/// grid. Also used by `status()` below, so a file it reports `ok` is
/// genuinely ready for `undulation` to use without re-parsing.
fn load(path: &Path) -> Result<Arc<GeoidGrid>, String> {
    let key = path.display().to_string();
    if let Some(grid) = cache().lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
        return Ok(grid.clone());
    }
    // Parsed OUTSIDE the lock: holding a mutex across a multi-megabyte
    // file read would block every other thread's lookup of a completely
    // unrelated grid for the duration. Two threads racing to load the
    // same not-yet-cached file both just pay the parse cost once each —
    // the second `insert` overwrites the first with an equal value, so
    // correctness never depends on which one wins, and it is not worth
    // synchronizing away the occasional duplicate parse.
    let grid = Arc::new(read_gtx(path)?);
    cache().lock().unwrap_or_else(|e| e.into_inner()).insert(key, grid.clone());
    Ok(grid)
}

/// Human-readable account of why `model` did not resolve to a file at
/// all — mirrors `nadgrid::missing_grid_hint`'s reasoning (read that
/// function): the fix for "no folder configured" is different from the
/// fix for "a folder is configured but genuinely lacks this file", so
/// they are two different messages. There is no third,
/// present-but-unreadable branch here the way nadgrid's has: that
/// situation never reaches this function, because `geodata::resolve`
/// finding the file is exactly what makes `undulation` skip straight to
/// `load` (and its own distinct error text) instead of calling this.
fn missing_grid_hint(model: &str) -> String {
    let dirs = geodata::search_dirs();
    if dirs.is_empty() {
        return format!(
            "needs the geoid grid {model}, and no geodetic data folder is configured. Geoid \
             models are data products PointCloudLabeler does not ship (global EGM96/EGM2008, or national \
             refinements); download {model} from the national mapping agency or NOAA (or \
             point PointCloudLabeler at an existing PROJ data folder) and set the folder under Layers → \
             Coordinate system → Geodetic data."
        );
    }
    let where_ = dirs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", ");
    format!(
        "needs the geoid grid {model}, which is not in any folder PointCloudLabeler searches ({where_}). \
         Add the file to the geodetic data folder — the name must match, apart from \
         upper/lower case — or pick a different geoid model."
    )
}

/// Resolve `model` to a file, parse-and-cache it, and interpolate N at
/// `(lat_deg, lon_deg)`.
///
/// Three different situations can make this fail, each with a different
/// fix, so each gets its own message rather than one generic "failed" —
/// the same reasoning `nadgrid::missing_grid_hint` documents for its own
/// three-way split: no folder configured at all; a folder configured
/// that simply does not have this file (`missing_grid_hint` covers both
/// of those); the file IS there but is not a file this reader can parse
/// (from `load`); and finally, the file parsed fine but this particular
/// point is not answerable from it (outside its rectangle, or over a
/// nodata cell within it — `GeoidGrid::undulation` does not distinguish
/// the two, so neither does this message; see its own doc comment).
pub fn undulation(model: &str, lat_deg: f64, lon_deg: f64) -> Result<f64, String> {
    let path = geodata::resolve(model).ok_or_else(|| missing_grid_hint(model))?;
    let grid = load(&path).map_err(|e| {
        format!("geoid grid {model} was found ({}) but could not be read: {e}", path.display())
    })?;
    grid.undulation(lat_deg, lon_deg).ok_or_else(|| {
        format!(
            "({lat_deg}, {lon_deg}) has no undulation in geoid grid {model}: either outside \
             its coverage ({:.4}..{:.4} N, {:.4}..{:.4} E) or over a nodata cell within it",
            grid.south,
            grid.south + (grid.rows - 1) as f64 * grid.lat_step,
            grid.west,
            grid.west + (grid.cols - 1) as f64 * grid.lon_step,
        )
    })
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/// Extension of a GTX geoid grid file, matched case-insensitively (see
/// `geodata::list_by_extension`).
const GTX_EXT: &str = "gtx";

/// Largest file `status()` will parse just to verify it — same cap and
/// same reasoning as `nadgrid`'s `MAX_VERIFY_BYTES`: EGM96's global
/// 15-arc-minute grid and most national refinements are only a few
/// megabytes, but a finer global grid (arc-minute class or better) can
/// run to hundreds of megabytes, and fully parsing one just because the
/// user opened a status panel would freeze the app for no benefit. Such
/// a file is listed but not opened, and parses on first real lookup like
/// any other — through the same `load` a real `undulation` call uses, so
/// deferring the parse changes nothing about what that later lookup
/// does.
const MAX_VERIFY_BYTES: u64 = 64 * 1024 * 1024;

/// One `.gtx` file found in a searched folder, and what PointCloudLabeler could
/// determine about it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoidGridFile {
    pub file: String,
    /// Folder it was found in — with more than one search folder (a
    /// configured one plus PROJ's own env vars, via `geodata`), two
    /// files can share a name and only the first wins.
    pub dir: String,
    pub size_bytes: u64,
    /// Whether PointCloudLabeler actually attempted to parse this file. `false`
    /// means it was skipped for being over `MAX_VERIFY_BYTES`, NOT that
    /// anything is wrong with it — `ok` carries no meaning in that case.
    pub checked: bool,
    /// Whether the file parsed as a valid GTX grid. A file that fails
    /// here cannot be used for any lookup, so it is reported rather than
    /// silently skipped.
    pub ok: bool,
    pub error: Option<String>,
    /// Extent and dimensions, in degrees — only known once the file has
    /// actually parsed, hence `Option` rather than a zeroed default that
    /// could be mistaken for a real (if implausible) zero-sized grid.
    pub south: Option<f64>,
    pub north: Option<f64>,
    pub west: Option<f64>,
    pub east: Option<f64>,
    pub rows: Option<usize>,
    pub cols: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoidStatus {
    /// The folder the user configured, if any — the same single folder
    /// `nadgrid_status` reports (`geodata` owns one folder setting for
    /// both grid kinds; see `geodata`'s own module doc comment for why).
    pub dir: Option<String>,
    /// Whether that folder exists right now — `false` rather than an
    /// empty file list for a moved or disconnected folder, which would
    /// otherwise read as "you have no grids".
    pub dir_exists: bool,
    /// Every folder searched, in priority order.
    pub searched: Vec<String>,
    pub files: Vec<GeoidGridFile>,
}

/// Enumerate every searched folder and report what is actually usable.
///
/// Parses through the same cache a real lookup uses (`load`), so a file
/// reported `ok` here is genuinely ready for `undulation` to use without
/// re-parsing — opening the status panel effectively pre-warms whatever
/// grids are small enough to check eagerly.
///
/// Unlike `nadgrid::status`, there is no `restart_required` flag. That
/// flag exists because proj4rs `Box::leak`s a loaded NTv2 grid into a
/// thread-local catalog with no eviction API, so a grid from a folder
/// PointCloudLabeler no longer searches can stay resident and keep answering to its
/// name after the folder changes. `CACHE` here is PointCloudLabeler's own
/// `HashMap`, keyed by resolved absolute path rather than by name — if
/// the configured folder changes, `geodata::resolve` starts returning a
/// different path for the same `model` string, which is simply a
/// different cache key, so there is no analogous staleness to report.
pub fn status() -> GeoidStatus {
    let configured = geodata::grid_dir();
    let dirs = geodata::search_dirs();

    let files: Vec<GeoidGridFile> = geodata::list_by_extension(GTX_EXT)
        .into_iter()
        .map(|(name, dir, size)| inspect(&name, &dir, size))
        .collect();

    GeoidStatus {
        dir: configured.as_ref().map(|d| d.display().to_string()),
        dir_exists: configured.as_ref().map(|d| d.is_dir()).unwrap_or(false),
        searched: dirs.iter().map(|d| d.display().to_string()).collect(),
        files,
    }
}

/// Load one grid file (through the real cache) and describe it, or
/// capture why it could not be loaded.
fn inspect(name: &str, dir: &Path, size: u64) -> GeoidGridFile {
    let base = |checked: bool, ok: bool, error: Option<String>, grid: Option<&GeoidGrid>| GeoidGridFile {
        file: name.to_string(),
        dir: dir.display().to_string(),
        size_bytes: size,
        checked,
        ok,
        error,
        south: grid.map(|g| g.south),
        north: grid.map(|g| g.south + (g.rows - 1) as f64 * g.lat_step),
        west: grid.map(|g| g.west),
        east: grid.map(|g| g.west + (g.cols - 1) as f64 * g.lon_step),
        rows: grid.map(|g| g.rows),
        cols: grid.map(|g| g.cols),
    };

    if size > MAX_VERIFY_BYTES {
        return base(false, false, None, None);
    }

    match load(&dir.join(name)) {
        Ok(grid) => base(true, true, None, Some(&grid)),
        Err(e) => base(true, false, Some(e), None),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn geoid_status() -> GeoidStatus {
    status()
}

/// `model` is a file name, e.g. `"egm96_15.gtx"` — resolved the same way
/// `nadgrid`'s grid names are, through `geodata::resolve` against the
/// shared geodetic data folder. `lat`/`lon` are degrees.
#[tauri::command]
pub fn geoid_undulation(model: String, lat: f64, lon: f64) -> Result<f64, String> {
    undulation(&model, lat, lon)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Held for the whole body of any test that touches the process-
    /// global geodetic data folder. See `geodata::test_serial`'s own doc
    /// comment for why the lock lives there rather than per-module.
    use super::super::geodata::test_serial as serial;

    /// Write a standard-conforming GTX file byte by byte: 40-byte header
    /// (4 `f64` then 2 `i32`, all in the requested endianness) followed
    /// by `values.len()` `f32` values in the same endianness. Mirrors
    /// `nadgrid.rs`'s `write_ntv2` test fixture builder — real bytes, no
    /// fixture file committed to the repo.
    fn write_gtx(
        path: &Path,
        south: f64,
        west: f64,
        lat_step: f64,
        lon_step: f64,
        rows: i32,
        cols: i32,
        values: &[f32],
        big_endian: bool,
    ) {
        fn f64b(v: f64, big: bool) -> [u8; 8] {
            if big { v.to_be_bytes() } else { v.to_le_bytes() }
        }
        fn i32b(v: i32, big: bool) -> [u8; 4] {
            if big { v.to_be_bytes() } else { v.to_le_bytes() }
        }
        fn f32b(v: f32, big: bool) -> [u8; 4] {
            if big { v.to_be_bytes() } else { v.to_le_bytes() }
        }

        let mut out = Vec::with_capacity(HEADER_LEN + values.len() * 4);
        out.extend_from_slice(&f64b(south, big_endian));
        out.extend_from_slice(&f64b(west, big_endian));
        out.extend_from_slice(&f64b(lat_step, big_endian));
        out.extend_from_slice(&f64b(lon_step, big_endian));
        out.extend_from_slice(&i32b(rows, big_endian));
        out.extend_from_slice(&i32b(cols, big_endian));
        assert_eq!(out.len(), HEADER_LEN);
        for &v in values {
            out.extend_from_slice(&f32b(v, big_endian));
        }
        std::fs::write(path, &out).unwrap();
    }

    fn fixture_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pointcloudlabeler-gtx-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Bilinear interpolation of a constant field is that constant
    /// everywhere inside the grid, so the expected value is exact and
    /// independent of interpolation weights and row ordering — the
    /// baseline sanity check before the sharper ramp tests below.
    #[test]
    fn constant_grid_interpolates_to_the_exact_constant_everywhere() {
        let dir = fixture_dir("constant");
        let path = dir.join("const.gtx");
        let (rows, cols) = (5, 5);
        let n: f32 = 21.5;
        let values = vec![n; (rows * cols) as usize];
        write_gtx(&path, 60.0, 20.0, 0.5, 0.5, rows, cols, &values, true);

        let grid = read_gtx(&path).expect("valid GTX");
        // Interior points, including several that are NOT on a node.
        for &(lat, lon) in &[(60.1, 20.1), (61.3, 21.7), (60.0, 20.0), (62.0, 22.0), (60.75, 20.25)] {
            let v = grid.undulation(lat, lon).unwrap_or_else(|| panic!("({lat},{lon}) should be inside coverage"));
            assert_eq!(v, n as f64, "constant grid must interpolate to exactly {n} at ({lat},{lon}), got {v}");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// N varying linearly with LATITUDE: at a point exactly halfway
    /// between two rows the answer must be the exact analytic midpoint.
    /// This is what proves interpolation actually interpolates rather
    /// than snapping to the nearest node — a constant-only test would
    /// pass just as happily under nearest-neighbour lookup.
    #[test]
    fn linear_ramp_in_latitude_hits_the_exact_analytic_midpoint() {
        let dir = fixture_dir("ramp-lat");
        let path = dir.join("ramp_lat.gtx");
        let (south, lat_step) = (60.0, 1.0);
        let (west, lon_step) = (20.0, 1.0);
        let (rows, cols) = (4, 3);
        // N = 10 + 2*row (constant across columns): row 0 (lat 60) = 10,
        // row 1 (lat 61) = 12, row 2 (lat 62) = 14, row 3 (lat 63) = 16.
        let mut values = vec![0f32; (rows * cols) as usize];
        for r in 0..rows {
            for c in 0..cols {
                values[(r * cols + c) as usize] = 10.0 + 2.0 * r as f32;
            }
        }
        write_gtx(&path, south, west, lat_step, lon_step, rows, cols, &values, true);
        let grid = read_gtx(&path).unwrap();

        // Exactly halfway between row 1 (N=12) and row 2 (N=14): 13.0.
        let v = grid.undulation(61.5, 20.5).expect("inside coverage");
        assert!((v - 13.0).abs() < 1e-9, "expected exact midpoint 13.0, got {v}");

        // A quarter of the way must be exactly 12.5, not merely
        // "somewhere between" — pins the interpolation WEIGHT, not just
        // that some blending happened.
        let v2 = grid.undulation(61.25, 20.5).expect("inside coverage");
        assert!((v2 - 12.5).abs() < 1e-9, "expected exact 12.5, got {v2}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Same proof, along LONGITUDE instead of latitude.
    #[test]
    fn linear_ramp_in_longitude_hits_the_exact_analytic_midpoint() {
        let dir = fixture_dir("ramp-lon");
        let path = dir.join("ramp_lon.gtx");
        let (south, lat_step) = (60.0, 1.0);
        let (west, lon_step) = (20.0, 1.0);
        let (rows, cols) = (3, 4);
        // N = 5 + 3*col (constant across rows): col 1 (lon 21) = 8,
        // col 2 (lon 22) = 11.
        let mut values = vec![0f32; (rows * cols) as usize];
        for r in 0..rows {
            for c in 0..cols {
                values[(r * cols + c) as usize] = 5.0 + 3.0 * c as f32;
            }
        }
        write_gtx(&path, south, west, lat_step, lon_step, rows, cols, &values, true);
        let grid = read_gtx(&path).unwrap();

        let v = grid.undulation(61.0, 21.5).expect("inside coverage");
        assert!((v - 9.5).abs() < 1e-9, "expected exact midpoint 9.5, got {v}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A grid whose value depends on latitude must return the SOUTH
    /// row's value near the south edge. If rows were parsed north-first
    /// this test fails and NOTHING else in this suite would catch it —
    /// the numbers would still look like plausible undulations, just the
    /// wrong ones.
    #[test]
    fn south_row_is_read_first_not_reversed() {
        let dir = fixture_dir("roworder");
        let path = dir.join("roworder.gtx");
        let (south, lat_step) = (10.0, 1.0); // rows at lat 10 (south) and 11 (north)
        let (west, lon_step) = (100.0, 1.0);
        let (rows, cols) = (2, 2);
        let values: Vec<f32> = vec![100.0, 100.0, 300.0, 300.0]; // south row, then north row
        write_gtx(&path, south, west, lat_step, lon_step, rows, cols, &values, true);
        let grid = read_gtx(&path).unwrap();

        let v = grid.undulation(10.001, 100.5).unwrap();
        assert!(
            (v - 100.0).abs() < 1.0,
            "a point just off the south edge must read close to the south row's value (100), \
             not the north row's (300) — if rows were parsed north-first this would read close \
             to 300 instead: got {v}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A little-endian GTX file (real files exist in the wild despite
    /// the format nominally being big-endian only) must parse to the
    /// exact same grid as its big-endian twin.
    #[test]
    fn little_endian_file_produces_the_same_grid_as_its_big_endian_twin() {
        let dir = fixture_dir("endianness");
        let (south, west, lat_step, lon_step) = (55.0, 10.0, 1.0, 1.0);
        let (rows, cols) = (3, 3);
        let values: Vec<f32> = (0..9).map(|i| 10.0 + i as f32).collect();

        let be_path = dir.join("be.gtx");
        let le_path = dir.join("le.gtx");
        write_gtx(&be_path, south, west, lat_step, lon_step, rows, cols, &values, true);
        write_gtx(&le_path, south, west, lat_step, lon_step, rows, cols, &values, false);

        let be = read_gtx(&be_path).expect("big-endian file parses");
        let le = read_gtx(&le_path).expect("little-endian file parses via the fallback");

        assert_eq!(be.rows, le.rows);
        assert_eq!(be.cols, le.cols);
        assert_eq!(be.south, le.south);
        assert_eq!(be.west, le.west);
        for &(lat, lon) in &[(55.5, 10.5), (56.2, 11.8), (55.0, 10.0)] {
            let a = be.undulation(lat, lon).unwrap();
            let b = le.undulation(lat, lon).unwrap();
            assert!((a - b).abs() < 1e-9, "big/little-endian grids disagree at ({lat},{lon}): {a} vs {b}");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A point outside the grid's rectangle must be `None`, never the
    /// nearest edge value clamped into range.
    #[test]
    fn point_outside_coverage_returns_none_not_a_clamped_edge() {
        let dir = fixture_dir("outside");
        let path = dir.join("outside.gtx");
        let (south, west, lat_step, lon_step) = (59.0, 19.0, 1.0, 1.0);
        let (rows, cols) = (13, 14); // 59-71N, 19-32E
        let values = vec![20.0f32; (rows * cols) as usize];
        write_gtx(&path, south, west, lat_step, lon_step, rows, cols, &values, true);
        let grid = read_gtx(&path).unwrap();

        assert!(grid.undulation(48.0, 10.0).is_none(), "far outside the grid must be None");
        assert!(grid.undulation(71.5, 25.0).is_none(), "just past the north edge must be None, not clamped");
        assert!(grid.undulation(65.0, 18.5).is_none(), "just past the west edge must be None, not clamped");
        assert!(grid.undulation(65.0, 25.0).is_some(), "comfortably inside must still resolve");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A cell whose bracketing nodes include a nodata sentinel must
    /// refuse to interpolate, even though a nearby cell that does not
    /// touch the sentinel resolves normally.
    #[test]
    fn cell_touching_nodata_sentinel_returns_none() {
        let dir = fixture_dir("nodata");
        let path = dir.join("nodata.gtx");
        let (south, west, lat_step, lon_step) = (0.0, 0.0, 1.0, 1.0);
        let (rows, cols) = (4, 4);
        let mut values = vec![20.0f32; 16];
        values[0] = 9999.0; // south-west corner node (row 0, col 0) is a sentinel
        write_gtx(&path, south, west, lat_step, lon_step, rows, cols, &values, true);
        let grid = read_gtx(&path).unwrap();

        // The cell bracketing (0.3, 0.3) has nodes (0,0)-(0,1)-(1,0)-(1,1)
        // as its corners, which includes the sentinel at (0,0).
        assert!(grid.undulation(0.3, 0.3).is_none(), "a cell touching a nodata sentinel must return None");
        // A cell far from the sentinel (bottom-right corner of the grid)
        // must still resolve to the real, constant value.
        let v = grid.undulation(2.5, 2.5).expect("a cell that does not touch the sentinel should resolve");
        assert!((v - 20.0).abs() < 1e-6);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A header claiming more data than the file actually holds — a
    /// truncated download being the realistic cause — must be a clean
    /// `Err`, never a panic or a silently truncated read.
    #[test]
    fn header_overclaiming_the_data_size_is_a_clean_error() {
        let dir = fixture_dir("truncated");
        let path = dir.join("truncated.gtx");
        let mut header = Vec::new();
        header.extend_from_slice(&55.0f64.to_be_bytes());
        header.extend_from_slice(&10.0f64.to_be_bytes());
        header.extend_from_slice(&1.0f64.to_be_bytes());
        header.extend_from_slice(&1.0f64.to_be_bytes());
        header.extend_from_slice(&10i32.to_be_bytes()); // claims 10 rows
        header.extend_from_slice(&10i32.to_be_bytes()); // claims 10 cols (100 nodes, 400 bytes)
        header.extend_from_slice(&1.0f32.to_be_bytes()); // but only 1 value (4 bytes) follows
        std::fs::write(&path, &header).unwrap();

        let err = read_gtx(&path).expect_err("a header overclaiming its data must error, not panic");
        assert!(!err.is_empty());
    }

    /// A file too short to even hold a 40-byte header must also error
    /// cleanly rather than panic on the header slice.
    #[test]
    fn file_shorter_than_the_header_is_a_clean_error() {
        let dir = fixture_dir("tooshort");
        let path = dir.join("tooshort.gtx");
        std::fs::write(&path, [0u8; 10]).unwrap();
        assert!(read_gtx(&path).is_err());
    }

    /// Arbitrary non-GTX bytes (long enough to contain a header) must
    /// fail the plausibility checks in both endiannesses and error
    /// cleanly, not panic or return a nonsense grid.
    #[test]
    fn arbitrary_bytes_are_rejected_cleanly_in_both_endiannesses() {
        let dir = fixture_dir("garbage");
        let path = dir.join("garbage.gtx");
        std::fs::write(&path, [0xFFu8; 60]).unwrap();
        assert!(read_gtx(&path).is_err());
    }

    /// The whole point of `CACHE`: a grid is parsed once. Corrupting the
    /// file on disk after the first successful lookup and confirming the
    /// second lookup still succeeds (rather than failing, or panicking
    /// on a `File::open` in `read_gtx`) proves the second call actually
    /// hit the cache instead of re-reading — not just "didn't crash".
    #[test]
    fn grid_is_parsed_once_and_cached_by_resolved_path() {
        let _guard = serial();
        let dir = fixture_dir("cache");
        let path = dir.join("cache_test.gtx");
        let values = vec![15.0f32; 9];
        write_gtx(&path, 0.0, 0.0, 1.0, 1.0, 3, 3, &values, true);
        geodata::set_grid_dir(Some(dir.clone()));

        let v1 = undulation("cache_test.gtx", 1.0, 1.0).expect("first lookup should succeed");
        assert!((v1 - 15.0).abs() < 1e-6);

        std::fs::write(&path, b"corrupted after the first read").unwrap();
        let v2 = undulation("cache_test.gtx", 1.0, 1.0)
            .expect("second lookup should hit the cache, not re-read the now-broken file");
        assert!((v2 - 15.0).abs() < 1e-6, "cached value must be unaffected by the later corruption");

        geodata::set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The top-level `undulation` function's four distinct failure
    /// messages (no folder / folder but absent / present but unreadable
    /// / outside coverage) must not be confusable with each other — each
    /// implies a different fix, so conflating any two would send the
    /// user to do the wrong thing. Mirrors
    /// `nadgrid`'s `missing_grid_hint_distinguishes_unreadable_from_absent`.
    #[test]
    fn undulation_error_messages_distinguish_all_failure_causes() {
        let _guard = serial();

        // 1. No folder configured at all.
        geodata::set_grid_dir(None);
        let e1 = undulation("does_not_exist_anywhere.gtx", 60.0, 25.0).expect_err("should fail");
        assert!(e1.contains("no geodetic data folder is configured"), "{e1}");

        let dir = fixture_dir("errors");
        geodata::set_grid_dir(Some(dir.clone()));

        // 2. Folder configured, but this name genuinely is not there.
        let e2 = undulation("still_not_there.gtx", 60.0, 25.0).expect_err("should fail");
        assert!(e2.contains("not in any folder"), "{e2}");
        assert!(
            !e2.contains("no geodetic data folder"),
            "a configured-but-absent file must not read like an unconfigured folder: {e2}"
        );

        // 3. Present, but not a valid GTX file.
        std::fs::write(dir.join("broken.gtx"), b"not a gtx file, far too short for a header").unwrap();
        let e3 = undulation("broken.gtx", 60.0, 25.0).expect_err("should fail");
        assert!(e3.contains("could not be read"), "{e3}");
        assert!(!e3.contains("not in any folder"), "a present-but-broken file must not read as absent: {e3}");

        // 4. Present and valid, but this point is outside its coverage.
        let values = vec![20.0f32; 25];
        write_gtx(&dir.join("valid.gtx"), 59.0, 19.0, 1.0, 1.0, 5, 5, &values, true);
        let e4 = undulation("valid.gtx", -10.0, 100.0).expect_err("should fail");
        assert!(e4.contains("coverage"), "{e4}");
        assert!(
            !e4.contains("not in any folder") && !e4.contains("could not be read"),
            "an out-of-coverage point must not read as a missing or unparseable file: {e4}"
        );

        geodata::set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `status()` must list every `.gtx` file, report a broken one as a
    /// genuine failure (with an error), and — the distinction the brief
    /// calls out explicitly — must NOT report a merely-oversized file as
    /// failed: `checked: false` there means "not attempted", not "tried
    /// and failed".
    #[test]
    fn status_lists_files_flags_broken_and_spares_merely_large_ones() {
        let _guard = serial();
        let dir = fixture_dir("status");

        let (rows, cols) = (13, 14); // 59-71N, 19-32E — same footprint as nadgrid's own fixture
        let values = vec![20.0f32; (rows * cols) as usize];
        write_gtx(&dir.join("good.gtx"), 59.0, 19.0, 1.0, 1.0, rows, cols, &values, true);

        std::fs::write(dir.join("broken.gtx"), b"not a gtx file at all, much too short").unwrap();

        // A file too large to verify eagerly. `set_len` on a freshly
        // created file makes it sparse — this does not actually write
        // 64+ MB to disk, only its reported metadata length grows.
        let big_path = dir.join("big.gtx");
        let big_file = std::fs::File::create(&big_path).unwrap();
        big_file.set_len(MAX_VERIFY_BYTES + 1).unwrap();
        drop(big_file);

        std::fs::write(dir.join("ignored.txt"), b"not a grid").unwrap();
        geodata::set_grid_dir(Some(dir.clone()));

        let st = status();
        assert!(st.dir_exists);
        // Filter to OUR folder: PROJ_DATA may be set in the environment
        // this test runs in and contribute unrelated real grids.
        let ours: Vec<&GeoidGridFile> = st.files.iter().filter(|f| f.dir == dir.display().to_string()).collect();
        assert_eq!(
            ours.len(),
            3,
            "only .gtx files are listed, got {:?}",
            ours.iter().map(|f| &f.file).collect::<Vec<_>>()
        );

        let good = ours.iter().find(|f| f.file == "good.gtx").unwrap();
        assert!(good.checked && good.ok, "a valid grid should parse: {:?}", good.error);
        assert_eq!(good.rows, Some(13));
        assert_eq!(good.cols, Some(14));
        assert_eq!(good.south, Some(59.0));
        assert_eq!(good.west, Some(19.0));
        assert_eq!(good.north, Some(71.0));
        assert_eq!(good.east, Some(32.0));

        let broken = ours.iter().find(|f| f.file == "broken.gtx").unwrap();
        assert!(broken.checked, "a small broken file must actually be attempted");
        assert!(!broken.ok, "a broken file must be reported as failed, not skipped");
        assert!(broken.error.is_some());

        let big = ours.iter().find(|f| f.file == "big.gtx").unwrap();
        assert!(!big.checked, "an oversized file must be skipped, not eagerly parsed");
        assert!(!big.ok, "ok is meaningless when unchecked");
        assert!(big.error.is_none(), "a file skipped only for its size is NOT a failure and must carry no error");

        geodata::set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
