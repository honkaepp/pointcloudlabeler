import { describe, it, expect, beforeEach } from 'vitest';
import { describeHits, scanSources } from '../testing/sourceScan';
import {
  BIOMASS_SETTINGS_KEY, CUSTOM_SPECIES_KEY, DEFAULT_BIOMASS_SETTINGS,
  fallbackDensityLabel, loadBiomassSettings, normaliseBiomassSettings,
  saveBiomassSettings, withFallbackSpecies,
} from './biomassSettings';
import { DEFAULT_BIOMASS_PARAMS, SPECIES_DENSITIES, computeSpeciesAwareBiomass } from './biomass';
import type { TreeQsm } from '../persistence/octreeReader';

/** These tests run in the node environment, which has no localStorage —
 *  so this provides one. Deliberately a real store rather than a mock
 *  that records calls: what has to hold is that a value written by one
 *  panel is the value another panel reads back, and a spy on setItem
 *  cannot show that. */
function installStorage(): void {
  const map = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  } as Storage;
}

/** Biomass is ρ·V and carbon a fraction of that, so the basic density ρ
 *  is the single largest assumption under a carbon number.
 *
 *  PointCloudLabeler had two of them at once: the Metrics module carried editable
 *  parameters in component state, and the Report panel passed
 *  DEFAULT_BIOMASS_PARAMS regardless. A forester outside the boreal zone
 *  — where none of the five bundled presets is their species — set
 *  600 kg/m³ for a tropical hardwood, got a correct table, then
 *  generated the client's report and got a different tonnage computed at
 *  400. */
