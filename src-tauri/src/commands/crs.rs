// Coordinate Reference System support (part 1 of 2 — recording what CRS
// a dataset is in, and converting coordinates between CRSs on request.
// Reprojecting a whole export onto a chosen CRS is a later stage that
// builds on this; not implemented here).
//
// PointCloudLabeler has no idea, by default, what grid a dataset's XYZ values are
// in — ETRS-TM35FIN, SWEREF 99 TM, a UTM zone, whatever the source file
// happened to use. This module gives it a name for that grid (a curated
// EPSG table, `crs_list`) and a way to convert between grids
// (`crs_transform`), both backed by proj4rs. Recording *which* CRS a
// dataset is in is a metadata-only operation (`octree_set_crs` in
// octree.rs, right next to `update_metadata_intensity_range` which it
// mirrors) — it never touches point data. Converting coordinates is
// what `crs_transform` is for, and only ever runs when a caller
// explicitly asks for it. `cloud_export_octree_las`'s optional
// `target_crs` (commands/octree.rs) is the one caller that reprojects
// a whole export, built on `CrsTransformer` below.
//
// — proj4 strings —
// Every table entry's `proj` field is a proj4 definition string, the
// same syntax proj4/PROJ's classic API and QGIS's "custom CRS" dialog
// accept. Values are transcribed from the EPSG registry / proj4-
// published definitions for each CRS; source noted per entry below
// where the parameters aren't self-evident (the Swiss ones especially).
// `crs_transform` also accepts a raw proj4 string directly in `from` /
// `to` (i.e. not just "epsg:XXXX") — the escape hatch for a CRS this
// table doesn't carry; see its own doc comment.
//
// — the radian/degree boundary —
// proj4rs works in RADIANS for every geographic (longlat) CRS, both
// what it reads and what it writes; a projected CRS uses its native
// linear unit (metres here, via each string's `+units=m`). It does not
// validate this — handed degrees where it wants radians, it silently
// treats e.g. longitude 24.9 as 24.9 RADIANS (about 1427 degrees,
// wrapped by the trig functions into some other angle entirely) and
// hands back a number that still *looks* like a plausible coordinate.
// There is no exception to catch; the output is just wrong. This is,
// empirically, the single easiest way to produce silently wrong output
// in this whole module — see `crs_transform`'s doc comment for exactly
// where the conversion happens and how it decides which side needs it.
//
// — a second, less obvious trap: proj4rs's datum "skip" heuristic —
// proj4rs skips the WGS84-hub datum shift entirely whenever EITHER side
// of a transform has no `towgs84` / `datum` parameter at all ("NoDatum"
// — see proj4rs::datum_transform::datum_transform). That is the right
// call when a CRS genuinely has no defined relationship to WGS84, but
// it is the WRONG call for a modern GRS80 CRS (ETRS89, TM35FIN,
// SWEREF 99 TM, RGF93/Lambert-93, ETRS89 UTM) whose shift to WGS84 is
// conventionally zero: omitting towgs84 there doesn't just skip a no-op
// shift on THIS side, it also skips the OTHER side's real shift when
// that side needs one. Concretely, with ETRS89 written as the bare
// "+proj=longlat +ellps=GRS80 +no_defs", transforming FROM Swiss LV03
// (a real ~674 m shift) TO that "ETRS89" silently returns the raw,
// un-shifted Bessel-ellipsoid coordinates — wrong by exactly the shift,
// with no error raised anywhere. Verified empirically while building
// this table (also covered by this module's tests): giving every
// zero-shift entry an EXPLICIT "+towgs84=0,0,0,0,0,0,0" avoids the
// short-circuit and forces the real (if degenerate) Helmert path, so a
// genuinely-shifted CRS on the other end is still correctly shifted.
// Every entry below that would otherwise carry no towgs84 at all has
// this explicit identity shift for exactly that reason — it is not
// decorative.
//
// — and a third: "+k_0=" is not "+k=" here —
// proj4rs reads the scale-factor-at-origin parameter from "+k0=" or
// "+k=" only (see proj4rs::proj::Proj::init) — NOT "+k_0=", which some
// other proj4 distributions accept as an alias for the same thing. A
// string carrying "+k_0=0.9996012717" parses without any error and
// silently falls back to the default 1.0 instead. Every entry below
// that needs a non-1.0 scale factor (OSGB36, RD New) is written with
// "+k=", not "+k_0=", for exactly this reason — verified empirically
// against proj4rs 0.1.10 (an obviously-wrong +k_0=0.5 produced no
// numeric change at all, while +k=0.5 / +k0=0.5 both did).
//
// — the full EPSG table (epsg.tsv) —
// `curated_table` below is a hand-picked shortlist — the CRSs a PointCloudLabeler
// user is actually likely to have data in — and it stays the picker's
// default list (`crs_list`, unchanged by any of this). It is NOT the
// only thing "epsg:XXXX" resolves against, though: `resolve_proj` falls
// back to the FULL EPSG registry, embedded verbatim from epsg.tsv
// (`include_str!`, parsed once into a HashMap on first use — see
// `epsg_table` below) so any of the ~8000 real EPSG codes works, not
// just the ~190 in `curated_table`. `crs_lookup` / `crs_search` expose
// that full table directly, for a picker's "or type a code / name"
// escape hatch.
//
// The curated table is checked FIRST and wins on overlap — see
// `proj_string_for_epsg`'s doc comment for concrete, verified examples
// of why that matters (EPSG:4258 losing its towgs84 identity shift,
// EPSG:28992's rotation-sign convention, EPSG:27700's grid file this
// crate can't load): several curated entries fix a real correctness bug
// the raw registry value for that SAME code has, so silently preferring
// the full table for a code curated_table already carries would
// reintroduce exactly the bugs this module's tests guard against.
//
// epsg.tsv is derived from the "epsg-index" dataset (ISC-licensed
// packaging of the IOGP — International Association of Oil & Gas
// Producers — EPSG Geodetic Parameter Registry) — the same registry
// `curated_table`'s own entries are transcribed from by hand. Every
// "+k_0=" in the source data has already been rewritten to "+k="
// (see trap #3 above — proj4rs silently ignores "+k_0=" and falls
// back to a scale factor of 1.0 with NO error, which measured as an
// 8.1 km / 346 m mislocation for one real affected CRS; 285 entries
// were affected). If epsg.tsv is ever regenerated from a newer
// epsg-index release, THAT REWRITE MUST BE RE-APPLIED FIRST —
// `embedded_epsg_table_has_no_k_0_param` in this module's tests exists
// specifically so a regeneration that skips it fails `cargo test`
// instead of silently shipping that error again.
//
// Attribution: PointCloudLabeler does not redistribute the EPSG Geodetic Parameter
// Registry itself, and is not endorsed by or affiliated with IOGP or
// the epsg-index maintainers. "EPSG" is a trademark of IOGP.

use proj4rs::proj::Proj;
use proj4rs::transform::transform;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::OnceLock;

/// One entry in the curated CRS table: an EPSG code, a short label for
/// the UI picker, and the proj4 string proj4rs consumes directly.
/// `crs_list` returns this table verbatim so the front end never
/// hardcodes a second copy of it (see LayersPanel.tsx's CRS row).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrsEntry {
    pub epsg: u32,
    pub label: String,
    pub proj: String,
}

fn entry(epsg: u32, label: &str, proj: impl Into<String>) -> CrsEntry {
    CrsEntry { epsg, label: label.to_string(), proj: proj.into() }
}

/// Build a "+proj=utm +zone=N [+south] ..." definition for a WGS84 UTM
/// zone. proj4rs's own `utm` projection derives the central meridian,
/// k0=0.9996 and the false easting/northing straight from `zone` (+
/// `south` for the false-northing branch) — see
/// proj4rs::projections::etmerc::Projection::utm. Writing the central
/// meridian out by hand here would just be a second place for a
/// "6*zone-183" slip to hide.
fn wgs84_utm_proj(zone: u32, south: bool) -> String {
    let south_flag = if south { " +south" } else { "" };
    format!("+proj=utm +zone={zone}{south_flag} +ellps=WGS84 +datum=WGS84 +units=m +no_defs")
}

