# AFK exposes lifecycle hooks as shell interceptors

`/afk` already runs project-specific shell scripts at a few baked-in points
(e.g. the cargo/gradle isolation defaults under `afk.hooks.defaults` in
`.red/config.yaml`). Those are hardcoded behaviours owned by the AFK code,
not extension points users can author. Today there is no supported way for a
project to say "before the loop starts, do X", "filter the queue to only
issues I created", "after every worker, clear cargo's incremental cache", or
"if the worker crashes, ping my pager".

We need a stable, project-local extension surface that covers the AFK
lifecycle without forcing every customisation back into the skill itself.

## Decision

`/afk` will expose a fixed set of **lifecycle hooks** declared in
`.red/config.yaml` (under `afk.hooks`) and resolved as ordered lists of
shell commands. Every hook follows a single **interceptor contract**: it
receives the current AFK context and may optionally return a modified
context, in the spirit of an axios request/response interceptor.

### Hook points

The AFK lifecycle exposes the following hooks, in execution order:

| Hook                | When it fires                                                | Mutable input            |
|---------------------|--------------------------------------------------------------|--------------------------|
| `pre_session`       | Boot, before any queue work                                  | session config           |
| `pre_pick`          | Before listing the issue tracker queue                       | query params             |
| `post_pick`         | After listing, before claiming                               | issues[]                 |
| `pre_worktree`      | Before the per-issue worktree is created                     | issue, target path       |
| `pre_worker`        | Worktree ready, before runner (claude/codex) executes        | issue, workspace         |
| `post_worker`       | Runner returned (success **or** clean failure)               | issue, workspace, result |
| `pre_merge`         | Before merging worker branch into the pinned branch          | issue, workspace, diff   |
| `post_merge`        | After successful merge                                       | issue, merge commit      |
| `on_worker_error`   | Unhandled exception inside a single worker                   | issue, workspace, error  |
| `on_idle`           | Queue drained, before sleep/exit                             | session stats            |
| `post_session`      | Normal session termination                                   | session stats            |
| `on_session_error`  | Unhandled exception in the loop itself (last gasp)           | error                    |

`on_idle` is intentionally separate from `post_session` so projects can run
"between drains" maintenance (e.g. `cargo clean`, prune stale worktrees,
`docker system prune`) without that cost being paid per-issue inside
`post_worker`.

### Interceptor contract

Every hook command runs with:

- **Env vars** for the common fields (`RED_AFK_ISSUE_ID`,
  `RED_AFK_WORKSPACE`, `RED_AFK_RESULT_STATUS`, etc.). Shell-friendly so
  trivial hooks (`bash ./.red/hooks/notify.sh`) do not need to parse JSON.
- **Full context JSON on stdin** for hooks that want to inspect or mutate
  structured fields.

The command may:

- Write **nothing to stdout** → AFK keeps the original context unchanged
  (pure side-effect hook).
- Write a **JSON object to stdout** → AFK replaces the relevant slice of
  context with the returned value. Only the fields documented as mutable
  for that hook (see table above) are honoured; AFK ignores extra keys.

Exit codes:

- `0` → continue.
- non-zero → abort *this step* with hook-specific semantics:
  - `pre_session`, `pre_pick`, `pre_worktree`, `pre_merge`: abort the
    session / pick / worktree / merge.
  - `pre_worker`: skip this issue, continue the loop.
  - `post_worker`, `post_merge`, `post_pick`, `on_idle`, `post_session`,
    `on_worker_error`, `on_session_error`: log the failure and continue —
    a broken notifier must never wedge `/afk`.

Multiple commands per hook run sequentially in declaration order; each one
sees the context as mutated by the previous one. A failed earlier command
short-circuits later ones in the same hook list.

### Config shape

```yaml
afk:
  hooks:
    pre_session:
      - "bash ./.red/hooks/boot.sh"
    pre_pick:
      - "bash ./.red/hooks/only-mine.sh"      # may emit {"labels":["mine"]}
    post_pick:
      - "bash ./.red/hooks/dedupe.sh"         # may emit filtered issues[]
    post_worker:
      - "bash ./.red/hooks/notify.sh"
    on_worker_error:
      - "bash ./.red/hooks/page-oncall.sh"
    on_idle:
      - "cargo clean -p reddb-storage"        # the canonical example
    post_session:
      - "bash ./.red/hooks/summarize.sh"
```

A bare string is accepted as shorthand for a single-element list. Unknown
hook names are a config error (caught at session boot, surfaced through
`on_session_error` if it fires after boot).

