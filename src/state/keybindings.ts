// Customizable editor keybindings — a single registry for every keyboard
// shortcut in the octree editor, with per-action overrides persisted to
// settings.json (via the localStorage mirror in settingsStore).
//
// Before this, shortcuts were hardcoded in two places (EditorShell's
// global handler + OctreeView's own keydown effects). They're now all
// driven from here: EditorShell installs ONE window keydown handler that
// looks the pressed chord up in this registry and dispatches the action.
// The Keybindings panel reads + rewrites the same overrides.
//
// A "chord" is a normalized string: zero or more modifiers in fixed order
// (mod, shift, alt) joined to a key by '+', e.g. "mod+s", "shift+z", "a",
// "Delete", "Escape", "F1", "Space". "mod" = Ctrl on Windows/Linux, ⌘ on
// macOS, so the same binding feels native on both.

import { useSyncExternalStore } from 'react';

export type KeyActionId =
  | 'file.import' | 'file.save' | 'file.export'
  | 'edit.undo' | 'edit.redo'
  | 'edit.assign' | 'edit.reset' | 'edit.newTree'
  | 'edit.delete' | 'edit.restore' | 'edit.clearSelection'
  | 'edit.semStem' | 'edit.semBranch' | 'edit.semUnlabel'
  | 'mode.toggle' | 'mode.measure' | 'view.palette'
  | 'view.top' | 'view.front' | 'view.side' | 'view.edl'
  | 'filter.hideUnassigned' | 'filter.isolate'
  | 'colour.tree_id' | 'colour.height' | 'colour.intensity'
  | 'colour.classification' | 'colour.semantic' | 'colour.flat';

export interface KeyAction {
  id: KeyActionId;
  label: string;
  group: string;
  /** Default chord, '' when the action ships unbound (still customizable). */
  defaultChord: string;
  /** One-line hint shown in the panel. */
  hint?: string;
}

// The canonical action list — order defines panel order within each group.
export const KEY_ACTIONS: readonly KeyAction[] = [
  { id: 'file.import',          group: 'File',   label: 'Import LAS / LAZ',            defaultChord: 'o' },
  { id: 'file.save',            group: 'File',   label: 'Save edits',                  defaultChord: 'mod+s' },
  { id: 'file.export',          group: 'File',   label: 'Export to LAS',               defaultChord: '' },

  { id: 'edit.assign',          group: 'Edit',   label: 'Assign active id to selection', defaultChord: 'a', hint: 'tree_id / deadwood / semantic — follows the colour mode' },
  { id: 'edit.reset',           group: 'Edit',   label: 'Reset selection to 0',        defaultChord: 'r', hint: 'unassign / unlabel the selected points' },
  { id: 'edit.newTree',         group: 'Edit',   label: 'New tree id',                 defaultChord: 'n' },
  { id: 'edit.delete',          group: 'Edit',   label: 'Delete selected points',      defaultChord: 'Delete' },
  { id: 'edit.restore',         group: 'Edit',   label: 'Restore deleted in selection', defaultChord: '' },
  { id: 'edit.clearSelection',  group: 'Edit',   label: 'Clear selection',             defaultChord: 'Escape' },
  { id: 'edit.undo',            group: 'Edit',   label: 'Undo',                        defaultChord: 'mod+z' },
  { id: 'edit.redo',            group: 'Edit',   label: 'Redo',                        defaultChord: 'mod+shift+z' },
  { id: 'edit.semStem',         group: 'Edit',   label: 'Label selection as stem',     defaultChord: '1', hint: 'semantic mode' },
  { id: 'edit.semBranch',       group: 'Edit',   label: 'Label selection as branch',   defaultChord: '2', hint: 'semantic mode' },
  { id: 'edit.semUnlabel',      group: 'Edit',   label: 'Remove semantic label',       defaultChord: '0', hint: 'semantic mode' },

  { id: 'mode.toggle',          group: 'Mode',   label: 'Toggle camera / edit',        defaultChord: 'Space' },
  { id: 'mode.measure',         group: 'Mode',   label: 'Toggle measure',              defaultChord: 'm' },
  { id: 'view.palette',         group: 'Mode',   label: 'Command palette',             defaultChord: 'mod+k' },

  { id: 'view.top',             group: 'View',   label: 'Top view',                    defaultChord: 'F1' },
  { id: 'view.front',           group: 'View',   label: 'Front view',                  defaultChord: 'F2' },
  { id: 'view.side',            group: 'View',   label: 'Side view',                   defaultChord: 'F3' },
  { id: 'view.edl',             group: 'View',   label: 'Toggle Eye-Dome lighting',    defaultChord: '' },

  { id: 'filter.hideUnassigned', group: 'Filter', label: 'Toggle hide unassigned',     defaultChord: 'h' },
  { id: 'filter.isolate',       group: 'Filter', label: 'Isolate active tree',         defaultChord: 'i' },

  { id: 'colour.tree_id',        group: 'Colour', label: 'Colour by tree id',          defaultChord: 't' },
  { id: 'colour.height',         group: 'Colour', label: 'Colour by height',           defaultChord: '' },
  { id: 'colour.intensity',      group: 'Colour', label: 'Colour by intensity',        defaultChord: '' },
  { id: 'colour.classification', group: 'Colour', label: 'Colour by classification',   defaultChord: '' },
  { id: 'colour.semantic',       group: 'Colour', label: 'Colour by semantic',         defaultChord: '' },
  { id: 'colour.flat',           group: 'Colour', label: 'Colour flat',                defaultChord: '' },
];

