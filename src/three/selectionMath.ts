// The pure decisions behind the viewport's destructive actions.
//
// Extracted from OctreeView so they can be tested without a WebGL
// context. Both drive operations the user cannot easily undo by eye: a
// lasso decides which points get deleted or reassigned, and the merge map
// decides which tree a point belongs to.

/** Ray-casting point-in-polygon, even-odd rule.
 *
 *  The polygon is implicitly closed — the last vertex joins the first,
 *  so a caller must not repeat it.
 *
 *  Even-odd is what a self-crossing lasso gets judged by: draw a loop
 *  that crosses its own path and the doubly-wound region counts as
 *  OUTSIDE. That is the standard rule for this test and it is what the
 *  viewport has always done, but it is worth knowing when a lasso comes
 *  back having missed the middle of a figure-eight. */
export function pointInPolygon(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    // A horizontal edge has (yi > y) === (yj > y) for every y, so it
    // never reaches the division; the epsilon is belt-and-braces.
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-30) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Collapse merge chains so every id maps straight to its final target.
 *
 *  `raw` is the on-disk overlay: from → to, one hop per recorded merge.
 *  Merging A into B and later B into C leaves A → B → C, and a point
 *  carrying A must end up as C, not B.
 *
 *  A cycle cannot come from a legitimate sequence of merges, but the
 *  overlay is a file: it is written by the backend, survives crashes, and
 *  can be edited. A cycle is therefore treated as corrupt data rather
 *  than trusted — every id in it resolves to the smallest member, which
 *  is stable, deterministic, and independent of which id the walk
 *  happened to start from. The previous walk had no cycle detection at
 *  all: it took 10 000 hops per key before giving up, and then kept
 *  whichever id it had landed on — so the same file could fold a tree
 *  into a different id depending only on iteration order. */
export function flattenRemap(raw: Map<number, number>): Map<number, number> {
  const flat = new Map<number, number>();
  for (const from of raw.keys()) {
    let cur = from;
    const seen = new Set<number>([from]);
    let repeated: number | null = null;
    while (raw.has(cur)) {
      const next = raw.get(cur)!;
      if (seen.has(next)) { repeated = next; break; }
      seen.add(next);
      cur = next;
    }
    let target = cur;
    if (repeated !== null) {
      // Take the smallest id in the CYCLE — not in everything walked.
      // The ids leading into a cycle are not part of it, and including
      // them made the answer depend on where the walk started: for
      // 9 → 10 → 11 → 12 → 10, entering at 9 gave 9 and entering at 11
      // gave 10, so two ids in the same component resolved differently.
      let min = repeated;
      let n = raw.get(repeated)!;
      let guard = 0;
      while (n !== repeated && ++guard < seen.size + 1) {
        if (n < min) min = n;
        n = raw.get(n)!;
      }
      target = min;
    }
    if (target !== from) flat.set(from, target);
  }
  return flat;
}

/** Fold a node's tree ids through the flattened merge map, in place. */
export function applyRemapInPlace(ids: Int32Array, flat: Map<number, number>): void {
  if (flat.size === 0) return;
  for (let i = 0; i < ids.length; i++) {
    const to = flat.get(ids[i]);
    if (to !== undefined) ids[i] = to;
  }
}
