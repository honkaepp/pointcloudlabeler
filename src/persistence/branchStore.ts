// Branches cut out of a tree by hand, and what was measured on them —
// `<dataset>/branches.json`.
//
// A branch is a set of points, kept as the same (tile, record, point)
// addresses the edit patches use: octree.bin is written once and never
// reordered, so an address names one point for the life of the
// dataset. (Re-importing the source rebuilds the octree, and the
// backend deletes branches.json with the other sidecars when it does.)
// Each point belongs to at most one branch; assigning it to another
// takes it out of the first.
//
// The point data is never touched. The viewer paints the branches'
// points in their own colours from this file, which is how a user sees
// which branches have been gone through.
//
// Measurements are stored with everything needed to redraw and re-take
// them — where the section was cut, along which axis, how thick, in
// which caliper direction — beside the reading itself, so a number in
// the export can always be traced back to the place on the branch it
// came from.

import type { Vec3 } from '../metrics/branchMeasure';
import { csvField, csvNum } from '../io/csv';
import { nodeKey, type NodeKey } from './octreePatches';

export const BRANCH_FORMAT = 'pointcloudlabeler-branches/1';

export interface BranchMembers {
  tile: number;
  record: number;
  /** Point indices within the node, ascending, unique. */
  points: number[];
}

/** What a diameter reading is FOR. 'base' is a branch's base diameter;
 *  'dbh' a stem's diameter at breast height (1.3 m) and 'd6' at 6 m,
 *  the two the Finnish volume functions take. One reading per role on a
 *  part at a time: saving a new one turns the previous into 'other'. */
export type DiameterRole = 'base' | 'dbh' | 'd6' | 'other';

export const DIAMETER_ROLE_LABEL: Record<DiameterRole, string> = {
  base: 'BASE', dbh: 'DBH', d6: 'D6', other: 'Ø',
};

export interface DiameterMeasurement {
  id: string;
  role: DiameterRole;
  /** Two readings at right angles and their mean, or one reading. */
  mode: 'cross' | 'single';
  /** Section centre on the branch axis, and the axis (world). */
  center: Vec3;
  axis: Vec3;
  /** Direction of the first reading, radians from the section's
   *  horizontal in-plane axis. */
  theta: number;
  /** Section half-thickness and search radius (m). */
  halfThickness: number;
  maxRadius: number;
  /** Fraction of points let outside each jaw. */
  trim: number;
  /** First reading, second reading (cross only) and the diameter: their
   *  mean for a cross reading, the one reading otherwise (m). */
  d1: number;
  d2: number | null;
  diameter: number;
  /** The jaws were moved by hand from where they closed on the points. */
  manual: boolean;
  /** Circle-fit diameter and 12-sector coverage, for comparison. */
  circleDiameter: number | null;
  coverage: number | null;
  pointCount: number;
  /** Stems: the section's height above the ground, and the ground level
   *  it was measured from (m). Null on a branch. */
  heightAboveGround: number | null;
  groundZ: number | null;
  createdAt: string;
}

export interface LengthMeasurement {
  id: string;
  /** Clicked by hand, followed through the points, straight, or (stems)
   *  the tree's height: the vertical from the ground to its top. */
  method: 'manual' | 'path' | 'chord' | 'height';
  /** Base first (world). */
  nodes: Vec3[];
  length: number;
  /** THE length of the branch (one at a time, like the base diameter). */
  primary: boolean;
  createdAt: string;
}

export interface BranchRecord {
  id: number;
  /** A branch, or a stem (Stems panel). Both live in one file because a
   *  point is wood of one or the other, never both. */
  kind: 'branch' | 'stem';
  /** The tree the branch was cut from, when one was isolated. */
  treeId: number | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Marked as gone through. */
  done: boolean;
  note: string;
  members: BranchMembers[];
  pointCount: number;
  diameters: DiameterMeasurement[];
  lengths: LengthMeasurement[];
}

export interface BranchFile {
  format: string;
  branches: BranchRecord[];
}

export function emptyBranchFile(): BranchFile {
  return { format: BRANCH_FORMAT, branches: [] };
}

// ---------------------------------------------------------------------
// Parse / serialise
// ---------------------------------------------------------------------

/** Point indices are integers by construction (and every parse path
 *  filters out anything that is not one), so a plain numeric sort. */
