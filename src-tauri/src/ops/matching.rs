// PointCloudLabeler — Tree segmentation, editing and label transfer for close-range forest point clouds
// Copyright (C) 2026 Eppu Honkanen
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//! Matching trees between two sets by position (`src/metrics/assignment.ts`):
//! the optimal assignment (Jonker–Volgenant, the Hungarian method) on
//! squared planimetric distance within a radius, and the greedy
//! nearest-first pairing the literature usually reports, kept so the
//! two can be compared. Pairs first, distance second: a tree both
//! epochs saw is reported as seen by both even at a little more
//! total distance. A tree with no position matches nothing; it is not
//! at the origin.

use serde::{Deserialize, Serialize};

/// A pair that must never be made.
pub const FORBIDDEN: f64 = f64::INFINITY;

/// Minimum-cost assignment of rows to columns; `None` for a row left
/// out. Forbidden (non-finite) costs are never assigned, and the
/// solver prefers more pairs over a lower total. Rectangular matrices
/// either way round.
pub fn assign(cost: &[Vec<f64>]) -> Vec<Option<usize>> {
    let n = cost.len();
    if n == 0 {
        return Vec::new();
    }
    let m = cost[0].len();
    if m == 0 {
        return vec![None; n];
    }
    let mut max_real = 0.0f64;
    for row in cost {
        for &c in row {
            if c.is_finite() && c > max_real {
                max_real = c;
            }
        }
    }
    let big = (max_real + 1.0) * (n.min(m) as f64 + 1.0);
    let sub = |i: usize, j: usize| -> f64 {
        let c = cost[i][j];
        if c.is_finite() { c } else { big }
    };
    let flip = n > m;
    let (r, c) = if flip { (m, n) } else { (n, m) };
    let at = |i: usize, j: usize| if flip { sub(j, i) } else { sub(i, j) };

    // Jonker–Volgenant, 1-indexed: u, v the dual potentials, p[j] the
    // row matched to column j.
    let mut u = vec![0.0f64; r + 1];
    let mut v = vec![0.0f64; c + 1];
    let mut p = vec![0usize; c + 1];
    let mut way = vec![0usize; c + 1];
    for i in 1..=r {
        p[0] = i;
        let mut j0 = 0usize;
        let mut minv = vec![f64::INFINITY; c + 1];
        let mut used = vec![false; c + 1];
        loop {
            used[j0] = true;
            let i0 = p[j0];
            let mut delta = f64::INFINITY;
            let mut j1: Option<usize> = None;
            for j in 1..=c {
                if used[j] {
                    continue;
                }
                let cur = at(i0 - 1, j - 1) - u[i0] - v[j];
                if cur < minv[j] {
                    minv[j] = cur;
                    way[j] = j0;
                }
                if minv[j] < delta {
                    delta = minv[j];
                    j1 = Some(j);
                }
            }
            let Some(j1) = j1 else { break };
            for j in 0..=c {
                if used[j] {
                    u[p[j]] += delta;
                    v[j] -= delta;
                } else {
                    minv[j] -= delta;
                }
            }
            j0 = j1;
            if p[j0] == 0 {
                break;
            }
        }
        while j0 != 0 {
            let j1 = way[j0];
            p[j0] = p[j1];
            j0 = j1;
        }
    }

    let mut out = vec![None; n];
    for (j, &i) in p.iter().enumerate().skip(1) {
        if i == 0 {
            continue;
        }
        let (row, col) = if flip { (j - 1, i - 1) } else { (i - 1, j - 1) };
        if !cost[row][col].is_finite() {
            continue;
        }
        out[row] = Some(col);
    }
    out
}

#[derive(Serialize, Deserialize, schemars::JsonSchema, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MatchMethod {
    /// The Hungarian assignment on squared distance (the default).
    Optimal,
    /// Nearest-first, for a like-for-like number with the literature.
    Greedy,
}

/// One pair: indices into the two inputs and their separation (m).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pairing {
    pub a: usize,
    pub b: usize,
    pub distance: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MatchResult {
    pub matches: Vec<Pairing>,
    pub unmatched_a: Vec<usize>,
    pub unmatched_b: Vec<usize>,
}

