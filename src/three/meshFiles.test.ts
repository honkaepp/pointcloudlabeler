import { describe, it, expect } from 'vitest';
import { meshFormat, parseMesh, parseObj, parsePly, parseStl, shadeVertices, stlOrigin } from './meshFiles';

const enc = new TextEncoder();

/** A binary PLY as survey.rs writes it: double vertices, uchar/int faces. */
function plyBinary(v: number[][], f: number[][]): ArrayBuffer {
  const head = enc.encode(`ply\nformat binary_little_endian 1.0\ncomment PointCloudLabeler mesh\nelement vertex ${v.length}\nproperty double x\nproperty double y\nproperty double z\nelement face ${f.length}\nproperty list uchar int vertex_indices\nend_header\n`);
  const body = new ArrayBuffer(v.length * 24 + f.reduce((n, x) => n + 1 + 4 * x.length, 0));
  const dv = new DataView(body);
  let at = 0;
  for (const p of v) for (const c of p) { dv.setFloat64(at, c, true); at += 8; }
  for (const x of f) { dv.setUint8(at, x.length); at += 1; for (const i of x) { dv.setInt32(at, i, true); at += 4; } }
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(head); out.set(new Uint8Array(body), head.length);
  return out.buffer;
}

describe('mesh files', () => {
  it('reads a binary PLY with world coordinates and fans a quad', () => {
    const v = [[399650.125, 6786360.5, 160.25], [399651, 6786360.5, 160], [399651, 6786361.5, 161], [399650, 6786361.5, 161]];
    const m = parsePly(plyBinary(v, [[0, 1, 2, 3]]));
    expect(Array.from(m.positions.slice(0, 3))).toEqual(v[0]);
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('reads an ASCII PLY with extra properties', () => {
    const text = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0 255\n1 0 0 0\n0 1 0 9\n3 0 1 2\n';
    const m = parsePly(enc.encode(text).buffer);
    expect(Array.from(m.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(Array.from(m.indices)).toEqual([0, 1, 2]);
  });

  it('reads OBJ polygons, slashes and negative indices', () => {
    const m = parseObj('# x\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvn 0 0 1\nf 1/1/1 2/2/1 3/3/1 4/4/1\nf -4 -3 -2\n');
    expect(m.positions.length).toBe(12);
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3, 0, 1, 2]);
  });

  it('reads binary STL relative to its origin, and ASCII STL', () => {
    const buf = new ArrayBuffer(84 + 50);
    const head = enc.encode('PointCloudLabeler mesh; origin 399650.000 6786360.000 160.000');
    new Uint8Array(buf).set(head);
    const dv = new DataView(buf);
    dv.setUint32(80, 1, true);
    const tri = [0, 0, 1, 1, 2, 0.5, 2, 3, 1, 3, 4, 1.5];
    tri.forEach((x, k) => dv.setFloat32(84 + k * 4, x, true));
    const m = parseStl(buf);
    expect(Array.from(m.positions.slice(0, 3))).toEqual([399651, 6786362, 160.5]);
    expect(stlOrigin('nothing')).toEqual([0, 0, 0]);
    const ascii = parseStl(enc.encode('solid s\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid\n').buffer);
    expect(Array.from(ascii.indices)).toEqual([0, 1, 2]);
  });

  it('knows the formats by name and shades both sides alike', () => {
    expect(meshFormat('C:/a/b.PLY')).toBe('ply');
    expect(meshFormat('x.dxf')).toBeNull();
    expect(() => parseMesh('x.dxf', new ArrayBuffer(0))).toThrow(/not a PLY/);
    const pos = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const up = shadeVertices(pos, Uint32Array.from([0, 1, 2]), [1, 1, 1]);
    const down = shadeVertices(pos, Uint32Array.from([0, 2, 1]), [1, 1, 1]);
    expect(up[0]).toBeCloseTo(down[0], 6);
    expect(up[0]).toBeGreaterThan(0.35);
    expect(up[0]).toBeLessThanOrEqual(1);
  });
});
