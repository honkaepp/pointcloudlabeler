//! The application's bundle identifier, and the per-user directory it
//! names.
//!
//! One definition, taken from `tauri.conf.json` at build time (see
//! `build.rs`'s `emit_app_identifier`). It used to be written out by
//! hand as a `const APP_IDENTIFIER` in `crash.rs` and again in
//! `commands/settings.rs`, with two more copies in comments.
//!
//! That string decides where a user's data lives: `%APPDATA%\<id>` on
//! Windows, `~/.config/<id>` on Linux, `~/Library/Application
//! Support/<id>` on macOS. Two copies of it means the crash log and the
//! settings can end up in different directories — and the moment that
//! happens is a rename, which is also the moment nobody thinks to grep
//! for a string they believe they have already changed. The user's
//! symptom would be "it lost all my preferences after the update", with
//! the old file sitting intact in a directory nothing looks in any more.
//!
//! The two callers still differ in one deliberate way, and that
//! difference is the reason this is a module rather than a single
//! constant: the settings store must report a failure it cannot resolve,
//! while the crash logger must never fail at all — it runs inside a
//! panic hook, where a second panic would abort the process and destroy
//! the very report it exists to write.

/// Reverse-DNS bundle identifier, e.g. `fi.honkaepp.pointcloudlabeler`.
///
/// Compiled in from `tauri.conf.json`, so it cannot disagree with the
/// installer or the directory the shipped app reads.
pub const APP_IDENTIFIER: &str = env!("POINTCLOUDLABELER_APP_IDENTIFIER");

/// The per-user configuration directory, or `None` when the platform
/// will not name one.
///
/// Does not create it — a reader must not have the side effect of
/// bringing into existence the thing it failed to find.
pub fn config_dir() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|base| base.join(APP_IDENTIFIER))
}

/// The same directory, falling back to the home directory when the
/// platform has no config directory at all.
///
/// For the crash logger only. Writing the report somewhere slightly
/// wrong beats not writing it, and this path runs where returning an
/// error would mean returning it to a panic hook that has nowhere to
/// put it.
pub fn config_dir_or_home() -> Option<std::path::PathBuf> {
    dirs::config_dir()
        .or_else(dirs::home_dir)
        .map(|base| base.join(APP_IDENTIFIER))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The identifier reaches the binary from the file that defines it,
    /// and is usable as a directory name on every platform PointCloudLabeler ships
    /// to. `build.rs` asserts the same thing; this is what fails if the
    /// build script is ever changed to stop doing so.
    #[test]
    fn the_identifier_comes_from_the_config_and_is_a_usable_directory_name() {
        let conf = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json"),
        )
        .expect("tauri.conf.json");
        let value: serde_json::Value = serde_json::from_str(&conf).expect("valid JSON");
        let declared = value["identifier"].as_str().expect("an identifier");
        assert_eq!(
            APP_IDENTIFIER, declared,
            "the compiled-in identifier must be the one tauri.conf.json declares — \
             the installer and the settings directory both use that one"
        );

        assert!(!APP_IDENTIFIER.is_empty());
        assert!(
            APP_IDENTIFIER
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'),
            "{APP_IDENTIFIER:?} would not survive being a directory name"
        );
        // Nothing that resolves to a parent, a hidden directory, or a
        // path separator — this string is joined onto the user's config
        // root and must land exactly one level down.
        assert!(!APP_IDENTIFIER.starts_with('.') && !APP_IDENTIFIER.ends_with('.'));
        assert!(!APP_IDENTIFIER.contains(".."));
        assert!(!APP_IDENTIFIER.contains('/') && !APP_IDENTIFIER.contains('\\'));
    }

    /// Both directories are the same directory. This is the whole point:
    /// the crash log and the settings have to land in one place, and the
    /// only difference between the two accessors is what they do when
    /// the platform gives them nothing.
    #[test]
    fn the_crash_log_and_the_settings_share_one_directory() {
        if let Some(strict) = config_dir() {
            assert_eq!(
                Some(strict),
                config_dir_or_home(),
                "the fallback must only engage when there is no config dir at all"
            );
        }
        for dir in [config_dir(), config_dir_or_home()].into_iter().flatten() {
            assert!(
                dir.ends_with(APP_IDENTIFIER),
                "{dir:?} does not end in the bundle identifier"
            );
        }
    }
}
