// Persistent user settings at %APPDATA%\<bundle identifier>\settings.json
// (~/.config/<id> on Linux). The identifier is compiled in from
// tauri.conf.json — see src-tauri/src/app_id.rs.
//
// Background (per §8A): localStorage is WebView2-profile-local and dies
// silently on profile reset. We mirror a known set of localStorage keys
// to a real on-disk JSON file so user preferences survive resets.
//
// Strategy: install a thin wrapper around `localStorage.setItem` (and
// `removeItem`) that mirrors writes for keys in PERSISTED_KEYS to
// settings.json with debounced flushes. At startup, `hydrateSettings()`
// reads settings.json and copies any persisted values into localStorage
// *before* React mounts, so the existing useState(() => localStorage.…)
// initialisers pick up the canonical value with no further changes.

import { invoke } from '@tauri-apps/api/core';

// Keys that get mirrored from localStorage to settings.json. Extend this
// set when adding a new user preference that needs to survive WebView2
// profile resets. Keys outside this set are not mirrored.
const PERSISTED_KEYS = new Set<string>([
  'tree-seg-point-size',
  // How every view draws heights (as stored / above ground). Must match
  // shell/heightMode.ts's HEIGHT_MODE_KEY.
  'tree-seg-height-mode',
  // Dark or white for the whole application. Must match ui/theme.ts's
  // THEME_KEY.
  'tree-seg-theme',
  // The Figures module's folder, settings and the frame it is holding
  // between a "before" and an "after". Must match figures/figureSession.ts's
  // FIGURE_SESSION_KEY.
  'tree-seg-figure-session',
  'tree-seg-color-column',
  'tree-seg-color-ramp',
  'tree-seg-autosave',
  'tree-seg-select-depth',
  'tree-seg-confirm-destructive',
  'tree-seg-measurement-decimals',
  'tree-seg-show-stems',
  'tree-seg-keybindings',
  'pointcloudlabeler-filter-presets',
  // Currency the Bucking / Thinning prices and the report's revenue
  // figures are labelled with. Must match metrics/currency.ts's
  // CURRENCY_KEY, or the symbol silently resets to € on every restart —
  // which is the defect this setting exists to fix, returning once a
  // day instead of always.
  'pointcloudlabeler-currency',
  // Wood density / carbon fraction behind every biomass figure. Must
  // match metrics/biomassSettings.ts's BIOMASS_SETTINGS_KEY — the
  // Metrics module and the Report panel both read it, and a mismatch
  // here puts them back to quoting different carbon for one plot.
  'pointcloudlabeler-biomass-params',
  // Geodetic data folder (NTv2 .gsb grids) — the one PERSISTED_KEYS
  // entry a Rust command also reads (nadgrid::apply_persisted_dir, at
  // startup only). The renderer stays the only writer; must match
  // nadgrid.rs's SETTINGS_KEY exactly or the folder silently never
  // restores across a restart.
  'pointcloudlabeler-geodetic-data-dir',
]);

const FLUSH_DEBOUNCE_MS = 300;

let cache: Record<string, string> = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let writeInFlight = false;
let dirty = false;
let installed = false;

const origSetItem: ((key: string, value: string) => void) | null =
  typeof localStorage !== 'undefined' ? localStorage.setItem.bind(localStorage) : null;
const origRemoveItem: ((key: string) => void) | null =
  typeof localStorage !== 'undefined' ? localStorage.removeItem.bind(localStorage) : null;

async function flush(): Promise<void> {
  if (writeInFlight) { dirty = true; return; }
  writeInFlight = true;
  dirty = false;
  try {
    await invoke('settings_save', { value: { ...cache } });
  } catch (e) {
    console.warn('settings_save failed', e);
  } finally {
    writeInFlight = false;
    if (dirty) scheduleFlush();
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_DEBOUNCE_MS);
}

function installLocalStorageMirror(): void {
  if (installed || !origSetItem || !origRemoveItem) return;
  installed = true;
  // Shadow the prototype's setItem with an instance property that calls the
  // original then mirrors persisted keys to settings.json. Works in WebView2
  // because Storage methods are settable on the instance.
  localStorage.setItem = (key: string, value: string): void => {
    origSetItem(key, value);
    if (PERSISTED_KEYS.has(key) && cache[key] !== value) {
      cache[key] = value;
      scheduleFlush();
    }
  };
  localStorage.removeItem = (key: string): void => {
    origRemoveItem(key);
    if (PERSISTED_KEYS.has(key) && key in cache) {
      delete cache[key];
      scheduleFlush();
    }
  };
}

/**
 * Wipe every tree-seg-* key from localStorage AND the on-disk
 * settings.json so a follow-up reload starts from defaults. Use this from
 * the Settings → Reset all preferences button (the localStorage-only clear
 * isn't enough on its own because hydrateSettings() would copy the old
 * settings.json values right back into localStorage on next launch).
 */
export async function clearAllSettings(): Promise<void> {
  // Drop persisted keys from localStorage. We bypass the mirror's removeItem
  // shim (which would schedule a flush per key) and call settings_save({})
  // once below to clear the file in a single atomic write.
  try {
    const remove = origRemoveItem ?? ((k: string) => localStorage.removeItem(k));
    const toDelete: string[] = [];
    if (typeof localStorage !== 'undefined') {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('tree-seg-')) toDelete.push(k);
      }
    }
    for (const k of toDelete) remove(k);
  } catch { /* ignore */ }
  cache = {};
  try {
    await invoke('settings_save', { value: {} });
  } catch (e) {
    console.warn('clearAllSettings: settings_save failed', e);
  }
}

/**
 * Load settings.json from disk and hydrate localStorage with the persisted
 * values. Idempotent. Call once at app startup, BEFORE React mounts, so
 * useState(() => localStorage.getItem(...)) initialisers see the canonical
 * value.
 */
export async function hydrateSettings(): Promise<void> {
  installLocalStorageMirror();
  if (!origSetItem) return;
  try {
    const value = await invoke<unknown>('settings_load');
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    for (const key of PERSISTED_KEYS) {
      const v = obj[key];
      if (typeof v === 'string') {
        cache[key] = v;
        // Use the *original* setItem so the mirror doesn't reschedule a flush
        // for values we just loaded.
        origSetItem(key, v);
      }
    }
  } catch (e) {
    console.warn('settings_load failed', e);
  }
}
