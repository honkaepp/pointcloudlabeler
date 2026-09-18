// Which edition this source tree builds.
//
// There are two, and they differ in ONE line — this file's EDITION.
//
//   development  — every panel, including the RIEGL project panel in
//                  Preprocessing: a RiSCAN PRO project lists its scan
//                  positions and poses, but its points (.rdbx, .rxp)
//                  are read only through RIEGL's own libraries, which
//                  no published build can carry — see
//                  src-tauri/src/commands/riegl_rdbx.rs.
//
//   release      — the same program with that panel not shown, so a
//                  user is never offered an importer that cannot give
//                  them their points. Published builds are this edition.
//
// Everything that differs between the editions is decided HERE, by
// functions of EDITION, and nowhere else, so a grep for EDITION finds
// every difference there is.

export type Edition = 'development' | 'release';

export const EDITION: Edition = 'release';

/** Whether the Preprocessing module shows the RIEGL project panel. */
export function showsRieglPanel(edition: Edition): boolean {
  return edition === 'development';
}

/** The importers the Preprocessing header names, in the order the
 *  panels appear. */
export function preprocessingSources(edition: Edition): string[] {
  const sources = [
    'E57 (FARO / Leica / Trimble / NavVis / Emesent / XGRIDS / GreenValley)',
    'PTX / PTS (Leica Cyclone, Topcon)',
    'XYZ / ASCII',
  ];
  return showsRieglPanel(edition) ? ['Riegl RiSCAN / RiPROCESS / scanner .PROJ', ...sources] : sources;
}

/** The importers a co-registration can draw scan positions from. */
export function coregisterSources(edition: Edition): string {
  return showsRieglPanel(edition) ? 'Riegl / E57 / PTX' : 'E57 / PTX';
}

/** The Preprocessing tab's one-line sub-label. */
export function preprocessingTabSub(edition: Edition): string {
  return showsRieglPanel(edition) ? 'Riegl · register · export' : 'E57 · PTX · register · export';
}
