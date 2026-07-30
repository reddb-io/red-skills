# @reddb-io/red-skills

## 2.88.1

### Patch Changes

- 245fe65: A rate-limited conditional poll waits for the reset instant instead of retrying at the floor (#2802). The ETag polling transport swallowed every fault in one bare `catch` and slept its floor interval, so a rate-limit response — the one fault whose cure is time — kept the loop issuing requests at floor cadence for the whole window, adding pressure to a quota already at zero and competing with the worker path for whatever budget returned first. The error path now classifies with the existing owner of the quota taxonomy (`runtime/gh/quota.ts`) rather than a second local matcher: a rate-limited poll raises `EtagQuotaExhaustedError` carrying the pacing the response supplied, and the loop sleeps until `x-ratelimit-reset`, else honours `retry-after`, else falls back to the floor. The wait is clamped to the floor below and to the same 30-minute cap the worker path's backoff uses above, and it announces itself through `onQuotaWait` so a long sleep is not indistinguishable from a hang. A generic transport fault keeps the floor-interval retry, and the parts that already worked are untouched: conditional requests still send `If-None-Match`, a `304` still costs no quota, and a successful poll still honours the server's `X-Poll-Interval`.
- dd3ea0b: A fleet relaunch runs the published bundle instead of the launching process's own (#2808). The boot probe is right to halt a Worker whose supervisor is older than the published release, but the fix it prescribed — "restart the fleet from the current bundle" — could not be performed: the launch built the supervisor's argv out of `process.argv[1]`, so relaunching through the MCP spawned the supervisor from the MCP server's plugin-cache bundle. A fleet stranded at 2.87.6 was relaunched into 2.87.5, a wider skew than before, and 21 Workers died in 20 minutes with one cause, none reaching the point of claiming an Issue — presenting to the operator as "the fleet is not pulling", indistinguishable from an empty queue. The launch now resolves the published version and spawns from an entry that runs it (cached bundle, the bundle shipped beside the caller, then a version-pinned dispatch), names the redirect in its output, and refuses loudly when the published version cannot be resolved rather than silently starting an older bundle. The probe and the launch read one definition of "published" (`resolvePublishedDevBundleVersion`), so after a launch the supervisor's version is the version the probe compares against — the prescribed remedy clears the finding it is prescribed for. A local source build still runs its own bundle: an unreleased version is not a point on the published lane.
- ac14a1f: An exhausted GitHub read raises instead of rendering as an empty result set (#2801). Every gh JSON read in the dev runtime collapsed failure into absence with `if (r.code !== 0) return []`, and an empty result is a confident, well-formed, wrong answer: a PR listing that never ran came back as "no pull requests are open" while two were open, and reading it at face value supported the conclusion that the work had merged. GraphQL made it worse — an exhausted query can exit 0 with a null-filled `data` block and a `RATE_LIMITED` entry in `errors`, so even the exit code said nothing. The new read boundary (`runtime/gh/read.ts`) decides once for every consumer: a query that could not run raises `GhReadError`, a query that ran returns its rows even when there are none, and the raised failure carries the transient quota classification so the existing bounded wait-and-retry applies rather than a generic failure path. The open-PR and queue counters, the statusline count cache, the deadend audit and the dashboard read through it, so a failed read keeps the last known counts or fails loudly instead of publishing a false zero.
- dd2c5db: The gh quota backoff is on by default in the shipped binary instead of being an option only a test populated (#2800). `apps/dev/src/runtime/gh/quota.ts` already classified GitHub primary limits, secondary/abuse limits and GraphQL `RATE_LIMITED` as transient and already had the bounded wait-and-retry, but both call boundaries — `runGh` and the `gh`-headed branch of `mergeExec` — took a bypass branch unless a `quotaBackoff` option was present, and the only file in the tree that populated one was `tests/landing-quota.test.ts`. So the suite injected the option, exercised the retry and passed while a live drain hit `0/5000` and died immediately with no wait, no retry and no `quota-wait` activity. Both boundaries now resolve their options through `resolveGhQuotaBackoff`: injection still wins, and its absence means the documented 60-second wait under a 30-minute cap rather than "disabled". The wait announces itself as a `quota-wait` notice so an operator reads a bounded wait instead of silence, `RED_GH_QUOTA_WAIT_MS` / `RED_GH_QUOTA_CAP_MS` tune it without a code change (cap `0` refuses the wait), and the read-only boot probes in `gh/auth.ts` opt out explicitly because they classify a rate limit as transient themselves and must not stall boot. A new repo-wide invariant, `invariants:shipped-primitives`, fails when a declared safety primitive has no non-test enabler anywhere under `apps/` or `packages/`, so an implemented-and-never-enabled primitive cannot recur behind a green suite.
- 16977f6: A GitHub quota failure is recognised as quota at every boundary that classifies failures (#2830). Two boundaries re-derived the taxonomy locally and each got it wrong in its own way: the structured-error surface matched a rate-limit body and returned it as a real error whose suggested remedy was `gh auth status`, sending the operator to inspect a token that was perfectly fine; and the runner-spawn exhaustion detector, written for the AI-runner signals (usage limit, weekly cap, `rate_limit_error`, 429, insufficient credit), matched none of GitHub's shapes — its primary limit is a **403** — so a GitHub quota failure fell through to a generic failure instead of the bounded quota recovery path those signals already reach. The taxonomy of primary limits, secondary and abuse limits, and GraphQL exhaustion now has exactly one owner, `@reddb-io/shared/github-quota.js`, and both boundaries read it: a rate limit classifies as `transient` and its help describes the wait, and a 403-shaped primary limit maps to the `quota` recovery reason. Permanent failures are untouched — an authentication failure still classifies as an authentication problem with the authentication remedy, and a not-found still classifies as a not-found.
- 80111f2: A merge rejected for an out-of-date branch is repaired in the landing lane instead of parked as `blocked:ci` (#2807). Every `gh pr merge` refusal was recorded as "usually because branch protection or CI is not satisfied" — a guess, and the wrong one on two green, `mergeable=true`, `CLEAN` PRs whose only defect was that `<base>` had advanced between the readiness poll and the merge call. The `next:` step then sent a human to fix a failing required check that did not exist, while the issue parked `ready-for-human` and stopped every dependent below it. The landing now reads the PR back after a rejection and classifies the OBSERVED cause: an out-of-date branch is updated (`gh pr update-branch`) and re-merged — bounded to two rounds, re-waiting for green when the landing is CI-aware — which is exactly what a human does. A failing check, a conflict, an unreported rollup, and a protection rule that is not a check are each named verbatim in the terminal note, and the recorded `next:` points at that observed reason rather than asserting a check that may well be green.
- f572c10: One owner answers "what version is published", and every surface derives from it (#2809). The operator-facing fleet status read `bundle_latest` from a locally-cached notion of latest while the Worker boot probe resolved a different one, so during an outage the dashboard reported `version_skew: 0, health: healthy` against 2.87.5 while every Worker was boot-halting on the real published 2.87.7 — the two-source contradiction ADR 0128 §5 forbids for liveness, appearing here for version, with the surface a human reads being the wrong one. The published version now has a single resolution (`core/published-version.ts`) that the boot probe, the MCP status tool, the `fleet status` CLI and the monitor render all consume: the path that pays for the registry call records its answer, and every later local read replays that same answer instead of deriving its own. The installed version is never substituted as "the published one" — that substitution is what manufactured a confident verdict out of a value that measured nothing, so an unresolvable published version now reports `published_unknown: 1` with no skew verdict, kept distinct from a measured match of zero skew. Staleness travels inside the payload: `published_version` carries the answer's source, age, threshold and stale flag, so a cached bundle reads as `cache-only` evidence and an aged-out registry answer reads as `aged-out` rather than as current.
- fdc05ae: The MCP lane canary now walks the socket boundary the lane grew under ADR 0130 (#2794). A Worker's process liveness resolves over a unix socket to the `redskilled` daemon, so the MCP server answering stopped being evidence that the lane behind it answers: with a dead socket every tool still replies and the verdict quietly degrades to `unknown`, which is the same silently-inert shape as #2677 with one more process in it. The walk gains a `daemon_reach` step between `worker_spawn` and `project_status`: it reads `worker_vitals` over the real transport for a worker it watched appear on disk — never for whatever row the reader happens to list, because a payload about no work is the false green the probe exists to refuse — and fails loudly when the published verdict was reached without the daemon's participation, naming the boundary rather than reporting "the lane did nothing". The daemon's silence sentence has one owner now (`DAEMON_SILENCE_REASON` / `isDaemonSilence`), so a reachable tool over an unreachable daemon cannot read as a daemon that simply never birthed the Worker. The e2e harness runs the real daemon binary on a session socket pinned per sandbox and asserts both directions: daemon up goes green, daemon down goes red at `daemon_reach` with every earlier step still green.
  - @reddb-io/shared@2.88.1
  - @reddb-io/build-info@2.88.1

## 2.88.0

### Patch Changes

- @reddb-io/shared@2.88.0
- @reddb-io/build-info@2.88.0

## 2.87.7

### Patch Changes

- 0e51608: A pending CI rollup no longer parks a healthy attempt as `blocked:ci` (#2747). The landing tail classified a `BLOCKED` PR whose required checks had not reported yet as ready to merge — the state every PR passes through in the seconds after it opens — so branch protection rejected the merge and the landing path parked that rejection as `blocked:ci`, converting finished work into HITL backlog on a PR that never carried a failing check. `classifyMergeState` now takes the base branch's required contexts into account: a required check with no verdict in the rollup, an empty rollup, or an unreadable one keeps the attempt waiting inside the tail instead of merging into the hole. Only a check that actually concluded unsuccessfully still classifies as `ci-failed`, and a `BLOCKED` PR whose required checks all reported green still attempts the merge, so the required-review handoff is unchanged.
- 1903dac: A park no longer survives on a closed issue (#2749). A park was treated as terminal, but it is not: parked work still lands — by a human merge of its PR, by a later retake, by an adopt-branch landing — and when GitHub's own PR-closes-issue mechanism performs the close, no engine path was watching to reconcile what the park left behind, so delivered slices stayed closed wearing `ready-for-human` + `blocked:ci` and any audit of label history read them as human-escalated. Closing is now a first-class `close` transition in the ADR 0122 API: it targets no state role at all, so the planner strips every role, the `running` projection, the blocked reasons, and the `req:*` edges in one proven-coherent mutation, while permanent markers such as the Spec child label, `type:*`, and `priority:*` ride through untouched. The `hitl_resolve` close decision routes through it before closing, and the ADR 0122 curator reconciles closes that originated outside the engine — one bounded `label:"a","b"` search per sweep over closed issues still carrying a state role, never a per-label loop.
- 3babd9a: The AFK gate now runs the repo-wide invariant suites in every cone-scoped run (#2762). A worker that changed one package validated only that package's cone, so a ratchet that constrains the whole repo but lives in a single package — the TOON JSON file-I/O allowlist in `apps/dev` — never ran in the loop where the agent could still satisfy it; it first fired in root CI, after the correction budget was spent, which is how the same assertion failed three PRs in one hour. The suites are declared in `apps/dev/src/core/repo-invariants.ts` and run after the scoped checks whenever the cone does not already cover them, via `pnpm -C apps/dev test:invariants`. A missing script emits a visible `skipped` record rather than a silent drop, a repo without the owning package stays silent, and the baseline probe re-runs the invariant script itself instead of the owning package's full suite. The ratchet's own failure is now actionable: it names each offending path, the allowlist file that classifies it, and the recurring cause — a `*.toon` path written with `JSON.stringify`, which the decoder tolerates at runtime and policy does not.
- 54b36ab: The re-seeded prompt now carries CURRENT OUTSTANDING STATE instead of the last trigger's block (#2728, ADR 0129). Three appenders — the `/afk` gate correction, the `/go` machine-gate retry, and the tier escalation — each rebuilt the prompt from the ORIGINAL handoff, and so did the adversarial-review correction; every one of them discarded whatever the previous round had appended. A gate round that followed a blocking review therefore re-instructed the implementer with the gate tail alone, leaving round N blind to findings rounds 1..N-1 had already confirmed. `reseed-handoff.ts` composes one `<outstanding-state>` section instead: the current gate tail and the current review findings together, deduped so a finding raised by more than one source appears once, bounded by the same 80-line tail ruler the appenders used, plus one `<reseed-history>` line carrying the round out of the lane's ceiling, the tier now running, and the repeat count from the round's failure signature. A stage that goes green drops out of the section, so the prompt states what is still outstanding rather than archiving what was.
- 9db2496: A Re-seed budget exhausted with work still outstanding now parks WITHOUT closing its draft pull request (#2732, ADR 0129). A validation park is precisely the moment a human needs the diff open, so the draft is left standing and marked with the same `blocked:validation` label the Ticket carries — parked work and live work separate in one query instead of a join across two vocabularies. Both projections are sealed on the way out through one path: the trail's Issue comment is edited in place a final time and the draft's body is mirrored onto it, each carrying the rounds already spent plus the evidence that ended the budget, so the human queue starts from the diagnosis rather than from a search. Exhaustion parks identically whatever exhausted it — gate churn and a surviving blocking review finding take the same exit — and an attempt that never re-seeded has no trail to seal and parks exactly as it did before.
- a3c72ea: A REPEATED failure signature now escalates the model tier instead of spending another round at the one that just failed (#2729, ADR 0129 decision 6). The trigger used to be the failure itself, and only ever for a simple-tier semantic one: the first red feedback gate on a `simple`-classified Ticket bought `complex` whether or not the round had learned anything. It is now the repeat. `decideTierEscalation` compares the round's failure signature (#2724) against the previous round's and escalates one step along `validate → simple → complex → think` only when they are equal — a changed signature, including a failure set that merely shrank, is progress and is re-instructed at the tier that produced it. The ladder terminates rather than saturating: a repeat on the dearest tier has nothing left to buy and falls through to gate correction and, once that is spent, to the uniform park. The escalation draws the `tier` sub-cap, never the gate's, so gate correction keeps its own share while the tier moves.
- 9800243: The superseded correction vocabulary is deleted now that every call site draws from the one Re-seed budget (#2733, ADR 0129). `afk.stallConvergenceBudget` — the standalone post-DONE gate counter that stood beside the lane budget instead of inside it — carries an ADR 0117 tombstone in both spellings, so a repo that still sets it is warned `RETIRED` rather than left believing it tunes anything; its reader (`resolveStallConvergenceBudget`, `RED_AFK_STALL_CONVERGENCE_BUDGET`) is gone with it. The replacement is `dev.reseed.afk.gate_budget` (default 3, env `RED_RESEED_GATE_BUDGET`), which caps only the GATE's share of the budget: the ceiling and the review's reserved round belong to the lane profile, so a raised setting can neither buy an unbounded run nor consume the round a blocking review finding is entitled to. The `adversarial-correction` landing reason stays gone with a guard that fails if any shipped source reintroduces it — every non-ok landing outcome is now an actual landing failure.
- 37b944d: The Re-seed correction trail became visible without paying a pull request per attempt (#2731, ADR 0129). The first Re-seed of any cause opens a DRAFT pull request carrying the trail; an attempt that never re-seeds opens none and lands exactly as it did before, so a churning fleet no longer burns a CI run to document the majority of attempts that need no documentation. The Issue carries ONE comment upserted in place through the existing edit-comment primitive — five rounds are one notification rather than five — and the draft mirrors that same body plus the `Closes #N` link. Landing reuses the existing draft and marks it ready via `gh pr ready`, which is a no-op on a pull request that was never a draft; opening a second pull request is a defect, not a fallback. Both surfaces are best-effort projections: the Attempt record stays the source of truth, so a forge that refuses a post, a patch, or the draft itself costs fidelity on a projection and never a Re-seed round.
- fe23606: Review moved off the landing path and became the gate fold's third stage, running before any pull request exists (#2730, ADR 0129). The reviewer reads the WORKTREE diff against the merge base rather than a PR diff, and it runs only once the earlier stages are green — `gateVerdict` short-circuits at the earliest blocker, so the fold's most expensive stage never pays to review a branch the cheap stages already rejected. A reviewer that crashes yields a SKIPPED stage, which cannot block: infrastructure trouble in an advisory reviewer no longer threatens machine-validated work. A blocking finding requests a Re-seed through the unified path, drawing the RESERVED review round that gate churn cannot consume — three gate corrections used to spend every available round and the review's own round never fired. The adversarial decision function lost its cap-dependent branch: its verdicts are now `blocking` or `not-blocking`, and both the budget and the exhaustion rule live in the Re-seed budget, which parks uniformly. That is what revokes the behaviour where the documented default budget landed code carrying a known blocking finding.
- 99c13fe: The `rsp` `gh` ETag cache is now partitioned, bounded and reclaimed (#2745). It was a single document, read whole, decoded and rewritten on every `gh` call routed through rsp — measured at 10,255,444 bytes on this repo, with no size ceiling, no eviction and no partitioning by key, so the surface whose purpose is to make terminal work cheaper got more expensive every day it was used. The cache now lives as one TOON file per request key under `.red/state/rsp/gh-etag/`, so a lookup reads exactly the entry it needs and its cost stays flat as the cache grows instead of scaling with everything cached before it. Writes hold the lane to `rsp.ghEtagCacheMaxBytes` (default 4 MiB, also `RSP_GH_ETAG_CACHE_MAX_BYTES`), evicting oldest-first by stat alone so keeping the cache bounded never reintroduces the read tax it exists to remove. An interrupted atomic write no longer strands a zero-byte `.tmp` — the write path cleans up after itself, and `rsp sweep`, the janitor that already owns this lane, reclaims any orphan left by a killed process, migrates a legacy single-document cache into partitions once, and re-bounds what it finds. Both intents from the overhead budget survive: a self-disabled `gh-api-json` family still skips the cache entirely, and every partition read is still charged to the invocation's `self_state_bytes_read`.
- 09fc533: `rsp` now holds itself to an overhead budget and says so out loud (#2746). It measured only the savings it produced, so a wrapper that taxed every command — a multi-megabyte self-state file read per call, a resident that never answered — was indistinguishable from one that worked, because every failure mode is fail-open by design. Every invocation now records the cost side too: `overhead_ms` (wall clock rsp added, total minus the wrapped command's own runtime) and `self_state_bytes_read` (bytes read from rsp's own caches, spools and ledgers), alongside the bytes saved. A sample breaches the ceiling when it adds more than `rsp.overhead.maxOverheadMs`, reads more than `rsp.overhead.maxSelfStateBytes`, or reads more of its own state than it removed from the agent's context; after `rsp.overhead.consecutiveBreaches` consecutive breaches the wrapper family self-disables for `rsp.overhead.cooldownMs`, writing the reason to `.red/state/rsp/overhead-budget.toon` and re-arming when the cooldown lapses. The verdict is the surface, not a log line: `rsp status`, `rsp stats`, the bare dashboard and the `rsp_status` MCP tool render `green` or `red` with the breaching families, and `rsp doctor` fails its new `overhead_budget` probe while a ceiling is breached. Self-disabling is a fail-open, never a failure — the raw command keeps its own stdout, stderr and exit status.
  - @reddb-io/shared@2.87.7
  - @reddb-io/build-info@2.87.7

## 2.87.6

### Patch Changes

- d4df875: ADR triage now reads supersession by direction, so a record that supersedes another is no longer reported as broken (#2720). `claimsSupersession` matched a bare `supersed` anywhere in the status, which made every healthy successor — `Accepted. Supersedes ADR 0032.` — fail the direction-aware `superseded by` lookup and land in `missing-supersession` with `successor-unnamed`. Acting on that bucket as reported would have written a fabricated `superseded-by:` pointer into nine live records, and the noise buried the two genuine findings. A claim now means only "this record IS superseded": a `superseded by` / `Superseded-by:` pointer, or a terminal `Superseded` standing alone. Pointer parsing reads through the markdown emphasis real headers use (`- **Superseded by**: …`), and a successor that names an issue or PR rather than an ADR stays flagged under its own `successor-not-adr:#N` signal — a decision is superseded only by another decision. Over the repo's own `.red/adr/`, `missing-supersession` drops from 12 findings to the 3 real ones.
- a3d1b09: The janitor now reclaims on the attempt record rather than on pid-file presence (#2705, ADR 0128). The old rule read a pid file and a mtime, which produced the exact inversion it was meant to prevent: the live supervisor's lane was deleted while dead ones survived. A pure planner in red-castle maps an attempt's terminal outcome to a retention tier — `live` retains everything, `landed` reclaims the workspace while the record and its pointers stay on the durable lane, `failed` reclaims only the expensive workspace and keeps the cheap evidence a rescue reads, `discarded` reclaims both — with `reclaimable` and `reclaim_after` as record-level overrides. Liveness wins at _path_ granularity, so a retry running on the same workspace path is never handed over by the previous try's closed record. The plan is total: every artifact lands in exactly one of reclaim/retain/dropped, a reclaim cap names each artifact it held back, and an observed path no record accounts for is reported and left alone — a silent truncation is a failure, not a clean sweep. Both apply paths run the record-keyed pass (the `/red-doctor --fix` janitor and the sweep on every fleet boot); each re-reads the lane immediately before removing, refuses a record-named path outside the tmp tier, and fails closed when the liveness probe is unwired or throws.
- 47b9fc3: Attempts now carry per-attempt resource budgets and a named termination (#2707, ADR 0128 §8). The resident measures each attempt's wall clock, peak RSS and reported cost and writes them into the attempt record for a completed attempt exactly as for a terminated one, charged to the fleet and the cgroup scope that actually holds it (#2697) — so "which fleet caused this pressure" is a record read rather than a `ps` reconstruction after the workers are gone. `afk.attempt.budget.peak_rss_mb` and `afk.attempt.budget.cost_usd` add the two ceilings nothing else watched; both default to `unlimited`, which means no ceiling and no sampling cost, and is deliberately a word rather than `0` (which would read as "terminate immediately"). The wall-clock budget stays the existing `afk.issue_wall_clock_max_s`, because two disagreeing wall-clock ceilings is the bug class the ADR forbids. A budgeted termination is a third terminal record, distinct from a stall and from a clean finish: the outcome is `budget-exceeded` and it NAMES the budget that fired, it publishes its branch and names any open PR before the labels rotate so the retry adopts the work instead of restarting from main, and memory/cost breaches page a human rather than blind-retrying a runaway. Memory is sampled from one process-table read per tick, so the accounting does not scale with fleet width, and a failed sample measures nothing rather than reporting a fabricated zero — it can never terminate an attempt that was inside its budget.
- d54cefe: `review` joins the gate's stage order as its third stage, after feedback and backpressure (#2726). This is vocabulary: a stage absent from the fold cannot block, so nothing changes behaviourally until a producer pushes a review outcome. What it buys is that the two properties a diff review needs — running only once the earlier, cheaper stages are green, and degrading instead of failing the attempt when it cannot run — are now native fold behaviour (the short-circuit on the earliest blocker, and the `skipped` outcome that never blocks) rather than machinery reimplemented beside the gate. The dev glossary's `Gate stage order` term is updated to the current order and drops the `trust` stage that went with the sensitive-path removal in #2417.
- 211b879: The MCP lane now carries a canary (#2706, ADR 0128 §7). `castle-mcp __mcp-canary` walks the shipped lane end to end over the real MCP stdio transport — `fleet_create` → a slot that spawns a real worker → `fleet_status` → `fleet_stop` — and exits non-zero naming the step that went inert. A returned supervisor pid is explicitly not accepted as drainage: only a worker directory holding a live `worker.pid` is, which is exactly what #2677's dead slots never wrote. CI runs the same walk on every PR against two bundles that differ solely in whether the slot entry can route `run`, so a lane that silently drains nothing fails the gate instead of surviving unnoticed.
- 793b3c3: The rsp documentation surfaces now describe the resident as the core (#2689, ADR 0126). The generated ambient host instructions gained a `Core model` section stating that the CLI, the wrappers, the pre-exec hook, the proxy and the MCP server are peer clients of one resident behind a unix socket with no privileged contact point among them, and that a host with no MCP server connected is fully supported. `docs/TROUBLESHOOTING.md` leads with a resident-first diagnosis path that separates a resident which never started (auto-spawn blocked, no socket) from a stale socket whose process is gone, and tabulates the exact observable fail-open behaviour per surface: wrappers and the proxy hand back the raw result, the hook passes the command through unrewritten, `stats` and the bare dashboard degrade to the empty snapshot, `wait` keeps its spooled bytes, and the MCP tools return the payload they were handed.
- e3b1e8f: The resident auto-spawn now resolves the rsp entrypoint explicitly instead of re-executing the caller's `process.argv[1]` (#2736). A host that is not the rsp CLI — the dev bundle, castle-mcp, memory, brain — used to re-exec _itself_ with `warm-resident`, an argument only the rsp CLI routes, and because rsp fails open by contract that spawn died in silence: the command still ran, but compression, `el:<id>` handles and telemetry quietly disappeared. Entry resolution walks named candidates in order — an explicit `serverCommand`, `RSP_BIN`, the caller's own entry when it _is_ an rsp entry, the rsp bundle beside the host bundle, the plugin-root bundle, the repo `dist/`, the workspace entry, and the bundle cache — and a host with no resolvable entry now emits the named `rsp-resident-entry-unresolved` diagnostic once instead of failing silently. Fail-open is unchanged: after the diagnostic the wrapped command keeps its own stdout, stderr and exit status.
- 21308a1: Every rsp surface is now a client of the resident core (#2688, ADR 0126). The pre-exec proxy, the CLI wrappers, `show`/`gains`, the bare dashboard, `stats`, `wait` capture and the MCP tool handlers previously each built their own store or opened a second connection to the same file; they all go through `residentElisionStore()` and the resident protocol instead, so the resident is the sole writer of the elision store and of the telemetry lanes it drains. Store construction is left in exactly two places — the store module (which owns the one-shot `rsp setup` provisioning open) and the resident server — and a contract test fails the build if a third appears. The fail-open guarantee is unchanged: an unreachable socket still yields the raw command's stdout, stderr and exit status, the dashboard and `stats` degrade to an empty snapshot, and `wait` keeps its spooled bytes rather than claiming a handle nothing can recover.
  - @reddb-io/shared@2.87.6
  - @reddb-io/build-info@2.87.6

## 2.87.5

### Patch Changes

- 7fec517: `fleet_status` and `fleet_stop` can no longer go blind to a live supervisor (#2698). Every management read resolved the supervisor's identity from `afk-supervisor.pid` alone, so a ticking fleet whose lock was missing — or whose `.pid.start` sidecar was gone — reported `pid 0, alive false, health absent` in the same response that carried a 13-second-old heartbeat and two busy slots, while `fleet_stop` answered `status: none` and the operator had to SIGTERM by hand. The supervisor now stamps its process-start pin next to its pid in the `state.toon` heartbeat, so ONE identity is published to two anchors; `discoverLiveSupervisorPid` falls back to the snapshot when the lock cannot answer, the stale-state reaper and the watchdog honour the same anchor (so a live lane is never wiped and never respawned over), and `fleet_status` names the anchor that answered in a new `supervisor.identity_anchor` field.
  - @reddb-io/shared@2.87.5
  - @reddb-io/build-info@2.87.5

## 2.87.4

### Patch Changes

- 08bfe90: The boot tmp-janitor no longer deletes the live supervisor lane (#2679). Its supervisor sweep keyed liveness off `afk-supervisor.pid` alone, so a supervisor still ticking without that file — its lane swept, or booted from a bundle predating the pid re-pin — was judged dead and had its runtime dir removed, after which `fleet_status` and `monitor` reported `pid 0, alive false` for a healthy fleet. A lane is now spared on ANY live anchor (pid file, the pid stamped into the fleet `state.toon` snapshot, or a live `s<pid>/` log dir), the supervisor stamps its pid into that snapshot on every heartbeat, and both the boot sweep and the runtime janitor refuse to delete a registered `.red/tmp` lane through the unknown-entry path.
- 583e059: MCP-launched fleets drain again (#2677): the supervisor no longer infers the slot's worker entry from `process.argv[1]`. Under the ADR 0120 MCP lane the supervisor is itself the castle-mcp bundle, whose entry does not route `run`, so every slot booted a second resident/stdio host, lost the singleton lease and died — `deaths == respawns`, `slots_busy=0`, zero drainage. `spawnSlot`/`spawnReconcileWorker` now resolve the sibling dev bundle (the entry that routes `run`), and the castle-mcp entry refuses an unroutable subcommand by name instead of silently falling through to the resident path.
  - @reddb-io/shared@2.87.4
  - @reddb-io/build-info@2.87.4

## 2.87.3

### Patch Changes

- 0b9aac0: Shipped-hook interpreter contract (#2626, Spec #2466): one strategy across every shipped hook — a hook is a bash script and every invocation site names bash explicitly, while the host `sh -c` wrappers stay strictly POSIX because `/bin/sh` is dash on Debian/Ubuntu. The `.mcp.json` launchers now `exec bash "$launcher"` instead of `exec sh`, the remaining `#!/bin/sh` hooks declare bash, the hook dispatcher survives a hook that ignores stdin instead of dying on EPIPE, and a new suite runs every shipped hook in a sandbox whose `sh` is dash while linting each wrapper body for bashisms.
  - @reddb-io/shared@2.87.3
  - @reddb-io/build-info@2.87.3

## 2.87.2

### Patch Changes

- @reddb-io/shared@2.87.2
- @reddb-io/build-info@2.87.2

## 2.87.1

### Patch Changes

- 0befc44: Statusline lifecycle bar recolored to the wine ramp: completed cells full-bodied red, healthy cursor pale pink, future cells dark wine; the failure cursor keeps the saturated red.
  - @reddb-io/shared@2.87.1
  - @reddb-io/build-info@2.87.1

## 2.87.0

### Minor Changes

- 4a1fb87: Castle-MCP H8 (#2346): `worker_dispatch` gains `mode: "scout"` — read-only investigations reachable through the MCP. Scout is demand-only (rejected with an issue number at input validation), routes through the scout dispatch operation into the `.red/tmp/scout-workers/` lane, and never mutates the tracker.
- 34c1f95: Territory scoping for shared issue pools: new `tag:<value>` label family + author filter. `/afk --tags a,b` drains only issues carrying EVERY requested tag label (AND semantics; untagged issues are outside every tag-scoped fleet) and `/afk --user login|@me` filters by issue author (`@me` resolved to a concrete login at launch); both fold into the fleet `selector` (`tags`/`user` facets) across CLI, supervise forwarding, fleets.toonl persistence, and the castle MCP `fleet_*`/`queue_status` surface. `/go --tags` stamps the labels on the minted `lane:go` issue (auto-created when missing); `/to-spec`/`/to-tickets` stamp and inherit them Spec→Ticket.

### Patch Changes

- be1eb85: Worker/gate teardown no longer leaks orphaned vitest forks (#2432): every engine path that terminates a worker, gate, or wait kills the entire process group (setsid at spawn, TERM→grace→KILL on `-PGID`) and verifies descendants are gone, matching the rsp wait cleanup contract. The tmp-janitor sweep additionally detects orphaned test-runner processes (parent dead, cwd inside a `.red/tmp` workspace), reaps them by process group, and logs each kill.
- 93d63d0: Statusline per-worker proof-of-life (#2480): worker rows render a heartbeat age sourced from the same liveness evaluator `worker_vitals` uses, with quiet-but-live (`~`) visually distinct from wedged (stale lane AND no live descendants) — a live worker is never rendered as silent zeros without the age qualifier. Landing/rebase sub-agent executions (conflict resolvers, landing helpers) now stream their tool events into the parent worker's lane through the linked-subagent adapter, so the longest phases no longer read all-zero.
  - @reddb-io/shared@2.87.0
  - @reddb-io/build-info@2.87.0

## 2.86.2

### Patch Changes

- 8fb4e9e: Unified local issue-lease (#2578): the two local-lease twins over `.red/tmp/claims/` — `tryAcquireClaimDir` and `createFsIssueLeaseStore` — converge on the proven mkdir-lock semantics, one engine for every claim path. (The CLI help guard half of this branch was superseded by the #2581 fix already on main.)
  - @reddb-io/shared@2.86.2
  - @reddb-io/build-info@2.86.2

## 2.86.1

### Patch Changes

- db927c5: `red-skills-dev --help` prints usage and exits 0 (#2581) — it no longer falls through to the run default and boots a live worker drain. Help short-circuits before any routing (bare, `-h`, `help`, and `<command> --help`), and a flag-led invocation whose leading flag is not one of the documented run-surface flags errors with usage instead of silently draining the queue.
  - @reddb-io/shared@2.86.1
  - @reddb-io/build-info@2.86.1

## 2.86.0

### Minor Changes

- ccc88f4: Boundary consolidation (ADR 0123): red-castle prunes to RedSkills' development shape (vercel/daytona sandboxes and cursor/copilot/devin agent providers removed as a recorded permanent upstream divergence; pi kept whole); the claim engine gains a single owner in `engine/tracker/claim.ts` with the proven #2385-hardened implementation absorbed from apps/dev, dev-side re-export shims, and a two-sided pinned wire fixture; the castle MCP adapter's capture-and-reparse tools (`retake`, `triage`, `respond`, `daily_review`, `weekly_review`, `worker_stop`/`worker_recycle`) now call value-returning cores with a guard test; `mcp-server` is published through the package exports map; `/hitl`, `/triage`, `/retake`, `/dashboard`, and `/daily-review` become MCP-first castle clients bound by the doc-contract test; and apps/dev drops its tested-but-unwired dead modules.

### Patch Changes

- 91f2b9d: Statusline drops the per-worker fleet-attribution tokens (#2568): no more `flt=unattributed` / `flt=<name>` in worker lines — maintainer-confirmed display noise. Fleet ownership stays available in `fleet_status`/`worker_status`; the fleet chip header is unchanged.
- b5af840: Land-failed retry loop killed (#2576): merge-retry accounting now consults the ADR 0122 heal ledger so the RED_AFK_RETRY_MERGE cap survives worker replacement — a replacement worker restarting at attempt 1 can no longer loop 100+ identical land-failed cycles; the 3rd durable strike escalates. Landing failures also preserve their real diagnostic (push failure vs merge-step reason) into the blocker record and envelope instead of a generic `merge-conflict` with `(no merge log captured)`.
  - @reddb-io/shared@2.86.0
  - @reddb-io/build-info@2.86.0

## 2.85.1

### Patch Changes

- f1b595a: Fleet launch runner cascade (#2545): a fresh `fleet N` launch honors the operator's `RED_AFK_RUNNER` env over the stale registered profile (flag > env > profile — the profile no longer shadows the env as a pseudo-flag), an invalid explicit runner errors loudly instead of silently resuming the old one, and `fleet_create` against a live-but-unregistered supervisor registers the orphan profile so `fleet_edit`/`fleet_status` work instead of the create-says-running/edit-says-not-exists trap.
  - @reddb-io/shared@2.85.1
  - @reddb-io/build-info@2.85.1

## 2.85.0

### Minor Changes

- 3c65e2e: Castle-MCP E7 (#2369): `claim_status`/`claim_release` accept a batch `issues` array (response keyed per issue, per-issue errors) alongside the single-issue form, and the new `hitl_resolve` verb encodes one human decision on a parked issue atomically — `requeue` (concede claims + one ADR 0122 transition, consuming dangling req:* edges on human override), `retake` (same freeing transition routed to the no-agent landing lane), `park`, or `close` — always posting the rationale as the audit trail. Collapses the 10-round-trip unpark sequences into one call.

### Patch Changes

- @reddb-io/shared@2.85.0
- @reddb-io/build-info@2.85.0

## 2.84.1

### Patch Changes

- @reddb-io/shared@2.84.1
- @reddb-io/build-info@2.84.1

## 2.84.0

### Minor Changes

- 9292d02: Event ingestion transport (#2514, Spec #2511 slice 3): the castle resident's webhook lane gains an ETag conditional-polling transport — `If-None-Match` reads where 304s are rate-limit-free, cadence honoring `X-Poll-Interval`, repo events deduped by id, and check-run snapshot diffing that emits exactly one `check.completed` delivery per transition for merge-driver-armed PR heads. The default resident transport is now a composite: the `gh webhook forward` child when its handshake holds, the poller as the always-armed fallback filling the same lane — consumers never see which transport delivered.
- 8179a82: Merge driver (#2512, Spec #2511 slice 1): a castle-resident loop that lands armed PRs without GitHub native auto-merge — BEHIND → update-branch, green at head → merge-commit (never an admin override), transient faults → bounded retries (25-pass budget), DIRTY/failing checks → terminal needs-medic/needs-human classification. Durable state in `.red/state/castle/merge-driver.toon` survives resident restarts. New castle MCP tools: `merge_arm`, `merge_status`, `merge_release`.
- 0bb78ad: PR medic (#2513, Spec #2511 slice 2): when the merge driver classifies a PR needs-medic, a bounded mechanical healing round runs in an isolated feedback-lane worktree before any escalation — stale staged Pi mirrors are regenerated, registered identifier renames applied, and additive conflicts union-resolved; anything semantic escalates untouched. Two failed rounds per PR escalate to needs-human, every action ledgered in `.red/state/castle/pr-medic.toon`; a healed push re-arms the PR on the driver.

### Patch Changes

- @reddb-io/shared@2.84.0
- @reddb-io/build-info@2.84.0

## 2.83.0

### Minor Changes

- fa59c75: Crashloop circuit breaker (#2527, ADR 0122 amendment): the supervisor fingerprints every boot-sweep halt; three consecutive identical boot-death signatures trip the breaker — respawn is suppressed (supervisor + watchdog), the resident issue-state curator is invoked immediately for the implicated state, and a loud alert surfaces in the supervisor lane, monitor dashboard, and statusline (`⛔brk=N×`). A different signature or one successful boot resets the run.
- 8a9a207: Death-sweep (ADR 0122, #2526): a reaped worker's issue is cleaned through the atomic transition API in one label edit, and the heal ledger quarantines an issue on its 3rd worker-death heal inside the window
- 3011e02: Transition API (expand): single atomic issue-state mutation function enforcing the one-state-role invariant (ADR 0122, #2524)
- e9fa0f8: Transition-API contract (#2528, ADR 0122 rule 5): boot quarantine, claim-sweep requeue, orphan restore, close-cascade promote, unblock-sweep promote, and the watchdog stale-claim reconcile now flow through `planTransition` — each mutation is one atomic edit proven to leave exactly one state role, so the 2026-07-22 poison shapes (stacked state roles, requeue over dangling req:* edges) are unconstructible from engine paths. A repo-wide contract lint fails any new raw state-role `editLabels` call site outside the justified allowlist.

### Patch Changes

- b939dce: Claim-hygiene probe applies the ADR 0066 claim TTL to unknown-pid own-namespace markers: expired ghosts become auto-concedable instead of red-halting every boot (#2525)
- 70b2941: Poison-chain regression fixture (#2529): an end-to-end test seeding the full 2026-07-22 incident class at once — dead-pid ghost claim, contradictory-labels issue with an active blocker, and a worker-killing issue on its 3rd heal — and asserting the healed outcome (concede, quarantine with diagnosis, ledger quarantine) while a healthy sibling drains in the same run. Per-mechanism mutation checks pin how the incident reappears if any healing belt is removed.
- 5f82ecc: Sandboxes stop writing the HOST global gitconfig (#2494): safe.directory and identity setup are skipped for the `none` provider (same-UID worktree, and the shared-file lock races across concurrent workers) and kept for container providers; a setup-phase `could not lock config file` failure is classified infra-transient, never a no-sentinel death
  - @reddb-io/shared@2.83.0
  - @reddb-io/build-info@2.83.0

## 2.82.0

### Minor Changes

- c42c223: Self-healing wave (ADR 0122): boot auto-concede of dead own-machine claims, quarantine curator + heal ledger + probe posture change (#2521), activity-independent wall-clock ceiling (#2286), gate teardown leak fix (#2432), fleet_create idempotent respawn (#2471), fleet-scoped stop (#2472), requeue blocked:base-stale lane (#2474), and the resident webhook singleton (#2425)

### Patch Changes

- @reddb-io/shared@2.82.0
- @reddb-io/build-info@2.82.0

## 2.81.0

### Patch Changes

- e7ef0d0: Rename the dev plugin's MCP servers to colon-free names: `dev:afk` → `castle` and
  `code-nav` → `navigator`. Codex rejects `:` in MCP server names, which broke every
  `dev:*` form. The AFK launcher is now `plugins/dev/hooks/castle-mcp.sh`, the bundle
  is `castle-mcp.bundle.min.mjs`, and the npm bin is `red-skills-castle-mcp`. Pure
  rename, zero behavior change; takes effect on the next plugin update.
  - @reddb-io/shared@2.81.0
  - @reddb-io/build-info@2.81.0

## 2.80.0

### Patch Changes

- @reddb-io/shared@2.80.0
- @reddb-io/build-info@2.80.0

## 2.79.1

### Patch Changes

- @reddb-io/shared@2.79.1
- @reddb-io/build-info@2.79.1

## 2.79.0

### Patch Changes

- @reddb-io/shared@2.79.0
- @reddb-io/build-info@2.79.0
