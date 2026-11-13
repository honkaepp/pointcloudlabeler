//! TreeQSM on every tree of a forest-pass working set (`FOREST_DUMP`), for
//! one labelling of its nodes — the forest pass's own or a reference's.
//!
//!     cargo run --release --example qsm_research -- DUMP_DIR LABELS u32|i32 OUT_PREFIX [cover_m=0.12] [min_nodes=50]
//!
//! Writes OUT_PREFIX_seg.u32 (the QSM segment of every node, 1-based and
//! unique across trees; 0 for none), OUT_PREFIX_segs.json (one row per
//! segment: tree, parent segment, branch order, radii base to tip, length,
//! base and tip), OUT_PREFIX_cyl.f64 (one row of 12 per cylinder:
//! segment, start xyz, axis xyz, length, radius, parent cylinder or -1,
//! added, tree) and OUT_PREFIX_cylraw.f64 (per cylinder: the radius as
//! fitted, before TreeQSM's taper adjustments, and its points).
//!
//! Each tree is the reference's outlier filter's survivors, less the pieces
//! lying more than `QSM_FAR_M` (15) metres from its main body: a reference
//! tree with a second tree under its id 30 m away kept `define_main_branches`
//! searching for minutes. A tree still running after `QSM_TREE_SECONDS` (180)
//! is given up at TreeQSM's next stage boundary.
//!
//! scripts/validation/eval_qsm_branches.py makes the reference's labels for
//! the working set and compares the two sets of models.

use pointcloudlabeler_editor_lib::commands::treeqsm::{filtering, treeqsm_single_cancellable, FilterParams, QsmInputs, QsmModel};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use rayon::prelude::*;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

fn f32s(b: &[u8]) -> Vec<f32> { b.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect() }

