use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::schema::{
    migrate_v1_to_v2, migrate_v2_to_v3, SCHEMA_INDEXES_SQL, SCHEMA_TABLES_SQL, SCHEMA_VERSION,
};
use crate::error::{AppError, AppResult, WithContext};

pub const PROJECT_FILE: &str = "project.json";
pub const DB_FILE: &str = "project.db";
pub const CLOUDS_DIR: &str = "clouds";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoordinateSystem {
    pub epsg: Option<i64>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub version: u32,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(rename = "coordinateSystem")]
    pub coordinate_system: CoordinateSystem,
    #[serde(rename = "defaultCloudFormat")]
    pub default_cloud_format: String,
    pub notes: String,
}

pub struct OpenProject {
    pub folder: PathBuf,
    pub meta: ProjectMeta,
    pub db: Connection,
}

/// Per-cloud open file descriptors (so renderer can stream large writes/reads).
pub struct CloudHandle {
    pub file: std::fs::File,
    /// Where the bytes are actually going: a sibling temp file. The
    /// destination is only replaced on commit — see commands/cloud.rs.
    pub temp: PathBuf,
    /// The destination the temp is renamed onto.
    pub path: PathBuf,
    #[allow(dead_code)]
    pub id: String,
    #[allow(dead_code)]
    pub total_size: u64,
}

#[derive(Default)]
pub struct AppState {
    pub current: Mutex<Option<OpenProject>>,
    pub cloud_writes: Mutex<HashMap<u64, CloudHandle>>,
    pub cloud_reads: Mutex<HashMap<u64, CloudHandle>>,
    pub next_handle: Mutex<u64>,
    pub recent_files: Mutex<Vec<String>>,
    /// The paths the user chose in a dialog this run — what the file
    /// commands check before touching anything. See fsgrant.rs.
    pub grants: crate::fsgrant::PathGrants,
}

impl AppState {
    pub fn allocate_handle(&self) -> u64 {
        let mut next = self.next_handle.lock();
        *next += 1;
        *next
    }

    pub fn with_current<F, R>(&self, f: F) -> AppResult<R>
    where
        F: FnOnce(&mut OpenProject) -> AppResult<R>,
    {
        let mut guard = self.current.lock();
        let proj = guard
            .as_mut()
            .ok_or_else(|| AppError::msg("No project open — create or open a project first"))?;
        f(proj)
    }

    /// The open project's folder, if one is open. Cloned rather than
    /// borrowed so the `current` lock is released before a caller takes
    /// any other lock.
    pub fn project_folder(&self) -> Option<PathBuf> {
        self.current.lock().as_ref().map(|p| p.folder.clone())
    }

    /// Check a renderer-supplied path and return the resolved form to
    /// use. Every file command goes through here; see fsgrant.rs for
    /// what is permitted and why.
    pub fn authorise_path(&self, path: &str) -> AppResult<PathBuf> {
        crate::fsgrant::authorise(path, &self.grants, self.project_folder().as_deref())
    }

    pub fn clouds_dir(&self) -> AppResult<PathBuf> {
        let guard = self.current.lock();
        let proj = guard
            .as_ref()
            .ok_or_else(|| AppError::msg("No project open — create or open a project first"))?;
        let dir = proj.folder.join(CLOUDS_DIR);
        if !dir.exists() {
            fs::create_dir_all(&dir)?;
        }
        Ok(dir)
    }
}

/// Wipes -wal / -shm / -journal sidecar files before opening the DB so that
/// stale locks from a previous crash don't surface as "database is locked".
fn clear_stale_locks(folder: &std::path::Path) {
    for suffix in ["-wal", "-shm", "-journal"] {
        let p = folder.join(format!("{DB_FILE}{suffix}"));
        let _ = fs::remove_file(p);
    }
}

pub fn open_db(folder: &std::path::Path) -> AppResult<Connection> {
    clear_stale_locks(folder);
    let db_path = folder.join(DB_FILE);
    let conn = Connection::open(&db_path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = MEMORY; \
         PRAGMA foreign_keys = ON;",
    )?;
    // Tables first, migrations second, indexes last. The order matters: an
    // index can only be created once every column it names exists, and two
    // of them name columns that a migration adds. Creating them alongside
    // the tables made opening a v1 project fail outright — see
    // SCHEMA_INDEXES_SQL.
    conn.execute_batch(SCHEMA_TABLES_SQL)?;

    // Read the persisted version. None → brand new project, insert the
    // current SCHEMA_VERSION row. Some(v) → run any needed migrations
    // forward to SCHEMA_VERSION. CREATE TABLE IF NOT EXISTS in
    // SCHEMA_TABLES_SQL covered new tables; ALTER passes inside the
    // per-version migrations fill in new columns that existing tables
    // wouldn't pick up.
    let existing: Option<String> = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'",
            [],
            |r| r.get(0),
        )
        .ok();
    match existing {
        None => {
            conn.execute(
                "INSERT INTO schema_meta(key, value) VALUES (?, ?)",
                rusqlite::params!["schema_version", SCHEMA_VERSION.to_string()],
            )?;
        }
        Some(v) => {
            let current: u32 = v.parse().unwrap_or(1);
            if current < 2 {
                migrate_v1_to_v2(&conn).ctx("migrate v1 → v2")?;
            }
            if current < 3 {
                migrate_v2_to_v3(&conn).ctx("migrate v2 → v3")?;
            }
            if current < SCHEMA_VERSION {
                conn.execute(
                    "UPDATE schema_meta SET value = ? WHERE key = 'schema_version'",
                    rusqlite::params![SCHEMA_VERSION.to_string()],
                )?;
            }
        }
    }

    conn.execute_batch(SCHEMA_INDEXES_SQL)?;
    Ok(conn)
}