const STORAGE_KEY = 'tree-seg-keybindings';

// Override map id→chord. An entry of '' means "explicitly unbound" (the
// user cleared the default). Absent ⇒ fall back to the default.
let overrides: Record<string, string> = loadOverrides();
let snapshot: Record<KeyActionId, string> = computeSnapshot();
const listeners = new Set<() => void>();
// Set true by the Keybindings panel while it's capturing a chord, so the
// global dispatcher ignores the keystroke being recorded.
let recording = false;

function loadOverrides(): Record<string, string> {
  try {
    const s = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (s) {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
    }
  } catch { /* malformed ⇒ defaults */ }
  return {};
}

function computeSnapshot(): Record<KeyActionId, string> {
  const map = {} as Record<KeyActionId, string>;
  for (const a of KEY_ACTIONS) {
    map[a.id] = a.id in overrides ? overrides[a.id] : a.defaultChord;
  }
  return map;
}

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides)); } catch { /* ignore */ }
  snapshot = computeSnapshot();
  for (const l of listeners) l();
}

export function subscribeBindings(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current id→chord map. Stable reference until a binding changes, so it's
 *  safe as a useSyncExternalStore snapshot. */
export function getBindings(): Record<KeyActionId, string> {
  return snapshot;
}

/** React hook — re-renders when any binding changes. */
export function useKeybindings(): Record<KeyActionId, string> {
  return useSyncExternalStore(subscribeBindings, getBindings, getBindings);
}

/** Assign `chord` to `id`. Any OTHER action holding that chord is unbound
 *  first so a chord maps to exactly one action. Pass '' to clear. */
export function setBinding(id: KeyActionId, chord: string): void {
  if (chord) {
    for (const a of KEY_ACTIONS) {
      if (a.id === id) continue;
      if (snapshot[a.id] === chord) overrides[a.id] = '';
    }
  }
  const def = KEY_ACTIONS.find(a => a.id === id)?.defaultChord ?? '';
  if (chord === def) delete overrides[id]; // back to default ⇒ drop the override
  else overrides[id] = chord;
  persist();
}

/** Restore one action to its shipped default. */
export function resetBinding(id: KeyActionId): void {
  delete overrides[id];
  persist();
}

/** Restore every action to its shipped default. */
export function resetAllBindings(): void {
  overrides = {};
  persist();
}

export function setRecording(on: boolean): void { recording = on; }
export function isRecording(): boolean { return recording; }

// --- chord encoding -------------------------------------------------

const MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** True for a keydown that is ONLY a modifier (no real key yet) — used by
 *  the recorder to wait for the full chord. */
export function isModifierOnly(e: KeyboardEvent): boolean {
  return e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta' || e.key === 'Alt' || e.key === 'AltGraph';
}

/** Normalize a KeyboardEvent into a chord string. */
export function eventToChord(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  let key = e.key;
  if (key === ' ' || key === 'Spacebar') key = 'Space';
  if (key.length === 1) key = key.toLowerCase();
  parts.push(key);
  return parts.join('+');
}

const KEY_LABEL: Record<string, string> = {
  Space: 'Space', Escape: 'Esc', Delete: 'Del', Backspace: '⌫', Enter: '↵',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};

/** Pretty-print a chord for display: "mod+shift+z" → "⌘⇧Z" (mac) or
 *  "Ctrl+Shift+Z" (win/linux). '' → '—'. */
export function formatChord(chord: string): string {
  if (!chord) return '—';
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  const mods: string[] = [];
  for (const p of parts) {
    if (p === 'mod') mods.push(MAC ? '⌘' : 'Ctrl');
    else if (p === 'shift') mods.push(MAC ? '⇧' : 'Shift');
    else if (p === 'alt') mods.push(MAC ? '⌥' : 'Alt');
  }
  const k = KEY_LABEL[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  // On mac the symbols read as a tight cluster (⌘⇧Z); elsewhere join with +.
  return MAC ? [...mods, k].join('') : [...mods, k].join('+');
}
