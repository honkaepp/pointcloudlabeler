// Runtime reader for PointCloudLabeler octree datasets.
//
// The converter (src-tauri/src/commands/octree.rs) writes each
// dataset as metadata.json + hierarchy.bin + octree.bin under
// <project>/octrees/<name>/. This module loads the metadata + the
// hierarchy up front, materialises a flat per-record geometry
// index (OctreeIndex) for the streamer's priority-queue traversal,
// and streams individual node point blocks on demand.
//
// On-disk shape (cross-referenced with octree.rs):
//   - metadata.json: pointCount, boundingBox, scale, offset, tiles[…]
//     where each tile = { chunkIdx, gridXyz, bbox{min,max}, byteOffset,
//     byteSize, pointCount, recordOffset, recordCount }.
//   - hierarchy.bin: array of NodeRecord (24 bytes LE) in tile order;
//     each tile's records sit contiguously starting at recordOffset
//     and span recordCount entries (depth-first within the tile).
//   - octree.bin: per-tile per-node 20-byte points blocks at
//     byteOffset + node.byteOffset for byte_size bytes.
//
// Camera-aware LOD selection lives in src/three/OctreeView.tsx — it
// walks the index built here with a screen-space priority queue.

import { writeScenePosition } from '../io/sceneAxes';

/** Reserved extra-column names for the two deadwood instance-id channels
 *  (must match octree.rs STANDING_/LAYING_DEADWOOD_NAME). They ride as
 *  numeric extras but are integer id channels the Deadwood editing tool
 *  owns — surfaced as their own colour/edit mode rather than as generic
 *  ramp-coloured extras, and filtered out of the user-toggleable extras
 *  lists (import carry, Display ramp, export f32 columns). */
export const STANDING_DEADWOOD_EXTRA = 'standing_deadwood';
export const LAYING_DEADWOOD_EXTRA = 'laying_deadwood';
export function isDeadwoodExtra(name: string): boolean {
  const n = name.toLowerCase();
  return n === STANDING_DEADWOOD_EXTRA || n === LAYING_DEADWOOD_EXTRA;
}

export interface OctreeListEntry {
  id: string;
  dir: string;
  name: string;
  pointCount: number;
  tileCount: number;
  scannerType: 'TLS' | 'MLS' | 'ULS' | 'ALS' | 'other';
  rootSpacing: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  updatedAt: number;
}

/** One tree's global footprint, from the `octree_tree_summary` command:
 *  point count + world-space bbox over the whole cloud with patches
 *  applied. treeId 0 is the unassigned bucket. */
export interface TreeSummaryEntry {
  treeId: number;
  count: number;
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  /** Mean point position (world) — the density centre. A few stray
   *  points barely move it, unlike the bbox centre they drag with them,
   *  so review anchoring + framing use this. */
  centroid: [number, number, number];
  /** Per-axis standard deviation of the point positions (m). ±2.5σ
   *  around the centroid covers the real tree while excluding far
   *  strays — the review neighbourhood box is sized from this. */
  sigma: [number, number, number];
  /** Every octree record holding a point of this tree, in record order
   *  — so isolating the tree can load exactly them, wherever they are.
   *  Optional: a summary from before this field has none. */
  records?: number[];
}

/** Result of the `octree_terrain` command — DTM / DSM / CHM rasters
 *  written to disk plus their georeference + value ranges. */
export interface TerrainResult {
  cols: number;
  rows: number;
  cellSize: number;
  groundCells: number;
  dtmMin: number;
  dtmMax: number;
  chmMin: number;
  chmMax: number;
  outDir: string;
  dtmPath: string;
  dsmPath: string;
  chmPath: string;
  /** GeoTIFF twins of the three rasters (same grid + data, georeferenced).
   *  Written alongside the .asc files for GIS hand-off. */
  dtmTifPath: string;
  dsmTifPath: string;
  chmTifPath: string;
  /** Geomorphometric derivatives — Horn 1981 slope (deg, 0..90) +
   *  aspect (compass deg, 0..360, NaN on flat), Weiss 2001 TPI
   *  (metres above/below the local mean). Written as .asc + .tif on
   *  the same grid as the DTM, so no re-sampling is needed. */
  slopePath: string;
  aspectPath: string;
  tpiPath: string;
  slopeTifPath: string;
  aspectTifPath: string;
  tpiTifPath: string;
  /** Half-width (in cells) of the square TPI window — auto-chosen to
   *  put the analysis circle at roughly 10 m across whatever the cell
   *  size. Surfaced so the Layers panel can label the layer. */
  tpiRadiusCells: number;
  // Hydrology + extended morphometry. Same grid + georef as the
  // others, all written as .asc + .tif. Filled = sink-filled DEM
  // (Wang & Liu 2006), flow accumulation in cells (multiply by
  // cell² for m²), TWI = ln(α / tan β) (Beven & Kirkby 1979),
  // streams = binary mask above the auto-picked threshold, plan +
  // profile curvature in 1/m (Zevenbergen & Thorne 1987), TRI in
  // metres (Riley 1999), HLI 0..1 (McCune & Keon 2002).
  filledPath: string;
  flowAccumPath: string;
  twiPath: string;
  streamsPath: string;
  planCurvPath: string;
  profileCurvPath: string;
  triPath: string;
  hliPath: string;
  filledTifPath: string;
  flowAccumTifPath: string;
  twiTifPath: string;
  streamsTifPath: string;
  planCurvTifPath: string;
  profileCurvTifPath: string;
  triTifPath: string;
  hliTifPath: string;
  /** Stream-mask threshold actually used (in cells). */
  streamThresholdCells: number;
  /** Latitude (deg) used for HLI. */
  hliLatitudeDeg: number;
  // Hillshade rasters — standard cartographic single-direction shade
  // (GDAL `gdaldem hillshade` defaults: sun altitude 45°, azimuth 315°)
  // and the modern multi-directional variant (Mark 1992, ArcGIS Pro's
  // default) which averages 4 azimuths so features parallel to the
  // sun's bearing remain visible.
  hillshadePath: string;
  hillshadeMultiPath: string;
  hillshadeTifPath: string;
  hillshadeMultiTifPath: string;
  /** Sun altitude (deg) used for both hillshade rasters. */
  hillshadeAltitudeDeg: number;
  /** Sun azimuth (compass deg) for the single-direction variant. */
  hillshadeAzimuthDeg: number;
}

/** Forestry density-metrics output — twelve grid rasters + a
 *  plot-wide summary computed by `octree_density_metrics`. Mirrors
 *  what lidR's `pixel_metrics` / FORTLS produce. */
