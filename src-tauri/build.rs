fn main() {
    emit_app_identifier();
    record_build_revision();
    // Only the desktop build has a Tauri context to generate; the
    // headless binary (`--no-default-features`) has none and links no
    // Tauri crate — see the `gui` feature in Cargo.toml.
    #[cfg(feature = "gui")]
    tauri_build::build();
}

/// Write down which commit this binary was compiled from, beside the
/// binary, so the release packager can ship the source that matches it.
///
/// GPL-3 §6 does not ask for "some source", it asks for the
/// Corresponding Source — the source this executable was built from.
/// The packaging script used to satisfy that by archiving HEAD and
/// refusing to run on a dirty tree, which is right only if HEAD has not
/// moved since the build. Build, `git pull`, package, and the tree is
/// clean, the check passes, and the archive is a different commit from
/// the binary beside it. Nothing in the package would say so.
///
/// A commit recorded at compile time closes it by construction: the
/// packager archives THIS commit rather than whatever HEAD happens to
/// be, so the two cannot disagree.
///
/// `-dirty` when the tree had uncommitted changes, because then no
/// commit is the source of this binary and the packager must refuse
/// rather than ship an archive that merely looks like it.
fn record_build_revision() {
    // Re-run when HEAD moves. `.git/HEAD` changes on checkout; the ref
    // it points at changes on commit. Watching both covers the ways the
    // answer can change without a source file changing.
    println!("cargo:rerun-if-changed=../.git/HEAD");
    if let Ok(head) = std::fs::read_to_string("../.git/HEAD") {
        if let Some(refname) = head.strip_prefix("ref: ").map(str::trim) {
            println!("cargo:rerun-if-changed=../.git/{refname}");
        }
    }

    let git = |args: &[&str]| -> Option<String> {
        let out = std::process::Command::new("git").args(args).output().ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    };

    // Building outside a git checkout — from the source archive this
    // very mechanism ships, or a distribution tarball — is a normal way
    // to build this and must not fail. "unknown" is the honest answer
    // there, and the packager (which only ever runs inside a checkout)
    // is what insists on better.
    let revision = match git(&["rev-parse", "HEAD"]).filter(|c| !c.is_empty()) {
        Some(commit) => {
            let dirty = git(&["status", "--porcelain", "--untracked-files=no"])
                .map(|s| !s.is_empty())
                .unwrap_or(true);
            if dirty {
                format!("{commit}-dirty")
            } else {
                commit
            }
        }
        None => "unknown".to_string(),
    };

    // OUT_DIR is <target>/<profile>/build/<pkg>-<hash>/out, so three
    // levels up is the profile directory the binary lands in. Derived
    // rather than assumed, because CARGO_TARGET_DIR can move it.
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR not set");
    if let Some(profile_dir) = std::path::Path::new(&out_dir).ancestors().nth(3) {
        let _ = std::fs::write(profile_dir.join("build-commit.txt"), &revision);
        // Which features that cannot be distributed were on.
        //
        // None in the released source: every feature of it may be
        // conveyed under the GPL, and the file is written empty.
        #[allow(unused_mut)]
        let mut proprietary: Vec<&str> = Vec::new();
        let _ =
            std::fs::write(profile_dir.join("build-proprietary.txt"), proprietary.join(", "));
    }
    // Always emitted, so `env!` is safe to add wherever the running
    // program needs to say what it was built from.
    println!("cargo:rustc-env=POINTCLOUDLABELER_BUILD_REVISION={revision}");
}

/// Hand the crate its own bundle identifier, read from the one file that
/// actually decides it.
///
/// `tauri.conf.json`'s `identifier` is what the installer registers and
/// what names the per-user config directory
/// (`%APPDATA%\<identifier>` on Windows, `~/.config/<identifier>` on
/// Linux). It was ALSO written out by hand as a `const APP_IDENTIFIER` in
/// two Rust files — the crash logger and the settings store — and
/// mentioned in two comments besides.
///
/// Four copies of a string that decides where a user's data lives. Change
/// the product's name and miss one, and the crash log goes to the new
/// directory while the settings stay in the old, or the reverse: a user
/// who "lost all their preferences" after an update, and a crash log
/// nobody thinks to look for. Renaming is exactly when that happens,
/// which is exactly when someone is least likely to grep for a string
/// they believe they have already changed.
///
/// Reading it here makes the drift impossible rather than merely
/// detectable: there is one definition, and `cargo build` fails outright
/// if it cannot be found.
fn emit_app_identifier() {
    println!("cargo:rerun-if-changed=tauri.conf.json");
    let conf = std::fs::read_to_string("tauri.conf.json")
        .expect("tauri.conf.json must be readable — it defines the bundle identifier");
    let value: serde_json::Value =
        serde_json::from_str(&conf).expect("tauri.conf.json must be valid JSON");
    let identifier = value
        .get("identifier")
        .and_then(|v| v.as_str())
        .expect("tauri.conf.json must declare a top-level \"identifier\"");
    // A reverse-DNS identifier becomes a directory name on three
    // platforms. Refuse anything that would not survive that, here,
    // rather than at a user's first launch.
    assert!(
        !identifier.is_empty()
            && identifier
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
            && !identifier.starts_with('.')
            && !identifier.ends_with('.'),
        "bundle identifier {identifier:?} is not usable as a directory name on every platform"
    );
    println!("cargo:rustc-env=POINTCLOUDLABELER_APP_IDENTIFIER={identifier}");
}

