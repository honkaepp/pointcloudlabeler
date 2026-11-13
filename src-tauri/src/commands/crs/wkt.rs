//! OGC WKT (version 1, OGC 01-009) for an EPSG code, for the
//! coordinate-system record of a LAS 1.4 file. Point formats 6–10 must
//! state their coordinate system as WKT (LASF_Projection record 2112,
//! with bit 4 of the header's global encoding set); GeoTIFF keys are for
//! formats 0–5 only.
//!
//! The embedded registry holds proj4 definitions, not WKT, so the text is
//! built from the definition: ellipsoid, prime meridian, projection and
//! parameters, unit, and the code itself in AUTHORITY at the end. Readers
//! identify the system by that code; the parameters make the text usable
//! without a registry. No TOWGS84: with one, PROJ reads the system as a
//! bound CRS and no longer identifies the code (QGIS then shows an
//! unknown CRS), and the shift to WGS 84 is the registry's to give. A definition this does not
//! know how to write (an unusual projection, a non-default axis order)
//! gives `None`, and the caller keeps the GeoTIFF keys rather than
//! writing a guess.

use std::collections::HashMap;

/// proj4 `+key=value` pairs; a bare `+flag` maps to "".
fn params(proj: &str) -> HashMap<&str, &str> {
    proj.split_whitespace()
        .filter_map(|t| t.strip_prefix('+'))
        .map(|t| t.split_once('=').unwrap_or((t, "")))
        .collect()
}

/// A number as WKT writes it: the shortest form that reads back exact.
fn num(v: f64) -> String {
    format!("{v}")
}

/// A name inside WKT's double quotes (a quote is written twice).
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// The EPSG name of a code, from the registry rather than the picker's
/// shortlist: "ETRS89 / TM35FIN(E,N)", not "ETRS-TM35FIN (Finland)".
fn registry_name(code: u32) -> Option<String> {
    super::epsg_table().get(&code).map(|(n, _)| n.clone()).or_else(|| super::display_name_for_epsg(code))
}

enum Flat {
    Rf(f64),
    B(f64),
}

/// proj4's ellipsoid ids, with the values proj4rs uses for them, for
/// every id the registry's definitions name.
const ELLIPSOIDS: &[(&str, &str, f64, Flat)] = &[
    ("GRS80", "GRS 1980", 6_378_137.0, Flat::Rf(298.257222101)),
    ("WGS84", "WGS 84", 6_378_137.0, Flat::Rf(298.257223563)),
    ("WGS72", "WGS 72", 6_378_135.0, Flat::Rf(298.26)),
    ("intl", "International 1924", 6_378_388.0, Flat::Rf(297.0)),
    ("krass", "Krassowsky 1940", 6_378_245.0, Flat::Rf(298.3)),
    ("clrk66", "Clarke 1866", 6_378_206.4, Flat::B(6_356_583.8)),
    ("clrk80", "Clarke 1880 (RGS)", 6_378_249.145, Flat::Rf(293.4663)),
    ("clrk80ign", "Clarke 1880 (IGN)", 6_378_249.2, Flat::Rf(293.4660212936269)),
    ("bessel", "Bessel 1841", 6_377_397.155, Flat::Rf(299.1528128)),
    ("bess_nam", "Bessel Namibia", 6_377_483.865, Flat::Rf(299.1528128)),
    ("airy", "Airy 1830", 6_377_563.396, Flat::Rf(299.3249646)),
    ("mod_airy", "Airy Modified 1849", 6_377_340.189, Flat::B(6_356_034.446)),
    ("aust_SA", "GRS 1967 Modified", 6_378_160.0, Flat::Rf(298.25)),
    ("GRS67", "GRS 1967", 6_378_160.0, Flat::Rf(298.2471674270)),
    ("GSK2011", "GSK-2011", 6_378_136.5, Flat::Rf(298.2564151)),
    ("IAU76", "IAU 1976", 6_378_140.0, Flat::Rf(298.257)),
    ("NWL9D", "NWL 9D", 6_378_145.0, Flat::Rf(298.25)),
    ("evrst30", "Everest 1830", 6_377_276.345, Flat::Rf(300.8017)),
    ("evrst48", "Everest 1948", 6_377_304.063, Flat::Rf(300.8017)),
    ("evrst56", "Everest 1956", 6_377_301.243, Flat::Rf(300.8017)),
    ("evrst69", "Everest 1969", 6_377_295.664, Flat::Rf(300.8017)),
    ("evrstSS", "Everest (Sabah & Sarawak)", 6_377_298.556, Flat::Rf(300.8017)),
    ("helmert", "Helmert 1906", 6_378_200.0, Flat::Rf(298.3)),
    ("hough", "Hough 1960", 6_378_270.0, Flat::Rf(297.0)),
    ("fschr60", "Fischer 1960", 6_378_166.0, Flat::Rf(298.3)),
    ("fschr60m", "Fischer 1960 Modified", 6_378_155.0, Flat::Rf(298.3)),
    ("fschr68", "Fischer 1968", 6_378_150.0, Flat::Rf(298.3)),
    ("walbeck", "Walbeck", 6_376_896.0, Flat::B(6_355_834.846_7)),
    ("sphere", "Sphere", 6_370_997.0, Flat::B(6_370_997.0)),
];

