#!/usr/bin/env python3
"""Regenerate the dependency inventory in THIRD-PARTY-NOTICES.md.

WHY THIS EXISTS
---------------
PointCloudLabeler ships as an installed desktop application: one executable with
several hundred Rust crates and npm packages compiled or bundled into
it, plus one statically linked C library (SQLite) and an embedded coordinate
registry.

The MIT licence — which most of them use — says the copyright notice "shall be included in all copies or
substantial portions of the Software". BSD-3 and Apache-2.0 say the
same in more words, and BSD-3 says it outright: "Redistributions in
binary form must reproduce the above copyright notice ... in the
documentation and/or other materials provided with the distribution."

A compiled binary is a copy. The crates do not travel with it, so their
notices have to. THIRD-PARTY-NOTICES.md used to say the opposite — that
dependency licences "travel with the crates and packages themselves and
are not restated here" — which is true of a source checkout and false of
the thing users actually download.

WHAT IT DOES
------------
Reads the two lockfiles, resolves each package's SPDX expression and its
copyright lines from the vendored source, and rewrites the generated
section of THIRD-PARTY-NOTICES.md between the two marker comments. The
hand-written sections (fonts, SQLite, EPSG — the embedded assets
whose full licence text is reproduced) are left untouched.

Offline: every input is already on disk in ~/.cargo/registry and
node_modules. Run it after changing a dependency:

    python3 scripts/gen-third-party-notices.py

`src/testing/notices.test.ts` fails if the file drifts from the
lockfiles, so a forgotten regeneration is a failing test rather than a
licence violation shipped to users.
"""

import json
import os
import re
import sys
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTICES = os.path.join(ROOT, 'THIRD-PARTY-NOTICES.md')
BEGIN = '<!-- BEGIN GENERATED DEPENDENCY INVENTORY -->'
END = '<!-- END GENERATED DEPENDENCY INVENTORY -->'

CARGO_REGISTRY = os.path.expanduser(
    '~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f')

COPYRIGHT = re.compile(r'^\s*(?:#|//|\*|;)?\s*(Copyright\b.*)$', re.M | re.I)


def copyright_lines(directory):
    """The `Copyright ...` lines from a package's own licence files.

    Attribution is a name, not a licence class: "MIT" identifies the
    terms, and the copyright line identifies who is owed the credit
    those terms require. Deduplicated and capped — a few packages carry
    a vendored dependency's entire licence folder.
    """
    if not directory or not os.path.isdir(directory):
        return []
    found = []
    for name in sorted(os.listdir(directory)):
        if not re.match(r'(LICEN[CS]E|COPYING|NOTICE)', name, re.I):
            continue
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        try:
            text = open(path, encoding='utf-8', errors='replace').read()
        except OSError:
            continue
        for m in COPYRIGHT.finditer(text):
            line = ' '.join(m.group(1).split())
            # The Apache-2.0 appendix boilerplate is a template, not an
            # attribution — recording it would credit "[name of
            # copyright owner]" to a real person's work.
            if '[yyyy]' in line or 'name of copyright owner' in line:
                continue
            if line not in found:
                found.append(line)
    return found[:4]


def rust_packages():
    lock = open(os.path.join(ROOT, 'src-tauri', 'Cargo.lock'),
                encoding='utf-8').read()
    pairs = re.findall(
        r'\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"', lock)
    out = []
    for name, version in pairs:
        if name == 'pointcloudlabeler-editor':
            continue
        directory = os.path.join(CARGO_REGISTRY, f'{name}-{version}')
        spdx = 'not built on this platform'
        manifest = os.path.join(directory, 'Cargo.toml')
        if os.path.exists(manifest):
            text = open(manifest, encoding='utf-8', errors='replace').read()
            m = re.search(r'^license\s*=\s*"([^"]+)"', text, re.M)
            f = re.search(r'^license-file\s*=\s*"([^"]+)"', text, re.M)
            if m:
                spdx = m.group(1)
            elif f:
                spdx = f'see {f.group(1)} in the crate'
            else:
                spdx = 'UNSTATED'
        out.append((name, version, spdx, copyright_lines(directory)))
    return sorted(out)


