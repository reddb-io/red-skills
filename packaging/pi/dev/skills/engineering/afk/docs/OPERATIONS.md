---
name: afk
description: Autonomous loop that drains the `ready-for-agent` queue on the issue tracker. Each iteration claims an issue, runs it in an isolated worktree, executes with claude or codex, merges back to main, and closes the issue. Use when the user wants to run AFK execution, drain a Spec, hammer specific issues, or otherwise let agents grind through the backlog.
argument-hint: "[--spec N | --issues N,N,N] [--runner claude|codex|opencode] [--alternate] [--fallback-runner] [--request TEXT] [-n N] [--once] [--boot-only] | fleet [N] | fleet stop | monitor | dashboard | daily-review | weekly-review | retake N | reap"
---

# /afk

**The default lane for all tracked backlog work.** `/afk` is the modus operandi; `/go` is the ad-hoc-only exception. Run the bundle, don't read the source — this `SKILL.md` is the complete behavioural contract; the `bin/` bundle and the `scripts/` files are build/runtime artifacts, and everything an agent needs to operate `/afk` is in this file.

Drain the agent-ready backlog. Single skill that owns issue selection, worktree isolation, inner-agent execution, GitHub state coordination, merge-back, and runner-fallback.

## Runtime & Invocation

The skill ships a single committed runtime bundle. Invoke it as:

```
RED_AFK_RUNNER=<claude|codex|opencode> npx -y -p @reddb-io/red-skills-dev@<version> red-skills-dev <command> [params]
```

The invoking LLM is responsible for setting `RED_AFK_RUNNER` to its own host runner (`codex` from Codex, `claude` from Claude Code). Do not infer a different runner from binaries on `PATH`; use `--runner` only when the user explicitly pinned one.

`afk.mjs` is a **dedicated forwarder** (ADR 0039 entrypoint, build role `run:dev`): every argument is passed straight to the `dev` bundle, whose own command surface (`run`, `monitor`, `fleet`, …) is documented below. So `… afk.mjs run --once`, `… afk.mjs monitor`, and the bare `… afk.mjs --issues 42` all reach the orchestrator. The generic entrypoint verbs (`run <plugin>` / `fetch`) belong to `red-fetch.mjs`, not to this launcher — they do **not** shadow the bundle's commands (#434).

Commands and their parameters are documented in *When To Use* below — that section is authoritative for the CLI surface.

The bundle is a single self-contained build (one file, one inlined runtime dependency, no `node_modules`, no install step) and is the public entrypoint. Every command — orchestration, supervisor, statusline, and hooks — executes natively in the bundle.

## Execution Substrate (ADR 0033)

The per-issue **agent run** executes on `@reddb-io/worker` — reddb.io's vendored sandcastle fork, committed under `packages/worker` and consumed as source (ADR 0061/0101) — not on a hand-rolled `claude -p` / `codex exec` session whose stdout is grepped for stage transitions. The boundary is clean: **the substrate owns execution, AFK owns the issue policy**.

- **sandcastle** (one `run()` call per attempt) spawns the inner agent, creates and manages the git worktree, runs the configured sandbox, captures the agent's stream, detects the completion signal, and lands the agent's commits on the worker branch.
- **AFK** keeps everything around that call: issue selection, the three-layer claim, the handoff file, the package-aware feedback gate, lock-toggled landing (ADR 0030), base resolution (ADR 0031), the terminal-event envelope, close, and the boot/monitor/mirror sweeps.

AFK drives the sandcastle Orchestrator through **injected providers** (`SandcastleDeps`: `run`, `agentFor`, `sandboxFor`) so the single adapter module is the only code coupled to the package. The pure mapping (`buildRunOptions` → `RunOptions`, `interpretOutcome` → outcome) is unit-tested with `run` injected; the real providers are wired lazily once, on the first agent run, so a `monitor` / `reap` / empty-queue path never imports sandcastle. AFK's canonical sentinels `<promise>DONE</promise>` and `<promise>BLOCKED</promise>` are registered as sandcastle `completionSignal`s, so the [`AGENT-PROMPT.md`](../AGENT-PROMPT.md) contract is unchanged — the agent still authors its own exit.

`run()` returns `{ branch, commits, completionSignal }`; AFK maps `completionSignal` to an outcome (`done` / `blocked` / `no-sentinel`) and proceeds with its own feedback → landing → envelope → close. Execution is a **single `runAgent` call**, not a multi-mode dispatch over named run-modes.

## When To Use

- `/afk` — every issue currently labelled `ready-for-agent`.
- `/afk --spec 42` — only issues that reference Spec #42 (by `spec: #42` line in body, parent link, or `spec:42` label).
- `/afk --issues 356,359,362` — explicit list, in that order.
- `/afk --runner codex` — pin a backend (disables detection cascade; mutually exclusive with `--alternate`).
- `/afk --alternate` — opt in to round-robin runner rotation between issues (claude → codex → claude → …).
- `/afk --fallback-runner` — opt in to swapping runners mid-issue when one returns `RUNNER_EXHAUSTED`. Without this flag, exhaustion routes the issue through bounded `blocked:quota` recovery and stops the outer run with exit 75.
- `/afk --request "dont run cargo tests for this issue resolution"` or `/afk -r "..."` — add a special user request block to every inner-agent prompt for this run.
- `/afk -n 5` — cap at five issues. `-n N` caps the run at `N` issues; `-n 0` (and omitting `-n`) drains the whole queue until it is empty (`0` means unlimited, not zero). For a no-agent dry-run use `--boot-only` instead.
- `/afk --once` — single supervised iteration. Use for debugging the prompt.
- `/afk --boot-only` — run the boot sweeps then exit without claiming or spawning an agent; a safe dry-run to inspect bootstrap / orphan-cleanup / unblock-sweep / precheck.
- `/afk monitor` — readonly status board that aggregates every `.red/tmp/workers/*/*/afk.state.json` so you see all live workers from another terminal, and mirrors them onto the host runner's native task surface. Running `afk monitor` → read [`monitor.md`](../monitor.md) for the full protocol (dashboard render plus the binding task mirror).
- `/afk dashboard [--period 30d] [--json]` — readonly process dashboard: open Specs/issues, global `running` issues, local AFK workers on this machine, issue/PR flow metrics, and DORA proxy metrics.
- `/afk daily-review [--json]` — readonly daily operational review from yesterday local midnight to now: delivery big numbers, local worker attempts/time, token spend when available, HITL/blocker challenges, and issue/PR cycle times.
- `/afk weekly-review [--json]` — readonly six-day operational review from six-days-ago local midnight to now, with the same sections as `daily-review`.
- `/afk retake 123 [--apply] [--json]` — issue resumption report: reads the issue, linked PRs, matching local/remote branches, matching local worktrees, HITL state, and prints the next command to continue, fix, recreate a work worktree, or run `requeue`. With `--apply`, executes only safe local setup `git` operations and still leaves merges/HITL to `requeue` or `/hitl`. The parser accepts `#123` too; quote it when invoking through a shell.
- `/afk fleet [N]` — launch the supervisor maintaining `N` concurrent workers (default `2`). Running `afk fleet` → read [`fleet.md`](../fleet.md) for the full launch/stop/supervisor protocol.
- `/afk fleet stop` — gracefully shut down a running fleet supervisor and cancel its auto-monitor cron.
- `/afk reap` — run branch hygiene without starting a worker: count lines for remote `afk/*` and local `afk/*`, then the same safe live-branch reapers used at boot.

