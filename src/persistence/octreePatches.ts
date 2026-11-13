// Stage 3 — sparse edits overlay for octree datasets.
//
// The converter writes octree.bin once and never touches it again;
// every later edit (tree_id assignment, semantic label, hide point)
// lives in <octreeDir>/patches.bin as a small list of records keyed
// by (tile, record, point). When a node block loads, the viewer
// applies any matching patches to the decoded buffers before pushing
// them to the GPU; saves flush the in-memory patches back to disk via
// the Tauri write command.
//
// File layout (in sync with octree.rs):
//   header   : 4 bytes "TROP" + u32 version (1 = legacy · 2 = with deadwood)
//   record[] (v1, 24 B): u16 tile, u16 reserved, u32 record, u32 point,
//              i32 treeId (-1 = unchanged),
//              u8 semantic (0 unchanged · 1 stem · 2 branch · 3 cleared ·
//              4 leaf, PointCloudLabeler),
//              u8 deleted  (0 unchanged · 1 hide · 2 unhide),
//              u16 reserved
//   record[] (v2, 32 B): ...all of v1 (24 B)... then
//              i32 standingDeadwood (-1 = unchanged · 0 clears · >0 sets id),
//              i32 layingDeadwood   (same semantics)
//
// v1 buffers still load (the deadwood fields default to -1 = unchanged);
// every save writes v2 so deadwood overrides round-trip. In-memory we
// keep one Map keyed by `${tile}:${record}` so a node load only touches
// its own patches; PointCloudLabeler packs each node's patches into typed arrays
// (NodePatches) so millions of edited points cost megabytes, not
// gigabytes.

export interface PatchEntry {
  /** Point index inside the node's block (0..numPoints). */
  pointIdx: number;
  /** −1 = unchanged. */
  treeId: number;
  /** 0 unchanged · 1 stem · 2 branch · 3 cleared (set back to none). */
  semantic: 0 | 1 | 2 | 3 | 4;
  /** 0 unchanged · 1 hide · 2 unhide. */
  deleted: 0 | 1 | 2;
  /** Standing-deadwood instance id override. −1 = unchanged · 0 clears
   *  the label · >0 sets the instance. */
  standingDeadwood: number;
  /** Laying-deadwood instance id override (same semantics). */
  layingDeadwood: number;
}

export type NodeKey = `${number}:${number}`;
export const nodeKey = (tile: number, record: number): NodeKey => `${tile}:${record}` as NodeKey;

const MAGIC = new Uint8Array([0x54, 0x52, 0x4F, 0x50]); // "TROP"
const VERSION_V1 = 1;
const VERSION_V2 = 2;
/** Latest version the serializer emits. */
const VERSION = VERSION_V2;
const REC_BYTES_V1 = 24;
const REC_BYTES_V2 = 32;
const HEADER_BYTES = 8;

/** Decode patches.bin into a node-keyed map. Empty input → empty
 *  map (used for octrees that have no edits yet). Accepts both v1
 *  (24 B/rec) and v2 (32 B/rec) bodies. */
export function deserialize(bytes: ArrayBuffer): Map<NodeKey, PatchEntry[]> {
  const out = new Map<NodeKey, PatchEntry[]>();
  if (bytes.byteLength === 0) return out;
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error('patches.bin too short — missing header');
  }
  const dv = new DataView(bytes);
  if (
    dv.getUint8(0) !== MAGIC[0] || dv.getUint8(1) !== MAGIC[1] ||
    dv.getUint8(2) !== MAGIC[2] || dv.getUint8(3) !== MAGIC[3]
  ) {
    throw new Error('patches.bin missing TROP magic');
  }
  const version = dv.getUint32(4, true);
  let recBytes: number;
  if (version === VERSION_V1) recBytes = REC_BYTES_V1;
  else if (version === VERSION_V2) recBytes = REC_BYTES_V2;
  else throw new Error(`unsupported patches version ${version}`);
  const bodyBytes = bytes.byteLength - HEADER_BYTES;
  if (bodyBytes % recBytes !== 0) {
    throw new Error(`patches body length ${bodyBytes} is not a multiple of ${recBytes}`);
  }
  const n = bodyBytes / recBytes;
  for (let i = 0; i < n; i++) {
    const o = HEADER_BYTES + i * recBytes;
    const tile = dv.getUint16(o, true);
    // bytes o+2..o+4 reserved
    const record = dv.getUint32(o + 4, true);
    const point = dv.getUint32(o + 8, true);
    const treeId = dv.getInt32(o + 12, true);
    const semantic = dv.getUint8(o + 16) as 0 | 1 | 2 | 3 | 4;
    const deleted = dv.getUint8(o + 17) as 0 | 1 | 2;
    // bytes o+18..o+20 reserved
    const standingDeadwood = recBytes === REC_BYTES_V2 ? dv.getInt32(o + 20, true) : -1;
    const layingDeadwood = recBytes === REC_BYTES_V2 ? dv.getInt32(o + 24, true) : -1;
    // bytes o+28..o+32 reserved (v2)
    const key = nodeKey(tile, record);
    let list = out.get(key);
    if (!list) { list = []; out.set(key, list); }
    list.push({ pointIdx: point, treeId, semantic, deleted, standingDeadwood, layingDeadwood });
  }
  return out;
}

