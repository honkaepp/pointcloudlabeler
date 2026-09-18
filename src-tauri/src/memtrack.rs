// How much memory this process is actually holding.
//
// The skeleton build killed the application five times, and every
// diagnosis until this file existed was an ESTIMATE: bytes-per-point
// guessed from the shape of a crash, a budget in points because points
// were what could be counted. Each estimate produced a fix, and each
// fix was followed by another crash — and the largest allocation in
// the stage, the read holding the whole plot, was never in any of
// them. The quantity that matters was not measured until here.
//
// This measures it. A global allocator that tracks allocations of
// 64 KiB or more — the point arrays, cover sets, neighbour graphs and
// segment structures, which is where the bytes are — and leaves
// everything smaller alone, so the common path costs one integer
// comparison and no atomic.
//
// It is a floor on real usage, not the whole of it: allocator
// fragmentation, the OS's own overhead and every allocation below the
// threshold are outside it. That is fine for what it is for — bounding
// what one stage ADDS, and saying in the log what a run was holding
// when it died.

use std::alloc::{GlobalAlloc, Layout};
use std::sync::atomic::{AtomicUsize, Ordering};

/// The allocator underneath the count: mimalloc, not the platform's.
///
/// WHY. A skeleton build runs sixteen trees at once, and each tree's
/// passes allocate without pause — cover sets, neighbour lists,
/// whole-tree scratch — much of it in blocks of tens to hundreds of
/// kilobytes. On Windows those are above what the low-fragmentation
/// heap serves and go through the process heap under one lock, and
/// with sixteen threads on it every tree ran eight to twenty times
/// slower than it did alone: a 3-hour run of a plot that takes 15
/// minutes when the giants are done one at a time, eight trees past
/// the 60-minute cap. On Linux, with an allocator that keeps per-thread
/// heaps, the same trees four at a time cost 8 % each. mimalloc is
/// that kind of allocator on every platform.
static UNDERLYING: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// Allocations at least this large are counted. Below it the count
/// would cost more than it measures: a tree's reconstruction makes
/// millions of small allocations whose total is a rounding error
/// beside one cover set.
pub const TRACK_FROM: usize = 64 * 1024;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

/// Bytes currently held in tracked allocations.
pub fn live() -> usize { LIVE.load(Ordering::Relaxed) }

/// The most that were ever held at once since the last reset.
pub fn peak() -> usize { PEAK.load(Ordering::Relaxed) }

/// Start a new high-water measurement from where things stand now.
pub fn reset_peak() { PEAK.store(LIVE.load(Ordering::Relaxed), Ordering::Relaxed); }

#[inline]
fn add(n: usize) {
    let now = LIVE.fetch_add(n, Ordering::Relaxed) + n;
    PEAK.fetch_max(now, Ordering::Relaxed);
}

#[inline]
fn sub(n: usize) { LIVE.fetch_sub(n, Ordering::Relaxed); }

pub struct Tracking;

// SAFETY: every method forwards to mimalloc, which is a correct
// allocator, and touches only two atomics besides. The counters are
// advisory — a torn read gives a number that is briefly stale, never
// an invalid pointer.
unsafe impl GlobalAlloc for Tracking {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = UNDERLYING.alloc(l);
        if !p.is_null() && l.size() >= TRACK_FROM { add(l.size()); }
        p
    }

    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = UNDERLYING.alloc_zeroed(l);
        if !p.is_null() && l.size() >= TRACK_FROM { add(l.size()); }
        p
    }

    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        if l.size() >= TRACK_FROM { sub(l.size()); }
        UNDERLYING.dealloc(p, l)
    }

    /// Forwarded rather than left to the default alloc-copy-dealloc,
    /// which would turn every `Vec` growth into a full copy — this
    /// process grows very large `Vec`s in loops, and measuring must
    /// not be what makes it slow.
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new_size: usize) -> *mut u8 {
        let q = UNDERLYING.realloc(p, l, new_size);
        // A failed realloc leaves the old block exactly as it was, so
        // there is nothing to account for.
        if !q.is_null() {
            if l.size() >= TRACK_FROM { sub(l.size()); }
            if new_size >= TRACK_FROM { add(new_size); }
        }
        q
    }
}

/// Bytes as a human reads them, for log lines.
pub fn mib(bytes: usize) -> f64 { bytes as f64 / (1024.0 * 1024.0) }

