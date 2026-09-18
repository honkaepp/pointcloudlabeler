// Riegl RiSCAN PRO / RiPROCESS preprocessing commands.
//
// What's here, and what's NOT:
//
//  ✓ Parsing `project.rsp` — the .RiSCAN / .RiPROJECT directory's root
//    XML. This file is plain text and carries everything we need to LIST
//    a project: the per-scan-position name + SOP matrix (SOCS → PRCS),
//    the project's POP matrix (PRCS → GLCS), and the per-scan reference
//    to its data file inside SCANS/<pos>/SINGLESCANS/.
//
//  ✓ Manifest registration — we write our findings to
//    <projectFolder>/preprocessing/riegl/<safeName>/manifest.json so the
//    Preprocessing module can re-list the imported projects across
//    sessions without re-parsing.
//
//  ✗ Reading binary point data from `.rdbx` / `.rxp` — both are RIEGL's
//    own formats and require RIEGL's rdblib / RiVLib SDKs (free with a
//    RIEGL account, NOT redistributable), so the build that ships reads
//    neither (see riegl_rdbx.rs). `riegl_export_region` says so by name
//    and points at what works: export from RiSCAN PRO as E57 / LAS and
//    import that.
//    A build made with `--features rdblib` / `--features rivlib` for
//    one's own use goes to the SDKs instead.
//
// References used to write this parser:
//   - gadomski/riscan-pro (MIT-licensed Rust XML reader for project.rsp)
//   - PDAL readers.rdb / readers.rxp documentation
//   - RiSCAN Pro Coordinate Systems manual

use tauri::State;

use crate::state::AppState;
use std::collections::{HashMap, HashSet};
use std::fs::{create_dir_all, File};
use std::io::{BufReader, Write};
use std::path::{Path, PathBuf};

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use serde::{Deserialize, Serialize};

/// What the front end sees per imported Riegl project — mirrored
/// straight into the UI's list. Matches RieglProjectSummary on the TS
/// side via the camelCase rename.
/// Which kind of RIEGL project a folder is. They are not variants of
/// one layout: a RiSCAN PRO project is `project.rsp` + `SCANS/` and
/// normally carries `.rdbx`, while what a scanner writes to its own
/// storage is `ScanPosNNN.SCNPOS/` folders whose scans are `.rxp` and
/// nothing else.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectKind {
    /// RiSCAN PRO / RiPROCESS. The default so that a manifest written
    /// before this field existed reads as what it was.
    #[default]
    Riscan,
    /// A scanner-side `.PROJ`.
    ScannerProj,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RieglProjectSummary {
    pub id: String,
    pub source_path: String,
    pub name: String,
    pub epsg: Option<u32>,
    /// 4×4 POP (PRCS → GLCS), row-major, 16 floats. Null when the project
    /// has no GLCS configured (= often the case for plot-scale TLS surveys).
    pub pop: Option<Vec<f64>>,
    pub scan_positions: Vec<RieglScanPosition>,
    /// Which layout this folder turned out to be.
    #[serde(default)]
    pub kind: ProjectKind,
    /// Every `.rdbx` / `.rxp` found anywhere under the project root,
    /// whether or not a scan position claimed it. The difference
    /// between "this project carries no point files" and "they are
    /// somewhere this importer did not look" is the whole diagnosis
    /// when an export finds nothing, and it used to be unavailable.
    #[serde(default)]
    pub rdbx_in_project: u32,
    #[serde(default)]
    pub rxp_in_project: u32,
    /// `.rdbx` found in the project that no scan position claimed.
    /// Non-zero means the layout is one the ladder in
    /// `discover_position_files` does not cover — worth reporting.
    #[serde(default)]
    pub rdbx_unassigned: u32,
    /// epoch ms — when the manifest was (re)built.
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RieglScanPosition {
    pub id: String,
    pub name: String,
    /// 4×4 SOP (SOCS → PRCS), row-major, 16 floats. The XML stores it
    /// column-major; we transpose on read so the matrix as Rust sees it
    /// is row-major (mat[row * 4 + col]).
    pub sop: Vec<f64>,
    pub point_count: Option<u64>,
    pub centre: Option<[f64; 3]>,
    /// True when at least one `.rdbx` was matched to this position —
    /// i.e. `rdbx_paths` is non-empty. Kept as its own field because
    /// the UI has always read it.
    pub has_rdbx: bool,
    /// The `.rdbx` files this position's points come from, resolved at
    /// import so the export does not have to guess the layout twice.
    /// A position can carry more than one: RiSCAN PRO writes one file
    /// per single scan, and a position scanned twice has two. The old
    /// export took the first one `read_dir` happened to yield and
    /// silently dropped the rest.
    #[serde(default)]
    pub rdbx_paths: Vec<String>,
    /// How many `.rxp` line files were found for it — the length of
    /// `rxp_paths`, kept because the UI has always read a count.
    #[serde(default)]
    pub rxp_count: u32,
    /// The `.rxp` files of this position. Exportable only in a build
    /// made with `--features rivlib` (see commands/riegl_rxp.rs); the
    /// paths are resolved either way so the UI can say what is there
    /// and the error can name the alternative.
    #[serde(default)]
    pub rxp_paths: Vec<String>,
    /// Which file the pose came from — `project.rsp`, `final.pose`, a
    /// per-scan `.pose` — or None when none of them held one and the
    /// position carries the identity.
    #[serde(default)]
    pub pose_source: Option<String>,
    /// When no file held a transform: what they held instead, in one
    /// line, so the row can explain itself.
    #[serde(default)]
    pub pose_note: Option<String>,
}

/// One run of the manifest serializer / deserializer — used by every
/// command that reads or writes a manifest.json. Bumped if the on-disk
/// schema changes.
/// v2 added the resolved `.rdbx` paths and the project-wide file
/// tally; v3 the project flavour, the `.rxp` paths and where each
/// pose came from. Every added field carries `#[serde(default)]`, so
/// an older manifest still deserialises — it just has no cached paths,
/// and the export re-runs discovery when it finds none.
const MANIFEST_VERSION: u32 = 3;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    summary: RieglProjectSummary,
}

// --- public commands ------------------------------------------------

#[tauri::command]
pub fn riegl_list_projects(project_folder: String) -> Result<Vec<RieglProjectSummary>, String> {
    let dir = Path::new(&project_folder).join("preprocessing").join("riegl");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out: Vec<RieglProjectSummary> = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read riegl dir: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = path.join("manifest.json");
        let Ok(bytes) = std::fs::read(&manifest) else { continue; };
        let Ok(m) = serde_json::from_slice::<Manifest>(&bytes) else { continue; };
        out.push(m.summary);
    }
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

#[tauri::command]
pub fn riegl_import_project(
    project_folder: String,
    source_path: String,
    name: String,
) -> Result<RieglProjectSummary, String> {
    let src = Path::new(&source_path);
    if !src.is_dir() {
        return Err(format!(
            "Not a folder: {source_path}. A Riegl project is the .RiSCAN / .RiPROJECT directory itself, not a single file.",
        ));
    }
    // Two layouts, told apart by what is in the folder rather than by
    // its extension: a `.RiSCAN` / `.RiPROJECT` has a project.rsp, and
    // a scanner-side `.PROJ` has `ScanPosNNN.SCNPOS` folders. The old
    // message — "doesn't look like a RiSCAN PRO / RiPROCESS project" —
    // was the only answer a scanner project got, and it is wrong: the
    // folder is unmistakably a RIEGL project.
    let rsp = find_project_rsp(src);
    let kind = if rsp.is_some() { ProjectKind::Riscan } else { ProjectKind::ScannerProj };
    if rsp.is_none() && scnpos_dirs(src).is_empty() {
        return Err(format!(
            "{source_path} holds neither a project.rsp (RiSCAN PRO / RiPROCESS) nor any \
             *.SCNPOS folder (a scanner's own .PROJ project), so there is nothing to import. \
             Point this at the project directory itself, not at a folder of projects.",
        ));
    }

    let id = safe_folder_name(&name);
    let target = Path::new(&project_folder)
        .join("preprocessing")
        .join("riegl")
        .join(&id);
    create_dir_all(&target).map_err(|e| format!("create target dir: {e}"))?;

    // Where the project metadata and the scan-position layout come
    // from: the .rsp XML, or the scanner's own folder structure.
    let (parsed, project_root) = match &rsp {
        Some(rsp) => (
            parse_project_rsp(rsp)?,
            rsp.parent().unwrap_or(src).to_path_buf(),
        ),
        None => (parse_scanner_proj(src)?, src.to_path_buf()),
    };

    // Find each position's point files. Not one hardcoded path any
    // more — see `discover_position_files` for why a real project's
    // fifty .rdbx files could sit somewhere the old probe never looked
    // and report as ".rxp only" on every row.
    let found = discover_all(&project_root, &parsed.scan_positions);

    let mut scan_positions: Vec<RieglScanPosition> = Vec::new();
    for (i, (sp, files)) in parsed.scan_positions.iter().zip(&found.per_position).enumerate() {
        let rdbx_paths: Vec<String> =
            files.rdbx.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        // A point count comes from reading the file, and this build
        // reads no RDB 2 — see riegl_rdbx.rs. The rows say the build
        // cannot read the points, and the export says why.
        let point_count: Option<u64> = None;
        scan_positions.push(RieglScanPosition {
            id: format!("sp_{i:03}"),
            name: sp.name.clone(),
            sop: sp.sop.clone(),
            point_count,
            centre: None,
            has_rdbx: !rdbx_paths.is_empty(),
            rdbx_paths,
            rxp_count: files.rxp.len() as u32,
            rxp_paths: files.rxp.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            pose_source: sp.pose_source.clone(),
            pose_note: sp.pose_note.clone(),
        });
    }

    let summary = RieglProjectSummary {
        id: id.clone(),
        source_path: source_path.clone(),
        name: name.clone(),
        epsg: parsed.epsg,
        pop: parsed.pop,
        scan_positions,
        kind,
        rdbx_in_project: found.rdbx_in_project as u32,
        rxp_in_project: found.rxp_in_project as u32,
        rdbx_unassigned: found.rdbx_unassigned as u32,
        updated_at: now_ms(),
    };
    write_manifest(&target, &summary)?;
    Ok(summary)
}

/// What this build can actually read. The UI asks at startup, because
/// it decides whether a `.rxp`-only scan position is exportable — and
/// no manifest can record it: the same project folder is exportable
/// from a build made with `--features rivlib` and not from the one
/// that ships.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RieglCapabilities {
    /// `.rdbx` (RDB 2), through RIEGL's rdblib. True only in a build
    /// made with `--features rdblib`, which cannot be distributed — and
    /// even there only once the FFI read loop in riegl_rdb.rs is
    /// written. False in the build that ships — see riegl_rdbx.rs.
    pub rdbx: bool,
    /// `.rxp`, through RiVLib. True only in a build that cannot be
    /// distributed.
    pub rxp: bool,
}

#[tauri::command]
pub fn riegl_capabilities() -> RieglCapabilities {
    RieglCapabilities {
        rdbx: cfg!(feature = "rdblib"),
        rxp: crate::commands::riegl_rxp::supported(),
    }
}

