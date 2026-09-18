// RIEGL `.rxp` reader — RiVLib FFI. Own builds only; see Cargo.toml.
//
// WHY THIS IS AN OPTIONAL FEATURE
//
// `.rxp` is RIEGL's closed streaming format: no published schema, no
// open reader. It is what a scanner writes into its own `.PROJ` project
// — every scan in one is `.rxp`, with no `.rdbx` anywhere beside it —
// so without this module a scanner-side project has no readable points
// at all. (`.rdbx` is the same arrangement — see riegl_rdbx.rs.)
//
// The only library that reads it is RIEGL's RiVLib, free with a RIEGL
// account and no more redistributable than rdblib. A GPL-3 binary
// linked against it cannot be conveyed (§6 wants Corresponding Source
// nobody may redistribute; §1's System Libraries exception does not
// cover a vendor SDK), which is why:
//
//   • the feature is off by default and the default build compiles this
//     file down to one clear error;
//   • build.rs records the feature in build-proprietary.txt;
//   • scripts/package-release.ps1 refuses to package such a build.
//
// Building it for your own measurements is fine and always will be —
// the GPL constrains conveying, not use.
//
// WHAT THE SDK PATH DOES
//
// RiVLib's C interface is `scanifc`, the same point-stream API PDAL's
// readers.rxp drives: open a stream over a `file:` URI, read points in
// blocks of (xyz, attributes, time) until the stream reports no more,
// close. Points arrive in SOCS, in metres, as f32. This applies the
// scan position's 4×4 pose to lift them into the project frame — the
// same convention as every other importer here — optionally crops to a
// world-coordinate bbox, and streams the result through the same
// las/laz Writer the E57, PTX, XYZ and .rdbx exporters use, so the
// output rides into the existing octree converter with no special case.
//
// The declarations come from bindgen over the installed
// `include/riegl/scanifc.h` (build.rs), not from names written out
// here, so they track the SDK version rather than a guess. Two places
// still name a field or a typedef — `reflectance_of` and `time_ns_of`
// below — and each says so, because a spelling change in a future
// RiVLib should be a one-line fix in an obvious place rather than a
// hunt.
//
// RIEGL, RiVLib, RiSCAN PRO and RXP are trademarks of RIEGL Laser
// Measurement Systems GmbH. Naming them describes what this reads;
// no affiliation or endorsement is claimed, and no RIEGL code is
// included in this repository.

#![allow(dead_code)] // the default build is intentionally a stub

pub use super::riegl_rdb::{RdbExportBbox as RxpExportBbox, RdbExportResult as RxpExportResult};

/// One `.rxp` to read, with the pose that places it in the project.
/// Mirrors `RdbScanRequest` so the dispatcher in riegl.rs can build
/// either from the same manifest entry.
#[derive(Clone)]
pub struct RxpScanRequest {
    /// Absolute path to the `.rxp` file.
    pub rxp_path: String,
    /// 4×4 pose (SOCS → project frame), row-major. From `final.pose`
    /// in a scanner `.PROJ`, or the SOP in a `project.rsp`.
    pub sop: Vec<f64>,
    /// Display name (the scan position's).
    pub name: String,
    /// Project EPSG when known, written into the LAS as a CRS VLR.
    pub epsg: Option<u32>,
}

/// Is this build able to read `.rxp` at all? The UI asks, because
/// whether a scan position is exportable depends on it, and a manifest
/// cannot record it: the same project folder is readable from one build
/// of PointCloudLabeler and not from another.
pub fn supported() -> bool {
    cfg!(feature = "rivlib")
}

#[cfg(not(feature = "rivlib"))]
pub fn export_region(
    out_path: &str,
    scans: &[RxpScanRequest],
    bbox: &RxpExportBbox,
) -> Result<RxpExportResult, String> {
    let _ = (out_path, scans, bbox);
    Err(
        "This build cannot read .rxp files. RIEGL's .rxp is a closed format and the only \
         library that reads it, RiVLib, is not redistributable — so no published build of \
         PointCloudLabeler can carry it. Export these scans to E57 / LAS in RiSCAN PRO and import \
         that, or install RiVLib and rebuild for your own use with \
         `cargo build --features rivlib` (RIVLIB_DIR pointing at it). A build made that way \
         must not be distributed, and the packaging script will refuse to release it."
            .to_string(),
    )
}

