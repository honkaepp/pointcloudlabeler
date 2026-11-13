//! The per-tree tally behind the tree summary, for large clouds.
//!
//! The summary streamed octree.bin once per call on one thread, with two
//! hash probes per point besides the patch lookup and the merge remap,
//! and the panels call it on every mount and after every merge: a minute
//! or two each at a billion points. Here:
//!  * the scan runs on every core, each worker on a contiguous run of
//!    nodes with its own file handle and its own tally, and a point of the
//!    same tree as the one before it costs no hash probe at all;
//!  * the tally is kept before the merges (treemap.json) and the merges are
//!    applied to the per-tree totals afterwards, which compose exactly
//!    (counts, extents, sums, records), so a merge, unmerge or clear
//!    costs no scan;
//!  * the last tally is kept for the dataset, keyed by octree.bin's,
//!    hierarchy.bin's and metadata.json's size and modification time and
//!    by patches.bin's content (a save rewrites it unchanged), so a panel
//!    opening on an unchanged cloud costs no scan either;
//!  * coordinates are summed relative to the dataset's offset: summed in
//!    UTM magnitudes, the sum of squares of a large tree loses the
//!    centimetres σ is made of (0.016 m on the 36 M points of plot 1041's
//!    unassigned bucket).

use super::{emit_progress, json_f64_3, parse_export_patches, parse_remap, point_bytes_of, TreeSummaryEntry};
use crate::progress::Progress;
use rayon::prelude::*;
use rustc_hash::{FxHashMap, FxHasher};
use std::collections::hash_map::Entry;
use std::fs::File;
use std::hash::Hasher;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

/// One tree's totals: what the summary reports, before σ and centroid.
/// Coordinates relative to the dataset's offset (`Tally::offset`).
#[derive(Clone, Debug)]
pub struct TreeAcc {
    pub count: u64,
    pub min: [f64; 3],
    pub max: [f64; 3],
    pub sum: [f64; 3],
    pub sumsq: [f64; 3],
    /// The records holding points of the tree, ascending.
    pub records: Vec<u32>,
}

impl TreeAcc {
    fn new() -> Self {
        Self {
            count: 0,
            min: [f64::INFINITY; 3],
            max: [f64::NEG_INFINITY; 3],
            sum: [0.0; 3],
            sumsq: [0.0; 3],
            records: Vec::new(),
        }
    }

    #[inline]
    fn add(&mut self, w: [f64; 3]) {
        self.count += 1;
        for a in 0..3 {
            if w[a] < self.min[a] { self.min[a] = w[a]; }
            if w[a] > self.max[a] { self.max[a] = w[a]; }
            self.sum[a] += w[a];
            self.sumsq[a] += w[a] * w[a];
        }
    }

    fn merge(&mut self, o: &TreeAcc) {
        self.count += o.count;
        for a in 0..3 {
            self.min[a] = self.min[a].min(o.min[a]);
            self.max[a] = self.max[a].max(o.max[a]);
            self.sum[a] += o.sum[a];
            self.sumsq[a] += o.sumsq[a];
        }
        self.records = merge_sorted(&self.records, &o.records);
    }
}

/// The union of two ascending lists, ascending.
fn merge_sorted(a: &[u32], b: &[u32]) -> Vec<u32> {
    if a.last().map_or(true, |&l| b.first().map_or(true, |&f| l < f)) {
        let mut out = Vec::with_capacity(a.len() + b.len());
        out.extend_from_slice(a);
        out.extend_from_slice(b);
        return out;
    }
    let mut out = Vec::with_capacity(a.len() + b.len());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i] < b[j] { out.push(a[i]); i += 1; }
        else if b[j] < a[i] { out.push(b[j]); j += 1; }
        else { out.push(a[i]); i += 1; j += 1; }
    }
    out.extend_from_slice(&a[i..]);
    out.extend_from_slice(&b[j..]);
    out
}

/// Tree id (patches applied, merges not) → totals, relative to `offset`.
pub struct Tally {
    pub offset: [f64; 3],
    pub trees: FxHashMap<i32, TreeAcc>,
}

struct Cached {
    dir: String,
    key: u64,
    tally: Arc<Tally>,
}

