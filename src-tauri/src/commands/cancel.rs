// Cancelling a long backend operation.
//
// Every long tool here emits progress on a named channel — "tst",
// "qsm", "segment" — and until now that was one-way: the user could
// watch an hour-long run and not stop it. Starting a build with the
// wrong parameters meant waiting it out or killing the application.
//
// The same names address the cancellation. A tool takes a token at the
// start, which clears any stale request and hands back a flag; it
// checks that flag wherever it can stop cleanly, and returns what it
// has rather than an error, because a cancelled run that throws away
// its work is barely better than one that cannot be cancelled.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

fn flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static F: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Take the token for `stage`, clearing any request left over from a
/// previous run. Call this once, at the start of the operation.
pub fn token(stage: &str) -> Arc<AtomicBool> {
    let mut m = flags().lock().unwrap_or_else(|e| e.into_inner());
    let f = m.entry(stage.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone();
    f.store(false, Ordering::Relaxed);
    f
}

/// Ask whatever is running on `stage` to stop. Does nothing if nothing
/// is running, which is why it is safe to call from a button.
#[tauri::command]
pub fn octree_cancel(stage: String) -> bool {
    let mut m = flags().lock().unwrap_or_else(|e| e.into_inner());
    let f = m.entry(stage).or_insert_with(|| Arc::new(AtomicBool::new(false)));
    f.store(true, Ordering::Relaxed);
    true
}

/// The stages with a run in progress right now.
fn running() -> &'static Mutex<HashSet<String>> {
    static R: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Held for as long as a stage runs. Dropping it — on return, or on
/// the unwind of a panic — marks the stage free again, so a run that
/// dies cannot leave its stage claimed for the life of the process.
pub struct RunGuard(String);

impl Drop for RunGuard {
    fn drop(&mut self) {
        running().lock().unwrap_or_else(|e| e.into_inner()).remove(&self.0);
    }
}

/// Claim `stage` for one run, or `None` if one is already in progress.
///
/// WHY. The skeleton build killed the renderer; the user pressed the
/// crash page's reload and started the build again. The backend had
/// never stopped — the first build was still reconstructing, because a
/// renderer dying does not touch a spawn_blocking thread — so the
/// second put two builds, thirty-two threads, on a machine that had
/// just run out of memory with one. Nothing refused it, and `token`
/// hands both runs the same stop flag, so cancelling either stopped
/// both. One run per stage; the second asks for it and is told no.
pub fn try_begin(stage: &str) -> Option<RunGuard> {
    let mut r = running().lock().unwrap_or_else(|e| e.into_inner());
    if r.contains(stage) {
        return None;
    }
    r.insert(stage.to_string());
    Some(RunGuard(stage.to_string()))
}

/// Whether a run holds `stage` right now.
pub fn is_running(stage: &str) -> bool {
    running().lock().unwrap_or_else(|e| e.into_inner()).contains(stage)
}

/// Whether any stage has a run in progress — what decides how often
/// the memory watch samples (see crash.rs).
pub fn any_running() -> bool {
    !running().lock().unwrap_or_else(|e| e.into_inner()).is_empty()
}

/// For a view that was (re)loaded while a run was going: is one still?
/// The panel asks this on mount, so a run it did not start is shown
/// with the same Stop it would have had.
#[tauri::command]
pub fn octree_stage_running(stage: String) -> bool {
    is_running(&stage)
}

/// Whether a stop has been asked for.
pub fn stopped(t: &AtomicBool) -> bool {
    t.load(Ordering::Relaxed)
}

/// Whether a stop was asked for on `stage`, WITHOUT clearing it —
/// `token` clears, so asking it this question always answers no.
///
/// This is for the caller that has to explain an empty result after
/// the fact: a run that produced nothing because it was stopped and
/// one that produced nothing because no tree could be reconstructed
/// look identical from outside, and the wrong message sends the user
/// to inspect their segmentation for a stop they asked for.
pub fn was_requested(stage: &str) -> bool {
    let m = flags().lock().unwrap_or_else(|e| e.into_inner());
    m.get(stage).map(|f| f.load(Ordering::Relaxed)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A TOKEN STARTS CLEAR AND STOPS WHEN ASKED, and a request from
    /// before the run started does not stop the run that follows it —
    /// which would make a cancelled operation impossible to retry.
    #[test]
    fn a_token_is_clear_until_asked_and_clear_again_next_run() {
        let t = token("test-stage-a");
        assert!(!stopped(&t), "a fresh token is not cancelled");

        octree_cancel("test-stage-a".into());
        assert!(stopped(&t), "asking must stop the run holding the token");

        // The next run takes a fresh token and is not stopped by the
        // request that ended the last one.
        let t2 = token("test-stage-a");
        assert!(!stopped(&t2), "a stale request must not kill the next run");
        // …and the old handle sees the clear too, since it is the same
        // flag: nothing keeps a reference to a token that will never
        // be cleared.
        assert!(!stopped(&t));
    }

    /// STAGES DO NOT INTERFERE. Cancelling the skeleton build must not
    /// stop a QSM run in another panel.
    #[test]
    fn one_stage_does_not_cancel_another() {
        let a = token("test-stage-b");
        let b = token("test-stage-c");
        octree_cancel("test-stage-b".into());
        assert!(stopped(&a));
        assert!(!stopped(&b), "cancelling one stage stopped another");
    }

    /// ASKING FOR A STAGE NOBODY IS RUNNING IS HARMLESS, so the button
    /// never needs to know whether it has anything to stop.
    #[test]
    fn cancelling_nothing_is_not_an_error() {
        assert!(octree_cancel("test-stage-nobody-runs".into()));
    }

    /// READING A REQUEST DOES NOT CONSUME IT. The caller that explains
    /// an empty result asks after the run has ended, and `token` — the
    /// obvious thing to reach for — CLEARS the flag, so a run that was
    /// stopped would report that it was not.
    #[test]
    fn asking_whether_a_stop_was_requested_does_not_clear_it() {
        let t = token("test-stage-d");
        assert!(!was_requested("test-stage-d"), "nothing was asked for yet");

        octree_cancel("test-stage-d".into());
        assert!(was_requested("test-stage-d"));
        // Twice, because a read that consumed the request would answer
        // yes once and no afterwards.
        assert!(was_requested("test-stage-d"), "the request was consumed by reading it");
        assert!(stopped(&t), "reading through the map cleared the running token");

        // A stage that has never run has nothing requested of it, and
        // asking must not create one that the next run then inherits.
        assert!(!was_requested("test-stage-never-seen"));
        assert!(!stopped(&token("test-stage-never-seen")));
    }

    /// The second run is refused while the first holds the stage, and
    /// admitted once the first has let go.
    #[test]
    fn one_run_per_stage() {
        let first = try_begin("rg-one").expect("free stage");
        assert!(is_running("rg-one"));
        assert!(try_begin("rg-one").is_none(), "a second run was admitted");
        // Another stage is unaffected.
        assert!(try_begin("rg-two").is_some());
        drop(first);
        assert!(!is_running("rg-one"));
        assert!(try_begin("rg-one").is_some(), "the stage stayed claimed after its run ended");
    }

    /// A run that panics must not leave its stage claimed for ever —
    /// that would make the tool unusable until the application restarts,
    /// which is the failure this replaced.
    #[test]
    fn a_run_that_unwinds_releases_its_stage() {
        let r = std::panic::catch_unwind(|| {
            let _g = try_begin("rg-panic").expect("free stage");
            panic!("the run died");
        });
        assert!(r.is_err());
        assert!(!is_running("rg-panic"), "an unwound run kept its stage");
        assert!(try_begin("rg-panic").is_some());
    }
}
