// PointCloudLabeler — Point-cloud tree labelling, forest inventory and biomass from terrestrial and mobile laser scans
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

pub mod app_id;
pub mod memtrack;
pub mod state;
pub mod db;
pub mod fsgrant;
pub mod sysmem;
pub mod commands;
pub mod error;
mod crash;
mod menu;

/// Measure what this process holds, because four crashes were
/// diagnosed from estimates and each estimate was wrong. See
/// memtrack.rs: allocations of 64 KiB and up are counted, everything
/// smaller costs one comparison.
#[global_allocator]
static ALLOCATOR: memtrack::Tracking = memtrack::Tracking;

use commands::{
    cancel, cloud, coregister, crs, e57, file, geodata, geoid, layers, nadgrid, octree, project,
    ptx, recent, riegl, settings, xyz,
};
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Install the panic hook before anything else so failures during Tauri
    // bring-up also get logged.
    crash::install_panic_hook();

    // GPU preference flags for WebView2 on Windows so the discrete (NVIDIA /
    // AMD) GPU is preferred over integrated graphics for WebGL.
    #[cfg(target_os = "windows")]
    {
        let existing = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let extra = "--force_high_performance_gpu --ignore-gpu-blocklist \
                     --enable-gpu-rasterization --enable-zero-copy \
                     --enable-features=Vulkan,UseSkiaRenderer";
        let combined = if existing.is_empty() {
            extra.to_string()
        } else {
            format!("{existing} {extra}")
        };
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", combined);
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(AppState::default())
        .setup(|app| {
            // Build the native menu once at startup. project:* commands rebuild
            // it whenever state changes so File/Recent stay in sync.
            menu::apply(&app.handle().clone());
            // Hear about the renderer process dying under the page —
            // the one failure the page cannot report itself. See crash.rs.
            if let Some(main) = tauri::Manager::get_webview_window(app, "main") {
                crash::watch_webview(&main);
                // …and what every process holds, over time, to memory.log.
                crash::start_memory_watch(main.clone());
            }
            // Re-apply the geodetic data folder (NTv2 datum-shift grids) from
            // the settings file before anything can transform a coordinate. The
            // renderer owns that key and would otherwise only push it after it
            // mounts, which is after the first CRS lookup a restored session
            // makes — and a `+nadgrids=` CRS that fails once is cached as
            // failed by the panel that asked.
            if let Ok(settings) = settings::settings_load() {
                geodata::apply_persisted_dir(&settings);
            }
            Ok(())
        })
        .on_menu_event(|app, event| menu::handle_event(app, event))
        .invoke_handler(tauri::generate_handler![
            // file dialogs — in Rust so the grant registry learns what
            // the user chose; see fsgrant.rs
            file::dialog_pick_file,
            file::dialog_pick_folder,
            file::dialog_save_file,
            // message boxes — the plugin's window.confirm stand-in calls
            // a command the plugin does not have; see file.rs
            file::dialog_confirm,
            file::dialog_message,
            // file
            file::file_read,
            file::file_read_chunk,
            file::file_stat,
            file::file_write,
            file::file_write_bytes,
            // recent files (separate from recent projects)
            recent::recent_add,
            recent::recent_get,
            recent::recent_clear,
            // project lifecycle
            project::project_current,
            project::project_create,
            project::project_open,
            project::project_close,
            project::project_save_meta,
            project::project_recent,
            project::project_remove_recent,
            // cloud io
            cloud::cloud_write_open,
            cloud::file_write_open,
            cloud::cloud_write_append,
            cloud::cloud_write_append_raw,
            cloud::cloud_write_commit,
            cloud::cloud_write_abort,
            cloud::cloud_read_open,
            cloud::cloud_read_chunk,
            cloud::cloud_read_close,
            cloud::cloud_list,
            cloud::cloud_delete,
            cloud::cloud_rename,
            // out-of-core LAZ → octree converter + reader
            octree::cloud_import_octree,
            octree::octree_list,
            octree::octree_read_meta,
            octree::octree_read_block,
            octree::octree_read_block_columns,
            octree::octree_remove_dataset,
            octree::octree_read_patches,
            octree::octree_write_patches,
            octree::octree_write_patches_begin,
            octree::octree_write_patches_chunk,
            octree::octree_write_patches_commit,
            octree::octree_bake_patches,
            octree::cloud_export_octree_las,
            octree::octree_tree_summary,
            octree::octree_intensity_range,
            octree::octree_set_crs,
            octree::octree_set_vertical_crs,
            octree::octree_dataset_fingerprint,
            octree::octree_read_treemap,
            octree::octree_write_treemap,
            octree::octree_read_review,
            octree::octree_write_review,
            octree::octree_read_species,
            octree::octree_write_species,
            octree::octree_read_plot,
            octree::octree_write_plot,
            octree::octree_classify_ground,
            octree::octree_ground_reference,
            octree::octree_dtm_grid,
            octree::octree_reset_classification,
            octree::octree_reset_attribute,
            octree::octree_subset,
            octree::octree_merge_clouds,
            octree::octree_filter_outliers,
            octree::octree_voxel_downsample,
            octree::octree_density_metrics,
            octree::octree_virtual_caliper,
            octree::octree_scan_inspection,
            octree::octree_click_to_measure_tree,
            octree::octree_stem_taper,
            octree::octree_stem_centerlines,
            octree::octree_skeleton_transfer,
            octree::octree_skeleton_align,
            octree::octree_skeleton_alignment_read,
            octree::octree_skeleton_alignment_clear,
            octree::octree_shift_georeference,
            octree::octree_build_skeletons,
            octree::octree_read_skeletons,
            octree::octree_skeleton_info,
            cancel::octree_cancel,
            layers::octree_layers_list,
            layers::octree_layer_prepare,
            layers::octree_layer_delete,
            cancel::octree_stage_running,
            // crash log: what the renderer reports about itself, and
            // what WebView2 reported about the renderer
            crash::crash_log,
            crash::crash_log_location,
            crash::renderer_last_failure,
            octree::octree_clear_skeletons,
            octree::octree_export_skeletons,
            octree::octree_realign_to_source,
            coregister::coregister_extract_planes,
            coregister::coregister_detect_spheres,
            coregister::coregister_msa,
            coregister::coregister_match_spheres,
            coregister::coregister_match_planes,
            octree::octree_normalize,
            octree::octree_point_qc,
            octree::octree_remove_extra,
            octree::octree_add_deadwood_columns,
            octree::octree_terrain,
            octree::octree_segment_chm,
            octree::octree_tree_isolation,
            octree::octree_segment_li2012,
            octree::octree_m3c2,
            octree::octree_segment_deadwood,
            octree::octree_leaf_wood,
            octree::octree_tree_metrics,
            octree::octree_fit_stems,
            octree::octree_read_stems,
            octree::octree_tree_qsm,
            octree::octree_read_qsm,
            // Riegl preprocessing (.RiSCAN / .RiPROJECT — XML metadata
            // only for now; point export needs user-installed rdblib).
            riegl::riegl_list_projects,
            riegl::riegl_import_project,
            riegl::riegl_remove_project,
            riegl::riegl_export_region,
            riegl::riegl_capabilities,
            // E57 preprocessing (ASTM E2807 — pure Rust, no SDK
            // needed). Covers FARO / Leica / Trimble / NavVis / Emesent
            // / XGRIDS / GreenValley via their export paths.
            e57::e57_list_projects,
            e57::e57_import_project,
            e57::e57_remove_project,
            e57::e57_export_region,
            // PTX / PTS preprocessing (Leica Cyclone ASCII format).
            // Pure-Rust ASCII parser; covers Cyclone, Topcon MAGNET
            // Collage, 3D Forest interop, Stonex round-trip.
            ptx::ptx_list_projects,
            ptx::ptx_import_project,
            ptx::ptx_remove_project,
            ptx::ptx_export_region,
            // Generic ASCII (XYZ / CSV / TXT) preprocessing — the
            // safety net for one-off datasets. Sniffs delimiter +
            // header, lets the user map columns to roles, converts
            // to LAS / LAZ.
            xyz::xyz_list_projects,
            xyz::xyz_import_project,
            xyz::xyz_set_mapping,
            xyz::xyz_remove_project,
            xyz::xyz_export,
            // Co-registration: align scan positions across the
            // imported preprocessing projects. Pure-Rust 3×3 SVD,
            // Kabsch fit on tie points; updates the manifest in
            // place (originals untouched).
            coregister::coregister_list_scans,
            coregister::coregister_solve,
            coregister::coregister_apply,
            coregister::coregister_apply_delta,
            coregister::coregister_icp,
            // Coordinate Reference System support (part 1 of 2 — record
            // + convert; reprojecting a full export is octree::cloud_export_octree_las's
            // target_crs option, part 2 — see that command's own group above).
            crs::crs_list,
            crs::crs_transform,
            crs::crs_lookup,
            crs::crs_search,
            // NTv2 datum-shift grids: the user supplies the .gsb files
            // (national data products PointCloudLabeler cannot redistribute), PointCloudLabeler
            // finds and uses them — see commands/nadgrid.rs.
            nadgrid::nadgrid_status,
            nadgrid::nadgrid_set_dir,
            // Geoid undulation grids (.gtx): reader + bilinear
            // interpolator for N, the ellipsoidal/orthometric height
            // difference (H = h - N). Same shared geodetic data folder
            // as the .gsb grids above — see commands/geoid.rs.
            geoid::geoid_status,
            geoid::geoid_undulation,
            // user settings (~/.config/<bundle identifier>/settings.json —
            // see app_id.rs)
            settings::settings_load,
            settings::settings_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