#[tauri::command]
pub fn riegl_remove_project(project_folder: String, riegl_id: String) -> Result<(), String> {
    // One path component, not a path: this is joined onto the
    // preprocessing directory, and a join confines nothing.
    // See fsgrant::safe_component.
    crate::fsgrant::safe_component(&riegl_id)?;
    let dir = Path::new(&project_folder)
        .join("preprocessing")
        .join("riegl")
        .join(&riegl_id);
    if !dir.is_dir() {
        return Err(format!("not a registered Riegl project: {riegl_id}"));
    }
    // Sanity check: only nuke a folder that actually carries our manifest.
    if !dir.join("manifest.json").is_file() {
        return Err(format!("refusing to remove '{riegl_id}' — no manifest.json"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("remove: {e}"))?;
    Ok(())
}

/// Bbox in PROJECT coords (PRCS). Each axis is optional — null = don't
/// clip on that axis. Matches the JS-side shape.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RieglExportBbox {
    pub x_min: Option<f64>,
    pub x_max: Option<f64>,
    pub y_min: Option<f64>,
    pub y_max: Option<f64>,
    pub z_min: Option<f64>,
    pub z_max: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RieglExportResult {
    pub out_path: String,
    pub point_count: u64,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn riegl_export_region(
    state: State<'_, AppState>,
    project_folder: String,
    riegl_id: String,
    scan_position_ids: Vec<String>,
    bbox: RieglExportBbox,
    out_path: String,
) -> Result<RieglExportResult, String> {
    // One path component, not a path: this is joined onto the
    // preprocessing directory, and a join confines nothing.
    // See fsgrant::safe_component.
    crate::fsgrant::safe_component(&riegl_id)?;
    // The renderer names this file; it is only allowed to name one the
    // user chose in a save dialog, or one inside the open project. See
    // fsgrant.rs — every write out of this application goes through it.
    let out_path = state
        .authorise_path(&out_path)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    // Resolve the picked scan-position ids back to .rdbx paths via the
    // manifest. The actual byte-level read happens in commands::riegl_rdb;
    // when the binary was built without the `rdblib` feature that call
    // returns a friendly "install rdblib" error instead of writing a
    // half-baked LAS. With the feature on it walks the SDK and produces
    // a real LAS / LAZ.
    let manifest_dir = std::path::Path::new(&project_folder)
        .join("preprocessing")
        .join("riegl")
        .join(&riegl_id);
    let manifest_bytes = std::fs::read(manifest_dir.join("manifest.json"))
        .map_err(|e| format!("read manifest.json: {e}"))?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("parse manifest.json: {e}"))?;
    let source_root = std::path::Path::new(&manifest.summary.source_path);
    let selected: Vec<&RieglScanPosition> = manifest
        .summary
        .scan_positions
        .iter()
        .filter(|sp| scan_position_ids.iter().any(|w| w == &sp.id))
        .collect();

    // The paths the import resolved win while they still point at
    // files. A v1 manifest has none and a project can move between
    // sessions, so rather than reporting an empty selection, re-run
    // discovery — one XML parse plus one walk.
    let cache_usable = |sp: &RieglScanPosition| {
        !sp.rdbx_paths.is_empty()
            && sp.rdbx_paths.iter().all(|p| std::path::Path::new(p).is_file())
    };
    let fresh = if selected.iter().all(|sp| cache_usable(sp)) {
        None
    } else {
        rediscover(source_root)
    };

    let mut want: Vec<crate::commands::riegl_rdb::RdbScanRequest> = Vec::new();
    let mut want_rxp: Vec<crate::commands::riegl_rxp::RxpScanRequest> = Vec::new();
    let mut searched: Vec<String> = Vec::new();
    for sp in &selected {
        // Every .rdbx of the position, not the first one `read_dir`
        // yielded: a position with two single scans used to export
        // half its points with nothing saying so.
        let (rdbx, rxp): (Vec<String>, Vec<String>) = if cache_usable(sp) {
            (sp.rdbx_paths.clone(), sp.rxp_paths.clone())
        } else if let Some(f) = fresh.as_ref().and_then(|r| r.by_name.get(&sp.name)) {
            searched.extend(f.searched.iter().map(|d| d.display().to_string()));
            (
                f.rdbx.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
                f.rxp.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            )
        } else {
            (Vec::new(), sp.rxp_paths.clone())
        };
        // `.rdbx` wins where a position has both: it is the processed
        // form of the same scan, and every build can read it.
        if !rdbx.is_empty() {
            for path in rdbx {
                want.push(crate::commands::riegl_rdb::RdbScanRequest {
                    rdbx_path: path,
                    sop: sp.sop.clone(),
                    name: sp.name.clone(),
                    epsg: manifest.summary.epsg,
                });
            }
        } else {
            for path in rxp {
                want_rxp.push(crate::commands::riegl_rxp::RxpScanRequest {
                    rxp_path: path,
                    sop: sp.sop.clone(),
                    name: sp.name.clone(),
                    epsg: manifest.summary.epsg,
                });
            }
        }
    }
    if want.is_empty() && want_rxp.is_empty() {
        return Err(no_rdbx_message(&manifest.summary, selected.len(), fresh.as_ref(), searched));
    }
    // Two formats, two libraries, and each exporter owns the LAS
    // writer it streams into — so one output file cannot hold both.
    // Refused rather than quietly dropping one side or writing two
    // files the user did not ask for.
    if !want.is_empty() && !want_rxp.is_empty() {
        return Err(format!(
            "The selection mixes {} scan position(s) read from .rdbx with {} read from .rxp. \
             Those go through different readers, each writing its own LAS, so export them as \
             two batches — select one group, export, then the other.",
            want.len(),
            want_rxp.len(),
        ));
    }

    let rdb_bbox = crate::commands::riegl_rdb::RdbExportBbox {
        x_min: bbox.x_min, x_max: bbox.x_max,
        y_min: bbox.y_min, y_max: bbox.y_max,
        z_min: bbox.z_min, z_max: bbox.z_max,
    };
    let point_count = if want_rxp.is_empty() {
        crate::commands::riegl_rdb::export_region(&out_path, &want, &rdb_bbox)?.point_count
    } else {
        crate::commands::riegl_rxp::export_region(&out_path, &want_rxp, &rdb_bbox)?.point_count
    };
    Ok(RieglExportResult { out_path, point_count })
}

// --- XML parser -----------------------------------------------------

#[derive(Default)]
struct ParsedProject {
    epsg: Option<u32>,
    pop: Option<Vec<f64>>,
    scan_positions: Vec<ParsedScanPosition>,
}

struct ParsedScanPosition {
    name: String,
    sop: Vec<f64>,
    /// Every `.rdbx` / `.rxp` path the XML mentions anywhere inside
    /// this `<scanposition>`, in document order.
    ///
    /// Deliberately not tied to one element name. RIEGL publishes no
    /// XSD, the per-scan file lives under `<file>` in the projects this
    /// was written against but not necessarily in every version, and a
    /// parser that guesses the element name wrong silently finds
    /// nothing. Any text node or attribute value ending in a
    /// point-file extension is a file reference — nothing else in a
    /// .rsp looks like one.
    refs: Vec<String>,
    /// Which file the pose was read from, or None when none could be —
    /// the position then carries the identity, and the UI says so
    /// rather than showing a scan confidently placed at the origin.
    pose_source: Option<String>,
    /// What the pose files did contain, when none of them held a
    /// transform. A scanner's `final.pose` is JSON — a GNSS fix and
    /// inclination angles, not a registration — and "identity pose"
    /// alone does not tell the user why or what to do about it.
    pose_note: Option<String>,
}

/// Try the few well-known names project.rsp can show up under. Most
/// .RiSCAN folders have it at the root; some older variants have a
/// different filename. We accept both.
fn find_project_rsp(dir: &Path) -> Option<PathBuf> {
    for name in ["project.rsp", "Project.rsp", "PROJECT.RSP"] {
        let p = dir.join(name);
        if p.is_file() { return Some(p); }
    }
    // Some RiPROCESS layouts nest the project XML one level deeper.
    if let Ok(it) = std::fs::read_dir(dir) {
        for entry in it.flatten() {
            let path = entry.path();
            if path.is_file()
                && path.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("rsp")).unwrap_or(false)
            {
                return Some(path);
            }
        }
    }
    None
}

/// Walk project.rsp pulling out every `<scanposition>`'s name + SOP and
/// the project-level POP. We use quick-xml's pull parser so we never
/// build a full DOM — a project with 200 scan positions parses in
/// milliseconds and constant memory.
///
/// The XML schema is inferred from the files themselves (RIEGL publishes
/// no XSD) — reading a project's own XML, not decompiling anything
/// from the open-source gadomski/riscan-pro Rust reader; the conventions
/// for the matrix elements are documented inline.
fn parse_project_rsp(path: &Path) -> Result<ParsedProject, String> {
    let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut reader = Reader::from_reader(BufReader::new(file));
    // No per-event trimming: an element's text now arrives in pieces
    // around its entity references, and trimming each piece ate the
    // spaces between them ("Plot 3 & 4" → "Plot 3&4"). The gathered text
    // is trimmed once, whole, where it is read.

    let mut out = ParsedProject::default();
    let mut buf = Vec::new();
    // Element stack — needed because `<matrix>` and `<name>` appear under
    // several different parents (pop / sop / cop / scanposition / scan /
    // scanposimage); we only want a subset.
    let mut stack: Vec<String> = Vec::new();
    // The scan position currently being assembled (between
    // <scanposition>…</scanposition>).
    let mut current_sp: Option<ParsedScanPosition> = None;

    // Text is gathered here and read when its element closes. Since
    // quick-xml 0.37 an entity reference is its own event, so a name
    // like "Plot 3 &amp; 4" arrives as three events — taking each as the
    // element's text, last one wins, made that name "4". See
    // `an_entity_in_a_name_is_unescaped`.
    let mut pending = String::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                // Text before a child element belongs to the parent, as
                // it always did.
                if !pending.trim().is_empty() {
                    take_text(pending.trim(), &stack, &mut current_sp, &mut out);
                }
                pending.clear();
                let tag = e.name().as_ref().as_bytes().to_vec();
                let tag_str = String::from_utf8_lossy(&tag).to_string();
                if tag_str == "scanposition" {
                    current_sp = Some(ParsedScanPosition {
                        name: String::new(),
                        sop: Vec::new(),
                        refs: Vec::new(),
                        pose_source: None,
                        pose_note: None,
                    });
                }
                stack.push(tag_str);
                if let Some(sp) = current_sp.as_mut() {
                    // with_checks(false): the default duplicate-attribute
                    // check compares each new name against every earlier
                    // one on the same tag, which is O(N²) in the number
                    // of attributes with no bound on N — RUSTSEC-2026-0194,
                    // measured by its reporter at ~10 minutes of pinned
                    // CPU for a single tag carrying 800k attributes. This
                    // is a project.rsp the user opened, so N is not ours
                    // to trust. Nothing here wanted the check: the loop
                    // reads values, and `flatten` already discards the
                    // error it would have raised.
                    for attr in e.attributes().with_checks(false).flatten() {
                        push_point_ref(&mut sp.refs, &attr.value);
                    }
                }
            }
            Ok(Event::End(_)) => {
                if !pending.trim().is_empty() {
                    take_text(pending.trim(), &stack, &mut current_sp, &mut out);
                }
                pending.clear();
                if let Some(closed) = stack.pop() {
                    if closed == "scanposition" {
                        if let Some(sp) = current_sp.take() {
                            // Drop entries that didn't carry a name — those are
                            // empty <scanposition> shells some tools leave behind.
                            if !sp.name.is_empty() {
                                out.scan_positions.push(sp);
                            }
                        }
                    }
                }
            }
            // Self-closing elements never reach the Start arm, and a
            // file reference can live in an attribute of one.
            Ok(Event::Empty(e)) => {
                if let Some(sp) = current_sp.as_mut() {
                    // with_checks(false): the default duplicate-attribute
                    // check compares each new name against every earlier
                    // one on the same tag, which is O(N²) in the number
                    // of attributes with no bound on N — RUSTSEC-2026-0194,
                    // measured by its reporter at ~10 minutes of pinned
                    // CPU for a single tag carrying 800k attributes. This
                    // is a project.rsp the user opened, so N is not ours
                    // to trust. Nothing here wanted the check: the loop
                    // reads values, and `flatten` already discards the
                    // error it would have raised.
                    for attr in e.attributes().with_checks(false).flatten() {
                        push_point_ref(&mut sp.refs, &attr.value);
                    }
                }
            }
            Ok(Event::Text(t)) => {
                // Since quick-xml 0.40 the reader hands text over as
                // `&str`; a piece that still carries an entity is
                // resolved here, one that fails to resolve is kept as
                // written rather than dropped.
                let raw = t.into_inner();
                match quick_xml::escape::unescape(&raw) {
                    Ok(u) => pending.push_str(&u),
                    Err(_) => pending.push_str(&raw),
                }
            }
            Ok(Event::GeneralRef(r)) => {
                // `&amp;`, `&#x3C;` and friends, each its own event: the
                // character it stands for joins the text being gathered.
                // An entity this parser does not know is kept as written —
                // a stray reference cannot delete part of a name.
                if r.is_char_ref() {
                    if let Ok(Some(c)) = r.resolve_char_ref() { pending.push(c); }
                } else {
                    let name = r.into_inner();
                    match quick_xml::escape::resolve_predefined_entity(&name) {
                        Some(known) => pending.push_str(known),
                        None => { pending.push('&'); pending.push_str(&name); pending.push(';'); }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("parse {}: {e}", path.display())),
            _ => {}
        }
        buf.clear();
    }
    Ok(out)
}

