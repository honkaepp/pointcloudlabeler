// Shared machinery for the tests that police the SOURCE rather than a
// value.
//
// Several defects in this codebase were not one bad decision but the
// same line spelled by hand in a dozen places — a hardcoded currency
// symbol, a raw CSV Blob with no byte-order mark, a second copy of the
// wood density. A value assertion catches the twelve that exist; only a
// scan stops the thirteenth.
//
// Every one of those scans has to dodge the same trap, and each of them
// hit it before landing: the file being policed EXPLAINS the defect in
// prose, naming the very thing the scan forbids, so a scan that reads
// comments finds the bug in its own account of the fix. That happened
// three times in a row, which is what this file is for.
//
// Test-only. Nothing in the shipping app imports it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Every .ts / .tsx file under `dir` that ships — no tests, no
 *  node_modules, no build output, no dotfiles. */
export function walkSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkSources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Blank out comments, keeping the line count and every line's length
 *  intact so an offender still reports its own line and column.
 *
 *  Not a parser: a `//` inside a string literal (a URL) blanks the rest
 *  of that line. That direction is safe for a scan — it can only hide a
 *  violation written after a URL on the same line, which is not how any
 *  of these defects were ever written — while the direction it fixes,
 *  finding the needle in the comment that documents its removal, broke
 *  three of these tests in a row. */
export function stripComments(src: string): string {
  const blanked = src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
  return blanked
    .split('\n')
    .map(l => {
      const i = l.indexOf('//');
      return i < 0 ? l : l.slice(0, i);
    })
    .join('\n');
}

export interface SourceHit {
  file: string;
  line: number;
  text: string;
}

/** Every line of shipping code under `dir` matching `pattern`, with
 *  comments already stripped. `exempt` names the files allowed to
 *  contain it — normally the one place the thing is legitimately
 *  defined, which is the whole point of the rule. */
export function scanSources(
  dir: string,
  pattern: RegExp | string,
  exempt: (file: string) => boolean = () => false,
): SourceHit[] {
  const hits: SourceHit[] = [];
  const test = (l: string) => (typeof pattern === 'string' ? l.includes(pattern) : pattern.test(l));
  for (const file of walkSources(dir)) {
    if (exempt(file)) continue;
    stripComments(readFileSync(file, 'utf8')).split('\n').forEach((l, i) => {
      if (test(l)) hits.push({ file, line: i + 1, text: l.trim() });
    });
  }
  return hits;
}

/** `path/to/file.ts:12: the offending line` — what an assertion message
 *  needs so the reader can go straight there. */
export function describeHits(hits: SourceHit[]): string {
  return hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n');
}
