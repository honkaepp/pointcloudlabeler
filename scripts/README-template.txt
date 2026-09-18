PointCloudLabeler — Install Guide
=================================

What this is
------------
PointCloudLabeler — Point-cloud tree labelling, forest inventory and
biomass from terrestrial and mobile laser scans.
An out-of-core point-cloud editor for forestry: import a LAS / LAZ
plot of any size, classify the ground, segment individual trees,
review and correct them, and measure them — height, DBH, taper, stem
volume with a confidence interval, biomass and carbon — then export
the labelled cloud, the per-tree table and the terrain rasters.


Requirements
------------
- Windows 10 / 11 (x64)
- Microsoft Edge WebView2 Runtime (ships with Windows 11 and current
  Windows 10; if missing, the installer offers to download it)
- ~60 MB disk space for the program itself. A dataset's octree takes
  roughly the size of the LAS it was built from, beside the project.
- 16 GB of RAM is comfortable for plots of a few hundred million
  points; the editor streams from disk and never loads a whole cloud.


Install
-------
1. Double-click  PointCloudLabeler_X.Y.Z_x64_en-US.msi.

2. Windows SmartScreen may show a blue "Windows protected your PC"
   dialog. This is expected because the binary isn't code-signed.
       - Click the small "More info" link
       - A "Run anyway" button appears at the bottom → click it

3. Setup wizard:
       - Welcome → Next
       - License Agreement → tick "I accept the terms..." → Next
       - Custom Setup → keep the default path → Next
       - Ready to install → Install
       - UAC prompt ("Allow this app to make changes...") → Yes
       - Installing... (~30 seconds)
       - Completed → Finish

4. Launch:
       - Start menu → type "PointCloudLabeler" → click the icon
       - or the desktop shortcut


Usage (basic flow)
------------------
1. Open the app → Welcome screen → "New project" → pick a folder. The
   folder holds the project's metadata and every dataset built for it
   (octrees/<name>/), so put it on a fast local disk with room to spare.
2. Editor → "Import LAS / LAZ". The importer builds an out-of-core
   octree; a plot of 100 M points takes a few minutes, and the run can
   be cancelled.
3. Terrain panel → "Classify ground" (PMF or CSF), then compute the
   DTM / DSM / CHM rasters in the same panel.
4. Auto-segment → "Tree crowns (CHM watershed)" → "Segment trees".
   Then Tree review → "Scan trees" to step through the crowns and
   correct them: lasso a selection and assign an id, or split and
   merge from the review panel. Ctrl+Z undoes; Ctrl+S saves the edits
   beside the dataset.
5. Metrics → "Compute" for per-tree height, DBH, basal area and crown
   size; "Stem QSM" for taper and stem volume with a 95 % confidence
   interval; "Biomass & carbon" with a species preset.
6. Metrics → "Export CSV" for the per-tree table; File → "Export…" for
   the labelled cloud as LAS / LAZ. The rasters are GeoTIFFs under the
   dataset's terrain/ folder.

Every panel is reachable from the activity bar on the left of the
Editor and from the command palette; Help → "Keyboard Shortcuts"
lists the keys, which can be changed there. Every long run has a
Cancel, and a stopped run leaves the dataset as it was.


Updates
-------
PointCloudLabeler does not update itself and does not contact any
server: nothing in it uses the network. New versions appear at

    https://github.com/honkaepp/pointcloudlabeler/releases

You choose when to upgrade, by downloading the new package and running
its MSI over the installed one.

That is deliberate. This is a measurement tool: a paper that says
"we used PointCloudLabeler 0.1.0" has to stay true, and software that
replaces itself mid-study makes it false. Versions of PointCloudLabeler
can differ in what they measure.


Uninstall
---------
Settings → Apps → "PointCloudLabeler" → Uninstall.

Optionally also wipe:
    %APPDATA%\fi.honkaepp.pointcloudlabeler\        — recent-projects list
    (paste that path into File Explorer's address bar)


Troubleshooting
---------------
"Antivirus blocks it"
    Add an exception for:
        C:\Program Files\PointCloudLabeler\
    Same root cause as SmartScreen — the binary is unsigned.

"The import is slow"
    The octree build reads the whole file once and writes it once,
    so on a network drive or an external HDD the disk is the
    bottleneck. Build datasets on a local SSD.

"Out of memory during a long run"
    Segmentation and QSM run on every core and hold a plot's worth of
    points at a time. Close other large applications, or run the tool
    on a part of the plot first (Subset / extract panel).

"A run takes too long"
    Every long run has a Cancel, and a stopped run leaves the dataset
    as it was.


Licence and credits
-------------------
PointCloudLabeler — © 2026 Eppu Honkanen.

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
General Public License for more details.

The full licence text ships beside this file as LICENSE and is
installed with the program; it is also at
https://www.gnu.org/licenses/gpl-3.0.html

The documentation is CC BY 4.0 instead (LICENSE-DOCS), so that it can
be quoted and adapted in a paper or a manual without dragging a
software licence along.

Your measurements are your own. Output — a stand table, a CSV, an HTML
report, the figures in a paper — is not a derivative work of the
program that produced it, and the GPL makes no claim on it.

Complete corresponding source code
----------------------------------
GPL-3 section 6 entitles you to the source for the exact binary you
received, and section 6(a) is satisfied by handing it to you rather
than by pointing at a server: the source ships in this same package,
as the file named below. You do not need a network connection, a
GitHub account, or this project to still exist.

    Source archive:   @SOURCE_ARCHIVE@
    Built from:       @SOURCE_REVISION@

That archive is the whole repository at the revision this binary was
compiled from, including the build scripts and both dependency
lockfiles (src-tauri/Cargo.lock and package-lock.json). The lockfiles
pin every third-party component to an exact version, so the build is
reproducible; those components are separately licensed works obtained
from their own registries, and THIRD-PARTY-NOTICES.md records what
each one is and under what terms.

The same source, its history and the issue tracker are also at:

    https://github.com/honkaepp/pointcloudlabeler


Third-party components
----------------------
PointCloudLabeler embeds several hundred third-party components — among them
SQLite, the EPSG coordinate registry via epsg-index, and the Inter and
JetBrains Mono typefaces. Every one of them keeps its own
licence, and all of them are reproduced in THIRD-PARTY-NOTICES.md,
which ships beside this file and is installed with the program.

If you use PointCloudLabeler in published work, please cite it —
CITATION.cff in
the repository has machine-readable metadata.
