import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HEIGHT_COLORS, getHeightState, heightCsv, heightDataset, heightOverlay, heightReading, keepReading, pickBoth, placePoint,
  resetHeightStore, ringRadius, scaleStep, scaleTicks, setHeightState, tickLabel, type Vec3,
} from './heightStore';

const read = (p: string) => readFileSync(resolve(__dirname, '../../..', p), 'utf8');

describe('the reading of two points', () => {
  it('stands on the lower point whichever is clicked first', () => {
    const root: Vec3 = [10, 20, 100], top: Vec3 = [13, 24, 127.4];
    for (const r of [heightReading(root, top), heightReading(top, root)]) {
      expect(r.low).toEqual(root);
      expect(r.high).toEqual(top);
      expect(r.height).toBeCloseTo(27.4, 9);
      expect(r.horizontal).toBeCloseTo(5, 9);
      expect(r.distance).toBeCloseTo(Math.hypot(5, 27.4), 9);
      expect(r.slopeDeg).toBeCloseTo((Math.atan2(27.4, 5) * 180) / Math.PI, 9);
    }
  });
  it('straight up is 90 degrees, level is 0, one point twice is nothing', () => {
    expect(heightReading([0, 0, 0], [0, 0, 3]).slopeDeg).toBeCloseTo(90, 9);
    expect(heightReading([0, 0, 0], [4, 3, 0]).slopeDeg).toBe(0);
    const same = heightReading([1, 1, 1], [1, 1, 1]);
    expect([same.height, same.distance, same.slopeDeg]).toEqual([0, 0, 0]);
  });
});

