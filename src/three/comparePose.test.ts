import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  worldToScene, sceneToWorld, dirToScene, dirToWorld, poseToScene, poseFromScene, posesEqual,
  heightBasesFor, footprintIntersection,
  defaultPose, extentOf, serializeViews, parseViews, splitBudget, exportBudget, exportPointSize,
  sideBySideSize, clampExportSize, buildSidecar, exportFileNames, exportStamp, MIN_PANE_BUDGET,
  SIDE_BY_SIDE_GUTTER_PX, type CameraPose, type Vec3,
  applyRigid, invertRigid, boxThrough, alignmentToWorld,
} from './comparePose';
import { toSceneXYZ } from '../io/sceneAxes';

const LEFT_OFFSET: Vec3 = [2_600_000, 1_200_000, 500];
const RIGHT_OFFSET: Vec3 = [2_600_012.25, 1_199_988.5, 497.75];

const POSE: CameraPose = {
  position: [2_600_030.125, 1_200_010.5, 540.25],
  target: [2_600_020, 1_200_020, 520],
  up: [0, 0, 1],
  fov: 45,
};

describe('one camera in world coordinates drives two scenes', () => {
  it('converts with the editor\u2019s own axis convention', () => {
    // The same remap the octree decoder and the planner use.
    const w: Vec3 = [2_600_005, 1_200_007, 511];
    const expected = toSceneXYZ(w[0] - LEFT_OFFSET[0], w[1] - LEFT_OFFSET[1], w[2] - LEFT_OFFSET[2]);
    expect(worldToScene(w, LEFT_OFFSET)).toEqual(expected);
    expect(sceneToWorld(worldToScene(w, LEFT_OFFSET), LEFT_OFFSET)).toEqual(w);
    expect(dirToWorld(dirToScene([0, 0, 1]))).toEqual([0, 0, 1]);
    expect(dirToScene([0, 0, 1]), 'world up is scene +Y').toEqual([0, 1, 0]);
    expect(dirToScene([0, 1, 0]), 'north is scene −Z').toEqual([0, 0, -1]);
  });

  it('round-trips a pose through a THREE camera on either side to 1e-6', () => {
    // Set the pose in the left pane, read it back from the right: the
    // brief's camera-sync round trip. The two panes have different
    // offsets, so a pose that only survived one offset would fail here.
    for (const offset of [LEFT_OFFSET, RIGHT_OFFSET]) {
      const sp = poseToScene(POSE, offset);
      const cam = new THREE.PerspectiveCamera(sp.fov, 4 / 3, 0.1, 1000);
      cam.position.set(...sp.position);
      cam.up.set(...sp.up);
      const target = new THREE.Vector3(...sp.target);
      cam.lookAt(target);
      const back = poseFromScene({
        position: [cam.position.x, cam.position.y, cam.position.z],
        target: [target.x, target.y, target.z],
        up: [cam.up.x, cam.up.y, cam.up.z],
        fov: cam.fov,
      }, offset);
      expect(posesEqual(back, POSE, 1e-6), `offset ${offset.join(',')}: ${JSON.stringify(back)}`).toBe(true);
    }
    // And the two panes agree with each other about where that is.
    const l = poseToScene(POSE, LEFT_OFFSET);
    const r = poseToScene(POSE, RIGHT_OFFSET);
    const lw = sceneToWorld(l.position, LEFT_OFFSET);
    const rw = sceneToWorld(r.position, RIGHT_OFFSET);
    expect(Math.hypot(lw[0] - rw[0], lw[1] - rw[1], lw[2] - rw[2])).toBeLessThan(1e-6);
    // The scene positions themselves DIFFER by the offset difference —
    // which is why a shared scene pose would have been wrong.
    expect(Math.abs(l.position[0] - r.position[0])).toBeCloseTo(12.25, 6);
  });

  it('puts a cloud in elevation at the height of a normalised one, by a constant base per side', () => {
    // TLS normalised (z 0–35) beside HeliALS in elevation (z 540–590):
    // 540 m apart under one camera. With alignment the elevation side's
    // base is its ground level, the normalised side's is zero, and the
    // shared pose's z is a height on both.
    const bases = heightBasesFor(true, { guess: 'above_ground', groundZ: null }, { guess: 'absolute', groundZ: 545.3 });
    expect(bases).toEqual({ source: 0, target: 545.3 });
    expect(heightBasesFor(false, { guess: 'above_ground', groundZ: null }, { guess: 'absolute', groundZ: 545.3 })).toEqual({ source: 0, target: 0 });
    expect(heightBasesFor(true, { guess: 'absolute', groundZ: null }, { guess: 'absolute', groundZ: NaN }), 'no ground level: no base').toEqual({ source: 0, target: 0 });
    // A pose at height 20 m lands 20 m above each cloud's own ground.
    const pose: CameraPose = { position: [2_600_030, 1_200_010, 20], target: [2_600_020, 1_200_020, 10], up: [0, 0, 1], fov: 45 };
    const left = poseToScene(pose, [2_600_000, 1_200_000, 0], bases.source);
    const right = poseToScene(pose, [2_600_000, 1_200_000, 541], bases.target);
    expect(left.position[1]).toBeCloseTo(20, 9);
    expect(right.position[1]).toBeCloseTo(20 + 545.3 - 541, 9);
    // And back: the shared pose is what either pane reads.
    expect(posesEqual(poseFromScene(right, [2_600_000, 1_200_000, 541], bases.target), pose, 1e-9)).toBe(true);
    // The ground level is asked for under the footprint the two share.
    const tls = { min: [10, 10, 0] as Vec3, max: [70, 70, 35] as Vec3 };
    const als = { min: [0, 0, 540] as Vec3, max: [200, 200, 590] as Vec3 };
    expect(footprintIntersection(tls, als)).toEqual([10, 10, 70, 70]);
    expect(footprintIntersection(tls, { min: [100, 100, 0] as Vec3, max: [110, 110, 1] as Vec3 })).toBeNull();
  });

  it('opens on the editor\u2019s start view over both clouds', () => {
    const a = { min: [0, 0, 0] as Vec3, max: [60, 60, 30] as Vec3 };
    const b = { min: [10, -20, 0] as Vec3, max: [70, 40, 35] as Vec3 };
    const p = defaultPose([a, b]);
    // Union box 0..70 × −20..60 × 0..35, extent 80.
    expect(p.target).toEqual([35, 20, 17.5]);
    expect(p.position).toEqual([35 + 64, 20 - 64, 17.5 + 48]);
    expect(p.up).toEqual([0, 0, 1]);
    expect(extentOf([a, b])).toBe(80);
    // The scene position matches OctreeView's startCamera for one cloud.
    const one = defaultPose([a]);
    const sp = poseToScene(one, [0, 0, 0]);
    expect(sp.position).toEqual([30 + 48, 15 + 36, -30 + 48]);
  });
});

