// Biomass + carbon estimation from QSM volume, with uncertainty.
//
// Above-stump woody biomass = wood basic density × stem+branch volume.
// Carbon = biomass × carbon fraction. CO₂-equivalent = carbon × 44/12.
//
// Uncertainty propagates in quadrature (relative errors add in
// squares for a product):
//
//   (σ_B / B)² = (σ_V / V)² + (σ_ρ / ρ)²
//   (σ_C / C)² = (σ_B / B)² + (σ_cf / cf)²
//   CO₂e = C × 44/12   (exact constant — adds no uncertainty)
//
// where V = stem + branch volume. The stem volume carries a QSM CI
// (stemVolumeStd); branch volume has no per-cylinder CI yet, so its
// uncertainty is modelled as a configurable fraction of the branch
// volume (branchUncPct, default 25 % — branch QSM is noisier than the
// slice-based stem). Per-plot totals sum in quadrature across trees
// (independent stems).
//
// Density values are wood BASIC density (oven-dry mass / green
// volume), kg/m³. Defaults are boreal stemwood values with a
// natural-variation ± for the CI.

import type { TreeQsm } from '../persistence/octreeReader';

export interface SpeciesDensity {
  key: string;
  label: string;
  /** Wood basic density, kg/m³ (oven-dry mass / green volume). */
  density: number;
  /** 1σ natural variation in density, kg/m³ (used for the CI). */
  densityStd: number;
  /** Carbon fraction of oven-dry wood (dimensionless, ~0.47–0.51). */
  carbonFraction: number;
  /** Short provenance note shown in the UI. */
  source: string;
}

// Boreal stemwood basic densities.
//
//   Repola, J. 2006. Models for vertical wood density of Scots pine,
//   Norway spruce and birch stems, and their application to determine
//   average wood density. Silva Fennica 40(4): 673–685.
//   Repola, J. 2008. Biomass equations for birch in Finland.
//   Silva Fennica 42(4): 605–624.
//   Kärkkäinen, M. 2007. Puutieteen perusteet. Metsäkustannus.
//   Zanne, A.E. et al. 2009. Global wood density database. Dryad.
//
// Repola 2006 is the WOOD DENSITY paper — this comment used to call it
// "biomass models", which is Repola's 2008/2009 work and not what these
// figures come from. A density is what is tabulated here; a citation
// that names the wrong paper is one a reader cannot follow.
//
// Carbon fraction 0.50 is the common boreal stemwood value; the IPCC
// 2006 Guidelines default is 0.47 (reachable through the custom
// density in the Metrics module).
//
// These five are boreal, and that is a real limit rather than an
// oversight: outside the boreal zone none of them is the right species
// and every tree falls back. metrics/biomassSettings.ts is how a
// forester supplies their own basic density instead, and the report
// then cites them rather than these papers.
export const SPECIES_DENSITIES: SpeciesDensity[] = [
  { key: 'pine',   label: 'Scots pine (Pinus sylvestris)',  density: 400, densityStd: 25, carbonFraction: 0.50, source: 'Repola 2006 / Kärkkäinen 2007' },
  { key: 'spruce', label: 'Norway spruce (Picea abies)',    density: 385, densityStd: 25, carbonFraction: 0.50, source: 'Repola 2006 / Kärkkäinen 2007' },
  { key: 'birch',  label: 'Birch (Betula spp.)',            density: 490, densityStd: 30, carbonFraction: 0.50, source: 'Repola 2008 / Kärkkäinen 2007' },
  { key: 'aspen',  label: 'Aspen (Populus tremula)',        density: 400, densityStd: 30, carbonFraction: 0.50, source: 'Kärkkäinen 2007' },
  { key: 'oak',    label: 'Oak (Quercus robur)',            density: 650, densityStd: 40, carbonFraction: 0.48, source: 'Zanne et al. 2009 (Global Wood Density Database)' },
];

export interface BiomassParams {
  /** Wood basic density, kg/m³. */
  density: number;
  /** 1σ density uncertainty, kg/m³. */
  densityStd: number;
  /** Carbon fraction of oven-dry wood. */
  carbonFraction: number;
  /** 1σ carbon-fraction uncertainty (dimensionless). */
  carbonFractionStd: number;
  /** Relative 1σ uncertainty on branch volume (fraction, e.g. 0.25). */
  branchUncFraction: number;
}

