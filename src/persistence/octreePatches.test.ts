import { describe, it, expect, afterEach } from 'vitest';
import {
  serialize, deserialize, applyToNode, nodeKey, savePatches,
  PatchStore, type PatchEntry, type NodeKey,
} from './octreePatches';

const HEADER = 8;
const REC_V1 = 24;
const REC_V2 = 32;

function entry(p: Partial<PatchEntry> & { pointIdx: number }): PatchEntry {
  return {
    treeId: -1, semantic: 0, deleted: 0,
    standingDeadwood: -1, layingDeadwood: -1,
    ...p,
  };
}

/** A v1 (24 B/record) buffer, the format that shipped before the
 *  deadwood overrides existed. Real files in the wild are this. */
function v1Buffer(recs: Array<{ tile: number; record: number; point: number; treeId: number; semantic: number; deleted: number }>): ArrayBuffer {
  const buf = new Uint8Array(HEADER + recs.length * REC_V1);
  buf.set([0x54, 0x52, 0x4f, 0x50], 0);
  const dv = new DataView(buf.buffer);
  dv.setUint32(4, 1, true);
  recs.forEach((r, i) => {
    const o = HEADER + i * REC_V1;
    dv.setUint16(o, r.tile, true);
    dv.setUint32(o + 4, r.record, true);
    dv.setUint32(o + 8, r.point, true);
    dv.setInt32(o + 12, r.treeId, true);
    dv.setUint8(o + 16, r.semantic);
    dv.setUint8(o + 17, r.deleted);
  });
  return buf.buffer;
}

/** patches.bin is the ONLY record of a user's manual corrections — the
 *  converter writes octree.bin once and never touches it again. A
 *  round-trip that loses a field loses hours of hand work with nothing
 *  on screen to say so. */
describe('patches.bin round-trip', () => {
  it('carries every field through serialize → deserialize', () => {
    const src = new Map<NodeKey, PatchEntry[]>([
      [nodeKey(3, 17), [
        entry({ pointIdx: 0, treeId: 42 }),
        entry({ pointIdx: 9, semantic: 2 }),
        entry({ pointIdx: 12, deleted: 1 }),
        entry({ pointIdx: 40, standingDeadwood: 7 }),
        entry({ pointIdx: 41, layingDeadwood: 8 }),
        entry({ pointIdx: 99, treeId: 5, semantic: 1, deleted: 2, standingDeadwood: 0, layingDeadwood: 3 }),
      ]],
      [nodeKey(511, 4_000_000), [entry({ pointIdx: 3_000_000, treeId: 2_000_000 })]],
    ]);
    const back = deserialize(serialize(src).buffer as ArrayBuffer);
    expect(back).toEqual(src);
  });

  it('preserves the sentinels that mean "unchanged"', () => {
    // −1 for the id fields and 0 for semantic are "leave it alone", not
    // "set it to −1" — confusing the two would silently rewrite every
    // point a patch merely touched.
    const src = new Map<NodeKey, PatchEntry[]>([
      [nodeKey(0, 0), [entry({ pointIdx: 1, deleted: 1 })]],
    ]);
    const e = deserialize(serialize(src).buffer as ArrayBuffer).get(nodeKey(0, 0))![0];
    expect(e.treeId).toBe(-1);
    expect(e.semantic).toBe(0);
    expect(e.standingDeadwood).toBe(-1);
    expect(e.layingDeadwood).toBe(-1);
  });

  it('emits a valid header for an empty map', () => {
    const bytes = serialize(new Map());
    expect(bytes.length).toBe(HEADER);
    expect([...bytes.slice(0, 4)]).toEqual([0x54, 0x52, 0x4f, 0x50]);
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(2);
    expect(deserialize(bytes.buffer as ArrayBuffer).size).toBe(0);
  });

  it('writes 32-byte v2 records', () => {
    const src = new Map<NodeKey, PatchEntry[]>([[nodeKey(1, 1), [entry({ pointIdx: 0, treeId: 1 })]]]);
    expect(serialize(src).length).toBe(HEADER + REC_V2);
  });

  /** An octree with no edits yet: the Rust reader returns an empty body
   *  rather than a header, and that must not read as corruption. */
  it('treats an empty buffer as no edits', () => {
    expect(deserialize(new ArrayBuffer(0)).size).toBe(0);
  });
});

