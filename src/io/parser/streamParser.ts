import { splitCells, type HeaderInfo } from './headerDetect';
import { writeScenePosition } from '../sceneAxes';

/** Either a JS string array (TXT parser path) or a TypedArray
 *  (LAS / binary path that already has the values as numbers). Consumers
 *  read both through readExtraCol() which formats numerics on demand. */
export type ExtraColumn =
  | string[]
  | Uint8Array | Uint16Array | Uint32Array | Int8Array | Int16Array | Int32Array | Float32Array | Float64Array;

export interface ParsedCloudData {
  positions: Float32Array;
  treeIds: Int32Array;
  extraCols: Record<string, ExtraColumn>;
  columnOrder: string[];
  columnSep: string;
  hadHeader: boolean;
  origin: { x: number; y: number; z: number };
  colIdx: {
    ix: number;
    iy: number;
    iz: number;
    iId: number;
    extraIdx: number[];
    extraNames: string[];
  };
  count: number;
  /** Maximum number of decimal places seen in the X/Y/Z tokens of the first
   *  ~100 rows. Used by the TXT export path so the round-trip preserves the
   *  source file's apparent precision instead of always dropping to 3 mm. */
  coordDecimals: number;
}

// Worker-to-main transfer format for extra string columns: bytes + offsets.
// Saves us from cloning hundreds of millions of small JS strings (which busts the
// 4 GiB worker heap during structured clone).
export interface PackedExtraCols {
  names: string[];
  // Per-column packed bytes (concatenated UTF-8 of all values).
  bytes: ArrayBuffer[];
  // Per-column offsets[i] = start index in bytes for value i; offsets[count] = total length.
  offsets: ArrayBuffer[];
}

export interface ParsedCloudPacked {
  positions: Float32Array;
  treeIds: Int32Array;
  packedExtras: PackedExtraCols;
  columnOrder: string[];
  columnSep: string;
  hadHeader: boolean;
  origin: { x: number; y: number; z: number };
  colIdx: {
    ix: number;
    iy: number;
    iz: number;
    iId: number;
    extraIdx: number[];
    extraNames: string[];
  };
  count: number;
  coordDecimals: number;
}

const SEG = 1 << 20;

/** Count decimal digits in a numeric token like "123.4567" → 4. Returns 0
 *  if the token has no fractional part or an exponent terminates it. Used
 *  by the parser to remember the source file's coordinate precision so
 *  fsExportTxt can preserve it on round-trip. */
function decimalDigits(s: string): number {
  const dot = s.indexOf('.');
  if (dot < 0) return 0;
  let end = s.length;
  for (let i = dot + 1; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) { end = i; break; }
  }
  return Math.min(end - dot - 1, 9);
}

export class TxtStreamParser {
  private decoder = new TextDecoder('utf-8');
  private carry = '';
  private posSegs: (Float32Array | null)[] = [new Float32Array(SEG * 3)];
  private idSegs: (Int32Array | null)[] = [new Int32Array(SEG)];
  private extraSegs: Record<string, (string[] | null)[]> = {};
  private segIdx = 0;
  private segWrite = 0;
  private wrote = 0;
  private ox: number | null = null;
  private oy: number | null = null;
  private oz: number | null = null;
  // Decimal-precision sampling (cheap: only sample the first ~100 rows). We
  // histogram the per-row max-of-X/Y/Z and use the MODE as the file's
  // representative precision. Picking the max across rows let one outlier
  // (e.g. a single row with weirdly long decimals) pad every coord on
  // export with trailing zeros, inflating an 84M-row TXT from 3.2 GB to
  // 4.5 GB. The mode is robust to those outliers.
  private decimalsProbed = 0;
  private decimalCounts: Uint32Array = new Uint32Array(10);

  constructor(private hi: HeaderInfo) {
    for (const n of hi.extraNames) this.extraSegs[n] = [new Array(SEG)];
  }

  rows(): number { return this.wrote; }

