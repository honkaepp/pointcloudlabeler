import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  wrapHue, hslToRgb, hslToRgb01, treeIdColor, treeIdColor01,
  classColor, classColor01, deadwoodColor, rampColor, hexToRgb255,
  setCustomRampStops, RAMPS, UNASSIGNED_RGB, parseHex, hexToRgb01,
} from './palette';

const inRange = (c: readonly number[]) => c.every(v => v >= 0 && v <= 255);
const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('treeIdColor', () => {
  /** The defect this module exists for.
   *
   *  A tree id is a signed Int32 read straight from a file, so negative
   *  ids arrive from real data. Two of the four old copies fed the raw
   *  (negative) hue into a hue2 that corrects by a single ±1, which is
   *  not enough once h − 1/3 drops below −1: the ramp is extrapolated
   *  past its end and the channel leaves 0–255. Nothing reports it —
   *  the viewport's Uint8Array wraps it into a confident wrong colour,
   *  and a panel's `rgb(215,196,-102)` is invalid CSS, so the swatch
   *  the user is matching the tree against silently disappears. */
  it('keeps every channel in range for a negative id', () => {
    for (const id of [-1, -2, -3, -5, -11, -13, -17, -999, -9999, -2147483648]) {
      const c = treeIdColor(id);
      expect(inRange(c), `id ${id} -> ${JSON.stringify(c)}`).toBe(true);
    }
  });

  it('never leaves 0–255 for any id a file can hold', () => {
    for (let id = -50000; id <= 50000; id += 7) {
      expect(inRange(treeIdColor(id)), `id ${id}`).toBe(true);
    }
    // …including the Int32 extremes, which is what an NA sentinel or a
    // corrupt column reaches.
    for (const id of [-2147483648, 2147483647, -2147483647]) {
      expect(inRange(treeIdColor(id)), `id ${id}`).toBe(true);
    }
  });

  /** These are the exact values the two copies disagreed on. Pinned so a
   *  future "simplification" back to `h % 1` fails here rather than in a
   *  screenshot nobody compares. */
  it('matches the normalised reference on the ids that used to differ', () => {
    expect(treeIdColor(-3)).toEqual([215, 196, 66]);
    expect(treeIdColor(-11)).toEqual([184, 215, 66]);
    expect(treeIdColor(-9999)).toEqual([115, 215, 66]);
  });

  it('is unchanged for positive ids — the fix costs the common case nothing', () => {
    expect(treeIdColor(1)).toEqual([66, 109, 215]);
    expect(treeIdColor(2)).toEqual([153, 215, 66]);
    expect(treeIdColor(3)).toEqual([215, 66, 196]);
  });

  it('is deterministic — the same tree is the same colour on every surface', () => {
    for (const id of [1, 7, 42, 1234]) expect(treeIdColor(id)).toEqual(treeIdColor(id));
  });

  /** What the golden-ratio hop is FOR. Segmentation numbers trees in
   *  spatial order, so the ids on screen together are consecutive: if
   *  neighbouring ids shared a hue the user could not tell two adjacent
   *  crowns apart, which is the one thing this colouring has to do. */
  it('separates consecutive ids', () => {
    let worst = Infinity;
    for (let id = 1; id < 5000; id++) {
      worst = Math.min(worst, dist(treeIdColor(id), treeIdColor(id + 1)));
    }
    expect(worst).toBeGreaterThan(150);
  });

  /** The harder version: any two ids inside a window of 12, which is
   *  roughly what fits in one isolate view. Measured floor is 34.7
   *  (ids 20 and 28); asserted at 25 so ordinary drift does not trip it
   *  but a palette change that collapses the spread does. */
  it('keeps ids within one screenful apart', () => {
    let worst = Infinity, at = '';
    for (let id = 1; id < 3000; id++) {
      for (let k = 1; k <= 12; k++) {
        const d = dist(treeIdColor(id), treeIdColor(id + k));
        if (d < worst) { worst = d; at = `${id} vs ${id + k}`; }
      }
    }
    expect(worst, `closest pair: ${at}`).toBeGreaterThan(25);
  });

  it('agrees with its 0–1 form', () => {
    for (const id of [1, 5, 99, -3, -9999]) {
      const a = treeIdColor(id);
      const b = treeIdColor01(id).map(v => Math.round(v * 255));
      expect(b).toEqual(a);
    }
  });

  it('gives a colour rather than NaN for an id that failed to parse', () => {
    for (const id of [NaN, Infinity, -Infinity]) {
      const c = treeIdColor(id);
      expect(c.every(Number.isFinite), `id ${id}`).toBe(true);
      expect(inRange(c)).toBe(true);
    }
  });
});