static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// Everything the tally depends on, hashed.
fn tally_key(dir: &Path) -> u64 {
    let mut h = FxHasher::default();
    for name in ["octree.bin", "hierarchy.bin", "metadata.json"] {
        match std::fs::metadata(dir.join(name)) {
            Ok(m) => {
                h.write_u64(m.len());
                if let Some(d) = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()) {
                    h.write_u128(d.as_nanos());
                }
            }
            Err(_) => h.write_u8(0xff),
        }
    }
    match std::fs::read(dir.join("patches.bin")) {
        Ok(b) => {
            h.write_u64(b.len() as u64);
            h.write(&b);
        }
        Err(_) => h.write_u8(0xfe),
    }
    h.finish()
}

/// Nodes per worker run: contiguous, about this many bytes of points.
const RUN_BYTES: u64 = 64 * 1024 * 1024;

fn scan(progress: &Progress, dir: &Path) -> Result<Tally, String> {
    let meta_bytes = std::fs::read(dir.join("metadata.json")).map_err(|e| format!("read metadata.json: {e}"))?;
    let meta: serde_json::Value =
        serde_json::from_slice(&meta_bytes).map_err(|e| format!("parse metadata.json: {e}"))?;
    let scale = json_f64_3(&meta, "scale")?;
    let offset = json_f64_3(&meta, "offset")?;
    let point_bytes = point_bytes_of(&meta)?;
    let hier = std::fs::read(dir.join("hierarchy.bin")).map_err(|e| format!("read hierarchy.bin: {e}"))?;
    if hier.len() % 24 != 0 {
        return Err(format!("hierarchy.bin length {} not a multiple of 24", hier.len()));
    }
    let n_records = hier.len() / 24;
    let rec = |i: usize| -> (u64, usize) {
        let h = &hier[i * 24..i * 24 + 24];
        (
            u64::from_le_bytes(h[8..16].try_into().unwrap()),
            u64::from_le_bytes(h[16..24].try_into().unwrap()) as usize,
        )
    };
    let patches = parse_export_patches(&dir.join("patches.bin"))?;
    let bin_path = dir.join("octree.bin");

    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut start = 0usize;
    let mut bytes = 0u64;
    for i in 0..n_records {
        bytes += rec(i).1 as u64;
        if bytes >= RUN_BYTES {
            runs.push((start, i + 1));
            start = i + 1;
            bytes = 0;
        }
    }
    if start < n_records {
        runs.push((start, n_records));
    }

    let done = AtomicUsize::new(0);
    let parts: Vec<Result<Vec<(i32, TreeAcc)>, String>> = runs
        .par_iter()
        .map(|&(a, b)| {
            let mut bin = BufReader::with_capacity(
                4 * 1024 * 1024,
                File::open(&bin_path).map_err(|e| format!("open octree.bin: {e}"))?,
            );
            let mut cur_pos = u64::MAX;
            let mut block: Vec<u8> = Vec::new();
            let mut index: FxHashMap<i32, usize> = FxHashMap::default();
            let mut accs: Vec<(i32, TreeAcc)> = Vec::new();
            for rec_idx in a..b {
                let (byte_offset, byte_size) = rec(rec_idx);
                if byte_size == 0 { continue; }
                let num_points = byte_size / point_bytes;
                block.resize(byte_size, 0);
                if byte_offset != cur_pos {
                    bin.seek(SeekFrom::Start(byte_offset)).map_err(|e| format!("seek octree.bin: {e}"))?;
                }
                bin.read_exact(&mut block).map_err(|e| format!("read octree.bin block: {e}"))?;
                cur_pos = byte_offset + byte_size as u64;
                let r = rec_idx as u32;
                let gated = patches.has_record(r);
                let mut last_id = i32::MIN;
                let mut last_k = usize::MAX;
                for p in 0..num_points {
                    let o = p * point_bytes;
                    let mut tree_id = i32::from_le_bytes(block[o + 12..o + 16].try_into().unwrap());
                    // The exporter's patch semantics: deleted ⇒ dropped, a
                    // non-negative tree id overrides (0 resets).
                    if gated {
                        if let Some(&(p_tree, _p_sem, p_del)) = patches.get(&(r, p as u32)) {
                            if p_del == 1 { continue; }
                            if p_tree >= 0 { tree_id = p_tree; }
                        }
                    }
                    let k = if tree_id == last_id {
                        last_k
                    } else {
                        let k = *index.entry(tree_id).or_insert_with(|| {
                            accs.push((tree_id, TreeAcc::new()));
                            accs.len() - 1
                        });
                        last_id = tree_id;
                        last_k = k;
                        k
                    };
                    let xi = i32::from_le_bytes(block[o..o + 4].try_into().unwrap());
                    let yi = i32::from_le_bytes(block[o + 4..o + 8].try_into().unwrap());
                    let zi = i32::from_le_bytes(block[o + 8..o + 12].try_into().unwrap());
                    let acc = &mut accs[k].1;
                    if acc.records.last() != Some(&r) { acc.records.push(r); }
                    acc.add([xi as f64 * scale[0], yi as f64 * scale[1], zi as f64 * scale[2]]);
                }
                let d = done.fetch_add(1, Ordering::Relaxed) + 1;
                if d % 256 == 0 {
                    emit_progress(progress, "tree_summary", d as f32 / n_records.max(1) as f32);
                }
            }
            Ok(accs)
        })
        .collect();

    // In run order, so every tree's records stay ascending.
    let mut trees: FxHashMap<i32, TreeAcc> = FxHashMap::default();
    for part in parts {
        for (id, acc) in part? {
            match trees.entry(id) {
                Entry::Occupied(mut e) => e.get_mut().merge(&acc),
                Entry::Vacant(e) => { e.insert(acc); }
            }
        }
    }
    Ok(Tally { offset, trees })
}