#[cfg(test)]
mod tests {
    use super::*;

    /// These read a PROCESS-WIDE counter, so they serialise against
    /// each other — and the sizes are large enough that whatever the
    /// rest of the suite allocates on other threads meanwhile is small
    /// beside them. Anything precise to a kilobyte would be measuring
    /// the other tests.
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const BIG: usize = 64 * 1024 * 1024;
    /// What the rest of the suite may plausibly be holding at the same
    /// moment. Every bound below is stated against this.
    const NOISE: usize = 8 * 1024 * 1024;

    /// A BIG ALLOCATION IS COUNTED AND GIVEN BACK. The second half is
    /// what matters: accounting that leaked would drift upward over an
    /// hour until the ceiling admitted nothing.
    #[test]
    fn a_large_allocation_is_counted_while_it_lives() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let before = live();
        let mut v: Vec<u8> = Vec::with_capacity(BIG);
        v.push(1);
        let during = live();
        assert!(during >= before + BIG - NOISE,
            "{} MiB allocated, live() moved by {:.1} MiB",
            mib(BIG), mib(during.saturating_sub(before)));
        drop(v);
        let after = live();
        assert!(after < before + NOISE,
            "the allocation was not given back: {:.1} MiB still counted",
            mib(after.saturating_sub(before)));
    }

    /// SMALL ONES ARE NOT, which is what keeps the cost of measuring
    /// out of the hot path. Half a million of them, so "counted" and
    /// "not counted" are 32 MiB apart and no tolerance can hide it.
    #[test]
    fn small_allocations_are_left_alone() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let n = 500_000;
        let each = 64;
        let before = live();
        let v: Vec<Vec<u8>> = (0..n).map(|_| Vec::<u8>::with_capacity(each)).collect();
        let counted = live().saturating_sub(before);
        // The outer Vec is one big allocation and IS counted; the half
        // million inner ones must not be.
        let outer = n * std::mem::size_of::<Vec<u8>>();
        assert!(counted < outer + NOISE,
            "{} allocations of {each} B added {:.1} MiB — small ones are being counted",
            n, mib(counted));
        drop(v);
    }

    /// GROWTH IS ACCOUNTED THROUGH REALLOC. A `Vec` that doubles its
    /// way up to hundreds of megabytes goes entirely through
    /// `realloc`, so leaving that path unaccounted would make the
    /// number meaningless for exactly the case it exists for.
    ///
    /// The counter is process-wide, and the rest of the suite runs
    /// beside this on other threads, freeing and allocating buffers of
    /// its own: a test that frees a hundred megabytes between `before`
    /// and `during` makes the growth here look smaller than it was. So
    /// the measurement is tried a few times and one clean reading is
    /// enough — broken accounting fails every attempt, interference
    /// does not.
    #[test]
    fn a_vec_that_grows_is_accounted_as_it_grows() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let n = BIG / 8;
        let mut last = (0usize, 0usize);
        for attempt in 0..5 {
            let before = live();
            let mut v: Vec<u64> = Vec::new();
            for i in 0..n as u64 { v.push(i); }
            let during = live();
            let grew = during >= before + BIG - NOISE;
            drop(v);
            let given_back = live() < before + NOISE;
            if grew && given_back { return; }
            last = (before, during);
            std::thread::sleep(std::time::Duration::from_millis(50 * (attempt + 1)));
        }
        panic!("a Vec grown to {:.1} MiB shows as {:.1} MiB across five attempts (before {}, during {})",
            mib(BIG), mib(last.1.saturating_sub(last.0)), last.0, last.1);
    }

    /// THE PEAK IS A HIGH-WATER MARK and survives the memory going
    /// away — otherwise a log written after a run reports whatever was
    /// live at the end, which is nothing.
    #[test]
    fn the_peak_outlives_what_made_it() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        reset_peak();
        let base = live();
        {
            let mut v: Vec<u8> = Vec::with_capacity(BIG);
            v.push(1);
            assert!(peak() >= base + BIG - NOISE, "the peak did not rise with the allocation");
        }
        assert!(live() < base + NOISE, "freed memory is still counted as live");
        assert!(peak() >= base + BIG - NOISE,
            "the peak fell back to the live figure once the memory went");
    }
}
