//! Native application menu. Each click emits a `menu:<action>` event the
//! renderer listens to via the desktop bridge (`window.desktop.onMenuAction`);
//! App.tsx's onMenuAction switch then dispatches based on the action string.

use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, PredefinedMenuItem,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::project::load_recent_public;
use crate::error::AppResult;
use crate::state::AppState;

const RECENT_PROJECT_PREFIX: &str = "recent-proj::";

fn has_project<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<AppState>().current.lock().is_some()
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> AppResult<Menu<R>> {
    let has_proj = has_project(app);
    let recent = load_recent_public(app);

    // ---- File ----
    // Per §9.2 a new import appends to the project rather than replacing
    // the previously-open cloud; the label reflects that. The underlying
    // menu id and event name stay 'open-cloud' / 'menu:open-cloud' so
    // existing handlers don't need to change.
    let open_cloud = MenuItemBuilder::new("Add Cloud…")
        .id("open-cloud")
        .accelerator("CmdOrCtrl+O")
        .enabled(has_proj)
        .build(app)?;
    let save = MenuItemBuilder::new("Save")
        .id("save")
        .accelerator("CmdOrCtrl+S")
        .enabled(has_proj)
        .build(app)?;
    let export = MenuItemBuilder::new("Export…")
        .id("export")
        .accelerator("CmdOrCtrl+E")
        .enabled(has_proj)
        .build(app)?;
    let close_project = MenuItemBuilder::new("Close Project")
        .id("project-close")
        .enabled(has_proj)
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_cloud)
        .separator()
        .item(&save)
        .item(&export)
        .separator()
        .item(&close_project)
        .separator()
        .quit()
        .build()?;

    // ---- Project ----
    let new_project = MenuItemBuilder::new("New Project…")
        .id("project-new")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let open_project = MenuItemBuilder::new("Open Project…")
        .id("project-open")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;

    let recent_submenu = {
        let mut builder = SubmenuBuilder::new(app, "Recent Projects");
        if recent.is_empty() {
            let empty = MenuItemBuilder::new("(none)").id("recent-none").enabled(false).build(app)?;
            builder = builder.item(&empty);
        } else {
            for proj in recent.iter().take(8) {
                let id = format!("{RECENT_PROJECT_PREFIX}{}", proj.folder);
                let label = if proj.exists {
                    proj.name.clone()
                } else {
                    format!("{} (missing)", proj.name)
                };
                let item = MenuItemBuilder::new(label)
                    .id(id)
                    .enabled(proj.exists)
                    .build(app)?;
                builder = builder.item(&item);
            }
        }
        builder.build()?
    };

    let project_menu = SubmenuBuilder::new(app, "Project")
        .item(&new_project)
        .item(&open_project)
        .item(&recent_submenu)
        .build()?;

    // ---- Edit ----
    let undo = MenuItemBuilder::new("Undo")
        .id("undo")
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;
    let redo = MenuItemBuilder::new("Redo")
        .id("redo")
        .accelerator("CmdOrCtrl+Shift+Z")
        .build(app)?;
    let invert = MenuItemBuilder::new("Invert Selection")
        .id("invert-selection")
        .accelerator("I")
        .build(app)?;
    let clear_sel = MenuItemBuilder::new("Clear Selection")
        .id("clear-selection")
        .accelerator("Escape")
        .build(app)?;
    let delete_pts = MenuItemBuilder::new("Delete Points")
        .id("delete-points")
        .accelerator("Delete")
        .build(app)?;
    // Destructive action: unassigns tree_id on selected points. Moved off the
    // left tools panel into Edit so it isn't a foot-gun next to the
    // routine selection tools (§8A). Undo works.
    let reset_id_0 = MenuItemBuilder::new("Reset Selection to id 0 (unclassified)")
        .id("reset-id-0")
        .build(app)?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .item(&invert)
        .item(&clear_sel)
        .separator()
        .item(&reset_id_0)
        .item(&delete_pts)
        .build()?;

    // ---- View ----
    let toggle_legend = MenuItemBuilder::new("Toggle Legend")
        .id("toggle-legend")
        .accelerator("CmdOrCtrl+L")
        .build(app)?;
    let toggle_filters = MenuItemBuilder::new("Toggle Filters")
        .id("toggle-filters")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&toggle_legend)
        .item(&toggle_filters)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    // ---- Tools ---- (auto-segment + stem classifier surfaced in the menu
    // so they're discoverable beyond the left-tools rail).
    let auto_segment = MenuItemBuilder::new("Auto-segment trees")
        .id("auto-segment")
        .build(app)?;
    let classify_stem = MenuItemBuilder::new("Classify stem points")
        .id("classify-stem")
        .build(app)?;
    let reset_stem = MenuItemBuilder::new("Clear stem classification")
        .id("reset-stem")
        .build(app)?;

    let tools_menu = SubmenuBuilder::new(app, "Tools")
        .item(&auto_segment)
        .item(&classify_stem)
        .separator()
        .item(&reset_stem)
        .build()?;

    // ---- Help ----
    let shortcuts = MenuItemBuilder::new("Keyboard Shortcuts")
        .id("shortcuts")
        .build(app)?;
    // Help → About is where a user looks for who made this and under
    // what terms, and it is the only place in the running application
    // that can answer. Every field here comes from the crate manifest
    // or from a constant that the licence tests hold to the LICENSE
    // file, so the dialog cannot drift from what the repository says.
    //
    // Under the GPL this dialog is also a licence obligation, not only
    // good manners. GPL-3 §5(d) requires an interactive work to carry
    // "Appropriate Legal Notices", and §0 defines that as a convenient
    // and prominently visible feature displaying FOUR things: the
    // copyright notice, that there is no warranty, that licensees may
    // convey the work under this Licence, and how to view a copy of
    // the Licence. Apache-2.0 asked for none of this — the notice
    // requirement there travelled with the files, not with the running
    // program — so all four are spelled out below and asserted by
    // src/testing/notices.test.ts.
    let about_meta = AboutMetadataBuilder::new()
        .name(Some("PointCloudLabeler"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .authors(Some(vec![env!("CARGO_PKG_AUTHORS").to_string()]))
        .copyright(Some("© 2026 Eppu Honkanen"))
        .license(Some("GPL-3.0-or-later"))
        .website(Some(env!("CARGO_PKG_REPOSITORY")))
        .website_label(Some("Source code"))
        .comments(Some(concat!(
            "Point-cloud tree labelling, forest inventory and biomass from terrestrial and mobile laser scans.\n\n",
            "This program comes with ABSOLUTELY NO WARRANTY. It is free ",
            "software, and you are welcome to redistribute it under the ",
            "terms of the GNU General Public License, version 3 or later. ",
            "The full licence is installed beside the program as LICENSE, ",
            "and is also at https://www.gnu.org/licenses/gpl-3.0.html\n\n",
            "Source code for this exact version is at the address above.\n",
            "Documentation is CC BY 4.0. Third-party components keep their ",
            "own licences — see THIRD-PARTY-NOTICES.md.",
        )))
        .build();
    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&shortcuts)
        .separator()
        .item(&PredefinedMenuItem::about(app, Some("About"), Some(about_meta))?)
        .build()?;

    MenuBuilder::new(app)
        .item(&file_menu)
        .item(&project_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&tools_menu)
        .item(&help_menu)
        .build()
        .map_err(|e| crate::error::AppError::msg(format!("menu build: {e}")))
}

