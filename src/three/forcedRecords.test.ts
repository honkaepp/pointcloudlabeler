import { describe, it, expect } from 'vitest';
import { forcedRecordSet, parentOf } from './forcedRecords';

// A tiny octree: 0 is the root with children 1 and 2; 2 has children 3
// and 4; 4 has child 5.
const idx = {
  childrenStart: Int32Array.from([0, 2, 2, 4, 4, 5, 5]),
  childrenFlat: Int32Array.from([1, 2, 3, 4, 5]),
};

describe('forcedRecordSet', () => {
  it('knows every record\'s parent', () => {
    expect(Array.from(parentOf(idx))).toEqual([-1, 0, 0, 2, 2, 4]);
  });

  it('forces the records the tree lives in and every ancestor of them', () => {
    // The planner reaches 5 only by refining 4, and 4 only by refining
    // 2: force a leaf alone and the planner never gets there.
    const set = forcedRecordSet([5], idx);
    expect(Array.from(set).sort()).toEqual([0, 2, 4, 5]);
    expect(set.has(1)).toBe(false);
    expect(set.has(3)).toBe(false);
  });

  it('is the same set for the same list, computed once', () => {
    const list = [3, 5];
    expect(forcedRecordSet(list, idx)).toBe(forcedRecordSet(list, idx));
    expect(Array.from(forcedRecordSet(list, idx)).sort()).toEqual([0, 2, 3, 4, 5]);
  });
});