describe('the density behind a carbon figure', () => {
  beforeEach(() => { installStorage(); localStorage.clear(); });

  it('is the same number on both screens', () => {
    const trees = [
      { treeId: 1, stemVolume: 1, stemVolumeStd: 0, branchVolume: 0 },
      { treeId: 2, stemVolume: 2, stemVolumeStd: 0, branchVolume: 0 },
    ] as unknown as TreeQsm[];
    const none = new Map<number, string>();

    // What the Metrics module stores when a user types their own figure.
    const stored = saveBiomassSettings({
      fallbackSpeciesKey: CUSTOM_SPECIES_KEY,
      params: { ...DEFAULT_BIOMASS_PARAMS, density: 600 },
    });
    expect(stored.params.density).toBe(600);

    // What a panel reading the shared store then computes.
    const shared = computeSpeciesAwareBiomass(
      trees, none, stored.fallbackSpeciesKey, loadBiomassSettings().params,
    );
    const total = [...shared.byTree.values()].reduce((a, b) => a + b.biomass, 0);
    expect(total).toBeCloseTo(3 * 600, 9);

    // What the report used to compute for the very same plot.
    const old = computeSpeciesAwareBiomass(trees, none, CUSTOM_SPECIES_KEY, DEFAULT_BIOMASS_PARAMS);
    const oldTotal = [...old.byTree.values()].reduce((a, b) => a + b.biomass, 0);
    expect(oldTotal).toBeCloseTo(3 * 400, 9);
    // 1200 kg against 1800 kg — a third of the carbon, on one plot.
    expect(oldTotal).not.toBeCloseTo(total, 0);
  });

  it('survives a restart, so a re-measure does not revert to Scots pine', () => {
    saveBiomassSettings({
      fallbackSpeciesKey: CUSTOM_SPECIES_KEY,
      params: { ...DEFAULT_BIOMASS_PARAMS, density: 720, carbonFraction: 0.47 },
    });
    const back = loadBiomassSettings();
    expect(back.params.density).toBe(720);
    expect(back.params.carbonFraction).toBe(0.47);
    expect(back.fallbackSpeciesKey).toBe(CUSTOM_SPECIES_KEY);
  });

  it('carries a preset across when one is picked, and never over a custom figure', () => {
    const birch = SPECIES_DENSITIES.find(s => s.key === 'birch')!;
    const picked = withFallbackSpecies(DEFAULT_BIOMASS_SETTINGS, 'birch');
    expect(picked.params.density).toBe(birch.density);
    expect(picked.params.densityStd).toBe(birch.densityStd);
    expect(picked.params.carbonFraction).toBe(birch.carbonFraction);
    // The two that are analysis settings, not facts about wood, ride
    // through untouched.
    expect(picked.params.branchUncFraction).toBe(DEFAULT_BIOMASS_PARAMS.branchUncFraction);
    expect(picked.params.carbonFractionStd).toBe(DEFAULT_BIOMASS_PARAMS.carbonFractionStd);

    // Selecting "custom" must not overwrite the user's own numbers with
    // a preset's — they are the entire point of it.
    const mine = { fallbackSpeciesKey: 'birch', params: { ...DEFAULT_BIOMASS_PARAMS, density: 880 } };
    const kept = withFallbackSpecies(mine, CUSTOM_SPECIES_KEY);
    expect(kept.fallbackSpeciesKey).toBe(CUSTOM_SPECIES_KEY);
    expect(kept.params.density).toBe(880);
  });

  /** settings.json is a file on disk a user can edit, and JSON has no
   *  NaN, so anything can arrive here. A density of 0 makes every
   *  biomass, carbon and CO₂e figure exactly zero — which looks like a
   *  plot with no QSM rather than like a broken setting. */
  it('refuses a stored value that would silently zero the carbon', () => {
    for (const bad of [0, -400, null, 'six hundred', undefined, NaN, Infinity, 1e9]) {
      const n = normaliseBiomassSettings({ params: { density: bad } });
      expect(n.params.density, `density ${String(bad)}`).toBe(DEFAULT_BIOMASS_PARAMS.density);
      expect(n.params.density).toBeGreaterThan(0);
    }
    // Wood is 45–55 % carbon; nothing is more than entirely carbon.
    for (const bad of [0, 1.5, -0.5, 'half']) {
      expect(normaliseBiomassSettings({ params: { carbonFraction: bad } }).params.carbonFraction)
        .toBe(DEFAULT_BIOMASS_PARAMS.carbonFraction);
    }
    // Real figures pass through untouched.
    expect(normaliseBiomassSettings({ params: { density: 880, carbonFraction: 0.47 } }).params)
      .toMatchObject({ density: 880, carbonFraction: 0.47 });
    // A species key that no longer exists falls back rather than
    // producing a plot attributed to nothing.
    expect(normaliseBiomassSettings({ fallbackSpeciesKey: 'kauri' }).fallbackSpeciesKey)
      .toBe(DEFAULT_BIOMASS_SETTINGS.fallbackSpeciesKey);
    expect(normaliseBiomassSettings(null)).toEqual(DEFAULT_BIOMASS_SETTINGS);
    expect(normaliseBiomassSettings('nonsense')).toEqual(DEFAULT_BIOMASS_SETTINGS);
  });

  it('reads a corrupted store as the defaults rather than throwing', () => {
    localStorage.setItem(BIOMASS_SETTINGS_KEY, '{not json');
    expect(loadBiomassSettings()).toEqual(DEFAULT_BIOMASS_SETTINGS);
  });

  it('names the density it will actually apply', () => {
    const spruce = SPECIES_DENSITIES.find(s => s.key === 'spruce')!;
    const preset = fallbackDensityLabel(withFallbackSpecies(DEFAULT_BIOMASS_SETTINGS, 'spruce'));
    expect(preset).toEqual({ label: spruce.label, density: spruce.density });

    const custom = fallbackDensityLabel({
      fallbackSpeciesKey: CUSTOM_SPECIES_KEY,
      params: { ...DEFAULT_BIOMASS_PARAMS, density: 655 },
    });
    expect(custom.density).toBe(655);
    expect(custom.label).not.toMatch(/pine|spruce|birch/i);
  });

  /** The defect was not a wrong default. It was a second copy of the
   *  parameters living in a panel, so this is the rule that stops the
   *  third: nothing may reach the biomass arithmetic with the module
   *  defaults when a user setting exists. */
  it('leaves no panel passing the module defaults straight to the arithmetic', () => {
    // Split so this file is not its own counterexample. biomass.ts
    // declares it; biomassSettings.ts is what every panel reads
    // instead, and validates against it.
    const hits = scanSources('src', `DEFAULT_${'BIOMASS'}_PARAMS`,
      f => /metrics[\\/]biomass(Settings)?\.ts$/.test(f));
    expect(hits, `a panel with its own copy of the density:\n${describeHits(hits)}`).toEqual([]);
  });
});
