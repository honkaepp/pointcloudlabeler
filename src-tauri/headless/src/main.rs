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

//! PointCloudLabeler without its window. Everything is in the library's
//! `headless` module; this is the process boundary: the panic hook and
//! the exit status.
//!
//! Its own crate, beside the application's, rather than a second
//! binary of it: the installer bundles every binary of the application's
//! package, and a binary built with other features is not there to
//! bundle.

#[cfg(not(feature = "cli"))]
compile_error!("the headless binary needs at least the `cli` feature (the default `headless` has every surface)");

fn main() {
    pointcloudlabeler_editor_lib::crash::install_panic_hook();
    std::process::exit(pointcloudlabeler_editor_lib::headless::cli::main());
}
