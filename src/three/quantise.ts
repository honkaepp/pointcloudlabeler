// The lossy-representation boundary.
//
// Two conversions in the viewer trade precision for size, and both are
// one-way doors: once a value has been through them the original is gone
// unless someone kept it.
//
//   * positions → qPositions. Per-axis uint16, node-relative, so the GPU
//     uploads 6 bytes per point instead of 12. The vertex shader
//     dequantises with qOrigin + raw/65535 × qSize.
//   * a decoded f32 extra column → the editable Int32 view. The deadwood
//     channels are integer instance ids that ride as floats.
//
// The rule that makes the first one safe is a separation, not a
// tolerance: **qPositions is for drawing and nothing else.** `positions`
// stays the CPU source of truth for picking, selection, measuring and
// the colour ramps. Measure from the quantised copy instead and every
// distance in the viewport silently inherits up to qSize/65535 of error
// — sub-millimetre on a leaf node, but centimetres on a coarse LOD tile
// spanning the whole plot, and nothing on screen would say so.
//
// Three guards below are belt-and-braces over a guarantee the language
// already gives, and the teeth check says so by finding no difference
// when they are removed. Measured rather than assumed:
//
//     Int32Array  <- Math.round(NaN)       0
//     Int32Array  <- Math.round(Infinity)  0
//     Uint16Array <- out-of-range index    silently discarded
//     0 * Infinity -> (NaN + 0.5) | 0      0
//
// They stay because they say what is meant. Relying on a typed array to
// coerce NaN into "unlabelled" is a fact about JavaScript, not about
// forests, and the next person to change the container should not have
// to rediscover it. The BEHAVIOUR is tested; these are documentation
// that happens to compile.

/** Round a decoded f32 extra column to integer ids.
 *
 *  Non-finite becomes 0, which is the unlabelled id — a point whose
 *  channel never decoded is unlabelled, not instance NaN. The Int32Array
 *  would coerce it to 0 on its own; the check is here to say that this
 *  is intended rather than inherited. */
export function f32ToI32(src: Float32Array): Int32Array {
  const out = new Int32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    out[i] = Number.isFinite(v) ? Math.round(v) : 0;
  }
  return out;
}

export interface QuantiseFrame {
  /** Node-relative origin: the min corner of the node's bbox. */
  qOrigin: readonly [number, number, number];
  /** Node extent per axis. Zero is allowed — a node whose points share a
   *  coordinate — and dequantises back to the origin either way. */
  qSize: readonly [number, number, number];
}

/** Encode scene positions into a node's uint16 GPU buffer.
 *
 *  Deleted points carry NaN in `positions`. NaN fails both clamp
 *  comparisons and falls through to `(NaN + 0.5) | 0`, which is 0 — a
 *  uint cannot carry NaN, and those points are masked by aVisible
 *  anyway, so where they land does not matter. It is written down
 *  because it looks like an oversight and is not. */
export function quantisePositions(
  positions: Float32Array,
  out: Uint16Array,
  frame: QuantiseFrame,
): void {
  const [ox, oy, oz] = frame.qOrigin;
  // A zero-extent axis. Dividing by zero would give Infinity, and the
  // arithmetic happens to survive it — 0 × Infinity is NaN, which the
  // clamp turns into 0, and the shader multiplies that back by a zero
  // size to land on the origin regardless. The floor keeps Infinity out
  // of the loop anyway: the coincidence holds today, and it is one
  // refactor away from not.
  const ix = 65535 / Math.max(frame.qSize[0], 1e-9);
  const iy = 65535 / Math.max(frame.qSize[1], 1e-9);
  const iz = 65535 / Math.max(frame.qSize[2], 1e-9);

  // Typed arrays discard an out-of-range write silently, so this bound
  // changes no output — it stops the loop doing work whose result is
  // thrown away, and states that the two arrays are meant to match.
  const n = Math.min(positions.length, out.length);
  for (let i = 0; i + 2 < n; i += 3) {
    let v = (positions[i] - ox) * ix;
    out[i] = v <= 0 ? 0 : v >= 65535 ? 65535 : (v + 0.5) | 0;
    v = (positions[i + 1] - oy) * iy;
    out[i + 1] = v <= 0 ? 0 : v >= 65535 ? 65535 : (v + 0.5) | 0;
    v = (positions[i + 2] - oz) * iz;
    out[i + 2] = v <= 0 ? 0 : v >= 65535 ? 65535 : (v + 0.5) | 0;
  }
}

/** What the vertex shader does, in JS — so the round-trip can be
 *  checked rather than assumed. Not used at runtime. */
export function dequantise(
  q: Uint16Array,
  i: number,
  frame: QuantiseFrame,
): [number, number, number] {
  return [
    frame.qOrigin[0] + (q[i] / 65535) * frame.qSize[0],
    frame.qOrigin[1] + (q[i + 1] / 65535) * frame.qSize[1],
    frame.qOrigin[2] + (q[i + 2] / 65535) * frame.qSize[2],
  ];
}

/** Worst-case round-trip error per axis (m): half a quantisation step. */
export function quantisationError(frame: QuantiseFrame): [number, number, number] {
  return [
    frame.qSize[0] / 65535 / 2,
    frame.qSize[1] / 65535 / 2,
    frame.qSize[2] / 65535 / 2,
  ];
}
