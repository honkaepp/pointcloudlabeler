# Contributing to PointCloudLabeler

Thank you for considering a contribution. PointCloudLabeler is open scientific
software and benefits from community input.

## Getting started

```bash
git clone https://github.com/honkaepp/pointcloudlabeler.git
cd pointcloudlabeler
npm install
npm run tauri dev
```

See [`README.md`](README.md) for full system requirements (Rust 1.77+,
Node 20+, Tauri system dependencies on your OS).

## Reporting bugs

Open a [GitHub issue](https://github.com/honkaepp/pointcloudlabeler/issues) with:
- Operating system + PointCloudLabeler version
- The shortest input that reproduces the problem (sample point cloud,
  project file)
- The exact steps you took
- What you expected vs. what happened
- The console output from the developer tools (View → Developer →
  Toggle Developer Tools) if relevant

If the issue involves a scientific computation (QSM, ground filter,
metrics, biomass), please also include the parameter values you used.

## Suggesting features

The same issue tracker works for feature requests. Before opening
one, search the existing issues; if yours is there, +1 it so we know
there's demand.

## Pull requests

Development happens in a private repository, and this one receives
each release as a single commit. Pull requests are still welcome here:
the maintainer reviews them and carries accepted changes into the next
release, with credit in the commit.

1. Fork the repository and create a feature branch from `main`.
2. Make your changes. Keep the commit focused — one logical change
   per PR is easier to review.
3. Add or update tests:
   - Rust: `cd src-tauri && cargo test --lib`
   - TypeScript: `npx tsc --noEmit` and `npm test`
4. Run the linters:
   - `cd src-tauri && cargo clippy --lib`
   - The TypeScript build is the type check.
5. Update the README's feature list if the change adds or removes a
   feature.
6. Push and open a PR. Describe what changed and why, and link any
   relevant issue.

## Scientific contributions

If you're adding a new algorithm — a different ground filter, a new
segmentation method, a region-specific biomass equation — please
include:

- A reference to the published method, in the module's header comment
  and in the README's citation list.
- A unit test on synthetic data that validates the implementation
  against the reference's expected behaviour. The existing QSM tests
  in `src-tauri/src/commands/octree.rs` and `treeqsm.rs` are good
  templates.
- A brief note in the module's header comment explaining when a
  forester would choose your method over the existing ones.

## Code style

- Rust: follow `cargo fmt`. Function and module names in `snake_case`,
  types in `CamelCase`.
- TypeScript: existing code uses 2-space indentation and prefers
  `const` over `let`. No formatter is enforced; match surrounding
  style.
- Comments explain **why**, not **what**. Use inline comments for
  hidden constraints, numerical conventions, and references to
  published algorithms.

## Commit messages

Short subject (≤ 72 chars), blank line, body explaining the why.
Reference issue numbers with `#123` when relevant. Recent commits
in the repository are good examples.

## Licence

By contributing, you agree that your contribution is released under
the same licence as the part of PointCloudLabeler it touches: code under the
[GNU General Public License v3 or later](LICENSE), documentation under
[CC BY 4.0](LICENSE-DOCS).

There is no contributor licence agreement to sign, and no copyright
assignment: you keep the copyright in what you write. Opening a pull
request is how you state the terms — inbound under the same licence as
outbound.

Worth knowing, because it is not obvious and it is not symmetric with
some other projects: the GPL contains no inbound-contribution clause
(Apache-2.0 §5 does; this is one of the few things it has that the GPL
does not), so the paragraph above is the whole of the arrangement
rather than a restatement of licence text. The practical consequence is
that once a contribution is merged, PointCloudLabeler cannot be relicensed without
the agreement of everyone who holds copyright in it. That is the normal
state of a GPL project and it is deliberate — it is the same guarantee
to a contributor that the licence gives to a user.
