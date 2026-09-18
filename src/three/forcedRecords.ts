// The records the streamer refines to full depth for an isolated tree.
//
// Tree Review's isolate box is clamped around the trunk so a badly
// segmented tree (a few strays across the plot) cannot force half the
// dataset into full detail. The price was that the tree's far parts were
// never loaded: tree 228 looked clean in review while a cluster 50 m
// away carried its id, and TreeQSM — which sees every point of an id —
// fitted cylinders to it. The scan now names the records each tree's
// points live in; this turns that list into the set the planner forces,
// ancestors included, because the planner reaches a record only by
// refining its parent.

export interface RecordTree {
  /** childrenStart[rec]..childrenStart[rec + 1] index childrenFlat. */
  childrenStart: ArrayLike<number>;
  childrenFlat: ArrayLike<number>;
}

const parents = new WeakMap<object, Int32Array>();

/** Parent record of every record, -1 for a root. Built once per index. */
export function parentOf(idx: RecordTree): Int32Array {
  const cached = parents.get(idx);
  if (cached) return cached;
  const n = Math.max(0, idx.childrenStart.length - 1);
  const p = new Int32Array(n).fill(-1);
  for (let rec = 0; rec < n; rec++) {
    for (let k = idx.childrenStart[rec]; k < idx.childrenStart[rec + 1]; k++) {
      const child = idx.childrenFlat[k];
      if (child >= 0 && child < n) p[child] = rec;
    }
  }
  parents.set(idx, p);
  return p;
}

const closures = new WeakMap<number[], WeakMap<object, Set<number>>>();

/** The records to force, with every ancestor of each, memoised on the
 *  identity of the list and of the index: the planner asks twelve times
 *  a second and the answer does not change until the tree does. */
export function forcedRecordSet(records: number[], idx: RecordTree): Set<number> {
  let byIdx = closures.get(records);
  if (!byIdx) { byIdx = new WeakMap(); closures.set(records, byIdx); }
  const cached = byIdx.get(idx);
  if (cached) return cached;
  const par = parentOf(idx);
  const set = new Set<number>();
  for (const r of records) {
    let cur = r;
    while (cur >= 0 && !set.has(cur)) {
      set.add(cur);
      cur = cur < par.length ? par[cur] : -1;
    }
  }
  byIdx.set(idx, set);
  return set;
}
