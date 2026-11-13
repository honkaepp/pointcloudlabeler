// The forest pass over a dataset: wood / leaf, stems and trees
// (commands/forest) read from and written into octree.bin.
//
// * The working set is one point per occupied voxel of the non-ground
//   points standing `cut` metres or more above the ground (grass and
//   litter below would bridge every stem to every other). Its centroid,
//   its point count and, where the dataset has a Reflectance column (as
//   some TLS scanners write), its mean reflectance.
// * The expensive part — the graph, the shape, the flow, wood / leaf —
//   depends only on the points and the settings, so it is kept in memory
//   under a fingerprint of the working set: correcting the stems by hand
//   and re-cutting the trees reruns only the trees.
// * Every point gets its voxel's tree and label; points below the cut get
//   the tree whose stem they are part of (the stem foot), else none.
//   Ground keeps tree 0 and no label.
// * Beside the dataset, in `forest/`: seeds.json (the stems, in world
//   coordinates — what the seed editor reads and writes), trees.json (each
//   tree's base, height, radius and flags), suggestions.json (pairs that
//   may be one tree, with where to look) and report.json (what ran, how
//   long each stage took).

use std::fs::{File, OpenOptions};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use rustc_hash::FxHashMap;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{build_dtm_grid, emit_progress, extra_layout, layout_find, open_octree_meta, parse_export_patches, parse_remap, write_file_atomic};
use crate::commands::forest::pipeline::{prepare, segment, Params, Prepared};
use crate::commands::forest::stems::{bh_reach, refine_at_breast_height, Seed, BH_BAND};
use crate::commands::forest::instance::TieBranch;
use crate::commands::forest::{WorkSet, BRANCH, LEAF, STEM};
use crate::progress::Progress;

/// The settings of a run.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForestRequest {
    /// Voxel edge of the working set, metres (default 0.04).
    #[serde(default = "d_voxel")]
    pub voxel: f64,
    /// Points lower than this above the ground are left out of the graph
    /// (grass, litter), metres (default 0.25).
    #[serde(default = "d_cut")]
    pub cut: f64,
    /// Cell of the ground model the heights are measured from, metres.
    #[serde(default = "d_dtm")]
    pub dtm_cell: f64,
    /// Blend a Reflectance column (as some TLS scanners write) into the wood
    /// likelihood where the dataset has it (bark returns more than leaves).
    #[serde(default = "d_true")]
    pub use_reflectance: bool,
    /// Trees standing this close to the edge of the data are flagged.
    #[serde(default = "d_edge")]
    pub edge_buffer: f64,
    /// Trees lower than this are flagged understory, metres.
    #[serde(default = "d_under")]
    pub understory: f64,
    /// Grow the trees from the dataset's forest/seeds.json (the stems as
    /// corrected by hand) instead of finding the stems again.
    #[serde(default)]
    pub use_saved_seeds: bool,
    /// Write stem / branch / leaf into the semantic column as well.
    #[serde(default = "d_true")]
    pub write_semantic: bool,
}

fn d_voxel() -> f64 { 0.04 }
fn d_cut() -> f64 { 0.25 }
fn d_dtm() -> f64 { 0.5 }
fn d_true() -> bool { true }
fn d_edge() -> f64 { 2.0 }
fn d_under() -> f64 { 2.0 }

