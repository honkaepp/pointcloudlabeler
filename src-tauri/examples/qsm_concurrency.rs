//! How the TreeQSM port scales when several trees are reconstructed at
//! once — the question a 3-hour plot run raised, where every tree took
//! ten to twenty times longer than it had taken on its own.
//!
//!     cargo run --release --example qsm_concurrency -- [points] [threads] [rounds]
//!
//! Generates one synthetic tree (trunk, branches, twigs; surface points
//! with noise), hands every thread its own copy, runs the reference's
//! filter and the reconstruction on all of them at the same time, and
//! prints what each took. Run it with 1 thread and then with as many as
//! the machine has: the ratio is the cost of concurrency on this
//! platform, with nothing shared between the trees but the allocator,
//! the caches and the memory bus.

use pointcloudlabeler_editor_lib::commands::treeqsm::{
    filtering, set_pass_trace, treeqsm_sweep_cancellable, FilterParams, PassTrace, QsmInputs, QsmMetric,
};
use std::sync::Arc;
use std::time::Instant;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12; self.0 ^= self.0 << 25; self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn f(&mut self) -> f64 { (self.next() >> 11) as f64 / (1u64 << 53) as f64 }
    fn range(&mut self, a: f64, b: f64) -> f64 { a + (b - a) * self.f() }
}

fn norm(v: [f64; 3]) -> [f64; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-12);
    [v[0] / l, v[1] / l, v[2] / l]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Points on the surface of a tapered cylinder from `a` to `b`, with a
/// little measurement noise.
fn sample_cylinder(rng: &mut Rng, a: [f64; 3], b: [f64; 3], r0: f64, r1: f64, n: usize, out: &mut Vec<[f64; 3]>) {
    let axis = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    let helper = if axis[2].abs() < 0.9 { [0.0, 0.0, 1.0] } else { [1.0, 0.0, 0.0] };
    let u = norm(cross(axis, helper));
    let v = cross(axis, u);
    for _ in 0..n {
        let t = rng.f();
        let r = r0 + (r1 - r0) * t;
        let ang = rng.range(0.0, std::f64::consts::TAU);
        let (c, s) = (ang.cos(), ang.sin());
        let noise = rng.range(-0.004, 0.004);
        let rr = r + noise;
        out.push([
            a[0] + (b[0] - a[0]) * t + (u[0] * c + v[0] * s) * rr,
            a[1] + (b[1] - a[1]) * t + (u[1] * c + v[1] * s) * rr,
            a[2] + (b[2] - a[2]) * t + (u[2] * c + v[2] * s) * rr,
        ]);
    }
}

