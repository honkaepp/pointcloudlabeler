# PointCloudLabeler without its window

The desktop application is one way to run PointCloudLabeler. The same
analyses — import, ground classification, terrain, segmentation,
per-tree measurement, stem fits and stem models, quality control,
review verdicts, skeleton transfer and registration, exports, change
detection — also run with no window at all, from a terminal, a script,
another program or an AI assistant. Four surfaces offer them:

| Surface | Command | For |
| --- | --- | --- |
| Command line | `pointcloudlabeler <group> <operation> --flags` | shells, scripts, pipelines, batch runs over many plots |
| Console interface | `pointcloudlabeler tui` | a terminal session, locally or over SSH |
| HTTP API | `pointcloudlabeler serve` | other programs on the same machine or, with a token, elsewhere |
| MCP server | `pointcloudlabeler mcp` or `POST /mcp` on the API | AI assistants that speak the Model Context Protocol |

All four drive one **operation catalogue** (`src-tauri/src/ops`): about
fifty named operations with typed parameters, each the same Rust pass
the desktop application's panels run, with the panels' defaults. The
full list with every parameter is [`OPERATIONS.md`](OPERATIONS.md), and
`pointcloudlabeler ops list` prints it from the binary itself.

Nothing is drawn. Looking at a point cloud, lassoing points, splitting
a crown by hand — those stay in the desktop application. What the
headless surfaces add is everything that can be done without looking:
the computation, the bookkeeping, the batch.

## Building the headless binary

The headless binary links no Tauri, GTK or WebKit, so it builds and
runs on a machine with no display — a compute server, a container, a
laptop over SSH:

```bash
cd src-tauri
cargo build --release -p pointcloudlabeler
# → target/release/pointcloudlabeler   (pointcloudlabeler.exe on Windows)
```

The binary is its own crate, `src-tauri/headless`, over the
application's library built without its `gui` feature (the installer
bundles every binary of the application's package, so the headless
one lives beside it rather than in it). Prerequisites are Rust 1.77
or newer and, on Linux, a C compiler for SQLite (nothing else: no
webkit2gtk, no gtk3). The crate's default feature, `headless`, is
shorthand for every surface; pick fewer to build less
(`cargo build --release -p pointcloudlabeler --no-default-features --features cli,api`):

| Feature | Adds | Crates |
| --- | --- | --- |
| `cli` | the command line and `recipe run` | clap |
| `tui` | `pointcloudlabeler tui` | ratatui, crossterm |
| `mcp` | `pointcloudlabeler mcp` (stdio) | none |
| `api` | `pointcloudlabeler serve`, and MCP over HTTP | hyper (server only), tokio |
| `api-tls` | HTTPS for `serve` | rustls with ring |

The desktop application (`npm run tauri build`) carries none of this:
the default feature set is `gui` alone, and the test suite checks that
no HTTP stack reaches it (`src/persistence/noNetwork.test.ts`).

## The command line

Each operation is a subcommand under its group, and each parameter is a
flag. `--help` at any level lists what is there, with the defaults and
a one-line description of every parameter:

```bash
pointcloudlabeler --help
pointcloudlabeler segment --help
pointcloudlabeler segment chm --help
```

A session that follows the manuscript's workflow:

```bash
pointcloudlabeler project new --folder ./evo --name "Evo 2023"
pointcloudlabeler dataset import --src-path ./laz/plot1001.laz --project-folder ./evo --scanner-type tls
# → {"name":"plot1001","outDir":"./evo/octrees/plot1001", ...}

D=./evo/octrees/plot1001
pointcloudlabeler ground classify --octree-dir $D
pointcloudlabeler ground terrain  --octree-dir $D --cell-size 0.5
pointcloudlabeler segment chm     --octree-dir $D --min-height 3
pointcloudlabeler metrics stems   --octree-dir $D
pointcloudlabeler metrics qsm     --octree-dir $D
pointcloudlabeler qc flags        --octree-dir $D > qc.json
jq '.flags[] | select(.severity == "critical") | .treeId' qc.json

pointcloudlabeler review set      --octree-dir $D --verdicts '{"17":"ok","42":"flag"}'
pointcloudlabeler export las      --octree-dir $D --out-path ./exports/plot1001_segmented.laz
```

