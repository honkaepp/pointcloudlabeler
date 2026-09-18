import { LazPerf } from 'laz-perf';
// Tell Vite to bundle the .wasm file and give us its resolved URL.
// This works in both `tauri dev` (loaded via the dev server) and bundled
// production builds (where the webview loads from the app's asset URL).
import lazPerfWasmUrl from 'laz-perf/lib/web/laz-perf.wasm?url';
import type { ParsedCloud, FileLike } from './parseTxtStream';
import { writeScenePosition } from './sceneAxes';
import type { ExtraColumn } from './parser/streamParser';

// Standard point-record length per LAS point format (bytes before any
// extra bytes). Used to locate the extra-bytes region inside each record.
const LAS_STD_POINT_LEN: Record<number, number> = {
  0: 20, 1: 28, 2: 26, 3: 34, 4: 57, 5: 63, 6: 30, 7: 36, 8: 38, 9: 59, 10: 67,
};

interface ExtraDim {
  name: string;
  dataType: number;
  /** Byte width of this dim's value. */
  size: number;
  /** Byte offset of this dim within the per-point extra-bytes region. */
  offset: number;
}

/** Byte width of an LAS Extra Bytes data_type (spec 1.4 table). 0 = the
 *  undocumented / array types we don't decode. */
function extraDimSize(dataType: number): number {
  // LAS Extra Bytes data types per the ASPRS spec. 0 = undocumented
  // (size lives in the descriptor's "options" byte, not the type). 1–10
  // are the scalar types we can decode. 11–30 were 2-element / 3-element
  // vector variants in LAS 1.0–1.3 (deprecated in 1.4 R15 but still seen
  // in older files); we don't decode them but we DO need their sizes so
  // a vector descriptor in the middle of a VLR doesn't break the offset
  // of every later descriptor — that was making files with mixed types
  // surface only the first dim.
  switch (dataType) {
    case 1: case 2: return 1;             // u8 / i8
    case 3: case 4: return 2;             // u16 / i16
    case 5: case 6: case 9: return 4;     // u32 / i32 / f32
    case 7: case 8: case 10: return 8;    // u64 / i64 / f64
    case 11: case 12: return 2;           // 2 × u8/i8
    case 13: case 14: return 4;           // 2 × u16/i16
    case 15: case 16: case 19: return 8;  // 2 × u32/i32/f32
    case 17: case 18: case 20: return 16; // 2 × u64/i64/f64
    case 21: case 22: return 3;           // 3 × u8/i8
    case 23: case 24: return 6;           // 3 × u16/i16
    case 25: case 26: case 29: return 12; // 3 × u32/i32/f32
    case 27: case 28: case 30: return 24; // 3 × u64/i64/f64
    default: return 0;                    // 0 = undocumented, >30 = unknown
  }
}

/** True for scalar types we can actually read into a number. The picker
 *  surfaces vector / undocumented dims by name too, but they're not
 *  importable as tree_id / semantic on either the in-memory or the
 *  octree path — flagged via the extraDimSize sentinel (0 = unknown). */

/** Parse the Extra Bytes VLR(s) (user_id 'LASF_Spec', record_id 4) from a
 *  raw LAS buffer, returning the named extra dimensions in file order with
 *  their byte offsets within each point's extra-bytes region. Defensive:
 *  returns [] if the buffer is too short or a descriptor uses an
 *  unsupported data type (so the caller falls back to no extra dims). */