### Running `/afk` in an execution environment (GitHub Actions)

The same `/afk --issues N --runner opencode --once` command runs unchanged in a
GitHub Actions runner — one attempt, one issue, one PR per invocation, no fleet,
no admin-merge. Only the trigger and the secret-injection surface differ.

The lane is packaged as three layers (ADR 0059/0062): the reusable workflow
`.github/workflows/reusable-afk-attempt.yml` (triggers + trust gate) → the composite
action `.github/actions/afk-attempt` (execution) → the `afk.mjs` launcher +
Release bundle (runtime). Two adoption paths: **turnkey** (call the reusable) or
**composable** (`uses: reddb-io/red-skills/.github/actions/afk-attempt@v1` with
your own triggers/gate). Pin `@v1`/SHA for reproducibility. The composite action
carries its own red-skills checkout, so the launcher resolves in any adopter repo
— no workspace build, no submodule.

Triggers: `issues: labeled`/`opened` (on `ready-for-agent`), `workflow_dispatch`,
`workflow_call`. Trust gate (ADR 0085): author + label-actor must both be
allowlisted. Runner: opencode (API-auth); point it at OpenAI/MiniMax/OpenRouter
by wiring the matching key + a `<provider>/<model>` slug via the `model` input.

**→ Full adopter guide:
[`actions-lane.md`](../actions-lane.md)** (architecture, both examples, all
inputs, triggers, trust gate, auth precedence, the MiniMax recipe, permissions).

