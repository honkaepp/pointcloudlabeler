import { describe, it, expect, beforeEach } from 'vitest';
import { clearRemovedFeatureData, REMOVED_FEATURE_KEYS } from './removedFeatureCleanup';

function installStorage(): void {
  const map = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  } as Storage;
}

describe('data from a removed feature does not outlive it', () => {
  beforeEach(installStorage);

  it('deletes every orphaned key, and reports how many were there', () => {
    for (const k of REMOVED_FEATURE_KEYS) localStorage.setItem(k, 'x');
    expect(clearRemovedFeatureData()).toBe(REMOVED_FEATURE_KEYS.length);
    for (const k of REMOVED_FEATURE_KEYS) {
      expect(localStorage.getItem(k), `${k} survived`).toBeNull();
    }
  });

  /** The runner's config named the user's server and the command run on
   *  it; its log was whatever that server printed. Both are listed. */
  it('covers the remote segmentation runner', () => {
    expect(REMOVED_FEATURE_KEYS).toContain('pointcloudlabeler.segany.config');
    expect(REMOVED_FEATURE_KEYS).toContain('pointcloudlabeler-segany-log');
  });

  it('leaves keys that belong to living features alone', () => {
    localStorage.setItem('pointcloudlabeler-currency', 'EUR');
    localStorage.setItem('pointcloudlabeler-biomass-params', '{}');
    clearRemovedFeatureData();
    expect(localStorage.getItem('pointcloudlabeler-currency')).toBe('EUR');
    expect(localStorage.getItem('pointcloudlabeler-biomass-params')).toBe('{}');
  });

  it('reports nothing on a clean install, and does not throw', () => {
    expect(clearRemovedFeatureData()).toBe(0);
  });

  it('survives a store that throws on access', () => {
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: () => { throw new Error('site data blocked'); },
      removeItem: () => { throw new Error('site data blocked'); },
    } as unknown as Storage;
    expect(() => clearRemovedFeatureData()).not.toThrow();
  });
});
