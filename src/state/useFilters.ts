export interface FilterState {
  enabled: boolean;
  hideId0: boolean;
  hideAllTrees: boolean;
  // When true, hides the "unassigned tree points" subset of tree_id<=0 — i.e. points
  // that are NOT classified as ground (LAS classification != 2). Independent from
  // hideId0, which still hides the whole tree_id<=0 set including ground.
  hideUnassignedTreePoints: boolean;
  xMin: number | null;
  xMax: number | null;
  yMin: number | null;
  yMax: number | null;
  zMin: number | null;
  zMax: number | null;
  idMin: number | null;
  idMax: number | null;
  isolateId: number | null;
}

export const defaultFilters: FilterState = {
  enabled: true,
  hideId0: false,
  hideAllTrees: false,
  hideUnassignedTreePoints: false,
  xMin: null, xMax: null,
  yMin: null, yMax: null,
  zMin: null, zMax: null,
  idMin: null, idMax: null,
  isolateId: null,
};

export function isFilterActive(f: FilterState): boolean {
  return f.enabled && (
    f.xMin != null || f.xMax != null ||
    f.yMin != null || f.yMax != null ||
    f.zMin != null || f.zMax != null ||
    f.idMin != null || f.idMax != null ||
    f.hideId0 || f.hideAllTrees || f.hideUnassignedTreePoints || f.isolateId != null
  );
}
