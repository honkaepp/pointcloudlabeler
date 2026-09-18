// Minimal single-band float32 GeoTIFF writer.
//
// Hand-rolled baseline TIFF (little-endian, single uncompressed strip)
// plus the four GeoTIFF tags every GIS needs to place a raster:
//   33550 ModelPixelScaleTag   — cell size in model units
//   33922 ModelTiepointTag      — ties raster (0,0) to a model XY
//   34735 GeoKeyDirectoryTag    — model type + raster type + CRS code
//   42113 GDAL_NODATA           — so NODATA reads as NODATA, not data
//
// No external crate: the `tiff` crate can't emit GeoTIFF tags and
// pulling a GDAL binding in would dwarf the rest of PointCloudLabeler. A DEM /
// CHM is a trivial TIFF (one strip, one float band) so the hand-rolled
// path is small and fully under our control.
//
// Orientation matches the ESRI-ASCII writer: row 0 of the image is the
// NORTHERNMOST grid row (cy = rows-1), so the .tif and .asc agree
// pixel-for-pixel. Non-finite cells are written as the NODATA value.

use std::path::Path;

const NODATA: f32 = -9999.0;

/// Write `z` (row-major, cy*cols+cx, cy=0 = south) as a georeferenced
/// float32 GeoTIFF. `min_x` / `min_y` are the lower-left corner of the
/// grid; `cell` is the pixel size in model units. `epsg`, when given,
/// is embedded as the CRS (projected for codes outside 4000..5000,
/// geographic within that band — covers WGS84 / ETRS89 vs UTM / national
/// grids).
pub fn write_geotiff_f32(
    path: &Path,
    z: &[f32],
    cols: usize,
    rows: usize,
    min_x: f64,
    min_y: f64,
    cell: f64,
    epsg: Option<u32>,
) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Err("GeoTIFF: empty grid".into());
    }
    if z.len() < cols * rows {
        return Err(format!("GeoTIFF: grid has {} cells, expected {}", z.len(), cols * rows));
    }

    // --- GeoKeyDirectory (array of u16) ---
    // Header: version 1, rev 1.0, then NumberOfKeys, then 4 shorts per key.
    //
    // Whether a CRS is geographic is asked of the CRS itself
    // (crs::is_geographic reads its proj4 definition), not guessed from
    // the numeric range 4000..5000. That band is wrong for 979 of the
    // bundled registry's 8017 codes — 688 geographic CRSs sit outside it
    // and 291 projected ones inside — and getting it wrong makes a GIS
    // read degrees as metres, or metres as degrees. The raster lands
    // nowhere near the data it describes and nothing in the file says so.
    let geographic = epsg.map(crate::commands::crs::is_geographic).unwrap_or(false);
    let mut geokeys: Vec<u16> = Vec::new();
    let mut key_entries: Vec<[u16; 4]> = Vec::new();
    // GTModelTypeGeoKey (1024): 1 = projected, 2 = geographic.
    key_entries.push([1024, 0, 1, if geographic { 2 } else { 1 }]);
    // GTRasterTypeGeoKey (1025): 1 = RasterPixelIsArea.
    key_entries.push([1025, 0, 1, 1]);
    // A classic GeoTIFF key value is a SHORT, so a code above 65535
    // cannot be expressed here — 1211 of the registry's codes are. The
    // old `code.min(u16::MAX)` wrote 65535, which is not that CRS and
    // not a reserved value either: the raster claims a CRS it is not in.
    // Writing NO CRS key instead leaves the pixel scale and tiepoint
    // intact, so the raster is still correctly placed in its own
    // coordinates and the GIS asks which CRS they are, rather than
    // answering wrongly on its own.
    if let Some(code) = epsg.filter(|c| *c <= u16::MAX as u32) {
        let code16 = code as u16;
        if geographic {
            // GeographicTypeGeoKey (2048).
            key_entries.push([2048, 0, 1, code16]);
        } else {
            // ProjectedCSTypeGeoKey (3072).
            key_entries.push([3072, 0, 1, code16]);
        }
    }
    // KeyDirectoryVersion, KeyRevision, MinorRevision, NumberOfKeys.
    geokeys.extend_from_slice(&[1, 1, 0, key_entries.len() as u16]);
    for e in &key_entries {
        geokeys.extend_from_slice(e);
    }

    // --- NODATA ascii ("-9999\0") ---
    let nodata_ascii: Vec<u8> = b"-9999\0".to_vec();

    // --- IFD tag list (must stay sorted ascending by tag id) ---
    // Each entry: (tag, type, count). Inline values get filled later;
    // external arrays get an offset. We compute offsets after sizing
    // the IFD.
    const T_SHORT: u16 = 3;
    const T_LONG: u16 = 4;
    const T_DOUBLE: u16 = 12;
    const T_ASCII: u16 = 2;

    // 15 tags total (11 baseline + 4 geo/nodata).
    let tag_count: u16 = 15;
    let ifd_offset: u32 = 8;
    let ifd_len: u32 = 2 + (tag_count as u32) * 12 + 4;
    let mut ext_cursor: u32 = ifd_offset + ifd_len;
    // Every external blob must start on an even boundary — TIFF
    // requires it and some readers assume it.
    //
    // As the sizes stand this never fires: the IFD ends at 194, and the
    // pixel scale (24), tiepoint (48), geokey directory (24 or 32) and
    // NODATA string ("-9999\0", 6) are all even, so each offset is
    // already aligned. The teeth check says so by finding no difference
    // when it is removed. It stays because it is one edit from being
    // load-bearing: a NODATA string of odd length — "-32768\0" is seven
    // bytes — misaligns the image strip and every blob after it, and the
    // file still opens, reporting shifted garbage rather than an error.
    let even = |n: u32| if n % 2 == 1 { n + 1 } else { n };

    // External blobs, in file order, recording each offset.
    let pixel_scale_off = even(ext_cursor); ext_cursor = pixel_scale_off + 3 * 8;
    let tiepoint_off = even(ext_cursor); ext_cursor = tiepoint_off + 6 * 8;
    let geokeys_off = even(ext_cursor); ext_cursor = geokeys_off + (geokeys.len() as u32) * 2;
    let nodata_off = even(ext_cursor); ext_cursor = nodata_off + nodata_ascii.len() as u32;
    let strip_off = even(ext_cursor);
    let strip_bytes = (cols * rows * 4) as u32;

    let mut buf: Vec<u8> = Vec::with_capacity(strip_off as usize + strip_bytes as usize);

    // --- TIFF header ---
    buf.extend_from_slice(b"II");          // little-endian
    buf.extend_from_slice(&42u16.to_le_bytes());
    buf.extend_from_slice(&ifd_offset.to_le_bytes());

    // --- IFD ---
    buf.extend_from_slice(&tag_count.to_le_bytes());
    let push_entry = |buf: &mut Vec<u8>, tag: u16, typ: u16, count: u32, val: u32| {
        buf.extend_from_slice(&tag.to_le_bytes());
        buf.extend_from_slice(&typ.to_le_bytes());
        buf.extend_from_slice(&count.to_le_bytes());
        // For inline SHORT (count 1) the value sits in the low 2 bytes;
        // writing the u32 LE puts it there correctly. For LONG / offsets
        // the full u32 is the value.
        buf.extend_from_slice(&val.to_le_bytes());
    };

    push_entry(&mut buf, 256, T_LONG, 1, cols as u32);                 // ImageWidth
    push_entry(&mut buf, 257, T_LONG, 1, rows as u32);                 // ImageLength
    push_entry(&mut buf, 258, T_SHORT, 1, 32);                         // BitsPerSample
    push_entry(&mut buf, 259, T_SHORT, 1, 1);                          // Compression = none
    push_entry(&mut buf, 262, T_SHORT, 1, 1);                          // Photometric = BlackIsZero
    push_entry(&mut buf, 273, T_LONG, 1, strip_off);                   // StripOffsets
    push_entry(&mut buf, 277, T_SHORT, 1, 1);                          // SamplesPerPixel
    push_entry(&mut buf, 278, T_LONG, 1, rows as u32);                 // RowsPerStrip (single strip)
    push_entry(&mut buf, 279, T_LONG, 1, strip_bytes);                 // StripByteCounts
    push_entry(&mut buf, 284, T_SHORT, 1, 1);                          // PlanarConfig = chunky
    push_entry(&mut buf, 339, T_SHORT, 1, 3);                          // SampleFormat = IEEE float
    push_entry(&mut buf, 33550, T_DOUBLE, 3, pixel_scale_off);         // ModelPixelScale
    push_entry(&mut buf, 33922, T_DOUBLE, 6, tiepoint_off);            // ModelTiepoint
    push_entry(&mut buf, 34735, T_SHORT, geokeys.len() as u32, geokeys_off); // GeoKeyDirectory
    push_entry(&mut buf, 42113, T_ASCII, nodata_ascii.len() as u32, nodata_off); // GDAL_NODATA
    // Next-IFD offset = 0 (only one image).
    buf.extend_from_slice(&0u32.to_le_bytes());

    // --- external: pixel scale (ScaleX, ScaleY, ScaleZ) ---
    pad_to(&mut buf, pixel_scale_off as usize);
    buf.extend_from_slice(&cell.to_le_bytes());
    buf.extend_from_slice(&cell.to_le_bytes());
    buf.extend_from_slice(&0.0f64.to_le_bytes());

    // --- external: tiepoint (i,j,k -> X,Y,Z); top-left pixel = NW corner ---
    pad_to(&mut buf, tiepoint_off as usize);
    let origin_y = min_y + rows as f64 * cell; // north edge
    for v in [0.0f64, 0.0, 0.0, min_x, origin_y, 0.0] {
        buf.extend_from_slice(&v.to_le_bytes());
    }

    // --- external: geokey directory ---
    pad_to(&mut buf, geokeys_off as usize);
    for k in &geokeys {
        buf.extend_from_slice(&k.to_le_bytes());
    }

    // --- external: NODATA ascii ---
    pad_to(&mut buf, nodata_off as usize);
    buf.extend_from_slice(&nodata_ascii);

    // --- image strip: north row first, NODATA for non-finite ---
    pad_to(&mut buf, strip_off as usize);
    for ry in 0..rows {
        let cy = rows - 1 - ry;
        let base = cy * cols;
        for cx in 0..cols {
            let v = z[base + cx];
            let out = if v.is_finite() { v } else { NODATA };
            buf.extend_from_slice(&out.to_le_bytes());
        }
    }

    std::fs::write(path, &buf).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Zero-pad the buffer up to `target` so the next write lands at the