// ---------------------------------------------------------------------
// One node's patches, packed.
// ---------------------------------------------------------------------

/** One node's patches as parallel typed arrays sorted by point index:
 *  18 bytes a patched point. The store used to keep a PatchEntry object
 *  and a Map entry per point (~120 B) and two more object copies per
 *  point in its undo history, so assigning a tree id to 10 M points cost
 *  gigabytes of script memory before anything was saved. */
export class NodePatches {
  count = 0;
  pointIdx: Uint32Array;
  treeId: Int32Array;
  semantic: Uint8Array;
  deleted: Uint8Array;
  standingDeadwood: Int32Array;
  layingDeadwood: Int32Array;

  constructor(capacity = 0) {
    this.pointIdx = new Uint32Array(capacity);
    this.treeId = new Int32Array(capacity);
    this.semantic = new Uint8Array(capacity);
    this.deleted = new Uint8Array(capacity);
    this.standingDeadwood = new Int32Array(capacity);
    this.layingDeadwood = new Int32Array(capacity);
  }

  get length(): number { return this.count; }

  /** The slot holding `point`, or −1. */
  indexOf(point: number): number {
    let lo = 0, hi = this.count - 1;
    const a = this.pointIdx;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const v = a[mid];
      if (v === point) return mid;
      if (v < point) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  /** Slot `i` as an entry object (for the occasional reader). */
  entry(i: number): PatchEntry {
    return {
      pointIdx: this.pointIdx[i], treeId: this.treeId[i],
      semantic: this.semantic[i] as 0 | 1 | 2 | 3 | 4, deleted: this.deleted[i] as 0 | 1 | 2,
      standingDeadwood: this.standingDeadwood[i], layingDeadwood: this.layingDeadwood[i],
    };
  }

  toEntries(): PatchEntry[] {
    const out: PatchEntry[] = new Array(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.entry(i);
    return out;
  }

  *[Symbol.iterator](): IterableIterator<PatchEntry> {
    for (let i = 0; i < this.count; i++) yield this.entry(i);
  }

  /** Copy slot `i` of `src` into slot `j` of this. */
  copySlot(j: number, src: NodePatches, i: number): void {
    this.pointIdx[j] = src.pointIdx[i];
    this.treeId[j] = src.treeId[i];
    this.semantic[j] = src.semantic[i];
    this.deleted[j] = src.deleted[i];
    this.standingDeadwood[j] = src.standingDeadwood[i];
    this.layingDeadwood[j] = src.layingDeadwood[i];
  }

  /** Slot `j` as "changes nothing" for `point`. */
  clearSlot(j: number, point: number): void {
    this.pointIdx[j] = point;
    this.treeId[j] = -1;
    this.semantic[j] = 0;
    this.deleted[j] = 0;
    this.standingDeadwood[j] = -1;
    this.layingDeadwood[j] = -1;
  }

  /** Whether slot `j` changes nothing (and so is not worth keeping). */
  isEmptySlot(j: number): boolean {
    return this.treeId[j] === -1 && this.semantic[j] === 0 && this.deleted[j] === 0
      && this.standingDeadwood[j] === -1 && this.layingDeadwood[j] === -1;
  }

  /** The arrays cut down to `count` when they hold much more. */
  trim(): this {
    if (this.pointIdx.length > 16 && this.count < this.pointIdx.length * 0.75) {
      const n = this.count;
      this.pointIdx = this.pointIdx.slice(0, n);
      this.treeId = this.treeId.slice(0, n);
      this.semantic = this.semantic.slice(0, n);
      this.deleted = this.deleted.slice(0, n);
      this.standingDeadwood = this.standingDeadwood.slice(0, n);
      this.layingDeadwood = this.layingDeadwood.slice(0, n);
    }
    return this;
  }

  /** A copy, exactly sized. */
  clone(): NodePatches {
    const n = this.count;
    const out = new NodePatches(0);
    out.pointIdx = this.pointIdx.slice(0, n);
    out.treeId = this.treeId.slice(0, n);
    out.semantic = this.semantic.slice(0, n);
    out.deleted = this.deleted.slice(0, n);
    out.standingDeadwood = this.standingDeadwood.slice(0, n);
    out.layingDeadwood = this.layingDeadwood.slice(0, n);
    out.count = n;
    return out;
  }

  /** From a list of entries in any order; a point listed twice keeps
   *  its last entry, as applying the list in order would. */
  static fromEntries(list: readonly PatchEntry[]): NodePatches {
    const order = Array.from(list.keys()).sort((a, b) => (list[a].pointIdx - list[b].pointIdx) || (a - b));
    const out = new NodePatches(list.length);
    let n = 0;
    for (const k of order) {
      const e = list[k];
      if (n > 0 && out.pointIdx[n - 1] === e.pointIdx) n--;
      out.pointIdx[n] = e.pointIdx;
      out.treeId[n] = e.treeId;
      out.semantic[n] = e.semantic;
      out.deleted[n] = e.deleted;
      out.standingDeadwood[n] = e.standingDeadwood;
      out.layingDeadwood[n] = e.layingDeadwood;
      n++;
    }
    out.count = n;
    return out.trim();
  }
}

type AnyPatches = NodePatches | readonly PatchEntry[];

/** Decode patches.bin straight into packed nodes, without an object per
 *  record (what loadPatches hands the store). */
export function deserializePacked(bytes: ArrayBuffer): Map<NodeKey, NodePatches> {
  const out = new Map<NodeKey, NodePatches>();
  if (bytes.byteLength === 0) return out;
  // The header checks are deserialize()'s; an empty body decodes there
  // without a record.
  if (bytes.byteLength <= HEADER_BYTES) { deserialize(bytes); return out; }
  const dv = new DataView(bytes);
  deserialize(bytes.slice(0, HEADER_BYTES));
  const version = dv.getUint32(4, true);
  const recBytes = version === VERSION_V1 ? REC_BYTES_V1 : REC_BYTES_V2;
  const bodyBytes = bytes.byteLength - HEADER_BYTES;
  if (bodyBytes % recBytes !== 0) {
    throw new Error(`patches body length ${bodyBytes} is not a multiple of ${recBytes}`);
  }
  const n = bodyBytes / recBytes;
  // Two passes: count each node's records, then fill its arrays.
  const counts = new Map<NodeKey, number>();
  for (let i = 0; i < n; i++) {
    const o = HEADER_BYTES + i * recBytes;
    const key = nodeKey(dv.getUint16(o, true), dv.getUint32(o + 4, true));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, c] of counts) out.set(key, new NodePatches(c));
  for (let i = 0; i < n; i++) {
    const o = HEADER_BYTES + i * recBytes;
    const node = out.get(nodeKey(dv.getUint16(o, true), dv.getUint32(o + 4, true)))!;
    const j = node.count++;
    node.pointIdx[j] = dv.getUint32(o + 8, true);
    node.treeId[j] = dv.getInt32(o + 12, true);
    node.semantic[j] = dv.getUint8(o + 16);
    node.deleted[j] = dv.getUint8(o + 17);
    node.standingDeadwood[j] = recBytes === REC_BYTES_V2 ? dv.getInt32(o + 20, true) : -1;
    node.layingDeadwood[j] = recBytes === REC_BYTES_V2 ? dv.getInt32(o + 24, true) : -1;
  }
  // Saves write each node sorted; anything else is sorted here.
  for (const [key, node] of out) {
    let sorted = true;
    for (let j = 1; j < node.count && sorted; j++) if (node.pointIdx[j] <= node.pointIdx[j - 1]) sorted = false;
    if (!sorted) out.set(key, NodePatches.fromEntries(node.toEntries()));
  }
  return out;
}

/** Write one record (v2) at `off`. */
function writeRecord(dv: DataView, off: number, tile: number, record: number, p: AnyPatches, i: number): void {
  dv.setUint16(off, tile, true);
  // bytes off+2..off+4 reserved (0)
  dv.setUint32(off + 4, record, true);
  if (p instanceof NodePatches) {
    dv.setUint32(off + 8, p.pointIdx[i], true);
    dv.setInt32(off + 12, p.treeId[i], true);
    dv.setUint8(off + 16, p.semantic[i]);
    dv.setUint8(off + 17, p.deleted[i]);
    // bytes off+18..off+20 reserved (0)
    dv.setInt32(off + 20, p.standingDeadwood[i], true);
    dv.setInt32(off + 24, p.layingDeadwood[i], true);
  } else {
    const e = p[i];
    dv.setUint32(off + 8, e.pointIdx, true);
    dv.setInt32(off + 12, e.treeId, true);
    dv.setUint8(off + 16, e.semantic);
    dv.setUint8(off + 17, e.deleted);
    dv.setInt32(off + 20, e.standingDeadwood, true);
    dv.setInt32(off + 24, e.layingDeadwood, true);
  }
  // bytes off+28..off+32 reserved (0)
}

function splitKey(key: NodeKey): [number, number] {
  const sep = key.indexOf(':');
  return [parseInt(key.slice(0, sep), 10), parseInt(key.slice(sep + 1), 10)];
}

/** Encode the patches map into a flat buffer matching the on-disk
 *  format (always v2). Empty maps still emit the header so the Rust
 *  writer always sees a valid TROP file.
 *
 *  savePatches() below does NOT call this — it streams the same
 *  per-record encoding straight into bounded IPC chunks so a save never
 *  allocates one buffer sized to the whole patch set. This stays around
 *  for anything that wants the whole thing in memory at once (tests,
 *  other one-shot callers). */
export function serialize(patches: ReadonlyMap<NodeKey, AnyPatches>): Uint8Array {
  let total = 0;
  for (const list of patches.values()) total += list.length;
  const buf = new Uint8Array(HEADER_BYTES + total * REC_BYTES_V2);
  buf.set(MAGIC, 0);
  const dv = new DataView(buf.buffer);
  dv.setUint32(4, VERSION, true);
  let off = HEADER_BYTES;
  for (const [key, list] of patches) {
    const [tile, record] = splitKey(key);
    for (let i = 0; i < list.length; i++) {
      writeRecord(dv, off, tile, record, list, i);
      off += REC_BYTES_V2;
    }
  }
  return buf;
}

/** Apply patches to the decoded buffers of a single node, in place.
 *  Called by the viewer before pushing the node's data to the GPU.
 *  `originalPositions` is consulted by deleted = 2 (unhide) to restore
 *  the point's original world position after a previous hide. */
export function applyToNode(
  treeIds: Int32Array,
  semantic: Uint8Array | null,
  deleted: Uint8Array | null,
  positions: Float32Array,
  originalPositions: Float32Array,
  entries: AnyPatches | undefined,
  /** Editable standing- / laying-deadwood id arrays (parallel to treeIds).
   *  Null when the dataset doesn't carry the channel. A patch with the
   *  field ≥ 0 overrides; -1 leaves it. */
  standingDeadwood: Int32Array | null = null,
  layingDeadwood: Int32Array | null = null,
): void {
  if (!entries) return;
  const one = (p: number, tree: number, sem: number, del: number, sd: number, ld: number): void => {
    if (p >= treeIds.length) return;
    if (tree >= 0) treeIds[p] = tree;
    if (semantic && sem !== 0) semantic[p] = sem === 3 ? 0 : sem;
    if (standingDeadwood && sd >= 0) standingDeadwood[p] = sd;
    if (layingDeadwood && ld >= 0) layingDeadwood[p] = ld;
    if (del !== 0) {
      if (deleted) deleted[p] = del === 1 ? 1 : 0;
      if (del === 1) {
        // Hide — NaN out the position so the GPU skips it.
        positions[p * 3] = NaN;
        positions[p * 3 + 1] = NaN;
        positions[p * 3 + 2] = NaN;
      } else if (del === 2) {
        // Unhide — restore the cached original position.
        positions[p * 3] = originalPositions[p * 3];
        positions[p * 3 + 1] = originalPositions[p * 3 + 1];
        positions[p * 3 + 2] = originalPositions[p * 3 + 2];
      }
    }
  };
  if (entries instanceof NodePatches) {
    for (let i = 0; i < entries.count; i++) {
      one(entries.pointIdx[i], entries.treeId[i], entries.semantic[i], entries.deleted[i],
        entries.standingDeadwood[i], entries.layingDeadwood[i]);
    }
    return;
  }
  for (const e of entries) one(e.pointIdx, e.treeId, e.semantic, e.deleted, e.standingDeadwood, e.layingDeadwood);
}

// ---------------------------------------------------------------------
// Read / write via Tauri (thin wrappers around the bridge commands).
// ---------------------------------------------------------------------

type DesktopApi = {
  octreeReadPatches?: (dir: string) => Promise<ArrayBuffer>;
  octreeWritePatches?: (dir: string, bytes: Uint8Array) => Promise<number>;
  octreeWritePatchesBegin?: (dir: string) => Promise<void>;
  octreeWritePatchesChunk?: (dir: string, bytes: Uint8Array) => Promise<void>;
  octreeWritePatchesCommit?: (dir: string) => Promise<number>;
};

function api(): DesktopApi | null {
  const d = (window as unknown as { desktop?: DesktopApi }).desktop;
  return d?.octreeReadPatches ? d : null;
}

/** patches.bin, packed per node (deserializePacked). */
export async function loadPatches(octreeDir: string): Promise<Map<NodeKey, NodePatches>> {
  const a = api();
  if (!a?.octreeReadPatches) return new Map();
  const bytes = await a.octreeReadPatches(octreeDir);
  return deserializePacked(bytes);
}

/** Records buffered per IPC call while saving. Bounds save-time peak
 *  memory to a few chunks' worth (200k × 32 B ≈ 6.4 MB) instead of one
 *  buffer sized to the whole cumulative patch set — on a big correction
 *  (millions of points, edits piling up with no compaction) that single
 *  allocation plus its IPC copy was enough on its own to push WebView2
 *  over its memory ceiling on top of an already-huge loaded scene, so
 *  the app died mid-save and the save was lost. */
const CHUNK_RECORDS = 200_000;

export async function savePatches(
  octreeDir: string,
  patches: ReadonlyMap<NodeKey, AnyPatches>,
): Promise<number> {
  const a = api();
  if (!a?.octreeWritePatchesBegin || !a.octreeWritePatchesChunk || !a.octreeWritePatchesCommit) {
    throw new Error('Octree patches IO unavailable.');
  }
  await a.octreeWritePatchesBegin(octreeDir);
  // A fresh buffer per chunk (not one reused across sends): the bridge hands
  // the chunk's ArrayBuffer straight to Tauri's IPC, and we must not assume
  // whether that call leaves the source buffer usable — reusing it could
  // detach it mid-save and break the very save this fix protects. One live
  // 6.4 MB chunk at a time keeps peak memory bounded regardless. Per-record
  // layout matches serialize() byte for byte.
  let chunk = new Uint8Array(CHUNK_RECORDS * REC_BYTES_V2);
  let dv = new DataView(chunk.buffer);
  let filled = 0;
  for (const [key, list] of patches) {
    const [tile, record] = splitKey(key);
    for (let i = 0; i < list.length; i++) {
      writeRecord(dv, filled * REC_BYTES_V2, tile, record, list, i);
      filled++;
      if (filled === CHUNK_RECORDS) {
        await a.octreeWritePatchesChunk(octreeDir, chunk);
        chunk = new Uint8Array(CHUNK_RECORDS * REC_BYTES_V2);
        dv = new DataView(chunk.buffer);
        filled = 0;
      }
    }
  }
  if (filled > 0) {
    // Exact-size copy for the tail so it already owns exactly its bytes
    // — the bridge ships it straight through with no further copy.
    await a.octreeWritePatchesChunk(octreeDir, chunk.slice(0, filled * REC_BYTES_V2));
  }
  return a.octreeWritePatchesCommit(octreeDir);
}

// ---------------------------------------------------------------------
// In-memory editor that the viewer drives. Wraps the map + an undo
// stack + a dirty flag so saving knows whether to hit disk.
// ---------------------------------------------------------------------

export interface PatchEdit {
  tile: number;
  record: number;
  pointIdx: number;
  treeId?: number;        // unset = don't touch
  semantic?: 0 | 1 | 2 | 3 | 4;
  deleted?: 0 | 1 | 2;
  /** Standing-deadwood id: ≥0 sets (0 clears the label), unset = leave. */
  standingDeadwood?: number;
  /** Laying-deadwood id (same semantics). */
  layingDeadwood?: number;
}

/** What one edit does to every point it is applied to; unset fields are
 *  left as they are. */
export type PatchAction = Omit<PatchEdit, 'tile' | 'record' | 'pointIdx'>;

/** One node's part of an undo step — the points (ascending,
 *  each once), the action, and what the points held before: whether
 *  each had a patch, and the patches of those that did, in point order.
 *  Redo applies the action again, which from the state undo restored
 *  gives the same result; so the step keeps no copy of the outcome. */
interface UndoSegment {
  key: NodeKey;
  points: Uint32Array;
  action: PatchAction;
  had: Uint8Array;
  prev: NodePatches | null;
}

/** One undo/redo step: its segments plus an opaque payload the caller
 *  attached to the batch (the viewer stores the selection that produced
 *  the edit, so undoing a wrong-button apply restores the points as
 *  still-selected instead of dumping the user's hand-picked set). The
 *  store never interprets `meta` — it just rides along. */
interface UndoBatch {
  segments: UndoSegment[];
  meta?: unknown;
  points: number;
}

/** Undo history bounds: steps, and points across them. A step past the
 *  point bound drops the oldest steps; the newest always stays. */
const UNDO_STEPS = 100;
const UNDO_POINTS = 50_000_000;

/** `node` rebuilt with each of `points` (ascending, each once) changed
 *  by `set`, which finds the point's current patch — or a cleared slot
 *  when it had none, `had` false — in slot `j` of `out`. Slots left
 *  changing nothing are dropped; the node's other points are copied as
 *  they are. O(node + points). */
function rebuild(
  node: NodePatches | undefined,
  points: Uint32Array,
  set: (out: NodePatches, j: number, k: number, had: boolean) => void,
): NodePatches {
  const n = node ? node.count : 0;
  const out = new NodePatches(n + points.length);
  let i = 0, k = 0, j = 0;
  while (i < n || k < points.length) {
    const pi = i < n ? node!.pointIdx[i] : Infinity;
    const pk = k < points.length ? points[k] : Infinity;
    if (pi < pk) {
      out.copySlot(j++, node!, i++);
      continue;
    }
    const had = pi === pk;
    if (had) out.copySlot(j, node!, i++); else out.clearSlot(j, pk);
    set(out, j, k, had);
    k++;
    if (!out.isEmptySlot(j)) j++;
  }
  out.count = j;
  return out.trim();
}

function applyActionTo(out: NodePatches, j: number, a: PatchAction): void {
  if (a.treeId !== undefined) out.treeId[j] = a.treeId;
  if (a.semantic !== undefined) out.semantic[j] = a.semantic;
  if (a.deleted !== undefined) out.deleted[j] = a.deleted;
  if (a.standingDeadwood !== undefined) out.standingDeadwood[j] = a.standingDeadwood;
  if (a.layingDeadwood !== undefined) out.layingDeadwood[j] = a.layingDeadwood;
}

/** Ascending, each once. */
function sortedUnique(points: ArrayLike<number>): Uint32Array {
  const a = Uint32Array.from(points);
  let ordered = true;
  for (let i = 1; i < a.length && ordered; i++) if (a[i] <= a[i - 1]) ordered = false;
  if (ordered) return a;
  a.sort();
  let n = 0;
  for (let i = 0; i < a.length; i++) if (n === 0 || a[i] !== a[n - 1]) a[n++] = a[i];
  return n === a.length ? a : a.slice(0, n);
}

export class PatchStore {
  /** The patches, node by node. Read it; change it through the store. */
  readonly map: Map<NodeKey, NodePatches> = new Map();
  /** Per-batch undo steps. applyEdits / applyAction push a single batch
   *  so the whole brush stroke undoes in one keystroke. */
  private undoStack: UndoBatch[] = [];
  private redoStack: UndoBatch[] = [];
  private undoPoints = 0;
  /** Bumped whenever the store mutates so the viewer's recolour
   *  effect can react. */
  private _version = 0;
  /** True when the in-memory state has unsaved changes. */
  private _dirty = false;
  /** Node keys touched by the most recent mutation, so the viewer can
   *  re-apply patches to just those nodes instead of every loaded one.
   *  `'all'` means a wholesale change (loadFrom) — refresh everything. */
  private _touched: Set<NodeKey> | 'all' = 'all';

