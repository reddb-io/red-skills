# @reddb-io/red-skills

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
