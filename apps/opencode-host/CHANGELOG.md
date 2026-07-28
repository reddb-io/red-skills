# @reddb-io/red-skills

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
