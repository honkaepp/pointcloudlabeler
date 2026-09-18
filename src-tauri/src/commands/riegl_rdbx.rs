// RIEGL `.rdbx` — what it is, and why this build does not read it.
//
// `.rdbx` is RIEGL's RDB 2 database: RIEGL's own point-cloud format,
// read only through RIEGL's rdblib (PDAL's readers.rdb, GDAL's RDB
// driver, FME's and OPALS's readers all require the library), which is
// free with a RIEGL account and not redistributable. A GPL-3 binary
// cannot carry it, so the build that ships reads no `.rdbx` at all and
// says so BY NAME here, with the way forward: RiSCAN PRO's own export
// to E57 or LAS/LAZ, which carries the registration and imports through
// the existing E57 and LAS paths. `--features rdblib` (riegl_rdb.rs) is
// the one direct route, for one's own use.
//
// The signature check below tells an RDB 2 file from an HDF5 container
// carrying the same extension, so the message a user gets is about the
// file they actually have.
//
// RIEGL, RiSCAN PRO, RiPROCESS and RDB are trademarks of RIEGL Laser
// Measurement Systems GmbH; naming them here describes what this
// handles and claims no affiliation or endorsement. No RIEGL code,
// header or SDK is read, decompiled or redistributed here.

/// The HDF5 superblock signature. The format puts it at offset 0, or —
/// behind a user block — at 512, 1024, 2048, … up to the file's end.
const HDF5_SIGNATURE: [u8; 8] = [0x89, b'H', b'D', b'F', b'\r', b'\n', 0x1a, b'\n'];

/// Is this file an HDF5 container at all? RIEGL's own RDB 2 files are
/// not. Kept so that a `.rdbx` is described as what it is, and the one
/// in a thousand that is something else is not called RDB 2.
pub fn is_hdf5_container(path: &str) -> std::io::Result<bool> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    let len = f.metadata()?.len();
    let mut buf = [0u8; 8];
    let mut off: u64 = 0;
    loop {
        if off + 8 > len {
            return Ok(false);
        }
        f.seek(SeekFrom::Start(off))?;
        f.read_exact(&mut buf)?;
        if buf == HDF5_SIGNATURE {
            return Ok(true);
        }
        off = if off == 0 { 512 } else { off * 2 };
    }
}

/// What a `.rdbx` is, and what to do about it — the message a RiSCAN
/// PRO project's scans get in the build that ships.
pub fn rdb2_message(path: &str) -> String {
    format!(
        "{path} is a RIEGL RDB 2 database — RIEGL's own point-cloud format, not an HDF5 file — \
         and this build cannot read it: RDB 2 is read only through RIEGL's rdblib, which cannot \
         ship with PointCloudLabeler. Export the scan positions from RiSCAN PRO instead (Export → E57 \
         or LAS/LAZ, in project or global coordinates) and import that file through the E57 panel \
         or the Editor's LAS import — the registration comes with it. Or build PointCloudLabeler \
         yourself with `--features rdblib`, for your own use only."
    )
}

/// The one message for a `.rdbx` this build was asked to read. An RDB 2
/// file — every one RIEGL writes — gets the RDB 2 message. An HDF5
/// container under the extension is not RIEGL's, and this build has no
/// HDF5 reader either, so it is told that instead of being called RDB 2.
pub fn cannot_read_message(path: &str) -> String {
    match is_hdf5_container(path) {
        Ok(false) => rdb2_message(path),
        Ok(true) => format!(
            "{path} is an HDF5 container, which is not what RIEGL writes to .rdbx (RDB 2), and this \
             build has no HDF5 reader. If it came from RiSCAN PRO, export the scan positions as E57 or \
             LAS/LAZ instead and import that."
        ),
        Err(e) => format!("open .rdbx {path}: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pointcloudlabeler-rdbx-{}-{}", name, std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    /// The case the old reader was wrong about: a `.rdbx` RIEGL's own
    /// writer produced is not HDF5. It is refused by name, with the way
    /// forward — and never with a request for an HDF5 dump.
    #[test]
    fn a_real_rdb2_file_is_refused_by_name() {
        let dir = scratch("rdb2");
        let path = dir.join("260521_153945.rdbx");
        // Not the real RDB 2 layout — only what matters: no HDF5
        // signature at 0 or at any 512 · 2^n.
        let mut bytes = b"RIEGL RDB 2 ".to_vec();
        bytes.resize(4096, 0);
        std::fs::write(&path, &bytes).unwrap();
        let p = path.to_string_lossy().into_owned();
        assert_eq!(is_hdf5_container(&p).unwrap(), false);
        let err = cannot_read_message(&p);
        assert!(err.contains("RDB 2"), "does not name the format: {err}");
        assert!(err.contains("rdblib"), "does not name the only reader: {err}");
        assert!(err.contains("E57"), "offers no way forward: {err}");
        assert!(!err.contains("h5dump"), "still asks for an HDF5 dump of a file that is not HDF5: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// …while an HDF5 container is recognised, at 0 and behind a user
    /// block, and told what it is — not called RDB 2.
    #[test]
    fn an_hdf5_container_is_recognised_and_not_called_rdb2() {
        let dir = scratch("h5sig");
        let at_zero = dir.join("container.rdbx");
        let mut bytes = HDF5_SIGNATURE.to_vec();
        bytes.resize(1024, 0);
        std::fs::write(&at_zero, &bytes).unwrap();
        let p = at_zero.to_string_lossy().into_owned();
        assert_eq!(is_hdf5_container(&p).unwrap(), true);
        let msg = cannot_read_message(&p);
        assert!(msg.contains("HDF5 container") && !msg.contains("is a RIEGL RDB 2 database"), "{msg}");

        // Behind a 512-byte user block.
        let behind = dir.join("userblock.rdbx");
        let mut bytes = vec![0u8; 512];
        bytes.extend_from_slice(&HDF5_SIGNATURE);
        bytes.resize(2048, 0);
        std::fs::write(&behind, &bytes).unwrap();
        assert_eq!(is_hdf5_container(&behind.to_string_lossy()).unwrap(), true);

        // Too short to carry a signature at all.
        let tiny = dir.join("tiny.rdbx");
        std::fs::write(&tiny, b"abc").unwrap();
        assert_eq!(is_hdf5_container(&tiny.to_string_lossy()).unwrap(), false);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
