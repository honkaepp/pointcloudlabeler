import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LAASASENAHO_1982, MIN_HEIGHT_M, DEFAULT_FORM_FACTOR, speciesFunction } from '../metrics/volumeFunctions';
import { SPECIES_DENSITIES, DEFAULT_BIOMASS_PARAMS } from '../metrics/biomass';

/** The forestry arithmetic after the per-tree measurements exists twice:
 *  in the renderer (volume functions, biomass, plot statistics and the
 *  plot-boundary geometry — what the panels and the report show) and in
 *  Rust (src-tauri/src/ops/forestry.rs — what the command line, the
 *  console, the API and the MCP tools return as metrics.volumes,
 *  metrics.biomass and metrics.plot). A plot must come out the same on
 *  both, so every constant one side states is read out of the other
 *  here: the published coefficients, the wood densities, the fallbacks,
 *  the sample counts. A change on one side fails this test until it is
 *  made on the other. */
const rs = readFileSync(new URL('../../src-tauri/src/ops/forestry.rs', import.meta.url), 'utf8');
const plotBoundary = readFileSync(new URL('../utils/plotBoundary.ts', import.meta.url), 'utf8');
const plotStats = readFileSync(new URL('../metrics/plotStats.ts', import.meta.url), 'utf8');
const biomassSettings = readFileSync(new URL('../metrics/biomassSettings.ts', import.meta.url), 'utf8');
const volumeFunctions = readFileSync(new URL('../metrics/volumeFunctions.ts', import.meta.url), 'utf8');

const num = (s: string) => Number(s);