  get version(): number { return this._version; }
  get dirty(): boolean { return this._dirty; }

  /** One node's patches as entry objects (tests, occasional readers). */
  entries(key: NodeKey): PatchEntry[] | undefined {
    return this.map.get(key)?.toEntries();
  }

  /** Return the keys touched since the last call and reset the tracker.
   *  `'all'` ⇒ the caller should refresh every loaded node. */
  takeTouched(): Set<NodeKey> | 'all' {
    const t = this._touched;
    this._touched = new Set();
    return t;
  }

  private markTouched(key: NodeKey): void {
    if (this._touched !== 'all') this._touched.add(key);
  }

  private put(key: NodeKey, node: NodePatches): void {
    if (node.count === 0) this.map.delete(key); else this.map.set(key, node);
  }

  loadFrom(map: ReadonlyMap<NodeKey, AnyPatches>): void {
    this.map.clear();
    for (const [k, v] of map) {
      // A copy: the caller keeps whatever it handed in. Packed nodes are
      // sorted and each point once already (deserializePacked).
      const node = v instanceof NodePatches ? v.clone() : NodePatches.fromEntries(v);
      this.put(k, node);
    }
    this.undoStack = [];
    this.redoStack = [];
    this.undoPoints = 0;
    this._dirty = false;
    this._touched = 'all';
    this._version++;
  }

