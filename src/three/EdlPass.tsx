// Eye-Dome Lighting (EDL) post-process — Boucheny 2009 / Potree /
// CloudCompare-style. Each pixel's depth is compared against its
// 4-neighbour ring in screen space; pixels that sit closer than their
// neighbours pick up shading, which paints silhouettes around point
// clusters and turns a flat-looking point cloud into something you can
// read depth off of.
//
// Implementation notes:
//   - We take over R3F's rendering by registering useFrame at priority
//     1. R3F skips its automatic gl.render whenever ANY useFrame uses a
//     priority > 0, so this component owns the present loop.
//   - When the toggle is off we still own the loop but just do a plain
//     gl.render(scene, camera) so the toggle round-trip is seamless.
//   - The render target's DepthTexture is FloatType so we get usable
//     precision out to ~10⁴ m without z-fighting in the EDL shader.
//     UnsignedShortType / UnsignedIntType would alias on plot-scale
//     clouds because near is set to 0.0001 in the Canvas.
//   - Resolution + DPR are taken from useThree().size + viewport.dpr
//     so a window resize / DPI change rebuilds the target lazily.

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

interface Props {
  enabled: boolean;
  /** Shading strength — multiplied into the exponential decay of the
   *  log-depth-difference response. Higher = darker silhouettes. */
  strength?: number;
  /** Neighbour offset in pixels. 1.5 picks the immediate 4-ring at a
   *  CC-like contrast; >3 starts to feel cartoony. */
  radius?: number;
}

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// EDL composite shader. depthTex is the perspective z (0..1); we
// linearise into eye-space metres via the near/far uniforms, then take
// log so the per-neighbour difference behaves uniformly across the
// scene's depth range. The 4-neighbour cross is enough — going to 8
// barely changes the look and doubles the texture-sample cost.
const FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uColor;
  uniform sampler2D uDepth;
  uniform vec2 uResolution;
  uniform float uStrength;
  uniform float uRadius;
  uniform float uNear;
  uniform float uFar;
  varying vec2 vUv;

  // Perspective depth (0..1) → eye-space distance (metres, positive).
  // The standard reverse-projection identity for a right-handed camera
  // looking down -Z.
  float linearise(float z) {
    float ndc = z * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
  }

  void main() {
    vec3 color = texture2D(uColor, vUv).rgb;
    float d = texture2D(uDepth, vUv).r;
    // Background (depth == 1.0 = far plane) stays unshaded so the
    // canvas-clear colour doesn't get darker around object edges.
    if (d >= 0.99999) {
      gl_FragColor = vec4(color, 1.0);
      return;
    }
    float lz = log2(linearise(d) + 1.0);
    vec2 px = uRadius / uResolution;
    float resp = 0.0;
    int n = 0;
    // 4-cross neighbour sampling.
    for (int k = 0; k < 4; k++) {
      vec2 off = vec2(0.0);
      if (k == 0) off = vec2( px.x, 0.0);
      if (k == 1) off = vec2(-px.x, 0.0);
      if (k == 2) off = vec2(0.0,  px.y);
      if (k == 3) off = vec2(0.0, -px.y);
      float nd = texture2D(uDepth, vUv + off).r;
      if (nd >= 0.99999) continue;
      float nlz = log2(linearise(nd) + 1.0);
      // neighbour further than center → center is on a near silhouette
      // edge → accumulate response (will darken the pixel).
      resp += max(0.0, nlz - lz);
      n++;
    }
    if (n > 0) resp /= float(n);
    float shade = exp(-uStrength * 300.0 * resp);
    gl_FragColor = vec4(color * shade, 1.0);
  }
`;

export default function EdlPass({ enabled, strength = 1.0, radius = 1.5 }: Props) {
  const { gl, scene, camera, size, viewport } = useThree();
  const dpr = viewport.dpr;
  const width = Math.max(1, Math.round(size.width * dpr));
  const height = Math.max(1, Math.round(size.height * dpr));

  // RT + depth texture. Rebuilds on canvas resize / DPR change. The
  // ref pattern + useMemo here is so we can dispose the old target
  // cleanly when the size changes — useMemo's cleanup runs before the
  // next allocation, but its return value is what useFrame reads.
  const target = useMemo(() => {
    const t = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    const dt = new THREE.DepthTexture(width, height);
    dt.type = THREE.FloatType;
    dt.format = THREE.DepthFormat;
    t.depthTexture = dt;
    return t;
  }, [width, height]);

  useEffect(() => () => {
    target.depthTexture?.dispose();
    target.dispose();
  }, [target]);

  // Fullscreen quad + shader material. Built once; uniforms updated
  // per-frame.
  const quad = useMemo(() => {
    const geom = new THREE.PlaneGeometry(2, 2);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uColor: { value: null },
        uDepth: { value: null },
        uResolution: { value: new THREE.Vector2(width, height) },
        uStrength: { value: strength },
        uRadius: { value: radius },
        uNear: { value: 0.0001 },
        uFar: { value: 1e9 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.frustumCulled = false;
    return mesh;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Resolution uniform follows the actual buffer size so a window
  // resize / DPI change doesn't desync the neighbour-offset math.
  useEffect(() => {
    (quad.material as THREE.ShaderMaterial).uniforms.uResolution.value.set(width, height);
  }, [quad, width, height]);

  useEffect(() => () => {
    (quad.material as THREE.Material).dispose();
    quad.geometry.dispose();
  }, [quad]);

  // Ortho cam for the final composite — the quad sits in clip space
  // already so an identity camera is fine.
  const orthoCam = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), []);
  const quadScene = useMemo(() => {
    const s = new THREE.Scene();
    s.add(quad);
    return s;
  }, [quad]);

  // We own the render loop: useFrame with priority > 0 disables R3F's
  // automatic render. When EDL is off we still take over but just do
  // a single straight render so toggling on/off is a no-op visually.
  const onRef = useRef({ enabled, strength, radius });
  onRef.current = { enabled, strength, radius };

  useFrame(() => {
    const cam = camera as THREE.PerspectiveCamera;
    // Guard the whole render in try/catch. This useFrame OWNS the render
    // loop (priority 1), so any throw here — a transient WebGL error
    // when the canvas is display:none mid-tab-switch, a context loss,
    // etc. — would otherwise propagate out of R3F and unmount the entire
    // app (white screen). Skipping a frame is harmless; the next frame
    // recovers once the canvas is visible again.
    try {
      if (!onRef.current.enabled) {
        gl.setRenderTarget(null);
        gl.render(scene, cam);
        return;
      }
      gl.setRenderTarget(target);
      gl.clear();
      gl.render(scene, cam);
      gl.setRenderTarget(null);
      const u = (quad.material as THREE.ShaderMaterial).uniforms;
      u.uColor.value = target.texture;
      u.uDepth.value = target.depthTexture;
      u.uStrength.value = onRef.current.strength;
      u.uRadius.value = onRef.current.radius;
      u.uNear.value = cam.near;
      u.uFar.value = cam.far;
      gl.clear();
      gl.render(quadScene, orthoCam);
    } catch {
      try { gl.setRenderTarget(null); } catch { /* ignore */ }
    }
  }, 1);

  return null;
}