/// Same, but ETRS89 (GRS80 ellipsoid, northern hemisphere only — ETRS89
/// is only ever used in Europe, which never crosses the equator). The
/// explicit "+towgs84=0,0,0,0,0,0,0" is required, not redundant with
/// omitting it — see the module doc comment's note on proj4rs's
/// datum-skip heuristic.
fn etrs89_utm_proj(zone: u32) -> String {
    format!("+proj=utm +zone={zone} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs")
}

/// The curated table: common CRSs a PointCloudLabeler user is likely to have data
/// in, plus every WGS84 UTM zone in both hemispheres (generated, not
/// listed — 120 near-identical hand-typed entries is 120 chances to
/// transpose a digit).
pub fn curated_table() -> Vec<CrsEntry> {
    let mut out = vec![
        entry(4326, "WGS84 (geographic)", "+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs"),
        // No EPSG-registered shift exists for ETRS89 → WGS84 (they're
        // conventionally treated as coincident at the sub-metre level);
        // the explicit zero towgs84 is still required so a genuinely-
        // shifted source CRS transformed INTO this one still gets its
        // real shift applied — see the module doc comment.
        entry(4258, "ETRS89 (geographic)", "+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs"),

        // Finland — one fixed "zone" (central meridian 27E) covering the
        // whole country instead of splitting it across ordinary UTM zones
        // 34N-36N. Numerically this IS UTM zone 35 on GRS80 (zone 35's own
        // central meridian is -183+6*35 = 27) — EPSG's own published
        // proj4 string for 3067 literally writes it as "+proj=utm +zone=35".
        entry(3067, "ETRS-TM35FIN (Finland)", "+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"),

        // Sweden — same idea: SWEREF 99 TM's central meridian (15E) is
        // UTM zone 33's, so this is "UTM zone 33 on GRS80" too.
        entry(3006, "SWEREF 99 TM (Sweden)", "+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"),

        // Switzerland — Swiss oblique Mercator ("somerc") on Bessel 1841,
        // centred on the old Bern observatory: lat_0/lon_0 below are
        // 46 57'08.66"N / 7 26'22.50"E in decimal degrees, the EPSG-
        // registered natural origin for both 2056 and 21781 (they share
        // the same origin; LV95 just adds 2,000,000 mE / 1,000,000 mN to
        // LV03's false origin so Swiss coordinates read unambiguously
        // beside the rest of Europe's 6-7 digit eastings).
        //
        // towgs84 = 674.374,15.056,405.346 (rx=ry=rz=0, scale=0) is the
        // EPSG-registered CH1903→WGS84 transformation (EPSG:1676,
        // "CH1903 to WGS 84 (2)", geocentric translation, ~1-2 m
        // accuracy) — the same figures epsg.io / spatialreference.org
        // publish for both CRSs, and what Swiss survey software falls
        // back to when the higher-accuracy FINELTRA/CHENyx06 correction
        // grid isn't available (that grid-based method is out of scope
        // for a single proj4 string). Cross-checked against the published
        // Bern-observatory-origin figure: LV03's false origin (600000,
        // 200000) inverse-projects + datum-shifts to ~46.9511N, 7.4386E
        // — see this module's tests, which assert exactly that.
        entry(2056, "CH1903+ / LV95 (Switzerland)", "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs"),
        entry(21781, "CH1903 / LV03 (Switzerland)", "+proj=somerc +lat_0=46.95240555555556 +lon_0=7.439583333333333 +k=1 +x_0=600000 +y_0=200000 +ellps=bessel +towgs84=674.374,15.056,405.346,0,0,0,0 +units=m +no_defs"),

        // Netherlands — oblique stereographic ("sterea") on Bessel 1841,
        // centred on the Amersfoort triangulation pillar (52 09'22.178"N
        // 5 23'15.500"E). towgs84 is the RDNAPTRANS "simple" 7-parameter
        // Helmert (Kadaster / epsg.io published value, Bessel 1841 →
        // ETRS89); full RDNAPTRANS adds a correction grid for cm accuracy,
        // out of scope for a curated proj4 string.
        entry(28992, "RD New (Netherlands)", "+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=565.4171,50.3319,465.5524,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs"),

        // France — Lambert Conformal Conic, 2 standard parallels
        // (44N / 49N), false origin 46.5N / 3E, RGF93 (GRS80) datum. Zero
        // towgs84 for the same "make the identity real, not implied"
        // reason as ETRS89/TM35FIN/SWEREF above — RGF93 is ETRS89's
        // French realisation.
        entry(2154, "Lambert-93 (France)", "+proj=lcc +lat_1=49 +lat_2=44 +lat_0=46.5 +lon_0=3 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs"),

        // Great Britain — Transverse Mercator on Airy 1830 with a
        // non-zero latitude of origin (49N — unlike UTM/TM35FIN/SWEREF's
        // equatorial origin). towgs84 is the classic OSGB36→WGS84
        // 7-parameter Helmert (Ordnance Survey / EPSG-published; OSTN15
        // gives cm accuracy but needs a grid file this crate doesn't
        // carry). Scale factor is written "+k=", not "+k_0=" — see the
        // module doc comment's note on that parameter name.
        entry(27700, "OSGB36 / British National Grid", "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.060,0.1502,0.2470,0.8421,-20.4894 +units=m +no_defs"),
    ];

    // ETRS89 / UTM zones 32N-36N — Nordics / central Europe. Generated
    // for the same reason as the WGS84 zones below: regular, so a loop
    // is both less code and less error-prone than five hand-typed lines.
    for zone in 32..=36u32 {
        out.push(entry(25800 + zone, &format!("ETRS89 / UTM zone {zone}N"), etrs89_utm_proj(zone)));
    }

    // WGS84 / UTM zones 1-60, both hemispheres — EPSG:326zz (north) /
    // EPSG:327zz (south).
    for zone in 1..=60u32 {
        out.push(entry(32600 + zone, &format!("WGS84 / UTM zone {zone}N"), wgs84_utm_proj(zone, false)));
    }
    for zone in 1..=60u32 {
        out.push(entry(32700 + zone, &format!("WGS84 / UTM zone {zone}S"), wgs84_utm_proj(zone, true)));
    }

    out
}

/// Raw embedded EPSG registry — every code in epsg.tsv (8017 entries at
/// last count), one `code<TAB>name<TAB>proj4` line each. See the module
/// doc comment ("the full EPSG table") for provenance/licensing and why
/// `curated_table` still takes priority over this for any code it also
/// carries.
const EPSG_TSV: &str = include_str!("epsg.tsv");

/// `EPSG_TSV`, parsed once into code -> (name, proj4) on first use.
/// Parsing ~8000 short lines costs low-single-digit milliseconds
/// (measured: 8017 codes from 1.1 MB in 1.8 ms release, 7.3 ms debug —
/// see `epsg_parse_timing`) —
/// cheap enough that doing it eagerly at startup would be unnoticeable,
/// but there's equally no reason to pay it in a session that never
/// looks up a full-table code (an explicit, occasional user action:
/// typing an EPSG code the shortlist doesn't have, or searching a
/// name) — hence `OnceLock` rather than a plain static built at load
/// time.
static EPSG_TABLE: OnceLock<HashMap<u32, (String, String)>> = OnceLock::new();

fn epsg_table() -> &'static HashMap<u32, (String, String)> {
    EPSG_TABLE.get_or_init(|| {
        let mut map = HashMap::with_capacity(8200);
        for line in EPSG_TSV.lines() {
            let mut parts = line.splitn(3, '\t');
            let (Some(code_s), Some(name), Some(proj)) = (parts.next(), parts.next(), parts.next()) else {
                continue; // malformed line in the data file — skip, don't panic
            };
            let Ok(code) = code_s.parse::<u32>() else { continue };
            map.insert(code, (name.to_string(), proj.to_string()));
        }
        map
    })
}