function readExtraDims(dv: DataView, all: Uint8Array): ExtraDim[] {
  if (all.length < 96) return [];
  const headerSize = dv.getUint16(94, true);
  const numVLRs = dv.getUint32(100, true);
  const dec = new TextDecoder('ascii');
  const clean = (s: string) => s.replace(/\0.*$/s, '').trim();
  let p = headerSize;
  const dims: ExtraDim[] = [];
  // The cumulative EB byte offset must run ACROSS every LASF_Spec/4 VLR —
  // the Extra-Bytes region is one contiguous block per point, and some
  // writers split the descriptors over several VLRs. A per-VLR reset gave
  // every column in a 2nd+ VLR offset 0 (so they aliased the first
  // column's bytes), so cum lives outside the VLR loop. Matches the Rust
  // converter's parse_extra_dims.
  let cum = 0;
  let stop = false;
  for (let v = 0; v < numVLRs && !stop; v++) {
    if (p + 54 > all.length) break;
    const userId = clean(dec.decode(all.subarray(p + 2, p + 18)));
    const recordId = dv.getUint16(p + 18, true);
    const recLen = dv.getUint16(p + 20, true);
    const payload = p + 54;
    if (userId === 'LASF_Spec' && recordId === 4 && payload + recLen <= all.length) {
      const nDesc = Math.floor(recLen / 192);
      for (let d = 0; d < nDesc; d++) {
        const base = payload + d * 192;
        const dataType = dv.getUint8(base + 2);
        const name = clean(dec.decode(all.subarray(base + 4, base + 36))).toLowerCase();
        const sz = extraDimSize(dataType);
        // Always record the dim — surface its name to the user even if
        // we can't decode the value, so a Semantic column stored as e.g.
        // a vector type still appears in the import picker. If we hit a
        // truly unknown (size 0) type, stop walking ALL later descriptors
        // because the cumulative offset is no longer trustworthy; the
        // dims we've already recorded stay valid.
        dims.push({ name: name || `extra_${d}`, dataType, size: sz, offset: cum });
        if (sz === 0) { stop = true; break; }
        cum += sz;
      }
    }
    p = payload + recLen;
  }
  return dims;
}

function makeExtraArr(dataType: number, count: number): ExtraColumn {
  switch (dataType) {
    case 1: return new Uint8Array(count);
    case 2: return new Int8Array(count);
    case 3: return new Uint16Array(count);
    case 4: return new Int16Array(count);
    case 5: return new Uint32Array(count);
    case 6: return new Int32Array(count);
    case 9: return new Float32Array(count);
    default: return new Float64Array(count); // 7 / 8 / 10
  }
}

function readExtraVal(dvPt: DataView, pos: number, dataType: number): number {
  switch (dataType) {
    case 1: return dvPt.getUint8(pos);
    case 2: return dvPt.getInt8(pos);
    case 3: return dvPt.getUint16(pos, true);
    case 4: return dvPt.getInt16(pos, true);
    case 5: return dvPt.getUint32(pos, true);
    case 6: return dvPt.getInt32(pos, true);
    case 9: return dvPt.getFloat32(pos, true);
    case 10: return dvPt.getFloat64(pos, true);
    case 7: return Number(dvPt.getBigUint64(pos, true));
    case 8: return Number(dvPt.getBigInt64(pos, true));
    default: return 0;
  }
}

/** Light header+VLR read to list the column names an LAS/LAZ file
 *  actually exposes — i.e. the Extra-Bytes dimensions declared in its
 *  VLR. The standard LAS fields (x, y, z, intensity, classification,
 *  return number) are NOT synthesised into this list: those aren't
 *  user-mappable columns in the octree route — the converter reads them
 *  straight from the file's geometry — and listing them as if they were
 *  columns produced phantom dropdown choices (e.g. a "tree_id" entry
 *  that doesn't physically exist in the file). The Import dialog only
 *  ever needs the real Extra-Bytes names: a label column is only usable
 *  if the converter can find it under that exact name.
 *  Returns the file's Extra-Bytes dimension names, in declared order. */
export async function detectLasColumns(file: File | FileLike): Promise<string[]> {
  return (await detectLasSource(file)).extraNames;
}

