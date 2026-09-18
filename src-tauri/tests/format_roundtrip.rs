//! End-to-end data-path test. Exercises the parts of the Rust backend that
//! don't need a Tauri runtime (so we can validate them headless under CI on
//! Linux, even though the user-facing app runs on Windows + WebView2).
//!
//! Covered:
//!   * `state::open_db` creates the full schema and inserts schema_version
//!   * ProjectMeta serializes + deserializes round-trips with the renderer's
//!     camelCase shape
//!   * The .tcloud binary format roundtrips: write header + payload manually,
//!     then parse it via `commands::cloud::parse_cloud_header`
//!   * The save path's per-row encoding produces a byte stream we can replay

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use pointcloudlabeler_editor_lib::commands::cloud::parse_cloud_header;
use pointcloudlabeler_editor_lib::commands::project::ProjectState;
use pointcloudlabeler_editor_lib::state::{open_db, CoordinateSystem, ProjectMeta};

fn tmp_dir(label: &str) -> PathBuf {
    let mut p = std::env::temp_dir();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    p.push(format!("pointcloudlabeler-test-{label}-{stamp}"));
    fs::create_dir_all(&p).unwrap();
    p
}

#[test]
fn schema_creates_all_tables_and_version_row() {
    let folder = tmp_dir("schema");
    let conn = open_db(&folder).expect("open_db");

    // Every domain table should exist and start empty (v2 adds `stands`,
    // v3 adds `branches`).
    for table in [
        "clouds", "plots", "stands", "trees", "tree_metrics", "plot_metrics", "cloud_edits", "branches",
    ] {
        let sql = format!("SELECT count(*) FROM {table}");
        let n: i64 = conn.query_row(&sql, [], |r| r.get(0)).expect(table);
        assert_eq!(n, 0, "table {table} should be empty on a fresh DB");
    }
    // schema_meta holds the schema_version row that open_db inserts.
    let meta_rows: i64 = conn
        .query_row("SELECT count(*) FROM schema_meta", [], |r| r.get(0))
        .unwrap();
    assert_eq!(meta_rows, 1);

    let v: String = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .expect("schema_version row");
    assert_eq!(v, "3", "fresh DB should be at v3");

    // Re-opening the same folder must succeed (sidecar cleanup + idempotent
    // schema). This is the regression we chased in vaihe 0 with the "database
    // is locked" sidecars from node-sqlite3-wasm.
    drop(conn);
    let _conn2 = open_db(&folder).expect("reopen");
}

/// PRAGMA table_info helper — returns the names of every column on a table.
fn column_names(conn: &rusqlite::Connection, table: &str) -> Vec<String> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql).unwrap();
    let mut rows = stmt.query([]).unwrap();
    let mut out = Vec::new();
    while let Some(row) = rows.next().unwrap() {
        out.push(row.get::<_, String>(1).unwrap());
    }
    out
}

#[test]
fn v2_schema_has_hierarchy_columns_and_indexes() {
    let folder = tmp_dir("v2-cols");
    let conn = open_db(&folder).expect("open_db");

    // §9.3: plots gains stand_id; clouds gains plot_id + scanner_type.
    assert!(
        column_names(&conn, "plots").contains(&"stand_id".to_string()),
        "plots should have stand_id in v2"
    );
    let cloud_cols = column_names(&conn, "clouds");
    assert!(cloud_cols.contains(&"plot_id".to_string()), "clouds should have plot_id in v2");
    assert!(
        cloud_cols.contains(&"scanner_type".to_string()),
        "clouds should have scanner_type in v2"
    );

    // Indexes promised by §9.3.
    let idx_names: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(idx_names.iter().any(|n| n == "idx_plots_stand"));
    assert!(idx_names.iter().any(|n| n == "idx_clouds_plot"));

    // The scanner_type CHECK constraint accepts the documented values and
    // NULL, rejects anything else.
    conn.execute(
        "INSERT INTO clouds(id, name, created_at, updated_at, scanner_type) VALUES \
         ('c1', 'tls scan', 0, 0, 'TLS')",
        [],
    )
    .expect("TLS should be accepted");
    conn.execute(
        "INSERT INTO clouds(id, name, created_at, updated_at) VALUES \
         ('c2', 'no class', 0, 0)",
        [],
    )
    .expect("NULL scanner_type should be accepted");
    let err = conn.execute(
        "INSERT INTO clouds(id, name, created_at, updated_at, scanner_type) VALUES \
         ('c3', 'bogus', 0, 0, 'CAR')",
        [],
    );
    assert!(err.is_err(), "non-enum scanner_type should be rejected");
}