#[cfg(feature = "rivlib")]
pub fn export_region(
    out_path: &str,
    scans: &[RxpScanRequest],
    bbox: &RxpExportBbox,
) -> Result<RxpExportResult, String> {
    ffi::export_region(out_path, scans, bbox)
}

/// Apply a row-major 4×4 affine: world = pose × [x, y, z, 1]. Same
/// convention and same arithmetic as the .rdbx path's `apply_sop`;
/// kept here so this module compiles and is testable with the feature
/// off, which is how it is built almost everywhere.
pub fn apply_pose(pose: &[f64; 16], x: f64, y: f64, z: f64) -> (f64, f64, f64) {
    (
        pose[0] * x + pose[1] * y + pose[2] * z + pose[3],
        pose[4] * x + pose[5] * y + pose[6] * z + pose[7],
        pose[8] * x + pose[9] * y + pose[10] * z + pose[11],
    )
}

pub fn pose_from_vec(v: &[f64]) -> Result<[f64; 16], String> {
    if v.len() != 16 {
        return Err(format!("pose must be 4×4 (16 values), got {}", v.len()));
    }
    let mut out = [0f64; 16];
    out.copy_from_slice(v);
    Ok(out)
}

/// RiVLib wants a URI, not a path. PDAL's rxp reader does the same
/// thing: anything without a scheme becomes a `file:` URI. Backslashes
/// are normalised because a Windows path is what this will be handed,
/// and a URI does not take them.
pub fn file_uri(path: &str) -> String {
    if path.contains("://") || path.starts_with("file:") {
        return path.to_string();
    }
    format!("file:{}", path.replace('\\', "/"))
}

/// Reflectance in dB → LAS u16 intensity over RIEGL's [-25, 0] dB
/// range, the same mapping the .rdbx exporter uses so a project read
/// through either path lands on the same scale.
pub fn reflectance_to_intensity(db: f32) -> u16 {
    (((db as f64 + 25.0) / 25.0).clamp(0.0, 1.0) * 65535.0) as u16
}

// --- the real FFI path (only compiled with --features rivlib) -------

#[cfg(feature = "rivlib")]
mod ffi {
    #![allow(non_upper_case_globals)]
    #![allow(non_camel_case_types)]
    #![allow(non_snake_case)]
    #![allow(deref_nullptr)]
    #![allow(clippy::all)]

    // bindgen output, generated at build time from
    // $RIVLIB_DIR/include/riegl/scanifc.h.
    include!(concat!(env!("OUT_DIR"), "/rivlib_bindings.rs"));

    use super::{
        apply_pose, file_uri, pose_from_vec, reflectance_to_intensity, RxpExportBbox,
        RxpExportResult, RxpScanRequest,
    };

    /// Points per `scanifc_point3dstream_read` call. RiVLib fills up to
    /// this many per call; 64 K keeps the three buffers around 1.5 MB
    /// total and the call overhead irrelevant next to the decoding.
    const BLOCK: u32 = 65_536;

    /// The one struct field this reader takes from the SDK. If a RiVLib
    /// version spells it differently, this is the only line to change —
    /// $OUT_DIR/rivlib_bindings.rs shows the generated name.
    #[inline]
    fn reflectance_of(a: &scanifc_attributes) -> f32 {
        a.reflectance
    }

    /// The one typedef this reader assumes is an integer count of
    /// nanoseconds. Same deal: if `scanifc_time_ns` becomes a struct in
    /// some future SDK, this line is where it fails and where it is
    /// fixed.
    #[inline]
    fn time_ns_of(t: scanifc_time_ns) -> u64 {
        t as u64
    }