export interface DensityMetricsResult {
  outDir: string;
  cols: number;
  rows: number;
  cellSize: number;
  minX: number;
  minY: number;
  /** HAG floor (m) — returns below it were dropped before stats. */
  minHeight: number;
  /** Canopy cover threshold (m). */
  canopyThreshold: number;
  // Plot-wide summary over every above-ground return.
  plotCount: number;
  plotMean: number; plotSd: number;
  plotP25: number; plotP50: number; plotP75: number; plotP90: number; plotP95: number;
  plotSkew: number; plotKurt: number;
  /** % returns above the canopy threshold (0..1). */
  plotCanopyCover: number;
  /** What the canopy-cover figures were computed from — "first returns"
   *  (the ABA convention every calibrated model expects) or "all returns"
   *  when the dataset carries no return numbers. The number means
   *  different things on the two bases, so it is shown, not assumed. */
  canopyCoverBasis: string;
  /** Returns per m² over populated cells. */
  plotDensity: number;
  // Grid rasters — .asc + georeferenced .tif per metric.
  meanPath: string;        meanTifPath: string;
  sdPath: string;          sdTifPath: string;
  cvPath: string;          cvTifPath: string;
  skewPath: string;        skewTifPath: string;
  kurtPath: string;        kurtTifPath: string;
  p25Path: string;         p25TifPath: string;
  p50Path: string;         p50TifPath: string;
  p75Path: string;         p75TifPath: string;
  p90Path: string;         p90TifPath: string;
  p95Path: string;         p95TifPath: string;
  densityPath: string;     densityTifPath: string;
  canopyCoverPath: string; canopyCoverTifPath: string;
  durationMs: number;
}

/** One horizontal slice of a stem taper (the QSM building block). */
export interface QsmSlice {
  /** Lower edge of the slice, height above ground (m). */
  hag: number;
  /** Absolute Z of the slice mid-height (m). */
  z: number;
  centerX: number;
  centerY: number;
  /** Fitted radius (m). */
  radius: number;
  /** Radial residual RMSE of the Kåsa fit (m). */
  rmse: number;
  nPoints: number;
  /** 12-sector angular coverage (0..1). 1.0 = fully encircled. */
  coverage: number;
  /** Bit-packed mask of the 12 sectors that had at least one point
   *  (bit i = sector centred at (i + 0.5) · 30°). Used by the rescan
   *  advisor to compute a per-tree shadow azimuth. Old QSM caches
   *  default to 0xFFF on read (fully encircled — no shadow info). */
  sectorMask?: number;
}

/** One reconstructed primary branch: PCA-axis cylinder + Kåsa radius
 *  on the perpendicular plane. Volume = π r² ℓ. */
export interface BranchCylinder {
  start: [number, number, number];
  end: [number, number, number];
  radius: number;
  length: number;
  volume: number;
  nVoxels: number;
  rmse: number;
}

/** Per-tree stem QSM (v1: stem + primary branches). */
export interface TreeQsm {
  treeId: number;
  baseX: number;
  baseY: number;
  baseZ: number;
  height: number;
  slices: QsmSlice[];
  /** Primary branches fit from non-stem voxel components. Empty when
   *  branch fitting was disabled in the run. */
  branches: BranchCylinder[];
  /** Sum of branch cylinder volumes (m³). 0 when branches off. */
  branchVolume: number;
  /** How many branches passed the geometry filter. */
  branchCount: number;
  /** stemVolume + branchVolume (m³). */
  totalVolume: number;
  /** Frustum-sum stem volume (m³). */
  stemVolume: number;
  /** 1σ uncertainty on `stemVolume` (m³) from analytic error
   *  propagation (per-slice σ_r = RMSE/√n, summed in quadrature via
   *  ∂V/∂r_i). */
  stemVolumeStd: number;
  /** 95 % CI half-width (= 1.96 · stemVolumeStd, m³). */
  stemVolumeCi95: number;
  /** Diameter at slice nearest 1.3 m (m). NaN if not covered. */
  dbh: number;
  /** Radius-weighted mean angular coverage across accepted slices (0..1). */
  confidence: number;
  /** Fraction of expected slices that produced a usable fit (0..1). */
  completeness: number;
  acceptedSlices: number;
  rejectedSlices: number;
  /** What the ported TreeQSM reports about this tree. Present only for
   *  the `treeqsm` branch method — the other methods build no model to
   *  measure. */
  treeqsm?: QsmAttributes;
}

/** The attributes a TreeQSM run reports, as `tree_data`,
 *  `crown_measures` and `point_model_distance` compute them.
 *
 *  Volumes are LITRES and areas square metres, as TreeQSM reports
 *  them; crown volumes are cubic metres, as it reports those. */
export interface QsmAttributes {
  totalVolume: number;
  trunkVolume: number;
  branchVolume: number;
  /** The model's own extent, base of the lowest cylinder to the top of
   *  the highest — not the height above the terrain, which `height`
   *  on the enclosing tree reports. */
  treeHeight: number;
  trunkLength: number;
  branchLength: number;
  totalLength: number;
  numberBranches: number;
  /** Of those, the ones that produced cylinders. */
  numberBranchesModelled: number;
  maxBranchOrder: number;
  trunkArea: number;
  branchArea: number;
  totalArea: number;
  /** Diameter at breast height off the cylinder chain (m). */
  dbhQsm: number;
  /** The same, refitted to the trunk's own points (m). */
  dbhCyl: number;
  crownDiamAve: number;
  crownDiamMax: number;
  crownAreaConv: number;
  crownAreaAlpha: number;
  crownBaseHeight: number;
  crownLength: number;
  crownRatio: number;
  crownVolumeConv: number;
  crownVolumeAlpha: number;
  /** How far the cloud sits from the model's surface (m). */
  pointDistanceMean: number;
  pointDistanceMax: number;
  pointDistanceTrunkMean: number;
  pointDistanceBranchMean: number;
  /** Cylinders no point was assigned to. Many of these means the model
   *  is inventing structure. */
  unsupportedCylinders: number;
  /** Which of TreeQSM's eight parameter sets won the sweep. */
  patchDiam1: number;
  patchDiam2Min: number;
  patchDiam2Max: number;
  /** `[height along the trunk, diameter there]`, base to top. */
  stemTaper: [number, number][];
}

/** Result of `octree_tree_qsm` (or a cached `octree_read_qsm`). */
export interface QsmResult {
  trees: TreeQsm[];
  totalStemVolume: number;
  /** 1σ uncertainty on the plot-total stem volume (m³), summed in
   *  quadrature across trees on the independence assumption. */
  totalStemVolumeStd: number;
  qsmPath: string;
  sliceHeight: number;
  minPointsPerSlice: number;
}

/** A parsed raster grid (from an ESRI ASCII grid). `values` is row-major
 *  with cy increasing northward (cy = 0 at yllcorner); NaN marks NODATA.
 *  vmin/vmax are the finite value range, for colour scaling. */
export interface RasterGrid {
  cols: number;
  rows: number;
  cellSize: number;
  minX: number;
  minY: number;
  values: Float32Array;
  vmin: number;
  vmax: number;
}

