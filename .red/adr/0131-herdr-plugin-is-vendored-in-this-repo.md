# 0131 — The herdr plugin is vendored here; the daemon's read surfaces have one home

- **Status**: accepted
- **Date**: 2026-08-01
- **Related**: ADR 0124 (castle crossing absorbs the proven engine), ADR 0126 (the resident is the core, every surface is a client), ADR 0130 (`redskilled` is the host-scoped execution daemon), issues #2947 and #2948 (the TOON wire), #2878 and #2918 (what a shipped binary owes)

## Context

`reddb-io/herdr-plugin-red-skills` is a herdr plugin that reads `redskilled`:
live Workers and their vitals, worker logs, the host event lane, open pull
requests per project, and notifications when any of that changes. It was written
in its own repository, and being a READ client of a daemon defined here is the
whole of what it is.

That split cost more than it bought, and the bill arrives as skew:

- **The wire moved and the plugin did not.** Issues #2947 and #2948 made the
  daemon's request/response wire TOON. The plugin still wrote a line of JSON,
  and only kept working because the daemon answers in the dialect it was
  addressed in. A contract change in this repo silently aged a client in
  another, with nothing in either failing.
- **The invariants stop at the repo boundary.** The TOON I/O ratchet, the
  extinction ratchet and the shipped-binary invariant constrain every file under
  `apps/` and `packages/` here. A client of this repo's daemon, living
  elsewhere, is bound by none of them — so the plugin read the daemon's TOONL
  event lane with a JSON-first sniff, wrote a `config.json`, and no check said
  a word.
- **Two repositories for one change.** Every op the daemon gains is a pull
  request here and another one there, ordered by hand, with a version pair
  nobody records.

`packages/red-castle` already set the precedent for what to do about this (ADR
0124): absorb the source as a real directory, record where it came from in an
`.upstream` marker, and make every subsequent change an ordinary one-PR change
in this repo.

## Decision

**The plugin is vendored at `apps/herdr-plugin/` as ordinary in-repo source, and
this repo is the single home for `redskilled`'s read surfaces.**

1. **A real directory, not a submodule, a subtree or a fork.** `.upstream`
   records the repository and the commit the code was absorbed at —
   `efc858158f830517187999861bb06d3f0a6e3c9a` — so the absorption can be diffed
   against its origin once. After that the marker is history rather than a link:
   there is no sync job, and an upstream advance would be a decision somebody
   makes, not a surprise.

2. **The source repository is untouched.** Whether it is archived is its
   maintainer's call. Nothing here depends on that answer, because nothing here
   reads it.

3. **A workspace member, held by the shared gate.** `apps/herdr-plugin` is a
   pnpm workspace package whose `test` script runs `scripts/check-manifest.py`
   and the `node --test` suite, so a cone-scoped gate that touches the plugin
   runs both, and the repo-wide invariants run whatever the cone.

4. **The binary is `red-skills-herdr`.** The plugin declared `bin: red-skills`,
   which is the name `@reddb-io/red-skills` already ships under. Two packages
   claiming one bin name is a collision resolved by whichever installed last,
   which is not a resolution. The rename is the price of one home, and it is
   paid once.

5. **The wire is TOON in both directions, with no JSON fallback.** The shared
   implementation accepts a JSON frame from an older peer (rule 1 of
   `packages/shared/resident-wire.ts`); this plugin does not, and loses nothing
   by it. A daemon too old to READ a TOON frame cannot answer these questions
   either — its reply is a parse error, not an answer — so decoding it would buy
   a rendered refusal instead of a rendered dashboard. "Nothing intelligible
   answered" is the honest report, and it keeps every byte on this wire TOON.

6. **`@reddb-io/build-info` became plain ESM so a `.mjs` binary can answer
   `--version`.** The shipped-binary invariant (#2878) asks every binary in every
   `bin` map to print `renderVersion(readBuildInfo(...))`, and the module that
   holds those two functions was `index.ts` — which no plain-ESM binary can load,
   because Node refuses to strip types from a file under `node_modules`, and a
   workspace link is under `node_modules`. The implementation carries no types
   worth compiling, so it moved to `index.mjs` with `index.d.mts` beside it. The
   TypeScript consumers resolve the same package name and see the same surface.

## Consequences

- The plugin is developed, tested and released as part of this repo. A change to
  the daemon's contract and the change to its reader are one pull request.
- **Its install path changed**: it is `herdr plugin link apps/herdr-plugin` from
  a checkout with `pnpm install` run, not a clone of a standalone repository.
  The plugin is no longer dependency-free — it depends on `@reddb-io/toon` for
  the wire and its own files, and on `@reddb-io/build-info` for the version
  answer — and pnpm is what resolves both. There is still no build step.
- **A pre-absorption `config.json` is not read.** Every value in it is a default
  the plugin declares, so `init-config` writes a fresh `config.toon` and the only
  thing an operator re-enters is their edits.
- The plugin now runs against a daemon that speaks TOON, which every `redskilled`
  from the #2947 cutover onward does. An older one reports as unreachable rather
  than rendering.
- One more `apps/*` package pays the gate's fixed cost, and the plugin's suite
  needs `python3` on PATH for its manifest check.
