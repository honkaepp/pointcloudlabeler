# PointCloudLabeler tutorial — from raw LAZ to per-tree biomass

This walks through the typical PointCloudLabeler workflow: import a forest plot,
classify the ground, segment trees, fit QSMs, and read out per-tree
biomass with traceable uncertainty; chapter 10 covers the tools for
looking at, measuring and reviewing a plot along the way. It names
the panels and the parameter values as they appear in the program. A
demo dataset to follow along with is on Zenodo — <https://doi.org/10.5281/zenodo.22810788>:
two clouds of one forest plot (Evo, Finland), a 2021 terrestrial scan
with a corrected tree segmentation (1.1 GB) and a 2023 helicopter-borne
scan of the same plot (58 MB), the pair the Tree Skeleton Transfer
carries labels across. Or substitute your own.

## 0. Install

See [`README.md`](../README.md) for installation. Open PointCloudLabeler.

## 1. Create a project

A project is a folder: it holds the project metadata, the imported
octrees, terrain rasters, QSM cache and exports. There are two ways to
start one.

**From the data.** On the welcome screen, drop a point cloud (or a
folder of them) anywhere on the window, or press **File…** or
**Folder…** under **Open data**. With no project open, the **New
project** dialog comes up first, already named after the data and
placed where the last project was; press Enter and the data goes on
into the new project (chapter 2).

**Empty.** `Project ▶ New Project…` (or **New empty project** on the
welcome screen). The dialog asks only for a **Name**, a **Location**
and, optionally, a **Coordinate system**; Enter creates the project.
The coordinate system is the one the project records; each dataset you
import keeps its own. Change it later in the **Data** tab's header
(**Project coordinate system**).

**Renaming.** Click the project's name beside the logo in the module
bar, choose `Project ▶ Rename Project…`, or press ✎ beside a recent
project on the welcome screen. The folder is renamed on disk together
with the project's name, and the editor reopens the cloud it had open.
The rename is refused, with the reason, when the name has a character
Windows does not allow (`< > : " / \ | ? *`), ends in a dot, is a
reserved device name or is longer than 100 characters, when a folder of
that name already exists, when the editor has unsaved edits, or when a
conversion or unpacking is still running. If another program holds a
file of the project open (an Explorer window, a terminal, a sync
client), the dialog asks you to close it and try again.

A project renamed in your file manager shows under its new name in the
recent list. One moved somewhere else shows as *missing*: press
**Locate…** and pick the folder where it is now.

## 2. Import a point cloud

There are two paths depending on what you have:

**A. Open the data** — `File ▶ Open Data…` (works with no project open
too), **Open data…** on the editor's start view or in the **Data** tab,
the key **O** in the editor, or drag the file or folder onto any part
of the window (the window shows *Drop to open* while you drag). Where
it goes depends on what it is:

| You open | It goes to |
|---|---|
| LAS, LAZ, E57, PLY, TXT / XYZ / CSV | the editor's import; several are imported one after another |
| a `.zip` of point clouds | unpacked into the project's `imports/` folder, then imported as above |
| a PTX | the **Data** tab's PTX panel |
| a PointCloudLabeler project folder | opened |
| a folder | what it holds |
| a trajectory, scan positions, stems CSV, a GeoJSON or shapefile region, a mesh, a QSM | a layer over the cloud (chapter 10, *Layers from files*) |

The import dialog maps the file's columns and asks the **Scanner
type**; choose **Mobile (MLS)** for a mobile or handheld scan, as the
forest pass (chapter 5) tunes itself to it. PointCloudLabeler then
builds an out-of-core octree. For a typical forestry plot (50 M to
200 M points) this takes a few minutes, and the run can be cancelled.
Running conversions and unpackings show at the right end of the module
bar; click one to go to it.

**B. A scanner project to process first** — in the **Data** tab,
choose the importer for your file (ASTM E57, Leica Cyclone PTX / PTS,
or generic ASCII XYZ / CSV / TXT). Pick the file or folder, list the
scan positions, optionally crop to a bounding box, then export to a
combined LAS / LAZ. Open that result as in path A.

For multi-position scans that need to be aligned across importers,
use the **Co-registration** panel in the **Data** tab: pick three or
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

