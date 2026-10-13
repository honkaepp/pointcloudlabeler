// PointCloudLabeler — Tree segmentation, editing and label transfer for close-range forest point clouds
// Copyright (C) 2026 Eppu Honkanen
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

//! The one runtime call the command wrappers make.
//!
//! Every long command is `async fn` and hands its work to
//! `spawn_blocking`, so the GUI's IPC thread is never the one streaming
//! a dataset. With the `gui` feature that is Tauri's own runtime. Without
//! it there is no runtime to hand work to and no IPC thread to protect:
//! the headless surfaces call the synchronous `run_*` functions directly
//! and never await these wrappers — but the wrappers still have to
//! compile, so the shim below runs the closure inline. Same signature,
//! same `Result`, so `.await.map_err(|e| format!("join error: {e}"))`
//! reads the same either way.

#[cfg(feature = "gui")]
pub use tauri::async_runtime::spawn_blocking;

/// What a blocking task's join reports when there is no runtime: nothing
/// can fail to join a closure that already ran, so this is never
/// constructed. It exists to give the inline shim the same `Result` shape
/// as the runtime's.
#[cfg(not(feature = "gui"))]
#[derive(Debug)]
pub struct JoinError(());

#[cfg(not(feature = "gui"))]
impl std::fmt::Display for JoinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("blocking task did not complete")
    }
}

#[cfg(not(feature = "gui"))]
impl std::error::Error for JoinError {}

/// Run `f` now, on this thread, and report it as joined.
#[cfg(not(feature = "gui"))]
pub async fn spawn_blocking<F, R>(f: F) -> Result<R, JoinError>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    Ok(f())
}
