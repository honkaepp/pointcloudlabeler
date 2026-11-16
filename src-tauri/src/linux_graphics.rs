// The WebKitGTK settings the desktop application starts with on Linux.
//
// WHY. On Linux the window is a WebKitGTK web view, and since WebKitGTK
// 2.42 it hands its frames to the window as DMA-BUF buffers. Where that
// path does not work the window opens and stays BLANK — the page runs,
// nothing is shown — and the only cure a user could find was an
// environment variable. It does not work:
//
//   * without a GPU render node (/dev/dri/renderD*): a virtual machine,
//     a remote desktop, a container — software OpenGL has no DMA-BUF to
//     hand over;
//   * with NVIDIA's proprietary driver (WebKit bug 261874), and on a
//     Wayland session with it, the explicit-sync protocol fails with
//     "Error 71 (Protocol error) dispatching to Wayland display".
//
// So the application sets what those cases need before WebKitGTK starts,
// and nothing on a machine where the default works (Intel or AMD with
// Mesa keep the faster DMA-BUF path):
//
//   WEBKIT_DISABLE_DMABUF_RENDERER=1  no render node, or an NVIDIA driver
//   __NV_DISABLE_EXPLICIT_SYNC=1      an NVIDIA driver on Wayland
//
// A variable the user has set, to anything, is left as it is — that is
// the override. POINTCLOUDLABELER_GRAPHICS chooses the rule itself:
//   auto (or unset)  as above
//   safe             the DMA-BUF renderer off on any machine
//   default          set nothing; WebKitGTK's own defaults
// What was set is written to the crash log, so a report of a blank
// window says what the application did about it.
//
// The decision is a pure function of what was detected (`quirks`), so it
// is tested here without the machine it describes.

/// What the machine has, as far as the WebKitGTK quirks care.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GraphicsEnv {
    /// NVIDIA's proprietary kernel driver is loaded.
    pub nvidia: bool,
    /// A DRM render node exists (/dev/dri/renderD*).
    pub render_node: bool,
    /// The session is Wayland (the web view then talks Wayland).
    pub wayland: bool,
}

/// POINTCLOUDLABELER_GRAPHICS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Auto,
    Safe,
    Default,
}

pub const MODE_VAR: &str = "POINTCLOUDLABELER_GRAPHICS";
pub const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
pub const NV_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";

impl Mode {
    /// An unknown value is `Auto`: a typo should not turn the fixes off.
    pub fn parse(v: Option<&str>) -> Mode {
        match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
            Some("safe") => Mode::Safe,
            Some("default") | Some("off") | Some("none") => Mode::Default,
            _ => Mode::Auto,
        }
    }
}

/// The variables to set, with why, for this machine and mode. `is_set`
/// says whether the user already set one; those are never touched.
pub fn quirks(env: GraphicsEnv, mode: Mode, is_set: impl Fn(&str) -> bool) -> Vec<(&'static str, &'static str, &'static str)> {
    let mut out = Vec::new();
    if mode == Mode::Default {
        return out;
    }
    let dmabuf_why = if mode == Mode::Safe {
        Some("POINTCLOUDLABELER_GRAPHICS=safe")
    } else if !env.render_node {
        Some("no GPU render node (virtual machine, remote desktop or software OpenGL)")
    } else if env.nvidia {
        Some("NVIDIA proprietary driver")
    } else {
        None
    };
    if let Some(why) = dmabuf_why {
        if !is_set(DMABUF) {
            out.push((DMABUF, "1", why));
        }
    }
    if env.nvidia && env.wayland && !is_set(NV_EXPLICIT_SYNC) {
        out.push((NV_EXPLICIT_SYNC, "1", "NVIDIA proprietary driver on Wayland"));
    }
    out
}

/// What this machine has.
#[cfg(target_os = "linux")]
pub fn detect() -> GraphicsEnv {
    use std::path::Path;
    let nvidia = Path::new("/proc/driver/nvidia/version").exists() || Path::new("/sys/module/nvidia_drm").exists();
    let render_node = std::fs::read_dir("/dev/dri")
        .map(|d| d.flatten().any(|e| e.file_name().to_string_lossy().starts_with("renderD")))
        .unwrap_or(false);
    let non_empty = |k: &str| std::env::var_os(k).is_some_and(|v| !v.is_empty());
    let wayland = non_empty("WAYLAND_DISPLAY")
        || std::env::var("XDG_SESSION_TYPE").map(|s| s.eq_ignore_ascii_case("wayland")).unwrap_or(false);
    GraphicsEnv { nvidia, render_node, wayland }
}