def npm_packages():
    lock = json.load(open(os.path.join(ROOT, 'package-lock.json'),
                          encoding='utf-8'))
    out = []
    for path, meta in lock.get('packages', {}).items():
        if not path.startswith('node_modules/') or meta.get('dev'):
            continue
        name = path.split('node_modules/')[-1]
        directory = os.path.join(ROOT, path)
        spdx = meta.get('license')
        if not spdx:
            manifest = os.path.join(directory, 'package.json')
            if os.path.exists(manifest):
                try:
                    d = json.load(open(manifest, encoding='utf-8'))
                    spdx = d.get('license')
                    if not spdx and isinstance(d.get('licenses'), list) and d['licenses']:
                        spdx = d['licenses'][0].get('type')
                except (OSError, ValueError):
                    spdx = None
        # A package with no SPDX field may still ship a licence file —
        # webgl-constants does, and it is MIT. Look before recording an
        # unknown, because "UNSTATED" in a notices file is a thing
        # somebody has to go and resolve by hand.
        if not spdx and copyright_lines(directory):
            spdx = 'see the LICENSE file in the package'
        out.append((name, meta.get('version', '?'), spdx or 'UNSTATED',
                    copyright_lines(directory)))
    return sorted(out)


def render(title, packages):
    lines = [f'### {title} ({len(packages)})', '']
    hist = Counter(p[2] for p in packages)
    lines.append('Licence expressions in use, by package count:')
    lines.append('')
    for spdx, n in sorted(hist.items(), key=lambda kv: (-kv[1], kv[0])):
        lines.append(f'  * {n} × `{spdx}`')
    lines.append('')
    lines.append('| Package | Version | Licence | Copyright |')
    lines.append('| --- | --- | --- | --- |')
    for name, version, spdx, holders in packages:
        who = '<br>'.join(h.replace('|', r'\|') for h in holders) or '—'
        lines.append(f'| `{name}` | {version} | {spdx} | {who} |')
    lines.append('')
    return lines


def main():
    rust = rust_packages()
    npm = npm_packages()

    body = [BEGIN, '']
    body.append('<!-- Generated by scripts/gen-third-party-notices.py.')
    body.append('     Do not edit by hand: run the script instead, and see')
    body.append('     src/testing/notices.test.ts, which fails when this')
    body.append('     section no longer matches the lockfiles. -->')
    body.append('')
    body += render('Rust crates', rust)
    # Only explain the marker when some row carries it. Generated on a
    # machine that has fetched every target's crates (`cargo fetch`
    # without --target does), nothing is marked, and the paragraph then
    # explains rows the reader cannot find — in the one file in this
    # repository whose whole point is not overstating what it knows.
    if any(p[2] == 'not built on this platform' for p in rust):
        body.append(
            'Crates marked *not built on this platform* are in `Cargo.lock` '
            'for a target this file was not generated on — the macOS '
            '(`core-graphics`, `objc2`, `dispatch2`), Windows, Android and '
            'wasm backends Tauri carries, plus the build-only `bindgen` / '
            '`clang-sys` behind the off-by-default `rdblib` feature. They '
            'are not in the binary this file ships beside. Cargo only '
            'fetches what the target needs, so regenerating on each release '
            "platform resolves that platform's own set; `notices.test.ts` "
            'checks that every lockfile package is listed either way, so '
            'none can go missing quietly.')
    body.append('')
    body += render('npm packages (production dependency closure)', npm)
    body.append(END)

    text = open(NOTICES, encoding='utf-8').read()
    if BEGIN not in text or END not in text:
        print(f'{NOTICES} has no generated section markers', file=sys.stderr)
        return 1
    head = text.split(BEGIN)[0]
    tail = text.split(END)[1]
    open(NOTICES, 'w', encoding='utf-8').write(head + '\n'.join(body) + tail)

    unstated = [p for p in rust + npm if p[2] in ('UNSTATED', 'not built on this platform')]
    print(f'{len(rust)} Rust crates, {len(npm)} npm packages')
    if unstated:
        print(f'{len(unstated)} unresolved:')
        for name, version, spdx, _ in unstated[:20]:
            print(f'   {name} {version}: {spdx}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