describe('wrapHue', () => {
  it('lands every finite hue in [0,1)', () => {
    for (const h of [0, 0.5, 1, 1.5, -0.1, -0.5, -1, -1.5, -12345.678, 98765.4321]) {
      const w = wrapHue(h);
      expect(w, `h=${h}`).toBeGreaterThanOrEqual(0);
      expect(w, `h=${h}`).toBeLessThan(1);
    }
  });

  it('preserves the fractional position, not just the range', () => {
    expect(wrapHue(-0.25)).toBeCloseTo(0.75, 12);
    expect(wrapHue(3.25)).toBeCloseTo(0.25, 12);
    expect(wrapHue(0.25)).toBeCloseTo(0.25, 12);
  });

  it('collapses non-finite to 0 instead of poisoning all three channels', () => {
    expect(wrapHue(NaN)).toBe(0);
    expect(wrapHue(Infinity)).toBe(0);
  });
});

describe('hslToRgb', () => {
  it('hits the primaries', () => {
    expect(hslToRgb(0, 1, 0.5)).toEqual([255, 0, 0]);
    expect(hslToRgb(1 / 3, 1, 0.5)).toEqual([0, 255, 0]);
    expect(hslToRgb(2 / 3, 1, 0.5)).toEqual([0, 0, 255]);
  });

  it('is achromatic at zero saturation', () => {
    expect(hslToRgb(0.42, 0, 0.5)).toEqual([128, 128, 128]);
    expect(hslToRgb(0.42, 0, 0)).toEqual([0, 0, 0]);
    expect(hslToRgb(0.42, 0, 1)).toEqual([255, 255, 255]);
  });

  it('wraps the hue circle — h and h+1 are the same colour', () => {
    for (const h of [0, 0.13, 0.5, 0.87]) {
      expect(hslToRgb(h + 1, 0.65, 0.55)).toEqual(hslToRgb(h, 0.65, 0.55));
      expect(hslToRgb(h - 1, 0.65, 0.55)).toEqual(hslToRgb(h, 0.65, 0.55));
      expect(hslToRgb(h - 3, 0.65, 0.55)).toEqual(hslToRgb(h, 0.65, 0.55));
    }
  });

  /** Total over the whole hue circle at the saturation/lightness the
   *  tree palette uses — this is the sweep that would have caught the
   *  original bug at any h, not only the ids that happen to trip it. */
  it('stays in range across the full circle', () => {
    for (let h = -3; h <= 3; h += 0.0005) {
      const c = hslToRgb01(h, 0.65, 0.55);
      for (const v of c) {
        expect(v, `h=${h.toFixed(4)} -> ${JSON.stringify(c)}`).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('clamps a nonsense saturation or lightness instead of extrapolating', () => {
    for (const c of [hslToRgb(0.3, 5, 0.5), hslToRgb(0.3, -5, 0.5),
      hslToRgb(0.3, 0.6, 9), hslToRgb(0.3, 0.6, -9),
      hslToRgb(0.3, NaN, 0.5), hslToRgb(0.3, 0.6, NaN)]) {
      expect(inRange(c), JSON.stringify(c)).toBe(true);
    }
  });
});

describe('classColor', () => {
  it('gives every named ASPRS class its own colour', () => {
    const known = [2, 3, 4, 5, 6, 7, 9];
    const seen = new Set(known.map(c => classColor(c).join(',')));
    expect(seen.size).toBe(known.length);
  });

  it('falls back to grey for an unmapped class rather than undefined', () => {
    for (const cls of [0, 1, 8, 10, 255, -1, NaN]) {
      expect(classColor(cls)).toEqual([140, 140, 140]);
    }
  });

  /** The overlay writes float colours and the main cloud writes u8. They
   *  must be the same palette or the same ground reads as two colours
   *  across the two surfaces. */
  it('agrees with its 0–1 form', () => {
    for (const cls of [2, 3, 4, 5, 6, 7, 9, 0]) {
      expect(classColor01(cls)).toEqual(classColor(cls).map(v => v / 255));
    }
  });
});

describe('deadwoodColor', () => {
  /** The design claim: standing and laying read apart at a glance.
   *  Measured floors are R−B ≥ 180 for standing and B−R ≥ 161 for
   *  laying; asserted at 100 so the bands can be retuned but not
   *  merged.
   *
   *  Negative ids are in the sweep because that is where the claim
   *  actually broke. An unnormalised jitter runs (−0.12, 0], pulling
   *  laying's hue down from 0.5 to 0.38 — green, not cyan, and the same
   *  green the classification palette gives vegetation. Instance −11
   *  came out [60, 221, 128]; with the hue wrapped it is [60, 197, 221].
   *  Worst B−R over negative ids: 45 unnormalised, 161 normalised. */
  it('keeps the standing and laying bands apart', () => {
    for (let id = -4000; id <= 4000; id++) {
      const s = deadwoodColor(id, 'standing');
      const l = deadwoodColor(id, 'laying');
      expect(s[0] - s[2], `standing id ${id} -> ${JSON.stringify(s)}`).toBeGreaterThan(100);
      expect(l[2] - l[0], `laying id ${id} -> ${JSON.stringify(l)}`).toBeGreaterThan(100);
    }
  });

  it('stays in range for any id, negative included', () => {
    for (const id of [-9999, -3, -1, 0, 1, 7, 100000]) {
      for (const ch of ['standing', 'laying'] as const) {
        expect(inRange(deadwoodColor(id, ch)), `${ch} ${id}`).toBe(true);
      }
    }
  });

  it('distinguishes neighbouring instances within a band', () => {
    for (let id = 1; id < 500; id++) {
      for (const ch of ['standing', 'laying'] as const) {
        expect(dist(deadwoodColor(id, ch), deadwoodColor(id + 1, ch)),
          `${ch} ${id}`).toBeGreaterThan(3);
      }
    }
  });
});

describe('rampColor', () => {
  const out: [number, number, number] = [0, 0, 0];
  const at = (ramp: Parameters<typeof rampColor>[0], t: number) => {
    rampColor(ramp, t, out);
    return [...out] as [number, number, number];
  };

  it('puts t=0 and t=1 exactly on the first and last stop', () => {
    for (const name of Object.keys(RAMPS) as (keyof typeof RAMPS)[]) {
      if (name === 'custom') continue;
      const stops = RAMPS[name];
      expect(at(name, 0), `${name} lo`).toEqual(stops[0]);
      expect(at(name, 1), `${name} hi`).toEqual(stops[stops.length - 1]);
    }
  });

  /** NaN survives every ordered comparison, so an unguarded clamp lets
   *  it through to `stops[NaN]` — undefined — and the Display panel dies
   *  with "Cannot read properties of undefined". A cloud with all-zero
   *  intensity or a zero-span axis produces exactly that t. */
  it('resolves a NaN parameter instead of crashing', () => {
    for (const t of [NaN, Infinity, -Infinity]) {
      expect(() => at('viridis', t)).not.toThrow();
      expect(at('viridis', t)).toEqual(RAMPS.viridis[0]);
    }
  });

  it('clamps out-of-range t to the ends', () => {
    expect(at('turbo', -5)).toEqual(RAMPS.turbo[0]);
    expect(at('turbo', 5)).toEqual(RAMPS.turbo[RAMPS.turbo.length - 1]);
  });

  it('stays in range and finite everywhere on every ramp', () => {
    for (const name of Object.keys(RAMPS) as (keyof typeof RAMPS)[]) {
      for (let t = 0; t <= 1; t += 0.002) {
        const c = at(name, t);
        expect(inRange(c), `${name} @ ${t.toFixed(3)} -> ${JSON.stringify(c)}`).toBe(true);
        expect(c.every(Number.isFinite)).toBe(true);
      }
    }
  });

  /** Grayscale is the one ramp whose ordering the user can verify by
   *  eye, so it is the one that pins "higher t means further along". */
  it('is monotone on grayscale — brighter means higher', () => {
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.01) {
      const v = at('grayscale', t)[0];
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('moves continuously — no jump between adjacent samples', () => {
    for (const name of Object.keys(RAMPS) as (keyof typeof RAMPS)[]) {
      if (name === 'custom') continue;
      // Two samples 1/2000 apart cannot cross more than a fraction of
      // one stop interval, so a large jump means a stop-index bug.
      const budget = 255 / (RAMPS[name].length - 1) / 2;
      let prev = at(name, 0);
      for (let t = 0.0005; t <= 1; t += 0.0005) {
        const c = at(name, t);
        expect(dist(c, prev), `${name} @ ${t.toFixed(4)}`).toBeLessThan(budget);
        prev = c;
      }
    }
  });

  it('resolves the user-defined custom ramp from its stops', () => {
    setCustomRampStops('#ff0000', '#0000ff');
    expect(at('custom', 0)).toEqual([255, 0, 0]);
    expect(at('custom', 1)).toEqual([0, 0, 255]);
    const mid = at('custom', 0.5);
    expect(mid[0]).toBeGreaterThan(100);
    expect(mid[2]).toBeGreaterThan(100);
    // Restore, so ordering between test files cannot leak.
    setCustomRampStops('#1a1a3a', '#e0b84a');
  });

  /** A ramp name from a stale saved config must not crash the viewport
   *  — every point in the node goes through here. */
  it('falls back rather than crashing on an unknown ramp name', () => {
    expect(() => at('nope' as never, 0.5)).not.toThrow();
    expect(inRange(at('nope' as never, 0.5))).toBe(true);
  });
});

describe('hexToRgb255', () => {
  it('parses with and without the hash, either case', () => {
    expect(hexToRgb255('#FF8000')).toEqual([255, 128, 0]);
    expect(hexToRgb255('ff8000')).toEqual([255, 128, 0]);
    expect(hexToRgb255('  #ff8000  ')).toEqual([255, 128, 0]);
  });

  /** A bad string must not become NaN: NaN written into a Uint8Array is
   *  0, which is black — a colour the user cannot distinguish from a
   *  deliberate one. */
  it('gives a neutral grey for anything unparseable', () => {
    for (const s of ['', '#fff', 'red', '#gggggg', '#ff80000']) {
      expect(hexToRgb255(s)).toEqual([180, 180, 180]);
    }
  });

  /** Three call sites wanted three different answers to "that was not a
   *  colour", which is why the parse is shared and the fallback is not.
   *  A caller's choice must survive. */
  it('honours a caller-supplied fallback', () => {
    expect(hexToRgb255('nope', [255, 71, 188])).toEqual([255, 71, 188]);
    expect(hexToRgb01('nope', [0.7, 0.7, 0.5])).toEqual([0.7, 0.7, 0.5]);
    // …and never substitutes it for something that DID parse.
    expect(hexToRgb255('#00ff00', [255, 71, 188])).toEqual([0, 255, 0]);
    expect(hexToRgb01('#00ff00', [0.7, 0.7, 0.5])).toEqual([0, 1, 0]);
  });

  it('reports "not a colour" distinguishably from a colour', () => {
    expect(parseHex('bogus')).toBeNull();
    expect(parseHex('#000000')).toEqual([0, 0, 0]);
  });

  it('agrees between its 0–255 and 0–1 forms', () => {
    for (const s of ['#000000', '#ffffff', '#1a2b3c', '#e0b84a']) {
      expect(hexToRgb01(s)).toEqual(hexToRgb255(s).map(v => v / 255));
    }
  });
});

/** Everything above is worth nothing if a fifth copy appears. That is
 *  precisely how the negative-id bug survived: four files each defined
 *  `treeIdColor` locally with a comment saying it mirrored the viewport,
 *  and two of them stopped mirroring it. */
describe('one palette', () => {
  const NAMES = ['treeIdColor', 'classColor', 'hslToRgb', 'deadwoodColor', 'rampColor'];

  function* walk(dir: string): Generator<string> {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) yield* walk(p);
      else if (/\.tsx?$/.test(e)) yield p;
    }
  }

  it('is defined in exactly one file', () => {
    const offenders: string[] = [];
    for (const file of walk('src')) {
      if (file === join('src', 'three', 'palette.ts')) continue;
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        for (const n of NAMES) {
          // A local definition — `function foo(`, `const foo = (`, or a
          // 0–1 variant of one. An import or a call site is fine.
          if (new RegExp(`^\\s*(export\\s+)?(function|const|let)\\s+${n}\\d*\\b`).test(line)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        }
      });
    }
    expect(offenders, `redefined outside palette.ts:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('UNASSIGNED_RGB', () => {
  /** The panels have no access to display.unlabeledColor, so they use
   *  this. It must equal the DEFAULT the viewport starts from, or an
   *  untouched dataset shows one grey in the viewport and another in the
   *  swatch beside it. */
  it('matches the default unlabeledColor in the shell config', () => {
    const shell = readFileSync('src/components/shell/OctreeShellContext.tsx', 'utf8');
    const m = /unlabeledColor:\s*'(#[0-9a-fA-F]{6})'/.exec(shell);
    expect(m, 'default unlabeledColor not found').not.toBeNull();
    expect(hexToRgb255(m![1])).toEqual([...UNASSIGNED_RGB]);
  });
});