/** A scene object backed by a raster (DTM / DSM / CHM), shown in 3D and
 *  toggled from the Layers panel. `grid` is null while it loads. */
export interface RasterLayer {
  id: string;
  /** DTM/DSM/CHM are the elevation/canopy surfaces. The rest are
   *  geomorphometric / hydrological derivatives computed from the
   *  DTM by `octree_terrain` in a single pass — slope + aspect +
   *  TPI (Horn 1981 / Weiss 2001), sink-filled DEM (Wang & Liu
   *  2006), flow accumulation + TWI (Beven & Kirkby 1979), stream
   *  network mask, plan + profile curvature (Zevenbergen & Thorne
   *  1987), TRI (Riley 1999), HLI (McCune & Keon 2002). */
  kind: 'dtm' | 'dsm' | 'chm' | 'slope' | 'aspect' | 'tpi'
      | 'filled' | 'flow_accum' | 'twi' | 'streams'
      | 'plan_curv' | 'profile_curv' | 'tri' | 'hli'
      | 'hillshade' | 'hillshade_multi'
      // Forestry density metrics — gridded HAG statistics from
      // octree_density_metrics. Same grid + georef as the terrain
      // rasters; foresters opt in from the Density panel.
      | 'height_mean' | 'height_sd' | 'height_cv' | 'height_skew' | 'height_kurt'
      | 'height_p25' | 'height_p50' | 'height_p75' | 'height_p90' | 'height_p95'
      | 'density' | 'canopy_cover';
  label: string;
  visible: boolean;
  grid: RasterGrid | null;
  /** Surface opacity 0..1 (default 1 = opaque). */
  opacity?: number;
  /** Render as a wireframe instead of a filled surface. */
  wireframe?: boolean;
  /** Optional aligned elevation grid: when set, each cell's surface sits
   *  at `elevationGrid.value + grid.value` instead of just `grid.value`.
   *  Used to drape the CHM (a height-above-ground relief) onto the ground
   *  so it renders at the real canopy elevation. */
  elevationGrid?: RasterGrid | null;
  /** The analysis-layer id this raster is saved under in the dataset's
   *  `layers/` folder — see src/layers/analysisLayers.ts. Unset for a
   *  raster that lives only in this session. */
  savedAs?: string;
}

export interface OctreeAttribute {
  name: string;
  type: string;
  byteSize: number;
}

/** Per-tree forestry metrics from octree_tree_metrics. Lengths in metres,
 *  areas in m². dbh / basalArea are NaN when the breast-height band was too
 *  sparse to fit a stem circle. */
export interface TreeMetric {
  treeId: number;
  count: number;
  height: number;
  dbh: number;
  basalArea: number;
  crownArea: number;
  crownDiameter: number;
  /** Stem BASE position — the stem axis carried down to the ground, not
   *  the breast-height cross-section. Breast height is not a fixed point
   *  on a tree: a stem left leaning by a storm carries its 1.3 m section
   *  sideways by 23 cm at 10° and 45 cm at 20°, and a stem swaying in
   *  wind moves too, so a plot scanned on a windy day and re-scanned on a
   *  calm one would disagree about where the same tree is. The base does
   *  not move — which is what the cross-epoch matcher needs, since it
   *  decides which tree is which by how far it moved. */
  x: number;
  y: number;
  baseZ: number;
  /** Stem lean from vertical (degrees), NaN when only one band could be
   *  fitted. Storm damage across a stand shows up directly here. */
  leanDeg: number;
  /** Where `dbh` came from. Absent (or 'algebraic') means the circle the
   *  metrics pass fitted across the whole breast-height band; 'stemFit'
   *  means the RANSAC cylinder from `octree_fit_stems` replaced it.
   *
   *  Set on the frontend by `mergeStemFits`, never sent by Rust. It rides
   *  along with the row because the alternative — a count returned beside
   *  the array — cannot say WHICH tree was refined, and a panel showing a
   *  diameter should be able to say what that particular number rests on. */
  dbhSource?: 'algebraic' | 'stemFit';
}

/** Per-tree RANSAC stem fit from octree_fit_stems. dbh is NaN when no
 *  cylinder reached the inlier threshold. rmse is the radial residual of
 *  the inlier circle (m) — a fit-quality flag. */
export interface StemFit {
  treeId: number;
  dbh: number;
  centerX: number;
  centerY: number;
  inlierCount: number;
  bandCount: number;
  rmse: number;
  writtenStemPoints: number;
}

export interface OctreeTile {
  chunkIdx: number;
  gridXyz: [number, number, number];
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
  byteOffset: number;
  byteSize: number;
  pointCount: number;
  recordOffset: number;
  recordCount: number;
}

/** One numeric extra column carried into the octree from the source file
 *  (LAS Extra-Bytes). Stored as a trailing f32 per point on disk. The
 *  observed min/max — recorded by the converter — drive the colour ramp
 *  the Display panel exposes for this extra. */
export interface OctreeExtra {
  name: string;
  min: number;
  max: number;
}

/** A dataset's recorded coordinate reference system: either a lookup
 *  into the curated table (`epsg`, resolved server-side by crs_list /
 *  crs_transform) or a user-supplied raw proj4 definition (`proj`) for
 *  a CRS the table doesn't carry — either way paired with a display
 *  label. Set via `octree_set_crs`; see the Layers panel's Coordinate
 *  system row. This is metadata only — recording it never moves a
 *  point (see that command's doc comment in commands/octree.rs). */
export type OctreeCrs =
  | { epsg: number; label: string }
  | {
      proj: string;
      label: string;
      /** Present only on a dataset the importer CONVERTED to metres.
       *
       *  PointCloudLabeler measures in metres and not by convention — breast height
       *  is the literal 1.3, density is kg/m³, per-hectare figures
       *  divide by an area in m². 1347 of the registry's 8017 codes are
       *  foot-based (the US State Plane zones most American LiDAR is
       *  delivered in), so a file declaring one is scaled to metres on
       *  the way in and records the SAME projection expressed in metres
       *  — hence a proj string and not an EPSG code, since most foot
       *  zones have no metric twin in the registry. These three keys
       *  keep the file's own coordinate system recoverable: exporting
       *  to `epsg:{sourceEpsg}` hands the points back exactly as they
       *  arrived. See `import_unit_conversion` in
       *  src-tauri/src/commands/octree.rs. */
      sourceEpsg?: number;
      sourceUnitToMetre?: number;
      sourceVerticalUnitToMetre?: number;
    };

/** What a dataset's Z values are heights above — mirrors `VerticalDatum`
 *  in src-tauri/src/commands/octree.rs. */
export type VerticalDatum = 'ellipsoidal' | 'orthometric';

/** A dataset's recorded vertical reference — mirrors `VerticalCrs` in
 *  src-tauri/src/commands/octree.rs. Set via `octree_set_vertical_crs`;
 *  see the Layers panel's Height row. Deliberately independent of
 *  `OctreeCrs`: a dataset routinely has a confident horizontal CRS and
 *  an unrecorded vertical one. This is metadata only — recording it
 *  never touches a single Z value (see that command's doc comment,
 *  commands/octree.rs's "Vertical datum" section, for why guessing
 *  instead would be actively dangerous). */
