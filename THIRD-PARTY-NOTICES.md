# Third-party notices

PointCloudLabeler is licensed under the GNU General Public License, version 3 or
later (see `LICENSE`); its documentation is CC BY 4.0 (see
`LICENSE-DOCS`). Neither applies to the third-party work below, which
keeps its own licences.

Every component listed here is under a licence compatible with GPL-3.0,
which is a precondition for distributing the combined work at all and
not a matter of taste: `src/testing/notices.test.ts` fails the build if
one appears that is not. Compatibility here is one-directional —
Apache-2.0 code may be taken into a GPL-3 work but not the reverse —
so this is a claim about PointCloudLabeler being distributable, not a claim that
these components are under the GPL. They are not; each keeps the
licence recorded beside it.

PointCloudLabeler ships as an installed desktop application: one executable with
several hundred Rust crates and npm packages compiled or bundled into
it, one statically linked C library (SQLite), an embedded coordinate
registry and two typefaces.

**A compiled binary is a copy.** The MIT licence — which most of those
dependencies use — requires the copyright notice to be included "in all
copies or substantial portions of the Software"; Apache-2.0 says the
same at greater length, and BSD-3 says it outright: "Redistributions in
binary form must reproduce the above copyright notice ... in the
documentation and/or other materials provided with the distribution."
The crates do not travel with the executable, so their notices have to.
This file is how they travel.

It has two parts:

  * **Embedded assets**, below, whose full licence text is reproduced
    here because there is nothing else in the shipped product to read
    it from.
  * **A generated dependency inventory** at the end — every package,
    its version, its SPDX licence and its copyright holders — produced
    by `scripts/gen-third-party-notices.py` from the two lockfiles and
    the vendored sources. `src/testing/notices.test.ts` fails if it
    drifts from the lockfiles, so a forgotten regeneration is a failing
    test rather than a licence violation shipped to users.

---

## Inter

Bundled as woff2 — every subset the family ships, weights 400/500/600 —
in `dist/assets/`. PointCloudLabeler runs worldwide and a project, plot or species
name can be written in any alphabet these families cover; a latin-only
build renders it in a fallback face. Upstream: https://github.com/rsms/inter

```
Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

---

## JetBrains Mono

Bundled as woff2 — every subset the family ships, weights 400/500/600 —
in `dist/assets/`. PointCloudLabeler runs worldwide and a project, plot or species
name can be written in any alphabet these families cover; a latin-only
build renders it in a fallback face. Upstream: https://github.com/JetBrains/JetBrainsMono

```
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) JetBrainsMono-Italic[wght].ttf: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

---

## SQLite

Statically linked into the PointCloudLabeler executable, via `rusqlite`'s `bundled`
feature. PointCloudLabeler stores per-project state in a SQLite database.

SQLite is in the public domain and imposes no condition on
redistribution. It is recorded here because a notices file that omits
what is in the binary is not a complete account of it, whatever the
obligation:

```
The author disclaims copyright to this source code.  In place of
a legal notice, here is a blessing:

   May you do good and not evil.
   May you find forgiveness for yourself and forgive others.
   May you share freely, never taking more than you give.
```

---

## EPSG Geodetic Parameter Registry, via `epsg-index`

Embedded as `src-tauri/src/commands/epsg.tsv` (8017 coordinate
reference systems) and compiled into the executable with
`include_str!`. It is what lets PointCloudLabeler resolve any EPSG code a file
declares, anywhere in the world, with no network and no PROJ
installation.

Derived from the **epsg-index** dataset, an ISC-licensed packaging of
the registry:

```
ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

The registry itself is maintained by IOGP (the International
Association of Oil & Gas Producers). **PointCloudLabeler does not redistribute the
EPSG Geodetic Parameter Registry itself, is not endorsed by or
affiliated with IOGP or the epsg-index maintainers, and "EPSG" is a
trademark of IOGP.**

PointCloudLabeler's copy is not verbatim: every `+k_0=` in the source data has been
rewritten to `+k=`, because proj4rs silently ignores `+k_0=` and falls
back to a scale factor of 1.0 with no error — measured as an 8.1 km
mislocation for one real affected CRS, across 285 affected entries. See
`src-tauri/src/commands/crs.rs` for the full account, and
`embedded_epsg_table_has_no_k_0_param`, which fails the build if a
regeneration ever ships that error again.

## TreeQSM — ported source, not a dependency

`src-tauri/src/commands/treeqsm.rs` contains code **ported from
TreeQSM**, the reference implementation of the quantitative structure
model this software fits to every tree.

```
TreeQSM Version 2.4.0
Copyright (C) 2013-2022 Pasi Raumonen
Tampere University

TreeQSM is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the
Free Software Foundation, either version 3 of the License, or (at your
option) any later version.

TreeQSM is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
for more details.
```

Upstream: https://github.com/InverseTampere/TreeQSM

The method is published as Raumonen, P., Kaasalainen, M., Åkerblom, M.,
Kaasalainen, S., Kaartinen, H., Vastaranta, M., Holopainen, M.,
Disney, M. & Lewis, P. (2013), *Fast Automatic Precision Tree Models
from Terrestrial Laser Scanner Data*, Remote Sensing 5(2):491–520.

**This is a different kind of entry from everything else in this file.**
The other components are dependencies: separate works, fetched from
their own registries, keeping their own licences. TreeQSM's code is
*inside* PointCloudLabeler's own source, translated to Rust, so the
result is a derivative work of it. Pasi Raumonen's copyright travels
with those functions and is noted on them where they appear.

That combination is possible because both works are under the same
licence. **Under this project's previous Apache-2.0 licence it would
not have been**: GPL-3 code cannot be taken into an Apache-2.0 work,
and the port would have been a licence violation rather than a port.

---

## treeiso — ported source, not a dependency

`src-tauri/src/commands/treeiso.rs` contains code **ported from treeiso**,
the reference implementation of the individual-tree isolation cascade this
software runs on dense terrestrial clouds. All three of its stages follow
that code, down to the parameter names and defaults.

```
MIT License

