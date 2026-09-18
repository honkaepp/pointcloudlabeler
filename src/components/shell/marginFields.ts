// The arithmetic behind Tree Review's margin control, kept out of the
// panel so it can be tested: what one edit does to the six reaches, and
// what re-linking them does.
//
// The reaches are [west, east, south, north, down, up] (see
// filterGeometry's MarginReach). "Linked" means one number for all six —
// the common case, and the default. Whether they are linked is part of
// the filter state (FilterConfig.isolateMarginLinked), not a flag inside
// the control: the control is mounted only while a tree is isolated, and
// a flag that lived in it reset to "linked" every time the isolation was
// left and re-entered — which is how typing into W came to widen the box
// in every direction after the user had switched "same" off.

import { marginReach, type IsolateMargin, type MarginReach } from '../../three/filterGeometry';

export const DIRECTION_LABELS: readonly [string, string, string, string, string, string] =
  ['W', 'E', 'S', 'N', '↓', '↑'];
export const DIRECTION_TITLES: readonly [string, string, string, string, string, string] = [
  'Reach west (m)', 'Reach east (m)', 'Reach south (m)', 'Reach north (m)',
  'Reach down, below the base (m)', 'Reach up, above the top (m)',
];

/** A reach typed by the user: never negative, never NaN. */
export function cleanReach(v: number): number {
  return Math.max(0, Number.isFinite(v) ? v : 0);
}

/** The six reaches after the user types `v` into direction `i`. Linked:
 *  all six become `v`. Unlinked: only direction `i` changes. */
export function editReach(current: IsolateMargin, linked: boolean, i: number, v: number): MarginReach {
  const n = cleanReach(v);
  if (linked) return [n, n, n, n, n, n];
  const next: MarginReach = [...marginReach(current)];
  if (i >= 0 && i < 6) next[i] = n;
  return next;
}

/** The six reaches after "same" is switched back on: the west value,
 *  the first field, everywhere. */
export function relinkReach(current: IsolateMargin): MarginReach {
  const w = marginReach(current)[0];
  return [w, w, w, w, w, w];
}