pub fn apply<R: Runtime>(app: &AppHandle<R>) {
    match build(app) {
        Ok(menu) => {
            if let Err(e) = app.set_menu(menu) {
                eprintln!("set_menu failed: {e}");
            }
        }
        Err(e) => eprintln!("menu build failed: {e}"),
    }
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref().to_string();

    // Recent project click → emit menu:project-open with the folder as payload.
    if let Some(folder) = id.strip_prefix(RECENT_PROJECT_PREFIX) {
        let _ = app.emit("menu:project-open", folder.to_string());
        return;
    }

    // Map every static id to its menu:* event. The renderer (App.tsx) already
    // routes these to the right handler.
    let event_name = match id.as_str() {
        "open-cloud" => Some("menu:open-cloud"),
        "save" => Some("menu:save"),
        "export" => Some("menu:export"),
        "project-close" => Some("menu:project-close"),
        "project-new" => Some("menu:project-new"),
        "project-open" => Some("menu:project-open"),
        "undo" => Some("menu:undo"),
        "redo" => Some("menu:redo"),
        "invert-selection" => Some("menu:invert-selection"),
        "clear-selection" => Some("menu:clear-selection"),
        "delete-points" => Some("menu:delete-points"),
        "reset-id-0" => Some("menu:reset-id-0"),
        "toggle-legend" => Some("menu:toggle-legend"),
        "toggle-filters" => Some("menu:toggle-filters"),
        "auto-segment" => Some("menu:auto-segment"),
        "classify-stem" => Some("menu:classify-stem"),
        "reset-stem" => Some("menu:reset-stem"),
        "shortcuts" => Some("menu:shortcuts"),
        _ => None,
    };
    if let Some(name) = event_name {
        let _ = app.emit(name, ());
    }
}
