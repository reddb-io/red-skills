# 0133 — `packages/github` is a client, not an argv planner

- **Status**: accepted
- **Date**: 2026-08-03
- **Related**: ADR 0132 (`packages/github` owns the API-surface decision; the quota ledger belongs to the daemon), ADR 0091 (the canonical `npx -y -p` invocation), ADR 0130 rule 3 (the daemon holds no castle semantics), Spec #3202 (the two surfaces cooperate), issues #3182 and #3169 (two landings parked by an argv bug), #2514 and #2802 (the ETag polling transport already in the tree)

## Context

ADR 0132 decision 4 made `packages/github` the one owner of the API-surface decision. It owns the decision and does not make the call: it returns `args: ["api", path]`, a caller prefixes `gh`, and a subprocess runs. **The one owner is a planner of command lines.**

That boundary charges rent, and the rent is now measurable.

**Roughly 1,233 lines exist to manage it.** `runtime/gh/{common,quota,read,single-object,band}.ts` plus `core/etag-polling.ts` and `runtime/etag-transport.ts`. Not all of it is transport — `read.ts` and `band.ts` are routing policy and would survive any transport — but `common.ts` builds argv, `quota.ts` recognises a rate limit by reading stderr, and a third of `single-object.ts` is plan → argv → `JSON.parse`. Ten sites parse a subprocess's stdout as JSON. `runtime/gh` alone holds 38 `catch` blocks.

**Most of those catches are not about GitHub.** They exist because a subprocess fails in ways an HTTP client cannot: a spawn that never happens, a flag the binary rejects, a truncated stdout, an exit code that means different things in different commands. Each becomes a semantic state the engine must model — `ABSENT_QUEUED_PR_VIEW`, `observed: false`, `restUnavailable` — and each of those states is a place a caller can mistake an unreadable answer for a negative one.

**#3182 and #3169 are the bill.** `readQueuedPrView` prefixed `-R <repo>` onto the REST plan's args. `-R` belongs to `gh pr view`; `gh api` rejects it outright, and the plan already carried the repository in its path. Every REST-routed merge confirmation therefore failed before reaching GitHub, four retries exhausted the budget, and both issues parked `blocked:infra` asking a human to repair infrastructure that was never broken — one of them the last open ticket of a Spec, the other the fix for a flake blocking the release train. **It was not a logic bug. It was a string-concatenation bug in a command line**, and a typed client has nowhere to put one.

**The CLI also fights the largest lever in Spec #3202.** Measured on this host:

```
$ gh api repos/… -H "If-None-Match: <etag>"
HTTP/2.0 304 Not Modified          ← nothing changed, and it cost no budget
$ echo $?
1                                  ← the CLI calls that a failure
```

A `304` is the answer conditional requests exist to get, and reaching it through `gh` means treating exit 1 as a possible success and re-deriving the status from header text. `core/etag-polling.ts` already does exactly that (#2514, #2802) — the workaround is written, tested and shipped. It is also a workaround for a boundary we chose.

**Authentication is the objection that dissolves.** `gh auth token` works, and the engine authenticates nothing itself today: it reads `GH_TOKEN`/`GITHUB_TOKEN` only for redaction and CI-context checks. Credential sourcing is already delegated, and delegating it to one call is strictly less coupling than delegating it to every call.

## Decision

**1. `packages/github` becomes a client. Its transport is `@octokit/*`.** The package stops emitting argv for someone else to run and starts making the call itself. This does not widen its charter — ADR 0132 already made it the one owner of the surface decision; this gives the owner the means to act on its own decision instead of describing it to a subprocess.

**2. Policy stays ours, because Octokit chooses nothing.** `octokit` exposes `rest.*` and `graphql()` on one object and routes between them never. Cardinality, volatility, the pressure ramp, the preferred/fallback pair and the `search` exclusion (Spec #3202) are ours to write under either transport. **Adopting a client is not adopting a strategy**, and this ADR must not be read as having answered #3202.

**3. `gh` remains the credential broker and the mutation surface.** The token is sourced once, via `gh auth token` or the ambient `GH_TOKEN`/`GITHUB_TOKEN`. Commands that are commands rather than reads — `gh pr merge --auto`, `gh run`, `gh release` — stay on the CLI, where they work and where the operator can reproduce them by hand. **We are removing a translation layer from the read path, not removing `gh`.**

**4. The plugins are used, not reimplemented.** `@octokit/plugin-throttling` replaces recognising a rate limit by matching stderr; `@octokit/plugin-retry` replaces bespoke transient handling; `@octokit/plugin-paginate-rest` supplies the iterator whose page count Spec #3202's batching rule must price. Response headers — `ETag`, `X-RateLimit-*`, `Retry-After` — arrive as data instead of as text to re-parse, which is what makes the budget ledger cheap to keep honest.

**5. The read path migrates first, one slice at a time.** #3207 (conditional requests on the poll path) is the first, because it touches this code anyway and because it is where the CLI boundary hurts most. A slice lands with its own tests and its own changeset.

**6. A big-bang migration of the 81 direct `gh` call sites is refused.** They migrate by convenience or not at all. A rewrite of every call site during a throughput crisis buys a tidier tree and no delivered fix, and the chokepoint exists precisely so the transport can change without touching them.

## Consequences

**What gets cheaper.** A class of defect disappears rather than a case: there is no argv to assemble, so there is no `-R` to misplace. Roughly 400–500 lines of translation retire — argv assembly, stderr-pattern quota detection, and the half of the conditional-request path that reconstructs a `304` from an exit code and header text. The remaining ~700 lines are routing and event-loop policy that survive by design.

**What gets more expensive.** The dependency tree grows (`@octokit/rest` carries four direct dependencies, `graphql` three, `throttling` two) and every host downloads the bundle that contains it, so the size is worth measuring on the first slice rather than assumed. We inherit token lifetime as our problem where `gh` handled it: an expired credential now surfaces as our error, and must say so in the operator's language rather than as an HTTP 401 nobody can act on.

**What must not happen.** A `304`, a rate-limited response and a network failure are three different answers, and the typed client makes them easy to collapse into one `catch`. The engine's hardest-won rule holds under the new transport: **an unreadable answer is not a negative one.** Every guard that exists today for that reason — `observed: false`, the absent-view sentinel, the unanswered balance outcome — keeps its meaning and keeps its test.

**How we will know it was right.** The first slice reports three numbers: lines removed, bundle delta, and whether the poll path's budget consumption falls. If the bundle grows more than the translation code shrinks and the poll spend does not move, the experiment has answered no and the remaining slices do not run.
