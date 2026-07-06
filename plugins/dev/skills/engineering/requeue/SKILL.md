---
name: requeue
description: Safely requeue a parked issue or adopt a hand-done branch through the no-agent gate. Requeue clears the active `## Current blocker`, drops stale `ready-for-human`/`blocked:*` labels, and applies `ready-for-agent`. With `--adopt-branch BRANCH` it also validates and lands the branch gate-only via the ADR-0055 no-agent landing lane (reconcile → doLanding). Refuses mixed `blocked:*` states and label/body mismatches — use `/hitl` for those.
argument-hint: "#ISSUE --guidance \"text\" [--adopt-branch BRANCH] [--repo OWNER/REPO] [--dry-run] [--json]"
---

# /requeue

**Put a parked issue back in the queue or adopt a hand-done branch through the gate — ONE coherent transition. A label flip alone is a silent no-op loop.**

<what-to-do>

## Two modes

### 1. Requeue a parked issue (existing behavior)

```bash
red-skills-dev requeue 123 --guidance "Retry with the documented guidance; the gate flake is fixed."
```

Clears the active `## Current blocker`, drops `ready-for-human` + `blocked:*` labels, records the guidance, and applies `ready-for-agent` atomically.

### 2. Adopt a hand-done branch and run gate-only (ADR 0081)

```bash
red-skills-dev requeue 123 --adopt-branch my-feature-branch --guidance "Manual implementation complete; run gate."
```

After the requeue transition (clearing any blocker state), requeue adopts the specified branch and routes it through the **no-agent landing lane** (ADR 0055):

1. Validates the branch via the shared feedback gate (`runFeedback` — no agent re-run).
2. On green: lands via `doLanding` (same path as `/afk`), closes the issue.
3. On red: parks to `ready-for-human` with `blocked:validation` + the real failing checks.
4. On skipped (branch has no commits vs base): exits 0 with a note.

The adopted branch and an AFK branch go through the same gate authority.

`--guidance` is required in both modes — it records the Human decision as an auditable `directive` comment. Use `--dry-run` to print the planned transition without mutating, and `--json` for structured output.

## Behaviour

1. Require `--guidance`; exit 2 immediately if it is missing or empty.
2. Read the issue body, labels, and state. Refuse (exit 1) a non-OPEN issue.
3. Refuse without mutation (exit 1, direct to `/hitl`) when:
   - the issue carries **mixed `blocked:*` labels** (e.g., both `blocked:validation` and `blocked:spec`);
   - the `blocked:*` label kind does not match the active `## Current blocker` kind in the body (**label/body mismatch**);
   - the blocked kind is not `validation` or `spec` (e.g., `blocked:decision`, `blocked:stalled`). **Exception (#1171):** `blocked:sensitive-path` is refused on a **bare** requeue but is clearable with `--adopt-branch` (see below).
4. If the issue is not parked AND `--adopt-branch` is NOT given: no-op exit 0.
5. If the issue is parked and requeueable: apply the requeue transition atomically:
   - clear/archive the active `## Current blocker` into `## Resolved blockers`;
   - post a `directive` comment recording the human `--guidance`;
   - remove `ready-for-human` and every `blocked:*` label, and add `ready-for-agent`.
6. If `--adopt-branch` is given (whether or not the issue was parked):
   - adopt the branch through the no-agent landing lane (ADR 0055 reconcile);
   - exit 0 on `landed`, exit 1 on `parked` (gate failed), exit 0 on `skipped`.

### Clearing a `blocked:sensitive-path` park (#1171)

A `blocked:sensitive-path` park (its diff touches a protected path — CI workflow, lifecycle script, git hook, `.red/` config) is a **landing** gate that re-fires on every fresh attempt, so a bare requeue → `/hitl` → new attempt is an **infinite loop**: the new agent reproduces the same protected diff and re-parks.

`--adopt-branch` breaks the loop. When a maintainer runs `/requeue <issue> --adopt-branch <branch> --guidance "<review note>"` on a `blocked:sensitive-path` park:

- requeue clears the blocker, drops `ready-for-human` + `blocked:sensitive-path`, and adopts the reviewed branch through the no-agent lane **with the sensitive-path landing guard bypassed for that land only**;
- an **audit comment** records who approved the diff and when — the bypass is never silent;
- the guard is **never** weakened for the autonomous path: every normal AFK/go attempt still parks `blocked:sensitive-path`. The bypass is reachable **only** from this explicit `--adopt-branch` human command.

A **bare** requeue of a `blocked:sensitive-path` issue still refuses → `/hitl` (the human must review the diff and land it via `--adopt-branch`).

</what-to-do>

<supporting-info>

## Why a label flip alone fails

A validation or spec failure parks an issue with `ready-for-human`, a `blocked:*` label, and an active `## Current blocker` in the body. AFK preflight reads the active non-mechanical blocker and **re-parks the issue before any work starts** — so flipping labels back to `ready-for-agent` by hand produces a silent no-op retry loop. The blocker must be cleared in the SAME transition that flips the labels (see #850 for the incident evidence).

## `/requeue` vs `/hitl` — the decision boundary

**Use `/requeue`** when:
- The issue is `blocked:validation` or `blocked:spec` (no other `blocked:*` label).
- The label kind and the active `## Current blocker` kind in the body agree.
- You already have the retry guidance and do not need an interview to extract it.
- OR: you have a hand-done branch to adopt (`--adopt-branch`).
- OR: the issue is `blocked:sensitive-path` and you have **reviewed the protected diff** — clear it with `--adopt-branch <branch>` (a bare requeue still refuses).

**Use `/hitl`** when:
- The pending human decision still has to be **extracted and answered**.
- The issue carries **mixed `blocked:*` labels** or a **label/body mismatch**.
- The blocked kind is anything other than `validation` or `spec` — **except** `blocked:sensitive-path`, which `/requeue --adopt-branch` clears once you have reviewed the diff.

Both commands end in the same safe state. `/requeue` is the focused shortcut; `/hitl` is the general path for everything else.

## See also

- `/dev:ship` — DEPRECATED; was the interactive finalizer; replaced by this command
- `/dev:hitl` — interactive decision extraction before requeueing
- ADR 0055 — the no-agent landing lane (reconcile / doLanding)
- ADR 0081 — command topology; requeue is the manual adoption path

</supporting-info>
