/** Which height a cloud's z is, guessed from its bounding box, and what
 *  the transfer should match each side in.
 *
 *  A TLS plot normalised before import has z as height above ground:
 *  its lowest point sits at about zero and its highest a tree's height
 *  up. An ALS epoch imported as it came has z as elevation: hundreds of
 *  metres, with a spread of a tree's height. Matched as stored the two
 *  are hundreds of metres apart at every point and the transfer
 *  reports 0.0 % — which is what happened. The guess here picks the
 *  panel's default per side; the user can override either. */

export type HeightFrame = 'stored' | 'above_ground';
export type FrameGuess = 'above_ground' | 'absolute' | 'unknown';

/** Height above ground when the lowest point is at about zero (a
 *  normalised cloud's ground) and nothing is taller than a tree;
 *  elevation when the lowest point is well above zero or anything is
 *  higher than a tree; unknown otherwise (a cloud reaching well below
 *  zero is neither). */
export function guessFrame(zMin: number, zMax: number): FrameGuess {
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax) || zMax < zMin) return 'unknown';
  if (Math.abs(zMin) <= 2 && zMax < 150) return 'above_ground';
  if (zMin > 10 || zMax >= 150) return 'absolute';
  return 'unknown';
}

export function framesDiffer(a: FrameGuess, b: FrameGuess): boolean {
  return a !== 'unknown' && b !== 'unknown' && a !== b;
}

/** The default per side. When the frames differ, the absolute side is
 *  matched above its own ground and the normalised side as stored —
 *  the stored z of a normalised cloud already is a height above ground,
 *  and a ground classification on it would only re-derive it. When
 *  they agree, both as stored. */
export function suggestFrames(baseline: FrameGuess, target: FrameGuess): { baseline: HeightFrame; target: HeightFrame; mismatch: boolean } {
  if (!framesDiffer(baseline, target)) return { baseline: 'stored', target: 'stored', mismatch: false };
  return {
    baseline: baseline === 'absolute' ? 'above_ground' : 'stored',
    target: target === 'absolute' ? 'above_ground' : 'stored',
    mismatch: true,
  };
}

export function describeGuess(g: FrameGuess): string {
  return g === 'above_ground' ? 'height above ground' : g === 'absolute' ? 'elevation' : 'an unclear height';
}