Copyright (c) 2022 Zhouxin Xi
Copyright (c) 2018 Loic Landrieu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Upstream: https://github.com/truebelief/artemis_treeiso — which carries the
second copyright above because it bundles Loic Landrieu's cut-pursuit
(https://github.com/loicland/cut-pursuit) as the optimiser its first two
stages call. Our ℓ0 optimiser in `src-tauri/src/commands/cutpursuit.rs` is
an independent implementation of the published algorithm rather than a port
of that C++, and its header says where the two differ; the notice is
reproduced whole because the licence file it comes from covers both.

The method is published as Xi, Z. & Hopkinson, C. (2022), *3D Graph-Based
Individual-Tree Isolation (Treeiso) from Terrestrial Laser Scanning Point
Clouds*, Remote Sensing 14(23):6116, and the optimiser as Landrieu, L. &
Obozinski, G. (2017), *Cut Pursuit: Fast Algorithms to Learn Piecewise
Constant Functions on General Weighted Graphs*, SIAM Journal on Imaging
Sciences 10(4):1724–1766.

Like the TreeQSM entry above and unlike everything else in this file, this
is not a dependency: the code is inside PointCloudLabeler's own source,
translated to Rust. MIT code may be taken into a GPL-3 work provided the
notice above travels with it, which is what this section is for. The
direction matters — it does not run the other way.

---

## Vendor names and file formats

PointCloudLabeler reads point-cloud formats produced by other people's
instruments and software, and names them so a user can tell what it
opens.

RIEGL, RiSCAN PRO, RiPROCESS, RDB and RXP are trademarks of RIEGL Laser
Measurement Systems GmbH. FARO is a trademark of FARO Technologies.
Leica and Cyclone are trademarks of Leica Geosystems / Hexagon. Trimble
is a trademark of Trimble Inc. NavVis, Emesent, XGRIDS and GreenValley
are trademarks of their respective owners. E57 is an ASTM standard
(ASTM E2807); LAS and LAZ are specified by ASPRS and by Hobu's LASzip
respectively.

**PointCloudLabeler is not affiliated with, endorsed by or sponsored by
any of them.** Those names appear here and in the source only to say
which formats are supported — nominative use, and the only accurate way
to describe an importer.

No vendor SDK is bundled, redistributed or required. Every format the
default build reads is read through published specifications and
open-source libraries: E57 through the `e57` crate, LAS/LAZ through
`las`/`laz`. RIEGL's own point formats — `.rdbx` (RDB 2) and `.rxp` —
are read by no default build: each needs RIEGL's own library, and the
route into PointCloudLabeler is RiSCAN PRO's export to E57 or LAS. No
RIEGL code is read, decompiled or shipped.

Two optional build features link RIEGL's proprietary SDKs and are off
by default: `rdblib` (RIEGL's `.rdbx` SDK — the only reader of RDB 2
there is) and `rivlib` (`.rxp`, RIEGL's
closed streaming format — the only way to read what a scanner writes to
its own `.PROJ` project, and the SDK is the only reader there is).
**A binary built with either cannot be distributed under the GPL** — the
SDKs are non-redistributable, so §6's Corresponding Source is impossible
for the combined work. Building one for your own use is unaffected; the
packaging script refuses to make a release from it.

---

---

<!-- BEGIN GENERATED DEPENDENCY INVENTORY -->

<!-- Generated by scripts/gen-third-party-notices.py.
     Do not edit by hand: run the script instead, and see
     src/testing/notices.test.ts, which fails when this
     section no longer matches the lockfiles. -->

### Rust crates (499)

Licence expressions in use, by package count:

  * 237 × `MIT OR Apache-2.0`
  * 109 × `MIT`
  * 33 × `Apache-2.0 OR MIT`
  * 26 × `MIT/Apache-2.0`
  * 18 × `Unicode-3.0`
  * 17 × `Zlib OR Apache-2.0 OR MIT`
  * 15 × `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`
  * 5 × `Apache-2.0/MIT`
  * 5 × `MPL-2.0`
  * 4 × `Apache-2.0`
  * 4 × `Unlicense OR MIT`
  * 3 × `BSD-3-Clause`
  * 2 × `BSD-2-Clause OR Apache-2.0 OR MIT`
  * 2 × `BSD-3-Clause OR MIT OR Apache-2.0`
  * 2 × `ISC`
  * 2 × `MIT OR Apache-2.0 OR LGPL-2.1-or-later`
  * 2 × `MIT OR Apache-2.0 OR Zlib`
  * 2 × `Unlicense/MIT`
  * 2 × `Zlib`
  * 1 × `(MIT OR Apache-2.0) AND Unicode-3.0`
  * 1 × `0BSD OR MIT OR Apache-2.0`
  * 1 × `Apache-2.0 / MIT`
  * 1 × `Apache-2.0 AND MIT`
  * 1 × `Apache-2.0 WITH LLVM-exception`
  * 1 × `BSD-3-Clause AND MIT`
  * 1 × `BSD-3-Clause/MIT`
  * 1 × `CC0-1.0 OR MIT-0 OR Apache-2.0`
  * 1 × `MIT OR Zlib OR Apache-2.0`

| Package | Version | Licence | Copyright |
| --- | --- | --- | --- |
| `adler2` | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | Copyright (C) Jonas Schievink <jonasschievink@gmail.com><br>copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `ahash` | 0.8.12 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018 Tom Kaitchuck |
| `aho-corasick` | 1.1.4 | Unlicense OR MIT | Copyright (c) 2015 Andrew Gallant |
| `alloc-no-stdlib` | 2.0.4 | BSD-3-Clause | Copyright (c) 2016 Dropbox, Inc. |
| `alloc-stdlib` | 0.2.2 | BSD-3-Clause | — |
| `android_system_properties` | 0.1.5 | MIT/Apache-2.0 | Copyright 2016 Nicolas Silva<br>Copyright (c) 2013 Nicolas Silva<br>COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| `anyhow` | 1.0.104 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `atk` | 0.18.2 | MIT | — |
| `atk-sys` | 0.18.2 | MIT | — |
| `atomic-waker` | 1.1.2 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Alex Crichton<br>Copyright (c) 2017 The Tokio Authors |
| `autocfg` | 1.5.0 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018 Josh Stone |
| `base64` | 0.21.7 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 Alice Maz |
| `base64` | 0.22.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 Alice Maz |
| `base64` | 0.23.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2025 Alice Maz, Marshall Pierce |
| `bindgen` | 0.69.5 | BSD-3-Clause | Copyright (c) 2013, Jyun-Yan You |
| `bit-set` | 0.8.0 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2023 The Rust Project Developers |
| `bit-vec` | 0.8.0 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2023 The Rust Project Developers |
| `bitflags` | 1.3.2 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The Rust Project Developers |
| `bitflags` | 2.11.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The Rust Project Developers |
| `block-buffer` | 0.10.4 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018-2019 The RustCrypto Project Developers |
| `block2` | 0.6.2 | MIT | — |
| `brotli` | 8.0.2 | BSD-3-Clause AND MIT | Copyright (c) 2009, 2010, 2013-2016 by the Brotli Authors. |
| `brotli-decompressor` | 5.0.0 | BSD-3-Clause/MIT | Copyright (c) 2016 Dropbox, Inc. |
| `bs58` | 0.5.1 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 The roaring-rs developers. |
| `bumpalo` | 3.20.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2019 Nick Fitzgerald |
| `bytemuck` | 1.25.0 | Zlib OR Apache-2.0 OR MIT | Copyright (c) 2019 Daniel "Lokathor" Gee. |
| `byteorder` | 1.5.0 | Unlicense OR MIT | Copyright (c) 2015 Andrew Gallant |
| `bytes` | 1.11.1 | MIT | Copyright (c) 2018 Carl Lerche |
| `cairo-rs` | 0.18.5 | MIT | — |
| `cairo-sys-rs` | 0.18.2 | MIT | — |
| `camino` | 1.2.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `cargo-platform` | 0.1.9 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `cargo_metadata` | 0.19.2 | MIT | — |
| `cargo_toml` | 0.22.3 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `cc` | 1.2.62 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `cesu8` | 1.1.0 | Apache-2.0/MIT | — |
| `cexpr` | 0.6.0 | Apache-2.0/MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `cfb` | 0.7.3 | MIT | Copyright (c) 2017 Matthew D. Steele |
| `cfg-expr` | 0.15.8 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2019 Embark Studios |
| `cfg-if` | 1.0.4 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `chrono` | 0.4.44 | MIT OR Apache-2.0 | Copyright (c) 2014, Kang Seonghoon.<br>copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `clang-sys` | 1.8.1 | Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `combine` | 4.6.7 | MIT | Copyright (c) 2015 Markus Westerlind |
| `console_log` | 1.1.0 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018 Matthew Nicholson |
| `cookie` | 0.18.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2017 Sergio Benitez<br>Copyright 2014 Alex Chricton |
| `core-foundation` | 0.10.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2012-2013 Mozilla Foundation |
| `core-foundation-sys` | 0.8.7 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2012-2013 Mozilla Foundation |
| `core-graphics` | 0.25.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2012-2013 Mozilla Foundation |
| `core-graphics-types` | 0.2.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2012-2013 Mozilla Foundation |
| `cpufeatures` | 0.2.17 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2020-2025 The RustCrypto Project Developers |
| `crc32fast` | 1.5.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018 Sam Rijs, Alex Crichton and contributors |
| `crossbeam-channel` | 0.5.15 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2019 The Crossbeam Project Developers<br>COPYRIGHT AND/OR OTHER APPLICABLE LAW. ANY USE OF THE WORK OTHER THAN AS |
| `crossbeam-deque` | 0.8.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2019 The Crossbeam Project Developers |
| `crossbeam-epoch` | 0.9.21 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2019 The Crossbeam Project Developers |
| `crossbeam-utils` | 0.8.21 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2019 The Crossbeam Project Developers |
| `crypto-common` | 0.1.7 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2021 RustCrypto Developers |
| `cssparser` | 0.36.0 | MPL-2.0 | — |
| `cssparser-macros` | 0.6.1 | MPL-2.0 | — |
| `ctor` | 0.8.0 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `ctor-proc-macro` | 0.0.7 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `darling` | 0.23.0 | MIT | Copyright (c) 2017 Ted Driggs |
| `darling_core` | 0.23.0 | MIT | Copyright (c) 2017 Ted Driggs |
| `darling_macro` | 0.23.0 | MIT | Copyright (c) 2017 Ted Driggs |
| `dbus` | 0.9.11 | Apache-2.0/MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2014-2018 David Henningsson <diwic@ubuntu.com> and other contributors<br>Copyright (c) 2014-2018 David Henningsson <diwic@ubuntu.com> and other contributors |
| `deranged` | 0.5.8 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2024 Jacob Pratt et al.<br>Copyright (c) 2024 Jacob Pratt et al. |
| `derive_more` | 2.1.1 | MIT | Copyright (c) 2016 Jelte Fennema |
| `derive_more-impl` | 2.1.1 | MIT | Copyright (c) 2016 Jelte Fennema |
| `digest` | 0.10.7 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 Artyom Pavlov |
| `dirs` | 5.0.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018-2019 dirs-rs contributors |
| `dirs` | 6.0.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018-2019 dirs-rs contributors |
| `dirs-sys` | 0.4.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018-2019 dirs-rs contributors |
| `dirs-sys` | 0.5.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018-2019 dirs-rs contributors |
| `dispatch2` | 0.3.1 | Zlib OR Apache-2.0 OR MIT | — |
| `displaydoc` | 0.2.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `dlopen2` | 0.8.2 | MIT | — |
| `dlopen2_derive` | 0.4.3 | MIT | — |
| `dom_query` | 0.27.0 | MIT | Copyright (c) 2023 Mykola Humanov |
| `dpi` | 0.1.2 | Apache-2.0 AND MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018 Jorge Aparicio<br>copyright: |
| `dtoa` | 1.0.11 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `dtoa-short` | 0.3.5 | MPL-2.0 | — |
| `dtor` | 0.3.0 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `dtor-proc-macro` | 0.0.6 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `dunce` | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | — |
| `dyn-clone` | 1.0.20 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `e57` | 0.11.12 | MIT | Copyright (c) 2023 cry-inc |
| `either` | 1.16.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 |
| `embed-resource` | 3.0.9 | MIT | Copyright (c) 2017 nabijaczleweli |
| `embed_plist` | 1.2.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2020 Nikolai Vazquez |
| `equivalent` | 1.0.2 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016--2023 |
| `erased-serde` | 0.4.10 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `errno` | 0.3.14 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Chris Wong |
| `fallible-iterator` | 0.3.0 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 The rust-openssl-verify Developers |
| `fallible-streaming-iterator` | 0.1.9 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 The fallible-streaming-iterator Developers |
| `fastrand` | 2.4.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `fdeflate` | 0.3.7 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `field-offset` | 0.3.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016-2021 Diggory Blake, and other contributors. |
| `find-msvc-tools` | 0.1.9 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `flate2` | 1.1.9 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014-2026 Alex Crichton |
| `fnv` | 1.0.7 | Apache-2.0 / MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 Contributors |
| `foldhash` | 0.1.5 | Zlib | Copyright (c) 2024 Orson Peters |
| `foldhash` | 0.2.0 | Zlib | Copyright (c) 2024 Orson Peters |
| `foreign-types` | 0.5.0 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 The foreign-types Developers |
| `foreign-types-macros` | 0.2.3 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 The foreign-types Developers |
| `foreign-types-shared` | 0.3.1 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 The foreign-types Developers |
| `form_urlencoded` | 1.2.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2013-2016 The rust-url developers |
| `futures-channel` | 0.3.32 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Alex Crichton<br>Copyright (c) 2017 The Tokio Authors |
| `futures-core` | 0.3.32 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Alex Crichton<br>Copyright (c) 2017 The Tokio Authors |
| `futures-executor` | 0.3.32 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Alex Crichton<br>Copyright (c) 2017 The Tokio Authors |
| `futures-io` | 0.3.32 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Alex Crichton<br>Copyright (c) 2017 The Tokio Authors |
| `futures-macro` | 0.3.32 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Alex Crichton<br>Copyright (c) 2017 The Tokio Authors |
| `futures-sink` | 0.3.32 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Alex Crichton<br>Copyright (c) 2017 The Tokio Authors |
| `futures-task` | 0.3.32 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Alex Crichton<br>Copyright (c) 2017 The Tokio Authors |
| `futures-util` | 0.3.32 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Alex Crichton<br>Copyright (c) 2017 The Tokio Authors |
| `gdk` | 0.18.2 | MIT | — |
| `gdk-pixbuf` | 0.18.5 | MIT | — |
| `gdk-pixbuf-sys` | 0.18.0 | MIT | — |
| `gdk-sys` | 0.18.2 | MIT | — |
| `gdkwayland-sys` | 0.18.2 | MIT | — |
| `gdkx11` | 0.18.2 | MIT | — |
| `gdkx11-sys` | 0.18.2 | MIT | — |
| `generic-array` | 0.14.7 | MIT | Copyright (c) 2015 Bartłomiej Kamiński |
| `getrandom` | 0.2.17 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018-2024 The rust-random Project Developers<br>Copyright (c) 2014 The Rust Project Developers |
| `getrandom` | 0.3.4 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018-2025 The rust-random Project Developers<br>Copyright (c) 2014 The Rust Project Developers |
| `getrandom` | 0.4.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018-2026 The rust-random Project Developers<br>Copyright (c) 2014 The Rust Project Developers |
| `gio` | 0.18.4 | MIT | — |
| `gio-sys` | 0.18.1 | MIT | — |
| `glib` | 0.18.5 | MIT | — |
| `glib-macros` | 0.18.5 | MIT | — |
| `glib-sys` | 0.18.1 | MIT | — |
| `glob` | 0.3.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The Rust Project Developers |
| `gobject-sys` | 0.18.0 | MIT | — |
| `gtk` | 0.18.2 | MIT | — |
| `gtk-sys` | 0.18.2 | MIT | — |
| `gtk3-macros` | 0.18.2 | MIT | — |
| `hashbrown` | 0.12.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Amanieu d'Antras |
| `hashbrown` | 0.14.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Amanieu d'Antras |
| `hashbrown` | 0.15.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Amanieu d'Antras |
| `hashbrown` | 0.17.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Amanieu d'Antras |
| `hashlink` | 0.9.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `heck` | 0.4.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 The Rust Project Developers |
| `heck` | 0.5.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 The Rust Project Developers |
| `hex` | 0.4.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2013-2014 The Rust Project Developers.<br>Copyright (c) 2015-2020 The rust-hex Developers |
| `home` | 0.5.12 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `html5ever` | 0.38.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The html5ever Project Developers |
| `http` | 1.4.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2017 http-rs authors<br>Copyright (c) 2017 http-rs authors |
| `http-body` | 1.0.1 | MIT | Copyright (c) 2019-2024 Sean McArthur & Hyper Contributors |
| `http-body-util` | 0.1.3 | MIT | Copyright (c) 2019-2025 Sean McArthur & Hyper Contributors |
| `httparse` | 1.10.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015-2025 Sean McArthur |
| `hyper` | 1.9.0 | MIT | Copyright (c) 2014-2026 Sean McArthur |
| `hyper-util` | 0.1.20 | MIT | Copyright (c) 2023-2025 Sean McArthur |
| `iana-time-zone` | 0.1.65 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2020 Andrew Straw<br>Copyright (c) 2020 Andrew D. Straw |
| `iana-time-zone-haiku` | 0.1.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2020 Andrew Straw<br>Copyright (c) 2020 Andrew D. Straw |
| `ico` | 0.5.0 | MIT | Copyright (c) 2018 Matthew D. Steele |
| `icu_collections` | 2.2.0 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `icu_locale_core` | 2.2.0 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `icu_normalizer` | 2.2.0 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `icu_normalizer_data` | 2.2.0 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `icu_properties` | 2.2.0 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `icu_properties_data` | 2.2.0 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `icu_provider` | 2.2.0 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `id-arena` | 2.3.0 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `ident_case` | 1.0.1 | MIT/Apache-2.0 | — |
| `idna` | 1.1.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2013-2025 The rust-url developers |
| `idna_adapter` | 1.2.2 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) The rust-url developers |
| `indexmap` | 1.9.3 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016--2017 |
| `indexmap` | 2.14.0 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016--2017 |
| `infer` | 0.19.0 | MIT | Copyright (c) 2019 Bojan |
| `ipnet` | 2.12.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2017 Juniper Networks, Inc. |
| `itertools` | 0.12.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 |
| `itoa` | 1.0.18 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `javascriptcore-rs` | 1.1.2 | MIT | Copyright (c) 2013-2021, The Gtk-rs Project Developers.<br>Copyright (c) 2021, Tauri Programme within The Commons Conservancy. |
| `javascriptcore-rs-sys` | 1.1.1 | MIT | Copyright (c) 2013-2017, The Gtk-rs Project Developers. |
| `jni` | 0.21.1 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 Prevoty, Inc. and jni-rs contributors |
| `jni-sys` | 0.3.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 The rust-jni-sys Developers |
| `jni-sys` | 0.4.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 The rust-jni-sys Developers |
| `jni-sys-macros` | 0.4.1 | MIT OR Apache-2.0 | — |
| `js-sys` | 0.3.98 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `json-patch` | 3.0.1 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 Ivan Dubrov |
| `jsonptr` | 0.6.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2024 Chance Dinkins<br>Copyright (c) 2022 Chance Dinkins |
| `keyboard-types` | 0.7.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 Pyfisch |
| `las` | 0.9.11 | MIT | Copyright (c) 2015 Pete Gadomski <pete.gadomski@gmail.com> |
| `laz` | 0.12.1 | Apache-2.0 | Copyright [2023] [Thomas Montaigu]<br>COPYRIGHT: |
| `lazy_static` | 1.5.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2010 The Rust Project Developers |
| `lazycell` | 1.3.0 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `leb128fmt` | 0.1.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `libappindicator` | 0.9.0 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017-2021 qDot<br>Copyright (c) 2021 Tauri Apps Contributors |
| `libappindicator-sys` | 0.9.0 | Apache-2.0 OR MIT | — |
| `libc` | 0.2.186 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) The Rust Project Developers |
| `libdbus-sys` | 0.2.7 | Apache-2.0/MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2014-2018 David Henningsson <diwic@ubuntu.com> and other contributors<br>Copyright (c) 2014-2018 David Henningsson <diwic@ubuntu.com> and other contributors |
| `libloading` | 0.7.4 | ISC | Copyright © 2015, Simonas Kazlauskas |
| `libloading` | 0.8.9 | ISC | Copyright © 2015, Simonas Kazlauskas |
| `libmimalloc-sys` | 0.1.49 | MIT | Copyright 2019 Octavian Oncescu |
| `libredox` | 0.1.16 | MIT | Copyright (c) 2023 4lDO2 |
| `libsqlite3-sys` | 0.30.1 | MIT | Copyright (c) 2014-2021 The rusqlite developers |
| `linux-raw-sys` | 0.4.15 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `litemap` | 0.8.2 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `lock_api` | 0.4.14 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 The Rust Project Developers |
| `log` | 0.4.29 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The Rust Project Developers |
| `markup5ever` | 0.38.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The html5ever Project Developers |
| `memchr` | 2.8.0 | Unlicense OR MIT | Copyright (c) 2015 Andrew Gallant |
| `memoffset` | 0.9.1 | MIT | Copyright (c) 2017 Gilad Naaman |
| `mimalloc` | 0.1.52 | MIT | Copyright 2019 Octavian Oncescu |
| `mime` | 0.3.17 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Sean McArthur |
| `minimal-lexical` | 0.2.1 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2009 The Go Authors. All rights reserved.<br>copyright notice, this list of conditions and the following disclaimer |
| `miniz_oxide` | 0.8.9 | MIT OR Zlib OR Apache-2.0 | Copyright 2013-2014 RAD Game Tools and Valve Software<br>Copyright 2010-2014 Rich Geldreich and Tenacious Software LLC<br>Copyright (c) 2017 Frommi<br>Copyright (c) 2017-2024 oyvindln |
| `mio` | 1.2.0 | MIT | Copyright (c) 2014 Carl Lerche and other MIO contributors |
| `muda` | 0.19.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2022-2022 Tauri Programme within The Commons Conservancy |
| `ndk` | 0.9.0 | MIT OR Apache-2.0 | — |
| `ndk-sys` | 0.6.0+11769913 | MIT OR Apache-2.0 | — |
| `new_debug_unreachable` | 1.0.6 | MIT | Copyright (c) 2015 Jonathan Reem |
| `nom` | 7.1.3 | MIT | Copyright (c) 2014-2019 Geoffroy Couprie |
| `num-conv` | 0.2.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Jacob Pratt |
| `num-traits` | 0.2.19 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The Rust Project Developers |
| `num_enum` | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018, Daniel Wagner-Hall |
| `num_enum_derive` | 0.7.6 | BSD-3-Clause OR MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018, Daniel Wagner-Hall |
| `objc2` | 0.6.4 | MIT | — |
| `objc2-app-kit` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-cloud-kit` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-core-data` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-core-foundation` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-core-graphics` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-core-image` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-core-location` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-core-text` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-encode` | 4.1.0 | MIT | — |
| `objc2-exception-helper` | 0.1.1 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-foundation` | 0.3.2 | MIT | — |
| `objc2-io-surface` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-quartz-core` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-ui-kit` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-user-notifications` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `objc2-web-kit` | 0.3.2 | Zlib OR Apache-2.0 OR MIT | — |
| `once_cell` | 1.21.4 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `option-ext` | 0.2.0 | MPL-2.0 | — |
| `pango` | 0.18.3 | MIT | — |
| `pango-sys` | 0.18.0 | MIT | — |
| `parking_lot` | 0.12.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 The Rust Project Developers |
| `parking_lot_core` | 0.9.12 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 The Rust Project Developers |
| `percent-encoding` | 2.3.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2013-2025 The rust-url developers |
| `phf` | 0.13.1 | MIT | Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi<br>COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| `phf_codegen` | 0.13.1 | MIT | Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi<br>COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| `phf_generator` | 0.13.1 | MIT | Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi<br>COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| `phf_macros` | 0.13.1 | MIT | Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi<br>COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| `phf_shared` | 0.13.1 | MIT | Copyright (c) 2014-2022 Steven Fackler, Yuki Okushi<br>COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| `pin-project-lite` | 0.2.17 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `pkg-config` | 0.3.33 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `plist` | 1.10.1 | MIT | Copyright (c) 2015 Edward Barnard |
| `png` | 0.17.16 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 nwin |
| `png` | 0.18.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 nwin |
| `potential_utf` | 0.1.5 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `powerfmt` | 0.2.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2023 Jacob Pratt et al.<br>Copyright (c) 2023 Jacob Pratt et al. |
| `precomputed-hash` | 0.1.1 | MIT | Copyright (c) 2017 Emilio Cobos Álvarez |
| `prettyplease` | 0.2.37 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `proc-macro-crate` | 1.3.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `proc-macro-crate` | 2.0.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `proc-macro-crate` | 3.5.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `proc-macro-error` | 1.0.4 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2019-2020 CreepySkeleton <creepy-skeleton@yandex.ru><br>Copyright (c) 2019-2020 CreepySkeleton |
| `proc-macro-error-attr` | 1.0.4 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2019-2020 CreepySkeleton <creepy-skeleton@yandex.ru><br>Copyright (c) 2019-2020 CreepySkeleton |
| `proc-macro2` | 1.0.106 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `proj4rs` | 0.1.10 | MIT OR Apache-2.0 | — |
| `quick-xml` | 0.42.0 | MIT | Copyright (c) 2016 Johann Tuffe |
| `quote` | 1.0.45 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `r-efi` | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | — |
| `r-efi` | 6.0.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later | — |
| `raw-window-handle` | 0.6.2 | MIT OR Apache-2.0 OR Zlib | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2019 Osspial<br>Copyright (c) 2020 Osspial |
| `rayon` | 1.12.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2010 The Rust Project Developers |
| `rayon-core` | 1.13.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2010 The Rust Project Developers |
| `redox_syscall` | 0.5.18 | MIT | Copyright (c) 2017 Redox OS Developers |
| `redox_users` | 0.4.6 | MIT | Copyright (c) 2017 Jose Narvaez |
| `redox_users` | 0.5.2 | MIT | Copyright (c) 2017 Jose Narvaez |
| `ref-cast` | 1.0.25 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `ref-cast-impl` | 1.0.25 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `regex` | 1.12.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The Rust Project Developers |
| `regex-automata` | 0.4.14 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The Rust Project Developers |
| `regex-syntax` | 0.8.10 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The Rust Project Developers |
| `reqwest` | 0.13.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2016 Sean McArthur<br>Copyright (c) 2016-2026 Sean McArthur |
| `rfd` | 0.16.0 | MIT | Copyright (c) 2022 Bartłomiej Maryńczak |
| `roxmltree` | 0.21.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018 Yevhenii Reizner |
| `rusqlite` | 0.32.1 | MIT | Copyright (c) 2014-2021 The rusqlite developers |
| `rustc-hash` | 1.1.0 | Apache-2.0/MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `rustc-hash` | 2.1.2 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `rustc_version` | 0.4.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016 The Rust Project Developers |
| `rustix` | 0.38.44 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `rustversion` | 1.0.22 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `same-file` | 1.0.6 | Unlicense/MIT | Copyright (c) 2017 Andrew Gallant |
| `schemars` | 0.8.22 | MIT | Copyright (c) 2019 Graham Esau |
| `schemars` | 0.9.0 | MIT | Copyright (c) 2019 Graham Esau |
| `schemars` | 1.2.1 | MIT | Copyright (c) 2019 Graham Esau |
| `schemars_derive` | 0.8.22 | MIT | Copyright (c) 2019 Graham Esau |
| `scopeguard` | 1.2.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2016-2019 Ulrik Sverdrup "bluss" and scopeguard developers |
| `selectors` | 0.36.1 | MPL-2.0 | — |
| `semver` | 1.0.28 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `serde` | 1.0.228 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `serde-untagged` | 0.1.9 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `serde_core` | 1.0.228 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `serde_derive` | 1.0.228 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `serde_derive_internals` | 0.29.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `serde_json` | 1.0.149 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `serde_repr` | 0.1.20 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `serde_spanned` | 0.6.9 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `serde_spanned` | 1.1.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `serde_with` | 3.20.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 |
| `serde_with_macros` | 3.20.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 |
| `serialize-to-javascript` | 0.1.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2021 Chip Reed |
| `serialize-to-javascript-impl` | 0.1.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2021 Chip Reed |
| `servo_arc` | 0.4.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `sha2` | 0.10.9 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2006-2009 Graydon Hoare<br>Copyright (c) 2009-2013 Mozilla Foundation |
| `shlex` | 1.3.0 | MIT OR Apache-2.0 | Copyright 2015 Nicholas Allegra (comex).<br>Copyright (c) 2015 Nicholas Allegra (comex). |
| `simd-adler32` | 0.3.9 | MIT | Copyright (c) [2021] [Marvin Countryman] |
| `siphasher` | 1.0.3 | MIT/Apache-2.0 | Copyright 2012-2016 The Rust Project Developers.<br>Copyright 2016-2026 Frank Denis. |
| `slab` | 0.4.12 | MIT | Copyright (c) 2019 Carl Lerche |
| `smallvec` | 1.15.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2018 The Servo Project Developers |
| `socket2` | 0.6.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `softbuffer` | 0.4.8 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2022 Kirill Chibisov |
| `soup3` | 0.5.0 | MIT | Copyright (c) 2013-2017, The Gtk-rs Project Developers. |
| `soup3-sys` | 0.5.0 | MIT | Copyright (c) 2013-2017, The Gtk-rs Project Developers. |
| `stable_deref_trait` | 1.2.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 Robert Grosse |
| `string_cache` | 0.9.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2012-2013 Mozilla Foundation |
| `string_cache_codegen` | 0.6.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2012-2013 Mozilla Foundation |
| `strsim` | 0.11.1 | MIT | Copyright (c) 2015 Danny Guo<br>Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com><br>Copyright (c) 2018 Akash Kurdekar |
| `swift-rs` | 1.0.7 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2023 The swift-rs developers<br>Copyright (c) 2023 The swift-rs Developers |
| `syn` | 1.0.109 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `syn` | 2.0.117 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `sync_wrapper` | 1.0.2 | Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `synstructure` | 0.13.2 | MIT | Copyright 2016 Nika Layzell |
| `system-deps` | 6.2.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `tao` | 0.35.2 | Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `tao-macros` | 0.1.3 | MIT OR Apache-2.0 | — |
| `target-lexicon` | 0.12.16 | Apache-2.0 WITH LLVM-exception | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `tauri` | 2.11.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 - Present Tauri Apps Contributors |
| `tauri-build` | 2.6.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 - Present Tauri Apps Contributors |
| `tauri-codegen` | 2.6.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 - Present Tauri Apps Contributors |
| `tauri-macros` | 2.6.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 - Present Tauri Apps Contributors |
| `tauri-plugin` | 2.6.1 | Apache-2.0 OR MIT | — |
| `tauri-plugin-dialog` | 2.7.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 - Present Tauri Apps Contributors |
| `tauri-plugin-fs` | 2.5.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 - Present Tauri Apps Contributors |
| `tauri-runtime` | 2.11.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 - Present Tauri Apps Contributors |
| `tauri-runtime-wry` | 2.11.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 - Present Tauri Apps Contributors |
| `tauri-utils` | 2.9.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 - Present Tauri Apps Contributors |
| `tauri-winres` | 0.3.6 | MIT | Copyright (c) 2023 - Present Tauri Apps Contributors<br>Copyright (c) 2016 Max Resch |
| `tendril` | 0.5.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 Keegan McAllister |
| `thiserror` | 1.0.69 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `thiserror` | 2.0.18 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `thiserror-impl` | 1.0.69 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `thiserror-impl` | 2.0.18 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `time` | 0.3.47 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Jacob Pratt et al. |
| `time-core` | 0.1.8 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Jacob Pratt et al. |
| `time-macros` | 0.2.27 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Jacob Pratt et al. |
| `tinystr` | 0.8.3 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `tinyvec` | 1.11.0 | Zlib OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2019 Daniel "Lokathor" Gee. |
| `tinyvec_macros` | 0.1.1 | MIT OR Apache-2.0 OR Zlib | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2020 Tomasz "Soveu" Marx<br>Copyright (c) 2020 Soveu |
| `tokio` | 1.52.3 | MIT | Copyright (c) Tokio Contributors |
| `tokio-util` | 0.7.18 | MIT | Copyright (c) Tokio Contributors |
| `toml` | 0.8.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `toml` | 0.9.12+spec-1.1.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `toml` | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `toml_datetime` | 0.6.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `toml_datetime` | 0.7.5+spec-1.1.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `toml_datetime` | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `toml_edit` | 0.19.15 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `toml_edit` | 0.20.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `toml_edit` | 0.25.11+spec-1.1.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `toml_parser` | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `toml_writer` | 1.1.1+spec-1.1.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Individual contributors |
| `tower` | 0.5.3 | MIT | Copyright (c) 2019 Tower Contributors |
| `tower-http` | 0.6.10 | MIT | Copyright (c) 2019-2021 Tower Contributors |
| `tower-layer` | 0.3.3 | MIT | Copyright (c) 2019 Tower Contributors |
| `tower-service` | 0.3.3 | MIT | Copyright (c) 2019 Tower Contributors |
| `tracing` | 0.1.44 | MIT | Copyright (c) 2019 Tokio Contributors |
| `tracing-core` | 0.1.36 | MIT | Copyright (c) 2019 Tokio Contributors |
| `tray-icon` | 0.23.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2022-2022 Tauri Programme within The Commons Conservancy |
| `try-lock` | 0.2.5 | MIT | Copyright (c) 2018-2023 Sean McArthur<br>Copyright (c) 2016 Alex Crichton |
| `typeid` | 1.0.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `typenum` | 1.20.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2014 Paho Lurie-Gregg<br>Copyright (c) 2014 Paho Lurie-Gregg |
| `unic-char-property` | 0.9.0 | MIT/Apache-2.0 | — |
| `unic-char-range` | 0.9.0 | MIT/Apache-2.0 | — |
| `unic-common` | 0.9.0 | MIT/Apache-2.0 | — |
| `unic-ucd-ident` | 0.9.0 | MIT/Apache-2.0 | — |
| `unic-ucd-version` | 0.9.0 | MIT/Apache-2.0 | — |
| `unicode-ident` | 1.0.24 | (MIT OR Apache-2.0) AND Unicode-3.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 1991-2023 Unicode, Inc. |
| `unicode-segmentation` | 1.13.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 The Rust Project Developers |
| `unicode-xid` | 0.2.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015 The Rust Project Developers |
| `url` | 2.5.8 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2013-2025 The rust-url developers |
| `urlpattern` | 0.3.0 | MIT | Copyright (c) 2021 the Deno authors |
| `utf-8` | 0.7.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `utf8_iter` | 1.0.4 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright Mozilla Foundation |
| `uuid` | 1.23.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The Rust Project Developers<br>Copyright (c) 2018 Ashley Mannix, Christopher Armstrong, Dylan DPC, Hunar Roop Kahlon |
| `vcpkg` | 0.2.15 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 Jim McGrath |
| `version-compare` | 0.2.1 | MIT | Copyright (c) 2017 Tim Visée |
| `version_check` | 0.9.5 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017-2018 Sergio Benitez<br>COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| `vswhom` | 0.1.0 | MIT | Copyright (c) 2019 nabijaczleweli |
| `vswhom-sys` | 0.1.3 | MIT | Copyright (c) 2019 nabijaczleweli |
| `walkdir` | 2.5.0 | Unlicense/MIT | Copyright (c) 2015 Andrew Gallant |
| `want` | 0.3.1 | MIT | Copyright (c) 2018-2019 Sean McArthur |
| `wasi` | 0.11.1+wasi-snapshot-preview1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `wasip2` | 1.0.3+wasi-0.2.9 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `wasip3` | 0.4.0+wasi-0.3.0-rc-2026-01-06 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | — |
| `wasm-bindgen` | 0.2.121 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `wasm-bindgen-futures` | 0.4.71 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `wasm-bindgen-macro` | 0.2.121 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `wasm-bindgen-macro-support` | 0.2.121 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `wasm-bindgen-shared` | 0.2.121 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `wasm-encoder` | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | — |
| `wasm-metadata` | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | — |
| `wasm-streams` | 0.5.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `wasmparser` | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | — |
| `web-sys` | 0.3.98 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 Alex Crichton |
| `web_atoms` | 0.2.4 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2014 The html5ever Project Developers |
| `webkit2gtk` | 2.0.2 | MIT | Copyright (c) 2016 Boucher, Antoni <bouanto@zoho.com><br>Copyright (c) 2017-2021, The Gtk-rs Project Developers.<br>Copyright (c) 2021, Tauri Programme within The Commons Conservancy<br>COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| `webkit2gtk-sys` | 2.0.2 | MIT | Copyright (c) 2016 Boucher, Antoni <bouanto@zoho.com><br>COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER |
| `webview2-com` | 0.38.2 | MIT | — |
| `webview2-com-macros` | 0.8.1 | MIT | — |
| `webview2-com-sys` | 0.38.2 | MIT | — |
| `which` | 4.4.2 | MIT | Copyright (c) 2015 fangyuanziti |
| `winapi` | 0.3.9 | MIT/Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2015-2018 The winapi-rs Developers |
| `winapi-i686-pc-windows-gnu` | 0.4.0 | MIT/Apache-2.0 | — |
| `winapi-util` | 0.1.11 | Unlicense OR MIT | Copyright (c) 2017 Andrew Gallant |
| `winapi-x86_64-pc-windows-gnu` | 0.4.0 | MIT/Apache-2.0 | — |
| `window-vibrancy` | 0.6.0 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2020-2022 Tauri Programme within The Commons Conservancy |
| `windows` | 0.61.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-collections` | 0.2.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-core` | 0.61.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-core` | 0.62.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-future` | 0.2.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-implement` | 0.60.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-interface` | 0.59.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-link` | 0.1.3 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-link` | 0.2.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-numerics` | 0.2.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-result` | 0.3.4 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-result` | 0.4.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-strings` | 0.4.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-strings` | 0.5.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-sys` | 0.45.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-sys` | 0.48.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-sys` | 0.59.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-sys` | 0.60.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-sys` | 0.61.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-targets` | 0.42.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-targets` | 0.48.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-targets` | 0.52.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-targets` | 0.53.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-threading` | 0.1.0 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows-version` | 0.1.7 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_aarch64_gnullvm` | 0.42.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_aarch64_gnullvm` | 0.48.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_aarch64_gnullvm` | 0.52.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_aarch64_gnullvm` | 0.53.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_aarch64_msvc` | 0.42.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_aarch64_msvc` | 0.48.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_aarch64_msvc` | 0.52.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_aarch64_msvc` | 0.53.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_i686_gnu` | 0.42.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_i686_gnu` | 0.48.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_i686_gnu` | 0.52.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_i686_gnu` | 0.53.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_i686_gnullvm` | 0.52.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_i686_gnullvm` | 0.53.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_i686_msvc` | 0.42.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_i686_msvc` | 0.48.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_i686_msvc` | 0.52.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_i686_msvc` | 0.53.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_gnu` | 0.42.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_gnu` | 0.48.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_gnu` | 0.52.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_gnu` | 0.53.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_gnullvm` | 0.42.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_gnullvm` | 0.48.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_gnullvm` | 0.52.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_gnullvm` | 0.53.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_msvc` | 0.42.2 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_msvc` | 0.48.5 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_msvc` | 0.52.6 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `windows_x86_64_msvc` | 0.53.1 | MIT OR Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) Microsoft Corporation. |
| `winnow` | 0.5.40 | MIT | — |
| `winnow` | 0.7.15 | MIT | — |
| `winnow` | 1.0.2 | MIT | — |
| `winreg` | 0.55.0 | MIT | Copyright (c) 2015 Igor Shaula |
| `wit-bindgen` | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `wit-bindgen` | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `wit-bindgen-core` | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `wit-bindgen-rust` | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `wit-bindgen-rust-macro` | 0.51.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `wit-component` | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | — |
| `wit-parser` | 0.244.0 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | — |
| `writeable` | 0.6.3 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `wry` | 0.55.1 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2020-2023 Ngo Iok Ui & Tauri Programme within The Commons Conservancy |
| `x11` | 2.21.0 | MIT | — |
| `x11-dl` | 2.21.0 | MIT | — |
| `yoke` | 0.8.2 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `yoke-derive` | 0.8.2 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `zerocopy` | 0.8.48 | BSD-2-Clause OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2023 The Fuchsia Authors<br>Copyright 2019 The Fuchsia Authors. |
| `zerocopy-derive` | 0.8.48 | BSD-2-Clause OR Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright 2023 The Fuchsia Authors<br>Copyright 2019 The Fuchsia Authors. |
| `zerofrom` | 0.1.8 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `zerofrom-derive` | 0.1.7 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `zerotrie` | 0.2.4 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `zerovec` | 0.11.6 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `zerovec-derive` | 0.11.3 | Unicode-3.0 | COPYRIGHT AND PERMISSION NOTICE<br>Copyright © 2020-2024 Unicode, Inc. |
| `zmij` | 1.0.21 | MIT | — |


### npm packages (production dependency closure) (84)

Licence expressions in use, by package count:

  * 71 × `MIT`
  * 5 × `Apache-2.0`
  * 3 × `ISC`
  * 2 × `OFL-1.1`
  * 1 × `Apache-2.0 OR MIT`
  * 1 × `BSD-3-Clause`
  * 1 × `see the LICENSE file in the package`

| Package | Version | Licence | Copyright |
| --- | --- | --- | --- |
| `@babel/runtime` | 7.29.2 | MIT | Copyright (c) 2014-present Sebastian McKenzie and other contributors |
| `@fontsource/inter` | 5.3.0 | OFL-1.1 | Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter) Inter-Italic[opsz,wght].ttf: Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)<br>copyright statement(s).<br>Copyright Holder. This restriction only applies to the primary font name as<br>Copyright Holder(s) and the Author(s) or with their explicit written |
| `@fontsource/jetbrains-mono` | 5.3.0 | OFL-1.1 | Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono) JetBrainsMono-Italic[wght].ttf: Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)<br>copyright statement(s).<br>Copyright Holder. This restriction only applies to the primary font name as<br>Copyright Holder(s) and the Author(s) or with their explicit written |
| `@mediapipe/tasks-vision` | 0.10.17 | Apache-2.0 | — |
| `@monogrid/gainmap-js` | 3.4.0 | MIT | Copyright (c) 2023 MONOGRID |
| `@react-spring/animated` | 9.7.5 | MIT | Copyright (c) 2018-present Paul Henschel, react-spring, all contributors |
| `@react-spring/core` | 9.7.5 | MIT | Copyright (c) 2018-present Paul Henschel, react-spring, all contributors |
| `@react-spring/rafz` | 9.7.5 | MIT | Copyright (c) 2018-present Paul Henschel, react-spring, all contributors |
| `@react-spring/shared` | 9.7.5 | MIT | Copyright (c) 2018-present Paul Henschel, react-spring, all contributors |
| `@react-spring/three` | 9.7.5 | MIT | Copyright (c) 2018-present Paul Henschel, react-spring, all contributors |
| `@react-spring/types` | 9.7.5 | MIT | Copyright (c) 2018-present Paul Henschel, react-spring, all contributors |
| `@react-three/drei` | 9.122.0 | MIT | Copyright (c) 2020 react-spring |
| `@react-three/fiber` | 8.18.0 | MIT | — |
| `@tauri-apps/api` | 2.11.0 | Apache-2.0 OR MIT | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of,<br>Copyright (c) 2017 - Present Tauri Apps Contributors |
| `@types/draco3d` | 1.4.10 | MIT | Copyright (c) Microsoft Corporation. |
| `@types/offscreencanvas` | 2019.7.3 | MIT | Copyright (c) Microsoft Corporation. |
| `@types/prop-types` | 15.7.15 | MIT | Copyright (c) Microsoft Corporation. |
| `@types/react` | 18.3.28 | MIT | Copyright (c) Microsoft Corporation. |
| `@types/react-reconciler` | 0.26.7 | MIT | Copyright (c) Microsoft Corporation. |
| `@types/react-reconciler` | 0.28.9 | MIT | Copyright (c) Microsoft Corporation. |
| `@types/stats.js` | 0.17.4 | MIT | Copyright (c) Microsoft Corporation. |
| `@types/three` | 0.160.0 | MIT | Copyright (c) Microsoft Corporation. |
| `@types/webxr` | 0.5.24 | MIT | Copyright (c) Microsoft Corporation. |
| `@use-gesture/core` | 10.3.1 | MIT | Copyright (c) 2018-present Paul Henschel <drcmda@gmail.com> |
| `@use-gesture/react` | 10.3.1 | MIT | Copyright (c) 2018-present Paul Henschel <drcmda@gmail.com> |
| `base64-js` | 1.5.1 | MIT | Copyright (c) 2014 Jameson Little |
| `bidi-js` | 1.0.3 | MIT | Copyright (c) 2021 Jason Johnston |
| `buffer` | 6.0.3 | MIT | Copyright (c) Feross Aboukhadijeh, and other contributors. |
| `camera-controls` | 2.10.1 | MIT | Copyright (c) 2017 @yomotsu |
| `cross-env` | 7.0.3 | MIT | Copyright (c) 2017 Kent C. Dodds |
| `cross-spawn` | 7.0.6 | MIT | Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio> |
| `csstype` | 3.2.3 | MIT | Copyright (c) 2017-2018 Fredrik Nicol |
| `detect-gpu` | 5.0.70 | MIT | Copyright (c) 2020 Tim van Scherpenzeel |
| `draco3d` | 1.5.7 | Apache-2.0 | — |
| `fflate` | 0.6.11 | MIT | Copyright (c) 2020 Arjun Barrett |
| `glsl-noise` | 0.0.0 | MIT | Copyright (C) 2011 by Ashima Arts (Simplex noise)<br>Copyright (C) 2011 by Stefan Gustavson (Classic noise) |
| `hls.js` | 1.6.16 | Apache-2.0 | Copyright (c) 2017 Dailymotion (http://www.dailymotion.com)<br>Copyright (c) 2013-2015 Brightcove |
| `ieee754` | 1.2.1 | BSD-3-Clause | Copyright 2008 Fair Oaks Labs, Inc. |
| `immediate` | 3.0.6 | MIT | Copyright (c) 2012 Barnesandnoble.com, llc, Donavon West, Domenic Denicola, Brian Cavalier |
| `is-promise` | 2.2.2 | MIT | Copyright (c) 2014 Forbes Lindesay |
| `isexe` | 2.0.0 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors<br>copyright notice and this permission notice appear in all copies. |
| `its-fine` | 1.2.5 | MIT | Copyright (c) 2022 Poimandres |
| `js-tokens` | 4.0.0 | MIT | Copyright (c) 2014, 2015, 2016, 2017, 2018 Simon Lydell |
| `laz-perf` | 0.0.7 | Apache-2.0 | — |
| `lie` | 3.3.0 | MIT | Copyright (c) 2014-2018 Calvin Metcalf, Jordan Harband |
| `loose-envify` | 1.4.0 | MIT | Copyright (c) 2015 Andres Suarez <zertosh@gmail.com> |
| `maath` | 0.10.8 | MIT | — |
| `meshline` | 3.3.1 | MIT | Copyright (c) 2016 Jaume Sanchez |
| `meshoptimizer` | 0.18.1 | MIT | Copyright (c) 2016-2022 Arseny Kapoulkine |
| `object-assign` | 4.1.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `path-key` | 3.1.1 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `potpack` | 1.0.2 | ISC | Copyright (c) 2018, Mapbox |
| `promise-worker-transferable` | 1.0.4 | Apache-2.0 | copyright notice that is included in or attached to the work<br>copyright license to reproduce, prepare Derivative Works of, |
| `prop-types` | 15.8.1 | MIT | Copyright (c) 2013-present, Facebook, Inc. |
| `react` | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| `react-composer` | 5.0.3 | MIT | Copyright (c) 2018 James, please |
| `react-dom` | 18.3.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| `react-is` | 16.13.1 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| `react-reconciler` | 0.27.0 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| `react-use-measure` | 2.1.7 | MIT | Copyright (c) 2019-2025 Poimandres |
| `require-from-string` | 2.0.2 | MIT | Copyright (c) Vsevolod Strukchinsky <floatdrop@gmail.com> (github.com/floatdrop) |
| `scheduler` | 0.21.0 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| `scheduler` | 0.23.2 | MIT | Copyright (c) Facebook, Inc. and its affiliates. |
| `shebang-command` | 2.0.0 | MIT | Copyright (c) Kevin Mårtensson <kevinmartensson@gmail.com> (github.com/kevva) |
| `shebang-regex` | 3.0.0 | MIT | Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com) |
| `stats-gl` | 2.4.2 | MIT | — |
| `stats.js` | 0.17.0 | MIT | Copyright (c) 2009-2016 stats.js authors |
| `suspend-react` | 0.1.3 | MIT | Copyright (c) 2021 Paul Henschel |
| `three` | 0.160.1 | MIT | Copyright © 2010-2023 three.js authors |
| `three` | 0.170.0 | MIT | Copyright © 2010-2024 three.js authors |
| `three-mesh-bvh` | 0.7.8 | MIT | Copyright (c) 2018 Garrett Johnson |
| `three-stdlib` | 2.36.1 | MIT | Copyright (c) 2021-2023 Poimandres |
| `troika-three-text` | 0.52.4 | MIT | Copyright (c) 2019 ProtectWise<br>Copyright (c) 2021 Jason Johnston |
| `troika-three-utils` | 0.52.4 | MIT | Copyright (c) 2019 ProtectWise<br>Copyright (c) 2021 Jason Johnston |
| `troika-worker-utils` | 0.52.0 | MIT | Copyright (c) 2019 ProtectWise<br>Copyright (c) 2021 Jason Johnston |
| `tunnel-rat` | 0.1.2 | MIT | Copyright (c) 2022 Poimandres |
| `use-sync-external-store` | 1.6.0 | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `utility-types` | 3.11.0 | MIT | Copyright (c) 2016 Piotr Witek <piotrek.witek@gmail.com> (http://piotrwitek.github.io) |
| `webgl-constants` | 1.1.1 | see the LICENSE file in the package | Copyright (c) 2019 Tim van Scherpenzeel |
| `webgl-sdf-generator` | 1.1.1 | MIT | Copyright (c) 2021 Jason Johnston |
| `which` | 2.0.2 | ISC | Copyright (c) Isaac Z. Schlueter and Contributors<br>copyright notice and this permission notice appear in all copies. |
| `zustand` | 3.7.2 | MIT | Copyright (c) 2019 Paul Henschel |
| `zustand` | 4.5.7 | MIT | Copyright (c) 2019 Paul Henschel |
| `zustand` | 5.0.13 | MIT | Copyright (c) 2019 Paul Henschel |

<!-- END GENERATED DEPENDENCY INVENTORY -->
