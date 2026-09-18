// What the renderer is allowed to reach on disk.
//
// WHY THIS EXISTS
// ---------------
// `file_read`, `file_read_chunk`, `file_stat` and `file_write` take a
// path from the renderer and do the I/O. Tauri's own capability system
// does not cover them: `fs:default` scopes the fs PLUGIN, and these are
// this application's commands, so whatever the renderer asks for is
// what it gets. That made the pair of them a general primitive —
// read any file the user can read, write any file the user can write —
// and on Windows "write any file" reaches the Startup folder, which is
// code execution at next login.
//
// There is no XSS in this renderer today: React escapes, the report
// generator escapes every interpolation it makes, the two `innerHTML`
// sites write formatted numbers, and nothing loads remote content. But
// that is a property of today's code and of ~180 npm packages, not a
// boundary, and a boundary is what a published application needs.
//
// WHAT THE RULE IS
// ----------------
// A path is reachable if it is one the USER chose — picked or named in
// a native dialog, this run — or if it is inside the open project,
// which is the folder the application keeps its own datasets, clouds,
// octrees and rasters in.
//
// That is not a restriction invented for the check; it is what the
// calling code already did. Every `writeFile` call follows a save
// dialog with the path it returned. Every `readFile` call reads either
// a file the user picked or a path a Rust command produced under the
// project folder (GroundPanel loads the CHM and DSM that
// `octree_terrain` just wrote there). So the grant covers the real
// flows and the primitive stops being general.
//
// SYMLINKS AND `..`
// -----------------
// Both are resolved before the comparison, never after. A granted
// directory containing a symlink to `/etc` would otherwise be a way
// out of it, and `<project>/../../secrets` reads as under the project
// to anything that compares strings. `resolve` canonicalises what
// exists and refuses a `..` in the part that does not.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use parking_lot::Mutex;

use crate::error::{AppError, AppResult};

/// The paths the user has chosen this run. Session-scoped on purpose:
/// consent to open one file is not consent that outlives the process,
/// and nothing here is persisted.
#[derive(Default)]
pub struct PathGrants {
    files: Mutex<HashSet<PathBuf>>,
    dirs: Mutex<Vec<PathBuf>>,
}

impl PathGrants {
    /// One file the user picked in an open dialog, or named in a save
    /// dialog. A save target usually does not exist yet, so this stores
    /// the resolved-parent form rather than requiring the file.
    pub fn grant_file(&self, path: &Path) {
        if let Ok(p) = resolve_path(path) {
            self.files.lock().insert(p);
        }
    }

    /// A directory the user picked, and everything beneath it.
    pub fn grant_dir(&self, path: &Path) {
        if let Ok(p) = resolve_path(path) {
            let mut dirs = self.dirs.lock();
            if !dirs.contains(&p) {
                dirs.push(p);
            }
        }
    }

    fn permits(&self, resolved: &Path) -> bool {
        if self.files.lock().contains(resolved) {
            return true;
        }
        self.dirs.lock().iter().any(|d| resolved.starts_with(d))
    }
}

/// Resolve a path to the form the grant comparison uses: symlinks
/// followed, `.` and `..` gone.
///
/// A path that exists canonicalises outright. One that does not — a
/// save target, or a raster a command is about to write — canonicalises
/// its nearest existing ancestor and re-joins the rest, which is what
/// makes "inside a granted directory" answerable before the file is
/// there. The re-joined part may not contain `..`: there is nothing to
/// resolve it against yet, so allowing it would let
/// `<granted>/../../elsewhere` through the ancestor walk.
pub fn resolve_path(path: &Path) -> AppResult<PathBuf> {
    if let Ok(c) = path.canonicalize() {
        return Ok(c);
    }
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor = path;
    loop {
        match cursor.parent() {
            Some(parent) => {
                let name = cursor.file_name().ok_or_else(|| {
                    AppError::msg(format!("not a usable path: {}", path.display()))
                })?;
                tail.push(name);
                if let Ok(base) = parent.canonicalize() {
                    let mut out = base;
                    for name in tail.iter().rev() {
                        // `..` in the unresolved tail has no meaning the
                        // canonicaliser could have checked.
                        if *name == std::ffi::OsStr::new("..") {
                            return Err(AppError::msg(format!(
                                "path escapes through '..': {}",
                                path.display()
                            )));
                        }
                        out.push(name);
                    }
                    return Ok(out);
                }
                cursor = parent;
            }
            None => {
                return Err(AppError::msg(format!(
                    "no existing parent directory: {}",
                    path.display()
                )))
            }
        }
    }
}