/// The points of a tree to keep: its main body (the largest piece of
/// 12 cm cells touching each other) and every piece within `far` of it.
fn near_main_body(pts: &[[f64; 3]], far: f64) -> Vec<bool> {
    use std::collections::HashMap;
    const CELL: f64 = 0.12;
    let key = |p: &[f64; 3]| [(p[0] / CELL).floor() as i64, (p[1] / CELL).floor() as i64, (p[2] / CELL).floor() as i64];
    let mut cells: HashMap<[i64; 3], Vec<u32>> = HashMap::new();
    for (i, p) in pts.iter().enumerate() { cells.entry(key(p)).or_default().push(i as u32); }
    let mut piece: HashMap<[i64; 3], u32> = HashMap::new();
    let mut size: Vec<usize> = Vec::new();
    let mut keys: Vec<[i64; 3]> = cells.keys().copied().collect();
    keys.sort();
    for k in keys {
        if piece.contains_key(&k) { continue; }
        let id = size.len() as u32;
        let mut n = 0usize;
        let mut stack = vec![k];
        piece.insert(k, id);
        while let Some(c) = stack.pop() {
            n += cells[&c].len();
            for dx in -1..=1 { for dy in -1..=1 { for dz in -1..=1 {
                let q = [c[0] + dx, c[1] + dy, c[2] + dz];
                if cells.contains_key(&q) && !piece.contains_key(&q) { piece.insert(q, id); stack.push(q); }
            }}}
        }
        size.push(n);
    }
    if size.len() < 2 { return vec![true; pts.len()]; }
    let main = (0..size.len()).max_by_key(|&i| (size[i], std::cmp::Reverse(i))).unwrap() as u32;
    let of: Vec<u32> = pts.iter().map(|p| piece[&key(p)]).collect();
    let body: Vec<[f32; 3]> = pts.iter().zip(&of).filter(|&(_, &c)| c == main).map(|(p, _)| [p[0] as f32, p[1] as f32, p[2] as f32]).collect();
    let kd = pointcloudlabeler_editor_lib::commands::kdtree::KdTree3::build(&body);
    let r2 = (far * far) as f32;
    // a piece is kept when any of its points is near the body
    let mut keep = vec![false; size.len()];
    keep[main as usize] = true;
    for (p, &c) in pts.iter().zip(&of) {
        if !keep[c as usize] && kd.nearest([p[0] as f32, p[1] as f32, p[2] as f32], r2).is_some() { keep[c as usize] = true; }
    }
    of.iter().map(|&c| keep[c as usize]).collect()
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() < 5 { eprintln!("usage: qsm_research DUMP_DIR LABELS u32|i32 OUT_PREFIX [cover_m] [min_nodes]"); std::process::exit(2); }
    let dir = std::path::Path::new(&a[1]);
    let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join("meta.json")).unwrap()).unwrap();
    let n = meta["n"].as_u64().unwrap() as usize;
    let pf = f32s(&std::fs::read(dir.join("p.f32")).unwrap());
    assert_eq!(pf.len(), 3 * n);
    let lb = std::fs::read(&a[2]).unwrap();
    let lab: Vec<i64> = lb.chunks_exact(4).map(|c| {
        let b: [u8; 4] = c.try_into().unwrap();
        if a[3] == "i32" { i32::from_le_bytes(b) as i64 } else { u32::from_le_bytes(b) as i64 }
    }).collect();
    assert_eq!(lab.len(), n);
    let d: f64 = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(0.12);
    let min_n: usize = a.get(6).and_then(|s| s.parse().ok()).unwrap_or(50);
    let mut by: BTreeMap<i64, Vec<u32>> = BTreeMap::new();
    for (i, &l) in lab.iter().enumerate() { if l > 0 { by.entry(l).or_default().push(i as u32); } }
    let mut trees: Vec<(i64, Vec<u32>)> = by.into_iter().filter(|(_, v)| v.len() >= min_n).collect();
    trees.sort_by(|x, y| y.1.len().cmp(&x.1.len()).then(x.0.cmp(&y.0)));
    let inp = QsmInputs::sweep_around_n(d, 1)[0];
    let t0 = Instant::now();
    let total = trees.len();
    let done = AtomicUsize::new(0);
    // a tree that runs past the limit is given up (its nodes get no segment)
    let far: f64 = std::env::var("QSM_FAR_M").ok().and_then(|s| s.parse().ok()).unwrap_or(15.0);
    let limit: f64 = std::env::var("QSM_TREE_SECONDS").ok().and_then(|s| s.parse().ok()).unwrap_or(180.0);
    let running: Arc<Mutex<Vec<(Instant, Arc<AtomicBool>, i64)>>> = Arc::new(Mutex::new(Vec::new()));
    let finished = Arc::new(AtomicBool::new(false));
    let dog = {
        let running = running.clone();
        let finished = finished.clone();
        std::thread::spawn(move || {
            while !finished.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(500));
                for (t, flag, l) in running.lock().unwrap().iter() {
                    if t.elapsed().as_secs_f64() > limit && !flag.swap(true, Ordering::Relaxed) {
                        eprintln!("tree {l}: given up after {limit} s");
                    }
                }
            }
        })
    };
    let models: Vec<(i64, Vec<u32>, Option<QsmModel>)> = trees.into_par_iter().map(|(l, idx)| {
        let pts: Vec<[f64; 3]> = idx.iter().map(|&i| {
            let k = 3 * i as usize;
            [pf[k] as f64, pf[k + 1] as f64, pf[k + 2] as f64]
        }).collect();
        let t = Instant::now();
        // the reference's outlier filter first, as the application runs
        // it: scattered nodes left in make the connection passes crawl
        let keep = filtering(&pts, &FilterParams::default());
        let idx: Vec<u32> = idx.iter().zip(&keep).filter(|&(_, &k)| k).map(|(&i, _)| i).collect();
        let pts: Vec<[f64; 3]> = pts.iter().zip(&keep).filter(|&(_, &k)| k).map(|(&q, _)| q).collect();
        let keep = near_main_body(&pts, far);
        let idx: Vec<u32> = idx.iter().zip(&keep).filter(|&(_, &k)| k).map(|(&i, _)| i).collect();
        let pts: Vec<[f64; 3]> = pts.iter().zip(&keep).filter(|&(_, &k)| k).map(|(&q, _)| q).collect();
        let flag = Arc::new(AtomicBool::new(false));
        running.lock().unwrap().push((Instant::now(), flag.clone(), l));
        let m = treeqsm_single_cancellable(&pts, &inp, Some(&flag));
        running.lock().unwrap().retain(|(_, f, _)| !Arc::ptr_eq(f, &flag));
        let k = done.fetch_add(1, Ordering::Relaxed) + 1;
        if t.elapsed().as_secs_f64() > 20.0 || k % 100 == 0 {
            eprintln!("{k}/{total} tree {l}: {} nodes {:.1} s (all {:.0} s)", pts.len(), t.elapsed().as_secs_f64(), t0.elapsed().as_secs_f64());
        }
        (l, idx, m)
    }).collect();
    finished.store(true, Ordering::Relaxed);
    let _ = dog.join();
    let mut seg_of_node = vec![0u32; n];
    let mut segs: Vec<serde_json::Value> = Vec::new();
    let mut cyl: Vec<f64> = Vec::new();
    // per cylinder: the radius as fitted (before the taper adjustments) and its points
    let mut raw: Vec<f64> = Vec::new();
    let mut next_seg = 1u32;
    let mut next_cyl = 0i64;
    let (mut fitted, mut failed) = (0usize, 0usize);
    for (l, idx, m) in &models {
        let Some(m) = m else { failed += 1; continue };
        fitted += 1;
        let cm = &m.cylinders;
        let nseg = cm.cyls_in_segment.len().max(m.segment_of_point.iter().filter(|&&s| s != u32::MAX).map(|&s| s as usize + 1).max().unwrap_or(0));
        let base = next_seg;
        next_seg += nseg as u32;
        let cyl_base = next_cyl;
        next_cyl += cm.cyl.len() as i64;
        for (k, &i) in idx.iter().enumerate() {
            let s = m.segment_of_point[k];
            if s != u32::MAX { seg_of_node[i as usize] = base + s; }
        }
        for s in 0..nseg {
            let cs: &[u32] = cm.cyls_in_segment.get(s).map(|v| v.as_slice()).unwrap_or(&[]);
            if cs.is_empty() {
                segs.push(serde_json::json!({ "id": base + s as u32, "tree": l, "ncyl": 0 }));
                continue;
            }
            let c0 = cs[0] as usize;
            let last = *cs.last().unwrap() as usize;
            let pc = cm.parent[c0].map(|p| p as usize);
            let tip = [
                cm.cyl.start[last][0] + cm.cyl.axis[last][0] * cm.cyl.length[last],
                cm.cyl.start[last][1] + cm.cyl.axis[last][1] * cm.cyl.length[last],
                cm.cyl.start[last][2] + cm.cyl.axis[last][2] * cm.cyl.length[last],
            ];
            segs.push(serde_json::json!({
                "id": base + s as u32, "tree": l, "ncyl": cs.len(),
                "parent": pc.map(|p| base + cm.branch[p]),
                "parent_cyl": pc.map(|p| cyl_base + p as i64),
                "parent_radius": pc.map(|p| cm.cyl.radius[p]),
                "order": cm.branch_order[c0],
                "r": cs.iter().map(|&c| cm.cyl.radius[c as usize]).collect::<Vec<_>>(),
                "added": cs.iter().map(|&c| cm.added[c as usize]).collect::<Vec<_>>(),
                "len": cs.iter().map(|&c| cm.cyl.length[c as usize]).sum::<f64>(),
                "base": cm.cyl.start[c0], "axis0": cm.cyl.axis[c0], "tip": tip,
            }));
        }
        for c in 0..cm.cyl.len() {
            cyl.extend_from_slice(&[
                (base + cm.branch[c]) as f64,
                cm.cyl.start[c][0], cm.cyl.start[c][1], cm.cyl.start[c][2],
                cm.cyl.axis[c][0], cm.cyl.axis[c][1], cm.cyl.axis[c][2],
                cm.cyl.length[c], cm.cyl.radius[c],
                cm.parent[c].map(|p| (cyl_base + p as i64) as f64).unwrap_or(-1.0),
                if cm.added[c] { 1.0 } else { 0.0 },
                *l as f64,
            ]);
            raw.extend_from_slice(&[cm.unmod_radius.get(c).copied().unwrap_or(f64::NAN), cm.region_points.get(c).copied().unwrap_or(0) as f64]);
        }
    }
    let out = &a[4];
    std::fs::write(format!("{out}_seg.u32"), seg_of_node.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    std::fs::write(format!("{out}_segs.json"), serde_json::to_vec(&segs).unwrap()).unwrap();
    std::fs::write(format!("{out}_cyl.f64"), cyl.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    std::fs::write(format!("{out}_cylraw.f64"), raw.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
    eprintln!("{fitted} trees fitted, {failed} not, {} segments, {} cylinders, {:.0} s", segs.len(), cyl.len() / 12, t0.elapsed().as_secs_f64());
}
