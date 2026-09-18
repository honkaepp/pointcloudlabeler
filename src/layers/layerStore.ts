// Reading and writing analysis layers through the desktop bridge.
//
// The pure half — the format — is analysisLayers.ts. This is the half
// that touches files: it asks the backend for the folder listing, the
// two paths of a layer and a deletion, and moves the header and the
// payload through the ordinary file bridge. Every function takes the
// bridge as a parameter so the round trip can be exercised in node with
// a fake in place of the desktop.

import {
  type AnalysisLayer, type LayerHeader, type LayerPayload,
  decodePayload, encodePayload, layerFromHeader, makeHeader, parseHeader,
} from './analysisLayers';

/** The slice of the desktop bridge this needs. */
export interface LayerBridge {
  octreeLayersList?: (octreeDir: string) => Promise<{ id: string; header: string; payloadBytes: number }[]>;
  octreeLayerPrepare?: (octreeDir: string, id: string) => Promise<{ jsonPath: string; binPath: string }>;
  octreeLayerDelete?: (octreeDir: string, id: string) => Promise<unknown>;
  writeFile?: (path: string, content: string) => Promise<unknown>;
  writeFileBytes?: (path: string, bytes: Uint8Array) => Promise<unknown>;
  readFile?: (path: string) => Promise<ArrayBuffer>;
}

/** Can this bridge save and read layers at all? False on the web build
 *  and on a desktop older than the commands. */
export function canPersistLayers(d: LayerBridge | undefined): d is Required<LayerBridge> {
  return !!d?.octreeLayersList && !!d.octreeLayerPrepare && !!d.octreeLayerDelete
    && !!d.writeFile && !!d.writeFileBytes && !!d.readFile;
}

/** The saved layers of a dataset, unloaded and hidden. A header that
 *  does not parse, or whose payload is missing or the wrong size, is
 *  left out with a console note rather than failing the whole list:
 *  one damaged layer must not hide the others. */
export async function listSavedLayers(d: LayerBridge, octreeDir: string): Promise<{ layers: AnalysisLayer[]; headers: Map<string, LayerHeader> }> {
  const headers = new Map<string, LayerHeader>();
  const layers: AnalysisLayer[] = [];
  if (!d.octreeLayersList) return { layers, headers };
  const entries = await d.octreeLayersList(octreeDir);
  for (const e of entries) {
    try {
      const h = parseHeader(e.header);
      if (h.id !== e.id) throw new Error(`header id ${h.id} does not match the file name ${e.id}`);
      if (h.payloadBytes !== e.payloadBytes) throw new Error(`payload is ${e.payloadBytes} bytes, the header says ${h.payloadBytes}`);
      headers.set(h.id, h);
      layers.push(layerFromHeader(h));
    } catch (err) {
      console.warn(`layer ${e.id} skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { layers, headers };
}

/** Read a saved layer's payload. */
export async function loadLayerPayload(d: LayerBridge, octreeDir: string, header: LayerHeader): Promise<LayerPayload> {
  if (!d.octreeLayerPrepare || !d.readFile) throw new Error('this build cannot read saved layers');
  const paths = await d.octreeLayerPrepare(octreeDir, header.id);
  const bytes = await d.readFile(paths.binPath);
  return decodePayload(header, bytes);
}

/** Write a layer's two files. Returns the header written, so the caller
 *  can keep it for a later read. */
export async function saveLayerFiles(d: LayerBridge, octreeDir: string, layer: AnalysisLayer): Promise<LayerHeader> {
  if (!layer.payload) throw new Error('nothing to save — the layer has no payload in memory');
  if (!d.octreeLayerPrepare || !d.writeFile || !d.writeFileBytes) throw new Error('this build cannot save layers');
  const { bytes, meta } = encodePayload(layer.payload);
  const header = makeHeader(layer, bytes.byteLength, meta);
  const paths = await d.octreeLayerPrepare(octreeDir, layer.id);
  // The payload first, the header last: a header without its payload
  // is what the listing refuses, so a write cut short leaves no
  // half-layer that looks whole.
  await d.writeFileBytes(paths.binPath, bytes);
  await d.writeFile(paths.jsonPath, JSON.stringify(header, null, 2));
  return header;
}

export async function deleteLayerFiles(d: LayerBridge, octreeDir: string, id: string): Promise<void> {
  if (!d.octreeLayerDelete) throw new Error('this build cannot delete layers');
  await d.octreeLayerDelete(octreeDir, id);
}