/// The dataset's tally, from the cache when nothing it depends on has
/// changed since the last one.
pub fn tally(progress: &Progress, dir: &Path) -> Result<Arc<Tally>, String> {
    let key = tally_key(dir);
    let name = dir.to_string_lossy().into_owned();
    if let Some(c) = CACHE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if c.dir == name && c.key == key {
            return Ok(c.tally.clone());
        }
    }
    let t = Arc::new(scan(progress, dir)?);
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(Cached { dir: name, key, tally: t.clone() });
    Ok(t)
}

/// The tree summary: the tally with the merges applied, one entry per
/// tree id, ascending.
pub fn summary(progress: &Progress, octree_dir: &str) -> Result<Vec<TreeSummaryEntry>, String> {
    let dir = Path::new(octree_dir);
    emit_progress(progress, "tree_summary", 0.0);
    let t = tally(progress, dir)?;
    let remap = parse_remap(&dir.join("treemap.json"))?;
    let mut ids: Vec<i32> = t.trees.keys().copied().collect();
    ids.sort_unstable();
    let o = t.offset;
    let mut merged: FxHashMap<i32, TreeAcc> = FxHashMap::default();
    for id in ids {
        let acc = &t.trees[&id];
        let to = remap.get(&id).copied().unwrap_or(id);
        match merged.entry(to) {
            Entry::Occupied(mut e) => e.get_mut().merge(acc),
            Entry::Vacant(e) => { e.insert(acc.clone()); }
        }
    }
    let mut out: Vec<TreeSummaryEntry> = merged
        .into_iter()
        .map(|(tree_id, a)| {
            let n = a.count.max(1) as f64;
            let mean = [a.sum[0] / n, a.sum[1] / n, a.sum[2] / n];
            // Population σ per axis; max(0, …) guards the tiny negative
            // variance float noise can give a one-point tree.
            let sigma = [
                (a.sumsq[0] / n - mean[0] * mean[0]).max(0.0).sqrt(),
                (a.sumsq[1] / n - mean[1] * mean[1]).max(0.0).sqrt(),
                (a.sumsq[2] / n - mean[2] * mean[2]).max(0.0).sqrt(),
            ];
            TreeSummaryEntry {
                tree_id,
                count: a.count,
                bbox_min: [a.min[0] + o[0], a.min[1] + o[1], a.min[2] + o[2]],
                bbox_max: [a.max[0] + o[0], a.max[1] + o[1], a.max[2] + o[2]],
                centroid: [mean[0] + o[0], mean[1] + o[1], mean[2] + o[2]],
                sigma,
                records: a.records,
            }
        })
        .collect();
    out.sort_by_key(|e| e.tree_id);
    emit_progress(progress, "tree_summary", 1.0);
    Ok(out)
}

