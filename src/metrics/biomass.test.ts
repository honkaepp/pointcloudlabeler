import { describe, it, expect } from 'vitest';
import type { TreeQsm } from '../persistence/octreeReader';
import {
  SPECIES_DENSITIES, DEFAULT_BIOMASS_PARAMS,
  biomassParamsForSpecies, computeTreeBiomass, computeSpeciesAwareBiomass,
  computeBiomassTotals,
} from './biomass';

/** A QSM tree with just the fields biomass reads; the rest are geometry
 *  it never touches. */
function tree(treeId: number, stemVolume: number, opts: Partial<TreeQsm> = {}): TreeQsm {
  return {
    treeId, baseX: 0, baseY: 0, baseZ: 0, height: 20,
    slices: [], branches: [],
    branchVolume: 0, branchCount: 0,
    totalVolume: stemVolume, stemVolume, stemVolumeStd: 0, stemVolumeCi95: 0,
    dbh: 0.3, confidence: 0.9,
    ...opts,
  } as TreeQsm;
}

describe('biomass', () => {
  it('scales linearly with wood density — the one thing the species choice changes', () => {
    const t = tree(1, 1.0);
    const pine = computeTreeBiomass(t, biomassParamsForSpecies('pine', DEFAULT_BIOMASS_PARAMS));
    const oak = computeTreeBiomass(t, biomassParamsForSpecies('oak', DEFAULT_BIOMASS_PARAMS));
    const dPine = SPECIES_DENSITIES.find(s => s.key === 'pine')!.density;
    const dOak = SPECIES_DENSITIES.find(s => s.key === 'oak')!.density;
    expect(pine.biomass).toBeCloseTo(dPine, 6);
    expect(oak.biomass / pine.biomass).toBeCloseTo(dOak / dPine, 9);
  });

  it('carries CO2e at 44/12 of carbon', () => {
    const b = computeTreeBiomass(tree(1, 2.5), DEFAULT_BIOMASS_PARAMS);
    expect(b.co2e / b.carbon).toBeCloseTo(44 / 12, 9);
    expect(b.carbon).toBeLessThan(b.biomass); // carbon fraction is < 1
  });

  it('includes branch volume, and its uncertainty, in the total', () => {
    const stemOnly = computeTreeBiomass(tree(1, 1.0), DEFAULT_BIOMASS_PARAMS);
    const withBranches = computeTreeBiomass(
      tree(1, 1.0, { branchVolume: 0.4, totalVolume: 1.4 }), DEFAULT_BIOMASS_PARAMS);
    expect(withBranches.volume).toBeCloseTo(1.4, 9);
    expect(withBranches.biomass).toBeGreaterThan(stemOnly.biomass);
    // Branch volume carries a fractional error, so the error bar must grow too.
    expect(withBranches.biomassStd).toBeGreaterThan(stemOnly.biomassStd);
  });

  /** The fallback count is the honesty field: a plot that is mostly
   *  fallback is not a species-aware result, and the caller can only say
   *  so if the number is right. Both "unassigned" and "assigned to a key
   *  that is no longer a known preset" must count — the second is how a
   *  stale species.json quietly turns into a wrong answer. */
  describe('species-aware fallback accounting', () => {
    const trees = [tree(1, 1), tree(2, 1), tree(3, 1)];

    it('counts trees with no assignment', () => {
      const r = computeSpeciesAwareBiomass(trees, new Map([[1, 'oak']]), 'pine', DEFAULT_BIOMASS_PARAMS);
      expect(r.fallbackCount).toBe(2);
      expect(r.byTree.size).toBe(3);
    });

    it('counts a stale key that no longer matches a preset', () => {
      const stale = new Map([[1, 'oak'], [2, 'larch-that-was-removed'], [3, 'spruce']]);
      const r = computeSpeciesAwareBiomass(trees, stale, 'pine', DEFAULT_BIOMASS_PARAMS);
      expect(r.fallbackCount, 'an unrecognised key must not silently pass as assigned').toBe(1);
    });

    it('gives each tree its OWN species density, not one shared value', () => {
      const assigned = new Map([[1, 'oak'], [2, 'pine'], [3, 'pine']]);
      const r = computeSpeciesAwareBiomass(trees, assigned, 'pine', DEFAULT_BIOMASS_PARAMS);
      expect(r.fallbackCount).toBe(0);
      // Equal volumes, different species ⇒ different biomass.
      expect(r.byTree.get(1)!.biomass).not.toBeCloseTo(r.byTree.get(2)!.biomass, 3);
      expect(r.byTree.get(2)!.biomass).toBeCloseTo(r.byTree.get(3)!.biomass, 9);
    });

    it('falls back to the chosen species, not to the first in the list', () => {
      const r = computeSpeciesAwareBiomass([tree(1, 1)], new Map(), 'oak', DEFAULT_BIOMASS_PARAMS);
      const oakDirect = computeTreeBiomass(tree(1, 1), biomassParamsForSpecies('oak', DEFAULT_BIOMASS_PARAMS));
      expect(r.byTree.get(1)!.biomass).toBeCloseTo(oakDirect.biomass, 9);
    });
  });

  it('every species preset is usable and cites a source', () => {
    for (const s of SPECIES_DENSITIES) {
      expect(s.density, `${s.key} density`).toBeGreaterThan(0);
      expect(s.densityStd, `${s.key} densityStd`).toBeGreaterThan(0);
      expect(s.carbonFraction, `${s.key} carbon fraction`).toBeGreaterThan(0.3);
      expect(s.carbonFraction).toBeLessThan(0.6);
      expect(s.source.length, `${s.key} must cite where its density came from`).toBeGreaterThan(0);
      // A preset the UI offers must actually resolve.
      expect(biomassParamsForSpecies(s.key, DEFAULT_BIOMASS_PARAMS).density).toBe(s.density);
    }
  });
});