export interface VerticalCrs {
  datum: VerticalDatum;
  /** Geoid model file name (e.g. "egm96_15.gtx") the height system is
   *  realised through, when known — lets a later export back to
   *  ellipsoidal undo exactly the correction that was applied. */
  geoid?: string;
  /** Human name of the height system ("N2000", "NAVD88"), for display. */
  label?: string;
  /** EPSG code of the vertical CRS (e.g. 3900 = N2000, 5703 = NAVD88).
   *  Recorded so an export can DECLARE what its heights are measured
   *  from — a geoid file name is not a vertical CRS, so without a code
   *  there is nothing standard to write into the file. */
  epsg?: number;
}

/** One entry in the curated CRS table returned by the `crs_list`
 *  command — mirrors `CrsEntry` in src-tauri/src/commands/crs.rs. The
 *  front end reads this instead of hardcoding a second copy of the
 *  table. */
export interface CrsListEntry {
  epsg: number;
  label: string;
  proj: string;
}

/** One result from the full-registry `crs_lookup` / `crs_search`
 *  commands — mirrors `EpsgLookupEntry` in src-tauri/src/commands/crs.rs.
 *  Distinct shape from `CrsListEntry` (that one is the curated
 *  shortlist's own epsg/label/proj triple): code/name/proj4, matching
 *  what those two commands actually return, so any of the ~8000 EPSG
 *  registry entries — not just the curated ~190 — can be found by code
 *  or a name fragment (the Export dialog's coordinate-system search). */
export interface EpsgLookupEntry {
  code: number;
  name: string;
  proj4: string;
}

/** One grid table inside an NTv2 `.gsb` file, as proj4rs parsed it —
 *  mirrors `NadGridInfo` in src-tauri/src/commands/nadgrid.rs. A single
 *  file can hold more than one (a root grid plus denser nested
 *  sub-grids covering part of its extent). `details` is proj4rs's own
 *  text description (extent, node spacing, matrix size) meant to be
 *  shown verbatim — see that struct's doc comment for why it is not
 *  re-derived here. */
export interface NadGridInfo {
  root: boolean;
  rows: number;
  cols: number;
  nodes: number;
  details: string;
}

/** One `.gsb` file found in a folder `nadgrid_status` searched — mirrors
 *  `NadGridFile` in src-tauri/src/commands/nadgrid.rs.
 *
 *  `checked` is false for a file too large to parse just to verify it
 *  (see MAX_VERIFY_BYTES in that module — Germany's BWTA2017.gsb is
 *  ~390 MB); `ok` is meaningless when `checked` is false, and it is NOT
 *  a failure, just an unopened file that will load on first real use.
 */
export interface NadGridFile {
  file: string;
  dir: string;
  sizeBytes: number;
  checked: boolean;
  ok: boolean;
  error: string | null;
  grids: NadGridInfo[];
}

/** Result of the `nadgrid_status` / `nadgrid_set_dir` commands — mirrors
 *  `NadGridStatus` in src-tauri/src/commands/nadgrid.rs. See the Layers
 *  panel's Geodetic data row.
 *
 *  `dir` is only the folder the user configured (null if never set).
 *  `searched` is every folder actually searched, in priority order —
 *  it also picks up PROJ_NADGRIDS / PROJ_DATA when those are set, so a
 *  grid can resolve (and `searched` be non-empty) even while `dir` is
 *  null. */
export interface NadGridStatus {
  dir: string | null;
  dirExists: boolean;
  searched: string[];
  files: NadGridFile[];
  restartRequired: boolean;
}

/** One `.gtx` geoid grid file found in a folder `geoid_status` searched —
 *  mirrors `GeoidGridFile` in src-tauri/src/commands/geoid.rs. Same
 *  checked/ok/error contract as `NadGridFile`: `checked` false means
 *  "too large to verify eagerly" (see MAX_VERIFY_BYTES in that module),
 *  NOT a failure — `ok` is meaningless then. Extent fields are only
 *  known once the file has actually parsed, hence nullable rather than a
 *  zeroed default that could read as a real (if implausible) 0×0 grid. */
export interface GeoidGridFile {
  file: string;
  dir: string;
  sizeBytes: number;
  checked: boolean;
  ok: boolean;
  error: string | null;
  south: number | null;
  north: number | null;
  west: number | null;
  east: number | null;
  rows: number | null;
  cols: number | null;
}

/** Result of the `geoid_status` command — mirrors `GeoidStatus` in
 *  src-tauri/src/commands/geoid.rs. See the Layers panel's Geodetic data
 *  row, which lists these alongside `NadGridFile`s (same shared folder).
 *
 *  Deliberately has no `restartRequired`, unlike `NadGridStatus`: that
 *  flag exists because proj4rs leaks a loaded NTv2 grid into a
 *  process-global catalog with no eviction, so a grid from a folder no
 *  longer searched can stay resident. geoid.rs's own cache is keyed by
 *  resolved file path, so a changed folder simply becomes a different
 *  cache key — there is nothing stale to warn about. See that module's
 *  `status()` doc comment. */
export interface GeoidStatus {
  dir: string | null;
  dirExists: boolean;
  searched: string[];
  files: GeoidGridFile[];
}

export interface OctreeMetadata {
  formatVersion: string;
  name: string;
  pointCount: number;
  boundingBox: { min: [number, number, number]; max: [number, number, number] };
  scale: [number, number, number];
  offset: [number, number, number];
  rootSpacing: number;
  maxDepth: number;
  tileGridSize: number;
  tileGlobalDepth: number;
  scannerType: 'TLS' | 'MLS' | 'ULS' | 'ALS' | 'other';
  pointBytes: number;
  attributes: OctreeAttribute[];
  /** Per-extra-column declaration in record order. Absent on v1 / v2
   *  octrees, present (possibly empty) from v3 onwards. */
  extras?: OctreeExtra[];
  /** Whole-cloud observed (min, max) raw intensity, recorded by the
   *  converter at import (Rust phase1_parallel_bin → write_metadata).
   *  Absent means "unknown" — either an octree built before this field
   *  existed, or a source with no usable intensity spread (every value
   *  identical, including all-zero) — never a stand-in for a real range.
   *  Lets the Display panel's intensity colour mode ramp over the whole
   *  cloud instead of renormalising per node (see colorNode in
   *  OctreeView.tsx); the `octree_intensity_range` command backfills it
   *  on demand for datasets imported before this existed. */
  intensityRange?: [number, number];
  /** The dataset's coordinate reference system, if the user has
   *  recorded one. Absent means unknown — PointCloudLabeler never assumes a CRS,
   *  since a wrong guess would make every later conversion silently
   *  wrong too. See `OctreeCrs`. */
  crs?: OctreeCrs;
  /** The dataset's vertical reference — what its Z values are heights
   *  ABOVE — if the user has recorded one. Absent means unknown, not
   *  ellipsoidal: PointCloudLabeler never guesses, because a wrong guess would
   *  silently double- (or never-) apply the geoid correction on export.
   *  See `VerticalCrs` and commands/octree.rs's "Vertical datum"
   *  section. */
  vertical?: VerticalCrs;
  tiles: OctreeTile[];
  createdAt: string;
}