/// What one element's text means, given where in the document it sits.
/// Called once per element, with its whole text — which is what the
/// old Text arm was, before entity references became their own events.
fn take_text(text: &str, stack: &[String], current_sp: &mut Option<ParsedScanPosition>, out: &mut ParsedProject) {
        // Direct parents drive what this <…> means.
        let inside_pop = stack_contains(&stack, "pop");
        let inside_scanposition = stack_contains(&stack, "scanposition");
        let inside_sop_of_sp = inside_scanposition && stack_contains(&stack, "sop");
        let inside_scanposimage = stack_contains(&stack, "scanposimage");
        let inside_cop = stack_contains(&stack, "cop");
        let inside_singlescan = stack_contains(&stack, "singlescans") || stack_contains(&stack, "scan");

        if inside_scanposition {
            if let Some(sp) = current_sp.as_mut() {
                push_point_ref(&mut sp.refs, &text);
            }
        }

        if let Some(parent) = stack.last() {
            match parent.as_str() {
                // <matrix> directly inside <pop> — the project's
                // PRCS → GLCS transform.
                "matrix" if inside_pop && !inside_scanposition => {
                    if let Some(m) = parse_matrix(&text) { out.pop = Some(m); }
                }
                // <matrix> inside <sop> inside <scanposition> — that
                // position's SOCS → PRCS. Guard out matrices that
                // belong to scanposimages or COPs.
                "matrix" if inside_sop_of_sp && !inside_scanposimage && !inside_cop && !inside_singlescan => {
                    if let Some(sp) = current_sp.as_mut() {
                        if let Some(m) = parse_matrix(&text) {
                            sp.sop = m;
                            sp.pose_source = Some("project.rsp".to_string());
                        }
                    }
                }
                // <name> directly under <scanposition> — guard out
                // names belonging to nested <scan>, <scanposimage>,
                // <camcalib> etc. by checking the parent chain.
                "name" if inside_scanposition && stack.iter().rev().nth(1).map(|s| s == "scanposition").unwrap_or(false) => {
                    if let Some(sp) = current_sp.as_mut() {
                        sp.name = text.trim().to_string();
                    }
                }
                // Crude EPSG sniff — Riegl projects often carry an
                // <epsg> or <epsgcode> element somewhere in the GLCS
                // block. We tolerate either.
                "epsg" | "epsgcode" if out.epsg.is_none() => {
                    if let Ok(n) = text.trim().parse::<u32>() { out.epsg = Some(n); }
                }
                _ => {}
            }
        }
    
}

fn stack_contains(stack: &[String], tag: &str) -> bool {
    stack.iter().any(|t| t == tag)
}

/// Parse 16 whitespace-separated floats into a ROW-MAJOR 4×4, so callers
/// index as `m[row * 4 + col]` with the translation at 3, 7 and 11.
///
/// project.rsp stores them column-major, so the read transposes. But
/// which way round a writer serialises a matrix is exactly the kind of
/// thing that differs between versions and vendors, and getting it wrong
/// does not fail — it silently rotates every scan position and leaves
/// the translation at zero.
///
/// A rigid transform has an invariant that holds whichever convention
/// produced it: its bottom row is (0, 0, 0, 1). So the transpose is
/// checked against that, and the untransposed form is used instead when
/// IT is the one that satisfies it. The PTX reader cross-checks its own
/// matrix the same way, against the scanner-position line; this is the
/// same idea using the only evidence a .rsp matrix carries by itself.
///
/// Returns None when neither layout is a plausible affine transform,
/// rather than picking one and hoping.
fn parse_matrix(s: &str) -> Option<Vec<f64>> {
    let v: Vec<f64> = s
        .split_whitespace()
        .filter_map(|t| t.parse::<f64>().ok())
        .collect();
    if v.len() != 16 { return None; }

    // Column-major source: element (r, c) sits at v[r + 4c].
    let mut transposed = vec![0.0f64; 16];
    for r in 0..4 {
        for c in 0..4 {
            transposed[r * 4 + c] = v[r + 4 * c];
        }
    }

    let bottom_row_ok = |m: &[f64]| -> bool {
        m[12].abs() < 1e-9 && m[13].abs() < 1e-9 && m[14].abs() < 1e-9
            && (m[15] - 1.0).abs() < 1e-9
    };

    if bottom_row_ok(&transposed) { return Some(transposed); }
    // The file was already row-major — transposing it would have moved
    // the translation into the bottom row and zeroed the scan's position.
    if bottom_row_ok(&v) { return Some(v); }
    None
}

// --- point-file discovery -------------------------------------------
//
// Where a scan position's point files live is not one fixed path, and
// this importer used to assume it was: it probed exactly
// SCANS/<name>/SINGLESCANS/*.rdbx, and a real RiSCAN PRO project with
// fifty .rdbx files in it reported ".rxp only" on all forty rows, then
// refused to export. A .rsp project does not have to store them
// there — the XML names each scan's file, that name can be relative or
// absolute, RiPROCESS nests differently, and a .rdbx converted from a
// .rxp commonly sits beside the .rxp the XML still points at.
//
// So the search is a ladder, most authoritative rung first, and it
// stops at the first rung that finds .rdbx files:
//
//   1. the files project.rsp names for that position;
//   2. every point file in those files' directories, plus the
//      conventional SCANS/<name>/SINGLESCANS/ — restricted to the scan
//      names the XML gave, so a thinned or derived copy sitting in the
//      same folder cannot double-count points into the export;
//   3. a bounded recursive walk of the position's own folder;
//   4. a project-wide index by file stem, for layouts none of the
//      above match. RIEGL names a single scan by its timestamp, so the
//      stem identifies a scan on its own, and a file already claimed
//      by an earlier position is never handed to a second one.
//
// Every path comparison here is case-insensitive. The XML's spelling
// of SCANS, SINGLESCANS or an extension is not necessarily the
// filesystem's, and on Linux that difference is fatal rather than
// cosmetic — `.RDBX` used to be invisible to this importer.

/// Depth and entry budget for the recursive walks. A .RiSCAN folder
/// with per-position images holds tens of thousands of files; the
/// budget keeps a pathological tree from turning an import into a
/// filesystem crawl, at the cost of possibly missing a file in one
/// (which rung 4 then reports as unassigned rather than hiding).
const WALK_MAX_DEPTH: usize = 8;
const WALK_BUDGET: usize = 200_000;

/// Extension test that ignores case, unlike `== Some("rdbx")`.
fn ext_is(path: &Path, ext: &str) -> bool {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.eq_ignore_ascii_case(ext))
        .unwrap_or(false)
}

fn is_point_file(path: &Path) -> bool {
    // `*.mon.rxp` is excluded: a scanner writes it beside the real
    // `.rxp` as a low-rate monitoring stream — the same scene at a
    // fraction of the points — so counting it as a scan would
    // duplicate every surface in an export and inflate the tally.
    if is_monitor_stream(path) {
        return false;
    }
    ext_is(path, "rdbx") || ext_is(path, "rxp")
}

fn is_monitor_stream(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_ascii_lowercase().ends_with(".mon.rxp"))
        .unwrap_or(false)
}

fn stem_lc(path: &Path) -> Option<String> {
    path.file_stem().and_then(|s| s.to_str()).map(|s| s.to_ascii_lowercase())
}

/// Comparison key for "is this the same file", used to keep one file
/// from being exported twice when two rungs of the ladder reach it.
/// Case-folded because Windows and macOS are: the same .rdbx spelled
/// two ways is one file there. On Linux two files differing only in
/// case would fold together — exporting one of them is a better
/// failure than exporting one of them twice.
fn path_key(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/").to_ascii_lowercase()
}

/// The XML can carry an absolute path, which must not be joined onto
/// the project folder. A Windows drive letter or UNC prefix is
/// absolute even when this code runs on Linux, where `is_absolute`
/// says otherwise.
fn looks_absolute(s: &str) -> bool {
    let b = s.as_bytes();
    s.starts_with('/')
        || s.starts_with('\\')
        || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\'))
}

/// Resolve a relative path against `base` one segment at a time,
/// falling back to a case-insensitive match when the exact spelling is
/// absent. Accepts either separator, since the XML is written on
/// Windows and may be read anywhere.
fn resolve_ci(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut cur = base.to_path_buf();
    for seg in rel.split(['/', '\\']).filter(|s| !s.is_empty() && *s != ".") {
        if seg == ".." {
            if !cur.pop() {
                return None;
            }
            continue;
        }
        let exact = cur.join(seg);
        if exact.exists() {
            cur = exact;
            continue;
        }
        let mut hit: Option<PathBuf> = None;
        if let Ok(it) = std::fs::read_dir(&cur) {
            for entry in it.flatten() {
                if entry.file_name().to_string_lossy().eq_ignore_ascii_case(seg) {
                    hit = Some(entry.path());
                    break;
                }
            }
        }
        cur = hit?;
    }
    Some(cur)
}

