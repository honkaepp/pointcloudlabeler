import { describe, it, expect } from 'vitest';
import {
  parseSpec, serializeSpec, frameExtent, figureFileName, isHexColor,
  FIGURE_SPEC_FORMAT, FIGURE_SPEC_VERSION, DEFAULT_UNCLASSIFIED_COLOR, type FigureSpec,
} from './figureSpec';
import { DEFAULT_DISPLAY } from '../components/shell/OctreeShellContext';

const SPEC: FigureSpec = {
  format: FIGURE_SPEC_FORMAT,
  version: FIGURE_SPEC_VERSION,
  name: 'fig3',
  title: 'The transfer',
  parts: [{
    kind: 'viewport', file: 'fig3_a.png', datasetDir: 'C:/p/octrees/tls', datasetName: 'Evo_TLS_2021_1001',
    width: 2400, height: 1800, background: 'white', colorMode: 'tree_id', unclassified: 'hidden',
    unclassifiedColor: '#3c3c3c',
    camera: { position: [10, -20, 12], target: [0, 0, 8], up: [0, 0, 1], fov: 45 },
    isolateTreeId: null, isolateMargin: 1, pointSize: 2.4, scaleBar: false,
  }],
  compose: { rows: 2, cols: 2, gutter: 70, margin: 40, crop: null, printedWidthCm: 16, file: 'fig3.png' },
};

/** A figure that cannot be re-run rots the moment anything upstream
 *  changes, and a reviewer cannot check how it was made. */
describe('the figure specification', () => {
  it('draws the unclassified in the viewer\'s own grey unless told otherwise', () => {
    // The figure and the screen agree by default; a specification an
    // earlier build wrote names no colour and meant this one.
    expect(DEFAULT_UNCLASSIFIED_COLOR).toBe(DEFAULT_DISPLAY.unlabeledColor);
    const old = JSON.parse(serializeSpec(SPEC)) as { parts: Record<string, unknown>[] };
    delete old.parts[0].unclassifiedColor;
    const back = parseSpec(JSON.stringify(old));
    expect(back.parts[0]).toMatchObject({ unclassifiedColor: DEFAULT_UNCLASSIFIED_COLOR });
    // …and a colour it does name is kept as it is.
    expect(parseSpec(serializeSpec(SPEC)).parts[0]).toMatchObject({ unclassifiedColor: '#3c3c3c' });
    // Only a #rrggbb is a colour here — what a colour input yields and
    // what the renderer's hex parser reads.
    expect(isHexColor('#3c3c3c')).toBe(true);
    expect(isHexColor('#3C3C3C')).toBe(true);
    for (const bad of ['3c3c3c', '#3c3', 'grey', '#3c3c3c3c', 12, null, undefined]) expect(isHexColor(bad), String(bad)).toBe(false);
  });

  it('round-trips, and byte-identically — the same specification twice is the same file', () => {
    const text = serializeSpec(SPEC);
    expect(serializeSpec(SPEC)).toBe(text);
    const back = parseSpec(text);
    expect(back).toEqual(SPEC);
    expect(serializeSpec(back)).toBe(text);
  });

  it('refuses a file it did not write, and one from a newer build', () => {
    expect(() => parseSpec('{"format":"something-else"}')).toThrow(/not a PointCloudLabeler figure specification/);
    expect(() => parseSpec(JSON.stringify({ ...SPEC, version: 99 }))).toThrow(/newer than this build/);
    expect(() => parseSpec(JSON.stringify({ ...SPEC, parts: [] }))).toThrow(/no parts/);
    expect(() => parseSpec(JSON.stringify({ ...SPEC, name: '' }))).toThrow(/no name/);
  });

  it('gives the world extent of the frame, so a caption need not measure it', () => {
    // 45° vertical field at 20 m: 2 · 20 · tan(22.5°) = 16.57 m tall.
    const e = frameExtent({ position: [0, 0, 20], target: [0, 0, 0], up: [0, 0, 1], fov: 45 }, 4 / 3);
    expect(e.heightM).toBeCloseTo(16.569, 3);
    expect(e.widthM).toBeCloseTo(22.0914, 3);
  });

  it('names its files the same way every run, so a re-run replaces its own outputs', () => {
    expect(figureFileName('fig2', 'a_qc', 'svg')).toBe('fig2_a_qc.svg');
    expect(figureFileName('fig3', 'composed', 'png')).toBe('fig3_composed.png');
  });
});
