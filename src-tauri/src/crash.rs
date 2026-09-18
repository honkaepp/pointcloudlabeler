// What went wrong, written somewhere a person can find it afterwards.
//
// Three things end up in `<config dir>/crash.log` (see app_id.rs):
//
//   * a panic in this process — the hook installed at startup;
//   * an error the renderer caught (its error boundary, an uncaught
//     exception, an unhandled promise rejection) and sent over;
//   * the WebView2 renderer process dying under the page.
//
// The third is the one that was missing, and the one that mattered. A
// skeleton build ran for an hour and the window went dark: only the
// native menu bar and the window's background colour were left. No
// error page, no dialog, no log line. The backend was fine — it had
// nothing to say because nothing had happened to it. The renderer
// process had been killed under the page, and the page is the only
// thing that could have reported it, and the page was gone.
//
// WebView2 reports exactly that, to the host, through ProcessFailed.
// Nobody was listening. Now the failure is logged with the reason the
// browser gives (out of memory, crashed, killed) and the exit code, the
// renderer is reloaded when reloading can bring it back, and the
// reloaded page can ask what happened and say so.

use std::io::Write;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::Serialize;

pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        let _ = write_crash_entry(info);
    }));
}

fn crash_log_path() -> Option<PathBuf> {
    // The identifier is compiled in from tauri.conf.json — see
    // app_id.rs for why it is not written out here as well.
    Some(crate::app_id::config_dir_or_home()?.join("crash.log"))
}

/// Beside crash.log: one line a minute while a stage runs, one every
/// ten otherwise, of what every process of this application holds.
fn memory_log_path() -> Option<PathBuf> {
    Some(crate::app_id::config_dir_or_home()?.join("memory.log"))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// One entry: `[unix seconds] vVERSION kind: message`, on one line —
/// a multi-line message (a stack) is joined with ` | ` so the log stays
/// one entry per line and `tail` still means something.
fn entry_line(ts: u64, kind: &str, message: &str) -> String {
    let version = env!("CARGO_PKG_VERSION");
    // Trimmed at both ends: a stack frame's indentation says nothing
    // once the frames are side by side.
    let flat: String = message
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" | ");
    format!("[{ts}] v{version} {kind}: {flat}")
}

fn append_line(line: &str) -> std::io::Result<()> {
    append_line_to(crash_log_path(), line)
}

fn append_line_to(path: Option<PathBuf>, line: &str) -> std::io::Result<()> {
    let path = path.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no application data directory",
        )
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    writeln!(f, "{line}")
}

/// Append one entry. Errors writing are swallowed: this is called from
/// the panic hook and from a process-failure handler, neither of which
/// has anywhere to put an error about the error.
pub fn log_event(kind: &str, message: &str) {
    let _ = append_line(&entry_line(now_secs(), kind, message));
}

/// One memory sample, timestamped, to memory.log.
pub fn log_memory(line: &str) {
    let _ = append_line_to(memory_log_path(), &format!("[{}] {}", now_secs(), line));
}

#[allow(deprecated)] // PanicInfo is the supported name on rust-version 1.77
fn write_crash_entry(info: &std::panic::PanicInfo<'_>) -> std::io::Result<()> {
    let payload = info.payload();
    let msg = if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "(non-string panic payload)".to_string()
    };
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "(unknown location)".to_string());
    append_line(&entry_line(now_secs(), "panic", &format!("at {location}: {msg}")))
}

// ---------------------------------------------------------------------
// Errors the renderer reports about itself.
// ---------------------------------------------------------------------

/// The renderer's own error reports: its error boundary, `window.onerror`,
/// unhandled rejections. `kind` is a short token so the log stays
/// greppable; the message is capped so a page in a loop cannot fill the
/// disk with one entry per frame.
#[tauri::command]
pub fn crash_log(kind: String, message: String) -> bool {
    const MAX_MESSAGE: usize = 16 * 1024;
    let kind: String = kind
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(32)
        .collect();
    let message = if message.len() > MAX_MESSAGE {
        let mut cut = MAX_MESSAGE;
        while !message.is_char_boundary(cut) { cut -= 1; }
        format!("{}… (truncated)", &message[..cut])
    } else {
        message
    };
    // The page's own memory samples (see the busyStage effect in
    // OctreeView.tsx) are a series, not events; they go beside the
    // process samples in memory.log, where a reader can line them up.
    if kind == "memory" {
        log_memory(&format!("page: {}", message.lines().collect::<Vec<_>>().join(" | ")));
        return true;
    }
    let kind = if kind.is_empty() { "renderer".to_string() } else { format!("renderer-{kind}") };
    log_event(&kind, &message);
    true
}

