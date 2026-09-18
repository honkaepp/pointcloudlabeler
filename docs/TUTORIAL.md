# PointCloudLabeler tutorial — from raw LAZ to per-tree biomass

This walks through the typical PointCloudLabeler workflow: import a forest plot,
classify the ground, segment trees, fit QSMs, and read out per-tree
biomass with traceable uncertainty. It names the panels and the
parameter values as they appear in the program. A demo dataset to
follow along with is on Zenodo — <https://doi.org/10.5281/zenodo.22810788>:
two clouds of one forest plot (Evo, Finland), a 2021 terrestrial scan
with a corrected tree segmentation (1.1 GB) and a 2023 helicopter-borne
scan of the same plot (58 MB), the pair the Tree Skeleton Transfer
carries labels across. Or substitute your own.

## 0. Install

See [`README.md`](../README.md) for installation. Open PointCloudLabeler.

## 1. Create a project

`Project ▶ New Project… ▶ pick a folder`. The folder will hold the
project metadata, the imported octrees, terrain rasters, QSM cache
and exports. Nothing in this dialog is irreversible; you'll add the
point cloud in the next step.

## 2. Import a point cloud

There are two paths depending on what you have:

**A. LAS / LAZ direct** — in the **Editor** module, click "Import
LAS / LAZ" and pick your file. PointCloudLabeler builds an out-of-core
octree from it. For a typical forestry plot (50 M to 200 M points)
this takes a few minutes, and the run can be cancelled.

**B. A vendor scanner format** — in the **Preprocessing** module,
choose the importer for your file (ASTM E57, Leica Cyclone PTX / PTS,
or generic ASCII XYZ / CSV / TXT). Pick the file or folder, list the
scan positions, optionally crop to a bounding box, then export to a
combined LAS / LAZ. Import that result in the Editor as in path A.
RIEGL scans take the same road one step earlier: export them from
RiSCAN PRO as E57 or LAS/LAZ first.

For multi-position scans that need to be aligned across importers,
use the **Co-registration** panel in Preprocessing: pick three or
more matching tie points across two scans and click Solve. Refine
with ICP if needed.

## 3. Classify the ground

In the Editor, open the **Terrain** panel from the activity bar.
Choose either:

- **PMF** (Progressive Morphological Filter; Zhang et al. 2003) —
  fast, good on relatively flat terrain.
- **CSF** (Cloth Simulation Filter; Zhang et al. 2016) — robust on
  hilly terrain.

**Classify ground**. The ground points appear in light grey; the
result is written into the octree, so it survives a restart.

## 4. Compute terrain rasters

In the same **Terrain** panel, pick a cell size (0.5 m for plot-scale,
1 m for stand-scale) and compute the rasters. PointCloudLabeler produces three rasters in
`<project>/octrees/<name>/terrain/`:

- `dtm.asc` / `dtm.tif` — bare-earth elevation
- `dsm.asc` / `dsm.tif` — surface (canopy) elevation
- `chm.asc` / `chm.tif` — canopy height = DSM − DTM

The GeoTIFFs are georeferenced and drop straight into QGIS / ArcGIS.

## 5. Segment individual trees

Open the **Auto-segment** panel; its **Tree crowns (CHM watershed)**
drawer detects treetops on the CHM and grows crowns from them. The
defaults are sensible for boreal stands — a minimum tree height, and a
treetop search window that grows with height up to a cap — and each
field explains itself on hover. **Segment trees**. Each detected crown
gets a `tree_id`; the count appears in the panel.

Then open **Tree review ▶ Scan trees** to list the crowns and step
through them with ← / →. If you spot a missed tree or a merged crown,
edit interactively: lasso a selection and assign an id, or split and
merge from the review panel.

## 6. Per-tree metrics

In the **Metrics** module, pick the dataset and click Compute. For
each tree PointCloudLabeler measures:

- Height (max point above the bilinear DTM at the tree's XY)
- DBH (algebraic Taubin circle fit in the breast-height band)
- Basal area = π · (DBH/2)²
- Crown area + diameter (cell-based footprint)
- Stem centroid + base elevation

Optional: open the "Stem fit · RANSAC" section to refine the DBH
estimate with a cylinder fit. Inlier points can be labelled as
semantic class 1 (stem).

## 7. QSM — stem volume with uncertainty

Open the "Stem QSM · taper + volume" section in the Metrics
sidebar.

- **Slice height**: 0.25 m (default)
- **Min points / slice**: 15
- **Min tree height**: 3 m

Click "Compute QSM". For each tree this slices the stem into
horizontal bands, fits a Taubin circle to each, computes a 12-sector
angular coverage per slice, integrates frustum volumes between
consecutive slices, and propagates per-slice σ_r through the
volume sum to give an analytical 95 % CI.

For a full Raumonen 2013 TreeQSM with trunk segmentation, branch
hierarchy and cylinder chains:

- Check "Fit branches"
- Method: "TreeQSM (Raumonen 2013)"
- Branch voxel: 0.02 m

Click "Compute QSM (TreeQSM)". The QSM cache lives at
`<dataset>/qsm.json` so a reopened project skips the recompute.

## 8. Biomass and carbon

Open the "Biomass & carbon" section. Pick a species preset (Scots
pine, Norway spruce, birch, aspen, or oak) or choose "Custom…" and
type your own density + carbon fraction. The plot totals card row
shows:

- Σ stem volume (m³)
- Σ biomass (kg / t, scale auto-picked)
- Σ carbon (kg / t)
- Σ CO₂-equivalent (kg / t)

Each total carries a 95 % CI propagated in quadrature from the QSM
stem-volume CI + wood-density variation + carbon-fraction error.
Per-tree values appear in the metrics table.

## 9. Export

In the Metrics module: **Export CSV**. The CSV includes every column
visible in the table — per-tree metrics, RANSAC DBH refinement (if
run), QSM stem volume and 95 % CI, branch volume and total volume
(if branches were fit), biomass / carbon / CO₂e with CIs.

In the Editor: **File ▶ Export…** and pick LAS or LAZ to round-trip
back to a point cloud with tree_id, semantic, classification and
any Extra Bytes columns the dataset carries.

## Troubleshooting

- **Empty CHM** → ground classification didn't run. Step 3.
- **No trees found** → CHM watershed parameters too strict; lower
  the min-tree-height or the search-window radius.
- **DBH = —** in the table for tall trees → the breast-height
  band missed the stem at 1.3 m for that tree. Try the RANSAC stem
  fit, which uses a wider band and is robust to off-vertical stems.
- **QSM confidence < 50 %** on most trees → the stem was seen from
  one side only. Acquire additional scans from the missing
  azimuths.
- **TreeQSM gives 0 cylinders** → the cover-ball radius is too large
  for the data's point spacing. Try `branch_voxel = 0.015` or
  `0.025` and recompute.
