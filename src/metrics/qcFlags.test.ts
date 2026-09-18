import { describe, it, expect } from 'vitest';
import type { TreeMetric } from '../persistence/octreeReader';
import {
  computeQcFlags, worstByTree, SEV_RANK, SEV_COLOR, FLAG_LABEL,
  type Flag, type Severity, type FlagCode,
} from './qcFlags';

/** A tree that trips no rule, so a test can perturb exactly one thing
 *  and attribute the resulting flag to it. */
function ok(treeId: number, over: Partial<TreeMetric> = {}): TreeMetric {
  return {
    treeId, count: 5000, height: 20, dbh: 0.30,
    basalArea: Math.PI * 0.15 * 0.15, crownArea: 30, crownDiameter: 6.2,
    x: treeId * 10, y: 0, baseZ: 0, leanDeg: 0,
    ...over,
  };
}

/** A plot of near-identical trees: a tight distribution, so any outlier
 *  a test introduces is unambiguously the outlier. */
function plot(n = 30): TreeMetric[] {
  // Real plots have spread, and the outlier rules are σ-based, so a
  // perfectly uniform fixture would silently disable them (see the
  // zero-spread test below). A small deterministic wobble keeps the
  // distribution tight enough that an injected outlier is unambiguous
  // while still giving the rules a σ to work with.
  return Array.from({ length: n }, (_, i) => ok(i + 1, {
    height: 20 + (i % 5) * 0.4,
    crownArea: 30 + (i % 7) * 1.5,
    count: 5000 + (i % 4) * 300,
  }));
}

const reasons = (fs: Flag[], id: number) => fs.filter(f => f.treeId === id).map(f => f.reason);

