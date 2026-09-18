// Finnish national stem-volume functions (Laasasenaho 1982).
//
// PointCloudLabeler has three ways to put a volume on a tree, and until now only two
// of them existed:
//
//   1. A QSM — cylinders fitted to the measured stem. The best number
//      there is, and it needs a ground-based scan of a stem the sensor
//      could actually see.
//   2. A form factor: basal area × height × 0.50. A constant, applied to
//      every tree of every species and size. It is a placeholder, and it
//      was being multiplied by a price per cubic metre.
//   3. This: a published allometric function of diameter and height,
//      fitted to thousands of felled and sectioned Finnish trees.
//
// (3) is what Finnish forestry actually uses when a stem has not been
// sectioned, and it is what the form factor was standing in for.
//
//   Laasasenaho, J. 1982. Taper curve and volume functions for pine,
//   spruce and birch. Communicationes Instituti Forestalis Fenniae 108.
//
// Implemented from the published functional form, not ported from any
// package's source.
//
// > **Verify the coefficients against the primary source before using
// > these numbers in anything binding.** The table below reproduces the
// > published values, the functional form is standard, and the outputs
// > sit where Finnish forestry expects them (see the check values in the
// > tests) — but a digit error in a fifth decimal would not show up in a
// > magnitude check, and a volume function is exactly the kind of silent
// > wrong number that survives for years.

import type { TreeMetric } from '../persistence/octreeReader';

/** The five coefficients of
 *    V = a1 · d^a2 · a3^d · h^a4 · (h − 1.3)^a5
 *  with V in cubic decimetres, d the breast-height diameter in
 *  CENTIMETRES and h the total height in METRES. The unit mismatch with
 *  the rest of PointCloudLabeler (metres everywhere) is the function's, not ours —
 *  it is converted at the boundary and never leaks. */
export interface VolumeCoefficients {
  a1: number; a2: number; a3: number; a4: number; a5: number;
}

/** Species PointCloudLabeler can resolve a national function for. Keys match
 *  SPECIES_DENSITIES in metrics/biomass. */
export type VolumeSpecies = 'pine' | 'spruce' | 'birch';

export const LAASASENAHO_1982: Readonly<Record<VolumeSpecies, VolumeCoefficients>> = {
  pine:   { a1: 0.036089, a2: 2.01395, a3: 0.99676, a4: 2.07025, a5: -1.07209 },
  spruce: { a1: 0.022927, a2: 1.91505, a3: 0.99146, a4: 2.82541, a5: -1.53547 },
  birch:  { a1: 0.011197, a2: 2.10253, a3: 0.98600, a4: 3.98519, a5: -2.65900 },
};

/** How a PointCloudLabeler species key maps onto a function.
 *
 *  Aspen and oak have no Laasasenaho function — they are outside the
 *  three species it was fitted for. Rather than quietly borrowing
 *  birch's curve for an oak, they resolve to null and the caller falls
 *  back to the form factor, which at least does not claim to be a
 *  national function. */
export function speciesFunction(key: string | undefined | null): VolumeSpecies | null {
  switch ((key ?? '').trim().toLowerCase()) {
    case 'pine': case 'manty': case 'mänty': return 'pine';
    case 'spruce': case 'kuusi': return 'spruce';
    case 'birch': case 'koivu': return 'birch';
    default: return null;
  }
}

/** Stem volume in CUBIC METRES from diameter and height in metres.
 *
 *  NaN when either input is missing, or when the tree is below
 *  MIN_HEIGHT_M — see there for why the floor is 4 m and not breast
 *  height. NaN rather than 0: an unmeasurable tree is not a tree with no
 *  wood in it, and the difference has already cost this codebase a wrong
 *  growth figure once. */
export function laasasenahoVolume(
  species: VolumeSpecies,
  dbhM: number,
  heightM: number,
): number {
  if (!Number.isFinite(dbhM) || dbhM <= 0) return NaN;
  if (!Number.isFinite(heightM)) return NaN;
  if (heightM < MIN_HEIGHT_M) return NaN;

  const c = LAASASENAHO_1982[species];
  const d = dbhM * 100;                       // the function wants cm
  const vdm3 =
    c.a1 * Math.pow(d, c.a2) * Math.pow(c.a3, d)
    * Math.pow(heightM, c.a4) * Math.pow(heightM - 1.3, c.a5);
  return Number.isFinite(vdm3) ? vdm3 / 1000 : NaN;   // dm³ → m³
}

