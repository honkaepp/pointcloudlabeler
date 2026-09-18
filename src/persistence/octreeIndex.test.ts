import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildIndex, indexProblems, NO_RECORD,
  type OctreeMetadata, type OctreeNodeRecord, type OctreeIndex,
} from './octreeReader';

/** The converter's tile depth. A tile root sits at global level 3
 *  because the top-level chunk grid is 8³. Read from the Rust source so
 *  this file cannot drift from it silently. */
const RUST = readFileSync('src-tauri/src/commands/octree.rs', 'utf8');
const TILE_GLOBAL_DEPTH = Number(/const TILE_GLOBAL_DEPTH: u32 = (\d+);/.exec(RUST)![1]);
const GRID_SIZE = Number(/const GRID_SIZE: usize = (\d+);/.exec(RUST)![1]);

// ---------------------------------------------------------------------
// A miniature writer, mirroring src-tauri/src/commands/octree.rs.
//
// Node::insert subdivides with Aabb::child, write_chunk_subtree emits
// its own record then recurses over octants 0..7, and the stitcher
// stores level + TILE_GLOBAL_DEPTH. Building the fixture the writer's
// way — rather than the reader's — is the point: if the two derivations
// ever diverge, this file is what notices.

interface TreeSpec { children: (TreeSpec | null)[] }

const leaf = (): TreeSpec => ({ children: Array(8).fill(null) });
function node(...kids: Array<[number, TreeSpec]>): TreeSpec {
  const children: (TreeSpec | null)[] = Array(8).fill(null);
  for (const [oct, k] of kids) children[oct] = k;
  return { children };
}

type Box = [number, number, number, number, number, number];

/** Aabb::child from octree.rs, transcribed. */
function childBox(b: Box, octant: number): Box {
  const cx = 0.5 * (b[0] + b[3]);
  const cy = 0.5 * (b[1] + b[4]);
  const cz = 0.5 * (b[2] + b[5]);
  return [
    (octant & 1) === 0 ? b[0] : cx,
    (octant & 2) === 0 ? b[1] : cy,
    (octant & 4) === 0 ? b[2] : cz,
    (octant & 1) === 0 ? cx : b[3],
    (octant & 2) === 0 ? cy : b[4],
    (octant & 4) === 0 ? cz : b[5],
  ];
}

interface Expected { rec: number; box: Box; level: number; tile: number; parent: number }

/** write_chunk_subtree: emit self, then recurse octants in order. */
function emit(
  spec: TreeSpec, box: Box, level: number, tile: number, parent: number,
  records: OctreeNodeRecord[], expected: Expected[],
): void {
  let childMask = 0;
  spec.children.forEach((c, i) => { if (c) childMask |= 1 << i; });
  const rec = records.length;
  records.push({
    childMask,
    level: Math.min(255, level + TILE_GLOBAL_DEPTH),
    numPoints: 10 + rec,
    byteOffset: rec * 1000,
    byteSize: 200,
  });
  expected.push({ rec, box, level, tile, parent });
  spec.children.forEach((c, i) => {
    if (c) emit(c, childBox(box, i), level + 1, tile, rec, records, expected);
  });
}

const ROOT_SPACING = 4;

function fixture(tiles: Array<{ spec: TreeSpec; box: Box }>) {
  const records: OctreeNodeRecord[] = [];
  const expected: Expected[] = [];
  const metaTiles = tiles.map((t, i) => {
    const start = records.length;
    emit(t.spec, t.box, 0, i, -1, records, expected);
    return {
      chunkIdx: i,
      bboxMin: [t.box[0], t.box[1], t.box[2]] as [number, number, number],
      bboxMax: [t.box[3], t.box[4], t.box[5]] as [number, number, number],
      recordOffset: start,
      recordCount: records.length - start,
    };
  });
  const meta = {
    rootSpacing: ROOT_SPACING,
    tileGlobalDepth: TILE_GLOBAL_DEPTH,
    tiles: metaTiles,
  } as unknown as OctreeMetadata;
  const starts = metaTiles.map(t => t.recordOffset);
  return { meta, records, expected, starts, index: buildIndex(meta, records, starts) };
}

const CUBE: Box = [0, 0, 0, 8, 8, 8];
const boxOf = (ix: OctreeIndex, rec: number): Box =>
  Array.from(ix.bbox.subarray(rec * 6, rec * 6 + 6)) as Box;