/// proj4's named prime meridians, in degrees east of Greenwich.
const PRIME_MERIDIANS: &[(&str, &str, f64)] = &[
    ("lisbon", "Lisbon", -9.131906111111),
    ("paris", "Paris", 2.337229166667),
    ("bogota", "Bogota", -74.080916666667),
    ("madrid", "Madrid", -3.687938888889),
    ("rome", "Rome", 12.452333333333),
    ("bern", "Bern", 7.439583333333),
    ("jakarta", "Jakarta", 106.807719444444),
    ("ferro", "Ferro", -17.666666666667),
    ("brussels", "Brussels", 4.367975),
    ("stockholm", "Stockholm", 18.058277777778),
    ("athens", "Athens", 23.7163375),
    ("oslo", "Oslo", 10.722916666667),
    ("copenhagen", "Copenhagen", 12.57788),
];

/// `UNIT[...]` for a proj4 unit id, or for an explicit factor to metres,
/// and the factor.
fn unit_clause(id: Option<&str>, to_meter: Option<&str>) -> Option<(String, f64)> {
    if let Some(f) = to_meter {
        let f: f64 = f.parse().ok().filter(|f: &f64| *f > 0.0)?;
        return Some((format!("UNIT[\"unknown\",{}]", num(f)), f));
    }
    let (name, factor, code) = match id.unwrap_or("m") {
        "m" => ("metre", 1.0, 9001),
        "ft" => ("foot", 0.3048, 9002),
        "us-ft" => ("US survey foot", 1200.0 / 3937.0, 9003),
        "ch" => ("chain", 20.1168, 9097),
        "link" => ("link", 0.201168, 9098),
        "ind-yd" => ("Indian yard", 0.91439523, 9084),
        _ => return None,
    };
    Some((format!("UNIT[\"{name}\",{},AUTHORITY[\"EPSG\",\"{code}\"]]", num(factor)), factor))
}

/// `SPHEROID[...]` from `+ellps`, `+datum`, a sphere's `+R`, or `+a`
/// with `+rf`/`+b`/`+f`.
fn spheroid(p: &HashMap<&str, &str>) -> Option<String> {
    let f = |k: &str| p.get(k).and_then(|v| v.parse::<f64>().ok());
    let inv = |a: f64, flat: &Flat| match *flat {
        Flat::Rf(rf) => rf,
        Flat::B(b) if (a - b).abs() < 1e-9 => 0.0,
        Flat::B(b) => a / (a - b),
    };
    if let Some(r) = f("R") {
        return Some(format!("SPHEROID[\"Sphere\",{},0]", num(r)));
    }
    if let Some(a) = f("a") {
        let rf = if let Some(rf) = f("rf") {
            rf
        } else if let Some(b) = f("b") {
            inv(a, &Flat::B(b))
        } else if let Some(fl) = f("f") {
            if fl == 0.0 { 0.0 } else { 1.0 / fl }
        } else {
            0.0
        };
        return Some(format!("SPHEROID[\"unnamed\",{},{}]", num(a), num(rf)));
    }
    let id = match (p.get("ellps"), p.get("datum")) {
        (Some(e), _) => *e,
        (None, Some(&"WGS84")) => "WGS84",
        (None, Some(&"NAD83")) => "GRS80",
        (None, Some(&"NAD27")) => "clrk66",
        _ => return None,
    };
    let (_, name, a, flat) = ELLIPSOIDS.iter().find(|e| e.0 == id)?;
    Some(format!("SPHEROID[{},{},{}]", quoted(name), num(*a), num(inv(*a, flat))))
}