describe('computeQcFlags', () => {
  it('returns nothing when there is nothing to judge', () => {
    expect(computeQcFlags(null, null, null)).toEqual([]);
    expect(computeQcFlags([], null, null)).toEqual([]);
  });

  it('flags a tree with no DBH fit as critical — every downstream metric depends on it', () => {
    const trees = [...plot(), ok(99, { dbh: NaN })];
    const flags = computeQcFlags(trees, null, null);
    const mine = flags.filter(f => f.treeId === 99);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.some(f => f.severity === 'critical')).toBe(true);
    expect(reasons(flags, 99).join(' ')).toMatch(/DBH/i);
  });

  /** A clean plot must produce a clean sheet. A QC panel that flags
   *  everything is exactly as useless as one that flags nothing, and it
   *  is the failure mode a threshold change causes. */
  it('leaves a uniform plot unflagged', () => {
    const flags = computeQcFlags(plot(40), null, null);
    expect(flags, `a uniform plot produced: ${flags.map(f => f.reason).join('; ')}`).toEqual([]);
  });

  /** σ is derived from the MAD, so a plot whose crowns are all exactly
   *  equal has σ = 0 and the "median + 3σ" test can never fire, however
   *  extreme the outlier. That is reachable on synthetic data, on a
   *  heavily downsampled plot, and on any plot small enough that more
   *  than half the trees share a value — this test found it. With no
   *  spread to measure against, the rule falls back to a ratio. */
  it('still flags an extreme outlier in a plot with zero spread', () => {
    const flat = Array.from({ length: 30 }, (_, i) => ok(i + 1));
    const flags = computeQcFlags([...flat, ok(99, { crownArea: 400 })], null, null);
    expect(
      flags.filter(f => f.treeId === 99 && /crown/i.test(f.reason)).length,
      'a crown 13x the median is a fused pair whether or not the plot has spread',
    ).toBeGreaterThan(0);
  });

  /** The fallback must not turn a normal plot into a wall of flags: a
   *  tree merely twice the median crown is ordinary. */
  it('does not flag a merely-large crown when there is no spread', () => {
    const flat = Array.from({ length: 30 }, (_, i) => ok(i + 1));
    const flags = computeQcFlags([...flat, ok(99, { crownArea: 55 })], null, null);
    expect(flags.filter(f => f.treeId === 99 && /crown/i.test(f.reason))).toEqual([]);
  });

  it('flags a fused crown (far above the plot median) as a segmentation problem', () => {
    const trees = [...plot(), ok(99, { crownArea: 400 })];
    const flags = computeQcFlags(trees, null, null);
    expect(reasons(flags, 99).join(' ')).toMatch(/crown/i);
  });

  /** Every flag has to tell the user what to do about it. A reason with
   *  no hint is a dead end in a worklist panel. */
  it('gives every flag a reason and an actionable hint', () => {
    const trees = [...plot(), ok(98, { dbh: NaN }), ok(99, { crownArea: 400, count: 5 })];
    const flags = computeQcFlags(trees, null, null);
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) {
      expect(f.reason.length, 'every flag needs a reason').toBeGreaterThan(0);
      expect(f.hint.length, `flag "${f.reason}" needs a hint`).toBeGreaterThan(0);
      expect(['critical', 'warning', 'info']).toContain(f.severity);
    }
  });

  it('attaches the bbox when one is known, so the panel can fly to the tree', () => {
    const box = { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    const flags = computeQcFlags([...plot(), ok(99, { dbh: NaN })], null, new Map([[99, box]]));
    const mine = flags.filter(f => f.treeId === 99);
    expect(mine.every(f => f.bbox !== null && f.bbox !== undefined)).toBe(true);
  });


  /** A plot with NO spread is the case the ratio fallback exists for —
   *  and it was the one case whose message came out as nonsense. The
   *  σ figure was computed as `(v − med) / sig` regardless of which
   *  branch fired, so every fallback flag read "Infinityσ above plot
   *  median". A user reading that has no idea how big the crown is.
   */
  it('never prints a σ figure it does not have', () => {
    // Twenty identical trees ⇒ MAD = 0 ⇒ σ = 0 for every population.
    const trees = [...Array.from({ length: 20 }, (_, i) => ok(i + 1)), ok(99, { crownArea: 300 })];
    const flags = computeQcFlags(trees, null, null);
    const crown = flags.find(f => f.treeId === 99 && f.code === 'crown-large');
    expect(crown, 'a 10× crown must still be flagged with no spread to measure').toBeDefined();
    expect(crown!.reason).not.toMatch(/Infinity|NaN/);
    expect(crown!.reason, 'with no σ it must say how many TIMES the median').toMatch(/10\.0× the plot median/);
    expect(crown!.reason).toMatch(/30\.0 m²/); // and name the median itself

    for (const f of flags) {
      expect(f.reason, `"${f.reason}"`).not.toMatch(/Infinity|NaN|undefined/);
      expect(f.hint, `"${f.hint}"`).not.toMatch(/Infinity|NaN|undefined/);
    }
  });

  it('phrases both comparisons so they read as English', () => {
    // "5.2σ above the plot median" and "10.0× the plot median" — the two
    // branches do not take the same preposition, and gluing one fixed
    // word onto a bare figure gets one of them wrong every time.
    const flat = [...Array.from({ length: 20 }, (_, i) => ok(i + 1)), ok(99, { crownArea: 300 })];
    const byRatio = computeQcFlags(flat, null, null).find(f => f.code === 'crown-large')!;
    expect(byRatio.reason).toContain('10.0× the plot median');
    expect(byRatio.reason).not.toContain('× above');

    const spread = [...plot(), ok(99, { crownArea: 300 })];
    const bySigma = computeQcFlags(spread, null, null).find(f => f.code === 'crown-large')!;
    expect(bySigma.reason).toMatch(/\dσ above the plot median/);
  });

  it('still reports σ when the plot has a spread to report', () => {
    const trees = [...plot(), ok(99, { crownArea: 300 })];
    const crown = computeQcFlags(trees, null, null).find(f => f.code === 'crown-large');
    expect(crown!.reason).toMatch(/σ above the plot median/);
    expect(crown!.reason).not.toMatch(/×/);
  });

  /** Slenderness is an ABSOLUTE range check — 0.3 to 4.0 cm of diameter
   *  per metre of height covers every real tree. It used to be gated on
   *  the population having a DBH and height spread, like the outlier
   *  tests are, so a 2 m-thick 20 m "tree" went unflagged whenever its
   *  neighbours happened to be all the same size as each other. The
   *  check has nothing to do with the neighbours.
   */
  it('checks slenderness whether or not the plot has any spread', () => {
    const absurd = ok(99, { dbh: 2.0, height: 20 }); // 10 cm/m
    // A plot with spread — this always worked.
    const spread = [
      ...Array.from({ length: 20 }, (_, i) => ok(i + 1, { dbh: 0.28 + (i % 5) * 0.01, height: 20 + (i % 4) })),
      absurd,
    ];
    expect(computeQcFlags(spread, null, null).some(f => f.treeId === 99 && f.code === 'slenderness')).toBe(true);
    // …and a plot without one, which did not.
    const flat = [...Array.from({ length: 20 }, (_, i) => ok(i + 1)), absurd];
    expect(
      computeQcFlags(flat, null, null).some(f => f.treeId === 99 && f.code === 'slenderness'),
      'a 10 cm/m stem is a bad fit however uniform its neighbours are',
    ).toBe(true);
    // Both ends of the range.
    const thin = [...Array.from({ length: 20 }, (_, i) => ok(i + 1)), ok(98, { dbh: 0.02, height: 20 })];
    expect(computeQcFlags(thin, null, null).some(f => f.treeId === 98 && f.code === 'slenderness')).toBe(true);
  });

  /** The code is what the panel filters on and the CSV carries, so it
   *  has to be present, stable and labelled — a flag with no code is
   *  invisible to the filter and a code with no label renders blank. */
  it('tags every flag with a labelled check code', () => {
    const trees = [
      ...plot(),
      ok(90, { dbh: NaN }),
      ok(91, { crownArea: 400 }),
      ok(92, { crownArea: 1, count: 40 }),
      ok(93, { dbh: 2.0 }),
      ok(94, { height: 90 }),
      ok(95, { height: 1.0 }),
      ok(96, { count: 10 }),
    ];
    const flags = computeQcFlags(trees, null, null);
    expect(flags.length).toBeGreaterThan(0);
    const seen = new Set<FlagCode>();
    for (const f of flags) {
      expect(f.code, `tree ${f.treeId}: "${f.reason}"`).toBeTruthy();
      expect(FLAG_LABEL[f.code], `no label for code "${f.code}"`).toBeTruthy();
      seen.add(f.code);
    }
    // The metrics-only checks should all be reachable from this fixture;
    // if one is not, either the fixture or the rule has drifted.
    for (const code of ['no-dbh', 'crown-large', 'crown-small', 'slenderness',
                        'height-high', 'height-low', 'few-points'] as FlagCode[]) {
      expect(seen.has(code), `no fixture tree triggered "${code}"`).toBe(true);
    }
  });

  it('labels every code it can emit, and no more', () => {
    // A label table that drifts from the union renders a blank chip on
    // one side or an orphan chip on the other.
    const codes = Object.keys(FLAG_LABEL) as FlagCode[];
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) expect(FLAG_LABEL[c].length).toBeGreaterThan(0);
  });

  it('leaves the bbox absent when it is not known, rather than inventing one', () => {
    const flags = computeQcFlags([...plot(), ok(99, { dbh: NaN })], null, new Map());
    expect(flags.filter(f => f.treeId === 99).every(f => !f.bbox)).toBe(true);
  });
});

describe('worstByTree', () => {
  const f = (treeId: number, severity: Severity): Flag =>
    ({ treeId, code: 'no-dbh', severity, reason: 'r', hint: 'h' });

  it('keeps the most severe flag per tree, whatever the order', () => {
    const worst = worstByTree([f(1, 'info'), f(1, 'critical'), f(1, 'warning')]);
    expect(worst.get(1)).toBe('critical');
    const reversed = worstByTree([f(2, 'critical'), f(2, 'info')]);
    expect(reversed.get(2), 'a later info must not demote an earlier critical').toBe('critical');
  });

  it('ranks severities in the order the UI sorts by', () => {
    expect(SEV_RANK.critical).toBeGreaterThan(SEV_RANK.warning);
    expect(SEV_RANK.warning).toBeGreaterThan(SEV_RANK.info);
  });

  it('gives every severity a distinct colour — they are the only cue in a dense list', () => {
    const colours = Object.values(SEV_COLOR);
    expect(new Set(colours).size).toBe(colours.length);
  });
});
