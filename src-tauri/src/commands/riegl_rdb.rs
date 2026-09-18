// RIEGL `.rdbx` point reader — dispatch, and the rdblib FFI behind
// `--features rdblib`.
//
// `.rdbx` is RIEGL's RDB 2 database, read only through RIEGL's rdblib,
// free with a RIEGL account and not redistributable, so the build that
// ships cannot read
// it, and this dispatcher's job in that build is to say so by name and
// point at what works: RiSCAN PRO's own export to E57 / LAS, which
// import here through the existing paths.
//
// With `--features rdblib` the bindings are generated at build time by
// build.rs (bindgen against $RDBLIB_DIR/include/riegl/rdb.h), so they
// track whatever rdblib version the user has installed. The read loop
// itself (open → bind columns → next) is still the TODO below — it can
// only be written against the bindgen output, on a machine with the SDK.
//
// References for the wrapper sketch:
//   - PDAL's RdbPointcloud.cpp (C++ wrapper around the same SDK)
//   - rdblib history.txt — repository.riegl.com/software/libraries/rdblib/

#![allow(dead_code)] // the stub case is intentionally bare

use serde::Deserialize;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RdbExportBbox {
    pub x_min: Option<f64>,
    pub x_max: Option<f64>,
    pub y_min: Option<f64>,
    pub y_max: Option<f64>,
    pub z_min: Option<f64>,
    pub z_max: Option<f64>,
}

#[derive(Clone)]
pub struct RdbScanRequest {
    /// Absolute path to the .rdbx file inside the .RiSCAN's SCANS
    /// directory. The Riegl XML parser stores per-scan-position paths
    /// in the manifest; the caller resolves a position id back to its
    /// .rdbx before invoking us.
    pub rdbx_path: String,
    /// 4×4 SOP (SOCS → PRCS), row-major. Applied per point so the
    /// exported LAS sits in the project frame, matching the convention
    /// the other importers use.
    pub sop: Vec<f64>,
    /// Display name (passed through to the LAS-writer logs).
    pub name: String,
    /// EPSG code of the RiSCAN project's global coordinate system, when
    /// project.rsp declares one. Parsed at import and previously dropped
    /// on the floor — the exported LAS carried no CRS, so the octree
    /// built from it arrived unreferenced and the user had to re-enter a
    /// code the project already knew. None when the project states none.
    pub epsg: Option<u32>,
}

#[derive(Debug)]
pub struct RdbExportResult {
    pub point_count: u64,
}

/// Public entry point — called from the existing `riegl_export_region`
/// command.
///
/// A RIEGL `.rdbx` is RDB 2, read only through rdblib, so in the build
/// that ships every export ends here with the RDB 2 message — what the
/// file is, that only rdblib reads it, and the export from RiSCAN PRO
/// that works — and nothing is written. With `--features rdblib` the
/// scans go to the FFI.
pub fn export_region(
    out_path: &str,
    scans: &[RdbScanRequest],
    bbox: &RdbExportBbox,
) -> Result<RdbExportResult, String> {
    #[cfg(not(feature = "rdblib"))]
    {
        let _ = (out_path, bbox);
        match scans.first() {
            Some(s) => Err(super::riegl_rdbx::cannot_read_message(&s.rdbx_path)),
            None => Err("no scan positions were selected".into()),
        }
    }
    #[cfg(feature = "rdblib")]
    {
        ffi::export_region(out_path, scans, bbox)
    }
}

#[cfg(all(test, not(feature = "rdblib")))]
mod dispatch_tests {
    use super::*;

    /// The build that ships, given what a RiSCAN PRO project actually
    /// holds: refused by name, with the way forward, and without asking
    /// for an HDF5 dump of a file that is not HDF5.
    #[test]
    fn a_riscan_pro_rdbx_gets_the_rdb2_message() {
        let dir = std::env::temp_dir().join(format!("pointcloudlabeler-rdb2-dispatch-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("scan.rdbx");
        let mut bytes = b"RIEGL RDB 2 ".to_vec();
        bytes.resize(2048, 0);
        std::fs::write(&path, &bytes).unwrap();
        let req = RdbScanRequest {
            rdbx_path: path.to_string_lossy().into_owned(),
            sop: vec![1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            name: "ScanPos001".into(),
            epsg: None,
        };
        let bbox = RdbExportBbox { x_min: None, x_max: None, y_min: None, y_max: None, z_min: None, z_max: None };
        let out = dir.join("out.laz").to_string_lossy().into_owned();
        let err = export_region(&out, &[req], &bbox).unwrap_err();
        assert!(err.contains("RDB 2") && err.contains("rdblib") && err.contains("RiSCAN PRO"), "{err}");
        assert!(!err.contains("h5dump") && !err.contains("HDF5 structure"), "{err}");
        assert!(!std::path::Path::new(&out).exists(), "wrote a half-baked LAS");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// --- the real FFI path (only compiled with --features rdblib) -------

#[cfg(feature = "rdblib")]
mod ffi {
    #![allow(non_upper_case_globals)]
    #![allow(non_camel_case_types)]
    #![allow(non_snake_case)]
    #![allow(deref_nullptr)]
    #![allow(clippy::all)]

    // bindgen-generated FFI declarations, populated at build time from
    // $RDBLIB_DIR/include/riegl/rdb.h.
    include!(concat!(env!("OUT_DIR"), "/rdblib_bindings.rs"));

    use super::{RdbExportBbox, RdbExportResult, RdbScanRequest};

    pub fn export_region(
        out_path: &str,
        scans: &[RdbScanRequest],
        bbox: &RdbExportBbox,
    ) -> Result<RdbExportResult, String> {
        // TODO: drive the rdblib C API to read points from each scan,
        // apply its SOP, optionally crop to bbox, and stream to LAS /
        // LAZ via the existing las::Writer pattern (see commands/e57.rs
        // for the same flow against the e57 crate's API). Until this
        // is filled in, fail loud and clear instead of writing a
        // half-baked LAS.
        //
        // Sketch of the call sequence (PDAL's C++ wrapper as reference;
        // the matching C names land in this module's bindgen output
        // when --features rdblib is enabled):
        //
        //   1. Create context
        //        rdb_context_new(...) — single shared context
        //   2. For each scan in `scans`:
        //      a. Allocate pointcloud handle
        //           rdb_pointcloud_new(ctx, ...)
        //      b. Open the file
        //           rdb_pointcloud_open(pc, path, settings)
        //      c. Start a select query (no filter, or
        //         "riegl.class != 7" to drop noise)
        //           rdb_pointcloud_query_select(pc, filter, ...)
        //      d. Bind buffers for the columns we want:
        //         "riegl.xyz" (3×f64), "riegl.reflectance" (f32),
        //         optionally "riegl.amplitude" / "riegl.class".
        //      e. Loop:
        //           rdb_query_select_next(q, want, &got);
        //           for i in 0..got: apply SOP, crop to bbox,
        //             write_point(las_writer, ...)
        //         until got == 0.
        //      f. Close + free.
        //   3. Free context.
        //
        // Drop guards (RAII wrappers around the *mut handles) keep
        // the close + free calls on every path including panic.
        let _ = (out_path, scans, bbox);
        Err(
            "rdblib FFI is wired but the read loop is not implemented yet — fill in the TODO in \
             src-tauri/src/commands/riegl_rdb.rs::ffi::export_region against the bindgen output \
             in $OUT_DIR/rdblib_bindings.rs. The build, link, and dispatch from \
             riegl_export_region all work; only the call sequence is missing."
                .to_string(),
        )
    }
}
