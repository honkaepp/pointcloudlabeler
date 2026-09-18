import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  f32ToI32, quantisePositions, dequantise, quantisationError,
  type QuantiseFrame,
} from './quantise';

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** A leaf-sized node: 8 m across, the usual case. */
const LEAF: QuantiseFrame = { qOrigin: [10, 20, -30], qSize: [8, 8, 8] };
/** A coarse LOD tile spanning a whole plot, where the step is largest. */
const TILE: QuantiseFrame = { qOrigin: [0, 0, 0], qSize: [1000, 400, 1000] };

function roundTrip(p: readonly number[], frame: QuantiseFrame): [number, number, number] {
  const pos = new Float32Array(p);
  const q = new Uint16Array(p.length);
  quantisePositions(pos, q, frame);
  return dequantise(q, 0, frame);
}

describe('quantisePositions', () => {
  /** The property the whole scheme rests on: what the shader
   *  dequantises is within half a step of what went in. */
  it('round-trips within half a quantisation step', () => {
    const rnd = lcg(20260821);
    for (const frame of [LEAF, TILE]) {
      const tol = quantisationError(frame);
      for (let t = 0; t < 400; t++) {
        const p = [
          frame.qOrigin[0] + rnd() * frame.qSize[0],
          frame.qOrigin[1] + rnd() * frame.qSize[1],
          frame.qOrigin[2] + rnd() * frame.qSize[2],
        ];
        const back = roundTrip(p, frame);
        for (let a = 0; a < 3; a++) {
          // f32 storage costs a little precision of its own on large
          // coordinates, so the budget is the step plus that.
          const slack = tol[a] + Math.abs(p[a]) * 1e-6;
          expect(Math.abs(back[a] - p[a]), `axis ${a}, ${p[a]}`).toBeLessThanOrEqual(slack);
        }
      }
    }
  });

  it('is sub-millimetre on a leaf node', () => {
    const e = quantisationError(LEAF);
    expect(Math.max(...e)).toBeLessThan(0.0001);
  });

  /** …and centimetres on a coarse tile. Not a defect — it is why the
   *  CPU keeps the floats and measures from those. */
  it('is centimetre-scale on a plot-sized tile, which is why nothing measures from it', () => {
    const e = quantisationError(TILE);
    expect(Math.max(...e)).toBeGreaterThan(0.005);
    expect(Math.max(...e)).toBeLessThan(0.02);
  });

  it('puts the corners exactly on the endpoints', () => {
    const lo = roundTrip([10, 20, -30], LEAF);
    expect(lo[0]).toBeCloseTo(10, 6);
    expect(lo[1]).toBeCloseTo(20, 6);
    expect(lo[2]).toBeCloseTo(-30, 6);

    const hi = roundTrip([18, 28, -22], LEAF);
    expect(hi[0]).toBeCloseTo(18, 6);
    expect(hi[1]).toBeCloseTo(28, 6);
    expect(hi[2]).toBeCloseTo(-22, 6);
  });

  it('is monotonic — a point further along an axis never encodes lower', () => {
    const q = new Uint16Array(3 * 50);
    const pos = new Float32Array(3 * 50);
    for (let i = 0; i < 50; i++) pos[i * 3] = 10 + (i / 49) * 8;
    quantisePositions(pos, q, LEAF);
    for (let i = 1; i < 50; i++) {
      expect(q[i * 3]).toBeGreaterThanOrEqual(q[(i - 1) * 3]);
    }
  });

  /** A deleted point carries NaN. A uint cannot, so it encodes as 0 and
   *  is masked by aVisible. This looks like an oversight and is not. */
  it('encodes a deleted (NaN) point as zero rather than garbage', () => {
    const pos = new Float32Array([NaN, NaN, NaN, 14, 24, -26]);
    const q = new Uint16Array(6);
    quantisePositions(pos, q, LEAF);
    expect([q[0], q[1], q[2]]).toEqual([0, 0, 0]);
    // …and the live point beside it is untouched.
    expect(q[3]).toBeGreaterThan(0);
  });

  it('clamps a point outside the node instead of wrapping', () => {
    const pos = new Float32Array([-1000, 1e6, -30, 1e9, -1e9, -30]);
    const q = new Uint16Array(6);
    quantisePositions(pos, q, LEAF);
    expect(q[0]).toBe(0);          // far below the origin
    expect(q[1]).toBe(65535);      // far above the extent
    expect(q[3]).toBe(65535);
    expect(q[4]).toBe(0);
    // Every value stays in range — a wrap would be a point on the far
    // side of the node, drawn confidently in the wrong place.
    for (const v of q) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(65535); }
  });

  it('survives a node with no extent on an axis', () => {
    const flat: QuantiseFrame = { qOrigin: [5, 5, 5], qSize: [4, 0, 4] };
    const back = roundTrip([6, 5, 7], flat);
    expect(Number.isFinite(back[1])).toBe(true);
    expect(back[1]).toBeCloseTo(5, 9);      // returns to the origin
    expect(back[0]).toBeCloseTo(6, 3);      // the other axes still work
  });

  it('writes no more than the output can hold', () => {
    const pos = new Float32Array([11, 21, -29, 12, 22, -28]);
    const q = new Uint16Array(3);            // room for one point only
    expect(() => quantisePositions(pos, q, LEAF)).not.toThrow();
    expect(q[0]).toBeGreaterThan(0);
  });

  it('is empty-safe', () => {
    expect(() => quantisePositions(new Float32Array(0), new Uint16Array(0), LEAF)).not.toThrow();
  });
});