// ---------------------------------------------------------------------

describe('buildIndex reproduces the writer’s walk', () => {
  /** The whole point. Six lines of subdivision arithmetic exist once in
   *  Rust (Aabb::child) and once in TypeScript, and nothing made them
   *  agree. A divergence gives every node below the first difference the
   *  wrong bbox — and because points carry their own coordinates, the
   *  cloud still LOOKS right. Only the frustum culling, the LOD choice
   *  and the eviction go wrong, which the user reads as "slow" and
   *  "that patch never loaded". */
  it('gives every node the box the converter would have given it', () => {
    const deep = node(
      [0, node([3, leaf()], [7, node([1, leaf()])])],
      [5, leaf()],
      [7, node([0, leaf()], [6, leaf()])],
    );
    const f = fixture([{ spec: deep, box: CUBE }]);
    expect(f.expected.length).toBeGreaterThan(6);
    for (const e of f.expected) {
      expect(boxOf(f.index, e.rec), `record ${e.rec}`).toEqual(e.box);
    }
  });

  it('emits records in the writer’s pre-order, octant 0 to 7', () => {
    const f = fixture([{ spec: node([0, leaf()], [4, leaf()], [7, leaf()]), box: CUBE }]);
    // root, then the octant-0, octant-4 and octant-7 children in order.
    expect(f.index.levelOf[0]).toBe(0);
    expect([f.index.levelOf[1], f.index.levelOf[2], f.index.levelOf[3]]).toEqual([1, 1, 1]);
    expect(boxOf(f.index, 1)).toEqual([0, 0, 0, 4, 4, 4]);          // −x −y −z
    expect(boxOf(f.index, 2)).toEqual([0, 0, 4, 4, 4, 8]);          // +z only
    expect(boxOf(f.index, 3)).toEqual([4, 4, 4, 8, 8, 8]);          // +x +y +z
  });

  /** octant = (z>0)<<2 | (y>0)<<1 | (x>0), the encoding in the
   *  hierarchy.bin note and in Node::octant_of. Swap two bits and the
   *  octree is geometrically transposed with nothing to show for it. */
  it('reads bit 0 as x, bit 1 as y, bit 2 as z', () => {
    for (const oct of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const f = fixture([{ spec: node([oct, leaf()]), box: CUBE }]);
      const b = boxOf(f.index, 1);
      expect(b[0] === 4, `octant ${oct} x`).toBe((oct & 1) !== 0);
      expect(b[1] === 4, `octant ${oct} y`).toBe((oct & 2) !== 0);
      expect(b[2] === 4, `octant ${oct} z`).toBe((oct & 4) !== 0);
    }
  });

  it('agrees with the stored level on every record', () => {
    const f = fixture([
      { spec: node([0, node([1, leaf()])], [3, leaf()]), box: CUBE },
      { spec: node([7, leaf()]), box: [8, 8, 8, 16, 16, 16] },
    ]);
    for (let i = 0; i < f.records.length; i++) {
      expect(f.index.levelOf[i] + TILE_GLOBAL_DEPTH, `record ${i}`).toBe(f.records[i].level);
    }
  });

  it('keeps each record with its own tile', () => {
    const f = fixture([
      { spec: node([0, leaf()]), box: CUBE },
      { spec: node([1, leaf()], [2, leaf()]), box: [8, 0, 0, 16, 8, 8] },
      { spec: leaf(), box: [0, 8, 0, 8, 16, 8] },
    ]);
    for (const e of f.expected) expect(f.index.tileOf[e.rec], `record ${e.rec}`).toBe(e.tile);
  });

  it('links every child back to the parent that emitted it', () => {
    const f = fixture([{
      spec: node([0, node([2, leaf()], [5, leaf()])], [6, leaf()]),
      box: CUBE,
    }]);
    for (const e of f.expected) {
      if (e.parent < 0) continue;
      const cs = f.index.childrenStart[e.parent];
      const ce = f.index.childrenStart[e.parent + 1];
      const kids = Array.from(f.index.childrenFlat.subarray(cs, ce));
      expect(kids, `record ${e.rec} under ${e.parent}`).toContain(e.rec);
    }
  });

  it('gives each record exactly as many child slots as its childMask bits', () => {
    const f = fixture([{
      spec: node([0, leaf()], [1, node([3, leaf()])], [7, leaf()]),
      box: CUBE,
    }]);
    for (let i = 0; i < f.records.length; i++) {
      const bits = f.records[i].childMask.toString(2).split('1').length - 1;
      expect(f.index.childrenStart[i + 1] - f.index.childrenStart[i], `record ${i}`).toBe(bits);
    }
  });

  it('handles a tile that is a single leaf', () => {
    const f = fixture([{ spec: leaf(), box: CUBE }]);
    expect(f.index.recordCount).toBe(1);
    expect(f.index.levelOf[0]).toBe(0);
    expect(f.index.childrenStart[1]).toBe(0);
    expect(indexProblems(f.meta, f.records, f.index)).toEqual([]);
  });

  it('handles a dataset with no tiles at all', () => {
    const f = fixture([]);
    expect(f.index.recordCount).toBe(0);
    expect(indexProblems(f.meta, f.records, f.index)).toEqual([]);
  });

  it('fills all eight octants when every child is present', () => {
    const f = fixture([{ spec: node(...[0, 1, 2, 3, 4, 5, 6, 7].map(o => [o, leaf()] as [number, TreeSpec])), box: CUBE }]);
    expect(f.index.recordCount).toBe(9);
    // The eight children tile the parent exactly: total volume matches.
    let vol = 0;
    for (let i = 1; i <= 8; i++) {
      const b = boxOf(f.index, i);
      vol += (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]);
    }
    expect(vol).toBeCloseTo(8 * 8 * 8, 9);
  });
});