describe('patches.bin v1 compatibility', () => {
  it('still loads a pre-deadwood file, with the new fields unset', () => {
    const buf = v1Buffer([
      { tile: 2, record: 5, point: 11, treeId: 77, semantic: 1, deleted: 0 },
      { tile: 2, record: 5, point: 12, treeId: -1, semantic: 0, deleted: 1 },
    ]);
    const m = deserialize(buf);
    const list = m.get(nodeKey(2, 5))!;
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(entry({ pointIdx: 11, treeId: 77, semantic: 1 }));
    expect(list[1]).toEqual(entry({ pointIdx: 12, deleted: 1 }));
  });

  /** Loading v1 and saving writes v2, so an old file upgrades in place
   *  the first time the user saves — without inventing deadwood labels. */
  it('upgrades to v2 on the next save without changing what it says', () => {
    const m = deserialize(v1Buffer([{ tile: 1, record: 2, point: 3, treeId: 9, semantic: 2, deleted: 0 }]));
    const bytes = serialize(m);
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(2);
    expect(deserialize(bytes.buffer as ArrayBuffer)).toEqual(m);
  });
});

/** A truncated or foreign file must fail loudly. Silently reading it as
 *  "no edits" would let a save overwrite the real patches.bin with an
 *  empty one — the user's corrections gone, no error shown. */
describe('patches.bin refuses a file it cannot read', () => {
  it('rejects a missing magic', () => {
    const b = new Uint8Array(HEADER);
    expect(() => deserialize(b.buffer as ArrayBuffer)).toThrow(/TROP/);
  });

  it('rejects a truncated header', () => {
    const b = new Uint8Array([0x54, 0x52, 0x4f, 0x50, 2]);
    expect(() => deserialize(b.buffer as ArrayBuffer)).toThrow(/too short/);
  });

  it('rejects a future version rather than misreading its records', () => {
    const b = new Uint8Array(HEADER);
    b.set([0x54, 0x52, 0x4f, 0x50], 0);
    new DataView(b.buffer).setUint32(4, 3, true);
    expect(() => deserialize(b.buffer as ArrayBuffer)).toThrow(/unsupported patches version 3/);
  });

  it('rejects a body that is not a whole number of records', () => {
    const good = serialize(new Map([[nodeKey(1, 1), [entry({ pointIdx: 0, treeId: 1 })]]]));
    const cut = good.slice(0, good.length - 4);
    expect(() => deserialize(cut.buffer as ArrayBuffer)).toThrow(/not a multiple of 32/);
  });
});

/** savePatches does NOT call serialize(). It streams the same per-record
 *  layout straight into bounded IPC chunks, because one buffer sized to
 *  the whole cumulative patch set was enough — on top of an already-huge
 *  loaded scene — to push WebView2 over its memory ceiling and kill the
 *  app mid-save.
 *
 *  So the two encoders are the same bytes written twice, in two places,
 *  and nothing checked that they agree. A drift between them is silent:
 *  saving would produce a file that loads without error and says
 *  something else. */
