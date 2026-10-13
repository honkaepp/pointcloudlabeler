import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CLOUD_OPEN_FILTERS, POINT_FILE_ROLES, cloudSaveFilter, isPointFileName, pointFileKindOf, withExportExtension,
} from './pointFile';

describe('point file kinds', () => {
  it('recognises the text, PLY and E57 families and nothing else', () => {
    expect(pointFileKindOf('plot.txt')).toBe('text');
    expect(pointFileKindOf('PLOT.XYZ')).toBe('text');
    expect(pointFileKindOf('a.csv')).toBe('text');
    expect(pointFileKindOf('a.pts')).toBe('text');
    expect(pointFileKindOf('tree.ply')).toBe('ply');
    expect(pointFileKindOf('scan.e57')).toBe('e57');
    expect(pointFileKindOf('plot.las')).toBeNull();
    expect(pointFileKindOf('plot.laz')).toBeNull();
    expect(pointFileKindOf('noext')).toBeNull();
    expect(isPointFileName('x.ply')).toBe(true);
    expect(isPointFileName('x.las')).toBe(false);
  });

  /** The open dialog's first filter must offer every family the Rust
   *  side reads — a file that can be picked but not imported, or
   *  imported but not picked, is the same bug from either side. */
  it('the open-dialog filter covers every kind', () => {
    const all = CLOUD_OPEN_FILTERS[0].extensions;
    for (const ext of ['las', 'laz', 'txt', 'xyz', 'csv', 'ply', 'e57']) expect(all).toContain(ext);
    for (const ext of all) {
      if (ext === 'las' || ext === 'laz') continue;
      expect(pointFileKindOf(`f.${ext}`), ext).not.toBeNull();
    }
  });

  it('the export extension follows the dialog, except a text extension the user typed', () => {
    expect(withExportExtension('/p/out.las', 'laz')).toBe('/p/out.laz');
    expect(withExportExtension('/p/out.laz', 'txt')).toBe('/p/out.txt');
    expect(withExportExtension('/p/out.xyz', 'txt')).toBe('/p/out.xyz');
    expect(withExportExtension('/p/out.csv', 'txt')).toBe('/p/out.csv');
    expect(withExportExtension('/p/out.txt', 'ply')).toBe('/p/out.ply');
    expect(withExportExtension('/p/out', 'e57')).toBe('/p/out.e57');
    for (const f of ['las', 'laz', 'txt', 'ply', 'e57'] as const) {
      expect(cloudSaveFilter(f).extensions[0]).toBe(f);
    }
  });

  /** The dialog's roles are the mapping's fields — one list on each
   *  side, and the Rust mapping has the same names in snake case. */
  it('the roles match the Rust mapping field for field', () => {
    const rust = readFileSync('src-tauri/src/commands/pointfile.rs', 'utf8');
    const block = rust.slice(rust.indexOf('pub struct PointFileMapping'), rust.indexOf('pub extras: Vec<String>'));
    const snake = (k: string) => k.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
    for (const r of POINT_FILE_ROLES) {
      expect(block, `mapping field ${r.key}`).toContain(`pub ${snake(r.key)}: Option<String>`);
    }
    const rustFields = [...block.matchAll(/pub (\w+): Option<String>/g)].map(m => m[1]);
    expect(rustFields.length).toBe(POINT_FILE_ROLES.length + 3);
  });
});
