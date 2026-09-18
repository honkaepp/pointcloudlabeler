import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** PointCloudLabeler is a desktop application for people working in a forest. It has
 *  to start and run with no network at all, and it must not call a third
 *  party on any launch from an application whose users are in the EU.
 *
 *  It did both: `index.html` carried a Google Fonts stylesheet and
 *  `globals.css` an `@import` of the same, so every start fetched
 *  fonts.googleapis.com before first paint — a render-blocking request
 *  that cannot succeed in the field, and then falls back to a different
 *  typeface anyway. Verified in a headless production build: one
 *  off-origin request, one failed request, one console error before;
 *  none of the three after.
 *
 *  These scan the SHIPPING html and css. NOTHING in PointCloudLabeler is
 *  allowed to reach the network: the auto-updater and the startup
 *  version check that each used to be the exception here are both
 *  gone, and persistence/noNetwork.test.ts holds the rule for the
 *  application code the way this file holds it for the document. */

const ROOT = new URL('../..', import.meta.url).pathname;

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

describe('the shipped app fetches nothing at boot', () => {
  it('has no remote stylesheet, font or script in index.html', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    const remote = [...html.matchAll(/(?:href|src)\s*=\s*["'](https?:)?\/\/[^"']+/gi)]
      .map(m => m[0]);
    expect(remote, `index.html reaches out to: ${remote.join(', ')}`).toEqual([]);
    // preconnect/dns-prefetch are the tell that something used to.
    expect(html).not.toMatch(/rel\s*=\s*["'](preconnect|dns-prefetch)/i);
  });

  it('has no remote @import or url() in any stylesheet', () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'src'), '.css')) {
      const css = readFileSync(file, 'utf8');
      // Strip comments first: this file's own explanation names the host
      // it removed, and a scan that read comments would find it there.
      const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of code.matchAll(/@import\s+url\(\s*["']?(https?:)?\/\//gi)) {
        offenders.push(`${file}: ${m[0]}`);
      }
      for (const m of code.matchAll(/url\(\s*["']?(https?:)?\/\/[^)]+/gi)) {
        offenders.push(`${file}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(offenders, `stylesheets reach out to: ${offenders.join(' | ')}`).toEqual([]);
  });

  it('bundles the typefaces it is designed in', () => {
    const css = readFileSync(join(ROOT, 'src/styles/globals.css'), 'utf8');
    // Both families, self-hosted, at every weight the interface uses —
    // and the WHOLE family, every subset. PointCloudLabeler ships worldwide, and a
    // project or species name can be written in any alphabet these
    // families cover; a latin-only build renders it in a fallback face.
    for (const family of ['inter', 'jetbrains-mono']) {
      for (const weight of [400, 500, 600]) {
        expect(css, `${family} ${weight} is not bundled`)
          .toContain(`@fontsource/${family}/${weight}.css`);
      }
      expect(css, `${family} is bundled latin-only, which PointCloudLabeler is not`)
        .not.toContain(`@fontsource/${family}/latin-`);
    }
    // And the fallback stack is real, so a missing face degrades to
    // something rather than to the webview's serif default.
    expect(css).toMatch(/font-family:\s*'Inter',\s*system-ui/);
  });

  it('reproduces the licences of what it bundles', () => {
    const notices = readFileSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8');
    // SIL OFL 1.1 requires the licence to travel with the fonts.
    expect(notices).toContain('Inter');
    expect(notices).toContain('JetBrains Mono');
    expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(notices.length).toBeGreaterThan(4000);
  });
});