/// The largest tree id anywhere in the cloud (patches applied, deleted
/// points left out; merges only ever point at ids that exist), from the
/// tally. "New tree" takes the next one: the viewer alone sees only the
/// nodes it has loaded, a small share of a large cloud.
pub fn max_tree_id(progress: &Progress, octree_dir: &str) -> Result<i32, String> {
    let t = tally(progress, Path::new(octree_dir))?;
    Ok(t.trees.keys().copied().max().unwrap_or(0).max(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorted_union() {
        assert_eq!(merge_sorted(&[1, 3, 5], &[2, 3, 6]), vec![1, 2, 3, 5, 6]);
        assert_eq!(merge_sorted(&[1, 2], &[3, 4]), vec![1, 2, 3, 4]);
        assert_eq!(merge_sorted(&[], &[3]), vec![3]);
        assert_eq!(merge_sorted(&[3], &[]), vec![3]);
        assert_eq!(merge_sorted(&[4, 9], &[1, 9]), vec![1, 4, 9]);
    }

    /// A three-node octree of 21-byte points: tree ids, a patch that
    /// moves a point to another tree, a deletion, a merge; then a new
    /// patch, which the cache must notice.
    #[test]
    fn summary_applies_patches_then_merges_and_follows_new_patches() {
        use super::super::{write_patch_record_v2, PatchRecord, PATCHES_MAGIC, PATCHES_VERSION_V2};
        let dir = std::env::temp_dir().join(format!("tp-tree-tally-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            br#"{"scale":[1,1,1],"offset":[0,0,0],"pointBytes":21,"boundingBox":{"min":[0,0,0],"max":[9,9,9]}}"#,
        ).unwrap();
        let pb = 21usize;
        // (node, x, tree id)
        let pts = [(0, 0, 1), (0, 1, 1), (0, 2, 2), (1, 3, 2), (1, 4, 3), (2, 5, 3), (2, 6, 3)];
        let mut bin = vec![0u8; pts.len() * pb];
        for (i, &(_, x, t)) in pts.iter().enumerate() {
            bin[i * pb..i * pb + 4].copy_from_slice(&(x as i32).to_le_bytes());
            bin[i * pb + 12..i * pb + 16].copy_from_slice(&(t as i32).to_le_bytes());
        }
        std::fs::write(dir.join("octree.bin"), &bin).unwrap();
        let counts = [3usize, 2, 2];
        let mut hier = vec![0u8; 3 * 24];
        let mut off = 0usize;
        for (r, &c) in counts.iter().enumerate() {
            hier[r * 24 + 4..r * 24 + 8].copy_from_slice(&(c as u32).to_le_bytes());
            hier[r * 24 + 8..r * 24 + 16].copy_from_slice(&(off as u64).to_le_bytes());
            hier[r * 24 + 16..r * 24 + 24].copy_from_slice(&((c * pb) as u64).to_le_bytes());
            off += c * pb;
        }
        std::fs::write(dir.join("hierarchy.bin"), &hier).unwrap();
        let write_patches = |recs: &[PatchRecord]| {
            let mut b = Vec::new();
            b.extend_from_slice(PATCHES_MAGIC);
            b.extend_from_slice(&PATCHES_VERSION_V2.to_le_bytes());
            for r in recs { b.extend_from_slice(&write_patch_record_v2(r)); }
            std::fs::write(dir.join("patches.bin"), &b).unwrap();
        };
        let moved = PatchRecord { tile: 0, record: 0, point: 0, tree_id: 3, semantic: 0, deleted: 0, standing: -1, laying: -1 };
        let deleted = PatchRecord { tile: 0, record: 1, point: 1, tree_id: -1, semantic: 0, deleted: 1, standing: -1, laying: -1 };
        write_patches(&[moved, deleted]);
        std::fs::write(dir.join("treemap.json"), br#"{"2": 1}"#).unwrap();
        let d = dir.to_string_lossy().into_owned();
        let p = Progress::silent();

        let s = summary(&p, &d).unwrap();
        let by: FxHashMap<i32, &TreeSummaryEntry> = s.iter().map(|e| (e.tree_id, e)).collect();
        assert_eq!(s.len(), 2, "2 merged into 1");
        // Tree 1: x 1 (node 0) and, merged from 2, x 2 (node 0) and x 3 (node 1).
        assert_eq!(by[&1].count, 3);
        assert_eq!(by[&1].bbox_min[0], 1.0);
        assert_eq!(by[&1].bbox_max[0], 3.0);
        assert_eq!(by[&1].records, vec![0, 1]);
        // Tree 3: x 0 moved in by the patch, x 4 deleted, x 5 and 6.
        assert_eq!(by[&3].count, 3);
        assert_eq!(by[&3].centroid[0], 11.0 / 3.0);
        assert_eq!(by[&3].records, vec![0, 2]);
        assert_eq!(max_tree_id(&p, &d).unwrap(), 3);

        // The merge undone: no scan needed, the same totals unmerged.
        std::fs::write(dir.join("treemap.json"), b"{}").unwrap();
        let s = summary(&p, &d).unwrap();
        assert_eq!(s.iter().map(|e| (e.tree_id, e.count)).collect::<Vec<_>>(), vec![(1, 1), (2, 2), (3, 3)]);

        // A new patch: the cache must not answer with the old tally.
        let renamed = PatchRecord { tile: 0, record: 2, point: 1, tree_id: 9, semantic: 0, deleted: 0, standing: -1, laying: -1 };
        write_patches(&[moved, deleted, renamed]);
        let s = summary(&p, &d).unwrap();
        assert_eq!(s.iter().map(|e| (e.tree_id, e.count)).collect::<Vec<_>>(), vec![(1, 1), (2, 2), (3, 2), (9, 1)]);
        assert_eq!(max_tree_id(&p, &d).unwrap(), 9);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two points a metre apart at UTM magnitude, a million times over:
    /// σ is exactly 0.5 m, which a sum of squares of the absolute
    /// coordinates cannot resolve.
    #[test]
    fn sigma_survives_utm_magnitudes() {
        let dir = std::env::temp_dir().join(format!("tp-tree-tally-utm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            br#"{"scale":[0.001,0.001,0.001],"offset":[399550.5555,6786235.01975,72.13325],"pointBytes":21,"boundingBox":{"min":[0,0,0],"max":[1,1,1]}}"#,
        ).unwrap();
        let pb = 21usize;
        let n = 1_000_000usize;
        let mut bin = vec![0u8; n * pb];
        for i in 0..n {
            let y = if i % 2 == 0 { 100_000i32 } else { 101_000 };
            bin[i * pb + 4..i * pb + 8].copy_from_slice(&y.to_le_bytes());
            bin[i * pb + 12..i * pb + 16].copy_from_slice(&5i32.to_le_bytes());
        }
        std::fs::write(dir.join("octree.bin"), &bin).unwrap();
        let mut hier = vec![0u8; 24];
        hier[4..8].copy_from_slice(&(n as u32).to_le_bytes());
        hier[16..24].copy_from_slice(&((n * pb) as u64).to_le_bytes());
        std::fs::write(dir.join("hierarchy.bin"), &hier).unwrap();
        let s = summary(&Progress::silent(), &dir.to_string_lossy()).unwrap();
        assert_eq!(s.len(), 1);
        assert!((s[0].sigma[1] - 0.5).abs() < 1e-9, "σ {}", s[0].sigma[1]);
        assert!((s[0].centroid[1] - (6786235.01975 + 100.5)).abs() < 1e-6, "centroid {}", s[0].centroid[1]);
        assert_eq!(s[0].bbox_min[1], 6786235.01975 + 100.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn totals_merge_like_one_tally() {
        let mut a = TreeAcc::new();
        a.add([0.0, 0.0, 0.0]);
        a.records.push(1);
        let mut b = TreeAcc::new();
        b.add([2.0, 4.0, -1.0]);
        b.records.extend([1, 7]);
        a.merge(&b);
        assert_eq!(a.count, 2);
        assert_eq!(a.min, [0.0, 0.0, -1.0]);
        assert_eq!(a.max, [2.0, 4.0, 0.0]);
        assert_eq!(a.sum, [2.0, 4.0, -1.0]);
        assert_eq!(a.records, vec![1, 7]);
    }
}