    /// Whatever the SDK last complained about, or the bare code.
    fn last_error(code: i32) -> String {
        let mut buf = vec![0u8; 512];
        let mut size: u32 = 0;
        let msg = unsafe {
            // c_char is i8 on x86 and u8 on some ARM targets, so the
            // cast names the C type rather than a width.
            let rc = scanifc_get_last_error(
                buf.as_mut_ptr() as *mut std::os::raw::c_char,
                buf.len() as u32,
                &mut size,
            );
            if rc != 0 || size == 0 {
                String::new()
            } else {
                let n = (size as usize).min(buf.len());
                String::from_utf8_lossy(&buf[..n]).trim_end_matches('\0').to_string()
            }
        };
        if msg.is_empty() {
            format!("RiVLib error {code}")
        } else {
            format!("RiVLib error {code}: {msg}")
        }
    }

    /// An open point stream that closes itself, so an error or a panic
    /// mid-read cannot leak the handle.
    struct Stream(point3dstream_handle);

    impl Stream {
        fn open(path: &str) -> Result<Self, String> {
            let uri = file_uri(path);
            let c_uri = std::ffi::CString::new(uri.as_str())
                .map_err(|_| format!("path is not a valid C string: {path}"))?;
            let mut handle: point3dstream_handle = std::ptr::null_mut();
            // sync_to_pps = 0: read every point as recorded rather than
            // only those inside a GPS-synchronised window. A TLS scan
            // from a tripod has no PPS, and asking for one yields
            // nothing at all.
            let rc = unsafe { scanifc_point3dstream_open(c_uri.as_ptr(), 0, &mut handle) };
            if rc != 0 || handle.is_null() {
                return Err(format!("open {path}: {}", last_error(rc)));
            }
            Ok(Self(handle))
        }

        /// One block. Returns (points read, stream still going).
        fn read(
            &mut self,
            xyz: &mut [scanifc_xyz32],
            attr: &mut [scanifc_attributes],
            time: &mut [scanifc_time_ns],
        ) -> Result<(usize, bool), String> {
            let mut got: u32 = 0;
            let mut end_of_frame: i32 = 0;
            let rc = unsafe {
                scanifc_point3dstream_read(
                    self.0,
                    BLOCK,
                    xyz.as_mut_ptr(),
                    attr.as_mut_ptr(),
                    time.as_mut_ptr(),
                    &mut got,
                    &mut end_of_frame,
                )
            };
            if rc != 0 {
                return Err(last_error(rc));
            }
            // The stream is done when a call returns no points and is
            // not merely at a frame boundary — scanifc signals the end
            // of the data that way rather than with a return code.
            let more = got > 0 || end_of_frame != 0;
            Ok((got as usize, more))
        }
    }