The k8s job manifest + real-environment E2E remain tracked as
[#631](https://github.com/reddb-io/red-skills/issues/631) (ADR 0059).

## Parallelization

`/afk` is **trivially parallel** — just open another terminal and run `/afk` again. No flag, no coordination, no slot to manage.

```bash
/afk            # terminal A → spawns worker "wZ2R4"
/afk            # terminal B → spawns worker "wK7M2"
/afk            # terminal C → spawns worker "w9RQP"
```

Each invocation generates its own **worker ID** — literal `w` plus 4 random characters from `[A-Z0-9]` (e.g. `wZ2R4`, ~1.7M possible IDs) — and uses it as the prefix for every per-run file. The leading `w` makes the worker directory `.red/tmp/workers/{id}` an unambiguous live-worker anchor. The ID is printed on the first line of the run so you can tail or kill it later.

Per-issue files live under `.red/tmp/workers/{id}/{N}/` in the primary checkout, where `{id}` is the worker ID and `{N}` is the issue number. There is no attempt level (ADR 0103): a worker re-queued onto the same Ticket reuses the same workspace. Everything for one (worker, issue) is in one directory — when the run ends successfully the whole directory is removed; when it blocks the whole directory is preserved. The worker also holds a single per-worker liveness anchor at `.red/tmp/workers/{id}/worker.pid` (see the `worker.pid` row below).

| Path | Purpose |
|---|---|
| `.red/tmp/workers/{id}/worker.pid` | Per-worker liveness anchor: the orchestrator's PID, written **once at bootstrap** and removed on the worker's EXIT trap (along with rmdir of the empty worker dir). The single liveness anchor for the worker; the fleet supervisor's slot matching keys off it. |
| `.red/tmp/workers/{id}/{N}/worktree/` | Git worktree for issue `N`. Lives inside the gitignored `.red/tmp/` so it never pollutes sibling directories. |
| `.red/tmp/workers/{id}/worker.log.toonl` | The Worker's one log: lifecycle, stdout/stderr, setup and agent narration, waits, validation narration, and heartbeat messages as tail-readable TOONL `msg` records. |
| `.red/tmp/workers/{id}/{N}/liveness.toonl` | Protected liveness anchor consumed by the evaluator/reaper. Separate because narration must not manufacture proof of life. |
| `.red/tmp/workers/{id}/{N}/validation.jsonl` | Machine-readable gate artifact. Separate because it is a tool contract, not narration. |
| `~/.red/redskilled/redskilled.log.toonl` | The host daemon's one log. Host-scoped because the daemon spans projects. |
| `.red/tmp/supervisors/default/supervisor.log.toonl` | Fleet supervisor firehose — append-only TOONL heartbeat records for the supervisor itself. Legacy `.red/tmp/afk-supervisor.log.jsonl`, `.red/state/afk/`, and `.red/state/castle/` structured firehose copies are boot-migrated into this live supervisor lane. Read with `tail -f .red/tmp/supervisors/default/supervisor.log.toonl \| tq -p toonl -o json -r .msg`. Readers sniff legacy JSONL and mixed files; the lane is never rewritten in place. |
| `.red/tmp/workers/{id}/{N}/afk.state.json` | State snapshot for this run. Schema in [`docs/ENVELOPE.md`](./ENVELOPE.md). |
| `.red/tmp/workers/{id}/{N}/handoff.md` | Handoff file the inner agent reads — `<issue-body>` (issue body verbatim, including the `## Agent brief` markdown section), `<previous-workers>`, `<human-guidance-thread>` (one `<human-guidance>` per extracted directive), `<thread-discussion>` (advisory comments with no directive marker), `<agent-notes>`. Top-level XML wrappers make body/comments/notes unambiguous. Template in [`docs/HANDOFF.md`](./HANDOFF.md). |
| `.red/state/castle/cutover.toon` | One-time ADR 0130 cutover report (contract `red.castle.cutover.v1`): what the daemon cutover stopped, quiesced and pruned, and every artifact it deliberately left behind with the reason. Also the run-once gate — its presence makes the migration a no-op. Full rules and the rollback path in [`docs/CUTOVER.md`](./CUTOVER.md). |
| `.red/tmp/workers/{id}/{N}/implementer-runtime.toon` | Per-run skill-projection artifact: enabled plugins, selected `plugin:skill` names, exact serialized skill-manifest bytes, projection-setup timing, and actual runner startup from invocation to first stream event. A configured historical startup baseline provides the before/delta comparison. Finalized measurements are emitted as `worker.implementer-environment`, stamped into worker state, and aggregated by `/afk dashboard`. |

Two workers cannot claim the same issue thanks to a local `mkdir` lock at `.red/tmp/claims/{N}/` plus a `gh issue view` pre-check before the edit. The gh edit itself is not atomic (see *Issue Lifecycle* below for the full three-layer scheme). The race surface is the brief window between two separate checkouts on the same host — acceptable for the intended scale.

## Hard Preconditions

Refuse to start if any fail — the user fixes them.

- `git remote -v`: SSH only. Reject HTTPS — never auto-rewrite.
- `gh auth status` succeeds.
- Repo has `main` branch: `git -C primary log -1 main` works.
- Label `ready-for-agent` exists; if not, point at `/triage`.
- `pnpm` is on PATH.

## Bootstrap

Run before the first iteration:

1. Ensure `.red/tmp/` exists (create) and in `.gitignore` (append if missing).
2. **Generate worker ID:** `w` + 4 random `[A-Z0-9]` chars (e.g. `wZ2R4`). Regenerate on live-directory collision. Print `worker: {id}` first.
3. **Detect runner** (first wins; log `runner: <r> (detected via <method>)`). Load the matching runner doc. Never probe `command -v`; swap only via `--fallback-runner`.
   - `--runner X` pin (`opencode` valid only here or via env) → `RED_AFK_RUNNER` env → env-var sniff (`CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`/`CLAUDE_CODE_SSE_PORT` → `claude`; `CODEX_HOME`/`CODEX_SANDBOX`/`CODEX_SANDBOX_NETWORK_DISABLED`/`CODEX_MANAGED_BY_NPM` → `codex`) → process-tree → path (`~/.claude/` → `claude`; `~/.codex/` → `codex`) → default `claude`.
4. Read [`SAFETY.md`](../SAFETY.md) — binding for every shell action.
5. **Write `worker.pid`:** create `.red/tmp/workers/{id}/`, write current PID **once** — the worker's liveness anchor for its whole lifetime.
6. Install signal handlers (SIGINT/SIGTERM/EXIT): release claim, preserve worker dir, remove `worker.pid`, rmdir empty worker dir.

## Boot-time sweeps

At boot the bundle reclaims stale state — orphan worker dirs (issue-state TTL), the per-issue attempt cap (#257), live `afk/*` branch cleanup, the **Docs Sweep** (origin-visible `.red/` docs before dispatch), and the on-demand `/afk reap` branch reaper (#275). Mechanics: [`docs/BOOT-SWEEPS.md`](./BOOT-SWEEPS.md).

## Dependency Unblock — `req:N` edges, close cascade + boot sweep

Dependencies are first-class **`req:N` edge labels** (one per blocker), and a dependency-blocked issue holds the **`blocked:dependency`** state — *not* `ready-for-human` (it is healthy, waiting, and never pages). Two mechanisms promote it to `ready-for-agent`:

**1. Close cascade (event-driven, the fast path).** Immediately after `/afk` closes an issue #N on the DONE path (after the completion sweep), it re-evaluates every dependent of #N:

1. `gh issue list --label req:N --state open --json number,labels`.
2. For each dependent, read its `req:*` labels and resolve each referenced issue's state (the just-closed #N is known closed; others via a cached lookup).
3. When **every** `req:*` of a dependent is now closed: `gh issue edit --remove-label blocked:dependency --add-label ready-for-agent` + post `🤖 /afk unblocked: all dependencies closed (#…)`. **The lane follows the dependent's TYPE**: one carrying a label declared under `afk.labels.hitl_types` gets `ready-for-human` instead, because its blockers closing frees the *human* to act, not an agent (#2966).

Best-effort: a `gh` failure here logs a `warn:` and never fails the close — the boot sweep below catches anything the cascade missed.

**2. Unblock Sweep (boot-time, the safety net).** After [orphan cleanup and the Docs Sweep](./BOOT-SWEEPS.md) and before *Straggler Check*, `/afk` re-scans dependency-blocked issues by label and promotes any whose deps all closed:

1. `gh issue list` for open `blocked:dependency` issues with `number,labels,body`.
2. Deps come from the `req:*` labels (the source of truth); for pre-`req:N` issues with no such label, fall back to extracting `#N` refs under the literal `## Blocked by` body heading (`- [ ] #N`) only when the issue is still labelled `blocked:dependency`.
3. Resolve each dep via `gh issue view <N> --json state`; promote only when **every** dep is `CLOSED`.
4. On promotion: remove the holding label (`blocked:dependency`), add `ready-for-agent` — or `ready-for-human` when the dependent carries a HUMAN-ONLY type (`afk.labels.hitl_types`, see [CONFIG.md](./CONFIG.md)) — post the audit comment, and log `unblocked N issue(s): #A #B`. The comment names the lane it routed to and why, so a human can tell a sweep promotion from a hand-set label.

`ready-for-human` is a human gate, not dependency-wait. The boot sweep must not promote it from a legacy `## Blocked by` body parse, because a closed blocker can still encode a failed measurement or a no-go decision. `blocked:dependency` issues do not have that ambiguity: the label *means* dependency-wait, which is the whole point of separating it from `ready-for-human`.

## Current Blocker State

Human gates are first-class issue-body state, not implicit thread archaeology. Before claiming an issue, `/afk` checks for an active `## Current blocker` block:

```md
## Current blocker

<!-- red:blocker-state v1 -->
status: blocked
kind: decision
ref: #856
summary: Phase 2 measured no columnar read win.
next: Human must decide whether to stop, redesign, or continue anyway.
<!-- /red:blocker-state -->
```

If this block is present with `status: blocked`, `/afk` does not create an attempt. It removes `ready-for-agent`, adds `ready-for-human` plus the typed blocker label, leaves the issue open, and waits for `/hitl`.

When an attempt escalates to a terminal human page (for example BLOCKED, validation failure, non-recoverable stall/infra, or a recoverable reason after retry-budget exhaustion), the runtime writes or replaces this block so the next `/hitl` turn can start from the current blocker instead of re-reading every old envelope. `/hitl` clears the block to `None`, records it under `## Resolved blockers`, refreshes `## Agent brief`, and moves the issue back to `ready-for-agent` only when the next agent can continue without guessing.

Use `## Blocked by` only for mechanical dependencies that should auto-promote on close. Use `## Current blocker` / `## Human decision needed` for gates, measurements, product calls, or any state where "the referenced issue closed" is not enough to prove the work is delegable.

## Straggler Check

Before issue selection, `/afk` counts open issues in states it cannot consume:

- `unlabeled` — never triaged
- `needs-triage` — triage in progress
- `needs-info` — waiting on reporter

If any of those are non-zero, print a warning and (on a TTY, not in `--once`) prompt to confirm before proceeding. This catches the "lost issue" case where a fresh report never made it through `/triage` and is silently invisible to `/afk`.

The systemic fix is the `red-issues-needs-triage.yml` workflow installed by `/red-setup`, which auto-applies `needs-triage` to every fresh issue. The straggler check is the in-loop safety net for repos where the workflow isn't installed yet.

## Issue Selection

Pull: `gh issue list --label ready-for-agent --state open --json number,title,labels,body,author --limit 100`. Drop every `type:spec` issue before any filter (log `/to-tickets N` warning for each). A territory scope (`--tags`/`--user`, filters 4–5) applies BEFORE the urgent prepend — an urgent issue outside the territory is never pulled across the boundary. Then prepend `priority:urgent` issues before the remaining filters, oldest first.

Filters:
1. `--issues N…`: match requested numbers against the full post-Spec `ready-for-agent` set, urgent included; keep those numbers in argument order; error if missing or not `ready-for-agent`; Specs rejected. Never combined with `--tags`/`--user` (refused at flag parse).
2. `--spec N`: keep non-urgent issues with `spec: #N` in body, parent link, or `spec:N` label; Spec itself excluded.
3. Default: all remaining non-urgent `ready-for-agent`, `priority:high` first, then ascending by number.
4. `--tags a,b`: keep only issues carrying EVERY requested `tag:<value>` label (AND). Strict untagged exclusion: an issue with no `tag:` labels never matches a tag-scoped run. `/afk` never creates `tag:<v>` labels — creation surfaces (`/go --tags`, `/to-spec`, `/to-tickets`) do.
5. `--user login|@me`: keep only issues AUTHORED by that login (`@me` is resolved to a concrete login at launch, so persisted fleet selectors never store `@me`). Matching is client-side over the pulled candidate pool, which is capped at 200 — in a repo with more than 200 open `ready-for-agent` issues an authored issue beyond the cap is invisible to this filter.

Filters 4–5 fold into the same fleet `selector` as `--spec` (facets AND together); `--tags`/`--user` + `--spec` narrows to that Spec's tickets inside the territory.

Final queue: `[urgent…] + [filtered…]`, deduped. Empty → `<promise>NO MORE TASKS</promise>`, exit 0.

**Empty queue + non-empty backlog = flow bug, not a stop (binding on the invoking agent).** "Nothing ready" and "nothing to do" are different claims — never report the second when only the first is true. When the queue is empty but open non-Spec issues exist, print a one-line **gate census** — counts per gate: `blocked:dependency`, `ready-for-human`, `needs-triage`/`needs-info`, `type:spec` — and name the highest-leverage unblock. When a territory scope was active (`--tags`/`--user`), also report whether the requested `tag:<v>` labels exist at all — a typo'd or never-created tag label yields a silently empty scoped queue, and `/afk` never creates tag labels itself. In particular, audit `blocked:dependency` edges whose `req:*` target no longer really pends: a **delivered-but-open Spec** strands every dependent, because the unblock cascade fires on *close*, and Specs close on manual bookkeeping (on 2026-07-02 two fully-delivered Specs froze 14 slices this way). The mission is maximizing autonomous drainage; humans gate only genuine decisions.

## Issue Lifecycle (the `/afk` slice)

Canonical state machine lives in [`red-setup/triage-labels.md`](../../red-setup/triage-labels.md). The portion `/afk` touches:

```
  ready-for-agent
         │
   (1) claim
   remove ready-for-agent
   add running
   post start comment
         │
         ▼
      running
   ┌───┴───┐
   │       │  inner agent works in worktree → emits DONE | BLOCKED
   │       │  orchestrator runs feedback loops, then merges to main
   │       │
   │       ├──── DONE + green + merged + pushed
   │       │           │
   │       │      (4a) close
   │       │      remove running
   │       │      gh issue close --reason completed
   │       │           │
   │       │           ▼
   │       │        closed
   │       │
   │       └──── terminal failure
   │                   │
   │              classify Attempt Outcome
   │              add typed blocked:<reason>
   │                   │
   │          ┌────────┴────────┐
   │          │                 │
   │          │ recoverable and │ non-recoverable, or
   │          │ attempt < cap   │ recoverable at/over cap
   │          │                 │
   │          ▼                 ▼
   │     remove running    remove running
   │     add               add
   │     ready-for-agent   ready-for-human
   │     post/retry        post blocker/budget
   │     audit             exhausted comment
   │          │                 │
   │          ▼                 ▼
   │     ready-for-agent   ready-for-human
   │     (fresh attempt)   (human gate)
   │
   └──── orchestrator interrupted (SIGINT/SIGTERM)
                     │
                (4c) release
                remove running
                restore ready-for-agent
                post interruption comment
                     │
                     ▼
                ready-for-agent  (next /afk run can pick it up)
```

Label transitions are **not** atomic at the gh level — `gh issue edit --remove-label A --add-label B` resolves the new label set client-side and submits the union, so a removed-but-no-longer-present label is a silent no-op and the edit returns 0. To prevent two parallel `/afk` runners from both thinking they claimed the same issue, the per-issue claim uses three layers:

1. **Local `mkdir` lock** at `.red/tmp/claims/{N}/` (POSIX-atomic). Workers in the same checkout race here, and the loser skips.
2. **Pre-check** via `gh issue view --json labels` — if `ready-for-agent` is already gone or `running` is already present, abort before the edit. Cuts the cross-checkout race window to roughly one round-trip.
3. **Stale-lock sweep** at boot, during orphan cleanup — any `.red/tmp/claims/{N}/` whose recorded pid is dead gets reclaimed automatically.

Residual gap: two clones of the same repo on the same host (or different hosts) do not share `.red/tmp/`, so each holds its own mkdir lock and the gh edit race re-opens for the brief window the pre-check leaves uncovered. Acceptable for the intended scale (a few terminals, one checkout). If you need cross-host claim safety, gate `/afk` on a proper coordinator instead of GitHub labels.

### Typed Failure Labels And Recovery Caps

AFK labels terminal failures with a descriptive `blocked:<reason>` label in addition to the routing label. The typed label is observability: a retry path still adds `ready-for-agent`, and an escalated path still adds `ready-for-human`.

| Attempt Outcome | typed label | recovery policy | default cap |
|---|---|---|---|
| `exhausted` | `blocked:quota` | `quota` | `RED_AFK_RETRY_QUOTA=3` |
| `runner-transient` | `blocked:runner-transient` | `runner-transient` | `RED_AFK_RETRY_RUNNER_TRANSIENT=3` |
| `merge-conflict` | `blocked:merge-conflict` | `merge-conflict` | `RED_AFK_RETRY_MERGE=3` |
| `ci-failed` | `blocked:ci` | none — escalates to a human/CI-aware finisher (never re-runs the agent) | n/a |
| `ci-pending` | `blocked:ci` | none — escalates to a human/CI-aware finisher (never re-runs the agent) | n/a |
| `no-sentinel` | `blocked:runner` | `crashed` | `RED_AFK_RETRY_CRASH=1` |
| `hook-aborted` | `blocked:policy` | `policy` | `RED_AFK_RETRY_POLICY=1` |
| `blocked` | `blocked:spec` | none — escalates immediately | n/a |
| `feedback-failed` | `blocked:validation` | none — escalates immediately | n/a |
| `stalled` | `blocked:stalled` | none — escalates immediately in the per-issue path | n/a |
| `infra` | `blocked:infra` | none — escalates immediately | n/a |
| `done` / `claim-lost` | none | none | n/a |

Recoverable reasons retry while the 1-based attempt number is less than the cap. At the cap and above, the same reason escalates to `ready-for-human`, keeps the typed `blocked:<reason>` label, and posts a retry-budget-exhausted comment. Missing, non-numeric, zero, or negative `RED_AFK_RETRY_*` values fall back to the default cap.

**`blocked:ci` never re-runs the agent (#812).** On an `enforce_admins` base, an admin-merge cannot bypass required status checks, so a completed, MERGEABLE PR whose required checks **failed** (`ci-failed`) or are still **pending** past the CI-wait timeout (`ci-pending`) is **not** a merge conflict. These outcomes carry `blocked:ci` and escalate straight to `ready-for-human` with the **PR left open** — they are deliberately NON-recoverable so AFK never re-runs the whole inner agent (re-spending tokens) for work that is already done and only awaiting CI. A human / CI-aware finisher drives the existing PR to merge once CI is green. This is gated by `afk.merge.ci_aware` (see step 8); with it off, the unlocked path admin-merges immediately (correct only on a base with no required checks).

## Per-Issue Loop

For each issue `N`:

1. **Claim.** `gh issue edit N --remove-label ready-for-agent --add-label running`. Then create the issue workspace `.red/tmp/workers/{id}/{N}/`, append narration to the parent's `worker.log.toonl`, and initialise `afk.state.json` per [`docs/ENVELOPE.md`](./ENVELOPE.md). The orchestrator PID is already recorded once in the per-worker `worker.pid` (written at bootstrap) and is also embedded in `afk.state.json`'s `.pid` field — there is no per-run pid file. The bounded-retry ordinal is counted off the history ledger (`core/history.ts`, `requeueOrdinal`), never off a directory name. Comment a start line on the issue: ISO timestamp, runner identity, worktree path. If labelling fails because someone else already claimed it, abandon the workspace and skip to the next issue.
2. **Worktree.** Resolve the **base branch** with precedence **lock > pin > main** (ADR 0031): the primary checkout's branch-lock value (`.red/state/branch-lock.yaml`, with legacy `.red/tmp/branch-lock.yaml` fallback during migration) wins when set; else the **pinned branch** (ADR 0008 — the issue's own `branch:` line, else its parent Spec's); else `main`. (`{pinned}` below denotes this resolved base.) Then `git -C primary fetch origin {pinned}` and `git worktree add .red/tmp/workers/{id}/{N}/worktree -b afk/{id}/{N}-{slug} origin/{pinned}` from the primary checkout. The worktree lives inside the gitignored `.red/tmp/` tree so it never appears in `git status` for `main`. Immediately after worktree creation the runtime mirrors the new branch on origin (`git push origin -u HEAD:refs/heads/afk/{id}/{N}-{slug} --force-with-lease`) and installs a per-worktree `post-commit` hook that fire-and-forgets a `git push origin HEAD --force-with-lease` after every inner-agent commit. Both calls are best-effort: a network/auth failure logs a `warn:` line and the iteration continues. Net effect: `afk/{id}/{N}-{slug}` is a **remote-tracked branch throughout the iteration**, so a SIGKILL or terminal failure preserves the diff on origin without manual recovery.
3. **Handoff file.** Materialise the handoff into `.red/tmp/workers/{id}/{N}/handoff.md` using the template below — top-level XML wrappers (`<issue-body>`, `<previous-workers>`, `<prev-failure-context>`, `<human-guidance-thread>`, `<agent-notes>`) keep the issue body, orchestrator-authored prior attempts, the previous-failure carry-forward, human comments, and the inner-agent scratchpad unambiguous. `<issue-body>` carries the issue body verbatim (including the `## Agent brief` section written by `/triage`). The handoff file lives above the worktree so the inner agent reads it via `../handoff.md` from inside the worktree, and so it survives a worktree wipe on re-queue.
   - **Previous-failure carry-forward (ADR 0103).** On a terminal failure the orchestrator writes `failure.reason` (the envelope summary) and `envelope.ref` (the thread the terminal Envelope was posted into) into the issue workspace. On an automatic re-queue the handoff emits a `<prev-failure-context>` element carrying both, read lane-blind across every worker by `core/prev-failure.ts`. A Ticket's first run skips all of this. This is the **only** thing carried across runs — uncommitted work is disposable, and forensics are the Envelope plus any pushed branch commits.
4. **Local heartbeat marker.** Append one `worker.heartbeat` record to `worker.log.toonl`. Slice D retired the periodic GitHub-comment heartbeat (`:one: :two: :three: :four:`); the protected `liveness.toonl` anchor supplies the evaluator signal.
5. **Inner agent.** Drive the inner agent via the single sandcastle `runAgent` call (ADR 0033, *Execution Substrate* above): the handoff file is the `promptFile`, the resolved runner/model selects the provider, the resolved sandbox mode selects the isolation backend, and the worker branch is the `branchStrategy` target forked off the base resolved in step 2. The optional `--request/-r` special user request block is materialised into the handoff. sandcastle captures the agent's stream through `onAgentStreamEvent`; AFK records those events in the parent Worker's `worker.log.toonl`, updates live state, and detects the `<promise>DONE|BLOCKED</promise>` completion signal. AFK reads stages off that stream — see [`docs/ENVELOPE.md`](./ENVELOPE.md). The call's termination bounds (`idleTimeoutSeconds`, `maxIterations`, and the commit-anchored worker guard) are documented under *Attempt Completion & Termination Bounds*.
6. **Inner result.**
   - Inner committed and emits `<promise>DONE</promise>` → continue to feedback loops.
   - Inner emits `<promise>BLOCKED</promise>` plus notes appended to the handoff file → comment the blocker on the issue, re-label `ready-for-human`, drop the worktree, go to next issue.
   - Inner emits `<promise>NO MORE TASKS</promise>` from inside one iteration → ignored. That sentinel is for the outer loop.
   - Runner-exhausted signal (rate limit / quota error string per runner) → without `--fallback-runner`, terminate this issue as Attempt Outcome `exhausted`; route it through bounded recovery (`blocked:quota`, retry under `RED_AFK_RETRY_QUOTA`, escalate at/over cap). With `--fallback-runner`, keep the same worktree and handoff, swap runner once, and only route `exhausted` if the swapped runner also exhausts.
   - Inner emits `DONE` / no-sentinel while the worktree still has dirty paths (zero commits or a partial commit) → AFK runs the ADR 0050 salvage: commit each dirty path on the worker branch, push it, then continue through the same feedback + landing tail. A salvage that later fails feedback/backpressure still parks as `blocked:validation`; the terminal envelope names the commit state (`zero commits` or `left dirty worktree paths after N commit(s)`), `salvaged N uncommitted file(s)`, and the failing gate so operators know the work was rescued but not mergeable.
7. **Feedback loops.** In the worktree, derive relevant package scopes from the worker branch diff against the pinned base, then run `test`, `typecheck`, `lint`, and `build` with `pnpm -C <scope>` for each touched package that declares the script. Root-only repos keep using the root package. The validation subprocesses run with the explicit feedback env contract from `buildFeedbackSubprocessEnv`: allow only stable OS/toolchain variables needed to find node/pnpm and caches/config, deny AFK lane/routing variables (`RED_AFK_*`, including `RED_AFK_WORKERS_NAMESPACE`, worker id, iter dir, runner/model controls) and common auth/model secret prefixes. They never inherit the worker shell wholesale, so `/afk`, `/go`, and scout lanes validate the same diff under the same subprocess env. Any missing script is reported as an explicit per-scope skip in the validation section. Any failure blocks the merge and flips the issue to `ready-for-human` with the validation report in the blocker envelope. **The gate command is canonical** — this feedback run plus the operator's `afk.backpressure` commands are the sole validation authority. Workers run those exact commands and never self-impose stricter flags (`--all-targets`), extra lint restrictions, or a harder contract than the gate defines; an error class visible only under such a check is a mirage, to be reconciled against the gate's real command before anyone reports a red `main` (see [`AGENT-PROMPT.md`](../AGENT-PROMPT.md) → *Validation Authority*).
8. **Merge.** All steps target the **base branch** resolved in step 2 (`{pinned}`, defaults to `main`). The integration prelude is shared; **landing is lock-toggled** by the branch-lock state (ADR 0030).
   - A crash or gate failure before Landing leaves a dirty primary checkout byte-for-byte untouched. AFK never stages or commits the primary on boot, claim, attempt failure, or gate failure; there is no eager `chore(afk): pre-merge snapshot` commit.
   - After feedback and operator backpressure have succeeded, push the worker branch and fire the `pre_merge` hook. A hook rejection stops before any integration or merge.
   - Serialize the Landing, then integrate and merge away from the primary checkout:
     - **Locked** (`.red/state/branch-lock.yaml` present, or the legacy tmp lock is still present during migration — `{pinned}` *is* the locked branch): provision an isolated landing worktree at the fetched `origin/{pinned}` tip, integrate there, and merge the validated worker tip there. `pre_merge_sha` is captured inside that isolated worktree immediately before `merge --no-ff`; a rejected push resets only the disposable worktree to that anchor. If the worktree cannot be provisioned, Landing is refused instead of falling back to the primary. Conflict → one-shot self-resolve in the landing worktree; still-conflicting → abort there → bounded `merge-conflict` recovery.
     - **Unlocked**: integrate the attempt branch with the fetched base in an isolated rebase worktree, force-with-lease the validated result, then land via a PR targeting `{pinned}`. The **PR is the durable per-worker history** — it survives the branch deletion in step 11. No completed work reaches `{pinned}` except through that PR merge.
       - **CI-aware merge (#812, `afk.merge.ci_aware: true`).** On an `enforce_admins` base the admin-merge **cannot** bypass required status checks, so admin-merging a just-opened PR with checks pending is rejected. When `ci_aware` is on, after opening/reusing the PR **poll `gh pr view --json mergeStateStatus,statusCheckRollup`** on a bounded loop (budget `RED_AFK_MERGE_CI_TIMEOUT_S`, default 1800s) until the PR settles, then `gh pr merge --admin --merge` **only** once `mergeStateStatus == CLEAN` (or it is `BLOCKED` solely by a required review, which `--admin` waives). Route the distinct failure modes instead of collapsing all to `merge-conflict`: a real git conflict / `DIRTY` / `BEHIND` → `merge-conflict` (bounded recovery — correct here); a **failed** required check → `ci-failed` (`blocked:ci`); checks still **pending** at the timeout → `ci-pending` (`blocked:ci`). `ci-failed`/`ci-pending` **leave the PR open** and escalate to `ready-for-human` — they never re-run the inner agent for already-complete work (see *Typed Failure Labels And Recovery Caps*). With `ci_aware` off (the default), a push/create/admin-merge failure routes through bounded `merge-conflict` recovery as before.
       - **Base-drift discipline (#2481).** A branch whose base never moves with trunk turns landing into a doomed rebase: field evidence had five sequential workers carry 65 continuous-push micro-commits on a base twelve hours stale, and the landing then replayed each of them into the same conflicts for 40+ minutes. Three rules keep the drift small and the rebase cheap.
         - **Adopt on a fresh base.** The re-claim resume handoff opens with a MANDATORY `git fetch origin {pinned}` + `git rebase origin/{pinned}` + `git push --force-with-lease`, so an adopted branch starts its attempt on current trunk with the agent present to resolve small conflicts.
         - **Sync trunk in-attempt** (`afk.notes_loop.trunk_sync`, default **on**; only an explicit `false` disables it). At every notes-loop iteration boundary the attempt worktree merges the fetched `origin/{pinned}` into the working branch — a MERGE, never a rebase, because the branch is already continuously pushed. Uncommitted work is never merged over, and a conflicting merge is **aborted** and handed to the agent as its first instruction in the next iteration's carried notes.
         - **Squash before the landing rebase, and refuse a doomed one.** In the isolated rebase worktree, `preMergeRebase` collapses the branch's own commits to ONE at its fork point (`squashAheadThreshold`, default 1 — any multi-commit branch squashes) so the trunk rebase presents a single consolidated conflict set instead of one per commit. Measured **after** that squash, a branch that is both **more than 40 commits ahead** AND forked from a base **more than 12h old** is refused outright (`stale-branch`): it parks `blocked:merge-conflict` carrying the guard's own actionable text — rebuild the slice on a fresh base, or squash it to its net diff — rather than grinding a rebase that cannot converge.

9. **Push.** Folded into step 8: the **locked** path pushes from the isolated landing worktree (rollback there on reject); the **unlocked** path's push feeds the PR merge. Either way, do not retry-loop indefinitely.
10. **Close.** Validation comment on the issue: tests pass/fail, lint, typecheck, build, commits added, files touched. Then `gh issue close N --reason completed`. Remove `running` label. Once the close succeeds, delete the live remote branch (`git push origin --delete afk/{id}/{N}-{slug}`) so the remote graveyard stays tidy — the merge commit on `{pinned}` already carries the diff. Best-effort: a failed delete (branch protection, network) logs a `warn:` line and the close still completes; the orphan `afk/*` branch can be cleaned up later.
11. **Cleanup (split teardown, issue #256).** Every close path — success **and** failure/blocker — always drops the heavy worktree (`git worktree remove .red/tmp/workers/{id}/{N}/worktree`) while **retaining** the cheap issue artifacts (`handoff.md`, state, and validation output) plus the parent Worker's canonical `worker.log.toonl` for post-mortem. On DONE the merged branch is also deleted (`git branch -d afk/{id}/{N}-{slug}`, after the worktree is gone). The retained workspace's state file is marked not-live (`pid: 0`) so monitor / mirror / statusline read it as finished. No worktree survives a close; the workspace itself is reclaimed later by the boot-time orphan sweep's TTL **or, on DONE, immediately by the completion sweep below**. The remote `afk/{id}/{N}-{slug}` ref was deleted in step 10 on DONE; failure paths leave the remote ref intact as the durable branch record (see [`docs/ENVELOPE.md`](./ENVELOPE.md)).
    - **Completion sweep (issue #257).** Once an issue is closed and merged, the runtime reclaims **every** worker dir for that issue across **all** workers via the canonical `.red/tmp/workers/*/{N}-a*` glob — not just the worker that completed it. The split-teardown retention only buys time for the orphan-sweep TTL; a completed issue needs none of it, so its retained dirs (including this worker's just-closed one) go now. A live worker's active attempt — one whose own state file still carries a live `pid` — is always skipped, though the claim lock makes a live duplicate of a just-completed issue unlikely.
12. **Tick.** Update state file. Recompute ETA from rolling average of last 3 issue durations. Print one summary line: `finished {done}/{total} ({pct}%) — next: #{next}`.

## Runner Fallback

Default behaviour is **no rotation and no fallback** — the runner resolved by the detection cascade (see *Bootstrap* step 4) is used for every issue in the run. `RUNNER_EXHAUSTED` is first handled as the per-issue Attempt Outcome `exhausted`: the issue gets `blocked:quota`, returns to `ready-for-agent` while under `RED_AFK_RETRY_QUOTA`, and escalates to `ready-for-human` at/over the cap. The outer session then stops the drain and returns exit 75 (`EX_TEMPFAIL`) so a supervisor can retry later instead of treating runner quota as a clean queue drain. Both rotation/fallback behaviours are opt-in:

- `--alternate` re-enables round-robin rotation between consecutive issues (claude → codex → claude → …). Mutually exclusive with `--runner`.
- `--fallback-runner` re-enables mid-issue swap when the active runner returns `RUNNER_EXHAUSTED`. Without it, exhaustion is terminal for the current runner invocation and routes through bounded recovery as `blocked:quota`.

 Exhaustion detection lives in [`runner-claude.md`](../runner-claude.md), [`runner-codex.md`](../runner-codex.md), and [`runner-opencode.md`](../runner-opencode.md) — they own the per-runner error strings. The orchestrator only sees `RUNNER_EXHAUSTED` as a structured signal. Note `opencode` is an API-auth runner; the auth key rides in `OpenCodeOptions.env` and the model slug's leading segment (`openai/`, `minimax/`, `openrouter/...`) tells OpenCode which endpoint to dispatch to. See `runner-opencode.md` *Auth env precedence* for the env-var order (`OPENAI_API_KEY` > `MINIMAX_API_KEY` > `OPENROUTER_API_KEY`). In an API-key-only lane with no host session, run it without `--fallback-runner` so exhaustion is terminal-through-recovery rather than a swap to a session-auth runner that is not present.

When swap happens mid-issue (only with `--fallback-runner`), the same worktree and handoff file are reused; the new runner sees the previous agent's Notes appended.

## Attempt Completion & Termination Bounds (`<promise>` is canonical — ADR 0028)

The `<promise>…</promise>` sentinel the inner agent emits is the **canonical "attempt is over" signal**. AFK registers `<promise>DONE</promise>` and `<promise>BLOCKED</promise>` as sandcastle `completionSignal`s, so sandcastle stops re-invoking the agent the moment one is observed (line-anchored, so the agent quoting the sentinel in planning prose does not false-positive). sandcastle owns the stream read and signal detection — there is no hand-rolled foreground pipe reader, no recursive SIGTERM/SIGKILL of a `claude | jq | grep | tee` pipeline, and no `RED_AFK_ATTEMPT_GRACE_S` / `RED_AFK_ATTEMPT_KILL_S` / `RED_AFK_WATCHDOG_GRACE_S` tear-down knobs. This is the architecture fix flagged during the #216 bash-hang diagnosis (we need to be more responsive to the promise result): the completion signal is the terminator, and the substrate enforces it.

`runAgent` maps the returned `completionSignal` to an outcome: `<promise>DONE</promise>` → `done`, `<promise>BLOCKED</promise>` → `blocked`, no signal → `no-sentinel`. The completion signal is the **real** terminator — a normal issue finishes in 1-3 iterations — but three independent bounds cap a run that never signals so a stuck agent cannot burn cycles forever:

- **`idleTimeoutSeconds`** (default **600 s**, env `RED_AFK_IDLE_TIMEOUT_S`) — sandcastle's per-iteration **silence** watchdog: an iteration producing no stream output for this long is aborted. This is the actual termination bound on a quiet hang.
- **`maxIterations`** (default **12**, env `RED_AFK_MAX_ITERATIONS`) — the sandcastle Orchestrator **re-invocation** ceiling (issue #322). sandcastle's own default is 1, which would cut the agent off after a single agentic invocation before it can emit `DONE`; AFK raises it so the completion signal stays the terminator while bounding repeated no-sentinel failures. A non-numeric / zero / negative value (env or config) is ignored and falls back to the default, so a typo can never disable the cap or pin the agent to 1.
- **Commit-anchored worker guard** (fixed **2700 s**, ADR 0044/0045 as amended by ADR 0107) — proof-of-**progress**: a run that stays *busy* (re-exploring, re-running tests) without landing a **new commit** within the cap is aborted, resetting on every commit. This catches the "productive infinite loop" that `idleTimeoutSeconds` misses because the agent is never silent. It maps to a `timeout` outcome → `blocked:stalled` / `ready-for-human`, preserving the worktree/PR. Armed **only under `none` (no-sandbox) isolation**, where the worker branch's commits land in the shared `.git` so HEAD advance is observable; under docker/podman the commits are not host-visible until final sync, so a commit-anchored guard would false-fire and is skipped (idle timeout + maxIterations still apply). The project hard **stall reaper** (see [`fleet.md`](../fleet.md)) is separately gated by the active-`vitest`/`tsc`/`cargo`-descendant + flat-cpu predicate, so a Worker mid-build/test is never killed merely because its narration is quiet.

**No sentinel is `on_attempt_error`.** When sandcastle's run completes with no completion signal, the agent never declared the attempt over (crash, kill, or a daemon that ended without speaking): the outcome is `no-sentinel`, `on_attempt_error` fires (error class `no-sentinel`), and `post_attempt` does **not** fire for that invocation. The issue routes through bounded `blocked:runner` recovery while retaining the existing `crashed` retry-policy key. With the default `RED_AFK_RETRY_CRASH=1`, the first such failure escalates to `ready-for-human`; a higher cap can requeue it first. **Runner exhaustion** (`RUNNER_EXHAUSTED`, detected by matching the per-runner quota/rate-limit strings against the thrown sandcastle error) stays out of the sentinel channel — it keeps its own `exhausted` outcome and the `--fallback-runner` swap. A **transient runner transport/setup** failure maps to `runner-transient` and is bounded by AFK's retry policy rather than escaping as a crash.

The parsed outcome rides into the `post_attempt` mutable context as `result.outcome` and the `RED_AFK_RESULT_OUTCOME` env var, so hooks (and the Memory `attempt.hooks` record, #216) see the agent-authored exit, not just `success`/`fail`.

Preventive counterpart lives in [`AGENT-PROMPT.md`](../AGENT-PROMPT.md) under *Background Tasks and Polling* — inner agents are required to cap every polling loop with a deadline. The termination bounds are the safety net; the prompt rule is the design.

## Liveness & stall protection

Local observability combines the protected liveness anchor with the canonical
`worker.log.toonl`, live state, and per-minute heartbeat records (the
GitHub-thread heartbeat was retired in Slice D). A solo run is guarded by the
commit-anchored worker-progress guard (#400) and the lane-idle reaper (#363),
both armed only under no-sandbox isolation. Details: [`docs/LIVENESS.md`](./LIVENESS.md).

## Terminal-event envelope, stages & state file

Every terminal event posts exactly one structured `<details data-attempt-status=…>` comment (the canonical record). Stages are read off the sandcastle stream; the terminal header redraws every 3s; per-worker state lives in `afk.state.json`. Schemas + the Attempt-Outcome→status mapping: [`docs/ENVELOPE.md`](./ENVELOPE.md).

## Fleet Mode

Running `afk fleet` → read [`fleet.md`](../fleet.md) for the runner-portable launch/stop/supervisor protocol (stall detector, hard stall reaper, circuit trip sweep, and per-runner monitor attachment).

## Monitor

Running `afk monitor` → read [`monitor.md`](../monitor.md) for the readonly dashboard, the binding native-task mirror, its self-cancel teardown, and the Codex monitor agent.

## Handoff file template

The inner agent reads `../handoff.md` — top-level XML wrappers (`<issue-body>`, `<previous-workers>`, `<prev-failure-context>`, `<human-guidance-thread>`, `<thread-discussion>`, `<agent-notes>`) keep body/comments/notes unambiguous. Full template: [`docs/HANDOFF.md`](./HANDOFF.md).

## Stop Conditions

- Queue drained → `<promise>NO MORE TASKS</promise>` → exit 0. When the backlog still has open non-Spec issues, the invoking agent accompanies this with the gate census (see *Issue Selection*) — a drained queue with a gated backlog is a flow bug to surface, not "nothing to do".
- `-n N` reached → summary + exit 0.
- Runner exhaustion / runner transport failure → route the current issue through bounded recovery (`blocked:quota` or `blocked:runner-transient`), then stop the outer run with exit 75.
- Uncaught error in orchestrator → leave worktree in place, exit 1, print recovery hint. (No heartbeat sub-shell to kill since Slice D.)

## Reporting

After every issue, print:

```
✓ #142 wire OAuth callback   12m 14s   tests:✓ lint:✓ types:✓ build:✓   merged b3f2a91
finished 4 / 12 (33%) — next: #143
```

After the loop, a final block:

```
/afk done.
runner    : codex (3 issues), claude (1 issue)
duration  : 01:14:22
processed : 4 closed, 0 blocked, 0 failed
remaining : 8 still ready-for-agent
```

## Configuration & lifecycle hooks

All `.red/config.yaml` knobs + `RED_AFK_*` env overrides (sandbox, runner, model/effort, timeouts, retry caps, stall thresholds, backpressure) and the lifecycle-hook contract live in [`docs/CONFIG.md`](./CONFIG.md). The runtime supplies the documented base env (`RED_AFK_REPO`, `RED_AFK_ROOT`, `RED_AFK_WORKSPACE`, `RED_AFK_RUNNER`, optional `RED_AFK_SLOT`) and layers each hook event's documented `RED_AFK_*` variables from that event's JSON context. Runner/model resolution policy: [`../model-tier-policy/SKILL.md`](../../model-tier-policy/SKILL.md).

## Safety

See [`SAFETY.md`](../SAFETY.md). The orchestrator and the inner agent both inherit those rules. Violations abort the loop.