export interface OctreeNodeRecord {
  childMask: number;
  level: number;
  numPoints: number;
  byteOffset: number;
  byteSize: number;
}

/** Open dataset — held in memory by the editor while the user is
 *  viewing the cloud. The records array is the full hierarchy.bin
 *  decoded; large datasets may have hundreds of thousands of entries
 *  but each is only 24 bytes so a million records is 24 MB — fine. */
export interface OpenOctree {
  dir: string;
  meta: OctreeMetadata;
  records: OctreeNodeRecord[];
  /** Index into `records` for each tile's depth-first subtree start.
   *  Equals tile.recordOffset for tile i; kept as a flat array so
   *  per-tile lookups are O(1). */
  tileRecordStarts: number[];
  /** Pre-computed per-record geometry index used by the LOD planner:
   *  bbox, centre, world-space radius, spacing, parent tile, children
   *  record indices. Built once on open so the priority-queue traversal
   *  can refine into children in O(1). */
  index: OctreeIndex;
}

/** Flat per-record geometry index. Parallel typed arrays so the planner
 *  hot loop never allocates. `children` uses CSR-style flat layout —
 *  record i's children sit at childrenFlat[childrenStart[i]..start[i+1]],
 *  in octant order matching the converter's depth-first walk. */
export interface OctreeIndex {
  recordCount: number;
  /** Tile index per record. */
  tileOf: Int32Array;
  /** Tile-local depth per record (0 = tile root). */
  levelOf: Int32Array;
  /** 6 doubles per record (minX, minY, minZ, maxX, maxY, maxZ) in the
   *  source CRS (matching tile.bboxMin/Max — caller subtracts offset). */
  bbox: Float64Array;
  /** Centre, 3 doubles per record. */
  centre: Float64Array;
  /** World-space bounding-sphere radius (= sqrt(3)/2 * nodeSide). */
  radius: Float64Array;
  /** Node spacing in world units (rootSpacing / 2^globalLevel). */
  spacing: Float32Array;
  /** CSR offsets — childrenStart[i+1] − childrenStart[i] = arity of i. */
  childrenStart: Int32Array;
  childrenFlat: Int32Array;
}

type DesktopApi = {
  octreeList?: (projectFolder: string) => Promise<OctreeListEntry[]>;
  octreeReadMeta?: (octreeDir: string) => Promise<{ metadata: OctreeMetadata; hierarchy: OctreeNodeRecord[] }>;
  octreeReadBlock?: (octreeDir: string, byteOffset: number, byteSize: number) => Promise<ArrayBuffer>;
  octreeReadBlockColumns?: (
    octreeDir: string, byteOffset: number, byteSize: number,
    pointBytes: number, fields: Array<[number, number]>,
  ) => Promise<ArrayBuffer>;
};

function getApi(): DesktopApi | null {
  const api = (window as unknown as { desktop?: DesktopApi }).desktop;
  return api?.octreeList ? api : null;
}

/** Discover the octree datasets stored under <projectFolder>/octrees/. */
export async function listOctrees(projectFolder: string): Promise<OctreeListEntry[]> {
  const api = getApi();
  if (!api?.octreeList) return [];
  return api.octreeList(projectFolder);
}

/** Load the metadata + full hierarchy for one dataset. */
export async function openOctree(dir: string): Promise<OpenOctree> {
  const api = getApi();
  if (!api?.octreeReadMeta) throw new Error('Octree reader unavailable in this build.');
  const { metadata, hierarchy } = await api.octreeReadMeta(dir);
  // tile.recordOffset is set by the Rust converter and matches the
  // tile's first record in `hierarchy` exactly — but we materialise an
  // explicit per-tile start index in case future writers change the
  // layout (e.g. interleaved tiles for read efficiency).
  const tileRecordStarts = metadata.tiles.map(t => t.recordOffset);
  const index = buildIndex(metadata, hierarchy, tileRecordStarts);
  // Opening anyway, loudly. A structurally wrong index still renders a
  // cloud that looks right — the points carry their own coordinates —
  // so refusing the dataset would cost the user more than it saves, but
  // saying nothing would leave them debugging "it's slow" against a file
  // that is actually broken.
  const problems = indexProblems(metadata, hierarchy, index);
  if (problems.length > 0) {
    console.warn(`[octree] ${dir}: hierarchy index is inconsistent\n  ${problems.join('\n  ')}`);
  }
  return { dir, meta: metadata, records: hierarchy, tileRecordStarts, index };
}

/** A record index that no node occupies.
 *
 *  levelOf, tileOf and childrenFlat are pre-filled with this rather than
 *  left at 0, because 0 is a REAL record — tile 0's root. A hierarchy
 *  whose childMask tree does not match its recordCount leaves slots
 *  unwritten, and at 0 those slots quietly name the first tile root as
 *  somebody's child: the LOD tree comes out wrong, the points still draw
 *  from their own coordinates, and nothing looks broken. */
export const NO_RECORD = -1;

/** Build the flat per-record geometry index from the loaded hierarchy.
 *  Walks every tile's depth-first subtree once and emits per-record
 *  bbox/centre/radius/spacing + a CSR adjacency list of children record
 *  indices. Cost is O(records) and runs once per dataset on open.
 *
 *  The walk must reproduce the writer's, exactly. Both are pre-order
 *  depth-first over octants 0..7, with octant = (z>0)<<2 | (y>0)<<1 |
 *  (x>0) — six lines of subdivision arithmetic written out once in
 *  src-tauri/src/commands/octree.rs (Aabb::child) and once here. Nothing
 *  makes them agree; a divergence would give every node below the first
 *  difference the wrong bbox, and since points carry their own
 *  coordinates the cloud would still LOOK right. Only the culling, the
 *  LOD choice and the eviction would be wrong, which reads as "slow" and
 *  "that patch never loaded". See indexProblems for the cross-check the
 *  file itself makes possible. */