  /** Strip one column from every patch entry — used by the column-reset
   *  feature, which zeroes the baked values in octree.bin and then clears
   *  the matching overrides here so they don't re-impose the old values
   *  on reload. Entries that become no-ops are dropped. This is a bulk,
   *  non-undoable operation (like loadFrom): it clears the undo/redo
   *  stacks and marks everything touched + dirty so the caller persists
   *  and refreshes. Returns the number of overrides cleared. */
  clearAttribute(attr: 'tree_id' | 'semantic' | 'standing_deadwood' | 'laying_deadwood'): number {
    let cleared = 0;
    for (const [key, node] of [...this.map]) {
      let j = 0;
      for (let i = 0; i < node.count; i++) {
        if (attr === 'tree_id' && node.treeId[i] !== -1) { node.treeId[i] = -1; cleared++; }
        else if (attr === 'semantic' && node.semantic[i] !== 0) { node.semantic[i] = 0; cleared++; }
        else if (attr === 'standing_deadwood' && node.standingDeadwood[i] !== -1) { node.standingDeadwood[i] = -1; cleared++; }
        else if (attr === 'laying_deadwood' && node.layingDeadwood[i] !== -1) { node.layingDeadwood[i] = -1; cleared++; }
        // Drop entries that no longer carry any change.
        if (node.isEmptySlot(i)) continue;
        if (j !== i) node.copySlot(j, node, i);
        j++;
      }
      node.count = j;
      this.put(key, node.trim());
    }
    this.undoStack = [];
    this.redoStack = [];
    this.undoPoints = 0;
    this._touched = 'all';
    this._dirty = true;
    this._version++;
    return cleared;
  }

