// Plot polygon persistence helpers. Plots live in the project's plots
// table (schema v2: id, cloud_id, stand_id, name, shape, geometry_wkt,
// center_x, center_y, radius_m, area_m2, created_at, notes). Polygons
// are stored as WKT 'POLYGON((x1 y1, x2 y2, …))' so downstream GIS
// tools can read them without a custom format.
//
// SUPERSEDED
// ----------
// The plot boundary is now a property of the DATASET — PlotBoundaryPanel
// writes plot.json beside the octree and EditorShell seeds shell state
// from it, so Report, Thinning and Inventory all read one value (see
// that panel's header). This project-scoped table is the older design
// it replaced, and nothing in PointCloudLabeler touches it.
//
// The four functions that read and wrote it (savePlot, listPlots,
// deletePlot, renamePlot) are gone, along with the three commands they
// reached it through. Those commands — db_all, db_get, db_run — took
// SQL as a string from the renderer and ran it, which is a general
// primitive: SQLite's ATTACH creates and writes a database file at any
// absolute path, and reads any database file the user can read, and a
// browser's cookie and history stores are database files. The renderer
// has no XSS today, but that is a property of today's code rather than
// a boundary, and the whole surface existed to serve five fixed
// statements against one table that nothing queried.
//
// The two WKT converters stay, and stay tested, for the reason
// io/sceneAxes gives about its own superseded mapping: what is
// preserved has to be preserved CORRECT, or reviving it revives the
// defect. Both had one — see their notes. Reviving the storage itself
// means adding commands that name what they do (`plots_insert`,
// `plots_list`, …) and phrase their own SQL in Rust, not a bridge that
// runs whatever it is handed.

export interface PlotRow {
  id: number;
  cloud_id: string | null;
  stand_id: number | null;
  name: string;
  shape: string | null;
  geometry_wkt: string | null;
  center_x: number | null;
  center_y: number | null;
  radius_m: number | null;
  area_m2: number | null;
  created_at: number;
  notes: string | null;
}

/** Can this coordinate be written as plain decimal WKT?
 *
 *  JavaScript writes a magnitude at or past 1e21, or below about 1e-7,
 *  in exponential notation — "1e+21" — which most WKT parsers reject,
 *  and the whole reason this format was chosen is that other GIS tools
 *  can read it. Rather than expanding such a number, it is refused with
 *  the same rule as a non-finite one: a plot boundary is metres to
 *  kilometres across, so a coordinate at 1e21 is not a plot boundary,
 *  and writing something no GIS will open is not better than saying so.
 *
 *  A first attempt formatted with toFixed(12) instead. That was worse
 *  twice over: it exposed float representation noise a plain String()
 *  hides (500123.456 became "500123.456000000006") and still returned
 *  exponential past 1e21, which is the case it was written for. */
function wktCoord(v: number): string | null {
  // String() gives the shortest representation that round-trips, which
  // is exactly what a coordinate wants.
  // String(-0) is already "0" in JavaScript — measured, and the teeth
  // check reports the explicit normalisation as making no difference.
  // Kept because "a coordinate of negative zero is a coordinate of
  // zero" is the intent, and toFixed, which a later edit might reach
  // for, does NOT hold it: (-0).toFixed(2) is "0.00" but the sign
  // survives other formatters.
  const s = String(v === 0 ? 0 : v);
  return /e/i.test(s) ? null : s;
}

/** Convert a closed XY ring to OGC well-known-text POLYGON. The first
 *  vertex is repeated at the end so the polygon reads as closed for GIS
 *  tools that require it.
 *
 *  Returns '' — no polygon — when any vertex is not a pair of real
 *  numbers. Writing one anyway put the literal "NaN" in the geometry,
 *  and the reader below then DROPPED that vertex, so a square came back
 *  as a triangle: measured, a 100 m square with one unreadable corner
 *  read back at 5000 m² instead of 10000, and every per-hectare figure
 *  divided by it doubled. A polygon missing a vertex is a different
 *  polygon, not a slightly worse one. */
export function polygonToWkt(vertices: Array<[number, number]>): string {
  if (vertices.length < 3) return '';
  if (!vertices.every(v => v && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]))) {
    return '';
  }
  const verts = vertices.slice();
  const first = verts[0];
  const last = verts[verts.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) verts.push(first);
  const cells: string[] = [];
  for (const v of verts) {
    const x = wktCoord(v[0]);
    const y = wktCoord(v[1]);
    if (x === null || y === null) return '';
    cells.push(`${x} ${y}`);
  }
  return `POLYGON((${cells.join(', ')}))`;
}

/** Parse a PointCloudLabeler-written POLYGON WKT back into an XY vertex array.
 *  Returns [] on anything that doesn't look like a single-ring polygon.
 *
 *  Anchored at the start of the geometry, because "POLYGON" is a
 *  substring of "MULTIPOLYGON": the unanchored pattern matched one and
 *  swallowed its extra opening bracket into the first coordinate, so
 *  MULTIPOLYGON(((0 0, 100 0, 100 100, 0 100, 0 0))) came back as a
 *  four-point ring missing its first vertex — the right number of
 *  points, the wrong shape, no error.
 *
 *  A vertex that will not parse makes the WHOLE polygon unreadable
 *  rather than a smaller one. See polygonToWkt for what dropping them
 *  quietly cost. */
export function wktToPolygon(wkt: string | null | undefined): Array<[number, number]> {
  if (!wkt) return [];
  const m = /^\s*POLYGON\s*\(\s*\(([^()]+)\)\s*\)\s*$/i.exec(wkt);
  if (!m) return [];
  const verts: Array<[number, number]> = [];
  for (const pair of m[1].split(',')) {
    const parts = pair.trim().split(/\s+/);
    // A WKT coordinate is 2 or 3 ordinates; anything else is not one.
    if (parts.length < 2 || parts.length > 3) return [];
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    verts.push([x, y]);
  }
  // Drop the closing duplicate when present.
  if (verts.length >= 2) {
    const a = verts[0], b = verts[verts.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) verts.pop();
  }
  return verts;
}
