// The Views & video panel inside the viewer: it hands the panel
// the camera and the canvas (to move along a fly-through and to record),
// and puts the cloud's point materials into X-ray while that is on. See
// components/shell/viewToolsStore.ts.

import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { applyXray, registerViewer, useViewTools, type Vec3 } from '../components/shell/viewToolsStore';

interface OrbitLike { target: THREE.Vector3; update: () => void }

export default function ViewTools() {
  const { camera, gl, scene, controls, invalidate } = useThree();
  const v = useViewTools();
  const applied = useRef(false);

  useEffect(() => {
    const orbit = controls as unknown as OrbitLike | null;
    registerViewer({
      getPose: () => {
        const t = orbit?.target ?? new THREE.Vector3();
        return { position: camera.position.toArray() as Vec3, target: t.toArray() as Vec3 };
      },
      setPose: (p) => {
        camera.position.set(...p.position);
        if (orbit?.target) {
          orbit.target.set(...p.target);
          orbit.update();
        } else {
          camera.lookAt(...p.target);
        }
        invalidate();
      },
      canvas: gl.domElement,
    });
    return () => registerViewer(null);
  }, [camera, gl, controls, invalidate]);

  // The cloud's nodes (and overlay clouds) are Points with shader
  // materials; streaming adds nodes all the time, so while X-ray is on every
  // frame looks for new ones. Off, one pass puts everything back.
  useFrame(() => {
    if (!v.xray && !applied.current) return;
    scene.traverse((o) => {
      const p = o as THREE.Points;
      if (p.isPoints && p.material instanceof THREE.ShaderMaterial) applyXray(p.material, v.xray, v.xrayStrength);
    });
    applied.current = v.xray;
  });

  return null;
}
