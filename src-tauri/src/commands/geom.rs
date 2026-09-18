// Convex hulls, Delaunay triangulations and alpha shapes.
//
// Written for TreeQSM's `crown_measures`, which needs MATLAB's
// `convhull` and `alphaShape` in two and three dimensions and has no
// other way to get a crown area or a crown volume. Nothing here is
// ported: these are textbook constructions, and they are in their own
// module because they are about geometry rather than about trees.
//
// WHY THE POINTS ARE MOVED BY A NANOMETRE FIRST. Bowyer-Watson needs
// to decide whether a point lies inside a circumsphere, and the answer
// is undefined when four points are exactly cocircular or five exactly
// cospherical. That is not a rare case here — it is the normal one.
// The crown cloud is generated ON THE SURFACES OF CYLINDERS: twelve
// points to a ring, four rings to a stem cylinder, every ring at the
// same radius about the same axis. Projected to the ground they lie on
// exact circles, and in space on exact spheres. Left alone, the
// predicates return whatever the rounding gives and the triangulation
// comes out invalid.
//
// So every coordinate is displaced by a deterministic amount of order
// 1e-9 of the cloud's own size — a nanometre on a ten-metre tree —
// derived from the point's index, before the triangulation is built.
// That is seven orders of magnitude above the rounding error of the
// predicates and seven orders below anything a laser scanner can
// measure. The ORIGINAL coordinates are used for every area and volume
// that comes out, so the numbers reported are a function of the input
// and not of the displacement; only which triangles exist depends on
// it, and only where the choice was arbitrary to begin with.

use rustc_hash::FxHashMap;

/// Deterministic displacement in [-1, 1) for coordinate `k` of point
/// `i`. splitmix64, so two neighbouring indices are not neighbouring
/// displacements.
fn wobble(i: usize, k: usize) -> f64 {
    let mut z = (i as u64)
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        .wrapping_add((k as u64).wrapping_mul(0xBF58_476D_1CE4_E5B9));
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    (z as f64 / u64::MAX as f64) * 2.0 - 1.0
}

// ===================================================================
// Two dimensions
// ===================================================================

/// The convex hull of `p`, as indices into it, counter-clockwise and
/// without repeating the first point.
///
/// Empty when the points are fewer than three or all on one line —
/// MATLAB's `convhull` raises an error there, and a caller that has to
/// cope with a degenerate crown is better served by an empty hull.
pub fn convex_hull_2d(p: &[[f64; 2]]) -> Vec<usize> {
    let n = p.len();
    if n < 3 { return Vec::new(); }
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|&a, &b| p[a][0].partial_cmp(&p[b][0])
        .unwrap_or(std::cmp::Ordering::Equal)
        .then(p[a][1].partial_cmp(&p[b][1]).unwrap_or(std::cmp::Ordering::Equal)));
    idx.dedup_by(|&mut a, &mut b| p[a] == p[b]);
    if idx.len() < 3 { return Vec::new(); }

    let cross = |o: usize, a: usize, b: usize| {
        (p[a][0] - p[o][0]) * (p[b][1] - p[o][1]) - (p[a][1] - p[o][1]) * (p[b][0] - p[o][0])
    };
    let mut hull: Vec<usize> = Vec::with_capacity(2 * idx.len());
    for &i in &idx {
        while hull.len() >= 2 && cross(hull[hull.len() - 2], hull[hull.len() - 1], i) <= 0.0 {
            hull.pop();
        }
        hull.push(i);
    }
    let lower = hull.len() + 1;
    for &i in idx.iter().rev().skip(1) {
        while hull.len() >= lower && cross(hull[hull.len() - 2], hull[hull.len() - 1], i) <= 0.0 {
            hull.pop();
        }
        hull.push(i);
    }
    hull.pop();
    if hull.len() < 3 { return Vec::new(); }
    hull
}

/// The signed area of a closed polygon, positive counter-clockwise.
pub fn polygon_signed_area(poly: &[[f64; 2]]) -> f64 {
    let n = poly.len();
    if n < 3 { return 0.0; }
    let mut s = 0.0;
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        s += a[0] * b[1] - b[0] * a[1];
    }
    s / 2.0
}

/// The centroid of a closed polygon — its centre of area, not the mean
/// of its vertices. The reference computes exactly this, by hand, to
/// have a centre to measure crown diameters from; taking the mean of
/// the hull's vertices instead would pull the centre towards whichever
/// side happened to be described by more of them.
pub fn polygon_centroid(poly: &[[f64; 2]]) -> Option<[f64; 2]> {
    let a = polygon_signed_area(poly);
    if a.abs() < 1e-15 { return None; }
    let n = poly.len();
    let (mut cx, mut cy) = (0.0, 0.0);
    for i in 0..n {
        let (p, q) = (poly[i], poly[(i + 1) % n]);
        let w = p[0] * q[1] - q[0] * p[1];
        cx += (p[0] + q[0]) * w;
        cy += (p[1] + q[1]) * w;
    }
    Some([cx / (6.0 * a), cy / (6.0 * a)])
}

