// The forest pass (src-tauri commands/forest): wood / leaf, the
// stems and every tree grown from them, in one run. Its settings, what it
// reports, and the stems it leaves in the dataset's forest/seeds.json for
// the seed editor.

export interface ForestParams {
  /** Voxel edge of the working set, metres. */
  voxel: number;
  /** Points lower than this above the ground stay out of the graph (grass,
   *  litter), metres. */
  cut: number;
  dtmCell: number;
  /** Blend a Reflectance column (as some TLS scanners write) into the wood likelihood where present. */
  useReflectance: boolean;
  /** Flag trees standing this close to the edge of the data, metres. */
  edgeBuffer: number;
  /** Flag trees lower than this as understory, metres. */
  understory: number;
  /** Grow the trees from the stems as corrected by hand. */
  useSavedSeeds: boolean;
  /** Write stem / branch / leaf into the semantic column too. */
  writeSemantic: boolean;
}

export const DEFAULT_FOREST_PARAMS: ForestParams = {
  voxel: 0.04, cut: 0.25, dtmCell: 0.5, useReflectance: true,
  edgeBuffer: 2, understory: 2, useSavedSeeds: false, writeSemantic: true,
};

export interface ForestResult {
  treeCount: number;
  assignedPoints: number;
  stemPoints: number;
  branchPoints: number;
  leafPoints: number;
  seeds: number;
  seedsWithoutCircle: number;
  merged: number;
  suggestions: number;
  edgeTrees: number;
  understoryTrees: number;
  workingPoints: number;
  /** The graph, shape, flow and wood / leaf were reused from the last run. */
  reused: boolean;
  usedReflectance: boolean;
  seconds: number;
  timings: [string, number][];
}

/** A stem, in world coordinates. */
export interface ForestSeed {
  id: number;
  /** The tree it grows; seeds sharing a tree grow one tree. */
  tree: number;
  /** The stem axis at the ground. */
  x: number;
  y: number;
  z: number;
  /** Radius, metres; 0 when unknown. */
  r: number;
  /** Horizontal drift of the axis per metre of height (east, north). */
  lean: [number, number];
  /** Height above ground of its highest circle. */
  top: number;
  circles: number;
  /** 'manual': measured by hand in the stem review, so a re-grow keeps
   *  its circle instead of fitting one at breast height. */
  source: 'circle' | 'flow' | 'user' | 'manual' | string;
}

export interface ForestSeedsFile { version: number; seeds: ForestSeed[] }

/** One line for the panel. */
export function forestSummary(r: ForestResult): string {
  const wood = r.stemPoints + r.branchPoints;
  const lab = wood + r.leafPoints;
  const woodPct = lab > 0 ? Math.round((wood / lab) * 100) : 0;
  const parts = [
    `${r.treeCount.toLocaleString()} trees`,
    `${(r.seeds - r.seedsWithoutCircle).toLocaleString()} stems fitted`,
    r.seedsWithoutCircle > 0 ? `${r.seedsWithoutCircle.toLocaleString()} from the flow` : '',
    `${woodPct}% wood`,
    r.merged > 0 ? `${r.merged} merged` : '',
    r.suggestions > 0 ? `${r.suggestions} to check` : '',
    `${r.seconds.toFixed(1)} s${r.reused ? ' (graph reused)' : ''}`,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** The stage times, slowest first. */
export function forestTimings(r: ForestResult): string {
  return [...r.timings].filter(([n]) => n !== 'reused').sort((a, b) => b[1] - a[1]).map(([n, s]) => `${n} ${s.toFixed(1)} s`).join(', ');
}
