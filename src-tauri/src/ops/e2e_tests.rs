//! The catalogue end to end on a synthetic plot: import, ground, terrain,
//! segmentation, metrics, QC, a review verdict, an export — the
//! manuscript's workflow with no window anywhere. Loose on the numbers
//! (the passes have their own tests); strict on the chain holding
//! together and on each step leaving the dataset the next one needs.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::{run, OpContext};

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pcl-ops-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A 30 × 30 m plot: a ground grid every 0.5 m at z ≈ 100 with a gentle
/// slope, and nine trees — a dense vertical stem (0.15 m radius) under a
/// crown (3 m radius) — on a 10 m lattice. Everything class 1, so the
/// ground filter has work to do. Roughly 20 k points.
fn synthetic_plot(path: &Path) -> (usize, usize) {
    use las::{Builder, Point as LasPoint, Transform, Vector, Writer};
    let mut b = Builder::from((1, 2));
    b.point_format = las::point::Format::new(0).unwrap();
    b.transforms = Vector {
        x: Transform { scale: 0.001, offset: 500_000.0 },
        y: Transform { scale: 0.001, offset: 6_800_000.0 },
        z: Transform { scale: 0.001, offset: 100.0 },
    };
    let mut w = Writer::from_path(path, b.into_header().unwrap()).unwrap();
    let mut n_ground = 0;
    let mut n_tree = 0;
    let mut put = |x: f64, y: f64, z: f64| {
        let p = LasPoint { x, y, z, intensity: 100, ..Default::default() };
        w.write_point(p).unwrap();
    };
    // ground
    let mut i = 0usize;
    for gx in 0..=60 {
        for gy in 0..=60 {
            let x = 500_000.0 + gx as f64 * 0.5;
            let y = 6_800_000.0 + gy as f64 * 0.5;
            let z = 100.0 + gx as f64 * 0.01 + ((i % 7) as f64) * 0.004;
            put(x, y, z);
            n_ground += 1;
            i += 1;
        }
    }
    // trees
    let mut k = 0usize;
    for tx in 0..3 {
        for ty in 0..3 {
            let cx = 500_005.0 + tx as f64 * 10.0;
            let cy = 6_800_005.0 + ty as f64 * 10.0;
            let ground_z = 100.0 + (cx - 500_000.0) / 0.5 * 0.01;
            let height = 14.0 + (tx * 3 + ty) as f64 * 0.7;
            let radius = 0.12 + (tx + ty) as f64 * 0.01;
            // stem: rings every 5 cm up to the crown base
            let mut hz = 0.05;
            while hz < height * 0.6 {
                for a in 0..16 {
                    let ang = a as f64 / 16.0 * std::f64::consts::TAU + k as f64 * 0.1;
                    put(cx + radius * ang.cos(), cy + radius * ang.sin(), ground_z + hz);
                    n_tree += 1;
                }
                hz += 0.05;
                k += 1;
            }
            // crown: a cone of points from 60 % of the height to the top
            let mut cz = height * 0.6;
            while cz <= height {
                let r_here = 3.0 * (1.0 - (cz - height * 0.6) / (height * 0.4));
                let rings = 2 + (r_here * 4.0) as usize;
                for ring in 0..rings {
                    let rr = r_here * (ring as f64 + 0.5) / rings as f64;
                    let n = 6 + ring * 6;
                    for a in 0..n {
                        let ang = a as f64 / n as f64 * std::f64::consts::TAU + cz;
                        put(cx + rr * ang.cos(), cy + rr * ang.sin(), ground_z + cz + (a % 3) as f64 * 0.05);
                        n_tree += 1;
                    }
                }
                cz += 0.4;
            }
        }
    }
    w.close().unwrap();
    (n_ground, n_tree)
}