/// Pair positions within `radius` (a non-finite or negative radius
/// matches nothing; zero pairs exact coincidences only). The cost is
/// the squared distance, deliberately: one long pair usually means a
/// wrong pair, and Σd² refuses it in favour of several ordinary ones.
pub fn match_by_position(a: &[[f64; 2]], b: &[[f64; 2]], radius: f64, method: MatchMethod) -> MatchResult {
    let r2 = if radius.is_finite() && radius >= 0.0 { radius * radius } else { -1.0 };
    let sep2 = |i: usize, j: usize| -> f64 {
        let (ax, ay) = (a[i][0], a[i][1]);
        let (bx, by) = (b[j][0], b[j][1]);
        if !ax.is_finite() || !ay.is_finite() || !bx.is_finite() || !by.is_finite() {
            return FORBIDDEN;
        }
        let d2 = (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
        if d2 <= r2 { d2 } else { FORBIDDEN }
    };
    let mut taken_a = vec![false; a.len()];
    let mut taken_b = vec![false; b.len()];
    let mut matches = Vec::new();
    if !a.is_empty() && !b.is_empty() {
        match method {
            MatchMethod::Greedy => {
                let mut cand: Vec<(usize, usize, f64)> = Vec::new();
                for i in 0..a.len() {
                    for j in 0..b.len() {
                        let d2 = sep2(i, j);
                        if d2.is_finite() {
                            cand.push((i, j, d2));
                        }
                    }
                }
                cand.sort_by(|x, y| x.2.partial_cmp(&y.2).unwrap().then(x.0.cmp(&y.0)).then(x.1.cmp(&y.1)));
                for (i, j, d2) in cand {
                    if taken_a[i] || taken_b[j] {
                        continue;
                    }
                    taken_a[i] = true;
                    taken_b[j] = true;
                    matches.push(Pairing { a: i, b: j, distance: d2.sqrt() });
                }
            }
            MatchMethod::Optimal => {
                let cost: Vec<Vec<f64>> = (0..a.len()).map(|i| (0..b.len()).map(|j| sep2(i, j)).collect()).collect();
                for (i, col) in assign(&cost).into_iter().enumerate() {
                    let Some(j) = col else { continue };
                    taken_a[i] = true;
                    taken_b[j] = true;
                    matches.push(Pairing { a: i, b: j, distance: cost[i][j].sqrt() });
                }
            }
        }
    }
    MatchResult {
        matches,
        unmatched_a: (0..a.len()).filter(|i| !taken_a[*i]).collect(),
        unmatched_b: (0..b.len()).filter(|j| !taken_b[*j]).collect(),
    }
}

pub fn total_distance(r: &MatchResult) -> f64 {
    r.matches.iter().map(|p| p.distance).sum()
}

pub fn total_squared_distance(r: &MatchResult) -> f64 {
    r.matches.iter().map(|p| p.distance * p.distance).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Brute force: the true optimum over every injective row→column
    /// map, pairs first then total — a real oracle.
    fn brute_force(cost: &[Vec<f64>]) -> (f64, usize) {
        fn walk(cost: &[Vec<f64>], row: usize, used: &mut Vec<bool>, total: f64, pairs: usize, best: &mut (f64, usize)) {
            if row == cost.len() {
                if pairs > best.1 || (pairs == best.1 && total < best.0) {
                    *best = (total, pairs);
                }
                return;
            }
            walk(cost, row + 1, used, total, pairs, best);
            for j in 0..used.len() {
                if used[j] || !cost[row][j].is_finite() {
                    continue;
                }
                used[j] = true;
                walk(cost, row + 1, used, total + cost[row][j], pairs + 1, best);
                used[j] = false;
            }
        }
        let m = cost.first().map(|r| r.len()).unwrap_or(0);
        let mut best = (f64::INFINITY, 0usize);
        walk(cost, 0, &mut vec![false; m], 0.0, 0, &mut best);
        (if best.1 == 0 { 0.0 } else { best.0 }, best.1)
    }

    fn score_of(cost: &[Vec<f64>], col_of: &[Option<usize>]) -> (f64, usize) {
        let mut seen = std::collections::HashSet::new();
        let (mut total, mut pairs) = (0.0, 0);
        for (i, c) in col_of.iter().enumerate() {
            let Some(j) = c else { continue };
            assert!(seen.insert(*j), "column {j} assigned twice");
            assert!(cost[i][*j].is_finite(), "pair {i}->{j} is forbidden");
            total += cost[i][*j];
            pairs += 1;
        }
        (total, pairs)
    }

    /// The renderer's seeded LCG, so a failure is reproducible.
    fn lcg(seed: u32) -> impl FnMut() -> f64 {
        let mut s = seed;
        move || {
            s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            s as f64 / 4_294_967_296.0
        }
    }

    #[test]
    fn solves_the_textbook_cases() {
        let cost = vec![vec![4.0, 1.0, 3.0], vec![2.0, 0.0, 5.0], vec![3.0, 2.0, 2.0]];
        assert_eq!(score_of(&cost, &assign(&cost)).0, 5.0);
        let cost = vec![vec![1.0, 2.0], vec![1.0, 9.0]];
        assert_eq!(score_of(&cost, &assign(&cost)).0, 3.0);
        let cost = vec![vec![1.0, 2.0], vec![FORBIDDEN, 3.0]];
        assert_eq!(score_of(&cost, &assign(&cost)), (4.0, 2));
        assert_eq!(assign(&[vec![FORBIDDEN, FORBIDDEN], vec![FORBIDDEN, FORBIDDEN]]), vec![None, None]);
        let col_of = assign(&[vec![1.0], vec![2.0], vec![3.0]]);
        assert_eq!(col_of.iter().filter(|c| c.is_some()).count(), 1);
        assert_eq!(col_of[0], Some(0));
        assert_eq!(assign(&[vec![f64::NAN, 5.0], vec![3.0, f64::NAN]]), vec![Some(1), Some(0)]);
        assert!(assign(&[]).is_empty());
        assert_eq!(assign(&[vec![]]), vec![None]);
        assert_eq!(assign(&[vec![7.0]]), vec![Some(0)]);
        let cost = vec![vec![-5.0, -1.0], vec![-2.0, -8.0]];
        assert!((score_of(&cost, &assign(&cost)).0 + 13.0).abs() < 1e-9);
    }

    #[test]
    fn matches_brute_force_on_random_square_rectangular_and_forbidden_matrices() {
        let mut rnd = lcg(20260820);
        for _ in 0..200 {
            let n = 1 + (rnd() * 5.0).floor() as usize;
            let cost: Vec<Vec<f64>> = (0..n).map(|_| (0..n).map(|_| (rnd() * 100.0).round()).collect()).collect();
            let got = score_of(&cost, &assign(&cost));
            let want = brute_force(&cost);
            assert_eq!(got.1, want.1, "n={n}");
            assert!((got.0 - want.0).abs() < 1e-9, "n={n}");
        }
        let mut rnd = lcg(4711);
        for _ in 0..150 {
            let n = 1 + (rnd() * 5.0).floor() as usize;
            let m = 1 + (rnd() * 5.0).floor() as usize;
            let cost: Vec<Vec<f64>> = (0..n).map(|_| (0..m).map(|_| (rnd() * 50.0).round()).collect()).collect();
            let got = score_of(&cost, &assign(&cost));
            let want = brute_force(&cost);
            assert_eq!(got.1, want.1, "{n}x{m}");
            assert!((got.0 - want.0).abs() < 1e-9, "{n}x{m}");
        }
        let mut rnd = lcg(1337);
        for _ in 0..150 {
            let n = 1 + (rnd() * 4.0).floor() as usize;
            let m = 1 + (rnd() * 4.0).floor() as usize;
            let cost: Vec<Vec<f64>> = (0..n).map(|_| (0..m).map(|_| if rnd() < 0.4 { FORBIDDEN } else { (rnd() * 40.0).round() }).collect()).collect();
            let got = score_of(&cost, &assign(&cost));
            let want = brute_force(&cost);
            assert_eq!(got.1, want.1, "{n}x{m} forbidden");
            assert!((got.0 - want.0).abs() < 1e-9, "{n}x{m} forbidden");
        }
    }

    fn pts(v: &[(f64, f64)]) -> Vec<[f64; 2]> {
        v.iter().map(|(x, y)| [*x, *y]).collect()
    }

    fn pairs(r: &MatchResult) -> Vec<(usize, usize)> {
        let mut v: Vec<(usize, usize)> = r.matches.iter().map(|p| (p.a, p.b)).collect();
        v.sort();
        v
    }

    #[test]
    fn pairs_within_the_radius_each_side_once_and_reports_the_separation() {
        let r = match_by_position(&pts(&[(0.0, 0.0), (10.0, 0.0)]), &pts(&[(0.3, 0.0), (10.2, 0.0)]), 2.0, MatchMethod::Optimal);
        assert_eq!(pairs(&r), vec![(0, 0), (1, 1)]);
        assert!(r.unmatched_a.is_empty() && r.unmatched_b.is_empty());
        let r = match_by_position(&pts(&[(0.0, 0.0)]), &pts(&[(3.0, 4.0)]), 10.0, MatchMethod::Optimal);
        assert!((r.matches[0].distance - 5.0).abs() < 1e-12);
        let r = match_by_position(&pts(&[(0.0, 0.0)]), &pts(&[(5.0, 0.0)]), 2.0, MatchMethod::Optimal);
        assert!(r.matches.is_empty() && r.unmatched_a == vec![0] && r.unmatched_b == vec![0]);
        let r = match_by_position(&pts(&[(0.0, 0.0), (0.2, 0.0)]), &pts(&[(0.1, 0.0)]), 5.0, MatchMethod::Optimal);
        assert_eq!((r.matches.len(), r.unmatched_a.len()), (1, 1));
    }

    #[test]
    fn finds_a_tree_greedy_loses_and_never_fewer_pairs_than_greedy() {
        let a = pts(&[(0.0, 0.0), (1.0, 0.0)]);
        let b = pts(&[(1.1, 0.0), (2.0, 0.0)]);
        let g = match_by_position(&a, &b, 1.5, MatchMethod::Greedy);
        let o = match_by_position(&a, &b, 1.5, MatchMethod::Optimal);
        assert_eq!(g.matches.len(), 1);
        assert_eq!(g.matches[0].a, 1);
        assert_eq!(g.unmatched_a, vec![0]);
        assert_eq!(pairs(&o), vec![(0, 0), (1, 1)]);

        let mut rnd = lcg(90210);
        let mut saw_larger_sum_d = false;
        for t in 0..120 {
            let n = 1 + (rnd() * 8.0).floor() as usize;
            let m = 1 + (rnd() * 8.0).floor() as usize;
            let a: Vec<[f64; 2]> = (0..n).map(|_| [rnd() * 10.0, rnd() * 10.0]).collect();
            let b: Vec<[f64; 2]> = (0..m).map(|_| [rnd() * 10.0, rnd() * 10.0]).collect();
            let g = match_by_position(&a, &b, 2.5, MatchMethod::Greedy);
            let o = match_by_position(&a, &b, 2.5, MatchMethod::Optimal);
            assert!(o.matches.len() >= g.matches.len(), "trial {t}");
            if o.matches.len() == g.matches.len() {
                assert!(total_squared_distance(&o) <= total_squared_distance(&g) + 1e-9, "trial {t}");
                if total_distance(&o) > total_distance(&g) + 1e-9 {
                    saw_larger_sum_d = true;
                    assert!(total_squared_distance(&o) < total_squared_distance(&g));
                }
            }
        }
        assert!(saw_larger_sum_d, "the squared objective trades Σd somewhere");
    }

    #[test]
    fn no_position_no_match_order_independence_empty_and_odd_radii() {
        let r = match_by_position(&pts(&[(f64::NAN, f64::NAN), (0.0, 0.0)]), &pts(&[(0.1, 0.0)]), 5.0, MatchMethod::Optimal);
        assert_eq!(pairs(&r), vec![(1, 0)]);
        assert_eq!(r.unmatched_a, vec![0]);

        let mut rnd = lcg(2718);
        let a: Vec<[f64; 2]> = (0..7).map(|_| [rnd() * 8.0, rnd() * 8.0]).collect();
        let b: Vec<[f64; 2]> = (0..7).map(|_| [rnd() * 8.0, rnd() * 8.0]).collect();
        for method in [MatchMethod::Optimal, MatchMethod::Greedy] {
            let fwd = match_by_position(&a, &b, 3.0, method);
            let ra: Vec<[f64; 2]> = a.iter().rev().copied().collect();
            let rb: Vec<[f64; 2]> = b.iter().rev().copied().collect();
            let rev = match_by_position(&ra, &rb, 3.0, method);
            let mut k1: Vec<(usize, usize)> = fwd.matches.iter().map(|p| (p.a, p.b)).collect();
            let mut k2: Vec<(usize, usize)> = rev.matches.iter().map(|p| (6 - p.a, 6 - p.b)).collect();
            k1.sort();
            k2.sort();
            assert_eq!(k1, k2, "{method:?}");
        }

        assert!(match_by_position(&[], &pts(&[(0.0, 0.0)]), 2.0, MatchMethod::Optimal).matches.is_empty());
        assert!(match_by_position(&pts(&[(0.0, 0.0)]), &[], 2.0, MatchMethod::Optimal).matches.is_empty());
        assert_eq!(match_by_position(&[], &[], 2.0, MatchMethod::Optimal), MatchResult { matches: vec![], unmatched_a: vec![], unmatched_b: vec![] });
        for radius in [-1.0, f64::NAN, f64::INFINITY] {
            assert!(match_by_position(&pts(&[(0.0, 0.0)]), &pts(&[(0.0, 0.0)]), radius, MatchMethod::Optimal).matches.is_empty(), "radius {radius}");
        }
        assert_eq!(match_by_position(&pts(&[(0.0, 0.0)]), &pts(&[(0.0, 0.0)]), 0.0, MatchMethod::Optimal).matches.len(), 1);
        assert!(match_by_position(&pts(&[(0.0, 0.0)]), &pts(&[(0.001, 0.0)]), 0.0, MatchMethod::Optimal).matches.is_empty());

        let mut rnd = lcg(31415);
        for _ in 0..60 {
            let a: Vec<[f64; 2]> = (0..6).map(|_| [rnd() * 6.0, rnd() * 6.0]).collect();
            let b: Vec<[f64; 2]> = (0..5).map(|_| [rnd() * 6.0, rnd() * 6.0]).collect();
            let r = match_by_position(&a, &b, 2.0, MatchMethod::Optimal);
            assert_eq!(r.matches.len() + r.unmatched_a.len(), 6);
            assert_eq!(r.matches.len() + r.unmatched_b.len(), 5);
        }
    }
}