/// `GEOGCS[...]`: the datum on its ellipsoid, and the prime meridian.
fn geogcs(name: &str, p: &HashMap<&str, &str>) -> Option<String> {
    let datum_name = match p.get("datum") {
        Some(&"WGS84") => "WGS_1984".to_string(),
        Some(&"NAD83") => "North_American_Datum_1983".to_string(),
        Some(&"NAD27") => "North_American_Datum_1927".to_string(),
        _ => match name {
            "WGS 84" => "WGS_1984".to_string(),
            "ETRS89" => "European_Terrestrial_Reference_System_1989".to_string(),
            n => {
                let mut s: String = n.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
                while s.contains("__") { s = s.replace("__", "_"); }
                s.trim_matches('_').to_string()
            }
        },
    };
    let primem = match p.get("pm") {
        None => "PRIMEM[\"Greenwich\",0,AUTHORITY[\"EPSG\",\"8901\"]]".to_string(),
        Some(v) => match PRIME_MERIDIANS.iter().find(|m| m.0 == *v) {
            Some((_, n, deg)) => format!("PRIMEM[\"{n}\",{}]", num(*deg)),
            None => format!("PRIMEM[\"unnamed\",{}]", num(v.parse::<f64>().ok()?)),
        },
    };
    Some(format!(
        "GEOGCS[{},DATUM[{},{}],{primem},UNIT[\"degree\",0.0174532925199433,AUTHORITY[\"EPSG\",\"9122\"]]]",
        quoted(name),
        quoted(&datum_name),
        spheroid(p)?,
    ))
}

