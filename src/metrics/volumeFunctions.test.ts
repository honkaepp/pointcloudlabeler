import { describe, it, expect } from 'vitest';
import type { TreeMetric } from '../persistence/octreeReader';
import {
  laasasenahoVolume, speciesFunction, resolveVolume, tallySources,
  describeVolumeSources, LAASASENAHO_1982, MIN_HEIGHT_M, DEFAULT_FORM_FACTOR,
  type VolumeSpecies,
} from './volumeFunctions';

function tree(treeId: number, dbh: number, height: number): TreeMetric {
  return {
    treeId, count: 4000, height, dbh,
    basalArea: Number.isFinite(dbh) && dbh > 0 ? Math.PI * (dbh / 2) ** 2 : NaN,
    crownArea: 12, crownDiameter: 3.9, x: 0, y: 0, baseZ: 0, leanDeg: 0,
  };
}

const SPECIES: VolumeSpecies[] = ['pine', 'spruce', 'birch'];
const g = (d: number) => Math.PI * (d / 2) ** 2;

/** These are the numbers a Finnish forester would recognise on sight.
 *  They are not a re-derivation of the formula — they are what the
 *  formula has to produce to be the function it claims to be, and they
 *  are the check that would catch a transposed coefficient. */
describe('Laasasenaho 1982 — magnitudes a forester would recognise', () => {
  it('puts a mature pine where it belongs', () => {
    // d 20 cm, h 18 m: a bit over a quarter of a cubic metre.
    expect(laasasenahoVolume('pine', 0.20, 18)).toBeGreaterThan(0.24);
    expect(laasasenahoVolume('pine', 0.20, 18)).toBeLessThan(0.31);
  });

  it('puts a large spruce where it belongs', () => {
    // d 25 cm, h 20 m: around 0.45 m³.
    expect(laasasenahoVolume('spruce', 0.25, 20)).toBeGreaterThan(0.40);
    expect(laasasenahoVolume('spruce', 0.25, 20)).toBeLessThan(0.52);
  });

  it('gives a sawlog-sized pine roughly a cubic metre and a half', () => {
    expect(laasasenahoVolume('pine', 0.40, 28)).toBeGreaterThan(1.3);
    expect(laasasenahoVolume('pine', 0.40, 28)).toBeLessThan(1.8);
  });

  /** The strongest dimensional check available without the primary
   *  source: V / (g·h) is the form factor, and for Nordic stems it sits
   *  between about 0.40 and 0.55 across the whole merchantable range. A
   *  misplaced decimal anywhere in the five coefficients throws this out
   *  by an order of magnitude. */
  it('implies a form factor in the range Nordic stems actually have', () => {
    for (const sp of SPECIES) {
      for (const [d, h] of [[0.10, 10], [0.15, 14], [0.20, 18], [0.25, 20], [0.30, 24], [0.40, 28]] as const) {
        const f = laasasenahoVolume(sp, d, h) / (g(d) * h);
        expect(f, `${sp} d=${d} h=${h}`).toBeGreaterThan(0.38);
        expect(f, `${sp} d=${d} h=${h}`).toBeLessThan(0.56);
      }
    }
  });

  /** Birch is more tapered than the conifers, so at the same size it
   *  holds less wood. If a coefficient set were swapped between species
   *  this ordering is what would break. */
  it('gives birch less volume than pine or spruce at the same size', () => {
    for (const [d, h] of [[0.20, 18], [0.30, 22], [0.40, 26]] as const) {
      const b = laasasenahoVolume('birch', d, h);
      expect(b, `d=${d}`).toBeLessThan(laasasenahoVolume('pine', d, h));
      expect(b, `d=${d}`).toBeLessThan(laasasenahoVolume('spruce', d, h));
    }
  });
});

