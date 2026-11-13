// The seed editor's state: the stems of the open dataset
// (forest/seeds.json), what the user is doing to them, the pairs the forest
// pass found that may be one tree, and the trees' flags.
//
// Correcting the stems is the fast way to correct a segmentation: a missed
// stem is one click, two stems of one tree one merge, and the trees are
// re-grown from the corrected stems in seconds (the forest pass keeps its
// graph). Point-level relabelling is left for the last details.

import { useSyncExternalStore } from 'react';
import type { ForestSeed, ForestSeedsFile } from './forest';

export type SeedMode = 'select' | 'add' | 'merge' | 'delete' | 'move' | 'radius';

/** Breast height, metres above a stem's ground: where the stem review cuts
 *  and the overlay draws each stem's circle. */
export const BH = 1.3;

/** The stem review's mark on a stem, with where its axis was at breast
 *  height when marked (a mark only holds for the stem it was made on). */
export interface ReviewMark { status: 'ok' | 'edited'; x: number; y: number }

/** Walking the stems one at a time, from above at breast height. */
export interface StemReview {
  /** Seed ids in the order walked. */
  order: number[];
  index: number;
  /** Width of the view, metres. */
  view: number;
  /** Half the thickness of the breast-height slab, metres. */
  slab: number;
}

export interface ForestSuggestion { a: number; b: number; votes: number; x: number; y: number; z: number }

/** A branch whose boundary with another tree was nearly a tie when the
 *  trees were grown (forest/near_ties.json): what `tree` reached through
 *  the weakest step of its path near `other`. Largest first in the file. */
export interface NearTie {
  id: number;
  tree: number;
  other: number;
  /** Its own distance over the other tree's at the closest point (1: a tie). */
  ratio: number;
  nodes: number;
  points: number;
  centre: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  /** The owner model's belief that the branch is `other`'s (MLS). */
  p?: number;
  /** The model was sure enough and moved it: then `tree` is the tree it
   *  was given to and `other` the one it came from. */
  auto?: boolean;
}

/** What the branch review did with a branch. */
export type TieMark = 'ok' | 'moved';
export interface ForestTree { tree: number; x: number; y: number; z: number; height: number; r: number; voxels: number; flags: string[] }

export interface ForestState {
  dir: string;
  seeds: ForestSeed[] | null;
  /** The seed picked (by id), and the seed a merge starts from. */
  selected: number | null;
  mode: SeedMode;
  /** Draw the stems in the viewport. */
  visible: boolean;
  /** Seeds changed since they were saved. */
  dirty: boolean;
  suggestions: ForestSuggestion[];
  trees: ForestTree[];
  /** The stem review, while it runs. */
  review: StemReview | null;
  /** The stems looked at in the review, by seed id (forest/seed_review.json). */
  marks: Record<number, ReviewMark>;
  /** The branches nearly another tree's, and which run of the forest pass
   *  listed them (the marks hold for that run only). */
  ties: NearTie[];
  tieRun: number;
  /** The branch review's marks, by branch id (saved with the stem marks). */
  tieMarks: Record<number, TieMark>;
  /** The branch review, while it runs: the index into `ties`. */
  tieReview: { index: number } | null;
}

let state: ForestState = {
  dir: '', seeds: null, selected: null, mode: 'select', visible: true, dirty: false, suggestions: [], trees: [], review: null, marks: {},
  ties: [], tieRun: 0, tieMarks: {}, tieReview: null,
};
const listeners = new Set<() => void>();

export function forestState(): ForestState { return state; }
export function setForestState(patch: Partial<ForestState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}
export function useForestStore(): ForestState {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, forestState);
}

interface ForestDesktop {
  octreeForestSeeds?: (dir: string) => Promise<ForestSeedsFile | null>;
  octreeForestSaveSeeds?: (dir: string, seeds: ForestSeedsFile) => Promise<void>;
  octreeForestFile?: (dir: string, name: string) => Promise<unknown>;
  octreeForestSaveReview?: (dir: string, review: unknown) => Promise<void>;
}
const desktop = (): ForestDesktop | undefined => (window as unknown as { desktop?: ForestDesktop }).desktop;