/// Where the log is, so the page can tell the user where to look.
#[tauri::command]
pub fn crash_log_location() -> Option<String> {
    crash_log_path().map(|p| p.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------
// The renderer process dying under the page.
// ---------------------------------------------------------------------

/// What WebView2 said when one of its processes failed.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RendererFailure {
    /// Which process: `render-process-exited`, `browser-process-exited`,
    /// `gpu-process-exited`, … (see `failed_kind_name`).
    pub kind: String,
    /// Why: `out-of-memory`, `crashed`, `terminated`, … (see
    /// `failed_reason_name`).
    pub reason: String,
    pub exit_code: i32,
    /// The browser's description of the process, when it gives one.
    pub description: String,
    /// Unix seconds.
    pub at: u64,
    /// Whether this side reloaded the page in response. True for a dead
    /// renderer process, which a reload replaces; false for a dead
    /// browser process, which nothing short of restarting the app does.
    pub reloaded: bool,
}

static LAST_RENDERER_FAILURE: Mutex<Option<RendererFailure>> = Mutex::new(None);

/// The most recent process failure this run, if any. In memory only,
/// deliberately: the page that asks is the one reloaded after the
/// failure, and this process outlived it. A restart clears it; the log
/// file keeps the history.
#[tauri::command]
pub fn renderer_last_failure() -> Option<RendererFailure> {
    LAST_RENDERER_FAILURE.lock().clone()
}

/// Log the failure and keep it for the reloaded page to ask about.
/// Used by the Windows watcher below and by the tests; on other
/// platforms nothing calls it, and that is not a defect.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn record_renderer_failure(failure: RendererFailure) {
    log_event(
        "webview",
        &format!(
            "{} ({}), exit code {}{}{}",
            failure.kind,
            failure.reason,
            failure.exit_code,
            if failure.description.is_empty() { String::new() } else { format!(", process: {}", failure.description) },
            if failure.reloaded { ", page reloaded" } else { ", not recoverable by reload" },
        ),
    );
    *LAST_RENDERER_FAILURE.lock() = Some(failure);
}

/// COREWEBVIEW2_PROCESS_FAILED_KIND, by value, as a token. Values from
/// the WebView2 SDK; the raw number is kept for one it does not know.
/// Used by the Windows watcher below and by the tests; on other
/// platforms nothing calls it, and that is not a defect.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn failed_kind_name(kind: i32) -> String {
    match kind {
        0 => "browser-process-exited",
        1 => "render-process-exited",
        2 => "render-process-unresponsive",
        3 => "frame-render-process-exited",
        4 => "utility-process-exited",
        5 => "sandbox-helper-process-exited",
        6 => "gpu-process-exited",
        7 => "ppapi-plugin-process-exited",
        8 => "ppapi-broker-process-exited",
        9 => "unknown-process-exited",
        other => return format!("process-failed-kind-{other}"),
    }
    .to_string()
}

/// COREWEBVIEW2_PROCESS_FAILED_REASON, by value, as a token.
/// Used by the Windows watcher below and by the tests; on other
/// platforms nothing calls it, and that is not a defect.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn failed_reason_name(reason: i32) -> String {
    match reason {
        0 => "unexpected",
        1 => "unresponsive",
        2 => "terminated",
        3 => "crashed",
        4 => "launch-failed",
        5 => "out-of-memory",
        6 => "profile-deleted",
        other => return format!("reason-{other}"),
    }
    .to_string()
}

/// Whether a failure of this kind is one a page reload recovers from.
/// The renderer process is replaced by navigating again; the browser
/// process is the thing that would do the navigating.
/// Used by the Windows watcher below and by the tests; on other
/// platforms nothing calls it, and that is not a defect.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn reload_recovers(kind: i32) -> bool {
    kind == 1 // render-process-exited
}

