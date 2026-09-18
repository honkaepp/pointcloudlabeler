import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { describeHits, scanSources, walkSources } from '../testing/sourceScan';

/** PointCloudLabeler reaches the network NOWHERE, and that is a property of
 *  the program rather than a setting inside it.
 *
 *  Two things used to break it. The auto-updater downloaded a signed
 *  MSI and restarted the editor into it — removed because a scientific
 *  measurement tool must not change under its user mid-study, and
 *  because the private key that signed those downloads was a permanent
 *  liability for the life of every install. Then a startup version
 *  check asked GitHub for the newest release tag: it installed nothing,
 *  but it still called a third party on every launch of an application
 *  whose users are in the EU, and the preference that was supposed to
 *  refuse it had no interface — only a hand-written localStorage key.
 *
 *  Both are gone. What is left is worth having only if it stays gone,
 *  and "gone" is now the simplest possible rule: no egress API appears
 *  in shipping code at all, so there is no call site to audit, no
 *  endpoint to keep track of, and no default to get wrong. */
describe('the application has no network egress', () => {
  it('contains no egress API in shipping code', () => {
    // Each of these is the whole of some way out. `fetch(` rather than
    // `fetch` so `prefetch`/`refetchOnMount` and the like stay readable
    // names; the scan strips comments first, so this file's own account
    // of what it forbids cannot trip it.
    for (const api of [
      'fetch(', 'XMLHttpRequest', 'new WebSocket', 'EventSource',
      'sendBeacon', 'navigator.connection',
    ]) {
      const hits = scanSources('src', api);
      expect(hits, `${api} is back:\n${describeHits(hits)}`).toEqual([]);
    }
  });

  it('names no remote host in shipping code outside a link', () => {
    // NOT scanSources here, and that is the whole point: its
    // stripComments blanks a line from its first `//` onward, and
    // every URL contains one — so a scan for `https://` run through it
    // matches nothing, ever, and reports a clean bill of health it did
    // not check. (sourceScan.ts warns about exactly this trap; this
    // test fell into it on the first attempt.) So: raw source, and
    // whole-line comments filtered by their own shape instead.
    const offenders: string[] = [];
    for (const file of walkSources('src')) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
        // An href is a link offered to a person, not a request the
        // application makes; the citation links in the panels are that.
        if (/\bhref\s*=/.test(line)) return;
        const m = /['"`]https?:\/\/([^'"`\s)]+)/.exec(line);
        if (!m) return;
        // XML namespaces are identifiers, never dereferenced: the GPX
        // exporter writes its format's own, and the SVG overlays name
        // the SVG one for createElementNS.
        if (/^(www\.)?(topografix\.com|w3\.org)/.test(m[1])) return;
        offenders.push(`${file}:${i + 1}: ${t.slice(0, 90)}`);
      });
    }
    expect(offenders, `shipping code names a remote host:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('has no updater plugin left to install with', () => {
    for (const needle of ['plugin-updater', 'downloadAndInstall', 'tauri_plugin_updater']) {
      const hits = scanSources('src', needle);
      expect(hits, `${needle} is back:\n${describeHits(hits)}`).toEqual([]);
    }
  });

  it('declares no updater capability, plugin or signing key', () => {
    const conf = JSON.parse(
      readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
    expect(conf.plugins?.updater).toBeUndefined();
    // A public key with no updater is a leftover that reads like a
    // promise the app does not keep.
    expect(JSON.stringify(conf)).not.toContain('pubkey');
    expect(conf.bundle.createUpdaterArtifacts).toBeUndefined();

    const caps = readFileSync(
      new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8');
    expect(caps).not.toContain('updater');

    const cargo = readFileSync(
      new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8');
    expect(cargo).not.toContain('tauri-plugin-updater');

    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.dependencies)).not.toContain('@tauri-apps/plugin-updater');
  });

  /** The Rust half has no HTTP client either, and that is what keeps
   *  the rule above from being only half a rule: a command could fetch
   *  on the renderer's behalf and no frontend scan would see it. */
  it('links no HTTP client into the binary', () => {
    const cargo = readFileSync(
      new URL('../../src-tauri/Cargo.toml', import.meta.url), 'utf8');
    for (const crate of ['reqwest', 'ureq', 'hyper', 'isahc', 'attohttpc', 'curl']) {
      expect(cargo, `${crate} is a dependency`).not.toMatch(
        new RegExp(`^\\s*${crate}\\s*=`, 'm'));
    }
  });
});