Open the **Auto-segment** panel. It offers two ways in: from the stems
up (the forest pass, for terrestrial and mobile scans that see the
stems) and from the canopy down (the CHM watershed, for clouds seen
from above).

### Forest pass: stems to trees

The **Forest — stems to trees** drawer at the top of the panel finds
the stems first (circles in thin slices above the ground, and the flow
of every branch down to them), then grows each tree from its stem over
the wood; foliage goes with the branch it hangs from. Wood and leaf
come from the local shape of the points and what each carries down to
the ground. It needs the ground classified (step 3).

- **Voxel**: 0.04 m (default). 4 cm keeps thin branches; 5–6 cm is
  faster on large or sparse clouds.
- **Ground cut**: 0.25 m. Grass and litter below it stay out of the
  graph; stem feet below it still get their tree.
- **Edge buffer**: 2 m, **Understory below**: 2 m. Trees this close to
  the edge of the data, or lower than this, are flagged *edge* or
  *understory*. Flags never remove a tree.
- **Use reflectance**: blends the cloud's Reflectance column into the
  wood call, when there is one.
- **Write stem / branch / leaf**: on by default. Writes the semantic
  labels too, so the QSM (step 7) models the wood only.

**Find stems and trees**. The run replaces every `tree_id` (and the
semantic labels, when ticked) and asks you to confirm first. The
stems, trees and the run's report are saved in the dataset's `forest/`
folder, and **Tree review** shows what the forest pass says about the
selected tree (at the edge of the data, understory, no stem circle
fitted, may be one tree with another).

The semantic codes mean the same everywhere: **1 stem, 2 branch,
4 leaf**. The forest pass writes them, so does the **Leaf–wood** drawer
further down the panel, and the **Tools** panel's **Semantic** buttons
**Stem**, **Branch** and **Leaf** (keys 1, 2 and 4) label a selection
by hand. The **Stems & wood** look (chapter 10) shows them.

**Correct the stems, then re-grow.** After a run the drawer's
**Stems** box lists the stems: green fitted, amber found from the flow
only, blue added by you. Choose a click mode and click in the view:
**Pick** shows a stem and the others of its tree, **Add** adds a missed
stem, **Merge** joins stems into one tree (click the one to keep
first), **Delete** removes a false stem (a stump, a shrub). **Own
tree** makes the picked stem a tree of its own. Trees the run thinks
may be one are listed under *pairs may be one tree*, each with **Look**
and **Merge**. **Re-grow trees** saves the stems and grows
every tree from them again in seconds, as the graph is kept. To go
through the stems one at a time from above at breast height, use
**Review stems one by one** (chapter 10).

The forest pass was tuned and checked against hand-segmented mobile
laser scanning reference plots of mixed forest, and their field-measured
diameters; the model that decides which tree owns a contested branch on
a mobile scan was trained on the same plots.

### Tree crowns: CHM watershed

The **Tree crowns (CHM watershed)** drawer detects treetops on the CHM
and grows crowns from them. The
defaults are sensible for boreal stands — a minimum tree height, and a
treetop search window that grows with height up to a cap — and each
field explains itself on hover. **Segment trees**. Each detected crown
gets a `tree_id`; the count appears in the panel.

### Review and correct

Then open **Tree review ▶ Scan trees** to list the crowns and step
through them with ← / →. If you spot a missed tree or a merged crown,
edit interactively: lasso a selection and assign an id, or split and
merge from the review panel. Where two trees' branches interleave,
**Pull apart** draws the neighbours aside so the wrong branch stands
out (chapter 10).

### Branches: base diameter and length by hand

To measure branches yourself, isolate a tree in **Tree review** (all of
its points are then loaded) and open the **Branches** panel.

1. **Cut out.** Press **Lasso**, draw around one branch's points, and
   press **New branch from selection**. The branch gets a colour and
   keeps it in every colour mode and after a restart, so the branches
   you have done stand out; **hide cut** hides them to show what is
   left. **Add to active** / **Remove from active** correct a branch
   later.