export const DEFAULT_BIOMASS_PARAMS: BiomassParams = {
  density: 400,
  densityStd: 25,
  carbonFraction: 0.50,
  carbonFractionStd: 0.02,
  branchUncFraction: 0.25,
};

/** BiomassParams for one species key: density / densityStd /
 *  carbonFraction come straight from its SPECIES_DENSITIES entry;
 *  everything else (carbon-fraction uncertainty, branch-volume error)
 *  rides through from `base` unchanged — those are shared analysis
 *  settings a caller may have tuned, not per-species facts. An
 *  unrecognised key (custom density, or a stale species.json entry from
 *  before a preset was renamed) returns `base` untouched, so the
 *  caller's own numbers win rather than silently resetting to a
 *  default. */
export function biomassParamsForSpecies(key: string, base: BiomassParams): BiomassParams {
  const s = SPECIES_DENSITIES.find(x => x.key === key);
  if (!s) return base;
  return { ...base, density: s.density, densityStd: s.densityStd, carbonFraction: s.carbonFraction };
}

export interface TreeBiomass {
  treeId: number;
  /** Total woody volume used (stem + branch), m³. */
  volume: number;
  /** 1σ on volume, m³. */
  volumeStd: number;
  /** Above-stump woody biomass, kg (oven-dry). */
  biomass: number;
  biomassStd: number;
  /** Carbon, kg. */
  carbon: number;
  carbonStd: number;
  /** CO₂-equivalent, kg. */
  co2e: number;
  co2eStd: number;
  /** The shared parameters this tree was computed with. Carried so plot
   *  totals can tell a CORRELATED error from an independent one: every
   *  tree of a species is multiplied by the same density, so that error
   *  does not average away across the plot the way each tree's own
   *  volume error does. */
  density: number;
  densityStd: number;
  carbonFraction: number;
  carbonFractionStd: number;
}

const CO2_PER_C = 44 / 12;

/** Compute per-tree biomass + carbon + CO₂e with 1σ uncertainties. */
export function computeTreeBiomass(t: TreeQsm, p: BiomassParams): TreeBiomass {
  const stemVol = t.stemVolume;
  const branchVol = t.branchVolume ?? 0;
  const volume = stemVol + branchVol;

  // Volume variance: the QSM's own 1σ on the stem (stemVolumeStd is
  // already 1σ — stemVolumeCi95 is the 1.96× version, and using that
  // here would inflate every error bar by a factor of two) plus the
  // branch fractional uncertainty, added in quadrature.
  const stemStd = t.stemVolumeStd ?? 0;
  const branchStd = branchVol * p.branchUncFraction;
  const volumeStd = Math.sqrt(stemStd * stemStd + branchStd * branchStd);

  // Biomass = ρ V.
  const biomass = p.density * volume;
  const relV = volume > 0 ? volumeStd / volume : 0;
  const relRho = p.density > 0 ? p.densityStd / p.density : 0;
  const relB = Math.sqrt(relV * relV + relRho * relRho);
  const biomassStd = biomass * relB;

  // Carbon = cf B.
  const carbon = p.carbonFraction * biomass;
  const relCf = p.carbonFraction > 0 ? p.carbonFractionStd / p.carbonFraction : 0;
  const relC = Math.sqrt(relB * relB + relCf * relCf);
  const carbonStd = carbon * relC;

  // CO₂e — exact constant.
  const co2e = carbon * CO2_PER_C;
  const co2eStd = carbonStd * CO2_PER_C;

  return {
    treeId: t.treeId, volume, volumeStd, biomass, biomassStd, carbon, carbonStd, co2e, co2eStd,
    density: p.density, densityStd: p.densityStd,
    carbonFraction: p.carbonFraction, carbonFractionStd: p.carbonFractionStd,
  };
}

export interface SpeciesAwareBiomass {
  /** Per-tree biomass, keyed by tree_id — each computed with ITS OWN
   *  species' density + densityStd, so a birch and a spruce in the same
   *  plot no longer share one density error bar. */
  byTree: Map<number, TreeBiomass>;
  /** How many trees had no (or an unrecognised) species assignment and
   *  used the fallback species instead. Callers must keep this visible
   *  wherever the totals are shown — a plot that's mostly fallback
   *  isn't a species-aware result. */
  fallbackCount: number;
}

