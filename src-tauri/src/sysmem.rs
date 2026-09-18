// What the machine has, and what this process is actually using.
//
// WHY THIS EXISTS
// ---------------
// The skeleton build's memory ceiling was a fixed 768 MiB, checked
// against `memtrack` — a count of this process's allocations of 64 KiB
// or more. Two things were wrong with that, and together they are why
// six runs died with the ceiling never reached.
//
// The count was a subset. The QSM port builds cover sets, neighbour
// lists and segment structures as `Vec<Vec<…>>` — 110 of those in the
// file — so a tree's reconstruction is millions of allocations under
// the threshold, and sixteen trees at once can hold gigabytes that the
// gauge reported as zero. The comment beside the threshold called that
// a rounding error. It was never measured.
//
// The ceiling knew nothing about the machine. 768 MiB is generous on
// 8 GB and absurd on 64 GB, and it is the same number on both. When
// Windows runs out of commit it fails whichever allocation comes next,
// and the WebView2 renderer — allocating constantly, and written to
// crash cleanly when it cannot — is the process that dies. The backend
// kept going every time, which is why the checkpoints survived. The
// crash was real; it was just not in the process that was measured.
//
// So: the resident set of THIS process as the OS reports it, and the
// physical memory the OS says is still available. Both are cheap — one
// syscall each — and both are the actual quantity rather than a proxy.

/// Physical memory the OS reports as available for new allocations
/// right now, in bytes. `None` where this has no way to ask.
pub fn available_bytes() -> Option<u64> {
    imp::available_bytes()
}

/// Physical memory installed, in bytes.
pub fn total_bytes() -> Option<u64> {
    imp::total_bytes()
}

/// This process's resident set — the working set on Windows, RSS on
/// Linux — in bytes. What the machine is actually giving up to us,
/// small allocations, allocator overhead and all.
pub fn process_resident_bytes() -> Option<u64> {
    imp::process_resident_bytes()
}

/// How much a memory-heavy stage may ADD to this process before it
/// stops admitting new work, chosen from what the machine has free
/// when the stage starts.
///
/// Half of what is available, and never within `reserve` of using it
/// all — the renderer, the OS and whatever else is open have to keep
/// running, and the renderer is what died. Never below `floor`, so a
/// machine that is already tight still makes progress one tree at a
/// time (a worker with nothing running is admitted regardless, so the
/// floor decides concurrency, not whether the stage can run). When the
/// machine cannot be asked, `fallback` — the old fixed number — so an
/// unknown platform behaves as it did.
pub fn stage_ceiling(available: Option<u64>, reserve: u64, floor: u64, fallback: u64) -> u64 {
    match available {
        Some(avail) => {
            let half = avail / 2;
            let leaving_reserve = avail.saturating_sub(reserve);
            half.min(leaving_reserve).max(floor)
        }
        None => fallback,
    }
}