  /** Apply `seg.action` to its points, recording what they held before. */
  private forward(seg: UndoSegment, record: boolean): void {
    this.markTouched(seg.key);
    let prev: NodePatches | null = null;
    const node = rebuild(this.map.get(seg.key), seg.points, (out, j, k, had) => {
      if (record && had) {
        seg.had[k] = 1;
        if (!prev) prev = new NodePatches(seg.points.length);
        prev.copySlot(prev.count++, out, j);
      }
      applyActionTo(out, j, seg.action);
    });
    if (record) seg.prev = prev ? (prev as NodePatches).trim() : null;
    this.put(seg.key, node);
  }

  /** Put back what the segment's points held before it. */
  private backward(seg: UndoSegment): void {
    this.markTouched(seg.key);
    let p = 0;
    const node = rebuild(this.map.get(seg.key), seg.points, (out, j, k) => {
      if (seg.had[k] && seg.prev) {
        out.copySlot(j, seg.prev, p++);
      } else {
        out.clearSlot(j, seg.points[k]);
      }
    });
    this.put(seg.key, node);
  }

  private pushUndo(batch: UndoBatch): void {
    this.undoStack.push(batch);
    this.undoPoints += batch.points;
    while (this.undoStack.length > 1
      && (this.undoStack.length > UNDO_STEPS || this.undoPoints > UNDO_POINTS)) {
      this.undoPoints -= this.undoStack.shift()!.points;
    }
    this.redoStack = [];
  }