/** Per-tree biomass for a whole plot, species-aware: every tree looks up
 *  its own assignment in `speciesByTree` (tree_id → species key,
 *  normally loaded from species.json) and falls back to
 *  `fallbackSpeciesKey` when unassigned — or when the stored key no
 *  longer matches a known preset. `base` supplies the params that apply
 *  to every tree regardless of species (carbon-fraction std, branch
 *  volume error); only density / densityStd / carbonFraction vary
 *  per-species. */
export function computeSpeciesAwareBiomass(
  trees: TreeQsm[],
  speciesByTree: Map<number, string>,
  fallbackSpeciesKey: string,
  base: BiomassParams,
): SpeciesAwareBiomass {
  const fallbackParams = biomassParamsForSpecies(fallbackSpeciesKey, base);
  const byTree = new Map<number, TreeBiomass>();
  let fallbackCount = 0;
  for (const t of trees) {
    const key = speciesByTree.get(t.treeId);
    const known = key !== undefined && SPECIES_DENSITIES.some(s => s.key === key);
    if (!known) fallbackCount++;
    const params = known ? biomassParamsForSpecies(key!, base) : fallbackParams;
    byTree.set(t.treeId, computeTreeBiomass(t, params));
  }
  return { byTree, fallbackCount };
}

export interface BiomassTotals {
  trees: number;
  biomass: number;
  biomassStd: number;
  carbon: number;
  carbonStd: number;
  co2e: number;
  co2eStd: number;
}

/** Plot totals, with the uncertainty combined the way the errors
 *  actually behave.
 *
 *  Summing every tree's σ in quadrature treats them all as independent,
 *  which is right for the volume term — each tree is measured from its
 *  own points — and wrong for the density. There is one density per
 *  species, applied to every tree of it, so that error is FULLY
 *  correlated: if the true basic density of pine is 6 % above the
 *  tabulated 400 kg/m³, then every pine in the plot is 6 % heavy, all in
 *  the same direction. Averaging cannot remove it.
 *
 *  Treating it as independent shrinks it by √N. For 200 pines at
 *  400 ± 25 kg/m³ — a 6.25 % density uncertainty, which dominates the
 *  per-tree error bar — the plot came back at 0.44 %, roughly fourteen
 *  times more confident than the inputs support. That figure is what a
 *  carbon claim gets quoted against.
 *
 *  So: volume errors add in quadrature across trees, and the density and
 *  carbon-fraction terms add LINEARLY within each group that shares the
 *  value, then in quadrature across groups (a birch density error and a
 *  spruce one come from different studies).
 */
export function computeBiomassTotals(perTree: TreeBiomass[]): BiomassTotals {
  let biomass = 0, carbon = 0, co2e = 0;
  // Independent part: each tree's own volume error, through its density.
  let varVolume = 0;
  // Correlated parts, accumulated per shared parameter value.
  const byDensity = new Map<string, { total: number; rel: number }>();
  const byCarbonFraction = new Map<string, { total: number; rel: number }>();

  for (const b of perTree) {
    biomass += b.biomass;
    carbon += b.carbon;
    co2e += b.co2e;

    const fromVolume = b.density * b.volumeStd;
    varVolume += fromVolume * fromVolume;

    const dk = `${b.density}|${b.densityStd}`;
    const d = byDensity.get(dk) ?? { total: 0, rel: b.density > 0 ? b.densityStd / b.density : 0 };
    d.total += b.biomass;
    byDensity.set(dk, d);

    const ck = `${b.carbonFraction}|${b.carbonFractionStd}`;
    const c = byCarbonFraction.get(ck)
      ?? { total: 0, rel: b.carbonFraction > 0 ? b.carbonFractionStd / b.carbonFraction : 0 };
    c.total += b.carbon;
    byCarbonFraction.set(ck, c);
  }

  let varBiomass = varVolume;
  for (const d of byDensity.values()) varBiomass += (d.rel * d.total) ** 2;
  const biomassStd = Math.sqrt(varBiomass);

  // Carbon carries the whole relative biomass error, plus its own
  // correlated carbon-fraction term.
  const relBiomass = biomass > 0 ? biomassStd / biomass : 0;
  let varCarbon = (relBiomass * carbon) ** 2;
  for (const c of byCarbonFraction.values()) varCarbon += (c.rel * c.total) ** 2;
  const carbonStd = Math.sqrt(varCarbon);

  return {
    trees: perTree.length,
    biomass, biomassStd,
    carbon, carbonStd,
    co2e, co2eStd: carbonStd * CO2_PER_C,
  };
}