    impl Drop for Stream {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { scanifc_point3dstream_close(self.0) };
            }
        }
    }

    /// Read one scan, handing every point in the project frame to `f`.
    fn for_each_world<F: FnMut(f64, f64, f64, f32, u64) -> Result<(), String>>(
        req: &RxpScanRequest,
        mut f: F,
    ) -> Result<u64, String> {
        let pose = pose_from_vec(&req.sop)?;
        let mut stream = Stream::open(&req.rxp_path)?;
        let mut xyz = vec![scanifc_xyz32::default(); BLOCK as usize];
        let mut attr = vec![scanifc_attributes::default(); BLOCK as usize];
        let mut time = vec![scanifc_time_ns::default(); BLOCK as usize];
        let mut seen: u64 = 0;
        loop {
            let (got, more) = stream
                .read(&mut xyz, &mut attr, &mut time)
                .map_err(|e| format!("read {}: {e}", req.rxp_path))?;
            for i in 0..got {
                let p = &xyz[i];
                let (wx, wy, wz) =
                    apply_pose(&pose, p.x as f64, p.y as f64, p.z as f64);
                f(wx, wy, wz, reflectance_of(&attr[i]), time_ns_of(time[i]))?;
                seen += 1;
            }
            if !more {
                break;
            }
        }
        Ok(seen)
    }

    pub fn export_region(
        out_path: &str,
        scans: &[RxpScanRequest],
        bbox: &RxpExportBbox,
    ) -> Result<RxpExportResult, String> {
        use las::{point::Format, Builder, Point as LasPoint, Transform as LasTransform, Vector, Writer};

        // Pass 1: the bounds, so the LAS offset sits near the data
        // instead of at the origin. Same two-pass shape as the .rdbx
        // exporter — a .rxp decode is not cheap, but a LAS whose offset
        // is a projected coordinate away from its points loses
        // millimetres to f32 rounding downstream.
        let mut bb = [
            f64::INFINITY, f64::NEG_INFINITY,
            f64::INFINITY, f64::NEG_INFINITY,
            f64::INFINITY, f64::NEG_INFINITY,
        ];
        for s in scans {
            for_each_world(s, |x, y, z, _, _| {
                if x < bb[0] { bb[0] = x; } if x > bb[1] { bb[1] = x; }
                if y < bb[2] { bb[2] = y; } if y > bb[3] { bb[3] = y; }
                if z < bb[4] { bb[4] = z; } if z > bb[5] { bb[5] = z; }
                Ok(())
            })?;
        }
        if !bb[0].is_finite() {
            return Err("no points in the selected scans".into());
        }
        let ox = ((bb[0] + bb[1]) * 0.5).round();
        let oy = ((bb[2] + bb[3]) * 0.5).round();
        let oz = ((bb[4] + bb[5]) * 0.5).round();

        // Point format 1 = XYZ + intensity + GPS time. RiVLib gives a
        // per-point timestamp, so unlike some .rdbx exports this field
        // carries a real value.
        let mut builder = Builder::from((1, 4));
        builder.point_format = Format::new(1).map_err(|e| format!("las format: {e}"))?;
        builder.transforms = Vector {
            x: LasTransform { scale: 0.001, offset: ox },
            y: LasTransform { scale: 0.001, offset: oy },
            z: LasTransform { scale: 0.001, offset: oz },
        };
        builder.generating_software = "PointCloudLabeler — RIEGL rxp (RiVLib)".to_string();
        if let Some(vlr) = scans
            .first()
            .and_then(|s| s.epsg)
            .and_then(super::super::octree::crs_vlr_for_las_crate)
        {
            builder.vlrs.push(vlr);
        }
        let header = builder.into_header().map_err(|e| format!("build las header: {e}"))?;
        let mut writer =
            Writer::from_path(out_path, header).map_err(|e| format!("create {out_path}: {e}"))?;

        // Pass 2: write, cropping to the bbox.
        let mut written: u64 = 0;
        for (scan_no, s) in scans.iter().enumerate() {
            for_each_world(s, |x, y, z, refl, t_ns| {
                if let Some(v) = bbox.x_min { if x < v { return Ok(()); } }
                if let Some(v) = bbox.x_max { if x > v { return Ok(()); } }
                if let Some(v) = bbox.y_min { if y < v { return Ok(()); } }
                if let Some(v) = bbox.y_max { if y > v { return Ok(()); } }
                if let Some(v) = bbox.z_min { if z < v { return Ok(()); } }
                if let Some(v) = bbox.z_max { if z > v { return Ok(()); } }
                writer
                    .write_point(LasPoint {
                        x,
                        y,
                        z,
                        intensity: reflectance_to_intensity(refl),
                        gps_time: Some(t_ns as f64 * 1e-9),
                        // Which scan position this point came from —
                        // see pointqc::scan_position_psid.
                        point_source_id:
                            crate::commands::pointqc::scan_position_psid(scan_no),
                        // Single-echo sources: 1 of 1 is both the
                        // ASPRS-valid and the truthful value.
                        return_number: 1,
                        number_of_returns: 1,
                        ..Default::default()
                    })
                    .map_err(|e| format!("write point: {e}"))?;
                written += 1;
                Ok(())
            })?;
        }
        writer.close().map_err(|e| format!("close las/laz: {e}"))?;
        Ok(RxpExportResult { point_count: written })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default build must fail with an explanation and a way
    /// forward, not with a bare "unsupported". This is the message
    /// almost every user of a released build will see if they select a
    /// .rxp-only scan position, so it is worth a test.
    #[test]
    #[cfg(not(feature = "rivlib"))]
    fn the_default_build_explains_itself() {
        // Matched rather than `expect_err`ed: the Ok type is the
        // shared export result, which carries no Debug, and adding one
        // to satisfy a test is the tail wagging the dog.
        let result = export_region(
            "out.laz",
            &[RxpScanRequest {
                rxp_path: "x.rxp".into(),
                sop: vec![0.0; 16],
                name: "ScanPos001".into(),
                epsg: None,
            }],
            &RxpExportBbox {
                x_min: None, x_max: None,
                y_min: None, y_max: None,
                z_min: None, z_max: None,
            },
        );
        let err = match result {
            Ok(_) => panic!("the default build must not claim to have read a .rxp"),
            Err(e) => e,
        };
        assert!(err.contains("RiVLib"), "{err}");
        assert!(err.contains("E57"), "no alternative offered: {err}");
        assert!(err.contains("--features rivlib"), "no way forward offered: {err}");
        assert!(!supported());
    }

    /// RiVLib takes a URI. A bare Windows path handed to it opens
    /// nothing, and the failure would look like a missing file.
    #[test]
    fn a_windows_path_becomes_a_file_uri() {
        assert_eq!(
            file_uri(r"D:\Petkeljärvi\p.PROJ\ScanPos001.SCNPOS\scans\240912_164924.rxp"),
            "file:D:/Petkeljärvi/p.PROJ/ScanPos001.SCNPOS/scans/240912_164924.rxp",
        );
        assert_eq!(file_uri("/mnt/scans/a.rxp"), "file:/mnt/scans/a.rxp");
        // Already a URI: left alone, including RIEGL's live-stream
        // scheme, so pointing this at a scanner keeps working.
        assert_eq!(file_uri("file:/tmp/a.rxp"), "file:/tmp/a.rxp");
        assert_eq!(file_uri("rdtp://192.168.0.234/current"), "rdtp://192.168.0.234/current");
    }

    /// The pose has to be applied the same way the .rdbx path applies
    /// its SOP, or the two readers would place the same scan position
    /// in two different places.
    #[test]
    fn the_pose_places_a_point_in_the_project_frame() {
        // 90° about Z, then 100 m east / 200 m north / 50 m up.
        let pose = [
            0.0, -1.0, 0.0, 100.0,
            1.0,  0.0, 0.0, 200.0,
            0.0,  0.0, 1.0,  50.0,
            0.0,  0.0, 0.0,   1.0,
        ];
        let (x, y, z) = apply_pose(&pose, 1.0, 0.0, 3.0);
        assert!((x - 100.0).abs() < 1e-9, "x = {x}");
        assert!((y - 201.0).abs() < 1e-9, "y = {y}");
        assert!((z - 53.0).abs() < 1e-9, "z = {z}");
        assert!(pose_from_vec(&[0.0; 15]).is_err());
        assert!(pose_from_vec(&[0.0; 16]).is_ok());
    }

    /// Reflectance maps to intensity on the same scale as the .rdbx
    /// exporter's, so a project read through either path colours the
    /// same.
    #[test]
    fn reflectance_maps_onto_the_same_intensity_scale() {
        assert_eq!(reflectance_to_intensity(0.0), 65535);
        assert_eq!(reflectance_to_intensity(-25.0), 0);
        assert_eq!(reflectance_to_intensity(-12.5), 32767);
        // Out of range in both directions is clamped, not wrapped.
        assert_eq!(reflectance_to_intensity(5.0), 65535);
        assert_eq!(reflectance_to_intensity(-99.0), 0);
    }
}
