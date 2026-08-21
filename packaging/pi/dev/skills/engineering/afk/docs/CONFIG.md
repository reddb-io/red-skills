# AFK configuration & lifecycle hooks (reference)

> Extracted from `afk/SKILL.md` for progressive disclosure. Consulted on demand — not the agent's step-by-step loop.
>
> Every `.red/config.yaml` knob and `RED_AFK_*` env var the loop reads, and the lifecycle-hook contract.

## Configuration

Scalar run settings live in `.red/config.yaml` under the `afk:` key (alongside the `afk.hooks` block documented below). Each one has a matching `RED_AFK_*` env override that wins over the config value, so an E2E/CI run can pick a setting without mutating the target repo's config.

**Two loader rules decide whether a key is read at all:**

- **The directory must be opted in** (ADR 0116). Without an explicit `plugins.dev.enabled: true` (ADR 0067), the loader returns the documented defaults and **none** of the file's settings — every table below reads as its default. This is decided in the loader, not only at process entry, so no caller can read a disabled directory's settings.
- **Retired keys are dropped and warned** (ADR 0117). A key on the tombstone list (`afk.attempt_timeout`, retired when the commit-anchored progress guard replaced the wall-clock cap) warns `RETIRED — it no longer does anything` and is unreadable. An **unknown** key stays silent for forward compatibility: silence means "not yet", a warning means "not any more".

### Implementer environment

An AFK inner agent does not inherit the host's full plugin, MCP, hook, or
statusline environment. The Worker launcher projects the existing activation gates into a
discovery-closed constraint owned by each runner-spec row:

| Existing gate | Inner-agent surface |
|---|---|
| `plugins.dev.enabled: true` | Dev essentials and the `navigator` code-navigation MCP (always present for an AFK implementer) |
| `plugins.memory.enabled: true` | Memory plugin and `red-memory` MCP |
| `plugins.brain.enabled: true` | Brain plugin and `brain` MCP |
| `plugins.red-ui.enabled: true` | `red-ui` MCP |
| `rsp.enabled: true` | rsp MCP/instructions and runner integration |

There is deliberately no implementer payload or allowlist key. Each optional
surface is present only when its existing gate is exactly `true`; enabling one
gate does not enable any sibling surface. Claude starts bare with strict MCP
loading and explicit settings, Codex receives explicit plugin/MCP config,
OpenCode receives an isolated config projection, and Pi disables discovery and
receives explicit skills/extensions. Statusline integration and operator
MCP, and non-essential host hooks are absent from every projection.