describe('savePatches streams the same bytes serialize() writes', () => {
  const CHUNK_RECORDS = 200_000;

  function stubBridge() {
    const chunks: Uint8Array[] = [];
    let begun = 0, committed = 0;
    (globalThis as Record<string, unknown>).window = {
      desktop: {
        octreeReadPatches: async () => new ArrayBuffer(0),
        octreeWritePatchesBegin: async () => { begun++; },
        // Copy: the real bridge hands the buffer to IPC, so a test that
        // kept the reference could not tell a reused buffer from a fresh
        // one — which is exactly the bug the comment there guards.
        octreeWritePatchesChunk: async (_d: string, b: Uint8Array) => { chunks.push(b.slice()); },
        octreeWritePatchesCommit: async () => { committed++; return chunks.reduce((a, c) => a + c.length, 0); },
      },
    };
    return { chunks, counts: () => ({ begun, committed }) };
  }

  afterEach(() => { delete (globalThis as Record<string, unknown>).window; });

  function bigMap(n: number): Map<NodeKey, PatchEntry[]> {
    const m = new Map<NodeKey, PatchEntry[]>();
    // Several nodes, so the chunk boundary falls inside a node's list
    // rather than conveniently between two.
    const perNode = Math.ceil(n / 3);
    for (let node = 0; node < 3; node++) {
      const list: PatchEntry[] = [];
      for (let i = 0; i < perNode && node * perNode + i < n; i++) {
        const g = node * perNode + i;
        list.push(entry({
          pointIdx: g, treeId: g % 7 === 0 ? -1 : g,
          semantic: (g % 4) as 0 | 1 | 2 | 3,
          deleted: (g % 3) as 0 | 1 | 2,
          standingDeadwood: g % 5 === 0 ? -1 : g % 1000,
          layingDeadwood: g % 6 === 0 ? -1 : g % 997,
        }));
      }
      m.set(nodeKey(node, node * 10), list);
    }
    return m;
  }

  it('produces exactly the serialize() body, across a chunk boundary', async () => {
    const { chunks } = stubBridge();
    const patches = bigMap(CHUNK_RECORDS + 1);   // forces a second chunk
    await savePatches('/ds', patches);

    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(CHUNK_RECORDS * REC_V2);
    expect(chunks[1].length).toBe(REC_V2);       // the tail is exact-size

    const streamed = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let o = 0;
    for (const c of chunks) { streamed.set(c, o); o += c.length; }

    const reference = serialize(patches).slice(HEADER);   // Rust writes the header
    expect(streamed.length).toBe(reference.length);
    expect(Buffer.from(streamed).equals(Buffer.from(reference))).toBe(true);
  });

  it('opens and commits the write exactly once', async () => {
    const { counts } = stubBridge();
    await savePatches('/ds', bigMap(10));
    expect(counts()).toEqual({ begun: 1, committed: 1 });
  });

  it('still opens and commits when there is nothing to write', async () => {
    // An empty save is how a user clears every edit. Skipping begin/commit
    // would leave the previous patches.bin in place — the edits come back
    // on reload.
    const { chunks, counts } = stubBridge();
    await savePatches('/ds', new Map());
    expect(chunks).toHaveLength(0);
    expect(counts()).toEqual({ begun: 1, committed: 1 });
  });

  it('refuses clearly when the bridge is missing', async () => {
    (globalThis as Record<string, unknown>).window = { desktop: { octreeReadPatches: async () => new ArrayBuffer(0) } };
    await expect(savePatches('/ds', new Map())).rejects.toThrow(/unavailable/);
  });
});