/** Below this the function is outside the data it was fitted on.
 *
 *  The (h − 1.3) term carries a NEGATIVE exponent, so as h approaches
 *  breast height the volume diverges. The floor is not taste: the
 *  implied form factor V/(g·h) is what says where the extrapolation
 *  stops being a stem. For a 5 cm tree it reads
 *
 *      h  1.5 m   2 m    2.5 m   3 m    4 m    5 m    6 m
 *      pine   4.01   1.42   1.01   0.85   0.70   0.64   0.60
 *      spruce 6.05   1.49   0.98   0.80   0.67   0.62   0.60
 *      birch 37.96   3.20   1.49   1.02   0.70   0.59   0.54
 *
 *  A real stem sits near 0.45–0.55. Birch diverges hardest because its
 *  a5 is the steepest (−2.659) — at 1.5 m it claims a form factor of 38,
 *  a number that would sail through every "positive and finite" check
 *  downstream. Four metres is where all three come back inside the
 *  plausible range.
 *
 *  Checked and NOT added: a guard on the output form factor. Every
 *  pathological shape automated segmentation actually produces — a
 *  merged clump at 60 cm × 22 m, a truncated stem at 45 cm × 6 m, a
 *  sliver at 6 cm × 25 m — yields a perfectly plausible 0.43–0.61. The
 *  function is well behaved for those; it is the INPUTS that are wrong,
 *  and a form-factor guard would catch none of them while looking like
 *  it did. */
export const MIN_HEIGHT_M = 4;

// --- Resolving one volume per tree ------------------------------------

export type VolumeSource = 'qsm' | 'laasasenaho' | 'formFactor' | 'none';

export interface ResolvedVolume {
  /** Stem volume (m³), NaN when nothing could be estimated. */
  volume: number;
  source: VolumeSource;
  /** The species function used, when source is 'laasasenaho'. */
  species: VolumeSpecies | null;
}

export interface VolumeOptions {
  /** QSM stem volumes by tree id — the measured ones, always preferred. */
  qsm?: Map<number, number> | null;
  /** Per-tree species assignment (species.json keys). */
  speciesByTree?: Map<number, string> | null;
  /** Fallback species for trees with no assignment. Null disables the
   *  national function for them, leaving the form factor. */
  defaultSpecies?: string | null;
  /** Form factor for the last resort. */
  formFactor?: number;
}

export const DEFAULT_FORM_FACTOR = 0.50;

/** One volume per tree, and — the point — which of the three ways
 *  produced it.
 *
 *  A table mixing a measured QSM volume, a national allometric estimate
 *  and a constant form factor without saying which is which reports
 *  three different kinds of number in one column. They are not
 *  interchangeable: the first is a measurement, the second is a
 *  published model, the third is a placeholder. */
export function resolveVolume(t: TreeMetric, o: VolumeOptions = {}): ResolvedVolume {
  const measured = o.qsm?.get(t.treeId);
  if (measured !== undefined && Number.isFinite(measured) && measured > 0) {
    return { volume: measured, source: 'qsm', species: null };
  }

  const key = o.speciesByTree?.get(t.treeId) ?? o.defaultSpecies ?? null;
  const sp = speciesFunction(key);
  if (sp) {
    const v = laasasenahoVolume(sp, t.dbh, t.height);
    if (Number.isFinite(v) && v > 0) return { volume: v, source: 'laasasenaho', species: sp };
  }

  const f = o.formFactor ?? DEFAULT_FORM_FACTOR;
  if (Number.isFinite(t.basalArea) && t.basalArea > 0
    && Number.isFinite(t.height) && t.height > 0) {
    return { volume: t.basalArea * t.height * f, source: 'formFactor', species: null };
  }
  return { volume: NaN, source: 'none', species: null };
}

export interface VolumeTally {
  qsm: number;
  laasasenaho: number;
  formFactor: number;
  none: number;
}

/** How many trees each way produced, for a panel to disclose. */
export function tallySources(rs: readonly ResolvedVolume[]): VolumeTally {
  const t: VolumeTally = { qsm: 0, laasasenaho: 0, formFactor: 0, none: 0 };
  for (const r of rs) t[r.source]++;
  return t;
}

/** One line naming what the volume column actually contains. */
export function describeVolumeSources(t: VolumeTally): string {
  const parts: string[] = [];
  if (t.qsm) parts.push(`${t.qsm} measured (QSM)`);
  if (t.laasasenaho) parts.push(`${t.laasasenaho} Laasasenaho 1982`);
  if (t.formFactor) parts.push(`${t.formFactor} form factor`);
  if (t.none) parts.push(`${t.none} not estimable`);
  return parts.join(' · ');
}
