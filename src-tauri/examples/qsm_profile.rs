//! Profile the TreeQSM port on one tree, pass by pass.
//!
//!     cargo run --release --example qsm_profile -- tree.laz [patch_diam_m] [models]
//!
//! Reads a LAS/LAZ file (every point is the tree) or a text file of
//! `x y z` / `x,y,z` rows, runs the reference's outlier filter and the
//! reconstruction the skeleton build runs, and prints which pass is
//! running every ten seconds and what each took at the end — the tool
//! for a tree that took sixteen hours in the application.

use pointcloudlabeler_editor_lib::commands::treeqsm::{
    filtering, set_pass_trace, treeqsm_sweep_cancellable, FilterParams, PassTrace, QsmInputs, QsmMetric,
};
use std::sync::Arc;
use std::time::Instant;

fn read_points(path: &str) -> Vec<[f64; 3]> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".las") || lower.ends_with(".laz") {
        let mut reader = las::Reader::from_path(path).expect("open las/laz");
        let mut out = Vec::new();
        for p in reader.points() {
            let p = p.expect("read point");
            out.push([p.x, p.y, p.z]);
        }
        return out;
    }
    let text = std::fs::read_to_string(path).expect("read text file");
    text.lines()
        .filter_map(|l| {
            let mut it = l.split(|c: char| c == ',' || c.is_whitespace()).filter(|t| !t.is_empty());
            let x = it.next()?.parse().ok()?;
            let y = it.next()?.parse().ok()?;
            let z = it.next()?.parse().ok()?;
            Some([x, y, z])
        })
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("usage: qsm_profile <tree.laz|tree.txt> [patch_diam_m] [models]");
    let patch: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.08);
    let models: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);

    let t = Instant::now();
    let raw = read_points(path);
    println!("{} points read in {:.1} s", raw.len(), t.elapsed().as_secs_f64());

    // The trace goes on before the filter, so its stages show too:
    // on a dense trunk the filter used to be most of a tree's time.
    let trace = Arc::new(PassTrace::default());
    set_pass_trace(Some(trace.clone()));
    let t = Instant::now();
    let keep = filtering(&raw, &FilterParams::default());
    let pts: Vec<[f64; 3]> = raw.iter().zip(&keep).filter(|&(_, &k)| k).map(|(&q, _)| q).collect();
    println!("{} points after the reference filter ({:.1} s)", pts.len(), t.elapsed().as_secs_f64());

    let reporter = {
        let trace = trace.clone();
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done2 = done.clone();
        let h = std::thread::spawn(move || {
            while !done2.load(std::sync::atomic::Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_secs(10));
                println!("  … {}", trace.summary());
            }
        });
        (h, done)
    };

    let t = Instant::now();
    let model = treeqsm_sweep_cancellable(
        &pts, &QsmInputs::sweep_around_n(patch, models), QsmMetric::default(), None);
    set_pass_trace(None);
    reporter.1.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = reporter.0.join();

    println!("reconstruction: {:.1} s", t.elapsed().as_secs_f64());
    println!("passes: {}", trace.summary());
    match model {
        Some(m) => println!("cylinders: {}, branches: {}", m.cylinders.cyl.start.len(), m.branches.angle.len()),
        None => println!("no model"),
    }
}
