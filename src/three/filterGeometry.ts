// World → scene geometry for the point filters.
//
// The viewer stores positions in a scene frame that is NOT the survey
// frame (see io/sceneAxes): the north axis is negated and swapped with
// up, so a world Z-up cloud becomes a Three.js Y-up one by rotation
// rather than reflection.
//
//     sceneX = worldX − offsetX
//     sceneY = worldZ − offsetZ        (elevation)
//     sceneZ = −(worldY − offsetY)     (north, negated)
//
// The user, meanwhile, types world coordinates: a northing range, a
// slicing plane through a stand, a bounding box around a tree. Every one
// of those has to be rewritten into the scene frame before the per-point
// loop can test it, and each rewrite is a place a sign can go missing.
//
// These are pulled out of applyFilters because they are the parts where
// a mistake is SILENT. The hot loop is a dot product and a comparison —
// if it were wrong nothing would draw. Get the negation wrong here and
// the filter works perfectly, on the wrong half of the plot.

export type Vec3 = readonly [number, number, number];
export type Range = readonly [number, number];

/** Scene-X interval for a world easting range. */
export function eastRangeToScene(r: Range, offset: Vec3): Range {
  return [r[0] - offset[0], r[1] - offset[0]];
}

/** Scene-Y interval for a world elevation range. */
export function upRangeToScene(r: Range, offset: Vec3): Range {
  return [r[0] - offset[2], r[1] - offset[2]];
}

/** Scene-Z interval for a world northing range.
 *
 *  Scene-Z is −(worldY − offsetY), so the interval both flips sign AND
 *  reverses: the northern edge becomes the lower scene-Z bound. Returning
 *  it unsorted would make every `z >= lo && z <= hi` test in the loop
 *  fail, silently, for every point. */
export function northRangeToScene(r: Range, offset: Vec3): Range {
  const lo = Math.min(r[0], r[1]);
  const hi = Math.max(r[0], r[1]);
  return [offset[1] - hi, offset[1] - lo];
}

export interface PlaneSlab {
  /** A point on the plane, world coordinates. */
  anchor: Vec3;
  /** Plane normal, world coordinates. Need not be unit length. */
  normal: Vec3;
  /** Half-thickness of the slab (m). */
  halfHeight: number;
}

export interface SceneSlab {
  /** Scene-space normal, unit length. */
  nx: number; ny: number; nz: number;
  /** Constant folded into the plane equation, so the per-point test is
   *  `|nx·x + ny·y + nz·z + k| <= halfHeight`. */
  k: number;
  halfHeight: number;
}

/** Rewrite a world slicing slab into the scene frame.
 *
 *  The world test is `|(p − anchor) · n| ≤ h`. Substituting the scene
 *  mapping and collecting terms:
 *
 *    (p − a)·n = sceneX·nx + sceneY·nz + sceneZ·(−ny)
 *              + (offX−ax)nx + (offY−ay)ny + (offZ−az)nz
 *
 *  so the scene normal is (nx, nz, −ny) and the rest is a constant. One
 *  dot product and an abs() per point, which is what the hot loop wants.
 *
 *  Null when the normal is degenerate or the slab has no thickness —
 *  a zero-length normal would divide by zero and mark every point as
 *  inside a plane that does not exist. */
export function slabToScene(ps: PlaneSlab, offset: Vec3): SceneSlab | null {
  const [ax, ay, az] = ps.anchor;
  const len = Math.hypot(ps.normal[0], ps.normal[1], ps.normal[2]);
  if (!(len > 1e-9) || !(ps.halfHeight > 0)) return null;
  if (![ax, ay, az].every(Number.isFinite)) return null;

  const nx = ps.normal[0] / len;
  const ny = ps.normal[1] / len;
  const nz = ps.normal[2] / len;
  return {
    nx,
    ny: nz,      // scene-Y (up) is world Z
    nz: -ny,     // scene-Z is −world Y
    k: (offset[0] - ax) * nx + (offset[1] - ay) * ny + (offset[2] - az) * nz,
    halfHeight: ps.halfHeight,
  };
}

/** Signed distance of a scene-space point from the slab's centre plane. */
export function slabDistance(s: SceneSlab, x: number, y: number, z: number): number {
  return s.nx * x + s.ny * y + s.nz * z + s.k;
}