describe('f32ToI32', () => {
  it('rounds to the nearest id', () => {
    expect([...f32ToI32(new Float32Array([0, 1, 1.4, 1.6, 2.5, 42]))])
      .toEqual([0, 1, 1, 2, 3, 42]);
  });

  /** A channel that never decoded is unlabelled, not instance NaN. */
  it('makes a non-finite value unlabelled', () => {
    expect([...f32ToI32(new Float32Array([NaN, Infinity, -Infinity]))]).toEqual([0, 0, 0]);
  });

  /** This pins the BEHAVIOUR, not the explicit check that produces it:
   *  an Int32Array coerces NaN to 0 by itself, so removing the check
   *  changes nothing and the teeth check correctly reports as much. The
   *  test still earns its place — swap the container for a plain array
   *  and NaN would survive into the id column, which this catches. */
  it('never lets a non-finite value reach an id column', () => {
    const out = f32ToI32(new Float32Array([NaN, 3, Infinity]));
    for (const v of out) expect(Number.isInteger(v)).toBe(true);
  });

  it('keeps a negative id negative', () => {
    expect([...f32ToI32(new Float32Array([-1, -2.6]))]).toEqual([-1, -3]);
  });

  it('is empty-safe', () => {
    expect(f32ToI32(new Float32Array(0)).length).toBe(0);
  });
});

/** The separation that makes the lossy copy safe. `positions` is the CPU
 *  source of truth for picking, selection, measuring and the colour
 *  ramps; `qPositions` exists to be uploaded. Measure from the quantised
 *  copy and every distance in the viewport inherits up to qSize/65535 —
 *  centimetres on a coarse tile — with nothing on screen to say so. */
describe('the quantised copy is for drawing only', () => {
  const SRC = 'src/three/OctreeView.tsx';

  it('qPositions is written and uploaded, never read back', () => {
    const text = readFileSync(SRC, 'utf8');
    const uses = text.split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(l => l.line.includes('qPositions'));

    for (const u of uses) {
      const ok =
        // the field declaration and its doc comment
        u.line.startsWith('*') || u.line.startsWith('/**') || u.line.startsWith('qPositions:')
        // allocation, and handing it to the GPU attribute
        || /new Uint16Array\(/.test(u.line)
        || /BufferAttribute\(/.test(u.line)
        // constructing the LoadedNode
        || /^qPositions,/.test(u.line)
        // the sync itself
        || /syncQuantizedPositions|quantisePositions/.test(u.line)
        || /^const q = ln\.qPositions;$/.test(u.line);
      expect(ok, `${SRC}:${u.n} reads qPositions — ${u.line}`).toBe(true);
    }
    expect(uses.length).toBeGreaterThan(0);
  });

  // A second test asserting the doc comment exists was written and
  // removed: it failed because the sentence wraps across lines, and
  // `toContain` on a 4900-line file dumps the whole file into the diff.
  // A test that fails for the wrong reason and reports it unreadably
  // teaches the next reader to skip it.
});