2. **Base diameter.** With the branch active, **Section at base** cuts
   a thin section across the branch the *base offset* in from the end
   nearer the stem (or **Pick section** and click where to read it).
   The panel draws the section looking along the branch with the
   caliper jaws closed on it: **cross** gives two readings at right
   angles (first turned to the narrowest direction) and their mean,
   **single** one reading. Turn the jaws with *Direction*, move the
   section along the branch, or drag a jaw onto the bark by hand when
   the outermost points are stray returns. **Save as base diameter**.
3. **Length.** **Click along the branch** from base to tip (pause to
   turn the view and go on clicking), or **Follow the branch** to let
   the length follow the branch's points from its base to its farthest
   point, or **Straight** for the chord. **Save as branch length**.
4. **Export.** *Branches CSV* has one row per branch (base diameter in
   mm, length in m); *Measurements CSV* one row per reading with where
   it was taken; the points of a branch export as x, y, z.

Everything is kept in `branches.json` in the dataset folder.

### Stems: DBH, d6, taper and height by hand

The **Stems** panel measures the isolated tree's stem with the same
calipers. Choose which points to measure on — the whole tree, only its
points labelled stem (after Tree Skeleton Transfer or leaf–wood
separation), or a stem cut out with the lasso — then press **DBH
1.3 m** or **d6 6 m**, type any height, or **Pick height** on the stem.
Heights are above the classified ground under the stem (with no ground
class, above the stem's lowest point; **pick** sets the ground by
hand). The stem is followed up from its foot by circles fitted to thin
slabs, so the section lands on the stem even where branches leave it.
Read and save the diameter as on a branch (**Save as DBH / d6 /
other**); **Read series** saves a reading every step up the stem — its
taper. **Tree height** is from the ground to the highest point;
**Follow the stem** or **Click along the stem** gives its length. The
*Stems CSV* has DBH, d6 and height per tree, the *Readings CSV* every
reading with its height above ground.

## 6. Per-tree metrics

In the **Metrics** module, pick the dataset and click Compute. For
each tree PointCloudLabeler measures:

