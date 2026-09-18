// One palette, so a tree is the same colour everywhere it appears.
//
// The user reads tree separation, height and intensity from colour and
// from nothing else — there is no number on screen saying "these two
// point clusters are different trees". So a colour that is wrong, or
// merely different between two surfaces showing the same tree, is a
// wrong answer delivered with no error attached.
//
// This existed as FOUR independent copies — OctreeView, OverlayCloud,
// TreeReviewPanel, MetricsModule — each written to "mirror the
// viewport", each individually plausible, and they had drifted:
//
//   * treeIdColor normalised a negative hue in two copies and not in
//     the other two. See NEGATIVE IDS below; this was a real defect,
//     not a stylistic difference.
//   * the unassigned grey was 120 in one panel, 140 in the overlay, and
//     the user's own display.unlabeledColor in the viewport.
//
// rampColor also lived in OctreeView, so ColorLegend — a CSS gradient
// swatch — imported a 4900-line Three.js module to get it.
//
// NEGATIVE IDS
// ------------
// A tree id is a signed Int32: octreeReader reads it with getInt32, and
// columnMapping takes it from a CSV column via parseFloat. Segmentation
// tools do emit negative ids (a noise label, or an NA exported as −1 or
// −9999), so they reach the palette from real files.
//
// hue2 below corrects an out-of-band t with a SINGLE ±1, which is only
// enough for t ∈ (−1, 2). With an unnormalised negative hue, h − 1/3
// can fall below −1, the single += 1 leaves it negative, and the first
// branch extrapolates past the end of the ramp:
//
//     id     unnormalised            normalised
//     −3     [215, 196, −102]        [215, 196, 66]
//     −11    [184, 215,  −52]        [184, 215, 66]
//     −9999  [115, 215,   16]        [115, 215, 66]
//
// Measured over ids −1…−20000: 6663 of 20000 differ, and 5188 produce a
// channel outside 0–255. Neither end reports anything. In the viewport
// the value lands in a Uint8Array and wraps (−102 → 154), drawing a
// confident wrong colour; in a panel it becomes `rgb(215,196,-102)`,
// which is invalid CSS, so the browser drops the declaration and the
// swatch the user is checking the tree against silently vanishes.
//
// Normalising the hue once, here, makes every caller correct instead of
// making three of four callers remember.

import type { ColorRamp } from '../components/shell/OctreeShellContext';

/** Hue spacing between consecutive tree ids.
 *
 *  The golden ratio's fractional part: successive multiples mod 1 are
 *  spread about as evenly as any sequence can be, so neighbouring ids —
 *  which is what adjacent trees usually get — never land on adjacent
 *  hues. */
const GOLDEN = 0.6180339887;

const TREE_SAT = 0.65;
const TREE_LIGHT = 0.55;

/** The default unassigned/unlabelled grey, matching DEFAULT display
 *  config's unlabeledColor (#787878).
 *
 *  The viewport honours the user's own setting; surfaces that only show
 *  a swatch and have no access to the display config use this. They
 *  previously disagreed with each other (120 vs 140) as well as with the
 *  viewport. */
export const UNASSIGNED_RGB: readonly [number, number, number] = [120, 120, 120];

/** Wrap any finite hue into [0, 1).
 *
 *  `x % 1` keeps the sign of x in JavaScript, so a negative id gives a
 *  negative hue; see NEGATIVE IDS above for what that costs downstream.
 *  Non-finite collapses to 0 rather than propagating NaN into every
 *  channel — an id that failed to parse is a colour, not a crash. */
export function wrapHue(h: number): number {
  if (!Number.isFinite(h)) return 0;
  const r = h % 1;
  return r < 0 ? r + 1 : r;
}

/** HSL → RGB with channels in 0–1.
 *
 *  The hue is normalised on the way in, so this is total over any finite
 *  h — callers do not have to pre-wrap and three of the four old copies
 *  did not. */
