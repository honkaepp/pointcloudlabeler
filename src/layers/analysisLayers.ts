// Analysis layers — what a tool draws over the cloud, as something the
// user owns.
//
// Every analysis that puts something on the viewport — the M3C2 change
// map, the stem centrelines, a taper profile, the click-to-measure
// handles, a terrain raster — used to live only in the panel that made
// it: hidden from there, cleared from there, and gone the moment the
// dataset was switched or the application closed. Nothing listed them
// together, and nothing kept them.
//
// This is the one list. Each entry is a layer: a kind, a label, what it
// came from, whether it is on screen, whether it is saved with the
// dataset, and — when loaded — its payload. The Layers panel shows the
// list with an eye, a Save and a remove on every row; the panels add to
// it and refer to their rows by id. A saved layer is two files under
// `<dataset>/layers/`: `<id>.json`, the header below, and `<id>.bin`,
// the payload encoded by this module — and it comes back, hidden, when
// the dataset is opened again.
//
// The payloads are typed arrays, not JSON numbers: an M3C2 map has
// hundreds of thousands of core points, and the centreline nodes are
// survey coordinates that a float32 would round by half a metre, so
// they are written as float64. Everything here is pure and runs in
// node, which is where its tests run.

import type { M3C2Overlay, StemCenterlineOverlay, SkeletonOverlay } from '../components/shell/OctreeShellContext';
import type { RasterLayer, RasterGrid } from '../persistence/octreeReader';

export const LAYER_FORMAT = 'pointcloudlabeler-layer';
export const LAYER_VERSION = 1;

/** The kinds a layer can be. `skeleton` is listed and toggled like the
 *  others but kept by the Tree Skeleton Transfer panel as
 *  `skeletons.bin`, so it is never written by this module. */
export type LayerKind = 'm3c2' | 'centerlines' | 'raster' | 'skeleton';

export type LayerPayload =
  | { kind: 'm3c2'; overlay: M3C2Overlay }
  | { kind: 'centerlines'; overlay: StemCenterlineOverlay }
  | { kind: 'raster'; raster: SavedRaster }
  | { kind: 'skeleton'; overlay: SkeletonOverlay };

/** A raster as it is saved — the grid plus what the Layers row shows. */
export interface SavedRaster {
  rasterKind: RasterLayer['kind'];
  label: string;
  grid: RasterGrid;
  opacity: number;
  wireframe: boolean;
}

export interface AnalysisLayer {
  /** File stem under `layers/`; also the key panels refer to. */
  id: string;
  kind: LayerKind;
  label: string;
  /** Which tool made it, and with what — the row's hint. */
  source: string;
  createdAt: string;
  visible: boolean;
  /** Both files exist under `<dataset>/layers/`. */
  saved: boolean;
  /** Null for a saved layer that has not been read yet — it is read the
   *  first time it is shown. */
  payload: LayerPayload | null;
  /** Rows the Layers panel can offer to save: everything this module
   *  encodes. A skeleton layer is the transfer panel's file. */
  savable: boolean;
}

/** The `<id>.json` beside the payload. `meta` is whatever the kind's
 *  encoder needs to read the bytes back. */
export interface LayerHeader {
  format: typeof LAYER_FORMAT;
  version: number;
  id: string;
  kind: LayerKind;
  label: string;
  source: string;
  createdAt: string;
  payloadBytes: number;
  meta: Record<string, unknown>;
}

/** The files a layer is saved as, relative to the dataset directory.
 *  Forward slashes: the bridge's writer accepts them on every platform
 *  and the dataset directory itself is spelled by the backend. */
export function layerFiles(id: string): { json: string; bin: string } {
  return { json: `layers/${id}.json`, bin: `layers/${id}.bin` };
}

/** A safe, sortable, unique id: the kind, then the time. Only the
 *  characters a file name is happy with. */
export function newLayerId(kind: LayerKind, now: Date = new Date()): string {
  const t = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  return `${kind}-${t}`;
}

/** Is this an id this module made, or at least one that cannot escape
 *  the layers folder? Mirrors the backend's check. */
export function isSafeLayerId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(id) && !id.includes('..');
}

// ---------------------------------------------------------------------
// Encoding.
// ---------------------------------------------------------------------

function concat(parts: ArrayBufferView[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o);
    o += p.byteLength;
  }
  return out;
}

/** The bytes and the header meta for a payload. Throws for a skeleton:
 *  that file is the transfer panel's. */
