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

**Per-lifecycle shape** (from `apps/dev/src`, verified in code):

- **Goal-predicate poll is the dominant per-worker cost**: `deps.gh.issueClosed`
  → REST `GET /repos/{o}/{r}/issues/{n}` at `DEFAULT_GOAL_POLL_MS = 60_000`
  (`apps/dev/src/core/execution/runtime.ts:147`) for the entire agent run,
  unconditional and uncapped — ~1 request/minute/worker; `orphanState`
  (`runtime/gh/sweeps.ts`) is the same read per drain iteration. That is the
  ~2/min baseline visible on every worker in the ledger.
- Claim + trust gate: ~5–12 requests (label read, claim comment POST, 1–3
  read-back verifies, up to ~7 trust-gate reads — mixed REST/GraphQL).
- Comments during the run: 3–6 `POST /issues/{n}/comments` + paginated guidance
  reads.
- PR create: 2–3 (`gh pr list` GraphQL + `pr create` + list again).
- Check waits (`apps/dev/src/core/merge.ts`): review wait `gh pr checks --json`
  ≤30 polls @10s (opt-in); **CI-aware wait `pr view --json
  …statusCheckRollup` up to 180 polls @10s — GraphQL, and the rollup costs two
  further server-side check/status requests** (`rest-plan.ts:151`); merge-queue
  wait ≤180 polls @15s but REST-planned via `planGithubRestRead`.
- Merge + stale-branch recovery: 1–8; close + cascade: 3 + 2 per dependent.
- Reconcile sweep: 4 concurrent `gh issue list --label …` (GraphQL) + per-
  candidate repairs — matching the ~25-request bursts every 5 minutes on the
  top-burner worker `hZ77P` (318 requests in the busy hour).
- `mergeExec` (`runtime/git.ts:814`) applies quota backoff but **bypasses the
  reserved-band gate** — the landing path is the one path not band-admitted.

**rsp** (`apps/rsp/src`, `.red/state/rsp/`): `rsp gh pr|issue|run list|view` is
request-neutral (output shaping); `rsp gh issues|prs` batch N reads into aliased
GraphQL; `rsp gh-api-json` is the request-reducing conditional path with a
durable on-disk ETag store (`.red/state/rsp/gh-etag/`, 7 entries, 888 KB).
**Critical finding: `gh-api-json` was self-disabled during the measured window**
(`overhead-budget.toon`: 71 breaches / 85 invocations, `overhead-exceeds-savings`
+ `self-state-byte-ceiling` — one 776 KB ETag entry pushes self-state reads to
2.31 MB against a 1 MB ceiling; `disabled_until 2026-08-05T01:15Z`). While
disabled, `listCandidates` and the statusline search counts fall through to raw
`gh issue list` / `gh api graphql`, and all 243 top-level `gh` rows in the
telemetry spool are `passed, disabled`. `rsp wait pr` polls 3 conditional REST
calls (`pulls/{n}`, `commits/{sha}/status`, `commits/{sha}/check-runs`) per
cycle at 15s with backoff — the cheap version of the engine's CI-aware wait.

**Actions-side** (`.github/workflows/`, separate per-repo `GITHUB_TOKEN` budget,
1,000/hr): `red-reactive-mechanical` is heaviest per event (up to ~23 gh call
sites; 3–8 per comment event); `red-publish` runs an **hourly** cron (1–4
release-API calls per run); `red-{brand,toon,upstream}-watch` are daily (3–4
calls each); `red-pr-review` and `red-issues-needs-triage` are per-PR/issue
event (2–7). Scheduled floor ≈ 10/day daily + ≤96/day hourly publish retries.

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

1. **Workers' raw `gh api` + goal poll (616/hr busy, 0% conditional).** The
   engine's goal-predicate poll (`issueClosed`, REST issue read every 60s per
   worker, uncapped) plus per-iteration `orphanState` are stable polls issued
   unconditionally. Cheapest win: give the worker gh shim the same ETag
   treatment the daemon poll already has — a repeated single-object read against
   an unchanged issue is the textbook 304; the daemon proves the machinery works
   (91–97% hit rate on the identical route family).
2. **Workers' `issue list` (307/hr busy, charged every time) — largely a
   regression, not a design cost.** rsp's request-reducing `gh-api-json`
   conditional path was self-disabled during the window (`overhead-budget.toon`:
   `self-state-byte-ceiling` breached by one 776 KB ETag entry), so
   `listCandidates`, sweeps and statusline reads fell through to raw `gh issue
   list`. Cheapest win: fix the overhead-budget breach (cap or split the
   oversized ETag entry) so the already-built conditional path turns back on;
   second, serve worker queue reads from the daemon's already-warm validator+
   collection instead of re-buying per worker (~19/hr vs ~307/hr).
3. **Engine checks/merge polling (`merge.ts`): the CI-aware wait polls `pr view
   --json …statusCheckRollup` up to 180 times @10s — GraphQL, with the rollup
   costing two further server-side checks/statuses requests per poll.** The
   merge-queue wait beside it is already REST-planned, and `rsp wait pr`
   already does the same job as 3 conditional REST calls @15s with backoff.
   Cheapest win: route the CI-aware wait through the rsp-wait probe shape
   (conditional `pulls/{n}` + `commits/{sha}/status` + `check-runs`) instead of
   the GraphQL rollup view.

Adjacent fix worth one line: `mergeExec` (`apps/dev/src/runtime/git.ts:814`)
applies quota backoff but bypasses the reserved-band admission gate — the
landing path is the only gh path not admitted through the band.

One more structural note, not a burner today: the daemon's ETag store is
memory-only by explicit TODO ("callers may provide a durable implementation
later"), while rsp already persists ETags to disk. Persisting the daemon store
would make restarts free as well; at current scale the cost is only ~3 charged
requests per restart, so it ranks below the three above.
