// Scanner-type taxonomy. The old multi-cloud editor state (CloudEntry /
// CloudDisplay / CloudRefs / per-cloud filter defaults / semantic
// constants) belonged to the legacy in-memory pipeline and was retired in
// the Phase-7 cleanup; what survives is the small bit of metadata the
// import dialog still needs — which scanner produced the file, surfaced as
// a friendly label + sub-line. Kept in `state/` for namespace stability
// (every other consumer was deleted with the old code).

export type ScannerType = 'TLS' | 'MLS' | 'ULS' | 'ALS' | 'other';

export const SCANNER_TYPES: ScannerType[] = ['TLS', 'MLS', 'ULS', 'ALS', 'other'];

export const SCANNER_TYPE_LABELS: Record<ScannerType, { label: string; sub: string }> = {
  TLS: {
    label: 'Terrestrial (TLS)',
    sub: 'Single-position scanner — DBH, taper, stem volume, crown radius.',
  },
  MLS: {
    label: 'Mobile (MLS)',
    sub: 'Vehicle / backpack / handheld — DBH (lower precision), height, plot density.',
  },
  ULS: {
    label: 'UAV (ULS)',
    sub: 'Drone-borne LiDAR — tree height, canopy structure, crown projection.',
  },
  ALS: {
    label: 'Aerial (ALS)',
    sub: 'Manned aircraft — stand-level height, density, biomass at plot resolution.',
  },
  other: {
    label: 'Other',
    sub: 'Photogrammetric, synthetic, or unknown source.',
  },
};
