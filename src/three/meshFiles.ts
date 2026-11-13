// Reading triangle meshes for the viewer: PLY (ASCII or binary
// little-endian; float or double vertices), OBJ (polygons fanned into
// triangles) and STL (binary or ASCII). Coordinates stay in double
// precision; the viewer subtracts the dataset's offset before they become
// 32-bit floats. A PointCloudLabeler STL names its origin in the header (its floats
// are relative to it).

export interface MeshData {
  /** x, y, z per vertex, world coordinates. */
  positions: Float64Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
  /** R, g, b per vertex, 0–1, when the file carries colours
   *  (QSM tubes are coloured by quality). */
  colors?: Float32Array;
}

const decoder = new TextDecoder();

export function meshFormat(path: string): 'ply' | 'obj' | 'stl' | null {
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'ply' || ext === 'obj' || ext === 'stl' ? ext : null;
}

export function parseMesh(path: string, buf: ArrayBuffer): MeshData {
  switch (meshFormat(path)) {
    case 'ply': return parsePly(buf);
    case 'obj': return parseObj(decoder.decode(buf));
    case 'stl': return parseStl(buf);
    default: throw new Error(`${path}: not a PLY, OBJ or STL file`);
  }
}

// ---------------------------------------------------------------------------
// PLY

interface PlyElement { name: string; count: number; props: Array<{ name: string; type: string; list?: { count: string; item: string } }> }

const PLY_SIZES: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8,
};

function readPlyValue(dv: DataView, at: number, type: string): number {
  switch (type) {
    case 'char': case 'int8': return dv.getInt8(at);
    case 'uchar': case 'uint8': return dv.getUint8(at);
    case 'short': case 'int16': return dv.getInt16(at, true);
    case 'ushort': case 'uint16': return dv.getUint16(at, true);
    case 'int': case 'int32': return dv.getInt32(at, true);
    case 'uint': case 'uint32': return dv.getUint32(at, true);
    case 'float': case 'float32': return dv.getFloat32(at, true);
    case 'double': case 'float64': return dv.getFloat64(at, true);
    default: throw new Error(`PLY: unknown type ${type}`);
  }
}

export function parsePly(buf: ArrayBuffer): MeshData {
  const bytes = new Uint8Array(buf);
  const headEnd = findHeaderEnd(bytes);
  const header = decoder.decode(bytes.subarray(0, headEnd)).split(/\r?\n/);
  if (header[0].trim() !== 'ply') throw new Error('not a PLY file');
  let format = '';
  const elements: PlyElement[] = [];
  for (const line of header.slice(1)) {
    const w = line.trim().split(/\s+/);
    if (w[0] === 'format') format = w[1];
    else if (w[0] === 'element') elements.push({ name: w[1], count: Number(w[2]), props: [] });
    else if (w[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1];
      if (w[1] === 'list') el.props.push({ name: w[4], type: 'list', list: { count: w[2], item: w[3] } });
      else el.props.push({ name: w[2], type: w[1] });
    }
  }
  const vEl = elements.find((e) => e.name === 'vertex');
  if (!vEl) throw new Error('PLY: no vertices');
  const xi = vEl.props.findIndex((p) => p.name === 'x'), yi = vEl.props.findIndex((p) => p.name === 'y'), zi = vEl.props.findIndex((p) => p.name === 'z');
  if (xi < 0 || yi < 0 || zi < 0) throw new Error('PLY: vertices without x, y, z');
  const positions = new Float64Array(vEl.count * 3);
  // Vertex colours, uchar 0–255 or float 0–1
  const ri = vEl.props.findIndex((p) => p.name === 'red'), gi = vEl.props.findIndex((p) => p.name === 'green'), bi = vEl.props.findIndex((p) => p.name === 'blue');
  const colors = ri >= 0 && gi >= 0 && bi >= 0 ? new Float32Array(vEl.count * 3) : undefined;
  const colourScale = colors && /float|double/.test(vEl.props[ri].type) ? 1 : 1 / 255;
  const tris: number[] = [];
  const addFace = (idx: number[]) => { for (let k = 1; k + 1 < idx.length; k++) tris.push(idx[0], idx[k], idx[k + 1]); };
  if (format === 'ascii') {
    const lines = decoder.decode(bytes.subarray(headEnd)).split(/\r?\n/).filter((l) => l.trim() !== '');
    let li = 0;
    for (const el of elements) {
      for (let n = 0; n < el.count; n++) {
        const w = lines[li++].trim().split(/\s+/).map(Number);
        if (el === vEl) {
          positions.set([w[xi], w[yi], w[zi]], n * 3);
          if (colors) colors.set([w[ri] * colourScale, w[gi] * colourScale, w[bi] * colourScale], n * 3);
        }
        else if (el.name === 'face') {
          // the first list property holds the indices
          let at = 0;
          for (const p of el.props) {
            if (p.list) { const c = w[at]; if (p.name.startsWith('vertex')) addFace(w.slice(at + 1, at + 1 + c)); at += 1 + c; }
            else at += 1;
          }
        }
      }
    }
  } else if (format === 'binary_little_endian') {
    const dv = new DataView(buf);
    let at = headEnd;
    for (const el of elements) {
      for (let n = 0; n < el.count; n++) {
        for (let k = 0; k < el.props.length; k++) {
          const p = el.props[k];
          if (p.list) {
            const c = readPlyValue(dv, at, p.list.count);
            at += PLY_SIZES[p.list.count];
            const size = PLY_SIZES[p.list.item];
            if (el.name === 'face' && p.name.startsWith('vertex')) {
              const idx: number[] = [];
              for (let j = 0; j < c; j++) idx.push(readPlyValue(dv, at + j * size, p.list.item));
              addFace(idx);
            }
            at += c * size;
          } else {
            if (el === vEl && (k === xi || k === yi || k === zi)) {
              positions[n * 3 + (k === xi ? 0 : k === yi ? 1 : 2)] = readPlyValue(dv, at, p.type);
            } else if (colors && el === vEl && (k === ri || k === gi || k === bi)) {
              colors[n * 3 + (k === ri ? 0 : k === gi ? 1 : 2)] = readPlyValue(dv, at, p.type) * colourScale;
            }
            at += PLY_SIZES[p.type];
          }
        }
      }
    }
  } else {
    throw new Error(`PLY: format ${format} is not read (ascii or binary_little_endian)`);
  }
  return { positions, indices: Uint32Array.from(tris), colors };
}