/// Open a v0.2 project DB (= PointCloudLabeler schema v1) and verify the v1 → v2
/// migration adds the new columns, the stands table, and bumps the
/// version row to '2' on the next open_db call.
#[test]
fn migrate_v1_project_upgrades_to_v2() {
    let folder = tmp_dir("migrate-v1");
    let db_path = folder.join("project.db");

    // Hand-build a v1 schema (= the original Canopy Segment shape, no stands
    // table, no stand_id / plot_id / scanner_type).
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE clouds (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, source_file TEXT,
              source_format TEXT, point_count INTEGER,
              min_x REAL, min_y REAL, min_z REAL, max_x REAL, max_y REAL, max_z REAL,
              origin_x REAL, origin_y REAL, origin_z REAL,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, notes TEXT
            );
            CREATE TABLE plots (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              cloud_id TEXT, name TEXT NOT NULL, shape TEXT, geometry_wkt TEXT,
              center_x REAL, center_y REAL, radius_m REAL, area_m2 REAL,
              created_at INTEGER NOT NULL, notes TEXT,
              FOREIGN KEY (cloud_id) REFERENCES clouds(id) ON DELETE SET NULL
            );
            CREATE TABLE trees (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              cloud_id TEXT NOT NULL, tree_id INTEGER NOT NULL,
              plot_id INTEGER, species TEXT, status TEXT DEFAULT 'alive',
              apex_x REAL, apex_y REAL, apex_z REAL,
              base_x REAL, base_y REAL, base_z REAL,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, notes TEXT,
              UNIQUE(cloud_id, tree_id)
            );
            CREATE TABLE tree_metrics (
              id INTEGER PRIMARY KEY AUTOINCREMENT, tree_pk INTEGER NOT NULL,
              metric TEXT NOT NULL, value REAL, unit TEXT, method TEXT,
              computed_at INTEGER NOT NULL, UNIQUE(tree_pk, metric)
            );
            CREATE TABLE plot_metrics (
              id INTEGER PRIMARY KEY AUTOINCREMENT, plot_id INTEGER NOT NULL,
              metric TEXT NOT NULL, value REAL, unit TEXT, method TEXT,
              computed_at INTEGER NOT NULL, UNIQUE(plot_id, metric)
            );
            CREATE TABLE cloud_edits (
              id INTEGER PRIMARY KEY AUTOINCREMENT, cloud_id TEXT NOT NULL,
              action TEXT NOT NULL, affected_count INTEGER, details TEXT,
              created_at INTEGER NOT NULL
            );
            INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1');
            INSERT INTO clouds(id, name, created_at, updated_at) VALUES ('legacy', 'old cloud', 100, 100);
            INSERT INTO plots(name, created_at) VALUES ('legacy plot', 100);
            "#,
        )
        .unwrap();
    }

    // Sanity: pre-migration shape lacks the v2 columns.
    {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        assert!(!column_names(&conn, "plots").contains(&"stand_id".to_string()));
        assert!(!column_names(&conn, "clouds").contains(&"plot_id".to_string()));
    }

    // open_db should run the migration and bump the version.
    let conn = open_db(&folder).expect("open_db should migrate v1 → v2");

    let v: String = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(v, "3", "schema_meta should be bumped past v2 (we now ship v3)");

    assert!(column_names(&conn, "plots").contains(&"stand_id".to_string()));
    let cloud_cols = column_names(&conn, "clouds");
    assert!(cloud_cols.contains(&"plot_id".to_string()));
    assert!(cloud_cols.contains(&"scanner_type".to_string()));

    // Pre-existing rows should still be queryable (FK-with-NULL is fine).
    let legacy_name: String = conn
        .query_row("SELECT name FROM clouds WHERE id = 'legacy'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(legacy_name, "old cloud");

    // The migration must be idempotent: running open_db again on a v2 DB
    // must not error and must not bump the version twice.
    drop(conn);
    let conn2 = open_db(&folder).expect("re-open of v2 DB");
    let v2: String = conn2
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(v2, "3");
}

#[test]
fn project_meta_roundtrips_through_camel_case_json() {
    let now: i64 = 1_700_000_000_000;
    let meta = ProjectMeta {
        version: 1,
        name: "Test Plot".into(),
        created_at: now,
        updated_at: now + 60_000,
        coordinate_system: CoordinateSystem {
            epsg: Some(3067),
            name: "ETRS89 / TM35FIN".into(),
            vertical: Some("N2000".into()),
        },
        default_cloud_format: "txt".into(),
        notes: "boreal sample".into(),
    };

    let json = serde_json::to_string(&meta).unwrap();
    // The renderer expects camelCase keys — make sure serde serializes that way.
    assert!(json.contains("\"coordinateSystem\""));
    assert!(json.contains("\"createdAt\""));
    assert!(json.contains("\"updatedAt\""));
    assert!(json.contains("\"defaultCloudFormat\""));
    assert!(!json.contains("created_at"));

    let back: ProjectMeta = serde_json::from_str(&json).unwrap();
    assert_eq!(back.name, "Test Plot");
    assert_eq!(back.coordinate_system.epsg, Some(3067));
    assert_eq!(back.coordinate_system.vertical.as_deref(), Some("N2000"));
}

