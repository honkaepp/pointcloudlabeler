//! A static k-d tree over f32 points, for one question: which of ten
//! million skeleton samples is nearest to this target point — at ANY
//! distance.
//!
//! The transfer used a uniform hash with a cell the size of the distance
//! threshold and looked in the 3 × 3 × 3 cells around a point. That
//! answers "is there a skeleton sample within the threshold" exactly and
//! "which sample is nearest" only within about two cells. "Label points
//! beyond the threshold" — the reference method's behaviour, and the
//! panel's default — then found nothing for a crown point half a metre
//! from any cylinder axis, and a HeliALS crown over a TLS skeleton came
//! out in patches: labelled where a branch happened to pass within
//! 30–45 cm, unlabelled everywhere else. The tree here answers the
//! nearest at any distance in O(log n).
//!
//! Layout: the points are stored in tree order, so a node is the middle
//! of its range and its children are the two halves — no pointers, no
//! per-node allocation. The split axis cycles x, y, z by depth; with
//! median splits the tree is balanced whatever the data.

pub struct KdTree3 {
    /// The points in tree order.
    pts: Vec<[f32; 3]>,
    /// For each tree slot, the index of that point in the input.
    ids: Vec<u32>,
}

/// Ranges longer than this split their build across two threads.
const PARALLEL_BUILD_MIN: usize = 1 << 16;

impl KdTree3 {
    pub fn build(points: &[[f32; 3]]) -> KdTree3 {
        let mut idx: Vec<u32> = (0..points.len() as u32).collect();
        build_rec(points, &mut idx, 0);
        let pts = idx.iter().map(|&i| points[i as usize]).collect();
        KdTree3 { pts, ids: idx }
    }

    pub fn len(&self) -> usize { self.pts.len() }
    pub fn is_empty(&self) -> bool { self.pts.is_empty() }

    /// The nearest point to `q` with squared distance below `max_d2`
    /// (pass `f32::INFINITY` for the nearest at any distance): its index
    /// in the input and the squared distance. None when nothing is that
    /// close.
    pub fn nearest(&self, q: [f32; 3], max_d2: f32) -> Option<(u32, f32)> {
        if self.pts.is_empty() { return None; }
        let mut best = (u32::MAX, max_d2);
        self.search(0, self.pts.len(), 0, q, &mut best);
        if best.0 == u32::MAX { None } else { Some((self.ids[best.0 as usize], best.1)) }
    }

    fn search(&self, lo: usize, hi: usize, depth: usize, q: [f32; 3], best: &mut (u32, f32)) {
        if lo >= hi { return; }
        let mid = lo + (hi - lo) / 2;
        let p = self.pts[mid];
        let dx = p[0] - q[0];
        let dy = p[1] - q[1];
        let dz = p[2] - q[2];
        let d2 = dx * dx + dy * dy + dz * dz;
        if d2 < best.1 { *best = (mid as u32, d2); }
        let axis = depth % 3;
        let diff = q[axis] - p[axis];
        let (near, far) = if diff < 0.0 { ((lo, mid), (mid + 1, hi)) } else { ((mid + 1, hi), (lo, mid)) };
        self.search(near.0, near.1, depth + 1, q, best);
        // The far side can only hold something closer if the splitting
        // plane itself is closer than the best so far.
        if diff * diff < best.1 {
            self.search(far.0, far.1, depth + 1, q, best);
        }
    }
}

fn build_rec(points: &[[f32; 3]], idx: &mut [u32], depth: usize) {
    let n = idx.len();
    if n <= 1 { return; }
    let axis = depth % 3;
    let mid = n / 2;
    idx.select_nth_unstable_by(mid, |&a, &b| {
        points[a as usize][axis].partial_cmp(&points[b as usize][axis]).unwrap_or(std::cmp::Ordering::Equal)
    });
    let (left, right) = idx.split_at_mut(mid);
    let right = &mut right[1..];
    if n >= PARALLEL_BUILD_MIN {
        rayon::join(|| build_rec(points, left, depth + 1), || build_rec(points, right, depth + 1));
    } else {
        build_rec(points, left, depth + 1);
        build_rec(points, right, depth + 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small deterministic generator — no rand dependency needed.
    fn lcg(seed: &mut u64) -> f32 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 33) as f32) / (1u64 << 31) as f32
    }

    fn brute(points: &[[f32; 3]], q: [f32; 3]) -> (u32, f32) {
        let mut best = (u32::MAX, f32::INFINITY);
        for (i, p) in points.iter().enumerate() {
            let d2 = (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2);
            if d2 < best.1 { best = (i as u32, d2); }
        }
        best
    }

    #[test]
    fn the_nearest_agrees_with_brute_force_at_any_distance() {
        let mut seed = 7u64;
        let points: Vec<[f32; 3]> = (0..5000).map(|_| [lcg(&mut seed) * 40.0, lcg(&mut seed) * 40.0, lcg(&mut seed) * 30.0]).collect();
        let tree = KdTree3::build(&points);
        assert_eq!(tree.len(), points.len());
        for _ in 0..500 {
            // Queries far outside the cloud too: the transfer asks about
            // crown points metres from any skeleton sample.
            let q = [lcg(&mut seed) * 80.0 - 20.0, lcg(&mut seed) * 80.0 - 20.0, lcg(&mut seed) * 60.0 - 15.0];
            let (bi, bd) = brute(&points, q);
            let (ti, td) = tree.nearest(q, f32::INFINITY).unwrap();
            assert!((td - bd).abs() <= 1e-4 * bd.max(1.0), "d2 {td} vs {bd}");
            if td == bd { assert_eq!(points[ti as usize], points[bi as usize]); }
        }
    }

    #[test]
    fn a_bound_is_the_threshold_the_transfer_asks_with() {
        let points = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 3.0, 0.0]];
        let tree = KdTree3::build(&points);
        // 0.1 m from the second point: within a 0.3 m threshold.
        let (i, d2) = tree.nearest([0.9, 0.0, 0.0], 0.3 * 0.3).unwrap();
        assert_eq!(i, 1);
        assert!((d2 - 0.01).abs() < 1e-6);
        // 0.5 m from anything: not within 0.3 m — and found unbounded.
        assert!(tree.nearest([0.5, 0.0, 0.5], 0.3 * 0.3).is_none());
        let (i, _) = tree.nearest([0.5, 0.0, 0.5], f32::INFINITY).unwrap();
        assert!(i == 0 || i == 1);
        assert!(KdTree3::build(&[]).nearest([0.0; 3], f32::INFINITY).is_none());
    }

    #[test]
    fn duplicates_and_a_degenerate_axis_build_and_answer() {
        // Every point on one line with many duplicates: the median
        // splits still terminate and the nearest is exact.
        let points: Vec<[f32; 3]> = (0..3000).map(|i| [0.0, 0.0, (i % 7) as f32]).collect();
        let tree = KdTree3::build(&points);
        let (_, d2) = tree.nearest([0.0, 0.0, 3.4], f32::INFINITY).unwrap();
        assert!((d2 - 0.16).abs() < 1e-5, "{d2}");
    }
}
