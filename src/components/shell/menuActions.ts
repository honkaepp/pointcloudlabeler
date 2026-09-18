// What each native-menu item does, by the id src-tauri/src/menu.rs gives
// it. A click arrives through the desktop bridge as `menu:<id>`; the id
// names either a keybinding action (dispatched by EditorShell's runAction,
// the same code the keyboard and the command palette run) or a panel to
// toggle. Nothing here runs anything itself: the menu is a third way to
// reach the commands the shell already has, and it cannot disagree with
// them because it only names them.
//
// The three ids the menu owns that are NOT here — project-new,
// project-open, project-close — are the application's, not the editor's,
// and App.tsx handles them. menuActions.test.ts holds this table and the
// Rust menu to each other: every clickable item has a target, and every
// target is an item.

import type { KeyActionId } from '../../state/keybindings';
import type { PanelId } from './OctreeShellContext';

export type MenuTarget =
  | { kind: 'action'; id: KeyActionId }
  | { kind: 'panel'; id: PanelId };

const action = (id: KeyActionId): MenuTarget => ({ kind: 'action', id });
const panel = (id: PanelId): MenuTarget => ({ kind: 'panel', id });

/** Menu item id → what it does. Keys are the `.id("…")` strings in menu.rs. */
export const MENU_TARGETS: Readonly<Record<string, MenuTarget>> = {
  // File
  'open-cloud': action('file.import'),
  'save': action('file.save'),
  'export': action('file.export'),
  // Edit
  'undo': action('edit.undo'),
  'redo': action('edit.redo'),
  'clear-selection': action('edit.clearSelection'),
  'new-tree': action('edit.newTree'),
  'assign': action('edit.assign'),
  'reset-id-0': action('edit.reset'),
  'delete-points': action('edit.delete'),
  'restore-points': action('edit.restore'),
  // View
  'view-top': action('view.top'),
  'view-front': action('view.front'),
  'view-side': action('view.side'),
  'view-edl': action('view.edl'),
  'palette': action('view.palette'),
  'panel-tools': panel('tools'),
  'panel-display': panel('display'),
  'panel-filters': panel('filters'),
  'panel-layers': panel('layers'),
  'panel-history': panel('history'),
  // Tools
  'panel-ground': panel('ground'),
  'panel-segment': panel('segment'),
  'panel-review': panel('review'),
  'panel-qc': panel('qc'),
  'panel-pointqc': panel('pointqc'),
  'panel-tst': panel('tst'),
  'panel-register': panel('register'),
  'panel-growth': panel('growth'),
  'panel-m3c2': panel('m3c2'),
  'panel-subset': panel('subset'),
  'panel-report': panel('report'),
  // Help
  'shortcuts': panel('keys'),
};

/** Ids App.tsx dispatches itself; the editor leaves them alone. */
export const APP_MENU_IDS: readonly string[] = ['project-new', 'project-open', 'project-close'];

/** The target of a bridge event, or null when the event is not a menu
 *  click the editor handles (an App id, a dropped file, project:changed,
 *  or an id this table does not know). */
export function menuTarget(event: string): MenuTarget | null {
  if (!event.startsWith('menu:')) return null;
  return MENU_TARGETS[event.slice('menu:'.length)] ?? null;
}
