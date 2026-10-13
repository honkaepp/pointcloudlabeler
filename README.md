# PointCloudLabeler

**Tree segmentation, editing and label transfer for close-range forest point clouds.**

PointCloudLabeler is an open-source desktop application for tree-level
work on close-range laser scanning point clouds of forest plots,
whatever produced them: terrestrial, mobile and handheld scanners, and
low-altitude airborne lidar from UAVs or helicopters. It streams plots
of hundreds of millions of points from disk and puts the segmentation
itself in the user's hands. Individual trees are found with published
methods, then reviewed and corrected in the viewport with lasso, split
and merge on the full data, guided by a quality-control engine that
ranks the trees most likely to be wrong and a review record of what was
checked and decided.

A corrected segmentation is transferred to any other cloud of the same
plot, whether a later epoch or a different sensor, through the trees'
skeletons, so tree identities stay stable across a time series and the
manual correction is done once. Per-tree metrics (height, DBH, taper,
stem volume with confidence intervals, biomass and carbon), terrain
rasters, side-by-side comparison of epochs and exports to LAS/LAZ, CSV
and GeoTIFF complete the workflow. A Windows installer is on the GitHub
Releases page; macOS and Linux build from source.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![DOI](https://zenodo.org/badge/1354385548.svg)](https://doi.org/10.5281/zenodo.22824704)

## Status

Version 0.1.3 is the current release: a Windows installer on the
[Releases](https://github.com/honkaepp/pointcloudlabeler/releases) page,
built from this repository. Development continues here, and a
software article describing PointCloudLabeler is in preparation for
SoftwareX.

> **Licence**: the software is [GPL-3.0-or-later](LICENSE); the
> documentation is [CC BY 4.0](LICENSE-DOCS). Third-party assets
> PointCloudLabeler bundles or embeds keep their own licences,
> reproduced in
> [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). See
> [Licence](#licence) for the full notice.

## Features

### Editor
- Out-of-core octree streaming — works on >100 M point plots without
  loading everything into RAM
- Per-point editing with overlays (tree IDs, semantic class, deadwood
  channels, custom Extra Bytes from LAS)
- Lasso / rectangular / polygon selection that follows occlusion and
  the visible LOD
- Auto-segmentation: CHM-watershed individual-tree-crown delineation,
  laying-deadwood detection via PCA + DBSCAN
- Tree review workflow with per-tree isolation, height-band slicing
  and "show neighbouring trees" context

### Preprocessing
- Import of ASTM E2807 **E57**, Leica Cyclone **PTX / PTS**, and
  generic ASCII **XYZ / CSV / TXT** scans into editor-ready LAS / LAZ,
  with the scan positions and poses they carry
- Co-registration of scan positions across importers — tie points
  (Kabsch), sphere targets matched by RANSAC, point-to-point and
  point-to-plane ICP, and a multi-station adjustment over the whole
  set

### Analytics
- Ground classification (Progressive Morphological Filter; Cloth
  Simulation Filter)
- DTM / DSM / CHM raster generation (Khosravipour pit-free option) →
  ESRI ASCII grids + **georeferenced GeoTIFFs**
- Per-tree metrics: height, DBH (algebraic + RANSAC refinement),
  basal area, crown area, crown diameter, stem centroid
- **Quantitative Structure Model (QSM)**:
  - **Slice-based stem fit** with 12-sector angular-coverage
    confidence per slice and an analytical 95 % CI on stem volume
  - **TreeQSM v2** (Raumonen 2013): overlapping-ball cover sets,
    BFS-expanding seed selection (MaxBalls), trunk segmentation as a
    cover-graph walk, branch hierarchy with parent-child + branch
    order, iterative cylinder LSQ fit with MAD outlier rejection,
    monotonic taper enforcement
- **Cloud registration**: two clouds of one plot that do not sit on
  each other — a TLS plot and the ALS epoch over it — are put together
  from the reference's tree skeletons, voted onto the target's stems and
  crowns (shift over tens of metres plus a small rotation, refined tree
  by tree), checked side by side, and fixed by a lossless georeference
  shift that rewrites no point and is undone by the opposite shift
- **Every column of the LAS record**: GPS time (stored as an f64, so a
  pulse's time comes back to the microsecond), colour, near-infrared,
  scan angle, user data, point source id and the flags are imported as
  columns under their reserved names, coloured and filtered in the
  viewport, and written back where the record keeps them on export, in
  a point format with room for them — as imported, or as edited
- **Text, PLY and E57 in and out**: the Editor imports a TXT / XYZ /
  CSV file (columns mapped by name, or by hand in the import dialog,
  every other column carried exact under its own name), a PLY (its
  vertex properties) and an E57 (every scan, poses applied, the scan
  index as the point source id) straight into a dataset, and exports a
  dataset as text, PLY or E57 with every column along — the same
  filters, normalisation and reprojection as a LAS export
- **Fine registration**: two datasets of one plot — two epochs, two
  sensors — put on each other in six degrees of freedom: symmetric
  point-to-plane ICP (Rusinkiewicz 2019; GICP, point-to-plane and
  point-to-point as choices) over a pyramid of decimations with a
  robust kernel, started from an automatic coarse search by stems and
  crowns or a global feature search (FPFH + RANSAC) from any heading,
  the translation and rotation with their standard errors from the
  covariance at the solution and from a spatial block jackknife, the
  observability of the fit (a flat field constrains height and tilt
  and nothing else, and the panel says so), and the registration error
  handed to M3C2; applied as a new, moved copy with every label kept,
  the source untouched
- **Biomass + carbon with uncertainty**: per-tree and plot totals,
  species-specific wood density presets (Repola 2006/2008; Kärkkäinen
  2007; Global Wood Density DB), uncertainty propagated in quadrature
  to CO₂-equivalent

### Export
- LAS / LAZ round-trip with Extra Bytes (tree_id, semantic_class,
  deadwood ids, height-above-ground, …); the same export as text
  (TXT / XYZ / CSV), PLY or E57, every column along
- CSV with all per-tree metrics + QSM uncertainty fields
- GeoTIFF rasters with EPSG metadata

## Installation

### Pre-built binaries (Windows)

Download `PointCloudLabeler-<version>.zip` from the latest release:
<https://github.com/honkaepp/pointcloudlabeler/releases/latest>. The
zip holds the `.msi` installer, `INSTALL.txt`, the licences and the
Corresponding Source of the exact commit the installer was built from
(GPL-3 §6a). Extract it and run the `.msi`.

The installer is not code-signed yet, so Windows SmartScreen shows
"Windows protected your PC" on first run: choose **More info → Run
anyway**. To check the download first, compare its SHA-256 with the
digest the release page shows beside the asset:

```powershell
certutil -hashfile PointCloudLabeler-<version>.zip SHA256
```

macOS and Linux have no installers yet; build from source below.

### From source

PointCloudLabeler is built with [Tauri 2](https://v2.tauri.app) (Rust backend,
React + Three.js frontend).

```bash
# Prerequisites:
#   - Rust 1.77+        (https://rustup.rs)
#   - Node.js 20+       (https://nodejs.org)
#   - Platform build tools:
#       Windows  Visual Studio Build Tools with the "Desktop development
#                with C++" workload — Rust's MSVC toolchain needs the
#                linker. WebView2 ships with Windows 11 and current
#                Windows 10; on an older machine install the Evergreen
#                runtime from Microsoft.
#       macOS    xcode-select --install
#       Linux    libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev
#                patchelf libssl-dev libgtk-3-dev
#
# Clone and run:
git clone https://github.com/honkaepp/pointcloudlabeler.git
cd pointcloudlabeler
npm install
npm run tauri dev          # development build with hot reload
npm run tauri build        # release build with installer
```

The first build takes 5–15 minutes depending on hardware. Subsequent
runs are incremental. For a build that matches a release exactly, use
`npm ci` rather than `npm install`: it installs what the lockfile pins.

On Windows the installer lands in
`src-tauri\target\release\bundle\msi\PointCloudLabeler_<version>_x64_en-US.msi`.
(The CI workflow overrides the bundle target to NSIS and produces an
`.exe` instead; a local build follows `tauri.conf.json`, which asks for
an `.msi`. Both install the same application.)

`npm run pack` then zips that MSI together with the install guide as
`PointCloudLabeler-<version>.zip`, ready to hand to someone else.

### Without a window: command line, console, API, MCP

The same analyses run with no window at all — on a compute server,
over SSH, from a script, from another program, or from an AI
assistant. The headless binary links no Tauri, GTK or WebKit:

```bash
cd src-tauri
cargo build --release -p pointcloudlabeler
# → target/release/pointcloudlabeler

pointcloudlabeler preprocess import --source-path plot1001.e57   # a scanner project; then register and export
pointcloudlabeler dataset import --src-path plot1001.laz --project-folder ./evo
pointcloudlabeler ground classify --octree-dir ./evo/octrees/plot1001
pointcloudlabeler segment chm --octree-dir ./evo/octrees/plot1001 --min-height 3
pointcloudlabeler qc flags --octree-dir ./evo/octrees/plot1001 | jq '.critical'
pointcloudlabeler metrics plot --octree-dir … --fit rectangular   # stems/ha, m²/ha, Lorey's H
pointcloudlabeler export report --octree-dir … --out-path plot1001.html   # the inventory report
pointcloudlabeler export csv --octree-dir … --out-path plot1001_trees.csv  # the per-tree table
pointcloudlabeler recipe run plots.json      # one recipe, many plots, overnight
pointcloudlabeler tui                        # the console interface
pointcloudlabeler serve                      # HTTP API on 127.0.0.1:7878, MCP on /mcp
pointcloudlabeler mcp                        # MCP server over stdio
```

Every subcommand is one operation of the **operation catalogue** —
about seventy, each the same Rust pass a desktop panel runs, with the
panel's defaults — and the command line, the console, the API and the
MCP tools are generated from it, so they always agree. See
[`docs/HEADLESS.md`](docs/HEADLESS.md) for the surfaces and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md) for every operation and
parameter.

## Quick start

```
Project ▶ New Project…      # picks a folder; project metadata only
Editor ▶ Import point cloud # LAS / LAZ / TXT / PLY / E57 → out-of-core octree
Terrain ▶ Classify ground   # PMF or CSF, then the DTM / DSM / CHM rasters
Auto-segment ▶ Tree crowns  # CHM-watershed individual-tree delineation
Metrics ▶ Compute           # per-tree height, DBH, basal area, …
Metrics ▶ Stem QSM          # taper + frustum stem volume + 95 % CI
Metrics ▶ Biomass & carbon  # density / carbon fraction → kg, kg CO₂e
Metrics ▶ Export CSV        # per-tree table including QSM uncertainty
```

A step-by-step tutorial is in [`docs/TUTORIAL.md`](docs/TUTORIAL.md),
and a demo dataset to follow it with — two clouds of one plot, a 2021
terrestrial scan with a corrected segmentation and a 2023 helicopter
scan, 1.2 GB — is on Zenodo: <https://doi.org/10.5281/zenodo.22810788>.

## Architecture

```
pointcloudlabeler/
├── src/              # React + Three.js frontend (TypeScript)
│   ├── three/        # WebGL renderer, LOD streaming, picking
│   ├── modules/      # Editor / Preprocessing / Inventory / Metrics / Figures
│   ├── components/   # Reusable panels (Tree review, Ground, …)
│   ├── metrics/      # Biomass + carbon (browser-side math)
│   └── persistence/  # File I/O, octree reader, project store
├── src-tauri/        # Rust backend
│   ├── src/commands/ # IPC commands: octree builder, importers,
│   │                 # QSM (slice + Raumonen 2013), terrain,
│   │                 # co-registration, GeoTIFF, exports
│   ├── src/ops/      # The operation catalogue: every analysis as a
│   │                 # named, typed, headless operation
│   └── src/headless/ # Command line, recipes, console, HTTP API, MCP
└── docs/             # User documentation
```

The Rust crate builds two binaries. The desktop application (feature
`gui`, the default) is the Tauri shell around the commands; the
headless binary (features `cli`, `tui`, `api`, `mcp` — `headless` for
all) is the operation catalogue behind a command line, a console, an
HTTP API and an MCP server, and links no Tauri, GTK or WebKit. The
analysis passes are shared; only the surfaces differ.

Each importer is a self-contained module under `commands/` with its
own UI panel under `components/preprocessing/`, and no importer touches
another's code path.

The QSM machinery lives in `commands/octree.rs` (slice-based stem
fitting, simple branch fit, biomass-ready output) and
`commands/treeqsm.rs` (Raumonen 2013 with overlapping balls + trunk
segmentation + branch hierarchy).

## Testing

```bash
cd src-tauri
cargo test --lib qsm        # the QSM math tests
cargo test --lib            # all backend tests, desktop build
cargo test --no-default-features --features headless   # the same, headless build, plus the surfaces
cd ..
npx tsc --noEmit            # frontend type check
npm test                    # frontend tests, including the source-pinning suites
```

The QSM test suite includes synthetic-data validation of the cone
frustum formula, analytical uncertainty propagation, angular-coverage
confidence, branch cylinder fitting, iterative LSQ on noisy data,
monotonic-taper enforcement, Y-tree hierarchy recovery, and
tilted-stem trunk segmentation.

## Citing PointCloudLabeler

A machine-readable citation is in [`CITATION.cff`](CITATION.cff), and
every release is archived on Zenodo: <https://doi.org/10.5281/zenodo.22824704>
resolves to the latest version, and each version has a DOI of its own
(v0.1.0: [10.5281/zenodo.22824705](https://doi.org/10.5281/zenodo.22824705)).
A software article is in preparation for **SoftwareX**; until it
appears, please cite the Zenodo record of the version you used.

If you use a specific algorithm in PointCloudLabeler, please also cite the
underlying reference. Every method below is implemented from its
publication, or ported from the authors' own code where the entry says
so; where this code departs from either, the entry and the module's own
header say how. A citation here is a statement about what the code
does, not a wish — the entries were re-checked against the publications
in 2026 and three of them changed as a result.

**Structure and volume**

- Raumonen et al. (2013) for the QSM algorithm — *Remote Sensing* 5(2):491–520
- Repola (2006, 2008) for Finnish biomass-from-volume conversion
- Taubin (1991) for the algebraic circle fit behind every diameter
  (DBH, QSM slices, taper, the virtual caliper)

**Segmentation**

- Xi & Hopkinson (2022) for treeiso individual-tree isolation —
  *Remote Sensing* 14(23):6116. All three stages are ported from the
  authors' reference implementation (`truebelief/artemis_treeiso`, MIT);
  see THIRD-PARTY-NOTICES.md
- Landrieu & Obozinski (2017) for the ℓ0 cut-pursuit optimiser treeiso
  is built on — *SIAM J. Imaging Sci.* 10(4)
- Li et al. (2012) for the top-down point-cloud tree segmentation —
  *PE&RS* 78(1):75–84
- Popescu & Wynne (2004) for the variable-window idea behind treetop
  detection — the window here is a user-set linear function of height,
  not their species-fitted quadratics

**Ground, terrain and canopy surfaces**

- Zhang et al. (2003) for the progressive morphological ground filter,
  implemented to its eq. 6
- Zhang et al. (2016) for the cloth-simulation ground filter — the idea,
  run as a 2.5D grid cloth over the min-Z surface rather than their 3D
  mass-spring cloth over the inverted cloud; see the module header
- Khosravipour et al. (2014) for the pit-free CHM's layered-maximum
  construction. Each partial layer is closed by a one-cell dilation
  where they interpolate a TIN, so pits wider than a cell survive
- Wang & Liu (2006) for depression filling in the terrain rasters
- Horn (1981) for slope and aspect; Zevenbergen & Thorne (1987) for
  curvature; Riley (1999) for the terrain ruggedness index;
  Weiss (2001) for the topographic position index;
  Beven & Kirkby (1979) for the topographic wetness index;
  McCune & Keon (2002) for the heat load index

**Registration, change detection and inspection**

- Kabsch (1976) for the closed-form point-set fit
- Besl & McKay (1992) point-to-point and Chen & Medioni (1991)
  point-to-plane ICP
- Kåsa (1976) / Coope (1993) for the algebraic sphere fit that seeds
  retro-target detection, refined to the geometric (maximum-likelihood)
  fit — a scanned target is a cap, and the algebraic fit alone reads a
  cap biased along the line of sight
- Lague et al. (2013) for M3C2 change detection —
  *ISPRS J. Photogramm.* 82:10–26
- Katz et al. (2007) for the hidden-point-removal *problem* the
  scan-inspection view addresses. The filter itself is a depth buffer
  over the viewpoint's angular bins, not Katz's spherical-inversion
  operator — the same question, a different answer near silhouettes
  and in sparse cloud

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). All contributors are expected
to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

Bug reports and feature requests welcome via
[GitHub issues](https://github.com/honkaepp/pointcloudlabeler/issues).

## Licence

Copyright (C) 2026 Eppu Honkanen

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.

`LICENSE` is the unmodified GPL-3.0 text as published by the Free
Software Foundation, and `LICENSE.txt` is the same file under the name
some journals and tools look for; the notice above is what applies it
to this work, because the licence text itself names no copyright
holder.

**What this means in practice.** You may use PointCloudLabeler for any purpose,
including commercially, and you may study, modify and redistribute it.
If you distribute it — modified or not — you must pass on the same
freedoms, which means shipping the corresponding source under the same
licence. Measurements PointCloudLabeler produces are yours; a stand table, a
report or a paper is not a derivative work of the program that computed
it.

The DOCUMENTATION is [CC BY 4.0](LICENSE-DOCS) instead, so that a
research paper, a course handout or a national forest-inventory manual
can quote and adapt it without inheriting a software licence.

Third-party components keep their own licences, reproduced in full in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Acknowledgements

PointCloudLabeler builds on a large pile of open scientific work — TreeQSM
(Raumonen et al.), lidR (Roussel et al.), 3D Forest (VUKOZ-OEL),
PDAL, GDAL, the LAS / LAZ specification (ASPRS / Hobu), ASTM E2807
(E57), and the Rust scientific software community (the `las`, `laz`,
`e57` crates).

Coordinate reference system support (`src-tauri/src/commands/crs.rs`)
embeds the EPSG Geodetic Parameter Registry, maintained by IOGP
(International Association of Oil & Gas Producers), via the
`epsg-index` dataset's ISC-licensed packaging of it. PointCloudLabeler is not
endorsed by or affiliated with IOGP or the epsg-index maintainers;
"EPSG" is a trademark of IOGP.
