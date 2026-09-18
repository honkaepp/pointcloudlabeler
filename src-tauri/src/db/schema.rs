//! Per-project SQLite schema. One project.db per project holds trees / plots /
//! stands / metrics / edit history. Binary point cloud data lives outside the
//! DB in .tcloud files.
//!
//! Versioning: `schema_meta(key='schema_version')` carries the user-DB version
//! number. `SCHEMA_SQL` always declares the *current* (= SCHEMA_VERSION) shape;
//! older projects are brought forward through one `migrate_vN_to_vN1` per
//! version step, called from `state::open_db`.
//!
//! v1 — initial: clouds, plots(cloud_id), trees, tree_metrics, plot_metrics,
//!      cloud_edits.
//! v2 — §9.3 hierarchy: stands table, plots.stand_id, clouds.plot_id,
//!      clouds.scanner_type with CHECK constraint, two extra indexes.
//! v3 — branches: per-tree branch records keyed by (tree_pk, branch_id),
//!      with base XY/Z, length, insertion angle + height, point count.
//!      Populated by the pc_detect_branches port (TreePlugin 'branches').

use rusqlite::Connection;

use crate::error::{AppResult, WithContext};

pub const SCHEMA_VERSION: u32 = 3;

/// Canonical current-version TABLES, applied with `execute_batch`. All
/// statements are idempotent (`CREATE … IF NOT EXISTS`) so this can run on
/// a fresh DB or be re-applied to an existing one without error. Note:
/// CREATE TABLE IF NOT EXISTS does NOT add new columns to an existing
/// table — the v1 → v2 column additions go through `migrate_v1_to_v2`.
///
/// The indexes are deliberately NOT here; see `SCHEMA_INDEXES_SQL`.
pub const SCHEMA_TABLES_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  geometry_wkt TEXT,
  area_ha REAL,
  species_target TEXT,
  age_years INTEGER,
  created_at INTEGER NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS clouds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_file TEXT,
  source_format TEXT,
  point_count INTEGER,
  min_x REAL, min_y REAL, min_z REAL,
  max_x REAL, max_y REAL, max_z REAL,
  origin_x REAL, origin_y REAL, origin_z REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  plot_id INTEGER,
  scanner_type TEXT CHECK (scanner_type IS NULL OR scanner_type IN ('TLS', 'MLS', 'ULS', 'ALS', 'other')),
  notes TEXT,
  FOREIGN KEY (plot_id) REFERENCES plots(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS plots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cloud_id TEXT,
  stand_id INTEGER,
  name TEXT NOT NULL,
  shape TEXT,
  geometry_wkt TEXT,
  center_x REAL,
  center_y REAL,
  radius_m REAL,
  area_m2 REAL,
  created_at INTEGER NOT NULL,
  notes TEXT,
  FOREIGN KEY (cloud_id) REFERENCES clouds(id) ON DELETE SET NULL,
  FOREIGN KEY (stand_id) REFERENCES stands(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS trees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cloud_id TEXT NOT NULL,
  tree_id INTEGER NOT NULL,
  plot_id INTEGER,
  species TEXT,
  status TEXT DEFAULT 'alive',
  apex_x REAL, apex_y REAL, apex_z REAL,
  base_x REAL, base_y REAL, base_z REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  notes TEXT,
  UNIQUE(cloud_id, tree_id),
  FOREIGN KEY (cloud_id) REFERENCES clouds(id) ON DELETE CASCADE,
  FOREIGN KEY (plot_id) REFERENCES plots(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS tree_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_pk INTEGER NOT NULL,
  metric TEXT NOT NULL,
  value REAL,
  unit TEXT,
  method TEXT,
  computed_at INTEGER NOT NULL,
  FOREIGN KEY (tree_pk) REFERENCES trees(id) ON DELETE CASCADE,
  UNIQUE(tree_pk, metric)
);

CREATE TABLE IF NOT EXISTS plot_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plot_id INTEGER NOT NULL,
  metric TEXT NOT NULL,
  value REAL,
  unit TEXT,
  method TEXT,
  computed_at INTEGER NOT NULL,
  FOREIGN KEY (plot_id) REFERENCES plots(id) ON DELETE CASCADE,
  UNIQUE(plot_id, metric)
);

CREATE TABLE IF NOT EXISTS cloud_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cloud_id TEXT NOT NULL,
  action TEXT NOT NULL,
  affected_count INTEGER,
  details TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (cloud_id) REFERENCES clouds(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tree_pk INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  base_x REAL,
  base_y REAL,
  base_z REAL,
  length_m REAL,
  insertion_angle_deg REAL,
  insertion_height_m REAL,
  point_count INTEGER,
  computed_at INTEGER NOT NULL,
  FOREIGN KEY (tree_pk) REFERENCES trees(id) ON DELETE CASCADE,
  UNIQUE(tree_pk, branch_id)
);
"#;

/// The indexes, applied AFTER the version migrations rather than with the
/// tables.
///
/// Two of them reference columns that only a migration adds — `stand_id`
/// on plots and `plot_id` on clouds, both introduced in v2. On a v1
/// project the tables already exist, so `CREATE TABLE IF NOT EXISTS` is a
/// no-op and does not add those columns; creating the index then failed
/// with "no such column: stand_id" and took the whole `execute_batch`
/// down with it. Because that ran BEFORE the migrations, `open_db`
/// returned an error and `migrate_v1_to_v2` was never reached: every v1
/// project was unopenable, and no upgrade path could run to fix it.
///
/// An index can only be created once every column it names exists, so
/// these run last. Keep it that way when adding one.
pub const SCHEMA_INDEXES_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_trees_cloud ON trees(cloud_id);
CREATE INDEX IF NOT EXISTS idx_trees_plot ON trees(plot_id);
CREATE INDEX IF NOT EXISTS idx_trees_treeid ON trees(cloud_id, tree_id);
CREATE INDEX IF NOT EXISTS idx_tree_metrics_tree ON tree_metrics(tree_pk);
CREATE INDEX IF NOT EXISTS idx_tree_metrics_name ON tree_metrics(metric);
CREATE INDEX IF NOT EXISTS idx_plot_metrics_plot ON plot_metrics(plot_id);
CREATE INDEX IF NOT EXISTS idx_cloud_edits_cloud ON cloud_edits(cloud_id);
CREATE INDEX IF NOT EXISTS idx_plots_stand ON plots(stand_id);
CREATE INDEX IF NOT EXISTS idx_clouds_plot ON clouds(plot_id);
CREATE INDEX IF NOT EXISTS idx_branches_tree ON branches(tree_pk);
"#;

/// True if `table` already has a column named `column`. Cheap helper used by
/// idempotent ALTER passes — SQLite's ALTER TABLE ADD COLUMN doesn't accept
/// IF NOT EXISTS, so we look it up via PRAGMA table_info first.
fn column_exists(conn: &Connection, table: &str, column: &str) -> AppResult<bool> {
    let sql = format!("PRAGMA table_info({table})");
    let mut stmt = conn.prepare(&sql).ctx("PRAGMA table_info prepare")?;
    let mut rows = stmt.query([]).ctx("PRAGMA table_info query")?;
    while let Some(row) = rows.next().ctx("PRAGMA table_info row")? {
        // column 1 of PRAGMA table_info is the column name
        let name: String = row.get(1).ctx("read column name")?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Add the §9.3 hierarchy columns + stands table to a v1 project DB.
/// Idempotent: each ALTER is gated on a column-existence check, and the
/// stands table + indexes use `IF NOT EXISTS` via SCHEMA_SQL. Safe to call
/// even if the DB is already at v2.
///
/// Important: this does NOT itself bump `schema_meta.schema_version` — the
/// caller (`state::open_db`) does that inside the same connection after the
/// migration succeeds so a partial migration can be retried.
pub fn migrate_v1_to_v2(conn: &Connection) -> AppResult<()> {
    if !column_exists(conn, "plots", "stand_id")? {
        conn.execute_batch(
            "ALTER TABLE plots \
             ADD COLUMN stand_id INTEGER \
             REFERENCES stands(id) ON DELETE SET NULL",
        )
        .ctx("ALTER plots ADD stand_id")?;
    }
    if !column_exists(conn, "clouds", "plot_id")? {
        conn.execute_batch(
            "ALTER TABLE clouds \
             ADD COLUMN plot_id INTEGER \
             REFERENCES plots(id) ON DELETE SET NULL",
        )
        .ctx("ALTER clouds ADD plot_id")?;
    }
    if !column_exists(conn, "clouds", "scanner_type")? {
        conn.execute_batch(
            "ALTER TABLE clouds \
             ADD COLUMN scanner_type TEXT \
             CHECK (scanner_type IS NULL OR scanner_type IN ('TLS', 'MLS', 'ULS', 'ALS', 'other'))",
        )
        .ctx("ALTER clouds ADD scanner_type")?;
    }
    Ok(())
}

/// Add the v3 branches table for the pc_detect_branches port. SCHEMA_SQL's
/// `CREATE TABLE IF NOT EXISTS branches` already covers brand-new DBs;
/// this exists so that an upgrade path from a project where the v2
/// SCHEMA_SQL ran but the branches table didn't (which can happen when
/// SCHEMA_SQL was the v2 string at migration time) still gets it.
/// Idempotent — re-running on a v3 DB is a no-op.
pub fn migrate_v2_to_v3(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS branches (\
           id INTEGER PRIMARY KEY AUTOINCREMENT,\
           tree_pk INTEGER NOT NULL,\
           branch_id INTEGER NOT NULL,\
           base_x REAL, base_y REAL, base_z REAL,\
           length_m REAL, insertion_angle_deg REAL, insertion_height_m REAL,\
           point_count INTEGER,\
           computed_at INTEGER NOT NULL,\
           FOREIGN KEY (tree_pk) REFERENCES trees(id) ON DELETE CASCADE,\
           UNIQUE(tree_pk, branch_id)\
         );\
         CREATE INDEX IF NOT EXISTS idx_branches_tree ON branches(tree_pk);",
    )
    .ctx("create branches v3")?;
    Ok(())
}