/// A conifer-ish tree: 20 m trunk, sixty first-order branches, three
/// twigs on each. Points split by surface area so the trunk is dense
/// and the twigs sparse, as a scan would have them.
fn synthetic_tree(n_points: usize, seed: u64) -> Vec<[f64; 3]> {
    let mut rng = Rng(seed | 1);
    let h = 20.0;
    // Branch geometry first, so the surface areas can be summed.
    struct Seg { a: [f64; 3], b: [f64; 3], r0: f64, r1: f64 }
    let mut segs: Vec<Seg> = vec![Seg { a: [0.0, 0.0, 0.0], b: [0.0, 0.0, h], r0: 0.25, r1: 0.02 }];
    for _ in 0..60 {
        let z = rng.range(3.0, h - 0.5);
        let ang = rng.range(0.0, std::f64::consts::TAU);
        let tilt = rng.range(0.15, 0.6); // upward
        let len = rng.range(1.5, 5.0) * (1.0 - 0.5 * (z / h));
        let d = norm([ang.cos() * tilt.cos(), ang.sin() * tilt.cos(), tilt.sin()]);
        let rt = 0.25 + (0.02 - 0.25) * (z / h);
        let a = [d[0] * rt * 0.8, d[1] * rt * 0.8, z];
        let b = [a[0] + d[0] * len, a[1] + d[1] * len, a[2] + d[2] * len];
        let r0 = 0.035 * (1.0 - 0.6 * z / h);
        segs.push(Seg { a, b, r0, r1: r0 * 0.3 });
        for _ in 0..3 {
            let t = rng.range(0.3, 0.95);
            let p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
            let a2 = rng.range(0.0, std::f64::consts::TAU);
            let dd = norm([d[0] + 0.7 * a2.cos(), d[1] + 0.7 * a2.sin(), d[2] + rng.range(-0.2, 0.5)]);
            let l2 = len * rng.range(0.25, 0.5);
            let q = [p[0] + dd[0] * l2, p[1] + dd[1] * l2, p[2] + dd[2] * l2];
            let rr = r0 * 0.4;
            segs.push(Seg { a: p, b: q, r0: rr, r1: rr * 0.3 });
        }
    }
    let area: Vec<f64> = segs.iter().map(|s| {
        let l = ((s.b[0] - s.a[0]).powi(2) + (s.b[1] - s.a[1]).powi(2) + (s.b[2] - s.a[2]).powi(2)).sqrt();
        std::f64::consts::PI * (s.r0 + s.r1) * l
    }).collect();
    let total: f64 = area.iter().sum();
    let mut out = Vec::with_capacity(n_points + 1024);
    for (s, a) in segs.iter().zip(&area) {
        let n = ((a / total) * n_points as f64).round().max(8.0) as usize;
        sample_cylinder(&mut rng, s.a, s.b, s.r0, s.r1, n, &mut out);
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let n_points: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(300_000);
    let threads: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(1);
    let rounds: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);

    let t = Instant::now();
    let tree = synthetic_tree(n_points, 0x9E3779B97F4A7C15);
    println!("synthetic tree: {} points in {:.2} s; {} thread(s), {} round(s)", tree.len(), t.elapsed().as_secs_f64(), threads, rounds);

    let wall = Instant::now();
    let handles: Vec<_> = (0..threads).map(|k| {
        let pts = tree.clone();
        std::thread::Builder::new().name(format!("tree-{k}")).spawn(move || {
            let mut times = Vec::new();
            let mut last = String::new();
            for _ in 0..rounds {
                let t0 = Instant::now();
                let trace = Arc::new(PassTrace::default());
                set_pass_trace(Some(trace.clone()));
                let keep = filtering(&pts, &FilterParams::default());
                let kept: Vec<[f64; 3]> = pts.iter().zip(&keep).filter(|&(_, &k)| k).map(|(&q, _)| q).collect();
                let t_filter = t0.elapsed().as_secs_f64();
                let model = treeqsm_sweep_cancellable(
                    &kept, &QsmInputs::sweep_around_n(0.08, 1), QsmMetric::default(), None);
                set_pass_trace(None);
                let ncyl = model.as_ref().map(|m| m.cylinders.cyl.start.len()).unwrap_or(0);
                times.push((t0.elapsed().as_secs_f64(), t_filter, ncyl));
                last = trace.summary();
            }
            (k, times, last)
        }).expect("spawn")
    }).collect();
    let mut all = Vec::new();
    for h in handles {
        let (k, times, passes) = h.join().expect("join");
        for (i, (total, filt, ncyl)) in times.iter().enumerate() {
            println!("thread {k} round {i}: {total:.1} s total, filter {filt:.1} s, {ncyl} cylinders");
            all.push(*total);
        }
        println!("  thread {k} passes: {passes}");
    }
    let mean = all.iter().sum::<f64>() / all.len().max(1) as f64;
    let max = all.iter().cloned().fold(0.0, f64::max);
    let min = all.iter().cloned().fold(f64::INFINITY, f64::min);
    println!("per-tree: min {min:.1} s, mean {mean:.1} s, max {max:.1} s; wall {:.1} s for {} tree(s)",
             wall.elapsed().as_secs_f64(), threads * rounds);
}