/// Whether `q` is inside a closed polygon, its boundary counted as
/// inside — MATLAB's `inpolygon` with both outputs taken together,
/// which is what its callers here rely on.
///
/// Ray casting with the half-open rule on the y comparison, so a
/// vertex is counted once rather than twice, and an explicit
/// on-the-edge test in front because the crossing count says nothing
/// useful about a point lying exactly on a boundary.
///
/// Two things here have a mirror image that behaves identically and no
/// test can tell them apart, which is worth saying rather than leaving
/// for someone to rediscover: `>` could be `>=` on the y comparison —
/// the rule then takes the lower vertex of each edge instead of the
/// upper, and each vertex is still counted once — and the ray could be
/// cast in -x instead of +x, which is what flipping the `<` on the
/// crossing does. Both give the same parity for a closed polygon, and
/// the on-the-edge test in front is what makes the boundary case
/// independent of either choice.
pub fn point_in_polygon(poly: &[[f64; 2]], q: [f64; 2]) -> bool {
    let n = poly.len();
    if n < 3 { return false; }
    let mut inside = false;
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        // On the edge?
        let cross = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
        if cross.abs() <= 1e-12 * ((b[0] - a[0]).abs() + (b[1] - a[1]).abs()).max(1.0)
            && q[0] >= a[0].min(b[0]) - 1e-12 && q[0] <= a[0].max(b[0]) + 1e-12
            && q[1] >= a[1].min(b[1]) - 1e-12 && q[1] <= a[1].max(b[1]) + 1e-12
        {
            return true;
        }
        if (a[1] > q[1]) != (b[1] > q[1]) {
            let t = (q[1] - a[1]) / (b[1] - a[1]);
            if q[0] < a[0] + t * (b[0] - a[0]) { inside = !inside; }
        }
    }
    inside
}

/// Triangulate a simple polygon by ear clipping, as triples of indices
/// into it.
///
/// The reference caps its stem mesh with MATLAB's
/// `delaunayTriangulation` under the polygon's own edges as
/// constraints, then keeps the triangles `isInterior` reports. That is
/// a constrained Delaunay triangulation followed by a point-in-polygon
/// test, and it exists to fill the polygon — the reference then checks
/// that the triangles it kept add up to `polyarea` and throws the whole
/// model away if they do not. Ear clipping fills the same polygon with
/// different triangles of the same total area, and the cap's
/// contribution to the volume depends only on the surface and not on
/// how it was cut up. Returns nothing for a polygon that crosses
/// itself, which is the case the reference's area check catches.
pub fn ear_clip(poly: &[[f64; 2]]) -> Vec<[usize; 3]> {
    let n = poly.len();
    let mut out = Vec::new();
    if n < 3 { return out; }
    let ccw = polygon_signed_area(poly) > 0.0;
    let mut idx: Vec<usize> = (0..n).collect();
    // A vertex is convex when the turn at it goes the polygon's own way.
    let convex = |a: [f64; 2], b: [f64; 2], c: [f64; 2]| {
        let cr = orient2(a, b, c);
        if ccw { cr > 0.0 } else { cr < 0.0 }
    };
    let mut guard = 0usize;
    while idx.len() > 3 && guard < 4 * n * n {
        guard += 1;
        let m = idx.len();
        let mut clipped = false;
        for k in 0..m {
            let (ia, ib, ic) = (idx[(k + m - 1) % m], idx[k], idx[(k + 1) % m]);
            let (a, b, c) = (poly[ia], poly[ib], poly[ic]);
            if !convex(a, b, c) { continue; }
            // No other vertex of the remaining polygon inside the ear.
            let mut clean = true;
            for &j in &idx {
                if j == ia || j == ib || j == ic { continue; }
                if point_in_triangle(poly[j], a, b, c) { clean = false; break; }
            }
            if !clean { continue; }
            out.push([ia, ib, ic]);
            idx.remove(k);
            clipped = true;
            break;
        }
        if !clipped { return Vec::new(); }
    }
    if idx.len() == 3 { out.push([idx[0], idx[1], idx[2]]); }
    out
}