/** Plot totals, where the errors stop being independent.
 *
 *  A per-tree error bar is straightforward. A plot total is not: the
 *  wood density is one number applied to every tree of a species, so
 *  getting it wrong gets every one of them wrong in the same direction,
 *  and no amount of averaging removes that. Summing the trees in
 *  quadrature assumed it would.
 */
describe('computeBiomassTotals', () => {
  const pine = biomassParamsForSpecies('pine', DEFAULT_BIOMASS_PARAMS);

  /** A tree with a known stem volume and no volume uncertainty at all,
   *  so the only error left is the shared density — which is exactly the
   *  term the plot total used to average away. */
  const exactTree = (treeId: number): TreeQsm => tree(treeId, 0.5);

  it('does not let a shared density error average away across the plot', () => {
    // 400 ± 25 kg/m³ is a 6.25 % density uncertainty. Every tree carries
    // it, in the same direction, so the plot carries it too.
    const relDensity = pine.densityStd / pine.density;

    for (const n of [1, 10, 200]) {
      const per = Array.from({ length: n }, (_, i) => computeTreeBiomass(exactTree(i), pine));
      const tot = computeBiomassTotals(per);
      const rel = tot.biomassStd / tot.biomass;
      expect(rel).toBeCloseTo(relDensity, 10);
    }

    // What quadrature-over-trees would have said, for contrast: with 200
    // trees it shrinks by √200, to well under a percent.
    const per = Array.from({ length: 200 }, (_, i) => computeTreeBiomass(exactTree(i), pine));
    const naive = Math.sqrt(per.reduce((a, b) => a + b.biomassStd * b.biomassStd, 0));
    const total = per.reduce((a, b) => a + b.biomass, 0);
    expect(naive / total).toBeLessThan(relDensity / 10);
  });

  it('still averages the part that really is independent', () => {
    // Same trees, but now the only error is each tree's own volume,
    // which IS measured separately per tree.
    const noDensityErr = { ...pine, densityStd: 0, carbonFractionStd: 0 };
    const withVolErr = (treeId: number): TreeQsm => tree(treeId, 0.5, { stemVolumeStd: 0.05 });

    const one = computeBiomassTotals([computeTreeBiomass(withVolErr(0), noDensityErr)]);
    const many = computeBiomassTotals(
      Array.from({ length: 100 }, (_, i) => computeTreeBiomass(withVolErr(i), noDensityErr)),
    );
    const relOne = one.biomassStd / one.biomass;
    const relMany = many.biomassStd / many.biomass;
    // 100 independent trees ⇒ the relative error falls by 10.
    expect(relMany).toBeCloseTo(relOne / 10, 10);
  });

  it('keeps two species’ density errors separate rather than pooling them', () => {
    const spruce = biomassParamsForSpecies('spruce', DEFAULT_BIOMASS_PARAMS);
    const oak = biomassParamsForSpecies('oak', DEFAULT_BIOMASS_PARAMS);
    const per = [
      ...Array.from({ length: 50 }, (_, i) => computeTreeBiomass(exactTree(i), spruce)),
      ...Array.from({ length: 50 }, (_, i) => computeTreeBiomass(exactTree(100 + i), oak)),
    ];
    const tot = computeBiomassTotals(per);

    // Each species contributes rel × its own biomass; the two groups are
    // independent of each other, so they combine in quadrature.
    const bs = per.filter(p => p.density === spruce.density).reduce((a, b) => a + b.biomass, 0);
    const bo = per.filter(p => p.density === oak.density).reduce((a, b) => a + b.biomass, 0);
    const expected = Math.hypot(
      (spruce.densityStd / spruce.density) * bs,
      (oak.densityStd / oak.density) * bo,
    );
    expect(tot.biomassStd).toBeCloseTo(expected, 8);
    // And that is strictly wider than pooling them into one group would be.
    expect(tot.biomassStd).toBeLessThan(
      (spruce.densityStd / spruce.density) * bs + (oak.densityStd / oak.density) * bo,
    );
  });

  it('agrees with the per-tree figure when the plot holds one tree', () => {
    const t = computeTreeBiomass(tree(1, 0.5, { stemVolumeStd: 0.03 }), pine);
    const tot = computeBiomassTotals([t]);
    expect(tot.biomass).toBeCloseTo(t.biomass, 10);
    expect(tot.biomassStd).toBeCloseTo(t.biomassStd, 10);
    expect(tot.carbon).toBeCloseTo(t.carbon, 10);
    expect(tot.carbonStd).toBeCloseTo(t.carbonStd, 10);
    expect(tot.co2e).toBeCloseTo(t.co2e, 10);
  });

  it('carries the carbon fraction as a shared error too, and CO2e exactly', () => {
    const per = Array.from({ length: 100 }, (_, i) => computeTreeBiomass(exactTree(i), pine));
    const tot = computeBiomassTotals(per);
    // Carbon relative error = biomass relative error and the carbon
    // fraction's, in quadrature — neither shrinking with tree count.
    const relB = tot.biomassStd / tot.biomass;
    const relCf = pine.carbonFractionStd / pine.carbonFraction;
    expect(tot.carbonStd / tot.carbon).toBeCloseTo(Math.hypot(relB, relCf), 10);
    expect(tot.co2e).toBeCloseTo(tot.carbon * (44 / 12), 10);
    expect(tot.co2eStd).toBeCloseTo(tot.carbonStd * (44 / 12), 10);
  });

  it('an empty plot is zero, not NaN', () => {
    const tot = computeBiomassTotals([]);
    expect(tot.trees).toBe(0);
    expect(tot.biomass).toBe(0);
    expect(tot.biomassStd).toBe(0);
    expect(tot.carbonStd).toBe(0);
    expect(Number.isNaN(tot.co2eStd)).toBe(false);
  });
});