impl Default for ForestRequest {
    fn default() -> Self {
        ForestRequest {
            voxel: d_voxel(), cut: d_cut(), dtm_cell: d_dtm(), use_reflectance: true,
            edge_buffer: d_edge(), understory: d_under(), use_saved_seeds: false, write_semantic: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ForestResult {
    pub tree_count: u32,
    pub assigned_points: u64,
    pub stem_points: u64,
    pub branch_points: u64,
    pub leaf_points: u64,
    pub seeds: u32,
    pub seeds_without_circle: u32,
    /// Stems whose diameter at breast height was measured from the full
    /// points (the rest keep their voxel circles' radius).
    pub stems_measured: u32,
    pub merged: u32,
    pub suggestions: u32,
    pub edge_trees: u32,
    pub understory_trees: u32,
    pub working_points: u32,
    /// The graph, shape, flow and wood / leaf were reused from the last run.
    pub reused: bool,
    pub used_reflectance: bool,
    pub seconds: f64,
    pub timings: Vec<(String, f64)>,
}

/// The seeds file: world coordinates.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SeedsFile {
    pub version: u32,
    pub seeds: Vec<SeedJson>,
}

/// A seed in world coordinates (the file's and the editor's).
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SeedJson {
    pub id: u32,
    pub tree: u32,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub r: f64,
    pub lean: [f64; 2],
    pub top: f32,
    pub circles: u32,
    pub source: String,
}

impl SeedJson {
    fn from_seed(s: &Seed, off: [f64; 3]) -> SeedJson {
        SeedJson { id: s.id, tree: s.tree, x: s.x + off[0], y: s.y + off[1], z: s.z + off[2], r: s.r, lean: s.lean, top: s.top, circles: s.circles, source: s.source.clone() }
    }
    fn to_seed(&self, off: [f64; 3]) -> Seed {
        Seed { id: self.id, tree: self.tree, x: self.x - off[0], y: self.y - off[1], z: self.z - off[2], r: self.r, lean: self.lean, top: self.top, circles: self.circles, source: self.source.clone() }
    }
}

pub fn forest_dir(dir: &Path) -> std::path::PathBuf { dir.join("forest") }

/// The dataset's seeds, or none when the pass has not run.
pub fn read_seeds(dir: &Path) -> Result<Option<SeedsFile>, String> {
    let p = forest_dir(dir).join("seeds.json");
    match std::fs::read(&p) {
        Ok(b) => serde_json::from_slice(&b).map(Some).map_err(|e| format!("read seeds.json: {e}")),
        Err(_) => Ok(None),
    }
}

/// One of the files beside the dataset, by name: "trees", "suggestions",
/// "report", "seed_review" or "near_ties"; None before it is written.
pub fn read_file(dir: &Path, name: &str) -> Result<Option<serde_json::Value>, String> {
    if !matches!(name, "trees" | "suggestions" | "report" | "seed_review" | "near_ties") { return Err(format!("no forest file called {name}")); }
    match std::fs::read(forest_dir(dir).join(format!("{name}.json"))) {
        Ok(b) => serde_json::from_slice(&b).map(Some).map_err(|e| format!("read {name}.json: {e}")),
        Err(_) => Ok(None),
    }
}

/// The points of one near-tie branch (forest/near_ties.json, its voxels in
/// near_ties.bin) that are still its tree's — after the saved edits and the
/// merges — as (record, point indices in the record), for the editor to move
/// to the other tree as an edit of its own (undoable like any other).
pub fn branch_points(dir: &Path, id: u32) -> Result<Vec<(u32, Vec<u32>)>, String> {
    let list = read_file(dir, "near_ties")?.ok_or("no near ties here — run the forest pass")?;
    let voxel = list.get("voxel").and_then(|v| v.as_f64()).ok_or("near_ties.json: no voxel")?;
    let b = list.get("branches").and_then(|v| v.as_array())
        .and_then(|a| a.iter().find(|b| b.get("id").and_then(|v| v.as_u64()) == Some(id as u64)))
        .ok_or(format!("no near tie {id}"))?;
    let num = |k: &str| b.get(k).and_then(|v| v.as_u64()).ok_or(format!("near tie {id}: no {k}"));
    let (tree, first, count) = (num("tree")? as i32, num("first")? as usize, num("count")? as usize);
    let bin = std::fs::read(forest_dir(dir).join("near_ties.bin")).map_err(|e| format!("read near_ties.bin: {e}"))?;
    if bin.len() < (first + count) * 12 { return Err("near_ties.bin is shorter than its list".into()); }
    let i32_at = |o: usize| i32::from_le_bytes(bin[o..o + 4].try_into().unwrap());
    let keys: rustc_hash::FxHashSet<(i32, i32, i32)> =
        (first..first + count).map(|k| (i32_at(k * 12), i32_at(k * 12 + 4), i32_at(k * 12 + 8))).collect();
    let (_meta, scale, _offset, _b, point_bytes, _e) = open_octree_meta(dir)?;
    let hier = std::fs::read(dir.join("hierarchy.bin")).map_err(|e| format!("read hierarchy.bin: {e}"))?;
    let patches = parse_export_patches(&dir.join("patches.bin"))?;
    let remap = parse_remap(&dir.join("treemap.json"))?;
    let resolve = |t: i32| remap.get(&t).copied().unwrap_or(t);
    let want = resolve(tree);
    let inv = 1.0 / voxel;
    let mut out = Vec::new();
    let mut file = BufReader::with_capacity(4 * 1024 * 1024, File::open(dir.join("octree.bin")).map_err(|e| format!("open octree.bin: {e}"))?);
    let mut block: Vec<u8> = Vec::new();
    let mut cur_pos: u64 = 0;
    for rec_idx in 0..hier.len() / 24 {
        let h = &hier[rec_idx * 24..rec_idx * 24 + 24];
        let byte_offset = u64::from_le_bytes(h[8..16].try_into().unwrap());
        let byte_size = u64::from_le_bytes(h[16..24].try_into().unwrap()) as usize;
        if byte_size == 0 { continue; }
        block.resize(byte_size, 0);
        if byte_offset != cur_pos { file.seek(SeekFrom::Start(byte_offset)).map_err(|e| format!("seek octree.bin: {e}"))?; cur_pos = byte_offset; }
        file.read_exact(&mut block).map_err(|e| format!("read octree.bin block: {e}"))?;
        cur_pos += byte_size as u64;
        let mut pts = Vec::new();
        for p in 0..byte_size / point_bytes {
            let o = p * point_bytes;
            let mut t = i32::from_le_bytes(block[o + 12..o + 16].try_into().unwrap());
            if let Some(&(pt, _s, del)) = patches.get(&(rec_idx as u32, p as u32)) {
                if del == 1 { continue; }
                if pt >= 0 { t = pt; }
            }
            if resolve(t) != want { continue; }
            // the forest pass's own voxel key (point coordinates less the offset)
            let c = |k: usize| i32::from_le_bytes(block[o + 4 * k..o + 4 * k + 4].try_into().unwrap()) as f64 * scale[k];
            let key = ((c(0) * inv).floor() as i32, (c(1) * inv).floor() as i32, (c(2) * inv).floor() as i32);
            if keys.contains(&key) { pts.push(p as u32); }
        }
        if !pts.is_empty() { out.push((rec_idx as u32, pts)); }
    }
    Ok(out)
}

/// Save the stem review's marks (forest/seed_review.json): which stems the
/// user has looked at, kept by the editor, opaque here.
pub fn write_review(dir: &Path, review: &serde_json::Value) -> Result<(), String> {
    let fd = forest_dir(dir);
    std::fs::create_dir_all(&fd).map_err(|e| format!("create forest/: {e}"))?;
    let bytes = serde_json::to_vec_pretty(review).map_err(|e| format!("seed_review.json: {e}"))?;
    write_file_atomic(&fd.join("seed_review.json"), &bytes, "seed_review.json")
}

/// The breast-height circles onto the stems: radius, and the axis moved
/// onto the circle's centre there. A stem the user measured by hand in
/// the stem review (source "manual") keeps its own circle. How many were
/// applied.
fn apply_refits(seeds: &mut [Seed], refined: &[Option<(f64, f64, f64)>]) -> usize {
    let h_bh = (BH_BAND.0 + BH_BAND.1) * 0.5;
    let mut n = 0;
    for (s, f) in seeds.iter_mut().zip(refined) {
        if s.source == "manual" { continue; }
        if let Some((cx, cy, r)) = *f {
            let (ax, ay) = s.axis_at(h_bh);
            s.x += cx - ax;
            s.y += cy - ay;
            s.r = r;
            n += 1;
        }
    }
    n
}

/// Save the seeds (the editor's corrections).
pub fn write_seeds(dir: &Path, seeds: &SeedsFile) -> Result<(), String> {
    let fd = forest_dir(dir);
    std::fs::create_dir_all(&fd).map_err(|e| format!("create forest/: {e}"))?;
    let bytes = serde_json::to_vec_pretty(seeds).map_err(|e| format!("seeds.json: {e}"))?;
    write_file_atomic(&fd.join("seeds.json"), &bytes, "seeds.json")
}

struct Cached {
    key: u64,
    prep: Arc<Prepared>,
}

static CACHE: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();

/// A fingerprint of the working set and the settings the preparation reads.
fn fingerprint(dir: &str, ws: &WorkSet, req: &ForestRequest, refl: bool) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = rustc_hash::FxHasher::default();
    dir.hash(&mut h);
    ws.len().hash(&mut h);
    for v in [req.voxel, req.cut, req.dtm_cell] { v.to_bits().hash(&mut h); }
    refl.hash(&mut h);
    let mut acc = 0u64;
    for (i, q) in ws.p.iter().enumerate() {
        let k = (q[0] * 1000.0) as i64 as u64 ^ ((q[1] * 1000.0) as i64 as u64).rotate_left(21) ^ ((q[2] * 1000.0) as i64 as u64).rotate_left(42);
        acc = acc.wrapping_add(k.wrapping_mul(i as u64 | 1));
    }
    acc.hash(&mut h);
    h.finish()
}

type Acc = (f64, f64, f64, u32, f64);

pub fn run_segment_forest(progress: &Progress, octree_dir: &str, req: &ForestRequest) -> Result<ForestResult, String> {
    let t0 = std::time::Instant::now();
    let cancel = crate::commands::cancel::token("forest");
    let dir = Path::new(octree_dir);
    emit_progress(progress, "forest", 0.0);
    let (meta, scale, offset, _b, point_bytes, _e) = open_octree_meta(dir)?;
    let hier = std::fs::read(dir.join("hierarchy.bin")).map_err(|e| format!("read hierarchy.bin: {e}"))?;
    if hier.len() % 24 != 0 { return Err(format!("hierarchy.bin length {} not a multiple of 24", hier.len())); }
    let n_records = hier.len() / 24;
    let patches = parse_export_patches(&dir.join("patches.bin"))?;
    let layout = extra_layout(&meta);
    let refl_col = if req.use_reflectance { layout_find(&layout, "Reflectance").cloned() } else { None };
    let dtm = build_dtm_grid(dir, req.dtm_cell)
        .map_err(|e| format!("{e} — the forest pass measures heights above the ground: classify ground first"))?;
    let voxel = req.voxel.max(0.01);
    let inv = 1.0 / voxel;
    let cut = req.cut.max(0.0) as f32;
    let vkey = |x: f64, y: f64, z: f64| -> (i32, i32, i32) { ((x * inv).floor() as i32, (y * inv).floor() as i32, (z * inv).floor() as i32) };
    // some 300 bytes a node at the peak: 32 M is about 10 GB (a 50 × 50 m
    // MLS tile of 90 M points makes 25 M at 4 cm)
    const MAX_NODES: usize = 32_000_000;

    // ---- 1. the working set ----
    let mut vox: FxHashMap<(i32, i32, i32), Acc> = FxHashMap::default();
    let mut ground_sum = 0.0f64;
    let mut ground_n = 0u64;
    {
        let mut bin = BufReader::with_capacity(4 * 1024 * 1024, File::open(dir.join("octree.bin")).map_err(|e| format!("open octree.bin: {e}"))?);
        let mut block: Vec<u8> = Vec::new();
        let mut cur_pos: u64 = 0;
        for rec_idx in 0..n_records {
            let h = &hier[rec_idx * 24..rec_idx * 24 + 24];
            let byte_offset = u64::from_le_bytes(h[8..16].try_into().unwrap());
            let byte_size = u64::from_le_bytes(h[16..24].try_into().unwrap()) as usize;
            if byte_size == 0 { continue; }
            let num_points = byte_size / point_bytes;
            block.resize(byte_size, 0);
            if byte_offset != cur_pos { bin.seek(SeekFrom::Start(byte_offset)).map_err(|e| format!("seek octree.bin: {e}"))?; cur_pos = byte_offset; }
            bin.read_exact(&mut block).map_err(|e| format!("read octree.bin block: {e}"))?;
            cur_pos += byte_size as u64;
            for p in 0..num_points {
                if let Some(&(_t, _s, del)) = patches.get(&(rec_idx as u32, p as u32)) { if del == 1 { continue; } }
                let o = p * point_bytes;
                if block[o + 18] == 2 { continue; }
                let xi = i32::from_le_bytes(block[o..o + 4].try_into().unwrap());
                let yi = i32::from_le_bytes(block[o + 4..o + 8].try_into().unwrap());
                let zi = i32::from_le_bytes(block[o + 8..o + 12].try_into().unwrap());
                let (rx, ry, rz) = (xi as f64 * scale[0], yi as f64 * scale[1], zi as f64 * scale[2]);
                let Some(g) = dtm.sample(rx + offset[0], ry + offset[1]) else { continue };
                let hag = (rz + offset[2] - g as f64) as f32;
                if hag < cut { continue; }
                ground_sum += g as f64; ground_n += 1;
                let refl = refl_col.as_ref().map(|c| c.read(&block[o..o + point_bytes])).unwrap_or(0.0);
                let e = vox.entry(vkey(rx, ry, rz)).or_insert((0.0, 0.0, 0.0, 0, 0.0));
                e.0 += rx; e.1 += ry; e.2 += rz; e.3 += 1; e.4 += refl;
            }
            if vox.len() > MAX_NODES {
                return Err(format!("a {voxel:.3} m voxel makes more than {MAX_NODES} working points here — use a larger voxel (e.g. {:.2} m)", voxel * 1.5));
            }
            if rec_idx % 256 == 0 {
                if crate::commands::cancel::stopped(&cancel) { return Err("Stopped — nothing was changed.".to_string()); }
                emit_progress(progress, "forest", 0.12 * (rec_idx as f32 / n_records.max(1) as f32));
            }
        }
    }
    let _ = (ground_sum, ground_n);
    if vox.len() < 100 { return Err("too few points above the ground for trees — is ground classified, and the cut height right?".into()); }
    // a stable order (the voxels' keys), so a re-run builds the same set
    let mut keys: Vec<((i32, i32, i32), Acc)> = vox.into_iter().collect();
    keys.sort_unstable_by_key(|&(k, _)| k);
    let mut index: FxHashMap<(i32, i32, i32), u32> = FxHashMap::default();
    index.reserve(keys.len());
    let mut ws = WorkSet { voxel: voxel as f32, ..WorkSet::default() };
    let mut refl = Vec::new();
    for (i, (k, (sx, sy, sz, n, sr))) in keys.into_iter().enumerate() {
        let nf = n as f64;
        let (x, y, z) = (sx / nf, sy / nf, sz / nf);
        let g = dtm.sample(x + offset[0], y + offset[1]).map(|g| g as f64).unwrap_or(z + offset[2]);
        ws.p.push([x as f32, y as f32, z as f32]);
        ws.hag.push(((z + offset[2] - g) as f32).max(0.0));
        ws.n.push(n);
        refl.push((sr / nf) as f32);
        index.insert(k, i as u32);
    }
    let used_reflectance = refl_col.is_some();
    if used_reflectance { ws.refl = Some(refl); }
    emit_progress(progress, "forest", 0.15);

    // ---- 2. the preparation, kept between runs ----
    let mut prm = Params::default();
    prm.wood.refl_weight = if used_reflectance { 0.3 } else { 0.0 };
    prm.edge_buffer = req.edge_buffer;
    prm.understory = req.understory as f32;
    // the scale-free settings follow the voxel
    let v = voxel as f32;
    prm.stems.half = (v * 1.25).max(0.04);
    prm.stems.eps = (v * 1.75).max(0.05);
    // a mobile scanner sees round every stem and branch (pipeline::for_mls)
    let mls = meta.get("scannerType").and_then(|v| v.as_str()).is_some_and(|t| t.eq_ignore_ascii_case("mls"));
    if mls { crate::commands::forest::pipeline::for_mls(&mut prm); }
    // tuning runs: settings from the JSON file FOREST_TUNE names
    let mut tune_prep = String::new();
    if let Ok(path) = std::env::var("FOREST_TUNE") {
        let text = std::fs::read_to_string(&path).map_err(|e| format!("FOREST_TUNE {path}: {e}"))?;
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("FOREST_TUNE {path}: {e}"))?;
        crate::commands::forest::pipeline::apply_tune(&mut prm, &v)?;
        if let Some(o) = v.as_object() {
            for (k, val) in o {
                if !["stems.", "instance.", "merge.", "attach_"].iter().any(|p| k.starts_with(p)) { tune_prep.push_str(&format!("{k}={val};")); }
            }
        }
    }
    let key = fingerprint(octree_dir, &ws, req, used_reflectance) ^ {
        use std::hash::{Hash, Hasher};
        let mut h = rustc_hash::FxHasher::default();
        tune_prep.hash(&mut h);
        h.finish()
    };
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    let cached = cache.lock().map_err(|_| "forest cache poisoned".to_string())?.as_ref().filter(|c| c.key == key).map(|c| c.prep.clone());
    let reused = cached.is_some();
    let prep = match cached {
        Some(p) => p,
        None => {
            let stopped = || crate::commands::cancel::stopped(&cancel);
            let p = prepare(&ws, &prm, &|stage, f| {
                emit_progress(progress, "forest", 0.15 + 0.55 * f);
                let _ = stage;
                !stopped()
            })?;
            let p = Arc::new(p);
            *cache.lock().map_err(|_| "forest cache poisoned".to_string())? = Some(Cached { key, prep: p.clone() });
            p
        }
    };
    emit_progress(progress, "forest", 0.7);
    if crate::commands::cancel::stopped(&cancel) { return Err("Stopped — nothing was changed.".to_string()); }