| Config key | Env override | Default | Meaning |
|---|---|---|---|
| `afk.default_runner` | `RED_AFK_RUNNER` | `claude` | Caller runner identity/default backend consumed before ambient sniffing. |
| `plugins.dev.afk.routes.<tier>.runner` | `--runner` / `RED_AFK_RUNNER` / `project_start.runner` | `afk.default_runner` | Runner selected after Ticket classification for `validate`, `simple`, `complex`, or `think`. Unmapped tiers preserve the scalar fallback. |
| `plugins.dev.afk.routes.<tier>.model` | `--model` / `RED_AFK_MODEL` | selected runner's tier table | Optional model pin beside the task-class runner. |
| `plugins.dev.afk.routes.<tier>.effort` | `--effort` / `RED_AFK_EFFORT` | selected runner's tier table | Optional effort pin beside the task-class runner. |
| `plugins.dev.afk.implementer.skills` | — | implementer profile | Optional comma-separated exact allowlist of `plugin:skill` entries for inner workers. It replaces the trimmed dev implementer profile (so it can widen or narrow it), while ADR 0067 activation remains authoritative: a skill from a disabled plugin is never exposed. |
| `plugins.dev.afk.implementer.runner_startup_baseline_ms` | — | _(unset)_ | Optional historical unprojected runner-startup baseline (invocation to first stream event). When present, each worker artifact and dashboard report compare it with the actual projected startup sample; when absent, the first projected sample self-baselines with a zero delta and is marked `unavailable`. |
| `afk.model` | — | runner-specific | Legacy global model override. Prefer tiered `afk.models.<runner>.<tier>.model` so Codex never receives a Claude-only model. |
| `afk.models.<runner>` | — | runner-specific | Legacy per-runner scalar model override. Used only when no explicit tier model is set. |
| `afk.models.<runner>.<tier>.model` | — | tier-specific | Suggested model id for every supported runner (`claude`, `codex`, `hermes`, `opencode`, `claude-minimax`). No runner inherits another runner's table. |
| `afk.models.<runner>.<tier>.effort` | — | tier-specific | Suggested provider-valid effort. `claude-minimax` is deliberately `low` on every tier because MiniMax-M3 rejects the thinking mode enabled by `high`. |
| `afk.sandbox` | `RED_AFK_SANDBOX` | `none` | Isolation backend (`none` \| `docker` \| `podman`, ADR 0033). |
| — | `RED_AFK_HOST_ENV_ALLOW` | runner-aware allowlist | Comma-separated exact names or `*`-suffixed prefixes appended to the no-sandbox worker's default host-env allowlist. Codex workers omit `CLAUDE*`, `BASH_ENV`, and `ENV` by default so a Claude host's shell-snapshot state cannot reach Codex; Claude workers retain the existing defaults. Explicit entries may re-admit those variables, and the literal `*` restores full host-environment inheritance. |
| `afk.sandbox_image` | `RED_AFK_SANDBOX_IMAGE` | `sandcastle:<repo-dir>` | Container image the `docker`/`podman` backend runs (issue #2340). Resolved off the **repo root**, so one prebuilt image serves every worker, issue, and attempt — never off the per-worker worktree, which produced an unbuildable `sandcastle:<issue-number>` tag and crashed every forced-isolation attempt. Build it once with `sandcastle docker build-image --image-name <image>`; when it is missing, the untrusted-author isolation policy parks the issue `ready-for-human` naming that exact command instead of burning the retry budget on a mid-run crash. |
| `afk.max_iterations` | `RED_AFK_MAX_ITERATIONS` | `12` | Sandcastle re-invocation ceiling (issue #322) — the safety cap for "the agent never emits `<promise>DONE</promise>` or `<promise>BLOCKED</promise>`". The completion sentinel is the real terminator, so a normal issue finishes in 1–3 iterations; this leaves headroom without letting repeated no-sentinel failures run for too long. A non-numeric / zero / negative value in either the env or the config is ignored (falls through to the default) so a typo can never disable the cap or pin the agent to 1. |
| — | `RED_AFK_IDLE_TIMEOUT_S` | `600` | Sandcastle's per-iteration **silence** watchdog (seconds): an iteration that produces no stream output for this long is aborted. The actual termination bound on a quiet hang. Env-only; typo-safe (non-numeric / zero / negative is ignored → default). |
| `afk.claim_reaper.refresh_s` | `RED_AFK_CLAIM_REFRESH_S` | `300` | Cross-host stale-claim refresh cadence (seconds). The stale window is `refresh_s × (stale_tolerance + 1)`. |
| `afk.claim_reaper.stale_tolerance` | `RED_AFK_CLAIM_STALE_TOLERANCE` | `3` | Consecutive missed claim refreshes tolerated before the stale-claim sweep may recover the issue. `0` is allowed. |
| `afk.claim_reaper.grace_s` | `RED_AFK_CLAIM_REAPER_GRACE_S` | `300` | Minimum claim age before the stale-claim sweep may recover a `running` issue, even if the stale window is configured aggressively. |
| `afk.claim_reaper.recent_commit_s` | `RED_AFK_CLAIM_REAPER_RECENT_COMMIT_S` | `2700` | Sliding progress-protection window: a live `afk/*/<issue>-*` attempt branch with a commit this recent protects the claimed issue from stale-claim recovery. |
| `afk.statusline_cache_ttl` | `RED_AFK_STATUSLINE_CACHE_TTL_S` | `180` | TTL (seconds) of every EXPENSIVE FETCHED statusline number — the GitHub-derived queue/human + open-PR/open-issue counts AND the repo-global local diffstat, cached in `.red/state/statusline/statusline-cache.toon` / `.red/state/statusline/statusline-repo-cache.toon` (issue #1178, #1217). The statusline renders on every prompt, so a per-render gh/git round-trip would freeze the TUI; the network cost is paid at most once per TTL. Also drives the monitor's stale-cache marker. Use the **flat** key — do **not** nest it under `afk.statusline` (that key is the boolean statusline opt-out; YAML cannot make one key both a boolean and a map). Typo-safe (env > config > default): a non-numeric / zero / negative value in **either** source falls through to the next and ultimately the 180 default — never 0 (a 0 TTL would refresh on every render, defeating the cache). |
| `plugins.dev.afk.setup` | — | _(undeclared fallback)_ | Ordered repository-owned commands that prepare dependencies in fresh Worker/feedback Worktrees. Commands run verbatim through `sh -c`; AFK never changes a declared command. `/red-setup` detects and confirms this value, and `/red-doctor` checks it against package/hook managers (#3268). |
| `plugins.dev.afk.validation.iteration` | — | _(undeclared; skip)_ | Ordered light checks handed to the inner agent for use while writing. |
| `plugins.dev.afk.validation.post_done` | — | _(undeclared; skip)_ | Ordered branch checks run after DONE against the branch's fork point. |
| `plugins.dev.afk.validation.landing` | — | _(undeclared; skip)_ | Ordered final local checks run before push, PR creation, and queue entry. |
| `plugins.dev.afk.standing.runner` + `plugins.dev.afk.standing.target` | — | _(undeclared; explicit-only)_ | Declares a standing drain. Both leaves are required: each MCP session auto-registers the project at this runner and target, renews while it lives, and the daemon keeps recoverable intent while a counted backlog remains. Omit the block to keep registration explicit through `drain`/`project_start`. A lapsed or stopped standing drain with a non-empty last count renders `queue N, drain STOPPED` in project status and the statusline. |
| `plugins.dev.afk.validation.node_max_old_space_mb` | — | `2048` | Node heap cap applied to Validation moment subprocesses via `NODE_OPTIONS=--max-old-space-size=<mb>` (#1758). Keeps heavy validation bounded per Worker. |
| `afk.fleet.target` | — | `1` | How many Workers a project registers for when nothing states a number (ADR 0132 decision 7). **One** because a second Worker doubles GitHub polling against a budget metered per token — two spend ~2200 GraphQL points/hour of a 5000/hour window — and doubles memory against a host ceiling every Worker is already granted in full (#3080); that is worth choosing deliberately rather than inheriting. The daemon's host-scoped ceiling bounds it from above, because width is machine budget rather than project preference. The value is not the decision — the EQUALITY is: this number, the MCP `project_start` schema default and `CONFIG_DEFAULTS` all read one namer, and a test fails when they disagree. |
| `plugins.dev.afk.validation.vitest_max_workers` | — | `1` | Vitest worker fan-out cap exposed as `VITEST_MAX_WORKERS` to validation subprocesses (#1758). Repos with larger machines may raise it; the conservative default prevents width-2 fleets from multiplying heavy suites. |
| `plugins.dev.afk.validation.turbo_concurrency` | — | `2` | Turbo task fan-out cap exposed as `TURBO_CONCURRENCY` to feedback and backpressure subprocesses. Positive values override the conservative default. |
| `plugins.dev.afk.validation.heavy_available_memory_mb` | — | `4096` | Minimum free-memory threshold for admitting known-heavy validation work (#1758). Heavy validation admission serializes when another heavy validation is active, and otherwise waits until this much memory is available. |
| `afk.output_shaping.terse_steering` | — | `false` | Opt-in AFK output-shaping experiment (#1638). When true, even-numbered issues receive a phrasing-only terse steering block; odd-numbered issues are the holdout. The assignment is persisted in worker state beside heartbeat output-token counters and reported by `afk-output-shaping`. |
| `afk.worktree_launches_pull_request` | — | `true` | Landing **mode**, decoupled from the branch-lock (ADR 0030 amended, #842). `true` (default) → the attempt lands via an **admin-merged PR** into the resolved base; `false` → a **direct merge** into that base (offline, no PR — only the post-commit push the worker already does). The branch-lock now only resolves the *target* base (lock > pin > main, ADR 0031); this flag decides PR-vs-direct **independently**. So: no lock + `true` → admin-PR to `main`; no lock + `false` → direct merge to `main`; lock=`X` + `true` → admin-PR to `X`; lock=`X` + `false` → direct merge to `X`. *How* a PR merges (admin vs `wait_for_review` vs `review_gate`) stays governed by `afk.merge.*`. **Migration:** the default `true` flips the old *locked* behaviour (which direct-merged) — a locked repo now gets an admin-PR to its lock branch; set `false` to keep the old offline/direct-promotion flow. |
| `afk.landing.wait` | — | `merge` | Worker-slot release point across the PR landing tail (#2427): `merge` keeps today’s byte-compatible flow and releases only after merge + Ticket close; `ci` releases once required CI is green; `none` releases as soon as the PR opens. For `ci`/`none`, the background landing observer finishes merge + close. It uses the resident’s shared webhook lane when available and the established per-wait forwarder otherwise. **Trade-off:** earlier release pipelines more Tickets through each fleet slot, but leaves a larger asynchronous tail; if that observer dies, the open PR/running Ticket is an orphan for the deadend audit/healer instead of work the slot still owns. |
| `afk.merge.wait_for_review` | — | `false` | Merge-gate policy (ADR 0048). When `false` (default), the unlocked admin-merge proceeds **ignoring advisory review checks** (e.g. CodeRabbit) — the binding local checks are the declared Validation moments plus `drift-guard` (the `pre_merge` hook). When `true`, the unlocked landing **waits** for the configured review check to conclude before merging, then merges regardless of its verdict (the review stays advisory). `drift-guard` is a hard gate either way. |
| `afk.merge.review_check` | — | `CodeRabbit` | Name (case-insensitive substring) of the advisory review check `wait_for_review` polls via `gh pr checks`. Only consulted when `afk.merge.wait_for_review` is `true`. |
| `afk.merge.ci_aware` | — | `false` | CI-aware merge (#812). When `false` (default), the unlocked admin-merge fires immediately — correct only on a base with **no** required status checks. When `true`, the unlocked landing first polls `gh pr view --json mergeStateStatus,statusCheckRollup` until the PR settles, then admin-merges **only** once it is genuinely ready (`CLEAN`, or `BLOCKED` solely by a required review `--admin` waives). Required for any `enforce_admins` base, where an admin-merge **cannot** bypass required checks: a real conflict / `DIRTY` / `BEHIND` → `blocked:merge-conflict`; a **failed** required check → `blocked:ci`; checks still **pending** at the timeout → `blocked:ci` with the open PR preserved (never re-runs the inner agent). |
| `RED_AFK_MERGE_CI_TIMEOUT_S` | env | `1800` | CI-aware merge wait budget, in seconds (#812). The poll runs at a fixed 10s cadence until `mergeStateStatus` settles; on timeout the open, MERGEABLE PR is handed off (`ci-pending` → `blocked:ci`) instead of re-running the agent. Non-positive / unparseable → the 1800s default. Only consulted when `afk.merge.ci_aware` is `true`. |
| `afk.review_gate.enabled` | — | `false` | PR review gate (ADR 0064 §10, #749). When `true`, a completed **non-mechanical** attempt (classified tier at/above `afk.review_gate.threshold`) gets `ready-for-review` on its PR — firing the advisory review — and **holds the merge** for a fresh-agent review by a different agent than the one that implemented it. Mechanical/trivial work keeps the fast-merge path. Only affects a PR landing (`worktree_launches_pull_request: true`); a direct merge never opens a PR, so the gate is moot there. Off by default so the "merge fast / no drift" loop is unchanged until a repo opts in. |
| `afk.review_gate.threshold` | — | `complex` | The cheapest issue-classifier tier (`validate` \| `simple` \| `complex` \| `think`) counted as non-mechanical. Tiers below it stay mechanical (fast-merge); this tier and above request review. |
| `plugins.dev.review.enabled` | — | `true` | Adversarial review, the **verifier** of ADR 0154 (#4137). **Default on and fail-closed.** One isolated reviewer pass reads ONLY the Issue + worktree diff and its outcome is written to the verdicts ledger under an identity that did **not** implement the change. A reviewer that throws, a reviewer runner that is not wired, or an identity that cannot be pinned distinct from the implementer all produce a `verifier-blocked` row and park the Ticket `ready-for-human` — never a silent skip, and never a retry loop: the reviewer is asked exactly once per pass. Set `false` only to drop the verifier entirely; the supported way to keep draining through a broken reviewer runner is `mode: advisory`. |
| `plugins.dev.review.mode` | — | `blocking` | The operator escape hatch for the fail-closed verifier (#4137). `blocking` (default) lets a `verifier-blocked` outcome block the gate's review stage and park the Ticket. `advisory` restores the pre-ADR-0154 behaviour — the stage never blocks and nothing parks — while still writing every row, so a drain run in advisory mode is auditable afterwards. Any unrecognised value resolves to `blocking`: a typo must never silently disarm the verifier. |
| `plugins.dev.review.appraisal_floor` | — | `off` | Appraisal promotion flip. `off` keeps the review score advisory and records it in the Envelope. Set a 0–1 floor to make a score strictly below it draw the review's reserved Re-seed round; if the next review remains below the floor, exhaustion parks the Ticket through the uniform validation Park path. |
| `afk.companion.iteration_churn` | — | `8` | Companion (active) monitor drift threshold (#921): a live worker at/above this iteration **and** below `min_progress_loc` added lines is judged `iteration-churn`. Only read when `monitor --companion` / `--active` is set (off → byte-for-byte read-only dashboard, no gh writes). A non-positive override falls back to the default. |
| `afk.companion.waiting_windows` | — | `20` | Companion drift threshold: a flat-diff worker with this many zero-progress waiting windows is judged `stuck-waiting`. |
| `afk.companion.diff_drift_loc` | — | `4000` | Companion drift threshold: total churn (added + removed) at/above this is judged `scope-creep` (sprawling past the issue), the highest-priority signal. |
| `afk.companion.min_progress_loc` | — | `5` | Companion progress floor: a worker that has added at least this many lines has produced real work and is never flagged for churn/stuck. |
| `afk.companion.*` (cap) | `RED_AFK_RETRY_DRIFT` | `2` | Companion bounded re-enqueue budget. Each detected drift on an attempt injects **one** correction (write-only, idempotent via a fingerprint, rewriting `## Agent brief`); once the attempt count reaches this cap the companion **escalates** to `ready-for-human` (a `## Current blocker` of kind `drift`) instead of correcting again. Shares the bounded-recovery policy (`core/recovery.ts`); never kills a process — termination/respawn is the reaper + fleet's job. |
| `afk.drain.max_cost_usd` | `RED_AFK_DRAIN_MAX_COST_USD` / `fleet --budget-usd` | _(unset)_ | Per-drain USD budget for the fleet supervisor. Spend is read from WorkerVitals (`current.cost_usd`) in worker state files, not a parallel ledger. Tiers are OK below 75%, WARNING at 75%, CRITICAL at 90%, and HARD_STOP at 100%. CRITICAL spawns new workers with one model-tier-policy downgrade; HARD_STOP stops all new spawns, lets in-flight workers finish, and records a TOON budget event in `.red/tmp/supervisors/default/supervisor.log.toonl`. |
| `afk.issue_wall_clock_max_s` | `RED_AFK_ISSUE_WALL_CLOCK_MAX_S` | `2700` | The activity-independent wall-clock ceiling one attempt may hold one issue for. This IS the per-worker `wall_clock_s` budget — there is deliberately no second wall-clock knob, because two disagreeing ceilings is a bug class of its own. A capped worker is terminated as `budget-exceeded` naming `wall_clock_s` and hands its branch/PR forward (#2701); it is never reported as a stall. |
| `afk.attempt.budget.peak_rss_mb` | `RED_AFK_ATTEMPT_PEAK_RSS_MB` | `unlimited` | Per-worker memory ceiling in MB. The supervisor samples every live worker's process tree from **one** process-table read per tick, so accounting costs the same at any width. A worker whose peak reaches this ceiling is terminated with an outcome that **names the budget** (`budget-exceeded` / `peak_rss_mb`) — never reported as a stall — publishes its branch and names its open PR so the retry adopts the work instead of restarting from main, and pages a human with `blocked:budget` (a resource runaway is not a transient flake to blind-retry). `unlimited` (the default) means no ceiling and no sampling cost; it is a word rather than `0`, which would read as "terminate immediately". A garbage or non-positive value also resolves to unlimited. |
| `afk.attempt.budget.cost_usd` | `RED_AFK_ATTEMPT_COST_USD` | `unlimited` | Per-worker USD ceiling, read from the same WorkerVitals lane as `afk.drain.max_cost_usd` (`current.cost_usd`) — never a parallel ledger. Distinct from the drain budget: that one throttles the whole fleet's spawns, this one terminates the single runaway worker, with the same named outcome and hand-forward as the memory budget. `unlimited` by default. |
| `afk.fleet.scope.enabled` | `RED_AFK_FLEET_SCOPE` (`off`) | `true` | Cgroup isolation for the fleet (#2697). On Linux with a systemd `--user` session the launcher spawns the supervisor under `systemd-run --user --scope` in a transient `red-fleet-<name>-<pid>.scope` with `Delegate=yes`, so every worker, gate install, and test fork is charged to the fleet's own cgroup. Without it the fleet inherits the caller's cgroup — the terminal emulator's scope — and `systemd-oomd`, which kills the largest cgroup under pressure, takes every terminal window and agent session instead of the fleet. The scope is created **at launch**, because moving a running process between cgroups does not move its existing memory charge. Where no systemd user session exists (or the value is `false`), the launcher runs unscoped **and warns**; it never drops isolation silently, and a scope that fails to produce a supervisor is retried unscoped with a second warning. |
| `afk.fleet.scope.memory_high` | `RED_AFK_FLEET_SCOPE_MEMORY_HIGH` | `70%` | The fleet scope's `MemoryHigh` throttle — any systemd memory value (`70%`, `6G`). An empty value sets no property, leaving the scope in place with no throttle. |

### Tier routing

AFK classifies each claimed Ticket before spawning its runner. It first resolves
the runner through `afk.routes.<tier>.runner`, falling back to
`afk.default_runner`, then resolves the pair through an optional model/effort in
that route and the selected runner's `afk.models.<runner>.<tier>` table. The default
router uses cheap Ticket metadata: type and mechanical labels, referenced paths
and scope count in the body, risk/design keywords, and `spec:<number>` family
membership. Docs/validation-only work routes to `validate`, ordinary
single-scope implementation routes to the standard `simple` tier, cross-scope or
risk-sensitive work routes to `complex`, and explicit design/routing work routes
to `think`. If classification is unavailable or unknown, AFK continues on
`simple`; classification never blocks a Worker.

Runner precedence is one contract: explicit `--runner` > `RED_AFK_RUNNER` > a
runner named in `project_start` > `afk.routes.<tier>.runner` >
`afk.default_runner` > the shipped default. `/red-doctor` prints the effective
runner, model, effort, and origin for all four tiers and warns when a runtime pin
currently shadows a value written in the file. Model and effort use the same
flag > env > route > selected-runner-table shape.

An explicit `tier:validate`, `tier:simple`, `tier:complex`, or `tier:think`
Ticket label always wins over inferred signals. Repository overrides remain the
normal model table above: for example, setting
`plugins.dev.afk.models.codex.simple.model` changes what the standard route
spawns without changing the classifier. Runtime `--model`/`RED_AFK_MODEL` and
`--effort`/`RED_AFK_EFFORT` overrides still take precedence and flatten the
resolved tiers as documented by the model-tier policy.

Every spawn appends a route line to the Worker log and stamps
`current.model_tier`, `current.model`, and `current.effort` in the Worker state.
rs_dev `status { scope: worker }` carries the active tier as a field, and the
monitor board renders it as `tier:<name>` on the Worker row, alongside the
existing vitals.

```yaml
plugins:
  dev:
    afk:
      implementer:
        skills: dev:tdd, dev:diagnose # optional exact worker allowlist; activation gates still apply
        runner_startup_baseline_ms: 840 # optional measured pre-projection historical baseline
      validation:
        preflight: false
        subsecond_failures_are_branch_fault: false
        iteration:
          - pnpm --filter @reddb-io/dev exec vitest run tests/config.test.ts
        post_done:
          - pnpm --filter @reddb-io/dev test
          - pnpm --filter @reddb-io/dev typecheck
        landing:
          - pnpm pi:packages:check
        node_max_old_space_mb: 2048
        vitest_max_workers: 1
        turbo_concurrency: 2
        heavy_available_memory_mb: 4096

afk:
  worktree_launches_pull_request: true   # true → admin-PR landing; false → direct merge (offline). Decoupled from the lock (#842)
  landing:
    wait: merge             # merge | ci | none; earlier release increases throughput and lengthens the async tail
  models:
    claude:
      think:
        model: claude-opus-4-8
        effort: high
    codex:
      think:
        model: gpt-5.5
        effort: high
  sandbox: none
  max_iterations: 12      # override the default re-invocation ceiling here
  statusline_cache_ttl: 180   # statusline gh/git cache TTL (seconds); flat key, NOT under afk.statusline
  output_shaping:
    terse_steering: false # true → even issues steered, odd issues holdout; report with afk-output-shaping
  merge:
    wait_for_review: false   # true → hold the unlocked admin-merge until the review check concludes
    review_check: CodeRabbit
    ci_aware: false          # true → poll mergeStateStatus and merge only once required checks settle (#812; needed for enforce_admins bases)
  review_gate:
    enabled: false           # true → non-mechanical PRs get ready-for-review + hold the merge for a fresh-agent review
    threshold: complex       # cheapest tier counted as non-mechanical (validate|simple|complex|think)
```

`RED_AFK_IDLE_TIMEOUT_S` is env-only (no `afk.*` config key); `sandbox`, `max_iterations`, and `statusline_cache_ttl` resolve env > config > default. The three runtime bounds — silence (`idleTimeoutSeconds`), re-invocation count (`maxIterations`), and the fixed no-commit-progress worker guard — are detailed under *Attempt Completion & Termination Bounds*.

### Validation moments

`plugins.dev.afk.validation` is the single repository-owned schedule. Commands
are ordered shell strings run verbatim; there is no discovered default. An
omitted moment is skipped loudly, while `[]` is an explicitly declared empty
list and also skips loudly.

| Moment | Owner and timing | Freshness contract |
|---|---|---|
| `plugins.dev.afk.validation.iteration` | The inner agent receives these light checks in its handoff and runs them while writing. | Confidence only; do not improvise a broader suite. |
| `plugins.dev.afk.validation.post_done` | The engine runs these commands after DONE against the branch's fork point. The Worker's `<merge-gate>` repeats the exact list. | A correction re-runs only the failed subset, then folds back to the full declaration after that subset passes. |
| `plugins.dev.afk.validation.landing` | The engine runs these commands immediately before push, PR creation, and queue entry. | Last local verdict; it does not try to predict a moving base. |
| Merge queue | The repository's required CI checks run on the merge group. This is configured at the forge, not in RedSkills. | The merge queue is the CI-side final Validation moment and owns freshness against the merged result. |

`plugins.dev.afk.validation.preflight` is an experimental boolean and defaults
to `false`. When enabled, the Worker system instruction previews the exact
`post_done` command list as a pre-DONE checklist. It never adds `iteration`,
`landing`, review, or other commands, and the post-DONE gate still executes and
enforces the declaration.

`plugins.dev.afk.validation.subsecond_failures_are_branch_fault` is an optional
boolean declaration beside that schedule. Verdict first trusts structured branch
evidence: a compiler diagnostic, failing assertion, or invariant finding is a
branch fault at any duration, including a turbo cache hit returned in milliseconds.
Without concrete evidence, an absent/`false` declaration lets a sub-second failure
remain suspect infrastructure; set it to `true` when every fast failure in this
repository should default to branch fault. This declaration replaces the removed
runtime classification hook.

`setup` and `format` remain separate declarations rather than Validation
moments. `/red-setup` inventories the repository's real scripts, proposes the
three ordered lists, and writes them only after operator confirmation.

Validation is admitted through one host-wide semaphore shared by every project.
Tune it with `plugins.dev.redskilled.validation_ceiling` in the machine's home
config (or `REDSKILLED_VALIDATION_CEILING` for the process). The derived default
is bounded by CPU, memory, and the Worker ceiling; `host-state` reports the
resolved `ceiling.validation_count` and its source, while the statusline shows
live occupancy as `gate N/M`. This host knob sits beside the schedule because a
declared moment answers *what and when*, while the ceiling answers *how many may
run concurrently*; it never changes or invents commands.

```yaml
# Machine home config, not the repository's .red/config.yaml
plugins:
  dev:
    redskilled:
      validation_ceiling: 2
```

#### Deprecated `post_done` aliases

`plugins.dev.afk.feedback.commands` and `plugins.dev.afk.backpressure` are
one-release migration aliases that contribute commands to `post_done` and warn
with the canonical replacement. They are not separate stages, do not restore
discovery, and must not be proposed for new configuration.

`plugins.dev.afk.setup` is the dependency-install authority for every fresh AFK validation Worktree. `/red-setup` inspects lockfiles, `packageManager`, Corepack metadata, and `prepare`/dependencies for hook managers, then asks the maintainer to confirm exact commands such as `LEFTHOOK=0 pnpm install --frozen-lockfile`, `HUSKY=0 npm ci`, or `bun install --frozen-lockfile`. The engine executes the ordered strings verbatim and never appends flags or substitutes its detected package manager. This lets a repo keep lifecycle scripts that perform real builds while disabling only the hook installer that conflicts with AFK's intentional `core.hooksPath` redirect.

For older undeclared repos only, AFK retains a hardened compatibility fallback: `pnpm install --frozen-lockfile` with `LEFTHOOK=0` and `HUSKY=0`. If stderr still names the custom-hooksPath refusal, AFK retries once with `--ignore-scripts`; a successful retry is recorded on each `red.afk.validation.v1` record as setup that skipped lifecycle scripts. Any unrelated install failure remains fatal without retry. `/red-doctor` reports an undeclared or mismatched setup so the fallback is migration scaffolding, not permanent guessed policy.

**This is how maintainers tell an inner agent the exact checks it must satisfy — without ad-hoc `-r` retry guidance.** The handoff carries the `iteration` list and a `<merge-gate>` containing the declared `post_done` commands verbatim. The contract distinguishes the **touched-package confidence checks** the agent chooses while developing from the **declared moments** the orchestrator enforces. On an automatic re-queue, the prior failure's summary remains visible through `<prev-failure-context>`, so the next agent can target the real blocker. The agent is told **not** to re-run an unbounded full repository suite after its final commit; the declared commands are the contract.

### HUMAN-ONLY ticket types

`afk.labels.hitl_types` is the list of TYPE labels this repo declares human-only. **A dependent carrying one is promoted to `ready-for-human`, never into the autonomous queue** (issue #2966): its blockers closing means the *human* may now act, not that an agent may act for them. Both promote paths honour it — the boot/periodic unblock sweep and the event-driven close cascade — and the `req:*` edges are consumed either way, so the dependency wait genuinely ends; only the lane differs.

```yaml
plugins:
  dev:
    afk:
      labels:
        hitl_types:
          - wayfinder:grilling
          - wayfinder:prototype
```

**Do not hand-write this block for a label you are installing — the two are one protection with two halves** (issue #3013). The rs_dev `install_type_labels` tool creates the type labels on the tracker and merges the HUMAN-ONLY ones into this list in the same act (appending, never overwriting or duplicating), and `/red-doctor` check 25 flags a repo that carries such a label with no entry here. Hand-editing is still fine for a rename or a type whose label already exists.

The audit comment then names the lane and the type that chose it, so an operator reading the Ticket can tell a sweep promotion from a hand-set label. **The names come from this list, never from a built-in one** — a repo whose decision tickets are called something else declares its own and inherits the same protection. An absent or empty list is today's behaviour exactly: every unblocked dependent reaches `ready-for-agent`, with the pre-existing comment text unchanged. A single-line scalar is accepted as a one-label list, and the namespaced `plugins.dev.afk.labels.hitl_types` location folds down like every other key (ADR 0042).

### Merge-gate policy

The unlocked admin-merge (`gh pr merge --admin --merge`, ADR 0030) **ignores advisory review checks by default** — this is intentional, not an oversight. The binding gates on a landing are:

1. **`drift-guard`** — the `pre_merge` hook, a hard gate that aborts the merge for this issue and routes through bounded `blocked:merge-conflict` recovery.
2. **In-process backpressure / feedback** — the pre-merge feedback-validation step (typecheck/tests, ADR 0008) that only mechanism can refuse a merge on.

External advisory reviewers (CodeRabbit and the like) are **not** binding: the worker is autonomous, and gating an autonomous loop on a human-paced external reviewer would stall the queue (ADR 0048). Opt into waiting with `afk.merge.wait_for_review: true` — the unlocked landing then polls `afk.merge.review_check` until it concludes and merges regardless of the verdict (so its comments are posted before the merge, but the review never blocks the land). The wait is **fail-open**: a reviewer that never registers or never concludes within the poll budget does not wedge the landing.

## Lifecycle Hooks

`/afk` exposes a fixed set of lifecycle points declared in `.red/config.yaml` under `afk.hooks` and resolved as ordered lists of shell commands. Every hook follows a single interceptor contract:

- Input: documented `RED_AFK_*` env vars (unset — *not* empty-string — when the field is irrelevant to the current point) plus the full mutable context as JSON on stdin.
- Output: empty stdout → context unchanged; JSON object on stdout → AFK replaces the documented mutable slice with the returned value. Non-JSON stdout is treated as a parse failure.
- Exit code: `0` continues the chain; non-zero is routed through a per-hook policy table — `pre_*` aborts the step, `post_*` / `on_idle` / `on_*_error` log and continue so a broken notifier never wedges AFK.

Within a single hook list, **built-in defaults run first, user-declared commands run after**, and declaration order is preserved inside each group. Two equivalent forms declare a multi-command hook: a bare scalar (one command, or commands joined by `\n`) and a **YAML list** (each element becomes one command, executed top-to-bottom). Both forms are accepted for every lifecycle point. An unknown hook name in `.red/config.yaml` is a hard error at session boot (surfaced before the first issue pick-up, so it does not cause a spawn/death churn loop). Disable a built-in default with `afk.hooks.defaults.<name>: false` — reordering is not supported.

Every hook command emits explicit dispatch breadcrumbs around the shell call:
`[afk:hooks] <point>: enter: <command>` and
`[afk:hooks] <point>: exit rc=<n>: <command>`. Session-scoped hooks write those
lines to the session output, per-issue hooks write them to the attempt's
parent Worker's `worker.log.toonl`, and project hooks use the analogous
`[afk:fleet-hooks]` prefix in the project log. A quiet Worker can therefore
still show policy/hook activity in its one narrative lane.

### Hook Hardening Contract

Shipped RedSkills hook implementations and hook launchers must satisfy this
checklist even though operator-authored AFK hooks may still use the lifecycle
exit-code policy table above:

- Exit 0 unconditionally. Blocking host hooks return a structured denial
  payload on stdout; crashes and missing dependencies fail open with `{}`.
- Drain stdin with a deadline. Shell hooks use
  `timeout "${RED_SKILLS_HOOK_STDIN_TIMEOUT_S:-5s}" cat ... || true`; Node hooks
  use an async bounded drain rather than `readFileSync(0)`.
- Arm a bounded, unref'd process deadline for Node hook processes that do work
  after startup. A hook must not keep a host session alive because a timer or
  child process is still referenced.
- Parse tool input as structured stdin JSON. Do not interpolate raw tool input
  into a shell command string; if a hook must deny a command, emit JSON that asks
  the host to deny it.

### Hook Interpreter Contract

**A shipped hook is a bash script, and every invocation site names bash
explicitly.** Concretely: each shipped hook carries a `#!/usr/bin/env bash`
shebang, the lifecycle dispatcher runs commands through `bash -c`
(`runtime/hooks.ts`), and a manifest that hands a script path to an interpreter
writes `bash "$hook"` — never `sh "$hook"`. Bash ≥ 3.2 is a hard host
prerequisite checked at boot (`afk.host-prerequisites`), so the interpreter is
proven present before any hook runs.

**The host's `/bin/sh` is never assumed to be bash.** Claude, Codex, and the MCP
launcher configs invoke us as `sh -c '<wrapper>'`, and on Debian/Ubuntu that
`sh` is dash. So the wrapper bodies inside `claude.hooks.json`,
`codex.hooks.json`, and `.mcp.json` stay strictly POSIX — no `[[ ]]`, no
`(( ))`, no arrays, no `local`, no `source`, no process substitution — and reach
the real logic by invoking bash. Bash-only constructs live behind the shebang,
never in a wrapper.

`apps/plugin-dev/tests/shipped-hooks-posix.test.ts` pins both halves: it executes every
shipped hook in a sandbox whose `sh` is dash, and lints/parses every wrapper
body with dash. A `#!/bin/sh` hook or an `sh "$hook"` invocation site fails it.

Run `scripts/audit-hook-hardening-contract.sh` before shipping changes to
`plugins/*/hooks/`, AFK library hooks, or hook launcher wrappers. The audit is
intentionally greppable: it catches pattern-matchable regressions and includes a
violating fixture that must fail.

The full lifecycle table is defined in PRD #207. The hooks shipped so far:

| Hook            | When it fires                              | Env vars              | Mutable slice   | Exit-code policy        |
|-----------------|--------------------------------------------|-----------------------|-----------------|-------------------------|
| `pre_session`   | Boot, before any queue work                | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` | session config (`runner`, `worker_id`, `filter`, `iter_cap`) | non-zero **aborts** the session loudly |
| `pre_pick`      | Before listing the tracker queue           | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` | query params (`label`, `state`, `limit`) — `filter.{kind,value}` is read-only context | non-zero **aborts** the pick; queue listing is **skipped this iteration** and AFK falls through to the empty-queue / `on_idle` path |
| `post_pick`     | After listing, before claiming             | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` | `issues[]` (filter / reorder; replace with `{issues:[…]}`) — extra keys are silently ignored | non-zero is **logged** and AFK continues with the **un-mutated** list (defensive default — a broken filter must not silently drop work) |
| `pre_worktree`  | After claim, before `git worktree add`     | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE`, `RED_AFK_ISSUE`, `RED_AFK_SLOT` | `issue`, `target` (worktree path), `env` (k/v map merged into the parent shell so `CARGO_TARGET_DIR` etc. propagate to the runner) — `branch` is read-only context | non-zero **aborts**: the claim is restored to `ready-for-agent`, the iteration tear-down runs, and the worktree is **not** created |
| `pre_attempt`    | After worktree exists, **before each runner invocation** (per attempt, not per issue — re-fires on a `--fallback-runner` swap with `attempt_n=2`) | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (now the worktree), `RED_AFK_ISSUE` | `issue`, `workspace` (worktree path), `attempt_n` — `runner` is read-only context | non-zero **skips runner invocation**: the worktree is preserved, the heartbeat stops, and the claim is restored to `ready-for-agent` so post-pick state is reconciled cleanly |
| `post_attempt`   | After the runner returned **with an authored `<promise>` exit** — DONE or BLOCKED — for that attempt. Does **not** fire on runner crash or EOF-without-sentinel (see `on_attempt_error`). Under `--fallback-runner` it fires once per runner invocation (the swapped-away attempt closes with `result.status=exhausted`). The parsed sentinel outcome (`done` / `blocked` / `no_more_tasks`, or `""` for the exhausted firings) rides in `result.outcome` (ADR 0028). | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (the worktree), `RED_AFK_ISSUE`, `RED_AFK_RESULT_STATUS` (`success` \| `fail`), `RED_AFK_RESULT_OUTCOME` (`done` \| `blocked` \| `no_more_tasks` \| empty) | `issue`, `workspace`, `result` (`{status, outcome}`), `attempt_n` | non-zero is **logged** and the loop continues — a broken notifier/pager must never wedge AFK |
| `on_attempt_error` | When the attempt produced **no authored exit**: either an unhandled exception in the worker path (`run_inner` exited non-zero outside the quota branch — `runner-crash`), or the runner's pipe closed with **no `<promise>` sentinel** (EOF-without-sentinel — `no-sentinel`, ADR 0028; the issue routes through bounded `blocked:runner` recovery under the `crashed` policy key). Distinct from `post_attempt` with `result.status=fail`, so hook authors do not have to demultiplex. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (the worktree), `RED_AFK_ISSUE`, `RED_AFK_ERROR_CLASS` (`runner-crash` \| `no-sentinel`) | `issue`, `workspace`, `error` (`{class, rc}`), `attempt_n` | non-zero is **logged** and the loop continues |
| `pre_feedback`  | After a green attempt, before the scope-derived feedback gate (the merge gate, ADR 0008) runs (#832). The resolved scopes are on stdin so a guard can veto validation. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (the worktree), `RED_AFK_ISSUE` | `issue`, `workspace`, `scopes[]` | non-zero **aborts** the feedback gate; the attempt routes through the bounded `blocked:policy` (hook-aborted) recovery, branch/PR preserved |
| `on_baseline_probe` | After the feedback gate **failed** and the "already failing on the base branch?" probe ran (ADR 0071). Fires only on a gate failure (the probe never runs on green). `inconclusive[]` lists checks the comparison could not attribute to the branch. A failure reproduced on a healthy baseline still blocks that branch. A baseline that OOMed, crashed, or could not be materialised makes the round environment-inconclusive instead: the baseline retries next round and the failure spends no Re-seed budget. The probe remains comparison-only (#2380): it files no repair issue and blocks no other landing. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE`, `RED_AFK_ISSUE` | `issue`, `workspace`, `ok` (always `false` here), `inconclusive[]` — read-only context | non-zero is **logged** and the loop continues |
| `post_feedback` | After the scope-derived feedback gate produced its verdict (#832), on both pass and fail, before the merge or the failure routing. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE`, `RED_AFK_ISSUE` | `issue`, `workspace`, `result` (`{status: pass\|fail}`) | non-zero is **logged** and the loop continues |
| `pre_merge`     | Before the merge mechanism (`git merge --no-ff` into the pinned base). The diff between the merge base and the worker branch is on stdin so a guard hook can reject changes by size, file pattern, etc. The merge itself plus conflict resolution remain **mechanism** (ADR 0008) and sit between `pre_merge` and `post_merge` — never dispatched as a hook. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (primary checkout), `RED_AFK_ISSUE`, `RED_AFK_MERGE_BASE` | `issue`, `workspace`, `diff` — `branch` is read-only context | non-zero **aborts the merge** for this issue; the failure surfaces as a worker-failure and routes through bounded `blocked:merge-conflict` recovery |
| `post_merge`    | After a successful merge and push to origin/`{pinned}`. The merge commit already exists, so user notifiers can include the real merge commit URL. Does **not** fire when the merge was aborted (`pre_merge` rejection, conflict resolver exhausted, push rejected). | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (primary checkout), `RED_AFK_ISSUE`, `RED_AFK_MERGE_COMMIT` (full sha), `RED_AFK_MERGE_SHA` (short sha) | `issue`, `workspace`, `merge_commit` (`{sha, short}`) — extended by the built-in `validation` default with `result.{validation_status, validation_summary}` | non-zero is **logged** and the loop continues — the merge has already landed; a broken notifier or a flaky smoke test must never roll it back |
| `on_recovery_decision` | After the disposition composer proposes **retry vs escalate** for a terminal failure (#832), before any label is applied. **Mutable**: a hook may override the decision. | `RED_AFK_ISSUE`, `RED_AFK_RECOVERY_DECISION` (`retry` \| `escalate`), `RED_AFK_RECOVERY_REASON` | `issue`, `decision` (`retry` \| `escalate`), `reason`, `attempt_n` — return `{decision:…}` to override | non-zero is **logged** and the composer's decision stands |
| `on_blocked`    | After an issue is parked to a human gate (the escalate path, #832): the typed `blocked:*` label and `ready-for-human` are applied. | `RED_AFK_ISSUE`, `RED_AFK_BLOCKED_LABEL` (`blocked:<reason>`), `RED_AFK_RECOVERY_REASON` | `issue`, `blocked_label`, `reason`, `attempt_n` — read-only context | non-zero is **logged** and the loop continues |
| `on_reconcile`  | After the no-agent reconcile (ADR 0055, #832) re-validated a parked mechanical branch and **landed / parked / skipped** it without re-running the agent. | `RED_AFK_ISSUE`, `RED_AFK_RECONCILE_OUTCOME` (`landed` \| `parked` \| `skipped`) | `issue`, `workspace`, `attempt_n`, `outcome` — read-only context | non-zero is **logged** and the loop continues |
| `on_heartbeat`  | Once per worker-vitals sample (~20s) during an inner-agent run — a periodic telemetry point, not a once-per-lifecycle one. The context carries the **full worker vitals** (ADR 0065/#832: tools/text/reasoning/reasoning-tokens/loc/cost) so an operator can drive custom live alerting. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE`, `RED_AFK_ISSUE`, `RED_AFK_VITAL_*` (one per numeric vital) | `issue`, `workspace`, `runner`, `attempt_n`, `vitals` (`{tools_called_count, text_chunk_count, reasoning_events, reasoning_tokens, waiting_count, input_tokens, output_tokens, cost_usd, loc_added, loc_removed}`) — read-only context | non-zero is **logged** and the loop continues |
| `on_idle`       | Queue drained at top of loop iteration, before sleep/exit. Distinct from `post_session` — this is "between drains" maintenance (e.g. cache cleanup), not session termination. Does **not** fire on session exit. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` | none in this slice — `stats.{done,blocked,total}` are read-only context | non-zero is **logged** and the loop continues |
| `post_session`  | Normal session termination                 | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` | session stats (`runner`, `worker_id`, `stats.{done,blocked,total}`) | non-zero is **logged** and the session ends as `NO MORE TASKS` |
| `on_session_error` | Last gasp — the AFK loop itself crashed (unhandled `set -e` exit, supervisor died, unrecoverable orchestrator exception). Distinct from `on_attempt_error` (a single attempt blew up; the loop continued) and from `post_session` (clean shutdown). This is the only path that guarantees a notification when the autonomous worker stopped without the operator noticing. Does **not** fire on a user-requested abort (`pre_session` rejection, straggler decline, Ctrl+C / SIGTERM through the cleanup trap) — those set the clean-exit sentinel before exiting. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE`, `RED_AFK_ERROR_CLASS` (`session-crash` by default), `RED_AFK_ERROR_MESSAGE` | `error` (`{class, rc, message}`) — none mutable (the loop is already collapsing) | non-zero is **logged** but the process still exits — this hook cannot rescue the session, only announce its death |

### Hook context schema (generated)

> Generated from the canonical hook registry (`apps/plugin-dev/src/core/hook-registry.ts`, #834). A drift test (`hook-registry.test.ts`) fails if this block and the registry disagree, so the contract below can never drift from the wired hooks. Edit the registry, not this table.

The stdin-JSON context each point receives, the **mutable slice** a hook may rewrite via stdout JSON (everything else is read-only context), and the exit-code policy class:

<!-- BEGIN GENERATED: hook-context-schema -->
| Hook | Stdin context (JSON) | Mutable slice | Exit policy |
|---|---|---|---|
| `pre_session` | `runner`, `worker_id`, `filter`, `iter_cap` | `runner`, `worker_id`, `filter`, `iter_cap` | non-zero **aborts** |
| `pre_pick` | `label`, `state`, `limit`, `filter` | `label`, `state`, `limit` | non-zero **aborts** |
| `post_pick` | `issues[]` | `issues[]` | non-zero **logged**, continues |
| `pre_worktree` | `issue`, `target`, `env`, `branch` | `issue`, `target`, `env` | non-zero **aborts** |
| `pre_attempt` | `issue`, `workspace`, `attempt_n`, `runner` | `issue`, `workspace`, `attempt_n` | non-zero **aborts** |
| `post_attempt` | `issue`, `workspace`, `result`, `attempt_n` | `issue`, `workspace`, `result`, `attempt_n` | non-zero **logged**, continues |
| `pre_feedback` | `issue`, `workspace`, `scopes[]` | `issue`, `workspace`, `scopes[]` | non-zero **aborts** |
| `on_baseline_probe` | `issue`, `workspace`, `ok`, `inconclusive[]` | _none (read-only)_ | non-zero **logged**, continues |
| `post_feedback` | `issue`, `workspace`, `result` | `issue`, `workspace`, `result` | non-zero **logged**, continues |
| `pre_merge` | `issue`, `workspace`, `diff`, `branch` | `issue`, `workspace`, `diff` | non-zero **aborts** |
| `post_merge` | `issue`, `workspace`, `merge_commit` | `issue`, `workspace`, `merge_commit` | non-zero **logged**, continues |
| `on_attempt_error` | `issue`, `workspace`, `error`, `attempt_n` | `issue`, `workspace`, `error`, `attempt_n` | non-zero **logged**, continues |
| `on_recovery_decision` | `issue`, `decision`, `reason`, `attempt_n` | `decision` | non-zero **logged**, continues |
| `on_blocked` | `issue`, `blocked_label`, `reason`, `attempt_n` | _none (read-only)_ | non-zero **logged**, continues |
| `on_reconcile` | `issue`, `workspace`, `attempt_n`, `outcome` | _none (read-only)_ | non-zero **logged**, continues |
| `on_idle` | `stats` | _none (read-only)_ | non-zero **logged**, continues |
| `on_heartbeat` | `issue`, `workspace`, `runner`, `attempt_n`, `vitals` | _none (read-only)_ | non-zero **logged**, continues |
| `post_session` | `runner`, `worker_id`, `stats` | `runner`, `worker_id`, `stats` | non-zero **logged**, continues |
| `on_session_error` | `error` | _none (read-only)_ | non-zero **logged**, continues |
<!-- END GENERATED: hook-context-schema -->

**Attempt vocabulary & back-compat (issue #226, ADR 0026).** The attempt-level hooks were renamed from `pre_worker` / `post_worker` / `on_worker_error` to `pre_attempt` / `post_attempt` / `on_attempt_error` so "worker" unambiguously names the orchestrator process (`RED_AFK_WORKER_ID`) and the hooks align 1:1 with ADR 0017's `attempt` (one node = one runner invocation). They fire **per runner invocation**, so a `--fallback-runner` swap on one issue yields two `pre_attempt → post_attempt` cycles; `attempt_n` remains in the mutable hook context for the first runner versus fallback swap distinction, but it is no longer exported as a `RED_AFK_*` environment variable.

### Built-in defaults

Defaults are AFK-shipped commands registered before any user hook at the
same lifecycle point. They run **first**, in a fixed registration order
that users cannot change — only **disable** individual defaults via
`afk.hooks.defaults.<name>: false`. The disable-not-reorder rule keeps
later defaults (and user hooks) able to assume an earlier default has
already had its turn at the env.

Currently shipped:

| Default  | Lifecycle point | Effect                                                                                  | Disable                              |
|----------|-----------------|-----------------------------------------------------------------------------------------|--------------------------------------|
| `cargo`  | `pre_worktree`  | When `Cargo.toml` exists at `$PROJECT_ROOT`, sets `CARGO_TARGET_DIR=${RED_AFK_CARGO_TARGET_BASE:-/opt/cargo-target}/slot-${RED_AFK_SLOT}` (mkdir-p'd) so each slot's cargo state is isolated. | `afk.hooks.defaults.cargo: false`  |
| `gradle` | `pre_worktree`  | When `build.gradle*` exists at `$PROJECT_ROOT` **and** `RED_AFK_GRADLE_USER_HOME_BASE` is set, sets `GRADLE_USER_HOME=${RED_AFK_GRADLE_USER_HOME_BASE}/slot-${RED_AFK_SLOT}` so each slot's Gradle daemons / caches are isolated. The env-var opt-in is deliberate — AFK will not claim a path on your filesystem without consent. | `afk.hooks.defaults.gradle: false` |
| `heartbeat` | `post_attempt`  | Stops the orchestrator's per-minute heartbeat sub-shell (`RED_AFK_HEARTBEAT_PID`) and appends the `iteration stopped` boundary marker to `RED_AFK_ITER_LOG`. Migrated from an inline `heartbeat_stop` call so the heartbeat now terminates *before* any user `post_attempt` hook runs. | `afk.hooks.defaults.heartbeat: false` |
| `envelope`  | `post_attempt`  | Reconciles `result.status` onto the AFK state file (`current.result_status` in `RED_AFK_STATE_FILE`) so a user `post_attempt` notifier reading state sees the worker's terminal status without re-deriving it from the sentinel. | `afk.hooks.defaults.envelope: false` |
| `validation` | `post_merge`  | Runs `pnpm test` / `typecheck` / `lint` / `build` against the merged primary checkout (when a `package.json` is present at the workspace root), then attaches `result.{validation_status, validation_summary}` to the post_merge context so user hooks see the CI/smoke outcome reconciled before they fire. Migrated from the inline post-merge CI/smoke call; the pre-merge feedback-validation step remains as the mechanism-owned safety gate (ADR 0008 — only mechanism can refuse a merge), so this default is observability + notification surface, not a gate. | `afk.hooks.defaults.validation: false` |

Example configuration:

```yaml
afk:
  hooks:
    pre_session: "echo boot"            # bare-string shorthand (one command)
    pre_merge:
      # YAML list form — each element is one command, executed in order.
      # Equivalent to the bare scalar "bash .red/hooks/fmt.sh" for a single entry.
      - bash .red/hooks/pre_merge/red-rust-fmt.sh
    post_pick:
      # filter the queue to issues you opened — RED_AFK_GITHUB_LOGIN must be set
      - "RED_AFK_GITHUB_LOGIN=$(gh api user --jq .login) \
         plugins/dev/skills/engineering/afk/examples/only-mine.sh"
    pre_worktree:
      # user hooks see CARGO_TARGET_DIR / GRADLE_USER_HOME already exported
      # by the built-in `cargo` / `gradle` defaults that ran before them
      - "echo isolated cargo dir: $CARGO_TARGET_DIR"
    on_idle:
      - "cargo clean -p reddb-storage"  # safe between drains, not on exit
    post_session:
      - "echo session done"
      - "curl -s -X POST $SLACK_URL -d \"done=$(jq -r .stats.done)\""
    defaults:
      gradle: false                     # opt out of the gradle built-in
```