Results are JSON on stdout — one object or array, pretty-printed unless
`--compact` — so `jq` reads them. Progress goes to stderr as lines that
overwrite in a terminal (`--quiet` silences them). Exit status is 0 for
a result, 1 when the operation failed (the message is on stderr), 2 for
a usage error. `--project <folder>` opens a project first, so
operations that take a `projectFolder` need none.

Parameters are typed from the operation's schema: numbers and integers
are checked, booleans take `true`/`false`, a nullable parameter takes
`null`, and a parameter that is an object or a list (`--filter`,
`--verdicts`, `--extra-names`) takes JSON — or, for a list of strings,
a comma-separated list.

Three subcommands take the catalogue by name, for scripts that would
rather build JSON than flags:

```bash
pointcloudlabeler ops list                       # name, group, summary
pointcloudlabeler ops describe transfer.run      # with the parameter schema
pointcloudlabeler ops run qc.flags --params '{"octreeDir":"./evo/octrees/plot1001"}'
pointcloudlabeler ops run qc.flags --params-file params.json   # or "-" for stdin
pointcloudlabeler ops docs > docs/OPERATIONS.md  # the reference, regenerated
```

### Stopping a long run

Long operations hold a *stage* (`segment`, `tst`, `export`, …; each
operation's help names its own). From another terminal:

```bash
pointcloudlabeler run cancel --stage tst
pointcloudlabeler run status --stage tst
```

The run stops at its next check and keeps what it finished, exactly as
the panel's Stop button does.

### Batch recipes

`recipe run` runs one sequence of operations over many plots — the
overnight run over two hundred plots. A recipe is a JSON file:

```bash
pointcloudlabeler recipe example > recipe.json   # the manuscript's workflow, to edit
pointcloudlabeler recipe run recipe.json --report report.json
pointcloudlabeler recipe run recipe.json --plot a.laz --plot b.laz --stop-on-error
```

```json
{
  "name": "plots 2023",
  "projectFolder": "./evo-2023",
  "plots": ["./laz/plot1001.laz", "./laz/plot1002.laz"],
  "steps": [
    { "op": "dataset.import",  "params": { "srcPath": "{{plot}}", "projectFolder": "{{project}}" } },
    { "op": "ground.classify", "params": { "octreeDir": "{{dataset}}" } },
    { "op": "segment.chm",     "params": { "octreeDir": "{{dataset}}", "minHeight": 3.0 } },
    { "op": "metrics.qsm",     "params": { "octreeDir": "{{dataset}}" }, "optional": true },
    { "op": "metrics.volumes", "params": { "octreeDir": "{{dataset}}", "defaultSpecies": "pine" } },
    { "op": "metrics.plot",    "params": { "octreeDir": "{{dataset}}", "fit": "rectangular" } },
    { "op": "metrics.biomass", "params": { "octreeDir": "{{dataset}}" }, "optional": true },
    { "op": "metrics.bucking", "params": { "octreeDir": "{{dataset}}", "outCsv": "{{project}}/exports/{{plotName}}_bucking.csv" }, "optional": true },
    { "op": "qc.flags",        "params": { "octreeDir": "{{dataset}}" } },
    { "op": "export.las",      "params": { "octreeDir": "{{dataset}}", "outPath": "{{project}}/exports/{{plotName}}.laz" } },
    { "op": "export.report",   "params": { "octreeDir": "{{dataset}}", "outPath": "{{project}}/exports/{{plotName}}_report.html" } }
  ],
  "stopOnError": false
}
```

Placeholders are filled per plot: `{{plot}}` (the path as given),
`{{plotName}}` (its file name without the extension), `{{project}}`
(the recipe's `projectFolder`), `{{dataset}}` (the directory the most
recent import, subset, clean or downsample in this plot's run produced)
and `{{steps.N.field}}` (a field of step N's result, 0-based). A value
that is exactly one placeholder takes the referenced value with its
type; otherwise placeholders are spliced into the text.

Plots run one after another. A failing step ends that plot's run and
the next plot starts, unless the step is `optional` (the run goes on)
or the recipe says `stopOnError`. The report — JSON on stdout and, with
`--report`, in a file — lists every step's outcome per plot with its
time and error, and the command exits 1 when any plot failed. A plot
may also be a dataset directory already imported; `{{dataset}}` then
starts as that directory.

## The console interface

```bash
pointcloudlabeler tui
pointcloudlabeler --project ./evo tui
```

Four panes: the project's **datasets**, the **operations** by group, the
selected operation's **parameters** as a form built from its schema
(the selected dataset's directory already filled in), and the **run** —
a progress bar, a log, and the **result** as JSON. After `qc.flags` the
result pane is a table of flags ranked by severity, and `o`, `f` and `x`
record the selected tree's verdict (ok, flag, cleared) through the same
`review.json` Tree Review writes, moving on to the next tree as the
panel's sequential review does.

| Key | Does |
| --- | --- |
| `Tab` / `Shift-Tab` | next / previous pane |
| `↑` `↓` (`PgUp` `PgDn`) | move in a list, the form, the table, or scroll the result |
| `Enter` | datasets: go to operations · operations: go to the form · form: edit the field |
| `e` / `Space` | edit / clear the field |
| `r` or `Shift-Enter` | run the operation |
| `c` | ask the running operation to stop |
| `P` | open a project (type its folder) |
| `R` | re-list the datasets |
| `o` `f` `x` | in the QC table: verdict ok / flag / cleared |
| `t` / `j` | result pane: table / JSON |
| `?` | the key list in the status line |
| `q` | quit |

## The HTTP API

```bash
pointcloudlabeler serve                                   # http://127.0.0.1:7878
pointcloudlabeler serve --bind 0.0.0.0:7878 --token "$TOKEN"
pointcloudlabeler serve --bind 0.0.0.0:7878 --print-token  # makes one, prints it
pointcloudlabeler serve --tls-cert cert.pem --tls-key key.pem --token "$TOKEN"   # HTTPS (feature api-tls)
```

The server listens; it never connects anywhere. On the loopback
interface it runs without a token. Bound to any other address it
refuses to start without one (`--token`, or the
`POINTCLOUDLABELER_API_TOKEN` environment variable), and with a token
every request must carry `Authorization: Bearer <token>`. Note that an
operation runs with the permissions of the process on the machine the
server runs on, and takes file paths on that machine: an API exposed
beyond the loopback interface should be behind a token *and* a network
you trust.

| Route | Does |
| --- | --- |
| `GET /api/health` | version, operation and job counts, the open project |
| `GET /api/ops` | the catalogue with parameter schemas; `GET /api/ops/{name}` one operation |
| `POST /api/ops/{name}` | run the operation with the JSON body as its parameters; the result as JSON (422 with `{"error": …}` when it fails) |
| `POST /api/ops/{name}?async=1` | start it as a job: 202 with `{"jobId", "events"}` and a `Location` header (`Prefer: respond-async` does the same) |
| `GET /api/jobs`, `GET /api/jobs/{id}` | jobs and their state: status, stage, percent, result or error |
| `GET /api/jobs/{id}/events` | server-sent events: the state, then `progress` events, then `done` or `failed`; the stream closes with the job |
| `DELETE /api/jobs/{id}` | ask the job's stage to stop |
| `GET /api/openapi.json` | an OpenAPI 3.1 document generated from the catalogue |
| `POST /mcp` | the Model Context Protocol, streamable HTTP transport (below) |

```bash
curl -s http://127.0.0.1:7878/api/ops | jq '.[].name'
curl -s -X POST http://127.0.0.1:7878/api/ops/qc.flags \
     -H 'Content-Type: application/json' \
     -d '{"octreeDir":"/data/evo/octrees/plot1001"}' | jq '.critical'
curl -s -X POST 'http://127.0.0.1:7878/api/ops/transfer.run?async=1' \
     -d '{"baselineDir":"/data/evo/octrees/tls2021","targetDir":"/data/evo/octrees/heli2023"}'
# → {"jobId":1,"events":"/api/jobs/1/events", ...}
curl -N http://127.0.0.1:7878/api/jobs/1/events
# event: progress
# data: {"id":1,"stage":"tst","pct":42.5}
```

Jobs live in memory for the life of the server process. Results that
carry large arrays (M3C2 core points, tree summaries with record lists)
are large as JSON too; the operations that produce them take a flag to
leave the arrays out or to write a file instead.

## The MCP server

The [Model Context Protocol](https://modelcontextprotocol.io) is how AI
assistants call tools. PointCloudLabeler's MCP server offers every
operation of the catalogue as a tool — its name with the dot as an
underscore (`segment_chm`, `qc_flags`, `transfer_run`), its parameter
schema as the tool's input schema, its result as structured content
and as text. A failing operation comes back as a tool result marked as
an error, so the assistant reads the message and can act on it. Tool
calls that carry a progress token receive progress notifications while
the pass runs. The catalogue and the example recipe are offered as
resources.

Two transports:

- **stdio** — `pointcloudlabeler mcp`, for a host that spawns the
  server as a subprocess. Messages are one JSON-RPC object per line.
- **streamable HTTP** — `POST /mcp` on the API server, one JSON-RPC
  message per request; the response as JSON, or as an SSE stream
  carrying the progress notifications first when the client accepts
  `text/event-stream`. The API's token applies.

Configuration for a host that spawns servers, with the path to the
binary:

```json
{
  "mcpServers": {
    "pointcloudlabeler": {
      "command": "/path/to/pointcloudlabeler",
      "args": ["mcp"]
    }
  }
}
```

A host with a command line for registering servers takes the same two
pieces: the command `/path/to/pointcloudlabeler mcp` for stdio, or the
URL `http://127.0.0.1:7878/mcp` for a running API server (with the
API's bearer token as the `Authorization` header when one is set).

The server's `initialize` reply tells the assistant how the tools fit
together: start with `project_open` or `project_create`, then
`dataset_import`; `ground_classify` before any `segment_*`;
`metrics_trees` and `qc_flags` read the segmentation; operations that
write say so in their descriptions. Paths are on the machine the server
runs on.

## Scanner projects: import, register, export

The Preprocessing module's pipeline — a scanner's own files in, a
registered LAS / LAZ out — is the `preprocess` group. An E57 file, a
PTX / PTS file or an XYZ / ASCII file is imported as a *scanner
project* into the project folder's `preprocessing/` manifests (the
source files are never touched); its scan positions are registered
into one frame; a region of them is exported as the LAS that
`dataset.import` takes.

```bash
pointcloudlabeler project open --folder ./evo
pointcloudlabeler preprocess import --source-path ./scans/plot1001.e57
pointcloudlabeler preprocess scans                     # every scan position, with its pose
pointcloudlabeler preprocess solve --ties '[{"source":[…],"target":[…]}, …]' \
    --apply-to '{"importer":"e57","projectId":"plot1001","scanId":"sp_001"}'
pointcloudlabeler preprocess icp --source '{…}' --target '{…}' --method pointToPlane --apply true
pointcloudlabeler preprocess msa --apply true          # every E57 / PTX scan at once
pointcloudlabeler preprocess export --format e57 --id plot1001 --out-path ./laz/plot1001.laz \
    --x-min 500000 --x-max 500030 --y-min 6800000 --y-max 6800030
pointcloudlabeler dataset import --src-path ./laz/plot1001.laz --scanner-type tls
```

Registration is the panel's arithmetic: `preprocess.solve` is Kabsch
over at least three tie points in world coordinates, and the result
is a *correction* composed onto the scan's current pose; `preprocess.icp`
is point-to-point (Besl & McKay 1992) or point-to-plane (Chen &
Medioni 1991) fine refinement returning an *absolute* pose;
`preprocess.targets` detects sphere targets and plane patches in one
scan; `preprocess.matchSpheres` pairs the spheres of two scans by
RANSAC and solves over the pairs; `preprocess.msa` is the
multi-station adjustment over every E57 / PTX scan with sphere and
plane correspondences for every pair. Every step reports first and
writes a pose only with `apply`, as the panel's Apply buttons do: a
pose overwrite cannot be undone short of re-importing the project.

## Every column of the record

A dataset's point record is the base fields — x, y, z, tree id,
intensity, classification, return number and number of returns, the
semantic label — followed by the *extra columns*, each an f32 (4
bytes) or, declared by `type: float64` in `metadata.extras`, an f64
(8 bytes). The extras are the file's Extra Bytes dimensions by name
and, for LAS, the **standard fields of the record** under their
reserved names: `gps_time` (f64 — adjusted standard GPS time is about
1e9 s, and an f32 steps by 64 s there), `red`, `green`, `blue`, `nir`,
`point_source_id`, `scan_angle` (degrees), `user_data`,
`scan_direction`, `edge_of_flight_line`, `synthetic`, `key_point`,
`withheld`, `overlap` and `scanner_channel`, each available where the
point format carries it. Every column colours the viewport, filters,
and is written back where the record keeps it on export.

```bash
pointcloudlabeler dataset import --src-path ./plot.laz --scanner-type mls \
    --extra-names '["gps_time","red","green","blue","point_source_id","reflectance"]'
pointcloudlabeler export las --octree-dir ./evo/octrees/plot --out-path ./plot_out.laz
```

`export.las` puts the standard fields back into the record and picks
the point format with room for them (LAS 1.2: 0, 1 with GPS time, 2
with colour, 3 with both; LAS 1.4: 6, 7 with colour, 8 with
near-infrared), with the GPS time type the source declared;
`standardFields: false` writes zeros there and offers the columns as
Extra Bytes instead (an f64 column as a double). An XYZ / ASCII file's
time column (`preprocess.xyzMapping`'s `gpsTime`) goes out as the GPS
time of the LAS the import reads.

### Text, PLY and E57 files

`dataset.import` takes a text file (`.txt`, `.xyz`, `.csv`, `.asc`,
`.pts`), a `.ply` or an `.e57` as well as LAS / LAZ, and `export.las`
writes any of them by the output path's extension. Both go through a
LAS: an import stages the file as a LAS 1.4 inside the dataset
directory with every mapped column in it — the record's own fields
where the record keeps them, everything else as a 64-bit Extra Bytes
dimension under its own name — and converts that; an export writes
its LAS to a temporary file beside the destination and transcodes it,
every option (filters, normalisation, reprojection, the attribute
choices) honoured. `dataset.probe` reports what a file has first: its
columns (a text file's header names, or `column_1 … column_N` without
a header; a PLY's vertex properties; an E57's attributes plus `scan`,
the scan's index), the first rows, and the `mapping` an import would
guess from the names — `x`, `y`, `z`, `intensity`, `red`, `green`,
`blue`, `classification`, `gpsTime`, `treeId`, `semantic`,
`returnNumber`, `numberOfReturns`, `pointSourceId`, `scanAngle`,
`userData`, `nir`, `standingDeadwood`, `layingDeadwood`, and `extras`,
the columns carried exact under their own names (an amplitude beside
the intensity it was scaled into; a reflectance is its own column,
never taken for an intensity). Pass the mapping back changed, or
leave it out for the guess.

```bash
pointcloudlabeler dataset probe --path ./plot.txt
pointcloudlabeler dataset import --src-path ./plot.txt --scanner-type tls \
    --mapping '{"x":"X","y":"Y","z":"Z","intensity":"Intensity","treeId":"tree_id","extras":["Reflectance"]}'
pointcloudlabeler dataset import --src-path ./scans.e57 --scanner-type tls   # every scan, poses applied
pointcloudlabeler export las --octree-dir ./evo/octrees/plot --out-path ./plot.csv --delimiter comma
pointcloudlabeler export las --octree-dir ./evo/octrees/plot --out-path ./plot.ply --ply-ascii false
pointcloudlabeler export las --octree-dir ./evo/octrees/plot --out-path ./plot.e57
```

A text export is one row per point: `x y z intensity return_number
number_of_returns classification`, then each standard field the
dataset carries as a column, then every Extra Bytes dimension —
`tree_id`, `semantic_class`, the deadwood ids, every numeric extra —
under its own name, integers as integers and floats as the shortest
text that reads back to the same number; `delimiter` is `space`,
`tab`, `comma` or `semicolon`, `header` names the columns on the first
line, `decimals` rounds the coordinates. A PLY is a `vertex` element
with one typed property per column (binary little-endian, or ascii
with `plyAscii`). An E57 is one point cloud with the position,
intensity, colour, time stamp and returns as standard attributes and
every other column under a `pcl` extension namespace, which any E57
reader may ignore and keep the geometry. An E57 import reads every
scan of the file in the world frame (poses applied), cartesian or
spherical, with intensity and colour as recorded, the time stamp
offset by each scan's acquisition start, and the scan's index as the
`point_source_id` so the Point QC wind stage can tell the scans apart.

## Two datasets on each other: fine registration

The Preprocessing module registers *scan positions* — the stations of
one scanner project. Two *datasets* of one plot — two TLS epochs, a
TLS plot and the MLS walk through it, a drone flight over both — are
registered by `change.register` (the Editor's Fine registration
panel): the rigid transform that puts the moving dataset on the
reference, in six degrees of freedom, with the figure that says how
sure it is.

```bash
pointcloudlabeler change register --reference-dir ./evo/octrees/plot1001_2024 \
    --moving-dir ./evo/octrees/plot1001_2025 --init auto --search-radius 10 \
    --out-json ./plot1001.registration.json
pointcloudlabeler change register --reference-dir … --moving-dir … --apply true --name "plot1001 2025 registered"
pointcloudlabeler dataset transform --octree-dir ./evo/octrees/plot1001_2025 \
    --name "plot1001 2025 registered" --registration-json ./plot1001.registration.json
```

The fit (`src-tauri/src/commands/register.rs`) is symmetric
point-to-plane ICP (Rusinkiewicz 2019; point-to-plane, plane-to-plane
GICP (Segal et al. 2009) and point-to-point as choices) over a pyramid
of decimations — the coarse cells have the wide basin, the fine cell
the precision — with a robust kernel (Welsch by default) whose scale
follows the median residual, so the parts of either cloud the other
does not show weigh nothing; the levelled (xyz + yaw) and
translation-only variants hold what a levelled instrument already
knows. It starts as the two stand (`init: current`), from a manual
offset, from the stored skeleton alignment, from an automatic coarse
search (`init: auto`: the moving cloud's stems and crown tops voted
onto the reference's over the search radius and a fan of yaw, refined
stem to stem, the height from the two grounds), or from a global
search by surface features (`init: features`: FPFH histograms (Rusu
et al. 2009) on both clouds whole, paired, transforms tried from
triples of pairs that agree with each other on the distance between
their points — the pairs agreeing with the most others first — and
the hypothesis chosen by how much of the moving cloud lands on the
reference — any heading, any offset, no ground classification
needed). The report carries the transform (a row-major 4 × 4 in world
coordinates, moving → reference), the translation at the moving
cloud's centre and the rotation with their *standard errors* — from
the covariance at the solution, and again by a spatial block jackknife
(the pairs cut into `jackknifeBlock`-metre cubes, the fit re-solved
with each left out), which counts what neighbouring pairs share once
where the covariance counts it n times; the larger is the one to quote
— the RMS, median and robust plane residual, the inlier and overlap
fractions, a residual histogram, a moved point's uncertainty at the
cloud's radius (`positionStdErr`), and the observability of the fit
(Gelfand et al. 2003): a flat field constrains height and tilt and
nothing else, and the report says so (`wellConstrained`, `weakest`)
rather than returning a horizontal shift it never measured.
`change.m3c2` takes the registration's JSON as `registrationJson` and
uses its `positionStdErr` as the registration error in the level of
detection, in place of a guessed `regError`.

Nothing moves until `apply`, or `dataset.transform`: the moving
dataset is written as a *new* dataset through the transform — every
point re-quantised on a fresh millimetre grid, every edit baked in,
every extra column kept, the CRS carried, the species and review
sidecars copied — with the transform and the fit's figures recorded
under `registration` in its metadata.json. The source is never
touched, so the move is undone by removing the copy.

## What the headless surfaces share with the desktop application

The operations call the same Rust functions the desktop application's
Tauri commands call, with the same defaults the panels send — copied
from the panels' `DEFAULT_*` constants and named for where they come
from in each parameter's description. Where a panel does a step in
TypeScript after a pass, the operation does the same step: after a
segmenter rewrites a column, the overrides for that column are cleared
from the edit overlay (`patches.bin`), so a reload cannot undo the run;
after a transfer, the target's tree-id and semantic overrides are
cleared likewise.

The forestry arithmetic the renderer owns is implemented again in Rust
for the headless surfaces, function for function, and pinned from both
sides by tests that read the constants out of the TypeScript and the
Rust and fail on a drift in either:

- the ten per-tree QC checks with their robust statistics
  (`src/metrics/qcFlags.ts` ↔ `src-tauri/src/ops/qc.rs`) and the merge
  that puts a RANSAC stem fit's diameter in place of the algebraic one
  — `src/testing/qcParity.test.ts`;
- the stem volume functions (Laasasenaho 1982 for pine, spruce and
  birch, with the QSM-first, form-factor-last resolution), biomass,
  carbon and CO₂e with the per-species wood densities and the
  correlated-density uncertainty of the plot totals, and the
  edge-corrected per-hectare statistics with the plot-boundary geometry
  (`src/metrics/volumeFunctions.ts`, `biomass.ts`, `plotStats.ts`,
  `src/utils/plotBoundary.ts` ↔ `src-tauri/src/ops/forestry.rs`) —
  `src/testing/forestryParity.test.ts`. They are the operations
  `metrics.volumes`, `metrics.biomass` and `metrics.plot`;
- the thinning simulator (`src/metrics/thinning.ts` ↔
  `src-tauri/src/ops/thinning.rs`): strip roads at a heading and
  spacing, forced corridor removal, boom-reach candidates scored by
  strategy with the quality weight redistributed when no tree has a
  QSM, greedy removal to a target basal area, and the removed list as
  the panel's CSV — `metrics.thinning`, pinned by the same parity test;
- the HTML inventory report (`src/report/generate.ts` ↔
  `src-tauri/src/ops/report.rs`): the same self-contained file the
  Report panel saves, from what is on disk — the metrics, qsm.json,
  species.json, plot.json and, on request, the density metrics. The
  sections the panel fills from other panels' in-memory state (field
  validation, tree growth, M3C2, stem taper) are not rendered; the
  report says what it can back up. `export.report`; the cover date is
  the UTC day unless `date` is given, since the headless binary has no
  timezone database. Given `fieldCsv` or `referenceDir`, the report
  also renders the field-data validation and the tree-growth blocks
  from the two operations below;
- bucking (`src/metrics/bucking.ts` ↔ `src-tauri/src/ops/bucking.rs`):
  greedy from the stump up in priority order, longest module first,
  every volume integrated over the measured taper the way the QSM
  integrated it, so stump + logs + residue is the QSM's stem volume
  and no log is sold out of stem nobody measured — `metrics.bucking`,
  with the panel's sawlog / pulpwood / energy assortments as the
  default and the per-tree CSV named for the currency;
- tree matching between two sets by position (`src/metrics/assignment.ts`
  ↔ `src-tauri/src/ops/matching.rs`): the optimal assignment
  (Jonker–Volgenant) on squared distance within a radius, pairs first
  and distance second, with the greedy nearest-first pairing kept for
  comparison; behind it, tree growth between two epochs
  (`src/metrics/growth.ts` ↔ `ops/growth.rs`, `change.growth`: a
  difference is an increment only where both scans measured the thing)
  and field-data validation (`src/metrics/fieldValidation.ts` ↔
  `ops/validation.rs`, `qc.validate`: the crew's CSV read with the
  renderer's own parser — sniffed delimiter, decimal comma, strict
  numbers, the formula guard undone — matched to the measured trees,
  then bias, RMSE and the fit over the usable pairs only).

`metrics.plot` takes its boundary from the dataset's `plot.json` (what
`review.setPlot` writes), from a `boundary` parameter, or — when the
dataset has none — fits one to the stems on request (`fit`:
`rectangular` or `circular`, shrunk by `fitMargin`). Edge correction
defaults to the panel's `crownArea`. A figure that could not be
computed (Lorey's height with no measured heights, a volume for a tree
with no diameter) is `null` in the JSON, never zero.

- the cross-sensor comparison (`src/metrics/crossSensor.ts`,
  `src/metrics/treeModel.ts` ↔ `src-tauri/src/ops/crosssensor.rs`):
  ALS and TLS / MLS trees over one plot matched by position, the
  detection rate overall and by diameter class (the single F1 hides
  the curve), the joined table with the TLS stem volume beside the
  ALS metrics, and a volume model fitted on the matched trees —
  log-log or linear, Duan's smearing for the back-transform, striped
  cross-validation for the error worth quoting — applied to the trees
  TLS missed, each prediction marked where it extrapolates:
  `change.crossSensor`;
- the Metrics module's per-tree CSV (`src/modules/MetricsModule.tsx`,
  `src/metrics/qsmAttributesCsv.ts` ↔ `src-tauri/src/ops/metricscsv.rs`),
  column for column, with the QSM, biomass and TreeQSM blocks present
  when any tree has them: `export.csv`.

`export.report` renders the M3C2 block too, given `m3c2ReferenceDir`
(it runs `change.m3c2` with the same settings).

Not in the catalogue, by design: anything that needs a viewport —
manual editing, figures, and the stem-taper picks the report's taper
table comes from.

## Notes

- **One process at a time per dataset.** The dataset lock that keeps
  two passes from rewriting the same octree is in-process. Do not run a
  headless operation on a dataset the desktop application has open with
  unsaved edits: the application saves its edit overlay before its own
  passes, but a process beside it would not see those edits, and a
  pass rewriting `octree.bin` under an open viewer is undefined.
- **Paths are local.** Every operation takes paths on the machine it
  runs on and runs with that process's permissions; the headless
  surfaces do not have the desktop application's dialog-based path
  grants.
- **Progress scale.** Passes report 0–100 (a few 0–1); the surfaces
  normalise to percent.
- **Where the files go.** `dataset.import` writes to
  `<projectFolder>/octrees/<safe name>`, as the Editor does, unless
  `outDir` says otherwise; `export.subset`, `dataset.clean` and
  `dataset.downsample` put the new dataset beside the source.
