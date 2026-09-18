import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  eastRangeToScene, upRangeToScene, northRangeToScene,
  slabToScene, slabDistance, inSlab, isolateBoxToScene, inBox,
  HORIZ_MAX_HALF_EXTENT, VERT_MAX_HALF_EXTENT,
  type Vec3, type SceneBox, type SceneSlab,
  viewDepthSpan, marginReach, isUniformReach } from './filterGeometry';

/** A realistic Finnish dataset origin: ETRS-TM35FIN easting, northing,
 *  elevation. Large offsets are the normal case and the reason the scene
 *  frame is offset-relative at all. */
const OFF: Vec3 = [500000, 6700000, 100];

/** The scene mapping itself, written out independently of the module —
 *  so the tests check against the CONVENTION rather than against a
 *  second copy of the same expression. */
const toScene = (wx: number, wy: number, wz: number, o: Vec3 = OFF) =>
  [wx - o[0], wz - o[2], -(wy - o[1])] as const;

describe('axis ranges', () => {
  it('east maps straight through', () => {
    const [lo, hi] = eastRangeToScene([500010, 500030], OFF);
    expect(lo).toBeCloseTo(10, 9);
    expect(hi).toBeCloseTo(30, 9);
  });

  it('up maps straight through', () => {
    const [lo, hi] = upRangeToScene([110, 135], OFF);
    expect(lo).toBeCloseTo(10, 9);
    expect(hi).toBeCloseTo(35, 9);
  });

  /** Scene-Z is −(worldY − offY): the interval flips sign AND reverses.
   *  Return it unsorted and every `z >= lo && z <= hi` in the hot loop
   *  fails for every point — a filter that quietly selects nothing. */
  it('north flips sign and comes back in ascending order', () => {
    const [lo, hi] = northRangeToScene([6700010, 6700030], OFF);
    expect(lo).toBeLessThan(hi);
    expect(lo).toBeCloseTo(-30, 9);
    expect(hi).toBeCloseTo(-10, 9);
  });

  it('accepts a north range given the wrong way round', () => {
    expect(northRangeToScene([6700030, 6700010], OFF))
      .toEqual(northRangeToScene([6700010, 6700030], OFF));
  });

  /** The property that matters: a world point inside the world range is
   *  inside the scene range, and one outside is outside. */
  it('selects exactly the world points the user asked for', () => {
    const north: [number, number] = [6700010, 6700030];
    const [lo, hi] = northRangeToScene(north, OFF);
    for (const wy of [6699990, 6700005, 6700010, 6700020, 6700030, 6700035, 6700100]) {
      const z = toScene(500000, wy, 100)[2];
      const inWorld = wy >= north[0] && wy <= north[1];
      expect(z >= lo && z <= hi, `worldY ${wy}`).toBe(inWorld);
    }
  });

  it('does the same for east and up', () => {
    const east: [number, number] = [500010, 500030];
    const [ex, exh] = eastRangeToScene(east, OFF);
    for (const wx of [500005, 500010, 500020, 500031]) {
      const x = toScene(wx, 6700000, 100)[0];
      expect(x >= ex && x <= exh, `worldX ${wx}`).toBe(wx >= east[0] && wx <= east[1]);
    }
    const up: [number, number] = [110, 135];
    const [uy, uyh] = upRangeToScene(up, OFF);
    for (const wz of [100, 110, 120, 140]) {
      const y = toScene(500000, 6700000, wz)[1];
      expect(y >= uy && y <= uyh, `worldZ ${wz}`).toBe(wz >= up[0] && wz <= up[1]);
    }
  });
});