/// True when `p` has a `..` component — used on a root before it is
/// trusted as a prefix.
fn has_parent_dir(p: &Path) -> bool {
    p.components().any(|c| c == Component::ParentDir)
}

/// Check one renderer-supplied path against the grants plus the open
/// project folder, returning the resolved path the caller should use.
///
/// The resolved path is the return value deliberately: a caller that
/// checked one string and then opened another would have checked
/// nothing, and this way the only path in hand is the one that passed.
pub fn authorise(
    path: &str,
    grants: &PathGrants,
    project_folder: Option<&Path>,
) -> AppResult<PathBuf> {
    let resolved = resolve_path(Path::new(path))?;
    if grants.permits(&resolved) {
        return Ok(resolved);
    }
    if let Some(folder) = project_folder {
        if !has_parent_dir(folder) {
            if let Ok(root) = resolve_path(folder) {
                if resolved.starts_with(&root) {
                    return Ok(resolved);
                }
            }
        }
    }
    Err(AppError::msg(format!(
        "not permitted: {path} — a file must be chosen in a dialog, or live in the open project"
    )))
}

/// Check that a renderer-supplied name is ONE path component.
///
/// Ids from the renderer are joined onto a directory —
/// `<project>/preprocessing/e57/<id>`, `<clouds>/<id>.tcloud` — and a
/// join does not confine anything: an id of `../../x` lands outside the
/// directory it was meant to stay in. Several of those paths are then
/// handed to `remove_dir_all`. The structural guards there (refuse
/// unless the folder carries our own manifest.json) limited what could
/// be reached; they did not confine it, and "limited" is not the
/// property wanted from a delete.
pub fn safe_component(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 128
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
        // A Windows drive letter or an NTFS alternate data stream.
        && !name.contains(':');
    if ok {
        Ok(())
    } else {
        Err(format!("not a valid id: {name}"))
    }
}

/// The most a single read may return, and the most a header length read
/// out of a file may claim.
///
/// `vec![0u8; length]` with a length from the renderer, or from a
/// four-byte header field, asks the allocator for whatever the number
/// says. On Linux the request succeeds lazily and costs nothing; on
/// Windows, which is what ships, it charges commit against RAM plus
/// pagefile and can fail — and a failed allocation aborts the process
/// rather than unwinding, which is the one outcome the release profile
/// is written to avoid (see Cargo.toml's note on `panic`).
///
/// 64 MiB is far above every real caller: the largest single read in
/// the application is the import header probe, at a few kilobytes, and
/// the streaming readers work in 1 MiB chunks.
pub const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;

