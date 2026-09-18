/** The one switch for how every view draws heights: as stored, or as
 *  height above the classified ground. It is a DISPLAY choice — the
 *  coordinates, edits, picks and exports stay in the stored frame; only
 *  where a point is drawn changes (three/terrainGrid.ts). Kept in
 *  localStorage (mirrored to settings.json by settingsStore) so it holds
 *  across restarts, like the other Display choices that matter. */

import type { HeightMode } from './OctreeShellContext';

export const HEIGHT_MODE_KEY = 'tree-seg-height-mode';

export function parseHeightMode(raw: string | null | undefined): HeightMode {
  return raw === 'above_ground' ? 'above_ground' : 'stored';
}

export function readHeightMode(): HeightMode {
  try { return parseHeightMode(localStorage.getItem(HEIGHT_MODE_KEY)); } catch { return 'stored'; }
}

export function writeHeightMode(mode: HeightMode): void {
  try { localStorage.setItem(HEIGHT_MODE_KEY, mode); } catch { /* the choice holds for this session */ }
}

export const HEIGHT_MODES: { id: HeightMode; label: string; hint: string }[] = [
  { id: 'stored', label: 'As stored', hint: 'Elevation, or whatever z the file carries.' },
  { id: 'above_ground', label: 'Above ground', hint: 'Every point at its height over the classified ground under it.' },
];

/** What the 'height' colour ramp runs over — the user's choice, apart
 *  from how the heights are drawn. */
export const HEIGHT_COLOR_FRAMES: { above: boolean; label: string; hint: string }[] = [
  { above: false, label: 'Stored z', hint: 'The ramp runs from the lowest to the highest stored z: on a slope, the terrain shows in the colours.' },
  { above: true, label: 'Above ground', hint: 'The ramp runs over each point’s height above the classified ground under it, so a tree is coloured by its own height wherever it stands. Needs a ground classification.' },
];
