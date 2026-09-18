import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { confirmDialog, alertDialog } from './dialogs';

type G = { desktop?: unknown; confirm?: unknown; alert?: unknown };
const g = globalThis as unknown as G;

afterEach(() => { delete g.desktop; delete g.confirm; delete g.alert; });

describe('confirmDialog', () => {
  it('asks through the desktop bridge when there is one, and returns its answer', async () => {
    const asked: string[] = [];
    g.desktop = { confirmDialog: async (m: string) => { asked.push(m); return true; } };
    // A stale window.confirm must not be consulted when the bridge exists.
    g.confirm = () => { throw new Error('window.confirm was called under Tauri'); };
    expect(await confirmDialog('Delete it?')).toBe(true);
    expect(asked).toEqual(['Delete it?']);
    g.desktop = { confirmDialog: async () => false };
    expect(await confirmDialog('Delete it?')).toBe(false);
  });

  it('falls back to the synchronous browser confirm without a bridge', async () => {
    g.confirm = (m: string) => m.includes('yes');
    expect(await confirmDialog('say yes')).toBe(true);
    expect(await confirmDialog('say no')).toBe(false);
  });

  /** The failure that was in the crash log: the box rejects. The
   *  action must not run. */
  it('answers no when the box cannot be shown', async () => {
    g.desktop = { confirmDialog: async () => { throw new Error('not allowed by ACL'); } };
    expect(await confirmDialog('Delete it?')).toBe(false);
    delete g.desktop;
    expect(await confirmDialog('nothing at all here')).toBe(false);
  });

  it('treats anything but true as no', async () => {
    g.desktop = { confirmDialog: async () => 'yes' as unknown as boolean };
    expect(await confirmDialog('?')).toBe(false);
  });
});

describe('alertDialog', () => {
  it('shows through the bridge, or the browser, and never throws', async () => {
    const shown: string[] = [];
    g.desktop = { messageDialog: async (m: string) => { shown.push(m); } };
    await alertDialog('done');
    expect(shown).toEqual(['done']);
    delete g.desktop;
    g.alert = (m: string) => { shown.push(`browser:${m}`); };
    await alertDialog('done again');
    expect(shown).toEqual(['done', 'browser:done again']);
    g.alert = () => { throw new Error('no'); };
    await expect(alertDialog('x')).resolves.toBeUndefined();
  });
});

/** Every yes/no question in the application goes through the helper,
 *  and awaits it. A bare `window.confirm(` or an un-awaited
 *  `confirmDialog(` is the bug this module exists to end. */
describe('no call site asks the browser directly', () => {
  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) sources(p, out);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }
  const root = new URL('../', import.meta.url).pathname;
  const files = sources(root).filter(f => !f.endsWith('/ui/dialogs.ts'));

  it('uses no window.confirm or window.alert outside the helper', () => {
    const offenders = files.filter(f => /window\.(confirm|alert)\(/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('awaits every confirmDialog', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const line of src.split('\n')) {
        if (/^\s*import\b/.test(line)) continue;
        if (/confirmDialog\(/.test(line) && !/await confirmDialog\(/.test(line)) offenders.push(`${f}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has at least the call sites that were converted', () => {
    let n = 0;
    for (const f of files) n += (readFileSync(f, 'utf8').match(/await confirmDialog\(/g) ?? []).length;
    expect(n).toBeGreaterThanOrEqual(24);
  });
});
