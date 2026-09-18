// Dark or white, for the whole application.
//
// The dark surface is the default and stays the default: a point cloud
// reads best against it, and that is what the tool is for. But a figure
// for print, a projector in a bright room and a screenshot dropped into
// a document all want the same white the figure exporter renders on —
// so the choice is the user's, it is one switch, and the viewport's own
// background follows it. Everything else is CSS variables, which is why
// the whole theme is two declarations in globals.css rather than a
// second set of components.

export type Theme = 'dark' | 'light';

/** Mirrored to settings.json by settingsStore — must match the entry in
 *  its PERSISTED_KEYS, or the choice resets on every profile reset. */
export const THEME_KEY = 'tree-seg-theme';

/** The 3D viewport's clear colour per theme. White is exactly the white
 *  the figure exporter uses, so what is on screen in white mode is what
 *  a figure of it looks like. */
export const VIEWPORT_BG: Record<Theme, string> = { dark: '#0b0d10', light: '#ffffff' };

export function parseTheme(raw: string | null | undefined): Theme {
  return raw === 'light' ? 'light' : 'dark';
}

export function readTheme(): Theme {
  if (typeof localStorage === 'undefined') return 'dark';
  try { return parseTheme(localStorage.getItem(THEME_KEY)); } catch { return 'dark'; }
}

/** Put the theme on the document, which is all the stylesheet needs.
 *  Dark sets no attribute: the default palette is the one on `:root`,
 *  so a build that never touches this is the dark one. */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'light') root.setAttribute('data-theme', 'light');
  else root.removeAttribute('data-theme');
  root.style.colorScheme = theme;
}

type Listener = (t: Theme) => void;
const listeners = new Set<Listener>();

/** Tell the parts that are not CSS — the WebGL clear colour, mainly. */
export function onThemeChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function writeTheme(theme: Theme): void {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* holds for this session */ }
  applyTheme(theme);
  for (const cb of listeners) cb(theme);
}

export function viewportBackground(theme: Theme = readTheme()): string {
  return VIEWPORT_BG[theme];
}

export const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: 'dark', label: 'Dark', hint: 'The default. A point cloud reads best against it.' },
  { id: 'light', label: 'White', hint: 'The same white a figure is rendered on, in the whole application and in the viewport.' },
];
