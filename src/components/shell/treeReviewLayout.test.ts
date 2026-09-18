import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The Tree review panel has to fit the frame it is shown in.
 *
 *  It did not. The root declared width 256 inside a 280 frame whose 1 px
 *  border left 254; the bulk species <select> sat beside its button and,
 *  because a flex item's minimum width is its content and a dropdown's
 *  content is its longest option ("Scots pine (Pinus sylvestris)"), it
 *  pushed the button out of the frame — the user saw "Ass" and a
 *  horizontal scrollbar. The count row and the review row each wrapped
 *  their label onto two lines beside their chips. All of it measured in
 *  real Chromium with the panel mounted on fake data, before and after;
 *  these pins keep the after. */
const PANEL = readFileSync(new URL('./TreeReviewPanel.tsx', import.meta.url), 'utf8');
const SHELL = readFileSync(new URL('./EditorShell.tsx', import.meta.url), 'utf8');

/** Every `<select …>` opening tag in the panel, attributes included. The
 *  tags close with a `>` alone on its line, which is what this stops at
 *  (an `=>` inside an onChange would fool a plain `[^>]*`). */
function selectTags(src: string): string[] {
  return src.match(/<select\b[\s\S]*?\n\s*>/g) ?? [];
}

describe('the Tree review panel fits its frame', () => {
  it('takes its width from the frame instead of declaring one', () => {
    expect(PANEL).not.toMatch(/style=\{\{\s*width:\s*256\s*\}\}/);
    expect(PANEL).toContain('<div className="flex flex-col gap-2.5 w-full min-w-0">');
  });

  it('is mounted at the width every row was measured to fit', () => {
    expect(SHELL).toMatch(/<FloatingPanel id="review"[^\n]*\bwidth=\{360\}/);
  });

  it('lets every dropdown shrink below its longest option', () => {
    const tags = selectTags(PANEL);
    expect(tags.length, 'bulk species, species filter, per-tree species').toBeGreaterThanOrEqual(3);
    for (const tag of tags) {
      expect(tag, tag).toMatch(/className="[^"]*\b(?:min-w-0|w-full)\b/);
    }
  });

  it('gives the bulk species dropdown its own line, with the button under it', () => {
    const start = PANEL.indexOf('value={bulkSpecies}');
    expect(start).toBeGreaterThan(0);
    const block = PANEL.slice(PANEL.lastIndexOf('<select', start), PANEL.indexOf('<Hint>', start));
    expect(block).toMatch(/<select\b[\s\S]*?className="w-full min-w-0/);
    expect(block).toMatch(/<button\b[\s\S]*?className="btn !h-7 w-full/);
    // The count stays on the button — it is what tells the user how many
    // trees one click relabels.
    expect(block).toContain('Assign → {realTrees}');
  });

  it('keeps the count row and the review row on one line each', () => {
    // The label gives way (truncates) and the chip group never shrinks,
    // so neither row can wrap or overflow whatever the numbers are.
    const labels = PANEL.match(/<span className="mono text-\[10(?:\.5)?px\] truncate min-w-0"/g) ?? [];
    expect(labels.length, 'count label + reviewed label').toBe(2);
    const chipGroups = PANEL.match(/<div className="flex items-center gap-1 shrink-0">/g) ?? [];
    expect(chipGroups.length, 'sort chips + status chips').toBe(2);
  });
});