describe('saved views', () => {
  it('read back exactly what was written, and nothing that was not a view', () => {
    const view = {
      name: 'Fig 4 before repair',
      savedAt: '2026-09-14T07:00:00.000Z',
      pose: POSE,
      source: { dir: 'C:/proj/octrees/a', name: 'a.las' },
      target: { dir: 'C:/proj/octrees/b', name: 'b.las' },
    };
    const text = serializeViews([view]);
    const back = parseViews(text);
    expect(back).toHaveLength(1);
    expect(posesEqual(back[0].pose, POSE, 0)).toBe(true);
    expect(back[0]).toEqual(view);
    // A view saved under a height base carries it; one from before
    // alignment existed has none, which reads as zero on both sides.
    const based = parseViews(serializeViews([{ ...view, name: 'based', heightBase: { source: 0, target: 545.3 } }]));
    expect(based[0].heightBase).toEqual({ source: 0, target: 545.3 });
    expect(back[0].heightBase).toBeUndefined();
    // A malformed entry is dropped, the good one survives.
    const damaged = JSON.parse(text);
    damaged.views.push({ name: 'broken', pose: { position: [1, 2] } });
    damaged.views.push({ name: 'nan', savedAt: 'x', pose: { position: [1, 2, NaN], target: [0, 0, 0], up: [0, 0, 1], fov: 45 }, source: view.source, target: view.target });
    expect(parseViews(JSON.stringify(damaged))).toHaveLength(1);
  });

  it('refuses a file that is something else', () => {
    expect(() => parseViews('{"format":"plot","views":[]}')).toThrow(/compare-views/);
    expect(() => parseViews('[]')).toThrow();
  });
});

