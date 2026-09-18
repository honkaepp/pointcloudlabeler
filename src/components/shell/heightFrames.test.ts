import { describe, it, expect } from 'vitest';
import { guessFrame, suggestFrames, framesDiffer, describeGuess } from './heightFrames';

describe('the height frame of a cloud, from its bounding box', () => {
  it('tells a normalised TLS plot from an ALS epoch in elevation', () => {
    // The pair that transferred 0.0 %: TLS at 0–35 m above ground,
    // HeliALS at 540–590 m above sea level.
    expect(guessFrame(-0.4, 34.7)).toBe('above_ground');
    expect(guessFrame(541.2, 588.9)).toBe('absolute');
    // A low plot by the sea is still an elevation once its floor is
    // well off zero; a floor near zero with a tree's height above it
    // is a normalised cloud whatever the plot's real elevation.
    expect(guessFrame(12.5, 48)).toBe('absolute');
    expect(guessFrame(1.5, 42)).toBe('above_ground');
    expect(guessFrame(-40, 10)).toBe('unknown');
    expect(guessFrame(NaN, 10)).toBe('unknown');
    expect(guessFrame(5, 3)).toBe('unknown');
  });

  it('matches the absolute side above its own ground and leaves the normalised side as stored', () => {
    const s = suggestFrames('above_ground', 'absolute');
    expect(s).toEqual({ baseline: 'stored', target: 'above_ground', mismatch: true });
    const r = suggestFrames('absolute', 'above_ground');
    expect(r).toEqual({ baseline: 'above_ground', target: 'stored', mismatch: true });
    expect(suggestFrames('absolute', 'absolute')).toEqual({ baseline: 'stored', target: 'stored', mismatch: false });
    expect(suggestFrames('unknown', 'absolute').mismatch, 'an unclear side is not a mismatch').toBe(false);
    expect(framesDiffer('unknown', 'above_ground')).toBe(false);
    expect(describeGuess('absolute')).toBe('elevation');
  });
});