/** What a LAS source carries, for the import dialog to disclose what
 *  will and will not survive.
 *
 *  `pointFormat` is the point data record format (header byte 104). It
 *  decides which standard fields the file HAS — colour lives in formats
 *  2/3/5/7/8/10, GPS time in 1/3/4/5/6-10, NIR in 8/10 — and PointCloudLabeler's
 *  octree carries none of them. That loss used to be covered only by
 *  omission in a note listing what IS read, which is not the same as
 *  telling someone their colourised MLS delivery will arrive grey.
 *
 *  `null` when the header could not be read; the dialog then says
 *  nothing rather than guessing at the file's contents. */
export interface LasSourceInfo {
  extraNames: string[];
  pointFormat: number | null;
}

export async function detectLasSource(file: File | FileLike): Promise<LasSourceInfo> {
  const names: string[] = [];
  let pointFormat: number | null = null;
  try {
    const head0 = await file.slice(0, Math.min(file.size, 65536)).arrayBuffer();
    const dv0 = new DataView(head0);
    // not 'L' → not LASF: report nothing rather than a guessed format.
    if (dv0.getUint8(0) !== 0x4C) return { extraNames: names, pointFormat: null };
    const pdo = dv0.getUint32(96, true);
    const need = Math.min(file.size, Math.max(pdo, 65536));
    const buf = need <= head0.byteLength ? head0 : await file.slice(0, need).arrayBuffer();
    const dv = new DataView(buf);
    // Bit 6 of the format byte is the LASzip "compressed" flag, not part
    // of the format number — masking it off is what makes this work for
    // a .laz as well as a .las.
    pointFormat = dv0.getUint8(104) & 0x3f;
    const dims = readExtraDims(dv, new Uint8Array(buf));
    for (const d of dims) names.push(d.name);
  } catch { /* malformed / non-LAS — report nothing rather than guess */ }
  return { extraNames: names, pointFormat };
}

/** Standard LAS fields present in `pointFormat` that PointCloudLabeler's octree does
 *  not carry, named as a user would recognise them. Empty when the
 *  format has none, or when the header could not be read. */
export function unsupportedLasFields(pointFormat: number | null): string[] {
  if (pointFormat === null) return [];
  const out: string[] = [];
  if ([2, 3, 5, 7, 8, 10].includes(pointFormat)) out.push('colour (RGB)');
  if ([8, 10].includes(pointFormat)) out.push('near-infrared');
  if ([1, 3, 4, 5, 6, 7, 8, 9, 10].includes(pointFormat)) out.push('GPS time');
  if ([4, 5, 9, 10].includes(pointFormat)) out.push('waveform data');
  // Every format has these; they are simply not stored.
  out.push('scan angle', 'user data', 'point source ID');
  return out;
}

// Single-shot LAS/LAZ reader using laz-perf WASM.
// Loads the entire file into WASM memory. Suitable for files up to ~2 GiB compressed
// (LAZ typically expands 5-10x, so this covers tens of millions of points).
//
// Output ParsedCloud:
//   - positions: Float32Array with origin subtracted (same convention as TXT parser)
//   - treeIds: read from extra bytes / classification when possible, else 0
//   - extraCols: intensity, classification, return_number, ... as strings (for export)
//   - origin: first point's world coords (so positions fit in Float32 precision)