const sortIds = (ids: number[]): number[] => ids.sort((a, b) => a - b);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
const numOr = <T>(v: unknown, d: T): number | T => (isNum(v) ? v : d);

function parseMembers(v: unknown): BranchMembers[] {
  if (!Array.isArray(v)) return [];
  const out: BranchMembers[] = [];
  for (const m of v) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    if (!isNum(o.tile) || !isNum(o.record) || !Array.isArray(o.points)) continue;
    const pts = sortIds(Array.from(new Set((o.points as unknown[]).filter((p): p is number => isNum(p) && p >= 0 && Number.isInteger(p)))));
    if (pts.length > 0) out.push({ tile: o.tile, record: o.record, points: pts });
  }
  return out;
}

function parseDiameter(v: unknown): DiameterMeasurement | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!isVec3(o.center) || !isVec3(o.axis) || !isNum(o.d1) || !isNum(o.diameter)) return null;
  return {
    id: str(o.id, `d${Math.random().toString(36).slice(2, 10)}`),
    role: o.role === 'base' || o.role === 'dbh' || o.role === 'd6' ? o.role : 'other',
    mode: o.mode === 'single' ? 'single' : 'cross',
    center: o.center, axis: o.axis,
    theta: numOr(o.theta, 0),
    halfThickness: numOr(o.halfThickness, 0),
    maxRadius: numOr(o.maxRadius, 0),
    trim: numOr(o.trim, 0),
    d1: o.d1,
    d2: numOr(o.d2, null),
    diameter: o.diameter,
    manual: o.manual === true,
    circleDiameter: numOr(o.circleDiameter, null),
    coverage: numOr(o.coverage, null),
    pointCount: numOr(o.pointCount, 0),
    heightAboveGround: numOr(o.heightAboveGround, null),
    groundZ: numOr(o.groundZ, null),
    createdAt: str(o.createdAt),
  };
}

function parseLength(v: unknown): LengthMeasurement | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.nodes) || !o.nodes.every(isVec3) || !isNum(o.length)) return null;
  return {
    id: str(o.id, `l${Math.random().toString(36).slice(2, 10)}`),
    method: o.method === 'path' || o.method === 'chord' || o.method === 'height' ? o.method : 'manual',
    nodes: o.nodes as Vec3[],
    length: o.length,
    primary: o.primary === true,
    createdAt: str(o.createdAt),
  };
}

/** Read branches.json. An absent or empty file is an empty set. A file
 *  in another format is refused rather than read as empty — saving over
 *  it would destroy work. Malformed entries inside are dropped. */
export function parseBranchFile(json: string): BranchFile {
  const t = json.trim();
  if (t === '' || t === '{}') return emptyBranchFile();
  const raw = JSON.parse(t) as Record<string, unknown>;
  if (raw.format !== undefined && raw.format !== BRANCH_FORMAT) {
    throw new Error(`branches.json is in a format this version does not read (${String(raw.format)})`);
  }
  const branches: BranchRecord[] = [];
  const seen = new Set<number>();
  for (const b of Array.isArray(raw.branches) ? raw.branches : []) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    if (!isNum(o.id) || !Number.isInteger(o.id) || o.id <= 0 || seen.has(o.id)) continue;
    seen.add(o.id);
    const members = parseMembers(o.members);
    branches.push({
      id: o.id,
      kind: o.kind === 'stem' ? 'stem' : 'branch',
      treeId: isNum(o.treeId) ? o.treeId : null,
      name: str(o.name, o.kind === 'stem' ? `Stem ${o.id}` : `Branch ${o.id}`),
      createdAt: str(o.createdAt),
      updatedAt: str(o.updatedAt),
      done: o.done === true,
      note: str(o.note),
      members,
      pointCount: countMembers(members),
      diameters: (Array.isArray(o.diameters) ? o.diameters : []).map(parseDiameter).filter((d): d is DiameterMeasurement => d !== null),
      lengths: (Array.isArray(o.lengths) ? o.lengths : []).map(parseLength).filter((l): l is LengthMeasurement => l !== null),
    });
  }
  return { format: BRANCH_FORMAT, branches };
}

export function serializeBranchFile(f: BranchFile): string {
  return JSON.stringify({ format: BRANCH_FORMAT, branches: f.branches });
}

// ---------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------

export function countMembers(members: BranchMembers[]): number {
  let n = 0;
  for (const m of members) n += m.points.length;
  return n;
}