describe('slabToScene', () => {
  /** The whole point of the rewrite: the scene-space test must agree
   *  with the world-space one, point for point. This checks the identity
   *  directly rather than re-deriving the algebra. */
  function worldDistance(anchor: Vec3, normal: Vec3, p: Vec3): number {
    const len = Math.hypot(normal[0], normal[1], normal[2]);
    return ((p[0] - anchor[0]) * normal[0]
          + (p[1] - anchor[1]) * normal[1]
          + (p[2] - anchor[2]) * normal[2]) / len;
  }

  const CASES: Array<{ name: string; anchor: Vec3; normal: Vec3 }> = [
    { name: 'horizontal slice (normal up)', anchor: [500010, 6700020, 120], normal: [0, 0, 1] },
    { name: 'north-facing wall', anchor: [500010, 6700020, 120], normal: [0, 1, 0] },
    { name: 'east-facing wall', anchor: [500010, 6700020, 120], normal: [1, 0, 0] },
    { name: 'oblique', anchor: [500007, 6700013, 115], normal: [0.4, -0.7, 0.6] },
    { name: 'un-normalised normal', anchor: [500007, 6700013, 115], normal: [4, -7, 6] },
  ];

  for (const c of CASES) {
    it(`agrees with the world-space test — ${c.name}`, () => {
      const s = slabToScene({ anchor: c.anchor, normal: c.normal, halfHeight: 2 }, OFF)!;
      expect(s).not.toBeNull();
      for (const p of [
        [500010, 6700020, 120], [500000, 6700000, 100], [500025, 6699980, 143],
        [499990, 6700041, 97], [500013, 6700027, 118],
      ] as Vec3[]) {
        const [x, y, z] = toScene(p[0], p[1], p[2]);
        expect(slabDistance(s, x, y, z), `${c.name} @ ${p}`)
          .toBeCloseTo(worldDistance(c.anchor, c.normal, p), 6);
      }
    });
  }

  it('normalises the normal, so thickness means metres', () => {
    const a = slabToScene({ anchor: [500000, 6700000, 100], normal: [0, 0, 1], halfHeight: 2 }, OFF)!;
    const b = slabToScene({ anchor: [500000, 6700000, 100], normal: [0, 0, 9], halfHeight: 2 }, OFF)!;
    const p = toScene(500005, 6700005, 103);
    expect(slabDistance(a, ...p)).toBeCloseTo(3, 9);
    expect(slabDistance(b, ...p)).toBeCloseTo(3, 9);
  });

  it('keeps the slab centred on the anchor', () => {
    const s = slabToScene({ anchor: [500010, 6700020, 120], normal: [0.3, 0.5, 0.8], halfHeight: 1 }, OFF)!;
    expect(slabDistance(s, ...toScene(500010, 6700020, 120))).toBeCloseTo(0, 9);
  });

  /** A zero-length normal would divide by zero and mark every point as
   *  inside a plane that does not exist. */
  it('refuses a degenerate slab rather than selecting everything', () => {
    const base = { anchor: [500000, 6700000, 100] as Vec3, halfHeight: 2 };
    expect(slabToScene({ ...base, normal: [0, 0, 0] }, OFF)).toBeNull();
    expect(slabToScene({ ...base, normal: [1e-12, 0, 0] }, OFF)).toBeNull();
    expect(slabToScene({ ...base, normal: [0, 0, 1], halfHeight: 0 }, OFF)).toBeNull();
    expect(slabToScene({ ...base, normal: [0, 0, 1], halfHeight: -1 }, OFF)).toBeNull();
    expect(slabToScene({ anchor: [NaN, 0, 0], normal: [0, 0, 1], halfHeight: 2 }, OFF)).toBeNull();
  });
});

