import { describe, it, expect } from 'vitest';
import {
  encodePayload, decodePayload, makeHeader, parseHeader, layerFromHeader, deriveOverlays, upsertLayer,
  newLayerId, isSafeLayerId, layerFiles, describePayload, LAYER_FORMAT, LAYER_VERSION,
  type AnalysisLayer, type LayerPayload,
} from './analysisLayers';
import { listSavedLayers, saveLayerFiles, loadLayerPayload, deleteLayerFiles, canPersistLayers, type LayerBridge } from './layerStore';

const layer = (id: string, payload: LayerPayload | null, extra: Partial<AnalysisLayer> = {}): AnalysisLayer => ({
  id, kind: payload?.kind ?? 'm3c2', label: id, source: 'test', createdAt: '2026-09-17T10:00:00.000Z',
  visible: true, saved: false, payload, savable: true, ...extra,
});

/** A tool's output as something the user owns: listed, hidden, saved
 *  with the dataset and back after a restart — byte for byte. */
describe('analysis layers', () => {
  it('round-trips an M3C2 change map through the header and the bytes', () => {
    const p: LayerPayload = { kind: 'm3c2', overlay: {
      xyz: new Float32Array([1, 2, 3, 4, 5, 6]), distance: new Float32Array([0.05, NaN]),
      significant: new Uint8Array([1, 0]), maxAbs: 0.25,
    } };
    const l = layer('m3c2-x', p);
    const { bytes, meta } = encodePayload(p);
    expect(bytes.byteLength).toBe(2 * 17);   // 12 xyz + 4 distance + 1 flag per point
    const h = makeHeader(l, bytes.byteLength, meta);
    const back = decodePayload(parseHeader(JSON.stringify(h)), bytes);
    expect(back.kind).toBe('m3c2');
    if (back.kind !== 'm3c2') return;
    expect(Array.from(back.overlay.xyz)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(back.overlay.distance[0]).toBeCloseTo(0.05, 6);
    expect(Number.isNaN(back.overlay.distance[1])).toBe(true);
    expect(Array.from(back.overlay.significant)).toEqual([1, 0]);
    expect(back.overlay.maxAbs).toBe(0.25);
  });

  it('keeps centreline nodes in float64 — survey coordinates do not survive float32', () => {
    const x = 6796395.71, y = 512345.123, z = 141.4271;
    const p: LayerPayload = { kind: 'centerlines', overlay: { trees: [
      { treeId: 7, nodes: [{ x, y, z, radius: 0.1234 }, { x: x + 0.01, y, z: z + 0.5, radius: 0.12 }] },
      { treeId: 9, nodes: [] },
    ] } };
    const { bytes, meta } = encodePayload(p);
    expect(bytes.byteLength).toBe(2 * 32);
    const back = decodePayload(makeHeader(layer('c', p), bytes.byteLength, meta), bytes);
    if (back.kind !== 'centerlines') throw new Error('kind');
    expect(back.overlay.trees.length).toBe(2);
    expect(back.overlay.trees[0].nodes[0].x).toBe(x);
    expect(back.overlay.trees[0].nodes[1].x).toBe(x + 0.01);
    expect(back.overlay.trees[0].nodes[0].radius).toBe(0.1234);
    expect(back.overlay.trees[1].nodes).toEqual([]);
    // A float32 would have lost the centimetre.
    expect(Math.fround(x + 0.01) - Math.fround(x)).not.toBeCloseTo(0.01, 3);
  });

  it('round-trips a raster with its grid and its row settings', () => {
    const p: LayerPayload = { kind: 'raster', raster: {
      rasterKind: 'dtm', label: 'DTM 0.5 m', opacity: 0.7, wireframe: true,
      grid: { cols: 3, rows: 2, cellSize: 0.5, minX: 100, minY: 200, vmin: 1, vmax: 6, values: new Float32Array([1, 2, 3, 4, 5, 6]) },
    } };
    const { bytes, meta } = encodePayload(p);
    const back = decodePayload(makeHeader(layer('r', p), bytes.byteLength, meta), bytes);
    if (back.kind !== 'raster') throw new Error('kind');
    expect(back.raster).toEqual({ ...p.raster, grid: { ...p.raster.grid, values: expect.any(Float32Array) } });
    expect(Array.from(back.raster.grid.values)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('refuses a truncated payload, a newer version and a foreign file', () => {
    const p: LayerPayload = { kind: 'm3c2', overlay: { xyz: new Float32Array(3), distance: new Float32Array(1), significant: new Uint8Array(1), maxAbs: 1 } };
    const { bytes, meta } = encodePayload(p);
    const h = makeHeader(layer('m', p), bytes.byteLength, meta);
    expect(() => decodePayload(h, bytes.subarray(0, 12))).toThrow(/truncated/);
    expect(() => parseHeader(JSON.stringify({ ...h, version: LAYER_VERSION + 1 }))).toThrow(/newer/);
    expect(() => parseHeader(JSON.stringify({ ...h, format: 'something' }))).toThrow(/not a PointCloudLabeler layer/);
    expect(() => parseHeader(JSON.stringify({ ...h, id: '../metadata' }))).toThrow(/id/);
    // Skeletons are the transfer panel's file, never a layer file.
    expect(() => encodePayload({ kind: 'skeleton', overlay: {} as never })).toThrow(/skeletons\.bin/);
    expect(h.format).toBe(LAYER_FORMAT);
  });

  it('draws one M3C2 map, one skeleton set, and every visible centreline together', () => {
    const cl = (id: string, treeId: number, visible: boolean) => layer(id, { kind: 'centerlines', overlay: { trees: [{ treeId, nodes: [{ x: 0, y: 0, z: 0, radius: 0.1 }] }] } }, { visible });
    const m = (id: string, maxAbs: number, visible: boolean) => layer(id, { kind: 'm3c2', overlay: { xyz: new Float32Array(0), distance: new Float32Array(0), significant: new Uint8Array(0), maxAbs } }, { visible });
    const d = deriveOverlays([cl('a', 1, true), cl('b', 2, false), cl('c', 3, true), m('m1', 1, true), m('m2', 2, true), layer('unloaded', null, { kind: 'centerlines', saved: true })]);
    expect(d.stemCenterlines?.trees.map((t) => t.treeId)).toEqual([1, 3]);
    expect(d.m3c2Overlay?.maxAbs).toBe(2);   // the most recently added visible one
    expect(d.skeletonOverlay).toBeNull();
    expect(deriveOverlays([]).stemCenterlines).toBeNull();
  });

  it('upserts by id, names files under layers/, and makes ids a file name is happy with', () => {
    const a = layer('a', null); const b = layer('b', null);
    expect(upsertLayer([a], b).map((l) => l.id)).toEqual(['a', 'b']);
    expect(upsertLayer([a, b], { ...a, label: 'A2' })[0].label).toBe('A2');
    expect(layerFiles('m3c2-1')).toEqual({ json: 'layers/m3c2-1.json', bin: 'layers/m3c2-1.bin' });
    const id = newLayerId('centerlines', new Date('2026-09-17T10:15:00.123Z'));
    expect(id).toBe('centerlines-20260917-101500');
    expect(isSafeLayerId(id)).toBe(true);
    for (const bad of ['../x', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(200)]) expect(isSafeLayerId(bad), bad).toBe(false);
    expect(describePayload(layer('s', null, { saved: true }))).toMatch(/saved/);
  });

  it('saves and reads back through the bridge, payload before header, and lists what is there', async () => {
    const files = new Map<string, Uint8Array | string>();
    const dir = 'C:/proj/octrees/tls';
    const fake: LayerBridge = {
      octreeLayersList: async () => {
        const out: { id: string; header: string; payloadBytes: number }[] = [];
        for (const [path, v] of files) {
          if (path.endsWith('.json') && typeof v === 'string') {
            const id = path.slice(path.lastIndexOf('/') + 1, -5);
            const bin = files.get(`${dir}/layers/${id}.bin`);
            out.push({ id, header: v, payloadBytes: bin && typeof bin !== 'string' ? bin.byteLength : 0 });
          }
        }
        return out;
      },
      octreeLayerPrepare: async (d, id) => ({ jsonPath: `${d}/layers/${id}.json`, binPath: `${d}/layers/${id}.bin` }),
      octreeLayerDelete: async (d, id) => { files.delete(`${d}/layers/${id}.json`); files.delete(`${d}/layers/${id}.bin`); },
      writeFile: async (p, c) => { files.set(p, c); },
      writeFileBytes: async (p, b) => { files.set(p, b.slice()); },
      readFile: async (p) => { const v = files.get(p); if (!(v instanceof Uint8Array)) throw new Error('no file'); return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer; },
    };
    expect(canPersistLayers(fake)).toBe(true);
    expect(canPersistLayers({})).toBe(false);
    const l = layer('centerlines-1', { kind: 'centerlines', overlay: { trees: [{ treeId: 4, nodes: [{ x: 1, y: 2, z: 3, radius: 0.2 }] }] } });
    await saveLayerFiles(fake, dir, l);
    expect(files.has(`${dir}/layers/centerlines-1.json`)).toBe(true);
    expect(files.has(`${dir}/layers/centerlines-1.bin`)).toBe(true);
    // A header whose payload is missing is left out, not listed as a layer.
    files.set(`${dir}/layers/broken.json`, JSON.stringify({ format: LAYER_FORMAT, version: 1, id: 'broken', kind: 'm3c2', payloadBytes: 13, meta: { count: 1 } }));
    const { layers, headers } = await listSavedLayers(fake, dir);
    expect(layers.map((x) => x.id)).toEqual(['centerlines-1']);
    expect(layers[0]).toMatchObject({ visible: false, saved: true, payload: null, kind: 'centerlines' });
    const back = await loadLayerPayload(fake, dir, headers.get('centerlines-1')!);
    expect(back).toEqual(l.payload);
    await deleteLayerFiles(fake, dir, 'centerlines-1');
    expect((await listSavedLayers(fake, dir)).layers).toEqual([]);
  });
});