describe('centre, radius and spacing', () => {
  it('puts the centre at the middle of the box', () => {
    const f = fixture([{ spec: node([7, leaf()]), box: CUBE }]);
    expect(Array.from(f.index.centre.subarray(0, 3))).toEqual([4, 4, 4]);
    expect(Array.from(f.index.centre.subarray(3, 6))).toEqual([6, 6, 6]);
  });

  /** The bounding sphere must CONTAIN the box. Tile boxes are cubes
   *  (Aabb::cube_around), so sqrt(3)/2 · side is exact; for anything
   *  non-cubic it over-estimates, which is the safe direction. Tighten
   *  it to side/2 — an inviting "optimisation" — and node corners fall
   *  outside the sphere, so the frustum test culls nodes that are
   *  genuinely on screen and they simply never load. */
  it('always encloses the node box', () => {
    const boxes: Box[] = [CUBE, [0, 0, 0, 8, 2, 40], [-3, -3, -3, 3, 3, 3], [0, 0, 0, 1, 1, 1]];
    for (const box of boxes) {
      const f = fixture([{ spec: leaf(), box }]);
      const half = [(box[3] - box[0]) / 2, (box[4] - box[1]) / 2, (box[5] - box[2]) / 2];
      const corner = Math.hypot(half[0], half[1], half[2]);
      expect(f.index.radius[0], `box ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(corner - 1e-12);
    }
  });

  it('is exact for a cube, which is what the converter writes', () => {
    const f = fixture([{ spec: leaf(), box: CUBE }]);
    expect(f.index.radius[0]).toBeCloseTo(Math.sqrt(3) * 4, 12);
  });

  it('shrinks the sphere with each level', () => {
    const f = fixture([{ spec: node([0, node([0, leaf()])]), box: CUBE }]);
    expect(f.index.radius[1]).toBeCloseTo(f.index.radius[0] / 2, 12);
    expect(f.index.radius[2]).toBeCloseTo(f.index.radius[0] / 4, 12);
  });

  /** Spacing drives the point size the shader draws. The writer sets
   *  Node::new's spacing to root_spacing / 2^level with the tile root at
   *  root_spacing / 2^TILE_GLOBAL_DEPTH; the reader must land on the
   *  same numbers or points are drawn at the wrong scale for their
   *  level — a cloud that looks too sparse or too clotted, with nothing
   *  saying which. */
  it('halves with each level, from the tile root spacing', () => {
    const f = fixture([{ spec: node([0, node([0, node([0, leaf()])])]), box: CUBE }]);
    const tileRoot = ROOT_SPACING / (1 << TILE_GLOBAL_DEPTH);
    expect(f.index.spacing[0]).toBeCloseTo(tileRoot, 12);
    expect(f.index.spacing[1]).toBeCloseTo(tileRoot / 2, 12);
    expect(f.index.spacing[2]).toBeCloseTo(tileRoot / 4, 12);
    expect(f.index.spacing[3]).toBeCloseTo(tileRoot / 8, 12);
  });

  it('uses the grid size the converter uses', () => {
    // The tile depth is log2 of the chunk grid: 8³ tiles, depth 3.
    expect(1 << TILE_GLOBAL_DEPTH).toBe(GRID_SIZE);
  });
});

describe('indexProblems', () => {
  const healthy = () => fixture([
    { spec: node([0, node([4, leaf()])], [6, leaf()]), box: CUBE },
    { spec: node([1, leaf()]), box: [8, 0, 0, 16, 8, 8] },
  ]);

  it('says nothing about a healthy index', () => {
    const f = healthy();
    expect(indexProblems(f.meta, f.records, f.index)).toEqual([]);
  });

  /** A hierarchy whose childMask tree describes more nodes than the
   *  tile's recordCount admits: the walk stops at the tile boundary and
   *  the trailing records are never touched. They keep no bbox, so they
   *  are invisible to the planner and their points never load — and the
   *  rest of the cloud renders perfectly. */
  it('reports records the walk never reached', () => {
    const f = healthy();
    const truncated = f.meta.tiles.map((t, i) =>
      i === 0 ? { ...t, recordCount: t.recordCount - 2 } : t);
    const meta = { ...f.meta, tiles: truncated } as OctreeMetadata;
    const idx = buildIndex(meta, f.records, f.starts);
    const probs = indexProblems(meta, f.records, idx);
    expect(probs.join('\n')).toMatch(/never reached by the tile walk/);
  });

  /** The reader's walk and the writer's disagreeing is the failure this
   *  module cannot otherwise notice, and the file carries the answer:
   *  every record stores the depth the writer put it at. Nothing read
   *  it until now. */
  it('reports a depth the writer disagrees with', () => {
    const f = healthy();
    const bent = f.records.map((r, i) => i === 2 ? { ...r, level: r.level + 1 } : r);
    const probs = indexProblems(f.meta, bent, f.index);
    expect(probs.join('\n')).toMatch(/different depth than the writer recorded/);
    expect(probs.join('\n')).toContain('record 2');
  });

  it('names how many records are wrong, not just that some are', () => {
    const f = healthy();
    const bent = f.records.map(r => ({ ...r, level: r.level + 7 }));
    const probs = indexProblems(f.meta, bent, f.index);
    expect(probs.join('\n')).toContain(`${f.records.length} of ${f.records.length}`);
  });

  /** The writer caps the stored level at 255, so a tree deeper than that
   *  saturates and stops being comparable. That is the format's limit,
   *  not a defect, and must not be reported as one. */
  it('does not report a saturated stored level as a mismatch', () => {
    const f = healthy();
    const saturated = f.records.map(r => ({ ...r, level: 255 }));
    expect(indexProblems(f.meta, saturated, f.index)).toEqual([]);
  });

  it('reports an unfilled child slot', () => {
    const f = healthy();
    const idx = { ...f.index, childrenFlat: Int32Array.from(f.index.childrenFlat) };
    idx.childrenFlat[0] = NO_RECORD;
    expect(indexProblems(f.meta, f.records, idx).join('\n')).toMatch(/child slots were never filled/);
  });

  it('reports a child slot pointing past the record array', () => {
    const f = healthy();
    const idx = { ...f.index, childrenFlat: Int32Array.from(f.index.childrenFlat) };
    idx.childrenFlat[0] = 9999;
    expect(indexProblems(f.meta, f.records, idx).join('\n')).toMatch(/outside the record array/);
  });

  it('reports a record assigned to a tile that does not exist', () => {
    const f = healthy();
    const idx = { ...f.index, tileOf: Int32Array.from(f.index.tileOf) };
    idx.tileOf[1] = 42;
    expect(indexProblems(f.meta, f.records, idx).join('\n')).toMatch(/does not exist/);
  });

  it('survives metadata with no tiles array', () => {
    const f = healthy();
    const meta = { ...f.meta, tiles: undefined } as unknown as OctreeMetadata;
    expect(() => indexProblems(meta, f.records, f.index)).not.toThrow();
  });
});

describe('NO_RECORD', () => {
  /** Zero is a real record — tile 0's root. Leaving unwritten slots at
   *  0 makes a truncated walk claim the first tile root as somebody's
   *  child: the LOD tree is wrong, the points still draw from their own
   *  coordinates, and nothing looks broken. */
  it('is not a usable record index', () => {
    expect(NO_RECORD).toBeLessThan(0);
  });

  it('marks the slots a truncated walk leaves behind', () => {
    const f = fixture([{ spec: node([0, leaf()], [1, leaf()], [2, leaf()]), box: CUBE }]);
    const truncated = [{ ...f.meta.tiles[0], recordCount: 2 }];
    const meta = { ...f.meta, tiles: truncated } as OctreeMetadata;
    const idx = buildIndex(meta, f.records, f.starts);
    // Records 2 and 3 were never walked.
    expect(idx.levelOf[2]).toBe(NO_RECORD);
    expect(idx.levelOf[3]).toBe(NO_RECORD);
    expect(idx.tileOf[2]).toBe(NO_RECORD);
    // …and the root's unfilled child slots say so rather than naming
    // record 0, which would be the root itself.
    const kids = Array.from(idx.childrenFlat.subarray(idx.childrenStart[0], idx.childrenStart[1]));
    expect(kids).toContain(NO_RECORD);
    expect(kids).not.toContain(0);
  });
});

/** The reader's octant arithmetic and the converter's must match, and
 *  they are six lines each in two languages. This reads the Rust source
 *  and checks the shape is still what the fixture above transcribes —
 *  cheap insurance that the fixture is testing today's writer and not
 *  the one that existed when it was written. */
describe('the converter still subdivides the way this file assumes', () => {
  it('splits octants on bit 0 = x, bit 1 = y, bit 2 = z', () => {
    const child = /fn child\(self, octant: usize\) -> Aabb \{[\s\S]*?\n    \}/.exec(RUST);
    expect(child, 'Aabb::child not found in octree.rs').not.toBeNull();
    const body = child![0];
    expect(body).toMatch(/xlo = if octant & 1 == 0/);
    expect(body).toMatch(/ylo = if octant & 2 == 0/);
    expect(body).toMatch(/zlo = if octant & 4 == 0/);
  });

  it('assigns points to octants with the same bit order', () => {
    expect(RUST).toMatch(/\(bz << 2\) \| \(by << 1\) \| bx/);
  });

  it('emits its own record before its children', () => {
    const fn = /fn write_chunk_subtree\([\s\S]*?\n\}/.exec(RUST);
    expect(fn, 'write_chunk_subtree not found').not.toBeNull();
    const body = fn![0];
    expect(body.indexOf('records.push'))
      .toBeLessThan(body.indexOf('write_chunk_subtree(child'));
  });

  /** The stored level is GLOBAL — tile-local plus tileGlobalDepth — so a
   *  tile root reads 3, not 0. The hierarchy.bin note said the opposite
   *  for as long as nothing compared them, and a second reader built
   *  from that wording would find no node at level 0 and so treat none
   *  as a tile root: the overview would vanish on zoom-out and LRU
   *  eviction would take the roots. */
  it('stores a global level, and says so', () => {
    // Line-based, not a windowed regex over the comment block: a
    // sentence that rewraps must not fail this test, and a `toMatch`
    // against the whole 20k-line file would dump it into the diff.
    const lines = RUST.split('\n');
    const code = lines.filter(l => !l.trimStart().startsWith('//'));
    const adds = code.filter(l => /rec\[1\] *=/.test(l));
    expect(adds.length, 'the level write in the stitcher').toBe(1);
    expect(adds[0]).toContain('TILE_GLOBAL_DEPTH');

    // Only the positive fact is asserted. A first attempt also scanned
    // for the old wording and failed, because the corrected note quotes
    // the sentence it corrects — a test cannot tell the documentation
    // from the note ABOUT the documentation by keyword. It costs
    // nothing: reverting the note to the old wording removes "GLOBAL
    // depth", which this catches.
    const comments = lines.filter(l => l.trimStart().startsWith('//'));
    expect(comments.some(l => /GLOBAL depth/.test(l)),
      'the hierarchy.bin note should say the level is global').toBe(true);
  });

  it('makes tile boxes cubes, which is what the exact radius relies on', () => {
    expect(RUST).toMatch(/fn cube_around\(self\) -> Aabb/);
    expect(RUST).toMatch(/cell_bbox\(bbox, cx, cy, cz\)\.cube_around\(\)/);
  });
});