    // ---- 3. the trees ----
    let off = offset;
    let seeds_in = if req.use_saved_seeds {
        let f = read_seeds(dir)?.ok_or("no saved stems yet — run the forest pass once first")?;
        Some(f.seeds.iter().map(|s| s.to_seed(off)).collect::<Vec<Seed>>())
    } else { None };
    let out = segment(&ws, &prep, seeds_in, &prm);
    // research: the working set, its graph and what was computed on it, raw (FOREST_DUMP names a folder)
    if let Ok(d) = std::env::var("FOREST_DUMP") {
        let d = std::path::PathBuf::from(d);
        std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
        let put = |name: &str, bytes: &[u8]| std::fs::write(d.join(name), bytes).map_err(|e| format!("{name}: {e}"));
        fn raw<T>(v: &[T]) -> &[u8] { unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) } }
        put("p.f32", raw(&ws.p))?;
        put("hag.f32", raw(&ws.hag))?;
        put("n.u32", raw(&ws.n))?;
        put("lik.f32", raw(&prep.lik))?;
        put("carry.f32", raw(&prep.carry))?;
        let wood: Vec<u8> = prep.wood.iter().map(|&w| w as u8).collect();
        put("wood.u8", &wood)?;
        put("root.u32", raw(&prep.root))?;
        put("up.u32", raw(&prep.up))?;
        put("off.u32", raw(&prep.csr.off))?;
        put("nbr.u32", raw(&prep.csr.nbr))?;
        put("label.u32", raw(&out.label))?;
        put("sem.u8", &out.sem)?;
        put("meta.json", serde_json::json!({ "n": ws.len(), "voxel": ws.voxel, "offset": offset }).to_string().as_bytes())?;
        put("seeds_raw.json", &serde_json::to_vec(&out.seeds).map_err(|e| e.to_string())?)?;
    }
    emit_progress(progress, "forest", 0.8);

    // ---- 4. write the trees and labels back ----
    let has_sem = point_bytes >= 21 && req.write_semantic;
    let seeds = &out.seeds;
    // each seed's full points at breast height, for its diameter
    let mut bh_pts: Vec<Vec<(f64, f64)>> = vec![Vec::new(); seeds.len()];
    let mut seed_grid: FxHashMap<(i32, i32), Vec<usize>> = FxHashMap::default();
    for (k, s) in seeds.iter().enumerate() { seed_grid.entry((s.x.floor() as i32, s.y.floor() as i32)).or_default().push(k); }
    let foot = |x: f64, y: f64, hag: f64| -> Option<u32> {
        let (gx, gy) = (x.floor() as i32, y.floor() as i32);
        let mut best: Option<(f64, u32)> = None;
        for dx in -1..=1 { for dy in -1..=1 {
            if let Some(ks) = seed_grid.get(&(gx + dx, gy + dy)) {
                for &k in ks {
                    let s = &seeds[k];
                    let (ax, ay) = s.axis_at(hag);
                    let d = ((x - ax).powi(2) + (y - ay).powi(2)).sqrt();
                    if d <= s.reach() && best.map_or(true, |b| d < b.0) { best = Some((d, s.tree)); }
                }
            }
        }}
        best.map(|b| b.1)
    };
    let (mut assigned, mut stem_n, mut branch_n, mut leaf_n) = (0u64, 0u64, 0u64, 0u64);
    {
        let mut file = OpenOptions::new().read(true).write(true).open(dir.join("octree.bin")).map_err(|e| format!("open octree.bin rw: {e}"))?;
        let mut block: Vec<u8> = Vec::new();
        for rec_idx in 0..n_records {
            let h = &hier[rec_idx * 24..rec_idx * 24 + 24];
            let byte_offset = u64::from_le_bytes(h[8..16].try_into().unwrap());
            let byte_size = u64::from_le_bytes(h[16..24].try_into().unwrap()) as usize;
            if byte_size == 0 { continue; }
            let num_points = byte_size / point_bytes;
            block.resize(byte_size, 0);
            file.seek(SeekFrom::Start(byte_offset)).map_err(|e| format!("seek octree.bin: {e}"))?;
            file.read_exact(&mut block).map_err(|e| format!("read octree.bin: {e}"))?;
            let mut dirty = false;
            for p in 0..num_points {
                if let Some(&(_t, _s, del)) = patches.get(&(rec_idx as u32, p as u32)) { if del == 1 { continue; } }
                let o = p * point_bytes;
                let (tree, sem): (i32, u8) = if block[o + 18] == 2 {
                    (0, 0)
                } else {
                    let xi = i32::from_le_bytes(block[o..o + 4].try_into().unwrap());
                    let yi = i32::from_le_bytes(block[o + 4..o + 8].try_into().unwrap());
                    let zi = i32::from_le_bytes(block[o + 8..o + 12].try_into().unwrap());
                    let (rx, ry, rz) = (xi as f64 * scale[0], yi as f64 * scale[1], zi as f64 * scale[2]);
                    match dtm.sample(rx + offset[0], ry + offset[1]) {
                        None => (0, 0),
                        Some(g) => {
                            let hag = rz + offset[2] - g as f64;
                            if hag >= BH_BAND.0 && hag <= BH_BAND.1 {
                                let (gx, gy) = (rx.floor() as i32, ry.floor() as i32);
                                for dx in -1..=1 { for dy in -1..=1 {
                                    if let Some(ks) = seed_grid.get(&(gx + dx, gy + dy)) {
                                        for &k in ks {
                                            let (ax, ay) = seeds[k].axis_at(hag);
                                            if (rx - ax).powi(2) + (ry - ay).powi(2) <= bh_reach(&seeds[k]).powi(2) { bh_pts[k].push((rx, ry)); }
                                        }
                                    }
                                }}
                            }
                            if (hag as f32) < cut {
                                match foot(rx, ry, hag.max(0.0)) { Some(t) => (t as i32, STEM), None => (0, 0) }
                            } else {
                                match index.get(&vkey(rx, ry, rz)) {
                                    Some(&i) => (out.label[i as usize] as i32, out.sem[i as usize]),
                                    None => (0, 0),
                                }
                            }
                        }
                    }
                };
                if tree != 0 { assigned += 1; }
                match sem { STEM => stem_n += 1, BRANCH => branch_n += 1, LEAF => leaf_n += 1, _ => {} }
                let cur = i32::from_le_bytes(block[o + 12..o + 16].try_into().unwrap());
                if cur != tree { block[o + 12..o + 16].copy_from_slice(&tree.to_le_bytes()); dirty = true; }
                if has_sem && block[o + 20] != sem { block[o + 20] = sem; dirty = true; }
            }
            if dirty {
                file.seek(SeekFrom::Start(byte_offset)).map_err(|e| format!("seek back octree.bin: {e}"))?;
                file.write_all(&block).map_err(|e| format!("write octree.bin: {e}"))?;
            }
            if rec_idx % 256 == 0 { emit_progress(progress, "forest", 0.8 + 0.18 * (rec_idx as f32 / n_records.max(1) as f32)); }
        }
        file.flush().map_err(|e| format!("flush octree.bin: {e}"))?;
    }

    // ---- 5. the files beside the dataset ----
    let fd = forest_dir(dir);
    std::fs::create_dir_all(&fd).map_err(|e| format!("create forest/: {e}"))?;
    // the stems measured at breast height from the full points: radius,
    // and the axis moved onto the circle's centre there
    let refined: Vec<Option<(f64, f64, f64)>> = {
        use rayon::prelude::*;
        seeds.par_iter().zip(bh_pts.par_iter()).map(|(s, p)| refine_at_breast_height(s, p)).collect()
    };
    drop(bh_pts);
    let mut seeds_out: Vec<Seed> = seeds.clone();
    let refined_n = apply_refits(&mut seeds_out, &refined);
    let seeds = &seeds_out;
    let mut tree_r: FxHashMap<u32, f64> = FxHashMap::default();
    for s in seeds.iter() { let e = tree_r.entry(s.tree).or_insert(0.0); if s.r > *e { *e = s.r; } }
    write_seeds(dir, &SeedsFile { version: 1, seeds: seeds.iter().map(|s| SeedJson::from_seed(s, off)).collect() })?;
    let trees: Vec<serde_json::Value> = out.trees.iter().map(|t| serde_json::json!({
        "tree": t.tree, "x": t.x + off[0], "y": t.y + off[1], "z": t.z + off[2],
        "height": t.height, "r": tree_r.get(&t.tree).copied().unwrap_or(t.r), "voxels": t.nodes, "flags": t.flags,
    })).collect();
    write_file_atomic(&fd.join("trees.json"), &serde_json::to_vec_pretty(&serde_json::json!({ "version": 1, "trees": trees })).map_err(|e| e.to_string())?, "trees.json")?;
    let sugg: Vec<serde_json::Value> = out.suggestions.iter().map(|s| serde_json::json!({
        "a": s.a, "b": s.b, "votes": s.votes, "x": s.x + off[0], "y": s.y + off[1], "z": s.z + off[2],
    })).collect();
    write_file_atomic(&fd.join("suggestions.json"), &serde_json::to_vec_pretty(&serde_json::json!({ "version": 1, "suggestions": sugg })).map_err(|e| e.to_string())?, "suggestions.json")?;
    write_near_ties(&fd, &ws, &index, &out, voxel, off)?;
    let mut timings = if reused { vec![("reused".to_string(), 0.0)] } else { prep.timings.clone() };
    timings.extend(out.timings.iter().cloned());
    let result = ForestResult {
        tree_count: out.trees.len() as u32,
        assigned_points: assigned,
        stem_points: stem_n,
        branch_points: branch_n,
        leaf_points: leaf_n,
        seeds: seeds.len() as u32,
        seeds_without_circle: seeds.iter().filter(|s| s.circles == 0).count() as u32,
        stems_measured: refined_n as u32,
        merged: out.merged.len() as u32,
        suggestions: out.suggestions.len() as u32,
        edge_trees: out.trees.iter().filter(|t| t.flags.iter().any(|f| f == "edge")).count() as u32,
        understory_trees: out.trees.iter().filter(|t| t.flags.iter().any(|f| f == "understory")).count() as u32,
        working_points: ws.len() as u32,
        reused,
        used_reflectance,
        seconds: t0.elapsed().as_secs_f64(),
        timings,
    };
    write_file_atomic(&fd.join("report.json"), &serde_json::to_vec_pretty(&serde_json::json!({ "request": req, "result": result })).map_err(|e| e.to_string())?, "report.json")?;
    emit_progress(progress, "forest", 1.0);
    Ok(result)
}