export function buildIndex(
  meta: OctreeMetadata,
  records: OctreeNodeRecord[],
  tileRecordStarts: number[],
): OctreeIndex {
  const n = records.length;
  const tileOf = new Int32Array(n).fill(NO_RECORD);
  const levelOf = new Int32Array(n).fill(NO_RECORD);
  const bbox = new Float64Array(n * 6);
  const centre = new Float64Array(n * 3);
  const radius = new Float64Array(n);
  const spacing = new Float32Array(n);
  // First pass: count children per record so we can allocate the CSR
  // arrays exactly. Children = number of set bits in childMask.
  const arity = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let m = records[i].childMask;
    let c = 0;
    while (m) { m &= m - 1; c++; }
    arity[i] = c;
  }
  const childrenStart = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) childrenStart[i + 1] = childrenStart[i] + arity[i];
  const childrenFlat = new Int32Array(childrenStart[n]).fill(NO_RECORD);

  // Second pass: depth-first walk per tile, materialise per-record
  // bbox/centre/radius/spacing + populate childrenFlat slots in order.
  // Each tile's records sit contiguously starting at recordOffset.
  const childWriteOffset = new Int32Array(n); // running cursor inside each parent's slot
  const sqrt3half = Math.sqrt(3) * 0.5;
  const tileRootSpacing = meta.rootSpacing / (1 << meta.tileGlobalDepth);

  for (let t = 0; t < meta.tiles.length; t++) {
    const tile = meta.tiles[t];
    const start = tileRecordStarts[t];
    const end = start + tile.recordCount;
    let cursor = start;
    // Walk the tile's depth-first records: each call consumes one
    // record, fills its data, then descends into each set child bit.
    const recurse = (level: number, b: [number, number, number, number, number, number], parent: number): void => {
      if (cursor >= end) return;
      const idx = cursor++;
      tileOf[idx] = t;
      levelOf[idx] = level;
      bbox[idx * 6 + 0] = b[0]; bbox[idx * 6 + 1] = b[1]; bbox[idx * 6 + 2] = b[2];
      bbox[idx * 6 + 3] = b[3]; bbox[idx * 6 + 4] = b[4]; bbox[idx * 6 + 5] = b[5];
      const cx = 0.5 * (b[0] + b[3]);
      const cy = 0.5 * (b[1] + b[4]);
      const cz = 0.5 * (b[2] + b[5]);
      centre[idx * 3] = cx; centre[idx * 3 + 1] = cy; centre[idx * 3 + 2] = cz;
      const side = Math.max(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
      radius[idx] = sqrt3half * side;
      // Spacing halves with each tile-local level.
      spacing[idx] = tileRootSpacing / (1 << level);
      if (parent >= 0) {
        const slot = childrenStart[parent] + childWriteOffset[parent]++;
        childrenFlat[slot] = idx;
      }
      const rec = records[idx];
      for (let o = 0; o < 8; o++) {
        if ((rec.childMask & (1 << o)) === 0) continue;
        const ccx = cx, ccy = cy, ccz = cz;
        const xlo = (o & 1) === 0 ? b[0] : ccx;
        const xhi = (o & 1) === 0 ? ccx : b[3];
        const ylo = (o & 2) === 0 ? b[1] : ccy;
        const yhi = (o & 2) === 0 ? ccy : b[4];
        const zlo = (o & 4) === 0 ? b[2] : ccz;
        const zhi = (o & 4) === 0 ? ccz : b[5];
        recurse(level + 1, [xlo, ylo, zlo, xhi, yhi, zhi], idx);
      }
    };
    recurse(0, [
      tile.bboxMin[0], tile.bboxMin[1], tile.bboxMin[2],
      tile.bboxMax[0], tile.bboxMax[1], tile.bboxMax[2],
    ], -1);
  }

  return {
    recordCount: n, tileOf, levelOf, bbox, centre, radius, spacing,
    childrenStart, childrenFlat,
  };
}

/** Structural problems in a built index, most useful first.
 *
 *  The reader derives each node's level, bbox and parentage by walking
 *  the childMask tree; the writer independently stored a level in every
 *  record. Nothing in PointCloudLabeler reads that stored level — so the file
 *  carries a free, unused check on whether the two walks agree, and a
 *  desynchronised reader and writer is precisely the failure this
 *  module cannot otherwise notice. The cloud draws from the points' own
 *  coordinates and looks perfectly correct; only the culling, the LOD
 *  choice and the eviction go wrong, which the user reads as "slow" and
 *  "that patch never loaded".
 *
 *  The stored level is GLOBAL — tile-local plus tileGlobalDepth — so a
 *  tile root reads 3, not 0. See the hierarchy.bin layout note in
 *  octree.rs, whose wording said otherwise for as long as nobody
 *  compared them.
 *
 *  Returns [] for a healthy index. Empty input is healthy, not broken. */
export function indexProblems(
  meta: OctreeMetadata,
  records: OctreeNodeRecord[],
  index: OctreeIndex,
): string[] {
  const out: string[] = [];
  const n = records.length;
  const depth = meta.tileGlobalDepth ?? 0;

  let unwalked = 0;
  let firstUnwalked = -1;
  for (let i = 0; i < n; i++) {
    if (index.levelOf[i] === NO_RECORD) {
      if (unwalked === 0) firstUnwalked = i;
      unwalked++;
    }
  }
  if (unwalked > 0) {
    out.push(
      `${unwalked} of ${n} records were never reached by the tile walk `
      + `(first: ${firstUnwalked}) — the childMask tree and the tiles' `
      + `recordCount disagree, so those nodes have no bbox and never load.`,
    );
  }

  // The stored level is a u8 capped at 255 by the writer, so a very deep
  // tree saturates and stops being comparable. Not a defect; skip those.
  let mismatched = 0;
  let firstMismatch = '';
  for (let i = 0; i < n; i++) {
    const walked = index.levelOf[i];
    if (walked === NO_RECORD) continue;
    const stored = records[i].level;
    if (stored >= 255) continue;
    if (walked + depth !== stored) {
      if (mismatched === 0) {
        firstMismatch = `record ${i}: walked ${walked} + tileGlobalDepth ${depth} != stored ${stored}`;
      }
      mismatched++;
    }
  }
  if (mismatched > 0) {
    out.push(
      `${mismatched} of ${n} records sit at a different depth than the `
      + `writer recorded (${firstMismatch}) — the reader's walk and the `
      + `writer's no longer agree, so every node below the first `
      + `difference has the wrong bbox. Points still draw correctly; `
      + `culling, LOD and eviction do not.`,
    );
  }

  let unfilled = 0;
  let outOfRange = 0;
  for (let k = 0; k < index.childrenFlat.length; k++) {
    const c = index.childrenFlat[k];
    if (c === NO_RECORD) unfilled++;
    else if (c < 0 || c >= n) outOfRange++;
  }
  if (unfilled > 0) {
    out.push(`${unfilled} child slots were never filled — some parents claim more children than the walk found.`);
  }
  if (outOfRange > 0) {
    out.push(`${outOfRange} child slots point outside the record array.`);
  }

  const tiles = meta.tiles?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const t = index.tileOf[i];
    if (t === NO_RECORD) continue;
    if (t < 0 || t >= tiles) {
      out.push(`record ${i} is assigned to tile ${t}, which does not exist (${tiles} tiles).`);
      break;
    }
  }

  return out;
}