export function encodePayload(p: LayerPayload): { bytes: Uint8Array; meta: Record<string, unknown> } {
  switch (p.kind) {
    case 'm3c2': {
      const o = p.overlay;
      const n = o.distance.length;
      if (o.xyz.length !== n * 3 || o.significant.length !== n) throw new Error('M3C2 overlay arrays disagree on the point count');
      return {
        bytes: concat([o.xyz, o.distance, o.significant]),
        meta: { count: n, maxAbs: o.maxAbs },
      };
    }
    case 'centerlines': {
      const trees = p.overlay.trees;
      const total = trees.reduce((n, t) => n + t.nodes.length, 0);
      const f = new Float64Array(total * 4);
      let i = 0;
      for (const t of trees) {
        for (const nd of t.nodes) { f[i++] = nd.x; f[i++] = nd.y; f[i++] = nd.z; f[i++] = nd.radius; }
      }
      return {
        bytes: concat([f]),
        meta: { trees: trees.map((t) => ({ treeId: t.treeId, nodes: t.nodes.length })) },
      };
    }
    case 'raster': {
      const r = p.raster;
      const g = r.grid;
      if (g.values.length !== g.cols * g.rows) throw new Error('raster values do not fill the grid');
      return {
        bytes: concat([g.values]),
        meta: {
          rasterKind: r.rasterKind, label: r.label, opacity: r.opacity, wireframe: r.wireframe,
          cols: g.cols, rows: g.rows, cellSize: g.cellSize, minX: g.minX, minY: g.minY, vmin: g.vmin, vmax: g.vmax,
        },
      };
    }
    case 'skeleton':
      throw new Error('skeletons are kept by the Tree Skeleton Transfer panel as skeletons.bin, not as a layer file');
  }
}

/** The payload back from a header and its bytes. Refuses a header from
 *  a newer build or one whose byte count does not fit its meta — a
 *  truncated file must not come back as a shorter, plausible layer. */
export function decodePayload(h: LayerHeader, bytes: ArrayBuffer | Uint8Array): LayerPayload {
  if (h.format !== LAYER_FORMAT) throw new Error('not a PointCloudLabeler layer file');
  if (typeof h.version !== 'number' || h.version > LAYER_VERSION) throw new Error(`layer file version ${String(h.version)} is newer than this build understands`);
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.byteLength !== h.payloadBytes) throw new Error(`layer payload is ${u8.byteLength} bytes, the header says ${h.payloadBytes} — the file is truncated or not this layer's`);
  // A view aligned for typed arrays: copy when the source is not.
  const aligned = (u8.byteOffset % 8 === 0) ? u8 : new Uint8Array(u8);
  const buf = aligned.buffer as ArrayBuffer;
  const base = aligned.byteOffset;
  const m = h.meta;
  switch (h.kind) {
    case 'm3c2': {
      const n = Number(m.count);
      // 12 bytes of xyz, 4 of distance, 1 of significance per point.
      if (!Number.isInteger(n) || n < 0 || n * 17 !== u8.byteLength) throw new Error('M3C2 layer: byte count does not match the point count');
      return {
        kind: 'm3c2',
        overlay: {
          xyz: new Float32Array(buf, base, n * 3).slice(),
          distance: new Float32Array(buf, base + n * 12, n).slice(),
          significant: new Uint8Array(buf, base + n * 16, n).slice(),
          maxAbs: Number(m.maxAbs) || 0,
        },
      };
    }
    case 'centerlines': {
      const trees = (m.trees as Array<{ treeId: number; nodes: number }>) ?? [];
      const total = trees.reduce((n, t) => n + t.nodes, 0);
      if (total * 32 !== u8.byteLength) throw new Error('centreline layer: byte count does not match the node count');
      const f = new Float64Array(buf, base, total * 4);
      let i = 0;
      return {
        kind: 'centerlines',
        overlay: {
          trees: trees.map((t) => ({
            treeId: t.treeId,
            nodes: Array.from({ length: t.nodes }, () => {
              const nd = { x: f[i], y: f[i + 1], z: f[i + 2], radius: f[i + 3] };
              i += 4;
              return nd;
            }),
          })),
        },
      };
    }
    case 'raster': {
      const cols = Number(m.cols), rows = Number(m.rows);
      if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols * rows * 4 !== u8.byteLength) throw new Error('raster layer: byte count does not match the grid');
      return {
        kind: 'raster',
        raster: {
          rasterKind: String(m.rasterKind) as RasterLayer['kind'],
          label: String(m.label ?? h.label),
          opacity: typeof m.opacity === 'number' ? m.opacity : 1,
          wireframe: m.wireframe === true,
          grid: {
            cols, rows,
            cellSize: Number(m.cellSize), minX: Number(m.minX), minY: Number(m.minY),
            vmin: Number(m.vmin), vmax: Number(m.vmax),
            values: new Float32Array(buf, base, cols * rows).slice(),
          },
        },
      };
    }
    case 'skeleton':
      throw new Error('a skeleton layer is not read from a layer file');
  }
}