#[test]
fn the_manuscript_workflow_runs_headless_from_import_to_export() {
    let dir = scratch("flow");
    let las = dir.join("plot.las");
    let (n_ground, n_tree) = synthetic_plot(&las);
    let ctx = OpContext::silent();
    let go = |name: &str, v: Value| -> Value {
        run(name, v, &ctx).unwrap_or_else(|e| panic!("{name}: {e}"))
    };

    // A project, and the import into it: <project>/octrees/<name>.
    let project = dir.join("proj");
    go("project.create", json!({ "folder": project.to_string_lossy(), "name": "Synthetic" }));
    let imported = go("dataset.import", json!({ "srcPath": las.to_string_lossy(), "scannerType": "tls" }));
    assert_eq!(imported["name"], "plot");
    assert_eq!(imported["pointCount"].as_u64().unwrap() as usize, n_ground + n_tree);
    let octree_dir = imported["outDir"].as_str().unwrap().to_string();
    assert!(octree_dir.ends_with("plot"), "{octree_dir}");
    assert!(Path::new(&octree_dir).starts_with(project.join("octrees")));
    let listed = go("project.datasets", Value::Null);
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["name"], "plot");

    // Ground: most of the ground grid, and not the stems.
    let ground = go("ground.classify", json!({ "octreeDir": octree_dir }));
    let classified = ground["points"].as_u64().unwrap() as usize;
    assert!(classified > n_ground * 8 / 10 && classified < n_ground + n_tree / 10,
        "ground classified {classified} of {n_ground} ground points ({n_tree} tree points)");

    // Terrain rasters land in terrain/.
    let terrain = go("ground.terrain", json!({ "octreeDir": octree_dir, "cellSize": 1.0 }));
    assert!(Path::new(terrain["dtmPath"].as_str().unwrap()).is_file());
    assert!(Path::new(&octree_dir).join("terrain").is_dir());

    // Segmentation finds the nine trees, give or take an edge case.
    let seg = go("segment.chm", json!({ "octreeDir": octree_dir, "cellSize": 1.0, "minHeight": 3.0 }));
    let trees = seg["treeCount"].as_u64().unwrap();
    assert!((7..=11).contains(&trees), "segmented {trees} trees out of 9");
    assert_eq!(seg["overridesCleared"], 0, "no overlay yet, nothing to clear");

    // Metrics for every tree: heights near the planted ones.
    let metrics = go("metrics.trees", json!({ "octreeDir": octree_dir }));
    let rows = metrics.as_array().unwrap();
    assert_eq!(rows.len() as u64, trees);
    for r in rows {
        let h = r["height"].as_f64().unwrap();
        assert!((10.0..=22.0).contains(&h), "tree {} height {h}", r["treeId"]);
        assert_eq!(r["dbhSource"], "metrics");
    }

    // Stems: a RANSAC fit per tree, then merged into the metrics.
    let stems = go("metrics.stems", json!({ "octreeDir": octree_dir }));
    assert!(!stems.as_array().unwrap().is_empty());
    assert!(Path::new(&octree_dir).join("stems.json").is_file());
    let merged = go("metrics.trees", json!({ "octreeDir": octree_dir }));
    assert!(merged.as_array().unwrap().iter().any(|r| r["dbhSource"] == "stemFit"), "no stem fit was merged");

    // Volumes without a QSM: every tree with a diameter and a height
    // gets the national function for the default species, pine.
    let volumes = go("metrics.volumes", json!({ "octreeDir": octree_dir }));
    assert_eq!(volumes["treeCount"].as_u64().unwrap(), trees);
    assert_eq!(volumes["tally"]["qsm"], 0);
    assert!(volumes["tally"]["laasasenaho"].as_u64().unwrap() > 0, "{}", volumes["sources"]);
    assert!(volumes["totalVolume"].as_f64().unwrap() > 0.0);
    for t in volumes["trees"].as_array().unwrap() {
        if t["source"] == "laasasenaho" {
            assert_eq!(t["species"], "pine");
            assert!(t["volume"].as_f64().unwrap() > 0.0);
        }
    }
    let spruce = go("metrics.volumes", json!({ "octreeDir": octree_dir, "defaultSpecies": "kuusi" }));
    assert!(spruce["trees"].as_array().unwrap().iter().filter(|t| t["source"] == "laasasenaho").all(|t| t["species"] == "spruce"));

    // Per-hectare figures need a boundary: none recorded yet, so the
    // operation says so, fits one on request, and uses the recorded one
    // once review.setPlot has written it.
    let err = run("metrics.plot", json!({ "octreeDir": octree_dir }), &ctx).unwrap_err();
    assert!(err.contains("no plot boundary"), "{err}");
    let fitted = go("metrics.plot", json!({ "octreeDir": octree_dir, "fit": "rectangular", "edge": "none" }));
    assert_eq!(fitted["boundarySource"], "fitted");
    assert_eq!(fitted["boundary"]["kind"], "rectangular");
    assert_eq!(fitted["nOut"], 0, "a bbox fitted to the stems leaves none outside");
    assert_eq!(fitted["treeStats"]["treeCount"].as_u64().unwrap(), trees);
    // The synthetic plot is 30 × 30 m from (500000, 6800000), its trees planted inside it.
    go("review.setPlot", json!({ "octreeDir": octree_dir, "boundary": { "kind": "rectangular", "min": [500_000.0, 6_800_000.0], "max": [500_030.0, 6_800_030.0] } }));
    let plot = go("metrics.plot", json!({ "octreeDir": octree_dir }));
    assert_eq!(plot["boundarySource"], "recorded");
    assert_eq!(plot["edge"], "crownArea");
    assert!((plot["areaHa"].as_f64().unwrap() - 0.09).abs() < 1e-9);
    let n_weighted = plot["nWeighted"].as_f64().unwrap();
    assert!(n_weighted > 0.0 && n_weighted <= trees as f64, "{n_weighted}");
    assert!((plot["stemsPerHa"].as_f64().unwrap() - n_weighted / 0.09).abs() < 1e-6);
    assert!(plot["basalAreaPerHa"].as_f64().unwrap() > 0.0);
    assert_eq!(plot["hasQsm"], false);
    let given = go("metrics.plot", json!({ "octreeDir": octree_dir, "boundary": { "kind": "circular", "center": [500_015.0, 6_800_015.0], "radius": 5.0 }, "edge": "halfcount" }));
    assert_eq!(given["boundarySource"], "given");
    assert!(given["nOut"].as_u64().unwrap() > 0, "a 5 m circle in a 30 m plot leaves trees outside");

    // Biomass needs the QSM; with it, every tree is pine by fallback,
    // and the totals carry the density error without averaging it away.
    let err = run("metrics.biomass", json!({ "octreeDir": octree_dir }), &ctx).unwrap_err();
    assert!(err.contains("metrics.qsm"), "{err}");
    let qsm = go("metrics.qsm", json!({ "octreeDir": octree_dir }));
    let qsm_trees = qsm["trees"].as_array().unwrap().len();
    assert!(qsm_trees > 0);
    let biomass = go("metrics.biomass", json!({ "octreeDir": octree_dir }));
    assert_eq!(biomass["totals"]["trees"].as_u64().unwrap() as usize, qsm_trees);
    assert_eq!(biomass["fallbackCount"].as_u64().unwrap() as usize, qsm_trees);
    assert_eq!(biomass["fallbackDensity"]["density"], 400.0);
    let b = biomass["totals"]["biomass"].as_f64().unwrap();
    let b_std = biomass["totals"]["biomassStd"].as_f64().unwrap();
    assert!(b > 0.0 && b_std / b >= 25.0 / 400.0 - 1e-9, "relative error {}", b_std / b);
    assert!((biomass["totals"]["co2e"].as_f64().unwrap() / biomass["totals"]["carbon"].as_f64().unwrap() - 44.0 / 12.0).abs() < 1e-9);
    // With species assigned, a birch weighs more than the same tree as pine.
    let first = biomass["trees"][0]["treeId"].as_i64().unwrap().to_string();
    go("review.setSpecies", json!({ "octreeDir": octree_dir, "species": { first.clone(): "birch" } }));
    let mixed = go("metrics.biomass", json!({ "octreeDir": octree_dir }));
    assert_eq!(mixed["fallbackCount"].as_u64().unwrap() as usize, qsm_trees - 1);
    assert!(mixed["trees"][0]["biomass"].as_f64().unwrap() > biomass["trees"][0]["biomass"].as_f64().unwrap());
    // And the measured volumes now take precedence in metrics.volumes
    // and reach the per-hectare figures.
    let measured = go("metrics.volumes", json!({ "octreeDir": octree_dir }));
    assert_eq!(measured["tally"]["qsm"].as_u64().unwrap() as usize, qsm_trees);
    let plot_qsm = go("metrics.plot", json!({ "octreeDir": octree_dir }));
    assert_eq!(plot_qsm["hasQsm"], true);
    assert!(plot_qsm["stemVolumePerHa"].as_f64().unwrap() > 0.0);

    // A thinning plan over the recorded boundary: every tree classed,
    // the removed list written as the panel's CSV.
    let csv = dir.join("thinning-removed.csv");
    let thin = go("metrics.thinning", json!({ "octreeDir": octree_dir, "targetBaPerHa": 5.0, "roadSpacing": 10.0, "outCsv": csv.to_string_lossy() }));
    assert_eq!(thin["areaBasis"], "boundary");
    assert!((thin["plotAreaHa"].as_f64().unwrap() - 0.09).abs() < 1e-9);
    let n_total = thin["nTotal"].as_u64().unwrap();
    assert!(n_total > 0 && n_total <= trees);
    assert_eq!(thin["nForced"].as_u64().unwrap() + thin["nSelected"].as_u64().unwrap() + thin["nKept"].as_u64().unwrap() + thin["nUnreachable"].as_u64().unwrap(), n_total);
    assert_eq!(thin["removed"].as_array().unwrap().len() as u64, thin["nForced"].as_u64().unwrap() + thin["nSelected"].as_u64().unwrap());
    assert_eq!(thin["qualityAvailable"], true, "the QSM gives every tree a confidence");
    assert_eq!(thin["volumeSources"]["qsm"].as_u64().unwrap() as usize, qsm_trees);
    assert_eq!(thin["currency"], "€");
    assert!(thin["baAfter"].as_f64().unwrap() <= thin["baBefore"].as_f64().unwrap());
    let csv_text = std::fs::read_to_string(&csv).unwrap();
    assert!(csv_text.starts_with("tree_id,reason,x,y,dbh_cm,height_m,ba_m2,volume_m3,volume_source,confidence\n"));
    assert_eq!(csv_text.lines().count() - 1, thin["removed"].as_array().unwrap().len());

    // The HTML report, with the biomass block from the QSM and the
    // species assigned above, and no NaN anywhere in it.
    let report_path = dir.join("report.html");
    let report = go("export.report", json!({ "octreeDir": octree_dir, "outPath": report_path.to_string_lossy(), "projectName": "Synthetic plot", "date": "2026-10-08" }));
    assert_eq!(report["hasQsm"], true);
    assert_eq!(report["hasBiomass"], true);
    assert_eq!(report["hasDensity"], false);
    assert_eq!(report["plotAreaBasis"], "boundary");
    assert_eq!(report["fallbackCount"].as_u64().unwrap() as usize, qsm_trees - 1);
    assert_eq!(report["summary"]["treeCount"].as_u64().unwrap(), trees);
    let html = std::fs::read_to_string(&report_path).unwrap();
    assert_eq!(html.len(), report["bytes"].as_u64().unwrap() as usize);
    assert!(html.starts_with("<!doctype html>"));
    assert!(html.contains("<h1>Synthetic plot</h1>") && html.contains("2026-10-08") && html.contains("· tls"));
    assert!(html.contains("Volume · biomass · carbon") && html.contains("Birch (Betula spp.) (1)") && html.contains("Revenue estimate"));
    assert!(html.contains("0.090 ha (900 m²) — defined plot boundary"));
    assert!(!html.contains("NaN"));

    // Bucking every QSM stem: the volumes add up to the QSM's, and the
    // CSV is named for the currency.
    let bucking_csv = dir.join("bucking.csv");
    let bucking = go("metrics.bucking", json!({ "octreeDir": octree_dir, "currency": "EUR", "outCsv": bucking_csv.to_string_lossy() }));
    assert_eq!(bucking["trees"].as_array().unwrap().len(), qsm_trees);
    let total_vol = bucking["totals"]["totalVol"].as_f64().unwrap();
    let qsm_total: f64 = qsm["trees"].as_array().unwrap().iter().map(|t| t["stemVolume"].as_f64().unwrap()).sum();
    assert!((total_vol - qsm_total).abs() < 1e-9, "{total_vol} vs {qsm_total}");
    let bucking_text = std::fs::read_to_string(&bucking_csv).unwrap();
    assert!(bucking_text.starts_with("tree_id,height_m,measured_top_m,stem_volume_m3,saw_m3,saw_revenue_eur,"));

    // Field validation against a CSV written from the measured trees
    // themselves, every caliper reading 1 cm over: bias +1 cm, RMSE 1 cm.
    let field_csv = dir.join("field.csv");
    let mut field = String::from("puunumero;x;y;lapimitta;pituus\n");
    for (i, r) in measured["trees"].as_array().unwrap().iter().enumerate() {
        let (dbh, h) = (r["dbh"].as_f64().unwrap(), r["height"].as_f64().unwrap());
        if dbh.is_nan() || dbh <= 0.0 { continue; }
        let m = merged.as_array().unwrap().iter().find(|m| m["treeId"] == r["treeId"]).unwrap();
        field.push_str(&format!("{};{};{};{};{}\n", i + 1, m["x"].as_f64().unwrap() + 0.2, m["y"].as_f64().unwrap(), format!("{:.2}", dbh * 100.0 - 1.0).replace('.', ","), format!("{h:.1}").replace('.', ",")));
    }
    std::fs::write(&field_csv, &field).unwrap();
    let validation_csv = dir.join("validation.csv");
    let validation = go("qc.validate", json!({ "octreeDir": octree_dir, "fieldCsv": field_csv.to_string_lossy(), "outCsv": validation_csv.to_string_lossy() }));
    assert_eq!(validation["decimalComma"], true);
    assert_eq!(validation["delimiter"], ";");
    assert_eq!(validation["mapping"]["dbhCol"], 3);
    let n_field = validation["fieldTrees"].as_u64().unwrap();
    assert_eq!(validation["nMatched"].as_u64().unwrap(), n_field);
    assert_eq!(validation["unmatchedField"], 0);
    let bias = validation["summary"]["biasCm"].as_f64().unwrap();
    assert!((bias - 1.0).abs() < 0.02, "bias {bias}");
    assert!((validation["summary"]["rmseCm"].as_f64().unwrap() - 1.0).abs() < 0.02);
    assert!(std::fs::read_to_string(&validation_csv).unwrap().lines().count() as u64 == n_field + 1);

    // Growth against the same epoch: every stem pairs with itself and
    // nothing grew.
    let growth_csv = dir.join("growth.csv");
    let growth = go("change.growth", json!({ "octreeDir": octree_dir, "referenceDir": octree_dir, "years": 2.5, "outCsv": growth_csv.to_string_lossy() }));
    assert_eq!(growth["n"].as_u64().unwrap(), trees);
    assert_eq!((growth["harvestedCount"].as_u64().unwrap(), growth["ingrowthCount"].as_u64().unwrap()), (0, 0));
    assert_eq!(growth["meanDdbh"].as_f64().unwrap(), 0.0);
    assert_eq!(growth["volumeChangeM3"].as_f64().unwrap(), 0.0);
    assert!(growth["matches"].as_array().unwrap().iter().all(|m| m["refId"] == m["nowId"] && m["distance"] == 0.0));
    assert!(std::fs::read_to_string(&growth_csv).unwrap().starts_with("status,ref_id,now_id,"));

    // And the report carries both blocks when given their inputs.
    let full = go("export.report", json!({ "octreeDir": octree_dir, "outPath": report_path.to_string_lossy(), "fieldCsv": field_csv.to_string_lossy(), "referenceDir": octree_dir, "years": 2.5, "date": "2026-10-08" }));
    assert_eq!(full["hasValidation"], true);
    assert_eq!(full["hasGrowth"], true);
    assert_eq!(full["hasM3c2"], false);
    let html = std::fs::read_to_string(&report_path).unwrap();
    assert!(html.contains("<h2>Field-data validation</h2>") && html.contains("Tree growth — 2.5-year interval"));
    assert!(!html.contains("NaN"));

    // The per-tree CSV with the QSM and biomass columns.
    let metrics_csv = dir.join("metrics.csv");
    let table = go("export.csv", json!({ "octreeDir": octree_dir, "outPath": metrics_csv.to_string_lossy() }));
    assert_eq!(table["rows"].as_u64().unwrap(), trees);
    assert_eq!(table["hasQsm"], true);
    assert_eq!(table["fallbackCount"].as_u64().unwrap() as usize, qsm_trees - 1);
    let text = std::fs::read_to_string(&metrics_csv).unwrap();
    let lines: Vec<&str> = text.trim_start_matches('\u{feff}').lines().collect();
    assert_eq!(lines.len() as u64, trees + 1);
    assert!(lines[0].starts_with("tree_id,points,height_m,dbh_m,dbh_method,"));
    assert!(lines[0].contains(",biomass_kg,biomass_ci95_kg,"));
    assert_eq!(lines[0].split(',').count(), table["columns"].as_array().unwrap().len());
    assert!(lines[1].contains(",ransac,") || lines.iter().any(|l| l.contains(",ransac,")), "the stem fits were merged");
    assert!(!text.contains("NaN"));

    // The cross-sensor comparison of the plot against itself: every
    // tree matches, recall and precision are 1, and the joined table
    // carries the TLS volume on every row.
    let joined_csv = dir.join("joined.csv");
    let cross = go("change.crossSensor", json!({ "alsDir": octree_dir, "tlsDir": octree_dir, "outCsv": joined_csv.to_string_lossy() }));
    assert_eq!(cross["nMatched"].as_u64().unwrap(), trees);
    assert_eq!((cross["nAlsOnly"].as_u64().unwrap(), cross["nTlsOnly"].as_u64().unwrap()), (0, 0));
    assert_eq!(cross["overall"]["recall"], 1.0);
    assert_eq!(cross["overall"]["f1"], 1.0);
    assert_eq!(cross["nWithVolume"].as_u64().unwrap() as usize, qsm_trees);
    assert!(cross["model"].is_null(), "nine trees are too few for a two-predictor model");
    assert!(cross["modelDescription"].as_str().unwrap().contains("not enough"));
    let joined = std::fs::read_to_string(&joined_csv).unwrap();
    assert!(joined.trim_start_matches('\u{feff}').starts_with("detection,separation_m,tls_tree_id"));
    assert_eq!(joined.lines().count() as u64, trees + 1);
    assert!(joined.lines().skip(1).all(|l| l.starts_with("matched,")));

    // QC: a report over the same rows, ranked.
    let qc = go("qc.flags", json!({ "octreeDir": octree_dir, "withMetrics": true }));
    assert_eq!(qc["treeCount"].as_u64().unwrap(), trees);
    assert_eq!(qc["qsmChecked"], true, "qsm.json was written above, so the three QSM checks ran");
    assert_eq!(qc["metrics"].as_array().unwrap().len() as u64, trees);
    let flags = qc["flags"].as_array().unwrap();
    for pair in flags.windows(2) {
        let rank = |s: &Value| match s.as_str().unwrap() { "critical" => 3, "warning" => 2, _ => 1 };
        assert!(rank(&pair[0]["severity"]) >= rank(&pair[1]["severity"]), "flags are not ranked");
    }

    // A review verdict, as Tree Review would write it.
    let first_id = rows[0]["treeId"].as_i64().unwrap().to_string();
    let review = go("review.set", json!({ "octreeDir": octree_dir, "verdicts": { first_id.clone(): "ok" } }));
    assert_eq!(review["ok"], 1);
    let info = go("dataset.info", json!({ "octreeDir": octree_dir }));
    assert_eq!(info["reviewedTrees"], 1);
    assert!(info["sidecars"]["stems.json"].as_u64().unwrap() > 0);
    assert!(info["sidecars"].get("terrain/").is_some());

    // Export, edits applied, and the file is a LAS with every point.
    let out = dir.join("export.las");
    let report = go("export.las", json!({ "octreeDir": octree_dir, "outPath": out.to_string_lossy(), "includeTreeId": true }));
    assert_eq!(report["written"].as_u64().unwrap() as usize, n_ground + n_tree);
    let reader = las::Reader::from_path(&out).unwrap();
    assert_eq!(reader.header().number_of_points() as usize, n_ground + n_tree);

    // The same export as text, PLY and E57 — transcoded from the LAS
    // the exporter writes — and the text and the E57 back in as
    // datasets of their own, every point and the tree ids along.
    let txt = dir.join("export.txt");
    let r = go("export.las", json!({ "octreeDir": octree_dir, "outPath": txt.to_string_lossy(), "delimiter": "comma" }));
    assert_eq!(r["written"].as_u64().unwrap() as usize, n_ground + n_tree);
    let first_line = std::fs::read_to_string(&txt).unwrap().lines().next().unwrap().to_string();
    assert!(first_line.starts_with("x,y,z,intensity,return_number,number_of_returns,classification"), "{first_line}");
    assert!(first_line.contains(",tree_id"), "{first_line}");
    let ply = dir.join("export.ply");
    let r = go("export.las", json!({ "octreeDir": octree_dir, "outPath": ply.to_string_lossy() }));
    assert_eq!(r["written"].as_u64().unwrap() as usize, n_ground + n_tree);
    let e57 = dir.join("export.e57");
    let r = go("export.las", json!({ "octreeDir": octree_dir, "outPath": e57.to_string_lossy() }));
    assert_eq!(r["written"].as_u64().unwrap() as usize, n_ground + n_tree);
    assert!(!dir.join(".export.e57.las.tmp").exists(), "the staging LAS is removed");

    let probed = go("dataset.probe", json!({ "path": txt.to_string_lossy() }));
    assert_eq!(probed["kind"], "text");
    assert_eq!(probed["delimiter"], "comma");
    assert_eq!(probed["suggested"]["x"], "x");
    assert_eq!(probed["suggested"]["treeId"], "tree_id");
    assert_eq!(probed["suggested"]["classification"], "classification");
    let back = go("dataset.import", json!({ "srcPath": txt.to_string_lossy(), "name": "from text", "scannerType": "tls", "mapping": probed["suggested"] }));
    assert_eq!(back["pointCount"].as_u64().unwrap() as usize, n_ground + n_tree);
    let back_dir = back["outDir"].as_str().unwrap().to_string();
    assert!(!Path::new(&back_dir).join(".import_stage.las").exists(), "the staging LAS is removed");
    let info = go("dataset.info", json!({ "octreeDir": back_dir }));
    let back_trees = go("metrics.trees", json!({ "octreeDir": back_dir }));
    assert_eq!(back_trees.as_array().map(|a| a.len()).unwrap_or(0) as u64, trees, "the tree ids came back through the text file; {info}");
    let probed = go("dataset.probe", json!({ "path": e57.to_string_lossy() }));
    assert_eq!(probed["kind"], "e57");
    assert_eq!(probed["approxPointCount"].as_u64().unwrap() as usize, n_ground + n_tree);
    let back = go("dataset.import", json!({ "srcPath": e57.to_string_lossy(), "name": "from e57", "scannerType": "tls" }));
    assert_eq!(back["pointCount"].as_u64().unwrap() as usize, n_ground + n_tree);
    for d in [back_dir, back["outDir"].as_str().unwrap().to_string()] {
        go("dataset.remove", json!({ "octreeDir": d }));
    }
    assert_eq!(go("project.datasets", Value::Null).as_array().unwrap().len(), 1);

    // A subset by tree id range into a new dataset beside the first.
    let subset = go("export.subset", json!({ "srcDir": octree_dir, "name": "trees only", "filter": { "treeIdRange": [1, 1000000] } }));
    let sub_count = subset["pointCount"].as_u64().unwrap() as usize;
    assert!(sub_count > 0 && sub_count < n_ground + n_tree, "subset kept {sub_count}");
    assert!(Path::new(subset["outDir"].as_str().unwrap()).ends_with("trees_only"));
    assert_eq!(go("project.datasets", Value::Null).as_array().unwrap().len(), 2);

    // M3C2 in the report, against the subset as the other epoch: the
    // block is there, named after the reference dataset.
    let with_m3c2 = go("export.report", json!({ "octreeDir": octree_dir, "outPath": report_path.to_string_lossy(), "m3c2ReferenceDir": subset["outDir"], "m3c2CoreSpacing": 2.0, "date": "2026-10-08" }));
    assert_eq!(with_m3c2["hasM3c2"], true);
    let html = std::fs::read_to_string(&report_path).unwrap();
    assert!(html.contains("<h2>M3C2 surface change — vs. trees only</h2>"), "the reference is named after its dataset");
    assert!(html.contains("Lague, D., Brodu, N.") && !html.contains("NaN"));

    // Fine registration: the plot moved by a known rigid transform —
    // 1.5° of yaw about its middle and most of a metre — and registered
    // back onto the original. The transform found must be the inverse
    // of the move, to the millimetre at the plot's corners.
    use crate::commands::register::{exp_so3, Rigid};
    let moved_by = Rigid::about(exp_so3([0.0, 0.0, 1.5f64.to_radians()]), [0.6, -0.4, 0.1], [500_015.0, 6_800_015.0, 100.0]);
    let moved = go("dataset.transform", json!({ "octreeDir": octree_dir, "name": "plot moved", "matrix": moved_by.to_mat4() }));
    let moved_dir = moved["outDir"].as_str().unwrap().to_string();
    assert!(moved_dir.ends_with("plot_moved"));
    assert!(moved["pointCount"].as_u64().unwrap() > 0 && moved["pointCount"].as_u64().unwrap() <= imported["pointCount"].as_u64().unwrap());
    let moved_meta: Value = serde_json::from_slice(&std::fs::read(Path::new(&moved_dir).join("metadata.json")).unwrap()).unwrap();
    assert_eq!(moved_meta["registration"]["matrix"].as_array().unwrap().len(), 16, "the move is recorded in the copy");
    assert_eq!(moved_meta["registration"]["sourceName"], "plot");
    assert!(moved_meta["boundingBox"]["min"][0].as_f64().unwrap() > 500_000.0 - 2.0, "the copy's box moved with it");
    let reg_json = dir.join("registration.json");
    let reg = go("change.register", json!({
        "referenceDir": octree_dir, "movingDir": moved_dir, "maxCorrDist": 2.0, "outJson": reg_json.to_string_lossy(),
    }));
    let want = moved_by.inverse();
    let corners_agree = |matrix: &Value, tol: f64| {
        let m: Vec<f64> = matrix.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let found = Rigid::from_mat4(&m).unwrap();
        for c in [[500_000.0, 6_800_000.0, 100.0], [500_030.0, 6_800_030.0, 100.0], [500_030.0, 6_800_000.0, 120.0], [500_000.0, 6_800_030.0, 110.0]] {
            let a = found.apply(c);
            let b = want.apply(c);
            let d = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
            assert!(d < tol, "corner {c:?} is {d} m off (tolerance {tol})");
        }
    };
    corners_agree(&reg["matrix"], 0.005);
    assert_eq!(reg["report"]["converged"], true);
    assert_eq!(reg["report"]["wellConstrained"], true, "condition {} ({})", reg["report"]["condition"], reg["report"]["weakest"]);
    assert_eq!(reg["initMode"], "current");
    assert!(reg["report"]["translationStdErr"][0].as_f64().unwrap() > 0.0);
    assert_eq!(reg["report"]["levels"].as_array().unwrap().len(), 4);
    assert!(reg_json.exists());
    // From nowhere near: the automatic search by stems and crowns finds
    // the offset first, and the moved copy is written in the same run.
    let auto = go("change.register", json!({
        "referenceDir": octree_dir, "movingDir": moved_dir, "init": "auto", "searchRadius": 6.0, "yawRangeDeg": 3.0,
        "apply": true, "name": "plot registered",
    }));
    corners_agree(&auto["matrix"], 0.005);
    assert_eq!(auto["initMode"], "auto");
    assert!(auto["coarse"]["matchedTrees"].as_u64().unwrap() >= 3, "{}", auto["coarse"]);
    assert!(auto["coarse"]["confidence"].as_f64().unwrap() > 1.0);
    let registered_dir = auto["dataset"]["outDir"].as_str().unwrap().to_string();
    assert!(registered_dir.ends_with("plot_registered"));
    let reg_meta: Value = serde_json::from_slice(&std::fs::read(Path::new(&registered_dir).join("metadata.json")).unwrap()).unwrap();
    assert_eq!(reg_meta["registration"]["referenceName"], "plot");
    assert_eq!(reg_meta["registration"]["wellConstrained"], true);
    // The registered copy against the original: no change left to see,
    // with the registration's own error as M3C2's.
    let m3 = go("change.m3c2", json!({ "octreeDir": registered_dir, "referenceDir": octree_dir, "coreSpacing": 2.0, "registrationJson": reg_json.to_string_lossy() }));
    assert!(m3["meanDistance"].as_f64().unwrap().abs() < 0.01, "{}", m3["meanDistance"]);
    // The error read back from the JSON file is the report's — to the
    // precision a JSON parser gives a double, which is not always the
    // last bit.
    let (got, want) = (m3["regError"].as_f64().unwrap(), reg["report"]["positionStdErr"].as_f64().unwrap());
    assert!((got - want).abs() <= 1e-12 * want.abs().max(1e-300), "{got} vs {want}");
    assert!(m3["regError"].as_f64().unwrap() > 0.0 && m3["regError"].as_f64().unwrap() < 0.02, "{}", m3["regError"]);
    // The jackknife ran: blocks, and a standard error from them.
    assert!(reg["report"]["jackknifeBlocks"].as_u64().unwrap() >= 8);
    assert!(reg["report"]["translationStdErrBlocks"][0].as_f64().unwrap() > 0.0);
    // From a quarter turn away, nothing known: the feature search finds
    // it, and plane-to-plane finishes it.
    let turned_by = Rigid::about(exp_so3([0.0, 0.0, 90f64.to_radians()]), [9.0, -4.0, 0.3], [500_015.0, 6_800_015.0, 100.0]);
    let turned = go("dataset.transform", json!({ "octreeDir": octree_dir, "name": "plot turned", "matrix": turned_by.to_mat4() }));
    let turned_dir = turned["outDir"].as_str().unwrap().to_string();
    let feat = go("change.register", json!({ "referenceDir": octree_dir, "movingDir": turned_dir, "init": "features", "featureVoxel": 0.15, "method": "gicp", "maxCorrDist": 1.5 }));
    {
        let m: Vec<f64> = feat["matrix"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        let found = Rigid::from_mat4(&m).unwrap();
        let want = turned_by.inverse();
        for c in [[500_000.0, 6_800_000.0, 100.0], [500_030.0, 6_800_030.0, 100.0], [500_030.0, 6_800_000.0, 120.0]] {
            let a = found.apply(c);
            let b = want.apply(c);
            let d = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
            assert!(d < 0.01, "corner {c:?} is {d} m off after the feature start ({})", feat["global"]);
        }
    }
    assert_eq!(feat["initMode"], "features");
    assert!(feat["global"]["inliers"].as_u64().unwrap() >= 6, "{}", feat["global"]);
    go("dataset.remove", json!({ "octreeDir": turned_dir }));
    // A moved copy from the registration's JSON, as a recipe would do it.
    let back = go("dataset.transform", json!({ "octreeDir": moved_dir, "name": "plot back", "registrationJson": reg_json.to_string_lossy() }));
    let back_meta: Value = serde_json::from_slice(&std::fs::read(Path::new(back["outDir"].as_str().unwrap()).join("metadata.json")).unwrap()).unwrap();
    assert_eq!(back_meta["registration"]["referenceName"], "plot");
    assert!(run("dataset.transform", json!({ "octreeDir": moved_dir, "name": "plot back", "registrationJson": reg_json.to_string_lossy() }), &ctx).unwrap_err().contains("already exists"));
    for d in [&moved_dir, &registered_dir, &back["outDir"].as_str().unwrap().to_string()] {
        go("dataset.remove", json!({ "octreeDir": d }));
    }
    assert_eq!(go("project.datasets", Value::Null).as_array().unwrap().len(), 2);

    // Clearing a column clears the overlay too; removing the dataset removes it.
    let reset = go("segment.reset", json!({ "octreeDir": octree_dir, "attr": "tree_id" }));
    assert!(reset["assignedPoints"].as_u64().unwrap() > 0);
    assert_eq!(go("metrics.trees", json!({ "octreeDir": octree_dir })).as_array().unwrap().len(), 0);
    go("dataset.remove", json!({ "octreeDir": subset["outDir"] }));
    assert_eq!(go("project.datasets", Value::Null).as_array().unwrap().len(), 1);

    // Close before removing: the open project holds its database file,
    // and Windows will not delete an open file, so the scratch
    // directory stayed behind there.
    go("project.close", Value::Null);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_operation_refuses_a_directory_that_is_not_a_dataset() {
    let dir = scratch("nodataset");
    let ctx = OpContext::silent();
    let d = dir.to_string_lossy().to_string();
    let err = run("dataset.info", json!({ "octreeDir": d }), &ctx).unwrap_err();
    assert!(err.contains("is not a dataset"), "{err}");
    let err = run("dataset.import", json!({ "srcPath": dir.join("missing.las").to_string_lossy() }), &ctx).unwrap_err();
    assert!(err.contains("is not a file"), "{err}");
    let err = run("dataset.import", json!({ "srcPath": dir.to_string_lossy() }), &ctx).unwrap_err();
    assert!(err.contains("is not a file"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A PTX file of two scans of one synthetic scene: a 20 × 20 m ground
/// plane and twelve vertical stems. Scan A sits at the origin with the
/// identity pose; scan B saw the same scene from `offset` away, and its
/// pose is written as the identity — misregistered by exactly `offset`,
/// which is what the registration below has to find.
fn synthetic_ptx(path: &Path, offset: [f64; 3]) -> usize {
    let mut pts: Vec<[f64; 3]> = Vec::new();
    let mut i = 0usize;
    // Dense enough that a 0.5 m voxel holds the 16 points the plane
    // extractor wants, gently undulating so ICP has a surface to hold.
    // Jittered off the grid: a regular lattice aligns with itself at
    // every multiple of its spacing, and ICP would settle on one.
    let mut seed: u32 = 20261008;
    let mut rnd = move || {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        seed as f64 / 4_294_967_296.0 - 0.5
    };
    for gx in 0..=200 {
        for gy in 0..=200 {
            let x = gx as f64 * 0.1 + rnd() * 0.08;
            let y = gy as f64 * 0.1 + rnd() * 0.08;
            let z = ((x * 0.9).sin() + (y * 0.7).cos()) * 0.3 + ((i % 11) as f64) * 0.002;
            pts.push([x, y, z]);
            i += 1;
        }
    }
    for s in 0..16 {
        let cx = 2.5 + (s % 4) as f64 * 5.0;
        let cy = 2.5 + (s / 4) as f64 * 5.0;
        let r = 0.12 + s as f64 * 0.01;
        for ring in 0..60 {
            let z = ring as f64 * 0.25;
            for k in 0..36 {
                let a = k as f64 * std::f64::consts::TAU / 36.0 + ring as f64 * 0.05;
                pts.push([cx + r * a.cos(), cy + r * a.sin(), z]);
            }
        }
    }
    let n = pts.len();
    let mut text = String::new();
    let section = |shift: [f64; 3], text: &mut String| {
        text.push_str(&format!("{n}\n1\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n"));
        for p in &pts {
            text.push_str(&format!("{:.4} {:.4} {:.4}\n", p[0] - shift[0], p[1] - shift[1], p[2] - shift[2]));
        }
    };
    section([0.0, 0.0, 0.0], &mut text);
    section(offset, &mut text);
    std::fs::write(path, text).unwrap();
    n
}

#[test]
fn scanner_projects_are_imported_registered_and_exported_headless() {
    let dir = scratch("pre");
    let project = dir.join("proj");
    let ptx = dir.join("scene.ptx");
    let offset = [0.3, -0.2, 0.0];
    let n = synthetic_ptx(&ptx, offset);
    let ctx = OpContext::silent();
    let go = |name: &str, v: Value| -> Value {
        run(name, v, &ctx).unwrap_or_else(|e| panic!("{name}: {e}"))
    };
    let folder = project.to_string_lossy().to_string();
    go("project.create", json!({ "folder": folder, "name": "Scene" }));

    // Import: two scan positions, each with the identity pose.
    let imported = go("preprocess.import", json!({ "sourcePath": ptx.to_string_lossy() }));
    assert_eq!(imported["importer"], "ptx");
    assert_eq!(imported["project"]["id"], "scene");
    let scan_ids: Vec<String> = imported["project"]["scanPositions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(scan_ids.len(), 2);
    assert_eq!(imported["project"]["scanPositions"][0]["pointCount"].as_u64().unwrap() as usize, n);
    let listed = go("preprocess.projects", Value::Null);
    assert_eq!(listed["ptx"].as_array().unwrap().len(), 1);
    assert_eq!(listed["e57"].as_array().unwrap().len(), 0);
    let scans = go("preprocess.scans", Value::Null);
    assert_eq!(scans.as_array().unwrap().len(), 2);
    let scan = |id: &str| json!({ "importer": "ptx", "projectId": "scene", "scanId": id });
    let translation = |v: &Value| -> [f64; 3] {
        let p = v.as_array().unwrap();
        [p[3].as_f64().unwrap(), p[7].as_f64().unwrap(), p[11].as_f64().unwrap()]
    };
    let pose_of = |id: &str| -> [f64; 3] {
        let scans = go("preprocess.scans", Value::Null);
        let s = scans.as_array().unwrap().iter().find(|s| s["scanId"] == id).unwrap();
        translation(&s["pose"])
    };
    assert_eq!(pose_of(&scan_ids[1]), [0.0, 0.0, 0.0]);

    // Tie points, world to world: scan B's points under its (identity)
    // pose against where they are in scan A. The Kabsch correction is
    // the offset, composed onto B's pose.
    let ties: Vec<Value> = [[2.5, 3.0, 1.0], [17.5, 15.0, 2.0], [7.5, 9.0, 5.0], [12.5, 3.0, 0.5]]
        .iter()
        .map(|p| json!({ "source": [p[0] - offset[0], p[1] - offset[1], p[2] - offset[2]], "target": p }))
        .collect();
    let solved = go("preprocess.solve", json!({ "ties": ties, "applyTo": scan(&scan_ids[1]) }));
    assert!(solved["rmse"].as_f64().unwrap() < 1e-9);
    assert_eq!(solved["applied"], true);
    let t = pose_of(&scan_ids[1]);
    for k in 0..3 {
        assert!((t[k] - offset[k]).abs() < 1e-9, "tie-point pose {t:?}");
    }

    // Back to the misregistered pose, then ICP finds the offset again.
    let identity: Vec<f64> = vec![1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    go("preprocess.apply", json!({ "scan": scan(&scan_ids[1]), "pose": identity }));
    assert_eq!(pose_of(&scan_ids[1]), [0.0, 0.0, 0.0]);
    let icp = go("preprocess.icp", json!({ "source": scan(&scan_ids[1]), "target": scan(&scan_ids[0]), "maxIters": 150, "apply": true }));
    assert_eq!(icp["applied"], true);
    assert!(icp["correspondences"].as_u64().unwrap() > 1000);
    let t = translation(&icp["pose"]);
    for k in 0..3 {
        assert!((t[k] - offset[k]).abs() < 0.05, "ICP pose {t:?} (rmse {}, {} iterations, converged {})", icp["rmse"], icp["rmseHistory"].as_array().unwrap().len(), icp["converged"]);
    }
    assert!(icp["rmse"].as_f64().unwrap() < 0.05, "{}", icp["rmse"]);

    // Targets: the ground plane is a plane patch; no spheres were placed.
    let targets = go("preprocess.targets", json!({ "scan": scan(&scan_ids[0]) }));
    assert!(targets["points"].as_u64().unwrap() as usize >= n);
    assert!(!targets["planes"].as_array().unwrap().is_empty(), "the ground plane is a patch");
    assert!(run("preprocess.matchSpheres", json!({ "source": scan(&scan_ids[1]), "target": scan(&scan_ids[0]) }), &ctx).unwrap_err().contains("no sphere targets"));

    // Export both scans, cropped, as one LAS, and bring it in as a dataset.
    let las = dir.join("scene.las");
    let exported = go("preprocess.export", json!({ "format": "ptx", "id": "scene", "outPath": las.to_string_lossy(), "zMin": 0.5 }));
    let exported_points = exported["pointCount"].as_u64().unwrap() as usize;
    assert!(exported_points > 0 && exported_points < 2 * n, "crop at z ≥ 0.5 keeps the stems: {exported_points}");
    assert_eq!(exported["scanPositionIds"].as_array().unwrap().len(), 2);
    let dataset = go("dataset.import", json!({ "srcPath": las.to_string_lossy(), "scannerType": "tls" }));
    assert_eq!(dataset["pointCount"].as_u64().unwrap() as usize, exported_points);

    // Removing the scanner project leaves the source file alone.
    go("preprocess.remove", json!({ "format": "ptx", "id": "scene" }));
    assert_eq!(go("preprocess.projects", Value::Null)["ptx"].as_array().unwrap().len(), 0);
    assert!(ptx.is_file());

    // An XYZ / ASCII file: imported with its columns sniffed, the
    // mapping settable, exported cropped.
    let xyz = dir.join("cloud.xyz");
    let mut text = String::from("x y z intensity\n");
    for k in 0..500 {
        text.push_str(&format!("{:.2} {:.2} {:.2} {}\n", (k % 25) as f64 * 0.4, (k / 25) as f64 * 0.4, (k % 7) as f64 * 0.1, k % 255));
    }
    std::fs::write(&xyz, text).unwrap();
    let imported = go("preprocess.import", json!({ "sourcePath": xyz.to_string_lossy() }));
    assert_eq!(imported["importer"], "xyz");
    let xyz_id = imported["project"]["id"].as_str().unwrap().to_string();
    assert_eq!(imported["project"]["columnCount"], 4);
    let mapped = go("preprocess.xyzMapping", json!({ "id": xyz_id, "mapping": { "x": 0, "y": 1, "z": 2, "intensity": 3 } }));
    assert_eq!(mapped["mapping"]["intensity"], 3);
    let xyz_las = dir.join("cloud.las");
    let exported = go("preprocess.export", json!({ "format": "xyz", "id": xyz_id, "outPath": xyz_las.to_string_lossy(), "xMax": 4.0 }));
    let n_xyz = exported["pointCount"].as_u64().unwrap();
    assert!(n_xyz > 0 && n_xyz < 500, "{n_xyz}");
    assert!(exported["scanPositionIds"].as_array().unwrap().is_empty());

    // An E57 file of two scans, the second carrying a translation in
    // its pose: both scan positions listed with their poses, the
    // region exported in world coordinates.
    let e57_path = dir.join("scene.e57");
    {
        use e57::{E57Writer, Record, RecordValue, Transform, Quaternion, Translation};
        let mut w = E57Writer::from_file(&e57_path, "{pcl-e2e-file}").unwrap();
        for (k, shift) in [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0]].iter().enumerate() {
            let proto = vec![Record::CARTESIAN_X_F64, Record::CARTESIAN_Y_F64, Record::CARTESIAN_Z_F64];
            let mut pc = w.add_pointcloud(&format!("{{pcl-e2e-scan-{k}}}"), proto).unwrap();
            pc.set_name(Some(format!("Scan {k}")));
            pc.set_transform(Some(Transform { rotation: Quaternion { w: 1.0, x: 0.0, y: 0.0, z: 0.0 }, translation: Translation { x: shift[0], y: shift[1], z: shift[2] } }));
            for i in 0..400 {
                let x = (i % 20) as f64 * 0.2;
                let y = (i / 20) as f64 * 0.2;
                pc.add_point(vec![RecordValue::Double(x), RecordValue::Double(y), RecordValue::Double(1.0 + (i % 3) as f64 * 0.1)]).unwrap();
            }
            pc.finalize().unwrap();
        }
        w.finalize().unwrap();
    }
    let imported = go("preprocess.import", json!({ "sourcePath": e57_path.to_string_lossy(), "name": "e57 scene" }));
    assert_eq!(imported["importer"], "e57");
    let e57_id = imported["project"]["id"].as_str().unwrap().to_string();
    let positions = imported["project"]["scanPositions"].as_array().unwrap().clone();
    assert_eq!(positions.len(), 2);
    assert_eq!(positions[1]["pose"][3], 10.0, "the pose carries the translation");
    let scans = go("preprocess.scans", Value::Null);
    assert_eq!(scans.as_array().unwrap().iter().filter(|s| s["importer"] == "e57").count(), 2);
    let e57_las = dir.join("scene_e57.las");
    let second = positions[1]["id"].as_str().unwrap();
    let exported = go("preprocess.export", json!({ "format": "e57", "id": e57_id, "outPath": e57_las.to_string_lossy(), "scanPositionIds": [second], "xMin": 9.0 }));
    assert_eq!(exported["pointCount"], 400, "the second scan sits at x ≥ 10 in the world");
    let exported = go("preprocess.export", json!({ "format": "e57", "id": e57_id, "outPath": e57_las.to_string_lossy(), "xMax": 5.0 }));
    assert_eq!(exported["pointCount"], 400, "only the first scan is below x = 5");
    go("project.close", Value::Null);
    let _ = std::fs::remove_dir_all(&dir);
}