  /** Apply one action to many points at once — the viewer's
   *  path. `groups` lists each node's point indices. One undo step.
   *  Returns the number of points edited. */
  applyAction(groups: Iterable<readonly [NodeKey, ArrayLike<number>]>, action: PatchAction, meta?: unknown): number {
    const segments: UndoSegment[] = [];
    let points = 0;
    for (const [key, idxs] of groups) {
      if (idxs.length === 0) continue;
      const pts = sortedUnique(idxs);
      const seg: UndoSegment = { key, points: pts, action: { ...action }, had: new Uint8Array(pts.length), prev: null };
      this.forward(seg, true);
      segments.push(seg);
      points += pts.length;
    }
    if (segments.length === 0) return 0;
    this.pushUndo({ segments, meta, points });
    this._dirty = true;
    this._version++;
    return points;
  }

  /** Apply a batch of edits, push one undo entry covering all of them.
   *  `meta` is an opaque payload returned by the undo()/redo() that
   *  rewinds/replays this batch (see UndoBatch). Edits run in order: a
   *  run of edits to one node with the same action becomes one segment,
   *  and a point seen again starts the next. */
  applyEdits(edits: PatchEdit[], meta?: unknown): void {
    if (edits.length === 0) return;
    const segments: UndoSegment[] = [];
    let key: NodeKey | null = null;
    let sig = '';
    let action: PatchAction = {};
    let pts: number[] = [];
    let seen = new Set<number>();
    const flush = (): void => {
      if (key === null || pts.length === 0) return;
      const points = sortedUnique(pts);
      const seg: UndoSegment = { key, points, action, had: new Uint8Array(points.length), prev: null };
      this.forward(seg, true);
      segments.push(seg);
    };
    for (const ed of edits) {
      const k = nodeKey(ed.tile, ed.record);
      const a: PatchAction = {
        treeId: ed.treeId, semantic: ed.semantic, deleted: ed.deleted,
        standingDeadwood: ed.standingDeadwood, layingDeadwood: ed.layingDeadwood,
      };
      const s = `${a.treeId}|${a.semantic}|${a.deleted}|${a.standingDeadwood}|${a.layingDeadwood}`;
      if (k !== key || s !== sig || seen.has(ed.pointIdx)) {
        flush();
        key = k; sig = s; action = a; pts = []; seen = new Set();
      }
      pts.push(ed.pointIdx);
      seen.add(ed.pointIdx);
    }
    flush();
    this.pushUndo({ segments, meta, points: edits.length });
    this._dirty = true;
    this._version++;
  }

  /** Rewind one batch. `meta` is whatever the corresponding applyEdits
   *  attached (the viewer's selection snapshot) so the caller can
   *  restore context alongside the data change. Segments rewind in
   *  reverse: each one's `prev` is the state before ITS OWN step, so a
   *  batch that touched a point twice must undo the second first. */
  undo(): { ok: boolean; meta?: unknown } {
    const batch = this.undoStack.pop();
    if (!batch) return { ok: false };
    this.undoPoints -= batch.points;
    for (let i = batch.segments.length - 1; i >= 0; i--) this.backward(batch.segments[i]);
    this.redoStack.push(batch);
    this._dirty = true;
    this._version++;
    return { ok: true, meta: batch.meta };
  }

  redo(): { ok: boolean; meta?: unknown } {
    const batch = this.redoStack.pop();
    if (!batch) return { ok: false };
    for (const seg of batch.segments) this.forward(seg, false);
    this.undoStack.push(batch);
    this.undoPoints += batch.points;
    this._dirty = true;
    this._version++;
    return { ok: true, meta: batch.meta };
  }

  /** Mark the in-memory state matched by an external save. */
  markClean(): void { this._dirty = false; }
}