/// Look up a proj4 definition string by EPSG code — first against the
/// curated table, THEN falling back to the full embedded EPSG registry
/// (`epsg_table`) so any of the ~8000 real EPSG codes resolves, not
/// just the ~190-entry curated shortlist. `None` when the code is in
/// neither — the caller (`resolve_proj`) turns that into the "unknown
/// EPSG code" error a raw proj4 string can never produce.
///
/// The curated table MUST be checked first: several of its entries fix
/// a real correctness bug the raw registry value for that same code
/// has, verified directly against epsg.tsv's own lines while building
/// this table —
///   - EPSG:4258 (ETRS89 geographic): epsg.tsv has no `towgs84` at all.
///     Per this module's "datum skip" trap, that silently drops the
///     real shift on the OTHER side of any transform INTO 4258 from a
///     CRS that isn't already zero-shift — curated_table's entry adds
///     the explicit "+towgs84=0,0,0,0,0,0,0" that avoids it.
///   - EPSG:28992 (RD New): epsg.tsv's towgs84 rotation terms
///     (1.9342,-1.6677,9.1019) have the OPPOSITE sign from the
///     published Kadaster/epsg.io value curated_table uses
///     (-0.398957,0.343988,-1.8774) — the two common Helmert sign
///     conventions ("position vector" vs "coordinate frame"). Using the
///     wrong one silently shifts the result by metres.
///   - EPSG:27700 (OSGB36 British National Grid): epsg.tsv names a grid
///     file, "+nadgrids=OSTN15_NTv2_OSGBtoETRS.gsb". PointCloudLabeler does not
///     ship that grid, so curated_table's entry uses the classic
///     7-parameter Helmert instead, which needs no external file —
///     metre-level rather than centimetre-level, but it works out of
///     the box. See the ONE EXCEPTION below for what happens when the
///     user does supply the grid.
/// Silently preferring the full table for a code curated_table already
/// carries would reintroduce exactly these bugs; this module's tests
/// pin the curated-first behaviour directly (see
/// `crs_lookup_prefers_curated_proj4_over_registry_when_they_differ`).
///
/// ONE EXCEPTION — a supplied datum-shift grid wins. If the registry's
/// definition for this code is grid-based (`+nadgrids=`) and every grid
/// it names is present in the user's configured geodetic data folder
/// (see commands/nadgrid.rs), the registry definition is used instead.
/// That is deliberate and matches PROJ / QGIS: the grid is the
/// authoritative, centimetre-accurate transformation, and the curated
/// Helmert only ever existed as the fallback for not having it. A user
/// who has gone to the trouble of installing OSTN15 wants OSTN15, not a
/// 7-parameter approximation of it. The fallback is automatic and
/// silent in the safe direction only: no folder, or the named file
/// absent, means the curated Helmert as before — never a hard failure.
/// The reverse (preferring the Helmert when the grid is right there)
/// would be the metre-level answer wearing a centimetre-level
/// coordinate that this whole module exists to avoid.
fn proj_string_for_epsg(code: u32) -> Option<String> {
    let curated = curated_table().into_iter().find(|e| e.epsg == code).map(|e| e.proj);
    let registry = epsg_table().get(&code).map(|(_, proj)| proj.clone());
    if let Some(reg) = registry.as_ref() {
        let needed = super::nadgrid::required_grids(reg);
        if !needed.is_empty() && super::nadgrid::grids_available(&needed) {
            return registry;
        }
    }
    curated.or(registry)
}

/// Pull the EPSG code out of an OGC WKT coordinate-system string.
///
/// Not a WKT parser, and deliberately not: parsing WKT properly means
/// implementing two incompatible grammars (WKT1 and WKT2) and then
/// deriving a code from projection parameters, which is a project. But
/// essentially every WKT a real file carries states its own code
/// outright — `AUTHORITY["EPSG","3067"]` in WKT1, `ID["EPSG",3067]` in
/// WKT2 — and that is the whole answer.
///
/// Takes the LAST such clause. WKT nests: the datum, the spheroid, the
/// prime meridian and the units each carry their own AUTHORITY, and the
/// CRS's own is conventionally written last, at the outermost level. The
/// first match would reliably return the datum's code — a real EPSG
/// number, for the wrong kind of object.
///
/// The code is then required to resolve in the embedded registry. A
/// number scraped out of a string is a guess until something confirms it
/// names a CRS this app can actually use; recording an unresolvable one
/// would put a coordinate system on a dataset that no later transform
/// could honour.
pub fn epsg_from_wkt(wkt: &str) -> Option<u32> {
    let mut found: Option<u32> = None;
    let bytes = wkt.as_bytes();
    for (kw, wkt2) in [("AUTHORITY", false), ("ID", true)] {
        let mut from = 0usize;
        while let Some(rel) = wkt[from..].find(kw) {
            let at = from + rel;
            from = at + kw.len();
            // Must be a keyword, not a substring of a longer word
            // (WKT2's ID would otherwise match inside "GEOGCRSID").
            if at > 0 && (bytes[at - 1].is_ascii_alphanumeric() || bytes[at - 1] == b'_') {
                continue;
            }
            let Some(open) = wkt[at..].find('[') else { continue };
            let Some(close) = wkt[at + open..].find(']') else { continue };
            let inner = &wkt[at + open + 1..at + open + close];
            let mut parts = inner.split(',');
            let auth = parts.next()?.trim().trim_matches('"');
            if !auth.eq_ignore_ascii_case("EPSG") {
                continue;
            }
            let raw = parts.next().unwrap_or("").trim().trim_matches('"');
            let _ = wkt2;
            if let Ok(code) = raw.parse::<u32>() {
                found = Some(code);
            }
        }
    }
    found.filter(|&c| proj_string_for_epsg(c).is_some())
}

/// EPSG unit-of-measure code for a projected CRS's linear unit, for the
/// GeoTIFF `ProjLinearUnitsGeoKey` an export writes.
///
/// The exporter used to hardcode 9001 (metre). That is right for every
/// entry in the curated shortlist, but the picker's registry search
/// reaches all ~8000 codes, and 1354 of them are foot-based (1173
/// US survey feet, 174 international feet, plus chains and links). A
/// file declaring EPSG:2263 — New York Long Island in US survey feet —
/// while also declaring metres is internally inconsistent: most readers
/// resolve the unit from the EPSG code and ignore the redundant key, but
/// "most" is not "all", and shipping a self-contradicting header is not
/// something to do on purpose.
///
/// Falls back to metre when the unit is absent or unrecognised, which
/// matches proj4's own default for a projected CRS.
pub fn linear_units_code(code: u32) -> u16 {
    const METRE: u16 = 9001;
    let Some(proj) = proj_string_for_epsg(code) else { return METRE };
    let Some(rest) = proj.split("+units=").nth(1) else { return METRE };
    match rest.split_whitespace().next().unwrap_or("m") {
        "m" => METRE,
        "us-ft" => 9003,  // US survey foot
        "ft" => 9002,     // international foot
        "ch" => 9033,     // chain (Clarke's)
        "link" => 9034,   // link
        "ind-yd" => 9085, // Indian yard
        _ => METRE,
    }
}

