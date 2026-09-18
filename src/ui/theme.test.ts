import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import { parseTheme, viewportBackground, VIEWPORT_BG, THEME_KEY, THEMES } from './theme';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const css = read('src/styles/globals.css');

/** White mode, for print, a projector, or a screenshot dropped into a
 *  document. Dark stays the default: a point cloud reads best against
 *  it, and that is what a fresh install gets. */
describe('dark or white, for the whole application', () => {
  afterEach(() => { try { localStorage.removeItem(THEME_KEY); } catch { /* none here */ } });

  it('is dark unless it says light, whatever is in the store', () => {
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('dark')).toBe('dark');
    expect(parseTheme('white')).toBe('dark');
    expect(parseTheme(null)).toBe('dark');
    expect(parseTheme(undefined)).toBe('dark');
    expect(THEMES.map((t) => t.id)).toEqual(['dark', 'light']);
  });

  it('gives the viewport the same white a figure is rendered on', () => {
    expect(viewportBackground('light')).toBe('#ffffff');
    expect(viewportBackground('dark')).toBe('#0b0d10');
    // …the same two the figure exporter clears to, or a white-mode
    // screen and a white-mode figure would not be the same white.
    const canvas = read('src/figures/FigureCanvas.tsx');
    expect(canvas).toMatch(/\{ white: '#ffffff', dark: '#0b0d10' \}/);
    expect(VIEWPORT_BG.light).toBe('#ffffff');
  });

  it('is the whole theme: variables, not a second set of components', () => {
    expect(css).toMatch(/:root\[data-theme="light"\] \{/);
    // Every variable the dark palette defines is redefined by the light
    // one — a variable that is not is a colour that stays dark on white.
    const block = (sel: string) => {
      const at = css.indexOf(sel);
      return css.slice(at, css.indexOf('}', at));
    };
    const names = (s: string) => new Set([...s.matchAll(/^\s*(--[a-z-]+):/gm)].map((m) => m[1]));
    const dark = names(block(':root {'));
    const light = names(block(':root[data-theme="light"] {'));
    expect(dark.size).toBeGreaterThan(10);
    expect([...dark].filter((n) => !light.has(n))).toEqual([]);
  });

  it('is applied before the first render and mirrored to settings.json', () => {
    const main = stripComments(read('src/main.tsx'));
    expect(main).toMatch(/applyTheme\(readTheme\(\)\);/);
    // Before createRoot, so nothing flashes dark on its way to white.
    expect(main.indexOf('applyTheme(readTheme())')).toBeLessThan(main.indexOf('createRoot('));
    expect(read('src/persistence/settingsStore.ts')).toContain(`'${THEME_KEY}'`);
  });

  it('the viewport follows it, and keeps following it after a switch', () => {
    const view = stripComments(read('src/three/OctreeView.tsx'));
    expect(view).toMatch(/gl\.setClearColor\(viewportBackground\(\), 1\)/);
    expect(view).toMatch(/export function ThemeClearColor\(\)/);
    expect(view).toMatch(/<ThemeClearColor \/>/);
    expect(stripComments(read('src/three/CompareView.tsx'))).toMatch(/<ThemeClearColor \/>/);
    // No view paints the dark surface as a literal any more.
    for (const f of ['src/three/OctreeView.tsx', 'src/three/CompareView.tsx',
      'src/modules/EditorModule.tsx', 'src/modules/MetricsModule.tsx',
      'src/modules/InventoryModule.tsx', 'src/modules/PreprocessingModule.tsx']) {
      expect(read(f), `${f} still hard-codes the dark background`).not.toMatch(/background: '#0b0d10'/);
    }
  });

  it('inverts the surface washes instead of letting them vanish into white', () => {
    // A panel's faint white fills are invisible on a white panel; the
    // ladder gives the same three steps as an ink on the light theme.
    for (const v of ['--wash-1', '--wash-2', '--wash-3']) {
      expect(css).toMatch(new RegExp(`${v}: rgba\\(255, 255, 255`));
      expect(css).toMatch(new RegExp(`${v}: rgba\\(18, 45, 30`));
    }
    // …and the panels use the ladder rather than a literal. A 2D-canvas
    // stroke takes no variable, and a floating panel's inset highlight
    // is deliberately white, so those are the only ones left.
    const offenders: string[] = [];
    for (const f of ['src/components/shell/DisplayPanel.tsx', 'src/components/shell/QcPanel.tsx',
      'src/components/shell/TreeReviewPanel.tsx', 'src/modules/FigureModule.tsx', 'src/modules/MetricsModule.tsx']) {
      for (const line of read(f).split('\n')) {
        if (/background[^\n]*rgba\(255,\s?255,\s?255,\s?0\.0/.test(line)) offenders.push(`${f}: ${line.trim()}`);
      }
    }
    expect(offenders, 'a surface wash that white mode cannot invert').toEqual([]);
  });

  it('is offered in the Display panel, and severity follows the theme', () => {
    const panel = stripComments(read('src/components/shell/DisplayPanel.tsx'));
    expect(panel).toMatch(/THEMES\.map\(t => \{/);
    expect(panel).toMatch(/writeTheme\(t\.id\)/);
    // A pale pink that reads on the dark surface is barely there on
    // white, so the pair is a variable.
    expect(read('src/metrics/qcFlags.ts')).toMatch(/critical: 'var\(--sev-critical\)'/);
    expect(css).toMatch(/--sev-critical: #ffb4be;/);
    expect(css).toMatch(/--sev-critical: #b3123a;/);
  });
});