/** Read the dataset's stems, suggestions and trees (none before a run). */
export async function loadForest(dir: string): Promise<void> {
  const d = desktop();
  if (!d?.octreeForestSeeds) {
    setForestState({ dir, seeds: null, suggestions: [], trees: [], dirty: false, selected: null, review: null, marks: {}, ties: [], tieRun: 0, tieMarks: {}, tieReview: null });
    return;
  }
  const [seeds, sugg, trees, review, ties] = await Promise.all([
    d.octreeForestSeeds(dir).catch(() => null),
    d.octreeForestFile?.(dir, 'suggestions').catch(() => null),
    d.octreeForestFile?.(dir, 'trees').catch(() => null),
    d.octreeForestFile?.(dir, 'seed_review').catch(() => null),
    d.octreeForestFile?.(dir, 'near_ties').catch(() => null),
  ]);
  const list = seeds?.seeds ?? null;
  const nt = (ties as { run?: number; branches?: NearTie[] } | null) ?? null;
  const tieRun = nt?.run ?? 0;
  setForestState({
    ties: nt?.branches ?? [],
    tieRun,
    tieMarks: validTieMarks((review as { ties?: { run?: number; marks?: Record<string, TieMark> } } | null)?.ties, tieRun),
    tieReview: null,
    dir,
    seeds: list,
    suggestions: ((sugg as { suggestions?: ForestSuggestion[] } | null)?.suggestions) ?? [],
    trees: ((trees as { trees?: ForestTree[] } | null)?.trees) ?? [],
    dirty: false,
    selected: null,
    review: null,
    marks: list ? validMarks(((review as { marks?: Record<string, ReviewMark> } | null)?.marks) ?? {}, list) : {},
  });
}

/** Save the stem review's marks beside the dataset. */
export async function saveReview(): Promise<void> {
  const d = desktop();
  if (!d?.octreeForestSaveReview || !state.dir) return;
  await d.octreeForestSaveReview(state.dir, { version: 1, marks: state.marks, ties: { run: state.tieRun, marks: state.tieMarks } });
}

export async function saveSeeds(): Promise<void> {
  const d = desktop();
  if (!d?.octreeForestSaveSeeds || !state.seeds) return;
  await d.octreeForestSaveSeeds(state.dir, { version: 1, seeds: state.seeds });
  setForestState({ dirty: false });
}

// ---- edits (pure, for the tests; the store applies them) ----