/// offset recorded in the IFD (covers the even-boundary padding).
fn pad_to(buf: &mut Vec<u8>, target: usize) {
    while buf.len() < target {
        buf.push(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Re-parse the IFD we just wrote and confirm the structural
    /// invariants: little-endian header, 15 tags, the StripOffsets /
    /// StripByteCounts tags point at a strip that ends exactly at EOF,
    /// and the value of a known cell round-trips through the float
    /// strip. This catches offset-arithmetic bugs without needing a
    /// GIS to open the file.
    #[test]
    fn writes_structurally_valid_geotiff() {
        let cols = 3usize;
        let rows = 2usize;
        // cy=0 is south; fill with recognisable values, one NODATA.
        let z: Vec<f32> = vec![
            1.0, 2.0, 3.0,        // south row (cy=0)
            4.0, f32::NAN, 6.0,   // north row (cy=1)
        ];
        let dir = std::env::temp_dir().join(format!("pointcloudlabeler_geotiff_test_{}.tif", std::process::id()));
        write_geotiff_f32(&dir, &z, cols, rows, 100.0, 200.0, 0.5, Some(32635)).unwrap();
        let bytes = std::fs::read(&dir).unwrap();
        let _ = std::fs::remove_file(&dir);

        // Header.
        assert_eq!(&bytes[0..2], b"II");
        assert_eq!(u16::from_le_bytes([bytes[2], bytes[3]]), 42);
        let ifd_off = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
        assert_eq!(ifd_off, 8);

        // Tag count.
        let count = u16::from_le_bytes([bytes[ifd_off], bytes[ifd_off + 1]]);
        assert_eq!(count, 15);

        // Walk entries; pull StripOffsets (273) + StripByteCounts (279).
        let mut strip_off = 0u32;
        let mut strip_bytes = 0u32;
        for i in 0..count as usize {
            let e = ifd_off + 2 + i * 12;
            let tag = u16::from_le_bytes([bytes[e], bytes[e + 1]]);
            let val = u32::from_le_bytes([bytes[e + 8], bytes[e + 9], bytes[e + 10], bytes[e + 11]]);
            if tag == 273 { strip_off = val; }
            if tag == 279 { strip_bytes = val; }
        }
        assert_eq!(strip_bytes as usize, cols * rows * 4);
        // Strip must end exactly at EOF.
        assert_eq!(strip_off as usize + strip_bytes as usize, bytes.len());

        // North row is written first: first strip float = cy=1,cx=0 = 4.0.
        let f0 = f32::from_le_bytes([
            bytes[strip_off as usize], bytes[strip_off as usize + 1],
            bytes[strip_off as usize + 2], bytes[strip_off as usize + 3],
        ]);
        assert_eq!(f0, 4.0);
        // The NaN cell (cy=1,cx=1) becomes NODATA.
        let off_nan = strip_off as usize + 4;
        let f1 = f32::from_le_bytes([
            bytes[off_nan], bytes[off_nan + 1], bytes[off_nan + 2], bytes[off_nan + 3],
        ]);
        assert_eq!(f1, NODATA);
        // (Verified end-to-end with PIL: orientation north-first,
        // ModelPixelScale / ModelTiepoint at the NW corner, GeoKeyDir
        // marks the EPSG, GDAL_NODATA = "-9999".)
    }

    // --- reading the file back, so the georeference can be checked ---

    struct Ifd {
        bytes: Vec<u8>,
        entries: Vec<(u16, u16, u32, u32)>, // tag, type, count, value/offset
    }

    impl Ifd {
        fn read(bytes: Vec<u8>) -> Self {
            let ifd = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
            let n = u16::from_le_bytes([bytes[ifd], bytes[ifd + 1]]) as usize;
            let entries = (0..n).map(|i| {
                let e = ifd + 2 + i * 12;
                (
                    u16::from_le_bytes([bytes[e], bytes[e + 1]]),
                    u16::from_le_bytes([bytes[e + 2], bytes[e + 3]]),
                    u32::from_le_bytes(bytes[e + 4..e + 8].try_into().unwrap()),
                    u32::from_le_bytes(bytes[e + 8..e + 12].try_into().unwrap()),
                )
            }).collect();
            Ifd { bytes, entries }
        }
        fn find(&self, tag: u16) -> Option<(u16, u32, u32)> {
            self.entries.iter().find(|e| e.0 == tag).map(|e| (e.1, e.2, e.3))
        }
        fn doubles(&self, tag: u16) -> Vec<f64> {
            let (_, count, off) = self.find(tag).unwrap_or_else(|| panic!("tag {tag} missing"));
            (0..count as usize).map(|i| {
                let o = off as usize + i * 8;
                f64::from_le_bytes(self.bytes[o..o + 8].try_into().unwrap())
            }).collect()
        }
        fn shorts(&self, tag: u16) -> Vec<u16> {
            let (_, count, off) = self.find(tag).unwrap_or_else(|| panic!("tag {tag} missing"));
            (0..count as usize).map(|i| {
                let o = off as usize + i * 2;
                u16::from_le_bytes([self.bytes[o], self.bytes[o + 1]])
            }).collect()
        }
        /// GeoKeyDirectory is a header of 4 shorts then 4 per key.
        fn geokey(&self, key: u16) -> Option<u16> {
            let d = self.shorts(34735);
            let n = d[3] as usize;
            (0..n).map(|i| (d[4 + i * 4], d[7 + i * 4])).find(|(k, _)| *k == key).map(|(_, v)| v)
        }
    }

    // Deliberately mirrors write_geotiff_f32's signature so the tests
    // read like calls to the API they exercise; wrapping it in a struct
    // would put a translation layer between the test and the thing
    // under test.
    #[allow(clippy::too_many_arguments)]
    fn write_and_read(
        z: &[f32], cols: usize, rows: usize,
        min_x: f64, min_y: f64, cell: f64, epsg: Option<u32>, tag: &str,
    ) -> Ifd {
        let path = std::env::temp_dir()
            .join(format!("pointcloudlabeler_gtiff_{}_{}.tif", std::process::id(), tag));
        write_geotiff_f32(&path, z, cols, rows, min_x, min_y, cell, epsg).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        Ifd::read(bytes)
    }

    /// The whole point of a GeoTIFF, and the one thing the original test
    /// did not check.
    ///
    /// With RasterPixelIsArea, raster point (0,0) is the OUTER corner of
    /// the top-left pixel, and row 0 is the northernmost — so the
    /// tiepoint is the grid's NW corner, min_y + rows*cell up from the
    /// lower-left one the caller passes. Half a cell out here, or a
    /// north edge computed from cols instead of rows, offsets every
    /// raster PointCloudLabeler exports against the cloud it came from, and the file
    /// opens perfectly.
    #[test]
    fn ties_the_top_left_pixel_to_the_grids_north_west_corner() {
        let (cols, rows, cell) = (7usize, 3usize, 0.25f64);
        let z = vec![1.0f32; cols * rows];
        let ifd = write_and_read(&z, cols, rows, 100.0, 200.0, cell, Some(32635), "tie");

        let tp = ifd.doubles(33922);
        assert_eq!(tp.len(), 6);
        assert_eq!(&tp[0..3], &[0.0, 0.0, 0.0], "raster point is (0,0,0)");
        assert_eq!(tp[3], 100.0, "model X is the western edge");
        assert_eq!(tp[4], 200.0 + 3.0 * 0.25, "model Y is the NORTHERN edge (min_y + rows*cell)");
        assert_eq!(tp[5], 0.0);
    }

    /// ModelPixelScale is (ScaleX, ScaleY, ScaleZ) with ScaleY POSITIVE:
    /// the sign is implied by the raster's north-down row order, and
    /// writing a negative one here flips the image vertically in every
    /// reader that honours it.
    #[test]
    fn writes_a_square_positive_pixel_scale() {
        let z = vec![0.0f32; 4];
        let ifd = write_and_read(&z, 2, 2, 0.0, 0.0, 0.5, None, "scale");
        assert_eq!(ifd.doubles(33550), vec![0.5, 0.5, 0.0]);
    }

    /// A projected CRS must be tagged projected and a geographic one
    /// geographic. Guessed from the range 4000..5000, this was wrong for
    /// 979 of the bundled registry's 8017 codes; it is now asked of the
    /// CRS's own proj4 definition.
    #[test]
    fn tags_the_model_type_from_the_crs_not_from_its_number() {
        const PROJECTED: u16 = 1;
        const GEOGRAPHIC: u16 = 2;
        const MODEL_TYPE: u16 = 1024;
        const GEOG_CS: u16 = 2048;
        const PROJ_CS: u16 = 3072;
        let z = vec![0.0f32; 4];

        // Geographic codes INSIDE the old band — these always worked.
        for code in [4326u32, 4258] {
            let ifd = write_and_read(&z, 2, 2, 0.0, 0.0, 1.0, Some(code), &format!("g{code}"));
            assert_eq!(ifd.geokey(MODEL_TYPE), Some(GEOGRAPHIC), "EPSG:{code} is geographic");
            assert_eq!(ifd.geokey(GEOG_CS), Some(code as u16), "EPSG:{code} key");
            assert_eq!(ifd.geokey(PROJ_CS), None, "EPSG:{code} must not be a projected key");
        }

        // Geographic codes OUTSIDE it — these were tagged projected, so
        // a GIS read their degrees as metres.
        for code in [3824u32, 5012] {
            let ifd = write_and_read(&z, 2, 2, 0.0, 0.0, 1.0, Some(code), &format!("go{code}"));
            assert_eq!(ifd.geokey(MODEL_TYPE), Some(GEOGRAPHIC), "EPSG:{code} is geographic");
            assert_eq!(ifd.geokey(GEOG_CS), Some(code as u16));
        }

        // Projected codes INSIDE it — these were tagged geographic, so a
        // GIS read their metres as degrees.
        for code in [4026u32, 4037] {
            let ifd = write_and_read(&z, 2, 2, 0.0, 0.0, 1.0, Some(code), &format!("po{code}"));
            assert_eq!(ifd.geokey(MODEL_TYPE), Some(PROJECTED), "EPSG:{code} is projected");
            assert_eq!(ifd.geokey(PROJ_CS), Some(code as u16));
            assert_eq!(ifd.geokey(GEOG_CS), None);
        }

        // Ordinary projected codes, outside the band, always fine.
        for code in [32635u32, 3067, 25835] {
            let ifd = write_and_read(&z, 2, 2, 0.0, 0.0, 1.0, Some(code), &format!("p{code}"));
            assert_eq!(ifd.geokey(MODEL_TYPE), Some(PROJECTED), "EPSG:{code} is projected");
            assert_eq!(ifd.geokey(PROJ_CS), Some(code as u16));
        }
    }

    /// A code that does not fit in a SHORT must produce NO CRS key, not
    /// a truncated one. 1211 registry codes are above 65535, and
    /// `code.min(u16::MAX)` claimed EPSG 65535 for every one of them —
    /// a CRS the raster is not in. Without the key the raster is still
    /// placed correctly in its own coordinates and the GIS asks.
    #[test]
    fn omits_a_crs_it_cannot_express_rather_than_truncating_it() {
        let z = vec![0.0f32; 4];
        for code in [65536u32, 102001, 900913] {
            let ifd = write_and_read(&z, 2, 2, 10.0, 20.0, 1.0, Some(code), &format!("big{code}"));
            assert_eq!(ifd.geokey(2048), None, "EPSG:{code} must not claim a geographic CRS");
            assert_eq!(ifd.geokey(3072), None, "EPSG:{code} must not claim a projected CRS");
            // …and the placement survives, which is the reason for
            // omitting rather than refusing to write.
            assert_eq!(ifd.doubles(33922)[3], 10.0);
            assert_eq!(ifd.doubles(33550)[0], 1.0);
        }
    }

    /// No EPSG at all is a legitimate call — a raster in unknown
    /// coordinates is still worth writing, correctly placed.
    #[test]
    fn writes_a_placed_raster_with_no_crs_key() {
        let z = vec![0.0f32; 4];
        let ifd = write_and_read(&z, 2, 2, 5.0, 6.0, 2.0, None, "nocrs");
        assert_eq!(ifd.geokey(1024), Some(1), "defaults to projected");
        assert_eq!(ifd.geokey(2048), None);
        assert_eq!(ifd.geokey(3072), None);
        assert_eq!(ifd.doubles(33922)[3], 5.0);
        assert_eq!(ifd.doubles(33922)[4], 6.0 + 2.0 * 2.0);
    }

    /// Row 0 is the northernmost, matching the ESRI-ASCII writer, so the
    /// .tif and .asc PointCloudLabeler writes side by side agree pixel-for-pixel.
    /// Flip this and every raster is mirrored north-south while still
    /// opening without complaint.
    #[test]
    fn writes_the_north_row_first_like_the_ascii_grid() {
        let (cols, rows) = (2usize, 3usize);
        // z[cy*cols+cx], cy = 0 is SOUTH.
        let z: Vec<f32> = vec![
            10.0, 11.0,   // cy=0, south
            20.0, 21.0,   // cy=1
            30.0, 31.0,   // cy=2, north
        ];
        let ifd = write_and_read(&z, cols, rows, 0.0, 0.0, 1.0, None, "order");
        let (_, _, off) = ifd.find(273).unwrap();
        let read = |i: usize| f32::from_le_bytes(
            ifd.bytes[off as usize + i * 4..off as usize + i * 4 + 4].try_into().unwrap());
        assert_eq!(
            (0..6).map(read).collect::<Vec<_>>(),
            vec![30.0, 31.0, 20.0, 21.0, 10.0, 11.0],
            "north row must come first",
        );
    }

    /// A cell the analysis could not answer must read as NODATA, not as
    /// a plausible elevation. Both the pixel value and the GDAL_NODATA
    /// tag have to say so — the tag alone leaves NaN in the band, and
    /// the value alone leaves the reader treating -9999 as terrain.
    #[test]
    fn marks_unanswerable_cells_as_nodata_both_ways() {
        let z = vec![1.0f32, f32::NAN, f32::INFINITY, f32::NEG_INFINITY];
        let ifd = write_and_read(&z, 2, 2, 0.0, 0.0, 1.0, None, "nodata");
        let (typ, count, off) = ifd.find(42113).unwrap();
        assert_eq!(typ, 2, "GDAL_NODATA is ASCII");
        let text = String::from_utf8(
            ifd.bytes[off as usize..off as usize + count as usize - 1].to_vec()).unwrap();
        assert_eq!(text, "-9999");

        let (_, _, soff) = ifd.find(273).unwrap();
        let read = |i: usize| f32::from_le_bytes(
            ifd.bytes[soff as usize + i * 4..soff as usize + i * 4 + 4].try_into().unwrap());
        // North row first: cy=1 is [inf, -inf], then cy=0 is [1.0, NaN].
        assert_eq!((0..4).map(read).collect::<Vec<_>>(), vec![NODATA, NODATA, 1.0, NODATA]);
    }

    /// Every offset the IFD hands out must land inside the file and on
    /// an even boundary, and the blobs must not overlap. Offset
    /// arithmetic is where a hand-rolled TIFF goes wrong, and a reader
    /// that lands mid-blob reports garbage rather than an error.
    ///
    /// The even-boundary half of this pins a PROPERTY, not the `even()`
    /// helper that maintains it: with today's blob sizes every offset is
    /// already aligned, so removing `even()` changes no byte and the
    /// teeth check correctly reports as much. The assertion earns its
    /// place the moment a size changes — a NODATA string of odd length
    /// would misalign the image strip, and this is what would say so.
    #[test]
    fn every_external_offset_is_inside_the_file_and_does_not_overlap() {
        let (cols, rows) = (5usize, 4usize);
        let z = vec![1.0f32; cols * rows];
        for epsg in [None, Some(4326), Some(32635), Some(999999)] {
            let ifd = write_and_read(&z, cols, rows, 0.0, 0.0, 1.0, epsg, "off");
            let len = ifd.bytes.len();
            let mut spans: Vec<(usize, usize, u16)> = Vec::new();
            for &(tag, typ, count, val) in &ifd.entries {
                let width = match typ { 2 => 1, 3 => 2, 4 => 4, 12 => 8, _ => panic!("type {typ}") };
                let bytes = width * count as usize;
                if bytes <= 4 { continue; } // inline value, not an offset
                assert!(val as usize % 2 == 0, "tag {tag} offset {val} is odd");
                assert!(val as usize + bytes <= len,
                    "tag {tag} runs to {} past EOF {len}", val as usize + bytes);
                spans.push((val as usize, val as usize + bytes, tag));
            }
            spans.sort();
            for w in spans.windows(2) {
                assert!(w[0].1 <= w[1].0,
                    "tag {} [{}..{}) overlaps tag {} [{}..{})",
                    w[0].2, w[0].0, w[0].1, w[1].2, w[1].0, w[1].1);
            }
        }
    }

    /// The IFD's declared tag count must match what was actually
    /// written. They are two independent numbers — a hardcoded 15 and
    /// the sequence of push_entry calls — and if they drift the reader
    /// walks off the end of the entries into the padding, reading zeroed
    /// bytes as a tag.
    #[test]
    fn declares_as_many_tags_as_it_writes() {
        let z = vec![0.0f32; 4];
        let ifd = write_and_read(&z, 2, 2, 0.0, 0.0, 1.0, Some(32635), "count");
        assert_eq!(ifd.entries.len(), 15);
        assert!(ifd.entries.iter().all(|e| e.0 != 0), "a zero tag means the count over-declared");
        // Ascending tag order is required by the TIFF spec; readers that
        // binary-search the IFD miss tags that are out of order.
        let tags: Vec<u16> = ifd.entries.iter().map(|e| e.0).collect();
        let mut sorted = tags.clone();
        sorted.sort();
        assert_eq!(tags, sorted, "IFD tags must ascend");
    }

    /// A grid that cannot be written must produce an error AND no file.
    /// A half-written raster is worse than none: it opens, and every
    /// cell after the truncation is whatever the allocator left there.
    #[test]
    fn refuses_a_grid_it_cannot_write() {
        // Unique per run, and removed first: an earlier run that DID
        // write here would otherwise fail this test for the wrong
        // reason, which is how a test teaches the next reader to ignore
        // it. (It did, during the teeth check.)
        let path = std::env::temp_dir()
            .join(format!("pointcloudlabeler_gtiff_never_{}.tif", std::process::id()));
        let _ = std::fs::remove_file(&path);

        assert!(write_geotiff_f32(&path, &[], 0, 0, 0.0, 0.0, 1.0, None).is_err(), "empty grid");
        assert!(write_geotiff_f32(&path, &[1.0], 5, 5, 0.0, 0.0, 1.0, None).is_err(), "short grid");
        assert!(!path.exists(), "nothing should have been written");
        let _ = std::fs::remove_file(&path);
    }
}
