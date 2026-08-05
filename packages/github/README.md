# @reddb-io/github

The one budget-aware GitHub client (ADR 0132 decision 4, as superseded by
Amendment 2).

## Why it exists

`ghReadSurface` already knew which GitHub API every call used, and spent that
knowledge labelling failures. Nothing routed on it, and its default sent
everything that was not `gh api <path>` to GraphQL — so the hot path (`issue
view --json state,labels` and `pr view --json mergeStateStatus,…`, polled per
Worker per iteration) was single-object reads issued against the pool metered by
node points. Measured twice within one hour on one machine: GraphQL `0/5000`
while REST sat at `4891/5000`.

## Volatility first, cardinality second

A stable poll prefers REST because a conditional request can cost no primary
quota while its answer is unchanged. A one-shot read then follows cardinality:
a **single-object** read prefers REST, while a **multi-node** listing or a
**multi-repository** aggregate prefers GraphQL.

Every operation also declares a fallback client method or states why none is
safe. `assertGithubRoutingTable` enforces that pair. An `only` constraint remains
absolute, and operations drawing from the minute-metered Search pool cannot be
fallback targets. A single-object issue read is therefore REST-preferred with a
GraphQL fallback, while an Actions read has no invented second path.

## Stable polls use conditional REST

Volatility is the exception cardinality cannot price. The daemon's repository
activity and queue discovery reads repeat against usually unchanged collections,
so their production transport uses repository issue and pull-request list
endpoints through `createGithubClient().conditionalPaginate()`. GitHub's Search
endpoint did not return a validator in the migration measurement, while these
list endpoints did. The first `200` stores each page with its `ETag`, and the next
request sends `If-None-Match` per page. A `304` reuses the stored page and records
zero spend; it never becomes an empty answer. Rate-limit refusals and network
failures still fail and cannot fall back to the stored value.

The client is built from `@octokit/rest`, retry, throttling, and the pagination
plugin bundled by REST.js. Interactive and not-yet-migrated reads keep their
existing route while migration proceeds one slice at a time under ADR 0133.

## Three budgets, not two

| Pool      | Metered by  | Limit    |
| --------- | ----------- | -------- |
| `rest`    | request     | 5000/hr  |
| `graphql` | node points | 5000/hr  |
| `search`  | minute      | 30/min   |

An operation declares its budget separately from its surface, because GraphQL's
`search` connection draws the Search pool rather than the node-point pool. ADR
0130's claim that one aliased query makes cost "flat in the number of projects"
is true of request count and false of points.

## An unclassified operation fails loudly

`routeGithubArgs` raises `UnclassifiedGithubOperationError` naming the key it
derived and the file to add it to. Adding a gh call to this repo means adding a
line to `GITHUB_OPERATIONS`; it does not mean inheriting whichever pool the old
default happened to pick.

## Realizing the route

Deciding that a read belongs on REST changes nothing on its own — `gh issue view
--json state` runs a GraphQL query regardless. `planGithubRestRead` returns the
`gh api repos/{o}/{r}/issues/{n}` argv plus a decoder projecting the REST body
back into the shape `--json` would have printed, so a call site swaps its argv
and keeps its parsing.

That argv planner remains for call sites not yet migrated. The stable daemon poll
path is the first typed-client slice: it calls REST directly through Octokit,
keeps validators with their response bodies, and attributes a changed response
as cost one and an unchanged response as cost zero.

A field with no single-request REST equivalent is **named, not approximated**:
`comments` (REST carries a count, not the list), `author` (gh normalizes a bot to
`app/<name>`, REST reports `<name>[bot]`), `statusCheckRollup` (a second and
third request). Those come back as `{outcome: "unavailable"}` with the blocking
fields, and the caller keeps its GraphQL call.

## Inner agents share the boundary

An AFK implementer's raw `gh` resolves first to a private shim in the Worker's
disposable workspace. The shim classifies the argv through this package, admits
it against the daemon's kept token-wide balance as convenience work, applies the
same bounded quota retry as engine calls, and forwards to the captured real
binary. Unclassified operations fail closed instead of inheriting a guessed
pool. Every issued invocation, including a retry, is appended to the attribution
ledger with the Worker as `actor`; the canonical operation key stays canonical.

This attribution remains local evidence, not a reconstructed balance. REST cost
is one request; because `gh` does not expose GraphQL node cost, the shim records
the minimum observed cost of one while the exact invocation count and Worker
identity remain available for incident attribution.

## The balance is asked, never counted

The design this replaced was a ledger the daemon **accumulates**: every caller
reports its calls, the daemon totals them. That ledger would have been born
blind. The daemon is host-scoped by construction while a GitHub quota is per
**token**, therefore cross-host — an operator running four machines on one token
would have had four daemons each reporting a quarter of the truth.

`GET /rate_limit` answers for the whole token across every machine and costs
nothing: measured, six consecutive calls moved `core` by exactly zero.
`fetchGithubBalance` asks it; `GithubBalance.origin` is the single literal
`"asked"`, so a counting path cannot construct one without declaring an origin
that does not exist. The ratchet that refuses the accumulator itself lives in
`apps/dev/src/core/asked-balance-guard.ts` and runs in every gate run.

**Free of *primary* quota only.** GitHub's secondary limits on request rate and
concurrency apply to `/rate_limit` like any other endpoint, so the cadence stays
a cadence — `GITHUB_BALANCE_MIN_CADENCE_MS` is the floor, and that ceiling was
deliberately not probed.

## Cadence is a function of the balance

Because asking is free, `githubBalanceCadenceMs` derives the window rather than
fixing it: rare above half, tightening as the balance falls, continuous once
spent — when the only event that still matters is the reset. A fixed cadence has
to choose between being slow at the edge and wasting polls in the middle; an
adaptive one does not choose. **One poller, the daemon's, never a check before
each call**: that would double the request count and put a synchronous round trip
in every hot path.

The curve is driven by the TIGHTEST pool, not by an average. The measurement that
produced this module — 2200 GraphQL points spent while `core` sat at `5000/5000`
— is exactly the shape an average would have called healthy.

## A reserved band, so degradation is graduated

`GITHUB_RESERVED_FRACTION` of each pool is held for work that must not fail.
`admitGithubCall` refuses a `convenience` call once the balance enters the band
and admits an `essential` one until the pool has nothing left at all, where
GitHub would refuse it anyway. Criticality is stated by the CALLER, never tabled
here: `issue comment` is a finished Worker's closing comment on one call and an
optional progress note on the next.

So semi-offline stops being a mode discovered through a 403 and becomes a posture
entered at a threshold an operator can see. `buildGithubBalanceReport` is what
they see it on.

## A cache that carries its own age

`createGithubCache` keeps counts, bodies and states, and every read comes back
with `age_ms` and an outcome. A stale entry is **labelled, never dropped** — that
is the point: there is nothing to fall back to unless something was kept, and a
cache that evicted on expiry would be empty exactly when the band starts refusing
the reads that would refill it.

## Consumers

`apps/dev` (the read boundary, the migrated single-object reads and the reserved
band in `runtime/gh/band.ts`), `apps/redskilled` (the daemon's conditional REST
pollers and its one balance poller) and `packages/red-castle` (the tracker
adapter) all import this package. One table, because two implementations of one
routing rule drift — and one balance, because two would be two fictions.

The old aliased GraphQL path remains available to injected migration adapters and
states its point cost explicitly. Production stable polls accept N sequential
round trips instead: unchanged collections answer `304`, so the API budget pays
only for the repositories whose representation actually changed.
