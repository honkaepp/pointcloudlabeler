import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The Content-Security-Policy the shipped window runs under.
 *
 *  WHY THIS IS PINNED
 *  ------------------
 *  It was `null`, which is Tauri's "send no policy at all". That is a
 *  defensible default for an app that loads nothing but its own bundle,
 *  right up until you ask what a renderer could do if something ever
 *  did run in it — and here the answer was: read any file the user can
 *  read, write any file the user can write, run arbitrary SQL, and
 *  `fetch` the results anywhere. The file commands are scoped now (see
 *  src-tauri/src/fsgrant.rs) and the SQL bridge is gone, but the reason
 *  a policy is wanted is that those were reachable at all: it is the
 *  layer that holds when a specific mitigation is missed, or when the
 *  next dependency of ~180 turns hostile.
 *
 *  Verified in headless Chromium against the real production bundle,
 *  not asserted from theory. With this policy served as a header:
 *  exfiltration by `fetch` — blocked; by image beacon — blocked;
 *  a remote `<script>` — blocked; an inline `<script>`, which is what
 *  an XSS payload is — blocked; a `javascript:` URL — blocked; and zero
 *  requests reached the listener standing in for an attacker. The app
 *  itself rendered with no violations and no console errors, and
 *  WebAssembly still instantiated, which laz-perf needs.
 *
 *  Two allowances are load-bearing and were both found by that run
 *  rather than reasoned out:
 *
 *    * `font-src data:` — Vite inlines the smaller font faces as data
 *      URIs, and `font-src 'self'` refused nine of them. The app still
 *      rendered, so nothing would have failed loudly; the interface
 *      would just have fallen back to a different typeface at some
 *      weights, which is the exact regression styles/offline.test.ts
 *      exists to prevent.
 *    * `script-src 'wasm-unsafe-eval'` — WebAssembly compilation, for
 *      laz-perf's LAZ decoder. It permits WASM and NOT `eval`, which is
 *      why it is this and not `'unsafe-eval'`. */
const CONF_PATH = new URL('../../src-tauri/tauri.conf.json', import.meta.url);

function csp(): string {
  const conf = JSON.parse(readFileSync(CONF_PATH, 'utf8'));
  const value = conf.app?.security?.csp;
  expect(typeof value, 'app.security.csp is not a policy string').toBe('string');
  return value as string;
}

/** The policy as directive → source list. */
function directives(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp().split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out.set(name.toLowerCase(), sources);
  }
  return out;
}

describe('the shipped window runs under a Content-Security-Policy', () => {
  it('has one at all', () => {
    expect(csp().length).toBeGreaterThan(20);
  });

  /** The directive that turns a renderer compromise from "reads your
   *  files" into "reads your files and can do nothing with them". */
  it('confines connect-src to itself and the Tauri IPC', () => {
    const sources = directives().get('connect-src');
    expect(sources, 'no connect-src — it would fall back to default-src').toBeDefined();
    for (const s of sources!) {
      expect(
        ["'self'", 'ipc:', 'http://ipc.localhost'],
        `connect-src allows ${s}, which is somewhere to send data`,
      ).toContain(s);
    }
  });

  it('allows no inline, eval or remote script', () => {
    const sources = directives().get('script-src');
    expect(sources).toBeDefined();
    // 'wasm-unsafe-eval' permits WebAssembly compilation and not eval;
    // 'unsafe-eval' and 'unsafe-inline' permit an XSS payload to run.
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain("'unsafe-eval'");
    for (const s of sources!) {
      expect(s.startsWith('http'), `script-src allows the remote origin ${s}`).toBe(false);
    }
    // laz-perf's decoder needs this and only this.
    expect(sources).toContain("'wasm-unsafe-eval'");
  });

  it('keeps the defaults that cost nothing', () => {
    const d = directives();
    expect(d.get('default-src')).toEqual(["'self'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'self'"]);
    expect(d.get('form-action')).toEqual(["'none'"]);
    expect(d.get('frame-src')).toEqual(["'none'"]);
  });

  /** The two allowances the browser run proved necessary. Pinned so a
   *  later tightening that looks obviously right has to reckon with
   *  what it was measured to break. */
  it('still permits the inlined fonts and WebAssembly the bundle needs', () => {
    const d = directives();
    expect(d.get('font-src'), 'Vite inlines small font faces as data URIs')
      .toContain('data:');
    expect(d.get('script-src')).toContain("'wasm-unsafe-eval'");
  });
});

/** The capability file is the other half of the same boundary: the CSP
 *  governs what the page may load, capabilities govern what it may ask
 *  the backend to do. */
describe('the renderer is granted no plugin it does not need', () => {
  it('grants neither the fs nor the dialog plugin', () => {
    const caps = JSON.parse(readFileSync(
      new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8'));
    const permissions: string[] = caps.permissions;
    // The dialogs are this application's own commands so the backend
    // learns which file the user chose (src-tauri/src/fsgrant.rs). A
    // renderer that could open its own dialog would leave the backend
    // unable to tell a chosen path from an invented one, and the fs
    // plugin would hand it a second way to the filesystem entirely.
    for (const p of permissions) {
      expect(p.startsWith('core:'), `${p} is not a core permission`).toBe(true);
    }
    expect(permissions).not.toContain('dialog:default');
    expect(permissions).not.toContain('fs:default');
  });
});