/// `PROJECTION[...]` and its `PARAMETER[...]`s, as GDAL names them.
/// `unit` is the CRS's linear unit in metres: proj4 gives the false
/// easting and northing in metres, WKT1 in the CRS's own unit.
fn projection(p: &HashMap<&str, &str>, unit: f64) -> Option<String> {
    let has = |k: &str| p.contains_key(k);
    let get = |k: &str, d: f64| -> Option<f64> {
        match p.get(k) { Some(v) => v.parse().ok(), None => Some(d) }
    };
    let lat0 = get("lat_0", 0.0)?;
    let lon0 = get("lon_0", 0.0)?;
    let k = match p.get("k").or(p.get("k_0")) { Some(v) => v.parse().ok()?, None => 1.0 };
    let (fe, fn_) = (get("x_0", 0.0)? / unit, get("y_0", 0.0)? / unit);
    let (name, params): (&str, Vec<(&str, f64)>) = match *p.get("proj")? {
        "tmerc" => ("Transverse_Mercator", vec![
            ("latitude_of_origin", lat0), ("central_meridian", lon0), ("scale_factor", k),
            ("false_easting", fe), ("false_northing", fn_)]),
        "utm" => {
            let zone: f64 = p.get("zone")?.parse::<u32>().ok().filter(|z| (1..=60).contains(z))? as f64;
            ("Transverse_Mercator", vec![
                ("latitude_of_origin", 0.0), ("central_meridian", 6.0 * zone - 183.0), ("scale_factor", 0.9996),
                ("false_easting", 500_000.0 / unit), ("false_northing", if has("south") { 10_000_000.0 / unit } else { 0.0 })])
        }
        // Michigan's 2SP variant scales the ellipsoid; WKT1 has no name for it.
        "lcc" if has("lat_2") && k != 1.0 => return None,
        "lcc" if has("lat_2") => ("Lambert_Conformal_Conic_2SP", vec![
            ("standard_parallel_1", get("lat_1", lat0)?), ("standard_parallel_2", get("lat_2", 0.0)?),
            ("latitude_of_origin", lat0), ("central_meridian", lon0),
            ("false_easting", fe), ("false_northing", fn_)]),
        "lcc" => ("Lambert_Conformal_Conic_1SP", vec![
            ("latitude_of_origin", get("lat_1", lat0)?), ("central_meridian", lon0), ("scale_factor", k),
            ("false_easting", fe), ("false_northing", fn_)]),
        "aea" => ("Albers_Conic_Equal_Area", vec![
            ("standard_parallel_1", get("lat_1", 0.0)?), ("standard_parallel_2", get("lat_2", 0.0)?),
            ("latitude_of_center", lat0), ("longitude_of_center", lon0),
            ("false_easting", fe), ("false_northing", fn_)]),
        "eqdc" => ("Equidistant_Conic", vec![
            ("standard_parallel_1", get("lat_1", 0.0)?), ("standard_parallel_2", get("lat_2", 0.0)?),
            ("latitude_of_center", lat0), ("longitude_of_center", lon0),
            ("false_easting", fe), ("false_northing", fn_)]),
        "cass" if !has("hyperbolic") => ("Cassini_Soldner", vec![
            ("latitude_of_origin", lat0), ("central_meridian", lon0),
            ("false_easting", fe), ("false_northing", fn_)]),
        "poly" => ("Polyconic", vec![
            ("latitude_of_origin", lat0), ("central_meridian", lon0),
            ("false_easting", fe), ("false_northing", fn_)]),
        "stere" if (lat0.abs() - 90.0).abs() < 1e-9 => match p.get("lat_ts") {
            // Variant B: the latitude of true scale stands in for the origin.
            Some(ts) => ("Polar_Stereographic", vec![
                ("latitude_of_origin", ts.parse().ok()?), ("central_meridian", lon0), ("scale_factor", 1.0),
                ("false_easting", fe), ("false_northing", fn_)]),
            None => ("Polar_Stereographic", vec![
                ("latitude_of_origin", lat0), ("central_meridian", lon0), ("scale_factor", k),
                ("false_easting", fe), ("false_northing", fn_)]),
        },
        "stere" => ("Stereographic", vec![
            ("latitude_of_origin", lat0), ("central_meridian", lon0), ("scale_factor", k),
            ("false_easting", fe), ("false_northing", fn_)]),
        "sterea" => ("Oblique_Stereographic", vec![
            ("latitude_of_origin", lat0), ("central_meridian", lon0), ("scale_factor", k),
            ("false_easting", fe), ("false_northing", fn_)]),
        "laea" => ("Lambert_Azimuthal_Equal_Area", vec![
            ("latitude_of_center", lat0), ("longitude_of_center", lon0),
            ("false_easting", fe), ("false_northing", fn_)]),
        "aeqd" => ("Azimuthal_Equidistant", vec![
            ("latitude_of_center", lat0), ("longitude_of_center", lon0),
            ("false_easting", fe), ("false_northing", fn_)]),
        "merc" => match p.get("lat_ts") {
            Some(ts) => ("Mercator_2SP", vec![
                ("standard_parallel_1", ts.parse().ok()?), ("central_meridian", lon0),
                ("false_easting", fe), ("false_northing", fn_)]),
            None => ("Mercator_1SP", vec![
                ("central_meridian", lon0), ("scale_factor", k),
                ("false_easting", fe), ("false_northing", fn_)]),
        },
        "eqc" => ("Equirectangular", vec![
            ("latitude_of_origin", lat0), ("central_meridian", lon0), ("standard_parallel_1", get("lat_ts", 0.0)?),
            ("false_easting", fe), ("false_northing", fn_)]),
        // Swiss oblique Mercator: the azimuth-centre Hotine form, at 90°.
        "somerc" => ("Hotine_Oblique_Mercator_Azimuth_Center", vec![
            ("latitude_of_center", lat0), ("longitude_of_center", lon0),
            ("azimuth", 90.0), ("rectified_grid_angle", 90.0), ("scale_factor", k),
            ("false_easting", fe), ("false_northing", fn_)]),
        // The azimuth form only; the two-point form has no WKT1 name.
        "omerc" if has("alpha") && !has("lat_1") && !has("lon_1") => {
            let alpha = get("alpha", 0.0)?;
            let name = if has("no_uoff") || has("no_off") {
                "Hotine_Oblique_Mercator"
            } else {
                "Hotine_Oblique_Mercator_Azimuth_Center"
            };
            (name, vec![
                ("latitude_of_center", lat0), ("longitude_of_center", get("lonc", lon0)?),
                ("azimuth", alpha), ("rectified_grid_angle", get("gamma", alpha)?), ("scale_factor", k),
                ("false_easting", fe), ("false_northing", fn_)])
        }
        _ => return None,
    };
    let mut out = format!("PROJECTION[\"{name}\"]");
    for (n, v) in params {
        out.push_str(&format!(",PARAMETER[\"{n}\",{}]", num(v)));
    }
    Some(out)
}

