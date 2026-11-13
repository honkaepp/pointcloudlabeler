//! One stem cut into two trees, found and joined.
//!
//! A stem's cross-section is one circle whatever the segmentation did to
//! its points; when the points of a believable stem circle carry two tree
//! ids in real numbers, those two are one tree split. Circles are fitted
//! up the stems from 1 m to 8 m above ground; each height where a pair
//! shows up is one vote. Pairs with enough votes are merged (the id with
//! more points survives, merges chain through a union-find); pairs with a
//! vote or two are offered to the user with where to look.

use rayon::prelude::*;
use rustc_hash::FxHashMap;
use serde::Serialize;

use super::stems::{slice_circles, StemParams};
use super::WorkSet;

#[derive(Clone, Debug)]
pub struct MergeParams {
    pub from: f32,
    pub to: f32,
    pub step: f32,
    /// Share of a circle's points the smaller id must hold.
    pub min_share: f32,
    /// Votes that merge a pair.
    pub votes: u32,
}

impl Default for MergeParams {
    fn default() -> Self { MergeParams { from: 1.0, to: 8.0, step: 0.5, min_share: 0.15, votes: 3 } }
}

/// A pair that may be one tree, and where it shows.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub a: u32,
    pub b: u32,
    pub votes: u32,
    /// Working-set coordinates of the first circle that showed it.
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

/// Pairs to merge and pairs to suggest.
pub fn find_splits(ws: &WorkSet, wood: &[bool], label: &[u32], prm: &MergeParams, stem: &StemParams) -> (Vec<(u32, u32)>, Vec<Suggestion>) {
    let mut heights = Vec::new();
    let mut h = prm.from;
    while h <= prm.to + 1e-3 { heights.push(h); h += prm.step; }
    let found: Vec<Vec<(u32, u32, [f64; 3])>> = heights
        .par_iter()
        .map(|&h| {
            let mut out = Vec::new();
            for c in slice_circles(ws, wood, h, stem) {
                if c.cover < 0.5 { continue; }
                let mut count: FxHashMap<u32, u32> = FxHashMap::default();
                for &i in &c.nodes { let l = label[i as usize]; if l != 0 { *count.entry(l).or_insert(0) += 1; } }
                let total = c.nodes.len() as f32;
                let mut ids: Vec<(u32, u32)> = count.into_iter().filter(|&(_, n)| n as f32 >= prm.min_share * total).collect();
                ids.sort_by_key(|b| std::cmp::Reverse(b.1));
                for x in 0..ids.len() {
                    for y in x + 1..ids.len() {
                        let (a, b) = (ids[x].0.min(ids[y].0), ids[x].0.max(ids[y].0));
                        let z = c.nodes.iter().map(|&i| ws.p[i as usize][2] as f64).sum::<f64>() / c.nodes.len() as f64;
                        out.push((a, b, [c.cx, c.cy, z]));
                    }
                }
            }
            out
        })
        .collect();
    let mut votes: FxHashMap<(u32, u32), (u32, [f64; 3])> = FxHashMap::default();
    for per in found {
        // one vote per height
        let mut seen = std::collections::HashSet::new();
        for (a, b, at) in per {
            if !seen.insert((a, b)) { continue; }
            let e = votes.entry((a, b)).or_insert((0, at));
            e.0 += 1;
        }
    }
    let mut merges = Vec::new();
    let mut suggestions = Vec::new();
    let mut keys: Vec<_> = votes.into_iter().collect();
    keys.sort_by_key(|&((a, b), _)| (a, b));
    for ((a, b), (v, at)) in keys {
        if v >= prm.votes { merges.push((a, b)); }
        else { suggestions.push(Suggestion { a, b, votes: v, x: at[0], y: at[1], z: at[2] }); }
    }
    (merges, suggestions)
}

/// Apply merges to the labels; the id with more nodes survives. Returns the
/// final id of every id that changed.
pub fn apply_merges(label: &mut [u32], merges: &[(u32, u32)]) -> FxHashMap<u32, u32> {
    if merges.is_empty() { return FxHashMap::default(); }
    let mut size: FxHashMap<u32, u64> = FxHashMap::default();
    for &l in label.iter() { if l != 0 { *size.entry(l).or_insert(0) += 1; } }
    let mut parent: FxHashMap<u32, u32> = FxHashMap::default();
    fn find(parent: &mut FxHashMap<u32, u32>, x: u32) -> u32 {
        let p = *parent.get(&x).unwrap_or(&x);
        if p == x { return x; }
        let r = find(parent, p);
        parent.insert(x, r);
        r
    }
    for &(a, b) in merges {
        let (ra, rb) = (find(&mut parent, a), find(&mut parent, b));
        if ra == rb { continue; }
        let (sa, sb) = (size.get(&ra).copied().unwrap_or(0), size.get(&rb).copied().unwrap_or(0));
        let (keep, gone) = if sa > sb || (sa == sb && ra < rb) { (ra, rb) } else { (rb, ra) };
        parent.insert(gone, keep);
        *size.entry(keep).or_insert(0) += if keep == ra { sb } else { sa };
    }
    let mut map: FxHashMap<u32, u32> = FxHashMap::default();
    let ids: Vec<u32> = merges.iter().flat_map(|&(a, b)| [a, b]).collect();
    for id in ids { let r = find(&mut parent, id); if r != id { map.insert(id, r); } }
    for l in label.iter_mut() { if let Some(&r) = map.get(l) { *l = r; } }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stem_split_in_two_is_joined_by_its_circles() {
        // one stem 0.2 m in radius, its west half labelled 1, east half 2,
        // from 1 m to 6 m; a second stem labelled 3
        let mut p = Vec::new();
        let mut label = Vec::new();
        let mut h = 0.5f32;
        while h < 6.0 {
            for a in 0..40 {
                let t = a as f32 / 40.0 * std::f32::consts::TAU;
                p.push([0.2 * t.cos(), 0.2 * t.sin(), h]);
                label.push(if t.cos() < 0.0 { 1 } else { 2 });
                p.push([4.0 + 0.15 * t.cos(), 0.15 * t.sin(), h]);
                label.push(3);
            }
            h += 0.05;
        }
        let hag = p.iter().map(|q| q[2]).collect();
        let ws = WorkSet { n: vec![1; p.len()], hag, p, refl: None, voxel: 0.03 };
        let wood = vec![true; ws.len()];
        let (merges, sugg) = find_splits(&ws, &wood, &label, &MergeParams::default(), &StemParams::default());
        assert_eq!(merges, vec![(1, 2)]);
        assert!(sugg.is_empty());
        let mut l = label.clone();
        let map = apply_merges(&mut l, &merges);
        assert_eq!(map.len(), 1);
        let ids: std::collections::BTreeSet<u32> = l.iter().copied().collect();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains(&3));
    }

    #[test]
    fn merges_chain() {
        let mut l = vec![1, 1, 1, 2, 3, 3];
        apply_merges(&mut l, &[(1, 2), (2, 3)]);
        assert!(l.iter().all(|&x| x == 1), "{l:?}");
    }
}
