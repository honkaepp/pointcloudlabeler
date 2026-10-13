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

//! The surfaces that run PointCloudLabeler without its window: the
//! command line, batch recipes, the console interface, the HTTP API and
//! the MCP server. All of them drive the operation catalogue
//! (`crate::ops`); none of them knows a pass by name. They are built
//! only into the headless binary — each behind its Cargo feature — so
//! the desktop application carries none of this.

#[cfg(feature = "cli")]
pub mod cli;
#[cfg(feature = "cli")]
pub mod docs;
#[cfg(feature = "cli")]
pub mod recipe;
#[cfg(feature = "cli")]
pub mod schema;
#[cfg(feature = "tui")]
pub mod tui;
#[cfg(feature = "mcp")]
pub mod mcp;
#[cfg(feature = "api")]
pub mod api;

/// The extra subcommands the optional surfaces add to the command line:
/// the console (`tui`), the API server (`serve`), the MCP server (`mcp`).
/// Each exists only with its feature; with none of them the command line
/// is the catalogue alone.
#[cfg(feature = "cli")]
pub fn surfaces(root: clap::Command) -> clap::Command {
    #[allow(unused_mut)]
    let mut root = root;
    #[cfg(feature = "tui")]
    {
        root = root.subcommand(clap::Command::new("tui").about("The console interface: browse a project, run operations, review trees — in a terminal"));
    }
    #[cfg(feature = "mcp")]
    {
        root = root.subcommand(clap::Command::new("mcp").about("Serve the catalogue as Model Context Protocol tools over stdio, for an MCP client to spawn"));
    }
    #[cfg(feature = "api")]
    {
        root = root.subcommand(api::command());
    }
    root
}

/// Whether `name` is one of the surface subcommands this build carries.
#[cfg(feature = "cli")]
pub fn is_surface(name: &str) -> bool {
    SURFACES.contains(&name)
}

#[cfg(feature = "cli")]
const SURFACES: &[&str] = &[
    #[cfg(feature = "tui")]
    "tui",
    #[cfg(feature = "mcp")]
    "mcp",
    #[cfg(feature = "api")]
    "serve",
];

/// Run a surface subcommand.
#[cfg(feature = "cli")]
pub fn run_surface(name: &str, _m: &clap::ArgMatches, _ctx: &crate::ops::OpContext) -> Result<(), String> {
    match name {
        #[cfg(feature = "tui")]
        "tui" => tui::run(_ctx),
        #[cfg(feature = "mcp")]
        "mcp" => mcp::serve_stdio(_ctx),
        #[cfg(feature = "api")]
        "serve" => api::run(_m),
        other => Err(format!("this build has no '{other}' surface")),
    }
}
