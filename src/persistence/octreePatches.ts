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
//              u8 semantic (0 unchanged · 1 stem · 2 branch · 3 cleared),
//              u8 deleted  (0 unchanged · 1 hide · 2 unhide),
//              u16 reserved
//   record[] (v2, 32 B): ...all of v1 (24 B)... then
//              i32 standingDeadwood (-1 = unchanged · 0 clears · >0 sets id),
//              i32 layingDeadwood   (same semantics)
//
// v1 buffers still load (the deadwood fields default to -1 = unchanged);
// every save writes v2 so deadwood overrides round-trip. In-memory we
// keep one Map keyed by `${tile}:${record}` so a node load only touches
// its own patches.

export interface PatchEntry {
  /** Point index inside the node's block (0..numPoints). */
  pointIdx: number;
  /** −1 = unchanged. */
  treeId: number;
  /** 0 unchanged · 1 stem · 2 branch · 3 cleared (set back to none). */
  semantic: 0 | 1 | 2 | 3;
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
    const semantic = dv.getUint8(o + 16) as 0 | 1 | 2 | 3;
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

/** Encode the patches map into a flat buffer matching the on-disk
 *  format (always v2). Empty maps still emit the header so the Rust
 *  writer always sees a valid TROP file.
 *
 *  savePatches() below does NOT call this — it streams the same
 *  per-record encoding straight into bounded IPC chunks so a save never
 *  allocates one buffer sized to the whole patch set. This stays around
 *  for anything that wants the whole thing in memory at once (tests,
 *  other one-shot callers). */
export function serialize(patches: Map<NodeKey, PatchEntry[]>): Uint8Array {
  let total = 0;
  for (const list of patches.values()) total += list.length;
  const buf = new Uint8Array(HEADER_BYTES + total * REC_BYTES_V2);
  buf.set(MAGIC, 0);
  const dv = new DataView(buf.buffer);
  dv.setUint32(4, VERSION, true);
  let off = HEADER_BYTES;
  for (const [key, list] of patches) {
    const sep = key.indexOf(':');
    const tile = parseInt(key.slice(0, sep), 10);
    const record = parseInt(key.slice(sep + 1), 10);
    for (const e of list) {
      dv.setUint16(off, tile, true);
      // bytes off+2..off+4 reserved (0)
      dv.setUint32(off + 4, record, true);
      dv.setUint32(off + 8, e.pointIdx, true);
      dv.setInt32(off + 12, e.treeId, true);
      dv.setUint8(off + 16, e.semantic);
      dv.setUint8(off + 17, e.deleted);
      // bytes off+18..off+20 reserved (0)
      dv.setInt32(off + 20, e.standingDeadwood, true);
      dv.setInt32(off + 24, e.layingDeadwood, true);
      // bytes off+28..off+32 reserved (0)
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
  entries: PatchEntry[] | undefined,
  /** Editable standing- / laying-deadwood id arrays (parallel to treeIds).
   *  Null when the dataset doesn't carry the channel. A patch with the
   *  field ≥ 0 overrides; -1 leaves it. */
  standingDeadwood: Int32Array | null = null,
  layingDeadwood: Int32Array | null = null,
): void {
  if (!entries) return;
  for (const e of entries) {
    if (e.pointIdx >= treeIds.length) continue;
    if (e.treeId >= 0) treeIds[e.pointIdx] = e.treeId;
    if (semantic && e.semantic !== 0) {
      semantic[e.pointIdx] = e.semantic === 3 ? 0 : e.semantic;
    }
    if (standingDeadwood && e.standingDeadwood >= 0) standingDeadwood[e.pointIdx] = e.standingDeadwood;
    if (layingDeadwood && e.layingDeadwood >= 0) layingDeadwood[e.pointIdx] = e.layingDeadwood;
    if (e.deleted !== 0) {
      if (deleted) deleted[e.pointIdx] = e.deleted === 1 ? 1 : 0;
      if (e.deleted === 1) {
        // Hide — NaN out the position so the GPU skips it.
        positions[e.pointIdx * 3] = NaN;
        positions[e.pointIdx * 3 + 1] = NaN;
        positions[e.pointIdx * 3 + 2] = NaN;
      } else if (e.deleted === 2) {
        // Unhide — restore the cached original position.
        positions[e.pointIdx * 3] = originalPositions[e.pointIdx * 3];
        positions[e.pointIdx * 3 + 1] = originalPositions[e.pointIdx * 3 + 1];
        positions[e.pointIdx * 3 + 2] = originalPositions[e.pointIdx * 3 + 2];
      }
    }
  }
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

export async function loadPatches(octreeDir: string): Promise<Map<NodeKey, PatchEntry[]>> {
  const a = api();
  if (!a?.octreeReadPatches) return new Map();
  const bytes = await a.octreeReadPatches(octreeDir);
  return deserialize(bytes);
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
  patches: Map<NodeKey, PatchEntry[]>,
): Promise<number> {
  const a = api();
  if (!a?.octreeWritePatchesBegin || !a.octreeWritePatchesChunk || !a.octreeWritePatchesCommit) {
    throw new Error('Octree patches IO unavailable.');
  }
  await a.octreeWritePatchesBegin(octreeDir);
  // One reusable buffer, refilled and resent every time it fills up —
  // save-time memory stays bounded by CHUNK_RECORDS no matter how many
  // edits have accumulated. Per-record layout matches serialize() byte
  // for byte, so patches.bin is unchanged by this transport rewrite.
  // A fresh buffer per chunk (not one reused across sends): the bridge hands
  // the chunk's ArrayBuffer straight to Tauri's IPC, and we must not assume
  // whether that call leaves the source buffer usable — reusing it could
  // detach it mid-save and break the very save this fix protects. One live
  // 6.4 MB chunk at a time keeps peak memory bounded regardless.
  let chunk = new Uint8Array(CHUNK_RECORDS * REC_BYTES_V2);
  let dv = new DataView(chunk.buffer);
  let filled = 0;
  for (const [key, list] of patches) {
    const sep = key.indexOf(':');
    const tile = parseInt(key.slice(0, sep), 10);
    const record = parseInt(key.slice(sep + 1), 10);
    for (const e of list) {
      const off = filled * REC_BYTES_V2;
      dv.setUint16(off, tile, true);
      // bytes off+2..off+4 reserved (0)
      dv.setUint32(off + 4, record, true);
      dv.setUint32(off + 8, e.pointIdx, true);
      dv.setInt32(off + 12, e.treeId, true);
      dv.setUint8(off + 16, e.semantic);
      dv.setUint8(off + 17, e.deleted);
      // bytes off+18..off+20 reserved (0)
      dv.setInt32(off + 20, e.standingDeadwood, true);
      dv.setInt32(off + 24, e.layingDeadwood, true);
      // bytes off+28..off+32 reserved (0)
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
  semantic?: 0 | 1 | 2 | 3;
  deleted?: 0 | 1 | 2;
  /** Standing-deadwood id: ≥0 sets (0 clears the label), unset = leave. */
  standingDeadwood?: number;
  /** Laying-deadwood id (same semantics). */
  layingDeadwood?: number;
}

interface UndoEntry {
  /** Previous patch entry (or null if the point had no patch before). */
  prev: PatchEntry | null;
  /** Next patch entry written by the edit (or null if removed). */
  next: PatchEntry | null;
  key: NodeKey;
  pointIdx: number;
}

/** One undo/redo step: the per-point entries plus an opaque payload the
 *  caller attached to the batch (the viewer stores the selection that
 *  produced the edit, so undoing a wrong-button apply restores the
 *  points as still-selected instead of dumping the user's hand-picked
 *  set). The store never interprets `meta` — it just rides along. */
interface UndoBatch {
  entries: UndoEntry[];
  meta?: unknown;
}

export class PatchStore {
  readonly map: Map<NodeKey, PatchEntry[]> = new Map();
  /** pointIdx → position in map.get(key), kept in lock-step with `map`
   *  so touchPoint doesn't have to linear-scan a node's list to find an
   *  existing entry. A big-tree correction can touch hundreds of
   *  thousands of points in one brush stroke; without this index every
   *  one of those touches rescanned the whole (ever-growing) list, so a
   *  bulk correction was O(n²) and could hang the UI for minutes. */
  private readonly pointIndex: Map<NodeKey, Map<number, number>> = new Map();
  /** Per-batch undo entries. applyEdits pushes a single batch so the
   *  whole brush stroke undoes in one keystroke. */
  private undoStack: UndoBatch[] = [];
  private redoStack: UndoBatch[] = [];
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

  /** Get-or-create a node's pointIdx → array-position index. Only call
   *  from a write path (about to add/move an entry) — pure lookups use
   *  `this.pointIndex.get(key)?.get(pointIdx)` directly so a probe on a
   *  key with no entries doesn't leave a stray empty Map behind. */
  private indexFor(key: NodeKey): Map<number, number> {
    let idx = this.pointIndex.get(key);
    if (!idx) { idx = new Map(); this.pointIndex.set(key, idx); }
    return idx;
  }

  /** Rebuild one node's index from its current list. Used after a
   *  splice shifts every later entry's array position — splices are
   *  rare (bulk column-reset) next to the add/mutate traffic a
   *  correction hammers, so an O(list.length) rebuild here doesn't
   *  reintroduce the O(n²) cost touchPoint used to have. */
  private reindex(key: NodeKey, list: PatchEntry[]): void {
    const idx = this.indexFor(key);
    idx.clear();
    for (let i = 0; i < list.length; i++) idx.set(list[i].pointIdx, i);
  }

  /** O(1) removal of `list[idx]` for `key`: swap the last entry into
   *  the freed slot and fix up just the two affected index entries,
   *  instead of Array.splice's O(n) shift (which would put the O(n²)
   *  cost right back for an undo/redo that removes many points from a
   *  large node list). Reorders the node's list — nothing reads that
   *  order for meaning; save + apply both key entries by pointIdx and
   *  a node holds at most one entry per point. */
  private removeAt(key: NodeKey, list: PatchEntry[], idx: number): void {
    const idxMap = this.indexFor(key);
    const removedPointIdx = list[idx].pointIdx;
    const last = list.length - 1;
    if (idx !== last) {
      const moved = list[last];
      list[idx] = moved;
      idxMap.set(moved.pointIdx, idx);
    }
    list.pop();
    idxMap.delete(removedPointIdx);
    if (list.length === 0) { this.map.delete(key); this.pointIndex.delete(key); }
  }

  loadFrom(map: Map<NodeKey, PatchEntry[]>): void {
    this.map.clear();
    this.pointIndex.clear();
    for (const [k, v] of map) {
      const list = v.slice();
      this.map.set(k, list);
      this.reindex(k, list);
    }
    this.undoStack = [];
    this.redoStack = [];
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
    for (const [key, list] of this.map) {
      let removed = false;
      // Reverse iteration + splice so removing entry i never disturbs
      // the not-yet-visited indices below it — swap-remove would skip
      // whichever entry gets swapped into a slot we've already passed.
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (attr === 'tree_id' && e.treeId !== -1) { e.treeId = -1; cleared++; }
        else if (attr === 'semantic' && e.semantic !== 0) { e.semantic = 0; cleared++; }
        else if (attr === 'standing_deadwood' && e.standingDeadwood !== -1) { e.standingDeadwood = -1; cleared++; }
        else if (attr === 'laying_deadwood' && e.layingDeadwood !== -1) { e.layingDeadwood = -1; cleared++; }
        // Drop entries that no longer carry any change.
        if (e.treeId === -1 && e.semantic === 0 && e.deleted === 0
            && e.standingDeadwood === -1 && e.layingDeadwood === -1) { list.splice(i, 1); removed = true; }
      }
      if (list.length === 0) { this.map.delete(key); this.pointIndex.delete(key); }
      else if (removed) this.reindex(key, list);
    }
    this.undoStack = [];
    this.redoStack = [];
    this._touched = 'all';
    this._dirty = true;
    this._version++;
    return cleared;
  }

  /** Resolve / merge a single point's patch. Returns the undo entry. */
  private touchPoint(tile: number, record: number, pointIdx: number, mutate: (e: PatchEntry) => void): UndoEntry {
    const key = nodeKey(tile, record);
    this.markTouched(key);
    let list = this.map.get(key);
    if (!list) { list = []; this.map.set(key, list); }
    // Find existing entry for this point, or create one — O(1) via the
    // index instead of a linear scan of the node's list.
    let idx = this.pointIndex.get(key)?.get(pointIdx);
    const prev: PatchEntry | null = idx !== undefined ? { ...list[idx] } : null;
    if (idx === undefined) {
      list.push({ pointIdx, treeId: -1, semantic: 0, deleted: 0, standingDeadwood: -1, layingDeadwood: -1 });
      idx = list.length - 1;
      this.indexFor(key).set(pointIdx, idx);
    }
    mutate(list[idx]);
    // If the entry has no actual change, drop it to keep the file small.
    const e = list[idx];
    if (e.treeId === -1 && e.semantic === 0 && e.deleted === 0
        && e.standingDeadwood === -1 && e.layingDeadwood === -1) {
      this.removeAt(key, list, idx);
      return { prev, next: null, key, pointIdx };
    }
    return { prev, next: { ...e }, key, pointIdx };
  }

  /** Apply a batch of edits, push one undo entry covering all of them.
   *  `meta` is an opaque payload returned by the undo()/redo() that
   *  rewinds/replays this batch (see UndoBatch). */
  applyEdits(edits: PatchEdit[], meta?: unknown): void {
    if (edits.length === 0) return;
    const batch: UndoEntry[] = [];
    for (const ed of edits) {
      batch.push(this.touchPoint(ed.tile, ed.record, ed.pointIdx, (e) => {
        if (ed.treeId !== undefined) e.treeId = ed.treeId;
        if (ed.semantic !== undefined) e.semantic = ed.semantic;
        if (ed.deleted !== undefined) e.deleted = ed.deleted;
        if (ed.standingDeadwood !== undefined) e.standingDeadwood = ed.standingDeadwood;
        if (ed.layingDeadwood !== undefined) e.layingDeadwood = ed.layingDeadwood;
      }));
    }
    this.undoStack.push({ entries: batch, meta });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this._dirty = true;
    this._version++;
  }

  private applyUndoBatch(batch: UndoEntry[], directionPrev: boolean): void {
    // Rewind in reverse, replay forward. Each undo entry's `prev` is the
    // state before ITS OWN touch, so if a batch touched one point twice
    // the entries read (null → A) and (A → B). Rewinding them in order
    // removes the entry and then puts A back — the undone edit survives,
    // and the store now disagrees with what the user sees. Reverse order
    // restores A and then removes it, which is the state before the
    // batch.
    //
    // The viewer's own path can't produce a repeated point (its
    // selection is a Set per node), so this was latent rather than
    // live — but an undo stack whose correctness depends on the caller
    // never repeating itself is one call site away from silently keeping
    // an edit the user cancelled.
    const step = directionPrev ? -1 : 1;
    const start = directionPrev ? batch.length - 1 : 0;
    for (let i = start; i >= 0 && i < batch.length; i += step) {
      const u = batch[i];
      this.markTouched(u.key);
      const list = this.map.get(u.key) ?? [];
      const target = directionPrev ? u.prev : u.next;
      const idx = this.pointIndex.get(u.key)?.get(u.pointIdx);
      if (target) {
        if (idx !== undefined) {
          list[idx] = { ...target };
        } else {
          list.push({ ...target });
          this.indexFor(u.key).set(u.pointIdx, list.length - 1);
          this.map.set(u.key, list);
        }
      } else if (idx !== undefined) {
        this.removeAt(u.key, list, idx);
      }
    }
    this._dirty = true;
    this._version++;
  }

  /** Rewind one batch. `meta` is whatever the corresponding applyEdits
   *  attached (the viewer's selection snapshot) so the caller can
   *  restore context alongside the data change. */
  undo(): { ok: boolean; meta?: unknown } {
    const batch = this.undoStack.pop();
    if (!batch) return { ok: false };
    this.applyUndoBatch(batch.entries, true);
    this.redoStack.push(batch);
    return { ok: true, meta: batch.meta };
  }

  redo(): { ok: boolean; meta?: unknown } {
    const batch = this.redoStack.pop();
    if (!batch) return { ok: false };
    this.applyUndoBatch(batch.entries, false);
    this.undoStack.push(batch);
    return { ok: true, meta: batch.meta };
  }

  /** Mark the in-memory state matched by an external save. */
  markClean(): void { this._dirty = false; }
}
