# @reddb-io/github

The single owner of the GitHub API-surface decision (ADR 0132 decision 4).

## Why it exists

`ghReadSurface` already knew which GitHub API every call used, and spent that
knowledge labelling failures. Nothing routed on it, and its default sent
everything that was not `gh api <path>` to GraphQL — so the hot path (`issue
view --json state,labels` and `pr view --json mergeStateStatus,…`, polled per
Worker per iteration) was single-object reads issued against the pool metered by
node points. Measured twice within one hour on one machine: GraphQL `0/5000`
while REST sat at `4891/5000`.

## The principle is cardinality, not frequency

A **single-object** read goes to REST. A **multi-node** listing or a
**multi-repository** aggregate goes to GraphQL. Cardinality is decidable
statically and never changes for an operation; a frequency or budget-symmetry
policy needs telemetry that does not exist and answers differently each release.

`surfaceForCardinality` is the whole rule, and `assertGithubRoutingTable`
refuses a read entry that states anything else. The one exception is declared,
not silent: `only` marks a resource that just one API exposes (Actions runs,
Releases, the search endpoints), where there is no routing choice to make.

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

A field with no single-request REST equivalent is **named, not approximated**:
`comments` (REST carries a count, not the list), `author` (gh normalizes a bot to
`app/<name>`, REST reports `<name>[bot]`), `statusCheckRollup` (a second and
third request). Those come back as `{outcome: "unavailable"}` with the blocking
fields, and the caller keeps its GraphQL call.

## Consumers

`apps/dev` (the read boundary and the migrated single-object reads),
`apps/redskilled` (the daemon's multi-repository activity query) and
`packages/red-castle` (the tracker adapter) all import this package. One table,
because two implementations of one routing rule drift.
