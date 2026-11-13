// The Data tab is where all data comes in, and the program speaks
// this platform's shortcuts.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../testing/sourceScan';
import { crsLabel } from './preprocessing/ProjectCrs';

const read = (rel: string) => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'));

describe('the Data tab', () => {
  const module_ = read('../modules/PreprocessingModule.tsx');
  it('is named for what it is, opens data and shows the project coordinate system', () => {
    expect(read('./ModuleTabs.tsx')).toContain("{ id: 'preprocessing', label: 'Data',");
    expect(module_).toContain("onClick={() => void pickData('file')}");
    expect(module_).toContain("onClick={() => void pickData('folder')}");
    expect(module_).toContain('<ProjectCrs />');
  });
  it('has no placeholder for things that are not there', () => {
    expect(module_).not.toContain('More — coming');
  });
  it('says the project coordinate system', () => {
    expect(crsLabel({ epsg: 3067, name: 'ETRS89 / TM35FIN(E,N)', vertical: 'N2000' })).toBe('EPSG:3067 + N2000');
    expect(crsLabel({ epsg: null, name: 'unknown' })).toBeNull();
  });
});

describe('shortcuts', () => {
  it('no component shows the Mac command key as a fixed glyph', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.tsx')) files.push(p);
      }
    };
    walk(root);
    const offenders = files.filter((f) => {
      const s = stripComments(readFileSync(f, 'utf8'));
      return /<span className="kbd"[^>]*>⌘/.test(s) || /title="[^"]*⌘/.test(s);
    });
    expect(offenders).toEqual([]);
  });
});