/** Is a scene-space point inside the slab?
 *
 *  The acceptance rule, not just the distance, so the whole test lives
 *  in one place. It used to end at slabDistance, leaving each caller to
 *  write `|d| <= halfHeight` itself — and the caller that mattered wrote
 *  it inline along with the distance, so the tested function was not the
 *  running one.
 *
 *  Written as a rejection of the outside rather than `Math.abs(d) <= h`
 *  because a deleted point carries NaN: every comparison against it is
 *  false, so `d < -h || d > h` does not reject it and `abs(d) <= h` does
 *  not accept it. Those are opposite answers for the same point, and the
 *  first is the one the viewer wants — a NaN-positioned point is masked
 *  by aVisible elsewhere and must not be dropped by the slab as well,
 *  because clearing the slab would then not bring it back. */
export function inSlab(s: SceneSlab, x: number, y: number, z: number): boolean {
  const d = slabDistance(s, x, y, z);
  return !(d < -s.halfHeight || d > s.halfHeight);
}

export interface SceneBox {
  x0: number; x1: number;
  y0: number; y1: number;
  z0: number; z1: number;
}

/** How far the isolate neighbourhood reaches beyond the tree, in metres.
 *  One value for every direction; or one per WORLD axis — east–west,
 *  north–south, up–down; or one per DIRECTION — west, east, south,
 *  north, down, up. The last is the one Tree Review edits: a stem that
 *  leans east wants reach east and none west, a stump the box cut off
 *  wants reach down and none up, and a crown pressed against its
 *  northern neighbour wants none towards it. There is no ceiling: a
 *  cluster of the same id 50 m away is still the tree's. */
export type IsolateMargin =
  | number
  | readonly [number, number, number]
  | readonly [number, number, number, number, number, number];

/** The six reaches a margin stands for — [west, east, south, north,
 *  down, up] — each at least zero and finite. Every consumer goes
 *  through this so a scalar from an older caller, an axis triple and
 *  the panel's six directions all dilate the same box, and a NaN or a
 *  negative reach dilates by nothing. */
export type MarginReach = [number, number, number, number, number, number];

export function marginReach(m: IsolateMargin | null | undefined): MarginReach {
  const one = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);
  if (Array.isArray(m)) {
    if (m.length >= 6) return [one(m[0]), one(m[1]), one(m[2]), one(m[3]), one(m[4]), one(m[5])];
    const x = one(m[0]), y = one(m[1]), z = one(m[2]);
    return [x, x, y, y, z, z];
  }
  const v = one(m);
  return [v, v, v, v, v, v];
}

/** Is the reach the same in every direction? What the panel's "same"
 *  checkbox starts as. */
export function isUniformReach(m: IsolateMargin | null | undefined): boolean {
  const r = marginReach(m);
  return r.every((v) => v === r[0]);
}

export interface IsolateBoxInput {
  /** World bbox of the isolated tree: [min, max], axes X east, Y north,
   *  Z up. */
  box: readonly [Vec3, Vec3];
  /** Density centre of the tree, world coords. Null falls back to the
   *  bbox centre. */
  anchor: Vec3 | null;
  /** Dilation (m) applied after the half-extents are clamped — one
   *  value, one per world axis, or one per direction; see IsolateMargin. */
  margin: IsolateMargin;
  /** Optional band, metres above the tree BASE (the raw bbox floor). */
  zRange: Range | null;
}

/** Per-axis cap on the half-extent BEFORE the margin is added.
 *
 *  A poorly segmented tree — a handful of stray points sitting tens of
 *  metres from the trunk — has a raw bbox spanning most of the plot in
 *  one axis. Dilating that by the margin then reveals nearly every
 *  unassigned point in that direction, which is what "the margin works
 *  only in one direction for some trees" turned out to be. Generous
 *  vertically because tall trees exist; tight horizontally because a
 *  real crown rarely exceeds ~8 m radius. */
export const HORIZ_MAX_HALF_EXTENT = 8;
export const VERT_MAX_HALF_EXTENT = 30;

/** The neighbourhood box around an isolated tree, in scene coordinates.
 *
 *  Anchored on the density centre rather than the bbox centre: stray
 *  points drag the bbox centre away from the trunk, putting the whole
 *  neighbourhood — and the unassigned points it reveals — in the wrong
 *  place for exactly the badly segmented trees a user isolates to fix. */