describe('the scale', () => {
  it('is ticked at most eight times to the top, on round steps', () => {
    expect(scaleStep(27.4)).toBe(5);
    expect(scaleStep(12)).toBe(2);
    expect(scaleStep(3)).toBe(0.5);
    expect(scaleStep(40)).toBe(5);
    expect(scaleStep(40.1)).toBe(10);
    expect(scaleStep(0.3)).toBe(0.1);
    expect(scaleStep(2000)).toBe(100);
    expect(scaleStep(27.4, 1)).toBe(1);
  });
  it('a 27.4 m tree reads on 0-30 m with lines every 5 m', () => {
    expect(scaleTicks(27.4, 5)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(scaleTicks(30, 5)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(scaleTicks(1.2, 0.2)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1, 1.2]);
    expect(scaleTicks(0, 5)).toEqual([0]);
  });
  it('labels whole metres plainly and finer steps with their decimals', () => {
    expect(tickLabel(25, 5)).toBe('25 m');
    expect(tickLabel(1.5, 0.5)).toBe('1.5 m');
  });
  it('the rings are a twentieth of the scale, between 0.3 and 3 m, unless chosen', () => {
    expect(ringRadius(30)).toBeCloseTo(1.5, 9);
    expect(ringRadius(2)).toBe(0.3);
    expect(ringRadius(200)).toBe(3);
    expect(ringRadius(30, 0.8)).toBe(0.8);
  });
});

describe('what the viewer draws', () => {
  const base = { step: 0, rings: true, radius: 0, labels: true };
  it('one point is a dot only', () => {
    const d = heightOverlay({ ...base, a: [0, 0, 0], b: null });
    expect(d.dots).toHaveLength(1);
    expect(d.segments).toHaveLength(0);
    expect(d.labels).toHaveLength(0);
  });
  it('the scale stands on the lower point and reaches the next step above the higher one', () => {
    const d = heightOverlay({ ...base, a: [5, 5, 127.4], b: [2, 1, 100] });
    const scale = d.segments.find((s) => s.color === HEIGHT_COLORS.scale)!;
    expect(scale.a).toEqual([2, 1, 100]);
    expect(scale.b).toEqual([2, 1, 130]);
    const tickLabels = d.labels.filter((l) => l.color === HEIGHT_COLORS.tick).map((l) => l.text);
    expect(tickLabels).toEqual(['0 m', '5 m', '10 m', '15 m', '20 m', '25 m', '30 m']);
    const height = d.labels.find((l) => l.strong)!;
    expect(height.text).toBe('27.40 m');
    expect(height.sub).toBe(`↗ ${Math.hypot(5, 27.4).toFixed(2)} m · ↔ 5.00 m`);
    expect(d.labels).toHaveLength(8);
    expect(height.p[2]).toBeCloseTo(127.4, 9);
    // a ring at every line but the foot, and one at the higher point, all around the scale
    const rings = d.segments.filter((s) => s.color === HEIGHT_COLORS.tick && Math.abs(Math.hypot(s.a[0] - 2, s.a[1] - 1) - 1.5) < 1e-9 && s.a[2] === s.b[2]);
    expect(new Set(rings.map((s) => s.a[2])).size).toBe(6);
    expect(d.segments.some((s) => s.color === HEIGHT_COLORS.top && s.a[2] === 127.4 && s.b[2] === 127.4)).toBe(true);
  });
  it('without rings or labels only the ticks and the height stay', () => {
    const d = heightOverlay({ ...base, rings: false, labels: false, a: [0, 0, 0], b: [0, 0, 10] });
    expect(d.labels.map((l) => l.text)).toEqual(['10.00 m']);
    // scale, two strokes per tick (0..10 by 2 m: 6 ticks), 4 minor per step, the line between the points
    expect(d.segments).toHaveLength(1 + 6 * 2 + 5 * 4 + 1);
  });
});

describe('the store', () => {
  beforeEach(() => resetHeightStore());
  it('asks for the first point, then the second, then stops', () => {
    pickBoth();
    expect(getHeightState().picking).toBe('a');
    placePoint([0, 0, 0]);
    expect(getHeightState().picking).toBe('b');
    placePoint([0, 0, 20]);
    expect(getHeightState()).toMatchObject({ a: [0, 0, 0], b: [0, 0, 20], picking: null });
    // one end again keeps the other
    setHeightState({ picking: 'b' });
    placePoint([1, 1, 25]);
    expect(getHeightState()).toMatchObject({ a: [0, 0, 0], b: [1, 1, 25], picking: null });
    // a click while not picking does nothing
    placePoint([9, 9, 9]);
    expect(getHeightState().b).toEqual([1, 1, 25]);
  });
  it('keeps readings and writes them as CSV, oldest first', () => {
    setHeightState({ a: [0, 0, 100], b: [0, 0, 120] });
    keepReading('tree 1');
    setHeightState({ a: [3, 4, 100], b: [0, 0, 110] });
    keepReading('crown base, "low"');
    const rows = heightCsv(getHeightState().kept);
    expect(rows[0]).toBe('idx,height_m,distance_3d_m,horizontal_m,slope_deg,base_x,base_y,base_z,top_x,top_y,top_z,note');
    expect(rows[1]).toBe('1,20.000,20.000,0.000,90.0,0.000,0.000,100.000,0.000,0.000,120.000,tree 1');
    expect(rows[2]).toMatch(/^2,10\.000,11\.180,5\.000,63\.4,3\.000,4\.000,100\.000,0\.000,0\.000,110\.000,"crown base, ""low"""$/);
  });
  it('another dataset starts afresh, the settings stay', () => {
    heightDataset('a');
    setHeightState({ a: [0, 0, 0], b: [0, 0, 1], step: 2, rings: false });
    keepReading();
    heightDataset('a');
    expect(getHeightState().kept).toHaveLength(1);
    heightDataset('b');
    expect(getHeightState()).toMatchObject({ dir: 'b', a: null, b: null, kept: [], step: 2, rings: false });
  });
});

describe('the Height panel is wired in', () => {
  it('has a button, a panel, a palette command and menu items', () => {
    expect(read('src/components/shell/OctreeShellContext.tsx')).toMatch(/export type PanelId = [^;]*'height'/);
    const bar = read('src/components/shell/ActivityBar.tsx');
    expect(bar).toContain('<PanelToggle id="height" label="Height — ');
    expect(bar).toMatch(/active=\{\['survey', 'height',/);
    const shell = read('src/components/shell/EditorShell.tsx');
    expect(shell).toContain('<FloatingPanel id="height" title="Height"');
    expect(shell).toContain("panel('height', ");
    expect(read('src/components/shell/menuActions.ts')).toContain("'panel-height': panel('height'),");
    expect(read('src-tauri/src/menu.rs')).toContain('"Height Between Two Points…", "panel-height"');
    expect(read('src/three/SurveyOverlay.tsx')).toContain('<HeightOverlay offset={offset} terrain={terrain} />');
  });
  it('hands the viewer its pickers as updaters, as React state wants', () => {
    for (const f of ['src/components/shell/HeightPanel.tsx', 'src/components/shell/SurveyPanel.tsx']) {
      expect(read(f), f).toContain('setWorldPicker(s.picking ? () => pick : null);');
    }
  });
});