describe('the volume functions agree between the renderer and the headless core', () => {
  it('carry the same Laasasenaho 1982 coefficients, unrounded', () => {
    // `VolumeSpecies::Pine => VolumeCoefficients { a1: …, a2: …, … }`
    const rsCoef: Record<string, Record<string, number>> = {};
    for (const m of rs.matchAll(/VolumeSpecies::(\w+) => VolumeCoefficients \{ a1: ([-\d.]+), a2: ([-\d.]+), a3: ([-\d.]+), a4: ([-\d.]+), a5: ([-\d.]+) \}/g)) {
      rsCoef[m[1].toLowerCase()] = { a1: num(m[2]), a2: num(m[3]), a3: num(m[4]), a4: num(m[5]), a5: num(m[6]) };
    }
    expect(Object.keys(rsCoef).sort()).toEqual(Object.keys(LAASASENAHO_1982).sort());
    for (const [sp, c] of Object.entries(LAASASENAHO_1982)) {
      expect(rsCoef[sp], sp).toEqual(c);
    }
  });

  it('refuse a tree below the same height, and fall back to the same form factor', () => {
    expect(rs).toMatch(new RegExp(`pub const MIN_HEIGHT_M: f64 = ${MIN_HEIGHT_M}\\.0;`));
    expect(rs).toMatch(new RegExp(`pub const DEFAULT_FORM_FACTOR: f64 = ${DEFAULT_FORM_FACTOR.toFixed(2)};`));
    // dm³ → m³ at the same place, and centimetres in.
    expect(volumeFunctions).toMatch(/const d = dbhM \* 100;/);
    expect(rs).toMatch(/let d = dbh_m \* 100\.0;/);
    expect(volumeFunctions).toMatch(/vdm3 \/ 1000/);
    expect(rs).toMatch(/vdm3 \/ 1000\.0/);
  });

  it('resolve the same species names onto the same functions', () => {
    const arms = rs.slice(rs.indexOf('pub fn species_function'), rs.indexOf('}', rs.indexOf('_ => None')));
    const rsNames: Record<string, string> = {};
    for (const m of arms.matchAll(/((?:"[^"]+"\s*\|\s*)*"[^"]+")\s*=> Some\(VolumeSpecies::(\w+)\)/g)) {
      for (const n of m[1].matchAll(/"([^"]+)"/g)) rsNames[n[1]] = m[2].toLowerCase();
    }
    expect(Object.keys(rsNames).sort()).toEqual(['birch', 'koivu', 'kuusi', 'manty', 'mänty', 'pine', 'spruce']);
    for (const [name, sp] of Object.entries(rsNames)) {
      expect(speciesFunction(name), name).toBe(sp);
    }
    // And the species with no function are refused on both sides.
    for (const s of SPECIES_DENSITIES.map(s => s.key).filter(k => !(k in rsNames))) {
      expect(speciesFunction(s), s).toBeNull();
    }
  });
});

describe('the biomass arithmetic agrees between the renderer and the headless core', () => {
  it('tabulates the same wood densities, uncertainties and carbon fractions', () => {
    const rows: Record<string, { density: number; densityStd: number; carbonFraction: number; label: string; source: string }> = {};
    for (const m of rs.matchAll(/SpeciesDensity \{ key: "(\w+)", label: "([^"]+)", density: ([\d.]+), density_std: ([\d.]+), carbon_fraction: ([\d.]+), source: "([^"]+)" \}/g)) {
      rows[m[1]] = { label: m[2], density: num(m[3]), densityStd: num(m[4]), carbonFraction: num(m[5]), source: m[6] };
    }
    expect(Object.keys(rows)).toEqual(SPECIES_DENSITIES.map(s => s.key));
    for (const s of SPECIES_DENSITIES) {
      expect(rows[s.key], s.key).toEqual({
        label: s.label, density: s.density, densityStd: s.densityStd, carbonFraction: s.carbonFraction, source: s.source,
      });
    }
  });

  it('starts from the same default parameters', () => {
    const block = rs.slice(rs.indexOf('pub const DEFAULT_BIOMASS_PARAMS'), rs.indexOf('};', rs.indexOf('pub const DEFAULT_BIOMASS_PARAMS')));
    const rsDefaults = Object.fromEntries(
      [...block.matchAll(/(\w+): ([\d.]+),/g)].map(m => [m[1].replace(/_(\w)/g, (_, c) => c.toUpperCase()), num(m[2])]));
    expect(rsDefaults).toEqual(DEFAULT_BIOMASS_PARAMS);
  });

  it('accepts the same ranges for a custom density', () => {
    // biomassSettings.ts: num(p.density, 50, 1400, …)
    const tsRanges = Object.fromEntries(
      [...biomassSettings.matchAll(/(\w+): num\(p\.\w+, ([\d.]+), ([\d.]+), d\.\w+\)/g)].map(m => [m[1], [num(m[2]), num(m[3])]]));
    const rsRanges = Object.fromEntries(
      [...rs.matchAll(/\("(\w+)", ([\d.]+), ([\d.]+)\),/g)].map(m => [m[1], [num(m[2]), num(m[3])]]));
    expect(Object.keys(tsRanges)).toHaveLength(5);
    expect(rsRanges).toEqual(tsRanges);
  });

  it('uses the same fallback species and the same custom key', () => {
    expect(biomassSettings).toMatch(/CUSTOM_SPECIES_KEY = 'custom'/);
    expect(rs).toMatch(/pub const CUSTOM_SPECIES_KEY: &str = "custom";/);
    expect(biomassSettings).toMatch(/fallbackSpeciesKey: SPECIES_DENSITIES\[0\]\?\.key \?\? 'pine'/);
    expect(SPECIES_DENSITIES[0].key).toBe('pine');
    expect(rs).toMatch(/fn pine_key\(\) -> String \{ "pine"\.into\(\) \}/);
  });

  it('converts carbon to CO2e with the same constant', () => {
    expect(rs).toMatch(/const CO2_PER_C: f64 = 44\.0 \/ 12\.0;/);
  });
});

describe('the plot statistics agree between the renderer and the headless core', () => {
  it('sample the crown disk at the same points', () => {
    expect(plotBoundary).toMatch(/const N = 64;/);
    expect(rs).toMatch(/pub const CROWN_SAMPLES: usize = 64;/);
    // ρ = r·√((i + 0.5) / N), θ = i · π(3 − √5), on both sides.
    expect(plotBoundary).toMatch(/Math\.sqrt\(\(i \+ 0\.5\) \/ N\)/);
    expect(rs).toMatch(/\(\(i as f64 \+ 0\.5\) \/ n as f64\)\.sqrt\(\)/);
    expect(plotBoundary).toMatch(/Math\.PI \* \(3 - Math\.sqrt\(5\)\)/);
    expect(rs).toMatch(/PI \* \(3\.0 - 5f64\.sqrt\(\)\)/);
  });

  it('give a boundary tree the same half weight in the same band', () => {
    expect(plotBoundary).toMatch(/halfcountBuffer: number = 1\.0/);
    expect(rs).toMatch(/fn f_1\(\) -> f64 \{ 1\.0 \}/);
    expect(rs).toMatch(/#\[serde\(default = "f_1"\)\]\s+pub halfcount_buffer: f64/);
    expect(plotBoundary).toMatch(/Math\.abs\(sd\) <= halfcountBuffer \? 0\.5 : 1\.0/);
    expect(rs).toMatch(/sd\.abs\(\) <= halfcount_buffer \{\s+0\.5/);
  });

  it('never shrink a fitted circle below the same radius', () => {
    expect(plotBoundary).toMatch(/Math\.max\(1\.0, rMax - margin\)/);
    expect(rs).toMatch(/pub const MIN_FITTED_RADIUS: f64 = 1\.0;/);
  });

  it('take the dominant height from the same top fraction', () => {
    expect(plotStats).toMatch(/topFractionMean\(withHeight\.map\(t => t\.height\), 0\.10\)/);
    expect(rs).toMatch(/pub const DOMINANT_FRACTION: f64 = 0\.10;/);
  });

  it('guard the per-hectare division the same way', () => {
    expect(plotStats).toMatch(/Math\.max\(areaHa, 1e-6\)/);
    expect(rs).toMatch(/area_ha\.max\(1e-6\)/);
  });

  it('default to the panel\'s edge correction', () => {
    const panel = readFileSync(new URL('../components/shell/PlotBoundaryPanel.tsx', import.meta.url), 'utf8');
    expect(panel).toMatch(/useState<EdgeCorrection>\('crownArea'\)/);
    expect(rs).toMatch(/fn crown_area\(\) -> EdgeCorrection \{ EdgeCorrection::CrownArea \}/);
  });
});

/** The thinning simulator decides which trees get cut. Its weights,
 *  its tie-breaker and its defaults are the plan; the headless run and
 *  the panel must produce the same one from the same stand. */
describe('the thinning simulator agrees between the renderer and the headless core', () => {
  const thinningTs = readFileSync(new URL('../metrics/thinning.ts', import.meta.url), 'utf8');
  const thinningRs = readFileSync(new URL('../../src-tauri/src/ops/thinning.rs', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../components/shell/ThinningPanel.tsx', import.meta.url), 'utf8');

  it('weights the strategies the same way', () => {
    const tsW = Object.fromEntries(
      [...thinningTs.matchAll(/case '(\w+)':\s+w = \{ qual: ([\d.]+),\s+small: ([\d.]+),\s+large: ([\d.]+) \}/g)]
        .map(m => [m[1], [num(m[2]), num(m[3]), num(m[4])]]));
    const rsW = Object.fromEntries(
      [...thinningRs.matchAll(/Strategy::(\w+) => Weights \{ qual: ([\d.]+), small: ([\d.]+), large: ([\d.]+) \}/g)]
        .map(m => [m[1].toLowerCase(), [num(m[2]), num(m[3]), num(m[4])]]));
    expect(Object.keys(tsW).sort()).toEqual(['high', 'low', 'mixed', 'quality']);
    expect(rsW).toEqual(tsW);
  });

  it('breaks ties with the same hash and the same weight, and guesses volume with the same form factor', () => {
    expect(thinningTs).toMatch(/2654435761 % 4294967296\) \/ 4294967296/);
    expect(thinningRs).toMatch(/wrapping_mul\(2_654_435_761\)\) % 4_294_967_296\) as f64 \/ 4_294_967_296\.0/);
    expect(thinningTs).toMatch(/JITTER_WEIGHT = 0\.05;/);
    expect(thinningRs).toMatch(/pub const JITTER_WEIGHT: f64 = 0\.05;/);
    expect(thinningTs).toMatch(/FORM_FACTOR = 0\.50;/);
    expect(thinningRs).toMatch(/pub const FORM_FACTOR: f64 = 0\.50;/);
    // The "cannot reach target" tolerance.
    expect(thinningTs).toMatch(/baAfter > o\.targetBaPerHa \+ 0\.05/);
    expect(thinningRs).toMatch(/ba_after > o\.target_ba_per_ha \+ 0\.05/);
  });

  it('starts from the panel\'s defaults', () => {
    const tsDefaults: Record<string, number | string> = {
      targetBaPerHa: num(panel.match(/useState\((\d+)\);\s+\/\/ m²\/ha/)![1]),
      roadSpacing: num(panel.match(/setRoadSpacing\] = useState\((\d+)\)/)![1]),
      roadWidth: num(panel.match(/setRoadWidth\] = useState\((\d+)\)/)![1]),
      boomReach: num(panel.match(/setBoomReach\] = useState\((\d+)\)/)![1]),
      pricePerM3: num(panel.match(/setPricePerM3\] = useState\((\d+)\)/)![1]),
      strategy: panel.match(/useState<Strategy>\('(\w+)'\)/)![1],
    };
    expect(tsDefaults).toEqual({ targetBaPerHa: 18, roadSpacing: 20, roadWidth: 4, boomReach: 10, pricePerM3: 35, strategy: 'low' });
    const rsDefault = (field: string) => thinningRs.match(new RegExp(`#\\[serde\\(default = "(\\w+)"\\)\\]\\s+pub ${field}:`))![1];
    const rsFn = (name: string) => thinningRs.match(new RegExp(`fn ${name}\\(\\) -> f64 \\{ ([\\d.]+) \\}`))![1];
    expect(num(rsFn(rsDefault('target_ba_per_ha')))).toBe(18);
    expect(num(rsFn(rsDefault('road_spacing')))).toBe(20);
    expect(num(rsFn(rsDefault('road_width')))).toBe(4);
    expect(num(rsFn(rsDefault('boom_reach')))).toBe(10);
    expect(num(rsFn(rsDefault('price_per_m3')))).toBe(35);
    expect(thinningRs).toMatch(/fn low\(\) -> Strategy \{ Strategy::Low \}/);
    expect(thinningRs).toMatch(/#\[serde\(default = "low"\)\]\s+pub strategy: Strategy/);
  });

  it('writes the same CSV columns', () => {
    const header = 'tree_id,reason,x,y,dbh_cm,height_m,ba_m2,volume_m3,volume_source,confidence';
    expect(panel).toContain(`'${header}'`);
    expect(thinningRs).toContain(`"${header}\\n"`);
  });

  it('quotes money in the same default currency, capped at the same length', () => {
    const currency = readFileSync(new URL('../metrics/currency.ts', import.meta.url), 'utf8');
    expect(currency).toMatch(/DEFAULT_CURRENCY = '€'/);
    expect(currency).toMatch(/MAX_CURRENCY_LEN = 8;/);
    expect(thinningRs).toMatch(/pub const DEFAULT_CURRENCY: &str = "€";/);
    expect(thinningRs).toMatch(/pub const MAX_CURRENCY_LEN: usize = 8;/);
  });
});