export function isolateBoxToScene(inp: IsolateBoxInput, offset: Vec3): SceneBox {
  const [bmin, bmax] = inp.box;
  const [west, east, south, north, down, up] = marginReach(inp.margin);

  const anc = inp.anchor;
  const cx = anc ? anc[0] : (bmin[0] + bmax[0]) * 0.5;
  const cy = anc ? anc[1] : (bmin[1] + bmax[1]) * 0.5;
  const cz = anc ? anc[2] : (bmin[2] + bmax[2]) * 0.5;

  const hx = Math.min((bmax[0] - bmin[0]) * 0.5, HORIZ_MAX_HALF_EXTENT);
  const hy = Math.min((bmax[1] - bmin[1]) * 0.5, HORIZ_MAX_HALF_EXTENT);
  const hz = Math.min((bmax[2] - bmin[2]) * 0.5, VERT_MAX_HALF_EXTENT);

  const minX = cx - hx, maxX = cx + hx;
  const minY = cy - hy, maxY = cy + hy;
  let minZ = cz - hz - down, maxZ = cz + hz + up;

  // The height band is measured from the tree BASE — the raw bbox floor.
  //
  // The upper bound always clips. The lower bound clips only when the
  // user raised it above 0: "0" means "from the base up", and the box
  // keeps its natural floor (base − margin) there. The very base of a
  // stem is routinely left unlabelled (tree_id 0), so the LABELLED floor
  // sits above the true stump — snapping the band to it hid exactly the
  // ground-level unassigned points the isolation exists to pull in, and
  // the stem appeared to start higher than it does.
  if (inp.zRange) {
    const lo = Math.min(inp.zRange[0], inp.zRange[1]);
    const hi = Math.max(inp.zRange[0], inp.zRange[1]);
    if (lo > 0) minZ = Math.max(minZ, bmin[2] + lo);
    maxZ = Math.min(maxZ, bmin[2] + hi);
  }

  return {
    x0: (minX - west) - offset[0], x1: (maxX + east) - offset[0],
    y0: minZ - offset[2], y1: maxZ - offset[2],
    // Scene-Z is −(worldY − offY), so the dilated north interval flips:
    // the northern reach lowers scene-Z's floor, the southern raises
    // its ceiling.
    z0: offset[1] - (maxY + north), z1: offset[1] - (minY - south),
  };
}

/** Is a scene-space point inside the box? */
export function inBox(b: SceneBox, x: number, y: number, z: number): boolean {
  return x >= b.x0 && x <= b.x1
      && y >= b.y0 && y <= b.y1
      && z >= b.z0 && z <= b.z1;
}

/** Near and far VIEW-SPACE depth of a scene box, from a camera whose
 *  world-matrix-inverse elements are `e` (three.js column-major 16).
 *
 *  Every consumer of a depth ramp over a region needs this and nothing
 *  else: the box's eight corners projected onto the view axis, minimum
 *  and maximum. The temptation is to use the camera-to-centre distance
 *  plus and minus some half-extent, and that is wrong in a way that
 *  looks plausible — the half-DIAGONAL of a tall thin box is dominated
 *  by its height, an axis mostly perpendicular to the view when you are
 *  looking at a trunk from the side, so the ramp comes out several times
 *  longer than the depth the box actually occupies and whatever it
 *  drives barely moves. (That is exactly what happened to Tree Review's
 *  depth cue; see the call site.)
 *
 *  `minSpan` floors the result so a box seen edge-on, or one the camera
 *  sits inside, cannot collapse to zero and make the consumer divide by
 *  nothing.
 */
export function viewDepthSpan(
  b: SceneBox, e: ArrayLike<number>, minSpan = 0.25,
): { near: number; far: number } {
  let near = Infinity;
  let far = -Infinity;
  for (let c = 0; c < 8; c++) {
    const x = (c & 1) ? b.x1 : b.x0;
    const y = (c & 2) ? b.y1 : b.y0;
    const z = (c & 4) ? b.z1 : b.z0;
    // View-space depth is −(view · p).z; the z row of a column-major
    // 4×4 is elements 2, 6, 10, 14.
    const d = -(e[2] * x + e[6] * y + e[10] * z + e[14]);
    if (d < near) near = d;
    if (d > far) far = d;
  }
  if (!Number.isFinite(near) || !Number.isFinite(far)) return { near: 0, far: minSpan };
  if (!(far - near > minSpan)) {
    const mid = (near + far) * 0.5;
    return { near: mid - minSpan * 0.5, far: mid + minSpan * 0.5 };
  }
  return { near, far };
}