#[test]
fn project_state_serializes_with_camel_case_meta() {
    // What the renderer actually receives from project_current / project_open.
    let now: i64 = 1_700_000_000_000;
    let state = ProjectState {
        folder: "/tmp/example".into(),
        meta: ProjectMeta {
            version: 1,
            name: "P".into(),
            created_at: now,
            updated_at: now,
            coordinate_system: CoordinateSystem {
                epsg: None,
                name: "unknown".into(),
                vertical: None,
            },
            default_cloud_format: "txt".into(),
            notes: String::new(),
        },
    };
    let json = serde_json::to_string(&state).unwrap();
    assert!(json.contains("\"folder\":\"/tmp/example\""));
    assert!(json.contains("\"coordinateSystem\""));
}

/// Helper: write a synthetic .tcloud file in the exact binary format the
/// renderer (fsCloudStore.ts) and Rust (cloud_write_append) produce.
fn write_tcloud(path: &std::path::Path, meta_json: &str, positions: &[f32], tree_ids: &[i32]) {
    let mut f = fs::File::create(path).unwrap();
    let header = meta_json.as_bytes();
    f.write_all(&(header.len() as u32).to_le_bytes()).unwrap();
    f.write_all(header).unwrap();

    let pos_bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(positions.as_ptr() as *const u8, positions.len() * 4)
    };
    f.write_all(&(pos_bytes.len() as u32).to_le_bytes()).unwrap();
    f.write_all(pos_bytes).unwrap();

    let ids_bytes: &[u8] = unsafe {
        std::slice::from_raw_parts(tree_ids.as_ptr() as *const u8, tree_ids.len() * 4)
    };
    f.write_all(&(ids_bytes.len() as u32).to_le_bytes()).unwrap();
    f.write_all(ids_bytes).unwrap();

    // deleted: 0 bytes
    f.write_all(&0u32.to_le_bytes()).unwrap();
    f.flush().unwrap();
}

#[test]
fn tcloud_header_parses_back_after_write() {
    let dir = tmp_dir("tcloud-header");
    let path = dir.join("sample.tcloud");

    let positions: Vec<f32> = (0..30).map(|i| i as f32 * 0.1).collect(); // 10 points
    let tree_ids: Vec<i32> = (0..10).collect();
    let meta_json = r#"{"version":1,"name":"sample","count":10,"savedAt":1700000000000,"columnOrder":["x","y","z","tree_id"],"columnSep":" ","hadHeader":true,"origin":{"x":0.0,"y":0.0,"z":0.0},"colIdx":{"ix":0,"iy":1,"iz":2,"iId":3,"extraIdx":[],"extraNames":[]},"extras":[],"camera":null,"hasDeleted":false}"#;
    write_tcloud(&path, meta_json, &positions, &tree_ids);

    let (parsed, stat) = parse_cloud_header(&path).expect("header should parse");
    assert_eq!(parsed["name"].as_str(), Some("sample"));
    assert_eq!(parsed["count"].as_u64(), Some(10));
    assert_eq!(parsed["savedAt"].as_i64(), Some(1_700_000_000_000));
    // Whole file is bigger than the header alone (positions + ids written too).
    assert!(stat.len() > meta_json.len() as u64 + 16);
}

