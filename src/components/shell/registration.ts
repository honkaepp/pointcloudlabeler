// The arithmetic of the Cloud registration panel, kept out of the
// component so it can be tested without a DOM.
//
// The measurement (src-tauri skelalign.rs) is a transform FROM the
// reference's skeletons ONTO the target's trees: rotation by `theta`
// about (cx, cy), then translation by (dx, dy), in the skeleton
// origin's frame. The reference is taken to be right, so the target is
// the one that moves — by the inverse. A georeference shift can carry
// the translation and not the rotation, which is why the rotation is
// reported at the plot's edge, where it is a distance somebody can
// judge.

/** The stage the alignment command runs and reports on, and the one
 *  its Stop is asked on. Its own, so a stop here never reaches a
 *  skeleton build or transfer, and theirs never reaches this. */
export const ALIGN_STAGE = 'align';

/** How sure the coarse vote was: the peak's score over its best rival
 *  elsewhere in the search window. Sixty stems voting together make a
 *  peak clutter does not; a ratio near one means two places looked
 *  equally likely, and the fine fit started from a guess. */
export function confidenceVerdict(ratio: number): { label: string; color: string } {
  if (!Number.isFinite(ratio) || ratio >= 1.3) return { label: 'unambiguous', color: '#67d391' };
  if (ratio >= 1.1) return { label: 'likely — check it in Compare first', color: '#e6c068' };
  return { label: 'a guess — check it before moving anything', color: '#e0817b' };
}

/** The shift that puts the target on the reference: the inverse of the
 *  translation measured from the reference onto the target. */
export function shiftOntoReference(a: { dx: number; dy: number }): [number, number] {
  return [-a.dx, -a.dy];
}

/** Half the horizontal diagonal of a bounding box — the farthest a
 *  point of the plot is from its middle, roughly. */
export function halfExtent(bboxMin: readonly number[], bboxMax: readonly number[]): number {
  const w = Math.abs((bboxMax[0] ?? 0) - (bboxMin[0] ?? 0));
  const h = Math.abs((bboxMax[1] ?? 0) - (bboxMin[1] ?? 0));
  return Math.hypot(w, h) / 2;
}

/** What a rotation the shift cannot carry amounts to at the plot's
 *  edge, in metres: arc = angle × radius. */
export function rotationAtEdge(thetaRad: number, halfExtentM: number): number {
  return Math.abs(thetaRad) * Math.max(0, halfExtentM);
}

/** Below this the remaining offset is noise, not a move worth making. */
export const MIN_SHIFT_M = 0.001;

export function isWorthMoving(dx: number, dy: number): boolean {
  return Number.isFinite(dx) && Number.isFinite(dy) && Math.hypot(dx, dy) >= MIN_SHIFT_M;
}

/** "+12.20 m east, −3.10 m north (12.59 m)". */
export function describeShift(dx: number, dy: number): string {
  const s = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} m`;
  return `${s(dx)} east, ${s(dy)} north (${Math.hypot(dx, dy).toFixed(2)} m)`;
}

export function degrees(rad: number): number {
  return rad * 180 / Math.PI;
}

/** Which stage of the run a progress fraction belongs to — the labels
 *  match run_skeleton_align's own milestones. */
export function alignStageLabel(pct: number): string {
  if (pct < 0.05) return 'Reading the reference’s skeletons';
  if (pct < 0.65) return 'Reading the target — verticality and canopy';
  if (pct < 0.9) return 'Voting for the shift';
  return 'Refining tree by tree';
}