describe('applyToNode', () => {
  function node(n: number) {
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) positions[i] = i + 1;
    return {
      treeIds: new Int32Array(n),
      semantic: new Uint8Array(n),
      deleted: new Uint8Array(n),
      positions,
      originalPositions: new Float32Array(positions),
      standing: new Int32Array(n),
      laying: new Int32Array(n),
    };
  }
  const apply = (nd: ReturnType<typeof node>, entries: PatchEntry[]) =>
    applyToNode(nd.treeIds, nd.semantic, nd.deleted, nd.positions,
      nd.originalPositions, entries, nd.standing, nd.laying);

  it('assigns a tree id, and treats 0 as "unassign" rather than "skip"', () => {
    const nd = node(4);
    nd.treeIds[1] = 55;
    apply(nd, [entry({ pointIdx: 0, treeId: 9 }), entry({ pointIdx: 1, treeId: 0 })]);
    expect(nd.treeIds[0]).toBe(9);
    expect(nd.treeIds[1]).toBe(0);   // cleared back to unassigned
  });

  it('leaves a point alone when treeId is the −1 sentinel', () => {
    const nd = node(2);
    nd.treeIds[0] = 33;
    apply(nd, [entry({ pointIdx: 0, deleted: 1 })]);
    expect(nd.treeIds[0]).toBe(33);
  });

  it('maps semantic 3 to "no label" and passes 1 and 2 through', () => {
    const nd = node(3);
    nd.semantic[2] = 2;
    apply(nd, [
      entry({ pointIdx: 0, semantic: 1 }),
      entry({ pointIdx: 1, semantic: 2 }),
      entry({ pointIdx: 2, semantic: 3 }),
    ]);
    expect([...nd.semantic]).toEqual([1, 2, 0]);
  });

  it('hides a point by NaN-ing its live position, not its original', () => {
    const nd = node(2);
    apply(nd, [entry({ pointIdx: 1, deleted: 1 })]);
    expect(nd.deleted[1]).toBe(1);
    expect(Number.isNaN(nd.positions[3])).toBe(true);
    // The pristine copy stays finite — node extents and unhide read it.
    expect(nd.originalPositions[3]).toBe(4);
  });

  it('unhides by restoring the original position', () => {
    const nd = node(2);
    apply(nd, [entry({ pointIdx: 1, deleted: 1 })]);
    apply(nd, [entry({ pointIdx: 1, deleted: 2 })]);
    expect(nd.deleted[1]).toBe(0);
    expect([...nd.positions.slice(3, 6)]).toEqual([4, 5, 6]);
  });

  it('sets a deadwood id, and 0 clears the label', () => {
    const nd = node(2);
    nd.standing[1] = 4;
    apply(nd, [entry({ pointIdx: 0, standingDeadwood: 7 }), entry({ pointIdx: 1, standingDeadwood: 0 })]);
    expect(nd.standing[0]).toBe(7);
    expect(nd.standing[1]).toBe(0);
  });

  it('does nothing on a dataset without the deadwood channel', () => {
    const nd = node(2);
    expect(() => applyToNode(
      nd.treeIds, nd.semantic, nd.deleted, nd.positions, nd.originalPositions,
      [entry({ pointIdx: 0, standingDeadwood: 7 })], null, null,
    )).not.toThrow();
  });

  /** A patch whose point index is past the end of the node — a stale
   *  patches.bin after a re-import with different chunking — must be
   *  skipped, not written past the end of the typed array (a silent
   *  no-op on the Int32Array but a real out-of-bounds read on the
   *  Float32Array position triple). */
  it('skips a patch that addresses a point the node does not have', () => {
    const nd = node(2);
    expect(() => apply(nd, [entry({ pointIdx: 99, treeId: 1, deleted: 1 })])).not.toThrow();
    expect([...nd.treeIds]).toEqual([0, 0]);
    expect(nd.positions.every(Number.isFinite)).toBe(true);
  });

  it('is a no-op for a node with no patches', () => {
    const nd = node(2);
    applyToNode(nd.treeIds, nd.semantic, nd.deleted, nd.positions, nd.originalPositions, undefined);
    expect([...nd.treeIds]).toEqual([0, 0]);
  });
});

/** The store's `pointIndex` is a hand-maintained mirror of the position
 *  of each point's entry inside its node's array — added because the
 *  linear scan it replaced made a bulk correction O(n²) and hung the UI.
 *  A mirror that drifts out of step is worse than the scan was: lookups
 *  find the wrong entry, so an edit lands on a point the user never
 *  touched. Nothing about that is visible until they save. */