/// The horizontal CRS of `code` as WKT1, or `None` when its definition
/// is not one this can write.
fn horizontal(code: u32) -> Option<String> {
    let proj = super::proj_string_for_epsg(code)?;
    let p = params(&proj);
    // A south- or west-oriented grid changes the axes, which WKT1 says
    // with AXIS clauses this does not write.
    if p.get("axis").is_some_and(|a| *a != "enu") {
        return None;
    }
    let name = registry_name(code)?;
    let auth = format!("AUTHORITY[\"EPSG\",\"{code}\"]");
    match *p.get("proj")? {
        "longlat" | "latlong" | "lonlat" | "latlon" => {
            let g = geogcs(&name, &p)?;
            // GEOGCS[...] with the code added before its closing bracket.
            Some(format!("{},{auth}]", &g[..g.len() - 1]))
        }
        _ => {
            let base = name.split(" / ").next().unwrap_or(&name).trim();
            let (unit, factor) = unit_clause(p.get("units").copied(), p.get("to_meter").copied())?;
            Some(format!(
                "PROJCS[{},{},{},{unit},AXIS[\"Easting\",EAST],AXIS[\"Northing\",NORTH],{auth}]",
                quoted(&name),
                geogcs(base, &p)?,
                projection(&p, factor)?,
            ))
        }
    }
}

/// The vertical CRS of `code` as WKT1. Only one whose heights are in
/// metres: the exporter writes metres, and a feet-based code would
/// contradict the numbers beside it.
fn vertical(code: u32) -> Option<String> {
    let proj = super::proj_string_for_epsg(code)?;
    let p = params(&proj);
    if p.contains_key("proj") || p.get("vunits").copied() != Some("m") {
        return None;
    }
    let name = registry_name(code)?;
    let datum = name.strip_suffix(" height").or(name.strip_suffix(" depth")).unwrap_or(&name);
    Some(format!(
        "VERT_CS[{},VERT_DATUM[{},2005],UNIT[\"metre\",1,AUTHORITY[\"EPSG\",\"9001\"]],AXIS[\"Gravity-related height\",UP],AUTHORITY[\"EPSG\",\"{code}\"]]",
        quoted(&name),
        quoted(datum),
    ))
}

/// The coordinate system of a LAS 1.4 export as OGC WKT1: the horizontal
/// CRS, as a compound with the vertical one when that is given and in
/// metres. `None` when the horizontal CRS cannot be written; a vertical
/// one that cannot be is left out.
pub fn wkt_for_epsg(code: u32, vertical_code: Option<u32>) -> Option<String> {
    let h = horizontal(code)?;
    let Some(v) = vertical_code.and_then(|v| vertical(v).map(|w| (v, w))) else { return Some(h) };
    let name = format!(
        "{} + {}",
        registry_name(code).unwrap_or_default(),
        registry_name(v.0).unwrap_or_default(),
    );
    Some(format!("COMPD_CS[{},{h},{}]", quoted(&name), v.1))
}

