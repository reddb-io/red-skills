# Relicense red-skills to Apache-2.0 with a NOTICE for upstream MIT

## Status

accepted.

red-skills began as an adaptation of [`mattpocock/skills`](https://github.com/mattpocock/skills)
(MIT) and carried `LICENSE` = MIT with Matt Pocock's copyright, plus a `CLAUDE.md`
rule forbidding any change to that attribution. We are now absorbing the
`red-memory` project — a TypeScript monorepo + MCP server + hooks — as the
`memory` plugin. red-memory is **Apache-2.0** (its own ADR 0001), and the
RedDB engine it talks to is AGPL-3.0. Two licenses cannot coexist in one repo
without a deliberate decision about which governs the whole and how the
inherited MIT work is preserved.

## Decision

License the entire red-skills repository under **Apache-2.0**.

Preserve Matt Pocock's original MIT copyright for the upstream-derived skills
(under `plugins/dev/skills/`) in a `NOTICE` file, as Apache-2.0 §4(d) provides.
The MIT licence requires its copyright notice be retained in derivative works;
the `NOTICE` satisfies that while the repo as a whole moves to Apache-2.0.

This subsumes red-memory's ADR 0001 (which relicensed red-memory alone to
Apache-2.0): the same conclusion now applies repo-wide, so red-memory's license
ADR is not migrated as a separate decision — it folds into this one.

The AGPL-3.0 RedDB engine is **not vendored**. The `memory` plugin consumes it
out-of-process over stdio via `@reddb-io/sdk`; an out-of-process consumer does
not inherit AGPL obligations, so no AGPL-licensed source enters this repo.

## Why

- **Apache-2.0 carries an explicit patent grant** that MIT lacks — it matters
  for code that may end up in enterprise stacks, which is exactly red-memory's
  adoption target.
- **One repo, one governing license** is simpler than per-subtree licensing for
  contributors and consumers; the `NOTICE` mechanism is the standard, low-friction
  way to honour the inherited MIT attribution without keeping two regimes.
- **Relicensing a derivative MIT work under Apache-2.0 is permitted** as long as
  the original copyright notice is retained — which the `NOTICE` does. We add our
  copyright; we do not remove Matt's.
- **AGPL stays external by construction** (stdio, not linked/vendored), so moving
  to Apache does not create a license conflict with the engine.

## Rejected alternatives

- **Keep MIT.** Same as the upstream and lowest friction, but loses the patent
  grant and forces the absorbed Apache code to live under a different license
  than the repo that hosts it.
- **Per-subtree license** (`plugins/memory/` Apache, rest MIT). Isolates the
  conflict but splits the repo into two regimes contributors must track, for
  marginal benefit once the AGPL engine is confirmed out-of-process.
- **Strip the upstream-derived skills first**, then Apache over 100% reddb.io
  code. Unnecessary destruction of working skills and of the attribution we are
  obliged to keep anyway.

## Consequences

- `LICENSE` is Apache-2.0; `NOTICE` retains Matt's MIT copyright for
  `plugins/dev/skills/`.
- `CLAUDE.md` rule 4 is rewritten: the protected invariant is now the `NOTICE`
  attribution, not "the repo is MIT".
- Future contributions are under Apache-2.0; a later relicense would require
  contributor agreement.
- Anyone may fork (including commercially) under Apache-2.0; the patent grant
  protects users from contributor patent claims.