/// Clamp a renderer-supplied read length, refusing rather than
/// truncating: a short read that looks like a complete one is how a
/// parser ends up reading a file it never saw the end of.
pub fn checked_read_len(length: u64) -> AppResult<usize> {
    if length > MAX_READ_BYTES {
        return Err(AppError::msg(format!(
            "read of {length} bytes refused — the limit is {MAX_READ_BYTES}"
        )));
    }
    Ok(length as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "pointcloudlabeler-grant-{tag}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn an_ungranted_path_is_refused() {
        let g = PathGrants::default();
        let dir = tmp("ungranted");
        let f = dir.join("secret.txt");
        std::fs::write(&f, b"x").unwrap();
        assert!(authorise(f.to_str().unwrap(), &g, None).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_granted_file_is_allowed_and_its_neighbour_is_not() {
        let g = PathGrants::default();
        let dir = tmp("one-file");
        let picked = dir.join("picked.las");
        let other = dir.join("other.las");
        std::fs::write(&picked, b"x").unwrap();
        std::fs::write(&other, b"x").unwrap();
        g.grant_file(&picked);
        assert!(authorise(picked.to_str().unwrap(), &g, None).is_ok());
        // Granting a file must not grant the folder it sits in.
        assert!(authorise(other.to_str().unwrap(), &g, None).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_save_target_that_does_not_exist_yet_is_allowed() {
        let g = PathGrants::default();
        let dir = tmp("save");
        let target = dir.join("export.csv");
        g.grant_file(&target); // what a save dialog returns
        assert!(authorise(target.to_str().unwrap(), &g, None).is_ok());
        assert!(!target.exists(), "the check must not create it");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_project_folder_is_reachable_and_its_parent_is_not() {
        let g = PathGrants::default();
        let root = tmp("project");
        let inside = root.join("octrees").join("ds1");
        std::fs::create_dir_all(&inside).unwrap();
        let f = inside.join("metadata.json");
        std::fs::write(&f, b"{}").unwrap();
        assert!(authorise(f.to_str().unwrap(), &g, Some(&root)).is_ok());

        let outside = root.parent().unwrap().join("elsewhere.txt");
        std::fs::write(&outside, b"x").unwrap();
        assert!(authorise(outside.to_str().unwrap(), &g, Some(&root)).is_err());
        std::fs::remove_file(&outside).ok();
        std::fs::remove_dir_all(&root).ok();
    }

    /// The string form of a path under the project folder is not the
    /// question; where it lands is. `<project>/../x` starts with the
    /// project folder as text and is outside it as a file.
    #[test]
    fn dot_dot_does_not_walk_out_of_the_project() {
        let g = PathGrants::default();
        let root = tmp("dotdot");
        let outside = root.parent().unwrap().join("pcl-grant-escape.txt");
        std::fs::write(&outside, b"x").unwrap();
        let sneaky = format!("{}/../pcl-grant-escape.txt", root.display());
        assert!(authorise(&sneaky, &g, Some(&root)).is_err(), "{sneaky} was allowed");
        std::fs::remove_file(&outside).ok();
        std::fs::remove_dir_all(&root).ok();
    }

    /// A granted directory is a directory, not a launchpad: a symlink
    /// inside it pointing elsewhere resolves elsewhere and is refused.
    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_a_granted_dir_is_refused() {
        let g = PathGrants::default();
        let dir = tmp("symlink");
        let outside_dir = tmp("symlink-target");
        let secret = outside_dir.join("secret.txt");
        std::fs::write(&secret, b"x").unwrap();
        let link = dir.join("innocent.txt");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        g.grant_dir(&dir);
        assert!(authorise(dir.join("ok.txt").to_str().unwrap(), &g, None).is_ok());
        assert!(
            authorise(link.to_str().unwrap(), &g, None).is_err(),
            "a symlink led out of a granted directory"
        );
        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&outside_dir).ok();
    }

    #[test]
    fn a_granted_dir_covers_what_is_under_it() {
        let g = PathGrants::default();
        let dir = tmp("granted-dir");
        let deep = dir.join("a").join("b");
        std::fs::create_dir_all(&deep).unwrap();
        let f = deep.join("scan.laz");
        std::fs::write(&f, b"x").unwrap();
        g.grant_dir(&dir);
        assert!(authorise(f.to_str().unwrap(), &g, None).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_lengths_are_bounded() {
        assert!(checked_read_len(1024).is_ok());
        assert!(checked_read_len(MAX_READ_BYTES).is_ok());
        assert!(checked_read_len(MAX_READ_BYTES + 1).is_err());
        // The shape that motivated the bound: a length that would ask
        // the allocator for more than the machine has.
        assert!(checked_read_len(u64::MAX).is_err());
        assert!(checked_read_len(1u64 << 40).is_err());
    }

    #[test]
    fn an_id_must_be_one_path_component() {
        for good in ["scan1", "ScanPos001", "a-b_c.d", "240423_151948"] {
            assert!(safe_component(good).is_ok(), "{good} was refused");
        }
        for bad in [
            "", ".", "..", "../x", "..\\x", "a/b", "a\\b",
            "C:evil", "stream:$DATA", "\0",
        ] {
            assert!(safe_component(bad).is_err(), "{bad:?} was accepted");
        }
        // Length, so an id cannot be used to push a path past a limit.
        assert!(safe_component(&"a".repeat(128)).is_ok());
        assert!(safe_component(&"a".repeat(129)).is_err());
    }
}
