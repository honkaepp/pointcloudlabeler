import { describe, it, expect } from 'vitest';
import {
  installRendererErrorLog, describeErrorEvent, describeRejection,
  type ErrorSource, type ErrorEventLike, type RejectionEventLike,
} from './rendererErrorLog';

/** A window that lets the test fire the events itself. */
function fakeWindow() {
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const target: ErrorSource = {
    addEventListener(type: string, listener: (ev: never) => void) {
      (listeners[type] ??= []).push(listener as (ev: unknown) => void);
    },
  } as ErrorSource;
  return {
    target,
    error(ev: ErrorEventLike) { for (const l of listeners.error ?? []) l(ev); },
    reject(ev: RejectionEventLike) { for (const l of listeners.unhandledrejection ?? []) l(ev); },
  };
}

describe('installRendererErrorLog', () => {
  it('sends an uncaught error and an unhandled rejection to the crash log, tagged', () => {
    const w = fakeWindow();
    const got: Array<[string, string | undefined]> = [];
    installRendererErrorLog(w.target, () => ({ logCrash: (m, k) => got.push([m, k]) }));
    w.error({ message: 'x is not a function', filename: 'app.js', lineno: 3, colno: 9 });
    w.reject({ reason: new RangeError('Array buffer allocation failed') });
    expect(got).toHaveLength(2);
    expect(got[0][1]).toBe('error');
    expect(got[0][0]).toBe('x is not a function at app.js:3:9');
    expect(got[1][1]).toBe('rejection');
    expect(got[1][0]).toMatch(/^RangeError: Array buffer allocation failed/);
  });

  /** The bridge that provides the sink is installed after the hooks
   *  are; an error before it exists is dropped, one after it reaches it. */
  it('looks the sink up per event', () => {
    const w = fakeWindow();
    let sink: { logCrash: (m: string) => void } | undefined;
    const got: string[] = [];
    installRendererErrorLog(w.target, () => sink);
    w.error({ message: 'too early' });
    sink = { logCrash: (m) => got.push(m) };
    w.error({ message: 'in time' });
    expect(got).toEqual(['in time']);
  });

  it('caps the entries per minute and says once that it is dropping', () => {
    const w = fakeWindow();
    let t = 0;
    const got: Array<[string, string | undefined]> = [];
    installRendererErrorLog(w.target, () => ({ logCrash: (m, k) => got.push([m, k]) }), { limit: 3, windowMs: 1000, now: () => t });
    for (let i = 0; i < 10; i++) w.error({ message: `e${i}` });
    expect(got.map(g => g[0])).toEqual(['e0', 'e1', 'e2', expect.stringMatching(/more than 3 errors/)]);
    expect(got[3][1]).toBe('flood');
    // A new window starts fresh.
    t = 1000;
    w.error({ message: 'later' });
    expect(got.at(-1)![0]).toBe('later');
  });

  it('survives a sink that throws', () => {
    const w = fakeWindow();
    installRendererErrorLog(w.target, () => ({ logCrash: () => { throw new Error('ipc down'); } }));
    expect(() => w.error({ message: 'boom' })).not.toThrow();
  });
});

describe('the descriptions', () => {
  it('include the stack when the error has one', () => {
    const err = new TypeError('bad');
    expect(describeErrorEvent({ message: 'bad', error: err })).toContain(err.stack!.split('\n')[1].trim());
  });
  it('render a non-Error rejection reason readably', () => {
    expect(describeRejection('plain string')).toBe('plain string');
    expect(describeRejection({ code: 7 })).toBe('{"code":7}');
    expect(describeRejection(undefined)).toBe('undefined');
  });
});
