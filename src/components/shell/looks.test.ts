// Looks, the folding Display panel and the grouped activity bar.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';
import { DEFAULT_DISPLAY, type ColorHistogram, type DisplayConfig } from './OctreeShellContext';
import {
  BUILT_IN_LOOKS, LOOK_KEYS, applyLook, deleteUserLook, isLookActive, loadUserLooks, lookAvailable, lookFromDisplay,
  looksPaletteCommands, saveUserLook,
} from './looks';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('the built-in looks', () => {
  it('set only display settings, never the budget or the filters', () => {
    for (const l of BUILT_IN_LOOKS) {
      expect(l.builtIn).toBe(true);
      for (const k of Object.keys(l.display)) expect(LOOK_KEYS).toContain(k);
      expect(l.display.colorMode).toBeTruthy();
    }
    expect(new Set(BUILT_IN_LOOKS.map((l) => l.id)).size).toBe(BUILT_IN_LOOKS.length);
    expect(LOOK_KEYS).not.toContain('pointBudget');
  });
  it('deadwood needs its columns', () => {
    const dead = BUILT_IN_LOOKS.find((l) => l.id === 'deadwood')!;
    expect(lookAvailable(dead, { deadwood: false })).toBe(false);
    expect(lookAvailable(dead, { deadwood: true })).toBe(true);
    expect(lookAvailable(BUILT_IN_LOOKS[0], { deadwood: false })).toBe(true);
  });
  it('change no point drawing: no point shape, splats or compute settings', () => {
    for (const k of LOOK_KEYS) expect(['pointShape', 'pointSizeMode', 'pointScale', 'hqs', 'computeRaster']).not.toContain(k);
  });
  it('a look is active while the display is what it sets', () => {
    const canopy = BUILT_IN_LOOKS.find((l) => l.id === 'canopy')!;
    const d: DisplayConfig = { ...DEFAULT_DISPLAY, ...canopy.display };
    expect(isLookActive(canopy, d)).toBe(true);
    expect(isLookActive(canopy, { ...d, ramp: 'turbo' })).toBe(false);
    // a setting the look leaves alone does not matter
    expect(isLookActive(canopy, { ...d, pointBudget: 9_000_000 })).toBe(true);
    // a display with no projection is in perspective
    expect(isLookActive(canopy, { ...d, projection: undefined })).toBe(true);
  });
  it('the measuring look is a parallel projection', () => {
    expect(BUILT_IN_LOOKS.find((l) => l.id === 'measure')!.display.projection).toBe('ortho');
  });
});

describe('applying a look', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  it('sets its display, and with autoStretch the ramp over the loaded 2–98 %', () => {
    const calls: Array<Partial<DisplayConfig>> = [];
    const h: ColorHistogram = { key: 'intensity', lo: 0, hi: 9000, counts: [1], p: { p1: 100, p2: 612.4, p98: 5957.6, p99: 7000 }, samples: 10 };
    const look = BUILT_IN_LOOKS.find((l) => l.id === 'intensity')!;
    applyLook(look, DEFAULT_DISPLAY, (p) => calls.push(p), () => h);
    expect(calls).toEqual([look.display]);
    vi.advanceTimersByTime(300);
    expect(calls[1]).toEqual({ rampRanges: { intensity: { lo: 612, hi: 5958 } } });
  });
  it('a look without a stretch sets only its display', () => {
    const calls: Array<Partial<DisplayConfig>> = [];
    applyLook(BUILT_IN_LOOKS[0], DEFAULT_DISPLAY, (p) => calls.push(p), () => null);
    vi.advanceTimersByTime(300);
    expect(calls).toHaveLength(1);
  });
});

describe("the user's looks", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    };
  });
  afterEach(() => { delete (globalThis as Record<string, unknown>).localStorage; });

  it('keep the display as it is, by name, and are forgotten', () => {
    const d: DisplayConfig = { ...DEFAULT_DISPLAY, colorMode: 'intensity', ramp: 'magma', shade: 0.4, rampRanges: { intensity: { lo: 5, hi: 50 } } };
    const look = lookFromDisplay('Bark', d);
    expect(look.display.ramp).toBe('magma');
    expect(look.display.rampRanges).toEqual({ intensity: { lo: 5, hi: 50 } });
    expect('pointBudget' in look.display).toBe(false);
    expect(isLookActive(look, d)).toBe(true);
    saveUserLook(look);
    saveUserLook(lookFromDisplay('Bark', { ...d, ramp: 'viridis' })); // same name replaces
    expect(loadUserLooks()).toHaveLength(1);
    expect(loadUserLooks()[0].display.ramp).toBe('viridis');
    expect(looksPaletteCommands(d, () => {}, undefined, { deadwood: false }).map((c) => c.title)).toContain('Look: Bark');
    expect(deleteUserLook('Bark')).toEqual([]);
  });
  it('a broken store reads as none', () => {
    store.set('pointcloudlabeler-looks', '{not json');
    expect(loadUserLooks()).toEqual([]);
    store.set('pointcloudlabeler-looks', JSON.stringify([{ name: 1 }, { name: 'ok', display: {} }]));
    expect(loadUserLooks().map((l) => l.name)).toEqual(['ok']);
  });
});

describe('the Display panel and the activity bar', () => {
  it('the Display panel folds into sections, looks first', () => {
    const src = read('./DisplayPanel.tsx');
    const ids = [...src.matchAll(/<Section id="([a-z]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(['looks', 'colour', 'lighting', 'points', 'heights', 'performance', 'appearance']);
    expect(src).toContain('<LooksRow hasDeadwood={hasDeadwood} />');
    expect(src).toContain("const SECTIONS_KEY = 'pointcloudlabeler-display-sections';");
    expect(src).not.toContain('Point size is intentionally absent');
  });
  it('the activity bar groups every panel once, and scrolls', () => {
    const src = read('./ActivityBar.tsx');
    const groups = [...src.matchAll(/<ActivityGroup id="([a-z]+)"/g)].map((m) => m[1]);
    expect(groups).toEqual(['view', 'edit', 'measure', 'analyse', 'compare']);
    const ids = [...src.matchAll(/<PanelToggle\s+id="([a-z0-9]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(src).toContain('overflow-y-auto overflow-x-hidden scroll-thin');
  });
  it('the looks are in the command palette', () => {
    expect(read('./EditorShell.tsx')).toContain('cmds.push(...looksPaletteCommands(display, setDisplay, () => api.colorHistogram(64)');
  });
});