/// Set the variables this machine needs. Call first thing in `run()`,
/// before any thread starts and before WebKitGTK reads its environment.
#[cfg(target_os = "linux")]
pub fn apply() {
    let env = detect();
    let mode = Mode::parse(std::env::var(MODE_VAR).ok().as_deref());
    let set = quirks(env, mode, |k| std::env::var_os(k).is_some());
    let mut notes = Vec::new();
    for (k, v, why) in &set {
        std::env::set_var(k, v);
        notes.push(format!("{k}={v} ({why})"));
    }
    let line = format!(
        "nvidia={} render_node={} wayland={} mode={:?}; set: {}",
        env.nvidia,
        env.render_node,
        env.wayland,
        mode,
        if notes.is_empty() { "nothing".to_string() } else { notes.join(", ") },
    );
    eprintln!("[graphics] {line}");
    crate::crash::log_event("linux-graphics", &line);
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESA: GraphicsEnv = GraphicsEnv { nvidia: false, render_node: true, wayland: false };
    const VM: GraphicsEnv = GraphicsEnv { nvidia: false, render_node: false, wayland: false };
    const NV_X11: GraphicsEnv = GraphicsEnv { nvidia: true, render_node: true, wayland: false };
    const NV_WAYLAND: GraphicsEnv = GraphicsEnv { nvidia: true, render_node: true, wayland: true };
    const UNSET: fn(&str) -> bool = |_| false;

    fn names(v: &[(&str, &str, &str)]) -> Vec<String> {
        v.iter().map(|(k, val, _)| format!("{k}={val}")).collect()
    }

    #[test]
    fn a_working_gpu_keeps_webkits_defaults() {
        assert!(quirks(MESA, Mode::Auto, UNSET).is_empty());
        assert!(quirks(GraphicsEnv { wayland: true, ..MESA }, Mode::Auto, UNSET).is_empty());
    }

    #[test]
    fn no_render_node_turns_the_dmabuf_renderer_off() {
        assert_eq!(names(&quirks(VM, Mode::Auto, UNSET)), ["WEBKIT_DISABLE_DMABUF_RENDERER=1"]);
    }

    #[test]
    fn nvidia_turns_it_off_and_on_wayland_explicit_sync_too() {
        assert_eq!(names(&quirks(NV_X11, Mode::Auto, UNSET)), ["WEBKIT_DISABLE_DMABUF_RENDERER=1"]);
        assert_eq!(
            names(&quirks(NV_WAYLAND, Mode::Auto, UNSET)),
            ["WEBKIT_DISABLE_DMABUF_RENDERER=1", "__NV_DISABLE_EXPLICIT_SYNC=1"],
        );
    }

    #[test]
    fn what_the_user_set_is_left_alone() {
        let dmabuf_set = |k: &str| k == DMABUF;
        assert_eq!(names(&quirks(NV_WAYLAND, Mode::Auto, dmabuf_set)), ["__NV_DISABLE_EXPLICIT_SYNC=1"]);
        assert!(quirks(VM, Mode::Safe, |_| true).is_empty());
    }

    #[test]
    fn the_mode_variable_forces_or_disables() {
        assert_eq!(names(&quirks(MESA, Mode::Safe, UNSET)), ["WEBKIT_DISABLE_DMABUF_RENDERER=1"]);
        assert!(quirks(NV_WAYLAND, Mode::Default, UNSET).is_empty());
        assert!(quirks(VM, Mode::Default, UNSET).is_empty());
    }

    #[test]
    fn the_mode_is_read_forgivingly() {
        assert_eq!(Mode::parse(None), Mode::Auto);
        assert_eq!(Mode::parse(Some(" SAFE ")), Mode::Safe);
        assert_eq!(Mode::parse(Some("default")), Mode::Default);
        assert_eq!(Mode::parse(Some("off")), Mode::Default);
        assert_eq!(Mode::parse(Some("sfae")), Mode::Auto);
    }
}
