import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './sourceScan';

/** PointCloudLabeler is published openly, and a licence that is stated in five
 *  places is a licence that can disagree with itself in five places.
 *
 *  Before this, it disagreed in all of them at once: there was no
 *  LICENSE file, `package.json` and `Cargo.toml` had no `license` field,
 *  the README badge said "License: TBD", CONTRIBUTING asked people to
 *  contribute under a licence that did not exist, and CITATION.cff
 *  carried a commented-out `# license: GPL-3.0-or-later` — a different
 *  answer from the one now shipped, sitting in the file a citation tool
 *  reads.
 *
 *  Code with no licence is "all rights reserved" by default: nobody may
 *  legally use, fork or contribute to it, however public the repository
 *  is. That is the state this checks PointCloudLabeler is never in again. */

const ROOT = new URL('../..', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** The packaging script's COMMENTS explain, at length, the licence
 *  obligations the script exists to satisfy — so a test that greps the
 *  raw file for `git archive` passes on a script where the only
 *  `git archive` is the word inside a comment.
 *
 *  That is not hypothetical: commenting the line out was tried as a
 *  mutation and the test did not notice. `sourceScan.ts` carries the
 *  same warning for TypeScript; this is the PowerShell half.
 *
 *  Not a parser — it tracks single and double quotes so a `#` inside a
 *  message string survives, and drops the rest. Block comments
 *  (`<# … #>`) are removed first. */
function ps1Code(text: string): string {
  return text
    .replace(/<#[\s\S]*?#>/g, '')
    .split('\n')
    .map(line => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") {
          quote = c;
        } else if (c === '#') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

const SOFTWARE_LICENCE = 'GPL-3.0-or-later';
const DOCS_LICENCE = 'CC BY 4.0';
const COPYRIGHT_HOLDER = 'Eppu Honkanen';

/** SHA-256 of the GPL-3.0 text as published by the Free Software
 *  Foundation, verified here against two independent copies that agree
 *  byte for byte: Debian's `/usr/share/common-licenses/GPL-3` and the
 *  `COPYING` shipped inside GNU automake — the FSF's own distribution
 *  of its own licence. */
const GPL3_SHA256 =
  '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986';

describe('the licence says one thing everywhere', () => {
  /** Apache-2.0 ends with an appendix you are meant to FILL IN, and the
   *  test that replaced this one checked the blanks had been filled.
   *  The GPL is the opposite: its own header says "changing it is not
   *  allowed", so the check is that the file has NOT been touched.
   *
   *  A hash is the honest way to express that. Any edit at all — a
   *  helpfully inserted copyright line, a wrapped paragraph, CRLF line
   *  endings from a Windows editor — fails this, which is what
   *  "verbatim" means. */
  it('ships the GPL-3.0 text exactly as the FSF publishes it', () => {
    const licence = readFileSync(join(ROOT, 'LICENSE'));
    expect(createHash('sha256').update(licence).digest('hex')).toBe(GPL3_SHA256);
  });

  /** Because LICENSE is verbatim, it names the FSF and not the author —
   *  so the copyright notice and the grant have to live somewhere else,
   *  and a GPL work with no such notice is a licence text with nothing
   *  attached to it. The FSF's own instructions put it in the README and
   *  in the source files. */
  it('states who holds the copyright and what they granted', () => {
    const readme = read('README.md');
    expect(readme).toContain(`Copyright (C) 2026 ${COPYRIGHT_HOLDER}`);
    // The four load-bearing sentences of the recommended notice: the
    // grant, the version, the no-warranty, and where to get the licence.
    expect(readme).toContain('This program is free software');
    expect(readme).toContain('either version 3 of the License, or');
    expect(readme).toContain('WITHOUT ANY WARRANTY');
    expect(readme).toContain('https://www.gnu.org/licenses/');
    // LICENSE cannot carry the holder, so nothing may claim it does.
    expect(read('LICENSE')).not.toContain(COPYRIGHT_HOLDER);
  });

  it('names the same licence in every manifest that states one', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.license).toBe(SOFTWARE_LICENCE);

    const cargo = read('src-tauri/Cargo.toml');
    expect(cargo).toMatch(new RegExp(`^license = "${SOFTWARE_LICENCE}"$`, 'm'));

    // CITATION.cff is what a citation tool and Zenodo read. Its
    // `license` key must be live, not a commented-out suggestion.
    const cff = read('CITATION.cff');
    expect(cff).toMatch(new RegExp(`^license: ${SOFTWARE_LICENCE}$`, 'm'));
    expect(cff).not.toMatch(/^#\s*license:/m);
  });

  it('leaves no file still saying the licence is undecided', () => {
    for (const file of ['README.md', 'CONTRIBUTING.md', 'CITATION.cff']) {
      const text = read(file);
      expect(text, `${file} still says the licence is pending`)
        .not.toMatch(/Licen[cs]e[^\n]*\bTBD\b/i);
      expect(text, `${file} still says the licence is pending`)
        .not.toMatch(/\bLicen[cs]e\b[^\n]*\bpending\b/i);
      expect(text, `${file} still promises a LICENSE that does not exist yet`)
        .not.toMatch(/once it lands|once the LICENSE file/i);
    }
    // And the README's badge is the first thing a visitor reads.
    expect(read('README.md')).toContain(`License-GPLv3`);
  });

  it('states the documentation licence separately and consistently', () => {
    expect(existsSync(join(ROOT, 'LICENSE-DOCS'))).toBe(true);
    const docs = read('LICENSE-DOCS');
    expect(docs).toContain(DOCS_LICENCE);
    expect(docs).toContain('creativecommons.org/licenses/by/4.0');
    // The split has to be legible, or it is just two licences in a
    // repository: the docs licence names the code licence and the code
    // licence's file is where the split is pointed at from.
    expect(docs).toContain(SOFTWARE_LICENCE);
    expect(read('README.md')).toContain('LICENSE-DOCS');
    expect(read('CONTRIBUTING.md')).toContain('LICENSE-DOCS');
  });

  /** Every document that SHIPS has to name the product that ships.
   *
   *  `LICENSE-DOCS` survived two renames describing an application that
   *  no longer existed, because the rename script walks files by
   *  extension and its extensionless special case named `LICENSE` and
   *  not the whole family. Six sentences of it — the two-licence split,
   *  what the GPL does not reach, the third-party carve-out — were
   *  about a product nobody could install, in a file installed beside
   *  the program.
   *
   *  The product name is read from the manifest rather than written
   *  here, so this keeps working through the next rename instead of
   *  becoming the same kind of stale claim it exists to catch. */
  it('names the current product in every document that ships with it', () => {
    const product = JSON.parse(read('src-tauri/tauri.conf.json')).productName as string;
    for (const doc of ['LICENSE-DOCS', 'THIRD-PARTY-NOTICES.md',
                       'scripts/README-template.txt', 'README.md']) {
      expect(read(doc), `${doc} never names the product it ships with`)
        .toContain(product);
    }
    // And the installer's own licence page points at the real file.
    expect(JSON.parse(read('src-tauri/tauri.conf.json')).bundle.licenseFile)
      .toContain('LICENSE');
  });
});

describe('the README describes directories that exist', () => {
  it('does not list a directory that is missing', () => {
    for (const m of read('README.md').matchAll(/^[├└]── ([\w.-]+)\/ /gm)) {
      expect(existsSync(join(ROOT, m[1])), `README lists ${m[1]}/ but it does not exist`).toBe(true);
    }
  });
});

/** Attribution has to be present in the SHIPPED PRODUCT, not only in
 *  the repository. A user who installs PointCloudLabeler and never opens GitHub
 *  should still be able to find out who wrote it and under what terms
 *  — and Apache-2.0 §4 requires the notice to travel with every copy.
 *
 *  Three surfaces carry it, and each is the only one some reader will
 *  ever see: the installer and the executable's properties page, the
 *  Help → About dialog, and the footer of the HTML report, which is the
 *  file that leaves the building and lands with a client. */
describe('the shipped product says who made it', () => {
  it('stamps the installer and the executable', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    expect(conf.bundle.publisher).toContain(COPYRIGHT_HOLDER);
    expect(conf.bundle.copyright).toContain(COPYRIGHT_HOLDER);
    expect(conf.bundle.copyright).toMatch(/\d{4}/);
    // The same licence the manifests and LICENSE state.
    expect(conf.bundle.copyright).toContain(SOFTWARE_LICENCE);
  });

  /** Under Apache-2.0 the About dialog was good manners. Under the GPL
   *  it is clause 5(d): an interactive work must carry "Appropriate
   *  Legal Notices", which §0 defines as a convenient and prominently
   *  visible feature displaying four specific things. Three of them
   *  were not there before this licence change, and none of them is
   *  the kind of omission anybody notices by using the program. */
  it('answers Help → About without opening a browser', () => {
    const menu = read('src-tauri/src/menu.rs');
    // Name and version come from the crate, so they cannot drift; the
    // copyright and licence are what must actually be there.
    expect(menu).toContain('CARGO_PKG_VERSION');
    expect(menu).toContain(COPYRIGHT_HOLDER);
    expect(menu).toContain(SOFTWARE_LICENCE);
    expect(menu).toContain('CARGO_PKG_REPOSITORY');
    // …and it points at the file that carries everything else.
    expect(menu).toContain('THIRD-PARTY-NOTICES.md');
  });

  it('displays the Appropriate Legal Notices GPL-3 §5(d) requires', () => {
    const menu = read('src-tauri/src/menu.rs');
    // (1) a copyright notice — asserted above, and again here because
    //     §0 lists it as one of the four.
    expect(menu).toMatch(/©\s*\d{4}\s+Eppu Honkanen/);
    // (2) that there is no warranty.
    expect(menu, 'the About dialog does not disclaim warranty')
      .toContain('ABSOLUTELY NO WARRANTY');
    // (3) that licensees may convey the work under this Licence.
    expect(menu, 'the About dialog does not say the user may redistribute')
      .toMatch(/welcome to redistribute/i);
    // (4) how to view a copy of the Licence. Both answers, because the
    //     offline one is the one that works in a forest.
    expect(menu, 'the About dialog does not say where to read the licence')
      .toContain('LICENSE');
    expect(menu).toContain('gnu.org/licenses/gpl-3.0');
  });

  it('signs the report a client keeps', () => {
    const gen = read('src/report/generate.ts');
    expect(gen).toContain(COPYRIGHT_HOLDER);
    expect(gen).toContain(SOFTWARE_LICENCE);
  });

  it('names the same holder everywhere a holder is named', () => {
    // One holder, stated identically wherever it is stated — a
    // copyright line that disagrees with the others is worse than
    // none, because it is a claim about who owns the work.
    expect(read('README.md')).toContain(`Copyright (C) 2026 ${COPYRIGHT_HOLDER}`);
    expect(read('LICENSE-DOCS')).toContain(COPYRIGHT_HOLDER);
    expect(read('CITATION.cff')).toContain('Honkanen');
    expect(JSON.parse(read('package.json')).author).toContain(COPYRIGHT_HOLDER);
    expect(read('src-tauri/Cargo.toml')).toContain(COPYRIGHT_HOLDER);
  });
});

/** The release package is what a user actually receives, and the
 *  licences have to be in it. GPL-3 section 4 requires this copy to
 *  carry the licence and the warranty disclaimer; the several hundred
 *  MIT / BSD-3 components require their notices to accompany it, and
 *  BSD-3 says so in as many words. None of that is satisfied
 *  by a file sitting in a repository the user never opens. */
describe('the release package carries the licences', () => {
  it('installs them alongside the program', () => {
    const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
    const resources = conf.bundle.resources ?? {};
    const shipped = Object.values(resources) as string[];
    for (const doc of ['LICENSE', 'LICENSE-DOCS', 'THIRD-PARTY-NOTICES.md']) {
      expect(shipped, `${doc} is not installed with the application`).toContain(doc);
      expect(existsSync(join(ROOT, doc)), `${doc} does not exist`).toBe(true);
    }
    // The installer's licence page shows the real licence.
    expect(conf.bundle.licenseFile).toContain('LICENSE');
  });

  it('ships the licence under both names, identical', () => {
    // GitHub recognises LICENSE; SoftwareX's template asks for a
    // Licence.txt and returns a submission without one. Two copies
    // that could drift would be worse than one, so they are checked
    // byte for byte.
    expect(existsSync(join(ROOT, 'LICENSE.txt')), 'LICENSE.txt is missing').toBe(true);
    expect(read('LICENSE.txt')).toBe(read('LICENSE'));
  });

  it('puts them in the zip too, where they can be read before installing', () => {
    const ps1 = ps1Code(read('scripts/package-release.ps1'));
    for (const doc of ['LICENSE', 'LICENSE-DOCS', 'THIRD-PARTY-NOTICES.md']) {
      expect(ps1, `the packaging script does not ship ${doc}`).toContain(doc);
    }
    // And it refuses to build a package that is missing one, rather
    // than shipping quietly without it.
    expect(ps1).toMatch(/Write-Error[^\n]*may not ship without it/);
  });

  /** The obligation Apache-2.0 did not have. Conveying a GPL binary
   *  without its Corresponding Source is not a documentation gap, it is
   *  the one thing the licence exists to prevent — and it is invisible
   *  from inside a repository where the source is obviously right
   *  there.
   *
   *  §6(a) — hand over the source with the binary — is the option with
   *  no ongoing obligation and no dependency on GitHub, this project or
   *  the author still being reachable in three years. So the packaging
   *  script produces it, and refuses to produce a package without it. */
  it('ships the Corresponding Source GPL-3 §6 requires', () => {
    // Each of these must match an INVOCATION — a line that starts with
    // PowerShell's call operator — and not the words appearing
    // somewhere in the file. Two weaker versions of this test were
    // written first and both passed on a script that had the archive
    // step commented out: the first because the explanatory comment
    // says "git archive", the second because the error message beneath
    // it does too. Comments are stripped below; strings are not, and
    // must not be, so the assertion has to be the narrow one.
    const ps1 = ps1Code(read('scripts/package-release.ps1'));
    expect(ps1, 'the release package contains no source archive')
      .toMatch(/^\s*&\s*git archive --format=zip/m);

    // Of the commit the BINARY was built from, not of HEAD. Archiving
    // HEAD and refusing a dirty tree looks equivalent and is not:
    // build, pull, package, and the tree is clean, the check passes,
    // and the archive is a different commit from the executable beside
    // it — the section 6 failure wearing the costume of compliance.
    expect(ps1, 'the packager archives HEAD rather than the built revision')
      .toMatch(/git archive[^\n]*\$revision\s*$/m);
    expect(ps1, 'the packager does not read the revision recorded at build time')
      .toContain('build-commit.txt');
    // …and build.rs must actually write it, or that file never exists.
    // Comments stripped: build.rs EXPLAINS this mechanism at length, so
    // a raw scan passes on a build.rs where only the explanation is
    // left. That is the third time in this session — `//` works for
    // Rust as well as TypeScript, which is why sourceScan owns it.
    const buildRs = stripComments(read('src-tauri/build.rs'));
    expect(buildRs, 'build.rs does not record the revision it compiled')
      .toContain('build-commit.txt');
    expect(buildRs).toContain('rev-parse');

    // A binary built from uncommitted work has no commit for its
    // source, and neither does one built outside a checkout. Both are
    // refusals, not warnings.
    //
    // Assert the CONDITIONS, not only the messages. Replacing the dirty
    // check with `if ($false)` leaves the Write-Error line sitting in a
    // branch nothing reaches, and a test that greps for the sentence
    // passes on a packager that ships a dirty build — the same mistake
    // as asserting a script "contains git archive" while the only such
    // text is an error message about it.
    expect(ps1, 'nothing refuses a binary built from a dirty tree')
      .toMatch(/if\s*\(\s*\$revision\s+-like\s+["']\*-dirty["']\s*\)/);
    expect(ps1, 'nothing refuses a binary built outside a checkout')
      .toMatch(/if\s*\(\s*\$revision\s+-eq\s+["']unknown["']\s*\)/);
    expect(ps1).toMatch(/Write-Error[^\n]*uncommitted changes/);
    expect(ps1).toMatch(/Write-Error[^\n]*outside a git checkout/);
    expect(buildRs, 'build.rs does not distinguish a dirty tree')
      .toContain('-dirty');
    // The stripper is load-bearing for both assertions above, so prove
    // it still removes a Rust comment and still keeps Rust code.
    expect(stripComments('// writes build-commit.txt when -dirty')).not.toContain('-dirty');
    expect(stripComments('/// doc\nlet x = "-dirty";')).toContain('-dirty');

    // The stripper is what makes those assertions mean anything, so
    // prove it still strips — and still does not strip a `#` that is
    // part of a message.
    expect(ps1Code('# & git archive --format=zip'))
      .not.toMatch(/^\s*&\s*git archive/m);
    expect(ps1Code('& git archive --format=zip  # ships the source'))
      .toMatch(/^\s*&\s*git archive --format=zip/m);
    expect(ps1Code('Write-Error "see #6"')).toContain('#6');
  });

  /** INSTALL.txt tells the reader the name of the source archive and
   *  the revision it was built from. Those are placeholders in the
   *  template and facts in the shipped file; a placeholder that reaches
   *  a user is a licence notice reading "@SOURCE_ARCHIVE@". */
  it('fills in what INSTALL.txt promises rather than shipping the template', () => {
    const template = read('scripts/README-template.txt');
    const ps1 = ps1Code(read('scripts/package-release.ps1'));
    const placeholders = [...template.matchAll(/@[A-Z_]+@/g)].map(m => m[0]);
    expect(placeholders.length, 'INSTALL.txt no longer names its source archive')
      .toBeGreaterThan(0);
    for (const p of new Set(placeholders)) {
      expect(ps1, `${p} is in the template but nothing fills it in`)
        .toContain(`Replace("${p}"`);
    }
    // …and the script checks its own work, because a renamed
    // placeholder would otherwise ship silently.
    expect(ps1).toMatch(/Write-Error[^\n]*unfilled placeholder/);
  });

  /** Renaming the product does not rename the GitHub repository, and
   *  the first rename rewrote every URL to a repository that did not
   *  exist — the README badge, the clone command, CITATION.cff's
   *  repository-code and the SoftwareX C2 field.
   *  Whatever slug is in use, it has to be the same one everywhere. */
  it('points every repository URL at one repository', () => {
    // OUR repository, under our owner. Third-party repositories are
    // cited legitimately — TreeQSM's upstream, for one — and this test
    // used to forbid them by counting every github.com URL, which made
    // attributing ported code fail a licence test. The rule is that
    // this project names itself consistently, not that no other project
    // may be named.
    const OWNER = 'honkaepp';
    const slugs = new Set<string>();
    for (const file of ['README.md', 'CITATION.cff',
                        'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json',
                        'scripts/README-template.txt']) {
      for (const m of read(file).matchAll(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:[/.]|\b)/g)) {
        if (m[1].toLowerCase() === OWNER) slugs.add(`${m[1]}/${m[2]}`);
      }
    }
    expect(slugs.size, `these files name more than one ${OWNER} repository: ${[...slugs].join(', ')}`)
      .toBe(1);
    // …and it must actually have found ours, or the assertion above is
    // satisfied by finding nothing at all.
    expect([...slugs][0]).toMatch(new RegExp(`^${OWNER}/`));
  });
});

/** Names this product has had, and the expansions that went with them.
 *
 *  A rename replaces the NAME. It does not replace the sentence that
 *  explains the name, and nothing looks for those: "Tree Resources
 *  Analytics & Cloud Editor" sat in the HTML report's methodology
 *  section through two complete renames, so a report handed to a client
 *  introduced PointCloudLabeler by TRACE's backronym — in the one file
 *  that leaves the building.
 *
 *  Retiring a name means retiring what it stood for. Add both here when
 *  the next one is retired. */
describe('no retired name or its expansion survives anywhere', () => {
  const RETIRED = [
    'TRACE', 'PEVIRA',
    'Tree Resources Analytics',
    'Point-cloud Editor, Volume, Inventory & Resource Analytics',
  ];

  it('is gone from every user-visible surface', () => {
    // EVERY shipping source file, plus the documents that travel with a
    // release — not a hand-picked list of surfaces.
    //
    // It was a hand-picked list, and it missed the welcome screen: the
    // first thing a user sees on opening the application still read
    // "Tree Resources Analytics · Cloud Editor", two names after TRACE.
    // A curated list of "the places that matter" always omits one, and
    // the omission is invisible precisely because the list looks
    // complete. Scan the tree instead.
    //
    // Source comments may discuss the history — that is what comments
    // are for — so TypeScript and Rust are read with them stripped.
    const SKIP = new Set(['node_modules', 'target', 'dist', 'build', '__pycache__']);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (SKIP.has(name) || name.startsWith('.')) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(tsx?|rs|html)$/.test(name) && !/\.test\.[jt]sx?$/.test(name)) files.push(p);
      }
    };
    walk(join(ROOT, 'src'));
    walk(join(ROOT, 'src-tauri/src'));
    const docs = ['index.html', 'src-tauri/tauri.conf.json',
                  'scripts/README-template.txt', 'README.md', 'LICENSE-DOCS',
                  'CITATION.cff', '.zenodo.json']
      .map(f => join(ROOT, f));

    const hits: string[] = [];
    for (const file of [...files, ...docs]) {
      const raw = readFileSync(file, 'utf8');
      const text = /\.(tsx?|rs)$/.test(file) ? stripComments(raw) : raw;
      for (const name of RETIRED) {
        if (text.includes(name)) hits.push(`${file.slice(ROOT.length)}: ${name}`);
      }
    }
    expect(hits, `a retired name is still shown to users:\n${hits.join('\n')}`)
      .toEqual([]);
  });

  it('would still notice — the list is not empty and the strings are real', () => {
    expect(RETIRED.length).toBeGreaterThan(2);
    // Guard against the list being quietly emptied or mangled into
    // something that matches nothing.
    expect(RETIRED).toContain('TRACE');
    for (const name of RETIRED) expect(name.length).toBeGreaterThan(3);
    // …and the scan has to be able to find one when it is there.
    const planted = `<p>Generated by X (${RETIRED[2]} & Cloud Editor).</p>`;
    expect(RETIRED.some(n => planted.includes(n))).toBe(true);
  });
});

/** What separates the build you use from the build you publish.
 *
 *  Under Apache-2.0 there was no difference: every build was
 *  distributable. GPL-3 introduced exactly one, and it is easy to miss
 *  because nothing about it is visible at compile time — the `rdblib`
 *  and `rivlib` features link RIEGL's proprietary, non-redistributable
 *  SDKs, so the combined work cannot satisfy §6 and cannot be conveyed
 *  at all. No source archive fixes it.
 *
 *  Building it stays legitimate; the GPL constrains conveying, not use.
 *  So the refusal belongs at the moment a package is made for somebody
 *  else, and that is the only place it exists. */
describe('a build that cannot be distributed is not packaged as a release', () => {
  it('records whether a proprietary feature was linked in', () => {
    const buildRs = stripComments(read('src-tauri/build.rs'));
    expect(buildRs, 'build.rs does not record proprietary features')
      .toContain('build-proprietary.txt');
    expect(buildRs, 'build.rs does not check the rdblib feature')
      .toMatch(/cfg!\(feature\s*=\s*"rdblib"\)/);
    expect(buildRs, 'build.rs does not check the rivlib feature')
      .toMatch(/cfg!\(feature\s*=\s*"rivlib"\)/);
  });

  /** The list in build.rs is what the packaging refusal reads, so a
   *  feature that links a non-redistributable library and is missing
   *  from it is a build the packager would happily ship. Rather than
   *  trust a hand-kept list, take the features from Cargo.toml and
   *  require each one to be either recorded there or named here as
   *  deliberately harmless. A new SDK feature then fails this test
   *  until someone decides which it is. */
  it('accounts for every Cargo feature', () => {
    /** Features that link nothing proprietary. Empty today; adding to
     *  it is a claim that the feature's dependencies may be
     *  redistributed under the GPL. */
    const HARMLESS = new Set<string>([]);
    const cargo = read('src-tauri/Cargo.toml');
    const block = cargo.split(/^\[features\]$/m)[1]?.split(/^\[/m)[0] ?? '';
    const features = [...block.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*\[/gm)]
      .map(m => m[1])
      .filter(name => name !== 'default');
    expect(features, 'no features parsed out of Cargo.toml — did the block move?')
      .not.toEqual([]);

    const buildRs = stripComments(read('src-tauri/build.rs'));
    const unaccounted = features.filter(
      name => !HARMLESS.has(name) && !buildRs.includes(`feature = "${name}"`),
    );
    expect(
      unaccounted,
      `Cargo features that build.rs never records as proprietary: ${unaccounted.join(', ')}. ` +
        'Either record them beside rdblib / rivlib, or add them to HARMLESS in this test.',
    ).toEqual([]);
  });

  it('refuses to package one', () => {
    const ps1 = ps1Code(read('scripts/package-release.ps1'));
    expect(ps1).toContain('build-proprietary.txt');
    // The condition, not the message — a Write-Error in an unreachable
    // branch has passed this file's tests twice already.
    expect(ps1, 'nothing refuses a build that linked a proprietary library')
      .toMatch(/if\s*\(\s*\$proprietary\s*\)/);
    expect(ps1).toMatch(/Write-Error[^\n]*proprietary/);
  });

  it('says so where a packager would look before building', () => {
    const cargo = read('src-tauri/Cargo.toml');
    // The feature is off by default, and the manifest has to say why
    // it matters rather than leaving it as a build flag like any other.
    expect(cargo).toMatch(/^default = \[\]$/m);
    expect(cargo, 'Cargo.toml does not warn that rdblib builds cannot be shipped')
      .toMatch(/MUST NOT BE DISTRIBUTED/);
  });

  /** Vendor names appear throughout the source because the importers
   *  are named after the formats they read. That is nominative use and
   *  it is fine, but a shipped notices file has to say so — and has to
   *  say that no vendor SDK is bundled, which is the question a
   *  reviewer or a lawyer actually asks. */
  it('states whose trademarks the format names are', () => {
    const notices = read('THIRD-PARTY-NOTICES.md');
    for (const vendor of ['RIEGL', 'FARO', 'Leica', 'Trimble']) {
      expect(notices, `${vendor} is named in the source but not in the notices`)
        .toContain(vendor);
    }
    expect(notices).toMatch(/not affiliated with, endorsed by or sponsored by/);
    expect(notices).toMatch(/No vendor SDK is bundled/);
  });

  /** "Reverse-engineered" described something this code does not do and
   *  reads worse than the truth: no RIEGL code, header or SDK is read
   *  or decompiled anywhere here. Wording in a public repository is
   *  not cosmetic when it is the
   *  sentence somebody quotes. */
  it('does not claim to reverse-engineer anything', () => {
    for (const file of ['src-tauri/src/commands/riegl_rdbx.rs',
                        'src-tauri/src/commands/riegl.rs']) {
      expect(read(file), `${file} still says it reverse-engineers a format`)
        .not.toMatch(/reverse[- ]engineered from/i);
    }
  });
});

/** A rename that replaced the product's old name as a SUBSTRING once
 *  welded the new name into ordinary English words, in exactly the
 *  files that travel with a manuscript, and nothing caught it: after
 *  the mangling there was no old name left for a leftover scan to find.
 *
 *  This is the other half of the fix: the product name welded to a
 *  lowercase letter is either that bug or a fixture named after the
 *  product, and both want a human.
 *
 *  (Scans the repository, not `src/` — the damage was in .md, .json and
 *  .rs as much as in TypeScript. Test files are excluded so this
 *  paragraph does not report itself, the trap `sourceScan.ts` exists
 *  for.) */
describe('the rename did not weld the product name into English words', () => {
  const SKIP = new Set(['node_modules', 'target', 'dist', 'build', '__pycache__']);
  const EXTS = /\.(rs|ts|tsx|js|jsx|md|json|html|css|toml|cff|ya?ml|py|ps1|txt)$/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name) || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (EXTS.test(name) && !/\.test\.[jt]sx?$/.test(name)) out.push(p);
    }
    return out;
  }

  /** The product name in lower case, taken from the crate rather than
   *  written out, so a future rename cannot leave this scan hunting for
   *  a name nothing is called any more. That is not hypothetical: the
   *  rename to this name rewrote the pattern below and left the
   *  examples that prove it works spelled in the OLD name, so the
   *  self-check passed on strings the scan could no longer match. */
  const NAME = (JSON.parse(read('package.json')).name as string)
    .replace(/-editor$/, '');

  /** Case-SENSITIVE, and that is the whole discrimination. The damage
   *  was always the all-lowercase name fused to lowercase letters,
   *  because that is what a substring replace does to running prose:
   *  `traceable` → `peviraable`. Identifiers spell it in camelCase or
   *  SCREAMING_SNAKE — `…LogoMark`, `…Cm`, `unmatched…`,
   *  `…_APP_IDENTIFIER` — and there the neighbouring character is a
   *  capital or an underscore, which is exactly the boundary a
   *  word-fusion does not have. Adding /i made this flag twenty-six
   *  perfectly good identifiers and nothing else. */
  const GLUED = new RegExp(`[a-z]${NAME}|${NAME}[a-z]`);

  it('leaves no word with the product name glued into it', () => {
    const hits: string[] = [];
    for (const file of walk(ROOT)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (GLUED.test(line)) {
          hits.push(`${file.slice(ROOT.length)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(hits, `the product name is welded into a longer word:\n${hits.join('\n')}`)
      .toEqual([]);
  });

  it('would notice if the damage came back', () => {
    // FIRST: that NAME is the product's name at all. Everything below
    // is built from NAME, so a NAME that matches nothing makes the scan
    // pass on every file while its own self-check stays perfectly
    // self-consistent — which is what happened when this was checked by
    // mutation, and is why the samples being derived is necessary but
    // not sufficient. tauri.conf.json is an independent statement of
    // the same fact.
    const product = JSON.parse(read('src-tauri/tauri.conf.json')).productName as string;
    expect(NAME, 'the scan is hunting for a name nothing is called')
      .toBe(product.toLowerCase());

    // A scan is worthless if its pattern stopped matching, and this one
    // narrowed twice while being written. Prove both directions.
    // Every sample is built from NAME, so the rename that breaks the
    // scan also breaks these — which is the only arrangement in which
    // they are worth having.
    const Cap = NAME[0].toUpperCase() + NAME.slice(1);
    for (const damaged of [`${NAME}able`, `back${NAME}s`, `${NAME}test_apply.gsb`,
                           `${NAME}ability`, `it ${NAME}s back to volume`]) {
      expect(GLUED.test(damaged), `the scan no longer catches ${damaged}`).toBe(true);
    }
    for (const ok of [`${NAME}-editor`, `${NAME}_editor_lib`, `fi.honkaepp.${NAME}`,
                      NAME.toUpperCase(), `${Cap}LogoMark`, `const ${NAME}Cm = 1`,
                      `unmatched${Cap}`, `${NAME.toUpperCase()}_APP_IDENTIFIER`]) {
      expect(GLUED.test(ok), `the scan now rejects the legitimate form ${ok}`).toBe(false);
    }
  });
});

/** A compiled binary is a copy, and the MIT licence most of PointCloudLabeler's
 *  dependencies use requires the copyright notice to travel with every
 *  copy. The crates do not travel with the .exe, so the notice has to.
 *
 *  This checks the file actually covers what is in the build — a
 *  notices file that silently falls behind the lockfile is worse than
 *  none, because it reads as a complete account and is not one. */
describe('the third-party notices cover what ships', () => {
  const notices = read('THIRD-PARTY-NOTICES.md');

  it('reproduces every embedded asset that requires a notice', () => {
    // The hand-written sections are exactly the assets embedded in the
    // binary and the two ported sources. A section for a library that is
    // not in the binary would overstate, which is the one thing this
    // file must not do; a missing one would understate.
    expect(notices.match(/^## .*$/gm)).toEqual([
      '## Inter',
      '## JetBrains Mono',
      '## SQLite',
      '## EPSG Geodetic Parameter Registry, via `epsg-index`',
      '## TreeQSM — ported source, not a dependency',
      '## treeiso — ported source, not a dependency',
      '## Vendor names and file formats',
    ]);
    // BSD-3 names the binary case outright, and the intro quotes it.
    expect(notices).toMatch(/Redistributions in\s+binary form must reproduce/);
    // SQLite is public domain and imposes nothing — recorded anyway,
    // because a notices file that omits what is in the binary is not a
    // complete account of it.
    expect(notices).toContain('SQLite');
    // The EPSG registry is compiled in with include_str!, and IOGP's
    // trademark and non-endorsement have to be stated.
    expect(notices).toContain('epsg-index');
    expect(notices).toContain('trademark of IOGP');
    // The typefaces are OFL-1.1, which requires the licence to travel
    // with the fonts.
    expect(notices).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(notices).toContain('Inter');
    expect(notices).toContain('JetBrains Mono');
    // …and the subset claim has to match what is actually bundled.
    // globals.css imports whole families; a notices file describing a
    // latin-only build would be describing a different product.
    expect(notices).not.toMatch(/woff2 \(latin/);
  });

  it('lists every package in both lockfiles', () => {
    const generated = notices.split('<!-- BEGIN GENERATED DEPENDENCY INVENTORY -->')[1];
    expect(generated, 'the generated inventory section is missing').toBeTruthy();

    const cargoLock = read('src-tauri/Cargo.lock');
    const crates = [...cargoLock.matchAll(/\[\[package\]\]\nname = "([^"]+)"/g)]
      .map(m => m[1])
      .filter(n => n !== 'pointcloudlabeler-editor');
    const missingCrates = [...new Set(crates)].filter(n => !generated.includes(`\`${n}\``));
    expect(
      missingCrates,
      `Cargo.lock crates absent from the notices — run scripts/gen-third-party-notices.py: ${missingCrates.join(', ')}`,
    ).toEqual([]);

    const lock = JSON.parse(read('package-lock.json'));
    const prod = Object.entries(lock.packages as Record<string, { dev?: boolean }>)
      .filter(([p, m]) => p.startsWith('node_modules/') && !m.dev)
      .map(([p]) => p.split('node_modules/').pop()!);
    const missingPkgs = [...new Set(prod)].filter(n => !generated.includes(`\`${n}\``));
    expect(
      missingPkgs,
      `production npm packages absent from the notices — run scripts/gen-third-party-notices.py: ${missingPkgs.join(', ')}`,
    ).toEqual([]);
  });

  it('leaves no dependency whose licence nobody resolved', () => {
    const generated = notices.split('<!-- BEGIN GENERATED DEPENDENCY INVENTORY -->')[1];
    // "UNSTATED" is the generator saying it could not find a licence at
    // all — a real thing somebody has to go and resolve, not a row to
    // ship. (Crates marked "not built on this platform" are a different
    // matter: they are in the lockfile for a target this file was not
    // generated on and are not in this binary. The row still exists, so
    // nothing goes missing quietly.)
    const rows = generated.split('\n').filter(l => l.includes('| UNSTATED |'));
    expect(rows, `dependencies with no resolvable licence:\n${rows.join('\n')}`).toEqual([]);
  });

  /** Licence compatibility runs ONE WAY, and the direction reversed
   *  when PointCloudLabeler moved from Apache-2.0 to GPL-3.
   *
   *  Under Apache-2.0 the danger was a copyleft dependency: any GPL
   *  crate in the tree and the combined work could not be conveyed
   *  under Apache at all. Under GPL-3 that danger is gone — a GPL
   *  dependency is simply the same licence — and Apache-2.0
   *  dependencies are fine too, because Apache-2.0 code may be taken
   *  INTO a GPL-3 work (the reverse was never true, which is why this
   *  relicensing was possible in the first place and would not be
   *  possible in the other direction).
   *
   *  What remains dangerous is the short list below: licences that
   *  cannot be combined with GPL-3 in either direction. Each is a
   *  specific, known incompatibility, named so that a failure explains
   *  itself rather than requiring somebody to remember why. */
  it('carries no dependency whose licence GPL-3 cannot be combined with', () => {
    const generated = notices.split('<!-- BEGIN GENERATED DEPENDENCY INVENTORY -->')[1];

    const INCOMPATIBLE: [RegExp, string][] = [
      [/\bGPL-2\.0(-only)?(?!-or-later)(?!\+)/,
       'GPL-2.0-only cannot be combined with GPL-3 — the versions are mutually exclusive unless the dependency says "or later"'],
      [/\bLGPL-2\.0(-only)?(?!-or-later)(?!\+)/,
       'LGPL-2.0-only predates the upgrade clause LGPL-2.1 has'],
      [/\bCDDL/, 'CDDL is a file-level copyleft with terms GPL-3 forbids adding'],
      [/\bEPL-/, 'the EPL imposes patent-retaliation and indemnity terms GPL-3 forbids adding'],
      [/\bMPL-1\.1/, 'MPL-1.1 is GPL-incompatible; MPL-2.0 fixed exactly this'],
      [/\bBSD-4-Clause/, 'the BSD advertising clause is a further restriction GPL-3 forbids'],
      [/\bOpenSSL\b|\bSSLeay\b/, 'the old OpenSSL licence carries an advertising clause'],
      [/\bSSPL/, 'SSPL is not a free software licence'],
      [/\bCC-BY-NC|\bCC-BY-ND|NonCommercial|NoDerivatives/,
       'a non-commercial or no-derivatives licence is not free software and cannot ship in this binary'],
      // AGPL is not incompatible — GPL-3 §13 exists precisely to permit
      // the combination — but it would extend §13's network-source
      // obligation to a desktop program that has no network service, so
      // it is a decision, not a dependency bump.
      [/\bAGPL/, 'AGPL is combinable via GPL-3 §13 but imposes network source obligations on the whole work — decide deliberately, do not absorb it'],
    ];

    // The licence column only. Copyright holders' names and licence
    // URLs live in other cells and must not be able to trip this.
    const licences = generated.split('\n')
      .filter(l => l.startsWith('| `'))
      .map(l => ({ row: l, licence: l.split('|')[3]?.trim() ?? '' }));
    expect(licences.length, 'the inventory table could not be parsed').toBeGreaterThan(100);

    const bad: string[] = [];
    for (const { row, licence } of licences) {
      for (const [pattern, why] of INCOMPATIBLE) {
        if (pattern.test(licence)) bad.push(`${row.split('|')[1].trim()} — ${licence}: ${why}`);
      }
    }
    expect(bad, `dependencies GPL-3 cannot cover:\n${bad.join('\n')}`).toEqual([]);
  });
});

/** The packaging script failed to parse on the release machine — at a
 *  Write-Host a hundred lines below the cause. The file has no
 *  byte-order mark, Windows PowerShell 5.1 reads such a file as ANSI,
 *  and an em dash inside a double-quoted string decodes to three
 *  cp1252 characters, the last a right double quotation mark that
 *  PowerShell takes for a closing quote. Comments may carry any
 *  character; the code may not. */
describe('the packaging script parses under Windows PowerShell 5.1', () => {
  it('keeps every string literal ASCII', () => {
    const code = ps1Code(read('scripts/package-release.ps1'));
    const offenders = code.split('\n')
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /[^\x00-\x7F]/.test(l));
    expect(offenders.map(o => `${o.n}: ${o.l.trim()}`), 'non-ASCII outside a comment').toEqual([]);
  });

  it('never calls a method on what Get-Content -Raw returned for an empty file', () => {
    // build.rs writes build-proprietary.txt EMPTY for a clean release
    // build; Get-Content -Raw hands back $null for an empty file, and
    // .Trim() on $null stopped the packager on the release machine.
    const ps1 = ps1Code(read('scripts/package-release.ps1'));
    expect(ps1, 'a method called straight on a Get-Content result').not.toMatch(/\(Get-Content [^)]*\)\.\w+\(/);
    expect(ps1).toMatch(/"\$\(Get-Content \$proprietaryFile -Raw\)"\.Trim\(\)/);
  });

  it('reads the install template as UTF-8, which is what it is', () => {
    const ps1 = ps1Code(read('scripts/package-release.ps1'));
    expect(ps1).toMatch(/Get-Content \$readme -Raw -Encoding UTF8/);
  });
});