/// One file reference from the XML → an existing file on disk, or None.
fn resolve_ref(project_root: &Path, scans_root: &Path, r: &str) -> Option<PathBuf> {
    if looks_absolute(r) {
        let p = PathBuf::from(r.replace('\\', "/"));
        return p.is_file().then_some(p);
    }
    for base in [project_root, scans_root] {
        if let Some(p) = resolve_ci(base, r) {
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Record a path-looking string as a file reference. Anything ending in
/// a point-file extension is one; nothing else in a .rsp does.
fn push_point_ref(refs: &mut Vec<String>, raw: &str) {
    let t = raw.trim();
    // 4 KiB is longer than any real path and short enough that a
    // malformed .rsp cannot grow this list without bound.
    if t.is_empty() || t.len() > 4096 || refs.len() >= 512 {
        return;
    }
    let lower = t.to_ascii_lowercase();
    if !(lower.ends_with(".rdbx") || lower.ends_with(".rxp")) {
        return;
    }
    if !refs.iter().any(|r| r == t) {
        refs.push(t.to_string());
    }
}

/// Point files directly in `dir` — no recursion.
fn point_files_in(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(it) = std::fs::read_dir(dir) {
        for entry in it.flatten() {
            let p = entry.path();
            if p.is_file() && is_point_file(&p) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// Point files under `root`, breadth unbounded but depth and visited
/// entries capped. Symlinks are neither followed nor collected, which
/// is also what keeps a link loop from hanging the walk.
fn walk_point_files(root: &Path, max_depth: usize, budget: usize) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(it) = std::fs::read_dir(&dir) else { continue };
        for entry in it.flatten() {
            if seen >= budget {
                out.sort();
                return out;
            }
            seen += 1;
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() => {
                    if depth < max_depth {
                        stack.push((path, depth + 1));
                    }
                }
                Ok(t) if t.is_file() && is_point_file(&path) => out.push(path),
                _ => {}
            }
        }
    }
    out.sort();
    out
}

/// Every point file under the project root, indexed by lower-cased file
/// stem. Built once per import: the ladder's last rung looks a scan up
/// here, and the totals let the UI tell "no point files in this
/// project" apart from "they are somewhere else in it".
struct ProjectIndex {
    by_stem: HashMap<String, Vec<PathBuf>>,
    rdbx_total: usize,
    rxp_total: usize,
}

fn project_index(root: &Path) -> ProjectIndex {
    let mut by_stem: HashMap<String, Vec<PathBuf>> = HashMap::new();
    let (mut rdbx_total, mut rxp_total) = (0usize, 0usize);
    for p in walk_point_files(root, WALK_MAX_DEPTH, WALK_BUDGET) {
        if ext_is(&p, "rdbx") {
            rdbx_total += 1;
        } else {
            rxp_total += 1;
        }
        if let Some(stem) = stem_lc(&p) {
            by_stem.entry(stem).or_default().push(p);
        }
    }
    ProjectIndex { by_stem, rdbx_total, rxp_total }
}

/// What one scan position's search turned up.
#[derive(Default, Clone)]
struct PositionFiles {
    rdbx: Vec<PathBuf>,
    rxp: Vec<PathBuf>,
    /// The directories actually looked in. Quoted back in the export
    /// error: "no .rdbx found" without saying where it looked is what
    /// made this take a screenshot to diagnose.
    searched: Vec<PathBuf>,
}

/// Keep only candidates whose stem the XML named for this position —
/// unless none of them match, in which case the directory's contents
/// are all the evidence there is.
fn prefer_named(cands: Vec<PathBuf>, stems: &HashSet<String>) -> Vec<PathBuf> {
    if stems.is_empty() {
        return cands;
    }
    let named: Vec<PathBuf> = cands
        .iter()
        .filter(|p| stem_lc(p).map(|s| stems.contains(&s)).unwrap_or(false))
        .cloned()
        .collect();
    if named.is_empty() { cands } else { named }
}

fn dedupe_paths(v: &mut Vec<PathBuf>) {
    let mut seen: HashSet<String> = HashSet::new();
    v.retain(|p| seen.insert(path_key(p)));
    v.sort();
}

fn push_unique_dir(dirs: &mut Vec<PathBuf>, d: PathBuf) {
    let key = path_key(&d);
    if !dirs.iter().any(|x| path_key(x) == key) {
        dirs.push(d);
    }
}

/// The ladder described at the top of this section, for one position.
/// `claimed` carries the paths earlier positions took, so the
/// project-wide rung cannot hand the same file to two positions.
fn discover_position_files(
    project_root: &Path,
    scans_root: &Path,
    sp: &ParsedScanPosition,
    index: &ProjectIndex,
    claimed: &mut HashSet<String>,
) -> PositionFiles {
    let mut files = PositionFiles::default();
    let stems: HashSet<String> = sp
        .refs
        .iter()
        .filter_map(|r| stem_lc(Path::new(&r.replace('\\', "/"))))
        .collect();

    // Rung 1 — the files the XML names.
    let named: Vec<PathBuf> = sp
        .refs
        .iter()
        .filter_map(|r| resolve_ref(project_root, scans_root, r))
        .collect();

    // Rung 2 — their directories, plus the conventional layout.
    let mut dirs: Vec<PathBuf> = Vec::new();
    for p in &named {
        if let Some(d) = p.parent() {
            push_unique_dir(&mut dirs, d.to_path_buf());
        }
    }
    let pos_dir = resolve_ci(scans_root, &sp.name);
    if let Some(pd) = &pos_dir {
        if let Some(sd) = resolve_ci(pd, "SINGLESCANS") {
            push_unique_dir(&mut dirs, sd);
        }
        push_unique_dir(&mut dirs, pd.clone());
    }
    let mut cands: Vec<PathBuf> = named.clone();
    for d in &dirs {
        files.searched.push(d.clone());
        cands.extend(point_files_in(d));
    }
    dedupe_paths(&mut cands);
    files.rdbx = prefer_named(cands.iter().filter(|p| ext_is(p, "rdbx")).cloned().collect(), &stems);
    files.rxp = prefer_named(cands.iter().filter(|p| ext_is(p, "rxp")).cloned().collect(), &stems);

    // Rung 3 — the position's own folder, however it nests inside.
    if files.rdbx.is_empty() {
        if let Some(pd) = &pos_dir {
            let walked = walk_point_files(pd, 4, WALK_BUDGET);
            files.searched.push(pd.join("**"));
            files.rdbx =
                prefer_named(walked.iter().filter(|p| ext_is(p, "rdbx")).cloned().collect(), &stems);
            if files.rxp.is_empty() {
                files.rxp =
                    prefer_named(walked.iter().filter(|p| ext_is(p, "rxp")).cloned().collect(), &stems);
            }
        }
    }

    // Rung 4 — anywhere in the project, matched by scan name.
    if files.rdbx.is_empty() {
        let mut hits: Vec<PathBuf> = Vec::new();
        for stem in &stems {
            for p in index.by_stem.get(stem).map(|v| v.as_slice()).unwrap_or(&[]) {
                if ext_is(p, "rdbx") && !claimed.contains(&path_key(p)) {
                    hits.push(p.clone());
                }
            }
        }
        dedupe_paths(&mut hits);
        files.rdbx = hits;
    }

    for p in files.rdbx.iter().chain(files.rxp.iter()) {
        claimed.insert(path_key(p));
    }
    files
}

/// Discovery across a whole project: per-position files plus the tally
/// the UI reports.
struct Discovery {
    /// Parallel to the positions passed in.
    per_position: Vec<PositionFiles>,
    rdbx_in_project: usize,
    rxp_in_project: usize,
    rdbx_unassigned: usize,
}

fn discover_all(project_root: &Path, positions: &[ParsedScanPosition]) -> Discovery {
    let scans_root =
        resolve_ci(project_root, "SCANS").unwrap_or_else(|| project_root.join("SCANS"));
    let index = project_index(project_root);
    let mut claimed: HashSet<String> = HashSet::new();
    let per_position: Vec<PositionFiles> = positions
        .iter()
        .map(|sp| discover_position_files(project_root, &scans_root, sp, &index, &mut claimed))
        .collect();
    // Counted from `claimed` rather than from the sum of the lists, so
    // a file two positions both resolve to is not counted twice and
    // cannot make this number negative-by-saturation.
    let assigned = claimed
        .iter()
        .filter(|k| k.ends_with(".rdbx"))
        .count();
    Discovery {
        per_position,
        rdbx_in_project: index.rdbx_total,
        rxp_in_project: index.rxp_total,
        rdbx_unassigned: index.rdbx_total.saturating_sub(assigned),
    }
}

/// Re-run discovery for a project whose manifest carries no usable
/// paths — a v1 manifest, or one written before the files moved.
struct Rediscovered {
    by_name: HashMap<String, PositionFiles>,
    rdbx_in_project: usize,
    rxp_in_project: usize,
}

fn rediscover(source_root: &Path) -> Option<Rediscovered> {
    let (parsed, root) = match find_project_rsp(source_root) {
        Some(rsp) => {
            let root = rsp.parent().unwrap_or(source_root).to_path_buf();
            (parse_project_rsp(&rsp).ok()?, root)
        }
        None => (parse_scanner_proj(source_root).ok()?, source_root.to_path_buf()),
    };
    let found = discover_all(&root, &parsed.scan_positions);
    Some(Rediscovered {
        by_name: parsed
            .scan_positions
            .iter()
            .map(|sp| sp.name.clone())
            .zip(found.per_position)
            .collect(),
        rdbx_in_project: found.rdbx_in_project,
        rxp_in_project: found.rxp_in_project,
    })
}

/// The export's "nothing to read" error. It says how many point files
/// the project actually holds and which folders were searched, because
/// the previous wording ("positions with only .rxp line files need
/// RiVLib") asserted a diagnosis the code had not made and sent the
/// user looking for the wrong problem.
fn no_rdbx_message(
    summary: &RieglProjectSummary,
    selected: usize,
    fresh: Option<&Rediscovered>,
    mut searched: Vec<String>,
) -> String {
    let (rdbx, rxp) = match fresh {
        Some(r) => (r.rdbx_in_project, r.rxp_in_project),
        None => (summary.rdbx_in_project as usize, summary.rxp_in_project as usize),
    };
    let mut msg = format!(
        "No readable .rdbx for the {selected} selected scan position{}. \
         The project holds {rdbx} .rdbx and {rxp} .rxp file(s) in total.",
        if selected == 1 { "" } else { "s" },
    );
    if rdbx == 0 {
        msg.push_str(
            " .rxp scans need RIEGL's RiVLib, which no distributable build can link: export \
             them to E57 or LAS from RiSCAN PRO and use the E57 importer, or rebuild for your \
             own use with `--features rivlib`.",
        );
    } else {
        searched.sort();
        searched.dedup();
        searched.truncate(4);
        msg.push_str(&format!(
            " Those .rdbx could not be matched to the selected positions — searched: {}. \
             Please report those paths so the layout can be added.",
            if searched.is_empty() {
                "(no candidate folder resolved)".to_string()
            } else {
                searched.join(", ")
            },
        ));
    }
    msg
}

// --- scanner-side `.PROJ` projects ----------------------------------
//
// A RIEGL scanner writes its own project to its own storage, and it is
// not a RiSCAN PRO project: no `project.rsp`, no `SCANS/`, and no
// `.rdbx` anywhere. What it has is
//
//   <name>.PROJ/
//     project.json                     project metadata
//     scanpositions.kml / .cesium      per-position GNSS location
//     ScanPos001.SCNPOS/
//       final.pose                     the registered pose
//       240912_164924.pose             that scan's own pose
//       imu_relative.pose              IMU tilt, NOT a scan pose
//       scans/240912_164924.rxp        the measurement
//       scans/240912_164924.mon.rxp    low-rate monitor stream
//       scans/240912_164924.png        preview panorama
//
// Reading the folder, the JSON and the poses is ordinary data
// extraction and every build does it. The points are the problem:
// `.rxp` needs RiVLib, so a released build imports such a project,
// lists its positions with their poses, and can export nothing —
// which is still far better than the old answer, "doesn't look like a
// RiSCAN PRO / RiPROCESS project", for a folder that is unmistakably a
// RIEGL project. A build made with `--features rivlib` exports it.
//
// The pose files are read tolerantly rather than to a schema: RIEGL
// publishes none, this was written against one project's layout, and a
// parser that insists on a shape it inferred from a single example is
// how the `.rdbx` search got this wrong in the first place. Any 16
// numbers that form an affine transform are taken as the pose; when
// nothing does, the position gets the identity and says so, and the
// Co-registration panel is where the user fixes it.

/// The point files under one `ScanPosNNN.SCNPOS`, as paths relative to
/// the project root — the shape `discover_all`'s first rung wants.
///
/// `*.mon.rxp` is excluded here and in `is_point_file`: it is the
/// low-rate stream the scanner records for monitoring, the same scene
/// as its `.rxp` at a fraction of the points, and exporting both would
/// silently duplicate every surface.
fn scanner_point_refs(pos_dir: &Path, root: &Path) -> Vec<String> {
    let scans = resolve_ci(pos_dir, "scans").unwrap_or_else(|| pos_dir.join("scans"));
    let mut out: Vec<String> = Vec::new();
    for p in point_files_in(&scans) {
        let rel = p.strip_prefix(root).map(|r| r.to_path_buf()).unwrap_or(p);
        out.push(rel.to_string_lossy().into_owned());
    }
    out
}

/// `<name>.SCNPOS` directories, sorted by name — what makes a folder a
/// scanner-side project, and the order the positions were recorded in.
fn scnpos_dirs(root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(it) = std::fs::read_dir(root) {
        for entry in it.flatten() {
            let path = entry.path();
            if path.is_dir() && ext_is(&path, "scnpos") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// Every numeric literal in a text, in order.
///
/// Deliberately not a format: a `.pose` file could separate its
/// numbers with spaces, newlines, commas or brackets and label them
/// with anything. Non-numeric bytes become separators, so the labels
/// drop out and the numbers survive whatever the punctuation is.
fn numbers_in(text: &str) -> Vec<f64> {
    let cleaned: String = text
        .chars()
        .map(|c| if c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E') { c } else { ' ' })
        .collect();
    cleaned
        .split_whitespace()
        .filter_map(|t| t.parse::<f64>().ok())
        .filter(|v| v.is_finite())
        .collect()
}

/// Read a 4×4 pose out of a text file, or None when the file holds no
/// transform this code can recognise.
///
/// The same row-major / column-major check `parse_matrix` applies to a
/// .rsp matrix applies here, and for the same reason: getting it the
/// wrong way round does not fail, it rotates the scan and puts it at
/// the origin.
fn pose_from_file(path: &Path) -> Option<Vec<f64>> {
    let text = std::fs::read_to_string(path).ok()?;
    let nums = numbers_in(&text);
    if nums.len() < 16 {
        return None;
    }
    // A file that holds exactly one matrix is the common case; one that
    // holds more (a header count, a timestamp) still starts it
    // somewhere. Try each 16-number window until one is an affine
    // transform, so a leading scalar does not defeat the read.
    for start in 0..=(nums.len() - 16) {
        let window: Vec<String> = nums[start..start + 16].iter().map(|v| v.to_string()).collect();
        if let Some(m) = parse_matrix(&window.join(" ")) {
            return Some(m);
        }
    }
    None
}

/// What a JSON `.pose` file holds, said in one line.
///
/// A scanner's `final.pose` is not a matrix: it is a GNSS fix, the
/// inclination sensors' roll and pitch, and a heading — the *inputs*
/// RiSCAN PRO's registration consumes, not its result. And it is a
/// single-fix GNSS position: metre-scale, which is a placement rather
/// than a registration. Guessing a 4×4 out of it means guessing
/// RIEGL's rotation order, sign convention and angle units, and
/// getting any of those wrong tilts every scan by a plausible-looking
/// amount — the failure mode this whole importer has been about. So
/// the numbers are reported and not interpreted: the position keeps
/// the identity, and the note says what is in the file and where the
/// registration actually comes from.
///
/// Values are quoted with the file's own key names and no unit
/// claimed, because the file does not state one (`gyro_offset` and
/// `gyro_offset_degs` sit side by side in different units).
fn pose_note_from_json(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned())?;
    let num = |key: &str| v.get(key).and_then(|x| x.as_f64());
    let gnss = v.get("gnss");
    let gnss_num = |key: &str| gnss.and_then(|g| g.get(key)).and_then(|x| x.as_f64());

    let mut parts: Vec<String> = Vec::new();
    if let (Some(lat), Some(lon)) = (gnss_num("latitude"), gnss_num("longitude")) {
        let fix = gnss
            .and_then(|g| g.get("fixInfo"))
            .and_then(|x| x.as_str())
            .unwrap_or("GNSS");
        let acc = gnss_num("horizontalAccuracy")
            .map(|a| format!(", ±{a:.1} m horizontal"))
            .unwrap_or_default();
        parts.push(format!("{fix} fix at {lat:.6}, {lon:.6}{acc}"));
    }
    if let (Some(roll), Some(pitch)) = (num("roll"), num("pitch")) {
        let yaw = num("yaw").map(|y| format!(", yaw {y:.3}")).unwrap_or_default();
        parts.push(format!("roll {roll:.3}, pitch {pitch:.3}{yaw}"));
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "{name} holds {} — a GNSS placement and inclination, not a registration, so this \
         position sits at the origin until it is registered (Co-registration panel, or import \
         the project through RiSCAN PRO).",
        parts.join("; "),
    ))
}

/// The pose for one scan position, and which file it came from.
///
/// `final.pose` is the registered result and the one to use. A
/// per-scan `<timestamp>.pose` is the fallback. `imu_relative.pose` is
/// never used: it is the IMU's tilt relative to the scan, not the
/// position's place in the project, and taking it for one would tilt
/// every scan by a plausible-looking amount.
fn scanner_pose(pos_dir: &Path) -> (Vec<f64>, Option<String>, Option<String>) {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = resolve_ci(pos_dir, "final.pose") {
        candidates.push(p);
    }
    if let Ok(it) = std::fs::read_dir(pos_dir) {
        let mut others: Vec<PathBuf> = it
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && ext_is(p, "pose")
                    && !p
                        .file_name()
                        .map(|n| n.to_string_lossy().eq_ignore_ascii_case("imu_relative.pose"))
                        .unwrap_or(false)
            })
            .collect();
        others.sort();
        candidates.extend(others);
    }
    for path in &candidates {
        if let Some(m) = pose_from_file(path) {
            let from = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "pose".to_string());
            return (m, Some(from), None);
        }
    }
    // Nothing held a transform. Say what the files did hold instead —
    // for a scanner project that is a GNSS fix and inclination, and
    // the user needs to know that rather than just "identity".
    let note = candidates.iter().find_map(|p| pose_note_from_json(p));
    (IDENTITY_4X4.to_vec(), None, note)
}

const IDENTITY_4X4: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
];

/// Fish an EPSG code out of `project.json`.
///
/// The file's schema is RIEGL's and undocumented here, so this looks
/// for evidence rather than a field: any key whose name mentions EPSG
/// with a plausible code as its value, or a string like "EPSG:3067"
/// anywhere in it. No evidence means None — the user sets the CRS in
/// the Editor, which is the same thing that happens for a .RiSCAN
/// project that stores no code.
fn epsg_from_project_json(root: &Path) -> Option<u32> {
    let path = resolve_ci(root, "project.json")?;
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    fn plausible(n: u64) -> Option<u32> {
        // EPSG codes in use run from 2000 up; anything below is a
        // count, an index or a version number.
        (2000..=1_000_000).contains(&n).then_some(n as u32)
    }
    fn walk(v: &serde_json::Value) -> Option<u32> {
        match v {
            serde_json::Value::Object(map) => {
                for (k, val) in map {
                    let key_mentions_epsg = k.to_ascii_lowercase().contains("epsg");
                    if key_mentions_epsg {
                        if let Some(n) = val.as_u64().and_then(plausible) {
                            return Some(n);
                        }
                        if let Some(n) = val.as_str().and_then(|s| s.trim().parse::<u64>().ok()).and_then(plausible) {
                            return Some(n);
                        }
                    }
                    if let Some(found) = walk(val) {
                        return Some(found);
                    }
                }
                None
            }
            serde_json::Value::Array(items) => items.iter().find_map(walk),
            serde_json::Value::String(s) => {
                let lower = s.to_ascii_lowercase();
                let idx = lower.find("epsg")?;
                let digits: String = s[idx..]
                    .chars()
                    .skip_while(|c| !c.is_ascii_digit())
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                digits.parse::<u64>().ok().and_then(plausible)
            }
            _ => None,
        }
    }
    walk(&value)
}

/// Parse a scanner-side `.PROJ` into the same shape the .rsp parser
/// produces, so everything downstream — discovery, the manifest, the
/// UI, the export — is unchanged.
fn parse_scanner_proj(root: &Path) -> Result<ParsedProject, String> {
    let dirs = scnpos_dirs(root);
    if dirs.is_empty() {
        return Err(format!(
            "no *.SCNPOS scan-position folders under {}",
            root.display()
        ));
    }
    let mut out = ParsedProject { epsg: epsg_from_project_json(root), ..Default::default() };
    for dir in dirs {
        let name = dir
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        let (sop, pose_source, pose_note) = scanner_pose(&dir);
        out.scan_positions.push(ParsedScanPosition {
            name,
            sop,
            refs: scanner_point_refs(&dir, root),
            pose_source,
            pose_note,
        });
    }
    if out.scan_positions.is_empty() {
        return Err(format!("no readable scan positions under {}", root.display()));
    }
    Ok(out)
}

// --- manifest IO + helpers ------------------------------------------

fn write_manifest(dir: &Path, summary: &RieglProjectSummary) -> Result<(), String> {
    let m = Manifest { version: MANIFEST_VERSION, summary: summary.clone() };
    let bytes = serde_json::to_vec_pretty(&m).map_err(|e| format!("encode manifest: {e}"))?;
    let tmp = dir.join("manifest.json.tmp");
    {
        let mut f = File::create(&tmp).map_err(|e| format!("create manifest tmp: {e}"))?;
        f.write_all(&bytes).map_err(|e| format!("write manifest tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync manifest tmp: {e}"))?;
    }
    std::fs::rename(&tmp, dir.join("manifest.json")).map_err(|e| format!("rename manifest: {e}"))?;
    Ok(())
}

fn safe_folder_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    if s.is_empty() { s.push_str("riegl_project"); }
    s.truncate(80);
    s
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The SOP / POP matrices, which place every scan position in the
/// project frame. Reading one with the rows and columns the wrong way
/// round does not fail — it rotates the scan and zeroes its position.
#[cfg(test)]
mod riegl_tests {
    use super::*;

    /// A rigid transform written out column-major, the way project.rsp
    /// stores it: element (r, c) at index r + 4c.
    fn column_major(m: &[f64; 16]) -> String {
        let mut v = [0.0f64; 16];
        for r in 0..4 { for c in 0..4 { v[r + 4 * c] = m[r * 4 + c]; } }
        v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(" ")
    }

    /// 90° about Z with a translation — a shape where a transpose is
    /// unmistakable, unlike the identity.
    const SOP: [f64; 16] = [
        0.0, -1.0, 0.0, 100.0,
        1.0,  0.0, 0.0, 200.0,
        0.0,  0.0, 1.0,  50.0,
        0.0,  0.0, 0.0,   1.0,
    ];

    #[test]
    fn a_column_major_matrix_comes_back_row_major() {
        let m = parse_matrix(&column_major(&SOP)).expect("parse");
        for i in 0..16 {
            assert!((m[i] - SOP[i]).abs() < 1e-12, "element {i}: {} vs {}", m[i], SOP[i]);
        }
        // The scan position is where it should be, not at the origin.
        assert_eq!((m[3], m[7], m[11]), (100.0, 200.0, 50.0));
    }

    /// A writer that serialises row-major must not have its matrix
    /// transposed into nonsense. Transposing it would put the
    /// translation into the bottom row and leave the scan at (0, 0, 0).
    #[test]
    fn a_row_major_matrix_is_detected_and_left_alone() {
        let text = SOP.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(" ");
        let m = parse_matrix(&text).expect("parse");
        assert_eq!((m[3], m[7], m[11]), (100.0, 200.0, 50.0), "the scan lost its position");
        assert_eq!((m[12], m[13], m[14], m[15]), (0.0, 0.0, 0.0, 1.0));
    }

    /// Whichever way the file stores it, the answer is the same matrix.
    #[test]
    fn both_layouts_agree_on_the_transform() {
        let a = parse_matrix(&column_major(&SOP)).unwrap();
        let b = parse_matrix(&SOP.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(" ")).unwrap();
        for i in 0..16 { assert!((a[i] - b[i]).abs() < 1e-12, "element {i}"); }
    }

    /// The identity is symmetric, so it reads the same either way — the
    /// case a broken transpose passes, which is why it is not the only
    /// test here.
    #[test]
    fn the_identity_survives_either_reading() {
        let id = "1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1";
        let m = parse_matrix(id).expect("parse");
        for r in 0..4 { for c in 0..4 {
            let want = if r == c { 1.0 } else { 0.0 };
            assert!((m[r * 4 + c] - want).abs() < 1e-12);
        }}
    }

    /// Something that is not an affine transform in either layout must
    /// be refused rather than picked from and hoped over.
    #[test]
    fn a_matrix_that_is_no_transform_either_way_is_refused() {
        // Bottom row nonzero in both readings.
        assert!(parse_matrix("1 0 0 5 0 1 0 6 0 0 1 7 9 9 9 9").is_none());
        // Wrong element count.
        assert!(parse_matrix("1 0 0 0 0 1 0 0").is_none());
        assert!(parse_matrix("").is_none());
        // Non-numeric tokens are dropped, so this ends up short.
        assert!(parse_matrix("1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 one").is_none());
    }

    /// Whitespace in a .rsp element is whatever the writer felt like:
    /// newlines, tabs, runs of spaces.
    #[test]
    fn the_layout_of_the_whitespace_does_not_matter() {
        let text = "\n  0 1 0 0\n\t-1 0 0 0\n  0 0 1 0\n  100  200   50 1\n";
        let m = parse_matrix(text).expect("parse");
        assert_eq!((m[3], m[7], m[11]), (100.0, 200.0, 50.0));
    }

    // --- point-file discovery ---------------------------------------
    //
    // These exist because the importer shipped a single hardcoded probe
    // (SCANS/<name>/SINGLESCANS/*.rdbx, extension compared case-
    // sensitively, first match only) and a real forty-position RiSCAN
    // project with fifty .rdbx files in it reported ".rxp only" on
    // every row. Not one of the layouts below was covered.

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("pointcloudlabeler-riegl-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Create an empty file, parents included. Discovery only ever
    /// stats and lists, so the contents do not matter here.
    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        File::create(path).expect("create file");
    }

    fn pos(name: &str, refs: &[&str]) -> ParsedScanPosition {
        ParsedScanPosition {
            name: name.to_string(),
            sop: SOP.to_vec(),
            refs: refs.iter().map(|s| s.to_string()).collect(),
            pose_source: Some("project.rsp".to_string()),
            pose_note: None,
        }
    }

    fn names(paths: &[PathBuf]) -> Vec<String> {
        paths
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    /// The layout the old probe did handle. It has to keep working:
    /// everything below widens the search, and widening it is only
    /// safe if the conventional case is still found the same way.
    #[test]
    fn the_conventional_layout_is_still_found() {
        let root = tmpdir("conventional");
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_151948.rdbx"));
        let found = discover_all(&root, &[pos("ScanPos001", &[])]);
        assert_eq!(names(&found.per_position[0].rdbx), ["240423_151948.rdbx"]);
        assert_eq!(found.rdbx_in_project, 1);
        assert_eq!(found.rdbx_unassigned, 0);
    }

    /// The case this bug actually was: the XML still points at the
    /// `.rxp` a scan was recorded as, and the `.rdbx` converted from it
    /// sits next to it. Following only the XML reference finds an
    /// unreadable file and reports the position as ".rxp only" while
    /// the readable one is in the same folder.
    #[test]
    fn a_rdbx_beside_the_rxp_the_xml_names_is_found() {
        let root = tmpdir("sibling");
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_151948.rxp"));
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_151948.rdbx"));
        let found = discover_all(&root, &[pos("ScanPos001", &["SINGLESCANS/240423_151948.rxp"])]);
        let f = &found.per_position[0];
        assert_eq!(names(&f.rdbx), ["240423_151948.rdbx"]);
        // The .rxp is still reported — the UI says what it saw, and a
        // position with both is not a position with only lines.
        assert_eq!(names(&f.rxp), ["240423_151948.rxp"]);
    }

    /// `extension() == Some("rdbx")` made `.RDBX` invisible. Nothing
    /// about the format says which case a writer uses, and on Windows
    /// the filesystem does not care either way.
    #[test]
    fn an_uppercase_extension_is_not_invisible() {
        let root = tmpdir("upper");
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_151948.RDBX"));
        let found = discover_all(&root, &[pos("ScanPos001", &[])]);
        assert_eq!(names(&found.per_position[0].rdbx), ["240423_151948.RDBX"]);
    }

    /// A position scanned twice has two single scans. The old export
    /// took whichever one `read_dir` yielded first and wrote half the
    /// points with nothing in the UI or the result saying so.
    #[test]
    fn both_scans_of_a_twice_scanned_position_are_returned() {
        let root = tmpdir("two-scans");
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_151948.rdbx"));
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_153228.rdbx"));
        let found = discover_all(
            &root,
            &[pos(
                "ScanPos001",
                &["SINGLESCANS/240423_151948.rxp", "SINGLESCANS/240423_153228.rxp"],
            )],
        );
        assert_eq!(
            names(&found.per_position[0].rdbx),
            ["240423_151948.rdbx", "240423_153228.rdbx"]
        );
    }

    /// Widening the search must not start exporting the same points
    /// twice. A thinned or otherwise derived copy in the same folder is
    /// not a scan the project names, and the named ones win.
    #[test]
    fn a_derived_copy_in_the_same_folder_is_not_exported_too() {
        let root = tmpdir("derived");
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_151948.rdbx"));
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_151948_thinned.rdbx"));
        let found = discover_all(&root, &[pos("ScanPos001", &["SINGLESCANS/240423_151948.rxp"])]);
        assert_eq!(names(&found.per_position[0].rdbx), ["240423_151948.rdbx"]);
        // The copy is still in the project, and the tally says so
        // rather than pretending the folder held one file.
        assert_eq!(found.rdbx_in_project, 2);
        assert_eq!(found.rdbx_unassigned, 1);
    }

    /// Nothing guarantees the .rdbx is under the position's folder at
    /// all. RIEGL names a single scan by its timestamp, so the stem
    /// identifies the scan wherever the file ended up.
    #[test]
    fn a_rdbx_elsewhere_in_the_project_is_matched_by_scan_name() {
        let root = tmpdir("elsewhere");
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_151948.rxp"));
        touch(&root.join("RDB/240423_151948.rdbx"));
        let found = discover_all(&root, &[pos("ScanPos001", &["SINGLESCANS/240423_151948.rxp"])]);
        assert_eq!(names(&found.per_position[0].rdbx), ["240423_151948.rdbx"]);
        assert_eq!(found.rdbx_unassigned, 0);
    }

    /// The project-wide rung matches by name, so two positions naming
    /// the same scan could both claim one file and export it twice.
    /// The first claim wins and the second position comes back empty —
    /// visibly wrong in the UI, rather than quietly doubled in the LAS.
    #[test]
    fn one_file_is_never_handed_to_two_positions() {
        let root = tmpdir("claimed");
        touch(&root.join("RDB/240423_151948.rdbx"));
        // Neither position has a folder of its own, so only the
        // project-wide rung can match, and both name the same stem.
        let found = discover_all(
            &root,
            &[
                pos("ScanPos001", &["SINGLESCANS/240423_151948.rxp"]),
                pos("ScanPos002", &["SINGLESCANS/240423_151948.rxp"]),
            ],
        );
        assert_eq!(names(&found.per_position[0].rdbx), ["240423_151948.rdbx"]);
        assert!(found.per_position[1].rdbx.is_empty());
    }

    /// A genuinely .rxp-only project. The point of the tally: the
    /// answer "this project has no .rdbx anywhere" is what tells the
    /// user to go back to RiSCAN PRO, and it is a different answer from
    /// "they are somewhere this importer did not look".
    #[test]
    fn a_project_with_only_lines_reports_no_rdbx_anywhere() {
        let root = tmpdir("lines-only");
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_151948.rxp"));
        touch(&root.join("SCANS/ScanPos002/SINGLESCANS/240423_153228.rxp"));
        let found = discover_all(&root, &[pos("ScanPos001", &[]), pos("ScanPos002", &[])]);
        assert!(found.per_position.iter().all(|f| f.rdbx.is_empty()));
        assert_eq!(found.rxp_in_project, 2);
        assert_eq!(found.rdbx_in_project, 0);
        assert_eq!(found.per_position[0].rxp.len(), 1);
    }

    /// The XML is written on Windows, where `singlescans` and
    /// `SINGLESCANS` name the same folder. On Linux they do not, and
    /// following the XML's spelling literally finds nothing.
    #[test]
    fn the_xml_spelling_of_a_folder_need_not_match_the_disk() {
        let root = tmpdir("case-path");
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_151948.rdbx"));
        let found = discover_all(
            &root,
            &[pos("ScanPos001", &["scans\\scanpos001\\singlescans\\240423_151948.rdbx"])],
        );
        assert_eq!(names(&found.per_position[0].rdbx), ["240423_151948.rdbx"]);
    }

    /// An absolute reference is used as it stands. Joining it onto the
    /// project folder produces a path that cannot exist, and the
    /// position then looks empty for a reason no message would explain.
    #[test]
    fn an_absolute_reference_is_not_joined_onto_the_project() {
        let root = tmpdir("absolute");
        let outside = tmpdir("absolute-outside");
        let scan = outside.join("240423_151948.rdbx");
        touch(&scan);
        std::fs::create_dir_all(root.join("SCANS/ScanPos001")).expect("mkdir");
        let found = discover_all(
            &root,
            &[pos("ScanPos001", &[&scan.to_string_lossy().into_owned()])],
        );
        assert_eq!(found.per_position[0].rdbx, vec![scan]);
        // It lives outside the project, so the project-wide tally does
        // not see it and the unassigned count cannot go negative.
        assert_eq!(found.rdbx_in_project, 0);
        assert_eq!(found.rdbx_unassigned, 0);
    }

    /// Windows drive letters and UNC paths are absolute wherever this
    /// runs; `Path::is_absolute` only agrees on Windows.
    #[test]
    fn windows_paths_are_recognised_as_absolute_everywhere() {
        assert!(looks_absolute("D:\\EVO\\Evo_2024_Riscan\\p.RiSCAN\\SCANS"));
        assert!(looks_absolute("d:/EVO/p.RiSCAN"));
        assert!(looks_absolute("\\\\server\\share\\p.RiSCAN"));
        assert!(looks_absolute("/mnt/scans/p.RiSCAN"));
        assert!(!looks_absolute("SINGLESCANS/240423_151948.rxp"));
        assert!(!looks_absolute("./SINGLESCANS/240423_151948.rxp"));
    }

    /// Only point files are file references. A .rsp is full of other
    /// text — names, timestamps, matrices, image paths.
    #[test]
    fn only_point_file_paths_are_taken_as_references() {
        let mut refs: Vec<String> = Vec::new();
        push_point_ref(&mut refs, "  SINGLESCANS/240423_151948.rxp  ");
        push_point_ref(&mut refs, "SINGLESCANS/240423_151948.RDBX");
        push_point_ref(&mut refs, "SCANPOSIMAGES/240423_151948.jpg");
        push_point_ref(&mut refs, "ScanPos001");
        push_point_ref(&mut refs, "");
        // Trimmed, deduplicated, order preserved.
        push_point_ref(&mut refs, "SINGLESCANS/240423_151948.rxp");
        assert_eq!(
            refs,
            [
                "SINGLESCANS/240423_151948.rxp".to_string(),
                "SINGLESCANS/240423_151948.RDBX".to_string()
            ]
        );
    }

    /// `BytesText::unescape` did decode AND entity-unescape in one call;
    /// quick-xml 0.41 splits those, and taking only the decode half is
    /// a silent wrong answer rather than an error — a scan position
    /// called "Plot 3 & 4" would come back as "Plot 3 &amp; 4" and then
    /// be written into the manifest, matched against a folder name, and
    /// shown to the user under that name.
    ///
    /// The version bump this pins was for security (RUSTSEC-2026-0194),
    /// so it is the kind of change nobody re-reads for meaning.
    #[test]
    fn an_entity_in_a_name_is_unescaped() {
        let dir = tmpdir("rsp-entity");
        let rsp = dir.join("project.rsp");
        std::fs::write(
            &rsp,
            format!(
                r#"<?xml version="1.0"?>
<project>
  <scanpositions>
    <scanposition>
      <name>Plot 3 &amp; 4 &lt;north&gt;</name>
      <sop><matrix>{m}</matrix></sop>
    </scanposition>
  </scanpositions>
</project>
"#,
                m = column_major(&SOP)
            ),
        )
        .expect("write rsp");

        let parsed = parse_project_rsp(&rsp).expect("parse");
        assert_eq!(parsed.scan_positions.len(), 1);
        assert_eq!(
            parsed.scan_positions[0].name, "Plot 3 & 4 <north>",
            "entities survived into the name — decode without unescape"
        );
    }

    /// The parser has to pick up a scan's file wherever the .rsp puts
    /// it — a `<file>` element, some other element name, or an
    /// attribute on a self-closing tag, which never reaches the Start
    /// arm at all. RIEGL publishes no XSD, so guessing one element
    /// name and finding nothing is the failure mode to avoid.
    #[test]
    fn file_references_are_read_from_elements_and_attributes() {
        let dir = tmpdir("rsp-parse");
        let rsp = dir.join("project.rsp");
        std::fs::write(
            &rsp,
            format!(
                r#"<?xml version="1.0"?>
<project>
  <pop><matrix>{m}</matrix></pop>
  <scanpositions>
    <scanposition>
      <name>ScanPos001</name>
      <sop><matrix>{m}</matrix></sop>
      <singlescans>
        <scan><name>240423_151948</name><file>SINGLESCANS/240423_151948.rxp</file></scan>
        <scan name="240423_153228" file="SINGLESCANS/240423_153228.rdbx"/>
      </singlescans>
      <scanposimages>
        <scanposimage><file>SCANPOSIMAGES/240423_151948.jpg</file></scanposimage>
      </scanposimages>
    </scanposition>
  </scanpositions>
</project>
"#,
                m = column_major(&SOP)
            ),
        )
        .expect("write rsp");

        let parsed = parse_project_rsp(&rsp).expect("parse");
        assert_eq!(parsed.scan_positions.len(), 1);
        let sp = &parsed.scan_positions[0];
        assert_eq!(sp.name, "ScanPos001");
        assert_eq!((sp.sop[3], sp.sop[7], sp.sop[11]), (100.0, 200.0, 50.0));
        assert_eq!(
            sp.refs,
            [
                "SINGLESCANS/240423_151948.rxp".to_string(),
                "SINGLESCANS/240423_153228.rdbx".to_string()
            ],
            "a scan's file must be found in an element or an attribute"
        );
        // The POP is the project's, not the position's — the guards in
        // the matrix arm still hold with refs being collected.
        assert!(parsed.pop.is_some());
    }

    /// End to end on the shape the screenshot showed: forty positions,
    /// each with lines the XML names and a converted .rdbx beside them.
    /// Before the ladder this reported forty ".rxp only" rows.
    #[test]
    fn a_forty_position_project_finds_every_scan() {
        let root = tmpdir("forty");
        let mut positions: Vec<ParsedScanPosition> = Vec::new();
        let mut refs_owned: Vec<Vec<String>> = Vec::new();
        for i in 1..=40u32 {
            let name = format!("ScanPos{i:03}");
            let stem = format!("240423_15{i:04}");
            touch(&root.join(format!("SCANS/{name}/SINGLESCANS/{stem}.rxp")));
            touch(&root.join(format!("SCANS/{name}/SINGLESCANS/{stem}.rdbx")));
            refs_owned.push(vec![format!("SINGLESCANS/{stem}.rxp")]);
            positions.push(ParsedScanPosition {
                name,
                sop: SOP.to_vec(),
                refs: refs_owned.last().unwrap().clone(),
                pose_source: Some("project.rsp".to_string()),
                pose_note: None,
            });
        }
        let found = discover_all(&root, &positions);
        assert_eq!(found.rdbx_in_project, 40);
        assert_eq!(found.rxp_in_project, 40);
        assert_eq!(found.rdbx_unassigned, 0);
        assert!(
            found.per_position.iter().all(|f| f.rdbx.len() == 1),
            "every position should have found exactly its own .rdbx"
        );
    }

    // --- scanner-side `.PROJ` projects ------------------------------
    //
    // Layout taken from a real VZ-series project rather than invented:
    // ScanPosNNN.SCNPOS holding final.pose, a per-scan .pose,
    // imu_relative.pose and scans/ with the .rxp, its .mon.rxp monitor
    // stream and a .png preview.

    /// Write the pose as a row-major 4×4 over four lines, the way a
    /// text matrix is normally laid out.
    fn row_major_lines(m: &[f64; 16]) -> String {
        (0..4)
            .map(|r| {
                (0..4)
                    .map(|c| m[r * 4 + c].to_string())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn scanner_project(dir: &Path, positions: &[(&str, &str)]) {
        for (pos, stem) in positions {
            let sp = dir.join(format!("{pos}.SCNPOS"));
            touch(&sp.join(".created"));
            std::fs::write(sp.join("final.pose"), row_major_lines(&SOP)).expect("write pose");
            std::fs::write(sp.join(format!("{stem}.pose")), row_major_lines(&SOP)).expect("write pose");
            std::fs::write(sp.join("imu_relative.pose"), row_major_lines(&SOP)).expect("write pose");
            touch(&sp.join("tpl_scan.input"));
            touch(&sp.join(format!("{stem}.tpl")));
            touch(&sp.join(format!("scans/{stem}.rxp")));
            touch(&sp.join(format!("scans/{stem}.mon.rxp")));
            touch(&sp.join(format!("scans/{stem}.png")));
            touch(&sp.join(format!("scans/{stem}.scn")));
        }
        touch(&dir.join("project.log"));
        touch(&dir.join("scanpositions.kml"));
    }

    /// The folder the previous importer rejected outright with "doesn't
    /// look like a RiSCAN PRO / RiPROCESS project" — for a folder that
    /// is unmistakably a RIEGL project.
    #[test]
    fn a_scanner_proj_imports_its_scan_positions() {
        let root = tmpdir("scnpos");
        scanner_project(&root, &[("ScanPos001", "240912_164924"), ("ScanPos002", "240912_165145")]);
        std::fs::write(root.join("project.json"), r#"{"crs": {"epsg": 3067}}"#).expect("write json");

        let parsed = parse_scanner_proj(&root).expect("parse scanner project");
        assert_eq!(parsed.scan_positions.len(), 2);
        assert_eq!(parsed.epsg, Some(3067));

        let sp = &parsed.scan_positions[0];
        assert_eq!(sp.name, "ScanPos001");
        assert_eq!(sp.pose_source.as_deref(), Some("final.pose"));
        assert_eq!((sp.sop[3], sp.sop[7], sp.sop[11]), (100.0, 200.0, 50.0));
        // The .rxp is a scan; the monitor stream, the preview and the
        // tie-point files are not.
        assert_eq!(sp.refs.len(), 1, "refs: {:?}", sp.refs);
        assert!(sp.refs[0].to_ascii_lowercase().ends_with("240912_164924.rxp"));
        assert!(!sp.refs[0].to_ascii_lowercase().contains(".mon."));

        // …and discovery finds the same file through the ladder.
        let found = discover_all(&root, &parsed.scan_positions);
        assert_eq!(found.rdbx_in_project, 0);
        assert_eq!(found.rxp_in_project, 2, "one scan per position, monitor streams excluded");
        assert!(found.per_position.iter().all(|f| f.rdbx.is_empty()));
        assert_eq!(found.per_position[1].rxp.len(), 1);
    }

    /// `*.mon.rxp` is the same scene at a fraction of the points.
    /// Counting it as a scan would duplicate every surface in an
    /// export and inflate the project tally.
    #[test]
    fn the_monitor_stream_is_not_a_scan() {
        assert!(is_monitor_stream(Path::new("/p/scans/240912_164924.mon.rxp")));
        assert!(is_monitor_stream(Path::new(r"D:\p\scans\240912_164924.MON.RXP")));
        assert!(!is_monitor_stream(Path::new("/p/scans/240912_164924.rxp")));
        assert!(!is_point_file(Path::new("/p/scans/240912_164924.mon.rxp")));
        assert!(is_point_file(Path::new("/p/scans/240912_164924.rxp")));
    }

    /// `imu_relative.pose` is the IMU's tilt relative to the scan, not
    /// the position's place in the project. Taking it for one would
    /// tilt every scan by a plausible-looking amount — the kind of
    /// wrong that does not look wrong.
    #[test]
    fn the_imu_pose_is_never_taken_for_a_scan_pose() {
        let root = tmpdir("imu-only");
        let sp = root.join("ScanPos001.SCNPOS");
        std::fs::create_dir_all(sp.join("scans")).expect("mkdir");
        std::fs::write(sp.join("imu_relative.pose"), row_major_lines(&SOP)).expect("write pose");
        touch(&sp.join("scans/240912_164924.rxp"));

        let parsed = parse_scanner_proj(&root).expect("parse");
        let p = &parsed.scan_positions[0];
        assert_eq!(p.pose_source, None, "the IMU file must not be used as a pose");
        // Identity, and the manifest says the pose is unknown so the UI
        // can too — rather than a scan confidently placed at the origin.
        assert_eq!((p.sop[3], p.sop[7], p.sop[11]), (0.0, 0.0, 0.0));
        assert_eq!(p.sop[0], 1.0);
    }

    /// The pose file's punctuation is not a format. RIEGL publishes no
    /// schema for it, this was written against one project, and a
    /// parser that insists on the shape it inferred from one example
    /// is exactly how the .rdbx search went wrong.
    #[test]
    fn a_pose_file_is_read_whatever_its_punctuation() {
        let dir = tmpdir("pose-shapes");
        let want = (100.0, 200.0, 50.0);

        let commas = dir.join("commas.pose");
        std::fs::write(
            &commas,
            "matrix = [\n 0.0, -1.0, 0.0, 100.0,\n 1.0, 0.0, 0.0, 200.0,\n \
             0.0, 0.0, 1.0, 50.0,\n 0.0, 0.0, 0.0, 1.0 ]\n",
        )
        .expect("write");
        let m = pose_from_file(&commas).expect("commas and brackets");
        assert_eq!((m[3], m[7], m[11]), want);

        // A leading scalar (a count, a version, a timestamp) must not
        // shift the matrix out of reach.
        let prefixed = dir.join("prefixed.pose");
        std::fs::write(&prefixed, format!("1\n{}", row_major_lines(&SOP))).expect("write");
        let m = pose_from_file(&prefixed).expect("a leading scalar");
        assert_eq!((m[3], m[7], m[11]), want);

        // Column-major is detected and transposed, the same way a .rsp
        // matrix is — getting this backwards leaves the scan rotated at
        // the origin instead of failing.
        let colmajor = dir.join("colmajor.pose");
        std::fs::write(&colmajor, column_major(&SOP)).expect("write");
        let m = pose_from_file(&colmajor).expect("column-major");
        assert_eq!((m[3], m[7], m[11]), want);
    }

    /// Something that is not a transform must leave the identity and
    /// say the pose is unknown, not half-read one.
    #[test]
    fn a_pose_file_with_no_transform_is_refused() {
        let dir = tmpdir("pose-junk");
        let junk = dir.join("junk.pose");
        std::fs::write(&junk, "scan quality: good\nrecorded 2024-09-12 16:49:24\n").expect("write");
        assert!(pose_from_file(&junk).is_none());
        let short = dir.join("short.pose");
        std::fs::write(&short, "1 0 0 0 0 1 0 0").expect("write");
        assert!(pose_from_file(&short).is_none());
    }

    /// project.json's schema is RIEGL's and undocumented here, so the
    /// EPSG read looks for evidence and settles for None. A number that
    /// is not a CRS code must not be taken for one.
    #[test]
    fn an_epsg_is_taken_from_project_json_only_on_evidence() {
        let dir = tmpdir("proj-json");
        let write = |body: &str| {
            std::fs::write(dir.join("project.json"), body).expect("write json");
            epsg_from_project_json(&dir)
        };
        assert_eq!(write(r#"{"crs": {"epsg": 3067}}"#), Some(3067));
        assert_eq!(write(r#"{"coordinateSystem": "EPSG:3067 / TM35FIN"}"#), Some(3067));
        assert_eq!(write(r#"{"srs": {"epsgCode": "32635"}}"#), Some(32635));
        assert_eq!(write(r#"{"positions": [{"meta": {"EPSG": 4326}}]}"#), Some(4326));
        // A version, a count, an index: not a CRS.
        assert_eq!(write(r#"{"version": 3, "scanCount": 40}"#), None);
        assert_eq!(write(r#"{"epsg": 2}"#), None, "2 is not a plausible EPSG code");
        assert_eq!(write("not json at all"), None);
    }


    /// RiSCAN PRO 2.x converts a scanner's `.rxp` into a `.rdbx` and
    /// stores it under the scan position's `POINTCLOUDS/`, while the
    /// project XML goes on naming the `.rxp` in `SINGLESCANS/`. That is
    /// the layout the original bug report was: forty positions, fifty
    /// `.rdbx` on disk, and an importer that probed `SINGLESCANS/` for
    /// `.rdbx`, found none and called every row ".rxp only".
    #[test]
    fn the_riscan_2x_layout_keeps_converted_scans_in_pointclouds() {
        let root = tmpdir("pointclouds-dir");
        touch(&root.join("SCANS/ScanPos001/SINGLESCANS/240423_143921.rxp"));
        touch(&root.join("SCANS/ScanPos001/POINTCLOUDS/240423_143921.rdbx"));
        // The XML names the .rxp — the .rdbx is nowhere in it.
        let found = discover_all(&root, &[pos("ScanPos001", &["240423_143921.rxp"])]);
        let f = &found.per_position[0];
        assert_eq!(names(&f.rdbx), ["240423_143921.rdbx"], "the converted scan must be found");
        assert_eq!(names(&f.rxp), ["240423_143921.rxp"]);
        assert_eq!(found.rdbx_unassigned, 0);
    }

    /// A scanner's `final.pose` is JSON: a GNSS fix, the inclination
    /// sensors' roll and pitch, and a heading. It is not a matrix, and
    /// the tolerant reader must not manufacture one out of 80-odd
    /// unrelated numbers — a pose assembled from a barometer reading
    /// and a gyro offset would place the scan somewhere specific and
    /// wrong.
    ///
    /// Key names and value shapes here match a real VZ-400i file; the
    /// values are made up.
    #[test]
    fn a_json_pose_is_reported_and_not_interpreted() {
        let root = tmpdir("json-pose");
        let sp = root.join("ScanPos001.SCNPOS");
        std::fs::create_dir_all(sp.join("scans")).expect("mkdir");
        touch(&sp.join("scans/240912_164924.rxp"));
        std::fs::write(
            sp.join("final.pose"),
            r#"{
                "barometric_amsl": 124.54045906126498,
                "dm": [-1.6331333336741422e-08, -6.9130397693025902e-08, 628.31819619966473],
                "gnss": {
                    "altitude": 186.98330688476562,
                    "coordinateSystem": "EPSG::4979",
                    "fix": 1,
                    "fixInfo": "Single",
                    "horizontalAccuracy": 1.7393999099731445,
                    "latitude": 62.599566515999996,
                    "longitude": 31.182213294999997,
                    "numSatellites": 17
                },
                "gyro_offset": [-30.337890625, -69.1279296875, -77.755859375],
                "ku": [0, 0, 0],
                "ku_conf": [0, 0, 0],
                "mode": "static",
                "pitch": -0.27143296205355327,
                "roll": -0.83583201620020942,
                "sscale": 0.99999999999999889,
                "uscale": 1,
                "yaw": 4.4624664683139548
            }"#,
        )
        .expect("write pose");

        // Not a transform, and not mistaken for one.
        assert!(pose_from_file(&sp.join("final.pose")).is_none());

        let parsed = parse_scanner_proj(&root).expect("parse");
        let p = &parsed.scan_positions[0];
        assert_eq!(p.pose_source, None, "a GNSS fix is not a pose source");
        assert_eq!((p.sop[3], p.sop[7], p.sop[11]), (0.0, 0.0, 0.0), "identity, not a guess");

        // …but the row can explain itself: what the file holds, and
        // where a registration actually comes from.
        let note = p.pose_note.as_deref().expect("a note about what final.pose holds");
        assert!(note.contains("final.pose"), "{note}");
        assert!(note.contains("Single fix"), "{note}");
        assert!(note.contains("62.5995"), "{note}");
        assert!(note.contains("±1.7 m"), "{note}");
        assert!(note.contains("not a registration"), "{note}");
        assert!(note.contains("Co-registration"), "{note}");
    }

    /// Every manifest field added since v1 has a serde default, so a
    /// project registered by an older build still lists and still
    /// exports — it just re-runs discovery because it cached no paths.
    /// Existing users' `manifest.json` files are the one thing in this
    /// module that cannot be re-tested by hand.
    #[test]
    fn a_v1_manifest_still_deserialises() {
        let v1 = r#"{
            "version": 1,
            "summary": {
                "id": "MyPlot",
                "sourcePath": "D:\\EVO\\MyPlot.RiSCAN",
                "name": "MyPlot",
                "epsg": 3067,
                "pop": null,
                "scanPositions": [
                    {
                        "id": "sp_000",
                        "name": "ScanPos001",
                        "sop": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
                        "pointCount": null,
                        "centre": null,
                        "hasRdbx": true
                    }
                ],
                "updatedAt": 1715000000000
            }
        }"#;
        let m: Manifest = serde_json::from_str(v1).expect("a v1 manifest must still load");
        assert_eq!(m.version, 1);
        let sp = &m.summary.scan_positions[0];
        assert!(sp.has_rdbx);
        // No cached paths: the export re-runs discovery rather than
        // reporting an empty selection.
        assert!(sp.rdbx_paths.is_empty());
        assert!(sp.rxp_paths.is_empty());
        assert_eq!(sp.rxp_count, 0);
        assert_eq!(sp.pose_source, None);
        assert_eq!(sp.pose_note, None);
        // And the project reads as what it was.
        assert_eq!(m.summary.kind, ProjectKind::Riscan);
        assert_eq!(m.summary.rdbx_in_project, 0);
        assert_eq!(m.summary.rdbx_unassigned, 0);
    }
}