/** Per node, which branch each marked point belongs to. A point listed
 *  in two branches (a hand-edited file) goes to the later one. */
export function buildMarks(f: BranchFile): Map<NodeKey, Map<number, number>> {
  const out = new Map<NodeKey, Map<number, number>>();
  for (const b of f.branches) {
    for (const m of b.members) {
      const key = nodeKey(m.tile, m.record);
      let inner = out.get(key);
      if (!inner) { inner = new Map(); out.set(key, inner); }
      for (const p of m.points) inner.set(p, b.id);
    }
  }
  return out;
}

function parseKey(key: string): [number, number] {
  const sep = key.indexOf(':');
  return [parseInt(key.slice(0, sep), 10), parseInt(key.slice(sep + 1), 10)];
}

/** A selection (node key → point indices) as member lists. */
export function membersFromSelection(sel: Map<string, Iterable<number>>): BranchMembers[] {
  const out: BranchMembers[] = [];
  for (const [key, pts] of sel) {
    const points = sortIds(Array.from(new Set(pts)));
    if (points.length === 0) continue;
    const [tile, record] = parseKey(key);
    out.push({ tile, record, points });
  }
  return out;
}

function membersToMap(members: BranchMembers[]): Map<NodeKey, Set<number>> {
  const out = new Map<NodeKey, Set<number>>();
  for (const m of members) {
    const key = nodeKey(m.tile, m.record);
    let s = out.get(key);
    if (!s) { s = new Set(); out.set(key, s); }
    for (const p of m.points) s.add(p);
  }
  return out;
}

function mapToMembers(map: Map<NodeKey, Set<number>>): BranchMembers[] {
  const out: BranchMembers[] = [];
  for (const [key, s] of map) {
    if (s.size === 0) continue;
    const [tile, record] = parseKey(key);
    out.push({ tile, record, points: sortIds(Array.from(s)) });
  }
  out.sort((a, b) => a.tile - b.tile || a.record - b.record);
  return out;
}

function without(members: BranchMembers[], take: Map<NodeKey, Set<number>>): BranchMembers[] {
  const out: BranchMembers[] = [];
  for (const m of members) {
    const t = take.get(nodeKey(m.tile, m.record));
    if (!t) { out.push(m); continue; }
    const points = m.points.filter(p => !t.has(p));
    if (points.length > 0) out.push({ tile: m.tile, record: m.record, points });
  }
  return out;
}

export function nextBranchId(f: BranchFile): number {
  let mx = 0;
  for (const b of f.branches) if (b.id > mx) mx = b.id;
  return mx + 1;
}

/** Put the selected points into branch `id`, taking them out of any
 *  other branch. */
export function assignToBranch(f: BranchFile, id: number, sel: BranchMembers[], now: string): BranchFile {
  const take = membersToMap(sel);
  return {
    ...f,
    branches: f.branches.map(b => {
      if (b.id === id) {
        const merged = membersToMap(b.members);
        for (const [k, s] of take) {
          let t = merged.get(k);
          if (!t) { t = new Set(); merged.set(k, t); }
          for (const p of s) t.add(p);
        }
        const members = mapToMembers(merged);
        return { ...b, members, pointCount: countMembers(members), updatedAt: now };
      }
      const members = without(b.members, take);
      if (members.length === b.members.length && countMembers(members) === b.pointCount) return b;
      return { ...b, members, pointCount: countMembers(members), updatedAt: now };
    }),
  };
}

/** Take the selected points out of branch `id`. */
export function removeFromBranch(f: BranchFile, id: number, sel: BranchMembers[], now: string): BranchFile {
  const take = membersToMap(sel);
  return {
    ...f,
    branches: f.branches.map(b => {
      if (b.id !== id) return b;
      const members = without(b.members, take);
      return { ...b, members, pointCount: countMembers(members), updatedAt: now };
    }),
  };
}

/** A new branch (or stem) holding the selected points, taken out of any
 *  other. A stem is named after its tree. */