/** Fetch a single node block's raw bytes. The caller owns parsing — see
 *  decodeNodePoints below for the standard 20-byte point layout. */
export async function readBlock(dir: string, byteOffset: number, byteSize: number): Promise<ArrayBuffer> {
  const api = getApi();
  if (!api?.octreeReadBlock) throw new Error('Octree reader unavailable in this build.');
  return api.octreeReadBlock(dir, byteOffset, byteSize);
}

/** Decode a node's raw bytes into typed arrays. The on-disk layout is
 *  20 bytes/point: i32 X, i32 Y, i32 Z, i32 tree_id, u16 intensity,
 *  u8 classification, u8 return_number. World position is reconstructed
 *  from int32 quantisation via the dataset's scale + offset; the
 *  Y/Z swap mirrors the rest of the editor (Three.js Y-up). */
export interface DecodedNode {
  /** Float32Array of length count*3, [x, y_height, z_north] per point —
   *  same layout as ParsedCloud.positions. */
  positions: Float32Array;
  treeIds: Int32Array;
  intensity: Uint16Array;
  classification: Uint8Array;
  returnNumber: Uint8Array;
  /** Per-point pre-existing semantic label from the file (1 stem,
   *  2 branch, 0 unlabelled). Present only on v2+ octrees; v1 readers
   *  see an all-zero buffer. The editor's PatchStore overrides this
   *  in-memory without rewriting octree.bin. */
  semantic: Uint8Array;
  /** Per-extra-column Float32Array (length = count), keyed by the
   *  extra's name from metadata.extras. Empty object on v1 / v2 files
   *  or v3 files imported without extras. */
  extras: Record<string, Float32Array>;
  count: number;
}

export function decodeNodePoints(
  bytes: ArrayBuffer,
  scale: [number, number, number],
  offset: [number, number, number],
  /** Per-point byte count from metadata.pointBytes — 20 for v1, 21 for
   *  v2 (carries semantic), 21 + 4*N for v3 (carries N f32 extras).
   *  Falls back to 20 if undefined so the function stays
   *  backwards-compatible. */
  pointBytes: number = 20,
  /** Names of the extra columns in record order, matched against
   *  metadata.extras. Empty / undefined skips the trailing extras even
   *  if pointBytes implies they're present. */
  extraNames: readonly string[] = [],
  /** When given, only extras whose name is in this set are materialised
   *  as Float32Arrays — the rest are skipped entirely. On clouds with
   *  many extra columns this is the difference between 4·N bytes/point
   *  of decoded arrays nobody is looking at and just the one column the
   *  active colour mode needs (a missing column can be decoded later
   *  from a block re-read — see decodeExtraColumn). Undefined = all. */
  wantedExtras?: ReadonlySet<string>,
): DecodedNode {
  const dv = new DataView(bytes);
  const count = (bytes.byteLength / pointBytes) | 0;
  const positions = new Float32Array(count * 3);
  const treeIds = new Int32Array(count);
  const intensity = new Uint16Array(count);
  const classification = new Uint8Array(count);
  const returnNumber = new Uint8Array(count);
  const semantic = new Uint8Array(count);
  // v2 layout writes the semantic byte right after return_number, at
  // offset 20. v3 then appends N trailing f32 extras (4 bytes each) in
  // the order given by extraNames. pointBytes must equal 21 + 4*N when
  // extras are present, but we don't enforce — the cap on the f32 read
  // is whatever pointBytes − 21 fits.
  const hasSemantic = pointBytes >= 21;
  const nExtras = Math.max(0, Math.min(extraNames.length, Math.floor((pointBytes - 21) / 4)));
  const extras: Record<string, Float32Array> = {};
  // Decode plan: (column index, output array) for each wanted extra.
  const plan: Array<{ off: number; arr: Float32Array }> = [];
  for (let k = 0; k < nExtras; k++) {
    const name = extraNames[k];
    if (wantedExtras && !wantedExtras.has(name)) continue;
    const arr = new Float32Array(count);
    extras[name] = arr;
    plan.push({ off: 21 + k * 4, arr });
  }
  for (let i = 0; i < count; i++) {
    const o = i * pointBytes;
    const xi = dv.getInt32(o, true);
    const yi = dv.getInt32(o + 4, true);
    const zi = dv.getInt32(o + 8, true);
    const tid = dv.getInt32(o + 12, true);
    const intensityVal = dv.getUint16(o + 16, true);
    const cls = dv.getUint8(o + 18);
    const ret = dv.getUint8(o + 19);
    const sem = hasSemantic ? dv.getUint8(o + 20) : 0;
    const xWorld = xi * scale[0] + offset[0];
    const yWorld = yi * scale[1] + offset[1];
    const zWorld = zi * scale[2] + offset[2];
    // Survey (east, north, up) → scene (x, y, z). See sceneAxes.
    writeScenePosition(
      positions, i,
      xWorld - offset[0], yWorld - offset[1], zWorld - offset[2],
    );
    treeIds[i] = tid;
    intensity[i] = intensityVal;
    classification[i] = cls;
    returnNumber[i] = ret;
    semantic[i] = sem;
    for (let k = 0; k < plan.length; k++) {
      plan[k].arr[i] = dv.getFloat32(o + plan[k].off, true);
    }
  }
  return { positions, treeIds, intensity, classification, returnNumber, semantic, extras, count };
}

/** Decode ONE extra column out of a node's raw bytes — used to hydrate a
 *  column that loadNode skipped (lazy extras): the caller re-reads the
 *  node's block from disk and pulls just this column's f32s out of it.
 *  `k` is the column's index in metadata.extras (record order). */
export function decodeExtraColumn(
  bytes: ArrayBuffer,
  pointBytes: number,
  k: number,
): Float32Array {
  const dv = new DataView(bytes);
  const count = (bytes.byteLength / pointBytes) | 0;
  const off = 21 + k * 4;
  const out = new Float32Array(count);
  if (off + 4 > pointBytes) return out; // column out of range — all zeros
  for (let i = 0; i < count; i++) {
    out[i] = dv.getFloat32(i * pointBytes + off, true);
  }
  return out;
}

/** Read + decode one node, transferring only the columns the renderer
 *  needs — the RDB2-style streaming path. When the desktop bridge offers
 *  the column-extracting read, the IPC payload is the base fields
 *  (21 B/point) plus just the wanted extras instead of the full record
 *  stride; on a cloud carrying many extra columns that's most of the
 *  per-tile transfer + decode cost gone. Falls back to the whole-block
 *  read + decodeNodePoints anywhere the bridge predates the command, so
 *  behaviour is identical either way. */
