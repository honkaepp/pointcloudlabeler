// The editor's first look: the left bar can show the tool names, panels
// fold from a bigger square, and a trajectory is a layer of its own.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';
import { shortName } from './activityNames';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('the widened activity bar', () => {
  it('names each tool by its label, without the description', () => {
    expect(shortName('Survey — measure lines and areas, contour lines, volumes')).toBe('Survey');
    expect(shortName('Thinning simulator (harvennus)')).toBe('Thinning simulator');
    expect(shortName('Tree Skeleton Transfer (TST) — baseline → target labels')).toBe('Tree Skeleton Transfer');
    expect(shortName('Filters (2 active)')).toBe('Filters');
    expect(shortName('Point QC — reflectance / outlier / wind')).toBe('Point QC');
    expect(shortName('Layers')).toBe('Layers');
    expect(shortName('(odd)')).toBe('(odd)');
  });
  it('is one button away and remembered', () => {
    const bar = read('./ActivityBar.tsx');
    expect(bar).toContain("const WIDE_KEY = 'pointcloudlabeler-activity-wide';");
    expect(bar).toContain('onClick={toggleWide}');
    expect(bar).toContain('<Wide.Provider value={wide}>');
    // both kinds of button show the name when wide
    expect(bar.match(/\{wide && <NameBeside label=\{label\} \/>\}/g)?.length).toBe(2);
    expect(bar.match(/className=\{buttonClass\(wide\)\}/g)?.length).toBe(2);
  });
});

describe('a floating panel', () => {
  it('folds and closes from a 28 px square, not the 10 px icon', () => {
    const panel = read('./FloatingPanel.tsx');
    expect(panel).toMatch(/const HEADER_BUTTON =\s*'shrink-0 w-7 h-7 -my-1\.5 -mx-1\.5 /);
    expect(panel.match(/className=\{`\$\{HEADER_BUTTON\} opacity-\d0`\}/g)?.length).toBe(2);
  });
});

describe('a trajectory', () => {
  it('is a layer: shown, hidden and removed in the Layers panel', () => {
    const layers = read('./LayersPanel.tsx');
    expect(layers).toContain('const { trajectories, meshes, features } = useSurveyStore();');
    expect(layers).toContain('onToggle={() => updateTrajectory(t.path, { visible: !t.visible })}');
    expect(layers).toContain('onRemove={() => removeTrajectory(t.path)}');
  });
});