/** The report is the document a stand gets measured by. */
describe('the report agrees between the renderer and the headless core', () => {
  const generate = readFileSync(new URL('../report/generate.ts', import.meta.url), 'utf8');
  const reportRs = readFileSync(new URL('../../src-tauri/src/ops/report.rs', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../components/shell/ReportPanel.tsx', import.meta.url), 'utf8');

  it('labels the plot-area basis with the same words', () => {
    expect(generate).toMatch(/'boundary'\) return 'defined plot boundary'/);
    expect(generate).toMatch(/'manual'\) return 'manual entry'/);
    expect(generate).toMatch(/return 'estimated — tree bbox'/);
    expect(rs).toMatch(/AreaBasis::Boundary => "defined plot boundary"/);
    expect(rs).toMatch(/AreaBasis::Manual => "manual entry"/);
    expect(rs).toMatch(/AreaBasis::Bbox => "estimated — tree bbox"/);
  });

  it('estimates the area from the bbox with the same floor, and divides by the same one', () => {
    expect(panel).toMatch(/Math\.max\(0\.0025, span \/ 10000\)/);
    expect(rs).toMatch(/pub const MIN_ESTIMATED_AREA_HA: f64 = 0\.0025;/);
    expect(generate).toMatch(/Math\.max\(0\.0001, inp\.plotAreaHa\)/);
    expect(reportRs).toMatch(/const HA_FLOOR: f64 = 0\.0001;/);
    expect(panel).toMatch(/useState\(35\)/);
    expect(reportRs).toMatch(/fn f_35\(\) -> f64 \{ 35\.0 \}/);
  });

  it('widens the biomass figures to the same 95 % interval', () => {
    expect(panel).toMatch(/biomassKgCi95: 1\.96 \* biomassTotals\.biomassStd/);
    expect(reportRs).toMatch(/biomass_kg_ci95: 1\.96 \* totals\.biomass_std/);
  });

  it('cites the same sources, in the same words', () => {
    const quotes = [
      'Raumonen, P. et al. (2013), <i>Fast Automatic Precision Tree Models from Terrestrial Laser Scanner Data</i>, Remote Sensing 5(2):491–520.',
      'Repola, J. (2006), <i>Models for vertical wood density of Scots pine, Norway spruce and birch stems</i>, Silva Fennica 40(4):673–685',
      'supplied by the analyst, not taken from a published table',
      'Horn, B.K.P. (1981) slope/aspect and hillshade, Mark, R.K. (1992) multidirectional hillshade, Weiss, A. (2001) TPI, Zevenbergen, L.W. & Thorne, C.R. (1987) curvature.',
      'from the RANSAC stem fit, the rest algebraic',
      'had no species assignment and used the',
      'Every tree carried its own species assignment.',
      'uniform-grade',
    ];
    for (const q of quotes) {
      expect(generate, q).toContain(q);
      expect(reportRs, q).toContain(q);
    }
  });

  it('runs the density pass with the panel\'s settings', () => {
    expect(panel).toMatch(/octreeDensityMetrics\(octree\.dir, 2\.0, \{\s+minHeight: 0\.2, canopyThreshold: 2\.0,/);
    expect(reportRs).toMatch(/run_density_metrics\(&dsink, &p\.octree_dir, 2\.0, 0\.2, 2\.0, None\)/);
  });
});

/** Bucking decides what the stand is worth. */
describe('bucking agrees between the renderer and the headless core', () => {
  const buckingTs = readFileSync(new URL('../metrics/bucking.ts', import.meta.url), 'utf8');
  const buckingRs = readFileSync(new URL('../../src-tauri/src/ops/bucking.rs', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../components/shell/BuckingPanel.tsx', import.meta.url), 'utf8');

  it('ships the same default assortments and stump height', () => {
    const tsA = [...panel.matchAll(/\{ id: '(\w+)',\s+name: '(\w+)',\s*minTopDcm:\s*(\d+), lengths: \[([\d., ]+)\], pricePerM3: (\d+), colour: '(#[0-9a-f]+)' \}/g)]
      .map(m => ({ id: m[1], name: m[2], minTopDcm: num(m[3]), lengths: m[4].split(',').map(x => num(x.trim())), pricePerM3: num(m[5]), colour: m[6] }));
    const rsA = [...buckingRs.matchAll(/Assortment \{ id: "(\w+)"\.into\(\), name: "(\w+)"\.into\(\), min_top_dcm: ([\d.]+), lengths: vec!\[([\d., ]+)\], price_per_m3: ([\d.]+), colour: "(#[0-9a-f]+)"\.into\(\) \}/g)]
      .map(m => ({ id: m[1], name: m[2], minTopDcm: num(m[3]), lengths: m[4].split(',').map(x => num(x.trim())), pricePerM3: num(m[5]), colour: m[6] }));
    expect(tsA.map(a => a.id)).toEqual(['saw', 'pulp', 'energy']);
    expect(rsA).toEqual(tsA);
    expect(panel).toMatch(/setStumpHeight\] = useState\(0\.10\)/);
    expect(buckingRs).toMatch(/pub const DEFAULT_STUMP_HEIGHT: f64 = 0\.10;/);
  });

  it('places the taper points, integrates and stops at the same place', () => {
    expect(buckingTs).toMatch(/Math\.max\(0\.05, slices\[1\]\.hag - slices\[0\]\.hag\)\s*:\s*0\.25/);
    expect(buckingRs).toMatch(/\(slices\[1\]\.0 - slices\[0\]\.0\)\.max\(0\.05\) \} else \{ 0\.25 \}/);
    expect(buckingTs).toMatch(/\(Math\.PI \/ 12\) \* length/);
    expect(buckingRs).toMatch(/\(std::f64::consts::PI \/ 12\.0\) \* length/);
    expect(buckingTs).toMatch(/r\.measuredTop < r\.height \* 0\.8/);
    expect(buckingRs).toMatch(/pub const PARTIAL_MEASURE_FRACTION: f64 = 0\.8;/);
    expect(buckingTs).toMatch(/if \(dTop \* 100 < a\.minTopDcm\) continue;/);
    expect(buckingRs).toMatch(/if d_top \* 100\.0 < a\.min_top_dcm \{/);
  });

  it('writes the same CSV columns', () => {
    for (const col of ["'tree_id', 'height_m', 'measured_top_m', 'stem_volume_m3'", "'stump_m3', 'residue_m3', 'waste_m3', `total_${rev}`"]) {
      expect(panel).toContain(col);
    }
    expect(buckingRs).toContain('"tree_id".to_string(), "height_m".into(), "measured_top_m".into(), "stem_volume_m3".into()');
    expect(buckingRs).toContain('"stump_m3".to_string(), "residue_m3".into(), "waste_m3".into(), format!("total_{rev}")');
    const currency = readFileSync(new URL('../metrics/currency.ts', import.meta.url), 'utf8');
    expect(currency).toMatch(/letters \? `revenue_\$\{letters\}` : 'revenue'/);
    expect(buckingRs).toMatch(/if letters\.is_empty\(\) \{ "revenue"\.into\(\) \} else \{ format!\("revenue_\{letters\}"\) \}/);
  });
});

/** Growth and validation rest on the same matching and the same rule:
 *  a figure only over what both sides measured. */
describe('growth and field validation agree between the renderer and the headless core', () => {
  const growthTs = readFileSync(new URL('../metrics/growth.ts', import.meta.url), 'utf8');
  const growthRs = readFileSync(new URL('../../src-tauri/src/ops/growth.rs', import.meta.url), 'utf8');
  const validationTs = readFileSync(new URL('../metrics/fieldValidation.ts', import.meta.url), 'utf8');
  const validationRs = readFileSync(new URL('../../src-tauri/src/ops/validation.rs', import.meta.url), 'utf8');
  const assignmentTs = readFileSync(new URL('../metrics/assignment.ts', import.meta.url), 'utf8');
  const matchingRs = readFileSync(new URL('../../src-tauri/src/ops/matching.rs', import.meta.url), 'utf8');
  const growthPanel = readFileSync(new URL('../components/shell/TreeGrowthPanel.tsx', import.meta.url), 'utf8');
  const validationPanel = readFileSync(new URL('../components/shell/ValidationPanel.tsx', import.meta.url), 'utf8');

  it('starts from the panels\' defaults', () => {
    expect(growthPanel).toMatch(/setYears\] = useState\(5\)/);
    expect(growthPanel).toMatch(/setSearchRadius\] = useState\(1\.5\)/);
    expect(growthPanel).toMatch(/setFormFactor\] = useState\(0\.50\)/);
    expect(growthRs).toMatch(/fn f_5\(\) -> f64 \{ 5\.0 \}/);
    expect(growthRs).toMatch(/#\[serde\(default = "f_5"\)\]\s+pub years: f64/);
    expect(growthRs).toMatch(/#\[serde\(default = "f_1_5"\)\]\s+pub search_radius: f64/);
    expect(growthRs).toMatch(/#\[serde\(default = "f_0_5"\)\]\s+pub form_factor: f64/);
    expect(validationPanel).toMatch(/setSearchRadius\] = useState\(2\.0\)/);
    expect(validationRs).toMatch(/#\[serde\(default = "f_2"\)\]\s+pub search_radius: f64/);
  });

  it('matches on squared distance with the same bound for a forbidden pair', () => {
    expect(assignmentTs).toMatch(/const big = \(maxReal \+ 1\) \* \(Math\.min\(n, m\) \+ 1\);/);
    expect(matchingRs).toMatch(/let big = \(max_real \+ 1\.0\) \* \(n\.min\(m\) as f64 \+ 1\.0\);/);
    expect(assignmentTs).toMatch(/return d2 <= r2 \? d2 : Infinity;/);
    expect(matchingRs).toMatch(/if d2 <= r2 \{ d2 \} else \{ FORBIDDEN \}/);
    expect(growthTs).toMatch(/Number\.isFinite\(t\.basalArea\) \? t\.basalArea \* t\.height \* f : NaN/);
    expect(growthRs).toMatch(/if t\.basal_area\.is_finite\(\) \{ t\.basal_area \* t\.height \* f \} else \{ f64::NAN \}/);
  });

  it('recognises the same field headers', () => {
    const tsNames = [...validationTs.matchAll(/(\w+Col): find\(([^)]+)\)/g)].map(m => [m[1], m[2].replace(/['\s]/g, '')]);
    const rsNames = [...validationRs.matchAll(/(\w+)_col: find\(&\[([^\]]+)\]\)/g)].map(m => [m[1], m[2].replace(/["\s]/g, '')]);
    expect(tsNames).toHaveLength(6);
    expect(rsNames.map(([k, v]) => [k.replace(/_(\w)/g, (_, c) => c.toUpperCase()) + 'Col', v])).toEqual(tsNames);
  });

  it('writes the same CSV columns', () => {
    const growthHeader = 'status,ref_id,now_id,x,y,dbh_ref_cm,dbh_now_cm,ddbh_cm,h_ref_m,h_now_m,dh_m,v_ref_m3,v_now_m3,dv_m3';
    expect(growthPanel).toContain(`'${growthHeader}'`);
    expect(growthRs).toContain(`"${growthHeader}\\n"`);
    const validationHeader = 'field_id,field_x,field_y,caliper_dbh_cm,pointcloudlabeler_dbh_cm,dbh_diff_cm,hyp_height_m,pointcloudlabeler_height_m,height_diff_m,match_distance_m,status';
    expect(validationPanel).toContain(`'${validationHeader}'`);
    expect(validationRs).toContain(`"${validationHeader}\\n"`);
  });

  it('reads CSV with the same delimiter preference and number rule', () => {
    const csvTs = readFileSync(new URL('../io/csv.ts', import.meta.url), 'utf8');
    const csvRs = readFileSync(new URL('../../src-tauri/src/ops/csvtext.rs', import.meta.url), 'utf8');
    expect(csvTs).toMatch(/const DELIMITERS = \[';', '\\t', ',', ' '\];/);
    expect(csvRs).toMatch(/const DELIMITERS: \[char; 4\] = \[';', '\\t', ',', ' '\];/);
    expect(csvTs).toMatch(/const score = mean - variance;/);
    expect(csvRs).toMatch(/let score = mean - variance;/);
    expect(csvTs).toMatch(/const sample = lines\.slice\(0, 5\);/);
    expect(csvRs).toMatch(/take\(5\)/);
  });
});

/** The cross-sensor comparison, its model and the per-tree CSV. */
describe('the cross-sensor comparison and the metrics CSV agree between the renderer and the headless core', () => {
  const crossTs = readFileSync(new URL('../metrics/crossSensor.ts', import.meta.url), 'utf8');
  const modelTs = readFileSync(new URL('../metrics/treeModel.ts', import.meta.url), 'utf8');
  const crossRs = readFileSync(new URL('../../src-tauri/src/ops/crosssensor.rs', import.meta.url), 'utf8');
  const csvRs = readFileSync(new URL('../../src-tauri/src/ops/metricscsv.rs', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../components/shell/CrossSensorPanel.tsx', import.meta.url), 'utf8');
  const metricsModule = readFileSync(new URL('../modules/MetricsModule.tsx', import.meta.url), 'utf8');
  const tqsmTs = readFileSync(new URL('../metrics/qsmAttributesCsv.ts', import.meta.url), 'utf8');

  const list = (src: string, re: RegExp) => [...src.match(re)![1].matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);

  it('uses the same diameter classes, radius, header and model defaults', () => {
    expect(crossTs).toMatch(/DEFAULT_DBH_CLASSES: readonly number\[\] = \[0\.05, 0\.15, 0\.25, 0\.35, 0\.45\]/);
    expect(crossRs).toMatch(/pub const DEFAULT_DBH_CLASSES: \[f64; 5\] = \[0\.05, 0\.15, 0\.25, 0\.35, 0\.45\]/);
    expect(panel).toMatch(/setRadius\] = useState\(2\.5\)/);
    expect(crossRs).toMatch(/fn f_2_5\(\) -> f64 \{ 2\.5 \}/);
    expect(crossRs).toMatch(/#\[serde\(default = "f_2_5"\)\]\s+pub radius: f64/);
    expect(list(crossTs, /JOINED_CSV_HEADER = \[([^\]]+)\]/)).toEqual(list(crossRs, /JOINED_CSV_HEADER: \[&str; 11\] = \[([^\]]+)\]/));
    expect(modelTs).toMatch(/predictors: \['height', 'crownArea'\],\s+form: 'loglog'/);
    expect(crossRs).toMatch(/predictors: vec!\[Predictor::Height, Predictor::CrownArea\], form: ModelForm::Loglog/);
    expect(modelTs).toMatch(/MIN_PAIRS_PER_PREDICTOR = 8;/);
    expect(crossRs).toMatch(/pub const MIN_PAIRS_PER_PREDICTOR: usize = 8;/);
    expect(modelTs).toMatch(/folds = 5/);
    expect(crossRs).toMatch(/fn u_5\(\) -> u32 \{ 5 \}/);
    expect(modelTs).toMatch(/Math\.abs\(m\[piv\]\[col\]\) < 1e-12/);
    expect(crossRs).toMatch(/m\[piv\]\[col\]\.abs\(\) < 1e-12/);
  });

  it('writes the metrics table with the same columns', () => {
    expect(list(metricsModule, /const baseHeader = \[([^\]]+)\]/)).toEqual(list(csvRs, /BASE_HEADER: \[&str; 14\] = \[([^\]]+)\]/));
    expect(list(tqsmTs, /TQSM_COLUMNS = \[([^\]]+)\]/)).toEqual(list(csvRs, /TQSM_COLUMNS: \[&str; 31\] = \[([^\]]+)\]/));
    for (const col of ["'qsm_stem_volume_m3', 'qsm_stem_volume_std_m3', 'qsm_stem_volume_ci95_m3'", "'qsm_branch_volume_m3', 'qsm_branch_count', 'qsm_total_volume_m3'", "'qsm_confidence', 'qsm_completeness', 'qsm_accepted_slices', 'qsm_rejected_slices'", "'biomass_kg', 'biomass_ci95_kg', 'carbon_kg', 'carbon_ci95_kg', 'co2e_kg', 'co2e_ci95_kg'"]) {
      expect(metricsModule).toContain(col);
      expect(csvRs).toContain(col.replace(/'/g, '"'));
    }
    expect(metricsModule).toMatch(/csvNum\(1\.96 \* bm\.biomassStd, 2\)/);
    expect(csvRs).toMatch(/1\.96 \* b\.biomass_std\), 2/);
  });
});