/// What one unit of this projected CRS is worth in METRES.
///
/// PointCloudLabeler's measurements are metric all the way down and not by
/// convention: "breast height" is the literal constant 1.3, the minimum
/// tree height is 2.0, the crown window grows in metres per metre of
/// tree, basic wood density is kg/m³ and every per-hectare figure
/// divides by an area in m². None of that is a label — it is arithmetic
/// on the dataset's own numbers.
///
/// So a cloud whose coordinates are NOT metres is not "the same answer
/// in another unit", it is a different and wrong answer: DBH gets
/// measured 1.3 FEET up the trunk, in the root flare, and the plot's
/// area comes out 10.76× too small, so stems/ha is 10.76× too large.
/// The numbers all still look like plausible forestry.
///
/// This is not a rare corner. The bundled registry has 8017 codes, of
/// which 1173 are US survey feet and 174 international feet — the
/// State Plane zones that most county and state LiDAR in the United
/// States is delivered in. PointCloudLabeler read a file's declared CRS and never
/// once asked what its unit was.
///
/// The factor is taken from the resolved `Proj`, i.e. from the same
/// `to_meter` proj4rs itself applies when transforming, so this can't
/// drift from a hand-copied table of foot definitions (the US survey
/// foot is 1200/3937 m, the international foot 0.3048 m exactly, and
/// the difference between them is 2 ppm — 3 mm over a 1500 m plot).
///
/// `None` for a geographic CRS (its units are degrees, which is not a
/// linear unit at all — see `is_geographic`) and for a code that does
/// not resolve.
pub fn linear_unit_to_metre(code: u32) -> Option<f64> {
    let proj_str = proj_string_for_epsg(code)?;
    let proj = Proj::from_proj_string(&proj_str).ok()?;
    if proj.is_latlong() {
        return None;
    }
    let k = proj.to_meter();
    if k.is_finite() && k > 0.0 { Some(k) } else { None }
}

/// The SAME projection as `code`, expressed in metres — the CRS an
/// importer converts a foot-based cloud into.
///
/// This is a textual substitution and it is exact, not an approximation.
/// A proj4 definition states its false easting/northing in METRES
/// regardless of `+units` (proj4rs applies `x * to_meter - x_0` on the
/// way in — transform.rs), so swapping the unit token changes nothing
/// but the unit. The registry proves it directly: EPSG:2263 (NAD83 /
/// New York Long Island, ftUS) and EPSG:32118 (the same CRS in metres)
/// are byte-identical apart from `+units=us-ft` vs `+units=m`, false
/// easting 300000 and all.
///
/// A proj STRING rather than the metric twin's EPSG code, deliberately.
/// Looking the twin up in the registry seems tidier and is a trap: of
/// the 1367 non-metre codes only 118 have an unambiguous metric twin
/// there. Most State Plane foot zones have none at all, because the
/// foot definition's false easting is the round number in FEET
/// (California zone 5's 6561666.667 ftUS = 2000000.0001016 m) and the
/// metric zone's is the round number in metres — genuinely different
/// CRSs, 0.1 mm apart. Worse, matching by parameters alone finds
/// confident WRONG answers: NAD83 / New York East and NAD83 / New
/// Jersey share every projection parameter, so a parameter-keyed lookup
/// hands back New Jersey for a New York file. The substituted string is
/// always right and never needs a table.
///
/// `None` for a geographic CRS (nothing to convert to — see
/// `linear_unit_to_metre`) and for a code that does not resolve, or
/// whose substituted form proj4rs then refuses.
pub fn metric_proj_for_epsg(code: u32) -> Option<String> {
    let proj_str = proj_string_for_epsg(code)?;
    if Proj::from_proj_string(&proj_str).ok()?.is_latlong() {
        return None;
    }
    // Drop every unit-bearing token (proj4 spells the same thing two
    // ways — "+units=us-ft" and "+to_meter=0.3048006096012192") and put
    // a single "+units=m" where the first one stood.
    let mut out: Vec<&str> = Vec::new();
    let mut replaced = false;
    for tok in proj_str.split_whitespace() {
        if tok.starts_with("+units=") || tok.starts_with("+to_meter=") {
            if !replaced {
                out.push("+units=m");
                replaced = true;
            }
        } else {
            out.push(tok);
        }
    }
    // No unit token at all means proj4's default, which for a projected
    // CRS already IS metres — say so explicitly rather than leave the
    // converted dataset's definition relying on a default.
    if !replaced {
        out.push("+units=m");
    }
    let metric = out.join(" ");
    // It must still parse, and it must actually be metres now.
    let check = Proj::from_proj_string(&metric).ok()?;
    if (check.to_meter() - 1.0).abs() > 1e-12 {
        return None;
    }
    Some(metric)
}

/// Is this EPSG code a GEOGRAPHIC (longitude/latitude) CRS?
///
/// Answered from the CRS's own proj4 definition — `+proj=longlat` is
/// exactly what makes a CRS geographic, and it is the same test
/// `resolve_proj` and the radian/degree boundary above already rely on.
///
/// The GeoTIFF writer used to guess this from the numeric range
/// 4000..5000. Measured against the bundled registry, that band is
/// wrong for 979 of its 8017 codes: 688 geographic CRSs sit OUTSIDE it
/// (HD1909, TWD97, PTRA08, and every modern realisation such as
/// NAD83(2011) 6318 or GDA2020 7844) and 291 projected ones sit INSIDE
/// it (MOLDREF99 / Moldova TM 4026, WGS 84 / TMzn35N 4037, …). A raster
/// written with the wrong model type is read by a GIS with degrees
/// taken for metres, or metres for degrees — it lands nowhere near the
/// data it describes, and nothing in the file says so.
///
/// An unknown code is reported as not geographic, matching proj4's own
/// default of a projected CRS in metres.
pub fn is_geographic(code: u32) -> bool {
    proj_string_for_epsg(code)
        .map(|p| p.contains("+proj=longlat"))
        .unwrap_or(false)
}

/// Resolve a CRS spec into a proj4rs `Proj`. Accepts either "epsg:XXXX"
/// (case-insensitive, looked up in the curated table then the full
/// EPSG registry — see `proj_string_for_epsg`) or a raw proj4
/// definition string — the escape hatch for a CRS neither table
/// carries. Errors say which of the two failure modes happened: an
/// EPSG code in neither table, or a proj4 string proj4rs itself
/// couldn't parse.
fn resolve_proj(spec: &str) -> Result<Proj, String> {
    // proj4rs resolves `+nadgrids=` while PARSING the proj string, and
    // its grid catalog is thread-local (see commands/nadgrid.rs), so the
    // loader has to be registered on this thread before the parse, not
    // before the transform. Cheap after the first call per thread.
    super::nadgrid::ensure_registered();
    let trimmed = spec.trim();
    let lower = trimmed.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("epsg:") {
        let code: u32 = rest
            .trim()
            .parse()
            .map_err(|_| format!("invalid EPSG code '{trimmed}'"))?;
        let proj_str = proj_string_for_epsg(code)
            .ok_or_else(|| format!("unknown EPSG code: {code}"))?;
        return Proj::from_proj_string(&proj_str)
            .map_err(|e| explain_proj_error(&format!("EPSG:{code}"), &proj_str, e));
    }
    Proj::from_proj_string(trimmed)
        .map_err(|e| explain_proj_error(&format!("proj4 string '{trimmed}'"), trimmed, e))
}

/// Turn a proj4rs failure into something a forester can act on.
///
/// The important case is a definition that needs an NTv2 datum-shift grid
/// (`+nadgrids=…`): 309 of the registry's entries do — the NAD27 zones,
/// OSGB36 and friends — and proj4rs refuses them rather than quietly
/// dropping the shift, which is the safe behaviour but surfaces as the
/// bare word "NadGridNotAvailable". PointCloudLabeler can use those grids (see
/// commands/nadgrid.rs) but does not ship them, so the message has to
/// say which file is missing and where PointCloudLabeler looked for it — that is
/// `nadgrid::missing_grid_hint`'s job, and it phrases the two distinct
/// situations (no folder configured vs. folder configured but the file
/// absent) differently because they have different fixes.
fn explain_proj_error(what: &str, proj_str: &str, e: impl std::fmt::Debug) -> String {
    let grids = super::nadgrid::required_grids(proj_str);
    if !grids.is_empty() {
        return format!("{what} {}", super::nadgrid::missing_grid_hint(&grids));
    }
    format!("{what}: {e:?}")
}

/// Return the curated CRS table (see `curated_table` above) so the
/// front end's CRS picker (LayersPanel.tsx) never hardcodes a second
/// copy of the list. Building it is pure in-memory string formatting —
/// nothing here can fail.
#[tauri::command]
pub fn crs_list() -> Vec<CrsEntry> {
    curated_table()
}