describe('laasasenahoVolume — behaviour', () => {
  it('grows with diameter at fixed height', () => {
    for (const sp of SPECIES) {
      let prev = 0;
      for (const d of [0.08, 0.12, 0.20, 0.30, 0.45, 0.60]) {
        const v = laasasenahoVolume(sp, d, 22);
        expect(v, `${sp} d=${d}`).toBeGreaterThan(prev);
        prev = v;
      }
    }
  });

  it('grows with height at fixed diameter', () => {
    for (const sp of SPECIES) {
      let prev = 0;
      for (const h of [6, 10, 14, 18, 22, 28]) {
        const v = laasasenahoVolume(sp, 0.25, h);
        expect(v, `${sp} h=${h}`).toBeGreaterThan(prev);
        prev = v;
      }
    }
  });

  it('scales roughly with the square of diameter', () => {
    // Doubling d should roughly quadruple V — the a2 exponent is near 2.
    const ratio = laasasenahoVolume('pine', 0.40, 22) / laasasenahoVolume('pine', 0.20, 22);
    expect(ratio).toBeGreaterThan(3.0);
    expect(ratio).toBeLessThan(5.0);
  });

  /** The (h − 1.3) term has a NEGATIVE exponent, so as h approaches
   *  breast height the volume diverges. A 1.5 m birch is handed an
   *  implied form factor of 38 — thirty-odd times a real stem, and a
   *  number that sails through every "positive and finite" check
   *  downstream. The floor is set where all three species come back
   *  inside the plausible range. */
  it('refuses a tree below the fitted range instead of diverging', () => {
    for (const sp of SPECIES) {
      for (const h of [1.3, 1.31, 2, 3, MIN_HEIGHT_M - 0.01]) {
        expect(laasasenahoVolume(sp, 0.05, h), `${sp} h=${h}`).toBeNaN();
      }
    }
  });

  /** …and at the floor itself the answer is already sensible, which is
   *  what makes the floor the right one rather than merely a high one. */
  it('is plausible from the floor upward', () => {
    for (const sp of SPECIES) {
      for (const h of [MIN_HEIGHT_M, MIN_HEIGHT_M + 1, 8, 15]) {
        const d = 0.05;
        const f = laasasenahoVolume(sp, d, h) / (g(d) * h);
        expect(f, `${sp} h=${h}`).toBeGreaterThan(0.35);
        expect(f, `${sp} h=${h}`).toBeLessThan(0.75);
      }
    }
  });

  it('is NaN, not zero, when a measurement is missing', () => {
    expect(laasasenahoVolume('pine', NaN, 20)).toBeNaN();
    expect(laasasenahoVolume('pine', 0.25, NaN)).toBeNaN();
    expect(laasasenahoVolume('pine', 0, 20)).toBeNaN();
    expect(laasasenahoVolume('pine', -0.25, 20)).toBeNaN();
    // Height 0 is what the metrics pass reports for a tree with no
    // ground beneath it — unmeasured, not a tree of no height.
    expect(laasasenahoVolume('pine', 0.25, 0)).toBeNaN();
  });

  it('carries the published coefficients, unrounded', () => {
    // Guards against someone "tidying" the table to fewer decimals.
    expect(LAASASENAHO_1982.pine.a1).toBe(0.036089);
    expect(LAASASENAHO_1982.spruce.a4).toBe(2.82541);
    expect(LAASASENAHO_1982.birch.a5).toBe(-2.65900);
    for (const sp of SPECIES) {
      expect(LAASASENAHO_1982[sp].a5, `${sp} a5`).toBeLessThan(0);
      expect(LAASASENAHO_1982[sp].a3, `${sp} a3`).toBeLessThan(1);
    }
  });
});

describe('speciesFunction', () => {
  it('resolves the three species it was fitted for', () => {
    expect(speciesFunction('pine')).toBe('pine');
    expect(speciesFunction('spruce')).toBe('spruce');
    expect(speciesFunction('birch')).toBe('birch');
  });

  it('resolves the Finnish names, which this app\'s users write', () => {
    expect(speciesFunction('mänty')).toBe('pine');
    expect(speciesFunction('kuusi')).toBe('spruce');
    expect(speciesFunction('koivu')).toBe('birch');
  });

  it('is case- and space-insensitive', () => {
    expect(speciesFunction('  Pine ')).toBe('pine');
    expect(speciesFunction('KUUSI')).toBe('spruce');
  });

  /** Aspen and oak are outside the three species the function was
   *  fitted for. Borrowing birch's curve for an oak would produce a
   *  confident number with nothing behind it. */
  it('refuses a species the function was never fitted for', () => {
    expect(speciesFunction('aspen')).toBeNull();
    expect(speciesFunction('oak')).toBeNull();
    expect(speciesFunction('')).toBeNull();
    expect(speciesFunction(undefined)).toBeNull();
    expect(speciesFunction(null)).toBeNull();
  });
});

/** Three kinds of number can end up in a volume column — a measurement,
 *  a published model, and a constant placeholder — and they are not
 *  interchangeable. */