describe('the export', () => {
  it('splits the live budget and plans the export at the full one', () => {
    expect(splitBudget(4_000_000)).toBe(2_000_000);
    expect(splitBudget(100)).toBe(MIN_PANE_BUDGET);
    expect(exportBudget(4_000_000)).toBe(4_000_000);
    expect(exportBudget(4_000_000)).toBeGreaterThanOrEqual(splitBudget(4_000_000) * 2);
  });

  it('gives both panes identical dimensions and a fixed gutter', () => {
    const size = clampExportSize(2400, 1800);
    expect(size).toEqual({ width: 2400, height: 1800 });
    expect(sideBySideSize(size.width, size.height)).toEqual({ width: 4800 + SIDE_BY_SIDE_GUTTER_PX, height: 1800 });
    expect(clampExportSize(NaN, 1e9)).toEqual({ width: 2400, height: 8192 });
    expect(exportPointSize(1, 900, 1800)).toBe(2);
    expect(exportPointSize(2.5, 1000, 1800)).toBe(4.5);
    expect(exportPointSize(1, 0, 1800)).toBe(1);
  });

  it('writes the live camera into the sidecar, and the four file names from one base', () => {
    const s = buildSidecar({
      appVersion: '0.1.0', exportedAt: '2026-09-14T07:48:35Z', camera: POSE, heightBase: { source: 0, target: 545.3 },
      colorMode: 'tree_id', hideUnlabeled: true, skeletonOverlay: false, skeletonColor: null, pixelSize: { width: 2400, height: 1800 },
      source: { dir: 'a', name: 'a.las', pointsRendered: 3_900_000, file: 'x_source.png' },
      target: { dir: 'b', name: 'b.las', pointsRendered: 3_800_000, file: 'x_target.png' },
      sideBySide: 'x_side-by-side.png',
    });
    expect(s.camera).toEqual(POSE);
    expect(s.camera).not.toBe(POSE);
    expect(s.heightBase).toEqual({ source: 0, target: 545.3 });
    expect(s.hideUnlabeled).toBe(true);
    expect(s.sideBySide).toEqual({ file: 'x_side-by-side.png', gutterPx: SIDE_BY_SIDE_GUTTER_PX });
    expect(s.app).toEqual({ name: 'PointCloudLabeler', version: '0.1.0' });
    expect(exportFileNames('D:/figs/compare_2026', true)).toEqual({
      source: 'D:/figs/compare_2026_source.png',
      target: 'D:/figs/compare_2026_target.png',
      sideBySide: 'D:/figs/compare_2026_side-by-side.png',
      sidecar: 'D:/figs/compare_2026.json',
    });
    expect(exportFileNames('x', false).sideBySide).toBeNull();
    expect(exportStamp(new Date('2026-09-14T07:48:35.123Z'))).toBe('2026-09-14T07-48-35');
  });
});

/** The Compare's target pane looks through the skeleton alignment —
 *  the source's skeletons onto the target's trees — so the two panes
 *  show the same tree although the clouds stand apart. */
describe('the target pane through the alignment', () => {
  const rigid = { theta: 0.02, dx: 12.5, dy: -3.0, cx: 100, cy: 200 };
  const offset: [number, number, number] = [50, 60, 5];

  it('a rigid transform and its inverse cancel, and a box goes through by its corners', () => {
    const [x, y] = applyRigid(rigid, 130, 210);
    const [bx, by] = applyRigid(invertRigid(rigid), x, y);
    expect(bx).toBeCloseTo(130, 9);
    expect(by).toBeCloseTo(210, 9);
    const box = boxThrough({ min: [0, 0, 1], max: [10, 20, 30] }, { theta: 0, dx: 5, dy: -5, cx: 0, cy: 0 });
    expect(box).toEqual({ min: [5, -5, 1], max: [15, 15, 30] });
    expect(boxThrough({ min: [0, 0, 1], max: [10, 20, 30] }, null)).toEqual({ min: [0, 0, 1], max: [10, 20, 30] });
    expect(alignmentToWorld({ dx: 1, dy: 2, theta: 0.1, cx: 3, cy: 4 }, [1000, 2000, 50])).toEqual({ theta: 0.1, dx: 1, dy: 2, cx: 1003, cy: 2004 });
  });

  it('the pose goes into the aligned pane through the transform and comes back out of it unchanged', () => {
    const pose = { position: [120, 230, 30] as [number, number, number], target: [110, 215, 10] as [number, number, number], up: [0, 0, 1] as [number, number, number], fov: 45 };
    const scene = poseToScene(pose, offset, 2, rigid);
    // The target point moved by the transform (+ the height base) before the scene mapping.
    const [tx, ty] = applyRigid(rigid, 110, 215);
    expect(scene.target[0]).toBeCloseTo(tx - offset[0], 9);
    expect(scene.target[2]).toBeCloseTo(0 - (ty - offset[1]), 9);
    expect(scene.target[1]).toBeCloseTo(10 + 2 - offset[2], 9);
    const back = poseFromScene(scene, offset, 2, rigid);
    expect(back.position[0]).toBeCloseTo(120, 9);
    expect(back.position[1]).toBeCloseTo(230, 9);
    expect(back.position[2]).toBeCloseTo(30, 9);
    expect(back.target[1]).toBeCloseTo(215, 9);
    expect(back.up[2]).toBeCloseTo(1, 12);
    // Without one, as before.
    expect(poseToScene(pose, offset, 2)).toEqual(poseToScene(pose, offset, 2, null));
  });
});