/// Subscribe to WebView2's ProcessFailed on the main window. Called once
/// from setup. On other platforms there is nothing to subscribe to, and
/// the crash log still gets the panic hook and the renderer's reports.
#[cfg(windows)]
pub fn watch_webview(window: &tauri::WebviewWindow) {
    let _ = window.with_webview(|platform| {
        webview_watch::install(&platform.controller());
    });
}

#[cfg(not(windows))]
pub fn watch_webview(_window: &tauri::WebviewWindow) {}

// ---------------------------------------------------------------------
// What every process of this application holds, over time.
// ---------------------------------------------------------------------
//
// The renderer died of memory on a machine with 64 GB, with this
// process holding a quarter of a gigabyte and the page holding no point
// cloud. Something in the browser's processes grew for an hour, and the
// failure report says only that it ended. So: a sample a minute while
// a stage runs — this process, the machine, and each WebView2 process
// by kind (browser, renderer, GPU, utility) with its working set and
// private bytes — and one every ten minutes otherwise, so an idle
// baseline is on record too. The page adds its own JS heap figures to
// the same file through `crash_log` with kind "memory".

/// A WebView2 process: kind, pid, working set, private bytes.
pub type ProcessSample = (String, u32, u64, u64);

/// One line of memory.log, minus the timestamp.
pub fn format_sample(
    busy: bool,
    machine_available: Option<u64>,
    app_resident: Option<u64>,
    webview: &[ProcessSample],
) -> String {
    let mib = |b: u64| format!("{:.0} MiB", b as f64 / (1024.0 * 1024.0));
    let opt = |b: Option<u64>| b.map(mib).unwrap_or_else(|| "?".to_string());
    let mut out = format!(
        "{} | machine available {} | app resident {}",
        if busy { "busy" } else { "idle" },
        opt(machine_available),
        opt(app_resident),
    );
    if webview.is_empty() {
        out.push_str(" | webview: none seen");
        return out;
    }
    let mut named: Vec<&ProcessSample> = webview.iter().collect();
    // Browser, renderer, GPU first, then the rest; biggest working set
    // first within a kind, so the one that matters reads first.
    let rank = |k: &str| match k { "browser" => 0, "renderer" => 1, "gpu" => 2, _ => 3 };
    named.sort_by(|a, b| rank(&a.0).cmp(&rank(&b.0)).then(b.2.cmp(&a.2)));
    out.push_str(" | webview:");
    for (kind, pid, ws, private) in named {
        out.push_str(&format!(" {kind}({pid}) ws {} private {};", mib(*ws), mib(*private)));
    }
    out
}

/// COREWEBVIEW2_PROCESS_KIND, by value. Used by the Windows sampler and
/// the tests; nothing else calls it elsewhere, and that is not a defect.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn process_kind_name(kind: i32) -> String {
    match kind {
        0 => "browser",
        1 => "renderer",
        2 => "utility",
        3 => "sandbox-helper",
        4 => "gpu",
        5 => "ppapi-plugin",
        6 => "ppapi-broker",
        other => return format!("kind-{other}"),
    }
    .to_string()
}

/// How long between samples: a minute while something runs, ten when
/// nothing does.
pub fn sample_interval(busy: bool) -> std::time::Duration {
    std::time::Duration::from_secs(if busy { 60 } else { 600 })
}

/// Start the sampler. One thread for the life of the process; each
/// sample is taken on the main thread, because the WebView2 objects it
/// asks live there.
pub fn start_memory_watch(window: tauri::WebviewWindow) {
    std::thread::Builder::new()
        .name("memory-watch".into())
        .spawn(move || {
            let mut last = std::time::Instant::now() - std::time::Duration::from_secs(3600);
            loop {
                std::thread::sleep(std::time::Duration::from_secs(5));
                let busy = crate::commands::cancel::any_running();
                if last.elapsed() < sample_interval(busy) { continue; }
                last = std::time::Instant::now();
                sample_once(&window, busy);
            }
        })
        .ok();
}

#[cfg(windows)]
fn sample_once(window: &tauri::WebviewWindow, busy: bool) {
    let _ = window.with_webview(move |platform| {
        let webview = webview_watch::process_memory(&platform.environment());
        log_memory(&format_sample(
            busy,
            crate::sysmem::available_bytes(),
            crate::sysmem::process_resident_bytes(),
            &webview,
        ));
    });
}