export async function readNodePoints(
  dir: string,
  byteOffset: number,
  byteSize: number,
  scale: [number, number, number],
  offset: [number, number, number],
  pointBytes: number,
  extraNames: readonly string[],
  wantedExtras: ReadonlySet<string>,
): Promise<DecodedNode> {
  const api = getApi();
  if (!api?.octreeReadBlockColumns) {
    const bytes = await readBlock(dir, byteOffset, byteSize);
    return decodeNodePoints(bytes, scale, offset, pointBytes, extraNames, wantedExtras);
  }
  const hasSemantic = pointBytes >= 21;
  // Request order defines the section order of the returned buffer.
  const fields: Array<[number, number]> = [
    [0, 12],   // xyz (3 × i32)
    [12, 4],   // tree_id (i32)
    [16, 2],   // intensity (u16)
    [18, 1],   // classification
    [19, 1],   // return_number
  ];
  if (hasSemantic) fields.push([20, 1]);
  // Wanted extras, in metadata.extras record order so the decode below
  // can walk extraKs and the returned sections in lock-step.
  const extraKs: number[] = [];
  const nExtras = Math.max(0, Math.floor((pointBytes - 21) / 4));
  for (let k = 0; k < Math.min(extraNames.length, nExtras); k++) {
    if (!wantedExtras.has(extraNames[k])) continue;
    fields.push([21 + k * 4, 4]);
    extraKs.push(k);
  }

  const buf = await api.octreeReadBlockColumns(dir, byteOffset, byteSize, pointBytes, fields);
  const count = (byteSize / pointBytes) | 0;
  const dv = new DataView(buf);

  const positions = new Float32Array(count * 3);
  const treeIds = new Int32Array(count);
  const intensity = new Uint16Array(count);
  const classification = new Uint8Array(count);
  const returnNumber = new Uint8Array(count);
  const semantic = new Uint8Array(count);
  const extras: Record<string, Float32Array> = {};

  let s = 0; // running section start within the SoA buffer
  // xyz — same world reconstruction + axis remap as decodeNodePoints
  // (sceneX = east, sceneY = up, sceneZ = −north).
  for (let i = 0; i < count; i++) {
    const o = s + i * 12;
    const xWorld = dv.getInt32(o, true) * scale[0] + offset[0];
    const yWorld = dv.getInt32(o + 4, true) * scale[1] + offset[1];
    const zWorld = dv.getInt32(o + 8, true) * scale[2] + offset[2];
    writeScenePosition(
      positions, i,
      xWorld - offset[0], yWorld - offset[1], zWorld - offset[2],
    );
  }
  s += count * 12;
  for (let i = 0; i < count; i++) treeIds[i] = dv.getInt32(s + i * 4, true);
  s += count * 4;
  for (let i = 0; i < count; i++) intensity[i] = dv.getUint16(s + i * 2, true);
  s += count * 2;
  for (let i = 0; i < count; i++) classification[i] = dv.getUint8(s + i);
  s += count;
  for (let i = 0; i < count; i++) returnNumber[i] = dv.getUint8(s + i);
  s += count;
  if (hasSemantic) {
    for (let i = 0; i < count; i++) semantic[i] = dv.getUint8(s + i);
    s += count;
  }
  for (const k of extraKs) {
    const arr = new Float32Array(count);
    for (let i = 0; i < count; i++) arr[i] = dv.getFloat32(s + i * 4, true);
    s += count * 4;
    extras[extraNames[k]] = arr;
  }

  return { positions, treeIds, intensity, classification, returnNumber, semantic, extras, count };
}

/** Fetch ONE extra column of a node — the lazy-extras hydration path.
 *  The columnar read transfers just count×4 bytes when available;
 *  otherwise re-reads the whole block and extracts client-side. */
export async function readExtraColumn(
  dir: string,
  byteOffset: number,
  byteSize: number,
  pointBytes: number,
  k: number,
): Promise<Float32Array> {
  const api = getApi();
  if (api?.octreeReadBlockColumns) {
    const buf = await api.octreeReadBlockColumns(dir, byteOffset, byteSize, pointBytes, [[21 + k * 4, 4]]);
    const count = (byteSize / pointBytes) | 0;
    const dv = new DataView(buf);
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = dv.getFloat32(i * 4, true);
    return out;
  }
  const bytes = await readBlock(dir, byteOffset, byteSize);
  return decodeExtraColumn(bytes, pointBytes, k);
}

/** Fetch the fields the deep-selection pass needs from one node —
 *  positions (scene coords), tree ids and classification, 17 bytes/point
 *  over the columnar IPC. Tree id + class ride along so the pass can
 *  replicate the viewer's visibility filters (isolate / hide-unassigned /
 *  class hides) on points that aren't streamed in: a paint selection must
 *  not grab points the user can't even see through the active filters. */
export async function readNodeSelectData(
  dir: string,
  byteOffset: number,
  byteSize: number,
  pointBytes: number,
  scale: [number, number, number],
  offset: [number, number, number],
): Promise<{ positions: Float32Array; treeIds: Int32Array; classification: Uint8Array }> {
  const api = getApi();
  const count = (byteSize / pointBytes) | 0;
  const positions = new Float32Array(count * 3);
  const treeIds = new Int32Array(count);
  const classification = new Uint8Array(count);
  if (api?.octreeReadBlockColumns) {
    const buf = await api.octreeReadBlockColumns(
      dir, byteOffset, byteSize, pointBytes,
      [[0, 12], [12, 4], [18, 1]],
    );
    const dv = new DataView(buf);
    for (let i = 0; i < count; i++) {
      const o = i * 12;
      const xWorld = dv.getInt32(o, true) * scale[0] + offset[0];
      const yWorld = dv.getInt32(o + 4, true) * scale[1] + offset[1];
      const zWorld = dv.getInt32(o + 8, true) * scale[2] + offset[2];
      // Same scene remap as decodeNodePoints (X east, Y up, Z = −north).
      writeScenePosition(
        positions, i,
        xWorld - offset[0], yWorld - offset[1], zWorld - offset[2],
      );
    }
    const tidBase = count * 12;
    for (let i = 0; i < count; i++) treeIds[i] = dv.getInt32(tidBase + i * 4, true);
    const clsBase = tidBase + count * 4;
    for (let i = 0; i < count; i++) classification[i] = dv.getUint8(clsBase + i);
    return { positions, treeIds, classification };
  }
  // Fallback: whole-block read, AoS walk.
  const dv = new DataView(await readBlock(dir, byteOffset, byteSize));
  for (let i = 0; i < count; i++) {
    const o = i * pointBytes;
    const xWorld = dv.getInt32(o, true) * scale[0] + offset[0];
    const yWorld = dv.getInt32(o + 4, true) * scale[1] + offset[1];
    const zWorld = dv.getInt32(o + 8, true) * scale[2] + offset[2];
    writeScenePosition(
      positions, i,
      xWorld - offset[0], yWorld - offset[1], zWorld - offset[2],
    );
    treeIds[i] = dv.getInt32(o + 12, true);
    classification[i] = dv.getUint8(o + 18);
  }
  return { positions, treeIds, classification };
}

