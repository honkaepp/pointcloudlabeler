import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  applyXray, bindViewDataset, getViewTools, lapseIndex, poseAt, resetViewTools, setViewTools, slabAt, videoType,
  type CameraPose,
} from './viewToolsStore';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('animation timing', () => {
  it('flies through every keyframe, smoothly, from the first to the last', () => {
    const keys: CameraPose[] = [
      { position: [0, 10, 0], target: [0, 0, 0] },
      { position: [10, 10, 0], target: [5, 0, 0] },
      { position: [10, 10, 10], target: [5, 0, 5] },
    ];
    expect(poseAt(keys, 0)).toEqual(keys[0]);
    const mid = poseAt(keys, 0.5)!;
    mid.position.forEach((c, i) => expect(c).toBeCloseTo(keys[1].position[i], 9));
    const end = poseAt(keys, 1.2)!;
    end.target.forEach((c, i) => expect(c).toBeCloseTo(keys[2].target[i], 9));
    // between keyframes the path bends, it does not jump
    const a = poseAt(keys, 0.24)!, b = poseAt(keys, 0.26)!;
    expect(Math.hypot(a.position[0] - b.position[0], a.position[2] - b.position[2])).toBeLessThan(1);
    expect(poseAt([], 0.5)).toBeNull();
  });

  it('moves the slab across the extent along its direction', () => {
    const min: [number, number, number] = [100, 200, 50], max: [number, number, number] = [140, 260, 80];
    const bottom = slabAt('height', 0, 0.4, min, max, 0);
    expect(bottom.anchor).toEqual([120, 230, 50]);
    expect(bottom.normal).toEqual([0, 0, 1]);
    expect(bottom.halfHeight).toBeCloseTo(0.2, 12);
    expect(slabAt('height', 0, 0.4, min, max, 1).anchor[2]).toBe(80);
    expect(slabAt('east', 0, 1, min, max, 0.5).anchor).toEqual([120, 230, 65]);
    const ne = slabAt('bearing', 90, 1, min, max, 1);
    expect(ne.normal[0]).toBeCloseTo(1, 12);
    expect(ne.anchor[0]).toBeCloseTo(140, 9);
  });

  it('shows each dataset of a lapse for its share of the time', () => {
    expect([0, 0.32, 0.34, 0.99, 1].map((u) => lapseIndex(3, u))).toEqual([0, 0, 1, 2, 2]);
    expect(lapseIndex(0, 0.5)).toBe(-1);
  });

  it('records MP4 where it can, else WebM', () => {
    expect(videoType((t) => t.startsWith('video/mp4'))).toEqual({ mime: 'video/mp4;codecs=avc1', ext: 'mp4' });
    expect(videoType((t) => t === 'video/webm;codecs=vp8')).toEqual({ mime: 'video/webm;codecs=vp8', ext: 'webm' });
    expect(videoType(() => false)).toBeNull();
  });
});

describe('X-ray', () => {
  it('turns a point material additive without depth, and back as it was', () => {
    const m = new THREE.ShaderMaterial();
    const before = { blending: m.blending, transparent: m.transparent, depthTest: m.depthTest, depthWrite: m.depthWrite };
    expect(applyXray(m, true, 0.1)).toBe(true);
    expect([m.blending, m.blendSrc, m.blendDst, m.depthTest, m.depthWrite]).toEqual([THREE.CustomBlending, THREE.ConstantColorFactor, THREE.OneFactor, false, false]);
    expect(m.blendColor.r).toBeCloseTo(0.1, 6);
    expect(applyXray(m, true, 0.1)).toBe(false);
    expect(applyXray(m, true, 0.3)).toBe(true);
    expect(applyXray(m, false, 0.3)).toBe(true);
    expect({ blending: m.blending, transparent: m.transparent, depthTest: m.depthTest, depthWrite: m.depthWrite }).toEqual(before);
    expect(applyXray(m, false, 0.3)).toBe(false);
  });
});

describe('the store and the wiring', () => {
  beforeEach(() => resetViewTools());

  it('keeps keyframes per dataset', () => {
    bindViewDataset('D:/a');
    setViewTools({ keyframes: [{ position: [0, 0, 0], target: [1, 0, 0] }], xray: true });
    bindViewDataset('D:/a');
    expect(getViewTools().keyframes).toHaveLength(1);
    bindViewDataset('D:/b');
    expect(getViewTools().keyframes).toHaveLength(0);
    expect(getViewTools().xray).toBe(true);
  });

  it('is in the panel list, the activity bar, the shell, the viewer, the menu and the palette', () => {
    expect(read('./OctreeShellContext.tsx')).toContain("'viewtools'");
    expect(read('./ActivityBar.tsx')).toContain('<PanelToggle id="viewtools"');
    const shell = read('./EditorShell.tsx');
    expect(shell).toContain('<FloatingPanel id="viewtools"');
    expect(shell).toContain("viewToolsPaletteCommands(() => togglePanel('viewtools'))");
    expect(read('../../three/SurveyOverlay.tsx')).toContain('<ViewTools />');
    expect(read('../../../src-tauri/src/menu.rs')).toContain('"panel-viewtools"');
    expect(read('./menuActions.ts')).toContain("'panel-viewtools': panel('viewtools')");
  });
});
