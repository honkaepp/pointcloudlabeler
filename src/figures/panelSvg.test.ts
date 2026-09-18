import { describe, it, expect } from 'vitest';
import {
  renderQcPanelSvg, wrapText, fitChars, checkLegibility, printedCm, widthForLegibility,
  selectFlags, MONO_ADVANCE, TEXT, MIN_PRINTED_CM, type QcPanelFigure,
} from './panelSvg';
import type { Flag } from '../metrics/qcFlags';

const flag = (treeId: number, code: Flag['code'], severity: Flag['severity'], reason: string, hint: string): Flag =>
  ({ treeId, code, severity, reason, hint });

const FLAGS: Flag[] = [
  flag(36, 'crown-small', 'warning', 'Crown 1.2 m across, well under the 4.8 m the plot median suggests for a tree this tall.',
    'Likely a fragment of a neighbouring crown. Merge it into the right tree.'),
  flag(12, 'no-dbh', 'critical', 'No DBH could be fitted at breast height.', 'Check the stem points between 1.2 and 1.4 m.'),
  flag(7, 'slenderness', 'warning', 'Height/diameter 142, far above the plot median of 78.', 'Check the height and the DBH fit.'),
  flag(51, 'few-points', 'warning', 'Only 412 points on this tree.', 'Segmentation may have split it.'),
];

const figure = (over: Partial<QcPanelFigure> = {}): QcPanelFigure => ({
  flags: FLAGS, shown: 4, total: 105, flaggedTrees: 65, treeCount: 65,
  counts: { critical: 7, warning: 91, info: 7 },
  byCode: [['qsm-completeness', 56], ['slenderness', 14], ['few-points', 7], ['no-dbh', 7], ['crown-small', 3]],
  hiddenCodes: ['qsm-completeness'],
  sort: 'severity', width: 480, ...over,
});

/** The QC panel prints at 4.9 pt and 160 dpi when it is a screen
 *  capture. Laying it out narrower raises the printed type size and a
 *  higher device pixel ratio raises the dpi; neither is reachable from
 *  a capture and neither alone is enough. */
describe('the QC panel as a figure', () => {
  it('lays out at the width it is given, and says so in the document', () => {
    const r = renderQcPanelSvg(figure());
    expect(r.width).toBe(480);
    expect(r.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="480"')).toBe(true);
    expect(r.svg).toContain(`viewBox="0 0 480 ${r.height}"`);
    expect(r.height).toBeGreaterThan(100);
    expect(r.rows).toBe(4);
  });

  it('keeps the header counters, the severity chips, the filter chips and the sort state', () => {
    const r = renderQcPanelSvg(figure());
    // The counters are what makes the review auditable and the first
    // thing a reader checks.
    expect(r.svg).toContain('4/105 flags on 65 of 65 trees');
    expect(r.svg).toContain('7 critical');
    expect(r.svg).toContain('91 warn');
    expect(r.svg).toContain('7 info');
    // Every check, so a reader can see that 56 QSM flags were filtered
    // out rather than wondering where the trees went.
    expect(r.svg).toContain('QSM gaps 56');
    expect(r.svg).toContain('crown too small 3');
    expect(r.svg).toContain('[severity]');
    expect(renderQcPanelSvg(figure({ sort: 'tree' })).svg).toContain('[tree]');
  });

  it('wraps every reason and hint instead of clipping — the words are the content', () => {
    const r = renderQcPanelSvg(figure({ width: 320 }));
    // The long hint the brief names, whole, across however many lines.
    const text = r.svg.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(text).toContain('Likely a fragment of a neighbouring crown. Merge it');
    expect(text).toContain('into the right tree.');
    // No drawn line is wider than its column at the widest monospace
    // face the document asks for.
    const textW = 320 - 10 - 3 - 8 - 10;
    for (const m of r.svg.matchAll(/font-size="(10|9\.5)"[^>]*>([^<]*)</g)) {
      expect(m[2].length * Number(m[1]) * MONO_ADVANCE).toBeLessThanOrEqual(textW + 0.001);
    }
  });

  it('wraps a word longer than the whole column rather than overflowing', () => {
    const lines = wrapText('a '.repeat(3) + 'x'.repeat(200), 100, 10);
    expect(lines.every((l) => l.length <= fitChars(100, 10))).toBe(true);
    expect(lines.join('').replace(/\s/g, '')).toContain('x'.repeat(50));
    expect(wrapText('', 100, 10)).toEqual(['']);
  });

  it('checks legibility as arithmetic, and names the width that would pass', () => {
    // 9 px type at 480 px wide, printed 8 cm: 0.15 cm ≈ 4.3 pt. Fails.
    const bad = checkLegibility(480, 8, 9);
    expect(bad.ok).toBe(false);
    expect(bad.printedCm).toBeCloseTo(0.15, 3);
    expect(bad.suggestedWidth).toBe(342);
    expect(bad.message).toMatch(/lay the panel out at 342 px or narrower/);
    // …and at that width it passes.
    expect(checkLegibility(342, 8, 9).ok).toBe(true);
    // The brief's own arithmetic: 11 px type at 480 px printed 8 cm.
    expect(printedCm(11, 480, 8) * 28.35).toBeCloseTo(5.2, 1);
    expect(widthForLegibility(TEXT.code, 8)).toBe(342);
    // The brief's floor, stated as 0.21 cm and called 6 pt (6 pt is
    // 0.2116 cm; the round number is what the check uses).
    expect(MIN_PRINTED_CM).toBe(0.21);
    expect(MIN_PRINTED_CM).toBeCloseTo(6 / 28.35, 2);
    const r = renderQcPanelSvg(figure({ width: 342 }), { printedWidthCm: 8 });
    expect(r.legibility.ok).toBe(true);
  });

  it('draws the same document twice — a figure is re-runnable or it is not a specification', () => {
    expect(renderQcPanelSvg(figure()).svg).toBe(renderQcPanelSvg(figure()).svg);
  });

  it('resolves every colour, because an SVG outside the application has no CSS variables', () => {
    for (const dark of [false, true]) {
      const r = renderQcPanelSvg(figure({ flags: [flag(1, 'few-points', 'info', 'r', 'h')] }), { dark });
      expect(r.svg).not.toContain('var(--');
    }
  });

  it('escapes what the flag text may contain', () => {
    const r = renderQcPanelSvg(figure({ flags: [flag(1, 'no-dbh', 'critical', 'height < 2 m & "short"', 'fix it')] }));
    expect(r.svg).toContain('height &lt; 2 m &amp; &quot;short&quot;');
  });

  it('selects the rows the figure shows: the filters, the sort, the first N', () => {
    const shown = selectFlags(FLAGS, { hiddenCodes: ['few-points'], sort: 'severity', rowCount: 2 });
    expect(shown.map((f) => f.treeId)).toEqual([12, 7]);
    expect(shown[0].severity).toBe('critical');
    const byTree = selectFlags(FLAGS, { sort: 'tree' });
    expect(byTree.map((f) => f.treeId)).toEqual([7, 12, 36, 51]);
    expect(selectFlags(FLAGS, { severities: ['critical'] }).map((f) => f.treeId)).toEqual([12]);
    // The same input gives the same order, whatever the input order.
    const shuffled = [FLAGS[3], FLAGS[0], FLAGS[2], FLAGS[1]];
    expect(selectFlags(shuffled, { sort: 'severity' })).toEqual(selectFlags(FLAGS, { sort: 'severity' }));
  });
});