## Why

- **One mental model instead of two.** Earlier drafts split this into
  observer "hooks" and transforming "filters". Modelling everything as an
  interceptor (input in, optional input out) removes that split: trivial
  notifiers ignore stdin/stdout, sophisticated ones mutate context. Same
  config shape, same execution model, same failure semantics.
- **Lifecycle coverage matches real automation needs.** Pre/post pairs for
  the session, queue pick, worktree, worker, and merge let projects bolt
  on boot, filtering, environment seeding, notification, and post-merge
  validation without forking the skill.
- **`on_idle` separates "between drains" maintenance from per-issue
  teardown.** The cargo example is the giveaway: `cargo clean` per
  `post_worker` would defeat incremental compilation; `cargo clean` at
  `on_idle` runs exactly when the cache is no longer load-bearing.
- **Errors are first-class without conflating outcomes.** `post_worker`
  always runs for "the worker terminated normally" (success or clean
  failure). `on_worker_error` exists for "the worker itself blew up", and
  `on_session_error` exists for "the loop blew up". Hook authors do not
  have to demultiplex on `result.status`.
- **Env vars for the common case, JSON for the rich case.** Asking every
  shell author to `jq` just to read an issue ID would be hostile to the
  90% of hooks that are one-line side effects.
- **Stays inside `.red/config.yaml`.** No new config file, no new
  discovery rules; consistent with the existing `afk.fleet.*` and
  `afk.hooks.defaults.*` keys (the latter now becomes one specific case
  of the broader hook surface).

### Internal hook adoption

The dispatcher is not only an extension surface for users — large parts of
the current `afk.sh` flow are themselves "policy" that should live on the
same pipeline. The migration splits AFK's existing behaviour into two
buckets along a single rule:

> **If the failure of a step must abort the session loudly and visibly,
> it is mechanism. If "log and continue" is an acceptable failure mode,
> it is a hook.**

**Migrates to built-in hooks** (registered by AFK at the relevant
lifecycle point, run through the same dispatcher as user hooks):

- `detectors/cargo.sh`, `detectors/gradle.sh` → `pre_worktree`
- `.env` / symlink seeding into the worktree → `pre_worktree`
- Heartbeat tick and intermediate envelope updates → `post_worker`
- Post-merge CI / smoke validation → `post_merge`
- Task Mirror sync to the tracker → `post_pick`, `post_worker`
- Session summary notification → `post_session`

**Stays as mechanism** (lifecycle steps themselves, not entries in any
hook list — they happen *between* the surrounding pre/post hooks):

- Atomic issue claim on the tracker (race-sensitive, transactional)
- Worktree creation itself (`pre_worktree` decorates, it does not create)
- Supervisor heartbeat and stall reaper (ADR 0015 safety invariant)
- Branch lock enforcement (ADR 0006)
- Merge into the pinned branch (ADR 0008)
- Conflict resolution path
- Post-merge worktree teardown
- Terminal Envelope post and issue close

A user disabling `afk.hooks.defaults.cargo` removes the built-in cargo
hook from the `pre_worktree` list — it does not skip the worktree
creation step itself, because that one is mechanism.

### Execution order

Each lifecycle moment is structured as `pre_<step>` → **mechanism step**
→ `post_<step>`. The mechanism step is owned by AFK and never appears
in a hook list; it is the irreducible work the orchestrator must do.
Hooks decorate it.

Within a single hook list, commands run in this order:

1. **Built-in defaults**, in the order AFK registers them.
2. **User hooks** from `.red/config.yaml`, in declaration order.

Both layers participate in the interceptor chain: each command sees the
context as mutated by every previous command in the list, defaults and
user alike. The rule generalises across `pre_*` and `post_*`:

- For `pre_*`: defaults set up the environment (cargo isolation, env
  seeding), then user hooks extend or override on top before mechanism
  runs.
- For `post_*`: defaults reconcile AFK-owned state (mirror sync, envelope
  update), then user hooks fire with the already-reconciled context
  (notify Slack with the real merge commit, page on validation failure).

Worked example for one cycle around merge:

```
pre_merge defaults  (e.g. "ensure clean index")     ── interceptor chain
pre_merge user      (e.g. "block if diff > 5k LOC") ──┘
─────── mechanism: merge + conflict resolution ───────  (not a hook)
post_merge defaults (validation, mirror update)     ── interceptor chain
post_merge user     (e.g. "Slack the merge URL")    ──┘
─────── mechanism: worktree teardown, envelope post ─  (not a hook)
```