#[cfg(not(windows))]
fn sample_once(_window: &tauri::WebviewWindow, busy: bool) {
    log_memory(&format_sample(
        busy,
        crate::sysmem::available_bytes(),
        crate::sysmem::process_resident_bytes(),
        &[],
    ));
}

#[cfg(windows)]
mod webview_watch {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller, ICoreWebView2Environment, ICoreWebView2Environment8,
        ICoreWebView2ProcessFailedEventArgs2,
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_REASON,
        COREWEBVIEW2_PROCESS_KIND,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows_core::Interface;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    /// Every process WebView2 runs for this application, with what it
    /// holds. Empty when the environment predates GetProcessInfos
    /// (WebView2 runtime 1.0.1108, 2022).
    pub fn process_memory(env: &ICoreWebView2Environment) -> Vec<super::ProcessSample> {
        let mut out = Vec::new();
        let Ok(env8) = env.cast::<ICoreWebView2Environment8>() else { return out };
        // SAFETY: COM calls on a live environment, on the thread that
        // owns it (with_webview runs this on the main thread); every
        // out-pointer is to a live local.
        unsafe {
            let Ok(infos) = env8.GetProcessInfos() else { return out };
            let mut count = 0u32;
            if infos.Count(&mut count).is_err() { return out }
            for i in 0..count {
                let Ok(info) = infos.GetValueAtIndex(i) else { continue };
                let mut pid = 0i32;
                let mut kind = COREWEBVIEW2_PROCESS_KIND::default();
                if info.ProcessId(&mut pid).is_err() || info.Kind(&mut kind).is_err() { continue }
                let (ws, private) = process_memory_of(pid as u32).unwrap_or((0, 0));
                out.push((super::process_kind_name(kind.0), pid as u32, ws, private));
            }
        }
        out
    }