export async function parseLasStream(
  file: File | FileLike,
  onProgress?: (bytesRead: number, total: number, rows: number) => void,
): Promise<ParsedCloud> {
  // Read everything. For huge files, we'd need streaming chunk decoding via ChunkDecoder.
  if (onProgress) onProgress(0, file.size, 0);
  const totalSize = file.size;
  // Read in 64 MiB chunks so the IPC layer doesn't have to materialize the whole file.
  const READ_CHUNK = 64 * 1024 * 1024;
  let cursor = 0;
  const pieces: Uint8Array[] = [];
  while (cursor < totalSize) {
    const end = Math.min(cursor + READ_CHUNK, totalSize);
    const buf = await file.slice(cursor, end).arrayBuffer();
    pieces.push(new Uint8Array(buf));
    cursor = end;
    if (onProgress) onProgress(cursor, totalSize, 0);
    // Yield to the event loop.
    await new Promise(r => setTimeout(r, 0));
  }
  // Concatenate. For files >2 GiB this allocation will fail.
  if (totalSize > (2 ** 31 - 1)) {
    throw new Error(`File is ${(totalSize / 1e9).toFixed(1)} GB — LAS/LAZ above 2 GB is not yet supported. Convert to .txt or split the file.`);
  }
  const all = new Uint8Array(totalSize);
  let off = 0;
  for (const p of pieces) { all.set(p, off); off += p.length; }
  pieces.length = 0;

  // Initialize laz-perf — point Emscripten at the bundled WASM URL.
  const lp = await LazPerf.create({
    locateFile: (filename: string) => {
      if (filename.endsWith('.wasm')) return lazPerfWasmUrl;
      return filename;
    },
  } as unknown as Parameters<typeof LazPerf.create>[0]);
  const dataPtr = lp._malloc(all.byteLength);
  lp.HEAPU8.set(all, dataPtr);
  const las = new lp.LASZip();
  try {
    las.open(dataPtr, all.byteLength);
    const count = las.getCount();
    const pointLen = las.getPointLength();
    const format = las.getPointFormat();
    // Reading minimal LAS header from the raw buffer to get scale/offset.
    const dv = new DataView(all.buffer, all.byteOffset, all.byteLength);
    // LAS public header structure (1.2/1.4 compatible offsets used here)
    // 'LASF' magic at byte 0..3
    if (dv.getUint8(0) !== 0x4C || dv.getUint8(1) !== 0x41 ||
        dv.getUint8(2) !== 0x53 || dv.getUint8(3) !== 0x46) {
      throw new Error('Not a LAS/LAZ file (missing LASF magic)');
    }
    // X/Y/Z scale factors at offset 131, 139, 147 (LE doubles)
    const xScale = dv.getFloat64(131, true);
    const yScale = dv.getFloat64(139, true);
    const zScale = dv.getFloat64(147, true);
    const xOff = dv.getFloat64(155, true);
    const yOff = dv.getFloat64(163, true);
    const zOff = dv.getFloat64(171, true);

    // Allocate per-point buffer in WASM
    const ptPtr = lp._malloc(pointLen);
    const dvPt = new DataView(lp.HEAPU8.buffer, ptPtr, pointLen);

    // Output buffers. Extras are TypedArrays — 50M points × 4 bytes
    // (intensity Uint16) + 1 byte (classification Uint8) + 1 byte
    // (return Uint8) ≈ 300 MB, vs. ~3 GB if we stored them as JS
    // strings the way the TXT parser does. The extras' typed-array
    // shape is what readExtraCol() + persistence/lasWriter expect.
    const positions = new Float32Array(count * 3);
    const treeIds = new Int32Array(count);
    const intensityArr = new Uint16Array(count);
    const classificationArr = new Uint8Array(count);
    const returnArr = new Uint8Array(count);
    let ox: number | null = null, oy: number | null = null, oz: number | null = null;

    // Extra bytes: format 6 / 7 / 8 / 9 / 10 have GPS time etc. Tree id is unusual in LAS.
    // We use classification (byte) when point format puts it in a known place. For point
    // formats 0..5: byte 15. For 6..10: byte 16 (different layout).
    const classByte = format <= 5 ? 15 : 16;

    // Named extra dimensions (e.g. semantic_pred, label, instance) declared
    // in the Extra Bytes VLR. Read into typed arrays so the import column
    // mapping can route them to tree_id / semantic / classification. Only
    // trusted when the declared widths exactly fill the record's extra
    // region; otherwise we skip them (standard columns still load).
    const stdLen = LAS_STD_POINT_LEN[format] ?? pointLen;
    let extraDims = readExtraDims(dv, all);
    const dimsTotal = extraDims.reduce((s, d) => s + d.size, 0);
    if (dimsTotal === 0 || stdLen + dimsTotal !== pointLen) extraDims = [];
    const extraDimArrs = extraDims.map(d => makeExtraArr(d.dataType, count));

    const reportEvery = Math.max(50_000, Math.floor(count / 200));
    for (let i = 0; i < count; i++) {
      las.getPoint(ptPtr);
      const xi = dvPt.getInt32(0, true);
      const yi = dvPt.getInt32(4, true);
      const zi = dvPt.getInt32(8, true);
      const xw = xi * xScale + xOff;
      const yw = yi * yScale + yOff;
      const zw = zi * zScale + zOff;
      if (ox === null) { ox = xw; oy = yw; oz = zw; }
      // Survey (east, north, up) -> scene (x, y, z). See sceneAxes:
      // the north axis is NEGATED, and dropping that made this a
      // reflection rather than a rotation.
      writeScenePosition(positions, i, xw - ox!, yw - oy!, zw - oz!);

      const intensity = dvPt.getUint16(12, true);
      const classification = dvPt.getUint8(classByte);
      const retByte = dvPt.getUint8(format <= 5 ? 14 : 14);
      const returnNum = retByte & 0x07;

      intensityArr[i] = intensity;
      classificationArr[i] = classification;
      returnArr[i] = returnNum;
      // No standard tree_id in LAS — default 0. User can paint IDs in editor
      // or map an extra dimension to tree_id in the import dialog.
      treeIds[i] = 0;

      for (let d = 0; d < extraDims.length; d++) {
        const dim = extraDims[d];
        (extraDimArrs[d] as { [k: number]: number })[i] =
          readExtraVal(dvPt, stdLen + dim.offset, dim.dataType);
      }

      if (onProgress && (i % reportEvery) === 0) {
        onProgress(totalSize, totalSize, i);
      }
    }
    lp._free(ptPtr);

    if (onProgress) onProgress(totalSize, totalSize, count);

    const baseExtraNames = ['intensity', 'classification', 'return_number'];
    const extraCols: Record<string, ExtraColumn> = {
      intensity: intensityArr,
      classification: classificationArr,
      return_number: returnArr,
    };
    // Append the named extra dimensions, de-duplicating names against the
    // standard columns so a file's own 'classification' EB doesn't clobber
    // the decoded ASPRS class.
    const usedNames = new Set([...baseExtraNames, 'x', 'y', 'z', 'tree_id']);
    const extraDimNames: string[] = [];
    for (let d = 0; d < extraDims.length; d++) {
      let nm = extraDims[d].name;
      while (usedNames.has(nm)) nm = `${nm}_eb`;
      usedNames.add(nm);
      extraDimNames.push(nm);
      extraCols[nm] = extraDimArrs[d];
    }
    const extraNames = [...baseExtraNames, ...extraDimNames];
    const columnOrder = ['x', 'y', 'z', 'tree_id', ...extraNames];

    return {
      positions,
      treeIds,
      extraCols,
      columnOrder,
      columnSep: ' ',
      hadHeader: true,
      origin: { x: ox ?? 0, y: oy ?? 0, z: oz ?? 0 },
      colIdx: {
        ix: 0, iy: 1, iz: 2, iId: 3,
        extraIdx: extraNames.map((_, k) => 4 + k),
        extraNames,
      },
      count,
      // LAS positions are decoded to mm; the canonical TXT export of an LAS
      // round-trip stays at 3 decimals (1 mm). Boost manually if higher
      // precision is needed (rare for LAS workflows).
      coordDecimals: 3,
    };
  } finally {
    try { las.delete(); } catch { /* ignore */ }
    try { lp._free(dataPtr); } catch { /* ignore */ }
  }
}

export function isLasLikeName(name: string): boolean {
  return /\.(las|laz)$/i.test(name);
}
