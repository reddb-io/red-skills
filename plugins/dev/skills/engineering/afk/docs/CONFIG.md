# AFK configuration & lifecycle hooks (reference)

> Extracted from `afk/SKILL.md` for progressive disclosure. Consulted on demand — not the agent's step-by-step loop.
>
> Every `.red/config.yaml` knob and `RED_AFK_*` env var the loop reads, and the lifecycle-hook contract.

## Configuration

Scalar run settings live in `.red/config.yaml` under the `afk:` key (alongside the `afk.hooks` block documented below). Each one has a matching `RED_AFK_*` env override that wins over the config value, so an E2E/CI run can pick a setting without mutating the target repo's config.

| Config key | Env override | Default | Meaning |
|---|---|---|---|
| `afk.default_runner` | `RED_AFK_RUNNER` | `claude` | Caller runner identity/default backend consumed before ambient sniffing. |
| `afk.model` | — | runner-specific | Legacy global model override. Prefer tiered `afk.models.<runner>.<tier>.model` so Codex never receives a Claude-only model. |
| `afk.models.<runner>` | — | runner-specific | Legacy per-runner scalar model override. Used only when no explicit tier model is set. |
| `afk.models.claude.<tier>.model` | — | tier-specific | Claude Code model id for `validate`, `simple`, `complex`, or `think`. |
| `afk.models.claude.<tier>.effort` | — | tier-specific | Claude Code effort for that tier. |
| `afk.models.codex.<tier>.model` | — | tier-specific | Codex model id for `validate`, `simple`, `complex`, or `think`. |
| `afk.models.codex.<tier>.effort` | — | tier-specific | Codex effort for that tier. |
| `afk.sandbox` | `RED_AFK_SANDBOX` | `none` | Isolation backend (`none` \| `docker` \| `podman`, ADR 0033). |
| `afk.max_iterations` | `RED_AFK_MAX_ITERATIONS` | `12` | Sandcastle re-invocation ceiling (issue #322) — the safety cap for "the agent never emits `<promise>DONE</promise>` or `<promise>BLOCKED</promise>`". The completion sentinel is the real terminator, so a normal issue finishes in 1–3 iterations; this leaves headroom without letting repeated no-sentinel failures run for too long. A non-numeric / zero / negative value in either the env or the config is ignored (falls through to the default) so a typo can never disable the cap or pin the agent to 1. |
| — | `RED_AFK_IDLE_TIMEOUT_S` | `600` | Sandcastle's per-iteration **silence** watchdog (seconds): an iteration that produces no stream output for this long is aborted. The actual termination bound on a quiet hang. Env-only; typo-safe (non-numeric / zero / negative is ignored → default). |
| `afk.attempt_timeout` | `RED_AFK_ATTEMPT_TIMEOUT_S` | `2700` | Commit-anchored attempt **progress** guard (seconds, ADR 0044/0045): a busy run that lands no new commit within the cap is aborted (`timeout` → `blocked:stalled` / `ready-for-human`, worktree/PR preserved), resetting on every commit. Armed only under `none` isolation. Typo-safe (env > config > default). |
| `afk.claim_reaper.refresh_s` | `RED_AFK_CLAIM_REFRESH_S` | `300` | Cross-host stale-claim refresh cadence (seconds). The stale window is `refresh_s × (stale_tolerance + 1)`. |
| `afk.claim_reaper.stale_tolerance` | `RED_AFK_CLAIM_STALE_TOLERANCE` | `3` | Consecutive missed claim refreshes tolerated before the stale-claim sweep may recover the issue. `0` is allowed. |
| `afk.claim_reaper.grace_s` | `RED_AFK_CLAIM_REAPER_GRACE_S` | `300` | Minimum claim age before the stale-claim sweep may recover a `running` issue, even if the stale window is configured aggressively. |
| `afk.claim_reaper.recent_commit_s` | `RED_AFK_CLAIM_REAPER_RECENT_COMMIT_S` | `2700` | Sliding progress-protection window: a live `afk/*/<issue>-*` attempt branch with a commit this recent protects the claimed issue from stale-claim recovery. |
| `afk.statusline_cache_ttl` | `RED_AFK_STATUSLINE_CACHE_TTL_S` | `180` | TTL (seconds) of every EXPENSIVE FETCHED statusline number — the GitHub-derived queue/human + open-PR/open-issue counts AND the repo-global local diffstat, cached in `.red/tmp/statusline-cache.json` / `.red/tmp/statusline-repo-cache.json` (issue #1178, #1217). The statusline renders on every prompt, so a per-render gh/git round-trip would freeze the TUI; the network cost is paid at most once per TTL. Also drives the monitor's stale-cache marker. Use the **flat** key — do **not** nest it under `afk.statusline` (that key is the boolean statusline opt-out; YAML cannot make one key both a boolean and a map). Typo-safe (env > config > default): a non-numeric / zero / negative value in **either** source falls through to the next and ultimately the 180 default — never 0 (a 0 TTL would refresh on every render, defeating the cache). |
| `afk.backpressure` | — | _(empty)_ | Ordered list of shell commands run as an extra pre-merge gate on the DONE path (issue #430, PRD #429). |
| `afk.worktree_launches_pull_request` | — | `true` | Landing **mode**, decoupled from the branch-lock (ADR 0030 amended, #842). `true` (default) → the attempt lands via an **admin-merged PR** into the resolved base; `false` → a **direct merge** into that base (offline, no PR — only the post-commit push the worker already does). The branch-lock now only resolves the *target* base (lock > pin > main, ADR 0031); this flag decides PR-vs-direct **independently**. So: no lock + `true` → admin-PR to `main`; no lock + `false` → direct merge to `main`; lock=`X` + `true` → admin-PR to `X`; lock=`X` + `false` → direct merge to `X`. *How* a PR merges (admin vs `wait_for_review` vs `review_gate`) stays governed by `afk.merge.*`. **Migration:** the default `true` flips the old *locked* behaviour (which direct-merged) — a locked repo now gets an admin-PR to its lock branch; set `false` to keep the old offline/direct-promotion flow. |
| `afk.merge.wait_for_review` | — | `false` | Merge-gate policy (ADR 0048). When `false` (default), the unlocked admin-merge proceeds **ignoring advisory review checks** (e.g. CodeRabbit) — the binding gates are `drift-guard` (the `pre_merge` hook) + in-process backpressure/feedback. When `true`, the unlocked landing **waits** for the configured review check to conclude before merging, then merges regardless of its verdict (the review stays advisory). `drift-guard` is a hard gate either way. |
| `afk.merge.review_check` | — | `CodeRabbit` | Name (case-insensitive substring) of the advisory review check `wait_for_review` polls via `gh pr checks`. Only consulted when `afk.merge.wait_for_review` is `true`. |
| `afk.merge.ci_aware` | — | `false` | CI-aware merge (#812). When `false` (default), the unlocked admin-merge fires immediately — correct only on a base with **no** required status checks. When `true`, the unlocked landing first polls `gh pr view --json mergeStateStatus,statusCheckRollup` until the PR settles, then admin-merges **only** once it is genuinely ready (`CLEAN`, or `BLOCKED` solely by a required review `--admin` waives). Required for any `enforce_admins` base, where an admin-merge **cannot** bypass required checks: a real conflict / `DIRTY` / `BEHIND` → `blocked:merge-conflict`; a **failed** required check → `blocked:ci`; checks still **pending** at the timeout → `blocked:ci` with the open PR preserved (never re-runs the inner agent). |
| `RED_AFK_MERGE_CI_TIMEOUT_S` | env | `1800` | CI-aware merge wait budget, in seconds (#812). The poll runs at a fixed 10s cadence until `mergeStateStatus` settles; on timeout the open, MERGEABLE PR is handed off (`ci-pending` → `blocked:ci`) instead of re-running the agent. Non-positive / unparseable → the 1800s default. Only consulted when `afk.merge.ci_aware` is `true`. |
| `afk.review_gate.enabled` | — | `false` | PR review gate (ADR 0064 §10, #749). When `true`, a completed **non-mechanical** attempt (classified tier at/above `afk.review_gate.threshold`) gets `ready-for-review` on its PR — firing the advisory review — and **holds the merge** for a fresh-agent review by a different agent than the one that implemented it. Mechanical/trivial work keeps the fast-merge path. Only affects a PR landing (`worktree_launches_pull_request: true`); a direct merge never opens a PR, so the gate is moot there. Off by default so the "merge fast / no drift" loop is unchanged until a repo opts in. |
| `afk.review_gate.threshold` | — | `complex` | The cheapest issue-classifier tier (`validate` \| `simple` \| `complex` \| `think`) counted as non-mechanical. Tiers below it stay mechanical (fast-merge); this tier and above request review. |
| `afk.companion.iteration_churn` | — | `8` | Companion (active) monitor drift threshold (#921): a live worker at/above this iteration **and** below `min_progress_loc` added lines is judged `iteration-churn`. Only read when `monitor --companion` / `--active` is set (off → byte-for-byte read-only dashboard, no gh writes). A non-positive override falls back to the default. |
| `afk.companion.waiting_windows` | — | `20` | Companion drift threshold: a flat-diff worker with this many zero-progress waiting windows is judged `stuck-waiting`. |
| `afk.companion.diff_drift_loc` | — | `4000` | Companion drift threshold: total churn (added + removed) at/above this is judged `scope-creep` (sprawling past the issue), the highest-priority signal. |
| `afk.companion.min_progress_loc` | — | `5` | Companion progress floor: a worker that has added at least this many lines has produced real work and is never flagged for churn/stuck. |
| `afk.companion.*` (cap) | `RED_AFK_RETRY_DRIFT` | `2` | Companion bounded re-enqueue budget. Each detected drift on an attempt injects **one** correction (write-only, idempotent via a fingerprint, rewriting `## Agent brief`); once the attempt count reaches this cap the companion **escalates** to `ready-for-human` (a `## Current blocker` of kind `drift`) instead of correcting again. Shares the bounded-recovery policy (`core/recovery.ts`); never kills a process — termination/respawn is the reaper + fleet's job. |

```yaml
afk:
  worktree_launches_pull_request: true   # true → admin-PR landing; false → direct merge (offline). Decoupled from the lock (#842)
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
  attempt_timeout: 2700   # commit-anchored progress guard (seconds)
  statusline_cache_ttl: 180   # statusline gh/git cache TTL (seconds); flat key, NOT under afk.statusline
  backpressure:           # extra pre-merge gate, runs after the feedback gate
    - npm run test
    - npm run lint
  merge:
    wait_for_review: false   # true → hold the unlocked admin-merge until the review check concludes
    review_check: CodeRabbit
    ci_aware: false          # true → poll mergeStateStatus and merge only once required checks settle (#812; needed for enforce_admins bases)
  review_gate:
    enabled: false           # true → non-mechanical PRs get ready-for-review + hold the merge for a fresh-agent review
    threshold: complex       # cheapest tier counted as non-mechanical (validate|simple|complex|think)
```

`RED_AFK_IDLE_TIMEOUT_S` is env-only (no `afk.*` config key); `sandbox`, `max_iterations`, `attempt_timeout`, and `statusline_cache_ttl` resolve env > config > default. The three runtime bounds — silence (`idleTimeoutSeconds`), re-invocation count (`maxIterations`), and no-commit-progress (attempt guard) — are detailed under *Attempt Completion & Termination Bounds*.

### Backpressure gate

`afk.backpressure` is an operator-declared, ordered list of shell commands that **supplements** the auto-derived feedback gate (it does not replace it). On a successful DONE attempt — after the scope-derived `test`/`typecheck`/`lint`/`build` feedback gate passes, before landing — AFK runs each backpressure command in order (`sh -c <command>`) against a checkout of the worker branch. If **any** command exits non-zero the merge is blocked and the issue is parked to `ready-for-human` with `blocked:validation`, exactly like a feedback failure: the failing command and its output tail land in the terminal envelope and in the `red.afk.validation.v1` validation sidecar (records named `backpressure:<command>`). An absent or empty block is a no-op (today's behaviour). The namespaced `plugins.dev.afk.backpressure` location is honoured with the legacy bare `afk.backpressure` fallback (ADR 0042).

**This is how maintainers tell an inner agent the exact gate it must satisfy — without ad-hoc `-r` retry guidance.** When `afk.backpressure` is set, every inner-agent handoff carries a `<merge-gate>` section listing the configured commands verbatim, and the agent's exit-protocol completion contract instructs it to run and pass those commands *before* emitting `<promise>DONE</promise>` (issue #849). The contract distinguishes two kinds of check: the **touched-package confidence checks** the agent runs while developing (the package's own `test`/`typecheck`/`lint`/`build`) versus the **binding merge gate** the orchestrator enforces after DONE (these backpressure commands plus `drift-guard`). So for repos with a broader gate than any single touched package — `cargo fmt --all -- --check`, a workspace-wide `cargo clippy`, an integration smoke — declare it once under `afk.backpressure` and the agent sees and satisfies it on the first attempt instead of bouncing as `blocked:validation`. On a retry, the prior failure's command and output tail remain visible through `<prior-attempt-context>`, so the next agent can target the real blocker. The agent is told **not** to re-run an unbounded full repository suite after its final commit; the listed gate commands are the contract.

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

Within a single hook list, **built-in defaults run first, user-declared commands run after**, and declaration order is preserved inside each group. A bare string is shorthand for a one-element list. An unknown hook name in `.red/config.yaml` is a hard error at session boot. Disable a built-in default with `afk.hooks.defaults.<name>: false` — reordering is not supported.

Every hook command emits explicit dispatch breadcrumbs around the shell call:
`[afk:hooks] <point>: enter: <command>` and
`[afk:hooks] <point>: exit rc=<n>: <command>`. Session-scoped hooks write those
lines to the session output, per-issue hooks write them to the attempt's
`afk.log`, and fleet hooks use the analogous `[afk:fleet-hooks]` prefix in the
supervisor log. A quiet Worker can therefore still show policy/hook activity
without pretending the inner agent lane advanced.

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
| `pre_attempt`    | After worktree exists, **before each runner invocation** (per attempt, not per issue — re-fires on a `--fallback-runner` swap with `attempt_n=2`) | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (now the worktree), `RED_AFK_ISSUE`, `RED_AFK_ATTEMPT_N` | `issue`, `workspace` (worktree path), `attempt_n` — `runner` is read-only context | non-zero **skips runner invocation**: the worktree is preserved, the heartbeat stops, and the claim is restored to `ready-for-agent` so post-pick state is reconciled cleanly |
| `post_attempt`   | After the runner returned **with an authored `<promise>` exit** — DONE or BLOCKED — for that attempt. Does **not** fire on runner crash or EOF-without-sentinel (see `on_attempt_error`). Under `--fallback-runner` it fires once per runner invocation (the swapped-away attempt closes with `result.status=exhausted`). The parsed sentinel outcome (`done` / `blocked` / `no_more_tasks`, or `""` for the exhausted firings) rides in `result.outcome` (ADR 0028). | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (the worktree), `RED_AFK_ISSUE`, `RED_AFK_RESULT_STATUS` (`success` \| `fail`), `RED_AFK_RESULT_OUTCOME` (`done` \| `blocked` \| `no_more_tasks` \| empty), `RED_AFK_ATTEMPT_N` | `issue`, `workspace`, `result` (`{status, outcome}`), `attempt_n` | non-zero is **logged** and the loop continues — a broken notifier/pager must never wedge AFK |
| `on_attempt_error` | When the attempt produced **no authored exit**: either an unhandled exception in the worker path (`run_inner` exited non-zero outside the quota branch — `runner-crash`), or the runner's pipe closed with **no `<promise>` sentinel** (EOF-without-sentinel — `no-sentinel`, ADR 0028; the issue routes through bounded `blocked:crashed` recovery). Distinct from `post_attempt` with `result.status=fail`, so hook authors do not have to demultiplex. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (the worktree), `RED_AFK_ISSUE`, `RED_AFK_ERROR_CLASS` (`runner-crash` \| `no-sentinel`), `RED_AFK_ATTEMPT_N` | `issue`, `workspace`, `error` (`{class, rc}`), `attempt_n` | non-zero is **logged** and the loop continues |
| `pre_feedback`  | After a green attempt, before the scope-derived feedback gate (the merge gate, ADR 0008) runs (#832). The resolved scopes are on stdin so a guard can veto validation. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (the worktree), `RED_AFK_ISSUE` | `issue`, `workspace`, `scopes[]` | non-zero **aborts** the feedback gate; the attempt routes through the bounded `blocked:policy` (hook-aborted) recovery, branch/PR preserved |
| `on_baseline_probe` | After the feedback gate **failed** and the "already failing on the base branch?" probe ran (ADR 0071). Fires only on a gate failure (the probe never runs on green). `downgraded[]` lists the checks reclassified from `failed` to `skipped` because they also failed on the baseline. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE`, `RED_AFK_ISSUE` | `issue`, `workspace`, `ok` (always `false` here), `downgraded[]` — read-only context | non-zero is **logged** and the loop continues |
| `on_feedback_classify` | After a feedback failure is classified **INFRA vs SEMANTIC** (ADR 0071), before the recovery routing reads the verdict. **Mutable**: a hook may override the classification. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE`, `RED_AFK_ISSUE`, `RED_AFK_FEEDBACK_CLASS` (`infra` \| `semantic`) | `issue`, `workspace`, `class` (`infra` \| `semantic`) — return `{class:…}` to override; any other value keeps the computed class | non-zero is **logged** and the computed class stands |
| `post_feedback` | After the scope-derived feedback gate produced its verdict (#832), on both pass and fail, before the merge or the failure routing. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE`, `RED_AFK_ISSUE` | `issue`, `workspace`, `result` (`{status: pass\|fail}`) | non-zero is **logged** and the loop continues |
| `pre_merge`     | Before the merge mechanism (`git merge --no-ff` into the pinned base). The diff between the merge base and the worker branch is on stdin so a guard hook can reject changes by size, file pattern, etc. The merge itself plus conflict resolution remain **mechanism** (ADR 0008) and sit between `pre_merge` and `post_merge` — never dispatched as a hook. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (primary checkout), `RED_AFK_ISSUE`, `RED_AFK_MERGE_BASE` | `issue`, `workspace`, `diff` — `branch` is read-only context | non-zero **aborts the merge** for this issue; the failure surfaces as a worker-failure and routes through bounded `blocked:merge-conflict` recovery |
| `post_merge`    | After a successful merge and push to origin/`{pinned}`. The merge commit already exists, so user notifiers can include the real merge commit URL. Does **not** fire when the merge was aborted (`pre_merge` rejection, conflict resolver exhausted, push rejected). | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (primary checkout), `RED_AFK_ISSUE`, `RED_AFK_MERGE_COMMIT` (full sha), `RED_AFK_MERGE_SHA` (short sha) | `issue`, `workspace`, `merge_commit` (`{sha, short}`) — extended by the built-in `validation` default with `result.{validation_status, validation_summary}` | non-zero is **logged** and the loop continues — the merge has already landed; a broken notifier or a flaky smoke test must never roll it back |
| `on_attempt_timeout` | When the commit-anchored progress guard fires (ADR 0044/0045, #832): the attempt was alive but produced no new commit within the cap. Fires before the no-agent reconcile / escalation routing. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` (the worktree), `RED_AFK_ISSUE`, `RED_AFK_ATTEMPT_N`, `RED_AFK_RECOVERY_REASON` (`timeout`) | `issue`, `workspace`, `attempt_n`, `reason` (`timeout`) — read-only context | non-zero is **logged** and the loop continues |
| `on_recovery_decision` | After the disposition composer proposes **retry vs escalate** for a terminal failure (#832), before any label is applied. **Mutable**: a hook may override the decision. | `RED_AFK_ISSUE`, `RED_AFK_RECOVERY_DECISION` (`retry` \| `escalate`), `RED_AFK_RECOVERY_REASON` | `issue`, `decision` (`retry` \| `escalate`), `reason`, `attempt_n` — return `{decision:…}` to override | non-zero is **logged** and the composer's decision stands |
| `on_blocked`    | After an issue is parked to a human gate (the escalate path, #832): the typed `blocked:*` label and `ready-for-human` are applied. | `RED_AFK_ISSUE`, `RED_AFK_BLOCKED_LABEL` (`blocked:<reason>`), `RED_AFK_RECOVERY_REASON` | `issue`, `blocked_label`, `reason`, `attempt_n` — read-only context | non-zero is **logged** and the loop continues |
| `on_reconcile`  | After the no-agent reconcile (ADR 0055, #832) re-validated a parked mechanical branch and **landed / parked / skipped** it without re-running the agent. | `RED_AFK_ISSUE`, `RED_AFK_RECONCILE_OUTCOME` (`landed` \| `parked` \| `skipped`) | `issue`, `workspace`, `attempt_n`, `outcome` — read-only context | non-zero is **logged** and the loop continues |
| `on_heartbeat`  | Once per attempt-guard poll (~60s) during an inner-agent run — a periodic proof-of-life point, not a once-per-lifecycle one. The context carries the **full worker vitals** (ADR 0065/#832: tools/text/reasoning/reasoning-tokens/loc/cost) so an operator can drive custom live alerting. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE`, `RED_AFK_ISSUE`, `RED_AFK_ATTEMPT_N`, `RED_AFK_VITAL_*` (one per numeric vital) | `issue`, `workspace`, `runner`, `attempt_n`, `vitals` (`{tools_called_count, text_chunk_count, reasoning_events, reasoning_tokens, waiting_count, input_tokens, output_tokens, cost_usd, loc_added, loc_removed}`) — read-only context | non-zero is **logged** and the loop continues |
| `on_idle`       | Queue drained at top of loop iteration, before sleep/exit. Distinct from `post_session` — this is "between drains" maintenance (e.g. cache cleanup), not session termination. Does **not** fire on session exit. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` | none in this slice — `stats.{done,blocked,total}` are read-only context | non-zero is **logged** and the loop continues |
| `post_session`  | Normal session termination                 | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE` | session stats (`runner`, `worker_id`, `stats.{done,blocked,total}`) | non-zero is **logged** and the session ends as `NO MORE TASKS` |
| `on_session_error` | Last gasp — the AFK loop itself crashed (unhandled `set -e` exit, supervisor died, unrecoverable orchestrator exception). Distinct from `on_attempt_error` (a single attempt blew up; the loop continued) and from `post_session` (clean shutdown). This is the only path that guarantees a notification when the autonomous worker stopped without the operator noticing. Does **not** fire on a user-requested abort (`pre_session` rejection, straggler decline, Ctrl+C / SIGTERM through the cleanup trap) — those set the clean-exit sentinel before exiting. | `RED_AFK_RUNNER`, `RED_AFK_WORKSPACE`, `RED_AFK_ERROR_CLASS` (`session-crash` by default), `RED_AFK_ERROR_MESSAGE` | `error` (`{class, rc, message}`) — none mutable (the loop is already collapsing) | non-zero is **logged** but the process still exits — this hook cannot rescue the session, only announce its death |

### Hook context schema (generated)

> Generated from the canonical hook registry (`apps/dev/src/core/hook-registry.ts`, #834). A drift test (`hook-registry.test.ts`) fails if this block and the registry disagree, so the contract below can never drift from the wired hooks. Edit the registry, not this table.

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
| `on_baseline_probe` | `issue`, `workspace`, `ok`, `downgraded[]` | _none (read-only)_ | non-zero **logged**, continues |
| `on_feedback_classify` | `issue`, `workspace`, `class` | `class` | non-zero **logged**, continues |
| `post_feedback` | `issue`, `workspace`, `result` | `issue`, `workspace`, `result` | non-zero **logged**, continues |
| `pre_merge` | `issue`, `workspace`, `diff`, `branch` | `issue`, `workspace`, `diff` | non-zero **aborts** |
| `post_merge` | `issue`, `workspace`, `merge_commit` | `issue`, `workspace`, `merge_commit` | non-zero **logged**, continues |
| `on_attempt_error` | `issue`, `workspace`, `error`, `attempt_n` | `issue`, `workspace`, `error`, `attempt_n` | non-zero **logged**, continues |
| `on_attempt_timeout` | `issue`, `workspace`, `attempt_n`, `reason` | _none (read-only)_ | non-zero **logged**, continues |
| `on_recovery_decision` | `issue`, `decision`, `reason`, `attempt_n` | `decision` | non-zero **logged**, continues |
| `on_blocked` | `issue`, `blocked_label`, `reason`, `attempt_n` | _none (read-only)_ | non-zero **logged**, continues |
| `on_reconcile` | `issue`, `workspace`, `attempt_n`, `outcome` | _none (read-only)_ | non-zero **logged**, continues |
| `on_idle` | `stats` | _none (read-only)_ | non-zero **logged**, continues |
| `on_heartbeat` | `issue`, `workspace`, `runner`, `attempt_n`, `vitals` | _none (read-only)_ | non-zero **logged**, continues |
| `post_session` | `runner`, `worker_id`, `stats` | `runner`, `worker_id`, `stats` | non-zero **logged**, continues |
| `on_session_error` | `error` | _none (read-only)_ | non-zero **logged**, continues |
<!-- END GENERATED: hook-context-schema -->

**Attempt vocabulary & back-compat (issue #226, ADR 0026).** The attempt-level hooks were renamed from `pre_worker` / `post_worker` / `on_worker_error` to `pre_attempt` / `post_attempt` / `on_attempt_error` so "worker" unambiguously names the orchestrator process (`RED_AFK_WORKER_ID`) and the hooks align 1:1 with ADR 0017's `attempt` (one node = one runner invocation). They fire **per runner invocation**, so a `--fallback-runner` swap on one issue yields two `pre_attempt → post_attempt` cycles; `attempt_n` (mutable-context field and the `RED_AFK_ATTEMPT_N` env var) carries the attempt counter (1 for the first runner, 2 for the swap). For one release window, the old names declared in `.red/config.yaml` still fire — they are translated to the canonical names at session boot with a single deprecation warning logged. Rename them before the next release; the back-compat shim is dropped then.

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
    pre_session: "echo boot"            # bare-string shorthand
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