/// One result from `crs_lookup` / `crs_search` — the full-registry
/// lookup shape, distinct from `CrsEntry` (`curated_table`'s own
/// (epsg, label, proj) triple, which stays the shortlist's shape).
/// `proj4` is whatever `proj_string_for_epsg` would hand `resolve_proj`
/// for this code — curated-first — so a caller is never shown a proj4
/// string that isn't actually what transforming against "epsg:{code}"
/// will use.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpsgLookupEntry {
    pub code: u32,
    pub name: String,
    pub proj4: String,
}

/// Display name for an EPSG code, as `crs_lookup` / `crs_search` show
/// it: the curated table's friendlier label when the code is curated
/// (e.g. "CH1903+ / LV95 (Switzerland)", which names the country —
/// see `crs_search`'s doc comment for why that matters), else the full
/// registry's own name verbatim.
pub fn display_name_for_epsg(code: u32) -> Option<String> {
    curated_table().into_iter().find(|e| e.epsg == code).map(|e| e.label)
        .or_else(|| epsg_table().get(&code).map(|(name, _)| name.clone()))
}

/// Look up a single EPSG code against the FULL registry (curated
/// shortlist included) — the picker's "type a code" path, extending
/// `crs_list`'s ~190-entry shortlist to any of the ~8000 real EPSG
/// codes. Errors clearly when the code isn't a real EPSG entry at all,
/// distinct from any other failure mode.
#[tauri::command]
pub fn crs_lookup(code: u32) -> Result<EpsgLookupEntry, String> {
    let name = display_name_for_epsg(code).ok_or_else(|| format!("unknown EPSG code: {code}"))?;
    let proj4 = proj_string_for_epsg(code).ok_or_else(|| format!("unknown EPSG code: {code}"))?;
    Ok(EpsgLookupEntry { code, name, proj4 })
}

/// Case-insensitive substring search over the full registry's names —
/// PLUS the curated table's own friendlier labels, so a query like
/// "Switzerland" finds EPSG:2056 / 21781 even though the raw registry's
/// names for those two codes, "CH1903+ / LV95" / "CH1903 / LV03", never
/// say "Switzerland" (see epsg.tsv's own lines for those codes) — only
/// `curated_table`'s label does. A purely numeric query ALSO matches by
/// exact code (so "3067" finds EPSG:3067 even though "3067" never
/// appears inside its name), in addition to any substring match on the
/// name. A code present in both tables is returned once, preferring the
/// curated entry — same precedence, and the same reasoning, as
/// `proj_string_for_epsg`. Results are sorted by code and capped at
/// `limit` (the search box's page size, not a registry limit); an empty
/// query returns no results rather than the entire registry.
#[tauri::command]
pub fn crs_search(query: String, limit: usize) -> Vec<EpsgLookupEntry> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let numeric_q: Option<u32> = q.parse().ok();
    let is_match = |name: &str, code: u32| -> bool {
        name.to_lowercase().contains(&q) || numeric_q == Some(code)
    };

    let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let mut out: Vec<EpsgLookupEntry> = Vec::new();
    for e in curated_table() {
        if is_match(&e.label, e.epsg) {
            seen.insert(e.epsg);
            out.push(EpsgLookupEntry { code: e.epsg, name: e.label, proj4: e.proj });
        }
    }
    for (&code, (name, proj)) in epsg_table().iter() {
        if seen.contains(&code) || !is_match(name, code) {
            continue;
        }
        out.push(EpsgLookupEntry { code, name: name.clone(), proj4: proj.clone() });
    }
    out.sort_by_key(|e| e.code);
    out.truncate(limit);
    out
}

/// Core of `crs_transform`: apply the radian/degree boundary handling
/// (see the module doc comment) around a single proj4rs `transform`
/// call. Both `crs_transform` and `CrsTransformer::transform_batch`
/// funnel through this, so there is exactly ONE place that decides
/// which side needs degrees<->radians conversion — see the module doc
/// comment for why getting that backwards is dangerous, and easy to get
/// away with (proj4rs never errors on it, it just silently computes a
/// wrong answer that still looks like a coordinate).
fn transform_points(src: &Proj, dst: &Proj, points: &[[f64; 3]]) -> Result<Vec<[f64; 3]>, String> {
    let src_geographic = src.is_latlong();
    let dst_geographic = dst.is_latlong();

    let mut pts: Vec<(f64, f64, f64)> = points
        .iter()
        .map(|p| {
            if src_geographic {
                (p[0].to_radians(), p[1].to_radians(), p[2])
            } else {
                (p[0], p[1], p[2])
            }
        })
        .collect();

    transform(src, dst, pts.as_mut_slice()).map_err(|e| format!("{e}"))?;

    Ok(pts
        .into_iter()
        .map(|(x, y, z)| {
            if dst_geographic {
                [x.to_degrees(), y.to_degrees(), z]
            } else {
                [x, y, z]
            }
        })
        .collect())
}

/// A `from`/`to` CRS pair, parsed ONCE and reusable for many batches —
/// for a caller that transforms the same pair of CRSs repeatedly (e.g.
/// reprojecting an entire octree export while streaming), re-resolving
/// "epsg:XXXX" (a curated-table scan, or a full-registry HashMap
/// lookup) and re-parsing a proj4 string on every batch would be pure
/// waste: the CRS pair never changes mid-export. See
/// `cloud_export_octree_las` / `run_export_octree_las` in
/// commands/octree.rs for the caller this was built for.
pub struct CrsTransformer {
    src: Proj,
    dst: Proj,
}

impl CrsTransformer {
    /// Parse `from` / `to` once. Same spec syntax as `crs_transform`:
    /// "epsg:XXXX" (resolved against the curated table then the full
    /// registry — see `resolve_proj`) or a raw proj4 string.
    pub fn new(from: &str, to: &str) -> Result<Self, String> {
        Ok(Self { src: resolve_proj(from)?, dst: resolve_proj(to)? })
    }

    /// Transform one batch of `[x, y, z]` points — same axis order /
    /// units / radian-boundary contract as `crs_transform`'s doc
    /// comment (identical here, since both share `transform_points`).
    /// Call this once per batch, never once per point — see the struct
    /// doc comment for why re-parsing isn't the only cost a per-point
    /// call would repeat.
    pub fn transform_batch(&self, points: &[[f64; 3]]) -> Result<Vec<[f64; 3]>, String> {
        transform_points(&self.src, &self.dst, points)
    }

    /// Whether the TARGET side is a geographic (longlat) CRS — decides
    /// the natural output quantisation step for a reprojected export:
    /// degrees need roughly 1e-8, not the ~1e-3 m appropriate for a
    /// projected CRS. See octree.rs's `scale_offset_for_extent`, the
    /// only caller.
    pub fn dst_is_geographic(&self) -> bool {
        self.dst.is_latlong()
    }
}