/// The branches that were nearly another tree's (forest/near_ties.json,
/// largest first) and each one's voxels (near_ties.bin: i32 x, y, z of the
/// working set's keys — point coordinates less the offset, over the voxel).
fn write_near_ties(fd: &Path, ws: &WorkSet, index: &FxHashMap<(i32, i32, i32), u32>, out: &crate::commands::forest::pipeline::Outcome, voxel: f64, off: [f64; 3]) -> Result<(), String> {
    let ties: &[TieBranch] = &out.ties;
    let mut of = vec![u32::MAX; ws.len()];
    for (k, b) in ties.iter().enumerate() { for &i in &b.nodes { of[i as usize] = k as u32; } }
    let mut keys_of: Vec<Vec<[i32; 3]>> = vec![Vec::new(); ties.len()];
    for (k, &i) in index.iter() {
        let b = of[i as usize];
        if b != u32::MAX { keys_of[b as usize].push([k.0, k.1, k.2]); }
    }
    let points = |b: &TieBranch| b.nodes.iter().map(|&i| ws.n[i as usize] as u64).sum::<u64>();
    let mut order: Vec<usize> = (0..ties.len()).collect();
    order.sort_by_key(|&k| (std::cmp::Reverse(points(&ties[k])), k));
    let mut bin: Vec<u8> = Vec::new();
    let mut rows = Vec::new();
    // a node's place in the world
    let end = |i: u32| { let q = ws.p[i as usize]; [q[0] as f64 + off[0], q[1] as f64 + off[1], q[2] as f64 + off[2]] };
    for (id, &k) in order.iter().enumerate() {
        let b = &ties[k];
        let keys = &mut keys_of[k];
        keys.sort_unstable();
        let first = bin.len() / 12;
        for q in keys.iter() { for v in q { bin.extend_from_slice(&v.to_le_bytes()); } }
        let (mut lo, mut hi, mut c, mut w) = ([f64::MAX; 3], [f64::MIN; 3], [0.0f64; 3], 0.0f64);
        for &i in &b.nodes {
            let (q, m) = (ws.p[i as usize], ws.n[i as usize] as f64);
            for a in 0..3 {
                let v = q[a] as f64 + off[a];
                lo[a] = lo[a].min(v - voxel * 0.5);
                hi[a] = hi[a].max(v + voxel * 0.5);
                c[a] += v * m;
            }
            w += m;
        }
        rows.push(serde_json::json!({
            "id": id + 1, "tree": b.tree, "other": b.other, "ratio": b.ratio, "nodes": b.nodes.len(), "points": points(b),
            "centre": [c[0] / w, c[1] / w, c[2] / w], "min": lo, "max": hi, "first": first, "count": keys.len(),
            "start": end(b.start), "tie": end(b.tie),
            // the owner model: its features, its belief that the branch is
            // the other tree's, and whether it moved it (then listed the other way)
            "features": out.tie_features.get(k).copied().flatten().map(|f| f.to_vec()),
            "p": out.tie_p.get(k).copied().unwrap_or(0.0), "auto": out.tie_moved.get(k).copied().unwrap_or(false),
        }));
    }
    // which run the list is of: the review's marks hold only for it
    let run = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    write_file_atomic(&fd.join("near_ties.bin"), &bin, "near_ties.bin")?;
    let json = serde_json::json!({ "version": 1, "voxel": voxel, "run": run, "branches": rows });
    write_file_atomic(&fd.join("near_ties.json"), &serde_json::to_vec_pretty(&json).map_err(|e| e.to_string())?, "near_ties.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_round_trip_through_world_coordinates() {
        let s = Seed { id: 3, tree: 7, x: 1.5, y: -2.0, z: 0.25, r: 0.12, lean: [0.01, -0.02], top: 2.2, circles: 4, source: "circle".into() };
        let off = [400000.0, 6800000.0, 100.0];
        let j = SeedJson::from_seed(&s, off);
        assert_eq!((j.x, j.y, j.z), (400001.5, 6799998.0, 100.25));
        assert_eq!(j.to_seed(off), s);
        let text = serde_json::to_string(&SeedsFile { version: 1, seeds: vec![j] }).unwrap();
        assert!(text.contains("\"lean\":[0.01,-0.02]") && text.contains("\"source\":\"circle\""));
    }

    #[test]
    fn a_stem_measured_by_hand_keeps_its_circle() {
        let s = |id: u32, source: &str| Seed { id, tree: id, x: 1.0, y: 2.0, z: 0.0, r: 0.10, lean: [0.1, 0.0], top: 2.2, circles: 3, source: source.into() };
        let mut seeds = vec![s(1, "circle"), s(2, "manual"), s(3, "user")];
        let fit = Some((1.2, 2.05, 0.2));
        let n = apply_refits(&mut seeds, &[fit, fit, None]);
        assert_eq!(n, 1);
        // the axis at breast height moved onto the circle's centre
        let (ax, ay) = seeds[0].axis_at((BH_BAND.0 + BH_BAND.1) * 0.5);
        assert!((ax - 1.2).abs() < 1e-12 && (ay - 2.05).abs() < 1e-12 && seeds[0].r == 0.2);
        assert_eq!((seeds[1].x, seeds[1].y, seeds[1].r), (1.0, 2.0, 0.10));
        assert_eq!((seeds[2].x, seeds[2].r), (1.0, 0.10));
    }
}
