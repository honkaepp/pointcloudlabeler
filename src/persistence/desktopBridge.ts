// Installs the renderer ↔ desktop bridge by mapping every method on
// `window.desktop` to a Tauri command from src-tauri/. The renderer
// (App.tsx, fsCloudStore.ts, projectStore.ts, plugins/persist.ts, …)
// reads from window.desktop without caring how the bridge is wired.
//
// Detection: Tauri 2 exposes `window.__TAURI_INTERNALS__`. If that
// global is absent (e.g. unit tests, pure browser preview) the bridge
// stays uninstalled and the renderer falls back to the no-desktop UX
// (no file IO, no project DB).

import type { TreeSummaryEntry, TerrainResult, TreeMetric, StemFit, QsmResult, DensityMetricsResult, CrsListEntry, EpsgLookupEntry, NadGridStatus, GeoidStatus } from './octreeReader';
import { withDatasetBusy } from '../state/datasetBusy';
import { decodeSkeletonPlanar } from './skeletonPlanar';
import type { RendererFailure } from './rendererFailure';

type ProjectChangedHandler = (action: string, payload?: unknown) => void;

/** What an export wrote.
 *
 *  A normalised export cannot give a point a height above ground when no
 *  ground surface reaches it, and LAS stores Z as a scaled integer that
 *  cannot hold a NaN — so those points are left out. `skippedNoGround`
 *  is how the caller finds out, rather than a file that is quietly short. */
export type ExportReport = { written: number; skippedNoGround: number };

type InvokeArgs = Record<string, unknown> | ArrayBuffer | Uint8Array;
interface BridgeCtx {
  invoke: <T = unknown>(cmd: string, args?: InvokeArgs, options?: { headers: HeadersInit }) => Promise<T>;
  listen: <T = unknown>(event: string, cb: (e: { payload: T }) => void) => Promise<() => void>;
  getCurrentWebview: () => { onDragDropEvent: (cb: (e: { payload: DragDropPayload }) => void) => Promise<() => void> };
}

type DragDropPayload =
  | { type: 'enter'; paths: string[] }
  | { type: 'over' }
  | { type: 'drop'; paths: string[] }
  | { type: 'leave' };

/** What `dialog_pick_file` hands back: the path the user chose, plus
 *  the name and byte size the import flow needs up front. */
interface PickedFile {
  name: string;
  size: number;
  path: string;
}