describe('resolveVolume', () => {
  const t = tree(1, 0.25, 20);

  it('prefers the measured QSM volume over everything', () => {
    const r = resolveVolume(t, {
      qsm: new Map([[1, 0.481]]),
      speciesByTree: new Map([[1, 'pine']]),
    });
    expect(r).toEqual({ volume: 0.481, source: 'qsm', species: null });
  });

  it('falls to the national function when there is no QSM', () => {
    const r = resolveVolume(t, { speciesByTree: new Map([[1, 'spruce']]) });
    expect(r.source).toBe('laasasenaho');
    expect(r.species).toBe('spruce');
    expect(r.volume).toBeCloseTo(laasasenahoVolume('spruce', 0.25, 20), 12);
  });

  it('uses the fallback species for a tree with no assignment', () => {
    const r = resolveVolume(t, { defaultSpecies: 'pine' });
    expect(r.source).toBe('laasasenaho');
    expect(r.species).toBe('pine');
  });

  it('prefers the tree\'s own species over the fallback', () => {
    const r = resolveVolume(t, {
      speciesByTree: new Map([[1, 'birch']]),
      defaultSpecies: 'pine',
    });
    expect(r.species).toBe('birch');
  });

  it('falls to the form factor for a species with no function', () => {
    const r = resolveVolume(t, { defaultSpecies: 'oak' });
    expect(r.source).toBe('formFactor');
    expect(r.volume).toBeCloseTo(g(0.25) * 20 * DEFAULT_FORM_FACTOR, 12);
  });

  it('falls to the form factor when the tree is below the fitted range', () => {
    expect(resolveVolume(tree(2, 0.04, 1.2), { defaultSpecies: 'pine' }).source)
      .toBe('formFactor');
    expect(resolveVolume(tree(2, 0.04, 3), { defaultSpecies: 'pine' }).source)
      .toBe('formFactor');
  });

  it('honours a caller\'s form factor', () => {
    const r = resolveVolume(t, { formFactor: 0.42 });
    expect(r.volume).toBeCloseTo(g(0.25) * 20 * 0.42, 12);
  });

  /** A QSM volume of zero is a failed fit, not a stem with no wood. */
  it('ignores a zero or non-finite QSM volume', () => {
    expect(resolveVolume(t, { qsm: new Map([[1, 0]]), defaultSpecies: 'pine' }).source)
      .toBe('laasasenaho');
    expect(resolveVolume(t, { qsm: new Map([[1, NaN]]), defaultSpecies: 'pine' }).source)
      .toBe('laasasenaho');
  });

  it('reports none, with NaN, when nothing can be estimated', () => {
    const r = resolveVolume(tree(3, NaN, 0), { defaultSpecies: 'pine' });
    expect(r.source).toBe('none');
    expect(r.volume).toBeNaN();
  });

  it('never returns a zero volume dressed as an estimate', () => {
    for (const opts of [{}, { defaultSpecies: 'pine' }, { defaultSpecies: 'oak' }]) {
      const r = resolveVolume(tree(4, NaN, NaN), opts);
      expect(r.source).toBe('none');
      expect(r.volume).toBeNaN();
    }
  });
});

describe('source disclosure', () => {
  const rs = [
    resolveVolume(tree(1, 0.25, 20), { qsm: new Map([[1, 0.48]]) }),
    resolveVolume(tree(2, 0.25, 20), { defaultSpecies: 'pine' }),
    resolveVolume(tree(3, 0.25, 20), { defaultSpecies: 'oak' }),
    resolveVolume(tree(4, NaN, NaN), {}),
  ];

  it('counts every tree by how its volume was produced', () => {
    expect(tallySources(rs)).toEqual({ qsm: 1, laasasenaho: 1, formFactor: 1, none: 1 });
  });

  it('names the mix in one line', () => {
    const s = describeVolumeSources(tallySources(rs));
    expect(s).toContain('1 measured (QSM)');
    expect(s).toContain('Laasasenaho 1982');
    expect(s).toContain('form factor');
    expect(s).toContain('not estimable');
  });

  it('says nothing about a kind that produced nothing', () => {
    const only = [resolveVolume(tree(1, 0.25, 20), { defaultSpecies: 'pine' })];
    const s = describeVolumeSources(tallySources(only));
    expect(s).toBe('1 Laasasenaho 1982');
    expect(s).not.toContain('form factor');
  });
});
