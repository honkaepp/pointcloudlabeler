import { describe, it, expect } from 'vitest';
import { describeHits, scanSources } from '../testing/sourceScan';
import type { TreeMetric } from '../persistence/octreeReader';
import { generateReportHtml, localIsoDate, summarise, type ReportInputs } from './generate';
import { mergeStemFits } from '../metrics/plotStats';

function tree(treeId: number, dbh: number, height: number, crownArea = 12): TreeMetric {
  return {
    treeId, count: 4000, height, dbh,
    basalArea: Number.isFinite(dbh) && dbh > 0 ? Math.PI * (dbh / 2) ** 2 : NaN,
    crownArea, crownDiameter: 2 * Math.sqrt(crownArea / Math.PI),
    x: treeId * 3, y: 0, baseZ: 0, leanDeg: 0,
  };
}

function inputs(metrics: TreeMetric[], plotAreaHa = 0.04): ReportInputs {
  return { metrics, plotAreaHa } as unknown as ReportInputs;
}

const g = (d: number) => Math.PI * (d / 2) ** 2;

/** Every plot figure in the report used to be derived from one filtered
 *  set requiring BOTH a diameter and a height, so a tree missing only its
 *  height dropped out of the stem count, the basal area and every
 *  diameter statistic — none of which need a height.
 *
 *  The metrics pass reports a height of 0 for a tree with no ground
 *  surface beneath it, so this is ordinary. With one such tree in four
 *  the report showed 25 % fewer stems and 26 % less basal area than the
 *  Plot Boundary panel did for the same plot. */