describe('isolateBoxToScene', () => {
  const box = (min: Vec3, max: Vec3) => [min, max] as [Vec3, Vec3];
  /** A tidy 4 m × 4 m × 20 m tree at the plot centre. */
  const TIDY = box([500008, 6700018, 100], [500012, 6700022, 120]);

  const contains = (b: SceneBox, w: Vec3) => inBox(b, ...toScene(w[0], w[1], w[2]));

  it('wraps the tree it was given', () => {
    const b = isolateBoxToScene({ box: TIDY, anchor: null, margin: 0, zRange: null }, OFF);
    expect(contains(b, [500010, 6700020, 110])).toBe(true);   // centre
    expect(contains(b, [500008, 6700018, 100])).toBe(true);   // corner
    expect(contains(b, [500012, 6700022, 120])).toBe(true);
    expect(contains(b, [500014, 6700020, 110])).toBe(false);  // 2 m east of it
  });

  it('reaches a different distance per world axis when given three', () => {
    // 4 m east–west, nothing north–south, 6 m up and down: a stem that
    // leans and a stump the box cut off, without pulling in the
    // neighbour to the north.
    const b = isolateBoxToScene({ box: TIDY, anchor: null, margin: [4, 0, 6], zRange: null }, OFF);
    expect(contains(b, [500015.5, 6700020, 110])).toBe(true);    // 3.5 m east of the box
    expect(contains(b, [500004.5, 6700020, 110])).toBe(true);    // 3.5 m west
    expect(contains(b, [500010, 6700023, 110])).toBe(false);     // 1 m north — no reach
    expect(contains(b, [500010, 6700017, 110])).toBe(false);     // 1 m south
    expect(contains(b, [500010, 6700020, 125])).toBe(true);      // 5 m above the top
    expect(contains(b, [500010, 6700020, 95])).toBe(true);       // 5 m below the base
    expect(contains(b, [500010, 6700020, 127])).toBe(false);     // 7 m above — past the reach
  });

  it('reaches in ONE direction when given six — east and not west, down and not up', () => {
    // A stem leaning east and a stump the box cut off: reach 4 m east,
    // 3 m down, nothing anywhere else.
    const b = isolateBoxToScene({ box: TIDY, anchor: null, margin: [0, 4, 0, 0, 3, 0], zRange: null }, OFF);
    expect(contains(b, [500015.5, 6700020, 110])).toBe(true);    // 3.5 m east — in
    expect(contains(b, [500007, 6700020, 110])).toBe(false);     // 1 m west — out
    expect(contains(b, [500010, 6700023, 110])).toBe(false);     // 1 m north — out
    expect(contains(b, [500010, 6700017, 110])).toBe(false);     // 1 m south — out
    expect(contains(b, [500010, 6700020, 97.5])).toBe(true);     // 2.5 m below the base — in
    expect(contains(b, [500010, 6700020, 121])).toBe(false);     // 1 m above the top — out
    // North alone, to be sure the scene-Z flip puts the reach on the
    // right side of the plot.
    const n = isolateBoxToScene({ box: TIDY, anchor: null, margin: [0, 0, 0, 5, 0, 0], zRange: null }, OFF);
    expect(contains(n, [500010, 6700026, 110])).toBe(true);      // 4 m north — in
    expect(contains(n, [500010, 6700016, 110])).toBe(false);     // 2 m south — out
    // A scalar is the same reach in all six, a triple mirrors per axis,
    // and nonsense reaches nowhere.
    expect(marginReach(3)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(marginReach([1, 2, 3])).toEqual([1, 1, 2, 2, 3, 3]);
    expect(marginReach([1, -2, NaN, 4, 5, 6])).toEqual([1, 0, 0, 4, 5, 6]);
    expect(marginReach(undefined)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(marginReach(Infinity)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(isUniformReach(2)).toBe(true);
    expect(isUniformReach([2, 2, 2])).toBe(true);
    expect(isUniformReach([2, 2, 2, 2, 2, 3])).toBe(false);
  });

  it('the margin dilates it in every direction, not one', () => {
    const b = isolateBoxToScene({ box: TIDY, anchor: null, margin: 3, zRange: null }, OFF);
    for (const p of [
      [500014, 6700020, 110], [500006, 6700020, 110],   // east / west
      [500010, 6700024, 110], [500010, 6700016, 110],   // north / south
      [500010, 6700020, 122], [500010, 6700020, 98],    // up / down
    ] as Vec3[]) {
      expect(contains(b, p), `${p}`).toBe(true);
    }
    // …and stops where it should.
    expect(contains(b, [500010, 6700027, 110])).toBe(false);
    expect(contains(b, [500010, 6700013, 110])).toBe(false);
  });

  /** The reported bug. A tree with a few stray points 60 m north has a
   *  raw bbox spanning the plot; dilating that revealed nearly every
   *  unassigned point in that direction while the other axes behaved —
   *  "the margin works only in one direction for some trees". */
  it('a few stray points cannot blow the box across the plot', () => {
    const strays = box([500008, 6700018, 100], [500012, 6700080, 120]);
    const b = isolateBoxToScene({
      box: strays,
      anchor: [500010, 6700020, 110],    // the density centre is at the trunk
      margin: 2, zRange: null,
    }, OFF);
    // The trunk neighbourhood is still there…
    expect(contains(b, [500010, 6700022, 110])).toBe(true);
    // …and the far end of the runaway bbox is not.
    expect(contains(b, [500010, 6700070, 110])).toBe(false);
    expect(contains(b, [500010, 6700040, 110])).toBe(false);
  });

  it('clamps the half-extent per axis, generously upward', () => {
    const huge = box([499900, 6699900, 0], [500100, 6700100, 300]);
    const b = isolateBoxToScene({
      box: huge, anchor: [500000, 6700000, 100], margin: 0, zRange: null,
    }, OFF);
    expect(b.x1 - b.x0).toBeCloseTo(2 * HORIZ_MAX_HALF_EXTENT, 6);
    expect(b.z1 - b.z0).toBeCloseTo(2 * HORIZ_MAX_HALF_EXTENT, 6);
    expect(b.y1 - b.y0).toBeCloseTo(2 * VERT_MAX_HALF_EXTENT, 6);
  });

  it('leaves a genuinely large tree unclipped', () => {
    // 12 m crown, 25 m tall: inside both caps, so nothing is trimmed.
    const big = box([500004, 6700014, 100], [500016, 6700026, 125]);
    const b = isolateBoxToScene({ box: big, anchor: null, margin: 0, zRange: null }, OFF);
    expect(b.x1 - b.x0).toBeCloseTo(12, 6);
    expect(b.y1 - b.y0).toBeCloseTo(25, 6);
  });

  /** The anchor is the density centre. Using the bbox centre instead
   *  puts the whole neighbourhood — and every unassigned point it
   *  reveals — away from the trunk, for exactly the badly segmented
   *  trees someone isolates in order to fix. */
  it('centres on the density anchor, not the bbox centre', () => {
    const skewed = box([500010, 6700020, 100], [500050, 6700022, 120]);
    const anchored = isolateBoxToScene({
      box: skewed, anchor: [500011, 6700021, 110], margin: 0, zRange: null,
    }, OFF);
    const unanchored = isolateBoxToScene({
      box: skewed, anchor: null, margin: 0, zRange: null,
    }, OFF);
    expect(contains(anchored, [500011, 6700021, 110])).toBe(true);
    // The bbox centre sits 20 m east of the trunk, and takes the box with it.
    expect(contains(unanchored, [500011, 6700021, 110])).toBe(false);
    expect(contains(unanchored, [500030, 6700021, 110])).toBe(true);
  });

  describe('height band above the tree base', () => {
    it('clips the top', () => {
      const b = isolateBoxToScene({ box: TIDY, anchor: null, margin: 0, zRange: [0, 5] }, OFF);
      expect(contains(b, [500010, 6700020, 104])).toBe(true);
      expect(contains(b, [500010, 6700020, 106])).toBe(false);
    });

    it('clips the bottom once it is raised above the base', () => {
      const b = isolateBoxToScene({ box: TIDY, anchor: null, margin: 0, zRange: [8, 15] }, OFF);
      expect(contains(b, [500010, 6700020, 107])).toBe(false);
      expect(contains(b, [500010, 6700020, 110])).toBe(true);
      expect(contains(b, [500010, 6700020, 116])).toBe(false);
    });

    /** "0" means "from the base up", and the box keeps its natural floor
     *  there. The very base of a stem is routinely left unlabelled, so
     *  the LABELLED bbox floor sits above the real stump — snapping the
     *  band to it hid exactly the ground-level unassigned points the
     *  isolation exists to pull in, and the stem appeared to start
     *  higher than it does. */
    it('a lower bound of zero keeps the margin below the labelled base', () => {
      const withBand = isolateBoxToScene({ box: TIDY, anchor: null, margin: 2, zRange: [0, 15] }, OFF);
      const noBand = isolateBoxToScene({ box: TIDY, anchor: null, margin: 2, zRange: null }, OFF);
      expect(withBand.y0).toBeCloseTo(noBand.y0, 9);
      // 1 m BELOW the labelled floor still passes — that is the stump.
      expect(contains(withBand, [500010, 6700020, 99])).toBe(true);
    });

    it('accepts the band given the wrong way round', () => {
      expect(isolateBoxToScene({ box: TIDY, anchor: null, margin: 0, zRange: [15, 3] }, OFF))
        .toEqual(isolateBoxToScene({ box: TIDY, anchor: null, margin: 0, zRange: [3, 15] }, OFF));
    });
  });

  it('treats a negative or non-finite margin as none', () => {
    const none = isolateBoxToScene({ box: TIDY, anchor: null, margin: 0, zRange: null }, OFF);
    for (const m of [-5, NaN]) {
      expect(isolateBoxToScene({ box: TIDY, anchor: null, margin: m, zRange: null }, OFF), `${m}`)
        .toEqual(none);
    }
  });

  it('produces a box with lo below hi on every axis', () => {
    const b = isolateBoxToScene({ box: TIDY, anchor: null, margin: 1, zRange: null }, OFF);
    expect(b.x0).toBeLessThan(b.x1);
    expect(b.y0).toBeLessThan(b.y1);
    expect(b.z0).toBeLessThan(b.z1);
  });
});

describe('inSlab', () => {
  const SLAB: SceneSlab = { nx: 0, ny: 1, nz: 0, k: -10, halfHeight: 2 };

  it('accepts the centre plane and both faces', () => {
    expect(inSlab(SLAB, 0, 10, 0)).toBe(true);
    expect(inSlab(SLAB, 0, 8, 0)).toBe(true);
    expect(inSlab(SLAB, 0, 12, 0)).toBe(true);
  });

  it('rejects just outside either face', () => {
    expect(inSlab(SLAB, 0, 7.999, 0)).toBe(false);
    expect(inSlab(SLAB, 0, 12.001, 0)).toBe(false);
  });

  it('agrees with the distance it is built on', () => {
    for (let y = 0; y < 20; y += 0.13) {
      const d = slabDistance(SLAB, 0, y, 0);
      expect(inSlab(SLAB, 0, y, 0), `y=${y}`).toBe(Math.abs(d) <= SLAB.halfHeight);
    }
  });

  /** A deleted point carries NaN. Every comparison against NaN is false,
   *  so `d < -h || d > h` does NOT reject it while `Math.abs(d) <= h`
   *  does not accept it — opposite answers for the same point. The
   *  viewer wants the first: a NaN-positioned point is masked by
   *  aVisible elsewhere, and if the slab dropped it too, clearing the
   *  slab would not bring it back. */
  it('does not drop a point the slab cannot measure', () => {
    expect(inSlab(SLAB, NaN, NaN, NaN)).toBe(true);
    expect(inSlab(SLAB, 0, NaN, 0)).toBe(true);
  });

  it('handles a degenerate slab without accepting everything', () => {
    const flat: SceneSlab = { ...SLAB, halfHeight: 0 };
    expect(inSlab(flat, 0, 10, 0)).toBe(true);
    expect(inSlab(flat, 0, 10.001, 0)).toBe(false);
  });
});

/** The tested copy has to BE the running copy.
 *
 *  These helpers were extracted for testability and applyFilters kept
 *  writing the same arithmetic out by hand — a slab dot product and two
 *  box comparisons, the box test twice. Both copies happened to agree,
 *  and nothing made them.
 *
 *  Inlining was for speed, and that was not true: measured over 12M
 *  points, seven runs, median 47.7 ms written out against 45.6 ms
 *  through the helpers. There was nothing to trade. */
describe('the filter loop uses these, not its own copy', () => {
  const SRC = 'src/three/OctreeView.tsx';

  /** A first version scanned applyFilters for the ARITHMETIC — a
   *  three-term dot product, a six-comparison box test — and matched
   *  every Euclidean distance in the file instead. A regex over
   *  arithmetic cannot tell one sum of products from another, and a test
   *  that fails for the wrong reason teaches the next reader to skip it.
   *
   *  Counting the call sites is the robust form. Re-inlining means
   *  removing a call, which this sees; the three sites are the slab test
   *  and the two isolate-box tests. */
  it('calls them, at every site that needs them', () => {
    const text = readFileSync(SRC, 'utf8');
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    expect(count(/\binSlab\(/g), 'the slab test').toBe(1);
    expect(count(/\binBox\(/g), 'the two isolate-box tests').toBe(2);
  });

  /** The locals the hand-written slab test used. Their absence is what
   *  says the arithmetic is gone rather than merely joined by a call. */
  it('no longer keeps the hand-hoisted slab terms', () => {
    const text = readFileSync(SRC, 'utf8');
    for (const name of ['psnx', 'psny', 'psnz', 'pskc', 'pshh', 'psOn']) {
      expect(text.includes(name), `${name} is back`).toBe(false);
    }
  });
});

/** `viewDepthSpan` — the depth range a box occupies from a given camera.
 *
 *  Tree Review's depth cue is a brightness ramp over exactly this range,
 *  and it read as doing nothing for a long time because the range was
 *  guessed from a centre distance ± the box's half-DIAGONAL instead. The
 *  tests below are written against that mistake: each one is a case
 *  where the diagonal answer and the true answer differ by a factor, and
 *  a factor on the ramp length is a factor off the visible effect.
 */
describe('viewDepthSpan', () => {
  /** A view matrix for a camera at `eye` looking down −Z with no roll —
   *  three.js column-major, which is what `matrixWorldInverse.elements`
   *  hands over. The inverse of a pure translation is the negation. */
  function lookDownZ(eye: [number, number, number]): number[] {
    return [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      -eye[0], -eye[1], -eye[2], 1,
    ];
  }

  /** …and one yawed 90° so it looks along −X: a point further west is
   *  further into the screen.
   *
   *  The camera's local +Z (backwards) is world +X, its up is world +Y,
   *  so the view rotation's rows are (0,0,−1), (0,1,0), (1,0,0) and the
   *  translation is −Rᵀ·eye = (ez, −ey, −ex). Written out column-major,
   *  which is what three.js stores. */
  function lookDownX(eye: [number, number, number]): number[] {
    return [
      0, 0, 1, 0,
      0, 1, 0, 0,
      -1, 0, 0, 0,
      eye[2], -eye[1], -eye[0], 1,
    ];
  }

  const box: SceneBox = { x0: -1.5, x1: 1.5, y0: 0, y1: 20, z0: -1.5, z1: 1.5 };

  it('measures the depth the box actually occupies, not its diagonal', () => {
    // Camera 30 m back along +Z, looking at a 3 x 20 x 3 m tree box. The
    // box spans 3 m of DEPTH (its z extent); its half-diagonal is
    // sqrt(1.5² + 10² + 1.5²) ≈ 10.2 m, so the old ramp was 20 m long —
    // nearly seven times the span the points really cover, which is why
    // the cue moved the brightness over a fraction of its range.
    const { near, far } = viewDepthSpan(box, lookDownZ([0, 10, 30]));
    expect(near).toBeCloseTo(28.5, 6);
    expect(far).toBeCloseTo(31.5, 6);
    expect(far - near).toBeCloseTo(3, 6);
  });

  it('re-measures as the camera turns, since depth is view-relative', () => {
    // The same box seen along X. Nothing about the box changed, but the
    // depth it occupies is now its x extent — also 3 m here, so make it
    // asymmetric to prove the axis is really being followed.
    const wide: SceneBox = { ...box, x0: -6, x1: 6 };
    const alongZ = viewDepthSpan(wide, lookDownZ([0, 10, 30]));
    expect(alongZ.far - alongZ.near).toBeCloseTo(3, 6);
    const alongX = viewDepthSpan(wide, lookDownX([30, 10, 0]));
    expect(alongX.far - alongX.near).toBeCloseTo(12, 6);
    expect(alongX.near).toBeCloseTo(24, 6);
    expect(alongX.far).toBeCloseTo(36, 6);
  });

  it('never collapses to a zero-length span', () => {
    // A flat box seen edge-on: every corner at the same depth. A ramp
    // over nothing divides by nothing, and the whole background flashes
    // one colour.
    const flat: SceneBox = { x0: -5, x1: 5, y0: 0, y1: 20, z0: 0, z1: 0 };
    const s = viewDepthSpan(flat, lookDownZ([0, 10, 30]));
    expect(s.far - s.near).toBeCloseTo(0.25, 6);
    expect((s.near + s.far) * 0.5).toBeCloseTo(30, 6);
    // …and the floor is the caller's to choose.
    expect(viewDepthSpan(flat, lookDownZ([0, 10, 30]), 4).far
         - viewDepthSpan(flat, lookDownZ([0, 10, 30]), 4).near).toBeCloseTo(4, 6);
  });

  it('survives a camera inside the box', () => {
    // Standing in the middle of the crown: half the corners are behind
    // the camera, so the near depth goes negative. That is correct — a
    // ramp still has to be finite and ordered.
    const s = viewDepthSpan(box, lookDownZ([0, 10, 0]));
    expect(Number.isFinite(s.near)).toBe(true);
    expect(Number.isFinite(s.far)).toBe(true);
    expect(s.far).toBeGreaterThan(s.near);
    expect(s.near).toBeCloseTo(-1.5, 6);
    expect(s.far).toBeCloseTo(1.5, 6);
  });

  it('returns a usable span rather than NaN on a degenerate box', () => {
    const bad: SceneBox = { x0: NaN, x1: NaN, y0: 0, y1: 1, z0: 0, z1: 1 };
    const s = viewDepthSpan(bad, lookDownZ([0, 0, 10]));
    expect(Number.isFinite(s.near)).toBe(true);
    expect(Number.isFinite(s.far)).toBe(true);
    expect(s.far).toBeGreaterThan(s.near);
  });
});
