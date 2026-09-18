//! Native application menu. Every click emits ONE `menu` event whose
//! payload names the item (`action`, the id given below) and, for a
//! recent project, its folder. The desktop bridge forwards it to the
//! renderer as `menu:<action>`; App.tsx handles the three project items
//! and EditorShell the rest (shell/menuActions.ts), through the same
//! dispatch the keyboard and the command palette use. menuActions.test.ts
//! holds the ids here and that table to each other, so an item cannot be
//! added on one side and do nothing on the other — which is what every
//! Edit, View, Tools and Help item did before.
//!
//! Accelerators are set only on the two Project items. Every other item
//! is also a customisable keybinding of the renderer (state/keybindings.ts),
//! which handles the chord itself; an accelerator here as well would
//! either take the key before the page saw it or fire the action a second
//! time, depending on how the platform routes it.

use serde::Serialize;
use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuBuilder, MenuEvent, MenuItem, MenuItemBuilder,
    PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::commands::project::load_recent_public;
use crate::error::AppResult;
use crate::state::AppState;

const RECENT_PROJECT_PREFIX: &str = "recent-proj::";

fn has_project<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.state::<AppState>().current.lock().is_some()
}

fn item<R: Runtime>(app: &AppHandle<R>, label: &str, id: &str) -> tauri::Result<MenuItem<R>> {
    MenuItemBuilder::new(label).id(id).build(app)
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> AppResult<Menu<R>> {
    let has_proj = has_project(app);
    let recent = load_recent_public(app);

    // ---- File ---- (needs an open project; rebuilt by the project
    // commands, so these enable the moment one is opened)
    let open_cloud = MenuItemBuilder::new("Add Cloud…")
        .id("open-cloud")
        .enabled(has_proj)
        .build(app)?;
    let save = MenuItemBuilder::new("Save")
        .id("save")
        .enabled(has_proj)
        .build(app)?;
    let export = MenuItemBuilder::new("Export…")
        .id("export")
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

    // ---- Edit ---- (the editing actions of state/keybindings.ts, by the
    // names the command palette gives them; "reset" and "assign" follow
    // the active colour mode as they do there)
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&item(app, "Undo", "undo")?)
        .item(&item(app, "Redo", "redo")?)
        .separator()
        .item(&item(app, "Clear Selection", "clear-selection")?)
        .item(&item(app, "New Tree Id", "new-tree")?)
        .separator()
        .item(&item(app, "Assign Active Id to Selection", "assign")?)
        .item(&item(app, "Reset Selection to 0", "reset-id-0")?)
        .separator()
        .item(&item(app, "Delete Points", "delete-points")?)
        .item(&item(app, "Restore Deleted Points", "restore-points")?)
        .build()?;

    // ---- View ---- (camera presets, lighting, the everyday panels, and
    // the palette that reaches everything else)
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&item(app, "Top View", "view-top")?)
        .item(&item(app, "Front View", "view-front")?)
        .item(&item(app, "Side View", "view-side")?)
        .separator()
        .item(&item(app, "Toggle Eye-Dome Lighting", "view-edl")?)
        .separator()
        .item(&item(app, "Tools Panel", "panel-tools")?)
        .item(&item(app, "Display Panel", "panel-display")?)
        .item(&item(app, "Filters Panel", "panel-filters")?)
        .item(&item(app, "Layers Panel", "panel-layers")?)
        .item(&item(app, "History Panel", "panel-history")?)
        .separator()
        .item(&item(app, "Command Palette…", "palette")?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;

    // ---- Tools ---- (the analysis panels of the activity bar, in the
    // order a plot is worked: terrain, trees, review, then the two-cloud
    // tools, then what leaves the program)
    let tools_menu = SubmenuBuilder::new(app, "Tools")
        .item(&item(app, "Terrain…", "panel-ground")?)
        .item(&item(app, "Auto-segment Trees…", "panel-segment")?)
        .item(&item(app, "Tree Review…", "panel-review")?)
        .item(&item(app, "QC — Flag Suspect Trees…", "panel-qc")?)
        .item(&item(app, "Point QC…", "panel-pointqc")?)
        .separator()
        .item(&item(app, "Tree Skeleton Transfer…", "panel-tst")?)
        .item(&item(app, "Cloud Registration…", "panel-register")?)
        .item(&item(app, "Tree Growth…", "panel-growth")?)
        .item(&item(app, "M3C2 Change Detection…", "panel-m3c2")?)
        .separator()
        .item(&item(app, "Subset / Extract…", "panel-subset")?)
        .item(&item(app, "Report…", "panel-report")?)
        .build()?;

    // ---- Help ----
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
            "Tree segmentation, editing and label transfer for close-range forest point clouds.\n\n",
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
        .item(&item(app, "Keyboard Shortcuts", "shortcuts")?)
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

/// What one click sends the renderer: the item's id as `action`, and for
/// a recent-project entry the folder to open (the entry's id carries it
/// behind RECENT_PROJECT_PREFIX; the action is then the plain
/// `project-open`, so the renderer has one handler for both ways of
/// opening a project).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct MenuClick {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
}

pub fn click_for_id(id: &str) -> MenuClick {
    match id.strip_prefix(RECENT_PROJECT_PREFIX) {
        Some(folder) => MenuClick { action: "project-open".to_string(), folder: Some(folder.to_string()) },
        None => MenuClick { action: id.to_string(), folder: None },
    }
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    // Every id goes through, the predefined items' included: the renderer
    // ignores what it does not know, and a fixed list here was how the
    // menu came to have items that did nothing.
    let _ = app.emit("menu", click_for_id(event.id().as_ref()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_item_sends_its_id_and_nothing_else() {
        let click = click_for_id("undo");
        assert_eq!(click, MenuClick { action: "undo".into(), folder: None });
        assert_eq!(serde_json::to_string(&click).unwrap(), r#"{"action":"undo"}"#);
    }

    #[test]
    fn a_recent_project_sends_project_open_with_its_folder() {
        let click = click_for_id(r"recent-proj::C:\Plots\Evo 1001");
        assert_eq!(click.action, "project-open");
        assert_eq!(click.folder.as_deref(), Some(r"C:\Plots\Evo 1001"));
    }
}
