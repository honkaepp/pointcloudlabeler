// Optimal one-to-one assignment, and the position matcher built on it.
//
// Three places in PointCloudLabeler pair up two lists of trees: the growth
// comparison across epochs, the validation against calipered field
// data, and — the reason this exists — the cross-sensor join, where an
// ALS crown has to be paired with the TLS stem underneath it. All three
// were the same greedy algorithm written out three times: build every
// candidate pair inside a radius, sort by distance, claim in order.
//
// Greedy is what most papers do and it is not merely suboptimal in the
// total-distance sense. It finds FEWER TREES. One crown that happens to
// sit slightly nearer a stem another crown needs takes it, and that
// other crown then has nothing left in range — a tree that both sensors
// saw, reported as seen by only one. On a dense plot that is a real
// dent in the detection rate, and it is invisible: the pair that was
// never made leaves no pointcloudlabeler.
//
// The Hungarian algorithm (Kuhn 1955, Munkres 1957) gives the globally
// optimal assignment for the same cost matrix. Implemented here as the
// shortest-augmenting-path form (Jonker & Volgenant 1987), O(n²m).

/** Cost marking a pair that may not be made — out of range, wrong
 *  species, whatever the caller decides. */
export const FORBIDDEN = Infinity;

/** Minimum-cost one-to-one assignment over `cost[row][col]`.
 *
 *  Returns `colOf[row]`: the column assigned to each row, or −1 when the
 *  row is left unassigned. Rows and columns need not be equal in number;
 *  the shorter side is fully assigned unless every remaining pair is
 *  FORBIDDEN.
 *
 *  Forbidden pairs are handled by substituting a finite value larger
 *  than any achievable total of real costs, then dropping the pairs that
 *  used it. Leaving them as Infinity would poison the potentials with
 *  Infinity − Infinity = NaN and quietly return nonsense. */
