# @reddb-io/red-skills

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
