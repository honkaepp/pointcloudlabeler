//! Per-point patch lookups that skip the nodes nobody edited.
//!
//! Every whole-cloud scan (export, tree summary, metrics, ground, survey)
//! asks the patch map about each point it reads. With patches spread over
//! a million-node cloud, most of those lookups are cache misses into a
//! large hash table for points of nodes that hold no patch at all: a
//! billion of them per scan. `RecGated` keeps a bit per record alongside
//! the map and answers those from the bit, so only the points of edited
//! nodes reach the hash. It derefs to the map for everything else.

use rustc_hash::FxHashMap;
use std::ops::{Deref, DerefMut};

pub struct RecGated<V> {
    map: FxHashMap<(u32, u32), V>,
    /// Bit r: record r holds at least one entry (or did; a removal leaves
    /// it set, which only costs the lookup it would have made anyway).
    recs: Vec<u64>,
}

impl<V> Default for RecGated<V> {
    fn default() -> Self {
        Self { map: FxHashMap::default(), recs: Vec::new() }
    }
}

impl<V> RecGated<V> {
    pub fn insert(&mut self, key: (u32, u32), value: V) -> Option<V> {
        let w = (key.0 >> 6) as usize;
        if w >= self.recs.len() {
            self.recs.resize(w + 1, 0);
        }
        self.recs[w] |= 1u64 << (key.0 & 63);
        self.map.insert(key, value)
    }

    /// Whether record `r` may hold entries.
    #[inline]
    pub fn has_record(&self, r: u32) -> bool {
        let w = (r >> 6) as usize;
        w < self.recs.len() && self.recs[w] & (1u64 << (r & 63)) != 0
    }

    #[inline]
    pub fn get(&self, key: &(u32, u32)) -> Option<&V> {
        if !self.has_record(key.0) {
            return None;
        }
        self.map.get(key)
    }

    pub fn into_map(self) -> FxHashMap<(u32, u32), V> {
        self.map
    }
}

impl<V> From<FxHashMap<(u32, u32), V>> for RecGated<V> {
    fn from(map: FxHashMap<(u32, u32), V>) -> Self {
        let mut recs: Vec<u64> = Vec::new();
        for &(r, _) in map.keys() {
            let w = (r >> 6) as usize;
            if w >= recs.len() {
                recs.resize(w + 1, 0);
            }
            recs[w] |= 1u64 << (r & 63);
        }
        Self { map, recs }
    }
}

impl<V> Deref for RecGated<V> {
    type Target = FxHashMap<(u32, u32), V>;
    fn deref(&self) -> &Self::Target {
        &self.map
    }
}

impl<V> DerefMut for RecGated<V> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.map
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_like_the_map() {
        let mut g: RecGated<i32> = RecGated::default();
        g.insert((3, 7), 1);
        g.insert((200, 0), 2);
        assert_eq!(g.get(&(3, 7)), Some(&1));
        assert_eq!(g.get(&(3, 8)), None);
        assert_eq!(g.get(&(200, 0)), Some(&2));
        assert_eq!(g.get(&(4, 7)), None);
        assert_eq!(g.get(&(1_000_000, 7)), None);
        assert_eq!(g.len(), 2);
        assert!(g.has_record(3) && g.has_record(200) && !g.has_record(4) && !g.has_record(199));
    }

    #[test]
    fn built_from_a_map_knows_its_records() {
        let mut m: FxHashMap<(u32, u32), u8> = FxHashMap::default();
        m.insert((64, 1), 9);
        m.insert((0, 0), 8);
        let g = RecGated::from(m);
        assert_eq!(g.get(&(64, 1)), Some(&9));
        assert_eq!(g.get(&(0, 0)), Some(&8));
        assert!(!g.has_record(1) && !g.has_record(63) && !g.has_record(65));
    }
}
