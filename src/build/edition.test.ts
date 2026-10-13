import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import { EDITION, preprocessingSources, coregisterSources, preprocessingTabSub, type Edition } from './edition';

const read = (p: string) => stripComments(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));

/** Two editions, one changed line. The release must not offer an
 *  importer that cannot give a user their points, while the development
 *  build must keep it; and the difference must live in edition.ts alone. */
describe('the editions', () => {
  it('are decided in edition.ts and read from there by the module', () => {
    // Whichever branch this is, the constant is one of the two.
    const editions: Edition[] = ['development', 'release'];
    expect(editions).toContain(EDITION);
    const module_ = read('src/modules/PreprocessingModule.tsx');
    // Every mention of the importers in the module's own words comes
    // from the edition.
    expect(module_).toMatch(/preprocessingSources\(EDITION\)\.join\(', '\)/);
    expect(read('src/components/preprocessing/CoregisterPanel.tsx')).toMatch(/coregisterSources\(EDITION\)/);
    expect(coregisterSources('release')).toBe('E57 / PTX');
    expect(preprocessingTabSub('release')).toBe('E57 · PTX · register · export');
    expect(preprocessingSources('release').length).toBe(3);
  });

});
