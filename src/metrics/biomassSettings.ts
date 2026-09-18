// The wood-density assumptions behind every biomass and carbon figure,
// in one place.
//
// WHY THIS EXISTS
// ---------------
// Biomass is ρ·V and carbon is a fraction of that, so the basic density
// ρ is the single biggest assumption under a carbon number — and PointCloudLabeler
// had two of them at once. The Metrics module carried an editable
// BiomassParams in component state (density, ±1σ, carbon fraction,
// branch-volume uncertainty, plus a "custom" fallback species). The
// Report panel ignored it and passed DEFAULT_BIOMASS_PARAMS.
//
// So a forester outside the boreal zone — where none of the five
// bundled presets is their species — set 600 kg/m³ for a tropical
// hardwood in Metrics, got a correct CSV, then generated the report and
// got a different tonnage computed at 400. Two screens in the same app
// disagreeing about how much carbon is standing in the plot, with the
// client-facing one being the wrong one, and nothing on either screen
// saying which density it used.
//
// It also meant the Metrics module's own settings vanished on every
// remount: a plot re-measured after switching panels quietly reverted
// to Scots pine.
//
// WHAT IT DOES NOT DO
// -------------------
// It does not touch the PER-TREE species assignments (species.json,
// edited in Tree Review) — those already carry their own density from
// SPECIES_DENSITIES per tree. This is only the shared fallback, which
// is what every tree uses in a stand whose species PointCloudLabeler does not ship
// a preset for.
//
// Persisted under a localStorage key mirrored to settings.json (see
// persistence/settingsStore.ts's PERSISTED_KEYS), like every other
// preference.

import { DEFAULT_BIOMASS_PARAMS, SPECIES_DENSITIES, type BiomassParams } from './biomass';

export const BIOMASS_SETTINGS_KEY = 'pointcloudlabeler-biomass-params';

/** The key the Metrics module's density inputs select when the user
 *  types their own figure — deliberately not a species. */
export const CUSTOM_SPECIES_KEY = 'custom';

export interface BiomassSettings {
  /** Which species' density the trees with NO assignment use. Either a
   *  SPECIES_DENSITIES key or CUSTOM_SPECIES_KEY. */
  fallbackSpeciesKey: string;
  params: BiomassParams;
}

export const DEFAULT_BIOMASS_SETTINGS: BiomassSettings = {
  fallbackSpeciesKey: SPECIES_DENSITIES[0]?.key ?? 'pine',
  params: DEFAULT_BIOMASS_PARAMS,
};

/** Clamp one stored number into a range, falling back to the default
 *  for anything that is not a usable number.
 *
 *  Not decoration. A stored density of 0 makes every biomass, carbon
 *  and CO₂e figure exactly zero, which is a plausible-looking answer
 *  for a plot with no QSM; a negative one makes them negative. A
 *  carbon fraction above 1 claims wood is more than entirely carbon.
 *  settings.json is a file on disk that a user can edit, and JSON has
 *  no NaN, so a corrupted or hand-edited value arrives as a string or
 *  as null and must not reach the arithmetic. */
function num(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback;
}

/** Validate whatever was stored into settings usable as-is. Total: every
 *  input maps to a complete, in-range BiomassSettings. */
export function normaliseBiomassSettings(raw: unknown): BiomassSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_BIOMASS_SETTINGS;
  const o = raw as Record<string, unknown>;
  const p = (typeof o.params === 'object' && o.params !== null ? o.params : {}) as Record<string, unknown>;
  const d = DEFAULT_BIOMASS_PARAMS;

  const key = typeof o.fallbackSpeciesKey === 'string'
    && (o.fallbackSpeciesKey === CUSTOM_SPECIES_KEY
      || SPECIES_DENSITIES.some(s => s.key === o.fallbackSpeciesKey))
    ? o.fallbackSpeciesKey
    : DEFAULT_BIOMASS_SETTINGS.fallbackSpeciesKey;

  return {
    fallbackSpeciesKey: key,
    params: {
      // 50–1400 kg/m³ spans balsa (~160) to lignum vitae (~1230) with
      // room either side; nothing real sits outside it.
      density: num(p.density, 50, 1400, d.density),
      densityStd: num(p.densityStd, 0, 500, d.densityStd),
      // Oven-dry wood is 45–55 % carbon across every species measured;
      // the bounds are wider than that and still exclude nonsense.
      carbonFraction: num(p.carbonFraction, 0.2, 1, d.carbonFraction),
      carbonFractionStd: num(p.carbonFractionStd, 0, 0.5, d.carbonFractionStd),
      branchUncFraction: num(p.branchUncFraction, 0, 2, d.branchUncFraction),
    },
  };
}

export function loadBiomassSettings(): BiomassSettings {
  try {
    const raw = localStorage.getItem(BIOMASS_SETTINGS_KEY);
    if (!raw) return DEFAULT_BIOMASS_SETTINGS;
    return normaliseBiomassSettings(JSON.parse(raw));
  } catch {
    // Unreadable storage, or a stored string that is not JSON — the
    // defaults are still a correct answer.
    return DEFAULT_BIOMASS_SETTINGS;
  }
}

export function saveBiomassSettings(s: BiomassSettings): BiomassSettings {
  const clean = normaliseBiomassSettings(s);
  try {
    localStorage.setItem(BIOMASS_SETTINGS_KEY, JSON.stringify(clean));
  } catch {
    /* preference just doesn't persist */
  }
  return clean;
}

/** Choose the fallback species, carrying its published density across.
 *
 *  The three values that ARE the species — density, its ±1σ and the
 *  carbon fraction — follow the choice; the two that are analysis
 *  settings rather than facts about wood (the carbon-fraction
 *  uncertainty, the branch-volume error) ride through untouched, the
 *  same split `biomassParamsForSpecies` makes.
 *
 *  CUSTOM_SPECIES_KEY changes nothing but the key: the user's own
 *  figures are the point of it, and overwriting them with a preset's
 *  would be the opposite.
 *
 *  Shared so the two panels that offer this picker cannot drift — which
 *  is exactly what happened when they each kept their own copy. */
export function withFallbackSpecies(s: BiomassSettings, key: string): BiomassSettings {
  const preset = SPECIES_DENSITIES.find(x => x.key === key);
  if (!preset) return normaliseBiomassSettings({ ...s, fallbackSpeciesKey: key });
  return normaliseBiomassSettings({
    fallbackSpeciesKey: key,
    params: {
      ...s.params,
      density: preset.density,
      densityStd: preset.densityStd,
      carbonFraction: preset.carbonFraction,
    },
  });
}

/** The density these settings actually apply to an unassigned tree, and
 *  the name to print beside it.
 *
 *  A report that quotes tonnes of carbon has to say what density it used
 *  — it is the largest single assumption in the number, and a reader
 *  cannot check the figure without it. */
export function fallbackDensityLabel(s: BiomassSettings): { label: string; density: number } {
  const preset = SPECIES_DENSITIES.find(x => x.key === s.fallbackSpeciesKey);
  return preset
    ? { label: preset.label, density: preset.density }
    : { label: 'custom density', density: s.params.density };
}