export function hslToRgb01(h: number, s: number, l: number): [number, number, number] {
  const li = Math.min(1, Math.max(0, Number.isFinite(l) ? l : 0));
  const sa = Math.min(1, Math.max(0, Number.isFinite(s) ? s : 0));
  if (sa === 0) return [li, li, li];
  const hh = wrapHue(h);
  const q = li < 0.5 ? li * (1 + sa) : li + sa - li * sa;
  const p = 2 * li - q;
  // t is now guaranteed to be in (−1/3, 4/3), which the single ±1
  // correction covers exactly.
  const hue2 = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue2(hh + 1 / 3), hue2(hh), hue2(hh - 1 / 3)];
}

/** HSL → RGB with channels in 0–255, rounded. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const [r, g, b] = hslToRgb01(h, s, l);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/** Colour for a tree id, 0–255. Callers that treat id ≤ 0 as unassigned
 *  should test that themselves — this answers for any id, including the
 *  negative ones a segmentation tool may have written. */
export function treeIdColor(id: number): [number, number, number] {
  return hslToRgb(id * GOLDEN, TREE_SAT, TREE_LIGHT);
}

/** Colour for a tree id, 0–1, for buffers that hold float colours. */
export function treeIdColor01(id: number): [number, number, number] {
  return hslToRgb01(id * GOLDEN, TREE_SAT, TREE_LIGHT);
}

/** ASPRS classification palette, 0–255. */
export function classColor(cls: number): [number, number, number] {
  switch (cls) {
    case 2: return [120, 90, 60];    // ground
    case 3: return [80, 160, 80];    // low vegetation
    case 4: return [60, 180, 60];    // medium vegetation
    case 5: return [40, 200, 40];    // high vegetation
    case 6: return [220, 80, 80];    // building
    case 7: return [220, 220, 60];   // noise
    case 9: return [80, 120, 220];   // water
    default: return [140, 140, 140];
  }
}

/** ASPRS classification palette, 0–1. */
export function classColor01(cls: number): [number, number, number] {
  const [r, g, b] = classColor(cls);
  return [r / 255, g / 255, b / 255];
}

/** Colour for a deadwood instance.
 *
 *  Standing deadwood sits in a warm amber→red band and laying deadwood
 *  in a cool cyan→blue one, so the two channels read apart at a glance;
 *  the golden-ratio hop WITHIN each band keeps neighbouring instances
 *  distinct without letting either channel wander into the other's. */
export function deadwoodColor(id: number, channel: 'standing' | 'laying'): [number, number, number] {
  const jitter = wrapHue(id * GOLDEN) * 0.12;
  return channel === 'standing'
    ? hslToRgb(0.05 + jitter, 0.8, TREE_LIGHT)
    : hslToRgb(0.5 + jitter, 0.7, TREE_LIGHT);
}