/** The header for a layer about to be saved. */
export function makeHeader(layer: AnalysisLayer, payloadBytes: number, meta: Record<string, unknown>): LayerHeader {
  return {
    format: LAYER_FORMAT, version: LAYER_VERSION,
    id: layer.id, kind: layer.kind, label: layer.label, source: layer.source, createdAt: layer.createdAt,
    payloadBytes, meta,
  };
}

/** Parse a header, refusing anything that is not one. */
export function parseHeader(text: string): LayerHeader {
  const v = JSON.parse(text) as Partial<LayerHeader>;
  if (v.format !== LAYER_FORMAT) throw new Error('not a PointCloudLabeler layer file');
  if (typeof v.version !== 'number' || v.version > LAYER_VERSION) throw new Error(`layer file version ${String(v.version)} is newer than this build understands`);
  if (typeof v.id !== 'string' || !isSafeLayerId(v.id)) throw new Error('layer file has no usable id');
  if (v.kind !== 'm3c2' && v.kind !== 'centerlines' && v.kind !== 'raster') throw new Error(`layer kind ${String(v.kind)} is not one this build reads`);
  return {
    format: LAYER_FORMAT, version: v.version, id: v.id, kind: v.kind,
    label: typeof v.label === 'string' ? v.label : v.id,
    source: typeof v.source === 'string' ? v.source : '',
    createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
    payloadBytes: typeof v.payloadBytes === 'number' ? v.payloadBytes : -1,
    meta: v.meta && typeof v.meta === 'object' ? v.meta as Record<string, unknown> : {},
  };
}

/** A saved layer as it appears in the list before its payload is read:
 *  hidden, saved, unloaded. */
export function layerFromHeader(h: LayerHeader): AnalysisLayer {
  return {
    id: h.id, kind: h.kind, label: h.label, source: h.source, createdAt: h.createdAt,
    visible: false, saved: true, payload: null, savable: h.kind !== 'skeleton',
  };
}

// ---------------------------------------------------------------------
// What the viewport draws, from the list.
// ---------------------------------------------------------------------

/** The overlays the viewport takes, derived from the visible, loaded
 *  layers. One M3C2 map and one skeleton set at a time — the most
 *  recently added visible one — and every visible centreline layer
 *  merged into one polyline set, because a taper profile and the plot's
 *  centrelines are the same kind of thing and belong on screen
 *  together. */
export function deriveOverlays(layers: readonly AnalysisLayer[]): {
  m3c2Overlay: M3C2Overlay | null;
  stemCenterlines: StemCenterlineOverlay | null;
  skeletonOverlay: SkeletonOverlay | null;
} {
  let m3c2Overlay: M3C2Overlay | null = null;
  let skeletonOverlay: SkeletonOverlay | null = null;
  const trees: StemCenterlineOverlay['trees'] = [];
  for (const l of layers) {
    if (!l.visible || !l.payload) continue;
    switch (l.payload.kind) {
      case 'm3c2': m3c2Overlay = l.payload.overlay; break;
      case 'skeleton': skeletonOverlay = l.payload.overlay; break;
      case 'centerlines': trees.push(...l.payload.overlay.trees); break;
      case 'raster': break; // rasters have their own list
    }
  }
  return { m3c2Overlay, skeletonOverlay, stemCenterlines: trees.length > 0 ? { trees } : null };
}

/** Insert or replace by id, newest last. */
export function upsertLayer(layers: readonly AnalysisLayer[], layer: AnalysisLayer): AnalysisLayer[] {
  const i = layers.findIndex((l) => l.id === layer.id);
  if (i < 0) return [...layers, layer];
  const next = layers.slice();
  next[i] = layer;
  return next;
}

/** A one-line description for a row's hint. */
export function describePayload(l: AnalysisLayer): string {
  const p = l.payload;
  if (!p) return l.saved ? 'saved — shown on request' : '';
  switch (p.kind) {
    case 'm3c2': return `${p.overlay.distance.length.toLocaleString()} core points`;
    case 'centerlines': {
      const n = p.overlay.trees.reduce((a, t) => a + t.nodes.length, 0);
      return `${p.overlay.trees.length} tree${p.overlay.trees.length === 1 ? '' : 's'} · ${n} nodes`;
    }
    case 'raster': return `${p.raster.grid.cols}×${p.raster.grid.rows} raster`;
    case 'skeleton': return `${p.overlay.treeId.length.toLocaleString()} skeleton points`;
  }
}