- Height (max point above the bilinear DTM at the tree's XY)
- DBH (algebraic Taubin circle fit in the breast-height band; where
  the forest pass has run and its stems are newer than the tree labels,
  its stem's circle measured at 1.2–1.4 m)
- Basal area = π · (DBH/2)²
- Crown area + diameter (cell-based footprint)
- Stem centroid + base elevation

Optional: open the **Stem fit · RANSAC** section and press **Refine
DBH (RANSAC)**.

- **Stem band**: 1 … 3 m above the ground (default)
- **Inlier tol.**: 0.03 m, **Iterations**: 600, **Min inliers**: 12

The band is cut into 25 cm slices and a circle is fitted to each; a
straight axis runs through their centres and a linear taper through
their radii, and the DBH is read off at 1.3 m, so a leaning stem is
not smeared across the band; slices a branch whorl or a neighbour took
are left out. Circles are scored the way a stem looks to
a scanner, hollow inside with a thin shell of bark, so a large circle
through a branch cloud does not win. A tree keeps its algebraic DBH
when fewer than 30 % of its slices agree on a stem, or when the fit
would be thicker than 1/15 of the tree's height (a circle through a
shrub's crown; a broken-topped snag can land here too). The refined
DBH replaces the algebraic one in the table, the reports, the growth
comparison and the exports. **Label stem points (semantic = stem)**
writes semantic 1 to the inlier points.

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

When the cloud carries leaf labels (semantic 4, from the forest pass
or the Leaf–wood drawer), the QSM fits the stem and branches to the
wood only; the leaves still count towards the tree's height. A cloud
without leaf labels is modelled from all its points. The branch volume
counts the branches only (order 1 and up), so the stem is not counted
twice in the total. Every cylinder carries how it was measured (seen
all round, from one side, its radius corrected, or a gap bridged
without points), and a tree whose stem thickens markedly upwards, or
much of whose branch volume is bridged gaps, is flagged in the **QC**
panel as *QSM log*. The QC panel
also flags a tree whose DBH is far off a height–diameter curve fitted to
the plot's own trees (*height–DBH curve*).

The buttons under the QSM section turn it into files and tubes:

- **Export .qsm** writes into the dataset's `qsm/` folder one `.qsm`
  file per tree in an open format with a `forest.qsf` manifest (read by
  other QSM software), `trees.obj` with one object per tree for 3D
  modelling software (coordinates near the origin; the shift is in
  `trees_origin.txt`), and `trees.ply` in world coordinates, coloured
  by quality.
- **Show tubes** draws every tree's cylinders in the editor's view:
  green measured all round, yellow from one side, orange corrected, red
  a gap bridged. They are listed with the meshes (chapter 10).
- **Open .qsm…** opens a `.qsm` or `.qsf` from other QSM software as
  tubes beside the cloud, to compare.

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

Choose the LAS version in the same dialog:

- **LAS 1.2** (*widest compatibility*) writes the coordinate system as
  GeoTIFF keys. Classification is five bits, so codes above 31 become 0.
- **LAS 1.4** (*full classification*) writes it as OGC WKT, as the
  standard requires for its point formats, with the vertical datum
  joined to it when the dataset records one in metres (for example
  ETRS-TM35FIN + N2000). The few systems that cannot be written as WKT
  keep GeoTIFF keys, so the coordinate system is never lost. Importing
  such a file reads the vertical part back as the dataset's vertical
  datum.

Class names travel with the file. A LAS that names its classes (its
Classification Lookup record) keeps the names on import; the legend
and the **Filters** panel's class chips show them, and a named code
outside the ASPRS list gets a chip and a colour of its own. When the
export writes the classification it writes the names back: LAS 1.2
names codes 0–31, LAS 1.4 all of them. The stem / branch / leaf labels
are in their own `semantic_class` column, not in the classification,
so they get no class names.

## 10. Viewing, measuring and reviewing

These tools work on the open dataset at any step. The activity bar
groups its panels under **VIEW**, **EDIT**, **MEASURE**, **ANALYSE** and
**COMPARE**. Click a group's header to fold it (the bar remembers);
a folded group's header lights up while one of its panels is open.
The panels are also in the **Tools** and **View** menus and the
command palette.

### Display: looks, colour range, shading, legend

The **Display** panel folds into sections: **Looks**, **Colour**,
**Lighting & shading**, **Points**, **Heights**, **Performance** and
**Appearance**. A folded section's header says what it is set to.

- **Looks** set the whole display for one job in one click: colour
  mode, ramp and its range, shading, lighting, point size, heights and
  projection, never the filters or the point budget. The built-in ones
  are *Canopy height*, *Intensity* (stretched over its 2–98 %), *Tree
  review*, *Stand map (DBH)*, *Stems & wood*, *Terrain & classes*,
  *Deadwood* (when the cloud has the deadwood columns) and *Measuring
  (parallel)*. **+ Save the display as a look…** keeps the current
  display under a name of your own, on this machine. The command
  palette lists them as *Look: …*.
- **Colour** shows a histogram of the loaded points under the ramp.
  Drag its ends or type the values, or press **Auto 2–98 %** (the
  weakest and strongest 2 % cut), **Full** or **Reset**. The range is in
  the legend's units and is kept per colour mode.
- **Lighting & shading ▶ Shade by intensity** lays the return strength
  over any colour mode, so stems and branches read inside tree-id and
  class colours too; **strength** sets how much. Eye-Dome lighting is
  in the same section.
- The **legend** in the view is a control: click a class or semantic
  label to hide it, Alt-click to show only it, type the ramp's ends,
  or press **Auto** / **Reset**.

### Trees coloured by their measurements

The **Tree metrics** colour mode paints each tree in one colour by a
measurement: **Height**, **DBH**, **Crown**, **Lean**, **QC flag**
(critical, warning, info, none) or, once two epochs are paired in the
**Tree growth** panel, **Δ DBH** and **Δ height**. The view only uses
measurements already made; if there are none, press **Measure the
trees** under the mode. A tree without a measurement is a lighter grey
than the unlabelled points, and the active tree stays highlighted. The
**QC** panel's **Show on trees** and the **Tree growth** panel's
**Colour trees by Δ DBH** / **by Δ height** switch to it directly.

### Projection, sections, scale and saved views

- **Persp / Parallel** in the view's lower-right corner (key **5**, or
  `View ▶ Perspective / Parallel Projection`) switches to a parallel
  projection: true scale everywhere, for sections, profiles and
  measuring. The switch keeps the scale at the orbit point, so the view
  does not jump.
- A **scale bar** and a **north arrow** sit beside the axis gizmo. In a
  parallel view the bar holds everywhere; in perspective it holds at
  the orbit point. Click an axis of the gizmo to look along it.
- In the **Cross-section slab** panel, **Section view** looks straight
  along the slab in a parallel projection: the cross-section at true
  scale. **◀** / **▶** (or the keys **[** / **]**) move the slab on by
  its own thickness.
- **Views & video ▶ Saved views**: **Save view** keeps the camera and
  the projection under a name, for this dataset on this machine. Click
  a view to go back to it, double-click to rename it, **update** to
  replace it with the current camera.

### Survey: lines, areas, contours, volumes, images, profiles

Open **Survey** from the activity bar (or `Tools ▶ Survey & Measure…`).
All its tabs share one line: press **Pick points** and each click in
the view adds a point on the cloud. The view cannot be turned while
picking, so **Pause picking** to move around. Tick **Area (closed)** to
make the line an area; Volume, Ortho, Mesh and Export limit themselves
to it.

| Tab | What it does | Files (in the dataset folder) |
|---|---|---|
| **Measure** | 3D and plan length or perimeter, plan area, height range, rise | `survey/<name>.geojson`, `.dxf`, `.csv` |
| **Contours** | contour lines of the ground model (class 2) at an interval, every n-th an index line, optionally only inside the area; also drawn in the view | `terrain/contours_<interval>m.geojson`, `.dxf` |
| **Volume** | cut and fill inside the area between a surface (top, lowest point, ground or mean) and a reference (a plane along the area's edge, a level plane, the lowest cell or the DTM) | `survey/<name>.tif` (difference raster), `.json` |
| **Change** | voxels new and gone against another dataset of the project, their volume, and a `voxel_change` column (1 = new) | `survey/voxel_change_gone.csv`, `voxel_change.json` |
| **Ortho** | a top or side ortho image (bearing and depth window) coloured by RGB, intensity, height, class or any column, with optional relief shading | `survey/<name>.png` + `.pgw` + GeoTIFF |
| **Profile** | a section along the line, from a corridor of the width you give; drawn in the panel with 1–10× vertical exaggeration | `survey/<name>.csv`, `.svg`, `.dxf` |
| **Mesh** | a 2.5D mesh (terrain, a pile, a roof) or a closed 3D one (a stump, a rock, a stem section, with its enclosed volume); smoothing, decimation, gap filling | `mesh/<name>.ply`, optionally `.obj`, `.stl`, `.dxf` |
| **Export** | the points as DXF, a layer per class, inside the area, by class and height window, every n-th point | `survey/<name>.dxf` |

The **Mesh** tab also shows, under *Meshes in the view*, any OBJ, STL
or PLY you open and the QSM tubes (each with visibility, colour and
opacity), and under *Trajectories in the view* the path a mobile scanner
walked (a time x y z text file), start and end marked.

### Height between two points

Open **Height** from the activity bar (or `Tools ▶ Height Between Two
Points…`). Press **Pick two points** and click the two ends in the
view, in either order: a tree's root and its top, a branch and the
ground. **First again** / **Second again** re-pick one end; Esc stops.
The panel gives the height difference, the straight and horizontal
distances, the angle from level and both points' heights.

In the view a scale stands on the lower point and reaches the next
full step above the upper one: a 27.4 m tree reads on 0–30 m with
lines every 5 m. **Step** is automatic (at most eight steps) or 0.5–20 m.
**Helper rings** draws a level ring round the scale at every line, so
the lines read from any side. Type a **Note** and press **Keep** to
store a reading; **CSV** saves the kept readings.

### Views & video

Open **Views & video** from the activity bar (or `Tools ▶ Views &
Video…`).

- **X-ray view**: every point adds a little light, so stems, walls and
  the ground's edge show through the canopy; **strength** sets how much
  one point adds. Eye-Dome lighting is off while it is on. A dark
  background and fewer, larger points read best.
- **Fly-through**: move the view and press **Add view**, as many times
  as you like; **Play** flies through them in order along a smooth
  curve. **Loop** repeats.
- **Slice through**: a slab moved through the cloud upward, eastward,
  northward or toward a bearing, at the thickness and duration you
  give. It borrows the Filters' plane slab and gives it back at the end.
- **Time lapse**: the ticked datasets shown one after another, in the
  order ticked. They must share the coordinate system (register them
  first if needed).
- **Record a video of the next animation**: the next fly-through,
  slice or time lapse is saved as a video (MP4 where the system can
  encode it, otherwise WebM). Keep the window on screen while it plays.

### A second cloud in the same view

In the **Layers** panel's dataset list, **+ scene** adds another
dataset of the project to the view as a read-only overlay; **→ active**
makes it the editable cloud instead. The **Filters** panel works on the
active cloud. Two switches on the overlay's row decide what it takes
from them:

- **sync extent** (on by default): only the extent's X, Y and Z range,
  so a height filter cuts both clouds at the same height, even when
  their offsets differ.
- **sync filters**: every filter, isolation, id range and hidden
  classes included. Tree ids and classes of another cloud seldom mean
  the same, which is why this is not the default.

With both off, the whole overlay shows.

### Second window

**⧉ Second window** at the right of the module tabs (or `View ▶ Second
Window…`) opens a second window beside the editor; pick its dataset
there, or use **▾** beside the button to open one of the project's
datasets in it directly. The editor takes the left half of the screen
and the second window the right; **⇆ side by side** arranges them
again, and the second window can go to another screen. It runs the
same editor on its own dataset, so every panel, colour mode and
measuring tool works in it. Link the two windows with **camera**:
**off** (each its own), **orbit** (turning and zooming one turns and
zooms the other about its own centre — two trees side by side from the
same direction and distance) or **world** (the same camera in world
coordinates — two epochs of one place); tick **colours** to share the
colour mode. A dataset open in both windows is read-only in the window
that opened it second, which says so. Closing the editor closes the
second window too.

### Reviewing the forest pass

Both reviews are in the **Forest — stems to trees** drawer once the
pass has run (chapter 5).

**Review stems one by one** goes through the stems from above at breast
height, the way they are checked in the field: a thin horizontal slab
1.3 m above the stem's own ground, seen straight down in a parallel
projection, coloured by tree, with the stem's circle drawn at its exact
radius. Pick the **view** width (1.5–12 m) and the **slab ±** (2.5–10
cm) with the buttons. With **doubtful stems first** ticked, the stems
that need a look come first (found from the flow only, added by hand
without a diameter, very thin or thick, leaning, sharing a tree with
another stem, suggested for a merge), the reason shown at the stem.

- **OK ▶** (Enter) marks the stem right and goes on; ← / → move without
  marking.
- **Move** (M) puts the centre where you click; **Radius** (R) makes
  the circle pass through the bark you click; **Fit** (F) fits the
  circle with the virtual caliper; **Add** (A) adds a stem; **Delete**
  removes one; **Own tree** makes it a tree of its own. Clicks land on
  the slab's plane, not on the nearest point, so you can click the
  middle of a hollow stem.
- A stem measured by hand keeps its circle when the trees are re-grown;
  **Measure on re-grow** hands it back to the forest pass.
- Esc leaves the click mode, a second Esc (or **End review**) ends the
  review and puts the view back as it was.

The marks are kept in `forest/seed_review.json` and follow a stem
through a new run as long as it stands within 15 cm of where it was.

**Review near-tie branches** appears for a mobile (MLS) dataset. It
lists the branches the forest pass nearly gave to another tree, the
largest first; these are where one tree has grown into its neighbour's
branch tips. **Right ▶** (Enter) marks a branch right where it is,
**Move to tree N** (M) gives its points to the other tree (an ordinary
edit, Ctrl+Z undoes it), **Look** (L) frames it again, ← / → move on,
Esc or **End review** stops. The marks hold for that run.

### Pulling neighbouring trees aside

In **Tree review**, isolate a tree and tick **Show other trees
nearby**; under it, **Pull apart · view only** draws chosen neighbours
aside, so interleaved branches come apart. The chips are the
neighbours on screen: click one to move it aside or back, or **all**.
Give the distance in metres (2 m by default) and the direction: **away**
(each straight away from the isolated tree) or **N**, **E**, **S**,
**W**. **✥ drag** lets you move the pulled trees with a left-drag in
the view (over the ground from above, along the screen from the side;
always horizontal); orbit and lasso pause until you click it again or
press Esc. **reset** puts every tree back, as do switching to another
tree, ending the isolation, hiding the neighbours or closing the panel.

Only the picture moves. Lasso, rectangle, polygon, set id, split and
trim work on what you see and save to the real points, and a point
whose id changes is drawn at once where its new tree is, so a wrong
branch given to the active tree jumps home. Filters, picked
coordinates, measurements, saving and exports all use the real
coordinates. Another window, other modules and overlay clouds are
not moved.

### Registration from stem maps

In the **Fine registration** panel (COMPARE group, or `Tools ▶ Fine
Registration…`), **2. Start ▶ Stem maps — where the stems stand, how
thick they are** puts two clouds of one plot together from their stem
maps alone: no skeletons, no tree segmentation, no first guess, any
heading and any offset.

- The stems are the forest pass's (those with a fitted circle) where it
  has run. Otherwise they are found during the run from four thin
  slices 0.8–2.2 m above the ground; that needs a ground classification
  and writes nothing to the dataset.
- Pairs of the moving cloud's thickest stems are matched to pairs in
  the reference by their spacing and thickness, the best matches refined
  over every paired stem, and the height taken from the ground under the
  stems. This gives the turn about the vertical and the shift; the fit
  in **3. Measure** then adds the tilt.
- The result line gives how many stems were paired and the
  *runner-up*: how many the best answer elsewhere pairs. When the two
  are close (a planted grid, rows), the positions alone did not decide
  and the thicknesses did; check the result by eye.

Clouds from above the canopy see few stems; for them **Automatic coarse
search by stems and crowns** is the better start.

### Layers from files

Files from other programs and from your runs open as layers over the
cloud: **+ File…** in the **Layers** panel, `File ▶ Open Data…`, or a
drop on the window. A point cloud goes to the import instead. What a
file is follows from its name:

| File | Drawn as |
|---|---|
| `_traj.txt`, `_traj_map.txt`, `_frames.txt`, `_odometry.txt`, `traj.txt`, `trajectory.txt` | a trajectory: a line, start and end marked |
| `_scan_positions.csv` | scan positions, with their names |
| `_targets.csv`, `_stops.csv` | targets, with their names; a `diameter` as a circle |
| `_stems.csv`, `_trees.csv` | stems: a circle at breast height (`ground_z` + 1.3 m, `dbh_cm`) |
| `.geojson`, `.shp` | a region outline (at the cloud's height when it has none) |
| `_pad.ply` | voxel centres |
| `.obj`, `.stl`, `_tubes.ply`, `trees.ply` | a mesh |
| `.qsm`, `.qsf` | a QSM, as tubes |
| `.asc` (ESRI ASCII grid) | a raster surface in a colour ramp: an elevation grid (`dtm`, `dsm`, `dem`, `_ground`, `filled`) at its heights, any other on the run's `_ground.asc` or at the cloud's lowest height |

A point table needs `x` and `y` (or `easting` and `northing`) in its
header; a point with no height is drawn as a pin through the cloud.
The **Scene** list shows each layer with an eye and ✕, and the project
remembers which layers it showed. **Project files** lists what was
unpacked into the project's `imports/` folder; ●/○ shows or hides a
file's layer, and **all files** lists the rest too.

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
- **Forest pass: "classify ground first"** or **"too few points above
  the ground"** → the ground is not classified. Step 3, then run again.
- **Shrubs or stumps came out as trees** → delete their stems in the
  drawer's **Stems** box (or in **Review stems one by one**) and press
  **Re-grow trees**; the graph is kept, so it takes seconds.
- **Rename Project… refuses** → save or discard the editor's edits,
  wait for a running conversion or unpacking, and close any Explorer
  window, terminal or sync client that has the project folder open.
- **"Read-only here" in a window** → the dataset is open in the other
  window too; edit it in the window that opened it first.
- **Stem maps start: "the places match more than one way"** → a planted
  grid or rows; the thicknesses decided. Check the result side by side
  before applying it, or start from **Automatic coarse search by stems
  and crowns**.
