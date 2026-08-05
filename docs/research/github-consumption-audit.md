# Audit: where RedSkills' GitHub requests actually go today

Research ticket #3383 (map #3381). Measured 2026-08-05 from code and from the
durable spend ledger — not estimated from architecture docs.

## Sources

- Code: `apps/redskilled/src/{queue-discovery,repository-activity,daemon}.ts`,
  `packages/github/{conditional-client,balance,surface,rest-plan,aliased-query}.ts`,
  `apps/dev/src/core/merge.ts`, `apps/dev/src/runtime/gh/`, `.github/workflows/`.
- Ledger: `~/.red/redskilled/state/github/spend.toonl` — 17,612 attributed
  requests over 2026-08-04T10:57 → 2026-08-05T16:5x; 8,633 charged (`cost=1`),
  9,049 free (`cost=0`, ETag `304` revalidations).
- Daemon log `~/.red/redskilled/redskilled.log.toonl` records lifecycle events
  (worker-birth/death, demand-refusal), **not** GitHub requests — the spend
  ledger is the request-level record.
- rsp: `.red/state/rsp/rsp-telemetry.spool.toonl` and `.red/state/rsp/gh-etag/`.

## 1. The daemon poll shape

**Queue discovery** (`queue-discovery.ts`): one conditional REST request per
project per cycle — `GET /repos/{owner}/{repo}/issues?state=open&labels=<selector>`
(the `ready-for-agent` selector) via `createGithubClient().conditionalPaginate()`.
Configured cadence `DEFAULT_REDSKILLED_QUEUE_MS = 15_000`, adaptive backoff to
`REDSKILLED_QUEUE_MAX_BACKOFF_MS = 100_000` under rate-limit pressure.

**Observed** (busy hour 2026-08-05T15): 220 cycles/hour, exactly 3 requests per
cycle (3 registered projects), median inter-cycle gap **16.4s** (15s cadence +
execution time). Idle hour (T06): 231 cycles, 1 request/cycle (1 project).

**ETag conditionals work**: 91% of all 9,920 queue-poll requests over the window
were `304`s costing zero primary quota; in the busy hour 660 polls cost only
**19 charged requests** (97% hit rate).

**ETag cache lifetime**: `createMemoryGithubEtagStore()`
(`packages/github/conditional-client.ts:40`) is an in-memory `Map`, documented as
"a daemon-lifetime store. Callers may provide a durable implementation later."
The queue transport is armed once per daemon (`daemon.ts` `armQueueTransport`
guards `queueTransport != null`), so ETags survive across polls but **die on
daemon restart** — every restart cold-starts one charged 200 per project per
collection. rsp, by contrast, already persists its ETags to disk
(`.red/state/rsp/gh-etag/*.toon`).

**Repository activity** (`repository-activity.ts`): 3 conditional lists per
project per 60s cycle (`GET /pulls?state=open`, `GET /issues?state=open`,
`GET /issues?state=closed&since=<7d>`), `DEFAULT_REDSKILLED_ACTIVITY_MS = 60_000`.
**Measured: zero ledger entries** under `redskilled repository activity poll` —
the activity poll is not registered on this host today (`pollRepositoryActivity`
returns null when `activityRegistration == null`). If enabled it would add
180 conditional requests/hour per 3 projects, mostly free after warm-up.

