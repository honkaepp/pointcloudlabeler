import { describe, it, expect } from 'vitest';
import { composeZAdjust, describeHeights, footprintOf, realignFor, zRangeOf } from './skeletonAlign';

/** The skeletons always land on the cloud.
 *
 *  A skeleton built from a normalised TLS plot is in height above
 *  ground; a HeliALS epoch is in elevation. Drawn as stored over each
 *  other they were hundreds of metres apart, and "Load + show" showed
 *  nothing. The overlay now guesses both frames and moves the skeletons
 *  per point, by the ground under them. */
describe('moving the skeletons onto the cloud', () => {
  const origin: [number, number, number] = [1000, 2000, 500];
  const xyz = new Float32Array([0, 0, 1, 5, 5, 12, 2, 3, NaN, NaN, 1, 4]);

  it('reads the skeletons’ world z range and footprint through their origin, skipping what is not finite', () => {
    expect(zRangeOf(origin, xyz)).toEqual([501, 512]);
    expect(footprintOf(origin, xyz)).toEqual([1000, 2000, 1005, 2005]);
    expect(zRangeOf(origin, new Float32Array([0, 0, NaN]))).toBeNull();
    expect(footprintOf(origin, new Float32Array(0))).toBeNull();
  });

  it('lifts a normalised skeleton onto an elevation cloud, drops an elevation skeleton onto a normalised one, and leaves the rest', () => {
    expect(realignFor('above_ground', 'absolute')).toBe('lift');
    expect(realignFor('absolute', 'above_ground')).toBe('drop');
    expect(realignFor('absolute', 'absolute')).toBe('none');
    expect(realignFor('above_ground', 'above_ground')).toBe('none');
    // An unclear frame on either side moves nothing: a wrong move is
    // worse than none.
    expect(realignFor('unknown', 'absolute')).toBe('none');
    expect(realignFor('above_ground', 'unknown')).toBe('none');
  });

  it('adds the cloud’s ground under each point when lifting, and subtracts the source’s when dropping', () => {
    const ground = (e: number, n: number) => 540 + 0.1 * (e - 1000) + 0.2 * (n - 2000);
    const lift = composeZAdjust({ realign: 'lift', cloudGround: ground, sourceGround: null, flatten: null })!;
    expect(lift(1010, 2000)).toBeCloseTo(541, 9);
    const drop = composeZAdjust({ realign: 'drop', cloudGround: null, sourceGround: ground, flatten: null })!;
    expect(drop(1000, 2010)).toBeCloseTo(-542, 9);
    // Without the ground the move needs, nothing yet — the caller waits.
    expect(composeZAdjust({ realign: 'lift', cloudGround: null, sourceGround: ground, flatten: null })).toBeNull();
    expect(composeZAdjust({ realign: 'drop', cloudGround: ground, sourceGround: null, flatten: null })).toBeNull();
    expect(composeZAdjust({ realign: 'none', cloudGround: ground, sourceGround: ground, flatten: null })).toBeNull();
  });

  it('a lifted skeleton over a flattened cloud sits at the reference level: ground on, terrain off', () => {
    const reference = 541;
    const ground = (e: number, n: number) => 540 + 0.1 * (e - 1000) + 0.2 * (n - 2000);
    const flatten = (e: number, n: number) => ground(e, n) - reference;
    const both = composeZAdjust({ realign: 'lift', cloudGround: ground, sourceGround: null, flatten })!;
    expect(both(1010, 2000)).toBeCloseTo(reference, 9);
    expect(both(1000, 2050)).toBeCloseTo(reference, 9);
    // Flatten alone: the skeleton comes down with the cloud it is inside.
    const only = composeZAdjust({ realign: 'none', cloudGround: null, sourceGround: null, flatten })!;
    expect(only(1010, 2000)).toBeCloseTo(-(541 - reference), 9);
  });

  it('says what it does with the heights, and nothing when there is nothing to say', () => {
    const quiet = describeHeights({ heightMode: 'stored', terrain: null, terrainPending: false, terrainMissing: false, realign: 'none', realigned: true, sourceKnown: false });
    expect(quiet).toBeNull();
    const above = describeHeights({ heightMode: 'above_ground', terrain: { reference: 541.25, cell: 0.5 }, terrainPending: false, terrainMissing: false, realign: 'none', realigned: true, sourceKnown: false })!;
    expect(above).toMatch(/Heights above ground/);
    expect(above).toMatch(/541\.3 m/);
    expect(describeHeights({ heightMode: 'above_ground', terrain: null, terrainPending: false, terrainMissing: true, realign: 'none', realigned: true, sourceKnown: false })).toMatch(/no ground classification/);
    expect(describeHeights({ heightMode: 'above_ground', terrain: null, terrainPending: true, terrainMissing: false, realign: 'none', realigned: true, sourceKnown: false })).toMatch(/reading the ground/);
    expect(describeHeights({ heightMode: 'stored', terrain: null, terrainPending: false, terrainMissing: false, realign: 'lift', realigned: true, sourceKnown: false })).toMatch(/lifted/);
    expect(describeHeights({ heightMode: 'stored', terrain: null, terrainPending: false, terrainMissing: false, realign: 'lift', realigned: false, sourceKnown: false })).toMatch(/reading this cloud/);
    expect(describeHeights({ heightMode: 'stored', terrain: null, terrainPending: false, terrainMissing: false, realign: 'drop', realigned: true, sourceKnown: true })).toMatch(/lowered/);
    expect(describeHeights({ heightMode: 'stored', terrain: null, terrainPending: false, terrainMissing: false, realign: 'drop', realigned: false, sourceKnown: false })).toMatch(/source cloud is not known/);
  });
});