export function createBranch(
  f: BranchFile, sel: BranchMembers[], treeId: number | null, now: string, kind: 'branch' | 'stem' = 'branch',
): { file: BranchFile; id: number } {
  const id = nextBranchId(f);
  const name = kind === 'stem' ? (treeId !== null ? `Stem of tree ${treeId}` : `Stem ${id}`) : `Branch ${id}`;
  const rec: BranchRecord = {
    id, kind, treeId, name, createdAt: now, updatedAt: now,
    done: false, note: '', members: [], pointCount: 0, diameters: [], lengths: [],
  };
  return { file: assignToBranch({ ...f, branches: [...f.branches, rec] }, id, sel, now), id };
}

export function deleteBranch(f: BranchFile, id: number): BranchFile {
  return { ...f, branches: f.branches.filter(b => b.id !== id) };
}

export function updateBranch(f: BranchFile, id: number, patch: Partial<Omit<BranchRecord, 'id' | 'members' | 'pointCount'>>, now: string): BranchFile {
  return { ...f, branches: f.branches.map(b => (b.id === id ? { ...b, ...patch, updatedAt: now } : b)) };
}

// ---------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------

/** Save a diameter on a part. A new reading in a role (base, DBH, d6)
 *  retires the old one in that role to 'other' — kept, so a
 *  re-measurement does not lose the first. */
export function addDiameter(f: BranchFile, id: number, d: DiameterMeasurement, now: string): BranchFile {
  return addDiameters(f, id, [d], now);
}

/** Several at once (a taper series), one write. */
export function addDiameters(f: BranchFile, id: number, ds: DiameterMeasurement[], now: string): BranchFile {
  return {
    ...f,
    branches: f.branches.map(b => {
      if (b.id !== id) return b;
      let prev = b.diameters;
      for (const d of ds) {
        if (d.role !== 'other') prev = prev.map(x => (x.role === d.role ? { ...x, role: 'other' as const } : x));
        prev = [...prev, d];
      }
      return { ...b, diameters: prev, updatedAt: now };
    }),
  };
}

/** Save a length. A new primary length retires the old primary. */
export function addLength(f: BranchFile, id: number, l: LengthMeasurement, now: string): BranchFile {
  return {
    ...f,
    branches: f.branches.map(b => {
      if (b.id !== id) return b;
      const prev = l.primary ? b.lengths.map(x => (x.primary ? { ...x, primary: false } : x)) : b.lengths;
      return { ...b, lengths: [...prev, l], updatedAt: now };
    }),
  };
}

export function removeMeasurement(f: BranchFile, id: number, measurementId: string, now: string): BranchFile {
  return {
    ...f,
    branches: f.branches.map(b => {
      if (b.id !== id) return b;
      return {
        ...b,
        diameters: b.diameters.filter(d => d.id !== measurementId),
        lengths: b.lengths.filter(l => l.id !== measurementId),
        updatedAt: now,
      };
    }),
  };
}

/** Give an existing diameter a role (default 'base'), retiring the one
 *  that held it; or make an existing length THE length. */
export function promoteMeasurement(f: BranchFile, id: number, measurementId: string, now: string, role: DiameterRole = 'base'): BranchFile {
  return {
    ...f,
    branches: f.branches.map(b => {
      if (b.id !== id) return b;
      const isD = b.diameters.some(d => d.id === measurementId);
      const isL = b.lengths.some(l => l.id === measurementId);
      return {
        ...b,
        diameters: isD ? b.diameters.map(d => (d.id === measurementId ? { ...d, role } : d.role === role ? { ...d, role: 'other' as const } : d)) : b.diameters,
        lengths: isL ? b.lengths.map(l => ({ ...l, primary: l.id === measurementId })) : b.lengths,
        updatedAt: now,
      };
    }),
  };
}

export function diameterOfRole(b: BranchRecord, role: DiameterRole): DiameterMeasurement | null {
  for (let i = b.diameters.length - 1; i >= 0; i--) if (b.diameters[i].role === role) return b.diameters[i];
  return null;
}

export function baseDiameter(b: BranchRecord): DiameterMeasurement | null {
  return diameterOfRole(b, 'base');
}

/** The stem of tree `treeId`, if one has been recorded. */
export function stemOf(f: BranchFile, treeId: number): BranchRecord | null {
  return f.branches.find(b => b.kind === 'stem' && b.treeId === treeId) ?? null;
}

export function primaryLength(b: BranchRecord): LengthMeasurement | null {
  for (let i = b.lengths.length - 1; i >= 0; i--) if (b.lengths[i].primary) return b.lengths[i];
  return null;
}

