import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';
import { MENU_TARGETS, APP_MENU_IDS, menuTarget } from './menuActions';

const read = (p: string) => stripComments(readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8'));
const menuRs = read('src-tauri/src/menu.rs');

/** The ids the native menu gives its clickable items: every `.id("…")`
 *  and every `item(app, "…", "…")`, less the disabled placeholder of an
 *  empty Recent list. */
function nativeMenuIds(): string[] {
  const ids = new Set<string>();
  for (const m of menuRs.matchAll(/\.id\("([a-z0-9-]+)"\)/g)) ids.add(m[1]);
  for (const m of menuRs.matchAll(/item\(app, "[^"]+", "([a-z0-9-]+)"\)/g)) ids.add(m[1]);
  ids.delete('recent-none');
  return [...ids].sort();
}

/** Every File, Project, Edit, View, Tools and Help item used to emit an
 *  event nothing listened to, or none at all: the bridge forwarded a fixed
 *  list of per-item events and the renderer handled four of them. These
 *  pins hold the menu to its handlers on both sides. */
describe('the native menu', () => {
  it('has a handler for every clickable item', () => {
    const unhandled = nativeMenuIds().filter((id) => !(id in MENU_TARGETS) && !APP_MENU_IDS.includes(id));
    expect(unhandled, 'menu items that would do nothing when clicked').toEqual([]);
  });

  it('has an item for every handler', () => {
    const ids = new Set(nativeMenuIds());
    const dead = Object.keys(MENU_TARGETS).filter((id) => !ids.has(id));
    expect(dead, 'handlers for items the menu does not have').toEqual([]);
    for (const id of APP_MENU_IDS) expect(ids.has(id), `App handles ${id} but the menu has no such item`).toBe(true);
  });

  it('sends one event per click, which the bridge forwards as menu:<id>', () => {
    expect(menuRs).toMatch(/app\.emit\("menu", click_for_id\(/);
    expect(menuRs, 'a per-item match table is how items came to do nothing').not.toMatch(/=> Some\("menu:/);
    const bridge = read('src/persistence/desktopBridge.ts');
    expect(bridge).toMatch(/ctx\.listen<\{ action: string; folder\?: string \}>\('menu'/);
    expect(bridge).toMatch(/cb\(`menu:\$\{e\.payload\.action\}`, e\.payload\.folder\)/);
    expect(bridge, 'the fixed event list is back').not.toMatch(/TAURI_EVENTS/);
  });

  it('is dispatched by the editor shell through the same code as the keyboard', () => {
    const shell = read('src/components/shell/EditorShell.tsx');
    expect(shell).toMatch(/const target = menuTarget\(action\);/);
    expect(shell).toMatch(/if \(target\.kind === 'action'\) runActionRef\.current\(target\.id\);/);
    expect(shell).toMatch(/else togglePanelRef\.current\(target\.id\);/);
    // …and by nothing else, or Add Cloud… would import twice.
    expect(read('src/modules/EditorModule.tsx')).not.toMatch(/onMenuAction/);
  });

  it('leaves the keyboard to the renderer: accelerators only on the Project items', () => {
    const accelerators = [...menuRs.matchAll(/\.accelerator\("([^"]+)"\)/g)].map((m) => m[1]).sort();
    expect(accelerators).toEqual(['CmdOrCtrl+Shift+N', 'CmdOrCtrl+Shift+O']);
  });

  it('opens New Project… while a project is open as well as from the welcome screen', () => {
    const app = read('src/App.tsx');
    expect(app.match(/<NewProjectDialog/g)?.length).toBe(2);
    expect(app).toMatch(/case 'menu:project-new':\s*setShowNewProject\(true\);/);
  });

  it('maps a bridge event to its target and ignores the rest', () => {
    expect(menuTarget('menu:undo')).toEqual({ kind: 'action', id: 'edit.undo' });
    expect(menuTarget('menu:open-cloud')).toEqual({ kind: 'action', id: 'file.import' });
    expect(menuTarget('menu:panel-filters')).toEqual({ kind: 'panel', id: 'filters' });
    expect(menuTarget('menu:shortcuts')).toEqual({ kind: 'panel', id: 'keys' });
    expect(menuTarget('menu:project-new')).toBeNull();
    expect(menuTarget('menu:open-file')).toBeNull();
    expect(menuTarget('project:changed')).toBeNull();
    expect(menuTarget('undo')).toBeNull();
  });
});
