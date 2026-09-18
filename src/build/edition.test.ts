import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import { EDITION, showsRieglPanel, preprocessingSources, coregisterSources, type Edition } from './edition';

const read = (p: string) => stripComments(readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8'));

/** Two editions, one changed line. The release must not offer the RIEGL
 *  importer — it cannot give a user their points — while the development
 *  build must keep it; and the difference must live in edition.ts alone. */
describe('the editions', () => {
  it('differ only in whether the RIEGL panel shows', () => {
    expect(showsRieglPanel('development')).toBe(true);
    expect(showsRieglPanel('release')).toBe(false);
    expect(preprocessingSources('development')[0]).toMatch(/Riegl/);
    expect(preprocessingSources('release').join(' ')).not.toMatch(/Riegl/i);
    expect(preprocessingSources('release').length).toBe(preprocessingSources('development').length - 1);
    expect(coregisterSources('development')).toBe('Riegl / E57 / PTX');
    expect(coregisterSources('release')).toBe('E57 / PTX');
  });

  it('is decided in edition.ts and read from there by the module', () => {
    // Whichever branch this is, the constant is one of the two.
    const editions: Edition[] = ['development', 'release'];
    expect(editions).toContain(EDITION);
    const module_ = read('src/modules/PreprocessingModule.tsx');
    // The panel is rendered under the edition's say-so and nothing else…
    expect(module_).toMatch(/\{showsRieglPanel\(EDITION\) && \(\s*<RieglProjectPanel/);
    // …and so is every mention of it in the module's own words.
    expect(module_).toMatch(/preprocessingSources\(EDITION\)\.join\(', '\)/);
    expect(module_, 'the header still names Riegl by hand').not.toMatch(/Riegl RiSCAN \/ RiPROCESS/);
    expect(read('src/components/preprocessing/CoregisterPanel.tsx')).toMatch(/coregisterSources\(EDITION\)/);
  });
});