/** The seed nearest a point in plan view, within `reach` metres of its axis. */
export function seedNear(seeds: readonly ForestSeed[], x: number, y: number, z: number, reach = 0.6): ForestSeed | null {
  let best: ForestSeed | null = null;
  let bd = reach;
  for (const s of seeds) {
    const h = Math.max(0, z - s.z);
    const ax = s.x + s.lean[0] * h, ay = s.y + s.lean[1] * h;
    const d = Math.hypot(x - ax, y - ay) - s.r;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

/** A stem added where the user clicked on it: its axis there, the ground
 *  taken from the nearest stem (the click is somewhere up the stem). */
export function addSeed(seeds: readonly ForestSeed[], x: number, y: number, z: number): ForestSeed[] {
  const id = seeds.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  const tree = seeds.reduce((m, s) => Math.max(m, s.tree), 0) + 1;
  let ground = z - 1.3;
  let bd = 15;
  for (const s of seeds) { const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; ground = s.z; } }
  const top = Math.min(3, Math.max(1.3, z - ground + 0.3));
  return [...seeds, { id, tree, x, y, z: ground, r: 0, lean: [0, 0], top, circles: 0, source: 'user' }];
}

export function deleteSeed(seeds: readonly ForestSeed[], id: number): ForestSeed[] {
  return seeds.filter((s) => s.id !== id);
}

/** Every seed of `from`'s tree grows `into`'s tree. */
export function mergeSeeds(seeds: readonly ForestSeed[], fromId: number, intoId: number): ForestSeed[] {
  const from = seeds.find((s) => s.id === fromId);
  const into = seeds.find((s) => s.id === intoId);
  if (!from || !into || from.tree === into.tree) return [...seeds];
  return seeds.map((s) => (s.tree === from.tree ? { ...s, tree: into.tree } : s));
}

/** Merge two trees (a suggestion): `b`'s seeds grow `a`. */
export function mergeTrees(seeds: readonly ForestSeed[], a: number, b: number): ForestSeed[] {
  return seeds.map((s) => (s.tree === b ? { ...s, tree: a } : s));
}

/** A seed out of the tree it shares: a tree of its own. */
export function splitSeed(seeds: readonly ForestSeed[], id: number): ForestSeed[] {
  const tree = seeds.reduce((m, s) => Math.max(m, s.tree), 0) + 1;
  return seeds.map((s) => (s.id === id ? { ...s, tree } : s));
}

/** A stem's axis at height `h` above its ground. */
export function axisAt(s: ForestSeed, h = BH): [number, number] {
  return [s.x + s.lean[0] * h, s.y + s.lean[1] * h];
}

/** The stem moved so that its axis at breast height is at (`x`, `y`); its
 *  lean is kept. The forest pass measures it there again at the next
 *  re-grow, unless it was measured by hand. */
export function moveSeed(seeds: readonly ForestSeed[], id: number, x: number, y: number): ForestSeed[] {
  return seeds.map((s) => (s.id === id ? { ...s, x: x - s.lean[0] * BH, y: y - s.lean[1] * BH } : s));
}

/** The stem measured by hand: its circle at breast height (radius, and
 *  the centre when given). A re-grow keeps it. */
export function measureSeed(seeds: readonly ForestSeed[], id: number, r: number, centre?: [number, number]): ForestSeed[] {
  return seeds.map((s) => {
    if (s.id !== id) return s;
    const moved = centre ? { ...s, x: centre[0] - s.lean[0] * BH, y: centre[1] - s.lean[1] * BH } : s;
    return { ...moved, r: Math.max(0, r), source: 'manual' };
  });
}

/** Hand a stem measured by hand back to the forest pass's own measurement
 *  at breast height. */
export function unmeasureSeed(seeds: readonly ForestSeed[], id: number): ForestSeed[] {
  return seeds.map((s) => (s.id === id && s.source === 'manual' ? { ...s, source: s.circles > 0 ? 'circle' : 'user' } : s));
}

/** Why a stem is worth a look: how it was found, its size, the trees it
 *  may belong with. Empty for a stem fitted from circles, alone in its
 *  tree and of an ordinary size. */
export function stemDoubts(seeds: readonly ForestSeed[], s: ForestSeed, suggestions: readonly ForestSuggestion[] = []): string[] {
  const out: string[] = [];
  if (s.source === 'flow') out.push('found from the flow of its branches only (no stem circle)');
  if (s.source === 'user') out.push('added by hand, not measured yet');
  if (s.r <= 0) out.push('no diameter');
  else if (s.r < 0.03) out.push(`very thin (⌀ ${(s.r * 200).toFixed(1)} cm)`);
  else if (s.r > 0.6) out.push(`very thick (⌀ ${(s.r * 200).toFixed(0)} cm)`);
  if (Math.hypot(s.lean[0], s.lean[1]) > 0.3) out.push('leans strongly');
  const sharing = seeds.filter((o) => o.tree === s.tree).length;
  if (sharing > 1) out.push(`one of ${sharing} stems of tree ${s.tree}`);
  for (const g of suggestions) {
    if (g.a === s.tree || g.b === s.tree) out.push(`may be one tree with #${g.a === s.tree ? g.b : g.a}`);
  }
  return out;
}

/** The order the review walks the stems: the doubtful first when asked,
 *  each group along rows 10 m wide from north to south, alternately west
 *  to east and back, so the next stem is near the last. */
export function reviewOrder(seeds: readonly ForestSeed[], suggestions: readonly ForestSuggestion[] = [], doubtfulFirst = true): number[] {
  const row = (s: ForestSeed) => Math.floor(-axisAt(s)[1] / 10);
  const walk = (list: ForestSeed[]) => [...list].sort((a, b) => {
    const ra = row(a), rb = row(b);
    if (ra !== rb) return ra - rb;
    const dx = axisAt(a)[0] - axisAt(b)[0];
    return (Math.abs(ra) % 2 === 0 ? dx : -dx) || a.id - b.id;
  }).map((s) => s.id);
  if (!doubtfulFirst) return walk([...seeds]);
  const doubtful = seeds.filter((s) => stemDoubts(seeds, s, suggestions).length > 0);
  const rest = seeds.filter((s) => stemDoubts(seeds, s, suggestions).length === 0);
  return [...walk(doubtful), ...walk(rest)];
}

/** The marks that still hold: their stem is there, its axis at breast
 *  height within 15 cm of where it was marked (a fresh forest pass numbers
 *  its stems anew; a re-grow moves a stem by its new circle only). */
export function validMarks(marks: Record<string | number, ReviewMark>, seeds: readonly ForestSeed[]): Record<number, ReviewMark> {
  const byId = new Map(seeds.map((s) => [s.id, s]));
  const out: Record<number, ReviewMark> = {};
  for (const [k, m] of Object.entries(marks)) {
    const s = byId.get(Number(k));
    if (!s || (m.status !== 'ok' && m.status !== 'edited')) continue;
    const [ax, ay] = axisAt(s);
    if (Math.hypot(ax - m.x, ay - m.y) <= 0.15) out[s.id] = { status: m.status, x: m.x, y: m.y };
  }
  return out;
}

/** Mark a stem in the review, or clear its mark, and save the marks. */
export function markStem(id: number, status: ReviewMark['status'] | null): void {
  const s = state.seeds?.find((x) => x.id === id);
  const marks = { ...state.marks };
  if (!s || status === null) delete marks[id];
  else { const [x, y] = axisAt(s); marks[id] = { status, x, y }; }
  setForestState({ marks });
  void saveReview().catch(() => { /* kept in memory; saved with the next mark */ });
}

/** The branch review's marks that still hold: those of the run that listed
 *  the branches (a new forest pass lists them anew). */
export function validTieMarks(saved: { run?: number; marks?: Record<string, TieMark> } | undefined, run: number): Record<number, TieMark> {
  const out: Record<number, TieMark> = {};
  if (!saved || !run || saved.run !== run) return out;
  for (const [k, m] of Object.entries(saved.marks ?? {})) {
    if (m === 'ok' || m === 'moved') out[Number(k)] = m;
  }
  return out;
}

/** Mark a branch in the review, or clear its mark, and save the marks. */
export function markTie(id: number, status: TieMark | null): void {
  const tieMarks = { ...state.tieMarks };
  if (status === null) delete tieMarks[id];
  else tieMarks[id] = status;
  setForestState({ tieMarks });
  void saveReview().catch(() => { /* kept in memory; saved with the next mark */ });
}

/** Where the branch review starts: the first branch not yet looked at. */
export function firstUnmarked(ties: readonly NearTie[], marks: Record<number, TieMark>): number {
  const i = ties.findIndex((t) => marks[t.id] === undefined);
  return i < 0 ? 0 : i;
}

/** Apply an edit to the store's seeds. */
export function editSeeds(f: (seeds: readonly ForestSeed[]) => ForestSeed[]): void {
  if (!state.seeds) return;
  setForestState({ seeds: f(state.seeds), dirty: true });
}

/** What a click in the viewport does in the current mode. */
export function clickSeed(x: number, y: number, z: number): void {
  const seeds = state.seeds;
  if (!seeds) return;
  const near = seedNear(seeds, x, y, z);
  switch (state.mode) {
    case 'add':
      editSeeds((s) => addSeed(s, x, y, z));
      setForestState({ selected: state.seeds ? state.seeds[state.seeds.length - 1].id : null });
      break;
    case 'delete':
      if (near) { editSeeds((s) => deleteSeed(s, near.id)); setForestState({ selected: null }); }
      break;
    case 'merge':
      if (!near) break;
      if (state.selected === null || state.selected === near.id) setForestState({ selected: near.id });
      else { const into = state.selected; editSeeds((s) => mergeSeeds(s, near.id, into)); }
      break;
    default:
      setForestState({ selected: near ? near.id : null });
  }
}

/** The stems as the overlay draws them: a line up the axis to the top of
 *  what the seed claims, a ring at the foot, and the colour by source. */
export function seedGeometry(seeds: readonly ForestSeed[], selected: number | null, exact = false): {
  segments: { a: [number, number, number]; b: [number, number, number]; color: string }[];
} {
  const sel = seeds.find((s) => s.id === selected) ?? null;
  const segments: { a: [number, number, number]; b: [number, number, number]; color: string }[] = [];
  for (const s of seeds) {
    const color = s.id === selected ? '#ff47bc'
      : sel && s.tree === sel.tree ? '#f9a8d4'
      : s.source === 'user' || s.source === 'manual' ? '#38bdf8' : s.source === 'flow' ? '#f59e0b' : '#4ade80';
    const h = s.top + 0.3;
    segments.push({ a: [s.x, s.y, s.z], b: [s.x + s.lean[0] * h, s.y + s.lean[1] * h, s.z + h], color });
    // the stem review (`exact`): the circle itself, the diameter read off
    // it, and a cross on its centre; otherwise a ring round the stem
    const r = exact ? s.r : Math.max(s.r, 0.1) + 0.05;
    const n = exact ? 48 : 16;
    const lh = BH;
    const [cx, cy] = axisAt(s, lh);
    if (r > 0) {
      for (let k = 0; k < n; k++) {
        const t0 = (k / n) * Math.PI * 2, t1 = ((k + 1) / n) * Math.PI * 2;
        segments.push({ a: [cx + r * Math.cos(t0), cy + r * Math.sin(t0), s.z + lh], b: [cx + r * Math.cos(t1), cy + r * Math.sin(t1), s.z + lh], color });
      }
    }
    if (exact) {
      const c = r > 0 ? Math.min(0.03, r / 3) : 0.05;
      segments.push({ a: [cx - c, cy, s.z + lh], b: [cx + c, cy, s.z + lh], color });
      segments.push({ a: [cx, cy - c, s.z + lh], b: [cx, cy + c, s.z + lh], color });
    }
  }
  return { segments };
}

/** What the forest pass says about one tree, for Tree review: its flags
 *  and the trees it may be one with. */
export function forestNotes(st: Pick<ForestState, 'trees' | 'suggestions'>, id: number): { label: string; hint: string }[] {
  const out: { label: string; hint: string }[] = [];
  const t = st.trees.find((x) => x.tree === id);
  if (t) {
    if (t.flags.includes('edge')) out.push({ label: 'stands at the edge of the data', hint: 'seen from one side, its crown may run out of the scan — check it, or leave it out of per-hectare figures' });
    if (t.flags.includes('understory')) out.push({ label: `understory (${t.height.toFixed(1)} m)`, hint: 'lower than the understory height of the forest pass' });
    if (t.flags.includes('noStemFit')) out.push({ label: 'no stem circle fitted', hint: 'found from the flow of its branches or by hand: its position and DBH are less certain' });
  }
  for (const g of st.suggestions) {
    if (g.a !== id && g.b !== id) continue;
    const other = g.a === id ? g.b : g.a;
    out.push({ label: `may be one tree with #${other}`, hint: `their stem circles mix at ${g.votes} height${g.votes === 1 ? '' : 's'} — merge them here, or in Segment → Forest stems` });
  }
  return out;
}