/// The same text for a LAS 1.4 file the front end writes itself (the
/// branches' points, src/io/branchLas.ts). `None` when the code has no
/// WKT form here.
#[cfg_attr(feature = "gui", tauri::command)]
pub fn crs_wkt(epsg: u32, vertical: Option<u32>) -> Option<String> {
    wkt_for_epsg(epsg, vertical)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn balanced(w: &str) -> bool {
        let (mut depth, mut quoted) = (0i32, false);
        for c in w.chars() {
            match c {
                '"' => quoted = !quoted,
                '[' if !quoted => depth += 1,
                ']' if !quoted => {
                    depth -= 1;
                    if depth < 0 { return false; }
                }
                _ => {}
            }
        }
        depth == 0 && !quoted
    }

    #[test]
    fn tm35fin_is_transverse_mercator_on_grs80_at_27_east() {
        let w = wkt_for_epsg(3067, None).unwrap();
        assert!(w.starts_with("PROJCS[\"ETRS89 / TM35FIN(E,N)\",GEOGCS[\"ETRS89\""), "{w}");
        for part in [
            "DATUM[\"European_Terrestrial_Reference_System_1989\"",
            "SPHEROID[\"GRS 1980\",6378137,298.257222101]",
            "PROJECTION[\"Transverse_Mercator\"]",
            "PARAMETER[\"central_meridian\",27]",
            "PARAMETER[\"scale_factor\",0.9996]",
            "PARAMETER[\"false_easting\",500000]",
            "UNIT[\"metre\",1,AUTHORITY[\"EPSG\",\"9001\"]]",
        ] {
            assert!(w.contains(part), "missing {part} in {w}");
        }
        assert!(w.ends_with("AUTHORITY[\"EPSG\",\"3067\"]]"), "{w}");
        // A TOWGS84 would make PROJ read a bound CRS and lose the code.
        assert!(!w.contains("TOWGS84"), "{w}");
        assert!(balanced(&w));
        assert_eq!(super::super::epsg_from_wkt(&w), Some(3067));
    }

    /// proj4 gives the false easting in metres, WKT1 in the CRS's unit.
    #[test]
    fn a_foot_based_system_states_its_false_easting_in_feet() {
        // NAD83 / Florida East (ftUS): x_0 = 200000 m.
        let w = wkt_for_epsg(2236, None).unwrap();
        assert!(w.contains("UNIT[\"US survey foot\",0.3048006096012192"), "{w}");
        let fe: f64 = w.split("PARAMETER[\"false_easting\",").nth(1).unwrap().split(']').next().unwrap().parse().unwrap();
        assert!((fe - 656_166.667).abs() < 0.001, "{fe}");
    }

    #[test]
    fn a_vertical_crs_makes_a_compound_whose_parts_read_back_apart() {
        let w = wkt_for_epsg(3067, Some(3900)).unwrap();
        assert!(w.starts_with("COMPD_CS[\"ETRS89 / TM35FIN(E,N) + N2000 height\",PROJCS["), "{w}");
        assert!(w.contains("VERT_CS[\"N2000 height\",VERT_DATUM[\"N2000\",2005]"), "{w}");
        assert!(balanced(&w));
        assert_eq!(super::super::epsg_from_wkt(&w), Some(3067));
        assert_eq!(super::super::vertical_epsg_from_wkt(&w), Some(3900));
    }

    #[test]
    fn a_vertical_crs_not_in_metres_is_left_out() {
        // 6360: NAVD88 height in US survey feet.
        if super::super::proj_string_for_epsg(6360).is_some() {
            assert_eq!(wkt_for_epsg(3067, Some(6360)), wkt_for_epsg(3067, None));
        }
        // A horizontal code is not a vertical one.
        assert_eq!(wkt_for_epsg(3067, Some(4326)), wkt_for_epsg(3067, None));
    }

    #[test]
    fn geographic_and_conic_systems_are_written() {
        let w = wkt_for_epsg(4326, None).unwrap();
        assert!(w.starts_with("GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563]]"), "{w}");
        assert!(w.ends_with(",AUTHORITY[\"EPSG\",\"4326\"]]"), "{w}");
        assert_eq!(super::super::epsg_from_wkt(&w), Some(4326));

        let w = wkt_for_epsg(2154, None).unwrap();
        for part in [
            "PROJECTION[\"Lambert_Conformal_Conic_2SP\"]",
            "PARAMETER[\"standard_parallel_1\",49]",
            "PARAMETER[\"standard_parallel_2\",44]",
            "PARAMETER[\"latitude_of_origin\",46.5]",
            "PARAMETER[\"false_northing\",6600000]",
        ] {
            assert!(w.contains(part), "missing {part} in {w}");
        }
        assert!(balanced(&w));
    }

    #[test]
    fn what_has_no_wkt1_form_here_gives_nothing() {
        // Geocentric, and a vertical code asked for as a horizontal one.
        assert_eq!(wkt_for_epsg(4978, None), None);
        assert_eq!(wkt_for_epsg(3900, None), None);
        assert_eq!(wkt_for_epsg(70_000, None), None);
    }

    /// Nearly every horizontal system in the registry gets a WKT, and
    /// every one that does is well formed and names its own code.
    #[test]
    fn the_registry_is_covered() {
        let (mut horizontal_codes, mut written) = (0usize, 0usize);
        for (&code, (_, proj)) in super::super::epsg_table() {
            let p = params(proj);
            if !p.contains_key("proj") || p.get("proj") == Some(&"geocent") { continue; }
            horizontal_codes += 1;
            if let Some(w) = wkt_for_epsg(code, None) {
                written += 1;
                assert!(balanced(&w), "{code}: {w}");
                assert!(w.ends_with(&format!("AUTHORITY[\"EPSG\",\"{code}\"]]")), "{code}: {w}");
            }
        }
        // 7402 of 7566 when written; the rest are world maps, Colombia's
        // urban grids, south-oriented grids and Krovak.
        let share = written as f64 / horizontal_codes as f64;
        assert!(share > 0.975, "{written} of {horizontal_codes}");
    }
}
