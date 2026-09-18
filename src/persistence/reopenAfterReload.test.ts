import { describe, it, expect } from 'vitest';
import { rememberReopen, takeReopen, type CrumbStore } from './reopenAfterReload';

function memory(): CrumbStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

describe('the dataset to reopen after a reload', () => {
  it('is handed back once, then forgotten', () => {
    const s = memory();
    rememberReopen('C:/proj/octrees/plot8', s);
    expect(takeReopen(s)).toBe('C:/proj/octrees/plot8');
    expect(takeReopen(s), 'a second reload, or a later start, must not reopen it again').toBeNull();
    expect(s.map.size).toBe(0);
  });

  it('is nothing when nothing was remembered', () => {
    expect(takeReopen(memory())).toBeNull();
    expect(takeReopen(null)).toBeNull();
  });

  it('never throws when the storage does', () => {
    const broken: CrumbStore = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
      removeItem: () => { throw new Error('SecurityError'); },
    };
    expect(() => rememberReopen('x', broken)).not.toThrow();
    expect(takeReopen(broken)).toBeNull();
  });
});