    /// (working set, private bytes) of another process of this user.
    fn process_memory_of(pid: u32) -> Option<(u64, u64)> {
        // SAFETY: OpenProcess with query-only rights; the handle is
        // checked and closed; the counters struct is plain data with
        // `cb` carrying its size, as the call requires.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() { return None }
            let mut c: PROCESS_MEMORY_COUNTERS_EX = std::mem::zeroed();
            c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            let ok = GetProcessMemoryInfo(h, &mut c as *mut _ as *mut PROCESS_MEMORY_COUNTERS, c.cb);
            CloseHandle(h);
            if ok == 0 { return None }
            Some((c.WorkingSetSize as u64, c.PrivateUsage as u64))
        }
    }

    pub fn install(controller: &ICoreWebView2Controller) {
        // SAFETY: plain COM calls on interfaces wry created and keeps
        // alive for the life of the window; every out-pointer is to a
        // live local.
        let Ok(core) = (unsafe { controller.CoreWebView2() }) else { return };
        let reloader = core.clone();
        let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
            unsafe { args.ProcessFailedKind(&mut kind)? };
            let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
            let mut exit_code = 0i32;
            let mut description = String::new();
            if let Ok(more) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                unsafe {
                    let _ = more.Reason(&mut reason);
                    let _ = more.ExitCode(&mut exit_code);
                    let mut text = windows_core::PWSTR::null();
                    if more.ProcessDescription(&mut text).is_ok() && !text.is_null() {
                        description = webview2_com::take_pwstr(text);
                    }
                }
            }
            let reloaded = super::reload_recovers(kind.0);
            super::record_renderer_failure(super::RendererFailure {
                kind: super::failed_kind_name(kind.0),
                reason: super::failed_reason_name(reason.0),
                exit_code,
                description,
                at: super::now_secs(),
                reloaded,
            });
            if reloaded {
                // The documented recovery: navigating again starts a new
                // renderer process. The page comes back to its start
                // screen; this process, and whatever it was running,
                // never went anywhere.
                unsafe { let _ = reloader.Reload(); }
            }
            Ok(())
        }));
        let mut token = 0i64;
        unsafe { let _ = core.add_ProcessFailed(&handler, &mut token); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_entry_is_one_line_with_the_stack_folded_in() {
        let line = entry_line(1700000000, "renderer-error", "TypeError: x is not a function\n    at f (app.js:1:2)\n\n    at g (app.js:3:4)\n");
        assert!(line.starts_with("[1700000000] v"), "{line}");
        assert!(line.contains(" renderer-error: TypeError: x is not a function | at f (app.js:1:2) | at g (app.js:3:4)"), "{line}");
        assert_eq!(line.lines().count(), 1);
    }

    /// The values are the WebView2 SDK's; the two that decide behaviour
    /// are pinned by number because the Windows-only code compares the
    /// raw value and this test runs everywhere.
    #[test]
    fn failure_kinds_and_reasons_have_names() {
        assert_eq!(failed_kind_name(1), "render-process-exited");
        assert_eq!(failed_kind_name(0), "browser-process-exited");
        assert_eq!(failed_kind_name(2), "render-process-unresponsive");
        assert_eq!(failed_kind_name(42), "process-failed-kind-42");
        assert_eq!(failed_reason_name(5), "out-of-memory");
        assert_eq!(failed_reason_name(3), "crashed");
        assert_eq!(failed_reason_name(2), "terminated");
        assert_eq!(failed_reason_name(99), "reason-99");
    }

    /// A dead renderer is reloaded; a dead browser process cannot be,
    /// and an unresponsive renderer is left alone — it may be busy, and
    /// a reload would throw that work away on a guess.
    #[test]
    fn only_a_dead_renderer_process_is_reloaded() {
        assert!(reload_recovers(1));
        assert!(!reload_recovers(0));
        assert!(!reload_recovers(2));
        assert!(!reload_recovers(6));
    }

    #[test]
    fn the_last_failure_is_kept_for_the_reloaded_page() {
        let f = RendererFailure {
            kind: failed_kind_name(1), reason: failed_reason_name(5), exit_code: -2147483645,
            description: String::new(), at: 1, reloaded: true,
        };
        // The log write is best-effort and may land in a temp config
        // dir on a test machine; what is asserted is the record.
        record_renderer_failure(f.clone());
        assert_eq!(renderer_last_failure(), Some(f));
    }

    #[test]
    fn a_memory_sample_names_every_process_biggest_renderer_first() {
        const MIB: u64 = 1024 * 1024;
        let line = format_sample(true, Some(50_000 * MIB), Some(250 * MIB), &[
            ("utility".into(), 40, 30 * MIB, 20 * MIB),
            ("renderer".into(), 12, 3_000 * MIB, 3_500 * MIB),
            ("gpu".into(), 20, 400 * MIB, 300 * MIB),
            ("browser".into(), 10, 200 * MIB, 150 * MIB),
            ("renderer".into(), 13, 90 * MIB, 80 * MIB),
        ]);
        assert!(line.starts_with("busy | machine available 50000 MiB | app resident 250 MiB | webview:"), "{line}");
        let order: Vec<usize> = ["browser(10)", "renderer(12)", "renderer(13)", "gpu(20)", "utility(40)"]
            .iter().map(|k| line.find(k).unwrap_or_else(|| panic!("{k} missing in {line}"))).collect();
        assert!(order.windows(2).all(|w| w[0] < w[1]), "order: {line}");
        assert!(line.contains("renderer(12) ws 3000 MiB private 3500 MiB;"), "{line}");
        assert_eq!(format_sample(false, None, None, &[]), "idle | machine available ? | app resident ? | webview: none seen");
    }

    #[test]
    fn samples_come_every_minute_while_busy_and_every_ten_otherwise() {
        assert_eq!(sample_interval(true).as_secs(), 60);
        assert_eq!(sample_interval(false).as_secs(), 600);
        assert_eq!(process_kind_name(1), "renderer");
        assert_eq!(process_kind_name(4), "gpu");
        assert_eq!(process_kind_name(0), "browser");
        assert_eq!(process_kind_name(9), "kind-9");
    }

    /// The page's samples are a series and go to the other file.
    #[test]
    fn page_memory_samples_are_routed_to_the_memory_log() {
        assert!(crash_log("memory".into(), "js heap 120 MiB\nnodes 0".into()));
    }

    #[test]
    fn renderer_reports_are_bounded_and_tagged() {
        assert!(crash_log("error".into(), "x".repeat(100_000)));
        assert!(crash_log("../../etc".into(), "kind is reduced to a token".into()));
    }
}
