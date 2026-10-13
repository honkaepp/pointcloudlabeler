// Which edition this source tree builds.
//
// There are two, and they differ in ONE line — this file's EDITION.
//
//   development  — every panel, including the ones the release does
//                  not carry (the dev-only regions of the source, which
//                  the release transform strips out: see
//                  scripts/merge-into-release.sh).
//
//   release      — the same program without them, so a user is never
//                  offered an importer that cannot give them their
//                  points. Published builds are this edition.
//
// Everything that differs between the editions is decided HERE, by
// functions of EDITION, and nowhere else, so a grep for EDITION finds
// every difference there is.

export type Edition = 'development' | 'release';

export const EDITION: Edition = 'release';


/** The importers the Preprocessing header names, in the order the
 *  panels appear. */
export function preprocessingSources(edition: Edition): string[] {
  const sources = [
    'E57 (FARO / Leica / Trimble / NavVis / Emesent / XGRIDS / GreenValley)',
    'PTX / PTS (Leica Cyclone, Topcon)',
    'XYZ / ASCII',
  ];
  const named = [...sources];
  return edition === 'release' ? sources : named;
}

/** The importers a co-registration can draw scan positions from. */
export function coregisterSources(edition: Edition): string {
  let named = 'E57 / PTX';
  return edition === 'release' ? 'E57 / PTX' : named;
}

/** The Preprocessing tab's one-line sub-label. */
export function preprocessingTabSub(edition: Edition): string {
  let named = 'E57 · PTX · register · export';
  return edition === 'release' ? 'E57 · PTX · register · export' : named;
}