  processChunk(bytes: Uint8Array, isLast: boolean): void {
    const piece = this.decoder.decode(bytes, { stream: !isLast });
    const text = this.carry + piece;
    const { ix, iy, iz, iId, extraIdx, extraNames, header, sep } = this.hi;
    let lineStart = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13) {
        if (i > lineStart) {
          const line = text.slice(lineStart, i);
          const toks = splitCells(line, sep);
          if (toks.length >= header.length - extraIdx.length) {
            const px = parseFloat(toks[ix]);
            const py = parseFloat(toks[iy]);
            const pz = parseFloat(toks[iz]);
            if (px === px && py === py && pz === pz) {
              if (this.ox === null) { this.ox = px; this.oy = py; this.oz = pz; }
              // Sample decimal precision from the first ~100 rows so we can
              // preserve it on TXT export. After that the probe is a no-op
              // and costs nothing in the hot path.
              if (this.decimalsProbed < 100) {
                const d = Math.max(
                  decimalDigits(toks[ix]),
                  decimalDigits(toks[iy]),
                  decimalDigits(toks[iz]),
                );
                this.decimalCounts[Math.min(d, 9)]++;
                this.decimalsProbed++;
              }
              this.pushRow(
                px - this.ox!, py - this.oy!, pz - this.oz!,
                iId >= 0 ? (parseInt(toks[iId], 10) || 0) : 0,
                toks, extraIdx, extraNames,
              );
            }
          }
        }
        if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
        lineStart = i + 1;
      }
    }
    this.carry = text.slice(lineStart);
    if (isLast && this.carry.length > 0) {
      const line = this.carry;
      const toks = splitCells(line, sep);
      if (toks.length >= header.length - extraIdx.length) {
        const px = parseFloat(toks[ix]);
        const py = parseFloat(toks[iy]);
        const pz = parseFloat(toks[iz]);
        if (px === px && py === py && pz === pz) {
          if (this.ox === null) { this.ox = px; this.oy = py; this.oz = pz; }
          this.pushRow(
            px - this.ox!, py - this.oy!, pz - this.oz!,
            iId >= 0 ? (parseInt(toks[iId], 10) || 0) : 0,
            toks, extraIdx, extraNames,
          );
        }
      }
      this.carry = '';
    }
  }

  /** Most common decimal-digit count seen in the per-row max(X, Y, Z) of the
   *  first ~100 rows. Falls back to 3 (1 mm) when nothing fractional was seen
   *  (integer-coordinate clouds). The mode is more representative of the
   *  source file's actual precision than the max, which is biased by single
   *  outlier rows. */
  decimals(): number {
    let mode = 0, modeCount = 0;
    for (let i = 0; i < this.decimalCounts.length; i++) {
      // Tie-break low: 4 over 5 if both have the same count, to keep the
      // output compact.
      if (this.decimalCounts[i] > modeCount) {
        modeCount = this.decimalCounts[i];
        mode = i;
      }
    }
    return mode > 0 ? mode : 3;
  }

  /** Takes SURVEY axes (east, north, up) relative to the origin and
   *  maps them to scene axes once, here — see sceneAxes. */
  private pushRow(east: number, north: number, up: number, id: number, toks: string[], extraIdx: number[], extraNames: string[]) {
    if (this.segWrite === SEG) {
      this.segIdx++; this.segWrite = 0;
      this.posSegs.push(new Float32Array(SEG * 3));
      this.idSegs.push(new Int32Array(SEG));
      for (const n of extraNames) this.extraSegs[n].push(new Array(SEG));
    }
    const pS = this.posSegs[this.segIdx]!;
    const iS = this.idSegs[this.segIdx]!;
    writeScenePosition(pS, this.segWrite, east, north, up);
    iS[this.segWrite] = id;
    for (let k = 0; k < extraIdx.length; k++) {
      this.extraSegs[extraNames[k]][this.segIdx]![this.segWrite] = toks[extraIdx[k]] ?? '';
    }
    this.segWrite++;
    this.wrote++;
  }

  finish(): ParsedCloudData {
    const { header, sep, ix, iy, iz, iId, extraIdx, extraNames, hadHeader } = this.hi;
    const wrote = this.wrote;
    const positions = new Float32Array(wrote * 3);
    const treeIds = new Int32Array(wrote);
    // TXT parser leaves extras as JS strings — that's the only thing the
    // streaming SoA segment buffer carries. Numeric typed-array extras
    // are an LAS / binary-parser concern (parseLasStream writes them
    // directly).
    const extraCols: Record<string, ExtraColumn> = {};
    for (const n of extraNames) extraCols[n] = new Array<string>(wrote);
    let cursor = 0;
    for (let s = 0; s < this.posSegs.length; s++) {
      const cnt = s < this.posSegs.length - 1 ? SEG : this.segWrite;
      positions.set(this.posSegs[s]!.subarray(0, cnt * 3), cursor * 3);
      treeIds.set(this.idSegs[s]!.subarray(0, cnt), cursor);
      for (const n of extraNames) {
        const src = this.extraSegs[n][s]!;
        const dst = extraCols[n] as string[];
        for (let k = 0; k < cnt; k++) dst[cursor + k] = src[k];
      }
      cursor += cnt;
      this.posSegs[s] = null;
      this.idSegs[s] = null;
      for (const n of extraNames) this.extraSegs[n][s] = null;
    }
    return {
      positions,
      treeIds,
      extraCols,
      columnOrder: header,
      columnSep: sep,
      hadHeader,
      origin: { x: this.ox ?? 0, y: this.oy ?? 0, z: this.oz ?? 0 },
      colIdx: { ix, iy, iz, iId, extraIdx, extraNames },
      count: wrote,
      coordDecimals: this.decimals(),
    };
  }

  // Finalize and pack extras into transferable byte buffers. Used by the worker so we
  // never have to structured-clone a Record<string, string[]> with 50M+ strings.
  finishPacked(): { result: ParsedCloudPacked; transferables: ArrayBuffer[] } {
    const { header, sep, ix, iy, iz, iId, extraIdx, extraNames, hadHeader } = this.hi;
    const wrote = this.wrote;
    const positions = new Float32Array(wrote * 3);
    const treeIds = new Int32Array(wrote);
    let cursor = 0;
    for (let s = 0; s < this.posSegs.length; s++) {
      const cnt = s < this.posSegs.length - 1 ? SEG : this.segWrite;
      positions.set(this.posSegs[s]!.subarray(0, cnt * 3), cursor * 3);
      treeIds.set(this.idSegs[s]!.subarray(0, cnt), cursor);
      cursor += cnt;
      this.posSegs[s] = null;
      this.idSegs[s] = null;
    }

    // Pack extras column by column: concatenate UTF-8 bytes, build offsets table.
    const packedBytes: ArrayBuffer[] = [];
    const packedOffsets: ArrayBuffer[] = [];
    const enc = new TextEncoder();
    for (const n of extraNames) {
      const segs = this.extraSegs[n];
      const offsets = new Uint32Array(wrote + 1);
      // First pass: encode each value to bytes, measure size.
      const encodedSegs: Uint8Array[] = new Array(wrote);
      let total = 0;
      let idx = 0;
      for (let s = 0; s < segs.length; s++) {
        const segArr = segs[s];
        if (!segArr) continue;
        const cnt = s < segs.length - 1 ? SEG : this.segWrite;
        for (let k = 0; k < cnt; k++) {
          offsets[idx] = total;
          const enc8 = enc.encode(segArr[k] ?? '');
          encodedSegs[idx] = enc8;
          total += enc8.length;
          idx++;
        }
        // Free the segment to reduce peak memory.
        this.extraSegs[n][s] = null;
      }
      offsets[wrote] = total;
      // Second pass: blit into a single buffer.
      const bytes = new Uint8Array(total);
      let off = 0;
      for (let k = 0; k < wrote; k++) {
        const e = encodedSegs[k];
        if (e && e.length) bytes.set(e, off);
        off += e ? e.length : 0;
        encodedSegs[k] = null as unknown as Uint8Array;
      }
      packedBytes.push(bytes.buffer);
      packedOffsets.push(offsets.buffer);
    }

    const transferables: ArrayBuffer[] = [
      positions.buffer,
      treeIds.buffer,
      ...packedBytes,
      ...packedOffsets,
    ];
    return {
      result: {
        positions,
        treeIds,
        packedExtras: { names: extraNames.slice(), bytes: packedBytes, offsets: packedOffsets },
        columnOrder: header,
        columnSep: sep,
        hadHeader,
        origin: { x: this.ox ?? 0, y: this.oy ?? 0, z: this.oz ?? 0 },
        colIdx: { ix, iy, iz, iId, extraIdx, extraNames },
        count: wrote,
        coordDecimals: this.decimals(),
      },
      transferables,
    };
  }
}

export function unpackExtras(packed: PackedExtraCols, count: number): Record<string, string[]> {
  const dec = new TextDecoder('utf-8');
  const result: Record<string, string[]> = {};
  for (let c = 0; c < packed.names.length; c++) {
    const name = packed.names[c];
    const bytes = new Uint8Array(packed.bytes[c]);
    const offsets = new Uint32Array(packed.offsets[c]);
    const arr = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      const s = offsets[i];
      const e = offsets[i + 1];
      arr[i] = e > s ? dec.decode(bytes.subarray(s, e)) : '';
    }
    result[name] = arr;
  }
  return result;
}