describe('PatchStore', () => {
  const K = nodeKey(1, 2);
  const edit = (pointIdx: number, patch: Partial<{ treeId: number; semantic: 0 | 1 | 2 | 3; deleted: 0 | 1 | 2 }>) =>
    ({ tile: 1, record: 2, pointIdx, ...patch });

  /** Recompute what pointIndex should be and compare — the invariant the
   *  swap-remove in removeAt() has to preserve. */
  function indexIsConsistent(s: PatchStore): true | string {
    for (const [key, list] of s.map) {
      if (list.length === 0) return `${key} kept an empty list`;
      const seen = new Set<number>();
      for (const e of list) {
        if (seen.has(e.pointIdx)) return `${key} holds two entries for point ${e.pointIdx}`;
        seen.add(e.pointIdx);
      }
    }
    return true;
  }

  it('merges repeated edits to one point into one entry', () => {
    const s = new PatchStore();
    s.applyEdits([edit(5, { treeId: 3 })]);
    s.applyEdits([edit(5, { semantic: 1 })]);
    const list = s.map.get(K)!;
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(entry({ pointIdx: 5, treeId: 3, semantic: 1 }));
  });

  it('drops an entry that no longer changes anything', () => {
    const s = new PatchStore();
    s.applyEdits([edit(5, { treeId: 3 })]);
    expect(s.map.get(K)).toHaveLength(1);
    s.applyEdits([edit(5, { treeId: -1 })]);
    expect(s.map.has(K)).toBe(false);
  });

  it('keeps the point index in step after a swap-remove', () => {
    const s = new PatchStore();
    for (const p of [10, 20, 30, 40]) s.applyEdits([edit(p, { treeId: p })]);
    // Remove the FIRST — removeAt swaps the last entry into slot 0.
    s.applyEdits([edit(10, { treeId: -1 })]);
    expect(indexIsConsistent(s)).toBe(true);
    // Point 40 moved slots; a later edit to it must find it, not create
    // a second entry or land on 20.
    s.applyEdits([edit(40, { semantic: 2 })]);
    expect(s.map.get(K)).toHaveLength(3);
    const e40 = s.map.get(K)!.find(e => e.pointIdx === 40)!;
    expect(e40).toEqual(entry({ pointIdx: 40, treeId: 40, semantic: 2 }));
    const e20 = s.map.get(K)!.find(e => e.pointIdx === 20)!;
    expect(e20.semantic).toBe(0);
  });

  it('undoes a whole brush stroke in one step, and redoes it', () => {
    const s = new PatchStore();
    s.applyEdits([edit(1, { treeId: 7 }), edit(2, { treeId: 7 }), edit(3, { treeId: 7 })]);
    expect(s.map.get(K)).toHaveLength(3);

    expect(s.undo().ok).toBe(true);
    expect(s.map.has(K)).toBe(false);
    expect(indexIsConsistent(s)).toBe(true);

    expect(s.redo().ok).toBe(true);
    expect(s.map.get(K)).toHaveLength(3);
    expect(new Set(s.map.get(K)!.map(e => e.pointIdx))).toEqual(new Set([1, 2, 3]));
  });

  it('undo restores the previous value, not just "no patch"', () => {
    const s = new PatchStore();
    s.applyEdits([edit(1, { treeId: 7 })]);
    s.applyEdits([edit(1, { treeId: 9 })]);
    s.undo();
    expect(s.map.get(K)![0].treeId).toBe(7);
    s.undo();
    expect(s.map.has(K)).toBe(false);
  });

  it('carries the caller\'s snapshot back out of undo and redo', () => {
    const s = new PatchStore();
    s.applyEdits([edit(1, { treeId: 7 })], { selection: [1] });
    expect(s.undo()).toEqual({ ok: true, meta: { selection: [1] } });
    expect(s.redo()).toEqual({ ok: true, meta: { selection: [1] } });
  });

  it('reports failure rather than throwing at the ends of the stack', () => {
    const s = new PatchStore();
    expect(s.undo()).toEqual({ ok: false });
    expect(s.redo()).toEqual({ ok: false });
  });

  it('a new edit drops the redo branch', () => {
    const s = new PatchStore();
    s.applyEdits([edit(1, { treeId: 7 })]);
    s.undo();
    s.applyEdits([edit(2, { treeId: 8 })]);
    expect(s.redo().ok).toBe(false);
  });

  /** Undoing a batch that touched the same point more than once has to
   *  rewind in reverse, or the earlier entry's "restore" re-imposes a
   *  value the later entry's "remove" had just taken away — leaving an
   *  edit behind that the user undid. */
  it('rewinds a batch that touched one point twice', () => {
    const s = new PatchStore();
    s.applyEdits([edit(5, { treeId: 3 }), edit(5, { semantic: 1 })]);
    expect(s.map.get(K)).toHaveLength(1);
    s.undo();
    expect(s.map.has(K)).toBe(false);
    expect(indexIsConsistent(s)).toBe(true);
    s.redo();
    expect(s.map.get(K)![0]).toEqual(entry({ pointIdx: 5, treeId: 3, semantic: 1 }));
  });

  it('tracks dirtiness across load, edit and save', () => {
    const s = new PatchStore();
    expect(s.dirty).toBe(false);
    s.applyEdits([edit(1, { treeId: 7 })]);
    expect(s.dirty).toBe(true);
    s.markClean();
    expect(s.dirty).toBe(false);
    s.undo();
    expect(s.dirty).toBe(true);   // undo is a change too — it must be saved
  });

  it('an empty edit list changes nothing and adds no undo step', () => {
    const s = new PatchStore();
    const v = s.version;
    s.applyEdits([]);
    expect(s.version).toBe(v);
    expect(s.dirty).toBe(false);
    expect(s.undo().ok).toBe(false);
  });

  it('loadFrom replaces the state and starts clean, with no undo history', () => {
    const s = new PatchStore();
    s.applyEdits([edit(1, { treeId: 7 })]);
    s.loadFrom(new Map([[nodeKey(9, 9), [entry({ pointIdx: 2, treeId: 4 })]]]));
    expect(s.map.has(K)).toBe(false);
    expect(s.map.get(nodeKey(9, 9))).toHaveLength(1);
    expect(s.dirty).toBe(false);
    expect(s.undo().ok).toBe(false);
    expect(s.takeTouched()).toBe('all');
  });

  it('loadFrom copies the lists it was handed', () => {
    const src = new Map<NodeKey, PatchEntry[]>([[K, [entry({ pointIdx: 1, treeId: 4 })]]]);
    const s = new PatchStore();
    s.loadFrom(src);
    s.applyEdits([edit(2, { treeId: 5 })]);
    expect(src.get(K)).toHaveLength(1);   // the caller's map is untouched
  });

  it('reports just the nodes an edit touched, then forgets them', () => {
    const s = new PatchStore();
    s.takeTouched();                        // clear the initial 'all'
    s.applyEdits([edit(1, { treeId: 7 })]);
    expect(s.takeTouched()).toEqual(new Set([K]));
    expect(s.takeTouched()).toEqual(new Set());
  });

  describe('clearAttribute', () => {
    function loaded() {
      const s = new PatchStore();
      s.loadFrom(new Map([[K, [
        entry({ pointIdx: 1, treeId: 4 }),
        entry({ pointIdx: 2, treeId: 5, semantic: 1 }),
        entry({ pointIdx: 3, semantic: 2 }),
        entry({ pointIdx: 4, deleted: 1 }),
        entry({ pointIdx: 5, standingDeadwood: 6 }),
      ]]]));
      return s;
    }

    it('strips one column and drops the entries left saying nothing', () => {
      const s = loaded();
      expect(s.clearAttribute('tree_id')).toBe(2);
      const list = s.map.get(K)!;
      // Point 1 carried only a tree id, so its entry is gone.
      expect(list.map(e => e.pointIdx).sort((a, b) => a - b)).toEqual([2, 3, 4, 5]);
      expect(list.every(e => e.treeId === -1)).toBe(true);
      // …and the other columns survived.
      expect(list.find(e => e.pointIdx === 2)!.semantic).toBe(1);
      expect(indexIsConsistent(s)).toBe(true);
    });

    it('leaves the index usable for later edits', () => {
      const s = loaded();
      s.clearAttribute('tree_id');
      s.applyEdits([edit(5, { semantic: 1 })]);
      const e5 = s.map.get(K)!.filter(e => e.pointIdx === 5);
      expect(e5).toHaveLength(1);
      expect(e5[0].standingDeadwood).toBe(6);
      expect(indexIsConsistent(s)).toBe(true);
    });

    it('removes the node entirely when nothing is left', () => {
      const s = new PatchStore();
      s.loadFrom(new Map([[K, [entry({ pointIdx: 1, treeId: 4 })]]]));
      expect(s.clearAttribute('tree_id')).toBe(1);
      expect(s.map.has(K)).toBe(false);
    });

    it('clears each column independently', () => {
      for (const [attr, n] of [
        ['semantic', 2], ['standing_deadwood', 1], ['laying_deadwood', 0],
      ] as const) {
        expect(loaded().clearAttribute(attr), attr).toBe(n);
      }
    });

    it('is not undoable, and says so by clearing the stack', () => {
      const s = loaded();
      s.applyEdits([edit(9, { treeId: 1 })]);
      s.clearAttribute('tree_id');
      expect(s.undo().ok).toBe(false);
      expect(s.dirty).toBe(true);
    });
  });
});
