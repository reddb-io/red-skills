# 0106 — Castle owns gate, config, runners, lanes, and lifecycle dispatch

## Status

Accepted. Records the locked gate, configuration, runner, lane, and hook
decisions from wayfinder map #1875 and source Tickets #1885, #1888, #1889,
#1890, and #1891.

## Context

After the boundary decision, several engine-adjacent surfaces had to move
together or stay together: validation and landing, configuration, runner
adapters, `/go` and `/scout` entry flags, and lifecycle hooks.

## Decision

Gate execution and landing move into red-castle. Feedback script discovery,
backpressure execution, validation cone computation, finding classification,
merge, landing, and land-lock are castle responsibilities.

The policy constants `MECHANICAL_KINDS`, `SENSITIVE_PATH_PATTERNS`, and the
feedback script set are versioned constants in the castle, not user config.
Operator-owned configuration remains configuration: `afk.backpressure` command
lists and hook defaults.

The validation cone becomes pure reverse-dependency BFS. `CORE_MODULE_MANIFEST`
and its whole-workspace escalation die. Root-trigger files such as lockfiles,
workspace or turbo config, and `.github/**` still escalate to whole-workspace.
The gate remains the sole validation authority; workers run the designed command
set, not stricter self-imposed checks.

The castle reads `.red/config.yaml` directly after receiving the `.red` root.
The published config names are frozen: `plugins.dev.afk.*`, compatibility
`afk.*`, and `RED_AFK_*`. The experience-facing name remains AFK even though
the engine state namespace is castle.

Attempt-era env keys die with Attempts. `RED_AFK_RETRY_*` survives as re-queue
caps. Heartbeat cadence survives for vitals. Claim, circuit, supervisor, fleet,
identity, hook/result, and budget keys survive with worker/drain semantics.
New config covers worker lifetime cap, accumulated worker budget cap, mutable
fleet target, escalation ladder, steering controls, and label mapping.

Runner adapter code moves as a unit into `src/engine/`: `RUNNER_SPECS`, runner
detection, spawn-parity builders, exhaustion regexes, and auth env resolvers.
The old `execution.ts` seam dissolves. Stream/result/liveness types re-export
from the engine barrel for skin-side consumers. Sentinels
`<promise>DONE</promise>`, `<promise>BLOCKED</promise>`, and
`<promise>NO MORE TASKS</promise>` are engine constants.

The engine entry flag contract remains:

- `--origin`
- `--lane`
- `--run-mode`
- `--once`
- `--issues`
- `--pre-pr`
- `--local-merge`
- `--yolo`

`RED_AFK_WORKERS_NAMESPACE` dies and is replaced by `--kind` (`afk`, `go`, or
`scout`) recorded in `state.toon`. Disposable issue minting and lane-label
writes move into the castle tracker adapter. `/go` mode-to-flag translation
stays in the dev CLI as UX. Scout read-only enforcement stays engine-side.

Lifecycle hook dispatch moves castle-side, while hook bodies stay in the dev
skin. The frozen lifecycle point set is:

- `supervisor_start`
- `supervisor_exit`
- `fleet_scaled`
- `worker_start`
- `worker_exit`
- `worker_steered`
- `worker_escalated`
- `post_claim`
- `pre_worktree`
- `post_issue`
- `pre_requeue`
- `pre_merge`
- `post_merge`

Default bodies ship only for `pre_worktree`; other points are no-op unless the
user supplies a body. Hook bodies keep reading the frozen `RED_AFK_*`
vocabulary, minus keys whose features died.

Command guard and Branch lock stay skin-side because they guard the host agent,
not the engine. A CI drift test binds the guard's `.red/tmp` literal to the
castle `SENSITIVE_PATH_PATTERNS` constant.

## Consequences

- Park/label transitions go through the label-mapping config.
- One gate-sink port supports headless AFK parking and interactive `/go`
  pause/ask behavior.
- Sensitive-path bypass remains audited and human-only through adopt-branch.
- `/go` and `/scout` continue to share the full engine instead of growing
  duplicate claim/worktree/gate/landing paths.

## Sources

- Wayfinder map #1875.
- Tickets #1885, #1888, #1889, #1890, and #1891.
