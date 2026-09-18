// What the application calls itself on screen.
//
// The wordmark was written as `<span>T</span>RACE` — the product name
// split across two JSX elements so the first letter could be coloured.
// Neither half was the word. The string "TRACE" appeared nowhere in the
// file, so the rename script did not find it, grep did not find it, and
// no test could have: it survived two complete product renames, and the
// running application went on introducing itself by a name nothing else
// in the repository used.
//
// It was found by the author opening the built installer and reading
// the screen — which is the only way it could have been found, and is
// not a way anything gets found reliably.
//
// The fix is that the letters now come from the name, so they cannot
// disagree with it. These tests hold that name to the manifest.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { stripComments } from '../testing/sourceScan';
import {
  PRODUCT_NAME, wordmarkParts, wordmarkTracking, brandMonogram,
} from './PointCloudLabelerLogo';

const productName = JSON.parse(
  readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
).productName as string;

describe('the application calls itself what the manifest calls it', () => {
  it('spells the product name the way tauri.conf.json does', () => {
    expect(PRODUCT_NAME).toBe(productName);
  });

  it('renders the whole name, not a name split into pieces', () => {
    // The assertion the old wordmark would have failed: put the parts
    // back together and you must get the product's name.
    expect(wordmarkParts().join('')).toBe(productName);
    // Both halves non-empty, or the highlight is decoration on nothing.
    const [head, tail] = wordmarkParts();
    expect(head).toHaveLength(1);
    expect(tail.length).toBeGreaterThan(0);
  });

  it('splits any name it is given, without knowing which one', () => {
    expect(wordmarkParts('TRACE')).toEqual(['T', 'RACE']);
    expect(wordmarkParts('X')).toEqual(['X', '']);
    expect(wordmarkParts('')).toEqual(['', '']);
  });

  it('tracks the letters at a width the name can actually be read at', () => {
    // 0.18em was tuned by hand for a five-letter name. The formula has
    // to reproduce that exactly, or this is a redesign pretending to be
    // a refactor.
    expect(wordmarkTracking('TRACE')).toBe('0.180em');
    // …and a long name has to come out tighter, not seventeen letters
    // at display tracking in a tab bar.
    const long = parseFloat(wordmarkTracking(productName));
    expect(long).toBeLessThanOrEqual(0.18);
    expect(long).toBeGreaterThan(0);
    // Never zero or negative, whatever it is handed.
    expect(parseFloat(wordmarkTracking(''))).toBeGreaterThan(0);
    expect(parseFloat(wordmarkTracking('a'.repeat(200)))).toBeGreaterThan(0);
  });

  /** The activity rail's monogram had the identical defect and the
   *  identical hiding place: the literal `T·R`, initials of a name that
   *  appears nowhere in the string. Two of these in one component tree
   *  is not a coincidence — it is what happens when a designer's
   *  shorthand is typed instead of derived. */
  it('builds the rail monogram out of the name too', () => {
    const mono = brandMonogram();
    expect(mono.length, 'the monogram is empty').toBeGreaterThan(0);
    // Every letter in it has to come from the name.
    for (const letter of mono.replace(/·/g, '')) {
      expect(productName.toUpperCase()).toContain(letter);
    }
    // It has to start the way the name does.
    expect(mono[0]).toBe(productName[0].toUpperCase());
    // CamelCase gives its capitals; an all-capitals name falls back to
    // its opening letters, which is what the old literal was.
    expect(brandMonogram('PointCloudLabeler')).toBe('P·C·L');
    expect(brandMonogram('TRACE')).toBe('T·R');
    expect(brandMonogram('PEVIRA')).toBe('P·E');
    // …and it never comes out empty, whatever it is handed.
    expect(brandMonogram('x').length).toBeGreaterThan(0);
    expect(brandMonogram('')).toBe('');
  });

  it('leaves no component with the monogram typed out', () => {
    const bar = stripComments(readFileSync(
      new URL('./shell/ActivityBar.tsx', import.meta.url), 'utf8'));
    expect(bar, 'the activity rail hardcodes a monogram again')
      .not.toMatch(/>\s*[A-Z]·[A-Z]/);
    expect(bar, 'the activity rail does not derive its monogram')
      .toContain('brandMonogram()');
    // The scan has to still recognise the shape it forbids.
    expect('<div>T·R</div>').toMatch(/>\s*[A-Z]·[A-Z]/);
  });

  /** The other half: no OTHER component may hand-assemble the name out
   *  of literals. One place spells it; everywhere else mentions it in
   *  prose, which a rename can find. */
  it('leaves no component spelling the name letter by letter', () => {
    // Comments stripped: the file DOCUMENTS the old markup, so a raw
    // scan finds the defect inside its own account of the fix. Fourth
    // time in this repository, which is what sourceScan.ts is for.
    const logo = stripComments(
      readFileSync(new URL('./PointCloudLabelerLogo.tsx', import.meta.url), 'utf8'));
    // A single-character JSX text node butting straight up against more
    // text is the shape the defect had. Nothing should match it now.
    expect(logo, 'the wordmark hardcodes a letter again')
      .not.toMatch(/>\s*[A-Za-z]\s*<\/span>[A-Za-z]/);
    // …and the scan has to still recognise that shape, or it is a
    // reassuring no-op.
    expect('<span style={{x}}>T</span>RACE')
      .toMatch(/>\s*[A-Za-z]\s*<\/span>[A-Za-z]/);
  });
});