export function newMeasurementId(prefix: 'd' | 'l'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------

/** Twelve colours that read on a dark background and stay clear of the
 *  selection red and the default active-tree pink. */
const PALETTE: [number, number, number][] = [
  [255, 196, 0], [0, 200, 255], [120, 230, 90], [255, 128, 32],
  [170, 120, 255], [0, 230, 180], [255, 235, 120], [90, 160, 255],
  [200, 255, 60], [255, 170, 110], [140, 220, 255], [230, 150, 255],
];

export function branchColor(id: number): [number, number, number] {
  return PALETTE[((id - 1) % PALETTE.length + PALETTE.length) % PALETTE.length];
}

export function branchColorHex(id: number): string {
  const [r, g, b] = branchColor(id);
  return `#${[r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------

const mm = (m: number | null | undefined, dp = 1) => (m == null ? '' : csvNum(m * 1000, dp));

/** One row per branch: the base diameter and the length beside the
 *  bookkeeping. Diameters in millimetres, lengths in metres. */
export function branchSummaryCsv(f: BranchFile): string[] {
  const rows = ['branch_id,kind,name,tree_id,points,done,base_diameter_mm,base_d1_mm,base_d2_mm,base_mode,base_coverage,dbh_mm,d6_mm,length_m,length_method,height_m,diameters,lengths,note'];
  for (const b of f.branches) {
    const d = baseDiameter(b);
    const dbh = diameterOfRole(b, 'dbh');
    const d6 = diameterOfRole(b, 'd6');
    const l = primaryLength(b);
    let h: LengthMeasurement | null = null;
    for (const x of b.lengths) if (x.method === 'height' && (!h || x.primary || !h.primary)) h = x;
    rows.push([
      b.id, b.kind, csvField(b.name), b.treeId ?? '', b.pointCount, b.done ? 1 : 0,
      mm(d?.diameter), mm(d?.d1), mm(d?.d2), d?.mode ?? '', d?.coverage == null ? '' : csvNum(d.coverage, 2),
      mm(dbh?.diameter), mm(d6?.diameter),
      l ? csvNum(l.length, 3) : '', l?.method ?? '', h ? csvNum(h.length, 3) : '',
      b.diameters.length, b.lengths.length, csvField(b.note),
    ].join(','));
  }
  return rows;
}

/** One row per measurement, with where it was taken. */
export function measurementsCsv(f: BranchFile): string[] {
  const rows = ['branch_id,part,tree_id,kind,role,method,value,unit,height_above_ground_m,d1_mm,d2_mm,theta_deg,thickness_mm,trim,manual,circle_diameter_mm,coverage,section_points,x,y,z,axis_x,axis_y,axis_z,end_x,end_y,end_z,created_at'];
  for (const b of f.branches) {
    for (const d of b.diameters) {
      rows.push([
        b.id, b.kind, b.treeId ?? '', 'diameter', d.role, d.mode, mm(d.diameter), 'mm',
        d.heightAboveGround == null ? '' : csvNum(d.heightAboveGround, 3), mm(d.d1), mm(d.d2),
        csvNum((d.theta * 180) / Math.PI, 1), mm(d.halfThickness * 2), csvNum(d.trim, 3), d.manual ? 1 : 0,
        mm(d.circleDiameter), d.coverage == null ? '' : csvNum(d.coverage, 2), d.pointCount,
        csvNum(d.center[0], 3), csvNum(d.center[1], 3), csvNum(d.center[2], 3),
        csvNum(d.axis[0], 4), csvNum(d.axis[1], 4), csvNum(d.axis[2], 4),
        '', '', '', csvField(d.createdAt),
      ].join(','));
    }
    for (const l of b.lengths) {
      const a = l.nodes[0], e = l.nodes[l.nodes.length - 1];
      rows.push([
        b.id, b.kind, b.treeId ?? '', 'length', l.primary ? 'primary' : 'other', l.method, csvNum(l.length, 3), 'm',
        '', '', '', '', '', '', '', '', '', '',
        a ? csvNum(a[0], 3) : '', a ? csvNum(a[1], 3) : '', a ? csvNum(a[2], 3) : '',
        '', '', '',
        e ? csvNum(e[0], 3) : '', e ? csvNum(e[1], 3) : '', e ? csvNum(e[2], 3) : '',
        csvField(l.createdAt),
      ].join(','));
    }
  }
  return rows;
}