**Balance** (`balance.ts`): `GET /rate_limit`, free of primary quota, adaptive
cadence: 600s healthy (>50%), 120s below half, 30s inside the 15% reserved band,
15s when spent (`GITHUB_BALANCE_MIN_CADENCE_MS` floor). 6–240 requests/hour, all
free; not recorded in the spend ledger. Two declared owners poll it: the daemon
and the rsp resident (#3311).

## 2. What agents add (worker-attributed spend)

All non-daemon spend in the host ledger is worker-attributed via the `gh` shim
(94 distinct `worker:*` actors over the window). Charged mix, busy hour T15
(1,099 worker requests, all charged — 0% ETag on the worker path):

- `api rest` **616** — raw `gh api <path>` calls (checks/status/misc REST reads);
  the single biggest charged family.
- `issue list` **307** (REST since the Aug-5 router cutover; was GraphQL until
  ~05:00, first REST entries ~10:00).
- `repo view` 31, `pr list` 25, `issue list (search)` 24 (Search pool),
  `api graphql` 24, `issue comment` 19, `issue edit` 17 (GraphQL), plus
  single-digit `label create`, `issue view`, `pr create`, `pr merge` (GraphQL),
  `issue close` (GraphQL), `pr view`, `pr edit` (GraphQL).

**Per-lifecycle shape** (`apps/dev/src/core/merge.ts`): the engine's review-check
wait polls `gh pr checks <n> --json name,state` every **10s, up to 30 polls**
(5 min budget) per landing, and CI-aware merge polls
`pr view --json mergeStateStatus,statusCheckRollup` until the PR settles. The
top-burner worker `hZ77P` (318 requests in the busy hour) shows the resulting
shape: a ~25-request burst every 5 minutes plus a ~2/min baseline —
checks/merge polling plus periodic sweep listings dominate a worker's spend.

**rsp** (`.red/state/rsp/`): durable per-command ETag store on disk; its
telemetry spool (Aug 2–5, interactive agents) shows the gh mix: `pr view` 237,
`issue list` 192, `issue view` 173, `pr list` 124, `issue create` 101,
`pr checks` 80, `pr merge` 74, `gh api` ~135, `label create` 61, `api rate` 46.

**Actions-side**: 5 scheduled workflows (`red-brand-watch`, `red-mcp-lane-canary`,
`red-upstream-watch`, `red-toon-watch` daily; `red-publish` retry cron) plus
event-triggered CI. These spend the per-repo `GITHUB_TOKEN` Actions quota
(1,000/hr, a separate budget), not the operator token measured above.

## 3. REST vs GraphQL split (packages/github, ADR 0132/0133)

Router policy: **volatility first, cardinality second**. Stable polls →
conditional REST (free 304s); one-shot single-object → REST with GraphQL
fallback; multi-node/multi-repo listing → GraphQL; Search-pool operations
(30/min) can never be fallback targets. `singleObject()` coalesces cold
same-kind bursts into one aliased GraphQL query when the count exceeds the
live REST/GraphQL headroom ratio; warm (ETag-held) objects never leave REST.

Measured pool split (busy hour, charged): **REST 1,042 / GraphQL 52 / Search 24**.
GraphQL carries the mutations gh routes there (`issue edit/close`,
`pr merge/edit/ready`) and residual listings; the expensive GraphQL shape is the
aliased multi-project query (points = node count, not request count) — currently
small because the conditional-REST migration took the stable polls off GraphQL.
Ledger shows the `issue list` GraphQL→REST cutover mid-window on Aug 5.

## 4. The table

Requests/hour, from the ledger (busy = 2026-08-05T15, idle = 2026-08-05T06).
"charged" excludes free 304s and free `/rate_limit` polls.

| Consumer | Route family | Busy (total / charged) | Idle (total / charged) |
|---|---|---|---|
| redskilled queue poll | REST `GET /repos/{o}/{r}/issues` (conditional) | 660 / 19 | 231 / 6 |
| redskilled activity poll | REST `/pulls`, `/issues` (conditional) | 0 (not registered) | 0 |
| redskilled + rsp balance | `GET /rate_limit` (free) | ~6–120 / 0 | ~6 / 0 |
| workers: raw `gh api` | REST misc (checks, statuses, repos) | 616 / 616 | 7 / 7 |
| workers: `issue list` | REST issues list | 307 / 307 | 0 |
| workers: single-object views | REST `issue/pr/repo view` | 41 / 41 | 2 / 2 |
| workers: listings | REST/GraphQL `pr list` | 25 / 25 | 2 / 2 |
| workers: Search | `GET /search/issues` (Search pool) | 24 / 24 | 0 |
| workers: mutations | GraphQL `issue edit/close`, `pr merge/edit` + REST `comment/label/create` | 62 / 62 | 8 / 8 |
| Actions workflows | Actions `GITHUB_TOKEN` (separate 1,000/hr budget) | event-driven + 5 daily crons | ~0 |
| **Total (operator token)** | | **1,759 / 1,118** | **248 / 23** |

Peak charged burn ≈ 1,100–1,140/hour ≈ 22% of the 5,000/hour REST pool with 3
projects and ~8 concurrent workers.

## 5. Top-3 burners and the cheapest structural win for each

1. **Workers' raw `gh api` (616/hr busy, 0% conditional).** Cheapest win: route
   repeated same-path `gh api` reads through the shim into
   `conditionalPaginate`/ETag storage the way the daemon poll already does — the
   busy-hour shape (identical 5-minute bursts) is exactly the stable-poll shape
   the conditional client was built for.
2. **Workers' `issue list` (307/hr busy, charged every time).** Same listings
   the daemon already polls conditionally. Cheapest win: serve worker queue/list
   reads from the daemon's already-warm answer (it holds the collection plus
   validator) instead of re-charging per worker — the daemon pays ~19/hr for
   what workers re-buy ~307 times.
3. **Engine checks/merge polling inside `api rest`/`pr checks` (10s interval,
   30 polls per landing).** Cheapest win: conditional requests on the checks
   endpoints (they return validators) or a coarser adaptive interval after the
   first pending answer — a 10s fixed poll against an unchanged rollup is the
   textbook 304 candidate.

One more structural note, not a burner today: the daemon's ETag store is
memory-only by explicit TODO ("callers may provide a durable implementation
later"), while rsp already persists ETags to disk. Persisting the daemon store
would make restarts free as well; at current scale the cost is only ~3 charged
requests per restart, so it ranks below the three above.