Users can **disable** any specific built-in default via
`afk.hooks.defaults.<name>: false`, but cannot reorder defaults among
themselves or interleave with them — defaults are owned by the skill and
their relative order encodes correctness invariants (e.g. cargo
isolation must seed `CARGO_TARGET_DIR` before any user `pre_worktree`
hook tries to read it). A user who needs a hook to run *before* the
defaults should propose promoting it into the defaults set rather than
reaching under the hood.

## Rejected alternatives

- **Two separate concepts, `hooks:` and `filters:`.** Initially proposed.
  Rejected after the user pushed back: an axios-style interceptor model
  collapses the two cleanly and avoids forcing trivial hooks to learn a
  JSON-stdin contract.
- **Hook scripts as a directory convention (`./.red/hooks/pre_session.sh`,
  etc.).** Rejected because it implies one script per hook, conflicts
  with the "list of commands" model, and complicates conditional inclusion
  (env-gated hooks, per-runner hooks).
- **Hooks as a separate `.red/afk/hooks.yaml`.** Rejected for the first
  slice to keep configuration discovery cheap; can be split later if the
  block grows unwieldy.
- **Merge `on_worker_error` into `post_worker` with a status field.**
  Rejected because crash paths and clean-failure paths have different
  invariants (workspace may be half-populated, branch may not exist) and
  conflating them would force every hook author to defensively branch on
  status.
- **Treat `on_idle` as equivalent to `post_session`.** Rejected for the
  cargo/cache case above: idle and termination are different lifecycle
  moments and projects need to script them independently.
- **Stop on first non-zero exit for every hook.** Rejected for post/idle
  hooks because a broken notifier or a failing cache cleanup must not
  wedge AFK; only pre-hooks abort their step.
- **Treat the existing `afk.sh` actions as opaque mechanism and only
  expose hooks around the outside.** Rejected because today's
  `detectors/cargo.sh`, `detectors/gradle.sh`, mirror sync, and
  post-merge validation are already policy in disguise: they are
  per-project choices, fail-soft, and have no global safety invariant.
  Keeping them as ad-hoc shell inside the orchestrator while exposing
  a parallel hook surface would leave AFK with two execution models
  for the same kind of action.
- **Let user hooks reorder or replace built-in defaults arbitrarily.**
  Rejected because some defaults encode correctness invariants
  (cargo isolation must run before any user `pre_worktree` hook that
  reads `CARGO_TARGET_DIR`). Disable-via-config is supported; reorder
  is not — a user who needs that should propose promoting their hook
  into the defaults bundle.

## Consequences

- `/afk` gains a hook dispatcher with the interceptor contract above,
  invoked at each lifecycle point. The dispatcher owns env-var
  population, JSON serialisation on stdin, JSON parsing on stdout,
  exit-code routing, and per-hook failure semantics.
- The existing `afk.hooks.defaults` keys (`cargo`, `gradle`, …) keep
  working and are reframed as built-in hook contributors layered on top
  of the user-declared hooks; user hooks run after defaults at the same
  lifecycle point.
- AFK Envelopes should record which user hooks ran at terminal time
  (names and exit codes), so attempt history reflects external mutations
  to the queue or worker context. Hook stdout/stderr stays local-only by
  default; pushing it into the Envelope is a later slice.
- The Memory `attempt` node (ADR 0017) gains an optional `hooks` summary
  field once Envelope capture lands, so reasoning recall can surface
  "this attempt ran with `only-mine` filter".
- Documentation: the `/afk` skill README and `.red/config.yaml` template
  must enumerate the hook list, env vars, mutable fields, and exit-code
  semantics. A short example hook (`only-mine.sh`) ships under
  `plugins/dev/skills/productivity/afk/examples/`.
- Codex parity: because hooks are plain shell, no Codex-specific bridge
  is required, sidestepping the PreCompact gap noted for the memory
  plugin.
- `scripts/hooks.sh` and `detectors/*.sh` get refactored behind the new
  dispatcher: same shell scripts, registered as built-in defaults at
  their lifecycle point instead of being called inline from `afk.sh`.
  The existing `tests/hooks-orchestrator.test.sh` harness covers
  defaults and user hooks under one execution model.
- The reordering ban is documented in the `/afk` skill README: users
  disable defaults, they do not reorder them; promotion of a user
  hook into the defaults bundle is the supported path when ordering
  must change.
