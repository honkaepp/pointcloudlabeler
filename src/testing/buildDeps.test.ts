// Does this repository build on a machine that is not the one it was
// written on?
//
// It did not. `npm run build:web` runs `tsc` over everything including
// the tests, and the tests import `node:fs`, `node:path` and
// `node:crypto`. The types for those live in `@types/node`, which
// nothing in package.json asked for: it arrived as an OPTIONAL PEER
// dependency of vite and vitest, which npm is free to install or not.
//
// On the machine this was written on, npm installed it. On a clean
// Windows checkout it did not, and the build stopped with 52 errors
// across 19 files, every one of them a `node:` import — after the
// author had installed Rust and several gigabytes of MSVC build tools
// to get that far.
//
// Nothing here was Windows-specific. The same clone on the same machine
// a week earlier could have gone either way. That is the defect: a
// build that depends on a package no manifest requires.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Every TypeScript file `tsc` compiles, TESTS INCLUDED — they are what
 *  imports the Node builtins, and `build:web` typechecks them. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('the build does not depend on a package nothing asked for', () => {
  const pkg = JSON.parse(read('package.json'));
  const declared: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };

  it('declares @types/node if anything imports a Node builtin', () => {
    const importers: string[] = [];
    for (const file of sources(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      if (/\bfrom\s+['"]node:|\brequire\(\s*['"]node:/.test(text)) {
        importers.push(file.slice(ROOT.length));
      }
    }
    // If this ever becomes empty the assertion below stops meaning
    // anything, so say so rather than passing quietly.
    expect(importers.length,
      'nothing imports a Node builtin any more — this test is now vacuous')
      .toBeGreaterThan(0);

    expect(
      Object.keys(declared),
      `${importers.length} files import Node builtins (${importers.slice(0, 3).join(', ')}…) ` +
      'but @types/node is not declared in package.json',
    ).toContain('@types/node');
  });

  /** The part that actually bit. `@types/node` WAS in the lockfile the
   *  whole time — as `"optional": true, "peer": true`, which npm honours
   *  by installing it on some machines and not others. Present in the
   *  lock is not the same as installed, and a test that only checked
   *  the lock would have passed on the tree that failed to build. */
  it('pins it as a real dependency, not an optional peer', () => {
    const lock = JSON.parse(read('package-lock.json'));
    const entry = lock.packages?.['node_modules/@types/node'];
    expect(entry, '@types/node is missing from the lockfile entirely').toBeTruthy();
    expect(entry.optional,
      '@types/node is optional in the lockfile — npm may skip it, and did')
      .toBeFalsy();
    expect(entry.peer,
      '@types/node is a peer-only entry — nothing requires it directly')
      .toBeFalsy();
    // …and the root package must be the thing that requires it.
    expect(lock.packages[''].devDependencies).toHaveProperty('@types/node');
  });

  /** The README tells a stranger how to build this. Both halves of that
   *  instruction have been wrong at once.
   *
   *  `cd` named the PRODUCT while `git clone` named the REPOSITORY, so
   *  following the README landed you in a directory that does not
   *  exist. The rename script caused it and could not have caught it:
   *  it deliberately protects `github.com/<owner>/<slug>` URLs from
   *  being rewritten, and then rewrote the `cd` on the next line. */
  it('tells you to enter the directory the clone actually creates', () => {
    const readme = read('README.md');
    const pair = readme.match(/git clone\s+(\S+?)(?:\.git)?\s*\n\s*cd\s+(\S+)/);
    expect(pair, 'the README no longer shows a clone followed by a cd').toBeTruthy();
    const repo = pair![1].split('/').pop()!;
    expect(pair![2],
      `the README clones ${repo}/ and then cd's into ${pair![2]}/, which the clone did not create`)
      .toBe(repo);
  });

  /** The declared major has to be one the documented Node floor can
   *  actually provide, or the types describe a runtime the user does not
   *  have. The README says Node >= 20. */
  it('matches the Node version the project says it needs', () => {
    const range = declared['@types/node'];
    const major = range.match(/(\d+)/)?.[1];
    expect(major, `cannot read a major version out of ${range}`).toBeTruthy();
    expect(read('README.md')).toMatch(new RegExp(`Node\\.js ${major}\\+|Node\\.js ≥ ${major}`));
  });
});