#[test]
fn tcloud_payload_roundtrips_byte_for_byte() {
    let dir = tmp_dir("tcloud-payload");
    let path = dir.join("rt.tcloud");

    let positions: Vec<f32> = (0..3000).map(|i| (i as f32).sin()).collect(); // 1000 points
    let tree_ids: Vec<i32> = (0..1000).map(|i| (i % 17) + 1).collect();
    let meta_json = r#"{"version":1,"name":"rt","count":1000,"columnOrder":[],"columnSep":" ","hadHeader":false,"origin":{"x":0.0,"y":0.0,"z":0.0},"colIdx":{"ix":0,"iy":1,"iz":2,"iId":-1,"extraIdx":[],"extraNames":[]},"extras":[],"camera":null,"hasDeleted":false}"#;
    write_tcloud(&path, meta_json, &positions, &tree_ids);

    // Replay the read path: header length, header bytes, positions length,
    // positions bytes, ids length, ids bytes, deleted length (0).
    let mut f = fs::File::open(&path).unwrap();

    let mut len_buf = [0u8; 4];
    f.read_exact(&mut len_buf).unwrap();
    let h_len = u32::from_le_bytes(len_buf) as usize;
    let mut h = vec![0u8; h_len];
    f.read_exact(&mut h).unwrap();
    let meta: serde_json::Value = serde_json::from_slice(&h).unwrap();
    assert_eq!(meta["count"].as_u64(), Some(1000));

    f.read_exact(&mut len_buf).unwrap();
    let pos_len = u32::from_le_bytes(len_buf) as usize;
    assert_eq!(pos_len, positions.len() * 4);
    let mut pos_bytes = vec![0u8; pos_len];
    f.read_exact(&mut pos_bytes).unwrap();
    let pos_read: Vec<f32> = pos_bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    assert_eq!(pos_read, positions);

    f.read_exact(&mut len_buf).unwrap();
    let id_len = u32::from_le_bytes(len_buf) as usize;
    let mut id_bytes = vec![0u8; id_len];
    f.read_exact(&mut id_bytes).unwrap();
    let id_read: Vec<i32> = id_bytes
        .chunks_exact(4)
        .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    assert_eq!(id_read, tree_ids);

    f.read_exact(&mut len_buf).unwrap();
    assert_eq!(u32::from_le_bytes(len_buf), 0, "no deleted set");

    let end = f.seek(SeekFrom::Current(0)).unwrap();
    let total = f.metadata().unwrap().len();
    assert_eq!(end, total, "all bytes consumed");
}

#[test]
fn timing_save_5m_points_under_ten_seconds() {
    // 5 M points (15 M f32 = 60 MB) + 5 M i32 ids (20 MB).
    // Validates the raw fs::write path is at disk-bandwidth speed: should
    // complete in well under a second on any modern SSD, comfortably below
    // the RiScan-style "tens of seconds" goal even after 10x scaling.
    let dir = tmp_dir("timing");
    let path = dir.join("perf.tcloud");

    const N: usize = 5_000_000;
    let positions: Vec<f32> = (0..N * 3).map(|i| (i & 0xFF) as f32).collect();
    let tree_ids: Vec<i32> = (0..N as i32).collect();
    let meta_json = format!(
        r#"{{"version":1,"name":"perf","count":{N},"columnOrder":[],"columnSep":" ","hadHeader":false,"origin":{{"x":0.0,"y":0.0,"z":0.0}},"colIdx":{{"ix":0,"iy":1,"iz":2,"iId":-1,"extraIdx":[],"extraNames":[]}},"extras":[],"camera":null,"hasDeleted":false}}"#
    );

    let t0 = std::time::Instant::now();
    write_tcloud(&path, &meta_json, &positions, &tree_ids);
    let dt = t0.elapsed();

    let bytes = path.metadata().unwrap().len();
    let mb = bytes as f64 / (1024.0 * 1024.0);
    let mbps = mb / dt.as_secs_f64();
    println!(
        "save {} pts ({:.1} MB) in {:.2}s = {:.0} MB/s",
        N,
        mb,
        dt.as_secs_f64(),
        mbps
    );
    assert!(
        dt.as_secs_f64() < 10.0,
        "save took {dt:?} — well over the RiScan-style budget"
    );
}

/// Tables and indexes must stay in separate batches, because `open_db`
/// runs the version migrations between them.
///
/// Two indexes name columns that only `migrate_v1_to_v2` adds. While they
/// lived alongside the tables they were created BEFORE that migration
/// ran, and on a v1 project — where `CREATE TABLE IF NOT EXISTS plots` is
/// a no-op that adds no column — `CREATE INDEX … ON plots(stand_id)`
/// failed with "no such column". `execute_batch` aborts the whole batch,
/// so `open_db` returned an error and the migration was never reached:
/// the project could not be opened, and no upgrade path could run to
/// repair it.
///
/// A new index added to the tables batch would restore exactly that, and
/// only for users with an older project — never on a fresh one, which is
/// what a developer tests with. This pins the split itself.
#[test]
fn schema_keeps_indexes_out_of_the_tables_batch() {
    use pointcloudlabeler_editor_lib::db::schema::{SCHEMA_INDEXES_SQL, SCHEMA_TABLES_SQL};

    assert!(
        !SCHEMA_TABLES_SQL.to_uppercase().contains("CREATE INDEX"),
        "an index in the tables batch runs before the migrations that add its columns",
    );
    assert!(
        !SCHEMA_INDEXES_SQL.to_uppercase().contains("CREATE TABLE"),
        "a table in the indexes batch is created after the migrations that expect it",
    );
    assert!(
        SCHEMA_INDEXES_SQL.contains("idx_plots_stand"),
        "the indexes batch should hold every index",
    );
}
