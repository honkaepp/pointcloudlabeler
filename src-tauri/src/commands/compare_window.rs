//! A second window beside the editor, for another tree or cloud.
//!
//! WHY A WINDOW AND NOT A SPLIT VIEW. The editor is built around one
//! dataset per page: the viewer's engine and streamer, the shell's state,
//! and a dozen module-level stores (forest seeds, survey, views & video,
//! tree metric colours, jobs) each hold "the" open dataset. A second view
//! inside the same page would have to make every one of them per-view
//! before a single measuring tool worked in it. A second webview runs the
//! same application in its own page, so it has all of it — every panel,
//! colour mode and measuring tool — for its own dataset, and nothing in
//! the first window changes. It can also go on a second screen.
//!
//! What the two windows share is this process: the open project, the
//! grants, the commands. Three things keep them apart:
//!
//! - a menu click is acted on only by the window whose menu bar it was
//!   (menu.rs puts the focused window's label in the click), and a drop
//!   only by the window it was dropped on (dataopen.rs);
//! - a dataset open in one window is read-only in the other (the claims
//!   below): two editors writing one dataset's patches and sidecars would
//!   each overwrite the other's work;
//! - closing the editor closes the second window.
//!
//! The cameras and colour modes are linked in the renderer, by events
//! between the two pages (state/compareWindow.ts).

use std::collections::HashMap;
use std::path::Path;

use parking_lot::Mutex;

/// The second window's label. Also listed in capabilities/default.json,
/// without which its page could call no command.
pub const COMPARE_LABEL: &str = "compare";
/// The editor's window (tauri.conf.json).
pub const MAIN_LABEL: &str = "main";

/// Which window holds which dataset for writing: the first to open it.
#[derive(Default)]
pub struct DatasetClaims {
    held: Mutex<HashMap<String, String>>,
}