describe('report plot summary', () => {
  const withGap = [
    tree(1, 0.30, 22),
    tree(2, 0.28, 21),
    tree(3, 0.35, 24),
    tree(4, 0.32, 0),   // measured stem, no ground beneath it
  ];

  it('counts a tree whether or not every attribute could be measured', () => {
    const s = summarise(inputs(withGap));
    expect(s.treeCount).toBe(4);
    expect(s.nWithDbh).toBe(4);
    expect(s.nWithHeight).toBe(3);
    expect(s.stemsPerHa).toBeCloseTo(4 / 0.04, 10);
  });

  it('measures basal area from the diameter alone', () => {
    const s = summarise(inputs(withGap));
    const expected = g(0.30) + g(0.28) + g(0.35) + g(0.32);
    expect(s.basalAreaTotalM2).toBeCloseTo(expected, 12);
    expect(s.basalAreaPerHa).toBeCloseTo(expected / 0.04, 10);
    // Dropping the height-less tree would have lost a quarter of it.
    expect(s.basalAreaTotalM2).toBeGreaterThan((expected - g(0.32)) * 1.2);
  });

  it('takes diameter statistics over every tree that has a diameter', () => {
    const s = summarise(inputs(withGap));
    const all = [0.30, 0.28, 0.35, 0.32];
    expect(s.mean.dbh).toBeCloseTo(all.reduce((a, b) => a + b, 0) / 4, 12);
    expect(s.median.dbh).toBeCloseTo((0.30 + 0.32) / 2, 12);
  });

  it('takes height statistics over every tree that has a height', () => {
    const s = summarise(inputs(withGap));
    expect(s.mean.height).toBeCloseTo((22 + 21 + 24) / 3, 12);
    expect(s.median.height).toBeCloseTo(22, 12);
    // The height-less tree must not be averaged in as a zero.
    expect(s.mean.height).toBeGreaterThan(20);
  });

  /** Lorey's mean height needs both, and both its sums must run over the
   *  same trees — the mirror of the mistake in the Plot Boundary panel,
   *  where the height-less tree was in the denominator only. */
  it('weights Lorey height over the trees that have both', () => {
    const s = summarise(inputs(withGap));
    const num = g(0.30) * 22 + g(0.28) * 21 + g(0.35) * 24;
    const den = g(0.30) + g(0.28) + g(0.35);
    expect(s.loreyMeanHeight).toBeCloseTo(num / den, 10);
    // Not the full basal area, which includes the height-less tree.
    expect(s.loreyMeanHeight).not.toBeCloseTo(num / s.basalAreaTotalM2, 3);
  });

  it('takes dominant height from the tallest tenth of the measured heights', () => {
    const many = Array.from({ length: 20 }, (_, i) => tree(i, 0.3, 10 + i));
    const s = summarise(inputs(many));
    expect(s.topNCount).toBe(2);              // ceil(20 × 0.10)
    expect(s.dominantHeight).toBeCloseTo((29 + 28) / 2, 12);
  });

  it('reports NaN rather than a number when nothing can be measured', () => {
    const s = summarise(inputs([tree(1, NaN, 0)]));
    expect(s.treeCount).toBe(1);
    expect(s.nWithDbh).toBe(0);
    expect(s.nWithHeight).toBe(0);
    expect(s.basalAreaTotalM2).toBe(0);
    expect(Number.isNaN(s.loreyMeanHeight)).toBe(true);
    expect(Number.isNaN(s.dominantHeight)).toBe(true);
  });

  it('an empty plot does not divide by zero', () => {
    const s = summarise(inputs([]));
    expect(s.treeCount).toBe(0);
    expect(s.stemsPerHa).toBe(0);
    expect(s.basalAreaPerHa).toBe(0);
    expect(Number.isNaN(s.dominantHeight)).toBe(true);
  });

  it('averages crown area over the trees that have one', () => {
    const mixed = [tree(1, 0.3, 20, 10), tree(2, 0.3, 20, 20), tree(3, 0.3, 20, NaN)];
    const s = summarise(inputs(mixed));
    expect(s.mean.crownArea).toBeCloseTo(15, 12);
  });

  /** The report is the document a stand gets measured by, and PointCloudLabeler has
   *  two ways to measure a diameter: the algebraic circle over the whole
   *  breast-height band, and the RANSAC stem fit that replaces it where
   *  it converged. Quoting the number without saying which produced it
   *  shows half of it — and the report used to quote the algebraic one
   *  while the Metrics table on screen showed the fitted one. */
  describe('diameter provenance', () => {
    const fit = (treeId: number, dbh: number) => ({
      treeId, dbh, centerX: 0, centerY: 0,
      inlierCount: 900, bandCount: 8, rmse: 0.004, writtenStemPoints: 0,
    });

    it('counts the diameters that came from the stem fit', () => {
      const merged = mergeStemFits(withGap, new Map([[1, fit(1, 0.31)], [3, fit(3, 0.34)]]));
      const s = summarise(inputs(merged));
      expect(s.nRefinedDbh).toBe(2);
      expect(s.nWithDbh).toBe(4);
      // …and the refined figure is the one the statistics are taken over.
      expect(s.mean.dbh).toBeCloseTo((0.31 + 0.28 + 0.34 + 0.32) / 4, 12);
    });

    it('is zero when the fit has never been run', () => {
      expect(summarise(inputs(withGap)).nRefinedDbh).toBe(0);
    });

    it('says so in the rendered report, and stays silent when there is nothing to say', () => {
      const base = {
        projectName: 'Plot 1', plotAreaHa: 0.04, plotAreaBasis: 'boundary',
        qsm: null, density: null,
      } as unknown as ReportInputs;

      const merged = mergeStemFits(withGap, new Map([[1, fit(1, 0.31)]]));
      const html = generateReportHtml({ ...base, metrics: merged });
      expect(html).toContain('1 of 4 diameters from the RANSAC stem fit');

      const plain = generateReportHtml({ ...base, metrics: withGap });
      expect(plain).not.toContain('RANSAC');
    });
  });

  /** The revenue card is the one figure in this document that is money,
   *  and the report is what a client reads. It carried a hardcoded euro
   *  sign, so a plot priced in any other currency produced a document
   *  making a false statement about money — with nothing in the numbers
   *  to reveal it. */
  it('quotes revenue in the currency it was given, not in one of its own', () => {
    const base = {
      projectName: 'Fundo Los Alerces', plotAreaHa: 0.5, plotAreaBasis: 'boundary',
      metrics: withGap, density: null,
      qsm: { trees: [{ treeId: 1, stemVolume: 2, stemVolumeCi95: 0, branchVolume: 0 }] },
    } as unknown as ReportInputs;

    const clp = generateReportHtml({ ...base, bucking: { unitPrice: 35000, currency: 'CLP' } });
    expect(clp).toContain('CLP/ha');
    expect(clp).toContain('35000 CLP/m³');
    expect(clp).not.toContain(String.fromCharCode(0x20ac));
    // 2 m³ at 35000 over half a hectare.
    expect(clp).toContain('140000');

    // The euro is still a currency, and still the default — it just has
    // to arrive from the caller like any other.
    const eur = generateReportHtml({
      ...base, bucking: { unitPrice: 35, currency: String.fromCharCode(0x20ac) },
    });
    expect(eur).toContain(`${String.fromCharCode(0x20ac)}/ha`);

    // Free text the user typed, landing in a document somebody else
    // opens — it has to be escaped like every other input.
    const nasty = generateReportHtml({
      ...base, bucking: { unitPrice: 1, currency: '<b>x' },
    });
    expect(nasty).not.toContain('<b>x');
    expect(nasty).toContain('&lt;b&gt;x');
  });

  /** Biomass is ρ·V and carbon a fraction of that, so the basic density
   *  is the largest single assumption behind every tonne on the page.
   *  The report named the SPECIES and never the number, which leaves a
   *  reader unable to check the figure or compare it with another plot
   *  — and for a stand outside the boreal zone, where the species name
   *  is a fallback the user overrode, the name is the less informative
   *  half of the two. */
  it('states the density its carbon figure was computed at', () => {
    const base = {
      projectName: 'Plot 1', plotAreaHa: 0.5, plotAreaBasis: 'boundary',
      metrics: withGap, density: null,
      qsm: { trees: [{ treeId: 1, stemVolume: 2, stemVolumeCi95: 0, branchVolume: 0 }] },
    } as unknown as ReportInputs;
    const biomass = {
      speciesMix: [], fallbackCount: 4, fallbackLabel: 'custom density',
      fallbackDensity: 655,
      biomassKg: 1310, biomassKgCi95: 80,
      carbonKg: 655, carbonKgCi95: 40,
      co2eKg: 2401, co2eKgCi95: 150,
    };

    const html = generateReportHtml({ ...base, biomass });
    expect(html).toContain('655 kg/m³');
    expect(html).toContain('custom density');
    // The fallback count still has to read as a warning, not be
    // absorbed into a clean species-aware claim.
    expect(html).toContain('biomass-fallback');

    // A report from before this field existed still renders — it just
    // says nothing it cannot back up.
    const older = generateReportHtml({
      ...base, biomass: { ...biomass, fallbackDensity: undefined },
    });
    expect(older).toContain('custom density');
    expect(older).not.toContain('kg/m³');
    // And a nonsense stored value is not printed as fact.
    const broken = generateReportHtml({
      ...base, biomass: { ...biomass, fallbackDensity: NaN },
    });
    expect(broken).not.toContain('kg/m³');
  });

  /** Found while writing the test above: a QSM cache from before the
   *  confidence field existed rendered `<td>NaN %</td>` in the per-tree
   *  table, straight into whatever the report was sent to. Five of that
   *  table's six cells called `.toFixed()` raw; the sixth had a
   *  hand-written finite check. */
  it('prints no NaN anywhere, whatever the caches are missing', () => {
    const html = generateReportHtml({
      projectName: 'Plot 1', plotAreaHa: 0.5, plotAreaBasis: 'boundary',
      metrics: withGap, density: null,
      // An old cache: stem volume only, no CI, no confidence.
      qsm: { trees: [{ treeId: 1, stemVolume: 2 }] },
    } as unknown as ReportInputs);
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('undefined');
    // The row is still there — a missing attribute is not a missing
    // tree, which is the whole reason the em dash exists.
    expect(html).toContain('#1');
    expect(html).toContain('—');

    // And the table with no QSM at all takes the same route.
    const plain = generateReportHtml({
      projectName: 'Plot 1', plotAreaHa: 0.5, plotAreaBasis: 'boundary',
      metrics: [...withGap, { ...withGap[0], treeId: 9, crownArea: NaN, height: NaN }],
      qsm: null, density: null,
    } as unknown as ReportInputs);
    expect(plain).not.toContain('NaN');
    expect(plain).toContain('#9');
  });

  /** The Methodology block is the report's bibliography, and it is what
   *  a reader follows to check the numbers. It credited Repola (2006) —
   *  a Finnish wood-density paper — for the biomass figure WHENEVER
   *  biomass was computed, including when the analyst had supplied
   *  their own density, which is the normal case outside the boreal
   *  zone. A citation nobody can follow back is worse than none. */
  it('credits a source only when the number came from it', () => {
    const base = {
      projectName: 'P', plotAreaHa: 0.5, plotAreaBasis: 'boundary',
      metrics: withGap, density: null,
      qsm: { trees: [{ treeId: 1, stemVolume: 2, stemVolumeCi95: 0, branchVolume: 0 }] },
    } as unknown as ReportInputs;
    const biomass = {
      speciesMix: [], fallbackCount: 4, fallbackLabel: 'Scots pine',
      fallbackDensity: 400,
      biomassKg: 800, biomassKgCi95: 50, carbonKg: 400, carbonKgCi95: 25,
      co2eKg: 1467, co2eKgCi95: 90,
    };

    // A bundled preset: the papers behind it are named.
    const preset = generateReportHtml({
      ...base,
      biomass: { ...biomass, fallbackSource: 'Repola 2006 / Kärkkäinen 2007' },
    });
    expect(preset).toContain('Repola, J. (2006)');
    expect(preset).toContain('Silva Fennica 40(4):673–685');

    // The analyst's own figure: no published source is claimed for it.
    const custom = generateReportHtml({
      ...base, biomass: { ...biomass, fallbackDensity: 655, fallbackSource: undefined },
    });
    expect(custom).not.toContain('Repola');
    expect(custom).not.toContain('Silva Fennica');
    expect(custom).toContain('supplied by the analyst');
    // …and the density itself is still stated, which is what a reader
    // needs in place of a citation.
    expect(custom).toContain('655 kg/m³');
  });

  /** Multi-directional hillshade is Mark, R.K. (1992), USGS Open-File
   *  Report 92-422 — the source Esri's own tool cites. The report's
   *  bibliography did not name it at all. */
  it('names the source of every terrain product it renders', () => {
    const html = generateReportHtml({
      projectName: 'P', plotAreaHa: 0.5, plotAreaBasis: 'boundary',
      metrics: withGap, qsm: null, density: null,
    } as unknown as ReportInputs);
    expect(html).toContain('Horn, B.K.P. (1981)');
    expect(html).toContain('Mark, R.K. (1992)');
    expect(html).toContain('Weiss, A. (2001)');
    expect(html).toContain('Zevenbergen, L.W.');
  });

  /** The report was dated in UTC. East of Greenwich that is yesterday
   *  for the first hours of the working day and west of it tomorrow for
   *  the last — a plot measured on Thursday morning in New Zealand
   *  produced a document dated Wednesday. */
  it('is dated by the reader’s calendar, not by Greenwich', () => {
    // Constructed from LOCAL components, so this is exact in every
    // timezone: 6 January 2026, half past midnight, wherever you are.
    expect(localIsoDate(new Date(2026, 0, 6, 0, 30))).toBe('2026-01-06');
    // Padding, both fields, and the last instant of a day.
    expect(localIsoDate(new Date(2026, 8, 9, 23, 59, 59))).toBe('2026-09-09');
    expect(localIsoDate(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
    expect(localIsoDate(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01');
    expect(localIsoDate(new Date(2026, 0, 6))).toHaveLength(10);

    // Where the teeth are. The two assertions above pass under the old
    // UTC implementation whenever the test machine happens to run in
    // UTC, which is exactly what let this through — so the rule is
    // stated against the source instead: nothing in the report may date
    // itself from the UTC clock. Needle split so this line is not its
    // own counterexample.
    // Comments stripped first: generate.ts explains the defect by
    // naming the call it removed, and a scan that read prose would find
    // the bug in its own account of the fix.
    const utcDate = `to${'ISOString'}()`;
    const hits = scanSources('src/report', utcDate);
    expect(hits, `${utcDate} is the UTC date, not the reader's:\n${describeHits(hits)}`).toEqual([]);

    // And the report actually carries it.
    const html = generateReportHtml({
      projectName: 'Plot 1', plotAreaHa: 0.04, plotAreaBasis: 'boundary',
      metrics: withGap, qsm: null, density: null,
    } as unknown as ReportInputs);
    expect(html).toContain(localIsoDate());
  });

  /** The report and the Plot Boundary panel describe the same plot, and
   *  must agree about how many trees are standing in it. */
  it('agrees with the panel on stems and basal area', () => {
    const s = summarise(inputs(withGap));
    // What computePlotStats reports for the same trees, no edge
    // correction: every tree counted, basal area from every diameter.
    expect(s.stemsPerHa).toBeCloseTo(4 / 0.04, 10);
    expect(s.basalAreaPerHa).toBeCloseTo(
      (g(0.30) + g(0.28) + g(0.35) + g(0.32)) / 0.04, 10,
    );
  });
});
