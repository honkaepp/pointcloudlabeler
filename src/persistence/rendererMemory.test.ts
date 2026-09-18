import { describe, it, expect } from 'vitest';
import { describeRendererMemory, readPerformanceMemory } from './rendererMemory';

const MIB = 1024 * 1024;

describe('describeRendererMemory', () => {
  it('writes the stage, the heap and the viewport counts in a fixed order', () => {
    const line = describeRendererMemory('tst', true,
      { usedJSHeapSize: 120 * MIB, totalJSHeapSize: 200 * MIB, jsHeapSizeLimit: 4096 * MIB },
      { loadedNodes: 0, loadedPoints: 0, pendingGpu: 0, inFlight: 0, queued: 0, geometries: 3, textures: 2, programs: 5 },
      1234);
    expect(line).toBe(
      'stage tst | cloud released | js heap 120 MiB used / 200 MiB total / 4096 MiB limit'
      + ' | nodes 0 loaded (0 pts), 0 pending gpu, 0 in flight, 0 queued | gl 3 geometries, 2 textures, 5 programs | dom 1234 nodes');
  });

  it('says what it could not measure instead of leaving it out', () => {
    const line = describeRendererMemory('qsm', false, null, null);
    expect(line).toBe('stage qsm | cloud held | js heap ? | viewport ?');
  });

  it('formats a large point count with separators', () => {
    const line = describeRendererMemory('tst', false, null,
      { loadedNodes: 812, loadedPoints: 4_012_345, pendingGpu: 2, inFlight: 4, queued: 30, geometries: 812, textures: 2, programs: 6 });
    expect(line).toContain('812 loaded (4,012,345 pts)');
  });
});

describe('readPerformanceMemory', () => {
  it('returns null where the browser does not expose it', () => {
    // Node's performance has no `memory`; Chromium's does.
    const m = readPerformanceMemory();
    if (m) expect(m.usedJSHeapSize).toBeGreaterThan(0);
    else expect(m).toBeNull();
  });
});