/// Transform a batch of points from one CRS to another.
///
/// `from` / `to` are each either "epsg:XXXX" (resolved against the
/// curated table then the full EPSG registry — see `resolve_proj`) or a
/// raw proj4 definition string. Each point is `[x, y, z]`; for a
/// projected CRS that's (easting, northing, height) in the CRS's native
/// unit (metres, for every entry in the curated table), and for a
/// geographic CRS it's (longitude, latitude, height) in DEGREES —
/// matching proj4rs's own (lam, phi, z) axis order, just converted at
/// the boundary (below).
///
/// RADIAN / DEGREE BOUNDARY: proj4rs itself works in radians for every
/// geographic CRS, in and out. Converting is not optional and not
/// symmetric: whichever side is geographic gets converted, independent
/// of whether that's `from` or `to` (`Proj::is_latlong()` decides it per
/// side, never assumed from argument position) — a WGS84→TM35FIN call
/// converts on `from`, a TM35FIN→WGS84 call converts on `to`, and a
/// WGS84→WGS84 call (or any geographic↔geographic pair) converts on
/// both. A projected CRS on either side needs no conversion there: its
/// numbers are already in the CRS's linear unit going in and out. See
/// the module doc comment for why getting this backwards is dangerous:
/// proj4rs never raises an error for it, it just silently computes a
/// wrong answer that still looks like a coordinate.
#[tauri::command]
pub fn crs_transform(points: Vec<[f64; 3]>, from: String, to: String) -> Result<Vec<[f64; 3]>, String> {
    let src = resolve_proj(&from)?;
    let dst = resolve_proj(&to)?;
    transform_points(&src, &dst, &points).map_err(|e| format!("transform from '{from}' to '{to}': {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TM35FIN (EPSG:3067) → WGS84 for a point in southern Finland
    /// (roughly Helsinki: E=385000, N=6672000). Expected lat/lon were
    /// cross-checked, while this table was originally built, against an
    /// independent from-scratch inverse-Transverse-Mercator
    /// implementation (Karney/GeographicLib Krüger series, TypeScript,
    /// formerly src/utils/projection.ts — since removed once the GPX
    /// export it backed was migrated onto this module's crs_transform
    /// instead, so PointCloudLabeler keeps exactly one projection implementation;
    /// see RescanPanel.tsx) run on the SAME point with TM35FIN's own
    /// published parameters. That implementation was itself checked
    /// against GIGS-5101 / PROJ's regression suite before removal.
    /// Tolerance 1e-8 degrees (~1 mm at this latitude): the two
    /// independently-written engines (Poder/Engsager etmerc here,
    /// Karney's Krüger series there) agreed to ~1e-10 degrees when
    /// cross-checked directly against proj4rs during development, so
    /// 1e-8 still leaves a hundredfold margin while catching any real
    /// mistake (wrong ellipsoid, wrong false easting/northing, a
    /// degree/radian slip) by many orders of magnitude.
    #[test]
    fn tm35fin_to_wgs84_southern_finland() {
        let out = crs_transform(vec![[385000.0, 6672000.0, 0.0]], "epsg:3067".into(), "epsg:4326".into())
            .expect("transform");
        let [lon, lat, _z] = out[0];
        let expected_lon = 24.927457713312172;
        let expected_lat = 60.168665999849864;
        // 1e-8 deg (~1 mm). The two engines agreed to ~1e-10 when
        // cross-checked, so this still leaves a hundredfold margin — but
        // unlike a 1e-6 bound it cannot sit quietly over a centimetre-
        // scale regression, and a test that only fails on gross errors
        // is barely a test.
        assert!((lon - expected_lon).abs() < 1e-8, "lon {lon} expected {expected_lon}");
        assert!((lat - expected_lat).abs() < 1e-8, "lat {lat} expected {expected_lat}");
    }

    /// A UTM easting of exactly 500000 (the false easting) must invert to
    /// exactly the zone's central meridian, for ANY northing — a basic
    /// geometric property of the transverse Mercator family (the central
    /// meridian is the one line the projection maps without east-west
    /// distortion, onto x = false easting). This is the sharpest check
    /// available that false easting AND the degree conversion are both
    /// right: get either wrong and this stops landing on a round number.
    /// Zone 33N's central meridian is -183+6*33 = 15E exactly. Tolerance
    /// 1e-9 degrees (~0.1 mm) — this is an exact mathematical identity
    /// of the projection, not an approximation, so the only slack needed
    /// is float64 rounding.
    #[test]
    fn utm_easting_500000_gives_exact_central_meridian() {
        let out = crs_transform(vec![[500000.0, 6_100_000.0, 5.0]], "epsg:32633".into(), "epsg:4326".into())
            .expect("transform");
        let [lon, _lat, z] = out[0];
        assert!((lon - 15.0).abs() < 1e-9, "lon {lon}, expected exactly 15.0 (zone 33 central meridian)");
        // z isn't touched by a purely horizontal CRS pair with no datum
        // crossing (both sides are WGS84) — confirms height rides
        // through unchanged rather than being silently dropped or
        // rescaled.
        assert!((z - 5.0).abs() < 1e-9, "z {z} expected to pass through unchanged");
    }

    /// CH1903/LV03 (EPSG:21781) false origin (600000, 200000) → WGS84,
    /// expected to land close to the old Bern observatory's WGS84
    /// position (~46.9511N, 7.4386E — the observatory defines the
    /// projection's natural origin in the CH1903/Bessel frame, so its
    /// WGS84 position differs from the projection's own lat_0/lon_0
    /// parameters by exactly the CH1903→WGS84 datum shift; see this
    /// module's proj string comment). Tolerance 1e-4 degrees (~11 m):
    /// loose enough to comfortably contain the published towgs84
    /// parameters' own ~1-2 m accuracy plus this test's 4-decimal
    /// reference value, while still tight enough that a wrong ellipsoid,
    /// a sign error in the shift, or a transposed lat_0/lon_0 digit
    /// (all of which move the result by 100s of m at minimum) would
    /// fail it.
    #[test]
    fn ch1903_lv03_bern_observatory_origin() {
        let out = crs_transform(vec![[600000.0, 200000.0, 0.0]], "epsg:21781".into(), "epsg:4326".into())
            .expect("transform");
        let [lon, lat, _z] = out[0];
        assert!((lat - 46.9511).abs() < 1e-4, "lat {lat} expected ~46.9511");
        assert!((lon - 7.4386).abs() < 1e-4, "lon {lon} expected ~7.4386");
    }

    /// Round trip: project (TM35FIN → WGS84) then unproject (WGS84 →
    /// TM35FIN) must return the original point to <= 1 mm on every axis.
    /// Includes a non-zero Z to confirm height survives the round trip
    /// too, not just the horizontal position.
    #[test]
    fn round_trip_project_then_unproject_within_1mm() {
        let original = [385000.0, 6672000.0, 12.5];
        let geo = crs_transform(vec![original], "epsg:3067".into(), "epsg:4326".into()).expect("forward");
        let back = crs_transform(geo, "epsg:4326".into(), "epsg:3067".into()).expect("inverse");
        let [x, y, z] = back[0];
        assert!((x - original[0]).abs() <= 1e-3, "x round-trip delta {}", x - original[0]);
        assert!((y - original[1]).abs() <= 1e-3, "y round-trip delta {}", y - original[1]);
        assert!((z - original[2]).abs() <= 1e-3, "z round-trip delta {}", z - original[2]);
    }

    /// An EPSG code not in the curated table must say so, distinctly
    /// from a malformed proj4 string (see the next test) — both are
    /// "the CRS spec didn't resolve", but a caller (and a user reading
    /// the error) needs to know which half of the problem it is.
    #[test]
    fn unknown_epsg_code_names_itself_in_the_error() {
        let err = crs_transform(vec![[0.0, 0.0, 0.0]], "epsg:99999".into(), "epsg:4326".into())
            .expect_err("should fail");
        assert!(err.contains("99999"), "error should name the unknown code: {err}");
    }

    /// A raw proj4 string is the documented escape hatch for a CRS the
    /// curated table doesn't carry — confirm it actually reaches
    /// proj4rs rather than being rejected for not starting with "epsg:".
    #[test]
    fn raw_proj4_string_is_accepted_as_an_escape_hatch() {
        let out = crs_transform(
            vec![[500000.0, 6_100_000.0, 0.0]],
            "+proj=utm +zone=33 +ellps=WGS84 +datum=WGS84 +units=m +no_defs".into(),
            "epsg:4326".into(),
        )
        .expect("transform with a raw proj4 string");
        assert!((out[0][0] - 15.0).abs() < 1e-9);
    }

    /// An unparseable proj4 string must say so, distinctly from the
    /// unknown-EPSG-code case above.
    #[test]
    fn unparseable_proj_string_names_itself_in_the_error() {
        let err = crs_transform(vec![[0.0, 0.0, 0.0]], "not a proj string".into(), "epsg:4326".into())
            .expect_err("should fail");
        assert!(err.contains("not a proj string"), "error should quote the bad input: {err}");
    }

    /// crs_list must expose every code this module resolves by lookup —
    /// the front end's picker and crs_transform's "epsg:" branch have to
    /// stay in lock-step, and they're backed by the same `curated_table`
    /// call, but this pins that invariant directly rather than relying
    /// on it being true by construction.
    #[test]
    fn crs_list_covers_the_full_utm_range_plus_the_fixed_entries() {
        let list = crs_list();
        // 9 fixed entries (4326, 4258, 3067, 3006, 2056, 21781, 28992,
        // 2154, 27700) + 5 ETRS89 UTM zones (32N-36N) + 60 WGS84 UTM
        // north zones + 60 WGS84 UTM south zones.
        assert_eq!(list.len(), 9 + 5 + 60 + 60, "fixed + ETRS89 UTM + WGS84 UTM N + WGS84 UTM S");
        for code in [4326, 4258, 3067, 3006, 2056, 21781, 28992, 2154, 27700] {
            assert!(list.iter().any(|e| e.epsg == code), "missing EPSG:{code}");
        }
        assert!(list.iter().any(|e| e.epsg == 32633)); // WGS84 / UTM 33N
        assert!(list.iter().any(|e| e.epsg == 32733)); // WGS84 / UTM 33S
        assert!(list.iter().any(|e| e.epsg == 25835)); // ETRS89 / UTM 35N
    }

    /// `crs_lookup(3067)` — the task's own worked example — must resolve
    /// with TM35FIN's exact proj4 string. Curated and the full registry
    /// happen to agree character-for-character for this particular code
    /// (see epsg.tsv's own 3067 line), so this incidentally confirms
    /// that agreement too.
    #[test]
    fn crs_lookup_known_code_resolves_tm35fin() {
        let e = crs_lookup(3067).expect("3067 should resolve");
        assert_eq!(e.code, 3067);
        assert_eq!(
            e.proj4,
            "+proj=utm +zone=35 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
        );
    }

    /// A code absent from BOTH the curated table and the full 8017-row
    /// registry must error clearly — the same "unknown EPSG code"
    /// wording `resolve_proj`'s "epsg:" branch already uses.
    #[test]
    fn crs_lookup_unknown_code_errors_clearly() {
        let err = crs_lookup(9_999_999).expect_err("should fail");
        assert!(err.contains("9999999"), "error should name the code: {err}");
    }

    /// `crs_lookup` must prefer the curated table's proj4 over the raw
    /// registry's for a code where the two genuinely differ. EPSG:4258
    /// in epsg.tsv carries no towgs84 at all, which — per the module doc
    /// comment's "datum skip" trap — silently breaks a real shift INTO
    /// 4258 from any CRS that isn't already zero-shift. If this test
    /// ever fails, `crs_lookup` / `proj_string_for_epsg` has started
    /// reading the full table unconditionally instead of curated-first,
    /// and that needs to be reverted.
    #[test]
    fn crs_lookup_prefers_curated_proj4_over_registry_when_they_differ() {
        let e = crs_lookup(4258).expect("4258 should resolve");
        assert!(e.proj4.contains("towgs84"), "curated EPSG:4258 must carry the explicit identity shift: {}", e.proj4);
    }

    /// …with the one documented exception: a datum-shift grid the user
    /// actually supplied beats the curated Helmert fallback, because the
    /// grid is the authoritative transformation and the Helmert only
    /// ever existed as the substitute for not having it. EPSG:27700 is
    /// the case that matters in practice — epsg.tsv's definition names
    /// OSTN15, curated_table's does not.
    ///
    /// Presence of the file is the trigger, not its contents (see
    /// `nadgrid::grids_available` for why it must not parse), so a
    /// placeholder file is the correct fixture here.
    #[test]
    fn supplied_datum_grid_beats_the_curated_helmert_fallback() {
        // The grid folder is process-global; share nadgrid's lock rather
        // than racing its tests. See `geodata::test_serial`.
        let _guard = super::super::geodata::test_serial();
        let dir = std::env::temp_dir()
            .join(format!("pointcloudlabeler-crs-grid-pref-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ostn15_ntv2_osgbtoetrs.gsb"), b"placeholder").unwrap();

        super::super::geodata::set_grid_dir(None);
        let without = proj_string_for_epsg(27700).expect("27700 should resolve");
        assert!(
            !without.contains("+nadgrids="),
            "with no grid folder, EPSG:27700 must fall back to the curated Helmert: {without}"
        );

        super::super::geodata::set_grid_dir(Some(dir.clone()));
        let with = proj_string_for_epsg(27700).expect("27700 should resolve");
        assert!(
            with.contains("+nadgrids="),
            "with OSTN15 supplied, EPSG:27700 must use the grid definition: {with}"
        );

        // A code whose curated entry fixes a real registry bug must be
        // unaffected — the exception is scoped to grid-based definitions.
        assert!(proj_string_for_epsg(4258).unwrap().contains("towgs84"));

        super::super::geodata::set_grid_dir(None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A foot-based CRS must not be declared in metres. 1354 registry
    /// entries are foot-based and the picker's search reaches all of
    /// them; the exporter used to hardcode metre for every one.
    #[test]
    fn linear_units_follow_the_crs_not_a_hardcoded_metre() {
        assert_eq!(linear_units_code(3067), 9001, "TM35FIN is metres");
        // EPSG:2263 — NAD83 / New York Long Island (ftUS).
        assert_eq!(linear_units_code(2263), 9003, "a US-survey-foot CRS must say so");
        // An unknown code falls back to metre rather than to nothing.
        assert_eq!(linear_units_code(9_999_999), 9001);
    }

    /// The factor a foot-based cloud has to be multiplied by before any
    /// of PointCloudLabeler's metre-shaped arithmetic touches it.
    ///
    /// Pinned to the DEFINITIONS, not to a rounded copy: the US survey
    /// foot is exactly 1200/3937 m and the international foot exactly
    /// 0.3048 m. They differ by 2 ppm, which is 3 mm across a 1500 m
    /// plot — invisible per point, and a systematic bias on every one of
    /// them, so taking either for the other is not acceptable.
    #[test]
    fn a_foot_based_crs_reports_the_foot_it_actually_uses() {
        // Metres are 1.0, exactly — the factor is applied unconditionally
        // at import, so this has to be an exact no-op, not "close".
        assert_eq!(linear_unit_to_metre(3067), Some(1.0), "TM35FIN is metres");
        assert_eq!(linear_unit_to_metre(32118), Some(1.0), "NY Long Island (m)");

        // EPSG:2263 — NAD83 / New York Long Island (ftUS).
        let us_ft = linear_unit_to_metre(2263).expect("2263 resolves");
        assert!((us_ft - 1200.0 / 3937.0).abs() < 1e-15,
            "US survey foot must be 1200/3937 m, got {us_ft}");
        // …and specifically NOT the international foot, 2 ppm away.
        assert!((us_ft - 0.3048).abs() > 1e-9,
            "the US survey foot is not 0.3048 m: {us_ft}");

        // EPSG:2222 — NAD83 / Arizona East (ft), international feet.
        let int_ft = linear_unit_to_metre(2222).expect("2222 resolves");
        assert!((int_ft - 0.3048).abs() < 1e-15,
            "international foot must be 0.3048 m exactly, got {int_ft}");

        // Degrees are not a linear unit — a geographic CRS has no answer
        // here, and must not be handed 1.0 by default.
        assert_eq!(linear_unit_to_metre(4326), None, "degrees are not metres");
        assert_eq!(linear_unit_to_metre(4258), None);
        assert_eq!(linear_unit_to_metre(9_999_999), None, "unknown code");
    }

    /// The metric form of a foot CRS must be the SAME projection —
    /// same false origin, same datum shift, same everything — with only
    /// the unit changed. If any parameter moved, a converted dataset
    /// would land somewhere else on the planet.
    #[test]
    fn the_metric_form_of_a_foot_crs_is_the_same_projection() {
        let metric = metric_proj_for_epsg(2263).expect("2263 has a metric form");
        assert!(metric.contains("+units=m"), "{metric}");
        assert!(!metric.contains("us-ft"), "the foot unit must be gone: {metric}");

        // Every OTHER token must survive verbatim. Compared as sets so a
        // reordering isn't mistaken for a change of meaning.
        let source = proj_string_for_epsg(2263).expect("2263 resolves");
        let strip = |s: &str| -> Vec<String> {
            s.split_whitespace()
                .filter(|t| !t.starts_with("+units=") && !t.starts_with("+to_meter="))
                .map(|t| t.to_string())
                .collect()
        };
        let (mut a, mut b) = (strip(&source), strip(&metric));
        a.sort();
        b.sort();
        assert_eq!(a, b, "only the unit may differ\n  from: {source}\n  to:   {metric}");

        // The registry itself is the independent check: EPSG:32118 IS
        // "NAD83 / New York Long Island" in metres, and PointCloudLabeler's
        // substitution has to land on exactly that definition.
        let twin = proj_string_for_epsg(32118).expect("32118 resolves");
        let (mut m, mut t) = (
            metric.split_whitespace().collect::<Vec<_>>(),
            twin.split_whitespace().collect::<Vec<_>>(),
        );
        m.sort_unstable();
        t.sort_unstable();
        assert_eq!(m, t,
            "the converted CRS must equal the registry's own metric twin\n  ours: {metric}\n  epsg: {twin}");

        // And it must actually transform: 300000 m easting, 0 northing is
        // the false origin, i.e. exactly the central meridian, −74°.
        let out = crs_transform(vec![[300000.0, 0.0, 0.0]], metric.clone(), "epsg:4326".into())
            .expect("metric NY Long Island → WGS84");
        assert!((out[0][0] - (-74.0)).abs() < 1e-9, "lon {}, expected −74", out[0][0]);
        assert!((out[0][1] - 40.1666666666667).abs() < 1e-7, "lat {}", out[0][1]);

        // A CRS with a false easting that is a round number of FEET, not
        // of metres (California zone 5: 6561666.667 ftUS =
        // 2000000.0001016 m) — the case where no metric EPSG twin exists
        // and a registry lookup would have had to invent one.
        let ca = metric_proj_for_epsg(2229).expect("2229 has a metric form");
        assert!(ca.contains("+x_0=2000000.0001016"),
            "the false easting is stated in metres and must not be touched: {ca}");

        // Geographic CRSs have no metric form to convert into.
        assert_eq!(metric_proj_for_epsg(4326), None);
        assert_eq!(metric_proj_for_epsg(9_999_999), None);
    }

    /// Real WKT states its own code; that is all this needs to read.
    #[test]
    fn epsg_is_read_from_wkt1_and_wkt2() {
        // WKT1, as a LAS 1.4 file or an E57 header carries it. Note the
        // datum and spheroid carry their OWN authority codes first — the
        // CRS's own is last, which is why the last match is the right one.
        let wkt1 = r#"PROJCS["ETRS89 / TM35FIN(E,N)",GEOGCS["ETRS89",DATUM["European_Terrestrial_Reference_System_1989",SPHEROID["GRS 1980",6378137,298.257222101,AUTHORITY["EPSG","7019"]],AUTHORITY["EPSG","6258"]],AUTHORITY["EPSG","4258"]],AUTHORITY["EPSG","3067"]]"#;
        assert_eq!(epsg_from_wkt(wkt1), Some(3067), "must take the CRS's code, not the datum's");

        let wkt2 = r#"PROJCRS["ETRS89 / TM35FIN(E,N)",BASEGEOGCRS["ETRS89",ID["EPSG",4258]],ID["EPSG",3067]]"#;
        assert_eq!(epsg_from_wkt(wkt2), Some(3067));
    }

    /// A number scraped out of a string is a guess until it is confirmed
    /// to name a usable CRS. Recording an unresolvable one would put a
    /// coordinate system on a dataset that no later transform can honour.
    #[test]
    fn wkt_without_a_usable_epsg_code_yields_nothing() {
        assert_eq!(epsg_from_wkt(""), None);
        assert_eq!(epsg_from_wkt("PROJCS[\"no authority at all\"]"), None);
        // Another authority is not EPSG.
        assert_eq!(epsg_from_wkt(r#"PROJCS["x",AUTHORITY["ESRI","102100"]]"#), None);
        // A code that does not resolve is not recorded.
        assert_eq!(epsg_from_wkt(r#"PROJCS["x",AUTHORITY["EPSG","9999999"]]"#), None);
    }

    /// `crs_search("TM35")` must find EPSG:3067 by a name fragment — one
    /// of the exact example queries the feature is meant to support.
    #[test]
    fn crs_search_finds_code_by_name_fragment() {
        let hits = crs_search("TM35".to_string(), 10);
        assert!(hits.iter().any(|e| e.code == 3067), "TM35 search should find EPSG:3067: {hits:?}");
    }

    /// `crs_search("3067")` — a purely numeric query — must find
    /// EPSG:3067 by exact code match even though "3067" never appears
    /// as a substring of its name.
    #[test]
    fn crs_search_finds_exact_code_for_numeric_query() {
        let hits = crs_search("3067".to_string(), 10);
        assert!(hits.iter().any(|e| e.code == 3067), "numeric search should find EPSG:3067 by code: {hits:?}");
    }

    /// `crs_search("Switzerland")` must find both Swiss CRSs even though
    /// the raw registry's own names for those two codes never say
    /// "Switzerland" (see epsg.tsv's 2056 / 21781 lines: "CH1903+ /
    /// LV95" and "CH1903 / LV03") — only `curated_table`'s label does.
    /// Confirms crs_search actually searches curated labels, not just
    /// the raw registry text.
    #[test]
    fn crs_search_finds_switzerland_by_curated_label() {
        let hits = crs_search("Switzerland".to_string(), 10);
        let codes: Vec<u32> = hits.iter().map(|e| e.code).collect();
        assert!(codes.contains(&2056), "should find CH1903+/LV95: {codes:?}");
        assert!(codes.contains(&21781), "should find CH1903/LV03: {codes:?}");
    }

    /// A code in the full registry but NOT the curated shortlist (2001,
    /// an old British-West-Indies grid) must still resolve through
    /// `resolve_proj`'s "epsg:" branch — the whole point of embedding
    /// the full table: any real EPSG code now works, not just the ~190
    /// curated ones.
    #[test]
    fn full_registry_code_outside_curated_table_still_resolves() {
        assert!(curated_table().iter().all(|e| e.epsg != 2001), "2001 should not be curated (test picked a bad example code)");
        let out = crs_transform(vec![[400000.0, 1_800_000.0, 0.0]], "epsg:2001".into(), "epsg:4326".into());
        assert!(out.is_ok(), "EPSG:2001 (full-registry-only) should resolve and transform: {out:?}");
    }

    /// The critical regression guard: NOTHING in the embedded table may
    /// carry "+k_0=". proj4rs silently ignores that spelling and falls
    /// back to a scale factor of 1.0 with no error (see the module doc
    /// comment's third trap), measured at an 8.1 km / 346 m mislocation
    /// for one real affected CRS. epsg.tsv ships pre-fixed (every
    /// "+k_0=" already rewritten to "+k="); this test exists so a future
    /// regeneration that skips that rewrite fails `cargo test` instead
    /// of silently shipping that error again.
    #[test]
    fn embedded_epsg_table_has_no_k_0_param() {
        assert!(!EPSG_TSV.contains("+k_0="), "epsg.tsv must not contain +k_0= — proj4rs silently ignores it (see module doc comment)");
    }
}

/// The cost this file claims for parsing the full EPSG table.
#[cfg(test)]
mod timing_tests {
    use super::*;

    #[test]
    fn epsg_parse_timing() {
        let t = std::time::Instant::now();
        let n = epsg_table().len();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        println!("EPSG table: {n} codes from {} KB in {ms:.1} ms", EPSG_TSV.len() / 1024);
        assert!(n > 7000, "the table should hold the full EPSG set, got {n}");
        // 1.8 ms release / 7.3 ms debug measured; 500 ms only trips on a
        // change that makes the lazy parse worth reconsidering.
        assert!(ms < 500.0, "parsing took {ms:.1} ms — the OnceLock rationale assumes it is cheap");
    }
}
