fn main() {
    emit_app_identifier();
    record_build_revision();
    tauri_build::build();
    #[cfg(feature = "rdblib")]
    rdblib::build();
    #[cfg(feature = "rivlib")]
    rivlib::build();
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
        // `rdblib` and `rivlib` link RIEGL's proprietary SDKs. Under
        // Apache-2.0 that was a build option; under GPL-3 the combined
        // work cannot be conveyed at all, because §6 wants the
        // Corresponding Source of a library nobody may redistribute and
        // §1's System Libraries exception does not stretch to a vendor
        // SDK. Building it for your own use stays fine — the GPL
        // constrains conveying, not use — so this is recorded rather
        // than refused, and the packaging script is what says no.
        //
        // Every such feature has to be listed here. A feature that
        // links a non-redistributable library and forgets this line is
        // a build the packager would happily ship.
        let mut proprietary: Vec<&str> = Vec::new();
        if cfg!(feature = "rdblib") {
            proprietary.push("rdblib");
        }
        if cfg!(feature = "rivlib") {
            proprietary.push("rivlib");
        }
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

// rdblib FFI glue — only compiled when `--features rdblib` is on. We
// look for the SDK under any of the three env-var names PDAL accepts
// (PDAL's CMake searches all three) so an existing PDAL build env
// continues to work. The path is expected to point at the rdblib root
// containing `include/` and `lib/`. Bindgen then runs against the
// canonical header `riegl/rdb.h` and emits Rust FFI declarations into
// $OUT_DIR/rdblib_bindings.rs so commands/riegl_rdb.rs can
// `include!()` them.
// RiVLib FFI glue — only compiled when `--features rivlib` is on, and
// the same shape as the rdblib module below.
//
// RiVLib's C interface is `scanifc`: the point-stream API declared in
// `include/riegl/scanifc.h`, which is what PDAL's readers.rxp drives
// too. Bindgen runs against that header so the Rust declarations match
// whichever RiVLib version is installed rather than a version this
// repository guessed, and writes them to
// $OUT_DIR/rivlib_bindings.rs for commands/riegl_rxp.rs to include!().
//
// The library is `scanifc-mt` (libscanifc-mt.so / .dylib,
// scanifc-mt.lib + scanifc-mt.dll on Windows, where the DLL also has to
// be beside the executable or on PATH at run time).
#[cfg(feature = "rivlib")]
mod rivlib {
    use std::env;
    use std::path::PathBuf;

    pub fn build() {
        let dir = env::var("RIVLIB_DIR")
            .or_else(|_| env::var("RiVLib_DIR"))
            .or_else(|_| env::var("RIVLIB_ROOT"))
            .expect(
                "the `rivlib` feature requires RIVLIB_DIR (or RiVLib_DIR / RIVLIB_ROOT) to \
                 point at a local RiVLib installation containing include/ and lib/. RiVLib is \
                 free with a RIEGL account from https://repository.riegl.com/ — and a binary \
                 built against it cannot be distributed, so do not package one.",
            );
        let root = PathBuf::from(&dir);
        let include_dir = root.join("include");
        let lib_dir = root.join("lib");

        if !include_dir.is_dir() {
            panic!("RIVLIB_DIR/include not found: {}", include_dir.display());
        }
        if !lib_dir.is_dir() {
            panic!("RIVLIB_DIR/lib not found: {}", lib_dir.display());
        }

        let header = include_dir.join("riegl/scanifc.h");
        if !header.is_file() {
            panic!(
                "riegl/scanifc.h not found under {} — is this a RiVLib installation? The \
                 point-stream C API this reader uses lives in that header.",
                include_dir.display()
            );
        }

        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        println!("cargo:rustc-link-lib=dylib=scanifc-mt");
        println!("cargo:rerun-if-env-changed=RIVLIB_DIR");
        println!("cargo:rerun-if-env-changed=RiVLib_DIR");
        println!("cargo:rerun-if-env-changed=RIVLIB_ROOT");
        println!("cargo:rerun-if-changed={}", header.display());

        let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
        let bindings = bindgen::Builder::default()
            .header(header.to_string_lossy())
            .clang_arg(format!("-I{}", include_dir.display()))
            // scanifc.h declares the C API as `scanifc_*` functions and
            // types; allow-list those so bindgen emits nothing else.
            .allowlist_function("scanifc_.*")
            .allowlist_type("scanifc_.*|SCANIFC_.*|point3dstream_handle")
            .allowlist_var("scanifc_.*|SCANIFC_.*")
            .layout_tests(false)
            .derive_default(true)
            .generate_comments(true)
            .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
            .generate()
            .expect("failed to generate RiVLib bindings — check the header path and clang install");

        bindings
            .write_to_file(out_dir.join("rivlib_bindings.rs"))
            .expect("failed to write RiVLib bindings to OUT_DIR");
    }
}

#[cfg(feature = "rdblib")]
mod rdblib {
    use std::env;
    use std::path::PathBuf;

    pub fn build() {
        let rdb_dir = env::var("RDBLIB_DIR")
            .or_else(|_| env::var("RDB_DIR"))
            .or_else(|_| env::var("rdb_DIR"))
            .expect(
                "the `rdblib` feature requires RDBLIB_DIR (or RDB_DIR / rdb_DIR) to point at \
                 a local rdblib installation — the same convention PDAL uses. Get the SDK from \
                 RIEGL's customer repository at https://repository.riegl.com/software/libraries/rdblib/",
            );
        let rdb_root = PathBuf::from(&rdb_dir);
        let include_dir = rdb_root.join("include");
        let lib_dir = rdb_root.join("lib");

        if !include_dir.is_dir() {
            panic!("RDBLIB_DIR/include not found: {}", include_dir.display());
        }
        if !lib_dir.is_dir() {
            panic!("RDBLIB_DIR/lib not found: {}", lib_dir.display());
        }

        // Tell cargo where to find the .so / .dylib / .lib + link
        // against it. The library name across platforms is "rdb"
        // (librdb.so on Linux, librdb.dylib on macOS, rdb.lib on
        // Windows).
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        println!("cargo:rustc-link-lib=dylib=rdb");
        // Re-run build.rs if the env vars or the header change so a
        // SDK upgrade triggers a fresh binding generation.
        println!("cargo:rerun-if-env-changed=RDBLIB_DIR");
        println!("cargo:rerun-if-env-changed=RDB_DIR");
        println!("cargo:rerun-if-env-changed=rdb_DIR");
        println!(
            "cargo:rerun-if-changed={}",
            include_dir.join("riegl/rdb.h").display()
        );

        let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));
        let bindings_path = out_dir.join("rdblib_bindings.rs");

        let bindings = bindgen::Builder::default()
            .header(include_dir.join("riegl/rdb.h").to_string_lossy())
            .clang_arg(format!("-I{}", include_dir.display()))
            // The rdb.h header declares the whole C API as
            // `rdb_*`-prefixed functions / `RDB_*`-prefixed
            // constants; allow-list both so bindgen doesn't generate
            // anything spurious.
            .allowlist_function("rdb_.*")
            .allowlist_type("rdb_.*|RDB_.*")
            .allowlist_var("rdb_.*|RDB_.*")
            .layout_tests(false)
            .derive_default(true)
            .generate_comments(true)
            .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
            .generate()
            .expect("failed to generate rdblib bindings — check the header path and clang install");

        bindings
            .write_to_file(&bindings_path)
            .expect("failed to write rdblib bindings to OUT_DIR");
    }
}
