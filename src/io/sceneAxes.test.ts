import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeScenePosition, toSceneXYZ } from './sceneAxes';

/** Every .ts/.tsx source file (no tests). */
function sourceFiles(dir = 'src'): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('survey → scene axes', () => {
  it('maps east to X, up to Y, and NEGATES north into Z', () => {
    expect(toSceneXYZ(1, 2, 3)).toEqual([1, 3, -2]);
  });

  it('writes the same mapping into a buffer at the right slot', () => {
    const buf = new Float32Array(9);
    writeScenePosition(buf, 1, 1, 2, 3);
    expect([...buf]).toEqual([0, 0, 0, 1, 3, -2, 0, 0, 0]);
  });

  /** The property that makes it a rotation and not a mirror: the basis
   *  stays right-handed, so X × Y = Z. Under the old (x, z, +y) form the
   *  cross product came out negated — the cloud was reflected, a road
   *  read flipped against CloudCompare, and any angle measured in the
   *  viewer had the wrong sign. */
  it('is right-handed — a rotation, not a reflection', () => {
    const e = toSceneXYZ(1, 0, 0);   // east
    const n = toSceneXYZ(0, 1, 0);   // north
    const u = toSceneXYZ(0, 0, 1);   // up
    const cross = (a: number[], b: number[]) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    // east × north = up, in the scene frame as in the survey frame.
    // Compared component-wise: the mapping produces −0 for a zeroed
    // axis, and toEqual would call that different from +0.
    const xu = cross(e, n);
    for (let k = 0; k < 3; k++) expect(xu[k]).toBeCloseTo(u[k], 12);

    // Scalar triple product e · (n × u) — the determinant of the basis.
    // +1 is a rotation; −1 would be a mirror, which is what the old
    // (x, z, +y) mapping was.
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(e, cross(n, u))).toBeCloseTo(1, 12);
  });

  it('preserves distances — no axis is scaled', () => {
    const [x, y, z] = toSceneXYZ(3, 4, 12);
    expect(Math.hypot(x, y, z)).toBeCloseTo(Math.hypot(3, 4, 12), 12);
  });

  it('leaves the origin at the origin', () => {
    for (const v of toSceneXYZ(0, 0, 0)) expect(v).toBeCloseTo(0, 12);
  });
});

/** Three decoders write scene positions — the octree reader, the TXT
 *  stream parser and the LAS stream parser — and they disagreed. The
 *  octree one was corrected to the right-handed rotation; the other two
 *  kept the mirrored (x, z, +y) form. Nothing caught it because the
 *  paths never meet at runtime: the TXT and LAS point decoders are
 *  currently unreachable, the Rust importer having taken over
 *  conversion.
 *
 *  A convention that only holds in the one place someone remembered to
 *  fix is not a convention. This is the invariant that keeps them
 *  together, whichever of them is live. */
describe('one axis convention across every decoder', () => {
  const DECODERS = [
    join('src', 'persistence', 'octreeReader.ts'),
    join('src', 'io', 'parser', 'streamParser.ts'),
    join('src', 'io', 'parseLasStream.ts'),
  ];

  it('every decoder goes through the shared mapping', () => {
    for (const file of DECODERS) {
      const text = readFileSync(file, 'utf8');
      expect(text, `${file} should call writeScenePosition`).toContain('writeScenePosition');
    }
  });

  /** Assigning the scene Z slot by hand is how the conventions drifted:
   *  octreeReader alone had FOUR copies of the same three lines, and the
   *  two other decoders had a fifth and sixth that disagreed with them.
   *
   *  Scoped to the decoders on purpose. Plenty of other code writes into
   *  a position buffer for reasons that have nothing to do with axes —
   *  octreePatches NaNs a hidden point, RasterLayers builds mesh
   *  geometry — and sweeping the whole tree would flag those and teach
   *  the next reader to ignore the failure. */
  it('no decoder hand-rolls a position triple', () => {
    const offenders: string[] = [];
    for (const file of DECODERS) {
      const text = readFileSync(file, 'utf8');
      if (/positions\[[^\]]*\*\s*3\s*\+\s*2\]\s*=/.test(text)) offenders.push(file);
    }
    expect(offenders, 'a hand-written scene Z is how the mirrored mapping survived').toEqual([]);
  });

  /** A fourth decoder must not be able to appear with its own private
   *  mapping, so the sweep is over the whole tree rather than over a
   *  list someone has to remember to extend.
   *
   *  Two files legitimately write a scene Z without decoding anything,
   *  and they are named here rather than pattern-matched away — the
   *  point is that the exceptions stay countable. */
  const NOT_DECODERS = [
    // Hides a point by NaN-ing its live position, and restores it from
    // the pristine copy on unhide. Never maps axes.
    join('src', 'persistence', 'octreePatches.ts'),
    // Builds raster mesh geometry in scene space directly.
    join('src', 'three', 'RasterLayers.tsx'),
  ];

  it('nothing outside sceneAxes writes a scene position triple', () => {
    const allowed = new Set([join('src', 'io', 'sceneAxes.ts'), ...NOT_DECODERS]);
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (allowed.has(file)) continue;
      if (/positions\[[^\]]*\*\s*3\s*\+\s*2\]\s*=/.test(readFileSync(file, 'utf8'))) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      'a new decoder with its own axis mapping — route it through writeScenePosition',
    ).toEqual([]);
  });

  it('the allowlisted files are still there and still not decoders', () => {
    for (const f of NOT_DECODERS) {
      const t = readFileSync(f, 'utf8');
      expect(t, `${f} should not have become a decoder`).not.toContain('writeScenePosition');
    }
  });
});
