// The viewer's camera, perspective or parallel (orthographic).
//
// A parallel projection is what a measurement view needs: a stem's profile,
// a cross-section through a slab, a top view whose metres are the same at the
// ground and at the canopy. It is a PerspectiveCamera all the same, so the
// orbit controls, the viewer's code and three.js treat it as before, and only
// its projection matrix changes:
//
//   the parallel view shows, everywhere, what the perspective view shows at
//   `orthoDistance` — the orbit target's distance, kept current every frame.
//
// So switching keeps the framing at the target, the controls' pan (scaled by
// the target distance × tan(fov/2)) moves the view by the right amount, and a
// dolly towards the target zooms. The point engine reads the projection from
// the matrix (`proj[15] === 1`), and the planner sizes nodes at
// `orthoDistance` (lodPlanner.pixelDiameter) instead of their own distance.
//
// Near and far are the whole scene in front of the camera AND behind it: a
// parallel view has no reason to clip what lies between the camera and the
// target, or behind the camera, as a zoomed-in perspective one must.

import * as THREE from 'three';

export class ViewCamera extends THREE.PerspectiveCamera {
  /** Draw with a parallel projection. */
  ortho = false;
  /** The distance at which the parallel view matches the perspective one. */
  orthoDistance = 10;
  /** Near and far of the parallel projection (near is negative: behind the camera). */
  orthoNear = -1000;
  orthoFar = 1000;

  override updateProjectionMatrix(): void {
    if (!this.ortho) {
      super.updateProjectionMatrix();
      return;
    }
    const halfH = orthoHalfHeight(this);
    const halfW = halfH * this.aspect;
    this.projectionMatrix.makeOrthographic(-halfW, halfW, halfH, -halfH, this.orthoNear, this.orthoFar);
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }

  override copy(source: this, recursive?: boolean): this {
    super.copy(source, recursive);
    if (source instanceof ViewCamera) {
      this.ortho = source.ortho;
      this.orthoDistance = source.orthoDistance;
      this.orthoNear = source.orthoNear;
      this.orthoFar = source.orthoFar;
    }
    return this;
  }
}

/** Half the height, in world units, the parallel view shows. */
export function orthoHalfHeight(c: { orthoDistance: number; fov: number; zoom: number }): number {
  return (Math.max(1e-6, c.orthoDistance) * Math.tan(THREE.MathUtils.DEG2RAD * 0.5 * c.fov)) / Math.max(1e-6, c.zoom);
}

export function isOrtho(c: THREE.Camera | null | undefined): c is ViewCamera {
  return !!c && (c as ViewCamera).ortho === true;
}

/** The distance the planner and the engine size things at in a parallel
 *  view; 0 in a perspective one (each thing at its own distance). */
export function orthoSizingDistance(c: THREE.Camera | null | undefined): number {
  return isOrtho(c) ? c.orthoDistance / Math.max(1e-6, c.zoom) : 0;
}

/** World units per CSS pixel at the orbit target — what a scale bar shows.
 *  Exact everywhere in a parallel view; at the target in a perspective one. */
export function unitsPerPixel(c: THREE.PerspectiveCamera, target: THREE.Vector3, viewportHeight: number): number {
  const dist = isOrtho(c) ? c.orthoDistance : c.position.distanceTo(target);
  const halfH = (dist * Math.tan(THREE.MathUtils.DEG2RAD * 0.5 * c.fov)) / Math.max(1e-6, c.zoom);
  return (2 * halfH) / Math.max(1, viewportHeight);
}

/** Keep a parallel camera's projection with its target: the distance it
 *  matches the perspective view at, and near / far around the scene.
 *  Returns whether the projection changed. */
export function syncOrtho(c: ViewCamera, targetDistance: number, sceneExtent: number): boolean {
  const reach = sceneExtent * 3 + targetDistance;
  const near = -reach;
  const far = targetDistance + reach;
  const changed = Math.abs(c.orthoDistance - targetDistance) > targetDistance * 1e-6
    || c.orthoNear !== near || c.orthoFar !== far;
  if (!changed) return false;
  c.orthoDistance = targetDistance;
  c.orthoNear = near;
  c.orthoFar = far;
  c.updateProjectionMatrix();
  return true;
}