function isTauri(): boolean {
  return typeof window !== 'undefined'
    && !!(window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

async function loadTauri(): Promise<BridgeCtx | null> {
  try {
    const core = await import(/* @vite-ignore */ '@tauri-apps/api/core');
    const event = await import(/* @vite-ignore */ '@tauri-apps/api/event');
    const webview = await import(/* @vite-ignore */ '@tauri-apps/api/webview');
    return {
      invoke: core.invoke as BridgeCtx['invoke'],
      listen: event.listen as BridgeCtx['listen'],
      getCurrentWebview: webview.getCurrentWebview as BridgeCtx['getCurrentWebview'],
    };
  } catch (e) {
    console.warn('Tauri API not available', e);
    return null;
  }
}

/** skeleton_alignment.json as the Rust side writes it — see
 *  shell/OctreeShellContext.ts SkeletonAlignment. */
interface SkeletonAlignmentRecord {
  format: string;
  baselineDir: string;
  targetDir: string;
  origin: [number, number, number];
  dx: number; dy: number; theta: number; cx: number; cy: number;
  rmse: number;
  matchedTrees: number;
  treeCount: number;
  confidence: number;
  coarse: { dx: number; dy: number; theta: number; cx: number; cy: number };
  createdAt: string;
  targetShifted?: [number, number];
}

function installShim(ctx: BridgeCtx) {
  const menuHandlers = new Set<ProjectChangedHandler>();

  // Forward every event the renderer ever cared about (menu clicks + project
  // state change) so subscribers see them as "menu actions" — App.tsx
  // (onMenuAction) subscribes once and dispatches based on event name.
  const TAURI_EVENTS = [
    'project:changed',
    'menu:open-cloud',
    'menu:save',
    'menu:export',
    'menu:project-new',
    'menu:project-open',
    'menu:project-close',
    'menu:undo',
    'menu:redo',
    'menu:invert-selection',
    'menu:clear-selection',
    'menu:delete-points',
    'menu:toggle-legend',
    'menu:toggle-filters',
    'menu:shortcuts',
  ] as const;
  for (const ev of TAURI_EVENTS) {
    ctx.listen<unknown>(ev, (e) => {
      for (const cb of menuHandlers) cb(ev, e.payload);
    }).catch(() => { /* ignore */ });
  }

  // Native file drag-drop. Tauri intercepts the drop, so the browser's onDrop
  // never sees the file paths; we forward the dropped path as menu:open-file
  // which App.tsx already routes to handleNativeFilePath().
  try {
    ctx.getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type !== 'drop') return;
      const path = e.payload.paths[0];
      if (!path) return;
      for (const cb of menuHandlers) cb('menu:open-file', path);
    }).catch(() => { /* ignore */ });
  } catch { /* webview API not available in this Tauri version */ }

  const api = {
    openFile: async () => {
      const picked = await ctx.invoke<PickedFile | null>('dialog_pick_file', {
        filters: [{ name: 'Point Cloud', extensions: ['txt', 'xyz', 'csv', 'las', 'laz'] }],
      });
      return picked?.path ?? null;
    },
    // Richer file picker used by the octree import flow: opens the native
    // open dialog (honouring caller-supplied filters), then resolves the
    // picked path into a { name, size, path } descriptor by stat-ing the
    // file. Returns null when the user cancels. The EditorModule import
    // button drives this; it needs the name + byte size up front (for the
    // dataset name + the header-probe slice bounds), not just a path.
    openFileDialog: async (opts?: { filters?: { name: string; extensions: string[] }[] }) => {
      // One round trip now: the Rust dialog stats the file it just
      // granted, so the name and size come back with the path instead
      // of needing a second call that has to be permitted separately.
      const picked = await ctx.invoke<PickedFile | null>('dialog_pick_file', {
        filters: opts?.filters ?? [{ name: 'Point Cloud', extensions: ['txt', 'xyz', 'csv', 'las', 'laz'] }],
      });
      return picked ?? null;
    },
    readFile: async (path: string): Promise<ArrayBuffer> => {
      // file_read returns Response (Vec<u8>) — Tauri's invoke yields an ArrayBuffer.
      const bytes = await ctx.invoke<ArrayBuffer | Uint8Array>('file_read', { path });
      return bytes instanceof ArrayBuffer ? bytes : ((bytes as Uint8Array).buffer as ArrayBuffer);
    },
    readFileChunk: async (path: string, offset: number, length: number): Promise<ArrayBuffer> => {
      const bytes = await ctx.invoke<ArrayBuffer | Uint8Array>('file_read_chunk', {
        path, offset, length,
      });
      return bytes instanceof ArrayBuffer ? bytes : ((bytes as Uint8Array).buffer as ArrayBuffer);
    },
    // Range read [start, end) for the import header probe. Thin wrapper over
    // file_read_chunk (offset + length) so the EditorModule's Blob-like
    // slice(start, end) maps straight through.
    readFileRange: async (path: string, start: number, end: number): Promise<ArrayBuffer> => {
      const length = Math.max(0, end - start);
      const bytes = await ctx.invoke<ArrayBuffer | Uint8Array>('file_read_chunk', {
        path, offset: start, length,
      });
      return bytes instanceof ArrayBuffer ? bytes : ((bytes as Uint8Array).buffer as ArrayBuffer);
    },
    statFile: (path: string) => ctx.invoke('file_stat', { path }),
    saveFileDialog: (defaultName: string) =>
      ctx.invoke<string | null>('dialog_save_file', {
        defaultName,
        filters: [{ name: 'Text', extensions: ['txt'] }],
      }),
    saveLasDialog: async (defaultName: string) => {
      // Two filters → the OS dialog gets a format dropdown the user can
      // pick from. LAS is offered first (default), LAZ second.
      // Tauri preserves the chosen filter's extension in the returned
      // path, so the export step can dispatch on it.
      return ctx.invoke<string | null>('dialog_save_file', {
        defaultName,
        filters: [
          { name: 'LAS point cloud', extensions: ['las'] },
          { name: 'LAZ compressed point cloud', extensions: ['laz'] },
        ],
      });
    },
    // Save dialog for a CSV / text export. Returns the chosen path (with
    // .csv) or null if cancelled; pair with writeFile to persist content.
    // A save dialog with caller-chosen filters and title, for the
    // exports that are not CSV / LAS / plain text. Same command as the
    // three above; only the dropdown differs.
    saveExportDialog: (
      defaultName: string,
      filters: { name: string; extensions: string[] }[],
      title?: string,
    ) => ctx.invoke<string | null>('dialog_save_file', { defaultName, filters, title }),
    // A folder picker with the caller's own title. Picking the folder
    // grants it, which is what permits reading the files inside.
    browseForFolder: (title?: string) =>
      ctx.invoke<string | null>('dialog_pick_folder', { title }),
    saveCsvDialog: (defaultName: string) =>
      ctx.invoke<string | null>('dialog_save_file', {
        defaultName,
        filters: [{ name: 'CSV (comma-separated)', extensions: ['csv'] }],
      }),
    writeFile: (path: string, content: string) =>
      ctx.invoke<boolean>('file_write', { path, content }),
    // The binary sibling, for the PNGs the Compare view exports. The
    // bytes travel as the raw request body and the path in a header —
    // percent-encoded, because a header value is Latin-1 at best and a
    // Finnish path ("Työpöytä") is not; the Rust side decodes it.
    writeFileBytes: (path: string, bytes: Uint8Array) =>
      ctx.invoke<boolean>('file_write_bytes', bytes, { headers: { 'x-path': encodeURIComponent(path) } }),
    // Drag-drop native paths: Tauri renders File objects without `path`, but the
    // file drop event has paths. For now the caller can use openFile() to fall back.
    getPathForFile: (_file: File) => '',
    addRecent: (path: string) => ctx.invoke<void>('recent_add', { path }),

    // Cloud IO — the Rust side wires every command to the matching binary
    // in src-tauri/src/commands/cloud.rs.
    cloudWriteOpen: (existingId: string | null) =>
      ctx.invoke<{ handle: number; id: string; filePath: string }>('cloud_write_open', {
        existingId,
      }),
    // Open an arbitrary file path for streaming writes. Reuses the cloud write
    // handle pool so the same append/commit/abort commands work on the result.
    // Used by the TXT export path to dump multi-GB blobs straight to disk
    // without buffering them in JS (which OOMs WebView2 around 3 GB).
    fileWriteOpen: (path: string) =>
      ctx.invoke<{ handle: number; id: string; filePath: string }>('file_write_open', { path }),
    cloudWriteAppend: async (handle: number, bytes: ArrayBuffer): Promise<boolean> => {
      // Raw binary IPC: ArrayBuffer is sent as the request body (no JSON number
      // array round-trip), with the write handle in a custom header. Saves the
      // 2x base64 encode+decode pass and keeps the bytes zero-copy on Windows.
      await ctx.invoke(
        'cloud_write_append_raw',
        bytes,
        { headers: { 'x-handle': String(handle) } },
      );
      return true;
    },
    cloudWriteCommit: (handle: number) =>
      ctx.invoke<boolean>('cloud_write_commit', { handle }),
    cloudWriteAbort: (handle: number) =>
      ctx.invoke<boolean>('cloud_write_abort', { handle }),
    cloudReadOpen: (id: string) =>
      ctx.invoke<{ handle: number; totalSize: number }>('cloud_read_open', { id }),
    cloudReadChunk: async (handle: number, offset: number, length: number): Promise<ArrayBuffer> => {
      const bytes = await ctx.invoke<ArrayBuffer | Uint8Array>('cloud_read_chunk', {
        handle, offset, length,
      });
      return bytes instanceof ArrayBuffer ? bytes : ((bytes as Uint8Array).buffer as ArrayBuffer);
    },
    cloudReadClose: (handle: number) =>
      ctx.invoke<boolean>('cloud_read_close', { handle }),
    cloudList: () => ctx.invoke('cloud_list'),
    cloudDelete: (id: string) => ctx.invoke<boolean>('cloud_delete', { id }),
    cloudRename: (id: string, name: string) =>
      ctx.invoke<boolean>('cloud_rename', { id, name }),

    // Out-of-core LAZ → octree converter (Stage 1). Streams the source
    // file on the Rust side and writes metadata.json + hierarchy.bin +
    // octree.bin into the chosen output directory. The runtime viewer
    // for these clouds lands in a follow-up stage.
    cloudImportOctree: (args: {
      srcPath: string;
      outDir: string;
      name: string;
      scannerType: string;
      rootSpacing: number;
      maxDepth: number;
      treeIdExtraName?: string;
      semanticExtraName?: string;
      /** Optional source columns for the two deadwood id channels. When
       *  given, those Extra-Bytes columns seed the standing / laying
       *  deadwood ids; otherwise the channels start empty (the editor
       *  labels them). The channels always exist in the result either way. */
      standingDeadwoodExtraName?: string;
      layingDeadwoodExtraName?: string;
      /** Extra LAS Extra-Bytes columns to carry into the octree as f32
       *  values. Each appears in the Display panel's Colour by menu
       *  after the import finishes. */
      extraNames?: string[];
      /** When false the two reserved deadwood id channels are NOT
       *  created (saves 8 bytes/point); they can be added later in-app
       *  via octreeAddDeadwoodColumns. Missing ⇒ true (legacy default).
       *  Set false on big TLS imports the user doesn't plan to label
       *  deadwood on — the gain is measurable on multi-GB clouds. */
      includeDeadwood?: boolean;
    }) => ctx.invoke<unknown>('cloud_import_octree', args),
    onOctreeProgress: (cb: (e: { stage: string; pct: number }) => void) =>
      ctx.listen<{ stage: string; pct: number }>('octree-progress', (e) => cb(e.payload)),
    octreeList: (projectFolder: string) =>
      ctx.invoke<unknown>('octree_list', { projectFolder }),
    octreeReadMeta: (octreeDir: string) =>
      ctx.invoke<unknown>('octree_read_meta', { octreeDir }),
    octreeReadBlock: async (octreeDir: string, byteOffset: number, byteSize: number): Promise<ArrayBuffer> => {
      const bytes = await ctx.invoke<ArrayBuffer | Uint8Array>('octree_read_block', {
        octreeDir, byteOffset, byteSize,
      });
      return bytes instanceof ArrayBuffer ? bytes : ((bytes as Uint8Array).buffer as ArrayBuffer);
    },
    // Column-extracting block read: returns ONLY the requested byte
    // ranges of each point record, packed column-by-column in request
    // order (fields = [recordOffset, widthBytes] pairs). The streamer
    // uses it to skip extra columns the renderer isn't looking at, so
    // IPC + decode cost scales with what's on screen, not with how many
    // columns the file happens to carry.
    octreeReadBlockColumns: async (
      octreeDir: string, byteOffset: number, byteSize: number,
      pointBytes: number, fields: Array<[number, number]>,
    ): Promise<ArrayBuffer> => {
      const bytes = await ctx.invoke<ArrayBuffer | Uint8Array>('octree_read_block_columns', {
        octreeDir, byteOffset, byteSize, pointBytes, fields,
      });
      return bytes instanceof ArrayBuffer ? bytes : ((bytes as Uint8Array).buffer as ArrayBuffer);
    },
    octreeReadPatches: async (octreeDir: string): Promise<ArrayBuffer> => {
      const bytes = await ctx.invoke<ArrayBuffer | Uint8Array>('octree_read_patches', { octreeDir });
      return bytes instanceof ArrayBuffer ? bytes : ((bytes as Uint8Array).buffer as ArrayBuffer);
    },
    octreeWritePatches: async (octreeDir: string, bytes: Uint8Array): Promise<number> => {
      // Raw binary IPC: the patches buffer rides as the request body and
      // the dataset path goes in a header. The earlier Array.from(bytes)
      // round-tripped through a JSON number-array — for tens of MB of
      // edits (a few dozen trees) that string ran to hundreds of MB and
      // WebView2 silently hung mid-serialise, so saves looked like they
      // worked but never actually called the Rust writer. Lost edits.
      // Never again: this path is zero-copy and bounded by the network of
      // a single ArrayBuffer transfer.
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      return ctx.invoke<number>(
        'octree_write_patches',
        buffer,
        { headers: { 'x-octree-dir': octreeDir } },
      );
    },
    // Chunked patches save — begin / chunk / commit. savePatches
    // (octreePatches.ts) uses this trio instead of octreeWritePatches so
    // no single buffer ever holds the whole cumulative patch set: on a
    // big correction, building + copying + IPC-shipping one buffer sized
    // to the entire patch history was enough on its own to exhaust
    // WebView2's memory on top of an already-huge loaded scene and crash
    // mid-save. octreeWritePatches above stays for small one-shot writes.
    octreeWritePatchesBegin: (octreeDir: string): Promise<void> =>
      ctx.invoke<void>('octree_write_patches_begin', { octreeDir }),
    octreeWritePatchesChunk: (octreeDir: string, bytes: Uint8Array): Promise<void> => {
      // Same zero-copy rule as octreeWritePatches: ship the buffer as-is
      // when the view already owns exactly its bytes (the normal case —
      // savePatches allocates one exact-size Uint8Array per chunk); only
      // slice (copy) when it's a partial view into something bigger.
      const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
      const buffer = owned
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      return ctx.invoke<void>(
        'octree_write_patches_chunk',
        buffer,
        { headers: { 'x-octree-dir': octreeDir } },
      );
    },
    octreeWritePatchesCommit: (octreeDir: string): Promise<number> =>
      ctx.invoke<number>('octree_write_patches_commit', { octreeDir }),
    // Fold accumulated tree_id + semantic overrides from patches.bin into
    // octree.bin and drop them from patches.bin, so a long correction
    // session (one 32-byte record per point of every corrected tree)
    // doesn't grow the overlay without bound. Deletions + deadwood ids are
    // left in patches.bin untouched — see octree_bake_patches's doc comment.
    octreeBakePatches: (octreeDir: string): Promise<{ baked: number; remaining: number; unmatched: number }> =>
      ctx.invoke<{ baked: number; remaining: number; unmatched: number }>('octree_bake_patches', { octreeDir }),
    octreeRemoveDataset: (octreeDir: string) =>
      withDatasetBusy(() => ctx.invoke<void>('octree_remove_dataset', { octreeDir })),
    // Bake octree.bin + patches.bin into a single LAS / LAZ file. Returns
    // the number of points written. Options (all optional; defaults give
    // the prior loss-less, everything-included behaviour):
    //   normalize  → write Z as height above ground (point Z − DTM)
    //   cellSize   → DTM cell size for the normalise pass
    //   opts.includeTreeId / includeSemantic → emit those extra-byte columns
    //   opts.keepClassification / keepIntensity → keep those fields (else 0)
    //   opts.decimals → X/Y/Z decimal precision (omit = native octree scale)
    //   opts.filter → "export what the filters show"; same predicate shape
    //     octreeSubset takes (below). undefined = every non-deleted point,
    //     the pre-existing behaviour.
    //   opts.targetCrs → reproject every point into this CRS while
    //     streaming ("epsg:XXXX" or a raw proj4 string — same spec syntax
    //     crsTransform above accepts). undefined = export exactly as
    //     today, byte-identical. Requires the dataset to already have a
    //     recorded source CRS (Layers panel); mutually exclusive with
    //     `normalize` — the Rust side rejects that combination outright
    //     (Coordinate Reference System support, part 2).
    cloudExportOctreeLas: (
      octreeDir: string,
      outPath: string,
      normalize = false,
      cellSize = 0.5,
      opts: {
        includeTreeId?: boolean;
        includeSemantic?: boolean;
        /** Emit the standing / laying deadwood id columns (i32 Extra-Bytes
         *  under their reserved names). Default true. */
        includeStandingDeadwood?: boolean;
        includeLayingDeadwood?: boolean;
        keepClassification?: boolean;
        keepIntensity?: boolean;
        decimals?: number;
        /** Names of numeric extra columns to carry through to the
         *  LAS / LAZ Extra-Bytes (one f32 per name). Each must exist
         *  in the dataset's metadata.extras; unknown names error
         *  before any bytes are written. */
        extrasToExport?: string[];
        /** Mirrors src-tauri's SubsetFilter (commands/octree.rs) — only
         *  send the constraints that are actually active, everything
         *  else stays undefined so it doesn't constrain. */
        filter?: {
          xRange?: [number, number];
          yRange?: [number, number];
          zRange?: [number, number];
          intensityRange?: [number, number];
          treeIdRange?: [number, number];
          classes?: number[];
          extraRanges?: { name: string; min: number; max: number }[];
          hideUnassigned?: boolean;
          isolateTreeId?: number;
          semanticHidden?: number[];
          returnsHidden?: number[];
          hideStandingDeadwood?: boolean;
          hideLayingDeadwood?: boolean;
          onlyDeadwood?: boolean;
        };
        targetCrs?: string;
        /** Geoid grid file name (e.g. "egm96_15.gtx") to convert
         *  ellipsoidal heights to orthometric on the way out: H = h - N.
         *  The dataset must be recorded as ellipsoidal — the backend
         *  refuses rather than guessing, because applying this to
         *  already-orthometric heights subtracts the undulation twice.
         *  Applied AFTER any targetCrs reprojection; see octree.rs's
         *  "2.6 - geoid" section for why that order is not arbitrary. */
        geoid?: string;
        /** Write LAS 1.4 / point data record format 6 instead of LAS 1.2 /
         *  format 0. Format 0 packs classification into five bits, so a
         *  class above 31 (the ASPRS user-definable 64..255 range) cannot
         *  be represented and is written as 0. Format 6 gives it a full
         *  byte, and widens the return number and count to four bits. */
        las14?: boolean;
      } = {},
    ) =>
      ctx.invoke<ExportReport>('cloud_export_octree_las', {
        octreeDir, outPath, normalize, cellSize,
        includeTreeId: opts.includeTreeId,
        includeSemantic: opts.includeSemantic,
        includeStandingDeadwood: opts.includeStandingDeadwood,
        includeLayingDeadwood: opts.includeLayingDeadwood,
        keepClassification: opts.keepClassification,
        keepIntensity: opts.keepIntensity,
        decimals: opts.decimals,
        extrasToExport: opts.extrasToExport,
        filter: opts.filter,
        targetCrs: opts.targetCrs,
        geoid: opts.geoid,
        las14: opts.las14,
      }),
    // Move a dataset's coordinates back onto its source file's grid.
    // A dataset imported before the offset was aligned to the file sits
    // up to half a step off it, systematically; this rewrites one
    // metadata field and touches no point. Returns the shift per axis.
    octreeRealignToSource: (octreeDir: string, lasPath: string) =>
      ctx.invoke<{ shiftMm: [number, number, number]; alreadyAligned: boolean; scale: [number, number, number]; sourceScale: [number, number, number] }>(
        'octree_realign_to_source', { octreeDir, lasPath }),
    // Global, patch-aware tally of every tree_id (count + world bbox).
    // One streaming pass over octree.bin — call after flushing patches.
    octreeTreeSummary: (octreeDir: string) =>
      ctx.invoke<TreeSummaryEntry[]>('octree_tree_summary', { octreeDir }),
    // Tree-id merge overlay (treemap.json). Read returns the raw JSON
    // string ("{}" when absent); write persists a flat { fromId: toId }.
    octreeReadTreemap: (octreeDir: string) =>
      ctx.invoke<string>('octree_read_treemap', { octreeDir }),
    octreeWriteTreemap: (octreeDir: string, json: string) =>
      ctx.invoke<null>('octree_write_treemap', { octreeDir, json }),
    // Tree Review per-tree QA status overlay (review.json). Read returns
    // the raw JSON string ("{}" when absent); write persists a flat
    // { treeId: "ok" | "flag" }. Bookkeeping only — never touches points.
    octreeReadReview: (octreeDir: string) =>
      ctx.invoke<string>('octree_read_review', { octreeDir }),
    octreeWriteReview: (octreeDir: string, json: string) =>
      ctx.invoke<null>('octree_write_review', { octreeDir, json }),
    // Per-tree species assignment overlay (species.json). Read returns
    // the raw JSON string ("{}" when absent); write persists a flat
    // { treeId: speciesKey }. Bookkeeping only — never touches points.
    octreeReadSpecies: (octreeDir: string) =>
      ctx.invoke<string>('octree_read_species', { octreeDir }),
    octreeWriteSpecies: (octreeDir: string, json: string) =>
      ctx.invoke<null>('octree_write_species', { octreeDir, json }),
    // Plot boundary overlay (plot.json) — the forestry plot definition
    // (circular / rectangular) the Plot Boundary panel writes. A plot
    // boundary is a property of the dataset, not shell state, so it's
    // persisted next to the octree like species/review. Read returns the
    // raw JSON string ("{}" when absent); write persists the
    // PlotBoundary object as-is. Consumers outside the editor shell
    // (InventoryModule) call this directly since they have no shell
    // context to share the boundary from.
    octreeReadPlot: (octreeDir: string) =>
      ctx.invoke<string>('octree_read_plot', { octreeDir }),
    octreeWritePlot: (octreeDir: string, json: string) =>
      ctx.invoke<null>('octree_write_plot', { octreeDir, json }),
    // Analysis layers saved with a dataset — `<dataset>/layers/<id>.json`
    // + `<id>.bin`. The renderer owns the format (src/layers/
    // analysisLayers.ts) and writes both files through writeFile /
    // writeFileBytes; these three do what it cannot from there: list the
    // folder, make it, delete a layer's two files. See commands/layers.rs.
    octreeLayersList: (octreeDir: string) =>
      ctx.invoke<{ id: string; header: string; payloadBytes: number }[]>('octree_layers_list', { octreeDir }),
    octreeLayerPrepare: (octreeDir: string, id: string) =>
      ctx.invoke<{ jsonPath: string; binPath: string }>('octree_layer_prepare', { octreeDir, id }),
    octreeLayerDelete: (octreeDir: string, id: string) =>
      ctx.invoke<null>('octree_layer_delete', { octreeDir, id }),
    // Classify ground points in place in octree.bin. `method` picks the
    // bare-earth filter — 'pmf' (Progressive Morphological Filter) or
    // 'csf' (Cloth Simulation Filter); rigidity tunes the CSF cloth.
    // Returns the number of points marked ground (class 2).
    octreeClassifyGround: (octreeDir: string, params: {
      cellSize: number; tolerance: number; slope: number;
      initialThreshold: number; maxThreshold: number; maxWindowM: number;
      method?: 'pmf' | 'csf'; rigidity?: number;
    }) => withDatasetBusy(() => ctx.invoke<number>('octree_classify_ground', { octreeDir, ...params })),
    // The z a cloud's ground sits at: the median of its class-2 surface
    // inside `within` [x0, y0, x1, y1] (world), or the bounding box's
    // floor for a cloud with no ground classification. The Compare view
    // lifts a cloud in elevation by it beside a normalised one — see
    // three/comparePose.ts, heightBasesFor.
    octreeGroundReference: (octreeDir: string, within?: [number, number, number, number]) =>
      ctx.invoke<{ z: number; from: 'ground' | 'bbox'; cells: number }>('octree_ground_reference', { octreeDir, within }),
    // A cloud's class-2 ground surface as a grid, for the renderer's
    // "heights above ground" display — see three/terrainGrid.ts for the
    // layout. Rejects a cloud with no ground classification.
    octreeDtmGrid: async (octreeDir: string, cell?: number): Promise<ArrayBuffer> => {
      const bytes = await ctx.invoke<ArrayBuffer | Uint8Array>('octree_dtm_grid', { octreeDir, cell });
      return bytes instanceof ArrayBuffer ? bytes : ((bytes as Uint8Array).buffer as ArrayBuffer);
    },
    // Reset classifications in place. fromClass < 0 matches every point;
    // otherwise only that class. Each match becomes toClass.
    octreeResetClassification: (octreeDir: string, fromClass: number, toClass: number) =>
      withDatasetBusy(() => ctx.invoke<number>('octree_reset_classification', { octreeDir, fromClass, toClass })),
    // Zero the tree_id or semantic column in octree.bin in place. The
    // caller also clears the matching patch overlay so overrides don't
    // re-impose the old values. Returns the number of points changed.
    octreeResetAttribute: (octreeDir: string, attr: 'tree_id' | 'semantic' | 'standing_deadwood' | 'laying_deadwood') =>
      withDatasetBusy(() => ctx.invoke<number>('octree_reset_attribute', { octreeDir, attr })),
    // Build a new octree from the points of `srcDir` that pass the given
    // attribute ranges, writing it to `outDir`. Reuses the converter's
    // LOD build so the result is a first-class dataset in the project.
    octreeSubset: (args: {
      srcDir: string;
      outDir: string;
      name: string;
      scannerType: string;
      filter: {
        xRange?: [number, number];
        yRange?: [number, number];
        zRange?: [number, number];
        intensityRange?: [number, number];
        treeIdRange?: [number, number];
        classes?: number[];
        extraRanges?: { name: string; min: number; max: number }[];
      };
    }) => ctx.invoke<{ outDir: string; pointCount: number; tileCount: number; durationMs: number }>('octree_subset', args),
    // Concatenate two existing octrees into a fresh one. Used to merge
    // an MLS / TLS cloud with an ALS overlay so canopy-top elevations
    // (which an MLS scan often misses) ride along into a single
    // dataset. The new octree gets one `source` extra column (f32:
    // 0.0 = primary, 1.0 = secondary) so the Display panel can colour
    // by origin. All other extras are dropped; base columns (tree_id /
    // intensity / classification / return / semantic) ride through.
    octreeMergeClouds: (args: {
      srcADir: string;
      srcBDir: string;
      outDir: string;
      name: string;
      scannerType: string;
    }) => ctx.invoke<{ outDir: string; pointCount: number; tileCount: number; durationMs: number }>('octree_merge_clouds', args),
    // Statistical / radius outlier removal — kills cloud noise into a
    // new cleaned dataset (the original is left alone). For SOR the
    // mean-distance threshold is μ + std_mult·σ over the k-NN of every
    // point; for radius, a point survives if it has ≥ min_neighbours
    // neighbours within `radius` metres.
    octreeFilterOutliers: (args: {
      srcDir: string;
      outDir: string;
      name: string;
      scannerType: string;
      method: 'sor' | 'radius';
      k?: number;
      stdMult?: number;
      radius?: number;
      minNeighbours?: number;
    }) => ctx.invoke<{ outDir: string; pointCountIn: number; pointCountOut: number; durationMs: number }>('octree_filter_outliers', args),
    // Voxel downsample — one representative point per `voxel_size`
    // cube, the rest dropped. Use for fast previews / batch passes.
    octreeVoxelDownsample: (args: {
      srcDir: string;
      outDir: string;
      name: string;
      scannerType: string;
      voxelSize: number;
    }) => ctx.invoke<{ outDir: string; pointCountIn: number; pointCountOut: number; durationMs: number }>('octree_voxel_downsample', args),
    // Virtual caliper — click any point on a rendered stem, fit a
    // Kåsa circle in a horizontal slab at the clicked Z, get the
    // diameter + RMSE + 12-sector angular-coverage confidence. The
    // forester's "click any height, get the diameter" tool.
    octreeVirtualCaliper: (
      octreeDir: string,
      clickX: number, clickY: number, clickZ: number,
      slabHalfHeight?: number, searchRadius?: number,
    ) => ctx.invoke<{
      centerX: number; centerY: number; z: number;
      radius: number; rmse: number; coverage: number;
      pointCount: number; rejectedCount: number; slabZMin: number; slabZMax: number;
    }>('octree_virtual_caliper', {
      octreeDir, clickX, clickY, clickZ, slabHalfHeight, searchRadius,
    }),
    // Click-to-measure-tree — one-click forester report. Click any
    // point on a stem and get every per-tree number a field caliper +
    // clinometer would: DBH (1.30 m Kåsa fit), total height, base
    // elevation, crown radius + base, lean angle + bearing, and a
    // centreline walk. Single streaming pass collects all points in a
    // local cylinder, then runs the analytics in-memory.
    octreeClickToMeasureTree: (
      octreeDir: string,
      clickX: number, clickY: number, clickZ: number,
      opts: { cylinderRadius?: number; slabHalfHeight?: number; sliceHeight?: number; dtmCell?: number } = {},
    ) => ctx.invoke<{
      baseZ: number; height: number;
      dbh: number; dbhCoverage: number; dbhRmse: number;
      stemX: number; stemY: number;
      crownRadius: number; crownBase: number;
      leanDeg: number; leanBearingDeg: number;
      pointCount: number;
      centerline: Array<{ hag: number; centerX: number; centerY: number; z: number; radius: number; rmse: number; coverage: number }>;
    }>('octree_click_to_measure_tree', {
      octreeDir, clickX, clickY, clickZ,
      cylinderRadius: opts.cylinderRadius,
      slabHalfHeight: opts.slabHalfHeight,
      sliceHeight: opts.sliceHeight,
      dtmCell: opts.dtmCell,
    }),
    // Stem taper (3DFin-style) — one click on a stem returns the diameter
    // profile section-by-section from stump toward the crown, a
    // truncated-cone stem volume, and a DBH interpolated from the
    // profile. Log bucking to assortments is computed in the panel from
    // the sections. Same streaming + patches-aware read as
    // click-to-measure; needs the DTM (run Terrain first).
    octreeStemTaper: (
      octreeDir: string,
      clickX: number, clickY: number, clickZ: number,
      opts: { cylinderRadius?: number; sectionHeight?: number; slabHalfHeight?: number; stumpHeight?: number; dtmCell?: number } = {},
    ) => ctx.invoke<{
      baseZ: number; height: number; dbh: number; stemVolume: number;
      sections: Array<{ hag: number; z: number; diameter: number; centerX: number; centerY: number; rmse: number; coverage: number; n: number }>;
      pointCount: number;
    }>('octree_stem_taper', {
      octreeDir, clickX, clickY, clickZ,
      cylinderRadius: opts.cylinderRadius,
      sectionHeight: opts.sectionHeight,
      slabHalfHeight: opts.slabHalfHeight,
      stumpHeight: opts.stumpHeight,
      dtmCell: opts.dtmCell,
    }),
    // Build per-tree TreeQSM skeletons for a baseline dataset and
    // persist them as `<baselineDir>/skeletons.bin`. Once built, the
    // transfer command uses the cache (much faster) and the panel
    // can draw the skeleton in the viewport + export it as CSV / PLY.
    octreeBuildSkeletons: (
      baselineDir: string,
      opts: { skeletonSpacing?: number; rCover?: number; minTreePoints?: number; dtmCell?: number; groundThreshold?: number; qsmModels?: number; maxTreePoints?: number; skipAddedCylinders?: boolean; dropFarFragments?: boolean } = {},
    ) => ctx.invoke<{
      treeCount: number;
      pointCount: number;
      skeletonSpacing: number;
      bytesWritten: number;
      trees: Array<{ treeId: number; pointCount: number; bboxMin: [number, number, number]; bboxMax: [number, number, number] }>;
      complete: boolean;
      treesTotal: number;
      treesRemaining: number;
      // The TreeQSM cylinder table beside the cache, once the run
      // has finished the plot — qsm_cylinders.csv, for other software.
      qsmPath: string | null;
    }>('octree_build_skeletons', {
        skipAddedCylinders: opts.skipAddedCylinders,
        dropFarFragments: opts.dropFarFragments,
      baselineDir,
      skeletonSpacing: opts.skeletonSpacing,
      groundThreshold: opts.groundThreshold,
      rCover: opts.rCover,
      minTreePoints: opts.minTreePoints,
      dtmCell: opts.dtmCell,
      qsmModels: opts.qsmModels,
      maxTreePoints: opts.maxTreePoints,
    }),
    // Read the cached `skeletons.bin` for a dataset. Returns null
    // when no cache exists yet; otherwise gives flat xyz + tree_id +
    // branch_order arrays the viewport's overlay renders directly.
    // Header only — twenty-four bytes — so a dropdown can say which
    // datasets already have skeletons without loading millions of
    // points to find out.
    // Ask whatever is running on a progress channel to stop. Safe to
    // call when nothing is running.
    octreeCancel: (stage: string) => ctx.invoke<boolean>('octree_cancel', { stage }),
    // Is a run holding `stage` right now? For a view (re)loaded while
    // one was going — a renderer crash does exactly that — so the run it
    // did not start can still be seen and stopped.
    octreeStageRunning: (stage: string) => ctx.invoke<boolean>('octree_stage_running', { stage }),
    // Native message boxes, as this application's own commands — see
    // src/ui/dialogs.ts for why window.confirm is not used.
    confirmDialog: (message: string, title?: string) => ctx.invoke<boolean>('dialog_confirm', { message, title }),
    messageDialog: (message: string, title?: string) => ctx.invoke<void>('dialog_message', { message, title }),
    // Crash log (src-tauri/src/crash.rs): what the renderer reports about
    // itself — the error boundary and the window error hooks call this —
    // and what WebView2 reported about the renderer, which a page
    // reloaded after its predecessor died asks for.
    logCrash: (message: string, kind = 'error') => ctx.invoke<boolean>('crash_log', { kind, message }),
    crashLogLocation: () => ctx.invoke<string | null>('crash_log_location'),
    rendererLastFailure: () => ctx.invoke<RendererFailure | null>('renderer_last_failure'),
    octreeSkeletonInfo: (octreeDir: string) =>
      ctx.invoke<{
        pointCount: number; treeCount: number; skeletonSpacing: number;
        bytes: number; modifiedAt: number; path: string;
      } | null>('octree_skeleton_info', { octreeDir }),
    // Binary, viewed in place — see skeletonPlanar.ts for the layout and
    // for why this stopped being JSON. Null when there is no cache.
    octreeReadSkeletons: async (octreeDir: string) => {
      const bytes = await ctx.invoke<ArrayBuffer | Uint8Array>('octree_read_skeletons', { octreeDir });
      return decodeSkeletonPlanar(bytes);
    },
    // Drop the cached `skeletons.bin` so a future transfer rebuilds.
    octreeClearSkeletons: (octreeDir: string) =>
      ctx.invoke<boolean>('octree_clear_skeletons', { octreeDir }),
    // Export the skeleton cache as a portable text / PLY / LAS / LAZ
    // file. Picks the right writer per format:
    //   - 'csv' : `x,y,z,tree_id,branch_order,class` (matches the MATLAB
    //             reference's `<plot>_skeletonpoints_<year>.txt`)
    //   - 'ply' : ASCII PLY 1.0 — `intensity` carries tree_id,
    //             red = branch_order × 30 for CloudCompare /
    //             MeshLab thumbnails
    //   - 'las' / 'laz' : LAS 1.4 point format 2 (XYZ + intensity +
    //             RGB) via the `las` crate; intensity = tree_id
    //             low-16, red high-byte = branch_order × 30.
    //             The crate routes through its LAZ-parallel
    //             writer when the path ends with `.laz`.
    octreeExportSkeletons: (
      octreeDir: string, outPath: string,
      format: 'csv' | 'txt' | 'ply' | 'las' | 'laz' = 'csv',
      opts?: { onlyTreeId?: number; perTree?: boolean },
    ) =>
      ctx.invoke<{
        path: string; pointCount: number; bytesWritten: number;
        fileCount: number; treeCount: number;
      }>('octree_export_skeletons', {
        octreeDir, outPath, format,
        onlyTreeId: opts?.onlyTreeId,
        perTree: opts?.perTree,
      }),
    // Tree Skeleton Transfer (Honkanen et al. 2026,
    // doi:10.1016/j.ophoto.2026.100147) — propagate
    // the BASELINE octree's per-point tree_id + semantic (stem/branch)
    // labels onto a TARGET octree at the same plot from a different
    // epoch. Per baseline tree: TreeQSM v2 cylinder model → dense
    // skeleton points along each cylinder → spatial hash NN search
    // for every target point → write tree_id (+12..16) + semantic
    // (+20) back to target/octree.bin in place. Frontend follows up
    // by clearing tree_id + semantic patches, saving, reloading.
    octreeSkeletonTransfer: (
      baselineDir: string,
      targetDir: string,
      opts: { distanceThreshold?: number; skeletonSpacing?: number; groundThreshold?: number; baselineGroundThreshold?: number; rCover?: number; minTreePoints?: number; dtmCell?: number; labelBeyondThreshold?: boolean; qsmModels?: number; maxTreePoints?: number; skipAddedCylinders?: boolean; dropFarFragments?: boolean; baselineHeight?: 'stored' | 'above_ground'; targetHeight?: 'stored' | 'above_ground'; alignment?: { dx: number; dy: number; theta: number; cx: number; cy: number } } = {},
    ) => withDatasetBusy(() => ctx.invoke<{
      baselineTreeCount: number;
      skeletonPointCount: number;
      targetEligibleCount: number;
      transferredCount: number;
      stemCount: number;
      branchCount: number;
      unclassifiedCount: number;
      outsideHullCount: number;
      alignmentApplied: boolean;
    }>('octree_skeleton_transfer', {
      skipAddedCylinders: opts.skipAddedCylinders,
      dropFarFragments: opts.dropFarFragments,
      baselineHeight: opts.baselineHeight,
      targetHeight: opts.targetHeight,
      baselineDir, targetDir,
      distanceThreshold: opts.distanceThreshold,
      skeletonSpacing: opts.skeletonSpacing,
      groundThreshold: opts.groundThreshold,
      baselineGroundThreshold: opts.baselineGroundThreshold,
      rCover: opts.rCover,
      minTreePoints: opts.minTreePoints,
      dtmCell: opts.dtmCell,
      labelBeyondThreshold: opts.labelBeyondThreshold,
      qsmModels: opts.qsmModels,
      maxTreePoints: opts.maxTreePoints,
    })),
    // Stem centerline extraction — runs TreeQSM v2's trunk segmentation
    // (Raumonen 2013 §2.3 cover-graph walk + §2.5 cylinder fitting)
    // and returns per-tree polylines + per-node radii. Skips branch
    // reconstruction so this is roughly a quarter of the full
    // octree_tree_qsm cost. Use `onlyTreeId` to restrict to a single
    // tree (the click-to-measure-tree panel does this).
    // The source's skeletons onto the target's trees — the shift and
    // small rotation that puts each skeleton's stem and top on the
    // target's vertical structures and crowns (src-tauri skelalign.rs).
    // Stored beside the target as skeleton_alignment.json; the transfer
    // and the views take it from the panel.
    octreeSkeletonAlign: (
      baselineDir: string, targetDir: string,
      opts: { dtmCell?: number; searchRadius?: number; allowRotation?: boolean } = {},
    ) => withDatasetBusy(() => ctx.invoke<SkeletonAlignmentRecord>('octree_skeleton_align', { baselineDir, targetDir, ...opts })),
    octreeSkeletonAlignmentRead: (targetDir: string) =>
      ctx.invoke<SkeletonAlignmentRecord | null>('octree_skeleton_alignment_read', { targetDir }),
    octreeSkeletonAlignmentClear: (targetDir: string) =>
      ctx.invoke<boolean>('octree_skeleton_alignment_clear', { targetDir }),
    // Move a dataset's georeference by (dx, dy) m without rewriting a
    // point — the offset the points are quantised against moves, and
    // the bounds and tiles with it. Lossless, undone by the opposite
    // shift; recorded under metadata.georeferenceShifts.
    octreeShiftGeoreference: (octreeDir: string, dx: number, dy: number, note?: string) =>
      withDatasetBusy(() => ctx.invoke<{ dx: number; dy: number; offset: [number, number, number]; total: [number, number] }>('octree_shift_georeference', { octreeDir, dx, dy, note })),
    octreeStemCenterlines: (
      octreeDir: string,
      opts: { rCover?: number; onlyTreeId?: number; minTreePoints?: number; dtmCell?: number } = {},
    ) => ctx.invoke<{
      trees: Array<{
        treeId: number;
        nodes: Array<{ x: number; y: number; z: number; radius: number }>;
        length: number;
        leanDeg: number;
      }>;
    }>('octree_stem_centerlines', {
      octreeDir,
      rCover: opts.rCover,
      onlyTreeId: opts.onlyTreeId,
      minTreePoints: opts.minTreePoints,
      dtmCell: opts.dtmCell,
    }),
    // Scan inspection — depth-buffer Hidden Point Removal + spherical
    // panorama from a chosen viewpoint. One streaming pass over the
    // octree produces BOTH the per-bin closest range (for HPR) and
    // the RGBA panorama image (color by range / intensity / class /
    // tree_id / semantic). Frontend renders the panorama via canvas
    // and feeds the depth map into the viewport's HPR filter.
    octreeScanInspection: (
      octreeDir: string,
      viewpointX: number, viewpointY: number, viewpointZ: number,
      opts: { azBins?: number; elBins?: number; colorMode?: string } = {},
    ) => ctx.invoke<{
      azBins: number; elBins: number;
      viewpoint: number[];
      depth: number[];
      rgba: number[];
      pointCount: number;
      rangeMin: number; rangeMax: number;
      colorMin: number; colorMax: number;
    }>('octree_scan_inspection', {
      octreeDir, viewpointX, viewpointY, viewpointZ,
      azBins: opts.azBins, elBins: opts.elBins, colorMode: opts.colorMode,
    }),
    // Forestry density metrics (lidR / FORTLS equivalent): twelve
    // grid rasters (mean / sd / cv / skew / kurt / P25 / P50 / P75 /
    // P90 / P95 / density / canopy cover) of height-above-ground +
    // a plot-wide summary. Reads the cached DTM, so terrain must be
    // computed first.
    octreeDensityMetrics: (octreeDir: string, cellSize: number, opts: {
      minHeight?: number;
      canopyThreshold?: number;
      epsg?: number;
    } = {}) =>
      ctx.invoke<DensityMetricsResult>('octree_density_metrics', {
        octreeDir, cellSize,
        minHeight: opts.minHeight,
        canopyThreshold: opts.canopyThreshold,
        epsg: opts.epsg,
      }),
    // Add a `height_above_ground` extra column computed from the class-2
    // DTM (hag = Z − ground). Z geometry is untouched. Errors if the
    // column already exists. Returns the count + observed hag range.
    octreeNormalize: (octreeDir: string, cellSize: number) =>
      withDatasetBusy(() => ctx.invoke<{
        count: number; min: number; max: number;
        /** Points with no ground beneath them: their height above ground
         *  is NaN, not a number, and they are excluded from count/min/max. */
        withoutGround: number;
      }>('octree_normalize', { octreeDir, cellSize })),
    // Remove a numeric extra column by name (rewrites octree.bin narrower).
    octreeRemoveExtra: (octreeDir: string, name: string) =>
      withDatasetBusy(() => ctx.invoke<number>('octree_remove_extra', { octreeDir, name })),
    // Append the two reserved deadwood id channels (standing + laying) to
    // an existing dataset imported without them. No-op if already present;
    // 8 bytes/point wider after the rewrite. Used by the Deadwood panel's
    // "Enable deadwood labelling" affordance.
    octreeAddDeadwoodColumns: (octreeDir: string) =>
      withDatasetBusy(() => ctx.invoke<number>('octree_add_deadwood_columns', { octreeDir })),
    // Backfill metadata.intensityRange for a dataset imported before it
    // was recorded automatically. Streams octree.bin once (O(points) —
    // the Display panel only calls this from an explicit "Compute
    // intensity range" button, never automatically), persists the
    // observed [min, max] into metadata.json, and returns it so the
    // panel can recolour without a second round trip.
    octreeIntensityRange: (octreeDir: string) =>
      withDatasetBusy(() => ctx.invoke<[number, number]>('octree_intensity_range', { octreeDir })),
    // Record (or clear, passing "null") the dataset's coordinate
    // reference system into metadata.json's `crs` key. Pure bookkeeping
    // — never touches octree.bin / patches.bin / tree ids. Callers
    // should follow with reloadActiveOctree() so octree.meta.crs picks
    // up the change (same pattern octreeIntensityRange's caller uses).
    octreeSetCrs: (octreeDir: string, crsJson: string) =>
      ctx.invoke<void>('octree_set_crs', { octreeDir, crsJson }),

    // Record (or clear, passing "null") the dataset's vertical datum —
    // whether Z is ellipsoidal (GNSS) or orthometric (a national height
    // system) height — into metadata.json's `vertical` key. Same
    // bookkeeping-only contract as octreeSetCrs just above: never
    // touches octree.bin, and callers should follow with
    // reloadActiveOctree() so octree.meta.vertical picks up the change.
    // See commands/octree.rs's "Vertical datum" section for why PointCloudLabeler
    // refuses to guess this instead of just picking ellipsoidal.
    octreeSetVerticalCrs: (octreeDir: string, verticalJson: string) =>
      ctx.invoke<void>('octree_set_vertical_crs', { octreeDir, verticalJson }),

    // ----- Coordinate Reference System support (part 1 of 2) -----
    //
    // crs_list is the curated EPSG table (src-tauri/src/commands/crs.rs)
    // — the CRS picker reads it instead of hardcoding a second copy.
    // crs_transform converts a batch of points between two CRSs, each
    // given as "epsg:XXXX" (looked up in that table) or a raw proj4
    // string. Points are [x, y, z]: (easting, northing, height) for a
    // projected CRS, (longitude, latitude, height) in DEGREES for a
    // geographic one — the Rust side handles the radian conversion
    // proj4rs needs internally, so callers never touch radians here.
    crsList: () => ctx.invoke<CrsListEntry[]>('crs_list'),
    crsTransform: (points: Array<[number, number, number]>, from: string, to: string) =>
      ctx.invoke<Array<[number, number, number]>>('crs_transform', { points, from, to }),
    // crs_lookup / crs_search extend the curated shortlist above to the
    // FULL ~8000-entry EPSG registry (commands/crs.rs's embedded
    // epsg.tsv) — the Export dialog's "search by code or name" box.
    // crs_lookup resolves one exact code (or rejects an unknown one);
    // crs_search does a case-insensitive name-fragment match, plus an
    // exact-code match when the query is numeric.
    crsLookup: (code: number) => ctx.invoke<EpsgLookupEntry>('crs_lookup', { code }),
    crsSearch: (query: string, limit: number) => ctx.invoke<EpsgLookupEntry[]>('crs_search', { query, limit }),

    // ----- Geodetic data (NTv2 datum-shift grids) -----
    //
    // See src-tauri/src/commands/nadgrid.rs's module doc for the full
    // picture: some curated + registry CRS entries need a `.gsb` grid
    // PointCloudLabeler cannot ship, and this points it at a user-supplied folder
    // of them. nadgrid_status never throws; nadgrid_set_dir rejects (a
    // string) a path that is not a directory. '' clears the folder.
    nadgridStatus: () => ctx.invoke<NadGridStatus>('nadgrid_status'),
    nadgridSetDir: (dir: string) => ctx.invoke<NadGridStatus>('nadgrid_set_dir', { dir }),

    // ----- Geoid undulation grids (.gtx) -----
    //
    // See src-tauri/src/commands/geoid.rs's module doc — nadgrid.rs's
    // sibling for the vertical axis: same shared geodetic data folder,
    // same status-report shape (no restartRequired here — geoid.rs's
    // cache is keyed by resolved path, so a changed folder is just a
    // different cache key, never a stale one; see GeoidStatus's own doc
    // comment). geoid_status never throws. geoid_undulation resolves
    // `model` (a file name, e.g. "egm96_15.gtx") against that folder and
    // interpolates the undulation N at (lat, lon) in degrees — the
    // building block a future height-conversion export step calls per
    // point; it does not itself change anything on disk.
    geoidStatus: () => ctx.invoke<GeoidStatus>('geoid_status'),
    geoidUndulation: (model: string, lat: number, lon: number) =>
      ctx.invoke<number>('geoid_undulation', { model, lat, lon }),

    // Per-tree point QC — the reflectance / outlier / wind filter
    // ported from pc_preprocess_aapo_V2.m. Writes a `point_quality`
    // extra column (1 kept, 2 reflectance, 3 outlier, 4 wind, 0 not
    // evaluated) and returns the per-tree and per-decile diagnostics
    // the MATLAB prints.
    octreePointQc: (octreeDir: string, params: Record<string, unknown>) =>
      ctx.invoke<unknown>('octree_point_qc', { octreeDir, params }),

    // ----- Riegl preprocessing -----
    //
    // The Preprocessing module's Riegl panel uses these. Only project.rsp
    // (XML metadata) is read on the Rust side today — points stay where
    // they live on disk. Point-bytes export needs RIEGL's rdblib (free
    // but not redistributable); riegl_export_region returns a clear
    // error in the meantime instead of writing a half-baked LAS.
    rieglListProjects: (projectFolder: string) =>
      ctx.invoke<unknown>('riegl_list_projects', { projectFolder }),
    rieglImportProject: (args: { projectFolder: string; sourcePath: string; name: string }) =>
      ctx.invoke<{ id: string }>('riegl_import_project', args),
    rieglRemoveProject: (args: { projectFolder: string; rieglId: string }) =>
      ctx.invoke<void>('riegl_remove_project', args),
    // What this build can read. Not a manifest field: the same project
    // folder is exportable from a build made with `--features rivlib`
    // (RIEGL's RiVLib, for .rxp — not distributable) and not from the
    // one that ships, so the UI has to ask the binary it is talking to.
    rieglCapabilities: () => ctx.invoke<{ rdbx: boolean; rxp: boolean }>('riegl_capabilities'),
    rieglExportRegion: (args: {
      projectFolder: string; rieglId: string; scanPositionIds: string[];
      bbox: { xMin: number | null; xMax: number | null; yMin: number | null; yMax: number | null; zMin: number | null; zMax: number | null };
      outPath: string;
    }) => ctx.invoke<{ outPath: string; pointCount: number }>('riegl_export_region', args),

    // ----- E57 preprocessing -----
    //
    // ASTM E2807. Unlike Riegl, this is pure-Rust end-to-end (no SDK
    // needed) — one importer covers FARO Focus / Orbis, Leica BLK360 /
    // RTC360 / Cyclone, Trimble X7 / X9, NavVis VLX, Emesent Hovermap,
    // XGRIDS Lixel, GreenValley LiDAR360 via their export paths. The
    // export step ACTUALLY writes a LAS / LAZ; the Editor module
    // imports the result as an octree like any other cloud.
    e57ListProjects: (projectFolder: string) =>
      ctx.invoke<unknown>('e57_list_projects', { projectFolder }),
    e57ImportProject: (args: { projectFolder: string; sourcePath: string; name: string }) =>
      ctx.invoke<{ id: string }>('e57_import_project', args),
    e57RemoveProject: (args: { projectFolder: string; e57Id: string }) =>
      ctx.invoke<void>('e57_remove_project', args),
    e57ExportRegion: (args: {
      projectFolder: string; e57Id: string; scanPositionIds: string[];
      bbox: { xMin: number | null; xMax: number | null; yMin: number | null; yMax: number | null; zMin: number | null; zMax: number | null };
      outPath: string;
    }) => ctx.invoke<{ outPath: string; pointCount: number }>('e57_export_region', args),

    // ----- PTX / PTS preprocessing -----
    //
    // Leica Cyclone ASCII format (PTX = with 4×4 transform per scan,
    // PTS = single dump of points). Pure-Rust parser; covers Cyclone,
    // Topcon MAGNET Collage, 3D Forest interop, Stonex round-trip.
    ptxListProjects: (projectFolder: string) =>
      ctx.invoke<unknown>('ptx_list_projects', { projectFolder }),
    ptxImportProject: (args: { projectFolder: string; sourcePath: string; name: string }) =>
      ctx.invoke<{ id: string }>('ptx_import_project', args),
    ptxRemoveProject: (args: { projectFolder: string; ptxId: string }) =>
      ctx.invoke<void>('ptx_remove_project', args),
    ptxExportRegion: (args: {
      projectFolder: string; ptxId: string; scanPositionIds: string[];
      bbox: { xMin: number | null; xMax: number | null; yMin: number | null; yMax: number | null; zMin: number | null; zMax: number | null };
      outPath: string;
    }) => ctx.invoke<{ outPath: string; pointCount: number }>('ptx_export_region', args),

    // ----- Generic ASCII (XYZ / CSV / TXT) preprocessing -----
    //
    // Safety net for one-off datasets. Sniffs delimiter + header,
    // lets the user map columns to roles (X / Y / Z / intensity /
    // R / G / B / classification), converts to LAS / LAZ.
    xyzListProjects: (projectFolder: string) =>
      ctx.invoke<unknown>('xyz_list_projects', { projectFolder }),
    xyzImportProject: (args: { projectFolder: string; sourcePath: string; name: string }) =>
      ctx.invoke<{ id: string }>('xyz_import_project', args),
    xyzSetMapping: (args: { projectFolder: string; xyzId: string; mapping: {
      x: number; y: number; z: number;
      intensity: number | null; r: number | null; g: number | null; b: number | null;
      classification: number | null;
    } }) => ctx.invoke<unknown>('xyz_set_mapping', args),
    xyzRemoveProject: (args: { projectFolder: string; xyzId: string }) =>
      ctx.invoke<void>('xyz_remove_project', args),
    xyzExport: (args: {
      projectFolder: string; xyzId: string;
      bbox: { xMin: number | null; xMax: number | null; yMin: number | null; yMax: number | null; zMin: number | null; zMax: number | null };
      outPath: string;
    }) => ctx.invoke<{ outPath: string; pointCount: number }>('xyz_export', args),

    // ----- Co-registration -----
    //
    // Operates on the manifests written by the other importers; no
    // editor / octree code is touched. The "list" call walks every
    // importer's preprocessing folder and returns a flat scan list.
    // The "solve" call runs Kabsch on tie points (pure math, no I/O).
    // The "apply" call rewrites one scan's pose in its manifest.
    coregisterListScans: (projectFolder: string) =>
      ctx.invoke<unknown>('coregister_list_scans', { projectFolder }),
    coregisterSolve: (ties: { source: [number, number, number]; target: [number, number, number] }[]) =>
      ctx.invoke<{ pose: number[]; rmse: number; residuals: number[] }>('coregister_solve', { ties }),
    coregisterApply: (args: {
      projectFolder: string;
      importer: 'riegl' | 'e57' | 'ptx';
      projectId: string;
      scanId: string;
      pose: number[];
    }) => ctx.invoke<void>('coregister_apply', args),
    /** Apply a world→world CORRECTION, composed onto the scan's existing
     *  pose. Tie points are in world coordinates, so a Kabsch solve over
     *  them returns a correction and not an absolute pose — writing it
     *  straight in replaced the scan's real pose with it, which for an
     *  already-good alignment (R ≈ I) silently replaced a genuine pose
     *  with the identity after reporting a perfect RMSE. ICP and MSA
     *  return absolute poses and use `coregisterApply` above; the two
     *  meanings have separate commands so they cannot be confused. */
    coregisterApplyDelta: (args: {
      projectFolder: string;
      importer: 'riegl' | 'e57' | 'ptx';
      projectId: string;
      scanId: string;
      delta: number[];
    }) => ctx.invoke<void>('coregister_apply_delta', args),
    // ICP fine-refinement: reads sub-sampled points from both scans
    // (E57 / PTX; Riegl needs rdblib first), iterates closest-point +
    // Kabsch until convergence. Returns the refined source pose + the
    // per-iteration RMSE curve.
    coregisterIcp: (args: {
      projectFolder: string;
      source: { importer: string; projectId: string; scanId: string };
      target: { importer: string; projectId: string; scanId: string };
      params: {
        maxIters: number; maxCorrDist: number; samplePoints: number;
        method?: 'pointToPoint' | 'pointToPlane';
        normalK?: number;
      };
    }) => ctx.invoke<{
      pose: number[]; rmse: number; rmseHistory: number[];
      correspondences: number; sourcePoints: number; targetPoints: number; converged: boolean;
    }>('coregister_icp', args),
    // Plane patch extraction (region-growing voxel-PCA; same primitive
    // RiSCAN PRO's plane-patch extractor produces for its MSA).
    coregisterExtractPlanes: (args: {
      projectFolder: string;
      scan: { importer: string; projectId: string; scanId: string };
      params: {
        voxelSize: number; planarityMax: number; minVoxelPoints: number;
        normalAngleTolDeg: number; minPatchPoints: number;
      };
    }) => ctx.invoke<Array<{
      centroid: number[]; normal: number[]; rmse: number;
      extent: number; areaEstimate: number; planarity: number; nPoints: number;
    }>>('coregister_extract_planes', args),
    // Retroreflective sphere target auto-detection (algebraic seed +
    // Gauss–Newton on the geometric distance, then validation). RIEGL
    // VZ/VUX users use 7.5 cm / 14.5 cm spheres as registration tie
    // points.
    coregisterDetectSpheres: (args: {
      projectFolder: string;
      scan: { importer: string; projectId: string; scanId: string };
      params: {
        rMin: number; rMax: number; rmseRelMax: number;
        minClusterPoints: number; voxelSize: number;
      };
    }) => ctx.invoke<Array<{
      center: number[]; radius: number; rmse: number; nPoints: number;
    }>>('coregister_detect_spheres', args),
    // Sphere-RANSAC pairwise matching across two scans. Pushes the
    // matched centres into the tie-point list so the existing
    // Kabsch + ICP refine pipeline picks them up.
    coregisterMatchSpheres: (args: {
      source: Array<{ center: number[]; radius: number; rmse: number; nPoints: number }>;
      target: Array<{ center: number[]; radius: number; rmse: number; nPoints: number }>;
      params: { radiusTol: number; inlierTol: number; iterations: number };
    }) => ctx.invoke<{
      pairs: Array<{
        sourceIdx: number; targetIdx: number;
        sourceCenter: number[]; targetCenter: number[]; radiusMean: number;
      }>;
      pose: number[]; rmse: number; candidates: number; iterations: number;
    }>('coregister_match_spheres', args),
    // Pairwise plane-patch matching (RANSAC + Procrustes on three
    // plane-normal triples + linear 3×3 solve for translation).
    // Each matched pair generates `samplesPerPair` point
    // correspondences ready to feed into coregister_msa.
    coregisterMatchPlanes: (args: {
      source: Array<{
        centroid: number[]; normal: number[]; rmse: number;
        extent: number; areaEstimate: number; planarity: number; nPoints: number;
      }>;
      target: Array<{
        centroid: number[]; normal: number[]; rmse: number;
        extent: number; areaEstimate: number; planarity: number; nPoints: number;
      }>;
      params: {
        maxPlanarity: number; minExtent: number;
        normalAngleTolDeg: number; centroidDistTol: number;
        iterations: number; samplesPerPair: number;
      };
    }) => ctx.invoke<{
      pairs: Array<{
        sourceIdx: number; targetIdx: number;
        normalDot: number; centroidDistance: number;
      }>;
      pose: number[]; rmse: number;
      correspondences: Array<{
        i: number; j: number; pILocal: number[]; pJLocal: number[];
      }>;
      candidates: number; iterations: number;
    }>('coregister_match_planes', args),
    // Multi-Station Adjustment — global pose-graph optimisation
    // over N scans simultaneously (Levenberg-Marquardt on the
    // 6(N−1)-DoF state). Replaces "chained pairwise solves" with one
    // globally consistent adjustment.
    coregisterMsa: (args: {
      poses: number[][];
      correspondences: Array<{
        i: number; j: number;
        pILocal: number[]; pJLocal: number[];
      }>;
      params: { maxIters: number; lambdaInit: number; rmseEps: number };
    }) => ctx.invoke<{
      poses: number[][]; rmseHistory: number[];
      converged: boolean; finalRmse: number; correspondences: number;
    }>('coregister_msa', args),
    // Auto-segment individual tree crowns from the CHM (treetop local
    // maxima + marker-controlled watershed) and write tree_id back into
    // octree.bin. Needs ground classified first. Returns tree count +
    // points assigned.
    octreeSegmentChm: (octreeDir: string, params: {
      cellSize: number; smooth: number; minHeight: number;
      crownBaseRadius: number; crownRadiusPerM: number; crownMaxRadius: number;
    }) => withDatasetBusy(() => ctx.invoke<{ treeCount: number; assignedPoints: number }>('octree_segment_chm', { octreeDir, ...params })),
    // Individual-tree isolation (treeiso — Xi & Hopkinson 2022): bottom-up
    // cut-pursuit cascade over a voxel-decimated working set → tree_id.
    // Far better than the CHM watershed on dense interlocking TLS/MLS
    // crowns. Overwrites tree_id. Needs ground classified.
    octreeTreeIsolation: (octreeDir: string, p: {
      voxelSize: number; k1: number; lambda1: number; k2: number; lambda2: number;
      decimate2: number; maxGap: number; k3: number; rho: number;
      verticalWeight: number; minTreePts: number;
    }) => withDatasetBusy(() => {
      // The ten algorithm knobs go over as one `params` object rather than
      // ten siblings of `octreeDir`: treeiso has two λ, three k and two
      // decimation resolutions, and a transposed pair would be silently
      // accepted on both sides of the bridge.
      const { voxelSize, ...params } = p;
      return ctx.invoke<{ treeCount: number; assignedPoints: number }>(
        'octree_tree_isolation', { octreeDir, voxelSize, params });
    }),
    // Li et al. 2012 — the third tree detector. Point-cloud, top-down, no
    // canopy raster, so a suppressed stem with no local maximum can still
    // be found. Writes tree_id like the other two.
    octreeSegmentLi2012: (octreeDir: string, p: {
      voxelSize: number; dtmCell: number;
      dt1: number; dt2: number; zu: number; searchWindow: number;
      minHeight: number; minTreePts: number;
    }) => withDatasetBusy(() => {
      // The algorithm's own knobs go over as one `params` object, like
      // treeiso's: dt1 and dt2 differ by half a metre and mean opposite
      // ends of the canopy, and swapping them is not a type error on
      // either side of the bridge.
      const { voxelSize, dtmCell, ...params } = p;
      return ctx.invoke<{ treeCount: number; assignedPoints: number }>(
        'octree_segment_li2012', { octreeDir, voxelSize, dtmCell, params });
    }),
    // M3C2 (Lague et al. 2013) multi-temporal change detection: signed
    // distance from a reference-epoch octree to the active (compared) octree
    // along local surface normals, per decimated core point, with a 95%
    // level of detection. Non-destructive analysis — nothing is written back.
    octreeM3C2: (octreeDir: string, referenceDir: string, params: {
      voxelSize: number; normalScale: number; projectionScale: number; maxDepth: number; regError: number;
      coreSpacing?: number;
    }) => ctx.invoke<{
      coreCount: number; definedCount: number; significantCount: number;
      meanDistance: number; medianDistance: number; stdDistance: number;
      xyz: number[]; distance: number[]; significant: number[]; stopped: boolean;
    }>('octree_m3c2', { octreeDir, referenceDir, ...params }),
    // Auto-detect laying (fallen) deadwood logs: near-ground PCA (linear +
    // horizontal-axis points) + DBSCAN clustering, written into the
    // laying_deadwood column as a seed for manual editing. Overwrites that
    // column. Needs ground classified (the height band is over the DTM).
    octreeSegmentDeadwood: (octreeDir: string, params: {
      cellSize: number; hagMin: number; hagMax: number; neighborRadius: number;
      minLinearity: number; maxAxisVerticality: number; clusterEps: number;
      minClusterPoints: number; minLogLength: number;
    }) => withDatasetBusy(() => ctx.invoke<{ logCount: number; assignedPoints: number }>('octree_segment_deadwood', { octreeDir, ...params })),
    // Geometric leaf–wood separation (LeWoS / TLSeparation family): per-point
    // PCA eigenfeatures — linear (branch) or planar (trunk) vs scattered
    // (foliage) — plus majority-vote smoothing, written to the semantic byte
    // (1 = wood, 2 = leaf, 0 = ground). Overwrites semantic. Ground classified
    // first is recommended so ground surfaces aren't called wood.
    octreeLeafWood: (octreeDir: string, params: {
      searchRadius: number; minNeighbors: number; linearityMin: number;
      planarityMin: number; scatterMax: number; smoothPasses: number;
    }) => withDatasetBusy(() => ctx.invoke<{ woodPoints: number; leafPoints: number }>('octree_leaf_wood', { octreeDir, ...params })),
    // Per-tree forestry metrics (height, DBH, basal area, crown area/dia,
    // centroid). One native streaming pass; needs ground classified.
    octreeTreeMetrics: (octreeDir: string, params: {
      crownCell: number; bhLow: number; bhHigh: number; dtmCell: number;
    }) => ctx.invoke<TreeMetric[]>('octree_tree_metrics', { octreeDir, ...params }),
    // RANSAC stem fit per tree: refines DBH from a cylinder through the
    // stem band and (optionally) labels inlier points semantic=1 (stem).
    octreeFitStems: (octreeDir: string, params: {
      bandLow: number; bandHigh: number; inlierTol: number; iterations: number;
      minInliers: number; writeSemantic: boolean; dtmCell: number;
    }) => ctx.invoke<StemFit[]>('octree_fit_stems', { octreeDir, ...params }),
    /** The persisted stem fits, or null when the fit has never been run
     *  on this dataset. Written by octreeFitStems next to the dataset,
     *  the way the QSM is — so every panel can use the refined diameter
     *  rather than only the one that happened to run the fit. */
    octreeReadStems: (octreeDir: string) =>
      ctx.invoke<StemFit[] | null>('octree_read_stems', { octreeDir }),
    // Length + mtime of every file the per-tree metrics are computed
    // from. `metrics/loadMetrics` keys its cache on this, so a merge, a
    // re-segmentation, a stem fit or a file swapped underneath the app
    // all retire the cached rows without anything having to remember to
    // say so. Five stats — cheap enough to ask on every request.
    octreeDatasetFingerprint: (octreeDir: string) =>
      ctx.invoke<string>('octree_dataset_fingerprint', { octreeDir }),
    // Stem QSM (Quantitative Structure Model) — per-tree taper as a
    // cylinder stack, integrated to a stem volume. Each slice carries an
    // occlusion-aware coverage (12 sectors of 30°) so the per-tree
    // confidence figure reflects how completely the stem was seen.
    octreeTreeQsm: (octreeDir: string, params: {
      sliceHeight: number; minPointsPerSlice: number;
      minTreeHeight: number; dtmCell: number;
      /** Enable PCA cylinder fitting for branches. Without it the
       *  per-tree `branches` array stays empty and `totalVolume`
       *  equals `stemVolume`. */
      enableBranches?: boolean;
      /** Branch fitting algorithm:
       *    'simple'  — one PCA cylinder per voxel connected
       *                component (v1, no hierarchy)
       *    'treeqsm' — Raumonen 2013 with overlapping balls →
       *                segment hierarchy + chain of cylinders per
       *                segment + parent-child + branch order. */
      branchMethod?: 'simple' | 'treeqsm';
      /** Voxel cell size for branch clustering (m). For 'treeqsm'
       *  the cover ball radius is 2 × this. Default 0.10 for simple,
       *  recommended 0.02 for treeqsm. */
      branchVoxel?: number;
    }) => ctx.invoke<QsmResult>('octree_tree_qsm', { octreeDir, ...params }),
    octreeReadQsm: (octreeDir: string) =>
      ctx.invoke<QsmResult | null>('octree_read_qsm', { octreeDir }),
    // Compute DTM / DSM / CHM rasters → ESRI ASCII grids under
    // <octreeDir>/terrain/. Returns georef + value ranges + paths.
    octreeTerrain: (octreeDir: string, cellSize: number, opts: {
      /** DSM construction: 'p2r' (point-to-raster, per-cell max — the
       *  default) or 'pit_free' (multi-layer surface max + 3×3 close).
       *  Pit-free yields cleaner CHMs in canopy gaps but costs an extra
       *  streaming pass over octree.bin. */
      dsmMethod?: 'p2r' | 'pit_free';
      /** Pit-free height layers (m above ground). Omit / empty for the
       *  default ladder [2, 5, 10, 15, 20, 25, 30]. */
      dsmLayers?: number[];
      /** Optional EPSG embedded in the GeoTIFF CRS keys. */
      epsg?: number;
      /** Latitude (degrees) for HLI. Default 60° (central Finland). */
      hliLatitudeDeg?: number;
      /** Stream-network threshold as a fraction of cells (0..1). The
       *  default 0.01 keeps the top 1 % of cells by accumulation. */
      streamFraction?: number;
      /** Sun altitude (degrees, 0..90) for hillshade. Default 45°. */
      hillshadeAltitudeDeg?: number;
      /** Sun azimuth (compass deg, 0..360) for the single-direction
       *  hillshade. Default 315° (NW). */
      hillshadeAzimuthDeg?: number;
    } = {}) =>
      ctx.invoke<TerrainResult>('octree_terrain', {
        octreeDir, cellSize,
        dsmMethod: opts.dsmMethod,
        dsmLayers: opts.dsmLayers,
        epsg: opts.epsg,
        hliLatitudeDeg: opts.hliLatitudeDeg,
        streamFraction: opts.streamFraction,
        hillshadeAltitudeDeg: opts.hillshadeAltitudeDeg,
        hillshadeAzimuthDeg: opts.hillshadeAzimuthDeg,
      }),

    // Project lifecycle
    projectCurrent: () => ctx.invoke('project_current'),
    projectCreate: (opts: unknown) => ctx.invoke('project_create', { opts }),
    projectOpen: (folder: string) => ctx.invoke('project_open', { folder }),
    projectClose: () => ctx.invoke<boolean>('project_close'),
    projectSaveMeta: (patch: unknown) => ctx.invoke('project_save_meta', { patch }),
    projectRecent: () => ctx.invoke('project_recent'),
    projectRemoveRecent: (folder: string) =>
      ctx.invoke<string[]>('project_remove_recent', { folder }),
    projectBrowseForFolder: (mode: 'new' | 'open') =>
      ctx.invoke<string | null>('dialog_pick_folder', {
        title: mode === 'open' ? 'Open Project' : 'Choose parent folder for new project',
      }),

    // Menu actions — under Tauri the only thing the renderer subscribes to is
    // project:changed. Native menus will be added in a later iteration.
    onMenuAction: (cb: ProjectChangedHandler) => {
      menuHandlers.add(cb);
      return () => { menuHandlers.delete(cb); };
    },
  };

  (window as unknown as Record<string, unknown>).desktop = api;
}

/**
 * Install the desktop bridge before React mounts. Idempotent.
 * Returns true when a Tauri bridge is now available on window.desktop.
 */
export async function setupDesktopBridge(): Promise<boolean> {
  if (!isTauri()) return false;
  const ctx = await loadTauri();
  if (!ctx) return false;
  installShim(ctx);
  return true;
}
