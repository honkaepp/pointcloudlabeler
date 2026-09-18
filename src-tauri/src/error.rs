use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{context}: {source}")]
    Io {
        context: String,
        #[source]
        source: std::io::Error,
    },

    #[error("{context}: {source}")]
    Sql {
        context: String,
        #[source]
        source: rusqlite::Error,
    },

    #[error("{context}: {source}")]
    Json {
        context: String,
        #[source]
        source: serde_json::Error,
    },

    #[error("{0}")]
    Tauri(#[from] tauri::Error),

    #[error("not found: {entity} '{id}'")]
    NotFound { entity: String, id: String },

    #[error("invalid argument '{field}': {reason}")]
    InvalidArgument { field: String, reason: String },

    #[error("invalid state: {0}")]
    InvalidState(String),

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("{0}")]
    Other(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Io { .. } => "Io",
            AppError::Sql { .. } => "Sql",
            AppError::Json { .. } => "Json",
            AppError::Tauri(_) => "Tauri",
            AppError::NotFound { .. } => "NotFound",
            AppError::InvalidArgument { .. } => "InvalidArgument",
            AppError::InvalidState(_) => "InvalidState",
            AppError::Conflict(_) => "Conflict",
            AppError::Other(_) => "Other",
        }
    }

    pub fn retryable(&self) -> bool {
        // Conservative default — the renderer can offer "retry" for transient
        // I/O and Tauri-layer failures but not for invalid arguments / state.
        matches!(self, AppError::Io { .. } | AppError::Tauri(_))
    }

    pub fn msg<S: Into<String>>(s: S) -> Self {
        AppError::Other(s.into())
    }

    pub fn not_found<E: Into<String>, I: Into<String>>(entity: E, id: I) -> Self {
        AppError::NotFound {
            entity: entity.into(),
            id: id.into(),
        }
    }

    pub fn invalid_arg<F: Into<String>, R: Into<String>>(field: F, reason: R) -> Self {
        AppError::InvalidArgument {
            field: field.into(),
            reason: reason.into(),
        }
    }

    pub fn invalid_state<S: Into<String>>(s: S) -> Self {
        AppError::InvalidState(s.into())
    }

    pub fn conflict<S: Into<String>>(s: S) -> Self {
        AppError::Conflict(s.into())
    }
}

// Bare-`?` interop with std error types — picks an "uncategorized" context.
// Call sites that have a meaningful operation name should prefer `.ctx(...)`
// from `WithContext` below to attach it.
impl From<std::io::Error> for AppError {
    fn from(source: std::io::Error) -> Self {
        AppError::Io {
            context: "io".into(),
            source,
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(source: rusqlite::Error) -> Self {
        AppError::Sql {
            context: "sql".into(),
            source,
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(source: serde_json::Error) -> Self {
        AppError::Json {
            context: "json".into(),
            source,
        }
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Other(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Other(s.into())
    }
}

// Serialize to a JSON object so the renderer can branch on `code` and
// `retryable`. The `message` field stays human-readable so existing
// `(e as Error).message` reads keep working in JS.
impl Serialize for AppError {
    fn serialize<S>(&self, ser: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeMap;
        let mut m = ser.serialize_map(None)?;
        m.serialize_entry("code", self.code())?;
        m.serialize_entry("message", &self.to_string())?;
        m.serialize_entry("retryable", &self.retryable())?;
        match self {
            AppError::Io { context, .. }
            | AppError::Sql { context, .. }
            | AppError::Json { context, .. } => {
                m.serialize_entry("context", context)?;
            }
            AppError::NotFound { entity, id } => {
                m.serialize_entry("entity", entity)?;
                m.serialize_entry("id", id)?;
            }
            AppError::InvalidArgument { field, reason } => {
                m.serialize_entry("field", field)?;
                m.serialize_entry("reason", reason)?;
            }
            AppError::Tauri(_)
            | AppError::InvalidState(_)
            | AppError::Conflict(_)
            | AppError::Other(_) => {}
        }
        m.end()
    }
}

pub type AppResult<T> = std::result::Result<T, AppError>;

/// Attach a `context` string to a fallible operation so the error carries
/// "what was the call site trying to do" alongside the underlying cause.
///
/// ```ignore
/// let bytes = std::fs::read(&path).ctx("read project.json")?;
/// ```
pub trait WithContext<T> {
    fn ctx(self, context: &str) -> AppResult<T>;
}

impl<T> WithContext<T> for std::result::Result<T, std::io::Error> {
    fn ctx(self, context: &str) -> AppResult<T> {
        self.map_err(|source| AppError::Io {
            context: context.into(),
            source,
        })
    }
}

impl<T> WithContext<T> for std::result::Result<T, rusqlite::Error> {
    fn ctx(self, context: &str) -> AppResult<T> {
        self.map_err(|source| AppError::Sql {
            context: context.into(),
            source,
        })
    }
}

impl<T> WithContext<T> for std::result::Result<T, serde_json::Error> {
    fn ctx(self, context: &str) -> AppResult<T> {
        self.map_err(|source| AppError::Json {
            context: context.into(),
            source,
        })
    }
}

/// Pass-through impl so an `AppResult<T>` can also `.ctx("…")` —
/// useful for chaining a higher-level operation name onto an error
/// that already carries the lower-level context. For Io / Sql / Json
/// variants we prepend `"<new context>: "` to the existing context
/// string; opaque variants (NotFound, Conflict, …) get wrapped in an
/// `AppError::Other` carrying their Display string with the prefix.
impl<T> WithContext<T> for AppResult<T> {
    fn ctx(self, context: &str) -> AppResult<T> {
        self.map_err(|e| match e {
            AppError::Io { context: inner, source } => AppError::Io {
                context: format!("{context}: {inner}"),
                source,
            },
            AppError::Sql { context: inner, source } => AppError::Sql {
                context: format!("{context}: {inner}"),
                source,
            },
            AppError::Json { context: inner, source } => AppError::Json {
                context: format!("{context}: {inner}"),
                source,
            },
            other => AppError::Other(format!("{context}: {other}")),
        })
    }
}