// Colour ramps for the scalar modes. Each is a short list of [r,g,b]
// stops we lerp between; compact + dependency-free. 'forest' keeps
// PointCloudLabeler's native green height look. The continuous ramps are sampled
// from the standard matplotlib palettes (viridis / magma / cividis /
// plasma / inferno / turbo / ocean), the diverging ramps from
// ColorBrewer (spectral, RdYlGn) — colours-of-record so a saved dataset
// shared with another tool comes out looking the same.
export const RAMPS: Record<ColorRamp, [number, number, number][]> = {
  forest:    [[40, 70, 55], [60, 130, 90], [150, 200, 90], [235, 225, 120]],
  viridis:   [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  turbo:     [[48, 18, 59], [38, 130, 230], [30, 220, 170], [160, 235, 50], [250, 150, 30], [180, 30, 10]],
  inferno:   [[0, 0, 4], [87, 16, 110], [188, 55, 84], [237, 121, 48], [252, 255, 164]],
  grayscale: [[20, 20, 20], [245, 245, 245]],
  magma:     [[0, 0, 4], [60, 15, 110], [165, 44, 122], [240, 110, 92], [254, 202, 141], [252, 253, 191]],
  cividis:   [[0, 32, 76], [40, 60, 100], [88, 90, 109], [136, 124, 113], [192, 161, 105], [253, 234, 105]],
  plasma:    [[13, 8, 135], [85, 4, 158], [156, 23, 158], [205, 64, 113], [237, 121, 83], [253, 188, 47], [240, 249, 33]],
  ocean:     [[8, 22, 60], [22, 70, 134], [56, 134, 168], [137, 196, 209], [220, 232, 239]],
  spectral:  [[158, 1, 66], [213, 62, 79], [244, 109, 67], [253, 174, 97], [254, 224, 139], [230, 245, 152], [171, 221, 164], [102, 194, 165], [50, 136, 189], [94, 79, 162]],
  rdylgn:    [[165, 0, 38], [215, 48, 39], [244, 109, 67], [253, 174, 97], [254, 224, 139], [217, 239, 139], [166, 217, 106], [102, 189, 99], [26, 152, 80], [0, 104, 55]],
  // Placeholder — 'custom' is resolved from CUSTOM_RAMP_STOPS in
  // rampColor before this entry is ever read; kept only to satisfy the
  // Record type.
  custom:    [[26, 26, 58], [224, 184, 74]],
};

// Stops for the user-defined 'custom' ramp (low → high), kept
// module-level so rampColor can resolve them without threading the
// colours through every call site. Updated from the display config by
// the recolour effect before any node is repainted.
let CUSTOM_RAMP_STOPS: [number, number, number][] = [[26, 26, 58], [224, 184, 74]];

export function setCustomRampStops(loHex: string, hiHex: string): void {
  CUSTOM_RAMP_STOPS = [hexToRgb255(loHex), hexToRgb255(hiHex)];
}

/** #rrggbb → 0–255 rgb, or null if it is not a colour.
 *
 *  The parse is shared; the FALLBACK is not, deliberately. Three call
 *  sites wanted three different answers to "the string was rubbish" —
 *  neutral grey where a wrong colour would mislead, and a loud pink
 *  where the point is to be noticed — and folding those into one would
 *  be consolidating a decision, not a duplicate. What was duplicated is
 *  this regex and the shifts. */
export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** #rrggbb → 0–255 rgb. An unparseable string becomes a neutral grey
 *  rather than NaN, which would reach a Uint8Array as 0 (black) and read
 *  as a deliberate colour choice. */
export function hexToRgb255(
  hex: string,
  fallback: readonly [number, number, number] = [180, 180, 180],
): [number, number, number] {
  return parseHex(hex) ?? [fallback[0], fallback[1], fallback[2]];
}

/** #rrggbb → 0–1 rgb, for buffers that hold float colours. */
export function hexToRgb01(
  hex: string,
  fallback: readonly [number, number, number] = [180 / 255, 180 / 255, 180 / 255],
): [number, number, number] {
  const c = parseHex(hex);
  return c ? [c[0] / 255, c[1] / 255, c[2] / 255] : [fallback[0], fallback[1], fallback[2]];
}

/** Resolve one ramp at parameter t ∈ [0,1] into `out` (0–255 rgb).
 *
 *  The single colour resolver every scalar-colouring path uses, so the
 *  viewport legend samples the SAME function to build its gradient
 *  swatch instead of hand-written per-ramp CSS gradients that would
 *  immediately drift for the user-defined 'custom' ramp.
 *
 *  Writes into `out` rather than allocating: this runs once per point,
 *  per node, on every recolour. */
export function rampColor(ramp: ColorRamp, t: number, out: [number, number, number]): void {
  const stops = ramp === 'custom' ? CUSTOM_RAMP_STOPS : (RAMPS[ramp] ?? RAMPS.forest);
  // NaN-safe clamp: NaN survives Math.min / Math.max comparisons (every
  // ordered comparison against NaN is false), so a sloppy t = NaN would
  // propagate to `stops[NaN] = undefined` and crash with "Cannot read
  // properties of undefined (reading '0')" — that is what tanked the
  // Display panel when switching modes on a cloud where a channel had no
  // usable range (all-zero intensity, an empty axis span). Coerce NaN → 0
  // up front so the ramp always resolves to a real stop pair.
  const safeT = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  const x = safeT * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  out[0] = (a[0] + (b[0] - a[0]) * f) | 0;
  out[1] = (a[1] + (b[1] - a[1]) * f) | 0;
  out[2] = (a[2] + (b[2] - a[2]) * f) | 0;
}
