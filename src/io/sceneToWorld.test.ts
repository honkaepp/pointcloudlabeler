import { describe, it, expect } from 'vitest';
import { toSceneXYZ, sceneToWorld } from './sceneAxes';

/** A pick in the viewport is a scene point; every backend command works
 *  in survey coordinates. The two are one rotation and one origin apart,
 *  and the round trip has to be exact. */
describe('sceneToWorld', () => {
  it('is the inverse of toSceneXYZ, origin included', () => {
    const offset: [number, number, number] = [500000, 6700000, 120];
    const world: [number, number, number] = [500047.67, 6700030.13, 141.42];
    const scene = toSceneXYZ(world[0] - offset[0], world[1] - offset[1], world[2] - offset[2]);
    // The scene point a stem at that easting/northing/elevation is drawn at…
    expect(scene[0]).toBeCloseTo(47.67, 9);
    expect(scene[1]).toBeCloseTo(21.42, 9);   // up
    expect(scene[2]).toBeCloseTo(-30.13, 9);  // −north
    // …comes back as the stem, not as a point near the origin.
    const back = sceneToWorld(scene, offset);
    expect(back[0]).toBeCloseTo(world[0], 9);
    expect(back[1]).toBeCloseTo(world[1], 9);
    expect(back[2]).toBeCloseTo(world[2], 9);
  });

  it('keeps the northing sign right — the reflection is the whole point', () => {
    // A point north of the origin has a NEGATIVE scene-Z.
    expect(sceneToWorld([0, 0, -10], [0, 0, 0])).toEqual([0, 10, 0]);
    expect(sceneToWorld([0, 5, 0], [0, 0, 0])).toEqual([0, 0, 5]);
    expect(sceneToWorld([3, 0, 0], [0, 0, 0])).toEqual([3, 0, 0]);
  });
});