fn point_in_triangle(q: [f64; 2], a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> bool {
    let d1 = orient2(a, b, q);
    let d2 = orient2(b, c, q);
    let d3 = orient2(c, a, q);
    let neg = d1 < 0.0 || d2 < 0.0 || d3 < 0.0;
    let pos = d1 > 0.0 || d2 > 0.0 || d3 > 0.0;
    !(neg && pos)
}

/// A Delaunay triangulation of `p`, as triples of indices.
///
/// Duplicated points are tolerated but wasteful; de-duplicate first.
pub struct Delaunay2 {
    pub tris: Vec<[usize; 3]>,
    /// Points that could not be inserted without breaking the
    /// triangulation, which the displacement above is there to prevent.
    pub skipped: usize,
}

struct Tri {
    v: [usize; 3],
    /// The triangle across the edge opposite `v[i]`, or -1.
    nb: [i32; 3],
    dead: bool,
}

/// The edge of a triangle opposite vertex `i`, ordered so that the
/// triangle's own interior is on its left.
const EDGE: [[usize; 2]; 3] = [[1, 2], [2, 0], [0, 1]];

fn orient2(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Positive when `d` is strictly inside the circumcircle of the
/// counter-clockwise triangle `abc`.
fn in_circle(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> f64 {
    let (ax, ay) = (a[0] - d[0], a[1] - d[1]);
    let (bx, by) = (b[0] - d[0], b[1] - d[1]);
    let (cx, cy) = (c[0] - d[0], c[1] - d[1]);
    let a2 = ax * ax + ay * ay;
    let b2 = bx * bx + by * by;
    let c2 = cx * cx + cy * cy;
    ax * (by * c2 - b2 * cy) - ay * (bx * c2 - b2 * cx) + a2 * (bx * cy - by * cx)
}

pub fn delaunay_2d(p: &[[f64; 2]]) -> Delaunay2 {
    let n = p.len();
    let mut out = Delaunay2 { tris: Vec::new(), skipped: 0 };
    if n < 3 { return out; }

    // Displace, then enclose everything in one huge triangle.
    let mut lo = [f64::INFINITY; 2];
    let mut hi = [f64::NEG_INFINITY; 2];
    for q in p { for k in 0..2 { lo[k] = lo[k].min(q[k]); hi[k] = hi[k].max(q[k]); } }
    let diag = ((hi[0] - lo[0]).powi(2) + (hi[1] - lo[1]).powi(2)).sqrt();
    if !(diag.is_finite() && diag > 0.0) { return out; }
    let eps = diag * 1e-9;
    let mut q: Vec<[f64; 2]> = (0..n)
        .map(|i| [p[i][0] + eps * wobble(i, 0), p[i][1] + eps * wobble(i, 1)])
        .collect();
    let c = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0];
    let m = diag * 100.0;
    q.push([c[0], c[1] + 2.0 * m]);
    q.push([c[0] - 1.8 * m, c[1] - m]);
    q.push([c[0] + 1.8 * m, c[1] - m]);

    let mut t = vec![Tri { v: [n, n + 1, n + 2], nb: [-1, -1, -1], dead: false }];
    let mut here = 0usize;
    let mut cavity: Vec<usize> = Vec::new();
    let mut border: Vec<(usize, usize, i32)> = Vec::new();   // two vertices, outside
    let mut mark: Vec<u32> = vec![0; 1];
    let mut gen = 0u32;

    'point: for i in 0..n {
        let x = q[i];
        // Walk to the triangle containing x.
        let Some(start) = walk2(&t, &q, here, x) else { out.skipped += 1; continue };
        here = start;

        // Every triangle whose circumcircle swallows x, reachable from
        // the one it sits in.
        gen += 1;
        mark.resize(t.len(), 0);
        cavity.clear();
        cavity.push(start);
        mark[start] = gen;
        let mut stack = vec![start];
        while let Some(u) = stack.pop() {
            for e in 0..3 {
                let nb = t[u].nb[e];
                if nb < 0 { continue; }
                let nb = nb as usize;
                if mark[nb] == gen || t[nb].dead { continue; }
                let w = &t[nb].v;
                if in_circle(q[w[0]], q[w[1]], q[w[2]], x) > 0.0 {
                    mark[nb] = gen;
                    cavity.push(nb);
                    stack.push(nb);
                }
            }
        }

        // The new triangles must all come out the right way round. If
        // one would not, the cavity is not star-shaped about x; grow it
        // across the offending edge and look again. See the note on the
        // same loop in three dimensions.
        for _ in 0..16 {
            border.clear();
            for &u in &cavity {
                for (e, ed) in EDGE.iter().enumerate() {
                    let nb = t[u].nb[e];
                    if nb >= 0 && mark[nb as usize] == gen { continue; }
                    border.push((t[u].v[ed[0]], t[u].v[ed[1]], nb));
                }
            }
            let mut grew = false;
            for &(a, b, nb) in &border {
                if orient2(q[a], q[b], x) > 0.0 { continue; }
                if nb < 0 { out.skipped += 1; continue 'point; }
                mark[nb as usize] = gen;
                cavity.push(nb as usize);
                grew = true;
            }
            if !grew { break; }
        }
        if border.iter().any(|&(a, b, _)| orient2(q[a], q[b], x) <= 0.0) {
            out.skipped += 1;
            continue;
        }

        for &u in &cavity { t[u].dead = true; }
        let first = t.len();
        for (k, &(a, b, outside)) in border.iter().enumerate() {
            t.push(Tri { v: [a, b, i], nb: [-1, -1, outside], dead: false });
            let me = (first + k) as i32;
            if outside >= 0 {
                let o = outside as usize;
                for (e, ed) in EDGE.iter().enumerate() {
                    let (x0, x1) = (t[o].v[ed[0]], t[o].v[ed[1]]);
                    if x0 == b && x1 == a { t[o].nb[e] = me; }
                }
            }
        }
        // Glue the new triangles to each other along the spokes to x:
        // triangle (a, b, x) meets (b, c, x) along the spoke at b.
        for k in 0..border.len() {
            for l in 0..border.len() {
                // Edge 0 of k is (b_k, x); edge 1 of l is (x, a_l).
                if k != l && border[k].1 == border[l].0 {
                    t[first + k].nb[0] = (first + l) as i32;
                    t[first + l].nb[1] = (first + k) as i32;
                }
            }
        }
        here = first;
    }

    for tr in &t {
        if tr.dead { continue; }
        if tr.v.iter().any(|&v| v >= n) { continue; }
        out.tris.push(tr.v);
    }
    out
}

/// Walk from `from` to the triangle containing `x`.
fn walk2(t: &[Tri], q: &[[f64; 2]], from: usize, x: [f64; 2]) -> Option<usize> {
    let mut u = if t[from].dead { t.iter().rposition(|tr| !tr.dead)? } else { from };
    for step in 0..(4 * t.len() + 64) {
        let mut moved = false;
        for k in 0..3 {
            let e = (k + step) % 3;
            let (a, b) = (t[u].v[EDGE[e][0]], t[u].v[EDGE[e][1]]);
            if orient2(q[a], q[b], x) < 0.0 {
                let nb = t[u].nb[e];
                if nb < 0 { return None; }
                u = nb as usize;
                moved = true;
                break;
            }
        }
        if !moved { return Some(u); }
    }
    None
}

/// The circumradius of a triangle, or infinity when it is degenerate.
pub fn circumradius_2d(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    let ab = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
    let bc = ((c[0] - b[0]).powi(2) + (c[1] - b[1]).powi(2)).sqrt();
    let ca = ((a[0] - c[0]).powi(2) + (a[1] - c[1]).powi(2)).sqrt();
    let area2 = orient2(a, b, c).abs();
    if area2 <= 0.0 { return f64::INFINITY; }
    ab * bc * ca / (2.0 * area2)
}

/// The area of the alpha shape of `p` — MATLAB's `alphaShape(x,y,alpha).area`.
///
/// The alpha complex is every Delaunay triangle whose circumcircle is
/// no larger than `alpha`, which is what a probe circle of that radius
/// cannot roll into. With `alpha` large it is the convex hull; with
/// `alpha` small it is nothing.
pub fn alpha_area_2d(p: &[[f64; 2]], alpha: f64) -> f64 {
    let d = delaunay_2d(p);
    let mut a = 0.0;
    for t in &d.tris {
        let (x, y, z) = (p[t[0]], p[t[1]], p[t[2]]);
        if circumradius_2d(x, y, z) <= alpha { a += orient2(x, y, z).abs() / 2.0; }
    }
    a
}

// ===================================================================
// Three dimensions
// ===================================================================

/// A Delaunay tetrahedralisation.
pub struct Delaunay3 {
    pub tets: Vec<[usize; 4]>,
    /// The tetrahedron across the face opposite `tets[i][k]`, or -1
    /// where that face is on the convex hull.
    pub nb: Vec<[i32; 4]>,
    pub skipped: usize,
}

struct Tet {
    v: [usize; 4],
    nb: [i32; 4],
    dead: bool,
}

/// The face opposite vertex `i`, ordered so that the tetrahedron's own
/// interior is on the positive side: `orient3(face, v[i]) > 0`.
const FACE: [[usize; 3]; 4] = [[1, 3, 2], [0, 2, 3], [0, 3, 1], [0, 1, 2]];

pub fn orient3(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> f64 {
    let u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let w = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    u[0] * (v[1] * w[2] - v[2] * w[1])
        - u[1] * (v[0] * w[2] - v[2] * w[0])
        + u[2] * (v[0] * w[1] - v[1] * w[0])
}

/// Positive when `e` is strictly inside the circumsphere of the
/// positively oriented tetrahedron `abcd`.
fn in_sphere(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3], e: [f64; 3]) -> f64 {
    let row = |x: [f64; 3]| {
        let r = [x[0] - e[0], x[1] - e[1], x[2] - e[2]];
        [r[0], r[1], r[2], r[0] * r[0] + r[1] * r[1] + r[2] * r[2]]
    };
    let (m0, m1, m2, m3) = (row(a), row(b), row(c), row(d));
    // 4x4 determinant by cofactor expansion along the last column.
    let det3 = |p: [f64; 4], q: [f64; 4], r: [f64; 4], i: usize, j: usize, k: usize| {
        p[i] * (q[j] * r[k] - q[k] * r[j]) - p[j] * (q[i] * r[k] - q[k] * r[i])
            + p[k] * (q[i] * r[j] - q[j] * r[i])
    };
    // Expanded along the last column, then negated: the raw
    // determinant is positive OUTSIDE, and every caller here wants the
    // usual convention where inside is positive.
    -(-m0[3] * det3(m1, m2, m3, 0, 1, 2) + m1[3] * det3(m0, m2, m3, 0, 1, 2)
        - m2[3] * det3(m0, m1, m3, 0, 1, 2) + m3[3] * det3(m0, m1, m2, 0, 1, 2))
}

pub fn delaunay_3d(p: &[[f64; 3]]) -> Delaunay3 {
    let n = p.len();
    let mut out = Delaunay3 { tets: Vec::new(), nb: Vec::new(), skipped: 0 };
    if n < 4 { return out; }

    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for x in p { for k in 0..3 { lo[k] = lo[k].min(x[k]); hi[k] = hi[k].max(x[k]); } }
    let diag = (0..3).map(|k| (hi[k] - lo[k]).powi(2)).sum::<f64>().sqrt();
    if !(diag.is_finite() && diag > 0.0) { return out; }
    let eps = diag * 1e-9;
    let mut q: Vec<[f64; 3]> = (0..n).map(|i| {
        [p[i][0] + eps * wobble(i, 0),
         p[i][1] + eps * wobble(i, 1),
         p[i][2] + eps * wobble(i, 2)]
    }).collect();

    // A regular tetrahedron of circumradius 100 * the cloud's own,
    // about its centre, so every point is well inside it.
    let c = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0];
    let r = diag * 100.0;
    let (s2, s6) = (2.0f64.sqrt(), 6.0f64.sqrt());
    let sup = [
        [c[0], c[1], c[2] + r],
        [c[0], c[1] + 2.0 * s2 / 3.0 * r, c[2] - r / 3.0],
        [c[0] - s6 / 3.0 * r, c[1] - s2 / 3.0 * r, c[2] - r / 3.0],
        [c[0] + s6 / 3.0 * r, c[1] - s2 / 3.0 * r, c[2] - r / 3.0],
    ];
    for s in sup { q.push(s); }
    let mut root = [n, n + 1, n + 2, n + 3];
    if orient3(q[root[0]], q[root[1]], q[root[2]], q[root[3]]) < 0.0 { root.swap(1, 2); }

    let mut t = vec![Tet { v: root, nb: [-1; 4], dead: false }];
    let mut here = 0usize;
    let mut mark: Vec<u32> = vec![0; 1];
    let mut gen = 0u32;
    let mut cavity: Vec<usize> = Vec::new();
    let mut border: Vec<([usize; 3], i32)> = Vec::new();
    let mut spokes: FxHashMap<(usize, usize), (usize, usize)> = FxHashMap::default();

    'point: for i in 0..n {
        let x = q[i];
        let Some(start) = walk3(&t, &q, here, x) else { out.skipped += 1; continue };
        here = start;

        // The cavity: every tetrahedron reachable from `start` whose
        // circumsphere swallows x.
        gen += 1;
        mark.resize(t.len(), 0);
        cavity.clear();
        cavity.push(start);
        mark[start] = gen;
        let mut stack = vec![start];
        while let Some(u) = stack.pop() {
            for f in 0..4 {
                let nb = t[u].nb[f];
                if nb < 0 { continue; }
                let nb = nb as usize;
                if mark[nb] == gen || t[nb].dead { continue; }
                let w = &t[nb].v;
                if in_sphere(q[w[0]], q[w[1]], q[w[2]], q[w[3]], x) > 0.0 {
                    mark[nb] = gen;
                    cavity.push(nb);
                    stack.push(nb);
                }
            }
        }

        // In exact arithmetic the cavity is star-shaped about x and
        // every face of its boundary makes a properly oriented
        // tetrahedron with x. In floating point, on the cospherical
        // input this module exists to survive, a sliver on the boundary
        // can fail that. Growing the cavity across the offending face
        // repairs it — the enlarged cavity is still a union of
        // circumspheres containing x — and the loop is bounded because
        // a cavity that reaches the enclosing tetrahedron's own faces
        // cannot grow further, at which point the point is left out.
        for _ in 0..16 {
            border.clear();
            for &u in &cavity {
                for (f, g) in FACE.iter().enumerate() {
                    let nb = t[u].nb[f];
                    if nb >= 0 && mark[nb as usize] == gen { continue; }
                    border.push(([t[u].v[g[0]], t[u].v[g[1]], t[u].v[g[2]]], nb));
                }
            }
            let mut grew = false;
            for &(f, nb) in &border {
                if orient3(q[f[0]], q[f[1]], q[f[2]], x) > 0.0 { continue; }
                if nb < 0 { out.skipped += 1; continue 'point; }
                mark[nb as usize] = gen;
                cavity.push(nb as usize);
                grew = true;
            }
            if !grew { break; }
        }
        if border.is_empty()
            || border.iter().any(|&(f, _)| orient3(q[f[0]], q[f[1]], q[f[2]], x) <= 0.0)
        {
            out.skipped += 1;
            continue;
        }

        for &u in &cavity { t[u].dead = true; }
        let first = t.len();
        spokes.clear();
        for (k, &(f, outside)) in border.iter().enumerate() {
            t.push(Tet { v: [f[0], f[1], f[2], i], nb: [-1, -1, -1, outside], dead: false });
            if outside >= 0 {
                let me = (first + k) as i32;
                let o = outside as usize;
                for (e, w) in FACE.iter().enumerate() {
                    let g = [t[o].v[w[0]], t[o].v[w[1]], t[o].v[w[2]]];
                    if same_face(g, f) { t[o].nb[e] = me; }
                }
            }
        }
        // Glue the new tetrahedra to one another. Face `e` of the new
        // tetrahedron on border face f is the one holding x and the
        // edge of f opposite f[e]; two new tetrahedra meet where they
        // name the same edge.
        for (k, &(f, _)) in border.iter().enumerate() {
            for e in 0..3 {
                let (u, v) = (f[(e + 1) % 3], f[(e + 2) % 3]);
                let key = (u.min(v), u.max(v));
                match spokes.remove(&key) {
                    Some((l, e2)) => {
                        t[first + k].nb[e] = (first + l) as i32;
                        t[first + l].nb[e2] = (first + k) as i32;
                    }
                    None => { spokes.insert(key, (k, e)); }
                }
            }
        }
        here = first;
    }

    // Drop the enclosing tetrahedron's own, and renumber.
    let mut map = vec![-1i32; t.len()];
    for (u, te) in t.iter().enumerate() {
        if te.dead || te.v.iter().any(|&v| v >= n) { continue; }
        map[u] = out.tets.len() as i32;
        out.tets.push(te.v);
    }
    for (u, te) in t.iter().enumerate() {
        if map[u] < 0 { continue; }
        let mut nb = [-1i32; 4];
        for f in 0..4 {
            if te.nb[f] >= 0 { nb[f] = map[te.nb[f] as usize]; }
        }
        out.nb.push(nb);
    }
    out
}

fn same_face(a: [usize; 3], b: [usize; 3]) -> bool {
    let (mut x, mut y) = (a, b);
    x.sort_unstable();
    y.sort_unstable();
    x == y
}

fn walk3(t: &[Tet], q: &[[f64; 3]], from: usize, x: [f64; 3]) -> Option<usize> {
    let mut u = if t[from].dead { t.iter().rposition(|te| !te.dead)? } else { from };
    for step in 0..(4 * t.len() + 64) {
        let mut moved = false;
        for k in 0..4 {
            let f = (k + step) % 4;
            let g = [t[u].v[FACE[f][0]], t[u].v[FACE[f][1]], t[u].v[FACE[f][2]]];
            if orient3(q[g[0]], q[g[1]], q[g[2]], x) < 0.0 {
                let nb = t[u].nb[f];
                if nb < 0 { return None; }
                u = nb as usize;
                moved = true;
                break;
            }
        }
        if !moved { return Some(u); }
    }
    None
}

/// The volume of a tetrahedron.
pub fn tet_volume(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> f64 {
    orient3(a, b, c, d).abs() / 6.0
}

/// The circumradius of a tetrahedron, or infinity when it is flat.
pub fn circumradius_3d(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> f64 {
    // Solve for the centre: |x-a|^2 = |x-b|^2 = |x-c|^2 = |x-d|^2.
    let row = |x: [f64; 3]| {
        [2.0 * (x[0] - a[0]), 2.0 * (x[1] - a[1]), 2.0 * (x[2] - a[2]),
         x[0] * x[0] + x[1] * x[1] + x[2] * x[2] - a[0] * a[0] - a[1] * a[1] - a[2] * a[2]]
    };
    let m = [row(b), row(c), row(d)];
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    if det == 0.0 || !det.is_finite() { return f64::INFINITY; }
    let sub = |k: usize| {
        let mut n = m;
        for r in 0..3 { n[r][k] = m[r][3]; }
        n[0][0] * (n[1][1] * n[2][2] - n[1][2] * n[2][1])
            - n[0][1] * (n[1][0] * n[2][2] - n[1][2] * n[2][0])
            + n[0][2] * (n[1][0] * n[2][1] - n[1][1] * n[2][0])
    };
    let ctr = [sub(0) / det, sub(1) / det, sub(2) / det];
    ((ctr[0] - a[0]).powi(2) + (ctr[1] - a[1]).powi(2) + (ctr[2] - a[2]).powi(2)).sqrt()
}

/// The volume of the convex hull of `p`.
///
/// The Delaunay tetrahedra of a point set tile its convex hull exactly,
/// so this is their total volume and needs no separate hull.
pub fn convex_hull_volume_3d(p: &[[f64; 3]]) -> f64 {
    let d = delaunay_3d(p);
    d.tets.iter().map(|t| tet_volume(p[t[0]], p[t[1]], p[t[2]], p[t[3]])).sum()
}

/// The volume of the alpha shape of `p` — MATLAB's
/// `alphaShape(x,y,z,alpha,'HoleThreshold',hole).volume`.
///
/// Every Delaunay tetrahedron whose circumsphere is no larger than
/// `alpha`, plus any enclosed void smaller than `hole` — a void being a
/// group of excluded tetrahedra with no way out to the hull, which is
/// what "HoleThreshold" fills.
pub fn alpha_volume_3d(p: &[[f64; 3]], alpha: f64, hole: f64) -> f64 {
    let d = delaunay_3d(p);
    let nt = d.tets.len();
    if nt == 0 { return 0.0; }
    let vol: Vec<f64> = d.tets.iter()
        .map(|t| tet_volume(p[t[0]], p[t[1]], p[t[2]], p[t[3]])).collect();
    let inside: Vec<bool> = d.tets.iter()
        .map(|t| circumradius_3d(p[t[0]], p[t[1]], p[t[2]], p[t[3]]) <= alpha)
        .collect();
    let mut total: f64 = (0..nt).filter(|&i| inside[i]).map(|i| vol[i]).sum();

    // Components of the excluded tetrahedra. One that reaches the hull
    // is outside the shape; one that does not is a void inside it.
    let mut comp = vec![usize::MAX; nt];
    let mut ncomp = 0usize;
    let mut open: Vec<bool> = Vec::new();
    let mut size: Vec<f64> = Vec::new();
    for s in 0..nt {
        if inside[s] || comp[s] != usize::MAX { continue; }
        let id = ncomp;
        ncomp += 1;
        open.push(false);
        size.push(0.0);
        let mut stack = vec![s];
        comp[s] = id;
        while let Some(u) = stack.pop() {
            size[id] += vol[u];
            for f in 0..4 {
                let nb = d.nb[u][f];
                if nb < 0 { open[id] = true; continue; }
                let nb = nb as usize;
                if inside[nb] || comp[nb] != usize::MAX { continue; }
                comp[nb] = id;
                stack.push(nb);
            }
        }
    }
    for id in 0..ncomp {
        if !open[id] && size[id] < hole { total += size[id]; }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE HULL OF A SQUARE IS THE SQUARE, and the points inside it are
    /// not on it.
    #[test]
    fn the_convex_hull_of_a_square_has_four_corners() {
        let p = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0],
                     [0.5, 0.5], [0.2, 0.7], [0.9, 0.1]];
        let h = convex_hull_2d(&p);
        assert_eq!(h.len(), 4, "got {h:?}");
        let poly: Vec<[f64; 2]> = h.iter().map(|&i| p[i]).collect();
        assert!((polygon_signed_area(&poly) - 1.0).abs() < 1e-12,
            "counter-clockwise unit square: {}", polygon_signed_area(&poly));
        let c = polygon_centroid(&poly).expect("a square has a centre");
        assert!((c[0] - 0.5).abs() < 1e-12 && (c[1] - 0.5).abs() < 1e-12, "{c:?}");
    }

    /// THE CENTROID IS THE CENTRE OF AREA, NOT THE MEAN OF THE CORNERS.
    /// A triangle with two corners close together shows the difference:
    /// the mean is dragged towards the pair, the centroid is not.
    #[test]
    fn the_centroid_is_not_the_mean_of_the_vertices() {
        // A square whose top edge carries an extra vertex in the middle.
        let poly = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.5, 1.0], [0.0, 1.0]];
        let c = polygon_centroid(&poly).expect("a centre");
        assert!((c[0] - 0.5).abs() < 1e-12 && (c[1] - 0.5).abs() < 1e-12,
            "the extra vertex must not move the centre: {c:?}");
        let mean = [poly.iter().map(|q| q[0]).sum::<f64>() / 5.0,
                    poly.iter().map(|q| q[1]).sum::<f64>() / 5.0];
        assert!((mean[1] - 0.6).abs() < 1e-12, "the mean is dragged upward: {mean:?}");
    }

    /// DEGENERATE INPUT GIVES AN EMPTY HULL rather than a wrong one.
    #[test]
    fn a_line_of_points_has_no_hull() {
        let line: Vec<[f64; 2]> = (0..10).map(|i| [i as f64, 2.0 * i as f64]).collect();
        assert!(convex_hull_2d(&line).is_empty());
        assert!(convex_hull_2d(&[[0.0, 0.0], [1.0, 1.0]]).is_empty());
        assert!(convex_hull_2d(&[]).is_empty());
        assert!(polygon_centroid(&line).is_none(), "a line has no centre of area");
    }

    /// INSIDE, OUTSIDE, AND ON THE EDGE — the last of which is what
    /// the callers here need: a skeleton point lying exactly on the
    /// hull it generated must not be outside it.
    #[test]
    fn a_point_is_in_a_polygon_or_on_it_or_out() {
        let sq = [[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]];
        assert!(point_in_polygon(&sq, [2.0, 2.0]), "the middle");
        assert!(point_in_polygon(&sq, [0.0, 0.0]), "a corner");
        assert!(point_in_polygon(&sq, [4.0, 4.0]), "the far corner");
        assert!(point_in_polygon(&sq, [2.0, 0.0]), "the bottom edge");
        assert!(point_in_polygon(&sq, [4.0, 1.5]), "the right edge");
        assert!(!point_in_polygon(&sq, [-0.001, 2.0]));
        assert!(!point_in_polygon(&sq, [4.001, 2.0]));
        assert!(!point_in_polygon(&sq, [2.0, -0.001]));
        assert!(!point_in_polygon(&sq, [2.0, 4.001]));
        // A ray through a vertex must count that vertex once, not
        // twice: at y = 4 the ray from (2,4) leaves through two
        // vertices, and double-counting would put the point outside.
        assert!(point_in_polygon(&sq, [2.0, 4.0]));

        // A concave shape, where the crossing count is the whole point.
        let l = [[0.0, 0.0], [4.0, 0.0], [4.0, 1.0], [1.0, 1.0], [1.0, 4.0], [0.0, 4.0]];
        assert!(point_in_polygon(&l, [0.5, 3.0]), "up the tall arm");
        assert!(point_in_polygon(&l, [3.0, 0.5]), "along the low arm");
        assert!(!point_in_polygon(&l, [3.0, 3.0]), "in the notch");

        // Degenerate input is outside everything rather than a panic.
        assert!(!point_in_polygon(&[], [0.0, 0.0]));
        assert!(!point_in_polygon(&[[0.0, 0.0], [1.0, 1.0]], [0.5, 0.5]));
    }

    fn grid(n: usize) -> Vec<[f64; 2]> {
        (0..n).flat_map(|i| (0..n).map(move |j| [i as f64 / (n - 1) as f64,
                                                 j as f64 / (n - 1) as f64])).collect()
    }

    /// THE TRIANGULATION COVERS THE HULL AND NOTHING ELSE: the areas of
    /// its triangles add up to the area of the convex hull, exactly.
    #[test]
    fn the_triangles_tile_the_convex_hull() {
        for n in [3usize, 5, 9] {
            let p = grid(n);
            let d = delaunay_2d(&p);
            assert_eq!(d.skipped, 0, "{n}x{n}: {} points left out", d.skipped);
            let a: f64 = d.tris.iter()
                .map(|t| orient2(p[t[0]], p[t[1]], p[t[2]]).abs() / 2.0).sum();
            assert!((a - 1.0).abs() < 1e-9, "{n}x{n} grid tiles {a}, want 1");
            // Euler: a triangulation of n points with h of them on the
            // hull BOUNDARY has 2n - 2 - h triangles. A square grid has
            // 4(n-1) on the boundary, three quarters of which are in
            // the middle of an edge and so not hull CORNERS.
            let h = 4 * (n - 1);
            assert_eq!(d.tris.len(), 2 * p.len() - 2 - h,
                "{n}x{n}: {} triangles", d.tris.len());
            assert_eq!(convex_hull_2d(&p).len(), 4, "and only four corners");
        }
    }

    /// COCIRCULAR POINTS ARE THE NORMAL CASE HERE and must not break
    /// it: a ring of points on an exact circle, which is what a
    /// cylinder's surface looks like from above.
    #[test]
    fn a_ring_of_cocircular_points_still_triangulates() {
        let mut p: Vec<[f64; 2]> = (0..24)
            .map(|i| {
                let a = i as f64 / 24.0 * std::f64::consts::TAU;
                [0.3 * a.cos(), 0.3 * a.sin()]
            }).collect();
        // Four concentric rings, all exactly circular.
        for r in [0.1, 0.2, 0.4] {
            for i in 0..24 {
                let a = i as f64 / 24.0 * std::f64::consts::TAU;
                p.push([r * a.cos(), r * a.sin()]);
            }
        }
        let d = delaunay_2d(&p);
        assert_eq!(d.skipped, 0, "{} of {} points left out", d.skipped, p.len());
        let a: f64 = d.tris.iter()
            .map(|t| orient2(p[t[0]], p[t[1]], p[t[2]]).abs() / 2.0).sum();
        // The hull is the 24-gon of radius 0.4.
        let want = 0.5 * 24.0 * 0.4 * 0.4 * (std::f64::consts::TAU / 24.0).sin();
        assert!((a - want).abs() < 1e-9, "tiled {a}, hull is {want}");
    }

    /// THE ALPHA SHAPE IS THE HULL WHEN THE PROBE IS BIG AND NOTHING
    /// WHEN IT IS SMALL, and in between it is what a circle of that
    /// radius cannot roll into.
    #[test]
    fn the_alpha_area_runs_from_nothing_to_the_hull() {
        let p = grid(9);                      // unit square, spacing 0.125
        assert!((alpha_area_2d(&p, 100.0) - 1.0).abs() < 1e-9, "big probe: the hull");
        assert_eq!(alpha_area_2d(&p, 0.01), 0.0, "a probe smaller than the spacing");
        // The circumradius of half a 0.125 square is 0.125/sqrt(2).
        let r = 0.125 / 2.0f64.sqrt();
        assert!((alpha_area_2d(&p, r * 1.001) - 1.0).abs() < 1e-9);
        assert_eq!(alpha_area_2d(&p, r * 0.999), 0.0);

        // Two clusters a long way apart: a probe that spans neither gap
        // gives the two little squares and not the space between them.
        let mut two: Vec<[f64; 2]> = grid(5).iter().map(|q| [q[0] * 0.2, q[1] * 0.2]).collect();
        two.extend(grid(5).iter().map(|q| [5.0 + q[0] * 0.2, q[1] * 0.2]));
        let a = alpha_area_2d(&two, 0.1);
        assert!((a - 2.0 * 0.04).abs() < 1e-9, "two 0.2 squares, got {a}");
        assert!(alpha_area_2d(&two, 100.0) > 1.0, "a big probe bridges the gap");
    }

    /// THE TETRAHEDRA TILE THE CONVEX HULL, which is the three
    /// dimensional form of the same claim and the one the crown volume
    /// rests on.
    #[test]
    fn the_tetrahedra_tile_the_convex_hull() {
        // A 4x4x4 grid in the unit cube.
        let p: Vec<[f64; 3]> = (0..4).flat_map(|i| (0..4).flat_map(move |j| (0..4)
            .map(move |k| [i as f64 / 3.0, j as f64 / 3.0, k as f64 / 3.0]))).collect();
        let d = delaunay_3d(&p);
        assert_eq!(d.skipped, 0, "{} of 64 points left out", d.skipped);
        let v: f64 = d.tets.iter()
            .map(|t| tet_volume(p[t[0]], p[t[1]], p[t[2]], p[t[3]])).sum();
        assert!((v - 1.0).abs() < 1e-9, "the unit cube tiles to {v}");
        assert!((convex_hull_volume_3d(&p) - 1.0).abs() < 1e-9);

        // The neighbour graph is symmetric: if A says B, B says A.
        for (u, nb) in d.nb.iter().enumerate() {
            for &w in nb {
                if w < 0 { continue; }
                assert!(d.nb[w as usize].contains(&(u as i32)),
                    "tet {u} points at {w} but not the other way");
            }
        }
    }

    /// A SINGLE TETRAHEDRON IS ITS OWN TRIANGULATION.
    #[test]
    fn four_points_make_one_tetrahedron() {
        let p = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let d = delaunay_3d(&p);
        assert_eq!(d.tets.len(), 1);
        assert_eq!(d.skipped, 0);
        assert!((convex_hull_volume_3d(&p) - 1.0 / 6.0).abs() < 1e-12);
        assert_eq!(d.nb[0], [-1, -1, -1, -1], "a lone tetrahedron has no neighbours");
        assert_eq!(delaunay_3d(&p[..3]).tets.len(), 0, "three points make no volume");
    }

    /// COSPHERICAL POINTS, which a cylinder's surface produces by the
    /// thousand, must not break the tetrahedralisation either.
    #[test]
    fn points_on_an_exact_sphere_still_tetrahedralise() {
        let mut p: Vec<[f64; 3]> = Vec::new();
        for i in 0..12 {
            for j in 1..8 {
                let a = i as f64 / 12.0 * std::f64::consts::TAU;
                let b = j as f64 / 8.0 * std::f64::consts::PI;
                p.push([b.sin() * a.cos(), b.sin() * a.sin(), b.cos()]);
            }
        }
        p.push([0.0, 0.0, 1.0]);
        p.push([0.0, 0.0, -1.0]);
        let d = delaunay_3d(&p);
        assert_eq!(d.skipped, 0, "{} of {} points left out", d.skipped, p.len());
        let v = convex_hull_volume_3d(&p);
        // A polyhedron inscribed in the unit sphere, so under 4/3 pi
        // and — with 86 vertices — not far under.
        assert!(v > 3.4 && v < 4.19, "inscribed volume {v}");
    }

    /// THE ALPHA VOLUME RUNS FROM NOTHING TO THE HULL, and a probe too
    /// large to enter the gap between two clouds does not bridge it.
    #[test]
    fn the_alpha_volume_runs_from_nothing_to_the_hull() {
        let cube = |o: [f64; 3], s: f64, n: usize| -> Vec<[f64; 3]> {
            (0..n).flat_map(move |i| (0..n).flat_map(move |j| (0..n).map(move |k| {
                let f = |x: usize| o[0] * 0.0 + s * x as f64 / (n - 1) as f64;
                [o[0] + f(i), o[1] + f(j), o[2] + f(k)]
            }))).collect()
        };
        let p = cube([0.0, 0.0, 0.0], 1.0, 5);            // spacing 0.25
        assert!((alpha_volume_3d(&p, 100.0, 0.0) - 1.0).abs() < 1e-9, "a big probe: the hull");
        assert_eq!(alpha_volume_3d(&p, 0.01, 0.0), 0.0, "a probe under the spacing");

        let mut two = cube([0.0, 0.0, 0.0], 0.5, 4);
        two.extend(cube([8.0, 0.0, 0.0], 0.5, 4));
        let v = alpha_volume_3d(&two, 0.3, 0.0);
        assert!((v - 2.0 * 0.125).abs() < 1e-9, "two 0.5 cubes, got {v}");
        assert!(alpha_volume_3d(&two, 100.0, 0.0) > 1.0, "a big probe bridges the gap");
    }

    /// A VOID INSIDE THE SHAPE IS FILLED WHEN IT IS SMALL ENOUGH AND
    /// LEFT WHEN IT IS NOT — the reference asks for a threshold of
    /// 10000 cubic metres, which fills every void a tree can have.
    #[test]
    fn an_enclosed_void_is_filled_only_up_to_the_threshold() {
        // A solid grid with the middle knocked out, so the alpha
        // complex has a hollow in it.
        let n = 7;
        let mut p: Vec<[f64; 3]> = Vec::new();
        for i in 0..n { for j in 0..n { for k in 0..n {
            let q = [i as f64, j as f64, k as f64];
            let mid = |x: f64| x > 1.5 && x < 4.5;
            if mid(q[0]) && mid(q[1]) && mid(q[2]) { continue; }
            p.push(q);
        }}}
        // A probe that spans the unit spacing but not the 3-unit hole.
        let alpha = 1.2;
        let hollow = alpha_volume_3d(&p, alpha, 0.0);
        let filled = alpha_volume_3d(&p, alpha, 1e6);
        assert!(filled > hollow, "filling the void must add volume: {filled} vs {hollow}");
        assert!((filled - 216.0).abs() < 1e-6,
            "filled, the shape is the whole 6x6x6 block: {filled}");

        // The void is bigger than the 27 removed points suggest, and
        // for a reason worth stating: the empty region runs out to the
        // points that surround it, the box from 1 to 5, which is 64.
        // The probe still reaches into its eight corners — a corner
        // tetrahedron there has circumradius sqrt(3)/2, well under the
        // probe — so the void it cannot enter is smaller than that box.
        // The number is pinned as measured rather than derived.
        let void = filled - hollow;
        assert!((void - 45.333_333_333).abs() < 1e-6, "the void measures {void}");

        // The threshold is a strict comparison against exactly that.
        assert!((alpha_volume_3d(&p, alpha, void * 0.999) - hollow).abs() < 1e-9,
            "a threshold under the void leaves it open");
        assert!((alpha_volume_3d(&p, alpha, void * 1.001) - filled).abs() < 1e-9,
            "a threshold over it fills it");
    }
}
