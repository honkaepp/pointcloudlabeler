//! Phase 2's chunk groups, bounded by memory as well as cores.
//!
//! Phase 2 builds the chunks' sub-octrees a group at a time, one chunk
//! per core, each held whole while it builds: its packed input, a 32-byte
//! PtRef and node and accelerator overhead per point, and its serialised
//! output. A group was simply as many chunks as cores (up to 32), however
//! large they were: a billion points over 64 chunks on 16 cores is about
//! 25 GB at once, which a workstation pays for in swap. Here a group also
//! stops at what the machine can spare, so a large import runs fewer
//! chunks at a time instead of swapping. The groups are consecutive runs
//! in chunk order, which is the order the files are written in, so the
//! output is the same byte for byte whatever the grouping.

/// What building one chunk holds at its peak, from its packed input:
/// the input, the serialised output (its size once more), and per point
/// a PtRef (32 B) with the slack of the node vectors and the accelerator
/// entries (another ~48 B).
pub(super) fn chunk_build_bytes(input: u64, stride: usize) -> u64 {
    let points = input / stride.max(1) as u64;
    input * 2 + points * 80
}

/// The memory phase 2 may hold at once: half of what the machine has
/// free, leaving 2 GiB to everything else and never under 1 GiB; 8 GiB
/// where the machine cannot be asked.
pub(super) fn build_budget() -> u64 {
    crate::sysmem::stage_ceiling(crate::sysmem::available_bytes(), 2 << 30, 1 << 30, 8 << 30)
}

/// Consecutive runs of `chunks` of at most `max_chunks`, each estimated
/// to need at most `budget` bytes while it builds. A chunk larger than
/// the budget is a group of its own: it cannot be split, and it still
/// has to be built.
pub(super) fn chunk_groups(
    chunks: &[usize],
    size_of: impl Fn(usize) -> u64,
    stride: usize,
    max_chunks: usize,
    budget: u64,
) -> Vec<Vec<usize>> {
    let mut out = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    let mut cur_bytes = 0u64;
    for &ci in chunks {
        let need = chunk_build_bytes(size_of(ci), stride);
        if !cur.is_empty() && (cur.len() >= max_chunks.max(1) || cur_bytes.saturating_add(need) > budget) {
            out.push(std::mem::take(&mut cur));
            cur_bytes = 0;
        }
        cur.push(ci);
        cur_bytes = cur_bytes.saturating_add(need);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::{phase23_build_write_with, Aabb, ChunkSource, GRID_CUBED, GRID_SIZE};
    use super::*;

    #[test]
    fn groups_keep_order_and_respect_both_bounds() {
        let chunks: Vec<usize> = (0..10).collect();
        let sizes = [10u64, 10, 10, 500, 10, 10, 10, 10, 10, 10];
        let stride = 10;
        let need = |s: u64| chunk_build_bytes(s, stride);
        let budget = need(10) * 3;
        let g = chunk_groups(&chunks, |c| sizes[c], stride, 4, budget);
        assert_eq!(g.concat(), chunks, "every chunk once, in order");
        for grp in &g {
            assert!(grp.len() <= 4);
            let bytes: u64 = grp.iter().map(|&c| need(sizes[c])).sum();
            assert!(grp.len() == 1 || bytes <= budget, "{grp:?} over budget");
        }
        assert!(g.iter().any(|grp| grp == &vec![3]), "the oversized chunk builds alone: {g:?}");
        // Plenty of memory: only the core count bounds a group.
        let g = chunk_groups(&chunks, |c| sizes[c], stride, 4, u64::MAX);
        assert_eq!(g, vec![vec![0, 1, 2, 3], vec![4, 5, 6, 7], vec![8, 9]]);
        assert!(chunk_groups(&[], |_| 0, stride, 4, 1).is_empty());
    }

    /// Six chunks of random points, built with all the memory in the world
    /// and with so little that every chunk is its own group: the same
    /// octree.bin and hierarchy.bin, byte for byte.
    #[test]
    fn the_grouping_does_not_change_the_output() {
        let stride = 21usize;
        let scale = [0.001; 3];
        let offset = [0.0; 3];
        let bbox = Aabb { min: [0.0; 3], max: [64.0; 3] };
        let cell = 64.0 / GRID_SIZE as f64;
        let source = || {
            let mut bufs: Vec<Vec<u8>> = (0..GRID_CUBED).map(|_| Vec::new()).collect();
            let mut seed = 0x2545_f491_4f6c_dd1du64;
            let mut rnd = || {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                (seed >> 11) as f64 / (1u64 << 53) as f64
            };
            for (k, &ci) in [0usize, 1, 9, 73, 200, 511].iter().enumerate() {
                let (cx, cy, cz) = (ci % GRID_SIZE, (ci / GRID_SIZE) % GRID_SIZE, ci / (GRID_SIZE * GRID_SIZE));
                for p in 0..(2_000 + 700 * k) {
                    let x = (cx as f64 + rnd()) * cell;
                    let y = (cy as f64 + rnd()) * cell;
                    let z = (cz as f64 + rnd()) * cell;
                    let mut rec = vec![0u8; stride];
                    rec[0..4].copy_from_slice(&((x / scale[0]) as i32).to_le_bytes());
                    rec[4..8].copy_from_slice(&((y / scale[1]) as i32).to_le_bytes());
                    rec[8..12].copy_from_slice(&((z / scale[2]) as i32).to_le_bytes());
                    rec[12..16].copy_from_slice(&(p as i32).to_le_bytes());
                    bufs[ci].extend_from_slice(&rec);
                }
            }
            ChunkSource::Mem(bufs)
        };
        let build = |name: &str, budget: u64| {
            let dir = std::env::temp_dir().join(format!("tp-build-groups-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let (tiles, bytes) = phase23_build_write_with(
                source(), bbox, scale, offset, 1.0, 10, stride, &dir, &|_, _| {}, budget,
            ).unwrap();
            let out = (
                std::fs::read(dir.join("octree.bin")).unwrap(),
                std::fs::read(dir.join("hierarchy.bin")).unwrap(),
                tiles.len(),
                bytes,
            );
            let _ = std::fs::remove_dir_all(&dir);
            out
        };
        let wide = build("wide", u64::MAX);
        let narrow = build("narrow", 1);
        assert_eq!(wide.2, 6);
        assert!(!wide.0.is_empty());
        assert_eq!(wide.0, narrow.0, "octree.bin differs");
        assert_eq!(wide.1, narrow.1, "hierarchy.bin differs");
        assert_eq!(wide.3, narrow.3);
    }
}
