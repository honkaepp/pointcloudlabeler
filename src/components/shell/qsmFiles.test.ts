// QSM files in the editor: the tubes' colours read from the PLY
// and drawn as they are, the buttons wired to the desktop commands.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../../testing/sourceScan';
import { parsePly, shadeVertices } from '../../three/meshFiles';
import { QSM_QUALITY } from './qsmFiles';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

/** A binary PLY like the one commands/qsmfile writes: double positions,
 *  uchar colours, faces with a tree. */
function tubePly(): ArrayBuffer {
  const head = 'ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 1\nproperty list uchar int vertex_indices\nproperty int tree\nend_header\n';
  const h = new TextEncoder().encode(head);
  const buf = new ArrayBuffer(h.length + 3 * 27 + 1 + 12 + 4);
  new Uint8Array(buf).set(h);
  const dv = new DataView(buf);
  let o = h.length;
  const verts: [number, number, number, number, number, number][] = [
    [400000, 6800000, 100, 74, 222, 128], [400001, 6800000, 100, 250, 204, 21], [400000, 6800001, 100, 239, 68, 68],
  ];
  for (const v of verts) {
    for (let a = 0; a < 3; a++) { dv.setFloat64(o, v[a], true); o += 8; }
    for (let a = 3; a < 6; a++) dv.setUint8(o++, v[a]);
  }
  dv.setUint8(o++, 3);
  for (const k of [0, 1, 2]) { dv.setInt32(o, k, true); o += 4; }
  dv.setInt32(o, 7, true);
  return buf;
}

describe('QSM tubes in the viewer', () => {
  it('a PLY keeps its vertex colours and world coordinates', () => {
    const m = parsePly(tubePly());
    expect(Array.from(m.positions.slice(0, 3))).toEqual([400000, 6800000, 100]);
    expect(Array.from(m.indices)).toEqual([0, 1, 2]);
    expect(m.colors).toBeDefined();
    expect(m.colors![0]).toBeCloseTo(74 / 255, 6);
    expect(m.colors![4]).toBeCloseTo(204 / 255, 6);
  });
  it('shading keeps each vertex its colour; without colours the layer colour', () => {
    const m = parsePly(tubePly());
    const lit = shadeVertices(m.positions, m.indices, [1, 1, 1], m.colors);
    expect(lit[0] / lit[1]).toBeCloseTo(74 / 222, 5);
    const plain = shadeVertices(m.positions, m.indices, [0.5, 0.5, 0.5]);
    expect(plain[0]).toBe(plain[1]);
  });
  it('the legend of the quality levels matches what the tubes are painted', () => {
    const rs = read('../../../src-tauri/src/commands/qsmfile.rs');
    for (const q of QSM_QUALITY) {
      const rgb = q.color.match(/\d+/g)!.join(', ');
      expect(rs).toContain(`[${rgb}]`);
    }
  });
  it('the Metrics module offers the tubes, the files and other software\'s QSMs', () => {
    const mm = read('../../modules/MetricsModule.tsx');
    expect(mm).toContain('void showQsmTubes(dir)');
    expect(mm).toContain('void exportQsmFiles(dir)');
    expect(mm).toContain('void openQsmFile()');
    expect(read('../../three/SurveyOverlay.tsx')).toContain('shadeVertices(data.positions, data.indices, [c.r, c.g, c.b], data.colors)');
    const lib = read('../../../src-tauri/src/lib.rs');
    expect(lib).toContain('commands::qsmfile::qsm_export_files,');
    expect(lib).toContain('commands::qsmfile::qsm_import_file,');
  });
});