pub fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    fn status() -> Option<MEMORYSTATUSEX> {
        // SAFETY: MEMORYSTATUSEX is plain data; zeroed is a valid value
        // for every field, and dwLength must carry the struct size for
        // the call to accept it. The pointer is to a live local.
        let mut s: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        s.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        let ok = unsafe { GlobalMemoryStatusEx(&mut s) };
        if ok != 0 { Some(s) } else { None }
    }

    pub fn available_bytes() -> Option<u64> { status().map(|s| s.ullAvailPhys) }
    pub fn total_bytes() -> Option<u64> { status().map(|s| s.ullTotalPhys) }

    pub fn process_resident_bytes() -> Option<u64> {
        // SAFETY: PROCESS_MEMORY_COUNTERS is plain data, zeroed is valid,
        // `cb` carries the size, and GetCurrentProcess returns a pseudo
        // handle that needs no closing.
        let mut c: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) };
        if ok != 0 { Some(c.WorkingSetSize as u64) } else { None }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    /// One `Key:   12345 kB` line out of /proc/meminfo, in bytes.
    fn meminfo(key: &str) -> Option<u64> {
        let text = std::fs::read_to_string("/proc/meminfo").ok()?;
        let line = text.lines().find(|l| l.starts_with(key))?;
        let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
        Some(kb * 1024)
    }

    pub fn available_bytes() -> Option<u64> { meminfo("MemAvailable:") }
    pub fn total_bytes() -> Option<u64> { meminfo("MemTotal:") }

    pub fn process_resident_bytes() -> Option<u64> {
        // VmRSS in /proc/self/status is already in kB, which spares
        // asking for the page size that /proc/self/statm would need.
        let text = std::fs::read_to_string("/proc/self/status").ok()?;
        let line = text.lines().find(|l| l.starts_with("VmRSS:"))?;
        let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
        Some(kb * 1024)
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    pub fn available_bytes() -> Option<u64> { None }
    pub fn total_bytes() -> Option<u64> { None }
    pub fn process_resident_bytes() -> Option<u64> { None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::alloc::GlobalAlloc;

    const GIB: u64 = 1024 * 1024 * 1024;
    const MIB: u64 = 1024 * 1024;

    /// The number the old code used, so the fallback is exactly the old
    /// behaviour and nothing else.
    const OLD: u64 = 768 * MIB;

    #[test]
    fn an_unknown_machine_keeps_the_old_ceiling() {
        assert_eq!(stage_ceiling(None, 2 * GIB, 512 * MIB, OLD), OLD);
    }

    /// The case that motivated this: a big machine was being held to a
    /// number sized for a small one.
    #[test]
    fn a_large_machine_gets_a_larger_ceiling() {
        let c = stage_ceiling(Some(48 * GIB), 2 * GIB, 512 * MIB, OLD);
        assert_eq!(c, 24 * GIB, "half of what is available");
        assert!(c > OLD);
    }

    /// And the case that killed the renderer: a machine with little
    /// free. The reserve binds first, then the floor — and only the
    /// second of these lands below the old fixed number, which is the
    /// point: the old ceiling was not low enough for a tight machine.
    #[test]
    fn a_tight_machine_is_held_back_and_keeps_the_reserve() {
        // 3 GiB free: half = 1.5 GiB, leaving-reserve = 1 GiB → 1 GiB.
        // The reserve is what decided, not the half.
        assert_eq!(stage_ceiling(Some(3 * GIB), 2 * GIB, 512 * MIB, OLD), 1 * GIB);
        // 2.5 GiB free: leaving-reserve = 512 MiB, which is the floor,
        // and 512 MiB is below the 768 MiB the old code would have used
        // on this same machine.
        let c = stage_ceiling(Some(2 * GIB + 512 * MIB), 2 * GIB, 512 * MIB, OLD);
        assert_eq!(c, 512 * MIB);
        assert!(c < OLD, "a tight machine must be held below the old fixed ceiling");
    }

    #[test]
    fn the_floor_keeps_a_starved_machine_moving() {
        // 1 GiB available, 2 GiB reserve: leaving-reserve saturates to 0,
        // half is 512 MiB — the floor is what remains.
        assert_eq!(stage_ceiling(Some(1 * GIB), 2 * GIB, 512 * MIB, OLD), 512 * MIB);
        assert_eq!(stage_ceiling(Some(0), 2 * GIB, 512 * MIB, OLD), 512 * MIB);
    }

    #[test]
    fn the_ceiling_never_exceeds_half_of_what_is_available() {
        for avail in [1 * GIB, 4 * GIB, 16 * GIB, 64 * GIB, 256 * GIB] {
            let c = stage_ceiling(Some(avail), 2 * GIB, 512 * MIB, OLD);
            assert!(c <= (avail / 2).max(512 * MIB), "avail {avail}: ceiling {c}");
        }
    }

    /// On the platforms this runs on, the gauges answer — and the
    /// resident set moves when this process allocates and touches
    /// memory, which is the property the admission gate depends on.
    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn the_gauges_answer_and_the_resident_set_follows_allocation() {
        let total = total_bytes().expect("total memory");
        let avail = available_bytes().expect("available memory");
        assert!(avail <= total, "available {avail} > total {total}");
        assert!(total > 256 * MIB, "implausible total {total}");

        // The resident set is the whole process's, and the rest of the
        // suite frees buffers on other threads while this runs; a free
        // of a hundred megabytes between the two readings hides the
        // growth. A few attempts, one clean reading: a gauge that does
        // not follow allocation fails them all.
        // Straight from the platform allocator, NOT the process's global
        // one: mimalloc keeps freed segments and hands them back on the
        // next request, and pages it has released with MADV_FREE stay
        // in the resident set until the kernel wants them — so a block
        // it recycles from an earlier test raises the resident set by
        // nothing, however carefully it is touched. This test is about
        // the gauge, not the allocator; the platform allocator maps a
        // fresh region for a block this size and unmaps it on free.
        let layout = std::alloc::Layout::from_size_align(256 * MIB as usize, 4096).unwrap();
        let mut last = (0u64, 0u64);
        for attempt in 0..8 {
            let before = process_resident_bytes().expect("resident set");
            // Written so the pages are actually mapped: a reserve that is
            // never touched does not show up in the resident set.
            let p = unsafe { std::alloc::System.alloc(layout) };
            assert!(!p.is_null(), "the platform allocator refused 256 MiB");
            let block = unsafe { std::slice::from_raw_parts_mut(p, layout.size()) };
            for (i, b) in block.iter_mut().enumerate().step_by(4096) { *b = (i & 0xff) as u8; }
            let after = process_resident_bytes().expect("resident set");
            std::hint::black_box(&block);
            unsafe { std::alloc::System.dealloc(p, layout) };
            if after > before + 128 * MIB { return; }
            last = (before, after);
            std::thread::sleep(std::time::Duration::from_millis(50 * (attempt + 1)));
        }
        panic!("resident set did not follow a 256 MiB allocation in eight attempts: {} -> {}", last.0, last.1);
    }
}