function findHeaderEnd(b: Uint8Array): number {
  const tag = 'end_header';
  for (let i = 0; i + tag.length < b.length && i < 65536; i++) {
    let ok = true;
    for (let k = 0; k < tag.length; k++) if (b[i + k] !== tag.charCodeAt(k)) { ok = false; break; }
    if (ok) {
      let j = i + tag.length;
      if (b[j] === 13) j++;
      if (b[j] === 10) j++;
      return j;
    }
  }
  throw new Error('PLY: no end_header');
}

// ---------------------------------------------------------------------------
// OBJ

export function parseObj(text: string): MeshData {
  const pos: number[] = [];
  const tris: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const w = line.split(/\s+/);
      pos.push(Number(w[1]), Number(w[2]), Number(w[3]));
    } else if (line.startsWith('f ')) {
      const n = pos.length / 3;
      const idx = line.split(/\s+/).slice(1).map((t) => {
        const v = parseInt(t.split('/')[0], 10);
        return v < 0 ? n + v : v - 1;
      });
      for (let k = 1; k + 1 < idx.length; k++) tris.push(idx[0], idx[k], idx[k + 1]);
    }
  }
  return { positions: Float64Array.from(pos), indices: Uint32Array.from(tris) };
}

// ---------------------------------------------------------------------------
// STL

/** "PointCloudLabeler mesh; origin x y z" in a binary STL's header. */
export function stlOrigin(header: string): [number, number, number] {
  const m = header.match(/origin\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

export function parseStl(buf: ArrayBuffer): MeshData {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(buf);
  const binaryCount = buf.byteLength >= 84 ? dv.getUint32(80, true) : -1;
  const isBinary = binaryCount >= 0 && 84 + binaryCount * 50 === buf.byteLength;
  if (isBinary) {
    const o = stlOrigin(decoder.decode(bytes.subarray(0, 80)));
    const positions = new Float64Array(binaryCount * 9);
    for (let t = 0; t < binaryCount; t++) {
      const at = 84 + t * 50 + 12;
      for (let k = 0; k < 9; k++) positions[t * 9 + k] = dv.getFloat32(at + k * 4, true) + o[k % 3];
    }
    return { positions, indices: Uint32Array.from({ length: binaryCount * 3 }, (_, i) => i) };
  }
  const pos: number[] = [];
  for (const m of decoder.decode(bytes).matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) pos.push(Number(m[1]), Number(m[2]), Number(m[3]));
  return { positions: Float64Array.from(pos), indices: Uint32Array.from({ length: pos.length / 3 }, (_, i) => i) };
}

// ---------------------------------------------------------------------------

/** Per-vertex colours lit from the north-west, above (the viewer has no
 *  lights for meshes): `base` scaled by 0.35 … 1 from the smooth normal. */
export function shadeVertices(positions: Float64Array, indices: Uint32Array, base: [number, number, number], perVertex?: Float32Array): Float32Array {
  const n = positions.length / 3;
  const nrm = new Float64Array(n * 3);
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { nrm[v * 3] += fx; nrm[v * 3 + 1] += fy; nrm[v * 3 + 2] += fz; }
  }
  const light = [-0.5, 0.5, 0.707];
  const out = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const x = nrm[v * 3], y = nrm[v * 3 + 1], z = nrm[v * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    // both sides lit alike: a surface seen from below is not black
    const k = 0.35 + 0.65 * Math.abs((x * light[0] + y * light[1] + z * light[2]) / l);
    // A vertex's own colour where the file gave one
    const r = perVertex ? perVertex[v * 3] : base[0], g = perVertex ? perVertex[v * 3 + 1] : base[1], b = perVertex ? perVertex[v * 3 + 2] : base[2];
    out[v * 3] = r * k; out[v * 3 + 1] = g * k; out[v * 3 + 2] = b * k;
  }
  return out;
}