export function assign(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const m = cost[0].length;
  if (m === 0) return new Array(n).fill(-1);

  // A bound that no feasible assignment of real costs can reach, so the
  // solver takes any real pair over any forbidden one.
  let maxReal = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const c = cost[i][j];
      if (Number.isFinite(c) && c > maxReal) maxReal = c;
    }
  }
  const big = (maxReal + 1) * (Math.min(n, m) + 1);
  const sub = (i: number, j: number): number => {
    const c = cost[i][j];
    // NaN is not a cost. Treating it as one would make the result depend
    // on comparison order, which is how it would go unnoticed.
    return Number.isFinite(c) ? c : big;
  };

  // The algorithm below wants rows ≤ columns; transpose if not and undo
  // it at the end.
  const flip = n > m;
  const R = flip ? m : n;
  const C = flip ? n : m;
  const at = flip ? (r: number, c: number) => sub(c, r) : sub;

  // Jonker–Volgenant, 1-indexed as in the standard formulation.
  // u, v are the dual potentials; p[j] is the row matched to column j.
  const u = new Float64Array(R + 1);
  const v = new Float64Array(C + 1);
  const p = new Int32Array(C + 1);
  const way = new Int32Array(C + 1);

  for (let i = 1; i <= R; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(C + 1).fill(Infinity);
    const used = new Uint8Array(C + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = -1;
      for (let j = 1; j <= C; j++) {
        if (used[j]) continue;
        const cur = at(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      if (j1 < 0) break;   // no reachable column — cannot happen for R ≤ C
      for (let j = 0; j <= C; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    // Walk the augmenting path back, flipping the matching along it.
    while (j0 !== 0) {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    }
  }

  const out = new Array<number>(n).fill(-1);
  for (let j = 1; j <= C; j++) {
    const i = p[j];
    if (i === 0) continue;
    const row = flip ? j - 1 : i - 1;
    const col = flip ? i - 1 : j - 1;
    // Drop the pairs that only exist because a forbidden cost was
    // substituted: they are the solver filling out a square, not a match.
    if (!Number.isFinite(cost[row][col])) continue;
    out[row] = col;
  }
  return out;
}

export interface Pairing<A, B> {
  a: A;
  b: B;
  /** Planimetric separation (m). */
  distance: number;
}

export interface MatchResult<A, B> {
  matches: Pairing<A, B>[];
  unmatchedA: A[];
  unmatchedB: B[];
}

export type MatchMethod = 'optimal' | 'greedy';

export interface MatchOptions {
  /** Pairs further apart than this are never made (m). */
  radius: number;
  /** 'optimal' is the Hungarian assignment and the default. 'greedy' is
   *  nearest-first, kept so the two can be compared — it is what the
   *  literature usually reports, so a like-for-like number sometimes has
   *  to be produced. */
  method?: MatchMethod;
}

const NO_POS: readonly [number, number] = [NaN, NaN];

/** Pair two lists of positioned things, one-to-one, within a radius.
 *
 *  The shared matcher: growth across epochs, validation against field
 *  data, and the ALS↔TLS join all come through here, so they agree about
 *  what "the same tree" means. */
export function matchByPosition<A, B>(
  as: readonly A[],
  bs: readonly B[],
  xyA: (a: A) => readonly [number, number],
  xyB: (b: B) => readonly [number, number],
  opts: MatchOptions,
): MatchResult<A, B> {
  // A radius of exactly 0 is meaningful — it pairs only trees at
  // identical coordinates. A negative or non-finite one is not a radius
  // at all, and must match nothing rather than quietly collapsing to the
  // exact-coincidence case, which is what it would do if it were merely
  // clamped to 0.
  const r2 = Number.isFinite(opts.radius) && opts.radius >= 0
    ? opts.radius * opts.radius
    : -1;
  const takenA = new Set<number>();
  const takenB = new Set<number>();
  const matches: Pairing<A, B>[] = [];

  const posA = as.map(a => xyA(a) ?? NO_POS);
  const posB = bs.map(b => xyB(b) ?? NO_POS);
  const sep2 = (i: number, j: number): number => {
    const [ax, ay] = posA[i];
    const [bx, by] = posB[j];
    // A tree with no position matches nothing. It is not at the origin.
    if (!Number.isFinite(ax) || !Number.isFinite(ay)
      || !Number.isFinite(bx) || !Number.isFinite(by)) return Infinity;
    const dx = ax - bx, dy = ay - by;
    const d2 = dx * dx + dy * dy;
    return d2 <= r2 ? d2 : Infinity;
  };

  if (as.length > 0 && bs.length > 0) {
    if (opts.method === 'greedy') {
      const cand: { i: number; j: number; d2: number }[] = [];
      for (let i = 0; i < as.length; i++) {
        for (let j = 0; j < bs.length; j++) {
          const d2 = sep2(i, j);
          if (Number.isFinite(d2)) cand.push({ i, j, d2 });
        }
      }
      // Tie-break by index so the result does not depend on the order
      // the sort happened to leave equal distances in.
      cand.sort((x, y) => x.d2 - y.d2 || x.i - y.i || x.j - y.j);
      for (const c of cand) {
        if (takenA.has(c.i) || takenB.has(c.j)) continue;
        takenA.add(c.i); takenB.add(c.j);
        matches.push({ a: as[c.i], b: bs[c.j], distance: Math.sqrt(c.d2) });
      }
    } else {
      // Cost is the SQUARED distance, deliberately. Minimising Σd² and
      // minimising Σd can pick different assignments; squared penalises
      // one bad pair more than several slightly-worse ones, which is the
      // behaviour wanted when a long pair usually means a wrong pair.
      const cost: number[][] = as.map((_, i) =>
        bs.map((__, j) => sep2(i, j)));
      const colOf = assign(cost);
      for (let i = 0; i < colOf.length; i++) {
        const j = colOf[i];
        if (j < 0) continue;
        takenA.add(i); takenB.add(j);
        matches.push({ a: as[i], b: bs[j], distance: Math.sqrt(cost[i][j]) });
      }
    }
  }

  return {
    matches,
    unmatchedA: as.filter((_, i) => !takenA.has(i)),
    unmatchedB: bs.filter((_, j) => !takenB.has(j)),
  };
}

/** Σ of the pair distances (m). What a report quotes — but NOT what the
 *  optimal method minimises; see `totalSquaredDistance`. */
export function totalDistance<A, B>(r: MatchResult<A, B>): number {
  return r.matches.reduce((s, p) => s + p.distance, 0);
}

/** Σd² — the objective the optimal method actually minimises.
 *
 *  Worth naming, because the consequence surprises: on the same plot the
 *  optimal assignment can have a LARGER Σd than the greedy one while
 *  having a smaller Σd². That is the squared cost doing its job — it
 *  refuses one implausible 3 m pair (9) to buy three ordinary 1 m pairs
 *  (3), where minimising Σd would take the trade. For trees, a long pair
 *  usually means a wrong pair, so the squared objective is the one that
 *  matches what the number is for. */
export function totalSquaredDistance<A, B>(r: MatchResult<A, B>): number {
  return r.matches.reduce((s, p) => s + p.distance * p.distance, 0);
}
