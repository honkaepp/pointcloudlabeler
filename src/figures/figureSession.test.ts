import { describe, it, expect } from 'vitest';
import { mergeSession, readSessionFrom, writeSessionTo, DEFAULT_SESSION, FIGURE_SESSION_KEY, type SessionStore } from './figureSession';

/** The module's workflow is "take a frame, go and edit, come back" — so
 *  what it holds has to survive leaving it, and the frame it is holding
 *  has to survive leaving the application. */
describe('what the Figures module remembers', () => {
  const fake = (): SessionStore & { map: Map<string, string> } => {
    const map = new Map<string, string>();
    return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
  };

  it('round-trips through the store', () => {
    const store = fake();
    const s = { ...DEFAULT_SESSION, folder: 'C:/figs', name: 'stand', treeId: 39, direction: { azimuth: 210, elevation: 12 } };
    writeSessionTo(store, s);
    expect(store.map.has(FIGURE_SESSION_KEY)).toBe(true);
    expect(readSessionFrom(store)).toEqual(s);
  });

  it('is the defaults with no store at all, rather than a module that will not mount', () => {
    expect(readSessionFrom(null)).toEqual(DEFAULT_SESSION);
    expect(() => writeSessionTo(null, DEFAULT_SESSION)).not.toThrow();
  });

  it('takes what it can from a session an older build wrote, and defaults the rest', () => {
    const partial = mergeSession({ folder: 'C:/figs', treeId: 39, cols: 3 });
    expect(partial.folder).toBe('C:/figs');
    expect(partial.treeId).toBe(39);
    expect(partial.cols).toBe(3);
    expect(partial.name).toBe(DEFAULT_SESSION.name);
    expect(partial.direction).toEqual(DEFAULT_SESSION.direction);
    // …and refuses to be broken by anything else.
    expect(mergeSession(null)).toEqual(DEFAULT_SESSION);
    expect(mergeSession('nonsense')).toEqual(DEFAULT_SESSION);
    expect(mergeSession({ width: 'wide', treeId: NaN }).width).toBe(DEFAULT_SESSION.width);
    expect(mergeSession({ treeId: NaN }).treeId).toBe(DEFAULT_SESSION.treeId);
    expect(mergeSession({ rowB: null }).rowB).toBeNull();
    expect(mergeSession({ unclassified: 'sideways' }).unclassified).toBe('grey');
    // The unclassified colour is a #rrggbb or it is the default; the
    // comparison's distance is positive or it is the default — zero
    // would put the camera inside the subject.
    expect(mergeSession({ unclassifiedColor: '#000000' }).unclassifiedColor).toBe('#000000');
    expect(mergeSession({ unclassifiedColor: 'black' }).unclassifiedColor).toBe(DEFAULT_SESSION.unclassifiedColor);
    expect(mergeSession({ cmpDistance: 1.8 }).cmpDistance).toBe(1.8);
    for (const bad of [0, -2, NaN, 'far']) expect(mergeSession({ cmpDistance: bad }).cmpDistance, String(bad)).toBe(1);
  });

  it('holds the first frame of a pair by its file, never its pixels', () => {
    const held = {
      camera: { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1], fov: 35 },
      zBase: 0, flatten: false, box: null, dir: 'C:/p/octrees/a',
      file: 'stand_pair_before.png', width: 2400, height: 1800,
      part: { kind: 'viewport' } as never, result: { file: 'stand_pair_before.png' } as never,
    };
    const s = mergeSession({ held });
    expect(s.held?.file).toBe('stand_pair_before.png');
    expect(JSON.stringify(s.held)).not.toMatch(/png":"data:|[A-Za-z0-9+/]{200}/);
    // A half-written hold is no hold: the second frame would be taken
    // from a camera that is not the first one's.
    expect(mergeSession({ held: { file: 'x.png' } }).held).toBeNull();
    expect(mergeSession({ held: { ...held, camera: undefined } }).held).toBeNull();
  });

  it('reads back as the defaults when the store holds rubbish', () => {
    const store = fake();
    store.setItem(FIGURE_SESSION_KEY, '{not json');
    expect(readSessionFrom(store)).toEqual(DEFAULT_SESSION);
  });
});
