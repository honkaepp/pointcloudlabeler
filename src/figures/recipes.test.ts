import { describe, it, expect } from 'vitest';
import { unionBox, fitDistance, sideElevationPose, obliquePose, topDownPose, orbitPose, poseFor, treePose, standOff, figurePointSize, scaleBarMetres, compass, directionOf, viewNameOf, VIEWS, type Box } from './recipes';
import { frameExtent } from './figureSpec';

const PLOT: Box = { min: [0, 0, 0], max: [40, 40, 25] };

/** A figure's camera is derived, not held by hand: the same box gives
 *  the same camera for both clouds of a pair, and the same one again
 *  when the figure is re-run. */
describe('the cameras the figures are taken from', () => {
  it('stands off along its own line of sight, so a pair taken farther still registers', () => {
    const pose = orbitPose(PLOT, 4 / 3, { azimuth: 135, elevation: 25 });
    const dist = (p: typeof pose) => Math.hypot(p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]);
    const far = standOff(pose, 2);
    const near = standOff(pose, 0.5);
    expect(dist(far)).toBeCloseTo(dist(pose) * 2, 9);
    expect(dist(near)).toBeCloseTo(dist(pose) * 0.5, 9);
    // The target, the up and the bearing do not move…
    expect(far.target).toEqual(pose.target);
    expect(far.up).toEqual(pose.up);
    expect(far.fov).toBe(pose.fov);
    for (let i = 0; i < 3; i++) {
      expect((far.position[i] - pose.target[i]) / (pose.position[i] - pose.target[i])).toBeCloseTo(2, 9);
    }
    // …the frame is twice as wide, and 1 (or nonsense) is the pose itself.
    expect(frameExtent(far, 4 / 3).widthM).toBeCloseTo(frameExtent(pose, 4 / 3).widthM * 2, 6);
    expect(standOff(pose, 1)).toBe(pose);
    for (const bad of [0, -1, NaN, Infinity]) expect(standOff(pose, bad), String(bad)).toBe(pose);
  });

  it('frames the plot, with the subject inside the frame', () => {
    const aspect = 4 / 3;
    for (const pose of [sideElevationPose(PLOT, aspect), obliquePose(PLOT, aspect)]) {
      const e = frameExtent(pose, aspect);
      // Wide enough for the plot and not absurdly wider — 8 % of air.
      expect(e.widthM).toBeGreaterThanOrEqual(40);
      expect(e.heightM).toBeGreaterThanOrEqual(25);
      // …and not absurdly wider. The camera also stands clear of the
      // box along the view direction, so the subject sits inside the
      // frame with air around it rather than filling it edge to edge.
      expect(e.widthM).toBeLessThan(40 * 3);
      expect(pose.up).toEqual([0, 0, 1]);
      expect(pose.target).toEqual([20, 20, 12.5]);
    }
  });

  it('puts the side elevation level, south of the plot, looking north', () => {
    const p = sideElevationPose(PLOT, 4 / 3);
    expect(p.position[0]).toBeCloseTo(20, 9);
    expect(p.position[2]).toBeCloseTo(12.5, 9);
    expect(p.position[1]).toBeLessThan(0);
    // Level: the camera's height is the target's.
    expect(p.position[2]).toBeCloseTo(p.target[2], 9);
  });

  it('puts the oblique above and to the south-east', () => {
    const p = obliquePose(PLOT, 4 / 3);
    expect(p.position[0]).toBeGreaterThan(p.target[0]);
    expect(p.position[1]).toBeLessThan(p.target[1]);
    expect(p.position[2]).toBeGreaterThan(p.target[2]);
    // 45° in plan: the two horizontal offsets are equal.
    expect(Math.abs(p.position[0] - p.target[0])).toBeCloseTo(Math.abs(p.position[1] - p.target[1]), 9);
  });

  it('gives one camera for a pair, from the box they share', () => {
    const tls: Box = { min: [0, 0, 0], max: [40, 40, 25] };
    const als: Box = { min: [-5, 0, 0], max: [40, 45, 28] };
    const u = unionBox([tls, als]);
    expect(u).toEqual({ min: [-5, 0, 0], max: [40, 45, 28] });
    // The same box twice is the same camera twice — byte-identical, so
    // the pair registers.
    expect(sideElevationPose(u, 4 / 3)).toEqual(sideElevationPose(u, 4 / 3));
  });

  it('pads a tree by the margin the user set before framing it', () => {
    const d = (p: { position: number[]; target: number[] }) =>
      Math.hypot(p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]);
    // A tall, thin tree is framed mostly by its height, so a metre of
    // margin barely moves the camera — and never pulls it in.
    const tall: Box = { min: [10, 10, 0], max: [12, 12, 18] };
    expect(d(treePose(tall, 1, 1))).toBeGreaterThanOrEqual(d(treePose(tall, 1, 0)));
    expect(d(treePose(tall, 1, 1))).toBeLessThan(d(treePose(tall, 1, 0)) * 1.15);
    expect(treePose(tall, 1, 1).target).toEqual(treePose(tall, 1, 0).target);
    // A broad, low crown is framed by its width, and there the margin
    // is what puts air around it.
    const broad: Box = { min: [0, 0, 0], max: [8, 8, 2] };
    expect(d(treePose(broad, 1, 2))).toBeGreaterThan(d(treePose(broad, 1, 0)));
  });

  it('keeps the dots the same fraction of the frame as the figure scales', () => {
    // 1 px on a 900 px viewport is 2.7 px in an 1800 px figure.
    expect(figurePointSize(1, 900, 1800)).toBe(2);
    expect(figurePointSize(1.5, 900, 1800)).toBe(3);
    expect(figurePointSize(1, 900, 900)).toBe(1);
    // Never below a whole pixel, never blobs.
    expect(figurePointSize(0, 900, 1800)).toBe(2);
    expect(figurePointSize(8, 900, 4000)).toBe(12);
  });

  it('looks straight down for a plan view, north up', () => {
    const p = topDownPose(PLOT, 1);
    expect(p.position[0]).toBeCloseTo(p.target[0], 9);
    expect(p.position[1]).toBeCloseTo(p.target[1], 9);
    expect(p.position[2]).toBeGreaterThan(p.target[2]);
    expect(p.up[0]).toBeCloseTo(0, 9);
    expect(p.up[1]).toBeCloseTo(1, 9);
    // Every named view is reachable by name, and they differ.
    expect(VIEWS.map((v) => v.id)).toEqual(['oblique', 'side', 'top']);
    expect(poseFor('top', PLOT, 1)).toEqual(topDownPose(PLOT, 1));
    expect(poseFor('side', PLOT, 1)).toEqual(sideElevationPose(PLOT, 1));
    expect(poseFor('oblique', PLOT, 1)).toEqual(obliquePose(PLOT, 1));
  });

  it('stands where the bearing and the angle say, for any of them', () => {
    const at = (azimuth: number, elevation: number) => orbitPose(PLOT, 1, { azimuth, elevation });
    // Bearing is measured from the subject: 0 north of it, 90 east, 180
    // south, 270 west. The target is the box's centre whatever it is.
    expect(at(0, 0).position[1]).toBeGreaterThan(20);
    expect(at(90, 0).position[0]).toBeGreaterThan(20);
    expect(at(180, 0).position[1]).toBeLessThan(20);
    expect(at(270, 0).position[0]).toBeLessThan(20);
    for (const a of [0, 90, 180, 270]) expect(at(a, 0).target).toEqual([20, 20, 12.5]);
    // Elevation lifts the camera and nothing else.
    expect(at(135, 60).position[2]).toBeGreaterThan(at(135, 25).position[2]);
    expect(at(135, 0).position[2]).toBeCloseTo(12.5, 9);
    // A direction the frame can be described by, and read back.
    expect(compass(0)).toBe('N');
    expect(compass(135)).toBe('SE');
    expect(compass(359)).toBe('N');
    expect(viewNameOf({ azimuth: 180, elevation: 0 })).toBe('side');
    expect(viewNameOf({ azimuth: 135, elevation: 25 })).toBe('oblique');
    expect(viewNameOf({ azimuth: 12, elevation: 90 })).toBe('top');
    expect(viewNameOf({ azimuth: 40, elevation: 12 })).toBeNull();
    expect(directionOf('side')).toEqual({ azimuth: 180, elevation: 0 });
  });

  it('frames from the box seen edge-on, not from its width and height', () => {
    // A long, narrow strip seen along its length needs far less frame
    // than seen across it — which a width-and-height rule cannot tell.
    const strip: Box = { min: [0, 0, 0], max: [100, 4, 10] };
    const along = orbitPose(strip, 1, { azimuth: 90, elevation: 0 });
    const across = orbitPose(strip, 1, { azimuth: 180, elevation: 0 });
    const d = (p: { position: number[]; target: number[] }) =>
      Math.hypot(p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]);
    expect(d(across)).toBeGreaterThan(d(along) * 2);
  });

  it('fits a distance the geometry agrees with, and picks a round scale bar', () => {
    // A 10 m half-height at 35° fills the frame exactly at margin 1.
    const d = fitDistance(0, 10, 35, 1, 1);
    expect(2 * d * Math.tan((35 * Math.PI) / 360)).toBeCloseTo(20, 9);
    expect(scaleBarMetres(50)).toBe(10);
    expect(scaleBarMetres(12)).toBe(2);
    expect(scaleBarMetres(4)).toBe(0.5);
    expect(scaleBarMetres(1000)).toBe(200);
  });
});