/// One spelling per folder: canonical where the folder exists, separators
/// and case folded on Windows, no trailing separator.
pub fn dataset_key(dir: &str) -> String {
    let p = Path::new(dir);
    let s = std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().into_owned())
        .unwrap_or_else(|_| dir.to_string());
    let s = s.trim_start_matches(r"\\?\");
    let mut s = s.replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

impl DatasetClaims {
    /// Claim `dir` for `label`. None when it is now the label's (or already
    /// was); the other window's label when that window holds it — the
    /// caller then opens it read-only.
    pub fn claim(&self, dir: &str, label: &str) -> Option<String> {
        let key = dataset_key(dir);
        let mut held = self.held.lock();
        match held.get(&key) {
            Some(owner) if owner != label => Some(owner.clone()),
            _ => {
                held.insert(key, label.to_string());
                None
            }
        }
    }

    /// Give `dir` up, if `label` holds it.
    pub fn release(&self, dir: &str, label: &str) {
        let key = dataset_key(dir);
        let mut held = self.held.lock();
        if held.get(&key).map(|o| o == label).unwrap_or(false) {
            held.remove(&key);
        }
    }

    /// Everything `label` holds — its window has closed.
    pub fn release_all(&self, label: &str) {
        self.held.lock().retain(|_, owner| owner != label);
    }

    /// Who holds `dir`, if anyone.
    pub fn holder(&self, dir: &str) -> Option<String> {
        self.held.lock().get(&dataset_key(dir)).cloned()
    }
}

/// The second window's page: the app with `?window=compare`, and the
/// dataset to open when one was asked for.
pub fn compare_url(dataset: Option<&str>) -> String {
    match dataset {
        Some(d) if !d.is_empty() => format!("index.html?window=compare&dataset={}", url_encode(d)),
        _ => "index.html?window=compare".to_string(),
    }
}

/// Percent-encoding for a query value (RFC 3986 unreserved kept).
pub fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Two windows side by side in a work area: the left half and the right
/// half, as (x, y, width, height) in physical pixels.
pub fn halves(x: i32, y: i32, w: u32, h: u32) -> ((i32, i32, u32, u32), (i32, i32, u32, u32)) {
    let left = w / 2;
    ((x, y, left, h), (x + left as i32, y, w - left, h))
}

#[cfg(feature = "gui")]
mod gui {
    use super::*;
    use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

    /// An event for one window: its label, and the dataset when there is one.
    #[derive(serde::Serialize, Clone)]
    struct ForWindow {
        window: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        dir: Option<String>,
    }

    /// The editor's WebView2 arguments (tauri.conf.json). Every webview of
    /// one user-data folder must be started with the same ones, or the
    /// second window fails to open.
    const BROWSER_ARGS: &str = "--force_high_performance_gpu --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --enable-features=Vulkan,UseSkiaRenderer";

    fn arrange(app: &AppHandle) -> Result<(), String> {
        let main = app.get_webview_window(MAIN_LABEL).ok_or("the editor window is gone")?;
        let other = app.get_webview_window(COMPARE_LABEL).ok_or("the second window is not open")?;
        let monitor = main
            .current_monitor()
            .map_err(|e| e.to_string())?
            .or(main.primary_monitor().map_err(|e| e.to_string())?)
            .ok_or("no monitor")?;
        let area = monitor.work_area();
        let (l, r) = halves(area.position.x, area.position.y, area.size.width, area.size.height);
        for (w, (x, y, ww, hh)) in [(&main, l), (&other, r)] {
            let _ = w.unmaximize();
            w.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
            w.set_size(PhysicalSize::new(ww, hh)).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn build(app: &AppHandle, dataset: Option<&str>) -> Result<WebviewWindow, String> {
        let url = WebviewUrl::App(compare_url(dataset).into());
        let w = WebviewWindowBuilder::new(app, COMPARE_LABEL, url)
            .title("PointCloudLabeler — second window")
            .inner_size(1200.0, 860.0)
            .min_inner_size(640.0, 480.0)
            .background_color(tauri::window::Color(10, 17, 13, 255))
            .additional_browser_args(BROWSER_ARGS)
            .build()
            .map_err(|e| format!("could not open the second window: {e}"))?;
        crate::crash::watch_webview(&w);
        let handle = app.clone();
        w.on_window_event(move |e| {
            if let tauri::WindowEvent::Destroyed = e {
                handle.state::<DatasetClaims>().release_all(COMPARE_LABEL);
                // Tell the editor its partner is gone (the camera link
                // shows it as closed). Broadcast with the window it is
                // for, as the menu's clicks are: the pages listen to every
                // event and keep their own.
                let _ = handle.emit("compare-window-closed", ForWindow { window: MAIN_LABEL.to_string(), dir: None });
            }
        });
        Ok(w)
    }

    /// Open the second window (or bring it forward), with `dataset` open
    /// in it when given; `side_by_side` puts it beside the editor, the
    /// editor on the left half of its screen.
    #[tauri::command]
    pub async fn compare_window_open(app: AppHandle, dataset: Option<String>, side_by_side: bool) -> Result<(), String> {
        if let Some(w) = app.get_webview_window(COMPARE_LABEL) {
            if let Some(d) = dataset.as_deref() {
                let _ = app.emit("compare-open-dataset", ForWindow { window: COMPARE_LABEL.to_string(), dir: Some(d.to_string()) });
            }
            let _ = w.unminimize();
            let _ = w.set_focus();
        } else {
            // Window creation must not run on the thread that handles the
            // command on Windows (WebView2 deadlocks); an async command runs
            // on the async runtime, which is fine.
            build(&app, dataset.as_deref())?;
        }
        if side_by_side {
            arrange(&app)?;
        }
        Ok(())
    }

    /// Put the editor on the left half of its screen and the second
    /// window on the right.
    #[tauri::command]
    pub async fn compare_window_arrange(app: AppHandle) -> Result<(), String> {
        arrange(&app)
    }

    /// Is the second window open?
    #[tauri::command]
    pub fn compare_window_is_open(app: AppHandle) -> bool {
        app.get_webview_window(COMPARE_LABEL).is_some()
    }

    /// Close the second window.
    #[tauri::command]
    pub fn compare_window_close(app: AppHandle) -> Result<(), String> {
        if let Some(w) = app.get_webview_window(COMPARE_LABEL) {
            w.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Claim `dir` for the calling window. Null when it may write there;
    /// the other window's label when that window has it open — the caller
    /// then shows it read-only.
    #[tauri::command]
    pub fn window_claim_dataset(window: tauri::Window, claims: tauri::State<'_, DatasetClaims>, dir: String) -> Option<String> {
        claims.claim(&dir, window.label())
    }

    /// The calling window has closed `dir`.
    #[tauri::command]
    pub fn window_release_dataset(window: tauri::Window, claims: tauri::State<'_, DatasetClaims>, dir: String) {
        claims.release(&dir, window.label());
    }

    /// When the editor's window goes, the second window goes with it —
    /// left alone it would keep the application running with no editor.
    pub fn watch_main(main: &WebviewWindow) {
        let app = main.app_handle().clone();
        main.on_window_event(move |e| {
            if let tauri::WindowEvent::Destroyed = e {
                if let Some(w) = app.get_webview_window(COMPARE_LABEL) {
                    let _ = w.close();
                }
            }
        });
    }
}

#[cfg(feature = "gui")]
pub use gui::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_window_to_open_a_dataset_holds_it() {
        let c = DatasetClaims::default();
        assert_eq!(c.claim("D:/plots/p1", "main"), None);
        // The editor opening it again is still the editor's.
        assert_eq!(c.claim("D:/plots/p1", "main"), None);
        // The second window sees who holds it, and does not take it.
        assert_eq!(c.claim("D:/plots/p1", "compare"), Some("main".to_string()));
        assert_eq!(c.holder("D:/plots/p1").as_deref(), Some("main"));
        // Another dataset is the second window's.
        assert_eq!(c.claim("D:/plots/p2", "compare"), None);
    }

    #[test]
    fn released_by_its_holder_only_and_all_at_once_when_a_window_closes() {
        let c = DatasetClaims::default();
        c.claim("D:/a", "main");
        c.claim("D:/b", "compare");
        c.claim("D:/c", "compare");
        c.release("D:/a", "compare");
        assert_eq!(c.holder("D:/a").as_deref(), Some("main"));
        c.release("D:/a", "main");
        assert_eq!(c.holder("D:/a"), None);
        c.release_all("compare");
        assert_eq!(c.holder("D:/b"), None);
        assert_eq!(c.holder("D:/c"), None);
        // Free again: whoever opens it next holds it.
        assert_eq!(c.claim("D:/b", "main"), None);
    }

    #[test]
    fn one_folder_has_one_key_however_it_is_spelled() {
        let dir = std::env::temp_dir().join("pcl_claims_key");
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.to_string_lossy().into_owned();
        let b = format!("{a}/");
        assert_eq!(dataset_key(&a), dataset_key(&b));
        if cfg!(windows) {
            assert_eq!(dataset_key(&a), dataset_key(&a.to_uppercase()));
            assert_eq!(dataset_key(&a), dataset_key(&a.replace('\\', "/")));
        }
        assert!(!dataset_key(&a).starts_with(r"\\?\"));
        let c = DatasetClaims::default();
        c.claim(&a, "main");
        assert_eq!(c.claim(&b, "compare"), Some("main".to_string()));
    }

    #[test]
    fn the_page_url_carries_the_dataset_encoded() {
        assert_eq!(compare_url(None), "index.html?window=compare");
        assert_eq!(compare_url(Some("")), "index.html?window=compare");
        assert_eq!(
            compare_url(Some(r"C:\Plots\Evo 1001\octrees\p&1")),
            "index.html?window=compare&dataset=C%3A%5CPlots%5CEvo%201001%5Coctrees%5Cp%261"
        );
        assert_eq!(url_encode("puu-ä.1~_"), "puu-%C3%A4.1~_");
    }

    #[test]
    fn side_by_side_is_the_two_halves_of_the_work_area() {
        assert_eq!(halves(0, 0, 1920, 1040), ((0, 0, 960, 1040), (960, 0, 960, 1040)));
        // An odd width gives the extra pixel to the right; a second screen
        // to the left of the first has negative x.
        assert_eq!(halves(-1281, 20, 1281, 1000), ((-1281, 20, 640, 1000), (-641, 20, 641, 1000)));
    }
}
